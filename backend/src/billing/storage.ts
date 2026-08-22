import { config } from '../config.ts';
import { DomainError } from '../core/errors.ts';
import { PACKAGES, type PackageTier } from './seats.ts';

/**
 * Storage as a metered entitlement.
 *
 * Every package already declared a `storageGb`, it was printed on the pricing
 * page and on the billing screen, and **nothing enforced it**. That is the same
 * class of defect the ACU bundle carried: a promise to a customer that the
 * billing engine was never going to keep. A tenant on the 100 GB plan could
 * upload a terabyte, and the first anyone would know is the volume filling up.
 *
 * ---
 *
 * **Why this needs a hard stop rather than an invoice.** Nothing the ledger
 * names is deletable — an evidence record can be argued over for as long as the
 * contract can be sued on — so a tenant's usage only ever goes up. There is no
 * natural point at which an over-quota tenant returns to quota, which means
 * "bill them for the overage" is a bill that grows for ever against storage the
 * platform can never reclaim. Refusing the write is the only lever that closes.
 *
 * **Why 70% is a flag and not a nag.** It is roughly a quarter's warning at the
 * rate an active project accumulates photographs, which is enough time to buy
 * capacity or start a conversation about the plan. Warning at 90% would arrive
 * after the decision needed making.
 *
 * **No package is uncapped.** Unlimited storage against a record nothing can be
 * deleted from is an unbounded liability, so every package carries a real
 * figure — the smallest that reaches the flag no sooner than twelve months of
 * typical use. That also removes a whole branch from everything downstream: a
 * position always has a limit, a percentage is always a number, and there is no
 * second path through the console for the tenancy that could never be refused.
 *
 * **What is refused, and what is never refused.** The stop applies to uploading
 * *bytes*. It does not apply to recording events, raising an RFI, certifying a
 * payment or signing anything — a full disk must not stop a contract from being
 * administered. The evidence hash is still committed to the ledger; what fails
 * is supplying the file, and the record says so rather than pretending the
 * evidence is held.
 */

/** The unit capacity is sold in. One block, one price, no bespoke sizes. */
export const STORAGE_BLOCK_GB = 100;

/**
 * Where the warning starts, as a share of the entitlement.
 *
 * A constant rather than a setting: a tenant who could move their own threshold
 * to 95% would be buying themselves a surprise, and one who could move it to
 * 30% would be generating noise the platform then has to explain.
 */
export const STORAGE_WARN_AT = 0.7;

const BYTES_PER_GB = 1024 * 1024 * 1024;

export type StorageState = 'OK' | 'WARNING' | 'FULL';

export type StoragePosition = {
  package: PackageTier;
  usedBytes: number;
  limitBytes: number;
  includedGb: number;
  purchasedBlocks: number;
  purchasedGb: number;
  percentUsed: number;
  remainingBytes: number;
  state: StorageState;
  /** What the next upload will do. The console leads with this. */
  summary: string;
  /** Present from WARNING onward: what buying one more block would give. */
  nextBlock?: { gb: number; priceMinor: number; wouldTakeTo: string };
};

/** The entitlement: what the package includes, plus what has been bought. */
export function allowanceBytes(tier: PackageTier, purchasedBlocks: number): number {
  return (PACKAGES[tier].storageGb + purchasedBlocks * STORAGE_BLOCK_GB) * BYTES_PER_GB;
}

function readable(bytes: number): string {
  if (bytes >= BYTES_PER_GB) return `${(bytes / BYTES_PER_GB).toFixed(bytes >= 10 * BYTES_PER_GB ? 0 : 1)} GB`;
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

export function storagePosition(input: {
  tier: PackageTier;
  usedBytes: number;
  purchasedBlocks: number;
}): StoragePosition {
  const limitBytes = allowanceBytes(input.tier, input.purchasedBlocks);
  const includedGb = PACKAGES[input.tier].storageGb;
  const purchasedGb = input.purchasedBlocks * STORAGE_BLOCK_GB;

  const percentUsed = Number(((input.usedBytes / limitBytes) * 100).toFixed(1));
  const remainingBytes = Math.max(0, limitBytes - input.usedBytes);
  const state: StorageState =
    input.usedBytes >= limitBytes ? 'FULL' : percentUsed >= STORAGE_WARN_AT * 100 ? 'WARNING' : 'OK';

  const nextBlock =
    state === 'OK'
      ? undefined
      : {
          gb: STORAGE_BLOCK_GB,
          priceMinor: config.billing.storageBlockPriceMinor,
          wouldTakeTo: readable(limitBytes + STORAGE_BLOCK_GB * BYTES_PER_GB),
        };

  const summary =
    state === 'FULL'
      ? `${readable(input.usedBytes)} of ${readable(limitBytes)} used. Uploads are refused until capacity is added. ` +
        'Records, approvals and signatures are unaffected — what stops is supplying files, not administering the contract.'
      : state === 'WARNING'
        ? `${readable(input.usedBytes)} of ${readable(limitBytes)} used (${percentUsed}%). ` +
          `${readable(remainingBytes)} left. Nothing already stored can be deleted to make room, so the only way ` +
          'down is more capacity.'
        : `${readable(input.usedBytes)} of ${readable(limitBytes)} used (${percentUsed}%).`;

  return {
    package: input.tier,
    usedBytes: input.usedBytes,
    limitBytes,
    includedGb,
    purchasedBlocks: input.purchasedBlocks,
    purchasedGb,
    percentUsed,
    remainingBytes,
    state,
    summary,
    ...(nextBlock ? { nextBlock } : {}),
  };
}

/**
 * Whether these bytes may be written, and why not when they may not.
 *
 * Checked against the size of *this* object rather than against the current
 * total alone: a tenant 1 MB under the line uploading a 40 MB drawing set would
 * otherwise be allowed to cross it, and the next upload would fail for a file
 * that had nothing to do with it.
 */
export function assertCapacity(position: StoragePosition, incomingBytes: number): void {
  if (position.usedBytes + incomingBytes > position.limitBytes) {
    const short = position.usedBytes + incomingBytes - position.limitBytes;
    throw new DomainError(
      'STORAGE_LIMIT_REACHED',
      `This file needs ${readable(incomingBytes)} and the plan is ${readable(short)} short of holding it. ` +
        `${readable(position.usedBytes)} of ${readable(position.limitBytes)} is in use. ` +
        `Nothing already stored can be removed — the record is append-only — so the way forward is another ` +
        `${STORAGE_BLOCK_GB} GB block. The evidence hash is still on the record; what is missing is the file.`,
      // 507 rather than 402 or 403. The request is authorised and well-formed;
      // the server cannot store the representation. That is what 507 is for,
      // and it tells a client library something 403 does not.
      507,
    );
  }
}

// --- reading the entitlement off the record ---------------------------------

/**
 * Blocks this tenancy has bought.
 *
 * Summed from the ledger rather than held as a counter, for the reason every
 * balance on this platform is: a counter is a second place the truth can live,
 * and the one that disagrees is always the one nobody is looking at.
 */
export function purchasedBlocks(
  ledger: { listByTenant: (tenantId: string, refType: string) => Array<{ state: Record<string, unknown> }> },
  tenantId: string,
): number {
  return ledger
    .listByTenant(tenantId, 'StorageEntitlement')
    .reduce((sum, record) => sum + Number(record.state.blocks ?? 0), 0);
}
