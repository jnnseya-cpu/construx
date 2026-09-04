import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { setAppointment } from '../src/domain/etablix/appointment.ts';
import { recordFact } from '../src/domain/etablix/brief.ts';
import { acceptInterface, assignInterface, composeSystem } from '../src/domain/etablix/composer.ts';
import { checkDelivery, scheduleDelivery } from '../src/domain/etablix/desk.ts';
import { libraryPosition, promoteKnowledge } from '../src/domain/etablix/library.ts';
import {
  createPackage,
  engageSupplier,
  lockReturn,
  openPackageTender,
  recordBid,
  scheduleFor,
  statePackageField,
  suspendEngagement,
  type ServiceBidLine,
  type ServicePackage,
} from '../src/domain/etablix/procurement.ts';
import { workflowPosition } from '../src/domain/etablix/workflow.ts';
import * as structure from '../src/domain/structure.ts';
import { registerSupplier } from '../src/domain/supplychain.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * §6 stage 8 — the knowledge library.
 *
 * Three properties. A supplier's performance is written back from the
 * engagement that produced it and from what the gate found. A price leaves a
 * project only as the median of a fully locked field, with no bidder on it.
 * And nothing that names the customer leaves at all — the check is proved by
 * searching the promoted records for the names, not by trusting the code that
 * was meant to strip them.
 */

let platform: Platform;
let seed: SeedResult;

type Registered = { id: string; legalName: string };

const WINDOW = { fromDate: '2026-11-01', toDate: '2027-09-01', leadDays: 30 };
const CONTRACTING_ENTITY = 'Meridian Infrastructure Group Ltd';
const FUNDING = 'Client capital programme';

function at(who: string, projectId: string): EngineContext {
  return platform.context(seed.users[who]!.auth, projectId);
}

function register(legalName: string, trades: string[]): Registered {
  const { supplierId } = registerSupplier(at('qs', seed.projectId), {
    partyId: `SUP-${legalName.toUpperCase().replaceAll(' ', '-')}-${Math.random().toString(36).slice(2, 7)}`,
    legalName,
    trades,
    contactName: 'Commercial Manager',
    contactEmail: `enquiries@${legalName.split(' ')[0]!.toLowerCase()}.example`,
    countryCode: 'GB',
  });
  return { id: supplierId, legalName };
}

