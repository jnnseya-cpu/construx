/**
 * Trend Intelligence AI — persisted signals and scored opportunities, on the Golden
 * Thread of the existing platform (not a separate store).
 *
 * `scoring.ts` is the pure engine; this gives it data and a home. Observations are
 * ingested idempotently — the spec's §15 uniqueness `(installation, source, source
 * record, revision)` is the ledger refId, so an exact replay is a counted duplicate and a
 * changed hash on the same key is a conflict, never a silent overwrite (TI-01). Everything
 * is tenant- and project-scoped through the one `write`/`ledger` path, so cross-scope
 * reads return nothing by construction (TI-02).
 *
 * An opportunity is scored from the topic's own observation history — the demand component
 * is the count-feed anomaly the engine computes — combined with the platform/strategist
 * inputs (fit, intent, timing, readiness, source quality, freshness). The snapshot stores
 * every numeric input and the reasons (spec §5.4), and the band is held at WATCH whenever
 * the history is too thin or the count gate is not cleared, so nothing drives a live change
 * on evidence the engine itself calls insufficient.
 */

import { DomainError } from '../../core/errors.ts';
import { authorise, write, type EngineContext } from '../../engines/context.ts';
import {
  anomalyZ,
  assessOpportunity,
  clearsCountGate,
  corroborationScore,
  demandFromZ,
  insufficientHistory,
  type DecisionBand,
  type OpportunityAssessment,
  type VetoReason,
} from './scoring.ts';

/** The scoring version stamped on every snapshot, so a re-score under new maths is distinguishable. */
export const TREND_SCORING_VERSION = 'v1';

export type ObservationInput = {
  sourceId: string;
  sourceFamily: string;
  sourceRecordId: string;
  /** The source's own version of this record; part of the idempotency key. */
  revision: string;
  topicId: string;
  observedAt: string;
  windowStart: string;
  windowEnd: string;
  geography?: string;
  locale?: string;
  segment?: string;
  metric: string;
  value: number;
  unit?: string;
  /** Valid observed/expected window ratio in [0,1]; defaults to 1 when the source cannot say. */
  coverage?: number;
  /** The hash of the evidence this observation stands on; a changed hash on a known key is a conflict. */
  evidenceHash: string;
  termsVersion?: string;
};

type ObservationState = ObservationInput & { projectId: string; ingestedAt: string; recordedBy: string };

export type ObservationBatchResult = { accepted: number; duplicate: number; conflicted: number };

const obsRef = (ctx: EngineContext, o: Pick<ObservationInput, 'sourceId' | 'sourceRecordId' | 'revision'>): string =>
  `${ctx.projectId}:${o.sourceId}:${o.sourceRecordId}:${o.revision}`;

function assertFinite(value: unknown, name: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new DomainError('BAD_OBSERVATION', `${name} must be a finite number`);
}

/**
 * Ingest a batch of observations idempotently (spec §16 `POST /observations:batch`).
 * An exact replay of a known `(source, record, revision)` with the same evidence hash is a
 * counted duplicate; the same key with a different hash is refused `EVIDENCE_CONFLICT`
 * rather than overwriting what the first one stood on. Returns the accepted / duplicate /
 * conflicted counts.
 */
