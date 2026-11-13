/**
 * Evidence and lineage — the provenance a consultancy finding rests on.
 *
 * The spec (§5) is strict about where facts come from: ingested sources carry
 * their original file and revision, authority, time period, access/licence and
 * locator; a drawing quantity cites sheet, revision, scale and method; an IFC
 * value cites element GUID and model revision. And the completion measure (§8)
 * is categorical: "Every released material finding traces to a cited source,
 * governed assumption or reproducible calculation." This module makes both true
 * by construction — a **claim** cannot be recorded without citing something, and
 * it cannot cite a source that has been **superseded**, which is the spec's
 * prohibition on "silent reuse of superseded facts."
 *
 * Both entities are Golden Thread records written through the one `write` path,
 * so tenant isolation and the hash chain apply; the lineage is therefore not a
 * convenience view but the record itself.
 */

import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { authorise, currentPhase, write, type EngineContext } from '../../engines/context.ts';

export type EvidenceStatus = 'CURRENT' | 'SUPERSEDED';
/** How much weight the source can bear — low/unverified evidence is flagged, not hidden. */
export type ConfidenceBasis = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNVERIFIED';

export type EvidenceState = {
  id: string;
  engagementId: string;
  /** The source: a document name, dataset, drawing, model or interview record. */
  source: string;
  /** The revision/version of the source, so a later revision does not silently replace it. */
  revision?: string;
  /** Where in the source the fact is: page, sheet + scale + method, IFC element GUID, cell. */
  locator?: string;
  /** Who issued or owns the source. */
  authority?: string;
  /** The currency / time period the source speaks to. */
  period?: string;
  /** Access / licence terms governing reuse. */
  licence?: string;
  /** The extraction method (read, OCR, measured, modelled) — low-quality OCR goes to verification. */
  method?: string;
  confidence: ConfidenceBasis;
  classification?: string;
  status: EvidenceStatus;
  registeredAt: string;
  registeredBy: string;
};

export type ClaimKind = 'FINDING' | 'CONDITIONAL_FINDING' | 'ASSUMPTION' | 'RECOMMENDATION';

export type ClaimState = {
  id: string;
  engagementId: string;
  kind: ClaimKind;
  statement: string;
  /** Evidence ids backing the claim. */
  sourceRefs: string[];
  /** Reproducible calculation ids backing the claim. */
  calculationRefs: string[];
  /** Governed assumption ids backing the claim. */
  assumptionRefs: string[];
  recordedAt: string;
  recordedBy: string;
};

function requireEngagement(ctx: EngineContext, engagementId: string): void {
  ctx.ledger.require({ refType: 'ConsultancyEngagement', refId: engagementId }); // existence + tenant check
}

function evidenceOf(ctx: EngineContext, engagementId: string): EvidenceState[] {
  return ctx.ledger
    .list(ctx.projectId, 'ConsultancyEvidence')
    .map((r) => r.state as EvidenceState)
    .filter((e) => e.engagementId === engagementId);
}

/** Register a source against the engagement, with its locator, authority and confidence. */
export function registerEvidence(
  ctx: EngineContext,
  engagementId: string,
  input: {
    source: string;
    revision?: string;
    locator?: string;
    authority?: string;
    period?: string;
    licence?: string;
    method?: string;
    confidence?: ConfidenceBasis;
    classification?: string;
  },
): { evidenceId: string } {
  authorise(ctx, 'EVIDENCE_AUDIT', 'I', { lifecyclePhase: currentPhase(ctx) });
  requireEngagement(ctx, engagementId);
  const evidenceId = ulid();
  const state: EvidenceState = {
    id: evidenceId,
    engagementId,
    source: input.source,
    revision: input.revision,
    locator: input.locator,
    authority: input.authority,
    period: input.period,
    licence: input.licence,
    method: input.method,
    confidence: input.confidence ?? 'UNVERIFIED',
    classification: input.classification,
    status: 'CURRENT',
    registeredAt: new Date().toISOString(),
    registeredBy: ctx.auth.actorId,
  };
  write(ctx, {
    eventType: 'CONSULTANCY_EVIDENCE_REGISTERED',
    entity: { refType: 'ConsultancyEvidence', refId: evidenceId },
    nextState: state,
  });
  return { evidenceId };
}

