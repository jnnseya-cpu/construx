import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { GoldenThreadLedger } from '../src/goldenthread/ledger.ts';
import { PostgresLedgerStore } from '../src/goldenthread/pgstore.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject } from '../src/seed.ts';
import { Pool, type ConnectionOptions } from '../src/store/postgres.ts';

/**
 * The ledger store against a real Postgres 16.
 *
 * Not part of `npm test`: run by `deploy/postgres/client-check.sh`, which
 * stands up a throwaway cluster, applies the schema, and runs this after the
 * client's own checks. Skips loudly without `CONSTRUX_PG_LIVE`.
 *
 * What only a real server can prove: that the whole demonstration record —
 * thousands of events across several tenancies, every event type the seed
 * writes, evidence-requiring types among them — goes through the schema's
 * triggers and policies and comes back out of them byte for byte, so that a
 * ledger replayed from the database verifies every chain hash and agrees with
 * the ledger that wrote it on every head.
 */

const LIVE = process.env.CONSTRUX_PG_LIVE === '1';

const options: ConnectionOptions = {
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? 5432),
  user: 'construx_app',
  password: process.env.PGPASSWORD ?? '',
  database: process.env.PGDATABASE ?? 'postgres',
  tls: 'disable',
  verifyCertificate: true,
  applicationName: 'construx-ledger-store-check',
  searchPath: 'goldenthread, public',
  connectTimeoutMs: 5_000,
  statementTimeoutMs: 30_000,
};

let pool: Pool;
let platform: Platform;
let store: PostgresLedgerStore;

/** The first tenancy that actually holds a project; the platform's own tenancy holds none. */
function tenancyWithProjects(): { tenantId: string; project: ReturnType<GoldenThreadLedger['require']> } {
  for (const tenant of platform.tenants()) {
    const project = platform.ledger.listByTenant(tenant.id, 'Project')[0];
    if (project) return { tenantId: tenant.id, project };
  }
  throw new Error('the seed created no project');
}

before(async () => {
  if (!LIVE) return;
  pool = new Pool(options, 4);
  platform = new Platform();
  await seedDemoProject(platform);
  store = new PostgresLedgerStore(pool, 'primary', { log: () => undefined, retryMs: 50 });
});

after(async () => {
  if (!LIVE) return;
  store?.close();
  await pool?.close();
});

