import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { consolidate, type SchedulePricing } from '../src/engines/maths/masterPricing.ts';
import * as structure from '../src/domain/structure.ts';
import * as tender from '../src/engines/tender.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Master pricing.
 *
 * Tender stage six: both routes converge and the sum that goes out is
 * assembled. The arithmetic is trivial and the value is in what it finds while
 * doing it, because each finding is a way to lose money that nobody notices
 * until the job is running.
 *
 * The one that matters most is scope priced by nobody. It is invisible in a
 * spreadsheet that sums what is there, it goes out at zero, and it gets built
 * at the contractor's cost.
 */

const pkg = (over: Partial<SchedulePricing> & { packageId: string }): SchedulePricing => ({
  scheduleId: `sch-${over.packageId}`,
  packageName: `Package ${over.packageId}`,
  ...over,
});

describe('which figure counts', () => {
  it('carries a market-routed package at what somebody agreed to do it for', () => {
    // Not at the in-house estimate, even though one exists. That estimate was
    // the budget the enquiry was measured against; putting it in the bid would
    // be a price nobody has agreed to.
    const result = consolidate([
      pkg({ packageId: 'A', route: 'SUPPLY_CHAIN', selfPricedMinor: 100_000, awardedMinor: 92_000, awardedSupplier: 'Trench Ltd' }),
    ]);

    assert.equal(result.totalMinor, 92_000);
    assert.equal(result.marketPricedMinor, 92_000);
    assert.equal(result.selfPricedMinor, 0);
    assert.equal(result.lines[0]!.source, 'MARKET');
    assert.equal(result.lines[0]!.supplier, 'Trench Ltd');
  });

  it('carries a self-priced package at the estimate', () => {
    const result = consolidate([pkg({ packageId: 'B', route: 'SELF_PRICE', selfPricedMinor: 240_000 })]);

    assert.equal(result.totalMinor, 240_000);
    assert.equal(result.selfPricedMinor, 240_000);
    assert.equal(result.lines[0]!.source, 'SELF_PRICE');
  });

  it('carries nothing for a package nobody routed, whatever prices exist', () => {
    // A total assembled from prices nobody routed is a total nobody can defend.
    const result = consolidate([pkg({ packageId: 'C', selfPricedMinor: 80_000, awardedMinor: 75_000 })]);

    assert.equal(result.totalMinor, 0);
    assert.equal(result.unpricedPackages, 1);
    assert.equal(result.findings[0]!.kind, 'ROUTE_UNASSIGNED');
    assert.equal(result.findings[0]!.severity, 'CRITICAL');
  });
});

describe('scope priced by nobody', () => {
  it('finds a package sent to the market that nothing came back for', () => {
    const result = consolidate([pkg({ packageId: 'D', route: 'SUPPLY_CHAIN' })]);

    const finding = result.findings.find((f) => f.kind === 'UNPRICED');
    assert.ok(finding);
    assert.equal(finding.severity, 'CRITICAL');
    assert.match(finding.finding, /nothing has been awarded/);
    assert.match(finding.consequence, /goes out at zero/);
  });

  it('finds a package kept in-house that nobody estimated', () => {
    const result = consolidate([pkg({ packageId: 'E', route: 'SELF_PRICE' })]);
    assert.ok(result.findings.some((f) => f.kind === 'UNPRICED'));
  });

  it('leads the summary on it, because it is the expensive one', () => {
    const result = consolidate([
      pkg({ packageId: 'F', route: 'SELF_PRICE', selfPricedMinor: 500_000 }),
      pkg({ packageId: 'G', route: 'SUPPLY_CHAIN' }),
    ]);

    assert.match(result.summary, /carry no price at all/);
    assert.match(result.summary, /excludes them, which is what the bid would do/);
    assert.equal(result.totalMinor, 500_000, 'and the total says so rather than pretending');
  });

  it('sorts what stops a bid above what merely qualifies it', () => {
    const result = consolidate([
      pkg({ packageId: 'H', route: 'SUPPLY_CHAIN', awardedMinor: 60_000, provisionalSumsMinor: 8_000, awardedSupplier: 'X' }),
      pkg({ packageId: 'I', route: 'SUPPLY_CHAIN' }),
    ]);

    assert.equal(result.findings[0]!.severity, 'CRITICAL');
  });
});

describe('what sits inside a price', () => {
  it('separates a provisional sum from a firm price without double counting it', () => {
    const result = consolidate([
      pkg({ packageId: 'J', route: 'SUPPLY_CHAIN', awardedMinor: 300_000, provisionalSumsMinor: 45_000, awardedSupplier: 'Y' }),
    ]);

    assert.equal(result.totalMinor, 300_000, 'the provisional sum is inside the total, not additional to it');
    assert.equal(result.provisionalSumsMinor, 45_000);

    const finding = result.findings.find((f) => f.kind === 'PROVISIONAL_SUM');
    assert.equal(finding?.severity, 'WARNING');
    assert.match(finding?.consequence ?? '', /expended against actual cost/);
  });

  it('lists exclusions as items to confirm rather than claiming to have checked them', () => {
    // Checking whether an exclusion is priced elsewhere means reading two
    // documents. The platform has read neither and says so.
    const result = consolidate([
      pkg({
        packageId: 'K',
        route: 'SUPPLY_CHAIN',
        awardedMinor: 120_000,
        awardedSupplier: 'Z',
        exclusions: ['Dewatering', 'Out of hours working'],
      }),
    ]);

    const finding = result.findings.find((f) => f.kind === 'EXCLUSIONS_CARRIED');
    assert.match(finding?.finding ?? '', /Dewatering; Out of hours working/);
    assert.match(finding?.consequence ?? '', /listed rather than checked/);
  });

  it('says nothing about exclusions on a package that was not bought', () => {
    const result = consolidate([
      pkg({ packageId: 'L', route: 'SELF_PRICE', selfPricedMinor: 90_000, exclusions: ['Something'] }),
    ]);
    assert.ok(!result.findings.some((f) => f.kind === 'EXCLUSIONS_CARRIED'));
  });
});

