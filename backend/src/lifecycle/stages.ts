import { DomainError, NotFoundError } from '../core/errors.ts';
import { hashEvidence } from '../core/canonical.ts';
import { ulid } from '../core/ids.ts';
import { authorise, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import { evaluatePhaseGate, nextPhase, PHASE_GATES, type GateEvaluation, type LifecyclePhase } from './phases.ts';

/**
 * Stage instances and gate reviews.
 *
 * A lifecycle stage was a string on the project and an array of past
 * transitions inside its state. That records *that* a project moved; it cannot
 * record what was frozen at the moment it moved, who decided, on what
 * authority, or what was still open when the decision was taken. Those are the
 * questions asked three years later when somebody wants to know why the design
 * was signed off with a clash still on the register — and the answer has to be
 * a record, not a reconstruction.
 *
 * So a stage occupancy becomes a first-class entity with its own status
 * machine, and the decision that ends one becomes another.
 *
 *   StageInstance:  DRAFT → ACTIVE → READY_FOR_GATE → GATE_REVIEW
 *                                  → APPROVED | REJECTED → LOCKED → SUPERSEDED
 *
 *   GateReview:     NOT_READY | READY_FOR_REVIEW
 *                             → APPROVED | APPROVED_WITH_ACTIONS | REJECTED
 *                             → SUPERSEDED
 *
 * ---
 *
 * **Two acts, two people.** Submitting a gate and deciding it are separate
 * commands, and the same person may not do both. Segregation of duties on the
 * one decision that moves a project past a control point is the whole reason
 * the control point exists; a gate one person can raise and approve is a
 * formality with a timestamp on it.
 *
 * **A decision is never AI-authored.** Every event in this module is
 * `aiAllowed: false`. The agent mandate ceiling is PROPOSE, and an agent that
 * could record a gate decision would be an agent that could approve its own
 * proposals.
 *
 * **Locking freezes component versions, not a summary.** The baseline hash
 * covers the exact `refType:refId@version` of every entity that satisfied the
 * gate. A later revision of any of them changes the hash, so a claim that "the
 * design was approved" can be checked against the design that was actually
 * approved rather than against whatever it became.
 *
 * **Re-opening never rewrites.** An authorised re-open supersedes the approved
 * instance and creates a new one carrying the reason, scope and authority. The
 * superseded record keeps the decision exactly as it was taken.
 */

export type StageStatus =
  | 'DRAFT'
  | 'ACTIVE'
  | 'READY_FOR_GATE'
  | 'GATE_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'LOCKED'
  | 'SUPERSEDED';

/**
 * The six outcomes a gate review can carry.
 *
 * `APPROVED_WITH_ACTIONS` is the one that earns its place. Real gates pass with
 * conditions attached, and a system offering only approve or reject forces that
 * into one of two lies: an approval with the conditions recorded nowhere, or a
 * rejection of work that everybody agreed should proceed. The actions travel
 * with the transition and land as open items on the stage that follows.
 */
export type GateResult =
  | 'NOT_READY'
  | 'READY_FOR_REVIEW'
  | 'APPROVED_WITH_ACTIONS'
  | 'APPROVED'
  | 'REJECTED'
  | 'SUPERSEDED';

/** A condition attached to an approval, or an item still open at a transition. */
export type GateAction = {
  id: string;
  description: string;
  /** A named person. An action with no owner is a wish, and gates are full of them. */
  ownerId: string;
  dueDate: string;
  status: 'OPEN' | 'CLOSED';
  /** Which stage raised it, so an action carried forward keeps its origin. */
  raisedInStageInstanceId: string;
};

/** The exact version of one entity at the moment a baseline was frozen. */
export type BaselineComponent = { refType: string; refId: string; version: number };

/** Statuses in which a stage instance is the project's current occupancy. */
const LIVE: StageStatus[] = ['DRAFT', 'ACTIVE', 'READY_FOR_GATE', 'GATE_REVIEW'];

// ---------------------------------------------------------------- reading

/** Every stage instance on the project, oldest first. */
export function stageInstances(ctx: EngineContext): Array<Record<string, unknown>> {
  return ctx.ledger
    .list(ctx.projectId, 'StageInstance')
    .map((record) => record.state)
    .sort((a, b) => String(a.openedAt).localeCompare(String(b.openedAt)));
}

/**
 * The occupancy the project is in now.
 *
 * `undefined` rather than throwing: projects created before stage instances
 * existed have none, and the whole point of the lazy open below is that they
 * acquire one on first use rather than needing a migration nothing can run
 * against an append-only ledger.
 */
export function currentStage(ctx: EngineContext): Record<string, unknown> | undefined {
  return stageInstances(ctx)
    .reverse()
    .find((stage) => LIVE.includes(stage.status as StageStatus));
}

export function gateReviews(ctx: EngineContext): Array<Record<string, unknown>> {
  return ctx.ledger
    .list(ctx.projectId, 'GateReview')
    .map((record) => record.state)
    .sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
}

// ---------------------------------------------------------------- opening

/**
 * Open a stage instance for the phase the project is in.
 *
 * Called on project creation, on every transition, and lazily on first use for
 * a project that predates this record. The lazy path matters: the ledger is
 * append-only, so there is no migration that can reach backwards and give an
 * existing project a stage instance for a phase it entered last year. What it
 * can do is open one now, marked as such, so the record from this point
 * forwards is complete and honest about where it starts.
 */
export function openStage(
  ctx: EngineContext,
  input: { phase: LifecyclePhase; reason: string; predecessorId?: string; carriedActions?: GateAction[] },
): Record<string, unknown> {
  const id = ulid();
  const now = new Date().toISOString();

  const { state } = write(ctx, {
    eventType: 'STAGE_INSTANCE_OPENED',
    entity: { refType: 'StageInstance', refId: id },
    nextState: {
      id,
      projectId: ctx.projectId,
      phase: input.phase,
      status: 'ACTIVE' satisfies StageStatus,
      openedAt: now,
      openedBy: ctx.auth.actorId,
      reason: input.reason,
      predecessorId: input.predecessorId ?? null,
      // Actions the previous gate left open. They are the stage's inheritance,
      // and carrying them explicitly is what stops a condition of approval from
      // evaporating at the boundary it was attached to.
      openActions: input.carriedActions ?? [],
      gateReviewIds: [],
      baselineHash: null,
      baselineComponents: [],
      lockedAt: null,
    },
  });

  return state;
}

/**
 * The project's current stage instance, opening one if it has none.
 *
 * The single door onto the current occupancy, so no caller has to decide what
 * to do about a project that predates the record.
 */
export function requireCurrentStage(ctx: EngineContext): Record<string, unknown> {
  const existing = currentStage(ctx);
  if (existing) return existing;

  const project = ctx.ledger.require({ refType: 'Project', refId: ctx.projectId });
  return openStage(ctx, {
    phase: project.state.phase as LifecyclePhase,
    reason: 'Opened on first use; this project predates stage instance records',
  });
}

// ---------------------------------------------------------- the phase change

/**
 * The one place a project's phase is written.
 *
 * Two commands move a project: `structure.transitionPhase` and `decideGate`
 * below. Each establishes its own right to — the first by clearing the gate
 * criteria, the second by carrying an approved gate decision — and then both
 * arrive here. If each wrote its own transition they would drift, and the first
 * symptom would be a stage record disagreeing with the project it describes,
 * which is fatal for a record whose whole purpose is to be trustworthy when the
 * project's own state is in doubt.
 *
 * Callers have already authorised. This does not re-check, because the two
 * callers authorise differently: one against the gate criteria, the other
 * against a second approver's decision.
 */
export function applyPhaseChange(
  ctx: EngineContext,
  input: {
    from: LifecyclePhase;
    to: LifecyclePhase;
    direction: 'FORWARD' | 'REGRESSION';
    justification: string;
    gateEvaluation: GateEvaluation['criteria'];
    /** Set by a gate decision, so the project's history names the review that authorised it. */
    gateReviewId?: string;
    /**
     * Set by a gate decision, which has already locked the outgoing instance
     * with its frozen baseline. Named rather than a boolean because the id is
     * needed anyway: by the time this runs the stage is LOCKED, so it is no
     * longer the *current* one and cannot be found by looking.
     */
    closedStageInstanceId?: string;
    carriedActions?: GateAction[];
  },
): void {
  const project = ctx.ledger.require({ refType: 'Project', refId: ctx.projectId });
  const now = new Date().toISOString();

  const evidence = registerEvidence(ctx, {
    type: 'PHASE_TRANSITION_AUTHORITY',
    hash: hashEvidence(
      JSON.stringify({
        from: input.from,
        to: input.to,
        justification: input.justification,
        gateEvaluation: input.gateEvaluation,
        gateReviewId: input.gateReviewId ?? null,
      }),
    ),
    description: `Phase transition ${input.from} -> ${input.to}: ${input.justification}`,
  });

  const history = (project.state.phaseHistory as Array<Record<string, unknown>>) ?? [];

  write(ctx, {
    eventType: 'PROJECT_PHASE_TRANSITIONED',
    entity: { refType: 'Project', refId: ctx.projectId },
    nextState: {
      ...project.state,
      phase: input.to,
      phaseHistory: [
        ...history,
        {
          phase: input.to,
          enteredAt: now,
          by: ctx.auth.actorId,
          direction: input.direction,
          justification: input.justification,
          gateEvaluation: input.gateEvaluation,
          gateReviewId: input.gateReviewId ?? null,
        },
      ],
    },
    evidenceRefs: [evidence],
  });

  // The stage record follows the project, whichever door was used.
  //
  // `closedStageInstanceId` is read rather than looked up: a gate decision has
  // already locked the outgoing instance, so `currentStage` no longer returns
  // it and the successor would be opened with no predecessor — which is how the
  // chain of stages silently loses its links.
  const outgoing = input.closedStageInstanceId
    ? ctx.ledger.get({ refType: 'StageInstance', refId: input.closedStageInstanceId })?.state
    : currentStage(ctx);

  if (outgoing && !input.closedStageInstanceId) {
    // A transition without a gate decision. The outgoing instance is closed as
    // SUPERSEDED rather than LOCKED: no gate approved it, so there is no
    // baseline to freeze, and stamping one would be a lie in the shape of a
    // hash. A regression is exactly this case and must not look like approval.
    write(ctx, {
      eventType: 'STAGE_INSTANCE_STATUS_CHANGED',
      entity: { refType: 'StageInstance', refId: outgoing.id as string },
      nextState: {
        ...outgoing,
        status: 'SUPERSEDED' satisfies StageStatus,
        supersededAt: now,
        supersededReason: `${input.direction === 'REGRESSION' ? 'Regressed' : 'Transitioned'} to ${input.to} without a gate decision: ${input.justification}`,
      },
    });
  }

  const inherited = ((outgoing?.openActions as GateAction[]) ?? []).filter((a) => a.status === 'OPEN');

  openStage(ctx, {
    phase: input.to,
    reason: input.justification,
    ...(outgoing ? { predecessorId: outgoing.id as string } : {}),
    carriedActions: input.carriedActions ?? inherited,
  });
}

// ---------------------------------------------------------------- baseline

/**
 * The exact versions of everything that satisfied a gate.
 *
 * Recorded rather than summarised. "The design was approved" is not a
 * checkable claim; "these seventeen entities at these versions were approved"
 * is, and it is what lets a later dispute establish whether the thing being
 * argued about is the thing that was signed off.
 */
function baselineComponents(ctx: EngineContext, phase: LifecyclePhase): BaselineComponent[] {
  const evaluation = evaluatePhaseGate(phase, (refType) =>
    ctx.ledger.list(ctx.projectId, refType).map((r) => r.state),
  );

  const components: BaselineComponent[] = [];
  const seen = new Set<string>();

  // Only the entity types the gate actually tests. Hashing the whole project
  // would make the baseline change every time anything moved, which would make
  // it useless as a statement about what was approved.
  for (const criterion of evaluation.criteria) {
    for (const record of ctx.ledger.list(ctx.projectId, refTypeOf(phase, criterion.id))) {
      const key = `${record.refType}:${record.refId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      components.push({ refType: record.refType, refId: record.refId, version: record.version });
    }
  }

  return components.sort((a, b) => `${a.refType}:${a.refId}`.localeCompare(`${b.refType}:${b.refId}`));
}

/**
 * The entity type a criterion tests.
 *
 * Read back off the gate definition rather than parsed out of the criterion id:
 * the id is a human-readable label and nothing stops one being renamed, whereas
 * `requires.refType` is the thing the evaluation actually uses.
 */
function refTypeOf(phase: LifecyclePhase, criterionId: string): string {
  const gate = PHASE_GATES.find((g) => g.phase === phase);
  const criterion = gate?.exitCriteria.find((c) => c.id === criterionId);
  if (!criterion) throw new DomainError('GATE_CRITERION_UNKNOWN', `No criterion ${criterionId} in ${phase}`);
  return criterion.requires.refType;
}

// ---------------------------------------------------------------- submitting

export type GateSubmission = {
  gateReviewId: string;
  result: Extract<GateResult, 'NOT_READY' | 'READY_FOR_REVIEW'>;
  evaluation: GateEvaluation;
  blockers: string[];
};

/**
 * Submit the current stage for gate review.
 *
 * Submitting does not decide anything, and a stage that is not ready may still
 * be submitted — it comes back `NOT_READY` with the blockers named. Refusing to
 * accept the submission would hide the one thing the submitter needs, which is
 * a list of what is stopping them.
 */
export function submitForGate(
  ctx: EngineContext,
  input: { comments: string },
): GateSubmission {
  // `U`, not `A`. Submitting is preparing work for review, which is the project
  // manager's job; approving is the sponsor's. The permission matrix already
  // draws that line — PM holds R and U on PROJECT_SETUP, OWNER holds R and A —
  // so the split here makes segregation of duties a matter of who holds what,
  // and not only of the self-approval check on the decision.
  authorise(ctx, 'PROJECT_SETUP', 'U');

  const stage = requireCurrentStage(ctx);
  const phase = stage.phase as LifecyclePhase;

  if (stage.status === 'GATE_REVIEW') {
    throw new DomainError(
      'GATE_ALREADY_SUBMITTED',
      `${phase} is already at gate review. Decide the open review before submitting another.`,
    );
  }

  const evaluation = evaluatePhaseGate(phase, (refType) =>
    ctx.ledger.list(ctx.projectId, refType).map((r) => r.state),
  );
  const blockers = evaluation.criteria
    .filter((c) => !c.satisfied)
    .map((c) => `${c.id}: ${c.description} (${c.found} of ${c.required})`);

  const result: GateSubmission['result'] = evaluation.passed ? 'READY_FOR_REVIEW' : 'NOT_READY';
  const id = ulid();
  const now = new Date().toISOString();

  // The completeness snapshot is evidence in its own right: it is what the
  // reviewer was shown, hashed, so a later argument about what was known at the
  // gate has an answer.
  const evidence = registerEvidence(ctx, {
    type: 'GATE_COMPLETENESS_SNAPSHOT',
    hash: hashEvidence(JSON.stringify({ phase, evaluation, blockers, submittedAt: now })),
    description: `Completeness snapshot for the ${phase} gate: ${evaluation.criteria.length} criteria, ${blockers.length} unmet`,
  });

  write(ctx, {
    eventType: 'GATE_REVIEW_SUBMITTED',
    entity: { refType: 'GateReview', refId: id },
    nextState: {
      id,
      projectId: ctx.projectId,
      stageInstanceId: stage.id,
      phase,
      result,
      submittedAt: now,
      submittedBy: ctx.auth.actorId,
      comments: input.comments,
      criteria: evaluation.criteria,
      blockers,
      // Filled by the decision. Present as null so the shape of a decided and
      // an undecided review are the same, and a reader cannot mistake a missing
      // key for a missing decision.
      decidedAt: null,
      decidedBy: null,
      authorityBasis: null,
      decisionComments: null,
      actions: [],
      openActionsAtDecision: stage.openActions ?? [],
    },
    evidenceRefs: [evidence],
  });

  write(ctx, {
    eventType: 'STAGE_INSTANCE_STATUS_CHANGED',
    entity: { refType: 'StageInstance', refId: stage.id as string },
    nextState: {
      ...stage,
      status: (evaluation.passed ? 'GATE_REVIEW' : 'READY_FOR_GATE') satisfies StageStatus,
      gateReviewIds: [...((stage.gateReviewIds as string[]) ?? []), id],
    },
  });

  return { gateReviewId: id, result, evaluation, blockers };
}

// ---------------------------------------------------------------- deciding

export type GateDecision = {
  gateReviewId: string;
  result: Extract<GateResult, 'APPROVED' | 'APPROVED_WITH_ACTIONS' | 'REJECTED'>;
  from: LifecyclePhase;
  to?: LifecyclePhase;
  baselineHash?: string;
  carriedActions: GateAction[];
};

/**
 * Decide a submitted gate.
 *
 * On approval this performs the transition transaction the specification
 * requires, in one command: freeze the baseline and its component versions,
 * lock the outgoing instance, open the incoming one, and carry the open actions
 * across with their owners and due dates.
 */
export function decideGate(
  ctx: EngineContext,
  input: {
    gateReviewId: string;
    result: GateDecision['result'];
    /** The delegation or role under which this person may approve. Recorded, not checked here. */
    authorityBasis: string;
    comments: string;
    /** Required for APPROVED_WITH_ACTIONS: the conditions attached to the approval. */
    actions?: Array<{ description: string; ownerId: string; dueDate: string }>;
    /** Where to go. Defaults to the next phase in order. */
    to?: LifecyclePhase;
  },
): GateDecision {
  authorise(ctx, 'PROJECT_SETUP', 'A');

  const review = ctx.ledger.get({ refType: 'GateReview', refId: input.gateReviewId })?.state;
  if (!review) throw new NotFoundError(`No gate review ${input.gateReviewId}`);
  if (review.projectId !== ctx.projectId) throw new NotFoundError(`No gate review ${input.gateReviewId}`);
  if (review.decidedAt) {
    throw new DomainError('GATE_ALREADY_DECIDED', `That gate review was decided as ${String(review.result)}`);
  }

  // Segregation of duties. The whole purpose of a gate is that somebody other
  // than the person doing the work confirms it is fit to pass, and a gate one
  // person can raise and approve is a formality with a timestamp on it.
  if (review.submittedBy === ctx.auth.actorId) {
    throw new DomainError(
      'GATE_SELF_APPROVAL',
      'The person who submitted a gate may not decide it. A second approver is required.',
      409,
    );
  }

  const approving = input.result !== 'REJECTED';

  if (approving && (review.blockers as string[]).length > 0) {
    throw new DomainError(
      'GATE_BLOCKERS_OPEN',
      `That gate cannot be approved with ${(review.blockers as string[]).length} unmet exit criteria: ` +
        (review.blockers as string[]).join('; '),
    );
  }

  if (input.result === 'APPROVED_WITH_ACTIONS' && !input.actions?.length) {
    throw new DomainError(
      'GATE_ACTIONS_REQUIRED',
      'An approval with actions must state the actions. Approve outright if there are none.',
    );
  }
  if (input.result === 'APPROVED' && input.actions?.length) {
    throw new DomainError(
      'GATE_ACTIONS_UNRECORDED',
      'Actions were supplied with an outright approval. Use APPROVED_WITH_ACTIONS so they are carried forward.',
    );
  }

  const stage = ctx.ledger.require({ refType: 'StageInstance', refId: review.stageInstanceId as string }).state;
  const from = stage.phase as LifecyclePhase;
  const now = new Date().toISOString();

  // Resolved here, before anything is written.
  //
  // This used to sit after the decision event, and at the last phase it threw —
  // leaving a review marked APPROVED with its actions carried nowhere and its
  // stage never locked, while the caller got an error saying nothing had
  // happened. An append-only ledger has no way to take that back. Every reason
  // to refuse now precedes every write.
  //
  // At the terminal phase an approval is an **assurance gate**, not a
  // transition. Operations is continuous and runs for thirty years; it is
  // reviewed annually and at each change, refurbishment or replacement, and a
  // system that could only approve a gate by moving somewhere would have no way
  // to record any of that. So the stage is locked with its baseline and a fresh
  // instance of the same phase opens behind it — the assurance cycle, with each
  // period's frozen position kept.
  const to = input.to ?? nextPhase(from);
  const assuranceOnly = to === undefined;

  const newActions: GateAction[] = (input.actions ?? []).map((action) => ({
    id: ulid(),
    description: action.description,
    ownerId: action.ownerId,
    dueDate: action.dueDate,
    status: 'OPEN',
    raisedInStageInstanceId: stage.id as string,
  }));

  const decisionEvidence = registerEvidence(ctx, {
    type: 'GATE_DECISION_AUTHORITY',
    hash: hashEvidence(
      JSON.stringify({
        gateReviewId: input.gateReviewId,
        result: input.result,
        decidedBy: ctx.auth.actorId,
        authorityBasis: input.authorityBasis,
        decidedAt: now,
      }),
    ),
    description: `${input.result} at the ${from} gate by ${ctx.auth.actorId} under ${input.authorityBasis}`,
  });

  write(ctx, {
    eventType: 'GATE_REVIEW_DECIDED',
    entity: { refType: 'GateReview', refId: input.gateReviewId },
    nextState: {
      ...review,
      result: input.result,
      decidedAt: now,
      decidedBy: ctx.auth.actorId,
      authorityBasis: input.authorityBasis,
      decisionComments: input.comments,
      actions: newActions,
    },
    evidenceRefs: [decisionEvidence],
  });

  if (!approving) {
    // A rejected stage goes back to work rather than closing. The review stays
    // as it was decided, so the rejection is on the record even though the
    // stage it rejected carries on.
    write(ctx, {
      eventType: 'STAGE_INSTANCE_STATUS_CHANGED',
      entity: { refType: 'StageInstance', refId: stage.id as string },
      nextState: { ...stage, status: 'ACTIVE' satisfies StageStatus },
    });
    return { gateReviewId: input.gateReviewId, result: input.result, from, carriedActions: [] };
  }

  // --- the transition transaction ------------------------------------------

  const components = baselineComponents(ctx, from);
  const baselineHash = hashEvidence(
    JSON.stringify({ phase: from, gateReviewId: input.gateReviewId, components }),
  );

  const lockEvidence = registerEvidence(ctx, {
    type: 'STAGE_BASELINE',
    hash: baselineHash,
    description: `${from} baseline frozen at ${assuranceOnly ? 'assurance review' : 'gate'}: ${components.length} components`,
  });

  write(ctx, {
    eventType: 'STAGE_INSTANCE_LOCKED',
    entity: { refType: 'StageInstance', refId: stage.id as string },
    nextState: {
      ...stage,
      status: 'LOCKED' satisfies StageStatus,
      lockedAt: now,
      lockedBy: ctx.auth.actorId,
      baselineHash,
      baselineComponents: components,
      decidedByGateReviewId: input.gateReviewId,
    },
    evidenceRefs: [lockEvidence],
  });

  // Everything still open travels: the conditions of this approval, plus
  // anything an earlier gate left open that nobody has closed since.
  const inherited = ((stage.openActions as GateAction[]) ?? []).filter((a) => a.status === 'OPEN');
  const carried = [...inherited, ...newActions];

  if (assuranceOnly) {
    // The project does not move, so no PROJECT_PHASE_TRANSITIONED is written —
    // claiming a transition that did not happen would put a phase change in the
    // project's history that nothing corresponds to. The period just reviewed
    // is locked with its baseline above; this opens the next one.
    openStage(ctx, {
      phase: from,
      reason: `${input.result} at the ${from} assurance review (${input.gateReviewId}): ${input.comments}`,
      predecessorId: stage.id as string,
      carriedActions: carried,
    });

    return { gateReviewId: input.gateReviewId, result: input.result, from, baselineHash, carriedActions: carried };
  }

  // The outgoing instance was locked above with its frozen baseline, so this
  // must not close it again — hence `closedStageInstanceId`. The distinction is
  // the point: a gate-approved stage is LOCKED with a hash, an ungated one is
  // SUPERSEDED with none, and the two must never be confused for each other.
  applyPhaseChange(ctx, {
    from,
    to,
    direction: 'FORWARD',
    justification: `${input.result} at the ${from} gate: ${input.comments}`,
    gateEvaluation: review.criteria as GateEvaluation['criteria'],
    gateReviewId: input.gateReviewId,
    closedStageInstanceId: stage.id as string,
    carriedActions: carried,
  });

  return { gateReviewId: input.gateReviewId, result: input.result, from, to, baselineHash, carriedActions: carried };
}

// ---------------------------------------------------------------- reopening

/**
 * Re-enter a stage the project has already left.
 *
 * Projects genuinely re-enter design and re-tender, and a system that cannot
 * express it gets one that lies instead. What must not happen is the approved
 * instance being edited: the decision taken at the time was taken on the
 * evidence available at the time, and rewriting it destroys the only record of
 * what was actually known. So this supersedes and opens anew.
 */
export function reopenStage(
  ctx: EngineContext,
  input: { phase: LifecyclePhase; reason: string; scope: string },
): { stageInstanceId: string; supersededId: string | null } {
  authorise(ctx, 'PROJECT_SETUP', 'A');

  if (!input.reason.trim() || !input.scope.trim()) {
    throw new DomainError('REOPEN_UNJUSTIFIED', 'Re-opening a stage requires a stated reason and scope.');
  }

  // The most recent locked instance of that phase, which is the one being
  // returned to. An earlier one is history and stays history.
  const previous = stageInstances(ctx)
    .reverse()
    .find((s) => s.phase === input.phase && s.status === 'LOCKED');

  const live = currentStage(ctx);
  const now = new Date().toISOString();

  const evidence = registerEvidence(ctx, {
    type: 'STAGE_REOPEN_AUTHORITY',
    hash: hashEvidence(JSON.stringify({ phase: input.phase, reason: input.reason, scope: input.scope, at: now })),
    description: `Re-open ${input.phase}: ${input.reason}`,
  });

  // The instance being left is superseded rather than locked: it did not reach
  // a gate, so there is no approved baseline to freeze and claiming one would
  // be a lie in the shape of a hash.
  if (live) {
    write(ctx, {
      eventType: 'STAGE_INSTANCE_STATUS_CHANGED',
      entity: { refType: 'StageInstance', refId: live.id as string },
      nextState: {
        ...live,
        status: 'SUPERSEDED' satisfies StageStatus,
        supersededAt: now,
        supersededReason: `Project re-opened at ${input.phase}: ${input.reason}`,
      },
    });
  }

  const id = ulid();
  const carried = ((live?.openActions as GateAction[]) ?? []).filter((a) => a.status === 'OPEN');

  write(ctx, {
    eventType: 'STAGE_REOPENED',
    entity: { refType: 'StageInstance', refId: id },
    nextState: {
      id,
      projectId: ctx.projectId,
      phase: input.phase,
      status: 'ACTIVE' satisfies StageStatus,
      openedAt: now,
      openedBy: ctx.auth.actorId,
      reason: input.reason,
      scope: input.scope,
      // The approved instance this returns to. It keeps its own status and its
      // own baseline; this is a pointer to it, not a change to it.
      reopensStageInstanceId: previous?.id ?? null,
      predecessorId: live?.id ?? null,
      openActions: carried,
      gateReviewIds: [],
      baselineHash: null,
      baselineComponents: [],
      lockedAt: null,
    },
    evidenceRefs: [evidence],
  });

  return { stageInstanceId: id, supersededId: (live?.id as string) ?? null };
}

// ---------------------------------------------------------------- actions

/** Close an action a gate left open. */
export function closeAction(
  ctx: EngineContext,
  input: { actionId: string; evidenceNote: string },
): { closed: GateAction } {
  // Closing a condition is delivery work, like the work that satisfies it.
  authorise(ctx, 'PROJECT_SETUP', 'U');

  const stage = requireCurrentStage(ctx);
  const actions = ((stage.openActions as GateAction[]) ?? []).slice();
  const index = actions.findIndex((a) => a.id === input.actionId);

  if (index === -1) throw new NotFoundError(`No open gate action ${input.actionId} on the current stage`);
  if (actions[index]!.status === 'CLOSED') {
    throw new DomainError('ACTION_ALREADY_CLOSED', 'That gate action is already closed.');
  }

  const closed: GateAction = { ...actions[index]!, status: 'CLOSED' };
  actions[index] = closed;

  write(ctx, {
    eventType: 'STAGE_INSTANCE_STATUS_CHANGED',
    entity: { refType: 'StageInstance', refId: stage.id as string },
    nextState: {
      ...stage,
      openActions: actions,
      actionClosures: [
        ...((stage.actionClosures as unknown[]) ?? []),
        {
          actionId: input.actionId,
          closedAt: new Date().toISOString(),
          closedBy: ctx.auth.actorId,
          evidenceNote: input.evidenceNote,
        },
      ],
    },
  });

  return { closed };
}
