import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import type { EngineContext } from '../src/engines/context.ts';
import {
  cancelDispatch,
  listDispatches,
  markRejected,
  markSent,
  markUnknownOutcome,
  openDispatch,
  reconcileNotDelivered,
  verifyReceipt,
} from '../src/domain/dispatch.ts';

/**
 * Dispatch reconciliation (Tier-1 spec §5/§7, AT-17). The safety property is that an
 * outbound notice whose outcome is unknown is never blindly retried: an UNKNOWN_OUTCOME has
 * no edge back to SENT, only a human-reconciled redispatch once non-delivery is confirmed.
 */

let platform: Platform;
let seed: SeedResult;
// PM holds DESIGN_INFORMATION create/update/read — the area dispatch authorises against.
const ctx = (): EngineContext => platform.context(seed.users.pm!.auth, seed.projectId, { correlationId: 'dispatch-test' });

const open = (dispatchKey = 'ntc-001', payloadHash = 'h1') =>
  openDispatch(ctx(), { dispatchKey, kind: 'NOTICE', subject: { refType: 'Correspondence', refId: 'C-1' }, recipient: 'CONTRACTOR', channel: 'portal', payloadHash });

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

describe('opening a dispatch is idempotent on a stable key', () => {
  it('returns the same record for the same key and payload, and refuses a changed payload (spec §7)', () => {
    const first = open('ntc-idem', 'hash-A');
    assert.equal(first.state, 'PENDING');
    assert.equal(open('ntc-idem', 'hash-A').id, first.id); // idempotent
    assert.throws(() => open('ntc-idem', 'hash-B'), (e) => (e as { code?: string }).code === 'DISPATCH_PAYLOAD_CHANGED');
  });
});

describe('the no-blind-retry rule for a notice (AT-17)', () => {
  it('parks a timed-out send UNKNOWN_OUTCOME and refuses a direct re-send', () => {
    const d = open('ntc-at17', 'h');
    const sent = markSent(ctx(), d.id);
    assert.equal(sent.state, 'SENT_UNCONFIRMED');
    assert.equal(sent.attempts, 1);
    const unknown = markUnknownOutcome(ctx(), d.id, { reason: 'Portal timed out; the submission may or may not have landed' });
    assert.equal(unknown.state, 'UNKNOWN_OUTCOME');
    // A blind retry — straight back to SENT — is not a valid transition. This is the rule.
    assert.throws(() => markSent(ctx(), d.id), (e) => (e as { code?: string }).code === 'DISPATCH_BAD_TRANSITION');
  });

  it('clears an unknown outcome by a VERIFIED receipt — it did arrive', () => {
    const d = open('ntc-arrived', 'h');
    markSent(ctx(), d.id);
    markUnknownOutcome(ctx(), d.id, { reason: 'timeout' });
    const verified = verifyReceipt(ctx(), d.id, { receiptRef: 'portal-receipt-7788' });
    assert.equal(verified.state, 'RECEIPT_VERIFIED');
    assert.equal(verified.receiptRef, 'portal-receipt-7788');
    // Terminal: no further transition.
    assert.throws(() => markSent(ctx(), d.id), (e) => (e as { code?: string }).code === 'DISPATCH_BAD_TRANSITION');
  });

  it('only resends after reconciling non-delivery, which is a fresh send, never a blind one', () => {
    const d = open('ntc-resend', 'h');
    markSent(ctx(), d.id);
    markUnknownOutcome(ctx(), d.id, { reason: 'timeout' });
    assert.throws(() => reconcileNotDelivered(ctx(), d.id, { reason: 'x' }), (e) => (e as { code?: string }).code === 'DISPATCH_INVALID'); // reason must be substantive
    const back = reconcileNotDelivered(ctx(), d.id, { reason: 'Confirmed with the portal that nothing was received' });
    assert.equal(back.state, 'PENDING'); // reconciled → may send afresh
    const resent = markSent(ctx(), d.id);
    assert.equal(resent.state, 'SENT_UNCONFIRMED');
    assert.equal(resent.attempts, 2); // the second genuine send, not a blind retry
  });
});

describe('the rest of the dispatch state machine (spec §5)', () => {
  it('accepts a verified receipt straight from PENDING for a synchronous endpoint', () => {
    const d = open('ntc-sync', 'h');
    const verified = verifyReceipt(ctx(), d.id, { receiptRef: 'sync-ack-1' });
    assert.equal(verified.state, 'RECEIPT_VERIFIED');
  });

  it('rejects, cancels, and refuses to cancel a completed dispatch', () => {
    const r = open('ntc-rej', 'h');
    markSent(ctx(), r.id);
    assert.equal(markRejected(ctx(), r.id, { reason: 'Portal refused the format' }).state, 'REJECTED');

    const c = open('ntc-cancel', 'h');
    assert.equal(cancelDispatch(ctx(), c.id, { reason: 'Superseded before sending' }).state, 'CANCELLED');

    const done = open('ntc-done', 'h');
    verifyReceipt(ctx(), done.id, { receiptRef: 'ack' });
    assert.throws(() => cancelDispatch(ctx(), done.id, { reason: 'too late' }), (e) => (e as { code?: string }).code === 'DISPATCH_BAD_TRANSITION');
  });

  it('lists the project’s dispatches and refuses an unknown one', () => {
    assert.ok(listDispatches(ctx()).some((d) => d.dispatchKey === 'ntc-sync'));
    assert.throws(() => markSent(ctx(), 'nope'), (e) => (e as { code?: string }).code === 'DISPATCH_NOT_FOUND');
  });
});
