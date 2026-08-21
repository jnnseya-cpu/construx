import { sCurveDistribution } from './evm.ts';

/**
 * Tender-stage cash flow and the peak funding requirement.
 *
 * A profitable contract can still close a company, and this is the arithmetic
 * that shows it before the tender goes in rather than after. The contractor
 * mobilises, pays deposits, buys materials, pays labour weekly and pays
 * subcontractors on their terms — all before the client's first certificate
 * clears. The gap is real money the business has to find, and it is nowhere in
 * the estimate: a £500k job at 12% margin looks excellent and can still need
 * £105k of working capital it does not have.
 *
 * Three things this models that a straight S-curve of income does not:
 *
 *   1. **Money out on its own timetable.** Labour is paid weekly whatever the
 *      client does. Material deposits are paid before delivery. Subcontractors
 *      are paid on their terms, which are rarely the terms above them. The
 *      mismatch between those three and the certificate cycle *is* the funding
 *      requirement.
 *   2. **Retention, twice.** It is deducted from every certificate and comes
 *      back in two halves, the second one after the defects period. Treating it
 *      as a percentage off the price rather than as cash withheld for two years
 *      understates the requirement.
 *   3. **VAT, in the direction it actually flows.** Since the domestic reverse
 *      charge, most B2B construction services carry no output VAT — so the VAT
 *      a contractor used to hold between collection and the quarterly return is
 *      no longer there to fund the job, while input VAT on materials is still
 *      paid out and reclaimed later. That reversal made working capital
 *      materially harder and it belongs in the model, not in a footnote.
 */

export type PaymentTerms = {
  /** Days between payment applications. Monthly is 30. */
  applicationIntervalDays: number;
  /** Days from application to the due date / certificate. */
  certificationDays: number;
  /** Days from the due date to money in the bank. */
  paymentDays: number;
  retentionPercent: number;
  /** Share of retention released at practical completion; the rest at the end of defects. */
  retentionReleasedAtCompletionPercent: number;
  defectsLiabilityWeeks: number;
  /** Advance or mobilisation payment as a percentage of contract value. */
  advancePaymentPercent?: number;
};

export type SupplyTerms = {
  /** Days from a subcontractor's work to paying them. */
  subcontractorPaymentDays: number;
  /** Days from taking materials to paying the supplier. */
  materialSupplierPaymentDays: number;
  /** Deposit taken by material suppliers, paid before delivery. */
  materialsDepositPercent: number;
  /** How far ahead of the spend the deposit falls due. */
  materialsDepositLeadWeeks: number;
  /** Plant hire and preliminaries, on supplier terms. */
  plantPaymentDays: number;
};

export type VatTreatment = {
  ratePercent: number;
  /**
   * The CIS domestic reverse charge. When it applies the contractor charges no
   * VAT on the sale, so there is no VAT float to fund the job — the single
   * biggest change to construction working capital in years.
   */
  reverseCharge: boolean;
  /** Weeks between VAT returns. A quarter is 13. */
  returnIntervalWeeks: number;
  /** Weeks after the period end before the return is settled. */
  settlementLagWeeks: number;
};

/** What the job costs, by how it is paid for rather than by cost head. */
export type FundingCostProfile = {
  /** Paid weekly in the week it is incurred, whatever the client does. */
  labourMinor: number;
  /** Bought on supplier terms, usually with a deposit. */
  materialsMinor: number;
  /** Package sums, paid on subcontract terms. */
  subcontractMinor: number;
  /** Plant and time-related site costs, on supplier terms. */
  plantAndPrelimsMinor: number;
  /** Spent before the first week of work — accommodation, hoarding, bonds, deposits. */
  mobilisationMinor: number;
  /** Head office recovery, drawn weekly. */
  weeklyOverheadMinor: number;
};

