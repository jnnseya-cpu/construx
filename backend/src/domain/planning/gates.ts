import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { write, type EngineContext } from '../../engines/context.ts';
import {
  applicationOf,
  applications,
  approvePack,
  markReady,
  outstandingMatters,
  packs,
  packStaleness,
  requirements,
  resolveEvidence,
  today,
  type Application,
} from './applications.ts';
import { conditions, consentOf, consents, lineage, markObligationDue, obligations, type Consent } from './consents.ts';
import {
  costLines,
  evaluations,
  evaluationStaleness,
  feeQuotes,
  guard,
  onPlanningChange,
  proposals,
  ruleVersionPositions,
  siteFacts,
  siteVersions,
  states,
  text,
} from './planning.ts';
import { RULE_PACK_VERSION, type Gate } from './rules.ts';

/**
 * CONSTRUX Planning: the gates and the release of works.
 *
 * Each gate's blockers are computed from the records, never stored: a gate is
 * approved by a person holding approval only when, at that moment, nothing
 * blocks it — the server re-evaluates inside the approval itself. An internal
 * risk acceptance can clear a commercial assumption, with its rationale and
 * its approver; it can never stand in for an authority decision, statutory
 * evidence or an unresolved pre-commencement condition.
 *
 * A works release (G4) and an occupation release (G5) are scoped to one phase
 * and one operation. Approvals and releases re-check themselves after every
 * planning write; one that no longer holds is invalidated or revoked on the
 * record, with its reasons, and its history kept.
 */

export type BlockerKind = 'STATUTORY' | 'EVIDENCE' | 'COMMERCIAL' | 'TIME';
export type Blocker = { id: string; reason: string; kind: BlockerKind; ref?: { refType: string; refId: string } };

export type GateReview = {
  id: string;
  gate: Gate;
  applicationId?: string;
  releaseId?: string;
  rationale: string;
  riskAcceptances: Array<{ blockerId: string; reason: string; rationale: string }>;
  status: 'APPROVED' | 'INVALIDATED';
  approvedBy: string;
  approvedAt: string;
  invalidated?: { at: string; reasons: string[] };
};

export const OPERATIONS = ['COMMENCEMENT', 'ABOVE_GROUND', 'OCCUPATION'] as const;
export type Operation = (typeof OPERATIONS)[number];

export type Release = {
  id: string;
  reference: string;
  gate: 'G4' | 'G5';
  phase: string;
  operation: Operation;
  description: string;
  consentId: string;
  programmeTaskId?: string;
  status: 'REQUESTED' | 'APPROVED' | 'REVOKED' | 'WITHDRAWN';
  requestedBy: string;
  requestedAt: string;
  approvedBy?: string;
  approvedAt?: string;
  rationale?: string;
  revoked?: { at: string; reasons: string[] };
};

export const gateReviews = (ctx: EngineContext): GateReview[] => states<GateReview>(ctx, 'PlanningGateReview');
export const releases = (ctx: EngineContext): Release[] => states<Release>(ctx, 'PlanningRelease');

const activeReview = (ctx: EngineContext, gate: Gate, applicationId?: string): GateReview | undefined =>
  gateReviews(ctx).find((review) => review.gate === gate && review.status === 'APPROVED' && (review.applicationId ?? '') === (applicationId ?? ''));

const done = (status: string) => status === 'ACCEPTED' || status === 'NOT_APPLICABLE';

// =============================================================================
// Blockers, gate by gate
// =============================================================================

function g0(ctx: EngineContext): Blocker[] {
  const blockers: Blocker[] = [];
  const site = siteVersions(ctx).at(-1);
  if (!site) blockers.push({ id: 'G0:SITE', reason: 'No red line is recorded.', kind: 'EVIDENCE' });
  const all = proposals(ctx);
  const latest = all.filter((entry) => !all.some((other) => other.scenarioName === entry.scenarioName && other.version > entry.version));
  if (latest.length === 0) blockers.push({ id: 'G0:PROPOSAL', reason: 'No proposal is recorded.', kind: 'EVIDENCE' });
  for (const subject of latest) {
    const evaluation = evaluations(ctx).filter((entry) => entry.proposalId === subject.id).at(-1);
    if (!evaluation) {
      blockers.push({ id: `G0:EVAL:${subject.id}`, reason: `${subject.scenarioName} v${subject.version} has not been evaluated.`, kind: 'EVIDENCE', ref: { refType: 'PlanningProposal', refId: subject.id } });
      continue;
    }
    const stale = evaluationStaleness(ctx, evaluation);
    if (stale.length > 0) blockers.push({ id: `G0:STALE:${subject.id}`, reason: `${subject.scenarioName}: ${stale.join(' ')}`, kind: 'EVIDENCE', ref: { refType: 'PlanningEvaluation', refId: evaluation.id } });
  }
  return blockers;
}

