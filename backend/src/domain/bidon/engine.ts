import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { authorise, runAI, write, type EngineContext } from '../../engines/context.ts';
import { requireModule } from '../../identity/modules.ts';
import { requireVisibleCustomer } from './customers.ts';
import { engagementOpenForWork, engagementsOf, requireOpenEngagement, type Engagement } from './engagements.ts';
import { depositStanding, invoicesOf, requireFundedEngagement } from './billing.ts';
import {
  evidenceCurrentOn,
  evidenceOf,
  requireEvidence,
  retrieveFor,
  type EvidenceType,
  type Retrieval,
} from './evidence.ts';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MAX_CHARS } from '../../ai/providers/embedding.ts';
import { ANSWER_TYPE, bidsOf, latestAnswer, recordAnswer, scoreAnswer, type Bid, type BidQuestion } from './bids.ts';
import { CRITERION, CRITERION_QUESTION, type CriterionScores } from './rubric.ts';

/**
 * The Bid Engine: parse, retrieve, draft, score, gap.
 *
 * ## The five agents, and where each one actually lives
 *
 * The specification describes five agents behind one orchestrator. Four of them
 * write prose or a score and are the four commands at the top of this file. The
 * fifth — the **Retriever** — is split, and the split follows the money.
 *
 * Its filtering is `evidence.retrieveFor`: the customer, the expiry judged
 * against the deadline, and the floor below which nothing comes back. None of
 * that costs anything, which is why a screen may call it and why the drafter
 * calls it without a quote.
 *
 * Its *ranking by meaning* costs two model calls — embedding each passage once
 * and embedding the question on every search — so those are commands here too,
 * `embedEvidence` and `retrieveSemantic`, quoted and metered like every other
 * spend in the module. Where no embedding provider is configured the filtering
 * still works and says it ranked on term overlap. One retriever, two honest
 * states, neither wearing the other's clothes.
 *
 * ## One question at a time, and why that is the whole design
 *
 * Every command here does **one question**. The specification asks for eight in
 * parallel, and that is an orchestration choice a caller makes by calling eight
 * times; what it must never be is one model call that produces a hundred
 * answers. A single call for the whole pack has no way to refuse when it runs
 * out of room — it stops mid-pack and looks finished, and the tokens are spent.
 * The same reasoning `bidresponse.writeNextSection` was built on, for the same
 * failure.
 *
 * ## Nothing here states a fact without a citation
 *
 * The drafter is given this customer's retrieved passages and nothing else, and
 * the constraint tells it to write only what those passages support and to name
 * the rest as a gap. Two things enforce that rather than asking for it:
 * `recordAnswer` refuses a citation that is not this customer's own, and the
 * drafter's own output is checked for citations before it is written — an
 * answer the model returned with no citation at all becomes a **gap**, not an
 * answer, because an uncited paragraph in a submission is a claim the customer
 * cannot stand behind.
 *
 * ## The scorer does not grade its own work
 *
 * A separate call, a separate prompt, and a separate command. `scoreAnswer` in
 * `bids.ts` has no AI in it and `recordAnswer` has no score field, so the only
 * way a score exists is a second pass. Where one provider serves both, the run
 * says so rather than implying independence it does not have — the same honesty
 * `redteam.ts` applies to its own challenge.
 *
 * ## Every command refuses the local stand-in
 *
 * `requireModel` is set on all four. The stand-in answers every request with a
 * deterministic sentence derived from a hash of its inputs; prose from it, sent
 * to a buyer under a customer's name as their answer to a mandatory question,
 * is a false statement. The refusal happens before the charge, so nobody pays
 * for it.
 */

/** The shape the parser is asked to return, and the one the bid stores. */
export type ParsedQuestion = Omit<BidQuestion, 'id'>;

function requireBidRecord(ctx: EngineContext, bidId: string): Bid {
  const bid = bidsOf(ctx).find((entry) => entry.id === bidId);
  if (!bid) throw new DomainError('BID_ON_BID_NOT_FOUND', `No bid ${bidId}`, 404);
  requireVisibleCustomer(ctx, bid.customerAccountId);
  return bid;
}

/**
 * Everything an AI command on a bid has to establish before it spends anything.
 *
 * One function because the four commands below must not drift: the module has
 * to be granted, the person has to be assigned to the customer, and the
 * engagement has to be open. A paused engagement consuming ACU is the
 * specification's own prohibition — *"paused engagements raise no recurring
 * invoices and cannot consume ACU"* — and it is enforced here rather than in
 * four places.
 */
function gate(ctx: EngineContext, bidId: string): Bid {
  requireModule(ctx.grantedModules, 'BID_ON');
  const bid = requireBidRecord(ctx, bidId);
  const engagement = requireOpenEngagement(ctx, bid.engagementId);
  // Beside the open check rather than inside it: the two answer different
  // questions. One asks whether work may happen at all, this asks whether the
  // provider has been paid enough to spend money on it. A paused engagement
  // blocks everything; an unpaid deposit blocks only the spend, so a person can
  // still file evidence and confirm a question list.
  requireFundedEngagement(ctx, engagement);
  if (['EXPORTED', 'SUBMITTED', 'WON', 'LOST'].includes(bid.status)) {
    throw new DomainError(
      'BID_ON_BID_SENT',
      `${bid.reference} is ${bid.status.toLowerCase()}. Spending AI on a pack that has gone is spending money on a ` +
        'record that must not change.',
      409,
    );
  }
  return bid;
}

