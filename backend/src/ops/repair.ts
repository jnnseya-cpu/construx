import { config } from '../config.ts';
import { drain, due, outboxPosition } from '../notifications/outbox.ts';
import { egressPosition, flush } from './otlp.ts';
import type { Platform } from '../platform.ts';

/**
 * Auto-repair, bounded to restart and reroute.
 *
 * The blueprint's line on this is the load-bearing one and it is kept
 * literally: **autonomous code patching and redeploy is refused.** An agent that
 * can change the code holding the evidence can change the evidence, and no
 * amount of approval workflow around it changes that — the capability itself is
 * the problem. What is permitted is restarting something that has stopped and
 * re-running something that is owed. Nothing here writes project state, nothing
 * here changes configuration, and nothing here deploys.
 *
 * ## The two failures worth repairing without asking
 *
 * **A timer that stopped.** `setInterval` survives most things and not
 * everything: an exception thrown inside a handler on some paths, a process
 * suspended and resumed, a clock that moved. A stopped drain is silent — the
 * outbox fills, nothing sends, and the first symptom is a customer saying they
 * never got the notice. Restarting it costs nothing and can be done wrongly
 * only by doing it twice, which is idempotent.
 *
 * **A queue that is owed and not moving.** Entries past their next-attempt time
 * with nothing draining them. Re-running the drain is the same operation the
 * timer would have performed, so the blast radius is exactly the blast radius of
 * normal operation.
 *
 * ## Why this is not the health agent
 *
 * `agents/platform.ts` has a `health` agent whose envelope is notify-only, and
 * that is the right ceiling for something that reads watch rules and tells
 * somebody. This is a different act — it changes the running process — and it is
 * deliberately not offered to an agent at all. It runs on its own interval, or
 * an operator triggers it. There is no path by which an agent causes a repair,
 * because "an agent may restart parts of the platform" is a sentence that needs
 * a much better reason than convenience.
 *
 * ## Every repair is observed, and a repeated one is a finding
 *
 * A repair that works is fine once. The same repair firing every interval means
 * something is re-breaking, and that is a defect being hidden by the thing
 * meant to be papering over a blip. The count is reported.
 */

export type RepairAction = 'RESTART_OUTBOX_DRAIN' | 'DRAIN_OWED_NOTICES' | 'FLUSH_STALLED_TELEMETRY';

export type RepairAttempt = {
  action: RepairAction;
  at: string;
  /** What was observed that justified it. Never "just in case". */
  because: string;
  repaired: boolean;
  detail?: string;
};

export type RepairPosition = {
  enabled: boolean;
  attempts: RepairAttempt[];
  /** How often each repair has fired. A rising count is a defect, not a fix. */
  counts: Record<string, number>;
  /**
   * Repairs that have fired often enough to be a finding rather than a fix.
   * Named so the platform cannot quietly paper over the same fault for ever.
   */
  recurring: Array<{ action: RepairAction; count: number; because: string }>;
  /** What this module will never do, published rather than assumed. */
  refuses: string[];
};

/** Beyond this many, a repair is a symptom rather than a remedy. */
export const RECURRENCE_THRESHOLD = 5;

const attempts: RepairAttempt[] = [];
const counts = new Map<RepairAction, number>();
let timer: NodeJS.Timeout | undefined;

/** Set by `main.ts`, so a restart can re-arm the real timer rather than a copy. */
let restartOutboxDrain: (() => void) | undefined;

/**
 * Hand the repairer the one thing it needs to restart.
 *
 * A function rather than the timer handle: restarting means calling
 * `startOutboxDrain` again, and only the composition root knows how to do that
 * with the right platform. Passing a handle would let this module clear a timer
 * it could not replace.
 */
export function armRepair(restart: () => void): void {
  restartOutboxDrain = restart;
}

function record(attempt: RepairAttempt): RepairAttempt {
  attempts.push(attempt);
  if (attempts.length > 200) attempts.splice(0, 100);
  counts.set(attempt.action, (counts.get(attempt.action) ?? 0) + 1);
  return attempt;
}

