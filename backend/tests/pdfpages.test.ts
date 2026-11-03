import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractPdfPages, PdfPageError, readPdfText, scanPdfBundle } from '../src/evidence/pdftext.ts';

/**
 * Carving a page range out of a bundled PDF.
 *
 * The case this exists for is the real one: a tender arrives as a single
 * "tender documentation" PDF of hundreds of pages, and the take-off needs to be
 * pointed at the three sheets that carry the foundation detail rather than the
 * whole bundle — which no vision model will take in one call. The extractor has
 * to produce a *smaller* file (so a provider counting physical pages accepts it)
 * that still renders: the kept pages with their fonts, images and inherited
 * geometry, and nothing the kept pages do not touch.
 */

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

const stream = (content: string, dict = ''): string =>
  `<< /Length ${Buffer.byteLength(content, 'latin1')} ${dict}>>\nstream\n${content}\nendstream`;

/**
 * Five pages. MediaBox and the shared font live on the Pages node, so each page
 * inherits them rather than stating them — the case an extractor gets wrong by
 * dropping. Page three additionally carries an image of its own.
 */
function fivewayPdf(): Buffer {
  return assemble([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R 7 0 R] /Count 5 /MediaBox [0 0 595 842] /Resources << /Font << /F1 8 0 R >> >> >>',
    '<< /Type /Page /Parent 2 0 R /Contents 9 0 R >>',
    '<< /Type /Page /Parent 2 0 R /Contents 10 0 R >>',
    '<< /Type /Page /Parent 2 0 R /Contents 11 0 R /Resources << /Font << /F1 8 0 R >> /XObject << /Im 14 0 R >> >> >>',
    '<< /Type /Page /Parent 2 0 R /Contents 12 0 R >>',
    '<< /Type /Page /Parent 2 0 R /Contents 13 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    stream('BT /F1 12 Tf 72 700 Td (Page one alpha) Tj ET'),
    stream('BT /F1 12 Tf 72 700 Td (Page two bravo) Tj ET'),
    stream('BT /F1 12 Tf 72 700 Td (Page three charlie) Tj ET q 100 0 0 100 50 50 cm /Im Do Q'),
    stream('BT /F1 12 Tf 72 700 Td (Page four delta) Tj ET'),
    stream('BT /F1 12 Tf 72 700 Td (Page five echo) Tj ET'),
    stream('IMAGEBYTESHERE', '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 '),
  ]);
}

describe('carving a page range out of a PDF', () => {
  it('keeps exactly the selected pages and drops the rest', () => {
    const sliced = extractPdfPages(fivewayPdf(), 2, 3);
    const reading = readPdfText(sliced);

    assert.equal(reading.pages, 2, 'the slice should contain only the two selected pages');
    assert.match(reading.text, /Page two bravo/);
    assert.match(reading.text, /Page three charlie/);
    assert.doesNotMatch(reading.text, /alpha|delta|echo/);
  });

  it('carries the resources the kept pages reference — the font and the image', () => {
    const sliced = extractPdfPages(fivewayPdf(), 2, 3).toString('latin1');
    // The shared font (inherited by page two, owned by page three) survives once.
    assert.match(sliced, /\/Helvetica/);
    // The image page three uses is copied in, bytes intact.
    assert.match(sliced, /IMAGEBYTESHERE/);
  });

  it('inlines the MediaBox each page inherited, so it is not lost with the tree', () => {
    const sliced = extractPdfPages(fivewayPdf(), 4, 4);
    const reading = readPdfText(sliced);
    assert.equal(reading.pages, 1);
    assert.match(reading.text, /Page four delta/);
    // Each kept page states its own geometry now rather than inheriting it from a
    // Pages node that no longer sits above it.
    assert.match(sliced.toString('latin1'), /\/MediaBox \[0 0 595 842\]/);
  });

  it('takes a single first page', () => {
    const reading = readPdfText(extractPdfPages(fivewayPdf(), 1, 1));
    assert.equal(reading.pages, 1);
    assert.match(reading.text, /Page one alpha/);
  });

  it('takes the whole document when the range spans it', () => {
    const reading = readPdfText(extractPdfPages(fivewayPdf(), 1, 5));
    assert.equal(reading.pages, 5);
    assert.match(reading.text, /alpha[\s\S]*bravo[\s\S]*charlie[\s\S]*delta[\s\S]*echo/);
  });

  it('refuses a range outside the document by name', () => {
    assert.throws(
      () => extractPdfPages(fivewayPdf(), 4, 9),
      (error: unknown) => error instanceof PdfPageError && error.code === 'PDF_PAGE_RANGE',
    );
    assert.throws(
      () => extractPdfPages(fivewayPdf(), 0, 1),
      (error: unknown) => error instanceof PdfPageError && error.code === 'PDF_PAGE_RANGE',
    );
    assert.throws(
      () => extractPdfPages(fivewayPdf(), 3, 2),
      (error: unknown) => error instanceof PdfPageError && error.code === 'PDF_PAGE_RANGE',
    );
  });

  it('refuses an encrypted file rather than returning it half-built', () => {
    const encrypted = assemble(
      [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 595 842] >>',
        '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
        stream('BT /F1 12 Tf 72 700 Td (secret) Tj ET'),
        '<< /Filter /Standard /V 2 /R 3 >>',
      ],
      '/Encrypt 5 0 R ',
    );
    assert.throws(
      () => extractPdfPages(encrypted, 1, 1),
      (error: unknown) => error instanceof PdfPageError && error.code === 'PDF_ENCRYPTED',
    );
  });

  it('refuses a file with no readable page tree', () => {
    assert.throws(
      () => extractPdfPages(Buffer.from('%PDF-1.7\nnothing here\n', 'latin1'), 1, 1),
      (error: unknown) => error instanceof PdfPageError && error.code === 'PDF_NO_PAGES',
    );
  });
});

