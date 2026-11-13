/**
 * The orchestration runtime — the deterministic task graph that drives a
 * consultancy engagement's work.
 *
 * The spec's orchestration sequence (§4) schedules independent analyses
 * concurrently and runs each task against its dependencies: "Build dependency
 * graph … Schedule independent analyses concurrently." The *execution* of a task
 * is the agent work (a model call, a deterministic model run); what this module
 * owns is the **scheduling** — which tasks are runnable now, which wait on what,
 * the concurrent waves the graph resolves into, and whether the graph is
 * complete. That part must be deterministic and must detect a cycle, because a
 * scheduler that can deadlock or loop is worse than none.
 *
 * It operates on the tasks a `store.ts` workboard already holds (`dependsOn`
 * carries task **keys**), so the graph is read from the record rather than kept
 * beside it. A task is *done* only when it is COMPLETE **and** validated — the
 * same bar the coverage measure uses — so a downstream task never unblocks on an
 * unvalidated predecessor.
 */

import type { TaskState } from './store.ts';

/** A task node reduced to what the scheduler needs. */
export type TaskNode = Pick<TaskState, 'key' | 'dependsOn' | 'runState' | 'validated' | 'requiredDigital'>;

const isDone = (t: TaskNode): boolean => t.runState === 'COMPLETE' && t.validated;

/**
 * The tasks ready to run now: QUEUED, with every dependency done. A dependency
 * that names a task not in the set is treated as unmet (a missing predecessor
 * cannot be assumed complete).
 */
export function runnable(tasks: TaskNode[]): string[] {
  const done = new Set(tasks.filter(isDone).map((t) => t.key));
  return tasks
    .filter((t) => t.runState === 'QUEUED' && t.dependsOn.every((d) => done.has(d)))
    .map((t) => t.key);
}

/** Tasks that are not done and are waiting on at least one unfinished dependency. */
export function waiting(tasks: TaskNode[]): Array<{ key: string; waitingOn: string[] }> {
  const done = new Set(tasks.filter(isDone).map((t) => t.key));
  return tasks
    .filter((t) => !isDone(t))
    .map((t) => ({ key: t.key, waitingOn: t.dependsOn.filter((d) => !done.has(d)) }))
    .filter((w) => w.waitingOn.length > 0);
}

export type Schedule = {
  /** Concurrent waves: every task in a wave can run once the waves before it are done. */
  waves: string[][];
  /** The keys on a dependency cycle, if the graph has one (the waves are then partial). */
  cycle?: string[];
};

/**
 * Resolve the graph into concurrent waves by topological level — a deterministic
 * Kahn's-algorithm layering, so independent analyses land in the same wave and
 * run concurrently. If tasks remain when no wave can be formed, the leftover set
 * is on a cycle and is returned as such rather than looped on.
 */
export function schedule(tasks: TaskNode[]): Schedule {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const remaining = new Set(tasks.map((t) => t.key));
  const placed = new Set<string>();
  const waves: string[][] = [];

  while (remaining.size > 0) {
    // A task joins this wave when every dependency it names is either already
    // placed or not a task in this graph (an external/absent dependency does not
    // hold up the internal schedule — it surfaces as a blocker elsewhere).
    const wave = [...remaining]
      .filter((key) => (byKey.get(key)!.dependsOn).every((d) => placed.has(d) || !byKey.has(d)))
      .sort();
    if (wave.length === 0) {
      // Nothing could be placed: the remainder is a cycle.
      return { waves, cycle: [...remaining].sort() };
    }
    for (const key of wave) { remaining.delete(key); placed.add(key); }
    waves.push(wave);
  }
  return { waves };
}

/** Whether every required digital task in the graph is done (COMPLETE and validated). */
export function graphComplete(tasks: TaskNode[]): boolean {
  const required = tasks.filter((t) => t.requiredDigital);
  return required.length > 0 && required.every(isDone);
}

export type Plan = {
  runnable: string[];
  waiting: Array<{ key: string; waitingOn: string[] }>;
  waves: string[][];
  cycle?: string[];
  complete: boolean;
};

/** The whole scheduling picture for an engagement's tasks. */
export function plan(tasks: TaskNode[]): Plan {
  const s = schedule(tasks);
  return {
    runnable: runnable(tasks),
    waiting: waiting(tasks),
    waves: s.waves,
    ...(s.cycle ? { cycle: s.cycle } : {}),
    complete: graphComplete(tasks),
  };
}
