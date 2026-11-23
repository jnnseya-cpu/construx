import { hashEvidence } from '../../core/canonical.ts';

/**
 * Standard England planning application fees for conventional new housing.
 *
 * A port of the owner's reference kernel (`CONSTRUX_Planning_Fee_Reference.py`,
 * v1.0), kept bound to it by that kernel's own fixtures in
 * `tests/planningfees.test.ts`. It covers the bounded statutory cases the
 * specification automates — full, outline, reserved matters, condition
 * details, section 73 for major development and section 96A non-householder —
 * for the two verified 2026 schedules. Everything else returns
 * `REVIEW_REQUIRED` with no payable figure.
 *
 * **Every schedule is a rule version a person publishes.** The figures below
 * were transcribed from the owner's specification. This platform cannot reach
 * the published schedules to check them, so a schedule produces a payable
 * figure only once a person in the company has checked it against the source
 * and a different person has published it (`planning.ts`). Until then a quote
 * names the schedule it would use and says it is unpublished.
 *
 * Money is integer pence throughout. An area is carried as integer hundredths
 * of a square metre so "started 0.1 ha" is integer arithmetic, never a float
 * ceiling that turns 25,000 m² into 26 units.
 */

export const FEE_ROUTES = [
  'full',
  'outline',
  'reserved_matters',
  'condition_details',
  'section_73_major',
  'section_96a_non_householder',
] as const;
export type FeeRoute = (typeof FEE_ROUTES)[number];

export type FeeSchedule = {
  /** The rule version a quote pins, e.g. `england-2026-12-08`. */
  version: string;
  title: string;
  /** Inclusive, as a Europe/London calendar date. */
  effectiveFrom: string;
  /** Inclusive. */
  effectiveTo: string;
  sourceUrl: string;
  full: { perDwellingUnder10: number; middleUpTo: number; middleRate: number; upperBase: number; upperExcess: number; cap: number };
  outline: { smallPerUnit: number; mediumPerUnit: number; upperBase: number; upperExcessPerUnit: number; cap: number };
  conditionDetails: number;
  section73Major: number;
  section96aNonHouseholder: number;
  reservedMattersFlat: number;
};

/**
 * The two schedules, in pounds as published. The upper-band base amounts are
 * written out, never derived from the lower-band rate: the published bands are
 * discontinuous (51 dwellings costs less than 50 under the April schedule) and
 * a derivation would quietly remove that.
 */
export const FEE_SCHEDULES: readonly FeeSchedule[] = [
  {
    version: 'england-2026-04-01',
    title: 'Planning fees — annual indexation from 1 April 2026',
    effectiveFrom: '2026-04-01',
    effectiveTo: '2026-12-07',
    sourceUrl: 'https://assets.publishing.service.gov.uk/media/69a073bb07d7bff3604d6df6/Planning_fees_-_annual_indexation_from_1_April_2026.pdf',
    full: { perDwellingUnder10: 610, middleUpTo: 50, middleRate: 659, upperBase: 32578, upperExcess: 196, cap: 427537 },
    outline: { smallPerUnit: 610, mediumPerUnit: 659, upperBase: 16291, upperExcessPerUnit: 196, cap: 213769 },
    conditionDetails: 309,
    section73Major: 2076,
    section96aNonHouseholder: 309,
    reservedMattersFlat: 610,
  },
  {
    version: 'england-2026-12-08',
    title: 'Planning fees — national increases from 8 December 2026',
    effectiveFrom: '2026-12-08',
    effectiveTo: '2027-03-31',
    sourceUrl: 'https://assets.publishing.service.gov.uk/media/6af1a985bdaa07fdf9470e18/Planning_fees_national_increases_from_8_December_2026.pdf',
    full: { perDwellingUnder10: 752, middleUpTo: 49, middleRate: 818, upperBase: 40082, upperExcess: 236, cap: 513512 },
    outline: { smallPerUnit: 719, mediumPerUnit: 896, upperBase: 22400, upperExcessPerUnit: 267, cap: 290625 },
    conditionDetails: 435,
    section73Major: 3150,
    section96aNonHouseholder: 360,
    reservedMattersFlat: 749,
  },
];

/** A schedule's content hash: what a publication pins, so an edit to the figures un-publishes it. */
export function scheduleHash(schedule: FeeSchedule): string {
  return hashEvidence(JSON.stringify(schedule));
}

export type FeeLine = { description: string; quantity: number; unitMinor: number; amountMinor: number };

export type FeeQuoteResult = {
  route: FeeRoute;
  madeOn: string;
  status: 'CALCULATED' | 'REVIEW_REQUIRED';
  /** Null whenever review is required: there is no automatically payable figure. */
  amountMinor: number | null;
  currency: 'GBP';
  ruleVersion: string | null;
  sourceUrl: string | null;
  breakdown: FeeLine[];
  reviewReasons: string[];
};

export type FeeInput = {
  route: FeeRoute;
  /** The application or request made date, Europe/London, YYYY-MM-DD. */
  madeOn: string;
  dwellings?: number | null;
  /** The accepted site area in square metres. */
  areaM2?: number | null;
  /** Whether the qualifying reserved-matters history threshold is met; unknown is review. */
  reservedHistoryThresholdMet?: boolean | null;
  /** A possible exemption, reduction, mixed category or other non-standard case, in words. */
  nonStandard?: string;
};

const line = (description: string, quantity: number, unitPounds: number): FeeLine => ({
  description,
  quantity,
  unitMinor: unitPounds * 100,
  amountMinor: quantity * unitPounds * 100,
});

