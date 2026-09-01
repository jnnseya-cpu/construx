import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';

/**
 * Reviewing the programme, and what silence is not.
 *
 * A programme is issued and everybody has an opinion about it, and on most jobs
 * those opinions live in email. Six months later, when the delay is being
 * argued, the question is which version of the sequence the steelwork
 * subcontractor objected to and on what date — and the answer is in somebody's
 * inbox, if it is anywhere.
 *
 * ---
 *
 * ## A review is of a *run*, not of "the programme"
 *
 * The single decision this module is built around. A comment attaches to the
 * schedule run it was made about, because the programme changes weekly and a
 * comment floating free of a version is unusable: "we cannot do that sequence"
 * means nothing without knowing which sequence.
 *
 * Re-running the schedule does not move or close an open review. The review goes
 * on being about the run it was opened against, and the position says so —
 * otherwise the act of rescheduling would quietly discard every objection made
 * to the version being replaced, which is precisely the version somebody would
 * later want to point at.
 *
 * ## Silence is not agreement
 *
 * Standard forms commonly deem a programme accepted if it is not objected to
 * within a period, and a register that reports "3 objections, everybody else
 * fine" encodes that deeming as a fact. It is not a fact. It is a contractual
 * consequence of a contractual term, and whether it applies is a question about
 * the contract rather than about who happened to open their email.
 *
 * So three states, kept apart: **objected**, **reviewed with no objection**, and
 * **did not respond**. The third is reported as itself and never folded into the
 * second, because they are the difference between a party who looked and a party
 * who did not, and only one of those is evidence of anything.
 *
 * ## What it refuses
 *
 * **Rejecting a comment without a reason.** A rejection is the planner's answer
 * to a party who will be reading it back to them in an adjudication, and "no"
 * on its own is the answer that makes the adjudication worth having.
 *
 * **Commenting on a review that has closed.** A closed review is a record of
 * what was said by the closing date; letting a late comment in changes what that
 * record says about the date it was closed on.
 */

/**
 * What a comment is about.
 *
 * A closed list because the register's whole use is that it can be read as a
 * pattern — twelve access objections against one contractor is a different
 * conversation from twelve scattered ones — and free text cannot be counted.
 */
export const COMMENT_KIND = {
  SEQUENCE: {
    label: 'The order of the work',
    matters: 'The commonest objection and the one most likely to be right: the person doing the work knows what has to come first.',
  },
  DURATION: {
    label: 'How long an activity is allowed',
    matters: 'A duration the party doing the work says is wrong is a duration that will be wrong, whatever the programme says.',
  },
  ACCESS: {
    label: 'When the area is actually available',
    matters:
      'An access date the programme assumes and nobody has committed to. This is the objection that becomes an ' +
      'extension of time, and it is almost always visible months in advance.',
  },
  RESOURCE: {
    label: 'What it would take to achieve it',
    matters: 'A programme achievable only with resource nobody has priced or can get is a programme that will not happen.',
  },
  CONSTRAINT: {
    label: 'A date the programme is pinned to',
    matters: 'Constraints override the logic. One nobody agrees with is a date the network is being bent around for no reason.',
  },
  OMISSION: {
    label: 'Work that is not on the programme at all',
    matters: 'The hardest thing to see on a Gantt chart is the bar that is not there.',
  },
  OTHER: { label: 'Something else', matters: 'Recorded rather than forced into a category it does not fit.' },
} as const;

export type CommentKind = keyof typeof COMMENT_KIND;

/**
 * What the planner did with a comment.
 *
 * `NOTED` is a real answer and is deliberately not a synonym for accepted: it
 * means the point is understood and the programme is not changing, which a party
 * is entitled to know rather than infer from the programme staying the same.
 */
export const DISPOSITION = {
  ACCEPTED: { label: 'Accepted — the programme will change', needsReason: false },
  ACCEPTED_IN_PART: { label: 'Accepted in part', needsReason: true },
  REJECTED: { label: 'Rejected', needsReason: true },
  NOTED: { label: 'Noted, and the programme is not changing', needsReason: true },
} as const;

