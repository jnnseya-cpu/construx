import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { groupOfTenant } from '../group/directory.ts';
import { primaryCompanyOf } from '../group/onboarding.ts';
import type { AuthContext } from '../identity/auth.ts';
import type { Platform } from '../platform.ts';
import * as collection from './collection.ts';
import { PACKAGES } from './seats.ts';
import { stripeConfigured } from './stripe.ts';
import { BILLING_CURRENCY } from './payments.ts';

/**
 * How a paying account agrees to be collected from, going forward.
 *
 * Asked for as the popup every paid account sees once subscribed: *Activate
 * <company>'s subscription — pay the first month upfront, then it renews each
 * month until you cancel*, followed by *How will you pay, going forward?* —
 * Direct Debit or a recurring card — and an authorisation sentence the person
 * ticks. The authorisation is a record: who, when, which method, how much a
 * month, in which words, for which company. It is what a Direct Debit or card
 * rail collects against once one is connected.
 *
 * **What is and is not built, stated so the popup cannot imply otherwise.**
 * The record is real and replayable. Collection is not: this deployment holds
 * no card and has no Direct Debit rail, so `attemptCollection` still answers
 * "no payment method is held" and the first month is paid by card checkout
 * (where Stripe is configured) or by transfer against the `CX-` reference,
 * recorded by the operator. `rails` on the position says exactly which of the
 * three the deployment can take, and the popup reads it rather than promising.
 */

export type MandateMethod = 'DIRECT_DEBIT' | 'RECURRING_CARD';

export type PaymentMandate = {
  id: string;
  tenantId: string;
  method: MandateMethod;
  /** The legal entity the person confirmed they may set up payments for. */
  companyName: string;
  /** The monthly amount at authorisation, in pence of the billing currency. */
  amountMinor: number;
  currency: string;
  /** The exact sentence the person agreed to. */
  wording: string;
  authorisedBy: string;
  authorisedByName: string;
  authorisedAt: string;
  status: 'AUTHORISED' | 'CANCELLED';
  cancelledAt?: string;
  cancelledBy?: string;
  cancelReason?: string;
};

const PLATFORM_NAME = 'CONSTRUX';

export const METHOD_LABEL: Record<MandateMethod, string> = {
  DIRECT_DEBIT: 'Direct Debit (BACS)',
  RECURRING_CARD: 'Recurring card',
};

