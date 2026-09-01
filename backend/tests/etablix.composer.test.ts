import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import {
  FAMILY_DESIGN,
  acceptInterface,
  factsFor,
  assignInterface,
  composeSystem,
  recomposeSystem,
  recordObservation,
  sbs,
} from '../src/domain/etablix/composer.ts';
import { SERVICE_FAMILIES } from '../src/domain/etablix/brief.ts';
import { assumeFact, recordFact } from '../src/domain/etablix/brief.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * §4 — the Site-Service System Composer.
 *
 * Composing freezes a **design basis**: the derivations as they stood the day
 * the compound was ordered. The brief keeps moving afterwards, and the question
 * that decides whether an order is still right — *what has changed since we
 * sized this* — is the one a platform showing only today's numbers cannot
 * answer.
 *
 * The other half is the interface matrix. §4 names, per family, the interfaces
 * that are non-negotiable, and composing raises one record for each — **open
 * and unowned**, because an interface nobody has taken is precisely the gap
 * that turns up on site, and it has to be visible as a gap rather than absent.
 */

let platform: Platform;
let seed: SeedResult;

function granted(who = 'pm'): EngineContext {
  return platform.context(seed.users[who]!.auth, seed.projectId);
}

function ungranted(): EngineContext {
  return { ...granted(), grantedModules: [] };
}

/** Enough of a brief that welfare and MEP can both be composed. */
function seedBrief(): void {
  const ctx = granted();
  const facts: [string, number][] = [
    ['peakWorkforce', 164],
    ['shiftOverlapPersons', 120],
    ['visitorsPerDay', 22],
    ['peakDurationDays', 45],
    ['plannedGrowthPercent', 10],
    ['connectedLoadKva', 900],
    ['foulTankCapacityM3', 20],
    ['accommodatedWorkers', 120],
    ['cleanableAreaSqm', 1800],
    ['travellingWorkforce', 96],
    ['gateThroughputPerHour', 120],
  ];
  for (const [itemId, value] of facts) {
    recordFact(ctx, { itemId, value, source: 'Programme rev D and the welfare layout' });
  }
}

const WINDOW = { fromDate: '2026-11-01', toDate: '2027-09-01', leadDays: 30 };

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

describe('what §4 says each family produces', () => {
  it('gives every family its outputs, its non-negotiable interfaces and a removal obligation', () => {
    for (const family of Object.keys(SERVICE_FAMILIES) as (keyof typeof SERVICE_FAMILIES)[]) {
      const design = FAMILY_DESIGN[family];
      assert.ok(design.outputs.length >= 5, `${family} produces almost nothing`);
      assert.ok(design.interfaces.length >= 6, `${family} has too few non-negotiable interfaces`);
      // The removal obligation exists from the moment the system is designed,
      // not from the moment somebody wants it gone. §12 begins at design.
      assert.ok(design.removal.length > 60, `${family} has no removal obligation`);
    }
  });
});