export type Disposition = keyof typeof DISPOSITION;

/** A person, named. The id is the identity this platform knows them by. */
export type Party = { id: string; name: string };

type CommentState = {
  id: string;
  reviewId: string;
  runId: string;
  activityId?: string;
  kind: CommentKind;
  body: string;
  raisedBy: string;
  raisedByRole: string;
  raisedAt: string;
  response?: { disposition: Disposition; reason?: string; respondedBy: string; respondedAt: string };
};

type ReviewState = {
  id: string;
  projectId: string;
  runId: string;
  /** What the programme said when the review opened, so the record is legible later. */
  finishDateAtIssue: string;
  closesOn: string;
  /**
   * Who was asked.
   *
   * Identity id *and* the name it had when the invitation went out. The id is
   * what makes the participation split work at all — a comment records the
   * actor who made it, so an invitation list in any other vocabulary can never
   * be matched against one and would report everybody as silent. The name is
   * carried alongside because the record has to stay readable years later
   * without the user store, and because a person can be renamed or leave.
   */
  invited: Party[];
  status: 'OPEN' | 'CLOSED';
  openedBy: string;
  openedAt: string;
  closedBy?: string;
  closedAt?: string;
  /** Recorded when the review is closed, so it cannot be recomputed differently later. */
  closingNote?: string;
};

/**
 * Issue a schedule run for review.
 *
 * Against a run rather than against the project, so every comment made under it
 * is anchored to the version it was made about.
 */
export function openReview(
  ctx: EngineContext,
  input: { runId: string; closesOn: string; invited: Party[]; note?: string },
): { reviewId: string; runId: string; closesOn: string; invited: number } {
  authorise(ctx, 'PROGRAMME_BASELINES', 'A');

  const run = ctx.ledger.get({ refType: 'ScheduleRun', refId: input.runId });
  if (!run || run.projectId !== ctx.projectId) {
    throw new DomainError(
      'SCHEDULE_RUN_NOT_FOUND',
      `No schedule run ${input.runId} on this project. A review is opened against a run so that every comment is ` +
        'anchored to the version of the programme it was made about.',
      404,
    );
  }
  if (Number.isNaN(Date.parse(input.closesOn))) {
    throw new DomainError('REVIEW_CLOSE_DATE_INVALID', 'Say when the review closes. A review with no closing date never closes.');
  }
  // Deduplicated by identity, not by name: two people can share a name, and the
  // id is what a comment will be matched against.
  const invited: Party[] = [];
  for (const party of input.invited) {
    const id = String(party?.id ?? '').trim();
    const name = String(party?.name ?? '').trim();
    if (!id || !name) {
      throw new DomainError(
        'REVIEW_PARTY_UNIDENTIFIED',
        'Every invited party needs both the identity this platform knows them by and the name they go by. The id is ' +
          'what a comment gets matched against — without it nobody can ever be recorded as having responded — and ' +
          'the name is what keeps the record readable once the person has left.',
      );
    }
    if (!invited.some((existing) => existing.id === id)) invited.push({ id, name });
  }
  if (invited.length === 0) {
    throw new DomainError(
      'REVIEW_NOBODY_INVITED',
      'Name who is being asked. A review nobody was invited to cannot distinguish a party who looked and had no ' +
        'objection from one who never saw it, and that distinction is the whole value of the register.',
    );
  }

  const open = ctx.ledger
    .list(ctx.projectId, 'ProgrammeReview')
    .map((record) => record.state as unknown as ReviewState)
    .find((review) => review.status === 'OPEN');
  if (open) {
    throw new DomainError(
      'REVIEW_ALREADY_OPEN',
      `A review of run ${open.runId} is already open until ${open.closesOn}. Two open reviews would mean a party ` +
        'commenting on one version while another is being circulated, and neither record would say which they meant.',
      409,
    );
  }

  const reviewId = ulid();
  const state: ReviewState = {
    id: reviewId,
    projectId: ctx.projectId,
    runId: input.runId,
    finishDateAtIssue: String(run.state.finishDate ?? ''),
    closesOn: input.closesOn.slice(0, 10),
    invited,
    status: 'OPEN',
    openedBy: ctx.auth.actorId,
    openedAt: new Date().toISOString(),
  };

  write(ctx, {
    eventType: 'PROGRAMME_REVIEW_OPENED',
    entity: { refType: 'ProgrammeReview', refId: reviewId },
    reason: `${state.invited.length} party(ies) invited to comment by ${state.closesOn}${input.note ? `: ${input.note}` : ''}`,
    nextState: state as unknown as Record<string, unknown>,
  });

  return { reviewId, runId: input.runId, closesOn: state.closesOn, invited: state.invited.length };
}

