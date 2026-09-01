import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import {
  CONTROL_STATES,
  CONTROL_STATE_IDS,
  COMPETITION_FLOOR,
  FAMILY_TRADES,
  PACKAGE_REQUIREMENTS,
  PACKAGING_FACTORS,
  advanceEngagement,
  createPackage,
  engageSupplier,
  entryCheck,
  lockReturn,
  normaliseBids,
  openPackageTender,
  procurementPosition,
  recommendAward,
  recommendPackaging,
  recordBid,
  scheduleFor,
  statePackageField,
  suspendEngagement,
  type ServiceBidLine,
  type ServicePackage,
} from '../src/domain/etablix/procurement.ts';
import { acceptInterface, assignInterface, composeSystem } from '../src/domain/etablix/composer.ts';
import { recordFact } from '../src/domain/etablix/brief.ts';
import { setAppointment } from '../src/domain/etablix/appointment.ts';
import { TRADE_CODES, registerSupplier, suspendSupplier } from '../src/domain/supplychain.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * §7 — the procurement and supplier-control factory.
 *
 * Three properties, one per subsection.
 *
 * 1. **§7.1 A packaging recommendation is an argument.** It must say why
 *    bundling reduces interfaces or why disaggregation protects competition and
 *    specialist performance, and it must say it from counted evidence. And a
 *    package cannot be issued with a minimum field silent, because the moment
 *    of issue is the last moment it is free to fix.
 * 2. **§7.2 An exclusion is priced, visibly, never scored.** Five returns
 *    against one schedule are five different scopes until they are normalised,
 *    and a scoring model that quietly deducts points for an exclusion produces
 *    a winner nobody can defend.
 * 3. **§7.3 A control state is a conclusion, not a click.** Contracted because
 *    somebody typed contracted is the control that fails in the month it
 *    matters.
 */

let platform: Platform;
let seed: SeedResult;

function as(who: string): EngineContext {
  return platform.context(seed.users[who]!.auth, seed.projectId);
}

const WINDOW = { fromDate: '2026-11-01', toDate: '2027-09-01', leadDays: 30 };

type Registered = { id: string; legalName: string; status: string; trades?: string[] };

function suppliers(): Registered[] {
  return platform.ledger
    .listByTenant(seed.users.pm!.auth.tenantId, 'Supplier')
    .map((record) => record.state as unknown as Registered);
}

/** A supplier registered for this test, with the trades the test needs. */
function register(legalName: string, trades: string[]): Registered {
  const { supplierId } = registerSupplier(as('qs'), {
    partyId: `SUP-${legalName.toUpperCase().replaceAll(' ', '-')}-${Math.random().toString(36).slice(2, 7)}`,
    legalName,
    trades,
    contactName: 'Commercial Manager',
    contactEmail: `enquiries@${legalName.split(' ')[0]!.toLowerCase()}.example`,
    countryCode: 'GB',
  });
  return suppliers().find((entry) => entry.id === supplierId)!;
}

function appoint(): void {
  setAppointment(as('pm'), {
    model: 'PRINCIPAL_SERVICE_CONTRACTOR',
    contractingEntity: 'Meridian Infrastructure Group Ltd',
    fundingSource: 'Client capital programme',
    basis: 'Single-point accountability across all seven families',
  });
  for (const [itemId, value] of [
    ['peakWorkforce', 164],
    ['shiftOverlapPersons', 120],
    ['visitorsPerDay', 22],
    ['accommodatedWorkers', 120],
    ['cleanableAreaSqm', 1800],
    // Security and logistics is sized on the gate and the bus, so the facts it
    // needs are recorded too — a family composed against nothing would assert a
    // design basis that does not exist, and the composer refuses to.
    ['gateThroughputPerHour', 120],
    ['travellingWorkforce', 96],
  ] as [string, number][]) {
    recordFact(as('pm'), { itemId, value, source: 'Programme rev D' });
  }
}

/** Compose one family in one zone and close its interfaces. */
function compose(family: string, zone = 'Main compound', leadDays = 30): string {
  const { system, interfaces } = composeSystem(as('pm'), { family, zone, ...WINDOW, leadDays });
  for (const entry of interfaces) {
    assignInterface(as('pm'), { interfaceId: entry.id, owner: 'Ruth Adeyemi', dueDate: '2026-10-15' });
    acceptInterface(as('pm'), { interfaceId: entry.id, note: `${entry.name} agreed` });
  }
  return system.id;
}

/** A package with all seven stated fields filled in, ready to issue. */
function completePackage(systemIds: string[], title = 'Welfare and accommodation'): ServicePackage {
  const created = createPackage(as('pm'), { title, systemIds });
  const values: Record<string, string> = {
    scope: 'In: supply, delivery, install, service and removal of all welfare units. Out: the compound platform and its drainage, which is the enabling civils package.',
    drawings: 'WEL-100 rev C compound layout; WEL-210 rev B unit schedule',
    kpis: 'Availability 99% of shift hours; cleaning to schedule A; hot water to every shower at shift change',
    evidence: 'Weekly service sheets, water temperature log, waste transfer notes, PAT records',
    acceptance: 'All units set, connected, tested and handed over with the O&M file and the training record',
    pricingMethod: 'Schedule of rates, remeasurable on the workforce curve',
    changeMechanism: 'Instructed change valued at the schedule rates; anything outside them agreed before instruction',
  };
  let current = created;
  for (const [field, value] of Object.entries(values)) {
    current = statePackageField(as('pm'), { packageId: created.id, field, value });
  }
  return current;
}

function line(itemId: string, quantity: number, rateMinor: number, extra: Partial<ServiceBidLine> = {}): ServiceBidLine {
  return { scheduleItemId: itemId, description: itemId, quantity, unit: 'unit', rateMinor, ...extra };
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
  // The demonstration tenancy has three civils firms and nothing else. Welfare
  // and cleaning firms are registered here so both halves of the packaging
  // argument have a real market behind them.
  register('Halcyon Welfare Systems Ltd', ['WELFARE', 'MODULAR']);
  register('Kestrel Facilities Ltd', ['CLEANING', 'WASTE_MANAGEMENT']);
  register('Ardley Modular Ltd', ['MODULAR', 'WELFARE', 'PLUMBING']);
  // Three firms that do welfare *and* cleaning, so the bundle has a market and
  // the bundling half of the argument can be made against a real one.
  register('Brightpath Site Services Ltd', ['WELFARE', 'CLEANING', 'MODULAR']);
  register('Lowfield Integrated Services Ltd', ['WELFARE', 'CLEANING', 'WASTE_MANAGEMENT']);
  register('Carrick Camp and Care Ltd', ['WELFARE', 'MODULAR', 'CLEANING']);
  // Three that do cleaning and security, which is the pair with exactly one
  // interface between them.
  register('Marchwood Site Control Ltd', ['CLEANING', 'SECURITY', 'LOGISTICS']);
  register('Aldergate Protective Services Ltd', ['SECURITY', 'CLEANING', 'TRAFFIC_MANAGEMENT']);
  register('Fenwick Estate Services Ltd', ['SECURITY', 'CLEANING', 'WASTE_MANAGEMENT']);
});

