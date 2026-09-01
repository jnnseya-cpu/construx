import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as programme from '../src/domain/programme.ts';
import * as planning from '../src/engines/planning.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The planner's door onto the dated scheduler.
 *
 * The engine is proved in `schedule.test.ts` against hand-worked dates. This is
 * about the things only the domain can get wrong: reading the network out of the
 * records the platform already has rather than a parallel copy, refusing the
 * states that would produce a programme nobody can work to, and keeping a run as
 * a statement rather than recomputing it under whoever is reading it.
 *
 * The reference week again: **2026-06-01 is a Monday.**
 */

/**
 * A project with no network of its own.
 *
 * The flagship demonstration project carries a full programme already, so a
 * chain added to it is scheduled among a hundred other activities and the
 * project finish date is somebody else's. Every date below is meant to be
 * checkable by hand, which it can only be if the network is exactly the one the
 * test built — the same lesson the supplier-concentration suite learned when a
 * seed with one package made an ordering assertion loop over a list of one.
 */
async function project(): Promise<{
  platform: Platform;
  seed: SeedResult;
  projectId: string;
  planner: () => ReturnType<Platform['context']>;
}> {
  const platform = new Platform();
  const seed = await seedDemoProject(platform);
  const projectId = emptyProjectIn(platform, seed);
  // The planner holds PROGRAMME_BASELINES; every command here is theirs.
  const planner = () => platform.context(seed.users.planner!.auth, projectId, { source: 'WEB' });
  return { platform, seed, projectId, planner };
}

function emptyProjectIn(platform: Platform, seed: SeedResult): string {
  const found = platform.ledger
    .listByTenant(seed.tenantId, 'Project')
    .map((record) => String(record.state.id))
    .find((id) => platform.ledger.list(id, 'Task').length === 0);
  assert.ok(found, 'the seed no longer has a project without activities to build a network in');
  return found;
}

/** A small network of three activities in a chain, on the existing records. */
function chain(ctx: ReturnType<Platform['context']>): { a: string; b: string; c: string } {
  const [a, b, c] = planning.createTasks(ctx, [
    { activityCode: 'A100', name: 'Excavate', workPackageId: 'wp-1', durationDays: 5 },
    { activityCode: 'A200', name: 'Blind and pour', workPackageId: 'wp-1', durationDays: 3 },
    { activityCode: 'A300', name: 'Strike and backfill', workPackageId: 'wp-1', durationDays: 2 },
  ]);
  planning.linkTasks(ctx, [
    { predecessorId: a!, successorId: b!, type: 'FS', lag: 0 },
    { predecessorId: b!, successorId: c!, type: 'FS', lag: 0 },
  ]);
  return { a: a!, b: b!, c: c! };
}

// ── The network comes from the records that already exist ───────────────────

describe('one activity model, not two', () => {
  it('schedules the tasks and dependencies the platform already holds', async () => {
    const { planner } = await project();
    const { a, b, c } = chain(planner());

    const view = programme.programmeView(planner(), '2026-06-01');
    const at = (id: string) => view.activities.find((activity) => activity.id === id)!;

    // A: 5 days from Monday 1 June. B: 3 days after it. C: 2 days after that.
    assert.equal(at(a).earlyStart, '2026-06-01');
    assert.equal(at(a).earlyFinish, '2026-06-05');
    assert.equal(at(b).earlyStart, '2026-06-08');
    assert.equal(at(c).earlyFinish, '2026-06-12');
    assert.equal(view.finishDate, '2026-06-12');

    // The activity code comes off the task record rather than being invented.
    assert.equal(at(a).activityCode, 'A100');
    assert.equal(at(a).name, 'Excavate');
  });

  it('offers the two calendars a project gets without being asked', async () => {
    // A planner should not have to define a working week before they can
    // schedule anything: that is a question with one sensible answer.
    const { planner } = await project();
    const view = programme.programmeView(planner(), '2026-06-01');
    const ids = view.calendars.map((calendar) => calendar.id);
    assert.ok(ids.includes('STANDARD_5_DAY'), `expected a five-day calendar, got ${ids.join(', ')}`);
    assert.ok(ids.includes('CONTINUOUS_7_DAY'));
    assert.equal(view.calendars.find((calendar) => calendar.id === 'STANDARD_5_DAY')!.workingDaysPerWeek, 5);
  });

  it('says there is no programme rather than reporting an empty one', async () => {
    // A project with no activities is not a project finishing today.
    const platform = new Platform();
    const seed = await seedDemoProject(platform);
    const view = programme.programmeView(
      platform.context(seed.users.planner!.auth, emptyProjectIn(platform, seed), { source: 'WEB' }),
    );
    assert.deepEqual(view.activities, []);
    assert.equal(view.finishDate, undefined);
    assert.match(view.summary, /no programme to schedule yet/);
  });
});

