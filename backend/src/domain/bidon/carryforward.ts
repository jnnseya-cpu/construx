import { DomainError } from '../../core/errors.ts';
import { authorise, type EngineContext } from '../../engines/context.ts';
import { requireModuleReadable } from '../../identity/modules.ts';
import { distinctTerms, evidenceCurrentOn, evidenceOf, overlap } from './evidence.ts';
import {
  bidsOf,
  judgedOn,
  requireBid,
  type Bid,
  type BidAnswerVersion,
  type BidQuestion,
  type BidStage,
} from './bids.ts';

/**
 * What this customer has already answered, offered against a new question.
 *
 * ## The problem a two-stage procurement creates
 *
 * A PQQ asks "describe your health and safety management arrangements". Eight
 * weeks later the ITT for the same job asks "set out your health and safety
 * management system". It is the same answer, it was reviewed and approved by a
 * person, and the alternative to finding it is writing it again — which costs a
 * draft, costs a review, and produces a second version of the company's
 * position that may not match the first. A buyer who reads both documents is
 * entitled to notice.
 *
 * So this finds the earlier answers and offers them. It is the thing that makes
 * the second submission faster than the first, which is the whole economic
 * argument for keeping a library at all.
 *
 * ## It offers and it does not paste
 *
 * The same rule as `domain/answers.ts`, for the same reason, and
 * `backend/tests/bidoncarry.test.ts` asserts it against this file's source:
 * there is no `applyAnswer`, no `pasteAnswer`, no `fillQuestion`. An answer
 * pasted unchanged into the next bid is boilerplate, and boilerplate is what a
 * buyer marks down — the reuse that works is somebody reading a good answer and
 * writing this buyer's version of it.
 *
 * Reuse therefore goes through `recordAnswer` like any other answer: the same
 * citation check, the same versioning, the same review state. What this adds is
 * `carriedFrom` on that call, so the lineage is on the record and a reviewer can
 * see that an answer came from the prequalification rather than from nowhere.
 *
 * ## Three things it checks that a human reading an old pack would miss
 *
 * **The citations.** An answer approved in March citing an insurance
 * certificate that lapsed in June is not reusable in September, and nothing
 * about reading the prose would tell you. Every candidate's citations are
 * re-checked against *this* bid's judgement day, and the result says which have
 * lapsed.
 *
 * **The limit.** The PQQ allowed 500 words and this ITT allows 300. A candidate
 * that does not fit is still worth offering — it is a starting point — but
 * saying so is the difference between a useful offer and a trap.
 *
 * **The lineage.** An answer from the prequalification this bid actually
 * follows is a different proposition from one out of an unrelated bid two years
 * ago, even where the wording matches better. Those sort first and are marked.
 */

/**
 * The floor on a candidate's question-wording match.
 *
 * Higher than retrieval's floor, deliberately. A loosely-matched *passage* is
 * material a drafter may or may not use; a loosely-matched *prior answer* is a
 * finished, approved, confident-sounding answer to a different question, and
 * the reader's instinct is to use what is offered. Offering none is better.
 */
export const MINIMUM_CARRY_MATCH = 0.3;

export type CarriedCitation = {
  evidenceId: string;
  reference: string;
  title: string;
  /** Still usable on the day this bid is judged against. */
  current: boolean;
  expiresOn?: string;
  /** Set where the item has been withdrawn since. */
  withdrawn?: true;
};

export type PriorAnswer = {
  answerId: string;
  bidId: string;
  bidReference: string;
  buyerName: string;
  stage: BidStage;
  /** From the prequalification this bid follows, rather than an unrelated bid. */
  fromLineage: boolean;
  /** What happened to the bid it came from, where it is settled. */
  outcome?: 'SUBMITTED' | 'WON' | 'LOST';
  question: { number: string; section: string; text: string };
  body: string[];
  words: number;
  /** The weighted score it was approved at, where it was scored. */
  score: number | null;
  citations: CarriedCitation[];
  /** Every citation still current on this bid's judgement day. */
  citationsCurrent: boolean;
  /** Against this question's own limit. Null where the question states none. */
  withinLimit: boolean | null;
  /** The share of this question's distinctive terms the old question used. */
  match: number;
};

export type CarryForward = {
  question: { id: string; number: string; text: string };
  candidates: PriorAnswer[];
  /** Approved answers looked at, across this customer's other bids. */
  considered: number;
  /** How the candidates were found, because the two ways are not equivalent. */
  method: 'TERM_OVERLAP';
  limits: string[];
  note: string;
};

