import { createHash } from 'node:crypto';
import { readPdfText, SENTENCE_END, type PdfTable } from './pdftext.ts';
import { zipEntries as readZipEntries } from './zip.ts';

/**
 * The file ingestion pipeline: what happens to a file between arriving and
 * being usable.
 *
 * Upload and storage were already built — `store.ts` holds the bytes at the
 * hash the ledger names, and refuses anything whose hash does not match. What
 * did not exist was everything between: nobody looked at the file, nothing said
 * what kind of document it was, nothing read it, and nothing could find the
 * other document that says the same thing.
 *
 * Five stages, and each is a separate fact on the record rather than one
 * "processed" flag: **inspect → classify → extract → index → available**.
 *
 * ---
 *
 * ## This is not an antivirus, and it does not say it is
 *
 * Zero runtime dependencies is a settled decision, so there is no signature
 * engine here and there is not going to be one. Calling this a virus scan would
 * be the exact false statement the rest of the platform is built to avoid — a
 * deployment would read "clean" and believe something nobody checked.
 *
 * A deployment that has a scanner beside it can now have one: `scanner.ts`
 * speaks clamd's INSTREAM protocol over a socket and `pipeline.ts` sends every
 * file through it, recording which daemon and which signature database answered.
 * That is a client, not an engine — it holds no signatures — and where none is
 * configured `antivirusScanned` stays false on every record.
 *
 * Either way the verdict *here* is about **structure**, not signatures, and the
 * two catch different things. What this catches is the threat that actually
 * applies to a construction record system, which is not a virus in a drawing: it
 * is a file that **is not what it claims to be**.
 *
 * - **The declared type is a claim; the first bytes are the fact.** A file
 *   uploaded as `image/png` whose bytes begin `MZ` is a Windows executable
 *   somebody has renamed.
 * - **Executables are refused outright**, by magic: PE, ELF and both Mach-O
 *   byte orders. There is no legitimate reason for one in an evidence store.
 * - **Active content in a document is refused.** An SVG or an HTML file
 *   carrying `<script>` served back from the platform's own origin is stored
 *   cross-site scripting, which is the same reasoning that keeps SVG out of the
 *   landing-page slots.
 * - **The EICAR test string is detected**, because it is the one signature
 *   every scanner in the world agrees on and it is how an operator checks that
 *   a quarantine path is wired up at all.
 * - **An archive carrying an executable is refused**, read from the local file
 *   headers without decompressing anything.
 * - **A compression bomb is refused** on the ratio the archive itself declares,
 *   so nothing has to be expanded to find out.
 *
 * A verdict of `PASSED` therefore means "structurally what it claims to be and
 * carrying nothing executable", and the type says so. It does not mean clean.
 *
 * ## The classifier is rules, and says so
 *
 * `classify` is magic bytes, filename convention and content markers, with a
 * confidence derived from **how many independent signals agree** rather than
 * from a model's self-report. It is not machine learning and the record does
 * not call it that. Where a multimodal provider is configured, the perception
 * pipeline can read the document properly and a person confirms — that path
 * already exists and this one does not compete with it.
 *
 * ## Extraction is native or it is refused
 *
 * Text comes out of a text-bearing format because the bytes are the text. A PDF
 * or a photograph needs OCR, which needs a model that can see, so the stage
 * reports `NEEDS_OCR` and routes to `engines/perception.ts` — the same refusal
 * discipline as everywhere else. Nothing here guesses at the contents of a
 * scan.
 *
 * ## The index is lexical, not semantic
 *
 * Feature hashing over words and word pairs, L2-normalised, compared by cosine.
 * That finds the near-duplicate revision, the second copy of the same
 * specification, and the other document quoting the same clause — which is most
 * of what anybody actually asks a document store. It does **not** find a
 * document that means the same thing in different words; that needs an
 * embedding model, and the field is named `lexicalVector` so nobody reads it as
 * one.
 */

// --- Stage 1: inspection ----------------------------------------------------

export type InspectionVerdict = 'PASSED' | 'BLOCKED' | 'UNRECOGNISED';

