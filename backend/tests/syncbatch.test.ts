import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { createGateway } from '../src/api/gateway.ts';
import { MAX_SYNC_BATCH, SYNC_SCHEMA_VERSION, type SyncOperation } from '../src/field/sync.ts';
import { rateLimiter } from '../src/api/middleware.ts';
import { Platform } from '../src/platform.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The batch contract the native apps are built against.
 *
 * Everything below is about a push that is *not* the happy one: a batch too
 * large to read, a device speaking a shape the server does not know, and the
 * same batch arriving twice because the connection dropped between the server
 * committing and the device hearing about it. On site all three are ordinary.
 *
 * The rule they share: **a batch the server cannot read is refused whole.** The
 * device still holds every operation, so refusing costs nothing and guessing
 * costs a site record. Partial application is the outcome with no way back — the
 * ledger is append-only, and half a shift filed under a misread schema cannot
 * be unfiled.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;
let token: string;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // `seed.users.*.auth` is a verified context, not a bearer string — the field
  // app sends the latter, so the test mints one the same way sign-in does.
  const person = platform.user(seed.users.siteManager!.id);
  token = issueTokens({
    actorId: person.id,
    tenantId: person.tenantId,
    partyId: person.partyId,
    roles: person.roles,
    mfaSatisfied: true,
  }).accessToken;
  rateLimiter.reset();
});

after(() => server.close());

/** One well-formed field operation, with whatever we want to break about it. */
function operation(index: number, over: Partial<SyncOperation> = {}): SyncOperation {
  return {
    operationId: `op-batch-${index}`,
    deviceId: 'device-batch',
    deviceTimestamp: new Date(Date.now() - 3_600_000 + index).toISOString(),
    eventType: 'SITE_OBSERVATION_CAPTURED',
    entity: { refType: 'SiteObservation', refId: `obs-batch-${index}` },
    nextState: { id: `obs-batch-${index}`, category: 'QUALITY', note: 'Batch contract fixture' },
    // The catalogue refuses a site observation with nothing behind it, which is
    // the right rule: an observation with no photograph is somebody's opinion.
    evidenceRefs: [{ refType: 'EvidenceItem', refId: `ev-batch-${index}` }],
    source: 'ANDROID',
    ...over,
  };
}

const pushOf = (operations: SyncOperation[], batchKey?: string) =>
  platform.sync.push(seed.users.siteManager!.auth, seed.projectId, operations, 'corr-batch', batchKey);

describe('a push is bounded', () => {
  it('refuses a batch larger than the limit, naming the limit', () => {
    const before = platform.ledger.list(seed.projectId, 'SiteObservation').length;
    const oversized = Array.from({ length: MAX_SYNC_BATCH + 1 }, (_, i) => operation(i));
    const refusal = throwsCode(() => pushOf(oversized), 'SYNC_BATCH_TOO_LARGE');
    assert.match(refusal.message ?? '', new RegExp(String(MAX_SYNC_BATCH)));
    // And nothing from it was applied: an oversized batch is not a partial one.
    // Counted against what the project already held, because the seeded estate
    // has observations of its own and zero was never the right expectation.
    assert.equal(platform.ledger.list(seed.projectId, 'SiteObservation').length, before);
  });

  it('accepts a batch exactly at the limit, so the boundary is inclusive', () => {
    const full = Array.from({ length: MAX_SYNC_BATCH }, (_, i) => operation(10_000 + i));
    const result = pushOf(full);
    assert.equal(result.accepted.length + result.conflicts.length + result.duplicates.length, MAX_SYNC_BATCH);
  });
});

describe('a device declares the shape it speaks', () => {
  it('refuses a batch from a device newer than the server, and applies none of it', () => {
    const before = platform.ledger.events({ projectId: seed.projectId }).length;
    const refusal = throwsCode(
      () => pushOf([operation(1, { schemaVersion: SYNC_SCHEMA_VERSION + 1 })]),
      'SYNC_SCHEMA_UNSUPPORTED',
    );
    // The message has to tell the device to *hold*, not to discard: the work is
    // on the phone and the server is the thing that is behind.
    assert.match(refusal.message ?? '', /Hold the batch/);
    assert.equal(platform.ledger.events({ projectId: seed.projectId }).length, before, 'operations were applied anyway');
  });

  it('refuses the whole batch where one operation is from the future', () => {
    // The realistic shape of a staged rollout: a device part-way through an
    // update, or a batch assembled across an upgrade. One unreadable operation
    // makes the batch unreadable, because applying its siblings and dropping it
    // silently reorders a shift.
    throwsCode(
      () => pushOf([operation(2), operation(3, { schemaVersion: SYNC_SCHEMA_VERSION + 5 }), operation(4)]),
      'SYNC_SCHEMA_UNSUPPORTED',
    );
  });

  it('treats an operation with no version as the current shape, because the shipped PWA sends none', () => {
    const result = pushOf([operation(5)]);
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.accepted.length, 1);
  });
});