function realProject(name: string): string {
  const governance = platform.context(seed.users.admin!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
  const portfolios = platform.ledger.listByTenant(seed.tenantId, 'Portfolio');
  return structure.createProject(governance, {
    portfolioId: String(portfolios[0]!.state.id),
    name,
    sectorType: 'TRANSPORT',
    assetType: 'Compound',
    location: { continentCode: 'EU', countryCode: 'GB', city: 'Derby' },
    contractValueMinor: 5_000_000_00,
    currency: 'GBP',
    plannedStart: '2026-11-01',
    plannedCompletion: '2027-09-01',
  }).projectId;
}

function appoint(projectId: string): void {
  setAppointment(at('pm', projectId), {
    model: 'PRINCIPAL_SERVICE_CONTRACTOR',
    contractingEntity: CONTRACTING_ENTITY,
    fundingSource: FUNDING,
    basis: 'Single-point accountability across all seven families',
  });
  for (const [itemId, value] of [
    ['peakWorkforce', 164],
    ['shiftOverlapPersons', 120],
    ['visitorsPerDay', 22],
    ['accommodatedWorkers', 120],
    ['cleanableAreaSqm', 1800],
  ] as [string, number][]) {
    recordFact(at('pm', projectId), { itemId, value, source: 'Programme rev D' });
  }
}

function composeWelfare(projectId: string): string {
  const { system, interfaces } = composeSystem(at('pm', projectId), { family: 'WELFARE_ACCOMMODATION', zone: 'Main compound', ...WINDOW });
  for (const entry of interfaces) {
    assignInterface(at('pm', projectId), { interfaceId: entry.id, owner: 'Ruth Adeyemi', dueDate: '2026-10-15' });
    acceptInterface(at('pm', projectId), { interfaceId: entry.id, note: `${entry.name} agreed` });
  }
  return system.id;
}

function tenderedPackage(projectId: string, systemId: string, drawings: string): ServicePackage {
  const created = createPackage(at('pm', projectId), { title: 'Welfare and accommodation', systemIds: [systemId] });
  const values: Record<string, string> = {
    scope: 'In: supply, delivery, install, service and removal of all welfare units. Out: the compound platform and its drainage.',
    drawings,
    kpis: 'Availability 99% of shift hours; cleaning to schedule A; hot water to every shower at shift change',
    evidence: 'Weekly service sheets, water temperature log, waste transfer notes, PAT records',
    acceptance: 'All units set, connected, tested and handed over with the O&M file and the training record',
    pricingMethod: 'Schedule of rates, remeasurable on the workforce curve',
    changeMechanism: 'Instructed change valued at the schedule rates; anything outside them agreed before instruction',
  };
  let current = created;
  for (const [field, value] of Object.entries(values)) {
    current = statePackageField(at('pm', projectId), { packageId: created.id, field, value });
  }
  openPackageTender(at('pm', projectId), { packageId: created.id, returnDeadline: '2026-10-01' });
  return current;
}

function line(itemId: string, quantity: number, rateMinor: number): ServiceBidLine {
  return { scheduleItemId: itemId, description: itemId, quantity, unit: 'unit', rateMinor };
}

const CLEAN_BASIS = {
  currency: 'GBP',
  taxBasis: 'EXCLUSIVE' as const,
  hirePeriodWeeks: 44,
  workingHours: '0700–1900, six days',
  transport: 'Delivered to site',
  mobilisationIncluded: true,
  demobilisationIncluded: true,
  consumablesIncluded: true,
  standbyIncluded: true,
  supervisionIncluded: true,
  reinstatementIncluded: true,
};

/** Every registered firm prices every item at its own rate, and every return is locked. */
function lockedField(projectId: string, packageId: string, rates: [Registered, number][]): void {
  const record = platform.ledger.list(projectId, 'ServicePackage').map((entry) => entry.state as unknown as ServicePackage).find((entry) => entry.id === packageId)!;
  const schedule = scheduleFor(at('pm', projectId), record);
  for (const [firm, rate] of rates) {
    const bid = recordBid(at('pm', projectId), {
      packageId,
      supplierId: firm.id,
      supplierName: firm.legalName,
      basis: CLEAN_BASIS,
      lines: schedule.map((entry) => line(entry.itemId, entry.quantity, rate)),
    });
    lockReturn(at('pm', projectId), { bidId: bid.id, acknowledgedBy: `Commercial manager, ${firm.legalName}` });
  }
}

let halcyon: Registered;
let ardley: Registered;
let brightpath: Registered;
let first = '';
let firstPackage: ServicePackage;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  platform.setModuleGrant({
    moduleId: 'ETABLIX',
    tenantId: seed.users.pm!.auth.tenantId,
    status: 'ACTIVE',
    reason: 'Appointed as ETABLIX site-services delivery partner',
    decidedBy: seed.users.operator!.id,
  });
  halcyon = register('Halcyon Welfare Systems Ltd', ['WELFARE', 'MODULAR']);
  ardley = register('Ardley Modular Ltd', ['MODULAR', 'WELFARE', 'PLUMBING']);
  brightpath = register('Brightpath Site Services Ltd', ['WELFARE', 'CLEANING', 'MODULAR']);

  first = realProject('Derby compound');
  appoint(first);
  const welfare = composeWelfare(first);
  // One stated field names the contracting entity. The template must not.
  firstPackage = tenderedPackage(first, welfare, `WEL-100 rev C compound layout, issued by ${CONTRACTING_ENTITY}`);
  lockedField(first, firstPackage.id, [
    [halcyon, 1_000_00],
    [ardley, 1_200_00],
    [brightpath, 1_600_00],
  ]);
  // Halcyon is engaged and then suspended; Ardley is engaged and left at Prospect.
  const engaged = engageSupplier(at('pm', first), { packageId: firstPackage.id, supplierId: halcyon.id, supplierName: halcyon.legalName });
  suspendEngagement(at('pm', first), { engagementId: engaged.id, reason: 'Insurance certificate lapsed on 1 October and no renewal has been produced' });
  engageSupplier(at('pm', first), { packageId: firstPackage.id, supplierId: ardley.id, supplierName: ardley.legalName });
  // What the gate found when Halcyon's lorries arrived.
  const cabins = scheduleDelivery(at('pm', first), { systemId: welfare, supplier: 'Halcyon Welfare Systems Ltd', description: 'Welfare cabins', expectedOn: '2026-10-20', quantityExpected: 4 });
  checkDelivery(at('pm', first), { deliveryId: cabins.id, quantityReceived: 3, discrepancy: 'Fourth cabin damaged in transit, returned' });
  const fuel = scheduleDelivery(at('pm', first), { supplier: 'halcyon welfare systems ltd', description: 'Generator', expectedOn: '2026-10-21', quantityExpected: 1 });
  checkDelivery(at('pm', first), { deliveryId: fuel.id, quantityReceived: 0, refused: true });
});

