import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rejectsCode } from './helpers.ts';
import { GoldenThreadLedger } from '../src/goldenthread/ledger.ts';
import { PostgresLedgerStore, type StoreClient, type StoreConnection } from '../src/goldenthread/pgstore.ts';
import type { GoldenThreadEvent } from '../src/goldenthread/types.ts';

/**
 * The ledger store's own behaviour — ordering, idempotence, retry, halt and
 * replay — against a stand-in that enforces the schema's rules without a
 * server: the primary key on `event_id`, the unique sequence, the chain
 * trigger, the tenant trigger, and row-level security on reads.
 *
 * The stand-in is not the database. `pgstore.live.test.ts` runs the same store
 * against a real Postgres 16 through `deploy/postgres/client-check.sh`; this
 * file is what `npm test` can prove without one, and it is where the failure
 * modes are staged — a connection that drops, another writer on the chain —
 * because a real server cannot be made to fail on cue.
 */

class FakePostgres implements StoreClient {
  readonly events = new Map<string, { row: unknown[]; tenantId: string }>();
  readonly heads = new Map<string, string>();
  readonly tenancy = new Map<string, number>();
  readonly evidenceTypes = new Set<string>();
  position = 0;
  /** Fail the next N statements with a connection error. */
  failNext = 0;
  statements = 0;