describe('composing a system', () => {
  it('freezes the design basis and raises the interface matrix', () => {
    seedBrief();
    const { system, interfaces } = composeSystem(granted(), {
      family: 'WELFARE_ACCOMMODATION',
      zone: 'Main compound',
      ...WINDOW,
    });

    assert.equal(system.version, 1);
    assert.equal(system.zone, 'Main compound');
    // The basis is the derivations, not a number. Every one carries its formula.
    assert.ok(system.basis.length >= 3);
    for (const derivation of system.basis) assert.ok(derivation.formula.length > 10);
    assert.ok(system.basis.some((derivation) => derivation.id === 'sanitaryProvision'));

    // The removal obligation travels with it from day one.
    assert.match(system.removalObligation, /statutory minimum/);

    // Every non-negotiable interface, open and unowned.
    assert.equal(interfaces.length, FAMILY_DESIGN.WELFARE_ACCOMMODATION.interfaces.length);
    assert.ok(interfaces.every((entry) => entry.status === 'OPEN' && entry.owner === undefined));
    // And each says what happens if it is never closed, at creation rather than
    // at failure — a matrix of names with no consequences is a table people tick.
    for (const entry of interfaces) assert.ok(entry.consequence.length > 30, `${entry.name} has no consequence`);
  });

  it('says what a brief cannot supply, and which section fills it', () => {
    // The alternative is an empty field, and "assets: none" and "assets: not
    // built yet" are opposite statements.
    seedBrief();
    const { system } = composeSystem(granted(), { family: 'WELFARE_ACCOMMODATION', zone: 'Main compound', ...WINDOW });
    const fields = system.awaiting.map((entry) => entry.field);
    assert.deepEqual(fields.sort(), ['Assets', 'Cost', 'KPIs', 'Operating tasks', 'Supplier package']);
    for (const entry of system.awaiting) assert.match(entry.from, /§\d+/);
  });

  it('refuses to compose against a basis that does not exist', () => {
    // A system composed against nothing asserts a design basis that is not
    // there, and it then sits in the SBS looking exactly like one that is.
    const error = throwsCode(
      () => composeSystem(granted(), { family: 'WELFARE_ACCOMMODATION', zone: 'Main compound', ...WINDOW }),
      'SERVICE_BASIS_ABSENT',
    );
    assert.match(String(error.message), /shiftOverlapPersons or peakWorkforce/);
  });

  it('composes a family that is sized on nothing numeric', () => {
    // Enabling civils and procurement have no derivations — their work is
    // scope and sequence rather than capacity. They still compose, because the
    // interfaces are the point for those two.
    const { interfaces } = composeSystem(granted(), { family: 'ENABLING_CIVILS', zone: 'North platform', ...WINDOW });
    assert.ok(interfaces.some((entry) => entry.name === 'Buried services'));
  });

  it('refuses a zone-less system', () => {
    seedBrief();
    throwsCode(
      () => composeSystem(granted(), { family: 'WELFARE_ACCOMMODATION', zone: '  ', ...WINDOW }),
      'SERVICE_ZONE_REQUIRED',
    );
  });

  it('refuses a window that ends before it starts', () => {
    seedBrief();
    throwsCode(
      () =>
        composeSystem(granted(), {
          family: 'WELFARE_ACCOMMODATION',
          zone: 'Main compound',
          fromDate: '2027-09-01',
          toDate: '2026-11-01',
          leadDays: 30,
        }),
      'SERVICE_WINDOW_INVALID',
    );
  });

  it('allows the same family in two zones and refuses it twice in one', () => {
    // Capacity is zone-specific. Two compounds are two systems with two demand
    // bases, and merging them hides the one that is short.
    seedBrief();
    composeSystem(granted(), { family: 'WELFARE_ACCOMMODATION', zone: 'Main compound', ...WINDOW });
    assert.doesNotThrow(() =>
      composeSystem(granted(), { family: 'WELFARE_ACCOMMODATION', zone: 'North satellite', ...WINDOW }),
    );
    throwsCode(
      () => composeSystem(granted(), { family: 'WELFARE_ACCOMMODATION', zone: 'Main compound', ...WINDOW }),
      'SERVICE_SYSTEM_EXISTS',
    );
  });

  it('refuses a family nobody defined', () => {
    throwsCode(
      () => composeSystem(granted(), { family: 'CATERING', zone: 'Main compound', ...WINDOW }),
      'SERVICE_FAMILY_UNKNOWN',
    );
  });

  it('is refused to a tenancy without the module', () => {
    throwsCode(
      () => composeSystem(ungranted(), { family: 'ENABLING_CIVILS', zone: 'North platform', ...WINDOW }),
      'MODULE_NOT_GRANTED',
    );
    throwsCode(() => sbs(ungranted()), 'MODULE_NOT_GRANTED');
  });
});