describe('what a project promotes', () => {
  it('refuses a project with nothing to promote, and says why', () => {
    const empty = realProject('Nothing learned yet');
    appoint(empty);
    throwsCode(() => promoteKnowledge(at('pm', empty)), 'NOTHING_TO_PROMOTE');
  });

  it('writes a supplier score back from the engagement and from the gate, and scores nobody who never got to contract', () => {
    const result = promoteKnowledge(at('pm', first), { note: 'First promotion from the Derby compound' });
    const score = result.suppliers.find((entry) => entry.supplierId === halcyon.id)!;
    assert.ok(score, 'Halcyon was scored');
    assert.equal(score.suspensions, 1);
    assert.equal(score.contracted, 0);
    assert.deepEqual(score.deliveries, { checked: 2, short: 1, refused: 1 }, 'the gate’s record found the firm under either spelling');
    assert.equal(score.score, 100 - 25 - 10 - 5);
    assert.match(score.basis, /25 per suspension \(1\)/);
    assert.ok(!result.suppliers.some((entry) => entry.supplierId === ardley.id), 'a firm left at Prospect has no performance to score');
    assert.ok(result.promotion.withheld.some((entry) => entry.what.startsWith(ardley.legalName) && /never reached Contracted/.test(entry.why)));
    assert.equal(result.promotion.note, 'First promotion from the Derby compound');
  });

  it('promotes the median compliant rate per item, with no bidder on it', () => {
    const library = libraryPosition(at('pm', first));
    assert.ok(library.benchmarks && library.benchmarks.length > 0, 'benchmarks were promoted');
    for (const benchmark of library.benchmarks!) {
      assert.equal(benchmark.family, 'WELFARE_ACCOMMODATION');
      assert.deepEqual(benchmark.rates, [1_200_00], 'the median of 1000, 1200 and 1600');
      assert.equal(benchmark.returns, 3);
      assert.equal(benchmark.packages, 1);
    }
    const text = JSON.stringify(library.benchmarks);
    for (const name of [halcyon.legalName, ardley.legalName, brightpath.legalName, first, 'Derby compound']) {
      assert.ok(!text.includes(name), `a benchmark carried "${name}"`);
    }
  });

  it('promotes the package template with the field that named the customer withheld, and says so', () => {
    const library = libraryPosition(at('pm', first));
    assert.equal(library.templates.length, 1);
    const template = library.templates[0]!;
    assert.deepEqual(template.families, ['WELFARE_ACCOMMODATION']);
    assert.deepEqual(template.withheldFields, ['drawings']);
    assert.equal(template.stated.drawings, undefined);
    assert.match(template.stated.scope!, /welfare units/);
    assert.deepEqual(library.promotions[0]!.templates[0]!.withheldFields, ['drawings']);
    assert.deepEqual(library.promotions[0]!.checkedAgainst, ['Derby compound', CONTRACTING_ENTITY, FUNDING]);
  });

  it('carries nothing of the customer or the project into the library, by search rather than by trust', () => {
    const governance = `${seed.tenantId}-governance`;
    const records = ['LibrarySupplierScore', 'LibraryBenchmark', 'LibraryPackageTemplate'].flatMap((refType) =>
      platform.ledger.list(governance, refType).map((record) => JSON.stringify(record.state)),
    );
    assert.ok(records.length >= 3);
    for (const text of records) {
      for (const name of [first, 'Derby compound', CONTRACTING_ENTITY, FUNDING]) {
        assert.ok(!text.includes(name), `a library record carried "${name}": ${text.slice(0, 120)}`);
      }
    }
  });

  it('promotes nothing twice', () => {
    throwsCode(() => promoteKnowledge(at('pm', first)), 'NOTHING_TO_PROMOTE');
    assert.equal(libraryPosition(at('pm', first)).suppliers.find((entry) => entry.supplierId === halcyon.id)!.engagements, 1);
  });

  it('satisfies the Learn gate that was the one gate with no record behind it', () => {
    const learn = workflowPosition(at('pm', first), '2026-10-20').stages.find((stage) => stage.id === 'LEARN')!;
    const gate = learn.exit.find((entry) => entry.id === 'knowledgePromoted')!;
    assert.equal(gate.outcome, 'SATISFIED');
    assert.match(gate.detail, /1 supplier score, \d+ price benchmarks, 1 package template/);
  });
});