/**
 * The passages the drafter is given, by the best honest means available.
 *
 * Semantic where this customer's library is embedded in the space this
 * deployment would use, and distinctive-term overlap where it is not. The
 * choice is made on two facts rather than on hope:
 *
 * - **Is an embedding provider configured at all.** Asked of the orchestrator's
 *   own published status, which answers rather than throwing, so this is a
 *   question and not a caught refusal. Read from the orchestrator and not from
 *   `config` directly: the orchestrator is what `adapterFor` would actually
 *   route to, and a deployment that was handed an adapter explicitly would
 *   otherwise have the drafter disagreeing with the thing that does the work.
 * - **Does this customer have anything embedded in that same space.** Without
 *   this second check a provider who has turned embeddings on but not yet
 *   embedded a library would get a semantic search that skips every passage,
 *   finds nothing, and raises a gap against a library that holds the answer.
 *   A false gap is worse than a weaker ranking: it asks the customer for
 *   something they already sent.
 *
 * Whichever runs, `method` comes back on the result and ends up in the draft's
 * own note. A reviewer reading "ranked on term overlap" knows that a passage
 * answering the question in other words may have been missed, which is a
 * different thing to know than "nothing was found".
 */
async function retrieveForDrafting(
  ctx: EngineContext,
  bid: Bid,
  question: BidQuestion,
): Promise<Retrieval & { acuConsumed: number }> {
  const embedding = ctx.orchestrator.controlPlaneStatus().embedding;
  const inSpace =
    embedding.configured &&
    embedding.provider !== undefined &&
    evidenceOf(ctx).some(
      (entry) =>
        entry.customerAccountId === bid.customerAccountId &&
        !entry.withdrawnAt &&
        evidenceCurrentOn(entry, bid.deadline) &&
        entry.semanticModel !== undefined &&
        entry.semanticModel.provider === embedding.provider &&
        entry.semanticModel.modelClass === EMBEDDING_CLASS,
    );

  if (inSpace) {
    return retrieveSemantic(ctx, {
      customerAccountId: bid.customerAccountId,
      question: `${question.text} ${question.section}`,
      asAt: bid.deadline,
    });
  }

  return {
    ...retrieveFor(ctx, {
      customerAccountId: bid.customerAccountId,
      question: `${question.text} ${question.section}`,
      asAt: bid.deadline,
    }),
    acuConsumed: 0,
  };
}

/** How a retrieval is reported on a draft, however the draft turned out. */
function retrievalOf(retrieved: Retrieval): { method: Retrieval['method']; model?: string; skipped: number } {
  return {
    method: retrieved.method,
    ...(retrieved.model ? { model: retrieved.model } : {}),
    skipped: retrieved.skipped,
  };
}

const NO_PROVIDER = {
  code: 'NO_REASONING_PROVIDER',
  message:
    'This deployment is running the local stand-in, which reasons about nothing. It cannot read a questionnaire or ' +
    'write a tender answer, and sending what it returns to a buyer under a customer’s name would be a false ' +
    'statement. Configure a reasoning provider and set AI_MODE=live.',
};

// --- The Parser --------------------------------------------------------------

/**
 * Read a questionnaire into an ordered question list. `X` on `BID_SERVICES`.
 *
 * It produces a **proposal**, not the list. `confirmQuestions` is what puts
 * questions on a bid, by a person, because a parser that drops one question
 * produces a pack where every answer is good and the submission is still
 * rejected — and nothing downstream can see that.
 *
 * The prompt is explicit that the buyer's own numbering is kept and nothing is
 * renumbered. An export has to match the source document, and a parser that
 * tidied `4.1a` into `4.2` produces a pack a buyer cannot map onto their own
 * questionnaire.
 */
