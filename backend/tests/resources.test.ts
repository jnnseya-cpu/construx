import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { CONTINUOUS_CALENDAR, STANDARD_CALENDAR } from '../src/engines/maths/calendar.ts';
import {
  levelResources,
  resourceHistogram,
  type Resource,
  type ResourceAssignment,
} from '../src/engines/maths/resources.ts';
import {
  schedule,
  type ScheduleActivity,
  type ScheduleOptions,
  type ScheduleRelationship,
} from '../src/engines/maths/schedule.ts';

/**
 * Resources, and whether the programme can be built with what there is.
 *
 * The reference week again: **2026-06-01 is a Monday.** Every date below is
 * counted rather than looked up, for the reason the schedule suite gives — a
 * resource curve checked only against itself proves the code is consistent, and
 * a calendar bug moves demand onto a weekend where it stays invisible.
 */

const MONDAY = '2026-06-01';

const options = (over: Partial<ScheduleOptions> = {}): ScheduleOptions => ({
  dataDate: MONDAY,
  outOfSequence: 'RETAINED_LOGIC',
  lagCalendar: 'PREDECESSOR',
  defaultCalendarId: STANDARD_CALENDAR.id,
  projectStart: MONDAY,
  ...over,
});

const task = (id: string, duration: number, over: Partial<ScheduleActivity> = {}): ScheduleActivity => ({
  id,
  name: `Activity ${id}`,
  type: 'TASK_DEPENDENT',
  duration,
  calendarId: STANDARD_CALENDAR.id,
  ...over,
});

const fs = (predecessorId: string, successorId: string, lag = 0): ScheduleRelationship => ({
  predecessorId,
  successorId,
  type: 'FS',
  lag,
});

const GANG: Resource = { id: 'GANG', name: 'Concrete gang', type: 'LABOUR', unit: 'gang', availablePerDay: 1 };
const CRANE: Resource = { id: 'CRANE', name: '80t crawler crane', type: 'PLANT', unit: 'crane', availablePerDay: 1 };

const needs = (activityId: string, resourceId: string, unitsPerDay = 1): ResourceAssignment => ({
  activityId,
  resourceId,
  unitsPerDay,
});

const calendars = [STANDARD_CALENDAR, CONTINUOUS_CALENDAR];

// ── Demand against availability ─────────────────────────────────────────────

