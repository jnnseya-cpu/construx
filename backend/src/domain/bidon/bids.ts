import { DomainError } from '../../core/errors.ts';
import { formatRef, ulid } from '../../core/ids.ts';
import { authorise, write, type EngineContext } from '../../engines/context.ts';
import { requireModule, requireModuleReadable } from '../../identity/modules.ts';
import { liveDeclarations, requireVisibleCustomer, type CustomerAccount } from './customers.ts';
import { requireOpenEngagement, engagementsOf, type Engagement } from './engagements.ts';
import { evidenceOf, type BidOnEvidence } from './evidence.ts';
import {
  DEFAULT_WEIGHTS,
  packReadiness,
  verdictFor,
  type CriterionScores,
  type PackReadiness,
  type Verdict,
} from './rubric.ts';

/**
 * The bid: a questionnaire, its questions, every version of every answer, and
 * the gaps nobody can answer yet.
 *
 * ## Why the question list is confirmed by a person, once
 *
 * A parser reads a questionnaire and gets the numbering wrong somewhere. Not
 * often, and it does not matter how often: a submission that answers
 * twenty-nine of thirty questions because one was missed in parsing is rejected
 * for a missing mandatory response, and nothing downstream can detect it —
 * every answer is good, the readiness figure is 100%, and the thing that is
 * wrong is the list itself.
 *
 * So `confirmQuestions` is a human act and it is the only way questions enter a
 * bid. The parser proposes; a person confirms. After confirmation the list is
 * fixed, because an answer approved against one question and silently
 * reattached to another is worse than a parsing error.
 *
 * ## Why every answer version is kept
 *
 * The version that went to a buyer is a promise the customer made. A reviewer's
 * rejection and the instructions attached to it are the record of why the
 * second version exists, and in a dispute about what was submitted the only
 * useful answer is the text that was actually sent. So an edit writes a new
 * version and nothing overwrites anything — the same rule the drawing register
 * and the answer library run under.
 *
 * ## Why approval is refused to whoever wrote it
 *
 * `approveAnswer` refuses the author of the version being approved **where a
 * person wrote it**. Where an agent drafted it, any reviewer may approve: the
 * agent drafted and a person signed, which is exactly the two-person review the
 * specification asks for. Where a person wrote it, that same person approving
 * is one person at both ends, and the platform already refuses that on every
 * other record that commits the business.
 *
 * ## What is not here
 *
 * No AI. This module holds the records, the lifecycle and the gates; the five
 * agents the specification describes are the callers that fill them in, and the
 * scoring arithmetic is `rubric.ts`. The separation is why the hard rules can be
 * tested without a provider and why a human-written pack behaves identically to
 * an agent-written one.
 */

export const BID_SCHEME = ['UVDB', 'CONSTRUCTIONLINE', 'PAS91', 'SQ_PA23', 'ITT', 'CUSTOM'] as const;
export type BidScheme = (typeof BID_SCHEME)[number];

export const BID_STATUS = [
  'CREATED',
  'PARSING',
  'DRAFTING',
  'IN_REVIEW',
  'APPROVED',
  'EXPORTED',
  'SUBMITTED',
  'WON',
  'LOST',
] as const;
export type BidStatus = (typeof BID_STATUS)[number];

export const ANSWER_TYPE = ['TEXT', 'YES_NO', 'NUMERIC', 'UPLOAD', 'TABLE'] as const;
export type AnswerType = (typeof ANSWER_TYPE)[number];

export const ANSWER_STATUS = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED'] as const;
export type AnswerStatus = (typeof ANSWER_STATUS)[number];

export type BidQuestion = {
  id: string;
  /** The buyer's own section heading, kept so an export can rebuild the structure. */
  section: string;
  /** The buyer's own numbering. Never renumbered: an export has to match the source. */
  number: string;
  text: string;
  answerType: AnswerType;
  wordLimit?: number;
  /** Its share of the buyer's evaluation, where they state one. */
  weighting?: number;
  mandatory: boolean;
  /** Pass/fail rather than scored. A "no" ends the bid. */
  passFail: boolean;
  /** Which declarations an answer to this question rests on. */
  declarationKinds?: string[];
};

export type AnswerCitation = {
  evidenceId: string;
  chunkId: string;
  /** Copied at the time of citing, so the record reads without a second lookup. */
  reference: string;
  pageRef?: string;
};

export type BidAnswerVersion = {
  id: string;
  questionId: string;
  version: number;
  body: string[];
  words: number;
  citations: AnswerCitation[];
  /** For a yes/no question. The hard rule reads this. */
  yesNo?: boolean;
  authorship: 'HUMAN' | 'AI_DRAFTED';
  provider?: string;
  status: AnswerStatus;
  /** The scorer's five criterion scores, where it has run. Never set by the drafter. */
  scores?: CriterionScores;
  /** Why each criterion scored what it did. Required when a score is recorded. */
  scoreReasons?: Record<string, string>;
  /** Which provider scored it, where a model did. */
  scoredBy?: string;
  scoredAt?: string;
  writtenAt: string;
  writtenBy: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewNote?: string;
  /** A reviewer's score override, with the reason that justifies it. */
  overrideScore?: number;
  overrideReason?: string;
};

export type BidGap = {
  id: string;
  questionId: string;
  /** What to ask the customer, in plain English. */
  promptToClient: string;
  raisedAt: string;
  raisedBy: string;
  resolvedAt?: string;
  resolvedBy?: string;
  /** The evidence the customer filed to close it, where they filed one. */
  resolvedEvidenceId?: string;
  resolutionNote?: string;
};

