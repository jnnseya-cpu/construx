import { contingencyRequirement, type ScoredRisk } from './risk.ts';

/**
 * The tender cost model: twenty heads, priced on the basis each one actually
 * has.
 *
 * The heads are not the interesting part — every estimating package has a list
 * of headings. What loses money is pricing a head on the wrong basis, and the
 * same three mistakes recur:
 *
 *   1. **Preliminaries as a percentage of works.** Prelims are a weekly cost
 *      multiplied by weeks on site. Site management, welfare, accommodation,
 *      logistics, the safety adviser and the site engineer are all paid by the
 *      week and none of them cost less because the works were cheap. Price them
 *      as a percentage and a programme that slips eight weeks is eight weeks of
 *      unrecovered cost. Here time-related heads take a weekly rate and a
 *      duration, and the percentage is an *output* for benchmarking — never an
 *      input.
 *   2. **Contingency as a round number.** A defensible contingency comes from
 *      the risk register, and simple expected value understates the tail, which
 *      is why this draws the P80 figure from `contingencyRequirement`.
 *   3. **Inflation on everything, or on nothing.** Inflation applies to the
 *      spend that falls after the base date, on the portion not already fixed
 *      by a firm price. Applying it to a fixed subcontract sum is a made-up
 *      cost; omitting it on a three-year job is a made-up saving.
 *
 * A head with no basis is reported as **unpriced**, never as zero. A tender
 * with nothing against waste is not a tender with no waste in it.
 */

export type CostHead =
  | 'DIRECT_WORKS'
  | 'SUBCONTRACT'
  | 'MATERIALS'
  | 'PLANT'
  | 'PRELIMINARIES'
  | 'SITE_MANAGEMENT'
  | 'TEMPORARY_WORKS'
  | 'INSURANCE'
  | 'DESIGN'
  | 'PROFESSIONAL_FEES'
  | 'TESTING'
  | 'COMMISSIONING'
  | 'WASTE'
  | 'LOGISTICS'
  | 'HEALTH_AND_SAFETY'
  | 'QUALITY'
  | 'RISK'
  | 'INFLATION'
  | 'OVERHEAD'
  | 'PROFIT';

export type PricingBasis =
  /** Quantity times rate, measured off the drawings. */
  | 'MEASURED'
  /** Weekly cost times weeks on site. Re-prices when the programme moves. */
  | 'TIME_RELATED'
  /** Its own units — skips, tonnes, hire weeks, test counts. */
  | 'QUANTIFIED'
  /** A fee: a lump sum, or a percentage of the works it relates to. */
  | 'FEE'
  /** Genuinely proportional to contract value. */
  | 'VALUE_RELATED'
  /** Derived from the risk register. */
  | 'RISK_REGISTER'
  /** Derived from the base date, the programme and the forecast rate. */
  | 'INDEXED'
  /** Applied to the cost beneath it. */
  | 'MARGIN';

export type CostHeadDefinition = {
  head: CostHead;
  label: string;
  basis: PricingBasis;
  /**
   * Whether this head's spend is exposed to inflation. Fixed-price subcontract
   * sums are not; the labour, materials and plant the contractor buys are.
   */
  inflationExposed: boolean;
  /** Why it exists, in the terms an estimator would defend it in. */
  note: string;
};

