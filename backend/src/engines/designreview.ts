import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from './context.ts';
import type { EntityRef } from '../goldenthread/types.ts';
import type { CDEState } from '../domain/designplan.ts';

/**
 * The design review cycle.
 *
 * The design stage could hold documents and answer questions about them —
 * drawings with revisions and supersession, markups, specification clauses,
 * RFIs, maturity assessment — and it had no way to **review** one. There was no
 * submission, no comment, no disposition and no acceptance, so a deliverable
 * went from registered to used with nothing in between.
 *
 * That is the gap where projects are quietly lost. An uncoordinated package
 * that nobody formally rejected is built, and the argument three years later is
 * about who should have said something.
 *
 * ---
 *
 * **The cycle names what it reviews by reference, not by type.** A deliverable
 * is a drawing, a model, a specification or a calculation, and inventing a
 * wrapper object to sit above all four would be a second identity for something
 * the ledger already identifies. The cycle carries an `EntityRef`, so it works
 * over any of them and over the next one without being changed.
 *
 * **A comment cannot disappear.** The ledger is append-only, so this is nearly
 * free — but "nearly" is where it goes wrong, so the disposition is written as
 * an update to the comment rather than as a replacement of it, and every state
 * the comment passed through stays readable. `AC-D-WF-03-01` asks for creator,
 * location, evidence, response, final disposition and timestamps, and all six
 * are on the record from the moment it exists.
 *
 * **Publication is impossible with a blocking comment open.** Not discouraged,
 * not warned about: refused. `ACCEPTED_WITH_COMMENTS` is the status this rule
 * exists for — it is the one that looks like completion while something material
 * is open, which is the same shape as a payment certificate issued without a
 * pay-less notice and is refused for the same reason.
 *
 * **The author cannot check their own work.** The same rule the phase gate
 * already enforces, and it is enforced per act rather than by role: a person who
 * holds both authorship and approval in the matrix still cannot do both to the
 * same deliverable.
 *
 * **Lateness is a fact about the review, not a nag.** The cycle carries the date
 * it was due, and the position read reports what is overdue, by how long, and
 * whose it is. A late review is a programme event and it is reported as one.
 */

/** How much a comment matters, and whether it stops publication. */
export const COMMENT_SEVERITY = ['CRITICAL', 'MAJOR', 'MINOR', 'OBSERVATION'] as const;
export type CommentSeverity = (typeof COMMENT_SEVERITY)[number];

/**
 * Critical and major block. Minor and observation do not.
 *
 * The line is drawn here rather than at each call site so that "what blocks"
 * is one fact the whole platform shares — the console reads it from the API
 * rather than holding a second copy.
 */
export const BLOCKING_SEVERITIES: readonly CommentSeverity[] = ['CRITICAL', 'MAJOR'];

export function blocks(severity: CommentSeverity): boolean {
  return BLOCKING_SEVERITIES.includes(severity);
}

/** What the author did about a comment. Never "closed" — that hides which way. */
export const COMMENT_DISPOSITION = ['ACCEPTED', 'REJECTED', 'ALTERNATIVE_PROPOSED'] as const;
export type CommentDisposition = (typeof COMMENT_DISPOSITION)[number];

/** The accepting party's decision on the deliverable. */
export const REVIEW_DECISION = [
  'ACCEPTED',
  'ACCEPTED_WITH_COMMENTS',
  'REVISE_AND_RESUBMIT',
  'REJECTED',
] as const;
export type ReviewDecision = (typeof REVIEW_DECISION)[number];

/**
 * Where a review cycle leaves its deliverable in the common data environment.
 *
 * This used to declare its own four states, with a note saying they stood in
 * "until containers carry their own". Containers now do — `domain/cde.ts` holds
 * the environment and `domain/designplan.ts` names the states — so the local
 * copy became a second definition of one concept, spelling work in progress
 * differently from the one the API publishes. Two vocabularies for the same
 * ladder is the failure a CDE exists to remove; having it inside the CDE would
 * be a poor joke.
 *
 * Re-exported rather than aliased away, because callers of this engine ask it
 * what state a decision leaves a deliverable in, and that is a question about
 * the review cycle. The answer now comes from one place.
 */