export type Bid = {
  id: string;
  reference: string;
  customerAccountId: string;
  engagementId: string;
  /** The standard-section tender this came from, where it was imported. */
  sourceTenderId?: string;
  buyerName: string;
  buyerReference?: string;
  scheme: BidScheme;
  /** The day the buyer reads it. Every expiry is judged against this. */
  deadline: string;
  status: BidStatus;
  /** The rubric weights in force for this bid, copied at creation. */
  weights: Record<string, number>;
  questions: BidQuestion[];
  questionsConfirmedAt?: string;
  questionsConfirmedBy?: string;
  answers: BidAnswerVersion[];
  gaps: BidGap[];
  exportedAt?: string;
  exportedBy?: string;
  outcome?: { outcome: 'SUBMITTED' | 'WON' | 'LOST'; on: string; by: string; feedback?: string };
  createdAt: string;
  createdBy: string;
};

const NAME_MIN = 3;
const REASON_MIN = 12;
const PROMPT_MIN = 20;

function requireText(value: string, min: number, code: string, what: string): string {
  const text = value.trim();
  if (text.length < min) throw new DomainError(code, `${what} needs at least ${min} characters`, 400);
  return text;
}

const wordsOf = (body: string[]): number => body.join(' ').split(/\s+/).filter(Boolean).length;

export function bidsOf(ctx: EngineContext): Bid[] {
  return ctx.ledger.listByTenant(ctx.tenantId, 'BidOnBid').map((record) => record.state as unknown as Bid);
}

/** Load a bid, refusing it unless this person may see the customer it belongs to. */
export function requireBid(ctx: EngineContext, bidId: string): Bid {
  const record = ctx.ledger.get({ refType: 'BidOnBid', refId: bidId });
  if (!record || record.tenantId !== ctx.tenantId) {
    throw new DomainError('BID_ON_BID_NOT_FOUND', `No bid ${bidId}`, 404);
  }
  const bid = record.state as unknown as Bid;
  requireVisibleCustomer(ctx, bid.customerAccountId);
  return bid;
}

/**
 * A bid that may still be worked on.
 *
 * Two gates and both have to pass: the bid itself has not been sent, and the
 * engagement it belongs to is open for work. The second is why a paused
 * engagement freezes everything under it without each command having to
 * remember.
 */
function requireWorkableBid(ctx: EngineContext, bidId: string): { bid: Bid; engagement: Engagement } {
  const bid = requireBid(ctx, bidId);
  if (['EXPORTED', 'SUBMITTED', 'WON', 'LOST'].includes(bid.status)) {
    throw new DomainError(
      'BID_ON_BID_SENT',
      `${bid.reference} is ${bid.status.toLowerCase()}. The record of what was sent to a buyer must stay what was ` +
        'sent.',
      409,
    );
  }
  const engagement = requireOpenEngagement(ctx, bid.engagementId);
  return { bid, engagement };
}

// --- Creating a bid ----------------------------------------------------------

/**
 * Open a bid under an engagement. `C` on `BID_SERVICES`.
 *
 * The engagement is required and is checked for being open, which is the
 * specification's rule: a bid cannot be created against a paused, completed or
 * cancelled engagement. That is what makes every ACU the bid later spends
 * attributable to a customer and to a piece of commercial work.
 *
 * `sourceTenderId` is optional and stays empty for a bid started here. A
 * standalone bid never appears in the standard Tenders section, which is the
 * other half of the same acceptance criterion.
 */
export function createBid(
  ctx: EngineContext,
  input: {
    engagementId: string;
    buyerName: string;
    scheme: BidScheme;
    deadline: string;
    buyerReference?: string;
    sourceTenderId?: string;
    weights?: Record<string, number>;
  },
): Bid {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'C', { dataSensitivity: 'COMMERCIAL_L3' });

  const engagement = requireOpenEngagement(ctx, input.engagementId);
  const customer = requireVisibleCustomer(ctx, engagement.customerAccountId);

  const deadline = input.deadline.slice(0, 10);
  if (Number.isNaN(Date.parse(deadline))) {
    throw new DomainError('BID_ON_DEADLINE_INVALID', 'A deadline is a date', 400);
  }

  const weights = input.weights ?? DEFAULT_WEIGHTS;
  const weightTotal = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  if (Math.abs(weightTotal - 1) > 0.001) {
    throw new DomainError(
      'BID_ON_WEIGHTS_INVALID',
      `The rubric weights sum to ${weightTotal.toFixed(3)} rather than 1. They are not normalised quietly, because ` +
        'that would mean the rubric the buyer published and the rubric this platform applied are two different ' +
        'documents.',
      400,
    );
  }

  const id = ulid();
  const bid: Bid = {
    id,
    reference: formatRef('BON', bidsOf(ctx).length + 1),
    customerAccountId: customer.id,
    engagementId: engagement.id,
    ...(input.sourceTenderId ? { sourceTenderId: input.sourceTenderId } : {}),
    buyerName: requireText(input.buyerName, NAME_MIN, 'BID_ON_NAME_TOO_SHORT', 'A buyer name'),
    ...(input.buyerReference?.trim() ? { buyerReference: input.buyerReference.trim() } : {}),
    scheme: input.scheme,
    deadline,
    status: 'CREATED',
    // Copied, not referenced. A rubric reversioned next month must not restate
    // what a submission already sent was scored against.
    weights,
    questions: [],
    answers: [],
    gaps: [],
    createdAt: new Date().toISOString(),
    createdBy: ctx.auth.actorId,
  };

  write(ctx, {
    eventType: 'BID_ON_BID_CREATED',
    entity: { refType: 'BidOnBid', refId: id },
    nextState: { ...bid },
  });

  return bid;
}

