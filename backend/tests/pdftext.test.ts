import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deflateSync } from 'node:zlib';
import { extractText } from '../src/evidence/ingest.ts';
import { readPdfText } from '../src/evidence/pdftext.ts';
import { renderPdf } from '../src/export/pdf.ts';
import type { ExportDocument } from '../src/export/exporter.ts';

/**
 * Reading a PDF's own text, with no model in the room.
 *
 * Two kinds of file. One the platform wrote itself, because a reader that
 * cannot read the platform's own output has no business reading anybody
 * else's. And one built by hand to carry what a word processor's output
 * carries and the renderer's does not: Flate-compressed streams, a `TJ` array
 * with kerning, a composite font whose strings are glyph indices mapped back
 * through `ToUnicode`, a form XObject, and a page that is nothing but an image
 * — a scan.
 */

function platformDocument(): ExportDocument {
  return {
    id: 'doc-1',
    reference: 'MIGL-00001',
    title: 'Project status report',
    branding: {
      clientName: 'Meridian Infrastructure Group Ltd',
      primaryColour: '#e2571e',
      legalFooter: 'Meridian Infrastructure Group Ltd · registered in GB',
      documentReferencePrefix: 'MIGL',
    },
    audience: 'ADJUDICATOR',
    format: 'PDF',
    generatedAt: '2026-08-21T05:28:00.000Z',
    generatedBy: 'user-1',
    projectId: 'project-1',
    contentHash: 'sha256:a56ec17ba0c50be01a88d3ec1ad4e84ce111f113a6b39af2783666253eabeff7',
    verification: 'CXV1:t-1:unchecked',
    blocks: [
      { kind: 'HEADING', level: 1, text: 'Project status report' },
      { kind: 'PARAGRAPH', text: 'Ashworth Water Treatment Works — Phase 2, £1,250,000 certified to date.' },
      { kind: 'KEY_VALUES', rows: [{ label: 'Lifecycle phase', value: 'OPERATIONS' }] },
    ],
  };
}