/** The latest version of each answer on a bid, which is the one somebody approved last. */
function latestByQuestion(bid: Bid): BidAnswerVersion[] {
  const latest = new Map<string, BidAnswerVersion>();
  for (const answer of bid.answers) {
    const held = latest.get(answer.questionId);
    if (!held || answer.version > held.version) latest.set(answer.questionId, answer);
  }
  return [...latest.values()];
}

function scoreOf(answer: BidAnswerVersion): number | null {
  if (answer.overrideScore !== undefined) return answer.overrideScore;
  if (!answer.scores) return null;
  const values = Object.values(answer.scores);
  return values.length === 0 ? null : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/**
 * Offer this customer's earlier approved answers against one question.
 *
 * `R` on `BID_SERVICES`, and nothing is written. The customer wall is enforced
 * by `requireBid` on the bid and by filtering every other bid on the same
 * `customerAccountId` — not by a caller remembering to. Two customers of one
 * provider chase the same framework, and an answer offered across that line
 * would be the one failure this module exists to prevent.
 */
export function priorAnswers(ctx: EngineContext, bidId: string, questionId: string): CarryForward {
  requireModuleReadable(ctx.grantedModules, ctx.heldModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const bid = requireBid(ctx, bidId);
  const question = bid.questions.find((entry) => entry.id === questionId);
  if (!question) {
    throw new DomainError(
      'BID_ON_QUESTION_NOT_FOUND',
      `No question ${questionId} on ${bid.reference}. Confirm the question list first — there is nothing to find a ` +
        'prior answer for until the list exists.',
      404,
    );
  }

  const day = judgedOn(bid);
  const evidenceById = new Map(evidenceOf(ctx).map((entry) => [entry.id, entry]));

  // This customer's other bids, and nothing else. `requireBid` already refused
  // a bid whose customer this person is not assigned to; this is the other
  // half, and it is a filter on the record rather than on a query somebody
  // remembers.
  const others = bidsOf(ctx).filter(
    (entry) => entry.customerAccountId === bid.customerAccountId && entry.id !== bid.id,
  );

  const terms = distinctTerms(`${question.text} ${question.section}`);
  const candidates: PriorAnswer[] = [];
  let considered = 0;
  let lineageBelowFloor = 0;

  for (const other of others) {
    const numberOf = new Map(other.questions.map((entry) => [entry.id, entry]));
    for (const answer of latestByQuestion(other)) {
      // Only what somebody put their name to. A draft is not a prior answer,
      // and a rejected one is a prior answer somebody decided against.
      if (answer.status !== 'APPROVED') continue;
      const asked = numberOf.get(answer.questionId);
      if (!asked) continue;
      considered += 1;

      const match = overlap(terms, `${asked.text} ${asked.section}`);
      const fromLineage = bid.followsBidId === other.id;
      if (match < MINIMUM_CARRY_MATCH) {
        // Counted rather than dropped silently: a reader who knows the
        // prequalification answered something similar should be told it was
        // looked at and judged too far off, not left wondering.
        if (fromLineage) lineageBelowFloor += 1;
        continue;
      }

      const citations: CarriedCitation[] = answer.citations.map((citation) => {
        const item = evidenceById.get(citation.evidenceId);
        return {
          evidenceId: citation.evidenceId,
          reference: citation.reference,
          title: item?.title ?? citation.reference,
          current: item !== undefined && evidenceCurrentOn(item, day),
          ...(item?.expiresOn ? { expiresOn: item.expiresOn } : {}),
          ...(item?.withdrawnAt ? { withdrawn: true as const } : {}),
        };
      });

      candidates.push({
        answerId: answer.id,
        bidId: other.id,
        bidReference: other.reference,
        buyerName: other.buyerName,
        stage: other.stage,
        fromLineage,
        ...(other.outcome ? { outcome: other.outcome.outcome } : {}),
        question: { number: asked.number, section: asked.section, text: asked.text },
        body: answer.body,
        words: answer.words,
        score: scoreOf(answer),
        citations,
        citationsCurrent: citations.length > 0 && citations.every((citation) => citation.current),
        withinLimit: question.wordLimit === undefined ? null : answer.words <= question.wordLimit,
        match,
      });
    }
  }

  // Lineage first, then the closest wording, then the better score. An answer
  // from the prequalification this bid actually follows is a different
  // proposition from one out of an unrelated bid, even where the wording of the
  // unrelated one matches better.
  candidates.sort(
    (a, b) =>
      Number(b.fromLineage) - Number(a.fromLineage) ||
      b.match - a.match ||
      (b.score ?? 0) - (a.score ?? 0),
  );

  const limits: string[] = [];
  const stale = candidates.filter((entry) => !entry.citationsCurrent && entry.citations.length > 0).length;
  if (stale > 0) {
    limits.push(
      `${stale} candidate(s) cite something that is not current on ${day}. The prose may still be right; the ` +
        'citation is not, and an answer citing a lapsed certificate is a hard red on this pack exactly as it would ' +
        'be on a new one.',
    );
  }
  const uncited = candidates.filter((entry) => entry.citations.length === 0).length;
  if (uncited > 0) {
    limits.push(
      `${uncited} candidate(s) carry no citation at all. They were approved before anything required one, or were ` +
        'written by hand: reusing one means finding the evidence for it now.',
    );
  }
  const overLimit = candidates.filter((entry) => entry.withinLimit === false).length;
  if (overLimit > 0) {
    limits.push(
      `${overLimit} candidate(s) are longer than this question's ${question.wordLimit}-word limit. Still worth ` +
        'reading as a starting point — anything past a stated limit is usually not read at all, so it has to be cut ' +
        'rather than trimmed at the end.',
    );
  }
  if (lineageBelowFloor > 0) {
    limits.push(
      `${lineageBelowFloor} answer(s) from the prequalification this bid follows were looked at and are too far from ` +
        'this question to offer. They are in that pack if you want to read them.',
    );
  }
  limits.push(
    'These are candidates, not answers. Nothing here is written into this bid: an answer pasted unchanged into the ' +
      'next submission is boilerplate, and boilerplate is what a buyer marks down. Read one, then write this ' +
      "buyer's version of it.",
  );

  return {
    question: { id: question.id, number: question.number, text: question.text },
    candidates,
    considered,
    method: 'TERM_OVERLAP',
    limits,
    note:
      considered === 0
        ? 'This customer has no approved answer on any other bid, so there is nothing to carry forward. The second ' +
          'submission is where this starts paying for itself.'
        : candidates.length === 0
          ? `Nothing among ${considered} approved answer(s) is close enough to this question's wording to offer. ` +
            'A loosely matched prior answer is a finished, confident answer to a different question, and the ' +
            'instinct is to use what is offered — so none is.'
          : `${candidates.length} of ${considered} approved answer(s) are close enough to offer` +
            (candidates.some((entry) => entry.fromLineage)
              ? ', and the ones from the prequalification this bid follows are first.'
              : '. None is from a prequalification this bid follows.'),
  };
}

/**
 * Every question on this bid with how many candidates it has.
 *
 * The screen's entry point, and the reason it exists rather than the caller
 * looping: on a sixty-question ITT, knowing *which* questions have something to
 * carry forward is the whole of the decision about where to start. Counting
 * them one at a time from the browser would be sixty reads to render a list.
 */
export function carryForwardBoard(
  ctx: EngineContext,
  bidId: string,
): {
  bidId: string;
  reference: string;
  stage: BidStage;
  follows?: { bidId: string; reference: string };
  questions: Array<{
    questionId: string;
    number: string;
    section: string;
    answered: boolean;
    candidates: number;
    fromLineage: number;
    /** The best match on offer, so a reader can tell a strong hit from a weak one. */
    best: number | null;
  }>;
  summary: string;
} {
  requireModuleReadable(ctx.grantedModules, ctx.heldModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const bid = requireBid(ctx, bidId);
  const predecessor = bid.followsBidId
    ? bidsOf(ctx).find((entry) => entry.id === bid.followsBidId)
    : undefined;

  const answeredIds = new Set(bid.answers.map((answer) => answer.questionId));
  const questions = bid.questions.map((question) => {
    const offer = priorAnswers(ctx, bidId, question.id);
    return {
      questionId: question.id,
      number: question.number,
      section: question.section,
      answered: answeredIds.has(question.id),
      candidates: offer.candidates.length,
      fromLineage: offer.candidates.filter((entry) => entry.fromLineage).length,
      best: offer.candidates[0]?.match ?? null,
    };
  });

  const withSomething = questions.filter((entry) => entry.candidates > 0 && !entry.answered).length;

  return {
    bidId: bid.id,
    reference: bid.reference,
    stage: bid.stage,
    ...(predecessor ? { follows: { bidId: predecessor.id, reference: predecessor.reference } } : {}),
    questions,
    summary:
      bid.questions.length === 0
        ? 'No question list has been confirmed, so there is nothing to carry forward into yet.'
        : withSomething === 0
          ? 'Nothing to carry forward: either every question with a prior answer is already answered here, or this ' +
            "customer's earlier bids do not cover these questions."
          : `${withSomething} unanswered question(s) have a prior approved answer to read first` +
            (predecessor ? `, including from ${predecessor.reference}.` : '.'),
  };
}
