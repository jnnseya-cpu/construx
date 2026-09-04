import { DomainError, NotFoundError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { PACKAGES } from '../billing/seats.ts';
import type { AuthContext } from '../identity/auth.ts';
import { MODULES } from '../identity/modules.ts';
import type { Platform } from '../platform.ts';
import { groupOf, type ChargeMode, type Group } from './directory.ts';

/**
 * The agreement under a group, and what each company's subscription holds
 * (enterprise specification §9).
 *
 * An agreement is the contract and billing rule that joins the companies'
 * subscriptions to a payer: who sells, who pays, in which currency, how
 * often, under which mode. The three modes — an internal licence allocated as
 * cost, an invoiced related party, an external enterprise customer — are
 * billing choices and nothing else: every one of them meters seats, ACUs,
 * documents and storage the same way, through the same wallet and the same
 * entitlement checks. A group display name is not a billing identity; the
 * seller and payer are named legal entities, and where the payer is one of
 * the group's own companies its tenancy is referenced by id.
 *
 * The agreement is versioned and effective-dated. A version is set as a
 * draft by the platform operator and approved by the group; the version in
 * force at a moment is the latest approved one whose effective window covers
 * it. Nothing here is a claim about transfer pricing or tax: the record holds
 * the terms that were approved, and finance reads the related-party
 * classification off the mode.
 *
 * A company's subscription is the record `billing/subscription.ts` already
 * keeps — one active suite subscription per tenancy — read here as the
 * spec's line items: the product (the package, with its seat allocation)
 * and every restricted module the company holds. CONSTRUX is the one
 * product on this platform, so a suite subscription has one product item.
 */

export const AGREEMENT_MODES = ['INTERNAL_COST_ALLOCATION', 'INVOICED_INTERCOMPANY', 'EXTERNAL_ENTERPRISE'] as const;
export type AgreementMode = (typeof AGREEMENT_MODES)[number];
export const BILLING_CADENCES = ['MONTHLY', 'QUARTERLY', 'ANNUAL'] as const;
export type BillingCadence = (typeof BILLING_CADENCES)[number];

/** A named legal entity on the agreement; one of the group's own companies where it is one. */
export type AgreementParty = { legalName: string; tenantId: string | null };

export type AgreementVersion = {
  version: number;
  mode: AgreementMode;
  seller: AgreementParty;
  payer: AgreementParty;
  currency: string;
  cadence: BillingCadence;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** Which price list the terms were approved against. The platform's catalogue is the one in `billing/seats.ts`. */
  pricingPolicyVersion: string;
  status: 'DRAFT' | 'APPROVED' | 'SUPERSEDED';
  note: string;
  setBy: string;
  setAt: string;
  approvedBy?: string;
  approvedAt?: string;
};

export type Agreement = {
  /** The group's id: one agreement per group. */
  id: string;
  groupId: string;
  versions: AgreementVersion[];
  createdAt: string;
  updatedAt: string;
};

const governance = (groupId: string) => `${groupId}-governance`;

/** The cost-centre charge mode an agreement mode implies for a company brought in under it. */
export function chargeModeFor(mode: AgreementMode): ChargeMode {
  return mode === 'INTERNAL_COST_ALLOCATION' ? 'INTERNAL' : mode === 'INVOICED_INTERCOMPANY' ? 'INTERCOMPANY' : 'EXTERNAL';
}

export function agreementOf(platform: Platform, groupId: string): Agreement | undefined {
  const record = platform.ledger.get({ refType: 'Agreement', refId: groupId });
  return record ? (record.state as unknown as Agreement) : undefined;
}

/** The version in force at a moment: the latest approved whose window covers it. */
export function agreementInForce(agreement: Agreement | undefined, at = new Date().toISOString()): AgreementVersion | null {
  if (!agreement) return null;
  const live = agreement.versions
    .filter((version) => version.status === 'APPROVED' && version.effectiveFrom <= at && (version.effectiveTo === null || version.effectiveTo > at))
    .sort((a, b) => b.version - a.version);
  return live[0] ?? null;
}

function commitAgreement(platform: Platform, actorId: string, agreement: Agreement, eventType: 'AGREEMENT_SET' | 'AGREEMENT_APPROVED'): void {
  platform.ledger.commit({
    tenantId: agreement.groupId,
    projectId: governance(agreement.groupId),
    actor: { refType: 'User', refId: actorId },
    source: 'WEB',
    correlationId: ulid(),
    eventType,
    entity: { refType: 'Agreement', refId: agreement.id },
    nextState: { ...agreement } as unknown as Record<string, unknown>,
  });
}

function assertParty(party: AgreementParty | undefined, field: string, platform: Platform, group: Group): AgreementParty {
  if (!party || !party.legalName?.trim()) throw new DomainError('AGREEMENT_PARTY_REQUIRED', `The ${field} is a named legal entity`);
  const tenantId = party.tenantId ?? null;
  if (tenantId !== null) {
    if (tenantId === 'platform') return { legalName: party.legalName.trim().slice(0, 200), tenantId };
    if (!group.costCentres.some((centre) => centre.tenantId === tenantId)) {
      throw new DomainError('AGREEMENT_PARTY_NOT_IN_GROUP', `The ${field} names a tenancy that is not one of ${group.displayName}'s companies`, 422);
    }
  }
  return { legalName: party.legalName.trim().slice(0, 200), tenantId };
}

/**
 * Set the terms as a new draft version (platform operator). Nothing changes
 * for billing until the group approves it: a draft is what the spec calls
 * keeping billing in draft until the commercial details are approved.
 */
export function setAgreement(
  platform: Platform,
  actor: AuthContext,
  groupId: string,
  input: { mode: AgreementMode; seller: AgreementParty; payer: AgreementParty; currency?: string; cadence?: BillingCadence; effectiveFrom?: string; note?: string; pricingPolicyVersion?: string },
): Agreement {
  const group = groupOf(platform, groupId);
  if (!AGREEMENT_MODES.includes(input.mode)) throw new DomainError('AGREEMENT_MODE_UNKNOWN', `${input.mode} is not an agreement mode. One of: ${AGREEMENT_MODES.join(', ')}`);
  const cadence = input.cadence ?? 'MONTHLY';
  if (!BILLING_CADENCES.includes(cadence)) throw new DomainError('CADENCE_UNKNOWN', `${cadence} is not a billing cadence`);
  const currency = (input.currency ?? group.billing.currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new DomainError('CURRENCY_INVALID', 'The agreement currency is a three-letter code');
  const effectiveFrom = input.effectiveFrom ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(effectiveFrom))) throw new DomainError('EFFECTIVE_FROM_INVALID', 'effectiveFrom is an ISO date-time');
  const seller = assertParty(input.seller, 'seller', platform, group);
  const payer = assertParty(input.payer, 'payer', platform, group);
  if (input.mode === 'INVOICED_INTERCOMPANY' && (seller.tenantId === null || payer.tenantId === null)) {
    throw new DomainError('INTERCOMPANY_PARTIES', 'An intercompany agreement is between two of the group\'s own companies; name both by tenancy', 422);
  }

  const now = new Date().toISOString();
  const existing = agreementOf(platform, groupId);
  const version: AgreementVersion = {
    version: (existing?.versions.length ?? 0) + 1,
    mode: input.mode,
    seller,
    payer,
    currency,
    cadence,
    effectiveFrom: new Date(effectiveFrom).toISOString(),
    effectiveTo: null,
    pricingPolicyVersion: input.pricingPolicyVersion?.trim() || 'construx-catalogue-v1',
    status: 'DRAFT',
    note: (input.note ?? '').trim().slice(0, 1000),
    setBy: actor.actorId,
    setAt: now,
  };
  const agreement: Agreement = {
    id: groupId,
    groupId,
    versions: [...(existing?.versions ?? []).filter((held) => held.status !== 'DRAFT'), version],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  commitAgreement(platform, actor.actorId, agreement, 'AGREEMENT_SET');
  return agreement;
}

/**
 * Approve the draft (group administrator or finance). The previously
 * approved version, if any, ends where this one begins, so the record is
 * effective-dated rather than overwritten.
 */
export function approveAgreement(platform: Platform, actor: AuthContext, groupId: string, version: number): Agreement {
  const agreement = agreementOf(platform, groupId);
  if (!agreement) throw new NotFoundError(`No agreement has been set for group ${groupId}`);
  const draft = agreement.versions.find((held) => held.version === version);
  if (!draft) throw new NotFoundError(`No agreement version ${version}`);
  if (draft.status !== 'DRAFT') throw new DomainError('AGREEMENT_NOT_DRAFT', `Version ${version} is ${draft.status.toLowerCase()}`, 409);
  const now = new Date().toISOString();
  const versions = agreement.versions.map((held) => {
    if (held.version === version) return { ...held, status: 'APPROVED' as const, approvedBy: actor.actorId, approvedAt: now };
    if (held.status === 'APPROVED' && held.effectiveTo === null) return { ...held, status: 'SUPERSEDED' as const, effectiveTo: draft.effectiveFrom };
    return held;
  });
  const approved: Agreement = { ...agreement, versions, updatedAt: now };
  commitAgreement(platform, actor.actorId, approved, 'AGREEMENT_APPROVED');
  return approved;
}

// --- a company's subscription as line items --------------------------------------

export type SubscriptionItem = {
  code: string;
  kind: 'PRODUCT' | 'MODULE';
  label: string;
  billingUnit: 'SUITE_MONTH' | 'MODULE_GRANT';
  /** List price per period in the tenancy's currency; a restricted module has no list price. */
  priceMinor: number | null;
  priceVersion: string;
  seats: { included: number | null; used: number } | null;
  start: string;
  end: string | null;
};

export function tenantSubscriptionItems(platform: Platform, tenantId: string): {
  subscriptionId: string;
  tenantId: string;
  state: string;
  package: string;
  startedAt: string;
  renewsAt: string;
  currency: string;
  items: SubscriptionItem[];
} {
  const subscription = platform.subscription(tenantId);
  const tenant = platform.tenant(tenantId);
  const pkg = PACKAGES[subscription.package];
  const items: SubscriptionItem[] = [
    {
      code: 'construx.core',
      kind: 'PRODUCT',
      label: pkg.label,
      billingUnit: 'SUITE_MONTH',
      priceMinor: pkg.monthlyPriceMinor,
      priceVersion: `construx-catalogue-v1:${subscription.package}`,
      seats: { included: pkg.includedSeats, used: subscription.assignedIdentities.length },
      start: subscription.startedAt,
      end: null,
    },
  ];
  for (const moduleId of platform.grantedModules(tenantId)) {
    const grant = platform.moduleGrants().find((held) => held.moduleId === moduleId && held.tenantId === tenantId);
    items.push({
      code: MODULES[moduleId].registry.moduleKey,
      kind: 'MODULE',
      label: MODULES[moduleId].name,
      billingUnit: 'MODULE_GRANT',
      priceMinor: null,
      priceVersion: 'restricted: not on the price list',
      seats: null,
      start: grant?.grantedAt ?? subscription.startedAt,
      end: null,
    });
  }
  return {
    subscriptionId: subscription.id,
    tenantId,
    state: subscription.status,
    package: subscription.package,
    startedAt: subscription.startedAt,
    renewsAt: subscription.renewsAt,
    currency: tenant.defaultCurrency,
    items,
  };
}

// --- the group billing view ----------------------------------------------------------

/**
 * Whether one invoice may cover the group's invoiced companies (§9.3): the
 * same seller, the same payer, the same currency and one period. Here the
 * seller and payer are the agreement's, so what can differ is the currency a
 * company is billed in. Companies under an internal allocation are not
 * invoiced at all; they appear on the allocation statement.
 */
export function invoiceGrouping(platform: Platform, group: Group, inForce: AgreementVersion | null): {
  single: boolean;
  reasons: string[];
  invoices: Array<{ currency: string; seller: string; payer: string; companies: string[] }>;
  allocationOnly: string[];
} {
  const reasons: string[] = [];
  if (!inForce) reasons.push('No approved agreement is in force');
  const invoiced = group.costCentres.filter((centre) => centre.chargeMode !== 'INTERNAL');
  const allocationOnly = group.costCentres.filter((centre) => centre.chargeMode === 'INTERNAL').map((centre) => platform.tenant(centre.tenantId).legalName);
  const byCurrency = new Map<string, string[]>();
  for (const centre of invoiced) {
    const currency = platform.tenant(centre.tenantId).defaultCurrency;
    byCurrency.set(currency, [...(byCurrency.get(currency) ?? []), platform.tenant(centre.tenantId).legalName]);
  }
  if (inForce && invoiced.some((centre) => platform.tenant(centre.tenantId).defaultCurrency !== inForce.currency)) {
    reasons.push(`Not every invoiced company is billed in the agreement currency ${inForce.currency}`);
  }
  if (group.billing.invoiceMode !== 'CONSOLIDATED') reasons.push('The billing account asks for an invoice per company');
  const invoices = [...byCurrency.entries()].map(([currency, companies]) => ({
    currency,
    seller: inForce?.seller.legalName ?? '',
    payer: inForce?.payer.legalName ?? '',
    companies,
  }));
  return { single: reasons.length === 0 && invoices.length <= 1, reasons, invoices, allocationOnly };
}

export function groupBilling(platform: Platform, groupId: string): {
  group: { id: string; slug: string; displayName: string; currency: string; invoiceMode: string; termsDays: number };
  agreement: Agreement | null;
  inForce: AgreementVersion | null;
  subscriptions: Array<ReturnType<typeof tenantSubscriptionItems> & { code: string; name: string; chargeMode: ChargeMode; seatLimit: number | null; seatsUsed: number }>;
  seats: { used: number; distinctPeople: number };
  invoicing: ReturnType<typeof invoiceGrouping>;
} {
  const group = groupOf(platform, groupId);
  const agreement = agreementOf(platform, groupId) ?? null;
  const inForce = agreementInForce(agreement ?? undefined);
  const subscriptions = group.costCentres.map((centre) => {
    const items = tenantSubscriptionItems(platform, centre.tenantId);
    const product = items.items.find((item) => item.kind === 'PRODUCT')!;
    return {
      ...items,
      code: centre.code,
      name: platform.tenant(centre.tenantId).legalName,
      chargeMode: centre.chargeMode,
      seatLimit: product.seats?.included ?? null,
      seatsUsed: product.seats?.used ?? 0,
    };
  });
  // One licensed active person counts once per company (§9.2); the group's
  // distinct people are the same addresses counted once, as information.
  const addresses = new Set<string>();
  let used = 0;
  for (const centre of group.costCentres) {
    for (const user of platform.users(centre.tenantId)) {
      if (user.status !== 'ACTIVE') continue;
      used += 1;
      addresses.add(user.email.toLowerCase());
    }
  }
  return {
    group: { id: group.id, slug: group.slug, displayName: group.displayName, currency: group.billing.currency, invoiceMode: group.billing.invoiceMode, termsDays: group.billing.termsDays },
    agreement,
    inForce,
    subscriptions,
    seats: { used, distinctPeople: addresses.size },
    invoicing: invoiceGrouping(platform, group, inForce),
  };
}
