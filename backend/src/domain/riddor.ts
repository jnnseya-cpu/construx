import { DomainError } from '../core/errors.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';

/**
 * The RIDDOR clock: once an incident is reportable, what kind of report it is,
 * the date the report to the enforcing authority is due, and the record of the
 * report made.
 *
 * Recording an incident already forces the reportable / not reportable answer
 * (`recordIncident` refuses it unanswered). What it did not hold is the kind of
 * report, so it could not say **when** the report was due, nor that it was ever
 * made. The deadlines are those of the Reporting of Injuries, Diseases and
 * Dangerous Occurrences Regulations 2013 as the HSE publishes them:
 *
 * - a death, a specified injury, an injury to somebody not at work who is taken
 *   to hospital, and a dangerous occurrence: notify without delay, and report
 *   within 10 days of the incident;
 * - an over-seven-day incapacitation of a worker: report within 15 days of the
 *   incident;
 * - a reportable occupational disease: report without delay once the diagnosis
 *   is received — due on the date of diagnosis.
 *
 * Reporting by telephone is accepted for deaths and specified injuries only;
 * everything can be reported online. A report made after its due date is still
 * recorded — it must be — but as late, with the reason.
 *
 * The classification is a competent person's judgement, recorded, never
 * inferred: the platform does not guess which category an injury falls in.
 */

export const RIDDOR_KINDS = {
  DEATH: { label: 'Death', withinDays: 10, notifyWithoutDelay: true, telephone: true },
  SPECIFIED_INJURY: { label: 'Specified injury to a worker', withinDays: 10, notifyWithoutDelay: true, telephone: true },
  NON_WORKER_HOSPITAL: { label: 'Injury to somebody not at work, taken to hospital', withinDays: 10, notifyWithoutDelay: true, telephone: false },
  OVER_SEVEN_DAY: { label: 'Over-seven-day incapacitation of a worker', withinDays: 15, notifyWithoutDelay: false, telephone: false },
  DANGEROUS_OCCURRENCE: { label: 'Dangerous occurrence', withinDays: 10, notifyWithoutDelay: true, telephone: false },
  OCCUPATIONAL_DISEASE: { label: 'Reportable occupational disease', withinDays: 0, notifyWithoutDelay: true, telephone: false },
} as const;
export type RiddorKind = keyof typeof RIDDOR_KINDS;
export const RIDDOR_METHODS = ['ONLINE', 'TELEPHONE'] as const;

export type RiddorRecord = {
  kind: RiddorKind;
  /** For a disease: the date the diagnosis was received, from which the report is due. */
  diagnosedOn?: string;
  dueOn: string;
  note: string;
  classifiedBy: string;
  classifiedAt: string;
  report?: { reportedOn: string; hseReference: string; method: (typeof RIDDOR_METHODS)[number]; late: boolean; lateReason?: string; reportedBy: string; recordedAt: string };
};

const dateOnly = (value: unknown): string => String(value ?? '').slice(0, 10);
const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const isDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

/** When the report is due, for a classification of an incident that occurred on `occurredOn`. */
export function riddorDueOn(kind: RiddorKind, occurredOn: string, diagnosedOn?: string): string {
  return kind === 'OCCUPATIONAL_DISEASE' ? diagnosedOn! : addDays(occurredOn, RIDDOR_KINDS[kind].withinDays);
}

function incidentOf(ctx: EngineContext, incidentId: string) {
  const record = ctx.ledger.get({ refType: 'Incident', refId: incidentId });
  if (!record || record.projectId !== ctx.projectId) throw new DomainError('INCIDENT_NOT_FOUND', 'No such incident on this project.', 404);
  return record;
}

