import { authorise, type EngineContext } from '../engines/context.ts';
import { packText, type IngestedFileState } from '../evidence/pipeline.ts';
import { DRAFTING_PACK_MAX } from './bidresponse.ts';
import { deadlineInForce, type ZonedInstant } from './tenderintake.ts';
import type { ListedDocument, TenderParticulars } from './tenderparticulars.ts';
import { describeQuoteSource, type QuoteSource } from './tendersource.ts';

/**
 * The tender's documents and its dates, in one place.
 *
 * Built from what the platform already holds — the files uploaded to the
 * project, what each read produced, which reading of the pack they went into,
 * the invitation recorded from it and what the pack says about itself — and
 * nothing typed in again. It says what was actually read and how much of it,
 * what the pack lists that was never uploaded, what it refers to that is only on
 * the portal, which document wins when two disagree, and every date with
 * whether it binds or is only indicative, and where two dates cannot both be
 * right.
 */

export type RegisterStatus = 'READ' | 'NOT_READ' | 'UNREADABLE' | 'QUARANTINED';

export type RegisterRow = {
  ingestionId: string;
  filename: string;
  /** What the platform classified it as. */
  kind: string;
  /** As the pack's own schedule lists it, where it does. */
  listedAs?: string;
  revision?: string;
  issuedOn?: string;
  uploadedAt: string;
  status: RegisterStatus;
  /** How much of it was read, in words a person checks against the file. */
  coverage: string;
  /** In the latest reading of the pack. */
  inReading: boolean;
  /** In the text each drafted answer is given. */
  inDrafting: boolean;
  /** Another upload with the same content, or the same document at another revision. */
  duplicateOf?: string;
};

export type DateRow = {
  label: string;
  /** YYYY-MM-DD, or a local date and time with its zone for the deadlines. */
  when: string;
  timeZone?: string;
  kind: 'MANDATORY' | 'INDICATIVE' | 'CONTRACT';
  source: string;
};

export type TenderRegister = {
  rows: RegisterRow[];
  /** Listed in the pack's schedule of documents but not uploaded. */
  listedNotUploaded: Array<{ title: string; source: string }>;
  /** Referred to in the pack but not supplied — on the portal only, or to follow. */
  notSupplied: Array<{ title: string; source: string }>;
  precedence?: { order: string[]; source: string };
  evaluation?: TenderParticulars['evaluation'] & { sourceText: string };
  submission?: TenderParticulars['submission'] & { sourceText: string };
  validity?: { days: number; source: string };
  dates: DateRow[];
  conflicts: string[];
  /** Whether the pack has been read and an invitation recorded from it. */
  read: boolean;
  summary: string;
};

const normal = (value: string): string =>
  value
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** The listed document an uploaded file is, matched on its reference or its title appearing in the file name. */
function listedFor(filename: string, listed: ListedDocument[]): ListedDocument | undefined {
  const name = normal(filename);
  return (
    listed.find((entry) => entry.reference && name.includes(normal(entry.reference))) ??
    listed.find((entry) => normal(entry.title).length >= 6 && name.includes(normal(entry.title)))
  );
}

function coverageOf(file: IngestedFileState): string {
  const extraction = file.extraction as { method?: string; text?: string; pages?: number; pageStarts?: unknown[]; reason?: string; note?: string };
  if (file.status === 'QUARANTINED') return 'Quarantined on upload — not opened';
  if (extraction.method === 'NEEDS_OCR') return `No text layer: ${extraction.pages ?? '?'} page(s) need a model that can see them`;
  if (extraction.method === 'UNSUPPORTED') return extraction.reason ?? 'Not a format this platform reads';
  const characters = (extraction.text ?? '').length;
  const pages = extraction.pages;
  const textPages = Array.isArray(extraction.pageStarts) ? extraction.pageStarts.length : undefined;
  const pageNote =
    pages !== undefined && textPages !== undefined
      ? textPages === pages
        ? `all ${pages} pages`
        : `${textPages} of ${pages} pages carry text; the rest are images only`
      : pages !== undefined
        ? `${pages} pages`
        : undefined;
  return [`${Math.round(characters / 100) / 10}k characters`, pageNote].filter(Boolean).join(', ');
}

const cited = (source: QuoteSource | undefined): string => (source ? describeQuoteSource(source) : 'as recorded on the invitation');