export { CDE_STATE } from '../domain/designplan.ts';
export type CdeState = CDEState;

export type ReviewComment = {
  id: string;
  cycleId: string;
  severity: CommentSeverity;
  blocking: boolean;
  /** Where in the deliverable: a clause, an object GUID, a sheet region. */
  location: string;
  comment: string;
  raisedBy: string;
  raisedAt: string;
  evidenceRef?: EntityRef;
  disposition?: CommentDisposition;
  response?: string;
  respondedBy?: string;
  respondedAt?: string;
  /** True once the checker who raised it agrees the response settles it. */
  closed: boolean;
  closedBy?: string;
  closedAt?: string;
};

/**
 * Submit a deliverable for review.
 *
 * The self-check declaration is required and is not a tick box: it is the
 * author saying, on the record, what they checked before asking somebody else
 * to. A submission without one is a deliverable thrown over a wall.
 */
export function submitForReview(
  ctx: EngineContext,
  input: {
    /** The drawing, model or specification being reviewed. */
    deliverable: EntityRef;
    /** What the author checked before submitting. Recorded verbatim. */
    selfCheck: string;
    /** Who is to check it. Named, because "the design team" is not an owner. */
    checkerId: string;
    /** When the review is due back. Lateness is measured against this. */
    dueBy: string;
    purpose?: string;
  },
): { cycleId: string; revision: number } {
  authorise(ctx, 'DESIGN_INFORMATION', 'C', { lifecyclePhase: currentPhase(ctx) });

  const deliverable = ctx.ledger.get(input.deliverable);
  if (!deliverable || deliverable.projectId !== ctx.projectId) {
    throw new DomainError('DELIVERABLE_NOT_FOUND', `No ${input.deliverable.refType} ${input.deliverable.refId} on this project`);
  }

  if (input.selfCheck.trim().length < 20) {
    throw new DomainError(
      'SELF_CHECK_REQUIRED',
      'A submission carries the author’s own check. State what you verified before asking somebody else to.',
    );
  }

  // A deliverable already in review cannot be submitted again. Two open cycles
  // over one thing means two sets of comments nobody reconciles.
  const open = openCycleFor(ctx, input.deliverable);
  if (open) {
    throw new DomainError(
      'REVIEW_ALREADY_OPEN',
      `${input.deliverable.refType} ${input.deliverable.refId} is already in review (${open.state.reference}). Decide that cycle first.`,
      409,
    );
  }

  // Revisions are counted rather than assumed: a third cycle over the same
  // deliverable is a fact worth reading off the record, and it is what "revise
  // and resubmit" produces.
  const previous = cyclesFor(ctx, input.deliverable);
  const revision = previous.length + 1;

  const cycleId = ulid();
  write(ctx, {
    eventType: 'DESIGN_SUBMITTED_FOR_REVIEW',
    entity: { refType: 'DesignReviewCycle', refId: cycleId },
    nextState: {
      id: cycleId,
      projectId: ctx.projectId,
      reference: `DR-${String(revision).padStart(3, '0')}-${input.deliverable.refId.slice(-6)}`,
      deliverable: input.deliverable,
      revision,
      purpose: input.purpose ?? 'Technical review',
      selfCheck: input.selfCheck.trim(),
      // The author, from the session rather than from the request. A submission
      // naming somebody else as its author is how maker-checker gets bypassed.
      submittedBy: ctx.auth.actorId,
      submittedAt: new Date().toISOString(),
      checkerId: input.checkerId,
      dueBy: input.dueBy,
      // Submission moves it out of work-in-progress. It does not publish it.
      cdeState: 'SHARED' satisfies CdeState,
      status: 'IN_REVIEW',
      decision: null,
      decidedBy: null,
      decidedAt: null,
    },
  });

  return { cycleId, revision };
}

