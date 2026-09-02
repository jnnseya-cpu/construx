import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { describe, it } from 'node:test';
import { ACUWallet } from '../src/billing/acu.ts';
import { config } from '../src/config.ts';
import { renderDocx, DOCX_CONTENT_TYPE } from '../src/export/docx.ts';
import { renderAndCharge, quoteRender } from '../src/export/render.ts';
import type { ClientBranding, ExportDocument } from '../src/export/exporter.ts';

/**
 * The same document, as an editable Word file — and paid for.
 *
 * A PDF is the right thing to issue and the wrong thing to receive when the
 * next step is somebody's tracked changes. Every quality plan a client wants to
 * comment on left this platform as a PDF and came back as a retyped copy, and
 * the retyped copy is the one that goes out of step with the record.
 *
 * Two properties are what make this worth having rather than a second export
 * button, and both are asserted below:
 *
 *   - **it is a real Word package**, not HTML with a `.docx` extension — that
 *     trick renders in Word, fails in Google Docs, and produces a file whose
 *     tracked changes nothing can merge;
 *   - **it is the same instrument as the PDF** — both render from one
 *     `ExportDocument`, so they carry the same content hash, the same branding
 *     and the same redaction notice.
 *
 * And rendering is metered. Generation was charged and *issuing* was free, so a
 * tenancy could take five hundred branded reports out and the statement would
 * show the writing and none of the leaving.
 */

const BRANDING: ClientBranding = {
  clientName: 'Meridian Infrastructure Group',
  issuingEntity: 'Meridian Infrastructure Group Limited',
  primaryColour: '#0B5FFF',
  legalFooter: 'Registered in England 04412233 · 40 Wellington Street, Leeds LS1 2DE',
  documentReferencePrefix: 'CX',
};

function documentWith(overrides: Partial<ExportDocument> = {}): ExportDocument {
  return {
    id: 'doc-1',
    reference: 'CX-QP-0001',
    title: 'Project Quality Plan',
    subtitle: 'Calderdale Reservoir Renewal',
    branding: BRANDING,
    audience: 'CLIENT',
    format: 'DOCX',
    generatedAt: '2026-08-29T15:00:00Z',
    generatedBy: 'qs',
    projectId: 'project-1',
    contentHash: 'abc123',
    verification: 'CXV1:t-1:unchecked',
    blocks: [
      { kind: 'HEADING', level: 1, text: 'Project Quality Plan' },
      { kind: 'PARAGRAPH', text: 'How quality is assured on the spillway works.' },
      { kind: 'KEY_VALUES', rows: [{ label: 'Prepared for', value: 'Yorkshire Water Services Limited' }] },
      {
        kind: 'TABLE',
        caption: 'Inspection and test plan',
        headers: ['Ref', 'Activity', 'Hold point'],
        rows: [['ITP-01', 'Reinforcement fixing', 'Yes'], ['ITP-02', 'Concrete pour', 'Yes & witnessed']],
      },
      { kind: 'LIST', ordered: false, items: ['Compaction testing to specification'] },
      {
        kind: 'ATTESTATION',
        rootHash: 'f3a9'.repeat(16),
        chainHead: '9c21'.repeat(16),
        // The wording the exporter actually produces: how to recompute the
        // chain, not where to visit. A fixture that sent the reader to this
        // platform's own address was modelling something the platform does not
        // do, and it was the only reason a rendered document ever mentioned it.
        instructions:
          'Recompute the chain from the first event forward: any insertion, deletion or alteration produces a different chain head.',
      },
    ],
    ...overrides,
  };
}

