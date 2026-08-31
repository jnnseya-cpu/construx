import { config } from '../config.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import { forwardCashflow, ledgerPosition } from '../engines/cost.ts';
import { abbreviateMoney } from './locale.ts';

/**
 * Running an integrated service contract without a finance team.
 *
 * A business that takes on every site service under one appointment — the
 * temporary offices, the power, the roads, the security, the accommodation —
 * is not doing harder work than a specialist. It is doing the same work with a
 * different exposure: it pays fifteen suppliers monthly and is paid by one
 * client monthly, and those two facts are not synchronised by anything.
 *
 * What decides whether that business survives is not the contract value. It is
 * whether there is money in the account on the day the suppliers are due, when
 * the client has not paid. A large firm answers that with a finance function
 * and a credit line. A new entrant, or a small business taking its first
 * integrated appointment, has neither — and everything else on this platform
 * is useless to them if they are wound up in month four.
 *
 * So this module answers two questions, and refuses to answer them vaguely.
 *
 * ## What the price is made of
 *
 * The industry habit is a single "overhead and profit" percentage, and it is
 * the number clients push back on hardest, because it cannot be argued with:
 * twenty per cent of what, for what? Split into its parts each one is
 * defensible on its own — this is the cost of managing the interface, this is
 * what the business costs to keep open, this is the return for carrying the
 * risk, and this is money held against things going wrong.
 *
 * **Contingency is not profit and this module will not let it become profit
 * quietly.** It is priced separately, drawn only against a stated risk, and
 * drawing it needs the authority that approves a budget rather than the one
 * that maintains it. A business that treats unused contingency as margin has
 * mispriced every job after the first one.
 *
 * ## Whether the money will be there
 *
 * The client advance is not a deposit, it is a rolling reserve: at each
 * valuation the client replenishes it so the business always holds the next
 * period's committed spend. That is what makes the model survivable, and it is
 * a single arithmetic check that a person should not have to do in a
 * spreadsheet at eleven at night.
 *
 * Stated in days of cover rather than as a balance, because a balance means
 * nothing without knowing what it is against. Thirty days is one payment
 * cycle: enough to pay everybody once with the client's money still in transit.
 *
 * ---
 *
 * **Built on what is already here.** The committed, certified and paid figures
 * come from `ledgerPosition`; the receivable and payable sides come from
 * `forwardCashflow`; the payment cycle, its notices and the Construction Act
 * dates are the platform's own and are not restated. This module adds the two
 * things none of them hold: what the price is made of, and what is in the
 * account against what is owed.
 */

// --- What the business is actually doing -------------------------------------

/**
 * The three ways a business can stand between a client and a panel of
 * suppliers, and they are not three names for one thing.
 *
 * This was a stored label that changed nothing: an appointment recorded as
 * `ADVISORY` was priced as a percentage of supplier cost and measured against a
 * supplier-payment reserve, exactly like one where the business pays every
 * supplier itself. On a pure fee that is two wrong answers — the fee is not a
 * function of somebody else's cost, and a reserve that covers an outflow the
 * business does not have is a warning about nothing.
 *
 * The distinction that matters is one question: **whose money pays the
 * supplier?** Everything else follows from it.
 */
export const TRADING_MODEL = {
  ADVISORY: {
    label: 'Advisory — a fee, and the client contracts the suppliers',
    /** The business never has supplier cost passing through its account. */
    fundsSupplierCost: false,
    /** Suppliers invoice the client directly; the business invoices its fee. */
    invoicesClientForSupplierCost: false,
    cashRisk:
      'None from supplier payment: there is no supplier cost in this business’s account to fund. The exposure is the ' +
      'fee itself going unpaid, which is an ordinary receivable.',
    marginRisk:
      'The highest of the three. Every supplier holds its own contract with the client and its own invoice ' +
      'relationship, so the client can see exactly what the work costs and what the advice costs. There is nothing ' +
      'commercial in the way of the client renewing with the suppliers and not with the adviser.',
  },
  MANAGEMENT_INTEGRATOR: {
    label: 'Management — supplier cost passes through at cost, plus a fee',
    fundsSupplierCost: true,
    invoicesClientForSupplierCost: true,
    cashRisk:
      'The whole risk, and it is not offset by margin. Supplier cost is paid out in full and recovered in full, so a ' +
      'timing gap is funded out of a fee earned on somebody else’s turnover.',
    marginRisk:
      'Moderate. The single invoice and the client specification sit with this business, but the supplier cost is ' +
      'open-book, so the client can price the alternative exactly.',
  },
  PRINCIPAL_SERVICE_CONTRACTOR: {
    label: 'Principal — one price to the client, and every supplier is this business’s',
    fundsSupplierCost: true,
    invoicesClientForSupplierCost: true,
    cashRisk:
      'The whole risk, against the whole margin. Supplier cost is funded between paying it and being paid for it, and ' +
      'the size of the gap is the size of the job.',
    marginRisk:
      'The lowest of the three, and the only one where the client is not shown what the suppliers charge. The ' +
      'exposure is a supplier that has met the client on site deciding it could hold the appointment itself.',
  },
} as const;

