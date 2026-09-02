import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { renderPdf } from '../src/export/pdf.ts';
import type { ExportDocument } from '../src/export/exporter.ts';
import { issueTokens, verifyToken } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * PDF.
 *
 * The format an adjudicator, an insurer or a court asks for, and the one the
 * platform could not produce. "Print the web page" is not an answer when the
 * document carries a content hash: a browser's print pipeline re-flows the
 * content, so what was hashed and what was printed are not the same artefact.
 *
 * These tests check the two things that decide whether a PDF is usable at all —
 * that a reader can open it, which means the cross-reference offsets are right
 * to the byte, and that the text is actually in it. Typography is not tested
 * because it is not claimed.
 */

const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');

function sampleDocument(over: Partial<ExportDocument> = {}): ExportDocument {
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
      { kind: 'PARAGRAPH', text: 'Ashworth Water Treatment Works — Phase 2' },
      { kind: 'KEY_VALUES', rows: [{ label: 'Lifecycle phase', value: 'OPERATIONS' }] },
    ],
    ...over,
  };
}

describe('a file a reader will open', () => {
  const bytes = renderPdf(sampleDocument());
  const text = latin1(bytes);

  it('starts with the header and ends with the marker', () => {
    assert.ok(text.startsWith('%PDF-1.7'));
    assert.ok(text.trimEnd().endsWith('%%EOF'));
  });

  it('puts every object exactly where the cross-reference table says it is', () => {
    // The only part a reader is strict about. A file whose xref is out by a
    // byte opens as a blank page in some readers and not at all in others,
    // which is not a failure anybody can debug from the symptom.
    const xrefIndex = text.lastIndexOf('startxref');
    const xrefOffset = Number(text.slice(xrefIndex + 'startxref'.length).trim().split('\n')[0]);
    assert.ok(text.slice(xrefOffset).startsWith('xref'), 'startxref points at the table');

    const table = text.slice(xrefOffset).split('\n');
    const [, count] = table[1]!.split(' ');
    const entries = table.slice(2, 2 + Number(count));

    // The first entry is the free head; the rest must each land on "N 0 obj".
    assert.match(entries[0]!, /^0000000000 65535 f/);
    entries.slice(1).forEach((entry, index) => {
      const offset = Number(entry.slice(0, 10));
      assert.match(
        text.slice(offset, offset + 20),
        new RegExp(`^${index + 1} 0 obj`),
        `object ${index + 1} is not at the offset the table gives`,
      );
    });
  });

  it('declares as many objects in the trailer as it wrote', () => {
    const size = Number(/\/Size (\d+)/.exec(text)?.[1]);
    const written = [...text.matchAll(/^\d+ 0 obj$/gm)].length;
    assert.equal(size, written + 1, 'the free object counts towards Size');
  });

  it('carries a catalogue, a page tree and at least one page', () => {
    assert.ok(text.includes('/Type /Catalog'));
    assert.ok(text.includes('/Type /Pages'));
    assert.ok(text.includes('/Type /Page '));
    assert.match(text, /\/MediaBox \[0 0 595\.28 841\.89\]/);
  });

  it('states the length of every content stream correctly', () => {
    // A stream whose declared length disagrees with its bytes is the second
    // most common way to produce a file that will not open.
    for (const match of text.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)) {
      assert.equal(Buffer.byteLength(match[2]!, 'latin1'), Number(match[1]), 'declared stream length matches the bytes');
    }
  });
});

describe('the text is actually in it', () => {
  it('writes the words, not a picture of them', () => {
    const text = latin1(renderPdf(sampleDocument()));
    assert.ok(text.includes('(Project status report) Tj'));
    assert.ok(text.includes('(OPERATIONS) Tj'));
  });

  it('escapes the three characters that would otherwise end the string early', () => {
    const text = latin1(
      renderPdf(sampleDocument({ blocks: [{ kind: 'PARAGRAPH', text: 'Withheld (see clause 3) \\ pending' }] })),
    );
    assert.ok(text.includes('\\(see clause 3\\)'), 'brackets are escaped');
    assert.ok(text.includes('\\\\'), 'and so is the backslash');
  });

  it('keeps an em dash and a pound sign rather than mangling them', () => {
    // Both are all over the domain text. A document going to a court with a
    // question mark where the currency symbol should be is not one anybody
    // would send.
    const text = latin1(renderPdf(sampleDocument({ blocks: [{ kind: 'PARAGRAPH', text: 'Withheld — £412,000 due' }] })));
    assert.ok(text.includes('\\227'), 'em dash as WinAnsi 0x97');
    assert.ok(text.includes('\\243'), 'pound as WinAnsi 0xA3');
    assert.ok(!text.includes('(Withheld ? ?412,000 due)'));
  });

  it('substitutes visibly for a character the encoding cannot carry', () => {
    // A question mark is wrong on the page, which is the point. Dropping it
    // silently would leave a sentence that reads correctly and says something
    // different.
    const text = latin1(renderPdf(sampleDocument({ blocks: [{ kind: 'PARAGRAPH', text: 'Value 中文 here' }] })));
    assert.ok(text.includes('(Value ?? here) Tj'));
  });

  it('declares the fonts with the encoding the bytes are written in', () => {
    const text = latin1(renderPdf(sampleDocument()));
    assert.ok(text.includes('/BaseFont /Helvetica /Encoding /WinAnsiEncoding'));
    assert.ok(text.includes('/BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding'));
    assert.ok(text.includes('/BaseFont /Courier /Encoding /WinAnsiEncoding'));
  });
});

