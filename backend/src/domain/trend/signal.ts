/**
 * Trend Intelligence AI — the first-party signal source: the platform's own activity.
 *
 * The chosen signal (operator decision) is CONSTRUX's own first-party activity — what the
 * platform's users are actually doing, read from the Golden Thread — turned into demand
 * observations per capability area. No new feed, no credential, no invented number: the
 * count for a window is the count of real events in it.
 *
 * Pure and provider-free: it takes a list of events and a clock and returns observations.
 * The background sweep reads the events from the ledger and records what this produces.
 *
 * Only **closed** windows are emitted. A window still accumulating would give a different
 * count on the next pass and, because the count is part of the evidence hash, would read as
 * a conflict rather than an update — so the current partial week is left out until it ends,
 * which also makes every re-run of a past window an exact, idempotent replay.
 */

import { lookupEventType } from '../../goldenthread/eventTypes.ts';
import type { GoldenThreadEvent } from '../../goldenthread/types.ts';
import { anomalyZ, clearsCountGate, demandFromZ, insufficientHistory, type DecisionBand } from './scoring.ts';
import type { ObservationInput } from './store.ts';

/**
 * Which capability area a Golden-Thread EventGroup signals demand for. The area ids line up
 * with the `features` the marketing topics in `site/visibility.ts` carry, so an opportunity
 * scored here can be matched to the posts the existing automation would write.
 */
export const GROUP_TO_AREA: Readonly<Record<string, string>> = {
  COMMERCIAL: 'commercial',
  PROCUREMENT: 'commercial',
  CONTRACTS_CLAIMS: 'contracts',
  PROGRAMME_CONTROL: 'programme',
  PROJECT_CONTROL: 'programme',
  RISK_SAFETY: 'risk',
  DESIGN: 'design',
  BIM_TWIN: 'design',
  DELIVERY: 'field',
  EVIDENCE: 'audit',
  GOVERNANCE: 'audit',
  COMMISSIONING: 'handover',
  HANDOVER_OM: 'handover',
  BUSINESS_DEVELOPMENT: 'business',
  AI_BILLING: 'billing',
};

const DAY_MS = 86_400_000;

/** The fixed 7-day window a timestamp falls in, as inclusive-start / exclusive-end ISO dates. */
export function weekWindow(ts: string | number): { start: string; end: string; endMs: number } {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  const weekIdx = Math.floor(Math.floor(t / DAY_MS) / 7);
  const startMs = weekIdx * 7 * DAY_MS;
  const endMs = startMs + 7 * DAY_MS;
  return { start: new Date(startMs).toISOString().slice(0, 10), end: new Date(endMs).toISOString().slice(0, 10), endMs };
}

/**
 * Turn a stream of Golden-Thread events into per-area, per-week demand observations. Only
 * windows that have fully closed by `now` are emitted. Events whose type maps to no area
 * (or is unknown) are ignored rather than bucketed into a catch-all.
 */
export function activityObservations(events: readonly GoldenThreadEvent[], now: string | number = Date.now()): ObservationInput[] {
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  // (area, windowEnd) -> count
  const counts = new Map<string, { area: string; start: string; end: string; count: number }>();
  for (const ev of events) {
    const def = lookupEventType(ev.eventType);
    const area = def ? GROUP_TO_AREA[def.group] : undefined;
    if (!area) continue;
    const w = weekWindow(ev.timestamp);
    if (w.endMs > nowMs) continue; // the window has not closed yet
    const key = `${area}:${w.end}`;
    const slot = counts.get(key) ?? { area, start: w.start, end: w.end, count: 0 };
    slot.count += 1;
    counts.set(key, slot);
  }

  return [...counts.values()]
    .sort((a, b) => (a.area === b.area ? a.end.localeCompare(b.end) : a.area.localeCompare(b.area)))
    .map((s) => ({
      sourceId: 'platform_activity',
      sourceFamily: 'first_party',
      sourceRecordId: `${s.area}:${s.end}`,
      revision: '1',
      topicId: s.area,
      metric: 'activity_events',
      observedAt: `${s.end}T00:00:00.000Z`,
      windowStart: s.start,
      windowEnd: s.end,
      value: s.count,
      // The count is the evidence: a closed window re-read gives the same hash (idempotent
      // replay); a changed count on a closed window is a conflict, which is the honest
      // reading of tampered history rather than a silent overwrite.
      evidenceHash: `activity:${s.area}:${s.end}:${s.count}`,
    }));
}

/**
 * The live demand per capability area from the platform's own activity, as `ScoredArea`
 * values the retarget consumes. This is the invisible platform-marketing path: it needs no
 * platform profile and writes nothing — demand is the count-feed anomaly over closed
 * windows, and an area only counts as live demand (a non-ARCHIVE band) when it has enough
 * history and clears the count gate, so a quiet or new area never reorders the marketing
 * automation's own sequence. The full opportunity score (fit, intent, readiness, …) is the
 * separate per-tenant persisted path in `store.ts`.
 */
export function marketingDemand(events: readonly GoldenThreadEvent[], now: string | number = Date.now()): Array<{ topicId: string; score: number; band: DecisionBand }> {
  // activityObservations already returns one value per area per window, ordered by window.
  const byArea = new Map<string, number[]>();
  for (const o of activityObservations(events, now)) {
    const list = byArea.get(o.topicId);
    if (list) list.push(o.value);
    else byArea.set(o.topicId, [o.value]);
  }
  const out: Array<{ topicId: string; score: number; band: DecisionBand }> = [];
  for (const [area, values] of byArea) {
    const current = values[values.length - 1]!;
    const history = values.slice(0, -1);
    const z = history.length > 0 ? anomalyZ(current, history) : 0;
    const demand = history.length > 0 ? demandFromZ(z) : 0;
    const live = history.length > 0 && !insufficientHistory(history) && clearsCountGate(current, z);
    out.push({ topicId: area, score: demand, band: live ? 'BRIEF' : 'ARCHIVE' });
  }
  return out;
}
