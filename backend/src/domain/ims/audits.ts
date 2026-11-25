import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { write, type EngineContext } from '../../engines/context.ts';
import { PERMISSION_MATRIX, isRole } from '../../identity/roles.ts';
import { actions, raiseAction } from './actions.ts';
import { CLAUSES, clauseById, isClauseId, isStandard, type Standard } from './clauses.ts';
import { documents } from './documents.ts';
import { activePeople, addMonths, guard, isoDate, nameOf, nextReference, stateOf, states, text, today, type Person } from './ims.ts';

/**
 * Internal audit (clause 9.2 of all three standards): a programme of audits,
 * each against clauses, procedures and projects; findings graded and
 * evidenced; every nonconformity carried into a corrective action.
 *
 * - **Objectivity.** The lead auditor may not audit their own work: not a
 *   document they own, drafted or approved the revision in force of.
 * - **The auditor records.** Only the lead auditor raises findings and completes
 *   the audit, and they must hold a role that may record in the system.
 * - **Nonconformities do not get lost.** A major or minor nonconformity raises
 *   its corrective action at the moment it is recorded, with an owner and a due
 *   date, so an audit cannot be closed with a finding nobody is acting on.
 * - **Coverage.** The programme shows, clause by clause, when each was last
 *   audited and when it is next planned, and which are covered by neither.
 */

export const FINDING_GRADES = ['MAJOR_NC', 'MINOR_NC', 'OBSERVATION', 'OPPORTUNITY'] as const;
export type FindingGrade = (typeof FINDING_GRADES)[number];
const NONCONFORMITY: readonly FindingGrade[] = ['MAJOR_NC', 'MINOR_NC'];

export type ChecklistItem = { clauseId?: string; documentId?: string; question: string };

export type ImsAudit = {
  id: string;
  reference: string;
  title: string;
  standards: Standard[];
  clauses: string[];
  documentIds: string[];
  projectIds: string[];
  plannedOn: string;
  leadAuditorId: string;
  status: 'PLANNED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  checklist: ChecklistItem[];
  startedOn?: string;
  completed?: { on: string; by: string; summary: string; conclusion: string };
  cancelled?: { on: string; by: string; reason: string };
  createdBy: string;
  createdAt: string;
};

export type ImsAuditFinding = {
  id: string;
  auditId: string;
  reference: string;
  grade: FindingGrade;
  clauseId: string;
  documentId?: string;
  projectId?: string;
  statement: string;
  evidence: string;
  raisedBy: string;
  raisedAt: string;
};

export const audits = (ctx: EngineContext): Array<ImsAudit & { version: number }> =>
  ctx.ledger.list(ctx.projectId, 'ImsAudit').map((record) => ({ ...(record.state as unknown as ImsAudit), version: record.version }));
export const findings = (ctx: EngineContext, auditId?: string): ImsAuditFinding[] =>
  states<ImsAuditFinding>(ctx, 'ImsAuditFinding').filter((finding) => !auditId || finding.auditId === auditId);

export function auditOf(ctx: EngineContext, id: string): ImsAudit & { version: number } {
  const found = stateOf<ImsAudit>(ctx, 'ImsAudit', id);
  if (!found) throw new DomainError('IMS_AUDIT_NOT_FOUND', 'No such audit in this management system.', 404);
  return found;
}

/** The company's delivery projects, for an audit's site scope. */
export function companyProjects(ctx: EngineContext): Array<{ id: string; name: string }> {
  return ctx.ledger
    .listByTenant(ctx.tenantId, 'Project')
    .filter((record) => !record.refId.endsWith('-governance'))
    .map((record) => ({ id: record.refId, name: String(record.state.name ?? record.refId) }));
}

/** May this person record in the system — raise findings, complete an audit? */
function mayRecord(person: Person): boolean {
  return person.roles.some((role) => {
    if (!isRole(role)) return false;
    const granted = (PERMISSION_MATRIX[role] as Record<string, readonly string[] | undefined>).MANAGEMENT_SYSTEM ?? [];
    return granted.includes('U');
  });
}

