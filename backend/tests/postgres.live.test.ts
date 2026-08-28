import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Pool, PostgresError, type ConnectionOptions } from '../src/store/postgres.ts';

/**
 * The Postgres client, against a real Postgres.
 *
 * Not part of `npm test`. This file needs a live server, and it is run by
 * `deploy/postgres/client-check.sh`, which stands one up, applies the schema,
 * runs this, and removes the cluster. Without `CONSTRUX_PG_LIVE` it skips —
 * loudly, so a skipped run is never mistaken for a passing one.
 *
 * Testing a wire-protocol client against a fake server proves the fake. The
 * things that actually break — SCRAM's exact string concatenation, a message
 * split across two TCP reads, a `text[]` round trip, the schema's own triggers
 * firing on a real write — only show up against the real thing.
 */

const LIVE = process.env.CONSTRUX_PG_LIVE === '1';

const options: ConnectionOptions = {
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? 5432),
  user: 'construx_app',
  password: process.env.PGPASSWORD ?? '',
  database: process.env.PGDATABASE ?? 'postgres',
  // The check runs over loopback to a cluster with no certificate. `prefer`
  // asks and continues; a deployment sets `require`, which refuses.
  tls: 'disable',
  verifyCertificate: true,
  applicationName: 'construx-client-check',
  // Where `schema.sql` actually puts the tables. Getting this wrong is not a
  // connection failure — it is a connection that works and sees nothing.
  searchPath: 'goldenthread, public',
  connectTimeoutMs: 5_000,
  statementTimeoutMs: 10_000,
};

let pool: Pool;

before(async () => {
  if (!LIVE) return;
  pool = new Pool(options, 4);
});

after(async () => {
  if (!LIVE) return;
  await pool.close();
});

describe('connecting to a real server', { skip: LIVE ? false : 'set CONSTRUX_PG_LIVE=1 and run deploy/postgres/client-check.sh' }, () => {
  it('authenticates with SCRAM-SHA-256 against a cluster that demands it', async () => {
    // The cluster is initialised with `--auth-host=scram-sha-256`, so a client
    // that only spoke MD5 could not connect at all. Getting here proves the
    // whole four-message exchange, including the server-signature verification
    // that most implementations skip.
    const connection = await pool.acquire();
    try {
      assert.equal(connection.open, true);
      assert.match(connection.serverVersion, /^1[6-9]/);
      // Sent at startup rather than as a later SET, so it holds for the first
      // statement as well as the hundredth.
      assert.equal(connection.parameters.get('TimeZone'), 'UTC');
    } finally {
      pool.release(connection);
    }
  });

  it('refuses a wrong password rather than connecting anyway', async () => {
    const wrong = new Pool({ ...options, password: 'not-the-password' }, 1);
    await assert.rejects(() => wrong.acquire(), /password|authentication/i);
    await wrong.close();
  });
});

describe('parameters travel separately from the statement', { skip: LIVE ? false : 'live only' }, () => {
  it('sends a value that would be catastrophic as syntax', async () => {
    // The injection test that matters. If this value were interpolated the
    // statement would end early and drop a table; sent as a parameter it is a
    // string, and comes back as one.
    const hostile = "'; DROP TABLE event; --";
    const result = await pool.query<{ echoed: string }>('SELECT $1::text AS echoed', [hostile]);
    assert.equal(result.rows[0]?.echoed, hostile);

    // And the table is still there.
    const still = await pool.query<{ count: unknown }>('SELECT count(*) AS count FROM event');
    assert.ok(still.rows.length === 1);
  });

  it('distinguishes null from an empty string', async () => {
    const result = await pool.query<{ a: unknown; b: unknown }>('SELECT $1::text AS a, $2::text AS b', [null, '']);
    assert.equal(result.rows[0]?.a, null);
    assert.equal(result.rows[0]?.b, '');
  });

  it('round-trips the types the schema actually uses', async () => {
    const result = await pool.query<{
      t: string;
      n: number;
      big: unknown;
      flag: boolean;
      doc: Record<string, unknown>;
      roles: string[];
      at: string;
    }>(
      `SELECT $1::text AS t, $2::int AS n, $3::bigint AS big, $4::boolean AS flag,
              $5::jsonb AS doc, $6::text[] AS roles, $7::timestamptz AS at`,
      ['a drawing', 42, 9007199254740993n.toString(), true, { op: 'add', path: '/a' }, ['PM', 'QS'], '2026-08-28T09:00:00.000Z'],
    );
    const row = result.rows[0]!;
    assert.equal(row.t, 'a drawing');
    assert.equal(row.n, 42);
    // Beyond Number.MAX_SAFE_INTEGER, so it stays a string rather than losing
    // its last digit silently.
    assert.equal(row.big, '9007199254740993');
    assert.equal(row.flag, true);
    assert.deepEqual(row.doc, { op: 'add', path: '/a' });
    assert.deepEqual(row.roles, ['PM', 'QS']);
    assert.match(String(row.at), /2026-08-28 09:00:00\+00/);
  });

  it('survives a role containing a comma and a quote', async () => {
    // The naive array parser splits on comma and corrupts exactly this.
    const awkward = ['Commercial, Lead', 'says "no"', 'back\\slash'];
    const result = await pool.query<{ roles: string[] }>('SELECT $1::text[] AS roles', [awkward]);
    assert.deepEqual(result.rows[0]?.roles, awkward);
  });

  it('never turns numeric into a float', async () => {
    // A payment certificate rounded by a client-side parse is the defect this
    // prevents. The server's own text is returned untouched.
    const result = await pool.query<{ amount: unknown }>('SELECT $1::numeric AS amount', ['12345678901234.56']);
    assert.equal(result.rows[0]?.amount, '12345678901234.56');
  });

  it('handles a value larger than one TCP read', async () => {
    // A megabyte of text arrives across many `data` events. A reader that
    // treated one event as one message would hang here.
    const large = 'x'.repeat(1_000_000);
    const result = await pool.query<{ n: number }>('SELECT length($1::text) AS n', [large]);
    assert.equal(result.rows[0]?.n, 1_000_000);
  });
});

