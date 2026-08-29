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
 * Volume bands. **Every band is 5×.**
 *
 * These previously stepped 4.0 → 3.6 → 3.3, so a large consumer paid below the
 * headline rate. That was a deliberate volume incentive and it has been
 * removed by decision: the price is 5× and there is no rate below it anywhere
 * in the platform. A tenant spending a million a month is charged at exactly
 * the same multiplier as one spending ten pounds.
 *
 * The table is kept rather than deleted, and this is the load-bearing part.
 * `effectiveMultiplier` reads it, the wallet reads that, and every charge is
 * stamped with the multiplier it was raised at — so if a band is ever
 * reintroduced the plumbing is already in place and audited, and the discount
 * would show up in the realised multiplier on the operator's estate view rather
 * than hiding inside a total. Deleting the mechanism would mean rebuilding it
 * blind and re-deriving what it does to margin.
 *
 * The floor in `minimumMultiplier` still guards it: nothing here can take a
 * charge below the company's profit rule, whatever the bands say.
 */
export const VOLUME_BANDS: Array<{ upToRawMinor: number; multiplier: number }> = [
  { upToRawMinor: 200_000, multiplier: 5.0 },
  { upToRawMinor: 1_000_000, multiplier: 5.0 },
  { upToRawMinor: Number.POSITIVE_INFINITY, multiplier: 5.0 },
];

/**
 * What a unit of provider cost is charged at, for this tenant, this month.
 *
 * Two rules, and the second is a guard rather than a policy: the headline rate
 * is 5x, the volume incentive may discount it, and nothing may take it below
 * `minimumMultiplier`. That floor is what makes "the platform never sells AI
 * at a loss" a property of the code rather than a property of whoever last
 * edited the bands — a band table is exactly the kind of constant somebody
 * tunes without re-deriving what it does to the margin.
 */
/**
 * The lowest multiplier that still satisfies the company's profit rule.
 *
 * Profit is what is left after the provider is paid, so a required profit of
 * 100% of cost means charging twice: `1 + 100/100 = 2`. Derived rather than
 * configured as a bare number, so the rule and the arithmetic cannot drift
 * apart — changing the required profit changes the floor by construction.
 */
export function minimumMultiplier(): number {
  return 1 + config.billing.minimumProfitPercent / 100;
}

/**
 * Profit on one transaction, as a percentage of what the provider charged.
 *
 * Reported rather than assumed. The platform states a required profit and a
 * price; this is what it actually made, and having it on the record is what
 * stops "are we hitting the rule" from being a question anybody has to
 * recompute by hand.
 */
export function profitPercent(rawCostMinor: number, billedMinor: number): number {
  if (rawCostMinor <= 0) return 0;
  return ((billedMinor - rawCostMinor) / rawCostMinor) * 100;
}

export function effectiveMultiplier(monthlyRawSpendMinor: number, volumeIncentiveEnabled: boolean): number {
  const floor = minimumMultiplier();
  if (!volumeIncentiveEnabled) return Math.max(config.billing.markupMultiplier, floor);
  for (const band of VOLUME_BANDS) {
    if (monthlyRawSpendMinor <= band.upToRawMinor) return Math.max(band.multiplier, floor);
  }
  return Math.max(config.billing.markupMultiplier, floor);
}

/**
 * What a run at each metering class costs, and what it is quoted at.
 *
 * The specification's Part H tiers, and the reason they belong here rather than
 * on the agent: a tier is a claim about how expensive a class of thinking is,
 * and the *price* of that claim is money, which has one source of truth. An
 * agent declaring `acuTier: 'HIGH'` is saying what kind of work it does; this
 * says what that costs, priced through the same markup as every other AI
 * charge, so a tier cannot quietly become a second pricing model.
 *
 * Before this, five agents carried hand-written estimates — 40, 50, 60, 75 —
 * chosen individually, unrelated to each other and to the rate. An approver
 * comparing two proposals was comparing two guesses.
 *
 * `rawCostMinor` is provider cost. `chargeMinor` is what a person sees on the
 * approval screen, and it moves with the markup by construction.
 */
export function tierCost(
  tier: 'LOW' | 'MED' | 'HIGH' | 'PREMIUM',
  monthlyRawSpendMinor = 0,
  volumeIncentiveEnabled = false,
): { rawCostMinor: number; chargeMinor: number; multiplier: number } {
  const rawCostMinor = config.billing.acuTierRawCostMinor[tier];
  const multiplier = effectiveMultiplier(monthlyRawSpendMinor, volumeIncentiveEnabled);
  return { rawCostMinor, chargeMinor: Math.ceil(rawCostMinor * multiplier), multiplier };
}

/**
 * The ACU credit a subscription payment buys.
 *
 * A fixed share of what the customer pays for the plan is credited to their AI
 * wallet; the rest carries no provider cost against it. Rounded *down* to a
 * whole minor unit, because an ACU is a minor unit and a fraction of one cannot
 * be spent — rounding up would credit money that does not exist.
 */
export function subscriptionAcuAllocationMinor(monthlyPriceMinor: number): number {
  if (!Number.isInteger(monthlyPriceMinor) || monthlyPriceMinor <= 0) return 0;
  return Math.floor((monthlyPriceMinor * config.billing.subscriptionAcuAllocationPercent) / 100);
}

/**
 * ACUs from money, and money from ACUs.
 *
 * One ACU is one minor unit, so £1 is 100 ACUs. The conversion is a function
 * rather than a bare multiplication at each call site because it is the kind of
 * arithmetic that gets inlined slightly differently in five places and then
 * disagrees with itself.
 */
