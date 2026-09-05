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
