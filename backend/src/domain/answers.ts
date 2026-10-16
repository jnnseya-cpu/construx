import { DomainError } from '../core/errors.ts';
import { formatRef, ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';
import type { RequirementCategory } from './itt.ts';

/**
 * The answer library — what this business says about itself, kept.
 *
 * ## Why it exists
 *
 * A qualitative response is 40–60% of the score on public work, and it is
 * written at eleven at night by an estimator who has already done a day. The
 * answer that took four hours to get right is submitted once and then thrown
 * away, and the next bid starts from the same blank page. A contractor doing
 * thirty bids a year rewrites the same social-value commitment thirty times and
 * gets slightly worse at it each time, because the version that scored well is
 * in a PDF nobody can find.
 *
 * `bidresponse.ts` holds the sections of one submission. Nothing held an answer
 * across submissions, and that was the gap.
 *
 * ## It does not paste, and that is the design
 *
 * The obvious build is a bank that fills the section in. It is also the one
 * that destroys the thing it is meant to improve: an answer pasted unchanged
 * into forty bids is boilerplate, a buyer reading their fourth identical
 * submission marks it as such, and the library converges on a permanent 3/5 —
 * which is precisely the failure it was bought to fix.
 *
 * So `offerAnswers` returns candidates **and the evidence of how they have
 * actually done**, and the section is still written by a person. The library's
 * job is to make sure nobody starts from nothing and nobody forgets the version
 * that worked; it is not to supply prose. Where an answer is used, that use is
 * recorded against it, so the library can be judged rather than admired: one
 * with eleven uses and two wins is worse than the blank page it replaced, and
 * nothing says so unless the uses are on the record.
 *
 * ## Why approval is a second person
 *
 * The same segregation the payment cycle and the calibration loop carry. What
 * goes in the library is not one bid's prose; it is what the business claims
 * about itself, under its own name, on every bid, for years. One person writing
 * a commitment and then approving it for permanent reuse is one person deciding
 * what the company promises.
 *
 * ## Nothing is deleted
 *
 * A retired answer stays. A revised one supersedes rather than overwrites. An
 * answer submitted to a buyer two years ago is a fact about what this business
 * undertook to do, and the version that was sent has to remain readable after
 * somebody improves it — the same rule the drawing register runs under.
 */

export const ANSWER_STATUS = ['DRAFT', 'APPROVED', 'SUPERSEDED', 'RETIRED'] as const;
export type AnswerStatus = (typeof ANSWER_STATUS)[number];

/** Where an answer was used, and — once known — how it did. */
export type AnswerUse = {
  /** The submission it went into. */
  packId: string;
  /** The section within it, by the compliance-matrix reference it answers. */
  sectionKey: string;
  /** The pursuit, so a reader can join a use to its outcome. */
  opportunityId?: string;
  usedOn: string;
  usedBy: string;
  /** The buyer's mark for that section, where they disclosed one. */
  scorePercent?: number;
};

export type BidAnswer = {
  id: string;
  reference: string;
  title: string;
  /** The kind of requirement this answers. The matrix's own vocabulary. */
  category: RequirementCategory;
  /** Paragraphs, as written. */
  body: string[];
  words: number;
  /** Free tags — a framework, a client, a scheme name. Searchable, not structural. */
  tags: string[];
  status: AnswerStatus;
  /** Rises on every revision. The record keeps every one. */
  version: number;
  /** The answer this one replaced, where it replaced one. */
  supersedes?: string;
  /** The answer that replaced this one. Set when it is superseded. */
  supersededBy?: string;
  /** Where the prose came from, so a reused answer is traceable to its first bid. */
  origin?: { packId?: string; sectionKey?: string; opportunityId?: string };
  /**
   * Who wrote it. A model may have drafted the bid section this was taken from,
   * and that fact travels with the answer rather than being laundered by the
   * capture.
   */
  authorship: 'HUMAN' | 'AI_DRAFTED';
  uses: AnswerUse[];
  capturedAt: string;
  capturedBy: string;
  approvedAt?: string;
  approvedBy?: string;
  approvalNote?: string;
  retiredAt?: string;
  retiredBy?: string;
  retiredReason?: string;
};

const TITLE_MIN = 6;
const BODY_MIN_WORDS = 25;
const REASON_MIN = 12;

function wordsOf(body: string[]): number {
  return body.join(' ').split(/\s+/).filter(Boolean).length;
}

function clean(body: string[]): string[] {
  return body.map((line) => line.trim()).filter(Boolean);
}

function answersOf(ctx: EngineContext): BidAnswer[] {
  return ctx.ledger
    .listByTenant(ctx.tenantId, 'BidAnswer')
    .map((record) => record.state as unknown as BidAnswer);
}

function requireAnswer(ctx: EngineContext, answerId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'BidAnswer', refId: answerId });
  if (!record || record.tenantId !== ctx.tenantId) {
    throw new DomainError('BID_ANSWER_NOT_FOUND', `No answer ${answerId}`, 404);
  }
  return record;
}

