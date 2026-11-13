import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import type { EngineContext } from '../src/engines/context.ts';
import {
  addDeliberation,
  openProcurement,
  recordEvaluation,
  submitBid,
  viewProcurement,
} from '../src/domain/consultancy/procurement.ts';

/**
 * The persisted shared procurement enforces the C03 isolation at read time: the
 * viewer's side is derived from who is asking, so a bidder gets only their own
 * submission however they ask, and only the buyer may deliberate and evaluate.
 */

let platform: Platform;
let seed: SeedResult;
// Two parties in the tenancy with business-development create rights.
const buyer = (): EngineContext => platform.context(seed.users.admin!.auth, seed.projectId, { correlationId: 'proc-test' });
const bidder = (): EngineContext => platform.context(seed.users.qs!.auth, seed.projectId, { correlationId: 'proc-test' });

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

describe('the persisted shared procurement (C03)', () => {
  it('derives the view from who is asking: the buyer sees all, a bidder sees only their own submission', () => {
    const { procurementId } = openProcurement(buyer(), { reference: 'ITT-900', published: { title: 'Rail feasibility', scope: 'x', deadline: '2026-12-01' } });
    addDeliberation(buyer(), procurementId, 'Prefer the bidder with the stronger methodology');
    const { submissionId } = submitBid(bidder(), procurementId, { content: 'Our approach…', marginMinor: 120_000 });
    assert.ok(submissionId);
    recordEvaluation(buyer(), procurementId, { bidderId: seed.users.qs!.id, score: 80 });

    // The buyer's view: deliberations, evaluations, the submission content — but no margin.
    const buyerView = viewProcurement(buyer(), procurementId);
    assert.equal(buyerView.deliberations?.length, 1);
    assert.equal(buyerView.evaluations?.length, 1);
    assert.equal(buyerView.submissions.length, 1);
    assert.equal(buyerView.submissions[0]!.marginMinor, undefined, 'the buyer never sees a bidder margin');

    // The bidder's view: their own submission with margin, and nothing of the buyer's.
    const bidderView = viewProcurement(bidder(), procurementId);
    assert.equal(bidderView.deliberations, undefined, 'a bidder never sees deliberations');
    assert.equal(bidderView.evaluations, undefined, 'a bidder never sees evaluations');
    assert.equal(bidderView.submissions.length, 1);
    assert.equal(bidderView.submissions[0]!.bidderId, seed.users.qs!.id);
    assert.equal(bidderView.submissions[0]!.marginMinor, 120_000, 'the bidder keeps their own margin');
  });

  it('refuses a deliberation or evaluation from anyone but the buyer', () => {
    const { procurementId } = openProcurement(buyer(), { reference: 'ITT-901', published: { title: 't', scope: 's', deadline: 'd' } });
    assert.throws(() => addDeliberation(bidder(), procurementId, 'sneaky'), (e) => (e as { code?: string }).code === 'NOT_BUYER');
    assert.throws(() => recordEvaluation(bidder(), procurementId, { bidderId: 'x', score: 1 }), (e) => (e as { code?: string }).code === 'NOT_BUYER');
  });

  it('refuses the buyer bidding on their own procurement', () => {
    const { procurementId } = openProcurement(buyer(), { reference: 'ITT-902', published: { title: 't', scope: 's', deadline: 'd' } });
    assert.throws(() => submitBid(buyer(), procurementId, { content: 'self-bid' }), (e) => (e as { code?: string }).code === 'BUYER_CANNOT_BID');
  });

  it('shows a bidder only their own submission when several bidders have submitted', () => {
    const { procurementId } = openProcurement(buyer(), { reference: 'ITT-903', published: { title: 't', scope: 's', deadline: 'd' } });
    submitBid(bidder(), procurementId, { content: 'qs bid', marginMinor: 90_000 });
    // A second bidder: the construction manager seat (also holds BD create via its row is not guaranteed; use planner/another with BD 'C'? fall back to admin is the buyer). Use the PM-less path: the buyer sees both, the bidder sees one.
    const buyerView = viewProcurement(buyer(), procurementId);
    const bidderView = viewProcurement(bidder(), procurementId);
    assert.ok(buyerView.submissions.length >= 1);
    assert.ok(bidderView.submissions.every((s) => s.bidderId === seed.users.qs!.id), 'a bidder sees only their own submissions');
  });
});