/** Read the parts back out of the package, as Word does. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const buffer = Buffer.from(bytes);
  const parts = new Map<string, string>();

  // Walk the local file headers rather than the central directory: this is a
  // test of what was written, and reading the directory would take the
  // writer's own word for where things are.
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04_03_4b_50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    const payload = buffer.subarray(start, start + compressedSize);
    parts.set(name, method === 8 ? inflateRawSync(payload).toString('utf8') : payload.toString('utf8'));
    offset = start + compressedSize;
  }
  return parts;
}

describe('it is a real Word package', () => {
  const parts = unzip(renderDocx(documentWith()));

  it('carries the parts the format requires', () => {
    // A `.docx` missing any of these opens in nothing. The content types part
    // in particular is what tells a reader that `word/document.xml` is a Word
    // document rather than arbitrary XML.
    for (const required of [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
      'word/styles.xml',
      'word/numbering.xml',
      'word/_rels/document.xml.rels',
    ]) {
      assert.ok(parts.has(required), `${required} is missing from the package`);
    }
  });

  it('declares WordprocessingML rather than dressing HTML as a document', () => {
    const document = parts.get('word/document.xml')!;
    assert.match(document, /xmlns:w="http:\/\/schemas\.openxmlformats\.org\/wordprocessingml\/2006\/main"/);
    assert.match(document, /<w:body>/);
    // Real tables, not a paragraph of tabs pretending to be one.
    assert.match(document, /<w:tbl>/);
    assert.match(document, /<w:tblGrid>/);
    assert.ok(!/<table|<div|<span/.test(document), 'HTML markup leaked into the document part');
  });

  it('ends the body with a section, which is what fixes the page size', () => {
    // `w:sectPr` has to be the last child of `w:body`. Elsewhere, Word repairs
    // the file on open — which is the dialog that tells a client the document
    // they were sent is damaged.
    const document = parts.get('word/document.xml')!;
    // The page size has to be *inside* the section, and the section has to be
    // the last thing in the body. Asserting only that both strings appear let a
    // mutation that moved the size outside the section pass.
    assert.match(document, /<w:sectPr><w:pgSz w:w="11906" w:h="16838"\/><w:pgMar[^>]*\/><\/w:sectPr><\/w:body><\/w:document>$/);
  });

  it('resolves every relationship it references', () => {
    // A dangling `r:embed` is the commonest way a generated document opens with
    // a red X where a photograph should be.
    const document = parts.get('word/document.xml')!;
    const rels = parts.get('word/_rels/document.xml.rels')!;
    for (const [, id] of document.matchAll(/r:embed="([^"]+)"/g)) {
      assert.match(rels, new RegExp(`Id="${id}"`), `${id} is referenced but has no relationship`);
    }
  });

  it('gives every list a numbering definition to point at', () => {
    const document = parts.get('word/document.xml')!;
    const numbering = parts.get('word/numbering.xml')!;
    for (const [, id] of document.matchAll(/<w:numId w:val="(\d+)"\/>/g)) {
      assert.match(numbering, new RegExp(`<w:num w:numId="${id}">`), `numbering ${id} is used and not defined`);
    }
  });

  it('names every style it uses', () => {
    const document = parts.get('word/document.xml')!;
    const styles = parts.get('word/styles.xml')!;
    for (const [, id] of document.matchAll(/<w:pStyle w:val="([^"]+)"\/>/g)) {
      assert.match(styles, new RegExp(`w:styleId="${id}"`), `style ${id} is used and not defined`);
    }
  });
});

describe('it carries the customer’s identity, not the platform’s', () => {
  const parts = unzip(renderDocx(documentWith()));

  it('sets the headings in the tenancy’s own colour', () => {
    // A document that came out in the platform's colours would be worse than no
    // document — it is the customer's instrument, sent under their name.
    assert.match(parts.get('word/styles.xml')!, /<w:color w:val="0B5FFF"\/>/);
  });

  it('puts the registered office on the page', () => {
    assert.match(parts.get('word/document.xml')!, /Registered in England 04412233/);
  });

  it('escapes a client name that contains XML, rather than producing a broken file', () => {
    // Exercised on the fields the renderer actually emits — the issuing entity
    // in the reference line and the footer — rather than on `clientName`, which
    // the exporter puts into a block and this fixture builds by hand.
    const parts2 = unzip(
      renderDocx(
        documentWith({
          branding: {
            ...BRANDING,
            issuingEntity: 'Smith & Sons <Contracts> Ltd',
            legalFooter: 'Registered "office" & trading address',
          },
        }),
      ),
    );
    const document = parts2.get('word/document.xml')!;
    assert.ok(!/<Contracts>/.test(document), 'an angle bracket went in raw');
    assert.match(document, /Smith &amp; Sons &lt;Contracts&gt; Ltd/);
    assert.match(document, /Registered &quot;office&quot; &amp; trading address/);

    // A bare ampersand anywhere makes the part malformed, and Word refuses the
    // whole file rather than one run. The table cell in the base fixture —
    // "Yes & witnessed" — is the same check on ordinary content.
    assert.ok(!/&(?!amp;|lt;|gt;|quot;|#)/.test(document), 'an unescaped ampersand reached the document part');
    assert.match(parts.get('word/document.xml')!, /Yes &amp; witnessed/);
  });

  it('states a photograph it does not hold rather than leaving an empty frame', () => {
    // The bytes may be on a device or aged out under the retention policy.
    // Naming the hash is what the JSON and HTML forms do, and a frame that
    // failed to load reads as a fault in the document.
    const parts3 = unzip(
      renderDocx(
        documentWith({
          blocks: [{ kind: 'PHOTOGRAPH', caption: 'Spillway crest', evidenceHash: 'a'.repeat(64) }],
        }),
      ),
    );
    assert.match(parts3.get('word/document.xml')!, /not embedded in this file/);
  });
});

describe('taking a document out is charged, in either form', () => {
  const renderers = {
    pdf: () => new Uint8Array([1, 2, 3]),
    docx: (document: ExportDocument) => renderDocx(document),
  };

  function fundedWallet(): ACUWallet {
    const wallet = new ACUWallet('tenant-1');
    wallet.topUp(500_000);
    return wallet;
  }

  it('quotes before anything is pressed', () => {
    const quote = quoteRender(fundedWallet());
    assert.ok(quote.chargeMinor > 0, 'a render was quoted at nothing');
    assert.equal(quote.affordable, true);
  });

  it('charges the same for Word as for PDF', () => {
    // They are the same instrument off the same document. Charging by file
    // extension would push people towards the form that suits the bill rather
    // than the one that suits the job.
    const asPdf = renderAndCharge(fundedWallet(), documentWith(), { format: 'PDF' }, renderers);
    const asDocx = renderAndCharge(fundedWallet(), documentWith(), { format: 'DOCX' }, renderers);

    assert.equal(asPdf.chargedMinor, asDocx.chargedMinor);
    assert.ok(asPdf.chargedMinor > 0, 'rendering was free, which is how five hundred exports leave unbilled');

    // The *held* amount too, not only the settled one. Comparing the final
    // charge alone let a mutation that tripled the Word hold pass: the hold is
    // what refuses a render, so a form held at three times the price is a form
    // that becomes unaffordable first.
    const held = (format: 'PDF' | 'DOCX'): number => {
      const wallet = fundedWallet();
      const before = wallet.availableMinor();
      renderAndCharge(wallet, documentWith(), { format }, renderers);
      return before - wallet.availableMinor();
    };
    assert.equal(held('PDF'), held('DOCX'), 'one form reserves more of the balance than the other');
  });

  it('returns the right content type and extension for each', () => {
    const wallet = fundedWallet();
    assert.equal(renderAndCharge(wallet, documentWith(), { format: 'PDF' }, renderers).contentType, 'application/pdf');
    const word = renderAndCharge(wallet, documentWith(), { format: 'DOCX' }, renderers);
    assert.equal(word.contentType, DOCX_CONTENT_TYPE);
    assert.match(word.filename, /\.docx$/);
  });

  it('lands on the statement as an export, beside everything else', () => {
    const wallet = fundedWallet();
    renderAndCharge(wallet, documentWith(), { format: 'DOCX', projectId: 'project-1' }, renderers);

    const entries = wallet.entries({ module: 'EXPORT' });
    assert.ok(entries.length > 0, 'the render does not appear in the ACU statement');
    assert.ok(
      entries.some((entry) => entry.feature === 'document_render_docx'),
      'the statement does not say which form was taken',
    );
  });

  it('charges nothing when the render fails', () => {
    // A customer must never be billed for a document they did not receive.
    const wallet = fundedWallet();
    const before = wallet.availableMinor();

    assert.throws(() =>
      renderAndCharge(wallet, documentWith(), { format: 'DOCX' }, {
        pdf: () => new Uint8Array(),
        docx: () => {
          throw new Error('renderer blew up');
        },
      }),
    );

    assert.equal(wallet.availableMinor(), before, 'a failed render still took money');
    assert.equal(wallet.heldMinor(), 0, 'a failed render left the hold in place');
  });

  it('refuses when the wallet cannot cover it, rather than rendering for free', () => {
    const empty = new ACUWallet('tenant-2');
    assert.throws(() => renderAndCharge(empty, documentWith(), { format: 'DOCX' }, renderers));
  });

  it('prices from configuration rather than from a number in the renderer', () => {
    assert.ok(config.billing.documentRenderRawCostMinor > 0);
  });
});

// ── Whose file this is ──────────────────────────────────────────────────────

/**
 * The page was the customer's and the file was not.
 *
 * Every visible surface was already white-labelled — their mark, their colour,
 * their legal footer, and nothing of this platform's on the page anywhere. The
 * *properties* told a different story: a PDF carried `Producer: CONSTRUX` in
 * its Info dictionary and named the client as its Author rather than the party
 * issuing the document, and a Word file carried no properties at all, so it
 * opened with a blank Author on an instrument the customer stands behind.
 *
 * None of that is on the page and all of it is in Document Properties, which is
 * the first place anybody looks when they want to know where a file came from.
 * A document handed to a regulator whose properties name the tooling rather
 * than the duty holder is answering the wrong question.
 */