function g1(ctx: EngineContext, application: Application): Blocker[] {
  const blockers: Blocker[] = [];
  if (!activeReview(ctx, 'G0')) blockers.push({ id: 'G1:G0', reason: 'G0 (appraise) is not approved.', kind: 'EVIDENCE' });
  if (application.proposalId) {
    const subject = proposals(ctx).find((entry) => entry.id === application.proposalId)!;
    if (proposals(ctx).some((entry) => entry.scenarioName === subject.scenarioName && entry.version > subject.version)) {
      blockers.push({ id: 'G1:PROPOSAL_VERSION', reason: `${subject.scenarioName} has a newer version than the one this application was promoted from.`, kind: 'EVIDENCE', ref: { refType: 'PlanningProposal', refId: subject.id } });
    }
  }
  for (const requirement of requirements(ctx, application.id).filter((entry) => entry.gate === 'G1' && !done(entry.delivery))) {
    blockers.push({ id: `REQ:${requirement.id}`, reason: `${requirement.title} — ${requirement.delivery.toLowerCase().replace(/_/g, ' ')}.`, kind: 'EVIDENCE', ref: { refType: 'PlanningRequirement', refId: requirement.id } });
  }
  if (!application.targetSubmissionOn) blockers.push({ id: 'G1:PROGRAMME', reason: 'No target submission date is set for the route.', kind: 'EVIDENCE', ref: { refType: 'PlanningApplication', refId: application.id } });
  const lines = costLines(ctx).filter((line) => line.status === 'ACTIVE');
  if (lines.length === 0) blockers.push({ id: 'G1:BUDGET', reason: 'No planning budget is recorded.', kind: 'EVIDENCE' });
  const unquoted = lines.filter((line) => line.kind === 'ALLOWANCE' && line.confidence === 'LOW');
  if (unquoted.length > 0) {
    blockers.push({ id: 'G1:UNQUOTED', reason: `${unquoted.length} allowance(s) are low-confidence assumptions, not quotes: ${unquoted.map((line) => line.label).join(', ')}.`, kind: 'COMMERCIAL' });
  }
  if (application.landOptionExpiresOn && application.targetSubmissionOn) {
    const decisionBy = new Date(Date.parse(`${application.targetSubmissionOn}T00:00:00Z`) + 16 * 7 * 86_400_000).toISOString().slice(0, 10);
    if (application.landOptionExpiresOn < decisionBy) {
      blockers.push({ id: 'G1:LAND_OPTION', reason: `The land option expires ${application.landOptionExpiresOn}, before a decision could be expected (up to ${decisionBy}).`, kind: 'COMMERCIAL' });
    }
  }
  return blockers;
}

function g2(ctx: EngineContext, application: Application): Blocker[] {
  const blockers: Blocker[] = [];
  if (!activeReview(ctx, 'G1', application.id)) blockers.push({ id: 'G2:G1', reason: 'G1 (commit to route) is not approved for this application.', kind: 'EVIDENCE' });
  const pack = packs(ctx, application.id).filter((entry) => entry.status === 'ASSEMBLED').at(-1);
  if (!pack) {
    blockers.push({ id: 'G2:PACK', reason: 'No submission pack is assembled.', kind: 'EVIDENCE' });
  } else {
    for (const [index, reason] of packStaleness(ctx, pack).entries()) {
      blockers.push({ id: `G2:PACK_STALE:${index}`, reason: `The pack no longer matches the project: ${reason}`, kind: 'EVIDENCE', ref: { refType: 'PlanningPack', refId: pack.id } });
    }
    const quote = feeQuotes(ctx).find((entry) => entry.id === pack.feeQuoteId);
    if (!quote || quote.amountMinor === null) {
      blockers.push({ id: 'G2:FEE', reason: `The fee is not determined: ${quote?.reviewReasons.join(' ') ?? 'no quote'}`, kind: 'STATUTORY', ref: { refType: 'PlanningFeeQuote', refId: pack.feeQuoteId } });
    }
    const documents = resolveEvidence(ctx, pack.items.filter((item) => item.kind === 'DOCUMENT').map((item) => ({ refType: item.refType, refId: item.refId })), 'documents', { checkAccess: false });
    for (const document of documents.filter((entry) => entry.quarantined)) {
      blockers.push({ id: `G2:QUARANTINE:${document.refId}`, reason: `${document.label} was flagged by the file scanner.`, kind: 'EVIDENCE', ref: { refType: document.refType, refId: document.refId } });
    }
    if (pack.evaluationId) {
      const pinned = ruleVersionPositions(ctx).find((entry) => entry.version === RULE_PACK_VERSION);
      if (pinned?.status !== 'PUBLISHED') blockers.push({ id: 'G2:RULE_PACK', reason: `The rule pack ${RULE_PACK_VERSION} is not published in this company.`, kind: 'STATUTORY' });
    }
  }
  for (const requirement of requirements(ctx, application.id).filter((entry) => entry.submissionCritical && !done(entry.delivery))) {
    blockers.push({ id: `REQ:${requirement.id}`, reason: `${requirement.title} — needs accepted evidence or a sourced, reviewed non-applicability.`, kind: 'EVIDENCE', ref: { refType: 'PlanningRequirement', refId: requirement.id } });
  }
  if (application.route === 'reserved_matters' && application.parentConsentId) {
    const by = consentOf(ctx, application.parentConsentId).timeLimits.reservedMattersBy;
    if (by && today() > by) blockers.push({ id: 'G2:RM_DEADLINE', reason: `Reserved matters had to be applied for by ${by}.`, kind: 'STATUTORY' });
  }
  return blockers;
}

