import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { rejectsCode, throwsCode } from './helpers.ts';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import type { AIProviderAdapter, ProviderResponse } from '../src/ai/providers/types.ts';
import { EvidenceStore, hashBytes } from '../src/evidence/store.ts';
import {
  appointmentPosition,
  recordAuthorityToProceed,
  setAppointment,
} from '../src/domain/etablix/appointment.ts';
import { assumeFact, briefReadiness, recordFact } from '../src/domain/etablix/brief.ts';
import { acceptInterface, assignInterface, composeSystem, sbs } from '../src/domain/etablix/composer.ts';
import {
  approveGate,
  declareProgress,
  mobilisationPosition,
} from '../src/domain/etablix/mobilisation.ts';
import {
  advanceEngagement,
  createPackage,
  engageSupplier,
  lockReturn,
  normaliseBids,
  openPackageTender,
  procurementPosition,
  recommendAward,
  recordBid,
  scheduleFor,
  statePackageField,
  type ServiceBidLine,
  type ServicePackage,
} from '../src/domain/etablix/procurement.ts';
import {
  assessValuation,
  certifyValuation,
  openLine,
  openValuation,
  recordAcceptedProgress,
  recordApplication,
} from '../src/domain/etablix/commercial.ts';
import { changePosition, raiseChange } from '../src/domain/etablix/change.ts';
import { proposeRunDown } from '../src/domain/etablix/demobilisation.ts';
import {
  closeEvent,
  operationsPosition,
  pauseClock,
  progressEvent,
  raiseEvent,
  recordClosureEvidence,
} from '../src/domain/etablix/operations.ts';
import { commandCentre } from '../src/domain/etablix/commandcentre.ts';
import { confirm, drafts, extract } from '../src/engines/perception.ts';
import { registerEvidence, type EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * §19 — the ten acceptance scenarios, executed.
 *
 * These are not unit tests of the modules underneath. Each one is the spec's own
 * *test action* run against the real commands, asserting the spec's own *pass
 * condition*, and each is written so that a reader who has the specification
 * open can check it line for line.
 *
 * They exist because a module can pass every test it wrote for itself and still
 * fail the thing the customer bought. Three of the ten did exactly that when
 * this file was first written: the platform had no answer at all to who holds
 * the contract under each appointment, so a supplier could be moved to
 * Contracted under Advisory, and a Prime award could be placed with no customer
 * authority and no facility behind it. The gate that stops both was built
 * because these scenarios refused to pass without it.
 */

let platform: Platform;
let seed: SeedResult;

function as(who: string): EngineContext {
  return platform.context(seed.users[who]!.auth, seed.projectId);
}

const WINDOW = { fromDate: '2026-11-01', toDate: '2027-09-01', leadDays: 30 };

const FACTS: [string, number][] = [
  ['peakWorkforce', 164],
  ['shiftOverlapPersons', 120],
  ['visitorsPerDay', 22],
  ['accommodatedWorkers', 120],
  ['cleanableAreaSqm', 1800],
  ['gateThroughputPerHour', 120],
  ['travellingWorkforce', 96],
];

function appoint(model: 'ADVISORY' | 'MANAGEMENT_INTEGRATOR' | 'PRINCIPAL_SERVICE_CONTRACTOR' = 'PRINCIPAL_SERVICE_CONTRACTOR', facts = true): void {
  setAppointment(as('pm'), {
    model,
    contractingEntity: 'Meridian Infrastructure Group Ltd',
    fundingSource: 'Client capital programme',
    basis: 'Single-point accountability across all seven site-service families',
  });
  if (!facts) return;
  for (const [itemId, value] of FACTS) {
    recordFact(as('pm'), { itemId, value, source: 'Programme rev D, workforce curve sheet 3' });
  }
}

function compose(family = 'WELFARE_ACCOMMODATION', zone = 'Main compound', close = true): string {
  const { system, interfaces } = composeSystem(as('pm'), { family, zone, ...WINDOW });
  if (close) {
    for (const entry of interfaces) {
      assignInterface(as('pm'), { interfaceId: entry.id, owner: 'Ruth Adeyemi', dueDate: '2026-10-15' });
      acceptInterface(as('pm'), { interfaceId: entry.id, note: `${entry.name} agreed` });
    }
  }
  return system.id;
}

/**
 * Firms the demonstration tenancy has actually prequalified.
 *
 * Used rather than freshly registered names, so Prequalified is a conclusion
 * the platform reaches from its own register rather than an assertion this test
 * makes. A merely-registered firm is correctly refused at that state.
 */
function approvedSuppliers(): { id: string; legalName: string }[] {
  return platform.ledger
    .listByTenant(seed.users.pm!.auth.tenantId, 'Supplier')
    .map((record) => record.state as unknown as { id: string; legalName: string; status: string })
    .filter((entry) => ['APPROVED', 'STRATEGIC', 'CONDITIONAL'].includes(entry.status));
}

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

function line(itemId: string, quantity: number, rateMinor: number): ServiceBidLine {
  return { scheduleItemId: itemId, description: itemId, quantity, unit: 'unit', rateMinor };
}

/** A package taken all the way to a recommendation, so an award can be attempted. */
function recommended(): { packageId: string; supplierId: string; supplierName: string } {
  const systemId = compose();
  const pack = completePackage([systemId]);
  openPackageTender(as('pm'), { packageId: pack.id, returnDeadline: '2026-10-30' });

  // Priced against the schedule the package actually issued, so the returns
  // map cleanly and the recommendation is about price rather than about
  // mapping problems.
  const schedule = scheduleFor(as('pm'), procurementPosition(as('pm')).packages[0]!);
  const bidders = approvedSuppliers().slice(0, 3);
  assert.ok(bidders.length >= 2, 'the demonstration register holds too few prequalified firms to run a competition');
  bidders.forEach((supplier, index) => {
    const bid = recordBid(as('qs'), {
      packageId: pack.id,
      supplierId: supplier.id,
      supplierName: supplier.legalName,
      lines: schedule.map((entry) => line(entry.itemId, entry.quantity, 1_000_00 + index * 100_00)),
      basis: CLEAN_BASIS,
      technicalScore: 70,
    });
    lockReturn(as('qs'), { bidId: bid.id, acknowledgedBy: `Commercial manager, ${supplier.legalName}` });
  });

  const award = recommendAward(as('pm'), pack.id);
  if (!award.recommended) throw new Error(`fixture produced no recommendation: ${award.refusedBecause}`);
  return {
    packageId: pack.id,
    supplierId: award.recommended!.supplierId,
    supplierName: award.recommended!.supplierName,
  };
}

/** Move an engagement up to Preferred, which is the state before Contracted. */
function toPreferred(packageId: string, supplierId: string, supplierName: string): string {
  const engagement = engageSupplier(as('pm'), { packageId, supplierId, supplierName });
  for (const state of ['PREQUALIFIED', 'TENDERING', 'PREFERRED']) {
    advanceEngagement(as('pm'), { engagementId: engagement.id, to: state });
  }
  return engagement.id;
}

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
});

