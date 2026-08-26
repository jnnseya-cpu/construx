import { decodeLogo, type DecodedImage } from './image.ts';
import type { DocumentBlock, ExportDocument } from './exporter.ts';

/**
 * PDF, written by hand.
 *
 * The exporter has always produced a structured document and rendered it to
 * HTML. What an adjudicator, an insurer or a court actually asks for is a PDF,
 * and "print the web page" is not an answer when the document has to carry a
 * content hash that means something — a browser's print pipeline re-flows the
 * content, so what was hashed and what was printed are not the same artefact.
 *
 * A PDF is a text format with a byte-offset index at the end, which is the only
 * fiddly part. Text is drawn with the standard 14 fonts, which every reader has
 * and none of which need embedding — that is what makes this possible without a
 * dependency, and it is also why the font metrics below are present as data:
 * without real widths, lines cannot be broken at the right place and text runs
 * off the page. Those numbers are Adobe's published AFM widths, not estimates.
 *
 * What this does not do is typeset. There is no hyphenation, no kerning, no
 * widow control and no vector graphics. It lays out headings, paragraphs,
 * key-value pairs, lists and tables on A4, breaks pages where the content runs
 * out of room, and repeats table headers across a break. That is the whole of
 * what these documents contain.
 */

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = { top: 56, bottom: 64, left: 56, right: 56 };
const CONTENT_WIDTH = A4.width - MARGIN.left - MARGIN.right;

type FontName = 'Helvetica' | 'Helvetica-Bold' | 'Courier';
const FONT_KEY: Record<FontName, string> = { Helvetica: 'F1', 'Helvetica-Bold': 'F2', Courier: 'F3' };

/**
 * Adobe AFM widths for the printable range, in 1/1000 em.
 *
 * Data rather than a guess. An average-width approximation puts a long line
 * either off the right margin or well short of it, and a legal document with
 * text running into the page edge is not one anybody will accept.
 */
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722,
  778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556,
  278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260,
  334, 584,
];

const HELVETICA_BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833,
  722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611,
  556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389,
  280, 389, 584,
];

/**
 * Characters this codebase actually uses that are not plain ASCII, mapped to
 * WinAnsiEncoding. Em dashes and curly quotes are all over the domain text, and
 * dropping them would put mojibake in a document going to a court.
 */
const WIN_ANSI: Record<string, number> = {
  '—': 0x97, // em dash
  '–': 0x96, // en dash
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '…': 0x85, // ellipsis
  '•': 0x95, // bullet
  '£': 0xa3, // pound
  '€': 0x80, // euro
  '±': 0xb1,
  '²': 0xb2,
  '³': 0xb3,
  '×': 0xd7,
  '°': 0xb0,
  '©': 0xa9,
  '®': 0xae,
};

/** One byte per character, in the encoding the fonts are declared with. */
function toWinAnsi(text: string): number[] {
  const bytes: number[] = [];
  for (const character of text) {
    const code = character.codePointAt(0) ?? 63;
    if (code >= 32 && code <= 126) bytes.push(code);
    else if (WIN_ANSI[character] !== undefined) bytes.push(WIN_ANSI[character]!);
    else if (code >= 160 && code <= 255) bytes.push(code);
    // Anything else has no representation in this encoding. A question mark is
    // visibly wrong, which is the point — silently dropping it would leave a
    // sentence that reads correctly and says something different.
    else bytes.push(63);
  }
  return bytes;
}