function supersededDrawings(ctx: EngineContext, consent: Consent): Blocker[] {
  return resolveEvidence(ctx, consent.approvedDrawings.map((entry) => ({ refType: entry.refType, refId: entry.refId })), 'approvedDrawings', { checkAccess: false })
    .filter((entry) => entry.superseded)
    .map((entry) => ({ id: `DRAWING:${entry.refId}`, reason: `Approved drawing ${entry.label} has been superseded in the CDE; the approval needs re-review.`, kind: 'EVIDENCE' as const, ref: { refType: entry.refType, refId: entry.refId } }));
}

function g3(ctx: EngineContext, application: Application): Blocker[] {
  const blockers: Blocker[] = [];
  if (!gateReviews(ctx).some((review) => review.gate === 'G2' && review.applicationId === application.id)) {
    blockers.push({ id: 'G3:G2', reason: 'The submission pack was never approved at G2.', kind: 'EVIDENCE' });
  }
  const decided = application.decision || application.appeal?.outcome;
  if (!decided) {
    blockers.push({
      id: 'G3:DECISION',
      reason: application.committee
        ? `Committee resolved "${application.committee.resolution}" on ${application.committee.on}; the signed decision notice is not recorded.`
        : 'No issued decision is recorded.',
      kind: 'STATUTORY',
    });
    return blockers;
  }
  if (application.appeal && !application.appeal.outcome) blockers.push({ id: 'G3:APPEAL', reason: `Appeal ${application.appeal.reference} is pending.`, kind: 'STATUTORY' });
  const granted = application.appeal?.outcome === 'ALLOWED' || (application.decision?.outcome === 'GRANTED' && !application.appeal);
  if (!granted || application.route === 'section_96a') return blockers;
  const consent = consents(ctx).find((entry) => entry.applicationId === application.id);
  if (!consent) {
    blockers.push({ id: 'G3:CONSENT', reason: 'The permission is not recorded.', kind: 'EVIDENCE' });
    return blockers;
  }
  if (!consent.conditionsComplete) blockers.push({ id: 'G3:CONDITIONS_COMPLETE', reason: `Nobody has confirmed every condition on ${consent.reference}'s notice is entered.`, kind: 'EVIDENCE', ref: { refType: 'PlanningConsent', refId: consent.id } });
  for (const condition of conditions(ctx, consent.id).filter((entry) => !entry.verified)) {
    blockers.push({ id: `COND_VERIFY:${condition.id}`, reason: `Condition ${condition.number}'s wording is not verified against the notice.`, kind: 'EVIDENCE', ref: { refType: 'PlanningCondition', refId: condition.id } });
  }
  if (application.committee?.subjectToS106) {
    const executed = obligations(ctx).some((entry) => entry.applicationId === application.id && entry.instrument === 'S106' && entry.status !== 'ESTIMATED');
    if (!executed) blockers.push({ id: 'G3:S106', reason: 'The resolution was subject to a section 106 agreement, and no executed agreement is recorded.', kind: 'STATUTORY' });
  }
  blockers.push(...supersededDrawings(ctx, consent));
  return blockers;
}

const inScope = (phases: string[], phase: string) => phases.length === 0 || phases.includes(phase);

