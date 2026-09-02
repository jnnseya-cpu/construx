/**
 * Usage against entitlement, and what to propose about it.
 *
 * ## The discipline
 *
 * An expansion engine is a machine for generating reasons to charge a customer
 * more, and the ones that destroy a supplier relationship all share a shape:
 * the proposal is made because the vendor wants revenue, not because the
 * customer is short of something.
 *
 * So every proposal here is **derived from a limit the customer is actually
 * against**, and carries the measurement that produced it. A tenancy using 30%
 * of its seats generates nothing, however profitable an upgrade would be.
 *
 * Two rules follow from that and are enforced rather than intended:
 *
 * - **A proposal that would not help is not made.** Where a tenancy is already
 *   on the largest package, running out of seats is not an upsell — it is a
 *   fact to state and a conversation to have. Proposing an upgrade that does
 *   not exist wastes the customer's time and ours.
 * - **Downgrades are proposed too.** A tenancy paying for a package it uses a
 *   fraction of is an unhappy customer who has not noticed yet, and a platform
 *   that only ever proposes upward has told the reader exactly what the engine
 *   is for. This is also the cheapest retention there is: the customer who was
 *   told to spend less stays.
 */

export type EntitlementUse = {
  /** What is limited: seats, storage, AI allowance, projects. */
  resource: string;
  used: number;
  /** Null where the package caps nothing — an uncapped resource cannot be exceeded. */
  limit: number | null;
  unit: string;
};

/** Against the ceiling. Above this, a customer is about to hit a wall. */
export const PRESSURE_AT = 0.85;

/** Well under. Below this, sustained, the customer is paying for air. */
export const SLACK_UNDER = 0.35;

export type Proposal = {
  kind: 'EXPAND' | 'REDUCE' | 'NOTHING_TO_PROPOSE';
  resource: string;
  /** The measurement, always, so nobody has to take the proposal on trust. */
  measurement: string;
  finding: string;
  /** What the customer should do, in their terms. */
  action: string;
  /** Ordering only. Higher is more pressing. */
  urgency: number;
};

export type ExpansionPosition = {
  tenantId: string;
  tier: string;
  /** Whether a larger package exists at all. Drives whether pressure is an upsell. */
  largerPackageExists: boolean;
  proposals: Proposal[];
  /** One sentence for a console header. */
  summary: string;
};

function ratio(use: EntitlementUse): number | null {
  if (use.limit === null || use.limit === 0) return null;
  return use.used / use.limit;
}

export function expansionPosition(input: {
  tenantId: string;
  tier: string;
  largerPackageExists: boolean;
  uses: readonly EntitlementUse[];
  /**
   * Whether the tenancy has been on this package long enough for slack to mean
   * anything. A company three weeks into a subscription has not finished
   * onboarding, and telling them to downgrade is telling them to give up.
   */
  settledIn: boolean;
}): ExpansionPosition {
  const proposals: Proposal[] = [];

  for (const use of input.uses) {
    const share = ratio(use);
    if (share === null) continue;

    if (share >= 1) {
      proposals.push({
        kind: input.largerPackageExists ? 'EXPAND' : 'NOTHING_TO_PROPOSE',
        resource: use.resource,
        measurement: `${use.used} of ${use.limit} ${use.unit} (${Math.round(share * 100)}%)`,
        finding: input.largerPackageExists
          ? `${use.resource} is at its limit. The next thing that needs one will be refused.`
          : `${use.resource} is at its limit and ${input.tier} is the largest package there is. There is no upgrade ` +
            'to sell you; this needs a conversation about how the platform is being used.',
        action: input.largerPackageExists
          ? `Move to a package with more ${use.unit}, or release ${use.unit} that are not being used.`
          : `Release ${use.unit} that are not in use, or contact us — the answer here is not a bigger package.`,
        urgency: 100,
      });
      continue;
    }

    if (share >= PRESSURE_AT) {
      proposals.push({
        kind: input.largerPackageExists ? 'EXPAND' : 'NOTHING_TO_PROPOSE',
        resource: use.resource,
        measurement: `${use.used} of ${use.limit} ${use.unit} (${Math.round(share * 100)}%)`,
        finding: `${use.resource} is close to its limit. This is a heads-up rather than a problem yet.`,
        action: input.largerPackageExists
          ? `A larger package would clear the ceiling before it is reached.`
          : `Keep an eye on it; there is no larger package to move to.`,
        urgency: 60,
      });
      continue;
    }

    if (input.settledIn && share <= SLACK_UNDER) {
      proposals.push({
        kind: 'REDUCE',
        resource: use.resource,
        measurement: `${use.used} of ${use.limit} ${use.unit} (${Math.round(share * 100)}%)`,
        finding:
          `You are paying for ${use.limit} ${use.unit} and using ${use.used}. On a settled subscription that is ` +
          'money going nowhere.',
        action: `A smaller package would cost less and would still cover what you use.`,
        urgency: 30,
      });
    }
  }

  proposals.sort((a, b) => b.urgency - a.urgency);

  const expansions = proposals.filter((proposal) => proposal.kind === 'EXPAND').length;
  const reductions = proposals.filter((proposal) => proposal.kind === 'REDUCE').length;

  return {
    tenantId: input.tenantId,
    tier: input.tier,
    largerPackageExists: input.largerPackageExists,
    proposals,
    summary:
      proposals.length === 0
        ? 'Everything is comfortably within its limits. Nothing to propose.'
        : `${expansions} thing${expansions === 1 ? '' : 's'} under pressure, ${reductions} being paid for and not used.`,
  };
}