/**
 * Confirm the question list. `C` on `BID_SERVICES`, and once.
 *
 * The only way questions enter a bid, and a human act by design: a parser that
 * misses one question produces a pack where every answer is good, readiness
 * reads 100%, and the submission is rejected for a missing mandatory response.
 * Nothing downstream can detect that, so a person confirms the list against the
 * source document while the source document is still open in front of them.
 *
 * Refused a second time. An answer approved against one question and silently
 * reattached to another is worse than the parsing error it was meant to fix; a
 * questionnaire that genuinely changed is a resync, which keeps approved
 * answers and redrafts only what moved.
 */
export function confirmQuestions(
  ctx: EngineContext,
  bidId: string,
  input: {
    questions: Array<{
      section: string;
      number: string;
      text: string;
      answerType: AnswerType;
      wordLimit?: number;
      weighting?: number;
      mandatory: boolean;
      passFail?: boolean;
      declarationKinds?: string[];
    }>;
  },
): Bid {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'C', { dataSensitivity: 'COMMERCIAL_L3' });

  const { bid } = requireWorkableBid(ctx, bidId);
  if (bid.questionsConfirmedAt) {
    throw new DomainError(
      'BID_ON_QUESTIONS_CONFIRMED',
      `${bid.reference} already has a confirmed question list. Reattaching approved answers to a changed list is ` +
        'worse than the parsing error it would fix — resync the source instead, which keeps approved answers and ' +
        'redrafts only the questions whose wording moved.',
      409,
    );
  }
  if (input.questions.length === 0) {
    throw new DomainError('BID_ON_NO_QUESTIONS', 'A questionnaire with no questions has not been read properly', 422);
  }

  const seen = new Set<string>();
  const questions: BidQuestion[] = input.questions.map((question) => {
    const number = requireText(question.number, 1, 'BID_ON_NUMBER_REQUIRED', 'A question number');
    // The buyer's own numbering, and it has to be unique. Two questions
    // numbered 4.2 is an export whose numbering does not match the source and a
    // reviewer who cannot tell which one they approved.
    if (seen.has(number)) {
      throw new DomainError(
        'BID_ON_NUMBER_DUPLICATED',
        `Two questions are numbered ${number}. The buyer's numbering is what the export has to match and what a ` +
          'reviewer identifies an answer by, so it cannot repeat.',
        400,
      );
    }
    seen.add(number);

    if (question.weighting !== undefined && (question.weighting < 0 || question.weighting > 100)) {
      throw new DomainError('BID_ON_WEIGHTING_RANGE', 'A weighting is a percentage between 0 and 100', 400);
    }
    if (question.wordLimit !== undefined && question.wordLimit < 1) {
      throw new DomainError('BID_ON_LIMIT_RANGE', 'A word limit is at least one word', 400);
    }

    return {
      id: ulid(),
      section: requireText(question.section, 1, 'BID_ON_SECTION_REQUIRED', 'A section'),
      number,
      text: requireText(question.text, NAME_MIN, 'BID_ON_QUESTION_TOO_SHORT', 'A question'),
      answerType: question.answerType,
      ...(question.wordLimit === undefined ? {} : { wordLimit: question.wordLimit }),
      ...(question.weighting === undefined ? {} : { weighting: question.weighting }),
      mandatory: question.mandatory,
      passFail: question.passFail ?? false,
      ...(question.declarationKinds?.length ? { declarationKinds: question.declarationKinds } : {}),
    };
  });

  const next: Bid = {
    ...bid,
    questions,
    questionsConfirmedAt: new Date().toISOString(),
    questionsConfirmedBy: ctx.auth.actorId,
    status: 'DRAFTING',
  };

  write(ctx, {
    eventType: 'BID_ON_QUESTIONS_CONFIRMED',
    entity: { refType: 'BidOnBid', refId: bidId },
    nextState: { ...next },
  });

  return next;
}

// --- Answers -----------------------------------------------------------------

/**
 * Record an answer, as a new version. `U` on `BID_SERVICES`.
 *
 * Called by the drafting agent and by a person editing afterwards, and the same
 * function for both on purpose: an answer a bid writer rewrote by hand has to
 * go through the same citation check, the same scoring and the same approval as
 * one a model produced. Two paths would mean the hand-written half of a pack
 * was checked less than the half nobody touched.
 *
 * **A citation has to point at this customer's own evidence.** Checked here
 * rather than trusted, because the citation list is the one field an agent
 * supplies that could name another customer's material, and the acceptance
 * criterion is that it cannot.
 */