function releaseBlockers(ctx: EngineContext, release: Pick<Release, 'id' | 'gate' | 'phase' | 'operation' | 'consentId'>): Blocker[] {
  const blockers: Blocker[] = [];
  const consent = consentOf(ctx, release.consentId);
  const chain = lineage(ctx, consent.id);
  if (consent.status !== 'EFFECTIVE') blockers.push({ id: 'REL:CONSENT', reason: `${consent.reference} is ${consent.status.toLowerCase()}.`, kind: 'STATUTORY', ref: { refType: 'PlanningConsent', refId: consent.id } });
  if (!consent.phases.includes(release.phase)) blockers.push({ id: 'REL:PHASE', reason: `${release.phase} is not a phase of ${consent.reference}.`, kind: 'STATUTORY' });
  if (consent.type === 'OUTLINE') {
    blockers.push({ id: 'REL:OUTLINE', reason: 'An outline permission alone does not permit works; release against the reserved matters approval for this phase.', kind: 'STATUTORY' });
  }
  if (!activeReview(ctx, 'G3', consent.applicationId)) blockers.push({ id: 'REL:G3', reason: `G3 (record decision) is not approved for ${consent.reference}.`, kind: 'EVIDENCE' });
  if (consent.type === 'RESERVED_MATTERS' && consent.parentConsentId) {
    const missing = outstandingMatters(ctx, consent.parentConsentId, release.phase);
    if (missing.length > 0) blockers.push({ id: 'REL:RESERVED_MATTERS', reason: `Reserved matters still outstanding for ${release.phase}: ${missing.join(', ')}.`, kind: 'STATUTORY' });
  }
  const live = (gate: string, operation: Operation) =>
    releases(ctx).some((entry) => entry.id !== release.id && entry.gate === gate && entry.phase === release.phase && entry.operation === operation && entry.status === 'APPROVED');
  if (release.gate === 'G4') {
    const deadline = consent.timeLimits.commencementBy ?? chain.find((entry) => entry.timeLimits.commencementBy)?.timeLimits.commencementBy;
    if (!deadline) blockers.push({ id: 'REL:NO_DEADLINE', reason: 'No commencement deadline is recorded for the permission.', kind: 'EVIDENCE' });
    else if (today() > deadline && !releases(ctx).some((entry) => entry.gate === 'G4' && entry.consentId === consent.id && entry.status === 'APPROVED' && entry.id !== release.id)) {
      blockers.push({ id: 'REL:DEADLINE', reason: `The permission had to be begun by ${deadline}.`, kind: 'TIME' });
    }
    if (release.operation === 'ABOVE_GROUND' && !live('G4', 'COMMENCEMENT')) blockers.push({ id: 'REL:NOT_COMMENCED', reason: `No commencement release is live for ${release.phase}.`, kind: 'EVIDENCE' });
  } else if (!live('G4', 'COMMENCEMENT')) {
    blockers.push({ id: 'REL:NOT_COMMENCED', reason: `No commencement release is live for ${release.phase}; occupation follows it.`, kind: 'EVIDENCE' });
  }
  const triggers: string[] =
    release.gate === 'G5' ? ['BEFORE_OCCUPATION'] : release.operation === 'ABOVE_GROUND' ? ['BEFORE_COMMENCEMENT', 'ABOVE_GROUND'] : ['BEFORE_COMMENCEMENT'];
  for (const entry of chain) {
    for (const condition of conditions(ctx, entry.id).filter((candidate) => inScope(candidate.phases, release.phase))) {
      if (!condition.verified) blockers.push({ id: `COND_VERIFY:${condition.id}`, reason: `Condition ${condition.number} (${entry.reference}) wording is not verified.`, kind: 'EVIDENCE', ref: { refType: 'PlanningCondition', refId: condition.id } });
      if (triggers.includes(condition.trigger) && condition.status !== 'DISCHARGED') {
        blockers.push({ id: `COND:${condition.id}`, reason: `Condition ${condition.number} (${entry.reference}) — ${condition.trigger.toLowerCase().replace(/_/g, ' ')} — is ${condition.status.toLowerCase()}.`, kind: 'STATUTORY', ref: { refType: 'PlanningCondition', refId: condition.id } });
      }
      if (condition.trigger === 'BESPOKE' && condition.status === 'OUTSTANDING') {
        blockers.push({ id: `COND_BESPOKE:${condition.id}`, reason: `Condition ${condition.number} has a bespoke trigger ("${condition.triggerText}") — confirm whether it applies to this operation.`, kind: 'EVIDENCE', ref: { refType: 'PlanningCondition', refId: condition.id } });
      }
    }
  }
  const before = release.gate === 'G5' ? 'BEFORE_OCCUPATION' : 'BEFORE_COMMENCEMENT';
  const on = release.gate === 'G5' ? ['ON_OCCUPATION', 'OCCUPATION_COUNT'] : ['ON_COMMENCEMENT'];
  const applicationIds = new Set(chain.map((entry) => entry.applicationId));
  for (const obligation of obligations(ctx).filter((entry) => inScope(entry.phases, release.phase) && (!entry.applicationId || applicationIds.has(entry.applicationId)))) {
    const events = obligation.triggers.map((trigger) => trigger.event);
    if (events.includes(before) && obligation.status !== 'SATISFIED') {
      blockers.push({ id: `OBL:${obligation.id}`, reason: `${obligation.reference} (${obligation.instrument} ${obligation.clause}) must be satisfied ${before.toLowerCase().replace(/_/g, ' ')}; it is ${obligation.status.toLowerCase()}.`, kind: 'STATUTORY', ref: { refType: 'PlanningObligation', refId: obligation.id } });
    }
    if (events.some((event) => on.includes(event)) && obligation.status === 'ESTIMATED') {
      blockers.push({ id: `OBL_EXEC:${obligation.id}`, reason: `${obligation.reference} falls due on ${release.gate === 'G5' ? 'occupation' : 'commencement'} and is not executed.`, kind: 'STATUTORY', ref: { refType: 'PlanningObligation', refId: obligation.id } });
    }
  }
  if (release.gate === 'G4' && release.operation === 'COMMENCEMENT' && siteFacts(ctx).CIL_CHARGING_SCHEDULE?.value === 'IN_FORCE') {
    const notice = obligations(ctx).some((entry) => entry.instrument === 'CIL' && inScope(entry.phases, release.phase) && entry.status === 'SATISFIED');
    if (!notice) blockers.push({ id: 'REL:CIL_NOTICE', reason: `CIL is charged here and no commencement notice is recorded as served for ${release.phase}.`, kind: 'STATUTORY' });
  }
  for (const requirement of requirements(ctx).filter((entry) => applicationIds.has(entry.applicationId) && entry.gate === release.gate && (!entry.phase || entry.phase === release.phase) && !done(entry.delivery))) {
    blockers.push({ id: `REQ:${requirement.id}`, reason: `${requirement.title} — ${requirement.delivery.toLowerCase().replace(/_/g, ' ')}.`, kind: 'EVIDENCE', ref: { refType: 'PlanningRequirement', refId: requirement.id } });
  }
  blockers.push(...supersededDrawings(ctx, consent));
  return blockers;
}

