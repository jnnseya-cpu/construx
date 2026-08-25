import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { createGateway } from '../src/api/gateway.ts';
import { resetIdempotency } from '../src/api/middleware.ts';
import { config } from '../src/config.ts';
import { settledPayment, verifyWebhook, type StripeEvent } from '../src/billing/stripe.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The webhook is a public URL that adds money to wallets.
 *
 * Every other route on this platform is protected by a credential the caller
 * holds. This one cannot be: Stripe has no account here and nothing to present.
 * The signature is the credential, and these tests are the argument that it
 * actually works — a webhook that credits on an unverified body is not a
 * payment integration, it is an open mint with a payment provider's name on it.
 *
 * What is attacked below, in order:
 *
 *   1. A forged body with no signature, a wrong signature, a signature over
 *      *different* bytes, a malformed header, and a genuine signature replayed
 *      outside the tolerance window.
 *   2. A test-mode event delivered to a production deployment — free to
 *      generate, since Stripe test keys cost nothing.
 *   3. The amount. A checkout opened for £10 must credit £10 however the
 *      request that opened it was shaped.
 *   4. Redelivery. Stripe retries for days and delivers at least once by
 *      design, and a single sale raises more than one event.
 *   5. A session that completed without being paid.
 *   6. A currency that is not the one the platform prices in.
 */

const SECRET = 'whsec_test_secret_for_the_suite_only';

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;

/**
 * `config` is a load-time snapshot and the suite has no Stripe account, so the
 * secrets are set here rather than in the environment. Cast because the object
 * is `as const` — readonly to stop production code reassigning it, which is not
 * the same as immutable.
 */
type MutableStripeConfig = { secretKey: string; webhookSecret: string };
const stripeConfig = config.stripe as unknown as MutableStripeConfig;

function tokenFor(who: string): string {
  const user = platform.user(seed.users[who]!.id);
  return issueTokens({
    actorId: user.id,
    tenantId: user.tenantId,
    partyId: user.partyId,
    roles: user.roles,
    mfaSatisfied: true,
  }).accessToken;
}

/** Sign a body the way Stripe does: HMAC-SHA256 over `timestamp.body`. */
function sign(body: string, secret = SECRET, at = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac('sha256', secret).update(`${at}.${body}`).digest('hex');
  return `t=${at},v1=${v1}`;
}

function checkoutEvent(over: {
  id?: string;
  type?: string;
  livemode?: boolean;
  tenantId?: string;
  intentId?: string;
  amountMinor?: number;
  currency?: string;
  paymentStatus?: string;
  paymentIntent?: string | null;
} = {}): StripeEvent {
  return {
    id: over.id ?? 'evt_1',
    type: over.type ?? 'checkout.session.completed',
    livemode: over.livemode ?? true,
    data: {
      object: {
        id: 'cs_test_1',
        object: 'checkout.session',
        amount_total: over.amountMinor ?? 10_000,
        currency: over.currency ?? 'gbp',
        payment_status: over.paymentStatus ?? 'paid',
        payment_intent: over.paymentIntent === null ? undefined : (over.paymentIntent ?? 'pi_test_1'),
        metadata: {
          tenantId: over.tenantId ?? 'unset',
          ...(over.intentId ? { intentId: over.intentId } : {}),
        },
      },
    },
  };
}

async function postWebhook(body: string, signature?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/v1/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(signature ? { 'stripe-signature': signature } : {}),
    },
    body,
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

const balance = () => platform.wallet(seed.users.pm!.auth.tenantId).snapshot().balanceMinor;

