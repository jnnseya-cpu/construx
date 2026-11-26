import { DomainError } from '../../core/errors.ts';
import type { EngineContext } from '../../engines/context.ts';
import type { DocumentBlock } from '../../export/exporter.ts';
import { revisionHash } from './approvals.ts';
import { draftOf, guard, scheduleOf, valuesOf, type ContractDraft } from './drafts.ts';
import { FIELD_GROUPS, findings } from './schedules.ts';
import { display } from './values.ts';

/**
 * The completion pack: the approved particulars as a branded, issued document.
 *
 * It is the platform's schedule of what was agreed, under its own labels, with
 * where every value came from, what was left blank, who approved it and the
 * hash they approved — so whoever completes the publisher's licensed form from
 * it, or signs against it, is reading exactly the revision that was approved.
 * It carries none of the publisher's wording, and says so.
 *
 * Issued only from an approved draft that still matches its approval, and only
 * under the document identity frozen when it was approved: a logo or footer
 * changed since then would put a different issuer on an approved instrument.
 */

const GROUP_TITLES: Record<string, string> = {
  PARTIES: 'Parties',
  PROJECT: 'The project',
  DATES: 'Dates',
  COMMERCIAL: 'Commercial',
  INSURANCE: 'Insurance',
  OBLIGATIONS: 'Obligations',
  ATTACHMENTS: 'Documents bound into the contract',
};

/** The draft, if its pack may be issued now; the reason it may not, otherwise. */
export function issuableDraft(ctx: EngineContext, id: string, brandVersion: number | null): ContractDraft {
  guard(ctx, 'R');
  const draft = draftOf(ctx, id);
  if ((draft.status !== 'APPROVED' && draft.status !== 'EXECUTED') || !draft.review?.approvedAt) {
    throw new DomainError('CONTRACT_PACK_NOT_APPROVED', `${draft.reference} is issued only once approved; it is ${draft.status.toLowerCase().replace('_', ' ')}.`, 409);
  }
  if (revisionHash(draft) !== draft.review.hash) throw new DomainError('CONTRACT_APPROVAL_STALE', `${draft.reference} no longer matches what was approved.`, 409);
  if ((draft.review.brandVersion ?? null) !== brandVersion) {
    throw new DomainError(
      'CONTRACT_BRAND_CHANGED',
      `The company’s document identity has changed since ${draft.reference} was approved (version ${draft.review.brandVersion ?? 'none'}, now ${brandVersion ?? 'none'}). Reopen it and approve it again to issue it under the current identity.`,
      409,
    );
  }
  return draft;
}

export function packDocument(draft: ContractDraft, nameOf: (actorId: string) => string): { title: string; subtitle: string; blocks: DocumentBlock[] } {
  const schedule = scheduleOf(draft);
  const values = valuesOf(draft);
  const review = draft.review!;
  const formLabel = `${draft.form.publisher} ${draft.form.code} ${draft.form.title} (${draft.form.edition})`;
  const blocks: DocumentBlock[] = [
    {
      kind: 'KEY_VALUES',
      rows: [
        { label: 'Contract', value: `${draft.reference} — ${draft.title}` },
        { label: 'Form', value: formLabel },
        { label: 'Schedule', value: schedule.formKey ? schedule.title : `${schedule.title} (this form has no schedule of its own; these are the agreed particulars, not a completed form)` },
        { label: 'Currency', value: draft.currency },
        { label: 'Revision approved', value: `${review.revision} — ${review.hash}` },
        ...review.approvals.map((approval) => ({ label: approval.scope === 'COMMERCIAL' ? 'Commercial approval' : 'Legal approval', value: `${nameOf(approval.by)}, ${approval.at.slice(0, 10)}: ${approval.note}` })),
        ...(review.legalRequired ? [] : [{ label: 'Legal approval', value: 'Not required: the form is not amended, the law is a UK jurisdiction’s and it is not a consumer contract.' }]),
        ...(draft.executed ? [{ label: 'Executed', value: `${draft.executed.executedOn} (${draft.executed.signatureMethod}); signed copy ${draft.executed.signedDocumentHash}` }] : []),
      ],
    },
  ];
  for (const group of FIELD_GROUPS) {
    const fields = schedule.fields.filter((field) => field.group === group);
    if (!fields.length) continue;
    blocks.push({ kind: 'HEADING', level: 2, text: GROUP_TITLES[group] ?? group });
    blocks.push({
      kind: 'TABLE',
      headers: ['Particular', 'Value', 'Source'],
      rows: fields.map((field) => {
        const entry = draft.fields[field.key];
        const source = !entry
          ? '—'
          : entry.source.kind === 'EVIDENCE'
            ? `${entry.source.filename}, ${entry.source.locator}: “${entry.source.quote}”${entry.note ? ` — ${entry.note}` : ''}`
            : `Entered by ${nameOf(entry.setBy)}${entry.note ? ` — ${entry.note}` : ''}`;
        return [field.label, entry ? display(field, entry.value, draft.currency) : 'Not completed', source];
      }),
    });
  }
  const blank = schedule.fields.filter((field) => !values[field.key]);
  const notes = findings(schedule, values).filter((finding) => finding.severity === 'WARNING');
  blocks.push({ kind: 'HEADING', level: 2, text: 'Completion report' });
  blocks.push({
    kind: 'KEY_VALUES',
    rows: [
      { label: 'Particulars completed', value: `${schedule.fields.length - blank.length} of ${schedule.fields.length}` },
      { label: 'Taken from project documents', value: String(Object.values(draft.fields).filter((entry) => entry.source.kind === 'EVIDENCE').length) },
      { label: 'Entered by a person', value: String(Object.values(draft.fields).filter((entry) => entry.source.kind === 'MANUAL').length) },
    ],
  });
  if (blank.length) blocks.push({ kind: 'LIST', ordered: false, items: blank.map((field) => `Left blank: ${field.label}${field.required ? '' : ' (optional)'}`) });
  if (notes.length) blocks.push({ kind: 'LIST', ordered: false, items: notes.map((finding) => finding.message) });
  const manifest = schedule.fields.filter((field) => field.type === 'REFERENCE' && values[field.key]);
  if (manifest.length) {
    blocks.push({ kind: 'HEADING', level: 2, text: 'Attachment manifest' });
    blocks.push({ kind: 'TABLE', headers: ['Document', 'Reference and revision'], rows: manifest.map((field) => [field.label.replace(/ — document and revision$/, ''), values[field.key]!]) });
  }
  blocks.push({
    kind: 'PARAGRAPH',
    text:
      'This schedule records the agreed particulars under the platform’s own labels. It is not the publisher’s form and reproduces none of its wording: ' +
      'complete the licensed edition named above from it, and read the contract itself for what each term means.',
  });
  return { title: 'Contract particulars', subtitle: formLabel, blocks };
}
