/**
 * Earned value and commercial forecasting.
 *
 * All figures are integers in minor currency units. Percentages are returned as
 * ratios so callers can format them; rounding happens once, at the edge.
 */

export type EVMInput = {
  /** Planned value: budgeted cost of work scheduled to date. */
  plannedValueMinor: number;
  /** Earned value: budgeted cost of work actually performed. */
  earnedValueMinor: number;
  /** Actual cost of work performed. */
  actualCostMinor: number;
  /** Budget at completion. */
  budgetAtCompletionMinor: number;
};

export type EVMSnapshot = EVMInput & {
  costVarianceMinor: number;
  scheduleVarianceMinor: number;
  costPerformanceIndex: number;
  schedulePerformanceIndex: number;
  /** Estimate at completion, assuming current cost performance persists. */
  estimateAtCompletionMinor: number;
  /** Optimistic EAC: remaining work delivered at budgeted rate. */
  estimateAtCompletionOptimisticMinor: number;
  /** Pessimistic EAC: remaining work suffers both cost and schedule drag. */
  estimateAtCompletionPessimisticMinor: number;
  estimateToCompleteMinor: number;
  varianceAtCompletionMinor: number;
  /** To-complete performance index: the efficiency needed to still hit budget. */
  toCompletePerformanceIndex: number;
  /** How trustworthy the numbers are, given how much of the work is measured. */
  confidence: number;
};

export function calculateEVM(input: EVMInput, measuredCoverage = 1): EVMSnapshot {
  const { plannedValueMinor: pv, earnedValueMinor: ev, actualCostMinor: ac, budgetAtCompletionMinor: bac } = input;

  const cpi = ac === 0 ? 1 : ev / ac;
  const spi = pv === 0 ? 1 : ev / pv;

  const eac = cpi === 0 ? bac : Math.round(bac / cpi);
  const eacOptimistic = ac + (bac - ev);
  const eacPessimistic = cpi * spi === 0 ? bac : Math.round(ac + (bac - ev) / (cpi * spi));
  const remainingBudget = bac - ac;

  return {
    ...input,
    costVarianceMinor: ev - ac,
    scheduleVarianceMinor: ev - pv,
    costPerformanceIndex: Number(cpi.toFixed(4)),
    schedulePerformanceIndex: Number(spi.toFixed(4)),
    estimateAtCompletionMinor: eac,
    estimateAtCompletionOptimisticMinor: eacOptimistic,
    estimateAtCompletionPessimisticMinor: eacPessimistic,
    estimateToCompleteMinor: eac - ac,
    varianceAtCompletionMinor: bac - eac,
    toCompletePerformanceIndex: remainingBudget <= 0 ? 0 : Number(((bac - ev) / remainingBudget).toFixed(4)),
    // A forecast built on 20% measured progress does not deserve the same
    // weight as one built on 90%. This makes that explicit rather than implied.
    confidence: Number(Math.max(0.1, Math.min(1, measuredCoverage)).toFixed(3)),
  };
}

// --- Cost value reconciliation ----------------------------------------------

export type CVRInput = {
  /** Original contract sum. */
  contractValueMinor: number;
  /** Instructed variations agreed with the client. */
  approvedVariationsMinor: number;
  /** Variations instructed or claimed but not yet agreed. */
  unapprovedVariationsMinor: number;
  /** Value certified by the client to date. */
  certifiedToDateMinor: number;
  /** Subcontract and supply commitments raised. */
  commitmentsMinor: number;
  /** Cost incurred and posted. */
  costToDateMinor: number;
  /** Accrued cost for work done but not yet invoiced. */
  accrualsMinor: number;
  /** Forecast cost still to be incurred. */
  costToCompleteMinor: number;
};

export type CVR = CVRInput & {
  forecastFinalValueMinor: number;
  forecastFinalCostMinor: number;
  forecastMarginMinor: number;
  forecastMarginPercent: number;
  marginAtTenderPercent: number;
  marginErosionPercent: number;
  /** Cash position: certified less paid-out cost. */
  cashPositionMinor: number;
  /** Exposure carried by variations that have not been agreed. */
  unapprovedExposureMinor: number;
  dataCompleteness: number;
  alerts: string[];
};

export function calculateCVR(input: CVRInput, tenderMarginPercent: number, dataCompleteness = 1): CVR {
  const forecastFinalValue = input.contractValueMinor + input.approvedVariationsMinor + input.unapprovedVariationsMinor;
  const forecastFinalCost = input.costToDateMinor + input.accrualsMinor + input.costToCompleteMinor;
  const margin = forecastFinalValue - forecastFinalCost;
  const marginPercent = forecastFinalValue === 0 ? 0 : (margin / forecastFinalValue) * 100;
  const erosion = tenderMarginPercent - marginPercent;

  const alerts: string[] = [];
  if (erosion > 2) alerts.push(`Margin eroded by ${erosion.toFixed(1)} points against tender`);
  if (margin < 0) alerts.push('Forecast final cost exceeds forecast final value — project is loss-making');
  if (input.unapprovedVariationsMinor > input.contractValueMinor * 0.05) {
    alerts.push('Unapproved variations exceed 5% of contract value — entitlement exposure is material');
  }
  if (input.commitmentsMinor > forecastFinalCost) {
    alerts.push('Commitments exceed forecast final cost — buyout is over budget');
  }
  if (dataCompleteness < 0.7) {
    alerts.push('CVR confidence is low: cost or progress data is incomplete');
  }

  return {
    ...input,
    forecastFinalValueMinor: forecastFinalValue,
    forecastFinalCostMinor: forecastFinalCost,
    forecastMarginMinor: margin,
    forecastMarginPercent: Number(marginPercent.toFixed(2)),
    marginAtTenderPercent: tenderMarginPercent,
    marginErosionPercent: Number(erosion.toFixed(2)),
    cashPositionMinor: input.certifiedToDateMinor - input.costToDateMinor,
    unapprovedExposureMinor: input.unapprovedVariationsMinor,
    dataCompleteness: Number(dataCompleteness.toFixed(3)),
    alerts,
  };
}

// --- Cashflow ---------------------------------------------------------------

/**
 * S-curve cashflow distribution. Construction spend is not linear: it ramps up,
 * peaks through the main works and tails off. A logistic curve models that far
 * better than a straight line and needs no historical data to seed.
 */
export function sCurveDistribution(totalMinor: number, periods: number): number[] {
  if (periods <= 0) return [];
  if (periods === 1) return [totalMinor];

  const cumulative: number[] = [];
  for (let i = 1; i <= periods; i++) {
    const t = i / periods;
    // Logistic centred at the midpoint, steepness 6 — a typical build profile.
    const value = 1 / (1 + Math.exp(-6 * (t - 0.5)));
    cumulative.push(value);
  }

  const first = 1 / (1 + Math.exp(-6 * (1 / periods - 0.5)));
  const last = cumulative[cumulative.length - 1] as number;
  const normalised = cumulative.map((v) => (v - first) / (last - first));

  const periodValues: number[] = [];
  let previous = 0;
  for (let i = 0; i < periods; i++) {
    const share = (normalised[i] as number) - previous;
    previous = normalised[i] as number;
    periodValues.push(Math.round(totalMinor * share));
  }

  // Force the periods to sum exactly to the total after rounding.
  const drift = totalMinor - periodValues.reduce((s, v) => s + v, 0);
  if (periodValues.length > 0) periodValues[periodValues.length - 1] = (periodValues[periodValues.length - 1] as number) + drift;
  return periodValues;
}
