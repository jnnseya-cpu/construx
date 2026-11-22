import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { write, type EngineContext } from '../../engines/context.ts';
import { applicationOf, resolveEvidence, whenGranted, type Application, type EvidenceView, type Matter } from './applications.ts';
import { evaluations, feeQuotes, guard, planningChanged, siteFacts, states, text } from './planning.ts';

/**
 * CONSTRUX Planning: what a decision gives, and what it asks for.
 *
 * A grant records a **consent** with its lineage (an outline and the reserved
 * matters under it; a section 73 permission and the one it varies; a section
 * 96A amendment and the permission it amends), its time limits and its phases.
 * Its **conditions** are recorded as written on the notice, each with an
 * interpretation, a trigger and a phase scope, and the wording is verified by a
 * second person. A **condition request** may cover several conditions; the
 * authority's answer is recorded condition by condition, and nothing is
 * discharged by submission or by silence. **Obligations** — section 106 and
 * the like, and CIL notices — are registered with their instrument, clause,
 * triggers and phases, and move estimated → executed → satisfied on evidence.
 */

const isDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

// =============================================================================
// Consents
// =============================================================================

export type Consent = {
  id: string;
  applicationId: string;
  reference: string;
  type: 'FULL' | 'OUTLINE' | 'RESERVED_MATTERS' | 'S73';
  parentConsentId?: string;
  decidedOn: string;
  viaAppeal: boolean;
  phases: string[];
  matters?: Partial<Record<Matter, 'DETERMINED' | 'RESERVED'>>;
  reservedMatters?: Matter[];
  timeLimits: { commencementBy?: string; reservedMattersBy?: string };
  approvedDrawings: EvidenceView[];
  /** A person's confirmation that every condition on the notice has been entered. */
  conditionsComplete?: { count: number; by: string; at: string };
  amendments: Array<{ applicationId: string; decidedOn: string; summary: string; documents: EvidenceView[] }>;
  status: 'EFFECTIVE' | 'SUPERSEDED' | 'LAPSED';
};

export function consents(ctx: EngineContext): Array<Consent & { version: number }> {
  return ctx.ledger.list(ctx.projectId, 'PlanningConsent').map((record) => ({ ...(record.state as unknown as Consent), version: record.version }));
}

export function consentOf(ctx: EngineContext, id: string): Consent {
  const found = consents(ctx).find((entry) => entry.id === id);
  if (!found) throw new DomainError('CONSENT_NOT_FOUND', 'No such permission on this project.', 404);
  const { version: _version, ...consent } = found;
  return consent;
}

