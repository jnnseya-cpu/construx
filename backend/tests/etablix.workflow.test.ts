import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { STAGES, workflowPosition, type StageView } from '../src/domain/etablix/workflow.ts';
import {
  assessModelFit,
  baselineAgreed,
  recordAuthorityToProceed,
  setAppointment,
} from '../src/domain/etablix/appointment.ts';
import { assumeFact, BRIEF_ITEMS, recordFact } from '../src/domain/etablix/brief.ts';
import { acceptInterface, assignInterface, composeSystem } from '../src/domain/etablix/composer.ts';
import {
  GATES,
  approveGate,
  attestEvidence,
  evidenceFor,
  type GateId,
} from '../src/domain/etablix/mobilisation.ts';
import { raiseEvent, recordPeriod } from '../src/domain/etablix/operations.ts';
import {
  advanceEngagement,
  createPackage,
  engageSupplier,
  lockReturn,
  openPackageTender,
  procurementPosition,
  recommendAward,
  recordBid,
  scheduleFor,
  statePackageField,
} from '../src/domain/etablix/procurement.ts';
import {
  acceptWorkstream,
  agreeRemovalPlan,
  openWorkstream,
  proposeRunDown,
  recordDemobEvidence,
  WORKSTREAMS,
} from '../src/domain/etablix/demobilisation.ts';
import type { Role } from '../src/identity/roles.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { authOf, seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * §6 — the nine-stage workflow engine.
 *
 * One property carries the whole module: **a gate is derived, never set.** There
 * is no command to move a stage and no stage field on any record, so the only
 * way through §6 is to make the underlying records true. The tests below are
 * mostly about that: each one makes a record true and asserts the gate moves,
 * or leaves it false and asserts the gate says precisely what is missing.
 *
 * The second property is the three-valued answer. Satisfied, outstanding, and
 * *not derivable* — because stage 8's exit is a knowledge library that does not
 * exist, and reporting that as outstanding would tell somebody they have work to
 * do rather than telling them the platform cannot answer.
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

function appoint(): void {
  setAppointment(as('pm'), {
    model: 'PRINCIPAL_SERVICE_CONTRACTOR',
    contractingEntity: 'Meridian Infrastructure Group Ltd',
    fundingSource: 'Client capital programme',
    basis: 'Single-point accountability across all seven site-service families',
  });
}

function facts(): void {
  for (const [itemId, value] of FACTS) {
    recordFact(as('pm'), { itemId, value, source: 'Programme rev D, workforce curve sheet 3' });
  }
}

const ASSUMPTION = {
  basis: 'Assumed pending the customer’s answer',
  decideBy: '2026-10-24',
  owner: 'Planning manager',
};

/** A usable value for an item whatever it is measured in. */
function assumedValue(item: (typeof BRIEF_ITEMS)[number]): { value: number | string } {
  if (item.unit === 'date') return { value: '2026-11-01' };
  if (item.unit === 'standard') return { value: 'To the pre-works condition survey' };
  return { value: 100 };
}

function stage(position: ReturnType<typeof workflowPosition>, id: string): StageView {
  return position.stages.find((entry) => entry.id === id)!;
}

/** Which role actually holds each gate. Kept as §8 declares them. */
const APPROVER: Record<GateId, string> = {
  G0: 'commercial',
  G1: 'designer',
  G2: 'qaqc',
  G3: 'constructionManager',
  G4: 'qaqc',
  G5: 'safety',
  G6: 'fm',
};

/** Attest every attestable item on one gate for one system. */
function satisfy(systemId: string, gate: GateId, family: 'WELFARE_ACCOMMODATION' | 'TEMPORARY_MEP'): void {
  const definition = GATES.find((entry) => entry.id === gate)!;
  for (const item of evidenceFor(definition, family)) {
    if (item.kind === 'DERIVED') continue;
    attestEvidence(as('pm'), {
      systemId,
      gate,
      itemId: item.id,
      reference: `REF-${gate}-${item.id}`,
      ...(item.expiryRequired ? { expiresAt: '2099-01-01' } : {}),
    });
  }
}

