import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from './context.ts';

/**
 * Quality assurance.
 *
 * Three events for this stage were already in the closed catalogue —
 * INSPECTION_COMPLETED, NCR_RAISED, SNAG_CLOSED — and nothing emitted any of
 * them. The platform could raise a snag and never close it, and could not
 * record an inspection or a non-conformance at all. Quality was a defect list.
 *
 * What was missing is the part that makes it assurance rather than reaction:
 *
 *   Inspection & Test Plan -> hold point -> inspection -> pass, or an NCR
 *
 * The hold point is the whole idea. An ITP names the stages where work must
 * stop until someone has inspected it — concrete cannot be poured over
 * reinforcement nobody checked. A hold point that can be passed by carrying on
 * regardless is a comment in a document, so here it is enforced: while a hold
 * point is open the platform refuses to record it as released, and the refusal
 * names what is outstanding.
 */

export type InspectionOutcome = 'PASS' | 'PASS_WITH_COMMENT' | 'FAIL';

export type ITPStageInput = {
  reference: string;
  description: string;
  /** Specification or drawing clause the inspection is against. */
  acceptanceCriteria: string;
  /**
   * HOLD  — work stops until released.
   * WITNESS — the inspector is invited; work may proceed if they do not attend.
   * REVIEW — records are checked afterwards.
   */
  type: 'HOLD' | 'WITNESS' | 'REVIEW';
  /** Who signs it off — the discipline, not a named person. */
  responsible: string;
};

function reference(ctx: EngineContext, refType: string, prefix: string): string {
  const sequence = ctx.ledger.list(ctx.projectId, refType).length + 1;
  return `${prefix}-${String(sequence).padStart(5, '0')}`;
}

// --- Inspection and test plan ------------------------------------------------

/**
 * Create the ITP for a work package: the agreed list of what gets inspected,
 * against what, and which stages stop the work.
 */
export function createInspectionPlan(
  ctx: EngineContext,
  input: {
    workPackageId: string;
    title: string;
    discipline: string;
    stages: ITPStageInput[];
    /** The specification the plan is written against. */
    specificationRef?: string;
  },
): { planId: string; reference: string; holdPoints: number } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (input.stages.length === 0) {
    throw new DomainError('ITP_EMPTY', 'An inspection and test plan with no stages inspects nothing');
  }

  const seen = new Set<string>();
  for (const stage of input.stages) {
    if (seen.has(stage.reference)) {
      throw new DomainError('ITP_STAGE_DUPLICATE', `Stage ${stage.reference} appears twice in the plan`);
    }
    seen.add(stage.reference);
    if (!stage.acceptanceCriteria?.trim()) {
      throw new DomainError(
        'ACCEPTANCE_CRITERIA_REQUIRED',
        `Stage ${stage.reference} has no acceptance criteria — there would be nothing to inspect against`,
      );
    }
  }

  const planId = ulid();
  const ref = reference(ctx, 'InspectionPlan', 'ITP');
  const holdPoints = input.stages.filter((s) => s.type === 'HOLD').length;

  write(ctx, {
    eventType: 'ITP_CREATED',
    entity: { refType: 'InspectionPlan', refId: planId },
    nextState: {
      id: planId,
      projectId: ctx.projectId,
      reference: ref,
      workPackageId: input.workPackageId,
      title: input.title,
      discipline: input.discipline,
      specificationRef: input.specificationRef,
      stages: input.stages.map((stage) => ({ ...stage, status: 'PENDING' })),
      holdPoints,
      status: 'OPEN',
      createdAt: new Date().toISOString(),
      createdBy: ctx.auth.actorId,
    },
  });

  return { planId, reference: ref, holdPoints };
}

function requirePlan(ctx: EngineContext, planId: string) {
  const record = ctx.ledger.get({ refType: 'InspectionPlan', refId: planId });
  if (!record) throw new DomainError('ITP_NOT_FOUND', `No inspection plan ${planId}`, 404);
  return record;
}

type StoredStage = ITPStageInput & { status: string; inspectionId?: string };

// --- Inspection ---------------------------------------------------------------