export async function parseQuestionnaire(
  ctx: EngineContext,
  bidId: string,
  input: { text?: string; hash?: string },
): Promise<{ bid: Bid; proposed: ParsedQuestion[]; acuConsumed: number }> {
  const bid = gate(ctx, bidId);
  authorise(ctx, 'BID_SERVICES', 'X', { dataSensitivity: 'COMMERCIAL_L3' });

  if (bid.questionsConfirmedAt) {
    throw new DomainError(
      'BID_ON_QUESTIONS_CONFIRMED',
      `${bid.reference} already has a confirmed question list. Parsing again would spend AI producing a proposal ` +
        'nothing can accept.',
      409,
    );
  }
  if (!input.text?.trim() && !input.hash) {
    throw new DomainError(
      'BID_ON_NOTHING_TO_PARSE',
      'Give it the questionnaire: the text pasted out of a portal, or the hash of a file already in the evidence ' +
        'store.',
      400,
    );
  }

  const result = await runAI(ctx, {
    engine: 'TENDER',
    taskType: 'bid_on_parse',
    // A pasted portal page is text; a questionnaire PDF — including a scan — is
    // a document a vision model reads. The capability follows the input rather
    // than being fixed, because offering a reasoning model a scan produces a
    // confident reading of nothing.
    capability: input.hash ? 'PERCEPTION' : 'REASONING',
    inputRefs: [{ refType: 'BidOnBid', refId: bid.id }],
    attribution: { customerAccountId: bid.customerAccountId, engagementId: bid.engagementId, bidId: bid.id },
    request: {
      task:
        'Read this prequalification or tender questionnaire and list every question a bidder must answer. Return ' +
        'JSON with `questions`: an array of { section, number, text, answerType, wordLimit, weighting, mandatory, ' +
        'passFail }.',
      payload: {
        scheme: bid.scheme,
        buyer: bid.buyerName,
        ...(input.text ? { questionnaire: input.text } : {}),
        ...(input.hash ? { documentHash: input.hash } : {}),
        constraint:
          'Keep the buyer’s own section headings and their own numbering exactly as printed, including suffixes ' +
          'like 4.1a — an export has to map onto their questionnaire, and a renumbered list is one a buyer cannot ' +
          'follow. Preserve the order. `answerType` is one of ' +
          `${ANSWER_TYPE.join(', ')}. ` +
          'Report a word limit, a weighting and a mandatory or pass/fail flag only where the document states them; ' +
          'omit them otherwise rather than assuming a convention. Do not answer anything, do not summarise, and do ' +
          'not merge two questions into one — a question nobody answers is a rejected submission.',
      },
    },
    // Nothing is committed from the model's output here beyond the proposal
    // written below under its own event, so the model writes no state.
    toWrites: () => [],
    requireModel: NO_PROVIDER,
  });

  const output = result.output as { questions?: unknown };
  const proposed: ParsedQuestion[] = (Array.isArray(output.questions) ? output.questions : [])
    .map((row) => row as Record<string, unknown>)
    .map((row) => ({
      section: String(row.section ?? 'General').trim() || 'General',
      number: String(row.number ?? '').trim(),
      text: String(row.text ?? '').trim(),
      answerType: (ANSWER_TYPE.includes(String(row.answerType ?? '').toUpperCase() as never)
        ? String(row.answerType).toUpperCase()
        : 'TEXT') as BidQuestion['answerType'],
      ...(row.wordLimit == null ? {} : { wordLimit: Math.round(Number(row.wordLimit)) }),
      ...(row.weighting == null ? {} : { weighting: Number(row.weighting) }),
      mandatory: row.mandatory === true,
      passFail: row.passFail === true,
    }))
    .filter((question) => question.number && question.text);

  if (proposed.length === 0) {
    throw new DomainError(
      'BID_ON_NOTHING_PARSED',
      `Nothing usable came back for ${bid.reference}. The bid is unchanged and nothing has been proposed — a ` +
        'questionnaire with no questions has not been read, and accepting an empty list would leave somebody ' +
        'confirming it.',
      502,
    );
  }

  const next: Bid = {
    ...bid,
    status: 'PARSING',
    proposedQuestions: proposed,
    parsedAt: new Date().toISOString(),
    ...(result.provider ? { parsedBy: result.provider } : {}),
  };

  write(ctx, {
    eventType: 'BID_ON_QUESTIONS_PARSED',
    entity: { refType: 'BidOnBid', refId: bid.id },
    nextState: { ...next },
  });

  return { bid: next, proposed, acuConsumed: result.acuConsumed };
}

// --- The Drafter -------------------------------------------------------------

/**
 * Draft one answer from this customer's own evidence. `X` on `BID_SERVICES`.
 *
 * Retrieval first, and if it returns nothing the command **raises a gap instead
 * of drafting**. That is the specification's rule — *"unknowns become gaps"* —
 * and it is also the only honest option: a model asked to answer a question its
 * evidence cannot support writes a plausible paragraph, which is exactly the
 * uncited claim that gets a submission thrown out.
 *
 * The same happens after the call. An answer the model returned with no
 * citation becomes a gap, because the thing a reviewer cannot check is the
 * thing a buyer will.
 */