/**
 * A system walked all the way to mobilisation acceptance.
 *
 * Written out rather than shortcut, because §6's Mobilise and Operate gates are
 * about exactly this sequence and a fixture that jumped to the end would prove
 * the gate against a state the platform cannot actually reach.
 */
function toG6(systemId: string, family: 'WELFARE_ACCOMMODATION' | 'TEMPORARY_MEP'): void {
  for (const gate of GATES) {
    satisfy(systemId, gate.id, family);
    approveGate(as(APPROVER[gate.id]), { systemId, gate: gate.id, note: `${gate.id} evidence complete` });
  }
}

const EXTRA_ROLES: [string, Role, string, string][] = [
  ['commercial', 'COMMERCIAL_MANAGER', 'Aisha Rahimi', 'commercial-wf@meridian.example'],
];

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  for (const [key, role, name, email] of EXTRA_ROLES) {
    const user = platform.createUser({ tenantId: seed.users.pm!.auth.tenantId, name, email, roles: [role] });
    seed.users[key] = { id: user.id, auth: authOf(platform, user.id) };
  }
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

describe('§6 the nine stages', () => {
  it('is nine, in order, each with its work and the record its exit produces', () => {
    assert.equal(STAGES.length, 9);
    assert.deepEqual(
      STAGES.map((entry) => entry.order),
      [0, 1, 2, 3, 4, 5, 6, 7, 8],
    );
    for (const entry of STAGES) {
      assert.ok(entry.work.length > 30, `${entry.id} does not say what work happens in it`);
      assert.ok(entry.authoritativeRecord.length > 20, `${entry.id} names no authoritative record`);
    }
    // Change and recover is the only concurrent one. A second would mean the
    // furthest-stage calculation was skipping two things.
    assert.deepEqual(
      STAGES.filter((entry) => entry.concurrent).map((entry) => entry.id),
      ['CHANGE_RECOVER'],
    );
  });

  it('has no way to set a stage: the module writes nothing at all', () => {
    // The property the whole design rests on, asserted against the source
    // rather than trusted. A `write` here would be a command to declare a stage
    // reached, which is the failure §6 exists to prevent.
    const source = fs.readFileSync(
      path.join(import.meta.dirname, '..', 'src', 'domain', 'etablix', 'workflow.ts'),
      'utf8',
    );
    assert.equal(/\bwrite\(/.test(source), false, 'the workflow engine writes to the ledger');
    assert.equal(/eventType:/.test(source), false, 'the workflow engine emits an event');
  });

  it('reports nothing entered on an empty project, and says which gate is first', () => {
    const position = workflowPosition(as('pm'), '2026-10-20');
    assert.equal(position.at, undefined);
    assert.equal(stage(position, 'OPPORTUNITY').entered, false);
    assert.match(position.statement, /Nothing has been entered/);
    assert.match(position.statement, /model-fit assessment/);
  });

  it('enters Opportunity on a model-fit assessment, before anything is appointed', () => {
    assessModelFit(as('pm'), {
      contractingEntity: 'Meridian Infrastructure Group Ltd',
      fundingSource: 'Client capital programme',
      scores: {
        customerDeliveryCapacity: 2,
        programmeUrgency: 2,
        packageCount: 2,
        customerProcurementMaturity: 2,
        etablixCreditStrength: 2,
        supplierCreditTerms: 2,
        contractRiskTransfer: 2,
        geographicSupplyDepth: 2,
        operationalComplexity: 2,
        singlePointAccountability: 2,
      },
      evidence: {
        advisoryOutputs: 'Requirement schedules, package strategy and an award paper',
        procurementOwner: 'The customer’s own commercial team',
        handoverDate: '2026-12-01',
        postAwardResponsibilities: 'The customer runs the operation from award; ETABLIX has no operational duty',
      },
    });
    const position = workflowPosition(as('pm'), '2026-10-20');
    assert.equal(position.at, 'OPPORTUNITY');
    assert.equal(stage(position, 'OPPORTUNITY').entered, true);
    assert.equal(stage(position, 'OPPORTUNITY').complete, false, 'an assessment is not an appointment');
    assert.match(stage(position, 'OPPORTUNITY').exit[0]!.detail, /No appointment is in force/);
  });

  it('completes Opportunity and enters Discover on the appointment', () => {
    appoint();
    const position = workflowPosition(as('pm'), '2026-10-20');
    assert.equal(stage(position, 'OPPORTUNITY').complete, true);
    assert.equal(stage(position, 'DISCOVER').entered, true);
    assert.equal(position.at, 'DISCOVER');
    assert.match(stage(position, 'OPPORTUNITY').exit[0]!.detail, /^Principal, on the basis:/);
  });

  it('holds Discover open while a brief item is neither known nor owned, and names the items', () => {
    appoint();
    facts();
    const position = workflowPosition(as('pm'), '2026-10-20');
    const exit = stage(position, 'DISCOVER').exit[0]!;
    assert.equal(exit.outcome, 'OUTSTANDING');
    assert.match(exit.detail, /neither known nor owned/);
    // Named, not counted. A gate that says "12 outstanding" tells whoever reads
    // it nothing about what to do next.
    assert.match(exit.detail, /[a-z]+[A-Z][a-zA-Z]*/, 'the outstanding items are not named');
  });

  it('closes Discover once every remaining gap is a provisional value with an owner', () => {
    appoint();
    facts();
    // Everything not answered by the facts above gets an owner and a date, which
    // is what "data gaps named rather than absent" means.
    const known = new Set(FACTS.map(([itemId]) => itemId));
    for (const item of BRIEF_ITEMS) {
      if (known.has(item.id)) continue;
      assumeFact(as('pm'), { itemId: item.id, ...assumedValue(item), ...ASSUMPTION });
    }
    const position = workflowPosition(as('pm'), '2026-10-20');
    const exit = stage(position, 'DISCOVER').exit[0]!;
    assert.equal(exit.outcome, 'SATISFIED', exit.detail);
    assert.match(exit.detail, /every remaining gap carries an owner/);
  });

  it('does not close Discover on a brief that is entirely assumption', () => {
    // Every item provisional, every one owned and dated — and nothing known.
    // That is a complete list of questions, not a problem statement, and a
    // gate that passed it would let a baseline be built on nobody's answer.
    appoint();
    for (const item of BRIEF_ITEMS) {
      assumeFact(as('pm'), { itemId: item.id, ...assumedValue(item), ...ASSUMPTION });
    }
    const exit = stage(workflowPosition(as('pm'), '2026-10-20'), 'DISCOVER').exit[0]!;
    assert.equal(exit.outcome, 'OUTSTANDING');
    assert.match(exit.detail, /No brief fact has been recorded at all/);
  });

  it('refuses Define while the demand engine cannot derive a figure, and names the missing inputs', () => {
    appoint();
    const position = workflowPosition(as('pm'), '2026-10-20');
    const entry = stage(position, 'DEFINE').entry[0]!;
    assert.equal(entry.outcome, 'OUTSTANDING');
    assert.match(entry.detail, /cannot be derived/);
    assert.match(entry.detail, /missing/);
  });

  it('enters Define once every derivation resolves', () => {
    appoint();
    for (const item of BRIEF_ITEMS) {
      assumeFact(as('pm'), { itemId: item.id, ...assumedValue(item), ...ASSUMPTION });
    }
    const position = workflowPosition(as('pm'), '2026-10-20');
    assert.equal(stage(position, 'DEFINE').entry[0]!.outcome, 'SATISFIED');
    assert.equal(position.at, 'DEFINE');
  });

  it('will not close Define on a baseline alone: the architecture has to exist and its interfaces be owned', () => {
    appoint();
    facts();
    baselineAgreed(as('pm'));

    const bare = workflowPosition(as('pm'), '2026-10-20');
    assert.equal(stage(bare, 'DEFINE').exit[0]!.outcome, 'SATISFIED', 'the baseline is agreed');
    assert.equal(stage(bare, 'DEFINE').exit[1]!.outcome, 'OUTSTANDING');
    assert.match(stage(bare, 'DEFINE').exit[1]!.detail, /Nothing is composed/);

    // Composed, but nobody named on the other side of the interfaces.
    const { interfaces } = composeSystem(as('pm'), { family: 'WELFARE_ACCOMMODATION', zone: 'Main compound', ...WINDOW });
    const unowned = workflowPosition(as('pm'), '2026-10-20');
    assert.equal(stage(unowned, 'DEFINE').exit[1]!.outcome, 'OUTSTANDING');
    assert.match(stage(unowned, 'DEFINE').exit[1]!.detail, /no counterparty named/);

    for (const entry of interfaces) {
      assignInterface(as('pm'), { interfaceId: entry.id, owner: 'Ruth Adeyemi', dueDate: '2026-10-15' });
      acceptInterface(as('pm'), { interfaceId: entry.id, note: `${entry.name} agreed` });
    }
    const closed = workflowPosition(as('pm'), '2026-10-20');
    assert.equal(stage(closed, 'DEFINE').exit[1]!.outcome, 'SATISFIED');
    assert.equal(stage(closed, 'DEFINE').complete, true);
  });

  it('refuses Procure while a composed system no package buys, and names it', () => {
    appoint();
    facts();
    baselineAgreed(as('pm'));
    composeSystem(as('pm'), { family: 'WELFARE_ACCOMMODATION', zone: 'Main compound', ...WINDOW });

    const entry = stage(workflowPosition(as('pm'), '2026-10-20'), 'PROCURE').entry[0]!;
    assert.equal(entry.outcome, 'OUTSTANDING');
    assert.match(entry.detail, /no package buys/);
    assert.match(entry.detail, /Welfare and accommodation/);
  });

  it('does not let a later gate carry a project past an earlier one that has not passed', () => {
    // Demobilise's entry is satisfied vacuously on a project with nothing
    // composed — there is nothing to remove. That must not report the project as
    // being at Demobilise, because the records that stage is about were never
    // built.
    appoint();
    const position = workflowPosition(as('pm'), '2026-10-20');
    assert.equal(position.at, 'DISCOVER');
    assert.equal(stage(position, 'DEMOBILISE').entered, false, 'the fixture no longer proves what it was written for');
  });

  it('runs Change alongside whatever stage the project is at, rather than instead of it', () => {
    appoint();
    facts();
    baselineAgreed(as('pm'));
    const { system, interfaces } = composeSystem(as('pm'), {
      family: 'WELFARE_ACCOMMODATION',
      zone: 'Main compound',
      ...WINDOW,
    });
    for (const entry of interfaces) {
      assignInterface(as('pm'), { interfaceId: entry.id, owner: 'Ruth Adeyemi', dueDate: '2026-10-15' });
      acceptInterface(as('pm'), { interfaceId: entry.id, note: `${entry.name} agreed` });
    }
    // Read before the event. Change may already be running — a system whose
    // lead time is nearly gone is itself a variance — so what is asserted is
    // that the stage the project is *at* does not move, which is the property.
    const at = workflowPosition(as('pm'), '2026-10-20').at;
    assert.notEqual(at, 'CHANGE_RECOVER', 'the concurrent stage was reported as the stage the project is at');

    raiseEvent(as('pm'), {
      systemId: system.id,
      defectType: 'WELFARE_UNAVAILABLE',
      severity: 'P1',
      summary: 'Main welfare water supply lost',
      source: 'Site manager, by radio',
    });
    const after = workflowPosition(as('pm'), '2026-10-20');
    assert.equal(after.changeRunning, true, 'an open P1 does not enter Change and recover');
    assert.equal(after.at, at, 'a live change moved the project out of the stage it was in');
    assert.match(after.statement, /running alongside/);
  });
});

describe('§6 walked end to end', () => {
  /**
   * One fixture that makes the records true all the way through, because the
   * later gates cannot be tested any other way: a project shortcut to a state
   * the platform cannot reach would prove the gate against a fiction.
   */
  /**
   * Welfare and the temporary MEP that supplies it, both in the same zone.
   *
   * Two rather than one, because G3 derives "utilities available at the
   * boundary" from a composed MEP system in the same zone — a welfare compound
   * on its own cannot pass it, which is correct and is exactly the kind of
   * thing a fixture that shortcut the gates would have hidden.
   */
  function composed(): { welfare: string; mep: string } {
    appoint();
    facts();
    baselineAgreed(as('pm'));
    const made: Record<string, string> = {};
    for (const [key, family] of [
      ['mep', 'TEMPORARY_MEP'],
      ['welfare', 'WELFARE_ACCOMMODATION'],
    ] as const) {
      const { system, interfaces } = composeSystem(as('pm'), { family, zone: 'Main compound', ...WINDOW });
      for (const entry of interfaces) {
        assignInterface(as('pm'), { interfaceId: entry.id, owner: 'Ruth Adeyemi', dueDate: '2026-10-15' });
        acceptInterface(as('pm'), { interfaceId: entry.id, note: `${entry.name} agreed` });
      }
      made[key] = system.id;
    }
    return { welfare: made.welfare!, mep: made.mep! };
  }

  /**
   * Every brief item answered, so the demand engine can derive everything and
   * Define's entry gate passes. Recorded facts where they matter to the
   * derivations; provisional with an owner and a date everywhere else, which is
   * what §3 asks of a gap.
   */
  function answerTheBrief(): void {
    const known = new Set(FACTS.map(([itemId]) => itemId));
    for (const item of BRIEF_ITEMS) {
      if (known.has(item.id)) continue;
      assumeFact(as('pm'), { itemId: item.id, ...assumedValue(item), ...ASSUMPTION });
    }
  }

  /** One package buying both systems, every field stated, contracted to a firm. */
  function contract(systems: { welfare: string; mep: string }): void {
    const created = createPackage(as('pm'), {
      title: 'Compound welfare and temporary MEP',
      systemIds: [systems.mep, systems.welfare],
    });
    const fields: Record<string, string> = {
      scope: 'In: supply, delivery, install, service and removal of the welfare units and the temporary MEP that supplies them. Out: the compound platform and its drainage.',
      drawings: 'WEL-100 rev C compound layout; MEP-300 rev A distribution',
      kpis: 'Availability 99% of shift hours; hot water to every shower at shift change',
      evidence: 'Weekly service sheets, water temperature log, PAT records, generator run hours',
      acceptance: 'All units set, connected, tested and handed over with the O&M file and the training record',
      pricingMethod: 'Schedule of rates, remeasurable on the workforce curve',
      changeMechanism: 'Instructed change valued at the schedule rates; anything outside them agreed before instruction',
    };
    for (const [field, value] of Object.entries(fields)) {
      statePackageField(as('pm'), { packageId: created.id, field, value });
    }
    openPackageTender(as('pm'), { packageId: created.id, returnDeadline: '2026-10-30' });

    const schedule = scheduleFor(as('pm'), procurementPosition(as('pm')).packages[0]!);
    const bidders = platform.ledger
      .listByTenant(seed.users.pm!.auth.tenantId, 'Supplier')
      .map((record) => record.state as unknown as { id: string; legalName: string; status: string })
      .filter((entry) => ['APPROVED', 'STRATEGIC', 'CONDITIONAL'].includes(entry.status))
      .slice(0, 3);
    bidders.forEach((supplier, index) => {
      const bid = recordBid(as('qs'), {
        packageId: created.id,
        supplierId: supplier.id,
        supplierName: supplier.legalName,
        lines: schedule.map((entry) => ({
          scheduleItemId: entry.itemId,
          description: entry.itemId,
          quantity: entry.quantity,
          unit: 'unit',
          rateMinor: 1_000_00 + index * 100_00,
        })),
        basis: {
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
        },
        technicalScore: 70,
      });
      lockReturn(as('qs'), { bidId: bid.id, acknowledgedBy: `Commercial manager, ${supplier.legalName}` });
    });

    const award = recommendAward(as('pm'), created.id);
    recordAuthorityToProceed(as('pm'), {
      reference: 'NTP-2026-014',
      grantedBy: 'Alison Rees, Programme Director',
      grantedOn: '2026-10-18',
      creditFacilityMinor: 2_500_000_00,
    });
    const engagement = engageSupplier(as('pm'), {
      packageId: created.id,
      supplierId: award.recommended!.supplierId,
      supplierName: award.recommended!.supplierName,
    });
    for (const state of ['PREQUALIFIED', 'TENDERING', 'PREFERRED', 'CONTRACTED']) {
      advanceEngagement(as('pm'), { engagementId: engagement.id, to: state });
    }
  }

  /**
   * The whole job: brief answered, systems composed, package let, both systems
   * accepted. Written out because §6's later gates cannot be tested any other
   * way, and a project shortcut to this state would prove them against a
   * fiction.
   */
  function accepted(): { welfare: string; mep: string } {
    const systems = composed();
    answerTheBrief();
    contract(systems);
    toG6(systems.mep, 'TEMPORARY_MEP');
    toG6(systems.welfare, 'WELFARE_ACCOMMODATION');
    return systems;
  }

  it('holds Mobilise open until every system is accepted, and names the gate each is at', () => {
    const systems = composed();
    const before = stage(workflowPosition(as('pm'), '2026-10-20'), 'MOBILISE');
    assert.equal(before.exit[0]!.outcome, 'OUTSTANDING');
    assert.match(before.exit[0]!.detail, /0 of 2 accepted/);
    assert.match(before.exit[0]!.detail, /at G0/);

    // One of the two. Still outstanding, and the detail names which.
    toG6(systems.mep, 'TEMPORARY_MEP');
    const half = stage(workflowPosition(as('pm'), '2026-10-20'), 'MOBILISE');
    assert.equal(half.exit[0]!.outcome, 'OUTSTANDING');
    assert.match(half.exit[0]!.detail, /1 of 2 accepted/);
    assert.match(half.exit[0]!.detail, /Welfare and accommodation/);

    toG6(systems.welfare, 'WELFARE_ACCOMMODATION');
    const after = stage(workflowPosition(as('pm'), '2026-10-20'), 'MOBILISE');
    assert.equal(after.exit[0]!.outcome, 'SATISFIED');
    assert.match(after.exit[0]!.detail, /All 2 systems accepted/);
  });

  it('enters Operate on acceptance, and holds its exit until a period is measured', () => {
    assert.equal(stage(workflowPosition(as('pm'), '2026-10-20'), 'OPERATE').entered, false);

    const systems = accepted();
    const systemId = systems.welfare;
    const entered = workflowPosition(as('pm'), '2026-10-20');
    assert.equal(stage(entered, 'OPERATE').entered, true);
    assert.equal(entered.at, 'OPERATE');
    const measured = stage(entered, 'OPERATE').exit.find((gate) => gate.id === 'serviceAccepted')!;
    assert.equal(measured.outcome, 'OUTSTANDING');
    assert.match(measured.detail, /No service period has been recorded/);

    recordPeriod(as('pm'), {
      systemId,
      from: '2026-11-01',
      to: '2026-11-30',
      requiredMinutes: 20_160,
      availableMinutes: 20_160,
    });
    const after = stage(workflowPosition(as('pm'), '2026-12-01'), 'OPERATE');
    assert.equal(after.exit.find((gate) => gate.id === 'serviceAccepted')!.outcome, 'SATISFIED');
    // The commercial half is still open: a measured month is not a closed one.
    assert.equal(after.exit.find((gate) => gate.id === 'commercialAccepted')!.outcome, 'OUTSTANDING');
    assert.equal(after.complete, false);
  });

  it('never reports the concurrent stage as the stage the project is at, even at Operate', () => {
    // The one arrangement where the concurrency rule is load-bearing: every
    // sequential gate up to Operate has passed, and a change is running. A
    // project with three live changes has not left Operate.
    const systems = accepted();
    raiseEvent(as('pm'), {
      systemId: systems.welfare,
      defectType: 'WELFARE_UNAVAILABLE',
      severity: 'P1',
      summary: 'Main welfare water supply lost',
      source: 'Site manager, by radio',
    });
    const position = workflowPosition(as('pm'), '2026-10-20');
    assert.equal(stage(position, 'CHANGE_RECOVER').entered, true);
    assert.equal(position.changeRunning, true);
    assert.equal(position.at, 'OPERATE', 'the concurrent stage was reported as where the project is');
  });

  it('holds Demobilise until every system has a removal plan, then until every workstream is accepted', () => {
    const systems = composed();
    const systemId = systems.welfare;
    const bare = stage(workflowPosition(as('pm'), '2026-10-20'), 'DEMOBILISE');
    assert.equal(bare.entry[0]!.outcome, 'OUTSTANDING');
    assert.match(bare.entry[0]!.detail, /2 of 2 systems have no removal plan/);
    // Singular reads correctly too. A gate a person stops trusting because it
    // says "1 system have" is a gate that stops being read.
    assert.match(
      stage(workflowPosition(as('pm'), '2026-10-20'), 'CHANGE_RECOVER').entry[0]!.detail,
      /^\d+ open events?, \d+ deployment exceptions?, \d+ drift records?/,
    );

    for (const id of [systems.mep, systems.welfare]) {
      agreeRemovalPlan(as('pm'), {
        systemId: id,
        owner: 'Northern Site Services Ltd',
        method: 'Cabins craned out, slab broken to 300mm and carted',
        trigger: 'Successor welfare accepted at the north compound',
        costMinor: 18_000_00,
        wasteRoute: 'Licensed inert transfer station, Bradford',
        reinstatementCriterion: 'Topsoil to 300mm against the pre-works ground survey',
      });
    }
    const planned = stage(workflowPosition(as('pm'), '2026-10-20'), 'DEMOBILISE');
    assert.equal(planned.entry[0]!.outcome, 'SATISFIED');
    assert.equal(planned.entered, true);
    assert.equal(planned.exit[0]!.outcome, 'OUTSTANDING');
    assert.match(planned.exit[0]!.detail, /No workstream has been opened/);

    // The demand run-down cannot be accepted with no run-down behind it, which
    // is §12's first refusal and is not being worked around here.
    proposeRunDown(as('pm'), {
      systemId,
      remainingPersons: 12,
      remainingWcs: 3,
      effectiveFrom: '2027-05-01',
      basis: 'The compound winds down to a maintenance team of twelve',
    });
    for (const stream of WORKSTREAMS) {
      const record = openWorkstream(as('pm'), { workstream: stream.id, systemId });
      recordDemobEvidence(as('pm'), {
        recordId: record.id,
        reference: `DEMOB-${stream.id}`,
        description: `Evidence against ${stream.acceptance}`,
      });
      acceptWorkstream(as('pm'), { recordId: record.id, note: 'Accepted against the stated criterion' });
    }
    const closed = stage(workflowPosition(as('pm'), '2026-10-20'), 'DEMOBILISE');
    assert.equal(closed.exit[0]!.outcome, 'SATISFIED');
    assert.match(closed.exit[0]!.detail, /Every opened workstream is accepted/);
  });

  it('does not let a stage entered out of order carry the project forward', () => {
    // Demobilise's entry passes here — every composed system has a removal plan
    // — while Procure has not been entered at all, because nothing is packaged.
    // The project is at Define, not at Demobilise.
    const systems = composed();
    answerTheBrief();
    for (const id of [systems.mep, systems.welfare]) {
      agreeRemovalPlan(as('pm'), {
        systemId: id,
        owner: 'Northern Site Services Ltd',
        method: 'Cabins craned out, slab broken to 300mm and carted',
        trigger: 'Successor welfare accepted at the north compound',
        costMinor: 18_000_00,
        wasteRoute: 'Licensed inert transfer station, Bradford',
        reinstatementCriterion: 'Topsoil to 300mm against the pre-works ground survey',
      });
    }
    const position = workflowPosition(as('pm'), '2026-10-20');
    assert.equal(stage(position, 'DEMOBILISE').entered, true, 'the fixture no longer proves what it was written for');
    assert.equal(stage(position, 'PROCURE').entered, false);
    assert.equal(position.at, 'DEFINE');
  });
});

describe('§6 what a gate is allowed to say', () => {
  it('reports the knowledge library as not derivable rather than as outstanding', () => {
    appoint();
    const learn = stage(workflowPosition(as('pm'), '2026-10-20'), 'LEARN');
    assert.equal(learn.exit[0]!.outcome, 'NOT_DERIVABLE');
    assert.match(learn.exit[0]!.detail, /Not built/);
    assert.match(learn.exit[0]!.detail, /no site-services supplier score is written back/);
    assert.match(learn.exit[0]!.detail, /the one stage of the nine with no authoritative record behind it/);
  });

  it('is the only gate in the nine that cannot be answered at all', () => {
    appoint();
    const undecidable = workflowPosition(as('pm'), '2026-10-20').stages.flatMap((entry) =>
      [...entry.entry, ...entry.exit].filter((gate) => gate.outcome === 'NOT_DERIVABLE').map((gate) => gate.id),
    );
    assert.deepEqual(undecidable, ['knowledgePromoted']);
  });

  it('gives every condition a reason it exists that is not a restatement of the label', () => {
    appoint();
    for (const entry of workflowPosition(as('pm'), '2026-10-20').stages) {
      for (const gate of [...entry.entry, ...entry.exit]) {
        assert.ok(gate.matters.length > 60, `${gate.id} does not say what failure it prevents`);
        assert.ok(gate.detail.length > 15, `${gate.id} does not say what was read`);
        assert.notEqual(gate.matters, gate.label);
      }
    }
  });

  it('does not report a stage complete to a reader who cannot see one of its gates', () => {
    // The site manager can see the service period and not the certificate. A
    // stage reported complete to them would be the platform telling somebody
    // the month is closed on the strength of a gate they are not allowed to
    // read — which is worse than telling them they cannot read it.
    appoint();
    facts();
    baselineAgreed(as('pm'));
    const { system, interfaces } = composeSystem(as('pm'), {
      family: 'WELFARE_ACCOMMODATION',
      zone: 'Main compound',
      ...WINDOW,
    });
    for (const entry of interfaces) {
      assignInterface(as('pm'), { interfaceId: entry.id, owner: 'Ruth Adeyemi', dueDate: '2026-10-15' });
      acceptInterface(as('pm'), { interfaceId: entry.id, note: `${entry.name} agreed` });
    }
    recordPeriod(as('pm'), {
      systemId: system.id,
      from: '2026-11-01',
      to: '2026-11-30',
      requiredMinutes: 20_160,
      availableMinutes: 20_160,
    });

    const operate = stage(workflowPosition(as('siteManager'), '2026-12-01'), 'OPERATE');
    assert.equal(operate.exit.find((gate) => gate.id === 'serviceAccepted')!.outcome, 'SATISFIED');
    assert.equal(operate.exit.find((gate) => gate.id === 'commercialAccepted')!.outcome, 'NOT_DERIVABLE');
    assert.equal(operate.complete, false, 'a withheld gate was counted as passed');
  });

  it('withholds the two commercial gates from a reader without commercial standing, rather than passing them', () => {
    appoint();
    const site = workflowPosition(as('siteManager'), '2026-10-20');
    const commercial = stage(site, 'OPERATE').exit.find((gate) => gate.id === 'commercialAccepted')!;
    assert.equal(commercial.outcome, 'NOT_DERIVABLE');
    assert.match(commercial.detail, /Withheld/);

    const change = stage(site, 'CHANGE_RECOVER').exit[0]!;
    assert.equal(change.outcome, 'NOT_DERIVABLE');
    assert.match(change.detail, /Withheld/);

    // And a reader who does hold it gets a real answer to both.
    const qs = workflowPosition(as('qs'), '2026-10-20');
    assert.notEqual(stage(qs, 'OPERATE').exit.find((gate) => gate.id === 'commercialAccepted')!.outcome, 'NOT_DERIVABLE');
    assert.notEqual(stage(qs, 'CHANGE_RECOVER').exit[0]!.outcome, 'NOT_DERIVABLE');
  });
});

describe('the module gate', () => {
  it('refuses the workflow to a tenancy that does not hold ETABLIX', () => {
    const ungranted = platform.createTenant({
      legalName: 'No Module Contracting Ltd',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'BUSINESS',
      enterpriseName: 'No Module Contracting',
    });
    const user = platform.createUser({
      tenantId: ungranted.tenant.id,
      name: 'Their project manager',
      email: `pm-${Math.random().toString(36).slice(2, 8)}@nomodule.example`,
      roles: ['PM'],
    });
    const ctx = platform.context(
      { ...seed.users.pm!.auth, actorId: user.id, tenantId: ungranted.tenant.id, roles: ['PM'] },
      `${ungranted.tenant.id}-governance`,
    );
    throwsCode(() => workflowPosition(ctx), 'MODULE_NOT_GRANTED');
  });
});