/** The permission a grant creates — or, for section 96A, the amendment it makes to its parent. */
function recordGrant(ctx: EngineContext, application: Application, payload: Record<string, unknown>): void {
  const decidedOn = application.appeal?.outcome === 'ALLOWED' ? application.appeal.decidedOn! : application.decision!.decidedOn;
  const drawings = resolveEvidence(ctx, payload.approvedDrawings, 'payload.approvedDrawings');
  if (application.route === 'section_96a') {
    const parent = consentOf(ctx, application.parentConsentId!);
    const summary = text(payload.amendmentSummary, 'payload.amendmentSummary', 5, 'Say what the non-material amendment changes.');
    const next: Consent = { ...parent, amendments: [...parent.amendments, { applicationId: application.id, decidedOn, summary, documents: drawings }] };
    write(ctx, { eventType: 'PLANNING_CONSENT_AMENDED', entity: { refType: 'PlanningConsent', refId: parent.id }, nextState: next, reason: `${parent.reference} amended under s96A (${application.reference}): ${summary}` });
    return;
  }
  const commencementBy = payload.commencementBy;
  if (application.route !== 'outline' && !isDate(commencementBy)) {
    throw new DomainError('CONSENT_TIME_LIMIT', 'Give the commencement deadline the notice sets.', 422, [{ field: 'payload.commencementBy', message: 'date from the notice' }]);
  }
  if (application.route === 'outline' && !isDate(payload.reservedMattersBy)) {
    throw new DomainError('CONSENT_TIME_LIMIT', 'Give the date by which reserved matters must be applied for, as the notice sets it.', 422, [{ field: 'payload.reservedMattersBy', message: 'date from the notice' }]);
  }
  const type: Consent['type'] = application.route === 'full' ? 'FULL' : application.route === 'outline' ? 'OUTLINE' : application.route === 'reserved_matters' ? 'RESERVED_MATTERS' : 'S73';
  const consent: Consent = {
    id: ulid(),
    applicationId: application.id,
    reference: `PP-${application.reference.slice(3)}`,
    type,
    ...(application.parentConsentId ? { parentConsentId: application.parentConsentId } : {}),
    decidedOn,
    viaAppeal: application.appeal?.outcome === 'ALLOWED',
    phases: application.phases,
    ...(application.matters ? { matters: application.matters } : {}),
    ...(application.reservedMatters ? { reservedMatters: application.reservedMatters } : {}),
    timeLimits: {
      ...(isDate(commencementBy) ? { commencementBy } : {}),
      ...(isDate(payload.reservedMattersBy) ? { reservedMattersBy: payload.reservedMattersBy } : {}),
    },
    approvedDrawings: drawings,
    amendments: [],
    status: 'EFFECTIVE',
  };
  write(ctx, { eventType: 'PLANNING_CONSENT_RECORDED', entity: { refType: 'PlanningConsent', refId: consent.id }, nextState: consent, reason: `${consent.reference} (${type.toLowerCase().replace('_', ' ')}) from ${application.reference}` });

  // Biodiversity gain is a statutory pre-commencement condition, deemed on every
  // permission it applies to. Recorded for the grant where the evaluation says it applies.
  const evaluation = application.proposalId ? evaluations(ctx).filter((entry) => entry.proposalId === application.proposalId).at(-1) : undefined;
  const bng = siteFacts(ctx).BNG_APPLICABILITY?.value === 'APPLIES' || evaluation?.findings.find((finding) => finding.code === 'BNG')?.status === 'applies';
  if (bng && type !== 'RESERVED_MATTERS') {
    const condition: Condition = {
      id: ulid(),
      consentId: consent.id,
      number: 'BNG',
      wording:
        'The development may not be begun unless a biodiversity gain plan has been submitted to the planning authority and the planning authority has approved the plan.',
      interpretation: 'The statutory biodiversity gain condition (Town and Country Planning Act 1990, Schedule 7A), deemed on the permission. An approved Biodiversity Gain Plan is needed before commencement; for phased development, as the permission provides.',
      trigger: 'BEFORE_COMMENCEMENT',
      phases: [],
      statutory: true,
      status: 'OUTSTANDING',
      capturedBy: ctx.auth.actorId,
      capturedAt: new Date().toISOString(),
      verified: { by: 'statute', at: new Date().toISOString() },
      responses: [],
    };
    write(ctx, { eventType: 'PLANNING_CONDITION_RECORDED', entity: { refType: 'PlanningCondition', refId: condition.id }, nextState: condition, reason: `${consent.reference}: statutory biodiversity gain condition` });
  }
}
whenGranted(recordGrant);

/** A person confirms every condition on the notice has been entered. */
export function confirmConditionsComplete(ctx: EngineContext, consentId: string, input: { count: number }): Consent {
  guard(ctx, 'U');
  const consent = consentOf(ctx, consentId);
  const entered = conditions(ctx, consentId).filter((condition) => !condition.statutory).length;
  if (!Number.isInteger(input.count) || input.count !== entered) {
    throw new DomainError('CONDITIONS_COUNT', `The notice's condition count must match what is entered: ${entered} entered.`, 409, [{ field: 'count', message: `${entered} entered` }]);
  }
  const next: Consent = { ...consent, conditionsComplete: { count: entered, by: ctx.auth.actorId, at: new Date().toISOString() } };
  write(ctx, { eventType: 'PLANNING_CONSENT_AMENDED', entity: { refType: 'PlanningConsent', refId: consent.id }, nextState: next, reason: `${consent.reference}: all ${entered} conditions entered` });
  planningChanged(ctx);
  return next;
}