/** Raise a comment against a deliverable in review. */
export function raiseComment(
  ctx: EngineContext,
  input: {
    cycleId: string;
    severity: CommentSeverity;
    /** A clause number, an object GUID, a grid reference — where, exactly. */
    location: string;
    comment: string;
    evidenceHash?: string;
  },
): { commentId: string; blocking: boolean } {
  authorise(ctx, 'DESIGN_INFORMATION', 'R');

  const cycle = requireOpenCycle(ctx, input.cycleId);

  // Maker-checker, per act rather than per role. Twenty-six roles hold both
  // authorship and approval in an area, deliberately, and separation is a rule
  // about two acts by one person — so it is checked here, against this
  // deliverable, and not against the permission matrix.
  if (cycle.state.submittedBy === ctx.auth.actorId) {
    throw new DomainError(
      'REVIEW_SELF_CHECK',
      'The person who submitted a deliverable may not check it. That is what the self-check declaration was for.',
      409,
    );
  }

  if (input.location.trim() === '') {
    throw new DomainError(
      'COMMENT_LOCATION_REQUIRED',
      'A comment with no location cannot be actioned. Name the clause, object or region it is about.',
    );
  }

  const evidenceRef = input.evidenceHash
    ? registerEvidence(ctx, {
        type: 'DESIGN_REVIEW_COMMENT',
        hash: input.evidenceHash,
        description: `Evidence for a ${input.severity.toLowerCase()} comment at ${input.location}`,
        linkedEntities: [{ refType: 'DesignReviewCycle', refId: input.cycleId }],
      })
    : undefined;

  const commentId = ulid();
  write(ctx, {
    eventType: 'REVIEW_COMMENT_RAISED',
    entity: { refType: 'DesignReviewComment', refId: commentId },
    nextState: {
      id: commentId,
      projectId: ctx.projectId,
      cycleId: input.cycleId,
      severity: input.severity,
      // Derived once and stored, so a later change to what blocks cannot
      // silently reclassify comments that were already dispositioned against
      // the old rule.
      blocking: blocks(input.severity),
      location: input.location.trim(),
      comment: input.comment,
      raisedBy: ctx.auth.actorId,
      raisedAt: new Date().toISOString(),
      evidenceRef,
      disposition: null,
      response: null,
      respondedBy: null,
      respondedAt: null,
      closed: false,
      closedBy: null,
      closedAt: null,
    },
    ...(evidenceRef ? { evidenceRefs: [evidenceRef] } : {}),
  });

  return { commentId, blocking: blocks(input.severity) };
}

/**
 * The author's answer to a comment.
 *
 * Three ways, and they are kept apart because they mean different things to
 * whoever reads the register later. Accepting means the design changes.
 * Rejecting means the author says the comment is wrong, which the checker may
 * still disagree with. Proposing an alternative means neither — and collapsing
 * the three into "responded" would lose the only part anybody cares about.
 */
export function dispositionComment(
  ctx: EngineContext,
  input: { commentId: string; disposition: CommentDisposition; response: string },
): ReviewComment {
  authorise(ctx, 'DESIGN_INFORMATION', 'U');

  const record = ctx.ledger.require({ refType: 'DesignReviewComment', refId: input.commentId });
  const comment = record.state as unknown as ReviewComment;

  if (comment.closed) {
    throw new DomainError('COMMENT_CLOSED', 'This comment is closed. Raise a new one on the next cycle.', 409);
  }
  if (input.response.trim().length < 10) {
    throw new DomainError(
      'RESPONSE_REQUIRED',
      'A disposition carries the reasoning behind it. "Noted" is not a response to a comment somebody raised.',
    );
  }

  // The author answers; the checker does not answer their own comment.
  const cycle = ctx.ledger.require({ refType: 'DesignReviewCycle', refId: comment.cycleId });
  if (cycle.state.submittedBy !== ctx.auth.actorId) {
    throw new DomainError(
      'NOT_THE_AUTHOR',
      'Only the person who submitted the deliverable answers a comment on it.',
      403,
    );
  }

  const next: ReviewComment = {
    ...comment,
    disposition: input.disposition,
    response: input.response.trim(),
    respondedBy: ctx.auth.actorId,
    respondedAt: new Date().toISOString(),
  };

  write(ctx, {
    eventType: 'COMMENT_DISPOSITIONED',
    entity: { refType: 'DesignReviewComment', refId: input.commentId },
    nextState: next as unknown as Record<string, unknown>,
  });

  return next;
}

