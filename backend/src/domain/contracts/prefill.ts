import { SOURCE_MATERIAL_RULE } from '../../ai/sourcematerial.ts';
import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { runAI, type EngineContext } from '../../engines/context.ts';
import { packDocuments } from '../../evidence/pipeline.ts';
import { applyField, draftOf, guard, scheduleOf, type ContractDraft } from './drafts.ts';
import { normalise as normaliseValue } from './values.ts';

/**
 * Pre-filling a contract draft from the project's own documents.
 *
 * The agent reads the documents this project has already read in — the
 * invitation to tender, the client's requirements, the award letter, the
 * programme — and proposes a value for each particular it finds, with the
 * document, where in it, and the passage word for word. **Nothing is applied.**
 * A person chooses each value; until they do, the draft is as they left it.
 *
 * What the agent returns is checked in code before anybody sees it:
 *
 * - a particular that is not on the draft's schedule is dropped;
 * - a value cited to a document it was not given is dropped;
 * - a quote that is not in that document, word for word, is dropped — a value
 *   with no passage behind it is a guess presented as a fact;
 * - a value that cannot be read as its type ("about £1m", "TBC") is dropped.
 *
 * What survives is normalised the same way a person's entry is, so two
 * documents saying "£1,250,000" and "1.25m" are one candidate with two sources,
 * and two that differ are a **conflict**, shown side by side; choosing between
 * them needs a reason. A required particular nobody found becomes a question.
 *
 * **Publisher text is never sent.** A document carrying a publisher's copyright
 * notice — a copy of an NEC, JCT or FIDIC form — is held back from the model
 * before anything is sent, and the run says which and why. NEC's terms forbid
 * putting its publications through AI without its written permission, and the
 * other publishers license their text for stated uses only. The check is the
 * copyright notice, so a document that reproduces a form without one is not
 * caught by it; the person choosing the documents is told what is sent.
 */

const MODEL_REQUIRED = {
  code: 'CONTRACT_PREFILL_NEEDS_A_MODEL',
  message: 'Pre-filling a contract needs a reasoning model cleared for the project’s documents; the local stand-in cannot read them. Complete the particulars by hand, or configure a provider.',
};

const MAX_CHARACTERS = 150_000;

const PUBLISHER_MARKERS: ReadonlyArray<{ publisher: string; pattern: RegExp }> = [
  { publisher: 'NEC', pattern: /(©|\(c\)|copyright)[^\n]{0,60}\bnec\b/i },
  { publisher: 'JCT', pattern: /(©|\(c\)|copyright)[^\n]{0,60}(the joint contracts tribunal|\bjct\b)/i },
  { publisher: 'FIDIC', pattern: /(©|\(c\)|copyright)[^\n]{0,60}(\bfidic\b|f[ée]d[ée]ration internationale des ing[ée]nieurs)/i },
];

/** Which publisher's copyright notice a document carries, if any. */
export function publisherText(text: string): string | undefined {
  return PUBLISHER_MARKERS.find((marker) => marker.pattern.test(text))?.publisher;
}

const flat = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

export type Support = { ingestionId: string; filename: string; locator: string; quote: string };
export type Candidate = { id: string; fieldKey: string; value: string; supports: Support[] };

export type ContractPrefill = {
  id: string;
  draftId: string;
  /** The draft revision the agent read against. */
  draftRevision: number;
  documents: Array<{ ingestionId: string; filename: string }>;
  heldBack: Array<{ ingestionId: string; filename: string; reason: string }>;
  omitted: Array<{ ingestionId: string; filename: string; reason: string }>;
  candidates: Candidate[];
  conflicts: string[];
  dropped: Array<{ fieldKey: string; reason: string }>;
  questions: string[];
  requestedBy: string;
  proposedAt: string;
};

export const prefills = (ctx: EngineContext, draftId: string): ContractPrefill[] =>
  ctx.ledger
    .list(ctx.projectId, 'ContractPrefill')
    .map((record) => record.state as unknown as ContractPrefill)
    .filter((entry) => entry.draftId === draftId)
    .sort((a, b) => a.proposedAt.localeCompare(b.proposedAt));

/** The documents a pre-fill may read on this project, and which of them it would hold back. */
export function prefillDocuments(ctx: EngineContext): Array<{ ingestionId: string; filename: string; characters: number; heldBack?: string }> {
  return packDocuments(ctx).map((doc) => {
    const publisher = publisherText(doc.text);
    return { ingestionId: doc.ingestionId, filename: doc.label, characters: doc.text.length, ...(publisher ? { heldBack: `carries ${publisher}’s copyright notice` } : {}) };
  });
}

