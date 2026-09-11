import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.ts';
import { DomainError } from '../core/errors.ts';
import {
  deliveryHealth,
  diagnose,
  recordAccepted,
  recordRefused,
  resetDelivery,
  secretShape,
  type SecretShape,
  type WebhookDiagnosis,
  type WebhookHealthRecord,
} from './webhookdelivery.ts';

/**
 * KODA — mobile money, as a second rail beside the card.
 *
 * Deliberately the same shape as `stripe.ts`: a JSON call out to create an
 * intent, a signed webhook back to say the money arrived, and
 * `Platform.creditFromPayment` as the single door into the wallet. Two rails,
 * one way in. A second provider that reached the balance by its own route would
 * be a second set of rules to get wrong.
 *
 * ---
 *
 * **The webhook is the whole attack surface, again.** Public, because KODA
 * holds no credential of ours, and it credits wallets. The signature is
 * `x-koda-signature`: HMAC-SHA256 of the raw body, hex, no timestamp. Checked
 * over the exact bytes received, in constant time, before the payload is read.
 *
 * **No timestamp means no tolerance window.** Stripe signs `t.body` so a stale
 * replay can be refused on age alone; KODA signs the body only, so an old
 * capture stays valid for ever. Replay is therefore stopped entirely by the
 * payment reference — KODA's own receipt id, spent exactly once by
 * `creditFromPayment`. That is the same defence Stripe redeliveries rely on, so
 * it is load-bearing there too; here it is the only one, which is worth knowing
 * before anybody relaxes it.
 *
 * **The wallet is in pounds and this rail settles in dollars.** The conversion
 * uses the rate quoted on the intent when the customer was shown a price, not
 * the rate in force when the webhook lands — otherwise moving
 * `KODA_USD_PER_GBP` mid-payment would credit somebody an amount they never
 * agreed to. Both figures and the rate go onto the receipt.
 */

/** Only this event means money. */
const SETTLEMENT_EVENT = 'payment.verified';

/**
 * The late sibling. KODA verifies some payments after the customer has gone —
 * an operator SMS that took ninety seconds to arrive. It is the same money and
 * must credit exactly the same way; dropping it would mean a customer who paid
 * on a slow network never receiving their credit.
 */
const LATE_SETTLEMENT_EVENT = 'payment.verified.late';

/** KODA prices in dollars for this integration. Its minor unit is cents. */
export const KODA_SETTLEMENT_CURRENCY = 'USD';

export function kodaConfigured(): boolean {
  return config.koda.secretKey !== '' && config.koda.webhookSecret !== '';
}

// ------------------------------------------------------------- delivery health

export type KodaWebhookHealth = WebhookHealthRecord;

export function kodaWebhookHealth(): KodaWebhookHealth {
  return deliveryHealth('MOBILE_MONEY');
}

export function resetKodaWebhookHealth(): void {
  resetDelivery('MOBILE_MONEY');
}

/**
 * The shape of the configured signing secret, with no prefix asserted: KODA
 * publishes no prefix for its signing secrets, and inventing one here would
 * report a correct secret as malformed. Length, padding and stray quotes are
 * checkable without knowing the format, and are the mistakes that matter.
 */
export function kodaWebhookSecretShape(): SecretShape {
  return secretShape(config.koda.webhookSecret);
}

/** What is wrong with the mobile-money webhook and what to do next, or that nothing is. */
export function kodaWebhookDiagnosis(): WebhookDiagnosis {
  return diagnose({
    rail: 'MOBILE_MONEY',
    configured: kodaConfigured(),
    shape: kodaWebhookSecretShape(),
    health: deliveryHealth('MOBILE_MONEY'),
  });
}

function reject(error: DomainError): never {
  recordRefused('MOBILE_MONEY', error.code);
  throw error;
}

// ------------------------------------------------------------------ requests

