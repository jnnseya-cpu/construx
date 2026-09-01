import { DomainError } from '../../core/errors.ts';
import {
  addCalendarDays,
  addWorkingDays,
  compileAll,
  finishOf,
  nextWorkingDay,
  previousWorkingDay,
  startOf,
  workingDaysBetween,
  type CalendarIndex,
  type WorkCalendar,
} from './calendar.ts';
import { topologicalOrder, type DependencyType } from './cpm.ts';

/**
 * The programme, in dates.
 *
 * `cpm.ts` computes the network on abstract working-day indices, which is what
 * the Monte Carlo simulation needs and is not a programme. This is a programme:
 * every activity on its own calendar, real dates, the nine constraint types a
 * planner actually uses, a data date, and out-of-sequence progress handled the
 * way the industry argues about it rather than ignored.
 *
 * ---
 *
 * ## What makes this different from a Gantt chart with arrows
 *
 * **A calendar per activity.** Excavation on a five-day week, a concrete cure on
 * a seven-day one, a shutdown week nobody works. Three working days from
 * Thursday is Monday on one and Saturday on the other, and a single project
 * calendar gets one of them wrong on every activity that uses it.
 *
 * **A data date.** The line between what happened and what is forecast. Nothing
 * unstarted may be scheduled before it, an activity in progress is forecast from
 * it rather than from its original start, and every "we are three weeks late"
 * conversation is really an argument about where this line is.
 *
 * **Out-of-sequence progress.** Work starts before its predecessor finishes —
 * constantly, on every real job. **Retained logic** says the remainder still
 * waits for the predecessor; **progress override** says the logic is spent and
 * the remainder runs free. They give materially different completion dates, both
 * are defensible, and a tool that silently picks one is hiding the assumption
 * that moved the date. This states which was used, in the result.
 *
 * **Longest path, not float ≤ 0.** With multiple calendars and constraints, the
 * set of activities with no total float is not the chain that determines the
 * finish date. P6 distinguishes them and so does this: `critical` is float-based
 * and `longestPath` is traced back through driving relationships from the
 * activity that actually finishes last.
 *
 * ## What it refuses
 *
 * A network with a cycle, because there is no order to schedule it in. A
 * constraint that contradicts the logic is **not** refused — it is scheduled and
 * reported as a negative float, which is what a planner needs to see rather than
 * a rejection.
 */

// --- What a programme is made of ---------------------------------------------

/**
 * P6's activity types, and each one schedules differently.
 *
 * `TASK_DEPENDENT` is ordinary work on its own calendar. The two milestone types
 * have no duration and mark a moment. `LEVEL_OF_EFFORT` is supervision,
 * scaffolding, site facilities — work whose duration is *not its own*: it spans
 * from its predecessors to its successors and stretches when they do, which is
 * exactly how site management behaves and nothing like how a task behaves.
 * `WBS_SUMMARY` spans its own branch of the breakdown.
 */
export const ACTIVITY_TYPE = {
  TASK_DEPENDENT: { label: 'Task', hasDuration: true, spans: false },
  RESOURCE_DEPENDENT: { label: 'Resource dependent', hasDuration: true, spans: false },
  START_MILESTONE: { label: 'Start milestone', hasDuration: false, spans: false },
  FINISH_MILESTONE: { label: 'Finish milestone', hasDuration: false, spans: false },
  LEVEL_OF_EFFORT: { label: 'Level of effort', hasDuration: false, spans: true },
  WBS_SUMMARY: { label: 'WBS summary', hasDuration: false, spans: true },
} as const;

export type ActivityType = keyof typeof ACTIVITY_TYPE;

/**
 * The constraint types, and which end of the activity each one pins.
 *
 * `hard` marks the two that override the logic rather than bounding it: a
 * mandatory date sits where it is told whatever its predecessors say, and P6
 * warns about them for the reason this flags them — they break the network, and
 * a programme full of them is a bar chart wearing a network's clothes.
 */
