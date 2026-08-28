import { DomainError, ForbiddenError, NotFoundError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import type { AuthContext } from '../identity/auth.ts';
import { PLATFORM_TENANT_ID, type Platform } from '../platform.ts';

/**
 * People who bring customers, and what the platform owes them for it.
 *
 * Two kinds, deliberately in one module because they are the same mechanism
 * with different terms, and building them as two would guarantee they drifted:
 *
 * - a **partner** is a reseller, a consultancy or an integrator who introduces
 *   tenancies and takes a share of what those tenancies pay, for as long as they
 *   keep paying;
 * - an **influencer** is somebody with an audience who is paid once per tenancy
 *   they bring, not a share of it.
 *
 * Everything below follows from one rule: **commission is calculated from
 * payments the platform has actually received, and never from anything else.**
 * Not from signups, not from pipeline, not from a tenancy's stated intent. A
 * referral programme that accrues against expected revenue is a programme that
 * eventually pays commission on money that never arrived, and the person it
 * paid is not going to give it back.
 *
 * So attribution is a fact recorded at signup — a referral code carried on the
 * tenancy — and earnings are computed by walking that tenancy's actual payment
 * receipts. The same walk that produces the estate's lifetime revenue produces
 * this. Two numbers derived from one record cannot disagree.
 *
 * **A payout is a separate act from an accrual.** What is earned and what has
 * been paid are different fields, and the platform records the second when
 * somebody has actually sent the money. Nothing here moves money — there is no
 * outbound payment rail, and pretending otherwise would be the worst kind of
 * fiction to put in a financial record.
 */

export type PartnerKind = 'PARTNER' | 'INFLUENCER';
export type PartnerStatus = 'ACTIVE' | 'PAUSED' | 'ENDED';

export type Partner = {
  id: string;
  kind: PartnerKind;
  name: string;
  /** How they are reached. The programme is a commercial relationship with a person. */
  email: string;
  /** What a referral link carries. Unique, case-insensitive, and never reused. */
  code: string;
  status: PartnerStatus;
  /**
   * Share of a referred tenancy's payments, in basis points. Only meaningful
   * for a PARTNER.
   */
  commissionBps?: number;
  /**
   * Paid once per tenancy that converts to a paid tier. Only meaningful for an
   * INFLUENCER, in minor units of the billing currency.
   */
  bountyMinor?: number;
  /** Where their audience is, for an influencer. Free text; it is a fact about them. */
  audience?: string;
  agreedAt: string;
  agreedBy: string;
  /** What has actually been sent to them, and when. */
  payouts: { id: string; at: string; amountMinor: number; reference: string; note?: string; recordedBy: string }[];
  endedAt?: string;
  endedReason?: string;
};

/** The maximum share anybody may be given, so a typo cannot give away the company. */
const MAX_COMMISSION_BPS = 5_000;

/** Where the programme's records live. The platform's own governance chain. */
function chain(): string {
  return `${PLATFORM_TENANT_ID}-governance`;
}

function normaliseCode(code: string): string {
  return code
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '');
}

function commit(platform: Platform, actorId: string, { eventType, partner }: { eventType: string; partner: Partner }): void {
  platform.ledger.commit({
    tenantId: PLATFORM_TENANT_ID,
    projectId: chain(),
    actor: { refType: 'User', refId: actorId },
    source: 'SYSTEM',
    correlationId: partner.id,
    eventType,
    entity: { refType: 'GrowthPartner', refId: partner.id },
    nextState: partner as unknown as Record<string, unknown>,
  });
}

function operatorOnly(actor: AuthContext, action: string): void {
  if (!actor.roles.includes('PLATFORM_ADMIN')) {
    throw new ForbiddenError(`Only the platform operator may ${action}`, 'PLATFORM_ADMIN_REQUIRED');
  }
}

