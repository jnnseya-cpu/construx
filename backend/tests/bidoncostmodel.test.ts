import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { costBuildUp } from '../src/domain/bidon/costmodel.ts';

/**
 * The cost-model build-up: pure arithmetic on the client's own numbers.
 *
 * Two things are being pinned here. First, that the sum is right — markup and
 * margin are not the same figure, and getting them confused under-recovers on
 * every line. Second, the property that makes it safe to ship: it computes a
 * price from a cost and a margin and never the other way round, so it cannot
 * invent a market price. The client brings the cost and the margin; the module
 * does nothing a pocket calculator could not, only out loud.
 */

describe('the cost-model build-up prices from the client’s own numbers', () => {
  it('prices cost-plus, and shows the smaller margin-on-price beside it', () => {
    const built = costBuildUp({ unitCostMinor: 6800, quantity: 250, targetMargin: 0.2, marginBasis: 'ON_COST' });
    assert.equal(built.directCostMinor, 1_700_000);
    assert.equal(built.totalCostMinor, 1_700_000);
    assert.equal(built.priceMinor, 2_040_000);
    assert.equal(built.unitPriceMinor, 8160);
    assert.equal(built.profitMinor, 340_000);
    assert.equal(built.marginOnCost, 0.2);
    // A 20% markup on cost is only ~16.7% of the price — the trap this names.
    assert.ok(Math.abs(built.marginOnPrice - 1 / 6) < 1e-9);
    assert.match(built.notes[0]!, /markup on cost/);
  });

  it('prices a margin on price, which is a larger number than the same markup', () => {
    const built = costBuildUp({ unitCostMinor: 100_000, quantity: 1, targetMargin: 0.2, marginBasis: 'ON_PRICE' });
    assert.equal(built.priceMinor, 125_000);
    assert.equal(built.profitMinor, 25_000);
    assert.equal(built.marginOnPrice, 0.2);
    assert.equal(built.marginOnCost, 0.25);
    assert.match(built.notes[0]!, /margin on price/);
  });

  it('adds a fixed cost across the line before the margin', () => {
    const built = costBuildUp({
      unitCostMinor: 6800,
      quantity: 250,
      fixedCostMinor: 50_000,
      targetMargin: 0.2,
      marginBasis: 'ON_COST',
    });
    assert.equal(built.totalCostMinor, 1_750_000);
    assert.equal(built.priceMinor, 2_100_000);
    assert.equal(built.profitMinor, 350_000);
  });

  it('flags a price below cost — the £45-against-£68 loss this exists to stop', () => {
    const built = costBuildUp({
      unitCostMinor: 6800,
      quantity: 1,
      targetMargin: 0.2,
      marginBasis: 'ON_COST',
      proposedUnitPriceMinor: 4500,
    });
    assert.ok(built.proposed);
    assert.equal(built.proposed!.belowCost, true);
    assert.equal(built.proposed!.profitMinor, -2300);
    assert.ok(built.notes.some((line) => /below cost/.test(line)));
  });

  it('flags a profitable price that still falls short of the target margin', () => {
    const built = costBuildUp({
      unitCostMinor: 6800,
      quantity: 1,
      targetMargin: 0.2,
      marginBasis: 'ON_COST',
      proposedUnitPriceMinor: 7000,
    });
    assert.equal(built.proposed!.belowCost, false);
    assert.equal(built.proposed!.belowTarget, true);
    assert.ok(built.notes.some((line) => /below the .* you set|thinner than you intended/.test(line)));
  });

  it('is content with a price at or above the target', () => {
    const built = costBuildUp({
      unitCostMinor: 6800,
      quantity: 1,
      targetMargin: 0.2,
      marginBasis: 'ON_COST',
      proposedUnitPriceMinor: 9000,
    });
    assert.equal(built.proposed!.belowCost, false);
    assert.equal(built.proposed!.belowTarget, false);
  });

  it('refuses the inputs that are not a cost model', () => {
    throwsCode(() => costBuildUp({ unitCostMinor: -1, quantity: 1, targetMargin: 0.2, marginBasis: 'ON_COST' }), 'BID_ON_COST_NEGATIVE');
    throwsCode(() => costBuildUp({ unitCostMinor: 100, quantity: 0, targetMargin: 0.2, marginBasis: 'ON_COST' }), 'BID_ON_COST_QUANTITY');
    throwsCode(() => costBuildUp({ unitCostMinor: 100, quantity: 2.5, targetMargin: 0.2, marginBasis: 'ON_COST' }), 'BID_ON_COST_QUANTITY');
    throwsCode(() => costBuildUp({ unitCostMinor: 100, quantity: 1, targetMargin: -0.1, marginBasis: 'ON_COST' }), 'BID_ON_COST_MARGIN');
    // A 100% margin on price would need an infinite price to leave as profit.
    throwsCode(() => costBuildUp({ unitCostMinor: 100, quantity: 1, targetMargin: 1, marginBasis: 'ON_PRICE' }), 'BID_ON_COST_MARGIN');
  });
});
