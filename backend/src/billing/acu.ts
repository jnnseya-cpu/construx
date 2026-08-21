import { config } from '../config.ts';
import { ACUExhaustedError, DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';

/**
 * The ACU ledger — survival economics, enforced rather than hoped for.
 *
 * Rules that are not negotiable anywhere in the platform:
 *   - Prepaid only. No negative balances, ever.
 *   - Every provider call is charged at a fixed multiplier over raw cost.
 *   - Sequence is atomic: reserve -> execute -> persist -> debit. A hold that
 *     is never settled is released; no debit occurs without a Golden Thread write.
 *   - AI execution halts automatically when credits are exhausted.
 *
 * Amounts are held in integer minor units (pence/cents). Floating point money
 * is how ledgers drift, and this one has to reconcile against invoices.
 */

export type ACUEntryType = 'TOP_UP' | 'HOLD' | 'DEBIT' | 'RELEASE' | 'GRANT' | 'REFUND';

/**
 * What each entry type does to the balance, in one place.
 *
 * `HOLD` and `RELEASE` are recorded but move nothing: a hold reserves against
 * the *available* balance without spending it, which is why `available()`
 * subtracts held funds rather than the balance doing so. Getting this wrong in
 * two places is how a ledger drifts, so it is written once and both the live
 * path and the restore path fold through it.
 */
export function balanceEffect(entry: { type: ACUEntryType; billedMinor: number }): number {
  switch (entry.type) {
    case 'TOP_UP':
    case 'GRANT':
    case 'REFUND':
      return entry.billedMinor;
    case 'DEBIT':
      return -entry.billedMinor;
    case 'HOLD':
    case 'RELEASE':
      return 0;
  }
}

export type ACUEntry = {
  id: string;
  tenantId: string;
  projectId?: string;
  userId?: string;
  module?: string;
  feature?: string;
  provider?: string;
  type: ACUEntryType;
  /** Raw third-party cost in minor units, before markup. */
  rawCostMinor: number;
  /** ACU units consumed — 1 ACU == 1 minor unit of raw provider cost by default. */
  acuUnits: number;
  /** What the customer is charged, in minor units: rawCost x effective multiplier. */
  billedMinor: number;
  effectiveMultiplier: number;
  timestamp: string;
  aiRequestId?: string;
  invoiceId?: string;
  note?: string;
};

export type ACUCaps = {
  /** Hard ceiling per calendar month, in billed minor units. Budget protection. */
  monthlyMinor?: number;
  perProjectMinor?: Record<string, number>;
  perModuleMinor?: Record<string, number>;
};

/** A ceiling a charge would breach, before it is turned into a sentence. */
export type CapBreach = {
  scope: 'MONTHLY' | 'PROJECT' | 'MODULE';
  capMinor: number;
  spentMinor: number;
  /** The project or module the cap applies to. Absent for the monthly cap. */
  scopeId?: string;
};

export type ACUAlert = {
  threshold: 50 | 80 | 100;
  scope: 'MONTHLY' | 'PROJECT' | 'MODULE';
  scopeId?: string;
  raisedAt: string;
  consumedMinor: number;
  capMinor: number;
};

/**
 * Volume incentive: large consumers get a lower effective multiplier while the
 * platform stays profitable. Thresholds are on monthly *raw* AI spend.
 */
const VOLUME_BANDS: Array<{ upToRawMinor: number; multiplier: number }> = [
  { upToRawMinor: 200_000, multiplier: 3.0 },
  { upToRawMinor: 1_000_000, multiplier: 2.7 },
  { upToRawMinor: Number.POSITIVE_INFINITY, multiplier: 2.5 },
];

export function effectiveMultiplier(monthlyRawSpendMinor: number, volumeIncentiveEnabled: boolean): number {
  if (!volumeIncentiveEnabled) return config.billing.markupMultiplier;
  for (const band of VOLUME_BANDS) {
    if (monthlyRawSpendMinor <= band.upToRawMinor) return band.multiplier;
  }
  return config.billing.markupMultiplier;
}

export type Hold = {
  holdId: string;
  tenantId: string;
  projectId?: string;
  userId?: string;
  module?: string;
  feature?: string;
  aiRequestId: string;
  /** Estimated billed amount ring-fenced until the execution settles. */
  heldMinor: number;
  createdAt: string;
};

export type WalletSnapshot = {
  tenantId: string;
  balanceMinor: number;
  heldMinor: number;
  availableMinor: number;
  lifetimeBilledMinor: number;
  lifetimeRawCostMinor: number;
  monthRawSpendMinor: number;
  monthBilledMinor: number;
  caps: ACUCaps;
  alerts: ACUAlert[];
  aiHalted: boolean;
  haltReason?: string;
};

function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

export class ACUWallet {
  readonly tenantId: string;
  #balanceMinor = 0;
  #caps: ACUCaps = {};
  #volumeIncentive: boolean;
  readonly #entries: ACUEntry[] = [];
  readonly #holds = new Map<string, Hold>();
  readonly #alerts: ACUAlert[] = [];
  #raisedAlertKeys = new Set<string>();
  #sink: ((entry: ACUEntry) => void) | undefined;

  constructor(tenantId: string, options: { volumeIncentive?: boolean } = {}) {
    this.tenantId = tenantId;
    this.#volumeIncentive = options.volumeIncentive ?? false;
  }

  // --- Funding ---------------------------------------------------------------

  topUp(amountMinor: number, note = 'Prepaid ACU purchase'): ACUEntry {
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      throw new DomainError('ACU_INVALID_AMOUNT', 'Top-up must be a positive integer in minor units');
    }
    return this.#record(
      { type: 'TOP_UP', billedMinor: amountMinor, rawCostMinor: 0, acuUnits: 0, effectiveMultiplier: 0, note },
      amountMinor,
    );
  }

  /** The free-trial grant. Same enforcement as paid credit, no auto top-up. */
  grantTrialCredit(amountMinor = config.billing.freeTrialGrantMinor): ACUEntry {
    return this.#record(
      {
        type: 'GRANT',
        billedMinor: amountMinor,
        rawCostMinor: 0,
        acuUnits: 0,
        effectiveMultiplier: 0,
        note: 'Free trial ACU grant',
      },
      amountMinor,
    );
  }

  setCaps(caps: ACUCaps): void {
    this.#caps = caps;
  }

  setVolumeIncentive(enabled: boolean): void {
    this.#volumeIncentive = enabled;
  }

  // --- Reserve -> settle -----------------------------------------------------

  /**
   * Ring-fence funds before a provider is called. If this throws, no provider
   * call happens — that is the whole point of holding first.
   */
  /**
   * What a reservation of this size would cost, and whether it would succeed.
   *
   * Shares every rule with `reserve` — the same multiplier, the same balance
   * check, the same caps — but holds nothing and writes nothing. Two separate
   * calculations would eventually disagree, and the one a user was shown is the
   * one they would remember.
   */
  quote(estimatedRawCostMinor: number, projectId?: string, module?: string): {
    chargeMinor: number;
    multiplier: number;
    availableMinor: number;
    blockedReason?: string;
    /** What stopped it, for a caller that would rather word the message itself. */
    blockedBy?: 'BALANCE' | 'CAP';
    capBreach?: CapBreach;
  } {
    const multiplier = effectiveMultiplier(this.monthRawSpendMinor(), this.#volumeIncentive);
    const chargeMinor = Math.ceil(estimatedRawCostMinor * multiplier);
    const availableMinor = this.availableMinor();

    if (chargeMinor > availableMinor) {
      return {
        chargeMinor,
        multiplier,
        availableMinor,
        blockedBy: 'BALANCE',
        blockedReason: `Insufficient ACU balance: ${chargeMinor} required, ${availableMinor} available.`,
      };
    }

    const capBreach = this.#capBreach(chargeMinor, projectId, module);
    if (capBreach) {
      return {
        chargeMinor,
        multiplier,
        availableMinor,
        blockedBy: 'CAP',
        capBreach,
        blockedReason: this.#checkCaps(chargeMinor, projectId, module),
      };
    }

    return { chargeMinor, multiplier, availableMinor };
  }

  reserve(input: {
    aiRequestId: string;
    estimatedRawCostMinor: number;
    projectId?: string;
    userId?: string;
    module?: string;
    feature?: string;
  }): Hold {
    const multiplier = effectiveMultiplier(this.monthRawSpendMinor(), this.#volumeIncentive);
    const heldMinor = Math.ceil(input.estimatedRawCostMinor * multiplier);

    if (heldMinor > this.availableMinor()) {
      throw new ACUExhaustedError(
        `Insufficient ACU balance: ${heldMinor} required, ${this.availableMinor()} available. AI execution halted.`,
      );
    }

    const capBreach = this.#checkCaps(heldMinor, input.projectId, input.module);
    if (capBreach) throw new ACUExhaustedError(capBreach);

    const hold: Hold = {
      holdId: ulid(),
      tenantId: this.tenantId,
      aiRequestId: input.aiRequestId,
      heldMinor,
      createdAt: new Date().toISOString(),
      projectId: input.projectId,
      userId: input.userId,
      module: input.module,
      feature: input.feature,
    };
    this.#holds.set(hold.holdId, hold);
    this.#record({
      type: 'HOLD',
      billedMinor: heldMinor,
      rawCostMinor: input.estimatedRawCostMinor,
      acuUnits: input.estimatedRawCostMinor,
      effectiveMultiplier: multiplier,
      projectId: input.projectId,
      userId: input.userId,
      module: input.module,
      feature: input.feature,
      aiRequestId: input.aiRequestId,
    });
    return hold;
  }

  /**
   * Settle a hold against the real provider cost. Called only after the
   * execution's output has been written to the Golden Thread — no debit
   * without a ledger write.
   */
  settle(holdId: string, actualRawCostMinor: number, provider: string): ACUEntry {
    const hold = this.#holds.get(holdId);
    if (!hold) throw new DomainError('ACU_HOLD_NOT_FOUND', `Hold ${holdId} does not exist or is already settled`);

    const multiplier = effectiveMultiplier(this.monthRawSpendMinor(), this.#volumeIncentive);
    const billedMinor = Math.ceil(actualRawCostMinor * multiplier);

    // An execution that overruns its estimate is capped at the held amount:
    // the customer is never charged more than was reserved and disclosed.
    const chargedMinor = Math.min(billedMinor, hold.heldMinor);

    this.#holds.delete(holdId);

    const entry = this.#record({
      type: 'DEBIT',
      billedMinor: chargedMinor,
      rawCostMinor: actualRawCostMinor,
      acuUnits: actualRawCostMinor,
      effectiveMultiplier: multiplier,
      provider,
      projectId: hold.projectId,
      userId: hold.userId,
      module: hold.module,
      feature: hold.feature,
      aiRequestId: hold.aiRequestId,
    }, -chargedMinor);

    this.#evaluateAlerts();
    return entry;
  }

  /** Release a hold without charging — used when an execution fails. */
  release(holdId: string, reason = 'AI execution failed'): ACUEntry | undefined {
    const hold = this.#holds.get(holdId);
    if (!hold) return undefined;
    this.#holds.delete(holdId);
    return this.#record({
      type: 'RELEASE',
      billedMinor: 0,
      rawCostMinor: 0,
      acuUnits: 0,
      effectiveMultiplier: 0,
      projectId: hold.projectId,
      userId: hold.userId,
      module: hold.module,
      feature: hold.feature,
      aiRequestId: hold.aiRequestId,
      note: reason,
    });
  }

  // --- Introspection ---------------------------------------------------------

  heldMinor(): number {
    let total = 0;
    for (const hold of this.#holds.values()) total += hold.heldMinor;
    return total;
  }

  availableMinor(): number {
    return this.#balanceMinor - this.heldMinor();
  }

  monthRawSpendMinor(now = new Date().toISOString()): number {
    const key = monthKey(now);
    return this.#entries
      .filter((e) => e.type === 'DEBIT' && monthKey(e.timestamp) === key)
      .reduce((sum, e) => sum + e.rawCostMinor, 0);
  }

  monthBilledMinor(now = new Date().toISOString()): number {
    const key = monthKey(now);
    return this.#entries
      .filter((e) => e.type === 'DEBIT' && monthKey(e.timestamp) === key)
      .reduce((sum, e) => sum + e.billedMinor, 0);
  }

  /**
   * What this account has actually paid a provider for one kind of action,
   * ascending, in raw minor units before markup.
   *
   * Raw rather than billed, because the multiplier moves with monthly volume:
   * a charge settled last month at 3.0x says nothing about what the same work
   * costs today at 2.5x. Re-applying the current multiplier to a raw history
   * gives a figure that is comparable with the one the next reservation will
   * compute.
   */
  observedRawCosts(module: string, feature: string): number[] {
    return this.#entries
      .filter((e) => e.type === 'DEBIT' && e.module === module && e.feature === feature)
      .map((e) => e.rawCostMinor)
      .sort((a, b) => a - b);
  }

  entries(filter: { projectId?: string; module?: string; month?: string } = {}): ACUEntry[] {
    return this.#entries.filter((e) => {
      if (filter.projectId && e.projectId !== filter.projectId) return false;
      if (filter.module && e.module !== filter.module) return false;
      if (filter.month && monthKey(e.timestamp) !== filter.month) return false;
      return true;
    });
  }

  alerts(): ACUAlert[] {
    return [...this.#alerts];
  }

  snapshot(): WalletSnapshot {
    const halted = this.availableMinor() <= 0;
    return {
      tenantId: this.tenantId,
      balanceMinor: this.#balanceMinor,
      heldMinor: this.heldMinor(),
      availableMinor: this.availableMinor(),
      lifetimeBilledMinor: this.#entries.filter((e) => e.type === 'DEBIT').reduce((s, e) => s + e.billedMinor, 0),
      lifetimeRawCostMinor: this.#entries.filter((e) => e.type === 'DEBIT').reduce((s, e) => s + e.rawCostMinor, 0),
      monthRawSpendMinor: this.monthRawSpendMinor(),
      monthBilledMinor: this.monthBilledMinor(),
      caps: this.#caps,
      alerts: this.alerts(),
      aiHalted: halted,
      haltReason: halted ? 'ACU balance exhausted — top up to resume AI execution' : undefined,
    };
  }

  /** Cost attribution per engine — the "explainable AI billing" audit view. */
  attributionByModule(month?: string): Array<{ module: string; rawCostMinor: number; billedMinor: number; calls: number }> {
    const grouped = new Map<string, { rawCostMinor: number; billedMinor: number; calls: number }>();
    for (const entry of this.entries({ month })) {
      if (entry.type !== 'DEBIT') continue;
      const key = entry.module ?? 'UNATTRIBUTED';
      const bucket = grouped.get(key) ?? { rawCostMinor: 0, billedMinor: 0, calls: 0 };
      bucket.rawCostMinor += entry.rawCostMinor;
      bucket.billedMinor += entry.billedMinor;
      bucket.calls += 1;
      grouped.set(key, bucket);
    }
    return [...grouped.entries()]
      .map(([module, totals]) => ({ module, ...totals }))
      .sort((a, b) => b.billedMinor - a.billedMinor);
  }

  // --- Internals -------------------------------------------------------------

  /**
   * Which ceiling a charge of this size would breach, as facts rather than as a
   * sentence. The message a person reads is built from these, so a screen can
   * put the figure in their own currency instead of repeating minor units.
   */
  #capBreach(pendingBilledMinor: number, projectId?: string, module?: string): CapBreach | undefined {
    const caps = this.#caps;
    const spentOn = (filter: { projectId?: string; module?: string }): number =>
      this.entries({ ...filter, month: monthKey(new Date().toISOString()) })
        .filter((e) => e.type === 'DEBIT')
        .reduce((s, e) => s + e.billedMinor, 0);

    if (caps.monthlyMinor !== undefined && this.monthBilledMinor() + pendingBilledMinor > caps.monthlyMinor) {
      return { scope: 'MONTHLY', capMinor: caps.monthlyMinor, spentMinor: this.monthBilledMinor() };
    }
    if (projectId && caps.perProjectMinor?.[projectId] !== undefined) {
      const cap = caps.perProjectMinor[projectId] as number;
      const spent = spentOn({ projectId });
      if (spent + pendingBilledMinor > cap) {
        return { scope: 'PROJECT', capMinor: cap, spentMinor: spent, scopeId: projectId };
      }
    }
    if (module && caps.perModuleMinor?.[module] !== undefined) {
      const cap = caps.perModuleMinor[module] as number;
      const spent = spentOn({ module });
      if (spent + pendingBilledMinor > cap) {
        return { scope: 'MODULE', capMinor: cap, spentMinor: spent, scopeId: module };
      }
    }
    return undefined;
  }

  #checkCaps(pendingBilledMinor: number, projectId?: string, module?: string): string | undefined {
    const breach = this.#capBreach(pendingBilledMinor, projectId, module);
    if (!breach) return undefined;

    const where = breach.scopeId ? ` for ${breach.scopeId}` : '';
    const scope = breach.scope === 'MONTHLY' ? 'Monthly' : breach.scope === 'PROJECT' ? 'Project' : 'Module';
    return `${scope} AI cap of ${breach.capMinor} minor units would be exceeded${where}. AI execution halted.`;
  }

  /** Alerts fire once per threshold per month, at 50 / 80 / 100 percent. */
  #evaluateAlerts(): void {
    const cap = this.#caps.monthlyMinor;
    if (cap === undefined || cap <= 0) return;
    const consumed = this.monthBilledMinor();
    const month = monthKey(new Date().toISOString());

    for (const threshold of [50, 80, 100] as const) {
      if (consumed * 100 >= cap * threshold) {
        const key = `${month}:MONTHLY:${threshold}`;
        if (this.#raisedAlertKeys.has(key)) continue;
        this.#raisedAlertKeys.add(key);
        this.#alerts.push({
          threshold,
          scope: 'MONTHLY',
          raisedAt: new Date().toISOString(),
          consumedMinor: consumed,
          capMinor: cap,
        });
      }
    }
  }

  /**
   * The single funnel for every entry, and the only place the balance moves.
   *
   * Order is deliberate: the entry is made durable *first*, then recorded, then
   * the balance follows. If the sink throws, nothing has changed — no entry, no
   * balance movement — and the command fails. Mutating the balance first and
   * writing afterwards would leave a wallet whose in-memory balance is lower
   * than anything the disk can prove, which on restart silently refunds the
   * customer money the provider was already paid.
   */
  #record(partial: Omit<ACUEntry, 'id' | 'tenantId' | 'timestamp'>, balanceDeltaMinor = 0): ACUEntry {
    const entry: ACUEntry = {
      id: ulid(),
      tenantId: this.tenantId,
      timestamp: new Date().toISOString(),
      ...partial,
    };
    this.#sink?.(entry);
    this.#entries.push(entry);
    this.#balanceMinor += balanceDeltaMinor;
    return entry;
  }

  /**
   * Where each entry is written before it counts.
   *
   * Absent means in-process only. A wallet with no sink is correct in a test
   * and is money that disappears on restart anywhere else.
   */
  attachSink(sink: (entry: ACUEntry) => void): void {
    this.#sink = sink;
  }

  /**
   * Rebuild from durable entries.
   *
   * The balance is recomputed by folding the entries rather than being read
   * from a stored total — a stored total is a second source of truth for the
   * same money, and the two disagree the first time either is rebuilt. Holds
   * are deliberately *not* restored: a hold belongs to an in-flight AI call
   * that died with the process, and reinstating it would reserve money against
   * work that will never run.
   */
  restoreEntries(entries: readonly ACUEntry[]): void {
    for (const entry of entries) {
      this.#entries.push(entry);
      this.#balanceMinor += balanceEffect(entry);
    }
  }

  /** Every entry, for journalling and for reconciliation against invoices. */
  allEntries(): readonly ACUEntry[] {
    return this.#entries;
  }

  restoreCaps(caps: ACUCaps): void {
    this.#caps = caps;
  }
}