beforeEach(() => {
  seed.projectId = `${seed.users.pm!.auth.tenantId}-${Math.random().toString(36).slice(2, 10)}`;
});

// --- 1 ---------------------------------------------------------------------------------

describe('§19.1 conflicting workforce data', () => {
  /*
   * Upload programme peak 164 and brief headcount 100.
   *
   * Pass: the system creates a conflict, a consequence, an assumption and a
   * decision; it cannot approve capacity silently.
   */
  it('creates a conflict with both numbers in it, and cannot size capacity around it silently', () => {
    appoint('PRINCIPAL_SERVICE_CONTRACTOR', false);
    // The brief says a hundred. The programme peaks at 164 across the
    // changeover. Welfare was sized on the hundred.
    recordFact(as('pm'), { itemId: 'peakWorkforce', value: 100, source: 'Customer brief, section 4' });
    recordFact(as('pm'), { itemId: 'shiftOverlapPersons', value: 164, source: 'Programme rev D, workforce curve sheet 3' });
    recordFact(as('pm'), { itemId: 'visitorsPerDay', value: 22, source: 'Customer brief, section 4' });
    recordFact(as('pm'), { itemId: 'wcProvision', value: 6, source: 'Welfare schedule rev A' });

    const readiness = briefReadiness(as('pm'));
    const conflict = readiness.conflicts.find((entry) => entry.id === 'OVERLAP_EXCEEDS_PEAK');
    assert.ok(conflict, 'a changeover of 164 against a stated peak of 100 raises no conflict');

    // Both numbers in the statement, and a resolution that ends in a choice.
    assert.match(conflict.statement, /164/);
    assert.match(conflict.statement, /100/);
    assert.equal(conflict.severity, 'BLOCKING');

    // And the welfare sized on the smaller figure is a second, separate
    // conflict with the statutory arithmetic in it.
    const statutory = readiness.conflicts.find((entry) => entry.id === 'WELFARE_BELOW_STATUTORY');
    assert.ok(statutory, 'welfare below the statutory minimum for the concurrent occupancy raises no conflict');
    assert.match(statutory.statement, /Schedule 1/);
    assert.ok(conflict.resolution.length > 20, 'the conflict warns and does not say what to do about it');
    assert.ok(conflict.families.length >= 1);

    // The consequence: it reaches the command centre as a capacity item that
    // somebody has to decide, with the rule and the owner on it.
    const centre = commandCentre(as('pm'), 'CONTROL_TOWER', { today: '2026-10-20' });
    const surfaced = centre.now.find((entry) => entry.id === `conflict:${conflict.id}`);
    assert.ok(surfaced, 'the conflict does not reach anybody');
    assert.equal(surfaced.subject, 'CAPACITY');
    assert.ok(surfaced.action.owner.roles.length > 0);
    assert.match(surfaced.action.consequence, /expensive|silent/i);
  });

  it('records an assumption with a decision date rather than letting a provisional value become the design', () => {
    appoint('PRINCIPAL_SERVICE_CONTRACTOR', false);
    throwsCode(
      () =>
        assumeFact(as('pm'), {
          itemId: 'accommodatedWorkers',
          value: 100,
          basis: 'The brief figure, pending the workforce curve',
          decideBy: '',
          owner: 'Planning manager',
        }),
      'BRIEF_ASSUMPTION_UNDATED',
    );

    const assumed = assumeFact(as('pm'), {
      itemId: 'accommodatedWorkers',
      value: 100,
      basis: 'The brief figure, pending the workforce curve',
      decideBy: '2026-10-24',
      owner: 'Planning manager',
    });
    assert.equal(assumed.status, 'PROVISIONAL');
    assert.equal(assumed.decideBy, '2026-10-24');

    // And the decision is on somebody's list with a date against it.
    const decision = commandCentre(as('pm'), 'CONTROL_TOWER', { today: '2026-10-20' }).next.find(
      (entry) => entry.id === `provisional:${assumed.id}`,
    );
    assert.ok(decision, 'a provisional value with a decision date reaches nobody');
    assert.equal(decision.action.dueAt, '2026-10-24');
  });
});

// --- 2 ---------------------------------------------------------------------------------

