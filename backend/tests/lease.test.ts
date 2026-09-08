import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DomainError } from '../src/core/errors.ts';
import { WriterLease, tryPromote } from '../src/goldenthread/lease.ts';
import type { StoreClient, StoreConnection } from '../src/goldenthread/pgstore.ts';

/**
 * The writer lease: who may extend the chain, decided by the database.
 *
 * The stand-in below implements the one statement that matters — the
 * conditional upsert — with the same semantics Postgres gives it, including
 * that two callers racing it are serialised and exactly one gets a row back.
 * That is the property the whole design rests on, so it is modelled rather
 * than mocked away.
 *
 * `pgstore.live.test.ts` is where this runs against a real server. This file is
 * what `npm test` can prove without one, and it is where the failure that
 * matters is staged: **the paused primary**. A real server cannot be made to
 * stop the world on cue.
 */

/** Postgres' `writer_lease` semantics, and a clock a test can move. */
class FakeLeaseDb implements StoreClient {
  row: { id: string; holder: string; token: number; host: string; pid: number; claimed_at: number; expires_at: number } | undefined;
  now = 1_000_000;
  statements = 0;
  /** Fail the next N statements, for the unreachable-database case. */
  failNext = 0;

  async query<R>(sql: string, params: unknown[] = []): Promise<{ rows: R[]; rowCount: number }> {
    this.statements += 1;
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('the database closed the connection');
    }
    const text = sql.replace(/\s+/g, ' ').trim();

    if (text.startsWith('CREATE TABLE IF NOT EXISTS writer_lease')) return { rows: [], rowCount: 0 };

