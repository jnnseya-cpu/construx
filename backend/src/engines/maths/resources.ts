import { DomainError } from '../../core/errors.ts';
import {
  addWorkingDays,
  compileAll,
  finishOf,
  nextWorkingDay,
  workingDaysBetween,
  type CalendarIndex,
  type WorkCalendar,
} from './calendar.ts';
import type { ScheduledActivityDates, ScheduleResult } from './schedule.ts';

/**
 * Resources: what the programme needs, and whether it can be had.
 *
 * A critical path assumes infinite resource. It will happily put two pours side
 * by side that need the same gang, and report a date nobody can hit. This is the
 * arithmetic that says so.
 *
 * Three things, and they are deliberately separate:
 *
 * - the **histogram**, which is demand against availability, day by day. It
 *   reports overallocation and never smooths it;
 * - **levelling**, which delays work into its own float until the demand fits;
 * - what levelling **could not fix**, which is the answer that matters — a
 *   leveller that always succeeds has either extended the programme without
 *   saying so or quietly lifted the limit.
 */

export const RESOURCE_TYPE = {
  LABOUR: {
    label: 'Labour',
    matters: 'A gang is the commonest constraint on a construction programme and the one most often assumed away.',
  },
  PLANT: {
    label: 'Plant',
    matters: 'A crane or a piling rig is one item on hire. Two activities that need it at once is a programme that will not run.',
  },
  MATERIAL: {
    label: 'Material',
    matters:
      'Consumed rather than occupied. A limit here is a delivery rate — how much can arrive in a day — not how many ' +
      'of a thing exist.',
  },
  SUBCONTRACT: {
    label: 'Subcontract',
    matters: 'A trade contractor’s own capacity, which the main programme borrows and rarely asks about.',
  },
} as const;

export type ResourceType = keyof typeof RESOURCE_TYPE;

export type Resource = {
  id: string;
  name: string;
  type: ResourceType;
  /** What one unit is: a gang, a rig, a tonne a day. */
  unit: string;
  /**
   * How many units are available on any working day.
   *
   * A limit, not a plan. Nothing here reduces demand to fit it — exceeding it is
   * reported, because a resource curve quietly smoothed to its limit is a
   * programme that has been made to look achievable rather than made achievable.
   */
  availablePerDay: number;
};

export type ResourceAssignment = {
  activityId: string;
  resourceId: string;
  /** Units this activity occupies on each of its working days. */
  unitsPerDay: number;
};

// --- The histogram --------------------------------------------------------------

export type ResourceDay = {
  date: string;
  demand: number;
  available: number;
  /** Demand above availability. Zero where it fits. */
  over: number;
  activityIds: string[];
};

export type ResourceProfile = {
  resourceId: string;
  name: string;
  type: ResourceType;
  unit: string;
  availablePerDay: number;
  days: ResourceDay[];
  peakDemand: number;
  peakDate?: string;
  /** Working days on which demand exceeds what is available. */
  overallocatedDays: number;
  /** Unit-days of demand that cannot be met — the size of the problem, not just its length. */
  shortfallUnitDays: number;
  /** Unit-days actually required across the programme. */
  totalUnitDays: number;
};

/**
 * Demand against availability, day by day.
 *
 * Counted on each activity's **own** calendar. An activity on a seven-day
 * calendar puts demand on a Saturday and one on a five-day calendar does not,
 * and rolling both onto a single project calendar either invents weekend demand
 * or hides it — which are the two ways a resource histogram lies.
 */