/**
 * The checker agrees a response settles the comment.
 *
 * Separate from the disposition on purpose: an author saying they have dealt
 * with something is not the same as the person who raised it agreeing. A
 * blocking comment stays blocking until this happens, which is what stops a
 * deliverable being published on the strength of its author's own opinion.
 */
export function closeComment(ctx: EngineContext, input: { commentId: string; note?: string }): ReviewComment {
  authorise(ctx, 'DESIGN_INFORMATION', 'R');

  const record = ctx.ledger.require({ refType: 'DesignReviewComment', refId: input.commentId });
  const comment = record.state as unknown as ReviewComment;

  if (comment.closed) return comment;
  if (!comment.disposition) {
    throw new DomainError(
      'NOT_DISPOSITIONED',
      'The author has not answered this comment yet. There is nothing to agree with.',
    );
  }

  const cycle = ctx.ledger.require({ refType: 'DesignReviewCycle', refId: comment.cycleId });
  if (cycle.state.submittedBy === ctx.auth.actorId) {
    throw new DomainError(
      'REVIEW_SELF_CHECK',
      'The author may not close a comment on their own deliverable. The person who raised it decides whether it is settled.',
      409,
    );
  }

  const next: ReviewComment = {
    ...comment,
    closed: true,
    closedBy: ctx.auth.actorId,
    closedAt: new Date().toISOString(),
    ...(input.note ? { closureNote: input.note } : {}),
  } as ReviewComment;

  write(ctx, {
    eventType: 'COMMENT_DISPOSITIONED',
    entity: { refType: 'DesignReviewComment', refId: input.commentId },
    nextState: next as unknown as Record<string, unknown>,
  });

  return next;
}

/**
 * The accepting party's decision.
 *
 * `AC-D-WF-03-02` — publication is impossible with blocking comments — is
 * enforced here, and it is a refusal rather than a warning.
 *
 * `ACCEPTED_WITH_COMMENTS` is the status the rule exists for. It is the one
 * that reads as done while something material is open, and on a real project it
 * is the one that gets used to keep a programme moving. A deliverable accepted
 * with three open critical comments is a deliverable somebody will build from.
 */
