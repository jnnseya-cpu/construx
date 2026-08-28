import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { EvidenceStore, hashBytes } from '../src/evidence/store.ts';
import {
  classify,
  extractText,
  inspect,
  lexicalVector,
  similarity,
  sniffType,
  VECTOR_DIMENSIONS,
} from '../src/evidence/ingest.ts';
import { ingestFile, ingestedFiles, ingestionPosition, similarFiles } from '../src/evidence/pipeline.ts';
import { registerEvidence, type EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Knowing what a held file actually is.
 *
 * The evidence store already refused anything whose bytes did not hash to the
 * address it was stored at. What it never did was look at the file: a Windows
 * executable renamed `site-photo.png` hashed correctly, stored correctly, and
 * sat in the register looking exactly like a photograph.
 *
 * The assertions that carry the weight are the refusals, and the naming is part
 * of the test rather than incidental to it. `antivirusScanned` is asserted false
 * on every path, because a deployment reading `0 quarantined` as "nothing
 * infected" would be believing something nobody checked. The classifier is
 * asserted to say `RULES`. The vector is asserted to be lexical by finding a
 * paraphrase it *fails* to match — the overclaim is the defect, not the miss.
 */

// A minimal but real PNG header, so the sniffer is reading bytes rather than a
// string somebody wrote to make a test pass.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function png(): Buffer {
  return Buffer.concat([PNG_MAGIC, Buffer.from('IHDR and then some image data')]);
}

/** The EICAR test string, assembled so this file is not itself flagged. */
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR', 'STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join('-');

/**
 * A ZIP local file header, hand-built.
 *
 * `PK`, twenty-two bytes to the declared uncompressed size, then the
 * name length, the extra length and the name. Written by hand because the point
 * of the check is that nothing is decompressed — a real archive library would
 * be testing the library.
 */
