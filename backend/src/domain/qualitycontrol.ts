import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';

/**
 * CN-WF-06 — quality planning, inspection, testing, NCR and defect control.
 *
 * `engines/quality.ts` already builds the ITP, records inspections, tracks hold
 * points and raises and closes non-conformances. None of that is rebuilt. What
 * this module owns is the five things that were missing, and the first of them
 * was predicted by a comment in the existing code.
 *
 * **A hold point nobody enforced.** `assertHoldPointsClear` was written with a
 * doc comment saying "a hold point nobody enforces is a comment in a document" —
 * and nothing in the platform called it. AC-CN-WF-06-02 asks for the successor
 * to be blocked, and it now is: a stage cannot be inspected while an earlier
 * hold point in the same plan is unreleased. Precisely that, rather than
 * blocking all work on the package, which would stop the job the moment an ITP
 * was written.
 *
 * **A release that was only an inspection.** A passed inspection is the
 * inspector's finding. The *release* is the authority to build over it, and on
 * a hold point those are two different acts by two different people — which is
 * the entire reason a hold point is not a review point. Recording the pass no
 * longer releases anything by itself.
 *
 * **An inspection against nothing in particular.** AC-CN-WF-06-01: an inspection
 * links the exact acceptance criteria *and* the information revision it was
 * carried out against. "Inspected and passed" against a drawing that was
 * superseded on the Friday is the finding that turns up at handover, and there
 * is no way to see it afterwards unless the revision was written down at the
 * time.
 *
 * **A measurement from an instrument out of calibration.** The second exception
 * control. A torque wrench three months past its certificate did not measure
 * anything; the readings taken with it are not wrong so much as unknown, and
 * every one of them has to be reviewed. The instrument register makes that
 * answerable instead of unanswerable.
 *
 * **A closure with nothing behind it.** AC-CN-WF-06-03. Rework and repair close
 * on a corrective action that names the containment, the root cause and the
 * verification that it worked — and *use-as-is* is not a quality decision at
 * all. Accepting work that does not meet the specification is the designer
 * accepting that the as-built differs from the design, so it needs a concession
 * from design authority before the quality manager can close on it. The two are
 * deliberately different people.
 *
 * And the third exception control: a closed defect **reopens** if the evidence
 * it closed on is withdrawn or superseded. Nothing about the original closure is
 * erased; the reopening says what happened to the evidence.
 */

// --- Requesting an inspection -----------------------------------------------

export type InspectionRequest = {
  planId: string;
  stageReference: string;
  /** The exact drawing, model or specification revision it is against. */
  informationRevision: string;
  /** Who has to be there, and by when they were told. */
  notifyParties: string[];
  requiredBy: string;
  /** The work that has to be finished first, confirmed by a person. */
  prerequisitesConfirmed: string;
};

function requirePlan(ctx: EngineContext, planId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'InspectionPlan', refId: planId });
  if (!record) throw new DomainError('ITP_NOT_FOUND', `No inspection plan ${planId}`, 404);
  return record;
}

type StoredStage = {
  reference: string;
  description: string;
  acceptanceCriteria: string;
  type: 'HOLD' | 'WITNESS' | 'REVIEW';
  responsible: string;
  status: string;
};

function stagesOf(record: EntityRecord): StoredStage[] {
  return (record.state.stages as StoredStage[]) ?? [];
}

/**
 * Why this stage cannot be inspected yet, or null.
 *
 * AC-CN-WF-06-02. Called by `engines/quality.ts` before it records an
 * inspection, so the rule sits on the act rather than on a screen. An ITP's
 * stages are in sequence, so an unreleased hold point earlier in the plan stops
 * everything after it — which is what a hold point is for and the only thing
 * that distinguishes it from a witness point.
 */
export function holdPointBlockedReason(ctx: EngineContext, planId: string, stageReference: string): string | null {
  const record = ctx.ledger.get({ refType: 'InspectionPlan', refId: planId });
  if (!record) return null;

  const stages = stagesOf(record);
  const index = stages.findIndex((stage) => stage.reference === stageReference);
  if (index <= 0) return null;

  const released = new Set(
    ctx.ledger
      .list(ctx.projectId, 'HoldPointRelease')
      .filter((entry) => entry.state.planId === planId)
      .map((entry) => String(entry.state.stageReference)),
  );

  const blocking = stages
    .slice(0, index)
    .filter((stage) => stage.type === 'HOLD' && !released.has(stage.reference));

  if (blocking.length === 0) return null;

  return (
    `${blocking.map((stage) => `${stage.reference} (${stage.description})`).join('; ')} ` +
    `${blocking.length === 1 ? 'is a hold point that has' : 'are hold points that have'} not been released. Work does not ` +
    'proceed past a hold point on a passed inspection alone — the release is a separate authority, and without that ' +
    'distinction a hold point is a witness point with a stronger word on it.'
  );
}