/**
 * Record an inspection against an ITP stage.
 *
 * Evidence is mandatory — an inspection nobody can produce a record of did not
 * happen, and the catalogue enforces it. A failure raises a non-conformance in
 * the same breath rather than leaving it to somebody's diary.
 */
export function recordInspection(
  ctx: EngineContext,
  input: {
    planId: string;
    stageReference: string;
    outcome: InspectionOutcome;
    inspectedBy: string;
    comments: string;
    /** Hash of the inspection record, photograph or test certificate. */
    evidenceHash: string;
    /** Required when the outcome is a failure. */
    nonConformance?: { description: string; severity: 'MINOR' | 'MAJOR' | 'CRITICAL'; proposedAction: string };
  },
): { inspectionId: string; reference: string; ncrId?: string; stageReleased: boolean } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'C', { lifecyclePhase: currentPhase(ctx) });

  const plan = requirePlan(ctx, input.planId);
  const stages = plan.state.stages as StoredStage[];
  const stage = stages.find((s) => s.reference === input.stageReference);

  if (!stage) {
    throw new DomainError('ITP_STAGE_NOT_FOUND', `Stage ${input.stageReference} is not in plan ${plan.state.reference}`);
  }
  if (stage.status === 'PASSED') {
    throw new DomainError('ITP_STAGE_CLOSED', `Stage ${input.stageReference} has already passed`);
  }
  if (input.outcome === 'FAIL' && !input.nonConformance) {
    throw new DomainError(
      'NON_CONFORMANCE_REQUIRED',
      'A failed inspection must record what did not conform, how serious it is, and what is proposed',
    );
  }

  const evidence = registerEvidence(ctx, {
    type: 'INSPECTION_RECORD',
    hash: input.evidenceHash,
    description: `Inspection ${input.stageReference}: ${input.outcome}`,
    linkedEntities: [{ refType: 'InspectionPlan', refId: input.planId }],
  });

  const inspectionId = ulid();
  const ref = reference(ctx, 'QualityInspection', 'INS');

  write(ctx, {
    eventType: 'INSPECTION_COMPLETED',
    entity: { refType: 'QualityInspection', refId: inspectionId },
    evidenceRefs: [evidence],
    nextState: {
      id: inspectionId,
      projectId: ctx.projectId,
      reference: ref,
      planId: input.planId,
      planReference: plan.state.reference,
      stageReference: input.stageReference,
      stageType: stage.type,
      acceptanceCriteria: stage.acceptanceCriteria,
      outcome: input.outcome,
      inspectedBy: input.inspectedBy,
      comments: input.comments,
      recordedBy: ctx.auth.actorId,
      inspectedAt: new Date().toISOString(),
    },
  });

  // A failure raises the non-conformance immediately. Leaving it to be raised
  // separately is how a failed inspection becomes a verbal conversation.
  let ncrId: string | undefined;
  if (input.outcome === 'FAIL' && input.nonConformance) {
    ncrId = raiseNCR(ctx, {
      description: input.nonConformance.description,
      severity: input.nonConformance.severity,
      proposedAction: input.nonConformance.proposedAction,
      inspectionId,
      evidenceHash: input.evidenceHash,
    }).ncrId;
  }

  const passed = input.outcome !== 'FAIL';
  const updatedStages = stages.map((s) =>
    s.reference === input.stageReference
      ? { ...s, status: passed ? 'PASSED' : 'FAILED', inspectionId }
      : s,
  );

  write(ctx, {
    eventType: 'ITP_STAGE_UPDATED',
    entity: { refType: 'InspectionPlan', refId: input.planId },
    nextState: {
      ...plan.state,
      stages: updatedStages,
      status: updatedStages.every((s) => s.status === 'PASSED') ? 'COMPLETE' : 'OPEN',
    },
  });

  return { inspectionId, reference: ref, ncrId, stageReleased: passed && stage.type === 'HOLD' };
}

// --- Hold points ---------------------------------------------------------------

export type HoldPointStatus = {
  planId: string;
  planReference: string;
  stageReference: string;
  description: string;
  status: string;
};

