import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { calculateCPM, durationAtConfidence, pert, type Dependency } from '../src/engines/maths/cpm.ts';
import { sampleTriangular, simulateCompletion, type ThreePointActivity } from '../src/engines/maths/montecarlo.ts';
import * as planning from '../src/engines/planning.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Monte Carlo completion, and the bias it exists to correct.
 *
 * The platform published a P80 computed the textbook way: sum the variance of
 * the activities on the deterministic critical path and read the normal
 * quantile. It is wrong in two directions, and the tests below demonstrate
 * both.
 *
 * It **understates** where a near-critical path can overtake, because finishing
 * by a date needs every path to make it rather than one. And it **overstates**
 * where several paths are critical at once, because it adds the variance of
 * activities that run alongside each other as though they ran in series — the
 * proof being that a duplicate parallel path leaves the project finishing on
 * the same day while moving the published figure by a fortnight.
 */

const chain = (n: number, duration: number, prefix: string): { activities: ThreePointActivity[]; dependencies: Dependency[] } => {
  const activities: ThreePointActivity[] = [];
  const dependencies: Dependency[] = [];
  for (let i = 0; i < n; i++) {
    activities.push({
      id: `${prefix}${i}`,
      name: `${prefix} step ${i}`,
      duration,
      optimistic: duration * 0.8,
      mostLikely: duration,
      pessimistic: duration * 1.5,
    });
    if (i > 0) dependencies.push({ predecessorId: `${prefix}${i - 1}`, successorId: `${prefix}${i}`, type: 'FS', lag: 0 });
  }
  return { activities, dependencies };
};

describe('the triangular sampler', () => {
  it('returns the duration itself when a planner says it is certain', () => {
    // Three identical numbers mean no uncertainty, and dividing by a zero range
    // would produce NaN rather than the obvious answer.
    for (const u of [0, 0.3, 0.5, 0.99]) {
      assert.equal(sampleTriangular(10, 10, 10, u), 10);
    }
  });

  it('stays inside the range the estimate gave', () => {
    for (let i = 0; i <= 100; i++) {
      const value = sampleTriangular(5, 8, 20, i / 100);
      assert.ok(value >= 5 && value <= 20, `${value} escaped the estimate`);
    }
  });

  it('crosses the mode at the right point of the distribution', () => {
    // For a triangle over [5, 20] with mode 8, the mode sits at (8-5)/(20-5) of
    // the cumulative distribution. Either side of that the sampler switches
    // branch, and both branches must agree at the join.
    const f = (8 - 5) / (20 - 5);
    assert.ok(Math.abs(sampleTriangular(5, 8, 20, f) - 8) < 1e-9);
  });

  it('is monotonic, because an inverse-transform sampler has to be', () => {
    let previous = -Infinity;
    for (let i = 0; i <= 200; i++) {
      const value = sampleTriangular(5, 8, 20, i / 200);
      assert.ok(value >= previous, 'the sampler went backwards');
      previous = value;
    }
  });

  it('copes with a planner who put the numbers in the wrong order', () => {
    const value = sampleTriangular(20, 8, 5, 0.5);
    assert.ok(value >= 5 && value <= 20);
  });
});

describe('reproducibility', () => {
  it('gives the same forecast twice for the same programme', () => {
    // An unreproducible forecast is an unauditable one: a figure in a board
    // pack has to be checkable against the platform that produced it.
    const { activities, dependencies } = chain(6, 20, 'A');
    const first = simulateCompletion(activities, dependencies, { seed: 'project-1', iterations: 500 });
    const second = simulateCompletion(activities, dependencies, { seed: 'project-1', iterations: 500 });

    assert.deepEqual(first, second);
  });

  it('gives a different one for a different project', () => {
    const { activities, dependencies } = chain(6, 20, 'A');
    const one = simulateCompletion(activities, dependencies, { seed: 'project-1', iterations: 500 });
    const two = simulateCompletion(activities, dependencies, { seed: 'project-2', iterations: 500 });

    assert.notEqual(one.p80, two.p80, 'two seeds producing an identical distribution would mean the seed is unused');
  });
});