export function requestInspection(
  ctx: EngineContext,
  input: InspectionRequest,
): { requestId: string; reference: string; stage: string; type: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'C', { lifecyclePhase: currentPhase(ctx) });

  const plan = requirePlan(ctx, input.planId);
  const stage = stagesOf(plan).find((entry) => entry.reference === input.stageReference);
  if (!stage) {
    throw new DomainError(
      'ITP_STAGE_NOT_FOUND',
      `Stage ${input.stageReference} is not in plan ${String(plan.state.reference)}.`,
      404,
    );
  }

  const blocked = holdPointBlockedReason(ctx, input.planId, input.stageReference);
  if (blocked) throw new DomainError('HOLD_POINT_OPEN', blocked, 409);

  // AC-CN-WF-06-01. "Inspected and passed" against a drawing superseded on the
  // Friday is the finding that turns up at handover, and it is invisible
  // afterwards unless the revision was written down at the time.
  if (!input.informationRevision.trim()) {
    throw new DomainError(
      'INFORMATION_REVISION_REQUIRED',
      'Name the exact drawing, model or specification revision this is inspected against. An inspection against "the ' +
        'drawings" cannot be checked afterwards, and afterwards is when somebody asks.',
    );
  }
  if (!input.prerequisitesConfirmed.trim()) {
    throw new DomainError(
      'PREREQUISITES_UNCONFIRMED',
      'Say what was finished before this was called. An inspector brought to a workface that is not ready is the reason ' +
        'inspections stop being attended.',
    );
  }
  if (input.notifyParties.length === 0) {
    throw new DomainError(
      'NOTIFICATION_REQUIRED',
      'Name who has to be there. A hold point nobody was told about is one that gets built over.',
    );
  }
  if (Number.isNaN(Date.parse(input.requiredBy))) {
    throw new DomainError('NOTIFICATION_REQUIRED', 'Say when the inspection is needed.');
  }

  const sequence = ctx.ledger.list(ctx.projectId, 'InspectionRequest').length + 1;
  const reference = `IR-${String(sequence).padStart(4, '0')}`;
  const requestId = ulid();

  write(ctx, {
    eventType: 'INSPECTION_REQUESTED',
    entity: { refType: 'InspectionRequest', refId: requestId },
    nextState: {
      id: requestId,
      projectId: ctx.projectId,
      reference,
      planId: input.planId,
      planReference: String(plan.state.reference),
      stageReference: input.stageReference,
      stageType: stage.type,
      acceptanceCriteria: stage.acceptanceCriteria,
      informationRevision: input.informationRevision.trim(),
      notifyParties: input.notifyParties,
      requiredBy: input.requiredBy.slice(0, 10),
      prerequisitesConfirmed: input.prerequisitesConfirmed,
      requestedAt: new Date().toISOString(),
      requestedBy: ctx.auth.actorId,
    },
  });

  return { requestId, reference, stage: input.stageReference, type: stage.type };
}

// --- Releasing a hold point -------------------------------------------------

