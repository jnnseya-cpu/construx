import { deflateRawSync } from 'node:zlib';
import { documentOrigin, type ClientBranding, type DocumentBlock, type ExportDocument } from './exporter.ts';
import type { ImageResolver } from './pdf.ts';

/**
 * The same document, as an editable Word file.
 *
 * A PDF is the right thing to *issue* and the wrong thing to receive when the
 * next step is somebody's tracked changes. A quality plan a client wants to
 * comment on, a contract a solicitor marks up, a method statement a
 * subcontractor adds their own sequence to — every one of those arrives as a
 * PDF and leaves as a retyped copy, and the retyped copy is the one that goes
 * out of step with the record.
 *
 * So the choice is the customer's, per document, and both forms come off the
 * same `ExportDocument`. That matters more than it sounds: the blocks, the
 * branding, the redaction notice and the attestation are fixed before either
 * renderer sees them, so a Word file and a PDF of the same document carry the
 * same `contentHash` and are provably the same instrument in two forms. A
 * second document model per format would have been two chances to disagree.
 *
 * ---
 *
 * **Written by hand, because zero runtime dependencies is settled.** A `.docx`
 * is a ZIP of XML parts, and neither half needs a library: `node:zlib` deflates,
 * and the archive's own headers are a few dozen bytes of little-endian fields
 * written below. That is the same argument that produced `pdf.ts`, and it lands
 * the same way — the format is a published specification, not a vendor's secret.
 *
 * **It is a real Word file, not an HTML document with a `.docx` extension.**
 * That trick renders in Word and fails in Google Docs, fails on iPadOS, and
 * produces a file whose tracked changes nothing can merge. What is written here
 * is WordprocessingML: styled paragraphs, real tables with real borders, a
 * numbering definition for lists, and images as `w:drawing` with their own
 * relationships.
 *
 * **The branding is the tenancy's own.** The heading colour is the customer's
 * primary colour, the mark is their logo resolved out of the evidence store by
 * hash, and the footer is their registered office — the same three the PDF
 * uses, from the same `ClientBranding`. A document that came out carrying the
 * platform's identity instead of the customer's would be worse than no
 * document.
 */

// --- ZIP ---------------------------------------------------------------------

/**
 * CRC-32, which the ZIP central directory requires for every entry.
 *
 * The table is built once at module load rather than written out as 256
 * constants somebody would have to trust.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xff_ff_ff_ff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xff_ff_ff_ff) >>> 0;
}

type ZipEntry = { path: string; bytes: Buffer };

/**
 * A ZIP archive, deflated.
 *
 * Stored (uncompressed) entries would also be a valid `.docx`, and are what a
 * naive writer produces. Deflating matters here because a document with a
 * hundred-row schedule is mostly repeated XML — the difference is roughly an
 * order of magnitude, and these files are emailed.
 */
function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const crc = crc32(entry.bytes);
    const deflated = deflateRawSync(entry.bytes);
    // Deflate can be larger than the input for tiny, already-dense parts.
    const compressed = deflated.length < entry.bytes.length;
    const payload = compressed ? deflated : entry.bytes;
    const method = compressed ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04_03_4b_50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    // A fixed DOS timestamp. The document's own `generatedAt` is on the page
    // and in the content hash; a clock reading in the archive header would make
    // two exports of one document differ byte for byte without differing at
    // all, which is the property that lets a file be checked against a hash.
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date — 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    locals.push(local, name, payload);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02_01_4b_50, 0);
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(payload.length, 20);
    dir.writeUInt32LE(entry.bytes.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE(0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);

    offset += local.length + name.length + payload.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06_05_4b_50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, directory, end]);
}

// --- WordprocessingML --------------------------------------------------------

/** XML text escaping. A client name with an ampersand in it is not exotic. */
function esc(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A colour Word will accept: six hex digits, no leading hash. */
function hex(colour: string, fallback = '1F2933'): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(colour ?? '').trim());
  return match ? match[1]!.toUpperCase() : fallback;
}

/**
 * `xml:space="preserve"` on every run.
 *
 * Without it Word collapses leading and trailing spaces, which turns
 * "Prepared for " into "Prepared for" and quietly reflows anything that relies
 * on a trailing space between runs.
 */
