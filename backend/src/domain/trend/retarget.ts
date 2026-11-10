/**
 * Trend Intelligence AI — the retarget: turn scored opportunities into a priority order for
 * the existing marketing/SEO automation, without changing what it is allowed to do.
 *
 * The spec's whole point is that this layer changes *priorities*, never permissions. So
 * this is pure ordering logic: given the marketing topics the automation already knows how
 * to write and the opportunities scored from real platform activity, it says which topic
 * carries the most live demand right now. The automation still decides, approves and
 * publishes exactly as before — it simply reaches for the topic demand points at first.
 *
 * A topic is only re-prioritised on a live-demand opportunity (WATCH and above). An
 * archived or unmeasured topic keeps its written order, so a weak or absent signal never
 * reorders anything — the automation's own sequence stands until there is real demand to
 * change it.
 */

import type { DecisionBand } from './scoring.ts';

/** The one field of a marketing topic this needs: the capability areas it covers. */
type TopicLike = { features?: readonly string[] };

/**
 * The minimum a scored thing must carry to drive the retarget: its area (`topicId`), a
 * score and a band. Both the persisted `OpportunitySnapshot` and the lightweight
 * platform-activity demand (`signal.marketingDemand`) satisfy this, so one retarget serves
 * the per-tenant persisted path and the invisible platform-marketing path alike.
 */
export type ScoredArea = { topicId: string; score: number; band: DecisionBand };

/** The highest-scoring opportunity whose area this topic covers, or undefined. */
export function opportunityForTopic<T extends TopicLike>(topic: T, opportunities: readonly ScoredArea[]): ScoredArea | undefined {
  const features = new Set(topic.features ?? []);
  let best: ScoredArea | undefined;
  for (const o of opportunities) {
    if (!features.has(o.topicId)) continue;
    if (!best || o.score > best.score) best = o;
  }
  return best;
}

/** The demand weight used to order a topic: its live-demand score, or −1 when there is none. */
export function demandWeight<T extends TopicLike>(topic: T, opportunities: readonly ScoredArea[]): number {
  const opp = opportunityForTopic(topic, opportunities);
  return opp && opp.band !== 'ARCHIVE' ? opp.score : -1;
}

/**
 * Order topics by live demand, highest first, and stably — topics with equal weight (and
 * the unmeasured ones, all at −1) keep their original relative order. A pure reordering:
 * the same topics come back, never more, never fewer.
 */
export function rankByDemand<T extends TopicLike>(topics: readonly T[], opportunities: readonly ScoredArea[]): T[] {
  return topics
    .map((topic, index) => ({ topic, index, weight: demandWeight(topic, opportunities) }))
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .map((x) => x.topic);
}

/**
 * The single topic the automation should prefer from a set of candidates (e.g. the
 * uncovered topics), or undefined when none carry live demand — in which case the caller
 * keeps its existing choice, so the retarget only ever *adds* direction, never removes the
 * baseline behaviour.
 */
export function preferredTopic<T extends TopicLike>(candidates: readonly T[], opportunities: readonly ScoredArea[]): T | undefined {
  let best: { topic: T; weight: number; index: number } | undefined;
  candidates.forEach((topic, index) => {
    const weight = demandWeight(topic, opportunities);
    if (weight < 0) return;
    if (!best || weight > best.weight || (weight === best.weight && index < best.index)) best = { topic, weight, index };
  });
  return best?.topic;
}