export const COST_HEADS: CostHeadDefinition[] = [
  { head: 'DIRECT_WORKS', label: 'Direct works', basis: 'MEASURED', inflationExposed: true, note: 'Own labour against measured quantities' },
  { head: 'SUBCONTRACT', label: 'Subcontract costs', basis: 'MEASURED', inflationExposed: false, note: 'Package sums; fixed-price sums are not indexed' },
  { head: 'MATERIALS', label: 'Materials', basis: 'MEASURED', inflationExposed: true, note: 'Supply against measured quantities, including waste allowance' },
  { head: 'PLANT', label: 'Plant', basis: 'MEASURED', inflationExposed: true, note: 'Owned and hired plant against the works' },
  { head: 'PRELIMINARIES', label: 'Preliminaries', basis: 'TIME_RELATED', inflationExposed: true, note: 'Site setup, welfare, accommodation, utilities — by the week' },
  { head: 'SITE_MANAGEMENT', label: 'Site management', basis: 'TIME_RELATED', inflationExposed: true, note: 'Site staff establishment — by the week, per person' },
  { head: 'TEMPORARY_WORKS', label: 'Temporary works', basis: 'QUANTIFIED', inflationExposed: true, note: 'Design fees plus hire duration; a CDM duty, not an allowance' },
  { head: 'INSURANCE', label: 'Insurance allocation', basis: 'VALUE_RELATED', inflationExposed: false, note: 'Contract works, PL and PI premiums on contract value' },
  { head: 'DESIGN', label: 'Design', basis: 'FEE', inflationExposed: false, note: 'Contractor-designed portion, per the design responsibility matrix' },
  { head: 'PROFESSIONAL_FEES', label: 'Professional fees', basis: 'FEE', inflationExposed: false, note: 'External consultants, surveys, statutory and planning fees' },
  { head: 'TESTING', label: 'Testing', basis: 'QUANTIFIED', inflationExposed: true, note: 'Materials, structural and systems testing against the ITP' },
  { head: 'COMMISSIONING', label: 'Commissioning', basis: 'QUANTIFIED', inflationExposed: true, note: 'Systems commissioning, witnessing and demonstration' },
  { head: 'WASTE', label: 'Waste', basis: 'QUANTIFIED', inflationExposed: true, note: 'Skips, muck away and gate fees — by volume or tonnage' },
  { head: 'LOGISTICS', label: 'Logistics', basis: 'TIME_RELATED', inflationExposed: true, note: 'Gate, traffic marshalling, hoists, cranage, deliveries — by the week' },
  { head: 'HEALTH_AND_SAFETY', label: 'Health and safety', basis: 'TIME_RELATED', inflationExposed: true, note: 'Safety advice, inductions, PPE, monitoring — by the week' },
  { head: 'QUALITY', label: 'Quality', basis: 'TIME_RELATED', inflationExposed: true, note: 'Inspection, ITP administration, snagging and handover evidence' },
  { head: 'RISK', label: 'Contingency and risk', basis: 'RISK_REGISTER', inflationExposed: false, note: 'From the quantified register, at P80 rather than expected value' },
  { head: 'INFLATION', label: 'Inflation', basis: 'INDEXED', inflationExposed: false, note: 'On exposed spend falling after the base date' },
  { head: 'OVERHEAD', label: 'Overhead', basis: 'MARGIN', inflationExposed: false, note: 'Head office recovery on cost' },
  { head: 'PROFIT', label: 'Profit', basis: 'MARGIN', inflationExposed: false, note: 'Return on cost plus overhead' },
];

export const COST_HEAD_ORDER: CostHead[] = COST_HEADS.map((h) => h.head);

const headIndex = new Map(COST_HEADS.map((h) => [h.head, h]));

export function costHead(head: string): CostHeadDefinition | undefined {
  return headIndex.get(head as CostHead);
}

// --- Inputs ---------------------------------------------------------------------

/** A measured line. Rates are per unit, in minor units. */
export type MeasuredLine = {
  boqItemId?: string;
  description: string;
  unit: string;
  quantity: number;
  labourRateMinor?: number;
  materialRateMinor?: number;
  plantRateMinor?: number;
  subcontractRateMinor?: number;
  /** Percentage added to materials for cutting, breakage and over-order. */
  materialWastePercent?: number;
  /** A subcontract sum agreed firm is not indexed for inflation. */
  subcontractFixedPrice?: boolean;
};

/** A resource paid by the week for as long as it is on site. */
export type TimeRelatedItem = {
  head: Extract<CostHead, 'PRELIMINARIES' | 'SITE_MANAGEMENT' | 'LOGISTICS' | 'HEALTH_AND_SAFETY' | 'QUALITY'>;
  description: string;
  /** Cost per week per unit, in minor units. */
  weeklyRateMinor: number;
  /** How many of them. Two site managers is quantity two. */
  quantity: number;
  /**
   * Weeks on site. Defaults to the full construction period — most of these
   * are there start to finish, which is exactly why they cost what they cost.
   */
  weeks?: number;
};

/** Something with its own units: skips, hire weeks, tests, commissioning days. */
export type QuantifiedItem = {
  head: Extract<CostHead, 'TEMPORARY_WORKS' | 'TESTING' | 'COMMISSIONING' | 'WASTE'>;
  description: string;
  unit: string;
  quantity: number;
  rateMinor: number;
};

