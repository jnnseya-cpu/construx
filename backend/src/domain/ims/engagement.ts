import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { write, type EngineContext } from '../../engines/context.ts';
import { raiseAction } from './actions.ts';
import { isStandard, type Standard } from './clauses.ts';
import { addDays, guard, isoDate, nameOf, nextReference, optionalText, stateOf, states, text, today, type Person } from './ims.ts';

/**
 * The three registers the review used to minute without records:
 *
 * - **Complaints and customer satisfaction** (ISO 9001 8.2.1, 9.1.2): each
 *   complaint received, from whom, about what, the response and when, closed
 *   only once answered; and each satisfaction survey's score. A complaint can
 *   raise its corrective action, named to it.
 * - **Emergency preparedness drills** (ISO 14001 and 45001 8.2): each drill
 *   planned for a scenario, then held — who took part, how long it took, how it
 *   went, what was learned — or cancelled with the reason. A lesson can raise an
 *   improvement action.
 * - **Worker consultation and participation** (ISO 45001 5.4): what workers
 *   raised, how and where, and the answer given, with the date. Unanswered is
 *   visible as unanswered.
 *
 * Each names a project where it belongs to one, which must be the company's.
 */

const stripVersion = <T extends { version?: number }>(value: T): Omit<T, 'version'> => {
  const { version: _version, ...rest } = value;
  return rest;
};

function checkedProject(ctx: EngineContext, projectId: unknown): string | undefined {
  if (projectId === undefined || projectId === null || projectId === '') return undefined;
  const project = ctx.ledger.get({ refType: 'Project', refId: String(projectId) });
  if (!project || project.tenantId !== ctx.tenantId || project.refId.endsWith('-governance')) {
    throw new DomainError('IMS_PROJECT_NOT_FOUND', 'The project must be one of the company’s.', 404);
  }
  return project.refId;
}

function checkedStandards(value: unknown, fallback: Standard[]): Standard[] {
  const list = [...new Set(Array.isArray(value) ? value : [])].filter(isStandard) as Standard[];
  return list.length ? list : fallback;
}

// =============================================================================
// Complaints and customer satisfaction
// =============================================================================

export const COMPLAINT_CATEGORIES = ['QUALITY', 'SAFETY', 'ENVIRONMENT', 'PROGRAMME', 'SERVICE', 'OTHER'] as const;
export const CHANNELS = ['LETTER', 'EMAIL', 'TELEPHONE', 'IN_PERSON', 'PORTAL', 'OTHER'] as const;

export type ImsComplaint = {
  id: string;
  reference: string;
  receivedOn: string;
  from: string;
  projectId?: string;
  channel: (typeof CHANNELS)[number];
  category: (typeof COMPLAINT_CATEGORIES)[number];
  description: string;
  ownerId: string;
  status: 'OPEN' | 'RESPONDED' | 'CLOSED';
  response?: { on: string; by: string; text: string };
  closed?: { on: string; by: string; note: string; satisfied: boolean | null };
  actionId?: string;
  recordedBy: string;
};

export type ImsSurvey = { id: string; client: string; projectId?: string; surveyedOn: string; score: number; comments: string; recordedBy: string };

export const complaints = (ctx: EngineContext): Array<ImsComplaint & { version: number }> =>
  ctx.ledger.list(ctx.projectId, 'ImsComplaint').map((record) => ({ ...(record.state as unknown as ImsComplaint), version: record.version }));
export const surveys = (ctx: EngineContext): ImsSurvey[] => states<ImsSurvey>(ctx, 'ImsSatisfactionSurvey');

function complaintOf(ctx: EngineContext, id: string) {
  const found = stateOf<ImsComplaint>(ctx, 'ImsComplaint', id);
  if (!found) throw new DomainError('IMS_COMPLAINT_NOT_FOUND', 'No such complaint in the register.', 404);
  return found;
}

