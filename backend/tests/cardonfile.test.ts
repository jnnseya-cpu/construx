import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { resetIdempotency } from '../src/api/middleware.ts';
import * as cardonfile from '../src/billing/cardonfile.ts';
import * as collection from '../src/billing/collection.ts';
import * as mandate from '../src/billing/mandate.ts';
import { PACKAGES } from '../src/billing/seats.ts';
import { resetWebhookHealth } from '../src/billing/stripe.ts';
import { config } from '../src/config.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { authOf } from '../src/seed.ts';

/**
 * The card a company keeps with us, and the months it pays for.
 *
 * The activation popup records *I authorise CONSTRUX to collect £X today and
 * the same amount each month by card, until I cancel*. This suite is the rail
 * behind that sentence: the first month's checkout tells Stripe to keep the
 * card, the webhook reads back which card it was, the monthly cycle charges it
 * off-session against the charge id, a decline is an attempt on the record
 * rather than a payment, and cancelling the mandate forgets the card here and
 * at Stripe.
 *
 * Stripe is a fake `fetch` answering `api.stripe.com` and nothing else; every
 * other URL — the gateway under test — goes to the real one. What the fake
 * records is what was asked of Stripe, which is the whole point: the card must
 * only be kept under a recurring-card mandate, and a month must only be taken
 * once however many times the cycle runs.
 */

const SECRET = 'whsec_card_on_file_suite';
const DAY = 86_400_000;

type MutableStripeConfig = { secretKey: string; webhookSecret: string };
const stripeConfig = config.stripe as unknown as MutableStripeConfig;

let platform: Platform;
let server: Server;
let base: string;
let tenantId = '';
let adminToken = '';
let adminId = '';

/** What the fake Stripe was asked, in order. */
type StripeCall = { method: string; path: string; body: URLSearchParams; idempotencyKey?: string };
let calls: StripeCall[] = [];
/** How the fake answers the next off-session charge; unset, it succeeds. */
let nextIntent: { status: number; body: Record<string, unknown> } | undefined;
let intentCounter = 0;

const realFetch = globalThis.fetch;

function stripeAnswer(call: StripeCall): { status: number; body: Record<string, unknown> } {
  if (call.method === 'POST' && call.path === '/checkout/sessions') {
    return { status: 200, body: { id: 'cs_fake', url: 'https://checkout.stripe.com/c/pay/cs_fake' } };
  }
  if (call.method === 'GET' && call.path.startsWith('/payment_intents/')) {
    const id = decodeURIComponent(call.path.slice('/payment_intents/'.length));
    // The first checkout's intent: paid by pm_visa under customer cus_jnn.
    return { status: 200, body: { id, customer: 'cus_jnn', payment_method: id === 'pi_second_card' ? 'pm_master' : 'pm_visa' } };
  }
  if (call.method === 'GET' && call.path.startsWith('/payment_methods/')) {
    const id = decodeURIComponent(call.path.slice('/payment_methods/'.length));
    const card = id === 'pm_master'
      ? { brand: 'mastercard', last4: '4444', exp_month: 6, exp_year: 2031 }
      : { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 };
    return { status: 200, body: { id, card } };
  }
  if (call.method === 'POST' && call.path === '/payment_intents') {
    intentCounter += 1;
    const answer = nextIntent ?? { status: 200, body: { id: `pi_month_${intentCounter}`, status: 'succeeded' } };
    nextIntent = undefined;
    return answer;
  }
  if (call.method === 'POST' && /^\/payment_methods\/[^/]+\/detach$/.test(call.path)) {
    return { status: 200, body: { id: call.path.split('/')[2], customer: null } };
  }
  return { status: 404, body: { error: { message: `the fake Stripe has no ${call.method} ${call.path}` } } };
}

function fakeStripe(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://api.stripe.com/v1')) return realFetch(input, init);
    const headers = new Headers(init?.headers);
    const call: StripeCall = {
      method: init?.method ?? 'GET',
      path: url.slice('https://api.stripe.com/v1'.length),
      body: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''),
      ...(headers.get('idempotency-key') ? { idempotencyKey: headers.get('idempotency-key')! } : {}),
    };
    calls.push(call);
    const answer = stripeAnswer(call);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

function tokenFor(userId: string): string {
  const auth = authOf(platform, userId);
  return issueTokens({ actorId: auth.actorId, tenantId: auth.tenantId, partyId: auth.partyId, roles: auth.roles, mfaSatisfied: true }).accessToken;
}

