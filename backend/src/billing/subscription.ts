import { PACKAGES, UNCHARGED_ROLES, seatForRole, type PackageTier } from './seats.ts';
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
  storageGb: number | null;
  /** Isolated tenancy database + dedicated key material. */
  isolatedTenancy: boolean;
};

export const TIERS: Record<SubscriptionTier, TierDefinition> = {
  FREE_TRIAL: {
    tier: 'FREE_TRIAL',
    targetCustomer: 'Evaluation',
    includedIdentities: 3,
    monthlyPriceUsd: 0,
    storageGb: 5,
    isolatedTenancy: false,
  },
  SOLO: {
    tier: 'SOLO',
    targetCustomer: 'Freelancers / planners',
    includedIdentities: 3,
    monthlyPriceUsd: 39,
    storageGb: 50,
    isolatedTenancy: false,
  },
  TEAM: {
    tier: 'TEAM',
    targetCustomer: 'SMEs / subcontractors',
    includedIdentities: 20,
    monthlyPriceUsd: 149,
    storageGb: 250,
    isolatedTenancy: false,
  },
  BUSINESS: {
    tier: 'BUSINESS',
    targetCustomer: 'Large contractors',
    includedIdentities: 100,
    monthlyPriceUsd: 399,
    storageGb: 1000,
    isolatedTenancy: false,
  },
  ENTERPRISE: {
    tier: 'ENTERPRISE',
    targetCustomer: 'EPCs',
    includedIdentities: null,
    monthlyPriceUsd: 1200,
    storageGb: null,
    isolatedTenancy: false,
  },
  SOVEREIGN: {
    tier: 'SOVEREIGN',
    targetCustomer: 'Ministries / cities',
    includedIdentities: null,
    monthlyPriceUsd: 1500,
    storageGb: null,
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
  status: 'ACTIVE' | 'SUSPENDED' | 'CANCELLED';
  /** Named identities currently assigned. Seats are assignable, revocable, reusable. */
  assignedIdentities: string[];
  startedAt: string;
  renewsAt: string;
};

export class SeatLimitError extends Error {
  constructor(packageTier: PackageTier, limit: number) {
    super(`The ${PACKAGES[packageTier].label} package includes ${limit} seats; revoke a seat or move package`);
    this.name = 'SeatLimitError';
  }
}

/**
 * One human = one identity. Shared accounts break liability attribution, which
 * is the whole point of an evidential record.
 *
 * Roles that carry no seat cost — the platform operator, and a regulator whose
 * access the asset owner is obliged to provide — do not consume the cap either.
 */
export function assignIdentity(subscription: Subscription, userId: string, roles: Role[] = []): Subscription {
  if (subscription.assignedIdentities.includes(userId)) return subscription;
  if (roles.some((role) => UNCHARGED_ROLES.includes(role))) return subscription;

  const limit = PACKAGES[subscription.package].includedSeats;
  if (limit !== null && subscription.assignedIdentities.length >= limit) {
    throw new SeatLimitError(subscription.package, limit);
  }
  return { ...subscription, assignedIdentities: [...subscription.assignedIdentities, userId] };
}

export function revokeIdentity(subscription: Subscription, userId: string): Subscription {
  return { ...subscription, assignedIdentities: subscription.assignedIdentities.filter((id) => id !== userId) };
}

/** The monthly charge in pence. A suspended subscription is not billed. */
export function monthlySubscriptionCharge(subscription: Subscription): number {
  return subscription.status === 'ACTIVE' ? PACKAGES[subscription.package].monthlyPriceMinor : 0;
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
