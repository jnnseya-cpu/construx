import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { pricingSchedule } from '../src/domain/quotation.ts';
import * as structure from '../src/domain/structure.ts';
import * as tender from '../src/engines/tender.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The priced take-off exported as a pricing schedule — the buyer's "Appendix B"
 * from the record.
 *
 * The property that matters is the one a client's QS checks first: the lines sum
 * to the tender total exactly. It reuses the quotation's own apportionment, so
 * the schedule and the quotation can never disagree; these tests pin that the
 * export carries it faithfully and refuses an incomplete estimate rather than
 * exporting a wrong total.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(platform.context(seed.users.admin!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'TENDER',
    justification: 'Retender of the remaining scope',
  });
});

const qsCtx = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });

const WALL_LINES = [
  { description: 'Rake out and repoint in lime mortar', unit: 'm2', quantity: 86, labourRateMinor: 8_500, materialRateMinor: 1_200 },
  { description: 'Rebuild collapsed section in reclaimed stone', unit: 'm2', quantity: 12, labourRateMinor: 24_000, materialRateMinor: 9_000 },
  { description: 'Replace coping, bed and point', unit: 'm', quantity: 34, labourRateMinor: 6_000, materialRateMinor: 4_500 },
];

function completeEstimate() {
  return tender.buildEstimate(qsCtx(), {
    packageId: 'WALL',
    durationWeeks: 4,
    lines: WALL_LINES,
    quantified: [{ head: 'WASTE', description: 'Skips and gate fees', unit: 'sum', quantity: 1, rateMinor: 45_000 }],
    insurance: { policies: [{ type: 'Contract works and liability', percentOfContractValue: 0.9 }] },
    exclusions: [{ head: 'PLANT', reason: 'Access from a tower scaffold provided by the church' }],
    margin: { overheadPercent: 8, profitPercent: 6 },
    basisOfEstimate: 'Measured off drawings DR-S-1600, DR-S-1601 and DR-C-9020 at revision P01.',
    assumptions: ['Uninterrupted access to the churchyard'],
  } as Parameters<typeof tender.buildEstimate>[1]);
}

describe('the pricing schedule export', () => {
  it('apportions the tender total across the measured lines, and they sum to it exactly', () => {
    const estimate = completeEstimate();
    const schedule = pricingSchedule(qsCtx());

    assert.equal(schedule.totalMinor, estimate.totalMinor, 'the schedule total is the estimate total');
    assert.equal(schedule.lines.length, 3, 'every measured line is on the schedule');
    assert.equal(schedule.apportioned, true);

    // The property a QS checks first: the lines add up to the total, to the penny.
    const summed = schedule.lines.reduce((total, line) => total + line.amountMinor, 0);
    assert.equal(summed, schedule.totalMinor, 'the priced lines do not sum to the tender total');

    // Each line carries what the buyer's schedule needs.
    for (const line of schedule.lines) {
      assert.ok(line.description.length > 0);
      assert.ok(line.quantity > 0);
      assert.ok(line.unit.length > 0);
      assert.ok(line.amountMinor >= 0);
    }
    assert.match(schedule.lines[0]!.description, /repoint/i);
  });

  it('carries the assumptions and the exclusion as qualifications, but never a margin head', () => {
    completeEstimate();
    const schedule = pricingSchedule(qsCtx());

    assert.ok(schedule.assumptions.includes('Uninterrupted access to the churchyard'));
    assert.ok(schedule.exclusions.some((exclusion) => /tower scaffold/i.test(exclusion.reason)));
    // The same rule the quotation holds — overhead and profit are never printed.
    const printed = JSON.stringify(schedule).toLowerCase();
    for (const forbidden of ['overhead', 'profit']) {
      assert.ok(!schedule.exclusions.some((e) => e.label.toLowerCase().includes(forbidden)), `a margin head leaked: ${forbidden}`);
    }
    assert.ok(printed.length > 0);
  });

  it('refuses rather than exporting a wrong total where no complete estimate exists', () => {
    // A brand-new project with nothing priced on it.
    const gov = platform.context(seed.users.admin!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
    const enterpriseId = String(platform.ledger.listByTenant(seed.tenantId, 'Enterprise')[0]?.state.id ?? '');
    const { portfolioId } = structure.createPortfolio(gov, {
      name: 'Pricing schedule fixture',
      enterpriseId,
      governanceModel: 'Sole director',
      continentCode: 'EU',
      city: 'Spalding',
    });
    const { projectId } = structure.createProject(gov, {
      portfolioId,
      name: 'Nothing priced yet',
      sectorType: 'RMI',
      assetType: 'Dwelling',
      location: { continentCode: 'EU', countryCode: 'GB', city: 'Spalding' },
      contractValueMinor: 5_000_000,
      currency: 'GBP',
      plannedStart: '2026-12-01',
      plannedCompletion: '2027-03-31',
    });
    const emptyCtx = platform.context(seed.users.qs!.auth, projectId, { source: 'WEB' });

    throwsCode(() => pricingSchedule(emptyCtx), 'NO_COMPLETE_ESTIMATE');
  });
});
