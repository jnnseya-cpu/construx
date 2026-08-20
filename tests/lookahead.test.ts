import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as structure from '../src/domain/structure.ts';
import * as planning from '../src/engines/planning.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Lookahead planning and Percent Plan Complete.
 *
 * The difference between this and a rolling bar chart is the promise. A
 * lookahead lists what *could* be done; a commitment is a named person saying
 * they *will* do a specific thing by a specific date. PPC counts how many of
 * those were kept, and the reasons the rest were not are the entire point.
 *
 * The delay-risk engine already read open constraints and always found zero,
 * because nothing in the platform could write one.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

const ctx = (who: string) => platform.context(seed.users[who]!.auth, seed.projectId);
const tasks = () => platform.ledger.list(seed.projectId, 'Task');

function reopenForConstruction(): void {
  structure.transitionPhase(platform.context(seed.users.admin!.auth, seed.projectId), {
    to: 'CONSTRUCTION',
    justification: 'Reopened to plan the remaining construction period',
  });
}

describe('the constraints log', () => {
  before(() => reopenForConstruction());

  it('is a log the platform can actually write to', () => {
    // The delay-risk model read this and always found zero, because
    // CONSTRAINT_RAISED had nothing emitting it.
    const open = platform.ledger.list(seed.projectId, 'Constraint');
    assert.ok(open.length >= 2, 'the seed raises constraints');
  });

  it('works out for itself whether the constraint blocks the critical path', () => {
    // Asking the person raising it would be asking them to guess at something
    // the network already knows.
    const constraints = platform.ledger.list(seed.projectId, 'Constraint');
    for (const constraint of constraints) {
      assert.equal(typeof constraint.state.blocksCriticalPath, 'boolean');
    }
  });

  it('refuses a constraint with nobody to clear it', () => {
    throwsCode(
      () =>
        planning.raiseConstraint(ctx('planner'), {
          taskId: tasks()[0]!.refId,
          category: 'ACCESS',
          description: 'Compound gate too narrow for deliveries',
          owner: '  ',
          needByDate: '2026-10-01',
        }),
      'CONSTRAINT_OWNER_REQUIRED',
    );
  });

  it('refuses a closure that does not say what cleared it', () => {
    const raised = planning.raiseConstraint(ctx('planner'), {
      taskId: tasks()[0]!.refId,
      category: 'PERMIT',
      description: 'Road closure permit not granted',
      owner: 'Highways liaison',
      needByDate: '2026-10-01',
    });

    throwsCode(
      () => planning.closeConstraint(ctx('planner'), { constraintId: raised.constraintId, resolution: 'Done' }),
      'CONSTRAINT_RESOLUTION_REQUIRED',
    );

    // Cleared properly, so it does not leak into the commitment tests below —
    // which is the behaviour under test there, not a fixture convenience.
    planning.closeConstraint(ctx('planner'), {
      constraintId: raised.constraintId,
      resolution: 'Permit granted by the highway authority for the November closure window',
    });
  });

  it('records how long a constraint took to clear, and whether it was late', () => {
    // The seeded design constraint was needed by 14 August and cleared on the
    // 18th. How long the business takes to unblock its own work is the number
    // the log exists to produce.
    const cleared = platform.ledger
      .list(seed.projectId, 'Constraint')
      .find((c) => c.state.status === 'CLOSED' && String(c.state.category) === 'DESIGN')!;

    assert.ok(cleared);
    assert.equal(cleared.state.clearedLate, true);
    assert.ok(Number(cleared.state.daysOpen) > 0);
  });

  it('will not close the same constraint twice', () => {
    const cleared = platform.ledger
      .list(seed.projectId, 'Constraint')
      .find((c) => c.state.status === 'CLOSED' && String(c.state.category) === 'DESIGN')!;
    throwsCode(
      () =>
        planning.closeConstraint(ctx('planner'), {
          constraintId: cleared.refId,
          resolution: 'Clearing it a second time for the same stated reason',
        }),
      'CONSTRAINT_ALREADY_CLOSED',
    );
  });
});

