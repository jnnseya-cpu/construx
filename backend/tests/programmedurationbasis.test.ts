import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as measurement from '../src/domain/measurement.ts';
import * as structure from '../src/domain/structure.ts';
import { programmeDurationBasis, proposeProgrammeDuration } from '../src/domain/costintel.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The duration estimate now reads its two figures off the priced bill — the
 * "auto-fill" the person asked for, so the estimate is a press rather than a
 * form. These pin that the basis is the direct cost summed across priced
 * schedules and the count of distinct priced work sections, that the estimate
 * derives from it when the figures are omitted, that a figure the caller does
 * pass still wins, and that an unpriced project is told to price the bill first
 * rather than handed a fortnight from a zero.
 */

let platform: Platform;
let seed: SeedResult;

const asQS = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  // BOQ_TAKEOFF and ESTIMATE_TENDER are gated to the tender phases.
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'TENDER',
    justification: 'Reopened to price a bill and read the duration off it',
  });
});

describe('programme duration · read off the priced bill', () => {
  it('has no basis, and refuses to estimate, while nothing is priced', () => {
    // The demo seed records measured items but prices none of them.
    assert.equal(programmeDurationBasis(asQS()), null);
    throwsCode(() => proposeProgrammeDuration(asQS(), {}), 'MEASURED_WORKS_NOT_PRICED');
  });

  it('reads the direct cost and the distinct work sections once the bill is priced', () => {
    const scheduleId = measurement.openSchedule(asQS(), {
      packageReference: 'DUR-TEST',
      title: 'Duration basis — measured works',
    }).scheduleId;
    // Two items in two distinct section codes (A and B), so the bill spans two
    // trade phases that cannot run at once.
    measurement.recordItems(asQS(), scheduleId, [
      { reference: 'A.10.1', description: 'Excavate to reduce levels', unit: 'm3', quantity: 100, basis: 'MEASURED', source: { drawing: 'D-1', revision: 'A' } },
      { reference: 'B.10.1', description: 'In situ concrete to slab', unit: 'm3', quantity: 50, basis: 'MEASURED', source: { drawing: 'D-2', revision: 'A' } },
    ]);
    measurement.priceItem(asQS(), scheduleId, {
      reference: 'A.10.1',
      components: [{ kind: 'LABOUR', description: 'Groundworker', unitCostMinor: 30_00, constant: 0.5 }],
    });
    measurement.priceItem(asQS(), scheduleId, {
      reference: 'B.10.1',
      components: [{ kind: 'MATERIAL', description: 'C32/40', unitCostMinor: 120_00, constant: 1 }],
    });

    const totals = measurement.scheduleTotals(asQS(), scheduleId);
    const basis = programmeDurationBasis(asQS());
    assert.ok(basis, 'a priced bill has a basis');
    assert.equal(basis!.netMeasuredMinor, totals.directCostMinor, 'the net measured works is the schedule direct cost');
    assert.equal(basis!.tradeGroups, 2, 'two distinct priced work sections');
    assert.equal(basis!.fromSchedules, 1);
    assert.ok(basis!.netMeasuredMinor > 0);
  });

  it('derives the estimate from the basis when the figures are omitted', () => {
    const basis = programmeDurationBasis(asQS())!;
    const derived = proposeProgrammeDuration(asQS(), {});
    const explicit = proposeProgrammeDuration(asQS(), {
      netMeasuredMinor: basis.netMeasuredMinor,
      tradeGroups: basis.tradeGroups,
    });
    assert.equal(derived.weeks, explicit.weeks, 'omitting the figures estimates the same as passing the bill figures');
    assert.equal(derived.confidence, 'LOW');
  });

  it('lets a figure the caller passes win over the bill', () => {
    const derived = proposeProgrammeDuration(asQS(), {});
    // A much larger works value must not read as the small priced bill.
    const overridden = proposeProgrammeDuration(asQS(), { netMeasuredMinor: 500_000_000, tradeGroups: 2 });
    assert.notEqual(overridden.weeks, derived.weeks, 'the passed figure is used, not the bill');
    assert.ok(overridden.weeks > derived.weeks);
  });
});
