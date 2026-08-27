import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, write, type EngineContext } from '../engines/context.ts';
import type { TrainingSessionState } from './commissioningclose.ts';

/**
 * H-WF-06 — operator training, competence and operational readiness.
 *
 * CM-WF-08 already records a delivered session against the information it taught
 * at the revision taught, and invalidates every session when that information is
 * superseded. That is AC-H-WF-06-02 and the second exception control, already
 * built, and this module reads those sessions rather than keeping a second set.
 *
 * What is new is the three things CM-WF-08 does not answer.
 *
 * **Attendance is not competence.** The first exception control, and the one
 * every training record in construction gets wrong. A signature on a sheet
 * proves somebody was in the room. Where the needs analysis says an assessment
 * is required, the assessment is a separate act by a separate assessor, with a
 * method and evidence — and a person marked present is *not yet competent* until
 * it happens.
 *
 * **AC-H-WF-06-01: every operational role covered, or a controlled gap plan.**
 * The question at handover is not "was training delivered" but "is there a
 * competent named person for every role this building needs to run". Where there
 * is not, the honest answer is a gap plan with an interim arrangement, an owner
 * and a date — not an empty column.
 *
 * **AC-H-WF-06-03: a failed or missed assessment is a handover blocker.** Where
 * the role is configured as required, somebody who has not been assessed
 * competent is a person the building cannot be operated by, and readiness says
 * so rather than reporting a training percentage.
 *
 * **One honest limit.** The specification asks for personal competence data to
 * carry restricted access and retention. The platform's sensitivity ladder is
 * PUBLIC, INTERNAL, SAFETY_L2, COMMERCIAL_L3 and LEGAL_L4 — it has **no
 * personal-data tier**. A competence assessment is classified `SAFETY_L2`, which
 * is a real restriction and the nearest one available, but it is not a
 * purpose-built personal-data control and is not claimed as one. The retention
 * half is not implemented at all.
 */

export type RequiredCompetence = {
  role: string;
  /** How many competent people the operating model needs in this role. */
  headcountRequired: number;
  competences: string[];
  /** Whether a signature on an attendance sheet is enough. Usually it is not. */
  assessmentRequired: boolean;
  /** Whether the role is one the building cannot be operated without. */
  critical: boolean;
};

export type TrainingNeedsState = {
  needsId: string;
  reference: string;
  operatingModel: string;
  roles: RequiredCompetence[];
  definedBy: string;
  definedAt: string;
};

export type CompetenceAssessment = {
  assessmentId: string;
  person: string;
  employer: string;
  role: string;
  sessionReference: string;
  method: 'PRACTICAL_DEMONSTRATION' | 'WRITTEN' | 'OBSERVATION';
  result: 'COMPETENT' | 'NOT_YET_COMPETENT';
  assessedBy: string;
  evidence: string;
  assessedAt: string;
};

export type GapPlan = {
  role: string;
  gap: string;
  /** What happens in the meantime, which is the part that makes it controlled. */
  interimArrangement: string;
  owner: string;
  by: string;
};

function needsOf(ctx: EngineContext): TrainingNeedsState | undefined {
  return ctx.ledger
    .list(ctx.projectId, 'TrainingNeeds')
    .map((record) => record.state as unknown as TrainingNeedsState)
    .pop();
}

function assessments(ctx: EngineContext): CompetenceAssessment[] {
  return ctx.ledger
    .list(ctx.projectId, 'CompetenceAssessment')
    .map((record) => record.state as unknown as CompetenceAssessment);
}

function sessions(ctx: EngineContext): TrainingSessionState[] {
  return ctx.ledger
    .list(ctx.projectId, 'TrainingSession')
    .map((record) => record.state as unknown as TrainingSessionState);
}

function gapPlans(ctx: EngineContext): GapPlan[] {
  return ctx.ledger.list(ctx.projectId, 'TrainingGapPlan').map((record) => record.state as unknown as GapPlan);
}