export function recordAnswer(
  ctx: EngineContext,
  bidId: string,
  input: {
    questionId: string;
    body: string[];
    citations?: Array<{ evidenceId: string; chunkId: string }>;
    yesNo?: boolean;
    authorship?: 'HUMAN' | 'AI_DRAFTED';
    provider?: string;
  },
): { bid: Bid; answer: BidAnswerVersion } {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const { bid } = requireWorkableBid(ctx, bidId);
  const question = bid.questions.find((entry) => entry.id === input.questionId);
  if (!question) {
    throw new DomainError('BID_ON_QUESTION_NOT_FOUND', `${bid.reference} has no question ${input.questionId}`, 404);
  }

  const body = input.body.map((line) => line.trim()).filter(Boolean);
  if (body.length === 0 && input.yesNo === undefined) {
    throw new DomainError(
      'BID_ON_ANSWER_EMPTY',
      'An answer with no prose and no yes/no is not an answer. Raise a gap instead — a gap is something the customer ' +
        'can fix and an empty answer is something nobody can see.',
      400,
    );
  }
  if (question.answerType === 'YES_NO' && input.yesNo === undefined) {
    throw new DomainError(
      'BID_ON_YES_NO_REQUIRED',
      `${question.number} is a yes/no question, and the hard rule that ends a bid on a "no" reads that field. Prose ` +
        'alone leaves it unanswered as far as every check is concerned.',
      400,
    );
  }

  // Every citation, against this customer's own current evidence. The chunk has
  // to exist too: an evidence id with a chunk id from another document is a
  // citation that opens to the wrong page.
  const mine = new Map(
    evidenceOf(ctx)
      .filter((entry: BidOnEvidence) => entry.customerAccountId === bid.customerAccountId)
      .map((entry) => [entry.id, entry]),
  );
  const citations: AnswerCitation[] = (input.citations ?? []).map((citation) => {
    const evidence = mine.get(citation.evidenceId);
    if (!evidence) {
      throw new DomainError(
        'BID_ON_CITATION_FOREIGN',
        'A citation points at evidence that does not belong to this customer. One customer’s material can never ' +
          'appear in another customer’s answer, so this is refused rather than filtered out — a silently dropped ' +
          'citation leaves an uncited claim reading as a cited one.',
        403,
      );
    }
    const chunk = evidence.chunks.find((entry) => entry.id === citation.chunkId);
    if (!chunk) {
      throw new DomainError(
        'BID_ON_CITATION_UNKNOWN',
        `${evidence.reference} has no passage ${citation.chunkId}. A citation that opens to the wrong page is worse ` +
          'than none, because a reviewer checks it once and then trusts the rest.',
        400,
      );
    }
    return {
      evidenceId: evidence.id,
      chunkId: chunk.id,
      reference: evidence.reference,
      ...(chunk.pageRef ? { pageRef: chunk.pageRef } : {}),
    };
  });

  const previous = bid.answers.filter((entry) => entry.questionId === question.id);
  const answer: BidAnswerVersion = {
    id: ulid(),
    questionId: question.id,
    version: previous.length + 1,
    body,
    words: wordsOf(body),
    citations,
    ...(input.yesNo === undefined ? {} : { yesNo: input.yesNo }),
    authorship: input.authorship ?? 'HUMAN',
    ...(input.provider ? { provider: input.provider } : {}),
    status: 'IN_REVIEW',
    writtenAt: new Date().toISOString(),
    writtenBy: ctx.auth.actorId,
  };

  const next: Bid = { ...bid, answers: [...bid.answers, answer], status: 'DRAFTING' };

  write(ctx, {
    eventType: 'BID_ON_ANSWER_DRAFTED',
    entity: { refType: 'BidOnBid', refId: bidId },
    nextState: { ...next },
  });

  return { bid: next, answer };
}

/**
 * Score an answer. `U` on `BID_SERVICES`, and a separate act from writing it.
 *
 * The specification is specific about why: *"the scorer is a separate LLM call
 * from the drafter so it does not grade its own work."* Making that a separate
 * command rather than a convention is what enforces it — `recordAnswer` has no
 * score field at all, so a drafter cannot return one, and an answer with no
 * score is visibly unscored rather than quietly marked by whoever wrote it.
 *
 * The reasons are required, one per criterion. A score with no reason is a
 * number a reviewer cannot argue with, and the whole point of the override is
 * that a reviewer who disagrees can say so — which needs something to disagree
 * with.
 *
 * Scoring a superseded version is refused. The scorer running against version
 * one while version two is what the pack will send produces a readiness figure
 * for text nobody is going to read.
 */
export function scoreAnswer(
  ctx: EngineContext,
  bidId: string,
  answerId: string,
  input: { scores: CriterionScores; reasons: Record<string, string>; provider?: string },
): { bid: Bid; answer: BidAnswerVersion } {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const { bid } = requireWorkableBid(ctx, bidId);
  const answer = bid.answers.find((entry) => entry.id === answerId);
  if (!answer) {
    throw new DomainError('BID_ON_ANSWER_NOT_FOUND', `${bid.reference} has no answer ${answerId}`, 404);
  }
  const current = latestAnswer(bid, answer.questionId);
  if (current && current.id !== answer.id) {
    throw new DomainError(
      'BID_ON_ANSWER_SUPERSEDED',
      `Version ${answer.version} has been replaced by version ${current.version}. Scoring the older one produces a ` +
        'readiness figure for text nobody is going to read.',
      409,
    );
  }

  for (const [criterion, score] of Object.entries(input.scores)) {
    if (score < 0 || score > 100) {
      throw new DomainError('BID_ON_SCORE_RANGE', `${criterion} is scored between 0 and 100`, 400);
    }
    if (!(input.reasons[criterion] ?? '').trim()) {
      throw new DomainError(
        'BID_ON_SCORE_REASON_REQUIRED',
        `${criterion} was scored with no reason. A score nobody can argue with is a score a reviewer ignores, and ` +
          'the override exists precisely so they can disagree with something.',
        400,
      );
    }
  }

  const scored: BidAnswerVersion = {
    ...answer,
    scores: input.scores,
    scoreReasons: Object.fromEntries(
      Object.entries(input.reasons).map(([criterion, reason]) => [criterion, reason.trim()]),
    ),
    ...(input.provider ? { scoredBy: input.provider } : {}),
    scoredAt: new Date().toISOString(),
  };

  const next: Bid = {
    ...bid,
    answers: bid.answers.map((entry) => (entry.id === answerId ? scored : entry)),
  };

  write(ctx, {
    eventType: 'BID_ON_ANSWER_SCORED',
    entity: { refType: 'BidOnBid', refId: bidId },
    nextState: { ...next },
  });

  return { bid: next, answer: scored };
}

