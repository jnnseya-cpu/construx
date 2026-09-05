import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.ts';
import { DomainError } from '../core/errors.ts';
import { BILLING_CURRENCY } from './payments.ts';

/**
 * Stripe, over `fetch` and `node:crypto`.
 *
 * No SDK: zero runtime dependencies is a settled decision, and Stripe's API is
 * form-encoded HTTP with an HMAC on the webhook. The AI providers are wired the
 * same way in `ai/providers/remote.ts`, so this is the house pattern rather than
 * an exception made for billing.
 *
 * ---
 *
 * **The webhook is the dangerous part, and the signature is the whole defence.**
 * It is a public endpoint — Stripe cannot hold a credential of ours — that
 * credits wallets. Unverified, it is the mint all over again, worse than the
 * original: anybody who learns the URL posts a JSON body and gets money. So the
 * signature is checked before the payload is looked at, over the exact bytes
 * received, in constant time, inside a tolerance window.
 *
 * **Nothing the browser says about money is believed.** The amount, the
 * currency and the payment status are read from the verified Stripe object, not
 * from the request that started the checkout. A customer can open a session for
 * £10 and pay £10; they cannot open one for £10 and have £10,000 credited,
 * because the figure that reaches the wallet is the one Stripe signed.
 *
 * **Live and test money are never confused.** A production deployment refuses
 * an event with `livemode: false`. Without that check, anybody holding a Stripe
 * test key — which is to say anybody, they are free — could drive real credit
 * onto a real account with fake payments.
 *
 * **A payment credits once, however many times we hear about it.** Stripe
 * retries for days on any non-2xx and delivers at-least-once by design, and one
 * Checkout sale raises more than one event with a different id on each. So the
 * reference is the *payment intent* rather than the event, and
 * `Platform.creditFromPayment` spends a reference exactly once.
 */

const STRIPE_API = 'https://api.stripe.com/v1';

/** How far out of date a signature may be. Stripe's own recommendation. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

export function stripeConfigured(): boolean {
  return config.stripe.secretKey !== '' && config.stripe.webhookSecret !== '';
}

// ------------------------------------------------------------- delivery health

/**
 * A tally of what the webhook endpoint has been sent.
 *
 * There is one deployment mistake that is silent, expensive and easy to make:
 * a webhook secret that is set but wrong — the signing secret of a different
 * endpoint, or one copied before the endpoint was recreated. Checkout works,
 * customers pay Stripe, every delivery fails verification, and nothing is ever
 * credited. Each failure is a 400 in a log nobody is reading, while the money
 * is real and the customer is waiting for credit.
 *
 * Boot-time configuration checks cannot catch it: the secret is present and
 * well-formed, it is simply not the right one. Only a delivery can tell us, so
 * the count of deliveries is the diagnostic. Rejected climbing while accepted
 * stays at zero has exactly one likely cause, and the operator can see it on
 * `GET /v1/admin/payments` instead of inferring it from Stripe's dashboard.
 *
 * In-process and reset by a restart, like everything else here. It is
 * operational telemetry, not a record — the receipts are the record.
 */
export type WebhookHealth = {
  accepted: number;
  rejected: number;
  /** The failure code of the most recent rejection, never the signature itself. */
  lastRejection?: { code: string; at: string };
  lastAcceptedAt?: string;
};

const health: WebhookHealth = { accepted: 0, rejected: 0 };

export function webhookHealth(): WebhookHealth {
  return { ...health };
}

export function resetWebhookHealth(): void {
  health.accepted = 0;
  health.rejected = 0;
  delete health.lastRejection;
  delete health.lastAcceptedAt;
}

/**
 * Record the outcome and re-throw.
 *
 * Wrapping every refusal rather than counting at the route, so a failure added
 * later cannot be the one that goes uncounted — which would be the failure that
 * matters, since an uncounted rejection is an invisible one.
 */
function reject(error: DomainError): never {
  health.rejected += 1;
  health.lastRejection = { code: error.code, at: new Date().toISOString() };
  throw error;
}

// ------------------------------------------------------------------ requests

/**
 * Stripe takes form encoding, including for nested objects: `metadata[tenantId]`
 * rather than JSON. Written out rather than reached for from a library, because
 * it is six lines and the library would be the only runtime dependency.
 */