// --- Capture -----------------------------------------------------------------

/**
 * Take an answer into the library, as a draft.
 *
 * `ESTIMATE_TENDER` `C`. A draft changes nothing anybody sees and is offered to
 * nobody; capturing is cheap on purpose, so the answer that worked is kept
 * while somebody still remembers it worked.
 */
export function captureAnswer(
  ctx: EngineContext,
  input: {
    title: string;
    category: RequirementCategory;
    body: string[];
    tags?: string[];
    origin?: { packId?: string; sectionKey?: string; opportunityId?: string };
    authorship?: 'HUMAN' | 'AI_DRAFTED';
  },
): BidAnswer {
  authorise(ctx, 'ESTIMATE_TENDER', 'C', { dataSensitivity: 'COMMERCIAL_L3' });

  const title = input.title.trim();
  if (title.length < TITLE_MIN) {
    throw new DomainError('ANSWER_TITLE_TOO_SHORT', `An answer needs a title of at least ${TITLE_MIN} characters`, 400);
  }

  const body = clean(input.body);
  const words = wordsOf(body);
  if (words < BODY_MIN_WORDS) {
    // Not a style rule. A library of twenty-word stubs is a library nobody
    // opens, and the first time somebody finds one mid-bid is the last time
    // they look.
    throw new DomainError(
      'ANSWER_TOO_SHORT',
      `An answer worth keeping runs to at least ${BODY_MIN_WORDS} words; this is ${words}.`,
      400,
    );
  }

  const id = ulid();
  const answer: BidAnswer = {
    id,
    reference: formatRef('ANS', answersOf(ctx).length + 1),
    title,
    category: input.category,
    body,
    words,
    tags: (input.tags ?? []).map((tag) => tag.trim()).filter(Boolean),
    status: 'DRAFT',
    version: 1,
    ...(input.origin ? { origin: input.origin } : {}),
    authorship: input.authorship ?? 'HUMAN',
    uses: [],
    capturedAt: new Date().toISOString(),
    capturedBy: ctx.auth.actorId,
  };

  write(ctx, {
    eventType: 'BID_ANSWER_CAPTURED',
    entity: { refType: 'BidAnswer', refId: id },
    nextState: { ...answer },
  });

  return answer;
}

// --- Approval ----------------------------------------------------------------

/**
 * Approve an answer for reuse. `ESTIMATE_TENDER` `A`, and never the author.
 *
 * Until this runs the answer is offered to nobody. What is being approved is
 * not prose — it is a commitment this business will repeat on every bid that
 * takes the answer, which is why it is a second person's decision and not a
 * formatting pass.
 */
