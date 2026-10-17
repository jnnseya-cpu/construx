import { zip, type ZipEntry } from './docx.ts';

/**
 * A spreadsheet, written by hand.
 *
 * ## Why this exists at all
 *
 * The platform could already produce PDF, DOCX, CSV, HTML and a JSON bundle,
 * and CSV covers most of what a spreadsheet is for. It does not cover the one
 * thing a bid pack needs: **a questionnaire returned in its own structure.**
 * A buyer who issues an XLSX questionnaire with a sheet per section and a row
 * per numbered question expects it back the same way, and a CSV of the same
 * content is a file somebody has to rebuild by hand — which is where the
 * numbering stops matching and the submission starts failing a format check.
 *
 * ## Why it is written rather than installed
 *
 * Zero runtime dependencies is settled, and an `.xlsx` is the same container as
 * the `.docx` this module already writes by hand: a ZIP of XML parts with a
 * content-types declaration and relationships. It reuses `zip()` from `docx.ts`
 * for exactly that reason — a second ZIP implementation would be a second place
 * for the fixed timestamp, the CRC and the central directory to be subtly
 * wrong, and only one of them would be the one anybody tested.
 *
 * ## What it deliberately does not do
 *
 * No formulas, no styling beyond a bold header row, no merged cells, no charts.
 * Every one of those is a feature somebody would want and none of them is what
 * a returned questionnaire needs. A writer that supported them would be a
 * spreadsheet library, which is a thing to install rather than a thing to keep.
 *
 * Values are written as **inline strings**, not into a shared string table.
 * The table is the format's compression trick and it is where a hand-written
 * writer goes wrong: an index off by one silently moves every cell's content to
 * a neighbouring cell, and the file still opens. Inline strings cost bytes the
 * deflate gets most of back, and they cannot be misaligned.
 */

export type Sheet = {
  /** The tab name. Excel refuses some characters and a name over 31 characters. */
  name: string;
  /** The first row, bolded. Absent for a sheet with no header. */
  headers?: string[];
  rows: Array<Array<string | number | null>>;
  /** Column widths in characters, where the default would truncate. */
  widths?: number[];
};

/** Excel's own restrictions on a tab name, applied rather than discovered. */
const FORBIDDEN = /[:\\/?*[\]]/g;

export function sheetName(raw: string, used: Set<string> = new Set()): string {
  let name = raw.replace(FORBIDDEN, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Sheet';
  // Two tabs with one name is a file Excel refuses to open, and the most likely
  // source of it is two questionnaire sections whose headings differ past the
  // thirty-first character.
  if (used.has(name.toLowerCase())) {
    let suffix = 2;
    while (used.has(`${name.slice(0, 28)} ${suffix}`.toLowerCase())) suffix += 1;
    name = `${name.slice(0, 28)} ${suffix}`;
  }
  used.add(name.toLowerCase());
  return name;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Characters the format forbids outright. A tab or a vertical tab pasted
    // out of a PDF questionnaire produces a file that will not open, and
    // stripping it is better than a workbook nobody can read.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/** `A`, `B`, … `AA`. Needed because a cell reference is a column letter and a row. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function cell(column: number, row: number, value: string | number | null, bold: boolean): string {
  if (value === null || value === '') return '';
  const ref = `${columnLetter(column)}${row}`;
  const style = bold ? ' s="1"' : '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"${style}><v>${value}</v></c>`;
  }
  // `t="inlineStr"` with the text in the cell. See the note above on why there
  // is no shared string table.
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(String(value))}</t></is></c>`;
}

function sheetXml(sheet: Sheet): string {
  const rows: string[] = [];
  let rowNumber = 1;

  if (sheet.headers && sheet.headers.length > 0) {
    rows.push(
      `<row r="${rowNumber}">${sheet.headers.map((value, column) => cell(column, rowNumber, value, true)).join('')}</row>`,
    );
    rowNumber += 1;
  }
  for (const row of sheet.rows) {
    rows.push(
      `<row r="${rowNumber}">${row.map((value, column) => cell(column, rowNumber, value, false)).join('')}</row>`,
    );
    rowNumber += 1;
  }

  const columns = (sheet.widths ?? [])
    .map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`)
    .join('');

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    (columns ? `<cols>${columns}</cols>` : '') +
    `<sheetData>${rows.join('')}</sheetData>` +
    '</worksheet>'
  );
}

/**
 * A workbook, as bytes.
 *
 * Deterministic: the same sheets produce the same file, because the ZIP writer
 * uses a fixed timestamp. That is what lets an export be hashed and the hash
 * mean something — two exports of one pack are provably the same instrument.
 */
export function renderXlsx(sheets: Sheet[]): Uint8Array {
  if (sheets.length === 0) {
    throw new Error('A workbook needs at least one sheet');
  }

  const used = new Set<string>();
  const named = sheets.map((sheet) => ({ ...sheet, name: sheetName(sheet.name, used) }));

  const entries: ZipEntry[] = [
    {
      path: '[Content_Types].xml',
      bytes: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
          named
            .map(
              (_sheet, index) =>
                `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
            )
            .join('') +
          '</Types>',
        'utf8',
      ),
    },
    {
      path: '_rels/.rels',
      bytes: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '</Relationships>',
        'utf8',
      ),
    },
    {
      path: 'xl/workbook.xml',
      bytes: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
          named
            .map(
              (sheet, index) =>
                `<sheet name="${esc(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
            )
            .join('') +
          '</sheets></workbook>',
        'utf8',
      ),
    },
    {
      path: 'xl/_rels/workbook.xml.rels',
      bytes: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          named
            .map(
              (_sheet, index) =>
                `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
            )
            .join('') +
          `<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
          '</Relationships>',
        'utf8',
      ),
    },
    {
      // Two formats and nothing else: the default, and bold for a header row.
      // `s="1"` on a cell selects the second `xf`, which is the bold one.
      path: 'xl/styles.xml',
      bytes: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
          '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
          '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
          '<borders count="1"><border/></borders>' +
          '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
          '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
          '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
          '</styleSheet>',
        'utf8',
      ),
    },
    ...named.map((sheet, index) => ({
      path: `xl/worksheets/sheet${index + 1}.xml`,
      bytes: Buffer.from(sheetXml(sheet), 'utf8'),
    })),
  ];

  return new Uint8Array(zip(entries));
}