describe('what the programme asks for, day by day', () => {
  it('adds two activities that overlap and reports the day it cannot be done', () => {
    // A and B both run Mon 01 → Wed 03 June and both want the gang. There is
    // one gang. The critical path is delighted; the site foreman is not.
    const result = schedule([task('A', 3), task('B', 3)], [], [STANDARD_CALENDAR], options());
    const [profile] = resourceHistogram(result, [needs('A', 'GANG'), needs('B', 'GANG')], [GANG], calendars);

    assert.equal(profile!.days.length, 3, 'three working days, Monday to Wednesday');
    assert.deepEqual(
      profile!.days.map((day) => day.date),
      ['2026-06-01', '2026-06-02', '2026-06-03'],
    );
    assert.equal(profile!.peakDemand, 2);
    assert.equal(profile!.peakDate, '2026-06-01');
    assert.equal(profile!.overallocatedDays, 3);
    assert.equal(profile!.shortfallUnitDays, 3, 'one gang short on each of three days');
    assert.equal(profile!.totalUnitDays, 6);
  });

  it('never smooths the curve to fit the limit', () => {
    // The single most common way a resource histogram lies: demand drawn at the
    // availability line because that is what will fit. A programme made to look
    // achievable is not a programme made achievable.
    const result = schedule([task('A', 2), task('B', 2), task('C', 2)], [], [STANDARD_CALENDAR], options());
    const [profile] = resourceHistogram(
      result,
      [needs('A', 'GANG'), needs('B', 'GANG'), needs('C', 'GANG')],
      [GANG],
      calendars,
    );
    assert.equal(profile!.days[0]!.demand, 3, 'reported as three, not clipped to one');
    assert.equal(profile!.days[0]!.available, 1);
    assert.equal(profile!.days[0]!.over, 2);
  });

  it('counts demand on each activity’s own calendar, not on one project calendar', () => {
    // A cure runs through the weekend and a pour does not. Rolling both onto a
    // five-day calendar hides the Saturday; rolling both onto a seven-day one
    // invents a Saturday gang. Both are wrong and only one is obvious.
    const result = schedule(
      // Five working days on a five-day calendar is Mon to Fri and never reaches
      // the weekend, so the seven-day activity is given seven: Mon 01 to Sun 07.
      [task('WEEKDAY', 5), task('CONTINUOUS', 7, { calendarId: CONTINUOUS_CALENDAR.id })],
      [],
      calendars,
      options(),
    );
    const [profile] = resourceHistogram(
      result,
      [needs('WEEKDAY', 'GANG'), needs('CONTINUOUS', 'GANG')],
      [GANG],
      calendars,
    );

    const saturday = profile!.days.find((day) => day.date === '2026-06-06');
    assert.ok(saturday, 'the seven-day activity puts demand on the Saturday');
    assert.equal(saturday!.demand, 1, 'and only the seven-day one does');
    assert.deepEqual(saturday!.activityIds, ['CONTINUOUS']);

    const monday = profile!.days.find((day) => day.date === '2026-06-01')!;
    assert.equal(monday.demand, 2, 'both work the Monday');
  });

  it('reports a resource nothing asks for rather than leaving it out', () => {
    // A resource with no demand and a resource that was never set up look
    // identical on a chart that only draws what has demand.
    const result = schedule([task('A', 3)], [], [STANDARD_CALENDAR], options());
    const profiles = resourceHistogram(result, [needs('A', 'GANG')], [GANG, CRANE], calendars);
    assert.equal(profiles.length, 2);
    const crane = profiles.find((profile) => profile.resourceId === 'CRANE')!;
    assert.deepEqual(crane.days, []);
    assert.equal(crane.peakDemand, 0);
    assert.equal(crane.totalUnitDays, 0);
  });

  it('refuses to count demand for an activity on a calendar nobody supplied', () => {
    const result = schedule([task('A', 3, { calendarId: 'NIGHT_SHIFT' })], [], [
      { ...STANDARD_CALENDAR, id: 'NIGHT_SHIFT' },
      STANDARD_CALENDAR,
    ], options());
    throwsCode(
      () => resourceHistogram(result, [needs('A', 'GANG')], [GANG], [STANDARD_CALENDAR]),
      'RESOURCE_CALENDAR_MISSING',
    );
  });
});

// ── Levelling ───────────────────────────────────────────────────────────────

