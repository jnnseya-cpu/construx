import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import { CONTINUOUS_CALENDAR, STANDARD_CALENDAR, type WorkCalendar } from '../engines/maths/calendar.ts';
import {
  ACTIVITY_TYPE,
  CONSTRAINT_TYPE,
  rollUpWBS,
  schedule,
  type ActivityType,
  type ConstraintType,
  type ScheduleActivity,
  type ScheduleOptions,
  type ScheduleRelationship,
  type ScheduleResult,
  type WBSNode,
} from '../engines/maths/schedule.ts';

/**
 * The planner's programme: the door onto the dated scheduler.
 *
 * `engines/maths/schedule.ts` computes a programme and had no way in. This is
 * the way in, and it is deliberately built on the records the platform already
 * has rather than on a second activity model:
 *
 * - **`WorkPackage`** is already the breakdown, with a code, a parent and a
 *   depth. It is the WBS; inventing another one would give the platform two
 *   answers to "what is this job made of".
 * - **`Task`** is already the activity, with a code, a name, a duration and a
 *   package. What it lacked was the half-dozen fields that make an activity
 *   schedulable in dates — a calendar, a type, a constraint, actual dates and a
 *   remaining duration — and those are *added to it* rather than copied into a
 *   parallel record that would immediately start to disagree.
 * - **`Dependency`** is already the relationship, with a type and a lag.
 *
 * What is genuinely new here is the **calendar**, which nothing owned, and the
 * **schedule run**: the result of pressing F9, kept as a record.
 *
 * ---
 *
 * ## Why a run is a record
 *
 * A programme is not a calculation, it is a *statement* — the one the team works
 * to and the one an extension of time is argued against. Recomputing it on every
 * read would mean the dates quietly changed under whoever was reading them, and
 * the question "what did the programme say on the 15th" would have no answer.
 *
 * So a run is written to the ledger with the options it used, the data date it
 * ran at and who ran it. Two runs of the same network with different
 * out-of-sequence settings are two different statements, and the record says
 * which is which rather than leaving the last one to win.
 */

// --- Calendars ----------------------------------------------------------------

/**
 * The calendars every project gets without being asked.
 *
 * A five-day week because that is what a site works, and a seven-day one because
 * a cure, a settlement period and a contractual notice all run through weekends
 * and putting them on a five-day calendar adds two days of fiction to each.
 *
 * Seeded rather than required: a planner should not have to define a working
 * week before they can schedule anything, and a platform that made them would
 * be asking a question with one sensible answer.
 */
export const DEFAULT_CALENDARS: WorkCalendar[] = [STANDARD_CALENDAR, CONTINUOUS_CALENDAR];

type CalendarState = WorkCalendar & { projectId: string; createdBy: string; createdAt: string };

/**
 * Define a working calendar, or replace one by the same id.
 *
 * Replacing rather than versioning: a calendar is a statement about which days
 * the site works, a correction to it is not a new calendar, and two calendars
 * differing by one bank holiday is exactly how half a programme ends up on the
 * wrong one.
 */
export function defineCalendar(
  ctx: EngineContext,
  input: {
    id: string;
    name: string;
    workingWeekdays: boolean[];
    exceptions?: Array<{ date: string; working: boolean; reason?: string }>;
    hoursPerDay?: number;
  },
): { calendarId: string; workingDaysPerWeek: number; exceptions: number } {
  authorise(ctx, 'PROGRAMME_BASELINES', 'U');

  if (input.workingWeekdays.length !== 7) {
    throw new DomainError(
      'CALENDAR_WEEK_INVALID',
      `A week has seven days and ${input.workingWeekdays.length} were given. Guessing which was meant would move ` +
        'every date on the programme.',
    );
  }
  if (!input.workingWeekdays.some(Boolean) && !(input.exceptions ?? []).some((entry) => entry.working)) {
    throw new DomainError(
      'CALENDAR_NEVER_WORKS',
      'A calendar with no working days at all would give every activity on it an infinite duration.',
    );
  }
  const id = input.id.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  if (!id) throw new DomainError('CALENDAR_ID_REQUIRED', 'A calendar needs an id to be referred to by.');

  const existing = ctx.ledger.get({ refType: 'Calendar', refId: `${ctx.projectId}:${id}` });
  const state: CalendarState = {
    id,
    name: input.name.trim() || id,
    workingWeekdays: input.workingWeekdays,
    exceptions: (input.exceptions ?? []).map((entry) => ({
      date: entry.date.slice(0, 10),
      working: entry.working,
      ...(entry.reason ? { reason: entry.reason } : {}),
    })),
    hoursPerDay: input.hoursPerDay ?? 8,
    projectId: ctx.projectId,
    createdBy: ctx.auth.actorId,
    createdAt: new Date().toISOString(),
  };

  write(ctx, {
    eventType: existing ? 'CALENDAR_UPDATED' : 'CALENDAR_DEFINED',
    entity: { refType: 'Calendar', refId: `${ctx.projectId}:${id}` },
    reason: `${state.name}: ${state.workingWeekdays.filter(Boolean).length} day week, ${state.exceptions.length} exception(s)`,
    nextState: state as unknown as Record<string, unknown>,
  });

  return { calendarId: id, workingDaysPerWeek: state.workingWeekdays.filter(Boolean).length, exceptions: state.exceptions.length };
}

