import { config } from '../config.ts';
import { ulid } from '../core/ids.ts';
import { scopesForRoles } from '../identity/scopes.ts';
import type { AuthContext } from '../identity/auth.ts';
import type { Platform } from '../platform.ts';
import {
  MAX_ATTEMPTS,
  recordDelivery,
  sign,
  type Delivery,
  type DeliveryOutcome,
  type Subscription,
} from './webhooks.ts';

/**
 * Actually posting what the outbox owes.
 *
 * ## What was missing
 *
 * The queue, the signature, the backoff, the abandonment threshold and the
 * register were all built and tested. Nothing drained them, and nothing filled
 * them either — every integrator subscription was a URL that would never be
 * posted to, with no failure anywhere to say so. `enqueue` is now called from
 * the single write path; this is the other half.
 *
 * ## AC-12, which is the whole point of the shape
 *
 * *Outbox publication temporarily fails; the core conversion commits; live
 * state remains valid and the event retries without duplication.*
 *
 * Three properties, each held by something specific:
 *
 * **The conversion commits.** Deliveries are queued, never sent inline, and
 * `publish` swallows its own failures. A customer's unreachable endpoint cannot
 * reach the transaction that caused the event.
 *
 * **Live state remains valid.** Nothing here writes project state. The worst a
 * failing endpoint produces is an abandoned delivery record and a disabled
 * subscription, both of them visible on the developer screen.
 *
 * **It retries without duplication.** The delivery id is minted when the entry
 * is queued and travels in the signed body, so every retry of one event carries
 * the same `deliveryId` and the same `eventId`. A receiver deduplicates on
 * either. This is at-least-once with a key, which is the honest guarantee of
 * anything that retries — promising exactly-once from the sending side would be
 * promising something no sender can give.
 */

/** The actor a drain writes under. Named, so an audit can see it was the drain. */
const DRAIN_ACTOR = 'system-webhook-drain';

function drainAuth(tenantId: string): AuthContext {
  return {
    actorId: DRAIN_ACTOR,
    tenantId,
    // The role that already holds `ENTERPRISE_STRUCTURE`, which is the area the
    // delivery register is classified under. The scope gate is applied to the
    // drain exactly as it is to a session rather than bypassed for it.
    roles: ['ENTERPRISE_ADMIN'],
    scopes: scopesForRoles(['ENTERPRISE_ADMIN']),
    tokenId: `webhook-drain-${ulid()}`,
    mfaSatisfied: true,
    regulatorAiEnabled: false,
    expiresAt: Math.floor(Date.now() / 1000) + 60,
  };
}

/**
 * Deliveries this tenancy owes now, oldest first, each with the project stream
 * it lives on.
 *
 * The project id is carried rather than assumed, and that is not bookkeeping.
 * A delivery is queued by `enqueue` on the stream of the write that caused it,
 * so a delivery for an award lives on that project's chain. The drain has to
 * write the attempt back to the *same* stream: the ledger refuses a commit that
 * would move an entity between projects — correctly, as a tenant-isolation
 * breach — and the first version of this drain, which built its context from
 * the tenant id, was refused by exactly that check on every attempt.
 */
function dueRecords(
  platform: Platform,
  tenantId: string,
  at: string,
): Array<{ delivery: Delivery; projectId: string }> {
  return platform.ledger
    .listByTenant(tenantId, 'WebhookDelivery')
    .map((record) => ({ delivery: record.state as unknown as Delivery, projectId: record.projectId }))
    .filter((entry) => entry.delivery.status === 'QUEUED' && entry.delivery.nextAttemptAt <= at)
    .sort((a, b) => (a.delivery.queuedAt < b.delivery.queuedAt ? -1 : 1));
}

/** Deliveries this tenancy owes now, oldest first. */
export function due(platform: Platform, tenantId: string, at: string = new Date().toISOString()): Delivery[] {
  return dueRecords(platform, tenantId, at).map((entry) => entry.delivery);
}

/** Every tenancy that has at least one subscription, so the drain knows where to look. */
export function tenanciesWithSubscriptions(platform: Platform): string[] {
  return [...new Set(platform.ledger.entitiesOfType('WebhookSubscription').map((record) => record.tenantId))];
}

export type WebhookDrainReport = {
  attempted: number;
  delivered: number;
  /** Failed this pass and still owed. */
  retrying: number;
  /** Out of attempts. Nobody will try these again without being asked. */
  abandoned: number;
  subscriptionsDisabled: number;
};

/**
 * One POST, with the signature over the exact body that was queued.
 *
 * Separated so a test can drive the whole drain against a failing transport
 * without a network, which is what AC-12 needs: the interesting case is the one
 * where publication fails, and a test that could only exercise success would
 * prove the opposite of what is required.
 */
export type Transport = (input: {
  url: string;
  body: string;
  headers: Record<string, string>;
}) => Promise<{ ok: boolean; status?: number; error?: string }>;