describe('what reaches the demand engine', () => {
  it('passes only numbers', () => {
    // A date or a standard is a fact and is not an input to arithmetic. Letting
    // one through would not throw — it would make every comparison against it
    // quietly false, which is the worst shape a defect can have in a
    // calculation engine.
    recordFact(granted(), { itemId: 'peakWorkforce', value: 164, source: 'Programme rev D' });
    recordFact(granted(), {
      itemId: 'reinstatementStandard',
      value: 'Return to the pre-existing condition',
      source: 'Lease schedule 4',
    });
    recordFact(granted(), { itemId: 'firstMobilisationDate', value: '2026-11-02', source: 'Programme rev D' });

    const facts = factsFor(granted());
    assert.equal(facts.peakWorkforce?.value, 164);
    assert.equal(facts.reinstatementStandard, undefined, 'a text fact reached the demand engine');
    assert.equal(facts.firstMobilisationDate, undefined, 'a date reached the demand engine');
    for (const held of Object.values(facts)) assert.equal(typeof held?.value, 'number');
  });

  it('passes the figure in force and not the one it replaced', () => {
    recordFact(granted(), { itemId: 'peakWorkforce', value: 100, source: 'Employer’s Requirements rev A' });
    recordFact(granted(), { itemId: 'peakWorkforce', value: 164, source: 'Programme rev D' });

    const facts = factsFor(granted());
    assert.equal(facts.peakWorkforce?.value, 164);
    // Exactly one entry survives — a superseded record must not appear at all,
    // whatever order the ledger returns them in.
    assert.equal(
      granted().ledger.list(seed.projectId, 'SiteServiceFact').length,
      2,
      'the superseded record was not kept on the ledger',
    );
  });

  it('carries whether a figure was settled or assumed', () => {
    // A capacity built on a provisional figure is not the same thing as one
    // built on a settled one, and the derivation has to be able to say which.
    assumeFact(granted(), {
      itemId: 'peakWorkforce',
      value: 164,
      basis: 'Resource histogram, pending the client’s confirmation',
      decideBy: '2026-10-01',
      owner: 'Ruth Adeyemi',
    });
    assert.equal(factsFor(granted()).peakWorkforce?.status, 'PROVISIONAL');
  });
});

describe('the drift between the basis and the brief', () => {
  it('reports what has moved since the system was sized', () => {
    seedBrief();
    composeSystem(granted(), { family: 'WELFARE_ACCOMMODATION', zone: 'Main compound', ...WINDOW });

    // The workforce grows after the compound is ordered — the ordinary case.
    recordFact(granted(), { itemId: 'shiftOverlapPersons', value: 180, source: 'Shift plan rev C' });

    const position = sbs(granted());
    const system = position.systems[0]!;
    const drift = system.drift.find((entry) => entry.derivationId === 'sanitaryProvision')!;
    assert.ok(drift, 'the WC provision did not move when the occupancy did');
    // 142 concurrent needed 7; 202 needs 10.
    assert.equal(drift.composedAt, 7);
    assert.equal(drift.now, 10);
    assert.ok(drift.changePercent > 0);
    assert.match(drift.consequence, /Whatever was ordered against the frozen basis is short/);
  });

  it('says a fall in demand is not a reason to reduce anything', () => {
    seedBrief();
    composeSystem(granted(), { family: 'WELFARE_ACCOMMODATION', zone: 'Main compound', ...WINDOW });
    recordFact(granted(), { itemId: 'shiftOverlapPersons', value: 40, source: 'Shift plan rev C' });

    const drift = sbs(granted()).systems[0]!.drift.find((entry) => entry.derivationId === 'sanitaryProvision')!;
    assert.ok(drift.changePercent < 0);
    assert.match(drift.consequence, /not a reason to reduce anything without change control/);
  });

  it('reports no drift while the brief has not moved', () => {
    seedBrief();
    composeSystem(granted(), { family: 'WELFARE_ACCOMMODATION', zone: 'Main compound', ...WINDOW });
    assert.deepEqual(sbs(granted()).systems[0]!.drift, []);
  });

  it('clears the drift when the system is recomposed, and keeps the version it was ordered against', () => {
    seedBrief();
    const { system } = composeSystem(granted(), { family: 'WELFARE_ACCOMMODATION', zone: 'Main compound', ...WINDOW });
    recordFact(granted(), { itemId: 'shiftOverlapPersons', value: 180, source: 'Shift plan rev C' });
    assert.ok(sbs(granted()).systems[0]!.drift.length > 0);

    const recomposed = recomposeSystem(granted(), {
      systemId: system.id,
      reason: 'Shift plan rev C adds a third gang to the night shift',
    });
    assert.equal(recomposed.version, 2);
    assert.deepEqual(sbs(granted()).systems[0]!.drift, []);

    // The version it was ordered against is still on the chain.
    const events = platform.ledger
      .events({ projectId: seed.projectId })
      .filter((event) => event.eventType === 'SERVICE_SYSTEM_RECOMPOSED');
    assert.equal(events.length, 1);
  });

  it('refuses a recompose with no stated reason', () => {
    seedBrief();
    const { system } = composeSystem(granted(), { family: 'WELFARE_ACCOMMODATION', zone: 'Main compound', ...WINDOW });
    throwsCode(
      () => recomposeSystem(granted(), { systemId: system.id, reason: '  ' }),
      'SERVICE_RECOMPOSE_UNREASONED',
    );
  });
});