/** Every calendar this project can schedule on, defaults included. */
export function calendarsFor(ctx: EngineContext): WorkCalendar[] {
  const defined = ctx.ledger
    .list(ctx.projectId, 'Calendar')
    .map((record) => record.state as unknown as CalendarState)
    .map(({ id, name, workingWeekdays, exceptions, hoursPerDay }) => ({ id, name, workingWeekdays, exceptions, hoursPerDay }));
  // A defined calendar wins over a default of the same id, so a project can
  // put its own bank holidays on the standard week without renaming it.
  const byId = new Map<string, WorkCalendar>(DEFAULT_CALENDARS.map((calendar) => [calendar.id, calendar]));
  for (const calendar of defined) byId.set(calendar.id, calendar);
  return [...byId.values()];
}

// --- What makes a task schedulable in dates -----------------------------------

/**
 * Give an activity the attributes a dated schedule needs.
 *
 * Written onto the existing `Task` rather than into a parallel record. A second
 * activity table is how a programme and a work list come to disagree about a
 * duration, and there is no reconciliation that survives the first argument.
 *
 * Every field is optional, and absent means the sensible default: the standard
 * calendar, an ordinary task, no constraint. A planner adding a constraint to
 * one activity should not have to restate the other five for it.
 */
export function setActivityAttributes(
  ctx: EngineContext,
  input: {
    taskId: string;
    type?: ActivityType;
    calendarId?: string;
    constraint?: { type: ConstraintType; date: string } | null;
    /** Overrides the work package's own code, for a hand-placed activity. */
    wbsPath?: string;
  },
): { taskId: string; type: ActivityType; calendarId: string } {
  authorise(ctx, 'PROGRAMME_BASELINES', 'U');

  const task = ctx.ledger.get({ refType: 'Task', refId: input.taskId });
  if (!task || task.projectId !== ctx.projectId) {
    throw new DomainError('TASK_NOT_FOUND', `No activity ${input.taskId} on this project`, 404);
  }
  if (input.type && !(input.type in ACTIVITY_TYPE)) {
    throw new DomainError('ACTIVITY_TYPE_UNKNOWN', `${input.type} is not an activity type this platform schedules.`);
  }
  if (input.constraint) {
    if (!(input.constraint.type in CONSTRAINT_TYPE)) {
      throw new DomainError('CONSTRAINT_TYPE_UNKNOWN', `${input.constraint.type} is not a constraint type.`);
    }
    if (Number.isNaN(Date.parse(input.constraint.date))) {
      throw new DomainError('CONSTRAINT_DATE_INVALID', 'A constraint is a date. Say which one.');
    }
  }
  if (input.calendarId && !calendarsFor(ctx).some((calendar) => calendar.id === input.calendarId)) {
    throw new DomainError(
      'CALENDAR_NOT_DEFINED',
      `${input.calendarId} is not a calendar on this project. Scheduling on the default instead would silently move ` +
        'this activity’s dates.',
    );
  }

  const type = input.type ?? (task.state.activityType as ActivityType | undefined) ?? 'TASK_DEPENDENT';
  const calendarId = input.calendarId ?? String(task.state.calendarId ?? STANDARD_CALENDAR.id);

  write(ctx, {
    eventType: 'ACTIVITY_ATTRIBUTES_SET',
    entity: { refType: 'Task', refId: input.taskId },
    reason: `${ACTIVITY_TYPE[type].label} on ${calendarId}${input.constraint ? `, ${CONSTRAINT_TYPE[input.constraint.type].label} ${input.constraint.date.slice(0, 10)}` : ''}`,
    nextState: {
      ...task.state,
      activityType: type,
      calendarId,
      // Explicit null clears the constraint. Omitting the field leaves it, so a
      // planner changing a calendar does not silently drop a date somebody
      // negotiated.
      ...(input.constraint === null
        ? { constraint: undefined }
        : input.constraint
          ? { constraint: { type: input.constraint.type, date: input.constraint.date.slice(0, 10) } }
          : {}),
      ...(input.wbsPath ? { wbsPath: input.wbsPath } : {}),
    },
  });

  return { taskId: input.taskId, type, calendarId };
}

