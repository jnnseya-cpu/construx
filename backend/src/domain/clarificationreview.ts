import { DomainError } from '../core/errors.ts';
import { authorise, currentPhase, runAI, type EngineContext } from '../engines/context.ts';
import { ingestedFiles } from '../evidence/pipeline.ts';
import { expertBriefing } from '../ai/expertise.ts';
import { CRITIQUE_SCHEMA, partitionByCritique, shapeCritiques } from '../ai/refine.ts';

/**
 * Review a tender as a construction expert, and propose the clarification
 * questions worth putting to the buyer.
 *
 * The matrix reader catches what arithmetic catches — weightings that do not add
 * up, a clause that cannot be insured. It does not read the scope the way a bid
 * manager does and ask the question a person would: the contradiction between
 * two clauses, the quantity the price list omits, the responsibility split the
 * documents leave unsaid, the condition that cannot be priced as written. This
 * is that read — a senior QS / bid manager going through the actual documents
 * before pricing.
 *
 * Three rules keep it honest, and they are the same three the rest of the AI
 * surface carries:
 *
 *   - **It reasons only over the documents supplied**, the ingested tender files
 *     that yielded text, and it names which they were. It is told to quote the
 *     passage each question comes from, so a person can see the basis rather
 *     than take the question on trust.
 *   - **It must come from a model.** `requireModel` refuses the local stand-in
 *     before a penny is charged — an expert review from a provider that read
 *     nothing is not a review, and a fabricated clarification is the exact thing
 *     the mechanical path was just cleaned of.
 *   - **It proposes; it never raises.** Nothing reaches the clarification
 *     register here. The questions come back as drafts; raising one onto the
 *     register, where it can be sent, stays a person's act.
 */

const PACK_TEXT_MAX = 180_000;

export type ProposedClarification = {
  /** A short label for the register. */
  subject: string;
  /** The question to put to the buyer. */
  question: string;
  /** The passage(s) from the documents the question arises from, for a person to verify. */
  basis: string;
};

export type ClarificationReview = {
  /** False when no model could run (no provider, empty wallet) or no document carried text. */
  available: boolean;
  proposed: ProposedClarification[];
  /** The ingested documents the review actually read. */
  documentsReviewed: string[];
  acuConsumed: number;
  note: string;
};

/**
 * Shape and guard the model's output: keep only entries that are a real question
 * with a real basis, de-duplicate, and cap the set — a review that returns
 * forty questions is a review nobody will read. Pure, so the guard is tested
 * without a provider.
 */
export function shapeProposedQuestions(output: Record<string, unknown>): ProposedClarification[] {
  const raw = Array.isArray((output as { questions?: unknown }).questions)
    ? ((output as { questions: unknown[] }).questions)
    : [];
  const seen = new Set<string>();
  const out: ProposedClarification[] = [];
  for (const entry of raw) {
    const row = (entry ?? {}) as Record<string, unknown>;
    const subject = String(row.subject ?? '').trim();
    const question = String(row.question ?? '').trim();
    const basis = String(row.basis ?? '').trim();
    // A real question against a real passage — not a one-word stub, and not a
    // question with nothing in the documents behind it.
    if (question.length < 20 || basis.length < 10) continue;
    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ subject: subject || question.slice(0, 60), question, basis });
    if (out.length >= 8) break;
  }
  return out;
}

const QUESTIONS_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          question: { type: 'string' },
          basis: { type: 'string' },
        },
        required: ['subject', 'question', 'basis'],
      },
    },
  },
  required: ['questions'],
} as const;

/**
 * The verify-and-improve pass. A first draft is a first draft; this is where it
 * is made worth sending. An independent senior reviewer — reading the questions
 * the way the buyer and every competitor will — marks each one against the bar it
 * actually has to clear: is it material, specific, and genuinely supported by the
 * passage it cites? What it passes is kept; what is real but loose is rewritten
 * to the fault named; what is immaterial, already answered, generic or unsupported
 * is dropped. Best-effort: a provider or wallet failure mid-way leaves the
 * first-pass questions standing rather than losing them.
 */