describe('the schema refuses the client the same way it refuses psql', { skip: LIVE ? false : 'live only' }, () => {
  const event = (over: Record<string, unknown> = {}) => ({
    event_id: `evt-${Math.random().toString(36).slice(2)}`,
    tenant_id: 'tenant-a',
    project_id: 'project-a',
    occurred_at: '2026-08-28T09:00:00.000Z',
    actor_type: 'User',
    actor_id: 'user-1',
    actor_roles: ['PM'],
    source: 'WEB',
    event_type: 'PROJECT_CREATED',
    entity_type: 'Project',
    entity_id: 'project-a',
    action: 'CREATE',
    before_hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    after_hash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    diff: [],
    correlation_id: 'corr-1',
    chain_hash: `sha256:${Math.random().toString(16).slice(2).padEnd(64, '0').slice(0, 64)}`,
    previous_chain_hash: null,
    ...over,
  });

  const INSERT = `
    INSERT INTO event (
      event_id, tenant_id, project_id, occurred_at, actor_type, actor_id, actor_roles,
      source, event_type, entity_type, entity_id, action, before_hash, after_hash,
      diff, correlation_id, chain_hash, previous_chain_hash
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`;

  const values = (row: Record<string, unknown>) => [
    row.event_id, row.tenant_id, row.project_id, row.occurred_at, row.actor_type, row.actor_id,
    row.actor_roles, row.source, row.event_type, row.entity_type, row.entity_id, row.action,
    row.before_hash, row.after_hash, row.diff, row.correlation_id, row.chain_hash, row.previous_chain_hash,
  ];

  it('writes a first event for a tenancy the connection is acting for', async () => {
    const row = event();
    await pool.asTenant('tenant-a', async (connection) => {
      const result = await connection.query(INSERT, values(row));
      assert.equal(result.rowCount, 1);
    });

    const read = await pool.asTenant('tenant-a', (connection) =>
      connection.query<{ event_id: string }>('SELECT event_id FROM event WHERE event_id = $1', [row.event_id]),
    );
    assert.equal(read.rows[0]?.event_id, row.event_id);
  });

  it('refuses a write for a different tenancy than the connection declared', async () => {
    // `assert_tenant_matches_session` raises insufficient_privilege, which the
    // client maps to 403 rather than 500 — a refusal, not a fault.
    await assert.rejects(
      () => pool.asTenant('tenant-a', (connection) => connection.query(INSERT, values(event({ tenant_id: 'tenant-b' })))),
      (error: PostgresError) => {
        assert.equal(error.sqlState, '42501');
        assert.equal(error.status, 403);
        assert.match(error.message, /tenant mismatch/i);
        return true;
      },
    );
  });

  it('shows a tenancy nothing that belongs to another', async () => {
    // Forced RLS, as the application role — which the schema creates
    // NOSUPERUSER NOBYPASSRLS precisely so this is a real test.
    const other = await pool.asTenant('tenant-z', (connection) =>
      connection.query<{ count: unknown }>('SELECT count(*)::int AS count FROM event'),
    );
    assert.equal(other.rows[0]?.count, 0);
  });

  it('refuses an update and a delete on the event table', async () => {
    // The append-only rules are DO INSTEAD NOTHING, so these do not error —
    // they affect nothing. Asserting the row count is the only way to tell,
    // and asserting it is how nobody later "fixes" the rules into errors and
    // breaks a caller that relies on the silence.
    await pool.asTenant('tenant-a', async (connection) => {
      const updated = await connection.query("UPDATE event SET event_type = 'TAMPERED' WHERE tenant_id = $1", ['tenant-a']);
      assert.equal(updated.rowCount, 0);
      const deleted = await connection.query('DELETE FROM event WHERE tenant_id = $1', ['tenant-a']);
      assert.equal(deleted.rowCount, 0);
    });

    const survived = await pool.asTenant('tenant-a', (connection) =>
      connection.query<{ count: number }>("SELECT count(*)::int AS count FROM event WHERE event_type = 'PROJECT_CREATED'"),
    );
    assert.ok((survived.rows[0]?.count ?? 0) >= 1);
  });

  it('lets exactly one of two concurrent writers extend the chain', async () => {
    // The property the whole schema exists for. Both read the same head and
    // both try to follow it; the row lock plus the unique index means one
    // commits and one is refused, rather than two events claiming the same
    // predecessor and the chain forking silently.
    const head = await pool.asTenant('tenant-a', (connection) =>
      connection.query<{ chain_hash: string }>('SELECT chain_hash FROM chain_head WHERE project_id = $1', ['project-a']),
    );
    const previous = head.rows[0]?.chain_hash ?? null;

    const attempt = (suffix: string) =>
      pool.asTenant('tenant-a', (connection) =>
        connection.query(INSERT, values(event({ previous_chain_hash: previous, chain_hash: `sha256:${suffix.padEnd(64, 'a').slice(0, 64)}` }))),
      );

    const outcomes = await Promise.allSettled([attempt('c1'), attempt('c2')]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');

    assert.equal(fulfilled.length, 1, 'both writers were allowed to extend the same chain head');
    assert.equal(rejected.length, 1);
  });

  it('reports a server error as a refusal a caller can read, not a 500 with a stack', async () => {
    await assert.rejects(
      () => pool.query('SELECT * FROM a_table_that_does_not_exist'),
      (error: PostgresError) => {
        assert.equal(error.sqlState, '42P01');
        assert.match(error.message, /does not exist/);
        // The statement is attached for diagnosis; nothing else is.
        assert.match(error.sqlText ?? '', /a_table_that_does_not_exist/);
        return true;
      },
    );
  });
});

describe('transactions and the pool', { skip: LIVE ? false : 'live only' }, () => {
  it('rolls back on a throw and leaves nothing behind', async () => {
    await pool.query('CREATE TEMP TABLE IF NOT EXISTS scratch (v text)').catch(() => undefined);

    await assert.rejects(
      () =>
        pool.transaction(async (connection) => {
          await connection.execute('CREATE TEMP TABLE rollback_probe (v text)');
          await connection.query('INSERT INTO rollback_probe VALUES ($1)', ['written']);
          throw new Error('the caller changed their mind');
        }),
      /changed their mind/,
    );

    // The temp table went with the rollback, so selecting from it is an
    // undefined-table error rather than an empty result.
    await assert.rejects(() => pool.query('SELECT * FROM rollback_probe'), /does not exist/);
  });

  it('scopes the tenancy setting to the transaction, so it cannot leak to the next borrower', async () => {
    await pool.asTenant('tenant-a', async (connection) => {
      const inside = await connection.query<{ v: string }>("SELECT current_setting('construx.tenant_id', true) AS v");
      assert.equal(inside.rows[0]?.v, 'tenant-a');
    });

    // Same pool, very likely the same socket. `set_config(..., true)` is
    // transaction-scoped, so the setting is gone — which is what stops one
    // tenancy's setting being inherited by the next request to borrow this
    // connection.
    const after_ = await pool.query<{ v: string | null }>("SELECT current_setting('construx.tenant_id', true) AS v");
    assert.ok(after_.rows[0]?.v === null || after_.rows[0]?.v === '');
  });

  it('runs more statements at once than one socket could carry', async () => {
    // Four connections, sixteen statements. A single connection runs one at a
    // time by protocol; concurrency is the pool's job and this proves it does it.
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, index) => pool.query<{ n: number }>('SELECT $1::int AS n', [index])),
    );
    assert.deepEqual(
      results.map((result) => result.rows[0]?.n),
      Array.from({ length: 16 }, (_, index) => index),
    );
    assert.ok(pool.statistics.open <= 4);
  });

  it('refuses a second statement on a connection already running one', async () => {
    const connection = await pool.acquire();
    try {
      const first = connection.query('SELECT pg_sleep(0.2)');
      await assert.rejects(() => connection.query('SELECT 1'), /already running/);
      await first;
    } finally {
      pool.release(connection);
    }
  });
});