describe('running out of page', () => {
  const longDocument = sampleDocument({
    blocks: [
      { kind: 'HEADING', level: 1, text: 'Audit export' },
      {
        kind: 'TABLE',
        caption: 'Every event',
        headers: ['Time', 'Event', 'Entity', 'Actor'],
        rows: Array.from({ length: 90 }, (_, i) => [
          `2026-08-${String((i % 28) + 1).padStart(2, '0')} 09:00`,
          'PROGRESS_RECORDED',
          `Task ${i}`,
          'Site engineer',
        ]),
      },
    ],
  });

  it('starts a new page rather than writing past the bottom margin', () => {
    const text = latin1(renderPdf(longDocument));
    const pages = [...text.matchAll(/\/Type \/Page /g)].length;
    assert.ok(pages > 1, `90 table rows should not fit on one page, got ${pages}`);
  });

  it('repeats the table header on the new page', () => {
    // A table continuing onto a page with no headings is unreadable, and these
    // documents are read by people who did not build them.
    const text = latin1(renderPdf(longDocument));
    assert.ok([...text.matchAll(/\(Entity\) Tj/g)].length > 1);
  });

  it('numbers every content page against the total, and repeats the reference on all of them', () => {
    const text = latin1(renderPdf(longDocument));
    const pages = [...text.matchAll(/\/Type \/Page /g)].length;

    // The cover is page 1 and carries no running footer: it has the reference,
    // the legal detail and the content hash laid out as part of the cover, and
    // "Page 1 of 5" across a cover competes with that. Content pages run from
    // two, numbered against the true total including the cover — so a page
    // pulled out of the bundle still says how much of the bundle it is.
    assert.ok(!text.includes(`(Page 1 of ${pages}) Tj`), 'the cover carries no running footer');
    for (let page = 2; page <= pages; page++) {
      assert.ok(text.includes(`(Page ${page} of ${pages}) Tj`), `page ${page} is numbered`);
    }

    // A page separated from the bundle should still say what it belongs to —
    // every content page from its footer, and the cover from its own reference
    // line, which is why this still equals the page count.
    assert.equal([...text.matchAll(/\(MIGL-00001\) Tj/g)].length, pages);
  });

  it('carries the content hash on every page', () => {
    const text = latin1(renderPdf(longDocument));
    const pages = [...text.matchAll(/\/Type \/Page /g)].length;
    assert.equal([...text.matchAll(/Content hash sha256:/g)].length, pages);
  });
});

describe('through the platform', () => {
  let platform: Platform;
  let seed: SeedResult;

  before(async () => {
    platform = new Platform();
    seed = await seedDemoProject(platform);
  });

  it('renders the real project report', () => {
    const document = platform.exports.projectReport(seed.users.pm!.auth, seed.projectId, {
      audience: 'ADJUDICATOR',
      format: 'PDF',
      correlationId: 'pdf-test-report',
    });
    const bytes = platform.exports.toPdf(document);

    assert.ok(bytes.byteLength > 2000);
    const text = latin1(bytes);
    assert.ok(text.includes(`(${document.reference}) Tj`));
    assert.ok(text.includes('(Ashworth Water Treatment Works \\227 Phase 2) Tj'), 'the em dash survives');
  });

  it('shows money in the project currency rather than in minor units', () => {
    // This document goes to an adjudicator. "1793000000" reads as a hundred
    // times the truth to anybody who does not know the convention, and there
    // is no reason they should.
    const document = platform.exports.projectReport(seed.users.pm!.auth, seed.projectId, {
      audience: 'ADJUDICATOR',
      correlationId: 'pdf-test-currency',
    });
    const rendered = JSON.stringify(document.blocks);

    assert.ok(rendered.includes('£'), 'the currency symbol is on the document');
    assert.ok(!/"1793000000"/.test(rendered), 'and the raw minor figure is not');
  });

  it('refuses a PDF to a tenant with no export entitlement, like every other export', () => {
    // The gate lives in #finalise, so the PDF path inherits it rather than
    // being a way around it.
    const trial = platform.createTenant({
      legalName: 'Trial Ltd',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'FREE_TRIAL',
      enterpriseName: 'Trial',
    });
    const user = platform.createUser({
      tenantId: trial.tenant.id,
      name: 'Trial PM',
      email: 'pm@trial.example',
      roles: ['PM'],
    });

    const auth = issueTokens({
      actorId: user.id,
      tenantId: trial.tenant.id,
      roles: ['PM'],
      mfaSatisfied: true,
    });

    assert.throws(
      () =>
        platform.exports.projectReport(verifyToken(auth.accessToken), seed.projectId, {
          audience: 'CLIENT',
          format: 'PDF',
          correlationId: 'pdf-test-trial',
        }),
      /does not include exporting/,
    );
  });
});