export const CONSTRAINT_TYPE = {
  START_ON: { label: 'Start on', pins: 'START', hard: false },
  START_ON_OR_AFTER: { label: 'Start on or after', pins: 'START', hard: false },
  START_ON_OR_BEFORE: { label: 'Start on or before', pins: 'START', hard: false },
  FINISH_ON: { label: 'Finish on', pins: 'FINISH', hard: false },
  FINISH_ON_OR_AFTER: { label: 'Finish on or after', pins: 'FINISH', hard: false },
  FINISH_ON_OR_BEFORE: { label: 'Finish on or before', pins: 'FINISH', hard: false },
  MANDATORY_START: { label: 'Mandatory start', pins: 'START', hard: true },
  MANDATORY_FINISH: { label: 'Mandatory finish', pins: 'FINISH', hard: true },
  AS_LATE_AS_POSSIBLE: { label: 'As late as possible', pins: 'NONE', hard: false },
} as const;

export type ConstraintType = keyof typeof CONSTRAINT_TYPE;

export type ScheduleActivity = {
  id: string;
  name: string;
  type: ActivityType;
  /** Original duration in working days of this activity's own calendar. */
  duration: number;
  calendarId: string;
  /** Where this sits in the breakdown, as a path like `1.2.3`. Optional. */
  wbsPath?: string;
  constraint?: { type: ConstraintType; date: string };
  /** Actual start, once work has begun. */
  actualStart?: string;
  /** Actual finish, once work is done. */
  actualFinish?: string;
  /**
   * Working days left. Absent means "not started, so all of it".
   *
   * Held separately from percent complete on purpose: a foreman saying an
   * activity is eighty per cent done and saying four days remain are different
   * statements, and the second is the one that schedules.
   */
  remainingDuration?: number;
  /** What the crew says is done, 0–100. Reported, never used to schedule. */
  percentComplete?: number;
};

export type ScheduleRelationship = {
  predecessorId: string;
  successorId: string;
  type: DependencyType;
  /** Lag in working days. Negative is a lead. */
  lag: number;
};

/**
 * The choices a planner makes before pressing F9, stated rather than assumed.
 *
 * Every one of these changes the answer, and a tool that hides them is hiding
 * the reason two people ran the same programme and got different dates.
 */
export type ScheduleOptions = {
  /** The line between actual and forecast. */
  dataDate: string;
  /** How out-of-sequence progress is handled. */
  outOfSequence: 'RETAINED_LOGIC' | 'PROGRESS_OVERRIDE';
  /**
   * Whose calendar measures relationship lag.
   *
   * P6 offers predecessor, successor, 24-hour and project default, and defaults
   * to the predecessor's. A two-day lag means something different on a five-day
   * calendar than on a seven-day one, so the choice is recorded with the result.
   */
  lagCalendar: 'PREDECESSOR' | 'SUCCESSOR' | 'CONTINUOUS';
  /** Calendar used for anything that names none of its own. */
  defaultCalendarId: string;
  /** Where the programme starts, if nothing constrains it earlier. */
  projectStart: string;
};

export type ScheduledActivityDates = ScheduleActivity & {
  earlyStart: string;
  earlyFinish: string;
  lateStart: string;
  lateFinish: string;
  /** Working days of this activity's own calendar. Negative means late. */
  totalFloat: number;
  freeFloat: number;
  critical: boolean;
  /** On the chain that actually determines the finish date. */
  longestPath: boolean;
  /** Complete, running, or not begun — derived, never asserted by a caller. */
  status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETE';
  /** True where work began before a predecessor finished. */
  outOfSequence: boolean;
  /**
   * The predecessor that actually set this activity's early start.
   *
   * The single most-asked question in front of a Gantt chart — "what is holding
   * this?" — and the answer the logic already knows and used to throw away.
   * Absent where nothing drives it: the first activity, or one whose constraint
   * or the data date set its start instead of a relationship.
   */
  drivingPredecessorId?: string;
};

export type ScheduleResult = {
  activities: ScheduledActivityDates[];
  /** The date the last activity finishes. */
  finishDate: string;
  /** Working days from the data date to the finish, on the default calendar. */
  remainingDurationDays: number;
  criticalPath: string[];
  longestPath: string[];
  cycles: string[][];
  /** Activities whose constraint pushed them past their logic. */
  constraintDriven: Array<{ id: string; name: string; constraint: ConstraintType; date: string; totalFloat: number }>;
  outOfSequenceCount: number;
  options: ScheduleOptions;
};

