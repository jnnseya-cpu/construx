import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import { throwsCode } from './helpers.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import type { SyncOperation } from '../src/field/sync.ts';
import { hashEvidence } from '../src/core/canonical.ts';
import type { AuthContext } from '../src/identity/auth.ts';

describe('offline field sync', () => {
  let platform: Platform;
  let seed: SeedResult;
  let auth: AuthContext;
  let taskId: string;

  before(async () => {
    platform = new Platform();
    seed = await seedDemoProject(platform);
    auth = seed.users.pm?.auth as AuthContext;
    taskId = platform.ledger.list(seed.projectId, 'Task')[0]?.refId as string;
  });

  /** A device timestamp `hoursAgo` in the past, as an offline capture would be. */
  function agoIso(hoursAgo: number): string {
    return new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  }

  function observation(operationId: string, deviceTimestamp: string): SyncOperation {
    const id = `${operationId}-obs`;
    return {
      operationId,
      deviceId: 'device-1',
      deviceTimestamp,
      eventType: 'SITE_OBSERVATION_CAPTURED',
      entity: { refType: 'SiteObservation', refId: id },
      nextState: { id, projectId: seed.projectId, note: 'Captured offline', capturedAt: deviceTimestamp },
      evidenceRefs: [{ refType: 'EvidenceItem', refId: platform.ledger.list(seed.projectId, 'EvidenceItem')[0]?.refId as string }],
      source: 'ANDROID',
    };
  }

  it('accepts a batch captured with no connectivity', () => {
    const result = platform.sync.push(
      auth,
      seed.projectId,
      [observation('op-1', agoIso(6)), observation('op-2', agoIso(4))],
      'corr-sync-1',
    );
    assert.equal(result.accepted.length, 2);
    assert.equal(result.conflicts.length, 0);
  });

  it('preserves the device timestamp alongside the server receipt time', () => {
    const capturedAt = agoIso(9);
    platform.sync.push(auth, seed.projectId, [observation('op-3', capturedAt)], 'corr-sync-2');
    const event = platform.ledger
      .events({ projectId: seed.projectId })
      .find((e) => e.entity.refId === 'op-3-obs');

    assert.equal(event?.deviceTimestamp, capturedAt);
    // The server time is when the record arrived, necessarily later than the
    // moment on site that it describes.
    assert.ok((event?.timestamp as string) > capturedAt);
  });

  it('is idempotent when a dropped connection causes a retry', () => {
    const batch = [observation('op-retry', agoIso(3))];
    const first = platform.sync.push(auth, seed.projectId, batch, 'corr-sync-3');
    const second = platform.sync.push(auth, seed.projectId, batch, 'corr-sync-3');

    assert.equal(first.accepted.length, 1);
    assert.equal(second.accepted.length, 0);
    assert.deepEqual(second.duplicates, ['op-retry']);

    const matching = platform.ledger.events({ projectId: seed.projectId }).filter((e) => e.entity.refId === 'op-retry-obs');
    assert.equal(matching.length, 1, 'a retried batch must not write the record twice');
  });

  it('refuses governance actions from a device', () => {
    const result = platform.sync.push(
      auth,
      seed.projectId,
      [
        {
          operationId: 'op-forbidden',
          deviceId: 'device-1',
          deviceTimestamp: agoIso(2),
          eventType: 'BUDGET_BASELINE_APPROVED',
          entity: { refType: 'Budget', refId: 'offline-budget' },
          nextState: { id: 'offline-budget' },
          source: 'ANDROID',
        },
      ],
      'corr-sync-4',
    );

    assert.equal(result.accepted.length, 0);
    assert.equal(result.conflicts[0]?.resolution, 'REJECTED');
    assert.equal(result.conflicts[0]?.reason, 'EVENT_NOT_PERMITTED_OFFLINE');
  });

  it('never lets an offline device pull progress backwards', () => {
    const task = platform.ledger.require({ refType: 'Task', refId: taskId });
    const serverPercent = Number(task.state.percentComplete);
    assert.ok(serverPercent > 0, 'the seeded project should have measured progress');

    const result = platform.sync.push(
      auth,
      seed.projectId,
      [
        {
          operationId: 'op-regression',
          deviceId: 'device-2',
          deviceTimestamp: agoIso(1),
          eventType: 'TASK_UPDATED',
          entity: { refType: 'Task', refId: taskId },
          nextState: { ...task.state, percentComplete: 1 },
          baseStateHash: 'sha256:stale',
          source: 'IOS',
        },
      ],
      'corr-sync-5',
    );

    assert.equal(result.accepted.length, 0);
    assert.equal(result.conflicts[0]?.reason, 'PROGRESS_REGRESSION');
    assert.equal(result.conflicts[0]?.resolution, 'SERVER_WINS');
    assert.equal(Number(platform.ledger.require({ refType: 'Task', refId: taskId }).state.percentComplete), serverPercent);
  });

  it('pulls events by cursor and refuses to move a cursor backwards', () => {
    const first = platform.sync.pull(auth, seed.projectId, 'device-3', undefined, 20);
    assert.equal(first.events.length, 20);
    assert.equal(first.hasMore, true);

    const second = platform.sync.pull(auth, seed.projectId, 'device-3', first.cursor, 20);
    assert.ok(second.cursor >= first.cursor);

    throwsCode(
      () => platform.sync.pull(auth, seed.projectId, 'device-3', '1970-01-01T00:00:00.000Z', 20),
      'CURSOR_REGRESSION',
    );
  });

  it('leaves the ledger verifiable after synchronisation', async () => {
    const { replayProject } = await import('../src/goldenthread/replay.ts');
    const report = replayProject(platform.ledger, seed.tenantId, seed.projectId, new Date().toISOString());
    assert.equal(report.verificationStatus, 'VERIFIED');
  });

  it('binds media hashes to the capturing device and time', () => {
    const a = hashEvidence('device-1|2026-09-01T08:00:00.000Z|photo-bytes');
    const b = hashEvidence('device-2|2026-09-01T08:00:00.000Z|photo-bytes');
    assert.notEqual(a, b, 'the same bytes from a different device must not collide');
  });
});

