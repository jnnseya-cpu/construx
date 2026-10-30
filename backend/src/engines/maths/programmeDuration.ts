/**
 * How long the works take, estimated from the measured works.
 *
 * This answers one question a bidder asks the moment the quantities are in —
 * *how long is this job?* — because the construction period drives every
 * time-related cost head and the whole programme, and until now it was only
 * ever typed in by hand.
 *
 * It is a **structural estimate, not market data.** There is no live feed of
 * real contract durations behind it; it is two defensible legs taken against
 * each other, and it carries LOW confidence by construction. It exists to seed
 * the construction period and the work-breakdown generator with a sensible
 * first number, which a planner then confirms and resource-loads — never to
 * quote a programme nobody has built.
 *
 * The two legs:
 *   - **value** — measured works divided by what a small-works crew turns over
 *     in a week (a declared assumption in `config.programme`, not a tariff);
 *   - **sequence floor** — distinct trade phases cannot all run at once, so each
 *     present phase carries at least a minimum in series.
 *
 * The estimate is the larger of the two, nudged by a complexity multiplier. A
 * value leg alone would let a dense, high-value job of few trades read as a
 * fortnight; a sequence floor alone would ignore how much work is in it. The
 * max is the honest reconciliation of the two.
 */

export const DURATION_COMPLEXITY = ['SIMPLE', 'NORMAL', 'COMPLEX'] as const;
export type DurationComplexity = (typeof DURATION_COMPLEXITY)[number];

/**
 * Model shape, not a business value: how much a job's own character stretches or
 * compresses the base estimate. Kept here with the maths it belongs to, the way
 * the cost model keeps its volume bands.
 */
const COMPLEXITY_MULTIPLIER: Record<DurationComplexity, number> = {
  SIMPLE: 0.85,
  NORMAL: 1,
  COMPLEX: 1.25,
};

export type ProgrammeDurationEstimate = {
  weeks: number;
  valueWeeks: number;
  sequenceFloorWeeks: number;
  complexity: DurationComplexity;
  /** Always low: this is an estimate from works, not a resource-loaded programme. */
  confidence: 'LOW';
  basis: string;
  assumptions: string[];
};

export function estimateProgrammeDuration(input: {
  /** Net measured works, in minor units. */
  netMeasuredMinor: number;
  /** How many distinct trade phases the works span. */
  tradeGroups: number;
  complexity?: DurationComplexity;
  /** Declared assumption from `config.programme` — never market data. */
  weeklyThroughputMinor: number;
  /** Declared assumption from `config.programme`. */
  minWeeksPerSequenceStep: number;
}): ProgrammeDurationEstimate {
  const complexity: DurationComplexity = input.complexity ?? 'NORMAL';
  const throughput = Math.max(1, input.weeklyThroughputMinor);
  const groups = Math.max(1, Math.round(input.tradeGroups));
  const value = Math.max(0, input.netMeasuredMinor);
  const stepWeeks = Math.max(0, input.minWeeksPerSequenceStep);

  const valueWeeks = value / throughput;
  const sequenceFloorWeeks = groups * stepWeeks;
  const multiplier = COMPLEXITY_MULTIPLIER[complexity];
  const weeks = Math.max(1, Math.round(Math.max(valueWeeks, sequenceFloorWeeks) * multiplier));

  const pounds = (minor: number) => Math.round(minor / 100).toLocaleString('en-GB');
  const basis =
    `The larger of a value leg (£${pounds(value)} of measured works ÷ £${pounds(throughput)}/week ≈ ${valueWeeks.toFixed(1)} wk) ` +
    `and a sequence floor (${groups} trade phase${groups === 1 ? '' : 's'} × ${stepWeeks} wk = ${sequenceFloorWeeks} wk), ` +
    `× ${multiplier} for ${complexity.toLowerCase()} complexity.`;

  const assumptions = [
    'A structural estimate from the measured works — not a market-researched or resource-loaded programme.',
    'Weekly throughput is a declared small-works assumption; confirm it against your own recent output.',
    'Trades are taken as running broadly in sequence; genuine overlap on site shortens this.',
    'Confidence stays low until a planner builds and resource-loads the real programme.',
  ];

  return {
    weeks,
    valueWeeks: Number(valueWeeks.toFixed(1)),
    sequenceFloorWeeks,
    complexity,
    confidence: 'LOW',
    basis,
    assumptions,
  };
}