export function approveAnswer(ctx: EngineContext, answerId: string, input: { note: string }): BidAnswer {
  authorise(ctx, 'ESTIMATE_TENDER', 'A', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireAnswer(ctx, answerId);
  const answer = record.state as unknown as BidAnswer;

  if (answer.status !== 'DRAFT') {
    throw new DomainError(
      'ANSWER_NOT_DRAFT',
      `${answer.reference} is ${answer.status.toLowerCase()} and only a draft can be approved.`,
      409,
    );
  }
  if (answer.capturedBy === ctx.auth.actorId) {
    throw new DomainError(
      'ANSWER_SELF_APPROVAL',
      'The person who captured an answer cannot approve it for reuse. What goes in the library is what this ' +
        'business claims about itself on every bid that takes it, and one person must not be both ends of that.',
      409,
    );
  }
  const note = input.note.trim();
  if (note.length < REASON_MIN) {
    throw new DomainError('ANSWER_NOTE_TOO_SHORT', `Say why in at least ${REASON_MIN} characters`, 400);
  }

  const approved: BidAnswer = {
    ...answer,
    status: 'APPROVED',
    approvedAt: new Date().toISOString(),
    approvedBy: ctx.auth.actorId,
    approvalNote: note,
  };

  write(ctx, {
    eventType: 'BID_ANSWER_APPROVED',
    entity: { refType: 'BidAnswer', refId: answerId },
    nextState: { ...approved },
  });

  return approved;
}

// --- Revision ----------------------------------------------------------------

/**
 * Replace an answer with a better one, keeping the old.
 *
 * A new record superseding the old rather than an edit in place. The version
 * that was sent to a buyer has to stay readable after somebody improves it —
 * a bid is a promise and the promise that was made is not whatever the library
 * says today. The same rule the drawing register runs under.
 *
 * The replacement arrives as a `DRAFT` and needs its own approval. An approved
 * answer is not a licence to publish its successor unseen.
 */
export function reviseAnswer(
  ctx: EngineContext,
  answerId: string,
  input: { body: string[]; reason: string; title?: string; tags?: string[] },
): BidAnswer {
  authorise(ctx, 'ESTIMATE_TENDER', 'C', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireAnswer(ctx, answerId);
  const previous = record.state as unknown as BidAnswer;

  if (previous.status === 'SUPERSEDED') {
    throw new DomainError(
      'ANSWER_ALREADY_SUPERSEDED',
      `${previous.reference} has already been replaced by ${previous.supersededBy}. Revise that one.`,
      409,
    );
  }
  if (previous.status === 'RETIRED') {
    throw new DomainError('ANSWER_RETIRED', `${previous.reference} is retired and is not revised.`, 409);
  }
  const reason = input.reason.trim();
  if (reason.length < REASON_MIN) {
    throw new DomainError('ANSWER_REASON_TOO_SHORT', `Say what changed in at least ${REASON_MIN} characters`, 400);
  }

  const body = clean(input.body);
  const words = wordsOf(body);
  if (words < BODY_MIN_WORDS) {
    throw new DomainError('ANSWER_TOO_SHORT', `A revision runs to at least ${BODY_MIN_WORDS} words; this is ${words}.`, 400);
  }

  const id = ulid();
  const next: BidAnswer = {
    id,
    reference: formatRef('ANS', answersOf(ctx).length + 1),
    title: (input.title ?? previous.title).trim(),
    category: previous.category,
    body,
    words,
    tags: input.tags ? input.tags.map((tag) => tag.trim()).filter(Boolean) : previous.tags,
    status: 'DRAFT',
    version: previous.version + 1,
    supersedes: previous.id,
    ...(previous.origin ? { origin: previous.origin } : {}),
    authorship: 'HUMAN',
    // Uses belong to the version that was actually sent. Carrying them forward
    // would credit a new answer with a record it has not earned.
    uses: [],
    capturedAt: new Date().toISOString(),
    capturedBy: ctx.auth.actorId,
  };

  write(ctx, {
    eventType: 'BID_ANSWER_CAPTURED',
    entity: { refType: 'BidAnswer', refId: id },
    nextState: { ...next },
  });

  write(ctx, {
    eventType: 'BID_ANSWER_REVISED',
    entity: { refType: 'BidAnswer', refId: previous.id },
    nextState: { ...previous, status: 'SUPERSEDED', supersededBy: id },
  });

  return next;
}

// --- Retirement --------------------------------------------------------------

/** Take an answer out of use without taking it off the record. */
export function retireAnswer(ctx: EngineContext, answerId: string, input: { reason: string }): BidAnswer {
  authorise(ctx, 'ESTIMATE_TENDER', 'A', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireAnswer(ctx, answerId);
  const answer = record.state as unknown as BidAnswer;

  if (answer.status === 'RETIRED') {
    throw new DomainError('ANSWER_RETIRED', `${answer.reference} is already retired.`, 409);
  }
  const reason = input.reason.trim();
  if (reason.length < REASON_MIN) {
    throw new DomainError('ANSWER_REASON_TOO_SHORT', `Say why in at least ${REASON_MIN} characters`, 400);
  }

  const retired: BidAnswer = {
    ...answer,
    status: 'RETIRED',
    retiredAt: new Date().toISOString(),
    retiredBy: ctx.auth.actorId,
    retiredReason: reason,
  };

  write(ctx, {
    eventType: 'BID_ANSWER_RETIRED',
    entity: { refType: 'BidAnswer', refId: answerId },
    nextState: { ...retired },
  });

  return retired;
}

// --- Use ---------------------------------------------------------------------

/**
 * Record that an answer was used on a bid.
 *
 * The half that makes the library honest. Without it the register shows a bank
 * of answers somebody is proud of; with it, it shows which ones go out and what
 * happens when they do. An answer used eleven times for two wins is worse than
 * the blank page it replaced, and that is a sentence nobody can write unless
 * the uses are on the record.
 *
 * Recorded as a separate act rather than by watching `bidresponse.ts` write a
 * section, because the library does not paste: a person reads the candidates,
 * writes their own section, and says which one they worked from — and whether
 * they worked from one at all is a fact only they have.
 */
export function recordAnswerUse(
  ctx: EngineContext,
  answerId: string,
  input: { packId: string; sectionKey: string; opportunityId?: string; scorePercent?: number },
): BidAnswer {
  authorise(ctx, 'ESTIMATE_TENDER', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireAnswer(ctx, answerId);
  const answer = record.state as unknown as BidAnswer;

  if (answer.status === 'DRAFT') {
    throw new DomainError(
      'ANSWER_NOT_APPROVED',
      `${answer.reference} has not been approved for reuse, so it should not have gone out on a bid.`,
      409,
    );
  }
  if (input.scorePercent !== undefined && (input.scorePercent < 0 || input.scorePercent > 100)) {
    throw new DomainError('ANSWER_SCORE_RANGE', 'A score is a percentage between 0 and 100', 400);
  }

  const use: AnswerUse = {
    packId: input.packId,
    sectionKey: input.sectionKey,
    ...(input.opportunityId ? { opportunityId: input.opportunityId } : {}),
    usedOn: new Date().toISOString(),
    usedBy: ctx.auth.actorId,
    ...(input.scorePercent === undefined ? {} : { scorePercent: input.scorePercent }),
  };

  const updated: BidAnswer = { ...answer, uses: [...answer.uses, use] };

  write(ctx, {
    eventType: 'BID_ANSWER_USED',
    entity: { refType: 'BidAnswer', refId: answerId },
    nextState: { ...updated },
  });

  return updated;
}

// --- Reads -------------------------------------------------------------------

export type AnswerSummary = Omit<BidAnswer, 'body'> & {
  /** How many times it has gone out. */
  useCount: number;
  /** Median of the disclosed marks, where any were disclosed. */
  medianScorePercent: number | null;
};

export type AnswerLibrary = {
  answers: AnswerSummary[];
  byCategory: Array<{ category: RequirementCategory; approved: number; draft: number }>;
  /** What the register cannot answer, said rather than left as a short list. */
  limits: string[];
  summary: string;
};

function summarise(answer: BidAnswer): AnswerSummary {
  const scores = answer.uses
    .map((use) => use.scorePercent)
    .filter((score): score is number => typeof score === 'number')
    .sort((a, b) => a - b);
  const middle = Math.floor(scores.length / 2);
  const { body: _body, ...rest } = answer;

  return {
    ...rest,
    useCount: answer.uses.length,
    medianScorePercent:
      scores.length === 0
        ? null
        : scores.length % 2 === 0
          ? (scores[middle - 1]! + scores[middle]!) / 2
          : scores[middle]!,
  };
}

/** Everything in the library, whatever its status. The register, not the offer. */
export function answerLibrary(ctx: EngineContext, filter: { category?: RequirementCategory } = {}): AnswerLibrary {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const all = answersOf(ctx).filter((answer) => !filter.category || answer.category === filter.category);
  const answers = all
    .map(summarise)
    .sort((a, b) => b.useCount - a.useCount || a.title.localeCompare(b.title));

  const categories = new Map<RequirementCategory, { approved: number; draft: number }>();
  for (const answer of all) {
    const row = categories.get(answer.category) ?? { approved: 0, draft: 0 };
    if (answer.status === 'APPROVED') row.approved += 1;
    if (answer.status === 'DRAFT') row.draft += 1;
    categories.set(answer.category, row);
  }

  const limits: string[] = [];
  const unscored = answers.filter((answer) => answer.useCount > 0 && answer.medianScorePercent === null).length;
  if (unscored > 0) {
    limits.push(
      `${unscored} answer(s) have been used and carry no disclosed mark, so nothing can be said about whether they ` +
        'score. Record the buyer’s mark against the use where they give one.',
    );
  }
  const waiting = all.filter((answer) => answer.status === 'DRAFT').length;
  if (waiting > 0) {
    limits.push(`${waiting} answer(s) are captured and not approved, so they are offered to nobody.`);
  }

  const approved = all.filter((answer) => answer.status === 'APPROVED').length;
  return {
    answers,
    byCategory: [...categories.entries()]
      .map(([category, row]) => ({ category, ...row }))
      .sort((a, b) => b.approved - a.approved || a.category.localeCompare(b.category)),
    limits,
    summary:
      all.length === 0
        ? 'Nothing in the library yet. Capture the answers that worked while somebody still remembers they worked.'
        : `${approved} approved answer(s) across ${categories.size} categor${categories.size === 1 ? 'y' : 'ies'}.`,
  };
}

export type AnswerOffer = {
  category: RequirementCategory;
  candidates: Array<AnswerSummary & { body: string[] }>;
  /** Said on every offer, deliberately. */
  note: string;
};

/**
 * What the library has for a requirement — and nothing more than that.
 *
 * It returns candidates with the evidence of how they have done, and the
 * section is still written by a person. There is no call anywhere in this
 * module that writes a library answer into a bid section, and that absence is
 * the feature: an answer pasted unchanged into forty bids is boilerplate, a
 * buyer reading their fourth identical submission marks it as such, and the
 * library converges on a permanent 3/5 — which is the failure it was built to
 * fix.
 *
 * Only approved answers are offered. A draft is somebody's idea; a superseded
 * one has a better version; a retired one was taken out of use for a reason
 * that is on the record.
 */
export function offerAnswers(ctx: EngineContext, category: RequirementCategory): AnswerOffer {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const candidates = answersOf(ctx)
    .filter((answer) => answer.status === 'APPROVED' && answer.category === category)
    .map((answer) => ({ ...summarise(answer), body: answer.body }))
    .sort((a, b) => (b.medianScorePercent ?? -1) - (a.medianScorePercent ?? -1) || b.useCount - a.useCount);

  return {
    category,
    candidates,
    note:
      candidates.length === 0
        ? 'Nothing approved for this category yet. Write the section, and capture it afterwards if it is worth keeping.'
        : 'A starting point and what it has scored, not a section. Tailor it to this buyer — a buyer reading their ' +
          'fourth identical answer marks it as their fourth identical answer.',
  };
}