export function gateBlockers(ctx: EngineContext, gate: Gate, scope: { applicationId?: string; releaseId?: string }): Blocker[] {
  if (gate === 'G0') return g0(ctx);
  if (gate === 'G4' || gate === 'G5') {
    const release = releases(ctx).find((entry) => entry.id === scope.releaseId);
    if (!release || release.gate !== gate) throw new DomainError('RELEASE_NOT_FOUND', `No ${gate} release request with that id on this project.`, 404, [{ field: 'releaseId', message: 'choose the release request' }]);
    return releaseBlockers(ctx, release);
  }
  const application = applicationOf(ctx, String(scope.applicationId ?? ''));
  return gate === 'G1' ? g1(ctx, application) : gate === 'G2' ? g2(ctx, application) : g3(ctx, application);
}

export type GatePosition = { gate: Gate; status: 'open' | 'in_review' | 'approved' | 'blocked' | 'superseded'; blockers: Blocker[]; review?: GateReview };

export function gatePosition(ctx: EngineContext, gate: Gate, scope: { applicationId?: string; releaseId?: string }): GatePosition {
  const blockers = gateBlockers(ctx, gate, scope);
  const reviews = gateReviews(ctx).filter((review) => review.gate === gate && (review.applicationId ?? '') === (scope.applicationId ?? '') && (review.releaseId ?? '') === (scope.releaseId ?? ''));
  const review = reviews.at(-1);
  if (review?.status === 'APPROVED') {
    // An approval shows only what still bites: not the risks it accepted, and nothing once the gate is history.
    const live = review.gate === 'G4' || review.gate === 'G5' ? true : stillLive(ctx, review);
    const open = live ? blockers.filter((blocker) => !review.riskAcceptances.some((acceptance) => acceptance.blockerId === blocker.id)) : [];
    return { gate, status: 'approved', blockers: open, review };
  }
  const previous = blockers.filter((blocker) => /^(G\d:G\d|REL:G3|REL:NOT_COMMENCED)$/.test(blocker.id));
  const status = review?.status === 'INVALIDATED' && blockers.length > 0 ? 'superseded' : blockers.length === 0 ? 'in_review' : blockers.length === previous.length ? 'open' : 'blocked';
  return { gate, status, blockers, ...(review ? { review } : {}) };
}

// =============================================================================
// Approving a gate
// =============================================================================

