import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { setAppointment } from '../src/domain/etablix/appointment.ts';
import { recordFact } from '../src/domain/etablix/brief.ts';
import { composeSystem } from '../src/domain/etablix/composer.ts';
import {
  allocateBed,
  bookSeat,
  checkDelivery,
  checkIn,
  checkOut,
  deskPosition,
  registerAsset,
  registerRoom,
  scanAsset,
  scheduleDelivery,
  scheduleJourney,
  setRoomStatus,
  updateJourney,
} from '../src/domain/etablix/desk.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * §13's four record families beneath a composed system: the asset a code
 * resolves to, the delivery checked against its schedule, the room and the
 * bed somebody sleeps in tonight, and the journey a seat is booked on.
 */

let platform: Platform;
let seed: SeedResult;
let systemId = '';

const as = (who: string): EngineContext => platform.context(seed.users[who]!.auth, seed.projectId);

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
  seed.projectId = `${seed.users.pm!.auth.tenantId}-desk`;
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
    ['accommodatedWorkers', 6],
    ['cleanableAreaSqm', 1800],
  ] as [string, number][]) {
    recordFact(as('pm'), { itemId, value, source: 'Programme rev D' });
  }
  systemId = composeSystem(as('pm'), { family: 'WELFARE_ACCOMMODATION', zone: 'Main compound', fromDate: '2026-11-01', toDate: '2027-09-01', leadDays: 30 }).system.id;
});

describe('the asset register a code resolves to', () => {
  it('registers a unit under its system and resolves a scan to it', () => {
    const cabin = registerAsset(as('pm'), { systemId, tag: 'wc 01', kind: 'Welfare cabin', serial: 'WC-2026-0181' });
    assert.equal(cabin.tag, 'WC-01', 'the tag is normalised the way a scanner reads it');
    assert.equal(cabin.location, 'Main compound', 'the system’s zone until somebody says otherwise');
    throwsCode(() => registerAsset(as('pm'), { systemId, tag: 'WC-01', kind: 'Another cabin' }), 'ASSET_TAG_IN_USE');
    throwsCode(() => registerAsset(as('pm'), { systemId: 'nope', tag: 'WC-02', kind: 'Cabin' }), 'SYSTEM_NOT_FOUND');

    const scanned = scanAsset(as('pm'), { tag: 'wc-01', status: 'DEFECTIVE', location: 'Compound gate', note: 'Door hinge failed' });
    assert.equal(scanned.scans, 1);
    assert.equal(scanned.status, 'DEFECTIVE');
    assert.equal(scanned.location, 'Compound gate');
    throwsCode(() => scanAsset(as('pm'), { tag: 'WC-99' }), 'ASSET_UNKNOWN');
    const desk = deskPosition(as('pm'));
    assert.equal(desk.assets.registered, 1);
    assert.equal(desk.assets.defective, 1);
    assert.equal(desk.assets.neverScanned, 0);
  });
});

describe('deliveries against their schedule', () => {
  it('is checked in as received, short with the discrepancy, or refused', () => {
    const cabins = scheduleDelivery(as('pm'), { systemId, supplier: 'Portakabin', description: 'Welfare cabins', expectedOn: '2026-10-20', quantityExpected: 4 });
    const fuel = scheduleDelivery(as('pm'), { supplier: 'Certas', description: 'Red diesel', expectedOn: '2026-10-21', quantityExpected: 1 });
    throwsCode(() => checkDelivery(as('pm'), { deliveryId: cabins.id, quantityReceived: 3 }), 'DISCREPANCY_REQUIRED');
    const short = checkDelivery(as('pm'), { deliveryId: cabins.id, quantityReceived: 3, discrepancy: 'Fourth cabin damaged in transit, returned' });
    assert.equal(short.status, 'SHORT');
    const refused = checkDelivery(as('pm'), { deliveryId: fuel.id, quantityReceived: 0, refused: true });
    assert.equal(refused.status, 'REFUSED');
    throwsCode(() => checkDelivery(as('pm'), { deliveryId: fuel.id, quantityReceived: 1 }), 'DELIVERY_ALREADY_CHECKED');
    const late = scheduleDelivery(as('pm'), { supplier: 'Speedy', description: 'Generator', expectedOn: '2026-10-01', quantityExpected: 1 });
    const desk = deskPosition(as('pm'), '2026-10-22');
    assert.equal(desk.deliveries.short, 1);
    assert.equal(desk.deliveries.refused, 1);
    assert.equal(desk.deliveries.overdue, 1, `${late.description} is past its day`);
  });
});

