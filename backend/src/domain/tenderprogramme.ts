import { expertBriefing } from '../ai/expertise.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, runAI, write, type EngineContext } from '../engines/context.ts';
import { STANDARD_CALENDAR, type WorkCalendar } from '../engines/maths/calendar.ts';
import { bankHolidays, type UkJurisdiction } from '../engines/maths/constructionAct.ts';
import { schedule, type ActivityType, type ScheduleActivity, type ScheduleRelationship } from '../engines/maths/schedule.ts';
import { createTasks, linkTasks } from '../engines/planning.ts';
import type { DocumentBlock } from '../export/exporter.ts';
import { calendarsFor, defineCalendar, programmeView, runSchedule, setActivityAttributes } from './programme.ts';

/**
 * The tender programme: the bar chart a buyer asks for with the return.
 *
 * "Tenderers are to submit a programme with the tender return" sits in almost
 * every civils invitation, and the platform could hold and calculate a programme
 * but not start one — every activity, duration and link was typed by hand on the
 * Programme screen, and the bid went out without one or with one drawn in another
 * tool. A one-person firm with a priced bill should get a programme from the bill.
 *
 * Read → draft → confirm, the same shape as every other AI reading here:
 *
 *   - **Draft.** A model is given the measured bill, the period, the start date,
 *     the invitation's own programme-related requirements and who the firm is, and
 *     proposes activities, working-day durations, the logic between them, the
 *     resource and any specialist subcontract trade behind each, and a labelled
 *     risk-allowance activity. The platform checks it with the same critical-path
 *     engine the Programme screen runs — a loop is refused, a link to an activity
 *     that does not exist is dropped and said so, and whether it fits the period
 *     is computed, not claimed. Nothing is written to the programme.
 *   - **Confirm.** A person accepts it. The activities and links are written
 *     through `createTasks` / `linkTasks` and scheduled with `runSchedule` from the
 *     start date — the project's one programme, editable on the Programme screen
 *     from then on, not a second scheduler beside it.
 *   - **Export.** `tenderProgrammeBlocks` reads the live programme, so an edit
 *     made after confirming is in the document, and draws it as a Gantt chart.
 *
 * Durations are proposals, and the document says so: they come from the model's
 * reading of the quantities, stated as assumptions, for the estimator to check.
 * A programme is a commitment, and the person confirming it owns it.
 */

export type DraftLink = { ref: string; type: 'FS' | 'SS' | 'FF' | 'SF'; lagDays?: number };

export type DraftActivity = {
  /** Short code the drafter gives each activity, e.g. A10. */
  ref: string;
  name: string;
  /** Working days on a five-day week. Zero for a milestone. */
  durationDays: number;
  predecessors: DraftLink[];
  /** The bill items this activity delivers, by reference as written on the bill. */
  boqRefs: string[];
  /** Crew, plant or the person responsible. */
  resource: string;
  /** The specialist trade it is subcontracted to, where it is. */
  subcontract?: string;
  milestone?: boolean;
  riskAllowance?: boolean;
};

export type TenderProgrammeDraft = {
  id: string;
  status: 'DRAFT' | 'CONFIRMED' | 'SUPERSEDED';
  startDate: string;
  periodDays: number;
  guidance?: string;
  activities: DraftActivity[];
  assumptions: string[];
  /** Links the model gave that named no activity, dropped rather than guessed at. */
  corrections: string[];
  /** Computed by the critical-path engine, never asserted by the drafter. */
  forecast: { finishDate: string; completionBy: string; fits: boolean; criticalRefs: string[] };
  /** The working calendar it was scheduled on: five days, less the bank holidays where the works are. */
  calendar: { id: string; name: string; holidays: string[] };
  provider?: string;
  modelClass?: string;
  draftedAt: string;
  draftedBy: string;
  confirmedAt?: string;
  confirmedBy?: string;
  /** Activity ref → the Task it became, once confirmed. */
  taskIds?: Record<string, string>;
};

const isoDate = (value: string): string => value.slice(0, 10);