async function refineClarifications(
  ctx: EngineContext,
  proposed: ProposedClarification[],
  documents: Array<{ label: string; text: string }>,
): Promise<{ questions: ProposedClarification[]; acuConsumed: number; droppedCount: number; sharpenedCount: number }> {
  let acuConsumed = 0;

  // 1. Critique — an independent senior reviewer marks each question. It did not
  //    write them and is not here to be kind to them.
  const critique = await runAI(ctx, {
    engine: 'TENDER',
    taskType: 'tender_clarification_critique',
    capability: 'REASONING',
    inputRefs: [],
    request: {
      task:
        `${expertBriefing('BID_MANAGER')} ` +
        'A first pass has proposed the clarification questions below, each with the passage it rests on. You did not ' +
        'write them, and you are not here to be kind to them — mark each as it will be judged once it is sent to the ' +
        'buyer and read by every competitor. For each, return its `index`, a `verdict`, and the `fault` in one ' +
        'sentence. KEEP a question that is material, specific, and genuinely supported by its basis. SHARPEN one that ' +
        'is real but loose — vague, not quantified, broader than its basis, or worded so the buyer could brush it off ' +
        '— and name exactly what to tighten. DROP one that is immaterial, already answered in the documents, generic ' +
        'enough to fit any tender, or that reveals the bidder cannot meet a clear requirement. Check each basis against ' +
        'the documents supplied: if the quoted passage does not actually say what the question claims, that is a DROP.',
      payload: {
        questions: proposed.map((q, index) => ({ index, subject: q.subject, question: q.question, basis: q.basis })),
        documents,
      },
      responseSchema: CRITIQUE_SCHEMA,
    },
    toWrites: () => [],
  });
  acuConsumed += critique.acuConsumed;

  const critiques = shapeCritiques(critique.output, proposed.length);
  const { keep, sharpen, droppedCount } = partitionByCritique(proposed, critiques);

  // 2. Improve — rewrite only what was faulted, to clear the bar. If nothing
  //    needs sharpening, the kept set is already the answer.
  let sharpened: ProposedClarification[] = [];
  if (sharpen.length > 0) {
    const improve = await runAI(ctx, {
      engine: 'TENDER',
      taskType: 'tender_clarification_sharpen',
      capability: 'REASONING',
      inputRefs: [],
      request: {
        task:
          `${expertBriefing('BID_MANAGER')} ` +
          'Each question below was judged real but not yet good enough, with the fault named. Rewrite each to fix ' +
          'exactly that fault: make it specific and quantified, keep it within what its basis actually supports, and ' +
          'word it so the buyer must answer it rather than brush it off. Quote the passage(s) it rests on as the basis. ' +
          'If a question cannot be made both sharp and supported by the documents, omit it rather than pad it. Return ' +
          'the same shape: `questions`, an array of { subject, question, basis }.',
        payload: {
          toSharpen: sharpen.map((entry) => ({
            subject: entry.item.subject,
            question: entry.item.question,
            basis: entry.item.basis,
            fault: entry.fault,
          })),
          documents,
        },
        responseSchema: QUESTIONS_SCHEMA,
      },
      toWrites: () => [],
    });
    acuConsumed += improve.acuConsumed;
    sharpened = shapeProposedQuestions(improve.output);
  }

  // 3. Merge: the kept questions plus the sharpened rewrites, re-guarded,
  //    de-duplicated and capped. The dropped ones are gone — that is the point.
  const questions = shapeProposedQuestions({ questions: [...keep, ...sharpened] });
  return { questions, acuConsumed, droppedCount, sharpenedCount: sharpen.length };
}

