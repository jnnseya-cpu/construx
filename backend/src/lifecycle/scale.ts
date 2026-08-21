/**
 * Scale — the one place the platform decides how big something is.
 *
 * The same operating system has to run a sole trader fitting a £3,000 bathroom
 * and a joint venture delivering a £2bn programme. That is not a matter of
 * hiding features: it is a matter of every threshold in the platform being
 * *relative* rather than absolute.
 *
 * An absolute threshold is always wrong at one end. "Enhanced scrutiny above
 * £250,000" is sensible for an £8m contractor, pointless for a £4bn one where
 * £250k is a rounding error, and unreachable for a £40k one that will never buy
 * a package that size. "Three quotes for every package" is good discipline on a
 * school and bureaucratic nonsense for a skip hire. A Construction Phase Plan,
 * a document control procedure and a programme baseline are all correct on a
 * hospital and all absurd on a two-day repair.
 *
 * So the rule this file exists to enforce is:
 *
 *   **Nothing in the platform hardcodes a money figure as a threshold.**
 *   Everything derives from the size of the project, the size of the business,
 *   or — where it matters most — the ratio between them.
 *
 * The ratio is the part people miss. A £400k package is routine for a £30m
 * contractor and a bet-the-company decision for a £600k one. Same package, and
 * the second business needs a different conversation about payment terms,
 * bonding and how much of the year's turnover is riding on one client paying.
 */

// --- Project scale -----------------------------------------------------------------

export type ProjectScale = 'MINOR' | 'SMALL' | 'MEDIUM' | 'MAJOR' | 'MEGA';

export const PROJECT_SCALE_ORDER: ProjectScale[] = ['MINOR', 'SMALL', 'MEDIUM', 'MAJOR', 'MEGA'];

export type ProjectBand = {
  scale: ProjectScale;
  label: string;
  /** Upper bound in minor units; the top band has none. */
  ceilingMinor: number | null;
  /** What work of this size actually looks like, so the band is checkable. */
  typical: string;
};

export const PROJECT_BANDS: ProjectBand[] = [
  { scale: 'MINOR', label: 'Under £25k', ceilingMinor: 25_000_00, typical: 'Repairs, a bathroom, a small domestic job — one contractor, days to weeks' },
  { scale: 'SMALL', label: '£25k–£500k', ceilingMinor: 500_000_00, typical: 'A house, a shop fit-out, a small civils job — a handful of packages' },
  { scale: 'MEDIUM', label: '£500k–£10m', ceilingMinor: 10_000_000_00, typical: 'A school, an office block, a treatment works — a full package list' },
  { scale: 'MAJOR', label: '£10m–£250m', ceilingMinor: 250_000_000_00, typical: 'A hospital, a highway scheme — multiple contractors and formal governance' },
  { scale: 'MEGA', label: 'Over £250m', ceilingMinor: null, typical: 'A programme, a power station, an infrastructure corridor' },
];

export function projectScale(valueMinor: number): ProjectScale {
  return (
    PROJECT_BANDS.find((b) => b.ceilingMinor !== null && valueMinor <= b.ceilingMinor)?.scale ??
    PROJECT_BANDS[PROJECT_BANDS.length - 1]!.scale
  );
}

export function projectBand(scale: ProjectScale): ProjectBand {
  return PROJECT_BANDS.find((b) => b.scale === scale)!;
}

/** True when `scale` has reached or passed `threshold` in the ordering. */
export function atLeastProject(scale: ProjectScale, threshold: ProjectScale): boolean {
  return PROJECT_SCALE_ORDER.indexOf(scale) >= PROJECT_SCALE_ORDER.indexOf(threshold);
}

// --- Organisation scale -------------------------------------------------------------

export type OrganisationScale = 'SOLE_TRADER' | 'MICRO' | 'SMALL' | 'MEDIUM' | 'LARGE' | 'TIER_1';

export const ORGANISATION_SCALE_ORDER: OrganisationScale[] = [
  'SOLE_TRADER',
  'MICRO',
  'SMALL',
  'MEDIUM',
  'LARGE',
  'TIER_1',
];

export type OrganisationBand = {
  scale: OrganisationScale;
  label: string;
  turnoverCeilingMinor: number | null;
  /**
   * How many supplier relationships this business can genuinely maintain.
   * Not a technical limit — a framework nobody reviews, visits or gives
   * feedback to is a list with a cover page, and relationship management is
   * the constraint everybody forgets when they set the target.
   */
  relationshipCapacity: number;
  /**
   * Sites running at the same time, typical for this band. This is the variable
   * that separates a large contractor from a Tier 1: they need the same three
   * quotes per package, but a Tier 1 needs them on twenty sites at once, and no
   * subcontractor can be on twenty of your sites at once.
   */
  typicalConcurrentProjects: number;
};

/**
 * The bands, from one person with a van to a Tier 1.
 *
 * A sole trader is a real user of this platform, not a rounding error below the
 * bottom band. Somebody turning over £40,000 still has to decide what to chase,
 * price it, buy materials, keep a record of what they did and get paid — which
 * is the same list as everybody else, at a size where getting it wrong ends the
 * business faster.
 */
