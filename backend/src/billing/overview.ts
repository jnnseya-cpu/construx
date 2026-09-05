import type { PaymentReceipt } from './payments.ts';
import type { SubscriptionTier } from './subscription.ts';

/**
 * The executive position of the platform, in one read.
 *
 * The operator console could already answer "how is the estate spending" — that
 * is `estateBurn` — and "who is on the estate" — that is the tenant route. It
 * could not answer the first question anybody actually opens an operator
 * console to ask: *how much money has come in, from whom, and is it growing.*
 * Each half of that was reachable, and assembling it was left to whoever was
 * looking at the screen.
 *
 * Three properties this module holds to, because each of them is a way a
 * dashboard lies:
 *
 * **Every figure is counted, never modelled.** Revenue is the sum of receipts
 * actually recorded. A receipt exists because a payment settled, so there is no
 * position in which this number is larger than the money received.
 *
 * **A projection is labelled as one and shows its arithmetic.** The run-rate is
 * month-to-date divided by elapsed days times the days in the month, and it says
 * so. It is not a forecast, there is no confidence attached to it, and on the
 * first of the month it is withheld rather than multiplied out of a single day.
 *
 * **Nothing is invented to fill a panel.** Where there is no history there is no
 * figure, and the absence is returned as `null` for the console to state plainly.
 * A dashboard that renders zero where it means "unknown" is worse than an empty
 * one, because zero is a claim.
 *
 * It holds no policy: it does not decide what a thin month means or what to do
 * about it. It counts, and returns.
 */

export type RevenuePosition = {
  /** Settled today, UTC. */
  todayMinor: number;
  /** Settled since the first of the current month, UTC. */
  monthToDateMinor: number;
  /** Settled in the calendar month before this one — what MTD is judged against. */
  previousMonthMinor: number;
  /** Every receipt ever recorded. */
  lifetimeMinor: number;
  receipts: number;
  /** Split by how the money arrived, biggest first. */
  byMethod: Array<{ method: string; amountMinor: number; receipts: number }>;
  /**
   * Month-to-date extrapolated across the whole month: `MTD ÷ elapsed × days`.
   *
   * Null on the first day of a month and null where nothing has been received —
   * extrapolating one day across thirty is arithmetic that produces a number
   * nobody should act on, and stating no projection is the honest output.
   */
  runRateMinor: number | null;
  /** The arithmetic behind `runRateMinor`, so the console can show its working. */
  runRateBasis: { monthToDateMinor: number; elapsedDays: number; daysInMonth: number } | null;
};

export type EstateOverview = {
  at: string;
  tenancies: {
    /** Open tenancies. A closed one is counted under `closed` and nowhere else. */
    total: number;
    active: number;
    suspended: number;
    cancelled: number;
    /**
     * Tenancies the operator has closed.
     *
     * Kept out of every other figure here. A closed tenancy's identities are
     * deactivated, its wallet is emptied and its subscription is cancelled, so
     * counting it as a tenancy, its people as identities or its unpaid
     * requests as money awaited reports a business one tenancy larger than the
     * one that exists — which is exactly what the Command Center did the day
     * after a test signup was closed.
     */
    closed: number;
    /**
     * Active tenancies still on the free trial tier.
     *
     * Counted apart from `active` because they are a different commercial fact:
     * a trial is a tenancy that has not yet decided, and folding it into the
     * active count reports a customer base larger than the one paying.
     */
    onTrial: number;
    /** Tenancies with no identity holding ENTERPRISE_ADMIN — nobody can run them. */
    unreachable: number;
    /** Tenancies onboarded in the last 30 days. */
    newInWindow: number;
    byTier: Array<{ tier: SubscriptionTier; tenancies: number }>;
  };
  identities: {
    /** Named identities across every customer tenancy. Operators are counted separately. */
    total: number;
    active: number;
    suspended: number;
    operators: number;
    /** Seats assigned against seats the packages include. Null where a tier is uncapped. */
    seatsUsed: number;
    seatsIncluded: number | null;
  };
  revenue: RevenuePosition;
  /** Top-ups raised and not yet settled — money customers intend to pay. */
  awaitingPayment: { count: number; amountMinor: number };
};

type TenancyInput = {
  tenantId: string;
  createdAt: string;
  tier: SubscriptionTier;
  status: 'ACTIVE' | 'SUSPENDED' | 'CANCELLED';
  seatsUsed: number;
  /** Null where the package caps nothing. */
  seatsIncluded: number | null;
  identities: ReadonlyArray<{ status: 'ACTIVE' | 'SUSPENDED'; administrator: boolean }>;
  /** Closed by the operator. Counted once, under `closed`, and in nothing else. */
  closed?: boolean;
};

/** Days in the calendar month `at` falls in, UTC. */
function daysInMonth(at: Date): number {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)).getUTCDate();
}