export function resourceHistogram(
  result: ScheduleResult,
  assignments: ResourceAssignment[],
  resources: Resource[],
  calendars: WorkCalendar[],
): ResourceProfile[] {
  const byId = new Map(result.activities.map((activity) => [activity.id, activity]));
  const compiled = compiledFor(result, calendars);

  const demand = new Map<string, Map<string, { units: number; activityIds: string[] }>>();
  for (const assignment of assignments) {
    const activity = byId.get(assignment.activityId);
    if (!activity) continue;
    if (assignment.unitsPerDay <= 0) continue;
    const index = compiled.get(activity.calendarId);
    if (!index) {
      throw new DomainError(
        'RESOURCE_CALENDAR_MISSING',
        `Activity ${activity.name} is on calendar ${activity.calendarId}, which was not supplied. Demand cannot be ` +
          'counted without knowing which days it works.',
      );
    }

    const perResource = demand.get(assignment.resourceId) ?? new Map();
    demand.set(assignment.resourceId, perResource);
    for (const date of workingDatesOf(index, activity)) {
      const cell = perResource.get(date) ?? { units: 0, activityIds: [] };
      cell.units += assignment.unitsPerDay;
      cell.activityIds.push(activity.id);
      perResource.set(date, cell);
    }
  }

  return resources.map((resource) => {
    const perResource = demand.get(resource.id) ?? new Map();
    const days: ResourceDay[] = [...perResource.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, cell]) => ({
        date,
        demand: round(cell.units),
        available: resource.availablePerDay,
        over: round(Math.max(0, cell.units - resource.availablePerDay)),
        activityIds: cell.activityIds,
      }));

    const peak = days.reduce<ResourceDay | undefined>(
      (worst, day) => (worst === undefined || day.demand > worst.demand ? day : worst),
      undefined,
    );

    return {
      resourceId: resource.id,
      name: resource.name,
      type: resource.type,
      unit: resource.unit,
      availablePerDay: resource.availablePerDay,
      days,
      peakDemand: peak?.demand ?? 0,
      ...(peak ? { peakDate: peak.date } : {}),
      overallocatedDays: days.filter((day) => day.over > 0).length,
      shortfallUnitDays: round(days.reduce((sum, day) => sum + day.over, 0)),
      totalUnitDays: round(days.reduce((sum, day) => sum + day.demand, 0)),
    };
  });
}

// --- Levelling ------------------------------------------------------------------

export type LevelledActivity = {
  activityId: string;
  name: string;
  /** Working days the activity was pushed back, on its own calendar. */
  delayDays: number;
  originalStart: string;
  levelledStart: string;
  levelledFinish: string;
  /** Float left after the delay. Zero means it is now critical. */
  remainingFloat: number;
};

export type LevellingResult = {
  levelled: LevelledActivity[];
  /**
   * Work that will not fit inside its own float however it is moved.
   *
   * The answer that matters. A leveller reporting nothing here has either
   * extended the programme without saying so or lifted the limit, and both are
   * decisions somebody else has to make.
   */
  unresolved: Array<{
    activityId: string;
    name: string;
    resourceId: string;
    resourceName: string;
    totalFloat: number;
    /** Working days past its late start the activity would have to move to fit. */
    daysBeyondFloat: number;
    /**
     * Where it was put anyway — its late start, over the limit.
     *
     * Placed rather than left out: an activity dropped from the levelling
     * understates every resource day after it and makes the rest of the answer
     * optimistic. It appears here and *not* in `levelled`, because listing a
     * forced placement among the successful moves would read as a programme
     * that levelled when it did not.
     */
    placedAt: string;
  }>;
  /** Peak demand per resource before and after, so the smoothing is visible. */
  peaks: Array<{ resourceId: string; name: string; before: number; after: number; availablePerDay: number }>;
  /** True where every resource fits its limit once the levelling is applied. */
  fits: boolean;
  /** The order activities were placed in, and why. Stated because it changes the answer. */
  priorityRule: string;
};

/**
 * Delay work into its own float until the demand fits.
 *
 * A serial placement: activities are taken in priority order and each is put at
 * the earliest working day, on or after its early start, where every resource it
 * needs has room for the whole of its remaining duration.
 *
 * **It never moves an activity past its late finish.** Levelling inside float
 * rearranges work; levelling beyond it changes the completion date, and that is a
 * commercial decision rather than an arithmetic one. What will not fit is
 * reported with the number of days it would take, so somebody can decide whether
 * to hire more, resequence, or accept the date.
 *
 * **The priority rule is stated rather than hidden.** Least float first, then the
 * earliest start, then the id for a stable answer. Two levellers with different
 * priority rules give different programmes from the same inputs, and a tool that
 * does not say which it used has made the choice on the planner's behalf.
 */
