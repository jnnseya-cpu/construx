import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import * as structure from '../src/domain/structure.ts';
import { drainWebhooks, due, type Transport } from '../src/developer/delivery.ts';
import {
  ENVELOPE_SCHEMA_VERSION,
  MAX_ATTEMPTS,
  PUBLISHED_EVENT_NAMES,
  subscribe,
  verifySignature,
  type Delivery,
  type Subscription,
} from '../src/developer/webhooks.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * AC-12 — the outbox fails and the conversion stands.
 *
 * *Outbox publication temporarily fails; the core conversion commits; live
 * state remains valid and the event retries without duplication.*
 *
 * ## What this found
 *
 * The outbox itself was built: queue, signature, backoff, abandonment, the
 * developer register. **Nothing ever called `enqueue`, and nothing ever drained
 * it.** Every integrator subscription on the platform was a URL that would
 * never be posted to — the subscribe screen worked, the delivery register was
 * empty, and there was no failure anywhere to say why. A test that only
 * exercised the module's own functions could not see it, because every one of
 * them worked.
 *
 * So these tests drive the *platform*: a real conversion, and then the feed.
 */

let platform: Platform;
let seed: SeedResult;
let gov: ReturnType<Platform['context']>;
let portfolioId: string;

const LOCATION = { continentCode: 'EU', countryCode: 'GB', city: 'Rawtenstall' };

const AWARD = {
  contractAwardDate: '2026-04-20',
  contractSumMinor: 100_000_000,
  contractForm: 'NEC4 ECC Option A',
  contractedScope: 'Exactly as tendered, with no change to scope, price or programme.',
  contractStartDate: '2026-02-02',
  contractCompletionDate: '2027-08-13',
};

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  gov = platform.context(seed.users.admin!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
  portfolioId = String(
    platform.ledger.entitiesOfType('Project').find((record) => record.state.id === seed.projectId)!.state.portfolioId,
  );
});

function bid(name: string): ReturnType<Platform['context']> {
  const created = structure.createProject(gov, {
    portfolioId,
    name,
    sectorType: 'UTILITIES',
    assetType: 'Fixture',
    location: LOCATION,
    contractValueMinor: 100_000_000,
    currency: 'GBP',
    plannedStart: '2026-02-02',
    plannedCompletion: '2027-08-13',
    startingPhase: 'TENDER',
    startingPhaseReason: 'Pricing the client design against their bill of quantities.',
  } as Parameters<typeof structure.createProject>[1]);
  return platform.context(seed.users.admin!.auth, created.projectId, { source: 'WEB' });
}

/**
 * A subscription, and its stored secret.
 *
 * `eventTypes` narrows it. A conversion emits a dozen events, so an endpoint
 * that wants everything gets a dozen deliveries — fine for proving the feed is
 * filled, useless for reasoning about one delivery's retry count.
 */
function endpoint(url = 'https://hooks.example.com/feed', eventTypes: string[] = []): Subscription {
  const created = subscribe(gov, { name: `Feed ${Math.random().toString(36).slice(2, 8)}`, url, eventTypes });
  return platform.ledger.get({ refType: 'WebhookSubscription', refId: created.subscription.id })!
    .state as unknown as Subscription;
}

/**
 * Drain everything that is due, with the clock wound past the backoff.
 *
 * The limit is raised well above the default because a pass posts every due
 * delivery on the platform, and the tests above leave a backlog behind them: at
 * the default of 100 a later pass never reaches the delivery under test, which
 * looks exactly like a delivery that was never retried.
 */
function drainAll(transport: Transport, windForward = true): Promise<unknown> {
  return drainWebhooks(platform, {
    transport,
    limit: 10_000,
    ...(windForward ? { at: new Date(Date.now() + 86_400_000).toISOString() } : {}),
  });
}

function deliveriesFor(subscriptionId: string): Delivery[] {
  return platform.ledger
    .listByTenant(seed.tenantId, 'WebhookDelivery')
    .map((record) => record.state as unknown as Delivery)
    .filter((entry) => entry.subscriptionId === subscriptionId);
}

/**
 * A transport that refuses the first `failures` attempts *per delivery*, then
 * succeeds.
 *
 * Counted per delivery id rather than globally, and that is not fussiness: a
 * drain pass posts every due delivery on the platform, including the ones
 * earlier tests in this file left queued. A global counter had its two failures
 * consumed by somebody else's backlog, and the delivery under test succeeded
 * first time — a test that passed for the wrong reason, then failed for the
 * right one.
 */
