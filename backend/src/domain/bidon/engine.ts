import { config } from '../../config.ts';
import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { authorise, runAI, write, type EngineContext } from '../../engines/context.ts';
import { extractText, inspect, type Extraction } from '../../evidence/ingest.ts';
import type { ProviderMedia } from '../../ai/providers/types.ts';
import type { EvidenceStore } from '../../evidence/store.ts';
import { requireModule } from '../../identity/modules.ts';
import { asksNothing, describeShape, looksLikeQuestionSet, questionShape } from './questionshape.ts';
import type { Clarification } from '../tenderintake.ts';
import { requireVisibleCustomer } from './customers.ts';
import { engagementOpenForWork, engagementsOf, requireOpenEngagement, type Engagement } from './engagements.ts';
import { depositStanding, invoicesOf, requireFundedEngagement } from './billing.ts';
import {
  textOf,
  CHUNK_MIN_CHARS,
  evidenceCurrentOn,
  evidenceOf,
  recordExtraction,
  requireEvidence,
  retrieveFor,
  type BidOnEvidence,
  type EvidenceType,
  type Retrieval,
  type RetrievedChunk,
} from './evidence.ts';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MAX_CHARS } from '../../ai/providers/embedding.ts';
import {
  ANSWER_TYPE,
  bidsOf,
  judgedOn,
  raiseClarifications,
  latestAnswer,
  recordAnswer,
  scoreAnswer,
  type Bid,
  type BidQuestion,
} from './bids.ts';
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
/**
 * How much of the library a drafter is allowed to read.
 *
 * The search default is eight passages, which is right for a screen somebody
 * scans. It is wrong for drafting: a question with a 500-word limit is marked
 * on what is in those 500 words, and eight passages of a library is not enough
 * material to fill them with anything specific — the model writes the twenty-
 * five careful words its evidence supports and the answer scores forty.
 *
 * Twenty-four. Input tokens are the cheapest thing in this transaction: a draft
 * reads three times as much for a fraction of what one lost tender costs, and
 * the fit check in `adapterFor` refuses anything that will not fit the window
 * rather than letting a vendor truncate it. Nothing here loosens the citation
 * rule — more passages means more the answer **can** cite, never more it may
 * claim.
 */
const DRAFTING_PASSAGES = 24;

/** How many separate searches one question is allowed to become. */
const MAX_FACETS = 6;

/**
 * What a question actually asks, as separate searches.
 *
 * A tender question is rarely one question. *"Describe your approach to
 * programme management, including how you resource peak demand, how you report
 * progress, and what you do when a milestone slips"* is four, and ranking the
 * whole paragraph as a single string returns passages about the first limb and
 * nothing about the fourth — so the draft answers three quarters of the
 * question and loses the marks for the rest. One search for a four-part
 * question is not a search strategy.
 *
 * So each limb gets its own search and the results are unioned. The splits are
 * where a question genuinely changes subject: a sentence end, a semicolon, an
 * enumerated item, or an `including`/`and how`/`as well as` hinge. The whole
 * question stays first, because it is the one query that carries the context
 * the limbs are read in.
 *
 * Lexical rather than a planning call, deliberately. A model asked to split a
 * question would cost a call, take a second, and get it right about as often —
 * and a wrong split here is invisible, where a wrong one in prose is not.
 */
export function questionFacets(question: BidQuestion): string[] {
  const whole = `${question.text} ${question.section}`.trim();
  const limbs = question.text
    .split(/(?<=[.?;:])\s+|\n+|\s*•\s*|\s+(?=\(?[a-z][).]\s)|\s+(?=\b(?:including|and how|as well as|together with|in addition)\b)/i)
    .map((part) => part.replace(/^[\s•>*-]*(?:\(?[a-z0-9]{1,3}[).]\s*)?/i, '').trim())
    .filter((part) => part.split(/\s+/).length >= 4 && part.length >= 16);

  // One limb is not a decomposition: it is the question again, with the
  // section cut off. Searching it twice buys nothing and costs an embedding.
  const seen = new Set<string>();
  const facets: string[] = [];
  for (const facet of limbs.length > 1 ? [whole, ...limbs] : [whole]) {
    const key = facet.toLowerCase();
    if (facet.length < 8 || seen.has(key)) continue;
    seen.add(key);
    facets.push(facet);
    if (facets.length === MAX_FACETS) break;
  }
  return facets;
}

/**
 * Every search's results as one ranked set.
 *
 * Keyed on the chunk, keeping the best score any limb gave it: a passage that
 * answers the fourth limb precisely should not be buried because it ranks
 * poorly against the first. What comes back is the ordinary `Retrieval` shape,
 * so everything downstream — the gap, the citation check, the reporting — is
 * unchanged.
 */