export async function draftAnswer(
  ctx: EngineContext,
  bidId: string,
  input: { questionId: string; reviewerInstructions?: string },
): Promise<{
  bid: Bid;
  outcome: 'DRAFTED' | 'GAP_RAISED';
  answerId?: string;
  gapId?: string;
  acuConsumed: number;
  /**
   * How the passages behind this draft were found.
   *
   * Reported because the two ways are not equivalent and a reviewer should not
   * have to guess which ran. "Ranked on term overlap, 14 passages not compared"
   * tells somebody the library needs embedding; silence tells them nothing and
   * reads as if everything was searched.
   */
  retrieval?: { method: Retrieval['method']; model?: string; skipped: number };
}> {
  const bid = gate(ctx, bidId);
  authorise(ctx, 'BID_SERVICES', 'X', { dataSensitivity: 'COMMERCIAL_L3' });

  const question = bid.questions.find((entry) => entry.id === input.questionId);
  if (!question) {
    throw new DomainError('BID_ON_QUESTION_NOT_FOUND', `${bid.reference} has no question ${input.questionId}`, 404);
  }
  const open = bid.gaps.find((entry) => entry.questionId === question.id && !entry.resolvedAt);
  if (open) {
    throw new DomainError(
      'BID_ON_GAP_OPEN',
      `${question.number} is waiting on the customer: "${open.promptToClient}". Drafting over an open gap spends ` +
        'money writing around the thing that is missing.',
      409,
    );
  }

  // The Retriever. It filters on the customer before it ranks — so a drafter
  // physically cannot be handed another customer's material — and it ranks by
  // meaning where this customer's library has been embedded.
  const retrieved = await retrieveForDrafting(ctx, bid, question);

  if (retrieved.chunks.length === 0) {
    // A gap, not a draft, and no AI call at all — so this costs nothing.
    const gap = {
      id: ulid(),
      questionId: question.id,
      promptToClient:
        `For "${question.number} ${question.text}" we have nothing on file we could cite. ` +
        `${retrieved.clientNote} ` +
        'Please send whatever evidences this — a policy, a certificate, a case study or the figures themselves.',
      raisedAt: new Date().toISOString(),
      raisedBy: ctx.auth.actorId,
    };
    const withGap: Bid = { ...bid, gaps: [...bid.gaps, gap] };
    write(ctx, {
      eventType: 'BID_ON_GAP_RAISED',
      entity: { refType: 'BidOnBid', refId: bid.id },
      nextState: { ...withGap },
    });
    // Not free any more where the retrieval embedded the question: a search
    // that found nothing still cost what it cost, and reporting zero would
    // make the wallet and the screen disagree.
    //
    // `retrieval` is reported on this path too, and this is where it matters
    // most: "nothing matched, and it was a word search" is a different fact
    // from "nothing matched", and only the first tells a reviewer that the
    // answer may well be in the library already.
    return {
      bid: withGap,
      outcome: 'GAP_RAISED',
      gapId: gap.id,
      acuConsumed: retrieved.acuConsumed,
      retrieval: retrievalOf(retrieved),
    };
  }

  const previous = latestAnswer(bid, question.id);
  const result = await runAI(ctx, {
    engine: 'TENDER',
    taskType: 'bid_on_draft',
    capability: 'REASONING',
    inputRefs: [{ refType: 'BidOnBid', refId: bid.id }],
    attribution: { customerAccountId: bid.customerAccountId, engagementId: bid.engagementId, bidId: bid.id },
    request: {
      task:
        'Write one answer to one question of a construction prequalification or tender questionnaire, using only the ' +
        'supplied passages. Return JSON with `body`: an array of paragraph strings, `citations`: an array of the ' +
        '`chunkId` values you actually relied on, and `unsupported`: an array of anything the question asks for that ' +
        'the passages do not support.',
      payload: {
        buyer: bid.buyerName,
        scheme: bid.scheme,
        section: question.section,
        number: question.number,
        question: question.text,
        ...(question.wordLimit === undefined ? {} : { wordLimit: question.wordLimit }),
        mandatory: question.mandatory,
        // The passages, each with the id the answer has to cite it by.
        passages: retrieved.chunks.map((chunk) => ({
          chunkId: chunk.chunkId,
          source: `${chunk.reference} ${chunk.title}${chunk.pageRef ? ` (${chunk.pageRef})` : ''}`,
          text: chunk.text,
        })),
        ...(previous && previous.status === 'REJECTED' && previous.reviewNote
          ? { reviewerInstructions: previous.reviewNote }
          : {}),
        ...(input.reviewerInstructions ? { extraInstructions: input.reviewerInstructions } : {}),
        constraint:
          'State nothing the passages do not support. Every factual claim — a figure, a date, a named scheme, a ' +
          'certificate, a person — must come from a passage and must carry that passage’s chunkId in `citations`. ' +
          'Anything the question asks for that the passages do not cover goes in `unsupported` and is left out of ' +
          'the prose entirely: an invented reference in a submission is a false statement to a buyer and grounds ' +
          'for disqualification. Answer every part of the question in the order asked, in the buyer’s own ' +
          'vocabulary, in British English, in the first person plural. Do not restate the question.' +
          (question.wordLimit === undefined
            ? ''
            : ` Stay within ${question.wordLimit} words: anything past a stated limit is usually not read at all.`),
      },
    },
    toWrites: () => [],
    requireModel: NO_PROVIDER,
  });

  const output = result.output as { body?: unknown; citations?: unknown; unsupported?: unknown };
  const body = (Array.isArray(output.body) ? output.body : []).map((line) => String(line).trim()).filter(Boolean);
  const cited = (Array.isArray(output.citations) ? output.citations : []).map((id) => String(id));
  const unsupported = (Array.isArray(output.unsupported) ? output.unsupported : [])
    .map((line) => String(line).trim())
    .filter(Boolean);

  // Only citations the retriever actually offered. A chunk id the model
  // invented would be refused by `recordAnswer` anyway; dropping it here means
  // the refusal does not throw away the prose as well.
  const offered = new Map(retrieved.chunks.map((chunk) => [chunk.chunkId, chunk]));
  const citations = [...new Set(cited)]
    .filter((id) => offered.has(id))
    .map((id) => ({ evidenceId: offered.get(id)!.evidenceId, chunkId: id }));

  /*
   * An answer with nothing behind it is a gap.
   *
   * The model wrote prose and cited nothing, or named what the evidence does
   * not cover. Either way the submission would carry a claim the customer
   * cannot stand behind, and the thing a reviewer cannot check is the thing a
   * buyer will. So the prose is discarded and the question goes back to the
   * customer — which is a worse outcome for the schedule and the only honest
   * one.
   */
  if (body.length === 0 || citations.length === 0) {
    const gap = {
      id: ulid(),
      questionId: question.id,
      promptToClient:
        `For "${question.number} ${question.text}" we could not write anything we are able to evidence. ` +
        (unsupported.length > 0
          ? `What is missing: ${unsupported.join('; ')}.`
          : 'Nothing on file supported an answer.') +
        ' Please send what evidences this and we will draft it.',
      raisedAt: new Date().toISOString(),
      raisedBy: ctx.auth.actorId,
    };
    const withGap: Bid = { ...bid, gaps: [...bid.gaps, gap] };
    write(ctx, {
      eventType: 'BID_ON_GAP_RAISED',
      entity: { refType: 'BidOnBid', refId: bid.id },
      nextState: { ...withGap },
    });
    return {
      bid: withGap,
      outcome: 'GAP_RAISED',
      gapId: gap.id,
      acuConsumed: result.acuConsumed + retrieved.acuConsumed,
      retrieval: retrievalOf(retrieved),
    };
  }

  // Through the ordinary command, so the citation check, the versioning and the
  // review state are the same ones a hand-written answer goes through.
  const written = recordAnswer(ctx, bid.id, {
    questionId: question.id,
    body,
    citations,
    authorship: 'AI_DRAFTED',
    ...(result.provider ? { provider: result.provider } : {}),
  });

  // Anything the evidence did not cover is still raised, beside the draft. A
  // partial answer with a known hole is better than either a gap that throws
  // away good prose or a draft that hides what is missing.
  let next = written.bid;
  if (unsupported.length > 0) {
    const gap = {
      id: ulid(),
      questionId: question.id,
      promptToClient:
        `We have drafted "${question.number}" from what is on file, and these parts are not evidenced: ` +
        `${unsupported.join('; ')}. Please send what covers them.`,
      raisedAt: new Date().toISOString(),
      raisedBy: ctx.auth.actorId,
    };
    next = { ...next, gaps: [...next.gaps, gap] };
    write(ctx, {
      eventType: 'BID_ON_GAP_RAISED',
      entity: { refType: 'BidOnBid', refId: bid.id },
      nextState: { ...next },
    });
  }

  return {
    bid: next,
    outcome: 'DRAFTED',
    answerId: written.answer.id,
    // The draft and the retrieval that fed it. One number, because one press of
    // one button is what the provider is charged for.
    acuConsumed: result.acuConsumed + retrieved.acuConsumed,
    retrieval: retrievalOf(retrieved),
  };
}