describe('the whole demonstration record goes into Postgres and comes back', { skip: LIVE ? false : 'set CONSTRUX_PG_LIVE=1 and run deploy/postgres/client-check.sh' }, () => {
  it('declares the catalogue’s evidence-requiring types so the database enforces the same list', async () => {
    const probe = await store.probe();
    // The client check before this file writes a few events of its own under
    // other tenancies; the store must not be confused by rows it did not write.
    assert.ok(probe.stored >= 0);
    const declared = await store.declareEvidenceTypes();
    assert.ok(declared > 50, `${declared} declared`);
    assert.equal(await store.declareEvidenceTypes(), 0, 'idempotent');
  });

  it('ships every event the seed wrote, in order, through the triggers, and the heads agree', async () => {
    const before = platform.ledger.size;
    assert.ok(before > 500, `the seed wrote ${before} events`);
    const { queued } = store.attach(platform.ledger, platform.ledger.events(), 'JOURNAL');
    assert.equal(queued, before);
    const pending = await store.flush(120_000);
    assert.equal(pending, 0, `${pending} events did not ship: ${store.position().halted ?? store.position().lastError ?? ''}`);
    assert.equal(store.position().halted, undefined);
    assert.equal(store.position().stored, before);

    const heads = await store.compareHeads(platform.ledger);
    assert.equal(heads.differing.length, 0, `heads differ on ${heads.differing.join(', ')}`);
    assert.equal(heads.missing.length, 0, `heads missing for ${heads.missing.join(', ')}`);
    assert.equal(heads.agreeing, heads.projects);
  });

  it('a commit made after attaching ships behind it and the head moves', async () => {
    const { tenantId, project } = tenancyWithProjects();
    const before = store.position().stored;
    platform.ledger.commit({
      tenantId,
      projectId: project.projectId,
      actor: { refType: 'User', refId: 'live-check' },
      source: 'WEB',
      correlationId: 'live-check',
      eventType: 'PROJECT_PHASE_TRANSITIONED',
      entity: { refType: 'Project', refId: project.refId },
      nextState: { ...project.state, phase: project.state.phase === 'CONCEPT' ? 'DESIGN' : 'CONCEPT' },
      evidenceRefs: [{ refType: 'EvidenceItem', refId: 'ev-live-check' }],
    });
    assert.equal(await store.flush(10_000), 0);
    assert.equal(store.position().stored, before + 1);
    const heads = await store.compareHeads(platform.ledger);
    assert.equal(heads.differing.length, 0);
  });

  it('a fresh process replays the database into a ledger that verifies every hash and matches the writer', async () => {
    const replacement = new GoldenThreadLedger();
    const second = new PostgresLedgerStore(pool, 'primary', { log: () => undefined });
    await second.probe();
    const events = await second.load();
    assert.equal(events.length, platform.ledger.size);
    const restored = replacement.restore(events);
    assert.equal(restored.restored, platform.ledger.size);
    assert.equal(restored.discrepancies.length, platform.ledger.discrepancies().length);
    for (const projectId of new Set(events.map((event) => event.projectId))) {
      assert.equal(replacement.chainHead(projectId), platform.ledger.chainHead(projectId), `head of ${projectId}`);
    }
    // The record is byte for byte the writer's: the same entities, the same
    // state hashes, in every tenancy the seed created.
    for (const tenant of platform.tenants()) {
      const written = platform.ledger.listByTenant(tenant.id, 'Project').map((record) => [record.refId, record.stateHash]);
      const replayed = replacement.listByTenant(tenant.id, 'Project').map((record) => [record.refId, record.stateHash]);
      assert.deepEqual(replayed, written);
    }
    second.close();
  });

  it('row-level security shows a tenancy only its own events, as the application role', async () => {
    const tenants = platform.tenants().filter((tenant) => platform.ledger.events({ tenantId: tenant.id }).length > 0);
    assert.ok(tenants.length >= 2, 'the seed writes for more than one tenancy');
    const counts: number[] = [];
    for (const tenant of tenants) {
      const seen = await pool.asTenant(tenant.id, (connection) => connection.query<{ count: number }>('SELECT count(*)::int AS count FROM event'));
      const expected = platform.ledger.events({ tenantId: tenant.id }).length;
      assert.equal(seen.rows[0]?.count, expected, `tenancy ${tenant.id} sees exactly its own ${expected} events`);
      counts.push(expected);
    }
    assert.notEqual(counts[0], counts[1], 'the two tenancies hold different records');
  });

  it('halts rather than forking when the database’s head has moved under it', async () => {
    const { tenantId, project } = tenancyWithProjects();
    // Another writer: an event inserted directly, following the real head.
    const head = platform.ledger.chainHead(project.projectId);
    await pool.asTenant(tenantId, (connection) =>
      connection.query(
        `INSERT INTO event (event_id, tenant_id, project_id, occurred_at, actor_type, actor_id, source, event_type, entity_type, entity_id,
           action, before_hash, after_hash, diff, correlation_id, chain_hash, previous_chain_hash)
         VALUES ($1,$2,$3,$4,'User','intruder','WEB','PROJECT_CREATED','Project',$5,'CREATE',$6,$6,'[]','intruder',$7,$8)`,
        [
          'evt-intruder',
          tenantId,
          project.projectId,
          new Date().toISOString(),
          project.refId,
          'sha256:0000000000000000000000000000000000000000000000000000000000000000',
          `sha256:${'f'.repeat(64)}`,
          head,
        ],
      ),
    );
    platform.ledger.commit({
      tenantId,
      projectId: project.projectId,
      actor: { refType: 'User', refId: 'live-check' },
      source: 'WEB',
      correlationId: 'live-check-2',
      eventType: 'PROJECT_PHASE_TRANSITIONED',
      entity: { refType: 'Project', refId: project.refId },
      nextState: { ...platform.ledger.require({ refType: 'Project', refId: project.refId }).state, phase: 'TENDER' },
      evidenceRefs: [{ refType: 'EvidenceItem', refId: 'ev-live-check-2' }],
    });
    await store.flush(10_000);
    const position = store.position();
    assert.match(position.halted ?? '', /chain break/);
    assert.equal(position.pending, 1, 'the refused event is kept, not dropped');
  });
});