/** Define what the operating model needs, role by role. */
export function defineTrainingNeeds(
  ctx: EngineContext,
  input: { reference: string; operatingModel: string; roles: RequiredCompetence[]; definedBy: string },
): { needsId: string; roles: number } {
  authorise(ctx, 'HANDOVER_OM', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (!input.reference.trim() || input.operatingModel.trim().length < 10) {
    throw new DomainError(
      'OPERATING_MODEL_REQUIRED',
      'Describe how the building will actually be run — in-house, contracted out, or a mixture. The training a building ' +
        'needs depends entirely on who is going to be operating it.',
    );
  }
  if (input.roles.length === 0) {
    throw new DomainError('NO_ROLES', 'A needs analysis with no roles in it says the building runs itself.');
  }
  for (const role of input.roles) {
    if (!role.role.trim() || role.competences.length === 0) {
      throw new DomainError(
        'ROLE_INCOMPLETE',
        `${role.role || 'A role'} names no competences. "Trained on the ventilation" is not a competence anybody can be ` +
          'assessed against.',
      );
    }
    if (role.headcountRequired <= 0) {
      throw new DomainError(
        'HEADCOUNT_REQUIRED',
        `${role.role} needs at least one competent person, or it is not a role the building depends on.`,
      );
    }
  }
  if (!input.definedBy.trim()) throw new DomainError('NEEDS_UNSIGNED', 'Name who defined them.');

  const needsId = ulid();

  write(ctx, {
    eventType: 'TRAINING_NEEDS_DEFINED',
    entity: { refType: 'TrainingNeeds', refId: needsId },
    nextState: {
      needsId,
      projectId: ctx.projectId,
      reference: input.reference,
      operatingModel: input.operatingModel,
      roles: input.roles,
      definedBy: input.definedBy,
      definedAt: new Date().toISOString(),
    },
  });

  return { needsId, roles: input.roles.length };
}

/**
 * Assess a person against the competence the role requires.
 *
 * A separate act by a separate assessor, because attendance is not competence.
 * The result is recorded even when it is `NOT_YET_COMPETENT` — that is the
 * finding, and a training record that only holds passes describes a different
 * building.
 */
export function assessCompetence(
  ctx: EngineContext,
  input: {
    person: string;
    employer: string;
    role: string;
    sessionReference: string;
    method: CompetenceAssessment['method'];
    result: CompetenceAssessment['result'];
    assessedBy: string;
    evidence: string;
  },
): { assessmentId: string; result: string } {
  // SAFETY_L2 is the nearest restriction the ladder offers; see the module doc.
  authorise(ctx, 'HANDOVER_OM', 'U', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'SAFETY_L2' });

  if (!input.person.trim() || !input.employer.trim() || !input.role.trim()) {
    throw new DomainError(
      'PERSON_REQUIRED',
      'Name the person, who employs them and the role they are assessed for. A competence record about nobody in ' +
        'particular cannot be relied on by anybody.',
    );
  }
  if (!input.assessedBy.trim()) {
    throw new DomainError(
      'ASSESSOR_REQUIRED',
      'Name the assessor. The specification is explicit that an authorised assessor records the result and the platform ' +
        'never certifies competence.',
    );
  }
  if (input.assessedBy === input.person) {
    throw new DomainError(
      'SELF_ASSESSED',
      `${input.person} cannot assess their own competence. That is not an assessment, it is a declaration.`,
    );
  }
  if (input.evidence.trim().length < 10) {
    throw new DomainError(
      'EVIDENCE_REQUIRED',
      'Record what the assessment consisted of. "Assessed competent" with nothing behind it is the same sentence whether ' +
        'anybody was assessed or not.',
    );
  }

  const session = sessions(ctx).find((entry) => entry.reference === input.sessionReference);
  if (!session) {
    throw new DomainError(
      'SESSION_NOT_FOUND',
      `No training session ${input.sessionReference}. An assessment hangs off the session it followed, which is what ties ` +
        'it to the revision that was taught.',
      404,
    );
  }
  if (session.status === 'INVALIDATED') {
    throw new DomainError(
      'SESSION_INVALIDATED',
      `${input.sessionReference} was delivered against information that has since been superseded. Assessing somebody on ` +
        'a building that no longer exists proves nothing about the one that does.',
    );
  }

  const assessmentId = ulid();

  write(ctx, {
    eventType: 'COMPETENCE_ASSESSED',
    entity: { refType: 'CompetenceAssessment', refId: assessmentId },
    nextState: {
      assessmentId,
      projectId: ctx.projectId,
      person: input.person,
      employer: input.employer,
      role: input.role,
      sessionReference: input.sessionReference,
      method: input.method,
      result: input.result,
      assessedBy: input.assessedBy,
      evidence: input.evidence,
      assessedAt: new Date().toISOString(),
    },
  });

  return { assessmentId, result: input.result };
}

