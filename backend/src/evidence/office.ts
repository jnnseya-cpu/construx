import { ZipError, zipEntries, zipEntryBytes, type ZipEntry } from './zip.ts';

/**
 * Text out of the two Office Open XML containers a tender actually arrives in.
 *
 * An invitation to tender is not one tidy PDF. The instructions come as a Word
 * document, the return schedule and the pricing document as a spreadsheet, and
 * the platform read neither: `extractText` sniffed both as `application/zip`
 * and answered "nothing in this platform reads application/zip". The file was
 * held, classified and never read, so every downstream reading — the ITT
 * requirement extraction, the specification clause register, the measurement
 * import — was closed to the majority of a real tender pack.
 *
 * Both formats are a ZIP of XML, and `zip.ts` already reads ZIP for the IFC
 * container. So this is a parser over XML that is already in hand, not a new
 * dependency and not a new way of getting at bytes.
 *
 * ## What it does and does not read
 *
 * `.docx` — the body of `word/document.xml`. Paragraph and table structure is
 * kept, because a requirement in row three of a table stops being a
 * requirement once the row boundaries are gone. Headers, footers, footnotes,
 * comments and tracked-change history are **not** read: a header repeats on
 * every page and a tracked deletion is text somebody removed, and feeding
 * either to a model that has been told to quote the document is how a
 * requirement gets invented.
 *
 * `.xlsx` — every worksheet, in the workbook's own sheet order, as rows.
 * Cached formula results are read where the file carries them; formulas
 * themselves are not evaluated, so a spreadsheet saved by something that never
 * calculated reads as the blanks it actually contains rather than as numbers
 * this module made up.
 *
 * `.pptx` and the legacy binary `.doc`/`.xls` are refused by name. So is an
 * encrypted container, which is not a readable archive at all.
 */

/** Nothing here expands more than this from one entry, whatever the directory claims. */
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;

/** A workbook with more rows than this is a database, and the tail is dropped with a note. */
const MAX_ROWS = 5_000;

export type OfficeSheet = { name: string; rows: string[][] };

export type OfficeRead =
  | { kind: 'WORD'; text: string }
  | { kind: 'WORKBOOK'; text: string; sheets: OfficeSheet[]; truncated: boolean }
  | { kind: 'UNREADABLE'; reason: string };

/** The five XML entities, and nothing else. Numeric references are decoded too. */
function decodeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Ampersand last, or `&amp;lt;` would decode twice.
    .replace(/&amp;/g, '&');
}

/**
 * Walk an XML document as (tag, following text) pairs.
 *
 * Not a general XML parser and not trying to be one: Office Open XML is
 * machine-written, so the shapes that break a scanner like this — a `>` inside
 * an unquoted attribute, a DTD, an unclosed tag — do not occur. `visit` is
 * called with the tag's local name, whether it was a closing tag, the raw tag
 * for its attributes, and the character data that follows it.
 */
function scanXml(xml: string, visit: (name: string, closing: boolean, tag: string, text: string) => void): void {
  const token = /<([^>]*)>([^<]*)/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(xml)) !== null) {
    const tag = match[1] ?? '';
    // A comment, a processing instruction or a CDATA marker carries no name.
    if (tag.startsWith('!') || tag.startsWith('?')) continue;
    const closing = tag.startsWith('/');
    const name = (closing ? tag.slice(1) : tag).split(/[\s/>]/)[0] ?? '';
    visit(name, closing, tag, match[2] ?? '');
  }
}

/** Strip the namespace prefix, so `w:t` and a rewritten `x:t` read the same. */
function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

function entryNamed(entries: ZipEntry[], name: string): ZipEntry | undefined {
  return entries.find((entry) => entry.name === name);
}

function textOf(bytes: Buffer, entries: ZipEntry[], name: string): string | undefined {
  const entry = entryNamed(entries, name);
  if (!entry) return undefined;
  return zipEntryBytes(bytes, entry, MAX_ENTRY_BYTES).toString('utf8');
}

// --- Word --------------------------------------------------------------------

/**
 * The body text of a `.docx`, with its paragraph and table structure kept.
 *
 * A table cell ends in a tab and a table row in a newline, which is what makes
 * a docx compliance table come out as delimited rows the same way a CSV does.
 */
