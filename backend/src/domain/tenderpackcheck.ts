import { DomainError } from '../core/errors.ts';
import { authorise, currentPhase, runAI, type EngineContext } from '../engines/context.ts';
import { ingestedFiles } from '../evidence/pipeline.ts';

/**
 * Check a clarification against the tender pack before it is sent.
 *
 * Raising a clarification is the easy, low-value half. The valuable half is
 * reading the whole pack and catching the question it already answers — because
 * a clarification the documents already answer, sent to the buyer, marks the
 * bidder as one who did not read the pack, and that is a real cost on a real
 * bid. Six questions were raised on a live tender before the pricing schedule
 * was in hand, and the schedule answered five of them.
 *
 * So this reads the clarification against the tender documents ingested on the
 * project and returns a verdict — *answered here, with the passage* or *no
 * answer found* — as a proposal the bidder verifies before withdrawing. Three
 * rules make it safe to rely on:
 *
 *   - **It only checks what is loaded.** The verdict is drawn from the ingested
 *     documents that actually carry text (the ITT, the pricing schedule, the
 *     specification — a drawing's text layer is its title block). With no such
 *     document it returns `NO_PACK` rather than guessing, and names nothing.
 *   - **It never withdraws anything.** A model wrongly saying "answered" would
 *     drop a question the bidder needed — the expensive error — so this returns
 *     advice, writes no state, and leaves the withdrawal to a person.
 *   - **The verdict must come from a model.** `requireModel` refuses the local
 *     stand-in: a fixed answer dressed as a reading of the pack is worse than no
 *     check at all.
 */

/** Characters of pack text shown to the model. A small-works pack fits inside this. */
const PACK_TEXT_MAX = 180_000;

export type ClarificationPackCheck = {
  clarificationId: string;
  reference: string;
  /** ANSWERED — the pack answers it; GAP — nothing found; NO_PACK — nothing ingested to check against. */
  verdict: 'ANSWERED' | 'GAP' | 'NO_PACK';
  confidence?: number;
  citation?: { document: string; passage: string };
  reasoning: string;
  /** The ingested documents the check was run against, named so the verdict is traceable. */
  documentsSearched: string[];
};

export async function checkClarificationAgainstPack(
  ctx: EngineContext,
  input: { clarificationId: string },
): Promise<ClarificationPackCheck> {
  authorise(ctx, 'PROCUREMENT_AWARD', 'R', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = ctx.ledger.get({ refType: 'Clarification', refId: input.clarificationId });
  if (!record || record.projectId !== ctx.projectId) {
    throw new DomainError('CLARIFICATION_NOT_FOUND', `No clarification ${input.clarificationId} on this project`, 404);
  }
  const reference = String(record.state.reference ?? input.clarificationId);
  const subject = String(record.state.subject ?? '');
  const question = String(record.state.question ?? '');
  const links = (record.state.links ?? {}) as Record<string, string>;

  // The pack is the ingested documents that yielded text. A drawing's text layer
  // is its title block, so a check runs against the documents that actually say
  // something, and names which they were.
  const docs = ingestedFiles(ctx)
    .filter((file) => file.status === 'INGESTED')
    .map((file) => ({
      label: file.filename ?? file.classification?.kind ?? file.hash.slice(0, 8),
      text: String((file.extraction as { text?: unknown } | undefined)?.text ?? '').trim(),
    }))
    .filter((doc) => doc.text.length > 0);

  const documentsSearched = docs.map((doc) => doc.label);

  if (docs.length === 0) {
    return {
      clarificationId: input.clarificationId,
      reference,
      verdict: 'NO_PACK',
      reasoning:
        'No ingested tender document on this project carries readable text, so there is nothing to check this ' +
        'clarification against. Upload the ITT, the pricing schedule and the specification to the tender, then run the ' +
        'check again — a verdict against an empty pack would be a guess.',
      documentsSearched: [],
    };
  }

  // Bound what the model is shown, filling from the first document to the last.
  let budget = PACK_TEXT_MAX;
  const documents: Array<{ label: string; text: string }> = [];
  for (const doc of docs) {
    if (budget <= 0) break;
    const text = doc.text.slice(0, budget);
    documents.push({ label: doc.label, text });
    budget -= text.length;
  }

  // The provider's confidence is handed to `toWrites`, not returned on the
  // result, so it is captured there — the check writes no state, but the
  // confidence is worth surfacing beside the verdict.
  let providerConfidence: number | undefined;
  const result = await runAI(ctx, {
    engine: 'TENDER',
    taskType: 'clarification_pack_check',
    capability: 'REASONING',
    inputRefs: [{ refType: 'Clarification', refId: input.clarificationId }],
    request: {
      task:
        'You are a bid manager checking, before a tender clarification is sent to the buyer, whether the tender ' +
        'documents already answer it. Decide only from the documents supplied. If one answers the question, set ' +
        'answered true, name that document and quote the exact passage that answers it. If nothing in the documents ' +
        'answers it, set answered false. Never invent an answer the documents do not contain, and do not treat a ' +
        'document merely mentioning the topic as answering the question unless it actually resolves it.',
      payload: {
        clarification: { subject, question, links },
        documents,
      },
      responseSchema: {
        type: 'object',
        properties: {
          answered: { type: 'boolean' },
          documentLabel: { type: ['string', 'null'] },
          passage: { type: ['string', 'null'] },
          reasoning: { type: 'string' },
        },
        required: ['answered', 'reasoning'],
      },
    },
    requireModel: {
      code: 'NO_REASONING_PROVIDER',
      message:
        'This deployment is running the local stand-in, which reads nothing. A verdict on whether the pack answers a ' +
        'clarification has to come from a model that actually read the pack — configure a reasoning provider and set ' +
        'AI_MODE=live, or check the clarification against the documents by hand.',
    },
    // Advisory: it writes no state. The withdrawal, if any, is a person's act.
    toWrites: (_output, confidence) => {
      providerConfidence = confidence;
      return [];
    },
  });

  const output = result.output as {
    answered?: boolean;
    documentLabel?: string | null;
    passage?: string | null;
    reasoning?: string;
  };
  const answered = output.answered === true;
  const citation =
    answered && output.documentLabel && output.passage
      ? { document: String(output.documentLabel), passage: String(output.passage) }
      : undefined;

  return {
    clarificationId: input.clarificationId,
    reference,
    verdict: answered ? 'ANSWERED' : 'GAP',
    ...(providerConfidence === undefined ? {} : { confidence: providerConfidence }),
    ...(citation ? { citation } : {}),
    reasoning: String(output.reasoning ?? ''),
    documentsSearched,
  };
}
