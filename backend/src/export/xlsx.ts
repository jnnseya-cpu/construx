import { zip, type ZipEntry } from './docx.ts';
import { documentOrigin, type ClientBranding } from './exporter.ts';
import { decodeImage, parseDataUri } from './image.ts';

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

// --- branding ---------------------------------------------------------------

/**
 * A brand colour as Excel's 8-hex ARGB (`AARRGGBB`).
 *
 * The colour arrives as the tenancy configured it: `#rrggbb` from the branding
 * form, but `rgba(r, g, b, a)` from the seeded default — so both are read rather
 * than the second silently falling back to grey the way a hex-only parser would.
 * Alpha is dropped because a spreadsheet fill is opaque. A value in neither form
 * falls back to a dark slate, so a header band is never white-on-white.
 */
export function brandArgb(colour: string, fallback = 'FF1F2933'): string {
  const raw = String(colour ?? '').trim();
  const asHex = /^#?([0-9a-f]{6})$/i.exec(raw);
  if (asHex) return `FF${asHex[1]!.toUpperCase()}`;
  const asRgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(raw);
  if (asRgb) {
    const channels = [asRgb[1], asRgb[2], asRgb[3]].map((n) => Math.min(255, Math.max(0, Number(n))));
    return `FF${channels.map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  }
  return fallback;
}

const EMU_PER_PX = 9525;
const LOGO_PX = 56;

type ResolvedLogo = { bytes: Buffer; ext: 'png' | 'jpeg'; width: number; height: number };

/**
 * The tenancy's mark as embeddable bytes, or nothing.
 *
 * Resolved from the inline `logoRef` data URI the branding form stores, or from
 * the evidence store by hash when a resolver is supplied. Only PNG and JPEG are
 * embedded — the two Excel reads without complaint — and an undecodable image is
 * left off rather than written as a broken picture, exactly as the PDF renderer
 * treats a logo it cannot read. A document with colour and a name but no mark is
 * still branded; one with a broken image is not.
 */
function resolveLogo(
  branding: ClientBranding,
  resolveImage?: (hash: string) => { bytes: Buffer; mime: string } | undefined,
): ResolvedLogo | undefined {
  let source: { bytes: Buffer; mime: string } | undefined;
  if (branding.logoRef) {
    const parsed = parseDataUri(branding.logoRef);
    if (parsed) source = { bytes: parsed.bytes, mime: parsed.mime };
  }
  if (!source && branding.logoEvidenceHash && resolveImage) {
    source = resolveImage(branding.logoEvidenceHash);
  }
  if (!source) return undefined;
  const mime = source.mime.toLowerCase();
  const ext = mime === 'image/png' ? 'png' : mime === 'image/jpeg' || mime === 'image/jpg' ? 'jpeg' : undefined;
  if (!ext) return undefined;
  try {
    const decoded = decodeImage(source.mime, source.bytes);
    return { bytes: source.bytes, ext, width: decoded.width, height: decoded.height };
  } catch {
    return undefined;
  }
}

/**
 * The styles the branded workbook uses. Index `1` — the one a header cell
 * selects with `s="1"` — becomes the brand band (white bold on the primary
 * colour), so every section's header row is branded without changing how a cell
 * is written. Index `2` is the cover title in the brand colour, `3` the legal
 * footer. The unbranded path keeps its own two-style sheet, so nothing that does
 * not pass branding changes.
 */
function brandedStyles(branding: ClientBranding): string {
  const band = brandArgb(branding.primaryColour);
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="4">' +
    '<font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>' +
    `<font><b/><sz val="20"/><color rgb="${band}"/><name val="Calibri"/></font>` +
    '<font><b/><sz val="10"/><color rgb="FF6B7680"/><name val="Calibri"/></font>' +
    '</fonts>' +
    '<fills count="2">' +
    '<fill><patternFill patternType="none"/></fill>' +
    `<fill><patternFill patternType="solid"><fgColor rgb="${band}"/><bgColor indexed="64"/></patternFill></fill>` +
    '</fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="4">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="1" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
    '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>'
  );
}

/**
 * The cover sheet: the issuing party in the brand colour, who the pack is
 * prepared for where that differs, and the legal footer — the same identity the
 * PDF and Word covers carry. Top rows are left clear for the mark when there is
 * one, so the logo floats above the text rather than over it.
 */
function coverSheetXml(branding: ClientBranding, hasLogo: boolean): string {
  const origin = documentOrigin(branding);
  const preparedFor =
    branding.issuingEntity && branding.clientName && branding.issuingEntity.trim() !== branding.clientName.trim()
      ? `Prepared for ${branding.clientName}`
      : '';
  const rows: string[] = [];
  let r = hasLogo ? 5 : 1;
  const put = (text: string, style: number): void => {
    if (text) {
      rows.push(
        `<row r="${r}"><c r="A${r}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c></row>`,
      );
    }
    r += 1;
  };
  put(origin, 2);
  put(preparedFor, 0);
  r += 1;
  put(branding.legalFooter, 3);

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<cols><col min="1" max="1" width="96" customWidth="1"/></cols>' +
    `<sheetData>${rows.join('')}</sheetData>` +
    (hasLogo ? '<drawing r:id="rId1"/>' : '') +
    '</worksheet>'
  );
}