function wordText(xml: string): string {
  let out = '';
  let inField = false;
  let cellDepth = 0;

  scanXml(xml, (name, closing, tag, text) => {
    const local = localName(name);

    // Field instructions (`PAGE`, `REF`, a hyperlink target) are markup that
    // happens to be stored as text. They are not the document's words.
    if (local === 'instrText') {
      inField = !closing;
      return;
    }

    if (!closing) {
      // A run's tab is `<w:tab/>` with nothing on it. A tab carrying
      // attributes is a tab *stop* defined in the paragraph properties —
      // layout, not a character in the text.
      if (local === 'tab' && !/\s/.test(tag)) out += '\t';
      if (local === 'br' || local === 'cr') out += '\n';
      // `<w:t>` is the only element whose character data is document text.
      if (local === 't' && !inField && !tag.endsWith('/')) out += decodeXml(text);
      if (local === 'tc' && !tag.endsWith('/')) cellDepth += 1;
      return;
    }

    // A cell holds paragraphs — every one of them, always at least one. Ending
    // them with a newline would put each cell of a compliance table on its own
    // line and lose the row, which is the one thing a compliance table is.
    if (local === 'p') out += cellDepth > 0 ? ' ' : '\n';
    else if (local === 'tc') {
      cellDepth = Math.max(0, cellDepth - 1);
      out += '\t';
    } else if (local === 'tr') out += '\n';
  });

  return out
    // The space a cell's last paragraph left, immediately before the cell's
    // own separator.
    .replace(/ +\t/g, '\t')
    .split('\n')
    // A table row ends with the tab its last cell contributed; trailing
    // whitespace on a line is never content.
    .map((line) => line.replace(/[\t ]+$/, ''))
    .join('\n')
    // Word writes an empty paragraph for spacing; three blank lines in a row
    // is layout, not structure.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- Workbook ----------------------------------------------------------------

/** The shared string table, in index order. A cell with `t="s"` points into it. */
function sharedStrings(xml: string): string[] {
  const strings: string[] = [];
  let current = '';
  let depth = 0;

  scanXml(xml, (name, closing, tag, text) => {
    const local = localName(name);
    if (local === 'si') {
      if (closing) {
        strings.push(current);
        depth = 0;
      } else {
        current = '';
        depth = 1;
        // `<si/>` is an empty shared string, which is a legal thing to be.
        if (tag.endsWith('/')) {
          strings.push('');
          depth = 0;
        }
      }
      return;
    }
    // `<rPh>` carries phonetic guides for Japanese text — a second reading of
    // the same characters, which would otherwise be concatenated into the cell.
    if (local === 'rPh') {
      depth = closing ? 1 : 0;
      return;
    }
    if (!closing && local === 't' && depth === 1) current += decodeXml(text);
  });

  return strings;
}

/** `A` → 0, `Z` → 25, `AA` → 26. The column a cell reference names. */
function columnIndex(reference: string): number {
  const letters = reference.replace(/\d+$/, '');
  let index = 0;
  for (const letter of letters.toUpperCase()) {
    const value = letter.charCodeAt(0) - 64;
    if (value < 1 || value > 26) return -1;
    index = index * 26 + value;
  }
  return index - 1;
}

function sheetRows(xml: string, strings: string[], budget: { left: number }): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let column = -1;
  let type = '';
  let value = '';
  let inInline = false;
  let truncated = false;

  scanXml(xml, (name, closing, tag, text) => {
    const local = localName(name);

    if (local === 'row') {
      if (closing) {
        // Trailing blanks are the sheet's used range, not data.
        while (row.length > 0 && row[row.length - 1] === '') row.pop();
        if (row.length > 0) {
          if (budget.left <= 0) truncated = true;
          else {
            rows.push(row);
            budget.left -= 1;
          }
        }
        row = [];
      } else {
        row = [];
      }
      return;
    }

    if (local === 'c') {
      if (closing) {
        if (column >= 0) {
          while (row.length < column) row.push('');
          // `t="s"` indexes the shared table; everything else is the literal.
          row[column] = type === 's' ? (strings[Number(value)] ?? '') : value;
        }
        column = -1;
        type = '';
        value = '';
        return;
      }
      const reference = /\br="([A-Z]+\d+)"/.exec(tag)?.[1];
      column = reference ? columnIndex(reference) : row.length;
      type = /\bt="([^"]+)"/.exec(tag)?.[1] ?? '';
      value = '';
      // `<c r="B4"/>` is a styled empty cell.
      if (tag.endsWith('/')) {
        if (column >= 0) {
          while (row.length < column) row.push('');
          row[column] = '';
        }
        column = -1;
      }
      return;
    }

    // `<v>` is the value — for a formula cell, the result the writer cached.
    // `<is><t>` is an inline string. `<f>` is the formula itself and is not
    // read: this module does not calculate, and a formula printed into a cell
    // would read as the answer.
    if (!closing && local === 'v') {
      value += decodeXml(text);
      return;
    }
    if (local === 'is') {
      inInline = !closing;
      return;
    }
    if (!closing && local === 't' && inInline) value += decodeXml(text);
  });

  return { rows, truncated };
}

