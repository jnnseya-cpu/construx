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
  status: 'ACTIVE' | 'SUSPENDED' | 'CANCELLED';
  /** Named identities currently assigned. Seats are assignable, revocable, reusable. */
  assignedIdentities: string[];
  startedAt: string;
  renewsAt: string;
};

export class SeatLimitError extends Error {
  constructor(tier: SubscriptionTier, limit: number) {
    super(`Tier ${tier} includes ${limit} identities; assign more seats or upgrade the tier`);
    this.name = 'SeatLimitError';
  }
}

/** One human = one identity. Shared accounts break liability attribution. */
export function assignIdentity(subscription: Subscription, userId: string): Subscription {
  if (subscription.assignedIdentities.includes(userId)) return subscription;
  const limit = TIERS[subscription.tier].includedIdentities;
  if (limit !== null && subscription.assignedIdentities.length >= limit) {
    throw new SeatLimitError(subscription.tier, limit);
  }
  return { ...subscription, assignedIdentities: [...subscription.assignedIdentities, userId] };
}

export function revokeIdentity(subscription: Subscription, userId: string): Subscription {
  return { ...subscription, assignedIdentities: subscription.assignedIdentities.filter((id) => id !== userId) };
}

export function monthlySubscriptionCharge(subscription: Subscription): number {
  return subscription.status === 'ACTIVE' ? TIERS[subscription.tier].monthlyPriceUsd : 0;
}