function unionRetrievals(parts: Retrieval[], limit: number): Retrieval {
  const best = new Map<string, RetrievedChunk>();
  for (const part of parts) {
    for (const chunk of part.chunks) {
      const held = best.get(chunk.chunkId);
      if (!held || chunk.score > held.score) best.set(chunk.chunkId, chunk);
    }
  }
  const chunks = [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  const first = parts[0]!;
  return {
    ...first,
    chunks,
    considered: parts.reduce((total, part) => total + part.considered, 0),
    skipped: Math.max(...parts.map((part) => part.skipped)),
  };
}

async function retrieveForDrafting(
  ctx: EngineContext,
  bid: Bid,
  question: BidQuestion,
): Promise<Retrieval & { acuConsumed: number; queries: number }> {
  // The day this pack is judged against: its deadline, or today on a rolling
  // submission that has no return date. The retriever must use the same day
  // the verdicts do, or the drafter is handed a certificate the pack will
  // then mark as lapsed.
  const day = judgedOn(bid);

  const embedding = ctx.orchestrator.controlPlaneStatus().embedding;
  const inSpace =
    embedding.configured &&
    embedding.provider !== undefined &&
    evidenceOf(ctx).some(
      (entry) =>
        entry.customerAccountId === bid.customerAccountId &&
        !entry.withdrawnAt &&
        evidenceCurrentOn(entry, day) &&
        entry.semanticModel !== undefined &&
        entry.semanticModel.provider === embedding.provider &&
        entry.semanticModel.modelClass === EMBEDDING_CLASS,
    );

  const facets = questionFacets(question);

  if (inSpace) {
    /*
     * Every limb embedded in one call.
     *
     * The embedding adapter takes an array of passages and answers with a
     * vector for each, so six searches cost one round trip rather than six.
     * The spend is here rather than in `retrieveFor`, so the library screen
     * still costs nothing.
     */
    const customer = requireVisibleCustomer(ctx, bid.customerAccountId);
    const engagement = requireFundedCustomer(ctx, bid.customerAccountId);
    const intended = ctx.orchestrator.adapterFor('EMBEDDING');
    const embedded = await runAI(ctx, {
      engine: 'TENDER',
      taskType: 'bid_on_retrieve',
      capability: 'EMBEDDING',
      inputRefs: [{ refType: 'BidOnCustomer', refId: customer.id }],
      attribution: { customerAccountId: customer.id, engagementId: engagement.id, bidId: bid.id },
      request: { task: 'bid_on_retrieve', payload: { passages: facets }, modelClass: EMBEDDING_CLASS },
      toWrites: () => [],
    });

    const vectors = (embedded.output as { vectors?: number[][] }).vectors ?? [];
    const usable = vectors.filter((vector) => vector?.length === EMBEDDING_DIMENSIONS);
    if (usable.length === 0) {
      throw new DomainError(
        'AI_EMBEDDING_MALFORMED',
        `The question embedded to ${vectors[0]?.length ?? 0} dimensions; this index is built at ` +
          `${EMBEDDING_DIMENSIONS}. Ranking against it would produce scores that look ordinary and mean nothing.`,
        502,
      );
    }

    const parts = usable.map((queryVector, at) =>
      retrieveFor(ctx, {
        customerAccountId: bid.customerAccountId,
        question: facets[at] ?? facets[0]!,
        asAt: day,
        limit: DRAFTING_PASSAGES,
        queryVector,
        queryModel: { provider: intended.name, modelClass: EMBEDDING_CLASS },
      }),
    );

    return {
      ...unionRetrievals(parts, DRAFTING_PASSAGES),
      acuConsumed: embedded.acuConsumed,
      queries: parts.length,
    };
  }

  const parts = facets.map((facet) =>
    retrieveFor(ctx, {
      customerAccountId: bid.customerAccountId,
      question: facet,
      asAt: day,
      limit: DRAFTING_PASSAGES,
    }),
  );

  return { ...unionRetrievals(parts, DRAFTING_PASSAGES), acuConsumed: 0, queries: parts.length };
}

/** How a retrieval is reported on a draft, however the draft turned out. */
/**
 * The yes or the no a model sent back, whatever shape it chose.
 *
 * A vendor told to return a boolean returns a boolean most of the time, and
 * `"yes"`, `"Yes"`, `"true"` or `"Y"` the rest of it. Reading only `true` would
 * refuse a perfectly good answer and charge for it again on the retry.
 *
 * What it will **not** do is guess. Anything that is not plainly one or the
 * other — `"maybe"`, `"see our answer"`, a number, a null, an omission —
 * returns `undefined`, and the caller refuses rather than deciding for a
 * bidder: a bid ends at the gate on a "no", and "probably yes" is not a thing
 * a platform may resolve on a company's behalf.
 */
export function yesNoFrom(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const said = value.trim().toLowerCase();
  if (['yes', 'y', 'true'].includes(said)) return true;
  if (['no', 'n', 'false'].includes(said)) return false;
  return undefined;
}

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
  store: EvidenceStore,
  bidId: string,
  input: {
    text?: string;
    hash?: string;
    /**
     * Send it to a model even though it does not look like a question set.
     *
     * The pre-flight check below is a floor, and a floor can be wrong: a
     * questionnaire written entirely as bare statements with no numbering would
     * trip it. So the refusal names this flag and the console offers it as a
     * checkbox. One paid call is the cost of disagreeing, which is the right
     * price for somebody who knows their own document.
     */
    anyway?: boolean;
  },
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

  // A questionnaire given as a file is read before it is sent: natively where
  // the bytes carry the words, as a scan only where they do not.
  const document = input.hash
    ? await documentForReading(ctx, store, documentHashFrom(ctx, input.hash), 'the questionnaire')
    : undefined;

  // A pasted portal page is text; a questionnaire PDF — including a scan — is a
  // document a vision model reads. The capability follows the input rather than
  // being fixed, because offering a reasoning model a scan produces a confident
  // reading of nothing.
  const capability = document?.kind === 'MEDIA' ? 'PERCEPTION' : 'REASONING';
  const inputRefs = [{ refType: 'BidOnBid', refId: bid.id }];

  // Pasted text is a document for this purpose: a questionnaire copied out of a
  // portal can be longer than one request just as a file can.
  const source: DocumentForReading | undefined =
    document ?? (input.text?.trim() ? { kind: 'TEXT', text: input.text } : undefined);

  // A questionnaire past the window is read in parts and the question lists are
  // joined in order, rather than the whole thing being sent and refused by the
  // vendor. Each part is its own execution and its own charge.
  const parts = partsFor(source, ctx.orchestrator.textBudgetChars({ capability, inputRefs }));

  /** What it read, in the words a person would use for it. */
  const documentLabel = ((): string => {
    if (!input.hash) return 'the text you pasted';
    try {
      const item = requireEvidence(ctx, input.hash);
      return `${item.reference} — ${item.title}`;
    } catch {
      return 'the document behind that hash';
    }
  })();
  const sentChars = parts.reduce((sum, part) => sum + (part.text?.length ?? 0), 0);

  /*
   * Looked at before a vendor is called, and refused for nothing where there is
   * nothing to find.
   *
   * Only on the text path: a scan has no text for this to read and is sent as
   * it always was. `anyway` overrides it, because a heuristic that cannot be
   * argued with is a rule that stops work.
   */
  const shape = questionShape(parts.map((part) => part.text ?? '').join('\n'));
  if (source?.kind === 'TEXT' && input.anyway !== true && asksNothing(shape)) {
    throw new DomainError(
      'BID_ON_NOT_A_QUESTION_SET',
      `${documentLabel} asks nothing: ${sentChars.toLocaleString()} characters, not one question mark and not one ` +
        'line that begins by asking something ("Please describe…", "4.1 Set out…"). Nothing has been sent to a ' +
        'model and nothing has been charged. ' +
        `${wrongDocumentHint(ctx, bid, input.hash)} If you know this document better than the check does, read it ` +
        'anyway and it will be sent — one call, and the check is a floor rather than a gate.',
      422,
      [{ field: 'anyway', message: 'Tick "read it anyway" if you know better than this check does' }],
    );
  }

  const proposed: ParsedQuestion[] = [];
  let acuConsumed = 0;
  let parsedBy: string | undefined;

  /*
   * What the reading actually saw, kept so a refusal can say something.
   *
   * `BID_ON_NOTHING_PARSED` told nobody anything: not which document was read,
   * not how much of it was sent, not whether the model answered with rows that
   * were then dropped or with nothing at all. Those are entirely different
   * problems — the wrong file chosen, a specification where a questionnaire was
   * expected, a model that answered in a shape nothing could read — and they
   * have different remedies.
   */
  let rowsSeen = 0;
  let withoutNumber = 0;
  let withoutText = 0;
  const answered: string[] = [];

  for (const part of parts) {
    const result = await runAI(ctx, {
      engine: 'TENDER',
      taskType: 'bid_on_parse',
      capability,
      inputRefs,
      attribution: { customerAccountId: bid.customerAccountId, engagementId: bid.engagementId, bidId: bid.id },
      request: {
        ...(part.media ? { media: part.media } : {}),
        task:
          'Read this prequalification or tender questionnaire and list every question a bidder must answer. Return ' +
          'JSON with `questions`: an array of { section, number, text, answerType, wordLimit, weighting, mandatory, ' +
          'passFail }.',
        payload: {
          scheme: bid.scheme,
          buyer: bid.buyerName,
          ...(part.text === undefined ? {} : { questionnaire: part.text }),
          ...(input.hash ? { documentHash: input.hash } : {}),
          ...partConstraint(part),
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

    acuConsumed += result.acuConsumed;
    parsedBy ??= result.provider;

    /*
     * The rows, under whichever name the model used.
     *
     * `questions` is what the prompt asks for and what every answer has used.
     * The alternatives are here because the cost of a model answering
     * `{"items": [...]}` was the whole reading thrown away and charged for, and
     * because a bare array is what a model returns when it decides the schema
     * was advisory. Each is still a list of question-shaped objects; nothing is
     * inferred about their contents.
     */
    const output = result.output as Record<string, unknown>;
    const listed = [output.questions, output.items, output.rows, output.list, output.data].find((candidate) =>
      Array.isArray(candidate),
    );
    const rows = (Array.isArray(listed) ? listed : []) as Array<Record<string, unknown>>;
    rowsSeen += rows.length;
    if (rows.length === 0) answered.push(excerpt(JSON.stringify(output)));

    /** The first of these the row actually carries, trimmed. */
    const field = (row: Record<string, unknown>, names: string[]): string => {
      for (const name of names) {
        const value = row[name];
        if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
      }
      return '';
    };

    for (const row of rows) {
      // The buyer's own numbering, under any of the names a model gives it. It
      // is load-bearing — the export has to map onto their questionnaire — so a
      // row without one is still dropped, and now counted so the refusal can
      // say that is what happened.
      const number = field(row, ['number', 'ref', 'reference', 'questionNumber', 'no', 'id']);
      const text = field(row, ['text', 'question', 'questionText', 'prompt', 'body']);
      if (number === '') withoutNumber += 1;
      if (text === '') withoutText += 1;
      if (number === '' || text === '') continue;

      const answerType = field(row, ['answerType', 'type', 'responseType']).toUpperCase();
      proposed.push({
        section: field(row, ['section', 'heading', 'category']) || 'General',
        number,
        text,
        answerType: (ANSWER_TYPE.includes(answerType as never) ? answerType : 'TEXT') as BidQuestion['answerType'],
        ...(row.wordLimit == null ? {} : { wordLimit: Math.round(Number(row.wordLimit)) }),
        ...(row.weighting == null ? {} : { weighting: Number(row.weighting) }),
        mandatory: row.mandatory === true,
        passFail: row.passFail === true,
      });
    }
  }

  if (proposed.length === 0) {
    /*
     * The same refusal, now saying which of three things happened.
     *
     * The bid is still unchanged and nothing is still proposed — accepting an
     * empty list would leave somebody confirming it — but "nothing usable came
     * back" sent people to look at the wrong thing. What they need to know is
     * whether the model answered with rows that were then dropped (a
     * numbering problem), answered with nothing (very often the wrong document
     * — a specification or a cost model where a questionnaire was expected),
     * or was given almost no text at all (a scan the platform could not read,
     * or an empty paste).
     */
    const read = source?.kind === 'MEDIA' ? 'as a scan' : `${sentChars.toLocaleString()} characters`;
    const what = rowsSeen === 0
      ? `It answered with no questions at all. What came back: ${answered.join(' | ')}.`
      : `It returned ${rowsSeen} row(s) and none could be used: ` +
        `${withoutNumber} carried no question number${withoutText > 0 ? ` and ${withoutText} no question text` : ''}. ` +
        'The buyer’s own numbering is what the export has to map onto, so a row without one cannot be proposed.';

    throw new DomainError(
      'BID_ON_NOTHING_PARSED',
      `Nothing usable came back for ${bid.reference}. It read ${documentLabel} (${read}${parts.length > 1 ? `, in ${parts.length} parts` : ''}). ` +
        `${what} ${wrongDocumentHint(ctx, bid, input.hash, { rows: rowsSeen, withoutNumber })} ` +
        'The bid is unchanged and nothing has been proposed.',
      502,
    );
  }

  const next: Bid = {
    ...bid,
    status: 'PARSING',
    proposedQuestions: proposed,
    parsedAt: new Date().toISOString(),
    ...(parsedBy ? { parsedBy } : {}),
  };

  write(ctx, {
    eventType: 'BID_ON_QUESTIONS_PARSED',
    entity: { refType: 'BidOnBid', refId: bid.id },
    nextState: { ...next },
  });

  return { bid: next, proposed, acuConsumed };
}

/**
 * A filed document, in the form a model can actually be given it.
 *
 * ## Two findings, a few minutes apart, from one real tender
 *
 * The first: three commands took a document "by its hash" and sent
 * `documentHash: 'sha256:…'` and nothing else. A model handed the *name* of a
 * file it cannot open answers from the name.
 *
 * The second, once the bytes were actually attached: every adapter sent them
 * as an **image**. OpenAI refused the PDF outright, which was the good
 * outcome. And a tender is not even mostly PDFs — this one is a questionnaire,
 * a Word order form, an Excel cost model and a scanned code of conduct.
 *
 * ## The platform already reads all four, and better than a vision model would
 *
 * `evidence/ingest.ts` has done this since it was written: `office.ts` reads a
 * Word document and a spreadsheet, because both are XML in a ZIP;
 * `pdftext.ts` reads a PDF that carries its words in its content streams; a
 * text file is its own text. Only where the bytes genuinely do not carry the
 * words — a scan, a photograph — is a model that can see required, and
 * `extractText` says so by reporting `NEEDS_OCR` rather than guessing.
 *
 * So the rule here is the platform's own: **read it natively where the bytes
 * are the text, and spend a vision call only on a scan.** The cost difference
 * is not the point, though it is large. The point is that an extracted cost
 * model is a table and a transcribed one is a model's impression of a table,
 * and the figures in it are going into a tender.
 *
 * ## Refused before anything is spent, by name
 *
 * A file the platform does not hold, one carrying something an inspection
 * blocks, a format nothing reads, one too large to send, and a deployment with
 * no provider that can see a scan — five different problems, five refusals,
 * none of them a provider error discovered after the charge.
 */
type DocumentForReading =
  | { kind: 'TEXT'; text: string; note?: string }
  | { kind: 'MEDIA'; media: ProviderMedia; note?: string };

/**
 * One document, as the words a model is given — each of them once.
 *
 * ## The document was being sent twice
 *
 * This was `[extraction.text, ...every table row]`, and for the two formats a
 * tender actually arrives in that is the same content twice over. A workbook's
 * `text` is *built from* its sheets — `office.ts` joins every row of every
 * sheet into it — and `pageTables` then carries those same rows again; a PDF's
 * reconstructed tables come out of the same text layer its `text` came from.
 * So a priced bill of quantities went to the vendor as the whole bill, followed
 * by the whole bill again in a second notation.
 *
 * It cost twice the input tokens on every spreadsheet the module has ever read,
 * and on a large one it is what pushed the call past the context window:
 *
 *     OPENAI returned 400: Your input exceeds the context window of this model
 *
 * It is also worse reading. A model shown the same table in two notations has
 * to decide whether it is looking at one bill or two, and the honest answer
 * from the prompt's point of view is that nothing told it.
 *
 * ## What it does now
 *
 * The text, then only those table rows the text does not already carry.
 * Compared on a normalised form — cells joined by single spaces, whitespace
 * collapsed — so a row the text holds as `a\tb\tc` is recognised in
 * `['a','b','c']` and dropped, while a PDF row whose columns the text layer
 * interleaved differently survives and is worth having.
 */
export function documentTextOf(extraction: Extraction): string {
  const normalise = (line: string): string => line.replace(/\s+/g, ' ').trim();
  const text = extraction.text ?? '';
  const held = new Set(text.split(/\r?\n/).map(normalise).filter(Boolean));

  const pageRows = (extraction.pageTables ?? []).flatMap((table) => table.rows ?? []);
  const rows = pageRows.length > 0 ? pageRows : (extraction.tables ?? []);

  const added: string[] = [];
  for (const row of rows) {
    const key = normalise(row.join(' '));
    if (key === '' || held.has(key)) continue;
    held.add(key);
    added.push(row.join(' | '));
  }

  return [text, ...added].filter(Boolean).join('\n');
}

/**
 * One document, in pieces small enough that a model can be handed each of them.
 *
 * A tender document is not a payload the platform chose the size of — it is
 * whatever the buyer published, and an invitation bundle runs to hundreds of
 * pages. Past the context window there are only two honest options: refuse the
 * document, or read it in parts. It reads it in parts.
 *
 * Split on blank lines first and single lines after, so a part never begins or
 * ends mid-sentence — a passage quoted across a boundary would be a sentence
 * the document does not contain, which is the one thing the reader must never
 * produce. A single line longer than the budget is cut at the budget, because
 * the alternative is a part that cannot be sent at all.
 */
export function partsOf(text: string, budgetChars: number): string[] {
  if (budgetChars <= 0 || text.length <= budgetChars) return [text];

  const parts: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current.trim() !== '') parts.push(current);
    current = '';
  };

  const place = (piece: string, separator: string): void => {
    const joined = current === '' ? piece : `${current}${separator}${piece}`;
    if (joined.length <= budgetChars) {
      current = joined;
      return;
    }
    flush();
    if (piece.length <= budgetChars) {
      current = piece;
      return;
    }
    // Longer than a whole part on its own: a minified table, or a document
    // written without line breaks. Cut it where it has to be cut.
    for (let at = 0; at < piece.length; at += budgetChars) {
      const slice = piece.slice(at, at + budgetChars);
      if (slice.length === budgetChars) parts.push(slice);
      else current = slice;
    }
  };

  for (const block of text.split(/\n\s*\n/)) {
    if (block.trim() === '') continue;
    if (block.length <= budgetChars) {
      place(block, '\n\n');
      continue;
    }
    for (const line of block.split(/\r?\n/)) place(line, '\n');
  }
  flush();

  return parts.length > 0 ? parts : [text.slice(0, budgetChars)];
}

/**
 * The parts of a document, in the form a reading command sends one.
 *
 * `undefined` where the command was given pasted text and no file, so a caller
 * can map over the same list either way. A scan is one part whatever its size:
 * splitting a PDF into page ranges is not something this platform does to a
 * file it was given, and the byte ceiling and the window guard both refuse one
 * too large by name.
 */
type DocumentPart = {
  /** The text of this part, where the document carries its own words. */
  text?: string;
  /** The whole file, where it is a scan. */
  media?: ProviderMedia;
  /** 1-based, and `of` is how many there are: both go to the model. */
  index: number;
  of: number;
};

function partsFor(document: DocumentForReading | undefined, budgetChars: number): DocumentPart[] {
  if (!document) return [{ index: 1, of: 1 }];
  if (document.kind === 'MEDIA') return [{ media: document.media, index: 1, of: 1 }];
  const parts = partsOf(document.text, budgetChars);
  return parts.map((text, index) => ({ text, index: index + 1, of: parts.length }));
}

/**
 * What a part says about itself, where there is more than one.
 *
 * Without it a model handed part 3 of 7 reports a questionnaire that starts at
 * question 48 as a questionnaire that starts at question 48 — and, worse,
 * invents the earlier ones to make the list look whole. Naming the part is what
 * makes reading in sequence safe.
 */
function partConstraint(part: DocumentPart): Record<string, string> {
  if (part.of === 1) return {};
  return {
    part: `This is part ${part.index} of ${part.of} of one document, split only because the whole document does not ` +
      'fit in one request. Read this part and nothing else: do not infer what the other parts contain, do not ' +
      'renumber anything to make this part look complete, and do not note that material is missing — the other ' +
      'parts are being read separately and the answers are combined.',
  };
}

/**
 * The document somebody meant, from whatever they pasted.
 *
 * The questionnaire parser and the amendments reading ask for a **document
 * hash**, and the library row offers three copyable values — the item's id, its
 * reference (`EVD-0003`) and the hash. Two of the three were refused, with a
 * message explaining the difference, which is better than nothing and is still
 * the platform asking a person to do a lookup it can do itself.
 *
 * Anything the library can resolve is accepted and turned into the hash the
 * reader needs. A value that resolves to nothing is left exactly as it was, so
 * a genuine hash for a file in the evidence store but not in the Bid-On library
 * — which is legitimate, since the store holds the platform's own evidence too
 * — still reads, and the refusal still comes from the store rather than from a
 * lookup that decided for it.
 */
/**
 * What a document that produced no questions probably is, and what reads it.
 *
 * A real run filed nine documents and pointed the questionnaire parser at
 * **Appendix 3 — Schedule of Amendment**. The model did the right thing and
 * returned no questions, the diagnostic said which document it had read, and
 * the person was still left to work out which of the other eight to try and
 * which command the amendments belonged to.
 *
 * A tender's documents announce themselves in their titles, because the buyer
 * numbered and named them — so the hint is read from the title the customer
 * typed, never from the contents. It is a hint in a refusal and nothing acts on
 * it: no command is chosen, no document is substituted, and the wording says
 * what it is reading from.
 *
 * The rest of the library is listed because a chooser that offered the right
 * document in the first place still cannot say which of nine PDFs is the
 * questionnaire — and the person who filed them can, the moment they see the
 * titles beside each other.
 */
function wrongDocumentHint(
  ctx: EngineContext,
  bid: Bid,
  hash: string | undefined,
  /**
   * What came back, where anything did.
   *
   * Rows with no numbering is a different diagnosis from no rows at all: it
   * means the model found content it could read as a list, and the document is
   * almost always a form rather than a questionnaire. Saying "none could be
   * used" alone sends somebody looking for a numbering problem.
   */
  returned: { rows: number; withoutNumber: number } = { rows: 0, withoutNumber: 0 },
): string {
  if (hash === undefined) {
    return 'Pasted text with no numbered questions in it is usually a covering page rather than the question set.';
  }

  let title = '';
  let chosenId = '';
  try {
    const item = requireEvidence(ctx, hash);
    title = item.title.toLowerCase();
    chosenId = item.id;
  } catch {
    // Not in this library. The refusal above has already said what it read.
  }

  /** The commands that read the documents a questionnaire parser is given by mistake. */
  const ELSEWHERE: Array<{ matches: RegExp; is: string; command: string }> = [
    {
      matches: /amendment|schedule of amend|deed of variation/,
      is: 'a schedule of amendments to a standard form contract',
      command: 'Bids → Read the schedule of amendments',
    },
    {
      matches: /pricing|price schedule|cost model|rates|bill of quantit|boq/,
      is: 'a pricing document',
      command: 'nothing here — a priced schedule is a returnable, recorded under Record what has to be returned',
    },
    {
      matches: /specification|spec\b|scope of works|employer.s requirement/,
      is: 'a specification',
      command: 'nothing here — a specification is evidence to cite, not a question set',
    },
    {
      matches: /terms|conditions of contract|framework agreement/,
      is: 'contract terms',
      command: 'Bids → Read the schedule of amendments, which is what reads terms against a standard form',
    },
    {
      /*
       * An order form, which is the case that produced rows and no numbers.
       *
       * A real run pointed the parser at `Appendix 2 — JCT MTC 2024 Order
       * Form`: the model returned 23 rows, every one of them a field to
       * complete rather than a question to answer, and none of them numbered.
       * Both facts are correct about an order form, and dropping all 23 is also
       * correct — but "none could be used" sent somebody to look for a
       * numbering problem in a document that has no questions in it.
       */
      matches: /order form|form of tender|form of agreement|contract particulars|appendix 2\b/,
      is: 'an order form — a document to complete and sign rather than a set of questions',
      command: 'nothing here as a question set — an order form is a returnable, recorded under Record what has to be returned',
    },
  ];

  const recognised = ELSEWHERE.find((entry) => entry.matches.test(title));

  /*
   * The rest of the library, with the ones that ask something first.
   *
   * Listing it alphabetically was still leaving somebody to guess, and a guess
   * here costs a model call: the live run went through the amendments, the
   * insurance certificates, the order form, a 382,691-character stock list and
   * the cost model before this was written. Every one of those documents had
   * already been read by the platform, which could therefore see — for nothing
   * — that none of them asks anything.
   */
  const others = evidenceOf(ctx)
    .filter((item) => item.customerAccountId === bid.customerAccountId && item.id !== chosenId && !item.withdrawnAt)
    .map((item) => {
      if (item.chunks.length === 0) return { rank: -1, line: `${item.reference} ${item.title} (nothing read out of it yet)` };
      const shape = questionShape(textOf(item));
      const describes = describeShape(shape);
      if (looksLikeQuestionSet(shape)) {
        return { rank: 2, line: `${item.reference} ${item.title} — this one looks like a question set: ${describes}` };
      }
      if (asksNothing(shape)) return { rank: 0, line: `${item.reference} ${item.title} (asks nothing)` };
      return { rank: 1, line: `${item.reference} ${item.title} (${describes})` };
    })
    .sort((a, b) => b.rank - a.rank)
    .map((entry) => entry.line);

  const unnumbered = returned.rows > 0 && returned.withoutNumber === returned.rows;

  return (
    (recognised
      ? `Its title says this is ${recognised.is} — that one is read by ${recognised.command}. `
      : unnumbered
        ? 'Every row came back without a number, which is what a form looks like rather than a questionnaire: ' +
          'fields to complete rather than questions numbered for a response to map onto. '
        : 'That is usually the wrong document: a specification, a cost model or a pricing schedule rather than the question set. ') +
    (others.length > 0 ? `The rest of this customer’s library: ${others.join('; ')}. ` : '') +
    'Point it at the questionnaire, paste the questions out of the portal, or — if the source genuinely numbers ' +
    'nothing — confirm the list by hand, where you give each question the number the response has to carry.'
  );
}

/** Enough of a model's answer to diagnose it, never enough to fill a log with a tender. */
function excerpt(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
}

function documentHashFrom(ctx: EngineContext, asked: string): string {
  const value = asked.trim();
  try {
    return requireEvidence(ctx, value).hash;
  } catch (error) {
    // A refusal that is about *this person* is not a failed lookup, and
    // falling through it would turn a denial into a read.
    if (error instanceof DomainError && error.code !== 'BID_ON_EVIDENCE_NOT_FOUND') throw error;
  }

  /*
   * A hash that belongs to this library and not to this person.
   *
   * `documentForReading` is tenant-scoped but not customer-scoped: it asks the
   * store whether the tenancy holds those bytes. So a hash alone was a way
   * round the assignment rule that `requireEvidence` exists to enforce — a
   * member of the provider's staff who was never assigned to a customer could
   * read that customer's document by pasting its hash, which is precisely the
   * case the rule is written for ("a provider's customers compete with each
   * other, so access is per customer and is recorded").
   *
   * A hash that no Bid-On item names is left alone, because the evidence store
   * holds the platform's own records too and reading one of those by hash is
   * what these commands have always allowed.
   */
  const inLibrary = evidenceOf(ctx).filter((item) => item.hash === value);
  if (inLibrary.length > 0) {
    throw new DomainError(
      'BID_ON_CUSTOMER_NOT_ASSIGNED',
      'That document belongs to a customer you are not assigned to. A provider’s customers compete with each other, ' +
        'so access is per customer and is recorded.',
      403,
    );
  }

  return value;
}

async function documentForReading(
  ctx: EngineContext,
  store: EvidenceStore,
  hash: string,
  what: string,
): Promise<DocumentForReading> {
  if (!(await store.holds(ctx.tenantId, hash))) {
    throw new DomainError(
      'BID_ON_FILE_NOT_HELD',
      `The platform holds the hash of ${what} but not the file itself, so there is nothing to read. Supply the file ` +
        'against that evidence record and try again.',
      409,
    );
  }

  const file = await store.fetch(ctx.tenantId, hash);

  // The same inspection every upload goes through, applied again here because
  // this is the moment the bytes are about to be acted on. An executable inside
  // a spreadsheet is an executable, and a tender appendix is exactly the sort
  // of attachment that carries one.
  const inspection = inspect({ bytes: file.bytes, declaredType: file.contentType });
  if (inspection.verdict === 'BLOCKED') {
    throw new DomainError(
      'BID_ON_FILE_BLOCKED',
      `${what} was refused by inspection: ${inspection.findings.map((finding) => `${finding.what} — ${finding.because}`).join(' ')}`,
      422,
    );
  }

  const extraction = extractText(file.bytes, inspection.actualType ?? file.contentType);

  if (extraction.method === 'NATIVE') {
    const text = documentTextOf(extraction);
    if (text.trim() !== '') {
      return { kind: 'TEXT', text, ...(extraction.note ? { note: extraction.note } : {}) };
    }
  }

  if (extraction.method === 'UNSUPPORTED') {
    throw new DomainError(
      'BID_ON_FORMAT_UNREADABLE',
      `Nothing on this platform reads ${what}: ${extraction.reason ?? `the format is ${inspection.actualType ?? file.contentType}`}. ` +
        'Save it as a PDF, a Word document, a spreadsheet or plain text, or paste the text instead.',
      415,
    );
  }

  // `NEEDS_OCR`, or a native read that produced nothing: the bytes do not carry
  // their words, so this needs a model that can see.
  if (file.bytes.length > config.ai.perceptionMaxBytes) {
    throw new DomainError(
      'BID_ON_FILE_TOO_LARGE',
      `${what} is ${Math.round(file.bytes.length / 1_048_576)}MB and a file over ` +
        `${Math.round(config.ai.perceptionMaxBytes / 1_048_576)}MB cannot be sent to a provider in one request. ` +
        'Split it, or paste the text instead.',
      413,
    );
  }

  // The honesty gate, in the words `perception.ts` uses: an adapter that cannot
  // be handed a file will answer anyway — deterministically, confidently and
  // fictionally — and that answer would be filed as this customer's evidence.
  const adapter = ctx.orchestrator.adapterFor('PERCEPTION');
  if (!adapter.multimodal) {
    throw new DomainError(
      'BID_ON_PROVIDER_CANNOT_READ',
      `${what} carries no text of its own — it is a scan or a photograph — and no provider configured on this ` +
        'deployment can be handed a file. Reading one needs a multimodal provider; the local engines compute, they ' +
        'do not perceive.',
      503,
    );
  }

  return {
    kind: 'MEDIA',
    media: {
      contentType: file.contentType,
      base64: file.bytes.toString('base64'),
      hash,
      // Carried where the reader counted them. A scan's pages, not its bytes,
      // decide whether a vendor's window will hold it.
      ...(extraction.pages ? { pages: extraction.pages } : {}),
    },
    note: 'The document carries no text of its own, so it was read as a scan.',
  };
}

// --- The Reader --------------------------------------------------------------

/**
 * Read a filed document into the passages a drafter cites. `X` on `BID_SERVICES`.
 *
 * ## The gap this closes
 *
 * Every other agent in this module was reachable and this one did not exist, so
 * the passages had to be **typed by hand** — `recordExtraction` is a textarea.
 * On a real invitation that is nine documents of prose transcribed by a bid
 * writer before the drafter has anything to cite, which is the bulk of the
 * labour the module exists to remove. The parser already reads a questionnaire
 * from a filed file, including a scan, through the perception capability; this
 * is the same act pointed at the rest of the library.
 *
 * ## It writes through the same door as a person
 *
 * The output goes to `recordExtraction`, which is what the hand-typed route
 * calls: the same chunk floor, the same refusal when nothing usable comes back,
 * the same dropping of `semanticModel` on a re-read, and the same
 * `BID_ON_EVIDENCE_EXTRACTED` event — which the catalogue already allows an
 * agent to author. A second write path would be a second definition of what a
 * passage is, and the retriever would eventually find them ranking differently.
 *
 * ## No stand-in, and this is the one place it would do real damage
 *
 * `requireModel` refuses the local engines before anything is charged. A
 * stand-in "reading" returns a hash-derived narrative, and those sentences
 * would be filed as this customer's evidence, retrieved against their
 * questions, cited by the drafter and read by a buyer as the company's own
 * statement. Everywhere else a stand-in is visibly a stand-in; here it would
 * become a citation.
 *
 * ## Re-reading is allowed, and says so
 *
 * A document re-read replaces its passages — a corrected specification is
 * worth re-reading and the old passages are about a document nobody holds any
 * more. `reread` is returned so the caller can say what happened rather than
 * reporting a second charge as a first one.
 */
export async function readEvidence(
  ctx: EngineContext,
  store: EvidenceStore,
  evidenceId: string,
): Promise<{
  item: BidOnEvidence;
  chunks: number;
  reread: boolean;
  acuConsumed: number;
  /**
   * How many requests the document took.
   *
   * Reported because it is the honest half of the charge: a bundle that does
   * not fit in one request is read in sequence and billed per part, and a
   * caller shown four parts' spend with no mention of four parts would read it
   * as a price that had moved.
   */
  parts: number;
}> {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'X', { dataSensitivity: 'COMMERCIAL_L3' });

  // Throws if this person is not assigned to the customer.
  const evidence = requireEvidence(ctx, evidenceId);
  if (evidence.withdrawnAt) {
    throw new DomainError(
      'BID_ON_EVIDENCE_WITHDRAWN',
      `${evidence.reference} has been withdrawn. Reading it would pay to index a document nobody may cite.`,
      409,
    );
  }

  const reread = evidence.chunks.length > 0;

  // The document, in whatever form a model can be given it. Resolved before
  // the call so a file the platform does not hold, cannot read, or would have
  // to send to a provider that cannot see, is refused without spending.
  const document = await documentForReading(ctx, store, evidence.hash, `${evidence.reference} — ${evidence.title}`);

  // The capability follows the document rather than the command. A Word order
  // form and a priced spreadsheet are text by the time they get here and want a
  // model that reasons; a scanned code of conduct wants one that sees. Fixing
  // this at PERCEPTION would have sent an extracted cost model to a vision
  // model as prose.
  const capability = document.kind === 'MEDIA' ? 'PERCEPTION' : 'REASONING';
  const inputRefs = [{ refType: 'BidOnEvidence', refId: evidence.id }];

  /*
   * A document longer than one request is read in parts, not refused.
   *
   * An invitation bundle runs to hundreds of pages and the platform does not
   * get to choose how long the buyer's document is. Before this, a document
   * past the context window was sent whole and came back as
   * `400 … exceeds the context window of this model`: a provider error, on a
   * command that had worked the day before with a smaller file, naming nothing
   * the person could act on.
   *
   * Each part is a separate execution with its own hold and its own charge,
   * which is the honest accounting — reading twice as much document costs twice
   * as much — and the passages are combined into one reading at the end.
   */
  /*
   * Sized by what the model can **write**, not only by what it can read.
   *
   * A reading restates the document — the passages are its own words — so the
   * answer is the binding constraint, and on every vendor the answer ceiling
   * is a fraction of the input window. A part sized from the input budget is
   * accepted, runs for a long time, and comes back cut off at the output
   * ceiling: a plausible partial reading, which is worse than no reading and
   * is refused only after the vendor has billed for all of it.
   */
  const parts = partsFor(document, ctx.orchestrator.textBudgetChars({ capability, inputRefs, echoesInput: true }));

  const passages: Array<{ text: string; pageRef?: string }> = [];
  const lines: string[] = [];
  let acuConsumed = 0;

  for (const part of parts) {
    const result = await runAI(ctx, {
      engine: 'TENDER',
      taskType: 'bid_on_read',
      capability,
      inputRefs,
      attribution: { customerAccountId: evidence.customerAccountId },
      request: {
        /*
         * `lines` is asked for only where the model can see something this
         * platform cannot read.
         *
         * It used to be asked for always: "the document as plain text, one
         * paragraph per entry" — of a document whose plain text the platform
         * had *already extracted* and had just sent in the payload. The model
         * was being paid to type back what it had been handed, which doubled
         * the output of every reading, doubled the time it took, and made the
         * answer ceiling the limit on how much document could go in one call.
         * On a long document it is also how a reading got truncated: the
         * transcription filled the answer and the passages were cut off.
         *
         * On a scan there is no extracted text, the model's transcription is
         * the only text of that document anybody will ever have, and it is
         * worth every token.
         */
        task: part.media
          ? 'Read this document and return the passages a bid writer would cite from it. Return JSON with ' +
            '`passages`: an array of { text, pageRef }, and `lines`: the document as plain text, one paragraph per ' +
            'entry — this document is a scan, so your transcription is the only text of it anybody will have.'
          : 'Read this document and return the passages a bid writer would cite from it. Return JSON with ' +
            '`passages`: an array of { text, pageRef }. Do not return the document itself: the platform has its ' +
            'text already and is sending it to you.',
        ...(part.media ? { media: part.media } : {}),
        payload: {
          // The hash travels in the payload as well as on the media, so the
          // answer names the document it read.
          documentHash: evidence.hash,
          ...(part.text === undefined ? {} : { document: part.text }),
          ...(document.note ? { howItWasRead: document.note } : {}),
          title: evidence.title,
          kind: evidence.type,
          ...partConstraint(part),
          constraint:
            'Quote the document. Every passage must be the document’s own words — not a summary, not a paraphrase ' +
            'and not a conclusion drawn from it: these passages are cited in a submission to a buyer as the ' +
            'company’s own statement, and a sentence the document does not contain is a false statement made in its ' +
            'name. Keep each passage whole enough to stand on its own in front of an evaluator — a figure, a ' +
            'commitment, a scope line, an accreditation, a date — and give its page or clause in `pageRef` where the ' +
            `document shows one. Drop anything shorter than ${CHUNK_MIN_CHARS} characters: it ranks against a ` +
            'question as well as a paragraph does and tells a drafter nothing. Read the whole document in its own ' +
            'order. Do not answer anything and do not add commentary.',
        },
      },
      // Nothing is committed from the output here. The write happens below,
      // through the command a person uses, so there is one definition of a
      // passage rather than two.
      toWrites: () => [],
      requireModel: {
        // Named for the act rather than the capability, because the capability
        // now follows the document: an extracted Word order form is read by a
        // reasoning model and a scanned one by a vision model, and the stand-in
        // is refused for both.
        code: 'NO_READING_PROVIDER',
        message:
          'This deployment is running the local stand-in, which reads nothing — it derives its answer from a hash of ' +
          'its inputs. Passages invented that way would be filed as this customer’s evidence, cited by the drafter ' +
          'and read by a buyer as the company’s own words. Configure a provider and set AI_MODE to staging or live.',
      },
    });

    acuConsumed += result.acuConsumed;

    const output = result.output as { passages?: unknown; lines?: unknown };
    passages.push(
      ...(Array.isArray(output.passages) ? output.passages : [])
        .map((row) => row as Record<string, unknown>)
        .map((row) => ({
          text: String(row.text ?? '').trim(),
          ...(row.pageRef == null || String(row.pageRef).trim() === '' ? {} : { pageRef: String(row.pageRef).trim() }),
        }))
        .filter((passage) => passage.text.length > 0),
    );

    // The document as plain text: the model's transcription where it read a
    // scan, and the platform's own extraction where it had one — which is the
    // better record of the two and costs nothing to use.
    lines.push(
      ...(part.text === undefined
        ? (Array.isArray(output.lines) ? output.lines : []).map((line) => String(line ?? '').trim())
        : part.text.split(/\n\s*\n|\r?\n/).map((line) => line.trim())
      ).filter(Boolean),
    );
  }

  if (passages.length === 0) {
    // Refused rather than written as an empty reading. `recordExtraction` would
    // refuse this too, with a message about the chunk floor; this one says the
    // truer thing — the provider answered and there was nothing in the answer,
    // which is a different problem from a document of short lines.
    throw new DomainError(
      'BID_ON_NOTHING_READ',
      `Nothing came back for ${evidence.reference}. The item is unchanged and still citable as an attachment — a ` +
        'document with no passages has not been read, and filing an empty reading would make it look as though it ' +
        'had been.',
      502,
    );
  }

  // The same door a person uses. The chunk floor, the refusal when nothing
  // survives it, and the dropped `semanticModel` on a re-read are all its
  // rules, applied once.
  const item = recordExtraction(ctx, evidenceId, {
    extractedText: lines.length > 0 ? lines : passages.map((passage) => passage.text),
    chunks: passages,
  });

  // Every part's charge, not the last one's. A document read in four calls
  // costs four calls, and reporting one of them would understate the spend the
  // customer is about to see on their wallet.
  return { item, chunks: item.chunks.length, reread, acuConsumed, parts: parts.length };
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
  input: {
    questionId: string;
    reviewerInstructions?: string;
    /**
     * Draft it anyway, with the gap still open.
     *
     * The refusal below is a good rule and it was a wall. A gap says the
     * customer has been asked for something; it does not follow that there is
     * nothing useful to write in the meantime, and on a tender that closes on
     * Friday a draft built from what *is* known — with the gap named on it for
     * whoever reviews it — is worth more than an empty question. It is the
     * caller's money and the caller's submission, so this is their decision to
     * take, explicitly, and it is recorded on the answer rather than inferred.
     */
    overOpenGap?: boolean;
  },
): Promise<{
  bid: Bid;
  outcome: 'DRAFTED' | 'GAP_RAISED';
  /** The gap this draft was written over, where the caller chose to. */
  draftedOverGapId?: string;
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
  if (open && input.overOpenGap !== true) {
    /*
     * A gap is a warning, and this used to be a wall.
     *
     * The rule is sound — drafting over an open gap spends money writing around
     * the thing that is missing — and it is not the platform's call to make on
     * somebody's behalf. Two days before a return there is often something
     * worth writing from what *is* known, and the only honest objection is that
     * a reviewer must be able to see it was written that way.
     *
     * So the refusal now names both ways on, including this command with
     * `overOpenGap`, and the answer carries the gap it was drafted over.
     */
    throw new DomainError(
      'BID_ON_GAP_OPEN',
      `${question.number} is waiting on the customer: "${open.promptToClient}". Drafting now spends money writing ` +
        'around the thing that is missing — so either close the gap with what the customer sent, or say to draft ' +
        'over it and the answer will carry the gap for whoever reviews it.',
      409,
      [
        {
          field: 'overOpenGap',
          message: 'Tick "draft it anyway" to write from what is known, with the gap named on the answer',
        },
      ],
    );
  }

  // The Retriever. It filters on the customer before it ranks — so a drafter
  // physically cannot be handed another customer's material — and it ranks by
  // meaning where this customer's library has been embedded.
  //
  // Where the caller chose to draft over an open gap, the model is told what is
  // missing and told not to write as though it were not. A draft that quietly
  // fills the hole is the one thing worse than no draft: it reads as evidenced
  // and is not.
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

  /*
   * A yes/no question needs the field, not just the prose.
   *
   * `recordAnswer` refuses an answer to a `YES_NO` question that carries no
   * `yesNo`, and it is right to: the hard rule that ends a bid on a "no" reads
   * that field, and prose saying "we do not hold ISO 14001" leaves the check
   * seeing an unanswered question. The drafter never asked the model for it and
   * never passed it on — so **every yes/no question in the catalogue called a
   * vendor, was charged for the call, built the answer and was refused on the
   * last line**, with the money spent and nothing recorded.
   *
   * The same shape as the three defects before it: an AI success path that
   * cannot run without a live model, and therefore had never run.
   */
  const wantsYesNo = question.answerType === 'YES_NO';
  const previous = latestAnswer(bid, question.id);

  /*
   * The plan, before the prose.
   *
   * A single pass asked a model to find what is relevant, decide a structure
   * and write to a word limit in one movement, and the thing that fell out was
   * the structure: twenty-five words answering the first limb of a four-limb
   * question, correctly cited and worth forty marks.
   *
   * So the limbs are settled first, on their own, against the passages: what
   * the question actually asks, which passage evidences each part, and what
   * nothing covers. It is a cheap call — no prose, no word limit to hit — and
   * the pass that writes is then writing rather than deciding what to write.
   */
  const plan = await runAI(ctx, {
    engine: 'TENDER',
    taskType: 'bid_on_draft_plan',
    capability: 'REASONING',
    inputRefs: [{ refType: 'BidOnBid', refId: bid.id }],
    attribution: { customerAccountId: bid.customerAccountId, engagementId: bid.engagementId, bidId: bid.id },
    request: {
      task:
        'Plan one answer to one tender question. Do not write the answer. Return JSON with `limbs`: an array of ' +
        '`{ asks, chunkIds, evidenced }` — one entry per distinct thing the question asks, in the order it asks ' +
        'them, with the `chunkId` values that evidence it and `evidenced` true or false; `missing`: an array of ' +
        'anything asked that no passage covers; and `shape`: one sentence on how the answer should be ordered.',
      payload: {
        buyer: bid.buyerName,
        section: question.section,
        number: question.number,
        question: question.text,
        ...(question.wordLimit === undefined ? {} : { wordLimit: question.wordLimit }),
        ...(question.weighting === undefined ? {} : { weightingPercent: question.weighting }),
        passages: retrieved.chunks.map((chunk) => ({
          chunkId: chunk.chunkId,
          source: `${chunk.reference} ${chunk.title}${chunk.pageRef ? ` (${chunk.pageRef})` : ''}`,
          text: chunk.text,
        })),
        constraint:
          'Split the question the way an evaluator would mark it: every limb it asks, including the ones buried ' +
          'in an "including" or a sub-clause, because an answer that misses one loses those marks whatever else ' +
          'it does. Claim no passage evidences something it does not — a limb with nothing behind it is `missing`, ' +
          'and saying so here is what stops the answer inventing it.',
      },
    },
    toWrites: () => [],
    requireModel: NO_PROVIDER,
  });

  const planned = plan.output as { limbs?: unknown; missing?: unknown; shape?: unknown };

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
        'the passages do not support.' +
        (wantsYesNo
          ? ' This question is answered **yes or no**. Also return `yesNo` as a boolean — `true` for yes, `false` ' +
            'for no — decided from the passages and consistent with the prose. It is a separate field because a ' +
            'rule reads it directly, and prose alone leaves the question unanswered as far as that rule is ' +
            'concerned.'
          : ''),
      payload: {
        buyer: bid.buyerName,
        scheme: bid.scheme,
        section: question.section,
        number: question.number,
        question: question.text,
        ...(question.wordLimit === undefined ? {} : { wordLimit: question.wordLimit }),
        mandatory: question.mandatory,
        // What this question is worth, where the buyer said. A question
        // carrying 40% of the marks deserves the whole of its limit; one
        // carrying 2% does not, and the drafter could not tell them apart.
        ...(question.weighting === undefined ? {} : { weightingPercent: question.weighting }),
        ...(question.passFail ? { passFail: 'This question is pass/fail. A weak answer here ends the bid.' } : {}),
        answerType: question.answerType,
        ...(wantsYesNo
          ? {
              yesNoInstruction:
                'Answer `yesNo` from the passages. Do not answer yes to be agreeable: a wrong yes is a ' +
                'representation to a buyer that the bidder cannot stand behind, and a true no is better than a ' +
                'yes that is not. Where the passages do not settle it, say so in `unsupported` and answer ' +
                '`yesNo` with the position the passages do support.',
            }
          : {}),
        // The passages, each with the id the answer has to cite it by.
        passages: retrieved.chunks.map((chunk) => ({
          chunkId: chunk.chunkId,
          source: `${chunk.reference} ${chunk.title}${chunk.pageRef ? ` (${chunk.pageRef})` : ''}`,
          text: chunk.text,
        })),
        ...(previous && previous.status === 'REJECTED' && previous.reviewNote
          ? { reviewerInstructions: previous.reviewNote }
          : {}),
        /*
         * The last attempt, and exactly why it scored what it scored.
         *
         * A redraft used to be told only a reviewer's rejection note, where
         * there was one. The scorer's own criterion-by-criterion reasons —
         * already written, already paid for — were on the record and never
         * reached the thing that could act on them, so the second attempt made
         * the same mistakes as the first and cost the same again.
         *
         * Given the text and the marks together, a redraft is a revision
         * rather than a fresh guess: the criteria that scored worst are named,
         * and the one instruction is to fix those without disturbing what
         * already worked.
         */
        ...(previous?.scores
          ? {
              previousAttempt: {
                version: previous.version,
                body: previous.body,
                scores: previous.scores,
                whyItScoredThat: previous.scoreReasons ?? {},
                weakest: Object.entries(previous.scores)
                  .sort(([, left], [, right]) => Number(left) - Number(right))
                  .slice(0, 2)
                  .map(([criterion]) => criterion),
              },
              revisionInstruction:
                'This question has been answered before and scored. Write a better answer, not a different one: ' +
                'keep what the marks say worked, fix what they say did not, and give the weakest criteria named ' +
                'above the most attention. Every rule above still holds — a revision that gains a mark by ' +
                'claiming something the passages do not support has lost the bid rather than improved the answer.',
            }
          : {}),
        ...(input.reviewerInstructions ? { extraInstructions: input.reviewerInstructions } : {}),
        /*
         * What the customer has been asked for and has not sent.
         *
         * Told to the model because it is drafting over it deliberately: an
         * answer written in ignorance of the gap reads as though the missing
         * thing were in hand, which is the false-evidence failure this whole
         * module is built to prevent. Named, the draft writes what is known and
         * leaves the rest in `unsupported`, where it already belongs.
         */
        ...(open
          ? {
              stillWaitingOnTheCustomer: open.promptToClient,
              gapInstruction:
                'This has been asked of the customer and has not come back. Write what the passages support and ' +
                'leave what depends on the outstanding material in `unsupported`. Do not write around it as ' +
                'though it were in hand, and do not promise anything on the customer’s behalf.',
            }
          : {}),
        /*
         * What the marks are actually given for.
         *
         * The model was told what it must not do — invent, exceed the limit —
         * and almost nothing about what a high-scoring tender answer looks
         * like. So it wrote the twenty-five careful words its evidence
         * supported and scored forty, which is a correct answer and a losing
         * one. An evaluator marks completeness against the question, evidence
         * against what is cited, and specificity against named figures,
         * periods and standards; a drafter that is not told that cannot aim
         * at it.
         *
         * Every one of these is about using the evidence *better*, not about
         * claiming more of it. The constraint above is unchanged and comes
         * first, deliberately: a longer answer that asserts one uncited fact
         * is worth less than a short one, because it is the thing that gets a
         * submission thrown out.
         */
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
        /*
         * The plan this answer is written to.
         *
         * Passed as the structure rather than as a suggestion: the limbs in
         * the order the question asks them is exactly what "completeness" is
         * marked on, and it has already been worked out against the passages.
         */
        plan: {
          ...(Array.isArray(planned.limbs) ? { limbs: planned.limbs } : {}),
          ...(Array.isArray(planned.missing) ? { nothingCoversThese: planned.missing } : {}),
          ...(typeof planned.shape === 'string' ? { shape: planned.shape } : {}),
        },
        planInstruction:
          'Answer every limb of the plan, in its order, each with the evidence named against it. A limb the plan ' +
          'marks as not evidenced goes in `unsupported` and stays out of the prose entirely — the plan having ' +
          'named it is not evidence for it.',
        howItIsMarked:
          'An evaluator scores this on five things, and the answer should be written to be marked on them. ' +
          '**Completeness**: every limb of the question answered, in the order asked — where the question lists ' +
          'requirements or asks "how", take each in turn under its own paragraph. **Evidence**: every commitment ' +
          'tied to a passage, with the document named in the prose where a buyer would expect to see it. ' +
          '**Specificity**: named figures, periods, standards, roles and systems rather than adjectives — "within ' +
          'ten working days, by the nominated assessor, lodged on the central register" beats "promptly, by ' +
          'qualified staff". **Buyer relevance**: the buyer’s own words for their own scheme. **Clarity**: short ' +
          'paragraphs, no preamble, no restating the question, no sales language.',
        lengthInstruction:
          question.wordLimit === undefined
            ? 'No word limit is stated. Write what the evidence supports in full — several paragraphs where there ' +
              'is material for them. A thin answer loses marks it had no need to lose.'
            : `The limit is ${question.wordLimit} words, and it is a target as much as a ceiling: the buyer is ` +
              `marking what is in those ${question.wordLimit} words, and an answer at a fraction of the limit ` +
              'throws away marks that were available. Use the space the passages genuinely support — aim near the ' +
              'limit where there is material, and stop short rather than padding where there is not. Never fill ' +
              'space with anything the passages do not carry.',
      },
    },
    toWrites: () => [],
    requireModel: NO_PROVIDER,
  });

  /*
   * The draft, marked as a buyer would mark it, and rewritten once.
   *
   * A first attempt is a first attempt. The platform already owns a scorer
   * that reads an answer adversarially against the five criteria — and it ran
   * *after* the answer was recorded, so the thing it criticised was the thing
   * the person had to approve. The criticism is worth more before the record
   * than after it.
   *
   * So the draft is marked and revised inside the same press: the pass is
   * given its own answer, the question, the marking criteria and the same
   * passages, and asked what an evaluator would take marks off for and then to
   * fix exactly that. One revision, not a loop — a second one trades real money
   * for diminishing prose, and the separate `Score it` is still there for a
   * reviewer who wants an independent read of what was recorded.
   *
   * The constraint does not move. A revision that gains a mark by claiming
   * something the passages do not support has lost the bid rather than improved
   * the answer, and its citations are checked exactly as the first draft's are.
   */
  const revised = await runAI(ctx, {
    engine: 'TENDER',
    taskType: 'bid_on_draft_revise',
    capability: 'REASONING',
    inputRefs: [{ refType: 'BidOnBid', refId: bid.id }],
    attribution: { customerAccountId: bid.customerAccountId, engagementId: bid.engagementId, bidId: bid.id },
    request: {
      task:
        'Mark this draft tender answer as the buyer’s evaluator would, then rewrite it to score higher. Return ' +
        'JSON in exactly the shape of the draft — `body`, `citations`, `unsupported`' +
        (wantsYesNo ? ', `yesNo`' : '') +
        ' — plus `tookMarksOffFor`: an array of what an evaluator would have marked it down for. Return the ' +
        'improved answer in `body`, not the original.',
      payload: {
        buyer: bid.buyerName,
        section: question.section,
        number: question.number,
        question: question.text,
        ...(question.wordLimit === undefined ? {} : { wordLimit: question.wordLimit }),
        ...(question.weighting === undefined ? {} : { weightingPercent: question.weighting }),
        answerType: question.answerType,
        theDraft: result.output,
        passages: retrieved.chunks.map((chunk) => ({
          chunkId: chunk.chunkId,
          source: `${chunk.reference} ${chunk.title}${chunk.pageRef ? ` (${chunk.pageRef})` : ''}`,
          text: chunk.text,
        })),
        markOn:
          'Completeness — is every limb of the question answered, in the order asked? Evidence — is every ' +
          'commitment tied to a passage and named where a buyer would look for it? Specificity — are there ' +
          'figures, periods, standards, roles and systems, or adjectives? Buyer relevance — is it in the buyer’s ' +
          'own vocabulary for their own scheme? Clarity and limits — short paragraphs, no preamble, no restating ' +
          'the question, inside any stated word limit.',
        constraint:
          'Every rule the draft was written under still holds. State nothing the passages do not support; every ' +
          'claim carries its passage’s `chunkId` in `citations`; anything asked that nothing covers goes in ' +
          '`unsupported` and stays out of the prose. A mark gained by claiming something the passages do not ' +
          'carry is a false statement to a buyer and loses the bid rather than improving the answer. If the draft ' +
          'cannot honestly be improved, return it unchanged and say so in `tookMarksOffFor`.',
      },
    },
    toWrites: () => [],
    requireModel: NO_PROVIDER,
  });

  /*
   * Whichever of the two actually has an answer in it.
   *
   * The revision is preferred and the draft is the fallback, because a revise
   * pass that comes back empty or uncited must not turn a perfectly good first
   * draft into a gap. A vendor fault on the third call is not a reason to
   * throw away the second.
   */
  const bodyOf = (from: unknown): string[] =>
    (Array.isArray((from as { body?: unknown })?.body) ? ((from as { body: unknown[] }).body) : [])
      .map((line) => String(line).trim())
      .filter(Boolean);

  const output = (bodyOf(revised.output).length > 0 ? revised.output : result.output) as {
    body?: unknown;
    citations?: unknown;
    unsupported?: unknown;
    yesNo?: unknown;
  };
  const body = bodyOf(output);
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
      acuConsumed: plan.acuConsumed + result.acuConsumed + revised.acuConsumed + retrieved.acuConsumed,
      retrieval: retrievalOf(retrieved),
    };
  }

  /*
   * The yes or the no, where the question has one.
   *
   * Read rather than inferred from the prose. A bid ends at the gate on a "no",
   * so deriving one from a paragraph — "we do not currently hold…" — would be
   * the platform deciding something that binds a company, out of a sentence
   * that was not written to be parsed.
   *
   * Where the model did not answer it, nothing is invented and the prose is not
   * thrown away: the refusal carries the draft so the call that was paid for is
   * not lost, and says the one place to put it.
   */
  const yesNo = yesNoFrom(output.yesNo);
  if (wantsYesNo && yesNo === undefined) {
    throw new DomainError(
      'BID_ON_YES_NO_NOT_DRAFTED',
      `${question.number} is a yes/no question and ${result.provider ?? 'the provider'} answered in prose without ` +
        'the yes or the no. Nothing has been recorded, and nothing has been guessed from the wording: a bid ends ' +
        'at the gate on a "no", and that is not a decision to read out of a paragraph. The draft it produced is ' +
        'below — put it into "Write an answer" with the yes/no field set, and the call is not wasted.\n\n' +
        body.join('\n\n'),
      502,
      [{ field: 'yesNo', message: 'Answer it yes or no in "Write an answer"' }],
    );
  }

  // Through the ordinary command, so the citation check, the versioning and the
  // review state are the same ones a hand-written answer goes through.
  const written = recordAnswer(ctx, bid.id, {
    questionId: question.id,
    body,
    citations,
    ...(yesNo === undefined ? {} : { yesNo }),
    authorship: 'AI_DRAFTED',
    ...(result.provider ? { provider: result.provider } : {}),
    // Written over a gap the caller chose not to wait for. On the answer, so a
    // reviewer reads the draft and the open question together rather than
    // finding the gap later on another screen.
    ...(open ? { draftedOverGap: { gapId: open.id, prompt: open.promptToClient } } : {}),
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
    // Said back, so a caller that chose to draft over a gap is told the draft
    // carries it rather than having to remember.
    ...(open ? { draftedOverGapId: open.id } : {}),
    // The draft and the retrieval that fed it. One number, because one press of
    // one button is what the provider is charged for.
    acuConsumed: plan.acuConsumed + result.acuConsumed + revised.acuConsumed + retrieved.acuConsumed,
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
): Promise<{ note: string; gaps: number; returnables: number; acuConsumed: number }> {
  const bid = gate(ctx, bidId);
  authorise(ctx, 'BID_SERVICES', 'X', { dataSensitivity: 'COMMERCIAL_L3' });

  const open = bid.gaps.filter((entry) => !entry.resolvedAt);
  /*
   * The customer's own returnables belong in this message too.
   *
   * A priced cost model and a signed order form are the customer's to produce
   * — the provider writes prose, the contractor prices their own rates and
   * signs their own contract. Those are not gaps in the evidence and they are
   * exactly as missing, and asking for them in a second message a week later is
   * how a submission goes out short of the one document the buyer cared about.
   * One request, everything in it.
   */
  const theirs = bid.returnables.filter(
    (entry) => entry.owner === 'CUSTOMER' && entry.status === 'OUTSTANDING',
  );

  if (open.length === 0 && theirs.length === 0) {
    throw new DomainError(
      'BID_ON_NO_GAPS',
      `${bid.reference} has no open gap and nothing outstanding with the customer, so there is nothing to ask for. ` +
        'Nothing was spent.',
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
        // What the customer is told to work to. A rolling submission has no
        // return date, and inventing one to put in a message to a contractor
        // is how a made-up date becomes the date everybody plans around.
        ...(bid.deadline ? { deadline: bid.deadline } : { deadline: 'rolling — there is no return date' }),
        missing: open.map((gap) => ({
          question: numberOf.get(gap.questionId) ?? '',
          asked: gap.promptToClient,
        })),
        documents: theirs.map((entry) => ({
          reference: entry.reference,
          what: entry.title,
          ...(entry.format ? { format: entry.format } : {}),
          ...(entry.signatureRequired ? { signature: 'needs signing' } : {}),
          ...(entry.internalDueBy ? { weNeedItBy: entry.internalDueBy } : {}),
          mandatory: entry.mandatory,
        })),
        constraint:
          'One message, grouped so the reader can gather things in one go rather than one item at a time. Plain ' +
          'English for somebody who runs a contracting business and does not write bids: no procurement jargon, no ' +
          'question numbers as the only identifier, and say what each thing is for. Name the return date and what ' +
          'happens to the submission without each item. Ask for nothing that is not in the list. `documents` are ' +
          'things only they can produce — their own rates, their own signature — so ask for those as documents to ' +
          'send back rather than as questions to answer, name the format where one is stated, say which need ' +
          'signing, and give the date we need each by rather than the buyer\u2019s.',
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

  return { note, gaps: open.length, returnables: theirs.length, acuConsumed: result.acuConsumed };
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

// --- The amendments reading --------------------------------------------------

/**
 * Read a schedule of amendments for what it shifts. `X` on `BID_SERVICES`.
 *
 * ## What this is, and the three things it is not
 *
 * A measured term contract arrives as an unamended standard form plus a
 * schedule of amendments, and the amendments are where the risk lives. An
 * unamended JCT MTC is a known quantity; the same contract with twenty
 * amendments is a different contract, and the commonest way a term contract
 * goes wrong is that nobody read them until the first dispute.
 *
 * So this reads them and produces **questions for the buyer** and **points to
 * put in front of whoever advises the customer**. It is not:
 *
 * - **Legal advice.** It says nothing about whether a clause is enforceable or
 *   what it would mean in court. The output is phrased as questions and
 *   observations, and the record says a model wrote them.
 * - **A decision.** It does not accept, reject or qualify anything. Accepting
 *   an amended contract binds a company, and no agent mandate in this platform
 *   reaches an act that binds one — the clarifications it raises are things to
 *   ask before anybody decides.
 * - **A substitute for reading them.** It is a first pass over a document
 *   somebody still has to read. Its value is that the questions are on the
 *   table before the clarification deadline rather than after it, which is the
 *   difference between a point that can be negotiated and one that cannot.
 *
 * The clarifications land on the bid beside the ones the question list raised,
 * because they are the same thing: something to ask the buyer while asking is
 * still possible.
 */
export async function reviewAmendments(
  ctx: EngineContext,
  store: EvidenceStore,
  bidId: string,
  input: { text?: string; hash?: string; contractForm?: string },
): Promise<{
  bid: Bid;
  clarifications: Clarification[];
  observations: string[];
  /** False where the reading found nothing the bid did not already hold. */
  recorded: boolean;
  acuConsumed: number;
}> {
  const bid = gate(ctx, bidId);
  authorise(ctx, 'BID_SERVICES', 'X', { dataSensitivity: 'COMMERCIAL_L3' });

  if (!input.text?.trim() && !input.hash) {
    throw new DomainError(
      'BID_ON_NOTHING_TO_REVIEW',
      'Give it the schedule of amendments: the text, or the hash of a file already in the evidence store.',
      400,
    );
  }

  // Same as the parser, and this is the one where reading the wrong thing
  // costs most: a model answering from a filename would report no amendments
  // on a four-year contract.
  const document = input.hash
    ? await documentForReading(ctx, store, documentHashFrom(ctx, input.hash), 'the schedule of amendments')
    : undefined;

  // A schedule of amendments as a file is a document a vision model reads;
  // pasted clauses are text. The capability follows the input, for the same
  // reason the parser's does.
  const capability = document?.kind === 'MEDIA' ? 'PERCEPTION' : 'REASONING';
  const inputRefs = [{ refType: 'BidOnBid', refId: bid.id }];

  // Pasted clauses are a document for this purpose. A schedule of amendments to
  // a standard form runs to a hundred pages often enough that the whole of it
  // past the window is an ordinary case, not an edge one.
  const source: DocumentForReading | undefined =
    document ?? (input.text?.trim() ? { kind: 'TEXT', text: input.text } : undefined);
  const parts = partsFor(source, ctx.orchestrator.textBudgetChars({ capability, inputRefs }));

  const severities = new Set(['CRITICAL', 'MAJOR', 'MINOR']);
  const clarifications: Clarification[] = [];
  const observations: string[] = [];
  let acuConsumed = 0;
  // The vendor that read the first part. Every part goes to the same chain, and
  // naming one of them is what the record needs: a reading is attributed, not
  // enumerated. `''` is never recorded — a reading with no part read at all is
  // refused below before this is written.
  let provider = '';

  for (const part of parts) {
    const result = await runAI(ctx, {
      engine: 'TENDER',
      taskType: 'bid_on_amendments',
      capability,
      inputRefs,
      attribution: { customerAccountId: bid.customerAccountId, engagementId: bid.engagementId, bidId: bid.id },
      request: {
        ...(part.media ? { media: part.media } : {}),
        task:
          'Read this schedule of amendments to a standard form construction contract. Return JSON with ' +
          '`clarifications`: an array of { severity, subject, question } where severity is CRITICAL, MAJOR or MINOR, ' +
          'and `observations`: an array of plain-English strings describing what each significant amendment changes ' +
          'compared with the unamended form.',
        payload: {
          contractForm: input.contractForm ?? 'the standard form named in the invitation',
          buyer: bid.buyerName,
          // Extracted where the file carries its own words. A schedule of
          // amendments is a Word document far more often than it is a scan.
          ...(part.text === undefined ? {} : { amendments: part.text }),
          ...(input.hash ? { documentHash: input.hash } : {}),
          ...partConstraint(part),
          constraint:
            'Report what the amendments change and what you would ask the buyer about them. Do not advise whether to ' +
            'accept, reject or qualify anything, do not state whether a clause is enforceable, and do not describe ' +
            'anything as legal advice — a contractor reading this is deciding whether to put it in front of their own ' +
            'adviser, which is the decision this is for. Mark CRITICAL only where an amendment moves a risk a ' +
            'subcontractor cannot price or insure: unlimited liability, a cap removed, fitness for purpose, pay-when-' +
            'paid, a right of set-off without notice, a retention or payment period materially extended, or ' +
            'termination at will. Say nothing about clauses the schedule does not amend. Where the schedule is short ' +
            'or routine, return few findings or none rather than padding — a list of twenty points nobody reads is ' +
            'worse than three that get asked.',
        },
      },
      toWrites: () => [],
      requireModel: NO_PROVIDER,
    });

    acuConsumed += result.acuConsumed;
    if (provider === '') provider = result.provider;

    const output = result.output as { clarifications?: unknown; observations?: unknown };
    clarifications.push(
      ...(Array.isArray(output.clarifications) ? output.clarifications : [])
        .map((entry) => entry as { severity?: unknown; subject?: unknown; question?: unknown })
        .filter((entry) => String(entry.subject ?? '').trim() && String(entry.question ?? '').trim())
        .map((entry) => ({
          // An unrecognised severity becomes MAJOR rather than being dropped. A
          // point the model thought worth raising is worth asking even where it
          // mislabelled how urgent it is, and silently discarding it would make
          // the reading look cleaner than it was.
          severity: (severities.has(String(entry.severity)) ? String(entry.severity) : 'MAJOR') as Clarification['severity'],
          subject: String(entry.subject).trim(),
          question: String(entry.question).trim(),
        })),
    );

    observations.push(
      ...(Array.isArray(output.observations) ? output.observations : []).map((line) => String(line).trim()).filter(Boolean),
    );
  }

  if (clarifications.length === 0 && observations.length === 0) {
    throw new DomainError(
      'BID_ON_NOTHING_READ',
      'Nothing came back from the amendments. The bid is unchanged, and the schedule still has to be read by ' +
        'somebody.',
      502,
    );
  }

  // Merged on subject, so re-reading a longer version of the same schedule adds
  // what is new rather than duplicating what was already asked.
  const held = new Set(bid.clarifications.map((entry) => entry.subject));
  const fresh = clarifications.filter((entry) => !held.has(entry.subject));

  /*
   * A second reading that found nothing new writes nothing.
   *
   * Found by the ledger refusing the commit: re-reading the same schedule
   * produced byte-identical state and `NO_OP_CHANGE` fired. Two fixes were
   * available and only one is honest. Refusing the command would lose the
   * caller the result of a run they have already paid for — the model was
   * called, the wallet moved, and the findings are in hand. Making the state
   * differ by a timestamp would put an event on an append-only ledger whose
   * only content is that somebody pressed the button again.
   *
   * So the findings come back, the spend is reported, and nothing is written.
   * `recorded` says which happened, because "nothing new" and "nothing read"
   * are different answers and the caller should be able to tell them apart.
   */
  const sameObservations =
    bid.amendmentsReview !== undefined &&
    bid.amendmentsReview.observations.length === observations.length &&
    bid.amendmentsReview.observations.every((line, index) => line === observations[index]);

  if (fresh.length === 0 && sameObservations) {
    return {
      bid,
      clarifications,
      observations,
      recorded: false,
      acuConsumed,
    };
  }

  const next: Bid = {
    ...bid,
    clarifications: raiseClarifications(ctx, bid.clarifications, fresh, 'AMENDMENTS'),
    amendmentsReview: {
      observations,
      contractForm: input.contractForm ?? '',
      reviewedAt: new Date().toISOString(),
      reviewedBy: ctx.auth.actorId,
      provider,
    },
  };

  write(ctx, {
    eventType: 'BID_ON_AMENDMENTS_REVIEWED',
    entity: { refType: 'BidOnBid', refId: bid.id },
    nextState: { ...next },
  });

  return { bid: next, clarifications, observations, recorded: true, acuConsumed };
}
