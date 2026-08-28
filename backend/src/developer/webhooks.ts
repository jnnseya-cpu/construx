import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import { lookupEventType } from '../goldenthread/eventTypes.ts';
import type { GoldenThreadEvent } from '../goldenthread/types.ts';
import type { KeyMode } from './keys.ts';

/**
 * Telling an integrator that something happened.
 *
 * The ledger already is a change feed — ordered, append-only, replayable. What
 * was missing is a way for somebody outside the platform to be told about it
 * without polling, and a way to catch up when they were down.
 *
 * ## Why this is not the notification outbox
 *
 * `notifications/outbox.ts` does queue, backoff and abandonment, and reusing it
 * was the first instinct. It is the wrong home. That outbox delivers to *people*
 * through a closed catalogue of notification codes, with consent, branding,
 * unsubscribe tokens and channel preference attached to every entry. A webhook
 * delivers to a *URL*, carries a signature rather than a template, and its
 * catalogue is the Golden Thread's, not the notification one. Folding one into
 * the other would mean a notification code per event type — 492 of them — and a
 * consent model for a machine.
 *
 * So this is a separate queue that follows the same discipline, stated rather
 * than inherited: a delivery that fails is owed rather than lost, retries are
 * bounded and back off, and abandonment is recorded with the reason.
 *
 * ## The signature
 *
 * `x-construx-signature: t=<unix seconds>,v1=<hex>` over `<t>.<body>`, HMAC
 * SHA-256, with the subscription's own secret. The timestamp is inside the
 * signed material, which is what makes a replay detectable: a receiver rejects
 * anything older than its tolerance, and an attacker cannot move the timestamp
 * without invalidating the signature.
 *
 * `verifySignature` is exported and tested. An integrator implementing the
 * receiving half needs to know exactly what to compute, and a signature scheme
 * described in prose is one that gets implemented three different ways.
 *
 * ## At least once, with an idempotency key
 *
 * A delivery may arrive twice — that is the honest guarantee of anything that
 * retries. Every delivery carries `x-construx-delivery-id`, stable across
 * retries of the same event, so a receiver can make it exactly once on their
 * side. Promising exactly-once here would be promising something no retrying
 * sender can give.
 */

export type Subscription = {
  id: string;
  tenantId: string;
  name: string;
  url: string;
  mode: KeyMode;
  /** Golden Thread event codes. Empty means every event this tenancy produces. */
  eventTypes: string[];
  /** Shown once at creation, then held for signing. Never returned by a read. */
  secret: string;
  createdBy: string;
  createdAt: string;
  active: boolean;
  disabledAt?: string;
  disabledReason?: string;
  /** Consecutive failures. A subscription that keeps failing is disabled. */
  consecutiveFailures: number;
  lastDeliveryAt?: string;
  lastFailureReason?: string;
};

export type Delivery = {
  id: string;
  subscriptionId: string;
  tenantId: string;
  eventId: string;
  eventType: string;
  /** The exact body that was signed and sent. */
  body: string;
  status: 'QUEUED' | 'DELIVERED' | 'ABANDONED';
  attempts: number;
  queuedAt: string;
  nextAttemptAt: string;
  deliveredAt?: string;
  lastStatus?: number;
  lastError?: string;
};

/** After this many consecutive failures a subscription stops being tried. */
export const FAILURES_BEFORE_DISABLE = 10;
/** Attempts per delivery before it is abandoned and recorded as owed no longer. */
export const MAX_ATTEMPTS = 6;
/** How old a signed timestamp may be before a receiver should refuse it. */
export const REPLAY_TOLERANCE_SECONDS = 300;

/**
 * Backoff, in seconds, per attempt.
 *
 * Bounded and short of an hour. An unbounded exponential means a receiver that
 * was down for a morning gets its backlog a week later, which is worse than
 * being told it was abandoned.
 */
export function backoffSeconds(attempt: number): number {
  return Math.min(3_600, 10 * 2 ** Math.max(0, attempt - 1));
}