export function acusFromMinor(minorUnits: number): number {
  return Math.floor(minorUnits / config.billing.acuUnitMinor);
}

export function minorFromAcus(acus: number): number {
  return acus * config.billing.acuUnitMinor;
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
  /**
   * What the company actually made on this account, as a percentage of what it
   * paid providers. The rule requires at least `minimumProfitPercent`; this is
   * the realised figure, so nobody has to recompute it to know.
   */
  lifetimeProfitPercent: number;
  lifetimeProfitMinor: number;
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

  /**
   * Credit the AI allowance a subscription payment buys.
   *
   * Recorded as its own entry type-note rather than as a top-up, so the invoice
   * can tell the two apart: a top-up is money the customer chose to spend on
   * AI, and this is the share of a plan they already paid for. Reconciliation
   * needs to know which is which, and so does anybody asking why the balance
   * moved without a purchase.
   */
  allocateFromSubscription(monthlyPriceMinor: number, period: string): ACUEntry | undefined {
    const amountMinor = subscriptionAcuAllocationMinor(monthlyPriceMinor);
    // A free plan allocates nothing. Recording a zero entry would put a line on
    // the invoice saying the customer received nothing, which is noise.
    if (amountMinor <= 0) return undefined;

    // Once per period, and the period is the key rather than a call count.
    // Invoices get reissued — a correction, a retry, an operator pressing the
    // button twice — and each reissue crediting another month of AI would hand
    // out an allowance nobody paid for.
    if (this.hasAllocationFor(period)) return undefined;

    return this.#record(
      {
        type: 'GRANT',
        billedMinor: amountMinor,
        rawCostMinor: 0,
        acuUnits: acusFromMinor(amountMinor),
        effectiveMultiplier: 0,
        note: `Subscription AI allowance (${config.billing.subscriptionAcuAllocationPercent}% of the plan) — ${period}`,
      },
      amountMinor,
    );
  }

  /** Whether this period's subscription allowance has already been credited. */
  hasAllocationFor(period: string): boolean {
    return this.#entries.some((entry) => entry.type === 'GRANT' && entry.note?.endsWith(`— ${period}`) === true);
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

    // The provider's reported cost, checked before it becomes arithmetic.
    //
    // Nothing validated it. A negative figure — from a provider adapter with a
    // sign error, a malformed response body, or a deliberately hostile one —
    // produced a negative charge, and `#record` subtracts the charge from the
    // balance, so a negative cost *credited* the customer. Free money arriving
    // through the AI path, in a direction nobody would think to look.
    //
    // Zero is refused for the same family of reasons: a call that reached a
    // provider cost something, and a zero settles the hold while charging
    // nothing.
    if (!Number.isFinite(actualRawCostMinor) || actualRawCostMinor <= 0) {
      throw new DomainError(
        'ACU_COST_INVALID',
        `A provider reported a cost of ${actualRawCostMinor}, which cannot be settled. ` +
          'A completed execution costs a positive amount.',
      );
    }

    const multiplier = effectiveMultiplier(this.monthRawSpendMinor(), this.#volumeIncentive);
    const billedMinor = Math.ceil(actualRawCostMinor * multiplier);

    // An execution that overruns its estimate is capped at the held amount: the
    // customer is never charged more than was reserved and disclosed.
    //
    // With one floor, and the floor is why this is not a plain `min`. The hold
    // is sized from an *estimate*, and the estimator assumes output is a
    // quarter of input. A request whose answer is much larger than its question
    // — a short prompt against a schema demanding a long list — costs several
    // times the estimate. Capping at the hold there meant paying a provider
    // more than the customer was charged: a straight loss, larger the more the
    // caller did it, and available to anybody who noticed.
    //
    // So the cap holds unless honouring it would sell below the company's own
    // profit floor, in which case the floor wins. That is the same rule the
    // price is derived from, applied at the moment the real cost is known
    // rather than only at the moment it was guessed.
    const floorMinor = Math.ceil(actualRawCostMinor * minimumMultiplier());
    const chargedMinor = Math.max(Math.min(billedMinor, hold.heldMinor), floorMinor);
    const overran = chargedMinor > hold.heldMinor;

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
      // Named on the entry rather than left to be inferred from the arithmetic.
      // An overrun is the one case where a customer is charged more than they
      // were quoted, and it has to be visible on the invoice line rather than
      // discovered by somebody recomputing it.
      ...(overran
        ? {
            note:
              `Charged at the minimum profit floor: the execution cost ${actualRawCostMinor} against an ` +
              `estimate held at ${hold.heldMinor}. Capping at the hold would have sold below cost.`,
          }
        : {}),
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
   * costs today at a different rate. Re-applying the current multiplier to a raw history
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
    const debits = this.#entries.filter((entry) => entry.type === 'DEBIT');
    const lifetimeBilled = debits.reduce((sum, entry) => sum + entry.billedMinor, 0);
    const lifetimeRawCost = debits.reduce((sum, entry) => sum + entry.rawCostMinor, 0);
    return {
      tenantId: this.tenantId,
      balanceMinor: this.#balanceMinor,
      heldMinor: this.heldMinor(),
      availableMinor: this.availableMinor(),
      lifetimeBilledMinor: lifetimeBilled,
      lifetimeRawCostMinor: lifetimeRawCost,
      lifetimeProfitMinor: lifetimeBilled - lifetimeRawCost,
      lifetimeProfitPercent: profitPercent(lifetimeRawCost, lifetimeBilled),
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
