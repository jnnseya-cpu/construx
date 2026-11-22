import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { write, type EngineContext } from '../../engines/context.ts';
import { applications, today } from './applications.ts';
import { evaluations, guard, planningChanged, proposals, text } from './planning.ts';
import { DEVELOPMENT_CATEGORIES } from './rules.ts';

/**
 * Study scheduling: the technical work an application needs, planned against
 * the date it has to be submitted.
 *
 * Candidate studies are generated from the rule findings and the
 * specification's templates. A study a finding requires is a candidate that
 * applies; every other template — and any study an upstream trigger (protected
 * habitat, historic land use) raises — waits for a planner's applicability
 * decision. Consultants enter the seasonal survey windows; the schedule is then
 * computed forward from the commission date, through dependencies and the next
 * open window, and any study that would finish after the target submission —
 * or after the land option expires — is flagged as being on the critical path.
 */

export const STUDY_TEMPLATES = {
  POLICY_DESIGN: 'Planning policy, design and masterplan',
  TRANSPORT: 'Transport assessment or statement, and access',
  ECOLOGY_BNG: 'Ecology and biodiversity net gain',
  FRA_SUDS: 'Flood risk assessment and SuDS strategy',
  ARBORICULTURE: 'Arboriculture',
  GROUND: 'Ground contamination and geotechnics',
  HERITAGE: 'Heritage and archaeology',
  NOISE_AIR: 'Noise and air quality',
  UTILITIES: 'Utilities',
  ENGAGEMENT: 'Community engagement',
} as const;
export type StudyTemplate = keyof typeof STUDY_TEMPLATES;

/** Which finding makes a study required rather than a candidate for review. */
const REQUIRED_BY: Partial<Record<StudyTemplate, string[]>> = {
  FRA_SUDS: ['FRA'],
  ECOLOGY_BNG: ['BNG', 'PROTECTED_SPECIES', 'HRA'],
};

export type Study = {
  id: string;
  template: StudyTemplate;
  title: string;
  applicationId: string;
  applicability: 'REQUIRED' | 'REVIEW' | 'NOT_REQUIRED';
  basis: string;
  status: 'CANDIDATE' | 'COMMISSIONED' | 'IN_PROGRESS' | 'COMPLETE';
  consultant?: string;
  commissionBy?: string;
  durationWeeks?: number;
  /** Month-day, inclusive, as the consultant gives it — e.g. bat activity 04-15 to 09-30. */
  surveyWindow?: { from: string; to: string; enteredBy: string };
  dependsOn: string[];
  validUntil?: string;
  applicabilityNote?: string;
};

export const studies = (ctx: EngineContext, applicationId?: string): Array<Study & { version: number }> =>
  ctx.ledger
    .list(ctx.projectId, 'PlanningStudy')
    .map((record) => ({ ...(record.state as unknown as Study), version: record.version }))
    .filter((entry) => !applicationId || entry.applicationId === applicationId);

/** Add the studies an application needs and does not have. */
export function generateStudies(ctx: EngineContext, applicationId: string): Study[] {
  guard(ctx, 'C');
  const application = applications(ctx).find((entry) => entry.id === applicationId);
  if (!application) throw new DomainError('APPLICATION_NOT_FOUND', 'No such application on this project.', 404);
  const evaluation = application.proposalId ? evaluations(ctx).filter((entry) => entry.proposalId === application.proposalId).at(-1) : undefined;
  const have = new Set(studies(ctx, applicationId).map((entry) => entry.template));
  const subject = application.proposalId ? proposals(ctx).find((entry) => entry.id === application.proposalId) : undefined;
  const need = subject?.category ? DEVELOPMENT_CATEGORIES[subject.category] : undefined;
  const byNeed = new Set<string>(need?.studies ?? []);
  const added: Study[] = [];
  for (const template of Object.keys(STUDY_TEMPLATES) as StudyTemplate[]) {
    if (have.has(template)) continue;
    const triggers = (REQUIRED_BY[template] ?? [])
      .map((code) => evaluation?.findings.find((finding) => finding.code === code))
      .filter((finding) => finding && finding.status === 'applies');
    const study: Study = {
      id: ulid(),
      template,
      title: STUDY_TEMPLATES[template],
      applicationId,
      applicability: triggers.length > 0 || byNeed.has(template) ? 'REQUIRED' : 'REVIEW',
      basis:
        triggers.length > 0
          ? `Required: ${triggers.map((finding) => finding!.title).join(', ')} applies.`
          : byNeed.has(template)
            ? `Required for ${need!.label.toLowerCase()}.`
            : 'Template study — a planner decides whether it applies to this site and proposal.',
      status: 'CANDIDATE',
      dependsOn: [],
    };
    write(ctx, { eventType: 'PLANNING_STUDY_RECORDED', entity: { refType: 'PlanningStudy', refId: study.id }, nextState: study, reason: `${application.reference}: ${study.title} (${study.applicability.toLowerCase()})` });
    added.push(study);
  }
  return added;
}

