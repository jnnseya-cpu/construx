import { DomainError } from '../core/errors.ts';

/**
 * Cross-tenancy benchmarking: telling a customer how they compare, without
 * telling anybody anything about anyone.
 *
 * ## Why this is the most dangerous file in the commercial module
 *
 * Every other feature here operates on one tenancy's own data. This one reads
 * across all of them, and a benchmark is a **disclosure mechanism wearing a
 * statistic's clothes**. Two failures are easy and both are fatal:
 *
 * 1. **Publishing a cohort too small to hide in.** "The average margin among
 *    water framework contractors in the North West" is a useful figure across
 *    forty companies and a direct disclosure of one competitor's margin across
 *    two. Nobody has to be named for the disclosure to happen — the cohort
 *    definition names them.
 * 2. **Publishing without consent.** A customer's operational data is theirs.
 *    Its aggregate is still derived from theirs, and "it was anonymised" is not
 *    a lawful basis, it is a technique.
 *
 * Both are refused here rather than warned about, and the refusal is the
 * feature: a cohort that cannot be published safely produces a stated refusal
 * with a reason, never a quietly thinner number.
 *
 * ## k-anonymity, and why k alone is not enough
 *
 * `MINIMUM_COHORT` is the floor on how many *contributors* a published figure
 * must rest on. Below it, nothing is published.
 *
 * But a cohort of five where one contributor is 94% of the total is a cohort of
 * one wearing a five. The mean discloses the dominant member almost exactly,
 * and k-anonymity says nothing about it — which is why `MAXIMUM_DOMINANCE`
 * exists alongside k and is checked separately. A benchmark that passed k and
 * failed dominance is the one that leaks in practice.
 *
 * ## What is deliberately not built
 *
 * No minimum, maximum or count-by-band. A minimum is one contributor's figure,
 * published exactly, and dressing it as "the lowest in the cohort" does not
 * change what it is. Percentiles are excluded for the same reason at small n:
 * at k=5 the 20th percentile *is* a member. Only the mean and the median are
 * published, and the median only above twice k, where it is not simply the
 * middle contributor's own number.
 */

/**
 * The smallest cohort that may be published.
 *
 * Five is the floor that is defensible rather than the smallest that feels
 * comfortable: at four, a contributor who knows the mean and their own figure
 * and can identify two of the others solves for the fourth.
 */
export const MINIMUM_COHORT = 5;

/**
 * No single contributor may be more than this share of the measured total.
 *
 * At 40%, a dominant member's own figure is still meaningfully obscured by the
 * rest. Above it, the aggregate is mostly a report about them.
 */
export const MAXIMUM_DOMINANCE = 0.4;

/** Above this many contributors, a median is safe to publish. */
export const MEDIAN_AT = MINIMUM_COHORT * 2;

export type BenchmarkContribution = {
  /** The contributing tenancy. Never published — used to count and to check consent. */
  tenantId: string;
  value: number;
  /** Whether this tenancy has recorded consent to contribute to benchmarks. */
  consented: boolean;
};

export type BenchmarkRefusal = {
  published: false;
  metric: string;
  cohort: string;
  reason: 'COHORT_TOO_SMALL' | 'ONE_CONTRIBUTOR_DOMINATES' | 'NO_CONSENTED_CONTRIBUTIONS';
  /** In the words a customer should be shown, saying what would change it. */
  finding: string;
  /** How many consented contributors there are. Never the identity of any. */
  contributors: number;
};

export type BenchmarkPublication = {
  published: true;
  metric: string;
  cohort: string;
  contributors: number;
  mean: number;
  /** Absent below `MEDIAN_AT`, where the middle value is a member's own figure. */
  median?: number;
  /** What this figure does and does not permit, carried with the number. */
  basis: string;
};

export type BenchmarkResult = BenchmarkPublication | BenchmarkRefusal;

/**
 * Aggregate one cohort, or refuse to.
 *
 * Consent is filtered **first**, and everything downstream counts only the
 * consented set. Checking k against all contributors and then averaging only
 * the consenting ones would report a cohort of forty resting on three, which is
 * the failure that looks safest in a code review.
 */
