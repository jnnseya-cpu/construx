import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { QUANTITY_BASIS, recordItems, type MeasuredItem, type QuantityBasis } from '../domain/measurement.ts';
import { ingestSpecification } from '../engines/bim.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import { findByHash } from './registry.ts';
import { ping, scan, scannerAddress, scannerConfigured } from './scanner.ts';
import type { EvidenceStore } from './store.ts';
import {
  classify,
  extractText,
  inspect,
  lexicalVector,
  similarity,
  type Classification,
  type Extraction,
  type Inspection,
} from './ingest.ts';

/**
 * Running a stored file through the ingestion pipeline, under authorisation,
 * with the result on the record.
 *
 * `ingest.ts` holds the stages as pure functions — bytes in, findings out, no
 * ledger and no context — because that is what makes them testable against a
 * malformed file without constructing a project first. This module is the
 * governed half: who may run it, what it writes, and what it refuses.
 *
 * ---
 *
 * **Ingestion is not upload.** The bytes are already stored and the hash is
 * already in the chain by the time this runs; `store.ts` refused anything whose
 * hash did not match long before. What this adds is knowing *what the file is*
 * — and the honest possibility that the answer is "something that should not
 * have been accepted".
 *
 * **A quarantined file is not deleted.** The record is append-only and the
 * bytes are already an address something else may reference. Quarantine is a
 * state on the ingestion record that says nothing downstream should read this
 * and why; deleting the object would leave a hash in the chain pointing at
 * nothing, which is the failure the evidence register exists to report on.
 *
 * **Re-ingesting is refused rather than repeated.** A file is the same bytes at
 * the same hash for ever, so a second run can only produce the same answer or a
 * different one — and a different one means the pipeline changed, which is a
 * fact worth a new version rather than an overwrite of the old finding.
 */

export type IngestedFileState = {
  ingestionId: string;
  projectId: string;
  /** The evidence hash. One ingestion per hash per project. */
  hash: string;
  evidenceId: string;
  filename?: string;
  inspection: Inspection;
  classification: Classification;
  extraction: Extraction;
  /** Lexical, not semantic — see `ingest.ts`. Absent where no text was read. */
  lexicalVector?: number[];
  status: 'INGESTED' | 'QUARANTINED';
  ingestedBy: string;
  ingestedAt: string;
};

function filesOf(ctx: EngineContext): IngestedFileState[] {
  return ctx.ledger
    .list(ctx.projectId, 'IngestedFile')
    .map((record) => record.state as unknown as IngestedFileState)
    .sort((a, b) => (a.ingestedAt < b.ingestedAt ? 1 : -1));
}

/**
 * Run a stored file through the pipeline and record what it is.
 *
 * `I` rather than `R`, which is what the register's other acting command —
 * discarding an orphaned object — already takes. Reading the register is a read;
 * producing a governed statement that a file is a specification, or that it is a
 * renamed executable nothing downstream should touch, is an act on the evidence
 * store. Gating it on `R` would have let every role in the platform write to the
 * ledger, because every role can read the register.
 */