/** A fee, either a lump sum or a percentage of the works it relates to. */
export type FeeItem = {
  head: Extract<CostHead, 'DESIGN' | 'PROFESSIONAL_FEES'>;
  description: string;
  lumpSumMinor?: number;
  /** Percentage of net measured works, for fees quoted that way. */
  percentOfWorks?: number;
};

export type InsuranceInput = {
  /** Premium as a percentage of contract value, by policy. */
  policies: Array<{ type: string; percentOfContractValue: number }>;
};

export type InflationInput = {
  /** The date the rates were priced at. */
  baseDate: string;
  /** Forecast annual rate, e.g. 0.035 for 3.5%. */
  annualRate: number;
  /** When work starts on site. */
  startOnSite: string;
};

export type MarginInput = { overheadPercent: number; profitPercent: number };

export type CostModelInput = {
  /** Construction period in weeks. Drives every time-related head. */
  durationWeeks: number;
  lines: MeasuredLine[];
  timeRelated?: TimeRelatedItem[];
  quantified?: QuantifiedItem[];
  fees?: FeeItem[];
  insurance?: InsuranceInput;
  /** Scored risks. Contingency is drawn from these, not from a percentage. */
  risks?: ScoredRisk[];
  /** Which point of the distribution to carry. P80 is the defensible default. */
  contingencyBasis?: 'EXPECTED' | 'P80';
  inflation?: InflationInput;
  margin: MarginInput;
  /**
   * Heads deliberately not priced, each with the wording that will appear in
   * the tender as an exclusion. A head that is neither priced nor excluded is
   * an omission, and this model says so rather than carrying it as zero.
   */
  exclusions?: Array<{ head: CostHead; reason: string }>;
};

// --- Output ---------------------------------------------------------------------

export type PricedHead = {
  head: CostHead;
  label: string;
  basis: PricingBasis;
  amountMinor: number;
  /** How the number was arrived at, in words an estimator can check. */
  derivation: string;
  status: 'PRICED' | 'EXCLUDED' | 'UNPRICED';
  excludedReason?: string;
};

export type PricedEstimate = {
  heads: PricedHead[];
  subtotals: {
    /** Measured works before anything site-wide. */
    netMeasuredMinor: number;
    /** Time-related and quantified site-wide costs. */
    siteOverheadMinor: number;
    feesMinor: number;
    /** Everything above, before risk, inflation and margin. */
    netCostMinor: number;
    inflationMinor: number;
    riskMinor: number;
    insuranceMinor: number;
    /** Total cost carried, before margin. */
    totalCostMinor: number;
    overheadMinor: number;
    profitMinor: number;
  };
  tenderTotalMinor: number;
  /** Profit as a percentage of the tender total — what the margin actually is. */
  marginPercent: number;
  /**
   * Benchmarks. These are outputs, and pricing anything from them is the
   * mistake this model exists to prevent.
   */
  benchmarks: {
    prelimsPercentOfWorks: number;
    riskPercentOfCost: number;
    weeklyBurnMinor: number;
    costPerWeekOfSiteOverheadMinor: number;
  };
  /** Heads neither priced nor excluded. A tender should not be submitted with these. */
  omissions: CostHead[];
  /** Exclusions, worded ready to go into the tender qualifications. */
  exclusions: Array<{ head: CostHead; label: string; reason: string }>;
  warnings: string[];
};

function round(n: number): number {
  return Math.round(n);
}

function weeksBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / (7 * 86_400_000);
}

/**
 * Price the whole tender.
 *
 * The order of the build-up is the point. Insurance is a percentage of contract
 * value so it cannot be computed before the cost it insures; inflation applies
 * to exposed cost so it comes after that cost is known but before margin;
 * overhead is on cost and profit is on cost plus overhead, because that is how
 * a business actually recovers them.
 */