describe('§19.2 Model 02 award', () => {
  /*
   * Approve the supplier recommendation under Management Integrator.
   *
   * Pass: contract/PO remains customer-owned; ETABLIX cannot create a
   * supplier-payment liability.
   */
  it('leaves the contract and the payment with the customer', () => {
    appoint('MANAGEMENT_INTEGRATOR');
    const { packageId, supplierId, supplierName } = recommended();
    const engagementId = toPreferred(packageId, supplierId, supplierName);

    const contracted = advanceEngagement(as('pm'), { engagementId, to: 'CONTRACTED' });
    assert.equal(contracted.state, 'CONTRACTED');

    // The basis recorded against the state, which is what a reader of the
    // register sees. It has to say whose contract this is.
    const basis = contracted.history.at(-1)!.basis;
    assert.match(basis, /the customer holds this contract/i);
    assert.match(basis, /ETABLIX carries no payment liability/i);
  });

  it('issues a certificate that says it is a recommendation to the customer, not ETABLIX’s debt', () => {
    appoint('MANAGEMENT_INTEGRATOR');
    const systemId = compose();
    const pack = completePackage([systemId]);
    const contract = openLine(as('qs'), {
      packageId: pack.id,
      description: 'Welfare units, weekly service',
      budgetMinor: 500_000_00,
      commitmentMinor: 480_000_00,
      currency: 'GBP',
      method: 'TIME',
      contractWeeks: 44,
      systemId,
    });
    recordAcceptedProgress(as('pm'), {
      lineId: contract.id,
      periodTo: '2026-11-30',
      accepted: 4,
      evidence: 'Weekly service sheets 1–4, countersigned by the site manager',
    });
    const valuation = openValuation(as('qs'), { periodFrom: '2026-11-01', periodTo: '2026-11-30' });
    recordApplication(as('qs'), {
      valuationId: valuation.id,
      lines: [{ lineId: contract.id, claimed: 4, narrative: 'Four weeks of the welfare service' }],
    });
    const certified = certifyValuation(as('pm'), {
      valuationId: valuation.id,
      note: 'Four weeks of the 44-week service, evidenced by the countersigned sheets',
    });

    assert.equal(certified.payer, 'CUSTOMER');
    assert.match(certified.payerBasis!, /payment recommendation to the customer/i);
    assert.match(certified.payerBasis!, /ETABLIX owes nothing/i);
  });

  it('says ETABLIX pays, under the one model where it does', () => {
    appoint('PRINCIPAL_SERVICE_CONTRACTOR');
    const systemId = compose();
    const pack = completePackage([systemId]);
    const contract = openLine(as('qs'), {
      packageId: pack.id,
      description: 'Welfare units, weekly service',
      budgetMinor: 500_000_00,
      commitmentMinor: 480_000_00,
      currency: 'GBP',
      method: 'TIME',
      contractWeeks: 44,
      systemId,
    });
    recordAcceptedProgress(as('pm'), {
      lineId: contract.id,
      periodTo: '2026-11-30',
      accepted: 4,
      evidence: 'Weekly service sheets 1–4, countersigned by the site manager',
    });
    const valuation = openValuation(as('qs'), { periodFrom: '2026-11-01', periodTo: '2026-11-30' });
    recordApplication(as('qs'), {
      valuationId: valuation.id,
      lines: [{ lineId: contract.id, claimed: 4, narrative: 'Four weeks of the welfare service' }],
    });
    const certified = certifyValuation(as('pm'), { valuationId: valuation.id, note: 'Four weeks, evidenced' });
    assert.equal(certified.payer, 'ETABLIX');
    assert.match(certified.payerBasis!, /recovering through one customer invoice/i);
  });
});

// --- 3 ---------------------------------------------------------------------------------