function formEncode(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

async function stripeRequest(path: string, body: Record<string, string | number | undefined>): Promise<Record<string, unknown>> {
  if (!stripeConfigured()) {
    throw new DomainError('STRIPE_UNCONFIGURED', 'Stripe is not configured on this deployment', 503);
  }

  const response = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.stripe.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      // Stripe pins behaviour to an API version. Sending ours means a version
      // rolled out on their side cannot change the shape of what we parse.
      'Stripe-Version': config.stripe.apiVersion,
    },
    body: formEncode(body),
    signal: AbortSignal.timeout(20_000),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const detail = (payload.error as { message?: string } | undefined)?.message ?? `HTTP ${response.status}`;
    throw new DomainError('STRIPE_ERROR', `Stripe refused the request: ${detail}`, 502);
  }
  return payload;
}

/**
 * A hosted checkout page for one top-up.
 *
 * The amount is fixed here from the intent already recorded, and travels to
 * Stripe rather than being chosen at the page. `metadata` carries the tenancy
 * and the intent so the webhook can match the payment back without trusting
 * anything the browser sends on the return trip.
 */
export async function createCheckoutSession(input: {
  /** The top-up this pays, or — with `chargeId` — absent. */
  intentId?: string;
  /**
   * The subscription charge this pays. A period, not AI credit: the webhook
   * settles the charge rather than crediting a wallet, and the checkout page
   * says what is being bought.
   */
  chargeId?: string;
  tenantId: string;
  amountMinor: number;
  customerEmail?: string;
  successUrl: string;
  cancelUrl: string;
  /** What the checkout page names, for a subscription charge. */
  description?: string;
}): Promise<{ id: string; url: string }> {
  if (!input.intentId && !input.chargeId) {
    throw new DomainError('CHECKOUT_TARGET_REQUIRED', 'A checkout pays a top-up request or a subscription charge', 400);
  }
  const target = input.chargeId ? { 'metadata[chargeId]': input.chargeId } : { 'metadata[intentId]': input.intentId };
  const session = await stripeRequest('/checkout/sessions', {
    mode: 'payment',
    'line_items[0][quantity]': 1,
    'line_items[0][price_data][currency]': BILLING_CURRENCY.toLowerCase(),
    'line_items[0][price_data][unit_amount]': input.amountMinor,
    'line_items[0][price_data][product_data][name]': input.chargeId ? 'CONSTRUX subscription' : 'CONSTRUX prepaid AI credit',
    'line_items[0][price_data][product_data][description]': input.chargeId
      ? (input.description ?? 'One month of the platform. The period’s AI allowance is credited when this settles.')
      : 'Credit added to your AI wallet and drawn down as engines run.',
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    customer_email: input.customerEmail,
    'metadata[tenantId]': input.tenantId,
    ...target,
    // Belt and braces on Stripe's own side: a retried create with the same key
    // returns the same session rather than opening a second one.
    'payment_intent_data[metadata][tenantId]': input.tenantId,
    ...(input.chargeId
      ? { 'payment_intent_data[metadata][chargeId]': input.chargeId }
      : { 'payment_intent_data[metadata][intentId]': input.intentId }),
  });

  const url = session.url;
  if (typeof url !== 'string' || typeof session.id !== 'string') {
    throw new DomainError('STRIPE_ERROR', 'Stripe returned a checkout session with no URL', 502);
  }
  return { id: session.id, url };
}

// ------------------------------------------------------------------ webhooks

export type StripeEvent = {
  id: string;
  type: string;
  livemode: boolean;
  data: { object: Record<string, unknown> };
};

/**
 * Verify a webhook and parse it, or refuse.
 *
 * The order matters and is not negotiable: signature first, over the raw bytes,
 * before anything in the body is read. Parsing first and verifying afterwards
 * is how a forged payload gets to influence the code that decides whether to
 * trust it.
 */