// --- The Scorer --------------------------------------------------------------

/**
 * Score one answer against the rubric. `X` on `BID_SERVICES`.
 *
 * A separate call with a separate prompt, and it is given the answer and the
 * question rather than the passages: a scorer that saw the retrieval would be
 * marking the drafter's homework against the drafter's own notes.
 *
 * Where the provider that scored is the one that drafted, the run says so.
 * `redteam.ts` makes the same disclosure for the same reason — a second pass by
 * the same model is a second pass, not an independent one, and reporting it as
 * independent is the overclaim.
 */
export async function scoreAnswerWithAI(
  ctx: EngineContext,
  bidId: string,
  answerId: string,
): Promise<{ bid: Bid; scores: CriterionScores; independent: boolean; acuConsumed: number }> {
  const bid = gate(ctx, bidId);
  authorise(ctx, 'BID_SERVICES', 'X', { dataSensitivity: 'COMMERCIAL_L3' });

  const answer = bid.answers.find((entry) => entry.id === answerId);
  if (!answer) {
    throw new DomainError('BID_ON_ANSWER_NOT_FOUND', `${bid.reference} has no answer ${answerId}`, 404);
  }
  const question = bid.questions.find((entry) => entry.id === answer.questionId)!;

  const result = await runAI(ctx, {
    engine: 'TENDER',
    // Its own task type, not the drafter's. A quote identifies a route by the
    // task it declares, and these are different prompts against different
    // inputs.
    taskType: 'bid_on_score',
    capability: 'REASONING',
    inputRefs: [{ refType: 'BidOnBid', refId: bid.id }],
    attribution: { customerAccountId: bid.customerAccountId, engagementId: bid.engagementId, bidId: bid.id },
    request: {
      task:
        'You are the buyer’s evaluator. Score this answer against five criteria, each out of 100, and say why for ' +
        'each. Return JSON with `scores`: an object keyed by criterion, and `reasons`: an object keyed by the same ' +
        'criteria.',
      payload: {
        buyer: bid.buyerName,
        scheme: bid.scheme,
        question: `${question.number} ${question.text}`,
        ...(question.wordLimit === undefined ? {} : { wordLimit: question.wordLimit }),
        mandatory: question.mandatory,
        words: answer.words,
        citationCount: answer.citations.length,
        answer: answer.body.join('\n\n'),
        criteria: CRITERION.map((criterion) => ({ criterion, asks: CRITERION_QUESTION[criterion] })),
        constraint:
          'You did not write this and you are not trying to help it. Score what a scorer working through a matrix ' +
          'could actually find and award, not what the answer probably means. A reason is required for every ' +
          'criterion and is what a reviewer will argue with, so say what is missing rather than restating the ' +
          'score. Do not rewrite the answer.',
      },
    },
    toWrites: () => [],
    requireModel: NO_PROVIDER,
  });

  const output = result.output as { scores?: Record<string, unknown>; reasons?: Record<string, unknown> };
  const scores = Object.fromEntries(
    CRITERION.map((criterion) => [criterion, clamp(Number(output.scores?.[criterion] ?? 0))]),
  ) as CriterionScores;
  const reasons = Object.fromEntries(
    CRITERION.map((criterion) => [
      criterion,
      String(output.reasons?.[criterion] ?? '').trim() ||
        // Never left empty: the command that records a score refuses a criterion
        // with no reason, and a blank one here would turn a usable score into a
        // refusal after the charge.
        'The scorer gave no reason for this criterion.',
    ]),
  );

  const scored = scoreAnswer(ctx, bid.id, answerId, {
    scores,
    reasons,
    ...(result.provider ? { provider: result.provider } : {}),
  });

  return {
    bid: scored.bid,
    scores,
    independent: answer.provider !== undefined && result.provider !== answer.provider,
    acuConsumed: result.acuConsumed,
  };
}