export async function ingestFile(
  ctx: EngineContext,
  // Passed rather than carried on the context, matching `perception.extract`.
  // The store is a platform resource, not a property of one request, and
  // putting it on the context would give every engine a handle on every
  // tenancy's files whether it needed one or not.
  store: EvidenceStore,
  input: { hash: string; filename?: string },
): Promise<{ ingestionId: string; status: IngestedFileState['status']; kind: string; findings: number }> {
  authorise(ctx, 'EVIDENCE_AUDIT', 'I');

  const record = findByHash(ctx.ledger, ctx.tenantId, input.hash);
  if (!record) {
    throw new DomainError(
      'NO_EVIDENCE_RECORD',
      'Nothing in this tenancy has claimed that hash as evidence, so there is no document to ingest.',
      404,
    );
  }
  if (!(await store.holds(ctx.tenantId, input.hash))) {
    throw new DomainError(
      'BYTES_NOT_HELD',
      'The platform holds the hash and not the file. There is nothing to inspect — the original is with whoever ' +
        'captured it, which the evidence register already reports.',
      409,
    );
  }

  const already = filesOf(ctx).find((file) => file.hash === input.hash);
  if (already) {
    throw new DomainError(
      'ALREADY_INGESTED',
      `${input.hash} was ingested on ${already.ingestedAt.slice(0, 10)} and read as a ${already.classification.kind}. ` +
        'The same bytes cannot produce a different document, so re-running would either repeat the answer or ' +
        'quietly replace a finding somebody may have acted on.',
      409,
    );
  }

  const { bytes, contentType } = await store.fetch(ctx.tenantId, input.hash);

  // Stage 1. Before anything else looks at the file, including this pipeline.
  const inspection = inspect({ bytes, declaredType: contentType, filename: input.filename });

  // Stage 1b. The signature scan, where this deployment has a scanner beside it.
  //
  // Structural inspection and signature scanning catch different things and
  // both are on the record: a signature engine knows about a virus in a
  // document and does not care that a `.png` is a Windows executable, which is
  // the threat that actually applies to an evidence store.
  //
  // `scan` throws where a scanner is configured and will not answer, and that
  // propagates deliberately. Recording the file as ingested with
  // `antivirusScanned: false` would leave it in the register looking checked,
  // and the operator who configured the scanner would never learn it had
  // stopped responding.
  const verdict = await scan(bytes);
  if (verdict.scanned) {
    inspection.antivirusScanned = true;
    inspection.antivirusScanner = verdict.scanner;
    if (!verdict.clean) {
      inspection.antivirusSignature = verdict.signature;
      inspection.verdict = 'BLOCKED';
      inspection.findings.push({
        what: `The scanner identified ${verdict.signature}`,
        because:
          `Reported by ${verdict.scanner}. Recorded by name rather than as "infected": a quarantine record that ` +
          'will not say what was found is one nobody can act on or argue with.',
      });
    }
  }

  // Stage 3 before stage 2 in execution order, and deliberately: the classifier
  // reads the extracted text where there is any, and a filename alone is a
  // guess. Nothing is extracted from a blocked file — a decompression bomb is
  // not made safe by being classified first.
  const extraction: Extraction =
    inspection.verdict === 'BLOCKED'
      ? { method: 'UNSUPPORTED', reason: 'The file was quarantined; nothing was read from it.' }
      : extractText(bytes, inspection.actualType);

  const classification: Classification =
    inspection.verdict === 'BLOCKED'
      ? { kind: 'UNKNOWN', confidence: 0, signals: ['the file was quarantined before it was classified'], method: 'RULES' }
      : classify({ filename: input.filename, actualType: inspection.actualType, text: extraction.text });

  const ingestionId = ulid();
  const status: IngestedFileState['status'] = inspection.verdict === 'BLOCKED' ? 'QUARANTINED' : 'INGESTED';

  // Three events, and each carries state the one before it did not — a second
  // event repeating the first is refused by the ledger, and rightly: an event
  // whose diff is empty records nothing.
  //
  // So `FILE_INGESTED` says what the file is and what came of trying to read it;
  // `FILE_EXTRACTED` adds what actually came out, which only exists where the
  // bytes were the text; `FILE_QUARANTINED` is the change of status, which is
  // the fact anything downstream reads.
  const ingested: IngestedFileState = {
    ingestionId,
    projectId: ctx.projectId,
    hash: input.hash,
    evidenceId: record.refId,
    ...(input.filename ? { filename: input.filename } : {}),
    inspection,
    classification,
    // The attempt, without its product. `NEEDS_OCR` is the whole answer for a
    // scan or a photograph and there is no second event for it.
    extraction: { method: extraction.method, ...(extraction.reason ? { reason: extraction.reason } : {}) },
    status: 'INGESTED',
    ingestedBy: ctx.auth.actorId,
    ingestedAt: new Date().toISOString(),
  };

  write(ctx, {
    eventType: 'FILE_INGESTED',
    entity: { refType: 'IngestedFile', refId: ingestionId },
    nextState: ingested as unknown as Record<string, unknown>,
  });

  if (status === 'QUARANTINED') {
    write(ctx, {
      eventType: 'FILE_QUARANTINED',
      entity: { refType: 'IngestedFile', refId: ingestionId },
      nextState: { ...ingested, status: 'QUARANTINED' } as unknown as Record<string, unknown>,
    });
  } else if (extraction.text !== undefined) {
    write(ctx, {
      eventType: 'FILE_EXTRACTED',
      entity: { refType: 'IngestedFile', refId: ingestionId },
      nextState: {
        ...ingested,
        extraction,
        lexicalVector: lexicalVector(extraction.text),
      } as unknown as Record<string, unknown>,
    });
  }

  return {
    ingestionId,
    status,
    kind: classification.kind,
    findings: inspection.findings.length,
  };
}

