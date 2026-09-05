import { config } from '../config.ts';
import { hashEvidence } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import type { Platform } from '../platform.ts';
import { PACKAGES, type PackageTier } from './seats.ts';
import { subscriptionPriceMinor } from '../group/agreement.ts';
import { purchasedBlocks } from './storage.ts';
import { monthlySubscriptionCharge, purchasedSeatChargeMinor } from './subscription.ts';
import type { Subscription } from './subscription.ts';

/**
 * Taking the monthly subscription, and stopping everything when it does not
 * arrive.
 *
 * `renewsAt` was set thirty days out at signup and moved by nothing. The
 * operator's forecast **warned** that a renewal was approaching;
 * `monthlySubscriptionCharge` could state what a period was worth; and no code
 * anywhere raised the charge, took the money, or noticed that it had not
 * arrived. A customer could sign up, use the platform for a year, and never be
 * asked for a penny — and the only signal was a warning nobody had to act on.
 *
 * The cycle here is four steps and each is a separate recorded fact, because
 * collapsing them is what makes a billing dispute unanswerable:
 *
 * 1. **Raise.** The period falls due; the charge is written with what is owed
 *    and when, and `renewsAt` advances. Raising is idempotent per period — a
 *    scheduler that fires twice must not bill twice.
 * 2. **Attempt.** Collection is tried against whatever can settle it.
 * 3. **Grace.** An unsettled charge is not an immediate stop. A card expires,
 *    a finance team is on holiday, a bank holds a transfer — cutting a customer
 *    off the hour a payment is late costs more than it saves.
 * 4. **Stop.** Past the grace window the subscription is suspended, and
 *    `standing()` closes writes, AI, top-up and export on the next request. The
 *    record stays readable, which is the same line drawn everywhere else here:
 *    what somebody recorded is theirs, and what they can *do* is what payment
 *    buys.
 *
 * ---
 *
 * **What is not built, stated plainly rather than implied.** There is no stored
 * payment method and no off-session charge: this platform holds no card. So
 * `attemptCollection` cannot debit anybody, and it does not pretend to — it
 * asks the configured collector, and the default collector answers *"no payment
 * method is held for this tenancy"*, which is the truth. What settles a charge
 * today is a payment recorded against it, which is what the Stripe webhook and
 * the operator's manual settlement both do.
 *
 * Everything after that point is real and enforced: the charge is raised
 * automatically, the clock runs, and the tenancy stops. Wiring a card is
 * replacing one function, not building the cycle.
 */

/** What a collection attempt did. */
export type CollectionOutcome =
  | { settled: true; reference: string; amountMinor: number }
  | { settled: false; because: string };

/**
 * How money is actually taken. Replaced when a card is on file.
 *
 * A port rather than a branch, so the day a payment method exists there is one
 * function to write and nothing in the cycle to change.
 */
export type Collector = (input: {
  tenantId: string;
  chargeId: string;
  amountMinor: number;
  currency: string;
}) => Promise<CollectionOutcome>;

/** The default: this platform holds no card, and says so. */
export const NO_PAYMENT_METHOD: Collector = async () => ({
  settled: false,
  because: 'No payment method is held for this tenancy, so nothing can be taken automatically',
});

let collector: Collector = NO_PAYMENT_METHOD;

/** Install a collector — a card processor, or a test double. */
export function setCollector(next: Collector): void {
  collector = next;
}

export type ChargeStatus = 'DUE' | 'SETTLED' | 'WRITTEN_OFF';

export type SubscriptionCharge = {
  id: string;
  tenantId: string;
  subscriptionId: string;
  package: string;
  amountMinor: number;
  currency: string;
  /** The period this covers, by its start. One charge per period, ever. */
  periodStart: string;
  dueAt: string;
  /** The day the tenancy stops if nothing has arrived. */
  graceEndsAt: string;
  status: ChargeStatus;
  raisedAt: string;
  attempts: Array<{ at: string; because: string }>;
  settledAt?: string;
  settlementReference?: string;
};

const DAY_MS = 86_400_000;
const governanceProject = (tenantId: string) => `${tenantId}-governance`;

/** Every charge on a tenancy, oldest first. */
export function chargesFor(platform: Platform, tenantId: string): SubscriptionCharge[] {
  return platform.ledger
    .listByTenant(tenantId, 'SubscriptionCharge')
    .map((record) => record.state as unknown as SubscriptionCharge)
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart));
}