export function tenderRegister(ctx: EngineContext): TenderRegister {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const files = ctx.ledger
    .list(ctx.projectId, 'IngestedFile')
    .map((record) => record.state as unknown as IngestedFileState)
    .sort((a, b) => a.ingestedAt.localeCompare(b.ingestedAt));

  // The invitation on this project and the matrix bound to it.
  // Filed at the company, against the pursuit linked to this project — found the
  // way confirming a reading finds it.
  const pursuits = new Set(
    ctx.ledger
      .listByTenant(ctx.tenantId, 'Opportunity')
      .map((record) => record.state)
      .filter((state) => String(state.projectId ?? '') === ctx.projectId || String(state.convertedProjectId ?? '') === ctx.projectId)
      .map((state) => String(state.id)),
  );
  const invitation = ctx.ledger
    .listByTenant(ctx.tenantId, 'TenderInvitation')
    .map((record) => record.state)
    .filter((state) => pursuits.has(String(state.opportunityId ?? '')))
    .at(-1);
  const analysisId = invitation?.analysisId as string | undefined;
  const analysis = analysisId ? ctx.ledger.get({ refType: 'ITTAnalysis', refId: analysisId }) : undefined;
  const particulars = (analysis && analysis.tenantId === ctx.tenantId ? analysis.state.particulars : undefined) as TenderParticulars | undefined;
  const listed = particulars?.documentsListed ?? [];

  // The latest reading of the whole pack, and the files it took in.
  const reading = ctx.ledger
    .list(ctx.projectId, 'PerceptionDraft')
    .map((record) => record.state)
    .filter((state) => state.task === 'ITT_REQUIREMENTS' && Array.isArray(state.packFiles))
    .at(-1);
  const readIds = new Set(((reading?.packFiles as Array<{ ingestionId: string }> | undefined) ?? []).map((file) => file.ingestionId));
  const drafting = packText(ctx, { maxCharacters: DRAFTING_PACK_MAX });
  const draftIds = new Set(drafting.files.map((file) => file.ingestionId));

  const seenHashes = new Map<string, string>();
  const seenListed = new Map<string, string>();
  const rows = files.map((file): RegisterRow => {
    const filename = file.filename ?? file.hash.slice(0, 12);
    const extraction = file.extraction as { method?: string; text?: string };
    const hasText = typeof extraction.text === 'string' && extraction.text.trim() !== '';
    const match = listedFor(filename, listed);
    const status: RegisterStatus =
      file.status === 'QUARANTINED' ? 'QUARANTINED' : !hasText ? 'UNREADABLE' : readIds.has(file.ingestionId) ? 'READ' : 'NOT_READ';
    const listedKey = match ? (match.reference ?? match.title).toLowerCase() : undefined;
    const duplicateOf = seenHashes.get(file.hash) ?? (listedKey ? seenListed.get(listedKey) : undefined);
    seenHashes.set(file.hash, filename);
    if (listedKey) seenListed.set(listedKey, filename);
    return {
      ingestionId: file.ingestionId,
      filename,
      kind: String(file.classification?.kind ?? 'UNKNOWN'),
      ...(match ? { listedAs: match.title } : {}),
      ...(match?.revision ? { revision: match.revision } : {}),
      ...(match?.issuedOn ? { issuedOn: match.issuedOn } : {}),
      uploadedAt: file.ingestedAt,
      status,
      coverage: coverageOf(file),
      inReading: readIds.has(file.ingestionId),
      inDrafting: draftIds.has(file.ingestionId),
      ...(duplicateOf ? { duplicateOf } : {}),
    };
  });

  const listedNotUploaded = listed
    .filter((entry) => !files.some((file) => listedFor(file.filename ?? '', [entry])))
    .map((entry) => ({
      // The reference only where the title does not already carry it: "Volume 3 – Drawings", not "Volume 3 Volume 3 – Drawings".
      title: [
        entry.reference && !normal(entry.title).includes(normal(entry.reference)) ? entry.reference : '',
        entry.title,
        entry.revision ? `rev ${entry.revision}` : '',
      ]
        .filter(Boolean)
        .join(' '),
      source: cited(entry.source),
    }));
  const notSupplied = (particulars?.documentsNotSupplied ?? []).map((entry) => ({ title: entry.title, source: cited(entry.source) }));

  // Every date, binding or indicative, with where it comes from.
  const dates: DateRow[] = [];
  const issue = invitation?.issue as
    | { issuedAt?: string; clarificationDeadline?: ZonedInstant; siteVisit?: ZonedInstant; returnDeadline?: ZonedInstant }
    | undefined;
  if (invitation && issue) {
    if (issue.issuedAt) dates.push({ label: 'Invitation issued', when: issue.issuedAt.slice(0, 10), kind: 'INDICATIVE', source: 'as recorded on the invitation' });
    if (issue.clarificationDeadline) {
      dates.push({ label: 'Last date for questions', when: issue.clarificationDeadline.local, timeZone: issue.clarificationDeadline.timeZone, kind: 'MANDATORY', source: 'as recorded on the invitation' });
    }
    if (issue.siteVisit) dates.push({ label: 'Site visit', when: issue.siteVisit.local, timeZone: issue.siteVisit.timeZone, kind: 'INDICATIVE', source: 'as recorded on the invitation' });
    const deadline = deadlineInForce(invitation);
    dates.push({
      label: deadline === issue.returnDeadline ? 'Tender return' : 'Tender return (moved by addendum)',
      when: deadline.local,
      timeZone: deadline.timeZone,
      kind: 'MANDATORY',
      source: 'as recorded on the invitation',
    });
  }
  if (particulars?.awardOn) dates.push({ label: 'Anticipated award', when: particulars.awardOn, kind: 'INDICATIVE', source: 'read from the pack' });
  if (particulars?.worksStartOn) dates.push({ label: 'Works start', when: particulars.worksStartOn, kind: 'CONTRACT', source: 'read from the pack' });
  if (particulars?.worksCompletionOn) dates.push({ label: 'Works completion', when: particulars.worksCompletionOn, kind: 'CONTRACT', source: 'read from the pack' });
  for (const milestone of particulars?.milestones ?? []) {
    dates.push({ label: milestone.label, when: milestone.date, kind: milestone.mandatory ? 'MANDATORY' : 'INDICATIVE', source: cited(milestone.source) });
  }
  dates.sort((a, b) => a.when.localeCompare(b.when));

  // Dates that cannot all be right.
  const conflicts: string[] = [];
  const returnDay = invitation && issue ? deadlineInForce(invitation).local.slice(0, 10) : undefined;
  const questionsDay = issue?.clarificationDeadline?.local.slice(0, 10);
  if (returnDay && questionsDay && questionsDay > returnDay) conflicts.push(`Questions close ${questionsDay}, after the tender returns ${returnDay}.`);
  if (returnDay && particulars?.awardOn && particulars.awardOn < returnDay) conflicts.push(`Award ${particulars.awardOn} is before the tender returns ${returnDay}.`);
  if (particulars?.awardOn && particulars.worksStartOn && particulars.awardOn > particulars.worksStartOn) {
    conflicts.push(`Award ${particulars.awardOn} is after the works start ${particulars.worksStartOn}.`);
  }
  if (particulars?.worksStartOn && particulars.worksCompletionOn && particulars.worksCompletionOn <= particulars.worksStartOn) {
    conflicts.push(`Completion ${particulars.worksCompletionOn} is not after the start ${particulars.worksStartOn}.`);
  }
  if (returnDay && particulars?.tenderValidityDays !== undefined && particulars.worksStartOn) {
    const validTo = new Date(Date.parse(`${returnDay}T00:00:00Z`) + particulars.tenderValidityDays * 86_400_000).toISOString().slice(0, 10);
    if (particulars.awardOn && particulars.awardOn > validTo) {
      conflicts.push(`The tender is valid to ${validTo} (${particulars.tenderValidityDays} days) but award is ${particulars.awardOn}.`);
    }
  }
  for (const milestone of particulars?.milestones ?? []) {
    if (particulars?.worksCompletionOn && milestone.date > particulars.worksCompletionOn && /complet|handover|section/i.test(milestone.label)) {
      conflicts.push(`${milestone.label} ${milestone.date} is after the works completion ${particulars.worksCompletionOn}.`);
    }
  }

  const unreadable = rows.filter((row) => row.status === 'UNREADABLE' || row.status === 'QUARANTINED').length;
  const notRead = rows.filter((row) => row.status === 'NOT_READ').length;
  const summary =
    files.length === 0
      ? 'No tender document has been uploaded to this project.'
      : [
          `${rows.length} document(s) uploaded, ${rows.filter((row) => row.status === 'READ').length} in the latest reading`,
          notRead > 0 ? `${notRead} uploaded since — read the pack again to take them in` : undefined,
          unreadable > 0 ? `${unreadable} could not be read` : undefined,
          listedNotUploaded.length > 0 ? `${listedNotUploaded.length} listed in the pack but not uploaded` : undefined,
          notSupplied.length > 0 ? `${notSupplied.length} referred to but not supplied` : undefined,
          conflicts.length > 0 ? `${conflicts.length} date conflict(s)` : undefined,
        ]
          .filter(Boolean)
          .join('; ') + '.';

  return {
    rows,
    listedNotUploaded,
    notSupplied,
    ...(particulars?.precedence ? { precedence: { order: particulars.precedence.order, source: cited(particulars.precedence.source) } } : {}),
    ...(particulars?.evaluation ? { evaluation: { ...particulars.evaluation, sourceText: cited(particulars.evaluation.source) } } : {}),
    ...(particulars?.submission ? { submission: { ...particulars.submission, sourceText: cited(particulars.submission.source) } } : {}),
    ...(particulars?.tenderValidityDays !== undefined ? { validity: { days: particulars.tenderValidityDays, source: cited(particulars.validitySource) } } : {}),
    dates,
    conflicts,
    read: Boolean(invitation && analysis),
    summary,
  };
}
