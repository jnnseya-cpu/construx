import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
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

/** Every ingested file on the project, newest first. */
export function ingestedFiles(ctx: EngineContext): IngestedFileState[] {
  authorise(ctx, 'EVIDENCE_AUDIT', 'R');
  return filesOf(ctx);
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
  /** Read natively, so their text is searchable and indexed. */
  read: number;
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
    read: files.filter((file) => file.extraction.method === 'NATIVE').length,
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