/** Charges still owed. */
export function outstanding(platform: Platform, tenantId: string): SubscriptionCharge[] {
  return chargesFor(platform, tenantId).filter((charge) => charge.status === 'DUE');
}

/**
 * past_due (Enterprise / Group v1.0 §9.3): the oldest period whose due date
 * has passed while its grace period still runs. The tenancy is open; the day
 * it stops is on the record. Null while nothing is late, and null once the
 * grace has ended — that is the suspension `enforceUnpaid` applies, not a
 * warning about one.
 */
export function pastDue(
  charges: readonly SubscriptionCharge[],
  now = new Date(),
): { chargeId: string; periodStart: string; amountMinor: number; dueAt: string; graceEndsAt: string; daysLate: number } | null {
  const at = now.toISOString();
  const late = charges
    .filter((charge) => charge.status === 'DUE' && charge.dueAt < at && charge.graceEndsAt > at)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const oldest = late[0];
  if (!oldest) return null;
  return {
    chargeId: oldest.id,
    periodStart: oldest.periodStart,
    amountMinor: oldest.amountMinor,
    dueAt: oldest.dueAt,
    graceEndsAt: oldest.graceEndsAt,
    daysLate: Math.floor((now.getTime() - Date.parse(oldest.dueAt)) / DAY_MS),
  };
}

/**
 * Raise the charge for a period that has fallen due.
 *
 * Idempotent by period, not by call. A scheduler that fires twice in a minute,
 * or a deployment that replays, must not bill a customer twice — and "did we
 * already bill this period" is answerable from the record rather than from a
 * lock somebody has to remember to take.
 */
export function raiseCharge(
  platform: Platform,
  tenantId: string,
  now = new Date(),
): { charge: SubscriptionCharge; alreadyRaised: boolean } | undefined {
  const subscription = platform.subscription(tenantId);
  if (!subscription) return undefined;

  // Nothing to collect. A free trial is free, and a cancelled subscription has
  // already stopped — continuing to raise charges against it would build a
  // debt nobody agreed to.
  //
  // The whole recurring charge: the package, plus storage bought beyond it,
  // plus seats bought beyond it. This raised the package alone, so a tenancy
  // that had bought capacity was invoiced for it and never collected on it.
  // The invoice and the charge are computed from the same three parts now.
  // The package part is priced through the group's agreement where the
  // tenancy is a company of one (a rate-card discount is a term the group
  // approved); storage and seats bought beyond the package are at list.
  const amountMinor =
    subscription.status === 'ACTIVE'
      ? subscriptionPriceMinor(platform, tenantId, monthlySubscriptionCharge(subscription)).amountMinor +
        purchasedBlocks(platform.ledger, tenantId) * config.billing.storageBlockPriceMinor +
        purchasedSeatChargeMinor(platform.ledger, tenantId)
      : 0;
  if (amountMinor <= 0 || subscription.status === 'CANCELLED') return undefined;

  const periodStart = subscription.renewsAt;
  if (now.toISOString() < periodStart) return undefined;

  const existing = chargesFor(platform, tenantId).find((charge) => charge.periodStart === periodStart);
  if (existing) return { charge: existing, alreadyRaised: true };

  // The platform's own tenancy is not a customer.
  //
  // It exists from construction, before any `createTenant` call, so it has an
  // in-memory subscription and no `Subscription` entity in the ledger — and a
  // billing run that iterates every tenancy would otherwise raise a charge
  // against the company itself and, seven days later, suspend the platform for
  // not paying itself. The ledger record is what distinguishes a tenancy
  // somebody signed up for from the one the process was born with.
  if (!platform.ledger.get({ refType: 'Subscription', refId: subscription.id })) return undefined;

  const graceDays = config.billing.subscriptionGraceDays;
  const charge: SubscriptionCharge = {
    id: ulid(),
    tenantId,
    subscriptionId: subscription.id,
    package: subscription.package,
    amountMinor,
    currency: platform.tenant(tenantId).defaultCurrency,
    periodStart,
    dueAt: periodStart,
    graceEndsAt: new Date(Date.parse(periodStart) + graceDays * DAY_MS).toISOString(),
    status: 'DUE',
    raisedAt: now.toISOString(),
    attempts: [],
  };

  platform.ledger.commit({
    tenantId,
    projectId: governanceProject(tenantId),
    actor: { refType: 'System', refId: 'billing' },
    source: 'SYSTEM',
    correlationId: ulid(),
    eventType: 'SUBSCRIPTION_CHARGE_RAISED',
    entity: { refType: 'SubscriptionCharge', refId: charge.id },
    nextState: { ...charge },
  });

  // The period moves on whether or not the money arrives. A renewal date that
  // waited for payment would raise the same charge every day the customer was
  // late, and the debt would be the number of times the scheduler ran.
  platform.advanceRenewal(tenantId, new Date(Date.parse(periodStart) + 30 * DAY_MS).toISOString());

  return { charge, alreadyRaised: false };
}