    if (text.startsWith('SELECT holder, token')) {
      if (!this.row || this.row.id !== params[0]) return { rows: [], rowCount: 0 };
      return { rows: [this.#read()] as R[], rowCount: 1 };
    }

    if (text.startsWith('INSERT INTO writer_lease')) {
      const [id, holder, host, pid, ttl] = params as [string, string, string, number, string];
      const ttlMs = Number(ttl) * 1_000;
      const existing = this.row?.id === id ? this.row : undefined;
      if (existing) {
        const free = existing.expires_at <= this.now;
        const mine = existing.holder === holder;
        // The WHERE clause. This is the race: two callers both reach here, and
        // only the one whose condition still holds when it runs gets a row.
        if (!free && !mine) return { rows: [], rowCount: 0 };
        existing.token = mine ? existing.token : existing.token + 1;
        existing.holder = holder;
        existing.host = host;
        existing.pid = pid;
        if (!mine) existing.claimed_at = this.now;
        existing.expires_at = this.now + ttlMs;
        return { rows: [this.#read()] as R[], rowCount: 1 };
      }
      this.row = { id, holder, token: 1, host, pid, claimed_at: this.now, expires_at: this.now + ttlMs };
      return { rows: [this.#read()] as R[], rowCount: 1 };
    }

    if (text.startsWith('UPDATE writer_lease SET expires_at = now() + ')) {
      const [id, holder, token, ttl] = params as [string, string, string, string];
      if (!this.row || this.row.id !== id || this.row.holder !== holder || String(this.row.token) !== token) {
        return { rows: [], rowCount: 0 };
      }
      this.row.expires_at = this.now + Number(ttl) * 1_000;
      return { rows: [], rowCount: 1 };
    }

    if (text.startsWith('UPDATE writer_lease SET expires_at = now() WHERE')) {
      const [id, holder, token] = params as [string, string, string];
      if (!this.row || this.row.id !== id || this.row.holder !== holder || String(this.row.token) !== token) {
        return { rows: [], rowCount: 0 };
      }
      this.row.expires_at = this.now;
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`the lease stand-in was sent a statement it does not model: ${text.slice(0, 90)}`);
  }

  async asTenant<T>(_tenantId: string, work: (connection: StoreConnection) => Promise<T>): Promise<T> {
    return work({ query: <R>(sql: string, params: unknown[] = []) => this.query<R>(sql, params) });
  }

  #read(): Record<string, unknown> {
    const row = this.row!;
    return {
      holder: row.holder,
      token: String(row.token),
      host: row.host,
      pid: row.pid,
      claimed_at: new Date(row.claimed_at).toISOString(),
      expires_at: new Date(row.expires_at).toISOString(),
      lapsed: row.expires_at <= this.now,
    };
  }
}

describe('taking the lease', () => {
  it('gives it to exactly one of two processes racing for it', async () => {
    const db = new FakeLeaseDb();
    const a = new WriterLease(db, { ttlSeconds: 10 });
    const b = new WriterLease(db, { ttlSeconds: 10 });

    const first = await a.acquire();
    const second = await b.acquire();

    assert.equal(first.taken, true);
    // Not an error and not a retry: this is the ordinary answer for a standby,
    // and it comes back with who actually holds it.
    assert.equal(second.taken, false);
    assert.equal(second.state.role, 'STANDBY');
    assert.equal(b.token, undefined);
  });

  it('lets the holder renew without changing its own token', async () => {
    const db = new FakeLeaseDb();
    const lease = new WriterLease(db, { ttlSeconds: 10 });
    await lease.acquire();
    const token = lease.token;
    db.now += 3_000;
    assert.equal(await lease.renew(), true);
    // A holder that fenced itself on every renewal would invalidate its own
    // in-flight writes once every renewal interval.
    assert.equal(lease.token, token);
  });

  it('hands it to a standby once the holder’s lease lapses, on a higher token', async () => {
    const db = new FakeLeaseDb();
    const primary = new WriterLease(db, { ttlSeconds: 10 });
    const standby = new WriterLease(db, { ttlSeconds: 10 });
    await primary.acquire();
    const before = primary.token!;

    // The primary stops renewing — killed, OOM, node lost.
    db.now += 11_000;
    const taken = await standby.acquire();

    assert.equal(taken.taken, true);
    assert.ok(standby.token! > before, `${standby.token} should exceed ${before}`);
  });
});

describe('the paused primary — the failure a lease alone does not survive', () => {
  it('fences the old holder out by number rather than by timing', async () => {
    const db = new FakeLeaseDb();
    const primary = new WriterLease(db, { ttlSeconds: 10 });
    const standby = new WriterLease(db, { ttlSeconds: 10 });
    await primary.acquire();

    // A long stop-the-world pause. The primary is not dead and does not know
    // anything has happened.
    db.now += 30_000;
    await standby.acquire();

    // It wakes and tries to carry on. This is the moment two processes would
    // both be extending one chain.
    assert.equal(await primary.renew(), false);
    assert.throws(
      () => primary.assertHeld(),
      (error: unknown) =>
        error instanceof DomainError && error.code === 'LEDGER_LEASE_LOST' && error.status === 503,
    );
    // And the standby is unaffected by the old holder's attempt.
    assert.equal(standby.assertHeld(), standby.token);
  });

  it('does not let a released lease reset the token, which would un-fence the paused process', async () => {
    const db = new FakeLeaseDb();
    const first = new WriterLease(db, { ttlSeconds: 10 });
    await first.acquire();
    const firstToken = first.token!;
    await first.release();

    const second = new WriterLease(db, { ttlSeconds: 10 });
    await second.acquire();
    // Deleting the row on release would start the next holder at 1 again, and
    // a paused process holding token 1 would then be indistinguishable from
    // the current one.
    assert.ok(second.token! > firstToken, `${second.token} should exceed ${firstToken}`);
  });

  it('treats an unreachable database as a blip, not as a lost lease', async () => {
    // The opposite mistake, and it stops a healthy platform: a momentary
    // network failure is not somebody else taking over, and the lease has not
    // expired yet.
    const db = new FakeLeaseDb();
    const lease = new WriterLease(db, { ttlSeconds: 10 });
    await lease.acquire();
    const token = lease.token;
    db.failNext = 1;
    await assert.rejects(lease.renew());
    assert.equal(lease.token, token, 'a failed renewal must not drop the token');
    assert.equal(await lease.renew(), true);
  });
});

describe('promotion without a restart', () => {
  it('promotes a standby the moment the lease falls free, and runs the handover once', async () => {
    const db = new FakeLeaseDb();
    const primary = new WriterLease(db, { ttlSeconds: 10 });
    const standby = new WriterLease(db, { ttlSeconds: 10 });
    await primary.acquire();

    let promotedWith: number | undefined;
    const onPromoted = (token: number): void => {
      promotedWith = token;
    };

    // While the primary is alive, the standby stays a standby.
    const held = await tryPromote(standby, onPromoted);
    assert.equal(held.promoted, false);
    assert.equal(held.state.role, 'STANDBY');
    assert.equal(promotedWith, undefined);

    // The primary goes. The standby already holds the whole record in memory —
    // that is what follower mode is for — so promotion is permission, not a
    // replay, and takes no restart.
    db.now += 11_000;
    const promoted = await tryPromote(standby, onPromoted);
    assert.equal(promoted.promoted, true);
    assert.equal(promotedWith, standby.token);

    // And it does not promote itself twice.
    promotedWith = undefined;
    const again = await tryPromote(standby, onPromoted);
    assert.equal(again.promoted, false);
    assert.equal(again.state.role, 'HOLDER');
    assert.equal(promotedWith, undefined);
  });

  it('holds the lease before the handover runs, so a failed handover writes nothing', async () => {
    const db = new FakeLeaseDb();
    const standby = new WriterLease(db, { ttlSeconds: 10 });
    await assert.rejects(
      tryPromote(standby, () => {
        throw new Error('the handover failed');
      }),
      /the handover failed/,
    );
    // The lease is held and the process is not writing. That is the safe half
    // of the failure: a process that had begun writing before taking the lease
    // would be the unsafe one.
    assert.equal((await standby.read()).role, 'HOLDER');
  });

  it('lets exactly one of several standbys win the election', async () => {
    const db = new FakeLeaseDb();
    const dead = new WriterLease(db, { ttlSeconds: 10 });
    await dead.acquire();
    db.now += 11_000;

    const contenders = [1, 2, 3].map(() => new WriterLease(db, { ttlSeconds: 10 }));
    const results = [];
    for (const contender of contenders) results.push(await tryPromote(contender, () => {}));

    assert.equal(results.filter((r) => r.promoted).length, 1);
    assert.equal(contenders.filter((c) => c.token !== undefined).length, 1);
  });
});

describe('reporting', () => {
  it('says who holds it, from the database rather than from memory', async () => {
    const db = new FakeLeaseDb();
    const primary = new WriterLease(db, { ttlSeconds: 10 });
    const observer = new WriterLease(db, { ttlSeconds: 10 });
    await primary.acquire();

    const seen = await observer.read();
    assert.equal(seen.role, 'STANDBY');
    assert.equal(seen.role === 'STANDBY' ? seen.holder.holder : '', primary.holderId);
    assert.equal(seen.role === 'STANDBY' ? seen.holder.pid : 0, process.pid);
  });

  it('reports a lapsed lease as free, and names who had it', async () => {
    const db = new FakeLeaseDb();
    const primary = new WriterLease(db, { ttlSeconds: 10 });
    await primary.acquire();
    db.now += 11_000;

    const observer = new WriterLease(db, { ttlSeconds: 10 });
    const seen = await observer.read();
    assert.equal(seen.role, 'FREE');
    // The previous holder is named rather than dropped: a takeover nobody can
    // attribute is a takeover nobody can investigate.
    assert.equal(seen.role === 'FREE' ? seen.previous?.holder : undefined, primary.holderId);
  });
});