describe('the next project opens with the library', () => {
  let second = '';

  it('reads its own field against the benchmark, and adds a second sample when it promotes', () => {
    second = realProject('Leeds depot');
    appoint(second);
    const welfare = composeWelfare(second);
    const pkg = tenderedPackage(second, welfare, 'WEL-200 rev A depot layout');
    lockedField(second, pkg.id, [
      [halcyon, 1_500_00],
      [ardley, 1_800_00],
    ]);

    const before = libraryPosition(at('pm', second));
    const applied = before.applied.packages.find((entry) => entry.packageId === pkg.id)!;
    assert.ok(applied, 'the tendered package is read against the library');
    for (const item of applied.items) {
      assert.equal(item.libraryMedianMinor, 1_200_00);
      assert.equal(item.fieldMedianMinor, 1_650_00, 'the median of 1500 and 1800');
      assert.equal(item.variancePercent, 38);
      assert.equal(item.samples, 1);
    }

    const result = promoteKnowledge(at('pm', second));
    assert.equal(result.suppliers.length, 0, 'nothing reached contract here');
    assert.equal(result.templates.length, 1);
    assert.equal(result.templates[0]!.uses, 2, 'the same family set reuses the template');
    assert.equal(result.templates[0]!.stated.drawings, 'WEL-200 rev A depot layout', 'a field withheld last time is filled by a clean one');
    const after = libraryPosition(at('pm', second));
    for (const benchmark of after.benchmarks!) {
      assert.deepEqual(benchmark.rates, [1_200_00, 1_650_00]);
      assert.equal(benchmark.packages, 2);
      assert.equal(benchmark.medianMinor, 1_425_00);
    }
  });

  it('withholds the benchmarks from a reader without commercial standing, and refuses them the promotion', () => {
    const site = libraryPosition(at('siteManager', second));
    assert.equal(site.benchmarks, undefined);
    assert.match(site.benchmarksWithheld!, /Withheld/);
    assert.ok(site.suppliers.length > 0, 'a supplier score is operating knowledge and is not withheld');
    assert.throws(() => promoteKnowledge(at('siteManager', second)));
  });

  it('survives a restart with the library intact', () => {
    const restored = new Platform();
    restored.ledger.restore(platform.ledger.events());
    restored.rehydrate();
    const before = libraryPosition(at('pm', second));
    const after = libraryPosition(restored.context(seed.users.pm!.auth, second));
    assert.equal(after.statement, before.statement);
    assert.deepEqual(after.benchmarks!.map((entry) => entry.rates), before.benchmarks!.map((entry) => entry.rates));
  });
});
