import { DomainError } from '../core/errors.ts';
import { config } from '../config.ts';

/**
 * Money entering the platform.
 *
 * This exists because it did not, and its absence was the largest financial
 * hole in the system. `POST /v1/billing/top-up` took an `amountMinor` from the
 * request body and credited the wallet with it. No payment provider, no
 * ceiling, callable by any tenant user holding `U` on `BILLING_ACU` — and the
 * console shipped a button that did exactly that for £1,000 a press. Every ACU
 * spent from that credit bought real provider compute with real money. One
 * request was unlimited AI, for free, for anybody who read the network tab.
 *
 * ---
 *
 * **A wallet is credited by a receipt, never by a request.** A customer asking
 * to top up creates an intent and nothing else; credit appears when money has
 * actually been received, and only the platform operator — or, when one is
 * wired, a payment provider's webhook — can say that it has.
 *
 * **A payment reference is spent once.** The reference is the idempotency key
 * for money, and it is checked against every receipt ever recorded rather than
 * against a cache with a TTL. A webhook that fires twice, an operator who
 * presses the button again, a retry after a timeout: all of them are the same
 * payment, and the second one credits nothing.
 *
 * **Every amount has a ceiling.** Not because a large payment is suspicious,
 * but because an unbounded integer from an external system is a typo away from
 * crediting a number nobody meant, and on an append-only ledger that is not
 * something anybody can quietly undo.
 */

export type PaymentMethod =
  | 'CARD'
  | 'MOBILE_MONEY'
  | 'BANK_TRANSFER'
  | 'INVOICE_SETTLEMENT'
  | 'CREDIT_NOTE'
  | 'MANUAL_ADJUSTMENT';

/**
 * What was actually paid, when it was not paid in the billing currency.
 *
 * The wallet holds GBP and always will. A mobile-money rail settles in dollars,
 * so a conversion happens — and a conversion that leaves no trace is a number
 * nobody can check. Recording the settled amount, its currency and the rate
 * applied means any credit can be recomputed from its own receipt, years later,
 * without knowing what the configured rate happened to be that day.
 */
export type SettlementFx = {
  settledCurrency: string;
  settledAmountMinor: number;
  /** Units of the settled currency per one unit of the billing currency. */
  ratePerBillingUnit: number;
};

/** A request to add credit. Carries no money and moves no balance. */
export type TopUpIntent = {
  id: string;
  tenantId: string;
  amountMinor: number;
  currency: string;
  requestedBy: string;
  requestedAt: string;
  status: 'AWAITING_PAYMENT' | 'SETTLED' | 'CANCELLED';
  /** Set when a receipt settles it. */
  receiptId?: string;
  /**
   * The rate quoted when this intent was created, for a rail that settles in
   * another currency.
   *
   * Held on the intent so the customer gets what they were quoted. If the
   * operator moves the configured rate while somebody is mid-payment, settling
   * at the new rate would credit an amount they never agreed to — in whichever
   * direction the market moved.
   */
  quotedFx?: { currency: string; amountMinor: number; ratePerBillingUnit: number };
};

/** Proof that money arrived. The only thing that may credit a wallet. */
export type PaymentReceipt = {
  id: string;
  tenantId: string;
  amountMinor: number;
  currency: string;
  method: PaymentMethod;
  /**
   * The provider's or bank's own identifier for this payment. Unique across the
   * platform for ever — this is what makes a replayed webhook harmless.
   */
  reference: string;
  /** The intent this settles, when it settles one. A direct credit has none. */
  intentId?: string;
  recordedBy: string;
  recordedAt: string;
  note?: string;
  /**
   * Set when the money arrived in a currency other than the billing one.
   * `amountMinor` above is always the billing currency; this says what was
   * actually handed over and at what rate it was converted.
   */
  fx?: SettlementFx;
};

/**
 * The largest single credit the platform will accept.
 *
 * A guard against a typo or a malformed webhook, not against a large customer:
 * a genuine payment above this is recorded as several receipts, each with its
 * own reference, which is also what an auditor would rather see.
 */
export function maximumCreditMinor(): number {
  return config.billing.maximumCreditMinor;
}

/**
 * Check an amount before it becomes money.
 *
 * Integer, positive, and inside the ceiling. Non-integer minor units are the
 * classic route to a fractional balance that then rounds differently in two
 * places; `Number.isSafeInteger` rather than `isInteger` because arithmetic
 * beyond 2^53 stops being exact and a balance that cannot be added up is worse
 * than one that is merely wrong.
 */
export function assertCreditableAmount(amountMinor: number): void {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new DomainError(
      'PAYMENT_INVALID_AMOUNT',
      'A payment amount must be a positive whole number of minor units',
    );
  }
  if (amountMinor > maximumCreditMinor()) {
    throw new DomainError(
      'PAYMENT_AMOUNT_TOO_LARGE',
      `A single payment may not exceed ${maximumCreditMinor()} minor units. ` +
        'Record a larger settlement as several receipts, each with its own reference.',
    );
  }
}