const stripVersion = <T extends { version?: number }>(value: T): Omit<T, 'version'> => {
  const { version: _version, ...rest } = value;
  return rest;
};

export function planAudit(
  ctx: EngineContext,
  people: readonly Person[],
  input: { title: string; standards: string[]; clauses: string[]; documentIds?: string[]; projectIds?: string[]; plannedOn: string; leadAuditorId: string },
): ImsAudit {
  guard(ctx, 'C');
  const title = text(input.title, 'title', 3, 'Say what the audit covers.', 200);
  const standards = [...new Set(input.standards ?? [])];
  if (standards.length === 0 || !standards.every(isStandard)) throw new DomainError('IMS_STANDARDS', 'Name the standards audited.', 422, [{ field: 'standards', message: 'one or more' }]);
  const clauses = [...new Set(input.clauses ?? [])];
  if (clauses.length === 0) throw new DomainError('IMS_AUDIT_SCOPE', 'An audit is against clauses: name at least one.', 422, [{ field: 'clauses', message: 'one or more' }]);
  const bad = clauses.filter((id) => !isClauseId(id) || !standards.includes(clauseById(id)!.standard));
  if (bad.length) throw new DomainError('IMS_CLAUSE_STANDARD', `Not clauses of the standards audited: ${bad.join(', ')}.`, 422, [{ field: 'clauses', message: 'of the chosen standards' }]);
  const library = documents(ctx);
  const documentIds = [...new Set(input.documentIds ?? [])];
  for (const id of documentIds) {
    if (!library.some((document) => document.id === id && document.status !== 'WITHDRAWN')) throw new DomainError('IMS_DOCUMENT_NOT_FOUND', 'An audited document must be a current controlled document.', 404);
  }
  const projects = companyProjects(ctx);
  const projectIds = [...new Set(input.projectIds ?? [])];
  for (const id of projectIds) {
    if (!projects.some((project) => project.id === id)) throw new DomainError('IMS_PROJECT_NOT_FOUND', 'An audited project must be one of the company’s projects.', 404);
  }
  const auditor = activePeople(people).find((person) => person.id === input.leadAuditorId);
  if (!auditor) throw new DomainError('IMS_AUDITOR_NOT_FOUND', 'The lead auditor must be an active person in the company.', 422, [{ field: 'leadAuditorId', message: 'choose a person' }]);
  if (!mayRecord(auditor)) {
    throw new DomainError('IMS_AUDITOR_CANNOT_RECORD', `${auditor.name} holds no role that may record findings in the management system.`, 422, [{ field: 'leadAuditorId', message: 'an authoring role' }]);
  }
  // Objectivity and impartiality (9.2.2 c): nobody audits their own work.
  const own = library.filter((document) => {
    if (!documentIds.includes(document.id)) return false;
    const inForce = document.revisions.find((revision) => revision.status === 'EFFECTIVE');
    return document.ownerId === auditor.id || inForce?.author === auditor.id || inForce?.approvedBy === auditor.id;
  });
  if (own.length) {
    throw new DomainError('IMS_AUDITOR_NOT_INDEPENDENT', `${auditor.name} owns, drafted or approved ${own.map((document) => document.reference).join(', ')}; choose an auditor independent of the work audited.`, 422, [{ field: 'leadAuditorId', message: 'independent of the work' }]);
  }
  const audit: ImsAudit = {
    id: ulid(),
    reference: nextReference(ctx, 'ImsAudit', 'AUD'),
    title,
    standards: standards as Standard[],
    clauses,
    documentIds,
    projectIds,
    plannedOn: isoDate(input.plannedOn, 'plannedOn', 'The planned date, YYYY-MM-DD.'),
    leadAuditorId: auditor.id,
    status: 'PLANNED',
    checklist: [],
    createdBy: ctx.auth.actorId,
    createdAt: new Date().toISOString(),
  };
  write(ctx, { eventType: 'IMS_AUDIT_PLANNED', entity: { refType: 'ImsAudit', refId: audit.id }, nextState: audit as unknown as Record<string, unknown>, reason: `${audit.reference} ${title} planned for ${audit.plannedOn}, lead auditor ${auditor.name}` });
  return audit;
}