/**
 * Comment on the programme under review.
 *
 * Open to anybody who can read the programme, which is deliberately wider than
 * who can change it: the value of a review is the objection from the person who
 * has to do the work, and requiring the permission to *edit* a programme in
 * order to say something about it would leave only the planner able to comment.
 */
export function comment(
  ctx: EngineContext,
  input: { reviewId: string; kind: CommentKind; body: string; activityId?: string },
): { commentId: string; kind: CommentKind } {
  authorise(ctx, 'PROGRAMME_BASELINES', 'R');

  const review = requireReview(ctx, input.reviewId);
  if (review.status === 'CLOSED') {
    throw new DomainError(
      'REVIEW_CLOSED',
      `That review closed on ${review.closedAt?.slice(0, 10) ?? review.closesOn}. A closed review is the record of ` +
        'what was said by its closing date, and a late comment changes what that record says about the date it was ' +
        'closed on. Raise it against the next issue.',
      409,
    );
  }
  if (!(input.kind in COMMENT_KIND)) {
    throw new DomainError('COMMENT_KIND_UNKNOWN', `${input.kind} is not one of the comment kinds this register counts.`);
  }
  if (input.body.trim().length < 10) {
    throw new DomainError(
      'COMMENT_BODY_REQUIRED',
      'Say what the objection is. A comment somebody will be reading back in an adjudication needs to contain the ' +
        'point, not a reference to a conversation.',
    );
  }
  if (input.activityId) {
    const task = ctx.ledger.get({ refType: 'Task', refId: input.activityId });
    if (!task || task.projectId !== ctx.projectId) {
      throw new DomainError('TASK_NOT_FOUND', `No activity ${input.activityId} on this project`, 404);
    }
  }

  const commentId = ulid();
  write(ctx, {
    eventType: 'PROGRAMME_COMMENT_RAISED',
    entity: { refType: 'ProgrammeComment', refId: commentId },
    reason: `${COMMENT_KIND[input.kind].label}${input.activityId ? ' on an activity' : ''}`,
    nextState: {
      id: commentId,
      reviewId: input.reviewId,
      runId: review.runId,
      ...(input.activityId ? { activityId: input.activityId } : {}),
      kind: input.kind,
      body: input.body.trim(),
      raisedBy: ctx.auth.actorId,
      // The role is recorded beside the identity because it is what makes the
      // comment weigh: an access objection from the party who controls the area
      // is a different fact from the same words typed by anybody else.
      raisedByRole: ctx.auth.roles.join(','),
      raisedAt: new Date().toISOString(),
    } satisfies CommentState,
  });

  return { commentId, kind: input.kind };
}

/**
 * Answer a comment.
 *
 * Every disposition except a plain acceptance needs a reason, including "noted".
 * A party told their objection is noted and nothing is changing is entitled to
 * know why, and a register full of unexplained "noted" is the email thread this
 * exists to replace.
 */