  #fail(code: string, message: string): never {
    const error = new Error(message) as Error & { sqlState: string };
    error.sqlState = code;
    throw error;
  }

  async query<R>(sql: string, params: unknown[] = []): Promise<{ rows: R[]; rowCount: number }> {
    return this.#run<R>(sql, params, undefined);
  }

  async asTenant<T>(tenantId: string, work: (connection: StoreConnection) => Promise<T>): Promise<T> {
    // A transaction: statements inside are applied to a copy and kept only on
    // success, so a refused insert leaves nothing behind — as BEGIN/ROLLBACK does.
    const snapshot = { events: new Map(this.events), heads: new Map(this.heads), tenancy: new Map(this.tenancy), position: this.position };
    try {
      return await work({ query: <R>(sql: string, params: unknown[] = []) => this.#run<R>(sql, params, tenantId) });
    } catch (error) {
      this.events.clear();
      for (const [key, value] of snapshot.events) this.events.set(key, value);
      this.heads.clear();
      for (const [key, value] of snapshot.heads) this.heads.set(key, value);
      this.tenancy.clear();
      for (const [key, value] of snapshot.tenancy) this.tenancy.set(key, value);
      this.position = snapshot.position;
      throw error;
    }
  }

  async #run<R>(sql: string, params: unknown[], tenantId: string | undefined): Promise<{ rows: R[]; rowCount: number }> {
    this.statements += 1;
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('the database closed the connection');
    }
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.startsWith('SELECT sequence FROM ledger_position')) {
      return { rows: (this.position > 0 ? [{ sequence: String(this.position) }] : []) as R[], rowCount: this.position > 0 ? 1 : 0 };
    }
    if (text.startsWith('SELECT count(*)::int AS count FROM tenancy')) return { rows: [{ count: this.tenancy.size }] as R[], rowCount: 1 };
    if (text.startsWith('SELECT sequence, body FROM event WHERE false')) return { rows: [], rowCount: 0 };
    if (text.startsWith('INSERT INTO event_type_requiring_evidence')) {
      const code = String(params[0]);
      const added = !this.evidenceTypes.has(code);
      this.evidenceTypes.add(code);
      return { rows: [], rowCount: added ? 1 : 0 };
    }
    if (text.startsWith('SELECT tenant_id FROM tenancy')) {
      const rows = [...this.tenancy.entries()].sort((a, b) => a[1] - b[1]).map(([tenant_id]) => ({ tenant_id }));
      return { rows: rows as R[], rowCount: rows.length };
    }
    if (text.startsWith('SELECT sequence, body FROM event WHERE sequence > $1')) {
      const after = Number(params[0]);
      const rows = [...this.events.values()]
        .filter((entry) => entry.tenantId === tenantId && Number(entry.row[23]) > after)
        .map((entry) => ({ sequence: String(entry.row[23]), body: entry.row[24] as string }))
        .sort((a, b) => Number(a.sequence) - Number(b.sequence));
      return { rows: rows as R[], rowCount: rows.length };
    }
    if (text.startsWith('SELECT sequence, body FROM event WHERE sequence IS NOT NULL')) {
      const rows = [...this.events.values()]
        .filter((entry) => entry.tenantId === tenantId)
        .map((entry) => ({ sequence: String(entry.row[23]), body: entry.row[24] as string }))
        .sort((a, b) => Number(a.sequence) - Number(b.sequence));
      return { rows: rows as R[], rowCount: rows.length };
    }
    if (text.startsWith('SELECT project_id, chain_hash FROM chain_head')) {
      const rows = [...this.events.values()]
        .filter((entry) => entry.tenantId === tenantId)
        .map((entry) => String(entry.row[2]))
        .filter((project, index, all) => all.indexOf(project) === index)
        .map((project_id) => ({ project_id, chain_hash: this.heads.get(project_id) }));
      return { rows: rows as R[], rowCount: rows.length };
    }
    if (text.startsWith('SELECT event_id FROM event WHERE event_id = $1')) {
      const found = this.events.get(String(params[0]));
      const visible = found && found.tenantId === tenantId;
      return { rows: (visible ? [{ event_id: params[0] }] : []) as R[], rowCount: visible ? 1 : 0 };
    }
    if (text.startsWith('INSERT INTO tenancy')) {
      const id = String(params[0]);
      if (!this.tenancy.has(id)) this.tenancy.set(id, Number(params[1]));
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('INSERT INTO event (')) {
      const [eventId, tenant, project, , , , , , , , , , , , , , , , , , , chainHash, previous, sequence] = params as string[];
      if (tenant !== tenantId) this.#fail('42501', `tenant mismatch: this connection is acting for ${tenantId} and the event belongs to ${tenant}`);
      if (this.events.has(eventId!)) this.#fail('23505', 'duplicate key value violates unique constraint "event_pkey"');
      if ([...this.events.values()].some((entry) => String(entry.row[23]) === String(sequence))) {
        this.#fail('23505', 'duplicate key value violates unique constraint "event_by_sequence"');
      }
      const head = this.heads.get(project!);
      if (head === undefined && previous !== null) this.#fail('23000', `chain break on ${project} : the event claims to follow ${previous} and this project has no events`);
      if (head !== undefined && previous !== head) this.#fail('23000', `chain break on ${project} : the event follows ${previous} but the head is ${head}. Two writers, or a replayed event.`);
      this.events.set(eventId!, { row: params, tenantId: tenant! });
      this.heads.set(project!, chainHash!);
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('INSERT INTO ledger_position')) {
      const sequence = Number(params[0]);
      if (sequence > this.position) this.position = sequence;
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`the stand-in does not know this statement: ${text.slice(0, 80)}`);
  }
}

const ACTOR = { refType: 'User', refId: 'user-1' } as const;

function commitProject(ledger: GoldenThreadLedger, tenantId: string, projectId: string, name: string): GoldenThreadEvent {
  return ledger.commit({
    tenantId,
    projectId,
    actor: ACTOR,
    source: 'WEB',
    correlationId: `corr-${name}`,
    eventType: 'PROJECT_CREATED',
    entity: { refType: 'Project', refId: projectId },
    nextState: { id: projectId, tenantId, name, phase: 'CONCEPT' },
  }).event;
}

/** A second event on the same chain: a phase transition, which the catalogue says needs evidence. */
function renameProject(ledger: GoldenThreadLedger, tenantId: string, projectId: string, name: string): GoldenThreadEvent {
  const current = ledger.require({ refType: 'Project', refId: projectId });
  return ledger.commit({
    tenantId,
    projectId,
    actor: ACTOR,
    source: 'WEB',
    correlationId: `corr-${name}`,
    eventType: 'PROJECT_PHASE_TRANSITIONED',
    entity: { refType: 'Project', refId: projectId },
    nextState: { ...current.state, name, phase: current.state.phase === 'CONCEPT' ? 'DESIGN' : 'TENDER' },
    evidenceRefs: [{ refType: 'EvidenceItem', refId: `ev-${name.replace(/\W+/g, '-')}` }],
  }).event;
}