/**
 * The one currency every published price is quoted in.
 *
 * Every `monthlyPriceMinor` in `seats.ts` is a bare integer — 95,000 for Core
 * Project — and "minor units" is not a fixed exponent. Signup let the customer
 * choose any currency the platform counts in, and nothing converted anything,
 * so the same integer meant a different amount of money depending on what they
 * picked:
 *
 *   GBP (exponent 2)   95,000 minor  =  £950
 *   JPY (exponent 0)   95,000 minor  =  ¥95,000   ≈ £490
 *   KWD (exponent 3)   95,000 minor  =  95 KWD    ≈ £245
 *
 * A quarter price for the identical package, selectable from a dropdown on the
 * signup form. The ACU wallet is worse, because one ACU is one minor unit: a
 * hundred thousand minor units buys a hundred thousand ACUs whatever the
 * currency, so the same AI cost 100 KWD instead of £1,000 — roughly cost, which
 * erases the entire markup.
 *
 * So prices are denominated, once, here. A tenancy still records the currency
 * it works in — a project in Riyadh reports in riyals, and that is correct and
 * unaffected — but what the platform charges is quoted in this one and is not
 * a function of what the customer selected.
 */
export const BILLING_CURRENCY = 'GBP';

/**
 * Refuse a billing period that has not happened.
 *
 * Issuing an invoice credits that period's AI allowance, so a period is worth
 * money. The route took one straight from the request body and only the wallet's
 * per-period guard stood behind it — which stops the *same* period twice and
 * says nothing about a different one. A loop from 2020-01 to 2030-12 minted a
 * hundred and thirty-two months of allowance at twenty per cent of the plan
 * price each.
 *
 * Two bounds, and both are needed. Not in the future, because a month that has
 * not happened cannot have been consumed. Not before the subscription started,
 * because a customer who signed up last week did not have a plan in 2019.
 */
export function assertBillablePeriod(period: string, subscriptionStartedAt: string, now = new Date()): void {
  if (!/^\d{4}-\d{2}$/.test(period)) {
    throw new DomainError('INVOICE_PERIOD_INVALID', 'A billing period must be written as YYYY-MM');
  }

  const month = Number(period.slice(5, 7));
  if (month < 1 || month > 12) {
    throw new DomainError('INVOICE_PERIOD_INVALID', `${period} is not a month`);
  }

  // String comparison rather than date arithmetic: `YYYY-MM` sorts
  // lexicographically in the same order it sorts chronologically, and building
  // Date objects here would drag a timezone into a question that has none.
  const current = now.toISOString().slice(0, 7);
  if (period > current) {
    throw new DomainError(
      'INVOICE_PERIOD_FUTURE',
      `${period} has not happened yet. A period can only be billed once it has.`,
    );
  }

  const started = subscriptionStartedAt.slice(0, 7);
  if (period < started) {
    throw new DomainError(
      'INVOICE_PERIOD_BEFORE_SUBSCRIPTION',
      `${period} predates this subscription, which started in ${started}.`,
    );
  }
}

/**
 * A payment reference that can be relied on as an identity.
 *
 * Trimmed and bounded, because it becomes a uniqueness key held for the life of
 * the platform. Empty or whitespace-only is refused outright: a receipt with no
 * reference cannot be reconciled against a bank statement, and cannot stop the
 * same payment being credited twice — which is the entire job.
 */
export function normaliseReference(reference: string): string {
  const trimmed = reference.trim();
  if (trimmed.length < 4) {
    throw new DomainError(
      'PAYMENT_REFERENCE_REQUIRED',
      'A payment reference of at least four characters is required. It is what stops one payment being credited twice.',
    );
  }
  if (trimmed.length > 200) {
    throw new DomainError('PAYMENT_REFERENCE_TOO_LONG', 'A payment reference may not exceed 200 characters');
  }
  return trimmed;
}

/**
 * Convert a settled foreign amount into the billing currency.
 *
 * Both currencies here have two decimal places, which is the only reason this
 * is one division. It is deliberately not a general FX function: the exponent
 * differences that made `BILLING_CURRENCY` necessary in the first place would
 * need handling before this could take JPY or KWD, and writing that now would
 * be building for a requirement that does not exist.
 *
 * Rounded half-up rather than floored. Floor would shave a sub-penny off every
 * conversion in the platform's favour, which across enough payments is a
 * systematic under-credit of customers — small, deliberate-looking, and exactly
 * the sort of thing that is indefensible when somebody eventually adds it up.
 */
export function convertToBillingMinor(settledAmountMinor: number, ratePerBillingUnit: number): number {
  if (!Number.isFinite(ratePerBillingUnit) || ratePerBillingUnit <= 0) {
    throw new DomainError(
      'FX_RATE_INVALID',
      `A conversion rate of ${ratePerBillingUnit} cannot be used to credit a wallet. ` +
        'Set a positive rate before taking payments on this rail.',
      503,
    );
  }
  if (!Number.isSafeInteger(settledAmountMinor) || settledAmountMinor <= 0) {
    throw new DomainError('PAYMENT_INVALID_AMOUNT', 'A settled amount must be a positive whole number of minor units');
  }
  return Math.round(settledAmountMinor / ratePerBillingUnit);
}

/** The other direction: what to charge on the foreign rail for a billing-currency top-up. */
export function convertFromBillingMinor(billingAmountMinor: number, ratePerBillingUnit: number): number {
  if (!Number.isFinite(ratePerBillingUnit) || ratePerBillingUnit <= 0) {
    throw new DomainError(
      'FX_RATE_INVALID',
      `A conversion rate of ${ratePerBillingUnit} cannot be used to price a payment.`,
      503,
    );
  }
  return Math.round(billingAmountMinor * ratePerBillingUnit);
}
