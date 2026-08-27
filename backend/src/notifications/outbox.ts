import { config } from '../config.ts';
import { ulid } from '../core/ids.ts';
import type { Platform } from '../platform.ts';
import { requireEvent, type Channel } from './catalogue.ts';
import { NOTIFICATIONS_PROJECT_ID } from './preferences.ts';
import type { Branding } from './render.ts';
import type { Recipient } from './notify.ts';

/**
 * The outbox.
 *
 * A notification used to be transmitted first and recorded afterwards. That
 * ordering has one failure and it is the worst one: a process that dies between
 * deciding to tell somebody and telling them leaves nothing at all — no notice,
 * no record, and nobody who could know a notice was owed. The payment-failure
 * email that never went is indistinguishable from the payment that never
 * failed.
 *
 * So the intent is written down first. `NOTIFICATION_QUEUED` goes into the
 * ledger — which means onto the volume, through the journal's write-ahead
 * fsync — carrying everything needed to deliver: the catalogue code, the
 * recipients, the payload, the branding. Only then is anything transmitted, and
 * `NOTIFICATION_QUEUE_SETTLED` records how it went.
 *
 * A queued notice that was never settled is one the platform still owes.
 * `drain()` picks those up, which makes delivery **at-least-once** instead of
 * at-most-once, and gives the platform a retry it never had: a refused relay
 * used to record `FAILED` and be forgotten in the same breath.
 *
 * ---
 *
 * **What this is, precisely, and what it is not.** It is an outbox: the intent
 * is durable in the same store as the record, and no notice can be lost after
 * the decision to send it. It is not a distributed transaction. The domain
 * event that prompted the notice and the queue entry are two appends to the
 * same journal, one after the other, so a crash in the microseconds between
 * them loses the notice and keeps the fact. Closing that would take committing
 * both in one journal write, which means a batched commit on the ledger — the
 * most load-bearing function in the codebase — for a window this narrow. It is
 * stated here rather than papered over, and it is one of the things the
 * Postgres design in `STATE.md` closes properly.
 *
 * **Retries stop.** Five attempts with a doubling backoff, both configurable.
 * The failures worth retrying are transient; the ones that are not do not
 * become deliverable on the sixth attempt, and a queue that retries for ever
 * hides a permanently bad address behind a number that never stops rising.
 *
 * **Nothing here decides who gets told.** Preference checks, channel routing
 * and the transports all stay in `notify.ts`. This module owns durability and
 * ordering, and duplicating a routing rule here would put a second opinion
 * about who may be emailed one file away from the first.
 */

export type OutboxStatus = 'QUEUED' | 'SENT' | 'ABANDONED';

export type OutboxEntry = {
  outboxId: string;
  tenantId: string;
  code: string;
  recipients: Recipient[];
  payload: Record<string, unknown>;
  channels?: Channel[];
  branding: Branding;
  actorId: string;
  correlationId: string;
  status: OutboxStatus;
  attempts: number;
  queuedAt: string;
  /** When the next attempt becomes due. Absent once settled. */
  nextAttemptAt?: string;
  lastAttemptAt?: string;
  lastError?: string;
  settledAt?: string;
  /** The dispatch this became, once it was delivered. */
  dispatchId?: string;
};

export type QueueInput = {
  code: string;
  recipients: Recipient[];
  payload?: Record<string, unknown>;
  channels?: Channel[];
  branding: Branding;
  actorId: string;
  correlationId: string;
};

function entriesOf(platform: Platform): OutboxEntry[] {
  return platform.ledger
    .list(NOTIFICATIONS_PROJECT_ID, 'NotificationOutbox')
    .map((record) => record.state as unknown as OutboxEntry)
    .sort((a, b) => (a.queuedAt < b.queuedAt ? -1 : 1));
}

/**
 * Write down that a notice is owed, before anything is transmitted.
 *
 * The catalogue code is checked here rather than at delivery: a code that is
 * not in the closed catalogue is a programming error, and queueing it would
 * park an undeliverable entry that fails identically on every retry until it is
 * abandoned five attempts later.
 */