/**
 * Raise the first period's charge, the moment a paid tenancy is created.
 *
 * A paid package used to be charged for the first time thirty days in: the
 * tenancy opened, ran for a month, and only then was asked for anything —
 * while its wallet had already been credited with a share of the price nobody
 * had paid. Nothing is free unless the package is, so the first month is owed
 * from the day the tenancy exists, and the tenancy's opening is what settling
 * it buys: a self-serve signup waits for it (`AWAITING_PAYMENT`), an operator-
 * provisioned customer runs on the same grace the renewals get.
 *
 * Idempotent by period, like `raiseCharge`: the period is the subscription's
 * own start, and a second call finds the charge already raised.
 */
export function raiseOpeningCharge(
  platform: Platform,
  tenantId: string,
  now = new Date(),
): { charge: SubscriptionCharge; alreadyRaised: boolean } | undefined {
  const subscription = platform.subscription(tenantId);
  if (!subscription || subscription.status === 'CANCELLED') return undefined;
  const amountMinor = subscriptionPriceMinor(platform, tenantId, PACKAGES[subscription.package].monthlyPriceMinor).amountMinor;
  if (amountMinor <= 0) return undefined;
  if (!platform.ledger.get({ refType: 'Subscription', refId: subscription.id })) return undefined;

  const periodStart = subscription.startedAt;
  const existing = chargesFor(platform, tenantId).find((charge) => charge.periodStart === periodStart);
  if (existing) return { charge: existing, alreadyRaised: true };

  const charge: SubscriptionCharge = {
    id: ulid(),
    tenantId,
    subscriptionId: subscription.id,
    package: subscription.package,
    amountMinor,
    currency: platform.tenant(tenantId).defaultCurrency,
    periodStart,
    dueAt: now.toISOString(),
    // A tenancy waiting to open has nothing to lose to a grace window — it is
    // not open — so its grace ends when it is due. One the operator opened on
    // agreed terms gets the same grace every renewal gets.
    graceEndsAt:
      subscription.status === 'AWAITING_PAYMENT'
        ? now.toISOString()
        : new Date(now.getTime() + config.billing.subscriptionGraceDays * DAY_MS).toISOString(),
    status: 'DUE',
    raisedAt: now.toISOString(),
    attempts: [],
  };

  platform.ledger.commit({
    tenantId,
    projectId: governanceProject(tenantId),
    actor: { refType: 'System', refId: 'billing' },
    source: 'SYSTEM',
    correlationId: ulid(),
    eventType: 'SUBSCRIPTION_CHARGE_RAISED',
    entity: { refType: 'SubscriptionCharge', refId: charge.id },
    nextState: { ...charge },
  });

  return { charge, alreadyRaised: false };
}

/** The period a charge covers, as the wallet keys its allowance: the day it starts. */
export function allowancePeriodOf(charge: Pick<SubscriptionCharge, 'periodStart'>): string {
  return charge.periodStart.slice(0, 10);
}

/** Try to take the money, and record what happened either way. */
export async function attemptCollection(
  platform: Platform,
  charge: SubscriptionCharge,
  now = new Date(),
): Promise<CollectionOutcome> {
  const outcome = await collector({
    tenantId: charge.tenantId,
    chargeId: charge.id,
    amountMinor: charge.amountMinor,
    currency: charge.currency,
  });

  if (outcome.settled) {
    settleCharge(platform, { chargeId: charge.id, reference: outcome.reference }, now);
    return outcome;
  }

  // Recorded rather than swallowed. A tenancy about to be suspended has to be
  // able to show what was tried and what it said — "we took your platform away"
  // with no attempt on the record is not a conversation anybody wins.
  const record = platform.ledger.require({ refType: 'SubscriptionCharge', refId: charge.id });
  platform.ledger.commit({
    tenantId: charge.tenantId,
    projectId: governanceProject(charge.tenantId),
    actor: { refType: 'System', refId: 'billing' },
    source: 'SYSTEM',
    correlationId: ulid(),
    eventType: 'SUBSCRIPTION_COLLECTION_FAILED',
    entity: { refType: 'SubscriptionCharge', refId: charge.id },
    nextState: {
      ...record.state,
      attempts: [...((record.state.attempts as SubscriptionCharge['attempts']) ?? []), { at: now.toISOString(), because: outcome.because }],
    },
  });

  return outcome;
}