function addCalendarDays(date: string, days: number): string {
  const at = new Date(`${isoDate(date)}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** The bill items still measured on this project, in the order they were measured. */
function liveBill(ctx: EngineContext): Array<Record<string, unknown>> {
  return ctx.ledger
    .list(ctx.projectId, 'BoQItem')
    .map((record) => record.state)
    .filter((item) => String(item.status ?? 'LIVE') !== 'SUPERSEDED');
}

/** The requirements of this tender's invitation that bear on time, access and sequence. */
function programmeRequirements(ctx: EngineContext): string[] {
  const BEARS_ON_TIME =
    /programme|start|complet|access|closure|possession|hours|working|week|day|date|sequenc|phase|traffic|road|notice|period|duration|milestone|key date/i;
  return ctx.ledger
    .list(`${ctx.tenantId}-governance`, 'ITTAnalysis')
    .map((record) => record.state)
    .filter((analysis) => String(analysis.projectId ?? '') === ctx.projectId)
    .flatMap((analysis) => (analysis.matrix as Array<Record<string, unknown>> | undefined) ?? [])
    .map((line) => String(line.requirement ?? '').replace(/\\[nrt]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((requirement) => requirement.length > 0 && BEARS_ON_TIME.test(requirement))
    .slice(0, 40);
}

function firm(ctx: EngineContext): Record<string, unknown> {
  const profile = ctx.ledger.get({ refType: 'CompanyProfile', refId: `${ctx.tenantId}-profile` })?.state;
  const people = [
    ...new Set(
      ctx.ledger
        .list(`${ctx.tenantId}-governance`, 'User')
        .map((record) => String(record.state.name ?? '').trim())
        .filter((name) => name.length > 0),
    ),
  ].slice(0, 12);
  return {
    people,
    singleOwnerBids: profile?.singleOwnerBids === true,
    selfDeliveredTrades: Array.isArray(profile?.selfDeliveredTrades) ? profile.selfDeliveredTrades : [],
  };
}

/**
 * Turn what the model returned into activities the engine can schedule, or
 * refuse. Pure, so the rules are tested without a provider.
 */
export function normaliseDraft(
  raw: unknown,
  input: { startDate: string; periodDays: number; calendar?: WorkCalendar },
): { activities: DraftActivity[]; assumptions: string[]; corrections: string[]; forecast: TenderProgrammeDraft['forecast'] } {
  const output = (raw ?? {}) as { activities?: unknown; assumptions?: unknown };
  const list = Array.isArray(output.activities) ? (output.activities as Array<Record<string, unknown>>) : [];
  const corrections: string[] = [];

  const seen = new Set<string>();
  const activities: DraftActivity[] = [];
  for (const entry of list) {
    const ref = String(entry.ref ?? '').trim();
    const name = String(entry.name ?? '').trim();
    const duration = Number(entry.durationDays);
    if (!ref || !name || seen.has(ref) || !Number.isFinite(duration) || duration < 0) {
      corrections.push(`An activity with no usable reference, name or duration was left out (${ref || name || 'unnamed'}).`);
      continue;
    }
    seen.add(ref);
    const milestone = entry.milestone === true || duration === 0;
    activities.push({
      ref,
      name,
      durationDays: milestone ? 0 : Math.round(duration * 2) / 2,
      predecessors: (Array.isArray(entry.predecessors) ? (entry.predecessors as Array<Record<string, unknown>>) : [])
        .map((link) => ({
          ref: String(link.ref ?? '').trim(),
          type: (['FS', 'SS', 'FF', 'SF'].includes(String(link.type)) ? String(link.type) : 'FS') as DraftLink['type'],
          ...(Number.isFinite(Number(link.lagDays)) && Number(link.lagDays) !== 0 ? { lagDays: Number(link.lagDays) } : {}),
        }))
        .filter((link) => link.ref.length > 0),
      boqRefs: (Array.isArray(entry.boqRefs) ? entry.boqRefs : []).map((value) => String(value).trim()).filter(Boolean),
      resource: String(entry.resource ?? '').trim(),
      ...(entry.subcontract ? { subcontract: String(entry.subcontract).trim() } : {}),
      ...(milestone ? { milestone: true } : {}),
      ...(entry.riskAllowance === true ? { riskAllowance: true } : {}),
    });
  }

  if (activities.length === 0) {
    throw new DomainError(
      'PROGRAMME_DRAFT_UNUSABLE',
      'The reading returned no activity the programme could hold. Nothing was written; draft it again.',
      502,
    );
  }

  // A link to an activity that is not in the programme is dropped and named. It
  // is not guessed at: "after the facing" pointing at nothing could mean either
  // of two activities, and choosing would put a date on the page nobody chose.
  const refs = new Set(activities.map((activity) => activity.ref));
  for (const activity of activities) {
    activity.predecessors = activity.predecessors.filter((link) => {
      if (link.ref === activity.ref || !refs.has(link.ref)) {
        corrections.push(`${activity.ref} was linked to "${link.ref}", which is not an activity; the link was dropped.`);
        return false;
      }
      return true;
    });
  }

  // A milestone is a moment, and this engine gives a moment its day: a
  // finish-to-start link out of "start on site" would begin the works the next
  // working day, and one into "completion" would complete a day after the last
  // activity. Out of a start milestone the link is start-to-start; into a finish
  // milestone it is finish-to-finish — the same logic, without the two days.
  const byRef = new Map(activities.map((activity) => [activity.ref, activity]));
  for (const activity of activities) {
    activity.predecessors = activity.predecessors.map((link) => {
      const from = byRef.get(link.ref)!;
      if (link.type !== 'FS' || link.lagDays) return link;
      if (from.milestone && from.predecessors.length === 0) return { ...link, type: 'SS' };
      if (activity.milestone) return { ...link, type: 'FF' };
      return link;
    });
  }

  const forecast = forecastOf(activities, input);
  return {
    activities,
    assumptions: (Array.isArray(output.assumptions) ? output.assumptions : []).map((value) => String(value).trim()).filter(Boolean),
    corrections,
    forecast,
  };
}

const TENDER_CALENDAR_ID = 'TENDER_5_DAY';

/**
 * Five working days a week, less the bank holidays where the works are.
 *
 * The standard five-day calendar has no holidays in it, so a UK programme over
 * Easter put work on Good Friday and Easter Monday and finished two days early
 * on paper. The holidays are the platform's own (`bankHolidays`, the same table
 * the Construction Act's payment periods are counted on); outside the UK none are
 * known, and the calendar says so in its name rather than inventing any.
 */
export function tenderCalendar(
  location: { countryCode?: string; city?: string; region?: string } | undefined,
  startDate: string,
): { calendar: WorkCalendar; holidays: string[] } {
  const country = String(location?.countryCode ?? '').toUpperCase();
  const where = `${location?.region ?? ''} ${location?.city ?? ''}`;
  if (country !== 'GB' && country !== 'UK') {
    return {
      calendar: { ...STANDARD_CALENDAR, id: TENDER_CALENDAR_ID, name: 'Five-day week (no public holidays known for this country)' },
      holidays: [],
    };
  }
  const jurisdiction: UkJurisdiction = /scotland/i.test(where)
    ? 'SCOTLAND'
    : /northern ireland/i.test(where)
      ? 'NORTHERN_IRELAND'
      : 'ENGLAND_WALES';
  const year = Number(startDate.slice(0, 4));
  const holidays = [year, year + 1, year + 2].flatMap((y) => bankHolidays(y, jurisdiction));
  const label = jurisdiction === 'ENGLAND_WALES' ? 'England and Wales' : jurisdiction === 'SCOTLAND' ? 'Scotland' : 'Northern Ireland';
  return {
    calendar: {
      ...STANDARD_CALENDAR,
      id: TENDER_CALENDAR_ID,
      name: `Five-day week less ${label} bank holidays`,
      exceptions: holidays.map((date) => ({ date, working: false, reason: 'Bank holiday' })),
    },
    holidays,
  };
}

/**
 * The engine's own milestone types, not a zero-length task. A zero-length task
 * pushes its successor to the next working day, so "start on site" would start
 * the works a day late and "completion" would land a day after the last
 * activity — two days of fiction on every programme.
 */
function activityTypeOf(activity: DraftActivity): ActivityType {
  if (!activity.milestone) return 'TASK_DEPENDENT';
  return activity.predecessors.length === 0 ? 'START_MILESTONE' : 'FINISH_MILESTONE';
}

/** The draft scheduled by the platform's own engine, on a five-day week from the start date. */
function forecastOf(
  activities: DraftActivity[],
  input: { startDate: string; periodDays: number; calendar?: WorkCalendar },
): TenderProgrammeDraft['forecast'] {
  const calendar = input.calendar ?? STANDARD_CALENDAR;
  const scheduleActivities: ScheduleActivity[] = activities.map((activity) => ({
    id: activity.ref,
    name: activity.name,
    type: activityTypeOf(activity),
    duration: activity.durationDays,
    calendarId: calendar.id,
  }));
  const relationships: ScheduleRelationship[] = activities.flatMap((activity) =>
    activity.predecessors.map((link) => ({
      predecessorId: link.ref,
      successorId: activity.ref,
      type: link.type,
      lag: link.lagDays ?? 0,
    })),
  );
  const start = isoDate(input.startDate);
  const result = schedule(scheduleActivities, relationships, [calendar], {
    dataDate: start,
    projectStart: start,
    outOfSequence: 'RETAINED_LOGIC',
    lagCalendar: 'PREDECESSOR',
    defaultCalendarId: calendar.id,
  });
  if (result.cycles.length > 0) {
    throw new DomainError(
      'PROGRAMME_DRAFT_CYCLIC',
      `The drafted logic loops — ${result.cycles[0]!.join(' → ')} — so it has no order to build in. Nothing was ` +
        'written; draft it again.',
      502,
    );
  }
  // The last day of the period, counted in calendar days from the start date.
  const completionBy = addCalendarDays(start, input.periodDays - 1);
  return {
    finishDate: result.finishDate,
    completionBy,
    fits: result.finishDate <= completionBy,
    criticalRefs: result.criticalPath,
  };
}

/**
 * The period, from whichever the buyer stated. An invitation usually fixes a
 * completion date rather than a number of days — "84 days" counted from a
 * Monday ends on a Sunday, and the contract date is the one the work is judged
 * against — so a completion date, when given, decides the period.
 */
function periodFrom(input: { startDate: string; periodDays?: number; completionDate?: string }): number {
  if (input.completionDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.completionDate) || Number.isNaN(Date.parse(input.completionDate))) {
      throw new DomainError('COMPLETION_DATE_INVALID', 'Give the completion date the buyer fixed, as YYYY-MM-DD.', 422, [
        { field: 'completionDate', message: 'a date' },
      ]);
    }
    const days = Math.round((Date.parse(input.completionDate) - Date.parse(isoDate(input.startDate))) / 86_400_000) + 1;
    if (days < 1) {
      throw new DomainError('COMPLETION_BEFORE_START', 'The completion date is before the start date. One of them is wrong.', 422, [
        { field: 'completionDate', message: 'after the start date' },
      ]);
    }
    return days;
  }
  if (input.periodDays === undefined) {
    throw new DomainError(
      'PERIOD_REQUIRED',
      'Give the completion date the buyer fixed, or the construction period in calendar days.',
      422,
      [{ field: 'completionDate', message: 'or periodDays' }],
    );
  }
  return input.periodDays;
}

function requireStart(startDate: string, periodDays: number): void {
  if (!/^\d{4}-\d{2}-\d{2}/.test(startDate) || Number.isNaN(Date.parse(startDate))) {
    throw new DomainError('START_DATE_INVALID', 'Give the date work starts on site, as YYYY-MM-DD.', 422, [
      { field: 'startDate', message: 'a date' },
    ]);
  }
  if (!Number.isInteger(periodDays) || periodDays < 1 || periodDays > 3650) {
    throw new DomainError('PERIOD_INVALID', 'Give the construction period in calendar days, e.g. 84 for twelve weeks.', 422, [
      { field: 'periodDays', message: 'a whole number of days' },
    ]);
  }
}

/** The drafts on this project, newest first. */
export function tenderProgrammeDrafts(ctx: EngineContext): TenderProgrammeDraft[] {
  authorise(ctx, 'WORKPACKAGES_TASKS', 'R');
  return ctx.ledger
    .list(ctx.projectId, 'TenderProgrammeDraft')
    .map((record) => record.state as unknown as TenderProgrammeDraft)
    .sort((a, b) => b.draftedAt.localeCompare(a.draftedAt));
}

/**
 * Draft the tender programme from the bill. Writes a draft only; the programme
 * itself is untouched until a person confirms.
 */
export async function draftTenderProgramme(
  ctx: EngineContext,
  request: { startDate: string; periodDays?: number; completionDate?: string; guidance?: string },
): Promise<{ draft: TenderProgrammeDraft; acuConsumed: number }> {
  authorise(ctx, 'WORKPACKAGES_TASKS', 'C', { lifecyclePhase: currentPhase(ctx) });
  // The start date is checked first: the period can be counted from it, and a
  // completion date measured from a date nobody can read is not a period.
  requireStart(request.startDate, 1);
  const input = { ...request, periodDays: periodFrom(request) };
  requireStart(input.startDate, input.periodDays);

  const bill = liveBill(ctx);
  if (bill.length === 0) {
    throw new DomainError(
      'BILL_NOT_MEASURED',
      'A tender programme is drafted from the measured bill, and this project has none yet. Read the buyer’s pricing ' +
        'schedule or enter the measured quantities first.',
      409,
    );
  }

  const project = ctx.ledger.get({ refType: 'Project', refId: ctx.projectId })?.state ?? {};
  const result = await runAI(ctx, {
    engine: 'TENDER',
    taskType: 'tender_programme_draft',
    capability: 'REASONING',
    inputRefs: [{ refType: 'Project', refId: ctx.projectId }],
    request: {
      task:
        `${expertBriefing('PLANNER')} ` +
        'Draft the construction programme a contractor submits with a tender return, for the works in the measured ' +
        'bill given. Return JSON: `activities`, an array of { ref, name, durationDays, predecessors: [{ ref, type, ' +
        'lagDays }], boqRefs, resource, subcontract, milestone, riskAllowance }, and `assumptions`, an array of strings.',
      payload: {
        project: { name: String(project.name ?? ''), client: String(project.client ?? ''), location: project.location ?? null },
        startDate: isoDate(input.startDate),
        periodCalendarDays: input.periodDays,
        workingWeek: 'Monday to Friday',
        ...(request.completionDate ? { completionDate: request.completionDate } : {}),
        bill: bill.slice(0, 200).map((item) => ({
          description: String(item.description ?? ''),
          unit: String(item.unit ?? ''),
          quantity: Number(item.quantity ?? 0),
          package: String(item.packageId ?? ''),
          ...(item.sourceSheet ? { section: String(item.sourceSheet) } : {}),
        })),
        tenderRequirements: programmeRequirements(ctx),
        firm: firm(ctx),
        ...(input.guidance?.trim() ? { estimatorGuidance: input.guidance.trim() } : {}),
        constraint:
          'Sequence the work the way it is built: preliminaries, traffic management and access first; then clearance, ' +
          'then the permanent works in buildable order, with testing before the work that depends on it, then ' +
          'reinstatement, finishes and demobilisation. One activity per buildable operation, not one per bill line — ' +
          'list the bill references each activity delivers in `boqRefs`, written as they appear on the bill. ' +
          'Durations are working days on a five-day week and must be justified by the quantities: state each ' +
          'productivity you assumed in `assumptions` (for example "soil nails at about 40 m per rig-day"). The whole ' +
          `programme must finish within ${input.periodDays} calendar days of the start date. Include a start-on-site ` +
          'milestone, a completion milestone, the tender requirements given (a date the buyer fixed is a milestone on ' +
          'that date), and one activity named as a risk allowance with `riskAllowance: true` placed before ' +
          'completion. Put procurement and approvals the works depend on (submissions, design, long-lead materials) ' +
          'before the work that needs them. Name only the people in `firm.people`; give work the firm buys in to a ' +
          'specialist subcontractor by trade in `subcontract`, never by company name. Invent no date, constraint or ' +
          'requirement the tender has not stated.',
      },
    },
    toWrites: () => [],
    requireModel: {
      code: 'NO_REASONING_PROVIDER',
      message:
        'This deployment is running the local stand-in, which reasons about nothing. It cannot draft a programme a ' +
        'buyer will hold the firm to. Configure a reasoning provider and set AI_MODE=production.',
    },
  });

  const { calendar, holidays } = tenderCalendar(
    project.location as { countryCode?: string; city?: string; region?: string } | undefined,
    input.startDate,
  );
  const normalised = normaliseDraft(result.output, { ...input, calendar });

  // A newer draft supersedes any older one still waiting — one programme is
  // being drafted, and two waiting drafts would be two answers to one question.
  for (const older of tenderProgrammeDrafts(ctx).filter((draft) => draft.status === 'DRAFT')) {
    write(ctx, {
      eventType: 'TENDER_PROGRAMME_SUPERSEDED',
      entity: { refType: 'TenderProgrammeDraft', refId: older.id },
      nextState: { ...older, status: 'SUPERSEDED' } as unknown as Record<string, unknown>,
    });
  }

  const draft: TenderProgrammeDraft = {
    id: ulid(),
    status: 'DRAFT',
    startDate: isoDate(input.startDate),
    periodDays: input.periodDays,
    ...(input.guidance?.trim() ? { guidance: input.guidance.trim() } : {}),
    ...normalised,
    calendar: {
      id: calendar.id,
      name: calendar.name,
      // Only the ones inside the programme's span are worth carrying.
      holidays: holidays.filter((date) => date >= isoDate(input.startDate)),
    },
    ...(result.provider ? { provider: result.provider } : {}),
    ...(result.modelClass ? { modelClass: result.modelClass } : {}),
    draftedAt: new Date().toISOString(),
    draftedBy: ctx.auth.actorId,
  };
  write(ctx, {
    eventType: 'TENDER_PROGRAMME_DRAFTED',
    entity: { refType: 'TenderProgrammeDraft', refId: draft.id },
    nextState: draft as unknown as Record<string, unknown>,
  });
  return { draft, acuConsumed: result.acuConsumed };
}

/**
 * A person accepts the draft: it becomes the project's programme.
 *
 * Refused on a project that already has activities. Writing a second set beside
 * them would leave two programmes in one network with nothing linking them, and
 * deciding which of the existing ones to replace is not a decision to take here.
 */
export function confirmTenderProgramme(
  ctx: EngineContext,
  input: { draftId: string },
): { draft: TenderProgrammeDraft; finishDate: string } {
  // Both checked before anything is written. Confirming creates the activities
  // and then schedules them, and the two are different permissions — a role
  // that could create and not schedule would leave a programme half written,
  // its activities on the record and no dates against any of them.
  authorise(ctx, 'WORKPACKAGES_TASKS', 'C', { lifecyclePhase: currentPhase(ctx) });
  authorise(ctx, 'PROGRAMME_BASELINES', 'U');

  const record = ctx.ledger.get({ refType: 'TenderProgrammeDraft', refId: input.draftId });
  if (!record || record.tenantId !== ctx.tenantId || record.projectId !== ctx.projectId) {
    throw new DomainError('PROGRAMME_DRAFT_NOT_FOUND', `No tender programme draft ${input.draftId} on this project`, 404);
  }
  const draft = record.state as unknown as TenderProgrammeDraft;
  if (draft.status !== 'DRAFT') {
    throw new DomainError(
      'PROGRAMME_DRAFT_NOT_OPEN',
      draft.status === 'CONFIRMED'
        ? 'This draft is already the programme. Change it on the Programme screen.'
        : 'A newer draft replaced this one. Confirm the newer draft.',
      409,
    );
  }
  const existing = ctx.ledger.list(ctx.projectId, 'Task').length;
  if (existing > 0) {
    throw new DomainError(
      'PROGRAMME_NOT_EMPTY',
      `This project already has a programme of ${existing} activit${existing === 1 ? 'y' : 'ies'}. The tender ` +
        'programme is written onto an empty programme; change the existing one on the Programme screen instead.',
      409,
    );
  }

  // Filed under the package the bill is measured in, so the programme and the
  // bill sit in the same breakdown. The most-used package where the bill has
  // several; the activities themselves name the bill items they deliver.
  const packages = new Map<string, number>();
  for (const item of liveBill(ctx)) {
    const id = String(item.packageId ?? '').trim();
    if (id) packages.set(id, (packages.get(id) ?? 0) + 1);
  }
  const workPackageId = [...packages.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'TENDER_PROGRAMME';

  const ids = createTasks(
    ctx,
    draft.activities.map((activity) => ({
      activityCode: activity.ref,
      name: activity.name,
      workPackageId,
      durationDays: activity.durationDays,
    })),
  );
  const taskIds = Object.fromEntries(draft.activities.map((activity, index) => [activity.ref, ids[index]!]));
  // The calendar the draft was checked on, so the confirmed dates are the dates
  // that were shown. Defined once per project; a later draft reuses it.
  const calendar = draft.calendar ?? { id: STANDARD_CALENDAR.id, name: STANDARD_CALENDAR.name, holidays: [] };
  if (calendar.id !== STANDARD_CALENDAR.id && !calendarsFor(ctx).some((entry) => entry.id === calendar.id)) {
    defineCalendar(ctx, {
      id: calendar.id,
      name: calendar.name,
      workingWeekdays: STANDARD_CALENDAR.workingWeekdays,
      exceptions: calendar.holidays.map((date) => ({ date, working: false, reason: 'Bank holiday' })),
    });
  }
  for (const activity of draft.activities) {
    setActivityAttributes(ctx, {
      taskId: taskIds[activity.ref]!,
      type: activityTypeOf(activity),
      calendarId: calendar.id,
    });
  }
  const links = draft.activities.flatMap((activity) =>
    activity.predecessors.map((link) => ({
      predecessorId: taskIds[link.ref]!,
      successorId: taskIds[activity.ref]!,
      type: link.type,
      lag: link.lagDays ?? 0,
    })),
  );
  if (links.length > 0) linkTasks(ctx, links);
  const run = runSchedule(ctx, {
    dataDate: draft.startDate,
    projectStart: draft.startDate,
    defaultCalendarId: calendar.id,
  });

  const confirmed: TenderProgrammeDraft = {
    ...draft,
    status: 'CONFIRMED',
    taskIds,
    confirmedAt: new Date().toISOString(),
    confirmedBy: ctx.auth.actorId,
  };
  write(ctx, {
    eventType: 'TENDER_PROGRAMME_CONFIRMED',
    entity: { refType: 'TenderProgrammeDraft', refId: draft.id },
    nextState: confirmed as unknown as Record<string, unknown>,
  });
  return { draft: confirmed, finishDate: run.finishDate };
}

/**
 * The tender programme as a document: the Gantt chart, then the activity table,
 * then what it assumed. Read from the live programme, so an activity changed on
 * the Programme screen after confirming is drawn as it now is.
 */
export function tenderProgrammeBlocks(ctx: EngineContext): { blocks: DocumentBlock[]; projectName: string } {
  authorise(ctx, 'WORKPACKAGES_TASKS', 'R');
  const confirmed = tenderProgrammeDrafts(ctx).find((draft) => draft.status === 'CONFIRMED');
  if (!confirmed) {
    throw new DomainError(
      'TENDER_PROGRAMME_NOT_CONFIRMED',
      'There is no confirmed tender programme on this project yet. Draft it from the bill and confirm it first.',
      409,
    );
  }
  const view = programmeView(ctx, confirmed.startDate);
  const byTask = new Map(view.activities.map((activity) => [activity.id, activity]));
  const refOfTask = new Map(Object.entries(confirmed.taskIds ?? {}).map(([ref, id]) => [id, ref]));
  const project = ctx.ledger.get({ refType: 'Project', refId: ctx.projectId })?.state ?? {};

  const rows = confirmed.activities
    .map((activity) => ({ activity, live: byTask.get(confirmed.taskIds?.[activity.ref] ?? '') }))
    .filter((entry) => entry.live !== undefined) as Array<{ activity: DraftActivity; live: (typeof view.activities)[number] }>;
  const finish = rows.reduce((last, row) => (row.live.earlyFinish > last ? row.live.earlyFinish : last), confirmed.startDate);
  const critical = rows.filter((row) => row.live.critical).map((row) => row.activity.ref);

  const blocks: DocumentBlock[] = [
    {
      kind: 'KEY_VALUES',
      rows: [
        { label: 'Project', value: String(project.name ?? '') },
        { label: 'Start on site', value: confirmed.startDate },
        { label: 'Completion (programmed)', value: finish },
        {
          label: 'Construction period',
          value:
            `${confirmed.periodDays} calendar days, to ${confirmed.forecast.completionBy}` +
            (finish <= confirmed.forecast.completionBy ? ' — the programme finishes within it' : ' — the programme overruns it'),
        },
        { label: 'Working pattern', value: confirmed.calendar?.name ?? 'Monday to Friday' },
        { label: 'Critical path', value: critical.join(' → ') || 'None calculated' },
        { label: 'Status', value: 'Tender programme — for tender purposes only' },
      ],
    },
    {
      kind: 'GANTT',
      caption: 'Programme of the works',
      from: confirmed.startDate,
      to: finish > confirmed.forecast.completionBy ? finish : confirmed.forecast.completionBy,
      rows: rows.map((row) => ({
        label: `${row.activity.ref} ${row.activity.name}`,
        start: row.live.earlyStart,
        finish: row.live.earlyFinish,
        ...(row.live.critical ? { critical: true } : {}),
        ...(row.activity.milestone ? { milestone: true } : {}),
        ...(row.activity.riskAllowance ? { riskAllowance: true } : {}),
      })),
    },
    { kind: 'HEADING', level: 2, text: 'Activities, logic and resources' },
    {
      kind: 'TABLE',
      headers: ['Ref', 'Activity', 'Days', 'Start', 'Finish', 'Follows', 'Resource / subcontract', 'Bill items', 'Critical'],
      rows: rows.map((row) => [
        row.activity.ref,
        row.activity.name,
        row.activity.milestone ? 'Milestone' : String(row.live.duration),
        row.live.earlyStart,
        row.live.earlyFinish,
        row.activity.predecessors
          .map((link) => `${link.ref}${link.type === 'FS' ? '' : ` ${link.type}`}${link.lagDays ? ` +${link.lagDays}d` : ''}`)
          .join(', ') || '—',
        [row.activity.resource, row.activity.subcontract ? `Specialist subcontractor: ${row.activity.subcontract}` : '']
          .filter(Boolean)
          .join('. ') || '—',
        row.activity.boqRefs.join(', ') || '—',
        row.live.critical ? 'Yes' : '',
      ]),
    },
  ];
  // Activities added on the Programme screen after confirming are in the live
  // programme and not in the draft; they are drawn too, without draft detail.
  const added = view.activities.filter((activity) => !refOfTask.has(activity.id));
  if (added.length > 0) {
    blocks.push({
      kind: 'TABLE',
      caption: 'Activities added on the Programme screen',
      headers: ['Code', 'Activity', 'Days', 'Start', 'Finish', 'Critical'],
      rows: added.map((activity) => [
        activity.activityCode,
        activity.name,
        String(activity.duration),
        activity.earlyStart,
        activity.earlyFinish,
        activity.critical ? 'Yes' : '',
      ]),
    });
  }
  if (confirmed.assumptions.length > 0) {
    blocks.push({ kind: 'HEADING', level: 2, text: 'Assumptions behind the durations' });
    blocks.push({ kind: 'LIST', ordered: false, items: confirmed.assumptions });
  }
  blocks.push({
    kind: 'PARAGRAPH',
    text:
      'This programme is submitted for tender purposes. It will be developed into the contract programme on award, ' +
      'from the confirmed start date, access dates and the Employer’s requirements.',
  });
  return { blocks, projectName: String(project.name ?? '') };
}
