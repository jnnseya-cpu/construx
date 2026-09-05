import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { rateLimiter, resetIdempotency } from '../src/api/middleware.ts';
import * as collection from '../src/billing/collection.ts';
import { PACKAGES } from '../src/billing/seats.ts';
import { resetWebhookHealth, settledPayment, type StripeEvent } from '../src/billing/stripe.ts';
import { config } from '../src/config.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { completeSignIn } from './helpers.ts';

/**
 * Nothing is free unless the package is.
 *
 * A company signed up on a paid package and found £21.00 of AI credit in its
 * wallet with nothing paid: the 20% allowance of the month it had not bought,
 * plus the trial grant meant for the free package. The commercial rule is the
 * one the founder stated — everyone pays for their ACUs, and unless a free
 * package was given, a monthly subscription is paid — and this file is that
 * rule driven through the public API from signup to the first settled month.
 *
 *   - A paid package's first month is charged the day the tenancy exists.
 *   - A self-serve signup on a paid package waits for it: the person can sign
 *     in and read the empty record, but cannot write, run AI, buy credit or
 *     export until the first month settles. 402, not 403: money is owed.
 *   - The AI allowance is credited when — and only when — a period's charge
 *     settles, once per period however many times the payment is reported.
 *   - The operator can see who is waiting and record the payment against the
 *     reference the customer was shown; Stripe can settle it by card.
 *   - The free package opens at once and carries the trial grant, and nothing
 *     else is ever granted for free.
 */

const SECRET = 'whsec_paywall_suite_only';
type MutableStripeConfig = { secretKey: string; webhookSecret: string };
const stripeConfig = config.stripe as unknown as MutableStripeConfig;

let platform: Platform;
let server: Server;
let base: string;
let operatorToken: string;