export function approveGate(
  ctx: EngineContext,
  gate: string,
  input: { applicationId?: string; releaseId?: string; rationale: string; riskAcceptances?: Array<{ blockerId: string; rationale: string }> },
): GateReview {
  guard(ctx, 'A');
  if (!['G0', 'G1', 'G2', 'G3', 'G4', 'G5'].includes(gate)) throw new DomainError('GATE_UNKNOWN', 'The gate is G0 to G5.', 404);
  const g = gate as Gate;
  const rationale = text(input.rationale, 'rationale', 5, 'Give the rationale for the approval.');
  if ((g === 'G4' || g === 'G5') && !input.releaseId) throw new DomainError('RELEASE_REQUIRED', 'A works or occupation release is approved against its request.', 422, [{ field: 'releaseId', message: 'choose the request' }]);
  if (g !== 'G0' && g !== 'G4' && g !== 'G5' && !input.applicationId) throw new DomainError('APPLICATION_REQUIRED', `${g} is approved for an application.`, 422, [{ field: 'applicationId', message: 'choose the application' }]);
  const scope: { applicationId?: string; releaseId?: string } =
    g === 'G0' ? {} : g === 'G4' || g === 'G5' ? { releaseId: input.releaseId! } : { applicationId: input.applicationId! };
  const release = scope.releaseId ? releases(ctx).find((entry) => entry.id === scope.releaseId) : undefined;
  if (release && release.status !== 'REQUESTED') throw new DomainError('RELEASE_STATE', `${release.reference} is ${release.status.toLowerCase()}.`, 409);
  if (release && release.requestedBy === ctx.auth.actorId) throw new DomainError('RELEASE_SAME_PERSON', 'The person who requested a release does not approve it.', 403);
  // Re-read inside the approval: two approvals at once accept one.
  if (!release && activeReview(ctx, g, scope.applicationId)) throw new DomainError('GATE_ALREADY_APPROVED', `${g} is already approved here.`, 409);

  const blockers = gateBlockers(ctx, g, scope);
  const acceptances: GateReview['riskAcceptances'] = [];
  for (const acceptance of input.riskAcceptances ?? []) {
    const blocker = blockers.find((entry) => entry.id === acceptance.blockerId);
    if (!blocker) throw new DomainError('RISK_ACCEPTANCE_UNKNOWN', `${acceptance.blockerId} is not blocking this gate.`, 422, [{ field: 'riskAcceptances', message: 'a current blocker' }]);
    if (blocker.kind !== 'COMMERCIAL') {
      throw new DomainError('RISK_ACCEPTANCE_REFUSED', `"${blocker.reason}" is ${blocker.kind.toLowerCase()}: an internal risk acceptance cannot stand in for an authority decision, statutory evidence or a pre-commencement condition.`, 409, [{ field: 'riskAcceptances', message: 'commercial assumptions only' }]);
    }
    acceptances.push({ blockerId: blocker.id, reason: blocker.reason, rationale: text(acceptance.rationale, 'riskAcceptances.rationale', 10, 'A risk acceptance records why the risk is accepted.') });
  }
  const remaining = blockers.filter((blocker) => !acceptances.some((acceptance) => acceptance.blockerId === blocker.id));
  if (remaining.length > 0) {
    throw new DomainError(
      'GATE_BLOCKED',
      `${g} cannot be approved: ${remaining.length} blocker(s). ${remaining.slice(0, 3).map((blocker) => blocker.reason).join(' ')}`,
      409,
      remaining.map((blocker) => ({ field: blocker.id, message: blocker.reason })),
    );
  }
  const review: GateReview = {
    id: ulid(),
    gate: g,
    ...(scope.applicationId ? { applicationId: scope.applicationId } : {}),
    ...(scope.releaseId ? { releaseId: scope.releaseId } : {}),
    rationale,
    riskAcceptances: acceptances,
    status: 'APPROVED',
    approvedBy: ctx.auth.actorId,
    approvedAt: new Date().toISOString(),
  };
  write(ctx, { eventType: 'PLANNING_GATE_APPROVED', entity: { refType: 'PlanningGateReview', refId: review.id }, nextState: review, reason: `${g} approved: ${rationale}${acceptances.length ? ` (${acceptances.length} commercial risk(s) accepted)` : ''}` });

  if (g === 'G2') {
    const application = applicationOf(ctx, scope.applicationId!);
    const pack = packs(ctx, application.id).filter((entry) => entry.status === 'ASSEMBLED').at(-1)!;
    approvePack(ctx, pack);
    markReady(ctx, application, pack.id);
  }
  if (release) {
    const next: Release = { ...release, status: 'APPROVED', approvedBy: ctx.auth.actorId, approvedAt: review.approvedAt, rationale };
    write(ctx, { eventType: 'PLANNING_RELEASE_APPROVED', entity: { refType: 'PlanningRelease', refId: release.id }, nextState: next, reason: `${release.reference}: ${release.phase}, ${release.operation.toLowerCase().replace('_', ' ')} released` });
    const chain = new Set(lineage(ctx, release.consentId).map((entry) => entry.applicationId));
    const due = g === 'G5' ? ['ON_OCCUPATION', 'OCCUPATION_COUNT'] : release.operation === 'COMMENCEMENT' ? ['ON_COMMENCEMENT'] : [];
    for (const obligation of obligations(ctx)) {
      if (!inScope(obligation.phases, release.phase) || (obligation.applicationId && !chain.has(obligation.applicationId))) continue;
      if (obligation.triggers.some((trigger) => due.includes(trigger.event))) {
        const { version: _version, ...plain } = obligation;
        markObligationDue(ctx, plain, `${release.reference} released ${release.operation.toLowerCase().replace('_', ' ')} of ${release.phase}`);
      }
    }
  }
  return review;
}

