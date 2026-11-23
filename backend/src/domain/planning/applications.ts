import { hashEvidence } from '../../core/canonical.ts';
import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { authorise, write, type EngineContext } from '../../engines/context.ts';
import type { Gate } from './rules.ts';
import {
  evaluations,
  evaluationStaleness,
  feeQuotes,
  guard,
  planningChanged,
  proposals,
  ruleVersionPositions,
  states,
  text,
  type EvaluationRecord,
} from './planning.ts';

/**
 * CONSTRUX Planning: applications, their events, requirements and packs.
 *
 * The application status, its gate status, each requirement's status and the
 * consent's effectiveness are separate fields kept separately. An application
 * moves draft → ready → submitted → valid → determined, with invalid,
 * corrected and withdrawn paths; everything else — consultation, amended
 * plans, an extension, a committee resolution, a forecast — is a dated event
 * that changes no status. A decision needs the issued notice, never a draft.
 */

// =============================================================================
// Evidence: a document revision on this project, and nowhere else
// =============================================================================

export type EvidenceRef = { refType: 'InformationContainer' | 'IngestedFile'; refId: string };
export type EvidenceView = EvidenceRef & { label: string; hash: string; quarantined: boolean; superseded: boolean };

/**
 * Resolve evidence references, refusing anything not on this project. A
 * reference to another tenant's or project's record is answered exactly as one
 * that does not exist — a scoped 404 — so the refusal discloses nothing.
 */
const READ_RULE = {
  InformationContainer: () => ['DESIGN_INFORMATION', {}] as const,
  IngestedFile: () => ['EVIDENCE_AUDIT', { dataSensitivity: 'LEGAL_L4' as const }] as const,
};

/** Whether the reader may open documents of this kind at all. */
export function mayReadEvidence(ctx: EngineContext, refType: EvidenceRef['refType']): boolean {
  const [area, attributes] = READ_RULE[refType]();
  try {
    authorise(ctx, area, 'R', attributes);
    return true;
  } catch {
    return false;
  }
}

export function resolveEvidence(ctx: EngineContext, refs: unknown, field = 'evidence', options: { checkAccess?: boolean } = {}): EvidenceView[] {
  const checkAccess = options.checkAccess ?? true;
  const list = Array.isArray(refs) ? refs : [];
  return list.map((entry, index) => {
    const ref = entry as Partial<EvidenceRef>;
    if (ref?.refType !== 'InformationContainer' && ref?.refType !== 'IngestedFile') {
      throw new DomainError('EVIDENCE_TYPE', 'Evidence is a CDE document revision or a filed document on this project.', 422, [{ field: `${field}[${index}]`, message: 'CDE revision or filed document' }]);
    }
    const record = ctx.ledger.get({ refType: ref.refType, refId: String(ref.refId ?? '') });
    // A document the reader may not open is answered as one that is not there.
    if (!record || record.tenantId !== ctx.tenantId || record.projectId !== ctx.projectId || (checkAccess && !mayReadEvidence(ctx, ref.refType))) {
      throw new DomainError('EVIDENCE_NOT_FOUND', 'No such document on this project.', 404, [{ field: `${field}[${index}]`, message: 'not on this project' }]);
    }
    const state = record.state;
    if (ref.refType === 'InformationContainer') {
      const hash = String(state.fileHash ?? '');
      const scanned = ctx.ledger
        .list(ctx.projectId, 'IngestedFile')
        .find((file) => String(file.state.hash) === hash);
      return {
        refType: ref.refType,
        refId: ref.refId!,
        label: `${String(state.reference)} rev ${String(state.revision)} — ${String(state.title)}`,
        hash,
        quarantined: scanned?.state.status === 'QUARANTINED',
        superseded: Boolean(state.supersededBy) || state.state === 'ARCHIVED',
      };
    }
    return {
      refType: ref.refType,
      refId: ref.refId!,
      label: String(state.filename ?? state.ingestionId),
      hash: String(state.hash ?? ''),
      quarantined: state.status === 'QUARANTINED',
      superseded: false,
    };
  });
}

/** The documents on this project a person can cite as evidence, for the forms. */
export function evidenceCatalogue(ctx: EngineContext): EvidenceView[] {
  const containers = (mayReadEvidence(ctx, 'InformationContainer') ? ctx.ledger : { list: () => [] as ReturnType<typeof ctx.ledger.list> })
    .list(ctx.projectId, 'InformationContainer')
    .filter((record) => !record.state.supersededBy && record.state.state !== 'ARCHIVED')
    .map((record) => ({ refType: 'InformationContainer' as const, refId: record.refId }));
  const files = (mayReadEvidence(ctx, 'IngestedFile') ? ctx.ledger.list(ctx.projectId, 'IngestedFile') : []).map((record) => ({ refType: 'IngestedFile' as const, refId: record.refId }));
  return resolveEvidence(ctx, [...containers, ...files]);
}

// =============================================================================
// Applications
// =============================================================================

export const APPLICATION_ROUTES = ['full', 'outline', 'reserved_matters', 'section_73', 'section_96a'] as const;
export type ApplicationRoute = (typeof APPLICATION_ROUTES)[number];
export const MATTERS = ['access', 'appearance', 'landscaping', 'layout', 'scale'] as const;
export type Matter = (typeof MATTERS)[number];
export type ApplicationStatus = 'DRAFT' | 'READY' | 'SUBMITTED' | 'INVALID' | 'VALID' | 'DETERMINED' | 'WITHDRAWN';

export type ApplicationEvent = {
  id: string;
  type: string;
  occurredOn: string;
  evidence: EvidenceView[];
  payload: Record<string, unknown>;
  recordedBy: string;
  recordedAt: string;
};