describe('§19.3 Model 03 award before the gate', () => {
  /*
   * Attempt an award before the customer's notice to proceed and the credit gate.
   *
   * Pass: the system blocks the commitment and shows the missing authority and
   * funding evidence.
   */
  it('blocks the commitment and names both things that are missing', () => {
    appoint('PRINCIPAL_SERVICE_CONTRACTOR');
    const { packageId, supplierId, supplierName } = recommended();
    const engagementId = toPreferred(packageId, supplierId, supplierName);

    const error = throwsCode(
      () => advanceEngagement(as('pm'), { engagementId, to: 'CONTRACTED' }),
      'CONTROL_STATE_UNMET',
    );
    assert.match(error.message!, /no customer authority to proceed is recorded/i);
    assert.match(error.message!, /no credit facility is named/i);
    assert.match(error.message!, /nobody's authority and nobody's money/i);
  });

  it('permits it once the authority and the facility are both recorded', () => {
    appoint('PRINCIPAL_SERVICE_CONTRACTOR');
    const { packageId, supplierId, supplierName } = recommended();
    const engagementId = toPreferred(packageId, supplierId, supplierName);

    recordAuthorityToProceed(as('pm'), {
      reference: 'NTP-2026-014',
      grantedBy: 'Alison Rees, Programme Director',
      grantedOn: '2026-10-18',
      creditFacilityMinor: 2_500_000_00,
    });
    const contracted = advanceEngagement(as('pm'), { engagementId, to: 'CONTRACTED' });
    assert.equal(contracted.state, 'CONTRACTED');
    assert.match(contracted.history.at(-1)!.basis, /NTP-2026-014/);
    assert.match(contracted.history.at(-1)!.basis, /Alison Rees/);

    assert.equal(appointmentPosition(as('pm')).appointment!.authority!.creditFacilityMinor, 2_500_000_00);
  });

  it('refuses an authority missing any of the four things it is made of', () => {
    appoint('PRINCIPAL_SERVICE_CONTRACTOR');
    const complete = {
      reference: 'NTP-2026-014',
      grantedBy: 'Alison Rees, Programme Director',
      grantedOn: '2026-10-18',
      creditFacilityMinor: 2_500_000_00,
    };
    const cases: [Partial<typeof complete>, RegExp][] = [
      [{ creditFacilityMinor: 0 }, /credit facility/i],
      [{ reference: '' }, /instruction reference/i],
      [{ grantedBy: '' }, /who at the customer gave it/i],
      [{ grantedOn: 'last Tuesday' }, /the date it was given/i],
    ];
    for (const [broken, expected] of cases) {
      const error = throwsCode(
        () => recordAuthorityToProceed(as('pm'), { ...complete, ...broken }),
        'AUTHORITY_INCOMPLETE',
      );
      assert.match(error.message!, expected);
      assert.match(error.message!, /instruction with no funding|money against work nobody asked for/i);
    }
  });

  it('refuses to record one under a model where the customer’s own order is the authority', () => {
    appoint('MANAGEMENT_INTEGRATOR');
    const error = throwsCode(
      () =>
        recordAuthorityToProceed(as('pm'), {
          reference: 'NTP-2026-014',
          grantedBy: 'Alison Rees, Programme Director',
          grantedOn: '2026-10-18',
          creditFacilityMinor: 2_500_000_00,
        }),
      'AUTHORITY_NOT_APPLICABLE',
    );
    assert.match(error.message!, /second answer to who authorised/i);
  });

  it('refuses a payment certificate under no appointment, because a certificate with no payer has no owner', () => {
    // The facts and the contract line exist; nothing is appointed. Certifying
    // here would put a sum on the record with nobody named against it.
    for (const [itemId, value] of FACTS) {
      recordFact(as('pm'), { itemId, value, source: 'Programme rev D' });
    }
    const systemId = compose();
    const pack = completePackage([systemId]);
    const contract = openLine(as('qs'), {
      packageId: pack.id,
      description: 'Welfare units, weekly service',
      budgetMinor: 500_000_00,
      commitmentMinor: 480_000_00,
      currency: 'GBP',
      method: 'TIME',
      contractWeeks: 44,
      systemId,
    });
    recordAcceptedProgress(as('pm'), {
      lineId: contract.id,
      periodTo: '2026-11-30',
      accepted: 4,
      evidence: 'Weekly service sheets 1–4, countersigned by the site manager',
    });
    const valuation = openValuation(as('qs'), { periodFrom: '2026-11-01', periodTo: '2026-11-30' });
    recordApplication(as('qs'), {
      valuationId: valuation.id,
      lines: [{ lineId: contract.id, claimed: 4, narrative: 'Four weeks of the welfare service' }],
    });
    const error = throwsCode(
      () => certifyValuation(as('pm'), { valuationId: valuation.id, note: 'Four weeks, evidenced' }),
      'SITE_SERVICES_NOT_APPOINTED',
    );
    assert.match(error.message!, /a liability with no owner/i);
  });

  it('refuses a contract under no appointment at all', () => {
    // The facts, the systems and the package all exist; nothing is appointed.
    for (const [itemId, value] of FACTS) {
      recordFact(as('pm'), { itemId, value, source: 'Programme rev D' });
    }
    const { packageId, supplierId, supplierName } = recommended();
    const engagementId = toPreferred(packageId, supplierId, supplierName);
    const error = throwsCode(
      () => advanceEngagement(as('pm'), { engagementId, to: 'CONTRACTED' }),
      'CONTROL_STATE_UNMET',
    );
    assert.match(error.message!, /a liability with no owner/i);
  });
});

// --- 4 ---------------------------------------------------------------------------------

describe('§19.4 mobilisation false progress', () => {
  /*
   * The supplier declares 100% but the integrated test is absent.
   *
   * Pass: the package stays blocked at the gate; no operational-ready state.
   */
  it('records the declaration, moves nothing, and holds the system short of acceptance', () => {
    appoint();
    const systemId = compose();

    const declaration = declareProgress(as('pm'), {
      systemId,
      percent: 100,
      note: 'All units set, connected and complete',
    });
    assert.equal(declaration.percent, 100);

    const before = mobilisationPosition(as('pm'), '2026-10-20').systems.find((entry) => entry.systemId === systemId)!;
    assert.equal(before.accepted, false, 'a declaration moved the system');
    assert.equal(before.atGate, 'G0', 'a declaration moved the gate');

    // And the panel shows the claim beside the record rather than instead of it.
    const centre = commandCentre(as('pm'), 'CONTROL_TOWER', { today: '2026-10-20' });
    const gate = centre.now.find((entry) => entry.id === `gate:${systemId}`)!;
    assert.match(gate.action.consequence, /declaration is recorded and moves nothing/i);
    assert.match(gate.action.consequence, /no operational-ready state/i);
  });

  it('refuses the gate whose integrated test has not been attested', () => {
    appoint();
    const systemId = compose();
    declareProgress(as('pm'), { systemId, percent: 100, note: 'Complete' });

    // G0 is passable on its own evidence. The gates that follow are not, and
    // the one carrying the integrated test refuses on the evidence itself.
    // Approved by somebody who actually holds G5 — the safety lead — so the
    // refusal is about the missing test rather than about the wrong person.
    const error = throwsCode(
      () => approveGate(as('safety'), { systemId, gate: 'G5', note: 'Supplier says done' }),
      'MOBILISATION_GATE_BLOCKED',
    );
    assert.ok(error.message!.length > 40, 'the refusal does not say what is missing');
  });
});

// --- 5 ---------------------------------------------------------------------------------