// =============================================================================
// Releases
// =============================================================================

export function requestRelease(
  ctx: EngineContext,
  input: { gate: string; phase: string; operation: string; description: string; consentId: string; programmeTaskId?: string },
): Release {
  guard(ctx, 'C');
  if (input.gate !== 'G4' && input.gate !== 'G5') throw new DomainError('RELEASE_GATE', 'A release is for works (G4) or occupation (G5).', 422, [{ field: 'gate', message: 'G4 or G5' }]);
  if (!(OPERATIONS as readonly string[]).includes(input.operation)) throw new DomainError('RELEASE_OPERATION', `The operation is one of ${OPERATIONS.join(', ')}.`, 422, [{ field: 'operation', message: 'choose one' }]);
  if ((input.gate === 'G5') !== (input.operation === 'OCCUPATION')) throw new DomainError('RELEASE_OPERATION', 'Occupation is released at G5; commencement and above-ground works at G4.', 422, [{ field: 'operation', message: 'matches the gate' }]);
  const consent = consentOf(ctx, input.consentId);
  if (!consent.phases.includes(input.phase)) throw new DomainError('RELEASE_PHASE', `Choose a phase of ${consent.reference}: ${consent.phases.join(', ')}.`, 422, [{ field: 'phase', message: 'a phase of the permission' }]);
  const description = text(input.description, 'description', 5, 'Say what operation is being released — the works, the plots, the extent.');
  if (input.programmeTaskId) {
    const task = ctx.ledger.get({ refType: 'Task', refId: input.programmeTaskId });
    if (!task || task.tenantId !== ctx.tenantId || task.projectId !== ctx.projectId) throw new DomainError('TASK_NOT_FOUND', 'No such programme task on this project.', 404, [{ field: 'programmeTaskId', message: 'a task on this project' }]);
  }
  const open = releases(ctx).find((entry) => entry.gate === input.gate && entry.phase === input.phase && entry.operation === input.operation && (entry.status === 'REQUESTED' || entry.status === 'APPROVED'));
  if (open) throw new DomainError('RELEASE_EXISTS', `${open.reference} already covers ${input.phase}, ${input.operation.toLowerCase().replace('_', ' ')} (${open.status.toLowerCase()}).`, 409);
  const release: Release = {
    id: ulid(),
    reference: `REL-${String(releases(ctx).length + 1).padStart(3, '0')}`,
    gate: input.gate,
    phase: input.phase,
    operation: input.operation as Operation,
    description,
    consentId: consent.id,
    ...(input.programmeTaskId ? { programmeTaskId: input.programmeTaskId } : {}),
    status: 'REQUESTED',
    requestedBy: ctx.auth.actorId,
    requestedAt: new Date().toISOString(),
  };
  write(ctx, { eventType: 'PLANNING_RELEASE_REQUESTED', entity: { refType: 'PlanningRelease', refId: release.id }, nextState: release, reason: `${release.reference}: ${release.phase}, ${release.operation.toLowerCase().replace('_', ' ')} — ${description}` });
  return release;
}

export function withdrawRelease(ctx: EngineContext, releaseId: string, input: { reason: string }): Release {
  guard(ctx, 'U');
  const release = releases(ctx).find((entry) => entry.id === releaseId);
  if (!release) throw new DomainError('RELEASE_NOT_FOUND', 'No such release on this project.', 404);
  if (release.status !== 'REQUESTED') throw new DomainError('RELEASE_STATE', `${release.reference} is ${release.status.toLowerCase()}.`, 409);
  const reason = text(input.reason, 'reason', 3, 'Say why the request is withdrawn.');
  const next: Release = { ...release, status: 'WITHDRAWN' };
  write(ctx, { eventType: 'PLANNING_RELEASE_REVOKED', entity: { refType: 'PlanningRelease', refId: release.id }, nextState: next, reason: `${release.reference} request withdrawn: ${reason}` });
  return next;
}