describe('merge bias — the reason this exists', () => {
  /** Analytic P80, computed exactly the way the platform publishes it. */
  function analyticP80(activities: ThreePointActivity[], dependencies: Dependency[]): number {
    const cpm = calculateCPM(activities, dependencies);
    const byId = new Map(activities.map((a) => [a.id, a]));
    const variance = cpm.criticalPath.reduce((sum, id) => {
      const activity = byId.get(id);
      if (!activity) return sum;
      return sum + pert(activity.optimistic, activity.mostLikely, activity.pessimistic).variance;
    }, 0);
    return durationAtConfidence(cpm.projectDuration, variance, 0.8);
  }

  it('understates the risk when parallel paths of equal length converge', () => {
    // Five identical chains running in parallel into one finish. The
    // deterministic critical path is any one of them; the project finishes when
    // the slowest does, which is later than any single path's own P80.
    const paths = ['A', 'B', 'C', 'D', 'E'].map((prefix) => chain(5, 20, prefix));
    const activities = paths.flatMap((p) => p.activities);
    const dependencies = paths.flatMap((p) => p.dependencies);

    const analytic = analyticP80(activities, dependencies);
    const simulated = simulateCompletion(activities, dependencies, {
      seed: 'merge-bias',
      iterations: 2_000,
      analyticP80Days: analytic,
    });

    assert.ok(
      simulated.p80 > analytic,
      `the simulated P80 (${simulated.p80}) should exceed the analytic one (${analytic}) where paths converge`,
    );
    assert.ok(simulated.analyticErrorDays > 0);
  });

  it('moves the analytic figure when nothing about the schedule changed', () => {
    // The second failure mode, and the more damning one. Add a parallel path of
    // exactly the same length: the project still finishes on the same day,
    // because the paths are identical. But every activity on both paths now has
    // zero float, so the analytic method sums the variance of activities
    // running *alongside* each other as though they ran in series — and the
    // published P80 moves by a fortnight for a change that altered nothing.
    const build = (count: number) => {
      const paths = Array.from({ length: count }, (_, i) => chain(5, 20, `P${i}`));
      const activities = paths.flatMap((p) => p.activities);
      const dependencies = paths.flatMap((p) => p.dependencies);
      return {
        deterministic: calculateCPM(activities, dependencies).projectDuration,
        analytic: analyticP80(activities, dependencies),
        simulated: simulateCompletion(activities, dependencies, { seed: 'growth', iterations: 1_500 }).p80,
      };
    };

    const one = build(1);
    const sixteen = build(16);

    assert.equal(one.deterministic, sixteen.deterministic, 'identical parallel paths finish on the same day');
    assert.ok(
      sixteen.analytic - one.analytic > 10,
      `the analytic P80 drifted by ${(sixteen.analytic - one.analytic).toFixed(1)} days for a schedule that did not change`,
    );

    // The simulation moves too — but for a real reason, and far less: with
    // sixteen paths the project waits for the slowest of sixteen samples, which
    // genuinely is later. The analytic drift is arithmetic error; this is risk.
    assert.ok(sixteen.simulated > one.simulated);
    assert.ok(
      sixteen.analytic - one.analytic > sixteen.simulated - one.simulated,
      'the analytic method should drift further than the honest one',
    );
  });

  it('still understates on the case it was supposed to handle', () => {
    // Both errors at once is the normal case. One near-critical competitor is
    // the textbook merge, and there the analytic figure is optimistic.
    const long = chain(5, 20, 'L');
    const short = chain(5, 19, 'S');
    const activities = [...long.activities, ...short.activities];
    const dependencies = [...long.dependencies, ...short.dependencies];

    const analytic = analyticP80(activities, dependencies);
    const simulated = simulateCompletion(activities, dependencies, { seed: 'near-critical', iterations: 2_000 });

    assert.ok(simulated.p80 > analytic, `simulated ${simulated.p80} should exceed analytic ${analytic}`);
  });

  it('reports the bias rather than silently replacing the number', () => {
    // People have been quoting the analytic figure. Changing it without saying
    // by how much would leave them unable to explain the difference.
    const { activities, dependencies } = chain(5, 20, 'A');
    const analytic = analyticP80(activities, dependencies);
    const simulated = simulateCompletion(activities, dependencies, {
      seed: 'single-path',
      iterations: 1_000,
      analyticP80Days: analytic,
    });

    assert.equal(typeof simulated.analyticErrorDays, 'number');
    assert.equal(simulated.deterministicDays, calculateCPM(activities, dependencies).projectDuration);
  });
});