const clamp = (value: number): number => (Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0);

// --- The Gap agent -----------------------------------------------------------

/**
 * Turn the open gaps into one request the customer can answer in a sitting.
 * `X` on `BID_SERVICES`.
 *
 * The specification's reason is the whole value: *"batches gaps per bid so the
 * client gets one list, not many emails."* Twelve separate requests over three
 * days is how a customer stops replying, and the gaps are already on the record
 * — this writes the covering note, in their language rather than the bid team's.
 *
 * It writes no state. The gaps exist; this produces the text somebody sends,
 * and the record of it is the AI execution. A command that also edited the gaps
 * would be rewriting what was asked every time the note was regenerated.
 */
export async function composeGapRequest(
  ctx: EngineContext,
  bidId: string,
): Promise<{ note: string; gaps: number; acuConsumed: number }> {
  const bid = gate(ctx, bidId);
  authorise(ctx, 'BID_SERVICES', 'X', { dataSensitivity: 'COMMERCIAL_L3' });

  const open = bid.gaps.filter((entry) => !entry.resolvedAt);
  if (open.length === 0) {
    throw new DomainError(
      'BID_ON_NO_GAPS',
      `${bid.reference} has no open gap, so there is nothing to ask for. Nothing was spent.`,
      409,
    );
  }

  const numberOf = new Map(bid.questions.map((entry) => [entry.id, `${entry.number} ${entry.text}`]));
  const result = await runAI(ctx, {
    engine: 'TENDER',
    taskType: 'bid_on_gaps',
    capability: 'REASONING',
    inputRefs: [{ refType: 'BidOnBid', refId: bid.id }],
    attribution: { customerAccountId: bid.customerAccountId, engagementId: bid.engagementId, bidId: bid.id },
    request: {
      task:
        'Write one covering request to a contractor for everything still missing from their submission. Return JSON ' +
        'with `note`: an array of paragraph strings.',
      payload: {
        buyer: bid.buyerName,
        deadline: bid.deadline,
        missing: open.map((gap) => ({
          question: numberOf.get(gap.questionId) ?? '',
          asked: gap.promptToClient,
        })),
        constraint:
          'One message, grouped so the reader can gather things in one go rather than one item at a time. Plain ' +
          'English for somebody who runs a contracting business and does not write bids: no procurement jargon, no ' +
          'question numbers as the only identifier, and say what each thing is for. Name the return date and what ' +
          'happens to the submission without each item. Ask for nothing that is not in the list.',
      },
    },
    toWrites: () => [],
    requireModel: NO_PROVIDER,
  });

  const output = result.output as { note?: unknown };
  const note = (Array.isArray(output.note) ? output.note : [])
    .map((line) => String(line).trim())
    .filter(Boolean)
    .join('\n\n');

  if (!note) {
    throw new DomainError('BID_ON_NOTHING_COMPOSED', 'Nothing came back. The gaps are unchanged.', 502);
  }

  return { note, gaps: open.length, acuConsumed: result.acuConsumed };
}

// --- The Retriever's own two commands ----------------------------------------

/**
 * Why the Retriever has AI commands at all, when `retrieveFor` has none.
 *
 * `retrieveFor` filters on the customer, judges expiry against the deadline and
 * refuses below a floor. None of that costs anything, which is what lets a
 * screen call it. Ranking **by meaning** costs two things: embedding each
 * passage once, and embedding the question on every search. Those are model
 * calls, so they are commands here — quoted, metered, refused on an empty
 * wallet and on an unpaid deposit, like every other spend in the module.
 *
 * The split is the point. The read stays a read; the spend is a command
 * somebody presses.
 */

/** The width the index is built at, and the space every row has to be in. */
const EMBEDDING_CLASS = 'embedding-standard';

/**
 * Whether this customer has an engagement that may spend.
 *
 * The bid commands take their engagement from the bid. Evidence belongs to the
 * customer and not to a bid, so there is no single engagement to check — but an
 * embedding run spends real money, and the deposit rule is about the spend
 * rather than about bids. So: at least one engagement for this customer that is
 * open for work and whose deposit is settled.
 *
 * Returned rather than discarded, because the ACU this run consumes is
 * attributed to it. An unattributed run is one a provider cannot bill back or
 * read its own margin from.
 */
