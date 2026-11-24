import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { write, type EngineContext } from '../../engines/context.ts';
import { raiseAction } from './actions.ts';
import { isStandard, type Standard } from './clauses.ts';
import { documents } from './documents.ts';
import { addMonths, guard, isoDate, nameOf, nextReference, optionalText, settings, stateOf, text, today, type Person } from './ims.ts';
import { legislationByKey } from './legislation.ts';

/**
 * The registers the standards ask a company to keep, and its objectives:
 *
 * - **Environmental aspects and impacts** (ISO 14001 6.1.2): each activity's
 *   aspect, the impact it can have, under normal, abnormal or emergency
 *   conditions, scored severity × likelihood; significant when the score meets
 *   the company's own threshold or a legal requirement drives it.
 * - **Legal and other requirements** (ISO 14001 6.1.3, ISO 45001 6.1.3): what
 *   applies, how, and how the company complies; evaluated on a schedule
 *   (9.1.2), and an evaluation that finds it not fully compliant raises a
 *   corrective action there and then.
 * - **Objectives** (6.2 of all three): what will be achieved, how it is measured,
 *   the target, who, by when; progress recorded, and closed achieved or not.
 */

const stripVersion = <T extends { version?: number }>(value: T): Omit<T, 'version'> => {
  const { version: _version, ...rest } = value;
  return rest;
};

function score(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 5) {
    throw new DomainError('IMS_SCORE', `${field} is a whole number from 1 to 5.`, 422, [{ field, message: '1–5' }]);
  }
  return value as number;
}

function checkedDocuments(ctx: EngineContext, ids: unknown): string[] {
  const list = [...new Set(Array.isArray(ids) ? ids.map(String) : [])];
  const library = documents(ctx);
  for (const id of list) {
    if (!library.some((document) => document.id === id && document.status !== 'WITHDRAWN')) throw new DomainError('IMS_DOCUMENT_NOT_FOUND', 'A linked document must be a current controlled document.', 404);
  }
  return list;
}

// =============================================================================
// Environmental aspects and impacts
// =============================================================================

export const CONDITIONS = ['NORMAL', 'ABNORMAL', 'EMERGENCY'] as const;

export type ImsAspect = {
  id: string;
  reference: string;
  activity: string;
  aspect: string;
  impact: string;
  condition: (typeof CONDITIONS)[number];
  severity: number;
  likelihood: number;
  legalDriver: boolean;
  controls: string;
  documentIds: string[];
  status: 'ACTIVE' | 'RETIRED';
  assessedBy: string;
  assessedOn: string;
  retired?: { by: string; on: string; reason: string };
  draftedByAgent?: boolean;
};

export type AspectInput = { activity: string; aspect: string; impact: string; condition: string; severity: number; likelihood: number; legalDriver?: boolean; controls: string; documentIds?: string[] };

export const aspects = (ctx: EngineContext): Array<ImsAspect & { version: number }> =>
  ctx.ledger.list(ctx.projectId, 'ImsAspect').map((record) => ({ ...(record.state as unknown as ImsAspect), version: record.version }));

function aspectOf(ctx: EngineContext, id: string): ImsAspect & { version: number } {
  const found = stateOf<ImsAspect>(ctx, 'ImsAspect', id);
  if (!found) throw new DomainError('IMS_ASPECT_NOT_FOUND', 'No such aspect in the register.', 404);
  return found;
}

function checkedAspect(ctx: EngineContext, input: AspectInput) {
  if (!(CONDITIONS as readonly string[]).includes(input.condition)) throw new DomainError('IMS_ASPECT_CONDITION', 'The condition is normal, abnormal or emergency.', 422, [{ field: 'condition', message: 'choose one' }]);
  return {
    activity: text(input.activity, 'activity', 3, 'Name the activity — what the company does that has the aspect.', 300),
    aspect: text(input.aspect, 'aspect', 3, 'Name the aspect — the element of the activity that can interact with the environment.', 300),
    impact: text(input.impact, 'impact', 3, 'Name the impact — the change to the environment it can cause.', 500),
    condition: input.condition as ImsAspect['condition'],
    severity: score(input.severity, 'severity'),
    likelihood: score(input.likelihood, 'likelihood'),
    legalDriver: input.legalDriver === true,
    controls: text(input.controls, 'controls', 5, 'Say how it is controlled — the procedure, the plan, the equipment.', 2000),
    documentIds: checkedDocuments(ctx, input.documentIds),
  };
}