export function releaseHoldPoint(
  ctx: EngineContext,
  input: { planId: string; stageReference: string; basis: string; evidenceHash: string },
): { planReference: string; stageReference: string } {
  // Approve. The release is the authority to build over the hold point, which
  // is a different act from the inspector's finding that it passed.
  authorise(ctx, 'QUALITY_COMMISSIONING', 'A', { lifecyclePhase: currentPhase(ctx) });

  const plan = requirePlan(ctx, input.planId);
  const stage = stagesOf(plan).find((entry) => entry.reference === input.stageReference);
  if (!stage) {
    throw new DomainError('ITP_STAGE_NOT_FOUND', `Stage ${input.stageReference} is not in that plan.`, 404);
  }
  if (stage.type !== 'HOLD') {
    throw new DomainError(
      'NOT_A_HOLD_POINT',
      `${input.stageReference} is a ${stage.type.toLowerCase()} point, which nothing is waiting on. Releasing it would ` +
        'suggest it had been holding something.',
    );
  }
  if (stage.status !== 'PASSED') {
    throw new DomainError(
      'STAGE_NOT_PASSED',
      `${input.stageReference} has not passed its inspection, so there is nothing to release it on. The release is an ` +
        'authority over a finding, not a substitute for one.',
      409,
    );
  }

  const already = ctx.ledger
    .list(ctx.projectId, 'HoldPointRelease')
    .find((entry) => entry.state.planId === input.planId && entry.state.stageReference === input.stageReference);
  if (already) {
    throw new DomainError('ALREADY_RELEASED', `${input.stageReference} was already released.`, 409);
  }
  if (!input.basis.trim()) {
    throw new DomainError('RELEASE_UNEXPLAINED', 'Say what the release rests on.');
  }

  const evidence = registerEvidence(ctx, {
    type: 'HOLD_POINT_RELEASE',
    hash: input.evidenceHash,
    description: `${String(plan.state.reference)}/${input.stageReference} released: ${input.basis}`,
    linkedEntities: [{ refType: 'InspectionPlan', refId: input.planId }],
  });

  const releaseId = ulid();

  write(ctx, {
    eventType: 'HOLD_POINT_RELEASED',
    entity: { refType: 'HoldPointRelease', refId: releaseId },
    nextState: {
      id: releaseId,
      projectId: ctx.projectId,
      planId: input.planId,
      planReference: String(plan.state.reference),
      stageReference: input.stageReference,
      basis: input.basis,
      releasedAt: new Date().toISOString(),
      releasedBy: ctx.auth.actorId,
    },
    evidenceRefs: [evidence],
  });

  return { planReference: String(plan.state.reference), stageReference: input.stageReference };
}

// --- Calibration ------------------------------------------------------------

export function registerInstrument(
  ctx: EngineContext,
  input: { instrumentId: string; description: string; calibratedAt: string; calibrationExpiresAt: string; certificate: string },
): { instrumentId: string; expiresAt: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (!input.instrumentId.trim() || !input.description.trim()) {
    throw new DomainError('INSTRUMENT_UNIDENTIFIED', 'An instrument carries an identifier and what it is.');
  }
  if (!input.certificate.trim()) {
    throw new DomainError(
      'CALIBRATION_CERTIFICATE_REQUIRED',
      'Name the calibration certificate. An instrument recorded as calibrated with nothing behind it is one nobody can ' +
        'defend the readings from.',
    );
  }
  if (Number.isNaN(Date.parse(input.calibratedAt)) || Number.isNaN(Date.parse(input.calibrationExpiresAt))) {
    throw new DomainError('CALIBRATION_DATES_REQUIRED', 'A calibration runs between two dates.');
  }
  if (input.calibrationExpiresAt <= input.calibratedAt) {
    throw new DomainError('CALIBRATION_DATES_REQUIRED', 'The calibration expires before it was carried out.');
  }

  write(ctx, {
    eventType: 'INSTRUMENT_CALIBRATED',
    entity: { refType: 'Instrument', refId: input.instrumentId.trim() },
    nextState: {
      id: input.instrumentId.trim(),
      projectId: ctx.projectId,
      description: input.description,
      calibratedAt: input.calibratedAt.slice(0, 10),
      calibrationExpiresAt: input.calibrationExpiresAt.slice(0, 10),
      certificate: input.certificate,
      registeredAt: new Date().toISOString(),
      registeredBy: ctx.auth.actorId,
    },
  });

  return { instrumentId: input.instrumentId.trim(), expiresAt: input.calibrationExpiresAt.slice(0, 10) };
}

/**
 * Why a reading from this instrument cannot be relied on, or null.
 *
 * The second exception control. A torque wrench three months past its
 * certificate did not measure anything: the readings are not wrong so much as
 * unknown, and every one of them has to be reviewed rather than quietly kept.
 */
