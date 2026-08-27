import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import type { ScoredRisk } from '../engines/maths/risk.ts';
import { currentMilestoneProgramme, currentCostPlan } from './conceptcontrols.ts';

/**
 * C-WF-07 — risk, opportunity, safety and compliance initiation.
 *
 * What already exists and is emphatically not rebuilt: the risk register
 * itself. `engines/safety.registerRisk`, `rescoreRisk` and `setMitigation`
 * carry `RiskRegisterItem` with three-point cost and schedule impacts,
 * probability, inherent and residual exposure, and a severity normalised
 * against project value and duration. `engines/maths/risk.scoreRisk` is the
 * arithmetic and `contingencyRequirement` derives the allowance. The CDM
 * dutyholder documents are `domain/cdm.ts`. None of that is duplicated here.
 *
 * Two things were missing, and both are acts rather than records.
 *
 * **Which statutory gateways bind this project, confirmed by a competent
 * person.** The AI guardrail is explicit — an AI safety or legal
 * classification requires competent-person confirmation — so applicability is
 * an approval carrying a named confirmer and their basis, never a computed
 * field. And AC-C-WF-07-03 requires the applicable gateways to appear as
 * non-bypassable project milestones, so `complianceBlockedReason` checks the
 * concept programme actually carries a statutory milestone for each one. A
 * gateway confirmed as applicable and absent from the programme is a gateway
 * nobody has planned for.
 *
 * **The concept risk review, and what retained exposure was accepted.** A
 * register is a list until somebody with authority says which of it the project
 * is carrying. The review refuses while a critical risk has no owner or no
 * response — AC-C-WF-07-01 — and it reconciles the risk allowance against the
 * cost plan, which is AC-C-WF-07-02.
 *
 * **Double counting is the thing AC-C-WF-07-02 actually guards against.** The
 * commonest failure is a risk allowance in the cost plan *and* a contingency
 * line, both sized from the same register. The reconciliation here compares the
 * declared allowance against `RISK_ALLOWANCE` in the cost plan and reports the
 * difference rather than silently accepting either.
 */

/** The statutory regimes a project can fall under. Extended per jurisdiction pack. */
export const COMPLIANCE_REGIME = [
  'CDM_2015',
  'BUILDING_SAFETY_ACT_GATEWAY_1',
  'BUILDING_SAFETY_ACT_GATEWAY_2',
  'BUILDING_SAFETY_ACT_GATEWAY_3',
  'HIGHER_RISK_BUILDING',
  'ENVIRONMENTAL_PERMIT',
  'PLANNING_CONSENT',
  'LISTED_BUILDING_CONSENT',
  'COMAH',
  'RAIL_ROGS',
] as const;
export type ComplianceRegime = (typeof COMPLIANCE_REGIME)[number];

export type RegimeApplicability = {
  regime: ComplianceRegime;
  applicable: boolean;
  /** Why. A screening with no reasoning is a checkbox somebody ticked. */
  basis: string;
  /**
   * The milestone reference this gateway must appear as, when applicable.
   * AC-C-WF-07-03 — the gateway has to be a date on the programme, not a note.
   */
  milestoneRef?: string;
};

export type ComplianceApplicabilityState = {
  screeningId: string;
  projectId: string;
  version: number;
  regimes: readonly RegimeApplicability[];
  /** The competent person confirming. Not the same field as the actor. */
  confirmedByName: string;
  confirmedByRole: string;
  /** Their competence to make this classification. */
  competenceBasis: string;
  confirmedBy: string;
  confirmedAt: string;
  supersedes?: string;
};

export type ConceptRiskReviewState = {
  reviewId: string;
  projectId: string;
  version: number;
  /** What the register held at the moment of review. */
  risksReviewed: number;
  criticalRisks: number;
  inherentExposureMinor: number;
  residualExposureMinor: number;
  /** The allowance the project is carrying, as agreed at the review. */
  declaredAllowanceMinor: number;
  /** The RISK_ALLOWANCE line in the cost plan, for the reconciliation. */
  costPlanAllowanceMinor: number;
  reconciliationDifferenceMinor: number;
  retainedExposureNote: string;
  escalated: readonly string[];
  approvedBy: string;
  approvedAt: string;
  supersedes?: string;
};

function screeningsOf(ctx: EngineContext): ComplianceApplicabilityState[] {
  return ctx.ledger
    .list(ctx.projectId, 'ComplianceApplicability')
    .map((r) => r.state as unknown as ComplianceApplicabilityState)
    .sort((a, b) => a.version - b.version);
}

