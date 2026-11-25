import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { write, type EngineContext } from '../../engines/context.ts';
import { isRole } from '../../identity/roles.ts';
import { riddorPosition } from '../riddor.ts';
import { recordCompetency } from '../../engines/safety.ts';
import { activePeople, addDays, addMonths, guard, nameOf, optionalText, settings, states, stateOf, text, today, type Person } from './ims.ts';

/**
 * Three things the system watches across every project, which were each only
 * half there:
 *
 * - **Supplier performance** (ISO 9001 8.4, ISO 45001 8.1.4): prequalification
 *   already approves a firm; this evaluates how it actually performed — quality,
 *   health and safety, environment, programme, commercial, each 1 to 5 — on a
 *   schedule the company sets, and puts a firm whose latest average falls below
 *   the company's score to review.
 * - **The competence matrix** (7.2): which competences each role requires,
 *   against what each person in that role holds and when it expires — held,
 *   expiring, expired or missing. Holdings are the competency and training
 *   records projects already keep, matched by person and competence.
 * - **The RIDDOR clock, company-wide**: every reportable incident on every
 *   project, when its report is due and whether it was made.
 */

// =============================================================================
// Supplier performance
// =============================================================================

export const PERFORMANCE_HEADINGS = ['quality', 'safety', 'environment', 'programme', 'commercial'] as const;
export type Scores = Record<(typeof PERFORMANCE_HEADINGS)[number], number>;

export type SupplierEvaluation = {
  id: string;
  supplierId: string;
  projectId?: string;
  evaluatedOn: string;
  scores: Scores;
  average: number;
  comments: string;
  evaluatedBy: string;
};

export const supplierEvaluations = (ctx: EngineContext): SupplierEvaluation[] => states<SupplierEvaluation>(ctx, 'ImsSupplierEvaluation');

export function evaluateSupplier(ctx: EngineContext, input: { supplierId: string; projectId?: string; scores: Partial<Scores>; comments: string }): SupplierEvaluation {
  guard(ctx, 'C');
  const supplier = ctx.ledger.get({ refType: 'Supplier', refId: input.supplierId });
  if (!supplier || supplier.tenantId !== ctx.tenantId) throw new DomainError('SUPPLIER_NOT_FOUND', 'No such supplier in the company’s register.', 404);
  if (input.projectId) {
    const project = ctx.ledger.get({ refType: 'Project', refId: input.projectId });
    if (!project || project.tenantId !== ctx.tenantId) throw new DomainError('IMS_PROJECT_NOT_FOUND', 'The project must be one of the company’s.', 404);
  }
  const scores = {} as Scores;
  for (const heading of PERFORMANCE_HEADINGS) {
    const value = input.scores?.[heading];
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 5) {
      throw new DomainError('IMS_SCORE', `${heading} is scored 1 (unacceptable) to 5 (excellent).`, 422, [{ field: `scores.${heading}`, message: '1–5' }]);
    }
    scores[heading] = value as number;
  }
  const average = Math.round((PERFORMANCE_HEADINGS.reduce((sum, heading) => sum + scores[heading], 0) / PERFORMANCE_HEADINGS.length) * 10) / 10;
  const evaluation: SupplierEvaluation = {
    id: ulid(),
    supplierId: input.supplierId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    evaluatedOn: today(),
    scores,
    average,
    comments: text(input.comments, 'comments', 10, 'Say what the scores rest on — the work seen, the incidents, the NCRs, the programme.', 4000),
    evaluatedBy: ctx.auth.actorId,
  };
  write(ctx, {
    eventType: 'IMS_SUPPLIER_EVALUATED',
    entity: { refType: 'ImsSupplierEvaluation', refId: evaluation.id },
    nextState: evaluation as unknown as Record<string, unknown>,
    reason: `${String(supplier.state.legalName)} evaluated: ${average} out of 5`,
  });
  return evaluation;
}