export function levelResources(
  result: ScheduleResult,
  assignments: ResourceAssignment[],
  resources: Resource[],
  calendars: WorkCalendar[],
): LevellingResult {
  const compiled = compiledFor(result, calendars);
  const resourceById = new Map(resources.map((resource) => [resource.id, resource]));
  const assignmentsOf = new Map<string, ResourceAssignment[]>();
  for (const assignment of assignments) {
    if (assignment.unitsPerDay <= 0) continue;
    if (!resourceById.has(assignment.resourceId)) continue;
    assignmentsOf.set(assignment.activityId, [...(assignmentsOf.get(assignment.activityId) ?? []), assignment]);
  }

  const before = resourceHistogram(result, assignments, resources, calendars);

  // Committed demand, built up as activities are placed. Only what has been
  // placed counts: an activity still to be placed has no claim on a day.
  const committed = new Map<string, Map<string, number>>();
  const claim = (resourceId: string, date: string, units: number) => {
    const perResource = committed.get(resourceId) ?? new Map<string, number>();
    committed.set(resourceId, perResource);
    perResource.set(date, (perResource.get(date) ?? 0) + units);
  };
  const roomFor = (resourceId: string, dates: string[], units: number): boolean => {
    const limit = resourceById.get(resourceId)!.availablePerDay;
    const perResource = committed.get(resourceId);
    return dates.every((date) => (perResource?.get(date) ?? 0) + units <= limit + TOLERANCE);
  };

  // Work that has already started or finished is where it is. Levelling an
  // actual date would be rewriting history to make an arithmetic problem go
  // away — so it is committed *first*, before anything is placed, and the rest
  // of the programme is arranged around it. Leaving it in the priority queue
  // was the defect: a started activity sorted behind an unstarted one had its
  // days handed out to work that could have gone elsewhere.
  const fixed = result.activities.filter(
    (activity) => activity.status === 'COMPLETE' || activity.actualStart !== undefined,
  );
  for (const activity of fixed) {
    const index = compiled.get(activity.calendarId)!;
    for (const need of assignmentsOf.get(activity.id) ?? []) {
      for (const date of workingDatesOf(index, activity)) claim(need.resourceId, date, need.unitsPerDay);
    }
  }
  const fixedIds = new Set(fixed.map((activity) => activity.id));

  const order = [...result.activities]
    .filter((activity) => !fixedIds.has(activity.id))
    .sort(
      (a, b) =>
        a.totalFloat - b.totalFloat ||
        a.earlyStart.localeCompare(b.earlyStart) ||
        (a.id < b.id ? -1 : 1),
    );

  const levelled: LevelledActivity[] = [];
  const unresolved: LevellingResult['unresolved'] = [];

  for (const activity of order) {
    const needs = assignmentsOf.get(activity.id) ?? [];
    const index = compiled.get(activity.calendarId)!;
    if (needs.length === 0) continue;

    const duration = durationOf(activity);
    const latestStart = activity.lateStart;
    let start = activity.earlyStart;
    let placed = false;
    let blockedBy: ResourceAssignment | undefined;

    // Walk forward one working day at a time. Bounded by the late start, so a
    // network that cannot be levelled costs a walk across the float rather than
    // across the programme.
    for (;;) {
      const dates = datesFrom(index, start, duration);
      blockedBy = needs.find((need) => !roomFor(need.resourceId, dates, need.unitsPerDay));
      if (blockedBy === undefined) {
        placed = true;
        break;
      }
      if (start >= latestStart) break;
      start = addWorkingDays(index, start, 1);
    }

    if (placed) {
      const dates = datesFrom(index, start, duration);
      for (const need of needs) for (const date of dates) claim(need.resourceId, date, need.unitsPerDay);
      const delayDays = workingDaysBetween(index, activity.earlyStart, start);
      if (delayDays > 0) {
        levelled.push({
          activityId: activity.id,
          name: activity.name,
          delayDays,
          originalStart: activity.earlyStart,
          levelledStart: start,
          levelledFinish: dates[dates.length - 1] ?? start,
          remainingFloat: Math.max(0, activity.totalFloat - delayDays),
        });
      }
      continue;
    }

    // It does not fit inside its float. Find out by how much, then place it at
    // its late start anyway — leaving it unplaced would understate every
    // downstream resource day and make the rest of the answer optimistic.
    let trial = latestStart;
    let beyond = 0;
    const blocked = blockedBy!;
    for (; beyond < MAX_BEYOND; beyond += 1) {
      const dates = datesFrom(index, trial, duration);
      if (needs.every((need) => roomFor(need.resourceId, dates, need.unitsPerDay))) break;
      trial = addWorkingDays(index, trial, 1);
    }
    unresolved.push({
      activityId: activity.id,
      name: activity.name,
      resourceId: blocked.resourceId,
      resourceName: resourceById.get(blocked.resourceId)!.name,
      totalFloat: activity.totalFloat,
      daysBeyondFloat: beyond,
      placedAt: latestStart,
    });

    const dates = datesFrom(index, latestStart, duration);
    for (const need of needs) for (const date of dates) claim(need.resourceId, date, need.unitsPerDay);
  }

  const peaks = resources.map((resource) => {
    const perResource = committed.get(resource.id);
    const after = perResource === undefined ? 0 : Math.max(0, ...perResource.values());
    return {
      resourceId: resource.id,
      name: resource.name,
      before: before.find((profile) => profile.resourceId === resource.id)?.peakDemand ?? 0,
      after: round(after),
      availablePerDay: resource.availablePerDay,
    };
  });

  return {
    levelled: levelled.sort((a, b) => b.delayDays - a.delayDays || a.originalStart.localeCompare(b.originalStart)),
    unresolved,
    peaks,
    fits: peaks.every((peak) => peak.after <= peak.availablePerDay + TOLERANCE),
    priorityRule: 'Least total float first, then the earliest start, then the activity id.',
  };
}

