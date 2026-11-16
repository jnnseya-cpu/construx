import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractText } from '../src/evidence/ingest.ts';
import { readPdfText } from '../src/evidence/pdftext.ts';
import { describeQuoteSource, locateQuote, type SourceDocument } from '../src/domain/tendersource.ts';

/**
 * Where a requirement was read from, found in the documents by code.
 *
 * A citation that is wrong is worse than none: a bid manager turns to page 12
 * and the clause is not there. So the page is taken from the PDF's own page
 * tree, a quote is matched as the document prints it, and a passage that is
 * not in the documents is said to be not found rather than given a page.
 */

function assemble(objects: string[]): Buffer {
  let out = '%PDF-1.5\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const stream = (content: string): string => `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;

/** Three pages; the second is blank, as a divider page in a tender volume is. */
function threePagePdf(): Buffer {
  return assemble([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 /MediaBox [0 0 595 842] /Resources << /Font << /F1 6 0 R >> >> >>',
    '<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>',
    '<< /Type /Page /Parent 2 0 R /Contents 8 0 R >>',
    '<< /Type /Page /Parent 2 0 R /Contents 9 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    stream('BT /F1 12 Tf 72 700 Td (1.16 Return of Tenders. Paper submissions will not be accepted.) Tj ET'),
    stream(''),
    stream('BT /F1 12 Tf 72 700 Td (2.4 The Contractor shall hold Employers Liability insurance of 10 million.) Tj ET'),
  ]);
}

describe('the page a passage is printed on', () => {
  it('records where each page with text begins, skipping a blank page without renumbering', () => {
    const reading = readPdfText(threePagePdf());
    assert.deepEqual(
      reading.pageStarts?.map((start) => start.page),
      [1, 3],
    );
    const third = reading.pageStarts![1]!;
    assert.match(reading.text.slice(third.offset), /^2\.4 The Contractor/);
  });

  it('carries the page starts into what ingestion stores', () => {
    const extraction = extractText(threePagePdf(), 'application/pdf');
    assert.equal(extraction.method, 'NATIVE');
    assert.deepEqual(extraction.pageStarts?.map((start) => start.page), [1, 3]);
  });

  it('cites a passage on page three as page three, with the clause and the passage as printed', () => {
    const extraction = extractText(threePagePdf(), 'application/pdf');
    const documents: SourceDocument[] = [
      { ingestionId: 'F1', filename: 'Volume 1 - ITT.pdf', text: extraction.text!, pageStarts: extraction.pageStarts! },
    ];
    const source = locateQuote(documents, {
      quote: 'the contractor shall hold  Employer’s Liability insurance',
      fallback: 'Employers liability insurance of £10m',
      clause: '2.4',
    });
    // The apostrophe the model added is not in the document; the requirement's
    // own words then decide it — and they are not there either, so not found.
    assert.equal(source.located, false);

    const found = locateQuote(documents, { quote: 'The Contractor shall hold\nEmployers Liability insurance', clause: '2.4' });
    assert.equal(found.located, true);
    assert.equal(found.document, 'Volume 1 - ITT.pdf');
    assert.equal(found.ingestionId, 'F1');
    assert.equal(found.page, 3);
    assert.equal(found.clause, '2.4');
    assert.equal(found.quote, 'The Contractor shall hold Employers Liability insurance');
    assert.equal(describeQuoteSource(found), 'Volume 1 - ITT.pdf, p. 3, 2.4');
  });
});

describe('finding a passage across the pack', () => {
  const documents: SourceDocument[] = [
    { filename: 'ITT.docx', text: 'Tenders must be returned through the portal.\nLate tenders will not be considered.' },
    { filename: 'Questionnaire.docx', text: 'Q2 Describe your approach to project management, including key staff.' },
  ];

  it('names the document that holds it, matched across case, line breaks and curly quotes', () => {
    const found = locateQuote(documents, { quote: 'q2 describe your approach   to PROJECT management' });
    assert.equal(found.document, 'Questionnaire.docx');
    assert.equal(found.page, undefined, 'a Word document has no page tree to cite');
    assert.equal(found.quote, 'Q2 Describe your approach to project management');
  });

  it('falls back to the requirement’s own words when the quote is not in the pack', () => {
    const found = locateQuote(documents, { quote: 'Tenders shall be submitted electronically', fallback: 'Late tenders will not be considered' });
    assert.equal(found.located, true);
    assert.equal(found.document, 'ITT.docx');
  });

  it('says not found, keeping the quote given, rather than inventing a place', () => {
    const missing = locateQuote(documents, { quote: 'A performance bond of 10% is required', clause: '4.2' });
    assert.deepEqual(missing, { clause: '4.2', quote: 'A performance bond of 10% is required', located: false });
    assert.match(describeQuoteSource(missing), /not found in the documents/);
  });

  it('does not cite a fragment so short it would be found anywhere', () => {
    assert.equal(locateQuote(documents, { quote: 'the portal' }).located, false);
  });

  it('finds nothing where the text was pasted rather than uploaded', () => {
    assert.equal(locateQuote([], { quote: 'Tenders must be returned through the portal.' }).located, false);
  });
});