export function queue(platform: Platform, input: QueueInput): OutboxEntry {
  requireEvent(input.code);

  const now = new Date().toISOString();
  const entry: OutboxEntry = {
    outboxId: ulid(),
    tenantId: input.recipients[0]?.tenantId ?? 'platform',
    code: input.code,
    recipients: input.recipients,
    payload: input.payload ?? {},
    ...(input.channels ? { channels: input.channels } : {}),
    branding: input.branding,
    actorId: input.actorId,
    correlationId: input.correlationId,
    status: 'QUEUED',
    attempts: 0,
    queuedAt: now,
    nextAttemptAt: now,
  };

  platform.ledger.commit({
    tenantId: entry.tenantId,
    projectId: NOTIFICATIONS_PROJECT_ID,
    eventType: 'NOTIFICATION_QUEUED',
    entity: { refType: 'NotificationOutbox', refId: entry.outboxId },
    actor: { refType: 'System', refId: input.actorId },
    source: 'SYSTEM',
    correlationId: input.correlationId,
    nextState: entry as unknown as Record<string, unknown>,
  });

  return entry;
}

/**
 * Record how an attempt went. Settled entries are never attempted again.
 *
 * `delivered: false` leaves the entry owed and schedules the next attempt,
 * unless the attempts are spent — in which case it is abandoned, which is a
 * settled state with a reason on it rather than a queue entry nobody is
 * watching.
 */
export function recordAttempt(
  platform: Platform,
  entry: OutboxEntry,
  outcome: { delivered: boolean; dispatchId?: string; error?: string },
): OutboxEntry {
  const now = new Date().toISOString();
  const attempts = entry.attempts + 1;
  const exhausted = attempts >= config.notifications.maxAttempts;

  const next: OutboxEntry = {
    ...entry,
    attempts,
    lastAttemptAt: now,
    status: outcome.delivered ? 'SENT' : exhausted ? 'ABANDONED' : 'QUEUED',
    ...(outcome.dispatchId ? { dispatchId: outcome.dispatchId } : {}),
    ...(outcome.error ? { lastError: outcome.error } : {}),
  };

  if (next.status === 'QUEUED') {
    // Doubling backoff. A relay that refused because it was overloaded is not
    // helped by being asked again immediately.
    const wait = config.notifications.retryBackoffSeconds * 2 ** (attempts - 1);
    next.nextAttemptAt = new Date(Date.parse(now) + wait * 1000).toISOString();
    delete next.settledAt;
  } else {
    next.settledAt = now;
    delete next.nextAttemptAt;
  }

  platform.ledger.commit({
    tenantId: entry.tenantId,
    projectId: NOTIFICATIONS_PROJECT_ID,
    eventType: 'NOTIFICATION_QUEUE_SETTLED',
    entity: { refType: 'NotificationOutbox', refId: entry.outboxId },
    actor: { refType: 'System', refId: entry.actorId },
    source: 'SYSTEM',
    correlationId: entry.correlationId,
    nextState: next as unknown as Record<string, unknown>,
  });

  return next;
}

/** Everything still owed and due now. Ordered oldest first, as a queue is. */
export function due(platform: Platform, at: string = new Date().toISOString()): OutboxEntry[] {
  return entriesOf(platform).filter(
    (entry) => entry.status === 'QUEUED' && (entry.nextAttemptAt === undefined || entry.nextAttemptAt <= at),
  );
}

export type DrainReport = {
  attempted: number;
  sent: number;
  /** Failed this pass and still owed — they will be tried again. */
  retrying: number;
  /** Out of attempts. Nobody will try these again without being asked. */
  abandoned: number;
};