export function respond(
  ctx: EngineContext,
  input: { commentId: string; disposition: Disposition; reason?: string },
): { commentId: string; disposition: Disposition } {
  authorise(ctx, 'PROGRAMME_BASELINES', 'A');

  const record = ctx.ledger.get({ refType: 'ProgrammeComment', refId: input.commentId });
  if (!record || record.projectId !== ctx.projectId) {
    throw new DomainError('COMMENT_NOT_FOUND', `No comment ${input.commentId} on this project`, 404);
  }
  const state = record.state as unknown as CommentState;
  if (state.response) {
    throw new DomainError(
      'COMMENT_ALREADY_ANSWERED',
      `That comment was already answered — ${DISPOSITION[state.response.disposition].label.toLowerCase()}. Changing ` +
        'the answer would rewrite what the party was told, which is the one thing this record exists to hold still.',
      409,
    );
  }
  if (!(input.disposition in DISPOSITION)) {
    throw new DomainError('DISPOSITION_UNKNOWN', `${input.disposition} is not a disposition.`);
  }
  if (DISPOSITION[input.disposition].needsReason && !input.reason?.trim()) {
    throw new DomainError(
      'DISPOSITION_REASON_REQUIRED',
      `${DISPOSITION[input.disposition].label} needs a reason. This is the planner's answer to a party who may be ` +
        'reading it back in an adjudication, and an answer with no reasoning in it is what makes that adjudication ' +
        'worth having.',
    );
  }

  write(ctx, {
    eventType: 'PROGRAMME_COMMENT_ANSWERED',
    entity: { refType: 'ProgrammeComment', refId: input.commentId },
    reason: `${DISPOSITION[input.disposition].label}`,
    nextState: {
      ...state,
      response: {
        disposition: input.disposition,
        ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
        respondedBy: ctx.auth.actorId,
        respondedAt: new Date().toISOString(),
      },
    },
  });

  return { commentId: input.commentId, disposition: input.disposition };
}

/**
 * Close the review.
 *
 * Refused while comments are unanswered. A review closed over an open objection
 * is a record that the objection was never dealt with, and closing it is the
 * moment that becomes hard to see — so the refusal names how many are
 * outstanding rather than letting the act be quiet.
 */
export function closeReview(ctx: EngineContext, input: { reviewId: string; note: string }): {
  reviewId: string;
  comments: number;
  didNotRespond: Party[];
} {
  authorise(ctx, 'PROGRAMME_BASELINES', 'A');

  const review = requireReview(ctx, input.reviewId);
  if (review.status === 'CLOSED') {
    throw new DomainError('REVIEW_CLOSED', 'That review is already closed.', 409);
  }
  if (!input.note.trim()) {
    throw new DomainError(
      'REVIEW_CLOSING_NOTE_REQUIRED',
      'Say what the review concluded. A review that closes with no statement leaves the next reader to infer it from ' +
        'the comment list, and two readers will infer different things.',
    );
  }

  const comments = commentsOf(ctx, review.id);
  const unanswered = comments.filter((entry) => !entry.response);
  if (unanswered.length > 0) {
    throw new DomainError(
      'REVIEW_HAS_UNANSWERED_COMMENTS',
      `${unanswered.length} comment(s) have no answer. Closing over them would put on the record that they were ` +
        'never dealt with, at the moment that becomes hardest to see. Answer them — "noted, and the programme is not ' +
        'changing" is an answer.',
      409,
    );
  }

  const responded = new Set(comments.map((entry) => entry.raisedBy));
  const didNotRespond = review.invited.filter((party) => !responded.has(party.id));

  write(ctx, {
    eventType: 'PROGRAMME_REVIEW_CLOSED',
    entity: { refType: 'ProgrammeReview', refId: review.id },
    reason: `${comments.length} comment(s), ${didNotRespond.length} invited party(ies) did not respond`,
    nextState: {
      ...review,
      status: 'CLOSED',
      closedBy: ctx.auth.actorId,
      closedAt: new Date().toISOString(),
      closingNote: input.note.trim(),
    } satisfies ReviewState as unknown as Record<string, unknown>,
  });

  return { reviewId: review.id, comments: comments.length, didNotRespond };
}

// --- Reading it ---------------------------------------------------------------