describe('where both routes have a number', () => {
  it('reports the gap without resolving it', () => {
    const under = consolidate([
      pkg({ packageId: 'M', route: 'SUPPLY_CHAIN', selfPricedMinor: 100_000, awardedMinor: 88_000, awardedSupplier: 'A' }),
    ]).findings.find((f) => f.kind === 'MARKET_VARIANCE');

    assert.equal(under?.amountMinor, 12_000);
    assert.match(under?.finding ?? '', /under the in-house estimate/);
    assert.match(under?.consequence ?? '', /margin or a lower bid/);

    const over = consolidate([
      pkg({ packageId: 'N', route: 'SUPPLY_CHAIN', selfPricedMinor: 100_000, awardedMinor: 118_000, awardedSupplier: 'B' }),
    ]).findings.find((f) => f.kind === 'MARKET_VARIANCE');

    assert.equal(over?.amountMinor, 18_000);
    assert.match(over?.finding ?? '', /over the in-house estimate/);
  });

  it('is informational, because which figure to carry is a commercial decision', () => {
    const result = consolidate([
      pkg({ packageId: 'O', route: 'SUPPLY_CHAIN', selfPricedMinor: 100_000, awardedMinor: 88_000, awardedSupplier: 'A' }),
    ]);
    assert.equal(result.findings.find((f) => f.kind === 'MARKET_VARIANCE')?.severity, 'INFO');
  });

  it('says nothing where only one route has a number', () => {
    const result = consolidate([pkg({ packageId: 'P', route: 'SELF_PRICE', selfPricedMinor: 100_000 })]);
    assert.ok(!result.findings.some((f) => f.kind === 'MARKET_VARIANCE'));
  });
});

describe('through the platform', () => {
  let platform: Platform;
  let seed: SeedResult;

  before(async () => {
    platform = new Platform();
    seed = await seedDemoProject(platform);

    // Tender writes are gated to the tender phase, correctly — consolidating a
    // price for a job that finished two years ago is not a thing. Regressed
    // through the governed transition rather than around the gate.
    structure.transitionPhase(platform.context(seed.users.admin!.auth, seed.projectId), {
      to: 'TENDER',
      justification: 'Reopened to consolidate the master pricing before the tender is re-issued',
    });
  });

  const ctx = () => platform.context(seed.users.qs!.auth, seed.projectId);

  it('consolidates the seeded project and writes the result to the thread', () => {
    const { masterPricingId, pricing } = tender.consolidateMasterPricing(ctx(), {
      note: 'Stage 6 consolidation before the tender goes out',
    });

    assert.ok(pricing.packages > 0);
    const record = platform.ledger.require({ refType: 'MasterPricing', refId: masterPricingId });
    assert.equal(record.state.projectId, seed.projectId);
    assert.equal(record.state.consolidatedBy, seed.users.qs!.auth.actorId);
    assert.match(String(record.state.note), /Stage 6/);
  });

  it('counts a package with no pricing schedule at all, which reading schedules alone would miss', () => {
    // The seeded package is routed. A second one, added and never routed, is
    // the case that matters: a consolidation reading only schedules would
    // produce a tender sum with no trace of it at all.
    const before = tender.consolidateMasterPricing(ctx()).pricing;
    const { packageId } = structure.createScopePackage(platform.context(seed.users.pm!.auth, seed.projectId), {
      name: 'Landscaping and reinstatement',
      discipline: 'CIVILS',
      scopeOfWorks: 'Reinstatement of the compound and soft landscaping to the boundary',
      inclusions: ['Topsoil and seeding'],
      exclusions: ['Highway works'],
      acceptanceCriteria: ['Establishment period of 12 months'],
      estimatedValueMinor: 84_000_000,
      designResponsibility: 'CONTRACTOR',
    });

    const after = tender.consolidateMasterPricing(ctx()).pricing;

    assert.equal(after.packages, before.packages + 1, 'every package appears, scheduled or not');
    const line = after.lines.find((l) => l.packageId === packageId);
    assert.ok(line, 'the unscheduled package is in the list rather than absent');
    assert.equal(line.route, undefined);
    assert.equal(line.amountMinor, 0);
    assert.ok(after.findings.some((f) => f.kind === 'ROUTE_UNASSIGNED' && f.packageId === packageId));
  });

  it('gives the same answer twice, because a tender sum has to be reproducible', () => {
    const first = tender.consolidateMasterPricing(ctx()).pricing;
    const second = tender.consolidateMasterPricing(ctx()).pricing;

    assert.equal(first.totalMinor, second.totalMinor);
    assert.deepEqual(
      first.findings.map((f) => `${f.kind}:${f.packageId}`),
      second.findings.map((f) => `${f.kind}:${f.packageId}`),
    );
  });

  it('refuses consolidation to a role with no commercial authority', () => {
    assert.throws(
      () => tender.consolidateMasterPricing(platform.context(seed.users.safety!.auth, seed.projectId)),
      /holds|ACCESS_DENIED/,
    );
  });
});