export function recordAspect(ctx: EngineContext, input: AspectInput, options: { draftedByAgent?: boolean } = {}): ImsAspect {
  guard(ctx, 'C');
  const aspect: ImsAspect = {
    id: ulid(),
    reference: nextReference(ctx, 'ImsAspect', 'ENV'),
    ...checkedAspect(ctx, input),
    status: 'ACTIVE',
    assessedBy: ctx.auth.actorId,
    assessedOn: today(),
    ...(options.draftedByAgent ? { draftedByAgent: true } : {}),
  };
  write(ctx, { eventType: 'IMS_ASPECT_RECORDED', entity: { refType: 'ImsAspect', refId: aspect.id }, nextState: aspect as unknown as Record<string, unknown>, reason: `${aspect.reference} ${aspect.activity}: ${aspect.aspect}` });
  return aspect;
}

export function reviseAspect(ctx: EngineContext, id: string, input: AspectInput): ImsAspect {
  guard(ctx, 'U');
  const current = aspectOf(ctx, id);
  if (current.status !== 'ACTIVE') throw new DomainError('IMS_ASPECT_RETIRED', `${current.reference} is retired.`, 409);
  const next: ImsAspect = { ...stripVersion(current), ...checkedAspect(ctx, input), assessedBy: ctx.auth.actorId, assessedOn: today() };
  write(ctx, { eventType: 'IMS_ASPECT_REVISED', entity: { refType: 'ImsAspect', refId: id }, nextState: next as unknown as Record<string, unknown>, reason: `${current.reference} reassessed` });
  return next;
}

export function retireAspect(ctx: EngineContext, id: string, input: { reason: string }): ImsAspect {
  guard(ctx, 'U');
  const current = aspectOf(ctx, id);
  if (current.status !== 'ACTIVE') throw new DomainError('IMS_ASPECT_RETIRED', `${current.reference} is already retired.`, 409);
  const next: ImsAspect = { ...stripVersion(current), status: 'RETIRED', retired: { by: ctx.auth.actorId, on: today(), reason: text(input.reason, 'reason', 5, 'Say why it no longer applies.', 1000) } };
  write(ctx, { eventType: 'IMS_ASPECT_RETIRED', entity: { refType: 'ImsAspect', refId: id }, nextState: next as unknown as Record<string, unknown>, reason: `${current.reference} retired: ${next.retired!.reason}` });
  return next;
}

// =============================================================================
// Legal and other requirements
// =============================================================================

export const EVALUATION_RESULTS = ['COMPLIANT', 'PARTIAL', 'NON_COMPLIANT'] as const;

export type ImsObligation = {
  id: string;
  reference: string;
  standards: Standard[];
  catalogueKey?: string;
  title: string;
  extent: string;
  requirement: string;
  applicability: string;
  howComplied: string;
  documentIds: string[];
  evaluationMonths: number;
  evaluations: Array<{ on: string; by: string; result: (typeof EVALUATION_RESULTS)[number]; note: string; actionId?: string }>;
  nextEvaluationDue: string;
  status: 'ACTIVE' | 'WITHDRAWN';
  withdrawn?: { by: string; on: string; reason: string };
  recordedBy: string;
  recordedOn: string;
  draftedByAgent?: boolean;
};

export type ObligationInput = {
  standards?: string[];
  catalogueKey?: string;
  title?: string;
  extent?: string;
  requirement: string;
  applicability: string;
  howComplied: string;
  documentIds?: string[];
  evaluationMonths?: number;
};

export const obligations = (ctx: EngineContext): Array<ImsObligation & { version: number }> =>
  ctx.ledger.list(ctx.projectId, 'ImsObligation').map((record) => ({ ...(record.state as unknown as ImsObligation), version: record.version }));

function obligationOf(ctx: EngineContext, id: string): ImsObligation & { version: number } {
  const found = stateOf<ImsObligation>(ctx, 'ImsObligation', id);
  if (!found) throw new DomainError('IMS_OBLIGATION_NOT_FOUND', 'No such entry in the legal register.', 404);
  return found;
}