// ------------------------------------------------------------ subscriptions

function subscriptionsOf(ctx: EngineContext): Subscription[] {
  return ctx.ledger
    .listByTenant(ctx.tenantId, 'WebhookSubscription')
    .map((record) => record.state as unknown as Subscription);
}

/**
 * Subscribe a URL to events.
 *
 * The URL is checked here rather than at delivery time. A subscription pointing
 * at `http://localhost:6379` is an SSRF primitive handed to whoever can create
 * one, and discovering that at delivery time means it has already been tried.
 */
export function subscribe(
  ctx: EngineContext,
  input: { name: string; url: string; eventTypes?: string[]; mode?: KeyMode },
): { subscription: Omit<Subscription, 'secret'>; secret: string } {
  authorise(ctx, 'ENTERPRISE_STRUCTURE', 'G');

  assertDeliverableUrl(input.url);

  if (input.name.trim().length < 3) {
    throw new DomainError('WEBHOOK_NAME_REQUIRED', 'Name the integration this endpoint belongs to.');
  }

  // Unknown event codes are refused rather than accepted and never matched. A
  // subscription that silently never fires is the support call that takes a day.
  for (const code of input.eventTypes ?? []) {
    if (!lookupEventType(code)) {
      throw new DomainError(
        'WEBHOOK_EVENT_UNKNOWN',
        `"${code}" is not an event this platform produces. A subscription to it would never fire and nothing would say why.`,
      );
    }
  }

  const secret = `whsec_${randomBytes(32).toString('base64url')}`;
  const subscription: Subscription = {
    id: ulid(),
    tenantId: ctx.tenantId,
    name: input.name.trim(),
    url: input.url,
    mode: input.mode ?? 'LIVE',
    eventTypes: [...(input.eventTypes ?? [])],
    secret,
    createdBy: ctx.auth.actorId,
    createdAt: new Date().toISOString(),
    active: true,
    consecutiveFailures: 0,
  };

  write(ctx, {
    eventType: 'WEBHOOK_SUBSCRIBED',
    entity: { refType: 'WebhookSubscription', refId: subscription.id },
    nextState: subscription as unknown as Record<string, unknown>,
  });

  const { secret: _held, ...published } = subscription;
  return { subscription: published, secret };
}

export function unsubscribe(ctx: EngineContext, input: { subscriptionId: string; reason: string }): void {
  authorise(ctx, 'ENTERPRISE_STRUCTURE', 'G');

  const record = ctx.ledger.get({ refType: 'WebhookSubscription', refId: input.subscriptionId });
  if (!record || record.tenantId !== ctx.tenantId) {
    throw new DomainError('WEBHOOK_NOT_FOUND', `No subscription ${input.subscriptionId}`, 404);
  }
  const subscription = record.state as unknown as Subscription;
  if (!subscription.active) {
    throw new DomainError('WEBHOOK_ALREADY_DISABLED', 'That subscription is already disabled', 409);
  }

  write(ctx, {
    eventType: 'WEBHOOK_DISABLED',
    entity: { refType: 'WebhookSubscription', refId: subscription.id },
    nextState: {
      ...subscription,
      active: false,
      disabledAt: new Date().toISOString(),
      disabledReason: input.reason,
    } as unknown as Record<string, unknown>,
  });
}

/** Every subscription, with the signing secret withheld from every read. */
export function subscriptionRegister(ctx: EngineContext): Array<Omit<Subscription, 'secret'>> {
  authorise(ctx, 'ENTERPRISE_STRUCTURE', 'R');
  return subscriptionsOf(ctx).map(({ secret: _withheld, ...rest }) => rest);
}

/**
 * Refuse a URL nothing should be posting to.
 *
 * A webhook is an outbound request to an address a customer chose, which makes
 * it a server-side request forgery primitive unless it is constrained. HTTPS
 * only, no credentials in the URL, and no address that resolves inside the
 * deployment.
 *
 * Hostname-based rather than resolution-based, and that limit is stated rather
 * than hidden: a name that resolves to a private address at delivery time is not
 * caught here. Closing that properly needs resolution at connect time with the
 * resolved address checked before the socket is used, which belongs in the
 * egress layer rather than in a validator.
 */