describe('the file says whose it is, and never says whose tooling made it', () => {
  const parts = unzip(renderDocx(documentWith()));
  const core = parts.get('docProps/core.xml') ?? '';
  const app = parts.get('docProps/app.xml') ?? '';

  it('carries the property parts a reader looks in', () => {
    // Declared and related, not merely present: a part in the archive that the
    // content types do not name and the package rels do not point at is a part
    // Word ignores, which looks identical to not writing it.
    assert.ok(core.length > 0, 'the package carries no core properties');
    assert.ok(app.length > 0, 'the package carries no extended properties');
    assert.match(parts.get('[Content_Types].xml') ?? '', /PartName="\/docProps\/core\.xml"/);
    assert.match(parts.get('[Content_Types].xml') ?? '', /PartName="\/docProps\/app\.xml"/);
    assert.match(parts.get('_rels/.rels') ?? '', /Target="docProps\/core\.xml"/);
    assert.match(parts.get('_rels/.rels') ?? '', /Target="docProps\/app\.xml"/);
  });

  it('names the issuing entity as the author, not the client it was prepared for', () => {
    // The distinction the branding model already draws: `clientName` is who a
    // document is *for*, `issuingEntity` is who carries the duty under it.
    // Naming the client as author is how a subcontractor comes to believe a
    // method statement was written by somebody else.
    assert.match(core, /<dc:creator>Meridian Infrastructure Group Limited<\/dc:creator>/);
    assert.match(core, /<cp:lastModifiedBy>Meridian Infrastructure Group Limited<\/cp:lastModifiedBy>/);
    assert.match(app, /<Company>Meridian Infrastructure Group Limited<\/Company>/);
    assert.ok(
      !core.includes('<dc:creator>Yorkshire Water'),
      'the client the document was prepared for is named as its author',
    );
  });

  it('falls back to the tenancy name when no issuing entity is separated out', () => {
    // A tenancy that has not distinguished the two still has to have a name on
    // its files. Blank is what an untitled draft looks like.
    const noIssuer = unzip(
      renderDocx(documentWith({ branding: { ...BRANDING, issuingEntity: undefined } })),
    );
    assert.match(noIssuer.get('docProps/core.xml') ?? '', /<dc:creator>Meridian Infrastructure Group<\/dc:creator>/);
  });

  it('carries the reference and the content hash, so a file alone still says what it is', () => {
    // A document separated from its covering email is the normal case by the
    // time anybody argues about it.
    assert.match(core, /<cp:category>CX-QP-0001<\/cp:category>/);
    assert.match(core, /<cp:contentStatus>abc123<\/cp:contentStatus>/);
  });

  it(`stamps this platform name nowhere in the package`, () => {
    // The assertion the whole section exists for, over every part rather than
    // the ones this file happens to have named. A future part carrying the
    // platform's identity would be invisible to a test that only checked the
    // two above.
    for (const [name, content] of parts) {
      assert.ok(
        !/construx/i.test(content),
        `${name} carries this platform's name into a document that is the customer's`,
      );
    }
  });
});
