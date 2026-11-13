import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isolationLeaks, partyView, type Procurement } from '../src/domain/consultancy/isolation.ts';

/**
 * Buyer/bidder isolation (C03): each party sees only entitled records; evaluations
 * and bidder margins stay compartmentalised. A bidder must not see buyer
 * deliberations or another bidder's data.
 */

const PROC: Procurement = {
  id: 'proc_1',
  reference: 'ITT-001',
  published: { title: 'Doncaster–Scunthorpe feasibility', scope: 'Hourly + Sunday appraisal', deadline: '18 Nov 2026' },
  buyerDeliberations: ['Prefer bidder A on methodology', 'Concern over bidder B capacity'],
  submissions: [
    { bidderId: 'A', content: 'Our approach…', marginMinor: 300_000 },
    { bidderId: 'B', content: 'Our approach…', marginMinor: 150_000 },
  ],
  evaluations: [
    { bidderId: 'A', score: 85 },
    { bidderId: 'B', score: 72 },
  ],
};

describe('the bidder view', () => {
  it('sees the published procurement and only their own submission, with their own margin', () => {
    const view = partyView(PROC, { side: 'BIDDER', partyId: 'A' });
    assert.equal(view.published.title, 'Doncaster–Scunthorpe feasibility');
    assert.equal(view.submissions.length, 1);
    assert.equal(view.submissions[0]!.bidderId, 'A');
    assert.equal(view.submissions[0]!.marginMinor, 300_000, 'a bidder keeps sight of their own margin');
  });

  it('never sees buyer deliberations, evaluations, or another bidder', () => {
    const view = partyView(PROC, { side: 'BIDDER', partyId: 'A' });
    assert.equal(view.deliberations, undefined);
    assert.equal(view.evaluations, undefined);
    assert.ok(!view.submissions.some((s) => s.bidderId === 'B'));
    assert.deepEqual(isolationLeaks(view, { side: 'BIDDER', partyId: 'A' }), [], 'the view leaks nothing');
  });

  it('a bidder with no submission sees the pack but no submissions at all', () => {
    const view = partyView(PROC, { side: 'BIDDER', partyId: 'C' });
    assert.equal(view.submissions.length, 0);
    assert.deepEqual(isolationLeaks(view, { side: 'BIDDER', partyId: 'C' }), []);
  });
});

describe('the buyer view', () => {
  it('sees deliberations, evaluations and every submission — but not any bidder’s internal margin', () => {
    const view = partyView(PROC, { side: 'BUYER', partyId: 'buyer' });
    assert.equal(view.deliberations?.length, 2);
    assert.equal(view.evaluations?.length, 2);
    assert.equal(view.submissions.length, 2, 'the buyer sees both submissions');
    assert.ok(view.submissions.every((s) => s.marginMinor === undefined), 'bidder margins are stripped from the buyer view');
    assert.deepEqual(isolationLeaks(view, { side: 'BUYER', partyId: 'buyer' }), [], 'no margin leaks to the buyer');
  });

  it('keeps each submission’s content so the buyer can evaluate it', () => {
    const view = partyView(PROC, { side: 'BUYER', partyId: 'buyer' });
    assert.ok(view.submissions.every((s) => s.content.length > 0));
  });
});