export function supplierPerformance(ctx: EngineContext, people: readonly Person[]) {
  guard(ctx, 'R');
  const { supplierEvaluationMonths, supplierReviewBelow } = settings(ctx);
  const on = today();
  const evaluations = supplierEvaluations(ctx);
  const projectName = new Map(ctx.ledger.listByTenant(ctx.tenantId, 'Project').map((record) => [record.refId, String(record.state.name ?? record.refId)]));
  return ctx.ledger.listByTenant(ctx.tenantId, 'Supplier').map((record) => {
    const own = evaluations.filter((evaluation) => evaluation.supplierId === record.refId).sort((a, b) => a.evaluatedOn.localeCompare(b.evaluatedOn));
    const latest = own.at(-1) ?? null;
    const status = String(record.state.status ?? '');
    const nextDue = latest ? addMonths(latest.evaluatedOn, supplierEvaluationMonths) : on;
    const approved = status !== 'SUSPENDED' && status !== 'REGISTERED';
    return {
      supplierId: record.refId,
      name: String(record.state.legalName ?? record.refId),
      status,
      prequalificationExpiresOn: typeof record.state.prequalificationExpiresOn === 'string' ? record.state.prequalificationExpiresOn : null,
      evaluations: own.map((evaluation) => ({ ...evaluation, evaluator: nameOf(people, evaluation.evaluatedBy), project: evaluation.projectId ? (projectName.get(evaluation.projectId) ?? evaluation.projectId) : null })),
      latest,
      nextEvaluationDue: nextDue,
      evaluationDue: approved && nextDue <= on,
      toReview: latest !== null && latest.average < supplierReviewBelow,
    };
  });
}

// =============================================================================
// The competence matrix
// =============================================================================

export type CompetenceRequirement = { id: string; role: string; competence: string; note?: string; status: 'ACTIVE' | 'REMOVED'; setBy: string; setOn: string; removed?: { by: string; on: string; reason: string } };

export const competenceRequirements = (ctx: EngineContext): CompetenceRequirement[] => states<CompetenceRequirement>(ctx, 'ImsCompetenceRequirement');

const normal = (value: unknown) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

export function requireCompetence(ctx: EngineContext, input: { role: string; competence: string; note?: string }): CompetenceRequirement {
  guard(ctx, 'C');
  if (!isRole(input.role) || input.role === 'PLATFORM_ADMIN') throw new DomainError('IMS_DISTRIBUTION', 'Name a role in the company.', 422, [{ field: 'role', message: 'a role' }]);
  const competence = text(input.competence, 'competence', 2, 'Name the competence exactly as the certificates name it — SMSTS, CSCS, first aid at work.', 200);
  if (competenceRequirements(ctx).some((entry) => entry.status === 'ACTIVE' && entry.role === input.role && normal(entry.competence) === normal(competence))) {
    throw new DomainError('IMS_COMPETENCE_EXISTS', `${competence} is already required of ${input.role}.`, 409);
  }
  const requirement: CompetenceRequirement = { id: ulid(), role: input.role, competence, ...(optionalText(input.note, 500) ? { note: optionalText(input.note, 500)! } : {}), status: 'ACTIVE', setBy: ctx.auth.actorId, setOn: today() };
  write(ctx, { eventType: 'IMS_COMPETENCE_REQUIRED', entity: { refType: 'ImsCompetenceRequirement', refId: requirement.id }, nextState: requirement as unknown as Record<string, unknown>, reason: `${competence} required of ${input.role}` });
  return requirement;
}

export function removeCompetenceRequirement(ctx: EngineContext, id: string, input: { reason: string }): CompetenceRequirement {
  guard(ctx, 'U');
  const current = stateOf<CompetenceRequirement>(ctx, 'ImsCompetenceRequirement', id);
  if (!current) throw new DomainError('IMS_COMPETENCE_NOT_FOUND', 'No such requirement in the matrix.', 404);
  if (current.status !== 'ACTIVE') throw new DomainError('IMS_COMPETENCE_REMOVED', 'That requirement is already removed.', 409);
  const { version: _version, ...rest } = current;
  const next: CompetenceRequirement = { ...rest, status: 'REMOVED', removed: { by: ctx.auth.actorId, on: today(), reason: text(input.reason, 'reason', 5, 'Say why the role no longer needs it.', 1000) } };
  write(ctx, { eventType: 'IMS_COMPETENCE_REQUIREMENT_REMOVED', entity: { refType: 'ImsCompetenceRequirement', refId: id }, nextState: next as unknown as Record<string, unknown>, reason: `${current.competence} no longer required of ${current.role}` });
  return next;
}

/**
 * A competence a person holds, recorded at company level against their identity
 * so the matrix can read it. The same competency record a project keeps, made
 * through the same command — so the certificate is evidence, and the safety
 * permission that guards it applies here too.
 */