describe('§19.5 unsupported valuation', () => {
  /*
   * The supplier claims full monthly service with a missing roster and a failed
   * KPI.
   *
   * Pass: the agent recommends the evidenced value, flags the gap and
   * calculates a transparent adjustment.
   */
  it('assesses to what the evidence supports, and names the exception rather than netting it off', () => {
    appoint();
    const systemId = compose();
    const pack = completePackage([systemId]);
    const contract = openLine(as('qs'), {
      packageId: pack.id,
      description: 'Welfare units, weekly service',
      budgetMinor: 500_000_00,
      commitmentMinor: 440_000_00,
      currency: 'GBP',
      method: 'TIME',
      contractWeeks: 44,
      systemId,
    });
    // Four weeks evidenced of the forty-four.
    recordAcceptedProgress(as('pm'), {
      lineId: contract.id,
      periodTo: '2026-11-30',
      accepted: 4,
      evidence: 'Weekly service sheets 1–4, countersigned by the site manager',
    });

    const valuation = openValuation(as('qs'), { periodFrom: '2026-11-01', periodTo: '2026-11-30' });
    // The claim: the whole contract sum for the month.
    recordApplication(as('qs'), {
      valuationId: valuation.id,
      lines: [{ lineId: contract.id, claimed: 44, narrative: 'The whole 44-week service, claimed this period' }],
    });

    const assessment = assessValuation(as('qs'), valuation.id);

    // The evidenced value, the flagged gap and the arithmetic behind the
    // adjustment — §19.5's three pass conditions.
    assert.ok(assessment.netMinor < 440_000_00, 'a full claim on four weeks of evidence was assessed at face');
    const overclaim = assessment.exceptions.find((entry) => entry.kind === 'OVERCLAIM');
    assert.ok(overclaim, 'the overclaim is not raised as an exception');
    assert.ok(overclaim.statement.length > 30, 'the exception does not show its arithmetic');
    assert.notEqual(overclaim.effectMinor, 0, 'the exception carries no value, so it never survives the meeting');

    // And the certificate is refused while the claim stands, naming the line.
    // An invoice is not proof of value, and certifying around an uncorrected
    // claim leaves both figures on the record with nothing saying which is the
    // agreed one.
    const blocked = throwsCode(
      () => certifyValuation(as('pm'), { valuationId: valuation.id, note: 'Certified at the evidenced value' }),
      'VALUATION_NOT_CERTIFIABLE',
    );
    assert.match(blocked.message!, /more than the accepted evidence supports/);
    assert.match(blocked.message!, /An invoice is not proof of value/);

    // Corrected to what the sheets support, it certifies at that figure.
    recordApplication(as('qs'), {
      valuationId: valuation.id,
      lines: [{ lineId: contract.id, claimed: 4, narrative: 'Four weeks, corrected against the countersigned sheets' }],
    });
    const corrected = assessValuation(as('qs'), valuation.id);
    assert.equal(corrected.certifiable, true);
    const certified = certifyValuation(as('pm'), {
      valuationId: valuation.id,
      note: 'Certified at four weeks of the 44-week service, which is what the sheets support',
    });
    assert.equal(certified.certifiedMinor, corrected.netMinor);
    assert.ok(certified.certifiedMinor! < 440_000_00);
  });
});

// --- 6 ---------------------------------------------------------------------------------

describe('§19.6 scope drift', () => {
  /*
   * The workforce increases and additional cabins are requested by email.
   *
   * Pass: the agent identifies the baseline delta, the capacity impact, the
   * change and notice need, and the unapproved exposure.
   */
  it('shows the delta against the frozen basis, and carries the exposure on the forecast before anything is priced', () => {
    appoint();
    const systemId = compose();

    // The frozen basis was composed against a changeover of 120. The programme
    // now says 190, and the welfare on the ground is sized for the old figure.
    recordFact(as('pm'), { itemId: 'peakWorkforce', value: 210, source: 'Programme rev E, issued by email' });
    recordFact(as('pm'), { itemId: 'shiftOverlapPersons', value: 190, source: 'Programme rev E, issued by email' });

    const drift = sbs(as('pm'), '2026-10-20').systems.find((entry) => entry.id === systemId)!.drift;
    assert.ok(drift.length > 0, 'the live brief moving past the frozen basis produces no drift');
    assert.ok(drift[0]!.consequence.length > 20, 'the drift says nothing about what it costs');

    // A request by email is a change, and it is on the forecast the day it is
    // raised whether or not anybody has priced it.
    const change = raiseChange(as('pm'), {
      trigger: 'DEMAND_VARIANCE',
      summary: 'Four additional welfare cabins for the increased workforce',
      difference: 'The baseline welfare schedule is sized for 164; the revised programme peaks at 210 and needs four more cabins.',
      entitlement: 'ARGUABLE',
      probabilityPercent: 70,
      valueMinor: 88_000_00,
    });
    const position = changePosition(as('pm'), '2026-10-20');
    assert.equal(position.agreedMinor, 0, 'nothing has been agreed');
    assert.equal(position.exposureMinor, 61_600_00, '70% of £88,000 is what the forecast carries');
    assert.equal(position.exposureAtFaceMinor, 88_000_00);
    assert.match(position.goldenRule, /forecast-neutral/);

    // And it reaches the commercial workspace as funding that needs a decision.
    const surfaced = commandCentre(as('pm'), 'COMMERCIAL', { today: '2026-10-20' }).next.find(
      (entry) => entry.id === `change:${change.id}`,
    );
    assert.ok(surfaced, 'an unpriced change reaches nobody');
    assert.equal(surfaced.need, 'FUNDING');
  });
});

// --- 7 ---------------------------------------------------------------------------------