function reviewsOf(ctx: EngineContext): ConceptRiskReviewState[] {
  return ctx.ledger
    .list(ctx.projectId, 'ConceptRiskReview')
    .map((r) => r.state as unknown as ConceptRiskReviewState)
    .sort((a, b) => a.version - b.version);
}

export function currentComplianceScreening(ctx: EngineContext): ComplianceApplicabilityState | undefined {
  return screeningsOf(ctx).at(-1);
}
export function currentConceptRiskReview(ctx: EngineContext): ConceptRiskReviewState | undefined {
  return reviewsOf(ctx).at(-1);
}

/** The risk register, as the safety engine wrote it. Read, never re-derived. */
export function riskRegister(ctx: EngineContext): ScoredRisk[] {
  return ctx.ledger.list(ctx.projectId, 'RiskRegisterItem').map((r) => r.state as unknown as ScoredRisk);
}

/**
 * Confirm which statutory regimes apply.
 *
 * `confirmedByName`, `confirmedByRole` and `competenceBasis` are separate from
 * the acting user id on purpose. The AI guardrail says a safety or legal
 * classification needs competent-person confirmation, and "the person who
 * pressed the button" is not evidence of competence — the record has to say who
 * they are and why they may say it.
 */
export function confirmComplianceApplicability(
  ctx: EngineContext,
  input: {
    regimes: readonly RegimeApplicability[];
    confirmedByName: string;
    confirmedByRole: string;
    competenceBasis: string;
    evidenceHash: string;
  },
): { screeningId: string; version: number; applicable: number } {
  authorise(ctx, 'SAFETY_RAMS', 'A');

  if (input.regimes.length === 0) {
    throw new DomainError(
      'NOTHING_SCREENED',
      'A screening covering no regime says nothing. Record each regime considered, including those found ' +
        'not to apply — a regime absent from the list is one nobody thought about.',
      422,
    );
  }
  if (input.competenceBasis.trim() === '' || input.confirmedByName.trim() === '') {
    throw new DomainError(
      'COMPETENCE_REQUIRED',
      'Name the competent person confirming this classification and their basis for making it. A statutory ' +
        'applicability decision is a professional judgement, and the record has to say whose.',
      422,
    );
  }

  for (const regime of input.regimes) {
    if (regime.basis.trim() === '') {
      throw new DomainError(
        'BASIS_REQUIRED',
        `${regime.regime} is marked ${regime.applicable ? 'applicable' : 'not applicable'} with no reasoning. ` +
          'A screening with no basis is a checkbox somebody ticked.',
        422,
      );
    }
    if (regime.applicable && (regime.milestoneRef ?? '').trim() === '') {
      throw new DomainError(
        'GATEWAY_UNPLANNED',
        `${regime.regime} applies but names no programme milestone. AC-C-WF-07-03 requires an applicable ` +
          'statutory gateway to be a date somebody works to, not a note in a register.',
        422,
      );
    }
  }

  const evidence = registerEvidence(ctx, {
    type: 'COMPLIANCE_SCREENING',
    hash: input.evidenceHash,
    description: `Statutory applicability confirmed by ${input.confirmedByName} (${input.confirmedByRole})`,
  });

  const previous = currentComplianceScreening(ctx);
  const screeningId = ulid();
  const version = (previous?.version ?? 0) + 1;
  write(ctx, {
    eventType: 'COMPLIANCE_APPLICABILITY_CONFIRMED',
    entity: { refType: 'ComplianceApplicability', refId: screeningId },
    nextState: {
      screeningId,
      projectId: ctx.projectId,
      version,
      regimes: input.regimes,
      confirmedByName: input.confirmedByName,
      confirmedByRole: input.confirmedByRole,
      competenceBasis: input.competenceBasis,
      confirmedBy: ctx.auth.actorId,
      confirmedAt: new Date().toISOString(),
      supersedes: previous?.screeningId,
    } satisfies ComplianceApplicabilityState as unknown as Record<string, unknown>,
    evidenceRefs: [evidence],
  });

  return { screeningId, version, applicable: input.regimes.filter((r) => r.applicable).length };
}

/**
 * Applicable gateways that are not on the programme.
 *
 * AC-C-WF-07-03 in one function. A gateway confirmed as applicable, named
 * against a milestone reference, and absent from the concept programme — or
 * present but not marked statutory — is a gateway that can be bypassed by
 * anybody who resequences the programme without noticing.
 */
