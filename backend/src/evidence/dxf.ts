/**
 * DXF — the open interchange format for CAD, and the only one of the 2D
 * drawing formats anything can read without a licence.
 *
 * ## Why this exists
 *
 * Stated as a requirement: *"a bid will be a mix of document (word, pdf,
 * excel) and cad drawing, bim model, 3d and 2d as well and it must read all
 * these."* Word, Excel and PDF are read by `office.ts` and `pdftext.ts`; IFC is
 * read by `engines/ifc.ts`. DWG, RVT and NWD are proprietary binary formats and
 * nothing here opens them — the platform says so and asks for an export. DXF is
 * the gap in the middle, and it is the format those tools all export to.
 *
 * **Before this it was worse than unread.** A DXF is ASCII, so `sniffType`
 * called it `text/plain`, and `extractText` handed the whole file over as
 * prose. What a model received was half a megabyte of
 * `10 / 123.456 / 20 / 789.0` — coordinate pairs, one number per line — inside
 * which it was asked to find tender requirements. It found none, correctly, at
 * full price.
 *
 * ## What is read, and what is deliberately not
 *
 * The **annotation**: every `TEXT`, `MTEXT` and `ATTRIB` value, with the layer
 * it sits on. That is the drawing's own words — the title block, the general
 * notes, the specification references, the revision cloud comments — and it is
 * the only part of a drawing that carries meaning to a reader that cannot see.
 *
 * The **structure**: layer names, block names, entity counts by type, and the
 * drawing extents. A reader deciding whether this is a general arrangement or a
 * foundation detail is answering that from the layer names.
 *
 * **Not the geometry.** Lines, arcs and polylines are counted and never
 * transcribed. A coordinate list is not information at this level, and putting
 * one in front of a model is what this module exists to stop.
 */

/** The marker a binary DXF opens with. Nothing here reads one. */
const BINARY_SENTINEL = 'AutoCAD Binary DXF';

export type DxfText = { layer: string; value: string };

export type DxfSummary = {
  kind: 'DXF';
  /** Every annotation string, in the order the file carries it. */
  annotations: DxfText[];
  layers: string[];
  blocks: string[];
  /** How many of each entity type, heaviest first. */
  entities: Array<{ type: string; count: number }>;
  /** `$EXTMIN`/`$EXTMAX` where the header declares them. */
  extents?: { min: [number, number]; max: [number, number] };
  /** The CAD application version string from `$ACADVER`, where present. */
  version?: string;
  /** The readable rendering, which is what a model is shown. */
  text: string;
  /** What was left out, said rather than left to be assumed. */
  note?: string;
};

export type DxfUnreadable = { kind: 'UNREADABLE'; reason: string };

/**
 * Is this a DXF at all?
 *
 * A DXF opens with the group pair `0` / `SECTION`. Checked on the first few
 * non-empty lines rather than by extension, because the extension is the
 * uploader's claim and this module is reached from a type sniff that has
 * already decided the bytes are text.
 */
export function looksLikeDxf(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 512).toString('latin1');
  if (head.startsWith(BINARY_SENTINEL)) return true;
  const lines = head.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  for (let i = 0; i + 1 < Math.min(lines.length, 8); i++) {
    if (lines[i] === '0' && lines[i + 1] === 'SECTION') return true;
  }
  return false;
}

/**
 * Strip MTEXT's inline formatting so a note reads as the note.
 *
 * MTEXT carries its own markup: `\P` for a paragraph break, `\f...;` and
 * `{\fArial|b0|i0;…}` for fonts, `\H2.5x;` for height, `%%U` for underline.
 * Left in, a general note arrives as
 * `{\fArial|b1;NOTE:}\PAll dimensions in mm` and a reader has to know CAD to
 * see the sentence.
 */
function plainMtext(raw: string): string {
  return raw
    .replace(/\\P/g, '\n')
    .replace(/\\[A-Za-z][^;\\]*;/g, '')
    .replace(/[{}]/g, '')
    .replace(/%%[udoUDO]/g, '')
    .replace(/%%c/gi, 'Ø')
    .replace(/%%d/gi, '°')
    .replace(/%%p/gi, '±')
    .replace(/\\~/g, ' ')
    .replace(/\\\\/g, '\\')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Group code / value pairs, which is all a DXF is. */
function* pairs(text: string): Generator<{ code: number; value: string }> {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i]!.trim());
    if (!Number.isFinite(code)) continue;
    yield { code, value: lines[i + 1]!.trim() };
  }
}

/**
 * The most a drawing is read as text, in bytes.
 *
 * A DXF is routinely tens of megabytes and almost all of it is coordinates.
 * The annotation in even a dense drawing is a few thousand characters, so this
 * bounds the scan rather than the answer: past it the geometry is skipped and
 * the note says so.
 */
const SCAN_CEILING = 24 * 1_048_576;

