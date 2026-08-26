import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { estateBurn } from '../src/billing/burn.ts';
import { estateOverview } from '../src/billing/overview.ts';
import type { ACUEntry } from '../src/billing/acu.ts';
import type { PaymentReceipt } from '../src/billing/payments.ts';

/**
 * The operator command centre.
 *
 * Everything here is arithmetic a dashboard performs on real records, and every
 * test is about a figure that is easy to compute and easy to compute wrongly in
 * a way that looks entirely normal on screen. A dashboard does not crash when it
 * lies; it renders a confident number, and somebody acts on it.
 *
 * Three failure modes get most of the attention below:
 *
 * **A gap read as a shape.** A daily series that omits the days with no activity
 * draws a rising line out of a flat month, because the quiet days simply are not
 * there to pull it down.
 *
 * **A zero read as a fact.** Extrapolating a month from one elapsed day, or
 * reporting a seat ceiling that excludes the uncapped tenancies, produces a
 * number that is not marked as an estimate and is not one.
 *
 * **A share of an incomplete set.** Dropping unattributed spend from the
 * provider split makes the remaining shares sum to 100% over part of the money,
 * which reads as a complete picture of where it went.
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

// --- the daily series ---------------------------------------------------------

describe('the spend trend', () => {
  it('returns every day in the window, including the ones with no spend', () => {
    // The defect this pins. A series built only from the days that have entries
    // draws a line that rises out of two charges a fortnight apart, because the
    // thirteen quiet days between them are not on the axis at all.
    const burn = estateBurn([tenant('t1', 'Meridian', 100_000, [entry({ timestamp: day(1) })])], 7, NOW);

    assert.equal(burn.daily.length, 8, 'the window did not produce one bucket per day');
    assert.equal(burn.daily.filter((d) => d.billedMinor === 0).length, 7, 'the quiet days were dropped from the series');
  });

  it('puts each charge on the day it happened, oldest first', () => {
    const burn = estateBurn(
      [
        tenant('t1', 'Meridian', 100_000, [
          entry({ timestamp: day(3), billedMinor: 300, rawCostMinor: 100 }),
          entry({ timestamp: day(1), billedMinor: 800, rawCostMinor: 200 }),
        ]),
      ],
      7,
      NOW,
    );

    const dated = Object.fromEntries(burn.daily.map((d) => [d.date, d]));
    assert.equal(dated[day(3).slice(0, 10)]!.billedMinor, 300);
    assert.equal(dated[day(1).slice(0, 10)]!.billedMinor, 800);
    // Oldest first: a chart drawn from a reversed series shows a collapse where
    // there was growth, and nothing about it looks wrong.
    assert.ok(burn.daily[0]!.date < burn.daily[burn.daily.length - 1]!.date, 'the series is not in date order');
  });

  it('sums to the estate total', () => {
    // The one property that makes the chart and the headline figure agree. They
    // are computed separately, so nothing else forces it.
    const burn = estateBurn(
      [
        tenant('t1', 'Meridian', 100_000, [entry({ timestamp: day(2) }), entry({ timestamp: day(5) })]),
        tenant('t2', 'Northgate', 50_000, [entry({ timestamp: day(2), billedMinor: 250, rawCostMinor: 50 })]),
      ],
      30,
      NOW,
    );

    assert.equal(
      burn.daily.reduce((sum, d) => sum + d.billedMinor, 0),
      burn.billedMinor,
      'the trend and the headline figure disagree',
    );
    assert.equal(
      burn.daily.reduce((sum, d) => sum + d.rawCostMinor, 0),
      burn.rawCostMinor,
    );
    assert.equal(
      burn.daily.reduce((sum, d) => sum + d.marginMinor, 0),
      burn.marginMinor,
    );
  });

  it('carries margin per day, so a day the platform lost money is visible', () => {
    // Absorbed margin means a charge can be capped below its provider cost. A
    // series that only carried the charged figure would draw that day as the
    // busiest of the month rather than as the worst.
    const burn = estateBurn(
      [tenant('t1', 'Meridian', 100_000, [entry({ timestamp: day(1), billedMinor: 100, rawCostMinor: 400 })])],
      7,
      NOW,
    );

    const bad = burn.daily.find((d) => d.date === day(1).slice(0, 10))!;
    assert.equal(bad.marginMinor, -300, 'a loss-making day was not reported as one');
  });

  it('excludes money coming in from the trend', () => {
    const burn = estateBurn(
      [
        tenant('t1', 'Meridian', 100_000, [
          entry({ type: 'TOP_UP', timestamp: day(1), billedMinor: 500_000, rawCostMinor: 0 }),
          entry({ type: 'HOLD', timestamp: day(1), billedMinor: 4_000, rawCostMinor: 1_000 }),
        ]),
      ],
      7,
      NOW,
    );

    assert.equal(
      burn.daily.reduce((sum, d) => sum + d.billedMinor, 0),
      0,
      'a top-up or a hold was drawn as spend',
    );
  });
});

// --- the provider split -------------------------------------------------------

describe('where the spend went', () => {
  it('splits by the provider that earned it, biggest first', () => {
    const burn = estateBurn(
      [
        tenant('t1', 'Meridian', 100_000, [
          entry({ provider: 'OPENAI', billedMinor: 400, rawCostMinor: 100 }),
          entry({ provider: 'ANTHROPIC', billedMinor: 1_200, rawCostMinor: 300 }),
          entry({ provider: 'ANTHROPIC', billedMinor: 400, rawCostMinor: 100 }),
        ]),
      ],
      30,
      NOW,
    );

    assert.equal(burn.providers[0]!.provider, 'ANTHROPIC');
    assert.equal(burn.providers[0]!.billedMinor, 1_600);
    assert.equal(burn.providers[0]!.executions, 2);
    assert.equal(burn.providers[1]!.provider, 'OPENAI');
  });

  it('names unattributed spend rather than dropping it', () => {
    // Provider attribution was added after the ledger existed, so early entries
    // carry none. Dropping them makes the remaining shares sum to one over an
    // incomplete set — a complete-looking picture of part of the money.
    const burn = estateBurn(
      [
        tenant('t1', 'Meridian', 100_000, [
          entry({ provider: 'OPENAI', billedMinor: 500, rawCostMinor: 100 }),
          entry({ billedMinor: 500, rawCostMinor: 100 }),
        ]),
      ],
      30,
      NOW,
    );

    assert.ok(
      burn.providers.some((p) => p.provider === 'UNATTRIBUTED' && p.billedMinor === 500),
      'spend with no provider on it vanished from the split',
    );
    assert.equal(
      burn.providers.reduce((sum, p) => sum + p.billedMinor, 0),
      burn.billedMinor,
      'the provider split does not account for all the spend',
    );
  });

  it('reports shares that sum to the whole', () => {
    const burn = estateBurn(
      [
        tenant('t1', 'Meridian', 100_000, [
          entry({ provider: 'OPENAI', billedMinor: 250, rawCostMinor: 50 }),
          entry({ provider: 'GEMINI', billedMinor: 750, rawCostMinor: 150 }),
        ]),
      ],
      30,
      NOW,
    );

    assert.equal(burn.providers.find((p) => p.provider === 'GEMINI')!.share, 0.75);
    assert.equal(
      Number(burn.providers.reduce((sum, p) => sum + p.share, 0).toFixed(4)),
      1,
      'the routing shares do not sum to one',
    );
  });

  it('is empty rather than fabricated where nothing was spent', () => {
    const burn = estateBurn([tenant('t1', 'Meridian', 100_000, [])], 30, NOW);

    assert.deepEqual(burn.providers, []);
    assert.equal(burn.acuUnits, 0);
  });
});

// --- the estate position ------------------------------------------------------

function receipt(over: Partial<PaymentReceipt>): PaymentReceipt {
  return {
    id: `r-${Math.random().toString(36).slice(2)}`,
    tenantId: 't1',
    amountMinor: 10_000,
    currency: 'GBP',
    method: 'CARD',
    reference: `ref-${Math.random().toString(36).slice(2)}`,
    recordedBy: 'ops',
    recordedAt: NOW.toISOString(),
    ...over,
  } as PaymentReceipt;
}

const tenancy = (over: Partial<Parameters<typeof estateOverview>[0]['tenancies'][number]> = {}) => ({
  tenantId: 't1',
  createdAt: day(3),
  tier: 'TEAM' as const,
  status: 'ACTIVE' as const,
  seatsUsed: 2,
  seatsIncluded: 20 as number | null,
  identities: [
    { status: 'ACTIVE' as const, administrator: true },
    { status: 'ACTIVE' as const, administrator: false },
  ],
  ...over,
});

describe('revenue is counted, never modelled', () => {
  it('separates today, this month, last month and lifetime', () => {
    const overview = estateOverview(
      {
        tenancies: [tenancy()],
        receipts: [
          receipt({ amountMinor: 5_000, recordedAt: NOW.toISOString() }),
          receipt({ amountMinor: 7_000, recordedAt: '2026-08-02T09:00:00.000Z' }),
          receipt({ amountMinor: 9_000, recordedAt: '2026-07-14T09:00:00.000Z' }),
          receipt({ amountMinor: 3_000, recordedAt: '2025-11-14T09:00:00.000Z' }),
        ],
        awaitingPayment: [],
        operators: 1,
      },
      NOW,
    );

    assert.equal(overview.revenue.todayMinor, 5_000);
    assert.equal(overview.revenue.monthToDateMinor, 12_000, 'month to date did not include today');
    assert.equal(overview.revenue.previousMonthMinor, 9_000);
    assert.equal(overview.revenue.lifetimeMinor, 24_000);
    assert.equal(overview.revenue.receipts, 4);
  });

  it('splits by how the money arrived', () => {
    const overview = estateOverview(
      {
        tenancies: [tenancy()],
        receipts: [
          receipt({ method: 'CARD', amountMinor: 1_000 }),
          receipt({ method: 'MOBILE_MONEY', amountMinor: 4_000 }),
          receipt({ method: 'MOBILE_MONEY', amountMinor: 1_000 }),
        ],
        awaitingPayment: [],
        operators: 1,
      },
      NOW,
    );

    assert.equal(overview.revenue.byMethod[0]!.method, 'MOBILE_MONEY');
    assert.equal(overview.revenue.byMethod[0]!.amountMinor, 5_000);
    assert.equal(overview.revenue.byMethod[0]!.receipts, 2);
  });

  it('counts top-ups raised and not yet settled separately from revenue', () => {
    // Money a customer intends to pay is not money received. Adding it to
    // revenue would report a sale that has not happened.
    const overview = estateOverview(
      {
        tenancies: [tenancy()],
        receipts: [receipt({ amountMinor: 1_000 })],
        awaitingPayment: [{ amountMinor: 50_000 }, { amountMinor: 25_000 }],
        operators: 1,
      },
      NOW,
    );

    assert.equal(overview.revenue.lifetimeMinor, 1_000, 'an unsettled top-up was counted as revenue');
    assert.equal(overview.awaitingPayment.count, 2);
    assert.equal(overview.awaitingPayment.amountMinor, 75_000);
  });
});

describe('the run-rate is labelled arithmetic, not a forecast', () => {
  it('extrapolates month-to-date across the month and shows its working', () => {
    const overview = estateOverview(
      {
        tenancies: [tenancy()],
        receipts: [receipt({ amountMinor: 21_000, recordedAt: '2026-08-05T09:00:00.000Z' })],
        awaitingPayment: [],
        operators: 1,
      },
      NOW, // the 21st of a 31-day month
    );

    assert.equal(overview.revenue.runRateBasis!.elapsedDays, 21);
    assert.equal(overview.revenue.runRateBasis!.daysInMonth, 31);
    assert.equal(overview.revenue.runRateMinor, Math.round((21_000 / 21) * 31));
  });

  it('withholds a projection on the first of the month', () => {
    // Dividing by one elapsed day multiplies whatever happened to land that day
    // across the whole month. Stating no projection is the honest output.
    const overview = estateOverview(
      {
        tenancies: [tenancy()],
        receipts: [receipt({ amountMinor: 90_000, recordedAt: '2026-09-01T09:00:00.000Z' })],
        awaitingPayment: [],
        operators: 1,
      },
      new Date('2026-09-01T12:00:00.000Z'),
    );

    assert.equal(overview.revenue.runRateMinor, null, 'a month was extrapolated from a single day');
    assert.equal(overview.revenue.runRateBasis, null);
  });

  it('withholds a projection where nothing has been received', () => {
    const overview = estateOverview(
      { tenancies: [tenancy()], receipts: [], awaitingPayment: [], operators: 1 },
      NOW,
    );

    assert.equal(overview.revenue.runRateMinor, null);
  });
});

describe('the estate position', () => {
  it('counts tenancies by subscription status', () => {
    const overview = estateOverview(
      {
        tenancies: [
          tenancy({ status: 'ACTIVE' }),
          tenancy({ status: 'SUSPENDED' }),
          tenancy({ status: 'CANCELLED' }),
          tenancy({ status: 'ACTIVE' }),
        ],
        receipts: [],
        awaitingPayment: [],
        operators: 2,
      },
      NOW,
    );

    assert.equal(overview.tenancies.total, 4);
    assert.equal(overview.tenancies.active, 2);
    assert.equal(overview.tenancies.suspended, 1);
    assert.equal(overview.tenancies.cancelled, 1);
  });

  it('counts only the tenancies onboarded inside the window as new', () => {
    const overview = estateOverview(
      {
        tenancies: [tenancy({ createdAt: day(3) }), tenancy({ createdAt: day(400) })],
        receipts: [],
        awaitingPayment: [],
        operators: 1,
      },
      NOW,
    );

    assert.equal(overview.tenancies.newInWindow, 1, 'an old tenancy was reported as new growth');
  });

  it('withholds the seat ceiling where an uncapped tier is on the estate', () => {
    // Summing the capped tiers alone reports a ceiling the estate does not have,
    // and it reads as a low one — the opposite of the truth, since the tenancy
    // that broke the sum is the one with no limit at all.
    const overview = estateOverview(
      {
        tenancies: [tenancy({ seatsUsed: 5, seatsIncluded: 20 }), tenancy({ seatsUsed: 300, seatsIncluded: null })],
        receipts: [],
        awaitingPayment: [],
        operators: 1,
      },
      NOW,
    );

    assert.equal(overview.identities.seatsUsed, 305, 'assigned seats are still countable and were not counted');
    assert.equal(overview.identities.seatsIncluded, null, 'an estate ceiling was reported that does not exist');
  });

  it('counts operators separately from customer identities', () => {
    // An operator is not a customer and does not consume a seat. Folding them in
    // inflates the estate and understates how full the packages are.
    const overview = estateOverview(
      {
        tenancies: [tenancy({ identities: [{ status: 'ACTIVE', administrator: true }, { status: 'SUSPENDED', administrator: false }] })],
        receipts: [],
        awaitingPayment: [],
        operators: 3,
      },
      NOW,
    );

    assert.equal(overview.identities.total, 2);
    assert.equal(overview.identities.active, 1);
    assert.equal(overview.identities.suspended, 1);
    assert.equal(overview.identities.operators, 3);
  });

  it('reports an empty platform as empty rather than as zeroes with a shape', () => {
    const overview = estateOverview({ tenancies: [], receipts: [], awaitingPayment: [], operators: 1 }, NOW);

    assert.equal(overview.tenancies.total, 0);
    assert.deepEqual(overview.tenancies.byTier, []);
    assert.deepEqual(overview.revenue.byMethod, []);
    assert.equal(overview.revenue.runRateMinor, null);
    assert.equal(overview.identities.seatsIncluded, 0);
  });
});