/**
 * Look for the two conditions, and repair them if found.
 *
 * Exported so an operator can force a pass and so a test can drive it without a
 * timer. Never throws: a repairer that falls over is worse than one that does
 * nothing, because the thing it was watching is now unwatched *and* the process
 * has a new failure in it.
 */
export async function repair(platform: Platform): Promise<RepairAttempt[]> {
  const taken: RepairAttempt[] = [];
  const at = new Date().toISOString();

  try {
    // 1. Notices owed, past their attempt time, and nothing moving them.
    const owed = due(platform);
    if (owed.length > 0) {
      const position = outboxPosition(platform);
      const report = await drain(platform);
      taken.push(
        record({
          action: 'DRAIN_OWED_NOTICES',
          at,
          because:
            `${owed.length} notice${owed.length === 1 ? '' : 's'} past their next attempt with ${position.due} due. ` +
            'A stopped drain is silent: the first symptom is a customer saying they never received something.',
          repaired: report.sent > 0 || report.retrying === 0,
          detail: `${report.sent} sent, ${report.retrying} still owed, ${report.abandoned} out of attempts`,
        }),
      );

      // Re-arming the timer as well, because a queue that was owed and idle is
      // the observable symptom of a drain that is no longer running. Idempotent
      // — `startOutboxDrain` replaces its own interval.
      if (restartOutboxDrain) {
        restartOutboxDrain();
        taken.push(
          record({
            action: 'RESTART_OUTBOX_DRAIN',
            at,
            because: 'The queue was owed and idle, which is what a stopped drain looks like from outside.',
            repaired: true,
          }),
        );
      }
    }

    // 2. Telemetry queued and not leaving. Same shape of failure, different
    // queue: a collector that recovered while the exporter had given up.
    const egress = egressPosition();
    if (egress.configured && egress.queued > 0 && egress.failures > 0) {
      const result = await flush();
      taken.push(
        record({
          action: 'FLUSH_STALLED_TELEMETRY',
          at,
          because:
            `${egress.queued} records queued after ${egress.failures} failed exports. ` +
            'A collector that came back does not tell the exporter it did.',
          repaired: result.metrics,
          detail: result.error ?? `${result.logs} records shipped`,
        }),
      );
    }
  } catch (error) {
    // Recorded, not thrown. The caller is an interval.
    taken.push(
      record({
        action: 'DRAIN_OWED_NOTICES',
        at,
        because: 'A repair pass was attempted.',
        repaired: false,
        detail: `The repair itself failed: ${error instanceof Error ? error.message : String(error)}`,
      }),
    );
  }

  return taken;
}

export function repairPosition(): RepairPosition {
  const recurring = [...counts.entries()]
    .filter(([, count]) => count >= RECURRENCE_THRESHOLD)
    .map(([action, count]) => ({
      action,
      count,
      because:
        `Repaired ${count} times. A repair that keeps firing is not a fix — something is re-breaking, and this ` +
        'is the platform papering over it.',
    }));

  return {
    enabled: config.repair.enabled,
    attempts: attempts.slice(-50),
    counts: Object.fromEntries(counts),
    recurring,
    // Published rather than assumed. The boundary is the product, and a
    // boundary nobody can read is one nobody can hold anybody to.
    refuses: [
      'Changing code. An agent that can change the code holding the evidence can change the evidence.',
      'Deploying, rolling back, or restarting the process.',
      'Writing project state, or any governed event.',
      'Changing configuration, credentials or permissions.',
      'Repairing a chain divergence — that is detected and reported, never mended.',
    ],
  };
}

export function startRepair(platform: Platform): NodeJS.Timeout | undefined {
  if (!config.repair.enabled || timer) return timer;

  timer = setInterval(() => {
    void repair(platform);
  }, config.repair.intervalSeconds * 1_000);

  timer.unref();
  return timer;
}

export function stopRepair(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

/** Test isolation only. */
export function resetRepair(): void {
  attempts.length = 0;
  counts.clear();
  restartOutboxDrain = undefined;
  stopRepair();
}
