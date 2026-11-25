import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { authorise, write, type EngineContext } from '../../engines/context.ts';
import { requireModule } from '../../identity/modules.ts';
import type { PermissionCode } from '../../identity/roles.ts';
import { CATALOGUE, draftable, formByKey, formLabel } from './catalogue.ts';
import { DESIGN, PACKAGES, PRICING, recommendForms, SUITES, VALUE_BANDS, type SelectionInput } from './selection.ts';
import { FIELD_GROUPS, findings, hasOwnSchedule, scheduleById, scheduleFor, type FieldDef, type Schedule } from './schedules.ts';
import { display, DRAFT_CURRENCIES, normalise } from './values.ts';

/**
 * A contract draft: one form, in one exact edition, and the particulars that
 * complete it — each with where it came from.
 *
 * The draft is pinned when it is opened. The person names the form and confirms
 * its edition in so many words, because "JCT Design and Build" is four
 * different contracts depending on the year, and a draft that quietly moved to
 * the current edition would complete the wrong one. The schedule it is filled
 * against is pinned with it.
 *
 * Every change to a particular is a new revision, made against the revision the
 * person was looking at: two people editing the same draft cannot overwrite each
 * other without seeing it (`CONTRACT_DRAFT_STALE`). A value that came from
 * somewhere other than the person's own hand is replaced only with a reason.
 *
 * Commercial-L3: a draft carries the price, the damages and the security.
 */

export const MODULE = 'CONTRACTS_STUDIO';
const SENSITIVITY = { dataSensitivity: 'COMMERCIAL_L3' as const };

export function guard(ctx: EngineContext, code: PermissionCode): void {
  requireModule(ctx.grantedModules, MODULE);
  authorise(ctx, 'CONTRACTS_CLAIMS', code, SENSITIVITY);
}

export type FieldSource =
  | { kind: 'MANUAL' }
  /** Taken from a read project document, at a stated place in it. */
  | { kind: 'EVIDENCE'; ingestionId: string; filename: string; locator: string; quote?: string };

export type FieldEntry = {
  value: string;
  source: FieldSource;
  note?: string;
  setBy: string;
  setAt: string;
  /** The draft revision this value was set in. */
  revision: number;
};

export type ContractDraft = {
  id: string;
  reference: string;
  title: string;
  formKey: string;
  form: { publisher: string; edition: string; code: string; title: string; status: string };
  scheduleId: string;
  currency: (typeof DRAFT_CURRENCIES)[number];
  selection?: { input: SelectionInput; reasons: string[] };
  status: 'DRAFTING' | 'WITHDRAWN';
  revision: number;
  fields: Record<string, FieldEntry>;
  createdBy: string;
  createdAt: string;
  withdrawn?: { by: string; at: string; reason: string };
};

const strip = (draft: ContractDraft & { version?: number }): ContractDraft => {
  const { version: _version, ...rest } = draft;
  return rest;
};

export const drafts = (ctx: EngineContext): ContractDraft[] =>
  ctx.ledger.list(ctx.projectId, 'ContractDraft').map((record) => record.state as unknown as ContractDraft);

export function draftOf(ctx: EngineContext, id: string): ContractDraft {
  const record = ctx.ledger.get({ refType: 'ContractDraft', refId: id });
  // Another project's draft, or another company's, reads exactly as no draft.
  if (!record || record.projectId !== ctx.projectId || record.tenantId !== ctx.tenantId) throw new DomainError('CONTRACT_DRAFT_NOT_FOUND', 'No such contract draft on this project.', 404);
  return record.state as unknown as ContractDraft;
}

function scheduleOf(draft: ContractDraft): Schedule {
  const schedule = scheduleById(draft.scheduleId);
  if (!schedule) throw new DomainError('CONTRACT_SCHEDULE_UNKNOWN', `The schedule ${draft.scheduleId} this draft was opened on is not held.`, 500);
  return schedule;
}

const reasonText = (value: unknown, field: string, min: number, what: string, max: number): string => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < min) throw new DomainError('CONTRACT_FIELD_REQUIRED', what, 422, [{ field, message: what }]);
  if (text.length > max) throw new DomainError('CONTRACT_FIELD_TOO_LONG', `At most ${max} characters.`, 422, [{ field, message: 'too long' }]);
  return text;
};

