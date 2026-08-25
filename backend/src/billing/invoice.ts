import { config } from '../config.ts';
import { ulid } from '../core/ids.ts';
import { currencySymbol, formatMoney as exactMoney, toMajor } from '../domain/locale.ts';
import type { ACUWallet } from './acu.ts';
import { STORAGE_BLOCK_GB } from './storage.ts';
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
  category: 'SUBSCRIPTION' | 'STORAGE' | 'AI_USAGE';
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
  storageMinor: number;
  aiUsageMinor: number;
  aiRawCostMinor: number;
  effectiveMultiplier: number;
  /**
   * What is payable. Subscription and storage only — AI was paid for when the
   * credit was bought, and adding it here charged for it twice.
   */
  totalMinor: number;
  /** States why the lines do not sum to the total, rather than leaving it to be worked out. */
  aiUsageDrawnFromCredit: boolean;
  /** Reproduced on the invoice so the multiplier is never a surprise. */
  commercialTerms: string[];
};

export function buildInvoice(
  subscription: Subscription,
  wallet: ACUWallet,
  period: string,
  currency = 'USD',
  storageBlocks = 0,
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

  // Storage held beyond the package allowance, charged for as long as it is
  // held. This line did not exist: blocks could be bought and never appeared on
  // any invoice, so the platform carried the disk and billed nothing for it.
  const storageMinor = storageBlocks * config.billing.storageBlockPriceMinor;
  if (storageBlocks > 0) {
    lines.push({
      description: `Additional evidence storage — ${storageBlocks} × ${STORAGE_BLOCK_GB} GB block${storageBlocks === 1 ? '' : 's'}`,
      quantity: storageBlocks,
      unitMinor: config.billing.storageBlockPriceMinor,
      amountMinor: storageMinor,
      category: 'STORAGE',
    });
  }

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
    storageMinor,
    aiUsageMinor,
    aiRawCostMinor,
    effectiveMultiplier: multiplier,
    /**
     * What is payable — and AI is deliberately not in it.
     *
     * The wallet is prepaid: `acu.ts` opens with "prepaid only, no negative
     * balances, ever", credit is bought before it is spent, and an execution
     * draws the balance down. The total used to be
     * `subscriptionMinor + aiUsageMinor`, which billed that consumption a
     * second time — the customer paid once to buy the credit and again on the
     * invoice for having used it. That is not a leak in the platform's favour;
     * it is the kind of error that ends in chargebacks, refunds and an argument
     * about every other figure on the page.
     *
     * AI usage stays on the invoice as a line, because a customer is entitled
     * to see what their credit went on. It is a statement of consumption, not a
     * charge, and `aiUsageDrawnFromCredit` says so rather than leaving somebody
     * to work out why the lines do not sum to the total.
     */
    totalMinor: subscriptionMinor + storageMinor,
    aiUsageDrawnFromCredit: true,
    commercialTerms: [
      'Subscription fees cover platform access, identity management, governance, auditability and non-AI functionality.',
      'AI services are prepaid: credit is purchased in advance and drawn down as it is consumed.',
      'AI usage shown on this invoice has already been paid for at the point credit was purchased, and is stated here for transparency rather than charged again.',
      'Each ACU represents the underlying third-party AI compute cost incurred by CONSTRUX.',
      'AI credit is sold at a fixed multiplier over underlying compute cost, applied uniformly to all client categories.',
      'Subscription fees include no AI usage entitlement beyond the monthly allowance stated on the plan.',
      'Additional evidence storage is charged monthly for as long as it is held.',
      'AI usage limits, alerts and hard caps may be configured by the client for budget predictability.',
    ],
  };
}

export function formatMoney(minor: number, currency = 'USD'): string {
  return exactMoney(minor, currency);
}

/**
 * Portfolio-scale value formatter. Zero renders as $0.0M at portfolio level so
 * the header does not read "$0.0B" on an empty portfolio.
 */
export function formatContractValue(minor: number, currency = 'USD'): string {
  const symbol = currencySymbol(currency);
  const major = toMajor(minor, currency);
  if (major === 0) return `${symbol}0.0M`;
  const abs = Math.abs(major);
  // Portfolio headline figures read in millions from a thousand upwards, so a
  // half-million-pound project shows as £0.5M rather than £500.0K.
  if (abs < 1_000) return `${symbol}${(major / 1_000).toFixed(1)}K`;
  if (abs < 1_000_000_000) return `${symbol}${(major / 1_000_000).toFixed(1)}M`;
  return `${symbol}${(major / 1_000_000_000).toFixed(1)}B`;
}
