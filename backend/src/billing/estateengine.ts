import type { Platform, PlatformUser, Tenant } from '../platform.ts';
import { graceDays } from '../identity/erasure.ts';
import * as collection from './collection.ts';
import { PACKAGES } from './seats.ts';
import * as storage from './storage.ts';
import { purchasedSeats, type Subscription } from './subscription.ts';

/**
 * The estate read as a whole: whether every customer can run their tenancy,
 * whether what is owed is arriving, whether what is owed back has been paid,
 * and whether the register says what is live.
 *
 * `GET /v1/admin/tenants` lists tenancies one row at a time and the screen
 * around it carries every operator act — credit, package, status, close, delete,
 * settle a refund, resolve an exception, unfreeze a wallet. This module stands
 * back from the rows the way `growth/engine.ts` stands back from one partner:
 * which tenancies nobody can administer; which paid packages have waited past
 * their due date for a first payment; which running subscriptions are past due;
 * which customers are switched off but not closed; which wallets are frozen;
 * which finance exceptions are open; which refunds have been owed too long;
 * which closed tenancies are still on the register with nothing left to keep
 * them there; who is over their seats or out of storage; whose erasure fell due
 * and has not been carried out.
 *
 * Every check reads the record — the subscriptions, the charges, the receipts,
 * the identities, the wallets, the object store's meter. The score is the
 * weights of what passes and decides nothing: a suspension, a write-off, a
 * refund and an erasure each happen only by the act that records them, and
 * every act this module points at already has its door on the screen.
 *
 * Customers only. The platform's own tenancy and a demonstration are on the
 * register, marked, and read by none of these checks.
 */

export type EstateFinding = { check: string; ok: boolean; weight: number; detail: string };

/** A refund owed longer than this has been owed too long. */
export const REFUND_DAYS = 14;
/** A paid package that has waited this long past its first due date is a signup that did not convert. */
export const FIRST_PAYMENT_DAYS = 14;

const DAY_MS = 86_400_000;

function daysBetween(from: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(from)) / DAY_MS);
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function tenancies(count: number): string {
  return plural(count, 'tenancy', 'tenancies');
}

function pounds(minor: number): string {
  return (minor / 100).toFixed(2);
}

/**
 * A tenancy's storage position: what the package allows plus what was bought,
 * against what the volume actually holds.
 *
 * Assembled here rather than inside `storage.ts` because it needs three things
 * that live in three places — the subscription, the ledger and the object store
 * — and the storage module should not have to know how to reach any of them.
 * The estate route and the tenancy's own storage routes read this one function.
 */
export function storagePositionFor(platform: Platform, tenantId: string): storage.StoragePosition {
  return storage.storagePosition({
    tier: platform.subscription(tenantId).package,
    usedBytes: platform.evidence.usage(tenantId),
    purchasedBlocks: storage.purchasedBlocks(platform.ledger, tenantId),
  });
}

// --- One tenancy, read ----------------------------------------------------------

/** Everything the sweep needs about one customer tenancy, read once. */
export type TenancyRead = {
  tenant: Tenant;
  subscription: Subscription;
  /** Open: not closed and not deleted. Every commercial check reads open tenancies only. */
  open: boolean;
  people: PlatformUser[];
  activePeople: number;
  /** Administrators who can still sign in: active, holding ENTERPRISE_ADMIN, not erased. */
  administrators: number;
  charges: collection.SubscriptionCharge[];
  outstandingMinor: number;
  /**
   * The oldest period raised, due and unpaid on a running subscription, or null.
   * Inside its grace the tenancy is open and the day it stops is on the record
   * (`collection.pastDue`); past its grace the hourly run should already have
   * suspended it, and a tenancy still ACTIVE then is the estate's to notice.
   */
  latePeriod: { chargeId: string; periodStart: string; amountMinor: number; dueAt: string; graceEndsAt: string; daysLate: number; graceEnded: boolean } | null;
  /** The opening charge a paid package is waiting on, when the tenancy is still waiting. */
  openingCharge: collection.SubscriptionCharge | null;
  seatsUsed: number;
  /** null is unlimited. */
  seatsAllowed: number | null;
  storage: storage.StoragePosition;
  frozen: { reason: string; at: string } | null;
  lifetimeRevenueMinor: number;
  /** Identities whose grace period has ended and who are still not erased. */
  erasuresDue: number;
  /** A closed tenancy every identity of which is already erased, or whose closure is older than the grace period. */
  readyToDelete: boolean;
};