export function recordObligation(ctx: EngineContext, input: ObligationInput, options: { draftedByAgent?: boolean } = {}): ImsObligation {
  guard(ctx, 'C');
  const listed = input.catalogueKey ? legislationByKey(input.catalogueKey) : undefined;
  if (input.catalogueKey && !listed) throw new DomainError('IMS_LEGISLATION_UNKNOWN', 'Not an entry of the legislation list; enter its title instead.', 422, [{ field: 'catalogueKey', message: 'from the list' }]);
  // An entry from the list carries the standards it is a requirement under, unless the company says otherwise.
  const standards = [...new Set(input.standards?.length ? input.standards : (listed?.standards ?? []))];
  if (standards.length === 0 || !standards.every(isStandard)) throw new DomainError('IMS_STANDARDS', 'Name the standards it is a requirement under.', 422, [{ field: 'standards', message: 'one or more' }]);
  const title = listed ? listed.title : text(input.title, 'title', 5, 'Give the title of the Act, regulation, permit or other requirement.', 300);
  if (obligations(ctx).some((entry) => entry.status === 'ACTIVE' && entry.title === title)) {
    throw new DomainError('IMS_OBLIGATION_EXISTS', `${title} is already in the register; evaluate or revise that entry.`, 409);
  }
  const months = input.evaluationMonths ?? 12;
  if (!Number.isInteger(months) || months < 1 || months > 36) throw new DomainError('IMS_EVALUATION_INTERVAL', 'Evaluate compliance every 1 to 36 months.', 422, [{ field: 'evaluationMonths', message: '1–36' }]);
  const on = today();
  const obligation: ImsObligation = {
    id: ulid(),
    reference: nextReference(ctx, 'ImsObligation', 'LEG'),
    standards: standards as Standard[],
    ...(listed ? { catalogueKey: listed.key } : {}),
    title,
    extent: listed ? listed.extent : (optionalText(input.extent, 100) ?? 'Not stated'),
    requirement: text(input.requirement, 'requirement', 10, 'Say what it requires of the company, in your own words.', 2000),
    applicability: text(input.applicability, 'applicability', 10, 'Say how it applies to the company’s activities.', 2000),
    howComplied: text(input.howComplied, 'howComplied', 10, 'Say how the company complies — the procedure, the permit, the record.', 2000),
    documentIds: checkedDocuments(ctx, input.documentIds),
    evaluationMonths: months,
    evaluations: [],
    // Due straight away: an entry nobody has evaluated has not been shown to be complied with.
    nextEvaluationDue: on,
    status: 'ACTIVE',
    recordedBy: ctx.auth.actorId,
    recordedOn: on,
    ...(options.draftedByAgent ? { draftedByAgent: true } : {}),
  };
  write(ctx, { eventType: 'IMS_OBLIGATION_RECORDED', entity: { refType: 'ImsObligation', refId: obligation.id }, nextState: obligation as unknown as Record<string, unknown>, reason: `${obligation.reference} ${title}` });
  return obligation;
}