export async function prefillDraft(
  ctx: EngineContext,
  draftId: string,
  input: { ingestionIds?: string[] },
): Promise<{ prefillId: string; proposed: number; conflicts: number; dropped: number; heldBack: number; questions: number; provider: string; modelClass?: string }> {
  guard(ctx, 'U');
  const draft = draftOf(ctx, draftId);
  if (draft.status !== 'DRAFTING') throw new DomainError('CONTRACT_DRAFT_STATE', `${draft.reference} is ${draft.status.toLowerCase()}.`, 409);
  const schedule = scheduleOf(draft);
  const wanted = input.ingestionIds?.length ? new Set(input.ingestionIds) : undefined;
  const all = packDocuments(ctx).filter((doc) => !wanted || wanted.has(doc.ingestionId));
  if (wanted && all.length !== wanted.size) {
    throw new DomainError('CONTRACT_PREFILL_DOCUMENT', 'A chosen document is not a read document on this project.', 422, [{ field: 'ingestionIds', message: 'read documents only' }]);
  }
  if (all.length === 0) throw new DomainError('CONTRACT_PREFILL_NO_DOCUMENTS', 'There is no read document on this project to take the particulars from. Upload the tender or contract documents first.', 409);

  const heldBack: ContractPrefill['heldBack'] = [];
  const omitted: ContractPrefill['omitted'] = [];
  const sent: Array<{ ingestionId: string; filename: string; text: string }> = [];
  let length = 0;
  for (const doc of all) {
    const publisher = publisherText(doc.text);
    if (publisher) {
      heldBack.push({ ingestionId: doc.ingestionId, filename: doc.label, reason: `It carries ${publisher}’s copyright notice, so it is not sent to an AI model.` });
      continue;
    }
    if (length + doc.text.length > MAX_CHARACTERS) {
      omitted.push({ ingestionId: doc.ingestionId, filename: doc.label, reason: 'Did not fit in one reading; choose fewer documents to include it.' });
      continue;
    }
    length += doc.text.length;
    sent.push({ ingestionId: doc.ingestionId, filename: doc.label, text: doc.text });
  }
  if (sent.length === 0) {
    throw new DomainError(
      'CONTRACT_PREFILL_NOTHING_SENDABLE',
      `None of the chosen documents can be sent: ${[...heldBack, ...omitted].map((entry) => `${entry.filename} — ${entry.reason}`).join(' ')}`,
      409,
    );
  }

  const prefillId = ulid();
  const counts = { proposed: 0, conflicts: 0, dropped: 0, questions: 0 };
  const byId = new Map(sent.map((doc) => [doc.ingestionId, { ...doc, flat: flat(doc.text) }]));
  const result = await runAI(ctx, {
    engine: 'CONTRACTS_CLAIMS',
    taskType: 'contract_prefill',
    capability: 'REASONING',
    inputRefs: [{ refType: 'ContractDraft', refId: draft.id }, ...sent.map((doc) => ({ refType: 'IngestedFile', refId: doc.ingestionId }))],
    requireModel: MODEL_REQUIRED,
    request: {
      task:
        `${SOURCE_MATERIAL_RULE} You are completing the particulars of a contract from the project's own documents. For each ` +
        'particular listed, give its value only where a document states it, with the id of the document, where in it the value ' +
        'is (page, section, clause or table), and the passage that states it, copied word for word. Never infer, estimate or ' +
        'complete a value the documents do not state; leave it out. Where two documents state different values for the same ' +
        'particular, give both. Give a registered legal name only where a document states it as the legal name, never a trading ' +
        `or display name. Money is in ${draft.currency}. Add a question for anything a person must decide or ask the other party.`,
      payload: {
        form: `${draft.form.publisher} ${draft.form.code} ${draft.form.title} (${draft.form.edition})`,
        particulars: schedule.fields.map((field) => ({ key: field.key, label: field.label, type: field.type, ...(field.options ? { options: field.options.map((option) => option.label) } : {}) })),
        documents: sent.map((doc) => ({ id: doc.ingestionId, name: doc.filename, text: doc.text })),
      },
      responseSchema: {
        type: 'object',
        properties: {
          proposals: {
            type: 'array',
            maxItems: 500,
            items: {
              type: 'object',
              properties: { fieldKey: { type: 'string' }, value: { type: 'string' }, documentId: { type: 'string' }, locator: { type: 'string' }, quote: { type: 'string' } },
              required: ['fieldKey', 'value', 'documentId', 'locator', 'quote'],
            },
          },
          questions: { type: 'array', maxItems: 100, items: { type: 'string' } },
        },
        required: ['proposals', 'questions'],
      },
    },
    toWrites: (output) => {
      const candidates = new Map<string, Candidate>();
      const dropped: ContractPrefill['dropped'] = [];
      for (const raw of Array.isArray(output.proposals) ? (output.proposals as Array<Record<string, unknown>>) : []) {
        const fieldKey = String(raw.fieldKey ?? '');
        const field = schedule.fields.find((entry) => entry.key === fieldKey);
        const doc = byId.get(String(raw.documentId ?? ''));
        const quote = String(raw.quote ?? '').trim();
        const locator = String(raw.locator ?? '').trim().slice(0, 256);
        if (!field) {
          dropped.push({ fieldKey: fieldKey.slice(0, 80), reason: 'not a particular of this form' });
          continue;
        }
        if (!doc) {
          dropped.push({ fieldKey, reason: 'cited a document it was not given' });
          continue;
        }
        if (quote.length < 8 || !doc.flat.includes(flat(quote))) {
          dropped.push({ fieldKey, reason: `the passage quoted is not in ${doc.filename}` });
          continue;
        }
        if (!locator) {
          dropped.push({ fieldKey, reason: 'no place in the document given' });
          continue;
        }
        let value: string;
        try {
          value = normaliseValue(field, raw.value, draft.currency);
        } catch {
          dropped.push({ fieldKey, reason: `“${String(raw.value ?? '').slice(0, 60)}” is not a ${field.type.toLowerCase()}` });
          continue;
        }
        const key = `${fieldKey}\u0000${value}`;
        const support: Support = { ingestionId: doc.ingestionId, filename: doc.filename, locator, quote: quote.slice(0, 600) };
        const existing = candidates.get(key);
        if (existing) {
          if (!existing.supports.some((entry) => entry.ingestionId === support.ingestionId && entry.locator === support.locator)) existing.supports.push(support);
        } else {
          candidates.set(key, { id: ulid(), fieldKey, value, supports: [support] });
        }
      }
      const list = [...candidates.values()];
      const conflicts = [...new Set(list.map((entry) => entry.fieldKey))].filter((key) => list.filter((entry) => entry.fieldKey === key).length > 1);
      const found = new Set(list.map((entry) => entry.fieldKey));
      const questions = [
        ...schedule.fields.filter((field) => field.required && !found.has(field.key) && !draft.fields[field.key]).map((field) => `${field.label}: not stated in the documents read.`),
        ...(Array.isArray(output.questions) ? (output.questions as unknown[]).map((entry) => String(entry).trim().slice(0, 400)).filter((entry) => entry.length > 0) : []),
      ].slice(0, 150);
      counts.proposed = list.length;
      counts.conflicts = conflicts.length;
      counts.dropped = dropped.length;
      counts.questions = questions.length;
      const prefill: ContractPrefill = {
        id: prefillId,
        draftId: draft.id,
        draftRevision: draft.revision,
        documents: sent.map((doc) => ({ ingestionId: doc.ingestionId, filename: doc.filename })),
        heldBack,
        omitted,
        candidates: list,
        conflicts,
        dropped: dropped.slice(0, 200),
        questions,
        requestedBy: ctx.auth.actorId,
        proposedAt: new Date().toISOString(),
      };
      return [
        {
          eventType: 'CONTRACT_PREFILL_PROPOSED',
          entity: { refType: 'ContractPrefill', refId: prefillId },
          nextState: prefill as unknown as Record<string, unknown>,
          reason: `${draft.reference}: ${list.length} value(s) proposed from ${sent.length} document(s), ${conflicts.length} in conflict, ${dropped.length} dropped`,
        },
      ];
    },
  });
  return { prefillId, ...counts, heldBack: heldBack.length, provider: result.provider, ...(result.modelClass ? { modelClass: result.modelClass } : {}) };
}