before(async () => {
  stripeConfig.secretKey = 'sk_test_suite';
  stripeConfig.webhookSecret = SECRET;

  platform = new Platform();
  seed = await seedDemoProject(platform);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

beforeEach(() => resetIdempotency());

after(() => {
  server.close();
  stripeConfig.secretKey = '';
  stripeConfig.webhookSecret = '';
});

// --------------------------------------------------- 1. the signature itself

describe('the webhook signature is the only credential', () => {
  it('refuses a body with no signature at all', async () => {
    const before = balance();
    const reply = await postWebhook(JSON.stringify(checkoutEvent()));

    assert.equal(reply.status, 400);
    assert.equal(reply.body.title, 'STRIPE_SIGNATURE_MISSING');
    assert.equal(balance(), before, 'an unsigned webhook credited a wallet');
  });

  it('refuses a signature computed under a different secret', async () => {
    const body = JSON.stringify(checkoutEvent());
    const before = balance();
    const reply = await postWebhook(body, sign(body, 'whsec_the_attackers_guess'));

    assert.equal(reply.status, 400);
    assert.equal(reply.body.title, 'STRIPE_SIGNATURE_INVALID');
    assert.equal(balance(), before);
  });

  it('refuses a genuine signature moved onto a different body', () => {
    // The realistic attack. Someone captures one legitimate webhook — from a
    // log, a proxy, their own £1 payment — and replays the header over a body
    // they wrote themselves with a larger amount in it.
    const captured = JSON.stringify(checkoutEvent({ amountMinor: 100 }));
    const header = sign(captured);
    const forged = JSON.stringify(checkoutEvent({ amountMinor: 100_000_000 }));

    throwsCode(() => verifyWebhook(Buffer.from(forged), header), 'STRIPE_SIGNATURE_INVALID');
  });

  it('refuses a signature that is even one byte different in the body', () => {
    // Guards the thing that would silently break the HMAC without breaking the
    // route: verifying over a re-serialised object rather than the raw bytes.
    const body = JSON.stringify(checkoutEvent());
    const header = sign(body);
    throwsCode(() => verifyWebhook(Buffer.from(`${body} `), header), 'STRIPE_SIGNATURE_INVALID');
  });

  it('refuses a header it cannot parse', () => {
    const body = JSON.stringify(checkoutEvent());
    for (const header of ['', 'nonsense', 't=123', 'v1=abc', 'garbage,more']) {
      throwsCode(
        () => verifyWebhook(Buffer.from(body), header),
        header === '' ? 'STRIPE_SIGNATURE_MISSING' : 'STRIPE_SIGNATURE_MALFORMED',
        `"${header}" was accepted as a signature header`,
      );
    }
  });

  it('refuses a valid signature replayed outside the tolerance window', () => {
    // The signature stays valid for ever — it is over bytes that do not change.
    // Time is the only thing that makes a captured webhook stale, which is what
    // stops one being held and replayed after a refund.
    const body = JSON.stringify(checkoutEvent());
    const anHourAgo = Math.floor(Date.now() / 1000) - 3600;
    throwsCode(() => verifyWebhook(Buffer.from(body), sign(body, SECRET, anHourAgo)), 'STRIPE_SIGNATURE_STALE');
  });

  it('accepts any of several v1 signatures, so a secret can be rotated', () => {
    // Stripe sends one v1 per active secret during a rotation. Taking only the
    // first would mean a rotation drops payments on the floor.
    const body = JSON.stringify(checkoutEvent());
    const at = Math.floor(Date.now() / 1000);
    const good = createHmac('sha256', SECRET).update(`${at}.${body}`).digest('hex');
    const header = `t=${at},v1=0000000000000000000000000000000000000000000000000000000000000000,v1=${good}`;

    const event = verifyWebhook(Buffer.from(body), header);
    assert.equal(event.id, 'evt_1');
  });

  it('refuses everything when no webhook secret is configured', () => {
    // The correct failure for an unconfigured deployment. An endpoint that
    // credits wallets and cannot check who is calling must answer nobody.
    const previous = stripeConfig.webhookSecret;
    stripeConfig.webhookSecret = '';
    try {
      const body = JSON.stringify(checkoutEvent());
      throwsCode(() => verifyWebhook(Buffer.from(body), sign(body)), 'STRIPE_UNCONFIGURED');
    } finally {
      stripeConfig.webhookSecret = previous;
    }
  });
});

// ------------------------------------------------------- 2. test money is not real money

describe('test-mode events and production deployments', () => {
  it('refuses a livemode:false event in production', () => {
    // Stripe test keys are free to anybody who signs up. Without this check,
    // a correctly signed test payment credits a real balance — and the
    // signature would be genuine, because they signed it with our secret only
    // if they had it, or with theirs if we ever pointed at their endpoint.
    const body = JSON.stringify(checkoutEvent({ livemode: false }));
    const header = sign(body);
    const previous = config.env;

    (config as unknown as { env: string }).env = 'production';
    try {
      throwsCode(() => verifyWebhook(Buffer.from(body), header), 'STRIPE_TEST_EVENT');
    } finally {
      (config as unknown as { env: string }).env = previous;
    }
  });

  it('allows a livemode:false event outside production, so the integration can be exercised', () => {
    const body = JSON.stringify(checkoutEvent({ livemode: false }));
    const event = verifyWebhook(Buffer.from(body), sign(body));
    assert.equal(event.livemode, false);
  });
});

// ----------------------------------------------------------- 3. what gets credited

describe('the amount credited comes from Stripe, not from the caller', () => {
  it('credits exactly what the signed object says was paid', async () => {
    const tenantId = seed.users.pm!.auth.tenantId;
    const before = balance();
    const body = JSON.stringify(checkoutEvent({ id: 'evt_amount', tenantId, amountMinor: 25_000 }));

    const reply = await postWebhook(body, sign(body));
    assert.ok([200, 201].includes(reply.status), `webhook answered ${reply.status}`);
    assert.equal(reply.body.acted, true);
    assert.equal(balance(), before + 25_000);
  });

  it('ignores an amount smuggled in beside the signed one', () => {
    // A top-level `amountMinor` is not something Stripe sends, so this is a
    // forger's shape. It is inside the signed body, so it cannot be injected
    // without the secret — the assertion is that even then it is never read.
    const event = checkoutEvent({ tenantId: 'T', amountMinor: 500 });
    (event as unknown as Record<string, unknown>).amountMinor = 9_999_999;
    (event.data.object as Record<string, unknown>).amount = 9_999_999;

    const payment = settledPayment(event);
    assert.equal(payment?.amountMinor, 500);
  });
});

// ------------------------------------------------------------- 4. redelivery

describe('a payment is credited exactly once', () => {
  it('credits nothing further when Stripe redelivers the same event', async () => {
    const tenantId = seed.users.pm!.auth.tenantId;
    const body = JSON.stringify(
      checkoutEvent({ id: 'evt_redelivered', tenantId, amountMinor: 4_000, paymentIntent: 'pi_redelivered' }),
    );

    const first = await postWebhook(body, sign(body));
    assert.equal(first.body.alreadyRecorded, false);
    const after = balance();

    // Same bytes, a fresh signature — which is what a Stripe retry looks like.
    const second = await postWebhook(body, sign(body));
    assert.ok([200, 201].includes(second.status), 'a retry must not be answered with an error');
    assert.equal(second.body.alreadyRecorded, true);
    assert.equal(balance(), after, 'a redelivered webhook credited twice');
  });

  it('credits once when one sale raises two event ids', () => {
    // The leak this design closes. A card payment through Checkout raises both
    // `checkout.session.completed` and `payment_intent.succeeded`, each with
    // its own event id. Keyed on the event, one £100 payment credits £200.
    const session = settledPayment(checkoutEvent({ id: 'evt_a', tenantId: 'T', paymentIntent: 'pi_same' }));
    const async_ = settledPayment(
      checkoutEvent({
        id: 'evt_b',
        type: 'checkout.session.async_payment_succeeded',
        tenantId: 'T',
        paymentIntent: 'pi_same',
      }),
    );

    assert.equal(session?.reference, 'stripe:pi_same');
    assert.equal(async_?.reference, session?.reference, 'two events for one payment produced two references');
  });

  it('does not treat payment_intent.succeeded as a settlement of its own', () => {
    // It is the duplicate half of the pair above. Reading both would be the
    // double credit, dressed up as thoroughness.
    assert.equal(settledPayment(checkoutEvent({ type: 'payment_intent.succeeded', tenantId: 'T' })), undefined);
  });

  it('acknowledges an event it does not act on rather than erroring', async () => {
    // Stripe retries any non-2xx for days. Answering 400 to the dozens of
    // events we never process would mean a permanent retry backlog.
    const body = JSON.stringify(checkoutEvent({ id: 'evt_other', type: 'customer.created' }));
    const before = balance();

    const reply = await postWebhook(body, sign(body));
    assert.ok([200, 201].includes(reply.status));
    assert.equal(reply.body.acted, false);
    assert.equal(balance(), before);
  });
});

// ------------------------------------------------------- 5, 6. unpaid and wrong currency

describe('what is not a payment', () => {
  it('credits nothing for a session that completed unpaid', async () => {
    const tenantId = seed.users.pm!.auth.tenantId;
    const before = balance();
    const body = JSON.stringify(
      checkoutEvent({ id: 'evt_unpaid', tenantId, paymentStatus: 'unpaid', paymentIntent: 'pi_unpaid' }),
    );

    const reply = await postWebhook(body, sign(body));
    assert.ok([200, 201].includes(reply.status));
    assert.equal(reply.body.acted, false);
    assert.equal(balance(), before, 'an unpaid checkout credited a wallet');
  });

  it('refuses a currency the platform does not price in', () => {
    // Minor units are not comparable across currencies. Crediting a JPY
    // `amount_total` as pence would credit roughly a hundred times the money.
    throwsCode(
      () => settledPayment(checkoutEvent({ tenantId: 'T', currency: 'usd' })),
      'STRIPE_CURRENCY_MISMATCH',
    );
  });

  it('credits nothing for a paid session carrying no tenancy', () => {
    // Not ours. Answering with a credit would mean guessing whose money it is.
    const event = checkoutEvent();
    (event.data.object as Record<string, unknown>).metadata = {};
    assert.equal(settledPayment(event), undefined);
  });
});

// ------------------------------------------------------------- the route itself

describe('the webhook route', () => {
  it('refuses to be called with a session token instead of a signature', async () => {
    // Being public does not make it a route an authenticated customer may use
    // to credit themselves. There is exactly one credential here and a bearer
    // token is not it.
    const body = JSON.stringify(checkoutEvent({ tenantId: seed.users.pm!.auth.tenantId }));
    const before = balance();

    const res = await fetch(`${base}/v1/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenFor('admin')}` },
      body,
    });

    assert.equal(res.status, 400);
    assert.equal(balance(), before);
  });

  it('caps the body it will buffer well below the evidence limit', async () => {
    // A public route reading up to the 50MB evidence ceiling is a way to make
    // this process hold 50MB per connection, from anywhere, with no account.
    const oversized = 'x'.repeat(400 * 1024);
    const res = await fetch(`${base}/v1/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': sign('{}') },
      body: oversized,
    });

    assert.equal(res.status, 400);
    const problem = (await res.json()) as { detail?: string };
    assert.match(String(problem.detail), /limit/i);
  });
});