/**
 * Record where an activity actually got to.
 *
 * Separate from `planning.recordProgress`, which is the *field* record: it
 * demands evidence, refuses to go backwards, and is gated by work
 * authorisation and by the measurement workflow — all correct for a foreman
 * claiming progress, and all wrong for a planner running a monthly update, who
 * is transcribing a marked-up programme rather than claiming anything.
 *
 * What this holds and that one does not is the pair the schedule actually needs:
 * **actual dates** and a **remaining duration**. A percentage is what gets
 * reported and a remaining duration is what schedules, and the two disagree
 * constantly — an activity can be ninety per cent complete with three weeks
 * left, and only one of those numbers moves the finish date.
 */
export function recordActivityStatus(
  ctx: EngineContext,
  input: {
    taskId: string;
    actualStart?: string;
    actualFinish?: string;
    remainingDuration?: number;
    percentComplete?: number;
  },
): { taskId: string; status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETE'; remainingDuration: number } {
  authorise(ctx, 'PROGRAMME_BASELINES', 'U');

  const task = ctx.ledger.get({ refType: 'Task', refId: input.taskId });
  if (!task || task.projectId !== ctx.projectId) {
    throw new DomainError('TASK_NOT_FOUND', `No activity ${input.taskId} on this project`, 404);
  }
  for (const [field, value] of [['actualStart', input.actualStart], ['actualFinish', input.actualFinish]] as const) {
    if (value !== undefined && Number.isNaN(Date.parse(value))) {
      throw new DomainError('ACTUAL_DATE_INVALID', `${field} is not a date: ${value}`);
    }
  }

  const actualStart = input.actualStart?.slice(0, 10) ?? (task.state.actualStart as string | undefined);
  const actualFinish = input.actualFinish?.slice(0, 10) ?? (task.state.actualFinish as string | undefined);

  if (actualFinish && !actualStart) {
    throw new DomainError(
      'ACTUAL_FINISH_WITHOUT_START',
      'An activity cannot have finished without having started. Record the actual start as well — a finish with no ' +
        'start leaves the schedule unable to say how long the work took, which is the number the next job is planned on.',
    );
  }
  if (actualStart && actualFinish && actualFinish < actualStart) {
    throw new DomainError('ACTUAL_DATES_REVERSED', `${actualFinish} is before the actual start of ${actualStart}.`);
  }

  // A finished activity has nothing left, whatever anybody typed.
  const remainingDuration = actualFinish
    ? 0
    : input.remainingDuration !== undefined
      ? Math.max(0, input.remainingDuration)
      : Number(task.state.remainingDuration ?? task.state.durationDays ?? 0);

  if (!actualFinish && actualStart && remainingDuration === 0) {
    throw new DomainError(
      'REMAINING_ZERO_BUT_UNFINISHED',
      'An activity with no remaining duration and no actual finish would be forecast to finish on the data date and ' +
        'never actually complete. Either it is finished — record the date — or something is left to do.',
    );
  }

  const status = actualFinish ? 'COMPLETE' : actualStart ? 'IN_PROGRESS' : 'NOT_STARTED';

  write(ctx, {
    eventType: 'ACTIVITY_STATUS_RECORDED',
    entity: { refType: 'Task', refId: input.taskId },
    reason: `${String(task.state.name)}: ${status.toLowerCase().replace('_', ' ')}, ${remainingDuration}d remaining`,
    nextState: {
      ...task.state,
      ...(actualStart ? { actualStart } : {}),
      ...(actualFinish ? { actualFinish } : {}),
      remainingDuration,
      ...(input.percentComplete !== undefined
        ? { percentComplete: Math.max(0, Math.min(100, input.percentComplete)) }
        : {}),
      status,
    },
  });

  return { taskId: input.taskId, status, remainingDuration };
}