export const ORGANISATION_BANDS: OrganisationBand[] = [
  { scale: 'SOLE_TRADER', label: 'Under £250k', turnoverCeilingMinor: 250_000_00, relationshipCapacity: 12, typicalConcurrentProjects: 1 },
  { scale: 'MICRO', label: '£250k–£5m', turnoverCeilingMinor: 5_000_000_00, relationshipCapacity: 30, typicalConcurrentProjects: 2 },
  { scale: 'SMALL', label: '£5m–£25m', turnoverCeilingMinor: 25_000_000_00, relationshipCapacity: 70, typicalConcurrentProjects: 4 },
  { scale: 'MEDIUM', label: '£25m–£100m', turnoverCeilingMinor: 100_000_000_00, relationshipCapacity: 140, typicalConcurrentProjects: 8 },
  { scale: 'LARGE', label: '£100m–£500m', turnoverCeilingMinor: 500_000_000_00, relationshipCapacity: 260, typicalConcurrentProjects: 18 },
  { scale: 'TIER_1', label: 'Over £500m', turnoverCeilingMinor: null, relationshipCapacity: 450, typicalConcurrentProjects: 35 },
];

export function organisationScale(annualTurnoverMinor: number): OrganisationScale {
  return (
    ORGANISATION_BANDS.find((b) => b.turnoverCeilingMinor !== null && annualTurnoverMinor <= b.turnoverCeilingMinor)?.scale ??
    ORGANISATION_BANDS[ORGANISATION_BANDS.length - 1]!.scale
  );
}

export function organisationBand(scale: OrganisationScale): OrganisationBand {
  return ORGANISATION_BANDS.find((b) => b.scale === scale)!;
}

// --- Proportionality ----------------------------------------------------------------

/**
 * Share of a year's turnover riding on one job.
 *
 * The single most useful ratio in a small contracting business, and the one an
 * absolute threshold can never express. Above 40% the job is not a project, it
 * is the year.
 */
export const EXPOSURE = {
  /** Above this share of turnover, one job carries the business. */
  bettingTheCompanyPercent: 40,
  /** Above this, the job is significant enough to change how it is governed. */
  materialPercent: 15,
} as const;

export type Proportionality = {
  projectScale: ProjectScale;
  organisationScale?: OrganisationScale;
  /**
   * Competitive quotes worth asking for at this size. One for a skip, three for
   * a package that matters. Asking three suppliers to price £400 of hire wastes
   * four people's time to save nothing.
   */
  quotesRequired: number;
  /** How hard to look at a supplier before buying from them. */
  scrutiny: 'LIGHT' | 'STANDARD' | 'ENHANCED';
  /**
   * Share of a year's turnover this job represents, where turnover is known.
   *
   * Annualised where the duration is known, because a £2bn programme delivered
   * over five years is £400m a year, not £2bn against one year's turnover.
   * Comparing a whole multi-year contract to a single year's revenue is how a
   * ratio that is meant to say "this job is the year" ends up saying 222%.
   */
  exposurePercent?: number;
  /** True when the exposure figure was annualised over a stated duration. */
  exposureAnnualised: boolean;
  /** True when one job is carrying the business. */
  bettingTheCompany: boolean;
  /**
   * Whether formal governance is proportionate: a programme baseline, document
   * control, a written cost report. On a two-day repair these are not light
   * governance, they are the whole job again in paperwork.
   */
  formalGovernance: boolean;
  /** Plain statement of why this project is treated the way it is. */
  rationale: string;
};

/**
 * Work out what proportionate looks like here.
 *
 * Takes the project value and, where it is known, the turnover of the business
 * buying. Both matter and they matter differently: the project's own size sets
 * how much process the work needs, and the ratio to turnover sets how much the
 * business has riding on it.
 */
export function proportionality(input: {
  projectValueMinor: number;
  annualTurnoverMinor?: number;
  /** Contract duration, so a multi-year programme is compared like for like. */
  durationWeeks?: number;
}): Proportionality {
  const scale = projectScale(input.projectValueMinor);
  const organisation = input.annualTurnoverMinor === undefined ? undefined : organisationScale(input.annualTurnoverMinor);

  // Annualise before comparing. A job running longer than a year contributes
  // only part of its value to any one year's revenue.
  const years = input.durationWeeks === undefined ? 1 : Math.max(1, input.durationWeeks / 52);
  const annualisedValue = input.projectValueMinor / years;
  const exposureAnnualised = years > 1;

  const exposurePercent =
    input.annualTurnoverMinor === undefined || input.annualTurnoverMinor <= 0
      ? undefined
      : Number(((annualisedValue / input.annualTurnoverMinor) * 100).toFixed(2));

  const bettingTheCompany = exposurePercent !== undefined && exposurePercent > EXPOSURE.bettingTheCompanyPercent;

  // Quotes scale with what is being bought, not with a policy somebody wrote
  // once for a different size of business.
  const quotesRequired = scale === 'MINOR' ? 1 : scale === 'SMALL' ? 2 : 3;

  // Scrutiny follows the same logic, with one override: a job that is a large
  // share of turnover gets looked at harder whatever its absolute size, because
  // the business cannot absorb it going wrong.
  let scrutiny: Proportionality['scrutiny'] = scale === 'MINOR' ? 'LIGHT' : atLeastProject(scale, 'MEDIUM') ? 'ENHANCED' : 'STANDARD';
  if (bettingTheCompany && scrutiny !== 'ENHANCED') scrutiny = 'ENHANCED';

  const formalGovernance = atLeastProject(scale, 'SMALL');

  const rationale = [
    `${projectBand(scale).label} project`,
    organisation ? `for a ${organisationBand(organisation).label} business` : undefined,
    exposurePercent !== undefined
      ? `at ${exposurePercent}% of annual turnover${exposureAnnualised ? ` (annualised over ${years.toFixed(1)} years)` : ''}`
      : undefined,
    bettingTheCompany ? '— one job carrying the year, so it is governed as such' : undefined,
  ]
    .filter(Boolean)
    .join(' ');

  return {
    projectScale: scale,
    organisationScale: organisation,
    quotesRequired,
    scrutiny,
    exposurePercent,
    exposureAnnualised,
    bettingTheCompany,
    formalGovernance,
    rationale,
  };
}