/**
 * The demonstration flagship, which really is in Operations.
 *
 * Held before `beforeEach` starts handing every test its own unphased project,
 * so the one test that needs a phased project has a real one rather than a
 * fixture pretending to be one.
 */
let FLAGSHIP: string;

beforeEach(() => {
  FLAGSHIP ??= seed.projectId;
  seed.projectId = `${seed.users.pm!.auth.tenantId}-${Math.random().toString(36).slice(2, 10)}`;
});

describe('§7.1 the packaging argument', () => {
  it('declares eight factors, each pushing a direction', () => {
    assert.equal(PACKAGING_FACTORS.length, 8);
    for (const factor of PACKAGING_FACTORS) {
      assert.ok(factor.question.length > 40, `${factor.id} does not say what it is asking`);
      assert.ok(['BUNDLE', 'DISAGGREGATE'].includes(factor.argues));
    }
    // They do not all push the same way. A set of factors that agreed would be
    // a preference with eight names on it.
    assert.ok(PACKAGING_FACTORS.some((factor) => factor.argues === 'BUNDLE'));
    assert.ok(PACKAGING_FACTORS.some((factor) => factor.argues === 'DISAGGREGATE'));
  });

  it('maps every family to trades the catalogue actually holds', () => {
    // The join between ETABLIX's seven families and CONSTRUX's closed trade
    // catalogue. A code that drifts out of the catalogue would silently return
    // no bidders, and no bidders reads as "no market" rather than as a bug.
    for (const [family, trades] of Object.entries(FAMILY_TRADES)) {
      assert.ok(trades.length > 0, `${family} maps to no trade`);
      for (const trade of trades) {
        assert.ok(TRADE_CODES.has(trade), `${family} maps to ${trade}, which is not in the trade catalogue`);
      }
    }
  });

  it('refuses to package a brief nothing has been composed from', () => {
    appoint();
    throwsCode(() => recommendPackaging(as('pm')), 'PACKAGING_NOTHING_COMPOSED');
  });

  it('argues for bundling by naming the interfaces it removes', () => {
    appoint();
    const welfare = compose('WELFARE_ACCOMMODATION');
    const cleaning = compose('CLEANING_FM');
    const strategy = recommendPackaging(as('pm'));

    const option = strategy.options.find((entry) => entry.systemIds.includes(welfare) && entry.systemIds.includes(cleaning))!;
    assert.equal(option.recommendation, 'BUNDLE');
    assert.match(option.argument, /^Bundling reduces interfaces/);
    // Named, not counted. "Three interfaces" is a number; "the workforce curve"
    // is the conversation that stops happening.
    for (const entry of option.internalised) {
      assert.ok(option.argument.includes(entry.name), `${entry.name} was internalised and not named in the argument`);
    }
    assert.ok(option.internalised.length > 1);
    assert.match(option.argument, /stop being interfaces between two firms and become internal matters for one/);
    assert.ok(option.biddersIfBundled >= COMPETITION_FLOOR);
    assert.match(option.argument, /which meets the floor of 3/);
  });

  it('argues for disaggregation when a bundle costs the competition', () => {
    appoint();
    // The demonstration supply chain has civils firms and welfare firms, and
    // not one firm that does both. Bundled, the package has no market.
    const welfare = compose('WELFARE_ACCOMMODATION');
    const civils = compose('ENABLING_CIVILS');
    const strategy = recommendPackaging(as('pm'));

    const option = strategy.options.find((entry) => entry.systemIds.includes(welfare) && entry.systemIds.includes(civils))!;
    assert.equal(option.recommendation, 'DISAGGREGATE');
    assert.match(option.argument, /^Disaggregation protects competition/);
    // No firm on the register does both, so the sentence says exactly that
    // rather than "only 0 firms", which reads as arithmetic rather than as a
    // market with nobody in it.
    assert.match(option.argument, /no firm on the register can deliver both families/);
    assert.match(option.argument, /A bundle nobody can price is a negotiation, not a tender/);
    // And it says what the split would buy, which is the whole argument.
    assert.ok(option.biddersIfSeparate.every((entry) => entry.count >= 0));
    assert.ok(option.biddersIfSeparate.some((entry) => entry.count > option.biddersIfBundled));
  });

  it('never produces an option without an argument', () => {
    appoint();
    compose('WELFARE_ACCOMMODATION');
    compose('CLEANING_FM');
    compose('ENABLING_CIVILS');
    const strategy = recommendPackaging(as('pm'));
    assert.equal(strategy.options.length, 3, 'three systems make three pairs');
    for (const option of strategy.options) {
      assert.ok(
        /^(Bundling reduces interfaces|Disaggregation protects (competition|specialist performance))/.test(option.argument),
        `${option.label} was recommended without saying which of the two it is doing`,
      );
      assert.ok(option.factors.length > 0);
    }
  });

  it('reads as English when exactly one interface is internalised', () => {
    // Cleaning carries "Waste routes" with security, and security carries
    // nothing back. One interface, and the sentence has to say so in the
    // singular — a recommendation that reads as a mail merge is not read.
    appoint();
    compose('CLEANING_FM');
    compose('SECURITY_LOGISTICS');
    const option = recommendPackaging(as('pm')).options[0]!;
    assert.equal(option.internalised.length, 1);
    assert.equal(option.recommendation, 'BUNDLE');
    assert.match(option.argument, /Waste routes stops being an interface between two firms and becomes an internal matter for one/);
  });

  it('says what the appointment does to this pair, not to appointments in general', () => {
    // A factor line identical on every option is decoration, not evidence. The
    // general statement is on the strategy once; the factor names these two.
    appoint();
    compose('WELFARE_ACCOMMODATION');
    compose('CLEANING_FM');
    const option = recommendPackaging(as('pm')).options[0]!;
    const factor = option.factors.find((entry) => entry.id === 'appointmentModel')!;
    assert.match(factor.says, /welfare and accommodation/);
    assert.match(factor.says, /cleaning, fm and living services/);
    // Under Prime the bundle is ETABLIX's own balance sheet, and the factor
    // pushes against concentrating it.
    assert.match(factor.says, /one cash exposure on ETABLIX's own balance sheet rather than two/);
    assert.equal(factor.supports, 'DISAGGREGATE');
  });

  it('says what the appointment does to the argument', () => {
    appoint();
    compose('WELFARE_ACCOMMODATION');
    const strategy = recommendPackaging(as('pm'));
    // Under Prime the bundle is ETABLIX's own balance sheet, and that changes
    // who the argument is being made for.
    assert.match(strategy.modelEffect, /ETABLIX holds and funds the supplier contracts/);
    assert.equal(strategy.competitionFloor, COMPETITION_FLOOR);
  });
});

describe('§7.1 the twelve minimum fields', () => {
  it('is five derived and seven stated, each saying what it prevents', () => {
    assert.equal(PACKAGE_REQUIREMENTS.length, 12);
    assert.equal(PACKAGE_REQUIREMENTS.filter((entry) => entry.kind === 'DERIVED').length, 5);
    assert.equal(PACKAGE_REQUIREMENTS.filter((entry) => entry.kind === 'STATED').length, 7);
    for (const requirement of PACKAGE_REQUIREMENTS) {
      assert.ok(requirement.matters.length > 40, `${requirement.id} does not say why it is asked for`);
    }
  });

  it('derives the interfaces, quantities, programme and removal from the systems', () => {
    appoint();
    const welfare = compose('WELFARE_ACCOMMODATION');
    createPackage(as('pm'), { title: 'Welfare', systemIds: [welfare] });
    const view = procurementPosition(as('pm')).packages[0]!;

    const derived = view.requirements.filter((entry) => entry.kind === 'DERIVED');
    assert.ok(derived.every((entry) => entry.satisfied), 'a derived field came back outstanding on a composed system');
    assert.match(view.requirements.find((entry) => entry.id === 'programme')!.detail, /On site 2026-11-01 to 2027-09-01 — \d+ weeks/);
    assert.match(view.requirements.find((entry) => entry.id === 'quantities')!.detail, /persons|WCs|litres/);
    assert.match(
      view.requirements.find((entry) => entry.id === 'removal')!.detail,
      /released only once a successor facility is accepted/,
    );
  });

  it('refuses to let a derived field be typed by hand', () => {
    appoint();
    const welfare = compose('WELFARE_ACCOMMODATION');
    const record = createPackage(as('pm'), { title: 'Welfare', systemIds: [welfare] });
    const error = throwsCode(
      () => statePackageField(as('pm'), { packageId: record.id, field: 'quantities', value: '7 WCs' }),
      'SERVICE_PACKAGE_FIELD_DERIVED',
    );
    assert.match(String(error.message), /derived from the systems this package links to/);
  });

  it('refuses a package that buys nothing, and a system bought twice', () => {
    appoint();
    const welfare = compose('WELFARE_ACCOMMODATION');
    throwsCode(() => createPackage(as('pm'), { title: 'Welfare', systemIds: [] }), 'SERVICE_PACKAGE_UNLINKED');
    createPackage(as('pm'), { title: 'Welfare', systemIds: [welfare] });
    const error = throwsCode(
      () => createPackage(as('pm'), { title: 'Welfare again', systemIds: [welfare] }),
      'SERVICE_SYSTEM_ALREADY_PACKAGED',
    );
    assert.match(String(error.message), /paid for twice/);
  });

  it('refuses to issue a package with a minimum field silent, and names them', () => {
    appoint();
    const welfare = compose('WELFARE_ACCOMMODATION');
    const record = createPackage(as('pm'), { title: 'Welfare', systemIds: [welfare] });
    const error = throwsCode(
      () => openPackageTender(as('pm'), { packageId: record.id, returnDeadline: '2026-10-01' }),
      'SERVICE_PACKAGE_INCOMPLETE',
    );
    assert.match(String(error.message), /7 of 12 minimum fields outstanding/);
    assert.match(String(error.message), /Acceptance criteria/);
    // The refusal carries what each one prevents, not just its name.
    assert.match(String(error.message), /drawn by whoever is under the most pressure/);
  });

  it('issues a package on a project already in operations', () => {
    // Site services are not the main works. Welfare is bought before the first
    // pour, cleaning is re-let in month twenty, security runs past practical
    // completion and the compound is demobilised after handover. The enquiry is
    // raised under SITE_SERVICES, so the main-works procurement window — Tender
    // and Construction, and rightly closed afterwards — does not close the
    // wrong door on it.
    seed.projectId = FLAGSHIP;
    assert.equal(
      platform.ledger.get({ refType: 'Project', refId: FLAGSHIP })!.state.phase,
      'OPERATIONS',
      'the flagship demonstration project is no longer in operations',
    );

    appoint();
    const welfare = compose('WELFARE_ACCOMMODATION', 'Operations compound');
    const record = completePackage([welfare], 'Welfare, re-let');

    const issued = openPackageTender(as('pm'), { packageId: record.id, returnDeadline: '2027-02-01' });
    assert.match(issued.reference, /^ENQ-\d{3}$/);
    // And the enquiry says which authority it was raised under, so a reader can
    // tell a site-services enquiry from a main-works one.
    const enquiry = platform.ledger
      .list(FLAGSHIP, 'Enquiry')
      .map((entry) => entry.state as unknown as { id: string; area?: string })
      .find((entry) => entry.id === issued.enquiryId)!;
    assert.equal(enquiry.area, 'SITE_SERVICES');
  });

  it('issues a complete package as a controlled enquiry, once', () => {
    appoint();
    const welfare = compose('WELFARE_ACCOMMODATION');
    const record = completePackage([welfare]);
    const issued = openPackageTender(as('pm'), { packageId: record.id, returnDeadline: '2026-10-01' });
    // The tender event is CONSTRUX's own enquiry machinery, reused rather than
    // rebuilt: the recipients, addenda and acknowledgement all live there.
    assert.match(issued.reference, /^ENQ-\d{3}$/);
    assert.ok(issued.package.enquiryId);
    assert.ok(platform.ledger.list(seed.projectId, 'Enquiry').length > 0);

    throwsCode(
      () => openPackageTender(as('pm'), { packageId: record.id, returnDeadline: '2026-11-01' }),
      'SERVICE_PACKAGE_TENDERED',
    );
    // And the scope is frozen: a change now is an addendum every bidder sees.
    const error = throwsCode(
      () => statePackageField(as('pm'), { packageId: record.id, field: 'kpis', value: 'Availability 95%' }),
      'SERVICE_PACKAGE_TENDERED',
    );
    assert.match(String(error.message), /addendum on the enquiry/);
  });
});

describe('§7.2 normalisation', () => {
  function tendered(): { packageId: string; schedule: ReturnType<typeof scheduleFor> } {
    appoint();
    const welfare = compose('WELFARE_ACCOMMODATION');
    const record = completePackage([welfare]);
    openPackageTender(as('pm'), { packageId: record.id, returnDeadline: '2026-10-01' });
    const schedule = scheduleFor(as('pm'), procurementPosition(as('pm')).packages[0]!);
    return { packageId: record.id, schedule };
  }

  it('maps every line to the issued schedule and names what does not fit', () => {
    const { packageId, schedule } = tendered();
    const first = schedule[0]!;
    const second = schedule[1]!;

    recordBid(as('pm'), {
      packageId,
      supplierId: 'SUP-A',
      supplierName: 'Halcyon Welfare Systems Ltd',
      basis: CLEAN_BASIS,
      lines: [
        line(first.itemId, first.quantity, 1_000_00),
        line(first.itemId, first.quantity, 900_00),
        line('not-on-the-schedule', 1, 4_000_00),
        line(second.itemId, second.quantity + 5, 200_00),
      ],
    });

    const result = normaliseBids(as('pm'), packageId);
    const kinds = result.bids[0]!.mapping.map((entry) => entry.kind);
    assert.ok(kinds.includes('DUPLICATE'), 'a line priced twice was not reported');
    assert.ok(kinds.includes('UNSOLICITED'), 'a line not on the schedule was not reported');
    assert.ok(kinds.includes('OMISSION'), 'a schedule item neither priced nor excluded was not reported');
    assert.ok(kinds.includes('QUALIFICATION'), 'a quantity that disagrees with the schedule was not reported');
    assert.match(
      result.bids[0]!.mapping.find((entry) => entry.kind === 'OMISSION')!.statement,
      /Silence is not a zero/,
    );
  });

  it('prices an exclusion at the median compliant rate, visibly', () => {
    const { packageId, schedule } = tendered();
    const item = schedule[0]!;
    // Three firms price it; the fourth excludes it. The median of the three is
    // what the exclusion costs — and it appears as a number, not as a lost mark.
    for (const [id, rate] of [
      ['SUP-A', 1_000_00],
      ['SUP-B', 1_200_00],
      ['SUP-C', 1_600_00],
    ] as [string, number][]) {
      recordBid(as('pm'), {
        packageId,
        supplierId: id,
        supplierName: `Firm ${id}`,
        basis: CLEAN_BASIS,
        lines: schedule.map((entry) => line(entry.itemId, entry.quantity, rate)),
      });
    }
    recordBid(as('pm'), {
      packageId,
      supplierId: 'SUP-D',
      supplierName: 'Firm D',
      basis: CLEAN_BASIS,
      lines: schedule.filter((entry) => entry.itemId !== item.itemId).map((entry) => line(entry.itemId, entry.quantity, 1_100_00)),
      exclusions: [item.itemId],
    });

    const result = normaliseBids(as('pm'), packageId);
    const excluder = result.bids.find((entry) => entry.supplierId === 'SUP-D')!;
    const priced = excluder.pricedExclusions.find((entry) => entry.item.includes(item.description))!;

    assert.equal(priced.pricedMinor, 1_200_00 * item.quantity, 'the median of 1000, 1200 and 1600 is 1200');
    assert.match(priced.source, /Median compliant rate of GBP 1200\.00 across 3 returns/);
    // The whole point: the exclusion is in the money, not in a score.
    assert.equal(excluder.normalisedMinor, excluder.submittedMinor + priced.pricedMinor);
    assert.equal(excluder.technicalScore, undefined);
  });

  it('takes the median of the compliant rates only, and averages the middle two of an even field', () => {
    const { packageId, schedule } = tendered();
    const item = schedule[0]!;
    // Four firms price it: 1000, 1200, 1600, 2000. The median of an even field
    // is the average of the middle two — 1400 — not whichever of them the
    // sort happened to put second.
    for (const [id, rate] of [
      ['SUP-A', 1_000_00],
      ['SUP-B', 1_200_00],
      ['SUP-C', 1_600_00],
      ['SUP-D', 2_000_00],
    ] as [string, number][]) {
      recordBid(as('pm'), {
        packageId,
        supplierId: id,
        supplierName: `Firm ${id}`,
        basis: CLEAN_BASIS,
        lines: schedule.map((entry) => line(entry.itemId, entry.quantity, rate)),
      });
    }
    // The fifth declares the item excluded and still carries a nil line for it,
    // which is what a real return looks like: "excluded — shown at nil for
    // completeness". A firm that excluded an item has no opinion about what it
    // costs, and counting their nil as a rate would drag the median toward the
    // exclusion it is meant to price.
    recordBid(as('pm'), {
      packageId,
      supplierId: 'SUP-E',
      supplierName: 'Firm E',
      basis: CLEAN_BASIS,
      lines: schedule.map((entry) => line(entry.itemId, entry.quantity, entry.itemId === item.itemId ? 0 : 1_100_00)),
      exclusions: [item.itemId],
    });

    const result = normaliseBids(as('pm'), packageId);
    const medianEntry = result.medians.find((entry) => entry.itemId === item.itemId)!;
    assert.equal(medianEntry.compliantBids, 4, 'the firm that excluded it was counted as having priced it');
    assert.equal(medianEntry.medianRateMinor, 1_400_00, 'the median of 1000, 1200, 1600 and 2000 is 1400');

    const excluder = result.bids.find((entry) => entry.supplierId === 'SUP-E')!;
    const priced = excluder.pricedExclusions.find((entry) => entry.item.includes(item.description))!;
    assert.equal(priced.pricedMinor, 1_400_00 * item.quantity);
  });

  it('carries an exclusion nobody priced at zero, and says so rather than scoring it', () => {
    const { packageId, schedule } = tendered();
    const item = schedule[0]!;
    recordBid(as('pm'), {
      packageId,
      supplierId: 'SUP-A',
      supplierName: 'Firm A',
      basis: CLEAN_BASIS,
      lines: schedule.filter((entry) => entry.itemId !== item.itemId).map((entry) => line(entry.itemId, entry.quantity, 900_00)),
      exclusions: [item.itemId],
    });
    const priced = normaliseBids(as('pm'), packageId).bids[0]!.pricedExclusions[0]!;
    assert.equal(priced.pricedMinor, 0);
    assert.match(priced.source, /no median to price it at/);
    assert.match(priced.source, /a cost, not a deduction/);
  });

  it('adjusts a hire period priced short of the programme', () => {
    const { packageId, schedule } = tendered();
    recordBid(as('pm'), {
      packageId,
      supplierId: 'SUP-A',
      supplierName: 'Firm A',
      basis: { ...CLEAN_BASIS, hirePeriodWeeks: 30 },
      lines: schedule.map((entry) => line(entry.itemId, entry.quantity, 1_000_00)),
    });
    const adjustment = normaliseBids(as('pm'), packageId).bids[0]!.adjustments.find(
      (entry) => entry.basis === 'hirePeriodWeeks',
    )!;
    assert.ok(adjustment.adjustmentMinor > 0, 'a short hire period cost nothing');
    assert.match(adjustment.reason, /Priced over 30 weeks against a programme of \d+/);
    assert.match(adjustment.reason, /weeks somebody pays for/);
  });

  it('refuses to invent an exchange rate, and says the return is incomparable', () => {
    const { packageId, schedule } = tendered();
    recordBid(as('pm'), {
      packageId,
      supplierId: 'SUP-A',
      supplierName: 'Firm A',
      basis: CLEAN_BASIS,
      lines: schedule.map((entry) => line(entry.itemId, entry.quantity, 1_000_00)),
    });
    recordBid(as('pm'), {
      packageId,
      supplierId: 'SUP-B',
      supplierName: 'Firm B',
      basis: { ...CLEAN_BASIS, currency: 'EUR' },
      lines: schedule.map((entry) => line(entry.itemId, entry.quantity, 1_000_00)),
    });
    const euro = normaliseBids(as('pm'), packageId).bids.find((entry) => entry.supplierId === 'SUP-B')!;
    assert.match(String(euro.incomparable), /No exchange rate is held/);
    assert.ok(euro.clarifications.some((entry) => entry.awardBlocking));
  });

  it('reports a tax-inclusive return rather than silently stripping the tax', () => {
    const { packageId, schedule } = tendered();
    recordBid(as('pm'), {
      packageId,
      supplierId: 'SUP-A',
      supplierName: 'Firm A',
      basis: { ...CLEAN_BASIS, taxBasis: 'INCLUSIVE' },
      lines: schedule.map((entry) => line(entry.itemId, entry.quantity, 1_000_00)),
    });
    const bid = normaliseBids(as('pm'), packageId).bids[0]!;
    assert.match(String(bid.incomparable), /tax-inclusive/);
    const adjustment = bid.adjustments.find((entry) => entry.basis === 'taxBasis')!;
    assert.equal(adjustment.adjustmentMinor, 0, 'a guessed tax rate is worse than a stated unknown');
  });

  it('treats a basis the bidder said nothing about as unknown, not as included', () => {
    const { packageId, schedule } = tendered();
    recordBid(as('pm'), {
      packageId,
      supplierId: 'SUP-A',
      supplierName: 'Firm A',
      basis: { currency: 'GBP', taxBasis: 'EXCLUSIVE' },
      lines: schedule.map((entry) => line(entry.itemId, entry.quantity, 1_000_00)),
    });
    const bid = normaliseBids(as('pm'), packageId).bids[0]!;
    const standby = bid.adjustments.find((entry) => entry.basis === 'standby')!;
    assert.equal(standby.declared, 'Not stated');
    assert.match(standby.reason, /Unknown is not the same as included/);
    assert.ok(bid.clarifications.some((entry) => /Standby is neither included nor excluded/.test(entry.question)));
  });

  it('evaluates five sensitivities, all of them named', () => {
    const { packageId, schedule } = tendered();
    recordBid(as('pm'), {
      packageId,
      supplierId: 'SUP-A',
      supplierName: 'Firm A',
      basis: CLEAN_BASIS,
      lines: schedule.map((entry) => line(entry.itemId, entry.quantity, 1_000_00)),
    });
    const bid = normaliseBids(as('pm'), packageId).bids[0]!;
    assert.deepEqual(
      bid.sensitivities.map((entry) => entry.id),
      ['MOBILISATION_DELAY', 'PEAK_WORKFORCE', 'EXTENSION', 'ENERGY_VARIANCE', 'EARLY_TERMINATION'],
    );
    for (const entry of bid.sensitivities) {
      assert.ok(entry.assumption.length > 20, `${entry.id} does not say what it assumes`);
    }
    assert.ok(
      bid.sensitivities.find((entry) => entry.id === 'PEAK_WORKFORCE')!.evaluatedMinor > bid.normalisedMinor,
    );
  });

  it('ranks clarifications by what it is worth being wrong about', () => {
    const { packageId, schedule } = tendered();
    recordBid(as('pm'), {
      packageId,
      supplierId: 'SUP-A',
      supplierName: 'Firm A',
      basis: { currency: 'GBP', taxBasis: 'EXCLUSIVE' },
      lines: [line(schedule[0]!.itemId, schedule[0]!.quantity, 1_000_00)],
    });
    const clarifications = normaliseBids(as('pm'), packageId).bids[0]!.clarifications;
    assert.ok(clarifications.length > 1);
    // Award-blocking first, and within those the expensive ones first.
    const blocking = clarifications.filter((entry) => entry.awardBlocking);
    assert.equal(clarifications.slice(0, blocking.length).every((entry) => entry.awardBlocking), true);
    for (let i = 1; i < blocking.length; i += 1) {
      assert.ok(blocking[i - 1]!.consequenceMinor >= blocking[i]!.consequenceMinor, 'clarifications are out of order');
    }
  });

  it('supersedes a first return with the clarified one, and will not lock the one it replaced', () => {
    const { packageId, schedule } = tendered();
    const first = recordBid(as('pm'), {
      packageId,
      supplierId: 'SUP-A',
      supplierName: 'Firm A',
      basis: CLEAN_BASIS,
      lines: schedule.map((entry) => line(entry.itemId, entry.quantity, 1_000_00)),
    });
    const clarified = recordBid(as('pm'), {
      packageId,
      supplierId: 'SUP-A',
      supplierName: 'Firm A',
      basis: CLEAN_BASIS,
      lines: schedule.map((entry) => line(entry.itemId, entry.quantity, 1_100_00)),
    });
    const result = normaliseBids(as('pm'), packageId);
    assert.equal(result.received, 1, 'one firm, two prices, and no rule for choosing');
    assert.equal(result.bids[0]!.bidId, clarified.id);

    // Locking the replaced one would freeze the comparison against a price the
    // firm has already moved off.
    const error = throwsCode(
      () => lockReturn(as('pm'), { bidId: first.id, acknowledgedBy: 'Commercial manager' }),
      'SERVICE_BID_SUPERSEDED',
    );
    assert.match(String(error.message), /Lock the return that stands/);
  });

  it('locks a return only with an acknowledgement, and only once', () => {
    const { packageId, schedule } = tendered();
    const bid = recordBid(as('pm'), {
      packageId,
      supplierId: 'SUP-A',
      supplierName: 'Firm A',
      basis: CLEAN_BASIS,
      lines: schedule.map((entry) => line(entry.itemId, entry.quantity, 1_000_00)),
    });
    throwsCode(
      () => lockReturn(as('pm'), { bidId: bid.id, acknowledgedBy: '  ' }),
      'SERVICE_BID_UNACKNOWLEDGED',
    );
    const locked = lockReturn(as('pm'), { bidId: bid.id, acknowledgedBy: 'D. Okafor, Halcyon' });
    const again = lockReturn(as('pm'), { bidId: bid.id, acknowledgedBy: 'Somebody else' });
    assert.equal(again.lockedAt, locked.lockedAt);
    assert.equal(again.acknowledgedBy, 'D. Okafor, Halcyon');
  });

  it('refuses a return against a package nobody issued', () => {
    appoint();
    const welfare = compose('WELFARE_ACCOMMODATION');
    const record = completePackage([welfare]);
    throwsCode(
      () =>
        recordBid(as('pm'), {
          packageId: record.id,
          supplierId: 'SUP-A',
          supplierName: 'Firm A',
          basis: CLEAN_BASIS,
          lines: [line('anything', 1, 100)],
        }),
      'SERVICE_PACKAGE_NOT_TENDERED',
    );
  });

  it('is refused to a tenancy without the module', () => {
    appoint();
    const welfare = compose('WELFARE_ACCOMMODATION');
    const record = completePackage([welfare]);
    const ungranted = { ...as('pm'), grantedModules: [] };
    throwsCode(() => procurementPosition(ungranted), 'MODULE_NOT_GRANTED');
    throwsCode(() => normaliseBids(ungranted, record.id), 'MODULE_NOT_GRANTED');
    throwsCode(() => recommendPackaging(ungranted), 'MODULE_NOT_GRANTED');
  });
});

describe('§7.2 the award recommendation', () => {
  function withReturns(rates: [string, string, number][]): { packageId: string } {
    appoint();
    const welfare = compose('WELFARE_ACCOMMODATION');
    const record = completePackage([welfare]);
    openPackageTender(as('pm'), { packageId: record.id, returnDeadline: '2026-10-01' });
    const schedule = scheduleFor(as('pm'), procurementPosition(as('pm')).packages[0]!);
    for (const [id, name, rate] of rates) {
      recordBid(as('pm'), {
        packageId: record.id,
        supplierId: id,
        supplierName: name,
        basis: CLEAN_BASIS,
        lines: schedule.map((entry) => line(entry.itemId, entry.quantity, rate)),
        technicalScore: 70,
      });
    }
    return { packageId: record.id };
  }

  it('refuses while any return is unlocked, and names them', () => {
    const registered = suppliers().filter((entry) => (entry.trades ?? []).includes('WELFARE'));
    const { packageId } = withReturns([
      [registered[0]!.id, registered[0]!.legalName, 1_000_00],
      [registered[1]!.id, registered[1]!.legalName, 1_100_00],
    ]);
    const recommendation = recommendAward(as('pm'), packageId);
    assert.equal(recommendation.recommended, undefined);
    assert.match(String(recommendation.refusedBecause), /2 of 2 returns are not locked/);
    assert.match(String(recommendation.refusedBecause), /what the buyer believes they meant/);
  });

  it('recommends the cheapest normalised eligible return once everything is locked', () => {
    const registered = suppliers().filter((entry) => (entry.trades ?? []).includes('WELFARE'));
    const { packageId } = withReturns([
      [registered[0]!.id, registered[0]!.legalName, 1_200_00],
      [registered[1]!.id, registered[1]!.legalName, 1_000_00],
    ]);
    for (const bid of normaliseBids(as('pm'), packageId).bids) {
      lockReturn(as('pm'), { bidId: bid.bidId, acknowledgedBy: `Commercial manager, ${bid.supplierName}` });
    }
    const recommendation = recommendAward(as('pm'), packageId);
    assert.equal(recommendation.refusedBecause, undefined);
    assert.equal(recommendation.recommended!.supplierId, registered[1]!.id);
    assert.equal(recommendation.comparison.length, 2);
    for (const entry of recommendation.comparison) {
      assert.ok(entry.worstCase.length > 0, 'no worst case named');
      assert.ok(entry.deliveryRisk.length > 0);
    }
  });

  it('notes the standstill only where the award was actually competed', () => {
    const registered = suppliers().filter((entry) => (entry.trades ?? []).includes('WELFARE'));
    const two = withReturns([
      [registered[0]!.id, registered[0]!.legalName, 1_200_00],
      [registered[1]!.id, registered[1]!.legalName, 1_000_00],
    ]);
    for (const bid of normaliseBids(as('pm'), two.packageId).bids) {
      lockReturn(as('pm'), { bidId: bid.bidId, acknowledgedBy: 'Commercial manager' });
    }
    // Two returns is a comparison, not a competition, and claiming a standstill
    // where none applies is as wrong as omitting one where it does.
    assert.equal(recommendAward(as('pm'), two.packageId).standstill, undefined);

    seed.projectId = `${seed.users.pm!.auth.tenantId}-${Math.random().toString(36).slice(2, 10)}`;
    const three = withReturns([
      [registered[0]!.id, registered[0]!.legalName, 1_200_00],
      [registered[1]!.id, registered[1]!.legalName, 1_000_00],
      [registered[2]!.id, registered[2]!.legalName, 1_400_00],
    ]);
    for (const bid of normaliseBids(as('pm'), three.packageId).bids) {
      lockReturn(as('pm'), { bidId: bid.bidId, acknowledgedBy: 'Commercial manager' });
    }
    const competed = recommendAward(as('pm'), three.packageId);
    assert.match(String(competed.standstill), /three or more eligible returns/);
    assert.match(String(competed.standstill), /before the contract is placed/);
  });

  it('holds a firm off the register ineligible however good the price', () => {
    const registered = suppliers().filter((entry) => (entry.trades ?? []).includes('WELFARE'));
    const { packageId } = withReturns([
      ['SUP-NOBODY-REGISTERED', 'Cheap and Unknown Ltd', 100_00],
      [registered[0]!.id, registered[0]!.legalName, 1_000_00],
    ]);
    for (const bid of normaliseBids(as('pm'), packageId).bids) {
      lockReturn(as('pm'), { bidId: bid.bidId, acknowledgedBy: 'Commercial manager' });
    }
    const recommendation = recommendAward(as('pm'), packageId);
    const stranger = recommendation.eligibility.find((entry) => entry.supplierName === 'Cheap and Unknown Ltd')!;
    assert.equal(stranger.eligible, false);
    assert.match(stranger.reason, /a firm nobody prequalified is a return from a firm nobody checked/);
    // Cheapest, and not recommended.
    assert.equal(recommendation.recommended!.supplierId, registered[0]!.id);
  });

  it('reports when normalisation changed the order the prices arrived in', () => {
    const registered = suppliers().filter((entry) => (entry.trades ?? []).includes('WELFARE'));
    appoint();
    const welfare = compose('WELFARE_ACCOMMODATION');
    const record = completePackage([welfare]);
    openPackageTender(as('pm'), { packageId: record.id, returnDeadline: '2026-10-01' });
    const schedule = scheduleFor(as('pm'), procurementPosition(as('pm')).packages[0]!);

    assert.ok(schedule.length >= 3, 'the comparison needs a schedule with something in it');
    // The cheapest submitted price is cheapest because it priced less scope:
    // one item at a high rate and everything else declared out. That is the
    // return that wins on a page of submitted totals and loses the moment the
    // exclusions are priced — which is the whole reason step three exists.
    recordBid(as('pm'), {
      packageId: record.id,
      supplierId: registered[0]!.id,
      supplierName: registered[0]!.legalName,
      basis: CLEAN_BASIS,
      lines: [line(schedule[0]!.itemId, schedule[0]!.quantity, 900_00)],
      exclusions: schedule.slice(1).map((entry) => entry.itemId),
    });
    for (const supplier of registered.slice(1, 3)) {
      recordBid(as('pm'), {
        packageId: record.id,
        supplierId: supplier.id,
        supplierName: supplier.legalName,
        basis: CLEAN_BASIS,
        lines: schedule.map((entry) => line(entry.itemId, entry.quantity, 600_00)),
      });
    }
    for (const bid of normaliseBids(as('pm'), record.id).bids) {
      lockReturn(as('pm'), { bidId: bid.bidId, acknowledgedBy: 'Commercial manager' });
    }

    const recommendation = recommendAward(as('pm'), record.id);
    assert.equal(recommendation.orderChanged, true, 'pricing the exclusion did not change who was cheapest');
    assert.notEqual(recommendation.recommended!.supplierId, registered[0]!.id);
  });

  it('refuses while an award-blocking clarification stands, however locked the returns are', () => {
    const registered = suppliers().filter((entry) => (entry.trades ?? []).includes('WELFARE'));
    appoint();
    const welfare = compose('WELFARE_ACCOMMODATION');
    const record = completePackage([welfare]);
    openPackageTender(as('pm'), { packageId: record.id, returnDeadline: '2026-10-01' });
    const schedule = scheduleFor(as('pm'), procurementPosition(as('pm')).packages[0]!);

    // One firm leaves an item neither priced nor excluded. Locked or not, that
    // is a question whose answer changes the answer.
    recordBid(as('pm'), {
      packageId: record.id,
      supplierId: registered[0]!.id,
      supplierName: registered[0]!.legalName,
      basis: CLEAN_BASIS,
      lines: schedule.slice(1).map((entry) => line(entry.itemId, entry.quantity, 600_00)),
    });
    recordBid(as('pm'), {
      packageId: record.id,
      supplierId: registered[1]!.id,
      supplierName: registered[1]!.legalName,
      basis: CLEAN_BASIS,
      lines: schedule.map((entry) => line(entry.itemId, entry.quantity, 700_00)),
    });
    for (const bid of normaliseBids(as('pm'), record.id).bids) {
      lockReturn(as('pm'), { bidId: bid.bidId, acknowledgedBy: 'Commercial manager' });
    }

    const recommendation = recommendAward(as('pm'), record.id);
    assert.equal(recommendation.recommended, undefined);
    assert.match(String(recommendation.refusedBecause), /award-blocking clarifications outstanding/);
    assert.match(String(recommendation.refusedBecause), /whose answer changes the answer/);
    assert.match(String(recommendation.refusedBecause), new RegExp(registered[0]!.legalName));
  });

  it('holds a firm the register suspended ineligible, and says whose decision that was', () => {
    const registered = suppliers().filter((entry) => (entry.trades ?? []).includes('WELFARE'));
    const barred = registered[0]!;
    // Suspended on the corporate register, which is a decision the business
    // made. This module reads it; it does not get a second opinion about it.
    suspendSupplier(as('pm'), barred.id, { reason: 'Fatal accident under investigation' });

    const { packageId } = withReturns([
      [barred.id, barred.legalName, 500_00],
      [registered[1]!.id, registered[1]!.legalName, 900_00],
    ]);
    for (const bid of normaliseBids(as('pm'), packageId).bids) {
      lockReturn(as('pm'), { bidId: bid.bidId, acknowledgedBy: 'Commercial manager' });
    }

    const recommendation = recommendAward(as('pm'), packageId);
    const entry = recommendation.eligibility.find((row) => row.supplierId === barred.id)!;
    assert.equal(entry.eligible, false);
    assert.match(entry.reason, /suspended/);
    assert.match(entry.reason, /not overridden by a good price/);
    // Cheapest by a distance, and not recommended.
    assert.equal(recommendation.recommended!.supplierId, registered[1]!.id);
  });

  it('refuses on an empty field', () => {
    appoint();
    const welfare = compose('WELFARE_ACCOMMODATION');
    const record = completePackage([welfare]);
    openPackageTender(as('pm'), { packageId: record.id, returnDeadline: '2026-10-01' });
    throwsCode(() => recommendAward(as('pm'), record.id), 'SERVICE_AWARD_NO_RETURNS');
  });
});

describe('§7.3 the nine control states', () => {
  function engaged(): { packageId: string; engagementId: string; supplierId: string } {
    appoint();
    const welfare = compose('WELFARE_ACCOMMODATION');
    const record = completePackage([welfare]);
    const supplier = suppliers().find((entry) => (entry.trades ?? []).includes('WELFARE'))!;
    const engagement = engageSupplier(as('pm'), {
      packageId: record.id,
      supplierId: supplier.id,
      supplierName: supplier.legalName,
    });
    return { packageId: record.id, engagementId: engagement.id, supplierId: supplier.id };
  }

  it('is nine states in order, each with entry criteria and controls', () => {
    assert.equal(CONTROL_STATES.length, 9);
    assert.deepEqual(CONTROL_STATES.map((state) => state.id), [...CONTROL_STATE_IDS]);
    CONTROL_STATES.forEach((state, index) => {
      assert.equal(state.order, index, `${state.id} is out of order`);
      assert.ok(state.entryCriteria.length > 20, `${state.id} has no entry criteria`);
      assert.ok(state.automatedControls.length > 0, `${state.id} watches nothing`);
    });
    assert.ok(
      CONTROL_STATES.find((state) => state.id === 'SUSPENDED_RECOVERY')!.automatedControls.includes('Block new work'),
    );
  });

  it('opens at Prospect only for a firm the register knows', () => {
    appoint();
    const welfare = compose('WELFARE_ACCOMMODATION');
    const record = completePackage([welfare]);
    const error = throwsCode(
      () => engageSupplier(as('pm'), { packageId: record.id, supplierId: 'SUP-GHOST', supplierName: 'Ghost Ltd' }),
      'SUPPLIER_ENGAGEMENT_INELIGIBLE',
    );
    assert.match(String(error.message), /a name in an email/);
  });

  it('refuses a second engagement for one firm on one package', () => {
    const { packageId, supplierId } = engaged();
    throwsCode(
      () => engageSupplier(as('pm'), { packageId, supplierId, supplierName: 'Again Ltd' }),
      'SUPPLIER_ENGAGEMENT_EXISTS',
    );
  });

  it('refuses Tendering before the package is issued, and permits it after', () => {
    const { packageId, engagementId, supplierId } = engaged();
    // A merely-registered firm is not prequalified, so the first move is
    // refused for the right reason and names the register as the place to fix it.
    const first = throwsCode(
      () => advanceEngagement(as('pm'), { engagementId, to: 'PREQUALIFIED' }),
      'CONTROL_STATE_UNMET',
    );
    assert.match(String(first.message), /Prequalify them there rather than moving them here/);

    // The check is a read of the platform's own records either way.
    assert.equal(entryCheck(as('pm'), { packageId, supplierId }, 'TENDERING').permitted, false);
    openPackageTender(as('pm'), { packageId, returnDeadline: '2026-10-01' });
    const after = entryCheck(as('pm'), { packageId, supplierId }, 'TENDERING');
    assert.equal(after.permitted, true);
    assert.match(after.because, /was issued to tender on 20/);
  });

  it('refuses a skipped state', () => {
    const { engagementId } = engaged();
    const error = throwsCode(
      () => advanceEngagement(as('pm'), { engagementId, to: 'CONTRACTED' }),
      'CONTROL_STATE_SKIPPED',
    );
    assert.match(String(error.message), /skipping it skips the control it carries/);
  });

  it('walks a prequalified firm from Prospect to Preferred on the platform’s own records', () => {
    appoint();
    const welfare = compose('WELFARE_ACCOMMODATION');
    const record = completePackage([welfare]);
    // A firm the seed actually prequalified, so PREQUALIFIED is a conclusion
    // rather than an assertion.
    const approved = suppliers().find((entry) => ['APPROVED', 'STRATEGIC', 'CONDITIONAL'].includes(entry.status))!;
    const engagement = engageSupplier(as('pm'), {
      packageId: record.id,
      supplierId: approved.id,
      supplierName: approved.legalName,
    });
    const prequalified = advanceEngagement(as('pm'), { engagementId: engagement.id, to: 'PREQUALIFIED' });
    assert.equal(prequalified.state, 'PREQUALIFIED');
    assert.match(prequalified.history.at(-1)!.basis, /live prequalification/);

    openPackageTender(as('pm'), { packageId: record.id, returnDeadline: '2026-10-01' });
    advanceEngagement(as('pm'), { engagementId: engagement.id, to: 'TENDERING' });

    // Preferred needs a locked return, not a good feeling about one.
    const blocked = throwsCode(
      () => advanceEngagement(as('pm'), { engagementId: engagement.id, to: 'PREFERRED' }),
      'CONTROL_STATE_UNMET',
    );
    assert.match(String(blocked.message), /No return from this firm/);

    const schedule = scheduleFor(as('pm'), procurementPosition(as('pm')).packages[0]!);
    const bid = recordBid(as('pm'), {
      packageId: record.id,
      supplierId: approved.id,
      supplierName: approved.legalName,
      basis: CLEAN_BASIS,
      lines: schedule.map((entry) => line(entry.itemId, entry.quantity, 900_00)),
    });
    const unlocked = throwsCode(
      () => advanceEngagement(as('pm'), { engagementId: engagement.id, to: 'PREFERRED' }),
      'CONTROL_STATE_UNMET',
    );
    assert.match(String(unlocked.message), /a position the bidder has not agreed/);

    lockReturn(as('pm'), { bidId: bid.id, acknowledgedBy: 'Commercial manager' });
    const preferred = advanceEngagement(as('pm'), { engagementId: engagement.id, to: 'PREFERRED' });
    assert.equal(preferred.state, 'PREFERRED');
    assert.equal(preferred.history.length, 4);
  });

  it('treats a lapsed prequalification as no prequalification', () => {
    appoint();
    const welfare = compose('WELFARE_ACCOMMODATION');
    const record = completePackage([welfare]);
    const approved = suppliers().find((entry) => ['APPROVED', 'STRATEGIC', 'CONDITIONAL'].includes(entry.status))!;
    engageSupplier(as('pm'), {
      packageId: record.id,
      supplierId: approved.id,
      supplierName: approved.legalName,
    });

    // Live today.
    assert.equal(entryCheck(as('pm'), { packageId: record.id, supplierId: approved.id }, 'PREQUALIFIED').permitted, true);

    // §7.3's evidence-expiry control, asked as at a date past the assessment.
    // A twelve-month approval that has run out is not a lapsed formality — it
    // is the point at which nobody is checking the insurance behind it.
    const lapsed = entryCheck(as('pm'), { packageId: record.id, supplierId: approved.id }, 'PREQUALIFIED', '2099-01-01');
    assert.equal(lapsed.permitted, false);
    assert.match(lapsed.because, /prequalification expired on 20/);
    assert.match(lapsed.because, /nobody is checking the insurance behind it/);

    // And the register says so too, rather than only the command.
    const view = procurementPosition(as('pm'), '2099-01-01').packages.find((entry) => entry.id === record.id)!;
    assert.match(String(view.engagements[0]!.nextBlocked), /prequalification expired/);
  });

  it('refuses Operational while any system in the package is short of G6', () => {
    const { packageId, supplierId } = engaged();
    const check = entryCheck(as('pm'), { packageId, supplierId }, 'OPERATIONAL');
    assert.equal(check.permitted, false);
    assert.match(check.because, /1 of 1 systems in this package have not reached G6/);
  });

  it('blocks new work while a supplier is suspended', () => {
    const { engagementId } = engaged();
    throwsCode(() => suspendEngagement(as('pm'), { engagementId, reason: '  ' }), 'SUPPLIER_SUSPENSION_UNREASONED');
    const suspended = suspendEngagement(as('pm'), {
      engagementId,
      reason: 'Employers’ liability cover lapsed on 2026-09-30 and has not been renewed',
    });
    assert.equal(suspended.state, 'SUSPENDED_RECOVERY');

    const error = throwsCode(
      () => advanceEngagement(as('pm'), { engagementId, to: 'PREQUALIFIED' }),
      'SUPPLIER_SUSPENDED',
    );
    assert.match(String(error.message), /New work is blocked/);
    assert.match(String(error.message), /liability cover lapsed/);

    // And suspension is idempotent: two suspensions would leave the register
    // with two reasons and no way to say which one it was suspended for.
    const again = suspendEngagement(as('pm'), { engagementId, reason: 'Something else entirely' });
    assert.equal(again.suspendedReason, suspended.suspendedReason);
  });

  it('refuses to reach suspension by advancing into it', () => {
    const { engagementId } = engaged();
    const error = throwsCode(
      () => advanceEngagement(as('pm'), { engagementId, to: 'SUSPENDED_RECOVERY' }),
      'SUPPLIER_SUSPENSION_UNREASONED',
    );
    assert.match(String(error.message), /A suspension is not an advance/);
  });

  it('shows the next state and what is blocking it, on the register', () => {
    const { packageId } = engaged();
    const view = procurementPosition(as('pm')).packages.find((entry) => entry.id === packageId)!;
    const engagement = view.engagements[0]!;
    assert.equal(engagement.state, 'PROSPECT');
    assert.equal(engagement.nextState, 'Prequalified');
    assert.match(String(engagement.nextBlocked), /not a prequalification/);
    assert.ok(engagement.controls.includes('Conflict, sanctions and duplicate checks'));
  });

  it('names the composed systems no package buys', () => {
    appoint();
    compose('WELFARE_ACCOMMODATION');
    const cleaning = compose('CLEANING_FM');
    createPackage(as('pm'), { title: 'Cleaning', systemIds: [cleaning] });
    const position = procurementPosition(as('pm'));
    assert.equal(position.unpackaged.length, 1);
    assert.match(position.unpackaged[0]!.label, /Welfare/);
  });
});