function requireFundedCustomer(ctx: EngineContext, customerAccountId: string): Engagement {
  const mine = engagementsOf(ctx).filter((entry) => entry.customerAccountId === customerAccountId);
  const open = mine.filter((entry) => engagementOpenForWork(entry).open);

  if (open.length === 0) {
    throw new DomainError(
      'BID_ON_NO_OPEN_ENGAGEMENT',
      mine.length === 0
        ? 'This customer has no engagement, so there is no piece of commercial work to attribute an AI run to. Open ' +
          'one and activate it first — the attribution is what lets you read your own margin per customer.'
        : 'Every engagement with this customer is paused, completed or cancelled. Embedding spends money, and a ' +
          'paused engagement consuming ACU is exactly what pausing is for.',
      409,
    );
  }

  const invoices = invoicesOf(ctx);
  const funded = open.find((entry) => depositStanding(entry, invoices).funded);
  if (!funded) {
    // The refusal of the first one, verbatim, rather than a summary: it names
    // the invoice and what to do about it.
    throw new DomainError('BID_ON_DEPOSIT_OUTSTANDING', depositStanding(open[0]!, invoices).reason!, 402);
  }
  return funded;
}

export type EmbeddingResult = {
  evidenceId: string;
  reference: string;
  chunks: number;
  provider: string;
  modelClass: string;
  dimensions: number;
  acuConsumed: number;
  note: string;
};

/**
 * Embed one evidence item's passages. `X` on `BID_SERVICES`.
 *
 * Per item rather than per library, and that is deliberate: a library is filed
 * over months, and a command that re-embedded everything each time a
 * certificate arrived would charge for the same passages repeatedly. The screen
 * loops over what is not embedded yet; the command stays the unit that can be
 * refused, quoted and retried on its own.
 *
 * **Refused where it would charge twice.** Same passages, same model, same
 * vectors. Re-embedding under a *different* model is allowed and replaces the
 * rows, because the old ones are in a space nothing else on this customer is in
 * any more.
 *
 * **No stand-in, ever.** `datalayer/embedding.ts` makes the argument in full: a
 * stand-in narrative is visibly a stand-in, and a stand-in *vector* is not
 * readable by anybody — it ranks, sorts and scores exactly like a real one and
 * means nothing. `adapterFor('EMBEDDING')` refuses by name where no provider is
 * configured, and that refusal is passed straight through.
 */
export async function embedEvidence(ctx: EngineContext, evidenceId: string): Promise<EmbeddingResult> {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'X', { dataSensitivity: 'COMMERCIAL_L3' });

  // Throws if this person is not assigned to the customer.
  const evidence = requireEvidence(ctx, evidenceId);
  if (evidence.withdrawnAt) {
    throw new DomainError(
      'BID_ON_EVIDENCE_WITHDRAWN',
      `${evidence.reference} has been withdrawn. Embedding it would pay to make a withdrawn document findable.`,
      409,
    );
  }
  if (evidence.chunks.length === 0) {
    throw new DomainError(
      'BID_ON_NOTHING_EXTRACTED',
      `Nothing has been read out of ${evidence.reference}, so there are no passages to embed. Record what was read ` +
        'out of it first.',
      409,
    );
  }

  const engagement = requireFundedCustomer(ctx, evidence.customerAccountId);

  // Resolved before anything is held, so an unconfigured deployment is refused
  // by name at no cost rather than through a wallet hold that is then released.
  const intended = ctx.orchestrator.adapterFor('EMBEDDING');
  if (evidence.semanticModel?.provider === intended.name && evidence.semanticModel.modelClass === EMBEDDING_CLASS) {
    throw new DomainError(
      'BID_ON_ALREADY_EMBEDDED',
      `${evidence.reference} was embedded by ${intended.name} on ${evidence.semanticModel.embeddedAt.slice(0, 10)}. ` +
        'The passages have not changed, so the vectors would not either, and it would be charged again.',
      409,
    );
  }

  const passages = evidence.chunks.map((chunk) => chunk.text);
  const oversized = passages.findIndex((text) => text.length > EMBEDDING_MAX_CHARS);
  if (oversized !== -1) {
    throw new DomainError(
      'BID_ON_PASSAGE_TOO_LONG',
      `Passage ${oversized + 1} of ${evidence.reference} is ${passages[oversized]!.length} characters and the ` +
        `ceiling is ${EMBEDDING_MAX_CHARS}. Read the file into shorter passages — a passage that long is also one no ` +
        'reviewer can check a citation against.',
      422,
    );
  }

  const result = await runAI(ctx, {
    engine: 'TENDER',
    taskType: 'bid_on_embed',
    capability: 'EMBEDDING',
    inputRefs: [{ refType: 'BidOnEvidence', refId: evidence.id }],
    attribution: { customerAccountId: evidence.customerAccountId, engagementId: engagement.id },
    request: {
      // No prompt. An embedding endpoint is handed text, not an instruction,
      // and anything else here is text the provider is billed to embed.
      task: 'bid_on_embed',
      payload: { passages },
      modelClass: EMBEDDING_CLASS,
    },
    toWrites: (output) => {
      const vectors = (output as { vectors?: number[][] }).vectors ?? [];
      if (vectors.length !== passages.length) {
        throw new DomainError(
          'AI_EMBEDDING_MALFORMED',
          `The provider returned ${vectors.length} vectors for ${passages.length} passages. Attaching vectors that ` +
            'may belong to different text would produce plausible rankings from nothing.',
          502,
        );
      }
      const wrong = vectors.findIndex((vector) => vector.length !== EMBEDDING_DIMENSIONS);
      if (wrong !== -1) {
        // Belt and braces on the way into an append-only record: a row of the
        // wrong width here is permanent, and cosine against it is undefined
        // rather than merely low.
        throw new DomainError(
          'AI_EMBEDDING_MALFORMED',
          `Vector ${wrong + 1} has ${vectors[wrong]!.length} dimensions; this index is built at ` +
            `${EMBEDDING_DIMENSIONS}.`,
          502,
        );
      }
      return [
        {
          eventType: 'BID_ON_EVIDENCE_EMBEDDED',
          entity: { refType: 'BidOnEvidence', refId: evidence.id },
          nextState: {
            ...evidence,
            chunks: evidence.chunks.map((chunk, index) => ({ ...chunk, vector: vectors[index]! })),
            semanticModel: {
              provider: intended.name,
              modelClass: EMBEDDING_CLASS,
              dimensions: EMBEDDING_DIMENSIONS,
              chunks: passages.length,
              embeddedAt: new Date().toISOString(),
              embeddedBy: ctx.auth.actorId,
            },
          },
        },
      ];
    },
  });

  return {
    evidenceId: evidence.id,
    reference: evidence.reference,
    chunks: passages.length,
    provider: result.provider,
    modelClass: result.modelClass ?? EMBEDDING_CLASS,
    dimensions: EMBEDDING_DIMENSIONS,
    acuConsumed: result.acuConsumed,
    note:
      `${passages.length} passage(s) of ${evidence.reference} are now searchable by meaning, in ` +
      `${result.provider}'s space. Only passages in that same space are ever compared — a cosine between two ` +
      'models’ vectors is not a weaker score, it is a number with no meaning.',
  };
}