export function recordComplaint(ctx: EngineContext, input: { receivedOn: string; from: string; projectId?: string; channel: string; category: string; description: string; ownerId: string }): ImsComplaint {
  guard(ctx, 'C');
  if (!(CHANNELS as readonly string[]).includes(input.channel)) throw new DomainError('IMS_COMPLAINT_CHANNEL', `Received by ${CHANNELS.join(', ')}.`, 422, [{ field: 'channel', message: 'choose one' }]);
  if (!(COMPLAINT_CATEGORIES as readonly string[]).includes(input.category)) throw new DomainError('IMS_COMPLAINT_CATEGORY', `About ${COMPLAINT_CATEGORIES.join(', ')}.`, 422, [{ field: 'category', message: 'choose one' }]);
  const receivedOn = isoDate(input.receivedOn, 'receivedOn', 'The date it was received, YYYY-MM-DD.');
  if (receivedOn > today()) throw new DomainError('IMS_DATE', 'A complaint is recorded once it has been received.', 422, [{ field: 'receivedOn', message: 'not in the future' }]);
  const complaint: ImsComplaint = {
    id: ulid(),
    reference: nextReference(ctx, 'ImsComplaint', 'CMP'),
    receivedOn,
    from: text(input.from, 'from', 2, 'Say who complained — the client, a neighbour, a member of the public.', 200),
    ...(checkedProject(ctx, input.projectId) ? { projectId: checkedProject(ctx, input.projectId)! } : {}),
    channel: input.channel as ImsComplaint['channel'],
    category: input.category as ImsComplaint['category'],
    description: text(input.description, 'description', 10, 'Record the complaint as it was made.', 4000),
    ownerId: text(input.ownerId, 'ownerId', 1, 'Name who will respond.', 200),
    status: 'OPEN',
    recordedBy: ctx.auth.actorId,
  };
  write(ctx, { eventType: 'IMS_COMPLAINT_RECORDED', entity: { refType: 'ImsComplaint', refId: complaint.id }, nextState: complaint as unknown as Record<string, unknown>, reason: `${complaint.reference} from ${complaint.from}: ${complaint.description.slice(0, 120)}` });
  return complaint;
}

/** The response given to the complainant, with its date. */
export function respondToComplaint(ctx: EngineContext, id: string, input: { respondedOn: string; text: string }): ImsComplaint {
  guard(ctx, 'U');
  const complaint = complaintOf(ctx, id);
  if (complaint.status === 'CLOSED') throw new DomainError('IMS_COMPLAINT_CLOSED', `${complaint.reference} is closed.`, 409);
  const on = isoDate(input.respondedOn, 'respondedOn');
  if (on < complaint.receivedOn || on > today()) throw new DomainError('IMS_DATE', 'The response is dated between receipt and today.', 422, [{ field: 'respondedOn', message: 'between receipt and today' }]);
  const next: ImsComplaint = { ...stripVersion(complaint), status: 'RESPONDED', response: { on, by: ctx.auth.actorId, text: text(input.text, 'text', 10, 'Record what the complainant was told.', 4000) } };
  write(ctx, { eventType: 'IMS_COMPLAINT_RESPONDED', entity: { refType: 'ImsComplaint', refId: id }, nextState: next as unknown as Record<string, unknown>, reason: `${complaint.reference} answered on ${on}` });
  return next;
}

/** Closed only once answered; whether the complainant was satisfied is recorded if known. */
export function closeComplaint(ctx: EngineContext, id: string, input: { note: string; satisfied?: boolean | null }): ImsComplaint {
  guard(ctx, 'U');
  const complaint = complaintOf(ctx, id);
  if (complaint.status === 'CLOSED') throw new DomainError('IMS_COMPLAINT_CLOSED', `${complaint.reference} is already closed.`, 409);
  if (!complaint.response) throw new DomainError('IMS_COMPLAINT_UNANSWERED', `${complaint.reference} has not been answered; record the response first.`, 409);
  const next: ImsComplaint = {
    ...stripVersion(complaint),
    status: 'CLOSED',
    closed: { on: today(), by: ctx.auth.actorId, note: text(input.note, 'note', 5, 'Say why it can be closed.', 2000), satisfied: typeof input.satisfied === 'boolean' ? input.satisfied : null },
  };
  write(ctx, { eventType: 'IMS_COMPLAINT_CLOSED', entity: { refType: 'ImsComplaint', refId: id }, nextState: next as unknown as Record<string, unknown>, reason: `${complaint.reference} closed` });
  return next;
}

