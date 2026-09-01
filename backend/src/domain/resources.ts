import { DomainError } from '../core/errors.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import {
  levelResources,
  resourceHistogram,
  RESOURCE_TYPE,
  type LevellingResult,
  type Resource,
  type ResourceAssignment,
  type ResourceProfile,
  type ResourceType,
} from '../engines/maths/resources.ts';
import { calendarsFor, loadProgramme, scheduleOptionsFor } from './programme.ts';
import { schedule } from '../engines/maths/schedule.ts';

/**
 * Who and what the programme needs, and whether it can be had.
 *
 * The critical path assumes infinite resource. It will put two pours side by
 * side that need the same gang and report a date nobody on site can hit, and
 * every planner knows it — which is why the resource histogram is the second
 * thing anybody opens after the Gantt.
 *
 * Built on the activity records the platform already has. A resource assignment
 * is a record against a `Task`, not a second activity model, and the demand
 * curve is computed from the live schedule rather than stored: stored demand
 * disagrees with the programme the moment a date moves, and a disagreeing
 * resource curve is worse than none because somebody will order labour off it.
 *
 * **Availability is a limit, not a plan.** Nothing here reduces demand to fit
 * it. A curve quietly drawn at the availability line is a programme made to look
 * achievable rather than made achievable, and the person it fools is the one who
 * has to build it.
 */

/** What one unit of a resource is, and how many there are on a working day. */
type ResourceState = Resource & {
  projectId: string;
  /** What one unit costs for a day, where anybody has said. Reporting only. */
  dayRateMinor?: number;
  definedBy: string;
  definedAt: string;
};

type AssignmentState = ResourceAssignment & {
  projectId: string;
  assignedBy: string;
  assignedAt: string;
};

/**
 * Define a resource, or replace one by the same id.
 *
 * Replacing rather than versioning, for the reason a calendar is replaced: the
 * availability of a gang is a statement about now, a correction to it is not a
 * second gang, and two resources differing by one unit is how half a programme
 * ends up levelled against the wrong limit.
 */
export function defineResource(
  ctx: EngineContext,
  input: {
    id: string;
    name: string;
    type: ResourceType;
    unit: string;
    availablePerDay: number;
    dayRateMinor?: number;
  },
): { resourceId: string; availablePerDay: number } {
  authorise(ctx, 'PROGRAMME_BASELINES', 'U');

  const id = input.id.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  if (!id) throw new DomainError('RESOURCE_ID_REQUIRED', 'A resource needs an id to be assigned by.');
  if (!(input.type in RESOURCE_TYPE)) {
    throw new DomainError('RESOURCE_TYPE_UNKNOWN', `${input.type} is not one of the four kinds of resource this platform counts.`);
  }
  if (!(input.availablePerDay > 0)) {
    throw new DomainError(
      'RESOURCE_AVAILABILITY_REQUIRED',
      'Say how many are available on a working day. A resource with none available makes every activity that needs ' +
        'it unschedulable, which is a different statement from not having recorded a limit yet.',
    );
  }

  const existing = ctx.ledger.get({ refType: 'Resource', refId: `${ctx.projectId}:${id}` });
  const state: ResourceState = {
    id,
    name: input.name.trim() || id,
    type: input.type,
    unit: input.unit.trim() || 'unit',
    availablePerDay: input.availablePerDay,
    ...(input.dayRateMinor !== undefined ? { dayRateMinor: Math.round(input.dayRateMinor) } : {}),
    projectId: ctx.projectId,
    definedBy: ctx.auth.actorId,
    definedAt: new Date().toISOString(),
  };

  write(ctx, {
    eventType: existing ? 'RESOURCE_UPDATED' : 'RESOURCE_DEFINED',
    entity: { refType: 'Resource', refId: `${ctx.projectId}:${id}` },
    reason: `${state.name}: ${state.availablePerDay} ${state.unit}(s) available per working day`,
    nextState: state as unknown as Record<string, unknown>,
  });

  return { resourceId: id, availablePerDay: state.availablePerDay };
}

/**
 * Put a resource on an activity, or change what it takes.
 *
 * Assigning zero removes the assignment rather than recording a demand of
 * nothing: a resource an activity does not need should not appear against it,
 * and a zero row in a demand table reads as "checked, needs none" when what
 * happened was somebody deleting it.
 */