const MONTH_DAY = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const isDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

/** Applicability, status, consultant, dates, the survey window and dependencies. */
export function updateStudy(
  ctx: EngineContext,
  id: string,
  input: {
    applicability?: string;
    applicabilityNote?: string;
    status?: string;
    consultant?: string;
    commissionBy?: string;
    durationWeeks?: number;
    surveyWindow?: { from: string; to: string } | null;
    dependsOn?: string[];
    validUntil?: string;
  },
): Study {
  guard(ctx, 'U');
  const found = studies(ctx).find((entry) => entry.id === id);
  if (!found) throw new DomainError('STUDY_NOT_FOUND', 'No such study on this project.', 404);
  const { version: _version, ...study } = found;
  const next: Study = { ...study };
  if (input.applicability !== undefined) {
    if (!['REQUIRED', 'NOT_REQUIRED'].includes(input.applicability)) throw new DomainError('STUDY_APPLICABILITY', 'A planner decides required or not required.', 422, [{ field: 'applicability', message: 'REQUIRED or NOT_REQUIRED' }]);
    next.applicability = input.applicability as Study['applicability'];
    next.applicabilityNote = text(input.applicabilityNote, 'applicabilityNote', 5, 'Give the reason — the site walk, the desk study, the officer’s advice.');
  }
  if (input.status !== undefined) {
    if (!['CANDIDATE', 'COMMISSIONED', 'IN_PROGRESS', 'COMPLETE'].includes(input.status)) throw new DomainError('STUDY_STATUS', 'Choose the study’s status.', 422, [{ field: 'status', message: 'choose one' }]);
    if (next.applicability === 'NOT_REQUIRED' && input.status !== 'CANDIDATE') throw new DomainError('STUDY_NOT_REQUIRED', 'That study was ruled not required.', 409);
    next.status = input.status as Study['status'];
  }
  if (input.consultant !== undefined) next.consultant = input.consultant.trim();
  for (const [field, value] of [['commissionBy', input.commissionBy], ['validUntil', input.validUntil]] as const) {
    if (value === undefined) continue;
    if (!isDate(value)) throw new DomainError('STUDY_DATE', 'A date is YYYY-MM-DD.', 422, [{ field, message: 'date' }]);
    next[field] = value;
  }
  if (input.durationWeeks !== undefined) {
    if (!Number.isInteger(input.durationWeeks) || input.durationWeeks < 1 || input.durationWeeks > 104) throw new DomainError('STUDY_DURATION', 'The duration is whole weeks, 1 to 104.', 422, [{ field: 'durationWeeks', message: 'weeks' }]);
    next.durationWeeks = input.durationWeeks;
  }
  if (input.surveyWindow === null) delete next.surveyWindow;
  else if (input.surveyWindow) {
    if (!MONTH_DAY.test(input.surveyWindow.from) || !MONTH_DAY.test(input.surveyWindow.to)) {
      throw new DomainError('STUDY_WINDOW', 'A survey window is two month-days, MM-DD to MM-DD, as the consultant gives it.', 422, [{ field: 'surveyWindow', message: 'MM-DD' }]);
    }
    next.surveyWindow = { ...input.surveyWindow, enteredBy: ctx.auth.actorId };
  }
  if (input.dependsOn !== undefined) {
    const siblings = new Set(studies(ctx, study.applicationId).map((entry) => entry.id));
    const unknown = input.dependsOn.filter((dep) => !siblings.has(dep) || dep === id);
    if (unknown.length > 0) throw new DomainError('STUDY_DEPENDENCY', 'A dependency is another study of the same application.', 422, [{ field: 'dependsOn', message: 'studies of this application' }]);
    // Refuse a loop: nothing this study depends on may depend, however indirectly, on it.
    const all = new Map(studies(ctx, study.applicationId).map((entry) => [entry.id, entry.dependsOn]));
    all.set(id, input.dependsOn);
    const reaches = (from: string, seen = new Set<string>()): boolean =>
      (all.get(from) ?? []).some((dep) => dep === id || (!seen.has(dep) && (seen.add(dep), reaches(dep, seen))));
    if (reaches(id)) throw new DomainError('STUDY_DEPENDENCY_LOOP', 'Those dependencies make a loop.', 422, [{ field: 'dependsOn', message: 'no loops' }]);
    next.dependsOn = input.dependsOn;
  }
  write(ctx, { eventType: 'PLANNING_STUDY_UPDATED', entity: { refType: 'PlanningStudy', refId: id }, nextState: next, reason: `${next.title} updated` });
  planningChanged(ctx);
  return next;
}

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** The first day on or after `date` that falls inside a month-day window (which may wrap the year end). */
export function nextInWindow(date: string, window: { from: string; to: string }): string {
  const md = date.slice(5);
  const wraps = window.from > window.to;
  const inside = wraps ? md >= window.from || md <= window.to : md >= window.from && md <= window.to;
  if (inside) return date;
  const year = Number(date.slice(0, 4));
  const candidate = `${year}-${window.from}`;
  return candidate >= date ? candidate : `${year + 1}-${window.from}`;
}

