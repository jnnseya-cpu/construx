import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { offHirePlant, onHirePlant, plantPosition } from '../src/domain/plant.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { captureSiteObservation, recordSiteDiary } from '../src/engines/planning.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The plant register.
 *
 * The property that matters: utilisation is derived, never entered. A diary
 * line naming the machine gives its hours; a photograph reading gives a
 * sighting; a diary line naming a machine nobody hired is reported as such.
 * The cost follows the rate basis honestly — a machine charged by the hour and
 * named in no diary has no derivable cost, and the register says so rather
 * than showing zero.
 */

let platform: Platform;
let seed: SeedResult;
let projectId: string;
const as = (who: string): EngineContext => platform.context(seed.users[who]!.auth, projectId);

const WEATHER = { conditions: 'Dry, 14°C', workingStopped: false };
const LABOUR = [{ trade: 'Groundworks', headcount: 4, hours: 8 }];

function diary(date: string, plant: Array<{ description: string; hoursWorked: number; hoursIdle: number }>): void {
  recordSiteDiary(as('pm'), {
    diaryDate: date,
    weather: WEATHER,
    labour: LABOUR,
    plant,
    progressNarrative: `Bulk dig to the inlet works, ${date}`,
    evidenceHash: `sha256:${date.replace(/-/g, '').padEnd(64, 'a')}`,
  });
}

let excavatorId = '';
let telehandlerId = '';
let breakerId = '';

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  // A project in CONSTRUCTION, where field execution is open. The main
  // demonstration project is in OPERATIONS. Dates below sit in March, clear
  // of the diaries the seed itself writes on this project in August.
  const project = platform.ledger
    .listByTenant(seed.tenantId, 'Project')
    .find((record) => record.state.phase === 'CONSTRUCTION');
  assert.ok(project, 'the seed has a project in construction');
  projectId = project.refId;
});

describe('on-hiring plant', () => {
  it('records what, from whom, at what rate, from when', () => {
    const item = onHirePlant(as('pm'), {
      description: '13t excavator',
      reference: 'AH-4471',
      supplierName: 'Ainscough Plant',
      rateMinor: 35_000,
      rateBasis: 'DAY',
      onHireFrom: '2026-03-02',
      minimumHireDays: 7,
      purpose: 'Bulk dig, inlet works',
    });
    excavatorId = item.id;
    assert.equal(item.status, 'ON_HIRE');
    assert.equal(item.ownership, 'HIRED');
    telehandlerId = onHirePlant(as('pm'), { description: 'Telehandler 17m', supplierName: 'Ainscough Plant', rateMinor: 42_000, rateBasis: 'WEEK', onHireFrom: '2026-03-09' }).id;
    breakerId = onHirePlant(as('pm'), { description: 'Hydraulic breaker', supplierName: 'Ainscough Plant', rateMinor: 1_200, rateBasis: 'HOUR', onHireFrom: '2026-03-02' }).id;
  });

  it('refuses a nameless item, a rate on no basis, hired plant from nobody, and a fleet number already on hire', () => {
    throwsCode(() => onHirePlant(as('pm'), { description: 'x', rateMinor: 100, rateBasis: 'DAY', onHireFrom: '2026-03-02', supplierName: 'A' }), 'PLANT_DESCRIPTION_REQUIRED');
    throwsCode(() => onHirePlant(as('pm'), { description: 'Dumper 6t', rateMinor: 100, rateBasis: 'FORTNIGHT', onHireFrom: '2026-03-02', supplierName: 'A' }), 'PLANT_RATE_BASIS_INVALID');
    throwsCode(() => onHirePlant(as('pm'), { description: 'Dumper 6t', rateMinor: 100, rateBasis: 'DAY', onHireFrom: '2026-03-02' }), 'PLANT_HIRER_REQUIRED');
    throwsCode(() => onHirePlant(as('pm'), { description: 'Another excavator', reference: 'ah-4471', rateMinor: 100, rateBasis: 'DAY', onHireFrom: '2026-03-04', supplierName: 'A' }), 'PLANT_REFERENCE_ON_HIRE');
    throwsCode(() => onHirePlant(as('pm'), { description: 'Dumper 6t', rateMinor: 100, rateBasis: 'DAY', onHireFrom: '2026-03-02', expectedOffHire: '2026-02-27', supplierName: 'A' }), 'PLANT_OFF_HIRE_BEFORE_ON_HIRE');
  });

  it('owned plant needs no hirer and may carry no rate', () => {
    const owned = onHirePlant(as('pm'), { description: 'Site dumper (owned)', ownership: 'OWNED', rateMinor: 0, rateBasis: 'DAY', onHireFrom: '2026-03-02' });
    assert.equal(owned.ownership, 'OWNED');
    assert.equal(offHirePlant(as('pm'), { plantId: owned.id, offHiredOn: '2026-03-03', reason: 'Returned to the yard' }).status, 'OFF_HIRE');
  });

  it('takes the field authority, so a planner may read the register and not write it', () => {
    throwsCode(() => onHirePlant(as('planner'), { description: 'Dumper 6t', rateMinor: 100, rateBasis: 'DAY', onHireFrom: '2026-03-02', supplierName: 'A' }), 'ACCESS_DENIED');
    assert.ok(plantPosition(as('planner')).items.length >= 3);
  });
});