export function assignResource(
  ctx: EngineContext,
  input: { taskId: string; resourceId: string; unitsPerDay: number },
): { taskId: string; resourceId: string; unitsPerDay: number; removed: boolean } {
  authorise(ctx, 'PROGRAMME_BASELINES', 'U');

  const task = ctx.ledger.get({ refType: 'Task', refId: input.taskId });
  if (!task || task.projectId !== ctx.projectId) {
    throw new DomainError('TASK_NOT_FOUND', `No activity ${input.taskId} on this project`, 404);
  }
  const resourceId = input.resourceId.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const resource = ctx.ledger.get({ refType: 'Resource', refId: `${ctx.projectId}:${resourceId}` });
  if (!resource) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `No resource ${resourceId} on this project. Define what it is and how many there are before putting it on an ` +
        'activity, or the demand curve has a line with no limit to compare against.',
      404,
    );
  }
  if (input.unitsPerDay < 0) {
    throw new DomainError('RESOURCE_UNITS_INVALID', 'An activity cannot take a negative amount of a resource.');
  }

  const refId = `${input.taskId}:${resourceId}`;
  const removed = input.unitsPerDay === 0;
  const state: AssignmentState = {
    activityId: input.taskId,
    resourceId,
    unitsPerDay: input.unitsPerDay,
    projectId: ctx.projectId,
    assignedBy: ctx.auth.actorId,
    assignedAt: new Date().toISOString(),
  };

  write(ctx, {
    eventType: removed ? 'RESOURCE_UNASSIGNED' : 'RESOURCE_ASSIGNED',
    entity: { refType: 'ResourceAssignment', refId },
    reason: removed
      ? `${String(resource.state.name ?? resourceId)} removed from ${String(task.state.name ?? input.taskId)}`
      : `${String(task.state.name ?? input.taskId)} takes ${input.unitsPerDay} ${String(resource.state.unit ?? 'unit')}(s) a day of ${String(resource.state.name ?? resourceId)}`,
    nextState: state as unknown as Record<string, unknown>,
  });

  return { taskId: input.taskId, resourceId, unitsPerDay: input.unitsPerDay, removed };
}

// --- Reading it -----------------------------------------------------------------

export type ResourcePosition = {
  resources: Array<{
    resourceId: string;
    name: string;
    type: ResourceType;
    typeLabel: string;
    unit: string;
    availablePerDay: number;
    dayRateMinor?: number;
    assignedActivities: number;
  }>;
  /**
   * Demand against availability, week by week rather than day by day.
   *
   * Weekly because a labour histogram of four hundred daily bars is a grey block
   * and nobody resources off it. The **peak** inside each week is carried, not
   * the average: an average hides the Tuesday that needs three gangs, which is
   * the only day on that bar anybody has to do anything about.
   */
  profiles: Array<{
    resourceId: string;
    name: string;
    type: ResourceType;
    unit: string;
    availablePerDay: number;
    peakDemand: number;
    peakDate?: string;
    overallocatedDays: number;
    shortfallUnitDays: number;
    totalUnitDays: number;
    weeks: Array<{ weekStarting: string; peak: number; available: number; over: number }>;
  }>;
  levelling?: LevellingResult;
  /** Activities the histogram covers, so an empty chart can be told from an empty programme. */
  activitiesWithResource: number;
  summary: string;
};

/**
 * The resource position: what is needed, what there is, and what levelling
 * cannot fix.
 *
 * Computed from the **live** schedule for the same reason the programme view is:
 * a stored demand curve disagrees with the programme the moment a date moves,
 * and somebody will order labour off the one that is wrong.
 */
