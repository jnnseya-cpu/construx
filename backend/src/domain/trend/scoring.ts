/**
 * Trend Intelligence AI — the detection and scoring engine as pure, tested logic.
 *
 * Spec §5 and §17: the per-source movement maths (`lift`, robust anomaly `z`), the
 * count-feed gate, the 0–100 **opportunity score** (25% demand, 25% platform fit, 20%
 * commercial intent, 15% timing, 15% readiness) and the independently-computed 0–100
 * **confidence** (35% source quality, 25% corroboration, 20% coverage, 20% freshness),
 * the hard vetoes, and the decision bands that turn the two scores into an action class.
 *
 * This module is maths only — it reads nothing, persists nothing, and calls no provider
 * or model. Scores are computed at full precision and rounded only for display (spec
 * §17: "Score using full precision and round only for display"). It is the authority the
 * briefs, actions and experiments compute against, the same way `billing/addon.ts` is for
 * the add-on contract.
 */

/** The opportunity-score weights (spec §5.4). They sum to 1. */
export const OPPORTUNITY_WEIGHTS = { demand: 0.25, fit: 0.25, intent: 0.2, timing: 0.15, readiness: 0.15 } as const;
/** The confidence weights (spec §5.5). They sum to 1. */
export const CONFIDENCE_WEIGHTS = { sourceQuality: 0.35, corroboration: 0.25, coverage: 0.2, freshness: 0.2 } as const;

/** A single source family can never be more than this confident on its own (spec §5.5). */
export const SINGLE_FAMILY_CONFIDENCE_CAP = 69;

/** The count-feed gate: a monitored topic opens only at this volume and anomaly (spec §5.3). */
export const COUNT_GATE = { minCount: 20, minZ: 2 } as const;

/** Fewer than this many comparable periods means the history is too thin to act on (spec §5.3). */
export const MIN_COMPARABLE_PERIODS = 4;