function zip(entries: Array<{ name: string; uncompressed: number }>): Buffer {
  const parts = entries.map((entry) => {
    const name = Buffer.from(entry.name, 'utf8');
    const header = Buffer.alloc(30);
    header.write('PK', 0, 'latin1');
    header.writeUInt32LE(entry.uncompressed, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    return Buffer.concat([header, name]);
  });
  return Buffer.concat(parts);
}

describe('inspection reads the bytes, not the label on them', () => {
  it('identifies a format from its magic number', () => {
    assert.equal(sniffType(png()), 'image/png');
    assert.equal(sniffType(Buffer.from('%PDF-1.7\nstuff')), 'application/pdf');
    assert.equal(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
    assert.equal(sniffType(Buffer.from('Clause 4.1 — the contractor shall')), 'text/plain');
  });

  it('does not mistake any RIFF container for a WebP image', () => {
    const notWebp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI ')]);
    assert.equal(sniffType(notWebp), undefined);
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
    assert.equal(sniffType(webp), 'image/webp');
  });

  it('refuses a Windows executable renamed as a photograph', () => {
    // The whole reason this pipeline exists. The hash is honest, the store is
    // honest, and the file is a program.
    const result = inspect({
      bytes: Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.from('this is a PE binary')]),
      declaredType: 'image/png',
      filename: 'site-photo.png',
    });
    assert.equal(result.verdict, 'BLOCKED');
    assert.match(result.findings.map((finding) => finding.what).join(' '), /Windows executable/);
    // And it says why refusing it matters, not only that it was refused.
    assert.match(result.findings[0]!.because, /Nothing in it should be a program/);
  });

  it('refuses ELF, Mach-O and Java class images too', () => {
    for (const magic of [
      [0x7f, 0x45, 0x4c, 0x46],
      [0xfe, 0xed, 0xfa, 0xce],
      [0xcf, 0xfa, 0xed, 0xfe],
      [0xca, 0xfe, 0xba, 0xbe],
    ]) {
      const result = inspect({
        bytes: Buffer.concat([Buffer.from(magic), Buffer.from('payload')]),
        declaredType: 'application/octet-stream',
      });
      assert.equal(result.verdict, 'BLOCKED', `magic ${magic.join(',')} should be refused`);
    }
  });

  it('quarantines the EICAR test string, which is the point of it', () => {
    // Harmless by construction, and the one string every scanner agrees on. An
    // operator uploads it to prove the quarantine path is wired up at all — so
    // it has to actually be quarantined.
    const result = inspect({ bytes: Buffer.from(EICAR), declaredType: 'text/plain', filename: 'eicar.txt' });
    assert.equal(result.verdict, 'BLOCKED');
    assert.match(result.findings.map((finding) => finding.what).join(' '), /EICAR/);
  });

  it('refuses active content in a document, and does not go looking for it in a JPEG', () => {
    const blocked = inspect({
      bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/v1/me")</script></svg>'),
      declaredType: 'image/svg+xml',
      filename: 'logo.svg',
    });
    assert.equal(blocked.verdict, 'BLOCKED');
    assert.match(blocked.findings.map((finding) => finding.what).join(' '), /markup that executes/);

    // The same byte sequence inside image entropy is not a threat, and treating
    // it as one would quarantine real site photography.
    const photo = Buffer.concat([PNG_MAGIC, Buffer.from('<script> as raw entropy, not markup')]);
    assert.equal(inspect({ bytes: photo, declaredType: 'image/png' }).verdict, 'PASSED');
  });

  it('refuses an archive carrying an executable, without decompressing it', () => {
    const bytes = zip([
      { name: 'xl/workbook.xml', uncompressed: 4_000 },
      { name: 'invoice.exe', uncompressed: 90_000 },
    ]);
    const result = inspect({
      bytes,
      declaredType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: 'valuation.xlsx',
    });
    assert.equal(result.verdict, 'BLOCKED');
    assert.match(result.findings.map((finding) => finding.what).join(' '), /invoice\.exe/);
  });

  it('refuses a decompression bomb on the ratio the archive itself declares', () => {
    const bytes = zip([{ name: 'programme.xml', uncompressed: 900_000_000 }]);
    const result = inspect({ bytes, declaredType: 'application/zip', filename: 'programme.zip' });
    assert.equal(result.verdict, 'BLOCKED');
    assert.match(result.findings.map((finding) => finding.because).join(' '), /decompression bomb/);
    // Nothing was expanded to reach that conclusion, which is the only safe way
    // to reach it. The evidence is that the buffer is tiny.
    assert.ok(bytes.length < 1024);
  });

  it('accepts an xlsx honestly declared, because a zip is what an xlsx is', () => {
    const bytes = zip([{ name: 'xl/worksheets/sheet1.xml', uncompressed: 8_000 }]);
    const result = inspect({
      bytes,
      declaredType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: 'boq.xlsx',
    });
    assert.equal(result.verdict, 'PASSED');
    assert.equal(result.actualType, 'application/zip');
  });

  it('holds an unrecognised format rather than refusing it', () => {
    // An IFC, a Revit model or a proprietary schedule is a legitimate record
    // this pipeline cannot open. Refusing it would lose real evidence.
    const result = inspect({
      bytes: Buffer.from([0x00, 0x01, 0x02, 0x03, 0x1f, 0x00, 0x7f, 0x05]),
      declaredType: 'application/octet-stream',
      filename: 'model.rvt',
    });
    assert.equal(result.verdict, 'UNRECOGNISED');
    assert.match(result.findings[0]!.because, /Stored and held/);
  });

  it('refuses an empty file', () => {
    const result = inspect({ bytes: Buffer.alloc(0), declaredType: 'application/pdf' });
    assert.equal(result.verdict, 'BLOCKED');
    assert.equal(result.bytes, 0);
  });

  it('never claims a virus scan happened', () => {
    for (const bytes of [png(), Buffer.from(EICAR), Buffer.alloc(0)]) {
      assert.equal(inspect({ bytes, declaredType: 'image/png' }).antivirusScanned, false);
    }
  });
});