/** Sheet name to worksheet part, resolved through the workbook relationships. */
function sheetParts(workbook: string, rels: string | undefined): { name: string; part: string }[] {
  const targets = new Map<string, string>();
  scanXml(rels ?? '', (name, closing, tag) => {
    if (closing || localName(name) !== 'Relationship') return;
    const id = /\bId="([^"]+)"/.exec(tag)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(tag)?.[1];
    if (!id || !target) return;
    // Targets are relative to `xl/`, and may be written with a leading slash.
    targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
  });

  const sheets: { name: string; part: string }[] = [];
  scanXml(workbook, (name, closing, tag) => {
    if (closing || localName(name) !== 'sheet') return;
    const sheetName = /\bname="([^"]*)"/.exec(tag)?.[1];
    const id = /\br:id="([^"]+)"/.exec(tag)?.[1] ?? /\bid="([^"]+)"/.exec(tag)?.[1];
    const part = id ? targets.get(id) : undefined;
    if (sheetName === undefined || !part) return;
    sheets.push({ name: decodeXml(sheetName), part });
  });
  return sheets;
}

// --- The one entry point -----------------------------------------------------

/**
 * Read an Office Open XML container, or say what it is and why it was not read.
 *
 * Never throws: a malformed or hostile archive comes back as `UNREADABLE` with
 * the reason, because this is called from ingestion, where a file that will not
 * open is a finding on the record rather than a failed request.
 */
export function readOffice(bytes: Buffer): OfficeRead {
  let entries: ZipEntry[];
  try {
    entries = zipEntries(bytes);
  } catch (error) {
    return { kind: 'UNREADABLE', reason: `This archive's directory could not be read: ${(error as Error).message}` };
  }

  const names = new Set(entries.map((entry) => entry.name));

  // An Office file protected with a password is an OLE compound document
  // wrapping the encrypted package, not a readable ZIP — but some writers
  // still leave a ZIP shell, so it is worth naming.
  if (names.has('EncryptedPackage')) {
    return {
      kind: 'UNREADABLE',
      reason: 'This document is password-protected. Nothing can read it without the password. Ask for an unlocked copy.',
    };
  }

  try {
    if (names.has('word/document.xml')) {
      const xml = textOf(bytes, entries, 'word/document.xml') ?? '';
      const text = wordText(xml);
      if (text.length === 0) {
        return { kind: 'UNREADABLE', reason: 'This Word document carries no body text — its content is images, or it is empty.' };
      }
      return { kind: 'WORD', text };
    }

    if (names.has('xl/workbook.xml')) {
      const strings = sharedStrings(textOf(bytes, entries, 'xl/sharedStrings.xml') ?? '');
      const parts = sheetParts(
        textOf(bytes, entries, 'xl/workbook.xml') ?? '',
        textOf(bytes, entries, 'xl/_rels/workbook.xml.rels'),
      );
      const budget = { left: MAX_ROWS };
      const sheets: OfficeSheet[] = [];
      let truncated = false;

      for (const { name, part } of parts) {
        const xml = textOf(bytes, entries, part);
        if (xml === undefined) continue;
        const read = sheetRows(xml, strings, budget);
        truncated ||= read.truncated;
        if (read.rows.length > 0) sheets.push({ name, rows: read.rows });
      }

      if (sheets.length === 0) {
        return { kind: 'UNREADABLE', reason: 'This workbook has no sheet with anything in it.' };
      }

      // One text, sheet by sheet, tab-delimited — the shape the readers
      // downstream already handle, with each sheet named so a requirement can
      // be traced back to the tab it sits on.
      const text = sheets
        .map(({ name, rows }) => `${name}\n${rows.map((row) => row.join('\t')).join('\n')}`)
        .join('\n\n');
      return { kind: 'WORKBOOK', text, sheets, truncated };
    }
  } catch (error) {
    if (error instanceof ZipError) return { kind: 'UNREADABLE', reason: error.message };
    throw error;
  }

  if (names.has('ppt/presentation.xml')) {
    return {
      kind: 'UNREADABLE',
      reason:
        'This is a PowerPoint presentation. Nothing here reads one: a slide deck is a summary of a document, and a ' +
        'requirement quoted from a summary is not quoted from the tender.',
    };
  }

  if ([...names].some((name) => /\.ifc$/i.test(name))) {
    return {
      kind: 'UNREADABLE',
      reason:
        'This is an IFC model in a ZIP container. It carries geometry, not prose — the model reader on Design & BIM ' +
        'is what opens it.',
    };
  }

  return {
    kind: 'UNREADABLE',
    reason: 'This archive is not a Word document or a spreadsheet. It is held; its contents are not read.',
  };
}