function flaky(failures: number): { transport: Transport; bodies: string[]; deliveryIds: string[] } {
  const seen = new Map<string, number>();
  const bodies: string[] = [];
  const deliveryIds: string[] = [];
  const transport: Transport = async ({ body, headers }) => {
    const id = headers['x-construx-delivery-id'] ?? '';
    bodies.push(body);
    deliveryIds.push(id);
    const attempt = (seen.get(id) ?? 0) + 1;
    seen.set(id, attempt);
    return attempt <= failures ? { ok: false, status: 503, error: 'HTTP 503' } : { ok: true, status: 200 };
  };
  return { transport, bodies, deliveryIds };
}

describe('the integrator feed is actually filled and actually drained', () => {
  it('queues a delivery for a committed event, which nothing did before', () => {
    const subscription = endpoint();
    const ctx = bid('AC-12 queue');
    structure.convertToDelivery(ctx, {
      award: AWARD,
      deliveryEntry: 'DESIGN',
      justification: 'Awarded; the feed should carry this.',
    });

    const queued = deliveriesFor(subscription.id);
    assert.ok(queued.length > 0, 'the conversion queued nothing for a subscription that wants everything');
    assert.ok(
      queued.some((entry) => entry.eventType === 'TENDER_WON'),
      `no award event on the feed: ${[...new Set(queued.map((entry) => entry.eventType))].join(', ')}`,
    );
  });

  it('carries §11.6’s versioned envelope, with the published contract name', () => {
    const subscription = endpoint();
    const ctx = bid('AC-12 envelope');
    structure.convertToDelivery(ctx, {
      award: AWARD,
      deliveryEntry: 'DESIGN',
      justification: 'Awarded; checking what an integrator actually receives.',
    });

    const award = deliveriesFor(subscription.id).find((entry) => entry.eventType === 'TENDER_WON')!;
    const body = JSON.parse(award.body) as Record<string, unknown>;

    assert.equal(body.schemaVersion, ENVELOPE_SCHEMA_VERSION);
    assert.equal(body.domainEvent, PUBLISHED_EVENT_NAMES.TENDER_WON);
    assert.equal(body.domainEvent, 'construx.project.converted_to_live');
    assert.equal(body.tenantId, seed.tenantId);
    assert.equal(body.projectId, ctx.projectId);
    assert.equal(body.deliveryId, award.id);
    assert.ok(typeof body.eventId === 'string' && body.eventId.length > 0);
    assert.ok(typeof body.correlationId === 'string');
    assert.ok(typeof body.occurredAt === 'string');
    // The version the aggregate reached because of this event — what a consumer
    // compares against `aggregateVersion` on the read API to know whether the
    // state it holds is older than this message.
    assert.equal(typeof body.aggregateVersion, 'number');
    assert.ok((body.aggregateVersion as number) > 0);
    assert.deepEqual(body.entity, { refType: 'Project', refId: ctx.projectId });
  });

  it('AC-12 — publication fails, and the project is still live with a valid state', async () => {
    const subscription = endpoint('https://hooks.example.com/down');
    const ctx = bid('AC-12 failure');
    const receipt = structure.convertToDelivery(ctx, {
      award: AWARD,
      deliveryEntry: 'DESIGN',
      justification: 'Awarded while the integrator’s endpoint is down.',
    });

    // Every attempt refuses.
    const report = (await drainAll(async () => ({ ok: false, status: 503, error: 'HTTP 503' }), false)) as {
      attempted: number;
      delivered: number;
      retrying: number;
    };
    assert.ok(report.attempted > 0, 'the drain attempted nothing');
    assert.equal(report.delivered, 0);
    assert.ok(report.retrying > 0);

    // The core conversion stands, whole.
    const state = platform.ledger.require({ refType: 'Project', refId: ctx.projectId }).state;
    assert.equal(state.lifecycleState, 'LIVE_MOBILISING');
    assert.equal(state.commercialOutcome, 'WON');
    assert.equal(state.contractValueMinor, AWARD.contractSumMinor);
    assert.ok(structure.awardReconciliation(ctx));
    assert.equal(receipt.currentState, 'LIVE_MOBILISING');
  });

  it('AC-12 — retries the same event without duplicating it', async () => {
    const subscription = endpoint('https://hooks.example.com/flaky', ['TENDER_WON']);
    const ctx = bid('AC-12 retry');
    structure.convertToDelivery(ctx, {
      award: AWARD,
      deliveryEntry: 'DESIGN',
      justification: 'Awarded; the endpoint refuses twice and then recovers.',
    });

    const queuedBefore = deliveriesFor(subscription.id);
    const awardBefore = queuedBefore.filter((entry) => entry.eventType === 'TENDER_WON');
    assert.equal(awardBefore.length, 1, 'one event produced more than one delivery for one subscription');
    const deliveryId = awardBefore[0]!.id;
    const eventId = awardBefore[0]!.eventId;

    const { transport, bodies, deliveryIds } = flaky(2);
    // Three passes, each winding the clock past the backoff so the entry is due.
    for (let pass = 0; pass < 3; pass += 1) await drainAll(transport);

    const settled = deliveriesFor(subscription.id).find((entry) => entry.id === deliveryId)!;
    assert.equal(settled.status, 'DELIVERED');
    assert.ok(settled.attempts >= 3, `settled after ${settled.attempts} attempt(s)`);

    // No second delivery record appeared for the same event.
    assert.equal(
      deliveriesFor(subscription.id).filter((entry) => entry.eventId === eventId).length,
      1,
      'the retry created a second delivery for the same event',
    );

    // And every attempt carried the same delivery id and the same body, which
    // is what makes the receiver's side exactly-once achievable.
    const attemptsForThis = deliveryIds.filter((id) => id === deliveryId);
    assert.ok(attemptsForThis.length >= 3);
    const sent = bodies.filter((body) => (JSON.parse(body) as { deliveryId?: string }).deliveryId === deliveryId);
    assert.equal(new Set(sent).size, 1, 'the retries sent different bodies for one event');
    assert.equal((JSON.parse(sent[0]!) as { eventId?: string }).eventId, eventId);
  });

  it('signs every attempt over the exact body that was queued', async () => {
    const subscription = endpoint('https://hooks.example.com/signed');
    const ctx = bid('AC-12 signature');
    structure.convertToDelivery(ctx, {
      award: AWARD,
      deliveryEntry: 'DESIGN',
      justification: 'Awarded; the receiver has to be able to verify this.',
    });

    let checked = 0;
    await drainAll(async ({ body, headers }) => {
        const verdict = verifySignature(subscription.secret, headers['x-construx-signature'] ?? '', body);
        assert.equal(verdict.valid, true, verdict.valid ? '' : `signature did not verify: ${verdict.because}`);
      checked += 1;
      return { ok: true, status: 200 };
    });
    assert.ok(checked > 0, 'nothing was posted, so nothing was signed');
  });

  it('abandons after the allowance rather than posting for ever', async () => {
    // One event type, so this subscription has exactly one delivery and the
    // attempt count below is that delivery's rather than a queue's.
    const subscription = endpoint('https://hooks.example.com/dead', ['TENDER_WON']);
    const ctx = bid('AC-12 abandon');
    structure.convertToDelivery(ctx, {
      award: AWARD,
      deliveryEntry: 'DESIGN',
      justification: 'Awarded; this endpoint is never coming back.',
    });

    for (let pass = 0; pass < MAX_ATTEMPTS + 1; pass += 1) {
      await drainAll(async () => ({ ok: false, status: 500, error: 'HTTP 500' }));
    }

    const settled = deliveriesFor(subscription.id);
    assert.equal(settled.length, 1, 'a filtered subscription queued more than the event it asked for');
    assert.equal(settled[0]!.status, 'ABANDONED');
    assert.equal(settled[0]!.attempts, MAX_ATTEMPTS);
    assert.equal(settled[0]!.lastStatus, 500);
    // Nothing is due any more, which is what stops the drain flooding a dead host.
    assert.equal(
      due(platform, seed.tenantId, new Date(Date.now() + 86_400_000).toISOString()).filter(
        (entry) => entry.subscriptionId === subscription.id,
      ).length,
      0,
    );
  });

  it('does not put its own bookkeeping on the feed, which would never terminate', () => {
    // Queueing a delivery is itself a write, and a write publishes. Without the
    // guard each message produces a message about the message.
    const subscription = endpoint();
    const ctx = bid('AC-12 loop');
    structure.convertToDelivery(ctx, {
      award: AWARD,
      deliveryEntry: 'DESIGN',
      justification: 'Awarded; checking the feed does not feed itself.',
    });

    const types = new Set(deliveriesFor(subscription.id).map((entry) => entry.eventType));
    assert.equal(types.has('WEBHOOK_DELIVERY_QUEUED'), false);
    assert.equal(types.has('WEBHOOK_DELIVERY_ATTEMPTED'), false);
    assert.equal(types.has('WEBHOOK_SUBSCRIPTION_HEALTH'), false);
  });

  it('names only events that actually happen, so no integrator builds against a lie', () => {
    // §11.5 lists nine. Four of them belong to the conversion wizard, which is
    // not built — publishing a `conversion.approved` from a platform with no
    // approval routing would be a contract nobody can honour.
    const { EVENT_TYPES } = platform as unknown as { EVENT_TYPES?: unknown };
    void EVENT_TYPES;
    for (const [eventType, published] of Object.entries(PUBLISHED_EVENT_NAMES)) {
      assert.match(published, /^construx\./, `${eventType} maps to "${published}", which is not a contract name`);
    }
    assert.equal(PUBLISHED_EVENT_NAMES['PROJECT_CONVERSION_APPROVED'], undefined);
    assert.equal(PUBLISHED_EVENT_NAMES['PROJECT_CONVERSION_REQUESTED'], undefined);
  });
});