describe('classification is rules, and the record says so', () => {
  it('reads a specification from its filename and its language together', () => {
    const result = classify({
      filename: 'E10-specification.txt',
      actualType: 'text/plain',
      text: 'Clause 4 Workmanship. Concrete shall be placed to the approval of the Engineer.',
    });
    assert.equal(result.kind, 'SPECIFICATION');
    assert.equal(result.method, 'RULES');
    // Two independent signals agreed, so the confidence reflects two — it is a
    // count of agreement, never a self-report.
    assert.ok(result.confidence > 0.5 && result.confidence <= 0.9);
    assert.equal(result.signals.length, 2);
    // The signals are sentences a project manager can read. Published as the
    // patterns themselves they said `the filename matches
    // /(spec|specification|nbs)/i` on a screen — true, and useless to everybody
    // the classification is for.
    for (const signal of result.signals) {
      assert.equal(/\/[gimsuy]*$|\\b|\\s|\[a-z/.test(signal), false, `signal leaks a pattern: ${signal}`);
    }
  });

  it('never reports more confidence than rules can support', () => {
    const result = classify({
      filename: 'contract-jct-agreement-nec-fidic-subcontract.txt',
      actualType: 'text/plain',
      text: 'The Employer and the Contractor shall. Liquidated damages under clause 2.32 apply.',
    });
    assert.ok(result.confidence <= 0.9, `confidence was ${result.confidence}`);
  });

  it('calls an image a photograph, and says what it knows nothing about', () => {
    assert.equal(classify({ actualType: 'image/jpeg', filename: 'DSC_0041.jpg' }).kind, 'PHOTOGRAPH');
    const blank = classify({ filename: 'file' });
    assert.equal(blank.kind, 'UNKNOWN');
    assert.equal(blank.confidence, 0);
    assert.match(blank.signals[0]!, /nothing in the filename/);
  });
});

describe('extraction is native or it is honestly refused', () => {
  it('reads text where the bytes are the text, and finds the table in it', () => {
    const csv = 'Item,Unit,Quantity\nExcavation,m3,420\nBlinding,m2,180\n';
    const result = extractText(Buffer.from(csv), 'text/plain');
    assert.equal(result.method, 'NATIVE');
    assert.deepEqual(result.tables?.[1], ['Excavation', 'm3', '420']);
  });

  it('does not call prose with commas a table', () => {
    // Found by this test rather than in production: three lines of a letter
    // carrying the same number of commas were read as a three-column table.
    // A table with the wrong columns is worse than no table — somebody reads it
    // as a bill of quantities.
    const prose =
      'Further to your letter, dated 3 March, we write to confirm.\n' +
      'The works, as instructed, proceed.\n' +
      'Access remains, as before, restricted.';
    const result = extractText(Buffer.from(prose), 'text/plain');
    assert.equal(result.method, 'NATIVE');
    assert.equal(result.tables, undefined);
  });

  it('routes a PDF and a photograph to OCR rather than guessing at them', () => {
    for (const type of ['application/pdf', 'image/jpeg']) {
      const result = extractText(Buffer.from('%PDF-1.7'), type);
      assert.equal(result.method, 'NEEDS_OCR');
      assert.match(result.reason ?? '', /model that can see|optical character/);
    }
  });

  it('says plainly that nothing reads an unrecognised format', () => {
    const result = extractText(Buffer.from([0x00, 0x01]), undefined);
    assert.equal(result.method, 'UNSUPPORTED');
    assert.match(result.reason ?? '', /held; it is not read/);
  });
});

describe('the index is lexical, and is named for what it is', () => {
  const SPECIFICATION =
    'Clause 4.1 Workmanship. Concrete for the inlet works shall be Class C32/40 and shall be placed in ' +
    'continuous pours to the approval of the Engineer. Curing shall continue for seven days.';

  it('normalises to a fixed width, so two vectors are always comparable', () => {
    const vector = lexicalVector(SPECIFICATION);
    assert.equal(vector.length, VECTOR_DIMENSIONS);
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    assert.ok(Math.abs(magnitude - 1) < 0.001, `magnitude was ${magnitude}`);
  });

  it('matches a document against itself, and never above 1', () => {
    const vector = lexicalVector(SPECIFICATION);
    const self = similarity(vector, vector);
    // Not exactly 1: the stored vector is rounded to six places, so a
    // self-comparison lands a hair under. The property that matters is that it
    // never lands over — a similarity of 1.0000001 reads as a bug to whoever
    // sees it.
    assert.ok(self > 0.999 && self <= 1, `self-similarity was ${self}`);
  });

  it('finds the near-duplicate revision, which is what it is for', () => {
    const revised = SPECIFICATION.replace('seven days', 'ten days');
    assert.ok(similarity(lexicalVector(SPECIFICATION), lexicalVector(revised)) > 0.9);
  });

  it('does not find a paraphrase — this is not an embedding, and does not pretend to be', () => {
    // Asserted deliberately. The failure mode worth guarding is not the miss,
    // it is somebody reading `lexicalVector` as semantic search and trusting it
    // to find the clause said in other words.
    const paraphrase =
      'Item 4.1 Standard of work. The mix used at the intake structure must reach the specified strength grade ' +
      'and be poured without interruption, then kept damp for a week.';
    assert.ok(similarity(lexicalVector(SPECIFICATION), lexicalVector(paraphrase)) < 0.5);
  });

  it('reports nothing in common as nothing in common', () => {
    const unrelated = 'Weekly progress meeting minutes. Present: site manager, subcontractor foreman.';
    assert.ok(similarity(lexicalVector(SPECIFICATION), lexicalVector(unrelated)) < 0.3);
  });

  it('refuses to compare vectors of different widths rather than reading past the end', () => {
    assert.equal(similarity([1, 0, 0], [1, 0]), 0);
  });
});

// --- The governed half ------------------------------------------------------

let directory: string;
let store: EvidenceStore;
let platform: Platform;
let seed: SeedResult;

function ctxFor(who: string): EngineContext {
  return platform.context(seed.users[who]!.auth, seed.projectId, { correlationId: 'ingestion-test' });
}

/** Put a file in the store and name it in the ledger, in that order's reverse. */
function hold(bytes: Buffer, contentType: string, description: string): string {
  const hash = hashBytes(bytes);
  // The ledger names the hash first; only then may bytes be stored against it.
  registerEvidence(ctxFor('pm'), { type: 'SITE_OBSERVATION_MEDIA', hash, description });
  store.put(seed.tenantId, hash, bytes, contentType);
  return hash;
}

describe('ingestion under authorisation, with the finding on the record', () => {
  before(async () => {
    directory = mkdtempSync(join(tmpdir(), 'construx-ingestion-'));
    store = new EvidenceStore(directory);
    platform = new Platform(undefined, store);
    seed = await seedDemoProject(platform);
  });

  after(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('reads a held file and records what it is', () => {
    const hash = hold(
      Buffer.from('Clause 4.1 Workmanship. Concrete shall be placed to the approval of the Engineer.'),
      'text/plain',
      'Specification extract',
    );
    const result = ingestFile(ctxFor('pm'), store, { hash, filename: 'E10-specification.txt' });
    assert.equal(result.status, 'INGESTED');
    assert.equal(result.kind, 'SPECIFICATION');
    assert.equal(result.findings, 0);

    const file = ingestedFiles(ctxFor('pm')).find((entry) => entry.ingestionId === result.ingestionId)!;
    assert.equal(file.extraction.method, 'NATIVE');
    assert.equal(file.classification.method, 'RULES');
    assert.equal(file.inspection.antivirusScanned, false);
    assert.equal(file.lexicalVector?.length, VECTOR_DIMENSIONS);
  });

  it('quarantines a renamed executable and keeps the bytes', () => {
    const bytes = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.from('a PE binary in an evidence store')]);
    const hash = hold(bytes, 'image/png', 'Alleged site photograph');
    const result = ingestFile(ctxFor('pm'), store, { hash, filename: 'site-photo.png' });

    assert.equal(result.status, 'QUARANTINED');
    assert.ok(result.findings > 0);
    // Quarantine is a state on the record, never a deletion. The hash is in the
    // chain, and a hash pointing at nothing is the failure the evidence
    // register exists to report.
    assert.equal(store.has(seed.tenantId, hash), true);

    const file = ingestedFiles(ctxFor('pm')).find((entry) => entry.ingestionId === result.ingestionId)!;
    // Nothing is read out of a blocked file — classifying a bomb first does not
    // make it safe.
    assert.equal(file.extraction.method, 'UNSUPPORTED');
    assert.equal(file.classification.kind, 'UNKNOWN');
    assert.equal(file.lexicalVector, undefined);
  });

  it('writes the refusal as its own event, separate from the reading', () => {
    const events = platform.ledger.events({ projectId: seed.projectId }).map((event) => event.eventType);
    assert.ok(events.includes('FILE_INGESTED'));
    assert.ok(events.includes('FILE_QUARANTINED'));
    assert.ok(events.includes('FILE_EXTRACTED'));
  });

  it('refuses a hash no evidence record names', () => {
    const error = throwsCode(
      () => ingestFile(ctxFor('pm'), store, { hash: `sha256:${'0'.repeat(64)}` }),
      'NO_EVIDENCE_RECORD',
    );
    assert.match(String(error.message), /no document to ingest/);
  });

  it('refuses a record whose bytes the platform does not hold', () => {
    const bytes = Buffer.from('a document somebody kept on their own laptop');
    const hash = hashBytes(bytes);
    registerEvidence(ctxFor('pm'), { type: 'SITE_OBSERVATION_MEDIA', hash, description: 'Unheld' });

    const error = throwsCode(() => ingestFile(ctxFor('pm'), store, { hash }), 'BYTES_NOT_HELD');
    // The distinction the whole evidence feature turns on, said out loud.
    assert.match(String(error.message), /holds the hash and not the file/);
  });

  it('refuses to ingest the same bytes twice rather than quietly replacing a finding', () => {
    const hash = hold(Buffer.from('Dear Sir, further to your letter of 3 March.'), 'text/plain', 'Letter');
    ingestFile(ctxFor('pm'), store, { hash, filename: 'letter.txt' });

    const error = throwsCode(() => ingestFile(ctxFor('pm'), store, { hash, filename: 'letter.txt' }), 'ALREADY_INGESTED');
    assert.match(String(error.message), /cannot produce a different document/);
  });

  it('takes authority to act on the register, not merely to read it', () => {
    const hash = hold(Buffer.from('Programme: critical path through the inlet works.'), 'text/plain', 'Programme');
    // The design lead can read the evidence register — everyone can — and
    // cannot write a governed statement about what a file is. Gating this on
    // `R` would have made it writable by every role in the platform.
    throwsCode(() => ingestFile(ctxFor('designer'), store, { hash }), 'ACCESS_DENIED');
    assert.ok(ingestedFiles(ctxFor('designer')).length > 0);
  });

  it('finds the second copy of a document, and says the match is lexical', () => {
    const original =
      'Clause 12 Notice. The Contractor shall give notice of any event which delays completion within eight ' +
      'weeks of becoming aware of it, stating the effect on the completion date.';
    const first = hold(Buffer.from(original), 'text/plain', 'Notice clause');
    const second = hold(Buffer.from(`${original} Issued for information.`), 'text/plain', 'Notice clause, reissued');

    const one = ingestFile(ctxFor('pm'), store, { hash: first, filename: 'clause-12.txt' });
    ingestFile(ctxFor('pm'), store, { hash: second, filename: 'clause-12-reissue.txt' });

    const matches = similarFiles(ctxFor('pm'), one.ingestionId);
    assert.ok(matches.length >= 1);
    assert.equal(matches[0]!.hash, second);
    assert.ok(matches[0]!.similarity >= 0.6);
  });

  it('says there is nothing to compare rather than returning an empty list', () => {
    // An empty list reads as "no similar documents". The truth is that nothing
    // was ever indexed, which is a different answer and a different next step.
    const hash = hold(png(), 'image/png', 'Site photograph');
    const ingested = ingestFile(ctxFor('pm'), store, { hash, filename: 'progress-01.png' });

    const error = throwsCode(() => similarFiles(ctxFor('pm'), ingested.ingestionId), 'NOTHING_INDEXED');
    assert.match(String(error.message), /perception pipeline/);
  });

  it('reports what has never been looked at, and never implies a scan', () => {
    // Held and named, and deliberately not ingested.
    hold(Buffer.from('An unread daily allocation sheet.'), 'text/plain', 'Allocation sheet');

    const position = ingestionPosition(ctxFor('pm'), store);
    assert.ok(position.notIngested >= 1);
    assert.ok(position.quarantined >= 1);
    assert.ok(position.read >= 1);
    assert.ok(position.awaitingOcr >= 1);
    assert.equal(position.byKind.SPECIFICATION, 1);
    // Said on every read, beside the count, so "0 quarantined" is never read as
    // "nothing infected".
    assert.equal(position.antivirusConfigured, false);
    assert.equal(position.quarantine.length, position.quarantined);
    assert.ok(position.quarantine[0]!.findings.length > 0);
  });
});