describe('§19.7 critical failure', () => {
  /*
   * The main welfare water supply is lost.
   *
   * Pass: P1 command flow, a temporary supply plan, clocks, notifications and an
   * immutable timeline.
   */
  it('runs the P1 flow, refuses closure without the temporary control, and leaves a timeline nobody can edit', () => {
    appoint();
    const systemId = compose();

    const event = raiseEvent(as('pm'), {
      systemId,
      defectType: 'WELFARE_UNAVAILABLE',
      severity: 'P1',
      summary: 'Main welfare water supply lost at the compound',
      source: 'Site manager, by radio',
    });

    // The clock: P1's window is zero, so it is late from the moment it exists.
    const hourLater = new Date(Date.parse(event.raisedAt) + 60 * 60_000).toISOString();
    const late = operationsPosition(as('pm'), hourLater).events.find((entry) => entry.id === event.id)!;
    assert.equal(late.acknowledgementBreached, true, 'a P1 unacknowledged for an hour is not late');
    assert.ok(late.blocking.includes('no temporary control recorded'));

    // The temporary supply plan is a condition of closure, not a nicety.
    progressEvent(as('pm'), { eventId: event.id, to: 'ACKNOWLEDGED' });
    throwsCode(() => closeEvent(as('pm'), { eventId: event.id, note: 'Supply back on' }), 'SERVICE_CONTROL_ABSENT');

    progressEvent(as('pm'), { eventId: event.id, to: 'ATTENDED' });
    progressEvent(as('pm'), {
      eventId: event.id,
      to: 'TEMPORARILY_RESTORED',
      note: 'Bowser and 40 litres per person per day to the compound, refilled twice daily',
    });
    for (const kind of ['PHOTO', 'USER_CONFIRMATION']) {
      recordClosureEvidence(as('pm'), { eventId: event.id, kind, reference: `EV-${kind}` });
    }
    const closed = closeEvent(as('pm'), { eventId: event.id, note: 'Mains repaired and pressure proved' });
    assert.equal(closed.status, 'CLOSED');
    assert.equal(closed.temporaryControl!.includes('Bowser'), true);

    // The timeline: every step is on the chain, and the chain is append-only.
    const chain = platform.ledger.eventsForEntity({ refType: 'ServiceEvent', refId: event.id });
    assert.ok(chain.length >= 5, 'the P1 flow left fewer records than it had steps');
    assert.deepEqual(
      chain.map((entry) => entry.eventType),
      [
        'SERVICE_EVENT_RAISED',
        // Acknowledged, attended, temporarily restored: the three steps between
        // the radio call and the bowser arriving.
        'SERVICE_EVENT_PROGRESSED',
        'SERVICE_EVENT_PROGRESSED',
        'SERVICE_EVENT_PROGRESSED',
        'SERVICE_EVIDENCE_RECORDED',
        'SERVICE_EVIDENCE_RECORDED',
        'SERVICE_EVENT_CLOSED',
      ],
    );
  });

  it('will not pause a P1 clock, because the one clock that must not stop is the one somebody wants to stop', () => {
    appoint();
    const event = raiseEvent(as('pm'), {
      systemId: compose(),
      defectType: 'WELFARE_UNAVAILABLE',
      severity: 'P1',
      summary: 'Main welfare water supply lost',
      source: 'Site manager, by radio',
    });
    throwsCode(
      () =>
        pauseClock(as('pm'), {
          eventId: event.id,
          reason: 'Waiting for the water board',
          approvedBy: 'Alison Rees, Programme Director',
        }),
      'SERVICE_CLOCK_UNPAUSABLE',
    );
  });
});

// --- 8 ---------------------------------------------------------------------------------

describe('§19.8 demobilisation against a live dependency', () => {
  /*
   * Cabin off-hire is requested while an adjacent phase still relies on its fire
   * alarm.
   *
   * Pass: the dependency blocks removal until the successor interface is
   * accepted.
   */
  it('reports the premature removal against the interface that depends on it', () => {
    appoint();
    // Two systems in two zones, the second arriving after the first leaves.
    const leaving = composeSystem(as('pm'), {
      family: 'WELFARE_ACCOMMODATION',
      zone: 'Main compound',
      fromDate: '2026-11-01',
      toDate: '2027-03-01',
      leadDays: 30,
    });
    const successor = composeSystem(as('pm'), {
      family: 'WELFARE_ACCOMMODATION',
      zone: 'North compound',
      fromDate: '2027-04-01',
      toDate: '2027-09-01',
      leadDays: 30,
    });
    assert.ok(successor.system.id);

    const exceptions = sbs(as('pm'), '2027-02-01').deployment;
    const premature = exceptions.find((entry) => entry.kind === 'PREMATURE_REMOVAL' || entry.kind === 'LEAD_TIME_MISSED');
    assert.ok(premature, 'a system leaving before its successor arrives raises no deployment exception');
    assert.ok(premature.resolution.length > 20, 'the exception says nothing about what to do');

    // And it is on the panel as a constraint, not buried in a report.
    const centre = commandCentre(as('pm'), 'CONTROL_TOWER', { today: '2027-02-01' });
    const surfaced = centre.now.find((entry) => entry.id.startsWith(`deployment:${leaving.system.id}`) || entry.id.startsWith('deployment:'));
    assert.ok(surfaced, 'the deployment clash reaches nobody');
    assert.equal(surfaced.subject, 'CONSTRAINT');
  });

  it('refuses a run-down that would take welfare below the statutory minimum', () => {
    appoint();
    const systemId = compose();
    const error = throwsCode(
      () =>
        proposeRunDown(as('pm'), {
          systemId,
          remainingPersons: 40,
          remainingWcs: 1,
          effectiveFrom: '2027-05-01',
          basis: 'The compound is finishing and the units are wanted back',
        }),
      'RUNDOWN_BELOW_STATUTORY',
    );
    assert.match(error.message!, /40/);
    assert.match(error.message!, /Schedule 1/i);
  });
});

