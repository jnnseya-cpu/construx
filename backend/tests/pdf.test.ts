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
