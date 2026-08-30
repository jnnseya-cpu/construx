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
  components: PriceComponent[];
  /** Everything above direct cost, as one figure and as a percentage of it. */
  additionMinor: number;
  additionPercent: number;
  contractPriceMinor: number;
  /**
   * Held against the risk register and returned, shared or converted if it is
   * not needed. Called out separately because it is the component most often
   * quietly counted as margin.
   */
  contingencyMinor: number;
  /** What the business actually earns if nothing goes wrong. */
  marginMinor: number;
};

function buildPrice(directSupplierCostMinor: number): IntegrationPrice {
  const pct = (value: number): number => Math.round(directSupplierCostMinor * (value / 100));

  const components: PriceComponent[] = [
    {
      label: 'Contingency',
      percent: config.billing.integrationContingencyPercent,
      amountMinor: pct(config.billing.integrationContingencyPercent),
      basis:
        'Held against the risk register, drawn only against a risk that has materialised, and not this business’s ' +
        'money until the contract says it is.',
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

  return {
    directSupplierCostMinor,
    components,
    additionMinor,
    additionPercent:
      directSupplierCostMinor > 0 ? Math.round((additionMinor / directSupplierCostMinor) * 1000) / 10 : 0,
    contractPriceMinor: directSupplierCostMinor + additionMinor,
    contingencyMinor,
    // Contingency is deliberately not in this figure. A business that counts it
    // as margin has mispriced every job after the first one.
    marginMinor: additionMinor - contingencyMinor,
  };
}

/** The build-up on its own, for a screen that quotes before anything is committed. */
export function quoteIntegration(ctx: EngineContext, directSupplierCostMinor: number): IntegrationPrice {
  authorise(ctx, 'BUDGET_COST', 'R', { dataSensitivity: 'COMMERCIAL_L3' });
  return buildPrice(directSupplierCostMinor);
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
  input: { directSupplierCostMinor: number; model: 'ADVISORY' | 'MANAGEMENT_INTEGRATOR' | 'PRINCIPAL_SERVICE_CONTRACTOR'; note?: string },
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

  const price = buildPrice(input.directSupplierCostMinor);
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
  kind: 'RESERVE_SHORT' | 'PAYING_OUT_FASTER' | 'CONTINGENCY_UNDRAWN_RISK' | 'NOT_PRICED';
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
export function integratorPosition(ctx: EngineContext, today?: string): IntegratorPosition {
  authorise(ctx, 'BUDGET_COST', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = ctx.ledger.list(ctx.projectId, 'IntegrationAccount')[0];
  const concerns: IntegratorConcern[] = [];

  if (!record) {
    return {
      priced: false,
      reserve: { advanceHeldMinor: 0, owedToSuppliersMinor: 0, owedByClientMinor: 0, unmeasured: 'Nothing has been priced.' },
      contingency: { pricedMinor: 0, drawnMinor: 0, remainingMinor: 0 },
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

  if (coverDays !== undefined && coverDays < required) {
    concerns.push({
      kind: 'RESERVE_SHORT',
      subject: `The advance covers ${coverDays} day(s) of supplier spend, against ${required} required`,
      consequence:
        'If the client pays late — and on a first appointment they will at least once — there is not enough in the ' +
        'account to pay the suppliers on their due date. Missing a supplier payment on an integrated contract loses ' +
        'the supply chain, and the supply chain is the service.',
    });
  }

  if (owedToSuppliersMinor > owedByClientMinor + advanceHeldMinor) {
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
    concerns,
    summary:
      `Priced at ${abbreviateMoney(price.contractPriceMinor)} on ${abbreviateMoney(price.directSupplierCostMinor)} of ` +
      `supplier cost — ${price.additionPercent}% above it, of which ${abbreviateMoney(price.contingencyMinor)} is ` +
      `contingency and not margin. ${reserveVerdict(coverDays, concerns.length)}` +
      `${ledger.exceptions.length > 0 ? ` The cost ledger carries ${ledger.exceptions.length} exception(s) of its own.` : ''}`,
  };
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
function reserveVerdict(coverDays: number | undefined, concernCount: number): string {
  if (concernCount > 0) return `${concernCount} thing(s) need attention.`;
  if (coverDays === undefined) return 'Whether the reserve covers what is committed cannot be answered yet.';
  return `The reserve covers ${coverDays} day(s) of supplier spend, which is what is committed.`;
}
