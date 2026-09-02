import { DomainError } from '../core/errors.ts';

/**
 * Transaction revenue: what the platform earns when money moves through it,
 * and the settlement record that proves what was taken and why.
 *
 * ## Why this is separate from every other money path already here
 *
 * Three exist already and none of them is this.
 *
 * - **Subscription charges** are what a tenancy pays to hold the platform. Flat,
 *   monthly, unrelated to how much work goes through it.
 * - **ACU consumption** is what a tenancy pays for AI it ran.
 * - **Payment certificates** are construction contract money under the
 *   Construction Act — the customer's own money, moving between the customer
 *   and their supply chain. The platform is not a party to it.
 *
 * Transaction revenue is a fourth thing: a fee taken on the third of those,
 * where the platform actually carried the money rather than merely recording it.
 * Conflating it with any of the others is how a platform ends up unable to
 * answer "what did you charge me and for what", which is the question that
 * ends a supplier relationship.
 *
 * ## The rule that governs the whole file
 *
 * **A fee is only earnable where the platform did something.** Recording a
 * payment certificate is not a service anybody should be charged a percentage
 * for; it is what the subscription buys. A fee is earned where the platform
 * *carried* the payment — took it in, held it, paid it out — because that is a
 * service with a cost and a risk attached.
 *
 * So `FACILITATED` is the only rail that earns. `RECORDED` exists precisely so
 * the refusal is representable: a transaction the platform observed but did not
 * carry produces a settlement record with a zero fee and a stated reason,
 * rather than no record at all. A silent absence is indistinguishable from a
 * bug.
 *
 * ## Why the fee is banded and capped
 *
 * An uncapped percentage on construction payments is not a pricing model, it is
 * a tax. A £4.2M interim certificate at even 0.4% is £16,800 for moving money
 * that took the same effort as moving £40,000 — and the customer who notices
 * that leaves, correctly. The bands fall as value rises and the cap is absolute.
 *
 * The floor exists for the same reason in the other direction: a £180 payment
 * at 0.4% is 72p, which does not cover the transfer, and a fee that loses money
 * on small transactions makes the platform hostile to exactly the small
 * subcontractors it should serve.
 */

export type SettlementRail =
  /** The platform took the money in, held it, and paid it out. Earns a fee. */
  | 'FACILITATED'
  /** The parties paid each other directly. Recorded here, charged nothing. */
  | 'RECORDED';

export type SettlementStatus = 'PENDING' | 'SETTLED' | 'REVERSED';

/**
 * The fee bands, in minor units of the transaction currency.
 *
 * Read as: up to `uptoMinor`, the rate is `rate`. Ordered ascending and checked
 * by a test, because a band table out of order silently prices the largest
 * transactions at the smallest band's rate.
 */
export const FEE_BANDS = [
  { uptoMinor: 5_000_00, rate: 0.009 },
  { uptoMinor: 50_000_00, rate: 0.006 },
  { uptoMinor: 250_000_00, rate: 0.003 },
  { uptoMinor: Number.POSITIVE_INFINITY, rate: 0.0015 },
] as const;

/** Never less than this, or the transfer costs more than the fee. */
export const FEE_FLOOR_MINOR = 150;

/**
 * Never more than this, whatever the transaction.
 *
 * The single most important number in this file. Without it the platform's
 * revenue scales with the customer's contract value rather than with what the
 * platform did, and the first customer to run a £20M certificate through it
 * discovers a five-figure fee for a bank transfer.
 */
export const FEE_CAP_MINOR = 75_000;

export type FeeBreakdown = {
  amountMinor: number;
  rail: SettlementRail;
  /** The band rate applied, before floor and cap. Zero on a recorded transaction. */
  rate: number;
  /** What the rate alone produced, so the console can show the working. */
  rawMinor: number;
  feeMinor: number;
  /** Which limit moved the figure, where one did. */
  adjustedBy?: 'FLOOR' | 'CAP';
  /** Stated on every fee, including the zero ones. */
  basis: string;
};

/**
 * What the platform earns on one transaction.
 *
 * Pure arithmetic on the amount and the rail. It reads no configuration a
 * customer cannot see and holds no per-customer rate, because a fee that
 * differs by customer without either of them being able to say why is a dispute
 * with a delay fuse in it.
 */