/**
 * Record what a model read from a file the bytes could not be read from.
 *
 * The other half of `NEEDS_OCR`. Ingestion says a scan has no text layer; the
 * perception pipeline shows the file to a provider that can see and writes a
 * draft; a person confirms the draft; and *this* is what confirming runs — the
 * same `FILE_EXTRACTED` event a native read writes, so everything downstream
 * that indexes or searches text finds it in one place, with `method: 'OCR'`
 * and the provider, the confirmer and the draft on the record. The
 * classification is re-run over the text, because the one made at ingestion
 * had only a filename to go on.
 *
 * Refused where the file was never ingested (the scan has not been looked at
 * for what it is), is quarantined, or was already read — a second reading of
 * bytes that already have text would replace a finding somebody may have used.
 */
export function recordModelReading(
  ctx: EngineContext,
  input: { hash: string; pages: Array<{ page: number; text: string }>; readBy: string; draftId: string },
): { ingestionId: string; pages: number; characters: number; kind: string } {
  authorise(ctx, 'EVIDENCE_AUDIT', 'I');

  const file = filesOf(ctx).find((entry) => entry.hash === input.hash);
  if (!file) {
    throw new DomainError(
      'NOT_INGESTED',
      'This file has not been through ingestion, so nothing has said what it is. Read it there first; the model’s ' +
        'transcription is filed against that record.',
      409,
    );
  }
  if (file.status === 'QUARANTINED') {
    throw new DomainError('FILE_QUARANTINED', 'The file is quarantined. Nothing downstream reads it, and that includes a transcription of it.', 409);
  }
  if (file.extraction.method === 'OCR' || (file.extraction.method === 'NATIVE' && !file.extraction.note)) {
    throw new DomainError(
      'ALREADY_READ',
      file.extraction.method === 'OCR'
        ? 'A confirmed transcription is already on this record. A second one would replace text somebody may have searched.'
        : 'Its text layer was read from the bytes themselves; a model has nothing to add to it.',
      409,
    );
  }

  const pages = [...input.pages].sort((a, b) => a.page - b.page).filter((page) => page.text.trim() !== '');
  const text = pages.map((page) => page.text.trim()).join('\n\n');
  if (text === '') {
    throw new DomainError('NOTHING_READ', 'The transcription carries no text, so there is nothing to record.');
  }

  const extraction: Extraction = {
    method: 'OCR',
    text,
    pages: pages.length,
    note: `Transcribed by ${input.readBy} and confirmed by ${ctx.auth.actorId} from draft ${input.draftId}.`,
  };
  const classification = classify({
    ...(file.filename ? { filename: file.filename } : {}),
    actualType: file.inspection.actualType,
    text,
  });

  write(ctx, {
    eventType: 'FILE_EXTRACTED',
    entity: { refType: 'IngestedFile', refId: file.ingestionId },
    nextState: {
      ...file,
      extraction,
      classification,
      lexicalVector: lexicalVector(text),
    } as unknown as Record<string, unknown>,
  });

  return { ingestionId: file.ingestionId, pages: pages.length, characters: text.length, kind: classification.kind };
}

/** Every ingested file on the project, newest first. */
export function ingestedFiles(ctx: EngineContext): IngestedFileState[] {
  authorise(ctx, 'EVIDENCE_AUDIT', 'R');
  return filesOf(ctx);
}

// --- What was read, put to use ----------------------------------------------

/** An ingested file whose text is on the record, or the reason it is not. */
function readFile(ctx: EngineContext, ingestionId: string): IngestedFileState & { extraction: Extraction & { text: string } } {
  const file = filesOf(ctx).find((entry) => entry.ingestionId === ingestionId);
  if (!file) throw new DomainError('INGESTION_NOT_FOUND', `No ingested file ${ingestionId} on this project`, 404);
  if (file.status === 'QUARANTINED') {
    throw new DomainError('FILE_QUARANTINED', `${file.filename ?? file.hash} was quarantined; nothing downstream reads it.`, 409);
  }
  if (file.extraction.text === undefined) {
    throw new DomainError(
      'FILE_NOT_READ',
      file.extraction.method === 'NEEDS_OCR'
        ? `${file.filename ?? file.hash} has no text layer. Transcribe it with a model on the Documents screen and confirm the transcription first.`
        : `${file.filename ?? file.hash} was not read as text: ${file.extraction.reason ?? file.extraction.method}.`,
      409,
    );
  }
  return file as IngestedFileState & { extraction: Extraction & { text: string } };
}