/**
 * Record that a charge was paid.
 *
 * Called by the payment webhook, by an operator recording a bank transfer, and
 * by a collector that took the money. A suspended tenancy comes back here: the
 * money arriving is the only thing that should ever reverse a suspension for
 * non-payment, and doing it automatically means nobody has to be asked twice.
 */
export function settleCharge(
  platform: Platform,
  input: { chargeId: string; reference: string },
  now = new Date(),
): SubscriptionCharge {
  const record = platform.ledger.require({ refType: 'SubscriptionCharge', refId: input.chargeId });
  const charge = record.state as unknown as SubscriptionCharge;

  if (charge.status === 'SETTLED') {
    // A webhook retried after a timeout is not a fault, and refusing it would
    // make the provider keep retrying a payment that is already recorded.
    return charge;
  }

  const settled: SubscriptionCharge = {
    ...charge,
    status: 'SETTLED',
    settledAt: now.toISOString(),
    settlementReference: input.reference,
  };

  platform.ledger.commit({
    tenantId: charge.tenantId,
    projectId: governanceProject(charge.tenantId),
    actor: { refType: 'System', refId: 'billing' },
    source: 'SYSTEM',
    correlationId: ulid(),
    eventType: 'SUBSCRIPTION_CHARGE_SETTLED',
    entity: { refType: 'SubscriptionCharge', refId: charge.id },
    nextState: { ...settled },
  });

  // Paying for the period is what buys the period's AI allowance — twenty per
  // cent of the plan, credited here and nowhere else. It used to be credited
  // at creation and again whenever an invoice was issued, neither of which is
  // money arriving. Keyed by the period's start day, so a charge settled twice
  // (a retried webhook, an operator pressing again) credits once.
  // Twenty per cent of the *payment*: a company priced through its group's
  // agreement is credited against what it paid, not the list price.
  const pkg = PACKAGES[charge.package as PackageTier];
  if (pkg) platform.wallet(charge.tenantId).allocateFromSubscription(charge.amountMinor, allowancePeriodOf(charge));

  const subscription = platform.subscription(charge.tenantId);

  // A tenancy that was waiting for its first month opens now. Nothing else
  // opens it: not a top-up, not the operator's patience, not time.
  if (subscription?.status === 'AWAITING_PAYMENT') {
    platform.setSubscriptionStatus({
      tenantId: charge.tenantId,
      status: 'ACTIVE',
      reason: `First subscription period paid against ${charge.id} (${input.reference}); the tenancy opens`,
      decidedBy: 'billing:collection',
    });
  }

  // Back on, if nothing else is outstanding. A tenancy with two unpaid periods
  // that settles one has not caught up, and reinstating it there would let
  // somebody stay live for ever by always paying the oldest invoice.
  if (subscription?.status === 'SUSPENDED' && outstanding(platform, charge.tenantId).length === 0) {
    platform.setSubscriptionStatus({
      tenantId: charge.tenantId,
      status: 'ACTIVE',
      reason: `Payment received against ${charge.id} (${input.reference}); nothing further outstanding`,
      decidedBy: 'billing:collection',
    });
  }

  return settled;
}

/**
 * Write off a period nobody will now pay for.
 *
 * Called when a tenancy is closed with charges still owed. A closed tenancy's
 * unpaid month would otherwise sit on the register as money awaited for ever;
 * writing it off says, on the record, that the business has stopped waiting.
 * Settled charges are untouched — money that arrived stays arrived.
 */
export function writeOffCharge(platform: Platform, input: { chargeId: string; reason: string }, now = new Date()): SubscriptionCharge {
  const record = platform.ledger.require({ refType: 'SubscriptionCharge', refId: input.chargeId });
  const charge = record.state as unknown as SubscriptionCharge;
  if (charge.status !== 'DUE') return charge;
  const written: SubscriptionCharge = { ...charge, status: 'WRITTEN_OFF', attempts: [...charge.attempts, { at: now.toISOString(), because: `Written off: ${input.reason}` }] };
  platform.ledger.commit({
    tenantId: charge.tenantId,
    projectId: governanceProject(charge.tenantId),
    actor: { refType: 'System', refId: 'billing' },
    source: 'SYSTEM',
    correlationId: ulid(),
    eventType: 'SUBSCRIPTION_CHARGE_WRITTEN_OFF',
    entity: { refType: 'SubscriptionCharge', refId: charge.id },
    nextState: { ...written },
  });
  return written;
}

