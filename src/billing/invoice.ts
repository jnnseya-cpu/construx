import { ulid } from '../core/ids.ts';
import type { ACUWallet } from './acu.ts';
import { monthlySubscriptionCharge, type Subscription, TIERS } from './subscription.ts';

/**
 * Invoicing — the customer-facing reconciliation of the two revenue lines:
 * a fixed subscription for access, and variable AI usage in ACUs at a
 * disclosed multiplier. Every AI line traces to project, user, module and
 * feature, which is what makes the model audit-defensible.
 */

export type InvoiceLine = {
  description: string;
  quantity: number;
  unitMinor: number;
  amountMinor: number;
  category: 'SUBSCRIPTION' | 'AI_USAGE';
  projectId?: string;
  module?: string;
};

export type Invoice = {
  id: string;
  tenantId: string;
  period: string;
  currency: string;
  issuedAt: string;
  lines: InvoiceLine[];
  subscriptionMinor: number;
  aiUsageMinor: number;
  aiRawCostMinor: number;
  effectiveMultiplier: number;
  totalMinor: number;
  /** Reproduced on the invoice so the multiplier is never a surprise. */
  commercialTerms: string[];
};

export function buildInvoice(
  subscription: Subscription,
  wallet: ACUWallet,
  period: string,
  currency = 'USD',
): Invoice {
  const tier = TIERS[subscription.tier];
  // The package charge is already in minor units — the whole billing path works
  // in pence so nothing rounds twice.
  const subscriptionMinor = monthlySubscriptionCharge(subscription);

  const lines: InvoiceLine[] = [
    {
      description: `CONSTRUX platform subscription — ${tier.tier} (${
        tier.includedIdentities === null ? 'unlimited' : tier.includedIdentities
      } identities, ${subscription.assignedIdentities.length} assigned)`,
      quantity: 1,
      unitMinor: subscriptionMinor,
      amountMinor: subscriptionMinor,
      category: 'SUBSCRIPTION',
    },
  ];

  let aiUsageMinor = 0;
  let aiRawCostMinor = 0;

  for (const attribution of wallet.attributionByModule(period)) {
    aiUsageMinor += attribution.billedMinor;
    aiRawCostMinor += attribution.rawCostMinor;
    lines.push({
      description: `AI usage — ${attribution.module} (${attribution.calls} execution${attribution.calls === 1 ? '' : 's'})`,
      quantity: attribution.calls,
      unitMinor: attribution.calls === 0 ? 0 : Math.round(attribution.billedMinor / attribution.calls),
      amountMinor: attribution.billedMinor,
      category: 'AI_USAGE',
      module: attribution.module,
    });
  }

  const multiplier = aiRawCostMinor === 0 ? 0 : Number((aiUsageMinor / aiRawCostMinor).toFixed(2));

  return {
    id: ulid(),
    tenantId: subscription.tenantId,
    period,
    currency,
    issuedAt: new Date().toISOString(),
    lines,
    subscriptionMinor,
    aiUsageMinor,
    aiRawCostMinor,
    effectiveMultiplier: multiplier,
    totalMinor: subscriptionMinor + aiUsageMinor,
    commercialTerms: [
      'Subscription fees cover platform access, identity management, governance, auditability and non-AI functionality.',
      'AI services are billed on actual consumption, measured in AI Compute Units (ACUs).',
      'Each ACU represents the underlying third-party AI compute cost incurred by CONSTRUX.',
      'AI usage is invoiced at a fixed multiplier over underlying compute cost, applied uniformly to all client categories.',
      'Subscription fees include no AI usage entitlement.',
      'AI usage limits, alerts and hard caps may be configured by the client for budget predictability.',
    ],
  };
}

export function formatMoney(minor: number, currency = 'USD'): string {
  const symbol = currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : '$';
  return `${symbol}${(minor / 100).toFixed(2)}`;
}

/**
 * Portfolio-scale value formatter. Zero renders as $0.0M at portfolio level so
 * the header does not read "$0.0B" on an empty portfolio.
 */
export function formatContractValue(minor: number, currency = 'USD'): string {
  const symbol = currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : '$';
  const major = minor / 100;
  if (major === 0) return `${symbol}0.0M`;
  const abs = Math.abs(major);
  // Portfolio headline figures read in millions from a thousand upwards, so a
  // half-million-pound project shows as $0.5M rather than $500.0K.
  if (abs < 1_000) return `${symbol}${(major / 1_000).toFixed(1)}K`;
  if (abs < 1_000_000_000) return `${symbol}${(major / 1_000_000).toFixed(1)}M`;
  return `${symbol}${(major / 1_000_000_000).toFixed(1)}B`;
}
