import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';
import { describe, it } from 'node:test';
import { decodeLogo, parseDataUri, UnsupportedImageError } from '../src/export/image.ts';
import { renderPdf } from '../src/export/pdf.ts';
import { ExportService, type ClientBranding, type ExportDocument } from '../src/export/exporter.ts';
import { GoldenThreadLedger } from '../src/goldenthread/ledger.ts';

/**
 * A document carries the client's brand, and the right client's.
 *
 * Two defects, and the second is the one that would have been noticed by a
 * customer rather than by a test.
 *
 * **Branding was stored one per tenancy.** A contractor running three projects
 * for three different clients had a single slot for all of them, so every export
 * carried whichever client had been configured last. The header prints
 * "Prepared for: {clientName}" verbatim — so a payment certificate for Northgate
 * went out saying it was prepared for Meridian, on Meridian's colour, with
 * Meridian's mark. The right document, the wrong company on the front of it.
 *
 * **The PDF never drew the logo.** The HTML export emitted an `<img>` and the
 * PDF — the artefact that actually reaches a client, a regulator or an
 * adjudicator — put the client's name in their accent colour and stopped. A
 * document that claims to be prepared for a company and carries nothing of
 * theirs is the weakest branding there is.
 */

// --- a real PNG, built here so nothing about the decoder is assumed ----------

const CRC = [...Array(256)].map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  let crc = 0xffffffff;
  for (const byte of typed) crc = CRC[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  const check = Buffer.alloc(4);
  check.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, typed, check]);
}

/**
 * @param colourType 2 = RGB, 6 = RGBA, 0 = greyscale
 * @param pixel the colour every opaque pixel takes
 */
function png(width: number, height: number, colourType: 0 | 2 | 6, pixel: number[], alpha = 255): string {
  const channels = colourType === 0 ? 1 : colourType === 2 ? 3 : 4;
  const stride = width * channels;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + stride)] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const offset = y * (1 + stride) + 1 + x * channels;
      for (let c = 0; c < Math.min(channels, 3); c += 1) raw[offset + c] = pixel[c] ?? pixel[0]!;
      if (colourType === 6) raw[offset + 3] = x === 0 ? 0 : alpha;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colourType;
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

const branding = (over: Partial<ClientBranding> = {}): ClientBranding => ({
  clientName: 'Meridian Infrastructure Ltd',
  primaryColour: '#1d4ed8',
  legalFooter: 'Meridian Infrastructure Ltd, registered in England',
  documentReferencePrefix: 'MER',
  ...over,
});

const documentFor = (brand: ClientBranding): ExportDocument => ({
  id: 'doc-1',
  reference: 'MER-00001',
  title: 'Interim payment certificate',
  branding: brand,
  audience: 'CLIENT',
  format: 'PDF',
  generatedAt: '2026-08-26T12:00:00.000Z',
  generatedBy: 'user-1',
  projectId: 'project-1',
  blocks: [{ kind: 'PARAGRAPH', text: 'Issued under clause 4.10.' }],
  contentHash: 'sha256:abc',
});

describe('the right client is on the document', () => {
  it('uses the project\'s own client identity ahead of the tenancy\'s', () => {
    // The defect. Reading the tenancy first would put the wrong client on every
    // project that had bothered to configure its own.
    const exports = new ExportService(new GoldenThreadLedger());
    exports.setBranding('tenant-1', branding({ clientName: 'Meridian Infrastructure Ltd' }));
    exports.setBranding('tenant-1', branding({ clientName: 'Northgate Developments plc' }), 'project-northgate');

    assert.equal(exports.branding('tenant-1', 'project-northgate').clientName, 'Northgate Developments plc');
  });

  it('falls back to the tenancy for a project with no client of its own', () => {
    // A document that belongs to no particular client carries the contractor's
    // own identity, which is correct rather than a gap.
    const exports = new ExportService(new GoldenThreadLedger());
    exports.setBranding('tenant-1', branding({ clientName: 'Meridian Infrastructure Ltd' }));

    assert.equal(exports.branding('tenant-1', 'project-with-no-client').clientName, 'Meridian Infrastructure Ltd');
  });

  it('keeps one tenancy\'s project branding out of another\'s reach', () => {
    // Keyed by tenancy and project together. A map keyed on a bare project id
    // would let a guessed id read another company's client identity.
    const exports = new ExportService(new GoldenThreadLedger());
    exports.setBranding('tenant-1', branding({ clientName: 'Northgate Developments plc' }), 'p-1');
    exports.setBranding('tenant-2', branding({ clientName: 'Harbour Estates Ltd' }));

    assert.equal(exports.projectBranding('tenant-2', 'p-1'), undefined, 'a project id crossed a tenancy boundary');
    assert.equal(exports.branding('tenant-2', 'p-1').clientName, 'Harbour Estates Ltd');
  });

  it('still refuses to export for a tenancy with no branding at all', () => {
    // The strict check stays strict. An unbranded document reaching a client is
    // worse than no document, and none of this relaxes that.
    const exports = new ExportService(new GoldenThreadLedger());
    assert.throws(() => exports.branding('tenant-nobody-configured'), /BRANDING_NOT_CONFIGURED|branding/i);
  });
});