describe('committing to work', () => {
  it('refuses a promise made against work that is still constrained', () => {
    // The single commonest reason PPC collapses: promising blocked work. The
    // constraint has to be cleared, or the work stays in the lookahead without
    // a promise against it.
    const constrained = platform.ledger
      .list(seed.projectId, 'Constraint')
      .find((c) => c.state.status !== 'CLOSED')!;

    throwsCode(
      () =>
        planning.publishLookahead(ctx('planner'), {
          weekStarting: '2026-09-07',
          plannedTaskIds: tasks().map((t) => t.refId),
          commitments: [
            {
              taskId: String(constrained.state.taskId),
              promise: 'Complete the channel installation',
              promisedBy: 'Site manager',
              dueDate: '2026-09-11',
            },
          ],
        }),
      'COMMITMENT_CONSTRAINED',
    );
  });

  it('names the constraint that blocked the promise rather than refusing vaguely', () => {
    const constrained = platform.ledger
      .list(seed.projectId, 'Constraint')
      .find((c) => c.state.status !== 'CLOSED')!;

    try {
      planning.publishLookahead(ctx('planner'), {
        weekStarting: '2026-09-07',
        plannedTaskIds: [],
        commitments: [
          { taskId: String(constrained.state.taskId), promise: 'Install the channels', promisedBy: 'Site manager', dueDate: '2026-09-11' },
        ],
      });
      assert.fail('expected the commitment to be refused');
    } catch (error) {
      assert.match((error as Error).message, new RegExp(String(constrained.state.reference)));
      assert.match((error as Error).message, /materials/);
    }
  });

  it('still lets constrained work sit in the lookahead — that is what a lookahead is for', () => {
    const constrained = platform.ledger
      .list(seed.projectId, 'Constraint')
      .find((c) => c.state.status !== 'CLOSED')!;

    const plan = planning.publishLookahead(ctx('planner'), {
      weekStarting: '2026-09-14',
      plannedTaskIds: [String(constrained.state.taskId)],
      commitments: [],
    });

    assert.equal(plan.planned, 1);
    assert.equal(plan.committed, 0);
  });

  it('refuses a commitment with no name against it', () => {
    throwsCode(
      () =>
        planning.publishLookahead(ctx('planner'), {
          weekStarting: '2026-09-21',
          plannedTaskIds: [],
          commitments: [{ taskId: tasks()[0]!.refId, promise: 'Finish the earthworks', promisedBy: '   ', dueDate: '2026-09-25' }],
        }),
      'COMMITMENT_UNOWNED',
    );
  });
});

describe('the weekly review', () => {
  it('computed PPC across the three seeded weeks', () => {
    const plans = platform.ledger.list(seed.projectId, 'LookaheadPlan').filter((p) => p.state.status === 'REVIEWED');
    assert.equal(plans.length, 3);

    const first = plans.find((p) => p.state.weekStarting === '2026-08-03')!;
    assert.equal(first.state.ppcPercent, 100);

    const second = plans.find((p) => p.state.weekStarting === '2026-08-10')!;
    // One of three kept.
    assert.equal(second.state.ppcPercent, 33.3);
  });

  it('refuses a review that leaves a promise unanswered', () => {
    // The promises nobody wants to discuss are the ones that were not kept, so
    // omitting them is exactly how PPC quietly rises.
    const plan = planning.publishLookahead(ctx('planner'), {
      weekStarting: '2026-09-28',
      plannedTaskIds: [],
      commitments: [
        { taskId: tasks()[0]!.refId, promise: 'Finish A', promisedBy: 'Site manager', dueDate: '2026-10-02' },
        { taskId: tasks()[1]!.refId, promise: 'Finish B', promisedBy: 'Site manager', dueDate: '2026-10-02' },
      ],
    });

    throwsCode(
      () =>
        planning.reviewLookahead(ctx('planner'), {
          lookaheadId: plan.lookaheadId,
          outcomes: [{ taskId: tasks()[0]!.refId, completed: true }],
        }),
      'REVIEW_INCOMPLETE',
    );
  });

  it('refuses a broken promise with no reason', () => {
    const plan = planning.publishLookahead(ctx('planner'), {
      weekStarting: '2026-10-05',
      plannedTaskIds: [],
      commitments: [{ taskId: tasks()[0]!.refId, promise: 'Finish A', promisedBy: 'Site manager', dueDate: '2026-10-09' }],
    });

    throwsCode(
      () =>
        planning.reviewLookahead(ctx('planner'), {
          lookaheadId: plan.lookaheadId,
          outcomes: [{ taskId: tasks()[0]!.refId, completed: false }],
        }),
      'NON_COMPLETION_REASON_REQUIRED',
    );
  });

  it('gives no partial credit, because that is the point', () => {
    // A measure that gave partial credit would report a comfortable number for
    // a team that finishes nothing.
    const plan = planning.publishLookahead(ctx('planner'), {
      weekStarting: '2026-10-12',
      plannedTaskIds: [],
      commitments: [
        { taskId: tasks()[0]!.refId, promise: 'Finish A', promisedBy: 'Site manager', dueDate: '2026-10-16' },
        { taskId: tasks()[1]!.refId, promise: 'Finish B', promisedBy: 'Site manager', dueDate: '2026-10-16' },
      ],
    });

    const review = planning.reviewLookahead(ctx('planner'), {
      lookaheadId: plan.lookaheadId,
      outcomes: [
        { taskId: tasks()[0]!.refId, completed: true },
        { taskId: tasks()[1]!.refId, completed: false, reason: 'MATERIALS', note: 'Ninety percent complete at Friday' },
      ],
    });

    assert.equal(review.ppcPercent, 50);
    assert.match(review.assessment, /not a plan/);
  });

  it('will not review the same week twice', () => {
    const reviewed = platform.ledger.list(seed.projectId, 'LookaheadPlan').find((p) => p.state.status === 'REVIEWED')!;
    throwsCode(
      () => planning.reviewLookahead(ctx('planner'), { lookaheadId: reviewed.refId, outcomes: [] }),
      'LOOKAHEAD_ALREADY_REVIEWED',
    );
  });
});