/** Every hold point on the project that has not yet passed. */
export function openHoldPoints(ctx: EngineContext): HoldPointStatus[] {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'R');

  return ctx.ledger
    .list(ctx.projectId, 'InspectionPlan')
    .flatMap((plan) =>
      (plan.state.stages as StoredStage[])
        .filter((stage) => stage.type === 'HOLD' && stage.status !== 'PASSED')
        .map((stage) => ({
          planId: String(plan.state.id),
          planReference: String(plan.state.reference),
          stageReference: stage.reference,
          description: stage.description,
          status: stage.status,
        })),
    );
}

/**
 * Refuse to proceed past an outstanding hold point.
 *
 * Called by any command that represents work continuing past a stage the ITP
 * says must stop. A hold point nobody enforces is a comment in a document.
 */
export function assertHoldPointsClear(ctx: EngineContext, workPackageId?: string): void {
  const outstanding = openHoldPoints(ctx).filter((hold) => {
    if (!workPackageId) return true;
    const plan = ctx.ledger.get({ refType: 'InspectionPlan', refId: hold.planId });
    return plan?.state.workPackageId === workPackageId;
  });

  if (outstanding.length > 0) {
    throw new DomainError(
      'HOLD_POINT_OPEN',
      `Work cannot proceed: ${outstanding.length} hold point(s) outstanding — ${outstanding
        .map((h) => `${h.planReference}/${h.stageReference} (${h.description})`)
        .join('; ')}`,
    );
  }
}

// --- Non-conformance -----------------------------------------------------------

/**
 * Raise a non-conformance.
 *
 * Distinct from a snag: a snag is something to put right before handover, an
 * NCR is work that does not meet the specification and needs a disposition —
 * rework, repair, use-as-is with a concession, or reject. The disposition is a
 * decision with a name against it.
 */
export function raiseNCR(
  ctx: EngineContext,
  input: {
    description: string;
    severity: 'MINOR' | 'MAJOR' | 'CRITICAL';
    proposedAction: string;
    inspectionId?: string;
    workPackageId?: string;
    evidenceHash: string;
  },
): { ncrId: string; reference: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'C', { lifecyclePhase: currentPhase(ctx) });

  const evidence = registerEvidence(ctx, {
    type: 'NCR_EVIDENCE',
    hash: input.evidenceHash,
    description: `Non-conformance: ${input.description.slice(0, 80)}`,
  });

  const ncrId = ulid();
  const ref = reference(ctx, 'NCR', 'NCR');

  write(ctx, {
    eventType: 'NCR_RAISED',
    entity: { refType: 'NCR', refId: ncrId },
    evidenceRefs: [evidence],
    nextState: {
      id: ncrId,
      projectId: ctx.projectId,
      reference: ref,
      description: input.description,
      severity: input.severity,
      proposedAction: input.proposedAction,
      inspectionId: input.inspectionId,
      workPackageId: input.workPackageId,
      status: 'OPEN',
      raisedBy: ctx.auth.actorId,
      raisedAt: new Date().toISOString(),
    },
  });

  return { ncrId, reference: ref };
}

/**
 * Close a non-conformance with a disposition.
 *
 * "Use as is" is permitted and is the one that matters: accepting work that
 * does not meet specification is a decision somebody has to own, and it is
 * recorded with a name and a justification rather than quietly dropped.
 */
export function closeNCR(
  ctx: EngineContext,
  ncrId: string,
  input: {
    disposition: 'REWORK' | 'REPAIR' | 'USE_AS_IS' | 'REJECT';
    justification: string;
    evidenceHash: string;
  },
): { status: string; disposition: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = ctx.ledger.get({ refType: 'NCR', refId: ncrId });
  if (!record) throw new DomainError('NCR_NOT_FOUND', `No non-conformance ${ncrId}`, 404);
  if (record.state.status !== 'OPEN') {
    throw new DomainError('NCR_NOT_OPEN', `This non-conformance is already ${String(record.state.status).toLowerCase()}`);
  }
  if (!input.justification?.trim()) {
    throw new DomainError('JUSTIFICATION_REQUIRED', 'Closing a non-conformance requires a justification');
  }

  const evidence = registerEvidence(ctx, {
    type: 'NCR_CLOSURE',
    hash: input.evidenceHash,
    description: `NCR ${String(record.state.reference)} closed as ${input.disposition}`,
    linkedEntities: [{ refType: 'NCR', refId: ncrId }],
  });

  write(ctx, {
    eventType: 'NCR_CLOSED',
    entity: { refType: 'NCR', refId: ncrId },
    evidenceRefs: [evidence],
    nextState: {
      ...record.state,
      status: 'CLOSED',
      disposition: input.disposition,
      justification: input.justification.trim(),
      closedBy: ctx.auth.actorId,
      closedAt: new Date().toISOString(),
    },
  });

  return { status: 'CLOSED', disposition: input.disposition };
}

