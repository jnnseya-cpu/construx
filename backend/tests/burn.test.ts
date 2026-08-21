import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { estateBurn } from '../src/billing/burn.ts';
import type { ACUEntry } from '../src/billing/acu.ts';

/**
 * AI spend across the estate.
 *
 * The arithmetic is trivial; the judgements are not. Every test here is about a
 * figure that is easy to compute and easy to compute wrongly in a way that
 * looks completely normal on a dashboard.
 */

const NOW = new Date('2026-08-21T12:00:00.000Z');
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function entry(over: Partial<ACUEntry>): ACUEntry {
  return {
    id: `e-${Math.random().toString(36).slice(2)}`,
    tenantId: 't',
    type: 'DEBIT',
    rawCostMinor: 100,
    acuUnits: 100,
    billedMinor: 400,
    effectiveMultiplier: 4,
    timestamp: day(1),
    ...over,
  } as ACUEntry;
}

const tenant = (id: string, name: string, availableMinor: number, entries: ACUEntry[]) => ({
  tenantId: id,
  legalName: name,
  availableMinor,
  entries,
});

describe('what counts as spend', () => {
  it('counts a charge and ignores money coming in', () => {
    // A top-up is not spend. Counting it would make the estate look like it is
    // burning twice what it burns, and the error grows with every payment.
    const burn = estateBurn(
      [
        tenant('t1', 'Meridian', 100_000, [
          entry({ type: 'DEBIT', rawCostMinor: 100, billedMinor: 400 }),
          entry({ type: 'TOP_UP', rawCostMinor: 0, billedMinor: 500_000 }),
          entry({ type: 'GRANT', rawCostMinor: 0, billedMinor: 500 }),
        ]),
      ],
      30,
      NOW,
    );

    assert.equal(burn.billedMinor, 400, 'a top-up or grant was counted as spend');
    assert.equal(burn.rawCostMinor, 100);
  });

  it('ignores a hold, which reserves without spending', () => {
    const burn = estateBurn(
      [tenant('t1', 'Meridian', 100_000, [entry({ type: 'HOLD', billedMinor: 4_000, rawCostMinor: 1_000 })])],
      30,
      NOW,
    );
    assert.equal(burn.billedMinor, 0, 'a hold was counted as spend before it was settled');
  });

  it('excludes spend from outside the window', () => {
    const burn = estateBurn(
      [
        tenant('t1', 'Meridian', 100_000, [
          entry({ timestamp: day(5), billedMinor: 400, rawCostMinor: 100 }),
          entry({ timestamp: day(400), billedMinor: 99_999, rawCostMinor: 99_999 }),
        ]),
      ],
      30,
      NOW,
    );
    assert.equal(burn.billedMinor, 400, 'a charge from over a year ago is in the thirty-day burn');
  });
});

describe('runway', () => {
  it('is days of service left at the current rate', () => {
    // 3000 billed over 30 days is 100/day; 1000 available is ten days.
    const burn = estateBurn(
      [tenant('t1', 'Meridian', 1_000, [entry({ billedMinor: 3_000, rawCostMinor: 750 })])],
      30,
      NOW,
    );
    assert.equal(burn.tenants[0]!.dailyBurnMinor, 100);
    assert.equal(burn.tenants[0]!.runwayDays, 10);
  });

  it('is null for a tenant that is not spending, never a large number', () => {
    // Infinity does not survive JSON, and a very large number reads as the
    // healthiest account on the estate rather than as no data.
    const burn = estateBurn([tenant('t1', 'Dormant', 50_000, [])], 30, NOW);
    assert.equal(burn.tenants[0]!.runwayDays, null);
    assert.equal(burn.tenants[0]!.realisedMultiplier, null);
  });

  it('queues the tenants that run out inside the window, shortest first', () => {
    const burn = estateBurn(
      [
        tenant('slow', 'Slow', 30_000, [entry({ billedMinor: 3_000, rawCostMinor: 750 })]),
        tenant('urgent', 'Urgent', 300, [entry({ billedMinor: 3_000, rawCostMinor: 750 })]),
        tenant('soon', 'Soon', 1_500, [entry({ billedMinor: 3_000, rawCostMinor: 750 })]),
      ],
      30,
      NOW,
    );

    assert.deepEqual(burn.runningOut.map((t) => t.tenantId), ['urgent', 'soon']);
    assert.ok(
      !burn.runningOut.some((t) => t.tenantId === 'slow'),
      'a tenant with ten months of runway is in the urgent queue',
    );
  });
});

