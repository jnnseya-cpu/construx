import { DomainError } from '../../core/errors.ts';
import { formatRef, ulid } from '../../core/ids.ts';
import { authorise, write, type EngineContext } from '../../engines/context.ts';
import { requireModule, requireModuleReadable } from '../../identity/modules.ts';
import { tierCost } from '../../billing/acu.ts';
import { renderDocx } from '../../export/docx.ts';
import { renderXlsx } from '../../export/xlsx.ts';
import type { ClientBranding, DocumentBlock } from '../../export/exporter.ts';
import { hashEvidence } from '../../core/canonical.ts';
// The standard section's own clarification type, reused rather than restated: a
// question for the buyer is the same thing whichever module raised it, and two
// shapes for it would eventually say different things about the same tender.
import type { Clarification } from '../tenderintake.ts';
import { liveDeclarations, requireVisibleCustomer, type CustomerAccount } from './customers.ts';
import { requireOpenEngagement, engagementsOf, type Engagement } from './engagements.ts';
import { evidenceOf, type BidOnEvidence } from './evidence.ts';
import {
  DEFAULT_WEIGHTS,
  packReadiness,
  verdictFor,
  type CriterionScores,
  type PackReadiness,
  type ReturnableInput,
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

export const BID_STAGE = ['PQQ', 'ITT', 'SINGLE_STAGE'] as const;
export type BidStage = (typeof BID_STAGE)[number];

export const CLARIFICATION_STATUS = ['RAISED', 'ASKED', 'ANSWERED', 'WITHDRAWN'] as const;
export type ClarificationStatus = (typeof CLARIFICATION_STATUS)[number];

export const CLARIFICATION_SOURCE = ['LIMITS', 'RETURNABLES', 'AMENDMENTS', 'PERSON'] as const;
export type ClarificationSource = (typeof CLARIFICATION_SOURCE)[number];

/**
 * A question for the buyer, and what has happened to it.
 *
 * `Clarification` from `domain/tenderintake.ts` carries the question itself —
 * severity, subject, and the words it would be asked in — and that stays the
 * source of truth for it. What is added here is the **lifecycle**, because a
 * clarification that nobody sent is not a clarification, it is a note.
 *
 * A two-stage procurement is why this needs states at all. A PQQ has its own
 * clarification deadline, weeks before the ITT exists; the ITT has another.
 * Asking at the wrong stage is asking too late, and a buyer's answer at the PQQ
 * stage is a fact the ITT inherits. None of that is expressible in a list of
 * notes.
 */
export type BidClarification = Clarification & {
  id: string;
  status: ClarificationStatus;
  /** Which part of the module noticed it, or a person. */
  source: ClarificationSource;
  raisedAt: string;
  raisedBy: string;
  /** When it actually went to the buyer, and their own reference for it. */
  askedAt?: string;
  askedBy?: string;
  buyerReference?: string;
  /** What the buyer said, in their words. */
  answer?: string;
  answeredAt?: string;
  recordedBy?: string;
  /** Why it was dropped without being asked. */
  withdrawnReason?: string;
};

export const RETURNABLE_OWNER = ['PROVIDER', 'CUSTOMER'] as const;
export type ReturnableOwner = (typeof RETURNABLE_OWNER)[number];

export const RETURNABLE_STATUS = ['OUTSTANDING', 'SUPPLIED', 'WAIVED'] as const;
export type ReturnableStatus = (typeof RETURNABLE_STATUS)[number];

/**
 * One thing the invitation requires to be returned, as opposed to answered.
 *
 * ## Why this exists at all
 *
 * A pack is rarely only questions. A measured term contract arrives as nine
 * documents: the questionnaire, an order form to complete and sign, a cost
 * model to price, a schedule of amendments to accept or qualify, a stock list,
 * a specification, a code of conduct. Three of those carry questions and five
 * are **obligations with no question attached**, and a submission missing a
 * signed order form is rejected exactly as completely as one missing an answer.
 *
 * Before this existed, readiness read 100% on such a pack with the order form
 * unsigned, because readiness was about answers and nothing in the module knew
 * those documents existed as obligations. That is the most expensive kind of
 * wrong this module could be: it is confidently wrong at the one moment nobody
 * re-checks.
 *
 * The shape is `TenderDeliverable`'s from `domain/tenderintake.ts`, deliberately
 * — the standard section already worked out what a returnable needs to carry,
 * and a second, subtly different answer to the same question is how two screens
 * end up disagreeing about whether a submission is complete. What is added here
 * is `owner` as a two-value enum rather than a role, because in this module the
 * only distinction that matters is whether the provider produces it or the
 * customer does.
 */
export type BidReturnable = {
  id: string;
  /** The buyer's own reference — "Appendix 2". Never renumbered, for the same reason a question is not. */
  reference: string;
  title: string;
  /** Mandatory ones gate the export. An optional one left out is a decision, not a defect. */
  mandatory: boolean;
  /** What the buyer will accept — PDF, native spreadsheet, a signed original. */
  format?: string;
  pageLimit?: number;
  fileSizeLimitMb?: number;
  /** A wet or qualified signature. A lead time rather than a task. */
  signatureRequired?: boolean;
  /**
   * Who produces it.
   *
   * The distinction the whole register turns on. The provider writes prose; the
   * customer prices their own rates and signs their own contract. A cost model
   * is `CUSTOMER` and belongs in the request that goes to them, not on a bid
   * writer's list of things they have failed to do.
   */
  owner: ReturnableOwner;
  /** Our own date, earlier than the buyer's, and the one that actually binds. */
  internalDueBy?: string;
  status: ReturnableStatus;
  /** The evidence item that is it, where one was filed. */
  evidenceId?: string;
  suppliedAt?: string;
  suppliedBy?: string;
  supplyNote?: string;
  /** Why it turned out not to be required. Mandatory on a waiver. */
  waivedReason?: string;
  waivedAt?: string;
  waivedBy?: string;
  recordedAt: string;
  recordedBy: string;
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

/**
 * What the standard section's invitation looked like when a bid was imported
 * from it.
 *
 * Lives here rather than with the import code because it is part of the bid's
 * own state: a bid carries the reading it was created from for the life of the
 * record, and `sourceStanding` compares it against the tender as it stands now.
 * Copied, never referenced — see `importing.ts` for why a bid in progress must
 * not change underneath somebody.
 */
export type SourceDigest = {
  reference: string;
  clientName: string;
  title: string;
  /** The return deadline in force at the moment of the reading, as a date. */
  deadline: string;
  /** Descriptions of the documents the transmittal contained, as copied. */
  documents: string[];
  /** How many files the standard section had registered against it at the reading. */
  files: number;
  addenda: number;
  /** What the questions were worded as, keyed by the buyer's own number. */
  questionWording?: Record<string, string>;
  takenAt: string;
};

export type Bid = {
  id: string;
  reference: string;
  customerAccountId: string;
  engagementId: string;
  /** The standard-section tender this came from, where it was imported. */
  sourceTenderId?: string;
  /**
   * The source as it read at import or at the last resync.
   *
   * Set only on an imported bid. A bid started here has neither this nor
   * `sourceTenderId`, and `sourceStanding` says so rather than reporting drift
   * against nothing.
   */
  sourceDigest?: SourceDigest;
  /** The documents carried over from the invitation, by the names it recorded. */
  sourceDocuments?: string[];
  /**
   * Files already in the evidence store that arrived with that tender.
   *
   * The reason the import can be run without asking for the pack a second time:
   * `parseQuestionnaire` takes a hash, and these are hashes the store already
   * holds. Only files the standard section linked to the invitation appear here
   * — its `documents` list is a record of what the transmittal contained, in
   * words, and words are not a file.
   */
  sourceFiles?: Array<{ hash: string; description: string }>;
  buyerName: string;
  buyerReference?: string;
  scheme: BidScheme;
  /**
   * Which stage of the procurement this pack is.
   *
   * A PQQ and the ITT that follows it are **two submissions to one buyer about
   * one job**, with separate question sets, separate deadlines, separate
   * clarification windows and separate outcomes. Treating them as one bid loses
   * the PQQ's own result; treating them as unrelated loses the fact that the
   * ITT exists only because the PQQ was won, and that everything said at the
   * PQQ stage is on the record the ITT is read against.
   *
   * `SINGLE_STAGE` is the honest default for the many procurements that are one
   * questionnaire and done — a registration, a dynamic market application, an
   * open ITT with no prequalification.
   */
  stage: BidStage;
  /**
   * The PQQ this ITT came out of, where there was one.
   *
   * One direction only, and the later bid holds the link: a PQQ exists before
   * anybody knows whether an ITT will follow, so a forward pointer would be a
   * field that is empty exactly when it matters and backfilled afterwards.
   */
  followsBidId?: string;
  /**
   * The day the buyer stops accepting questions.
   *
   * Separate from the return deadline and almost always well before it, which
   * is the whole reason it is here. A clarification raised after this date
   * cannot be asked at all: a point that could have been negotiated becomes a
   * risk that has to be priced or accepted, and nothing else in the pack tells
   * anybody that window has shut.
   */
  clarificationDeadline?: string;
  /**
   * The day the buyer reads it. Every expiry is judged against this.
   *
   * Absent on a rolling submission, and absent rather than invented. See
   * `rolling` below for why that distinction is the whole point.
   */
  deadline?: string;
  /**
   * There is no day the buyer reads this, because they read it whenever they
   * look.
   *
   * A dynamic market under the Procurement Act accepts applications at any
   * point in its life and cannot cap its membership; a UVDB or Constructionline
   * registration is maintained rather than returned. None of those has a return
   * date, and the obvious workaround — put a target date in the deadline field
   * — is the thing this exists to avoid: every expiry verdict in the pack would
   * then be judged against a date somebody made up, and "this certificate
   * lapses before the deadline" would be a statement about an invention.
   *
   * So a rolling bid carries no deadline and is judged against **the day it is
   * read**, every time it is read. `judgedOn` is the one place that decides
   * which day that is, and the position says which day it used.
   *
   * `true` only, never `false`: absent means dated, so every bid written before
   * this existed replays as exactly what it was, with no migration and no
   * backfilled flag that would have to be trusted.
   */
  rolling?: true;
  status: BidStatus;
  /** The rubric weights in force for this bid, copied at creation. */
  weights: Record<string, number>;
  questions: BidQuestion[];
  /**
   * What the parser proposed, awaiting a person.
   *
   * Kept apart from `questions` deliberately. A proposal is a reading and the
   * list is a record: until somebody has checked it against the source
   * document, nothing may be drafted against it, nothing may be scored and no
   * readiness figure means anything. Keeping the two in one field would make
   * "has this been checked" unanswerable.
   */
  proposedQuestions?: Array<Omit<BidQuestion, 'id'>>;
  parsedAt?: string;
  /** Which provider read it. */
  parsedBy?: string;
  questionsConfirmedAt?: string;
  questionsConfirmedBy?: string;
  answers: BidAnswerVersion[];
  gaps: BidGap[];
  /**
   * What has to be returned rather than answered. Empty on a pack that is all
   * questions, which is why adding this changed nothing for the bids that
   * already existed.
   */
  returnables: BidReturnable[];
  /**
   * What to ask the buyer before their clarification deadline.
   *
   * Two sources, one concept. A question with no stated word limit and an
   * amendment that shifts risk onto the bidder are both *questions for the
   * buyer*, and both are useless if they surface after the clarification
   * deadline has passed. `Clarification` is the standard section's own type,
   * reused rather than restated.
   */
  clarifications: BidClarification[];
  /**
   * The last reading of a schedule of amendments, where one has been read.
   *
   * The observations, not a verdict. Nothing here accepts or qualifies
   * anything: a model's reading of an amended contract is a first pass that
   * puts the questions on the table before the clarification deadline, and the
   * decision it informs binds a company, which no agent mandate reaches.
   */
  amendmentsReview?: {
    observations: string[];
    contractForm: string;
    reviewedAt: string;
    reviewedBy: string;
    provider: string;
  };
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

/**
 * The day this pack's expiries and declarations are judged against.
 *
 * One function, because the alternative is each caller deciding — and a screen
 * that judged against today while the export gate judged against the deadline
 * would disagree about whether a certificate is valid, which is the only
 * question either of them is being asked.
 *
 * A dated bid is judged against its deadline, because that is the day the buyer
 * reads it and a certificate lapsing the week before return is not evidence for
 * that submission. A rolling bid has no such day, so it is judged against the
 * day it is being read — which means its readiness genuinely moves as
 * certificates age, and that is the honest behaviour for a membership somebody
 * maintains rather than returns.
 */
export function judgedOn(bid: Pick<Bid, 'deadline' | 'rolling'>, asAt?: string): string {
  if (!bid.rolling && bid.deadline) return bid.deadline.slice(0, 10);
  return (asAt ?? new Date().toISOString()).slice(0, 10);
}

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
    /** PQQ, the ITT that follows it, or a one-stage procurement. Defaults to one stage. */
    stage?: BidStage;
    /** The PQQ this ITT came out of. Implies `stage: 'ITT'` where the stage is not given. */
    followsBidId?: string;
    /** The day the buyer stops accepting questions. Earlier than the return. */
    clarificationDeadline?: string;
    deadline?: string;
    /** No return date: a dynamic market, or a registration that is maintained. */
    rolling?: true;
    buyerReference?: string;
    sourceTenderId?: string;
    weights?: Record<string, number>;
  },
): Bid {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'C', { dataSensitivity: 'COMMERCIAL_L3' });

  const engagement = requireOpenEngagement(ctx, input.engagementId);
  const customer = requireVisibleCustomer(ctx, engagement.customerAccountId);

  // Exactly one of the two, and the refusals say which mistake was made.
  // Neither is a default: a bid with no date that is not declared rolling is
  // somebody who forgot the deadline, and a rolling bid carrying a date is a
  // dated bid wearing the wrong label — in which case every expiry verdict in
  // it would be judged against a day that is not the day it is read.
  if (input.rolling && input.deadline) {
    throw new DomainError(
      'BID_ON_ROLLING_HAS_DEADLINE',
      'A rolling submission has no return date — that is what makes it rolling. Give a deadline or declare it ' +
        'rolling, not both: with both, every certificate in the pack would be judged against a date nobody is ' +
        'actually reading it on.',
      400,
    );
  }
  if (!input.rolling && !input.deadline) {
    throw new DomainError(
      'BID_ON_DEADLINE_REQUIRED',
      'Give the day the buyer reads it. Every certificate expiry, insurance date and declaration in the pack is ' +
        'judged against it. If there genuinely is no return date — a dynamic market, or a registration that is ' +
        'maintained rather than returned — say so with `rolling` and it is judged against the day it is read ' +
        'instead.',
      400,
    );
  }

  const deadline = input.deadline?.slice(0, 10);
  if (deadline !== undefined && Number.isNaN(Date.parse(deadline))) {
    throw new DomainError('BID_ON_DEADLINE_INVALID', 'A deadline is a date', 400);
  }

  /*
   * The stage, and the PQQ behind it.
   *
   * Giving a `followsBidId` and calling the bid a PQQ is a contradiction — a
   * prequalification does not follow a prequalification for the same job — so
   * the stage is inferred as ITT where it is not stated and refused where it
   * is stated as something else. The predecessor has to be a PQQ this person
   * can already see, for the same customer: a link to another customer's PQQ
   * would be the one leak this module exists to prevent, dressed as a
   * convenience.
   */
  const stage: BidStage = input.stage ?? (input.followsBidId ? 'ITT' : 'SINGLE_STAGE');
  if (input.followsBidId) {
    if (stage !== 'ITT') {
      throw new DomainError(
        'BID_ON_STAGE_CONTRADICTS',
        `A bid that follows a prequalification is the ITT stage, not ${stage}. Leave the stage out and it is taken ` +
          'as the ITT.',
        400,
      );
    }
    const previous = requireBid(ctx, input.followsBidId);
    if (previous.customerAccountId !== customer.id) {
      throw new DomainError(
        'BID_ON_PREDECESSOR_NOT_THIS_CUSTOMER',
        `${previous.reference} belongs to another customer. An ITT follows that customer's own prequalification, and ` +
          'nothing else.',
        409,
      );
    }
    if (previous.stage !== 'PQQ') {
      throw new DomainError(
        'BID_ON_PREDECESSOR_NOT_PQQ',
        `${previous.reference} is the ${previous.stage.toLowerCase().replace('_', ' ')} stage, so nothing follows ` +
          'it. An ITT follows a prequalification.',
        409,
      );
    }
  }

  // A window for questions that closes after the buyer has read the submission
  // is not a window. On a rolling bid there is no return to be before.
  const clarificationDeadline = input.clarificationDeadline?.slice(0, 10);
  if (clarificationDeadline !== undefined) {
    if (Number.isNaN(Date.parse(clarificationDeadline))) {
      throw new DomainError('BID_ON_CLARIFICATION_DATE_INVALID', 'A clarification deadline is a date', 400);
    }
    if (deadline && clarificationDeadline > deadline) {
      throw new DomainError(
        'BID_ON_CLARIFICATION_AFTER_RETURN',
        `The clarification deadline of ${clarificationDeadline} falls after the return deadline of ${deadline}. A ` +
          'window for questions that closes after the buyer has read the submission is not a window.',
        422,
      );
    }
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
    stage,
    ...(input.followsBidId ? { followsBidId: input.followsBidId } : {}),
    ...(clarificationDeadline ? { clarificationDeadline } : {}),
    ...(deadline ? { deadline } : {}),
    ...(input.rolling ? { rolling: true as const } : {}),
    status: 'CREATED',
    // Copied, not referenced. A rubric reversioned next month must not restate
    // what a submission already sent was scored against.
    weights,
    questions: [],
    answers: [],
    gaps: [],
    returnables: [],
    clarifications: [],
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
  // The proposal, where a person is accepting it unchanged. Explicit rather
  // than implicit: passing no questions means "the parse was right", which is
  // a decision, and passing a list means "this is the list", which is another.
  const proposal = (input.questions.length === 0 ? bid.proposedQuestions ?? [] : input.questions) as typeof input.questions;
  if (bid.questionsConfirmedAt) {
    throw new DomainError(
      'BID_ON_QUESTIONS_CONFIRMED',
      `${bid.reference} already has a confirmed question list. Reattaching approved answers to a changed list is ` +
        'worse than the parsing error it would fix — resync the source instead, which keeps approved answers and ' +
        'redrafts only the questions whose wording moved.',
      409,
    );
  }
  if (proposal.length === 0) {
    throw new DomainError(
      'BID_ON_NO_QUESTIONS',
      'There is no question list to confirm. Give it one, or read the questionnaire first — a questionnaire with no ' +
        'questions has not been read properly.',
      422,
    );
  }

  const seen = new Set<string>();
  const questions: BidQuestion[] = proposal.map((question) => {
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

  /*
   * An unstated word limit is a question for the buyer, not a free hand.
   *
   * The standard section raises clarifications for *dates* on its own — a
   * deadline with no time zone, a return time that occurs twice — because a
   * date nobody questioned is how a submission misses by an hour. Limits have
   * exactly the same shape and nothing raised them: a portal box with no stated
   * limit is answered at whatever length somebody felt like, and the two
   * outcomes are an answer truncated by the portal or one a reader stops
   * reading. Either is avoidable by asking.
   *
   * Only on text answers, and only where it is worth a question: a yes/no or a
   * numeric field has no length to limit, and raising one per question on a
   * hundred-question pack would produce a list nobody reads to the end.
   */
  const unstated = questions.filter(
    (question) => question.wordLimit === undefined && (question.answerType === 'TEXT' || question.answerType === 'TABLE'),
  );
  const raised: Clarification[] = [];
  if (unstated.length > 0) {
    raised.push({
      severity: 'MINOR',
      subject: `${unstated.length} question(s) state no length limit`,
      question:
        `Is there a word or page limit for ${unstated
          .slice(0, 8)
          .map((question) => question.number)
          .join(', ')}` +
        (unstated.length > 8 ? ` and ${unstated.length - 8} other(s)` : '') +
        '? Where a limit is not stated we will answer at a length we judge appropriate, and anything past a limit ' +
        'a portal applies silently is not read at all.',
    });
  }

  const next: Bid = {
    ...bid,
    questions,
    clarifications: raiseClarifications(ctx, bid.clarifications, raised, 'LIMITS'),
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

// --- Clarification requests --------------------------------------------------

/**
 * Why a clarification has states at all.
 *
 * Three of the four sources raise these automatically — a question with no
 * stated limit, a mandatory returnable with no stated format, an amendment that
 * shifts a risk — and a note nobody sent is worth nothing. What decides whether
 * a bid team got the benefit is whether the question reached the buyer **before
 * their clarification deadline**, which on a two-stage procurement is a
 * different date at each stage and is always well before the return.
 *
 * So: raised, asked, answered, withdrawn. The buyer's own reference is recorded
 * because that is what their answer will quote back, and their answer is
 * recorded in their words because a paraphrase of a buyer's answer is a new
 * claim with nobody's name on it.
 */

function requireClarification(bid: Bid, clarificationId: string): BidClarification {
  const held = bid.clarifications.find((entry) => entry.id === clarificationId);
  if (!held) {
    throw new DomainError(
      'BID_ON_CLARIFICATION_NOT_FOUND',
      `No clarification ${clarificationId} on ${bid.reference}`,
      404,
    );
  }
  return held;
}

/** Add a question a person spotted. `U` on `BID_SERVICES`. */
export function raiseClarification(
  ctx: EngineContext,
  bidId: string,
  input: { severity: Clarification['severity']; subject: string; question: string },
): { bid: Bid; clarification: BidClarification } {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const { bid } = requireWorkableBid(ctx, bidId);
  const subject = requireText(input.subject, NAME_MIN, 'BID_ON_SUBJECT_TOO_SHORT', 'A subject');
  const question = requireText(input.question, PROMPT_MIN, 'BID_ON_QUESTION_TOO_SHORT', 'A question for the buyer');

  if (bid.clarifications.some((entry) => entry.subject === subject)) {
    throw new DomainError(
      'BID_ON_CLARIFICATION_DUPLICATE',
      `${bid.reference} already has a clarification about "${subject}". Two questions to a buyer about one subject ` +
        'invites two answers that have to be reconciled.',
      409,
    );
  }

  const next: Bid = {
    ...bid,
    clarifications: raiseClarifications(ctx, bid.clarifications, [{ severity: input.severity, subject, question }], 'PERSON'),
  };

  write(ctx, {
    eventType: 'BID_ON_CLARIFICATION_RAISED',
    entity: { refType: 'BidOnBid', refId: bidId },
    nextState: { ...next },
  });

  return { bid: next, clarification: next.clarifications[next.clarifications.length - 1]! };
}

/**
 * Record that a question actually went to the buyer. `U` on `BID_SERVICES`.
 *
 * Takes the date rather than assuming today, because somebody records this
 * after the fact as often as at the time, and a wrong date here is worse than
 * none: the whole value of the field is answering "did we get it in before
 * their window shut".
 *
 * Asking **after** the clarification deadline is recorded rather than refused.
 * It is a fact, and often a fact worth having — a buyer may answer a late
 * question and may not — so the record carries it and the position says plainly
 * that it went late. Refusing would make the honest entry impossible and leave
 * the question looking un-asked for ever.
 */
export function markClarificationAsked(
  ctx: EngineContext,
  bidId: string,
  clarificationId: string,
  input: { askedOn?: string; buyerReference?: string },
): { bid: Bid; clarification: BidClarification; late: boolean } {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const { bid } = requireWorkableBid(ctx, bidId);
  const held = requireClarification(bid, clarificationId);

  if (held.status === 'ANSWERED') {
    throw new DomainError(
      'BID_ON_CLARIFICATION_ANSWERED',
      `${held.subject} has already been answered by the buyer. Asking it again would invite a second answer that has ` +
        'to be reconciled with the first.',
      409,
    );
  }
  if (held.status === 'WITHDRAWN') {
    throw new DomainError(
      'BID_ON_CLARIFICATION_WITHDRAWN',
      `${held.subject} was withdrawn. Raise it again rather than sending something somebody decided not to ask.`,
      409,
    );
  }

  const askedOn = (input.askedOn ?? new Date().toISOString()).slice(0, 10);
  const late = bid.clarificationDeadline !== undefined && askedOn > bid.clarificationDeadline;

  const asked: BidClarification = {
    ...held,
    status: 'ASKED',
    askedAt: askedOn,
    askedBy: ctx.auth.actorId,
    ...(input.buyerReference?.trim() ? { buyerReference: input.buyerReference.trim() } : {}),
  };

  const next: Bid = {
    ...bid,
    clarifications: bid.clarifications.map((entry) => (entry.id === clarificationId ? asked : entry)),
  };

  write(ctx, {
    eventType: 'BID_ON_CLARIFICATION_ASKED',
    entity: { refType: 'BidOnBid', refId: bidId },
    nextState: { ...next },
  });

  return { bid: next, clarification: asked, late };
}

/**
 * Record the buyer's answer. `U` on `BID_SERVICES`.
 *
 * In their words, verbatim, because a buyer's answer to a clarification is part
 * of the tender documents from the moment they give it — usually issued to
 * every bidder — and a paraphrase of it is a new claim with nobody's name on
 * it. What the answer *changes* is a separate act: a stated word limit goes on
 * the question, a waived document goes on the register, a moved date goes on
 * the bid. This records what was said and nothing else, so that the change and
 * the authority for it are two entries rather than one.
 */
export function recordClarificationAnswer(
  ctx: EngineContext,
  bidId: string,
  clarificationId: string,
  input: { answer: string; answeredOn?: string },
): { bid: Bid; clarification: BidClarification } {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const { bid } = requireWorkableBid(ctx, bidId);
  const held = requireClarification(bid, clarificationId);

  if (held.status === 'RAISED') {
    throw new DomainError(
      'BID_ON_CLARIFICATION_NOT_ASKED',
      `${held.subject} is not recorded as having been asked, so there is nobody whose answer this would be. Record ` +
        'that it went to the buyer first — the date it went is the thing a dispute about a late question turns on.',
      409,
    );
  }
  if (held.status === 'WITHDRAWN') {
    throw new DomainError(
      'BID_ON_CLARIFICATION_WITHDRAWN',
      `${held.subject} was withdrawn before it was asked.`,
      409,
    );
  }

  const answered: BidClarification = {
    ...held,
    status: 'ANSWERED',
    answer: requireText(input.answer, PROMPT_MIN, 'BID_ON_ANSWER_TOO_SHORT', "The buyer's answer"),
    answeredAt: (input.answeredOn ?? new Date().toISOString()).slice(0, 10),
    recordedBy: ctx.auth.actorId,
  };

  const next: Bid = {
    ...bid,
    clarifications: bid.clarifications.map((entry) => (entry.id === clarificationId ? answered : entry)),
  };

  write(ctx, {
    eventType: 'BID_ON_CLARIFICATION_ANSWERED',
    entity: { refType: 'BidOnBid', refId: bidId },
    nextState: { ...next },
  });

  return { bid: next, clarification: answered };
}

/**
 * Drop a question without asking it. `U` on `BID_SERVICES`.
 *
 * With a reason, because the module raises most of these itself and will raise
 * the same subject again the next time a register is added to. A withdrawal is
 * what stops that, so it has to carry why — otherwise the next person sees a
 * question that was dropped and no way to know whether it was answered
 * elsewhere, judged irrelevant, or simply missed.
 */
export function withdrawClarification(
  ctx: EngineContext,
  bidId: string,
  clarificationId: string,
  input: { reason: string },
): { bid: Bid; clarification: BidClarification } {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const { bid } = requireWorkableBid(ctx, bidId);
  const held = requireClarification(bid, clarificationId);

  if (held.status === 'ANSWERED') {
    throw new DomainError(
      'BID_ON_CLARIFICATION_ANSWERED',
      `${held.subject} has been answered by the buyer. Their answer is part of the tender documents and does not ` +
        'become un-given because we would rather not have asked.',
      409,
    );
  }

  const withdrawn: BidClarification = {
    ...held,
    status: 'WITHDRAWN',
    withdrawnReason: requireText(input.reason, REASON_MIN, 'BID_ON_REASON_TOO_SHORT', 'A reason'),
  };

  const next: Bid = {
    ...bid,
    clarifications: bid.clarifications.map((entry) => (entry.id === clarificationId ? withdrawn : entry)),
  };

  write(ctx, {
    eventType: 'BID_ON_CLARIFICATION_WITHDRAWN',
    entity: { refType: 'BidOnBid', refId: bidId },
    nextState: { ...next },
  });

  return { bid: next, clarification: withdrawn };
}

/** What the clarification position is, judged on a day. */
export type ClarificationStanding = {
  raised: number;
  asked: number;
  answered: number;
  withdrawn: number;
  /** Raised and not asked, where the window has already shut. */
  missed: number;
  /** Days until the buyer stops accepting questions. Null where no date is set. */
  daysToAsk: number | null;
  summary: string;
};

export function clarificationStanding(bid: Bid, asAt?: string): ClarificationStanding {
  const day = (asAt ?? new Date().toISOString()).slice(0, 10);
  const count = (status: ClarificationStatus) => bid.clarifications.filter((entry) => entry.status === status).length;

  const shut = bid.clarificationDeadline !== undefined && bid.clarificationDeadline < day;
  const raised = count('RAISED');
  const daysToAsk =
    bid.clarificationDeadline === undefined
      ? null
      : Math.ceil((Date.parse(bid.clarificationDeadline) - Date.parse(day)) / 86_400_000);

  return {
    raised,
    asked: count('ASKED'),
    answered: count('ANSWERED'),
    withdrawn: count('WITHDRAWN'),
    missed: shut ? raised : 0,
    daysToAsk,
    summary:
      bid.clarifications.length === 0
        ? 'Nothing to ask the buyer.'
        : `${raised} to ask, ${count('ASKED')} awaiting an answer, ${count('ANSWERED')} answered` +
          (count('WITHDRAWN') > 0 ? `, ${count('WITHDRAWN')} withdrawn` : '') +
          '.' +
          (bid.clarificationDeadline === undefined
            ? ' No clarification deadline is recorded, so nothing here knows when the window shuts — and it is ' +
              'almost always well before the return.'
            : shut
              ? ` The window shut on ${bid.clarificationDeadline}.` +
                (raised > 0
                  ? ` ${raised} question(s) were never asked: each is now a point that has to be priced or accepted ` +
                    'rather than negotiated.'
                  : '')
              : ` ${daysToAsk} day(s) left to ask, until ${bid.clarificationDeadline}.`),
  };
}

// --- Returnables -------------------------------------------------------------

/**
 * Record what the invitation requires to be returned. `U` on `BID_SERVICES`.
 *
 * Additive rather than a confirmation step, and that is deliberate. The
 * question list is confirmed **once**, because an answer approved against one
 * question and silently reattached to another is worse than the parsing error
 * it would fix. A returnable register is the opposite: a person finds the order
 * form in appendix 2, the cost model in appendix 5 and the amendments in
 * appendix 3 as they read nine documents over an afternoon, and a register that
 * had to be right in one go is a register nobody fills in. So this appends, and
 * refuses a reference it already holds rather than quietly replacing it — two
 * entries for appendix 2 is two things a reviewer has to check separately.
 */
export function recordReturnables(
  ctx: EngineContext,
  bidId: string,
  input: {
    returnables: Array<{
      reference: string;
      title: string;
      mandatory: boolean;
      owner: ReturnableOwner;
      format?: string;
      pageLimit?: number;
      fileSizeLimitMb?: number;
      signatureRequired?: boolean;
      internalDueBy?: string;
    }>;
  },
): { bid: Bid; added: number; clarifications: Clarification[] } {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const { bid } = requireWorkableBid(ctx, bidId);

  if (input.returnables.length === 0) {
    throw new DomainError('BID_ON_NOTHING_TO_RECORD', 'Name at least one returnable', 400);
  }

  const held = new Set(bid.returnables.map((entry) => entry.reference.toLowerCase()));
  const now = new Date().toISOString();
  const added: BidReturnable[] = [];
  const raised: Clarification[] = [];

  for (const entry of input.returnables) {
    const reference = requireText(entry.reference, 1, 'BID_ON_REFERENCE_REQUIRED', 'A returnable reference');
    if (held.has(reference.toLowerCase())) {
      throw new DomainError(
        'BID_ON_RETURNABLE_DUPLICATE',
        `${reference} is already on this bid's register. Two entries for one appendix is two things a reviewer has ` +
          'to check separately, and the second says nothing the first did not.',
        409,
      );
    }
    held.add(reference.toLowerCase());

    const title = requireText(entry.title, NAME_MIN, 'BID_ON_TITLE_TOO_SHORT', 'A returnable title');

    // Our own date cannot fall after the buyer's. On a rolling submission there
    // is no buyer's date to fall after, so there is nothing to check.
    if (entry.internalDueBy && bid.deadline && entry.internalDueBy.slice(0, 10) > bid.deadline) {
      throw new DomainError(
        'BID_ON_INTERNAL_DATE_AFTER_RETURN',
        `${reference} carries an internal date of ${entry.internalDueBy}, which is after the return deadline of ` +
          `${bid.deadline}. The internal date is the one that binds, and one set after the return binds nothing.`,
        422,
      );
    }

    added.push({
      id: ulid(),
      reference,
      title,
      mandatory: entry.mandatory,
      owner: entry.owner,
      ...(entry.format?.trim() ? { format: entry.format.trim() } : {}),
      ...(entry.pageLimit === undefined ? {} : { pageLimit: entry.pageLimit }),
      ...(entry.fileSizeLimitMb === undefined ? {} : { fileSizeLimitMb: entry.fileSizeLimitMb }),
      ...(entry.signatureRequired ? { signatureRequired: true } : {}),
      ...(entry.internalDueBy ? { internalDueBy: entry.internalDueBy.slice(0, 10) } : {}),
      status: 'OUTSTANDING',
      recordedAt: now,
      recordedBy: ctx.auth.actorId,
    });

    // A signature is a lead time, not a task, and a mandatory one with no
    // internal date ahead of the return is how a wet signature is discovered on
    // the last afternoon.
    if (entry.signatureRequired && entry.mandatory && !entry.internalDueBy) {
      raised.push({
        severity: 'MAJOR',
        subject: `${reference} needs a signature and has no internal date`,
        question:
          `${title} requires a signature and no internal date has been set for it. A wet or qualified signature is ` +
          'a lead time rather than a task. Confirm who signs it and by when.',
      });
    }
    // A format nobody recorded is a submission rejected on a filename, which is
    // rejected as completely as one rejected on price.
    if (entry.mandatory && !entry.format?.trim()) {
      raised.push({
        severity: 'MINOR',
        subject: `${reference} has no stated format`,
        question:
          `In what format should ${title} be returned — PDF, the native spreadsheet, or a signed original? A ` +
          'submission rejected on a format is rejected as completely as one rejected on price.',
      });
    }
  }

  const next: Bid = {
    ...bid,
    returnables: [...bid.returnables, ...added],
    clarifications: raiseClarifications(ctx, bid.clarifications, raised, 'RETURNABLES'),
  };

  write(ctx, {
    eventType: 'BID_ON_RETURNABLES_RECORDED',
    entity: { refType: 'BidOnBid', refId: bidId },
    nextState: { ...next },
  });

  return { bid: next, added: added.length, clarifications: raised };
}

function requireReturnable(bid: Bid, returnableId: string): BidReturnable {
  const returnable = bid.returnables.find((entry) => entry.id === returnableId);
  if (!returnable) {
    throw new DomainError('BID_ON_RETURNABLE_NOT_FOUND', `No returnable ${returnableId} on ${bid.reference}`, 404);
  }
  return returnable;
}

/**
 * Mark a returnable supplied. `U` on `BID_SERVICES`.
 *
 * `evidenceId` is optional and is strongly preferred: a returnable pointing at
 * the filed item that is it can be checked by somebody else in ten seconds,
 * and one that merely says "done" can only be checked by asking whoever ticked
 * it. Where it is given it has to be this customer's own item, for the same
 * reason a citation does — the filter is not a formality in a module where two
 * customers compete for the same framework.
 */
export function supplyReturnable(
  ctx: EngineContext,
  bidId: string,
  returnableId: string,
  input: { evidenceId?: string; note?: string },
): { bid: Bid; returnable: BidReturnable } {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const { bid } = requireWorkableBid(ctx, bidId);
  const returnable = requireReturnable(bid, returnableId);

  if (returnable.status === 'SUPPLIED') {
    throw new DomainError(
      'BID_ON_RETURNABLE_SUPPLIED',
      `${returnable.reference} is already recorded as supplied on ${returnable.suppliedAt?.slice(0, 10)}.`,
      409,
    );
  }

  if (input.evidenceId) {
    const item = evidenceOf(ctx).find((entry) => entry.id === input.evidenceId);
    if (!item || item.customerAccountId !== bid.customerAccountId) {
      throw new DomainError(
        'BID_ON_EVIDENCE_NOT_THIS_CUSTOMER',
        'That evidence item is not this customer\u2019s own. A returnable can only point at something filed for the ' +
          'customer whose submission it is.',
        404,
      );
    }
    if (item.withdrawnAt) {
      throw new DomainError(
        'BID_ON_EVIDENCE_WITHDRAWN',
        `${item.reference} has been withdrawn, so it cannot be what satisfies ${returnable.reference}.`,
        409,
      );
    }
  }

  const supplied: BidReturnable = {
    ...returnable,
    status: 'SUPPLIED',
    ...(input.evidenceId ? { evidenceId: input.evidenceId } : {}),
    ...(input.note?.trim() ? { supplyNote: input.note.trim() } : {}),
    suppliedAt: new Date().toISOString(),
    suppliedBy: ctx.auth.actorId,
  };

  const next: Bid = {
    ...bid,
    returnables: bid.returnables.map((entry) => (entry.id === returnableId ? supplied : entry)),
  };

  write(ctx, {
    eventType: 'BID_ON_RETURNABLE_SUPPLIED',
    entity: { refType: 'BidOnBid', refId: bidId },
    nextState: { ...next },
  });

  return { bid: next, returnable: supplied };
}

/**
 * Record that a returnable is not required after all. `A` on `BID_SERVICES`.
 *
 * Approval rather than update, because this is the one command here that
 * removes a gate. The reason is mandatory and is the point: a waiver with none
 * is indistinguishable from a returnable nobody chased, and the difference
 * matters when a submission comes back rejected for a missing document.
 */
export function waiveReturnable(
  ctx: EngineContext,
  bidId: string,
  returnableId: string,
  input: { reason: string },
): { bid: Bid; returnable: BidReturnable } {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'A', { dataSensitivity: 'COMMERCIAL_L3' });

  const { bid } = requireWorkableBid(ctx, bidId);
  const returnable = requireReturnable(bid, returnableId);

  if (returnable.status === 'SUPPLIED') {
    throw new DomainError(
      'BID_ON_RETURNABLE_SUPPLIED',
      `${returnable.reference} has already been supplied, so there is nothing to waive.`,
      409,
    );
  }

  const waived: BidReturnable = {
    ...returnable,
    status: 'WAIVED',
    waivedReason: requireText(input.reason, REASON_MIN, 'BID_ON_REASON_TOO_SHORT', 'A reason'),
    waivedAt: new Date().toISOString(),
    waivedBy: ctx.auth.actorId,
  };

  const next: Bid = {
    ...bid,
    returnables: bid.returnables.map((entry) => (entry.id === returnableId ? waived : entry)),
  };

  write(ctx, {
    eventType: 'BID_ON_RETURNABLE_WAIVED',
    entity: { refType: 'BidOnBid', refId: bidId },
    nextState: { ...next },
  });

  return { bid: next, returnable: waived };
}

/** What readiness needs to know about the register. */
export function returnableReadiness(bid: Bid, asAt?: string): ReturnableInput {
  const day = judgedOn(bid, asAt);
  return bid.returnables.map((entry) => ({
    reference: entry.reference,
    title: entry.title,
    mandatory: entry.mandatory,
    outstanding: entry.status === 'OUTSTANDING',
    reason:
      entry.owner === 'CUSTOMER'
        ? `Waiting on the customer${entry.internalDueBy ? `, due ${entry.internalDueBy}` : ''}.` +
          (entry.internalDueBy && entry.internalDueBy < day ? ' That date has passed.' : '')
        : `Nobody has supplied it${entry.signatureRequired ? ', and it needs a signature' : ''}` +
          (entry.internalDueBy ? `, due ${entry.internalDueBy}` : '') +
          '.' +
          (entry.internalDueBy && entry.internalDueBy < day ? ' That date has passed.' : ''),
  }));
}

/**
 * Turn questions noticed by the module into clarifications on the record.
 *
 * Matched on subject, because these are raised again every time a register is
 * added to or a schedule is re-read, and a list repeating "no stated format"
 * nine times is a list nobody reads to the end. A subject already **withdrawn**
 * is not raised again either: somebody decided not to ask it, and a module that
 * put it back would be overruling them every time the page reloaded.
 */
export function raiseClarifications(
  ctx: EngineContext,
  held: BidClarification[],
  raised: Clarification[],
  source: ClarificationSource,
): BidClarification[] {
  const subjects = new Set(held.map((entry) => entry.subject));
  const now = new Date().toISOString();
  return [
    ...held,
    ...raised
      .filter((entry) => !subjects.has(entry.subject))
      .map((entry) => ({
        ...entry,
        id: ulid(),
        status: 'RAISED' as const,
        source,
        raisedAt: now,
        raisedBy: ctx.auth.actorId,
      })),
  ];
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
  /**
   * The day every verdict in this position was judged against.
   *
   * The deadline on a dated bid, today on a rolling one. Published rather than
   * left implicit because on a rolling bid the answer changes daily, and a
   * readiness figure somebody screenshots is worthless without the date it was
   * true on.
   */
  judgementDay: string;
  customer: { id: string; reference: string; legalName: string };
  questions: ScoredQuestion[];
  readiness: PackReadiness;
  /** What has to be returned rather than answered, and where each one stands. */
  returnables: BidReturnable[];
  /** What to ask the buyer, raised from the questions, the register and the amendments. */
  clarifications: BidClarification[];
  /** Where those stand, and how long is left to ask them. */
  clarificationStanding: ClarificationStanding;
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
 * that is the day the buyer reads it — or, on a rolling submission that has no
 * such day, against the day it is being read. `judgedOn` decides which, and
 * `judgementDay` on the result says which it used: a readiness figure with no
 * date attached is one nobody can check tomorrow.
 */
export function bidPosition(ctx: EngineContext, bidId: string, asAt?: string): BidPosition {
  requireModuleReadable(ctx.grantedModules, ctx.heldModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const bid = requireBid(ctx, bidId);
  const customer = requireVisibleCustomer(ctx, bid.customerAccountId);

  /*
   * Two different dates, and conflating them was a real bug.
   *
   * `day` is the day the pack is *judged* against — the deadline on a dated
   * bid, because that is when the buyer reads it and a certificate lapsing
   * before then is no use. `readOn` is simply today. Expiry and declarations
   * use the first; the clarification window uses the second, because a question
   * can only be asked now and whether the window has shut is a fact about today
   * rather than about the return.
   *
   * Passing `day` to the clarification standing made every unasked question on
   * a dated bid read as missed, since the deadline is always on or after the
   * clarification deadline. Caught by a test reading a pack five weeks before
   * its window shut and being told the window had shut.
   */
  const day = judgedOn(bid, asAt);
  const readOn = (asAt ?? new Date().toISOString()).slice(0, 10);
  const scored = scoreBid(ctx, bid, customer, day);

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

  const outstanding = bid.returnables.filter((entry) => entry.status === 'OUTSTANDING');
  if (outstanding.length > 0) {
    const theirs = outstanding.filter((entry) => entry.owner === 'CUSTOMER');
    limits.push(
      `${outstanding.length} returnable(s) are outstanding: ` +
        `${outstanding.map((entry) => entry.reference).join(', ')}` +
        (theirs.length > 0
          ? `. ${theirs.length} of those are the customer's to produce — a priced cost model or a signed contract is ` +
            'theirs, not a bid writer\u2019s, and they appear in the request that goes to them.'
          : '.'),
    );
  }
  const standing = clarificationStanding(bid, readOn);
  if (standing.raised > 0 || standing.missed > 0) {
    limits.push(standing.summary);
  }
  if (bid.rolling) {
    limits.push(
      `This is a rolling submission with no return date, so every expiry and declaration is judged against today ` +
        `(${day}) and re-judged on every read. A pack that is green now can go red on its own as a certificate ` +
        'ages, which is the honest behaviour for a membership nobody returns — watch the expiry dates rather than ' +
        'the readiness figure alone.',
    );
  }

  return {
    bid: header,
    judgementDay: day,
    customer: { id: customer.id, reference: customer.reference, legalName: customer.legalName },
    questions: scored,
    readiness: packReadiness(
      scored.map((entry) => ({
        ...(entry.question.weighting === undefined ? {} : { weighting: entry.question.weighting }),
        mandatory: entry.question.mandatory,
        approved: entry.answer?.status === 'APPROVED',
        verdict: entry.verdict,
      })),
      // The second half of a submission. Empty on a pack that is all questions,
      // which is why this changed nothing for the bids that already existed.
      returnableReadiness(bid, day),
    ),
    returnables: bid.returnables,
    clarifications: bid.clarifications,
    clarificationStanding: clarificationStanding(bid, readOn),
    openGaps: bid.gaps.filter((entry) => !entry.resolvedAt),
    limits,
  };
}

/** Every question with its latest answer and the verdict on it. */
function scoreBid(ctx: EngineContext, bid: Bid, customer: CustomerAccount, day: string): ScoredQuestion[] {
  const evidenceById = new Map(evidenceOf(ctx).map((entry) => [entry.id, entry]));
  const live = new Set(liveDeclarations(customer, day).map((entry) => entry.kind));

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
        // The day the pack is judged against, which the rubric calls the
        // deadline because on a dated bid that is exactly what it is.
        deadline: day,
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
    const missing = position.readiness.returnablesOutstanding
      .map((entry) => `${entry.reference} ${entry.title} — ${entry.reason}`)
      .join('; ');

    // Both halves in one refusal, each only where it applies. A gate that said
    // "mandatory answers are red" when the real problem was an unsigned order
    // form would send somebody to re-read answers that are fine.
    throw new DomainError(
      'BID_ON_NOT_EXPORTABLE',
      `${bid.reference} cannot be exported. ` +
        (position.readiness.blocking.length > 0
          ? `${position.readiness.blocking.length} mandatory answer(s) are red or unapproved: ${named}. `
          : '') +
        (position.readiness.returnablesOutstanding.length > 0
          ? `${position.readiness.returnablesOutstanding.length} mandatory returnable(s) are outstanding: ` +
            `${missing}. `
          : '') +
        'A submission missing a mandatory response or a required document is not marked down, it is rejected, and ' +
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
    /** Absent on a rolling submission, which has no return date at all. */
    deadline?: string;
    rolling?: true;
    status: BidStatus;
    questions: number;
    approved: number;
    openGaps: number;
    /** Returnables nobody has supplied or waived. Mandatory ones block the export. */
    returnablesOutstanding: number;
    /** Of those, the ones only the customer can produce — their rates, their signature. */
    returnablesWithCustomer: number;
    /** Raised and not yet asked. The ones still worth doing something about. */
    clarifications: number;
    /** Raised, never asked, and the window has shut. Each is a point that cannot be negotiated now. */
    clarificationsMissed: number;
    stage: BidStage;
    followsBidId?: string;
    clarificationDeadline?: string;
    /** Whether a schedule of amendments has been read on this bid. */
    amendmentsReviewed: boolean;
    readinessPercent: number | null;
    exportable: boolean;
    /** Null where there is no deadline to count down to. */
    daysLeft: number | null;
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
      const scored = scoreBid(ctx, bid, customer, judgedOn(bid, day));
      const readiness = packReadiness(
        scored.map((entry) => ({
          ...(entry.question.weighting === undefined ? {} : { weighting: entry.question.weighting }),
          mandatory: entry.question.mandatory,
          approved: entry.answer?.status === 'APPROVED',
          verdict: entry.verdict,
        })),
        returnableReadiness(bid, day),
      );
      return {
        id: bid.id,
        reference: bid.reference,
        customerAccountId: bid.customerAccountId,
        customerName: customer.legalName,
        engagementReference: engagements.get(bid.engagementId)?.reference ?? '—',
        buyerName: bid.buyerName,
        scheme: bid.scheme,
        ...(bid.deadline ? { deadline: bid.deadline } : {}),
        ...(bid.rolling ? { rolling: true as const } : {}),
        status: bid.status,
        questions: bid.questions.length,
        approved: readiness.approved,
        openGaps: bid.gaps.filter((entry) => !entry.resolvedAt).length,
        // The half a readiness percentage cannot see. Counted separately on the
        // row because "92% ready" beside "order form unsigned" is the only
        // honest way to show both at once.
        returnablesOutstanding: bid.returnables.filter((entry) => entry.status === 'OUTSTANDING').length,
        // Split out, because the customer's own screen has to show what is
        // waiting on *them* — a priced cost model is theirs — and lumping it
        // in with the provider's own outstanding documents would tell a
        // contractor they are late for something they were never asked for.
        returnablesWithCustomer: bid.returnables.filter(
          (entry) => entry.status === 'OUTSTANDING' && entry.owner === 'CUSTOMER',
        ).length,
        clarifications: bid.clarifications.filter((entry) => entry.status === 'RAISED').length,
        clarificationsMissed: clarificationStanding(bid, day).missed,
        stage: bid.stage,
        ...(bid.followsBidId ? { followsBidId: bid.followsBidId } : {}),
        ...(bid.clarificationDeadline ? { clarificationDeadline: bid.clarificationDeadline } : {}),
        // So a screen knows whether there is a reading to fetch without
        // opening every pack to find out. The observations themselves are not
        // on the row: a register is a list, and one carrying a paragraph per
        // bid is a list nobody can scan.
        amendmentsReviewed: bid.amendmentsReview !== undefined,
        readinessPercent: readiness.readinessPercent,
        exportable: readiness.exportable,
        // Null on a rolling bid, not zero and not a large number: there is no
        // day to count down to, and a countdown of 0 would read as "due today"
        // on a submission that has no due date at all.
        daysLeft: bid.deadline
          ? Math.ceil((Date.parse(bid.deadline) - Date.parse(day)) / 86_400_000)
          : null,
        standalone: bid.sourceTenderId === undefined,
      };
    })
    // Soonest first, and the rolling ones last — they are never the thing with
    // the least time left, because they have no time left to have.
    .sort((a, b) => (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999'));

  const limits: string[] = [];
  const hidden = bidsOf(ctx).length - visible.length;
  if (hidden > 0) {
    limits.push(
      `${hidden} further bid(s) exist for customers you are not assigned to. A provider's customers compete with ` +
        'each other, so access is per customer.',
    );
  }
  // A rolling bid is never late: there is no date for it to be past. Counting
  // one here would put a permanent false alarm on the screen for every
  // membership the provider maintains.
  const late = bids.filter(
    (bid) => bid.daysLeft !== null && bid.daysLeft < 0 && !['SUBMITTED', 'WON', 'LOST'].includes(bid.status),
  ).length;
  if (late > 0) {
    limits.push(`${late} bid(s) are past their deadline and were never recorded as submitted.`);
  }
  const rolling = bids.filter((bid) => bid.rolling).length;
  if (rolling > 0) {
    limits.push(
      `${rolling} of these are rolling submissions with no return date — a dynamic market, or a registration that ` +
        'is maintained rather than returned. They are judged against today and re-judged on every read, so one can ' +
        'go red on its own as a certificate ages.',
    );
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

// --- The quote before the run ------------------------------------------------

export type AcuEstimate = {
  bidId: string;
  reference: string;
  /** What is actually left to do, which is what decides the cost. */
  questionsOutstanding: number;
  answersToScore: number;
  /** Passages in this customer's library a drafter may be given. */
  passagesAvailable: number;
  /** One run per outstanding question, plus one score each. */
  runs: number;
  rawCostMinor: number;
  chargeMinor: number;
  multiplier: number;
  limits: string[];
  summary: string;
};

/**
 * What an agent run on this pack would cost, before it starts.
 *
 * The specification asks for this, and `doors.test.ts` now requires it: a
 * tenant-quoted AI route is refused unless an estimate route exists for the
 * same prefix, because the rule every AI action in this platform keeps is that
 * the cost is shown first. A module whose work has no project in its URL still
 * has to keep it.
 *
 * Sized from what is left rather than from the pack. A hundred-question
 * questionnaire with ninety answers approved costs ten drafts, and quoting a
 * hundred would make the figure useless in the one direction that matters — it
 * would stop somebody running the ten they need.
 *
 * It is an estimate and says so. The real charge is the tokens actually spent,
 * settled per run against the ledger, and a pack whose evidence is thin costs
 * less than one with forty passages to read.
 */
export function acuEstimate(ctx: EngineContext, bidId: string): AcuEstimate {
  requireModuleReadable(ctx.grantedModules, ctx.heldModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const bid = requireBid(ctx, bidId);
  const customer = requireVisibleCustomer(ctx, bid.customerAccountId);

  const outstanding = bid.questions.filter((question) => {
    const answer = latestAnswer(bid, question.id);
    return !answer || answer.status === 'REJECTED';
  }).length;
  const toScore = bid.questions.filter((question) => {
    const answer = latestAnswer(bid, question.id);
    return answer && answer.status !== 'REJECTED' && !answer.scores;
  }).length;

  const passages = evidenceOf(ctx)
    .filter((entry) => entry.customerAccountId === customer.id)
    .reduce((sum, entry) => sum + entry.chunks.length, 0);

  // One draft and one score per outstanding question, plus one score for each
  // answer written and not yet scored. The parse, where it has not run, is one
  // more. Each is its own call because each is one question — a single call for
  // the whole pack has no way to refuse when it runs out of room.
  const runs = outstanding * 2 + toScore + (bid.questionsConfirmedAt ? 0 : 1);

  // Both passes are reasoning calls over one question and its passages, which
  // is the MED tier the tender engine already prices its section drafting at.
  const { rawCostMinor, chargeMinor, multiplier } = tierCost('MED');

  const limits: string[] = [];
  if (!bid.questionsConfirmedAt) {
    limits.push(
      'The question list is not confirmed, so the count of outstanding questions is the parse only. The real figure ' +
        'is known once somebody has confirmed the list.',
    );
  }
  if (passages === 0) {
    limits.push(
      'This customer has no readable evidence, so every draft would raise a gap instead of writing — and a gap ' +
        'costs nothing. Nothing here is worth spending until the library has something in it.',
    );
  }
  limits.push(
    'An estimate. The charge is the tokens actually spent, settled per run, and a pack with forty passages to read ' +
      'costs more than one with four.',
  );
  limits.push(
    'Drafting against an embedded library also embeds each question, which is priced per input token with no output ' +
      'side — of the order of a hundredth of a draft. It is in the charge and not in this figure, because quoting a ' +
      'rounding difference as a separate line would suggest a choice about it that nobody has.',
  );

  return {
    bidId: bid.id,
    reference: bid.reference,
    questionsOutstanding: outstanding,
    answersToScore: toScore,
    passagesAvailable: passages,
    runs,
    rawCostMinor: rawCostMinor * runs,
    chargeMinor: chargeMinor * runs,
    multiplier,
    limits,
    summary:
      runs === 0
        ? 'Nothing outstanding. An agent run on this pack would do nothing and is refused rather than charged.'
        : `${runs} run(s): ${outstanding} draft(s), ${outstanding + toScore} score(s)` +
          (bid.questionsConfirmedAt ? '' : ', and one parse') +
          `, against ${passages} passage(s) of evidence.`,
  };
}

// --- Rendering the pack ------------------------------------------------------

export type RenderedPack = {
  reference: string;
  /** DOCX, XLSX or the copy-ready text an online portal needs. */
  format: 'DOCX' | 'XLSX' | 'TEXT';
  /** Base64 for the two binary formats, the text itself for the third. */
  content: string;
  contentType: string;
  filename: string;
  /** Sections in the buyer's own order, so a reader can check the structure. */
  sections: string[];
  questions: number;
};

/**
 * Render the pack in the questionnaire's own structure.
 *
 * The acceptance criterion is *"the DOCX/XLSX keeps the source numbering and
 * section order"*, and that is the whole job: a buyer who issued a
 * questionnaire with a sheet per section and a row per numbered question
 * expects it back the same way, and anything that renumbered or regrouped is a
 * file somebody rebuilds by hand — which is where the numbering stops matching
 * and the submission starts failing a format check.
 *
 * So nothing here sorts. The questions are emitted in the order they were
 * confirmed, which is the order they were parsed, which is the order they are
 * printed in the source document. `confirmQuestions` is what guarantees that,
 * because it refuses a duplicate number and keeps the array as given.
 *
 * **Three formats for two different readers.** A DOCX is what goes in an email
 * or a portal upload. An XLSX is what a buyer who issued a spreadsheet wants
 * back. The text form is for an online portal with a box per question: it
 * carries no formatting at all, because formatting pasted into a portal textarea
 * arrives as literal asterisks.
 *
 * It is a read. Rendering does not export: `exportBid` is the act with the gate
 * on it, and this refuses unless that gate has already passed — so nothing can
 * produce a sendable file from a pack that is not sendable.
 */
export function renderPack(
  ctx: EngineContext,
  bidId: string,
  format: 'DOCX' | 'XLSX' | 'TEXT',
  /**
   * The branding to put on a DOCX, resolved by the caller.
   *
   * Passed in rather than looked up, because how a tenancy's branding is
   * resolved is the export service's business and this module should not know
   * it. Unused by the other two formats: a spreadsheet goes back in the
   * buyer's own template and portal text carries no formatting at all.
   */
  branding: ClientBranding,
): RenderedPack {
  requireModuleReadable(ctx.grantedModules, ctx.heldModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'I', { dataSensitivity: 'COMMERCIAL_L3' });

  const bid = requireBid(ctx, bidId);
  const position = bidPosition(ctx, bidId);

  /*
   * Refused unless the pack has been through the export gate.
   *
   * Without this the gate would be a formality: somebody blocked from
   * exporting could render the same file and send it. The check is the
   * readiness position rather than the status, so a pack that became unsendable
   * after export — a certificate that lapsed, an answer rejected — cannot be
   * rendered either.
   */
  if (!position.readiness.exportable) {
    throw new DomainError(
      'BID_ON_NOT_EXPORTABLE',
      `${bid.reference} cannot be rendered: ${position.readiness.blocking.length} mandatory answer(s) are red or ` +
        'unapproved. Rendering a file from a pack that cannot be exported would make the gate a formality — the ' +
        'file would be sendable.',
      422,
    );
  }

  // The buyer's own sections, in first-appearance order. Not sorted and not
  // deduplicated by name alone: two sections genuinely called "Appendix" stay
  // two sections if the source has them twice.
  const sections: string[] = [];
  for (const entry of position.questions) {
    if (!sections.includes(entry.question.section)) sections.push(entry.question.section);
  }

  const answerOf = (entry: (typeof position.questions)[number]): string =>
    entry.answer
      ? [
          ...(entry.answer.yesNo === undefined ? [] : [entry.answer.yesNo ? 'Yes' : 'No']),
          ...entry.answer.body,
        ].join('\n\n')
      : '';

  if (format === 'TEXT') {
    // One block per question, with the buyer's number as the only heading, and
    // a rule between them. Somebody pasting into a portal copies from the
    // number down to the next rule.
    const text = position.questions
      .map((entry) => {
        const citations = entry.answer?.citations ?? [];
        return [
          `${entry.question.number} ${entry.question.text}`,
          '',
          answerOf(entry),
          ...(citations.length > 0
            ? ['', `Evidence: ${citations.map((citation) => citation.reference).join(', ')}`]
            : []),
          '',
          '---',
          '',
        ].join('\n');
      })
      .join('');

    return {
      reference: bid.reference,
      format,
      content: `${bid.buyerName} — ${bid.reference}\n\n${text}`,
      contentType: 'text/plain; charset=utf-8',
      filename: `${bid.reference}-${bid.scheme.toLowerCase()}.txt`,
      sections,
      questions: position.questions.length,
    };
  }

  if (format === 'XLSX') {
    // A sheet per section, a row per question, in source order. The columns
    // carry what a buyer's own template carries plus the evidence reference,
    // which is what lets their evaluator check a claim without asking.
    const sheets = sections.map((section) => ({
      name: section,
      headers: ['Number', 'Question', 'Answer', 'Words', 'Limit', 'Evidence'],
      widths: [10, 60, 90, 8, 8, 24],
      rows: position.questions
        .filter((entry) => entry.question.section === section)
        .map((entry) => [
          entry.question.number,
          entry.question.text,
          answerOf(entry),
          entry.answer?.words ?? 0,
          entry.question.wordLimit ?? null,
          (entry.answer?.citations ?? []).map((citation) => citation.reference).join(', '),
        ] as Array<string | number | null>),
    }));

    return {
      reference: bid.reference,
      format,
      content: Buffer.from(renderXlsx(sheets)).toString('base64'),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: `${bid.reference}-${bid.scheme.toLowerCase()}.xlsx`,
      sections,
      questions: position.questions.length,
    };
  }

  // DOCX, through the platform's own document model — so the branding, the
  // hashing and the renderer are the ones every other issued document uses.
  const blocks: DocumentBlock[] = [
    {
      kind: 'KEY_VALUES',
      rows: [
        { label: 'Buyer', value: bid.buyerName },
        ...(bid.buyerReference ? [{ label: 'Their reference', value: bid.buyerReference }] : []),
        { label: 'Scheme', value: bid.scheme as string },
        // A rolling submission has no return date, and the pack says which day
        // it was judged on instead. Printing a blank there, or today's date
        // under a "Return by" label, would both be a buyer reading something
        // untrue off the front page.
        bid.rolling
          ? { label: 'Submitted on a rolling basis, judged on', value: position.judgementDay }
          : { label: 'Return by', value: bid.deadline as string },
        { label: 'Our reference', value: bid.reference },
      ],
    },
  ];
  for (const section of sections) {
    blocks.push({ kind: 'HEADING', level: 2, text: section });
    for (const entry of position.questions.filter((row) => row.question.section === section)) {
      blocks.push({ kind: 'HEADING', level: 3, text: `${entry.question.number} ${entry.question.text}` });
      const answer = answerOf(entry);
      for (const paragraph of answer.split('\n\n').filter(Boolean)) {
        blocks.push({ kind: 'PARAGRAPH', text: paragraph });
      }
      const citations = entry.answer?.citations ?? [];
      if (citations.length > 0) {
        blocks.push({
          kind: 'PARAGRAPH',
          text: `Evidence: ${citations
            .map((citation) => `${citation.reference}${citation.pageRef ? ` (${citation.pageRef})` : ''}`)
            .join(', ')}`,
        });
      }
    }
  }

  const bytes = renderDocx({
    id: bid.id,
    reference: bid.reference,
    title: `${bid.buyerName} — ${bid.scheme} submission`,
    subtitle: position.customer.legalName,
    branding,
    audience: 'CLIENT',
    format: 'DOCX',
    generatedAt: new Date().toISOString(),
    generatedBy: ctx.auth.actorId,
    projectId: ctx.projectId,
    blocks,
    /*
     * Hashed, and deliberately not verified as a CONSTRUX instrument.
     *
     * This file is the *customer's* submission in the buyer's format, not a
     * report this platform issues. A buyer opening a UVDB questionnaire does
     * not want a CONSTRUX verification code in the footer, and stamping one
     * there would be this platform attesting to a document the customer is the
     * author of. The hash is over the content so two renders of one pack are
     * provably the same file; the identifier is the pack's own reference.
     */
    contentHash: hashEvidence(JSON.stringify({ reference: bid.reference, blocks })),
    verification: bid.reference,
  });

  return {
    reference: bid.reference,
    format,
    content: Buffer.from(bytes).toString('base64'),
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    filename: `${bid.reference}-${bid.scheme.toLowerCase()}.docx`,
    sections,
    questions: position.questions.length,
  };
}
