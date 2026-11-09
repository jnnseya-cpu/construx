/**
 * A persisted shared procurement — the buyer/bidder isolation (C03) bound to the
 * Golden Thread.
 *
 * `isolation.ts` proves the per-party *rule* as a pure filter. This persists the
 * procurement, the buyer's deliberations and evaluations, and the bidders'
 * submissions as chain records, and — crucially — **derives the viewer from the
 * authenticated caller**, not from a value the client supplies. So the filter is
 * enforced at the read: a bidder asking for the procurement gets only their own
 * submission because the server decides they are a bidder from who they are, and
 * `partyView` copies in only what a bidder is entitled to. A client cannot ask to
 * be the buyer.
 *
 * The buyer is whoever opened the procurement. Within one tenancy that is enough
 * to compartmentalise several parties for testing and for a single-tenant
 * marketplace; extending it so a bidder in a *different* tenancy can be granted
 * read access to the same procurement rides on the platform's group/sharing
 * layer, and the filter it is handed is exactly this one.
 */

import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { authorise, currentPhase, write, type EngineContext } from '../../engines/context.ts';
import { partyView, type Evaluation, type PartyView, type Procurement, type Submission } from './isolation.ts';

type ProcurementState = {
  id: string;
  reference: string;
  published: { title: string; scope: string; deadline: string };
  buyerPartyId: string;
  deliberations: string[];
  evaluations: Evaluation[];
  openedAt: string;
  openedBy: string;
};

type SubmissionState = {
  id: string;
  procurementId: string;
  bidderId: string;
  content: string;
  marginMinor?: number;
  at: string;
};

function requireProcurement(ctx: EngineContext, procurementId: string): ProcurementState {
  return ctx.ledger.require({ refType: 'ConsultancyProcurement', refId: procurementId }).state as ProcurementState;
}

function assertBuyer(ctx: EngineContext, proc: ProcurementState): void {
  if (ctx.auth.actorId !== proc.buyerPartyId) {
    throw new DomainError('NOT_BUYER', 'Only the buyer who opened this procurement may do that');
  }
}

/** Open a shared procurement. The opener is its buyer. */
export function openProcurement(
  ctx: EngineContext,
  input: { reference: string; published: { title: string; scope: string; deadline: string } },
): { procurementId: string } {
  authorise(ctx, 'BUSINESS_DEVELOPMENT', 'C', { lifecyclePhase: currentPhase(ctx) });
  const id = ulid();
  const state: ProcurementState = {
    id,
    reference: input.reference,
    published: input.published,
    buyerPartyId: ctx.auth.actorId,
    deliberations: [],
    evaluations: [],
    openedAt: new Date().toISOString(),
    openedBy: ctx.auth.actorId,
  };
  write(ctx, { eventType: 'CONSULTANCY_PROCUREMENT_OPENED', entity: { refType: 'ConsultancyProcurement', refId: id }, nextState: state });
  return { procurementId: id };
}

/** Record a buyer deliberation. Buyer-only; never visible to any bidder. */
export function addDeliberation(ctx: EngineContext, procurementId: string, note: string): void {
  authorise(ctx, 'BUSINESS_DEVELOPMENT', 'U', { lifecyclePhase: currentPhase(ctx) });
  const proc = requireProcurement(ctx, procurementId);
  assertBuyer(ctx, proc);
  write(ctx, {
    eventType: 'CONSULTANCY_PROCUREMENT_UPDATED',
    entity: { refType: 'ConsultancyProcurement', refId: procurementId },
    nextState: { ...proc, deliberations: [...proc.deliberations, note] },
  });
}

/** Record an evaluation of a bidder. Buyer-only; never visible to any bidder. */
export function recordEvaluation(ctx: EngineContext, procurementId: string, input: Evaluation): void {
  authorise(ctx, 'BUSINESS_DEVELOPMENT', 'U', { lifecyclePhase: currentPhase(ctx) });
  const proc = requireProcurement(ctx, procurementId);
  assertBuyer(ctx, proc);
  write(ctx, {
    eventType: 'CONSULTANCY_PROCUREMENT_UPDATED',
    entity: { refType: 'ConsultancyProcurement', refId: procurementId },
    nextState: { ...proc, evaluations: [...proc.evaluations, input] },
  });
}

/** Submit a bid. The submitter is the bidder; the buyer cannot bid on their own procurement. */
export function submitBid(
  ctx: EngineContext,
  procurementId: string,
  input: { content: string; marginMinor?: number },
): { submissionId: string } {
  authorise(ctx, 'BUSINESS_DEVELOPMENT', 'C', { lifecyclePhase: currentPhase(ctx) });
  const proc = requireProcurement(ctx, procurementId);
  if (ctx.auth.actorId === proc.buyerPartyId) {
    throw new DomainError('BUYER_CANNOT_BID', 'The buyer cannot submit a bid on their own procurement');
  }
  const id = ulid();
  const state: SubmissionState = {
    id,
    procurementId,
    bidderId: ctx.auth.actorId,
    content: input.content,
    ...(input.marginMinor !== undefined ? { marginMinor: input.marginMinor } : {}),
    at: new Date().toISOString(),
  };
  write(ctx, { eventType: 'CONSULTANCY_SUBMISSION_RECEIVED', entity: { refType: 'ConsultancySubmission', refId: id }, nextState: state });
  return { submissionId: id };
}

/**
 * The caller's entitled view of the procurement. The viewer's side is **derived
 * from who is asking** — the buyer who opened it, or anyone else as a bidder —
 * and `partyView` returns only what that party is entitled to. A bidder sees only
 * their own submission; buyer deliberations, evaluations and other bidders'
 * submissions never enter the view.
 */
export function viewProcurement(ctx: EngineContext, procurementId: string): PartyView {
  authorise(ctx, 'BUSINESS_DEVELOPMENT', 'R', { lifecyclePhase: currentPhase(ctx) });
  const proc = requireProcurement(ctx, procurementId);
  const submissions: Submission[] = ctx.ledger
    .list(ctx.projectId, 'ConsultancySubmission')
    .map((r) => r.state as SubmissionState)
    .filter((s) => s.procurementId === procurementId)
    .map((s) => ({ bidderId: s.bidderId, content: s.content, ...(s.marginMinor !== undefined ? { marginMinor: s.marginMinor } : {}) }));

  const procurement: Procurement = {
    id: proc.id,
    reference: proc.reference,
    published: proc.published,
    buyerDeliberations: proc.deliberations,
    submissions,
    evaluations: proc.evaluations,
  };
  const viewer =
    ctx.auth.actorId === proc.buyerPartyId
      ? ({ side: 'BUYER', partyId: ctx.auth.actorId } as const)
      : ({ side: 'BIDDER', partyId: ctx.auth.actorId } as const);
  return partyView(procurement, viewer);
}