// ── Calendars ───────────────────────────────────────────────────────────────

describe('the working week, and the days it is not', () => {
  it('takes a bank holiday and moves every date after it', async () => {
    const { planner } = await project();
    const { a } = chain(planner());

    // Without the holiday: 5 days from Monday finishes Friday the 5th.
    assert.equal(
      programme.programmeView(planner(), '2026-06-01').activities.find((x) => x.id === a)!.earlyFinish,
      '2026-06-05',
    );

    // Redefine the standard week with Wednesday the 3rd shut down. The same
    // five days now run to Monday the 8th.
    programme.defineCalendar(planner(), {
      id: 'STANDARD_5_DAY',
      name: 'Five-day week',
      workingWeekdays: [false, true, true, true, true, true, false],
      exceptions: [{ date: '2026-06-03', working: false, reason: 'Shutdown' }],
    });
    assert.equal(
      programme.programmeView(planner(), '2026-06-01').activities.find((x) => x.id === a)!.earlyFinish,
      '2026-06-08',
      'the shutdown day did not move the dates after it',
    );
  });

  it('lets a cure run through the weekend the site does not work', async () => {
    // The case a single project calendar cannot express, through the domain.
    const { planner } = await project();
    const { a, b } = chain(planner());
    programme.setActivityAttributes(planner(), { taskId: b, calendarId: 'CONTINUOUS_7_DAY' });

    const view = programme.programmeView(planner(), '2026-06-01');
    const at = (id: string) => view.activities.find((activity) => activity.id === id)!;
    // A finishes Friday the 5th; B is on the seven-day calendar so it starts
    // on the Saturday and runs Sat, Sun, Mon.
    assert.equal(at(a).earlyFinish, '2026-06-05');
    assert.equal(at(b).earlyStart, '2026-06-06');
    assert.equal(at(b).earlyFinish, '2026-06-08');
    assert.equal(at(b).calendarId, 'CONTINUOUS_7_DAY');
  });

  it('refuses a calendar nobody defined rather than quietly using the default', async () => {
    const { planner } = await project();
    const { a } = chain(planner());
    throwsCode(
      () => programme.setActivityAttributes(planner(), { taskId: a, calendarId: 'NIGHT_SHIFT' }),
      'CALENDAR_NOT_DEFINED',
    );
  });

  it('refuses a week that is not seven days, or one that never works', async () => {
    const { planner } = await project();
    throwsCode(
      () => programme.defineCalendar(planner(), { id: 'ODD', name: 'Odd', workingWeekdays: [true, true, true] }),
      'CALENDAR_WEEK_INVALID',
    );
    throwsCode(
      () =>
        programme.defineCalendar(planner(), {
          id: 'NEVER',
          name: 'Never',
          workingWeekdays: [false, false, false, false, false, false, false],
        }),
      'CALENDAR_NEVER_WORKS',
    );
  });
});

// ── Constraints and activity types ──────────────────────────────────────────