// --- Running the schedule -----------------------------------------------------

/** What the network looks like to the scheduler. */
function loadProgramme(ctx: EngineContext): {
  activities: ScheduleActivity[];
  relationships: ScheduleRelationship[];
} {
  // Two package concepts exist on this platform and both are legitimately "the
  // package this activity sits under": `WorkPackage` is the manual breakdown
  // with a WBS code, and `ScopePackage` is the one the scope work produces,
  // which has a name rather than a code. The demonstration project's activities
  // reference the second, so reading only the first left every activity with no
  // breakdown path and the roll-up table empty on real data.
  //
  // Resolving both rather than picking one: a platform that recognised half its
  // own packages would report a breakdown that is missing branches, which is
  // worse than reporting none.
  const packages = new Map<string, string>();
  for (const record of ctx.ledger.list(ctx.projectId, 'WorkPackage')) {
    const code = String(record.state.wbsCode ?? '').trim();
    if (code) packages.set(record.refId, code);
  }
  for (const record of ctx.ledger.list(ctx.projectId, 'ScopePackage')) {
    // A scope package has no code, so its name is the branch. Dots in it would
    // be read as a hierarchy it does not have.
    const name = String(record.state.name ?? '').trim().replace(/\./g, ' ');
    if (name && !packages.has(record.refId)) packages.set(record.refId, name);
  }

  const activities = ctx.ledger.list(ctx.projectId, 'Task').map((record) => {
    const state = record.state;
    const type = (state.activityType as ActivityType | undefined) ?? 'TASK_DEPENDENT';
    // A milestone has no duration whatever the task record says. Scheduling one
    // with a duration puts a span on a moment.
    const declared = Number(state.durationDays ?? 0);
    const duration = ACTIVITY_TYPE[type].hasDuration ? Math.max(0, declared) : 0;
    return {
      id: record.refId,
      name: String(state.name ?? record.refId),
      type,
      duration,
      calendarId: String(state.calendarId ?? STANDARD_CALENDAR.id),
      // The work package's own code is the breakdown path unless the planner
      // has overridden it — one WBS, read from where it already lives.
      ...(state.wbsPath || packages.get(String(state.workPackageId ?? ''))
        ? { wbsPath: String(state.wbsPath ?? packages.get(String(state.workPackageId ?? ''))) }
        : {}),
      ...(state.constraint ? { constraint: state.constraint as ScheduleActivity['constraint'] } : {}),
      ...(state.actualStart ? { actualStart: String(state.actualStart) } : {}),
      ...(state.actualFinish ? { actualFinish: String(state.actualFinish) } : {}),
      ...(state.remainingDuration !== undefined ? { remainingDuration: Number(state.remainingDuration) } : {}),
      ...(state.percentComplete !== undefined ? { percentComplete: Number(state.percentComplete) } : {}),
    } satisfies ScheduleActivity;
  });

  const relationships = ctx.ledger.list(ctx.projectId, 'Dependency').map((record) => ({
    predecessorId: String(record.state.predecessorId),
    successorId: String(record.state.successorId),
    type: (record.state.type ?? 'FS') as ScheduleRelationship['type'],
    lag: Number(record.state.lag ?? 0),
  }));

  return { activities, relationships };
}

export type ScheduleRunSummary = {
  runId: string;
  ranAt: string;
  ranBy: string;
  options: ScheduleOptions;
  finishDate: string;
  remainingDurationDays: number;
  activities: number;
  criticalCount: number;
  longestPathCount: number;
  outOfSequenceCount: number;
  cycles: string[][];
  constraintDriven: ScheduleResult['constraintDriven'];
};

/**
 * Press F9: schedule the programme and keep the answer.
 *
 * Refuses a cyclic network. The scheduler itself reports cycles rather than
 * throwing, because reporting is right for an analysis — but a *stored*
 * programme with a cycle in it is a statement nobody can work to, and the dates
 * on the activities inside the cycle are arbitrary.
 */
