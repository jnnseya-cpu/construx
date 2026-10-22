import { config } from '../../config.ts';
import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { authorise, runAI, write, type EngineContext } from '../../engines/context.ts';
import type { EvidenceStore } from '../../evidence/store.ts';
import { requireModule } from '../../identity/modules.ts';
import type { Clarification } from '../tenderintake.ts';
import { requireVisibleCustomer } from './customers.ts';
import { engagementOpenForWork, engagementsOf, requireOpenEngagement, type Engagement } from './engagements.ts';
import { depositStanding, invoicesOf, requireFundedEngagement } from './billing.ts';
import {
  CHUNK_MIN_CHARS,
  evidenceCurrentOn,
  evidenceOf,
  recordExtraction,
  requireEvidence,
  retrieveFor,
  type BidOnEvidence,
  type EvidenceType,
  type Retrieval,
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
async function retrieveForDrafting(
  ctx: EngineContext,
  bid: Bid,
  question: BidQuestion,
): Promise<Retrieval & { acuConsumed: number }> {
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

  if (inSpace) {
    return retrieveSemantic(ctx, {
      customerAccountId: bid.customerAccountId,
      question: `${question.text} ${question.section}`,
      asAt: day,
    });
  }

  return {
    ...retrieveFor(ctx, {
      customerAccountId: bid.customerAccountId,
      question: `${question.text} ${question.section}`,
      asAt: day,
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
  store: EvidenceStore,
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

  // A questionnaire given as a file is sent as a file. It used to travel as
  // `documentHash` alone, which is the name of a document rather than the
  // document, and a model handed a name answers from the name.
  const media = input.hash ? await documentMedia(ctx, store, input.hash, 'the questionnaire') : undefined;

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
      ...(media ? { media } : {}),
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

/**
 * The bytes behind a hash, as a provider can actually be given them.
 *
 * ## The defect this closes
 *
 * Three commands in this module take a document "by its hash" — the
 * questionnaire parser, the amendments reading and the Reader — and all three
 * put `documentHash: 'sha256:…'` into the payload and sent nothing else. A
 * model handed the *name* of a file it cannot open answers from the name: it
 * returns nothing, or worse, something. The first real use produced
 * `BID_ON_NOTHING_READ` against a document that had uploaded perfectly, which
 * is the kindest way this could have surfaced.
 *
 * `engines/perception.ts` has done it correctly since it was written: fetch the
 * file, check the platform actually holds it, check the size, check the adapter
 * can be handed one at all, and put it on `media` where the adapters read it.
 * This is that sequence, for the module's own three callers.
 *
 * Every refusal here names the thing to go and fix, because each is a different
 * problem: a record whose bytes were never supplied, a file too large to send,
 * and a deployment whose provider cannot read a file at all.
 */
async function documentMedia(
  ctx: EngineContext,
  store: EvidenceStore,
  hash: string,
  what: string,
): Promise<{ contentType: string; base64: string; hash: string }> {
  if (!(await store.holds(ctx.tenantId, hash))) {
    throw new DomainError(
      'BID_ON_FILE_NOT_HELD',
      `The platform holds the hash of ${what} but not the file itself, so there is nothing for a model to read. ` +
        'Supply the file against that evidence record and try again.',
      409,
    );
  }

  const file = await store.fetch(ctx.tenantId, hash);
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
      'No provider configured on this deployment can be handed a file. Reading a document needs a multimodal ' +
        'provider; the local engines compute, they do not perceive.',
      503,
    );
  }

  return { contentType: file.contentType, base64: file.bytes.toString('base64'), hash };
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
): Promise<{ item: BidOnEvidence; chunks: number; reread: boolean; acuConsumed: number }> {
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

  // The file itself, not its name. Fetched before the call so a document whose
  // bytes were never supplied is refused without spending anything.
  const media = await documentMedia(ctx, store, evidence.hash, `${evidence.reference} — ${evidence.title}`);

  const result = await runAI(ctx, {
    engine: 'TENDER',
    taskType: 'bid_on_read',
    // A filed document is a document. The parser makes the same choice for the
    // same reason: offering a reasoning model a scanned policy produces a
    // confident reading of nothing.
    capability: 'PERCEPTION',
    inputRefs: [{ refType: 'BidOnEvidence', refId: evidence.id }],
    attribution: { customerAccountId: evidence.customerAccountId },
    request: {
      task:
        'Read this document and return the passages a bid writer would cite from it. Return JSON with `passages`: ' +
        'an array of { text, pageRef }, and `lines`: the document as plain text, one paragraph per entry.',
      media,
      payload: {
        // The hash travels in the payload as well as on the media, so the
        // answer names the document it read.
        documentHash: evidence.hash,
        contentType: media.contentType,
        title: evidence.title,
        kind: evidence.type,
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
      code: 'NO_PERCEPTION_PROVIDER',
      message:
        'This deployment is running the local stand-in, which reads nothing — it derives its answer from a hash of ' +
        'its inputs. Passages invented that way would be filed as this customer’s evidence, cited by the drafter ' +
        'and read by a buyer as the company’s own words. Configure a perception provider and set AI_MODE=live.',
    },
  });

  const output = result.output as { passages?: unknown; lines?: unknown };
  const passages = (Array.isArray(output.passages) ? output.passages : [])
    .map((row) => row as Record<string, unknown>)
    .map((row) => ({
      text: String(row.text ?? '').trim(),
      ...(row.pageRef == null || String(row.pageRef).trim() === '' ? {} : { pageRef: String(row.pageRef).trim() }),
    }))
    .filter((passage) => passage.text.length > 0);

  const lines = (Array.isArray(output.lines) ? output.lines : [])
    .map((line) => String(line ?? '').trim())
    .filter(Boolean);

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

  return { item, chunks: item.chunks.length, reread, acuConsumed: result.acuConsumed };
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

  // Same correction as the parser: a schedule of amendments given as a file is
  // sent as a file. This is the one of the three where a model answering from a
  // filename would be most expensive — it would report no amendments.
  const media = input.hash ? await documentMedia(ctx, store, input.hash, 'the schedule of amendments') : undefined;

  const result = await runAI(ctx, {
    engine: 'TENDER',
    taskType: 'bid_on_amendments',
    // A schedule of amendments as a file is a document a vision model reads;
    // pasted clauses are text. The capability follows the input, for the same
    // reason the parser's does.
    capability: input.hash ? 'PERCEPTION' : 'REASONING',
    inputRefs: [{ refType: 'BidOnBid', refId: bid.id }],
    attribution: { customerAccountId: bid.customerAccountId, engagementId: bid.engagementId, bidId: bid.id },
    request: {
      ...(media ? { media } : {}),
      task:
        'Read this schedule of amendments to a standard form construction contract. Return JSON with ' +
        '`clarifications`: an array of { severity, subject, question } where severity is CRITICAL, MAJOR or MINOR, ' +
        'and `observations`: an array of plain-English strings describing what each significant amendment changes ' +
        'compared with the unamended form.',
      payload: {
        contractForm: input.contractForm ?? 'the standard form named in the invitation',
        buyer: bid.buyerName,
        ...(input.text ? { amendments: input.text } : {}),
        ...(input.hash ? { documentHash: input.hash } : {}),
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

  const output = result.output as { clarifications?: unknown; observations?: unknown };
  const severities = new Set(['CRITICAL', 'MAJOR', 'MINOR']);
  const clarifications: Clarification[] = (Array.isArray(output.clarifications) ? output.clarifications : [])
    .map((entry) => entry as { severity?: unknown; subject?: unknown; question?: unknown })
    .filter((entry) => String(entry.subject ?? '').trim() && String(entry.question ?? '').trim())
    .map((entry) => ({
      // An unrecognised severity becomes MAJOR rather than being dropped. A
      // point the model thought worth raising is worth asking even where it
      // mislabelled how urgent it is, and silently discarding it would make the
      // reading look cleaner than it was.
      severity: (severities.has(String(entry.severity)) ? String(entry.severity) : 'MAJOR') as Clarification['severity'],
      subject: String(entry.subject).trim(),
      question: String(entry.question).trim(),
    }));

  const observations = (Array.isArray(output.observations) ? output.observations : [])
    .map((line) => String(line).trim())
    .filter(Boolean);

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
      acuConsumed: result.acuConsumed,
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
      provider: result.provider,
    },
  };

  write(ctx, {
    eventType: 'BID_ON_AMENDMENTS_REVIEWED',
    entity: { refType: 'BidOnBid', refId: bid.id },
    nextState: { ...next },
  });

  return { bid: next, clarifications, observations, recorded: true, acuConsumed: result.acuConsumed };
}