/** Raise the corrective action a complaint calls for, named to it. */
export function actionFromComplaint(ctx: EngineContext, id: string, input: { ownerId: string; dueOn: string; standards?: string[]; description?: string }): ImsComplaint {
  guard(ctx, 'C');
  const complaint = complaintOf(ctx, id);
  if (complaint.actionId) throw new DomainError('IMS_COMPLAINT_ACTIONED', `${complaint.reference} already has its action.`, 409);
  const fallback: Standard[] = complaint.category === 'ENVIRONMENT' ? ['ISO14001'] : complaint.category === 'SAFETY' ? ['ISO45001'] : ['ISO9001'];
  const action = raiseAction(
    ctx,
    {
      kind: 'CORRECTIVE',
      source: { kind: 'COMPLAINT', refType: 'ImsComplaint', refId: complaint.id, label: `${complaint.reference} from ${complaint.from}` },
      standards: checkedStandards(input.standards, fallback),
      description: optionalText(input.description, 4000) ?? complaint.description,
      ownerId: input.ownerId,
      dueOn: input.dueOn,
    },
    { eventCause: `Raised from complaint ${complaint.reference}` },
  );
  const current = complaintOf(ctx, id);
  const next: ImsComplaint = { ...stripVersion(current), actionId: action.id };
  write(ctx, { eventType: 'IMS_COMPLAINT_ACTIONED', entity: { refType: 'ImsComplaint', refId: id }, nextState: next as unknown as Record<string, unknown>, reason: `${complaint.reference}: ${action.reference} raised` });
  return next;
}

export function recordSurvey(ctx: EngineContext, input: { client: string; projectId?: string; surveyedOn: string; score: number; comments: string }): ImsSurvey {
  guard(ctx, 'C');
  if (!Number.isInteger(input.score) || input.score < 1 || input.score > 5) throw new DomainError('IMS_SCORE', 'The score is 1 (very dissatisfied) to 5 (very satisfied).', 422, [{ field: 'score', message: '1–5' }]);
  const surveyedOn = isoDate(input.surveyedOn, 'surveyedOn');
  if (surveyedOn > today()) throw new DomainError('IMS_DATE', 'A survey is recorded once it has been answered.', 422, [{ field: 'surveyedOn', message: 'not in the future' }]);
  const survey: ImsSurvey = {
    id: ulid(),
    client: text(input.client, 'client', 2, 'Name the client who answered.', 200),
    ...(checkedProject(ctx, input.projectId) ? { projectId: checkedProject(ctx, input.projectId)! } : {}),
    surveyedOn,
    score: input.score,
    comments: text(input.comments, 'comments', 3, 'Record what the client said.', 4000),
    recordedBy: ctx.auth.actorId,
  };
  write(ctx, { eventType: 'IMS_SATISFACTION_RECORDED', entity: { refType: 'ImsSatisfactionSurvey', refId: survey.id }, nextState: survey as unknown as Record<string, unknown>, reason: `${survey.client}: ${survey.score} out of 5` });
  return survey;
}

// =============================================================================
// Emergency preparedness drills
// =============================================================================

export const DRILL_SCENARIOS = ['FIRE_EVACUATION', 'SPILL', 'RESCUE_AT_HEIGHT', 'CONFINED_SPACE_RESCUE', 'MEDICAL', 'SERVICE_STRIKE', 'FLOOD', 'OTHER'] as const;

export type ImsDrill = {
  id: string;
  reference: string;
  scenario: (typeof DRILL_SCENARIOS)[number];
  description: string;
  projectId?: string;
  plannedOn: string;
  leadId: string;
  status: 'PLANNED' | 'HELD' | 'CANCELLED';
  held?: { on: string; participants: number; durationMinutes: number; outcome: 'EFFECTIVE' | 'PARTLY_EFFECTIVE' | 'NOT_EFFECTIVE'; lessons: string; recordedBy: string; actionId?: string };
  cancelled?: { on: string; by: string; reason: string };
  plannedBy: string;
};