describe('constraints, and what they do to the float', () => {
  it('pushes a start out and hands the float back up the chain', async () => {
    const { planner } = await project();
    const { a, b } = chain(planner());
    programme.setActivityAttributes(planner(), {
      taskId: b,
      constraint: { type: 'START_ON_OR_AFTER', date: '2026-06-15' },
    });

    const view = programme.programmeView(planner(), '2026-06-01');
    const at = (id: string) => view.activities.find((activity) => activity.id === id)!;
    assert.equal(at(b).earlyStart, '2026-06-15');
    // A could have run a week later without disturbing anything.
    assert.equal(at(a).totalFloat, 5);
    assert.deepEqual(view.constraintDriven, [
      { id: b, name: 'Blind and pour', constraint: 'START_ON_OR_AFTER', date: '2026-06-15', totalFloat: 0 },
    ]);
  });

  it('clears a constraint on an explicit null and leaves it on an omission', async () => {
    // The distinction that stops a planner changing a calendar and silently
    // dropping a date somebody negotiated with the client.
    const { planner } = await project();
    const { b } = chain(planner());
    programme.setActivityAttributes(planner(), { taskId: b, constraint: { type: 'START_ON_OR_AFTER', date: '2026-06-15' } });

    // Changing the calendar alone leaves the constraint standing.
    programme.setActivityAttributes(planner(), { taskId: b, calendarId: 'CONTINUOUS_7_DAY' });
    assert.equal(
      programme.programmeView(planner(), '2026-06-01').activities.find((x) => x.id === b)!.constraint?.date,
      '2026-06-15',
      'changing the calendar dropped the constraint',
    );

    programme.setActivityAttributes(planner(), { taskId: b, constraint: null });
    assert.equal(programme.programmeView(planner(), '2026-06-01').activities.find((x) => x.id === b)!.constraint, undefined);
  });

  it('gives a milestone no duration whatever the task record says', async () => {
    // A zero-duration activity marks a moment. Scheduling one with a span puts
    // a duration on something that has none.
    const { planner } = await project();
    const [id] = planning.createTasks(planner(), [
      { activityCode: 'M100', name: 'Possession granted', workPackageId: 'wp-1', durationDays: 7 },
    ]);
    programme.setActivityAttributes(planner(), { taskId: id!, type: 'START_MILESTONE' });

    const activity = programme.programmeView(planner(), '2026-06-01').activities.find((x) => x.id === id)!;
    assert.equal(activity.duration, 0);
    assert.equal(activity.earlyStart, activity.earlyFinish);
    assert.equal(activity.typeLabel, 'Start milestone');
  });

  it('refuses an activity type and a constraint type it does not schedule', async () => {
    const { planner } = await project();
    const { a } = chain(planner());
    throwsCode(
      () => programme.setActivityAttributes(planner(), { taskId: a, type: 'HAMMOCK' as never }),
      'ACTIVITY_TYPE_UNKNOWN',
    );
    throwsCode(
      () => programme.setActivityAttributes(planner(), { taskId: a, constraint: { type: 'WHENEVER' as never, date: '2026-06-01' } }),
      'CONSTRAINT_TYPE_UNKNOWN',
    );
  });
});

// ── Progress, and what it may not say ───────────────────────────────────────

describe('the planner’s monthly update', () => {
  it('forecasts running work on what is left, not on what was planned', async () => {
    const { planner } = await project();
    const { a } = chain(planner());
    programme.recordActivityStatus(planner(), { taskId: a, actualStart: '2026-06-01', remainingDuration: 4, percentComplete: 60 });

    // At a data date of Monday the 15th, four days remain: the 15th to the 18th,
    // not the 5th its original five-day duration would have given.
    const activity = programme.programmeView(planner(), '2026-06-15').activities.find((x) => x.id === a)!;
    assert.equal(activity.status, 'IN_PROGRESS');
    assert.equal(activity.earlyStart, '2026-06-15');
    assert.equal(activity.earlyFinish, '2026-06-18');
    assert.equal(activity.percentComplete, 60);
  });

  it('refuses a finish with no start', async () => {
    // A finish with no start leaves the schedule unable to say how long the
    // work took, which is the number the next job is planned on.
    const { planner } = await project();
    const { a } = chain(planner());
    const error = throwsCode(
      () => programme.recordActivityStatus(planner(), { taskId: a, actualFinish: '2026-06-05' }),
      'ACTUAL_FINISH_WITHOUT_START',
    );
    assert.match(String(error.message), /how long the work took/);
  });

  it('refuses a finish before its own start', async () => {
    const { planner } = await project();
    const { a } = chain(planner());
    throwsCode(
      () => programme.recordActivityStatus(planner(), { taskId: a, actualStart: '2026-06-10', actualFinish: '2026-06-05' }),
      'ACTUAL_DATES_REVERSED',
    );
  });

  it('refuses started work with nothing left and no finish date', async () => {
    // It would be forecast to finish on the data date and never complete —
    // a programme that quietly stops moving.
    const { planner } = await project();
    const { a } = chain(planner());
    throwsCode(
      () => programme.recordActivityStatus(planner(), { taskId: a, actualStart: '2026-06-01', remainingDuration: 0 }),
      'REMAINING_ZERO_BUT_UNFINISHED',
    );
  });

  it('leaves a finished activity nothing remaining, whatever was typed', async () => {
    const { planner } = await project();
    const { a } = chain(planner());
    const result = programme.recordActivityStatus(planner(), {
      taskId: a,
      actualStart: '2026-06-01',
      actualFinish: '2026-06-03',
      remainingDuration: 99,
    });
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.remainingDuration, 0);

    // And the actual dates hold against the logic.
    const activity = programme.programmeView(planner(), '2026-06-04').activities.find((x) => x.id === a)!;
    assert.equal(activity.earlyFinish, '2026-06-03');
    assert.equal(activity.totalFloat, 0);
  });
});