export function runSchedule(
  ctx: EngineContext,
  input: {
    dataDate: string;
    projectStart?: string;
    outOfSequence?: ScheduleOptions['outOfSequence'];
    lagCalendar?: ScheduleOptions['lagCalendar'];
    defaultCalendarId?: string;
  },
): ScheduleRunSummary {
  authorise(ctx, 'PROGRAMME_BASELINES', 'U');

  const { activities, relationships } = loadProgramme(ctx);
  if (activities.length === 0) {
    throw new DomainError('PROGRAMME_EMPTY', 'There are no activities to schedule on this project.', 409);
  }
  if (Number.isNaN(Date.parse(input.dataDate))) {
    throw new DomainError('DATA_DATE_INVALID', 'The data date is the line between what happened and what is forecast. Say which day it is.');
  }

  const options: ScheduleOptions = {
    dataDate: input.dataDate.slice(0, 10),
    outOfSequence: input.outOfSequence ?? 'RETAINED_LOGIC',
    lagCalendar: input.lagCalendar ?? 'PREDECESSOR',
    defaultCalendarId: input.defaultCalendarId ?? STANDARD_CALENDAR.id,
    projectStart: (input.projectStart ?? input.dataDate).slice(0, 10),
  };

  const result = schedule(activities, relationships, calendarsFor(ctx), options);

  if (result.cycles.length > 0) {
    throw new DomainError(
      'PROGRAMME_CYCLIC',
      `The network has a loop in it — ${result.cycles[0]!.join(' → ')} — so there is no order to schedule it in and ` +
        'the dates inside the loop would be arbitrary. Break the loop and run it again.',
      409,
    );
  }

  const runId = ulid();
  const ranAt = new Date().toISOString();
  write(ctx, {
    eventType: 'SCHEDULE_RUN',
    entity: { refType: 'ScheduleRun', refId: runId },
    reason: `${activities.length} activities to ${result.finishDate} under ${options.outOfSequence.toLowerCase().replace('_', ' ')}`,
    nextState: {
      id: runId,
      projectId: ctx.projectId,
      ranAt,
      ranBy: ctx.auth.actorId,
      options,
      finishDate: result.finishDate,
      remainingDurationDays: result.remainingDurationDays,
      // The dates themselves, so "what did the programme say on the 15th" has an
      // answer that does not depend on re-running it against today's data.
      dates: result.activities.map((activity) => ({
        id: activity.id,
        earlyStart: activity.earlyStart,
        earlyFinish: activity.earlyFinish,
        lateStart: activity.lateStart,
        lateFinish: activity.lateFinish,
        totalFloat: activity.totalFloat,
        freeFloat: activity.freeFloat,
        critical: activity.critical,
        longestPath: activity.longestPath,
        status: activity.status,
      })),
      criticalPath: result.criticalPath,
      longestPath: result.longestPath,
      constraintDriven: result.constraintDriven,
      outOfSequenceCount: result.outOfSequenceCount,
    },
  });

  return {
    runId,
    ranAt,
    ranBy: ctx.auth.actorId,
    options,
    finishDate: result.finishDate,
    remainingDurationDays: result.remainingDurationDays,
    activities: result.activities.length,
    criticalCount: result.activities.filter((activity) => activity.critical).length,
    longestPathCount: result.longestPath.length,
    outOfSequenceCount: result.outOfSequenceCount,
    cycles: result.cycles,
    constraintDriven: result.constraintDriven,
  };
}

// --- Reading it ---------------------------------------------------------------

export type ProgrammeView = {
  /** The last run, or nothing where the programme has never been scheduled. */
  lastRun?: { runId: string; ranAt: string; options: ScheduleOptions; finishDate: string; remainingDurationDays: number };
  activities: Array<{
    id: string;
    activityCode: string;
    name: string;
    wbsPath?: string;
    type: ActivityType;
    typeLabel: string;
    calendarId: string;
    duration: number;
    earlyStart: string;
    earlyFinish: string;
    lateStart: string;
    lateFinish: string;
    totalFloat: number;
    freeFloat: number;
    critical: boolean;
    longestPath: boolean;
    status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETE';
    outOfSequence: boolean;
    percentComplete: number;
    constraint?: { type: ConstraintType; date: string };
    /** Where the baseline had it, for the bar underneath the bar. */
    baselineStart?: string;
    baselineFinish?: string;
  }>;
  wbs: WBSNode[];
  /**
   * Activities that sit under no package at all.
   *
   * Counted rather than left to be inferred from an empty table. A breakdown
   * with nothing in it and a project whose activities were never filed under
   * anything look identical on screen, and only one of them is somebody's job
   * to fix.
   */
  unassignedActivities: number;
  /**
   * Activities the field says are finished and the programme cannot schedule as
   * finished, because nobody recorded when.
   *
   * The platform holds two records of "done" and they can disagree.
   * `planning.recordProgress` is the field one — a foreman claiming progress
   * against evidence — and it writes a percentage and a status. The schedule
   * needs a *date*: without an actual finish it has nothing to pin the activity
   * to, so it forecasts work that has already happened and every date after it
   * is pessimistic.
   *
   * Averaged into a roll-up this reads as "0 of 8 complete, 100% done", which is
   * the shape of the disagreement rather than a report of it. Named instead,
   * because it is the commonest reason a programme and a progress report say
   * different things, and it is fixable in a minute by whoever knows the date.
   */
  progressDisagreement: Array<{ id: string; activityCode: string; name: string; fieldPercentComplete: number }>;
  calendars: Array<{ id: string; name: string; workingDaysPerWeek: number; exceptions: number }>;
  finishDate?: string;
  criticalPath: string[];
  longestPath: string[];
  constraintDriven: ScheduleResult['constraintDriven'];
  outOfSequenceCount: number;
  cycles: string[][];
  summary: string;
};