export type ReviewPosition = {
  open?: {
    reviewId: string;
    runId: string;
    finishDateAtIssue: string;
    closesOn: string;
    daysRemaining: number;
    openedAt: string;
    /** True where the programme has been rescheduled since the review opened. */
    supersededByLaterRun: boolean;
    /** How many were asked. Not the same number as objected plus silent: anybody who can read the programme may comment on it, invited or not. */
    invitedCount: number;
  };
  comments: Array<{
    commentId: string;
    reviewId: string;
    activityId?: string;
    activityName?: string;
    kind: CommentKind;
    kindLabel: string;
    body: string;
    raisedBy: string;
    /** The name the invitation carried, where the person who commented was invited. */
    raisedByName: string;
    raisedAt: string;
    answered: boolean;
    disposition?: Disposition;
    dispositionLabel?: string;
    reason?: string;
  }>;
  /** The three states, kept apart. */
  participation: {
    objected: Party[];
    reviewedWithoutObjection: Party[];
    didNotRespond: Party[];
  };
  byKind: Array<{ kind: CommentKind; label: string; count: number; unanswered: number }>;
  unanswered: number;
  closedReviews: number;
  summary: string;
};

/**
 * Who said what about which version, and who said nothing.
 *
 * The `participation` split is the point. A register that reports objections and
 * leaves everybody else in one bucket says a party who read the programme and
 * had no objection is the same as one who never opened it, and those are the two
 * facts a deemed-acceptance argument turns on.
 */
export function reviewPosition(ctx: EngineContext, today?: string): ReviewPosition {
  authorise(ctx, 'PROGRAMME_BASELINES', 'R');

  const asAt = (today ?? new Date().toISOString()).slice(0, 10);
  const reviews = ctx.ledger
    .list(ctx.projectId, 'ProgrammeReview')
    .map((record) => record.state as unknown as ReviewState);
  const open = reviews.find((review) => review.status === 'OPEN');

  const taskNames = new Map(
    ctx.ledger.list(ctx.projectId, 'Task').map((record) => [record.refId, String(record.state.name ?? record.refId)]),
  );

  const all = ctx.ledger
    .list(ctx.projectId, 'ProgrammeComment')
    .map((record) => record.state as unknown as CommentState)
    .sort((a, b) => b.raisedAt.localeCompare(a.raisedAt));
  const forOpen = open ? all.filter((entry) => entry.reviewId === open.id) : [];

  // Objected and reviewed-without-objection are both derived from what people
  // actually did. Nobody is put in the second bucket for having been invited.
  //
  // Both sides are keyed on the identity id, which is the whole reason the
  // invitation list carries one: a comment records the actor who made it, so
  // matching on anything else reports everybody as silent including the people
  // who objected. A commenter who was never invited is still an objector — a
  // review is open to anybody who can read the programme — and is named by
  // their id, because the invitation list is the only place a name was given.
  const nameOf = new Map((open?.invited ?? []).map((party) => [party.id, party.name]));
  const objected: Party[] = [];
  for (const id of new Set(forOpen.map((entry) => entry.raisedBy))) {
    objected.push({ id, name: nameOf.get(id) ?? id });
  }
  const respondedIds = new Set(objected.map((party) => party.id));
  const didNotRespond = open ? open.invited.filter((party) => !respondedIds.has(party.id)) : [];

  const byKind = (Object.keys(COMMENT_KIND) as CommentKind[])
    .map((kind) => ({
      kind,
      label: COMMENT_KIND[kind].label,
      count: forOpen.filter((entry) => entry.kind === kind).length,
      unanswered: forOpen.filter((entry) => entry.kind === kind && !entry.response).length,
    }))
    .filter((entry) => entry.count > 0);

  const unanswered = forOpen.filter((entry) => !entry.response).length;

  // Has the programme moved on under the review? Re-running does not close a
  // review, and it should not — but a party commenting on a superseded run
  // needs to know, and so does the planner reading their comment.
  const latestRun = ctx.ledger
    .list(ctx.projectId, 'ScheduleRun')
    .map((record) => record.state as Record<string, unknown>)
    .sort((a, b) => String(a.ranAt).localeCompare(String(b.ranAt)))
    .pop();
  const supersededByLaterRun = open !== undefined && latestRun !== undefined && String(latestRun.id) !== open.runId;

  return {
    ...(open
      ? {
          open: {
            reviewId: open.id,
            runId: open.runId,
            finishDateAtIssue: open.finishDateAtIssue,
            closesOn: open.closesOn,
            daysRemaining: Math.round((Date.parse(open.closesOn) - Date.parse(asAt)) / 86_400_000),
            openedAt: open.openedAt,
            supersededByLaterRun,
            invitedCount: open.invited.length,
          },
        }
      : {}),
    comments: all.map((entry) => ({
      commentId: entry.id,
      reviewId: entry.reviewId,
      ...(entry.activityId ? { activityId: entry.activityId, activityName: taskNames.get(entry.activityId) } : {}),
      kind: entry.kind,
      kindLabel: COMMENT_KIND[entry.kind]?.label ?? entry.kind,
      body: entry.body,
      raisedBy: entry.raisedBy,
      raisedByName: nameOf.get(entry.raisedBy) ?? entry.raisedBy,
      raisedAt: entry.raisedAt,
      answered: entry.response !== undefined,
      ...(entry.response
        ? {
            disposition: entry.response.disposition,
            dispositionLabel: DISPOSITION[entry.response.disposition]?.label ?? entry.response.disposition,
            ...(entry.response.reason ? { reason: entry.response.reason } : {}),
          }
        : {}),
    })),
    participation: {
      objected,
      // Nobody is here yet: a party who has read the programme and has no
      // objection has to say so, and until this platform has a way for them to
      // say it they cannot be counted as having. Reporting an empty list is the
      // honest answer; filling it from the invitation list would be the deeming
      // this module exists to refuse.
      reviewedWithoutObjection: [],
      didNotRespond,
    },
    byKind,
    unanswered,
    closedReviews: reviews.filter((review) => review.status === 'CLOSED').length,
    summary: summarise(open, forOpen.length, unanswered, didNotRespond.length, supersededByLaterRun, asAt),
  };
}