// --- Scheduling ---------------------------------------------------------------

const FLOAT_TOLERANCE = 1e-6;

/**
 * Schedule the programme.
 *
 * Forward pass, backward pass, float, then the longest path traced back from
 * whatever finishes last. Progressed work is pinned to its actual dates and
 * everything unstarted is held at or after the data date, which is what makes
 * the result a forecast rather than a restatement of the original plan.
 */
export function schedule(
  activities: ScheduleActivity[],
  relationships: ScheduleRelationship[],
  calendars: WorkCalendar[],
  options: ScheduleOptions,
): ScheduleResult {
  const byId = new Map(activities.map((activity) => [activity.id, activity]));
  const ids = activities.map((activity) => activity.id);
  const { order, cycles } = topologicalOrder(ids, relationships);

  // A padded span so both passes and any negative lag have somewhere to land.
  const dates = [
    options.projectStart,
    options.dataDate,
    ...activities.flatMap((a) => [a.actualStart, a.actualFinish, a.constraint?.date].filter(Boolean) as string[]),
  ].map((value) => value.slice(0, 10));
  const spanFrom = dates.reduce((min, value) => (value < min ? value : min));
  const spanTo = dates.reduce((max, value) => (value > max ? value : max));
  const compiled = compileAll(calendars, spanFrom, spanTo, 1200);

  if (!compiled.has(options.defaultCalendarId)) {
    throw new DomainError(
      'SCHEDULE_DEFAULT_CALENDAR_MISSING',
      `The default calendar ${options.defaultCalendarId} is not among the calendars supplied, so anything that names ` +
        'none of its own could not be scheduled at all.',
    );
  }
  const calendarFor = (activity: ScheduleActivity): CalendarIndex => {
    const index = compiled.get(activity.calendarId);
    if (!index) {
      throw new DomainError(
        'SCHEDULE_CALENDAR_MISSING',
        `${activity.name} is on calendar ${activity.calendarId}, which was not supplied. Scheduling it on the ` +
          'default instead would silently move its dates.',
      );
    }
    return index;
  };
  const lagIndexFor = (predecessor: ScheduleActivity, successor: ScheduleActivity): CalendarIndex =>
    options.lagCalendar === 'SUCCESSOR'
      ? calendarFor(successor)
      : options.lagCalendar === 'CONTINUOUS'
        ? (compiled.get('CONTINUOUS_7_DAY') ?? calendarFor(predecessor))
        : calendarFor(predecessor);

  const predecessorsOf = new Map<string, ScheduleRelationship[]>();
  const successorsOf = new Map<string, ScheduleRelationship[]>();
  for (const id of ids) {
    predecessorsOf.set(id, []);
    successorsOf.set(id, []);
  }
  for (const link of relationships) {
    if (!byId.has(link.predecessorId) || !byId.has(link.successorId)) continue;
    predecessorsOf.get(link.successorId)!.push(link);
    successorsOf.get(link.predecessorId)!.push(link);
  }

  const dataDate = options.dataDate.slice(0, 10);
  const statusOf = (activity: ScheduleActivity): ScheduledActivityDates['status'] =>
    activity.actualFinish ? 'COMPLETE' : activity.actualStart ? 'IN_PROGRESS' : 'NOT_STARTED';

  /** What is left to do, in working days. Complete work has nothing left. */
  const remainingOf = (activity: ScheduleActivity): number => {
    if (activity.actualFinish) return 0;
    if (activity.remainingDuration !== undefined) return Math.max(0, activity.remainingDuration);
    return Math.max(0, activity.duration);
  };

  const earlyStart = new Map<string, string>();
  const earlyFinish = new Map<string, string>();
  const outOfSequence = new Set<string>();
  const drivingPredecessor = new Map<string, string>();

  // Activities inside a cycle never reach the topological order, and a pass
  // that assumed they did read `undefined` out of the date maps and threw —
  // reporting a crash where the answer is "this network has no order". They are
  // scheduled after the ones that can be, at the earliest date permitted, and
  // the cycle is the finding.
  const ordered = new Set(order);
  const passOrder = [...order, ...ids.filter((id) => !ordered.has(id))];

  // --- Forward pass -----------------------------------------------------------
  for (const id of passOrder) {
    const activity = byId.get(id)!;
    const index = calendarFor(activity);
    const status = statusOf(activity);

    if (status === 'COMPLETE') {
      // Actual dates are facts. Nothing in the network moves them.
      const start = previousWorkingDay(index, activity.actualStart ?? activity.actualFinish!);
      earlyStart.set(id, start);
      earlyFinish.set(id, previousWorkingDay(index, activity.actualFinish!));
      continue;
    }

    // Where the logic says the remaining work could begin.
    let logicStart: string | undefined;
    let driver: string | undefined;
    for (const link of predecessorsOf.get(id) ?? []) {
      const predecessor = byId.get(link.predecessorId)!;
      const predecessorDone = statusOf(predecessor) === 'COMPLETE';

      // Out of sequence: this activity has started while a predecessor has not
      // finished. Under progress override the spent logic stops driving; under
      // retained logic it goes on holding the remainder back.
      if (status === 'IN_PROGRESS' && !predecessorDone) {
        outOfSequence.add(id);
        if (options.outOfSequence === 'PROGRESS_OVERRIDE') continue;
      }

      const lagIndex = lagIndexFor(predecessor, activity);
      const predStart = earlyStart.get(link.predecessorId);
      const predFinish = earlyFinish.get(link.predecessorId);
      if (predStart === undefined || predFinish === undefined) continue;

      let candidate: string;
      switch (link.type) {
        case 'FS': {
          // Two different steps, and conflating them is the defect a
          // hand-worked date caught. The successor may begin the *calendar* day
          // after the predecessor finishes — a turn of the calendar, not a day
          // of anybody's work — and the lag on top of that is working days.
          //
          // Taken as one working-day step on the predecessor's calendar, a
          // concrete cure that runs through the weekend waits until Monday for
          // a pour that finished on Friday, adding two invented days to every
          // such pair on the programme.
          const dayAfter = addCalendarDays(predFinish, 1);
          candidate = link.lag === 0 ? dayAfter : addWorkingDays(lagIndex, dayAfter, link.lag);
          break;
        }
        case 'SS':
          candidate = addWorkingDays(lagIndex, predStart, link.lag);
          break;
        case 'FF': {
          const requiredFinish = addWorkingDays(lagIndex, predFinish, link.lag);
          candidate = startOf(index, requiredFinish, remainingOf(activity));
          break;
        }
        case 'SF': {
          const requiredFinish = addWorkingDays(lagIndex, predStart, link.lag);
          candidate = startOf(index, requiredFinish, remainingOf(activity));
          break;
        }
      }
      candidate = nextWorkingDay(index, candidate);
      if (logicStart === undefined || candidate > logicStart) {
        logicStart = candidate;
        driver = link.predecessorId;
      }
    }

    let start = logicStart ?? nextWorkingDay(index, options.projectStart);

    // Nothing unstarted may be forecast into the past. The data date is the
    // whole reason a progressed programme differs from the plan it came from.
    const earliestPermitted = nextWorkingDay(index, dataDate);
    if (status === 'IN_PROGRESS') {
      // Running work resumes at the data date at the earliest — holding its
      // remainder in the past would forecast work into days that have gone.
      //
      // But not *only* at the data date. Under retained logic an out-of-sequence
      // activity's remainder is still held behind its unfinished predecessor,
      // and pinning every running activity to the data date discarded that —
      // which made retained logic and progress override give the same answer,
      // silently, on the one case they exist to distinguish.
      start = logicStart !== undefined && logicStart > earliestPermitted ? logicStart : earliestPermitted;
    } else if (start < earliestPermitted) {
      start = earliestPermitted;
      driver = undefined;
    }

    // Constraints. A bound is applied to the pass it bounds; a mandatory date
    // overrides the logic outright, which is exactly why P6 warns about them.
    const constraint = activity.constraint;
    if (constraint) {
      const on = nextWorkingDay(index, constraint.date);
      const type = constraint.type;
      if (type === 'MANDATORY_START' || type === 'START_ON') {
        start = on;
        driver = undefined;
      } else if (type === 'START_ON_OR_AFTER' && on > start) {
        start = on;
        driver = undefined;
      } else if (type === 'FINISH_ON' || type === 'MANDATORY_FINISH') {
        start = startOf(index, previousWorkingDay(index, constraint.date), remainingOf(activity));
        driver = undefined;
      } else if (type === 'FINISH_ON_OR_AFTER') {
        const implied = startOf(index, previousWorkingDay(index, constraint.date), remainingOf(activity));
        if (implied > start) {
          start = implied;
          driver = undefined;
        }
      }
    }

    earlyStart.set(id, start);
    earlyFinish.set(id, finishOf(index, start, remainingOf(activity)));
    if (driver) drivingPredecessor.set(id, driver);
  }

  const finishDate = ids.length === 0 ? dataDate : ids.reduce((latest, id) => {
    const finish = earlyFinish.get(id) ?? dataDate;
    return finish > latest ? finish : latest;
  }, dataDate);

  // --- Backward pass ----------------------------------------------------------
  const lateFinish = new Map<string, string>();
  const lateStart = new Map<string, string>();

  for (const id of [...passOrder].reverse()) {
    const activity = byId.get(id)!;
    const index = calendarFor(activity);
    if (statusOf(activity) === 'COMPLETE') {
      lateFinish.set(id, earlyFinish.get(id)!);
      lateStart.set(id, earlyStart.get(id)!);
      continue;
    }

    let finish: string | undefined;
    for (const link of successorsOf.get(id) ?? []) {
      const successor = byId.get(link.successorId)!;
      if (options.outOfSequence === 'PROGRESS_OVERRIDE' && outOfSequence.has(link.successorId)) continue;
      const lagIndex = lagIndexFor(activity, successor);
      const succLateStart = lateStart.get(link.successorId);
      const succLateFinish = lateFinish.get(link.successorId);
      if (succLateStart === undefined || succLateFinish === undefined) continue;

      let candidate: string;
      switch (link.type) {
        case 'FS': {
          // The mirror of the forward pass: undo the lag in working days, then
          // step back one calendar day.
          const beforeLag = link.lag === 0 ? succLateStart : addWorkingDays(lagIndex, succLateStart, -link.lag);
          candidate = addCalendarDays(beforeLag, -1);
          break;
        }
        case 'SS':
          candidate = finishOf(index, addWorkingDays(lagIndex, succLateStart, -link.lag), remainingOf(activity));
          break;
        case 'FF':
          candidate = addWorkingDays(lagIndex, succLateFinish, -link.lag);
          break;
        case 'SF':
          candidate = finishOf(index, addWorkingDays(lagIndex, succLateFinish, -link.lag), remainingOf(activity));
          break;
      }
      candidate = previousWorkingDay(index, candidate);
      if (finish === undefined || candidate < finish) finish = candidate;
    }

    let late = finish ?? previousWorkingDay(index, finishDate);

    const constraint = activity.constraint;
    if (constraint) {
      const type = constraint.type;
      const on = previousWorkingDay(index, constraint.date);
      if (type === 'MANDATORY_FINISH' || type === 'FINISH_ON') {
        late = on;
      } else if (type === 'FINISH_ON_OR_BEFORE' && on < late) {
        late = on;
      } else if (type === 'MANDATORY_START' || type === 'START_ON') {
        late = finishOf(index, nextWorkingDay(index, constraint.date), remainingOf(activity));
      } else if (type === 'START_ON_OR_BEFORE') {
        const implied = finishOf(index, nextWorkingDay(index, constraint.date), remainingOf(activity));
        if (implied < late) late = implied;
      } else if (type === 'AS_LATE_AS_POSSIBLE') {
        // ALAP consumes its own free float: the activity is pushed to the last
        // date that disturbs nothing downstream, which is what the backward
        // pass already computed.
        late = finish ?? late;
      }
    }

    lateFinish.set(id, late);
    lateStart.set(id, startOf(index, late, remainingOf(activity)));
  }

  // --- Float and the longest path ---------------------------------------------
  const scheduled: ScheduledActivityDates[] = activities.map((activity) => {
    const index = calendarFor(activity);
    const es = earlyStart.get(activity.id)!;
    const ef = earlyFinish.get(activity.id)!;
    const ls = lateStart.get(activity.id)!;
    const lf = lateFinish.get(activity.id)!;
    const status = statusOf(activity);
    const totalFloat = status === 'COMPLETE' ? 0 : workingDaysBetween(index, es, ls);

    const successors = successorsOf.get(activity.id) ?? [];
    const freeFloat =
      status === 'COMPLETE'
        ? 0
        : successors.length === 0
          ? totalFloat
          : Math.min(
              ...successors.map((link) => {
                const succEarlyStart = earlyStart.get(link.successorId);
                if (succEarlyStart === undefined || link.type !== 'FS') return totalFloat;
                const lagIndex = lagIndexFor(activity, byId.get(link.successorId)!);
                const beforeLag = link.lag === 0 ? succEarlyStart : addWorkingDays(lagIndex, succEarlyStart, -link.lag);
                const availableTo = previousWorkingDay(index, addCalendarDays(beforeLag, -1));
                return workingDaysBetween(index, ef, availableTo);
              }),
            );

    return {
      ...activity,
      earlyStart: es,
      earlyFinish: ef,
      lateStart: ls,
      lateFinish: lf,
      totalFloat,
      freeFloat: Math.max(0, Math.min(freeFloat, totalFloat)),
      critical: status !== 'COMPLETE' && totalFloat <= FLOAT_TOLERANCE,
      longestPath: false,
      status,
      outOfSequence: outOfSequence.has(activity.id),
      ...(drivingPredecessor.has(activity.id) ? { drivingPredecessorId: drivingPredecessor.get(activity.id)! } : {}),
    };
  });

  // The longest path: traced back through the driving relationships from
  // whatever actually finishes last. With one calendar and no constraints it is
  // the same set as float ≤ 0; with either, it is not, and it is the one a
  // planner needs — the chain that moves the finish date if it slips.
  const byIdScheduled = new Map(scheduled.map((activity) => [activity.id, activity]));
  const last = scheduled
    .filter((activity) => activity.status !== 'COMPLETE')
    .reduce<ScheduledActivityDates | undefined>(
      (latest, activity) => (latest === undefined || activity.earlyFinish > latest.earlyFinish ? activity : latest),
      undefined,
    );
  const longestPath: string[] = [];
  let cursor = last?.id;
  const walked = new Set<string>();
  while (cursor && !walked.has(cursor)) {
    walked.add(cursor);
    const activity = byIdScheduled.get(cursor);
    if (!activity) break;
    activity.longestPath = true;
    longestPath.push(cursor);
    cursor = drivingPredecessor.get(cursor);
  }
  longestPath.reverse();

  const criticalPath = scheduled
    .filter((activity) => activity.critical)
    .sort((a, b) => (a.earlyStart < b.earlyStart ? -1 : a.earlyStart > b.earlyStart ? 1 : a.id < b.id ? -1 : 1))
    .map((activity) => activity.id);

  const constraintDriven = scheduled
    .filter((activity) => activity.constraint !== undefined)
    .map((activity) => ({
      id: activity.id,
      name: activity.name,
      constraint: activity.constraint!.type,
      date: activity.constraint!.date.slice(0, 10),
      totalFloat: activity.totalFloat,
    }));

  const defaultIndex = compiled.get(options.defaultCalendarId)!;
  return {
    activities: scheduled,
    finishDate,
    remainingDurationDays: Math.max(0, workingDaysBetween(defaultIndex, dataDate, finishDate)),
    criticalPath,
    longestPath,
    cycles,
    constraintDriven,
    outOfSequenceCount: outOfSequence.size,
    options,
  };
}

