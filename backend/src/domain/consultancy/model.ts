/**
 * The deterministic appraisal model behind a consultancy business case.
 *
 * The developer spec (§5) is explicit that economics are computed by
 * **deterministic services**, not by a model writing numbers: "Use deterministic
 * services for quantity aggregation, CPM schedule logic, estimate arithmetic,
 * cash flow, appraisal metrics and scenario tests." This module is the service
 * for the **client-service / business-case** context — the break-even, funding
 * gap, subsidy headroom and scenario arithmetic a service-enhancement case rests
 * on. No AI reasoning reaches these figures; a reasoning provider may later
 * describe them in prose, but it never produces them.
 *
 * Unit-agnostic by construction: every input is an integer in one consistent
 * unit (minor currency units, or whole pounds, or uses), and the arithmetic is
 * ratios and differences, so the caller's unit is preserved on the way out. The
 * platform convention is minor units; the spec's acceptance figures (C07) are
 * raw, and both give the same answer because the maths is a ratio.
 *
 * Acceptance test C07 (spec §8): a service costing 450,000 with a net receipt of
 * 3 per use and a subsidy cap of 100,000 breaks even at **150,000 uses** and
 * needs a minimum of **116,667 whole uses** once the subsidy is applied. Both
 * fall straight out of the two formulas below, which is why they are kept pure.
 */

/** Divide and round **up** to a whole use — you cannot break even on a fraction of a journey. */
function wholeUses(amount: number, perUse: number): number {
  if (perUse <= 0) return Number.POSITIVE_INFINITY; // a non-positive receipt never covers a positive cost
  return Math.ceil(amount / perUse);
}

export type ServiceCaseInput = {
  /** Annual operating cost of running the enhanced service. */
  operatingCostMinor: number;
  /**
   * Net receipt per use — fare/revenue less the marginal cost of serving one
   * more use. Net, because a gross fare that ignores the cost of carrying the
   * passenger overstates what each use contributes to the fixed operating cost.
   */
  netReceiptPerUseMinor: number;
  /** Forecast annual uses (the central demand case). Optional: the two break-even figures do not need it. */
  demandUses?: number;
  /**
   * Service capacity in uses. Demand is served only up to capacity; anything
   * above is unmet demand, surfaced rather than silently satisfied — the spec
   * (§5) forbids demand exceeding capacity unless the unmet part is explicit.
   */
  capacityUses?: number;
  /** The maximum subsidy available to close the operating gap. */
  subsidyCapMinor?: number;
  /** Optional capital cost, carried for whole-life context; it does not enter the operating break-even. */
  capexMinor?: number;
};

export type ServiceCaseResult = {
  /** Uses needed to cover the operating cost from receipts alone (no subsidy). */
  breakEvenUses: number;
  /** Uses needed once the available subsidy (capped) is applied against the cost. */
  minUsesWithinCap: number;
  /** Uses actually served = min(demand, capacity). Undefined inputs leave it undefined. */
  servedUses?: number;
  /** Demand that cannot be served because it exceeds capacity (0 if none, or capacity unset). */
  unmetUses?: number;
  /** Receipts at the served level. */
  receiptsMinor?: number;
  /** Receipts − operating cost at the served level (a deficit is negative). */
  operatingBalanceMinor?: number;
  /** The funding gap the subsidy must close: max(0, operating cost − receipts). */
  fundingGapMinor?: number;
  /** Subsidy actually drawn = min(funding gap, cap). */
  subsidyDrawnMinor?: number;
  /** Gap left unfunded after the capped subsidy — the number that stops a case. */
  residualGapMinor?: number;
  /** Whether the served case is affordable within the subsidy cap (no residual gap). */
  withinSubsidyCap?: boolean;
  /** Whether forecast demand exceeds capacity (only when both are given). */
  demandExceedsCapacity?: boolean;
};

/**
 * The service business-case arithmetic. The two break-even figures are always
 * computed; the served-level figures appear only when demand (and, for capacity
 * effects, capacity) are supplied.
 */
export function serviceBusinessCase(input: ServiceCaseInput): ServiceCaseResult {
  const { operatingCostMinor, netReceiptPerUseMinor } = input;
  const subsidyCap = Math.max(0, input.subsidyCapMinor ?? 0);

  const breakEvenUses = wholeUses(operatingCostMinor, netReceiptPerUseMinor);
  // The cost the receipts must cover once the capped subsidy is applied. Never
  // below zero: a subsidy larger than the cost does not create negative demand.
  const costAfterSubsidy = Math.max(0, operatingCostMinor - subsidyCap);
  const minUsesWithinCap = wholeUses(costAfterSubsidy, netReceiptPerUseMinor);

  const result: ServiceCaseResult = { breakEvenUses, minUsesWithinCap };

  if (input.demandUses !== undefined) {
    const demand = Math.max(0, input.demandUses);
    const capacity = input.capacityUses;
    const served = capacity !== undefined ? Math.min(demand, Math.max(0, capacity)) : demand;
    const unmet = capacity !== undefined ? Math.max(0, demand - Math.max(0, capacity)) : 0;
    const receipts = served * netReceiptPerUseMinor;
    const operatingBalance = receipts - operatingCostMinor;
    const fundingGap = Math.max(0, operatingCostMinor - receipts);
    const subsidyDrawn = Math.min(fundingGap, subsidyCap);
    const residualGap = fundingGap - subsidyDrawn;

    result.servedUses = served;
    result.unmetUses = unmet;
    result.receiptsMinor = receipts;
    result.operatingBalanceMinor = operatingBalance;
    result.fundingGapMinor = fundingGap;
    result.subsidyDrawnMinor = subsidyDrawn;
    result.residualGapMinor = residualGap;
    result.withinSubsidyCap = residualGap === 0;
    if (capacity !== undefined) result.demandExceedsCapacity = demand > Math.max(0, capacity);
  }

  return result;
}

/** A single scenario run: a named demand multiplier applied to the central case. */
export type ScenarioRun = {
  name: string;
  demandMultiplier: number;
  result: ServiceCaseResult;
};

/**
 * Central / downside / upside (and any supplied) scenarios over one case.
 *
 * The spec (§5) requires "central, upside, downside and combined scenarios" and
 * the tests to "Test zero demand, threshold breach, delayed launch, missing
 * funding, higher cost and unavailable capacity." This runs the demand-side
 * family deterministically; cost/funding stress is a second call with the
 * stressed input, so each stress is explicit rather than hidden in one number.
 */
export function scenarioRuns(
  input: ServiceCaseInput,
  scenarios: Array<{ name: string; demandMultiplier: number }> = [
    { name: 'Downside', demandMultiplier: 0.7 },
    { name: 'Central', demandMultiplier: 1 },
    { name: 'Upside', demandMultiplier: 1.3 },
  ],
): ScenarioRun[] {
  const base = input.demandUses ?? 0;
  return scenarios.map((s) => ({
    name: s.name,
    demandMultiplier: s.demandMultiplier,
    result: serviceBusinessCase({ ...input, demandUses: Math.round(base * s.demandMultiplier) }),
  }));
}

/**
 * The demand at which the operating balance crosses zero — the switching value a
 * decision turns on. Equal to the break-even uses by construction, surfaced
 * under its appraisal name so a reader sees it as the threshold it is.
 */
export function demandSwitchingValue(input: ServiceCaseInput): number {
  return wholeUses(input.operatingCostMinor, input.netReceiptPerUseMinor);
}