/** Mark a source superseded. A superseded source can no longer back a new claim. */
export function supersedeEvidence(ctx: EngineContext, evidenceId: string): void {
  authorise(ctx, 'EVIDENCE_AUDIT', 'I', { lifecyclePhase: currentPhase(ctx) });
  const record = ctx.ledger.require({ refType: 'ConsultancyEvidence', refId: evidenceId });
  const current = record.state as EvidenceState;
  write(ctx, {
    eventType: 'CONSULTANCY_EVIDENCE_UPDATED',
    entity: { refType: 'ConsultancyEvidence', refId: evidenceId },
    nextState: { ...current, status: 'SUPERSEDED' },
  });
}

/** The evidence register for an engagement. */
export function evidenceRegister(ctx: EngineContext, engagementId: string): EvidenceState[] {
  authorise(ctx, 'EVIDENCE_AUDIT', 'R', { lifecyclePhase: currentPhase(ctx) });
  requireEngagement(ctx, engagementId);
  return evidenceOf(ctx, engagementId);
}

/**
 * Record a claim with its lineage. Refused unless it cites at least one source,
 * assumption or calculation (no unsupported finding), and refused if any cited
 * source has been superseded (no silent reuse of a stale fact) or does not
 * belong to this engagement.
 */
export function recordClaim(
  ctx: EngineContext,
  engagementId: string,
  input: {
    kind?: ClaimKind;
    statement: string;
    sourceRefs?: string[];
    calculationRefs?: string[];
    assumptionRefs?: string[];
  },
): { claimId: string } {
  authorise(ctx, 'EVIDENCE_AUDIT', 'I', { lifecyclePhase: currentPhase(ctx) });
  requireEngagement(ctx, engagementId);

  const sourceRefs = input.sourceRefs ?? [];
  const calculationRefs = input.calculationRefs ?? [];
  const assumptionRefs = input.assumptionRefs ?? [];

  if (sourceRefs.length + calculationRefs.length + assumptionRefs.length === 0) {
    throw new DomainError(
      'UNSUPPORTED_CLAIM',
      'A claim must cite at least one source, assumption or calculation. A finding that traces to nothing cannot be recorded.',
    );
  }

  const register = evidenceOf(ctx, engagementId);
  const byId = new Map(register.map((e) => [e.id, e]));
  for (const ref of sourceRefs) {
    const evidence = byId.get(ref);
    if (!evidence) {
      throw new DomainError('UNKNOWN_EVIDENCE', `Cited source ${ref} is not registered on this engagement`);
    }
    if (evidence.status === 'SUPERSEDED') {
      throw new DomainError('SUPERSEDED_SOURCE', `Cited source ${ref} (${evidence.source}) has been superseded and cannot back a claim`);
    }
  }

  const claimId = ulid();
  const state: ClaimState = {
    id: claimId,
    engagementId,
    kind: input.kind ?? 'FINDING',
    statement: input.statement,
    sourceRefs,
    calculationRefs,
    assumptionRefs,
    recordedAt: new Date().toISOString(),
    recordedBy: ctx.auth.actorId,
  };
  write(ctx, {
    eventType: 'CONSULTANCY_CLAIM_RECORDED',
    entity: { refType: 'ConsultancyClaim', refId: claimId },
    nextState: state,
  });
  return { claimId };
}

export type ClaimLineage = {
  claim: ClaimState;
  evidence: EvidenceState[];
  /** Cited sources that have since been superseded — the claim needs re-checking. */
  supersededSince: string[];
  calculationRefs: string[];
  assumptionRefs: string[];
};

/**
 * The lineage of a claim: the cited evidence resolved, plus any cited source that
 * has been superseded since the claim was made — so a released finding whose
 * ground has moved is visible rather than silently stale.
 */
export function claimLineage(ctx: EngineContext, claimId: string): ClaimLineage {
  authorise(ctx, 'EVIDENCE_AUDIT', 'R', { lifecyclePhase: currentPhase(ctx) });
  const record = ctx.ledger.require({ refType: 'ConsultancyClaim', refId: claimId });
  const claim = record.state as ClaimState;
  const evidence: EvidenceState[] = [];
  const supersededSince: string[] = [];
  for (const ref of claim.sourceRefs) {
    const er = ctx.ledger.require({ refType: 'ConsultancyEvidence', refId: ref });
    const state = er.state as EvidenceState;
    evidence.push(state);
    if (state.status === 'SUPERSEDED') supersededSince.push(ref);
  }
  return { claim, evidence, supersededSince, calculationRefs: claim.calculationRefs, assumptionRefs: claim.assumptionRefs };
}