// --- The breakdown ------------------------------------------------------------

export type WBSNode = {
  path: string;
  /** Direct and inherited activity ids, so a branch total includes its children. */
  activityIds: string[];
  earlyStart: string;
  earlyFinish: string;
  /** The worst float anywhere in the branch — the one that decides its health. */
  totalFloat: number;
  /** Weighted by duration, because a two-day task is not half a forty-day one. */
  percentComplete: number;
  activities: number;
  complete: number;
};

/**
 * Roll a schedule up its breakdown.
 *
 * Every branch reports the span of everything beneath it, its worst float, and
 * a duration-weighted percent complete. Weighted, because counting activities
 * makes a two-day snagging item worth as much as a forty-day pour, and a
 * programme reported that way says it is halfway through when it has done a
 * tenth of the work.
 */
export function rollUpWBS(result: ScheduleResult): WBSNode[] {
  const nodes = new Map<string, ScheduledActivityDates[]>();
  for (const activity of result.activities) {
    if (!activity.wbsPath) continue;
    const parts = activity.wbsPath.split('.');
    // Every ancestor, so `1.2.3` contributes to `1`, `1.2` and `1.2.3`.
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const path = parts.slice(0, depth).join('.');
      nodes.set(path, [...(nodes.get(path) ?? []), activity]);
    }
  }

  return [...nodes.entries()]
    .map(([path, activities]) => {
      const totalDuration = activities.reduce((sum, activity) => sum + Math.max(activity.duration, 0), 0);
      const doneDuration = activities.reduce(
        (sum, activity) => sum + Math.max(activity.duration, 0) * ((activity.percentComplete ?? (activity.status === 'COMPLETE' ? 100 : 0)) / 100),
        0,
      );
      return {
        path,
        activityIds: activities.map((activity) => activity.id),
        earlyStart: activities.reduce((min, a) => (a.earlyStart < min ? a.earlyStart : min), activities[0]!.earlyStart),
        earlyFinish: activities.reduce((max, a) => (a.earlyFinish > max ? a.earlyFinish : max), activities[0]!.earlyFinish),
        totalFloat: activities.reduce((worst, a) => Math.min(worst, a.totalFloat), Number.POSITIVE_INFINITY),
        percentComplete: totalDuration > 0 ? Math.round((doneDuration / totalDuration) * 1000) / 10 : 0,
        activities: activities.length,
        complete: activities.filter((a) => a.status === 'COMPLETE').length,
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : 1));
}