function summarise(
  open: ReviewState | undefined,
  comments: number,
  unanswered: number,
  didNotRespond: number,
  superseded: boolean,
  asAt: string,
): string {
  if (!open) return 'No review of the programme is open.';
  const parts = [
    `Run ${open.runId.slice(-6)} is out for comment until ${open.closesOn}, finishing ${open.finishDateAtIssue} as issued.`,
    `${comments} comment(s)${unanswered > 0 ? `, ${unanswered} unanswered` : ''}.`,
  ];
  if (didNotRespond > 0) {
    // Said plainly, and never as agreement.
    parts.push(
      `${didNotRespond} invited party(ies) have not responded. That is not agreement — it is an absence of one, and ` +
        'whether it becomes acceptance is a question about the contract rather than about this register.',
    );
  }
  if (superseded) {
    parts.push('The programme has been rescheduled since this went out, so the comments are about a superseded run.');
  }
  if (open.closesOn < asAt) parts.push('The closing date has passed and the review is still open.');
  return parts.join(' ');
}

function requireReview(ctx: EngineContext, reviewId: string): ReviewState {
  const record = ctx.ledger.get({ refType: 'ProgrammeReview', refId: reviewId });
  if (!record || record.projectId !== ctx.projectId) {
    throw new DomainError('REVIEW_NOT_FOUND', `No programme review ${reviewId} on this project`, 404);
  }
  return record.state as unknown as ReviewState;
}

function commentsOf(ctx: EngineContext, reviewId: string): CommentState[] {
  return ctx.ledger
    .list(ctx.projectId, 'ProgrammeComment')
    .map((record) => record.state as unknown as CommentState)
    .filter((entry) => entry.reviewId === reviewId);
}
