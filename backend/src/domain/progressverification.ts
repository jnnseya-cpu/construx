import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';

/**
 * CN-WF-04 — progress measurement, verification and productivity.
 *
 * The money path. Progress is what a valuation is built on, what earned value
 * is computed from and what the programme's remaining duration comes off, so a
 * figure that is wrong here is wrong in three places at once and expensive in
 * all of them.
 *
 * `engines/planning.ts` already measures productivity against baseline and
 * `engines/cost.ts` already computes earned value; neither is rebuilt. What was
 * missing is the thing that makes those numbers trustworthy: a **claim** and an
 * **acceptance** that are different records made by different people.
 *
 * **Submitted and accepted stay separately auditable.** AC-CN-WF-04-01, and the
 * whole reason the workflow exists. A verifier who adjusts a claim from 240m to
 * 180m must not be able to leave a record saying 180m was what was claimed — the
 * gap between the two *is* the finding, and it is what a productivity argument
 * and a payment dispute both turn on. The submitted value is written once and
 * never touched again.
 *
 * **Nothing is claimed twice.** AC-CN-WF-04-03. A claim is against an activity,
 * a location and a period, and the same three arriving again is refused rather
 * than added. Duplicate reporting is not usually dishonest — it is a gang
 * reporting the same pour on Thursday and again on Friday — and it inflates
 * earned value by exactly the amount nobody notices.
 *
 * **Cumulative quantity cannot exceed the control total.** The first exception
 * control. More installed than exists is either a measurement error or a change
 * nobody has raised, and both need resolving before the money moves. It blocks
 * acceptance rather than submission: the claim is a fact about what somebody
 * measured, and refusing to record it would lose the evidence that the scope
 * has moved.
 *
 * **Rework earns nothing.** The second exception control. Redoing work already
 * claimed is a real cost and a real hazard to the programme, and recording it as
 * progress would report a project going backwards as one going forwards. It is
 * recorded — separately, against the same activity, so the productivity picture
 * is honest — and it contributes zero to the accepted quantity.
 *
 * **One accepted figure, read by everything.** AC-CN-WF-04-02.
 * `acceptedProgressFor` is the single answer, and acceptance is what writes the
 * task's percentage — so the programme, earned value and the valuation are
 * reading the same version by construction rather than by three modules
 * agreeing to. Where an activity is under this workflow, the direct
 * `recordProgress` path is refused, because two doors to one money field is how
 * they diverge.
 */

export const VERIFICATION = ['ACCEPTED', 'ADJUSTED', 'REJECTED'] as const;
export type Verification = (typeof VERIFICATION)[number];

export type MeasurementBasis = {
  taskId: string;
  /** What the activity is measured in. A claim in another unit is refused. */
  unit: string;
  /** The quantity that exists. Nothing cumulative may exceed it. */
  controlTotal: number;
  /** How it is measured — the rule, not a number. */
  measurementRule: string;
  /** The drawing, model or BoQ item the control total came from. */
  source: string;
};

type SubmissionState = {
  id: string;
  reference: string;
  taskId: string;
  costCode?: string;
  location: string;
  periodFrom: string;
  periodTo: string;
  unit: string;
  /** What was claimed. Written once, never touched again. */
  submittedQuantity: number;
  submittedBy: string;
  submittedAt: string;
  /** Redone work. Records the cost and earns nothing. */
  rework: boolean;
  status: 'SUBMITTED' | Verification;
  acceptedQuantity?: number;
  verification?: { decision: Verification; by: string; at: string; rationale: string };
};

function basisFor(ctx: EngineContext, taskId: string): MeasurementBasis | undefined {
  const record = ctx.ledger.get({ refType: 'MeasurementBasis', refId: taskId });
  return record ? (record.state as unknown as MeasurementBasis) : undefined;
}

function submissionsFor(ctx: EngineContext, taskId: string): SubmissionState[] {
  return ctx.ledger
    .list(ctx.projectId, 'ProgressSubmission')
    .map((record) => record.state as unknown as SubmissionState)
    .filter((entry) => entry.taskId === taskId);
}