export type FundingInput = {
  contractValueMinor: number;
  durationWeeks: number;
  cost: FundingCostProfile;
  payment: PaymentTerms;
  supply: SupplyTerms;
  vat: VatTreatment;
  /** Cash the business can actually put behind this job. */
  availableWorkingCapitalMinor?: number;
};

export type FundingPeriod = {
  week: number;
  cashInMinor: number;
  cashOutMinor: number;
  vatMovementMinor: number;
  netMinor: number;
  cumulativeMinor: number;
};

export type FundingVerdict = 'FUNDABLE' | 'TIGHT' | 'UNFUNDABLE' | 'UNKNOWN';

export type FundingModel = {
  periods: FundingPeriod[];
  /** The most cash the job is ever out of pocket. The number that matters. */
  peakFundingRequirementMinor: number;
  /** The week it happens, so it can be planned for. */
  peakWeek: number;
  /** Weeks the job spends cash-negative. */
  weeksNegative: number;
  /** Cash at the end, before retention comes back. */
  closingBeforeRetentionMinor: number;
  retentionHeldMinor: number;
  /** Final retention release, and how long after completion it lands. */
  finalRetentionWeek: number;
  marginMinor: number;
  marginPercent: number;
  /** Profit against the cash it takes to earn it. A ratio below 1 is a warning. */
  returnOnPeakFunding: number;
  verdict: FundingVerdict;
  availableWorkingCapitalMinor?: number;
  headroomMinor?: number;
  /** Changes that would close the gap, each with what it is worth. */
  remedies: Array<{ change: string; peakWouldBecomeMinor: number; improvementMinor: number }>;
  warnings: string[];
};

const round = (n: number): number => Math.round(n);
const weeksFromDays = (days: number): number => Math.round(days / 7);

/**
 * Build the weekly cash model.
 *
 * Weekly rather than monthly because the peak is often a matter of weeks — the
 * gap between paying the first month's labour and clearing the first
 * certificate — and a monthly model averages exactly the thing being looked for.
 */