export function calibrationBlockedReason(
  ctx: EngineContext,
  instrumentId: string,
  on = new Date().toISOString().slice(0, 10),
): string | null {
  const record = ctx.ledger.get({ refType: 'Instrument', refId: instrumentId });
  if (!record) {
    return `${instrumentId} is not on the instrument register, so nothing can say whether it was in calibration when the reading was taken.`;
  }
  const expires = String(record.state.calibrationExpiresAt);
  if (expires < on) {
    return `${instrumentId} (${String(record.state.description)}) was out of calibration on ${on}; its certificate expired ${expires}. The reading is not wrong so much as unknown.`;
  }
  return null;
}

// --- Corrective action and closure ------------------------------------------

export type CorrectiveAction = {
  /** What was done immediately to stop it getting worse or spreading. */
  containment: string;
  /** Why it happened. Not what happened — that is the non-conformance. */
  rootCause: string;
  /** What puts this instance right. */
  corrective: string;
  /** What stops the next one. Often the only part with lasting value. */
  preventive: string;
  owner: string;
  by: string;
};

export function recordCorrectiveAction(
  ctx: EngineContext,
  ncrId: string,
  input: CorrectiveAction & { evidenceHash: string },
): { ncrReference: string; recorded: true } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = ctx.ledger.get({ refType: 'NCR', refId: ncrId });
  if (!record) throw new DomainError('NCR_NOT_FOUND', `No non-conformance ${ncrId}`, 404);

  const missing = (['containment', 'rootCause', 'corrective', 'preventive', 'owner'] as const).filter(
    (field) => !input[field].trim(),
  );
  if (missing.length > 0) {
    throw new DomainError(
      'CORRECTIVE_ACTION_INCOMPLETE',
      `The action on ${String(record.state.reference)} has no ${missing.join(', no ')}. Containment stops it spreading, the ` +
        'root cause is why rather than what, the corrective action puts this one right and the preventive action stops the ' +
        'next one — and the last of those is usually the only part with lasting value.',
    );
  }
  if (Number.isNaN(Date.parse(input.by))) {
    throw new DomainError('CORRECTIVE_ACTION_INCOMPLETE', 'A corrective action carries the date it is due.');
  }
  if (!input.evidenceHash.trim()) {
    throw new DomainError('EVIDENCE_REQUIRED', 'A corrective action carries the evidence that it was carried out.');
  }

  const evidence = registerEvidence(ctx, {
    type: 'NCR_CORRECTIVE_ACTION',
    hash: input.evidenceHash,
    description: `Corrective action on ${String(record.state.reference)}: ${input.corrective}`,
    linkedEntities: [{ refType: 'NCR', refId: ncrId }],
  });

  write(ctx, {
    eventType: 'NCR_ACTION_RECORDED',
    entity: { refType: 'NCR', refId: ncrId },
    nextState: {
      ...record.state,
      correctiveAction: {
        containment: input.containment,
        rootCause: input.rootCause,
        corrective: input.corrective,
        preventive: input.preventive,
        owner: input.owner,
        by: input.by.slice(0, 10),
        recordedAt: new Date().toISOString(),
        recordedBy: ctx.auth.actorId,
      },
    },
    evidenceRefs: [evidence],
  });

  return { ncrReference: String(record.state.reference), recorded: true };
}

/**
 * A concession: the designer accepting that the as-built differs from the
 * design.
 *
 * The first exception control asks for use-as-is to need a designated technical
 * or commercial authority, and this is it. Deliberately `DESIGN_INFORMATION`
 * approve rather than quality approve — accepting non-compliant work is not a
 * quality decision, it is a decision to change what the design asked for, and
 * the person who decides it should not be the person closing the record on it.
 */
