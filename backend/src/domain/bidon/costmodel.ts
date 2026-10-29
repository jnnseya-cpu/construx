import { DomainError } from '../../core/errors.ts';
import { authorise, type EngineContext } from '../../engines/context.ts';
import { requireModuleReadable } from '../../identity/modules.ts';
import {
  runRateCardImport,
  tenderRateEntries,
  type RateCardImportEntry,
  type RateCardImportResult,
} from '../costintel.ts';
import { requireBid, requireWorkableBid } from './bids.ts';

/**
 * A cost-model build-up: the arithmetic that turns what a job costs into a
 * price, done in the open so a client is not pricing blind.
 *
 * ## What this is, and what it is deliberately not
 *
 * It takes the client's **own** numbers — what a unit costs them, how many
 * units, any fixed cost across the line, and the margin they want — and returns
 * the price those numbers imply, with the profit shown both ways round. It does
 * **not** hold, fetch or suggest a market price. A rate card, what a competitor
 * charges, what the market will bear: all of that is the client's commercial
 * judgement and their information to bring, and a tool that invented a number
 * there would be guessing with someone else's money. This module does the sum;
 * the client supplies the inputs and decides whether the answer is a price they
 * want to offer.
 *
 * ## Why the profit is shown twice
 *
 * "20% margin" is said two incompatible ways, and the difference is real money.
 * A **markup on cost** of 20% on a £100 cost is a £120 price — a profit that is
 * 20% of cost but only ~16.7% of the price. A **margin on price** of 20% on the
 * same cost is a £125 price. Pricing a tender against a "20% margin" instruction
 * while computing it as a markup under-recovers on every line, and nobody sees
 * it until the job is run. So the build-up is computed on the basis the client
 * names, and the result states both the margin-on-cost and the margin-on-price,
 * so whichever the evaluator meant, the client can see what they are actually
 * making.
 *
 * ## The check against a price the client is weighing
 *
 * The defect this exists to stop was a real one: a unit priced at £45 against a
 * modelled cost of £68, a loss on every unit, discovered after submission. So a
 * client may pass a `proposedUnitPriceMinor` they are considering (from the
 * market, from an instinct, from last year's bid) and the build-up says what
 * margin it yields and warns, in plain words, if it is below cost or below the
 * margin they said they wanted. That is the whole point: not to set the price,
 * but to make sure the client sees what a price does before they commit it.
 */

export const MARGIN_BASIS = ['ON_COST', 'ON_PRICE'] as const;
export type MarginBasis = (typeof MARGIN_BASIS)[number];

export type CostBuildUpInput = {
  /**
   * What one unit costs the client, all-in, in minor units (pence). Their own
   * figure — the subcontractor rate plus whatever they add to it. The module
   * does not itemise it; the client's build-up of it is the client's.
   */
  unitCostMinor: number;
  /** How many units this line prices (e.g. EPCs in a locality). At least one. */
  quantity: number;
  /**
   * Cost across the whole line that is not per-unit — mobilisation, a site
   * visit, project management — in minor units. Optional; nought when absent.
   */
  fixedCostMinor?: number;
  /**
   * The profit the client wants, as a fraction: 0.2 is twenty per cent. Read
   * against `marginBasis`, because twenty per cent means two different prices.
   */
  targetMargin: number;
  marginBasis: MarginBasis;
  /**
   * A price per unit the client is weighing, in minor units. Optional. When
   * given, the result says what margin it makes and warns if it loses money or
   * falls short of the target — it never changes the computed price.
   */
  proposedUnitPriceMinor?: number;
};

export type CostBuildUp = {
  quantity: number;
  unitCostMinor: number;
  fixedCostMinor: number;
  /** unitCost × quantity. */
  directCostMinor: number;
  /** direct + fixed: what the line costs the client in total. */
  totalCostMinor: number;
  marginBasis: MarginBasis;
  targetMargin: number;
  /** The price for the whole line that the cost and the margin imply. */
  priceMinor: number;
  /** price ÷ quantity, rounded — what one unit is offered at. */
  unitPriceMinor: number;
  /** price − totalCost. */
  profitMinor: number;
  /** profit ÷ cost. */
  marginOnCost: number;
  /** profit ÷ price. */
  marginOnPrice: number;
  /** The reading of a price the client is weighing, where they gave one. */
  proposed?: {
    unitPriceMinor: number;
    priceMinor: number;
    profitMinor: number;
    marginOnCost: number;
    marginOnPrice: number;
    /** True where the proposed price does not even cover cost. */
    belowCost: boolean;
    /** True where it covers cost but makes less than the target margin. */
    belowTarget: boolean;
  };
  /** Plain-English notes: how the price was derived, and any warning. */
  notes: string[];
};