/** The latest version of the answer to one question, or none. */
export function latestAnswer(bid: Bid, questionId: string): BidAnswerVersion | undefined {
  return bid.answers
    .filter((entry) => entry.questionId === questionId)
    .sort((a, b) => b.version - a.version)[0];
}

/**
 * Approve an answer. `A` on `BID_SERVICES`, and never its own author.
 *
 * Where an agent drafted it, any reviewer may approve: the agent drafted and a
 * person signed, which is the review the specification asks for. Where a person
 * wrote it, that person approving is one person at both ends — the same refusal
 * the answer library and the evidence claim register already make.
 *
 * A score override is permitted and is recorded with the reason that justifies
 * it. A reviewer who disagrees with the scorer is usually right, and a platform
 * that would not let them say so would be a platform whose scores are ignored.
 * What it may not do is clear a hard rule: those are not opinions about prose.
 */
export function approveAnswer(
  ctx: EngineContext,
  bidId: string,
  answerId: string,
  input: { note: string; overrideScore?: number; overrideReason?: string },
): { bid: Bid; answer: BidAnswerVersion } {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'A', { dataSensitivity: 'COMMERCIAL_L3' });

  const { bid } = requireWorkableBid(ctx, bidId);
  const answer = bid.answers.find((entry) => entry.id === answerId);
  if (!answer) {
    throw new DomainError('BID_ON_ANSWER_NOT_FOUND', `${bid.reference} has no answer ${answerId}`, 404);
  }
  if (answer.status === 'APPROVED') {
    throw new DomainError('BID_ON_ANSWER_APPROVED', 'That version is already approved.', 409);
  }
  const current = latestAnswer(bid, answer.questionId);
  if (current && current.id !== answer.id) {
    throw new DomainError(
      'BID_ON_ANSWER_SUPERSEDED',
      `Version ${answer.version} has been replaced by version ${current.version}. Approving the older one would ` +
        'approve text the pack is not going to send.',
      409,
    );
  }

  if (answer.authorship === 'HUMAN' && answer.writtenBy === ctx.auth.actorId) {
    throw new DomainError(
      'BID_ON_SELF_APPROVAL',
      'You wrote this answer, so you cannot be the one who approves it. Where an agent drafted it a reviewer signing ' +
        'is the two-person check; where a person wrote it, the same person approving is one person at both ends of a ' +
        'statement going to a buyer.',
      409,
    );
  }

  const note = requireText(input.note, REASON_MIN, 'BID_ON_NOTE_TOO_SHORT', 'An approval note');
  if (input.overrideScore !== undefined) {
    if (input.overrideScore < 0 || input.overrideScore > 100) {
      throw new DomainError('BID_ON_SCORE_RANGE', 'A score is between 0 and 100', 400);
    }
    if (!(input.overrideReason ?? '').trim()) {
      throw new DomainError(
        'BID_ON_OVERRIDE_REASON_REQUIRED',
        'An override with no reason is a number nobody can argue with later. Say why the scorer was wrong.',
        400,
      );
    }
  }

  const approved: BidAnswerVersion = {
    ...answer,
    status: 'APPROVED',
    reviewedAt: new Date().toISOString(),
    reviewedBy: ctx.auth.actorId,
    reviewNote: note,
    ...(input.overrideScore === undefined
      ? {}
      : { overrideScore: input.overrideScore, overrideReason: input.overrideReason!.trim() }),
  };

  const next: Bid = {
    ...bid,
    answers: bid.answers.map((entry) => (entry.id === answerId ? approved : entry)),
  };

  write(ctx, {
    eventType: 'BID_ON_ANSWER_APPROVED',
    entity: { refType: 'BidOnBid', refId: bidId },
    nextState: { ...next },
  });

  return { bid: next, answer: approved };
}

/**
 * Reject an answer, with the instructions that go back to the drafter. `A`.
 *
 * The instructions are mandatory and are the point. A rejection with no
 * instruction is a round trip that produces the same answer again, and the
 * specification is specific: *"a rejected answer goes back to the drafter with
 * the reviewer's instructions attached."*
 */
export function rejectAnswer(
  ctx: EngineContext,
  bidId: string,
  answerId: string,
  input: { instructions: string },
): { bid: Bid; answer: BidAnswerVersion } {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'A', { dataSensitivity: 'COMMERCIAL_L3' });

  const { bid } = requireWorkableBid(ctx, bidId);
  const answer = bid.answers.find((entry) => entry.id === answerId);
  if (!answer) {
    throw new DomainError('BID_ON_ANSWER_NOT_FOUND', `${bid.reference} has no answer ${answerId}`, 404);
  }
  if (answer.status === 'REJECTED') {
    throw new DomainError('BID_ON_ANSWER_REJECTED', 'That version is already rejected.', 409);
  }

  const rejected: BidAnswerVersion = {
    ...answer,
    status: 'REJECTED',
    reviewedAt: new Date().toISOString(),
    reviewedBy: ctx.auth.actorId,
    reviewNote: requireText(
      input.instructions,
      REASON_MIN,
      'BID_ON_INSTRUCTIONS_REQUIRED',
      'Instructions for the redraft',
    ),
  };

  const next: Bid = {
    ...bid,
    answers: bid.answers.map((entry) => (entry.id === answerId ? rejected : entry)),
  };

  write(ctx, {
    eventType: 'BID_ON_ANSWER_REJECTED',
    entity: { refType: 'BidOnBid', refId: bidId },
    nextState: { ...next },
  });

  return { bid: next, answer: rejected };
}

// --- Gaps --------------------------------------------------------------------