export type Application = {
  id: string;
  reference: string;
  route: ApplicationRoute;
  proposalId?: string;
  parentConsentId?: string;
  phases: string[];
  /** Outline: each matter determined now or reserved. Reserved matters: the matters this application seeks to approve. */
  matters?: Partial<Record<Matter, 'DETERMINED' | 'RESERVED'>>;
  reservedMatters?: Matter[];
  status: ApplicationStatus;
  targetSubmissionOn?: string;
  externalRef?: string;
  madeOn?: string;
  validatedOn?: string;
  /** The statutory period, from the validated date the authority records. Kept apart from every other date. */
  clock?: { weeks: number; statutoryTargetOn: string; basis: string };
  authorityTargetOn?: string;
  extension?: { agreedTo: string; eventId: string };
  forecastDecisionOn?: string;
  landOptionExpiresOn?: string;
  decision?: { outcome: 'GRANTED' | 'REFUSED'; decidedOn: string; issuedBy: string; eventId: string };
  committee?: { resolution: string; on: string; subjectToS106: boolean };
  appeal?: { lodgedOn: string; reference: string; ground: 'REFUSAL' | 'NON_DETERMINATION'; outcome?: 'ALLOWED' | 'DISMISSED'; decidedOn?: string; inspectorRef?: string };
  events: ApplicationEvent[];
  draftedBy: string;
  draftedAt: string;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (value: unknown): value is string => typeof value === 'string' && DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
export const today = (): string => new Date().toISOString().slice(0, 10);

export function applications(ctx: EngineContext): Application[] {
  return states<Application>(ctx, 'PlanningApplication');
}

export function applicationOf(ctx: EngineContext, id: string): Application {
  const found = applications(ctx).find((entry) => entry.id === id);
  if (!found) throw new DomainError('APPLICATION_NOT_FOUND', 'No such application on this project.', 404);
  return found;
}


/** Consents are recorded in `consents.ts`; read here only to check a parent. */
type ConsentLike = { id: string; type: string; status: string; matters?: Partial<Record<Matter, string>>; timeLimits: { commencementBy?: string; reservedMattersBy?: string }; phases: string[] };
const consentsOf = (ctx: EngineContext): ConsentLike[] => states<ConsentLike>(ctx, 'PlanningConsent');

export function draftApplication(
  ctx: EngineContext,
  input: {
    route: string;
    proposalId?: string;
    parentConsentId?: string;
    phases?: string[];
    matters?: Partial<Record<string, string>>;
    reservedMatters?: string[];
    targetSubmissionOn?: string;
    landOptionExpiresOn?: string;
  },
): Application {
  guard(ctx, 'C');
  if (!(APPLICATION_ROUTES as readonly string[]).includes(input.route)) {
    throw new DomainError('APPLICATION_ROUTE', `The route is one of ${APPLICATION_ROUTES.join(', ')}.`, 422, [{ field: 'route', message: 'choose one' }]);
  }
  const route = input.route as ApplicationRoute;
  const linked = route === 'reserved_matters' || route === 'section_73' || route === 'section_96a';
  let proposalId: string | undefined;
  if (input.proposalId) {
    const subject = proposals(ctx).find((entry) => entry.id === input.proposalId);
    if (!subject) throw new DomainError('PROPOSAL_NOT_FOUND', 'No such proposal on this project.', 404);
    if (!linked && subject.route !== route) {
      throw new DomainError('APPLICATION_ROUTE_MISMATCH', `That proposal is a ${subject.route} scenario; promote it as one.`, 422, [{ field: 'route', message: 'match the proposal' }]);
    }
    proposalId = subject.id;
  } else if (!linked) {
    throw new DomainError('APPLICATION_PROPOSAL_REQUIRED', 'A full or outline application is promoted from a proposal.', 422, [{ field: 'proposalId', message: 'choose the proposal' }]);
  }
  let parent: ConsentLike | undefined;
  if (linked) {
    parent = consentsOf(ctx).find((entry) => entry.id === input.parentConsentId);
    if (!parent) throw new DomainError('PARENT_CONSENT_REQUIRED', 'A reserved matters, section 73 or section 96A application is linked to the permission it depends on.', 422, [{ field: 'parentConsentId', message: 'choose the permission' }]);
    if (parent.status !== 'EFFECTIVE') throw new DomainError('PARENT_CONSENT_NOT_EFFECTIVE', 'That permission is not effective.', 409);
  }
  let matters: Application['matters'];
  let reservedMatters: Matter[] | undefined;
  if (route === 'outline') {
    matters = {};
    for (const matter of MATTERS) {
      const value = input.matters?.[matter];
      if (value !== 'DETERMINED' && value !== 'RESERVED') {
        throw new DomainError('OUTLINE_MATTERS', `Say whether ${matter} is determined now or reserved.`, 422, [{ field: `matters.${matter}`, message: 'determined or reserved' }]);
      }
      matters[matter] = value;
    }
  }
  if (route === 'reserved_matters') {
    if (parent!.type !== 'OUTLINE') throw new DomainError('PARENT_NOT_OUTLINE', 'Reserved matters are approved under an outline permission.', 422, [{ field: 'parentConsentId', message: 'an outline permission' }]);
    const outstanding = outstandingMatters(ctx, parent!.id);
    reservedMatters = (input.reservedMatters ?? []).filter((matter): matter is Matter => (MATTERS as readonly string[]).includes(matter));
    if (reservedMatters.length === 0) throw new DomainError('RESERVED_MATTERS_REQUIRED', 'Choose the reserved matters this application seeks to approve.', 422, [{ field: 'reservedMatters', message: 'at least one' }]);
    const extra = reservedMatters.filter((matter) => !outstanding.includes(matter));
    if (extra.length > 0) throw new DomainError('RESERVED_MATTERS_NOT_OUTSTANDING', `${extra.join(', ')} is not reserved and outstanding under that permission.`, 422, [{ field: 'reservedMatters', message: 'outstanding matters only' }]);
  }
  for (const [field, value] of [['targetSubmissionOn', input.targetSubmissionOn], ['landOptionExpiresOn', input.landOptionExpiresOn]] as const) {
    if (value !== undefined && value !== '' && !isDate(value)) throw new DomainError('APPLICATION_DATE', 'A date is YYYY-MM-DD.', 422, [{ field, message: 'date' }]);
  }
  const phases = [...new Set((input.phases ?? []).map((phase) => String(phase).trim()).filter(Boolean))];
  if (phases.length === 0) phases.push('Whole site');
  if (parent && !phases.every((phase) => parent!.phases.includes(phase))) {
    throw new DomainError('APPLICATION_PHASE', `Choose phases of the parent permission: ${parent.phases.join(', ')}.`, 422, [{ field: 'phases', message: 'phases of the permission' }]);
  }
  const next: Application = {
    id: ulid(),
    reference: `PA-${String(applications(ctx).length + 1).padStart(3, '0')}`,
    route,
    ...(proposalId ? { proposalId } : {}),
    ...(parent ? { parentConsentId: parent.id } : {}),
    phases,
    ...(matters ? { matters } : {}),
    ...(reservedMatters ? { reservedMatters } : {}),
    status: 'DRAFT',
    ...(input.targetSubmissionOn ? { targetSubmissionOn: input.targetSubmissionOn } : {}),
    ...(input.landOptionExpiresOn ? { landOptionExpiresOn: input.landOptionExpiresOn } : {}),
    events: [],
    draftedBy: ctx.auth.actorId,
    draftedAt: new Date().toISOString(),
  };
  write(ctx, { eventType: 'PLANNING_APPLICATION_DRAFTED', entity: { refType: 'PlanningApplication', refId: next.id }, nextState: next, reason: `${next.reference} drafted (${route.replace(/_/g, ' ')})` });
  generateRequirements(ctx, next.id);
  planningChanged(ctx);
  return applicationOf(ctx, next.id);
}

/** Matters reserved under an outline permission and not yet approved by a granted reserved-matters application, per the whole permission. */
export function outstandingMatters(ctx: EngineContext, outlineConsentId: string, phase?: string): Matter[] {
  const outline = consentsOf(ctx).find((entry) => entry.id === outlineConsentId);
  if (!outline || outline.type !== 'OUTLINE') return [];
  const reserved = MATTERS.filter((matter) => outline.matters?.[matter] === 'RESERVED');
  const approved = new Set(
    states<ConsentLike & { parentConsentId?: string; reservedMatters?: Matter[] }>(ctx, 'PlanningConsent')
      .filter((consent) => consent.type === 'RESERVED_MATTERS' && consent.parentConsentId === outlineConsentId && consent.status === 'EFFECTIVE')
      .filter((consent) => !phase || consent.phases.includes(phase))
      .flatMap((consent) => consent.reservedMatters ?? []),
  );
  return reserved.filter((matter) => !approved.has(matter));
}

/** The planning clock: the statutory weeks from the latest evaluation of the application's proposal. */
function statutoryWeeks(ctx: EngineContext, application: Application): number | undefined {
  if (!application.proposalId) return undefined;
  const evaluation = evaluations(ctx).filter((entry) => entry.proposalId === application.proposalId).at(-1);
  const period = evaluation?.findings.find((finding) => finding.code === 'DETERMINATION_PERIOD');
  const match = period?.status === 'applies' ? /^(\d+) weeks/.exec(period.reason) : null;
  return match ? Number(match[1]) : undefined;
}

export const APPLICATION_EVENTS = [
  'submitted',
  'invalid',
  'resubmitted',
  'validated',
  'invalidated',
  'withdrawn',
  'consultation',
  'amended_plans',
  'extension',
  'committee_resolution',
  'forecast',
  'determined',
  'appeal_lodged',
  'appeal_decided',
] as const;
export type ApplicationEventType = (typeof APPLICATION_EVENTS)[number];

/** Which status each event may be recorded from, and what it moves the application to. */
const TRANSITIONS: Record<ApplicationEventType, { from: ApplicationStatus[]; to?: ApplicationStatus }> = {
  submitted: { from: ['READY'], to: 'SUBMITTED' },
  invalid: { from: ['SUBMITTED'], to: 'INVALID' },
  resubmitted: { from: ['INVALID'], to: 'SUBMITTED' },
  validated: { from: ['SUBMITTED'], to: 'VALID' },
  invalidated: { from: ['VALID'], to: 'INVALID' },
  withdrawn: { from: ['SUBMITTED', 'VALID'], to: 'WITHDRAWN' },
  consultation: { from: ['VALID'] },
  amended_plans: { from: ['VALID'] },
  extension: { from: ['VALID'] },
  committee_resolution: { from: ['VALID'] },
  forecast: { from: ['SUBMITTED', 'VALID'] },
  determined: { from: ['VALID'], to: 'DETERMINED' },
  appeal_lodged: { from: ['DETERMINED', 'VALID'] },
  appeal_decided: { from: ['DETERMINED', 'VALID'], to: 'DETERMINED' },
};

/** Called by `consents.ts` to record the permission a grant creates. Registered to avoid a cycle. */
let onGranted: ((ctx: EngineContext, application: Application, payload: Record<string, unknown>) => void) | undefined;
export function whenGranted(listener: typeof onGranted): void {
  onGranted = listener;
}

export function recordApplicationEvent(
  ctx: EngineContext,
  applicationId: string,
  input: { type: string; occurredOn: string; evidence?: unknown; payload?: Record<string, unknown> },
): Application {
  guard(ctx, 'U');
  const application = applicationOf(ctx, applicationId);
  if (!(APPLICATION_EVENTS as readonly string[]).includes(input.type)) {
    throw new DomainError('APPLICATION_EVENT_TYPE', `The event is one of ${APPLICATION_EVENTS.join(', ')}.`, 422, [{ field: 'type', message: 'choose one' }]);
  }
  const type = input.type as ApplicationEventType;
  if (!isDate(input.occurredOn)) throw new DomainError('APPLICATION_EVENT_DATE', 'The date it happened is YYYY-MM-DD.', 422, [{ field: 'occurredOn', message: 'date' }]);
  if (input.occurredOn > today()) throw new DomainError('APPLICATION_EVENT_FUTURE', 'An event is recorded once it has happened; a forecast is its own event.', 422, [{ field: 'occurredOn', message: 'not in the future' }]);
  const transition = TRANSITIONS[type];
  if (!transition.from.includes(application.status)) {
    throw new DomainError('APPLICATION_STATE', `${application.reference} is ${application.status.toLowerCase()}; "${type.replace(/_/g, ' ')}" is recorded from ${transition.from.map((status) => status.toLowerCase()).join(' or ')}.`, 409);
  }
  const evidence = resolveEvidence(ctx, input.evidence);
  const payload = input.payload ?? {};
  const needEvidence = (why: string) => {
    if (evidence.length === 0) throw new DomainError('APPLICATION_EVIDENCE_REQUIRED', why, 422, [{ field: 'evidence', message: 'attach the document' }]);
  };
  const event: ApplicationEvent = { id: ulid(), type, occurredOn: input.occurredOn, evidence, payload, recordedBy: ctx.auth.actorId, recordedAt: new Date().toISOString() };
  let next: Application = { ...application, events: [...application.events, event], ...(transition.to ? { status: transition.to } : {}) };
  let decisionRecorded = false;

  switch (type) {
    case 'submitted':
    case 'resubmitted': {
      needEvidence('Attach the submission receipt or portal confirmation.');
      const ref = text(payload.externalRef ?? application.externalRef, 'payload.externalRef', 2, 'Give the portal or authority reference.');
      next = { ...next, externalRef: ref, ...(type === 'submitted' ? { madeOn: input.occurredOn } : {}) };
      break;
    }
    case 'invalid':
    case 'invalidated': {
      text(payload.reasons, 'payload.reasons', 5, 'Say what the authority found invalid.');
      if (type === 'invalidated') needEvidence('An authority correction of a validated application is recorded with its evidence.');
      const { clock: _clock, validatedOn: _validated, ...rest } = next;
      next = rest as Application;
      break;
    }
    case 'validated': {
      needEvidence('Attach the authority’s validation letter or notice.');
      const weeks = Number(payload.statutoryWeeks ?? statutoryWeeks(ctx, application));
      if (!Number.isInteger(weeks) || weeks < 1) {
        throw new DomainError('CLOCK_WEEKS_UNKNOWN', 'The statutory period is not settled by an evaluation; give it in weeks (8, 13 or 16) with its basis.', 422, [{ field: 'payload.statutoryWeeks', message: 'weeks' }]);
      }
      const basis = payload.statutoryWeeks ? text(payload.weeksBasis, 'payload.weeksBasis', 3, 'Say why that period applies.') : 'From the latest rule evaluation of the proposal';
      next = {
        ...next,
        validatedOn: input.occurredOn,
        clock: { weeks, statutoryTargetOn: addDays(input.occurredOn, weeks * 7), basis },
        ...(isDate(payload.authorityTargetOn) ? { authorityTargetOn: payload.authorityTargetOn } : {}),
      };
      break;
    }
    case 'withdrawn':
      text(payload.reason, 'payload.reason', 3, 'Say why it was withdrawn.');
      break;
    case 'consultation':
      text(payload.summary, 'payload.summary', 3, 'Say who was consulted or what was said.');
      if (payload.kind !== 'STATUTORY' && payload.kind !== 'DEVELOPER_LED') {
        throw new DomainError('CONSULTATION_KIND', 'Say whether it is statutory consultation or developer-led engagement.', 422, [{ field: 'payload.kind', message: 'STATUTORY or DEVELOPER_LED' }]);
      }
      break;
    case 'amended_plans':
      needEvidence('Attach the amended plans as CDE revisions.');
      break;
    case 'extension': {
      needEvidence('An extension of time is recorded with the signed agreement.');
      if (!isDate(payload.agreedTo)) throw new DomainError('EXTENSION_DATE', 'Give the date agreed to.', 422, [{ field: 'payload.agreedTo', message: 'date' }]);
      next = { ...next, extension: { agreedTo: payload.agreedTo, eventId: event.id } };
      break;
    }
    case 'committee_resolution': {
      const resolution = text(payload.resolution, 'payload.resolution', 3, 'Give the resolution as minuted.');
      // A resolution is an event. It is not a decision and moves nothing.
      next = { ...next, committee: { resolution, on: input.occurredOn, subjectToS106: payload.subjectToS106 === true } };
      break;
    }
    case 'forecast': {
      // The forecast is its own field and never rewrites the statutory baseline.
      if (!isDate(payload.forecastDecisionOn)) throw new DomainError('FORECAST_DATE', 'Give the forecast decision date.', 422, [{ field: 'payload.forecastDecisionOn', message: 'date' }]);
      text(payload.basis, 'payload.basis', 3, 'Say what the forecast rests on.');
      next = { ...next, forecastDecisionOn: payload.forecastDecisionOn };
      break;
    }
    case 'determined': {
      needEvidence('Attach the issued decision notice.');
      if (payload.issuedNotice !== true) {
        throw new DomainError('DECISION_NOT_ISSUED', 'Only the signed, issued decision notice records a decision. A draft or a committee report does not.', 422, [{ field: 'payload.issuedNotice', message: 'confirm it is the issued notice' }]);
      }
      if (payload.outcome !== 'GRANTED' && payload.outcome !== 'REFUSED') {
        throw new DomainError('DECISION_OUTCOME', 'The outcome is granted or refused.', 422, [{ field: 'payload.outcome', message: 'GRANTED or REFUSED' }]);
      }
      const issuedBy = text(payload.issuedBy, 'payload.issuedBy', 2, 'Name the issuing authority and its decision reference.');
      next = { ...next, decision: { outcome: payload.outcome, decidedOn: input.occurredOn, issuedBy, eventId: event.id } };
      decisionRecorded = true;
      break;
    }
    case 'appeal_lodged': {
      const reference = text(payload.appealRef, 'payload.appealRef', 3, 'Give the appeal reference.');
      const ground = application.status === 'VALID' ? 'NON_DETERMINATION' : 'REFUSAL';
      if (ground === 'REFUSAL' && application.decision?.outcome !== 'REFUSED') {
        throw new DomainError('APPEAL_NOT_AVAILABLE', 'An appeal follows a refusal or a failure to determine.', 409);
      }
      if (ground === 'NON_DETERMINATION') {
        const due = application.extension?.agreedTo ?? application.clock?.statutoryTargetOn;
        if (!due || input.occurredOn <= due) throw new DomainError('APPEAL_NOT_AVAILABLE', 'A non-determination appeal is available only once the determination period, or any agreed extension, has passed.', 409);
      }
      if (application.appeal) throw new DomainError('APPEAL_EXISTS', 'An appeal is already recorded.', 409);
      next = { ...next, status: application.status, appeal: { lodgedOn: input.occurredOn, reference, ground } };
      break;
    }
    case 'appeal_decided': {
      if (!application.appeal || application.appeal.outcome) throw new DomainError('APPEAL_NOT_LODGED', 'Record the appeal first.', 409);
      needEvidence('Attach the appeal decision.');
      if (payload.outcome !== 'ALLOWED' && payload.outcome !== 'DISMISSED') {
        throw new DomainError('APPEAL_OUTCOME', 'The appeal outcome is allowed or dismissed.', 422, [{ field: 'payload.outcome', message: 'ALLOWED or DISMISSED' }]);
      }
      const inspectorRef = text(payload.inspectorRef, 'payload.inspectorRef', 3, 'Give the inspector’s decision reference.');
      next = { ...next, appeal: { ...application.appeal, outcome: payload.outcome, decidedOn: input.occurredOn, inspectorRef } };
      decisionRecorded = true;
      break;
    }
  }

  write(ctx, {
    eventType: decisionRecorded ? 'PLANNING_DECISION_RECORDED' : 'PLANNING_APPLICATION_EVENT_RECORDED',
    entity: { refType: 'PlanningApplication', refId: next.id },
    nextState: next,
    reason: `${application.reference}: ${type.replace(/_/g, ' ')} on ${input.occurredOn}`,
  });
  const granted = (type === 'determined' && next.decision?.outcome === 'GRANTED') || (type === 'appeal_decided' && next.appeal?.outcome === 'ALLOWED');
  if (granted && onGranted) onGranted(ctx, next, payload);
  planningChanged(ctx);
  return applicationOf(ctx, application.id);
}

/** Called by the G2 gate approval: the pack is approved, the application ready. */
export function markReady(ctx: EngineContext, application: Application, packId: string): void {
  write(ctx, { eventType: 'PLANNING_APPLICATION_EVENT_RECORDED', entity: { refType: 'PlanningApplication', refId: application.id }, nextState: { ...application, status: 'READY' }, reason: `${application.reference} ready: pack ${packId} approved` });
}

// =============================================================================
// Requirements and reviews
// =============================================================================

export type RequirementReview = {
  decision: 'ACCEPTED' | 'RETURNED' | 'NOT_APPLICABLE';
  rationale: string;
  evidence: EvidenceView[];
  source?: string;
  reviewedBy: string;
  reviewedAt: string;
};

export type Requirement = {
  id: string;
  /** Stable per application: the same requirement is never generated twice. */
  key: string;
  applicationId: string;
  title: string;
  gate: Gate;
  phase?: string;
  kind: 'NATIONAL' | 'LOCAL' | 'FINDING' | 'GATE' | 'EXTERNAL_CONSENT';
  basis: string;
  submissionCritical: boolean;
  owner?: string;
  dueOn?: string;
  delivery: 'NOT_STARTED' | 'COMMISSIONED' | 'IN_PROGRESS' | 'SUBMITTED_FOR_REVIEW' | 'ACCEPTED' | 'RETURNED' | 'NOT_APPLICABLE';
  evidence: EvidenceView[];
  evidenceBy?: string;
  reviews: RequirementReview[];
};

export function requirements(ctx: EngineContext, applicationId?: string): Array<Requirement & { version: number }> {
  return ctx.ledger
    .list(ctx.projectId, 'PlanningRequirement')
    .map((record) => ({ ...(record.state as unknown as Requirement), version: record.version }))
    .filter((entry) => !applicationId || entry.applicationId === applicationId);
}

type Candidate = Omit<Requirement, 'id' | 'applicationId' | 'delivery' | 'evidence' | 'reviews'>;

/** The national candidates, the gate items and the rule findings, for one application. */
function candidatesFor(ctx: EngineContext, application: Application, evaluation?: EvaluationRecord): Candidate[] {
  const major = evaluation?.major === 'MAJOR';
  const bng = evaluation?.findings.find((finding) => finding.code === 'BNG');
  const linked = application.route !== 'full' && application.route !== 'outline';
  const list: Candidate[] = [
    { key: 'G1:SITE_CONTROL', title: 'Site control and access: title, rights of way and access rights reviewed', gate: 'G1', kind: 'GATE', basis: 'Specification G1', submissionCritical: false },
    { key: 'G1:CONSULTANT_SCOPE', title: 'Consultant scopes and quotes for the studies the route needs', gate: 'G1', kind: 'GATE', basis: 'Specification G1', submissionCritical: false },
    { key: 'G1:LOCAL_POLICY', title: 'Local plan and policy review for the route', gate: 'G1', kind: 'GATE', basis: 'Specification G1', submissionCritical: false },
    { key: 'NAT:FORM', title: 'Application form', gate: 'G2', kind: 'NATIONAL', basis: 'Making an application (national requirement)', submissionCritical: true },
    { key: 'NAT:FEE', title: 'Fee, or evidence of exemption', gate: 'G2', kind: 'NATIONAL', basis: 'Making an application (national requirement)', submissionCritical: true },
    ...(linked
      ? []
      : ([
          { key: 'NAT:CERTIFICATES', title: 'Ownership certificate and agricultural land declaration, with any notices served', gate: 'G2', kind: 'NATIONAL', basis: 'DMPO 2015 articles 13–14', submissionCritical: true },
          { key: 'NAT:LOCATION_PLAN', title: 'Location plan with the red line', gate: 'G2', kind: 'NATIONAL', basis: 'Making an application (national requirement)', submissionCritical: true },
          { key: 'NAT:SITE_PLAN', title: 'Site plan', gate: 'G2', kind: 'NATIONAL', basis: 'Making an application (national requirement)', submissionCritical: true },
        ] satisfies Candidate[])),
    ...(major && !linked
      ? [{ key: 'NAT:DAS', title: 'Design and Access Statement', gate: 'G2' as Gate, kind: 'NATIONAL' as const, basis: 'DMPO 2015 article 9: required for major development', submissionCritical: true }]
      : []),
    ...(bng && bng.status !== 'does_not_apply' && !linked
      ? [{ key: 'NAT:BNG_INFO', title: 'Biodiversity net gain information', gate: 'G2' as Gate, kind: 'NATIONAL' as const, basis: 'Biodiversity net gain (applicability as evaluated)', submissionCritical: true }]
      : []),
  ];
  for (const finding of evaluation?.findings ?? []) {
    if (finding.status !== 'applies' && finding.status !== 'review_required') continue;
    if (finding.evidenceNeeded.length === 0) continue;
    if (finding.code.startsWith('MAJOR_') || finding.code === 'DETERMINATION_PERIOD') continue;
    list.push({
      key: `FINDING:${finding.code}`,
      title: `${finding.title}: ${finding.evidenceNeeded.join('; ')}`,
      gate: finding.gate,
      kind: finding.source.kind === 'LOCAL' ? 'LOCAL' : 'FINDING',
      basis: `${finding.source.title} — ${finding.reason}`,
      submissionCritical: finding.gate === 'G2' || finding.gate === 'G1',
    });
  }
  return list;
}

/** Add any requirement the application now needs and does not have. Never removes one. */
export function generateRequirements(ctx: EngineContext, applicationId: string): Requirement[] {
  guard(ctx, 'C');
  const application = applicationOf(ctx, applicationId);
  const evaluation = application.proposalId ? evaluations(ctx).filter((entry) => entry.proposalId === application.proposalId).at(-1) : undefined;
  const existing = new Set(requirements(ctx, applicationId).map((entry) => entry.key));
  const added: Requirement[] = [];
  for (const candidate of candidatesFor(ctx, application, evaluation)) {
    if (existing.has(candidate.key)) continue;
    const requirement: Requirement = { ...candidate, id: ulid(), applicationId, delivery: 'NOT_STARTED', evidence: [], reviews: [] };
    write(ctx, { eventType: 'PLANNING_REQUIREMENT_RECORDED', entity: { refType: 'PlanningRequirement', refId: requirement.id }, nextState: requirement, reason: `${application.reference}: ${requirement.title}` });
    added.push(requirement);
  }
  if (added.length > 0) planningChanged(ctx);
  return added;
}

/** A local requirement, or an external consent for a phase, added by hand with its basis. */
export function addRequirement(
  ctx: EngineContext,
  input: { applicationId: string; title: string; kind: 'LOCAL' | 'EXTERNAL_CONSENT'; gate: string; phase?: string; basis: string; submissionCritical?: boolean },
): Requirement {
  guard(ctx, 'C');
  const application = applicationOf(ctx, input.applicationId);
  if (input.kind !== 'LOCAL' && input.kind !== 'EXTERNAL_CONSENT') throw new DomainError('REQUIREMENT_KIND', 'A requirement added by hand is local or an external consent.', 422, [{ field: 'kind', message: 'choose one' }]);
  if (!['G1', 'G2', 'G3', 'G4', 'G5'].includes(input.gate)) throw new DomainError('REQUIREMENT_GATE', 'Choose the gate it bears on.', 422, [{ field: 'gate', message: 'G1–G5' }]);
  if (input.phase && !application.phases.includes(input.phase)) throw new DomainError('REQUIREMENT_PHASE', `Choose one of the application's phases: ${application.phases.join(', ')}.`, 422, [{ field: 'phase', message: 'a phase' }]);
  const title = text(input.title, 'title', 3, 'Name the requirement.');
  const basis = text(input.basis, 'basis', 3, 'Give its basis — the local list item, the consenting body, the policy.');
  const requirement: Requirement = {
    id: ulid(),
    key: `${input.kind}:${ulid()}`,
    applicationId: application.id,
    title,
    gate: input.gate as Gate,
    ...(input.phase ? { phase: input.phase } : {}),
    kind: input.kind,
    basis,
    submissionCritical: input.submissionCritical ?? input.kind === 'LOCAL',
    delivery: 'NOT_STARTED',
    evidence: [],
    reviews: [],
  };
  write(ctx, { eventType: 'PLANNING_REQUIREMENT_RECORDED', entity: { refType: 'PlanningRequirement', refId: requirement.id }, nextState: requirement, reason: `${application.reference}: ${title}` });
  planningChanged(ctx);
  return requirement;
}

function requirementOf(ctx: EngineContext, id: string): Requirement & { version: number } {
  const found = requirements(ctx).find((entry) => entry.id === id);
  if (!found) throw new DomainError('REQUIREMENT_NOT_FOUND', 'No such requirement on this project.', 404);
  return found;
}

/** Owner, due date, delivery progress and evidence. Linking new evidence reopens a previous acceptance. */
export function updateRequirement(
  ctx: EngineContext,
  id: string,
  input: { owner?: string; dueOn?: string; delivery?: string; evidence?: unknown },
): Requirement {
  guard(ctx, 'U');
  const { version: _version, ...existing } = requirementOf(ctx, id);
  if (input.dueOn !== undefined && !isDate(input.dueOn)) throw new DomainError('REQUIREMENT_DUE', 'A due date is YYYY-MM-DD.', 422, [{ field: 'dueOn', message: 'date' }]);
  const settable = ['NOT_STARTED', 'COMMISSIONED', 'IN_PROGRESS', 'SUBMITTED_FOR_REVIEW'];
  if (input.delivery !== undefined && !settable.includes(input.delivery)) {
    throw new DomainError('REQUIREMENT_DELIVERY', 'Acceptance, return and non-applicability are a reviewer’s decision, not a status to set.', 422, [{ field: 'delivery', message: settable.join(', ') }]);
  }
  const evidence = input.evidence === undefined ? undefined : resolveEvidence(ctx, input.evidence);
  const evidenceChanged = evidence !== undefined && JSON.stringify(evidence.map((entry) => entry.refId)) !== JSON.stringify(existing.evidence.map((entry) => entry.refId));
  const next: Requirement = {
    ...existing,
    ...(input.owner !== undefined ? { owner: input.owner.trim() } : {}),
    ...(input.dueOn !== undefined ? { dueOn: input.dueOn } : {}),
    ...(evidence ? { evidence, evidenceBy: ctx.auth.actorId } : {}),
    // New evidence against an accepted requirement puts it back in front of a reviewer.
    delivery: evidenceChanged && existing.delivery === 'ACCEPTED' ? 'SUBMITTED_FOR_REVIEW' : ((input.delivery as Requirement['delivery']) ?? existing.delivery),
  };
  write(ctx, { eventType: 'PLANNING_REQUIREMENT_UPDATED', entity: { refType: 'PlanningRequirement', refId: id }, nextState: next, reason: `${existing.title} updated` });
  planningChanged(ctx);
  return next;
}

/**
 * A reviewer's decision. Acceptance needs evidence; non-applicability needs a
 * source; a return needs the reason. The person who attached the evidence does
 * not accept it.
 */
export function reviewRequirement(
  ctx: EngineContext,
  id: string,
  input: { decision: string; rationale: string; source?: string; evidence?: unknown },
): Requirement {
  guard(ctx, 'U');
  const { version: _version, ...existing } = requirementOf(ctx, id);
  if (!['ACCEPTED', 'RETURNED', 'NOT_APPLICABLE'].includes(input.decision)) {
    throw new DomainError('REVIEW_DECISION', 'The decision is accepted, returned or not applicable.', 422, [{ field: 'decision', message: 'choose one' }]);
  }
  const rationale = text(input.rationale, 'rationale', 5, 'Give the reason for the decision.');
  const evidence = input.evidence === undefined ? existing.evidence : resolveEvidence(ctx, input.evidence);
  if (input.decision === 'ACCEPTED') {
    if (evidence.length === 0) throw new DomainError('REVIEW_EVIDENCE_REQUIRED', 'A requirement is accepted on its evidence; none is linked.', 409);
    if (existing.evidenceBy === ctx.auth.actorId) {
      throw new DomainError('REVIEW_SAME_PERSON', 'The person who attached the evidence does not accept it; a second person reviews.', 403);
    }
  }
  const source = input.decision === 'NOT_APPLICABLE' ? text(input.source, 'source', 5, 'Non-applicability is recorded with its source — the regulation, the authority’s letter, the checklist.') : undefined;
  const review: RequirementReview = { decision: input.decision as RequirementReview['decision'], rationale, evidence, ...(source ? { source } : {}), reviewedBy: ctx.auth.actorId, reviewedAt: new Date().toISOString() };
  const next: Requirement = { ...existing, evidence, reviews: [...existing.reviews, review], delivery: review.decision };
  write(ctx, { eventType: 'PLANNING_REQUIREMENT_REVIEWED', entity: { refType: 'PlanningRequirement', refId: id }, nextState: next, reason: `${existing.title}: ${review.decision.toLowerCase().replace('_', ' ')} — ${rationale}` });
  planningChanged(ctx);
  return next;
}

// =============================================================================
// Submission packs: an immutable manifest
// =============================================================================

export type PackItem = { kind: 'PROPOSAL' | 'EVALUATION' | 'FEE_QUOTE' | 'RULE_VERSION' | 'DOCUMENT' | 'REQUIREMENT'; refType: string; refId: string; version: number; label: string; hash?: string };

export type Pack = {
  id: string;
  applicationId: string;
  evaluationId?: string;
  feeQuoteId: string;
  items: PackItem[];
  /** The hash of the manifest: what was frozen, exactly. */
  manifestHash: string;
  status: 'ASSEMBLED' | 'APPROVED';
  assembledBy: string;
  assembledAt: string;
  approvedBy?: string;
  approvedAt?: string;
};

export function packs(ctx: EngineContext, applicationId?: string): Pack[] {
  return states<Pack>(ctx, 'PlanningPack').filter((entry) => !applicationId || entry.applicationId === applicationId);
}

const FEE_ROUTE_FOR: Record<ApplicationRoute, string> = {
  full: 'full',
  outline: 'outline',
  reserved_matters: 'reserved_matters',
  section_73: 'section_73_major',
  section_96a: 'section_96a_non_householder',
};

/** Freeze the proposal, the evaluation, the rule versions, the fee basis and the documents. */
export function assemblePack(ctx: EngineContext, input: { applicationId: string; evaluationId?: string; feeQuoteId: string; documents: unknown }): Pack {
  guard(ctx, 'C');
  const application = applicationOf(ctx, input.applicationId);
  if (application.status !== 'DRAFT' && application.status !== 'INVALID') {
    throw new DomainError('PACK_APPLICATION_STATE', `${application.reference} is ${application.status.toLowerCase()}; a pack is assembled before submission or to correct an invalid one.`, 409);
  }
  const versionOf = (refType: string, refId: string) => ctx.ledger.get({ refType, refId })?.version ?? 0;
  const items: PackItem[] = [];
  let evaluationId: string | undefined;
  if (application.proposalId) {
    const subject = proposals(ctx).find((entry) => entry.id === application.proposalId)!;
    const evaluation = evaluations(ctx).find((entry) => entry.id === input.evaluationId);
    if (!evaluation || evaluation.proposalId !== subject.id) {
      throw new DomainError('PACK_EVALUATION', 'Choose an evaluation of this application’s proposal.', 422, [{ field: 'evaluationId', message: 'an evaluation of the proposal' }]);
    }
    evaluationId = evaluation.id;
    items.push({ kind: 'PROPOSAL', refType: 'PlanningProposal', refId: subject.id, version: versionOf('PlanningProposal', subject.id), label: `${subject.scenarioName} v${subject.version}` });
    items.push({ kind: 'EVALUATION', refType: 'PlanningEvaluation', refId: evaluation.id, version: versionOf('PlanningEvaluation', evaluation.id), label: `${evaluation.ruleVersion}, ${evaluation.evaluatedAt.slice(0, 10)}`, hash: evaluation.rulePackHash });
  }
  const quote = feeQuotes(ctx).find((entry) => entry.id === input.feeQuoteId);
  if (!quote) throw new DomainError('FEE_QUOTE_NOT_FOUND', 'No such fee quote on this project.', 404, [{ field: 'feeQuoteId', message: 'choose a quote' }]);
  if (quote.route !== FEE_ROUTE_FOR[application.route]) {
    throw new DomainError('PACK_FEE_ROUTE', `That quote is for ${quote.route.replace(/_/g, ' ')}; this application needs ${FEE_ROUTE_FOR[application.route].replace(/_/g, ' ')}.`, 422, [{ field: 'feeQuoteId', message: 'a quote for this route' }]);
  }
  items.push({ kind: 'FEE_QUOTE', refType: 'PlanningFeeQuote', refId: quote.id, version: versionOf('PlanningFeeQuote', quote.id), label: `${quote.ruleVersion ?? 'no schedule'}, made ${quote.madeOn}`, ...(quote.scheduleHash ? { hash: quote.scheduleHash } : {}) });
  for (const rule of ruleVersionPositions(ctx).filter((entry) => entry.version === quote.ruleVersion || entry.kind === 'EVALUATION')) {
    items.push({ kind: 'RULE_VERSION', refType: 'PlanningRuleVersion', refId: rule.version, version: 0, label: `${rule.version} (${rule.status.toLowerCase()})`, hash: rule.hash });
  }
  const documents = resolveEvidence(ctx, input.documents, 'documents');
  if (documents.length === 0) throw new DomainError('PACK_DOCUMENTS', 'A pack carries the documents being submitted.', 422, [{ field: 'documents', message: 'at least one' }]);
  for (const document of documents) {
    items.push({ kind: 'DOCUMENT', refType: document.refType, refId: document.refId, version: versionOf(document.refType, document.refId), label: document.label, hash: document.hash });
  }
  for (const requirement of requirements(ctx, application.id).filter((entry) => entry.submissionCritical)) {
    items.push({ kind: 'REQUIREMENT', refType: 'PlanningRequirement', refId: requirement.id, version: requirement.version, label: `${requirement.title} — ${requirement.delivery.toLowerCase().replace(/_/g, ' ')}` });
  }
  const pack: Pack = {
    id: ulid(),
    applicationId: application.id,
    ...(evaluationId ? { evaluationId } : {}),
    feeQuoteId: quote.id,
    items,
    manifestHash: hashEvidence(JSON.stringify(items)),
    status: 'ASSEMBLED',
    assembledBy: ctx.auth.actorId,
    assembledAt: new Date().toISOString(),
  };
  write(ctx, { eventType: 'PLANNING_PACK_ASSEMBLED', entity: { refType: 'PlanningPack', refId: pack.id }, nextState: pack, reason: `${application.reference}: pack of ${items.length} items, manifest ${pack.manifestHash.slice(0, 12)}` });
  planningChanged(ctx);
  return pack;
}

/** Why a pack no longer matches the project, if it does not. */
export function packStaleness(ctx: EngineContext, pack: Pack): string[] {
  const reasons: string[] = [];
  for (const item of pack.items) {
    if (item.kind === 'RULE_VERSION') {
      const rule = ruleVersionPositions(ctx).find((entry) => entry.version === item.refId);
      if (rule && rule.hash !== item.hash) reasons.push(`${item.refId} has changed since the pack was assembled.`);
      continue;
    }
    const now = ctx.ledger.get({ refType: item.refType, refId: item.refId })?.version ?? 0;
    if (now !== item.version) reasons.push(`${item.label.split(' — ')[0]} has changed since the pack was assembled.`);
  }
  if (pack.evaluationId) {
    const evaluation = evaluations(ctx).find((entry) => entry.id === pack.evaluationId);
    if (evaluation) reasons.push(...evaluationStaleness(ctx, evaluation));
    const newer = evaluation && evaluations(ctx).some((entry) => entry.proposalId === evaluation.proposalId && entry.evaluatedAt > evaluation.evaluatedAt);
    if (newer) reasons.push('A newer evaluation of the proposal exists.');
  }
  for (const document of resolveEvidence(ctx, pack.items.filter((item) => item.kind === 'DOCUMENT').map((item) => ({ refType: item.refType, refId: item.refId })), 'documents', { checkAccess: false })) {
    if (document.superseded) reasons.push(`${document.label} has been superseded in the CDE.`);
  }
  return [...new Set(reasons)];
}

/** The pack's documents for export — refused while any is quarantined. */
export function packManifest(ctx: EngineContext, packId: string): Pack & { documents: EvidenceView[]; stale: string[] } {
  guard(ctx, 'R');
  const pack = packs(ctx).find((entry) => entry.id === packId);
  if (!pack) throw new DomainError('PACK_NOT_FOUND', 'No such pack on this project.', 404);
  const documents = resolveEvidence(ctx, pack.items.filter((item) => item.kind === 'DOCUMENT').map((item) => ({ refType: item.refType, refId: item.refId })), 'documents', { checkAccess: false });
  const quarantined = documents.filter((document) => document.quarantined);
  if (quarantined.length > 0) {
    throw new DomainError('PACK_QUARANTINED', `The scanner flagged ${quarantined.map((document) => document.label).join(', ')}; the pack is not exported while any document in it is quarantined.`, 409);
  }
  return { ...pack, documents, stale: packStaleness(ctx, pack) };
}

/** Called by the G2 approval. */
export function approvePack(ctx: EngineContext, pack: Pack): Pack {
  const next: Pack = { ...pack, status: 'APPROVED', approvedBy: ctx.auth.actorId, approvedAt: new Date().toISOString() };
  write(ctx, { eventType: 'PLANNING_PACK_APPROVED', entity: { refType: 'PlanningPack', refId: pack.id }, nextState: next, reason: `Pack ${pack.manifestHash.slice(0, 12)} approved for submission` });
  return next;
}