/**
 * The programme as it stands, scheduled live.
 *
 * Live rather than read off the last stored run, and the distinction matters:
 * the stored run is what the programme *said* at the moment somebody ran it, and
 * this is what it says now given everything recorded since. A planner needs
 * both — the first to argue an extension of time against, the second to decide
 * what to do this week — and reporting one as the other is how a team ends up
 * working to a month-old set of dates.
 */
export function programmeView(ctx: EngineContext, asAt?: string): ProgrammeView {
  authorise(ctx, 'PROGRAMME_BASELINES', 'R');

  const calendars = calendarsFor(ctx).map((calendar) => ({
    id: calendar.id,
    name: calendar.name,
    workingDaysPerWeek: calendar.workingWeekdays.filter(Boolean).length,
    exceptions: calendar.exceptions.length,
  }));

  const runs = ctx.ledger
    .list(ctx.projectId, 'ScheduleRun')
    .map((record) => record.state as Record<string, unknown>)
    .sort((a, b) => String(a.ranAt).localeCompare(String(b.ranAt)));
  const last = runs[runs.length - 1];

  const { activities, relationships } = loadProgramme(ctx);
  if (activities.length === 0) {
    return {
      activities: [],
      wbs: [],
      unassignedActivities: 0,
      progressDisagreement: [],
      calendars,
      criticalPath: [],
      longestPath: [],
      constraintDriven: [],
      outOfSequenceCount: 0,
      cycles: [],
      summary: 'No activities have been created, so there is no programme to schedule yet.',
    };
  }

  const dataDate = (asAt ?? (last?.options as ScheduleOptions | undefined)?.dataDate ?? new Date().toISOString()).slice(0, 10);
  const options: ScheduleOptions = {
    ...(last?.options as ScheduleOptions | undefined ?? {
      outOfSequence: 'RETAINED_LOGIC' as const,
      lagCalendar: 'PREDECESSOR' as const,
      defaultCalendarId: STANDARD_CALENDAR.id,
      projectStart: dataDate,
    }),
    dataDate,
  };

  const result = schedule(activities, relationships, calendarsFor(ctx), options);
  const taskState = new Map(ctx.ledger.list(ctx.projectId, 'Task').map((record) => [record.refId, record.state]));

  // The baseline, where one has been approved, so the Gantt can draw the bar
  // underneath the bar. Without it a chart says when the work is planned; with
  // it, it says whether that has moved, which is the only version of the
  // question anybody asks at a progress meeting.
  const baseline = ctx.ledger
    .list(ctx.projectId, 'ProgrammeBaseline')
    .map((record) => record.state as Record<string, unknown>)
    .sort((a, b) => String(a.approvedAt ?? '').localeCompare(String(b.approvedAt ?? '')))
    .pop();
  const baselineDates = new Map<string, { start?: string; finish?: string }>(
    ((baseline?.activities as Array<Record<string, unknown>> | undefined) ?? []).map((entry) => [
      String(entry.taskId ?? entry.id),
      { start: entry.earlyStartDate as string | undefined, finish: entry.earlyFinishDate as string | undefined },
    ]),
  );

  return {
    ...(last
      ? {
          lastRun: {
            runId: String(last.id),
            ranAt: String(last.ranAt),
            options: last.options as ScheduleOptions,
            finishDate: String(last.finishDate),
            remainingDurationDays: Number(last.remainingDurationDays ?? 0),
          },
        }
      : {}),
    activities: result.activities.map((activity) => {
      const state = taskState.get(activity.id) ?? {};
      const baselined = baselineDates.get(activity.id);
      return {
        id: activity.id,
        activityCode: String(state.activityCode ?? activity.id.slice(-6)),
        name: activity.name,
        ...(activity.wbsPath ? { wbsPath: activity.wbsPath } : {}),
        type: activity.type,
        typeLabel: ACTIVITY_TYPE[activity.type].label,
        calendarId: activity.calendarId,
        duration: activity.duration,
        earlyStart: activity.earlyStart,
        earlyFinish: activity.earlyFinish,
        lateStart: activity.lateStart,
        lateFinish: activity.lateFinish,
        totalFloat: activity.totalFloat,
        freeFloat: activity.freeFloat,
        critical: activity.critical,
        longestPath: activity.longestPath,
        status: activity.status,
        outOfSequence: activity.outOfSequence,
        percentComplete: Number(state.percentComplete ?? (activity.status === 'COMPLETE' ? 100 : 0)),
        ...(activity.constraint ? { constraint: activity.constraint } : {}),
        ...(baselined?.start ? { baselineStart: baselined.start } : {}),
        ...(baselined?.finish ? { baselineFinish: baselined.finish } : {}),
      };
    }),
    wbs: rollUpWBS(result),
    unassignedActivities: result.activities.filter((activity) => !activity.wbsPath).length,
    progressDisagreement: result.activities
      .filter((activity) => {
        const state = taskState.get(activity.id) ?? {};
        const fieldSaysDone = Number(state.percentComplete ?? 0) >= 100 || String(state.status ?? '') === 'COMPLETE';
        return fieldSaysDone && activity.status !== 'COMPLETE';
      })
      .map((activity) => {
        const state = taskState.get(activity.id) ?? {};
        return {
          id: activity.id,
          activityCode: String(state.activityCode ?? activity.id.slice(-6)),
          name: activity.name,
          fieldPercentComplete: Number(state.percentComplete ?? 100),
        };
      }),
    calendars,
    finishDate: result.finishDate,
    criticalPath: result.criticalPath,
    longestPath: result.longestPath,
    constraintDriven: result.constraintDriven,
    outOfSequenceCount: result.outOfSequenceCount,
    cycles: result.cycles,
    summary: summarise(
      result,
      last !== undefined,
      result.activities.filter((activity) => {
        const state = taskState.get(activity.id) ?? {};
        return (Number(state.percentComplete ?? 0) >= 100 || String(state.status ?? '') === 'COMPLETE') && activity.status !== 'COMPLETE';
      }).length,
    ),
  };
}

