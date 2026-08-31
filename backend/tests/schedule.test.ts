import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import {
  addWorkingDays,
  compileCalendar,
  CONTINUOUS_CALENDAR,
  finishOf,
  isWorkingDay,
  nextWorkingDay,
  previousWorkingDay,
  startOf,
  STANDARD_CALENDAR,
  workingDaysBetween,
  type WorkCalendar,
} from '../src/engines/maths/calendar.ts';
import {
  rollUpWBS,
  schedule,
  type ScheduleActivity,
  type ScheduleOptions,
  type ScheduleRelationship,
} from '../src/engines/maths/schedule.ts';

/**
 * The programme, in dates.
 *
 * Every date below is worked out by hand and written into the comment, for the
 * reason the geometry suite gives: a schedule checked only against itself proves
 * the code is consistent, not that it is right. A calendar bug is invisible in a
 * self-consistent answer and moves every downstream date by a weekend.
 *
 * The reference week: **2026-06-01 is a Monday.** Every fixture is anchored to
 * it so the weekday of any date in this file can be counted rather than looked
 * up.
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

// ── The calendar ────────────────────────────────────────────────────────────

describe('working days are the days the site actually works', () => {
  const index = compileCalendar(STANDARD_CALENDAR, '2026-05-01', '2026-08-31');

  it('knows a weekend when it sees one', () => {
    // 2026-06-01 is a Monday, so the 6th is a Saturday and the 7th a Sunday.
    assert.equal(isWorkingDay(index, '2026-06-05'), true, 'Friday should be a working day');
    assert.equal(isWorkingDay(index, '2026-06-06'), false, 'Saturday should not be');
    assert.equal(isWorkingDay(index, '2026-06-07'), false, 'Sunday should not be');
    assert.equal(isWorkingDay(index, '2026-06-08'), true, 'the following Monday should be');
  });

  it('rolls a start forward and a finish back, which are opposite directions', () => {
    // Work told to start on the Saturday starts on the Monday. Work told to
    // finish on the Saturday finished on the Friday. Rolling both the same way
    // is the classic off-by-a-weekend, and it looks entirely reasonable.
    assert.equal(nextWorkingDay(index, '2026-06-06'), '2026-06-08');
    assert.equal(previousWorkingDay(index, '2026-06-06'), '2026-06-05');
    // A working day is its own answer in both directions.
    assert.equal(nextWorkingDay(index, '2026-06-03'), '2026-06-03');
    assert.equal(previousWorkingDay(index, '2026-06-03'), '2026-06-03');
  });

  it('steps over the weekend rather than through it', () => {
    // Three working days on from Thursday the 4th: Friday, Monday, Tuesday.
    assert.equal(addWorkingDays(index, '2026-06-04', 3), '2026-06-09');
    // And backwards: three before Tuesday the 9th is Thursday the 4th.
    assert.equal(addWorkingDays(index, '2026-06-09', -3), '2026-06-04');
    // Which a seven-day calendar answers differently, and that is the point.
    const continuous = compileCalendar(CONTINUOUS_CALENDAR, '2026-05-01', '2026-08-31');
    assert.equal(addWorkingDays(continuous, '2026-06-04', 3), '2026-06-07');
  });

  it('rolls a non-working base backwards before stepping back from it', () => {
    // The direction only matters when the base is not a working day, which is
    // why moving back from a Tuesday proves nothing. From Saturday the 6th,
    // one working day back is Thursday the 4th: the Saturday lands on Friday
    // the 5th first, then steps. Rolling it forward to Monday the 8th instead
    // gives Friday the 5th — one day out, on every backward-pass date.
    assert.equal(addWorkingDays(index, '2026-06-06', -1), '2026-06-04');
    assert.equal(addWorkingDays(index, '2026-06-07', -2), '2026-06-03');
    // Forwards from the same Saturday is the mirror: it lands on Monday first.
    assert.equal(addWorkingDays(index, '2026-06-06', 1), '2026-06-09');
  });

  it('counts the first day and not the second', () => {
    // Monday to Friday is four working days elapsed and five days of work.
    assert.equal(workingDaysBetween(index, '2026-06-01', '2026-06-05'), 4);
    assert.equal(workingDaysBetween(index, '2026-06-01', '2026-06-01'), 0);
    // Across a weekend: Friday to the following Monday is one.
    assert.equal(workingDaysBetween(index, '2026-06-05', '2026-06-08'), 1);
  });

  it('makes a five-day activity run Monday to Friday, not Monday to the next Monday', () => {
    // The inclusive convention every planner uses. Off by one here and every
    // activity on the programme is a day short.
    assert.equal(finishOf(index, '2026-06-01', 5), '2026-06-05');
    assert.equal(finishOf(index, '2026-06-01', 1), '2026-06-01');
    assert.equal(startOf(index, '2026-06-05', 5), '2026-06-01');
    // A milestone has no span at all.
    assert.equal(finishOf(index, '2026-06-01', 0), '2026-06-01');
  });

  it('takes a bank holiday out and puts a Saturday pour in', () => {
    const withExceptions: WorkCalendar = {
      ...STANDARD_CALENDAR,
      id: 'SITE',
      exceptions: [
        { date: '2026-06-03', working: false, reason: 'Shutdown' },
        { date: '2026-06-06', working: true, reason: 'Saturday pour' },
      ],
    };
    const site = compileCalendar(withExceptions, '2026-05-01', '2026-08-31');
    assert.equal(isWorkingDay(site, '2026-06-03'), false, 'the shutdown day was still working');
    assert.equal(isWorkingDay(site, '2026-06-06'), true, 'the Saturday pour was not a working day');

    // Three working days from Monday the 1st: Tuesday, then Wednesday is out,
    // so Thursday, then Friday. The exception moved the finish by a day.
    assert.equal(finishOf(site, '2026-06-01', 4), '2026-06-05');
    assert.equal(finishOf(index, '2026-06-01', 4), '2026-06-04');
  });

  it('refuses a date outside the span rather than guessing the working days', () => {
    throwsCode(() => isWorkingDay(index, '2027-01-01'), 'CALENDAR_OUT_OF_SPAN');
    throwsCode(() => addWorkingDays(index, '2026-08-28', 500), 'CALENDAR_OUT_OF_SPAN');
  });

  it('refuses a calendar that never works, rather than reporting infinity', () => {
    throwsCode(
      () => compileCalendar({ ...STANDARD_CALENDAR, workingWeekdays: [false, false, false, false, false, false, false] }, MONDAY, '2026-07-01'),
      'CALENDAR_NEVER_WORKS',
    );
    throwsCode(
      () => compileCalendar({ ...STANDARD_CALENDAR, workingWeekdays: [true, true, true] }, MONDAY, '2026-07-01'),
      'CALENDAR_WEEK_INVALID',
    );
  });
});

// ── The forward pass ────────────────────────────────────────────────────────

describe('the programme in dates', () => {
  it('schedules a chain across weekends', () => {
    // A: 5 days from Monday 1 June, finishing Friday the 5th.
    // B: 3 days finish-to-start after it, so Monday 8th to Wednesday 10th.
    // C: 2 days after B, Thursday 11th to Friday 12th.
    const result = schedule(
      [task('A', 5), task('B', 3), task('C', 2)],
      [fs('A', 'B'), fs('B', 'C')],
      [STANDARD_CALENDAR],
      options(),
    );
    const at = (id: string) => result.activities.find((a) => a.id === id)!;

    assert.equal(at('A').earlyStart, '2026-06-01');
    assert.equal(at('A').earlyFinish, '2026-06-05');
    assert.equal(at('B').earlyStart, '2026-06-08', 'B started on the Saturday');
    assert.equal(at('B').earlyFinish, '2026-06-10');
    assert.equal(at('C').earlyStart, '2026-06-11');
    assert.equal(at('C').earlyFinish, '2026-06-12');
    assert.equal(result.finishDate, '2026-06-12');
    // Ten working days from Monday the 1st to Friday the 12th.
    assert.equal(result.remainingDurationDays, 9);
  });

  it('applies a lag on the calendar the option names', () => {
    // A finishes Friday the 5th. A two-day lag on the five-day calendar puts B
    // on Wednesday the 10th; on a continuous calendar it puts B on Monday the
    // 8th, because the weekend counts. Two dates from one number.
    const chain = [task('A', 5), task('B', 3)];
    const link = [{ ...fs('A', 'B'), lag: 2 }];

    const fiveDay = schedule(chain, link, [STANDARD_CALENDAR, CONTINUOUS_CALENDAR], options());
    assert.equal(fiveDay.activities.find((a) => a.id === 'B')!.earlyStart, '2026-06-10');

    const continuous = schedule(chain, link, [STANDARD_CALENDAR, CONTINUOUS_CALENDAR], options({ lagCalendar: 'CONTINUOUS' }));
    assert.equal(continuous.activities.find((a) => a.id === 'B')!.earlyStart, '2026-06-08');
  });

  it('lets a cure run through the weekend and the work stop for it', () => {
    // The case a single project calendar cannot express. Pour 1 day Friday the
    // 5th; a 3-day cure on the continuous calendar runs Sat/Sun/Mon, finishing
    // Monday the 8th; strike follows on Tuesday the 9th. On a five-day calendar
    // the cure would not finish until Wednesday, inventing two days.
    const result = schedule(
      [
        task('POUR', 1, { constraint: { type: 'START_ON', date: '2026-06-05' } }),
        task('CURE', 3, { calendarId: CONTINUOUS_CALENDAR.id }),
        task('STRIKE', 2),
      ],
      [fs('POUR', 'CURE'), fs('CURE', 'STRIKE')],
      [STANDARD_CALENDAR, CONTINUOUS_CALENDAR],
      options(),
    );
    const at = (id: string) => result.activities.find((a) => a.id === id)!;
    assert.equal(at('POUR').earlyFinish, '2026-06-05');
    assert.equal(at('CURE').earlyStart, '2026-06-06', 'the cure waited for Monday');
    assert.equal(at('CURE').earlyFinish, '2026-06-08');
    assert.equal(at('STRIKE').earlyStart, '2026-06-09');
  });

  it('holds a start-to-start pair together and a finish-to-finish pair apart', () => {
    // SS with a 2-day lag: B starts two working days after A starts.
    const ss = schedule(
      [task('A', 10), task('B', 4)],
      [{ predecessorId: 'A', successorId: 'B', type: 'SS', lag: 2 }],
      [STANDARD_CALENDAR],
      options(),
    );
    assert.equal(ss.activities.find((a) => a.id === 'B')!.earlyStart, '2026-06-03');

    // FF with no lag: B finishes when A finishes. A is 10 days from Monday the
    // 1st, so Friday the 12th; B is 4 days back from there, Tuesday the 9th.
    const ff = schedule(
      [task('A', 10), task('B', 4)],
      [{ predecessorId: 'A', successorId: 'B', type: 'FF', lag: 0 }],
      [STANDARD_CALENDAR],
      options(),
    );
    const b = ff.activities.find((a) => a.id === 'B')!;
    assert.equal(ff.activities.find((a) => a.id === 'A')!.earlyFinish, '2026-06-12');
    assert.equal(b.earlyFinish, '2026-06-12');
    assert.equal(b.earlyStart, '2026-06-09');
  });
});

// ── Float and the longest path ──────────────────────────────────────────────

describe('float, and the chain that actually decides the date', () => {
  it('gives the slack path float and the driving path none', () => {
    // Two paths from a start milestone to a finish milestone.
    //   long:  L1 (10 days) → L2 (10 days)
    //   short: S1 (4 days)
    // The short path has 16 days of float; the long one has none.
    const result = schedule(
      [
        task('START', 0, { type: 'START_MILESTONE' }),
        task('L1', 10),
        task('L2', 10),
        task('S1', 4),
        task('END', 0, { type: 'FINISH_MILESTONE' }),
      ],
      [fs('START', 'L1'), fs('L1', 'L2'), fs('L2', 'END'), fs('START', 'S1'), fs('S1', 'END')],
      [STANDARD_CALENDAR],
      options(),
    );
    const at = (id: string) => result.activities.find((a) => a.id === id)!;

    assert.equal(at('L1').totalFloat, 0);
    assert.equal(at('L2').totalFloat, 0);
    assert.equal(at('S1').totalFloat, 16, `S1 float was ${at('S1').totalFloat}`);
    assert.equal(at('L1').critical, true);
    assert.equal(at('S1').critical, false);

    // And the longest path is the chain traced back from what finishes last.
    assert.deepEqual(result.longestPath, ['START', 'L1', 'L2', 'END']);
    assert.equal(at('S1').longestPath, false);
  });

  it('reports a constraint that pushes past the logic as negative float', () => {
    // A 20-day chain from Monday 1 June finishes Friday 26 June. Told to finish
    // by the 12th, the programme does not refuse — it reports 10 days of
    // negative float, which is what a planner needs to see.
    const result = schedule(
      [task('A', 10), task('B', 10, { constraint: { type: 'FINISH_ON_OR_BEFORE', date: '2026-06-12' } })],
      [fs('A', 'B')],
      [STANDARD_CALENDAR],
      options(),
    );
    const b = result.activities.find((a) => a.id === 'B')!;
    assert.equal(b.earlyFinish, '2026-06-26');
    assert.ok(b.totalFloat < 0, `expected negative float, got ${b.totalFloat}`);
    assert.equal(b.totalFloat, -10);

    assert.deepEqual(result.constraintDriven, [
      { id: 'B', name: 'Activity B', constraint: 'FINISH_ON_OR_BEFORE', date: '2026-06-12', totalFloat: -10 },
    ]);
  });

  it('pushes a start-no-earlier-than out and gives it back to nobody', () => {
    // A finishes Friday the 5th; B could start Monday the 8th but may not start
    // before the 15th. Its early start is the 15th and the week is lost.
    const result = schedule(
      [task('A', 5), task('B', 5, { constraint: { type: 'START_ON_OR_AFTER', date: '2026-06-15' } })],
      [fs('A', 'B')],
      [STANDARD_CALENDAR],
      options(),
    );
    const b = result.activities.find((a) => a.id === 'B')!;
    assert.equal(b.earlyStart, '2026-06-15');
    assert.equal(b.earlyFinish, '2026-06-19');
    // A now has a week of float it did not have before the constraint.
    assert.equal(result.activities.find((a) => a.id === 'A')!.totalFloat, 5);
  });

  it('reports a cycle rather than scheduling a network that has no order', () => {
    const result = schedule(
      [task('A', 2), task('B', 2)],
      [fs('A', 'B'), fs('B', 'A')],
      [STANDARD_CALENDAR],
      options(),
    );
    assert.ok(result.cycles.length > 0, 'a circular network was scheduled as though it had an order');
  });
});

// ── The data date and progress ──────────────────────────────────────────────

describe('the line between what happened and what is forecast', () => {
  it('will not forecast unstarted work into the past', () => {
    // The data date has moved to Monday 15 June and A has not begun. It cannot
    // start on the 1st any more, whatever the original plan said.
    const result = schedule([task('A', 5)], [], [STANDARD_CALENDAR], options({ dataDate: '2026-06-15' }));
    assert.equal(result.activities[0]!.earlyStart, '2026-06-15');
    assert.equal(result.activities[0]!.status, 'NOT_STARTED');
  });

  it('holds completed work at its actual dates whatever the logic says', () => {
    // A finished early, on the 3rd, against a plan that had it running to the
    // 5th. The network does not get to move a fact.
    const result = schedule(
      [
        task('A', 5, { actualStart: '2026-06-01', actualFinish: '2026-06-03' }),
        task('B', 3),
      ],
      [fs('A', 'B')],
      [STANDARD_CALENDAR],
      options({ dataDate: '2026-06-04' }),
    );
    const at = (id: string) => result.activities.find((a) => a.id === id)!;
    assert.equal(at('A').status, 'COMPLETE');
    assert.equal(at('A').earlyFinish, '2026-06-03');
    assert.equal(at('A').totalFloat, 0, 'completed work was given float');
    // B is free to run from the data date.
    assert.equal(at('B').earlyStart, '2026-06-04');
  });

  it('forecasts running work from the data date on what is left, not on the original duration', () => {
    // A is a 10-day activity that started on the 1st. At the data date of the
    // 15th, four days remain — so it finishes on the 18th, not on the 12th its
    // original duration would have given.
    const result = schedule(
      [task('A', 10, { actualStart: '2026-06-01', remainingDuration: 4, percentComplete: 60 })],
      [],
      [STANDARD_CALENDAR],
      options({ dataDate: '2026-06-15' }),
    );
    const a = result.activities[0]!;
    assert.equal(a.status, 'IN_PROGRESS');
    assert.equal(a.earlyStart, '2026-06-15');
    assert.equal(a.earlyFinish, '2026-06-18');
  });

  it('gives a different answer under retained logic and progress override, and says which', () => {
    // B has started out of sequence: A is not finished and B is running.
    //
    //   A: 10 days from the 1st, 6 remaining at the data date of Monday the
    //      15th. Six working days from the 15th is Mon 15, Tue 16, Wed 17,
    //      Thu 18, Fri 19, Mon 22 — so A finishes on the 22nd either way.
    //   B: started on the 10th, 5 remaining.
    //
    //   Retained logic holds B's remainder behind A: B starts Tue the 23rd and
    //   runs Tue 23, Wed 24, Thu 25, Fri 26, Mon 29 — the project finishes on
    //   the 29th.
    //   Progress override says the spent logic no longer drives: B runs from
    //   the data date, Mon 15 to Fri 19, and the project finishes on the 22nd
    //   with A.
    //
    // A week between them, from one setting.
    const activities = [
      task('A', 10, { actualStart: '2026-06-01', remainingDuration: 6 }),
      task('B', 8, { actualStart: '2026-06-10', remainingDuration: 5 }),
    ];
    const link = [fs('A', 'B')];
    const dataDate = '2026-06-15';

    const retained = schedule(activities, link, [STANDARD_CALENDAR], options({ dataDate, outOfSequence: 'RETAINED_LOGIC' }));
    const override = schedule(activities, link, [STANDARD_CALENDAR], options({ dataDate, outOfSequence: 'PROGRESS_OVERRIDE' }));

    assert.equal(retained.activities.find((a) => a.id === 'A')!.earlyFinish, '2026-06-22');
    assert.equal(override.activities.find((a) => a.id === 'A')!.earlyFinish, '2026-06-22');
    assert.equal(retained.outOfSequenceCount, 1);
    assert.equal(override.outOfSequenceCount, 1);

    // Where the difference actually lives: B's own dates.
    const retainedB = retained.activities.find((a) => a.id === 'B')!;
    const overrideB = override.activities.find((a) => a.id === 'B')!;
    assert.equal(retainedB.earlyStart, '2026-06-23', 'retained logic let B ignore its unfinished predecessor');
    assert.equal(retainedB.earlyFinish, '2026-06-29');
    assert.equal(overrideB.earlyStart, '2026-06-15', 'progress override still held B behind A');
    assert.equal(overrideB.earlyFinish, '2026-06-19');
    assert.equal(retainedB.outOfSequence, true);

    // And so the completion dates differ by a week.
    assert.equal(retained.finishDate, '2026-06-29');
    assert.equal(override.finishDate, '2026-06-22');
    assert.ok(
      retained.finishDate > override.finishDate,
      `retained logic (${retained.finishDate}) should not finish before progress override (${override.finishDate})`,
    );

    // And the result carries which setting produced it, so the date can be
    // argued with rather than only quoted.
    assert.equal(retained.options.outOfSequence, 'RETAINED_LOGIC');
    assert.equal(override.options.outOfSequence, 'PROGRESS_OVERRIDE');
  });
});

// ── The breakdown ───────────────────────────────────────────────────────────

describe('rolling the programme up its breakdown', () => {
  it('spans each branch and weights its progress by duration', () => {
    // 1.1 holds a 40-day activity that is 25% done and a 2-day one that is
    // finished. Counting activities gives 50%; weighting by duration gives
    // (40 × 0.25 + 2 × 1) / 42 = 12 / 42 = 28.6%, which is the true answer.
    const result = schedule(
      [
        task('BIG', 40, { wbsPath: '1.1', percentComplete: 25, actualStart: '2026-06-01', remainingDuration: 30 }),
        task('SMALL', 2, { wbsPath: '1.1', actualStart: '2026-06-01', actualFinish: '2026-06-02' }),
        task('OTHER', 10, { wbsPath: '1.2' }),
      ],
      [],
      [STANDARD_CALENDAR],
      options({ dataDate: '2026-06-15' }),
    );

    const nodes = rollUpWBS(result);
    const at = (path: string) => nodes.find((node) => node.path === path)!;

    assert.deepEqual(nodes.map((node) => node.path), ['1', '1.1', '1.2']);
    assert.equal(at('1.1').activities, 2);
    assert.equal(at('1.1').complete, 1);
    assert.equal(at('1.1').percentComplete, 28.6, 'progress was counted rather than weighted');
    // The parent gathers both branches.
    assert.equal(at('1').activities, 3);
    assert.equal(at('1').earlyStart, at('1.1').earlyStart);
  });

  it('takes the worst float in a branch, not the average of it', () => {
    // A branch is as healthy as its sickest activity. Averaging float lets a
    // pile of slack hide the one thing that is late.
    const result = schedule(
      [
        task('CRIT', 10, { wbsPath: '2' }),
        task('SLACK', 2, { wbsPath: '2' }),
        task('END', 0, { type: 'FINISH_MILESTONE', wbsPath: '3' }),
      ],
      [fs('CRIT', 'END'), fs('SLACK', 'END')],
      [STANDARD_CALENDAR],
      options(),
    );
    const branch = rollUpWBS(result).find((node) => node.path === '2')!;
    assert.equal(branch.totalFloat, 0, 'a branch with a critical activity reported float');
  });
});

// ── Refusals ────────────────────────────────────────────────────────────────

describe('what the scheduler will not do', () => {
  it('refuses an activity on a calendar nobody supplied', () => {
    throwsCode(
      () => schedule([task('A', 5, { calendarId: 'NIGHT_SHIFT' })], [], [STANDARD_CALENDAR], options()),
      'SCHEDULE_CALENDAR_MISSING',
    );
  });

  it('refuses a default calendar that is not there', () => {
    throwsCode(
      () => schedule([task('A', 5)], [], [STANDARD_CALENDAR], options({ defaultCalendarId: 'NOT_SUPPLIED' })),
      'SCHEDULE_DEFAULT_CALENDAR_MISSING',
    );
  });
});