function latePeriod(subscription: Subscription, charges: readonly collection.SubscriptionCharge[], now: Date): TenancyRead['latePeriod'] {
  if (subscription.status !== 'ACTIVE') return null;
  const inGrace = collection.pastDue(charges, now);
  if (inGrace) return { ...inGrace, graceEnded: false };
  const at = now.toISOString();
  const oldest = charges
    .filter((charge) => charge.status === 'DUE' && charge.dueAt < at)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0];
  if (!oldest) return null;
  return {
    chargeId: oldest.id,
    periodStart: oldest.periodStart,
    amountMinor: oldest.amountMinor,
    dueAt: oldest.dueAt,
    graceEndsAt: oldest.graceEndsAt,
    daysLate: Math.floor((now.getTime() - Date.parse(oldest.dueAt)) / DAY_MS),
    graceEnded: true,
  };
}

export function readTenancy(platform: Platform, tenant: Tenant, now: Date = new Date()): TenancyRead {
  const subscription = platform.subscription(tenant.id);
  const pkg = PACKAGES[subscription.package];
  const people = platform.users(tenant.id);
  const charges = collection.chargesFor(platform, tenant.id);
  const due = charges.filter((charge) => charge.status === 'DUE');
  const open = tenant.closedAt === undefined && tenant.deletedAt === undefined;
  const purchased = purchasedSeats(platform.ledger, tenant.id);
  const erasuresDue = people.filter((user) => user.erasedAt === undefined && user.erasureDueAt !== undefined && Date.parse(user.erasureDueAt) <= now.getTime()).length;
  const everyoneErased = people.length > 0 && people.every((user) => user.erasedAt !== undefined);
  return {
    tenant,
    subscription,
    open,
    people,
    activePeople: people.filter((user) => user.status === 'ACTIVE' && user.erasedAt === undefined).length,
    administrators: people.filter((user) => user.status === 'ACTIVE' && user.erasedAt === undefined && user.roles.includes('ENTERPRISE_ADMIN')).length,
    charges,
    outstandingMinor: due.reduce((sum, charge) => sum + charge.amountMinor, 0),
    latePeriod: latePeriod(subscription, charges, now),
    openingCharge: subscription.status === 'AWAITING_PAYMENT' ? (due.sort((a, b) => a.periodStart.localeCompare(b.periodStart))[0] ?? null) : null,
    seatsUsed: subscription.assignedIdentities.length,
    seatsAllowed: pkg.includedSeats === null ? null : pkg.includedSeats + purchased,
    storage: storagePositionFor(platform, tenant.id),
    frozen: platform.wallet(tenant.id).frozen(),
    lifetimeRevenueMinor: platform.paymentReceipts(tenant.id).reduce((sum, receipt) => sum + receipt.amountMinor, 0),
    erasuresDue,
    readyToDelete:
      tenant.closedAt !== undefined &&
      tenant.deletedAt === undefined &&
      (everyoneErased || people.length === 0 || daysBetween(tenant.closedAt, now) >= graceDays()),
  };
}

/** Every customer tenancy still on the register, read. Deleted ones are on the chain and on no register. */
export function readEstate(platform: Platform, now: Date = new Date()): TenancyRead[] {
  return platform
    .customerTenants()
    .filter((tenant) => tenant.deletedAt === undefined)
    .map((tenant) => readTenancy(platform, tenant, now));
}

// --- The sweep -----------------------------------------------------------------

