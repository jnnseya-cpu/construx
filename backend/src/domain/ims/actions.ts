import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { registerEvidence, write, type EngineContext } from '../../engines/context.ts';
import { isStandard, type Standard } from './clauses.ts';
import { guard, isoDate, nameOf, nextReference, optionalText, stateOf, text, today, type Person } from './ims.ts';

/**
 * Corrective and improvement actions, company-wide.
 *
 * ISO 9001, 14001 and 45001 10.2 ask the same thing of a nonconformity: react
 * to it, find its cause, act on the cause, and **review the effectiveness** of
 * what was done. So an action here runs:
 *
 *   open → (correction, root cause, the actions planned) → implemented →
 *   verified effective (closed) — or not effective, and open again.
 *
 * The person who verifies is not the person who implemented: checking your own
 * fix is not a check. A corrective action cannot be marked implemented without a
 * root cause and the actions taken on it.
 *
 * An action is raised from wherever the problem was found — an audit finding,
 * an incident or an NCR on any of the company's projects, a management review,
 * a compliance evaluation, a supplier — and names the record it came from, which
 * must exist in this company. Project NCRs keep their own disposition; this is
 * the system-level response to them.
 */

export const ACTION_KINDS = ['CORRECTIVE', 'IMPROVEMENT'] as const;
export const SOURCE_KINDS = ['AUDIT_FINDING', 'INCIDENT', 'NCR', 'MANAGEMENT_REVIEW', 'OBLIGATION', 'SUPPLIER', 'COMPLAINT', 'OTHER'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** The record each kind of source must name, where it names one. */
const SOURCE_TYPE: Partial<Record<SourceKind, string>> = {
  AUDIT_FINDING: 'ImsAuditFinding',
  INCIDENT: 'Incident',
  NCR: 'NCR',
  MANAGEMENT_REVIEW: 'ImsManagementReview',
  OBLIGATION: 'ImsObligation',
  SUPPLIER: 'Supplier',
};

export type ActionSource = { kind: SourceKind; refType?: string; refId?: string; projectId?: string; label: string };

export type ImsAction = {
  id: string;
  reference: string;
  kind: (typeof ACTION_KINDS)[number];
  source: ActionSource;
  standards: Standard[];
  description: string;
  correction?: string;
  rootCause?: string;
  plannedActions?: string;
  ownerId: string;
  dueOn: string;
  status: 'OPEN' | 'IMPLEMENTED' | 'CLOSED';
  implemented?: { by: string; on: string; note: string; evidenceId?: string };
  verification?: { by: string; on: string; effective: boolean; note: string };
  history: Array<{ at: string; by: string; what: string }>;
  raisedBy: string;
  raisedAt: string;
};

export const actions = (ctx: EngineContext): Array<ImsAction & { version: number }> =>
  ctx.ledger.list(ctx.projectId, 'ImsAction').map((record) => ({ ...(record.state as unknown as ImsAction), version: record.version }));

export function actionOf(ctx: EngineContext, id: string): ImsAction & { version: number } {
  const found = stateOf<ImsAction>(ctx, 'ImsAction', id);
  if (!found) throw new DomainError('IMS_ACTION_NOT_FOUND', 'No such action in this management system.', 404);
  return found;
}

/** The source record, which must exist in this company. */
function checkedSource(ctx: EngineContext, source: Partial<ActionSource> | undefined): ActionSource {
  const kind = source?.kind;
  if (!kind || !(SOURCE_KINDS as readonly string[]).includes(kind)) {
    throw new DomainError('IMS_ACTION_SOURCE', `Say where it came from: ${SOURCE_KINDS.join(', ')}.`, 422, [{ field: 'source.kind', message: 'choose one' }]);
  }
  const expected = SOURCE_TYPE[kind];
  if (!expected) {
    return { kind, label: text(source.label, 'source.label', 3, 'Describe where it came from — who complained, about what, when.', 300) };
  }
  if (source.refType !== expected || !source.refId) {
    throw new DomainError('IMS_ACTION_SOURCE', `An action from ${kind.toLowerCase().replace('_', ' ')} names the ${expected} it came from.`, 422, [{ field: 'source.refId', message: expected }]);
  }
  const record = ctx.ledger.get({ refType: expected, refId: source.refId });
  if (!record || record.tenantId !== ctx.tenantId) {
    // Another company's record, or none: answered the same way.
    throw new DomainError('IMS_ACTION_SOURCE_NOT_FOUND', `No such ${expected} in this company.`, 404);
  }
  const state = record.state as Record<string, unknown>;
  const label = String(source.label ?? '').trim() || String(state.reference ?? state.legalName ?? state.title ?? record.refId);
  return { kind, refType: expected, refId: source.refId, ...(record.projectId !== ctx.projectId ? { projectId: record.projectId } : {}), label: label.slice(0, 300) };
}

export type RaiseActionInput = {
  kind: string;
  source: Partial<ActionSource>;
  standards: string[];
  description: string;
  correction?: string;
  ownerId: string;
  dueOn: string;
};

export function raiseAction(ctx: EngineContext, input: RaiseActionInput, options: { eventCause?: string } = {}): ImsAction {
  guard(ctx, 'C');
  if (!(ACTION_KINDS as readonly string[]).includes(input.kind)) {
    throw new DomainError('IMS_ACTION_KIND', 'Corrective (something went wrong) or improvement (it could go better).', 422, [{ field: 'kind', message: 'choose one' }]);
  }
  const standards = [...new Set(input.standards ?? [])];
  if (standards.length === 0 || !standards.every(isStandard)) {
    throw new DomainError('IMS_STANDARDS', 'Name the standards it concerns.', 422, [{ field: 'standards', message: 'one or more' }]);
  }
  const source = checkedSource(ctx, input.source);
  const now = new Date().toISOString();
  const action: ImsAction = {
    id: ulid(),
    reference: nextReference(ctx, 'ImsAction', 'CA'),
    kind: input.kind as ImsAction['kind'],
    source,
    standards: standards as Standard[],
    description: text(input.description, 'description', 10, 'Describe the problem or the opportunity, as found.', 4000),
    ...(optionalText(input.correction) ? { correction: optionalText(input.correction)! } : {}),
    ownerId: text(input.ownerId, 'ownerId', 1, 'Name who owns the action.', 200),
    dueOn: isoDate(input.dueOn, 'dueOn', 'The date it is due, YYYY-MM-DD.'),
    status: 'OPEN',
    history: [{ at: now, by: ctx.auth.actorId, what: options.eventCause ?? 'Raised' }],
    raisedBy: ctx.auth.actorId,
    raisedAt: now,
  };
  write(ctx, { eventType: 'IMS_ACTION_RAISED', entity: { refType: 'ImsAction', refId: action.id }, nextState: action as unknown as Record<string, unknown>, reason: `${action.reference} from ${source.label}: ${action.description.slice(0, 120)}` });
  return action;
}

const stripVersion = (action: ImsAction & { version?: number }): ImsAction => {
  const { version: _version, ...rest } = action;
  return rest;
};

/** The investigation: the correction, the root cause, what will be done about it, who and by when. */
export function updateAction(ctx: EngineContext, id: string, input: { correction?: string; rootCause?: string; plannedActions?: string; ownerId?: string; dueOn?: string }): ImsAction {
  guard(ctx, 'U');
  const action = actionOf(ctx, id);
  if (action.status !== 'OPEN') throw new DomainError('IMS_ACTION_STATE', `${action.reference} is ${action.status.toLowerCase()}; it is changed only while open.`, 409);
  const next: ImsAction = stripVersion({
    ...action,
    ...(input.correction !== undefined ? { correction: optionalText(input.correction) } : {}),
    ...(input.rootCause !== undefined ? { rootCause: text(input.rootCause, 'rootCause', 10, 'State the cause — why it happened, not what happened.', 4000) } : {}),
    ...(input.plannedActions !== undefined ? { plannedActions: text(input.plannedActions, 'plannedActions', 10, 'Say what will be done about the cause.', 4000) } : {}),
    ...(input.ownerId !== undefined ? { ownerId: text(input.ownerId, 'ownerId', 1, 'Name the owner.', 200) } : {}),
    ...(input.dueOn !== undefined ? { dueOn: isoDate(input.dueOn, 'dueOn') } : {}),
    history: [...action.history, { at: new Date().toISOString(), by: ctx.auth.actorId, what: 'Investigation updated' }],
  });
  write(ctx, { eventType: 'IMS_ACTION_UPDATED', entity: { refType: 'ImsAction', refId: id }, nextState: next as unknown as Record<string, unknown>, reason: `${action.reference} updated` });
  return next;
}

export function implementAction(ctx: EngineContext, id: string, input: { note: string; evidenceHash?: string }): ImsAction {
  guard(ctx, 'U');
  const action = actionOf(ctx, id);
  if (action.status !== 'OPEN') throw new DomainError('IMS_ACTION_STATE', `${action.reference} is already ${action.status.toLowerCase()}.`, 409);
  if (action.kind === 'CORRECTIVE' && (!action.rootCause || !action.plannedActions)) {
    throw new DomainError('IMS_ROOT_CAUSE_REQUIRED', 'A corrective action is implemented on its cause: record the root cause and the actions taken first.', 409, [{ field: 'rootCause', message: 'required first' }]);
  }
  const note = text(input.note, 'note', 5, 'Say what was done.', 4000);
  const evidence = input.evidenceHash ? registerEvidence(ctx, { type: 'IMS_ACTION_EVIDENCE', hash: input.evidenceHash, description: `${action.reference} implemented: ${note.slice(0, 80)}` }) : undefined;
  const on = today();
  const next: ImsAction = stripVersion({
    ...action,
    status: 'IMPLEMENTED',
    implemented: { by: ctx.auth.actorId, on, note, ...(evidence ? { evidenceId: evidence.refId } : {}) },
    history: [...action.history, { at: new Date().toISOString(), by: ctx.auth.actorId, what: `Implemented: ${note.slice(0, 200)}` }],
  });
  write(ctx, {
    eventType: 'IMS_ACTION_IMPLEMENTED',
    entity: { refType: 'ImsAction', refId: id },
    nextState: next as unknown as Record<string, unknown>,
    reason: `${action.reference} implemented`,
    ...(evidence ? { evidenceRefs: [evidence] } : {}),
  });
  return next;
}

/** Effective: closed. Not effective: open again, with the history kept. Never by the person who implemented it. */
export function verifyAction(ctx: EngineContext, id: string, input: { effective: boolean; note: string }): ImsAction {
  guard(ctx, 'U');
  const action = actionOf(ctx, id);
  if (action.status !== 'IMPLEMENTED') throw new DomainError('IMS_ACTION_STATE', `${action.reference} is ${action.status.toLowerCase()}; only an implemented action is verified.`, 409);
  if (action.implemented?.by === ctx.auth.actorId) {
    throw new DomainError('IMS_VERIFY_SAME_PERSON', 'Effectiveness is verified by somebody other than the person who implemented the action.', 403);
  }
  if (typeof input.effective !== 'boolean') throw new DomainError('IMS_VERIFY_OUTCOME', 'Say whether it was effective.', 422, [{ field: 'effective', message: 'yes or no' }]);
  const note = text(input.note, 'note', 5, 'Say what showed it worked, or did not.', 4000);
  const on = today();
  const next: ImsAction = stripVersion({
    ...action,
    status: input.effective ? 'CLOSED' : 'OPEN',
    verification: { by: ctx.auth.actorId, on, effective: input.effective, note },
    ...(input.effective ? {} : { implemented: undefined }),
    history: [...action.history, { at: new Date().toISOString(), by: ctx.auth.actorId, what: input.effective ? `Verified effective: ${note.slice(0, 200)}` : `Not effective, reopened: ${note.slice(0, 200)}` }],
  });
  write(ctx, { eventType: 'IMS_ACTION_VERIFIED', entity: { refType: 'ImsAction', refId: id }, nextState: next as unknown as Record<string, unknown>, reason: `${action.reference} ${input.effective ? 'verified effective and closed' : 'not effective; reopened'}` });
  return next;
}

export type ActionPosition = ImsAction & { version: number; owner: string; overdue: boolean };

export function actionRegister(ctx: EngineContext, people: readonly Person[]): ActionPosition[] {
  guard(ctx, 'R');
  const on = today();
  return actions(ctx)
    .map((action) => ({ ...action, owner: nameOf(people, action.ownerId), overdue: action.status === 'OPEN' && action.dueOn < on }))
    .sort((a, b) => Number(b.status !== 'CLOSED') - Number(a.status !== 'CLOSED') || a.dueOn.localeCompare(b.dueOn));
}

/**
 * The records an action can be raised from, across every project in the company.
 *
 * Only what identifies each one — reference, project, kind, date, status — and
 * never the description, the people involved or the location: the management
 * system needs to know an incident happened and is being acted on, and a
 * reader of the system who is not on that project does not need its detail.
 */
export function sourceCandidates(ctx: EngineContext) {
  guard(ctx, 'R');
  const projectName = new Map(ctx.ledger.listByTenant(ctx.tenantId, 'Project').map((record) => [record.refId, String(record.state.name ?? record.refId)]));
  const fromProjects = (type: string) => ctx.ledger.listByTenant(ctx.tenantId, type).filter((record) => !record.projectId.endsWith('-governance'));
  return {
    incidents: fromProjects('Incident').map((record) => ({
      refId: record.refId,
      reference: String(record.state.reference ?? record.refId),
      project: projectName.get(record.projectId) ?? record.projectId,
      category: String(record.state.category ?? ''),
      occurredAt: String(record.state.occurredAt ?? '').slice(0, 10),
      status: String(record.state.status ?? ''),
    })),
    ncrs: fromProjects('NCR').map((record) => ({
      refId: record.refId,
      reference: String(record.state.reference ?? record.refId),
      project: projectName.get(record.projectId) ?? record.projectId,
      severity: String(record.state.severity ?? ''),
      status: String(record.state.status ?? ''),
    })),
    suppliers: ctx.ledger
      .listByTenant(ctx.tenantId, 'Supplier')
      .map((record) => ({ refId: record.refId, reference: String(record.state.legalName ?? record.refId), status: String(record.state.status ?? '') })),
  };
}