/**
 * What this customer's library has for one question, ranked by meaning.
 * `X` on `BID_SERVICES`.
 *
 * One embedding call — the question — and then the ordinary read. The spend is
 * here and not in `retrieveFor`, so the screen that lists a library still costs
 * nothing and the search that uses a model is quoted before it runs.
 *
 * Writes nothing. A retrieval is not a finding, and recording every search as
 * an event would fill an append-only ledger with the fact that somebody typed
 * a question. The `AIExecution` record the orchestrator writes is the audit
 * trail for the spend, which is the part that needs one.
 */
export async function retrieveSemantic(
  ctx: EngineContext,
  input: { customerAccountId: string; question: string; asAt?: string; types?: EvidenceType[]; limit?: number },
): Promise<Retrieval & { acuConsumed: number }> {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'X', { dataSensitivity: 'COMMERCIAL_L3' });

  const customer = requireVisibleCustomer(ctx, input.customerAccountId);
  const question = input.question.trim();
  if (question.length < 8) {
    throw new DomainError(
      'BID_ON_QUESTION_TOO_SHORT',
      'Give it the question. Embedding two words costs the same as embedding the question and ranks against ' +
        'everything equally badly.',
      400,
    );
  }

  const engagement = requireFundedCustomer(ctx, input.customerAccountId);
  const intended = ctx.orchestrator.adapterFor('EMBEDDING');

  const result = await runAI(ctx, {
    engine: 'TENDER',
    taskType: 'bid_on_retrieve',
    capability: 'EMBEDDING',
    inputRefs: [{ refType: 'BidOnCustomer', refId: customer.id }],
    attribution: { customerAccountId: customer.id, engagementId: engagement.id },
    request: { task: 'bid_on_retrieve', payload: { passages: [question] }, modelClass: EMBEDDING_CLASS },
    toWrites: () => [],
  });

  const vectors = (result.output as { vectors?: number[][] }).vectors ?? [];
  const queryVector = vectors[0];
  if (!queryVector || queryVector.length !== EMBEDDING_DIMENSIONS) {
    throw new DomainError(
      'AI_EMBEDDING_MALFORMED',
      `The question embedded to ${queryVector?.length ?? 0} dimensions; this index is built at ` +
        `${EMBEDDING_DIMENSIONS}. Ranking against it would produce scores that look ordinary and mean nothing.`,
      502,
    );
  }

  const retrieval = retrieveFor(ctx, {
    customerAccountId: customer.id,
    question,
    // Today by default. A retrieval run from the library screen has no bid and
    // therefore no deadline, and judging expiry against today is the honest
    // reading of "what do we have right now".
    asAt: (input.asAt ?? new Date().toISOString()).slice(0, 10),
    ...(input.types ? { types: input.types } : {}),
    ...(input.limit ? { limit: input.limit } : {}),
    queryVector,
    queryModel: { provider: intended.name, modelClass: EMBEDDING_CLASS },
  });

  return { ...retrieval, acuConsumed: result.acuConsumed };
}