// --- Multiple float paths -------------------------------------------------------

export type FloatPath = {
  /** 1 is the chain that sets the finish date. */
  rank: number;
  /** The chain in date order. */
  activityIds: string[];
  /** The float that governs the whole chain — its worst. */
  totalFloat: number;
  earlyStart: string;
  earlyFinish: string;
  /**
   * Where this chain runs into a more critical one.
   *
   * The number that matters. A chain with four days of float that merges into
   * the critical path is four days from becoming the critical path; the same
   * float on a chain that merges into nothing until the end is a different
   * risk entirely, and a single float column cannot tell them apart.
   */
  mergesInto?: { rank: number; activityId: string };
};

/**
 * The chains behind the critical path, ranked.
 *
 * A single critical path answers "what is driving the finish date today" and
 * nothing else. The question a planner actually has is "what drives it next" —
 * because a chain with three days of float becomes the critical path on the
 * fourth day of a delay, and by then the argument about who caused it is
 * already lost. P6 calls this multiple float path analysis and it is the
 * feature planners move tools to get.
 *
 * Ranked by float rather than by the free-float chaining P6 also offers. Float
 * is what a planner reads off the screen and what an extension of time is
 * argued in; ranking by anything else would produce a table whose order needed
 * explaining before it could be used.
 *
 * Every path is a chain of *driving* relationships, so it reads as a sequence of
 * work rather than a bag of activities that happen to share a float value —
 * those are two different things and only the first can be walked through with a
 * subcontractor.
 */
