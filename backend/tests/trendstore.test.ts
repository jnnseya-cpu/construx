import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { listOpportunities, recordObservations, scoreOpportunity, type ObservationInput } from '../src/domain/trend/store.ts';

/**
 * Trend Intelligence AI — persisted observations and scored opportunities on the Golden
 * Thread. Proves idempotent ingestion and conflict (TI-01), project-scoped isolation
 * (TI-02), and that an opportunity is scored from the topic's own observation history with
 * the band held back when the evidence is thin, a single family, or vetoed.
 */

let platform: Platform;
let seed: SeedResult;
// QS holds BUSINESS_DEVELOPMENT R+C+U — the area Trend Intelligence authorises against.
const ctx = (): EngineContext => platform.context(seed.users.qs!.auth, seed.projectId, { correlationId: 'trend-test' });
// A different real project of the same tenant: the governance pseudo-project. Used to
// prove an opportunity scored on the delivery project is not visible from another scope.
const otherProjectCtx = (): EngineContext =>
  platform.context(seed.users.qs!.auth, `${seed.users.qs!.auth.tenantId}-governance`, { correlationId: 'trend-test' });

const obs = (topicId: string, family: string, windowEnd: string, value: number, hashSuffix = ''): ObservationInput => ({
  sourceId: `${family}_src`,
  sourceFamily: family,
  sourceRecordId: `${topicId}:${family}:${windowEnd}`,
  revision: '1',
  topicId,
  metric: 'count',
  observedAt: '2026-11-10T00:00:00Z',
  windowStart: windowEnd,
  windowEnd,
  value,
  geography: 'CA',
  evidenceHash: `h:${topicId}:${family}:${windowEnd}:${value}${hashSuffix}`,
});

const WINDOWS = ['2026-11-01', '2026-11-08', '2026-11-15', '2026-11-22', '2026-11-29'];

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

describe('idempotent ingestion (spec §15/§16, TI-01)', () => {
  it('counts an exact replay as a duplicate and refuses a changed hash on the same key', () => {
    const o = obs('onboarding', 'first_party', WINDOWS[0]!, 24);
    assert.deepEqual(recordObservations(ctx(), { observations: [o] }), { accepted: 1, duplicate: 0, conflicted: 0 });
    // Exact replay — same (source, record, revision) and same evidence hash.
    assert.deepEqual(recordObservations(ctx(), { observations: [o] }), { accepted: 0, duplicate: 1, conflicted: 0 });
    // Same key, different evidence hash and value — a conflict, never an overwrite.
    const changed = { ...o, value: 99, evidenceHash: `${o.evidenceHash}:changed` };
    assert.deepEqual(recordObservations(ctx(), { observations: [changed] }), { accepted: 0, duplicate: 0, conflicted: 1 });
  });

  it('rejects an empty batch and an oversized one', () => {
    assert.throws(() => recordObservations(ctx(), { observations: [] }), (e) => (e as { code?: string }).code === 'BAD_OBSERVATION');
    const many = Array.from({ length: 501 }, (_, i) => obs('big', 'f', `w${i}`, 1));
    assert.throws(() => recordObservations(ctx(), { observations: many }), (e) => (e as { code?: string }).code === 'BATCH_TOO_LARGE');
  });
});

describe('scoring an opportunity from its observation history (spec §5, §17)', () => {
  before(() => {
    // A corroborated spike: two independent families, five complete windows, a jump in the
    // last — enough history, a cleared count gate, two families.
    const batch: ObservationInput[] = [];
    for (const family of ['first_party', 'search_console']) {
      WINDOWS.forEach((w, i) => batch.push(obs('spike', family, w, i === WINDOWS.length - 1 ? 30 : 3)));
    }
    recordObservations(ctx(), { observations: batch });
  });

  it('turns a strong, corroborated signal into a reviewable brief, and an opt-in into an auto candidate', () => {
    const inputs = { topicId: 'spike', market: 'CA', fit: 95, intent: 85, timing: 90, readiness: 80, sourceQuality: 90, freshness: 90 };
    const briefed = scoreOpportunity(ctx(), inputs);
    assert.ok(briefed.demand > 90, `demand ${briefed.demand} should be high on a clear spike`);
    assert.equal(briefed.sufficientHistory, true);
    assert.equal(briefed.clearedCountGate, true);
    assert.equal(briefed.independentFamilies, 2);
    assert.ok(briefed.score >= 85 && briefed.confidence >= 85, `${briefed.score}/${briefed.confidence}`);
    assert.equal(briefed.band, 'BRIEF'); // no opt-in → reviewable, not automatic

    const auto = scoreOpportunity(ctx(), { ...inputs, autoOptIn: true });
    assert.equal(auto.band, 'AUTO');
  });

  it('caps a single-source-family topic at confidence 69, holding it below a brief', () => {
    // One family, five windows: the spike is real but uncorroborated.
    WINDOWS.forEach((w, i) => recordObservations(ctx(), { observations: [obs('solo', 'first_party', w, i === WINDOWS.length - 1 ? 30 : 3)] }));
    const s = scoreOpportunity(ctx(), { topicId: 'solo', market: 'CA', fit: 100, intent: 100, timing: 100, readiness: 100, sourceQuality: 100, freshness: 100 });
    assert.equal(s.independentFamilies, 1);
    assert.equal(s.confidence, 69);
    assert.equal(s.band, 'WATCH');
  });

  it('holds a thin-history topic at WATCH however high the inputs', () => {
    recordObservations(ctx(), { observations: [obs('thin', 'first_party', WINDOWS[0]!, 3), obs('thin', 'first_party', WINDOWS[1]!, 40)] });
    const s = scoreOpportunity(ctx(), { topicId: 'thin', market: 'CA', fit: 100, intent: 100, timing: 100, readiness: 100, sourceQuality: 100, freshness: 100, autoOptIn: true });
    assert.equal(s.sufficientHistory, false);
    assert.equal(s.band, 'WATCH');
  });

  it('vetoes a zero-readiness topic and refuses an unknown one', () => {
    const s = scoreOpportunity(ctx(), { topicId: 'spike', market: 'CA', fit: 95, intent: 85, timing: 90, readiness: 0, sourceQuality: 90, freshness: 90, autoOptIn: true });
    assert.deepEqual(s.vetoes, ['MISSING_READINESS']);
    assert.equal(s.band, 'WATCH');
    assert.throws(() => scoreOpportunity(ctx(), { topicId: 'does-not-exist', market: 'CA', fit: 50, intent: 50, timing: 50, readiness: 50, sourceQuality: 50, freshness: 50 }), (e) => (e as { code?: string }).code === 'NO_OBSERVATIONS');
  });
});

describe('project-scoped isolation (TI-02)', () => {
  it('lists an opportunity on the project it was scored on, and nowhere else', () => {
    const here = listOpportunities(ctx());
    assert.ok(here.some((o) => o.topicId === 'spike'), 'the scored opportunity is visible on its own project');
    // Another real project of the same tenant sees none of them.
    assert.deepEqual(listOpportunities(otherProjectCtx()), []);
    // And a topic scored here cannot be re-scored from the other project — it has no observations there.
    assert.throws(() => scoreOpportunity(otherProjectCtx(), { topicId: 'spike', market: 'CA', fit: 90, intent: 90, timing: 90, readiness: 90, sourceQuality: 90, freshness: 90 }), (e) => (e as { code?: string }).code === 'NO_OBSERVATIONS');
  });
});