/** The DrawingML that anchors the mark at the top-left of the cover sheet. */
function drawingXml(logo: ResolvedLogo): string {
  const cy = LOGO_PX * EMU_PER_PX;
  const cx = Math.round((logo.width / logo.height) * LOGO_PX) * EMU_PER_PX;
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<xdr:oneCellAnchor>' +
    '<xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>' +
    `<xdr:ext cx="${cx}" cy="${cy}"/>` +
    '<xdr:pic>' +
    '<xdr:nvPicPr><xdr:cNvPr id="1" name="Logo"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
    '<xdr:blipFill>' +
    '<a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId1"/>' +
    '<a:stretch><a:fillRect/></a:stretch>' +
    '</xdr:blipFill>' +
    `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>' +
    '</xdr:pic>' +
    '<xdr:clientData/>' +
    '</xdr:oneCellAnchor>' +
    '</xdr:wsDr>'
  );
}

/**
 * The file's own properties, naming the issuer as author and company. Invisible
 * on the page, and the first place anybody checks for where a document came
 * from — so on the customer's own instrument the honest answer there is the
 * customer, as the PDF and Word renderers already decided. No dates: they would
 * vary per render and break the byte-for-byte guarantee an export's hash rests
 * on.
 */
function corePropsXml(origin: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    `<dc:creator>${esc(origin)}</dc:creator>` +
    `<cp:lastModifiedBy>${esc(origin)}</cp:lastModifiedBy>` +
    '</cp:coreProperties>'
  );
}

function appPropsXml(origin: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
    `<Application>${esc(origin)}</Application>` +
    `<Company>${esc(origin)}</Company>` +
    '</Properties>'
  );
}

/**
 * A workbook, as bytes.
 *
 * Deterministic: the same sheets produce the same file, because the ZIP writer
 * uses a fixed timestamp. That is what lets an export be hashed and the hash
 * mean something — two exports of one pack are provably the same instrument.
 *
 * `branding`, when given, makes the workbook the tenancy's own instrument rather
 * than a bare grid: a cover sheet carrying the mark, the issuing name in the
 * brand colour and the legal footer; the brand colour on every section's header
 * row; and the issuer named in the file's properties. It is woven in without
 * disturbing a single data cell — the cover is an added first sheet and the
 * header styling is a style change, not a structural one — so a buyer's returned
 * questionnaire keeps its numbering and section order. Omit `branding` and the
 * file is byte-for-byte the unbranded grid it always was.
 */
export function renderXlsx(
  sheets: Sheet[],
  branding?: ClientBranding,
  resolveImage?: (hash: string) => { bytes: Buffer; mime: string } | undefined,
): Uint8Array {
  if (sheets.length === 0) {
    throw new Error('A workbook needs at least one sheet');
  }

  const used = new Set<string>();
  const logo = branding ? resolveLogo(branding, resolveImage) : undefined;
  // The cover is the first sheet when branded, so section sheets follow it. Its
  // name is reserved first, so a section literally called "Cover" is the one
  // that gets disambiguated.
  const dataSheets = sheets.map((sheet) => ({ ...sheet, name: sheetName(sheet.name, used) }));
  const coverName = branding ? sheetName('Cover', used) : '';
  const sheetXmls: string[] = branding
    ? [coverSheetXml(branding, Boolean(logo)), ...dataSheets.map((sheet) => sheetXml(sheet))]
    : dataSheets.map((sheet) => sheetXml(sheet));
  const sheetTitles = branding ? [coverName, ...dataSheets.map((s) => s.name)] : dataSheets.map((s) => s.name);

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    (logo ? `<Default Extension="${logo.ext}" ContentType="image/${logo.ext === 'jpeg' ? 'jpeg' : 'png'}"/>` : '') +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    sheetTitles
      .map(
        (_title, index) =>
          `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join('') +
    (logo
      ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>'
      : '') +
    (branding
      ? '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
      : '') +
    '</Types>';

  const packageRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    (branding
      ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
      : '') +
    '</Relationships>';

  const workbookXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    sheetTitles
      .map((title, index) => `<sheet name="${esc(title)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
      .join('') +
    '</sheets></workbook>';

  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheetTitles
      .map(
        (_title, index) =>
          `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
      )
      .join('') +
    `<Relationship Id="rId${sheetTitles.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    '</Relationships>';

  const stylesXml = branding
    ? brandedStyles(branding)
    : // Two formats and nothing else: the default, and bold for a header row.
      // `s="1"` on a cell selects the second `xf`, which is the bold one.
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
      '<borders count="1"><border/></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
      '</styleSheet>';

  const entries: ZipEntry[] = [
    { path: '[Content_Types].xml', bytes: Buffer.from(contentTypes, 'utf8') },
    { path: '_rels/.rels', bytes: Buffer.from(packageRels, 'utf8') },
    { path: 'xl/workbook.xml', bytes: Buffer.from(workbookXml, 'utf8') },
    { path: 'xl/_rels/workbook.xml.rels', bytes: Buffer.from(workbookRels, 'utf8') },
    { path: 'xl/styles.xml', bytes: Buffer.from(stylesXml, 'utf8') },
    ...sheetXmls.map((xml, index) => ({
      path: `xl/worksheets/sheet${index + 1}.xml`,
      bytes: Buffer.from(xml, 'utf8'),
    })),
  ];

  if (logo) {
    // The cover is sheet1, so its drawing relationship and the drawing itself
    // carry the mark into the file.
    entries.push(
      {
        path: 'xl/worksheets/_rels/sheet1.xml.rels',
        bytes: Buffer.from(
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>' +
            '</Relationships>',
          'utf8',
        ),
      },
      { path: 'xl/drawings/drawing1.xml', bytes: Buffer.from(drawingXml(logo), 'utf8') },
      {
        path: 'xl/drawings/_rels/drawing1.xml.rels',
        bytes: Buffer.from(
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.${logo.ext}"/>` +
            '</Relationships>',
          'utf8',
        ),
      },
      { path: `xl/media/image1.${logo.ext}`, bytes: logo.bytes },
    );
  }

  if (branding) {
    const origin = documentOrigin(branding);
    entries.push(
      { path: 'docProps/core.xml', bytes: Buffer.from(corePropsXml(origin), 'utf8') },
      { path: 'docProps/app.xml', bytes: Buffer.from(appPropsXml(origin), 'utf8') },
    );
  }

  return new Uint8Array(zip(entries));
}