const run = (text: string, properties = ''): string =>
  `<w:r>${properties}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;

const para = (content: string, properties = ''): string => `<w:p>${properties}${content}</w:p>`;

function heading(level: 1 | 2 | 3, text: string): string {
  return para(run(text), `<w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr>`);
}

/** Twips. A4 minus 25mm margins leaves 9,638 for the text column. */
const TEXT_WIDTH = 9638;

function tableXml(headers: string[], rows: string[][], branding: ClientBranding): string {
  const columns = Math.max(headers.length, ...rows.map((r) => r.length), 1);
  const width = Math.floor(TEXT_WIDTH / columns);
  const grid = Array.from({ length: columns }, () => `<w:gridCol w:w="${width}"/>`).join('');

  const cell = (text: string, header: boolean): string =>
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${
      header ? `<w:shd w:val="clear" w:color="auto" w:fill="${hex(branding.primaryColour)}"/>` : ''
    }</w:tcPr>${para(
      run(text, header ? `<w:rPr><w:b/><w:color w:val="FFFFFF"/></w:rPr>` : ''),
      '<w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr>',
    )}</w:tc>`;

  const headerRow =
    headers.length > 0
      ? `<w:tr><w:trPr><w:tblHeader/></w:trPr>${headers.map((h) => cell(h, true)).join('')}</w:tr>`
      : '';

  const bodyRows = rows
    .map(
      (row) =>
        `<w:tr>${Array.from({ length: columns }, (_, index) => cell(row[index] ?? '', false)).join('')}</w:tr>`,
    )
    .join('');

  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((edge) => `<w:${edge} w:val="single" w:sz="4" w:space="0" w:color="D5DBE0"/>`)
    .join('');

  return (
    `<w:tbl><w:tblPr><w:tblW w:w="${TEXT_WIDTH}" w:type="dxa"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr>` +
    `<w:tblGrid>${grid}</w:tblGrid>${headerRow}${bodyRows}</w:tbl>` +
    // Word requires a paragraph after a table, or the next table merges into it.
    para('')
  );
}

/**
 * An image, as a `w:drawing`.
 *
 * Sized to the text column at 96 dpi and capped, because a 4,000-pixel site
 * photograph placed at its natural size runs off the page and Word will not
 * scale it down for you.
 */
function drawingXml(relationshipId: string, index: number, caption: string): string {
  const widthEmu = 5_486_400; // 6in — the text column at A4 with 25mm margins
  const heightEmu = 3_657_600; // 4in, a 3:2 frame
  return (
    para(
      `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
        `<wp:extent cx="${widthEmu}" cy="${heightEmu}"/>` +
        `<wp:docPr id="${index + 1000}" name="Image ${index + 1}" descr="${esc(caption)}"/>` +
        `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
        `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
        `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
        `<pic:nvPicPr><pic:cNvPr id="${index + 1000}" name="Image ${index + 1}"/><pic:cNvPicPr/></pic:nvPicPr>` +
        `<pic:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
        `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm>` +
        `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
        `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`,
      '<w:pPr><w:spacing w:before="120" w:after="60"/></w:pPr>',
    ) + para(run(caption), '<w:pPr><w:pStyle w:val="Caption"/></w:pPr>')
  );
}

function blockXml(
  block: DocumentBlock,
  branding: ClientBranding,
  images: Array<{ id: string; bytes: Buffer; extension: string }>,
  resolveImage?: ImageResolver,
): string {
  switch (block.kind) {
    case 'HEADING':
      return heading(block.level, block.text);

    case 'PARAGRAPH':
      return para(run(block.text));

    case 'KEY_VALUES':
      // A two-column table rather than tabbed text: a label and its value stay
      // together when somebody edits the value to twice the length.
      return tableXml([], block.rows.map((row) => [row.label, row.value]), branding);

    case 'TABLE':
      return (
        (block.caption ? para(run(block.caption), '<w:pPr><w:pStyle w:val="Caption"/></w:pPr>') : '') +
        tableXml(block.headers, block.rows, branding)
      );

    case 'LIST':
      return block.items
        .map((item) =>
          para(
            run(item),
            `<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${block.ordered ? 2 : 1}"/></w:numPr></w:pPr>`,
          ),
        )
        .join('');

    case 'ATTESTATION':
      // The hashes are the point of the page, so they are set in a monospaced
      // face at a size that survives being read off paper.
      return (
        heading(2, 'Attestation') +
        para(run(block.instructions)) +
        tableXml(
          [],
          [
            ['Document root hash', block.rootHash],
            ['Chain head at issue', block.chainHead],
          ],
          branding,
        )
      );

    case 'PHOTOGRAPH': {
      const resolved = resolveImage?.(block.evidenceHash);
      if (!resolved) {
        // The bytes are not to hand. Naming the hash is the honest thing a
        // document can say, and it is what the JSON and HTML forms say too — an
        // empty frame would read as a photograph that failed to load.
        return para(
          run(`${block.caption} — held as evidence ${block.evidenceHash.slice(0, 16)}…, not embedded in this file.`),
          '<w:pPr><w:pStyle w:val="Caption"/></w:pPr>',
        );
      }
      const extension = resolved.mime === 'image/png' ? 'png' : resolved.mime === 'image/webp' ? 'webp' : 'jpeg';
      const id = `rId${100 + images.length}`;
      images.push({ id, bytes: resolved.bytes, extension });
      return drawingXml(id, images.length - 1, block.takenOn ? `${block.caption} — ${block.takenOn}` : block.caption);
    }

    default:
      return '';
  }
}

