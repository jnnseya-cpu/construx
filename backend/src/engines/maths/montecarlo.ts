import { calculateCPM, type Activity, type Dependency } from './cpm.ts';

/**
 * Monte Carlo completion, and why the analytic figure was not enough.
 *
 * The platform already reported a P80 duration, computed the classical way:
 * sum the variance of the activities on the deterministic critical path and
 * read off the normal quantile. That is the textbook PERT method, and it is
 * wrong in two directions at once — both consequences of treating "the critical
 * path" as a single chain when it is neither single nor fixed.
 *
 * **It understates when a near-critical path can overtake.** The critical path
 * is only critical for the durations you assumed. Vary them and the competitor
 * wins. Finishing by a date requires *every* path to finish by it, so the true
 * probability is lower than the probability of the one path PERT looked at.
 * This is merge bias, and it is worst on large programmes with many parallel
 * routes — exactly where the forecast gets quoted hardest.
 *
 * **It overstates when several paths are critical at once.** Where two chains
 * are the same length, both have zero float, and the method sums the variance
 * of activities running *alongside* each other as though they ran in series.
 * The demonstration is unarguable: add a duplicate parallel path and the
 * project still finishes on the same day, while the published P80 moves by a
 * fortnight. A forecast that shifts when the schedule did not is not a forecast.
 *
 * Simulating the network removes the assumption behind both.
 *
 * Every iteration samples a duration for every activity and recomputes the
 * critical path from scratch, so a path that only becomes critical under stress
 * is counted when it does, and parallel work is never added up as though it
 * were sequential.
 *
 * Two design decisions are deliberate.
 *
 * **The random number generator is seeded and reproducible.** An unreproducible
 * forecast is an unauditable one — the same project on the same data must give
 * the same answer twice, or a figure in a board pack cannot be checked against
 * the platform that produced it. `Math.random()` would have made the number
 * unarguable in the worst sense.
 *
 * **Durations are sampled from a triangular distribution** over the three-point
 * estimate rather than a beta. Triangular is the standard in construction risk
 * practice, it needs nothing but a uniform, and it makes no claim the estimate
 * cannot support: three numbers from a planner describe a minimum, a mode and a
 * maximum, and a triangle is exactly that and nothing more.
 */

export type ThreePointActivity = Activity & {
  optimistic: number;
  mostLikely: number;
  pessimistic: number;
};

/**
 * xorshift128, seeded from a string.
 *
 * Small, fast, and — the only property that matters here — deterministic. The
 * same project produces the same distribution every time it is asked.
 */