export type StudySchedule = Study & {
  start?: string;
  finish?: string;
  waitedForWindowDays?: number;
  critical: string[];
};

/**
 * Forward through dependencies and windows from each commission date. A study
 * with no commission date or duration is unscheduled and says so.
 */
export function studySchedule(ctx: EngineContext, applicationId: string): StudySchedule[] {
  guard(ctx, 'R');
  const application = applications(ctx).find((entry) => entry.id === applicationId);
  if (!application) throw new DomainError('APPLICATION_NOT_FOUND', 'No such application on this project.', 404);
  const list = studies(ctx, applicationId).filter((entry) => entry.applicability !== 'NOT_REQUIRED');
  const byId = new Map(list.map((entry) => [entry.id, entry]));
  const done = new Map<string, StudySchedule>();
  const visit = (study: Study): StudySchedule => {
    const known = done.get(study.id);
    if (known) return known;
    const critical: string[] = [];
    const deps = study.dependsOn.map((dep) => byId.get(dep)).filter((dep): dep is Study & { version: number } => Boolean(dep)).map(visit);
    if (!study.commissionBy || !study.durationWeeks) {
      const result: StudySchedule = { ...study, critical: study.applicability === 'REQUIRED' ? ['Not scheduled: give it a commission date and a duration.'] : [] };
      done.set(study.id, result);
      return result;
    }
    const after = [study.commissionBy, ...deps.map((dep) => dep.finish).filter((finish): finish is string => Boolean(finish))].sort().at(-1)!;
    const start = study.surveyWindow ? nextInWindow(after, study.surveyWindow) : after;
    const finish = addDays(start, study.durationWeeks * 7);
    const waited = Math.round((Date.parse(`${start}T00:00:00Z`) - Date.parse(`${after}T00:00:00Z`)) / 86_400_000);
    if (application.targetSubmissionOn && finish > application.targetSubmissionOn) {
      critical.push(`Finishes ${finish}, after the target submission (${application.targetSubmissionOn})${waited > 0 ? ` — it waits ${waited} days for its survey window` : ''}.`);
    }
    if (application.landOptionExpiresOn && finish > application.landOptionExpiresOn) critical.push(`Finishes after the land option expires (${application.landOptionExpiresOn}).`);
    if (study.status === 'CANDIDATE' && study.commissionBy < today()) critical.push(`Should have been commissioned by ${study.commissionBy}.`);
    if (study.validUntil && application.targetSubmissionOn && study.validUntil < application.targetSubmissionOn) critical.push(`Its findings expire ${study.validUntil}, before the target submission.`);
    const result: StudySchedule = { ...study, start, finish, ...(waited > 0 ? { waitedForWindowDays: waited } : {}), critical };
    done.set(study.id, result);
    return result;
  };
  return list.map(visit);
}

export const studiesForRegister = (ctx: EngineContext) =>
  applications(ctx).flatMap((application) => (studies(ctx, application.id).length ? studySchedule(ctx, application.id) : []));

