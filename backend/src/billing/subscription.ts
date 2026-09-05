import { PACKAGES, UNCHARGED_ROLES, seatForRole, type PackageTier } from './seats.ts';
import { DomainError } from '../core/errors.ts';
import type { Role } from '../identity/roles.ts';

/**
 * Subscription layer — platform access and identity seats.
 *
 * The commercial split is deliberate and load-bearing: the subscription buys
 * access, governance, storage and every non-AI workflow. It buys no AI. AI is
 * metered separately through ACUs, so a heavy AI user pays for what they
 * consume rather than the platform absorbing it.
 */

export type SubscriptionTier = 'SOLO' | 'TEAM' | 'BUSINESS' | 'ENTERPRISE' | 'SOVEREIGN' | 'FREE_TRIAL';

export type TierDefinition = {
  tier: SubscriptionTier;
  targetCustomer: string;
  /** null = unlimited named identities. */
  includedIdentities: number | null;
  monthlyPriceUsd: number;
  /**
   * Storage is deliberately absent here.
   *
   * This table carried its own `storageGb` — 50, 250, 1000 against the packages'
   * 100, 500, unlimited — for the same customer, and the package is what the
   * pricing page publishes and what `billing/storage.ts` now enforces. Two
   * numbers for one entitlement is how a tenant gets sold one figure and
   * metered against another. The package owns it; read `PACKAGES[...].storageGb`
   * through `packageForTier`.
   */
  /** Isolated tenancy database + dedicated key material. */
  isolatedTenancy: boolean;
};

export const TIERS: Record<SubscriptionTier, TierDefinition> = {
  FREE_TRIAL: {
    tier: 'FREE_TRIAL',
    targetCustomer: 'Evaluation',
    includedIdentities: 3,
    monthlyPriceUsd: 0,
    isolatedTenancy: false,
  },
  SOLO: {
    tier: 'SOLO',
    targetCustomer: 'Freelancers / planners',
    includedIdentities: 3,
    monthlyPriceUsd: 39,
    isolatedTenancy: false,
  },
  TEAM: {
    tier: 'TEAM',
    targetCustomer: 'SMEs / subcontractors',
    includedIdentities: 20,
    monthlyPriceUsd: 149,
    isolatedTenancy: false,
  },
  BUSINESS: {
    tier: 'BUSINESS',
    targetCustomer: 'Large contractors',
    includedIdentities: 100,
    monthlyPriceUsd: 399,
    isolatedTenancy: false,
  },
  ENTERPRISE: {
    tier: 'ENTERPRISE',
    targetCustomer: 'EPCs',
    includedIdentities: null,
    monthlyPriceUsd: 1200,
    isolatedTenancy: false,
  },
  SOVEREIGN: {
    tier: 'SOVEREIGN',
    targetCustomer: 'Ministries / cities',
    includedIdentities: null,
    monthlyPriceUsd: 1500,
    isolatedTenancy: true,
  },
};

/**
 * The package a legacy tier maps to. The tier vocabulary predates the package
 * model and is kept so existing tenants and contracts still resolve, but the
 * package is what caps seats and sets the charge.
 */
export function packageForTier(tier: SubscriptionTier): PackageTier {
  if (tier === 'FREE_TRIAL') return 'FREE_TRIAL';
  if (tier === 'SOLO' || tier === 'TEAM') return 'CORE_PROJECT';
  if (tier === 'BUSINESS') return 'PROFESSIONAL_DELIVERY';
  return 'ENTERPRISE';
}

/** What the subscription covers. Anything not listed here is either AI-metered or unavailable. */
export const SUBSCRIPTION_INCLUDES = [
  'Identity management and named seats',
  'RBAC / ABAC policy enforcement',
  'Audit logs and Golden Thread retention',
  'Enterprise / portfolio / programme / project / package structure',
  'Document control (non-AI)',
  'Workflow orchestration',
  'Tiered data storage',
] as const;

/** Explicitly excluded — stated so no contract can imply an AI entitlement. */
export const SUBSCRIPTION_EXCLUDES = ['Any AI execution (billed strictly per ACU consumption)'] as const;

export type Subscription = {
  id: string;
  tenantId: string;
  tier: SubscriptionTier;
  /** The commercial package. Seat caps and the monthly charge come from here. */
  package: PackageTier;
  /**
   * `AWAITING_PAYMENT` is a paid package somebody signed up for and nobody has
   * paid for yet. The tenancy exists — its administrator can sign in and see
   * what is owed — and nothing else opens until the first period's charge is
   * settled, when it becomes ACTIVE on its own. A free package never holds it.
   */
  status: 'ACTIVE' | 'SUSPENDED' | 'CANCELLED' | 'AWAITING_PAYMENT';
  /** Named identities currently assigned. Seats are assignable, revocable, reusable. */
  assignedIdentities: string[];
  startedAt: string;
  renewsAt: string;
  /**
   * The operator has given this package away: no monthly charge is raised for
   * it, at the first month or any renewal. The wallet is untouched by it — the
   * tenancy still tops up its own account before an engine will run.
   *
   * On the subscription rather than only on the event that decided it, because
   * the event was all it was ever written to: the response said £0 a month and
   * `raiseCharge` read the list price at every renewal. Absent means paid.
   */
  grantedFree?: boolean;
};

/**
 * A refusal, not a failure.
 *
 * This extended a bare `Error`. The gateway had no mapping for it and answered
 * `500 INTERNAL_ERROR — The request could not be completed` — so an
 * administrator on the Free package, which includes one identity and whose one
 * identity they already were, pressed "Add a person" and was told the platform
 * was broken. It was refusing correctly and saying nothing. A `DomainError`
 * carries the limit, the package and what to do about it to the person.
 */