const round = (value: number): number => Math.round(value);
/** A fraction to one decimal place as a percentage, for a readable note. */
const asPercent = (fraction: number): string => `${Math.round(fraction * 1000) / 10}%`;

/**
 * The build-up, as pure arithmetic. Exported for direct testing; the route goes
 * through `costModelBuildUp`, which adds the module and permission checks.
 */
export function costBuildUp(input: CostBuildUpInput): CostBuildUp {
  if (!Number.isFinite(input.unitCostMinor) || input.unitCostMinor < 0) {
    throw new DomainError('BID_ON_COST_NEGATIVE', 'A unit cost cannot be negative.', 400);
  }
  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    throw new DomainError('BID_ON_COST_QUANTITY', 'A line prices at least one unit, and a count is a whole number.', 400);
  }
  const fixedCostMinor = input.fixedCostMinor ?? 0;
  if (!Number.isFinite(fixedCostMinor) || fixedCostMinor < 0) {
    throw new DomainError('BID_ON_COST_NEGATIVE', 'A fixed cost cannot be negative.', 400);
  }
  if (!Number.isFinite(input.targetMargin) || input.targetMargin < 0) {
    throw new DomainError('BID_ON_COST_MARGIN', 'A target margin cannot be negative.', 400);
  }
  if (input.marginBasis === 'ON_PRICE' && input.targetMargin >= 1) {
    throw new DomainError(
      'BID_ON_COST_MARGIN',
      'A margin on price has to be below 100%: at 100% the price would have to be infinite to leave that share as ' +
        'profit. If you mean "cost plus 100%", that is a markup on cost, not a margin on price.',
      400,
    );
  }

  const directCostMinor = round(input.unitCostMinor * input.quantity);
  const totalCostMinor = directCostMinor + fixedCostMinor;

  const priceMinor =
    input.marginBasis === 'ON_COST'
      ? round(totalCostMinor * (1 + input.targetMargin))
      : round(totalCostMinor / (1 - input.targetMargin));
  const unitPriceMinor = round(priceMinor / input.quantity);
  const profitMinor = priceMinor - totalCostMinor;
  const marginOnCost = totalCostMinor === 0 ? 0 : profitMinor / totalCostMinor;
  const marginOnPrice = priceMinor === 0 ? 0 : profitMinor / priceMinor;

  const notes: string[] = [
    input.marginBasis === 'ON_COST'
      ? `Price is cost plus ${asPercent(input.targetMargin)} (a markup on cost). That is a profit of ` +
        `${asPercent(marginOnPrice)} of the price.`
      : `Price leaves ${asPercent(input.targetMargin)} of the price as profit (a margin on price). That is a ` +
        `markup of ${asPercent(marginOnCost)} on cost.`,
  ];

  const result: CostBuildUp = {
    quantity: input.quantity,
    unitCostMinor: input.unitCostMinor,
    fixedCostMinor,
    directCostMinor,
    totalCostMinor,
    marginBasis: input.marginBasis,
    targetMargin: input.targetMargin,
    priceMinor,
    unitPriceMinor,
    profitMinor,
    marginOnCost,
    marginOnPrice,
    notes,
  };

  if (input.proposedUnitPriceMinor !== undefined) {
    if (!Number.isFinite(input.proposedUnitPriceMinor) || input.proposedUnitPriceMinor < 0) {
      throw new DomainError('BID_ON_COST_NEGATIVE', 'A proposed price cannot be negative.', 400);
    }
    const proposedPriceMinor = round(input.proposedUnitPriceMinor * input.quantity);
    const proposedProfitMinor = proposedPriceMinor - totalCostMinor;
    const belowCost = proposedProfitMinor < 0;
    const belowTarget = !belowCost && proposedProfitMinor < profitMinor;
    result.proposed = {
      unitPriceMinor: input.proposedUnitPriceMinor,
      priceMinor: proposedPriceMinor,
      profitMinor: proposedProfitMinor,
      marginOnCost: totalCostMinor === 0 ? 0 : proposedProfitMinor / totalCostMinor,
      marginOnPrice: proposedPriceMinor === 0 ? 0 : proposedProfitMinor / proposedPriceMinor,
      belowCost,
      belowTarget,
    };
    if (belowCost) {
      notes.push(
        'The price you are weighing is below cost. Every unit at it loses money, and the more you sell the more ' +
          'you lose — this is the trap that is only found after the job is won.',
      );
    } else if (belowTarget) {
      notes.push(
        `The price you are weighing makes ${asPercent(result.proposed.marginOnCost)} on cost, below the ` +
          `${asPercent(input.targetMargin)} you set. It is profitable, but thinner than you intended — a deliberate ` +
          'choice to win on price, not a number to reach by accident.',
      );
    } else {
      notes.push(
        `The price you are weighing makes ${asPercent(result.proposed.marginOnCost)} on cost, at or above the ` +
          'margin you set.',
      );
    }
  }

  return result;
}