/**
 * Deliver what is owed.
 *
 * Called inline after every queue, so an ordinary notification is transmitted
 * in the same request that raised it, and on a timer, which exists for exactly
 * one case: entries queued by a process that died before delivering them.
 *
 * `at` winds the clock forward for the backoff only, so a caller can ask for
 * everything that will be due by a given moment. It is what the retry tests use
 * instead of waiting four minutes; nothing in production passes it.
 *
 * A delivery is counted as sent when the dispatch produced at least one
 * delivery that was not a hard failure. `RECORDED` counts — a channel with no
 * carrier configured did everything the platform can do, and retrying it five
 * times would fill the log with attempts at a transport that does not exist.
 * `SUPPRESSED` counts too: the recipient muted it, which is an outcome and not
 * a failure to deliver.
 */
export async function drain(
  platform: Platform,
  options: { limit?: number; at?: string } = {},
): Promise<DrainReport> {
  // Imported here rather than at the top: `notify.ts` imports this module for
  // `queue`, and a static cycle between the two would leave one of them
  // half-initialised depending on which was loaded first.
  const { dispatchNow } = await import('./notify.ts');

  const report: DrainReport = { attempted: 0, sent: 0, retrying: 0, abandoned: 0 };

  for (const entry of due(platform, options.at).slice(0, options.limit ?? 100)) {
    report.attempted += 1;
    try {
      const dispatch = await dispatchNow(platform, entry);
      const delivered =
        dispatch.deliveries.length === 0 || dispatch.deliveries.some((delivery) => delivery.status !== 'FAILED');
      const settled = recordAttempt(platform, entry, {
        delivered,
        dispatchId: dispatch.id,
        error: delivered ? undefined : dispatch.deliveries.map((delivery) => delivery.detail).join('; '),
      });
      if (settled.status === 'SENT') report.sent += 1;
      else if (settled.status === 'ABANDONED') report.abandoned += 1;
      else report.retrying += 1;
    } catch (error) {
      // A throw here is the transport or the renderer failing outright, not a
      // recipient refusing. Recorded and retried, because the alternative is
      // the loop stopping and everything behind it staying undelivered.
      const settled = recordAttempt(platform, entry, {
        delivered: false,
        error: error instanceof Error ? error.message : String(error),
      });
      if (settled.status === 'ABANDONED') report.abandoned += 1;
      else report.retrying += 1;
    }
  }

  return report;
}

export type OutboxPosition = {
  queued: number;
  sent: number;
  abandoned: number;
  /** Queued and due now — anything here is a notice the platform owes. */
  due: number;
  oldestQueuedAt?: string;
  /** The ones that gave up, newest first. These are what an operator reads. */
  abandonedEntries: Array<{
    outboxId: string;
    code: string;
    tenantId: string;
    attempts: number;
    queuedAt: string;
    lastError?: string;
  }>;
};

/**
 * What the platform owes and what it gave up on.
 *
 * Scoped across every tenancy, because the outbox is a platform chain and the
 * question it answers — "is anything failing to go out" — is an operator's.
 */
export function outboxPosition(platform: Platform): OutboxPosition {
  const all = entriesOf(platform);
  const queued = all.filter((entry) => entry.status === 'QUEUED');
  const abandoned = all.filter((entry) => entry.status === 'ABANDONED');

  return {
    queued: queued.length,
    sent: all.filter((entry) => entry.status === 'SENT').length,
    abandoned: abandoned.length,
    due: due(platform).length,
    oldestQueuedAt: queued.map((entry) => entry.queuedAt).sort().at(0),
    abandonedEntries: abandoned
      .slice()
      .reverse()
      .slice(0, 25)
      .map((entry) => ({
        outboxId: entry.outboxId,
        code: entry.code,
        tenantId: entry.tenantId,
        attempts: entry.attempts,
        queuedAt: entry.queuedAt,
        ...(entry.lastError ? { lastError: entry.lastError } : {}),
      })),
  };
}

/**
 * Start the timer that picks up what a dead process left behind.
 *
 * Returns a stop function. Unreferenced so a drain in flight never holds the
 * process open at shutdown — a notice that misses this pass is still queued and
 * goes out on the next one, which is the property the whole module exists for.
 */
export function startOutboxDrain(platform: Platform): () => void {
  const timer = setInterval(() => {
    void drain(platform).catch((error) => {
      process.stderr.write(`[outbox] drain failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }, config.notifications.drainIntervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