export function estateSweep(platform: Platform, estate: readonly TenancyRead[], now: Date = new Date()): EstateFinding[] {
  const open = estate.filter((entry) => entry.open);
  const names = (entries: readonly TenancyRead[]) => entries.map((entry) => entry.tenant.legalName).join(', ');

  // 1. Somebody can run every open tenancy.
  const unrun = open.filter((entry) => entry.administrators === 0);

  // 2. Paid packages waiting for a first payment past the due date.
  const waiting = open.filter((entry) => entry.subscription.status === 'AWAITING_PAYMENT');
  const stale = waiting.filter((entry) => entry.openingCharge !== null && daysBetween(entry.openingCharge.dueAt, now) > FIRST_PAYMENT_DAYS);

  // 3. Running subscriptions whose period is past due.
  const late = open.filter((entry) => entry.latePeriod !== null);

  // 4. Switched off but not closed: neither a customer nor gone.
  const off = open.filter((entry) => entry.subscription.status === 'SUSPENDED' || entry.subscription.status === 'CANCELLED');

  // 5. Frozen wallets.
  const frozen = open.filter((entry) => entry.frozen !== null);

  // 6. Finance exceptions still open, on customers.
  const customerIds = new Set(estate.map((entry) => entry.tenant.id));
  const exceptions = platform.paymentExceptions().filter((exception) => exception.status === 'OPEN' && customerIds.has(exception.tenantId));

  // 7. Refunds owed too long.
  const refunds = platform.refunds().filter((refund) => refund.status === 'DUE');
  const lateRefunds = refunds.filter((refund) => daysBetween(refund.raisedAt, now) > REFUND_DAYS);
  const refundsDueMinor = refunds.reduce((sum, refund) => sum + refund.totalMinor, 0);

  // 8. Closed tenancies with nothing left to keep them on the register.
  const closed = estate.filter((entry) => !entry.open);
  const tidy = closed.filter((entry) => entry.readyToDelete);

  // 9. Seats within the allowance.
  const overSeats = open.filter((entry) => entry.seatsAllowed !== null && entry.seatsUsed > entry.seatsAllowed);

  // 10. Storage: full fails; warning is named.
  const full = open.filter((entry) => entry.storage.state === 'FULL');
  const warning = open.filter((entry) => entry.storage.state === 'WARNING');

  // 11. Erasures that fell due and were not carried out.
  const overdueErasures = estate.filter((entry) => entry.erasuresDue > 0);
  const overdueCount = overdueErasures.reduce((sum, entry) => sum + entry.erasuresDue, 0);

  return [
    {
      check: 'Administrators',
      ok: unrun.length === 0,
      weight: 12,
      detail:
        unrun.length === 0
          ? `Every open tenancy has at least one active administrator (${tenancies(open.length)}).`
          : `${names(unrun)} — no active administrator. Nobody can invite anybody, configure anything or pay.`,
    },
    {
      check: 'First payment',
      ok: stale.length === 0,
      weight: 10,
      detail:
        stale.length === 0
          ? waiting.length === 0
            ? 'No paid package is waiting for its first payment.'
            : `${tenancies(waiting.length)} waiting for a first payment, none past its due date by more than ${FIRST_PAYMENT_DAYS} days.`
          : `${stale.map((entry) => `${entry.tenant.legalName} (${pounds(entry.openingCharge!.amountMinor)}, due ${entry.openingCharge!.dueAt.slice(0, 10)})`).join(', ')} — signed up for a paid package and more than ${FIRST_PAYMENT_DAYS} days past the first due date. Record the payment if it arrived; close the tenancy if it never will.`,
    },
    {
      check: 'Collection',
      ok: late.length === 0,
      weight: 12,
      detail:
        late.length === 0
          ? 'No running subscription is past due.'
          : `${late.map((entry) => `${entry.tenant.legalName} (${pounds(entry.latePeriod!.amountMinor)}, ${plural(entry.latePeriod!.daysLate, 'day')} late, ${entry.latePeriod!.graceEnded ? `grace ended ${entry.latePeriod!.graceEndsAt.slice(0, 10)} and still running` : `stops ${entry.latePeriod!.graceEndsAt.slice(0, 10)}`})`).join(', ')} — the period was raised and has not been paid.`,
    },
    {
      check: 'Switched off',
      ok: off.length === 0,
      weight: 8,
      detail:
        off.length === 0
          ? 'No open tenancy is suspended or cancelled.'
          : `${off.map((entry) => `${entry.tenant.legalName} (${entry.subscription.status.toLowerCase()})`).join(', ')} — read-only and still on the register. Reactivate it or close it, so the register says what is live.`,
    },
    {
      check: 'Frozen wallets',
      ok: frozen.length === 0,
      weight: 8,
      detail: frozen.length === 0 ? 'No customer wallet is frozen.' : `${frozen.map((entry) => `${entry.tenant.legalName} (${entry.frozen!.reason}, since ${entry.frozen!.at.slice(0, 10)})`).join(', ')} — AI is stopped for them until the dispute is settled and the wallet unfrozen.`,
    },
    {
      check: 'Payment exceptions',
      ok: exceptions.length === 0,
      weight: 10,
      detail:
        exceptions.length === 0
          ? 'No finance exception is open.'
          : `${plural(exceptions.length, 'exception')} open, ${pounds(exceptions.reduce((sum, exception) => sum + exception.shortfallMinor, 0))} of shortfall: money went back after it was spent and nobody has yet said how it was resolved.`,
    },
    {
      check: 'Refunds',
      ok: lateRefunds.length === 0,
      weight: 10,
      detail:
        lateRefunds.length === 0
          ? refunds.length === 0
            ? 'Nothing is owed back to a closed tenancy.'
            : `${pounds(refundsDueMinor)} owed to ${tenancies(refunds.length)}, all raised inside the last ${REFUND_DAYS} days.`
          : `${lateRefunds.map((refund) => `${refund.legalName} ${pounds(refund.totalMinor)} (raised ${refund.raisedAt.slice(0, 10)})`).join(', ')} — owed for more than ${REFUND_DAYS} days. Pay it, then record the reference.`,
    },
    {
      check: 'Register',
      ok: tidy.length === 0,
      weight: 6,
      detail:
        tidy.length === 0
          ? closed.length === 0
            ? 'No closed tenancy is waiting on the register.'
            : `${tenancies(closed.length)} closed, each still inside its ${graceDays()}-day erasure grace.`
          : `${names(tidy)} — closed, with every identity erased or the grace period over. Nothing keeps ${tidy.length === 1 ? 'it' : 'them'} on the register but the act of deleting.`,
    },
    {
      check: 'Seats',
      ok: overSeats.length === 0,
      weight: 8,
      detail:
        overSeats.length === 0
          ? 'Every tenancy is within its seat allowance.'
          : `${overSeats.map((entry) => `${entry.tenant.legalName} ${entry.seatsUsed} of ${entry.seatsAllowed}`).join(', ')} — more people assigned than the package plus purchased seats allow. Move the package or the assignments will not reconcile with the charge.`,
    },
    {
      check: 'Storage',
      ok: full.length === 0,
      weight: 8,
      detail:
        full.length === 0
          ? warning.length === 0
            ? 'No tenancy is near its storage limit.'
            : `${names(warning)} at warning; nobody is refused an upload yet.`
          : `${names(full)} — at the limit. The next upload is refused until capacity is added${warning.length ? `; ${names(warning)} at warning` : ''}.`,
    },
    {
      check: 'Erasures',
      ok: overdueCount === 0,
      weight: 8,
      detail:
        overdueCount === 0
          ? 'No erasure has fallen due and not been carried out.'
          : `${plural(overdueCount, 'identity', 'identities')} past the grace period and not yet erased (${names(overdueErasures)}). The hourly run should have taken them; delete them now.`,
    },
  ];
}