async function call(method: string, path: string, token?: string, payload?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

async function signUp(email: string, pkg: string, organisationName: string) {
  rateLimiter.reset();
  const started = await call('POST', '/v1/signup', undefined, {
    email,
    contactName: 'Rowan Blake',
    organisationName,
    jurisdiction: 'GB',
    currency: 'GBP',
    package: pkg,
  });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const verified = await call('POST', '/v1/signup/verify', undefined, {
    registrationId: started.body.registrationId,
    token: started.body.devToken,
  });
  assert.equal(verified.status, 201, JSON.stringify(verified.body));
  const user = platform.userByEmail(email);
  assert.ok(user, `${email} was not provisioned`);
  // The charge's id is not in the verification reply — it belongs behind a
  // sign-in, on the billing screen — so it is read off the record here.
  const chargeId = collection.chargesFor(platform, user.tenantId)[0]?.id;
  return { verified: verified.body, tenantId: user.tenantId, userId: user.id, chargeId };
}

async function signIn(email: string): Promise<string> {
  rateLimiter.reset();
  const login = await call('POST', '/v1/auth/login', undefined, { email });
  assert.equal(login.status, 201, JSON.stringify(login.body));
  const verified = await call('POST', '/v1/auth/mfa/verify', undefined, {
    actorId: login.body.actorId,
    challengeId: login.body.challengeId,
    code: login.body.devCode,
  });
  assert.equal(verified.status, 201, JSON.stringify(verified.body));
  return completeSignIn(base, verified.body);
}

async function createPortfolio(token: string, tenantId: string, name: string) {
  const enterprise = platform.ledger.listByTenant(tenantId, 'Enterprise')[0];
  assert.ok(enterprise, 'signup provisioned no enterprise to file a portfolio under');
  return call('POST', '/v1/portfolios', token, {
    name,
    enterpriseId: enterprise.refId,
    governanceModel: 'CENTRALISED',
    continentCode: 'EU',
    countryCode: 'GB',
  });
}

function sign(body: string): string {
  const at = Math.floor(Date.now() / 1000);
  return `t=${at},v1=${createHmac('sha256', SECRET).update(`${at}.${body}`).digest('hex')}`;
}

function chargeEvent(input: { id: string; tenantId: string; chargeId: string; amountMinor: number; reference: string }): StripeEvent {
  return {
    id: input.id,
    type: 'checkout.session.completed',
    livemode: true,
    data: {
      object: {
        id: `cs_${input.id}`,
        object: 'checkout.session',
        amount_total: input.amountMinor,
        currency: 'gbp',
        payment_status: 'paid',
        payment_intent: input.reference,
        metadata: { tenantId: input.tenantId, chargeId: input.chargeId },
      },
    },
  };
}

const wallet = (tenantId: string) => platform.wallet(tenantId).snapshot().balanceMinor;
const allowanceOf = (pkg: keyof typeof PACKAGES) =>
  Math.round((PACKAGES[pkg].monthlyPriceMinor * config.billing.subscriptionAcuAllocationPercent) / 100);

before(async () => {
  stripeConfig.secretKey = 'sk_test_paywall';
  stripeConfig.webhookSecret = SECRET;
  platform = new Platform();
  collection.setCollector(collection.NO_PAYMENT_METHOD);
  const operator = platform.createUser({ tenantId: 'platform', name: 'Ops', email: 'ops@construx.example', roles: ['PLATFORM_ADMIN'] });
  operatorToken = issueTokens({
    actorId: operator.id,
    tenantId: operator.tenantId,
    partyId: operator.partyId,
    roles: operator.roles,
    mfaSatisfied: true,
  }).accessToken;
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

beforeEach(() => {
  resetIdempotency();
  resetWebhookHealth();
});

after(() => {
  server.close();
});

describe('a paid package, signed up for and not yet paid', () => {
  let tenantId: string;
  let chargeId: string;
  let adminToken: string;
  const email = 'finance@kestrel-build.example';

  before(async () => {
    const signed = await signUp(email, 'CORE_PROJECT', 'Kestrel Build Ltd');
    tenantId = signed.tenantId;
    chargeId = signed.chargeId!;
    // Verification says what is owed and sends the person to where it is paid.
    assert.equal(signed.verified.awaitingPayment, true);
    assert.equal(signed.verified.amountDueMinor, PACKAGES.CORE_PROJECT.monthlyPriceMinor);
    assert.equal(signed.verified.signInPath, '/app/billing');
    assert.ok(chargeId, 'no charge was raised for the first month');
  });

  it('holds nothing free: no allowance, no trial grant, and the first month owed', () => {
    assert.equal(platform.subscription(tenantId).status, 'AWAITING_PAYMENT');
    assert.equal(wallet(tenantId), 0, 'a paid package was credited before anything was paid');
    const charges = collection.chargesFor(platform, tenantId);
    assert.equal(charges.length, 1);
    assert.equal(charges[0]!.status, 'DUE');
    assert.equal(charges[0]!.amountMinor, PACKAGES.CORE_PROJECT.monthlyPriceMinor);
  });

  it('lets the person sign in, and shows them the bill', async () => {
    adminToken = await signIn(email);
    const bill = await call('GET', '/v1/billing/subscription', adminToken);
    assert.equal(bill.status, 200, JSON.stringify(bill.body));
    assert.equal(bill.body.subscription.status, 'AWAITING_PAYMENT');
    assert.equal(bill.body.standing.mayWrite, false);
    assert.equal(bill.body.standing.mayRunAI, false);
    assert.equal(bill.body.standing.mayTopUp, false);
    assert.match(bill.body.standing.reason, /first month/i);
    assert.equal(bill.body.outstandingMinor, PACKAGES.CORE_PROJECT.monthlyPriceMinor);
    assert.equal(bill.body.charges.length, 1);
    assert.equal(bill.body.charges[0].id, chargeId);
    assert.match(bill.body.charges[0].paymentReference, /^CX-[A-Z0-9]{8}$/, 'no reference to quote on a transfer');
    assert.equal(bill.body.payment.bankTransfer, true);
    assert.equal(bill.body.payment.card, true, 'Stripe is configured for this suite, so card must be offered');
  });

  it('refuses a write as money owed, not as a permission', async () => {
    const attempt = await createPortfolio(adminToken, tenantId, 'Before paying');
    assert.equal(attempt.status, 402, JSON.stringify(attempt.body));
    assert.equal(attempt.body.title, 'SUBSCRIPTION_NOT_ACTIVE');
    assert.match(attempt.body.detail, /not been paid/);
  });

  it('refuses to sell AI credit to a tenancy that has not bought the platform', async () => {
    const topUp = await call('POST', '/v1/billing/top-up', adminToken, { amountMinor: 1_000 });
    assert.equal(topUp.status, 402, JSON.stringify(topUp.body));
    assert.equal(topUp.body.title, 'SUBSCRIPTION_NOT_ACTIVE');
    assert.equal(wallet(tenantId), 0);
  });

  it('is on the operator’s onboarding queue as awaiting its first payment', async () => {
    const register = await call('GET', '/v1/admin/tenants', operatorToken);
    assert.equal(register.status, 200);
    const row = register.body.tenants.find((tenant: { id: string }) => tenant.id === tenantId);
    assert.ok(row, 'the signup is invisible to the operator');
    assert.equal(row.awaitingFirstPayment, true);
    assert.equal(row.outstandingMinor, PACKAGES.CORE_PROJECT.monthlyPriceMinor);

    const charges = await call('GET', `/v1/admin/tenants/${tenantId}/charges`, operatorToken);
    assert.equal(charges.status, 200);
    assert.equal(charges.body.status, 'AWAITING_PAYMENT');
    assert.equal(charges.body.charges[0].id, chargeId);
    assert.equal(charges.body.charges[0].paymentReference, `CX-${chargeId.slice(-8).toUpperCase()}`);
  });

  it('is the operator’s act to settle, not the customer’s', async () => {
    const own = await call('POST', `/v1/admin/tenants/${tenantId}/charges/${chargeId}/settle`, adminToken, {
      reference: 'I-PAID-HONEST',
      method: 'BANK_TRANSFER',
    });
    assert.equal(own.status, 403);
    assert.equal(platform.subscription(tenantId).status, 'AWAITING_PAYMENT');
  });

  it('opens the moment the operator records the transfer, and credits the allowance once', async () => {
    const before = await call('GET', '/v1/admin/overview', operatorToken);
    const settled = await call('POST', `/v1/admin/tenants/${tenantId}/charges/${chargeId}/settle`, operatorToken, {
      reference: 'BACS-KESTREL-0001',
      method: 'BANK_TRANSFER',
      note: 'Matched on the CX reference',
    });
    assert.equal(settled.status, 201, JSON.stringify(settled.body));
    assert.equal(settled.body.status, 'ACTIVE');
    assert.equal(settled.body.charge.status, 'SETTLED');
    assert.equal(settled.body.alreadyRecorded, false);
    assert.equal(settled.body.receipt.chargeId, chargeId, 'the receipt does not say which period it paid');
    assert.equal(settled.body.receipt.amountMinor, PACKAGES.CORE_PROJECT.monthlyPriceMinor);

    assert.equal(platform.subscription(tenantId).status, 'ACTIVE');
    assert.equal(wallet(tenantId), allowanceOf('CORE_PROJECT'), 'the allowance follows the settlement, and only the allowance');

    // Money counted where the operator looks for it.
    const after = await call('GET', '/v1/admin/overview', operatorToken);
    assert.equal(
      after.body.revenue.lifetimeMinor - before.body.revenue.lifetimeMinor,
      PACKAGES.CORE_PROJECT.monthlyPriceMinor,
      'a settled subscription is revenue',
    );
  });

  it('records the same payment once however many times it is reported', async () => {
    const again = await call('POST', `/v1/admin/tenants/${tenantId}/charges/${chargeId}/settle`, operatorToken, {
      reference: 'BACS-KESTREL-0001',
      method: 'BANK_TRANSFER',
    });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(again.body.alreadyRecorded, true);
    assert.equal(wallet(tenantId), allowanceOf('CORE_PROJECT'), 'the allowance was credited twice for one payment');
    assert.equal(platform.paymentReceipts(tenantId).length, 1);
  });

  it('refuses a second, different payment against a period already paid', async () => {
    const twice = await call('POST', `/v1/admin/tenants/${tenantId}/charges/${chargeId}/settle`, operatorToken, {
      reference: 'BACS-KESTREL-0002',
      method: 'BANK_TRANSFER',
    });
    assert.equal(twice.status, 409, JSON.stringify(twice.body));
    assert.equal(twice.body.title, 'CHARGE_ALREADY_SETTLED');
    assert.equal(platform.paymentReceipts(tenantId).length, 1, 'money was taken for a period already paid');
  });

  it('then lets the customer work', async () => {
    const created = await createPortfolio(adminToken, tenantId, 'After paying');
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const bill = await call('GET', '/v1/billing/subscription', adminToken);
    assert.equal(bill.body.subscription.status, 'ACTIVE');
    assert.equal(bill.body.outstandingMinor, 0);
    assert.equal(bill.body.standing.mayWrite, true);
    const register = await call('GET', '/v1/admin/tenants', operatorToken);
    const row = register.body.tenants.find((tenant: { id: string }) => tenant.id === tenantId);
    assert.equal(row.awaitingFirstPayment, false);
  });
});

describe('a paid package, paid by card through Stripe', () => {
  let tenantId: string;
  let chargeId: string;
  const email = 'owner@marlow-joinery.example';

  before(async () => {
    const signed = await signUp(email, 'SOLO', 'Marlow Joinery');
    tenantId = signed.tenantId;
    chargeId = signed.chargeId!;
  });

  it('offers a checkout for the charge, and only for a charge still owed', async () => {
    const token = await signIn(email);
    const checkout = await call('POST', `/v1/billing/charges/${chargeId}/checkout`, token, {});
    // No Stripe account answers in this suite; what matters is that the door
    // exists, is the customer's own, and is refused for somebody else's charge.
    assert.ok([201, 502, 503].includes(checkout.status), `unexpected ${checkout.status}: ${JSON.stringify(checkout.body)}`);
    const other = await call('POST', `/v1/billing/charges/not-my-charge/checkout`, token, {});
    assert.equal(other.status, 404);
  });

  it('reads the charge off the session Stripe signed', () => {
    const payment = settledPayment(chargeEvent({ id: 'evt_read', tenantId, chargeId, amountMinor: PACKAGES.SOLO.monthlyPriceMinor, reference: 'pi_read' }));
    assert.ok(payment);
    assert.equal(payment.chargeId, chargeId);
    assert.equal(payment.amountMinor, PACKAGES.SOLO.monthlyPriceMinor);
  });

  it('refuses a card payment that does not match the charge', async () => {
    const body = JSON.stringify(chargeEvent({ id: 'evt_short', tenantId, chargeId, amountMinor: PACKAGES.SOLO.monthlyPriceMinor - 1, reference: 'pi_short' }));
    const res = await fetch(`${base}/v1/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': sign(body) },
      body,
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { title: string }).title, 'STRIPE_AMOUNT_MISMATCH');
    assert.equal(platform.subscription(tenantId).status, 'AWAITING_PAYMENT');
    assert.equal(wallet(tenantId), 0);
  });

  it('settles the charge, opens the tenancy and credits the allowance when Stripe confirms the payment', async () => {
    const body = JSON.stringify(chargeEvent({ id: 'evt_paid', tenantId, chargeId, amountMinor: PACKAGES.SOLO.monthlyPriceMinor, reference: 'pi_marlow_1' }));
    const post = () =>
      fetch(`${base}/v1/webhooks/stripe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': sign(body) },
        body,
      });
    const first = await post();
    const firstText = await first.text();
    assert.equal(first.status, 201, firstText);
    const acted = JSON.parse(firstText) as { acted: boolean; chargeId: string; alreadyRecorded: boolean };
    assert.equal(acted.acted, true);
    assert.equal(acted.chargeId, chargeId);
    assert.equal(acted.alreadyRecorded, false);

    assert.equal(platform.subscription(tenantId).status, 'ACTIVE');
    assert.equal(wallet(tenantId), allowanceOf('SOLO'));
    assert.equal(platform.paymentReceipts(tenantId)[0]?.method, 'CARD');
    assert.equal(platform.paymentReceipts(tenantId)[0]?.chargeId, chargeId);

    // Stripe redelivers. The second delivery is acknowledged and changes nothing.
    const second = await post();
    assert.equal(second.status, 201);
    assert.equal(((await second.json()) as { alreadyRecorded: boolean }).alreadyRecorded, true);
    assert.equal(wallet(tenantId), allowanceOf('SOLO'));
    assert.equal(platform.paymentReceipts(tenantId).length, 1);
  });
});

describe('the free package', () => {
  it('opens at once with the trial grant, and nothing else is ever free', async () => {
    const signed = await signUp('trial@northgate-eval.example', 'FREE_TRIAL', 'Northgate Evaluation');
    assert.equal(signed.verified.awaitingPayment, false);
    assert.equal(signed.verified.amountDueMinor, 0);
    assert.equal(signed.verified.signInPath, '/app');
    assert.equal(platform.subscription(signed.tenantId).status, 'ACTIVE');
    assert.equal(wallet(signed.tenantId), config.billing.freeTrialGrantMinor, 'the trial grant is the whole of what a free package gets');
    assert.equal(collection.chargesFor(platform, signed.tenantId).length, 0, 'a free package was charged');
  });
});