function pounds(minor: number): string {
  return `£${(minor / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The sentence the person agrees to, word for word, for the record. */
export function mandateWording(method: MandateMethod, companyName: string, amountMinor: number): string {
  const by = method === 'DIRECT_DEBIT' ? 'direct debit' : 'card';
  return (
    `I authorise ${PLATFORM_NAME} to collect ${pounds(amountMinor)} today and the same amount each month by ${by}, until I cancel. ` +
    `I confirm I’m authorised to set up payments for ${companyName}.`
  );
}

/** Every mandate a tenancy has ever authorised, oldest first. Read from the record. */
export function mandates(platform: Platform, tenantId: string): PaymentMandate[] {
  return platform.ledger
    .listByTenant(tenantId, 'PaymentMandate')
    .map((record) => record.state as unknown as PaymentMandate)
    .sort((a, b) => a.authorisedAt.localeCompare(b.authorisedAt));
}

/** The mandate in force, or null. */
export function currentMandate(platform: Platform, tenantId: string): PaymentMandate | null {
  return mandates(platform, tenantId).filter((mandate) => mandate.status === 'AUTHORISED').at(-1) ?? null;
}

export type ActivationPosition = {
  /** Whether this account has a subscription to activate: paid, not covered by a group, not granted free, not cancelled. */
  required: boolean;
  reason: string;
  companyName: string;
  packageLabel: string;
  monthlyPriceMinor: number;
  currency: string;
  status: string;
  /** The first period owed, when one is: what "pay your first month upfront" points at. */
  firstCharge: { id: string; amountMinor: number; dueAt: string; paymentReference: string } | null;
  /** Which rails this deployment can actually take. */
  rails: { card: boolean; directDebit: boolean; bankTransfer: boolean };
  mandate: PaymentMandate | null;
  wording: Record<MandateMethod, string>;
};

export function activationPosition(platform: Platform, tenantId: string): ActivationPosition {
  const tenant = platform.tenant(tenantId);
  const subscription = platform.subscription(tenantId);
  const pkg = PACKAGES[subscription.package];
  const group = groupOfTenant(platform, tenantId);
  // A company of a group is covered by the primary's subscription; the primary
  // itself holds that subscription, so a free grant on it is the operator's.
  const covered = group !== undefined && subscription.grantedFree === true && primaryCompanyOf(platform, group)?.tenantId !== tenantId;
  const monthlyPriceMinor = subscription.grantedFree ? 0 : pkg.monthlyPriceMinor;
  const due = collection.outstanding(platform, tenantId).sort((a, b) => a.periodStart.localeCompare(b.periodStart))[0];

  let required = true;
  let reason = `${pkg.label} is ${pounds(monthlyPriceMinor)} a month, collected today and each month until cancelled.`;
  if (subscription.status === 'CANCELLED') {
    required = false;
    reason = 'The subscription is cancelled; nothing is collected.';
  } else if (covered) {
    required = false;
    reason = `${tenant.legalName} is a company of ${group!.displayName} and is covered by its subscription; nothing is collected from it.`;
  } else if (subscription.grantedFree) {
    required = false;
    reason = 'The package is granted free of charge; nothing is collected.';
  } else if (monthlyPriceMinor <= 0) {
    required = false;
    reason = `${pkg.label} costs nothing a month; nothing is collected.`;
  }

  return {
    required,
    reason,
    companyName: tenant.legalName,
    packageLabel: pkg.label,
    monthlyPriceMinor,
    currency: BILLING_CURRENCY,
    status: subscription.status,
    firstCharge: due ? { id: due.id, amountMinor: due.amountMinor, dueAt: due.dueAt, paymentReference: `CX-${due.id.slice(-8).toUpperCase()}` } : null,
    rails: { card: stripeConfigured(), directDebit: false, bankTransfer: true },
    mandate: currentMandate(platform, tenantId),
    wording: {
      DIRECT_DEBIT: mandateWording('DIRECT_DEBIT', tenant.legalName, monthlyPriceMinor),
      RECURRING_CARD: mandateWording('RECURRING_CARD', tenant.legalName, monthlyPriceMinor),
    },
  };
}

function commit(platform: Platform, actor: AuthContext, eventType: 'PAYMENT_MANDATE_AUTHORISED' | 'PAYMENT_MANDATE_CANCELLED', mandate: PaymentMandate): void {
  platform.ledger.commit({
    tenantId: mandate.tenantId,
    projectId: `${mandate.tenantId}-governance`,
    actor: { refType: 'User', refId: actor.actorId },
    source: 'WEB',
    correlationId: ulid(),
    eventType,
    entity: { refType: 'PaymentMandate', refId: mandate.id },
    nextState: { ...mandate },
  });
}

/**
 * Record the person's authorisation. The sentence is composed here from the
 * method, the company and the price on the record — never taken from the
 * request — so what is recorded is what the platform showed. A mandate already
 * in force is cancelled as superseded, so there is one at a time.
 */
export function authoriseMandate(platform: Platform, actor: AuthContext, input: { method: MandateMethod; authorised: boolean; companyName?: string }): PaymentMandate {
  const position = activationPosition(platform, actor.tenantId);
  if (!input.authorised) {
    throw new DomainError('AUTHORISATION_REQUIRED', 'Tick the authorisation to set up the payment method. Nothing is recorded without it.', 422);
  }
  if (!position.required) {
    throw new DomainError('NOTHING_TO_COLLECT', position.reason, 409);
  }
  const companyName = (input.companyName?.trim() || position.companyName).slice(0, 200);
  const person = platform.user(actor.actorId);
  const existing = currentMandate(platform, actor.tenantId);
  if (existing) {
    commit(platform, actor, 'PAYMENT_MANDATE_CANCELLED', {
      ...existing,
      status: 'CANCELLED',
      cancelledAt: new Date().toISOString(),
      cancelledBy: actor.actorId,
      cancelReason: `Superseded by a ${METHOD_LABEL[input.method]} authorisation`,
    });
  }
  const mandate: PaymentMandate = {
    id: ulid(),
    tenantId: actor.tenantId,
    method: input.method,
    companyName,
    amountMinor: position.monthlyPriceMinor,
    currency: position.currency,
    wording: mandateWording(input.method, companyName, position.monthlyPriceMinor),
    authorisedBy: actor.actorId,
    authorisedByName: person.name,
    authorisedAt: new Date().toISOString(),
    status: 'AUTHORISED',
  };
  commit(platform, actor, 'PAYMENT_MANDATE_AUTHORISED', mandate);
  return mandate;
}

export function cancelMandate(platform: Platform, actor: AuthContext, reason: string): PaymentMandate {
  const existing = currentMandate(platform, actor.tenantId);
  if (!existing) throw new DomainError('NO_MANDATE', 'No payment method is authorised for this account.', 404);
  const cancelled: PaymentMandate = {
    ...existing,
    status: 'CANCELLED',
    cancelledAt: new Date().toISOString(),
    cancelledBy: actor.actorId,
    cancelReason: reason.trim(),
  };
  commit(platform, actor, 'PAYMENT_MANDATE_CANCELLED', cancelled);
  return cancelled;
}