export function decideReview(
  ctx: EngineContext,
  input: { cycleId: string; decision: ReviewDecision; reason: string },
): { decision: ReviewDecision; cdeState: CdeState; openBlocking: number } {
  authorise(ctx, 'DESIGN_INFORMATION', 'A', { lifecyclePhase: currentPhase(ctx) });

  const cycle = requireOpenCycle(ctx, input.cycleId);

  if (cycle.state.submittedBy === ctx.auth.actorId) {
    throw new DomainError(
      'REVIEW_SELF_APPROVAL',
      'The person who submitted a deliverable may not accept it. A second party decides.',
      409,
    );
  }
  if (input.reason.trim().length < 10) {
    throw new DomainError('REASON_REQUIRED', 'A decision on a deliverable carries its reasoning.');
  }

  const comments = commentsFor(ctx, input.cycleId);
  const openBlocking = comments.filter((comment) => comment.blocking && !comment.closed);

  // The refusal. Both accepting statuses are barred, and the message names the
  // comments rather than saying "there are blockers" — the person deciding has
  // to be able to go and look at them.
  if (openBlocking.length > 0 && (input.decision === 'ACCEPTED' || input.decision === 'ACCEPTED_WITH_COMMENTS')) {
    throw new DomainError(
      'BLOCKING_COMMENTS_OPEN',
      `${openBlocking.length} blocking comment${openBlocking.length === 1 ? '' : 's'} ` +
        `${openBlocking.length === 1 ? 'is' : 'are'} still open: ` +
        `${openBlocking.slice(0, 4).map((comment) => `${comment.severity} at ${comment.location}`).join('; ')}` +
        `${openBlocking.length > 4 ? ` and ${openBlocking.length - 4} more` : ''}. ` +
        'Accepted with comments may not conceal them. Close them, or revise and resubmit.',
      409,
    );
  }

  // Only acceptance publishes. Revise-and-resubmit sends it back to the author,
  // and a rejection leaves it where it was — neither becomes a published
  // revision, because a published revision is what everybody downstream builds
  // from.
  const cdeState: CdeState =
    input.decision === 'ACCEPTED' || input.decision === 'ACCEPTED_WITH_COMMENTS' ? 'PUBLISHED' : 'WIP';

  const nextState = {
    ...cycle.state,
    status: 'DECIDED',
    decision: input.decision,
    decisionReason: input.reason.trim(),
    decidedBy: ctx.auth.actorId,
    decidedAt: new Date().toISOString(),
    cdeState,
    // What was open at the moment of the decision, frozen. A register read later
    // shows today's comments; this shows what the decision was actually taken
    // against.
    openCommentsAtDecision: comments.filter((comment) => !comment.closed).length,
    openBlockingAtDecision: openBlocking.length,
  };

  // Two calls rather than one with a conditional event type. Accepting a design
  // and rejecting one are different acts, and writing them through a ternary
  // makes them read as one variation of the same thing. It also keeps both
  // event names findable in the source, which is how the catalogue test proves
  // no event in the closed list is dead — an event nothing can emit reads as a
  // capability the platform does not have.
  if (input.decision === 'REJECTED') {
    write(ctx, { eventType: 'DESIGN_REJECTED', entity: { refType: 'DesignReviewCycle', refId: input.cycleId }, nextState });
  } else {
    write(ctx, { eventType: 'DESIGN_ACCEPTED', entity: { refType: 'DesignReviewCycle', refId: input.cycleId }, nextState });
  }

  return { decision: input.decision, cdeState, openBlocking: openBlocking.length };
}

// --- reads -----------------------------------------------------------------

function cyclesFor(ctx: EngineContext, deliverable: EntityRef) {
  return ctx.ledger
    .list(ctx.projectId, 'DesignReviewCycle')
    .filter((record) => {
      const ref = record.state.deliverable as EntityRef | undefined;
      return ref?.refType === deliverable.refType && ref?.refId === deliverable.refId;
    });
}

function openCycleFor(ctx: EngineContext, deliverable: EntityRef) {
  return cyclesFor(ctx, deliverable).find((record) => record.state.status === 'IN_REVIEW');
}

function requireOpenCycle(ctx: EngineContext, cycleId: string) {
  const cycle = ctx.ledger.require({ refType: 'DesignReviewCycle', refId: cycleId });
  if (cycle.state.status !== 'IN_REVIEW') {
    throw new DomainError('REVIEW_NOT_OPEN', 'This review cycle has been decided. A new cycle is needed.', 409);
  }
  return cycle;
}

export function commentsFor(ctx: EngineContext, cycleId: string): ReviewComment[] {
  return ctx.ledger
    .list(ctx.projectId, 'DesignReviewComment')
    .map((record) => record.state as unknown as ReviewComment)
    .filter((comment) => comment.cycleId === cycleId)
    .sort((a, b) => {
      // Blocking first, then by severity, then oldest. A register that opened on
      // the newest observation would bury the thing stopping publication.
      const order = { CRITICAL: 0, MAJOR: 1, MINOR: 2, OBSERVATION: 3 };
      return (
        Number(b.blocking) - Number(a.blocking) ||
        order[a.severity] - order[b.severity] ||
        a.raisedAt.localeCompare(b.raisedAt)
      );
    });
}