describe('the same batch twice is the same answer twice', () => {
  it('returns the first result rather than reporting every operation a duplicate', () => {
    const batch = [operation(20), operation(21)];
    const first = pushOf(batch, 'batch-key-alpha');
    assert.equal(first.accepted.length, 2);

    // The retry a device makes when it never heard the first answer.
    const again = pushOf(batch, 'batch-key-alpha');
    assert.deepEqual(again, first, 'the retry produced a different answer from the original');
    assert.equal(again.duplicates.length, 0, 'the retry reported its own operations as duplicates');
  });

  it('still falls back to per-operation idempotency when no batch key is given', () => {
    const batch = [operation(30)];
    assert.equal(pushOf(batch).accepted.length, 1);
    const again = pushOf(batch);
    assert.deepEqual(again.accepted, []);
    assert.deepEqual(again.duplicates, ['op-batch-30']);
  });
});

describe('the batch contract over HTTP', () => {
  it('takes the batch key from the Idempotency-Key header the gateway already reads', async () => {
    const body = { operations: [operation(40), operation(41)] };
    const send = () =>
      fetch(`${base}/v1/projects/${seed.projectId}/sync/push`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'idempotency-key': 'http-batch-key',
        },
        body: JSON.stringify(body),
      });

    const raw = await send();
    const first = (await raw.json()) as { accepted: string[]; syncSessionId: string };
    assert.equal(raw.status, 201, JSON.stringify(first));
    assert.equal(first.accepted.length, 2, JSON.stringify(first));

    const retry = (await (await send()).json()) as { accepted: string[]; syncSessionId: string };
    // The session id is the tell: a genuinely re-run push mints a new one.
    assert.equal(retry.syncSessionId, first.syncSessionId, 'the retry was processed as a fresh push');
  });

  it('rejects an oversized batch at the schema, before the engine reads it', async () => {
    const response = await fetch(`${base}/v1/projects/${seed.projectId}/sync/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ operations: Array.from({ length: MAX_SYNC_BATCH + 1 }, (_, i) => operation(50_000 + i)) }),
    });
    // 400, not 422: the platform answers a malformed body with a field error and
    // reserves 422 for a request that was well formed and refused on its merits.
    // The engine's own 413 sits behind this and catches a non-HTTP caller.
    assert.equal(response.status, 400);
    const problem = (await response.json()) as Record<string, unknown>;
    assert.match(JSON.stringify(problem), new RegExp(String(MAX_SYNC_BATCH)), JSON.stringify(problem));
  });
});

/**
 * Specification A4, conflict class 3: append-only objects never conflict.
 *
 * Diary segments, photographs and observations are appends. Two people
 * capturing at once have not disagreed about anything — they have each recorded
 * something that happened — and a conflict between them would be the platform
 * inventing a disagreement in order to discard one of them.
 *
 * It holds structurally rather than by a rule: the conflict path is entered only
 * where the device carried a base hash *and* a record already exists to be stale
 * against. An append has no base. That is a good reason to believe it and a poor
 * reason to leave it untested, because the property people rely on is the
 * doctrine — the app never blocks capture — not the implementation detail that
 * currently delivers it.
 */
describe('appends never conflict, however many devices are capturing', () => {
  it('accepts every observation from two devices at once, in device-time order', () => {
    const both: SyncOperation[] = [
      operation(60, { deviceId: 'device-a', deviceTimestamp: '2026-09-01T08:00:02.000Z' }),
      operation(61, { deviceId: 'device-b', deviceTimestamp: '2026-09-01T08:00:01.000Z' }),
      operation(62, { deviceId: 'device-a', deviceTimestamp: '2026-09-01T08:00:03.000Z' }),
    ];
    const result = pushOf(both);

    assert.deepEqual(result.conflicts, [], 'two people capturing at once were treated as a disagreement');
    assert.equal(result.accepted.length, 3);

    // Ordered by the time on site, not the order the batch happened to arrive
    // in. The device that was a second earlier is first on the record.
    assert.deepEqual(result.accepted, ['op-batch-61', 'op-batch-60', 'op-batch-62']);
  });

  it('keeps the device clock rather than rewriting it to server time', () => {
    // A4's clock discipline: the device timestamp is contractual evidence. The
    // server records when it received the operation alongside; it never
    // replaces when the work happened.
    const captured = '2026-09-01T06:15:00.000Z';
    pushOf([operation(70, { deviceTimestamp: captured })]);

    const event = platform.ledger
      .events({ projectId: seed.projectId })
      .find((e) => e.entity.refId === 'obs-batch-70');
    assert.ok(event, 'the observation never reached the ledger');
    assert.equal(event.deviceTimestamp, captured, 'the device clock was rewritten to server time');
    // And the server's own receive time is recorded beside it rather than
    // instead of it — both facts, neither replacing the other.
    assert.ok(event.timestamp, 'no server receive time was recorded');
    assert.notEqual(event.timestamp, event.deviceTimestamp);
  });
});