/**
 * Render an export document as an editable, branded Word file.
 *
 * Same `ExportDocument` the PDF renderer takes, so the two forms of one
 * document are the same instrument: same blocks, same branding, same redaction
 * notice, same `contentHash`.
 */
export function renderDocx(document: ExportDocument, resolveImage?: ImageResolver): Uint8Array {
  const branding = document.branding;
  const accent = hex(branding.primaryColour);
  const images: Array<{ id: string; bytes: Buffer; extension: string }> = [];

  const logo = branding.logoEvidenceHash ? resolveImage?.(branding.logoEvidenceHash) : undefined;
  let logoXml = '';
  if (logo) {
    const extension = logo.mime === 'image/png' ? 'png' : logo.mime === 'image/webp' ? 'webp' : 'jpeg';
    const id = `rId${100 + images.length}`;
    images.push({ id, bytes: logo.bytes, extension });
    // A mark, not a cover image: 1.5in wide, left-aligned above the title.
    logoXml = para(
      `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
        `<wp:extent cx="1371600" cy="457200"/>` +
        `<wp:docPr id="900" name="Mark" descr="${esc(branding.clientName)}"/>` +
        `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
        `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
        `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
        `<pic:nvPicPr><pic:cNvPr id="900" name="Mark"/><pic:cNvPicPr/></pic:nvPicPr>` +
        `<pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
        `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1371600" cy="457200"/></a:xfrm>` +
        `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
        `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`,
    );
  }

  const body =
    logoXml +
    // The reference and the issuing entity, before the title, exactly as the
    // PDF sets them.
    para(
      run(
        `${document.reference} · ${branding.issuingEntity ?? branding.clientName}`,
        `<w:rPr><w:color w:val="${accent}"/><w:b/><w:sz w:val="18"/></w:rPr>`,
      ),
    ) +
    (document.redactionNotice
      ? para(
          run(document.redactionNotice, '<w:rPr><w:i/><w:color w:val="8A4B00"/></w:rPr>'),
          '<w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="6" w:color="C77700"/></w:pBdr>' +
            '<w:spacing w:before="120" w:after="120"/><w:ind w:left="120"/></w:pPr>',
        )
      : '') +
    document.blocks.map((block) => blockXml(block, branding, images, resolveImage)).join('');

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
    `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
    `<w:body>${body}` +
    // A4 with 25mm margins, and the customer's legal footer as the last thing
    // on the page — registered office and company number, which is what makes
    // the document theirs rather than the platform's.
    para(
      run(branding.legalFooter, '<w:rPr><w:sz w:val="14"/><w:color w:val="6B7680"/></w:rPr>'),
      '<w:pPr><w:pBdr><w:top w:val="single" w:sz="4" w:space="6" w:color="D5DBE0"/></w:pBdr><w:spacing w:before="240"/></w:pPr>',
    ) +
    // A Word file is the one form of a document that is *expected* to be edited
    // — that is why it is offered. The verification line is what lets the
    // recipient of an edited copy tell it apart from the issued one, so it is
    // printed on the page rather than only in the file properties.
    para(
      run(
        `Content hash ${document.contentHash} · verification ${document.verification}`,
        '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="13"/><w:color w:val="8A94A0"/></w:rPr>',
      ),
    ) +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
    `<w:pgMar w:top="1418" w:right="1134" w:bottom="1418" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/>` +
    `</w:sectPr></w:body></w:document>`;

  const stylesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="20"/></w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
    [1, 2, 3]
      .map(
        (level) =>
          `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/>` +
          `<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
          `<w:pPr><w:keepNext/><w:outlineLvl w:val="${level - 1}"/><w:spacing w:before="${300 - level * 60}" w:after="${120 - level * 20}"/></w:pPr>` +
          `<w:rPr><w:b/><w:color w:val="${accent}"/><w:sz w:val="${36 - level * 6}"/></w:rPr></w:style>`,
      )
      .join('') +
    `<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:qFormat/>` +
    `<w:rPr><w:i/><w:sz w:val="16"/><w:color w:val="6B7680"/></w:rPr></w:style>` +
    `</w:styles>`;

  // Two numbering definitions: bulleted and decimal, which is every list the
  // document model can produce.
  const numberingXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/>` +
    `<w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr>` +
    `<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:hint="default"/></w:rPr></w:lvl></w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/>` +
    `<w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>` +
    `<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>` +
    `<w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>` +
    `</w:numbering>`;

  const relationships =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>` +
    images
      .map(
        (image, index) =>
          `<Relationship Id="${image.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" ` +
          `Target="media/image${index + 1}.${image.extension}"/>`,
      )
      .join('') +
    `</Relationships>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Default Extension="png" ContentType="image/png"/>` +
    `<Default Extension="jpeg" ContentType="image/jpeg"/>` +
    `<Default Extension="webp" ContentType="image/webp"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
    `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
    `</Types>`;

  const packageRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
    `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>` +
    `</Relationships>`;

  // The customer's name where Word looks for it.
  //
  // The package carried no properties at all, which is not the same as being
  // white-labelled: it opened with a blank Author and a blank Company on a
  // document that is meant to be the customer's own. Blank is what an untitled
  // draft looks like, and this is an issued instrument.
  //
  // `dc:creator` and `cp:lastModifiedBy` are both set to the issuer rather than
  // to a person. A document produced from a project record is issued by the
  // organisation carrying the duty under it; naming an individual there would
  // put one person's name on something their whole company stands behind. Who
  // pressed the button is on the page, under "Generated by", where it belongs.
  const origin = documentOrigin(document.branding);
  const coreXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ` +
    `xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${esc(document.title)}</dc:title>` +
    `<dc:subject>${esc(document.subtitle ?? '')}</dc:subject>` +
    `<dc:creator>${esc(origin)}</dc:creator>` +
    `<cp:lastModifiedBy>${esc(origin)}</cp:lastModifiedBy>` +
    // The document's own reference and content hash, so a file separated from
    // its covering email still says which record it is and what it commits to.
    `<cp:category>${esc(document.reference)}</cp:category>` +
    `<cp:contentStatus>${esc(document.contentHash)}</cp:contentStatus>` +
    `<cp:keywords>${esc(document.verification)}</cp:keywords>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${esc(document.generatedAt)}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${esc(document.generatedAt)}</dcterms:modified>` +
    `</cp:coreProperties>`;

  // `Application` conventionally names the software. On a customer's own
  // instrument the honest answer to "what made this" is the customer, for the
  // same reason the PDF's producer is theirs.
  const appXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ` +
    `xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
    `<Application>${esc(origin)}</Application>` +
    `<Company>${esc(origin)}</Company>` +
    `<Manager>${esc(origin)}</Manager>` +
    `</Properties>`;

  return zip([
    // `[Content_Types].xml` first, which the OPC specification requires.
    { path: '[Content_Types].xml', bytes: Buffer.from(contentTypes, 'utf8') },
    { path: '_rels/.rels', bytes: Buffer.from(packageRels, 'utf8') },
    { path: 'word/document.xml', bytes: Buffer.from(documentXml, 'utf8') },
    { path: 'word/styles.xml', bytes: Buffer.from(stylesXml, 'utf8') },
    { path: 'word/numbering.xml', bytes: Buffer.from(numberingXml, 'utf8') },
    { path: 'word/_rels/document.xml.rels', bytes: Buffer.from(relationships, 'utf8') },
    { path: 'docProps/core.xml', bytes: Buffer.from(coreXml, 'utf8') },
    { path: 'docProps/app.xml', bytes: Buffer.from(appXml, 'utf8') },
    ...images.map((image, index) => ({ path: `word/media/image${index + 1}.${image.extension}`, bytes: image.bytes })),
  ]);
}

/** What a browser and an email client need to open the file as Word. */
export const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