function seededRandom(seed: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // Four non-zero words derived from the hash.
  let x = h || 123456789;
  let y = (h ^ 0x9e3779b9) >>> 0 || 362436069;
  let z = (h ^ 0x85ebca6b) >>> 0 || 521288629;
  let w = (h ^ 0xc2b2ae35) >>> 0 || 88675123;

  return () => {
    const t = x ^ (x << 11);
    x = y;
    y = z;
    z = w;
    w = (w ^ (w >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
    return w / 0x100000000;
  };
}

/**
 * Sample a triangular distribution by inverse transform.
 *
 * Degenerate cases matter: a planner who gives the same three numbers is saying
 * the duration is certain, and the sampler must return that rather than divide
 * by a zero range.
 */
export function sampleTriangular(optimistic: number, mostLikely: number, pessimistic: number, u: number): number {
  const low = Math.min(optimistic, mostLikely, pessimistic);
  const high = Math.max(optimistic, mostLikely, pessimistic);
  const mode = Math.min(Math.max(mostLikely, low), high);

  if (high === low) return low;
  const f = (mode - low) / (high - low);
  return u < f
    ? low + Math.sqrt(u * (high - low) * (mode - low))
    : high - Math.sqrt((1 - u) * (high - low) * (high - mode));
}

export type SimulationResult = {
  iterations: number;
  /** Duration at each confidence level, in working days. */
  p10: number;
  p50: number;
  p80: number;
  p90: number;
  meanDays: number;
  /** The deterministic answer, for comparison rather than for use. */
  deterministicDays: number;
  /**
   * How far the analytic P80 was out, in days. Positive means it was
   * optimistic; negative means it overstated the risk.
   *
   * Reported rather than hidden. A platform that silently replaced a number
   * people had been quoting would leave them unable to explain the change, and
   * the sign is the part that tells them which way it was wrong.
   */
  analyticErrorDays: number;
  /**
   * Share of iterations in which each activity landed on the critical path.
   *
   * The output PERT cannot produce, and the one planners act on: an activity
   * critical in three runs out of five is a risk the deterministic path never
   * shows, because in the deterministic run it had float.
   */
  criticalityIndex: Array<{ taskId: string; name: string; index: number }>;
  /**
   * Why the analytic figure was out, split into its two causes rather than
   * asserted.
   *
   * **Skew** is the part that has nothing to do with paths: the analytic P80 is
   * centred on the sum of *most likely* durations, while the expected duration
   * of a right-skewed three-point estimate is higher than its mode. Every
   * activity contributes a little, and on a long serial chain it dominates.
   *
   * **Residual** is everything else: merge bias where a competitor can
   * overtake, the opposite error where parallel work is summed as though it
   * were sequential, and the normal approximation's own understatement of the
   * upper tail of a sum of skewed durations. They are grouped because the
   * platform cannot separate them from the data, and naming one of them as
   * *the* cause would be a guess dressed as an explanation.
   */
  skewDays: number;
  residualDays: number;
  /** Probability of hitting a contractual date, where one was supplied. */
  probabilityOnTime?: number;
};

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (position - lower) * (sorted[upper]! - sorted[lower]!);
}

/**
 * Run the network many times and report the distribution of completion dates.
 *
 * `analyticP80` is the figure the classical method produced. It is taken as an
 * argument rather than recomputed so the comparison is against the number the
 * platform actually published, not a second derivation of it.
 */
export function simulateCompletion(
  activities: ThreePointActivity[],
  dependencies: Dependency[],
  options: {
    seed: string;
    iterations?: number;
    contractualDurationDays?: number;
    analyticP80Days?: number;
  },
): SimulationResult {
  const iterations = Math.max(200, Math.min(options.iterations ?? 2_000, 20_000));
  const random = seededRandom(options.seed);

  const deterministic = calculateCPM(activities, dependencies);
  const durations: number[] = [];
  const criticalCount = new Map<string, number>();

  for (const activity of activities) criticalCount.set(activity.id, 0);

  for (let i = 0; i < iterations; i++) {
    const sampled: Activity[] = activities.map((activity) => ({
      ...activity,
      duration: sampleTriangular(activity.optimistic, activity.mostLikely, activity.pessimistic, random()),
    }));

    // Recomputed from scratch every iteration. Reusing the deterministic
    // critical path and only varying its durations would reintroduce exactly
    // the assumption this exists to remove.
    const run = calculateCPM(sampled, dependencies);
    durations.push(run.projectDuration);
    for (const id of run.criticalPath) {
      criticalCount.set(id, (criticalCount.get(id) ?? 0) + 1);
    }
  }

  // The skew component: how much higher the expected duration of the
  // deterministic critical path is than its most-likely duration. The analytic
  // method centres on the latter and therefore misses this entirely.
  const byId = new Map(activities.map((a) => [a.id, a]));
  const skewDays = deterministic.criticalPath.reduce((sum, id) => {
    const activity = byId.get(id);
    if (!activity) return sum;
    const expected = (activity.optimistic + 4 * activity.mostLikely + activity.pessimistic) / 6;
    return sum + (expected - activity.mostLikely);
  }, 0);

  const sorted = [...durations].sort((a, b) => a - b);
  const mean = durations.reduce((sum, d) => sum + d, 0) / durations.length;
  const p80 = quantile(sorted, 0.8);

  const analyticError =
    options.analyticP80Days === undefined ? 0 : Number((p80 - options.analyticP80Days).toFixed(1));

  const nameById = new Map(activities.map((a) => [a.id, a.name]));
  const criticalityIndex = [...criticalCount.entries()]
    .map(([taskId, count]) => ({
      taskId,
      name: nameById.get(taskId) ?? taskId,
      index: Number((count / iterations).toFixed(3)),
    }))
    .filter((entry) => entry.index > 0)
    .sort((a, b) => b.index - a.index);

  const probabilityOnTime =
    options.contractualDurationDays === undefined
      ? undefined
      : Number((sorted.filter((d) => d <= options.contractualDurationDays!).length / iterations).toFixed(4));

  return {
    iterations,
    p10: Number(quantile(sorted, 0.1).toFixed(1)),
    p50: Number(quantile(sorted, 0.5).toFixed(1)),
    p80: Number(p80.toFixed(1)),
    p90: Number(quantile(sorted, 0.9).toFixed(1)),
    meanDays: Number(mean.toFixed(1)),
    deterministicDays: deterministic.projectDuration,
    analyticErrorDays: analyticError,
    skewDays: Number(skewDays.toFixed(1)),
    residualDays: Number((analyticError - skewDays).toFixed(1)),
    criticalityIndex,
    probabilityOnTime,
  };
}