export type InspectionFinding = {
  /** What was found, in a sentence somebody can act on. */
  what: string;
  /** Why it is refused or noted. */
  because: string;
};

export type Inspection = {
  verdict: InspectionVerdict;
  /** What the bytes actually are, by magic. Absent where nothing matched. */
  actualType?: string;
  /** What the upload said it was. */
  declaredType: string;
  findings: InspectionFinding[];
  /**
   * Whether a signature scanner actually looked at these bytes.
   *
   * There is no signature engine *in this process* and there is not going to be
   * one, so `inspect` always sets this false: its verdict is about structure.
   * `pipeline.ts` talks to a configured scanner and overwrites it, naming the
   * daemon and its database in `antivirusScanner`. Load-bearing either way — a
   * deployment reading a `PASSED` verdict as "scanned clean" would be believing
   * something nobody checked.
   */
  antivirusScanned: boolean;
  /** The daemon and signature database that answered. Absent where none did. */
  antivirusScanner?: string;
  /** What was found, verbatim. A quarantine that will not say what by is useless. */
  antivirusSignature?: string;
  bytes: number;
};

/** Leading bytes that identify a format, longest prefix first. */
const MAGIC: ReadonlyArray<{ type: string; bytes: number[]; offset?: number }> = [
  { type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { type: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  // ZIP, and everything built on it: xlsx, docx, pptx, and IFC-ZIP.
  { type: 'application/zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { type: 'application/zip', bytes: [0x50, 0x4b, 0x05, 0x06] },
  // RIFF····WEBP — the four bytes between are the length.
  { type: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] },
];

/** Executable images. None of these has a reason to be in an evidence store. */
const EXECUTABLE: ReadonlyArray<{ what: string; bytes: number[] }> = [
  { what: 'a Windows executable (PE)', bytes: [0x4d, 0x5a] },
  { what: 'a Linux executable (ELF)', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { what: 'a macOS executable (Mach-O)', bytes: [0xfe, 0xed, 0xfa, 0xce] },
  { what: 'a macOS executable (Mach-O, little-endian)', bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { what: 'a Java class file', bytes: [0xca, 0xfe, 0xba, 0xbe] },
];

/**
 * The EICAR anti-malware test string.
 *
 * Not malware and not a signature database — it is the one string every scanner
 * on earth agrees to flag, and it exists so somebody can prove a quarantine
 * path works without handling anything dangerous. Detected here for exactly
 * that: an operator can upload it and watch the file be refused.
 */
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/** Extensions that are executable whatever they are wrapped in. */
const DANGEROUS_ENTRY = /\.(exe|scr|bat|cmd|com|pif|vbs|js|jar|msi|dll|sh|ps1)$/i;

/** Markup that runs. In a document served from our own origin, this is XSS. */
const ACTIVE_CONTENT = /<script[\s>]|javascript:|on(?:error|load|click)\s*=|<\?php/i;

/** The declared-to-actual ratio above which an archive is a decompression bomb. */
const BOMB_RATIO = 200;

function startsWith(bytes: Buffer, magic: number[], offset = 0): boolean {
  if (bytes.length < offset + magic.length) return false;
  return magic.every((byte, index) => bytes[offset + index] === byte);
}

/** What the bytes are, by magic. `undefined` where nothing matched. */
export function sniffType(bytes: Buffer): string | undefined {
  for (const entry of MAGIC) {
    if (!startsWith(bytes, entry.bytes, entry.offset)) continue;
    // RIFF is a container; only the WEBP form is an image.
    if (entry.type === 'image/webp' && bytes.subarray(8, 12).toString('latin1') !== 'WEBP') continue;
    return entry.type;
  }
  // Text is not a magic number. A file that decodes as UTF-8 with no control
  // characters outside whitespace is text, which is the honest test.
  const sample = bytes.subarray(0, 4096).toString('utf8');
  // eslint-disable-next-line no-control-regex
  if (sample.length > 0 && !/[\u0000-\u0008\u000e-\u001f]/.test(sample)) return 'text/plain';
  return undefined;
}

/**
 * Read the entry names an archive declares, without decompressing anything.
 *
 * Enough to see that a spreadsheet is carrying an executable, and it never
 * expands a byte — which is the whole point when the file might be a bomb.
 * The reading itself lives in `zip.ts`, shared with the IFC reader, which
 * prefers the central directory and falls back to the local headers this used
 * to walk on its own.
 */
function zipEntries(bytes: Buffer): { names: string[]; declaredUncompressed: number } {
  const entries = readZipEntries(bytes);
  return {
    names: entries.map((entry) => entry.name),
    declaredUncompressed: entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0),
  };
}

/**
 * Look at a file before anything else touches it.
 *
 * Returns a verdict rather than throwing: a refused file is a fact to record
 * against the evidence item, not an exception that loses the reason.
 */
export function inspect(input: { bytes: Buffer; declaredType: string; filename?: string }): Inspection {
  const { bytes, declaredType } = input;
  const findings: InspectionFinding[] = [];
  const actualType = sniffType(bytes);

  if (bytes.length === 0) {
    return {
      verdict: 'BLOCKED',
      declaredType,
      findings: [{ what: 'The file is empty', because: 'There is nothing to store, read or evidence.' }],
      antivirusScanned: false,
      bytes: 0,
    };
  }

  for (const executable of EXECUTABLE) {
    if (startsWith(bytes, executable.bytes)) {
      findings.push({
        what: `The file begins with the signature of ${executable.what}`,
        because: 'An evidence store holds records of construction work. Nothing in it should be a program.',
      });
    }
  }

  if (bytes.includes(EICAR, 0, 'latin1')) {
    findings.push({
      what: 'The file contains the EICAR anti-malware test string',
      because:
        'Refused deliberately. It is harmless, and it is how somebody proves the quarantine path works — so it ' +
        'has to actually be quarantined.',
    });
  }

  // Active content, checked only where the file is text-shaped. A JPEG that
  // happens to contain the bytes `<script` in its entropy is not a threat.
  if (actualType === 'text/plain' || declaredType.includes('svg') || declaredType.includes('html')) {
    const text = bytes.subarray(0, 64 * 1024).toString('utf8');
    if (ACTIVE_CONTENT.test(text)) {
      findings.push({
        what: 'The file carries markup that executes — a script, an event handler or a javascript: URL',
        because:
          'Served back from the platform’s own origin, that is stored cross-site scripting. The same reasoning ' +
          'keeps SVG out of the landing page slots.',
      });
    }
  }

  if (actualType === 'application/zip') {
    const { names, declaredUncompressed } = zipEntries(bytes);
    const dangerous = names.filter((name) => DANGEROUS_ENTRY.test(name));
    if (dangerous.length > 0) {
      findings.push({
        what: `The archive contains ${dangerous.slice(0, 3).join(', ')}`,
        because: 'An executable inside a spreadsheet is an executable.',
      });
    }
    if (declaredUncompressed > bytes.length * BOMB_RATIO) {
      findings.push({
        what:
          `The archive declares ${Math.round(declaredUncompressed / 1_048_576)}MB of content in ` +
          `${Math.round(bytes.length / 1024)}KB`,
        because:
          `A ratio above ${BOMB_RATIO}:1 is a decompression bomb. Read from what the archive declares, so nothing ` +
          'had to be expanded to find out.',
      });
    }
  }

  // The declared type is the uploader's claim. Where the bytes disagree, the
  // bytes win and the file is refused — this is the check that catches a
  // renamed executable, and it is worth more than any of the others.
  if (actualType !== undefined && !typesAgree(declaredType, actualType)) {
    findings.push({
      what: `Uploaded as ${declaredType}, but the bytes are ${actualType}`,
      because:
        'A file that is not what it says it is has either been renamed by somebody or mislabelled by something. ' +
        'Either way the record would name the wrong thing.',
    });
  }

  if (findings.length > 0) {
    return { verdict: 'BLOCKED', actualType, declaredType, findings, antivirusScanned: false, bytes: bytes.length };
  }

  if (actualType === undefined) {
    return {
      verdict: 'UNRECOGNISED',
      declaredType,
      findings: [
        {
          what: 'The platform does not recognise this format',
          because:
            'Stored and held, but nothing downstream will read it. Not refused: an IFC, a Revit model or a ' +
            'proprietary schedule is a legitimate record this pipeline simply cannot open.',
        },
      ],
      antivirusScanned: false,
      bytes: bytes.length,
    };
  }

  return { verdict: 'PASSED', actualType, declaredType, findings: [], antivirusScanned: false, bytes: bytes.length };
}

/**
 * Whether a declared media type and a sniffed one describe the same file.
 *
 * Not string equality: `application/zip` is honestly declared as an `xlsx`,
 * a `docx` or an IFC-ZIP, and `text/plain` covers CSV, JSON, XML and Markdown.
 * Being strict here would refuse most of a real document set.
 */
function typesAgree(declared: string, actual: string): boolean {
  const base = declared.split(';')[0]!.trim().toLowerCase();
  if (base === actual) return true;
  if (actual === 'application/zip') {
    return /officedocument|opendocument|zip|ifc|excel|word|powerpoint/i.test(base);
  }
  if (actual === 'text/plain') return base.startsWith('text/') || /json|xml|csv|svg|ifc|markdown/i.test(base);
  if (actual === 'image/jpeg') return base === 'image/jpg';
  // An unlabelled upload is a claim about nothing, so there is nothing to
  // disagree with. The classifier below works from the bytes regardless.
  return base === '' || base === 'application/octet-stream';
}

// --- Stage 2: classification ------------------------------------------------

export const DOCUMENT_KIND = [
  'DRAWING',
  'SPECIFICATION',
  'PROGRAMME',
  'CONTRACT',
  'CERTIFICATE',
  'PHOTOGRAPH',
  'MODEL',
  'SCHEDULE',
  'CORRESPONDENCE',
  'UNKNOWN',
] as const;
export type DocumentKind = (typeof DOCUMENT_KIND)[number];

export type Classification = {
  kind: DocumentKind;
  /**
   * 0–1, from how many independent signals agree — never a model's self-report.
   * One signal is a guess, three is a reading.
   */
  confidence: number;
  /** Every signal that fired, so the answer can be argued with. */
  signals: string[];
  /**
   * Always `'RULES'`. The record does not call this machine learning, because
   * it is a filename convention, a magic number and a word list.
   */
  method: 'RULES';
};

/**
 * Filename conventions and content markers, per kind.
 *
 * `says` is what the signal is called on a screen. The pattern was published
 * instead at first, so a project manager was shown
 * `the filename matches /(spec|specification|nbs)/i` — true, and useless to
 * everybody the classification is for. The regex is the implementation; the
 * sentence is the finding.
 */
const KIND_SIGNALS: ReadonlyArray<{
  kind: DocumentKind;
  says: string;
  name?: RegExp;
  content?: RegExp;
  types?: string[];
}> = [
  {
    kind: 'DRAWING',
    says: 'the filename is a drawing reference',
    name: /(^|[-_])(dwg|drg|drawing|ga|plan|section|elevation|detail)([-_]|\.|$)/i,
  },
  {
    kind: 'DRAWING',
    says: 'the text carries a scale, a revision or a title block',
    content: /\b(scale\s*1\s*[:/]\s*\d|do not scale|title block|rev(ision)?\s*[a-z0-9]{1,3}\b)/i,
  },
  { kind: 'SPECIFICATION', says: 'the filename says specification', name: /(spec|specification|nbs)/i },
  {
    kind: 'SPECIFICATION',
    says: 'the text is written as a specification — clauses, “shall be”, workmanship',
    content: /\b(clause\s+\d|shall be|workmanship|to the approval of the)\b/i,
  },
  {
    kind: 'PROGRAMME',
    says: 'the filename says programme, baseline or lookahead',
    name: /(programme|schedule|gantt|baseline|lookahead)/i,
  },
  {
    kind: 'PROGRAMME',
    says: 'the text uses programming terms — critical path, float, predecessors',
    content: /\b(critical path|total float|predecessor|milestone|early start)\b/i,
  },
  {
    kind: 'CONTRACT',
    says: 'the filename names a contract or a standard form',
    name: /(contract|jct|nec|fidic|agreement|appointment|subcontract)/i,
  },
  {
    kind: 'CONTRACT',
    says: 'the text uses contract language — the Employer, the Contractor shall, liquidated damages',
    content: /\b(the employer|the contractor shall|liquidated damages|clause \d+\.\d+)\b/i,
  },
  {
    kind: 'CERTIFICATE',
    says: 'the filename says certificate, test or competency',
    name: /(certificate|cert|test|calibration|competen|ticket|card)/i,
  },
  {
    kind: 'CERTIFICATE',
    says: 'the text certifies something and carries an expiry',
    content: /\b(this is to certify|certificate no|valid until|expiry date)\b/i,
  },
  {
    kind: 'PHOTOGRAPH',
    says: 'the bytes are an image',
    types: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  },
  { kind: 'MODEL', says: 'the extension is a model format', name: /\.(ifc|rvt|nwd|nwc|dgn|skp)$/i },
  { kind: 'SCHEDULE', says: 'the extension is a spreadsheet', name: /\.(xlsx|xls|csv)$/i },
  { kind: 'SCHEDULE', says: 'the text is delimited into columns', content: /^[^\n]*,[^\n]*,[^\n]*,/ },
  {
    kind: 'CORRESPONDENCE',
    says: 'the filename says letter, minutes, RFI or notice',
    name: /(letter|email|minutes|memo|rfi|notice)/i,
  },
  {
    kind: 'CORRESPONDENCE',
    says: 'the text is written as a letter',
    content: /\b(dear sir|yours faithfully|we write to|further to your)\b/i,
  },
];

/**
 * What kind of construction document this is.
 *
 * Rules, and the record says `method: 'RULES'` so nobody reads it as a model.
 * The confidence is the count of agreeing signals rather than an assertion:
 * a filename alone is a guess, a filename and two content markers is a
 * reading, and the signals are listed so somebody can disagree with it.
 */
export function classify(input: {
  filename?: string;
  actualType?: string;
  /** Extracted text, where there is any. Absent for a scan or a photograph. */
  text?: string;
}): Classification {
  const scores = new Map<DocumentKind, string[]>();
  const note = (kind: DocumentKind, signal: string): void => {
    scores.set(kind, [...(scores.get(kind) ?? []), signal]);
  };

  const name = input.filename ?? '';
  const text = (input.text ?? '').slice(0, 32 * 1024);

  for (const rule of KIND_SIGNALS) {
    if (rule.types && input.actualType && rule.types.includes(input.actualType)) note(rule.kind, rule.says);
    if (rule.name && name && rule.name.test(name)) note(rule.kind, rule.says);
    if (rule.content && text && rule.content.test(text)) note(rule.kind, rule.says);
  }

  // A photograph that is also named like a drawing is a photograph of a
  // drawing, and the image type is the stronger signal for what the file *is*.
  const ranked = [...scores.entries()].sort((a, b) => b[1].length - a[1].length);
  const best = ranked[0];

  if (!best) {
    return {
      kind: 'UNKNOWN',
      confidence: 0,
      signals: ['nothing in the filename, the type or the text identified this'],
      method: 'RULES',
    };
  }

  // Three agreeing signals is as confident as rules get. Anything above 0.9
  // would be a claim this method cannot support.
  const confidence = Math.min(0.9, Number((best[1].length / 3).toFixed(2)));
  return { kind: best[0], confidence, signals: best[1], method: 'RULES' };
}

// --- Stage 3: extraction ----------------------------------------------------

export type Extraction = {
  /** The text, where the bytes are the text — or, under `OCR`, what a model transcribed and a person confirmed. */
  text?: string;
  /**
   * Rows, where the file is delimited or a PDF's text lines up into columns.
   * Never inferred from prose. Where a PDF carries several tables this is the
   * first of them, and `pageTables` carries them all.
   */
  tables?: string[][];
  /** Every table recovered from a PDF, with the page it sits on. */
  pageTables?: PdfTable[];
  /**
   * `NATIVE`: read from the bytes themselves. `OCR`: transcribed by a
   * multimodal provider through the perception pipeline and confirmed by a
   * person. `NEEDS_OCR`: nothing readable in the bytes, a model is needed.
   * `UNSUPPORTED`: nothing here reads this format.
   */
  method: 'NATIVE' | 'OCR' | 'NEEDS_OCR' | 'UNSUPPORTED';
  /** Pages, where the format has them. */
  pages?: number;
  /** Why nothing was extracted, where nothing was. Never blank on a refusal. */
  reason?: string;
  /** What a successful read left out or how it was made, where either is worth saying. */
  note?: string;
};

/** Below this many characters a PDF's text layer is a title on a scan, not a document. */
const PDF_TEXT_FLOOR = 20;

/**
 * Get the text out, or say honestly why not.
 *
 * Native where the bytes *are* the text: a text file, or a PDF that carries its
 * words in its content streams, which `pdftext.ts` reads. A scanned PDF or a
 * photograph needs a model that can see, so this reports `NEEDS_OCR` and the
 * caller routes to the perception pipeline, which refuses when no multimodal
 * provider is configured. Nothing here guesses at the contents of a scan.
 */
export function extractText(bytes: Buffer, actualType: string | undefined): Extraction {
  if (actualType === 'text/plain') {
    const text = bytes.toString('utf8');
    const tables = parseDelimited(text);
    return { text, ...(tables ? { tables } : {}), method: 'NATIVE' };
  }

  if (actualType === 'application/pdf') {
    const read = readPdfText(bytes);
    if (read.encrypted) {
      return {
        method: 'UNSUPPORTED',
        reason:
          'This PDF is encrypted. Nothing can read it without its password — not this parser, and not a model that ' +
          'can see, which would be shown the same ciphertext. Ask for an unlocked copy.',
      };
    }
    const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;
    if (read.pages > 0 && read.text.replace(/\s+/g, '').length >= PDF_TEXT_FLOOR) {
      const notes: string[] = [];
      if (read.imageOnlyPages > 0) {
        notes.push(
          `${read.imageOnlyPages} of ${plural(read.pages, 'page')} carr${read.imageOnlyPages === 1 ? 'ies' : 'y'} only images and no text ` +
            'layer — what a scan looks like — and would need a model that can see',
        );
      }
      if (read.undecodableStrings > 0) {
        notes.push(`${plural(read.undecodableStrings, 'text run')} set in a font with no readable encoding were skipped rather than guessed at`);
      }
      if (read.unreadableStreams > 0) {
        notes.push(`${plural(read.unreadableStreams, 'stream')} under a compression this reader does not decode were skipped`);
      }
      // The tables are carried, not noted: the note is for what a read left
      // out, and the screen counts `pageTables` itself.
      return {
        text: read.text,
        ...(read.tables.length > 0 ? { tables: read.tables[0]!.rows, pageTables: read.tables } : {}),
        method: 'NATIVE',
        pages: read.pages,
        ...(notes.length > 0 ? { note: `${notes.join('; ')}.` } : {}),
      };
    }
    if (read.pages === 0) {
      return {
        method: 'NEEDS_OCR',
        reason:
          'No page tree could be found in this PDF, so whatever text layer it has could not be reached. Reading it needs ' +
          'a model that can see the page — the perception pipeline, which refuses when no multimodal provider is ' +
          'configured rather than inventing a reading.',
      };
    }
    return {
      method: 'NEEDS_OCR',
      pages: read.pages,
      reason:
        `${plural(read.pages, 'page')} and no text layer to read` +
        (read.imageOnlyPages > 0 ? ` — ${read.imageOnlyPages} carr${read.imageOnlyPages === 1 ? 'ies' : 'y'} only images, which is what a scan looks like` : '') +
        (read.undecodableStrings > 0 ? `; ${plural(read.undecodableStrings, 'text run')} set in a font with no readable encoding` : '') +
        (read.unreadableStreams > 0 ? `; ${plural(read.unreadableStreams, 'stream')} under a compression this reader does not decode` : '') +
        '. Reading it needs a model that can see the page — the perception pipeline, which refuses when no multimodal ' +
        'provider is configured rather than inventing a reading.',
    };
  }

  if (actualType?.startsWith('image/')) {
    return {
      method: 'NEEDS_OCR',
      reason: 'An image carries no text. Reading it is optical character recognition, which needs a model that can see.',
    };
  }

  return {
    method: 'UNSUPPORTED',
    reason: `Nothing in this platform reads ${actualType ?? 'an unrecognised format'}. The file is held; it is not read.`,
  };
}

/**
 * Rows out of a delimited file, or nothing.
 *
 * Deliberately conservative, because a table with the wrong columns is worse
 * than no table: somebody reads it as a bill of quantities.
 *
 * Three conditions, and the third was added after a letter was parsed as a
 * spreadsheet. Two lines of correspondence happened to carry the same number of
 * commas — "Further to your letter, dated 3 March, we write to confirm." beside
 * "The works, as instructed, proceed." — and equal field counts alone called it
 * a table.
 *
 * 1. At least three rows, so a coincidence has to happen three times.
 * 2. Every row the same width.
 * 3. No sentence in the header row. A column heading is `Item`, `Unit`,
 *    `Quantity`; a first line of prose ends in a full stop. Checked on the
 *    header only, because a real bill's *descriptions* are full of `incl.` and
 *    refusing those would lose the tables this exists to find.
 */
function parseDelimited(text: string): string[][] | undefined {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length < 3) return undefined;

  for (const delimiter of [',', '\t', ';']) {
    const rows = lines.slice(0, 200).map((line) => line.split(delimiter));
    const width = rows[0]!.length;
    if (width < 2) continue;
    if (rows[0]!.some((cell) => SENTENCE_END.test(cell.trim()))) continue;
    if (rows.every((row) => row.length === width)) {
      return rows.map((row) => row.map((cell) => cell.trim()));
    }
  }
  return undefined;
}

// --- Stage 4: indexing ------------------------------------------------------

/**
 * How many dimensions the lexical vector has.
 *
 * 128 is enough to separate a document set of the size one project produces
 * without making every record carry a kilobyte of floats. Feature hashing has
 * collisions by design; at this width they blur rather than confuse.
 */
export const VECTOR_DIMENSIONS = 128;

/**
 * A vector for finding the same document again.
 *
 * Feature hashing over words and word pairs, L2-normalised so cosine
 * similarity is a dot product. **Lexical, not semantic** — the field is named
 * for that. It finds the near-duplicate revision, the second copy of a
 * specification and the other document quoting the same clause, which is most
 * of what anybody asks a document store. It does not find a document that
 * means the same thing in different words; that needs an embedding model, and
 * claiming this is one would be the overclaim the naming exists to prevent.
 */
export function lexicalVector(text: string): number[] {
  const vector = new Array<number>(VECTOR_DIMENSIONS).fill(0);
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && token.length < 32);

  const add = (feature: string): void => {
    const digest = createHash('sha256').update(feature).digest();
    const index = digest.readUInt16BE(0) % VECTOR_DIMENSIONS;
    // The sign comes from the hash too, so unrelated features that collide
    // cancel as often as they reinforce rather than always piling up.
    vector[index] = (vector[index] ?? 0) + (digest[2]! % 2 === 0 ? 1 : -1);
  };

  for (let at = 0; at < tokens.length; at += 1) {
    add(tokens[at]!);
    // Word pairs, which is what separates "notice of delay" from "delay notice"
    // and matters a great deal in a document set full of the same vocabulary.
    if (at + 1 < tokens.length) add(`${tokens[at]} ${tokens[at + 1]}`);
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) return vector;
  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}

/** Cosine similarity of two normalised vectors: 1 is identical, 0 unrelated. */
export function similarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0;
  const dot = a.reduce((sum, value, index) => sum + value * b[index]!, 0);
  // Clamped: floating point can put a self-comparison a hair over 1, and a
  // similarity of 1.0000001 reads as a bug in whatever displays it.
  return Number(Math.max(-1, Math.min(1, dot)).toFixed(6));
}