export function verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined, now = Date.now()): StripeEvent {
  if (!stripeConfigured()) {
    reject(new DomainError('STRIPE_UNCONFIGURED', 'Stripe is not configured on this deployment', 503));
  }
  if (!signatureHeader) {
    reject(new DomainError('STRIPE_SIGNATURE_MISSING', 'No Stripe signature on the request', 400));
  }

  // `t=1700000000,v1=abc...,v1=def...` — more than one v1 during a secret
  // rotation, and any of them matching is a valid signature.
  const parts = signatureHeader.split(',').map((part) => part.trim().split('='));
  const timestamp = parts.find(([key]) => key === 't')?.[1];
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value ?? '');

  if (!timestamp || signatures.length === 0) {
    reject(new DomainError('STRIPE_SIGNATURE_MALFORMED', 'The Stripe signature header could not be parsed', 400));
  }

  // The tolerance window is what stops a captured webhook being replayed a
  // month later. The signature would still be valid — it is over bytes that
  // have not changed — so time is the only thing that makes it stale.
  const age = Math.abs(now / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) {
    reject(new DomainError(
      'STRIPE_SIGNATURE_STALE',
      `The Stripe signature is ${Math.round(age)}s out of date, beyond the ${SIGNATURE_TOLERANCE_SECONDS}s tolerance`,
      400,
    ));
  }

  const expected = createHmac('sha256', config.stripe.webhookSecret)
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest('hex');

  const matched = signatures.some((candidate) => {
    // Length first: `timingSafeEqual` throws on a mismatch rather than
    // returning false, and a thrown comparison is a leak of a different kind.
    const a = Buffer.from(candidate, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  });

  if (!matched) {
    reject(new DomainError(
      'STRIPE_SIGNATURE_INVALID',
      'The Stripe signature does not match. This request did not come from Stripe.',
      400,
    ));
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody.toString('utf8')) as StripeEvent;
  } catch {
    reject(new DomainError('STRIPE_PAYLOAD_INVALID', 'The Stripe payload is not valid JSON', 400));
  }

  // Live and test money are different money. A production deployment that
  // accepted test events would credit real accounts from fake payments, and
  // Stripe test keys are free to anybody who signs up.
  if (config.env === 'production' && event.livemode !== true) {
    reject(new DomainError(
      'STRIPE_TEST_EVENT',
      'A test-mode Stripe event was delivered to a production deployment and was refused.',
      400,
    ));
  }

  health.accepted += 1;
  health.lastAcceptedAt = new Date().toISOString();
  return event;
}

/** What a paid event says, once it has been verified. */
export type SettledPayment = {
  reference: string;
  tenantId: string;
  intentId?: string;
  /** The subscription charge the session paid, when it paid one rather than a top-up. */
  chargeId?: string;
  amountMinor: number;
  currency: string;
};

/**
 * The event types that mean money arrived.
 *
 * Deliberately only the checkout session, and deliberately *not*
 * `payment_intent.succeeded`. One card payment through Stripe Checkout raises
 * both, with two different event ids and the same money behind them — keying
 * the credit on the event would credit a single payment twice. One payment,
 * one event type, one credit.
 *
 * The asynchronous sibling is here because some methods settle after the
 * session closes. Without it a bank debit would complete unpaid, never be
 * revisited, and the customer would have paid for nothing.
 */
const SETTLEMENT_EVENTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);

/**
 * Read a settled payment out of a verified event, or `undefined` for the events
 * that are not one.
 *
 * Stripe delivers dozens of event types and most of them are not money. Anything
 * unrecognised returns `undefined` and the caller answers 200 — acknowledging an
 * event is not the same as acting on it, and a non-2xx would have Stripe retry
 * something we were never going to process.
 */
export function settledPayment(event: StripeEvent): SettledPayment | undefined {
  if (!SETTLEMENT_EVENTS.has(event.type)) return undefined;

  const object = event.data.object;
  const metadata = (object.metadata ?? {}) as Record<string, string | undefined>;

  // The amount is read from the object Stripe signed. It is never taken from
  // the request that opened the checkout: a customer choosing what to pay is
  // fine, a customer choosing what they are credited is not.
  const amountMinor = typeof object.amount_total === 'number' ? object.amount_total : undefined;
  const currency = typeof object.currency === 'string' ? object.currency : undefined;
  const tenantId = metadata.tenantId;

  if (!tenantId || amountMinor === undefined || !currency) return undefined;

  // A checkout session can complete unpaid — an asynchronous method still
  // clearing, a card declined at the last step. Crediting on completion rather
  // than on payment would hand out AI against money that never arrived.
  if (object.payment_status !== 'paid') return undefined;

  if (currency.toUpperCase() !== BILLING_CURRENCY) {
    throw new DomainError(
      'STRIPE_CURRENCY_MISMATCH',
      `Stripe settled ${currency.toUpperCase()} against a platform that prices in ${BILLING_CURRENCY}. ` +
        'Crediting minor units across currencies would credit the wrong amount.',
      400,
    );
  }

  // The reference identifies the *payment*, not the notification. The payment
  // intent is the one id that stays the same however many events a single sale
  // raises and however many times each is redelivered, so it is what makes
  // `creditFromPayment` spend one payment once. The session id is the fallback
  // for the free-of-charge case, where there is no intent and no money either.
  const paymentIntent = typeof object.payment_intent === 'string' ? object.payment_intent : undefined;
  const reference = paymentIntent ? `stripe:${paymentIntent}` : `stripe:session:${String(object.id)}`;

  return {
    reference,
    tenantId,
    ...(metadata.intentId ? { intentId: metadata.intentId } : {}),
    ...(metadata.chargeId ? { chargeId: metadata.chargeId } : {}),
    amountMinor,
    currency: currency.toUpperCase(),
  };
}