// --- Snag closure --------------------------------------------------------------

/**
 * Close a snag.
 *
 * SNAG_CLOSED was in the catalogue with nothing to emit it, so a snag raised on
 * this platform could never be finished. Evidence is required: "it has been
 * done" without a photograph is how a snag list reopens at handover.
 */
export function closeSnag(
  ctx: EngineContext,
  snagId: string,
  input: { evidenceHash: string; note: string },
): { reference: string; status: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = ctx.ledger.get({ refType: 'Snag', refId: snagId });
  if (!record) throw new DomainError('SNAG_NOT_FOUND', `No snag ${snagId}`, 404);
  if (record.state.status === 'CLOSED') {
    throw new DomainError('SNAG_ALREADY_CLOSED', `Snag ${String(record.state.reference)} is already closed`);
  }

  const evidence = registerEvidence(ctx, {
    type: 'SNAG_CLOSURE_PHOTO',
    hash: input.evidenceHash,
    description: `Snag ${String(record.state.reference)} closed`,
    linkedEntities: [{ refType: 'Snag', refId: snagId }],
  });

  write(ctx, {
    eventType: 'SNAG_CLOSED',
    entity: { refType: 'Snag', refId: snagId },
    evidenceRefs: [evidence],
    nextState: {
      ...record.state,
      status: 'CLOSED',
      closureNote: input.note,
      closedBy: ctx.auth.actorId,
      closedAt: new Date().toISOString(),
    },
  });

  return { reference: String(record.state.reference), status: 'CLOSED' };
}

// --- Read ----------------------------------------------------------------------

export type QualityPosition = {
  plans: number;
  stagesTotal: number;
  stagesPassed: number;
  holdPointsOpen: number;
  inspections: { total: number; passed: number; failed: number };
  ncrs: { open: number; closed: number; bySeverity: Record<string, number> };
  snags: { open: number; closed: number };
  /** Passed stages as a percentage of all stages. Null when there is no plan. */
  conformancePercent: number | null;
};

export function qualityPosition(ctx: EngineContext): QualityPosition {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'R');

  const plans = ctx.ledger.list(ctx.projectId, 'InspectionPlan');
  const stages = plans.flatMap((p) => p.state.stages as StoredStage[]);
  const inspections = ctx.ledger.list(ctx.projectId, 'QualityInspection').map((r) => r.state);
  const ncrs = ctx.ledger.list(ctx.projectId, 'NCR').map((r) => r.state);
  const snags = ctx.ledger.list(ctx.projectId, 'Snag').map((r) => r.state);

  const stagesPassed = stages.filter((s) => s.status === 'PASSED').length;
  const bySeverity: Record<string, number> = {};
  for (const ncr of ncrs.filter((n) => n.status === 'OPEN')) {
    const severity = String(ncr.severity);
    bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;
  }

  return {
    plans: plans.length,
    stagesTotal: stages.length,
    stagesPassed,
    holdPointsOpen: openHoldPoints(ctx).length,
    inspections: {
      total: inspections.length,
      passed: inspections.filter((i) => i.outcome !== 'FAIL').length,
      failed: inspections.filter((i) => i.outcome === 'FAIL').length,
    },
    ncrs: {
      open: ncrs.filter((n) => n.status === 'OPEN').length,
      closed: ncrs.filter((n) => n.status === 'CLOSED').length,
      bySeverity,
    },
    snags: {
      open: snags.filter((s) => s.status !== 'CLOSED').length,
      closed: snags.filter((s) => s.status === 'CLOSED').length,
    },
    conformancePercent: stages.length === 0 ? null : Math.round((stagesPassed / stages.length) * 10000) / 100,
  };
}