/** Evaluate compliance. Anything short of compliant raises a corrective action, with its owner and due date. */
export function evaluateObligation(ctx: EngineContext, id: string, input: { result: string; note: string; actionOwnerId?: string; actionDueOn?: string }): ImsObligation {
  guard(ctx, 'U');
  const obligation = obligationOf(ctx, id);
  if (obligation.status !== 'ACTIVE') throw new DomainError('IMS_OBLIGATION_WITHDRAWN', `${obligation.reference} is withdrawn.`, 409);
  if (!(EVALUATION_RESULTS as readonly string[]).includes(input.result)) throw new DomainError('IMS_EVALUATION_RESULT', 'Compliant, partial or non-compliant.', 422, [{ field: 'result', message: 'choose one' }]);
  const result = input.result as ImsObligation['evaluations'][number]['result'];
  const note = text(input.note, 'note', 10, 'Say what was checked — the permit, the records, the site — and what was found.', 4000);
  if (result !== 'COMPLIANT' && (!input.actionOwnerId || !input.actionDueOn)) {
    throw new DomainError('IMS_EVALUATION_ACTION_REQUIRED', 'A requirement not fully complied with raises a corrective action: name its owner and due date.', 422, [{ field: 'actionOwnerId', message: 'owner and due date' }]);
  }
  const on = today();
  let actionId: string | undefined;
  if (result !== 'COMPLIANT') {
    actionId = raiseAction(
      ctx,
      {
        kind: 'CORRECTIVE',
        source: { kind: 'OBLIGATION', refType: 'ImsObligation', refId: obligation.id, label: `${obligation.reference} ${obligation.title} (${result === 'PARTIAL' ? 'partly compliant' : 'not compliant'})` },
        standards: obligation.standards,
        description: note,
        ownerId: input.actionOwnerId!,
        dueOn: input.actionDueOn!,
      },
      { eventCause: `Raised from the compliance evaluation of ${obligation.reference}` },
    ).id;
  }
  const current = obligationOf(ctx, id);
  const next: ImsObligation = {
    ...stripVersion(current),
    evaluations: [...current.evaluations, { on, by: ctx.auth.actorId, result, note, ...(actionId ? { actionId } : {}) }],
    nextEvaluationDue: addMonths(on, current.evaluationMonths),
  };
  write(ctx, { eventType: 'IMS_OBLIGATION_EVALUATED', entity: { refType: 'ImsObligation', refId: id }, nextState: next as unknown as Record<string, unknown>, reason: `${obligation.reference} evaluated: ${result.toLowerCase().replace('_', ' ')}` });
  return next;
}

export function withdrawObligation(ctx: EngineContext, id: string, input: { reason: string }): ImsObligation {
  guard(ctx, 'U');
  const obligation = obligationOf(ctx, id);
  if (obligation.status !== 'ACTIVE') throw new DomainError('IMS_OBLIGATION_WITHDRAWN', `${obligation.reference} is already withdrawn.`, 409);
  const next: ImsObligation = { ...stripVersion(obligation), status: 'WITHDRAWN', withdrawn: { by: ctx.auth.actorId, on: today(), reason: text(input.reason, 'reason', 5, 'Say why it no longer applies.', 1000) } };
  write(ctx, { eventType: 'IMS_OBLIGATION_WITHDRAWN', entity: { refType: 'ImsObligation', refId: id }, nextState: next as unknown as Record<string, unknown>, reason: `${obligation.reference} withdrawn: ${next.withdrawn!.reason}` });
  return next;
}

// =============================================================================
// Objectives
// =============================================================================

export type ImsObjective = {
  id: string;
  reference: string;
  standard: Standard;
  objective: string;
  measure: string;
  target: string;
  baseline?: string;
  resources?: string;
  ownerId: string;
  dueOn: string;
  progress: Array<{ on: string; by: string; value: string; note: string }>;
  status: 'OPEN' | 'ACHIEVED' | 'NOT_ACHIEVED';
  closed?: { on: string; by: string; note: string };
  setBy: string;
  setOn: string;
  draftedByAgent?: boolean;
};

export type ObjectiveInput = { standard: string; objective: string; measure: string; target: string; baseline?: string; resources?: string; ownerId: string; dueOn: string };

export const objectives = (ctx: EngineContext): Array<ImsObjective & { version: number }> =>
  ctx.ledger.list(ctx.projectId, 'ImsObjective').map((record) => ({ ...(record.state as unknown as ImsObjective), version: record.version }));

function objectiveOf(ctx: EngineContext, id: string): ImsObjective & { version: number } {
  const found = stateOf<ImsObjective>(ctx, 'ImsObjective', id);
  if (!found) throw new DomainError('IMS_OBJECTIVE_NOT_FOUND', 'No such objective.', 404);
  return found;
}