export class SeatLimitError extends DomainError {
  constructor(packageTier: PackageTier, limit: number, purchased = 0) {
    const included = PACKAGES[packageTier].includedSeats ?? limit;
    super(
      'SEAT_LIMIT_REACHED',
      `The ${PACKAGES[packageTier].label} package includes ${included} seat${included === 1 ? '' : 's'}` +
        (purchased > 0 ? ` and ${purchased} more ${purchased === 1 ? 'has' : 'have'} been bought` : '') +
        ', and every one is taken. Buy a seat on ACU & Billing, revoke a seat, or move package.',
      422,
    );
    this.name = 'SeatLimitError';
  }
}

/**
 * Seats this tenancy has bought beyond the package, summed from the record.
 *
 * Read from the ledger rather than held on the subscription, for the reason
 * every balance on this platform is: a counter is a second place the truth can
 * live. Each entitlement carries the seat it was bought as and the price in
 * force when it was bought, so the monthly charge below is what the customer
 * agreed to and not what the price list says today.
 */
type EntitlementLedger = { listByTenant: (tenantId: string, refType: string) => Array<{ state: Record<string, unknown> }> };

export type PurchasedSeat = {
  id: string;
  seat: string;
  label: string;
  seats: number;
  unitMinor: number;
  monthlyPriceMinor: number;
  purchasedAt: string;
};

export function purchasedSeatEntitlements(ledger: EntitlementLedger, tenantId: string): PurchasedSeat[] {
  return ledger.listByTenant(tenantId, 'SeatEntitlement').map((record) => ({
    id: String(record.state.id ?? ''),
    seat: String(record.state.seat ?? ''),
    label: String(record.state.label ?? record.state.seat ?? ''),
    seats: Number(record.state.seats ?? 0),
    unitMinor: Number(record.state.seatPriceMinorAtPurchase ?? 0),
    monthlyPriceMinor: Number(record.state.monthlyPriceMinor ?? 0),
    purchasedAt: String(record.state.purchasedAt ?? ''),
  }));
}

export function purchasedSeats(ledger: EntitlementLedger, tenantId: string): number {
  return purchasedSeatEntitlements(ledger, tenantId).reduce((sum, entitlement) => sum + entitlement.seats, 0);
}

/** What the bought seats add to the month, at the prices they were bought at. */
export function purchasedSeatChargeMinor(ledger: EntitlementLedger, tenantId: string): number {
  return purchasedSeatEntitlements(ledger, tenantId).reduce((sum, entitlement) => sum + entitlement.monthlyPriceMinor, 0);
}

/**
 * The seats a tenancy may fill: the package's included count plus what it has
 * bought. `null` is unlimited.
 */
export function seatCap(subscription: Subscription, purchased: number): number | null {
  const included = PACKAGES[subscription.package].includedSeats;
  return included === null ? null : included + purchased;
}

/**
 * One human = one identity. Shared accounts break liability attribution, which
 * is the whole point of an evidential record.
 *
 * Roles that carry no seat cost — the platform operator, and a regulator whose
 * access the asset owner is obliged to provide — do not consume the cap either.
 */
export function assignIdentity(subscription: Subscription, userId: string, roles: Role[] = [], purchased = 0): Subscription {
  if (subscription.assignedIdentities.includes(userId)) return subscription;
  if (roles.some((role) => UNCHARGED_ROLES.includes(role))) return subscription;

  // The package's seats plus the ones bought beyond it. A seat bought and not
  // counted here is money taken for nothing.
  const limit = seatCap(subscription, purchased);
  if (limit !== null && subscription.assignedIdentities.length >= limit) {
    throw new SeatLimitError(subscription.package, limit, purchased);
  }
  return { ...subscription, assignedIdentities: [...subscription.assignedIdentities, userId] };
}

export function revokeIdentity(subscription: Subscription, userId: string): Subscription {
  return { ...subscription, assignedIdentities: subscription.assignedIdentities.filter((id) => id !== userId) };
}

/** The monthly charge in pence. A suspended subscription is not billed, and neither is one granted free of charge. */
export function monthlySubscriptionCharge(subscription: Subscription): number {
  return subscription.status === 'ACTIVE' && !subscription.grantedFree ? PACKAGES[subscription.package].monthlyPriceMinor : 0;
}

/**
 * What the tenant's seats would cost bought individually, against what the
 * package charges. An enterprise admin deciding whether to move package needs
 * both numbers, and a package that costs more than its seats is one the tenant
 * should be told to leave.
 */
export function seatEconomics(
  subscription: Subscription,
  rolesByUser: Map<string, Role[]>,
): { seatValueMinor: number; packageMinor: number; savingMinor: number; breakdown: Array<{ seat: string; count: number; minor: number }> } {
  const counts = new Map<string, { minor: number; count: number }>();

  for (const userId of subscription.assignedIdentities) {
    const seat = (rolesByUser.get(userId) ?? []).map(seatForRole).find(Boolean);
    if (!seat) continue;
    const entry = counts.get(seat.label) ?? { minor: seat.monthlyPriceMinor, count: 0 };
    entry.count += 1;
    counts.set(seat.label, entry);
  }

  const breakdown = [...counts.entries()]
    .map(([seat, { minor, count }]) => ({ seat, count, minor: minor * count }))
    .sort((a, b) => b.minor - a.minor);

  const seatValue = breakdown.reduce((sum, line) => sum + line.minor, 0);
  const packageMinor = monthlySubscriptionCharge(subscription);

  return { seatValueMinor: seatValue, packageMinor, savingMinor: seatValue - packageMinor, breakdown };
}