/** Record a controlled gap plan for a role the project cannot cover. */
export function recordGapPlan(
  ctx: EngineContext,
  input: { role: string; gap: string; interimArrangement: string; owner: string; by: string },
): { role: string } {
  authorise(ctx, 'HANDOVER_OM', 'A', { lifecyclePhase: currentPhase(ctx) });

  if (input.gap.trim().length < 10) throw new DomainError('GAP_UNDESCRIBED', 'Say what is missing.');
  if (input.interimArrangement.trim().length < 15) {
    throw new DomainError(
      'INTERIM_REQUIRED',
      'State what happens in the meantime. That is the part that makes it a controlled gap rather than a gap — somebody ' +
        'still has to operate the building on Monday.',
    );
  }
  if (!input.owner.trim() || Number.isNaN(Date.parse(input.by))) {
    throw new DomainError('GAP_UNOWNED', 'A gap plan carries an owner and the date the gap closes by.');
  }

  const planId = `${ctx.projectId}-${input.role}`;

  write(ctx, {
    eventType: 'TRAINING_GAP_PLANNED',
    entity: { refType: 'TrainingGapPlan', refId: planId },
    nextState: {
      planId,
      projectId: ctx.projectId,
      role: input.role,
      gap: input.gap,
      interimArrangement: input.interimArrangement,
      owner: input.owner,
      by: input.by,
      recordedBy: ctx.auth.actorId,
      recordedAt: new Date().toISOString(),
    },
  });

  return { role: input.role };
}

/** Require retraining for a role, where a change has invalidated what was taught. */
export function requireRetraining(
  ctx: EngineContext,
  input: { role: string; reason: string; owner: string; by: string },
): { role: string } {
  authorise(ctx, 'HANDOVER_OM', 'U', { lifecyclePhase: currentPhase(ctx) });

  if (input.reason.trim().length < 10) {
    throw new DomainError('REASON_REQUIRED', 'Say what changed. It is what the retraining has to cover.');
  }
  if (!input.owner.trim() || Number.isNaN(Date.parse(input.by))) {
    throw new DomainError('RETRAINING_UNOWNED', 'Retraining carries an owner and a date.');
  }

  const obligationId = ulid();

  write(ctx, {
    eventType: 'RETRAINING_REQUIRED',
    entity: { refType: 'RetrainingObligation', refId: obligationId },
    nextState: {
      obligationId,
      projectId: ctx.projectId,
      role: input.role,
      reason: input.reason,
      owner: input.owner,
      by: input.by,
      status: 'OUTSTANDING',
      raisedBy: ctx.auth.actorId,
      raisedAt: new Date().toISOString(),
    },
  });

  return { role: input.role };
}

// --- Readiness --------------------------------------------------------------

export type RoleCoverage = {
  role: string;
  critical: boolean;
  headcountRequired: number;
  /** People assessed competent, or attended where no assessment is required. */
  competent: string[];
  /** Present but not yet assessed competent, where the role requires it. */
  awaitingAssessment: string[];
  notYetCompetent: string[];
  covered: boolean;
  gapPlan?: GapPlan;
};

/**
 * Who can actually run the building.
 *
 * Derived on every read from the sessions, the assessments and the gap plans. A
 * stored readiness figure would survive the supersession that invalidated the
 * training it was computed from.
 */