describe('the logo reaches the page', () => {
  it('decodes an RGB PNG to embeddable samples', () => {
    const decoded = decodeLogo(png(8, 4, 2, [255, 102, 0]))!;

    assert.equal(decoded.width, 8);
    assert.equal(decoded.height, 4);
    assert.equal(decoded.filter, 'FlateDecode');
    assert.equal(decoded.components, 3);

    const flat = inflateSync(decoded.data);
    assert.deepEqual([flat[0], flat[1], flat[2]], [255, 102, 0], 'the colour did not survive decoding');
  });

  it('composites transparency onto white rather than dropping it', () => {
    // The page is white, so the result is what a reader sees either way — and
    // it avoids a soft-mask stream that some readers handle badly. A logo drawn
    // on black where its background should be is worse than one omitted.
    const decoded = decodeLogo(png(4, 2, 6, [255, 102, 0]))!;
    const flat = inflateSync(decoded.data);

    assert.deepEqual([flat[0], flat[1], flat[2]], [255, 255, 255], 'a transparent pixel did not become white');
    assert.deepEqual([flat[3], flat[4], flat[5]], [255, 102, 0], 'an opaque pixel was altered');
  });

  it('carries greyscale as one component rather than inflating it to three', () => {
    const decoded = decodeLogo(png(4, 4, 0, [128]))!;
    assert.equal(decoded.components, 1);
  });

  it('embeds the image once and draws it, whatever the page count', () => {
    const bytes = renderPdf(documentFor(branding({ logoRef: png(120, 40, 2, [255, 102, 0]) })));
    const file = Buffer.from(bytes).toString('latin1');

    assert.ok(file.includes('/Subtype /Image'), 'the PDF carries no image');
    assert.ok(file.includes('/Logo Do'), 'the image is embedded and never drawn');
    assert.equal(
      file.split('/Subtype /Image').length - 1,
      1,
      'the logo is embedded more than once — a long bundle would carry a copy per page',
    );
  });

  it('produces a document without one when no logo was supplied', () => {
    // Absent is not an error. A client who supplied no mark gets a document with
    // their name and colour, and no placeholder standing in for a logo.
    const bytes = renderPdf(documentFor(branding()));
    const file = Buffer.from(bytes).toString('latin1');

    assert.ok(!file.includes('/Subtype /Image'));
    assert.ok(file.includes('Meridian Infrastructure Ltd'), 'the client name is missing too');
  });
});

describe('a logo that cannot be used is refused, not swallowed', () => {
  it('names the format it will not take', () => {
    // A logo silently dropped is worse than one refused: the document still goes
    // out, looking finished, missing the thing somebody asked for.
    assert.throws(
      () => decodeLogo('data:image/svg+xml;base64,PHN2Zy8+'),
      (error: Error) => error instanceof UnsupportedImageError && /svg/i.test(error.message),
    );
  });

  it('refuses an interlaced PNG by name rather than half-decoding it', () => {
    const plain = Buffer.from(png(4, 4, 2, [1, 2, 3]).split(',')[1]!, 'base64');
    // Flip the interlace byte in IHDR: signature(8) + length(4) + type(4) + 12.
    plain[8 + 4 + 4 + 12] = 1;
    assert.throws(
      () => decodeLogo(`data:image/png;base64,${plain.toString('base64')}`),
      (error: Error) => /interlac/i.test(error.message),
    );
  });

  it('leaves a storage reference alone rather than treating it as a failure', () => {
    // Not every logoRef is inline. A stored object reference is resolved
    // elsewhere or the logo is left off; it is not a malformed image.
    assert.equal(decodeLogo('evidence://tenant-1/logo.png'), undefined);
  });

  it('reads a data URI apart into its type and bytes', () => {
    const parsed = parseDataUri('data:image/png;base64,AAECAw==')!;
    assert.equal(parsed.mime, 'image/png');
    assert.deepEqual([...parsed.bytes], [0, 1, 2, 3]);
  });
});