export function floatPaths(
  result: ScheduleResult,
  relationships: ScheduleRelationship[],
  limit = 10,
): FloatPath[] {
  const byId = new Map(result.activities.map((activity) => [activity.id, activity]));

  // Every successor, driving or not. The merge point is by definition a *non*-
  // driving link — if it were driving, the chain would be part of the path it
  // merges into rather than a separate one — so the driving map alone can never
  // find it, and a version built on it reports every chain as merging into
  // nothing.
  const successorsOf = new Map<string, string[]>();
  for (const link of relationships) {
    successorsOf.set(link.predecessorId, [...(successorsOf.get(link.predecessorId) ?? []), link.successorId]);
  }

  // Driving successors: the reverse of the driving-predecessor map the forward
  // pass already worked out. An activity can drive several.
  const drivenBy = new Map<string, string[]>();
  for (const activity of result.activities) {
    const driver = activity.drivingPredecessorId;
    if (driver === undefined) continue;
    drivenBy.set(driver, [...(drivenBy.get(driver) ?? []), activity.id]);
  }

  const rankOf = new Map<string, number>();
  const paths: FloatPath[] = [];

  const chainFrom = (seedId: string): string[] => {
    // Back through the drivers, then forward through what this drives, stopping
    // at anything already claimed by a more critical path — that activity is
    // where this chain merges, and it belongs to the path that claimed it.
    const chain: string[] = [];
    let cursor: string | undefined = seedId;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor) && !rankOf.has(cursor) && byId.has(cursor)) {
      seen.add(cursor);
      chain.unshift(cursor);
      cursor = byId.get(cursor)!.drivingPredecessorId;
    }
    cursor = seedId;
    seen.clear();
    seen.add(seedId);
    for (;;) {
      // Where an activity drives several, follow the tightest — least float,
      // and the later finish where they tie. Consistent with how the paths
      // themselves are ranked, and it keeps a chain running into the branch
      // that will bite first rather than the one that merely runs longest.
      // The branches not taken are not lost: each becomes a path of its own at
      // the rank its own float earns.
      const next: string | undefined = (drivenBy.get(cursor!) ?? [])
        .filter((id) => !rankOf.has(id) && !seen.has(id))
        .sort(
          (a, b) =>
            byId.get(a)!.totalFloat - byId.get(b)!.totalFloat ||
            byId.get(b)!.earlyFinish.localeCompare(byId.get(a)!.earlyFinish),
        )[0];
      if (next === undefined) break;
      seen.add(next);
      chain.push(next);
      cursor = next;
    }
    return chain;
  };

  const record = (chain: string[], rank: number) => {
    if (chain.length === 0) return;
    for (const id of chain) rankOf.set(id, rank);
    const members = chain.map((id) => byId.get(id)!);

    // The merge point: where this chain runs into work a more critical path
    // already claimed. Taken from anywhere along the chain, not only its end —
    // a chain often continues past the activity that feeds the critical path
    // into a tail of its own, and it is the feed that carries the risk.
    const mergeId = chain
      .flatMap((id) => successorsOf.get(id) ?? [])
      .filter((id) => rankOf.get(id) !== undefined && rankOf.get(id)! < rank)
      .sort((a, b) => rankOf.get(a)! - rankOf.get(b)!)[0];

    paths.push({
      rank,
      activityIds: chain,
      totalFloat: members.reduce((worst, activity) => Math.min(worst, activity.totalFloat), Number.POSITIVE_INFINITY),
      earlyStart: members.reduce((min, a) => (a.earlyStart < min ? a.earlyStart : min), members[0]!.earlyStart),
      earlyFinish: members.reduce((max, a) => (a.earlyFinish > max ? a.earlyFinish : max), members[0]!.earlyFinish),
      ...(mergeId ? { mergesInto: { rank: rankOf.get(mergeId)!, activityId: mergeId } } : {}),
    });
  };

  // Path 1 is the longest path — the chain that moves the finish date — and not
  // "everything at zero float", which with calendars or constraints in play is a
  // different and larger set.
  record(result.longestPath.filter((id) => byId.has(id)), 1);

  for (let rank = paths.length + 1; rank <= limit; rank += 1) {
    const seed = result.activities
      .filter((activity) => !rankOf.has(activity.id) && activity.status !== 'COMPLETE')
      .sort(
        (a, b) =>
          a.totalFloat - b.totalFloat ||
          b.earlyFinish.localeCompare(a.earlyFinish) ||
          (a.id < b.id ? -1 : 1),
      )[0];
    if (seed === undefined) break;
    record(chainFrom(seed.id), rank);
  }

  return paths;
}