/** Open a draft on a form, its edition confirmed by the person opening it. */
export function createDraft(
  ctx: EngineContext,
  input: { formKey: string; confirmEdition: string; title: string; currency?: string; selection?: SelectionInput },
): ContractDraft {
  guard(ctx, 'C');
  const form = formByKey(input.formKey);
  if (!form) throw new DomainError('CONTRACT_FORM_NOT_FOUND', 'That form is not in the catalogue.', 404, [{ field: 'formKey', message: 'choose a form' }]);
  if (!draftable(form)) {
    throw new DomainError(
      'CONTRACT_FORM_EDITION_UNPINNED',
      `${formLabel(form)} is a family or an import route, not one exact issue. Name the exact edition, reprint and any regional variant before drafting on it.`,
      409,
      [{ field: 'formKey', message: 'an exact edition' }],
    );
  }
  if (String(input.confirmEdition ?? '').trim() !== form.edition) {
    throw new DomainError('CONTRACT_EDITION_NOT_CONFIRMED', `Confirm the edition: this draft will complete ${formLabel(form)}.`, 422, [{ field: 'confirmEdition', message: `type ${form.edition}` }]);
  }
  const currency = (input.currency ?? 'GBP').toUpperCase();
  if (!(DRAFT_CURRENCIES as readonly string[]).includes(currency)) {
    throw new DomainError('CONTRACT_CURRENCY', `A draft is written in ${DRAFT_CURRENCIES.join(', ')}.`, 422, [{ field: 'currency', message: 'choose one' }]);
  }
  const schedule = scheduleFor(form.key);
  const selection = input.selection ? { input: input.selection, reasons: recommendForms(input.selection).recommendations.find((entry) => entry.key === form.key)?.reasons ?? [] } : undefined;
  const draft: ContractDraft = {
    id: ulid(),
    reference: `CD-${String(drafts(ctx).length + 1).padStart(3, '0')}`,
    title: reasonText(input.title, 'title', 3, 'Name the contract — what it is for.', 200),
    formKey: form.key,
    form: { publisher: form.publisher, edition: form.edition, code: form.code, title: form.title, status: form.status },
    scheduleId: schedule.id,
    currency: currency as ContractDraft['currency'],
    ...(selection ? { selection } : {}),
    status: 'DRAFTING',
    revision: 1,
    fields: {},
    createdBy: ctx.auth.actorId,
    createdAt: new Date().toISOString(),
  };
  write(ctx, {
    eventType: 'CONTRACT_DRAFT_CREATED',
    entity: { refType: 'ContractDraft', refId: draft.id },
    nextState: draft as unknown as Record<string, unknown>,
    reason: `${draft.reference} opened on ${formLabel(form)}${hasOwnSchedule(form.key) ? '' : ' (general particulars schedule)'}`,
  });
  return draft;
}

/**
 * Set or clear one particular, against the revision the person was looking at.
 *
 * `value: null` clears it. The same value again changes nothing and writes
 * nothing. Replacing a value somebody did not type — one taken from evidence —
 * needs a note saying why.
 */
export function setField(ctx: EngineContext, id: string, input: { key: string; value: string | null; note?: string; expectedRevision: number }): ContractDraft {
  guard(ctx, 'U');
  const draft = draftOf(ctx, id);
  if (draft.status !== 'DRAFTING') throw new DomainError('CONTRACT_DRAFT_STATE', `${draft.reference} is ${draft.status.toLowerCase()}.`, 409);
  if (input.expectedRevision !== draft.revision) {
    throw new DomainError('CONTRACT_DRAFT_STALE', `${draft.reference} has moved on to revision ${draft.revision} since you opened it at revision ${input.expectedRevision}. Reload it and check what changed.`, 412);
  }
  const schedule = scheduleOf(draft);
  const field = schedule.fields.find((entry) => entry.key === input.key);
  if (!field) throw new DomainError('CONTRACT_FIELD_UNKNOWN', `${schedule.title} has no particular "${input.key}".`, 422, [{ field: 'key', message: 'not on this schedule' }]);
  const current = draft.fields[field.key];
  const value = input.value === null ? null : normalise(field, input.value, draft.currency);
  if ((value === null && !current) || (current && value === current.value)) return draft;
  const note = typeof input.note === 'string' && input.note.trim() ? reasonText(input.note, 'note', 3, 'Say why.', 1000) : undefined;
  if (current && current.source.kind !== 'MANUAL' && !note) {
    throw new DomainError('CONTRACT_OVERRIDE_REASON', `${field.label} came from ${current.source.kind.toLowerCase()}; say why it is being replaced.`, 422, [{ field: 'note', message: 'why' }]);
  }
  const revision = draft.revision + 1;
  const fields = { ...draft.fields };
  if (value === null) delete fields[field.key];
  else fields[field.key] = { value, source: { kind: 'MANUAL' }, ...(note ? { note } : {}), setBy: ctx.auth.actorId, setAt: new Date().toISOString(), revision };
  const next: ContractDraft = { ...strip(draft), fields, revision };
  write(ctx, {
    eventType: 'CONTRACT_DRAFT_FIELD_SET',
    entity: { refType: 'ContractDraft', refId: id },
    nextState: next as unknown as Record<string, unknown>,
    reason: `${draft.reference} revision ${revision}: ${field.label} ${value === null ? 'cleared' : 'set'}${note ? ` — ${note}` : ''}`,
  });
  return next;
}