// =============================================================================
// Re-checking after every planning write
// =============================================================================

/** When each approval is still worth re-checking: once an application has gone in, its earlier gates are history. */
function stillLive(ctx: EngineContext, review: GateReview): boolean {
  if (review.gate === 'G0') return true;
  const application = applications(ctx).find((entry) => entry.id === review.applicationId);
  if (!application) return false;
  if (review.gate === 'G1') return application.status === 'DRAFT' || application.status === 'INVALID';
  if (review.gate === 'G2') return application.status === 'READY';
  if (review.gate === 'G3') return consents(ctx).some((consent) => consent.applicationId === application.id && consent.status === 'EFFECTIVE');
  return false;
}

export function revalidate(ctx: EngineContext): void {
  for (const review of gateReviews(ctx).filter((entry) => entry.status === 'APPROVED' && entry.gate !== 'G4' && entry.gate !== 'G5')) {
    if (!stillLive(ctx, review)) continue;
    const reasons = gateBlockers(ctx, review.gate, { ...(review.applicationId ? { applicationId: review.applicationId } : {}) })
      .filter((blocker) => !review.riskAcceptances.some((acceptance) => acceptance.blockerId === blocker.id) && blocker.kind !== 'TIME')
      .map((blocker) => blocker.reason);
    if (reasons.length === 0) continue;
    const next: GateReview = { ...review, status: 'INVALIDATED', invalidated: { at: new Date().toISOString(), reasons } };
    write(ctx, { eventType: 'PLANNING_GATE_INVALIDATED', entity: { refType: 'PlanningGateReview', refId: review.id }, nextState: next, reason: `${review.gate} needs re-review: ${reasons.slice(0, 3).join(' ')}` });
    if (review.gate === 'G2') {
      const application = applicationOf(ctx, review.applicationId!);
      write(ctx, { eventType: 'PLANNING_APPLICATION_EVENT_RECORDED', entity: { refType: 'PlanningApplication', refId: application.id }, nextState: { ...application, status: 'DRAFT' }, reason: `${application.reference} back to draft: its pack no longer holds` });
    }
  }
  for (const release of releases(ctx).filter((entry) => entry.status === 'APPROVED')) {
    const reasons = releaseBlockers(ctx, release).filter((blocker) => blocker.kind !== 'TIME').map((blocker) => blocker.reason);
    if (reasons.length === 0) continue;
    const next: Release = { ...release, status: 'REVOKED', revoked: { at: new Date().toISOString(), reasons } };
    write(ctx, { eventType: 'PLANNING_RELEASE_REVOKED', entity: { refType: 'PlanningRelease', refId: release.id }, nextState: next, reason: `${release.reference} revoked — Delivery: stop ${release.operation.toLowerCase().replace('_', ' ')} on ${release.phase}. ${reasons.slice(0, 3).join(' ')}` });
    const review = gateReviews(ctx).find((entry) => entry.releaseId === release.id && entry.status === 'APPROVED');
    if (review) write(ctx, { eventType: 'PLANNING_GATE_INVALIDATED', entity: { refType: 'PlanningGateReview', refId: review.id }, nextState: { ...review, status: 'INVALIDATED', invalidated: { at: next.revoked!.at, reasons } }, reason: `${review.gate} for ${release.reference} invalidated` });
  }
}
onPlanningChange(revalidate);

// =============================================================================
// The register: every gate where it stands
// =============================================================================

export function gateRegister(ctx: EngineContext): {
  project: GatePosition;
  applications: Array<{ applicationId: string; reference: string; gates: GatePosition[] }>;
  releases: Array<Release & { position: GatePosition; task?: { id: string; name: string; percentComplete: number } }>;
} {
  guard(ctx, 'R');
  return {
    project: gatePosition(ctx, 'G0', {}),
    applications: applications(ctx).map((application) => ({
      applicationId: application.id,
      reference: application.reference,
      gates: (['G1', 'G2', 'G3'] as const).map((gate) => gatePosition(ctx, gate, { applicationId: application.id })),
    })),
    releases: releases(ctx).map((release) => {
      const task = release.programmeTaskId ? ctx.ledger.get({ refType: 'Task', refId: release.programmeTaskId }) : undefined;
      return {
        ...release,
        position: gatePosition(ctx, release.gate, { releaseId: release.id }),
        ...(task ? { task: { id: task.refId, name: String(task.state.name ?? ''), percentComplete: Number(task.state.percentComplete ?? 0) } } : {}),
      };
    }),
  };
}