function assert0to100(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${name} must be a number in [0, 100], got ${value}`);
  }
}

/** The median of a non-empty list. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('median of an empty list is undefined');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** The median absolute deviation: median(|x − median(x)|) (spec §5.3). */
export function mad(values: readonly number[]): number {
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

/** The log lift of a current count against a baseline: ln((c+1)/(b+1)) (spec §5.3). */
export function logLift(current: number, baseline: number): number {
  if (current < 0 || baseline < 0) throw new Error('counts are non-negative');
  return Math.log((current + 1) / (baseline + 1));
}

/**
 * The robust anomaly score of a current count against its history (spec §5.3):
 * `z = (log1p(c) − median(log1p(x))) / max(1.4826 × MAD(log1p(x)), 0.2)`.
 * The 1.4826 makes the MAD a consistent estimator of the standard deviation for normal
 * data; the 0.2 floor stops a flat history dividing by zero and reporting every blip as
 * infinitely anomalous.
 */
export function anomalyZ(current: number, history: readonly number[]): number {
  if (history.length === 0) throw new Error('an anomaly score needs a history to compare against');
  const logs = history.map((x) => Math.log1p(x));
  const denom = Math.max(1.4826 * mad(logs), 0.2);
  return (Math.log1p(current) - median(logs)) / denom;
}

/** Whether a count feed clears the volume-and-anomaly gate that opens a monitored topic. */
export function clearsCountGate(current: number, z: number, gate: { minCount: number; minZ: number } = COUNT_GATE): boolean {
  return current >= gate.minCount && z >= gate.minZ;
}

/** Whether there are too few comparable periods to score (draft-only below the floor). */
export function insufficientHistory(history: readonly number[]): boolean {
  return history.length < MIN_COMPARABLE_PERIODS;
}

/** The count-feed demand score from the anomaly z (spec §17): clamp(50 + 10·z, 0, 100). */
export function demandFromZ(z: number): number {
  return Math.min(100, Math.max(0, 50 + 10 * z));
}

/**
 * The corroboration score from the number of *independent* source families on the same
 * topic, market and time (spec §17): 0 for one, 80 for two, 100 for three or more. A
 * single family cannot corroborate itself, which is why one family scores zero here and
 * caps overall confidence separately.
 */
export function corroborationScore(independentFamilies: number): number {
  if (!Number.isInteger(independentFamilies) || independentFamilies < 0) {
    throw new Error(`independentFamilies must be a non-negative integer, got ${independentFamilies}`);
  }
  if (independentFamilies >= 3) return 100;
  if (independentFamilies === 2) return 80;
  return 0;
}

export type OpportunityInputs = {
  /** Demand, derived from calibrated source scores (0–100). */
  demand: number;
  /** Platform fit — product/category, geography, persona match (0–100). */
  fit: number;
  /** Commercial intent from explicit behaviour and taxonomy (0–100). */
  intent: number;
  /** Timing — the remaining actionable window (0–100). */
  timing: number;
  /** Readiness — stock, partner coverage, capacity, approved assets (0–100). Zero vetoes activation. */
  readiness: number;
};

export type ConfidenceInputs = {
  /** Mean of the configured 0–100 quality scores of the contributing families. */
  sourceQuality: number;
  /** From `corroborationScore` (0/80/100). */
  corroboration: number;
  /** Mean valid observed/expected window ratio × 100. */
  coverage: number;
  /** Mean per-family freshness: 100 at window close tapering to 0 at the stale-after limit. */
  freshness: number;
};

/** The hard vetoes that block live activation whatever the score says (spec §5.4). */
export type VetoReason =
  | 'OUT_OF_MARKET'
  | 'UNSUPPORTED_CLAIM'
  | 'RESTRICTED_TOPIC'
  | 'UNAVAILABLE_INVENTORY'
  | 'ILLEGAL_TARGETING'
  | 'MISSING_READINESS';

/** The action class a scored opportunity falls into (spec §5 decision table). */
export type DecisionBand = 'ARCHIVE' | 'WATCH' | 'BRIEF' | 'AUTO';

/** The weighted 0–100 opportunity score, at full precision (spec §5.4). */
export function opportunityScore(i: OpportunityInputs): number {
  for (const [k, v] of Object.entries(i)) assert0to100(v, k);
  const w = OPPORTUNITY_WEIGHTS;
  return i.demand * w.demand + i.fit * w.fit + i.intent * w.intent + i.timing * w.timing + i.readiness * w.readiness;
}

/**
 * The weighted 0–100 confidence, at full precision (spec §5.5). Model certainty is
 * excluded by construction — it is not an input. A single source family is capped at 69.
 */
export function confidenceScore(i: ConfidenceInputs, opts: { singleSourceFamily: boolean }): number {
  for (const [k, v] of Object.entries(i)) assert0to100(v, k);
  const w = CONFIDENCE_WEIGHTS;
  const raw = i.sourceQuality * w.sourceQuality + i.corroboration * w.corroboration + i.coverage * w.coverage + i.freshness * w.freshness;
  return opts.singleSourceFamily ? Math.min(raw, SINGLE_FAMILY_CONFIDENCE_CAP) : raw;
}

/** The hard vetoes in force: the supplied ones, plus MISSING_READINESS when readiness is zero. */
export function vetoesOf(inputs: OpportunityInputs, supplied: readonly VetoReason[] = []): VetoReason[] {
  const out = [...new Set(supplied)];
  if (inputs.readiness <= 0 && !out.includes('MISSING_READINESS')) out.push('MISSING_READINESS');
  return out;
}

/**
 * The decision band (spec §5 table). A veto, or either score below its live-change gate,
 * holds the topic at WATCH or ARCHIVE — a veto can never reach BRIEF or AUTO. AUTO needs
 * both scores ≥85 **and** an explicit tenant opt-in; everything above the archive cutoff
 * that is not a brief or auto case is WATCH (internal draft, no live change).
 */
export function decisionBand(
  score: number,
  confidence: number,
  opts: { vetoed?: boolean; autoOptIn?: boolean } = {},
): DecisionBand {
  if (score < 60 || confidence < 55) return 'ARCHIVE';
  if (opts.vetoed) return 'WATCH';
  if (score >= 85 && confidence >= 85 && opts.autoOptIn === true) return 'AUTO';
  if (score >= 75 && confidence >= 75) return 'BRIEF';
  return 'WATCH';
}

export type OpportunityAssessment = {
  score: number;
  confidence: number;
  vetoes: VetoReason[];
  band: DecisionBand;
};

/**
 * Score an opportunity end to end: the two independent scores, the vetoes in force and
 * the resulting band. The composed call the strategist uses; the parts are exported so a
 * caller can show the breakdown (spec §5.4: "Store numeric inputs and reasons").
 */
export function assessOpportunity(input: {
  opportunity: OpportunityInputs;
  confidence: ConfidenceInputs;
  singleSourceFamily: boolean;
  vetoes?: readonly VetoReason[];
  autoOptIn?: boolean;
}): OpportunityAssessment {
  const score = opportunityScore(input.opportunity);
  const confidence = confidenceScore(input.confidence, { singleSourceFamily: input.singleSourceFamily });
  const vetoes = vetoesOf(input.opportunity, input.vetoes ?? []);
  const band = decisionBand(score, confidence, { vetoed: vetoes.length > 0, ...(input.autoOptIn !== undefined ? { autoOptIn: input.autoOptIn } : {}) });
  return { score, confidence, vetoes, band };
}