/** A PDF literal string: WinAnsi bytes with the three characters that must be escaped. */
function pdfString(text: string): string {
  let out = '(';
  for (const byte of toWinAnsi(text)) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else if (byte < 32 || byte > 126) out += `\\${byte.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(byte);
  }
  return `${out})`;
}

function widthOf(text: string, font: FontName, size: number): number {
  const table = font === 'Helvetica-Bold' ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let total = 0;
  for (const byte of toWinAnsi(text)) {
    // Courier is monospaced at 600. Outside the tabulated range, fall back to
    // the width of a lowercase n, which is close enough for a stray accent and
    // never produces a line that overflows by more than a character.
    if (font === 'Courier') total += 600;
    else total += byte >= 32 && byte <= 126 ? (table[byte - 32] ?? 556) : 556;
  }
  return (total / 1000) * size;
}

/** Break text into lines that fit. Long unbreakable words are cut rather than allowed to overflow. */
function wrap(text: string, font: FontName, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = '';

  for (const word of text.split(/\s+/).filter((w) => w.length > 0)) {
    const candidate = current ? `${current} ${word}` : word;
    if (widthOf(candidate, font, size) <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current) lines.push(current);

    // A hash or a URL has no spaces in it and would otherwise run off the page.
    if (widthOf(word, font, size) > maxWidth) {
      let chunk = '';
      for (const character of word) {
        if (widthOf(chunk + character, font, size) > maxWidth) {
          lines.push(chunk);
          chunk = character;
        } else chunk += character;
      }
      current = chunk;
    } else current = word;
  }

  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

type Op = string;

/** Page construction, with a cursor that knows when it has run out of room. */
class Sheet {
  readonly pages: Op[][] = [];
  #ops: Op[] = [];
  #y = A4.height - MARGIN.top;

  readonly #onNewPage?: (sheet: Sheet) => void;

  constructor(onNewPage?: (sheet: Sheet) => void) {
    this.#onNewPage = onNewPage;
    this.pages.push(this.#ops);
  }

  get y(): number {
    return this.#y;
  }

  /** Make room for `height` points, starting a page if there is none. */
  reserve(height: number): void {
    if (this.#y - height >= MARGIN.bottom) return;
    this.#ops = [];
    this.pages.push(this.#ops);
    this.#y = A4.height - MARGIN.top;
    this.#onNewPage?.(this);
  }

  advance(points: number): void {
    this.#y -= points;
  }

  text(value: string, options: { font?: FontName; size?: number; x?: number; colour?: [number, number, number] } = {}): void {
    const font = options.font ?? 'Helvetica';
    const size = options.size ?? 10;
    const x = options.x ?? MARGIN.left;
    const [r, g, b] = options.colour ?? [0, 0, 0];

    this.#ops.push(
      `BT`,
      `${r} ${g} ${b} rg`,
      `/${FONT_KEY[font]} ${size} Tf`,
      `1 0 0 1 ${x.toFixed(2)} ${this.#y.toFixed(2)} Tm`,
      `${pdfString(value)} Tj`,
      `ET`,
    );
  }

  rule(colour: [number, number, number] = [0.85, 0.85, 0.85], width = CONTENT_WIDTH): void {
    const [r, g, b] = colour;
    this.#ops.push(
      `${r} ${g} ${b} RG`,
      `0.6 w`,
      `${MARGIN.left} ${this.#y.toFixed(2)} m ${(MARGIN.left + width).toFixed(2)} ${this.#y.toFixed(2)} l S`,
    );
  }

  /**
   * Draw a named image XObject at the cursor, right-aligned in the header band.
   *
   * Right, not left: the document title and the client's name read from the
   * left margin, and a mark placed there displaces the words somebody actually
   * reads first. The `cm` operator both scales and positions in one matrix —
   * PDF images are drawn into a unit square, so the width and height *are* the
   * scale.
   */
  image(name: string, width: number, height: number): void {
    const x = A4.width - MARGIN.right - width;
    const y = this.#y - height + 6;
    this.#ops.push(
      `q`,
      `${width.toFixed(2)} 0 0 ${height.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm`,
      `/${name} Do`,
      `Q`,
    );
  }

  fill(x: number, y: number, width: number, height: number, colour: [number, number, number]): void {
    const [r, g, b] = colour;
    this.#ops.push(`${r} ${g} ${b} rg`, `${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re f`);
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const cleaned = hex.replace('#', '');
  if (cleaned.length !== 6) return [0.1, 0.1, 0.1];
  const value = Number.parseInt(cleaned, 16);
  if (Number.isNaN(value)) return [0.1, 0.1, 0.1];
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

function renderBlock(sheet: Sheet, block: DocumentBlock, accent: [number, number, number]): void {
  switch (block.kind) {
    case 'HEADING': {
      const size = block.level === 1 ? 17 : block.level === 2 ? 13 : 11;
      sheet.reserve(size + 18);
      sheet.advance(block.level === 1 ? 6 : 16);
      for (const line of wrap(block.text, 'Helvetica-Bold', size, CONTENT_WIDTH)) {
        sheet.reserve(size + 6);
        sheet.text(line, { font: 'Helvetica-Bold', size, colour: block.level === 1 ? accent : [0.1, 0.1, 0.1] });
        sheet.advance(size + 3);
      }
      if (block.level <= 2) {
        sheet.advance(3);
        sheet.rule();
      }
      sheet.advance(9);
      return;
    }

    case 'PARAGRAPH': {
      for (const line of wrap(block.text, 'Helvetica', 10, CONTENT_WIDTH)) {
        sheet.reserve(14);
        sheet.text(line, { size: 10 });
        sheet.advance(14);
      }
      sheet.advance(6);
      return;
    }

    case 'KEY_VALUES': {
      const labelWidth = 170;
      for (const row of block.rows) {
        const valueLines = wrap(row.value, 'Helvetica', 10, CONTENT_WIDTH - labelWidth - 10);
        sheet.reserve(valueLines.length * 13 + 4);
        sheet.text(row.label, { size: 10, colour: [0.42, 0.42, 0.45] });
        valueLines.forEach((line, index) => {
          if (index > 0) sheet.advance(13);
          sheet.text(line, { size: 10, x: MARGIN.left + labelWidth });
        });
        sheet.advance(15);
      }
      sheet.advance(6);
      return;
    }

    case 'LIST': {
      block.items.forEach((item, index) => {
        const marker = block.ordered ? `${index + 1}.` : '•';
        const indent = 18;
        const lines = wrap(item, 'Helvetica', 10, CONTENT_WIDTH - indent);
        sheet.reserve(lines.length * 13 + 2);
        sheet.text(marker, { size: 10, colour: [0.42, 0.42, 0.45] });
        lines.forEach((line, lineIndex) => {
          if (lineIndex > 0) {
            sheet.advance(13);
            sheet.reserve(13);
          }
          sheet.text(line, { size: 10, x: MARGIN.left + indent });
        });
        sheet.advance(15);
      });
      sheet.advance(6);
      return;
    }

    case 'TABLE': {
      renderTable(sheet, block, accent);
      return;
    }

    case 'ATTESTATION': {
      sheet.reserve(88);
      sheet.advance(6);
      const top = sheet.y + 12;
      sheet.fill(MARGIN.left, top - 92, CONTENT_WIDTH, 92, [0.97, 0.97, 0.98]);
      sheet.fill(MARGIN.left, top - 92, 3, 92, accent);

      sheet.advance(6);
      sheet.text('Attestation', { font: 'Helvetica-Bold', size: 11, x: MARGIN.left + 14 });
      sheet.advance(16);
      for (const [label, value] of [
        ['State root', block.rootHash],
        ['Chain head', block.chainHead],
      ]) {
        sheet.text(label!, { size: 9, x: MARGIN.left + 14, colour: [0.42, 0.42, 0.45] });
        sheet.text(value!.slice(0, 78), { font: 'Courier', size: 8, x: MARGIN.left + 90 });
        sheet.advance(13);
      }
      for (const line of wrap(block.instructions, 'Helvetica', 9, CONTENT_WIDTH - 28)) {
        sheet.text(line, { size: 9, x: MARGIN.left + 14, colour: [0.3, 0.3, 0.32] });
        sheet.advance(12);
      }
      sheet.advance(14);
      return;
    }
  }
}

function renderTable(sheet: Sheet, block: Extract<DocumentBlock, { kind: 'TABLE' }>, accent: [number, number, number]): void {
  const columns = block.headers.length;
  if (columns === 0) return;

  // Column widths from the widest cell in each, then scaled to the page. A
  // fixed even split wastes half a page on a date column and cuts a narrative
  // one to ribbons.
  const natural = block.headers.map((header, index) => {
    const cells = block.rows.map((row) => row[index] ?? '');
    return Math.max(widthOf(header, 'Helvetica-Bold', 9), ...cells.map((c) => widthOf(c, 'Helvetica', 9)), 30);
  });
  const total = natural.reduce((sum, w) => sum + w, 0) + columns * 12;
  const scale = CONTENT_WIDTH / total;
  const widths = natural.map((w) => (w + 12) * scale);

  if (block.caption) {
    sheet.reserve(16);
    sheet.text(block.caption, { font: 'Helvetica-Bold', size: 10 });
    sheet.advance(16);
  }

  const drawHeader = (): void => {
    sheet.reserve(20);
    sheet.fill(MARGIN.left, sheet.y - 5, CONTENT_WIDTH, 18, [0.95, 0.95, 0.96]);
    let x = MARGIN.left + 6;
    block.headers.forEach((header, index) => {
      const [line] = wrap(header, 'Helvetica-Bold', 9, widths[index]! - 12);
      sheet.text(line ?? '', { font: 'Helvetica-Bold', size: 9, x, colour: [0.25, 0.25, 0.28] });
      x += widths[index]!;
    });
    sheet.advance(20);
  };

  drawHeader();

  for (const row of block.rows) {
    const cellLines = row.map((cell, index) => wrap(cell ?? '', 'Helvetica', 9, (widths[index] ?? CONTENT_WIDTH) - 12));
    const height = Math.max(...cellLines.map((lines) => lines.length)) * 12 + 5;

    const before = sheet.y;
    sheet.reserve(height);
    // The header is repeated after a break. A table continuing onto a page with
    // no headings is unreadable, and these documents are read by people who did
    // not build them.
    if (sheet.y > before) drawHeader();

    let x = MARGIN.left + 6;
    const rowTop = sheet.y;
    cellLines.forEach((lines, index) => {
      lines.forEach((line, lineIndex) => {
        sheet.advance(lineIndex === 0 ? 0 : 12);
        sheet.text(line, { size: 9, x });
      });
      // Back to the top of the row for the next column.
      sheet.advance(-(lines.length - 1) * 12);
      x += widths[index] ?? 0;
    });

    sheet.advance(height);
    sheet.rule([0.9, 0.9, 0.91]);
    if (rowTop < 0) sheet.text('', { colour: accent });
  }

  sheet.advance(12);
}

/**
 * Render a document to PDF bytes.
 *
 * Every page carries the client's name and the document reference, and every
 * page is numbered — a page of an evidence bundle that has become separated
 * from the rest of it should still say what it belongs to.
 */
export function renderPdf(document: ExportDocument): Uint8Array {
  const accent = hexToRgb(document.branding.primaryColour);

  // The client's own mark, if they gave one. A logo that cannot be decoded is a
  // mistake somebody needs to hear about, not something to swallow — but it
  // must not stop an evidence bundle being produced, so the document is drawn
  // without it and the reason travels back to the caller.
  let logo: DecodedImage | undefined;
  let logoRefused: string | undefined;
  try {
    logo = decodeLogo(document.branding.logoRef);
  } catch (error) {
    logoRefused = error instanceof Error ? error.message : String(error);
  }

  // Scaled to a fixed height so a wide mark and a square one sit the same on
  // the page. Height, not width: a header is a band, and its depth is what must
  // stay constant.
  const LOGO_HEIGHT = 22;
  const logoWidth = logo ? (logo.width / logo.height) * LOGO_HEIGHT : 0;

  const header = (sheet: Sheet): void => {
    if (logo) sheet.image('Logo', logoWidth, LOGO_HEIGHT);
    sheet.text(document.branding.clientName, { font: 'Helvetica-Bold', size: 9, colour: accent });
    // The reference sits left of the mark rather than under it. Right-aligning
    // both put the logo on top of the reference — which is the one string on
    // the page that identifies the document, and the last thing that should be
    // obscured by decoration.
    sheet.text(document.reference, {
      size: 9,
      x: A4.width - MARGIN.right - widthOf(document.reference, 'Helvetica', 9) - (logo ? logoWidth + 12 : 0),
      colour: [0.45, 0.45, 0.48],
    });
    sheet.advance(6);
    sheet.rule(accent);
    sheet.advance(20);
  };

  const sheet = new Sheet(header);
  header(sheet);
  void logoRefused;

  for (const block of document.blocks) renderBlock(sheet, block, accent);

  // The footer goes on afterwards, at a fixed position, so it does not compete
  // with the flow for space.
  const footerOps = (pageNumber: number, pageCount: number): string[] => {
    const left = `${document.reference} · ${document.audience} · generated ${document.generatedAt.slice(0, 16).replace('T', ' ')}`;
    const right = `Page ${pageNumber} of ${pageCount}`;
    const hash = `Content hash ${document.contentHash}`;
    return [
      `0.72 0.72 0.74 RG`,
      `0.6 w`,
      `${MARGIN.left} 48 m ${(A4.width - MARGIN.right).toFixed(2)} 48 l S`,
      `BT`,
      `0.42 0.42 0.45 rg`,
      `/F1 8 Tf`,
      `1 0 0 1 ${MARGIN.left} 36 Tm`,
      `${pdfString(left)} Tj`,
      `ET`,
      `BT`,
      `0.42 0.42 0.45 rg`,
      `/F1 8 Tf`,
      `1 0 0 1 ${(A4.width - MARGIN.right - widthOf(right, 'Helvetica', 8)).toFixed(2)} 36 Tm`,
      `${pdfString(right)} Tj`,
      `ET`,
      `BT`,
      `0.55 0.55 0.58 rg`,
      `/F3 7 Tf`,
      `1 0 0 1 ${MARGIN.left} 25 Tm`,
      `${pdfString(hash)} Tj`,
      `ET`,
    ];
  };

  const pageCount = sheet.pages.length;
  const streams = sheet.pages.map((ops, index) => [...ops, ...footerOps(index + 1, pageCount)].join('\n'));

  return assemble(streams, document.title, document.branding.clientName, logo);
}

/**
 * Put the objects together and build the cross-reference table.
 *
 * The offsets are the only part a reader is strict about: every one is the byte
 * position of the start of its object, and a file whose xref is wrong opens as
 * a blank page in some readers and not at all in others.
 */
function assemble(streams: string[], title: string, author: string, logo?: DecodedImage): Uint8Array {
  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length;
  };

  const catalogId = 1;
  const pagesId = 2;
  objects.push('', ''); // reserved for catalog and pages, which need the page ids

  const fontIds = {
    F1: add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
    F2: add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'),
    F3: add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>'),
  };

  // The client's mark, as one XObject shared by every page. Embedded once and
  // referenced repeatedly: a twenty-page evidence bundle must not carry twenty
  // copies of the same logo.
  let logoId: number | undefined;
  if (logo) {
    const colourSpace = logo.components === 1 ? '/DeviceGray' : '/DeviceRGB';
    logoId = add(
      `<< /Type /XObject /Subtype /Image /Width ${logo.width} /Height ${logo.height} ` +
        `/ColorSpace ${colourSpace} /BitsPerComponent ${logo.bitsPerComponent} ` +
        `/Filter /${logo.filter} /Length ${logo.data.length} >>\nstream\n${logo.data.toString('latin1')}\nendstream`,
    );
  }

  const resources =
    `<< /Font << /F1 ${fontIds.F1} 0 R /F2 ${fontIds.F2} 0 R /F3 ${fontIds.F3} 0 R >> ` +
    `${logoId ? `/XObject << /Logo ${logoId} 0 R >> ` : ''}>>`;

  const pageIds: number[] = [];
  for (const stream of streams) {
    const length = Buffer.byteLength(stream, 'latin1');
    const contentId = add(`<< /Length ${length} >>\nstream\n${stream}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] ` +
          `/Resources ${resources} /Contents ${contentId} 0 R >>`,
      ),
    );
  }

  objects[pagesId - 1] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`;
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;

  const infoId = add(
    `<< /Title ${pdfString(title)} /Author ${pdfString(author)} /Producer ${pdfString('CONSTRUX')} ` +
      `/CreationDate ${pdfString(pdfDate())} >>`,
  );

  let file = '%PDF-1.7\n%âãÏÓ\n';
  const offsets: number[] = [];

  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(file, 'latin1'));
    file += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(file, 'latin1');
  file += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) file += `${String(offset).padStart(10, '0')} 00000 n \n`;
  file += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(file, 'latin1'));
}

function pdfDate(): string {
  const now = new Date().toISOString();
  return `D:${now.slice(0, 4)}${now.slice(5, 7)}${now.slice(8, 10)}${now.slice(11, 13)}${now.slice(14, 16)}${now.slice(17, 19)}Z`;
}