/**
 * Read a specification section straight from the file it arrived in.
 *
 * The clause register was fed by pasting text: ingestion read the PDF, a person
 * copied the words out and supplied them back with the file's hash typed in.
 * This is that in one step — the text is the ingestion record's, the document
 * hash is the file's, and what runs is the same reading (`ingestSpecification`)
 * with the same refusals, the same charge and the same clause records.
 */
export async function specificationFromFile(
  ctx: EngineContext,
  input: { ingestionId: string; sectionRef: string; title: string; revision: string },
): Promise<Awaited<ReturnType<typeof ingestSpecification>> & { ingestionId: string; documentHash: string }> {
  const file = readFile(ctx, input.ingestionId);
  const result = await ingestSpecification(ctx, {
    sectionRef: input.sectionRef,
    title: input.title,
    revision: input.revision,
    specificationText: file.extraction.text,
    documentHash: file.hash,
    source: 'INGESTED_FILE',
  });
  return { ...result, ingestionId: file.ingestionId, documentHash: file.hash };
}

export type BillImport = {
  scheduleId: string;
  /** Items written to the schedule from this table. */
  recorded: number;
  /** Rows that were not items, with the reason: a section heading, a blank quantity, a figure that is not one. */
  skipped: Array<{ row: number; reason: string }>;
  /** Which recovered column stood for which field. */
  columns: { reference?: string; description: string; unit: string; quantity: string };
  /** The schedule after the import. */
  total: number;
  findings: ReturnType<typeof recordItems>['findings'];
};

const REFERENCE_HEADING = /^(item|item\s*(no|ref|reference)\.?|ref\.?|reference|no\.?|number|code|clause)$/i;
const DESCRIPTION_HEADING = /descr|particular|work|scope/i;
const UNIT_HEADING = /^unit/i;
const QUANTITY_HEADING = /^(qty|quant)/i;

/**
 * A recovered table's rows as measured items on a schedule.
 *
 * The columns are found by their headings, not their positions: a bill puts
 * the item reference first and the quantity fourth, a schedule of rates the
 * other way about, and both are read. Description, unit and quantity are
 * required — without them the rows are not a bill — and a reference column is
 * used where there is one, else the row number stands in. A row with no
 * quantity, or a quantity that is not a figure, is a heading or a note and is
 * skipped with the reason rather than recorded as zero. Nothing is priced:
 * a rate column, where the bill carries one, is left where it is, because a
 * rate typed in is exactly what `priceItem` refuses.
 *
 * Every item's source is the document: the file's hash, the page and the
 * table, so a line can be checked against the bill it came from.
 */