// --- Shared -----------------------------------------------------------------------

const TOLERANCE = 1e-6;

/** How far past its late start a levelling walk will look before giving up. */
const MAX_BEYOND = 400;

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function durationOf(activity: ScheduledActivityDates): number {
  return Math.max(1, Math.round(activity.remainingDuration ?? activity.duration));
}

function compiledFor(result: ScheduleResult, calendars: WorkCalendar[]): Map<string, CalendarIndex> {
  // A span wide enough for the programme plus room to level into. Compiling to
  // the finish date exactly would put a levelling walk off the end of the index.
  const dates = result.activities.flatMap((activity) => [activity.earlyStart, activity.lateFinish, activity.earlyFinish]);
  const from = dates.reduce((min, date) => (date < min ? date : min), result.options.dataDate);
  const to = dates.reduce((max, date) => (date > max ? date : max), result.finishDate);
  return compileAll(calendars, shift(from, -400), shift(to, 800));
}

function shift(iso: string, days: number): string {
  const at = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** Every working day an activity occupies, on its own calendar. */
function workingDatesOf(index: CalendarIndex, activity: ScheduledActivityDates): string[] {
  const dates: string[] = [];
  let cursor = nextWorkingDay(index, activity.earlyStart);
  const last = activity.earlyFinish;
  while (cursor <= last) {
    dates.push(cursor);
    cursor = addWorkingDays(index, cursor, 1);
  }
  return dates;
}

function datesFrom(index: CalendarIndex, start: string, durationDays: number): string[] {
  const first = nextWorkingDay(index, start);
  const last = finishOf(index, first, durationDays);
  const dates: string[] = [];
  let cursor = first;
  while (cursor <= last) {
    dates.push(cursor);
    cursor = addWorkingDays(index, cursor, 1);
  }
  return dates;
}