export type HealthScore = { score: number; band: 'STRONG' | 'WORKABLE' | 'WEAK'; passing: number; total: number; summary: string };

export function healthScore(findings: readonly EstateFinding[], customers: number): HealthScore {
  const total = findings.reduce((sum, finding) => sum + finding.weight, 0);
  const earned = findings.filter((finding) => finding.ok).reduce((sum, finding) => sum + finding.weight, 0);
  const score = total === 0 ? 0 : Math.round((earned / total) * 100);
  const failing = findings.filter((finding) => !finding.ok).sort((a, b) => b.weight - a.weight);
  return {
    score,
    band: score >= 90 ? 'STRONG' : score >= 65 ? 'WORKABLE' : 'WEAK',
    passing: findings.length - failing.length,
    total: findings.length,
    summary:
      failing.length === 0
        ? customers === 0
          ? 'Every check passes, over no customer tenancies. There is nothing yet to fail.'
          : `Every check passes across ${tenancies(customers)}. Everybody can run their tenancy, nothing is past due, nothing is owed back late.`
        : `${plural(failing.length, 'check')} failing, costliest first: ${failing.map((finding) => finding.check).join(', ')}.`,
  };
}

// --- Results -------------------------------------------------------------------

export type MonthlyResult = { month: string; joined: number; closed: number; receipts: number; revenueMinor: number };