export function measureFromTable(
  ctx: EngineContext,
  input: { ingestionId: string; table: number; scheduleId: string; basis?: QuantityBasis },
): BillImport {
  const file = readFile(ctx, input.ingestionId);
  const tables = file.extraction.pageTables ?? (file.extraction.tables ? [{ page: 1, rows: file.extraction.tables }] : []);
  const found = tables[input.table - 1];
  if (!found) {
    throw new DomainError(
      'TABLE_NOT_FOUND',
      tables.length === 0
        ? `${file.filename ?? file.hash} has no table recovered from it.`
        : `${file.filename ?? file.hash} has ${tables.length} table${tables.length === 1 ? '' : 's'}; there is no table ${input.table}.`,
      404,
    );
  }
  const basis = input.basis ?? 'MEASURED';
  if (!QUANTITY_BASIS.includes(basis)) {
    throw new DomainError('BASIS_INVALID', `A quantity's basis is one of ${QUANTITY_BASIS.join(', ')}.`);
  }
  if (basis === 'ALLOWANCE') {
    throw new DomainError('BASIS_INVALID', 'A bill row is a measured quantity somebody wrote down, not an allowance. Record an allowance on the schedule itself, with who authorised it.');
  }

  const [header = [], ...body] = found.rows;
  const headings = header.map((cell) => cell.trim());
  const indexOf = (pattern: RegExp, taken: number[]): number => headings.findIndex((cell, index) => !taken.includes(index) && pattern.test(cell));
  const description = indexOf(DESCRIPTION_HEADING, []);
  const reference = indexOf(REFERENCE_HEADING, [description]);
  const unit = indexOf(UNIT_HEADING, [description, reference]);
  const quantity = indexOf(QUANTITY_HEADING, [description, reference, unit]);
  if (description < 0 || unit < 0 || quantity < 0) {
    const missing = [description < 0 ? 'a description' : '', unit < 0 ? 'a unit' : '', quantity < 0 ? 'a quantity' : ''].filter(Boolean);
    throw new DomainError(
      'TABLE_NOT_A_BILL',
      `Table ${input.table} on page ${found.page} is headed ${headings.map((cell) => `"${cell}"`).join(', ')}; no column reads as ${missing.join(', ')}. ` +
        'A bill has a description, a unit and a quantity per row.',
      422,
    );
  }

  const items: MeasuredItem[] = [];
  const skipped: BillImport['skipped'] = [];
  body.forEach((row, index) => {
    const rowNumber = index + 2;
    const text = (at: number): string => (row[at] ?? '').trim();
    const rawQuantity = text(quantity).replace(/,/g, '').replace(/\s+/g, '');
    if (text(description) === '' && rawQuantity === '') {
      skipped.push({ row: rowNumber, reason: 'blank row' });
      return;
    }
    if (rawQuantity === '') {
      skipped.push({ row: rowNumber, reason: `no quantity — a heading or a note: "${text(description).slice(0, 60)}"` });
      return;
    }
    const figure = Number(rawQuantity);
    if (!Number.isFinite(figure)) {
      skipped.push({ row: rowNumber, reason: `"${text(quantity)}" is not a figure` });
      return;
    }
    if (text(description) === '') {
      skipped.push({ row: rowNumber, reason: 'a quantity with no description' });
      return;
    }
    const ref = reference >= 0 ? text(reference) : '';
    items.push({
      reference: ref !== '' ? ref : `R${rowNumber}`,
      description: text(description),
      unit: text(unit) || '—',
      quantity: figure,
      basis,
      source: { document: file.hash, page: found.page, sheet: `Table ${input.table}` },
    });
  });
  if (items.length === 0) {
    throw new DomainError(
      'TABLE_HAS_NO_ITEMS',
      `Table ${input.table} on page ${found.page} has ${body.length} row${body.length === 1 ? '' : 's'} and none with a description and a figure for a quantity.`,
      422,
    );
  }

  const written = recordItems(ctx, input.scheduleId, items);
  return {
    scheduleId: input.scheduleId,
    recorded: items.length,
    skipped,
    columns: {
      ...(reference >= 0 ? { reference: headings[reference]! } : {}),
      description: headings[description]!,
      unit: headings[unit]!,
      quantity: headings[quantity]!,
    },
    total: written.total,
    findings: written.findings,
  };
}

export type SimilarFile = {
  ingestionId: string;
  hash: string;
  filename?: string;
  kind: string;
  /** Cosine, 0–1. Lexical overlap, not meaning. */
  similarity: number;
};

/**
 * Other documents that read like this one.
 *
 * **Lexical**, and the threshold says so. What this reliably finds is the
 * near-duplicate: the same specification uploaded twice under different names,
 * revision C beside revision B, the letter that quotes the clause. What it does
 * not find is a document that means the same thing in other words.
 *
 * 0.6 is the floor because below it the matches are shared vocabulary rather
 * than shared content — every document on a project says "the contractor
 * shall".
 */
export function similarFiles(ctx: EngineContext, ingestionId: string, threshold = 0.6): SimilarFile[] {
  authorise(ctx, 'EVIDENCE_AUDIT', 'R');

  const all = filesOf(ctx);
  const subject = all.find((file) => file.ingestionId === ingestionId);
  if (!subject) throw new DomainError('NO_SUCH_INGESTION', `No ingested file ${ingestionId} on this project`, 404);
  if (!subject.lexicalVector) {
    throw new DomainError(
      'NOTHING_INDEXED',
      'No text was read from this file, so there is nothing to compare. A scan or a photograph needs the ' +
        'perception pipeline to read it first.',
      409,
    );
  }

  return all
    .filter((file) => file.ingestionId !== ingestionId && file.lexicalVector && file.status === 'INGESTED')
    .map((file) => ({
      ingestionId: file.ingestionId,
      hash: file.hash,
      ...(file.filename ? { filename: file.filename } : {}),
      kind: file.classification.kind,
      similarity: similarity(subject.lexicalVector!, file.lexicalVector!),
    }))
    .filter((match) => match.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity);
}

