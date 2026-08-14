/**
 * Critical path method — forward pass, backward pass, float and criticality.
 *
 * This is deterministic arithmetic, not model output. The AI layer contributes
 * duration uncertainty and recovery judgement; the network itself is computed
 * here so that two runs on the same data always produce the same programme.
 */

export type DependencyType = 'FS' | 'SS' | 'FF' | 'SF';

export type Activity = {
  id: string;
  name: string;
  /** Working days. Milestones have duration 0. */
  duration: number;
  /** Calendar constraint: earliest the activity may start (day index). */
  constraintStart?: number;
};

export type Dependency = {
  predecessorId: string;
  successorId: string;
  type: DependencyType;
  /** Lag in working days; may be negative (lead). */
  lag: number;
};

export type ScheduledActivity = Activity & {
  earlyStart: number;
  earlyFinish: number;
  lateStart: number;
  lateFinish: number;
  totalFloat: number;
  freeFloat: number;
  critical: boolean;
};

export type CPMResult = {
  activities: ScheduledActivity[];
  projectDuration: number;
  criticalPath: string[];
  /** Cycles make a network unschedulable; they are reported, not silently ignored. */
  cycles: string[][];
};

/** Topological order, or the cycle that prevents one. */
function topologicalOrder(
  activityIds: string[],
  dependencies: Dependency[],
): { order: string[]; cycles: string[][] } {
  const successors = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const id of activityIds) {
    successors.set(id, []);
    inDegree.set(id, 0);
  }
  for (const dep of dependencies) {
    if (!successors.has(dep.predecessorId) || !inDegree.has(dep.successorId)) continue;
    (successors.get(dep.predecessorId) as string[]).push(dep.successorId);
    inDegree.set(dep.successorId, (inDegree.get(dep.successorId) ?? 0) + 1);
  }

  // Sorted seeding keeps the resulting order stable across runs.
  const queue = activityIds.filter((id) => (inDegree.get(id) ?? 0) === 0).sort();
  const order: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    for (const successor of (successors.get(id) ?? []).slice().sort()) {
      const remaining = (inDegree.get(successor) ?? 0) - 1;
      inDegree.set(successor, remaining);
      if (remaining === 0) queue.push(successor);
    }
  }

  if (order.length === activityIds.length) return { order, cycles: [] };

  const stuck = activityIds.filter((id) => !order.includes(id));
  return { order, cycles: [stuck] };
}