describe('realised margin', () => {
  it('reports what was charged, not what the multiplier says should have been', () => {
    // The divergence this catches: a charge raised at 4x and settled at 2.5x
    // through a volume incentive. A platform reporting its configured
    // multiplier as its margin is reporting an intention.
    const burn = estateBurn(
      [
        tenant('t1', 'Meridian', 100_000, [
          entry({ rawCostMinor: 100, billedMinor: 400, effectiveMultiplier: 4 }),
          entry({ rawCostMinor: 100, billedMinor: 250, effectiveMultiplier: 2.5 }),
        ]),
      ],
      30,
      NOW,
    );

    assert.equal(burn.realisedMultiplier, 3.25, 'the realised multiplier was taken from the configured one');
    assert.equal(burn.marginMinor, 450);
  });

  it('is null where nothing was spent — not one, and not zero', () => {
    // Zero would read as "we are charging nothing above cost", which is a
    // commercial emergency. One would read as break-even. Neither happened.
    const burn = estateBurn([tenant('t1', 'Dormant', 10, [])], 30, NOW);
    assert.equal(burn.realisedMultiplier, null);
    assert.equal(burn.marginMinor, 0);
  });
});

describe('concentration', () => {
  it('reveals a platform carried by one tenant', () => {
    // The arithmetic is identical whether revenue is spread or concentrated;
    // only the share tells the operator which platform they are running.
    const burn = estateBurn(
      [
        tenant('whale', 'Whale', 100_000, [entry({ billedMinor: 9_000, rawCostMinor: 2_250 })]),
        tenant('minnow', 'Minnow', 100_000, [entry({ billedMinor: 1_000, rawCostMinor: 250 })]),
      ],
      30,
      NOW,
    );

    assert.equal(burn.concentration, 0.9);
    assert.equal(burn.tenants[0]!.tenantId, 'whale', 'the estate view is not led by the biggest spender');
  });

  it('is null on an estate that has spent nothing', () => {
    const burn = estateBurn([tenant('t1', 'Dormant', 10, [])], 30, NOW);
    assert.equal(burn.concentration, null);
  });
});

describe('an empty estate', () => {
  it('returns zeroes and nulls rather than dividing by nothing', () => {
    const burn = estateBurn([], 30, NOW);
    assert.equal(burn.billedMinor, 0);
    assert.equal(burn.realisedMultiplier, null);
    assert.equal(burn.concentration, null);
    assert.deepEqual(burn.tenants, []);
    assert.deepEqual(burn.runningOut, []);
  });
});

describe('margin absorbed by the estimate cap', () => {
  it('explains a realised multiplier below the configured one', () => {
    // settle() caps a charge at the amount held, so an execution that overruns
    // its estimate costs the platform the difference. Found on the seeded
    // estate: a configured 4x realised as 3.787x. Without this figure the low
    // multiplier invites the diagnosis "the multiplier is misconfigured" and
    // the wrong fix.
    const burn = estateBurn(
      [
        tenant('t1', 'Meridian', 100_000, [
          // Estimated at 50, actually cost 100. At 4x that is 400; only 200 was
          // held and disclosed, so 200 is charged and 200 is absorbed.
          entry({ rawCostMinor: 100, billedMinor: 200, effectiveMultiplier: 4 }),
          entry({ rawCostMinor: 100, billedMinor: 400, effectiveMultiplier: 4 }),
        ]),
      ],
      30,
      NOW,
    );

    assert.equal(burn.absorbedMinor, 200);
    assert.equal(burn.realisedMultiplier, 3, 'the realised figure did not fall as the cap bit');
    // The two reconcile: charging in full would have produced exactly 4x.
    assert.equal((burn.billedMinor + burn.absorbedMinor) / burn.rawCostMinor, 4);
  });

  it('is zero when every execution came in at or under its estimate', () => {
    const burn = estateBurn(
      [tenant('t1', 'Meridian', 100_000, [entry({ rawCostMinor: 100, billedMinor: 400, effectiveMultiplier: 4 })])],
      30,
      NOW,
    );
    assert.equal(burn.absorbedMinor, 0);
    assert.equal(burn.realisedMultiplier, 4);
  });

  it('never reports a negative absorption', () => {
    // A charge above the entry's own multiplier is not the platform absorbing
    // anything, and reporting it as negative absorption would net off against a
    // real overrun elsewhere and hide it.
    const burn = estateBurn(
      [tenant('t1', 'Odd', 100_000, [entry({ rawCostMinor: 100, billedMinor: 900, effectiveMultiplier: 4 })])],
      30,
      NOW,
    );
    assert.equal(burn.absorbedMinor, 0);
  });
});