export function recordObservations(ctx: EngineContext, input: { observations: ObservationInput[] }): ObservationBatchResult {
  authorise(ctx, 'BUSINESS_DEVELOPMENT', 'C');
  if (!Array.isArray(input.observations) || input.observations.length === 0) {
    throw new DomainError('BAD_OBSERVATION', 'A batch needs at least one observation');
  }
  if (input.observations.length > 500) throw new DomainError('BATCH_TOO_LARGE', 'At most 500 observations per batch');

  const result: ObservationBatchResult = { accepted: 0, duplicate: 0, conflicted: 0 };
  for (const o of input.observations) {
    for (const key of ['sourceId', 'sourceFamily', 'sourceRecordId', 'revision', 'topicId', 'metric', 'evidenceHash'] as const) {
      if (typeof o[key] !== 'string' || o[key].length === 0) throw new DomainError('BAD_OBSERVATION', `${key} is required`);
    }
    assertFinite(o.value, 'value');
    if (o.coverage !== undefined && (o.coverage < 0 || o.coverage > 1)) throw new DomainError('BAD_OBSERVATION', 'coverage is a ratio in [0,1]');

    const ref = obsRef(ctx, o);
    const existing = ctx.ledger.get({ refType: 'TrendObservation', refId: ref });
    if (existing && existing.tenantId === ctx.tenantId) {
      const prior = existing.state as ObservationState;
      if (prior.evidenceHash === o.evidenceHash) {
        result.duplicate += 1; // exact replay — counted, not re-written
        continue;
      }
      // Same key, different evidence: a conflict, never a silent overwrite.
      result.conflicted += 1;
      continue;
    }
    const state: ObservationState = { ...o, projectId: ctx.projectId, ingestedAt: new Date().toISOString(), recordedBy: ctx.auth.actorId };
    write(ctx, { eventType: 'TREND_OBSERVATION_RECORDED', entity: { refType: 'TrendObservation', refId: ref }, nextState: state });
    result.accepted += 1;
  }
  return result;
}

/** The observations for a topic on this project, newest window last. */
function observationsOfTopic(ctx: EngineContext, topicId: string, market?: string): ObservationState[] {
  return ctx.ledger
    .list(ctx.projectId, 'TrendObservation')
    .map((r) => r.state as ObservationState)
    .filter((o) => o.topicId === topicId && (market === undefined || o.geography === market))
    .sort((a, b) => a.windowEnd.localeCompare(b.windowEnd));
}

export type OpportunitySnapshot = {
  projectId: string;
  topicId: string;
  market: string;
  score: number;
  confidence: number;
  band: DecisionBand;
  vetoes: VetoReason[];
  /** The demand derived from the topic's own observation history. */
  demand: number;
  currentCount: number;
  comparablePeriods: number;
  sufficientHistory: boolean;
  clearedCountGate: boolean;
  independentFamilies: number;
  inputs: { fit: number; intent: number; timing: number; readiness: number; sourceQuality: number; freshness: number; coverage: number };
  scoringVersion: string;
  scoredAt: string;
  scoredBy: string;
};

/**
 * Score (or re-score) an opportunity for a topic from its observations and the
 * platform/strategist inputs. Demand, corroboration, coverage and the single-family flag
 * come from the data; fit, intent, timing, readiness, source quality and freshness come
 * from the caller (the platform profile and the strategist, persisted in a later slice).
 * The band is held at WATCH when the history is too thin or the count gate is not cleared.
 */
