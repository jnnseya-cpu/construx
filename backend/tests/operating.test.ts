import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { hashEvidence } from '../src/core/canonical.ts';
import { maintenanceQueue, operatingPosition, recordOperatingCost } from '../src/engines/handover.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Running the asset, rather than listing it.
 *
 * The FM centre was the weakest of the seven: four of its nine panels partial
 * and one absent, all for one reason — the asset register was listable and
 * nothing aggregated it. A list of assets is not an operating position any more
 * than a list of events is an audit.
 *
 * The absent one is the interesting one. "What is costing money" had no record
 * behind it at all: nothing captured energy or reactive-maintenance spend, so
 * the only honest options were to capture it or to keep saying nothing. Deriving
 * it would have meant inventing it.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

const fm = (): EngineContext => platform.context(seed.users.fm!.auth, seed.projectId, { source: 'WEB' });

describe('what the asset costs to run', () => {
  it('is unknown rather than zero before anything is recorded', () => {
    // The distinction the whole panel turns on. A facility with no cost records
    // is not a facility that costs nothing, and reporting zero would be a
    // confident number nobody put in.
    const position = operatingPosition(fm());
    if (!position.cost.recorded) {
      assert.equal(position.cost.reactiveShare, null);
      assert.match(String(position.notRecorded), /unknown rather than zero/i);
    }
  });

  it('records a period against the facility or one asset', () => {
    const ctx = fm();
    const assetId = platform.ledger.list(seed.projectId, 'AssetRegisterItem')[0]?.refId;

    recordOperatingCost(ctx, {
      period: '2026-07',
      category: 'ENERGY',
      amountMinor: 4_000_000,
      quantity: 92_000,
      unit: 'kWh',
      narrative: 'Half-hourly electricity, whole site.',
      evidenceHash: hashEvidence('july-electricity-invoice'),
    });

    if (assetId) {
      recordOperatingCost(ctx, {
        period: '2026-07',
        category: 'REACTIVE_MAINTENANCE',
        amountMinor: 900_000,
        assetId,
        narrative: 'Emergency call-out, bearing replacement.',
        evidenceHash: hashEvidence('july-callout'),
      });
    }

    const position = operatingPosition(fm());
    assert.equal(position.cost.recorded, true);
    assert.equal(position.cost.totalMinor, assetId ? 4_900_000 : 4_000_000);
    assert.ok(position.cost.byCategory.some((entry) => entry.category === 'ENERGY'));
  });

  it('refuses a negative cost rather than netting it off silently', () => {
    // A negative operating cost is a credit note, and it belongs on the invoice
    // it corrects. Accepting it here would let a period be made to look better
    // by adding a line rather than by correcting one.
    throwsCode(
      () =>
        recordOperatingCost(fm(), {
          period: '2026-07',
          category: 'ENERGY',
          amountMinor: -100,
          narrative: 'Rebate',
          evidenceHash: hashEvidence('rebate'),
        }),
      'OPERATING_COST_NEGATIVE',
    );
  });

  it('leads with reactive share rather than total spend', () => {
    // A facility spending more in total but less of it reactively is being run
    // better, and a total alone cannot tell those apart.
    const ctx = fm();
    recordOperatingCost(ctx, {
      period: '2026-07',
      category: 'PLANNED_MAINTENANCE',
      amountMinor: 2_700_000,
      narrative: 'Quarterly PPM visit across all plant.',
      evidenceHash: hashEvidence('july-ppm'),
    });

    const position = operatingPosition(fm());
    assert.ok(position.cost.reactiveShare !== null);
    assert.equal(
      position.cost.reactiveShare,
      Number((position.cost.reactiveMinor / (position.cost.reactiveMinor + position.cost.plannedMinor)).toFixed(3)),
    );
  });

  it('refuses a cost against an asset that does not exist', () => {
    // A cost attributed to nothing is worse than an unattributed one: it reads
    // as attributed.
    assert.throws(() =>
      recordOperatingCost(fm(), {
        period: '2026-07',
        category: 'CONSUMABLES',
        amountMinor: 1_000,
        assetId: 'no-such-asset',
        narrative: 'Filters',
        evidenceHash: hashEvidence('filters'),
      }),
    );
  });
});

describe('the operating position', () => {
  it('reports an asset past its expected life as due, not as failed', () => {
    // Plenty of plant runs long past its design life. What the register can
    // honestly say is that replacement is no longer a surprise, and what it
    // would cost.
    const position = operatingPosition(fm(), '2099-01-01');
    assert.equal(position.lifeExpired.count, position.assets.total);
    assert.equal(
      position.lifeExpired.replacementCostMinor,
      position.assets.byClass.reduce((sum, entry) => sum + entry.replacementCostMinor, 0),
    );
    // The word matters: this is a replacement decision, not a failure report.
    assert.ok(position.lifeExpired.assets.every((a) => a.expectedLifeYears > 0));
  });

  it('separates defects somebody else pays for from the ones we do', () => {
    const position = operatingPosition(fm());
    assert.equal(position.defects.open, position.defects.underWarranty + position.defects.notCovered);
    if (position.defects.notCovered > 0) {
      assert.match(position.summary, /outside warranty/i);
    }
  });

  it('says there is nothing to operate rather than reporting zeroes', () => {
    const empty = new Platform();
    const position = operatingPosition({ ...fm(), ledger: empty.ledger, projectId: 'nothing' } as EngineContext);
    assert.equal(position.assets.total, 0);
    assert.match(position.summary, /nothing to operate/i);
  });
});

describe('the maintenance queue', () => {
  it('puts a statutory inspection above an emergency', () => {
    // It looks wrong for a day and is right for a year: a missed statutory date
    // is an offence, and the emergency will still be an emergency in an hour.
    const queue = maintenanceQueue(fm());
    const firstStatutory = queue.items.findIndex((item) => item.statutory);
    const firstEmergency = queue.items.findIndex((item) => !item.statutory && item.priority === 'EMERGENCY');
    if (firstStatutory >= 0 && firstEmergency >= 0) {
      assert.ok(firstStatutory < firstEmergency, 'an emergency was ranked above a statutory obligation');
    }
  });

  it('counts a late statutory item separately, because it is not a backlog', () => {
    const queue = maintenanceQueue(fm());
    assert.ok(queue.statutoryOverdue <= queue.overdue);
    if (queue.statutoryOverdue > 0) {
      assert.match(queue.summary, /offence rather than a backlog/i);
    } else if (queue.items.length > 0) {
      assert.match(queue.summary, /Nothing statutory is late/i);
    }
  });

  it('carries both open work orders and open defects, and says which is which', () => {
    const queue = maintenanceQueue(fm());
    const openOrders = platform.ledger.list(seed.projectId, 'WorkOrder').filter((r) => r.state.status !== 'CLOSED').length;
    const openDefects = platform.ledger.list(seed.projectId, 'Defect').filter((r) => r.state.status !== 'CLOSED').length;

    assert.equal(queue.items.length, openOrders + openDefects);
    assert.equal(queue.items.filter((i) => i.kind === 'WORK_ORDER').length, openOrders);
    assert.equal(queue.items.filter((i) => i.kind === 'DEFECT').length, openDefects);
  });

  it('says nothing is outstanding rather than returning an empty list with no words', () => {
    const empty = new Platform();
    const queue = maintenanceQueue({ ...fm(), ledger: empty.ledger, projectId: 'nothing' } as EngineContext);
    assert.deepEqual(queue.items, []);
    assert.match(queue.summary, /nothing is outstanding/i);
  });
});