export function priceEstimate(input: CostModelInput): PricedEstimate {
  const warnings: string[] = [];

  if (input.durationWeeks <= 0) {
    throw new Error('DURATION_REQUIRED: time-related costs cannot be priced without a construction period');
  }

  const excluded = new Map((input.exclusions ?? []).map((e) => [e.head, e.reason]));
  const amounts = new Map<CostHead, number>();
  const derivations = new Map<CostHead, string>();
  /** Spend exposed to inflation, by head. */
  const exposed = new Map<CostHead, number>();

  // 1 — Measured works.
  let labour = 0;
  let materials = 0;
  let plant = 0;
  let subcontract = 0;
  let subcontractFixed = 0;

  for (const line of input.lines) {
    const wasteFactor = 1 + (line.materialWastePercent ?? 0) / 100;
    labour += line.quantity * (line.labourRateMinor ?? 0);
    materials += line.quantity * (line.materialRateMinor ?? 0) * wasteFactor;
    plant += line.quantity * (line.plantRateMinor ?? 0);
    const sub = line.quantity * (line.subcontractRateMinor ?? 0);
    subcontract += sub;
    if (line.subcontractFixedPrice) subcontractFixed += sub;
  }

  amounts.set('DIRECT_WORKS', round(labour));
  amounts.set('MATERIALS', round(materials));
  amounts.set('PLANT', round(plant));
  amounts.set('SUBCONTRACT', round(subcontract));
  derivations.set('DIRECT_WORKS', `${input.lines.length} measured lines at labour rates`);
  derivations.set('MATERIALS', `${input.lines.length} measured lines at supply rates, including waste allowance`);
  derivations.set('PLANT', `${input.lines.length} measured lines at plant rates`);
  derivations.set(
    'SUBCONTRACT',
    subcontractFixed > 0
      ? `Package sums, of which ${Math.round((subcontractFixed / Math.max(1, subcontract)) * 100)}% is firm price and not indexed`
      : 'Package sums, none confirmed firm price',
  );

  exposed.set('DIRECT_WORKS', labour);
  exposed.set('MATERIALS', materials);
  exposed.set('PLANT', plant);
  exposed.set('SUBCONTRACT', subcontract - subcontractFixed);

  const netMeasured = round(labour + materials + plant + subcontract);

  // 2 — Time-related site-wide costs. Weekly rate times weeks, times how many.
  for (const item of input.timeRelated ?? []) {
    const weeks = item.weeks ?? input.durationWeeks;
    if (weeks > input.durationWeeks) {
      warnings.push(`${item.description} is priced for ${weeks} weeks against a ${input.durationWeeks}-week programme`);
    }
    const amount = item.weeklyRateMinor * item.quantity * weeks;
    amounts.set(item.head, (amounts.get(item.head) ?? 0) + round(amount));
    exposed.set(item.head, (exposed.get(item.head) ?? 0) + amount);
  }
  for (const head of ['PRELIMINARIES', 'SITE_MANAGEMENT', 'LOGISTICS', 'HEALTH_AND_SAFETY', 'QUALITY'] as const) {
    const items = (input.timeRelated ?? []).filter((i) => i.head === head);
    if (items.length > 0) {
      const weeks = items.map((i) => i.weeks ?? input.durationWeeks);
      const low = Math.min(...weeks);
      const high = Math.max(...weeks);
      derivations.set(
        head,
        `${items.length} resource${items.length === 1 ? '' : 's'} at weekly rates over ${low === high ? `${low} weeks` : `${low}–${high} weeks`}`,
      );
    }
  }

  // 3 — Quantified heads in their own units.
  for (const item of input.quantified ?? []) {
    const amount = item.quantity * item.rateMinor;
    amounts.set(item.head, (amounts.get(item.head) ?? 0) + round(amount));
    exposed.set(item.head, (exposed.get(item.head) ?? 0) + amount);
  }
  for (const head of ['TEMPORARY_WORKS', 'TESTING', 'COMMISSIONING', 'WASTE'] as const) {
    const items = (input.quantified ?? []).filter((i) => i.head === head);
    if (items.length > 0) {
      derivations.set(head, items.map((i) => `${i.quantity} ${i.unit}`).join(', '));
    }
  }

  // 4 — Fees, lump sum or a percentage of the measured works.
  for (const fee of input.fees ?? []) {
    const amount = (fee.lumpSumMinor ?? 0) + (fee.percentOfWorks ? netMeasured * (fee.percentOfWorks / 100) : 0);
    amounts.set(fee.head, (amounts.get(fee.head) ?? 0) + round(amount));
  }
  for (const head of ['DESIGN', 'PROFESSIONAL_FEES'] as const) {
    const items = (input.fees ?? []).filter((i) => i.head === head);
    if (items.length > 0) {
      derivations.set(head, items.map((i) => (i.percentOfWorks ? `${i.percentOfWorks}% of works` : 'lump sum')).join(', '));
    }
  }

  const timeRelatedHeads: CostHead[] = ['PRELIMINARIES', 'SITE_MANAGEMENT', 'LOGISTICS', 'HEALTH_AND_SAFETY', 'QUALITY'];
  const quantifiedHeads: CostHead[] = ['TEMPORARY_WORKS', 'TESTING', 'COMMISSIONING', 'WASTE'];
  const feeHeads: CostHead[] = ['DESIGN', 'PROFESSIONAL_FEES'];

  const sumOf = (heads: CostHead[]): number => heads.reduce((s, h) => s + (amounts.get(h) ?? 0), 0);

  const siteOverhead = sumOf([...timeRelatedHeads, ...quantifiedHeads]);
  const fees = sumOf(feeHeads);
  const netCost = netMeasured + siteOverhead + fees;

  // 5 — Inflation, on the exposed portion only, at the weighted mid-point of
  // spend. Spend is not uniform, but the mid-point of a construction S-curve is
  // close enough to the middle of the period that pretending otherwise is false
  // precision.
  let inflation = 0;
  if (input.inflation) {
    const exposedTotal = [...timeRelatedHeads, ...quantifiedHeads, 'DIRECT_WORKS', 'MATERIALS', 'PLANT', 'SUBCONTRACT']
      .map((h) => exposed.get(h as CostHead) ?? 0)
      .reduce((s, v) => s + v, 0);

    const weeksToStart = weeksBetween(input.inflation.baseDate, input.inflation.startOnSite);
    if (weeksToStart < 0) {
      warnings.push('Start on site precedes the base date; inflation has been taken from the base date');
    }
    // Mid-point of spend: start on site plus half the construction period.
    const yearsToMidpoint = Math.max(0, weeksToStart + input.durationWeeks / 2) / 52;
    const factor = Math.pow(1 + input.inflation.annualRate, yearsToMidpoint) - 1;
    inflation = round(exposedTotal * factor);

    amounts.set('INFLATION', inflation);
    derivations.set(
      'INFLATION',
      `${(input.inflation.annualRate * 100).toFixed(2)}% per annum over ${yearsToMidpoint.toFixed(2)} years to the mid-point of exposed spend`,
    );
    if (subcontractFixed > 0) {
      derivations.set('INFLATION', `${derivations.get('INFLATION')}; firm-price subcontract sums excluded`);
    }
  }

  // 6 — Contingency, from the register rather than a percentage.
  let risk = 0;
  if (input.risks && input.risks.length > 0) {
    const requirement = contingencyRequirement(input.risks);
    const basis = input.contingencyBasis ?? 'P80';
    risk = basis === 'P80' ? requirement.p80Minor : requirement.expectedMinor;
    amounts.set('RISK', risk);
    derivations.set(
      'RISK',
      `${input.risks.length} quantified risk${input.risks.length === 1 ? '' : 's'} at ${basis}; expected ${requirement.expectedMinor}, worst case ${requirement.worstCaseMinor}`,
    );
  }

  // 7 — Insurance, on the value it insures. It cannot be computed before that
  // value is known, which is why it sits here and not with the fees.
  const insurableValue = netCost + inflation + risk;
  let insurance = 0;
  if (input.insurance && input.insurance.policies.length > 0) {
    const totalPercent = input.insurance.policies.reduce((s, p) => s + p.percentOfContractValue, 0);
    insurance = round(insurableValue * (totalPercent / 100));
    amounts.set('INSURANCE', insurance);
    derivations.set(
      'INSURANCE',
      `${input.insurance.policies.map((p) => `${p.type} ${p.percentOfContractValue}%`).join(', ')} of insured value`,
    );
  }

  const totalCost = insurableValue + insurance;

  // 8 — Margin. Overhead on cost, profit on cost plus overhead.
  const overhead = round(totalCost * (input.margin.overheadPercent / 100));
  const profit = round((totalCost + overhead) * (input.margin.profitPercent / 100));
  amounts.set('OVERHEAD', overhead);
  amounts.set('PROFIT', profit);
  derivations.set('OVERHEAD', `${input.margin.overheadPercent}% of total cost`);
  derivations.set('PROFIT', `${input.margin.profitPercent}% of cost plus overhead`);

  const tenderTotal = totalCost + overhead + profit;

  // --- Presentation, and the honesty check ------------------------------------
  const omissions: CostHead[] = [];
  const heads: PricedHead[] = COST_HEADS.map((definition) => {
    const amount = amounts.get(definition.head) ?? 0;
    const exclusion = excluded.get(definition.head);

    if (exclusion !== undefined) {
      if (amount > 0) {
        warnings.push(`${definition.label} is both priced and excluded — one of the two is wrong`);
      }
      return {
        head: definition.head,
        label: definition.label,
        basis: definition.basis,
        amountMinor: 0,
        derivation: 'Excluded from this tender',
        status: 'EXCLUDED' as const,
        excludedReason: exclusion,
      };
    }

    if (amount === 0) {
      omissions.push(definition.head);
      return {
        head: definition.head,
        label: definition.label,
        basis: definition.basis,
        amountMinor: 0,
        derivation: 'Nothing priced against this head',
        status: 'UNPRICED' as const,
      };
    }

    return {
      head: definition.head,
      label: definition.label,
      basis: definition.basis,
      amountMinor: amount,
      derivation: derivations.get(definition.head) ?? '',
      status: 'PRICED' as const,
    };
  });

  const prelimsTotal = sumOf(timeRelatedHeads);
  const prelimsPercent = netMeasured === 0 ? 0 : Number(((prelimsTotal / netMeasured) * 100).toFixed(2));

  if (prelimsPercent > 25) {
    warnings.push(
      `Time-related costs are ${prelimsPercent}% of measured works — high, and worth checking the programme rather than the rates`,
    );
  }
  if (omissions.length > 0) {
    warnings.push(
      `${omissions.length} head(s) are neither priced nor excluded: ${omissions.join(', ')}. Price them or exclude them in writing before submitting.`,
    );
  }
  if (!input.risks || input.risks.length === 0) {
    warnings.push('No quantified risk register, so no contingency has been carried');
  }
  if (!input.inflation && input.durationWeeks > 52) {
    warnings.push(`A ${input.durationWeeks}-week programme with no inflation allowance is a fixed price on future costs`);
  }
  if (input.margin.profitPercent <= 0) {
    warnings.push('Profit is zero or negative on this build-up');
  }

  return {
    heads,
    subtotals: {
      netMeasuredMinor: netMeasured,
      siteOverheadMinor: siteOverhead,
      feesMinor: fees,
      netCostMinor: netCost,
      inflationMinor: inflation,
      riskMinor: risk,
      insuranceMinor: insurance,
      totalCostMinor: totalCost,
      overheadMinor: overhead,
      profitMinor: profit,
    },
    tenderTotalMinor: tenderTotal,
    marginPercent: tenderTotal === 0 ? 0 : Number(((profit / tenderTotal) * 100).toFixed(2)),
    benchmarks: {
      prelimsPercentOfWorks: prelimsPercent,
      riskPercentOfCost: totalCost === 0 ? 0 : Number(((risk / totalCost) * 100).toFixed(2)),
      weeklyBurnMinor: round(totalCost / input.durationWeeks),
      costPerWeekOfSiteOverheadMinor: round(siteOverhead / input.durationWeeks),
    },
    omissions,
    exclusions: (input.exclusions ?? []).map((e) => ({
      head: e.head,
      label: costHead(e.head)?.label ?? e.head,
      reason: e.reason,
    })),
    warnings,
  };
}

/**
 * What the tender total becomes if the programme moves.
 *
 * This is the question every contractor is asked after award and few can answer
 * quickly, and it is answerable here only because the time-related heads were
 * priced by the week in the first place.
 */
export function reprice(input: CostModelInput, durationWeeks: number): PricedEstimate {
  return priceEstimate({
    ...input,
    durationWeeks,
    // Items given an explicit duration keep it; items that ran for the whole
    // job still run for the whole job, which is now longer.
    timeRelated: input.timeRelated,
  });
}