/** Lapse or supersede a permission: it stops being effective, and stays on the record. */
export function setConsentStatus(ctx: EngineContext, consentId: string, input: { status: string; reason: string }): Consent {
  guard(ctx, 'A');
  const consent = consentOf(ctx, consentId);
  if (input.status !== 'SUPERSEDED' && input.status !== 'LAPSED') throw new DomainError('CONSENT_STATUS', 'A permission is marked superseded or lapsed.', 422, [{ field: 'status', message: 'SUPERSEDED or LAPSED' }]);
  const reason = text(input.reason, 'reason', 5, 'Say why — the permission that replaced it, or the deadline that passed.');
  const next: Consent = { ...consent, status: input.status };
  write(ctx, { eventType: 'PLANNING_CONSENT_AMENDED', entity: { refType: 'PlanningConsent', refId: consent.id }, nextState: next, reason: `${consent.reference} ${input.status.toLowerCase()}: ${reason}` });
  planningChanged(ctx);
  return next;
}

/** The permission and every permission it rests on, nearest first. */
export function lineage(ctx: EngineContext, consentId: string): Consent[] {
  const chain: Consent[] = [];
  let current: Consent | undefined = consentOf(ctx, consentId);
  while (current && chain.length < 20) {
    chain.push(current);
    current = current.parentConsentId ? consents(ctx).find((entry) => entry.id === current!.parentConsentId) : undefined;
  }
  return chain;
}

// =============================================================================
// Conditions
// =============================================================================

export const TRIGGERS = ['BEFORE_COMMENCEMENT', 'ABOVE_GROUND', 'BEFORE_OCCUPATION', 'ONGOING', 'BESPOKE'] as const;
export type Trigger = (typeof TRIGGERS)[number];

export type Condition = {
  id: string;
  consentId: string;
  number: string;
  /** Exactly as the notice words it. */
  wording: string;
  interpretation: string;
  trigger: Trigger;
  triggerText?: string;
  /** Empty means every phase of the permission. */
  phases: string[];
  statutory?: boolean;
  status: 'OUTSTANDING' | 'SUBMITTED' | 'DISCHARGED' | 'REFUSED' | 'COMPLYING';
  capturedBy: string;
  capturedAt: string;
  verified?: { by: string; at: string };
  responses: Array<{ requestId: string; outcome: 'APPROVED' | 'REFUSED'; on: string; note: string }>;
};

export function conditions(ctx: EngineContext, consentId?: string): Array<Condition & { version: number }> {
  return ctx.ledger
    .list(ctx.projectId, 'PlanningCondition')
    .map((record) => ({ ...(record.state as unknown as Condition), version: record.version }))
    .filter((entry) => !consentId || entry.consentId === consentId);
}

function conditionOf(ctx: EngineContext, id: string): Condition {
  const found = conditions(ctx).find((entry) => entry.id === id);
  if (!found) throw new DomainError('CONDITION_NOT_FOUND', 'No such condition on this project.', 404);
  const { version: _version, ...condition } = found;
  return condition;
}