export function feeFor(amountMinor: number, rail: SettlementRail): FeeBreakdown {
  if (!Number.isInteger(amountMinor) || amountMinor < 0) {
    throw new DomainError(
      'SETTLEMENT_AMOUNT_INVALID',
      `A settlement amount must be a whole number of minor units and not negative; this one is ${amountMinor}. ` +
        'A fractional or negative amount here would produce a fee nobody could reconcile against a bank statement.',
    );
  }

  if (rail === 'RECORDED') {
    return {
      amountMinor,
      rail,
      rate: 0,
      rawMinor: 0,
      feeMinor: 0,
      basis:
        'The parties paid each other directly and this platform carried no money. Recording a payment is what the ' +
        'subscription buys; nothing further is charged for it.',
    };
  }

  const band = FEE_BANDS.find((candidate) => amountMinor <= candidate.uptoMinor) ?? FEE_BANDS[FEE_BANDS.length - 1]!;
  const rawMinor = Math.round(amountMinor * band.rate);

  // A zero-value transaction earns nothing. The floor exists to cover the cost
  // of moving money, and no money moved.
  if (amountMinor === 0) {
    return {
      amountMinor,
      rail,
      rate: band.rate,
      rawMinor: 0,
      feeMinor: 0,
      basis: 'Nothing moved, so nothing is charged.',
    };
  }

  if (rawMinor > FEE_CAP_MINOR) {
    return {
      amountMinor,
      rail,
      rate: band.rate,
      rawMinor,
      feeMinor: FEE_CAP_MINOR,
      adjustedBy: 'CAP',
      basis:
        `${(band.rate * 100).toFixed(2)}% of the transaction is more than the cap, so the cap applies. The fee is for ` +
        'carrying the payment, and carrying a large one is not proportionally more work than carrying a small one.',
    };
  }

  if (rawMinor < FEE_FLOOR_MINOR) {
    return {
      amountMinor,
      rail,
      rate: band.rate,
      rawMinor,
      feeMinor: FEE_FLOOR_MINOR,
      adjustedBy: 'FLOOR',
      basis:
        `${(band.rate * 100).toFixed(2)}% of this transaction is less than the cost of making the transfer, so the ` +
        'floor applies.',
    };
  }

  return {
    amountMinor,
    rail,
    rate: band.rate,
    rawMinor,
    feeMinor: rawMinor,
    basis: `${(band.rate * 100).toFixed(2)}% of the transaction, the band this value falls in.`,
  };
}

export type SettlementRecord = {
  id: string;
  tenantId: string;
  projectId: string;
  /** The certificate, invoice or order this money was against. */
  againstRef: { refType: string; refId: string };
  amountMinor: number;
  currency: string;
  rail: SettlementRail;
  status: SettlementStatus;
  feeMinor: number;
  /** What the payee actually receives. Always `amount − fee`, and checked. */
  netMinor: number;
  basis: string;
  raisedAt: string;
  settledAt?: string;
  reversedAt?: string;
  reversalReason?: string;
  /** The payer's own reference, so a bank statement can be reconciled against this. */
  externalReference?: string;
};

/**
 * Build the record. Does not commit it — the caller owns the ledger write, so
 * this file stays testable without one and cannot half-record a settlement.
 */
export function raiseSettlement(input: {
  id: string;
  tenantId: string;
  projectId: string;
  againstRef: { refType: string; refId: string };
  amountMinor: number;
  currency: string;
  rail: SettlementRail;
  externalReference?: string;
  now?: Date;
}): SettlementRecord {
  const fee = feeFor(input.amountMinor, input.rail);
  return {
    id: input.id,
    tenantId: input.tenantId,
    projectId: input.projectId,
    againstRef: input.againstRef,
    amountMinor: input.amountMinor,
    currency: input.currency,
    rail: input.rail,
    status: 'PENDING',
    feeMinor: fee.feeMinor,
    netMinor: input.amountMinor - fee.feeMinor,
    basis: fee.basis,
    raisedAt: (input.now ?? new Date()).toISOString(),
    ...(input.externalReference ? { externalReference: input.externalReference } : {}),
  };
}