export function modelFunding(input: FundingInput, options: { withRemedies?: boolean } = {}): FundingModel {
  // Remedies are priced by re-running this model with one term changed, so the
  // recursion has to stop somewhere. It stops here, explicitly, rather than by
  // relying on a branch happening not to be taken.
  const withRemedies = options.withRemedies ?? true;
  const warnings: string[] = [];

  if (input.durationWeeks <= 0) {
    throw new Error('DURATION_REQUIRED: a cash model needs a construction period');
  }

  const { cost, payment, supply, vat } = input;
  const buildWeeks = input.durationWeeks;

  // The horizon runs past completion far enough to catch the last certificate
  // and the second half of retention, because a job is not finished when the
  // work is.
  const paymentLagWeeks = weeksFromDays(payment.certificationDays + payment.paymentDays);
  const horizon = buildWeeks + paymentLagWeeks + payment.defectsLiabilityWeeks + 2;

  const cashIn = new Array<number>(horizon + 1).fill(0);
  const cashOut = new Array<number>(horizon + 1).fill(0);
  const outputVat = new Array<number>(horizon + 1).fill(0);
  const inputVat = new Array<number>(horizon + 1).fill(0);

  const at = (week: number): number => Math.max(0, Math.min(horizon, Math.round(week)));

  // --- Value earned, and when it is paid ------------------------------------
  // Work is earned on an S-curve; the client pays for it a cycle later, less
  // retention.
  const earned = sCurveDistribution(input.contractValueMinor, buildWeeks);
  const applicationWeeks = Math.max(1, weeksFromDays(payment.applicationIntervalDays));
  const retentionRate = payment.retentionPercent / 100;

  let retentionHeld = 0;
  let unapplied = 0;
  for (let week = 0; week < buildWeeks; week++) {
    unapplied += earned[week] ?? 0;
    const isApplicationWeek = (week + 1) % applicationWeeks === 0 || week === buildWeeks - 1;
    if (!isApplicationWeek || unapplied === 0) continue;

    const retention = round(unapplied * retentionRate);
    const net = unapplied - retention;
    retentionHeld += retention;

    const paidWeek = at(week + paymentLagWeeks);
    cashIn[paidWeek] = (cashIn[paidWeek] ?? 0) + net;
    // Output VAT rides with the certificate — unless the reverse charge applies,
    // in which case the contractor never sees it.
    if (!vat.reverseCharge) {
      outputVat[paidWeek] = (outputVat[paidWeek] ?? 0) + round(net * (vat.ratePercent / 100));
    }
    unapplied = 0;
  }

  // Advance payment, if the contract carries one. It is the single most
  // effective thing a contractor can negotiate and it lands at the start.
  const advance = round(input.contractValueMinor * ((payment.advancePaymentPercent ?? 0) / 100));
  if (advance > 0) cashIn[0] = (cashIn[0] ?? 0) + advance;

  // Retention comes back in two halves.
  const atCompletion = round(retentionHeld * (payment.retentionReleasedAtCompletionPercent / 100));
  const completionWeek = at(buildWeeks + paymentLagWeeks);
  const finalRetentionWeek = at(buildWeeks + payment.defectsLiabilityWeeks + paymentLagWeeks);
  cashIn[completionWeek] = (cashIn[completionWeek] ?? 0) + atCompletion;
  cashIn[finalRetentionWeek] = (cashIn[finalRetentionWeek] ?? 0) + (retentionHeld - atCompletion);

  // --- Money out, each on its own timetable ---------------------------------
  // Mobilisation is spent before anybody is productive.
  cashOut[0] = (cashOut[0] ?? 0) + cost.mobilisationMinor;
  inputVat[0] = (inputVat[0] ?? 0) + round(cost.mobilisationMinor * (vat.ratePercent / 100));

  const labourCurve = sCurveDistribution(cost.labourMinor, buildWeeks);
  const materialCurve = sCurveDistribution(cost.materialsMinor, buildWeeks);
  const subcontractCurve = sCurveDistribution(cost.subcontractMinor, buildWeeks);
  const plantCurve = sCurveDistribution(cost.plantAndPrelimsMinor, buildWeeks);

  const subcontractLag = weeksFromDays(supply.subcontractorPaymentDays);
  const materialLag = weeksFromDays(supply.materialSupplierPaymentDays);
  const plantLag = weeksFromDays(supply.plantPaymentDays);
  const depositRate = supply.materialsDepositPercent / 100;

  for (let week = 0; week < buildWeeks; week++) {
    // Labour is paid weekly, in the week it is worked. Nothing about the
    // client's payment terms changes that, which is why it drives the peak.
    const labour = labourCurve[week] ?? 0;
    cashOut[week] = (cashOut[week] ?? 0) + labour;

    // Materials: a deposit ahead of delivery, the balance on supplier terms.
    const material = materialCurve[week] ?? 0;
    const deposit = round(material * depositRate);
    const depositWeek = at(week - supply.materialsDepositLeadWeeks);
    cashOut[depositWeek] = (cashOut[depositWeek] ?? 0) + deposit;
    inputVat[depositWeek] = (inputVat[depositWeek] ?? 0) + round(deposit * (vat.ratePercent / 100));

    const balance = material - deposit;
    const balanceWeek = at(week + materialLag);
    cashOut[balanceWeek] = (cashOut[balanceWeek] ?? 0) + balance;
    inputVat[balanceWeek] = (inputVat[balanceWeek] ?? 0) + round(balance * (vat.ratePercent / 100));

    // Subcontractors, on their own terms. Under the reverse charge the
    // contractor pays them net of VAT, so there is no input VAT to reclaim.
    const subcontract = subcontractCurve[week] ?? 0;
    const subWeek = at(week + subcontractLag);
    cashOut[subWeek] = (cashOut[subWeek] ?? 0) + subcontract;
    if (!vat.reverseCharge) {
      inputVat[subWeek] = (inputVat[subWeek] ?? 0) + round(subcontract * (vat.ratePercent / 100));
    }

    const plant = plantCurve[week] ?? 0;
    const plantWeek = at(week + plantLag);
    cashOut[plantWeek] = (cashOut[plantWeek] ?? 0) + plant;
    inputVat[plantWeek] = (inputVat[plantWeek] ?? 0) + round(plant * (vat.ratePercent / 100));

    cashOut[week] = (cashOut[week] ?? 0) + cost.weeklyOverheadMinor;
  }

  // --- VAT settlement -------------------------------------------------------
  // VAT collected and reclaimed sits with the business until the return is
  // filed. Netting it off at the point of the transaction would overstate the
  // cash position by a quarter's worth in both directions.
  const vatMovement = new Array<number>(horizon + 1).fill(0);
  const interval = Math.max(1, vat.returnIntervalWeeks);
  let periodOutput = 0;
  let periodInput = 0;
  for (let week = 0; week <= horizon; week++) {
    // Collected with the money, and paid with the money.
    vatMovement[week] = (outputVat[week] ?? 0) - (inputVat[week] ?? 0);
    periodOutput += outputVat[week] ?? 0;
    periodInput += inputVat[week] ?? 0;

    if ((week + 1) % interval === 0) {
      // Settle: pay over what was collected, reclaim what was suffered.
      const settlement = periodOutput - periodInput;
      const settleWeek = at(week + vat.settlementLagWeeks);
      vatMovement[settleWeek] = (vatMovement[settleWeek] ?? 0) - settlement;
      periodOutput = 0;
      periodInput = 0;
    }
  }
  // Anything still outstanding at the horizon settles one lag later.
  if (periodOutput !== 0 || periodInput !== 0) {
    const settleWeek = horizon;
    vatMovement[settleWeek] = (vatMovement[settleWeek] ?? 0) - (periodOutput - periodInput);
  }

  // --- Roll it up -----------------------------------------------------------
  const periods: FundingPeriod[] = [];
  let cumulative = 0;
  let peak = 0;
  let peakWeek = 0;
  let weeksNegative = 0;

  for (let week = 0; week <= horizon; week++) {
    const inn = cashIn[week] ?? 0;
    const out = cashOut[week] ?? 0;
    const vatMove = vatMovement[week] ?? 0;
    const net = inn - out + vatMove;
    cumulative += net;

    if (cumulative < 0) weeksNegative += 1;
    if (-cumulative > peak) {
      peak = -cumulative;
      peakWeek = week;
    }

    periods.push({
      week,
      cashInMinor: inn,
      cashOutMinor: out,
      vatMovementMinor: vatMove,
      netMinor: net,
      cumulativeMinor: cumulative,
    });
  }

  const totalCost =
    cost.labourMinor +
    cost.materialsMinor +
    cost.subcontractMinor +
    cost.plantAndPrelimsMinor +
    cost.mobilisationMinor +
    cost.weeklyOverheadMinor * buildWeeks;
  const margin = input.contractValueMinor - totalCost;

  const closingBeforeRetention =
    (periods[at(buildWeeks + paymentLagWeeks)]?.cumulativeMinor ?? cumulative) - (retentionHeld - atCompletion);

  // --- Verdict --------------------------------------------------------------
  const capital = input.availableWorkingCapitalMinor;
  let verdict: FundingVerdict = 'UNKNOWN';
  let headroom: number | undefined;

  if (capital !== undefined) {
    headroom = capital - peak;
    // A job that uses every last pound of working capital leaves nothing for
    // the one after it, or for anything going wrong on this one. Eighty per
    // cent is the point at which it stops being a plan and becomes a bet.
    verdict = peak > capital ? 'UNFUNDABLE' : peak > capital * 0.8 ? 'TIGHT' : 'FUNDABLE';
  }

  // --- What would fix it ----------------------------------------------------
  // Refusing a job is one answer; changing the terms is usually the better one,
  // so each remedy is priced rather than listed.
  const remedy = (change: string, altered: Partial<FundingInput>) => {
    const alternative = modelFunding({ ...input, ...altered }, { withRemedies: false });
    return {
      change,
      peakWouldBecomeMinor: alternative.peakFundingRequirementMinor,
      improvementMinor: peak - alternative.peakFundingRequirementMinor,
    };
  };

  const remedies =
    withRemedies && (verdict === 'UNFUNDABLE' || verdict === 'TIGHT')
      ? [
          remedy('A 10% advance payment', { payment: { ...payment, advancePaymentPercent: (payment.advancePaymentPercent ?? 0) + 10 } }),
          remedy('Retention reduced to 3%', { payment: { ...payment, retentionPercent: Math.min(payment.retentionPercent, 3) } }),
          remedy('Payment on 30 days rather than the current terms', {
            payment: { ...payment, certificationDays: Math.min(payment.certificationDays, 7), paymentDays: Math.min(payment.paymentDays, 23) },
          }),
          remedy('Subcontractors paid at 45 days', {
            supply: { ...supply, subcontractorPaymentDays: Math.max(supply.subcontractorPaymentDays, 45) },
          }),
          remedy('Fortnightly applications rather than monthly', {
            payment: { ...payment, applicationIntervalDays: Math.min(payment.applicationIntervalDays, 14) },
          }),
        ]
          .filter((r) => r.improvementMinor > 0)
          .sort((a, b) => b.improvementMinor - a.improvementMinor)
      : [];

  // --- Warnings -------------------------------------------------------------
  if (margin <= 0) warnings.push('The contract does not cover its own cost before any of this is financed');
  if (peak > margin && margin > 0) {
    warnings.push(
      `Peak funding is more than the whole margin: the business puts in more cash than the job returns, for ${weeksNegative} weeks`,
    );
  }
  if (verdict === 'UNFUNDABLE') {
    warnings.push('Peak funding exceeds available working capital. This is a no-bid unless the payment structure changes.');
  }
  if (verdict === 'TIGHT') {
    warnings.push('Peak funding leaves under 20% of working capital spare — nothing for the next job or for this one going wrong.');
  }
  if (vat.reverseCharge) {
    warnings.push('Reverse charge applies, so there is no VAT on the sale to fund the job — input VAT is still paid out and reclaimed later.');
  }
  if (supply.subcontractorPaymentDays < weeksFromDays(payment.certificationDays + payment.paymentDays) * 7) {
    warnings.push('Subcontractors are paid faster than the client pays, which the contractor funds for the whole job');
  }

  return {
    periods,
    peakFundingRequirementMinor: round(peak),
    peakWeek,
    weeksNegative,
    closingBeforeRetentionMinor: round(closingBeforeRetention),
    retentionHeldMinor: retentionHeld,
    finalRetentionWeek,
    marginMinor: margin,
    marginPercent: input.contractValueMinor === 0 ? 0 : Number(((margin / input.contractValueMinor) * 100).toFixed(2)),
    returnOnPeakFunding: peak === 0 ? Infinity : Number((margin / peak).toFixed(2)),
    verdict,
    availableWorkingCapitalMinor: capital,
    headroomMinor: headroom,
    remedies,
    warnings,
  };
}

/**
 * Turn a peak funding requirement into the 1–5 score the bid/no-bid algorithm
 * uses for cash-flow risk.
 *
 * Like the supply-chain evidence, this suggests rather than sets: the model
 * knows the arithmetic, not whether the finance director has an overdraft
 * facility nobody mentioned.
 */
export function cashflowScoreFor(peakMinor: number, workingCapitalMinor: number): number {
  if (workingCapitalMinor <= 0) return 1;
  const usage = peakMinor / workingCapitalMinor;
  if (usage <= 0.2) return 5;
  if (usage <= 0.4) return 4;
  if (usage <= 0.6) return 3;
  if (usage <= 0.85) return 2;
  return 1;
}