const httpTransport: Transport = async ({ url, body, headers }) => {
  // A receiver that hangs must not hold the drain open behind it. The whole
  // pass is bounded by the per-attempt timeout times the batch size.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { method: 'POST', body, headers, signal: controller.signal });
    return response.ok
      ? { ok: true, status: response.status }
      : { ok: false, status: response.status, error: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Deliveries already being attempted by another pass.
 *
 * Two drains overlap easily — the timer and a boot pass, or two ticks around a
 * slow receiver — and the list each read was taken before either began. Without
 * the claim both post the same body, which is a duplicate the receiver has to
 * deduplicate rather than one the platform avoided sending.
 */
const inFlight = new Set<string>();

export async function drainWebhooks(
  platform: Platform,
  options: { limit?: number; at?: string; transport?: Transport } = {},
): Promise<WebhookDrainReport> {
  const transport = options.transport ?? httpTransport;
  const report: WebhookDrainReport = { attempted: 0, delivered: 0, retrying: 0, abandoned: 0, subscriptionsDisabled: 0 };
  const limit = options.limit ?? 100;

  for (const tenantId of tenanciesWithSubscriptions(platform)) {
    for (const { delivery, projectId } of dueRecords(platform, tenantId, options.at ?? new Date().toISOString())) {
      if (report.attempted >= limit) break;
      /*
       * Read per delivery, not cached per tenancy.
       *
       * A snapshot taken once at the top of the loop goes stale the moment the
       * first delivery to that subscription records its outcome — and then the
       * second delivery computes its health update against the old failure
       * count, produces the state that was just written, and the ledger refuses
       * it as a no-op. That refusal would abort the drain on the *second*
       * delivery to a recovering endpoint, which is precisely the endpoint with
       * a backlog behind it.
       */
      const subscription = platform.ledger.get({ refType: 'WebhookSubscription', refId: delivery.subscriptionId })
        ?.state as unknown as Subscription | undefined;
      // A delivery whose subscription was removed or disabled is not owed. It
      // stays QUEUED and stays visible rather than being quietly marked sent —
      // an integrator who re-enables the endpoint gets the backlog.
      if (!subscription || !subscription.active) continue;
      if (inFlight.has(delivery.id)) continue;
      inFlight.add(delivery.id);
      report.attempted += 1;

      // The engine context is built per delivery, on the stream the delivery
      // record already lives on — see `dueRecords` for why that is the only
      // stream the attempt can be written to.
      const ctx = platform.context(drainAuth(tenantId), projectId, {
        source: 'SYSTEM',
        correlationId: `webhook-${delivery.id}`,
      });

      try {
        const timestamp = Math.floor(Date.now() / 1000);
        const result = await transport({
          url: subscription.url,
          body: delivery.body,
          headers: {
            'content-type': 'application/json',
            'x-construx-signature': sign(subscription.secret, delivery.body, timestamp),
            // Stable across every retry of this event, which is what makes the
            // receiver's side exactly-once achievable — AC-12's "without
            // duplication".
            'x-construx-delivery-id': delivery.id,
            'x-construx-event-id': delivery.eventId,
            'x-construx-event-type': delivery.eventType,
          },
        });

        const outcome: DeliveryOutcome = {
          deliveryId: delivery.id,
          delivered: result.ok,
          ...(result.status === undefined ? {} : { status: result.status }),
          ...(result.error === undefined ? {} : { error: result.error }),
        };
        const settled = recordDelivery(ctx, { subscription, delivery, outcome });
        if (settled.delivery.status === 'DELIVERED') report.delivered += 1;
        else if (settled.delivery.status === 'ABANDONED') report.abandoned += 1;
        else report.retrying += 1;
        if (settled.subscriptionDisabled) report.subscriptionsDisabled += 1;
      } catch (error) {
        // A throw here is the platform's own machinery failing, not a receiver
        // refusing. Recorded as a failed attempt so it backs off and is tried
        // again, because the alternative is the loop stopping and everything
        // behind it staying undelivered.
        const settled = recordDelivery(ctx, {
          subscription,
          delivery,
          outcome: {
            deliveryId: delivery.id,
            delivered: false,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        if (settled.delivery.status === 'ABANDONED') report.abandoned += 1;
        else report.retrying += 1;
        if (settled.subscriptionDisabled) report.subscriptionsDisabled += 1;
      } finally {
        inFlight.delete(delivery.id);
      }
    }
  }

  return report;
}

/**
 * Start the timer that posts what the outbox owes.
 *
 * Returns a stop function. Unreferenced, so a delivery in flight never holds
 * the process open at shutdown — a delivery that misses this pass is still
 * queued and goes out on the next one, which is the property the queue exists
 * for. The interval is the notification outbox's, because it answers the same
 * question and two drain cadences to tune is one more than anybody needs.
 */
export function startWebhookDrain(platform: Platform): () => void {
  const timer = setInterval(() => {
    void drainWebhooks(platform).catch((error) => {
      process.stderr.write(
        `[webhooks] drain failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  }, config.notifications.drainIntervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

/** What the platform owes integrators, across every tenancy — an operator's question. */
export function webhookOutboxPosition(platform: Platform): {
  queued: number;
  delivered: number;
  abandoned: number;
  due: number;
  oldestQueuedAt?: string;
  attemptsRemainingBeforeAbandon: number;
} {
  const all = platform.ledger
    .entitiesOfType('WebhookDelivery')
    .map((record) => record.state as unknown as Delivery);
  const queued = all.filter((entry) => entry.status === 'QUEUED');
  const now = new Date().toISOString();

  return {
    queued: queued.length,
    delivered: all.filter((entry) => entry.status === 'DELIVERED').length,
    abandoned: all.filter((entry) => entry.status === 'ABANDONED').length,
    due: queued.filter((entry) => entry.nextAttemptAt <= now).length,
    ...(queued.length > 0
      ? { oldestQueuedAt: queued.map((entry) => entry.queuedAt).sort()[0] as string }
      : {}),
    attemptsRemainingBeforeAbandon: MAX_ATTEMPTS,
  };
}