export function assertDeliverableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DomainError('WEBHOOK_URL_INVALID', 'That is not a URL.');
  }

  if (url.protocol !== 'https:') {
    throw new DomainError(
      'WEBHOOK_URL_INSECURE',
      'A webhook endpoint must be https. Project data and a signature over it are not going over plain http.',
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new DomainError(
      'WEBHOOK_URL_CREDENTIALS',
      'Credentials in the URL would be stored in this record and printed in every delivery log. Use the signature instead.',
    );
  }

  const host = url.hostname.toLowerCase();
  const forbidden =
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  if (forbidden) {
    throw new DomainError(
      'WEBHOOK_URL_INTERNAL',
      `${url.hostname} is inside the deployment. A subscription pointing at it would turn this feature into a way of ` +
        'making the platform fetch its own internals on request.',
    );
  }

  return url;
}

// --------------------------------------------------------------- signatures

/** The exact material a receiver must verify: `<timestamp>.<body>`. */
export function signingPayload(timestamp: number, body: string): string {
  return `${timestamp}.${body}`;
}

export function sign(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const digest = createHmac('sha256', secret).update(signingPayload(timestamp, body)).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

/**
 * Verify a signature the way a receiver should.
 *
 * Exported and tested because an integrator has to implement this, and a scheme
 * described only in prose gets implemented three different ways — two of which
 * accept a forgery.
 *
 * Rejects a stale timestamp as well as a wrong digest. Without the age check a
 * captured delivery can be replayed for ever, and the signature will verify
 * perfectly every time.
 */
export function verifySignature(
  secret: string,
  header: string,
  body: string,
  now = Math.floor(Date.now() / 1000),
  toleranceSeconds = REPLAY_TOLERANCE_SECONDS,
): { valid: true } | { valid: false; because: string } {
  const parts = new Map(
    header
      .split(',')
      .map((part) => part.trim().split('='))
      .filter((pair): pair is [string, string] => pair.length === 2),
  );
  const timestamp = Number(parts.get('t'));
  const presented = parts.get('v1') ?? '';

  if (!Number.isFinite(timestamp) || presented === '') {
    return { valid: false, because: 'The signature header is not in the form t=<seconds>,v1=<hex>.' };
  }
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    return {
      valid: false,
      because: `The signed timestamp is ${Math.abs(now - timestamp)}s away from now, outside the ${toleranceSeconds}s tolerance. This may be a replay.`,
    };
  }

  const expected = createHmac('sha256', secret).update(signingPayload(timestamp, body)).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, because: 'The signature does not match the body under this secret.' };
  }
  return { valid: true };
}

// ----------------------------------------------------------------- delivery

/**
 * The body an integrator receives.
 *
 * Deliberately the event, not a rendering of it. An integrator who wants the
 * current state of the entity reads it back through the API with their key;
 * putting state in the webhook would mean a payload that is already stale on
 * arrival and a second definition of what each entity looks like.
 */
export function envelope(event: GoldenThreadEvent, deliveryId: string): string {
  return JSON.stringify({
    deliveryId,
    eventId: event.eventId,
    eventType: event.eventType,
    occurredAt: event.timestamp,
    tenantId: event.tenantId,
    projectId: event.projectId,
    entity: event.entity,
    action: event.action,
    actor: event.actor,
    correlationId: event.correlationId,
    // The chain position, so a receiver can tell whether it has missed one.
    // Without it an at-least-once feed is also an unknowably-lossy one.
    sequence: event.chainHash,
  });
}

/** Which subscriptions want this event. */
export function matching(subscriptions: Subscription[], event: GoldenThreadEvent): Subscription[] {
  return subscriptions.filter(
    (subscription) =>
      subscription.active &&
      subscription.tenantId === event.tenantId &&
      (subscription.eventTypes.length === 0 || subscription.eventTypes.includes(event.eventType)),
  );
}