export async function reviewTenderForClarifications(ctx: EngineContext): Promise<ClarificationReview> {
  authorise(ctx, 'PROCUREMENT_AWARD', 'R', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const docs = ingestedFiles(ctx)
    .filter((file) => file.status === 'INGESTED')
    .map((file) => ({
      label: file.filename ?? file.classification?.kind ?? file.hash.slice(0, 8),
      text: String((file.extraction as { text?: unknown } | undefined)?.text ?? '').trim(),
    }))
    .filter((doc) => doc.text.length > 0);
  const documentsReviewed = docs.map((doc) => doc.label);

  if (docs.length === 0) {
    return {
      available: false,
      proposed: [],
      documentsReviewed: [],
      acuConsumed: 0,
      note:
        'No ingested tender document on this project carries readable text to review. Upload the ITT, specification and ' +
        'scope to the tender, then run the review again — an expert review of an empty pack would be a guess.',
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

  try {
    const result = await runAI(ctx, {
      engine: 'TENDER',
      taskType: 'tender_clarification_review',
      capability: 'REASONING',
      inputRefs: [],
      request: {
        task:
          `${expertBriefing('BID_MANAGER')} ` +
          'You are reviewing this invitation to tender before pricing. From the documents supplied, identify only ' +
          'genuine clarification questions a competent contractor would put to the buyer: internal contradictions ' +
          'between clauses; information missing but needed to price (quantities, limits, responsibilities, provisional ' +
          'sums, access, programme or seasonal constraints); ambiguous scope or responsibility splits; and conditions ' +
          'that cannot be priced as written. For each question, quote the exact passage or passages from the documents ' +
          'that give rise to it, as the basis. Do NOT ask the buyer to confirm a requirement that is already clearly ' +
          'stated; do NOT ask anything that reveals the bidder cannot meet a clear requirement — for example, never ask ' +
          'the buyer to confirm that the bidder must hold an accreditation, because that is the bidder’s to obtain, ' +
          'not a question. Return at most eight questions, the most material first. If the documents are internally ' +
          'consistent and fully specified, return an empty list — that is a valid and useful answer.',
        payload: { documents },
        responseSchema: {
          type: 'object',
          properties: {
            questions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  subject: { type: 'string' },
                  question: { type: 'string' },
                  basis: { type: 'string' },
                },
                required: ['subject', 'question', 'basis'],
              },
            },
          },
          required: ['questions'],
        },
      },
      requireModel: {
        code: 'NO_REASONING_PROVIDER',
        message:
          'This deployment is running the local stand-in, which reads nothing. An expert review of a tender has to come ' +
          'from a model that actually read it — configure a reasoning provider and set AI_MODE=production, or review the ' +
          'documents by hand.',
      },
      // Advisory: it writes no state. Raising a question is a person's act.
      toWrites: () => [],
    });

    const proposed = shapeProposedQuestions(result.output);

    // Verify and improve: a first pass is not a finished job. An independent
    // senior reviewer marks each question and the weak ones are sharpened or
    // dropped before a person ever sees them — the mechanism that makes the
    // output experienced, not just the agent. Best-effort: if the second pass
    // cannot run, the first-pass questions still stand.
    let questions = proposed;
    let refineAcu = 0;
    let droppedCount = 0;
    let sharpenedCount = 0;
    let refined = false;
    if (proposed.length > 0) {
      try {
        const refinement = await refineClarifications(ctx, proposed, documents);
        questions = refinement.questions;
        refineAcu = refinement.acuConsumed;
        droppedCount = refinement.droppedCount;
        sharpenedCount = refinement.sharpenedCount;
        refined = true;
      } catch {
        // A provider outage or an empty wallet mid-review: keep the first-pass
        // questions rather than lose a paid-for result.
      }
    }

    const reviewedNote = refined
      ? ' Each was marked by an independent senior reviewer' +
        (droppedCount > 0 || sharpenedCount > 0
          ? `, which dropped ${droppedCount} and sharpened ${sharpenedCount} before they reached you.`
          : ' and passed as sent.')
      : '';

    return {
      available: true,
      proposed: questions,
      documentsReviewed,
      acuConsumed: result.acuConsumed + refineAcu,
      note:
        questions.length === 0
          ? proposed.length === 0
            ? 'The review read the tender and found nothing that needs asking — it is internally consistent and specified ' +
              'as written. That is a real answer, not a gap: a clarification nobody needs is one the competition reads too.'
            : 'A first pass proposed questions, but an independent senior review found none of them material, supported and ' +
              'worth sending once it checked each against the documents. There is nothing here that needs asking.'
          : `${questions.length} question${questions.length === 1 ? '' : 's'} proposed from the documents.${reviewedNote} ` +
            'Each cites the passage it comes from — verify it against the tender, then raise the ones worth sending.',
    };
  } catch (error) {
    if (error instanceof DomainError && error.code === 'NO_REASONING_PROVIDER') {
      return {
        available: false,
        proposed: [],
        documentsReviewed,
        acuConsumed: 0,
        note:
          'The expert review needs a reasoning AI provider, and none is configured on this deployment (or the wallet is ' +
          'empty). Nothing was charged. Configure a provider, or review the documents by hand.',
      };
    }
    throw error;
  }
}
