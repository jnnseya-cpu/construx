import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { createGateway } from '../src/api/gateway.ts';
import { resetIdempotency } from '../src/api/middleware.ts';
import { config } from '../src/config.ts';
import {
  kodaSettlement,
  kodaWebhookHealth,
  resetKodaWebhookHealth,
  verifyKodaWebhook,
  type KodaEvent,
} from '../src/billing/koda.ts';
import {
  BILLING_CURRENCY,
  convertFromBillingMinor,
  convertToBillingMinor,
} from '../src/billing/payments.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The mobile-money rail.
 *
 * Two things are being defended here, and they are different from the card
 * rail's problems.
 *
 * **The signature, with no timestamp behind it.** KODA signs the raw body only,
 * so unlike Stripe there is no tolerance window: a captured webhook stays
 * cryptographically valid for ever. Replay is stopped entirely by the payment
 * reference being spent once. That makes the reference load-bearing rather than
 * belt-and-braces, so it is tested as the primary defence it actually is.
 *
 * **The conversion.** The wallet holds pounds and this rail settles in dollars.
 * A rate that is wrong, missing, zero or negative must never reach a wallet,
 * and the rate a customer was quoted must be the rate they are credited at —
 * otherwise moving the configured rate mid-payment silently re-prices somebody
 * who has already paid.
 */

const SECRET = 'koda_whsec_for_the_suite_only';
const RATE = 1.25; // dollars per pound, chosen so the arithmetic is checkable by eye

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;

type MutableKodaConfig = { secretKey: string; webhookSecret: string; usdPerGbp: number };
const kodaConfig = config.koda as unknown as MutableKodaConfig;

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

/** Sign the way KODA does: HMAC-SHA256 of the raw body, hex, no timestamp. */
function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function verifiedEvent(over: {
  type?: string;
  tenantId?: string;
  intentId?: string;
  amount?: number;
  currency?: string;
  receiptId?: string;
} = {}): KodaEvent {
  return {
    type: over.type ?? 'payment.verified',
    data: {
      receipt_id: over.receiptId === undefined ? 'rcpt_1' : over.receiptId,
      amount: over.amount ?? 12_500,
      currency: over.currency ?? 'USD',
      metadata: {
        tenantId: over.tenantId ?? 'unset',
        ...(over.intentId ? { intentId: over.intentId } : {}),
      },
    },
  };
}