export function estateOverview(
  input: {
    tenancies: readonly TenancyInput[];
    receipts: readonly PaymentReceipt[];
    awaitingPayment: ReadonlyArray<{ amountMinor: number }>;
    operators: number;
  },
  now = new Date(),
): EstateOverview {
  const at = now.toISOString();
  const today = at.slice(0, 10);
  const monthStart = at.slice(0, 7);
  const previousMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const windowStart = new Date(now.getTime() - 30 * 86_400_000).toISOString();

  // Every figure below reads the open tenancies. The closed ones are counted
  // once, as closed, so the screen can say they exist without adding them to
  // anything.
  const closed = input.tenancies.filter((tenancy) => tenancy.closed === true).length;
  const tenancies = input.tenancies.filter((tenancy) => tenancy.closed !== true);

  const byTier = new Map<SubscriptionTier, number>();
  for (const tenancy of tenancies) byTier.set(tenancy.tier, (byTier.get(tenancy.tier) ?? 0) + 1);

  const byMethod = new Map<string, { method: string; amountMinor: number; receipts: number }>();
  for (const receipt of input.receipts) {
    const row = byMethod.get(receipt.method) ?? { method: receipt.method, amountMinor: 0, receipts: 0 };
    row.amountMinor += receipt.amountMinor;
    row.receipts += 1;
    byMethod.set(receipt.method, row);
  }

  const monthToDateMinor = input.receipts
    .filter((receipt) => receipt.recordedAt.slice(0, 7) === monthStart)
    .reduce((sum, receipt) => sum + receipt.amountMinor, 0);

  const elapsedDays = now.getUTCDate();
  const days = daysInMonth(now);
  // Withheld rather than extrapolated on day one: dividing by a single elapsed
  // day multiplies whatever happened to land that day across the whole month.
  const projectable = elapsedDays > 1 && monthToDateMinor > 0;

  // A capped tier reports its cap; an uncapped one makes the estate total
  // meaningless, so the whole figure is withheld rather than reported as the sum
  // of the capped tiers alone — which would read as a low ceiling.
  const uncapped = tenancies.some((tenancy) => tenancy.seatsIncluded === null);

  return {
    at,
    tenancies: {
      total: tenancies.length,
      active: tenancies.filter((t) => t.status === 'ACTIVE').length,
      suspended: tenancies.filter((t) => t.status === 'SUSPENDED').length,
      cancelled: tenancies.filter((t) => t.status === 'CANCELLED').length,
      closed,
      onTrial: tenancies.filter((t) => t.status === 'ACTIVE' && t.tier === 'FREE_TRIAL').length,
      // A tenancy nobody can administer cannot invite anybody, cannot be
      // configured and cannot be used, whatever it is paying. Onboarding now
      // creates the first administrator with the tenancy, so this should read
      // zero for ever — which is exactly why it is worth showing.
      unreachable: tenancies.filter((t) => !t.identities.some((i) => i.administrator)).length,
      newInWindow: tenancies.filter((t) => t.createdAt >= windowStart).length,
      byTier: [...byTier.entries()]
        .map(([tier, count]) => ({ tier, tenancies: count }))
        .sort((a, b) => b.tenancies - a.tenancies),
    },
    identities: {
      total: tenancies.reduce((sum, t) => sum + t.identities.length, 0),
      active: tenancies.reduce((sum, t) => sum + t.identities.filter((i) => i.status === 'ACTIVE').length, 0),
      suspended: tenancies.reduce((sum, t) => sum + t.identities.filter((i) => i.status === 'SUSPENDED').length, 0),
      operators: input.operators,
      seatsUsed: tenancies.reduce((sum, t) => sum + t.seatsUsed, 0),
      seatsIncluded: uncapped ? null : tenancies.reduce((sum, t) => sum + (t.seatsIncluded ?? 0), 0),
    },
    revenue: {
      todayMinor: input.receipts
        .filter((receipt) => receipt.recordedAt.slice(0, 10) === today)
        .reduce((sum, receipt) => sum + receipt.amountMinor, 0),
      monthToDateMinor,
      previousMonthMinor: input.receipts
        .filter((receipt) => receipt.recordedAt.slice(0, 7) === previousMonth)
        .reduce((sum, receipt) => sum + receipt.amountMinor, 0),
      lifetimeMinor: input.receipts.reduce((sum, receipt) => sum + receipt.amountMinor, 0),
      receipts: input.receipts.length,
      byMethod: [...byMethod.values()].sort((a, b) => b.amountMinor - a.amountMinor),
      runRateMinor: projectable ? Math.round((monthToDateMinor / elapsedDays) * days) : null,
      runRateBasis: projectable ? { monthToDateMinor, elapsedDays, daysInMonth: days } : null,
    },
    awaitingPayment: {
      count: input.awaitingPayment.length,
      amountMinor: input.awaitingPayment.reduce((sum, intent) => sum + intent.amountMinor, 0),
    },
  };
}