export type IngestionPosition = {
  total: number;
  quarantined: number;
  /** Held but never looked at — the queue this pipeline exists to empty. */
  notIngested: number;
  /** Read — natively or by a confirmed model transcription — so their text is searchable and indexed. */
  read: number;
  /** Of those, transcribed by a model and confirmed by a person rather than read from the bytes. */
  readByModel: number;
  /** Needing a model that can see. Zero where no multimodal provider is set. */
  awaitingOcr: number;
  byKind: Record<string, number>;
  /** Every quarantined file with what was found, newest first. */
  quarantine: Array<{
    ingestionId: string;
    hash: string;
    filename?: string;
    findings: Array<{ what: string; because: string }>;
  }>;
  /**
   * Whether this deployment has a signature scanner beside it.
   *
   * Said on every read, because with it false a screen reporting "0
   * quarantined" must not be read as "nothing infected" — nothing looked. With
   * it true, `antivirusScanner` names the daemon and its database, because
   * "clean" against a database from 2019 is a different statement from "clean"
   * against today's.
   */
  antivirusConfigured: boolean;
  /** Where it is, and whether it answered just now. Absent where none is set. */
  antivirusScanner?: string;
  antivirusReachable?: boolean;
  /** Held files read before a scanner was configured. They were never scanned. */
  ingestedUnscanned: number;
};

/**
 * What the project holds, what has been read, and what was refused.
 *
 * `notIngested` is the number that matters on a project part way through
 * adopting this: it is the evidence the platform holds and has never looked at.
 */
export async function ingestionPosition(ctx: EngineContext, store: EvidenceStore): Promise<IngestionPosition> {
  authorise(ctx, 'EVIDENCE_AUDIT', 'R');

  // Asked at read time rather than remembered from boot. A scanner that has
  // stopped answering is the thing an operator most needs to see on this
  // screen, and a cached "configured: true" would hide exactly that.
  const scanner = await ping();

  const files = filesOf(ctx);
  const ingested = new Set(files.map((file) => file.hash));

  // Evidence the platform holds the *bytes* for, not evidence it holds a hash
  // for. The distinction is the whole point of this figure: a hash with no file
  // behind it has never been read and never can be.
  //
  // Asked of the store one hash at a time, in parallel, because with an object
  // store each answer is a round trip. Bounded by the number of evidence items
  // on one project, which is the same set that was walked synchronously before.
  const recorded = ctx.ledger
    .list(ctx.projectId, 'EvidenceItem')
    .map((record) => String((record.state as { hash?: string }).hash ?? ''))
    .filter((hash) => hash !== '');
  const presence = await Promise.all(recorded.map((hash) => store.holds(ctx.tenantId, hash)));
  const held = recorded.filter((_hash, index) => presence[index]);

  const byKind: Record<string, number> = {};
  for (const file of files) {
    if (file.status !== 'INGESTED') continue;
    byKind[file.classification.kind] = (byKind[file.classification.kind] ?? 0) + 1;
  }

  return {
    total: files.length,
    quarantined: files.filter((file) => file.status === 'QUARANTINED').length,
    notIngested: held.filter((hash) => !ingested.has(hash)).length,
    read: files.filter((file) => file.extraction.method === 'NATIVE' || file.extraction.method === 'OCR').length,
    readByModel: files.filter((file) => file.extraction.method === 'OCR').length,
    awaitingOcr: files.filter((file) => file.extraction.method === 'NEEDS_OCR').length,
    byKind,
    quarantine: files
      .filter((file) => file.status === 'QUARANTINED')
      .map((file) => ({
        ingestionId: file.ingestionId,
        hash: file.hash,
        ...(file.filename ? { filename: file.filename } : {}),
        findings: file.inspection.findings,
      })),
    antivirusConfigured: scannerConfigured(),
    ...(scannerConfigured()
      ? { antivirusScanner: `${scannerAddress()} — ${scanner.reachable ? scanner.version : scanner.reason}`, antivirusReachable: scanner.reachable }
      : {}),
    // Files read before a scanner was configured. They are ingested and they
    // were never scanned, and the count says so rather than letting a newly
    // configured scanner imply the whole register has been checked.
    ingestedUnscanned: files.filter((file) => file.inspection.antivirusScanned !== true).length,
  };
}