const quiet = (): void => undefined;

describe('shipping a ledger to the store', () => {
  it('ships every commit in order, one tenancy at a time, and the database agrees on every chain head', async () => {
    const db = new FakePostgres();
    const ledger = new GoldenThreadLedger();
    const store = new PostgresLedgerStore(db, 'mirror', { log: quiet, retryMs: 5 });
    await store.probe();
    store.attach(ledger, ledger.events(), 'NOTHING');

    commitProject(ledger, 'tenant-a', 'project-a', 'Ashworth');
    commitProject(ledger, 'tenant-b', 'project-b', 'Calderdale');
    renameProject(ledger, 'tenant-a', 'project-a', 'Ashworth WTW');

    assert.equal(await store.flush(2_000), 0);
    const position = store.position();
    assert.equal(position.stored, 3);
    assert.equal(position.pending, 0);
    assert.equal(position.shippedThisProcess, 3);
    assert.deepEqual([...db.tenancy.entries()], [['tenant-a', 1], ['tenant-b', 2]], 'a tenancy is registered at its first event');

    const heads = await store.compareHeads(ledger);
    assert.deepEqual(heads, { projects: 2, agreeing: 2, differing: [], missing: [] });
    assert.equal(db.evidenceTypes.size, 0, 'nothing declared until asked');
    assert.ok((await store.declareEvidenceTypes()) > 50, 'the catalogue’s evidence-requiring types are declared to the database');
  });

  it('queues what the database has not seen when it attaches, and ships that first', async () => {
    const db = new FakePostgres();
    const ledger = new GoldenThreadLedger();
    commitProject(ledger, 'tenant-a', 'project-a', 'Before the store existed');
    renameProject(ledger, 'tenant-a', 'project-a', 'Still before');

    const store = new PostgresLedgerStore(db, 'mirror', { log: quiet, retryMs: 5 });
    await store.probe();
    const { queued } = store.attach(ledger, ledger.events(), 'JOURNAL');
    assert.equal(queued, 2);
    renameProject(ledger, 'tenant-a', 'project-a', 'After');

    assert.equal(await store.flush(2_000), 0);
    assert.equal(store.position().stored, 3);
    const stored = [...db.events.values()].map((entry) => entry.row[23]);
    assert.deepEqual(stored, [1, 2, 3], 'commit order, the earlier two first');
  });

  it('retries a connection that drops, and reports the failure until it succeeds', async () => {
    const db = new FakePostgres();
    const ledger = new GoldenThreadLedger();
    const store = new PostgresLedgerStore(db, 'mirror', { log: quiet, retryMs: 5, maxRetryMs: 20 });
    await store.probe();
    store.attach(ledger, ledger.events(), 'NOTHING');

    db.failNext = 3;
    commitProject(ledger, 'tenant-a', 'project-a', 'Ashworth');
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.match(store.position().lastError ?? '', /closed the connection/);
    assert.equal(store.position().pending, 1, 'nothing is dropped while the database is away');

    assert.equal(await store.flush(2_000), 0);
    assert.equal(store.position().lastError, undefined, 'cleared by the ship that succeeded');
    assert.equal(store.position().stored, 1);
  });

  it('re-shipping an event the database already holds is a success, not a chain break', async () => {
    const db = new FakePostgres();
    const first = new GoldenThreadLedger();
    const store = new PostgresLedgerStore(db, 'mirror', { log: quiet, retryMs: 5 });
    await store.probe();
    store.attach(first, first.events(), 'NOTHING');
    commitProject(first, 'tenant-a', 'project-a', 'Ashworth');
    await store.flush(2_000);

    // A crash after the insert committed and before the process noted it: the
    // position is behind the record. The next boot ships from the position.
    db.position = 0;
    const again = new PostgresLedgerStore(db, 'mirror', { log: quiet, retryMs: 5 });
    await again.probe();
    again.attach(first, first.events(), 'JOURNAL');
    assert.equal(await again.flush(2_000), 0);
    assert.equal(again.position().halted, undefined);
    assert.equal(db.position, 1);
    assert.equal(db.events.size, 1);
  });

  it('halts, keeps everything, and says why when another writer has extended the chain', async () => {
    const db = new FakePostgres();
    const ledger = new GoldenThreadLedger();
    const store = new PostgresLedgerStore(db, 'mirror', { log: quiet, retryMs: 5 });
    await store.probe();
    store.attach(ledger, ledger.events(), 'NOTHING');
    commitProject(ledger, 'tenant-a', 'project-a', 'Ashworth');
    await store.flush(2_000);

    // Somebody else moves the head in the database.
    db.heads.set('project-a', 'sha256:somebody-else');
    renameProject(ledger, 'tenant-a', 'project-a', 'Renamed here');
    renameProject(ledger, 'tenant-a', 'project-a', 'Renamed again');
    await store.flush(2_000);

    const position = store.position();
    assert.match(position.halted ?? '', /SQLSTATE 23000/);
    assert.match(position.halted ?? '', /chain break on project-a/);
    assert.match(position.halted ?? '', /Another process has extended this chain/);
    assert.equal(position.pending, 2, 'nothing after the refused event is shipped onto the fork');
    assert.equal(position.stored, 1);
  });
});