// --- 9 ---------------------------------------------------------------------------------

describe('§19.9 tenant privacy', () => {
  /*
   * An agent tries to use a named supplier rate from another customer.
   *
   * Pass: access denied; only an approved anonymised benchmark range may be
   * used.
   */
  it('refuses a bid belonging to another tenancy, and refuses it as absent rather than as forbidden', () => {
    appoint();
    const { packageId } = recommended();
    const ourBid = platform.ledger.list(seed.projectId, 'ServiceBid')[0]!;
    assert.ok(ourBid, 'the fixture recorded no bid');

    const other = platform.createTenant({
      legalName: 'Somebody Else Contracting Ltd',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'BUSINESS',
      enterpriseName: 'Somebody Else Contracting',
    });
    platform.setModuleGrant({
      moduleId: 'ETABLIX',
      tenantId: other.tenant.id,
      status: 'ACTIVE',
      reason: 'Also an ETABLIX customer',
      decidedBy: seed.users.operator!.id,
    });
    const stranger = platform.createUser({
      tenantId: other.tenant.id,
      name: 'Their commercial manager',
      email: `commercial-${Math.random().toString(36).slice(2, 8)}@somebodyelse.example`,
      roles: ['QS'],
    });
    const theirs = platform.context(
      { ...seed.users.qs!.auth, actorId: stranger.id, tenantId: other.tenant.id, roles: ['QS'] },
      `${other.tenant.id}-governance`,
    );

    // Their normalisation of our package: not "their competitor charges X", but
    // no such package at all. The distinction is itself information about what
    // another contractor is buying.
    throwsCode(() => normaliseBids(theirs, packageId), 'SERVICE_PACKAGE_NOT_FOUND');

    // And their whole procurement position is empty rather than showing ours.
    assert.deepEqual(procurementPosition(theirs).packages, [], 'another tenancy can see our packages');
  });

  it('keeps a named rate inside the project that produced it, even for the tenancy that owns both', () => {
    appoint();
    recommended();
    const ours = platform.ledger.list(seed.projectId, 'ServiceBid').length;
    assert.ok(ours > 0);

    // A sibling project in the same tenancy sees none of it. A rate is a
    // supplier's price on one job, not a figure the next job inherits.
    const sibling = platform.context(seed.users.qs!.auth, `${seed.users.qs!.auth.tenantId}-sibling`);
    assert.equal(platform.ledger.list(sibling.projectId, 'ServiceBid').length, 0);
  });
});

// --- 10 --------------------------------------------------------------------------------