export function recordCondition(
  ctx: EngineContext,
  consentId: string,
  input: { number: string; wording: string; interpretation: string; trigger: string; triggerText?: string; phases?: string[] },
): Condition {
  guard(ctx, 'C');
  const consent = consentOf(ctx, consentId);
  const number = text(input.number, 'number', 1, 'Give the condition number as on the notice.');
  if (conditions(ctx, consentId).some((entry) => entry.number === number)) throw new DomainError('CONDITION_EXISTS', `Condition ${number} is already recorded on ${consent.reference}.`, 409);
  const wording = text(input.wording, 'wording', 10, 'Enter the condition exactly as the notice words it.');
  const interpretation = text(input.interpretation, 'interpretation', 5, 'Say what it requires, in plain terms.');
  if (!(TRIGGERS as readonly string[]).includes(input.trigger)) throw new DomainError('CONDITION_TRIGGER', `The trigger is one of ${TRIGGERS.join(', ')}.`, 422, [{ field: 'trigger', message: 'choose one' }]);
  const triggerText = input.trigger === 'BESPOKE' ? text(input.triggerText, 'triggerText', 5, 'A bespoke trigger is quoted from the condition.') : undefined;
  const phases = [...new Set((input.phases ?? []).filter(Boolean))];
  const outside = phases.filter((phase) => !consent.phases.includes(phase));
  if (outside.length > 0) throw new DomainError('CONDITION_PHASE', `${outside.join(', ')} is not a phase of ${consent.reference}.`, 422, [{ field: 'phases', message: 'phases of the permission' }]);
  const condition: Condition = {
    id: ulid(),
    consentId,
    number,
    wording,
    interpretation,
    trigger: input.trigger as Trigger,
    ...(triggerText ? { triggerText } : {}),
    phases,
    status: input.trigger === 'ONGOING' ? 'COMPLYING' : 'OUTSTANDING',
    capturedBy: ctx.auth.actorId,
    capturedAt: new Date().toISOString(),
    responses: [],
  };
  write(ctx, { eventType: 'PLANNING_CONDITION_RECORDED', entity: { refType: 'PlanningCondition', refId: condition.id }, nextState: condition, reason: `${consent.reference} condition ${number}` });
  planningChanged(ctx);
  return condition;
}

/** A second person checks the wording against the notice. */
export function verifyCondition(ctx: EngineContext, conditionId: string): Condition {
  guard(ctx, 'U');
  const condition = conditionOf(ctx, conditionId);
  if (condition.verified) throw new DomainError('CONDITION_VERIFIED', 'That wording is already verified.', 409);
  if (condition.capturedBy === ctx.auth.actorId) throw new DomainError('CONDITION_SAME_PERSON', 'The person who entered the wording does not verify it; a second person checks it against the notice.', 403);
  const next: Condition = { ...condition, verified: { by: ctx.auth.actorId, at: new Date().toISOString() } };
  write(ctx, { eventType: 'PLANNING_CONDITION_VERIFIED', entity: { refType: 'PlanningCondition', refId: conditionId }, nextState: next, reason: `Condition ${condition.number} wording verified against the notice` });
  planningChanged(ctx);
  return next;
}

// =============================================================================
// Condition requests: grouped submission, per-condition answers
// =============================================================================

export type ConditionRequest = {
  id: string;
  reference: string;
  consentId: string;
  conditionIds: string[];
  phase?: string;
  madeOn: string;
  externalRef?: string;
  feeQuoteId?: string;
  evidence: EvidenceView[];
  outcomes: Record<string, { outcome: 'APPROVED' | 'REFUSED'; on: string; note: string; evidence: EvidenceView[] }>;
  status: 'SUBMITTED' | 'PART_DECIDED' | 'DECIDED';
  recordedBy: string;
};

export function conditionRequests(ctx: EngineContext): ConditionRequest[] {
  return states<ConditionRequest>(ctx, 'PlanningConditionRequest');
}