export function calculateCPM(activities: Activity[], dependencies: Dependency[]): CPMResult {
  const byId = new Map(activities.map((a) => [a.id, a]));
  const ids = activities.map((a) => a.id);
  const { order, cycles } = topologicalOrder(ids, dependencies);

  const predecessorsOf = new Map<string, Dependency[]>();
  const successorsOf = new Map<string, Dependency[]>();
  for (const id of ids) {
    predecessorsOf.set(id, []);
    successorsOf.set(id, []);
  }
  for (const dep of dependencies) {
    if (!byId.has(dep.predecessorId) || !byId.has(dep.successorId)) continue;
    (predecessorsOf.get(dep.successorId) as Dependency[]).push(dep);
    (successorsOf.get(dep.predecessorId) as Dependency[]).push(dep);
  }

  const earlyStart = new Map<string, number>();
  const earlyFinish = new Map<string, number>();

  // --- Forward pass ---------------------------------------------------------
  for (const id of order) {
    const activity = byId.get(id) as Activity;
    let start = activity.constraintStart ?? 0;

    for (const dep of predecessorsOf.get(id) ?? []) {
      const predEarlyStart = earlyStart.get(dep.predecessorId) ?? 0;
      const predEarlyFinish = earlyFinish.get(dep.predecessorId) ?? 0;
      let candidate: number;
      switch (dep.type) {
        case 'FS':
          candidate = predEarlyFinish + dep.lag;
          break;
        case 'SS':
          candidate = predEarlyStart + dep.lag;
          break;
        case 'FF':
          candidate = predEarlyFinish + dep.lag - activity.duration;
          break;
        case 'SF':
          candidate = predEarlyStart + dep.lag - activity.duration;
          break;
      }
      start = Math.max(start, candidate);
    }

    earlyStart.set(id, start);
    earlyFinish.set(id, start + activity.duration);
  }

  const projectDuration = ids.length === 0 ? 0 : Math.max(...ids.map((id) => earlyFinish.get(id) ?? 0));

  // --- Backward pass --------------------------------------------------------
  const lateFinish = new Map<string, number>();
  const lateStart = new Map<string, number>();

  for (const id of [...order].reverse()) {
    const activity = byId.get(id) as Activity;
    const successors = successorsOf.get(id) ?? [];
    let finish = successors.length === 0 ? projectDuration : Number.POSITIVE_INFINITY;

    for (const dep of successors) {
      const succLateStart = lateStart.get(dep.successorId) ?? projectDuration;
      const succLateFinish = lateFinish.get(dep.successorId) ?? projectDuration;
      let candidate: number;
      switch (dep.type) {
        case 'FS':
          candidate = succLateStart - dep.lag;
          break;
        case 'SS':
          candidate = succLateStart - dep.lag + activity.duration;
          break;
        case 'FF':
          candidate = succLateFinish - dep.lag;
          break;
        case 'SF':
          candidate = succLateFinish - dep.lag + activity.duration;
          break;
      }
      finish = Math.min(finish, candidate);
    }

    if (!Number.isFinite(finish)) finish = projectDuration;
    lateFinish.set(id, finish);
    lateStart.set(id, finish - activity.duration);
  }

  const scheduled: ScheduledActivity[] = activities.map((activity) => {
    const es = earlyStart.get(activity.id) ?? 0;
    const ef = earlyFinish.get(activity.id) ?? 0;
    const ls = lateStart.get(activity.id) ?? 0;
    const lf = lateFinish.get(activity.id) ?? 0;
    const totalFloat = ls - es;

    // Free float: delay available before the earliest successor is disturbed.
    const successors = successorsOf.get(activity.id) ?? [];
    const freeFloat =
      successors.length === 0
        ? totalFloat
        : Math.min(
            ...successors.map((dep) => {
              const succEarlyStart = earlyStart.get(dep.successorId) ?? 0;
              return dep.type === 'FS' ? succEarlyStart - dep.lag - ef : totalFloat;
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
      critical: totalFloat <= 0,
    };
  });

  const criticalPath = scheduled
    .filter((a) => a.critical)
    .sort((a, b) => a.earlyStart - b.earlyStart || (a.id < b.id ? -1 : 1))
    .map((a) => a.id);

  return { activities: scheduled, projectDuration, criticalPath, cycles };
}

/**
 * Three-point (PERT) duration estimate with a beta distribution, plus the
 * variance needed to express a completion probability.
 */
export function pert(optimistic: number, mostLikely: number, pessimistic: number): { mean: number; variance: number } {
  const mean = (optimistic + 4 * mostLikely + pessimistic) / 6;
  const sd = (pessimistic - optimistic) / 6;
  return { mean, variance: sd * sd };
}

/** Standard normal CDF — used to convert schedule variance into P(on time). */
export function normalCdf(z: number): number {
  // Abramowitz & Stegun 7.1.26 approximation; accurate to ~1e-7.
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-0.5 * z * z);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

/**
 * Probability of finishing on or before a target, given the critical path's
 * aggregated PERT variance.
 */
export function completionProbability(
  expectedDuration: number,
  varianceSum: number,
  targetDuration: number,
): number {
  if (varianceSum <= 0) return expectedDuration <= targetDuration ? 1 : 0;
  const z = (targetDuration - expectedDuration) / Math.sqrt(varianceSum);
  return Number(normalCdf(z).toFixed(4));
}

/** The P-value duration: the duration that will not be exceeded with probability p. */
export function durationAtConfidence(expectedDuration: number, varianceSum: number, p: number): number {
  if (varianceSum <= 0) return expectedDuration;
  // Inverse normal via bisection — avoids shipping a rational approximation.
  let low = -6;
  let high = 6;
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    if (normalCdf(mid) < p) low = mid;
    else high = mid;
  }
  return Number((expectedDuration + ((low + high) / 2) * Math.sqrt(varianceSum)).toFixed(2));
}