describe('rooms, beds and who is in them tonight', () => {
  let roomId = '';
  let allocationId = '';

  it('registers rooms beneath the accommodation system only', () => {
    const room = registerRoom(as('pm'), { systemId, block: 'A', number: '1', beds: 2 });
    roomId = room.id;
    registerRoom(as('pm'), { systemId, block: 'A', number: '2', beds: 2 });
    throwsCode(() => registerRoom(as('pm'), { systemId, block: 'A', number: '1', beds: 2 }), 'ROOM_EXISTS');
    const desk = deskPosition(as('pm'));
    assert.equal(desk.accommodation.beds, 4);
    assert.equal(desk.accommodation.demandBeds, 6);
    assert.match(desk.accommodation.statement, /2 short of the demand/);
  });

  it('allocates by name, never beyond the beds, and occupies by check-in', () => {
    const first = allocateBed(as('pm'), { roomId, occupant: 'Dev Patel', employer: 'Meridian', from: '2026-11-02', to: '2026-11-13' });
    allocationId = first.id;
    allocateBed(as('pm'), { roomId, occupant: 'Sam Okafor', from: '2026-11-02' });
    throwsCode(() => allocateBed(as('pm'), { roomId, occupant: 'One too many', from: '2026-11-02' }), 'ROOM_FULL');
    throwsCode(() => setRoomStatus(as('pm'), { roomId, status: 'OCCUPIED' }), 'NOBODY_CHECKED_IN');

    const arrived = checkIn(as('pm'), { allocationId });
    assert.equal(arrived.status, 'CHECKED_IN');
    const desk = deskPosition(as('pm'), '2026-11-02');
    const room = desk.accommodation.rooms.find((entry) => entry.id === roomId)!;
    assert.equal(room.status, 'OCCUPIED', 'occupied by the record, not by declaration');
    assert.deepEqual(room.occupants, ['Dev Patel']);
    assert.equal(desk.accommodation.occupiedTonight, 1);
    assert.equal(desk.accommodation.arrivalsDue, 1, 'Sam is allocated from today and not yet in');
    throwsCode(() => setRoomStatus(as('pm'), { roomId, status: 'OUT_OF_SERVICE', reason: 'Leak' }), 'ROOM_OCCUPIED');
  });

  it('sends a vacated room to housekeeping and refuses a room out of service', () => {
    const left = checkOut(as('pm'), { allocationId });
    assert.equal(left.status, 'CHECKED_OUT');
    const cleaning = deskPosition(as('pm')).accommodation.rooms.find((entry) => entry.id === roomId)!;
    assert.equal(cleaning.status, 'CLEANING');
    assert.equal(cleaning.free, 1, 'Sam still holds the other bed');
    const other = deskPosition(as('pm')).accommodation.rooms.find((entry) => entry.id !== roomId)!;
    setRoomStatus(as('pm'), { roomId: other.id, status: 'OUT_OF_SERVICE', reason: 'Heater failed, awaiting part' });
    throwsCode(() => allocateBed(as('pm'), { roomId: other.id, occupant: 'Nobody', from: '2026-11-03' }), 'ROOM_OUT_OF_SERVICE');
    const desk = deskPosition(as('pm'));
    assert.equal(desk.accommodation.outOfService, 1);
    assert.equal(desk.accommodation.beds, 2, 'a room out of service holds no beds tonight');
  });
});

describe('journeys and the seats on them', () => {
  it('books by name, never beyond the seats, and moves through its states with a reason where one is owed', () => {
    const bus = scheduleJourney(as('pm'), { systemId, vehicle: 'Minibus 1', route: 'Station → Compound', departs: '2026-11-02T06:30:00Z', seats: 2 });
    bookSeat(as('pm'), { journeyId: bus.id, passenger: 'Dev Patel' });
    const same = bookSeat(as('pm'), { journeyId: bus.id, passenger: 'Dev Patel' });
    assert.equal(same.booked.length, 1, 'the same name books once');
    bookSeat(as('pm'), { journeyId: bus.id, passenger: 'Sam Okafor' });
    throwsCode(() => bookSeat(as('pm'), { journeyId: bus.id, passenger: 'Standing' }), 'JOURNEY_FULL');
    const desk = deskPosition(as('pm'), '2026-11-02');
    assert.equal(desk.transport.today, 1);
    assert.equal(desk.transport.loadFactorPercent, 100);

    throwsCode(() => updateJourney(as('pm'), { journeyId: bus.id, status: 'ARRIVED' }), 'JOURNEY_TRANSITION');
    throwsCode(() => updateJourney(as('pm'), { journeyId: bus.id, status: 'CANCELLED' }), 'REASON_REQUIRED');
    const departed = updateJourney(as('pm'), { journeyId: bus.id, status: 'DEPARTED' });
    assert.ok(departed.departedAt);
    throwsCode(() => bookSeat(as('pm'), { journeyId: bus.id, passenger: 'Late' }), 'JOURNEY_NOT_BOOKABLE');
    const arrived = updateJourney(as('pm'), { journeyId: bus.id, status: 'ARRIVED' });
    assert.ok(arrived.arrivedAt);
  });

  it('survives a restart with every record intact', () => {
    const restored = new Platform();
    restored.ledger.restore(platform.ledger.events());
    restored.rehydrate();
    const before = deskPosition(as('pm'), '2026-11-02');
    const after = deskPosition(restored.context(seed.users.pm!.auth, seed.projectId), '2026-11-02');
    assert.deepEqual(after.statement, before.statement);
    assert.equal(after.accommodation.rooms.length, before.accommodation.rooms.length);
    assert.equal(after.transport.journeys.length, before.transport.journeys.length);
  });
});