async function kodaRequest(path: string, body: unknown): Promise<Record<string, unknown>> {
  if (!kodaConfigured()) {
    throw new DomainError('KODA_UNCONFIGURED', 'Mobile money is not configured on this deployment', 503);
  }

  const response = await fetch(`${config.koda.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.koda.secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const detail =
      (payload.error as { message?: string } | undefined)?.message ??
      (typeof payload.message === 'string' ? payload.message : `HTTP ${response.status}`);
    throw new DomainError('KODA_ERROR', `KODA refused the request: ${detail}`, 502);
  }
  return payload;
}

/**
 * Open a mobile-money checkout for one top-up.
 *
 * The dollar amount is computed from the intent already on record and travels
 * to KODA; the customer chooses their operator and pays, never the amount.
 * `metadata` carries the tenancy and the intent so the webhook can match the
 * payment back without trusting anything that came through the browser.
 */
export async function createCheckout(input: {
  intentId: string;
  tenantId: string;
  amountMinorUsd: number;
  successUrl: string;
}): Promise<{ intentId: string; url: string }> {
  const created = await kodaRequest('/intents', {
    amount: input.amountMinorUsd,
    currency: KODA_SETTLEMENT_CURRENCY,
    operators: config.koda.operators,
    metadata: { tenantId: input.tenantId, intentId: input.intentId },
    success_url: input.successUrl,
  });

  const url = created.checkout_url;
  if (typeof url !== 'string') {
    throw new DomainError('KODA_ERROR', 'KODA returned an intent with no checkout URL', 502);
  }
  return { intentId: String(created.intent_id ?? ''), url };
}

// ------------------------------------------------------------------ webhooks

export type KodaEvent = {
  type: string;
  data: Record<string, unknown>;
};

/**
 * Verify a KODA webhook and parse it, or refuse.
 *
 * Signature first, over the raw bytes, before anything in the body is read —
 * the same order as Stripe and for the same reason: parsing first lets a forged
 * payload influence the code deciding whether to trust it.
 */
export function verifyKodaWebhook(rawBody: Buffer, signatureHeader: string | undefined): KodaEvent {
  // Counted, not thrown past the tally. An unconfigured rail refusing every
  // delivery is exactly the state the tally exists to make visible, and this
  // was the one refusal it could not see — the card rail already counted its
  // equivalent, so the two read differently for no reason.
  if (!kodaConfigured()) {
    reject(new DomainError('KODA_UNCONFIGURED', 'Mobile money is not configured on this deployment', 503));
  }
  if (!signatureHeader) {
    reject(new DomainError('KODA_SIGNATURE_MISSING', 'No KODA signature on the request', 400));
  }

  const expected = createHmac('sha256', config.koda.webhookSecret).update(rawBody).digest('hex');
  const supplied = Buffer.from(signatureHeader.trim(), 'utf8');
  const computed = Buffer.from(expected, 'utf8');

  // Length first: `timingSafeEqual` throws on a length mismatch rather than
  // returning false, and a thrown comparison leaks in a different way.
  if (supplied.length !== computed.length || !timingSafeEqual(supplied, computed)) {
    reject(
      new DomainError(
        'KODA_SIGNATURE_INVALID',
        'The KODA signature does not match. This request did not come from KODA.',
        400,
      ),
    );
  }

  let event: KodaEvent;
  try {
    event = JSON.parse(rawBody.toString('utf8')) as KodaEvent;
  } catch {
    reject(new DomainError('KODA_PAYLOAD_INVALID', 'The KODA payload is not valid JSON', 400));
  }

  recordAccepted('MOBILE_MONEY');
  return event;
}

export type KodaSettlement = {
  reference: string;
  tenantId: string;
  intentId?: string;
  settledAmountMinor: number;
  settledCurrency: string;
};

/**
 * Read a settled payment out of a verified event, or `undefined` for the events
 * that are not one.
 *
 * Anything unrecognised returns `undefined` and the route answers 200:
 * acknowledging a notification is not the same as acting on it, and a non-2xx
 * would have KODA retry something we were never going to process.
 */
export function kodaSettlement(event: KodaEvent): KodaSettlement | undefined {
  if (event.type !== SETTLEMENT_EVENT && event.type !== LATE_SETTLEMENT_EVENT) return undefined;

  const data = event.data ?? {};
  const metadata = (data.metadata ?? {}) as Record<string, string | undefined>;

  const amount = typeof data.amount === 'number' ? data.amount : undefined;
  const currency = typeof data.currency === 'string' ? data.currency : undefined;
  const tenantId = metadata.tenantId;
  // KODA's own receipt id. The reference has to identify the payment, and this
  // is the id that stays the same across a redelivery of the same verification.
  const receiptId = typeof data.receipt_id === 'string' ? data.receipt_id : undefined;

  if (!tenantId || amount === undefined || !currency || !receiptId) return undefined;

  if (currency.toUpperCase() !== KODA_SETTLEMENT_CURRENCY) {
    throw new DomainError(
      'KODA_CURRENCY_MISMATCH',
      `KODA settled ${currency.toUpperCase()} against an integration priced in ${KODA_SETTLEMENT_CURRENCY}. ` +
        'Converting minor units from the wrong currency would credit the wrong amount.',
      400,
    );
  }

  return {
    reference: `koda:${receiptId}`,
    tenantId,
    ...(metadata.intentId ? { intentId: metadata.intentId } : {}),
    settledAmountMinor: amount,
    settledCurrency: currency.toUpperCase(),
  };
}