export function recordConditionRequest(
  ctx: EngineContext,
  input: { consentId: string; conditionIds: string[]; phase?: string; madeOn: string; externalRef?: string; feeQuoteId?: string; evidence: unknown },
): ConditionRequest {
  guard(ctx, 'C');
  const consent = consentOf(ctx, input.consentId);
  const ids = [...new Set(input.conditionIds ?? [])];
  if (ids.length === 0) throw new DomainError('REQUEST_CONDITIONS', 'Choose the conditions the request seeks to discharge.', 422, [{ field: 'conditionIds', message: 'at least one' }]);
  const chosen = ids.map((id) => conditionOf(ctx, id));
  const foreign = chosen.filter((condition) => condition.consentId !== consent.id);
  if (foreign.length > 0) throw new DomainError('REQUEST_CONDITION_CONSENT', 'Every condition in a request belongs to the same permission.', 422, [{ field: 'conditionIds', message: 'one permission' }]);
  const closed = chosen.filter((condition) => condition.status === 'DISCHARGED' || condition.status === 'SUBMITTED');
  if (closed.length > 0) throw new DomainError('REQUEST_CONDITION_STATE', `Condition ${closed.map((condition) => condition.number).join(', ')} is already ${closed[0]!.status.toLowerCase()}.`, 409);
  if (!isDate(input.madeOn)) throw new DomainError('REQUEST_DATE', 'The made date is YYYY-MM-DD.', 422, [{ field: 'madeOn', message: 'date' }]);
  if (input.phase && !consent.phases.includes(input.phase)) throw new DomainError('REQUEST_PHASE', `${input.phase} is not a phase of ${consent.reference}.`, 422, [{ field: 'phase', message: 'a phase' }]);
  if (input.feeQuoteId) {
    const quote = feeQuotes(ctx).find((entry) => entry.id === input.feeQuoteId);
    if (!quote || quote.route !== 'condition_details') throw new DomainError('REQUEST_FEE', 'Choose a condition-details fee quote.', 422, [{ field: 'feeQuoteId', message: 'a condition-details quote' }]);
    if (conditionRequests(ctx).some((request) => request.feeQuoteId === quote.id)) throw new DomainError('REQUEST_FEE_USED', 'That fee quote is already a request’s fee; one request, one fee.', 409);
  }
  const evidence = resolveEvidence(ctx, input.evidence);
  if (evidence.length === 0) throw new DomainError('REQUEST_EVIDENCE', 'Attach the details submitted.', 422, [{ field: 'evidence', message: 'the submitted details' }]);
  const request: ConditionRequest = {
    id: ulid(),
    reference: `DOC-${String(conditionRequests(ctx).length + 1).padStart(3, '0')}`,
    consentId: consent.id,
    conditionIds: ids,
    ...(input.phase ? { phase: input.phase } : {}),
    madeOn: input.madeOn,
    ...(input.externalRef?.trim() ? { externalRef: input.externalRef.trim() } : {}),
    ...(input.feeQuoteId ? { feeQuoteId: input.feeQuoteId } : {}),
    evidence,
    outcomes: {},
    status: 'SUBMITTED',
    recordedBy: ctx.auth.actorId,
  };
  write(ctx, { eventType: 'PLANNING_CONDITION_REQUEST_RECORDED', entity: { refType: 'PlanningConditionRequest', refId: request.id }, nextState: request, reason: `${request.reference}: conditions ${chosen.map((condition) => condition.number).join(', ')} on ${consent.reference}` });
  for (const condition of chosen) {
    write(ctx, { eventType: 'PLANNING_CONDITION_RECORDED', entity: { refType: 'PlanningCondition', refId: condition.id }, nextState: { ...condition, status: 'SUBMITTED' }, reason: `Condition ${condition.number} submitted in ${request.reference}` });
  }
  planningChanged(ctx);
  return request;
}

/**
 * The authority's answer, condition by condition, with its evidence. Only an
 * explicit approval discharges a condition.
 */