export function benchmark(input: {
  metric: string;
  cohort: string;
  contributions: readonly BenchmarkContribution[];
}): BenchmarkResult {
  const consented = input.contributions.filter((contribution) => contribution.consented);

  if (consented.length === 0) {
    return {
      published: false,
      metric: input.metric,
      cohort: input.cohort,
      reason: 'NO_CONSENTED_CONTRIBUTIONS',
      finding:
        'No company in this cohort has consented to contribute to benchmarks, so there is nothing to compare against. ' +
        'Consent is given per tenancy and can be withdrawn at any time.',
      contributors: 0,
    };
  }

  if (consented.length < MINIMUM_COHORT) {
    return {
      published: false,
      metric: input.metric,
      cohort: input.cohort,
      reason: 'COHORT_TOO_SMALL',
      finding:
        `A benchmark needs at least ${MINIMUM_COHORT} consenting companies before it can be published, and this ` +
        `cohort has ${consented.length}. Below that, the average is close enough to one company's own figure to ` +
        'disclose it — nobody has to be named for that to happen, because the cohort definition names them.',
      contributors: consented.length,
    };
  }

  const values = consented.map((contribution) => contribution.value);
  const total = values.reduce((sum, value) => sum + value, 0);

  // Dominance is measured against the total of absolute values, so a cohort
  // containing a large negative figure — a loss-making project — cannot cancel
  // itself out into a total small enough to make every share look modest.
  const magnitude = values.reduce((sum, value) => sum + Math.abs(value), 0);
  if (magnitude > 0) {
    const largest = Math.max(...values.map((value) => Math.abs(value)));
    if (largest / magnitude > MAXIMUM_DOMINANCE) {
      return {
        published: false,
        metric: input.metric,
        cohort: input.cohort,
        reason: 'ONE_CONTRIBUTOR_DOMINATES',
        finding:
          `One company accounts for more than ${Math.round(MAXIMUM_DOMINANCE * 100)}% of this cohort's total, so the ` +
          'average would be mostly a report about them. The cohort is large enough to publish and the distribution ' +
          'is not, which is a distinction the count on its own cannot make.',
        contributors: consented.length,
      };
    }
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return {
    published: true,
    metric: input.metric,
    cohort: input.cohort,
    contributors: consented.length,
    mean: total / consented.length,
    ...(consented.length >= MEDIAN_AT
      ? {
          median:
            sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!,
        }
      : {}),
    basis:
      `Computed across ${consented.length} companies that have each consented to contribute. No company is named, no ` +
      'minimum or maximum is published — either would be one company’s own figure — and the cohort is checked both ' +
      'for size and for whether any one member dominates it.',
  };
}

export type BenchmarkConsent = {
  tenantId: string;
  /** True only where somebody with authority said yes. Absence is not consent. */
  granted: boolean;
  decidedAt: string;
  decidedBy: string;
  /** What they were told they were agreeing to, kept with the decision. */
  scope: string;
};

/** What a tenancy is agreeing to. Stored with the consent so it cannot be restated later. */
export const CONSENT_SCOPE =
  'Contribute this company’s aggregate operational figures to cross-company benchmarks. Only averages across at ' +
  `least ${MINIMUM_COHORT} consenting companies are ever published, no company is named, no individual figure is ` +
  'shown, and consent can be withdrawn at any time with immediate effect on future benchmarks.';

/**
 * Read a benchmark against the requesting tenancy's own figure.
 *
 * A tenancy that has **not** consented can still be told where it stands: it is
 * their own number being positioned against a published aggregate, and nothing
 * about them enters the aggregate. Refusing to answer would be a dark pattern —
 * withholding a reading to extract consent for a contribution.
 */
export function positionAgainst(result: BenchmarkResult, ownValue: number): {
  ownValue: number;
  comparison?: { mean: number; differenceFromMean: number; standing: 'ABOVE' | 'AT' | 'BELOW' };
  finding: string;
} {
  if (!result.published) {
    return { ownValue, finding: result.finding };
  }
  const difference = ownValue - result.mean;
  // A hair either side of the mean is noise, not a standing.
  const tolerance = Math.abs(result.mean) * 0.02;
  return {
    ownValue,
    comparison: {
      mean: result.mean,
      differenceFromMean: difference,
      standing: Math.abs(difference) <= tolerance ? 'AT' : difference > 0 ? 'ABOVE' : 'BELOW',
    },
    finding: `Measured against ${result.contributors} consenting companies. ${result.basis}`,
  };
}

/** Refuse a cohort definition narrow enough to name somebody by description alone. */
export function assertCohortIsGeneral(cohort: string): void {
  // A free-text cohort is how "UK contractors" becomes "water contractors in
  // Rochdale with a turnover between £8m and £9m", which identifies one company
  // without naming it and passes every count-based check.
  const segments = cohort.split('·').map((segment) => segment.trim()).filter(Boolean);
  if (segments.length > 3) {
    throw new DomainError(
      'BENCHMARK_COHORT_TOO_NARROW',
      `A cohort may be defined by at most three characteristics; this one uses ${segments.length}. Each further ` +
        'characteristic narrows the group towards a single identifiable company, and a description precise enough to ' +
        'name somebody discloses them whether or not it uses their name.',
    );
  }
}