export function withdrawDraft(ctx: EngineContext, id: string, input: { reason: string }): ContractDraft {
  guard(ctx, 'U');
  const draft = draftOf(ctx, id);
  if (draft.status === 'WITHDRAWN') throw new DomainError('CONTRACT_DRAFT_STATE', `${draft.reference} is already withdrawn.`, 409);
  const next: ContractDraft = { ...strip(draft), status: 'WITHDRAWN', withdrawn: { by: ctx.auth.actorId, at: new Date().toISOString(), reason: reasonText(input.reason, 'reason', 5, 'Say why it is withdrawn.', 1000) } };
  write(ctx, { eventType: 'CONTRACT_DRAFT_WITHDRAWN', entity: { refType: 'ContractDraft', refId: id }, nextState: next as unknown as Record<string, unknown>, reason: `${draft.reference} withdrawn: ${next.withdrawn!.reason}` });
  return next;
}

const valuesOf = (draft: ContractDraft): Record<string, string> => Object.fromEntries(Object.entries(draft.fields).map(([key, entry]) => [key, entry.value]));

/** A draft as the screen reads it: every particular in schedule order, with its value, source and findings. */
export function draftView(draft: ContractDraft, nameOf: (actorId: string) => string) {
  const schedule = scheduleOf(draft);
  const found = findings(schedule, valuesOf(draft));
  const required = schedule.fields.filter((field) => field.required);
  return {
    ...draft,
    formLabel: `${draft.form.publisher} ${draft.form.code} ${draft.form.title} (${draft.form.edition})`,
    schedule: { id: schedule.id, title: schedule.title, ownSchedule: schedule.formKey !== null },
    groups: FIELD_GROUPS.map((group) => ({
      group,
      fields: schedule.fields
        .filter((field) => field.group === group)
        .map((field: FieldDef) => {
          const entry = draft.fields[field.key];
          return {
            ...field,
            value: entry?.value ?? null,
            display: entry ? display(field, entry.value, draft.currency) : null,
            source: entry?.source ?? null,
            note: entry?.note ?? null,
            setBy: entry ? nameOf(entry.setBy) : null,
            setAt: entry?.setAt ?? null,
            findings: found.filter((finding) => finding.fieldKey === field.key),
          };
        }),
    })).filter((group) => group.fields.length > 0),
    completion: { required: required.length, completed: required.filter((field) => draft.fields[field.key]).length },
    findings: found,
    blocking: found.filter((finding) => finding.severity === 'BLOCKING').length,
  };
}

/** Everything the Contracts Studio screen reads for a project. */
export function studioOverview(ctx: EngineContext, nameOf: (actorId: string) => string) {
  guard(ctx, 'R');
  return {
    drafts: drafts(ctx)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((draft) => draftView(draft, nameOf)),
    catalogue: CATALOGUE.map((entry) => ({ ...entry, draftable: draftable(entry), ownSchedule: hasOwnSchedule(entry.key) })),
    vocabulary: { packages: PACKAGES, design: DESIGN, pricing: PRICING, valueBands: VALUE_BANDS, suites: SUITES, currencies: DRAFT_CURRENCIES },
  };
}

/** The shortlist, behind the same module and permission as the rest. */
export function selectForm(ctx: EngineContext, input: SelectionInput) {
  guard(ctx, 'R');
  return recommendForms(input);
}