export type TradingModel = keyof typeof TRADING_MODEL;

// --- The price build-up ------------------------------------------------------

export type PriceComponent = {
  /** What a client reads on the build-up. */
  label: string;
  percent: number;
  amountMinor: number;
  /** Why this component exists, in the sentence it would be defended in. */
  basis: string;
};

export type IntegrationPrice = {
  directSupplierCostMinor: number;
  /** Which of the three ways of trading this price is built for. */
  model: TradingModel;
  components: PriceComponent[];
  /** Everything above direct cost, as one figure and as a percentage of it. */
  additionMinor: number;
  additionPercent: number;
  /**
   * What this business will invoice the client over the life of the appointment.
   *
   * On a fee model that is the addition alone: the suppliers hold their own
   * contracts with the client and invoice the client directly, so the supplier
   * cost never passes through this business's books. Reporting cost-plus-fee
   * there overstates turnover by the whole supplier cost, and every figure
   * derived from it — the VAT position, the reserve requirement, the size band
   * the business is measured in — is then wrong by the same amount.
   */
  contractPriceMinor: number;
  /** Supplier cost this business pays and recovers. Zero on a fee model. */
  passThroughMinor: number;
  /**
   * Held against the risk register and returned, shared or converted if it is
   * not needed. Called out separately because it is the component most often
   * quietly counted as margin.
   */
  contingencyMinor: number;
  /** What the business actually earns if nothing goes wrong. */
  marginMinor: number;
};

function buildPrice(directSupplierCostMinor: number, model: TradingModel): IntegrationPrice {
  const pct = (value: number): number => Math.round(directSupplierCostMinor * (value / 100));
  const trading = TRADING_MODEL[model];

  // On a fee model the supplier cost is the client's, so a contingency held
  // against it would be this business holding money against somebody else's
  // exposure — and charging a fee for the privilege. The client's own risk
  // allowance covers scope growth in contracts the client signed. What the
  // adviser carries instead is professional liability, which is insured rather
  // than funded, and is not a line in a price build-up.
  const contingencyPercent = trading.fundsSupplierCost ? config.billing.integrationContingencyPercent : 0;

  const components: PriceComponent[] = [
    {
      label: 'Contingency',
      percent: contingencyPercent,
      amountMinor: pct(contingencyPercent),
      basis: trading.fundsSupplierCost
        ? 'Held against the risk register, drawn only against a risk that has materialised, and not this business’s ' +
          'money until the contract says it is.'
        : 'Nil on a fee appointment. The supplier contracts are the client’s, so the risk allowance against them is ' +
          'the client’s too. What this business carries is professional liability, which is insured rather than ' +
          'funded and does not belong in a price build-up.',
    },
    {
      label: 'Project management and supplier integration',
      percent: config.billing.integrationManagementPercent,
      amountMinor: pct(config.billing.integrationManagementPercent),
      basis:
        'The people who run the interface between the packages. This is the work the client is buying instead of ' +
        'coordinating fifteen suppliers themselves.',
    },
    {
      label: 'Corporate overhead recovery',
      percent: config.billing.integrationOverheadPercent,
      amountMinor: pct(config.billing.integrationOverheadPercent),
      basis: 'What the business costs to keep open, recovered across the work it is doing.',
    },
    {
      label: 'Profit and principal-contractor risk',
      percent: config.billing.integrationProfitPercent,
      amountMinor: pct(config.billing.integrationProfitPercent),
      basis:
        'The return for standing behind every supplier: their default, their delay and their defects become this ' +
        'business’s liability the moment the appointment is signed.',
    },
  ];

  const additionMinor = components.reduce((sum, component) => sum + component.amountMinor, 0);
  const contingencyMinor = components[0]!.amountMinor;
  const passThroughMinor = trading.invoicesClientForSupplierCost ? directSupplierCostMinor : 0;

  return {
    directSupplierCostMinor,
    model,
    components,
    additionMinor,
    additionPercent:
      directSupplierCostMinor > 0 ? Math.round((additionMinor / directSupplierCostMinor) * 1000) / 10 : 0,
    contractPriceMinor: passThroughMinor + additionMinor,
    passThroughMinor,
    contingencyMinor,
    // Contingency is deliberately not in this figure. A business that counts it
    // as margin has mispriced every job after the first one.
    marginMinor: additionMinor - contingencyMinor,
  };
}