/** The questions the auditor works through. Replaces the checklist while the audit is not complete. */
export function setChecklist(ctx: EngineContext, id: string, input: { items: ChecklistItem[] }): ImsAudit {
  guard(ctx, 'U');
  const audit = auditOf(ctx, id);
  if (audit.status === 'COMPLETED' || audit.status === 'CANCELLED') throw new DomainError('IMS_AUDIT_STATE', `${audit.reference} is ${audit.status.toLowerCase()}.`, 409);
  const items = (input.items ?? []).map((item, index) => {
    const question = text(item.question, `items[${index}].question`, 5, 'Each checklist item is a question to ask or a record to see.', 1000);
    if (item.clauseId !== undefined && !audit.clauses.includes(item.clauseId)) throw new DomainError('IMS_CLAUSE_STANDARD', `${item.clauseId} is not in this audit’s scope.`, 422, [{ field: `items[${index}].clauseId`, message: 'in scope' }]);
    if (item.documentId !== undefined && !audit.documentIds.includes(item.documentId)) throw new DomainError('IMS_DOCUMENT_NOT_FOUND', 'A checklist item names a document this audit covers.', 422, [{ field: `items[${index}].documentId`, message: 'in scope' }]);
    return { ...(item.clauseId ? { clauseId: item.clauseId } : {}), ...(item.documentId ? { documentId: item.documentId } : {}), question };
  });
  if (items.length === 0 || items.length > 200) throw new DomainError('IMS_CHECKLIST', 'A checklist has between 1 and 200 items.', 422, [{ field: 'items', message: '1–200' }]);
  const next = { ...stripVersion(audit), checklist: items };
  write(ctx, { eventType: 'IMS_AUDIT_CHECKLIST_SET', entity: { refType: 'ImsAudit', refId: id }, nextState: next as unknown as Record<string, unknown>, reason: `${audit.reference} checklist: ${items.length} items` });
  return next;
}

function asLeadAuditor(ctx: EngineContext, audit: ImsAudit, act: string): void {
  if (audit.leadAuditorId !== ctx.auth.actorId) throw new DomainError('IMS_NOT_THE_AUDITOR', `Only the lead auditor of ${audit.reference} ${act}.`, 403);
}

export function startAudit(ctx: EngineContext, id: string): ImsAudit {
  guard(ctx, 'U');
  const audit = auditOf(ctx, id);
  asLeadAuditor(ctx, audit, 'starts it');
  if (audit.status !== 'PLANNED') throw new DomainError('IMS_AUDIT_STATE', `${audit.reference} is ${audit.status.toLowerCase()}.`, 409);
  const next = { ...stripVersion(audit), status: 'IN_PROGRESS' as const, startedOn: today() };
  write(ctx, { eventType: 'IMS_AUDIT_STARTED', entity: { refType: 'ImsAudit', refId: id }, nextState: next as unknown as Record<string, unknown>, reason: `${audit.reference} started` });
  return next;
}

export type FindingInput = {
  grade: string;
  clauseId: string;
  documentId?: string;
  projectId?: string;
  statement: string;
  evidence: string;
  /** For a nonconformity: who owns its corrective action, and by when. */
  actionOwnerId?: string;
  actionDueOn?: string;
};