function capped(lines: FeeLine[], capPounds: number): FeeLine[] {
  const excess = lines.reduce((sum, entry) => sum + entry.amountMinor, 0) - capPounds * 100;
  return excess > 0 ? [...lines, { description: 'Statutory cap adjustment', quantity: 1, unitMinor: -excess, amountMinor: -excess }] : lines;
}

/** Whole started 0.1 ha units in an area given in hundredths of a square metre. */
const startedUnits = (hundredths: number): number => Math.floor((hundredths + 99_999) / 100_000);

export function fullLines(dwellings: number, schedule: FeeSchedule): FeeLine[] {
  const rates = schedule.full;
  if (dwellings < 10) return [line('Dwellings', dwellings, rates.perDwellingUnder10)];
  if (dwellings <= rates.middleUpTo) return [line('Dwellings', dwellings, rates.middleRate)];
  return capped([line('Upper-band base', 1, rates.upperBase), line('Excess dwellings', dwellings - rates.middleUpTo, rates.upperExcess)], rates.cap);
}

export function outlineLines(areaM2: number, schedule: FeeSchedule): FeeLine[] {
  const rates = schedule.outline;
  const hundredths = Math.round(areaM2 * 100);
  if (hundredths < 500_000) return [line('Started 0.1 ha units', startedUnits(hundredths), rates.smallPerUnit)];
  if (hundredths <= 2_500_000) return [line('Started 0.1 ha units', startedUnits(hundredths), rates.mediumPerUnit)];
  return capped(
    [line('Upper-band base', 1, rates.upperBase), line('Started excess 0.1 ha units', startedUnits(hundredths - 2_500_000), rates.upperExcessPerUnit)],
    rates.cap,
  );
}

export function scheduleFor(madeOn: string, schedules: readonly FeeSchedule[] = FEE_SCHEDULES): FeeSchedule | undefined {
  return schedules.find((schedule) => schedule.effectiveFrom <= madeOn && madeOn <= schedule.effectiveTo);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class FeeInputError extends Error {
  readonly field: string;
  constructor(message: string, field: string) {
    super(message);
    this.field = field;
  }
}

/**
 * The statutory fee, deterministically. `published` is the set of schedule
 * versions this company has published; a schedule outside it gives no payable
 * figure.
 */
export function quoteFee(input: FeeInput, published: ReadonlySet<string>, schedules: readonly FeeSchedule[] = FEE_SCHEDULES): FeeQuoteResult {
  if (!DATE.test(input.madeOn) || Number.isNaN(Date.parse(`${input.madeOn}T00:00:00Z`))) {
    throw new FeeInputError('The made date is a calendar date, YYYY-MM-DD, in Europe/London.', 'madeOn');
  }
  const base = { route: input.route, madeOn: input.madeOn, currency: 'GBP' as const };
  const review = (reasons: string[], schedule?: FeeSchedule): FeeQuoteResult => ({
    ...base,
    status: 'REVIEW_REQUIRED',
    amountMinor: null,
    ruleVersion: schedule?.version ?? null,
    sourceUrl: schedule?.sourceUrl ?? null,
    breakdown: [],
    reviewReasons: reasons,
  });

  const schedule = scheduleFor(input.madeOn, schedules);
  if (!schedule) return review(['No verified fee schedule covers this made date. Review it with the authority; no fee is calculated.']);
  if (input.nonStandard?.trim()) return review([`Non-standard case for review: ${input.nonStandard.trim()}.`], schedule);

  let lines: FeeLine[];
  if (input.route === 'full' || (input.route === 'reserved_matters' && input.reservedHistoryThresholdMet === false)) {
    const dwellings = input.dwellings;
    if (dwellings === null || dwellings === undefined) {
      return review(['The dwelling count is not known, so the fee cannot be calculated.'], schedule);
    }
    if (!Number.isInteger(dwellings) || dwellings < 1) throw new FeeInputError('A positive whole dwelling count is required.', 'dwellings');
    lines = fullLines(dwellings, schedule);
  } else if (input.route === 'outline') {
    const area = input.areaM2;
    if (area === null || area === undefined) return review(['The site area is not accepted, so the outline fee cannot be calculated.'], schedule);
    if (!Number.isFinite(area) || area <= 0) throw new FeeInputError('A positive site area in square metres is required.', 'areaM2');
    lines = outlineLines(area, schedule);
  } else if (input.route === 'reserved_matters') {
    if (input.reservedHistoryThresholdMet !== true) {
      return review(['Verify the reserved-matters application and payment history before a fee is calculated.'], schedule);
    }
    lines = [line('Reserved matters flat fee', 1, schedule.reservedMattersFlat)];
  } else if (input.route === 'condition_details') {
    lines = [line('Request fee', 1, schedule.conditionDetails)];
  } else if (input.route === 'section_73_major') {
    lines = [line('Request fee', 1, schedule.section73Major)];
  } else if (input.route === 'section_96a_non_householder') {
    lines = [line('Request fee', 1, schedule.section96aNonHouseholder)];
  } else {
    return review(['Unsupported fee route.'], schedule);
  }

  if (!published.has(schedule.version)) {
    return {
      ...review(
        [
          `The schedule ${schedule.version} has not been checked against its published source and published in this company. ` +
            'A planning rule approver publishes it in Rule versions; until then no fee is payable from it.',
        ],
        schedule,
      ),
      // What it would come to is shown, labelled, so the reviewer can check it — but not as payable.
      breakdown: lines,
    };
  }
  return {
    ...base,
    status: 'CALCULATED',
    amountMinor: lines.reduce((sum, entry) => sum + entry.amountMinor, 0),
    ruleVersion: schedule.version,
    sourceUrl: schedule.sourceUrl,
    breakdown: lines,
    reviewReasons: [],
  };
}