function summarise(result: ScheduleResult, hasRun: boolean, disagreements: number): string {
  const parts = [
    `${result.activities.length} activities finishing ${result.finishDate}, ` +
      `${result.remainingDurationDays} working day(s) from the data date.`,
    `${result.longestPath.length} on the longest path.`,
  ];
  if (result.cycles.length > 0) {
    parts.push(`${result.cycles.length} loop(s) in the logic — the dates inside them are arbitrary until it is broken.`);
  }
  const late = result.constraintDriven.filter((entry) => entry.totalFloat < 0);
  if (late.length > 0) {
    parts.push(`${late.length} constraint(s) cannot be met on the current logic.`);
  }
  if (disagreements > 0) {
    parts.push(
      `${disagreements} activity(ies) are recorded complete in the field with no actual finish date, so the ` +
        'programme is still forecasting work that is done.',
    );
  }
  const unassigned = result.activities.filter((activity) => !activity.wbsPath).length;
  if (unassigned > 0) {
    parts.push(`${unassigned} activity(ies) sit under no package, so they appear in no branch of the breakdown.`);
  }
  if (result.outOfSequenceCount > 0) {
    parts.push(
      `${result.outOfSequenceCount} activity(ies) progressed out of sequence, scheduled under ` +
        `${result.options.outOfSequence.toLowerCase().replace('_', ' ')}.`,
    );
  }
  // Never scheduled and scheduled-and-unchanged are different facts.
  if (!hasRun) parts.push('This is a live calculation; the programme has never been formally run.');
  return parts.join(' ');
}