/**
 * Queue one delivery per matching subscription.
 *
 * Queued rather than sent. The event has already been committed to the ledger
 * by the time this runs, and a delivery attempted inline would put a customer's
 * unreachable endpoint on the critical path of their own write.
 */
export function enqueue(ctx: EngineContext, event: GoldenThreadEvent): Delivery[] {
  const wanted = matching(subscriptionsOf(ctx), event);
  const now = new Date().toISOString();

  return wanted.map((subscription) => {
    const id = ulid();
    const delivery: Delivery = {
      id,
      subscriptionId: subscription.id,
      tenantId: subscription.tenantId,
      eventId: event.eventId,
      eventType: event.eventType,
      body: envelope(event, id),
      status: 'QUEUED',
      attempts: 0,
      queuedAt: now,
      nextAttemptAt: now,
    };

    write(ctx, {
      eventType: 'WEBHOOK_DELIVERY_QUEUED',
      entity: { refType: 'WebhookDelivery', refId: delivery.id },
      nextState: delivery as unknown as Record<string, unknown>,
    });

    return delivery;
  });
}

export type DeliveryOutcome = {
  deliveryId: string;
  delivered: boolean;
  status?: number;
  error?: string;
  /** Set where this attempt exhausted the allowance. */
  abandoned?: boolean;
};

/**
 * Attempt one delivery.
 *
 * Never throws. A customer's endpoint being down is not this platform's failure,
 * and a drain that stopped at the first bad endpoint would let one broken
 * subscription hold up every other tenancy's.
 */
export async function attempt(
  subscription: Subscription,
  delivery: Delivery,
  timeoutMs = 10_000,
): Promise<DeliveryOutcome> {
  const timestamp = Math.floor(Date.now() / 1000);

  try {
    const response = await fetch(subscription.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-construx-signature': sign(subscription.secret, delivery.body, timestamp),
        // Stable across retries, so a receiver can make an at-least-once feed
        // exactly-once on their side.
        'x-construx-delivery-id': delivery.id,
        'x-construx-event-type': delivery.eventType,
        'user-agent': 'CONSTRUX-Webhooks/1',
      },
      body: delivery.body,
      signal: AbortSignal.timeout(timeoutMs),
    });

    // Any 2xx is acceptance. A receiver that answers 302 has not accepted
    // anything, and following it would post a signed payload somewhere the
    // subscription never named.
    if (response.ok) return { deliveryId: delivery.id, delivered: true, status: response.status };

    return {
      deliveryId: delivery.id,
      delivered: false,
      status: response.status,
      error: `endpoint answered ${response.status}`,
      abandoned: delivery.attempts + 1 >= MAX_ATTEMPTS,
    };
  } catch (error) {
    return {
      deliveryId: delivery.id,
      delivered: false,
      error: error instanceof Error ? error.message : String(error),
      abandoned: delivery.attempts + 1 >= MAX_ATTEMPTS,
    };
  }
}

/**
 * Record what an attempt did, and decide whether to try again.
 *
 * The half that makes "owed rather than lost" true. Without it an attempt is
 * fire-and-forget: a failed delivery disappears, and nobody — the platform or
 * the integrator — can say whether an event was ever sent.
 *
 * A subscription that fails repeatedly is disabled rather than retried for
 * ever. An endpoint that has been refusing for a day is not coming back within
 * the next attempt, and continuing to post to it is a slow outbound flood
 * against somebody else's server.
 */
