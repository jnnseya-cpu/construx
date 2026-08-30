import * as geo from '../domain/geometry.ts';
import { decodeImage, decodeLogo, UnsupportedImageError, type DecodedImage } from './image.ts';
import { documentOrigin, type DocumentBlock, type ExportDocument } from './exporter.ts';

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

/**
 * A string for the document catalogue — the title, the author, the producer.
 *
 * Not `pdfString`. That one encodes to WinAnsi, which is right for a content
 * stream because the fonts are declared with `/WinAnsiEncoding`; but a literal
 * string *outside* a content stream is read as PDFDocEncoding, and the two
 * disagree above 0x7F. The visible symptom was a report titled "Site visit
 * report Š SV-001" in the viewer's tab, where the em-dash had been read under
 * the wrong table — and the same fault turns "Société Générale" into noise on
 * every document that client is ever sent.
 *
 * The format's own answer is UTF-16BE behind a byte-order mark, which every
 * reader understands unambiguously. Used only where it is needed, so an
 * ordinary ASCII title stays a readable literal in the file.
 */
function pdfTextString(text: string): string {
  if (!/[^\x20-\x7e]/.test(text)) return pdfString(text);

  let hex = 'FEFF';
  const utf16 = Buffer.from(text, 'utf16le');
  // Swap each pair: Node writes UTF-16LE, PDF wants big-endian.
  for (let i = 0; i < utf16.length; i += 2) {
    hex += utf16[i + 1]!.toString(16).padStart(2, '0') + utf16[i]!.toString(16).padStart(2, '0');
  }
  return `<${hex.toUpperCase()}>`;
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

  /**
   * Place a photograph in the flow, at the left margin, and move the cursor
   * past it.
   *
   * Separate from `image` above rather than a flag on it: the header mark is
   * decoration placed against the right edge and deliberately does not move the
   * cursor, while a photograph is content and the next block has to start below
   * it. One method doing both would be one method with two behaviours.
   */
  photo(name: string, width: number, height: number): void {
    const y = this.#y - height;
    this.#ops.push(
      `q`,
      `${width.toFixed(2)} 0 0 ${height.toFixed(2)} ${MARGIN.left.toFixed(2)} ${y.toFixed(2)} cm`,
      `/${name} Do`,
      `Q`,
    );
    this.#y = y;
  }

  /**
   * Draw a closed polygon, in absolute page points.
   *
   * The one primitive a scale drawing needs that a flowing document does not.
   * Everything else on a sheet is text, rules and rectangles; a site plan is
   * arbitrary rings, and drawing them as a run of `re` rectangles would be a
   * plan of rectangles rather than a plan of the site.
   *
   * Fill and stroke are separate because a zone wants both — a wash to read at
   * a glance and a line to measure to — and an exclusion wants a hatch, which
   * is the same path stroked without a fill.
   */
  polygon(
    points: Array<{ x: number; y: number }>,
    options: { fill?: [number, number, number]; stroke?: [number, number, number]; width?: number; dashed?: boolean } = {},
  ): void {
    if (points.length < 2) return;
    const first = points[0]!;
    this.#ops.push('q');
    if (options.dashed) this.#ops.push('[3 2] 0 d');
    if (options.fill) this.#ops.push(`${options.fill[0]} ${options.fill[1]} ${options.fill[2]} rg`);
    if (options.stroke) this.#ops.push(`${options.stroke[0]} ${options.stroke[1]} ${options.stroke[2]} RG`);
    this.#ops.push(`${(options.width ?? 0.8).toFixed(2)} w`, `${first.x.toFixed(2)} ${first.y.toFixed(2)} m`);
    for (const point of points.slice(1)) this.#ops.push(`${point.x.toFixed(2)} ${point.y.toFixed(2)} l`);
    this.#ops.push('h');
    // `B` fills and strokes in one operation, which keeps the fill exactly
    // inside its own outline. Filling and stroking as two paths leaves a
    // half-line-width gap at every vertex on a scaled drawing.
    this.#ops.push(options.fill && options.stroke ? 'B' : options.fill ? 'f' : 'S');
    this.#ops.push('Q');
  }

  /** A single segment, for a north arrow, a scale bar or a leader line. */
  segment(from: { x: number; y: number }, to: { x: number; y: number }, colour: [number, number, number], width = 0.8): void {
    this.#ops.push(
      'q',
      `${colour[0]} ${colour[1]} ${colour[2]} RG`,
      `${width.toFixed(2)} w`,
      `${from.x.toFixed(2)} ${from.y.toFixed(2)} m ${to.x.toFixed(2)} ${to.y.toFixed(2)} l S`,
      'Q',
    );
  }

  /** Text at an absolute position, for a label on a drawing. */
  textAt(value: string, x: number, y: number, options: { font?: FontName; size?: number; colour?: [number, number, number] } = {}): void {
    const [r, g, b] = options.colour ?? [0, 0, 0];
    this.#ops.push(
      'BT',
      `${r} ${g} ${b} rg`,
      `/${FONT_KEY[options.font ?? 'Helvetica']} ${options.size ?? 7} Tf`,
      `1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm`,
      `${pdfString(value)} Tj`,
      'ET',
    );
  }

  fill(x: number, y: number, width: number, height: number, colour: [number, number, number]): void {
    const [r, g, b] = colour;
    this.#ops.push(`${r} ${g} ${b} rg`, `${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re f`);
  }

  /**
   * Place an image at an absolute position, without touching the cursor.
   *
   * A third placement method rather than a flag on the other two, for the same
   * reason those are separate: `image` is right-aligned decoration in a header
   * band and `photo` is content that pushes the flow down. This is neither — it
   * is a cover filling a region the caller has already decided on, and it is
   * clipped to the page by the page itself.
   */
  cover(name: string, width: number, height: number, x: number, y: number): void {
    this.#ops.push(
      `q`,
      `${width.toFixed(2)} 0 0 ${height.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm`,
      `/${name} Do`,
      `Q`,
    );
  }

  /**
   * Put the cursor at an absolute height.
   *
   * Only the cover uses it. Everything else flows, and a flow that could be
   * repositioned mid-document would be a flow with no guarantee that one block
   * lands below the last.
   */
  moveTo(y: number): void {
    this.#y = y;
  }

  /**
   * End this page and start the next, without running the header hook.
   *
   * `reserve` starts a page as a side effect of needing room and then draws the
   * running header on it. The cover needs the opposite: a deliberate break, and
   * the header drawn by the caller afterwards — the cover has no running header
   * on it, and the first content page does.
   */
  endPage(): void {
    this.#ops = [];
    this.pages.push(this.#ops);
    this.#y = A4.height - MARGIN.top;
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const cleaned = hex.replace('#', '');
  if (cleaned.length !== 6) return [0.1, 0.1, 0.1];
  const value = Number.parseInt(cleaned, 16);
  if (Number.isNaN(value)) return [0.1, 0.1, 0.1];
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

/** A photograph resolved out of the evidence store, ready to place. */
type PlacedImage = { name: string; image: DecodedImage };

function renderBlock(
  sheet: Sheet,
  block: DocumentBlock,
  accent: [number, number, number],
  photos: Map<string, PlacedImage> = new Map(),
): void {
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

    case 'DRAWING': {
      renderDrawing(sheet, block, accent);
      return;
    }

    case 'PHOTOGRAPH': {
      const placed = photos.get(block.evidenceHash);
      const caption = block.takenOn ? `${block.caption} — ${block.takenOn}` : block.caption;

      if (!placed) {
        // The photograph is named on the document and its bytes are not here:
        // held on a device that has not synced, or discarded under the
        // retention policy. Saying so on the page is the only honest option —
        // a silently missing image reads as a document that had nothing to show.
        sheet.reserve(34);
        sheet.advance(8);
        sheet.text(caption, { font: 'Helvetica-Bold', size: 9 });
        sheet.advance(12);
        sheet.text(`Photograph ${block.evidenceHash.slice(0, 23)}… is not in the store`, {
          font: 'Courier',
          size: 8,
          colour: [0.55, 0.35, 0.2],
        });
        sheet.advance(14);
        return;
      }

      // Sized to the column, and never enlarged: a 400px snap blown up to full
      // width looks like evidence of nothing. Capped in height as well, so a
      // portrait photograph from a phone does not take a page to itself.
      const MAX_HEIGHT = 260;
      const scale = Math.min(CONTENT_WIDTH / placed.image.width, MAX_HEIGHT / placed.image.height, 1);
      const width = placed.image.width * scale;
      const height = placed.image.height * scale;

      sheet.reserve(height + 30);
      sheet.advance(10);
      sheet.photo(placed.name, width, height);
      sheet.advance(13);
      sheet.text(caption, { size: 9, colour: [0.35, 0.35, 0.38] });
      sheet.advance(16);
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

/** Millimetres to PDF points. A point is 1/72 inch, a millimetre is 1/25.4. */
const MM = 72 / 25.4;

/**
 * Render a scale drawing.
 *
 * The transform is the whole of it: a site metre becomes `1000 / scale`
 * millimetres on the sheet, and that is the only place the scale is applied. So
 * the drawing is plotted at exactly the ratio printed beside it, and a scale
 * rule laid on the paper reads true — which is the difference between a drawing
 * and a picture of one.
 *
 * The plan is centred in the space it is given and clipped to it. A site too
 * large for the sheet at the stated scale is not silently squeezed to fit,
 * because that would break the ratio; the caller chooses the scale, and
 * `siteplan.ts` chooses it from the extent so it fits.
 */
function renderDrawing(sheet: Sheet, block: Extract<DocumentBlock, { kind: 'DRAWING' }>, accent: [number, number, number]): void {
  const metresToPoints = (1000 / block.scaleDenominator) * MM;
  const widthMetres = block.extent.maxX - block.extent.minX;
  const heightMetres = block.extent.maxY - block.extent.minY;
  const plotWidth = widthMetres * metresToPoints;
  const plotHeight = heightMetres * metresToPoints;

  sheet.reserve(plotHeight + 74);
  sheet.advance(12);
  sheet.text(block.caption, { font: 'Helvetica-Bold', size: 10 });
  sheet.advance(10);

  // Centred horizontally in the content column; the cursor is the top edge.
  const originX = MARGIN.left + Math.max(0, (CONTENT_WIDTH - plotWidth) / 2);
  const originY = sheet.y - plotHeight;
  // Site y increases northward and so does the page, so the only shift is the
  // extent's own origin. Flipping y here would mirror the site.
  const toSheet = (p: { x: number; y: number }) => ({
    x: originX + (p.x - block.extent.minX) * metresToPoints,
    y: originY + (p.y - block.extent.minY) * metresToPoints,
  });

  const pending: Array<{ text: string; x: number; y: number; area: number }> = [];
  for (const shape of block.shapes) {
    const points = shape.ring.map(toSheet);
    const colour = hexToRgb(shape.colour);
    sheet.polygon(points, {
      ...(shape.outlineOnly ? {} : { fill: wash(colour) }),
      stroke: colour,
      width: shape.outlineOnly ? 1.2 : 0.7,
      ...(shape.outlineOnly ? { dashed: true } : {}),
    });

    // Held back rather than drawn here: a zone drawn later would print its
    // wash straight over an earlier zone's label.
    if (shape.label) pending.push({ text: shape.label, ...labelPointOf(points), area: geo.area(shape.ring) });
  }

  drawLabels(sheet, pending);

  // Scale bar: a round number of metres, drawn at the stated scale so it can be
  // checked against the drawing with a rule.
  const barMetres = niceBarLength(widthMetres);
  const barPoints = barMetres * metresToPoints;
  const barY = originY - 16;

  // North arrow — beside the plot, never on it. Drawn inside the frame it
  // prints over whatever zone occupies the corner, and on the first site this
  // rendered that was the overhead-line exclusion: the one thing on the sheet
  // nobody should have to read through an arrow. It goes in the right-hand
  // gutter when the plot leaves one, and otherwise on the scale-bar row, which
  // is always clear. Site north is +y, which is up the page.
  const gutter = MARGIN.left + CONTENT_WIDTH - (originX + plotWidth);
  const north =
    gutter >= 22
      ? { x: originX + plotWidth + gutter / 2, y: originY + plotHeight - 4 }
      : { x: MARGIN.left + CONTENT_WIDTH - 8, y: barY + 12 };
  sheet.segment({ x: north.x, y: north.y - 22 }, { x: north.x, y: north.y }, [0.2, 0.2, 0.2], 1);
  sheet.polygon(
    [
      { x: north.x, y: north.y + 4 },
      { x: north.x - 3.5, y: north.y - 4 },
      { x: north.x + 3.5, y: north.y - 4 },
    ],
    { fill: [0.2, 0.2, 0.2] },
  );
  sheet.textAt('N', north.x - 2.5, north.y - 32, { size: 7, font: 'Helvetica-Bold' });

  sheet.segment({ x: originX, y: barY }, { x: originX + barPoints, y: barY }, [0.2, 0.2, 0.2], 1.4);
  sheet.segment({ x: originX, y: barY - 3 }, { x: originX, y: barY + 3 }, [0.2, 0.2, 0.2], 1.4);
  sheet.segment({ x: originX + barPoints, y: barY - 3 }, { x: originX + barPoints, y: barY + 3 }, [0.2, 0.2, 0.2], 1.4);
  sheet.textAt(`0`, originX - 2, barY - 11, { size: 6.5 });
  sheet.textAt(`${barMetres}m`, originX + barPoints - 8, barY - 11, { size: 6.5 });
  sheet.textAt(`Scale 1:${block.scaleDenominator} at A4`, originX + barPoints + 14, barY - 2, { size: 7, font: 'Helvetica-Bold' });

  sheet.moveTo(barY - 24);

  // Legend, from the taxonomy the zones are coded against.
  if (block.legend.length > 0) {
    sheet.advance(10);
    sheet.text('Legend', { font: 'Helvetica-Bold', size: 8 });
    sheet.advance(11);
    let column = MARGIN.left;
    for (const entry of block.legend) {
      if (column > MARGIN.left + CONTENT_WIDTH - 130) {
        column = MARGIN.left;
        sheet.advance(11);
      }
      sheet.fill(column, sheet.y - 1, 7, 7, wash(hexToRgb(entry.colour)));
      sheet.textAt(entry.label, column + 11, sheet.y, { size: 6.5 });
      column += 132;
    }
    sheet.advance(12);
  }
  void accent;
}

/** A pale wash of the line colour, so a label stays readable over it. */
function wash([r, g, b]: [number, number, number]): [number, number, number] {
  return [r + (1 - r) * 0.78, g + (1 - g) * 0.78, b + (1 - b) * 0.78];
}

/** The mean of the ring's corners: where a zone's name wants to sit. */
function labelPointOf(points: Array<{ x: number; y: number }>): { x: number; y: number } {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

/** Text size for a zone name on the plan, and the masked box it sits in. */
const LABEL_SIZE = 6.5;
const LABEL_BOX_HEIGHT = LABEL_SIZE + 3;

/**
 * Place the zone names so they can actually be read.
 *
 * Two things make a label useless on a plan, and both appeared the first time
 * this rendered: it prints on top of another label, and it prints on top of a
 * line. A masked box behind the text answers the second — it is what a CAD
 * package's text mask does, and it is why a hoarding's name is legible where it
 * crosses the boundary. The first is answered by trying a short ladder of
 * positions above and below the wanted point.
 *
 * A label that still cannot be placed is **dropped, not overprinted**. Two
 * names on top of each other read as neither, and the zone schedule beside the
 * drawing names every zone regardless — so the clutter is all that is lost.
 */
function drawLabels(sheet: Sheet, labels: Array<{ text: string; x: number; y: number; area: number }>): void {
  type Box = { x0: number; y0: number; x1: number; y1: number };
  const taken: Box[] = [];
  const hits = (a: Box, b: Box): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

  // Largest zone first. On a plan the big areas are what a reader orients by,
  // so when a name has to give way it should be the sliver's, not the
  // compound's — and the order has to come from the shape's own area, because
  // the name's length says nothing about it: "Gate 1" is a long label on one of
  // the smallest things on any site.
  for (const label of [...labels].sort((a, b) => b.area - a.area)) {
    const width = widthOf(label.text, 'Helvetica-Bold', LABEL_SIZE);
    const left = label.x - width / 2;
    let placed: Box | undefined;
    // The rungs are a whole box apart. A shorter step leaves consecutive rungs
    // overlapping each other, so the ladder rejects its own positions and runs
    // out having placed a fraction of what it could.
    for (const dy of [0, LABEL_BOX_HEIGHT, -LABEL_BOX_HEIGHT, LABEL_BOX_HEIGHT * 2, -LABEL_BOX_HEIGHT * 2]) {
      const box = { x0: left - 1.5, y0: label.y + dy - 2, x1: left + width + 1.5, y1: label.y + dy - 2 + LABEL_BOX_HEIGHT };
      if (!taken.some((other) => hits(other, box))) {
        placed = box;
        break;
      }
    }
    if (!placed) continue;
    taken.push(placed);
    sheet.fill(placed.x0, placed.y0, placed.x1 - placed.x0, placed.y1 - placed.y0, [1, 1, 1]);
    sheet.textAt(label.text, placed.x0 + 1.5, placed.y0 + 2, { size: LABEL_SIZE, font: 'Helvetica-Bold', colour: [0.15, 0.15, 0.15] });
  }
}

/** 1, 2, 5, 10, 20, 50… metres — whichever is closest to a quarter of the plot. */
function niceBarLength(widthMetres: number): number {
  const target = widthMetres / 4;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(target, 1)));
  for (const step of [1, 2, 5, 10]) {
    if (magnitude * step >= target) return magnitude * step;
  }
  return magnitude * 10;
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
/**
 * How the renderer gets at a photograph's bytes.
 *
 * Passed in rather than reached for: this module writes PDF and knows nothing
 * about tenants, evidence stores or signed URLs, and giving it a store handle
 * would make a page renderer into something that can read customer files.
 * Returning `undefined` for an absent photograph is normal — bytes held on a
 * device that has not synced are not an error — and the page says so.
 */
export type ImageResolver = (evidenceHash: string) => { mime: string; bytes: Buffer } | undefined;

export function renderPdf(document: ExportDocument, resolveImage?: ImageResolver): Uint8Array {
  const accent = hexToRgb(document.branding.primaryColour);

  // Resolved once, before anything is drawn, and keyed by hash so a photograph
  // referenced twice is embedded once. A twenty-finding report that shows the
  // same access gate on three pages must not carry three copies of it.
  const photos = new Map<string, PlacedImage>();
  if (resolveImage) {
    for (const block of document.blocks) {
      if (block.kind !== 'PHOTOGRAPH' || photos.has(block.evidenceHash)) continue;
      const held = resolveImage(block.evidenceHash);
      if (!held) continue;
      try {
        photos.set(block.evidenceHash, {
          name: `Ph${photos.size}`,
          image: decodeImage(held.mime, held.bytes, 'A photograph'),
        });
      } catch (error) {
        // A photograph in a format the renderer cannot place must not stop an
        // evidence bundle being produced. It is left out, and the page says the
        // image is not there — which is true, and visible.
        if (!(error instanceof UnsupportedImageError)) throw error;
      }
    }
  }

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

  /**
   * The cover image, resolved through the same content-addressed path a
   * photograph takes.
   *
   * So the document's own content hash commits to exactly which image was on
   * its cover: swap the image afterwards and the hash changes and the document
   * stops verifying, which is the correct behaviour for an instrument somebody
   * may have to stand behind.
   *
   * An image the renderer cannot decode is left out and the cover falls back to
   * type. It never stops the document being produced — the same rule the
   * photographs and the logo follow, for the same reason: a bundle somebody
   * needs is worth more than a picture on its first page.
   */
  let cover: PlacedImage | undefined;
  if (resolveImage && document.branding.coverEvidenceHash) {
    const hash = document.branding.coverEvidenceHash;
    // Keyed into the same map the photographs use, so a cover that is also
    // shown as a photograph inside the document is embedded once rather than
    // twice — and so the embedding loop below needs no second case.
    const already = photos.get(hash);
    if (already) {
      cover = already;
    } else {
      const held = resolveImage(hash);
      if (held) {
        try {
          cover = { name: 'Cover', image: decodeImage(held.mime, held.bytes, 'The cover image') };
          photos.set(hash, cover);
        } catch (error) {
          if (!(error instanceof UnsupportedImageError)) throw error;
        }
      }
    }
  }

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

  /**
   * The cover.
   *
   * Always present, image or no image. A branded document handed to a client
   * that opens straight into a table reads as a printout rather than as an
   * issued document, and the four things somebody checks before reading a word
   * — what it is, who it is for, who issued it, and which document this is —
   * are exactly what a cover is for.
   *
   * Drawn directly rather than through `renderBlock`, because it is not a
   * block: it is a whole page with its own layout, it takes no part in the flow,
   * and the running header does not appear on it. A `COVER` block kind would
   * have made every document type able to put one anywhere, which is not a
   * capability anybody asked for and is a way for a cover to end up on page
   * eleven.
   */
  const drawCover = (): void => {
    // A full-bleed band of the client's colour across the top, and the image
    // inside it where there is one. The band is what makes the page read as
    // branded when there is no image at all.
    const BAND = 260;
    sheet.fill(0, A4.height - BAND, A4.width, BAND, accent);

    if (cover) {
      // Cover the band without distorting: scale to whichever axis needs more,
      // and let the overflow fall outside the band rather than squashing a
      // photograph of somebody's building into a different shape.
      const scale = Math.max(A4.width / cover.image.width, BAND / cover.image.height);
      const width = cover.image.width * scale;
      const height = cover.image.height * scale;
      sheet.cover(cover.name, width, height, (A4.width - width) / 2, A4.height - BAND - (height - BAND) / 2);
    }

    sheet.moveTo(A4.height - BAND - 70);
    sheet.text(document.branding.clientName.toUpperCase(), { font: 'Helvetica-Bold', size: 10, colour: accent });
    sheet.advance(34);
    sheet.text(document.title, { font: 'Helvetica-Bold', size: 24 });
    if (document.subtitle) {
      sheet.advance(20);
      sheet.text(document.subtitle, { size: 12, colour: [0.35, 0.35, 0.38] });
    }
    sheet.advance(26);
    sheet.rule(accent, 160);

    sheet.advance(30);
    const facts: Array<[string, string]> = [
      ['Reference', document.reference],
      ['Prepared for', document.branding.clientName],
      // Who carries the duty under the document, which is not always who it was
      // prepared for. Omitted rather than guessed when it is not set.
      ...(document.branding.issuingEntity ? ([['Issued by', document.branding.issuingEntity]] as Array<[string, string]>) : []),
      ['Audience', document.audience],
      ['Generated', document.generatedAt.slice(0, 16).replace('T', ' ')],
      ['Generated by', document.generatedBy],
    ];
    for (const [label, value] of facts) {
      sheet.text(label, { size: 9, colour: [0.45, 0.45, 0.48] });
      sheet.text(value, { font: 'Helvetica-Bold', size: 9, x: MARGIN.left + 110 });
      sheet.advance(16);
    }

    // On the cover as well as in the footer. The cover is the page that gets
    // photographed, forwarded and printed on its own, and the hash is what makes
    // any of that checkable afterwards.
    sheet.advance(14);
    sheet.text(`Content hash ${document.contentHash}`, { font: 'Courier', size: 7, colour: [0.55, 0.55, 0.58] });

    if (document.redactionNotice) {
      sheet.advance(24);
      sheet.text(document.redactionNotice, { size: 8, colour: [0.55, 0.35, 0.1] });
    }

    // The legal footer belongs on the cover too: it is the registered detail of
    // the party issuing the document, and a reader deciding whether to act on
    // one wants it before the content, not after it.
    sheet.moveTo(MARGIN.bottom + 60);
    sheet.rule([0.85, 0.85, 0.85]);
    sheet.advance(14);
    sheet.text(document.branding.legalFooter, { size: 8, colour: [0.42, 0.42, 0.45] });

    sheet.endPage();
  };

  drawCover();

  header(sheet);
  void logoRefused;

  for (const block of document.blocks) renderBlock(sheet, block, accent, photos);

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
  // The cover carries no running footer.
  //
  // It has its own: the reference, the legal detail and the content hash are
  // all on it already, laid out as part of the cover rather than in a band at
  // the bottom. Adding "Page 1 of 5" and a rule across a cover competes with
  // that layout, and it would put the content hash on the page twice.
  const streams = sheet.pages.map((ops, index) =>
    (index === 0 ? ops : [...ops, ...footerOps(index + 1, pageCount)]).join('\n'),
  );

  return assemble(streams, document.title, documentOrigin(document.branding), logo, photos);
}

/**
 * Put the objects together and build the cross-reference table.
 *
 * The offsets are the only part a reader is strict about: every one is the byte
 * position of the start of its object, and a file whose xref is wrong opens as
 * a blank page in some readers and not at all in others.
 */
function assemble(
  streams: string[],
  title: string,
  /** Who issued the document. Author and producer both, because both are read. */
  origin: string,
  logo?: DecodedImage,
  photos: Map<string, PlacedImage> = new Map(),
): Uint8Array {
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

  // Each photograph once, shared by every page that shows it — the same reason
  // the logo is embedded once rather than per page.
  const embedImage = (image: DecodedImage): number =>
    add(
      `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
        `/ColorSpace ${image.components === 1 ? '/DeviceGray' : '/DeviceRGB'} /BitsPerComponent ${image.bitsPerComponent} ` +
        `/Filter /${image.filter} /Length ${image.data.length} >>\nstream\n${image.data.toString('latin1')}\nendstream`,
    );

  const photoIds: string[] = [];
  for (const placed of photos.values()) {
    photoIds.push(`/${placed.name} ${embedImage(placed.image)} 0 R`);
  }

  const xobjects = [...(logoId ? [`/Logo ${logoId} 0 R`] : []), ...photoIds];
  const resources =
    `<< /Font << /F1 ${fontIds.F1} 0 R /F2 ${fontIds.F2} 0 R /F3 ${fontIds.F3} 0 R >> ` +
    `${xobjects.length > 0 ? `/XObject << ${xobjects.join(' ')} >> ` : ''}>>`;

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

  // The customer's name in every field a reader shows, and this platform's in
  // none of them.
  //
  // `Producer` conventionally names the software that wrote the file, and that
  // convention is wrong for this document. What leaves here is the customer's
  // instrument, carrying their mark and their legal footer, and a reader
  // opening Document Properties to ask where it came from should be told the
  // customer — not the tooling they happen to run. `Creator` is set for the
  // same reason: left unset, some readers fall back to showing the producer.
  const infoId = add(
    `<< /Title ${pdfTextString(title)} /Author ${pdfTextString(origin)} ` +
      `/Creator ${pdfTextString(origin)} /Producer ${pdfTextString(origin)} ` +
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
