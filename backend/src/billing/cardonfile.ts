import { ulid } from '../core/ids.ts';
import type { Platform } from '../platform.ts';
import type { Collector } from './collection.ts';
import { PACKAGES, type PackageTier } from './seats.ts';
import * as stripe from './stripe.ts';

/**
 * The card a company keeps with us, and the collector that charges it.
 *
 * The activation popup records a mandate — *I authorise CONSTRUX to collect
 * £X today and the same amount each month by card, until I cancel* — and until
 * this file nothing collected against it: `attemptCollection` asked the
 * configured collector and the default answered "no payment method is held".
 * Now, on a deployment with Stripe keyed, the first month paid by card
 * checkout under a recurring-card mandate is paid with a card Stripe keeps,
 * the webhook reads which card that was, and the monthly cycle charges it
 * off-session. The mandate is the authorisation; this is the rail.
 *
 * **What is kept, and what is not.** A Stripe customer id, a Stripe payment
 * method id, the card's brand, its last four digits and its expiry. Never a
 * number, never a CVC: those never reach this process, because the customer
 * typed them into Stripe's page, not ours. The record is on the chain under
 * the tenancy's governance project like the mandate, at commercial
 * sensitivity, so who saved a card and who removed it is on the same record
 * as who authorised the collection.
 *
 * **What a decline does.** A card declined, expired or needing the customer
 * present (strong customer authentication) is not a payment. The collector
 * answers `settled: false` with the reason, the cycle records the attempt on
 * the charge exactly as it did for "no payment method", the grace period
 * runs, and the customer pays in person from ACU & Billing or the tenancy
 * stops at the end of the grace as it always has. Nothing is retried in a
 * loop: one attempt per charge per cycle, and Stripe's own idempotency key on
 * the charge means a retried run can never take a month twice.
 */

export type CardOnFile = {
  id: string;
  tenantId: string;
  /** The Stripe customer the card belongs to. */
  customerId: string;
  /** The Stripe payment method. The only thing that can charge the card, and it lives at Stripe. */
  paymentMethodId: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  /** The mandate this card was saved under, where one was in force. */
  mandateId?: string;
  savedAt: string;
  /** The Stripe reference of the payment that saved it. */
  savedFrom: string;
  status: 'ACTIVE' | 'REMOVED';
  removedAt?: string;
  removedBy?: string;
  removedReason?: string;
};

function commit(platform: Platform, eventType: 'CARD_ON_FILE_SAVED' | 'CARD_ON_FILE_REMOVED', card: CardOnFile, actor: { refType: 'User' | 'System'; refId: string }): void {
  platform.ledger.commit({
    tenantId: card.tenantId,
    projectId: `${card.tenantId}-governance`,
    actor,
    source: actor.refType === 'System' ? 'SYSTEM' : 'WEB',
    correlationId: ulid(),
    eventType,
    entity: { refType: 'CardOnFile', refId: card.id },
    nextState: { ...card },
  });
}

/** The card in force for a tenancy, or null. */
export function cardOnFile(platform: Platform, tenantId: string): CardOnFile | null {
  return (
    platform.ledger
      .listByTenant(tenantId, 'CardOnFile')
      .map((record) => record.state as unknown as CardOnFile)
      .filter((card) => card.status === 'ACTIVE')
      .sort((a, b) => a.savedAt.localeCompare(b.savedAt))
      .at(-1) ?? null
  );
}

/** What the customer and the operator may see of it: never the ids. */
export function cardSummary(card: CardOnFile | null): { brand: string; last4: string; expMonth: number; expYear: number; savedAt: string } | null {
  if (!card) return null;
  return { brand: card.brand, last4: card.last4, expMonth: card.expMonth, expYear: card.expYear, savedAt: card.savedAt };
}

/**
 * Keep the card. A card already on file is removed as superseded, so there is
 * one at a time; the same method saved twice — a webhook redelivered — is a
 * no-op rather than a second record.
 */
export function saveCardOnFile(
  platform: Platform,
  input: { tenantId: string; customerId: string; paymentMethodId: string; card: stripe.CardSummary; mandateId?: string; savedFrom: string },
  now = new Date(),
): { card: CardOnFile; alreadySaved: boolean } {
  const existing = cardOnFile(platform, input.tenantId);
  if (existing && existing.paymentMethodId === input.paymentMethodId) return { card: existing, alreadySaved: true };
  if (existing) {
    commit(platform, 'CARD_ON_FILE_REMOVED', { ...existing, status: 'REMOVED', removedAt: now.toISOString(), removedBy: 'stripe', removedReason: 'Superseded by a newer card' }, { refType: 'System', refId: 'stripe' });
  }
  const card: CardOnFile = {
    id: ulid(),
    tenantId: input.tenantId,
    customerId: input.customerId,
    paymentMethodId: input.paymentMethodId,
    brand: input.card.brand,
    last4: input.card.last4,
    expMonth: input.card.expMonth,
    expYear: input.card.expYear,
    ...(input.mandateId ? { mandateId: input.mandateId } : {}),
    savedAt: now.toISOString(),
    savedFrom: input.savedFrom,
    status: 'ACTIVE',
  };
  commit(platform, 'CARD_ON_FILE_SAVED', card, { refType: 'System', refId: 'stripe' });
  return { card, alreadySaved: false };
}

/**
 * Forget the card: on the record now, and at Stripe when it answers. Called
 * when the mandate is cancelled, because a card kept after the authorisation
 * to charge it has gone is a card kept for nothing.
 */
export async function removeCardOnFile(
  platform: Platform,
  tenantId: string,
  actor: { refType: 'User' | 'System'; refId: string },
  reason: string,
  now = new Date(),
): Promise<{ removed: boolean; detached: boolean }> {
  const existing = cardOnFile(platform, tenantId);
  if (!existing) return { removed: false, detached: false };
  commit(platform, 'CARD_ON_FILE_REMOVED', { ...existing, status: 'REMOVED', removedAt: now.toISOString(), removedBy: actor.refId, removedReason: reason }, actor);
  const detached = stripe.stripeConfigured() ? await stripe.detachPaymentMethod(existing.paymentMethodId) : false;
  return { removed: true, detached };
}

/**
 * The collector the monthly cycle installs where Stripe is keyed. It answers
 * exactly like the default where no card is held, so a tenancy that never
 * saved one is treated as it always was.
 */
export function stripeCollector(platform: Platform): Collector {
  return async (input) => {
    const card = cardOnFile(platform, input.tenantId);
    if (!card) {
      return { settled: false, because: 'No payment method is held for this tenancy, so nothing can be taken automatically' };
    }
    const charge = platform.ledger.get({ refType: 'SubscriptionCharge', refId: input.chargeId });
    const pkg = charge ? PACKAGES[charge.state.package as PackageTier] : undefined;
    const period = charge ? String(charge.state.periodStart ?? '').slice(0, 10) : '';
    const outcome = await stripe.chargeOffSession({
      customerId: card.customerId,
      paymentMethodId: card.paymentMethodId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      tenantId: input.tenantId,
      chargeId: input.chargeId,
      description: `CONSTRUX ${pkg?.label ?? 'subscription'}${period ? ` — the period from ${period}` : ''}`,
    });
    if (outcome.succeeded) {
      return { settled: true, reference: `stripe:${outcome.paymentIntentId}`, amountMinor: input.amountMinor };
    }
    return { settled: false, because: `${card.brand} •••• ${card.last4}: ${outcome.because}` };
  };
}