/** The build-up on its own, for a screen that quotes before anything is committed. */
export function quoteIntegration(
  ctx: EngineContext,
  directSupplierCostMinor: number,
  model: TradingModel = 'PRINCIPAL_SERVICE_CONTRACTOR',
): IntegrationPrice {
  authorise(ctx, 'BUDGET_COST', 'R', { dataSensitivity: 'COMMERCIAL_L3' });
  return buildPrice(directSupplierCostMinor, model);
}

/**
 * Price the appointment and open the commercial account for it.
 *
 * `C` on `BUDGET_COST`, which is the quantity surveyor. Approving the price is
 * somebody else's — the same separation the rest of the commercial model keeps,
 * and the reason it is not one person deciding what a job is worth.
 */
export function priceIntegration(
  ctx: EngineContext,
  input: { directSupplierCostMinor: number; model: TradingModel; note?: string },
): { accountId: string; price: IntegrationPrice } {
  authorise(ctx, 'BUDGET_COST', 'C', { dataSensitivity: 'COMMERCIAL_L3' });

  if (!Number.isInteger(input.directSupplierCostMinor) || input.directSupplierCostMinor <= 0) {
    throw new DomainError('INTEGRATION_COST_INVALID', 'A price is built up from a forecast supplier cost, not from nothing');
  }

  const open = ctx.ledger.list(ctx.projectId, 'IntegrationAccount');
  if (open.length > 0) {
    throw new DomainError(
      'INTEGRATION_ACCOUNT_EXISTS',
      'This appointment already has a commercial account. A second one would be a second answer to what the job is ' +
        'worth and how much is left in the reserve.',
    );
  }

  const price = buildPrice(input.directSupplierCostMinor, input.model);
  const accountId = ulid();

  write(ctx, {
    eventType: 'INTEGRATION_PRICED',
    entity: { refType: 'IntegrationAccount', refId: accountId },
    nextState: {
      id: accountId,
      model: input.model,
      price,
      advanceHeldMinor: 0,
      advances: [],
      contingencyDrawnMinor: 0,
      draws: [],
      ...(input.note ? { note: input.note } : {}),
      pricedAt: new Date().toISOString(),
      pricedBy: ctx.auth.actorId,
    },
  });

  return { accountId, price };
}

// --- The reserve -------------------------------------------------------------

/**
 * Record money the client has advanced, or replenished.
 *
 * The mobilisation advance and every monthly top-up take the same command,
 * because they are the same thing: the client funding the reserve the business
 * pays suppliers out of. Recording them separately would have produced two
 * numbers and no answer to how much is actually held.
 */
export function recordAdvance(
  ctx: EngineContext,
  input: { amountMinor: number; receivedOn: string; reference: string; covers?: string },
): { advanceHeldMinor: number } {
  authorise(ctx, 'BUDGET_COST', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireAccount(ctx);
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new DomainError('ADVANCE_AMOUNT_INVALID', 'An advance of nothing is not an advance');
  }

  const advances = [...((record.state.advances as unknown[] | undefined) ?? [])];
  const advanceHeldMinor = Number(record.state.advanceHeldMinor ?? 0) + input.amountMinor;

  advances.push({
    amountMinor: input.amountMinor,
    receivedOn: input.receivedOn,
    reference: input.reference,
    ...(input.covers ? { covers: input.covers } : {}),
    recordedBy: ctx.auth.actorId,
  });

  write(ctx, {
    eventType: 'ADVANCE_RECEIVED',
    entity: { refType: 'IntegrationAccount', refId: record.refId },
    nextState: { ...(record.state as Record<string, unknown>), advances, advanceHeldMinor },
  });

  return { advanceHeldMinor };
}

/**
 * Draw against contingency, for a risk that has actually happened.
 *
 * `A` on `BUDGET_COST` — the authority that approves a budget rather than the
 * one that maintains it. That is the whole control: a drawdown is a decision
 * somebody with standing takes and answers for, not a line a quantity surveyor
 * posts. A business where the person spending the contingency is the person
 * recording it has no contingency, it has a slower profit.
 *
 * Refuses a draw with no risk named against it. "Contingency" spent on
 * something nobody identified as a risk is either an underestimate or a
 * scope change, and both of those have their own routes.
 */