export const drills = (ctx: EngineContext): Array<ImsDrill & { version: number }> =>
  ctx.ledger.list(ctx.projectId, 'ImsDrill').map((record) => ({ ...(record.state as unknown as ImsDrill), version: record.version }));

function drillOf(ctx: EngineContext, id: string) {
  const found = stateOf<ImsDrill>(ctx, 'ImsDrill', id);
  if (!found) throw new DomainError('IMS_DRILL_NOT_FOUND', 'No such drill.', 404);
  return found;
}

export function planDrill(ctx: EngineContext, input: { scenario: string; description: string; projectId?: string; plannedOn: string; leadId: string }): ImsDrill {
  guard(ctx, 'C');
  if (!(DRILL_SCENARIOS as readonly string[]).includes(input.scenario)) throw new DomainError('IMS_DRILL_SCENARIO', `The scenario is one of ${DRILL_SCENARIOS.join(', ')}.`, 422, [{ field: 'scenario', message: 'choose one' }]);
  const drill: ImsDrill = {
    id: ulid(),
    reference: nextReference(ctx, 'ImsDrill', 'DRL'),
    scenario: input.scenario as ImsDrill['scenario'],
    description: text(input.description, 'description', 5, 'Say what is tested — the plan, the place, the people.', 2000),
    ...(checkedProject(ctx, input.projectId) ? { projectId: checkedProject(ctx, input.projectId)! } : {}),
    plannedOn: isoDate(input.plannedOn, 'plannedOn'),
    leadId: text(input.leadId, 'leadId', 1, 'Name who leads it.', 200),
    status: 'PLANNED',
    plannedBy: ctx.auth.actorId,
  };
  write(ctx, { eventType: 'IMS_DRILL_PLANNED', entity: { refType: 'ImsDrill', refId: drill.id }, nextState: drill as unknown as Record<string, unknown>, reason: `${drill.reference} ${drill.scenario.toLowerCase().replace(/_/g, ' ')} drill planned for ${drill.plannedOn}` });
  return drill;
}

/** The drill as held. A drill not fully effective needs its lesson acted on: an owner and date raise the improvement action. */
export function recordDrill(
  ctx: EngineContext,
  id: string,
  input: { heldOn: string; participants: number; durationMinutes: number; outcome: string; lessons: string; actionOwnerId?: string; actionDueOn?: string },
): ImsDrill {
  guard(ctx, 'U');
  const drill = drillOf(ctx, id);
  if (drill.status !== 'PLANNED') throw new DomainError('IMS_DRILL_STATE', `${drill.reference} is ${drill.status.toLowerCase()}.`, 409);
  const heldOn = isoDate(input.heldOn, 'heldOn');
  if (heldOn > today()) throw new DomainError('IMS_DATE', 'A drill is recorded once it has been held.', 422, [{ field: 'heldOn', message: 'not in the future' }]);
  if (!Number.isInteger(input.participants) || input.participants < 1) throw new DomainError('IMS_DRILL_PARTICIPANTS', 'How many took part — at least one.', 422, [{ field: 'participants', message: 'whole number' }]);
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 1 || input.durationMinutes > 1440) throw new DomainError('IMS_DRILL_DURATION', 'How long it took, in minutes.', 422, [{ field: 'durationMinutes', message: 'minutes' }]);
  if (!['EFFECTIVE', 'PARTLY_EFFECTIVE', 'NOT_EFFECTIVE'].includes(input.outcome)) throw new DomainError('IMS_DRILL_OUTCOME', 'Effective, partly effective or not effective.', 422, [{ field: 'outcome', message: 'choose one' }]);
  const lessons = text(input.lessons, 'lessons', 5, 'Say what was learned, even if it went well.', 4000);
  if (input.outcome !== 'EFFECTIVE' && (!input.actionOwnerId || !input.actionDueOn)) {
    throw new DomainError('IMS_DRILL_ACTION_REQUIRED', 'A drill that was not fully effective needs its lesson acted on: name the owner and due date.', 422, [{ field: 'actionOwnerId', message: 'owner and due date' }]);
  }
  let actionId: string | undefined;
  if (input.actionOwnerId && input.actionDueOn) {
    actionId = raiseAction(
      ctx,
      {
        kind: input.outcome === 'EFFECTIVE' ? 'IMPROVEMENT' : 'CORRECTIVE',
        source: { kind: 'OTHER', label: `Emergency drill ${drill.reference} (${drill.scenario.toLowerCase().replace(/_/g, ' ')})` },
        standards: ['ISO14001', 'ISO45001'],
        description: lessons,
        ownerId: input.actionOwnerId,
        dueOn: input.actionDueOn,
      },
      { eventCause: `Raised from emergency drill ${drill.reference}` },
    ).id;
  }
  const current = drillOf(ctx, id);
  const next: ImsDrill = {
    ...stripVersion(current),
    status: 'HELD',
    held: { on: heldOn, participants: input.participants, durationMinutes: input.durationMinutes, outcome: input.outcome as NonNullable<ImsDrill['held']>['outcome'], lessons, recordedBy: ctx.auth.actorId, ...(actionId ? { actionId } : {}) },
  };
  write(ctx, { eventType: 'IMS_DRILL_HELD', entity: { refType: 'ImsDrill', refId: id }, nextState: next as unknown as Record<string, unknown>, reason: `${drill.reference} held on ${heldOn}: ${input.outcome.toLowerCase().replace('_', ' ')}` });
  return next;
}

