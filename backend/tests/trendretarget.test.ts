import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { config } from '../src/config.ts';
import { Platform } from '../src/platform.ts';
import * as visibility from '../src/site/visibility.ts';

/**
 * Trend Intelligence AI — the invisible marketing retarget, at the integration seam.
 *
 * The demand maths and the topic ordering are proven end to end in trendsignal.test.ts
 * (real golden-thread activity → per-area demand → the preferred topic). This proves the
 * production wiring in `runDailyRelease`: with the control layer on it still publishes, it
 * falls back to the written order when there is no live demand to act on (so a quiet signal
 * never changes anything), and the daily release record carries the audit of what it did.
 */

type MutableOps = { -readonly [K in keyof typeof config.ops]: (typeof config.ops)[K] };
const ops = config.ops as MutableOps;
let wasEnabled: boolean;

const operator = (platform: Platform) => {
  const user = platform.createUser({ tenantId: 'platform', name: 'Ruth', email: `ops-${Math.random().toString(36).slice(2, 8)}@construx.example`, roles: ['PLATFORM_ADMIN'] });
  return { refType: 'User' as const, refId: user.id };
};

before(() => {
  wasEnabled = ops.trendRetargetEnabled;
  ops.trendRetargetEnabled = true;
});
after(() => {
  ops.trendRetargetEnabled = wasEnabled;
});

describe('the marketing retarget with the control layer on', () => {
  it('still publishes and, with no live demand, keeps the written order and records no retarget', async () => {
    const platform = new Platform();
    const actor = operator(platform);
    // A fresh platform has no activity, so no area carries live demand.
    const release = await visibility.runDailyRelease(platform, actor, { trigger: 'OPERATOR', now: new Date('2026-11-20T09:00:00Z') });

    assert.equal(release.alreadyRun, false);
    assert.ok(release.published, 'the release still composes and publishes a post');
    // No live demand → the layer was not able to reorder anything, so no retarget is recorded.
    assert.equal(release.retarget, undefined);
  });

  it('is idempotent for the day, exactly as the baseline release is', async () => {
    const platform = new Platform();
    const actor = operator(platform);
    const now = new Date('2026-11-21T09:00:00Z');
    const first = await visibility.runDailyRelease(platform, actor, { trigger: 'OPERATOR', now });
    const second = await visibility.runDailyRelease(platform, actor, { trigger: 'SCHEDULER', now: new Date('2026-11-21T23:00:00Z') });
    assert.equal(first.alreadyRun, false);
    assert.equal(second.alreadyRun, true);
    assert.equal(second.published?.postId, first.published?.postId);
  });
});