export function drawContingency(
  ctx: EngineContext,
  input: { amountMinor: number; riskReference: string; reason: string },
): { drawnMinor: number; remainingMinor: number } {
  authorise(ctx, 'BUDGET_COST', 'A', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireAccount(ctx);
  const price = record.state.price as IntegrationPrice;

  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new DomainError('CONTINGENCY_AMOUNT_INVALID', 'A draw of nothing is not a draw');
  }
  if (input.riskReference.trim() === '') {
    throw new DomainError(
      'CONTINGENCY_RISK_REQUIRED',
      'Contingency is drawn against a risk that has materialised. Money spent on something nobody identified is an ' +
        'underestimate or a scope change, and both have their own route.',
    );
  }

  const alreadyDrawn = Number(record.state.contingencyDrawnMinor ?? 0);
  const remaining = price.contingencyMinor - alreadyDrawn;
  if (input.amountMinor > remaining) {
    throw new DomainError(
      'CONTINGENCY_EXHAUSTED',
      `Only ${abbreviateMoney(remaining)} of contingency remains against ${abbreviateMoney(price.contingencyMinor)} ` +
        'priced. Drawing beyond it is spending the margin, and it should be recorded as that rather than hidden here.',
    );
  }

  const draws = [...((record.state.draws as unknown[] | undefined) ?? [])];
  draws.push({
    amountMinor: input.amountMinor,
    riskReference: input.riskReference,
    reason: input.reason,
    drawnAt: new Date().toISOString(),
    drawnBy: ctx.auth.actorId,
  });

  write(ctx, {
    eventType: 'CONTINGENCY_DRAWN',
    entity: { refType: 'IntegrationAccount', refId: record.refId },
    reason: `${input.riskReference}: ${input.reason}`,
    nextState: {
      ...(record.state as Record<string, unknown>),
      draws,
      contingencyDrawnMinor: alreadyDrawn + input.amountMinor,
    },
  });

  return { drawnMinor: alreadyDrawn + input.amountMinor, remainingMinor: remaining - input.amountMinor };
}

// --- Trading terms, and the gap between them ---------------------------------

/**
 * When this business is paid, and when it pays — the two numbers that decide
 * whether coordinating a supply chain traps cash or not.
 *
 * ## Why "back-to-back" needs splitting in two
 *
 * The usual answer to the cash trap is "back-to-back terms", and that phrase
 * covers two arrangements which behave completely differently in law.
 *
 * **Conditional — pay the supplier when the client pays.** Ineffective. Section
 * 113 of the Housing Grants, Construction and Regeneration Act 1996 makes a term
 * making payment conditional on the payer receiving payment from a third party
 * of no effect, except where that third party is insolvent. The obligation to
 * pay the supplier falls due whether or not the client has paid, and where the
 * struck-out clause leaves no adequate payment mechanism the Scheme for
 * Construction Contracts supplies one. A business that answers its cash exposure
 * with this clause has not mitigated anything: it has a term that does not work
 * and a supplier who can go to adjudication and be paid within weeks.
 *
 * The platform already knows this — `itt.ts` says exactly this to a bidder
 * reading somebody else's invitation. It said nothing at all about the same
 * clause in the subcontracts this business issues, which is the one place the
 * business would be relying on it.
 *
 * **Timing — pay the supplier later than the client pays this business.**
 * Entirely effective, and it is what the phrase ought to mean. It is a payment
 * *period*, which section 110 requires the contract to state and which nothing
 * prohibits, so the money is in the account before it has to leave it. This is
 * the mitigation. It is arithmetic, not a clause that will not survive contact
 * with an adjudicator.
 *
 * ## And what timing alone cannot do
 *
 * Two limits, and both are on the lawful mechanism rather than on the void one.
 *
 * On a **public contract**, regulation 113 of the Public Contracts Regulations
 * 2015 requires 30-day payment terms and requires them to be passed down the
 * whole subcontract chain. A 90-day subcontract on public work is not a
 * commercial choice, it is a breach of a term the regulations require to be in
 * the contract.
 *
 * Beyond `grosslyUnfairPaymentDays`, a period is in territory the Late Payment
 * of Commercial Debts (Interest) Act 1998 treats as grossly unfair to the
 * supplier, and a term imposing it can be struck out — leaving the statutory
 * default, statutory interest and fixed compensation. Stretching suppliers is
 * available as a cash strategy for a while and it is not free.
 *
 * The reserve is what covers the gap that is left. This module already measures
 * it; this pair of numbers says how big the gap it has to cover actually is.
 */
export type TradingTerms = {
  /** Days from application to the client's money arriving. */
  clientPaymentDays: number;
  /** Days from a supplier's application to this business paying it. */
  supplierPaymentDays: number;
  /**
   * Whether the subcontract makes payment conditional on the client paying.
   *
   * Recorded rather than refused. The clause is void, not criminal, and it is in
   * standard documents all over the industry — the business needs to know it is
   * there and worthless, which it cannot if the platform declines to hold the
   * fact.
   */
  conditionalOnClientPayment: boolean;
  /** Whether the client is a contracting authority, which changes the rules. */
  publicSectorClient: boolean;
  recordedBy: string;
  recordedAt: string;
};