export function roleCoverage(ctx: EngineContext): RoleCoverage[] {
  const needs = needsOf(ctx);
  if (!needs) return [];

  const live = sessions(ctx).filter((session) => session.status !== 'INVALIDATED');
  const assessed = assessments(ctx);
  const plans = new Map(gapPlans(ctx).map((plan) => [plan.role, plan]));

  return needs.roles.map((role) => {
    const attended = new Set(
      live
        .filter((session) => session.role === role.role)
        .flatMap((session) => session.attendees.map((attendee) => attendee.name)),
    );
    const mine = assessed.filter((entry) => entry.role === role.role);
    const competentByAssessment = new Set(
      mine.filter((entry) => entry.result === 'COMPETENT').map((entry) => entry.person),
    );
    const notYetCompetent = [
      ...new Set(
        mine
          .filter((entry) => entry.result === 'NOT_YET_COMPETENT' && !competentByAssessment.has(entry.person))
          .map((entry) => entry.person),
      ),
    ];

    // Attendance is competence only where the needs analysis says no assessment
    // is required. Everywhere else a signature on a sheet proves somebody was in
    // the room.
    const competent = role.assessmentRequired
      ? [...competentByAssessment]
      : [...new Set([...attended, ...competentByAssessment])];
    const awaitingAssessment = role.assessmentRequired
      ? [...attended].filter((person) => !competentByAssessment.has(person) && !notYetCompetent.includes(person))
      : [];

    const gapPlan = plans.get(role.role);

    return {
      role: role.role,
      critical: role.critical,
      headcountRequired: role.headcountRequired,
      competent,
      awaitingAssessment,
      notYetCompetent,
      covered: competent.length >= role.headcountRequired || Boolean(gapPlan),
      gapPlan,
    };
  });
}

/**
 * Accept that the operator is ready to run the building.
 *
 * AC-H-WF-06-01 as a refusal: a critical role with no competent named person and
 * no gap plan means the building cannot be operated, whatever percentage of
 * training was delivered.
 */
export function acceptOperatorReadiness(
  ctx: EngineContext,
  input: { acceptedBy: string; forOperator: string; supportPlan: string },
): { rolesCovered: number; gapPlans: number } {
  authorise(ctx, 'HANDOVER_OM', 'A', { lifecyclePhase: currentPhase(ctx) });

  const needs = needsOf(ctx);
  if (!needs) {
    throw new DomainError(
      'NO_NEEDS_ANALYSIS',
      'No training needs have been defined, so there is nothing to be ready against.',
    );
  }
  if (!input.acceptedBy.trim() || !input.forOperator.trim()) {
    throw new DomainError('ACCEPTANCE_UNSIGNED', 'Name the person accepting readiness and the operator they act for.');
  }
  if (input.supportPlan.trim().length < 15) {
    throw new DomainError(
      'SUPPORT_PLAN_REQUIRED',
      'State the outstanding support arrangement. Nobody runs a new building unaided in the first month, and a readiness ' +
        'acceptance that pretends otherwise is one the operator withdraws in week two.',
    );
  }

  const coverage = roleCoverage(ctx);
  const uncovered = coverage.filter((role) => role.critical && !role.covered);
  if (uncovered.length > 0) {
    const first = uncovered[0]!;
    throw new DomainError(
      'ROLE_NOT_COVERED',
      `${uncovered.map((role) => role.role).join(', ')} ${uncovered.length === 1 ? 'has' : 'have'} no competent named ` +
        `person and no gap plan. ${first.role} needs ${first.headcountRequired} and has ${first.competent.length}` +
        (first.awaitingAssessment.length > 0
          ? `, with ${first.awaitingAssessment.length} who attended and have not been assessed.`
          : '.'),
    );
  }

  const readinessId = ulid();

  write(ctx, {
    eventType: 'OPERATOR_READY',
    entity: { refType: 'OperatorReadiness', refId: readinessId },
    nextState: {
      readinessId,
      projectId: ctx.projectId,
      acceptedBy: input.acceptedBy,
      forOperator: input.forOperator,
      supportPlan: input.supportPlan,
      // The coverage as it stood at acceptance, so what was accepted is
      // recoverable even after somebody leaves.
      coverage: coverage.map((role) => ({
        role: role.role,
        competent: role.competent,
        gapPlan: role.gapPlan?.gap,
      })),
      acceptedByActor: ctx.auth.actorId,
      acceptedAt: new Date().toISOString(),
    },
  });

  return {
    rolesCovered: coverage.filter((role) => role.covered).length,
    gapPlans: coverage.filter((role) => role.gapPlan).length,
  };
}