describe('the criticality index, which PERT cannot produce', () => {
  it('finds an activity that is critical under stress but has float today', () => {
    // A near-parallel path, five days shorter. It is not on the deterministic
    // critical path at all, and it takes over in a large share of runs.
    const long = chain(4, 25, 'L');
    const short = chain(4, 23, 'S');
    const activities = [...long.activities, ...short.activities];
    const dependencies = [...long.dependencies, ...short.dependencies];

    const deterministic = calculateCPM(activities, dependencies);
    assert.ok(!deterministic.criticalPath.includes('S0'), 'the short path has float in the deterministic run');

    const simulated = simulateCompletion(activities, dependencies, { seed: 'criticality', iterations: 2_000 });
    const shortPath = simulated.criticalityIndex.find((c) => c.taskId === 'S0');

    assert.ok(shortPath, 'the short path never became critical, which cannot be right at these durations');
    assert.ok(shortPath.index > 0.05, `expected a real share, got ${shortPath?.index}`);
  });

  it('puts the deterministic critical path at the top', () => {
    const long = chain(4, 40, 'L');
    const short = chain(4, 10, 'S');
    const simulated = simulateCompletion(
      [...long.activities, ...short.activities],
      [...long.dependencies, ...short.dependencies],
      { seed: 'dominant', iterations: 1_000 },
    );

    // A path four times longer is critical in every run.
    assert.equal(simulated.criticalityIndex[0]!.index, 1);
    assert.ok(simulated.criticalityIndex[0]!.taskId.startsWith('L'));
  });

  it('leaves out activities that were never critical rather than listing zeros', () => {
    const long = chain(4, 40, 'L');
    const short = chain(4, 10, 'S');
    const simulated = simulateCompletion(
      [...long.activities, ...short.activities],
      [...long.dependencies, ...short.dependencies],
      { seed: 'dominant', iterations: 1_000 },
    );

    assert.ok(simulated.criticalityIndex.every((c) => c.index > 0));
  });
});

describe('the distribution itself', () => {
  it('orders the confidence levels', () => {
    const { activities, dependencies } = chain(6, 20, 'A');
    const s = simulateCompletion(activities, dependencies, { seed: 'ordering', iterations: 1_000 });

    assert.ok(s.p10 <= s.p50);
    assert.ok(s.p50 <= s.p80);
    assert.ok(s.p80 <= s.p90);
  });

  it('collapses to a point when every duration is certain', () => {
    const activities: ThreePointActivity[] = [
      { id: 'A', name: 'A', duration: 10, optimistic: 10, mostLikely: 10, pessimistic: 10 },
      { id: 'B', name: 'B', duration: 15, optimistic: 15, mostLikely: 15, pessimistic: 15 },
    ];
    const dependencies: Dependency[] = [{ predecessorId: 'A', successorId: 'B', type: 'FS', lag: 0 }];

    const s = simulateCompletion(activities, dependencies, { seed: 'certain', iterations: 300 });
    assert.equal(s.p10, 25);
    assert.equal(s.p90, 25);
    assert.equal(s.meanDays, 25);
  });

  it('answers the contractual question directly', () => {
    const { activities, dependencies } = chain(5, 20, 'A');
    const s = simulateCompletion(activities, dependencies, { seed: 'contract', iterations: 1_000, contractualDurationDays: 130 });

    assert.ok(s.probabilityOnTime !== undefined);
    assert.ok(s.probabilityOnTime >= 0 && s.probabilityOnTime <= 1);
  });
});