export function setObjective(ctx: EngineContext, input: ObjectiveInput, options: { draftedByAgent?: boolean } = {}): ImsObjective {
  guard(ctx, 'C');
  if (!isStandard(input.standard)) throw new DomainError('IMS_STANDARDS', 'Name the standard it is an objective under.', 422, [{ field: 'standard', message: 'choose one' }]);
  const objective: ImsObjective = {
    id: ulid(),
    reference: nextReference(ctx, 'ImsObjective', 'OBJ'),
    standard: input.standard,
    objective: text(input.objective, 'objective', 10, 'State the objective — what will be achieved.', 1000),
    measure: text(input.measure, 'measure', 5, 'Say how it is measured.', 500),
    target: text(input.target, 'target', 1, 'State the target value.', 200),
    ...(optionalText(input.baseline, 200) ? { baseline: optionalText(input.baseline, 200)! } : {}),
    ...(optionalText(input.resources, 1000) ? { resources: optionalText(input.resources, 1000)! } : {}),
    ownerId: text(input.ownerId, 'ownerId', 1, 'Name who is responsible.', 200),
    dueOn: isoDate(input.dueOn, 'dueOn', 'When it is to be achieved, YYYY-MM-DD.'),
    progress: [],
    status: 'OPEN',
    setBy: ctx.auth.actorId,
    setOn: today(),
    ...(options.draftedByAgent ? { draftedByAgent: true } : {}),
  };
  write(ctx, { eventType: 'IMS_OBJECTIVE_SET', entity: { refType: 'ImsObjective', refId: objective.id }, nextState: objective as unknown as Record<string, unknown>, reason: `${objective.reference} ${objective.objective.slice(0, 120)}` });
  return objective;
}

export function recordProgress(ctx: EngineContext, id: string, input: { value: string; note: string }): ImsObjective {
  guard(ctx, 'U');
  const objective = objectiveOf(ctx, id);
  if (objective.status !== 'OPEN') throw new DomainError('IMS_OBJECTIVE_CLOSED', `${objective.reference} is closed.`, 409);
  const next: ImsObjective = {
    ...stripVersion(objective),
    progress: [...objective.progress, { on: today(), by: ctx.auth.actorId, value: text(input.value, 'value', 1, 'Give the measured value.', 200), note: text(input.note, 'note', 3, 'Say where the figure comes from.', 1000) }],
  };
  write(ctx, { eventType: 'IMS_OBJECTIVE_PROGRESS_RECORDED', entity: { refType: 'ImsObjective', refId: id }, nextState: next as unknown as Record<string, unknown>, reason: `${objective.reference} progress: ${input.value}` });
  return next;
}

export function closeObjective(ctx: EngineContext, id: string, input: { achieved: boolean; note: string }): ImsObjective {
  guard(ctx, 'A');
  const objective = objectiveOf(ctx, id);
  if (objective.status !== 'OPEN') throw new DomainError('IMS_OBJECTIVE_CLOSED', `${objective.reference} is already closed.`, 409);
  if (typeof input.achieved !== 'boolean') throw new DomainError('IMS_OBJECTIVE_OUTCOME', 'Say whether it was achieved.', 422, [{ field: 'achieved', message: 'yes or no' }]);
  const next: ImsObjective = { ...stripVersion(objective), status: input.achieved ? 'ACHIEVED' : 'NOT_ACHIEVED', closed: { on: today(), by: ctx.auth.actorId, note: text(input.note, 'note', 5, 'Say what the final figure was and what is learned.', 2000) } };
  write(ctx, { eventType: 'IMS_OBJECTIVE_CLOSED', entity: { refType: 'ImsObjective', refId: id }, nextState: next as unknown as Record<string, unknown>, reason: `${objective.reference} ${input.achieved ? 'achieved' : 'not achieved'}` });
  return next;
}

// =============================================================================
// The registers as the screen reads them
// =============================================================================

export function registersPosition(ctx: EngineContext, people: readonly Person[]) {
  guard(ctx, 'R');
  const threshold = settings(ctx).aspectSignificanceThreshold;
  const on = today();
  return {
    aspects: aspects(ctx).map((aspect) => {
      const value = aspect.severity * aspect.likelihood;
      return { ...aspect, score: value, significant: aspect.status === 'ACTIVE' && (value >= threshold || aspect.legalDriver), assessor: nameOf(people, aspect.assessedBy) };
    }),
    obligations: obligations(ctx).map((obligation) => ({
      ...obligation,
      lastResult: obligation.evaluations.at(-1)?.result ?? null,
      evaluationDue: obligation.status === 'ACTIVE' && obligation.nextEvaluationDue <= on,
    })),
    objectives: objectives(ctx).map((objective) => ({ ...objective, owner: nameOf(people, objective.ownerId), overdue: objective.status === 'OPEN' && objective.dueOn < on, latest: objective.progress.at(-1) ?? null })),
    threshold,
  };
}