export function partners(platform: Platform): Partner[] {
  return platform.ledger
    .entitiesOfType('GrowthPartner')
    .map((record) => record.state as unknown as Partner)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function partnerByCode(platform: Platform, code: string): Partner | undefined {
  const wanted = normaliseCode(code);
  return partners(platform).find((partner) => partner.code === wanted);
}

function mustFind(platform: Platform, partnerId: string): Partner {
  const record = platform.ledger.get({ refType: 'GrowthPartner', refId: partnerId });
  if (!record) throw new NotFoundError(`No partner ${partnerId}`);
  return record.state as unknown as Partner;
}

export function enrol(
  platform: Platform,
  actor: AuthContext,
  input: { kind: PartnerKind; name: string; email: string; code: string; commissionBps?: number; bountyMinor?: number; audience?: string },
): Partner {
  operatorOnly(actor, 'enrol a growth partner');

  const code = normaliseCode(input.code);
  if (code.length < 3) throw new DomainError('CODE_TOO_SHORT', 'A referral code needs at least three usable characters.', 422);
  if (partnerByCode(platform, code)) {
    // Never reused, including after somebody's agreement ends: an old link that
    // starts crediting a different person is an attribution error nobody can
    // detect from the outside.
    throw new DomainError('CODE_IN_USE', `${code} already belongs to somebody. A code is never reused, including after an agreement ends.`, 409);
  }
  if (!input.email.includes('@')) throw new DomainError('EMAIL_REQUIRED', 'A programme is an agreement with a person who can be reached.', 422);

  if (input.kind === 'PARTNER') {
    const bps = input.commissionBps ?? 0;
    if (bps <= 0) throw new DomainError('COMMISSION_REQUIRED', 'A partner with no commission has no agreement. State the share in basis points.', 422);
    if (bps > MAX_COMMISSION_BPS) {
      throw new DomainError(
        'COMMISSION_TOO_HIGH',
        `${bps} basis points is ${(bps / 100).toFixed(1)}% of everything a referred tenancy ever pays. The ceiling is ${MAX_COMMISSION_BPS / 100}%.`,
        422,
      );
    }
  } else if (!input.bountyMinor || input.bountyMinor <= 0) {
    throw new DomainError('BOUNTY_REQUIRED', 'An influencer is paid a fixed amount per tenancy. State it.', 422);
  }

  const partner: Partner = {
    id: ulid(),
    kind: input.kind,
    name: input.name.trim(),
    email: input.email.trim().toLowerCase(),
    code,
    status: 'ACTIVE',
    commissionBps: input.kind === 'PARTNER' ? input.commissionBps : undefined,
    bountyMinor: input.kind === 'INFLUENCER' ? input.bountyMinor : undefined,
    audience: input.audience?.trim() || undefined,
    agreedAt: new Date().toISOString(),
    agreedBy: actor.actorId,
    payouts: [],
  };

  commit(platform, actor.actorId, { eventType: 'GROWTH_PARTNER_ENROLLED', partner });
  return partner;
}

export function setStatus(platform: Platform, actor: AuthContext, partnerId: string, status: PartnerStatus, reason: string): Partner {
  operatorOnly(actor, 'change a partner agreement');
  const existing = mustFind(platform, partnerId);
  const stated = reason.trim();
  if (stated.length < 5) throw new DomainError('REASON_REQUIRED', 'Say why. A commercial agreement changed with no stated reason is unreadable later.', 422);

  const updated: Partner = {
    ...existing,
    status,
    endedAt: status === 'ENDED' ? new Date().toISOString() : undefined,
    endedReason: status === 'ENDED' ? stated : undefined,
  };
  commit(platform, actor.actorId, { eventType: 'GROWTH_PARTNER_STATUS_SET', partner: updated });
  return updated;
}

/**
 * Record money that has already been sent.
 *
 * Not a payment instruction. The platform has no outbound rail and this does not
 * transfer anything — it writes down that somebody paid a partner, so that what
 * is owed can be computed against what has been settled. The reference is the
 * bank's, and it is the idempotency key: the same reference twice records once.
 */
export function recordPayout(
  platform: Platform,
  actor: AuthContext,
  partnerId: string,
  input: { amountMinor: number; reference: string; note?: string },
): { partner: Partner; alreadyRecorded: boolean } {
  operatorOnly(actor, 'record a partner payout');
  const existing = mustFind(platform, partnerId);
  const reference = input.reference.trim();
  if (reference.length < 3) throw new DomainError('REFERENCE_REQUIRED', 'The bank’s own reference. It is what stops the same payment being recorded twice.', 422);
  if (input.amountMinor <= 0) throw new DomainError('AMOUNT_REQUIRED', 'A payout of nothing is not a payout.', 422);

  if (existing.payouts.some((payout) => payout.reference === reference)) {
    return { partner: existing, alreadyRecorded: true };
  }

  const updated: Partner = {
    ...existing,
    payouts: [
      ...existing.payouts,
      {
        id: ulid(),
        at: new Date().toISOString(),
        amountMinor: input.amountMinor,
        reference,
        note: input.note?.trim() || undefined,
        recordedBy: actor.actorId,
      },
    ],
  };
  commit(platform, actor.actorId, { eventType: 'GROWTH_PARTNER_PAID', partner: updated });
  return { partner: updated, alreadyRecorded: false };
}

/** A tenancy attributed to a partner, with what it has actually paid. */
export type ReferredTenancy = {
  tenantId: string;
  legalName: string;
  joinedAt: string;
  tier: string;
  status: string;
  /** Every settled receipt on this tenancy, summed. */
  lifetimeRevenueMinor: number;
  /** This partner's share of that, under their own terms. */
  earnedMinor: number;
  /** True once the tenancy has paid anything at all. A bounty is owed on this. */
  converted: boolean;
};

export type PartnerPosition = Partner & {
  referrals: ReferredTenancy[];
  referredCount: number;
  convertedCount: number;
  attributedRevenueMinor: number;
  earnedMinor: number;
  paidMinor: number;
  owedMinor: number;
};

/**
 * What a partner has brought and what they are owed.
 *
 * Walks payment receipts, not subscriptions. A tenancy on a paid tier that has
 * never settled an invoice has produced no revenue and therefore no commission —
 * and saying otherwise would have the platform owing money against money it has
 * not been sent.
 */
export function position(platform: Platform, partner: Partner): PartnerPosition {
  const referrals: ReferredTenancy[] = [];

  for (const tenant of platform.tenants()) {
    if ((tenant.referralCode ?? '') !== partner.code) continue;
    const subscription = platform.subscription(tenant.id);
    const lifetimeRevenueMinor = platform.paymentReceipts(tenant.id).reduce((sum, receipt) => sum + receipt.amountMinor, 0);
    const converted = lifetimeRevenueMinor > 0;

    referrals.push({
      tenantId: tenant.id,
      legalName: tenant.legalName,
      joinedAt: tenant.createdAt,
      tier: subscription.tier,
      status: subscription.status,
      lifetimeRevenueMinor,
      earnedMinor:
        partner.kind === 'PARTNER'
          ? Math.floor((lifetimeRevenueMinor * (partner.commissionBps ?? 0)) / 10_000)
          : converted
            ? (partner.bountyMinor ?? 0)
            : 0,
      converted,
    });
  }

  referrals.sort((a, b) => b.lifetimeRevenueMinor - a.lifetimeRevenueMinor);
  const earnedMinor = referrals.reduce((sum, referral) => sum + referral.earnedMinor, 0);
  const paidMinor = partner.payouts.reduce((sum, payout) => sum + payout.amountMinor, 0);

  return {
    ...partner,
    referrals,
    referredCount: referrals.length,
    convertedCount: referrals.filter((referral) => referral.converted).length,
    attributedRevenueMinor: referrals.reduce((sum, referral) => sum + referral.lifetimeRevenueMinor, 0),
    earnedMinor,
    paidMinor,
    // Never negative on the screen. An overpayment is a real thing and shows as
    // zero owed with paid exceeding earned, which is visible in the two figures
    // beside it rather than hidden inside one.
    owedMinor: Math.max(0, earnedMinor - paidMinor),
  };
}

export type ProgrammePosition = {
  partners: PartnerPosition[];
  influencers: PartnerPosition[];
  totals: {
    active: number;
    referredTenancies: number;
    convertedTenancies: number;
    attributedRevenueMinor: number;
    earnedMinor: number;
    paidMinor: number;
    owedMinor: number;
  };
  /**
   * Tenancies that arrived with a code nobody in the programme holds.
   *
   * Almost always a typo in a link, and always worth knowing: somebody is
   * sending traffic and getting no credit for it.
   */
  unattributed: { tenantId: string; legalName: string; code: string; joinedAt: string }[];
  summary: string;
};

export function programmePosition(platform: Platform, actor: AuthContext): ProgrammePosition {
  operatorOnly(actor, 'see the growth programme');

  const positions = partners(platform).map((partner) => position(platform, partner));
  const known = new Set(positions.map((entry) => entry.code));

  const unattributed = platform
    .tenants()
    .filter((tenant) => tenant.referralCode && !known.has(tenant.referralCode))
    .map((tenant) => ({
      tenantId: tenant.id,
      legalName: tenant.legalName,
      code: tenant.referralCode as string,
      joinedAt: tenant.createdAt,
    }));

  const totals = {
    active: positions.filter((entry) => entry.status === 'ACTIVE').length,
    referredTenancies: positions.reduce((sum, entry) => sum + entry.referredCount, 0),
    convertedTenancies: positions.reduce((sum, entry) => sum + entry.convertedCount, 0),
    attributedRevenueMinor: positions.reduce((sum, entry) => sum + entry.attributedRevenueMinor, 0),
    earnedMinor: positions.reduce((sum, entry) => sum + entry.earnedMinor, 0),
    paidMinor: positions.reduce((sum, entry) => sum + entry.paidMinor, 0),
    owedMinor: positions.reduce((sum, entry) => sum + entry.owedMinor, 0),
  };

  return {
    partners: positions.filter((entry) => entry.kind === 'PARTNER'),
    influencers: positions.filter((entry) => entry.kind === 'INFLUENCER'),
    totals,
    unattributed,
    summary:
      positions.length === 0
        ? 'Nobody is enrolled. A referral code on a signup link credits whoever holds it, and until somebody is enrolled every code is unattributed.'
        : `${totals.active} active · ${totals.referredTenancies} tenanc${totals.referredTenancies === 1 ? 'y' : 'ies'} attributed · ` +
          `commission is computed from settled receipts, never from signups.`,
  };
}