export function cancelDrill(ctx: EngineContext, id: string, input: { reason: string }): ImsDrill {
  guard(ctx, 'U');
  const drill = drillOf(ctx, id);
  if (drill.status !== 'PLANNED') throw new DomainError('IMS_DRILL_STATE', `${drill.reference} is ${drill.status.toLowerCase()}.`, 409);
  const next: ImsDrill = { ...stripVersion(drill), status: 'CANCELLED', cancelled: { on: today(), by: ctx.auth.actorId, reason: text(input.reason, 'reason', 5, 'Say why, and when it is re-planned.', 1000) } };
  write(ctx, { eventType: 'IMS_DRILL_CANCELLED', entity: { refType: 'ImsDrill', refId: id }, nextState: next as unknown as Record<string, unknown>, reason: `${drill.reference} cancelled: ${next.cancelled!.reason}` });
  return next;
}

// =============================================================================
// Worker consultation and participation
// =============================================================================

export const CONSULTATION_METHODS = ['TOOLBOX_TALK', 'SAFETY_COMMITTEE', 'SURVEY', 'WORKER_FORUM', 'SUGGESTION', 'REPRESENTATIVE', 'OTHER'] as const;

export type ImsConsultation = {
  id: string;
  reference: string;
  on: string;
  method: (typeof CONSULTATION_METHODS)[number];
  topic: string;
  projectId?: string;
  participants: number;
  raised: string;
  status: 'OPEN' | 'ANSWERED';
  answer?: { on: string; by: string; text: string };
  recordedBy: string;
};

export const consultations = (ctx: EngineContext): Array<ImsConsultation & { version: number }> =>
  ctx.ledger.list(ctx.projectId, 'ImsConsultation').map((record) => ({ ...(record.state as unknown as ImsConsultation), version: record.version }));