describe('the trend, which is the only PPC worth reading', () => {
  it('weights by promises rather than averaging the weekly percentages', () => {
    // A week with two commitments should not count as much as a week with
    // thirty. Averaging the percentages is the common mistake.
    const trend = planning.ppcTrend(ctx('planner'));
    const promised = trend.weeks.reduce((s, w) => s + w.promised, 0);
    const completed = trend.weeks.reduce((s, w) => s + w.completed, 0);

    assert.equal(trend.meanPpcPercent, Number(((completed / promised) * 100).toFixed(1)));
  });

  it('finds the reason that recurs, which is the one worth fixing', () => {
    const trend = planning.ppcTrend(ctx('planner'));
    assert.ok(trend.topReasons.length > 0);
    assert.equal(trend.topReasons[0]!.reason, 'DESIGN_INFORMATION');
    assert.ok(trend.topReasons[0]!.share > 0);
    assert.match(trend.summary, /recurring reason/);
  });

  it('reports how long the business takes to unblock its own work', () => {
    const trend = planning.ppcTrend(ctx('planner'));
    assert.ok(trend.meanDaysToClear !== null && trend.meanDaysToClear > 0);
  });

  it('sorts the open constraints by when they are needed, and flags the overdue', () => {
    const trend = planning.ppcTrend(ctx('planner'), '2026-12-01');
    assert.ok(trend.openConstraints.length > 0);
    const dates = trend.openConstraints.map((c) => c.needByDate);
    assert.deepEqual(dates, [...dates].sort());
    assert.ok(trend.openConstraints.every((c) => c.overdue), 'all are past their date by December');
  });

  it('says nothing rather than reporting a PPC it does not have', () => {
    // A fresh project has reviewed no weeks. Reporting 0% would read as a team
    // that keeps no promises rather than one that has not started.
    const admin = platform.context(seed.users.admin!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
    const portfolios = platform.ledger.listByTenant(seed.tenantId, 'Portfolio');
    const { projectId } = structure.createProject(admin, {
      portfolioId: String(portfolios[0]!.state.id),
      name: 'Lookahead trend blank slate',
      sectorType: 'INFRASTRUCTURE',
      assetType: 'Pumping station',
      location: { continentCode: 'EU', countryCode: 'GB', city: 'Leeds' },
      contractValueMinor: 120_000_000,
      currency: 'GBP',
      plannedStart: '2027-03-01',
      plannedCompletion: '2027-12-01',
    });

    const trend = planning.ppcTrend(platform.context(seed.users.planner!.auth, projectId));
    assert.equal(trend.meanPpcPercent, null);
    assert.match(trend.summary, /A figure would be invented/);
  });
});