/** A PDF assembled from object bodies, with a correct xref table. */
function assemble(objects: Array<string | Buffer>, trailerExtra = ''): Buffer {
  let out = '%PDF-1.5\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${index + 1} 0 obj\n${typeof object === 'string' ? object : object.toString('latin1')}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function flate(content: string): Buffer {
  const data = deflateSync(Buffer.from(content, 'latin1'));
  return Buffer.concat([
    Buffer.from(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
    data,
    Buffer.from('\nendstream', 'latin1'),
  ]);
}

const stream = (content: string, dict = ''): string => `<< /Length ${Buffer.byteLength(content, 'latin1')} ${dict}>>\nstream\n${content}\nendstream`;

/** Codes 1, 2 and 4 map to H, e and o by bfchar; 3 to l by a range; 6 to the whole word "World" in one array entry. */
const CMAP = [
  '/CIDInit /ProcSet findresource begin begincmap',
  '1 begincodespacerange <0000> <FFFF> endcodespacerange',
  '3 beginbfchar <0001> <0048> <0002> <0065> <0004> <006F> endbfchar',
  '1 beginbfrange <0003> <0003> <006C> endbfrange',
  '1 beginbfrange <0006> <0006> [<0057006F0072006C0064>] endbfrange',
  'endcmap',
].join('\n');

/** Two pages: one of text set three ways, one that is only an image. */
function wordProcessorPdf(): Buffer {
  return assemble([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 8 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 7 0 R >> /XObject << /Fm1 11 0 R >> >> >>',
    flate(
      // Composite font through ToUnicode, kerned into two words; then WinAnsi with an escaped bracket and an en dash;
      // then a second line by T*, then the form XObject with its own font.
      'BT /F1 12 Tf 72 700 Td [<00010002000300030004> -320 <0006>] TJ ET ' +
        'BT /F2 10 Tf 72 680 Td (Clause 12 \\(payment\\) \\226 due 28 days) Tj T* (Second line of the letter) Tj ET ' +
        'q /Fm1 Do Q',
    ),
    '<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Calibri /Encoding /Identity-H /ToUnicode 6 0 R >>',
    stream(CMAP),
    '<< /Type /Font /Subtype /TrueType /BaseFont /Arial /Encoding /WinAnsiEncoding >>',
    '<< /Type /Page /Parent 2 0 R /Contents 9 0 R /Resources << /XObject << /Im1 10 0 R >> >> >>',
    stream('q 500 0 0 700 50 50 cm /Im1 Do Q'),
    stream('\x00', '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 '),
    stream(
      'BT /F3 9 Tf 1 0 0 1 72 40 Tm (Footer from A form) Tj ET',
      '/Type /XObject /Subtype /Form /BBox [0 0 595 842] /Resources << /Font << /F3 12 0 R >> >> ',
    ),
    // Differences: code 65 is set to "sterling", so an A in the string reads as £.
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /Differences [65 /sterling] >> >>',
  ]);
}

describe('the platform’s own PDF reads back as its words', () => {
  const reading = readPdfText(Buffer.from(renderPdf(platformDocument())));

  it('finds every page on the tree and text on each', () => {
    assert.equal(reading.pages, 2);
    assert.equal(reading.textPages, 2);
    assert.equal(reading.imageOnlyPages, 0);
    assert.equal(reading.encrypted, false);
  });

  it('carries the heading, the body and the key/value rows', () => {
    assert.match(reading.text, /Project status report/);
    assert.match(reading.text, /Ashworth Water Treatment Works — Phase 2, £1,250,000 certified to date\./);
    assert.match(reading.text, /Lifecycle phase\s*\n?\s*OPERATIONS/);
  });

  it('skips nothing it could have read', () => {
    assert.equal(reading.undecodableStrings, 0);
    assert.equal(reading.unreadableStreams, 0);
  });
});

describe('a word processor’s PDF: compressed, kerned, composite fonts, a form and a scan', () => {
  const reading = readPdfText(wordProcessorPdf());

  it('inflates the content stream and maps glyph indices back through ToUnicode', () => {
    assert.match(reading.text, /^Hello World/, reading.text);
  });

  it('decodes WinAnsi with its escapes, and breaks lines where the operators do', () => {
    assert.match(reading.text, /Clause 12 \(payment\) – due 28 days\nSecond line of the letter/);
  });

  it('follows a form XObject and honours a Differences array inside it', () => {
    assert.match(reading.text, /Footer from £ form/);
  });

  it('reports the image-only page as what a scan looks like, and does not invent text for it', () => {
    assert.equal(reading.pages, 2);
    assert.equal(reading.textPages, 1);
    assert.equal(reading.imageOnlyPages, 1);
    assert.equal(reading.undecodableStrings, 0);
  });
});

describe('what it refuses, by name', () => {
  it('a composite font with no ToUnicode is glyph indices, not text — counted, not guessed', () => {
    const reading = readPdfText(
      assemble([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        stream('BT /F1 12 Tf 72 700 Td <00010002> Tj ET'),
        '<< /Type /Font /Subtype /Type0 /BaseFont /Subset+Font /Encoding /Identity-H >>',
      ]),
    );
    assert.equal(reading.text, '');
    assert.equal(reading.undecodableStrings, 1);
    assert.equal(reading.textPages, 0);
  });

  it('a stream under a filter it does not decode is counted, and the rest of the file is still read', () => {
    const reading = readPdfText(
      assemble([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
        '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
        stream('nonsense', '/Filter /LZWDecode '),
        '<< /Type /Page /Parent 2 0 R /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
        stream('BT /F1 12 Tf (Readable page) Tj ET'),
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      ]),
    );
    assert.equal(reading.unreadableStreams, 1);
    assert.equal(reading.text, 'Readable page');
  });

  it('an encrypted file, which nothing can read without the password', () => {
    const reading = readPdfText(
      assemble(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>', '<< /Filter /Standard /V 2 /R 3 >>'], '/Encrypt 3 0 R '),
    );
    assert.equal(reading.encrypted, true);
    assert.equal(reading.text, '');
  });

  it('bytes that are a PDF header and nothing else read as no pages, never as an exception', () => {
    const reading = readPdfText(Buffer.from('%PDF-1.7\n'));
    assert.equal(reading.pages, 0);
    assert.equal(reading.text, '');
  });

  it('objects packed in an object stream are found, as PDF 1.5 files keep them', () => {
    const inner = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>'];
    let offsets = '';
    let bodies = '';
    inner.forEach((body, index) => {
      offsets += `${index + 1} ${bodies.length} `;
      bodies += `${body} `;
    });
    const packed = deflateSync(Buffer.from(offsets + bodies, 'latin1'));
    const reading = readPdfText(
      assemble([
        // Objects 1–3 are defined twice: as stale top-level placeholders here,
        // and inside the object stream (object 5) further down the file. The
        // later definition wins, as it does in an incremental update.
        'null',
        'null',
        'null',
        stream('BT (Packed page) Tj ET'),
        Buffer.concat([
          Buffer.from(`<< /Type /ObjStm /N 3 /First ${offsets.length} /Length ${packed.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
          packed,
          Buffer.from('\nendstream', 'latin1'),
        ]),
      ]),
    );
    assert.equal(reading.pages, 1);
    assert.equal(reading.text, 'Packed page');
  });
});

/**
 * Tables, from where the text sits.
 *
 * Courier throughout, because its advance is 600/1000 em for every glyph and
 * so every position below can be worked out by hand: a cell's right edge is its
 * start plus 0.6 × size × its length. That is what lets the quantity column be
 * right-aligned to x = 400 exactly, which is the case a start-position
 * clustering would get wrong and this reader must not.
 */
function courierPage(content: string, extra: string[] = []): Buffer {
  return assemble([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> ${extra.length > 0 ? '/XObject << /Fm1 6 0 R >> ' : ''}>> >>`,
    stream(content),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
    ...extra,
  ]);
}

/** A bill: left-aligned item and unit, a quantity column right-aligned to x = 400, a wrapped description, a paragraph after. */
const BILL =
  'BT /F1 10 Tf 72 700 Td (Item) Tj 200 0 Td (Unit) Tj 100 0 Td (Qty) Tj ET ' +
  // The item set in two kerned pieces: still one cell.
  'BT /F1 10 Tf 72 686 Td [(Exca) -20 (vation)] TJ 200 0 Td (m3) Tj 110 0 Td (420) Tj ET ' +
  'BT /F1 10 Tf 72 672 Td (Blinding) Tj 200 0 Td (m2) Tj 98 0 Td (1,250) Tj ET ' +
  // A row with nothing measured: the quantity cell is blank on the page and blank in the row.
  'BT /F1 10 Tf 72 658 Td (Disposal) Tj 200 0 Td (m3) Tj ET ' +
  'BT /F1 10 Tf 72 644 Td (Reinforced concrete) Tj 200 0 Td (m3) Tj 122 0 Td (8) Tj ET ' +
  // The description wrapped onto a second line, one line-height down, under nothing else.
  'BT /F1 10 Tf 72 632 Td (in foundations) Tj ET ' +
  'BT /F1 10 Tf 72 610 Td (Carried to summary, provisional sums separately.) Tj ET';

describe('tables recovered from where the text sits', () => {
  it('finds the rows of a bill, right-aligned figures and blank cells included, and joins a wrapped description', () => {
    const reading = readPdfText(courierPage(BILL));
    assert.equal(reading.tables.length, 1, JSON.stringify(reading.tables));
    assert.equal(reading.tables[0]!.page, 1);
    assert.deepEqual(reading.tables[0]!.rows, [
      ['Item', 'Unit', 'Qty'],
      ['Excavation', 'm3', '420'],
      ['Blinding', 'm2', '1,250'],
      ['Disposal', 'm3', ''],
      ['Reinforced concrete in foundations', 'm3', '8'],
    ]);
    // The text is exactly what it was before tables existed: nothing about the
    // line breaking changed to make room for them.
    assert.match(reading.text, /^Item Unit Qty\nExcavation m3 420\n/);
    assert.match(reading.text, /Carried to summary, provisional sums separately\.$/);
  });

  it('does not call prose set word by word a table, nor two columns of prose', () => {
    // Justified text: every word its own string at its own position. The
    // words' extents overlap from line to line, so there is one column, and
    // one column is no table.
    const justified =
      'BT /F1 10 Tf 72 500 Td (Further) Tj 54 0 Td (to) Tj 24 0 Td (your) Tj 36 0 Td (letter) Tj ET ' +
      'BT /F1 10 Tf 72 488 Td (dated) Tj 42 0 Td (3) Tj 18 0 Td (March) Tj 42 0 Td (we) Tj ET ' +
      'BT /F1 10 Tf 72 476 Td (write) Tj 42 0 Td (to) Tj 24 0 Td (confirm) Tj 54 0 Td (it) Tj ET';
    assert.deepEqual(readPdfText(courierPage(justified)).tables, []);

    // Two newspaper columns line up perfectly and neither is short cells.
    const columns =
      'BT /F1 10 Tf 72 500 Td (The works proceed as instructed) Tj 228 0 Td (and the engineer attends each day) Tj ET ' +
      'BT /F1 10 Tf 72 488 Td (by the contract administrator) Tj 228 0 Td (to record progress on the wall) Tj ET ' +
      'BT /F1 10 Tf 72 476 Td (under clause four of the deed) Tj 228 0 Td (chart kept in the site office) Tj ET';
    assert.deepEqual(readPdfText(courierPage(columns)).tables, []);

    // A heading beside a date is one line of two things, not a table.
    const heading = 'BT /F1 10 Tf 72 700 Td (Progress report) Tj 300 0 Td (3 March 2026) Tj ET BT /F1 10 Tf 72 680 Td (The works proceed.) Tj ET';
    assert.deepEqual(readPdfText(courierPage(heading)).tables, []);
  });

  it('refuses a block whose header does not fill the columns or reads as a sentence', () => {
    // Body rows of three cells under a header of two: a paragraph beside a
    // list, not a table. Refused rather than given an invented third heading.
    const short =
      'BT /F1 10 Tf 72 700 Td (Item) Tj 200 0 Td (Unit) Tj ET ' +
      'BT /F1 10 Tf 72 686 Td (Excavation) Tj 200 0 Td (m3) Tj 110 0 Td (420) Tj ET ' +
      'BT /F1 10 Tf 72 672 Td (Blinding) Tj 200 0 Td (m2) Tj 110 0 Td (180) Tj ET ' +
      'BT /F1 10 Tf 72 658 Td (Disposal) Tj 200 0 Td (m3) Tj 110 0 Td (96) Tj ET';
    assert.deepEqual(readPdfText(courierPage(short)).tables, []);

    const sentence = BILL.replace('(Item) Tj', '(We write to confirm.) Tj');
    assert.deepEqual(readPdfText(courierPage(sentence)).tables, []);
  });

  it('follows the transformation into a form XObject placed by its matrix', () => {
    const form = stream(
      'BT /F1 10 Tf 0 0 Td (Ref) Tj 100 0 Td (Clause) Tj 100 0 Td (Due) Tj ET ' +
        'BT /F1 10 Tf 0 -14 Td (O-1) Tj 100 0 Td (4.1) Tj 100 0 Td (28 days) Tj ET ' +
        'BT /F1 10 Tf 0 -28 Td (O-2) Tj 100 0 Td (4.7) Tj 100 0 Td (7 days) Tj ET ' +
        'BT /F1 10 Tf 0 -42 Td (O-3) Tj 100 0 Td (8.2) Tj 100 0 Td (14 days) Tj ET',
      '/Type /XObject /Subtype /Form /BBox [0 0 400 100] /Matrix [1 0 0 1 72 600] /Resources << /Font << /F1 5 0 R >> >> ',
    );
    const reading = readPdfText(courierPage('q /Fm1 Do Q', [form]));
    assert.deepEqual(reading.tables.map((t) => t.rows), [
      [
        ['Ref', 'Clause', 'Due'],
        ['O-1', '4.1', '28 days'],
        ['O-2', '4.7', '7 days'],
        ['O-3', '8.2', '14 days'],
      ],
    ]);
  });

  it('recovers the table the platform’s own renderer drew, columns and blanks as drawn', () => {
    const bill: ExportDocument = {
      ...platformDocument(),
      blocks: [
        { kind: 'HEADING', level: 1, text: 'Bill of quantities' },
        { kind: 'PARAGRAPH', text: 'Measured in accordance with NRM2. Rates exclude VAT.' },
        {
          kind: 'TABLE',
          caption: 'Section 2 — Substructure',
          headers: ['Item', 'Description', 'Unit', 'Qty', 'Rate'],
          rows: [
            ['2.1', 'Excavation to reduce levels, not exceeding 2m deep, in material other than rock', 'm3', '420', '18.50'],
            ['2.2', 'Blinding concrete C16/20, 50mm thick', 'm2', '180', '12.00'],
            ['2.3', 'Disposal of excavated material off site', 'm3', '', ''],
            ['2.4', 'Reinforced concrete C32/40 in foundations', 'm3', '96', '185.00'],
          ],
        },
        { kind: 'PARAGRAPH', text: 'Carried to summary. Provisional sums are listed separately in Section 9.' },
      ],
    };
    const reading = readPdfText(Buffer.from(renderPdf(bill)));
    // The cover page's reference block is a two-column table of its own, and
    // is reported as one; the bill is the table on page 2.
    const found = reading.tables.find((t) => t.rows[0]?.[0] === 'Item');
    assert.ok(found, JSON.stringify(reading.tables));
    assert.equal(found.page, 2);
    assert.deepEqual(found.rows[0], ['Item', 'Description', 'Unit', 'Qty', 'Rate']);
    assert.deepEqual(found.rows[1], ['2.1', 'Excavation to reduce levels, not exceeding 2m deep, in material other than rock', 'm3', '420', '18.50']);
    assert.deepEqual(found.rows[3], ['2.3', 'Disposal of excavated material off site', 'm3', '', '']);
    assert.equal(found.rows.length, 5, 'the paragraph after the table is not a row of it');
  });

  it('a word processor’s letter has no table in it', () => {
    assert.deepEqual(readPdfText(wordProcessorPdf()).tables, []);
  });

  it('keeps a column that is empty below its heading, as an unpriced bill’s Rate column is', () => {
    // Every row has a blank rate: the tenderer prices it. The column is real
    // and the table is real; the rule that every column carried text below
    // its heading used to lose the whole bill for it.
    const unpriced =
      'BT /F1 10 Tf 72 700 Td (Item) Tj 200 0 Td (Unit) Tj 100 0 Td (Qty) Tj 60 0 Td (Rate) Tj ET ' +
      'BT /F1 10 Tf 72 686 Td (Excavation) Tj 200 0 Td (m3) Tj 110 0 Td (420) Tj ET ' +
      'BT /F1 10 Tf 72 672 Td (Blinding) Tj 200 0 Td (m2) Tj 98 0 Td (1,250) Tj ET ' +
      'BT /F1 10 Tf 72 658 Td (Disposal) Tj 200 0 Td (m3) Tj 116 0 Td (96) Tj ET';
    assert.deepEqual(readPdfText(courierPage(unpriced)).tables.map((t) => t.rows), [
      [
        ['Item', 'Unit', 'Qty', 'Rate'],
        ['Excavation', 'm3', '420', ''],
        ['Blinding', 'm2', '1,250', ''],
        ['Disposal', 'm3', '96', ''],
      ],
    ]);
  });
});

describe('ingestion’s extraction stage, now that a PDF can be read', () => {
  it('reads a PDF with a text layer natively, with its page count', () => {
    const result = extractText(Buffer.from(renderPdf(platformDocument())), 'application/pdf');
    assert.equal(result.method, 'NATIVE');
    assert.equal(result.pages, 2);
    assert.match(result.text ?? '', /Project status report/);
    assert.equal(result.note, undefined, 'nothing was left out, so nothing is noted');
  });

  it('reads the text it can and names the scanned page it cannot', () => {
    const result = extractText(wordProcessorPdf(), 'application/pdf');
    assert.equal(result.method, 'NATIVE');
    assert.match(result.note ?? '', /1 of 2 pages carries only images and no text layer/);
    assert.equal(result.tables, undefined);
    assert.equal(result.pageTables, undefined);
  });

  it('carries a PDF’s tables as rows, the first where the delimited parser puts one and all of them by page', () => {
    const result = extractText(courierPage(BILL), 'application/pdf');
    assert.equal(result.method, 'NATIVE');
    assert.deepEqual(result.tables?.[1], ['Excavation', 'm3', '420']);
    assert.equal(result.pageTables?.length, 1);
    assert.equal(result.pageTables?.[0]?.page, 1);
    assert.equal(result.note, undefined, 'a table found is not something left out');
  });

  it('routes a scan to a model that can see, saying what it saw', () => {
    const scan = assemble([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>',
      stream('q 500 0 0 700 50 50 cm /Im1 Do Q'),
      stream('\x00', '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 '),
    ]);
    const result = extractText(scan, 'application/pdf');
    assert.equal(result.method, 'NEEDS_OCR');
    assert.equal(result.pages, 1);
    assert.match(result.reason ?? '', /1 page and no text layer to read — 1 carries only images, which is what a scan looks like/);
  });

  it('refuses an encrypted PDF as unsupported rather than sending ciphertext to a model', () => {
    const locked = assemble(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>', '<< /Filter /Standard >>'], '/Encrypt 3 0 R ');
    const result = extractText(locked, 'application/pdf');
    assert.equal(result.method, 'UNSUPPORTED');
    assert.match(result.reason ?? '', /encrypted/);
  });
});