export function recordFinding(ctx: EngineContext, auditId: string, input: FindingInput): { finding: ImsAuditFinding; actionId?: string } {
  guard(ctx, 'U');
  const audit = auditOf(ctx, auditId);
  asLeadAuditor(ctx, audit, 'records its findings');
  if (audit.status !== 'IN_PROGRESS') throw new DomainError('IMS_AUDIT_STATE', `Findings are recorded while ${audit.reference} is in progress; it is ${audit.status.toLowerCase()}.`, 409);
  if (!(FINDING_GRADES as readonly string[]).includes(input.grade)) throw new DomainError('IMS_FINDING_GRADE', `The grade is one of ${FINDING_GRADES.join(', ')}.`, 422, [{ field: 'grade', message: 'choose one' }]);
  const grade = input.grade as FindingGrade;
  if (!isClauseId(input.clauseId) || !audit.standards.includes(clauseById(input.clauseId)!.standard)) {
    throw new DomainError('IMS_CLAUSE_STANDARD', 'A finding is against a clause of the standards audited.', 422, [{ field: 'clauseId', message: 'of the audited standards' }]);
  }
  if (input.documentId && !audit.documentIds.includes(input.documentId)) throw new DomainError('IMS_DOCUMENT_NOT_FOUND', 'A finding names a document this audit covers.', 422, [{ field: 'documentId', message: 'in scope' }]);
  if (input.projectId && !audit.projectIds.includes(input.projectId)) throw new DomainError('IMS_PROJECT_NOT_FOUND', 'A finding names a project this audit covers.', 422, [{ field: 'projectId', message: 'in scope' }]);
  const nonconformity = NONCONFORMITY.includes(grade);
  if (nonconformity && (!input.actionOwnerId || !input.actionDueOn)) {
    throw new DomainError('IMS_FINDING_ACTION_REQUIRED', 'A nonconformity is carried into a corrective action: name its owner and due date.', 422, [{ field: 'actionOwnerId', message: 'owner and due date' }]);
  }
  const sequence = findings(ctx, auditId).length + 1;
  const finding: ImsAuditFinding = {
    id: ulid(),
    auditId,
    reference: `${audit.reference}-F${String(sequence).padStart(2, '0')}`,
    grade,
    clauseId: input.clauseId,
    ...(input.documentId ? { documentId: input.documentId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    statement: text(input.statement, 'statement', 10, 'State the finding against the requirement.', 4000),
    evidence: text(input.evidence, 'evidence', 5, 'Say what was seen — the record, the person, the place — that shows it.', 4000),
    raisedBy: ctx.auth.actorId,
    raisedAt: new Date().toISOString(),
  };
  write(ctx, { eventType: 'IMS_AUDIT_FINDING_RAISED', entity: { refType: 'ImsAuditFinding', refId: finding.id }, nextState: finding as unknown as Record<string, unknown>, reason: `${finding.reference} ${grade.replace('_', ' ').toLowerCase()} against ${input.clauseId}` });
  if (!nonconformity) return { finding };
  const action = raiseAction(
    ctx,
    {
      kind: 'CORRECTIVE',
      source: { kind: 'AUDIT_FINDING', refType: 'ImsAuditFinding', refId: finding.id, label: `${finding.reference} (${grade === 'MAJOR_NC' ? 'major' : 'minor'} nonconformity)` },
      standards: [clauseById(input.clauseId)!.standard],
      description: finding.statement,
      ownerId: input.actionOwnerId!,
      dueOn: input.actionDueOn!,
    },
    { eventCause: `Raised from audit finding ${finding.reference}` },
  );
  return { finding, actionId: action.id };
}

export function completeAudit(ctx: EngineContext, id: string, input: { summary: string; conclusion: string }): ImsAudit {
  guard(ctx, 'U');
  const audit = auditOf(ctx, id);
  asLeadAuditor(ctx, audit, 'completes it');
  if (audit.status !== 'IN_PROGRESS') throw new DomainError('IMS_AUDIT_STATE', `${audit.reference} is ${audit.status.toLowerCase()}; only an audit in progress is completed.`, 409);
  const next = {
    ...stripVersion(audit),
    status: 'COMPLETED' as const,
    completed: {
      on: today(),
      by: ctx.auth.actorId,
      summary: text(input.summary, 'summary', 10, 'Summarise what was audited and seen.', 8000),
      conclusion: text(input.conclusion, 'conclusion', 5, 'Conclude: is the system conforming and effectively implemented for this scope?', 4000),
    },
  };
  write(ctx, { eventType: 'IMS_AUDIT_COMPLETED', entity: { refType: 'ImsAudit', refId: id }, nextState: next as unknown as Record<string, unknown>, reason: `${audit.reference} completed: ${next.completed.conclusion.slice(0, 120)}` });
  return next;
}

export function cancelAudit(ctx: EngineContext, id: string, input: { reason: string }): ImsAudit {
  guard(ctx, 'A');
  const audit = auditOf(ctx, id);
  if (audit.status === 'COMPLETED' || audit.status === 'CANCELLED') throw new DomainError('IMS_AUDIT_STATE', `${audit.reference} is ${audit.status.toLowerCase()}.`, 409);
  if (findings(ctx, id).length) throw new DomainError('IMS_AUDIT_HAS_FINDINGS', `${audit.reference} has findings on the record; complete it instead.`, 409);
  const next = { ...stripVersion(audit), status: 'CANCELLED' as const, cancelled: { on: today(), by: ctx.auth.actorId, reason: text(input.reason, 'reason', 5, 'Say why it is cancelled and whether it is re-planned.', 1000) } };
  write(ctx, { eventType: 'IMS_AUDIT_CANCELLED', entity: { refType: 'ImsAudit', refId: id }, nextState: next as unknown as Record<string, unknown>, reason: `${audit.reference} cancelled: ${next.cancelled.reason}` });
  return next;
}

export type ClauseCoverage = { clauseId: string; standard: Standard; clause: string; title: string; lastAuditedOn: string | null; nextPlannedOn: string | null; uncovered: boolean };

/**
 * The programme: every audit with its findings and the actions they raised, and
 * clause by clause, when each was last audited and next planned. A clause of a
 * standard the company runs that was not audited in the last twelve months and
 * is not planned is uncovered.
 */
export function auditProgramme(ctx: EngineContext, people: readonly Person[]) {
  guard(ctx, 'R');
  const on = today();
  const yearAgo = addMonths(on, -12);
  const all = audits(ctx);
  const allFindings = findings(ctx);
  const allActions = actions(ctx);
  const projects = companyProjects(ctx);
  const inUse = new Set<Standard>([...documents(ctx).flatMap((document) => document.standards), ...all.flatMap((audit) => audit.standards)]);
  const coverage: ClauseCoverage[] = CLAUSES.filter((clause) => inUse.has(clause.standard)).map((clause) => {
    const done = all.filter((audit) => audit.status === 'COMPLETED' && audit.clauses.includes(clause.id)).map((audit) => audit.completed!.on).sort();
    const planned = all.filter((audit) => (audit.status === 'PLANNED' || audit.status === 'IN_PROGRESS') && audit.clauses.includes(clause.id)).map((audit) => audit.plannedOn).sort();
    const last = done.at(-1) ?? null;
    return { clauseId: clause.id, standard: clause.standard, clause: clause.clause, title: clause.title, lastAuditedOn: last, nextPlannedOn: planned[0] ?? null, uncovered: (!last || last < yearAgo) && planned.length === 0 };
  });
  return {
    audits: all
      .sort((a, b) => a.plannedOn.localeCompare(b.plannedOn))
      .map((audit) => ({
        ...audit,
        leadAuditor: nameOf(people, audit.leadAuditorId),
        overdue: audit.status === 'PLANNED' && audit.plannedOn < on,
        projects: audit.projectIds.map((id) => projects.find((project) => project.id === id)?.name ?? id),
        findings: allFindings
          .filter((finding) => finding.auditId === audit.id)
          .map((finding) => {
            const action = allActions.find((entry) => entry.source.refId === finding.id);
            return { ...finding, action: action ? { id: action.id, reference: action.reference, status: action.status } : null };
          }),
      })),
    coverage,
    projects,
  };
}