export function recordDelivery(
  ctx: EngineContext,
  input: { subscription: Subscription; delivery: Delivery; outcome: DeliveryOutcome },
): { delivery: Delivery; subscriptionDisabled: boolean } {
  const now = new Date().toISOString();
  const attempts = input.delivery.attempts + 1;

  const delivery: Delivery = {
    ...input.delivery,
    attempts,
    status: input.outcome.delivered ? 'DELIVERED' : attempts >= MAX_ATTEMPTS ? 'ABANDONED' : 'QUEUED',
    deliveredAt: input.outcome.delivered ? now : undefined,
    lastStatus: input.outcome.status,
    lastError: input.outcome.error,
    nextAttemptAt: input.outcome.delivered
      ? now
      : new Date(Date.now() + backoffSeconds(attempts) * 1_000).toISOString(),
  };

  write(ctx, {
    eventType: 'WEBHOOK_DELIVERY_ATTEMPTED',
    entity: { refType: 'WebhookDelivery', refId: delivery.id },
    nextState: delivery as unknown as Record<string, unknown>,
  });

  const failures = input.outcome.delivered ? 0 : input.subscription.consecutiveFailures + 1;
  const shouldDisable = failures >= FAILURES_BEFORE_DISABLE;

  const subscription: Subscription = {
    ...input.subscription,
    consecutiveFailures: failures,
    lastDeliveryAt: input.outcome.delivered ? now : input.subscription.lastDeliveryAt,
    lastFailureReason: input.outcome.delivered ? undefined : input.outcome.error,
    active: shouldDisable ? false : input.subscription.active,
    disabledAt: shouldDisable ? now : input.subscription.disabledAt,
    disabledReason: shouldDisable
      ? `${failures} consecutive failures. An endpoint refusing this long is not coming back within the next attempt, ` +
        'and continuing to post to it is a slow outbound flood against somebody else\'s server.'
      : input.subscription.disabledReason,
  };

  // Only where something actually changed. The ledger refuses two events with
  // identical state, and a no-op write here would fail the drain rather than
  // the delivery.
  if (
    subscription.consecutiveFailures !== input.subscription.consecutiveFailures ||
    subscription.active !== input.subscription.active
  ) {
    write(ctx, {
      // Not WEBHOOK_SUBSCRIBED. That event creates, so recording a second
      // failure against the same subscription would be refused as a duplicate
      // creation — and the drain would fail on the endpoint that is already
      // failing, which is precisely the wrong moment.
      eventType: shouldDisable ? 'WEBHOOK_DISABLED' : 'WEBHOOK_SUBSCRIPTION_HEALTH',
      entity: { refType: 'WebhookSubscription', refId: subscription.id },
      nextState: subscription as unknown as Record<string, unknown>,
    });
  }

  return { delivery, subscriptionDisabled: shouldDisable };
}

/** What the platform owes this tenancy's endpoints, for the developer screen. */
export type WebhookPosition = {
  subscriptions: number;
  active: number;
  queued: number;
  delivered: number;
  abandoned: number;
  /** Subscriptions disabled for repeated failure, with what failed. */
  failing: Array<{ id: string; name: string; url: string; consecutiveFailures: number; lastFailureReason?: string }>;
};

export function webhookPosition(ctx: EngineContext): WebhookPosition {
  authorise(ctx, 'ENTERPRISE_STRUCTURE', 'R');

  const subscriptions = subscriptionsOf(ctx);
  const deliveries = ctx.ledger
    .listByTenant(ctx.tenantId, 'WebhookDelivery')
    .map((record) => record.state as unknown as Delivery);

  return {
    subscriptions: subscriptions.length,
    active: subscriptions.filter((entry) => entry.active).length,
    queued: deliveries.filter((entry) => entry.status === 'QUEUED').length,
    delivered: deliveries.filter((entry) => entry.status === 'DELIVERED').length,
    // Named rather than hidden. An abandoned delivery is data an integrator
    // never received, and a screen that showed only successes would let a
    // customer believe their integration is complete when it has gaps.
    abandoned: deliveries.filter((entry) => entry.status === 'ABANDONED').length,
    failing: subscriptions
      .filter((entry) => entry.consecutiveFailures > 0)
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        url: entry.url,
        consecutiveFailures: entry.consecutiveFailures,
        lastFailureReason: entry.lastFailureReason,
      })),
  };
}