export function readDxf(bytes: Buffer): DxfSummary | DxfUnreadable {
  if (bytes.subarray(0, 32).toString('latin1').startsWith(BINARY_SENTINEL)) {
    return {
      kind: 'UNREADABLE',
      reason:
        'This is a binary DXF. Nothing here reads one, and guessing at its structure would be inventing a drawing. ' +
        'Export it again as ASCII DXF — every CAD application offers both, and the ASCII form is the interchange one.',
    };
  }

  const truncated = bytes.length > SCAN_CEILING;
  const text = bytes.subarray(0, SCAN_CEILING).toString('utf8');

  const annotations: DxfText[] = [];
  const layers = new Set<string>();
  const blocks = new Set<string>();
  const counts = new Map<string, number>();
  let version: string | undefined;
  let extMin: [number, number] | undefined;
  let extMax: [number, number] | undefined;

  let section = '';
  let entity = '';
  let layer = '';
  /** MTEXT splits a long string across 3s with the tail on 1. */
  let buffer = '';
  let headerVar = '';
  let pendingPoint: { x?: number; y?: number } | undefined;

  const flush = (): void => {
    const value = plainMtext(buffer);
    buffer = '';
    if (value === '') return;
    annotations.push({ layer: layer || '0', value });
  };

  for (const { code, value } of pairs(text)) {
    if (code === 0) {
      flush();
      if (value === 'SECTION') {
        section = '';
      } else if (value === 'ENDSEC') {
        section = '';
        entity = '';
      } else {
        entity = value;
        layer = '';
        if (section === 'ENTITIES' || section === 'BLOCKS') counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      continue;
    }

    // Immediately after `0/SECTION`, code 2 names the section.
    if (code === 2 && section === '' && entity === '') {
      section = value;
      continue;
    }

    if (section === 'HEADER') {
      if (code === 9) {
        headerVar = value;
        pendingPoint = headerVar === '$EXTMIN' || headerVar === '$EXTMAX' ? {} : undefined;
        continue;
      }
      if (headerVar === '$ACADVER' && code === 1) version = value;
      if (pendingPoint && code === 10) pendingPoint.x = Number(value);
      if (pendingPoint && code === 20) {
        pendingPoint.y = Number(value);
        const point: [number, number] = [pendingPoint.x ?? 0, pendingPoint.y ?? 0];
        if (headerVar === '$EXTMIN') extMin = point;
        if (headerVar === '$EXTMAX') extMax = point;
        pendingPoint = undefined;
      }
      continue;
    }

    if (code === 8) {
      layer = value;
      // A layer is declared in TABLES and used in ENTITIES; both are worth
      // collecting, because a drawing whose layers are all `0` was exported
      // flat and that is worth a reader knowing.
      if (value !== '') layers.add(value);
      continue;
    }

    if (section === 'BLOCKS' && entity === 'BLOCK' && code === 2 && value !== '') {
      blocks.add(value);
      continue;
    }

    // The annotation itself. 1 is the value, 3 the continuation of a long
    // MTEXT, and ATTRIB carries its tag on 2 which is deliberately not read:
    // a tag is a field name, not what the field says.
    if ((entity === 'TEXT' || entity === 'MTEXT' || entity === 'ATTRIB' || entity === 'ATTDEF') && (code === 1 || code === 3)) {
      buffer += value;
    }
  }
  flush();

  const entities = [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);

  const notes: string[] = [];
  if (truncated) notes.push(`only the first ${Math.round(SCAN_CEILING / 1_048_576)}MB was scanned`);
  notes.push('geometry is counted, never transcribed — a coordinate list is not information');
  if (annotations.length === 0) {
    notes.push('this drawing carries no text at all, so there is nothing in it for a reader that cannot see the lines');
  }

  const lines: string[] = [];
  lines.push(`CAD drawing (DXF${version ? `, ${version}` : ''}).`);
  if (extMin && extMax) {
    lines.push(`Extents ${extMin[0]} ${extMin[1]} to ${extMax[0]} ${extMax[1]}.`);
  }
  if (layers.size > 0) lines.push(`Layers: ${[...layers].join(', ')}.`);
  if (blocks.size > 0) lines.push(`Blocks: ${[...blocks].join(', ')}.`);
  if (entities.length > 0) {
    lines.push(`Entities: ${entities.slice(0, 12).map((e) => `${e.type} ${e.count}`).join(', ')}.`);
  }
  if (annotations.length > 0) {
    lines.push('', 'Text on the drawing, by layer:');
    for (const annotation of annotations) lines.push(`[${annotation.layer}] ${annotation.value}`);
  }

  return {
    kind: 'DXF',
    annotations,
    layers: [...layers],
    blocks: [...blocks],
    entities,
    ...(extMin && extMax ? { extents: { min: extMin, max: extMax } } : {}),
    ...(version ? { version } : {}),
    text: lines.join('\n'),
    note: `${notes.join('; ')}.`,
  };
}
