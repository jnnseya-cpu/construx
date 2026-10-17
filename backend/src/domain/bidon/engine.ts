import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { authorise, runAI, write, type EngineContext } from '../../engines/context.ts';
import { requireModule } from '../../identity/modules.ts';
import { requireVisibleCustomer } from './customers.ts';
import { requireOpenEngagement } from './engagements.ts';
import { retrieveFor } from './evidence.ts';
import { ANSWER_TYPE, bidsOf, latestAnswer, recordAnswer, scoreAnswer, type Bid, type BidQuestion } from './bids.ts';
import { CRITERION, CRITERION_QUESTION, type CriterionScores } from './rubric.ts';

/**
 * The Bid Engine: parse, retrieve, draft, score, gap.
 *
 * ## The five agents, and where each one actually lives
 *
 * The specification describes five agents behind one orchestrator. Four of them
 * are AI calls and are the four exported commands here. The fifth — the
 * **Retriever** — is `evidence.retrieveFor`, which is not an AI call at all:
 * it filters on the customer, judges expiry against the deadline and refuses
 * below a matching floor. It is called by the drafter rather than invoked on its
 * own, because a retriever's output is not a deliverable; it is an input to one.
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
  requireOpenEngagement(ctx, bid.engagementId);
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

  // The Retriever. Not an AI call, and it filters on the customer before it
  // ranks — so a drafter physically cannot be handed another customer's
  // material.
  const retrieved = retrieveFor(ctx, {
    customerAccountId: bid.customerAccountId,
    question: `${question.text} ${question.section}`,
    asAt: bid.deadline,
  });

  if (retrieved.chunks.length === 0) {
    // A gap, not a draft, and no AI call at all — so this costs nothing.
    const gap = {
      id: ulid(),
      questionId: question.id,
      promptToClient:
        `For "${question.number} ${question.text}" we have nothing on file we could cite. ${retrieved.note} ` +
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
    return { bid: withGap, outcome: 'GAP_RAISED', gapId: gap.id, acuConsumed: 0 };
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
    return { bid: withGap, outcome: 'GAP_RAISED', gapId: gap.id, acuConsumed: result.acuConsumed };
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

  return { bid: next, outcome: 'DRAFTED', answerId: written.answer.id, acuConsumed: result.acuConsumed };
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