async function send(method: string, path: string, token: string, payload?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function sign(body: string, at = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac('sha256', SECRET).update(`${at}.${body}`).digest('hex');
  return `t=${at},v1=${v1}`;
}

function paidCheckout(over: { eventId: string; chargeId: string; amountMinor: number; paymentIntent: string; customer?: string | null }): string {
  return JSON.stringify({
    id: over.eventId,
    type: 'checkout.session.completed',
    livemode: false,
    data: {
      object: {
        id: `cs_${over.eventId}`,
        object: 'checkout.session',
        amount_total: over.amountMinor,
        currency: 'gbp',
        payment_status: 'paid',
        payment_intent: over.paymentIntent,
        ...(over.customer === null ? {} : { customer: over.customer ?? 'cus_jnn' }),
        metadata: { tenantId, chargeId: over.chargeId },
      },
    },
  });
}

async function postWebhook(body: string) {
  const response = await fetch(`${base}/v1/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': sign(body) },
    body,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const firstCharge = () => collection.chargesFor(platform, tenantId)[0]!;
const dueCharge = () => collection.outstanding(platform, tenantId)[0];
const receipts = () => platform.ledger.listByTenant(tenantId, 'PaymentReceipt').map((record) => record.state as { reference: string; chargeId?: string; recordedBy: string });

before(async () => {
  stripeConfig.secretKey = 'sk_test_card_on_file';
  stripeConfig.webhookSecret = SECRET;
  fakeStripe();

  platform = new Platform();
  collection.setCollector(collection.NO_PAYMENT_METHOD);
  const created = platform.createTenant({ legalName: 'JNN GLOBAL LTD', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'TEAM', package: 'CORE_PROJECT', enterpriseName: 'JNN GLOBAL', trialGrant: false, opensOn: 'FIRST_PAYMENT' });
  tenantId = created.tenant.id;
  adminId = platform.createUser({ tenantId, name: 'Jean Nseya', email: 'jean@jnnglobal.example', roles: ['OWNER', 'ENTERPRISE_ADMIN'] }).id;
  adminToken = tokenFor(adminId);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

beforeEach(() => {
  resetIdempotency();
  resetWebhookHealth();
  calls = [];
});

after(() => {
  server.close();
  collection.setCollector(collection.NO_PAYMENT_METHOD);
  globalThis.fetch = realFetch;
  stripeConfig.secretKey = '';
  stripeConfig.webhookSecret = '';
});

describe('the first month, paid by card under a recurring-card mandate', () => {
  it('opens a checkout that tells Stripe to keep the card', async () => {
    const authorised = await send('POST', '/v1/billing/mandate', adminToken, { method: 'RECURRING_CARD', authorised: true });
    assert.equal(authorised.status, 201, JSON.stringify(authorised.body));

    const opened = await send('POST', `/v1/billing/charges/${firstCharge().id}/checkout`, adminToken, {});
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    assert.equal(opened.body.checkoutUrl, 'https://checkout.stripe.com/c/pay/cs_fake');

    const checkout = calls.find((call) => call.path === '/checkout/sessions')!;
    assert.ok(checkout, 'no checkout session was asked of Stripe');
    assert.equal(checkout.body.get('customer_creation'), 'always', 'no customer to hold the card');
    assert.equal(checkout.body.get('payment_intent_data[setup_future_usage]'), 'off_session', 'the card was not asked to be kept');
    assert.equal(checkout.body.get('metadata[chargeId]'), firstCharge().id);
    assert.equal(checkout.body.get('line_items[0][price_data][unit_amount]'), String(PACKAGES.CORE_PROJECT.monthlyPriceMinor));
  });

  it('keeps the card the webhook says paid: brand, last four and expiry, never the number', async () => {
    const charge = firstCharge();
    const reply = await postWebhook(paidCheckout({ eventId: 'evt_first', chargeId: charge.id, amountMinor: charge.amountMinor, paymentIntent: 'pi_first' }));
    assert.ok([200, 201].includes(reply.status), JSON.stringify(reply.body));
    assert.equal(reply.body.acted, true);
    assert.equal(reply.body.alreadyRecorded, false);
    assert.equal(reply.body.cardSaved, true);

    // The money first, then the card: the charge settled and the tenancy opened.
    assert.equal(collection.chargesFor(platform, tenantId)[0]!.status, 'SETTLED');
    assert.equal(platform.subscription(tenantId).status, 'ACTIVE');

    const card = cardonfile.cardOnFile(platform, tenantId)!;
    assert.ok(card, 'no card was kept');
    assert.equal(card.customerId, 'cus_jnn');
    assert.equal(card.paymentMethodId, 'pm_visa');
    assert.equal(card.brand, 'visa');
    assert.equal(card.last4, '4242');
    assert.equal(card.expMonth, 12);
    assert.equal(card.expYear, 2030);
    assert.equal(card.savedFrom, 'stripe:pi_first');
    assert.equal(card.mandateId, mandate.currentMandate(platform, tenantId)!.id);
    assert.equal(card.status, 'ACTIVE');

    // Read back from Stripe by the intent, then the method: two reads, no more.
    assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), ['GET /payment_intents/pi_first', 'GET /payment_methods/pm_visa']);
  });

  it('shows the customer the card, and never its ids', async () => {
    const position = await send('GET', '/v1/billing/mandate', adminToken);
    assert.equal(position.status, 200);
    assert.deepEqual(position.body.cardOnFile, { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030, savedAt: cardonfile.cardOnFile(platform, tenantId)!.savedAt });
    const serialised = JSON.stringify(position.body);
    assert.ok(!serialised.includes('cus_jnn'), 'the Stripe customer id reached the customer');
    assert.ok(!serialised.includes('pm_visa'), 'the Stripe payment method id reached the customer');
    assert.equal(position.body.required, true, 'the position still says what the account pays');
    assert.equal(position.body.firstCharge, null, 'nothing is owed once the first month is paid');
  });

  it('keeps one card when Stripe redelivers the webhook', async () => {
    const charge = firstCharge();
    const reply = await postWebhook(paidCheckout({ eventId: 'evt_first', chargeId: charge.id, amountMinor: charge.amountMinor, paymentIntent: 'pi_first' }));
    assert.ok([200, 201].includes(reply.status));
    assert.equal(reply.body.alreadyRecorded, true);
    assert.equal(reply.body.cardSaved, false, 'a redelivery saved the card again');
    assert.equal(platform.ledger.listByTenant(tenantId, 'CardOnFile').length, 1, 'a second CardOnFile record was written');
  });

  it('survives a restart', () => {
    const rebuilt = new Platform();
    rebuilt.ledger.restore(platform.ledger.events());
    rebuilt.rehydrate();
    assert.equal(cardonfile.cardOnFile(rebuilt, tenantId)!.paymentMethodId, 'pm_visa');
  });
});

describe('the months after, taken from the card', () => {
  const nextPeriod = () => {
    const subscription = platform.subscription(tenantId);
    return new Date(Date.parse(subscription.renewsAt) + DAY);
  };

  it('charges the card off-session, keyed on the charge so a retried run cannot take a month twice', async () => {
    collection.setCollector(cardonfile.stripeCollector(platform));
    const raised = collection.raiseCharge(platform, tenantId, nextPeriod())!;
    assert.equal(raised.alreadyRaised, false);

    const outcome = await collection.attemptCollection(platform, raised.charge, nextPeriod());
    assert.equal(outcome.settled, true, JSON.stringify(outcome));
    assert.ok(outcome.settled && outcome.reference.startsWith('stripe:pi_month_'), outcome.settled ? outcome.reference : '');

    const asked = calls.find((call) => call.method === 'POST' && call.path === '/payment_intents')!;
    assert.ok(asked, 'nothing was asked of Stripe');
    assert.equal(asked.idempotencyKey, `charge-${raised.charge.id}`);
    assert.equal(asked.body.get('amount'), String(PACKAGES.CORE_PROJECT.monthlyPriceMinor));
    assert.equal(asked.body.get('currency'), 'gbp');
    assert.equal(asked.body.get('customer'), 'cus_jnn');
    assert.equal(asked.body.get('payment_method'), 'pm_visa');
    assert.equal(asked.body.get('off_session'), 'true');
    assert.equal(asked.body.get('confirm'), 'true');
    assert.equal(asked.body.get('metadata[chargeId]'), raised.charge.id);
    assert.match(asked.body.get('description') ?? '', /CONSTRUX Core Project — the period from \d{4}-\d{2}-\d{2}/);

    // Settled on the record, with a receipt under Stripe's reference.
    const settled = collection.chargesFor(platform, tenantId).find((charge) => charge.id === raised.charge.id)!;
    assert.equal(settled.status, 'SETTLED');
    assert.equal(settled.settlementReference, outcome.settled ? outcome.reference : '');
    const receipt = receipts().find((candidate) => candidate.chargeId === raised.charge.id)!;
    assert.ok(receipt, 'the collection left no receipt');
    assert.equal(receipt.recordedBy, 'billing:collector');
    assert.equal(collection.outstanding(platform, tenantId).length, 0);
  });

  it('records a decline as an attempt, names the card, and leaves the month owed', async () => {
    nextIntent = { status: 402, body: { error: { code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card has insufficient funds.' } } };
    const raised = collection.raiseCharge(platform, tenantId, nextPeriod())!;
    const outcome = await collection.attemptCollection(platform, raised.charge, nextPeriod());

    assert.equal(outcome.settled, false);
    assert.match(outcome.settled ? '' : outcome.because, /^visa •••• 4242: The card was not charged: insufficient_funds$/);
    const owed = dueCharge()!;
    assert.equal(owed.id, raised.charge.id);
    assert.equal(owed.status, 'DUE');
    assert.equal(owed.attempts.length, 1);
    assert.match(owed.attempts[0]!.because, /insufficient_funds/);
    assert.equal(receipts().some((receipt) => receipt.chargeId === raised.charge.id), false, 'a decline left a receipt');
    // The customer is not cut off by a decline: the grace period runs as it always has.
    assert.equal(platform.subscription(tenantId).status, 'ACTIVE');
  });

  it('treats a card that needs the customer present as not paid', async () => {
    // Settle the declined month by transfer first, so the next period stands alone.
    platform.recordSubscriptionPayment({ tenantId, chargeId: dueCharge()!.id, method: 'BANK_TRANSFER', reference: 'BACS-DECLINED-MONTH', recordedBy: 'ops', source: 'OPERATOR' });
    nextIntent = { status: 200, body: { id: 'pi_sca', status: 'requires_action' } };
    const raised = collection.raiseCharge(platform, tenantId, nextPeriod())!;
    const outcome = await collection.attemptCollection(platform, raised.charge, nextPeriod());

    assert.equal(outcome.settled, false);
    assert.match(outcome.settled ? '' : outcome.because, /requires_action rather than succeeded; the card needs the customer present/);
    assert.equal(dueCharge()!.status, 'DUE');
    platform.recordSubscriptionPayment({ tenantId, chargeId: dueCharge()!.id, method: 'BANK_TRANSFER', reference: 'BACS-SCA-MONTH', recordedBy: 'ops', source: 'OPERATOR' });
  });

  it('answers as the default does for a tenancy that never kept a card', async () => {
    const other = platform.createTenant({ legalName: 'NO CARD LTD', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'TEAM', package: 'CORE_PROJECT', enterpriseName: 'No Card', trialGrant: false, opensOn: 'FIRST_PAYMENT' });
    const opening = collection.outstanding(platform, other.tenant.id)[0]!;
    const outcome = await cardonfile.stripeCollector(platform)({ tenantId: other.tenant.id, chargeId: opening.id, amountMinor: opening.amountMinor, currency: 'GBP' });
    assert.equal(outcome.settled, false);
    assert.equal(outcome.settled ? '' : outcome.because, 'No payment method is held for this tenancy, so nothing can be taken automatically');
    assert.equal(calls.length, 0, 'Stripe was asked about a tenancy with no card');
  });
});

describe('a newer card supersedes, and cancelling the mandate forgets it', () => {
  it('keeps one card at a time, the older one removed as superseded', () => {
    const saved = cardonfile.saveCardOnFile(platform, {
      tenantId,
      customerId: 'cus_jnn',
      paymentMethodId: 'pm_master',
      card: { brand: 'mastercard', last4: '4444', expMonth: 6, expYear: 2031 },
      savedFrom: 'stripe:pi_second_card',
    });
    assert.equal(saved.alreadySaved, false);
    assert.equal(cardonfile.cardOnFile(platform, tenantId)!.paymentMethodId, 'pm_master');
    const all = platform.ledger.listByTenant(tenantId, 'CardOnFile').map((record) => record.state as { paymentMethodId: string; status: string; removedReason?: string });
    assert.equal(all.length, 2);
    const older = all.find((card) => card.paymentMethodId === 'pm_visa')!;
    assert.equal(older.status, 'REMOVED');
    assert.equal(older.removedReason, 'Superseded by a newer card');
  });

  it('forgets the card here and detaches it at Stripe when the mandate is cancelled', async () => {
    const cancelled = await send('POST', '/v1/billing/mandate/cancel', adminToken, { reason: 'Moving to Direct Debit' });
    assert.equal(cancelled.status, 201, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.status, 'CANCELLED');
    assert.equal(cancelled.body.cardRemoved, true);

    assert.equal(cardonfile.cardOnFile(platform, tenantId), null);
    const detached = calls.find((call) => call.method === 'POST' && call.path === '/payment_methods/pm_master/detach');
    assert.ok(detached, 'the payment method was not detached at Stripe');
    const removed = platform.ledger.listByTenant(tenantId, 'CardOnFile').map((record) => record.state as { paymentMethodId: string; status: string; removedReason?: string; removedBy?: string }).find((card) => card.paymentMethodId === 'pm_master')!;
    assert.equal(removed.status, 'REMOVED');
    assert.match(removed.removedReason!, /Mandate cancelled: Moving to Direct Debit/);
    assert.equal(removed.removedBy, adminId);

    const position = await send('GET', '/v1/billing/mandate', adminToken);
    assert.equal(position.body.cardOnFile, null);
    assert.equal(position.body.mandate, null);
  });

  it('takes nothing automatically once the card is gone', async () => {
    const outcome = await cardonfile.stripeCollector(platform)({ tenantId, chargeId: 'none', amountMinor: 1, currency: 'GBP' });
    assert.equal(outcome.settled, false);
    assert.equal(calls.length, 0);
  });
});

describe('without a recurring-card mandate nothing is kept', () => {
  let otherTenant = '';
  let otherToken = '';

  before(() => {
    const created = platform.createTenant({ legalName: 'TRANSFER LTD', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'TEAM', package: 'CORE_PROJECT', enterpriseName: 'Transfer', trialGrant: false, opensOn: 'FIRST_PAYMENT' });
    otherTenant = created.tenant.id;
    otherToken = tokenFor(platform.createUser({ tenantId: otherTenant, name: 'Lea Mbala', email: 'lea@transfer.example', roles: ['OWNER', 'ENTERPRISE_ADMIN'] }).id);
  });

  it('opens a checkout that asks Stripe to keep nothing under a Direct Debit authorisation', async () => {
    const authorised = await send('POST', '/v1/billing/mandate', otherToken, { method: 'DIRECT_DEBIT', authorised: true });
    assert.equal(authorised.status, 201, JSON.stringify(authorised.body));
    const opening = collection.outstanding(platform, otherTenant)[0]!;
    const opened = await send('POST', `/v1/billing/charges/${opening.id}/checkout`, otherToken, {});
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    const checkout = calls.find((call) => call.path === '/checkout/sessions')!;
    assert.equal(checkout.body.get('customer_creation'), null, 'a customer was created with no authorisation to keep a card');
    assert.equal(checkout.body.get('payment_intent_data[setup_future_usage]'), null);
  });

  it('settles the charge from the webhook and reads no card back', async () => {
    const opening = collection.outstanding(platform, otherTenant)[0]!;
    const body = JSON.stringify({
      id: 'evt_transfer_first',
      type: 'checkout.session.completed',
      livemode: false,
      data: {
        object: {
          id: 'cs_transfer',
          object: 'checkout.session',
          amount_total: opening.amountMinor,
          currency: 'gbp',
          payment_status: 'paid',
          payment_intent: 'pi_transfer_first',
          customer: 'cus_transfer',
          metadata: { tenantId: otherTenant, chargeId: opening.id },
        },
      },
    });
    const reply = await postWebhook(body);
    assert.ok([200, 201].includes(reply.status), JSON.stringify(reply.body));
    assert.equal(reply.body.acted, true);
    assert.equal(reply.body.cardSaved, false);
    assert.equal(cardonfile.cardOnFile(platform, otherTenant), null);
    assert.equal(calls.length, 0, 'Stripe was asked about a card nobody authorised keeping');
    assert.equal(platform.subscription(otherTenant).status, 'ACTIVE');
  });
});