function requireSubmission(ctx: EngineContext, submissionId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'ProgressSubmission', refId: submissionId });
  if (!record) throw new DomainError('SUBMISSION_NOT_FOUND', `No progress submission ${submissionId}`, 404);
  return record;
}

// --- Step 1: what the activity is measured against --------------------------

/**
 * Declare the measurement basis for an activity.
 *
 * The specification's first required input, and the thing every later refusal
 * needs: without a unit there is nothing to check a claim against, and without
 * a control total "cumulative quantity above the control total" cannot be
 * detected at all.
 */
export function setMeasurementBasis(
  ctx: EngineContext,
  input: MeasurementBasis,
): { taskId: string; controlTotal: number; revised: boolean } {
  authorise(ctx, 'WORKPACKAGES_TASKS', 'U', { lifecyclePhase: currentPhase(ctx) });

  ctx.ledger.require({ refType: 'Task', refId: input.taskId });

  if (!input.unit.trim() || !input.measurementRule.trim()) {
    throw new DomainError(
      'MEASUREMENT_RULE_REQUIRED',
      'Say what the activity is measured in and how. Two people measuring the same wall — one by area, one by linear metre ' +
        'of the same wall — produce two honest numbers that cannot be reconciled.',
    );
  }
  if (!input.source.trim()) {
    throw new DomainError(
      'CONTROL_TOTAL_UNSOURCED',
      'Name the drawing, model or bill item the control total came from. A control total nobody can trace is one nobody can ' +
        'argue with when a claim exceeds it, which is precisely when somebody will need to.',
    );
  }
  if (!(input.controlTotal > 0)) {
    throw new DomainError('CONTROL_TOTAL_REQUIRED', 'A control total of zero means the activity installs nothing.');
  }

  const existing = basisFor(ctx, input.taskId);

  // Lowering the control total below what has already been accepted would make
  // the accepted figure retrospectively impossible.
  if (existing) {
    const accepted = acceptedProgressFor(ctx, input.taskId).acceptedQuantity;
    if (input.controlTotal < accepted) {
      throw new DomainError(
        'CONTROL_TOTAL_BELOW_ACCEPTED',
        `${accepted}${existing.unit} has already been accepted against this activity, so a control total of ` +
          `${input.controlTotal}${input.unit} would make what is already agreed impossible. Resolve the scope first.`,
        409,
      );
    }
  }

  write(ctx, {
    eventType: 'MEASUREMENT_BASIS_SET',
    entity: { refType: 'MeasurementBasis', refId: input.taskId },
    nextState: {
      id: input.taskId,
      projectId: ctx.projectId,
      taskId: input.taskId,
      unit: input.unit.trim(),
      controlTotal: input.controlTotal,
      measurementRule: input.measurementRule,
      source: input.source,
      setAt: new Date().toISOString(),
      setBy: ctx.auth.actorId,
    },
  });

  return { taskId: input.taskId, controlTotal: input.controlTotal, revised: existing !== undefined };
}

// --- Step 1 and 2: the claim ------------------------------------------------