export function scoreOpportunity(
  ctx: EngineContext,
  input: {
    topicId: string;
    market: string;
    fit: number;
    intent: number;
    timing: number;
    readiness: number;
    sourceQuality: number;
    freshness: number;
    vetoes?: VetoReason[];
    autoOptIn?: boolean;
  },
): OpportunitySnapshot {
  authorise(ctx, 'BUSINESS_DEVELOPMENT', 'U');
  for (const key of ['fit', 'intent', 'timing', 'readiness', 'sourceQuality', 'freshness'] as const) assertFinite(input[key], key);

  const obs = observationsOfTopic(ctx, input.topicId, input.market);
  if (obs.length === 0) throw new DomainError('NO_OBSERVATIONS', `No observations for topic ${input.topicId} in ${input.market}`);

  // Sum the metric value per window, ordered; the last window is current, the rest history.
  const byWindow = new Map<string, number>();
  for (const o of obs) byWindow.set(o.windowEnd, (byWindow.get(o.windowEnd) ?? 0) + o.value);
  const windows = [...byWindow.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const currentCount = windows[windows.length - 1]![1];
  const history = windows.slice(0, -1).map(([, v]) => v);

  const sufficientHistory = !insufficientHistory(history);
  const z = history.length > 0 ? anomalyZ(currentCount, history) : 0;
  const clearedCountGate = history.length > 0 && clearsCountGate(currentCount, z);
  const demand = history.length > 0 ? demandFromZ(z) : 0;

  const independentFamilies = new Set(obs.map((o) => o.sourceFamily)).size;
  const coverageVals = obs.map((o) => (o.coverage ?? 1) * 100);
  const coverage = coverageVals.reduce((a, b) => a + b, 0) / coverageVals.length;

  const assessment: OpportunityAssessment = assessOpportunity({
    opportunity: { demand, fit: input.fit, intent: input.intent, timing: input.timing, readiness: input.readiness },
    confidence: { sourceQuality: input.sourceQuality, corroboration: corroborationScore(independentFamilies), coverage, freshness: input.freshness },
    singleSourceFamily: independentFamilies <= 1,
    ...(input.vetoes ? { vetoes: input.vetoes } : {}),
    ...(input.autoOptIn !== undefined ? { autoOptIn: input.autoOptIn } : {}),
  });

  // Thin history or an un-cleared count gate can never drive a live change: hold at WATCH
  // at most, however the inputs score (spec §5.3).
  const band: DecisionBand =
    (!sufficientHistory || !clearedCountGate) && (assessment.band === 'BRIEF' || assessment.band === 'AUTO') ? 'WATCH' : assessment.band;

  const snapshot: OpportunitySnapshot = {
    projectId: ctx.projectId,
    topicId: input.topicId,
    market: input.market,
    score: assessment.score,
    confidence: assessment.confidence,
    band,
    vetoes: assessment.vetoes,
    demand,
    currentCount,
    comparablePeriods: history.length,
    sufficientHistory,
    clearedCountGate,
    independentFamilies,
    inputs: { fit: input.fit, intent: input.intent, timing: input.timing, readiness: input.readiness, sourceQuality: input.sourceQuality, freshness: input.freshness, coverage },
    scoringVersion: TREND_SCORING_VERSION,
    scoredAt: new Date().toISOString(),
    scoredBy: ctx.auth.actorId,
  };
  const ref = `${ctx.projectId}:${input.topicId}:${input.market}`;
  const existing = ctx.ledger.get({ refType: 'TrendOpportunity', refId: ref });
  write(ctx, {
    eventType: existing ? 'TREND_OPPORTUNITY_RESCORED' : 'TREND_OPPORTUNITY_SCORED',
    entity: { refType: 'TrendOpportunity', refId: ref },
    nextState: snapshot,
  });
  return snapshot;
}

/** The scored opportunities on this project, highest score first (spec §16 `GET /opportunities`). */
export function listOpportunities(ctx: EngineContext): OpportunitySnapshot[] {
  authorise(ctx, 'BUSINESS_DEVELOPMENT', 'R');
  return ctx.ledger
    .list(ctx.projectId, 'TrendOpportunity')
    .map((r) => r.state as OpportunitySnapshot)
    .sort((a, b) => b.score - a.score);
}

/** A topic's observation tally, for the console: how many, over how many windows, families and coverage. */
export function topicSignal(ctx: EngineContext, topicId: string, market?: string): { observations: number; windows: number; families: number; latestWindowEnd?: string } {
  authorise(ctx, 'BUSINESS_DEVELOPMENT', 'R');
  const obs = observationsOfTopic(ctx, topicId, market);
  const windows = new Set(obs.map((o) => o.windowEnd));
  return {
    observations: obs.length,
    windows: windows.size,
    families: new Set(obs.map((o) => o.sourceFamily)).size,
    ...(obs.length > 0 ? { latestWindowEnd: obs[obs.length - 1]!.windowEnd } : {}),
  };
}