/**
 * Why training blocks the handover, or null.
 *
 * AC-H-WF-06-03. Binds only where the project runs a needs analysis at all.
 */
export function trainingHandoverBlockedReason(ctx: EngineContext): string | null {
  const needs = needsOf(ctx);
  if (!needs) return null;

  const coverage = roleCoverage(ctx);

  // The failed assessment first, and the order is not arbitrary. A role short of
  // competent people because somebody failed is also a role with nobody in it,
  // and "no competent named person" describes the consequence while "K. Osei was
  // assessed as not yet competent" is the thing anybody can act on.
  const failed = coverage.filter((role) => role.critical && role.notYetCompetent.length > 0);
  if (failed.length > 0) {
    return (
      `${failed.flatMap((role) => role.notYetCompetent).join(', ')} assessed as not yet competent in a required role. A ` +
      'failed assessment is a finding, not a formality.'
    );
  }

  const uncovered = coverage.filter((role) => role.critical && !role.covered);
  if (uncovered.length > 0) {
    return (
      `${uncovered.map((role) => role.role).join(', ')} ${uncovered.length === 1 ? 'is' : 'are'} a required operational ` +
      'role with no competent named person and no gap plan.'
    );
  }

  const outstanding = ctx.ledger
    .list(ctx.projectId, 'RetrainingObligation')
    .filter((record) => record.state.status === 'OUTSTANDING');
  if (outstanding.length > 0) {
    return `${outstanding.map((record) => String(record.state.role)).join(', ')} awaiting retraining after a material change.`;
  }

  return null;
}

// --- The position -----------------------------------------------------------

export type OperatorReadinessPosition = {
  operatingModel?: string;
  coverage: RoleCoverage[];
  retraining: Array<{ role: string; reason: string; owner: string; by: string }>;
  accepted?: { acceptedBy: string; forOperator: string; supportPlan: string; acceptedAt: string };
  blockedReason: string | null;
  summary: string;
};

export function operatorReadinessPosition(ctx: EngineContext): OperatorReadinessPosition {
  authorise(ctx, 'HANDOVER_OM', 'R');

  const needs = needsOf(ctx);
  const coverage = roleCoverage(ctx);
  const accepted = ctx.ledger.list(ctx.projectId, 'OperatorReadiness')[0]?.state;

  const retraining = ctx.ledger
    .list(ctx.projectId, 'RetrainingObligation')
    .filter((record) => record.state.status === 'OUTSTANDING')
    .map((record) => ({
      role: String(record.state.role),
      reason: String(record.state.reason),
      owner: String(record.state.owner),
      by: String(record.state.by),
    }));

  const parts: string[] = [];
  if (!needs) {
    parts.push('No training needs analysis');
  } else {
    const covered = coverage.filter((role) => role.covered).length;
    parts.push(`${covered} of ${coverage.length} operational roles covered`);
    const awaiting = coverage.reduce((sum, role) => sum + role.awaitingAssessment.length, 0);
    if (awaiting > 0) parts.push(`${awaiting} attended and not assessed`);
    const notYet = coverage.reduce((sum, role) => sum + role.notYetCompetent.length, 0);
    if (notYet > 0) parts.push(`${notYet} assessed as not yet competent`);
    const gaps = coverage.filter((role) => role.gapPlan).length;
    if (gaps > 0) parts.push(`${gaps} covered by a gap plan`);
  }
  if (retraining.length > 0) parts.push(`${retraining.length} awaiting retraining`);
  if (accepted) parts.push('operator readiness accepted');

  return {
    operatingModel: needs?.operatingModel,
    coverage,
    retraining,
    accepted: accepted
      ? {
          acceptedBy: String(accepted.acceptedBy),
          forOperator: String(accepted.forOperator),
          supportPlan: String(accepted.supportPlan),
          acceptedAt: String(accepted.acceptedAt),
        }
      : undefined,
    blockedReason: trainingHandoverBlockedReason(ctx),
    summary: parts.join(', ') + '.',
  };
}
