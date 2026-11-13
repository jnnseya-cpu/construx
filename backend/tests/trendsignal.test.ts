import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GoldenThreadEvent } from '../src/goldenthread/types.ts';
import { activityObservations, marketingDemand, weekWindow } from '../src/domain/trend/signal.ts';
import { demandWeight, opportunityForTopic, preferredTopic, rankByDemand } from '../src/domain/trend/retarget.ts';
import type { OpportunitySnapshot } from '../src/domain/trend/store.ts';

/**
 * Trend Intelligence AI — the first-party signal source (platform activity → observations)
 * and the retarget (opportunities → marketing priority), both pure. Proves the signal reads
 * real event counts into closed weekly windows, and that the retarget only ever reorders by
 * live demand and never drops a topic.
 */

const ev = (eventType: string, timestamp: string): GoldenThreadEvent => ({ eventType, timestamp } as GoldenThreadEvent);
const opp = (topicId: string, score: number, band: OpportunitySnapshot['band']): OpportunitySnapshot =>
  ({ topicId, score, band, market: 'ZZ' } as OpportunitySnapshot);

describe('the first-party signal (platform activity → observations)', () => {
  it('buckets a timestamp into a fixed 7-day window deterministically', () => {
    const a = weekWindow('2026-11-10T12:00:00Z');
    const b = weekWindow('2026-11-11T23:59:00Z');
    assert.equal(a.start, b.start); // same week
    assert.equal(a.end > a.start, true);
    assert.equal(weekWindow(a.endMs).start, a.end); // the next window starts where this one ends
  });

  it('counts real events per area and week, emitting only closed windows', () => {
    // RADAR_RUN_COMPLETED is BUSINESS_DEVELOPMENT → area "business"; ACU_CONSUMED is
    // AI_BILLING → "billing". Five weeks of business activity with a spike in the last.
    const weeks = ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02'];
    const events: GoldenThreadEvent[] = [];
    weeks.forEach((d, i) => {
      const n = i === weeks.length - 1 ? 20 : 2;
      for (let k = 0; k < n; k++) events.push(ev('RADAR_RUN_COMPLETED', `${d}T09:00:00Z`));
    });
    events.push(ev('ACU_CONSUMED', '2026-10-12T09:00:00Z'));
    // An event in the still-open current week must not be emitted. The window containing
    // `now` is always open (its end is strictly after now), so an event at `now` is excluded.
    events.push(ev('RADAR_RUN_COMPLETED', '2026-11-20T00:00:00Z'));

    const obs = activityObservations(events, '2026-11-20T00:00:00Z');
    const business = obs.filter((o) => o.topicId === 'business').sort((a, b) => a.windowEnd.localeCompare(b.windowEnd));
    assert.equal(business.length, 5, 'five closed business windows, the open one excluded');
    assert.deepEqual(business.map((o) => o.value), [2, 2, 2, 2, 20]);
    assert.equal(business.every((o) => o.sourceFamily === 'first_party' && o.sourceId === 'platform_activity'), true);
    assert.ok(obs.some((o) => o.topicId === 'billing' && o.value === 1));
  });

  it('ignores events whose type maps to no area, and is idempotent on a closed window', () => {
    const events = [ev('NOT_A_REAL_EVENT', '2026-10-05T09:00:00Z'), ev('RADAR_RUN_COMPLETED', '2026-10-05T09:00:00Z')];
    const a = activityObservations(events, '2026-11-20T00:00:00Z');
    const b = activityObservations(events, '2026-11-20T00:00:00Z');
    assert.equal(a.length, 1); // the unknown event ignored, not bucketed
    assert.equal(a[0]!.evidenceHash, b[0]!.evidenceHash); // same closed window → same hash
  });
});

describe('the retarget (opportunities → marketing priority)', () => {
  const topics = [
    { id: 'commercial', features: ['commercial', 'payments'] },
    { id: 'programme', features: ['programme', 'autopilot'] },
    { id: 'governance', features: ['audit', 'autopilot'] },
  ];

  it('matches a topic to the strongest opportunity in an area it covers', () => {
    const opps = [opp('commercial', 90, 'BRIEF'), opp('audit', 70, 'WATCH'), opp('programme', 40, 'ARCHIVE')];
    assert.equal(opportunityForTopic(topics[0]!, opps)!.topicId, 'commercial');
    assert.equal(demandWeight(topics[0]!, opps), 90);
    assert.equal(demandWeight(topics[2]!, opps), 70); // governance covers "audit"
    assert.equal(demandWeight(topics[1]!, opps), -1); // programme's only opp is ARCHIVE → no live demand
  });

  it('reorders by live demand, stably, and never drops or adds a topic', () => {
    const opps = [opp('audit', 85, 'BRIEF'), opp('commercial', 60, 'WATCH')];
    const ranked = rankByDemand(topics, opps);
    assert.deepEqual(ranked.map((t) => t.id), ['governance', 'commercial', 'programme']);
    assert.equal(ranked.length, topics.length);
  });

  it('prefers the highest live-demand candidate, or no change when none carry demand', () => {
    assert.equal(preferredTopic(topics, [opp('programme', 95, 'AUTO')])!.id, 'programme');
    assert.equal(preferredTopic(topics, [opp('commercial', 50, 'ARCHIVE')]), undefined); // archived → baseline stands
    assert.equal(preferredTopic(topics, []), undefined);
  });
});

describe('end to end: real activity drives the marketing retarget', () => {
  it('turns a spike in one area into a live-demand retarget, and a flat area into none', () => {
    const weeks = ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02'];
    const events: GoldenThreadEvent[] = [];
    // "business" (RADAR_RUN_COMPLETED) spikes in the last week; "billing" (ACU_CONSUMED) is flat.
    weeks.forEach((d, i) => {
      for (let k = 0; k < (i === weeks.length - 1 ? 30 : 2); k++) events.push(ev('RADAR_RUN_COMPLETED', `${d}T09:00:00Z`));
      for (let k = 0; k < 2; k++) events.push(ev('ACU_CONSUMED', `${d}T09:00:00Z`));
    });

    const demand = marketingDemand(events, '2026-11-20T00:00:00Z');
    const business = demand.find((d) => d.topicId === 'business')!;
    const billing = demand.find((d) => d.topicId === 'billing')!;
    assert.equal(business.band, 'BRIEF'); // a cleared count gate with enough history → live demand
    assert.ok(business.score > 90);
    assert.equal(billing.band, 'ARCHIVE'); // flat: no anomaly → not live
    assert.ok(billing.score < business.score);

    // The retarget then prefers the topic whose area is busiest.
    const topics = [
      { id: 'billing', features: ['billing'] },
      { id: 'business', features: ['business'] },
    ];
    assert.equal(preferredTopic(topics, demand)!.id, 'business');
  });
});