export function recordConditionResponse(
  ctx: EngineContext,
  requestId: string,
  input: { on: string; outcomes: Array<{ conditionId: string; outcome: string; note: string }>; evidence: unknown },
): ConditionRequest {
  guard(ctx, 'U');
  const request = conditionRequests(ctx).find((entry) => entry.id === requestId);
  if (!request) throw new DomainError('REQUEST_NOT_FOUND', 'No such condition request on this project.', 404);
  if (!isDate(input.on)) throw new DomainError('RESPONSE_DATE', 'The decision date is YYYY-MM-DD.', 422, [{ field: 'on', message: 'date' }]);
  const evidence = resolveEvidence(ctx, input.evidence);
  if (evidence.length === 0) throw new DomainError('RESPONSE_EVIDENCE', 'Attach the authority’s decision.', 422, [{ field: 'evidence', message: 'the decision' }]);
  const outcomes = { ...request.outcomes };
  for (const entry of input.outcomes ?? []) {
    if (!request.conditionIds.includes(entry.conditionId)) throw new DomainError('RESPONSE_CONDITION', 'That condition is not in this request.', 422, [{ field: 'outcomes', message: 'conditions of the request' }]);
    if (outcomes[entry.conditionId]) throw new DomainError('RESPONSE_EXISTS', 'That condition already has the authority’s answer on this request.', 409);
    if (entry.outcome !== 'APPROVED' && entry.outcome !== 'REFUSED') throw new DomainError('RESPONSE_OUTCOME', 'Each outcome is approved or refused.', 422, [{ field: 'outcomes', message: 'APPROVED or REFUSED' }]);
    outcomes[entry.conditionId] = { outcome: entry.outcome, on: input.on, note: text(entry.note, 'outcomes.note', 2, 'Say what the authority said.'), evidence };
  }
  if (Object.keys(outcomes).length === Object.keys(request.outcomes).length) {
    throw new DomainError('RESPONSE_EMPTY', 'Record the answer for at least one condition.', 422, [{ field: 'outcomes', message: 'at least one' }]);
  }
  const decided = request.conditionIds.every((id) => outcomes[id]);
  const next: ConditionRequest = { ...request, outcomes, status: decided ? 'DECIDED' : 'PART_DECIDED' };
  write(ctx, { eventType: 'PLANNING_CONDITION_RESPONSE_RECORDED', entity: { refType: 'PlanningConditionRequest', refId: request.id }, nextState: next, reason: `${request.reference}: authority answered ${Object.keys(outcomes).length} of ${request.conditionIds.length}` });
  for (const entry of input.outcomes) {
    const condition = conditionOf(ctx, entry.conditionId);
    const answer = outcomes[entry.conditionId]!;
    write(ctx, {
      eventType: 'PLANNING_CONDITION_RECORDED',
      entity: { refType: 'PlanningCondition', refId: condition.id },
      nextState: {
        ...condition,
        status: answer.outcome === 'APPROVED' ? (condition.trigger === 'ONGOING' ? 'COMPLYING' : 'DISCHARGED') : 'REFUSED',
        responses: [...condition.responses, { requestId: request.id, outcome: answer.outcome, on: answer.on, note: answer.note }],
      },
      reason: `Condition ${condition.number} ${answer.outcome.toLowerCase()} by the authority (${request.reference})`,
    });
  }
  planningChanged(ctx);
  return next;
}

// =============================================================================
// Obligations
// =============================================================================

export const INSTRUMENTS = ['S106', 'S278', 'UNILATERAL_UNDERTAKING', 'CIL', 'OTHER'] as const;
export const OBLIGATION_TRIGGERS = ['BEFORE_COMMENCEMENT', 'ON_COMMENCEMENT', 'BEFORE_OCCUPATION', 'ON_OCCUPATION', 'OCCUPATION_COUNT', 'DATE', 'ONGOING', 'OTHER'] as const;

export type Obligation = {
  id: string;
  reference: string;
  applicationId?: string;
  instrument: (typeof INSTRUMENTS)[number];
  instrumentRef: string;
  clause: string;
  kind: 'FINANCIAL' | 'DELIVERABLE' | 'NOTICE';
  description: string;
  amountMinor?: number | null;
  indexation?: string;
  cap?: string;
  repayment?: string;
  security?: string;
  phases: string[];
  triggers: Array<{ event: (typeof OBLIGATION_TRIGGERS)[number]; count?: number; on?: string; text?: string }>;
  owner: string;
  monitoring?: { termYears?: number; nextReviewOn?: string };
  status: 'ESTIMATED' | 'EXECUTED' | 'SATISFIED';
  executedOn?: string;
  satisfiedOn?: string;
  acknowledgedOn?: string;
  evidence: EvidenceView[];
  dueSince?: string;
};

