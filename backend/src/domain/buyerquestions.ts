import { authorise, type EngineContext } from '../engines/context.ts';
import type { DocumentBlock } from '../export/exporter.ts';
import { deadlineInForce } from './tenderintake.ts';
import { projectTender, tenderRegister } from './tenderregister.ts';

/**
 * The questions as the buyer sees them, the request for more time, and what an
 * answer changes.
 *
 * The clarification register (`tenderintel.ts`) is the internal log: impact,
 * urgency, owner and how a question is priced meanwhile. None of that goes to
 * the buyer. This makes the buyer-ready schedule from it — CQ-n, the tender
 * reference, the document and clause, the ambiguity stated neutrally and the
 * question — and nothing else; drafts a reasoned request for an extension where
 * the information still missing threatens the deadline; and, once an answer is
 * recorded, says which matrix line, which drafted answer and which risk it
 * reaches. It sends nothing: the platform never puts a question to a buyer, and
 * a draft is shown for a person to approve and send through the buyer's channel.
 */

export type ScheduleRow = {
  /** CQ-n: the client-side questions numbered in the order they were raised, withdrawn ones keeping their number. */
  cq: string;
  /** The internal TQ reference it comes from — kept off the buyer's copy. */
  tq: string;
  tenderReference: string;
  locator: string;
  ambiguity: string;
  question: string;
  status: string;
};

export type BuyerSchedule = {
  tenderReference: string;
  buyer: string;
  rows: ScheduleRow[];
  /** As it is pasted into the buyer's portal or form: one question after another, numbered. */
  text: string;
  summary: string;
};

type ClarificationState = Record<string, unknown> & {
  reference?: string;
  side?: string;
  status?: string;
  subject?: string;
  question?: string;
  ambiguity?: string;
  links?: { document?: string; clause?: string; drawing?: string; package?: string; scopeItem?: string; requirement?: string };
  responseDeadline?: string;
  urgency?: string;
  raisedAt?: string;
  answer?: string;
  answeredOn?: string;
};

function clientQuestions(ctx: EngineContext): ClarificationState[] {
  return ctx.ledger
    .list(ctx.projectId, 'Clarification')
    .map((record) => record.state as ClarificationState)
    .filter((state) => state.side === 'CLIENT')
    .sort((a, b) => String(a.raisedAt ?? '').localeCompare(String(b.raisedAt ?? '')));
}

const locatorOf = (links: ClarificationState['links']): string =>
  [links?.document, links?.clause ? `cl. ${links.clause}` : '', links?.drawing ? `dwg ${links.drawing}` : '', links?.requirement ? `item ${links.requirement}` : '']
    .filter(Boolean)
    .join(', ') || '—';

/** The open questions for the buyer, in the buyer's form — CQ-n, reference, locator, ambiguity, question. */
export function buyerSchedule(ctx: EngineContext): BuyerSchedule {
  authorise(ctx, 'PROCUREMENT_AWARD', 'R', { dataSensitivity: 'COMMERCIAL_L3' });
  const { invitation } = projectTender(ctx);
  const tenderReference = String(invitation?.reference ?? '');
  const buyer = String(invitation?.clientName ?? '');
  const all = clientQuestions(ctx);
  const rows = all
    .map((state, index) => ({ state, cq: `CQ-${index + 1}` }))
    .filter(({ state }) => state.status === 'OPEN')
    .map(({ state, cq }) => ({
      cq,
      tq: String(state.reference ?? ''),
      tenderReference,
      locator: locatorOf(state.links),
      ambiguity: String(state.ambiguity ?? state.subject ?? ''),
      question: String(state.question ?? ''),
      status: String(state.status ?? ''),
    }));
  const text = rows
    .map(
      (row) =>
        `${row.cq}${row.tenderReference ? ` — ${row.tenderReference}` : ''} — ${row.locator}\n` +
        `${row.ambiguity}\n` +
        `Question: ${row.question}`,
    )
    .join('\n\n');
  return {
    tenderReference,
    buyer,
    rows,
    text,
    summary:
      rows.length === 0
        ? 'No open question for the buyer.'
        : `${rows.length} open question(s) for ${buyer || 'the buyer'}, ready to put through the buyer's own channel. Nothing has been sent.`,
  };
}

export type ExtensionDraft = {
  /** Whether the information still missing threatens the deadline. */
  warranted: boolean;
  reasons: string[];
  /** The request, for a person to approve and send. Absent when none is warranted. */
  text?: string;
  returnDeadline?: string;
  summary: string;
};

/**
 * A reasoned request for more time, drafted only where it is warranted: an
 * open question of critical or high urgency, a document the pack refers to but
 * did not supply, or one it lists that never arrived — and the return is close.
 */