export function submitProgress(
  ctx: EngineContext,
  input: {
    taskId: string;
    quantity: number;
    unit: string;
    location: string;
    periodFrom: string;
    periodTo: string;
    costCode?: string;
    /** Redone work. Recorded against the activity and earning nothing. */
    rework?: boolean;
    evidenceDescription: string;
    evidenceHash: string;
  },
): { submissionId: string; reference: string; cumulativeIfAccepted: number; exceedsControlTotal: boolean } {
  authorise(ctx, 'FIELD_EXECUTION', 'C', { lifecyclePhase: currentPhase(ctx) });

  ctx.ledger.require({ refType: 'Task', refId: input.taskId });

  const basis = basisFor(ctx, input.taskId);
  if (!basis) {
    throw new DomainError(
      'MEASUREMENT_BASIS_REQUIRED',
      'This activity has no measurement basis, so there is no unit to claim in and no control total to claim against. ' +
        'Set it first — a claim against nothing is a number somebody will have to defend from memory.',
      409,
    );
  }
  if (input.unit.trim().toLowerCase() !== basis.unit.toLowerCase()) {
    throw new DomainError(
      'UNIT_MISMATCH',
      `This activity is measured in ${basis.unit} and the claim is in ${input.unit}. Two units against one activity is two ` +
        'honest numbers that cannot be added together.',
    );
  }
  if (!(input.quantity > 0)) {
    throw new DomainError('NOTHING_CLAIMED', 'A progress claim of zero reports nothing done, which needs no record.');
  }
  if (!input.location.trim()) {
    throw new DomainError(
      'LOCATION_REQUIRED',
      'Say where. A claim with no location cannot be checked against the one made last week, which is how the same pour ' +
        'gets paid for twice.',
    );
  }
  if (Number.isNaN(Date.parse(input.periodFrom)) || Number.isNaN(Date.parse(input.periodTo))) {
    throw new DomainError('PERIOD_REQUIRED', 'A claim covers a period. Say when it starts and when it ends.');
  }
  if (input.periodTo < input.periodFrom) {
    throw new DomainError('PERIOD_REQUIRED', 'The period ends before it begins.');
  }
  if (!input.evidenceHash.trim() || !input.evidenceDescription.trim()) {
    throw new DomainError(
      'EVIDENCE_REQUIRED',
      'A progress claim carries the evidence it rests on. This is the record a valuation is built from.',
    );
  }

  // AC-CN-WF-04-03. Not usually dishonest — a gang reporting the same pour on
  // Thursday and again on Friday — and it inflates earned value by exactly the
  // amount nobody notices.
  const duplicate = submissionsFor(ctx, input.taskId).find(
    (entry) =>
      entry.status !== 'REJECTED' &&
      entry.location.trim().toLowerCase() === input.location.trim().toLowerCase() &&
      entry.periodFrom === input.periodFrom &&
      entry.periodTo === input.periodTo &&
      entry.rework === (input.rework === true),
  );
  if (duplicate) {
    throw new DomainError(
      'DUPLICATE_CLAIM',
      `${duplicate.reference} already claims ${input.location} for ${input.periodFrom} to ${input.periodTo}. Amend that ` +
        'claim rather than adding a second — the same work claimed twice is paid for twice, and nobody sees it in a total.',
      409,
    );
  }

  const position = acceptedProgressFor(ctx, input.taskId);
  const cumulativeIfAccepted = input.rework ? position.acceptedQuantity : position.acceptedQuantity + input.quantity;

  const sequence = ctx.ledger.list(ctx.projectId, 'ProgressSubmission').length + 1;
  const reference = `PRG-${String(sequence).padStart(4, '0')}`;
  const submissionId = ulid();

  const evidence = registerEvidence(ctx, {
    type: 'PROGRESS_EVIDENCE',
    hash: input.evidenceHash,
    description: input.evidenceDescription,
    linkedEntities: [{ refType: 'Task', refId: input.taskId }],
  });

  write(ctx, {
    eventType: 'PROGRESS_REPORTED',
    entity: { refType: 'ProgressSubmission', refId: submissionId },
    nextState: {
      id: submissionId,
      projectId: ctx.projectId,
      reference,
      taskId: input.taskId,
      ...(input.costCode ? { costCode: input.costCode } : {}),
      location: input.location,
      periodFrom: input.periodFrom,
      periodTo: input.periodTo,
      unit: basis.unit,
      submittedQuantity: input.quantity,
      submittedBy: ctx.auth.actorId,
      submittedAt: new Date().toISOString(),
      rework: input.rework === true,
      status: 'SUBMITTED',
    },
    evidenceRefs: [evidence],
  });

  return {
    submissionId,
    reference,
    cumulativeIfAccepted,
    exceedsControlTotal: cumulativeIfAccepted > basis.controlTotal,
  };
}

// --- Step 4: the verifier decides -------------------------------------------