export function recordConsultation(ctx: EngineContext, input: { on: string; method: string; topic: string; projectId?: string; participants: number; raised: string }): ImsConsultation {
  guard(ctx, 'C');
  if (!(CONSULTATION_METHODS as readonly string[]).includes(input.method)) throw new DomainError('IMS_CONSULTATION_METHOD', `How: ${CONSULTATION_METHODS.join(', ')}.`, 422, [{ field: 'method', message: 'choose one' }]);
  const on = isoDate(input.on, 'on');
  if (on > today()) throw new DomainError('IMS_DATE', 'A consultation is recorded once it has happened.', 422, [{ field: 'on', message: 'not in the future' }]);
  if (!Number.isInteger(input.participants) || input.participants < 1) throw new DomainError('IMS_CONSULTATION_PARTICIPANTS', 'How many workers took part — at least one.', 422, [{ field: 'participants', message: 'whole number' }]);
  const entry: ImsConsultation = {
    id: ulid(),
    reference: nextReference(ctx, 'ImsConsultation', 'CON'),
    on,
    method: input.method as ImsConsultation['method'],
    topic: text(input.topic, 'topic', 3, 'Say what it was about.', 300),
    ...(checkedProject(ctx, input.projectId) ? { projectId: checkedProject(ctx, input.projectId)! } : {}),
    participants: input.participants,
    raised: text(input.raised, 'raised', 5, 'Record what the workers raised, in their words.', 4000),
    status: 'OPEN',
    recordedBy: ctx.auth.actorId,
  };
  write(ctx, { eventType: 'IMS_CONSULTATION_RECORDED', entity: { refType: 'ImsConsultation', refId: entry.id }, nextState: entry as unknown as Record<string, unknown>, reason: `${entry.reference} ${entry.topic}` });
  return entry;
}

export function answerConsultation(ctx: EngineContext, id: string, input: { answeredOn: string; text: string }): ImsConsultation {
  guard(ctx, 'U');
  const found = stateOf<ImsConsultation>(ctx, 'ImsConsultation', id);
  if (!found) throw new DomainError('IMS_CONSULTATION_NOT_FOUND', 'No such consultation.', 404);
  if (found.status === 'ANSWERED') throw new DomainError('IMS_CONSULTATION_ANSWERED', `${found.reference} is already answered.`, 409);
  const on = isoDate(input.answeredOn, 'answeredOn');
  if (on < found.on || on > today()) throw new DomainError('IMS_DATE', 'The answer is dated between the consultation and today.', 422, [{ field: 'answeredOn', message: 'between the consultation and today' }]);
  const next: ImsConsultation = { ...stripVersion(found), status: 'ANSWERED', answer: { on, by: ctx.auth.actorId, text: text(input.text, 'text', 10, 'Record what the workers were told and what was done.', 4000) } };
  write(ctx, { eventType: 'IMS_CONSULTATION_ANSWERED', entity: { refType: 'ImsConsultation', refId: id }, nextState: next as unknown as Record<string, unknown>, reason: `${found.reference} answered on ${on}` });
  return next;
}

// =============================================================================
// As the screen reads them
// =============================================================================

/** Days after receipt a complaint waits for its answer before it is shown as late. */
const COMPLAINT_ANSWER_DAYS = 14;

export function engagementPosition(ctx: EngineContext, people: readonly Person[]) {
  guard(ctx, 'R');
  const on = today();
  const projectName = new Map(ctx.ledger.listByTenant(ctx.tenantId, 'Project').map((record) => [record.refId, String(record.state.name ?? record.refId)]));
  const project = (id?: string) => (id ? (projectName.get(id) ?? id) : null);
  const allSurveys = surveys(ctx).sort((a, b) => b.surveyedOn.localeCompare(a.surveyedOn));
  return {
    complaints: complaints(ctx).map((entry) => ({ ...entry, owner: nameOf(people, entry.ownerId), project: project(entry.projectId), late: entry.status === 'OPEN' && addDays(entry.receivedOn, COMPLAINT_ANSWER_DAYS) < on })),
    surveys: allSurveys.map((entry) => ({ ...entry, project: project(entry.projectId) })),
    averageSatisfaction: allSurveys.length ? Math.round((allSurveys.reduce((sum, entry) => sum + entry.score, 0) / allSurveys.length) * 10) / 10 : null,
    drills: drills(ctx).map((entry) => ({ ...entry, lead: nameOf(people, entry.leadId), project: project(entry.projectId), overdue: entry.status === 'PLANNED' && entry.plannedOn < on })),
    consultations: consultations(ctx).map((entry) => ({ ...entry, project: project(entry.projectId) })),
    answerDays: COMPLAINT_ANSWER_DAYS,
    vocabulary: { complaintCategories: COMPLAINT_CATEGORIES, channels: CHANNELS, drillScenarios: DRILL_SCENARIOS, consultationMethods: CONSULTATION_METHODS },
  };
}