/**
 * The build-up behind the module and permission checks, for the route.
 *
 * It reads nothing and writes nothing — it is arithmetic on numbers the caller
 * sends — but it is gated on the Bid-On module so it is a tool for Bid-On
 * tenants rather than a public calculator, and on the same `BID_SERVICES` read
 * permission as reading a pack, since that is who prices one.
 */
export function costModelBuildUp(ctx: EngineContext, input: CostBuildUpInput): CostBuildUp {
  requireModuleReadable(ctx.grantedModules, ctx.heldModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'R', { dataSensitivity: 'COMMERCIAL_L3' });
  return costBuildUp(input);
}

/**
 * Import a rate card for one tender, held for that bid and no longer.
 *
 * The same paste or CSV a firm loads into its permanent library, but scoped to a
 * single Bid-On bid. External customers are often a one-off, and their rates are
 * not the firm's own house rates — so they are kept against the bid, used to
 * price it (the cost-model build-up can pull a unit cost from them), and never
 * harvested into the cross-tender library. A future tender that needs them
 * imports them again. The parsing, de-duplication and honest skip-reporting are
 * exactly the library import's, via the shared core; only the scope differs.
 */
export function importTenderRateCard(
  ctx: EngineContext,
  bidId: string,
  input: { entries: RateCardImportEntry[] },
): RateCardImportResult {
  requireModuleReadable(ctx.grantedModules, ctx.heldModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'C', { dataSensitivity: 'COMMERCIAL_L3' });
  // A sent bid, or one under a paused engagement, is not priced further.
  const { bid } = requireWorkableBid(ctx, bidId);
  return runRateCardImport(ctx, input.entries, { bidId: bid.id });
}

/**
 * The rates held for one tender, to price its bid.
 *
 * Each is a THIN starting point by construction: a per-tender rate is a copy the
 * client brought, never corroborated by a committed bid, so it carries no
 * confidence beyond "this is the number you imported".
 */
export function tenderRateCard(
  ctx: EngineContext,
  bidId: string,
): { bidId: string; rates: Array<{ code?: string; description: string; unit: string; rateMinor: number; note?: string; confidence: 'THIN' }> } {
  requireModuleReadable(ctx.grantedModules, ctx.heldModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'R', { dataSensitivity: 'COMMERCIAL_L3' });
  const bid = requireBid(ctx, bidId);
  const rates = tenderRateEntries(ctx, bid.id)
    .map((entry) => ({
      ...(entry.code ? { code: entry.code } : {}),
      description: entry.description,
      unit: entry.unit,
      rateMinor: Number(entry.rateMinor),
      ...(entry.note ? { note: entry.note } : {}),
      confidence: 'THIN' as const,
    }))
    .sort((a, b) => a.description.localeCompare(b.description, 'en', { numeric: true }));
  return { bidId: bid.id, rates };
}