/**
 * A person takes one proposed value into the draft.
 *
 * Where the documents disagreed, the choice needs a reason: the other value is
 * not wrong because it lost, and whoever reads the draft next should know why
 * this one was preferred.
 */
export function acceptCandidate(
  ctx: EngineContext,
  draftId: string,
  input: { prefillId: string; candidateId: string; note?: string; expectedRevision: number },
): ContractDraft {
  guard(ctx, 'U');
  const draft = draftOf(ctx, draftId);
  const prefill = prefills(ctx, draft.id).find((entry) => entry.id === input.prefillId);
  if (!prefill) throw new DomainError('CONTRACT_PREFILL_NOT_FOUND', 'No such pre-fill on this draft.', 404);
  const candidate = prefill.candidates.find((entry) => entry.id === input.candidateId);
  if (!candidate) throw new DomainError('CONTRACT_CANDIDATE_NOT_FOUND', 'No such proposed value in that pre-fill.', 404);
  if (prefill.conflicts.includes(candidate.fieldKey) && !(input.note ?? '').trim()) {
    throw new DomainError('CONTRACT_CONFLICT_REASON', 'The documents disagree on this particular; say why this value is the one.', 422, [{ field: 'note', message: 'why this one' }]);
  }
  const support = candidate.supports[0]!;
  return applyField(ctx, draft.id, {
    key: candidate.fieldKey,
    value: candidate.value,
    ...(input.note?.trim() ? { note: input.note } : {}),
    expectedRevision: input.expectedRevision,
    source: { kind: 'EVIDENCE', prefillId: prefill.id, candidateId: candidate.id, ingestionId: support.ingestionId, filename: support.filename, locator: support.locator, quote: support.quote },
  });
}
