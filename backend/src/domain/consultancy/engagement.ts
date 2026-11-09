/**
 * A consultancy engagement — the scoped record the agents work an appraisal
 * under, and the deterministic decision logic that governs it.
 *
 * This is the first vertical of the Autonomous Consultancy spec: the engagement
 * shape, the minimum-intake check (so missing inputs become recorded blockers
 * rather than silent gaps — spec test C02), the hard-constraint **screen** that
 * runs before any scoring (C06), and the proceed / hold / stop recommendation a
 * complete pack can carry (C12). The agent orchestration runtime, CDE ingestion
 * and buyer/bidder workspace isolation are later verticals; this is the honest,
 * testable core they build on.
 *
 * Everything here is pure and deterministic. A reasoning provider may later
 * narrate a recommendation, but the recommendation itself — and in particular
 * whether an option is *eligible* at all — is arithmetic over stated evidence,
 * never a model's opinion. The spec is categorical: "A weighted score cannot
 * clear a fatal constraint."
 */

import type { ServiceCaseResult } from './model.ts';

/** How the engagement entered the platform (spec §1). */
export type WorkRoute = 'COMMISSION_RFQ' | 'RESPOND_TO_RFQ' | 'DELIVER_COMMISSION' | 'REAPPRAISE';

/** What is contracted (spec §1). A business-case-only commission must ingest or flag prior feasibility. */
export type Assignment = 'FEASIBILITY_ONLY' | 'BUSINESS_CASE_ONLY' | 'COMBINED';

/** The appraisal profile (spec §5). Public keeps the Five Cases separate; private tracks incremental cash. */
export type BusinessCaseProfile = 'PUBLIC_FIVE_CASE' | 'PRIVATE_CLIENT';

/** Which side of a procurement the party sits on — the basis of buyer/bidder isolation (spec §1). */
export type PartySide = 'BUYER' | 'BIDDER' | 'CLIENT';

/**
 * The minimum intake the spec (§1) requires before work can be authorised. The
 * lead agent extracts these first and asks for the rest in one prioritised
 * request; anything unresolved is recorded as such rather than invented.
 */
export type MinimumIntake = {
  decisionRequested: string;
  decisionAuthority: string;
  deadline?: string;
  client: string;
  partySide: PartySide;
  assetOrService: string;
  location: string;
  currentStage?: string;
  expectedOutcome?: string;
  evidenceAccess?: string;
};

/** The intake fields the spec names as mandatory before execution is authorised. */
const REQUIRED_INTAKE: Array<{ key: keyof MinimumIntake; label: string }> = [
  { key: 'decisionRequested', label: 'the decision requested' },
  { key: 'decisionAuthority', label: 'the decision authority' },
  { key: 'client', label: 'the client and role' },
  { key: 'partySide', label: 'the party side (buyer, bidder or client)' },
  { key: 'assetOrService', label: 'the asset or service' },
  { key: 'location', label: 'the location / jurisdiction' },
];

/**
 * Which mandatory intake values are missing, as readable blockers. An empty list
 * means the engagement may be authorised to run; a non-empty list is exactly the
 * "single prioritised response for remaining blockers" the spec asks the lead
 * agent to request (test C02 — unaffected work proceeds, the gap is recorded).
 */
export function intakeBlockers(intake: Partial<MinimumIntake>): string[] {
  return REQUIRED_INTAKE.filter(({ key }) => {
    const value = intake[key];
    return value === undefined || value === null || String(value).trim() === '';
  }).map(({ label }) => `Awaiting ${label}`);
}

/** A hard constraint an option must satisfy to be eligible at all (consent, safety, deliverability). */
export type ConstraintCheck = { name: string; satisfied: boolean; note?: string };

/** An option put forward for appraisal, with its hard constraints and (optional) weighted score. */
export type AppraisalOption = {
  name: string;
  summary: string;
  constraints?: ConstraintCheck[];
  /** The weighted appraisal score. Meaningful only once the option is eligible. */
  score?: number;
};