export function verifyProgress(
  ctx: EngineContext,
  submissionId: string,
  input: {
    decision: Verification;
    /** Required on an adjustment. Ignored otherwise — acceptance takes the claim. */
    acceptedQuantity?: number;
    rationale: string;
    /** Required on an adjustment: what the verifier saw that the claim did not show. */
    evidenceDescription?: string;
    evidenceHash?: string;
  },
): { reference: string; submittedQuantity: number; acceptedQuantity: number; cumulative: number } {
  // Approve, not create. Certifying progress is the act a valuation rests on,
  // and the specification is explicit that the agent never certifies alone.
  authorise(ctx, 'FIELD_EXECUTION', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = requireSubmission(ctx, submissionId);
  const state = record.state as unknown as SubmissionState;

  if (state.status !== 'SUBMITTED') {
    throw new DomainError(
      'ALREADY_VERIFIED',
      `${state.reference} was already ${state.status.toLowerCase()}. Re-deciding a claim would leave two answers on one ` +
        'record and no way to say which the valuation used.',
      409,
    );
  }
  if (state.submittedBy === ctx.auth.actorId) {
    throw new DomainError(
      'SELF_VERIFICATION_REFUSED',
      'The person who claimed the progress cannot be the person who certifies it. That separation is the entire control.',
    );
  }
  if (!input.rationale.trim()) {
    throw new DomainError('DECISION_UNEXPLAINED', 'Say what the decision rests on.');
  }

  const basis = basisFor(ctx, state.taskId);
  if (!basis) {
    throw new DomainError('MEASUREMENT_BASIS_REQUIRED', 'The activity has lost its measurement basis.', 409);
  }

  let acceptedQuantity = 0;
  if (input.decision === 'ACCEPTED') {
    acceptedQuantity = state.submittedQuantity;
  } else if (input.decision === 'ADJUSTED') {
    // The third exception control. An adjustment moves money, so it carries a
    // reason and something somebody else can look at.
    if (input.acceptedQuantity === undefined || input.acceptedQuantity < 0) {
      throw new DomainError('ADJUSTMENT_UNQUANTIFIED', 'An adjustment states the quantity being accepted.');
    }
    if (input.acceptedQuantity === state.submittedQuantity) {
      throw new DomainError(
        'ADJUSTMENT_CHANGES_NOTHING',
        'This adjustment accepts exactly what was claimed. Accept it — an adjustment that adjusts nothing makes the register ' +
          'read as though the claim was found wanting.',
      );
    }
    if (!input.evidenceHash?.trim() || !input.evidenceDescription?.trim()) {
      throw new DomainError(
        'ADJUSTMENT_UNEVIDENCED',
        'An adjustment carries what the verifier saw that the claim did not show. Without it the record says only that two ' +
          'people disagreed, and the disagreement is what gets argued about later.',
      );
    }
    acceptedQuantity = input.acceptedQuantity;
  }

  // The first exception control, applied at acceptance rather than at
  // submission: the claim is a fact about what somebody measured, and refusing
  // to record it would lose the evidence that the scope has moved.
  if (input.decision !== 'REJECTED' && !state.rework) {
    const cumulative = acceptedProgressFor(ctx, state.taskId).acceptedQuantity + acceptedQuantity;
    if (cumulative > basis.controlTotal) {
      throw new DomainError(
        'EXCEEDS_CONTROL_TOTAL',
        `Accepting ${acceptedQuantity}${basis.unit} takes the cumulative to ${cumulative}${basis.unit} against a control ` +
          `total of ${basis.controlTotal}${basis.unit} from ${basis.source}. More installed than exists is either a ` +
          'measurement error or a change nobody has raised, and both are resolved before the money moves.',
        409,
      );
    }
  }

  const evidenceRefs =
    input.evidenceHash && input.evidenceDescription
      ? [
          registerEvidence(ctx, {
            type: 'PROGRESS_EVIDENCE',
            hash: input.evidenceHash,
            description: input.evidenceDescription,
            linkedEntities: [{ refType: 'ProgressSubmission', refId: submissionId }],
          }),
        ]
      : [];

  const nextState = {
    ...record.state,
    status: input.decision,
    // Never overwrites `submittedQuantity`. AC-CN-WF-04-01: the gap between the
    // two is the finding, and a record that lost it would report a verifier's
    // number as a gang's claim.
    acceptedQuantity: input.decision === 'REJECTED' ? 0 : acceptedQuantity,
    verification: {
      decision: input.decision,
      by: ctx.auth.actorId,
      at: new Date().toISOString(),
      rationale: input.rationale,
    },
  };

  // Two explicit writes. An adjustment is a different fact from an acceptance,
  // and an audit reading the ledger should see which without opening state.
  if (input.decision === 'ADJUSTED') {
    write(ctx, {
      eventType: 'PROGRESS_ADJUSTED',
      entity: { refType: 'ProgressSubmission', refId: submissionId },
      nextState,
      ...(evidenceRefs.length > 0 ? { evidenceRefs } : {}),
    });
  } else {
    write(ctx, {
      eventType: 'PROGRESS_VERIFIED',
      entity: { refType: 'ProgressSubmission', refId: submissionId },
      nextState,
      ...(evidenceRefs.length > 0 ? { evidenceRefs } : {}),
    });
  }

  // AC-CN-WF-04-02. Acceptance is what moves the activity, so the programme,
  // earned value and the valuation are all reading the accepted figure by
  // construction rather than by three modules agreeing to.
  const position = acceptedProgressFor(ctx, state.taskId);
  const task = ctx.ledger.require({ refType: 'Task', refId: state.taskId });
  const percentComplete = Math.min(100, Number(((position.acceptedQuantity / basis.controlTotal) * 100).toFixed(2)));

  write(ctx, {
    eventType: 'TASK_UPDATED',
    entity: { refType: 'Task', refId: state.taskId },
    nextState: {
      ...task.state,
      percentComplete,
      status: percentComplete >= 100 ? 'COMPLETE' : percentComplete > 0 ? 'IN_PROGRESS' : 'NOT_STARTED',
      // Which accepted version the percentage came from, so the three readers
      // can be shown to be reading the same one.
      acceptedProgressVersion: position.version,
    },
  });

  return {
    reference: state.reference,
    submittedQuantity: state.submittedQuantity,
    acceptedQuantity: nextState.acceptedQuantity,
    cumulative: position.acceptedQuantity,
  };
}

// --- The one accepted figure ------------------------------------------------

export type AcceptedProgress = {
  taskId: string;
  /** Everything accepted, rework excluded. */
  acceptedQuantity: number;
  /** Everything claimed, whatever was accepted of it. */
  submittedQuantity: number;
  /** Redone work: a real cost, and zero earned progress. */
  reworkQuantity: number;
  unit?: string;
  controlTotal?: number;
  percentComplete: number;
  /** Rises with each accepted claim, so three readers can be shown to agree. */
  version: number;
  outstanding: number;
};

export function acceptedProgressFor(ctx: EngineContext, taskId: string): AcceptedProgress {
  const basis = basisFor(ctx, taskId);
  const submissions = submissionsFor(ctx, taskId);

  let acceptedQuantity = 0;
  let submittedQuantity = 0;
  let reworkQuantity = 0;
  let version = 0;
  let outstanding = 0;

  for (const entry of submissions) {
    submittedQuantity += entry.submittedQuantity;
    if (entry.status === 'SUBMITTED') {
      outstanding += 1;
      continue;
    }
    if (entry.status === 'REJECTED') continue;
    version += 1;
    // The second exception control. Redoing work already claimed is a real cost
    // and a real hazard to the programme; recording it as progress would report
    // a project going backwards as one going forwards.
    if (entry.rework) reworkQuantity += entry.acceptedQuantity ?? 0;
    else acceptedQuantity += entry.acceptedQuantity ?? 0;
  }

  return {
    taskId,
    acceptedQuantity: Number(acceptedQuantity.toFixed(3)),
    submittedQuantity: Number(submittedQuantity.toFixed(3)),
    reworkQuantity: Number(reworkQuantity.toFixed(3)),
    ...(basis ? { unit: basis.unit, controlTotal: basis.controlTotal } : {}),
    percentComplete: basis ? Math.min(100, Number(((acceptedQuantity / basis.controlTotal) * 100).toFixed(2))) : 0,
    version,
    outstanding,
  };
}

/**
 * Why the direct progress command is closed for this activity, or null.
 *
 * Called by `planning.recordProgress`. Where an activity has a measurement
 * basis it is under this workflow, and two doors to one money field is how they
 * diverge — the valuation reading one and the programme the other, with nothing
 * saying which is right. An activity with no basis is untouched.
 */
export function directProgressBlockedReason(ctx: EngineContext, taskId: string): string | null {
  const basis = basisFor(ctx, taskId);
  if (!basis) return null;
  return (
    `This activity is measured in ${basis.unit} against a control total of ${basis.controlTotal} from ${basis.source}, so ` +
    'its progress is claimed and then certified by somebody else rather than entered directly. Submit the claim and have it ' +
    'verified — the separation between what was claimed and what was accepted is what a valuation stands on.'
  );
}

// --- The position -----------------------------------------------------------

export type ProgressVerificationPosition = {
  activities: Array<{
    taskId: string;
    name: string;
    unit?: string;
    controlTotal?: number;
    submitted: number;
    accepted: number;
    rework: number;
    percentComplete: number;
    awaitingVerification: number;
  }>;
  /** Claims nobody has decided. This is what holds a valuation up. */
  awaiting: Array<{ reference: string; taskName: string; quantity: number; unit: string; submittedBy: string; periodTo: string }>;
  /** Where the verifier and the gang disagreed, and by how much. */
  adjustments: Array<{
    reference: string;
    taskName: string;
    submitted: number;
    accepted: number;
    unit: string;
    rationale: string;
  }>;
  /** Redone work, which earns nothing and is worth looking at. */
  rework: Array<{ reference: string; taskName: string; quantity: number; unit: string }>;
  summary: string;
};

export function progressVerificationPosition(ctx: EngineContext): ProgressVerificationPosition {
  authorise(ctx, 'FIELD_EXECUTION', 'R');

  const tasks = new Map(ctx.ledger.list(ctx.projectId, 'Task').map((record) => [record.refId, String(record.state.name)]));

  const awaiting: ProgressVerificationPosition['awaiting'] = [];
  const adjustments: ProgressVerificationPosition['adjustments'] = [];
  const rework: ProgressVerificationPosition['rework'] = [];

  for (const record of ctx.ledger.list(ctx.projectId, 'ProgressSubmission')) {
    const entry = record.state as unknown as SubmissionState;
    const taskName = tasks.get(entry.taskId) ?? entry.taskId;
    if (entry.status === 'SUBMITTED') {
      awaiting.push({
        reference: entry.reference,
        taskName,
        quantity: entry.submittedQuantity,
        unit: entry.unit,
        submittedBy: entry.submittedBy,
        periodTo: entry.periodTo,
      });
    }
    if (entry.status === 'ADJUSTED') {
      adjustments.push({
        reference: entry.reference,
        taskName,
        submitted: entry.submittedQuantity,
        accepted: entry.acceptedQuantity ?? 0,
        unit: entry.unit,
        rationale: entry.verification?.rationale ?? '',
      });
    }
    if (entry.rework && entry.status !== 'REJECTED' && entry.status !== 'SUBMITTED') {
      rework.push({
        reference: entry.reference,
        taskName,
        quantity: entry.acceptedQuantity ?? 0,
        unit: entry.unit,
      });
    }
  }

  const activities = ctx.ledger
    .list(ctx.projectId, 'MeasurementBasis')
    .map((record) => {
      const basis = record.state as unknown as MeasurementBasis;
      const accepted = acceptedProgressFor(ctx, basis.taskId);
      return {
        taskId: basis.taskId,
        name: tasks.get(basis.taskId) ?? basis.taskId,
        unit: basis.unit,
        controlTotal: basis.controlTotal,
        submitted: accepted.submittedQuantity,
        accepted: accepted.acceptedQuantity,
        rework: accepted.reworkQuantity,
        percentComplete: accepted.percentComplete,
        awaitingVerification: accepted.outstanding,
      };
    })
    .sort((a, b) => b.awaitingVerification - a.awaitingVerification);

  const parts = [`${activities.length} measured activit${activities.length === 1 ? 'y' : 'ies'}`];
  if (awaiting.length > 0) parts.push(`${awaiting.length} claim(s) awaiting verification`);
  if (adjustments.length > 0) parts.push(`${adjustments.length} adjusted on verification`);
  if (rework.length > 0) parts.push(`${rework.length} rework record(s) earning nothing`);

  return { activities, awaiting, adjustments, rework, summary: parts.join(', ') + '.' };
}