describe('utilisation, derived from the diary and the photographs', () => {
  before(() => {
    diary('2026-03-03', [{ description: '13T Excavator (AH-4471)', hoursWorked: 8, hoursIdle: 0 }]);
    diary('2026-03-10', [
      { description: '13t excavator', hoursWorked: 4, hoursIdle: 4 },
      { description: 'Telehandler 17m', hoursWorked: 6, hoursIdle: 2 },
      { description: 'Dumper 6t', hoursWorked: 8, hoursIdle: 0 },
    ]);
    diary('2026-03-11', [{ description: '13t excavator', hoursWorked: 0, hoursIdle: 8 }]);
  });

  it('matches diary lines to the register by fleet number or description, and derives hours, utilisation and standing cost', () => {
    const position = plantPosition(as('pm'), '2026-03-13');
    const excavator = position.items.find((item) => item.id === excavatorId)!;
    assert.equal(excavator.hireDays, 12, '2 to 13 March inclusive');
    assert.equal(excavator.costToDateMinor, 12 * 35_000);
    assert.equal(excavator.hoursWorked, 12);
    assert.equal(excavator.hoursIdle, 12);
    assert.equal(excavator.diaryDays, 3);
    assert.equal(excavator.utilisationPercent, 50);
    assert.equal(excavator.standingCostMinor, 6 * 35_000, 'half the hire cost was paid for a machine standing');
    assert.equal(excavator.idleAlert, undefined, 'named in a diary two days ago');

    const telehandler = position.items.find((item) => item.id === telehandlerId)!;
    assert.equal(telehandler.hireDays, 5);
    assert.equal(telehandler.costToDateMinor, 42_000, 'one whole week at the week rate');
    assert.equal(telehandler.utilisationPercent, 75);
  });

  it('cannot derive a cost for hourly plant named in no diary, and says so rather than showing zero', () => {
    const position = plantPosition(as('pm'), '2026-03-13');
    const breaker = position.items.find((item) => item.id === breakerId)!;
    assert.equal(breaker.costToDateMinor, undefined);
    assert.match(breaker.costBasis, /named in no diary, so the cost to date cannot be derived/);
    assert.match(breaker.idleAlert ?? '', /On hire 12 days and named in no site diary at all/);
    assert.equal(position.alerts, 1);
  });

  it('reports plant the diary names that nobody has hired', () => {
    const position = plantPosition(as('pm'), '2026-03-13');
    // The seed's own diaries on this project name plant too, none of it on the
    // register, so the dumper is one entry among several rather than the only one.
    const dumper = position.unregistered.find((entry) => entry.description === 'Dumper 6t');
    assert.deepEqual(dumper, { description: 'Dumper 6t', hoursWorked: 8, hoursIdle: 0, days: 1, lastDate: '2026-03-10' });
    assert.match(position.statement, /\d+ plant descriptions? in the diary match nothing on the register/);
  });

  it('totals the week ahead by the day and week rates, and the spend and standing cost to date', () => {
    const position = plantPosition(as('pm'), '2026-03-13');
    assert.equal(position.weeklyRunRateMinor, 35_000 * 5 + 42_000);
    assert.equal(position.costToDateMinor, 12 * 35_000 + 42_000);
    assert.equal(position.standingCostMinor, 6 * 35_000 + Math.round((42_000 * 2) / 8));
    assert.match(position.statement, /3 items on hire, running at about £2,170\.00 a week before 1 charged by the hour/);
  });

  it('counts a photograph reading that names the machine as a sighting', () => {
    captureSiteObservation(as('pm'), {
      category: 'PROGRESS',
      description: 'Plant and equipment read from site photography: 1 × 13t excavator (AH-4471) — IDLE',
      location: 'Inlet works',
      observedBy: seed.users.pm!.id,
      requiresAction: false,
      evidenceHash: `sha256:${'b'.repeat(64)}`,
    });
    const excavator = plantPosition(as('pm')).items.find((item) => item.id === excavatorId)!;
    assert.equal(excavator.sightings, 1);
    assert.ok(excavator.lastSeen);
  });
});

describe('off-hiring', () => {
  it('records the release, and a minimum term still to bill as a shortfall', () => {
    const released = offHirePlant(as('pm'), { plantId: excavatorId, offHiredOn: '2026-03-05', reason: 'Dig complete early' });
    assert.equal(released.status, 'OFF_HIRE');
    assert.equal(released.minimumHireShortfallDays, 3, 'four days of a seven-day minimum');
    const position = plantPosition(as('pm'), '2026-03-13');
    const excavator = position.items.find((item) => item.id === excavatorId)!;
    assert.equal(excavator.hireDays, 4);
    assert.equal(excavator.costToDateMinor, 7 * 35_000, 'the minimum term bills');
    assert.match(excavator.costBasis, /minimum term billing beyond the hire/);
    assert.equal(excavator.hoursWorked, 8, 'only the diary days inside the hire count');
    assert.equal(position.onHire, 2);
  });

  it('refuses an off-hire before the on-hire, and a second off-hire', () => {
    throwsCode(() => offHirePlant(as('pm'), { plantId: telehandlerId, offHiredOn: '2026-02-27' }), 'PLANT_OFF_HIRE_BEFORE_ON_HIRE');
    throwsCode(() => offHirePlant(as('pm'), { plantId: excavatorId, offHiredOn: '2026-03-20' }), 'PLANT_ALREADY_OFF_HIRE');
    throwsCode(() => offHirePlant(as('pm'), { plantId: 'no-such-item', offHiredOn: '2026-03-20' }), 'PLANT_NOT_FOUND');
  });

  it('a fleet number released can be hired again', () => {
    const again = onHirePlant(as('pm'), { description: '13t excavator', reference: 'AH-4471', supplierName: 'Ainscough Plant', rateMinor: 35_000, rateBasis: 'DAY', onHireFrom: '2026-03-20' });
    assert.equal(again.status, 'ON_HIRE');
  });
});