describe('against the seeded project', () => {
  let platform: Platform;
  let seed: SeedResult;

  before(async () => {
    platform = new Platform();
    seed = await seedDemoProject(platform);
  });

  it('shows the published P80 understating the risk on a real programme', () => {
    const result = planning.simulateProgramme(platform.context(seed.users.planner!.auth, seed.projectId), {
      contractualDurationDays: 400,
    });

    // Eight activities, and the analytic method is still tens of days
    // optimistic. This is not a rounding difference.
    assert.ok(result.analyticErrorDays > 0, `expected understatement, got ${result.analyticErrorDays}`);
    assert.ok(result.p80 > result.analyticP80Days);
    assert.ok(result.p80 > result.deterministicDays);
  });

  it('is reproducible across calls on the same project', () => {
    const ctx = platform.context(seed.users.planner!.auth, seed.projectId);
    assert.equal(planning.simulateProgramme(ctx).p80, planning.simulateProgramme(ctx).p80);
  });

  it('writes nothing — a forecast is not a commercial position', () => {
    const ctx = platform.context(seed.users.planner!.auth, seed.projectId);
    const before = platform.ledger.list(seed.projectId, 'ProgrammeBaseline').length;
    planning.simulateProgramme(ctx);
    assert.equal(platform.ledger.list(seed.projectId, 'ProgrammeBaseline').length, before);
  });

  it('refuses a role with no programme read', () => {
    assert.throws(() => planning.simulateProgramme(platform.context(seed.users.fm!.auth, seed.projectId)));
  });
});

describe('why the analytic figure was out', () => {
  it('separates skew from everything else rather than asserting a cause', () => {
    // A pure serial chain has no parallel routes at all, so blaming the gap on
    // merge bias would be an explanation the data does not support. Most of it
    // here is skew: the analytic P80 centres on the sum of most-likely
    // durations, and a right-skewed estimate expects more than its mode.
    const { activities, dependencies } = chain(8, 40, 'A');
    const cpm = calculateCPM(activities, dependencies);
    const byId = new Map(activities.map((a) => [a.id, a]));
    const variance = cpm.criticalPath.reduce(
      (sum, id) => sum + pert(byId.get(id)!.optimistic, byId.get(id)!.mostLikely, byId.get(id)!.pessimistic).variance,
      0,
    );
    const analytic = durationAtConfidence(cpm.projectDuration, variance, 0.8);

    const s = simulateCompletion(activities, dependencies, { seed: 'skew', iterations: 3_000, analyticP80Days: analytic });

    assert.ok(s.skewDays > 0, 'a right-skewed estimate must contribute positive skew');
    // The two components add back to the total, so nothing is hidden in the gap.
    assert.ok(Math.abs(s.skewDays + s.residualDays - s.analyticErrorDays) < 0.2);
  });

  it('reports no skew where the estimates are symmetric', () => {
    const activities: ThreePointActivity[] = [
      { id: 'A', name: 'A', duration: 20, optimistic: 15, mostLikely: 20, pessimistic: 25 },
      { id: 'B', name: 'B', duration: 20, optimistic: 15, mostLikely: 20, pessimistic: 25 },
    ];
    const dependencies: Dependency[] = [{ predecessorId: 'A', successorId: 'B', type: 'FS', lag: 0 }];

    const s = simulateCompletion(activities, dependencies, { seed: 'symmetric', iterations: 1_000, analyticP80Days: 45 });
    assert.equal(s.skewDays, 0, 'a symmetric estimate expects its mode');
  });
});
