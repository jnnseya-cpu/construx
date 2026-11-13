/**
 * The late lifecycle of a consultancy engagement — award, reappraisal, and the
 * controlled release — with the spec's safety rules that make each one
 * trustworthy.
 *
 * - **Award promotion (C05).** When a tender is won, the award links the winning
 *   bid snapshot and the signed terms, and transfers *only* the commitments named
 *   — "Only authorised bid commitments transfer." An award without signed terms
 *   to reconcile against is refused.
 * - **Reappraisal (C08).** A cost, programme or consent event that threatens the
 *   approved decision triggers a reappraisal: the changed inputs are reconciled
 *   against the baseline and a **decision delta** is produced, while the approved
 *   baseline version persists — the old baseline is not overwritten by the event.
 * - **Controlled release (C09/C11/C14).** A release is rechecked immediately
 *   before it happens: current **authority** is re-authorised at release time, so
 *   a permission revoked after the work was queued fails *before* exposure (C14);
 *   the cited **evidence** is rechecked and a release citing a **superseded**
 *   source is blocked rather than issued, so a stale artifact is discarded not
 *   shipped (C09); and the release is **idempotent** on its key, so a duplicate
 *   or a retry after a partial failure yields one visible side effect, not two
 *   (C11).
 */

import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { authorise, currentPhase, write, type EngineContext } from '../../engines/context.ts';
import type { EngagementState } from './store.ts';
import type { EvidenceState } from './evidence.ts';

function engagement(ctx: EngineContext, engagementId: string): EngagementState {
  return ctx.ledger.require({ refType: 'ConsultancyEngagement', refId: engagementId }).state as EngagementState;
}

/**
 * Promote a won tender to an award (C05). Links the winning bid and the signed
 * terms, and transfers only the commitments named. Refused without signed terms
 * to reconcile the award against.
 */
export function promoteAward(
  ctx: EngineContext,
  engagementId: string,
  input: { winningBidRef: string; signedTermsRef: string; transferredCommitments?: string[] },
): { workflowState: EngagementState['workflowState']; award: NonNullable<EngagementState['award']> } {
  authorise(ctx, 'BUSINESS_DEVELOPMENT', 'A', { lifecyclePhase: currentPhase(ctx) });
  const current = engagement(ctx, engagementId);
  if (current.workflowState === 'CANCELLED' || current.workflowState === 'CLOSED') {
    throw new DomainError('ENGAGEMENT_CLOSED', `Engagement ${current.reference} is ${current.workflowState.toLowerCase()}`);
  }
  if (!input.signedTermsRef?.trim()) {
    throw new DomainError('NO_SIGNED_TERMS', 'An award must reconcile against signed terms; none were supplied');
  }
  const award = {
    winningBidRef: input.winningBidRef,
    signedTermsRef: input.signedTermsRef,
    transferredCommitments: input.transferredCommitments ?? [],
    awardedAt: new Date().toISOString(),
    awardedBy: ctx.auth.actorId,
  };
  const next: EngagementState = {
    ...current,
    workflowState: 'ISSUED',
    award,
    actions: [...current.actions, { kind: 'AWARD', note: input.winningBidRef, at: award.awardedAt, by: ctx.auth.actorId }],
  };
  write(ctx, { eventType: 'CONSULTANCY_ENGAGEMENT_UPDATED', entity: { refType: 'ConsultancyEngagement', refId: engagementId }, nextState: next });
  return { workflowState: 'ISSUED', award };
}

/**
 * Trigger a reappraisal (C08). Produces the decision delta between the approved
 * baseline figures and the revised ones, keyed line by line, and keeps the
 * approved baseline version — the triggering event does not overwrite it.
 */
export function triggerReappraisal(
  ctx: EngineContext,
  engagementId: string,
  input: { event: string; baseline: Record<string, number>; revised: Record<string, number> },
): { delta: Record<string, number>; baselineVersion: number } {
  authorise(ctx, 'BUSINESS_DEVELOPMENT', 'U', { lifecyclePhase: currentPhase(ctx) });
  const current = engagement(ctx, engagementId);
  const delta: Record<string, number> = {};
  for (const key of new Set([...Object.keys(input.baseline), ...Object.keys(input.revised)])) {
    delta[key] = (input.revised[key] ?? 0) - (input.baseline[key] ?? 0);
  }
  const reappraisal = {
    event: input.event,
    baseline: input.baseline,
    revised: input.revised,
    delta,
    baselineVersion: current.scopeVersion,
    at: new Date().toISOString(),
    by: ctx.auth.actorId,
  };
  const next: EngagementState = {
    ...current,
    workflowState: 'IN_PROGRESS',
    reappraisal,
    actions: [...current.actions, { kind: 'REAPPRAISE', note: input.event, at: reappraisal.at, by: ctx.auth.actorId }],
  };
  write(ctx, { eventType: 'CONSULTANCY_ENGAGEMENT_UPDATED', entity: { refType: 'ConsultancyEngagement', refId: engagementId }, nextState: next });
  return { delta, baselineVersion: current.scopeVersion };
}

export type ReleaseState = {
  id: string;
  engagementId: string;
  idempotencyKey: string;
  citedEvidenceIds: string[];
  releasedAt: string;
  releasedBy: string;
};

export type ReleaseResult =
  | { released: true; releaseId: string; duplicate: boolean }
  | { released: false; blocked: string[] };

/**
 * Issue a controlled release (C09/C11/C14). Re-authorises at release time,
 * returns the existing release for a repeated idempotency key without a second
 * side effect, and blocks (rather than issues) a release whose cited evidence has
 * been superseded.
 */
export function release(
  ctx: EngineContext,
  engagementId: string,
  input: { idempotencyKey: string; citedEvidenceIds?: string[] },
): ReleaseResult {
  // C14 — authority is rechecked here, so a permission revoked after the work was
  // queued fails before anything is exposed.
  authorise(ctx, 'BUSINESS_DEVELOPMENT', 'A', { lifecyclePhase: currentPhase(ctx) });
  engagement(ctx, engagementId); // existence + tenant check

  if (!input.idempotencyKey?.trim()) {
    throw new DomainError('NO_IDEMPOTENCY_KEY', 'A release needs an idempotency key so a retry cannot issue twice');
  }

  // C11 — idempotent: an existing release for this key is returned, not re-issued.
  const existing = ctx.ledger
    .list(ctx.projectId, 'ConsultancyRelease')
    .map((r) => r.state as ReleaseState)
    .find((r) => r.engagementId === engagementId && r.idempotencyKey === input.idempotencyKey);
  if (existing) return { released: true, releaseId: existing.id, duplicate: true };

  // C09 — recheck the cited evidence; a superseded source blocks the release.
  const blocked: string[] = [];
  for (const evidenceId of input.citedEvidenceIds ?? []) {
    const evidence = ctx.ledger.require({ refType: 'ConsultancyEvidence', refId: evidenceId }).state as EvidenceState;
    if (evidence.status === 'SUPERSEDED') blocked.push(evidenceId);
  }
  if (blocked.length > 0) return { released: false, blocked };

  const releaseId = ulid();
  const state: ReleaseState = {
    id: releaseId,
    engagementId,
    idempotencyKey: input.idempotencyKey,
    citedEvidenceIds: input.citedEvidenceIds ?? [],
    releasedAt: new Date().toISOString(),
    releasedBy: ctx.auth.actorId,
  };
  write(ctx, { eventType: 'CONSULTANCY_RELEASE_ISSUED', entity: { refType: 'ConsultancyRelease', refId: releaseId }, nextState: state });
  return { released: true, releaseId, duplicate: false };
}