describe('§19.10 agent uncertainty', () => {
  /*
   * A drawing extraction comes back below the confidence threshold.
   *
   * Pass: the output enters the exception queue with its source and a proposed
   * reviewer; the baseline is unchanged.
   *
   * Run against the real path. `SITE_SERVICES_BRIEF` in `engines/perception.ts`
   * reads a workforce curve into a draft; the draft carries its provider, its
   * confidence and the words each figure was read from; it changes nothing
   * until a person confirms it, and what it changes then goes through
   * `recordFact` — the same command as typing the figure in — with the
   * document, the model and the confirmer all on the source. A deployment with
   * no provider that can see a file is refused before anything is charged.
   */
  const CURVE = Buffer.from('PDF-ish bytes standing in for a workforce curve', 'utf8');
  const CURVE_HASH = hashBytes(CURVE);
  const READING = {
    facts: [
      { itemId: 'peakWorkforce', value: 164, quoted: 'Peak on site 164 (wk 22)', page: 3 },
      { itemId: 'shiftOverlapPersons', value: 120, quoted: 'Shift overlap 120 persons 06:30–07:30', page: 3 },
      { itemId: 'notAnItem', value: 9, quoted: 'Something the catalogue does not know', page: 4 },
    ],
    omitted: ['visitorsPerDay — the curve does not count visitors'],
  };
  let directory = '';
  let store: EvidenceStore;

  /** A provider that can be handed a file, answering at the confidence given. */
  function seeing(confidence: number): AIProviderAdapter {
    return {
      name: 'GEMINI',
      capability: 'PERCEPTION',
      multimodal: true,
      transmits: true,
      estimateCostMinor: () => 40,
      healthy: () => true,
      async execute(): Promise<ProviderResponse> {
        return { provider: 'GEMINI', modelClass: 'perception-standard', output: READING, rawCostMinor: 40, latencyMs: 8, confidence };
      },
    };
  }

  async function rebuild(adapter?: AIProviderAdapter): Promise<void> {
    platform = new Platform(adapter ? new AIOrchestrator({ perception: adapter }) : undefined, store);
    seed = await seedDemoProject(platform);
    platform.setModuleGrant({
      moduleId: 'ETABLIX',
      tenantId: seed.users.pm!.auth.tenantId,
      status: 'ACTIVE',
      reason: 'Appointed as ETABLIX site-services delivery partner',
      decidedBy: seed.users.operator!.id,
    });
    appoint('PRINCIPAL_SERVICE_CONTRACTOR', false);
    registerEvidence(as('pm'), { type: 'SITE_SERVICES_BRIEF_DOCUMENT', hash: CURVE_HASH, description: 'Programme rev D, workforce curve sheet 3' });
    store.put(seed.tenantId, CURVE_HASH, CURVE, 'application/pdf');
  }

  before(() => {
    directory = mkdtempSync(join(tmpdir(), 'construx-etablix-brief-'));
    store = new EvidenceStore(directory);
  });
  after(() => rmSync(directory, { recursive: true, force: true }));

  it('refuses to read the curve on a deployment whose provider cannot see a file, and charges nothing', async () => {
    await rebuild();
    const wallet = platform.wallet(seed.tenantId).snapshot();
    await rejectsCode(() => extract(as('pm'), store, { hash: CURVE_HASH, task: 'SITE_SERVICES_BRIEF' }), 'PERCEPTION_PROVIDER_UNAVAILABLE');
    assert.equal(platform.wallet(seed.tenantId).snapshot().balanceMinor, wallet.balanceMinor);
    assert.equal(briefReadiness(as('pm')).facts.length, 0, 'the baseline moved on a refusal');
  });

  it('holds a low-confidence reading as a draft with its source and provider, and the baseline is unchanged', async () => {
    await rebuild(seeing(0.42));
    const read = await extract(as('pm'), store, { hash: CURVE_HASH, task: 'SITE_SERVICES_BRIEF' });
    const held = drafts(as('pm')).find((entry) => entry.id === read.draftId)!;
    assert.equal(held.status, 'DRAFT');
    assert.equal(held.confidence, 0.42);
    assert.equal(held.evidenceHash, CURVE_HASH, 'the draft names the exact bytes it was read from');
    assert.equal(held.aiProvenance?.provider, 'GEMINI');
    assert.equal(held.aiProvenance?.synthetic, false);
    assert.equal(briefReadiness(as('pm')).facts.length, 0, 'a draft reached the register');

    // The exception queue: it is on the list of somebody entitled to decide it.
    assert.ok(drafts(as('pm')).some((entry) => entry.status === 'DRAFT' && entry.task === 'SITE_SERVICES_BRIEF'));

    // And once a person confirms it, the reading goes through the same command
    // as typing it in, with the document, the model and the confirmer on the
    // source. One test rather than two because the suite's `beforeEach` moves
    // every test onto a fresh project, and the draft belongs to this one.
    const pending = drafts(as('pm')).find((entry) => entry.status === 'DRAFT')!;
    const confirmed = await confirm(as('pm'), { draftId: pending.id });
    const result = confirmed.result as { recorded: number; facts: { itemId: string }[]; omitted: string[] };
    assert.equal(result.recorded, 2, 'the item the catalogue does not know was dropped, not invented');
    assert.deepEqual(result.facts.map((fact) => fact.itemId).sort(), ['peakWorkforce', 'shiftOverlapPersons']);
    assert.deepEqual(result.omitted, READING.omitted);

    const facts = briefReadiness(as('pm')).facts;
    const peak = facts.find((fact) => fact.itemId === 'peakWorkforce')!;
    assert.equal(peak.value, 164);
    assert.equal(peak.status, 'KNOWN');
    assert.match(peak.source, /Programme rev D, workforce curve sheet 3/);
    assert.match(peak.source, /page 3/);
    assert.match(peak.source, /read by GEMINI/);
    assert.match(peak.source, new RegExp(`confirmed by ${seed.users.pm!.id}`));
    assert.match(peak.source, /"Peak on site 164 \(wk 22\)"/);
    for (const fact of facts) {
      assert.ok(fact.source.trim().length > 0, `${fact.itemId} reached the register with no stated source`);
    }
    assert.equal(drafts(as('pm')).find((entry) => entry.id === pending.id)!.status, 'CONFIRMED');
  });

  it('refuses the reading to a tenancy that does not hold the module, and to a reader who may not record a fact', async () => {
    await rebuild(seeing(0.9));
    // An enterprise admin reads the brief and records nothing in it.
    await rejectsCode(() => extract(as('admin'), store, { hash: CURVE_HASH, task: 'SITE_SERVICES_BRIEF' }), 'ACCESS_DENIED');
    platform.setModuleGrant({
      moduleId: 'ETABLIX',
      tenantId: seed.users.pm!.auth.tenantId,
      status: 'REVOKED',
      reason: 'Engagement ended at the close of the pilot',
      decidedBy: seed.users.operator!.id,
    });
    await assert.rejects(() => extract(as('pm'), store, { hash: CURVE_HASH, task: 'SITE_SERVICES_BRIEF' }));
    // Restored, because the tests after this one run on the same tenancy.
    platform.setModuleGrant({
      moduleId: 'ETABLIX',
      tenantId: seed.users.pm!.auth.tenantId,
      status: 'ACTIVE',
      reason: 'Re-engaged for the next scenario',
      decidedBy: seed.users.operator!.id,
    });
  });

  it('keeps a provisional value visible as provisional rather than letting it settle into the baseline', () => {
    // The nearest thing the module *does* have to §19.10's exception queue: a
    // value nobody has confirmed carries its basis, its owner and the date after
    // which it is too late to change, and it is on somebody's list until then.
    appoint('PRINCIPAL_SERVICE_CONTRACTOR', false);
    const assumed = assumeFact(as('pm'), {
      itemId: 'connectedLoadKva',
      value: 380,
      basis: 'Read off an unissued single-line diagram; not a confirmed load schedule',
      decideBy: '2026-10-24',
      owner: 'Temporary works designer',
    });
    assert.equal(assumed.status, 'PROVISIONAL');
    assert.equal(assumed.owner, 'Temporary works designer');
    assert.ok(assumed.basis!.length > 20, 'a provisional value with no basis is an invention with a date on it');

    const queued = commandCentre(as('pm'), 'CONTROL_TOWER', { today: '2026-10-20' }).next.find(
      (entry) => entry.id === `provisional:${assumed.id}`,
    );
    assert.ok(queued, 'a provisional value reaches nobody');
    assert.match(queued.why.evidence, /unissued single-line diagram/);
    assert.equal(queued.action.dueAt, '2026-10-24');
  });
});