// ── The run is a statement ──────────────────────────────────────────────────

describe('pressing F9 keeps the answer', () => {
  it('records the dates and the options they were produced under', async () => {
    const { planner } = await project();
    chain(planner());

    const run = programme.runSchedule(planner(), { dataDate: '2026-06-01', outOfSequence: 'PROGRESS_OVERRIDE' });
    assert.equal(run.finishDate, '2026-06-12');
    assert.equal(run.activities, 3);
    assert.equal(run.options.outOfSequence, 'PROGRESS_OVERRIDE');
    assert.equal(run.options.lagCalendar, 'PREDECESSOR');

    // The view reports the run alongside the live calculation, so a planner can
    // tell what the programme said from what it says.
    const view = programme.programmeView(planner(), '2026-06-01');
    assert.equal(view.lastRun?.runId, run.runId);
    assert.equal(view.lastRun?.finishDate, '2026-06-12');
    assert.doesNotMatch(view.summary, /never been formally run/);
  });

  it('says a live view has never been run, rather than implying it has', async () => {
    const { planner } = await project();
    chain(planner());
    const view = programme.programmeView(planner(), '2026-06-01');
    assert.equal(view.lastRun, undefined);
    assert.match(view.summary, /never been formally run/);
  });

  it('refuses to store a programme with a loop in its logic', async () => {
    // The scheduler reports a cycle rather than throwing, which is right for an
    // analysis. A stored programme with one is a statement nobody can work to.
    const { planner } = await project();
    const { a, b } = chain(planner());
    planning.linkTasks(planner(), [{ predecessorId: b, successorId: a, type: 'FS', lag: 0 }]);

    const error = throwsCode(() => programme.runSchedule(planner(), { dataDate: '2026-06-01' }), 'PROGRAMME_CYCLIC');
    assert.match(String(error.message), /the dates inside them would be arbitrary|dates inside the loop would be arbitrary/);

    // The live view still reports it rather than refusing to show anything.
    const view = programme.programmeView(planner(), '2026-06-01');
    assert.ok(view.cycles.length > 0);
    assert.match(view.summary, /loop\(s\) in the logic/);
  });

  it('refuses to schedule a project with no activities', async () => {
    const platform = new Platform();
    const seed = await seedDemoProject(platform);
    throwsCode(
      () =>
        programme.runSchedule(
          platform.context(seed.users.planner!.auth, emptyProjectIn(platform, seed), { source: 'WEB' }),
          { dataDate: '2026-06-01' },
        ),
      'PROGRAMME_EMPTY',
    );
  });
});

// ── The breakdown ───────────────────────────────────────────────────────────