export function approveConcession(
  ctx: EngineContext,
  ncrId: string,
  input: { rationale: string; limitations: string; evidenceHash: string },
): { ncrReference: string; approvedBy: string } {
  authorise(ctx, 'DESIGN_INFORMATION', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = ctx.ledger.get({ refType: 'NCR', refId: ncrId });
  if (!record) throw new DomainError('NCR_NOT_FOUND', `No non-conformance ${ncrId}`, 404);
  if (record.state.concession) {
    throw new DomainError('ALREADY_CONCEDED', `${String(record.state.reference)} already carries a concession.`, 409);
  }
  if (!input.rationale.trim()) {
    throw new DomainError(
      'CONCESSION_UNEXPLAINED',
      'Say why the work is acceptable as built. "Use as is" with no engineering behind it is the sentence that gets read ' +
        'out at an inquiry.',
    );
  }
  if (!input.limitations.trim()) {
    throw new DomainError(
      'CONCESSION_UNLIMITED',
      'Say what the concession does not cover — the loading it assumes, the life it accepts, the maintenance it now needs. ' +
        'A concession with no limits on it is read later as approval of the method.',
    );
  }

  const evidence = registerEvidence(ctx, {
    type: 'NCR_CONCESSION',
    hash: input.evidenceHash,
    description: `Concession on ${String(record.state.reference)}: ${input.rationale}`,
    linkedEntities: [{ refType: 'NCR', refId: ncrId }],
  });

  write(ctx, {
    eventType: 'CONCESSION_APPROVED',
    entity: { refType: 'NCR', refId: ncrId },
    nextState: {
      ...record.state,
      concession: {
        rationale: input.rationale,
        limitations: input.limitations,
        approvedAt: new Date().toISOString(),
        approvedBy: ctx.auth.actorId,
      },
    },
    evidenceRefs: [evidence],
  });

  return { ncrReference: String(record.state.reference), approvedBy: ctx.auth.actorId };
}

/**
 * Why this non-conformance cannot be closed on this disposition, or null.
 *
 * AC-CN-WF-06-03, called by `engines/quality.ts` so the rule sits on the act.
 * The rule binds only where the workflow is in use: a project that raises an
 * NCR and closes it the same afternoon with a photograph is not obstructed,
 * because a project with no corrective action recorded has not started using
 * this control and refusing it would be inventing a requirement.
 */
export function ncrClosureBlockedReason(
  ctx: EngineContext,
  ncrId: string,
  disposition: 'REWORK' | 'REPAIR' | 'USE_AS_IS' | 'REJECT',
): string | null {
  const record = ctx.ledger.get({ refType: 'NCR', refId: ncrId });
  if (!record) return null;

  if (disposition === 'USE_AS_IS' && !record.state.concession) {
    return (
      `${String(record.state.reference)} cannot be closed as use-as-is without a concession from design authority. ` +
      'Accepting work that does not meet the specification is a decision to change what the design asked for, not a quality ' +
      'decision, and the person who decides it is not the person closing the record on it.'
    );
  }

  const action = record.state.correctiveAction as Record<string, unknown> | undefined;
  if ((disposition === 'REWORK' || disposition === 'REPAIR') && action && !String(action.corrective ?? '').trim()) {
    return `${String(record.state.reference)} carries a corrective action with nothing in it.`;
  }

  return null;
}

/**
 * Reopen a closed non-conformance.
 *
 * The third exception control. Evidence gets withdrawn — a test certificate
 * turns out to be for a different batch, a photograph turns out to be of the
 * adjacent bay — and a defect closed on it was never actually closed. Nothing
 * about the original closure is erased: the reopening records what happened to
 * the evidence, which is the fact somebody will need.
 */
export function reopenNCR(
  ctx: EngineContext,
  ncrId: string,
  input: { reason: string; withdrawnEvidence: string },
): { ncrReference: string; reopened: true } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = ctx.ledger.get({ refType: 'NCR', refId: ncrId });
  if (!record) throw new DomainError('NCR_NOT_FOUND', `No non-conformance ${ncrId}`, 404);
  if (record.state.status !== 'CLOSED') {
    throw new DomainError('NCR_NOT_CLOSED', `${String(record.state.reference)} is not closed.`);
  }
  if (!input.reason.trim() || !input.withdrawnEvidence.trim()) {
    throw new DomainError(
      'REOPENING_UNEXPLAINED',
      'Name the evidence that was withdrawn or superseded and why. A reopening with no reason on it reads as somebody ' +
        'disagreeing with the closure rather than as the closure having rested on something that turned out not to hold.',
    );
  }

  const history = (record.state.closureHistory as unknown[]) ?? [];

  write(ctx, {
    eventType: 'NCR_REOPENED',
    entity: { refType: 'NCR', refId: ncrId },
    nextState: {
      ...record.state,
      status: 'OPEN',
      // The original closure is kept in full rather than overwritten: somebody
      // acted on it, and an append-only ledger does not remove what was relied
      // upon.
      closureHistory: [
        ...history,
        {
          disposition: record.state.disposition,
          justification: record.state.justification,
          closedBy: record.state.closedBy,
          closedAt: record.state.closedAt,
          reopenedAt: new Date().toISOString(),
          reopenedBy: ctx.auth.actorId,
          reason: input.reason,
          withdrawnEvidence: input.withdrawnEvidence,
        },
      ],
      disposition: undefined,
      closedBy: undefined,
      closedAt: undefined,
    },
  });

  return { ncrReference: String(record.state.reference), reopened: true };
}

