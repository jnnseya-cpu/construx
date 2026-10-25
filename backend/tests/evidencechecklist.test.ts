import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EVIDENCE_CHECKLIST,
  checklistCoverage,
  checklistTypesAreReal,
} from '../src/domain/bidon/evidencechecklist.ts';
import { EVIDENCE_TYPE, type EvidenceSummary } from '../src/domain/bidon/evidence.ts';

/**
 * The standing checklist: what a bidder is told to file, before a question is read.
 *
 * The module exists so the library is built against a known list from the start,
 * instead of its gaps being discovered one low-scoring answer at a time. These
 * tests hold the two promises that makes: every item files under a real type, and
 * coverage is an honest, current-only measurement that never over-claims.
 */

/**
 * A library summary carrying only the fields the checklist reads.
 *
 * The checklist reads four fields — reference, title, type, currentNow, and
 * withdrawnAt — so the fixture states those and casts, rather than building a
 * whole `BidOnEvidence`. If the checklist ever reads more, these tests fail to
 * compile, which is the signal to widen the fixture.
 */
function doc(over: Partial<EvidenceSummary>): EvidenceSummary {
  return {
    reference: 'EVD-0001',
    title: 'A document',
    type: 'OTHER',
    currentNow: true,
    withdrawnAt: undefined,
    ...over,
  } as EvidenceSummary;
}

describe('the evidence checklist', () => {
  it('files every item under a real evidence type', () => {
    assert.ok(checklistTypesAreReal(), 'a checklist item names a type the store does not have');
    for (const item of EVIDENCE_CHECKLIST) {
      assert.ok((EVIDENCE_TYPE as readonly string[]).includes(item.type), `${item.key} → ${item.type}`);
      assert.ok(item.why.length > 20, `${item.key} does not say what it is for`);
      assert.ok(item.match.length > 0, `${item.key} has nothing to match a title against`);
    }
  });

  it('reports an empty library as every essential missing, not as ready', () => {
    const c = checklistCoverage([]);
    assert.equal(c.covered, 0);
    assert.ok(c.essentialsTotal > 0);
    assert.equal(c.essentialsCovered, 0);
    assert.match(c.summary, /essential document\(s\) are not on file/);
    assert.ok(c.items.every((item) => item.status === 'MISSING'));
  });

  it('counts a current matching document as cover, and names it', () => {
    const c = checklistCoverage([
      doc({ reference: 'EVD-0007', title: 'Professional Indemnity insurance schedule 2026', type: 'INSURANCE', currentNow: true }),
    ]);
    const pi = c.items.find((item) => item.key === 'professional-indemnity')!;
    assert.equal(pi.status, 'CURRENT');
    assert.deepEqual(pi.coveredBy, { reference: 'EVD-0007', title: 'Professional Indemnity insurance schedule 2026' });
    assert.equal(c.essentialsCovered, 1);
  });

  it('does not let one insurance satisfy the other two', () => {
    // The whole reason the match fragments are specific. Holding PL must not
    // mark PI and EL as covered.
    const c = checklistCoverage([
      doc({ reference: 'EVD-0002', title: 'Public Liability certificate', type: 'INSURANCE', currentNow: true }),
    ]);
    assert.equal(c.items.find((i) => i.key === 'public-liability')!.status, 'CURRENT');
    assert.equal(c.items.find((i) => i.key === 'professional-indemnity')!.status, 'MISSING');
    assert.equal(c.items.find((i) => i.key === 'employers-liability')!.status, 'MISSING');
  });

  it('marks a lapsed match as LAPSED, not covered and not simply missing', () => {
    // A lapsed certificate is worse than a missing one — citing it is a hard red
    // — so it must be surfaced as a renewal, not hidden.
    const c = checklistCoverage([
      doc({ reference: 'EVD-0003', title: 'Health and Safety policy', type: 'POLICY', currentNow: false }),
    ]);
    const hs = c.items.find((item) => item.key === 'health-safety-policy')!;
    assert.equal(hs.status, 'LAPSED');
    assert.equal(hs.coveredBy?.reference, 'EVD-0003');
    assert.equal(c.essentialsCovered, 0, 'a lapsed essential does not count as covered');
  });

  it('ignores a withdrawn document entirely', () => {
    const c = checklistCoverage([
      doc({ reference: 'EVD-0004', title: 'Health and Safety policy', type: 'POLICY', currentNow: true, withdrawnAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    assert.equal(c.items.find((item) => item.key === 'health-safety-policy')!.status, 'MISSING');
  });

  it('says the library is ready once every essential is current', () => {
    const essentials = EVIDENCE_CHECKLIST.filter((item) => item.importance === 'ESSENTIAL');
    const docs = essentials.map((item, at) =>
      doc({ reference: `EVD-${at}`, title: item.match[0]!, type: item.type, currentNow: true }),
    );
    const c = checklistCoverage(docs);
    assert.equal(c.essentialsCovered, c.essentialsTotal);
    assert.match(c.summary, /ready for the questions a tender will ask/);
  });
});