export function extensionRequestDraft(ctx: EngineContext, input: { proposedLocal?: string; today?: string } = {}): ExtensionDraft {
  authorise(ctx, 'PROCUREMENT_AWARD', 'R', { dataSensitivity: 'COMMERCIAL_L3' });
  const { invitation } = projectTender(ctx);
  if (!invitation) {
    return { warranted: false, reasons: [], summary: 'There is no tender recorded on this project.' };
  }
  const deadline = deadlineInForce(invitation);
  const register = tenderRegister(ctx);
  const reasons: string[] = [];
  for (const question of clientQuestions(ctx).filter((state) => state.status === 'OPEN' && (state.urgency === 'CRITICAL' || state.urgency === 'HIGH'))) {
    reasons.push(`our question ${locatorOf(question.links)} (“${String(question.subject ?? question.question ?? '')}”) is not yet answered and decides how the tender is priced`);
  }
  for (const missing of register.notSupplied) reasons.push(`${missing.title} is referred to in the tender documents but has not been issued`);
  for (const missing of register.listedNotUploaded) reasons.push(`${missing.title} is listed in the tender documents but has not been received`);

  const today = (input.today ?? new Date().toISOString()).slice(0, 10);
  const daysLeft = Math.round((Date.parse(`${deadline.local.slice(0, 10)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (reasons.length === 0 || daysLeft < 0) {
    return {
      warranted: false,
      reasons,
      returnDeadline: deadline.local,
      summary:
        daysLeft < 0
          ? 'The return deadline has passed; there is nothing to extend.'
          : 'No missing information threatens the deadline, so no extension is warranted.',
    };
  }
  const proposed = input.proposedLocal?.trim() ? input.proposedLocal.replace('T', ' ') : '[the date you propose]';
  const text =
    `Tender ${String(invitation.reference ?? '')}${invitation.clientName ? ` — ${String(invitation.clientName)}` : ''}\n` +
    `Request for an extension to the tender return date\n\n` +
    `We ask that the return date of ${deadline.local.replace('T', ' ')} (${deadline.timeZone}) be extended to ${proposed}, because:\n` +
    reasons.map((reason) => `- ${reason}`).join('\n') +
    `\n\nWithout this information a compliant, fully priced tender cannot be returned on the present date. If the date cannot ` +
    `move, please tell us how tenderers are to treat the missing information, so every tender is priced on the same basis.`;
  return {
    warranted: true,
    reasons,
    text,
    returnDeadline: deadline.local,
    summary: `${reasons.length} reason(s) the deadline is threatened, ${daysLeft} day(s) before the return. A draft for approval — it has not been sent.`,
  };
}

export type AnswerImpact = { kind: 'MATRIX_LINE' | 'ANSWER_SECTION' | 'RISK' | 'PRICE'; reference: string; action: string };

/** What a recorded answer reaches: the matrix line, the drafted answers to it, the risks citing it, and the price where it was priced on an assumption. */
export function answerImpacts(ctx: EngineContext, clarificationId: string): AnswerImpact[] {
  authorise(ctx, 'PROCUREMENT_AWARD', 'R', { dataSensitivity: 'COMMERCIAL_L3' });
  const record = ctx.ledger.get({ refType: 'Clarification', refId: clarificationId });
  if (!record || record.tenantId !== ctx.tenantId) return [];
  const state = record.state as ClarificationState;
  const reference = String(state.reference ?? '');
  const impacts: AnswerImpact[] = [];
  const requirement = state.links?.requirement?.trim();
  if (requirement) {
    impacts.push({ kind: 'MATRIX_LINE', reference: requirement, action: `Review ${requirement} on the matrix against the answer in ${reference}.` });
    for (const pack of ctx.ledger.list(ctx.projectId, 'BidResponsePack').map((entry) => entry.state)) {
      const sections = (pack.sections as Array<{ key: string; alsoAnswers?: string[]; status: string }> | undefined) ?? [];
      for (const section of sections.filter((entry) => entry.key === requirement || (entry.alsoAnswers ?? []).includes(requirement))) {
        if (section.status === 'DRAFTED') {
          impacts.push({ kind: 'ANSWER_SECTION', reference: section.key, action: `Re-read the drafted answer to ${section.key} against ${reference}; redraft it if the answer changes it.` });
        }
      }
    }
  }
  for (const risk of ctx.ledger.list(ctx.projectId, 'RiskRegisterItem').map((entry) => entry.state)) {
    const source = String(risk.source ?? '');
    if (source.includes(reference) || (requirement && source.includes(`Matrix ${requirement} `))) {
      impacts.push({ kind: 'RISK', reference: String(risk.title ?? risk.id), action: `Rescore or close the risk now ${reference} is answered.` });
    }
  }
  if (state.interimTreatment) {
    impacts.push({
      kind: 'PRICE',
      reference,
      action: `It was priced meanwhile as: ${String(state.interimTreatment).replace(/[.\s]+$/, '')}. Revisit the price against the answer.`,
    });
  }
  return impacts;
}

/** The buyer's copy as a document: the questions and nothing internal. */
export function buyerScheduleBlocks(schedule: BuyerSchedule): DocumentBlock[] {
  return [
    {
      kind: 'KEY_VALUES',
      rows: [
        { label: 'Tender reference', value: schedule.tenderReference || '—' },
        { label: 'To', value: schedule.buyer || '—' },
      ],
    },
    {
      kind: 'TABLE',
      caption: 'Clarification questions',
      headers: ['No.', 'Document / clause / drawing', 'The ambiguity', 'Question'],
      rows: schedule.rows.map((row) => [row.cq, row.locator, row.ambiguity, row.question]),
    },
  ];
}