/**
 * Mark a settlement as arrived.
 *
 * Refuses a second settlement of the same record. A settlement recorded twice
 * is revenue recognised twice and a payee credited twice, and the refusal is
 * here rather than in the route because a second door onto the same record
 * would otherwise reintroduce it.
 */
export function settle(record: SettlementRecord, now = new Date()): SettlementRecord {
  if (record.status === 'SETTLED') {
    throw new DomainError(
      'SETTLEMENT_ALREADY_SETTLED',
      `Settlement ${record.id} settled at ${record.settledAt}. Settling it again would recognise the fee twice and ` +
        'credit the payee twice.',
      409,
    );
  }
  if (record.status === 'REVERSED') {
    throw new DomainError(
      'SETTLEMENT_REVERSED',
      `Settlement ${record.id} was reversed${record.reversalReason ? `: ${record.reversalReason}` : ''}. A reversed ` +
        'settlement cannot be settled; raise a new one.',
      409,
    );
  }
  return { ...record, status: 'SETTLED', settledAt: now.toISOString() };
}

/**
 * Reverse a settlement, giving back the fee with it.
 *
 * The fee goes back. A platform that kept its cut of a payment that was
 * reversed has charged for a service it did not complete, and the customer
 * finds out from their bank rather than from us.
 */
export function reverse(record: SettlementRecord, reason: string, now = new Date()): SettlementRecord {
  if (record.status === 'REVERSED') {
    throw new DomainError('SETTLEMENT_ALREADY_REVERSED', `Settlement ${record.id} is already reversed`, 409);
  }
  if (!reason.trim()) {
    throw new DomainError(
      'SETTLEMENT_REVERSAL_REASON_REQUIRED',
      'A reversal moves money back and has to say why. An unexplained reversal is the entry an auditor stops on.',
    );
  }
  return {
    ...record,
    status: 'REVERSED',
    reversedAt: now.toISOString(),
    reversalReason: reason.trim(),
    // The fee is returned with the money.
    feeMinor: 0,
    netMinor: 0,
  };
}

export type TransactionRevenue = {
  /** Settled fee income. The only figure that is actually revenue. */
  earnedMinor: number;
  /** Raised and not yet settled. Intended, not earned. */
  pendingMinor: number;
  /** Given back. Shown rather than netted away, because a rising figure here is a signal. */
  reversedMinor: number;
  /** Value carried, which is the exposure rather than the income. */
  facilitatedMinor: number;
  /** Value recorded but not carried, and therefore charged nothing. */
  recordedMinor: number;
  settlements: { pending: number; settled: number; reversed: number };
  /**
   * Fee income as a share of value carried.
   *
   * The number to watch. A take rate drifting upward means the band table is
   * mispriced against what customers actually run through the platform, and it
   * is better found here than in a customer's complaint.
   */
  takeRate: number | null;
  currency: string;
};

export function transactionRevenue(records: readonly SettlementRecord[], currency = 'GBP'): TransactionRevenue {
  const mine = records.filter((record) => record.currency === currency);
  const settled = mine.filter((record) => record.status === 'SETTLED');
  const pending = mine.filter((record) => record.status === 'PENDING');
  const reversed = mine.filter((record) => record.status === 'REVERSED');

  const facilitatedMinor = settled
    .filter((record) => record.rail === 'FACILITATED')
    .reduce((total, record) => total + record.amountMinor, 0);
  const earnedMinor = settled.reduce((total, record) => total + record.feeMinor, 0);

  return {
    earnedMinor,
    pendingMinor: pending.reduce((total, record) => total + record.feeMinor, 0),
    // The fee that *was* on them, which the record no longer carries because
    // reversal zeroes it. Reconstructed from the amount and rail so the figure
    // is what was given back rather than zero.
    reversedMinor: reversed.reduce((total, record) => total + feeFor(record.amountMinor, record.rail).feeMinor, 0),
    facilitatedMinor,
    recordedMinor: settled
      .filter((record) => record.rail === 'RECORDED')
      .reduce((total, record) => total + record.amountMinor, 0),
    settlements: { pending: pending.length, settled: settled.length, reversed: reversed.length },
    takeRate: facilitatedMinor > 0 ? earnedMinor / facilitatedMinor : null,
    currency,
  };
}