/**
 * Document Properties is the first place anybody looks to ask where a file came
 * from, and it was answering with this platform's name.
 *
 * The Info dictionary carried `Producer: CONSTRUX` and named the client — who
 * the document was prepared *for* — as its Author. Neither is on the page, and
 * both are one keyboard shortcut away in every reader. On a document that
 * carries the customer's mark, their colour and their registered office, the
 * honest answer there is the customer.
 */
describe('the file says whose it is', () => {
  it('names the issuing entity in every field a reader shows', () => {
    const pdf = latin1(
      renderPdf(
        sampleDocument({
          branding: {
            clientName: 'Yorkshire Water Services Limited',
            issuingEntity: 'Meridian Infrastructure Group Ltd',
            primaryColour: '#e2571e',
            legalFooter: 'Meridian Infrastructure Group Ltd · registered in GB',
            documentReferencePrefix: 'MIGL',
          },
        }),
      ),
    );

    assert.match(pdf, /\/Author \(Meridian Infrastructure Group Ltd\)/);
    assert.match(pdf, /\/Creator \(Meridian Infrastructure Group Ltd\)/);
    assert.match(pdf, /\/Producer \(Meridian Infrastructure Group Ltd\)/);
    // The client is who it is *for*. Naming them as the author is how a
    // subcontractor comes to believe a method statement came from elsewhere.
    assert.ok(!/\/Author \(Yorkshire Water/.test(pdf), 'the client was named as the document author');
  });

  it('falls back to the tenancy name when no issuing entity is separated out', () => {
    const pdf = latin1(renderPdf(sampleDocument()));
    assert.match(pdf, /\/Producer \(Meridian Infrastructure Group Ltd\)/);
  });

  it('stamps this platform name nowhere in the file', () => {
    // Over the whole file rather than the Info dictionary alone: a mark added
    // to a header, an XMP packet or a font name would be invisible to a test
    // that only read the one object.
    const pdf = latin1(renderPdf(sampleDocument()));
    assert.ok(!/construx/i.test(pdf), 'the rendered PDF carries this platform name');
  });
});

/**
 * Zone names on a scale drawing.
 *
 * These exist because the arithmetic was right and the sheet was still wrong.
 * The plan plotted at exactly 1:500 — boundary 120.00mm × 80.00mm for a
 * 60m × 40m site, scale bar 40.00mm for 20m — and every zone's rectangle
 * reproduced the area its schedule row quoted. Then the page was rendered and
 * looked at, and "Walkway" and "Muster point" were printed on top of each
 * other. No assertion about scale could have caught that.
 */
describe('zone names on a plan', () => {
  const drawing = (
    shapes: Array<{ label: string; ring: Array<{ x: number; y: number }>; colour: string }>,
  ): ExportDocument =>
    sampleDocument({
      blocks: [
        {
          kind: 'DRAWING',
          caption: 'Site layout',
          scaleDenominator: 500,
          extent: { minX: 0, minY: 0, maxX: 60, maxY: 40 },
          shapes,
          legend: [],
        },
      ],
    });

  const box = (x: number, y: number, w: number, h: number) => [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];

  /** How many times a piece of text is actually drawn in the content stream. */
  const drawn = (bytes: Uint8Array, value: string): number =>
    latin1(bytes).split(`(${value}) Tj`).length - 1;

  it('draws both names when they are far enough apart to read', () => {
    const bytes = renderPdf(drawing([
      { label: 'Walkway', ring: box(2, 2, 10, 10), colour: '#15803d' },
      { label: 'Muster point', ring: box(40, 30, 8, 8), colour: '#047857' },
    ]));
    assert.equal(drawn(bytes, 'Walkway'), 1);
    assert.equal(drawn(bytes, 'Muster point'), 1);
  });

  it('steps a name clear of its neighbour rather than printing over it', () => {
    // Two zones whose centres are 3m apart vertically. At 1:500 that is 6pt —
    // less than a line — so on the wanted point the labels would collide, and
    // the ladder has to move one of them.
    const bytes = renderPdf(drawing([
      { label: 'Walkway', ring: box(20, 18, 4, 4), colour: '#15803d' },
      { label: 'Muster point', ring: box(20, 21, 4, 4), colour: '#047857' },
    ]));
    assert.equal(drawn(bytes, 'Walkway'), 1, 'a name that fits was dropped');
    assert.equal(drawn(bytes, 'Muster point'), 1, 'a name that fits was dropped');

    // And they are on different lines. Both names are centred on x ≈ the same
    // place, so if the y values matched they would be one on top of the other.
    const text = latin1(bytes);
    const yOf = (label: string): number => {
      const at = text.indexOf(`(${label}) Tj`);
      const tm = text.lastIndexOf('1 0 0 1 ', at);
      return Number(text.slice(tm + 8, text.indexOf(' Tm', tm)).split(' ')[1]);
    };
    assert.ok(Math.abs(yOf('Walkway') - yOf('Muster point')) >= 8, 'two names were placed on the same line');
  });

  it('drops a name it cannot place rather than overprinting one', () => {
    // Five zones stacked on one point. The ladder has five rungs, so the sixth
    // has nowhere to go — and an unreadable name is worse than an absent one,
    // because the schedule names every zone anyway.
    const bytes = renderPdf(drawing(
      ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'].map((label) => ({
        label,
        ring: box(20, 20, 6, 6),
        colour: '#ca8a04',
      })),
    ));
    const placed = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'].filter((l) => drawn(bytes, l) === 1);
    assert.equal(placed.length, 5, `placed ${placed.length}: ${placed.join(', ')}`);
  });

  it('gives the ground to the larger zone, not to the longer name', () => {
    // Six zones on one point again, but now sized. The compound keeps its name
    // and the sliver loses it — which is the way round a reader needs, and the
    // opposite of what ordering by label length would have produced: "Gate 1"
    // is a long name on one of the smallest things on any site.
    // Concentric, so every name wants the same point and the ladder has to
    // choose. Boxes sharing a corner would have different centres, and there
    // would be room for all six.
    const centred = (size: number) => box(30 - size / 2, 20 - size / 2, size, size);
    const bytes = renderPdf(drawing([
      { label: 'Gate 1', ring: centred(1), colour: '#0b6e4f' },
      ...['Two', 'Three', 'Four', 'Five', 'Six'].map((label, i) => ({
        label,
        ring: centred(8 + i),
        colour: '#ca8a04',
      })),
    ]));
    assert.equal(drawn(bytes, 'Six'), 1, 'the largest zone lost its name');
    assert.equal(drawn(bytes, 'Gate 1'), 0, 'the smallest zone kept its name over a larger one');
  });

  it('masks behind a name, so it stays legible where it crosses a line', () => {
    // A hoarding is a strip a metre and a half wide: its own outline runs
    // through the middle of its label. Without a mask the text reads as
    // struck through.
    const text = latin1(renderPdf(drawing([
      { label: 'Perimeter hoarding', ring: box(0, 0, 60, 1.5), colour: '#1f2933' },
    ])));
    const at = text.indexOf('(Perimeter hoarding) Tj');
    const before = text.slice(0, at);
    assert.match(before.slice(-260), /1 1 1 rg\n[-\d\. ]+ re f/, 'no mask was drawn behind the name');
  });

  it('keeps the north arrow off the drawing', () => {
    // It was inside the frame, printed over the corner zone — which on the
    // first real site was the overhead-line exclusion.
    const text = latin1(renderPdf(drawing([
      { label: 'Overhead line', ring: box(50, 20, 8, 20), colour: '#dc2626' },
    ])));
    const at = text.indexOf('(N) Tj');
    const tm = text.lastIndexOf('1 0 0 1 ', at);
    const [x] = text.slice(tm + 8, text.indexOf(' Tm', tm)).split(' ').map(Number);
    // The plot is 60m at 1:500 = 120mm = 340.16pt, centred in a 483.28pt
    // column starting at x=56: it runs to x=467.7. The arrow must be beyond it.
    assert.ok(x! > 467, `the north arrow was drawn at x=${x}, which is on the plan`);
  });
});