export type ReviewPosition = {
  cycles: Array<{
    cycleId: string;
    reference: string;
    deliverable: EntityRef;
    revision: number;
    status: string;
    decision: ReviewDecision | null;
    cdeState: CdeState;
    submittedBy: string;
    checkerId: string;
    submittedAt: string;
    dueBy: string;
    /** Days the review has been open, or took. */
    durationDays: number;
    /** Positive where it is past its date. Absent once decided. */
    daysOverdue?: number;
    comments: { total: number; open: number; blocking: number };
    /** Whose it is right now, and why it is theirs. */
    waitingOn: string;
  }>;
  openCycles: number;
  overdue: number;
  blockedFromPublication: number;
  summary: string;
};

/**
 * Where every review stands.
 *
 * `AC-D-WF-03-03` asks for review duration and overdue ownership on the design
 * dashboard, and both are computed here rather than in the console: the screen
 * gets the answer, not the arithmetic.
 *
 * **`waitingOn` is the field that makes this usable.** A list of open reviews
 * tells a design manager nothing they did not know. A list that says which of
 * them is sitting with the checker, which is back with the author, and which is
 * waiting on an acceptance is a morning's work in order.
 */
export function reviewPosition(ctx: EngineContext, today = new Date().toISOString().slice(0, 10)): ReviewPosition {
  authorise(ctx, 'DESIGN_INFORMATION', 'R');

  const days = (from: string, to: string) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000));

  const cycles = ctx.ledger.list(ctx.projectId, 'DesignReviewCycle').map((record) => {
    const state = record.state;
    const comments = commentsFor(ctx, record.refId);
    const open = comments.filter((comment) => !comment.closed);
    const blocking = open.filter((comment) => comment.blocking);
    const decided = state.status === 'DECIDED';
    const until = decided ? String(state.decidedAt).slice(0, 10) : today;
    const overdue = decided ? 0 : days(String(state.dueBy).slice(0, 10), today);

    return {
      cycleId: record.refId,
      reference: String(state.reference),
      deliverable: state.deliverable as EntityRef,
      revision: Number(state.revision),
      status: String(state.status),
      decision: (state.decision ?? null) as ReviewDecision | null,
      cdeState: state.cdeState as CdeState,
      submittedBy: String(state.submittedBy),
      checkerId: String(state.checkerId),
      submittedAt: String(state.submittedAt),
      dueBy: String(state.dueBy),
      durationDays: days(String(state.submittedAt).slice(0, 10), until),
      ...(overdue > 0 ? { daysOverdue: overdue } : {}),
      comments: { total: comments.length, open: open.length, blocking: blocking.length },
      waitingOn: decided
        ? 'Decided'
        : blocking.length > 0 && blocking.every((comment) => comment.disposition)
          ? 'The checker, to agree the responses settle the blocking comments'
          : open.some((comment) => !comment.disposition)
            ? 'The author, to answer the open comments'
            : comments.length === 0
              ? 'The checker, to review it'
              : 'The accepting party, to decide it',
    };
  });

  const openCycles = cycles.filter((cycle) => cycle.status === 'IN_REVIEW');
  const overdue = openCycles.filter((cycle) => cycle.daysOverdue !== undefined);
  const blocked = openCycles.filter((cycle) => cycle.comments.blocking > 0);

  return {
    cycles: cycles.sort((a, b) => (b.daysOverdue ?? -1) - (a.daysOverdue ?? -1) || b.submittedAt.localeCompare(a.submittedAt)),
    openCycles: openCycles.length,
    overdue: overdue.length,
    blockedFromPublication: blocked.length,
    summary:
      cycles.length === 0
        ? 'Nothing has been submitted for review.'
        : `${openCycles.length} review${openCycles.length === 1 ? '' : 's'} open` +
          `${overdue.length > 0 ? `, ${overdue.length} past the date it was due back — worst ${Math.max(...overdue.map((c) => c.daysOverdue ?? 0))} days` : ', none overdue'}` +
          `${blocked.length > 0 ? `. ${blocked.length} cannot be published until blocking comments are closed` : ''}.`,
  };
}