/**
 * Raise a gap: something nobody can answer from the evidence held. `U`.
 *
 * The specification's rule is that **a gap pauses only its own question** — the
 * rest of the pack keeps drafting while the customer is asked. That is why a
 * gap is its own record against one question rather than a status on the bid:
 * a bid blocked by one missing certificate is a bid nobody works on for three
 * days.
 *
 * The prompt is written for the customer, not for the provider. "Social value
 * evidence missing" is a note to self; "we need the apprenticeship figures for
 * 2026 — how many starts and how many completions" is something somebody can
 * actually answer.
 */
export function raiseGap(
  ctx: EngineContext,
  bidId: string,
  input: { questionId: string; promptToClient: string },
): { bid: Bid; gap: BidGap } {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const { bid } = requireWorkableBid(ctx, bidId);
  if (!bid.questions.some((entry) => entry.id === input.questionId)) {
    throw new DomainError('BID_ON_QUESTION_NOT_FOUND', `${bid.reference} has no question ${input.questionId}`, 404);
  }
  const open = bid.gaps.find((entry) => entry.questionId === input.questionId && !entry.resolvedAt);
  if (open) {
    throw new DomainError(
      'BID_ON_GAP_OPEN',
      'There is already an open gap on that question. Two requests for one thing is two emails the customer has to ' +
        'reconcile; add to the existing one or close it.',
      409,
    );
  }

  const gap: BidGap = {
    id: ulid(),
    questionId: input.questionId,
    promptToClient: requireText(input.promptToClient, PROMPT_MIN, 'BID_ON_PROMPT_TOO_SHORT', 'A request to the client'),
    raisedAt: new Date().toISOString(),
    raisedBy: ctx.auth.actorId,
  };

  const next: Bid = { ...bid, gaps: [...bid.gaps, gap] };

  write(ctx, {
    eventType: 'BID_ON_GAP_RAISED',
    entity: { refType: 'BidOnBid', refId: bidId },
    nextState: { ...next },
  });

  return { bid: next, gap };
}

/**
 * Close a gap. `U` — and the customer's own people may do this.
 *
 * Either by filing evidence, which is the useful case, or by answering in text
 * where there is no document. The evidence has to be this customer's, checked
 * the same way a citation is.
 */
export function resolveGap(
  ctx: EngineContext,
  bidId: string,
  gapId: string,
  input: { evidenceId?: string; note: string },
): { bid: Bid; gap: BidGap } {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const { bid } = requireWorkableBid(ctx, bidId);
  const gap = bid.gaps.find((entry) => entry.id === gapId);
  if (!gap) throw new DomainError('BID_ON_GAP_NOT_FOUND', `${bid.reference} has no gap ${gapId}`, 404);
  if (gap.resolvedAt) {
    throw new DomainError('BID_ON_GAP_RESOLVED', 'That gap is already closed.', 409);
  }

  if (input.evidenceId) {
    const evidence = evidenceOf(ctx).find((entry) => entry.id === input.evidenceId);
    if (!evidence || evidence.customerAccountId !== bid.customerAccountId) {
      throw new DomainError(
        'BID_ON_CITATION_FOREIGN',
        'That evidence does not belong to this customer.',
        403,
      );
    }
  }

  const resolved: BidGap = {
    ...gap,
    resolvedAt: new Date().toISOString(),
    resolvedBy: ctx.auth.actorId,
    ...(input.evidenceId ? { resolvedEvidenceId: input.evidenceId } : {}),
    resolutionNote: requireText(input.note, REASON_MIN, 'BID_ON_NOTE_TOO_SHORT', 'A note'),
  };

  const next: Bid = { ...bid, gaps: bid.gaps.map((entry) => (entry.id === gapId ? resolved : entry)) };

  write(ctx, {
    eventType: 'BID_ON_GAP_RESOLVED',
    entity: { refType: 'BidOnBid', refId: bidId },
    nextState: { ...next },
  });

  return { bid: next, gap: resolved };
}

// --- Scoring the pack --------------------------------------------------------

export type ScoredQuestion = {
  question: BidQuestion;
  answer: BidAnswerVersion | null;
  verdict: Verdict;
  /** The open gap on this question, where there is one. */
  gap: BidGap | null;
  versions: number;
};

export type BidPosition = {
  bid: Omit<Bid, 'questions' | 'answers' | 'gaps'>;
  customer: { id: string; reference: string; legalName: string };
  questions: ScoredQuestion[];
  readiness: PackReadiness;
  openGaps: BidGap[];
  limits: string[];
};

/**
 * The bid as a screen and the export gate both need it.
 *
 * Computed on read. Nothing here is stored, for the reason every other position
 * in this platform gives: a stored readiness figure is a second copy of a
 * conclusion that moves the moment a certificate lapses, and the one somebody
 * trusts is whichever screen they had open.
 *
 * Every verdict is judged against **the bid's deadline**, not today, because
 * that is the day the buyer reads it.
 */
