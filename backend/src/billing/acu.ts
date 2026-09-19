import { config } from '../config.ts';
import { ACUExhaustedError, DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';

/**
 * The ACU ledger — survival economics, enforced rather than hoped for.
 *
 * Rules that are not negotiable anywhere in the platform:
 *   - Every provider call is charged at a fixed multiplier over raw cost.
 *   - Sequence is atomic: reserve -> execute -> persist -> debit. A hold that
 *     is never settled is released; no debit occurs without a Golden Thread write.
 *   - **Prepaid only. No negative balances, ever.** Sufficient ACUs have to be
 *     available, and no ACUs means no AI: the features are off until the wallet
 *     is topped up. This is the bound, and it is the only one on spend.
 *   - **No *limit* cuts an AI task short.** A customer's own cap — monthly, per
 *     project, per module, per person — is a budget signal rather than a
 *     guillotine: an AI run that passes one goes ahead, is charged as normal
 *     against the funded balance, and the breach is signalled and named on the
 *     entry. A task that has to reason its way to an answer is not left half
 *     finished by a ceiling, and nothing is ever given away to do it, because
 *     the balance still has to fund it.
 *
 * The distinction is the whole of it: **the balance is real money and binds;
 * a cap is a ceiling the customer set and reports rather than truncates.**
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

/**
 * How a trial grant is labelled on the wallet.
 *
 * One constant, because the platform's monthly trial budget is computed by
 * reading these entries back — what has been given away this month is the sum
 * of the grants carrying this note, and a second spelling anywhere would be
 * credit that the budget cannot see.
 */
export const TRIAL_GRANT_NOTE = 'Free trial ACU grant';

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
  /**
   * The ACU sponsorship this spend was authorised under, where the person is
   * from another organisation and somebody agreed to pay for their AI. On the
   * entry so the sponsorship's own allowance is measured from the wallet's
   * record rather than from a counter beside it.
   */
  sponsorshipId?: string;
};

export type ACUCaps = {
  /** Hard ceiling per calendar month, in billed minor units. Budget protection. */
  monthlyMinor?: number;
  perProjectMinor?: Record<string, number>;
  perModuleMinor?: Record<string, number>;
  /** Per person, per calendar month: the budget a company gives one of its people. */
  perUserMinor?: Record<string, number>;
};