export function classifyRiddor(ctx: EngineContext, incidentId: string, input: { kind: string; diagnosedOn?: string; note: string }): RiddorRecord {
  authorise(ctx, 'SAFETY_RAMS', 'U');
  const record = incidentOf(ctx, incidentId);
  const state = record.state as Record<string, unknown>;
  if ((state.riddor as RiddorRecord | undefined)?.report) {
    throw new DomainError('RIDDOR_ALREADY_REPORTED', 'The report has been made; its classification is part of the record and is not changed afterwards.', 409);
  }
  if (!(input.kind in RIDDOR_KINDS)) throw new DomainError('RIDDOR_KIND', `The kind of report is one of ${Object.keys(RIDDOR_KINDS).join(', ')}.`, 422, [{ field: 'kind', message: 'choose one' }]);
  const kind = input.kind as RiddorKind;
  const occurredOn = dateOnly(state.occurredAt);
  if (kind === 'OCCUPATIONAL_DISEASE' && !isDate(input.diagnosedOn)) {
    throw new DomainError('RIDDOR_DIAGNOSIS_DATE', 'A disease is reported from the date the diagnosis is received: give that date.', 422, [{ field: 'diagnosedOn', message: 'YYYY-MM-DD' }]);
  }
  const note = String(input.note ?? '').trim();
  if (note.length < 10) throw new DomainError('RIDDOR_BASIS', 'Say why it falls in this category — the injury, the absence, the occurrence — as the competent person judged it.', 422, [{ field: 'note', message: 'the basis' }]);
  const riddor: RiddorRecord = {
    kind,
    ...(kind === 'OCCUPATIONAL_DISEASE' ? { diagnosedOn: input.diagnosedOn } : {}),
    dueOn: riddorDueOn(kind, occurredOn, input.diagnosedOn),
    note: note.slice(0, 2000),
    classifiedBy: ctx.auth.actorId,
    classifiedAt: new Date().toISOString(),
  };
  write(ctx, {
    eventType: 'INCIDENT_RIDDOR_CLASSIFIED',
    entity: { refType: 'Incident', refId: incidentId },
    nextState: { ...state, riddorReportable: true, riddor },
    reason: `${String(state.reference)} reportable under RIDDOR as ${RIDDOR_KINDS[kind].label.toLowerCase()}; report due ${riddor.dueOn}`,
  });
  return riddor;
}

export function recordRiddorReport(ctx: EngineContext, incidentId: string, input: { reportedOn: string; hseReference: string; method: string; lateReason?: string }): RiddorRecord {
  authorise(ctx, 'SAFETY_RAMS', 'U');
  const record = incidentOf(ctx, incidentId);
  const state = record.state as Record<string, unknown>;
  const riddor = state.riddor as RiddorRecord | undefined;
  if (!riddor) throw new DomainError('RIDDOR_NOT_CLASSIFIED', 'Classify the report first, so its due date is on the record.', 409);
  if (riddor.report) throw new DomainError('RIDDOR_ALREADY_REPORTED', 'The report to the enforcing authority is already recorded.', 409);
  if (!isDate(input.reportedOn)) throw new DomainError('RIDDOR_REPORTED_ON', 'The date the report was made, YYYY-MM-DD.', 422, [{ field: 'reportedOn', message: 'YYYY-MM-DD' }]);
  const today = new Date().toISOString().slice(0, 10);
  if (input.reportedOn > today) throw new DomainError('RIDDOR_REPORTED_ON', 'A report is recorded once it has been made.', 422, [{ field: 'reportedOn', message: 'not in the future' }]);
  if (input.reportedOn < dateOnly(state.occurredAt)) throw new DomainError('RIDDOR_REPORTED_ON', 'A report cannot precede the incident.', 422, [{ field: 'reportedOn', message: 'on or after the incident' }]);
  if (!(RIDDOR_METHODS as readonly string[]).includes(input.method)) throw new DomainError('RIDDOR_METHOD', 'Online or by telephone.', 422, [{ field: 'method', message: 'choose one' }]);
  if (input.method === 'TELEPHONE' && !RIDDOR_KINDS[riddor.kind].telephone) {
    throw new DomainError('RIDDOR_METHOD', 'The telephone service takes deaths and specified injuries only; this report is made online.', 422, [{ field: 'method', message: 'online' }]);
  }
  const hseReference = String(input.hseReference ?? '').trim();
  if (hseReference.length < 3) throw new DomainError('RIDDOR_REFERENCE', 'Give the reference the enforcing authority issued for the report.', 422, [{ field: 'hseReference', message: 'the reference' }]);
  const late = input.reportedOn > riddor.dueOn;
  const lateReason = String(input.lateReason ?? '').trim();
  if (late && lateReason.length < 10) {
    throw new DomainError('RIDDOR_LATE_REASON', `The report was due by ${riddor.dueOn}; it is recorded as late, with the reason.`, 422, [{ field: 'lateReason', message: 'why it was late' }]);
  }
  const next: RiddorRecord = {
    ...riddor,
    report: {
      reportedOn: input.reportedOn,
      hseReference: hseReference.slice(0, 100),
      method: input.method as (typeof RIDDOR_METHODS)[number],
      late,
      ...(late ? { lateReason: lateReason.slice(0, 2000) } : {}),
      reportedBy: ctx.auth.actorId,
      recordedAt: new Date().toISOString(),
    },
  };
  write(ctx, {
    eventType: 'INCIDENT_RIDDOR_REPORTED',
    entity: { refType: 'Incident', refId: incidentId },
    nextState: { ...state, riddor: next },
    reason: `${String(state.reference)} reported under RIDDOR on ${input.reportedOn}, reference ${hseReference}${late ? ' (late)' : ''}`,
  });
  return next;
}