describe('a follower keeps a second process in step with the store', () => {
  it('replays the database at boot, applies what the primary ships afterwards, and never writes', async () => {
    const db = new FakePostgres();
    const primaryLedger = new GoldenThreadLedger();
    commitProject(primaryLedger, 't1', 'p1', 'Ashworth');
    renameProject(primaryLedger, 't1', 'p1', 'Ashworth Phase 2');
    const primary = new PostgresLedgerStore(db, 'primary', { log: quiet, retryMs: 5 });
    await primary.probe();
    primary.attach(primaryLedger, primaryLedger.events(), 'JOURNAL');
    assert.equal(await primary.flush(5_000), 0);

    // The standby comes up from the database, not from a journal.
    const follower = new PostgresLedgerStore(db, 'follower', { log: quiet });
    await follower.probe();
    const replica = new GoldenThreadLedger();
    replica.restore(await follower.load());
    assert.equal(replica.size, 2);
    assert.equal(follower.position().restoredFrom, 'POSTGRES');

    const batches: number[] = [];
    const handle = follower.follow(replica, { intervalMs: 60_000, onApplied: (events) => batches.push(events.length) });
    assert.equal(await handle.poll(), 0, 'nothing new: nothing applied');

    // The primary carries on — a second tenancy, a second event on the first
    // chain — and the follower picks both up on the next poll, in order.
    commitProject(primaryLedger, 't2', 'p2', 'Calderdale');
    renameProject(primaryLedger, 't1', 'p1', 'Ashworth Phase 3');
    assert.equal(await primary.flush(5_000), 0);
    assert.equal(await handle.poll(), 2);
    assert.equal(replica.size, 4);
    assert.deepEqual(batches, [2]);
    for (const projectId of ['p1', 'p2']) assert.equal(replica.chainHead(projectId), primaryLedger.chainHead(projectId), `head of ${projectId}`);
    assert.equal(replica.require({ refType: 'Project', refId: 'p1' }).state.name, 'Ashworth Phase 3');

    const position = follower.position();
    assert.equal(position.mode, 'follower');
    assert.equal(position.stored, 4);
    assert.equal(position.following?.applied, 4);
    assert.equal(position.following?.behind, 0);
    assert.ok(position.following?.lastAppliedAt);

    // A follower ships nothing, and its ledger takes nothing once marked.
    assert.throws(() => follower.attach(replica, replica.events()), (error: unknown) => (error as { code?: string }).code === 'LEDGER_STORE_FOLLOWER');
    replica.markReadOnly('this process follows the record');
    assert.throws(() => commitProject(replica, 't3', 'p3', 'Rossendale'), (error: unknown) => (error as { code?: string }).code === 'LEDGER_READ_ONLY');
    assert.equal(replica.size, 4);

    handle.stop();
    follower.close();
    primary.close();
  });

  it('records a database it cannot reach and tries again, and halts for good on a record that no longer follows its own', async () => {
    const db = new FakePostgres();
    const primaryLedger = new GoldenThreadLedger();
    commitProject(primaryLedger, 't1', 'p1', 'Ashworth');
    const primary = new PostgresLedgerStore(db, 'primary', { log: quiet, retryMs: 5 });
    await primary.probe();
    primary.attach(primaryLedger, primaryLedger.events(), 'JOURNAL');
    assert.equal(await primary.flush(5_000), 0);

    const follower = new PostgresLedgerStore(db, 'follower', { log: quiet });
    await follower.probe();
    const replica = new GoldenThreadLedger();
    replica.restore(await follower.load());
    const handle = follower.follow(replica, { intervalMs: 60_000 });

    // The connection drops on one poll: recorded, not fatal.
    db.failNext = 1;
    assert.equal(await handle.poll(), 0);
    assert.match(follower.position().following?.lastError ?? '', /closed the connection/);
    assert.equal(follower.position().halted, undefined);
    renameProject(primaryLedger, 't1', 'p1', 'Ashworth Phase 2');
    assert.equal(await primary.flush(5_000), 0);
    assert.equal(await handle.poll(), 1);
    assert.equal(follower.position().following?.lastError, undefined, 'a poll that succeeds clears the failure');

    // Somebody extended the replica's chain locally, so the next event the
    // database holds no longer follows what this process holds. Applying it
    // would be a second record; the follower stops instead and says so.
    renameProject(replica, 't1', 'p1', 'A local fork');
    renameProject(primaryLedger, 't1', 'p1', 'Ashworth Phase 3');
    assert.equal(await primary.flush(5_000), 0);
    assert.equal(await handle.poll(), 0);
    assert.match(follower.position().halted ?? '', /no longer follows this process's/);
    assert.equal(await handle.poll(), 0, 'halted stays halted');

    handle.stop();
    follower.close();
    primary.close();
  });
});

describe('a process coming up from the store', () => {
  it('replays the database into a ledger that verifies, and continues the chain from it', async () => {
    const db = new FakePostgres();
    const writer = new GoldenThreadLedger();
    const store = new PostgresLedgerStore(db, 'primary', { log: quiet, retryMs: 5 });
    await store.probe();
    store.attach(writer, writer.events(), 'NOTHING');
    commitProject(writer, 'tenant-a', 'project-a', 'Ashworth');
    commitProject(writer, 'tenant-b', 'project-b', 'Calderdale');
    renameProject(writer, 'tenant-a', 'project-a', 'Ashworth WTW');
    await store.flush(2_000);

    // A new host with an empty volume.
    const replacement = new GoldenThreadLedger();
    const second = new PostgresLedgerStore(db, 'primary', { log: quiet, retryMs: 5 });
    await second.probe();
    const events = await second.load();
    assert.equal(events.length, 3);
    const restored = replacement.restore(events);
    assert.equal(restored.entities, 2);
    assert.equal(restored.discrepancies.length, 0);
    assert.equal(replacement.require({ refType: 'Project', refId: 'project-a' }).state.name, 'Ashworth WTW');
    assert.equal(replacement.chainHead('project-a'), writer.chainHead('project-a'));

    // The replacement carries on, and the database accepts what it writes.
    const { queued } = second.attach(replacement, replacement.events());
    assert.equal(queued, 0);
    renameProject(replacement, 'tenant-b', 'project-b', 'Calderdale Reservoir');
    assert.equal(await second.flush(2_000), 0);
    assert.equal(second.position().stored, 4);
    assert.equal(second.position().restoredFrom, 'POSTGRES');
  });

  it('replays in commit order even where a device timestamp precedes the event it chains from', async () => {
    const db = new FakePostgres();
    const writer = new GoldenThreadLedger();
    const store = new PostgresLedgerStore(db, 'primary', { log: quiet, retryMs: 5 });
    await store.probe();
    store.attach(writer, writer.events(), 'NOTHING');
    commitProject(writer, 'tenant-a', 'project-a', 'Ashworth');
    // An offline capture, stamped by the device an hour before the project
    // existed on the server. The read order puts it first; the chain does not.
    const current = writer.require({ refType: 'Project', refId: 'project-a' });
    writer.commit({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      actor: ACTOR,
      source: 'PWA',
      correlationId: 'corr-offline',
      eventType: 'PROJECT_PHASE_TRANSITIONED',
      entity: { refType: 'Project', refId: 'project-a' },
      nextState: { ...current.state, name: 'Captured offline', phase: 'DESIGN' },
      evidenceRefs: [{ refType: 'EvidenceItem', refId: 'ev-offline' }],
      timestamp: new Date(Date.now() - 3_600_000).toISOString(),
    });
    await store.flush(2_000);

    const second = new PostgresLedgerStore(db, 'primary', { log: quiet });
    await second.probe();
    const events = await second.load();
    assert.equal(events[0]!.eventType, 'PROJECT_CREATED', 'the order the chain was extended in, not the read order');
    assert.doesNotThrow(() => new GoldenThreadLedger().restore(events));
  });

  it('refuses a database whose position and record disagree, and one with a gap', async () => {
    const db = new FakePostgres();
    const writer = new GoldenThreadLedger();
    const store = new PostgresLedgerStore(db, 'primary', { log: quiet, retryMs: 5 });
    await store.probe();
    store.attach(writer, writer.events(), 'NOTHING');
    commitProject(writer, 'tenant-a', 'project-a', 'Ashworth');
    renameProject(writer, 'tenant-a', 'project-a', 'Ashworth WTW');
    await store.flush(2_000);

    db.position = 5;
    const disagreeing = new PostgresLedgerStore(db, 'primary', { log: quiet });
    await disagreeing.probe();
    await rejectsCode(() => disagreeing.load(), 'LEDGER_STORE_POSITION_DISAGREES');

    db.position = 1;
    const [first] = [...db.events.keys()];
    db.events.delete(first!);
    const gapped = new PostgresLedgerStore(db, 'primary', { log: quiet });
    await gapped.probe();
    await rejectsCode(() => gapped.load(), 'LEDGER_STORE_GAP');
  });

  it('refuses to follow a database that holds more than the process does', async () => {
    const db = new FakePostgres();
    const writer = new GoldenThreadLedger();
    const store = new PostgresLedgerStore(db, 'mirror', { log: quiet, retryMs: 5 });
    await store.probe();
    store.attach(writer, writer.events(), 'NOTHING');
    commitProject(writer, 'tenant-a', 'project-a', 'Ashworth');
    await store.flush(2_000);

    const behind = new GoldenThreadLedger();
    const mirror = new PostgresLedgerStore(db, 'mirror', { log: quiet });
    await mirror.probe();
    assert.throws(() => mirror.attach(behind, behind.events(), 'JOURNAL'), (error: { code?: string }) => error.code === 'LEDGER_STORE_AHEAD');
  });

  it('names a database without the store’s schema rather than failing on a statement', async () => {
    const bare: StoreClient = {
      async query() {
        const error = new Error('relation "ledger_position" does not exist') as Error & { sqlState: string };
        error.sqlState = '42P01';
        throw error;
      },
      async asTenant() {
        throw new Error('unreachable');
      },
    };
    const store = new PostgresLedgerStore(bare, 'primary', { log: quiet });
    await rejectsCode(() => store.probe(), 'LEDGER_STORE_SCHEMA_MISSING');
  });
});