export function obligations(ctx: EngineContext): Array<Obligation & { version: number }> {
  return ctx.ledger.list(ctx.projectId, 'PlanningObligation').map((record) => ({ ...(record.state as unknown as Obligation), version: record.version }));
}

function obligationOf(ctx: EngineContext, id: string): Obligation {
  const found = obligations(ctx).find((entry) => entry.id === id);
  if (!found) throw new DomainError('OBLIGATION_NOT_FOUND', 'No such obligation on this project.', 404);
  const { version: _version, ...obligation } = found;
  return obligation;
}

export function recordObligation(
  ctx: EngineContext,
  input: Partial<Omit<Obligation, 'id' | 'reference' | 'status' | 'evidence' | 'dueSince'>> & { evidence?: unknown },
): Obligation {
  guard(ctx, 'C');
  if (!INSTRUMENTS.includes(input.instrument as never)) throw new DomainError('OBLIGATION_INSTRUMENT', `The instrument is one of ${INSTRUMENTS.join(', ')}.`, 422, [{ field: 'instrument', message: 'choose one' }]);
  if (!['FINANCIAL', 'DELIVERABLE', 'NOTICE'].includes(String(input.kind))) throw new DomainError('OBLIGATION_KIND', 'An obligation is financial, a deliverable or a notice.', 422, [{ field: 'kind', message: 'choose one' }]);
  if (input.applicationId) applicationOf(ctx, input.applicationId);
  const triggers = (input.triggers ?? []).map((trigger, index) => {
    if (!OBLIGATION_TRIGGERS.includes(trigger.event as never)) throw new DomainError('OBLIGATION_TRIGGER', `A trigger is one of ${OBLIGATION_TRIGGERS.join(', ')}.`, 422, [{ field: `triggers[${index}].event`, message: 'choose one' }]);
    if (trigger.event === 'DATE' && !isDate(trigger.on)) throw new DomainError('OBLIGATION_TRIGGER_DATE', 'A date trigger has its date.', 422, [{ field: `triggers[${index}].on`, message: 'date' }]);
    if (trigger.event === 'OCCUPATION_COUNT' && (!Number.isInteger(trigger.count) || trigger.count! < 1)) throw new DomainError('OBLIGATION_TRIGGER_COUNT', 'An occupation trigger gives the number of homes.', 422, [{ field: `triggers[${index}].count`, message: 'homes' }]);
    if (trigger.event === 'OTHER') text(trigger.text, `triggers[${index}].text`, 5, 'Quote the trigger as the agreement words it.');
    return trigger;
  });
  if (triggers.length === 0) throw new DomainError('OBLIGATION_TRIGGERS', 'Give the trigger the agreement sets.', 422, [{ field: 'triggers', message: 'at least one' }]);
  if (input.kind === 'FINANCIAL' && input.amountMinor !== null && input.amountMinor !== undefined && (!Number.isInteger(input.amountMinor) || input.amountMinor < 0)) {
    throw new DomainError('OBLIGATION_AMOUNT', 'An amount is whole pence, or left unknown.', 422, [{ field: 'amountMinor', message: 'pence' }]);
  }
  const obligation: Obligation = {
    id: ulid(),
    reference: `OB-${String(obligations(ctx).length + 1).padStart(3, '0')}`,
    ...(input.applicationId ? { applicationId: input.applicationId } : {}),
    instrument: input.instrument as Obligation['instrument'],
    instrumentRef: text(input.instrumentRef, 'instrumentRef', 2, 'Give the agreement or notice reference — heads of terms if it is not yet executed.'),
    clause: text(input.clause, 'clause', 1, 'Give the clause or schedule.'),
    kind: input.kind as Obligation['kind'],
    description: text(input.description, 'description', 5, 'Say what is owed or to be delivered.'),
    ...(input.kind === 'FINANCIAL' ? { amountMinor: input.amountMinor ?? null } : {}),
    ...(input.indexation?.trim() ? { indexation: input.indexation.trim() } : {}),
    ...(input.cap?.trim() ? { cap: input.cap.trim() } : {}),
    ...(input.repayment?.trim() ? { repayment: input.repayment.trim() } : {}),
    ...(input.security?.trim() ? { security: input.security.trim() } : {}),
    phases: [...new Set((input.phases ?? []).filter(Boolean))],
    triggers,
    owner: text(input.owner, 'owner', 2, 'Name who is accountable for it.'),
    ...(input.monitoring ? { monitoring: input.monitoring } : {}),
    status: 'ESTIMATED',
    evidence: resolveEvidence(ctx, input.evidence),
  };
  write(ctx, { eventType: 'PLANNING_OBLIGATION_RECORDED', entity: { refType: 'PlanningObligation', refId: obligation.id }, nextState: obligation, reason: `${obligation.reference}: ${obligation.instrument} ${obligation.clause} — ${obligation.description}` });
  planningChanged(ctx);
  return obligation;
}

