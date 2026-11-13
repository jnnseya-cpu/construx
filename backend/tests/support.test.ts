import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { fileSupportReport } from '../src/ops/support.ts';
import { DomainError } from '../src/core/errors.ts';

/**
 * The report-when-stuck / report-the-error channel.
 *
 * The honest version of "the AI gets help when it struggles": a person files a
 * report, it goes on the record, it reaches the tenancy's owners in-platform,
 * and it is forwarded to the ops webhook where one is configured. These pin
 * that it records, that it reaches someone even with no webhook, that any seat
 * can file one, and that it refuses an empty report.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

function governance(auth: SeedResult['users']['owner']['auth']) {
  return platform.context(auth, `${seed.tenantId}-governance`, { source: 'WEB' });
}

describe('Support report channel', () => {
  it('records the report, returns a reference, and reaches the owners in-platform', async () => {
    // Filed by the QS — a non-owner seat — to prove reporting a problem is not a
    // privilege reserved to administrators.
    const ctx = governance(seed.users.qs!.auth);
    const result = await fileSupportReport(platform, ctx, {
      kind: 'STUCK',
      message: 'The copilot could not tell me how to read the invitation into a matrix.',
      screen: 'copilot',
      question: 'How do I read the invitation into a matrix?',
    });

    assert.match(result.reference, /^CXR-[0-9A-Z]{8}$/);
    assert.ok(result.deliveredTo >= 1, 'at least the owner is notified in-platform');
    // No OPS_ALERT_WEBHOOK_URL in a test deployment, so it is honestly not forwarded.
    assert.equal(result.forwardedToOps, false);

    // On the record, on the tenancy's own governance chain.
    const filed = ctx.ledger.get({ refType: 'SupportReport', refId: result.reportId });
    assert.ok(filed, 'the report is on the ledger');
    assert.equal(filed!.state.kind, 'STUCK');
    assert.equal(filed!.state.reference, result.reference);
    assert.equal(filed!.state.screen, 'copilot');
    assert.equal(filed!.state.reportedBy, seed.users.qs!.auth.actorId);
  });

  it('carries the correlation id of a failed request on an ERROR report', async () => {
    const ctx = governance(seed.users.owner!.auth);
    const result = await fileSupportReport(platform, ctx, {
      kind: 'ERROR',
      message: 'Issuing the pack returned a 500.',
      screen: 'pipeline',
      correlationId: 'abc-123-correlation',
    });
    const filed = ctx.ledger.get({ refType: 'SupportReport', refId: result.reportId });
    assert.equal(filed!.state.correlationId, 'abc-123-correlation');
    assert.equal(filed!.state.kind, 'ERROR');
  });

  it('refuses an empty report rather than recording nothing', async () => {
    const ctx = governance(seed.users.owner!.auth);
    await assert.rejects(
      () => fileSupportReport(platform, ctx, { kind: 'FEEDBACK', message: ' ' }),
      (error: unknown) => error instanceof DomainError && error.status === 422,
    );
  });

  it('refuses an over-long report', async () => {
    const ctx = governance(seed.users.owner!.auth);
    await assert.rejects(
      () => fileSupportReport(platform, ctx, { kind: 'FEEDBACK', message: 'x'.repeat(4001) }),
      (error: unknown) => error instanceof DomainError && error.status === 422,
    );
  });

  it('normalises an unknown kind to FEEDBACK rather than failing', async () => {
    const ctx = governance(seed.users.owner!.auth);
    const result = await fileSupportReport(platform, ctx, {
      kind: 'WHATEVER' as never,
      message: 'Just some feedback about the colours.',
    });
    const filed = ctx.ledger.get({ refType: 'SupportReport', refId: result.reportId });
    assert.equal(filed!.state.kind, 'FEEDBACK');
  });
});