export function resourcePosition(ctx: EngineContext, asAt?: string): ResourcePosition {
  authorise(ctx, 'PROGRAMME_BASELINES', 'R');

  const resources = ctx.ledger
    .list(ctx.projectId, 'Resource')
    .map((record) => record.state as unknown as ResourceState);

  const assignments = ctx.ledger
    .list(ctx.projectId, 'ResourceAssignment')
    .map((record) => record.state as unknown as AssignmentState)
    .filter((assignment) => assignment.unitsPerDay > 0);

  const { activities, relationships } = loadProgramme(ctx);
  const assignedActivityIds = new Set(assignments.map((assignment) => assignment.activityId));

  const catalogue = resources.map((resource) => ({
    resourceId: resource.id,
    name: resource.name,
    type: resource.type,
    typeLabel: RESOURCE_TYPE[resource.type]?.label ?? resource.type,
    unit: resource.unit,
    availablePerDay: resource.availablePerDay,
    ...(resource.dayRateMinor !== undefined ? { dayRateMinor: resource.dayRateMinor } : {}),
    assignedActivities: assignments.filter((assignment) => assignment.resourceId === resource.id).length,
  }));

  if (activities.length === 0 || resources.length === 0) {
    return {
      resources: catalogue,
      profiles: [],
      activitiesWithResource: 0,
      summary:
        activities.length === 0
          ? 'No activities have been created, so there is nothing to resource yet.'
          : 'No resources have been defined, so the programme is still assuming there is enough of everything.',
    };
  }

  const calendars = calendarsFor(ctx);
  const result = schedule(activities, relationships, calendars, scheduleOptionsFor(ctx, asAt));
  const plain: Resource[] = resources.map(({ id, name, type, unit, availablePerDay }) => ({
    id,
    name,
    type,
    unit,
    availablePerDay,
  }));
  const plainAssignments: ResourceAssignment[] = assignments.map(({ activityId, resourceId, unitsPerDay }) => ({
    activityId,
    resourceId,
    unitsPerDay,
  }));

  const profiles = resourceHistogram(result, plainAssignments, plain, calendars);
  const levelling = levelResources(result, plainAssignments, plain, calendars);

  return {
    resources: catalogue,
    profiles: profiles.map((profile) => ({
      resourceId: profile.resourceId,
      name: profile.name,
      type: profile.type,
      unit: profile.unit,
      availablePerDay: profile.availablePerDay,
      peakDemand: profile.peakDemand,
      ...(profile.peakDate ? { peakDate: profile.peakDate } : {}),
      overallocatedDays: profile.overallocatedDays,
      shortfallUnitDays: profile.shortfallUnitDays,
      totalUnitDays: profile.totalUnitDays,
      weeks: weeklyPeaks(profile),
    })),
    levelling,
    activitiesWithResource: activities.filter((activity) => assignedActivityIds.has(activity.id)).length,
    summary: summarise(profiles, levelling),
  };
}

/**
 * A week's worth of days reduced to its **peak**, not its average.
 *
 * An average smooths the Tuesday that needs three gangs into a week that needs
 * one and a half, and the Tuesday is the only thing on that bar anybody has to
 * do something about.
 */
function weeklyPeaks(profile: ResourceProfile): Array<{ weekStarting: string; peak: number; available: number; over: number }> {
  const weeks = new Map<string, { peak: number; over: number }>();
  for (const day of profile.days) {
    const week = mondayOf(day.date);
    const cell = weeks.get(week) ?? { peak: 0, over: 0 };
    if (day.demand > cell.peak) cell.peak = day.demand;
    if (day.over > cell.over) cell.over = day.over;
    weeks.set(week, cell);
  }
  return [...weeks.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([weekStarting, cell]) => ({
      weekStarting,
      peak: cell.peak,
      available: profile.availablePerDay,
      over: cell.over,
    }));
}

function mondayOf(iso: string): string {
  const at = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  // Sunday is 0; a week that starts on Sunday would split every site week in two.
  const offset = (at.getUTCDay() + 6) % 7;
  at.setUTCDate(at.getUTCDate() - offset);
  return at.toISOString().slice(0, 10);
}

function summarise(profiles: ResourceProfile[], levelling: LevellingResult): string {
  const over = profiles.filter((profile) => profile.overallocatedDays > 0);
  const parts: string[] = [];

  if (over.length === 0) {
    parts.push('Every resource fits what is available, as the programme stands.');
  } else {
    const worst = over.reduce((a, b) => (b.shortfallUnitDays > a.shortfallUnitDays ? b : a));
    parts.push(
      `${over.length} resource(s) are asked for more than there is. The worst is ${worst.name}: ` +
        `${worst.peakDemand} ${worst.unit}(s) wanted at the peak against ${worst.availablePerDay} available, over ` +
        `${worst.overallocatedDays} working day(s).`,
    );
  }

  if (levelling.levelled.length > 0) {
    parts.push(
      `${levelling.levelled.length} activity(ies) can be delayed into their own float to fit — the longest by ` +
        `${levelling.levelled[0]!.delayDays} working day(s), which uses float the programme currently shows as spare.`,
    );
  }

  if (levelling.unresolved.length > 0) {
    // The number that matters. Everything above it is arithmetic; this is a
    // decision somebody has to make.
    parts.push(
      `${levelling.unresolved.length} activity(ies) will not fit however they are moved inside their float. ` +
        'Levelling stops at the float rather than extending the completion date, because moving the date is a ' +
        'commercial decision and not an arithmetic one. Hire more, resequence, or accept the date — but the ' +
        'programme as it stands cannot be built with what has been recorded as available.',
    );
  } else if (over.length > 0) {
    parts.push('All of it fits once the work is delayed into its float, so the completion date does not move.');
  }

  return parts.join(' ');
}