describe('branded exports', () => {
  let platform: Platform;
  let seed: SeedResult;

  before(async () => {
    platform = new Platform();
    seed = await seedDemoProject(platform);
  });

  it('applies the client identity to every document', () => {
    const document = platform.exports.projectReport(seed.users.pm?.auth as AuthContext, seed.projectId, {
      audience: 'CLIENT',
      correlationId: 'corr-export-1',
    });
    assert.equal(document.branding.clientName, 'Meridian Infrastructure Group Ltd');
    assert.ok(document.reference.startsWith('MIG'));
    assert.match(document.contentHash, /^sha256:[0-9a-f]{64}$/);
  });

  it('records every export as a Golden Thread event with its hash', () => {
    const before = platform.ledger.list(seed.projectId, 'Export').length;
    const document = platform.exports.projectReport(seed.users.pm?.auth as AuthContext, seed.projectId, {
      audience: 'CLIENT',
      correlationId: 'corr-export-2',
    });
    const exports = platform.ledger.list(seed.projectId, 'Export');

    assert.equal(exports.length, before + 1);
    assert.ok(exports.some((e) => e.state.contentHash === document.contentHash));
  });

  it('withholds commercial detail from a regulator copy and says so on the document', () => {
    const regulatorCopy = platform.exports.projectReport(seed.users.regulator?.auth as AuthContext, seed.projectId, {
      audience: 'REGULATOR',
      correlationId: 'corr-export-3',
    });
    const clientCopy = platform.exports.projectReport(seed.users.pm?.auth as AuthContext, seed.projectId, {
      audience: 'CLIENT',
      correlationId: 'corr-export-4',
    });

    assert.ok(regulatorCopy.redactionNotice, 'the recipient must be told something was withheld');
    assert.ok(!JSON.stringify(regulatorCopy.blocks).includes('Forecast margin'));
    assert.ok(JSON.stringify(clientCopy.blocks).includes('Forecast margin'));
  });

  it('produces an audit export carrying an attestation the recipient can verify', () => {
    const document = platform.exports.auditExport(seed.users.qs?.auth as AuthContext, seed.projectId, {
      audience: 'ADJUDICATOR',
      from: '1970-01-01T00:00:00.000Z',
      to: new Date().toISOString(),
      correlationId: 'corr-export-5',
    });

    const attestation = document.blocks.find((b) => b.kind === 'ATTESTATION');
    assert.ok(attestation, 'an audit export without an attestation cannot be checked');
    assert.match((attestation as { rootHash: string }).rootHash, /^sha256:/);
    assert.match((attestation as { chainHead: string }).chainHead, /^sha256:/);
  });

  it('refuses to export before client branding is configured', () => {
    const bare = new Platform();
    throwsCode(
      () => bare.exports.branding('unknown-tenant'),
      'BRANDING_NOT_CONFIGURED',
    );
  });

  it('renders self-contained branded HTML', () => {
    const document = platform.exports.projectReport(seed.users.pm?.auth as AuthContext, seed.projectId, {
      audience: 'CLIENT',
      format: 'HTML',
      correlationId: 'corr-export-6',
    });
    const html = platform.exports.toHtml(document);

    assert.ok(html.includes('Meridian Infrastructure Group Ltd'));
    assert.ok(html.includes(document.contentHash));
    assert.ok(html.startsWith('<!doctype html>'));
  });
});