/** Executed (signed), acknowledged by the authority, or satisfied — each on evidence. */
export function progressObligation(ctx: EngineContext, id: string, input: { to: string; on: string; evidence: unknown; note?: string }): Obligation {
  guard(ctx, 'U');
  const obligation = obligationOf(ctx, id);
  if (!isDate(input.on)) throw new DomainError('OBLIGATION_DATE', 'The date is YYYY-MM-DD.', 422, [{ field: 'on', message: 'date' }]);
  const evidence = resolveEvidence(ctx, input.evidence);
  if (evidence.length === 0) throw new DomainError('OBLIGATION_EVIDENCE', 'Attach the executed agreement, the payment or the authority’s acknowledgement.', 422, [{ field: 'evidence', message: 'evidence' }]);
  let next: Obligation;
  if (input.to === 'EXECUTED') {
    if (obligation.status !== 'ESTIMATED') throw new DomainError('OBLIGATION_STATE', `${obligation.reference} is already ${obligation.status.toLowerCase()}.`, 409);
    next = { ...obligation, status: 'EXECUTED', executedOn: input.on };
  } else if (input.to === 'SATISFIED') {
    if (obligation.status !== 'EXECUTED') throw new DomainError('OBLIGATION_STATE', `${obligation.reference} is ${obligation.status.toLowerCase()}; an obligation is satisfied once it is executed.`, 409);
    next = { ...obligation, status: 'SATISFIED', satisfiedOn: input.on };
  } else if (input.to === 'ACKNOWLEDGED') {
    next = { ...obligation, acknowledgedOn: input.on };
  } else {
    throw new DomainError('OBLIGATION_TO', 'Move it to executed, acknowledged or satisfied.', 422, [{ field: 'to', message: 'EXECUTED, ACKNOWLEDGED or SATISFIED' }]);
  }
  next = { ...next, evidence: [...obligation.evidence, ...evidence] };
  write(ctx, { eventType: 'PLANNING_OBLIGATION_UPDATED', entity: { refType: 'PlanningObligation', refId: id }, nextState: next, reason: `${obligation.reference} ${input.to.toLowerCase()} on ${input.on}${input.note ? `: ${input.note}` : ''}` });
  planningChanged(ctx);
  return next;
}

/** Marked due when the event that triggers it happens (a release recording commencement or occupation). */
export function markObligationDue(ctx: EngineContext, obligation: Obligation, because: string): void {
  if (obligation.dueSince || obligation.status === 'SATISFIED') return;
  write(ctx, {
    eventType: 'PLANNING_OBLIGATION_DUE',
    entity: { refType: 'PlanningObligation', refId: obligation.id },
    nextState: { ...obligation, dueSince: new Date().toISOString().slice(0, 10) },
    reason: `${obligation.reference} due: ${because}`,
  });
}