/** A ceiling a charge would breach, before it is turned into a sentence. */
export type CapBreach = {
  scope: 'MONTHLY' | 'PROJECT' | 'MODULE' | 'USER';
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
 * Volume bands. **Every band is 4×.**
 *
 * These previously stepped 4.0 → 3.6 → 3.3, so a large consumer paid below the
 * headline rate. That was a deliberate volume incentive and it has been
 * removed by decision: the price is 4× and there is no rate below it anywhere
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
/**
 * What a wallet says about itself as it is spent, to whoever is listening:
 * a threshold of the monthly limit crossed (once per threshold per month), or
 * the hard limit reached and a request refused (once per scope per month).
 * GN-SPEC-TENANCY-001 §9.3: the company's administrators and the group's
 * finance are told; the wallet itself only raises the signal.
 */
export type WalletSignal =
  | { kind: 'THRESHOLD'; alert: ACUAlert }
  | { kind: 'LIMIT_REACHED'; breach: CapBreach; requestedMinor: number };

/**
 * Where each band sits in the price range, as a fraction of the way from the
 * bottom (`markupMultiplier`) to the top (`maxMarkupMultiplier`), against the
 * raw provider cost this tenancy has run up this calendar month.
 *
 * Positions rather than multipliers, so the ladder cannot drift away from the
 * range it is meant to span: move either end in config and every rung moves
 * with it, and the top and bottom rungs are the ends by construction rather
 * than by somebody remembering to edit them too.
 *
 * The thresholds are raw provider cost in minor units — £10, £50, £200, £1,000
 * a month — because that is the quantity the economics turn on. Charged spend
 * would make the band depend on the multiplier that the band decides.
 */
const BAND_POSITIONS: Array<{ upToRawMinor: number; positionInRange: number }> = [
  { upToRawMinor: 1_000, positionInRange: 1 },
  { upToRawMinor: 5_000, positionInRange: 0.75 },
  { upToRawMinor: 20_000, positionInRange: 0.5 },
  { upToRawMinor: 100_000, positionInRange: 0.25 },
  { upToRawMinor: Number.POSITIVE_INFINITY, positionInRange: 0 },
];

/**
 * The price ladder, from the top of the range down to the bottom.
 *
 * **This used to be flat at 4× and is now a range of 4× to 10×, by decision of
 * the business.** The rule it replaces — one multiple at every level of spend —
 * priced a tenancy spending £0.43 of provider cost a month identically to one
 * spending £4,000, and the two do not cost the same to serve: a run whose
 * provider cost is a fraction of a penny still takes a routing decision, a
 * reservation, a ledger append, an evidence write and a settlement, none of
 * which shrink with the token count.
 *
 * So the smallest consumers pay the top of the range and the largest pay the
 * bottom, and the bottom is `minimumMultiplier` — the profit floor — so nothing
 * on this ladder can sell AI below the company's profit rule whatever the
 * bands say. Every charge is stamped with the multiplier it was raised at, so a
 * customer's realised rate is on their own ledger entries rather than inferred
 * from a total, and the operator's estate view shows the realised multiplier
 * per tenancy beside the charge.
 *
 * Computed from the two ends rather than written out, so the published range
 * and the table that implements it are the same fact.
 */
export const VOLUME_BANDS: Array<{ upToRawMinor: number; multiplier: number }> = BAND_POSITIONS.map((band) => ({
  upToRawMinor: band.upToRawMinor,
  // Rounded to two places so a rate never reaches an invoice as 6.4999999999.
  multiplier:
    Math.round(
      (config.billing.markupMultiplier +
        (config.billing.maxMarkupMultiplier - config.billing.markupMultiplier) * band.positionInRange) *
        100,
    ) / 100,
}));

/**
 * What a unit of provider cost is charged at, for this tenant, this month.
 *
 * Two rules, and the second is a guard rather than a policy: the headline rate
 * is 4x, the volume incentive may discount it, and nothing may take it below
 * `minimumMultiplier`. That floor is what makes "the platform never sells AI
 * at a loss" a property of the code rather than a property of whoever last
 * edited the bands — a band table is exactly the kind of constant somebody
 * tunes without re-deriving what it does to the margin.
 */
/**
 * The lowest multiplier that still satisfies the company's profit rule.
 *
 * Profit is what is left after the provider is paid, so a required profit of
 * 300% of cost means charging four times: `1 + 300/100 = 4`. Derived rather than
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

/**
 * What a unit of provider cost is charged at, for this tenant, this month.
 *
 * The ladder applies to everybody. `volumeIncentiveEnabled` — set for the
 * ENTERPRISE and SOVEREIGN tiers, and for the platform's own wallet — holds
 * that tenancy at the bottom of the range whatever it spends, which is what a
 * negotiated enterprise rate is. It kept its name and its direction: the flag
 * has always meant "this account pays less", and it still does.
 *
 * The floor is the last word in both paths. A band table is exactly the kind of
 * constant somebody tunes without re-deriving what it does to margin, and
 * `minimumMultiplier` is what makes "the platform never sells AI at a loss" a
 * property of the code rather than of whoever last edited the ladder.
 */
export function effectiveMultiplier(monthlyRawSpendMinor: number, volumeIncentiveEnabled: boolean): number {
  const floor = minimumMultiplier();
  if (volumeIncentiveEnabled) return Math.max(config.billing.markupMultiplier, floor);
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
  sponsorshipId?: string;
  /**
   * Why this reservation went ahead past a customer's own cap.
   *
   * Absent on an ordinary reservation, and absent whenever the *balance* is the
   * constraint — that one refuses, because prepaid means prepaid. Present, with
   * the sentence, where an AI run passed a monthly, project, module or personal
   * ceiling: the money was funded, and a ceiling does not cut an AI task in
   * half. It travels onto the settlement entry so the invoice line says why.
   */
  authorisedOverrun?: string;
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
  /** Of that, what the charged runs cost — the denominator of a realised rate. */
  monthChargedRawMinor: number;
  /** And what this platform bore instead of charging on. */
  monthAbsorbedRawMinor: number;
  monthBilledMinor: number;
  caps: ACUCaps;
  alerts: ACUAlert[];
  aiHalted: boolean;
  haltReason?: string;
  /** Set while a disputed payment has the wallet frozen (Enterprise / Group v1.0 §10.2). */
  frozen: { reason: string; at: string } | null;
  /** Holds whose provider call ended without evidence either way, waiting on the operator (§10.2 reconciliation_required). */
  unresolvedHolds: number;
  /**
   * Set while the platform is bearing this tenancy's AI cost instead of
   * charging it. The balance does not move, an empty one does not stop a run,
   * and every screen that would otherwise show a depleting prepaid balance says
   * this instead.
   */
  unmetered: UnmeteredGrant | null;
};

/**
 * An exemption from AI charging, with a term.
 *
 * Distinct from a free *package*: that is the monthly platform fee, and a
 * customer can hold a free package and still buy ACUs. This is the other half —
 * the AI itself costs them nothing while it runs. `until` omitted means
 * open-ended.
 */
export type UnmeteredGrant = { reason: string; until?: string };

/**
 * The wallet as a customer may see it: what they were charged, what is left,
 * and the limits they set themselves. None of this platform's own cost of
 * serving them, which is not an answer to any question they are asking.
 */
export type CustomerWalletSnapshot = Pick<
  WalletSnapshot,
  | 'tenantId'
  | 'balanceMinor'
  | 'heldMinor'
  | 'availableMinor'
  | 'lifetimeBilledMinor'
  | 'monthBilledMinor'
  | 'caps'
  | 'alerts'
  | 'aiHalted'
  | 'haltReason'
  | 'frozen'
  | 'unresolvedHolds'
  | 'unmetered'
>;

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
  /** Settled holds by id, so a replayed completion answers the same and charges nothing. */
  readonly #settled = new Map<string, ACUEntry>();
  readonly #alerts: ACUAlert[] = [];
  #raisedAlertKeys = new Set<string>();
  #sink: ((entry: ACUEntry) => void) | undefined;
  #unmetered: UnmeteredGrant | null = null;

  constructor(tenantId: string, options: { volumeIncentive?: boolean } = {}) {
    this.tenantId = tenantId;
    this.#volumeIncentive = options.volumeIncentive ?? false;
  }

  // --- Unmetered AI ------------------------------------------------------------

  /**
   * Bear this tenancy's AI cost rather than charge it, until a date.
   *
   * Reported as a group holding twelve months of free ACUs still watching a
   * prepaid balance fall towards zero. The exemption existed, but it was an
   * exemption from the *subscription* — the monthly platform fee — and the AI
   * wallet knew nothing about it, so the customer was told their AI was free
   * and then metered anyway, with a runway counting down beside it.
   *
   * The spend is still recorded in full. `rawCostMinor` on every entry is what
   * the providers actually charged this platform, because that cost is real
   * whoever pays it, and the operator's burn view has to see it or the estate's
   * economics are a fiction. What changes is `billedMinor`, which is nil, and
   * the arithmetic in `burn.ts` then reports the whole of the forgone charge
   * under **Absorbed**, which is precisely what it is.
   *
   * Set from the subscription grant at `Platform.wallet`, so there is one place
   * that decides whether a tenancy is exempt and one term for it to run to.
   * Passing `null` withdraws it.
   */
  setUnmetered(grant: UnmeteredGrant | null): void {
    this.#unmetered = grant;
  }

  /**
   * The grant in force now, or `null`.
   *
   * Expiry is applied here, at the accessor, rather than by a job that clears
   * the field on a date: a grant whose term has run out has to stop applying
   * everywhere at once, and nothing fails when a customer is not charged, so a
   * missed sweep is invisible. An absent `until` is open-ended.
   */
  unmetered(at: string = new Date().toISOString()): UnmeteredGrant | null {
    const grant = this.#unmetered;
    if (!grant) return null;
    if (grant.until !== undefined && at >= grant.until) return null;
    return grant;
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
        note: TRIAL_GRANT_NOTE,
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
  quote(
    estimatedRawCostMinor: number,
    projectId?: string,
    module?: string,
    userId?: string,
    /**
     * Whether the run being quoted is AI work, which is not cut short by a
     * budget. Set by the orchestrator and by nothing else, for the reason
     * `reserve` states: a document render has no "keep going until it is
     * right", so an empty wallet still blocks one.
     */
    runToCompletion = false,
  ): {
    chargeMinor: number;
    multiplier: number;
    availableMinor: number;
    blockedReason?: string;
    /** What stopped it, for a caller that would rather word the message itself. */
    blockedBy?: 'BALANCE' | 'CAP';
    capBreach?: CapBreach;
    /**
     * What running this would cost past a ceiling, where it would pass one.
     *
     * Distinct from `blockedReason`, and the distinction is the whole point: a
     * block is "this will not happen", an overrun is "this will happen and here
     * is what it does to the account". Under the rule that AI work is not cut
     * short by a budget the second is the truth, and a screen that showed the
     * first would be telling somebody a button is dead while the platform would
     * run it happily on the next press.
     */
    overrunReason?: string;
  } {
    const multiplier = effectiveMultiplier(this.monthRawSpendMinor(), this.#volumeIncentive);
    // Quoted at nil for an exempt tenancy, because that is what `settle` will
    // take. The disclosure before the button and the charge after it are read
    // from the same rule, so a customer cannot be shown a price they will not
    // pay — nor be blocked by a balance that is not going to be touched.
    const exempt = this.unmetered();
    const chargeMinor = exempt ? 0 : Math.ceil(estimatedRawCostMinor * multiplier);
    const availableMinor = this.availableMinor();
    // The same two ceilings `reserve` checks, and on exactly the same terms —
    // AI work, and the rule switched on — so the quote and the reservation can
    // never disagree about whether something will run.
    const running = runToCompletion && config.ai.runToCompletion;

    // The balance blocks whatever this is: prepaid means prepaid, and no ACUs
    // means no AI.
    if (chargeMinor > availableMinor) {
      return {
        chargeMinor,
        multiplier,
        availableMinor,
        blockedBy: 'BALANCE',
        blockedReason: `Insufficient ACU balance: ${chargeMinor} required, ${availableMinor} available.`,
      };
    }

    // A cap blocks everything except AI work with the rule on, where it is
    // disclosed instead: the money is funded, and a ceiling does not cut a
    // reasoning task in half.
    const capBreach = this.#capBreach(chargeMinor, projectId, module, userId);
    if (capBreach) {
      const reason = this.#checkCaps(chargeMinor, projectId, module, userId);
      return running
        ? {
            chargeMinor,
            multiplier,
            availableMinor,
            capBreach,
            overrunReason: `${reason} The run goes ahead — a cap does not cut an AI task short — and is charged against the funded balance as normal.`,
          }
        : { chargeMinor, multiplier, availableMinor, blockedBy: 'CAP', capBreach, blockedReason: reason };
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
    sponsorshipId?: string;
    /**
     * Whether this reservation is AI work, which is not cut short by a budget.
     *
     * Set by the orchestrator and by nothing else. **Deliberately not the
     * default**, because the rule is about AI: a task that has to reason its
     * way to an answer runs until it has one, whatever it costs. A document
     * render or a spatial compute is metered work of a fixed size that the
     * platform can price up front and the customer can pay for or not — there
     * is no "keep going until it is right" in a PDF, so an empty wallet still
     * refuses one, exactly as before.
     */
    runToCompletion?: boolean;
  }): Hold {
    if (this.#frozen) {
      throw new DomainError(
        'WALLET_FROZEN',
        `This wallet is frozen (${this.#frozen.reason}). AI is paused until the platform operator resolves the payment exception; everything else is unaffected.`,
        409,
      );
    }
    const multiplier = effectiveMultiplier(this.monthRawSpendMinor(), this.#volumeIncentive);
    const exempt = this.unmetered();
    // Nothing is reserved against a balance that is not going to be charged.
    // Holding the notional amount would work — the settlement bills nil either
    // way — but it would take an exempt customer's own topped-up credit out of
    // `availableMinor` for the length of the call, and refuse the call outright
    // once the two met. A nil hold makes both impossible rather than unlikely.
    const heldMinor = exempt ? 0 : Math.ceil(input.estimatedRawCostMinor * multiplier);

    /*
     * **The balance binds, and it binds for AI too.**
     *
     * Prepaid only: sufficient ACUs have to be available, and no ACUs means no
     * AI. Nothing here runs a provider on credit — the platform never lays out
     * money it cannot bill, and a customer is never handed a charge they did
     * not fund first.
     */
    if (heldMinor > this.availableMinor()) {
      throw new ACUExhaustedError(
        `Insufficient ACU balance: ${heldMinor} required, ${this.availableMinor()} available. AI execution halted.`,
      );
    }

    /*
     * **A cap is a ceiling the customer set, and it does not cut an AI task in
     * half.**
     *
     * The money is funded either way — the balance above saw to that — so what
     * a cap decides is not whether the platform can afford the work but whether
     * it is allowed to finish it. An AI task that has to reason its way to an
     * answer is worth nothing half done, and stopping it at a monthly ceiling
     * means the customer has paid for the tokens and received nothing usable.
     *
     * So the breach is **reported rather than enforced** for AI: the signal
     * still goes out, so the company's administrators and the group's finance
     * are told exactly as before, and the reason travels on the hold and onto
     * the settlement entry so the invoice line says why. Non-AI metered work,
     * and a deployment that has turned the rule off, are refused as they were.
     */
    const capBreach = this.#checkCaps(heldMinor, input.projectId, input.module, input.userId);
    let authorisedOverrun: string | undefined;
    if (capBreach) {
      const breach = this.#capBreach(heldMinor, input.projectId, input.module, input.userId)!;
      const key = `${monthKey(new Date().toISOString())}:${breach.scope}:${breach.scopeId ?? ''}`;
      if (!this.#limitSignalKeys.has(key)) {
        this.#limitSignalKeys.add(key);
        this.#emit({ kind: 'LIMIT_REACHED', breach, requestedMinor: heldMinor });
      }
      if (input.runToCompletion === true && config.ai.runToCompletion) {
        authorisedOverrun = `${capBreach} The run went ahead because a cap does not cut an AI task short; it is charged against the funded balance as normal.`;
      } else {
        throw new ACUExhaustedError(capBreach);
      }
    }

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
      ...(input.sponsorshipId ? { sponsorshipId: input.sponsorshipId } : {}),
      ...(authorisedOverrun ? { authorisedOverrun } : {}),
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
      ...(input.sponsorshipId ? { sponsorshipId: input.sponsorshipId } : {}),
    });
    return hold;
  }

  /**
   * Settle a hold against the real provider cost. Called only after the
   * execution's output has been written to the Golden Thread — no debit
   * without a ledger write.
   */
  settle(holdId: string, actualRawCostMinor: number, provider: string): ACUEntry {
    // A settlement replayed is the same settlement. An execution whose
    // completion is reported twice — a retried callback, a worker that did not
    // hear the first acknowledgement — charged once and answers the same the
    // second time, with the balance exactly where the first left it. Commit and
    // release stay mutually exclusive: a released hold cannot then be settled,
    // because the hold is gone and its release is on the record.
    const already = this.#settled.get(holdId);
    if (already) return already;
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

    // An execution that overruns its estimate was capped at the held amount, so
    // the customer was never charged more than was reserved and disclosed —
    // unless honouring the cap would sell below the company's own profit floor,
    // in which case the floor won. The hold is sized from an *estimate*, and
    // the estimator assumes output is a quarter of input; a request whose
    // answer is much larger than its question costs several times the estimate,
    // and capping there meant paying a provider more than the customer paid.
    //
    // **The floor is now the price, so this cap no longer binds and that is
    // deliberate.** The business rule is that £1 of provider cost produces the
    // full multiple, with no case in which it produces less, and
    // `minimumProfitPercent` states
    // it — so `floorMinor === billedMinor` on every settlement and the `min`
    // against the hold can never win. The arithmetic is left exactly as it is
    // rather than simplified to `billedMinor`: the shape is what shows that a
    // cap exists and what the floor does to it, and lowering the floor below
    // the price restores the cap without a code change, which is the property
    // worth keeping.
    //
    // The exposure that creates is handled by disclosure, below: an overrun is
    // named on the entry rather than left to be inferred by anybody who
    // recomputes the arithmetic.
    const floorMinor = Math.ceil(actualRawCostMinor * minimumMultiplier());
    // The profit floor is a rule about what the platform sells at, not about
    // what it gives away. An exemption is the operator deciding to bear this
    // cost, so the floor does not apply to it and the charge is nil — but
    // `effectiveMultiplier` on the entry stays the real one, because
    // `burn.ts` reads Absorbed as "what this would have been charged, less what
    // was taken", and a nil multiplier would report the giveaway as costing the
    // platform nothing.
    const exempt = this.unmetered();
    const chargedMinor = exempt ? 0 : Math.max(Math.min(billedMinor, hold.heldMinor), floorMinor);
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
      ...(hold.sponsorshipId ? { sponsorshipId: hold.sponsorshipId } : {}),
      // Named on the entry rather than left to be inferred from the arithmetic.
      // An overrun is the one case where a customer is charged more than they
      // were quoted, and it has to be visible on the invoice line rather than
      // discovered by somebody recomputing it.
      // Two disclosures, and a run can carry both: charged above its estimate,
      // and run past a cap the customer set. Joined into one sentence rather
      // than one overwriting the other, because an invoice line that named only
      // one of them would be answering half the question somebody is asking.
      // A nil charge needs a reason on the line, or the entry reads as a bug:
      // a debit against a named provider, for real compute, charging nothing.
      ...(overran || hold.authorisedOverrun || exempt
        ? {
            note: [
              exempt
                ? `Not charged — ${exempt.reason}. The providers charged ${actualRawCostMinor} for this run and ` +
                  `this platform bore it${exempt.until ? `; the exemption runs until ${exempt.until.slice(0, 10)}` : ''}.`
                : '',
              overran
                ? `Charged above the estimate: the execution cost ${actualRawCostMinor} against an estimate held ` +
                  `at ${hold.heldMinor}, so ${chargedMinor} was charged rather than the ${hold.heldMinor} quoted. ` +
                  'AI is charged on what a run actually cost, and this one cost more than it was estimated at.'
                : '',
              hold.authorisedOverrun ?? '',
            ]
              .filter(Boolean)
              .join(' '),
          }
        : {}),
    }, -chargedMinor);

    this.#settled.set(holdId, entry);
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
      ...(hold.sponsorshipId ? { sponsorshipId: hold.sponsorshipId } : {}),
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

  /**
   * The provider cost of the runs that were actually charged this month.
   *
   * Distinct from `monthRawSpendMinor`, which counts every run whether it was
   * billed or given away, and the difference is not academic. An exempt
   * tenancy keeps accruing provider cost at nil charge, so
   * `billed / rawSpend` decays towards zero: a screen dividing one by the other
   * reported a **realised multiplier of 1.70×** on a platform whose floor is
   * 4×, and read as selling below cost. It was not — it was one ratio taken
   * across two different things.
   *
   * A realised rate is what was charged over what the charged runs cost. Runs
   * nobody was charged for belong in Absorbed, which is where `burn.ts` already
   * puts them.
   */
  monthChargedRawMinor(now = new Date().toISOString()): number {
    const key = monthKey(now);
    return this.#entries
      .filter((e) => e.type === 'DEBIT' && e.billedMinor > 0 && monthKey(e.timestamp) === key)
      .reduce((sum, e) => sum + e.rawCostMinor, 0);
  }

  /** The provider cost this platform bore this month rather than charged on. */
  monthAbsorbedRawMinor(now = new Date().toISOString()): number {
    return this.monthRawSpendMinor(now) - this.monthChargedRawMinor(now);
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

  entries(filter: { projectId?: string; module?: string; userId?: string; month?: string } = {}): ACUEntry[] {
    return this.#entries.filter((e) => {
      if (filter.projectId && e.projectId !== filter.projectId) return false;
      if (filter.module && e.module !== filter.module) return false;
      if (filter.userId && e.userId !== filter.userId) return false;
      if (filter.month && monthKey(e.timestamp) !== filter.month) return false;
      return true;
    });
  }

  /**
   * Listen for the wallet's own signals. A listener that throws is contained:
   * telling somebody about a threshold must never fail the settlement that
   * crossed it.
   */
  onSignal(listener: (signal: WalletSignal) => void): void {
    this.#signalListeners.push(listener);
  }

  #signalListeners: Array<(signal: WalletSignal) => void> = [];
  #limitSignalKeys = new Set<string>();

  #emit(signal: WalletSignal): void {
    for (const listener of this.#signalListeners) {
      try {
        listener(signal);
      } catch (error) {
        process.stderr.write(`wallet signal listener failed for ${this.tenantId}: ${(error as Error).message}\n`);
      }
    }
  }

  alerts(): ACUAlert[] {
    return [...this.#alerts];
  }

  snapshot(): WalletSnapshot {
    const debits = this.#entries.filter((entry) => entry.type === 'DEBIT');
    const lifetimeBilled = debits.reduce((sum, entry) => sum + entry.billedMinor, 0);
    const lifetimeRawCost = debits.reduce((sum, entry) => sum + entry.rawCostMinor, 0);
    // No ACUs means no AI: the features are off until the wallet is topped up,
    // and the screen says so rather than offering a button that will refuse.
    // An exempt tenancy is never halted for want of credit: there is nothing
    // to run out of. A freeze still stops it — that is a payment dispute, and
    // it is about the account rather than about the balance.
    const exempt = this.unmetered();
    const halted = (this.availableMinor() <= 0 && !exempt) || this.#frozen !== null;
    return {
      unmetered: exempt,
      tenantId: this.tenantId,
      balanceMinor: this.#balanceMinor,
      heldMinor: this.heldMinor(),
      availableMinor: this.availableMinor(),
      lifetimeBilledMinor: lifetimeBilled,
      lifetimeRawCostMinor: lifetimeRawCost,
      lifetimeProfitMinor: lifetimeBilled - lifetimeRawCost,
      lifetimeProfitPercent: profitPercent(lifetimeRawCost, lifetimeBilled),
      monthRawSpendMinor: this.monthRawSpendMinor(),
      monthChargedRawMinor: this.monthChargedRawMinor(),
      monthAbsorbedRawMinor: this.monthAbsorbedRawMinor(),
      monthBilledMinor: this.monthBilledMinor(),
      caps: this.#caps,
      alerts: this.alerts(),
      aiHalted: halted,
      haltReason: this.#frozen
        ? `Wallet frozen: ${this.#frozen.reason}`
        : halted
          ? 'ACU balance exhausted — top up to resume AI execution'
          : undefined,
      frozen: this.#frozen,
      unresolvedHolds: this.#unresolved.size,
    };
  }

  /**
   * What the customer is shown, which is what they were charged and no more.
   *
   * `snapshot()` carries this platform's own economics — what the providers
   * cost, what was absorbed, the lifetime margin and the percentage it
   * represents — and `/v1/billing/wallet` returned all of it to the tenancy.
   * So every customer could read, from their own browser, exactly what CONSTRUX
   * pays a provider and therefore exactly what the markup is. Taking the
   * figures off the screen would not have touched that: the response carried
   * them whether or not anything rendered them.
   *
   * A customer's legitimate question is "what am I being charged, and what is
   * left". The platform's cost of serving them is not an answer to it, and is
   * commercially the company's own. The operator sees the whole of it on the
   * ACU Economy screen, through operator-only routes.
   *
   * Written as a pick rather than a delete, so a field added to `snapshot()`
   * later is private until somebody decides otherwise — the safe direction for
   * a boundary like this to fail in.
   */
  customerSnapshot(): CustomerWalletSnapshot {
    const full = this.snapshot();
    return {
      tenantId: full.tenantId,
      balanceMinor: full.balanceMinor,
      heldMinor: full.heldMinor,
      availableMinor: full.availableMinor,
      lifetimeBilledMinor: full.lifetimeBilledMinor,
      monthBilledMinor: full.monthBilledMinor,
      caps: full.caps,
      alerts: full.alerts,
      aiHalted: full.aiHalted,
      ...(full.haltReason ? { haltReason: full.haltReason } : {}),
      frozen: full.frozen,
      unresolvedHolds: full.unresolvedHolds,
      unmetered: full.unmetered,
    };
  }

  // --- disputed funding ---------------------------------------------------------

  #frozen: { reason: string; at: string } | null = null;

  /**
   * Freeze the wallet: nothing further is reserved until it is unfrozen.
   * A disputed payment's unspent credit stays where it is (§10.2: "unspent
   * affected credits can be frozen"); the balance is not touched, and non-AI
   * work is unaffected because nothing but `reserve` reads this.
   */
  freeze(reason: string, at = new Date().toISOString()): void {
    this.#frozen = { reason, at };
  }

  unfreeze(): void {
    this.#frozen = null;
  }

  frozen(): { reason: string; at: string } | null {
    return this.#frozen;
  }

  /**
   * Reverse funding that has gone back to the payer — a refund, a chargeback.
   * An explicit debit of what is still available, never a rewrite of the
   * top-up and never a negative balance: what was already consumed cannot be
   * taken back from a wallet, and is returned as the shortfall for the
   * finance exception the caller raises (§10.2).
   */
  reverse(amountMinor: number, note: string): { reversedMinor: number; shortfallMinor: number; entry: ACUEntry | null } {
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      throw new DomainError('ACU_INVALID_AMOUNT', 'A reversal is a positive integer in minor units');
    }
    const reversedMinor = Math.min(this.availableMinor(), amountMinor);
    const entry =
      reversedMinor > 0
        ? this.#record({ type: 'DEBIT', rawCostMinor: 0, acuUnits: 0, billedMinor: reversedMinor, effectiveMultiplier: 0, note }, -reversedMinor)
        : null;
    return { reversedMinor, shortfallMinor: amountMinor - reversedMinor, entry };
  }

  // --- holds whose outcome is unknown -------------------------------------------

  readonly #unresolved = new Map<string, { hold: Hold; reason: string; parkedAt: string }>();

  /**
   * A provider call that ended with no evidence either way — a timeout after
   * the request left — must not be released (the provider may have done the
   * work and billed us) and must not be charged (the customer may have got
   * nothing). The hold stays reserved and waits for the operator's evidence
   * (Enterprise / Group v1.0 §10.2: reconciliation_required).
   */
  parkHold(holdId: string, reason: string): void {
    const hold = this.#holds.get(holdId);
    if (!hold) throw new DomainError('ACU_HOLD_NOT_FOUND', `Hold ${holdId} does not exist or is already settled`);
    this.#unresolved.set(holdId, { hold, reason, parkedAt: new Date().toISOString() });
  }

  unresolvedHolds(): Array<Hold & { reason: string; parkedAt: string }> {
    return [...this.#unresolved.values()].map(({ hold, reason, parkedAt }) => ({ ...hold, reason, parkedAt }));
  }

  /**
   * The operator's answer for a parked hold, with the evidence in the note:
   * the provider's account shows the call completed (charge what it cost), or
   * it shows nothing (release). Exactly one of the two, once.
   */
  reconcileHold(holdId: string, outcome: { kind: 'CHARGE'; actualRawCostMinor: number; provider: string } | { kind: 'RELEASE'; note: string }): ACUEntry | undefined {
    const parked = this.#unresolved.get(holdId);
    if (!parked) throw new DomainError('ACU_HOLD_NOT_UNRESOLVED', `Hold ${holdId} is not waiting for reconciliation`, 409);
    this.#unresolved.delete(holdId);
    return outcome.kind === 'CHARGE' ? this.settle(holdId, outcome.actualRawCostMinor, outcome.provider) : this.release(holdId, outcome.note);
  }

  /** Every hold not yet settled or released, parked ones included. */
  openHolds(): Hold[] {
    return [...this.#holds.values()];
  }

  /** Cost attribution per engine — the "explainable AI billing" audit view. */
  attributionByModule(
    month?: string,
  ): Array<{ module: string; rawCostMinor: number; billedMinor: number; calls: number; basis: 'MODEL' | 'LOCAL' | 'MIXED' }> {
    const grouped = new Map<string, { rawCostMinor: number; billedMinor: number; calls: number; local: number }>();
    for (const entry of this.entries({ month })) {
      if (entry.type !== 'DEBIT') continue;
      const key = entry.module ?? 'UNATTRIBUTED';
      const bucket = grouped.get(key) ?? { rawCostMinor: 0, billedMinor: 0, calls: 0, local: 0 };
      bucket.rawCostMinor += entry.rawCostMinor;
      bucket.billedMinor += entry.billedMinor;
      bucket.calls += 1;
      // `LOCAL` is what the wallet is handed for compute this platform performs
      // itself — a document render, a reconstruction, a segmentation. Everything
      // else settled against a named vendor.
      if (entry.provider === 'LOCAL') bucket.local += 1;
      grouped.set(key, bucket);
    }
    return [...grouped.entries()]
      .map(([module, totals]) => ({
        module,
        rawCostMinor: totals.rawCostMinor,
        billedMinor: totals.billedMinor,
        calls: totals.calls,
        // Carried out rather than left to the screen to infer.
        //
        // This list is not what it was. It used to be AI engines and nothing
        // else, and it is now billed either way — a document render and a site
        // reconstruction sit in it, and both are arithmetic this platform runs
        // rather than a model somebody was charged for thinking. A customer
        // reading "Site capture, 5 executions" beside "BIM twin" would
        // reasonably conclude a model had been run over their site, which is a
        // statement about where their data went and not merely a label.
        basis: totals.local === totals.calls ? ('LOCAL' as const) : totals.local === 0 ? ('MODEL' as const) : ('MIXED' as const),
      }))
      .sort((a, b) => b.billedMinor - a.billedMinor);
  }

  // --- Internals -------------------------------------------------------------

  /**
   * Which ceiling a charge of this size would breach, as facts rather than as a
   * sentence. The message a person reads is built from these, so a screen can
   * put the figure in their own currency instead of repeating minor units.
   */
  #capBreach(pendingBilledMinor: number, projectId?: string, module?: string, userId?: string): CapBreach | undefined {
    const caps = this.#caps;
    const spentOn = (filter: { projectId?: string; module?: string; userId?: string }): number =>
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
    if (userId && caps.perUserMinor?.[userId] !== undefined) {
      const cap = caps.perUserMinor[userId] as number;
      const spent = spentOn({ userId });
      if (spent + pendingBilledMinor > cap) {
        return { scope: 'USER', capMinor: cap, spentMinor: spent, scopeId: userId };
      }
    }
    return undefined;
  }

  #checkCaps(pendingBilledMinor: number, projectId?: string, module?: string, userId?: string): string | undefined {
    const breach = this.#capBreach(pendingBilledMinor, projectId, module, userId);
    if (!breach) return undefined;

    const where = breach.scopeId ? ` for ${breach.scopeId}` : '';
    const scope = breach.scope === 'MONTHLY' ? 'Monthly' : breach.scope === 'PROJECT' ? 'Project' : breach.scope === 'USER' ? 'Personal' : 'Module';
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
        const alert: ACUAlert = {
          threshold,
          scope: 'MONTHLY',
          raisedAt: new Date().toISOString(),
          consumedMinor: consumed,
          capMinor: cap,
        };
        this.#alerts.push(alert);
        this.#emit({ kind: 'THRESHOLD', alert });
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

  /** What the customer has paid into this wallet, ever. Grants are not money. */
  paidInMinor(): number {
    return this.#entries.filter((entry) => entry.type === 'TOP_UP').reduce((sum, entry) => sum + entry.billedMinor, 0);
  }

  /**
   * What the customer is owed back if the wallet closes now: the unspent part
   * of what they paid in. Grants and subscription allowances are spent first —
   * they were never the customer's money — so the refundable figure is the
   * lesser of the balance and what was paid in.
   */
  refundableMinor(): number {
    return Math.max(0, Math.min(this.availableMinor(), this.paidInMinor()));
  }

  /**
   * Empty the wallet on closure. Recorded as a debit of the whole available
   * balance, with the note saying why, so the entries still fold to the
   * balance and the money that left can be traced to the refund raised for it.
   */
  closeOut(note: string): ACUEntry | undefined {
    const available = this.availableMinor();
    if (available <= 0) return undefined;
    return this.#record(
      { type: 'DEBIT', rawCostMinor: 0, acuUnits: 0, billedMinor: available, effectiveMultiplier: 0, note },
      -available,
    );
  }

  restoreCaps(caps: ACUCaps): void {
    this.#caps = caps;
  }
}
