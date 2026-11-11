/**
 * Dispatch reconciliation for outbound intents — the transmission lifecycle a formal
 * notice (and a bid, or a purchase order) has *outside* its own contractual state.
 *
 * `correspondence.ts` records what a notice *is* contractually — ISSUED, answered, deemed
 * accepted. It does not record whether the thing actually reached the recipient, which is a
 * separate question with a dangerous failure mode: an external send that times out might
 * have succeeded or might not, and a blind retry of a notice that did arrive serves it
 * twice — a second clock, a second obligation, a dispute. The spec is explicit (§5 state
 * table; §7 "stable dispatch key … if an external timeout can mean an action succeeded,
 * mark UNKNOWN_OUTCOME and verify … before retry; no blind retries for bids, purchase
 * orders or notices"; AT-17).
 *
 * So this is the transmission state machine, and the safety property is **structural**:
 * `UNKNOWN_OUTCOME` has no edge back to `SENT_UNCONFIRMED`. The only ways out of an unknown
 * outcome are to verify the receipt (it arrived — done), to reject it, to cancel it, or to
 * reconcile it as *not* delivered — and that reconciliation is a human-authored event
 * (`aiAllowed: false`), so an agent cannot clear its own uncertainty and resend. A retry is
 * then a fresh `PENDING → SENT`, never a blind re-send of an intent that may already have
 * landed.
 *
 * The record is idempotent on a stable dispatch key: the same key with the same payload
 * hash returns the same record; the same key with a changed payload is refused, because a
 * changed payload under a used key is exactly how a replay turns into a second, different
 * external effect.
 */

import { DomainError } from '../core/errors.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';

/** The transmission states (spec §5). A verified receipt can arrive straight from PENDING for a synchronous endpoint. */
export type DispatchState = 'PENDING' | 'SENT_UNCONFIRMED' | 'RECEIPT_VERIFIED' | 'UNKNOWN_OUTCOME' | 'REJECTED' | 'CANCELLED';

/** The class of intent, which governs the no-blind-retry rule. Notices, bids and POs are never blindly retried. */
export type DispatchKind = 'NOTICE' | 'BID' | 'PURCHASE_ORDER' | 'OTHER';

const TERMINAL: ReadonlySet<DispatchState> = new Set<DispatchState>(['RECEIPT_VERIFIED', 'REJECTED', 'CANCELLED']);

export type Dispatch = {
  id: string;
  /** The stable idempotency key for this outbound intent. */
  dispatchKey: string;
  kind: DispatchKind;
  /** What is being dispatched — e.g. the Correspondence (notice) record. */
  subject: { refType: string; refId: string };
  recipient: string;
  channel: string;
  /** The hash of the exact payload; a changed payload under the same key is refused. */
  payloadHash: string;
  state: DispatchState;
  attempts: number;
  lastAttemptAt?: string;
  /** The authorised receipt that confirmed delivery, where one has been verified. */
  receiptRef?: string;
  /** Why, for UNKNOWN_OUTCOME / REJECTED / a not-delivered reconciliation. */
  reason?: string;
  openedBy: string;
  openedAt: string;
  updatedAt: string;
};

const dispatchRef = (ctx: EngineContext, dispatchKey: string): string => `${ctx.projectId}:${dispatchKey}`;

function require(ctx: EngineContext, dispatchId: string): Dispatch {
  const rec = ctx.ledger.get({ refType: 'Dispatch', refId: dispatchId });
  if (!rec || rec.tenantId !== ctx.tenantId) throw new DomainError('DISPATCH_NOT_FOUND', `No dispatch ${dispatchId}`, 404);
  return rec.state as Dispatch;
}

/**
 * Validate a transition and build the next state — but do not write it. Each caller writes
 * with its own *literal* event type, so the event catalogue can see every one is emitted
 * (a variable event type would read to the catalogue check as a dead event).
 */
function advance(current: Dispatch, from: readonly DispatchState[], patch: Partial<Dispatch>): Dispatch {
  if (!from.includes(current.state)) {
    throw new DomainError('DISPATCH_BAD_TRANSITION', `A dispatch in ${current.state} cannot move here; this transition is valid only from ${from.join(', ')}.`);
  }
  return { ...current, ...patch, updatedAt: new Date().toISOString() };
}

/**
 * Open (or idempotently re-open) a dispatch for an outbound intent. The same key with the
 * same payload hash returns the existing record; the same key with a different payload hash
 * is refused — a changed payload under a used key is how a replay becomes a second effect.
 */