// --- The position -----------------------------------------------------------

export type QualityControlPosition = {
  /** Hold points passed but not released — work is stopped behind these. */
  awaitingRelease: Array<{ planReference: string; stageReference: string; description: string }>;
  requests: Array<{
    reference: string;
    planReference: string;
    stageReference: string;
    type: string;
    informationRevision: string;
    requiredBy: string;
  }>;
  /** Instruments out of calibration, and the ones about to be. */
  calibration: Array<{ instrumentId: string; description: string; expiresAt: string; expired: boolean }>;
  /** Non-conformances reopened because the evidence did not hold. */
  reopened: Array<{ reference: string; reason: string; withdrawnEvidence: string }>;
  concessions: Array<{ reference: string; rationale: string; limitations: string; approvedBy: string }>;
  summary: string;
};

export function qualityControlPosition(
  ctx: EngineContext,
  today = new Date().toISOString().slice(0, 10),
): QualityControlPosition {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'R');

  const released = new Set(
    ctx.ledger
      .list(ctx.projectId, 'HoldPointRelease')
      .map((entry) => `${String(entry.state.planId)}/${String(entry.state.stageReference)}`),
  );

  const awaitingRelease: QualityControlPosition['awaitingRelease'] = [];
  for (const plan of ctx.ledger.list(ctx.projectId, 'InspectionPlan')) {
    for (const stage of stagesOf(plan)) {
      if (stage.type !== 'HOLD' || stage.status !== 'PASSED') continue;
      if (released.has(`${String(plan.state.id)}/${stage.reference}`)) continue;
      awaitingRelease.push({
        planReference: String(plan.state.reference),
        stageReference: stage.reference,
        description: stage.description,
      });
    }
  }

  const requests = ctx.ledger.list(ctx.projectId, 'InspectionRequest').map((entry) => ({
    reference: String(entry.state.reference),
    planReference: String(entry.state.planReference),
    stageReference: String(entry.state.stageReference),
    type: String(entry.state.stageType),
    informationRevision: String(entry.state.informationRevision),
    requiredBy: String(entry.state.requiredBy),
  }));

  const calibration = ctx.ledger.list(ctx.projectId, 'Instrument').map((entry) => ({
    instrumentId: String(entry.state.id),
    description: String(entry.state.description),
    expiresAt: String(entry.state.calibrationExpiresAt),
    expired: String(entry.state.calibrationExpiresAt) < today,
  }));

  const reopened: QualityControlPosition['reopened'] = [];
  const concessions: QualityControlPosition['concessions'] = [];

  for (const entry of ctx.ledger.list(ctx.projectId, 'NCR')) {
    const history = (entry.state.closureHistory as Array<Record<string, unknown>>) ?? [];
    const latest = history.at(-1);
    if (latest && entry.state.status === 'OPEN') {
      reopened.push({
        reference: String(entry.state.reference),
        reason: String(latest.reason ?? ''),
        withdrawnEvidence: String(latest.withdrawnEvidence ?? ''),
      });
    }
    const concession = entry.state.concession as Record<string, unknown> | undefined;
    if (concession) {
      concessions.push({
        reference: String(entry.state.reference),
        rationale: String(concession.rationale ?? ''),
        limitations: String(concession.limitations ?? ''),
        approvedBy: String(concession.approvedBy ?? ''),
      });
    }
  }

  const expired = calibration.filter((entry) => entry.expired).length;
  const parts: string[] = [];
  if (awaitingRelease.length > 0) parts.push(`${awaitingRelease.length} hold point(s) passed and not released`);
  if (expired > 0) parts.push(`${expired} instrument(s) out of calibration`);
  if (reopened.length > 0) parts.push(`${reopened.length} non-conformance(s) reopened`);
  if (concessions.length > 0) parts.push(`${concessions.length} concession(s) in force`);
  if (parts.length === 0) parts.push('Nothing held, nothing out of calibration, nothing reopened');

  return { awaitingRelease, requests, calibration, reopened, concessions, summary: parts.join(', ') + '.' };
}