/** An option after screening: eligible or excluded, with the constraints that excluded it named. */
export type ScreenedOption = AppraisalOption & { eligible: boolean; excludedBy: string[] };

/**
 * Screen options against their hard constraints **before** scoring. An option
 * failing any constraint is ineligible however high its score — the spec's
 * "A weighted score cannot clear a fatal constraint" (test C06). The option is
 * preserved, not deleted, so the pack can show *why* it was excluded.
 */
export function screenOptions(options: AppraisalOption[]): ScreenedOption[] {
  return options.map((option) => {
    const excludedBy = (option.constraints ?? [])
      .filter((c) => !c.satisfied)
      .map((c) => (c.note ? `${c.name}: ${c.note}` : c.name));
    return { ...option, eligible: excludedBy.length === 0, excludedBy };
  });
}

export type Recommendation = 'PROCEED' | 'HOLD' | 'STOP';

export type DecisionRecommendation = {
  recommendation: Recommendation;
  preferredOption?: string;
  rationale: string;
  /** Outstanding confirmations/authorities — the conditions a HOLD carries, or empty on a clean PROCEED. */
  conditions: string[];
};

/**
 * The proceed / hold / stop recommendation a complete pack carries.
 *
 * Deterministic and conservative, matching the spec's release rule that "A
 * complete pack can recommend hold or stop if that conclusion passes its own
 * evidence and release tests":
 *
 * - **STOP** when no option survives the hard-constraint screen — there is
 *   nothing left to recommend (ties test C06 to C12: a fatal constraint on the
 *   only option ends the case).
 * - **HOLD** when the preferred eligible option is not yet affordable within the
 *   funding available (a residual gap remains) or external confirmations are
 *   outstanding — the spec's conditional appraisal, carrying the conditions.
 * - **PROCEED** when an eligible option is affordable within the cap and nothing
 *   external is outstanding.
 */
export function recommendDecision(
  screened: ScreenedOption[],
  preferredModel: ServiceCaseResult | undefined,
  outstandingConfirmations: string[] = [],
  preferredOptionName?: string,
): DecisionRecommendation {
  const eligible = screened.filter((o) => o.eligible);

  if (eligible.length === 0) {
    const reasons = screened.flatMap((o) => o.excludedBy);
    return {
      recommendation: 'STOP',
      rationale:
        'No option clears the hard constraints, so none is eligible for appraisal. ' +
        (reasons.length > 0 ? `Excluded by: ${reasons.join('; ')}.` : '') +
        ' A weighted score cannot clear a fatal constraint; the case cannot proceed on the current evidence.',
      conditions: [],
    };
  }

  // The preferred option: the named one if it is eligible, else the highest-scored eligible option.
  const named = preferredOptionName ? eligible.find((o) => o.name === preferredOptionName) : undefined;
  const preferred =
    named ?? [...eligible].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]!;

  const conditions = [...outstandingConfirmations];
  const unaffordable = preferredModel !== undefined && (preferredModel.residualGapMinor ?? 0) > 0;
  if (unaffordable) {
    conditions.push(
      `Secure additional funding of ${preferredModel!.residualGapMinor} (residual gap beyond the subsidy available)`,
    );
  }

  if (conditions.length > 0) {
    return {
      recommendation: 'HOLD',
      preferredOption: preferred.name,
      rationale:
        `${preferred.name} is the preferred eligible option, but the decision is conditional: ` +
        `${conditions.length} item(s) remain outstanding. A conditional appraisal can complete while these are resolved.`,
      conditions,
    };
  }

  return {
    recommendation: 'PROCEED',
    preferredOption: preferred.name,
    rationale:
      `${preferred.name} is the preferred eligible option, is affordable within the funding available, ` +
      'and has no outstanding external confirmation. It is recommended for authorisation.',
    conditions: [],
  };
}