export function openDispatch(
  ctx: EngineContext,
  input: { dispatchKey: string; kind: DispatchKind; subject: { refType: string; refId: string }; recipient: string; channel: string; payloadHash: string },
): Dispatch {
  authorise(ctx, 'DESIGN_INFORMATION', 'C');
  for (const key of ['dispatchKey', 'recipient', 'channel', 'payloadHash'] as const) {
    if (typeof input[key] !== 'string' || input[key].length === 0) throw new DomainError('DISPATCH_INVALID', `${key} is required`);
  }
  const ref = dispatchRef(ctx, input.dispatchKey);
  const existing = ctx.ledger.get({ refType: 'Dispatch', refId: ref });
  if (existing && existing.tenantId === ctx.tenantId) {
    const prior = existing.state as Dispatch;
    if (prior.payloadHash !== input.payloadHash) {
      throw new DomainError('DISPATCH_PAYLOAD_CHANGED', `Dispatch key ${input.dispatchKey} was opened with a different payload; a changed payload under a used key is refused.`, 409);
    }
    return prior; // idempotent
  }
  const state: Dispatch = {
    id: ref,
    dispatchKey: input.dispatchKey,
    kind: input.kind,
    subject: input.subject,
    recipient: input.recipient,
    channel: input.channel,
    payloadHash: input.payloadHash,
    state: 'PENDING',
    attempts: 0,
    openedBy: ctx.auth.actorId,
    openedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  write(ctx, { eventType: 'DISPATCH_OPENED', entity: { refType: 'Dispatch', refId: ref }, nextState: state });
  return state;
}

/** Record that the intent was sent and is awaiting confirmation. Only from PENDING — never a blind re-send. */
export function markSent(ctx: EngineContext, dispatchId: string): Dispatch {
  authorise(ctx, 'DESIGN_INFORMATION', 'U');
  const current = require(ctx, dispatchId);
  const updated = advance(current, ['PENDING'], { state: 'SENT_UNCONFIRMED', attempts: current.attempts + 1, lastAttemptAt: new Date().toISOString() });
  write(ctx, { eventType: 'DISPATCH_SENT', entity: { refType: 'Dispatch', refId: dispatchRef(ctx, current.dispatchKey) }, nextState: updated });
  return updated;
}

/** An external timeout that could mean success: park it UNKNOWN_OUTCOME and reconcile before any retry (spec §7, AT-17). */
export function markUnknownOutcome(ctx: EngineContext, dispatchId: string, input: { reason: string }): Dispatch {
  authorise(ctx, 'DESIGN_INFORMATION', 'U');
  const current = require(ctx, dispatchId);
  const updated = advance(current, ['SENT_UNCONFIRMED'], { state: 'UNKNOWN_OUTCOME', reason: input.reason });
  write(ctx, { eventType: 'DISPATCH_OUTCOME_UNKNOWN', entity: { refType: 'Dispatch', refId: dispatchRef(ctx, current.dispatchKey) }, nextState: updated });
  return updated;
}

/** A verified receipt — it arrived. Valid from PENDING (synchronous), SENT_UNCONFIRMED, or an UNKNOWN_OUTCOME now reconciled. */
export function verifyReceipt(ctx: EngineContext, dispatchId: string, input: { receiptRef: string }): Dispatch {
  authorise(ctx, 'DESIGN_INFORMATION', 'U');
  if (typeof input.receiptRef !== 'string' || input.receiptRef.length === 0) throw new DomainError('DISPATCH_INVALID', 'A verified receipt needs its reference');
  const current = require(ctx, dispatchId);
  const updated = advance(current, ['PENDING', 'SENT_UNCONFIRMED', 'UNKNOWN_OUTCOME'], { state: 'RECEIPT_VERIFIED', receiptRef: input.receiptRef });
  write(ctx, { eventType: 'DISPATCH_RECEIPT_VERIFIED', entity: { refType: 'Dispatch', refId: dispatchRef(ctx, current.dispatchKey) }, nextState: updated });
  return updated;
}

/** The destination refused it. */
export function markRejected(ctx: EngineContext, dispatchId: string, input: { reason: string }): Dispatch {
  authorise(ctx, 'DESIGN_INFORMATION', 'U');
  const current = require(ctx, dispatchId);
  const updated = advance(current, ['PENDING', 'SENT_UNCONFIRMED', 'UNKNOWN_OUTCOME'], { state: 'REJECTED', reason: input.reason });
  write(ctx, { eventType: 'DISPATCH_REJECTED', entity: { refType: 'Dispatch', refId: dispatchRef(ctx, current.dispatchKey) }, nextState: updated });
  return updated;
}

/** Cancel a dispatch that has not completed. */
export function cancelDispatch(ctx: EngineContext, dispatchId: string, input: { reason: string }): Dispatch {
  authorise(ctx, 'DESIGN_INFORMATION', 'U');
  const current = require(ctx, dispatchId);
  if (TERMINAL.has(current.state)) throw new DomainError('DISPATCH_BAD_TRANSITION', `A dispatch in ${current.state} is already complete and cannot be cancelled.`);
  const updated = advance(current, ['PENDING', 'SENT_UNCONFIRMED', 'UNKNOWN_OUTCOME'], { state: 'CANCELLED', reason: input.reason });
  write(ctx, { eventType: 'DISPATCH_CANCELLED', entity: { refType: 'Dispatch', refId: dispatchRef(ctx, current.dispatchKey) }, nextState: updated });
  return updated;
}

/**
 * Reconcile an UNKNOWN_OUTCOME as *not* delivered, returning the dispatch to PENDING so it
 * may be sent afresh. This is the only edge out of UNKNOWN_OUTCOME back toward a send, and
 * it is a human-authored event (`aiAllowed: false` in the catalogue) — an agent cannot
 * clear its own uncertainty and resend. A retry is therefore always a fresh send of an
 * intent confirmed not to have landed, never a blind re-send (spec §7, AT-17).
 */
export function reconcileNotDelivered(ctx: EngineContext, dispatchId: string, input: { reason: string }): Dispatch {
  authorise(ctx, 'DESIGN_INFORMATION', 'U');
  if (typeof input.reason !== 'string' || input.reason.trim().length < 4) throw new DomainError('DISPATCH_INVALID', 'Say, on the record, how non-delivery was confirmed before a resend.');
  const current = require(ctx, dispatchId);
  const updated = advance(current, ['UNKNOWN_OUTCOME'], { state: 'PENDING', reason: input.reason });
  write(ctx, { eventType: 'DISPATCH_REDISPATCHED', entity: { refType: 'Dispatch', refId: dispatchRef(ctx, current.dispatchKey) }, nextState: updated });
  return updated;
}

/** The dispatches on a project, newest first. */
export function listDispatches(ctx: EngineContext): Dispatch[] {
  authorise(ctx, 'DESIGN_INFORMATION', 'R');
  return ctx.ledger
    .list(ctx.projectId, 'Dispatch')
    .map((r) => r.state as Dispatch)
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt));
}