export type FundingGap = {
  clientPaymentDays: number;
  supplierPaymentDays: number;
  /**
   * Days this business funds the chain out of its own money. Negative means the
   * client's money arrives before the supplier has to be paid, which is the
   * position the whole arrangement is trying to reach.
   */
  gapDays: number;
  /** What that gap costs at the current rate of supplier spend, where measurable. */
  exposureMinor?: number;
  /** Named when the exposure cannot be worked out, rather than reported as zero. */
  unmeasured?: string;
  lawful: boolean;
  findings: Array<{ authority: string; finding: string; severity: 'BAR' | 'MATERIAL' | 'ROUTINE' }>;
};

export function recordTradingTerms(
  ctx: EngineContext,
  input: {
    clientPaymentDays: number;
    supplierPaymentDays: number;
    conditionalOnClientPayment: boolean;
    publicSectorClient: boolean;
  },
): { gap: FundingGap } {
  authorise(ctx, 'BUDGET_COST', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireAccount(ctx);
  for (const [name, value] of [
    ['clientPaymentDays', input.clientPaymentDays],
    ['supplierPaymentDays', input.supplierPaymentDays],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new DomainError('PAYMENT_DAYS_INVALID', `${name} is a whole number of days from the application, not ${value}.`);
    }
  }

  const terms: TradingTerms = {
    ...input,
    recordedBy: ctx.auth.actorId,
    recordedAt: new Date().toISOString(),
  };

  write(ctx, {
    eventType: 'TRADING_TERMS_RECORDED',
    entity: { refType: 'IntegrationAccount', refId: record.refId },
    reason: `Paid at ${input.clientPaymentDays} days, pays at ${input.supplierPaymentDays}`,
    nextState: { ...(record.state as Record<string, unknown>), tradingTerms: terms },
  });

  return { gap: assessTerms(terms) };
}

/**
 * The gap, and what the law says about how it was arrived at.
 *
 * Exported because a business deciding what terms to *ask* for needs the answer
 * before there is an appointment to record it against, and running the same
 * arithmetic twice in two places is how the two come to disagree.
 */
export function assessTerms(terms: TradingTerms, averageSupplierSpendPerPeriodMinor?: number): FundingGap {
  const gapDays = terms.clientPaymentDays - terms.supplierPaymentDays;
  const findings: FundingGap['findings'] = [];

  if (terms.conditionalOnClientPayment) {
    findings.push({
      authority: 'HGCRA 1996 s.113',
      finding:
        'The subcontract makes payment conditional on this business being paid. That term is of no effect except on ' +
        'the client’s insolvency, so it protects nothing: the supplier’s money falls due on the contract date ' +
        'regardless, and an adjudicator will say so in weeks. Treat the cash exposure as if the clause were not ' +
        'there, because it is not. The lawful way to reach the same position is the payment period below.',
      severity: 'BAR',
    });
  }

  if (terms.publicSectorClient && terms.supplierPaymentDays > config.billing.publicSectorFlowDownDays) {
    findings.push({
      authority: 'Public Contracts Regulations 2015, reg 113',
      finding:
        `On a public contract the 30-day payment term must be passed down the whole subcontract chain. Paying ` +
        `suppliers at ${terms.supplierPaymentDays} days breaches a term the regulations require this subcontract to ` +
        'contain, and the funding gap it was buying is not available on this work.',
      severity: 'BAR',
    });
  }

  if (terms.supplierPaymentDays > config.billing.grosslyUnfairPaymentDays) {
    findings.push({
      authority: 'Late Payment of Commercial Debts (Interest) Act 1998',
      finding:
        `${terms.supplierPaymentDays} days is beyond the point at which a payment period is open to challenge as ` +
        'grossly unfair to the supplier. Struck out, it leaves the statutory default plus statutory interest and ' +
        'fixed compensation — so the cash this term buys is borrowed at a rate nobody agreed.',
      severity: 'MATERIAL',
    });
  }

  if (gapDays > 0) {
    findings.push({
      authority: 'Arithmetic',
      finding:
        `Suppliers are paid ${gapDays} day(s) before the client’s money arrives. That gap is funded by this business ` +
        'on every cycle, it scales with the job rather than with the fee, and the reserve is the only thing covering it.',
      severity: 'MATERIAL',
    });
  } else if (gapDays < 0) {
    findings.push({
      authority: 'Arithmetic',
      finding:
        `The client’s money arrives ${Math.abs(gapDays)} day(s) before the suppliers have to be paid. This is the ` +
        'position back-to-back terms are meant to produce, reached by the payment period rather than by a condition.',
      severity: 'ROUTINE',
    });
  }

  const daily = averageSupplierSpendPerPeriodMinor !== undefined && averageSupplierSpendPerPeriodMinor > 0
    ? averageSupplierSpendPerPeriodMinor / 30
    : 0;

  // Three cases, and the middle one used to be reported as the third.
  //
  // No gap at all is an exposure of nil, and that is a measurement: the money
  // arrives before it leaves, so there is nothing to price whatever the rate of
  // spend turns out to be. Reporting it as "not yet priced" put a caveat on the
  // one arrangement that does not need one — the screen showed a business that
  // had got its terms right and then told it the answer was pending.
  //
  // A real gap with no rate of spend to price it against is the case that is
  // genuinely unmeasured, and it keeps the caveat.
  const exposure =
    gapDays <= 0 ? { exposureMinor: 0 }
    : daily > 0 ? { exposureMinor: Math.round(daily * gapDays) }
    : {
        unmeasured:
          'Nothing has been certified down the chain yet, so there is no rate of supplier spend to price the gap ' +
          'against. It becomes measurable with the first supplier certificate.',
      };

  return {
    clientPaymentDays: terms.clientPaymentDays,
    supplierPaymentDays: terms.supplierPaymentDays,
    gapDays,
    ...exposure,
    lawful: !findings.some((entry) => entry.severity === 'BAR'),
    findings,
  };
}

function requireAccount(ctx: EngineContext): { refId: string; state: Record<string, unknown> } {
  const record = ctx.ledger.list(ctx.projectId, 'IntegrationAccount')[0];
  if (!record) {
    throw new DomainError(
      'INTEGRATION_ACCOUNT_NOT_FOUND',
      'This appointment has not been priced, so there is no commercial account to post against.',
      404,
    );
  }
  return { refId: record.refId, state: record.state as Record<string, unknown> };
}

// --- The position ------------------------------------------------------------

export type IntegratorConcern = {
  kind:
    | 'RESERVE_SHORT'
    | 'PAYING_OUT_FASTER'
    | 'CONTINGENCY_UNDRAWN_RISK'
    | 'NOT_PRICED'
    | 'TERMS_NOT_RECORDED'
    | 'FUNDING_GAP'
    | 'VOID_PAYMENT_CONDITION'
    | 'FLOW_DOWN_BREACH';
  subject: string;
  consequence: string;
};

export type IntegratorPosition = {
  priced: boolean;
  model?: string;
  price?: IntegrationPrice;
  /** What the reserve holds, and what it is against. */
  reserve: {
    advanceHeldMinor: number;
    /** Committed to suppliers and not yet paid — what the account is actually for. */
    owedToSuppliersMinor: number;
    /** What the client owes and has not paid. */
    owedByClientMinor: number;
    /** Days of committed supplier spend the advance covers, where that is measurable. */
    coverDays?: number;
    /** Named when cover cannot be worked out, rather than reported as zero. */
    unmeasured?: string;
  };
  contingency: { pricedMinor: number; drawnMinor: number; remainingMinor: number };
  /** What this business funds and what it does not, from the trading model. */
  trading?: { model: TradingModel; label: string; fundsSupplierCost: boolean; cashRisk: string; marginRisk: string };
  /**
   * The three arrangements and what each one costs, published rather than
   * described in the console.
   *
   * The pricing form used to carry its own one-line description of each model,
   * written before the models did anything, and two of the three had drifted
   * into saying the opposite of what the platform now does with them. A screen
   * that names a commercial position the API does not publish is a second
   * source of truth for the rule, which is settled decision 6.
   */
  models: Array<{ model: TradingModel; label: string; fundsSupplierCost: boolean; cashRisk: string; marginRisk: string }>;
  /** The gap between being paid and paying, once the terms are on the record. */
  fundingGap?: FundingGap;
  concerns: IntegratorConcern[];
  summary: string;
};

/**
 * The one screen a business running this model needs, and the questions it
 * answers are the ones that decide whether the business is still here next year.
 *
 * Not a dashboard of everything the platform knows. Four concerns, each of
 * which is a specific way an integrator fails, and each stated with what
 * happens if it is left.
 */

/** The catalogue, in one shape, so the position and the console agree. */
const modelCatalogue = (): IntegratorPosition['models'] =>
  (Object.keys(TRADING_MODEL) as TradingModel[]).map((model) => ({ model, ...TRADING_MODEL[model] }));

export function integratorPosition(ctx: EngineContext, today?: string): IntegratorPosition {
  authorise(ctx, 'BUDGET_COST', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = ctx.ledger.list(ctx.projectId, 'IntegrationAccount')[0];
  const concerns: IntegratorConcern[] = [];

  if (!record) {
    return {
      priced: false,
      reserve: { advanceHeldMinor: 0, owedToSuppliersMinor: 0, owedByClientMinor: 0, unmeasured: 'Nothing has been priced.' },
      contingency: { pricedMinor: 0, drawnMinor: 0, remainingMinor: 0 },
      models: modelCatalogue(),
      concerns: [
        {
          kind: 'NOT_PRICED',
          subject: 'This appointment has no commercial account',
          consequence:
            'There is no build-up to defend to the client, no contingency held against the risks, and nothing to ' +
            'measure the reserve against.',
        },
      ],
      summary: 'Not priced. Everything below depends on it.',
    };
  }

  const price = record.state.price as IntegrationPrice;
  const advanceHeldMinor = Number(record.state.advanceHeldMinor ?? 0);
  const drawnMinor = Number(record.state.contingencyDrawnMinor ?? 0);
  const draws = (record.state.draws as Array<{ riskReference?: string }> | undefined) ?? [];

  // From what the platform already holds, rather than a second set of figures.
  const cash = forwardCashflow(ctx, today);
  const ledger = ledgerPosition(ctx);

  const owedToSuppliersMinor = cash.outflow.certifiedUnpaidMinor;
  const owedByClientMinor = cash.certifiedUnpaidMinor;

  // Cover, in days, against the rate money actually leaves. Reported as
  // unmeasured rather than as a large number when nothing has been certified
  // down the chain yet — a reserve that covers an outflow of zero covers
  // nothing, and saying "infinite cover" would be the most dangerous possible
  // answer on a project that has not started paying anybody.
  const perPeriod = cash.outflow.averagePerPeriodMinor ?? 0;
  const dailyOutflow = perPeriod > 0 ? perPeriod / 30 : 0;
  const coverDays = dailyOutflow > 0 ? Math.floor(advanceHeldMinor / dailyOutflow) : undefined;
  const required = config.billing.integrationReserveCoverDays;

  // Which of the three arrangements this is, and therefore which of the
  // concerns below can arise at all. On a fee appointment there is no supplier
  // cost in this business's account, so a reserve against supplier payment is a
  // warning about an outflow that does not exist — and raising it would train
  // whoever reads this screen to ignore it on the appointment where it is real.
  const model = (String(record.state.model ?? 'PRINCIPAL_SERVICE_CONTRACTOR') as TradingModel);
  const trading = TRADING_MODEL[model] ?? TRADING_MODEL.PRINCIPAL_SERVICE_CONTRACTOR;
  const carriesSupplierCash = trading.fundsSupplierCost;

  const terms = record.state.tradingTerms as TradingTerms | undefined;
  const fundingGap = terms ? assessTerms(terms, perPeriod) : undefined;

  if (carriesSupplierCash && !terms) {
    concerns.push({
      kind: 'TERMS_NOT_RECORDED',
      subject: 'Nobody has recorded when the client pays and when the suppliers are paid',
      consequence:
        'This business pays suppliers and is paid by the client, and the platform cannot say which happens first. ' +
        'That difference is the whole cash exposure of the model, and it is the one number that can be fixed before ' +
        'the contracts are signed rather than argued about afterwards.',
    });
  }

  if (fundingGap) {
    for (const finding of fundingGap.findings) {
      if (finding.authority === 'HGCRA 1996 s.113') {
        concerns.push({
          kind: 'VOID_PAYMENT_CONDITION',
          subject: 'The subcontract pays when this business is paid, and that term has no effect',
          consequence: finding.finding,
        });
      } else if (finding.authority.startsWith('Public Contracts Regulations')) {
        concerns.push({
          kind: 'FLOW_DOWN_BREACH',
          subject: `Suppliers are paid at ${fundingGap.supplierPaymentDays} days on a public contract`,
          consequence: finding.finding,
        });
      }
    }

    if (carriesSupplierCash && fundingGap.gapDays > 0) {
      concerns.push({
        kind: 'FUNDING_GAP',
        subject:
          `Suppliers are paid ${fundingGap.gapDays} day(s) before the client pays` +
          `${fundingGap.exposureMinor ? `, about ${abbreviateMoney(fundingGap.exposureMinor)} at the current rate of spend` : ''}`,
        consequence:
          'Every cycle, this business funds the chain for that many days out of its own money. It is the gap the ' +
          'reserve has to cover, and lengthening the subcontract payment period closes it lawfully where a ' +
          'pay-when-paid clause does not.',
      });
    }
  }

  if (carriesSupplierCash && coverDays !== undefined && coverDays < required) {
    concerns.push({
      kind: 'RESERVE_SHORT',
      subject: `The advance covers ${coverDays} day(s) of supplier spend, against ${required} required`,
      consequence:
        'If the client pays late — and on a first appointment they will at least once — there is not enough in the ' +
        'account to pay the suppliers on their due date. Missing a supplier payment on an integrated contract loses ' +
        'the supply chain, and the supply chain is the service.',
    });
  }

  if (carriesSupplierCash && owedToSuppliersMinor > owedByClientMinor + advanceHeldMinor) {
    concerns.push({
      kind: 'PAYING_OUT_FASTER',
      subject: 'More is certified down the chain than is owed up it and held in the reserve combined',
      consequence:
        'This business is funding the client. That is survivable for one cycle and is how integrators fail over ' +
        'three — the gap grows with the job rather than closing.',
    });
  }

  const undated = draws.filter((draw) => !draw.riskReference || draw.riskReference.trim() === '').length;
  if (undated > 0) {
    concerns.push({
      kind: 'CONTINGENCY_UNDRAWN_RISK',
      subject: `${undated} contingency draw(s) name no risk`,
      consequence:
        'Contingency spent on something nobody identified is an underestimate or a scope change. Recorded here it ' +
        'looks like neither, and the next job is priced on the same wrong figure.',
    });
  }

  const remainingMinor = price.contingencyMinor - drawnMinor;

  return {
    priced: true,
    model: String(record.state.model ?? ''),
    price,
    reserve: {
      advanceHeldMinor,
      owedToSuppliersMinor,
      owedByClientMinor,
      ...(coverDays === undefined
        ? {
            unmeasured:
              'Nothing has been certified down the chain yet, so there is no outflow rate to measure the reserve ' +
              'against. Cover becomes measurable with the first supplier certificate.',
          }
        : { coverDays }),
    },
    contingency: { pricedMinor: price.contingencyMinor, drawnMinor, remainingMinor },
    trading: {
      model,
      label: trading.label,
      fundsSupplierCost: trading.fundsSupplierCost,
      cashRisk: trading.cashRisk,
      marginRisk: trading.marginRisk,
    },
    models: modelCatalogue(),
    ...(fundingGap ? { fundingGap } : {}),
    concerns,
    // The reserve position is stated whether or not there are concerns.
    //
    // It used to be one or the other: a concern count replaced the reserve
    // sentence entirely, so the moment anything else needed attention the reader
    // lost the answer to the question this screen exists for. "3 things need
    // attention" says nothing about whether there is money in the account.
    summary:
      `${priceSentence(price)}${concerns.length > 0 ? ` ${concerns.length} thing(s) need attention.` : ''} ` +
      `${reserveVerdict(coverDays, carriesSupplierCash)}` +
      `${ledger.exceptions.length > 0 ? ` The cost ledger carries ${ledger.exceptions.length} exception(s) of its own.` : ''}`,
  };
}

/**
 * What the price sentence is allowed to claim.
 *
 * On a fee appointment, "priced at £5.25m on £5m of supplier cost" describes a
 * turnover this business will never see: the suppliers invoice the client and
 * the fee is the whole of the income. The same sentence for both models was one
 * of the ways the stored `model` label looked load-bearing while changing
 * nothing.
 */
function priceSentence(price: IntegrationPrice): string {
  if (price.passThroughMinor === 0) {
    return (
      `A fee of ${abbreviateMoney(price.additionMinor)} against ${abbreviateMoney(price.directSupplierCostMinor)} of ` +
      `supplier cost the client contracts and pays directly — ${price.additionPercent}% of the value coordinated, and ` +
      'none of it passing through this business.'
    );
  }
  return (
    `Priced at ${abbreviateMoney(price.contractPriceMinor)} on ${abbreviateMoney(price.directSupplierCostMinor)} of ` +
    `supplier cost — ${price.additionPercent}% above it, of which ${abbreviateMoney(price.contingencyMinor)} is ` +
    'contingency and not margin.'
  );
}

/**
 * What the summary is allowed to say about the reserve.
 *
 * Saying "the reserve covers what is committed" because no concern was raised
 * is the same mistake `coverDays` refuses to make one branch above: with
 * nothing certified down the chain there is no outflow to cover, so the absence
 * of a warning is the absence of a measurement, not an assurance. Reporting it
 * as one would tell a business it is safe at exactly the point it has not
 * started paying anybody — which is the point at which it still has time to do
 * something about it.
 */
function reserveVerdict(coverDays: number | undefined, carriesSupplierCash: boolean): string {
  // On a fee appointment there is no supplier outflow to cover, so saying the
  // reserve does or does not cover it is answering a question nobody asked.
  if (!carriesSupplierCash) {
    // The price sentence has already said the supplier cost does not pass
    // through, so repeating it here reads as padding on the one screen written
    // to be read quickly. What this adds is the consequence.
    return 'There is no supplier payment gap to hold a reserve against.';
  }
  if (coverDays === undefined) return 'Whether the reserve covers what is committed cannot be answered yet.';
  return `The reserve covers ${coverDays} day(s) of supplier spend, which is what is committed.`;
}
