import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { estimateProgrammeDuration } from '../src/engines/maths/programmeDuration.ts';

/**
 * The duration estimate is two legs taken against each other: measured value
 * over a weekly throughput, and a sequence floor from the trade phases present.
 * The larger wins, nudged by complexity. These pin that it is a reconciliation
 * of the two, not one of them — and that it never claims more than LOW
 * confidence, because it is an estimate from works, not a built programme.
 */

const ASSUMPTIONS = { weeklyThroughputMinor: 450_000, minWeeksPerSequenceStep: 1 };

describe('programme duration · the value leg and the sequence floor', () => {
  it('takes the value leg when the works are dense and span few trades', () => {
    // £90k across two trades: value leg 20 wk beats a floor of 2 wk.
    const est = estimateProgrammeDuration({ netMeasuredMinor: 9_000_000, tradeGroups: 2, ...ASSUMPTIONS });
    assert.equal(est.weeks, 20);
    assert.equal(est.sequenceFloorWeeks, 2);
    assert.equal(est.valueWeeks, 20);
  });

  it('takes the sequence floor when a small value spans many trades', () => {
    // £4.5k across eight trades: value leg 1 wk, but eight phases cannot run at once.
    const est = estimateProgrammeDuration({ netMeasuredMinor: 450_000, tradeGroups: 8, ...ASSUMPTIONS });
    assert.equal(est.weeks, 8, 'the floor, not the value leg, sets the duration');
    assert.equal(est.sequenceFloorWeeks, 8);
  });

  it('reconciles value and sequence on a real small-works bill (~£32.5k, 6 trades)', () => {
    const est = estimateProgrammeDuration({ netMeasuredMinor: 3_254_757, tradeGroups: 6, ...ASSUMPTIONS });
    // value leg ≈ 7.2 wk beats the 6 wk floor → ~7 weeks, near a hand-set 8.
    assert.equal(est.weeks, 7);
    assert.equal(est.valueWeeks, 7.2);
    assert.equal(est.confidence, 'LOW');
  });

  it('stretches for complexity and compresses for a simple job', () => {
    const base = { netMeasuredMinor: 3_254_757, tradeGroups: 6, ...ASSUMPTIONS };
    const complex = estimateProgrammeDuration({ ...base, complexity: 'COMPLEX' });
    const simple = estimateProgrammeDuration({ ...base, complexity: 'SIMPLE' });
    assert.equal(complex.weeks, 9, '7.23 × 1.25 ≈ 9');
    assert.equal(simple.weeks, 6, '7.23 × 0.85 ≈ 6');
  });

  it('never returns less than a week, and always states its basis and that it is low confidence', () => {
    const est = estimateProgrammeDuration({ netMeasuredMinor: 0, tradeGroups: 1, ...ASSUMPTIONS });
    assert.equal(est.weeks, 1);
    assert.equal(est.confidence, 'LOW');
    assert.match(est.basis, /value leg/);
    assert.ok(est.assumptions.some((a) => /not a market-researched/.test(a)), 'says plainly it is not market data');
  });
});