export function complianceBlockedReason(ctx: EngineContext): string | null {
  const screening = currentComplianceScreening(ctx);
  if (!screening) {
    return 'No statutory applicability screening has been confirmed. Nobody has said which regimes bind ' +
      'this project.';
  }

  const applicable = screening.regimes.filter((r) => r.applicable);
  if (applicable.length === 0) return null;

  const programme = currentMilestoneProgramme(ctx);
  if (!programme) {
    return `${applicable.length} statutory regime${applicable.length === 1 ? '' : 's'} apply and there is no ` +
      'concept programme for their gateways to appear on.';
  }

  const missing: string[] = [];
  const unmarked: string[] = [];
  for (const regime of applicable) {
    const milestone = programme.milestones.find((m) => m.reference === regime.milestoneRef);
    if (!milestone) missing.push(`${regime.regime} → ${regime.milestoneRef}`);
    else if (!milestone.statutory) unmarked.push(`${regime.regime} → ${milestone.reference}`);
  }

  if (missing.length > 0) {
    return (
      `${missing.length} applicable statutory gateway${missing.length === 1 ? '' : 's'} ` +
      `${missing.length === 1 ? 'is' : 'are'} not on the concept programme: ${missing.join(', ')}.`
    );
  }
  if (unmarked.length > 0) {
    return (
      `${unmarked.join(', ')} ${unmarked.length === 1 ? 'is' : 'are'} on the programme but not marked ` +
      'statutory, so nothing stops a resequence from moving past it.'
    );
  }
  return null;
}

/**
 * Why the concept risk review cannot be approved.
 *
 * AC-C-WF-07-01 in the form the exception control states it: a critical risk
 * without a named owner and an action blocks the gate.
 */
export function riskReviewBlockedReason(ctx: EngineContext): string | null {
  const register = riskRegister(ctx);
  if (register.length === 0) {
    return 'The risk register is empty. A concept risk review over nothing is a signature on an empty page.';
  }

  const critical = register.filter((r) => r.severity === 'CRITICAL' || r.severity === 'HIGH');
  const unowned = critical.filter((r) => (r.ownerPartyId ?? '').trim() === '');
  if (unowned.length > 0) {
    return (
      `${unowned.length} critical or high risk${unowned.length === 1 ? '' : 's'} ` +
      `(${unowned.map((r) => r.title).join('; ')}) ${unowned.length === 1 ? 'has' : 'have'} no named owner.`
    );
  }

  const unmitigated = critical.filter((r) => (r.mitigations ?? []).length === 0);
  if (unmitigated.length > 0) {
    return (
      `${unmitigated.length} critical or high risk${unmitigated.length === 1 ? '' : 's'} ` +
      `(${unmitigated.map((r) => r.title).join('; ')}) ${unmitigated.length === 1 ? 'has' : 'have'} no response. ` +
      'A risk with an owner and no action is a risk somebody has been made responsible for watching.'
    );
  }

  return null;
}

/** The RISK_ALLOWANCE and CONTINGENCY lines in the cost plan, in minor units. */
function costPlanAllowance(ctx: EngineContext): number {
  const plan = currentCostPlan(ctx);
  if (!plan) return 0;
  return plan.lines
    .filter((l) => l.category === 'RISK_ALLOWANCE')
    .reduce((sum, l) => sum + l.mostLikelyMinor, 0);
}

/**
 * Approve the concept risk review.
 *
 * The reconciliation against the cost plan is the point. AC-C-WF-07-02 asks
 * that the risk allowance reconciles without double counting, so the difference
 * between what the review says the project is carrying and what the cost plan
 * holds as `RISK_ALLOWANCE` is computed and refused above a tolerance. A
 * difference is not automatically double counting — but it is always somebody
 * having two different numbers for the same money.
 */