export function recordHolding(ctx: EngineContext, people: readonly Person[], input: { personId: string; competence: string; issuedOn: string; expiresOn: string; certificateHash: string }): { competencyId: string } {
  guard(ctx, 'R');
  const person = activePeople(people).find((entry) => entry.id === input.personId);
  if (!person) throw new DomainError('IMS_PERSON_NOT_FOUND', 'The holder must be an active person in the company.', 422, [{ field: 'personId', message: 'choose a person' }]);
  const competence = text(input.competence, 'competence', 2, 'Name the competence as the certificate names it.', 200);
  const issuedOn = String(input.issuedOn ?? '');
  const expiresOn = String(input.expiresOn ?? '');
  for (const [field, value] of [['issuedOn', issuedOn], ['expiresOn', expiresOn]] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new DomainError('IMS_DATE', 'A date, YYYY-MM-DD.', 422, [{ field, message: 'YYYY-MM-DD' }]);
  }
  if (expiresOn <= issuedOn) throw new DomainError('IMS_DATE', 'It expires after it was issued.', 422, [{ field: 'expiresOn', message: 'after the issue date' }]);
  return { competencyId: recordCompetency(ctx, { operativeId: person.id, qualification: competence, issuedAt: issuedOn, expiresAt: expiresOn, certificateHash: input.certificateHash }) };
}

export type MatrixCell = { competence: string; status: 'HELD' | 'EXPIRING' | 'EXPIRED' | 'MISSING'; expiresOn: string | null };

/** People in the roles with requirements, against what each holds. */
export function competenceMatrix(ctx: EngineContext, people: readonly Person[]) {
  guard(ctx, 'R');
  const on = today();
  const warnBy = addDays(on, settings(ctx).competenceWarningDays);
  const requirements = competenceRequirements(ctx).filter((entry) => entry.status === 'ACTIVE');
  // Every competency and training record in the company, by person and competence: the latest expiry wins.
  const held = new Map<string, string | null>();
  const keep = (person: unknown, competence: unknown, expires: unknown) => {
    const key = `${String(person)}|${normal(competence)}`;
    const expiry = typeof expires === 'string' && expires ? expires.slice(0, 10) : null;
    const previous = held.get(key);
    if (previous === undefined || (expiry === null ? true : previous !== null && expiry > previous)) held.set(key, expiry);
  };
  for (const record of ctx.ledger.listByTenant(ctx.tenantId, 'Competency')) keep(record.state.operativeId, record.state.qualification, record.state.expiresAt);
  for (const record of ctx.ledger.listByTenant(ctx.tenantId, 'TrainingRecord')) keep(record.state.personId, record.state.competency, record.state.expiresOn);
  const rows = activePeople(people)
    .map((person) => {
      const needed = requirements.filter((requirement) => person.roles.includes(requirement.role));
      const cells: MatrixCell[] = needed.map((requirement) => {
        const key = `${person.id}|${normal(requirement.competence)}`;
        if (!held.has(key)) return { competence: requirement.competence, status: 'MISSING', expiresOn: null };
        const expiry = held.get(key)!;
        return { competence: requirement.competence, status: expiry === null ? 'HELD' : expiry < on ? 'EXPIRED' : expiry <= warnBy ? 'EXPIRING' : 'HELD', expiresOn: expiry };
      });
      return { personId: person.id, name: person.name, roles: person.roles, cells, gaps: cells.filter((cell) => cell.status === 'MISSING' || cell.status === 'EXPIRED').length };
    })
    .filter((row) => row.cells.length > 0);
  return {
    requirements: competenceRequirements(ctx),
    rows,
    gaps: rows.reduce((sum, row) => sum + row.gaps, 0),
    expiring: rows.reduce((sum, row) => sum + row.cells.filter((cell) => cell.status === 'EXPIRING').length, 0),
  };
}

// =============================================================================
// The RIDDOR clock across every project
// =============================================================================

export function riddorCompany(ctx: EngineContext) {
  guard(ctx, 'R');
  const on = today();
  const projectName = new Map(ctx.ledger.listByTenant(ctx.tenantId, 'Project').map((record) => [record.refId, String(record.state.name ?? record.refId)]));
  return ctx.ledger
    .listByTenant(ctx.tenantId, 'Incident')
    .map((record) => riddorPosition({ refId: record.refId, projectId: record.projectId, state: record.state as Record<string, unknown> }, on))
    .filter((entry) => entry !== null)
    .map((entry) => ({ ...entry, project: projectName.get(entry.projectId) ?? entry.projectId }));
}