describe('the interface matrix', () => {
  function firstInterface(): string {
    seedBrief();
    const { interfaces } = composeSystem(granted(), {
      family: 'WELFARE_ACCOMMODATION',
      zone: 'Main compound',
      ...WINDOW,
    });
    return interfaces[0]!.id;
  }

  it('takes an interface with a person and a date together', () => {
    const id = firstInterface();
    const taken = assignInterface(granted(), {
      interfaceId: id,
      owner: 'Ruth Adeyemi',
      dueDate: '2026-10-15',
      counterparty: 'Programme team',
    });
    assert.equal(taken.owner, 'Ruth Adeyemi');
    assert.equal(taken.status, 'OPEN', 'taking an interface is not closing it');
  });

  it('refuses an interface with an owner and no date, or a date and no owner', () => {
    // Either alone is unmanageable: an owner with no date cannot be late, and a
    // date with no owner is nobody's.
    const id = firstInterface();
    throwsCode(
      () => assignInterface(granted(), { interfaceId: id, owner: 'Ruth Adeyemi', dueDate: 'soon' }),
      'SERVICE_INTERFACE_UNDATED',
    );
    throwsCode(
      () => assignInterface(granted(), { interfaceId: id, owner: '   ', dueDate: '2026-10-15' }),
      'SERVICE_INTERFACE_UNOWNED',
    );
  });

  it('refuses to accept an interface nobody took', () => {
    const id = firstInterface();
    throwsCode(
      () => acceptInterface(granted(), { interfaceId: id, note: 'Fine' }),
      'SERVICE_INTERFACE_UNOWNED',
    );
  });

  it('refuses an acceptance that proves nothing', () => {
    const id = firstInterface();
    assignInterface(granted(), { interfaceId: id, owner: 'Ruth Adeyemi', dueDate: '2026-10-15' });
    throwsCode(
      () => acceptInterface(granted(), { interfaceId: id, note: '' }),
      'SERVICE_INTERFACE_UNEVIDENCED',
    );
  });

  it('closes it, and will not let it be quietly reassigned afterwards', () => {
    const id = firstInterface();
    assignInterface(granted(), { interfaceId: id, owner: 'Ruth Adeyemi', dueDate: '2026-10-15' });
    const accepted = acceptInterface(granted(), {
      interfaceId: id,
      note: 'Workforce curve rev D issued and signed off at the 14 October interface meeting',
    });
    assert.equal(accepted.status, 'ACCEPTED');
    assert.ok(accepted.acceptedBy);
    throwsCode(
      () => assignInterface(granted(), { interfaceId: id, owner: 'Somebody else', dueDate: '2026-11-01' }),
      'SERVICE_INTERFACE_ACCEPTED',
    );
  });

  it('rolls the matrix up by interface name across every system', () => {
    // "Who owns ground bearing on this job" is asked once, not once per zone.
    seedBrief();
    composeSystem(granted(), { family: 'TEMPORARY_INFRASTRUCTURE', zone: 'Main compound', ...WINDOW });
    composeSystem(granted(), { family: 'TEMPORARY_INFRASTRUCTURE', zone: 'North satellite', ...WINDOW });

    const ground = sbs(granted()).interfaceMatrix.find((entry) => entry.name === 'Ground bearing')!;
    assert.equal(ground.open, 2);
    assert.equal(ground.unowned, 2);
    assert.equal(ground.accepted, 0);
  });
});