export function bidPosition(ctx: EngineContext, bidId: string): BidPosition {
  requireModuleReadable(ctx.grantedModules, ctx.heldModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const bid = requireBid(ctx, bidId);
  const customer = requireVisibleCustomer(ctx, bid.customerAccountId);
  const scored = scoreBid(ctx, bid, customer);

  const { questions: _q, answers: _a, gaps: _g, ...header } = bid;
  const limits: string[] = [];
  if (!bid.questionsConfirmedAt) {
    limits.push(
      'The question list has not been confirmed, so nothing can be drafted. A parser that missed a question ' +
        'produces a pack where every answer is good and the submission is still rejected, and only a person reading ' +
        'the source document can catch that.',
    );
  }
  const unscored = scored.filter((entry) => entry.answer && !entry.answer.scores).length;
  if (unscored > 0) {
    limits.push(
      `${unscored} answer(s) have been written and not scored, so their criterion scores are zero and the readiness ` +
        'figure understates the pack. Score them before reading it as a verdict.',
    );
  }

  return {
    bid: header,
    customer: { id: customer.id, reference: customer.reference, legalName: customer.legalName },
    questions: scored,
    readiness: packReadiness(
      scored.map((entry) => ({
        ...(entry.question.weighting === undefined ? {} : { weighting: entry.question.weighting }),
        mandatory: entry.question.mandatory,
        approved: entry.answer?.status === 'APPROVED',
        verdict: entry.verdict,
      })),
    ),
    openGaps: bid.gaps.filter((entry) => !entry.resolvedAt),
    limits,
  };
}

/** Every question with its latest answer and the verdict on it. */
function scoreBid(ctx: EngineContext, bid: Bid, customer: CustomerAccount): ScoredQuestion[] {
  const evidenceById = new Map(evidenceOf(ctx).map((entry) => [entry.id, entry]));
  const live = new Set(liveDeclarations(customer, bid.deadline).map((entry) => entry.kind));

  return bid.questions.map((question) => {
    const answer = latestAnswer(bid, question.id) ?? null;
    const citations = (answer?.citations ?? []).map((citation) => {
      const evidence = evidenceById.get(citation.evidenceId);
      return {
        reference: citation.reference,
        title: evidence?.title ?? citation.reference,
        ...(evidence?.expiresOn ? { expiresOn: evidence.expiresOn } : {}),
      };
    });

    // Which declarations this question rests on, and whether the customer has
    // confirmed each. An unstated kind is not checked: the hard rule is about
    // declarations the question actually needs.
    const declarations = (question.declarationKinds ?? []).map((kind) => ({
      statement: `${kind} declaration for ${customer.legalName}`,
      confirmed: live.has(kind as never),
    }));

    const verdict = verdictFor(
      {
        ...(answer?.scores
          ? { scores: answer.scores }
          : answer?.overrideScore !== undefined
            ? {
                // A reviewer's override stands in for the criterion scores
                // rather than being averaged with them. They looked at the
                // answer; the scorer looked at a prompt.
                scores: {
                  COMPLIANCE: answer.overrideScore,
                  EVIDENCE: answer.overrideScore,
                  BUYER_RELEVANCE: answer.overrideScore,
                  SPECIFICITY: answer.overrideScore,
                  CLARITY_AND_LIMITS: answer.overrideScore,
                },
              }
            : {}),
        answered: Boolean(answer && (answer.body.length > 0 || answer.yesNo !== undefined)),
        mandatory: question.mandatory,
        passFail: question.passFail,
        ...(answer?.yesNo === undefined ? {} : { passFailAnswer: answer.yesNo }),
        words: answer?.words ?? 0,
        ...(question.wordLimit === undefined ? {} : { wordLimit: question.wordLimit }),
        deadline: bid.deadline,
        citations,
        declarations,
      },
      bid.weights as never,
    );

    return {
      question,
      answer,
      verdict,
      gap: bid.gaps.find((entry) => entry.questionId === question.id && !entry.resolvedAt) ?? null,
      versions: bid.answers.filter((entry) => entry.questionId === question.id).length,
    };
  });
}

// --- Export and outcome ------------------------------------------------------

/**
 * Mark the pack exported, or refuse it. `I` on `BID_SERVICES`.
 *
 * The gate the specification states twice: refused unless every mandatory
 * answer is approved and out of red. The refusal names every blocking answer
 * rather than the first, because fixing them one attempt at a time is how
 * somebody decides at 4pm that the check is the problem.
 *
 * This records the act. Rendering the DOCX and XLSX in the questionnaire's own
 * structure is the exporter's job and is recorded in `docs/STATE.md` as
 * outstanding — what is built here is the gate, which is the part that stops a
 * rejected submission going out.
 */
export function exportBid(ctx: EngineContext, bidId: string): { bid: Bid; readiness: PackReadiness } {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'I', { dataSensitivity: 'COMMERCIAL_L3' });

  const { bid } = requireWorkableBid(ctx, bidId);
  const position = bidPosition(ctx, bidId);

  if (!position.readiness.exportable) {
    const named = position.readiness.blocking
      .map((entry) => {
        const question = position.questions[entry.index]?.question;
        return `${question?.number ?? entry.index} — ${entry.reason}`;
      })
      .join('; ');
    throw new DomainError(
      'BID_ON_NOT_EXPORTABLE',
      `${bid.reference} cannot be exported. ${position.readiness.blocking.length} mandatory answer(s) are red or ` +
        `unapproved: ${named}. A submission missing a mandatory response is not marked down, it is rejected, and ` +
        'everything else in it is spent for nothing.',
      422,
    );
  }

  const exported: Bid = {
    ...bid,
    status: 'EXPORTED',
    exportedAt: new Date().toISOString(),
    exportedBy: ctx.auth.actorId,
  };

  write(ctx, {
    eventType: 'BID_ON_BID_EXPORTED',
    entity: { refType: 'BidOnBid', refId: bidId },
    nextState: { ...exported },
  });

  return { bid: exported, readiness: position.readiness };
}

/**
 * Record what happened to it. `U` on `BID_SERVICES`.
 *
 * Submitted, won or lost, with the buyer's feedback where they gave any. The
 * outcome is what lets a rubric be tuned against reality rather than against
 * opinion, which is the only honest way a scoring rule improves.
 */