/**
 * Stop a tenancy whose grace window has run out.
 *
 * The suspension goes through the same governed path an operator's would —
 * evidence, a reason, a named decider — so "why is this account suspended" has
 * one answer in one place, whoever or whatever decided it.
 */
export function enforceUnpaid(platform: Platform, tenantId: string, now = new Date()): { suspended: boolean; because?: string } {
  const subscription = platform.subscription(tenantId);
  if (!subscription || subscription.status !== 'ACTIVE') return { suspended: false };

  const overdue = outstanding(platform, tenantId).filter((charge) => now.toISOString() > charge.graceEndsAt);
  if (overdue.length === 0) return { suspended: false };

  const oldest = overdue[0]!;
  const because =
    `${overdue.length} unpaid subscription period${overdue.length === 1 ? '' : 's'}. ` +
    `The oldest fell due on ${oldest.dueAt.slice(0, 10)} and its grace period ended on ${oldest.graceEndsAt.slice(0, 10)}.`;

  platform.setSubscriptionStatus({
    tenantId,
    status: 'SUSPENDED',
    reason: because,
    decidedBy: 'billing:collection',
  });

  return { suspended: true, because };
}

export type CollectionReport = {
  ranAt: string;
  raised: number;
  settled: number;
  failed: number;
  suspended: number;
  /** Named, because a run that suspended somebody is not a line in a log. */
  suspendedTenants: Array<{ tenantId: string; because: string }>;
};

/** One pass over every tenancy: raise what is due, try to collect, stop what is past grace. */
export async function runCollection(platform: Platform, now = new Date()): Promise<CollectionReport> {
  const report: CollectionReport = { ranAt: now.toISOString(), raised: 0, settled: 0, failed: 0, suspended: 0, suspendedTenants: [] };

  for (const tenant of platform.tenants()) {
    const raised = raiseCharge(platform, tenant.id, now);
    if (raised && !raised.alreadyRaised) {
      report.raised += 1;
      const outcome = await attemptCollection(platform, raised.charge, now);
      if (outcome.settled) report.settled += 1;
      else report.failed += 1;
    }

    const stopped = enforceUnpaid(platform, tenant.id, now);
    if (stopped.suspended) {
      report.suspended += 1;
      report.suspendedTenants.push({ tenantId: tenant.id, because: stopped.because! });
    }
  }

  return report;
}

/**
 * The timer.
 *
 * Hourly rather than daily, and the reason is the grace window rather than the
 * billing: a tenancy whose grace ended at 09:00 should not keep working until
 * midnight, and a customer who paid at 09:05 should not wait a day to get their
 * platform back.
 */
export function startCollectionSchedule(
  platform: Platform,
  onRun: (report: CollectionReport) => void = () => {},
): { stop: () => void } {
  if (!config.billing.collectionEnabled) return { stop: () => {} };

  const tick = async () => {
    try {
      const report = await runCollection(platform);
      if (report.raised > 0 || report.suspended > 0) onRun(report);
    } catch {
      // A failed pass must not take the timer down with it: the next hour is a
      // retry, and a dead scheduler is a platform nobody is billing.
    }
  };

  const timer = setInterval(() => void tick(), 3_600_000);
  // Never holds the process open. A deployment that cannot shut down because a
  // billing timer is pending is a deployment that gets killed rather than
  // stopped, halfway through a ledger write.
  timer.unref?.();

  return { stop: () => clearInterval(timer) };
}

/** Guard for a caller that hands us a charge id that is not one. */
export function requireCharge(platform: Platform, chargeId: string): SubscriptionCharge {
  const record = platform.ledger.get({ refType: 'SubscriptionCharge', refId: chargeId });
  if (!record) throw new DomainError('CHARGE_NOT_FOUND', `No subscription charge ${chargeId}`, 404);
  return record.state as unknown as SubscriptionCharge;
}

/** Kept for the evidence hash on a settlement recorded by hand. */
export const settlementEvidence = (charge: SubscriptionCharge, reference: string): string =>
  hashEvidence(JSON.stringify({ chargeId: charge.id, amountMinor: charge.amountMinor, reference }));

export type { Subscription };