describe('the SBS read back', () => {
  it('names the families nobody has composed', () => {
    // Absent is not the same as complete. A family with no system is a gap.
    seedBrief();
    composeSystem(granted(), { family: 'WELFARE_ACCOMMODATION', zone: 'Main compound', ...WINDOW });
    const position = sbs(granted());
    assert.equal(position.systems.length, 1);
    assert.equal(position.uncomposed.length, Object.keys(SERVICE_FAMILIES).length - 1);
    assert.ok(position.uncomposed.every((entry) => entry.scope.length > 30));
  });

  it('carries the live demand engine whether or not anything is composed', () => {
    seedBrief();
    const position = sbs(granted());
    assert.equal(position.systems.length, 0);
    assert.ok(position.demand.derivations.length > 0, 'the demand position is only shown once something is composed');
  });

  it('finds a service coming out before the one that depends on it', () => {
    seedBrief();
    // MEP off site in June; welfare, which has no power without it, until September.
    composeSystem(granted(), {
      family: 'TEMPORARY_MEP',
      zone: 'Main compound',
      fromDate: '2026-11-01',
      toDate: '2027-06-01',
      leadDays: 60,
    });
    composeSystem(granted(), {
      family: 'WELFARE_ACCOMMODATION',
      zone: 'Main compound',
      fromDate: '2026-11-15',
      toDate: '2027-09-01',
      leadDays: 30,
    });

    const premature = sbs(granted(), '2026-09-01').deployment.find((entry) => entry.kind === 'PREMATURE_REMOVAL')!;
    assert.ok(premature, 'nothing noticed the power leaving before the welfare it feeds');
    assert.match(premature.statement, /no power, water or foul/);
  });

  it('turns an observation into a proposal and never into a reduction', () => {
    seedBrief();
    composeSystem(granted(), { family: 'TEMPORARY_MEP', zone: 'Main compound', ...WINDOW });
    recordObservation(granted(), {
      derivationId: 'potableWater',
      observed: 4_000,
      over: 'the four weeks to 2027-02-01',
      source: 'Meter M-01, monthly read',
    });

    const forecast = sbs(granted()).reforecasts.find((entry) => entry.derivationId === 'potableWater')!;
    assert.ok(forecast);
    assert.equal(forecast.reducesBaseline, true);
    assert.ok(forecast.requiresApproval);

    // And the basis on the composed system is untouched. A design basis is what
    // the service was sized, contracted and priced against; the meter does not
    // get to move it.
    assert.equal(sbs(granted()).systems[0]!.basis.find((entry) => entry.id === 'potableWater')!.normal, 7_100);
  });

  it('measures the observation against the frozen basis, not against today’s brief', () => {
    // The defect this pins was found by driving it: the reforecast compared a
    // meter reading to a live re-derivation, so the variance moved every time
    // the brief did. "Observed consumption vs basis" means the figure the
    // service was sized, contracted and priced against, and that figure stopped
    // moving the day the system was composed.
    seedBrief();
    composeSystem(granted(), { family: 'TEMPORARY_MEP', zone: 'Main compound', ...WINDOW });
    // The brief moves afterwards. The basis does not.
    recordFact(granted(), { itemId: 'shiftOverlapPersons', value: 180, source: 'Shift plan rev C' });
    recordObservation(granted(), {
      derivationId: 'potableWater',
      observed: 6_000,
      over: 'the four weeks to 2027-02-01',
      source: 'Meter M-01',
    });

    const forecast = sbs(granted()).reforecasts.find((entry) => entry.derivationId === 'potableWater')!;
    assert.equal(forecast.basis, 7_100, 'the reforecast measured against the live brief rather than the design basis');
    // 6,000 against 7,100 is 15.5% below — not the 40-odd per cent it would be
    // against a brief that has since grown.
    assert.equal(forecast.variancePercent, -15.5);
  });

  it('does not reforecast a capacity nobody composed', () => {
    // No design basis means nothing to compare to. Measuring against a live
    // figure nothing was ordered on would be inventing a variance.
    seedBrief();
    recordObservation(granted(), {
      derivationId: 'potableWater',
      observed: 6_000,
      over: 'a week',
      source: 'Meter M-01',
    });
    assert.deepEqual(sbs(granted()).reforecasts, []);
  });

  it('refuses an observation with no period or no source', () => {
    seedBrief();
    throwsCode(
      () => recordObservation(granted(), { derivationId: 'potableWater', observed: 4_000, over: '', source: 'Meter' }),
      'OBSERVATION_UNPERIODISED',
    );
    throwsCode(
      () =>
        recordObservation(granted(), { derivationId: 'potableWater', observed: 4_000, over: 'a week', source: ' ' }),
      'OBSERVATION_UNSOURCED',
    );
  });
});