export type RiddorPosition = {
  incidentId: string;
  projectId: string;
  reference: string;
  category: string;
  occurredOn: string;
  kind: RiddorKind | null;
  dueOn: string | null;
  notifyWithoutDelay: boolean;
  status: 'UNCLASSIFIED' | 'DUE' | 'OVERDUE' | 'REPORTED' | 'REPORTED_LATE';
  daysLeft: number | null;
  report: RiddorRecord['report'] | null;
};

/** One incident's place on the clock. Only reportable incidents are on it. */
export function riddorPosition(incident: { refId: string; projectId: string; state: Record<string, unknown> }, today: string): RiddorPosition | null {
  const state = incident.state;
  const riddor = state.riddor as RiddorRecord | undefined;
  if (state.riddorReportable !== true && !riddor) return null;
  const daysLeft = riddor && !riddor.report ? Math.round((Date.parse(`${riddor.dueOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) : null;
  return {
    incidentId: incident.refId,
    projectId: incident.projectId,
    reference: String(state.reference ?? incident.refId),
    category: String(state.category ?? ''),
    occurredOn: dateOnly(state.occurredAt),
    kind: riddor?.kind ?? null,
    dueOn: riddor?.dueOn ?? null,
    notifyWithoutDelay: riddor ? RIDDOR_KINDS[riddor.kind].notifyWithoutDelay : false,
    status: !riddor ? 'UNCLASSIFIED' : riddor.report ? (riddor.report.late ? 'REPORTED_LATE' : 'REPORTED') : daysLeft! < 0 ? 'OVERDUE' : 'DUE',
    daysLeft,
    report: riddor?.report ?? null,
  };
}

/** The project's reportable incidents on the clock. */
export function riddorClock(ctx: EngineContext) {
  authorise(ctx, 'SAFETY_RAMS', 'R');
  const today = new Date().toISOString().slice(0, 10);
  return {
    incidents: ctx.ledger
      .list(ctx.projectId, 'Incident')
      .map((record) => riddorPosition({ refId: record.refId, projectId: record.projectId, state: record.state as Record<string, unknown> }, today))
      .filter((entry): entry is RiddorPosition => entry !== null),
    kinds: Object.entries(RIDDOR_KINDS).map(([kind, entry]) => ({ kind, ...entry })),
    methods: RIDDOR_METHODS,
  };
}