describe('the breakdown comes from the work packages', () => {
  it('reads the WBS out of where it already lives', async () => {
    // The platform already has a work-package hierarchy with codes. A second
    // breakdown would give it two answers to what the job is made of.
    const { planner } = await project();
    const { workPackageId } = planning.createWorkPackage(planner(), {
      wbsCode: '4.2',
      title: 'Substructure',
      indicativeDurationDays: 20,
    });
    const [id] = planning.createTasks(planner(), [
      { activityCode: 'S100', name: 'Piling', workPackageId, durationDays: 10 },
    ]);

    const view = programme.programmeView(planner(), '2026-06-01');
    assert.equal(view.activities.find((x) => x.id === id)!.wbsPath, '4.2');
    const branch = view.wbs.find((node) => node.path === '4.2');
    assert.ok(branch, `expected a 4.2 branch, got ${view.wbs.map((n) => n.path).join(', ')}`);
    assert.equal(branch.activities, 1);
    // And its parent gathers it.
    assert.ok(view.wbs.some((node) => node.path === '4'));
    assert.equal(view.unassignedActivities, 0);
  });

  it('reads a scope package too, not only a work package', async () => {
    // The platform has two package concepts and both are legitimately "the
    // package this activity sits under". Reading only the coded one left every
    // activity on the demonstration project with no breakdown path and the
    // roll-up table empty on real data — found by driving it, not by a test.
    const { platform, seed, planner } = await project();
    const view = programme.programmeView(
      platform.context(seed.users.planner!.auth, seed.projectId, { source: 'WEB' }),
      '2026-09-01',
    );
    assert.ok(view.activities.length > 0, 'the seeded project no longer has activities');
    assert.ok(
      view.wbs.length > 0,
      `the seeded project's activities resolved to no breakdown at all: ${view.unassignedActivities} unassigned`,
    );
    assert.equal(view.unassignedActivities, 0, 'seeded activities were left under no package');
    void planner;
  });

  it('names work the field says is done that the programme cannot date', async () => {
    // The platform holds two records of "done" and they can disagree.
    // `recordProgress` is the field one and writes a percentage; the schedule
    // needs a date. Without one it forecasts work that has already happened,
    // and averaged into a roll-up that reads as "0 of 8 complete, 100% done" —
    // the shape of the disagreement rather than a report of it.
    //
    // Found by reading the rendered panel on the demonstration project, where
    // every activity is 100% in the field and has no actual dates at all.
    const { platform, seed } = await project();
    const view = programme.programmeView(
      platform.context(seed.users.planner!.auth, seed.projectId, { source: 'WEB' }),
      '2026-09-01',
    );

    assert.ok(
      view.progressDisagreement.length > 0,
      'the seeded project no longer has field progress without actual dates',
    );
    assert.equal(view.progressDisagreement.length, view.activities.length);
    assert.equal(view.progressDisagreement[0]!.fieldPercentComplete, 100);
    assert.ok(view.progressDisagreement[0]!.activityCode.startsWith('A'));
    assert.match(view.summary, /recorded complete in the field with no actual finish date/);

    // Every one of them is still scheduled as unstarted, which is the whole
    // problem: the programme is forecasting work that is done.
    for (const entry of view.progressDisagreement) {
      assert.notEqual(view.activities.find((a) => a.id === entry.id)!.status, 'COMPLETE');
    }
  });

  it('stops naming a disagreement once the actual dates are recorded', async () => {
    // The finding has to clear, or it is a permanent scold rather than a thing
    // to fix.
    const { planner } = await project();
    const { a } = chain(planner());
    programme.recordActivityStatus(planner(), { taskId: a, percentComplete: 100 });
    assert.equal(programme.programmeView(planner(), '2026-06-15').progressDisagreement.length, 1);

    programme.recordActivityStatus(planner(), { taskId: a, actualStart: '2026-06-01', actualFinish: '2026-06-05' });
    assert.deepEqual(programme.programmeView(planner(), '2026-06-15').progressDisagreement, []);
  });

  it('counts activities under no package rather than showing an empty table', async () => {
    // A breakdown with nothing in it and a project whose activities were never
    // filed under anything look identical on screen, and only one of them is
    // somebody's job to fix.
    const { planner } = await project();
    planning.createTasks(planner(), [
      { activityCode: 'X100', name: 'Unfiled', workPackageId: 'no-such-package', durationDays: 3 },
    ]);
    const view = programme.programmeView(planner(), '2026-06-01');
    assert.equal(view.unassignedActivities, 1);
    assert.deepEqual(view.wbs, []);
    assert.match(view.summary, /sit under no package/);
  });
});

// ── Authorisation ───────────────────────────────────────────────────────────

describe('who may change the programme', () => {
  it('is the planner’s, and refused to a role without the area', async () => {
    const { platform, seed, projectId, planner } = await project();
    const { a } = chain(planner());
    const safety = platform.context(seed.users.safety!.auth, projectId, { source: 'WEB' });

    throwsCode(() => programme.runSchedule(safety, { dataDate: '2026-06-01' }), 'ACCESS_DENIED');
    throwsCode(
      () => programme.defineCalendar(safety, { id: 'X', name: 'X', workingWeekdays: [true, true, true, true, true, true, true] }),
      'ACCESS_DENIED',
    );
    throwsCode(() => programme.setActivityAttributes(safety, { taskId: a, type: 'START_MILESTONE' }), 'ACCESS_DENIED');
  });
});