export function approveRiskReview(
  ctx: EngineContext,
  input: {
    declaredAllowanceMinor: number;
    retainedExposureNote: string;
    escalated?: readonly string[];
    /** Absolute tolerance on the reconciliation, in minor units. */
    reconciliationToleranceMinor?: number;
    evidenceHash: string;
  },
): {
  reviewId: string;
  version: number;
  residualExposureMinor: number;
  reconciliationDifferenceMinor: number;
} {
  authorise(ctx, 'RISK_REGISTER', 'A');

  const blocked = riskReviewBlockedReason(ctx);
  if (blocked) throw new DomainError('RISK_REVIEW_BLOCKED', blocked, 409);

  if (input.retainedExposureNote.trim() === '') {
    throw new DomainError(
      'RETAINED_EXPOSURE_UNSTATED',
      'State what exposure the project is retaining. A risk review that approves a register without saying ' +
        'what is being carried has approved nothing.',
      422,
    );
  }

  const planAllowance = costPlanAllowance(ctx);
  const difference = input.declaredAllowanceMinor - planAllowance;
  const tolerance = input.reconciliationToleranceMinor ?? 0;
  if (currentCostPlan(ctx) && Math.abs(difference) > tolerance) {
    throw new DomainError(
      'ALLOWANCE_UNRECONCILED',
      `The review declares an allowance of ${input.declaredAllowanceMinor} and the cost plan carries ` +
        `${planAllowance} under RISK_ALLOWANCE — a difference of ${difference}. Two numbers for the same ` +
        'money is how a contingency gets counted twice.',
      422,
    );
  }

  const register = riskRegister(ctx);
  const evidence = registerEvidence(ctx, {
    type: 'CONCEPT_RISK_REVIEW',
    hash: input.evidenceHash,
    description: `Concept risk review — ${register.length} risks, allowance ${input.declaredAllowanceMinor}`,
  });

  const previous = currentConceptRiskReview(ctx);
  const reviewId = ulid();
  const version = (previous?.version ?? 0) + 1;
  const residual = register.reduce((sum, r) => sum + (r.residual?.expectedCostMinor ?? 0), 0);

  write(ctx, {
    eventType: 'RISK_REVIEW_APPROVED',
    entity: { refType: 'ConceptRiskReview', refId: reviewId },
    nextState: {
      reviewId,
      projectId: ctx.projectId,
      version,
      risksReviewed: register.length,
      criticalRisks: register.filter((r) => r.severity === 'CRITICAL').length,
      inherentExposureMinor: register.reduce((sum, r) => sum + r.expectedCostMinor, 0),
      residualExposureMinor: residual,
      declaredAllowanceMinor: input.declaredAllowanceMinor,
      costPlanAllowanceMinor: planAllowance,
      reconciliationDifferenceMinor: difference,
      retainedExposureNote: input.retainedExposureNote,
      escalated: input.escalated ?? [],
      approvedBy: ctx.auth.actorId,
      approvedAt: new Date().toISOString(),
      supersedes: previous?.reviewId,
    } satisfies ConceptRiskReviewState as unknown as Record<string, unknown>,
    evidenceRefs: [evidence],
  });

  return { reviewId, version, residualExposureMinor: residual, reconciliationDifferenceMinor: difference };
}

export type CompliancePosition = {
  screening?: ComplianceApplicabilityState;
  applicableRegimes: string[];
  review?: ConceptRiskReviewState;
  risks: number;
  criticalRisks: number;
  unownedCritical: number;
  inherentExposureMinor: number;
  residualExposureMinor: number;
  costPlanAllowanceMinor: number;
  complianceBlocked: string | null;
  riskReviewBlocked: string | null;
};

/** The compliance and risk position, derived on every read. */
export function compliancePosition(ctx: EngineContext): CompliancePosition {
  authorise(ctx, 'RISK_REGISTER', 'R');

  const screening = currentComplianceScreening(ctx);
  const register = riskRegister(ctx);
  const critical = register.filter((r) => r.severity === 'CRITICAL' || r.severity === 'HIGH');

  return {
    screening,
    applicableRegimes: (screening?.regimes ?? []).filter((r) => r.applicable).map((r) => r.regime),
    review: currentConceptRiskReview(ctx),
    risks: register.length,
    criticalRisks: register.filter((r) => r.severity === 'CRITICAL').length,
    unownedCritical: critical.filter((r) => (r.ownerPartyId ?? '').trim() === '').length,
    inherentExposureMinor: register.reduce((sum, r) => sum + r.expectedCostMinor, 0),
    residualExposureMinor: register.reduce((sum, r) => sum + (r.residual?.expectedCostMinor ?? 0), 0),
    costPlanAllowanceMinor: costPlanAllowance(ctx),
    complianceBlocked: complianceBlockedReason(ctx),
    riskReviewBlocked: riskReviewBlockedReason(ctx),
  };
}