describe('delaying work into its own float until it fits', () => {
  it('moves the one with float and leaves the critical one alone', () => {
    // A (3d) → C (3d) is the critical chain: Mon 01 → Wed 03, then Thu 04 → Mon 08.
    // B (3d) has nothing after it, so it has float. Both A and B want the gang
    // on the Monday. B is the one that moves.
    const result = schedule([task('A', 3), task('B', 3), task('C', 3)], [fs('A', 'C')], [STANDARD_CALENDAR], options());
    const at = (id: string) => result.activities.find((a) => a.id === id)!;
    assert.equal(at('A').totalFloat, 0);
    assert.equal(at('B').totalFloat, 3, 'B has the three days A and C take after it');

    // C is a different trade and wants nothing from the gang.
    const levelling = levelResources(result, [needs('A', 'GANG'), needs('B', 'GANG')], [GANG], calendars);

    assert.equal(levelling.fits, true, 'one gang, one activity at a time');
    assert.deepEqual(levelling.unresolved, []);
    const moved = levelling.levelled.find((entry) => entry.activityId === 'B')!;
    assert.equal(moved.delayDays, 3, 'B waits for A to finish with the gang');
    assert.equal(moved.levelledStart, '2026-06-04');
    assert.equal(levelling.levelled.some((entry) => entry.activityId === 'A'), false, 'the critical one did not move');
    assert.deepEqual(levelling.peaks, [{ resourceId: 'GANG', name: 'Concrete gang', before: 2, after: 1, availablePerDay: 1 }]);
  });

  it('says what will not fit inside its float, and where it put it anyway', () => {
    // A (3d) → C (3d) is the critical chain and both want the gang: A takes
    // Mon 01 → Wed 03 and C takes Thu 04 → Mon 08. B also wants it and has three
    // days of float, which run out on Thursday — exactly when C has the gang.
    // Nine days of gang work will not go into six days of one gang, and no
    // rearrangement inside the float changes that.
    const result = schedule([task('A', 3), task('B', 3), task('C', 3)], [fs('A', 'C')], [STANDARD_CALENDAR], options());
    const levelling = levelResources(
      result,
      [needs('A', 'GANG'), needs('B', 'GANG'), needs('C', 'GANG')],
      [GANG],
      calendars,
    );

    assert.equal(levelling.fits, false, 'and the answer says so rather than claiming success');
    assert.equal(levelling.unresolved.length, 1);
    assert.equal(levelling.unresolved[0]!.activityId, 'B');
    assert.equal(levelling.unresolved[0]!.totalFloat, 3);
    assert.equal(levelling.unresolved[0]!.daysBeyondFloat, 3, 'the three days C is holding the gang');
    // Put at its late start anyway, over the limit. Dropping it would understate
    // every gang-day after it and make the rest of the answer optimistic.
    assert.equal(levelling.unresolved[0]!.placedAt, '2026-06-04');
    // And it is *not* also listed among the successful moves, which would read
    // as a programme that levelled when it did not.
    assert.equal(levelling.levelled.some((entry) => entry.activityId === 'B'), false);
  });

  it('will not move an activity past its late finish to make the numbers work', () => {
    // Two activities that must both run inside the same three days and both need
    // the one crane. There is no arrangement that fits. Levelling stops at the
    // float and reports the shortfall rather than extending the programme,
    // because extending it is a commercial decision and not an arithmetic one.
    const result = schedule(
      [
        task('P', 3, { constraint: { type: 'FINISH_ON_OR_BEFORE', date: '2026-06-03' } }),
        task('Q', 3, { constraint: { type: 'FINISH_ON_OR_BEFORE', date: '2026-06-03' } }),
      ],
      [],
      [STANDARD_CALENDAR],
      options(),
    );
    const levelling = levelResources(result, [needs('P', 'CRANE'), needs('Q', 'CRANE')], [CRANE], calendars);

    assert.equal(levelling.unresolved.length, 1, 'one of the two cannot be placed');
    assert.equal(levelling.unresolved[0]!.resourceName, '80t crawler crane');
    assert.equal(levelling.unresolved[0]!.daysBeyondFloat, 3, 'it would need the three days the other is using');
    assert.equal(levelling.fits, false, 'and the answer says so rather than claiming success');
    assert.equal(levelling.levelled.length, 0, 'a forced placement is not a successful move');
  });

  it('leaves work that has already started where it is', () => {
    // Levelling an actual date would be rewriting history to make an arithmetic
    // problem go away. The started activity keeps its claim on the resource and
    // everything else works around it.
    // LONG runs to Friday the 12th and sets the project finish, so LATER has
    // float to be moved into. Without it nothing on the network can move at all
    // and the test would prove only that.
    const result = schedule(
      [task('STARTED', 3, { actualStart: '2026-06-01' }), task('LATER', 3), task('LONG', 10)],
      [],
      [STANDARD_CALENDAR],
      options(),
    );
    const levelling = levelResources(result, [needs('STARTED', 'GANG'), needs('LATER', 'GANG')], [GANG], calendars);

    assert.equal(levelling.levelled.some((entry) => entry.activityId === 'STARTED'), false);
    const later = levelling.levelled.find((entry) => entry.activityId === 'LATER')!;
    assert.equal(later.levelledStart, '2026-06-04', 'it waits for the gang the started work is holding');
  });

  it('states the priority rule rather than deciding it behind a dialog', () => {
    // Two levellers with different priority rules give different programmes from
    // the same inputs. A tool that will not say which it used has made the
    // choice on the planner's behalf.
    const result = schedule([task('A', 2), task('B', 2)], [], [STANDARD_CALENDAR], options());
    const levelling = levelResources(result, [needs('A', 'GANG'), needs('B', 'GANG')], [GANG], calendars);
    assert.match(levelling.priorityRule, /Least total float first/);
  });

  it('does nothing at all where nothing is assigned', () => {
    const result = schedule([task('A', 3), task('B', 3)], [], [STANDARD_CALENDAR], options());
    const levelling = levelResources(result, [], [GANG], calendars);
    assert.deepEqual(levelling.levelled, []);
    assert.deepEqual(levelling.unresolved, []);
    assert.equal(levelling.fits, true);
  });
});