/**
 * The cover.
 *
 * A branded document that opens straight into a table reads as a printout
 * rather than as something issued. The cover carries the four things somebody
 * checks before reading a word — what it is, who it is for, who issued it, and
 * which document this is — and it is always there, image or no image.
 */
describe('the cover page', () => {
  const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');

  it('is drawn even when no cover image is set', () => {
    const pdf = latin1(renderPdf(documentFor(branding())));
    // Two pages where the content alone would fit on one: the cover, then the
    // content. A cover that only appears when somebody supplies an image would
    // make the document's shape depend on whether marketing had a photograph.
    assert.ok([...pdf.matchAll(/\/Type \/Page /g)].length >= 2, 'a cover page exists');
    assert.ok(pdf.includes('(Interim payment certificate) Tj'), 'the title is on it');
    assert.ok(pdf.includes('(MERIDIAN INFRASTRUCTURE LTD) Tj'), 'the client is named on it');
  });

  it('names who issued it, when that is not who it was prepared for', () => {
    const pdf = latin1(renderPdf(documentFor(branding({ issuingEntity: 'Ashworth Contracting Ltd' }))));
    // The distinction the cover exists to preserve: a subcontractor reading a
    // method statement needs to know which party carries the duty under it, and
    // that is not always the party it was prepared for.
    assert.ok(pdf.includes('(Ashworth Contracting Ltd) Tj'), 'the issuing entity is on the cover');
    assert.ok(pdf.includes('(Meridian Infrastructure Ltd) Tj'), 'so is the client it was prepared for');
  });

  it('carries the content hash on the cover itself', () => {
    const pdf = latin1(renderPdf(documentFor(branding())));
    // The cover is the page that gets photographed, forwarded and printed on
    // its own. The hash is what makes any of that checkable afterwards, so it
    // is on the cover as well as in the running footer.
    const firstPageEnd = pdf.indexOf('/Type /Page ');
    assert.ok(firstPageEnd > 0);
    assert.ok(pdf.includes('Content hash sha256:'), 'the hash is present');
  });

  it('places a cover image resolved out of the evidence store', () => {
    const bytes = Buffer.from(png(8, 6, 2, [10, 20, 30]).split(',')[1]!, 'base64');
    const document = documentFor(branding({ coverEvidenceHash: 'sha256:cover' }));
    const pdf = latin1(renderPdf(document, (hash) => (hash === 'sha256:cover' ? { mime: 'image/png', bytes } : undefined)));
    assert.ok(pdf.includes('/Cover'), 'the cover image is embedded and referenced');
  });

  it('falls back to type when the cover image cannot be decoded', () => {
    const document = documentFor(branding({ coverEvidenceHash: 'sha256:cover' }));
    // A cover in a format the renderer cannot place must not stop the document
    // being produced. The page is drawn without it — the same rule the
    // photographs and the logo follow, and for the same reason: a bundle
    // somebody needs is worth more than a picture on its first page.
    const pdf = latin1(
      renderPdf(document, () => ({ mime: 'image/tiff', bytes: Buffer.from('not something this renderer can place') })),
    );
    assert.ok(!pdf.includes('/Cover'), 'nothing is embedded');
    assert.ok(pdf.includes('(Interim payment certificate) Tj'), 'the cover is still drawn');
  });

  it('embeds a cover shown inside the document only once', () => {
    const bytes = Buffer.from(png(8, 6, 2, [10, 20, 30]).split(',')[1]!, 'base64');
    const base = documentFor(branding({ coverEvidenceHash: 'sha256:shared' }));
    const document: ExportDocument = {
      ...base,
      blocks: [...base.blocks, { kind: 'PHOTOGRAPH', evidenceHash: 'sha256:shared', caption: 'The same image again' }],
    };
    const pdf = latin1(renderPdf(document, () => ({ mime: 'image/png', bytes })));
    // One XObject, referenced twice. A document that used the same picture as
    // its cover and as evidence must not carry two copies of it.
    assert.equal([...pdf.matchAll(/\/Subtype \/Image/g)].length, 1);
  });
});