async function postWebhook(body: string, signature?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/v1/webhooks/koda`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(signature ? { 'x-koda-signature': signature } : {}),
    },
    body,
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

const balance = () => platform.wallet(seed.users.pm!.auth.tenantId).snapshot().balanceMinor;

before(async () => {
  kodaConfig.secretKey = 'sk_test_koda_suite';
  kodaConfig.webhookSecret = SECRET;
  kodaConfig.usdPerGbp = RATE;

  platform = new Platform();
  seed = await seedDemoProject(platform);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

beforeEach(() => {
  resetIdempotency();
  resetKodaWebhookHealth();
});

after(() => {
  server.close();
  kodaConfig.secretKey = '';
  kodaConfig.webhookSecret = '';
});

// ---------------------------------------------------------- the signature

describe('the KODA webhook signature is the only credential', () => {
  it('refuses an unsigned body', async () => {
    const before = balance();
    const reply = await postWebhook(JSON.stringify(verifiedEvent()));

    assert.equal(reply.status, 400);
    assert.equal(reply.body.title, 'KODA_SIGNATURE_MISSING');
    assert.equal(balance(), before, 'an unsigned webhook credited a wallet');
  });

  it('refuses a signature computed under a different secret', async () => {
    const body = JSON.stringify(verifiedEvent());
    const before = balance();
    const reply = await postWebhook(body, sign(body, 'koda_whsec_the_attackers_guess'));

    assert.equal(reply.status, 400);
    assert.equal(reply.body.title, 'KODA_SIGNATURE_INVALID');
    assert.equal(balance(), before);
  });

  it('refuses a genuine signature moved onto a different body', () => {
    // Capture a small legitimate payment, replay its header over a large forged
    // one. The whole reason the HMAC covers the body.
    const captured = JSON.stringify(verifiedEvent({ amount: 100 }));
    const header = sign(captured);
    const forged = JSON.stringify(verifiedEvent({ amount: 100_000_000 }));

    throwsCode(() => verifyKodaWebhook(Buffer.from(forged), header), 'KODA_SIGNATURE_INVALID');
  });

  it('refuses a signature one byte adrift from the body', () => {
    // Guards the change that would break the HMAC without breaking the route:
    // verifying a re-serialised object rather than the bytes received.
    const body = JSON.stringify(verifiedEvent());
    throwsCode(() => verifyKodaWebhook(Buffer.from(`${body} `), sign(body)), 'KODA_SIGNATURE_INVALID');
  });

  it('refuses a header of the wrong shape without throwing on the comparison', () => {
    // `timingSafeEqual` throws on a length mismatch rather than returning
    // false. A thrown comparison would surface as a 500 and, worse, as a
    // different response than a wrong-but-correctly-sized signature.
    const body = JSON.stringify(verifiedEvent());
    for (const header of ['', 'short', 'z'.repeat(64), 'nonsense'.repeat(40)]) {
      throwsCode(
        () => verifyKodaWebhook(Buffer.from(body), header),
        header === '' ? 'KODA_SIGNATURE_MISSING' : 'KODA_SIGNATURE_INVALID',
        `"${header.slice(0, 12)}…" was mishandled`,
      );
    }
  });

  it('refuses everything when no webhook secret is configured', () => {
    const previous = kodaConfig.webhookSecret;
    kodaConfig.webhookSecret = '';
    try {
      const body = JSON.stringify(verifiedEvent());
      throwsCode(() => verifyKodaWebhook(Buffer.from(body), sign(body)), 'KODA_UNCONFIGURED');
    } finally {
      kodaConfig.webhookSecret = previous;
    }
  });
});

// ------------------------------------------------------------ the conversion

describe('converting a dollar settlement into the billing currency', () => {
  it('credits the pound value of what was actually paid', async () => {
    const tenantId = seed.users.pm!.auth.tenantId;
    const before = balance();
    // $125.00 at 1.25 USD/GBP is £100.00.
    const body = JSON.stringify(verifiedEvent({ tenantId, amount: 12_500, receiptId: 'rcpt_convert' }));

    const reply = await postWebhook(body, sign(body));
    assert.ok([200, 201].includes(reply.status), `webhook answered ${reply.status}`);
    assert.equal(balance(), before + 10_000);
  });

  it('records what was settled and at what rate, so the credit can be recomputed', () => {
    const tenantId = seed.users.pm!.auth.tenantId;
    const { receipt } = platform.creditFromMobileMoney({
      reference: 'koda:rcpt_audit',
      tenantId,
      settledAmountMinor: 2_500,
      settledCurrency: 'USD',
    });

    assert.equal(receipt.currency, BILLING_CURRENCY, 'the receipt must be denominated in the billing currency');
    assert.equal(receipt.amountMinor, 2_000);
    assert.equal(receipt.fx?.settledAmountMinor, 2_500);
    assert.equal(receipt.fx?.settledCurrency, 'USD');
    assert.equal(receipt.fx?.ratePerBillingUnit, RATE);
    // The whole point of recording it: the credit is reproducible from the
    // receipt alone, without knowing the configured rate that day.
    assert.equal(Math.round(receipt.fx!.settledAmountMinor / receipt.fx!.ratePerBillingUnit), receipt.amountMinor);
  });

  it('refuses a rate that cannot be used to credit anything', () => {
    // Fail closed. A zero rate divides to infinity and a negative one credits a
    // negative balance; both are a misconfiguration reaching a wallet.
    for (const rate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      throwsCode(() => convertToBillingMinor(1_000, rate), 'FX_RATE_INVALID', `rate ${rate} was accepted`);
      throwsCode(() => convertFromBillingMinor(1_000, rate), 'FX_RATE_INVALID', `rate ${rate} was accepted`);
    }
  });

  it('rounds half-up rather than flooring, so the platform does not shave every conversion', () => {
    // Flooring would take a sub-penny off every conversion in our favour. Small,
    // systematic, and indefensible once somebody adds it up.
    assert.equal(convertToBillingMinor(101, 2), 51);
    assert.equal(convertToBillingMinor(103, 2), 52);
  });

  it('round-trips a quoted amount back to what was requested', () => {
    // The customer asks for £100, is charged the dollar equivalent, pays it, and
    // must end up with exactly £100 of credit.
    for (const requested of [1_000, 10_000, 4_999, 123_45]) {
      const charged = convertFromBillingMinor(requested, RATE);
      assert.equal(convertToBillingMinor(charged, RATE), requested, `£${requested} did not round-trip`);
    }
  });

  it('refuses a currency the rail is not priced in', () => {
    throwsCode(
      () => kodaSettlement(verifiedEvent({ tenantId: 'T', currency: 'CDF' })),
      'KODA_CURRENCY_MISMATCH',
    );
  });
});

// ----------------------------------------------- the rate quoted vs the rate now

describe('the rate a customer was quoted is the rate they are credited at', () => {
  it('does not re-price a payment already in flight when the configured rate moves', () => {
    // The failure this prevents: somebody is shown a price, pays it, and the
    // operator adjusts KODA_USD_PER_GBP before the webhook lands. Settling at
    // the new rate credits an amount nobody agreed to, in whichever direction
    // the market went.
    const tenantId = seed.users.pm!.auth.tenantId;
    const intent = platform.requestTopUp({ tenantId, amountMinor: 10_000, requestedBy: seed.users.pm!.id });

    const quote = platform.quoteMobileMoney(intent.id, tenantId);
    assert.equal(quote.amountMinor, 12_500, '£100 at 1.25 should be charged as $125');

    // The operator moves the rate while the customer is paying.
    const previous = kodaConfig.usdPerGbp;
    kodaConfig.usdPerGbp = 2;
    try {
      const { receipt } = platform.creditFromMobileMoney({
        reference: 'koda:rcpt_rate_moved',
        tenantId,
        intentId: intent.id,
        settledAmountMinor: quote.amountMinor,
        settledCurrency: 'USD',
      });

      assert.equal(receipt.amountMinor, 10_000, 'the credit was re-priced at the new rate');
      assert.equal(receipt.fx?.ratePerBillingUnit, RATE, 'the receipt recorded a rate the customer never saw');
    } finally {
      kodaConfig.usdPerGbp = previous;
    }
  });

  it('holds the quote steady when the checkout is reopened', () => {
    const tenantId = seed.users.pm!.auth.tenantId;
    const intent = platform.requestTopUp({ tenantId, amountMinor: 5_000, requestedBy: seed.users.pm!.id });

    const first = platform.quoteMobileMoney(intent.id, tenantId);
    const previous = kodaConfig.usdPerGbp;
    kodaConfig.usdPerGbp = 3;
    try {
      const second = platform.quoteMobileMoney(intent.id, tenantId);
      assert.deepEqual(second, first, 'reopening the checkout re-priced the payment');
    } finally {
      kodaConfig.usdPerGbp = previous;
    }
  });

  it('will not quote another tenancy\'s top-up', () => {
    const intent = platform.requestTopUp({
      tenantId: seed.users.pm!.auth.tenantId,
      amountMinor: 5_000,
      requestedBy: seed.users.pm!.id,
    });
    throwsCode(() => platform.quoteMobileMoney(intent.id, 'some-other-tenancy'), 'NOT_FOUND');
  });
});

// --------------------------------------------------------------- replay

describe('a mobile-money payment credits exactly once', () => {
  it('credits nothing further on redelivery', async () => {
    // The primary defence on this rail, not a secondary one: KODA signs no
    // timestamp, so a captured webhook never goes stale and the reference is
    // the only thing standing between one payment and two credits.
    const tenantId = seed.users.pm!.auth.tenantId;
    const body = JSON.stringify(verifiedEvent({ tenantId, amount: 5_000, receiptId: 'rcpt_replay' }));

    const first = await postWebhook(body, sign(body));
    assert.equal(first.body.alreadyRecorded, false);
    const after = balance();

    const second = await postWebhook(body, sign(body));
    assert.ok([200, 201].includes(second.status), 'a redelivery must not be answered with an error');
    assert.equal(second.body.alreadyRecorded, true);
    assert.equal(balance(), after, 'a redelivered webhook credited twice');
  });

  it('treats a late verification as the same money, not as more of it', async () => {
    // A slow operator SMS raises payment.verified.late. It must credit — a
    // customer on a slow network is still a customer who paid — and it must not
    // credit twice if the on-time event also arrived.
    const tenantId = seed.users.pm!.auth.tenantId;
    const onTime = JSON.stringify(verifiedEvent({ tenantId, amount: 2_500, receiptId: 'rcpt_late' }));
    const late = JSON.stringify(
      verifiedEvent({ type: 'payment.verified.late', tenantId, amount: 2_500, receiptId: 'rcpt_late' }),
    );

    await postWebhook(onTime, sign(onTime));
    const after = balance();

    const reply = await postWebhook(late, sign(late));
    assert.equal(reply.body.alreadyRecorded, true);
    assert.equal(balance(), after);
  });

  it('credits a late verification that arrives on its own', () => {
    const settlement = kodaSettlement(verifiedEvent({ type: 'payment.verified.late', tenantId: 'T' }));
    assert.equal(settlement?.reference, 'koda:rcpt_1');
  });

  it('acknowledges an event it does not act on rather than erroring', async () => {
    const body = JSON.stringify(verifiedEvent({ type: 'payment.failed' }));
    const before = balance();

    const reply = await postWebhook(body, sign(body));
    assert.ok([200, 201].includes(reply.status));
    assert.equal(reply.body.acted, false);
    assert.equal(balance(), before);
  });

  it('credits nothing for a verification carrying no receipt id', () => {
    // The reference is the only replay defence on this rail. An event without
    // one cannot be made idempotent, so it must not be credited at all.
    assert.equal(kodaSettlement(verifiedEvent({ tenantId: 'T', receiptId: '' })), undefined);
  });

  it('credits nothing for a verification carrying no tenancy', () => {
    const event = verifiedEvent();
    (event.data as Record<string, unknown>).metadata = {};
    assert.equal(kodaSettlement(event), undefined);
  });
});

// ------------------------------------------------------------ the diagnostic

describe('a wrong KODA webhook secret is visible', () => {
  it('shows as rejections with nothing accepted', async () => {
    const body = JSON.stringify(verifiedEvent({ tenantId: seed.users.pm!.auth.tenantId }));
    for (let i = 0; i < 3; i += 1) await postWebhook(body, sign(body, 'koda_whsec_wrong'));

    const health = kodaWebhookHealth();
    assert.equal(health.accepted, 0);
    assert.equal(health.rejected, 3);
    assert.equal(health.lastRejection?.code, 'KODA_SIGNATURE_INVALID');
  });

  it('never puts the signature into the tally', async () => {
    const body = JSON.stringify(verifiedEvent());
    const header = sign(body, 'koda_whsec_wrong');
    await postWebhook(body, header);

    assert.ok(!JSON.stringify(kodaWebhookHealth()).includes(header), 'the signature reached the tally');
  });
});

// ------------------------------------------------------------ the route

describe('the KODA webhook route', () => {
  it('refuses a session token in place of a signature', async () => {
    const body = JSON.stringify(verifiedEvent({ tenantId: seed.users.pm!.auth.tenantId }));
    const before = balance();

    const res = await fetch(`${base}/v1/webhooks/koda`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenFor('admin')}` },
      body,
    });

    assert.equal(res.status, 400);
    assert.equal(balance(), before);
  });

  it('caps the body it will buffer', async () => {
    const res = await fetch(`${base}/v1/webhooks/koda`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-koda-signature': sign('{}') },
      body: 'x'.repeat(400 * 1024),
    });

    assert.equal(res.status, 400);
    const problem = (await res.json()) as { detail?: string };
    assert.match(String(problem.detail), /limit/i);
  });
});