/** Six pages under two bookmarks: three visual sheets, then three pages of prose. */
function bookmarkedBundle(): Buffer {
  const fewWords = 'BT /F1 12 Tf 72 700 Td (DWG-01) Tj ET';
  const manyWords = `BT /F1 10 Tf 72 700 Td (${Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /Outlines 16 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R 7 0 R 8 0 R] /Count 6 /MediaBox [0 0 595 842] /Resources << /Font << /F1 15 0 R >> >> >>',
    '<< /Type /Page /Parent 2 0 R /Contents 9 0 R >>',
    '<< /Type /Page /Parent 2 0 R /Contents 10 0 R >>',
    '<< /Type /Page /Parent 2 0 R /Contents 11 0 R >>',
    '<< /Type /Page /Parent 2 0 R /Contents 12 0 R >>',
    '<< /Type /Page /Parent 2 0 R /Contents 13 0 R >>',
    '<< /Type /Page /Parent 2 0 R /Contents 14 0 R >>',
    stream(fewWords),
    stream(fewWords),
    stream(fewWords),
    stream(manyWords),
    stream(manyWords),
    stream(manyWords),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Outlines /First 17 0 R /Last 18 0 R /Count 2 >>',
    '<< /Title (Drawings) /Parent 16 0 R /Next 18 0 R /Dest [3 0 R /XYZ null null null] >>',
    '<< /Title (Structural Report) /Parent 16 0 R /Prev 17 0 R /Dest [6 0 R /XYZ null null null] >>',
  ];
  return assemble(objects);
}

describe('scanning a bundle into sections', () => {
  it('reads the file’s own bookmarks into named sections with page ranges', () => {
    const scan = scanPdfBundle(bookmarkedBundle());
    assert.equal(scan.pageCount, 6);
    assert.equal(scan.hasOutline, true);
    assert.equal(scan.sections.length, 2);
    assert.deepEqual(
      scan.sections.map((s) => [s.title, s.fromPage, s.toPage, s.kind]),
      [
        ['Drawings', 1, 3, 'DRAWINGS'],
        ['Structural Report', 4, 6, 'TEXT'],
      ],
    );
  });

  it('falls back to runs of visual pages when there are no bookmarks', () => {
    // The four-page fixture has no outline; every page is a one-word sheet, so the
    // whole run reads as visual.
    const scan = scanPdfBundle(fivewayPdf());
    assert.equal(scan.hasOutline, false);
    assert.ok(scan.sections.length >= 1);
    assert.equal(scan.sections[0]!.fromPage, 1);
    assert.ok(scan.sections.every((s) => s.toPage >= s.fromPage));
  });

  it('reports nothing for a file with no pages rather than throwing', () => {
    const scan = scanPdfBundle(Buffer.from('%PDF-1.7\nnothing\n', 'latin1'));
    assert.deepEqual(scan, { pageCount: 0, hasOutline: false, sections: [] });
  });
});