export function recordBidOutcome(
  ctx: EngineContext,
  bidId: string,
  input: { outcome: 'SUBMITTED' | 'WON' | 'LOST'; on?: string; feedback?: string },
): Bid {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const bid = requireBid(ctx, bidId);
  requireOpenEngagement(ctx, bid.engagementId);

  if (input.outcome === 'SUBMITTED' && bid.status !== 'EXPORTED') {
    throw new DomainError(
      'BID_ON_NOT_EXPORTED',
      `${bid.reference} has not been exported, so there is nothing that could have been submitted. Export it first — ` +
        'the gate on the export is what checks every mandatory answer is approved.',
      409,
    );
  }
  if ((input.outcome === 'WON' || input.outcome === 'LOST') && bid.status !== 'SUBMITTED') {
    throw new DomainError(
      'BID_ON_NOT_SUBMITTED',
      `${bid.reference} is ${bid.status.toLowerCase()}. A result follows a submission; recording one against a pack ` +
        'that was never sent would put an outcome on the record with nothing behind it.',
      409,
    );
  }

  const next: Bid = {
    ...bid,
    status: input.outcome,
    outcome: {
      outcome: input.outcome,
      on: (input.on ?? new Date().toISOString()).slice(0, 10),
      by: ctx.auth.actorId,
      ...(input.feedback?.trim() ? { feedback: input.feedback.trim() } : {}),
    },
  };

  write(ctx, {
    eventType: 'BID_ON_BID_OUTCOME_RECORDED',
    entity: { refType: 'BidOnBid', refId: bidId },
    nextState: { ...next },
  });

  return next;
}

// --- The register ------------------------------------------------------------

export type BidRegister = {
  bids: Array<{
    id: string;
    reference: string;
    customerAccountId: string;
    customerName: string;
    engagementReference: string;
    buyerName: string;
    scheme: BidScheme;
    deadline: string;
    status: BidStatus;
    questions: number;
    approved: number;
    openGaps: number;
    readinessPercent: number | null;
    exportable: boolean;
    daysLeft: number;
    standalone: boolean;
  }>;
  limits: string[];
  summary: string;
};

/** Every bid this person may see, with what is stopping each. */
export function bidRegister(ctx: EngineContext, asAt?: string): BidRegister {
  requireModuleReadable(ctx.grantedModules, ctx.heldModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const day = (asAt ?? new Date().toISOString()).slice(0, 10);
  const engagements = new Map(engagementsOf(ctx).map((entry) => [entry.id, entry]));
  const customers = new Map(
    ctx.ledger
      .listByTenant(ctx.tenantId, 'BidOnCustomer')
      .map((record) => record.state as unknown as CustomerAccount)
      .map((entry) => [entry.id, entry]),
  );

  const visible = bidsOf(ctx).filter((bid) => {
    const customer = customers.get(bid.customerAccountId);
    if (!customer) return false;
    return (
      customer.guests.some((guest) => guest.actorId === ctx.auth.actorId) ||
      customer.assignedStaff.includes(ctx.auth.actorId) ||
      customer.openedBy === ctx.auth.actorId
    );
  });

  const bids = visible
    .map((bid) => {
      const customer = customers.get(bid.customerAccountId)!;
      const scored = scoreBid(ctx, bid, customer);
      const readiness = packReadiness(
        scored.map((entry) => ({
          ...(entry.question.weighting === undefined ? {} : { weighting: entry.question.weighting }),
          mandatory: entry.question.mandatory,
          approved: entry.answer?.status === 'APPROVED',
          verdict: entry.verdict,
        })),
      );
      return {
        id: bid.id,
        reference: bid.reference,
        customerAccountId: bid.customerAccountId,
        customerName: customer.legalName,
        engagementReference: engagements.get(bid.engagementId)?.reference ?? '—',
        buyerName: bid.buyerName,
        scheme: bid.scheme,
        deadline: bid.deadline,
        status: bid.status,
        questions: bid.questions.length,
        approved: readiness.approved,
        openGaps: bid.gaps.filter((entry) => !entry.resolvedAt).length,
        readinessPercent: readiness.readinessPercent,
        exportable: readiness.exportable,
        daysLeft: Math.ceil((Date.parse(bid.deadline) - Date.parse(day)) / 86_400_000),
        standalone: bid.sourceTenderId === undefined,
      };
    })
    .sort((a, b) => a.deadline.localeCompare(b.deadline));

  const limits: string[] = [];
  const hidden = bidsOf(ctx).length - visible.length;
  if (hidden > 0) {
    limits.push(
      `${hidden} further bid(s) exist for customers you are not assigned to. A provider's customers compete with ` +
        'each other, so access is per customer.',
    );
  }
  const late = bids.filter(
    (bid) => bid.daysLeft < 0 && !['SUBMITTED', 'WON', 'LOST'].includes(bid.status),
  ).length;
  if (late > 0) {
    limits.push(`${late} bid(s) are past their deadline and were never recorded as submitted.`);
  }
  const gapped = bids.filter((bid) => bid.openGaps > 0).length;
  if (gapped > 0) {
    limits.push(
      `${gapped} bid(s) are waiting on the customer for something. A gap pauses its own question and nothing else, ` +
        'so the rest of each pack can still be drafted.',
    );
  }

  return {
    bids,
    limits,
    summary:
      bids.length === 0
        ? 'No bid yet. A bid belongs to an engagement, which is what makes the AI it spends attributable to a ' +
          'customer and a piece of commercial work.'
        : `${bids.length} bid(s): ${bids.filter((bid) => bid.exportable).length} ready to export, ` +
          `${bids.filter((bid) => bid.openGaps > 0).length} waiting on a customer.`,
  };
}