/** What the estate did, by calendar month: who arrived, who left, what arrived in money. */
export function monthlyResults(platform: Platform, estate: readonly TenancyRead[]): MonthlyResult[] {
  const byMonth = new Map<string, MonthlyResult>();
  const bucket = (month: string): MonthlyResult => {
    const found = byMonth.get(month) ?? { month, joined: 0, closed: 0, receipts: 0, revenueMinor: 0 };
    byMonth.set(month, found);
    return found;
  };
  for (const entry of estate) {
    bucket(entry.tenant.createdAt.slice(0, 7)).joined += 1;
    if (entry.tenant.closedAt) bucket(entry.tenant.closedAt.slice(0, 7)).closed += 1;
  }
  for (const receipt of platform.customerReceipts()) {
    const row = bucket(receipt.recordedAt.slice(0, 7));
    row.receipts += 1;
    row.revenueMinor += receipt.amountMinor;
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

export type EstateTotals = {
  tenancies: { open: number; active: number; awaitingPayment: number; suspended: number; cancelled: number; closed: number };
  people: { active: number; administrators: number; deactivated: number; pendingErasure: number };
  money: { lifetimeRevenueMinor: number; outstandingMinor: number; refundsDueMinor: number; frozenWallets: number; openExceptions: number };
};

export function estateTotals(platform: Platform, estate: readonly TenancyRead[]): EstateTotals {
  const open = estate.filter((entry) => entry.open);
  const status = (wanted: Subscription['status']) => open.filter((entry) => entry.subscription.status === wanted).length;
  const people = open.flatMap((entry) => entry.people);
  const customerIds = new Set(estate.map((entry) => entry.tenant.id));
  return {
    tenancies: {
      open: open.length,
      active: status('ACTIVE'),
      awaitingPayment: status('AWAITING_PAYMENT'),
      suspended: status('SUSPENDED'),
      cancelled: status('CANCELLED'),
      closed: estate.length - open.length,
    },
    people: {
      active: open.reduce((sum, entry) => sum + entry.activePeople, 0),
      administrators: open.reduce((sum, entry) => sum + entry.administrators, 0),
      deactivated: people.filter((user) => user.status === 'SUSPENDED' && user.erasedAt === undefined).length,
      pendingErasure: estate.flatMap((entry) => entry.people).filter((user) => user.erasedAt === undefined && user.erasureDueAt !== undefined).length,
    },
    money: {
      lifetimeRevenueMinor: estate.reduce((sum, entry) => sum + entry.lifetimeRevenueMinor, 0),
      outstandingMinor: open.reduce((sum, entry) => sum + entry.outstandingMinor, 0),
      refundsDueMinor: platform
        .refunds()
        .filter((refund) => refund.status === 'DUE')
        .reduce((sum, refund) => sum + refund.totalMinor, 0),
      frozenWallets: open.filter((entry) => entry.frozen !== null).length,
      openExceptions: platform.paymentExceptions().filter((exception) => exception.status === 'OPEN' && customerIds.has(exception.tenantId)).length,
    },
  };
}

// --- Recommendations ------------------------------------------------------------

/**
 * A door the screen already has. `settle-charge` records a subscription payment
 * against a named charge; every other command clicks the row control of the same
 * name on the Tenants & Users screen, so the act is the one the operator would
 * have pressed by hand.
 */
export type Recommendation = {
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  detail: string;
  action?: {
    label: string;
    command: 'settle-charge' | 'status' | 'close' | 'delete' | 'unfreeze' | 'resolve-exception' | 'settle' | 'package' | 'people' | 'onboard';
    tenantId?: string;
    chargeId?: string;
    refundId?: string;
    exceptionId?: string;
  };
};

export function recommendations(platform: Platform, estate: readonly TenancyRead[], findings: readonly EstateFinding[], now: Date = new Date()): Recommendation[] {
  const out: Recommendation[] = [];
  const open = estate.filter((entry) => entry.open);
  const byCheck = new Map(findings.map((finding) => [finding.check, finding]));

  for (const entry of open.filter((candidate) => candidate.administrators === 0)) {
    out.push({
      priority: 'HIGH',
      title: `${entry.tenant.legalName} has no administrator`,
      detail:
        entry.activePeople > 0
          ? `${plural(entry.activePeople, 'person', 'people')} can sign in and none of them can invite, configure or pay. There is no operator act that appoints an administrator inside a customer's tenancy; the company's own remaining administrator would have to, and there is none. Reach the customer, or close the tenancy if it has been abandoned.`
          : 'Nobody in it can sign in. Reach the customer, or close the tenancy if it has been abandoned.',
      action: { label: 'Close the tenancy', command: 'close', tenantId: entry.tenant.id },
    });
  }

  for (const entry of open.filter((candidate) => candidate.latePeriod !== null)) {
    const period = entry.latePeriod!;
    out.push({
      priority: 'HIGH',
      title: `${entry.tenant.legalName} is ${plural(period.daysLate, 'day')} past due`,
      detail:
        `${pounds(period.amountMinor)} for the period from ${period.periodStart.slice(0, 10)} was raised and has not arrived; ` +
        (period.graceEnded
          ? `its grace ended ${period.graceEndsAt.slice(0, 10)} and the tenancy is still running. The hourly run should have suspended it. `
          : `the tenancy stops on ${period.graceEndsAt.slice(0, 10)}. `) +
        'If the money came by transfer, record it against the charge. If it will not come, suspend now rather than on the day.',
      action: { label: 'Record the payment', command: 'settle-charge', tenantId: entry.tenant.id, chargeId: period.chargeId },
    });
  }

  for (const entry of open.filter((candidate) => candidate.openingCharge !== null && daysBetween(candidate.openingCharge.dueAt, now) > FIRST_PAYMENT_DAYS)) {
    out.push({
      priority: 'HIGH',
      title: `${entry.tenant.legalName} never paid its first month`,
      detail: `Signed up for ${PACKAGES[entry.subscription.package].label} and ${plural(daysBetween(entry.openingCharge!.dueAt, now), 'day')} past the first due date with nothing recorded. Record the payment if it arrived outside the platform; otherwise close the tenancy so the register stops counting a customer that never was.`,
      action: { label: 'Record the payment', command: 'settle-charge', tenantId: entry.tenant.id, chargeId: entry.openingCharge!.id },
    });
  }

  for (const exception of platform.paymentExceptions().filter((candidate) => candidate.status === 'OPEN' && estate.some((entry) => entry.tenant.id === candidate.tenantId))) {
    const entry = estate.find((candidate) => candidate.tenant.id === exception.tenantId)!;
    out.push({
      priority: 'HIGH',
      title: `Resolve the ${exception.kind.toLowerCase()} on ${entry.tenant.legalName}`,
      detail: `${pounds(exception.amountMinor)} went back against ${exception.reference} after ${pounds(exception.shortfallMinor)} of it had been spent. Say how it was resolved — recovered, written off, or re-charged — so the exception closes on the record.`,
      action: { label: 'Resolve', command: 'resolve-exception', exceptionId: exception.id, tenantId: exception.tenantId },
    });
  }

  for (const entry of open.filter((candidate) => candidate.frozen !== null)) {
    if (platform.paymentExceptions().some((exception) => exception.status === 'OPEN' && exception.tenantId === entry.tenant.id && exception.kind === 'DISPUTE')) continue;
    out.push({
      priority: 'HIGH',
      title: `Unfreeze ${entry.tenant.legalName}'s wallet`,
      detail: `Frozen since ${entry.frozen!.at.slice(0, 10)} (${entry.frozen!.reason}) with no dispute still open against it. AI is stopped for them until it is lifted.`,
      action: { label: 'Unfreeze wallet', command: 'unfreeze', tenantId: entry.tenant.id },
    });
  }

  for (const refund of platform.refunds().filter((candidate) => candidate.status === 'DUE' && daysBetween(candidate.raisedAt, now) > REFUND_DAYS)) {
    out.push({
      priority: 'MEDIUM',
      title: `Pay ${refund.legalName} ${pounds(refund.totalMinor)}`,
      detail: `Owed since ${refund.raisedAt.slice(0, 10)}: ${pounds(refund.walletMinor)} of unspent paid-in credit and ${pounds(refund.subscriptionMinor)} of unused subscription. There is no rail that moves it; pay it and record the reference here.`,
      action: { label: 'Record the refund', command: 'settle', refundId: refund.id, tenantId: refund.tenantId },
    });
  }

  for (const entry of open.filter((candidate) => candidate.subscription.status === 'SUSPENDED' || candidate.subscription.status === 'CANCELLED')) {
    out.push({
      priority: 'MEDIUM',
      title: `${entry.tenant.legalName} is ${entry.subscription.status.toLowerCase()} and still open`,
      detail: 'Read-only for the customer, counted as a tenancy on every screen, and paying nothing. Reactivate it if the matter is settled; close it if the customer has gone, so the refund owed is raised and the people are scheduled for erasure.',
      action: { label: entry.subscription.status === 'CANCELLED' ? 'Close the tenancy' : 'Change the status', command: entry.subscription.status === 'CANCELLED' ? 'close' : 'status', tenantId: entry.tenant.id },
    });
  }

  for (const entry of open.filter((candidate) => candidate.seatsAllowed !== null && candidate.seatsUsed > candidate.seatsAllowed)) {
    out.push({
      priority: 'MEDIUM',
      title: `${entry.tenant.legalName} holds ${entry.seatsUsed} seats of ${entry.seatsAllowed}`,
      detail: 'More people assigned than the package plus purchased seats allow. Move the package so the entitlement matches the headcount, or the charge will not reconcile with what is in use.',
      action: { label: 'Move the package', command: 'package', tenantId: entry.tenant.id },
    });
  }

  for (const entry of open.filter((candidate) => candidate.storage.state === 'FULL')) {
    out.push({
      priority: 'MEDIUM',
      title: `${entry.tenant.legalName} is out of storage`,
      detail: `${entry.storage.summary} A larger package carries more; the customer can also buy a block from their own Billing screen.`,
      action: { label: 'Move the package', command: 'package', tenantId: entry.tenant.id },
    });
  }

  for (const entry of estate.filter((candidate) => candidate.erasuresDue > 0)) {
    out.push({
      priority: 'MEDIUM',
      title: `${plural(entry.erasuresDue, 'erasure')} overdue in ${entry.tenant.legalName}`,
      detail: 'The grace period has ended and the identity still names a person. The hourly run should have taken it; open the closed people and delete now.',
      action: { label: 'Open closed people', command: 'people', tenantId: entry.tenant.id },
    });
  }

  for (const entry of estate.filter((candidate) => candidate.readyToDelete)) {
    out.push({
      priority: 'LOW',
      title: `Delete ${entry.tenant.legalName} from the register`,
      detail: `Closed ${entry.tenant.closedAt!.slice(0, 10)}, ${entry.people.every((user) => user.erasedAt !== undefined) ? 'every identity erased' : 'the grace period over'}. The chain keeps what happened; the register stops listing it.`,
      action: { label: 'Delete from the register', command: 'delete', tenantId: entry.tenant.id },
    });
  }

  if (estate.length === 0) {
    out.push({
      priority: 'LOW',
      title: 'Onboard the first tenancy',
      detail: 'Nothing on the estate is a customer yet. Signups arrive on their own through the public form; an operator can also onboard a tenancy here with its first administrator.',
      action: { label: 'Onboard a tenancy', command: 'onboard' },
    });
  }

  // A warning nobody has to act on yet, said once.
  const storageCheck = byCheck.get('Storage');
  if (storageCheck && storageCheck.ok && storageCheck.detail.includes('at warning')) {
    out.push({ priority: 'LOW', title: 'Storage headroom', detail: storageCheck.detail });
  }

  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  return out.sort((a, b) => rank[a.priority] - rank[b.priority]).slice(0, 12);
}

// --- The position -----------------------------------------------------------------

export type EstatePosition = {
  health: HealthScore;
  sweep: EstateFinding[];
  results: { totals: EstateTotals; series: MonthlyResult[] };
  /** Per tenancy: what the sweep found wrong with it, for the row on the register. Empty when nothing. */
  attention: Array<{ tenantId: string; legalName: string; flags: string[] }>;
  recommendations: Recommendation[];
  limits: string[];
};

function flagsFor(entry: TenancyRead, now: Date): string[] {
  const flags: string[] = [];
  if (entry.open && entry.administrators === 0) flags.push('no administrator');
  if (entry.open && entry.latePeriod) flags.push(`${plural(entry.latePeriod.daysLate, 'day')} past due`);
  if (entry.open && entry.openingCharge && daysBetween(entry.openingCharge.dueAt, now) > FIRST_PAYMENT_DAYS) flags.push('first payment overdue');
  if (entry.open && (entry.subscription.status === 'SUSPENDED' || entry.subscription.status === 'CANCELLED')) flags.push(`${entry.subscription.status.toLowerCase()}, not closed`);
  if (entry.open && entry.frozen) flags.push('wallet frozen');
  if (entry.open && entry.seatsAllowed !== null && entry.seatsUsed > entry.seatsAllowed) flags.push('over seats');
  if (entry.open && entry.storage.state === 'FULL') flags.push('storage full');
  if (entry.erasuresDue > 0) flags.push(`${plural(entry.erasuresDue, 'erasure')} overdue`);
  if (entry.readyToDelete) flags.push('ready to delete');
  return flags;
}

export function estatePosition(platform: Platform, now: Date = new Date()): EstatePosition {
  const estate = readEstate(platform, now);
  const sweep = estateSweep(platform, estate, now);
  return {
    health: healthScore(sweep, estate.length),
    sweep,
    results: { totals: estateTotals(platform, estate), series: monthlyResults(platform, estate) },
    attention: estate
      .map((entry) => ({ tenantId: entry.tenant.id, legalName: entry.tenant.legalName, flags: flagsFor(entry, now) }))
      .filter((entry) => entry.flags.length > 0),
    recommendations: recommendations(platform, estate, sweep, now),
    limits: [
      'The score decides nothing. A suspension, a write-off, a refund and an erasure each happen only by the act that records them, and each act here is the same door the row already carries.',
      "A tenancy with no administrator cannot be repaired from this screen: there is no operator act that appoints an administrator inside a customer's tenancy. The company's own people do that, or the tenancy is closed.",
      'Bytes held, seats assigned, money received. What any tenancy is building is not read by the operator layer, and none of these checks looks.',
      'Customers only. The platform’s own tenancy and a demonstration are listed on the register, marked, and counted by none of these checks.',
    ],
  };
}
