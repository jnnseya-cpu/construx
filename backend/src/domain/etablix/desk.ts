import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { authorise, write, type EngineContext } from '../../engines/context.ts';
import { requireModule } from '../../identity/modules.ts';
import type { ServiceSystem } from './composer.ts';

/**
 * §13's four missing record families: the per-asset register a QR code
 * resolves to, deliveries booked against a schedule rather than attested
 * after the fact, the rooms and beds beneath a composed accommodation system,
 * and the journeys beneath a transport service.
 *
 * Each is a record under a composed system, never beside it. §4 sizes a
 * system against demand and that stays the design basis; these are what is
 * actually on site, who is actually in which bed tonight, which vehicle is
 * actually leaving. Every position here reads the two against each other and
 * says where they disagree, because a welfare block sized for 120 with 130
 * checked in is a finding, not a rounding.
 */

// --- assets -----------------------------------------------------------------

export type AssetStatus = 'ON_SITE' | 'OFF_SITE' | 'DEFECTIVE';

export type ServiceAsset = {
  id: string;
  projectId: string;
  systemId: string;
  /** What the code on the unit says. Unique on the project. */
  tag: string;
  kind: string;
  serial?: string;
  status: AssetStatus;
  location?: string;
  registeredBy: string;
  registeredAt: string;
  scans: number;
  lastScanAt?: string;
  lastScanBy?: string;
  lastScanNote?: string;
};

function systemsOf(ctx: EngineContext): ServiceSystem[] {
  return ctx.ledger.list(ctx.projectId, 'ServiceSystem').map((record) => record.state as unknown as ServiceSystem);
}

function requireSystem(ctx: EngineContext, systemId: string): ServiceSystem {
  const system = systemsOf(ctx).find((entry) => entry.id === systemId);
  if (!system) throw new DomainError('SYSTEM_NOT_FOUND', `No composed system ${systemId} on this project. Compose the system first; a record under nothing is a record nobody can size.`, 404);
  return system;
}

function assetsOf(ctx: EngineContext): ServiceAsset[] {
  return ctx.ledger.list(ctx.projectId, 'ServiceAsset').map((record) => record.state as unknown as ServiceAsset);
}

function normaliseTag(tag: string): string {
  return tag.trim().toUpperCase().replace(/\s+/g, '-');
}

export function registerAsset(
  ctx: EngineContext,
  input: { systemId: string; tag: string; kind: string; serial?: string; location?: string },
): ServiceAsset {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C');
  const system = requireSystem(ctx, input.systemId);
  const tag = normaliseTag(input.tag);
  if (tag.length < 3) throw new DomainError('TAG_REQUIRED', 'The tag is what the code on the unit resolves to. Three characters at least.', 422);
  if (!input.kind?.trim()) throw new DomainError('KIND_REQUIRED', 'Say what the unit is — a cabin, a generator, a bowser.', 422);
  if (assetsOf(ctx).some((entry) => entry.tag === tag)) {
    throw new DomainError('ASSET_TAG_IN_USE', `${tag} is already registered on this project. A code that resolves to two units resolves to neither.`, 409);
  }
  const asset: ServiceAsset = {
    id: ulid(),
    projectId: ctx.projectId,
    systemId: system.id,
    tag,
    kind: input.kind.trim(),
    ...(input.serial?.trim() ? { serial: input.serial.trim() } : {}),
    status: 'ON_SITE',
    ...(input.location?.trim() ? { location: input.location.trim() } : { location: system.zone }),
    registeredBy: ctx.auth.actorId,
    registeredAt: new Date().toISOString(),
    scans: 0,
  };
  write(ctx, { eventType: 'SERVICE_ASSET_REGISTERED', entity: { refType: 'ServiceAsset', refId: asset.id }, nextState: { ...asset } });
  return asset;
}

/** What a scanned code resolves to, and the scan recorded against it. */
export function scanAsset(
  ctx: EngineContext,
  input: { tag: string; status?: AssetStatus; location?: string; note?: string },
): ServiceAsset {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'U');
  const tag = normaliseTag(input.tag);
  const asset = assetsOf(ctx).find((entry) => entry.tag === tag);
  if (!asset) {
    throw new DomainError('ASSET_UNKNOWN', `${tag} resolves to nothing on this project. Register the unit, or the code is on somebody else’s site.`, 404);
  }
  const updated: ServiceAsset = {
    ...asset,
    status: input.status ?? asset.status,
    ...(input.location?.trim() ? { location: input.location.trim() } : {}),
    scans: asset.scans + 1,
    lastScanAt: new Date().toISOString(),
    lastScanBy: ctx.auth.actorId,
    ...(input.note?.trim() ? { lastScanNote: input.note.trim() } : {}),
  };
  write(ctx, { eventType: 'SERVICE_ASSET_SCANNED', entity: { refType: 'ServiceAsset', refId: asset.id }, nextState: { ...updated } });
  return updated;
}

// --- deliveries -------------------------------------------------------------

export type DeliveryStatus = 'EXPECTED' | 'RECEIVED' | 'SHORT' | 'REFUSED';

export type ServiceDelivery = {
  id: string;
  projectId: string;
  systemId?: string;
  supplier: string;
  description: string;
  expectedOn: string;
  quantityExpected: number;
  status: DeliveryStatus;
  quantityReceived?: number;
  receivedOn?: string;
  checkedBy?: string;
  checkedAt?: string;
  discrepancy?: string;
  scheduledBy: string;
  scheduledAt: string;
};

function deliveriesOf(ctx: EngineContext): ServiceDelivery[] {
  return ctx.ledger.list(ctx.projectId, 'ServiceDelivery').map((record) => record.state as unknown as ServiceDelivery);
}

export function scheduleDelivery(
  ctx: EngineContext,
  input: { systemId?: string; supplier: string; description: string; expectedOn: string; quantityExpected: number },
): ServiceDelivery {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C');
  if (input.systemId) requireSystem(ctx, input.systemId);
  if (!input.supplier?.trim()) throw new DomainError('SUPPLIER_REQUIRED', 'Who is delivering.', 422);
  if (!input.description?.trim()) throw new DomainError('DESCRIPTION_REQUIRED', 'What is being delivered.', 422);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expectedOn)) throw new DomainError('DATE_REQUIRED', 'The day it is expected, as YYYY-MM-DD.', 422);
  if (!Number.isInteger(input.quantityExpected) || input.quantityExpected <= 0) {
    throw new DomainError('QUANTITY_REQUIRED', 'How many are expected. A delivery of nothing cannot be checked.', 422);
  }
  const delivery: ServiceDelivery = {
    id: ulid(),
    projectId: ctx.projectId,
    ...(input.systemId ? { systemId: input.systemId } : {}),
    supplier: input.supplier.trim(),
    description: input.description.trim(),
    expectedOn: input.expectedOn,
    quantityExpected: input.quantityExpected,
    status: 'EXPECTED',
    scheduledBy: ctx.auth.actorId,
    scheduledAt: new Date().toISOString(),
  };
  write(ctx, { eventType: 'SERVICE_DELIVERY_SCHEDULED', entity: { refType: 'ServiceDelivery', refId: delivery.id }, nextState: { ...delivery } });
  return delivery;
}

export function checkDelivery(
  ctx: EngineContext,
  input: { deliveryId: string; quantityReceived: number; receivedOn?: string; discrepancy?: string; refused?: boolean },
): ServiceDelivery {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'U');
  const delivery = deliveriesOf(ctx).find((entry) => entry.id === input.deliveryId);
  if (!delivery) throw new DomainError('DELIVERY_NOT_FOUND', `No delivery ${input.deliveryId} on this project.`, 404);
  if (delivery.status !== 'EXPECTED') {
    throw new DomainError('DELIVERY_ALREADY_CHECKED', `${delivery.description} was checked as ${delivery.status.toLowerCase()} already.`, 409);
  }
  if (!Number.isInteger(input.quantityReceived) || input.quantityReceived < 0) {
    throw new DomainError('QUANTITY_REQUIRED', 'How many actually arrived, zero included.', 422);
  }
  const short = input.quantityReceived < delivery.quantityExpected;
  if (short && !input.refused && !input.discrepancy?.trim()) {
    throw new DomainError(
      'DISCREPANCY_REQUIRED',
      `${input.quantityReceived} of ${delivery.quantityExpected} arrived. Say what is short and why, or the gate evidence will carry a delivery that half happened.`,
      422,
    );
  }
  const updated: ServiceDelivery = {
    ...delivery,
    status: input.refused ? 'REFUSED' : short ? 'SHORT' : 'RECEIVED',
    quantityReceived: input.quantityReceived,
    receivedOn: input.receivedOn ?? new Date().toISOString().slice(0, 10),
    checkedBy: ctx.auth.actorId,
    checkedAt: new Date().toISOString(),
    ...(input.discrepancy?.trim() ? { discrepancy: input.discrepancy.trim() } : {}),
  };
  write(ctx, { eventType: 'SERVICE_DELIVERY_CHECKED', entity: { refType: 'ServiceDelivery', refId: delivery.id }, nextState: { ...updated } });
  return updated;
}

// --- rooms and beds -----------------------------------------------------------

export type RoomStatus = 'READY' | 'OCCUPIED' | 'CLEANING' | 'OUT_OF_SERVICE';

export type AccommodationRoom = {
  id: string;
  projectId: string;
  systemId: string;
  block: string;
  number: string;
  beds: number;
  status: RoomStatus;
  statusReason?: string;
  registeredBy: string;
  registeredAt: string;
};

export type AllocationStatus = 'ALLOCATED' | 'CHECKED_IN' | 'CHECKED_OUT';

export type BedAllocation = {
  id: string;
  projectId: string;
  roomId: string;
  occupant: string;
  employer?: string;
  from: string;
  to?: string;
  status: AllocationStatus;
  allocatedBy: string;
  allocatedAt: string;
  checkedInAt?: string;
  checkedOutAt?: string;
};

function roomsOf(ctx: EngineContext): AccommodationRoom[] {
  return ctx.ledger.list(ctx.projectId, 'AccommodationRoom').map((record) => record.state as unknown as AccommodationRoom);
}

function allocationsOf(ctx: EngineContext): BedAllocation[] {
  return ctx.ledger.list(ctx.projectId, 'BedAllocation').map((record) => record.state as unknown as BedAllocation);
}

const LIVE: readonly AllocationStatus[] = ['ALLOCATED', 'CHECKED_IN'];

export function registerRoom(
  ctx: EngineContext,
  input: { systemId: string; block: string; number: string; beds: number },
): AccommodationRoom {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C');
  const system = requireSystem(ctx, input.systemId);
  if (system.family !== 'WELFARE_ACCOMMODATION') {
    throw new DomainError('NOT_ACCOMMODATION', `${system.label} is a ${system.family.toLowerCase().replace(/_/g, ' ')} system. Rooms live under an accommodation system.`, 422);
  }
  const block = input.block.trim();
  const number = input.number.trim();
  if (!block || !number) throw new DomainError('ROOM_REQUIRED', 'A block and a room number, so a bed can be pointed at.', 422);
  if (!Number.isInteger(input.beds) || input.beds <= 0) throw new DomainError('BEDS_REQUIRED', 'How many beds the room holds.', 422);
  if (roomsOf(ctx).some((entry) => entry.block === block && entry.number === number)) {
    throw new DomainError('ROOM_EXISTS', `${block} ${number} is already registered.`, 409);
  }
  const room: AccommodationRoom = {
    id: ulid(),
    projectId: ctx.projectId,
    systemId: system.id,
    block,
    number,
    beds: input.beds,
    status: 'READY',
    registeredBy: ctx.auth.actorId,
    registeredAt: new Date().toISOString(),
  };
  write(ctx, { eventType: 'ACCOMMODATION_ROOM_REGISTERED', entity: { refType: 'AccommodationRoom', refId: room.id }, nextState: { ...room } });
  return room;
}

function writeRoomStatus(ctx: EngineContext, room: AccommodationRoom, status: RoomStatus, reason?: string): AccommodationRoom {
  const updated: AccommodationRoom = { ...room, status, ...(reason ? { statusReason: reason } : {}) };
  if (!reason) delete updated.statusReason;
  write(ctx, { eventType: 'ACCOMMODATION_ROOM_STATUS_SET', entity: { refType: 'AccommodationRoom', refId: room.id }, nextState: { ...updated } });
  return updated;
}

export function setRoomStatus(
  ctx: EngineContext,
  input: { roomId: string; status: RoomStatus; reason?: string },
): AccommodationRoom {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'U');
  const room = roomsOf(ctx).find((entry) => entry.id === input.roomId);
  if (!room) throw new DomainError('ROOM_NOT_FOUND', `No room ${input.roomId} on this project.`, 404);
  const checkedIn = allocationsOf(ctx).filter((entry) => entry.roomId === room.id && entry.status === 'CHECKED_IN');
  if (input.status === 'OUT_OF_SERVICE' && checkedIn.length > 0) {
    throw new DomainError('ROOM_OCCUPIED', `${room.block} ${room.number} has ${checkedIn.length} checked in. Check them out or move them before taking it out of service.`, 409);
  }
  if (input.status === 'OUT_OF_SERVICE' && !input.reason?.trim()) {
    throw new DomainError('REASON_REQUIRED', 'Say why the room is out of service; the desk will be asked when it comes back.', 422);
  }
  if (input.status === 'OCCUPIED' && checkedIn.length === 0) {
    throw new DomainError('NOBODY_CHECKED_IN', 'A room is occupied by a check-in, not by declaration.', 422);
  }
  return writeRoomStatus(ctx, room, input.status, input.reason?.trim());
}

export function allocateBed(
  ctx: EngineContext,
  input: { roomId: string; occupant: string; employer?: string; from: string; to?: string },
): BedAllocation {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C');
  const room = roomsOf(ctx).find((entry) => entry.id === input.roomId);
  if (!room) throw new DomainError('ROOM_NOT_FOUND', `No room ${input.roomId} on this project.`, 404);
  if (room.status === 'OUT_OF_SERVICE') {
    throw new DomainError('ROOM_OUT_OF_SERVICE', `${room.block} ${room.number} is out of service${room.statusReason ? `: ${room.statusReason}` : ''}.`, 409);
  }
  if (!input.occupant?.trim()) throw new DomainError('OCCUPANT_REQUIRED', 'Who the bed is for.', 422);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.from)) throw new DomainError('DATE_REQUIRED', 'The first night, as YYYY-MM-DD.', 422);
  if (input.to && input.to < input.from) throw new DomainError('DATES_REVERSED', 'The last night is before the first.', 422);
  const live = allocationsOf(ctx).filter((entry) => entry.roomId === room.id && LIVE.includes(entry.status));
  if (live.length >= room.beds) {
    throw new DomainError('ROOM_FULL', `${room.block} ${room.number} has ${room.beds} bed${room.beds === 1 ? '' : 's'} and ${live.length} allocated. Nobody sleeps on a number.`, 409);
  }
  const allocation: BedAllocation = {
    id: ulid(),
    projectId: ctx.projectId,
    roomId: room.id,
    occupant: input.occupant.trim(),
    ...(input.employer?.trim() ? { employer: input.employer.trim() } : {}),
    from: input.from,
    ...(input.to ? { to: input.to } : {}),
    status: 'ALLOCATED',
    allocatedBy: ctx.auth.actorId,
    allocatedAt: new Date().toISOString(),
  };
  write(ctx, { eventType: 'BED_ALLOCATED', entity: { refType: 'BedAllocation', refId: allocation.id }, nextState: { ...allocation } });
  return allocation;
}

export function checkIn(ctx: EngineContext, input: { allocationId: string }): BedAllocation {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'U');
  const allocation = allocationsOf(ctx).find((entry) => entry.id === input.allocationId);
  if (!allocation) throw new DomainError('ALLOCATION_NOT_FOUND', `No allocation ${input.allocationId}.`, 404);
  if (allocation.status !== 'ALLOCATED') throw new DomainError('NOT_ARRIVING', `${allocation.occupant} is ${allocation.status.toLowerCase().replace('_', ' ')}, not arriving.`, 409);
  const room = roomsOf(ctx).find((entry) => entry.id === allocation.roomId)!;
  if (room.status === 'OUT_OF_SERVICE' || room.status === 'CLEANING') {
    throw new DomainError('ROOM_NOT_READY', `${room.block} ${room.number} is ${room.status.toLowerCase().replace('_', ' ')}. Make it ready before anybody is checked in.`, 409);
  }
  const updated: BedAllocation = { ...allocation, status: 'CHECKED_IN', checkedInAt: new Date().toISOString() };
  write(ctx, { eventType: 'BED_CHECKED_IN', entity: { refType: 'BedAllocation', refId: allocation.id }, nextState: { ...updated } });
  if (room.status !== 'OCCUPIED') writeRoomStatus(ctx, room, 'OCCUPIED');
  return updated;
}

export function checkOut(ctx: EngineContext, input: { allocationId: string }): BedAllocation {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'U');
  const allocation = allocationsOf(ctx).find((entry) => entry.id === input.allocationId);
  if (!allocation) throw new DomainError('ALLOCATION_NOT_FOUND', `No allocation ${input.allocationId}.`, 404);
  if (allocation.status === 'CHECKED_OUT') return allocation;
  const updated: BedAllocation = { ...allocation, status: 'CHECKED_OUT', checkedOutAt: new Date().toISOString() };
  write(ctx, { eventType: 'BED_CHECKED_OUT', entity: { refType: 'BedAllocation', refId: allocation.id }, nextState: { ...updated } });
  const room = roomsOf(ctx).find((entry) => entry.id === allocation.roomId)!;
  const remaining = allocationsOf(ctx).filter((entry) => entry.roomId === room.id && entry.status === 'CHECKED_IN' && entry.id !== allocation.id);
  // Somebody leaving is the moment a room needs housekeeping, and the desk
  // is told so by the record rather than by somebody remembering.
  if (allocation.status === 'CHECKED_IN' && remaining.length === 0) writeRoomStatus(ctx, room, 'CLEANING', 'Vacated; housekeeping due');
  return updated;
}

// --- transport --------------------------------------------------------------

export type JourneyStatus = 'SCHEDULED' | 'DEPARTED' | 'ARRIVED' | 'CANCELLED';

export type TransportJourney = {
  id: string;
  projectId: string;
  systemId?: string;
  vehicle: string;
  route: string;
  departs: string;
  seats: number;
  booked: string[];
  status: JourneyStatus;
  departedAt?: string;
  arrivedAt?: string;
  cancelledReason?: string;
  scheduledBy: string;
  scheduledAt: string;
};

function journeysOf(ctx: EngineContext): TransportJourney[] {
  return ctx.ledger.list(ctx.projectId, 'TransportJourney').map((record) => record.state as unknown as TransportJourney);
}

export function scheduleJourney(
  ctx: EngineContext,
  input: { systemId?: string; vehicle: string; route: string; departs: string; seats: number },
): TransportJourney {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C');
  if (input.systemId) requireSystem(ctx, input.systemId);
  if (!input.vehicle?.trim()) throw new DomainError('VEHICLE_REQUIRED', 'Which vehicle.', 422);
  if (!input.route?.trim()) throw new DomainError('ROUTE_REQUIRED', 'From where to where.', 422);
  if (Number.isNaN(Date.parse(input.departs))) throw new DomainError('DEPARTURE_REQUIRED', 'When it leaves, as an ISO date-time.', 422);
  if (!Number.isInteger(input.seats) || input.seats <= 0) throw new DomainError('SEATS_REQUIRED', 'How many seats.', 422);
  const journey: TransportJourney = {
    id: ulid(),
    projectId: ctx.projectId,
    ...(input.systemId ? { systemId: input.systemId } : {}),
    vehicle: input.vehicle.trim(),
    route: input.route.trim(),
    departs: new Date(input.departs).toISOString(),
    seats: input.seats,
    booked: [],
    status: 'SCHEDULED',
    scheduledBy: ctx.auth.actorId,
    scheduledAt: new Date().toISOString(),
  };
  write(ctx, { eventType: 'TRANSPORT_JOURNEY_SCHEDULED', entity: { refType: 'TransportJourney', refId: journey.id }, nextState: { ...journey } });
  return journey;
}

export function bookSeat(ctx: EngineContext, input: { journeyId: string; passenger: string }): TransportJourney {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'U');
  const journey = journeysOf(ctx).find((entry) => entry.id === input.journeyId);
  if (!journey) throw new DomainError('JOURNEY_NOT_FOUND', `No journey ${input.journeyId}.`, 404);
  if (journey.status !== 'SCHEDULED') throw new DomainError('JOURNEY_NOT_BOOKABLE', `That journey has ${journey.status.toLowerCase()}.`, 409);
  const passenger = input.passenger?.trim();
  if (!passenger) throw new DomainError('PASSENGER_REQUIRED', 'Who the seat is for.', 422);
  if (journey.booked.includes(passenger)) return journey;
  if (journey.booked.length >= journey.seats) {
    throw new DomainError('JOURNEY_FULL', `${journey.vehicle} at ${journey.departs.slice(11, 16)} has ${journey.seats} seats and ${journey.booked.length} booked.`, 409);
  }
  const updated: TransportJourney = { ...journey, booked: [...journey.booked, passenger] };
  write(ctx, { eventType: 'TRANSPORT_SEAT_BOOKED', entity: { refType: 'TransportJourney', refId: journey.id }, nextState: { ...updated } });
  return updated;
}

export function updateJourney(
  ctx: EngineContext,
  input: { journeyId: string; status: Exclude<JourneyStatus, 'SCHEDULED'>; reason?: string },
): TransportJourney {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'U');
  const journey = journeysOf(ctx).find((entry) => entry.id === input.journeyId);
  if (!journey) throw new DomainError('JOURNEY_NOT_FOUND', `No journey ${input.journeyId}.`, 404);
  const allowed: Record<JourneyStatus, JourneyStatus[]> = {
    SCHEDULED: ['DEPARTED', 'CANCELLED'],
    DEPARTED: ['ARRIVED'],
    ARRIVED: [],
    CANCELLED: [],
  };
  if (!allowed[journey.status].includes(input.status)) {
    throw new DomainError('JOURNEY_TRANSITION', `A ${journey.status.toLowerCase()} journey cannot become ${input.status.toLowerCase()}.`, 409);
  }
  if (input.status === 'CANCELLED' && !input.reason?.trim()) {
    throw new DomainError('REASON_REQUIRED', `${journey.booked.length} passenger${journey.booked.length === 1 ? '' : 's'} booked. Say why it is cancelled; they will be told.`, 422);
  }
  const now = new Date().toISOString();
  const updated: TransportJourney = {
    ...journey,
    status: input.status,
    ...(input.status === 'DEPARTED' ? { departedAt: now } : {}),
    ...(input.status === 'ARRIVED' ? { arrivedAt: now } : {}),
    ...(input.status === 'CANCELLED' ? { cancelledReason: input.reason!.trim() } : {}),
  };
  write(ctx, { eventType: 'TRANSPORT_JOURNEY_UPDATED', entity: { refType: 'TransportJourney', refId: journey.id }, nextState: { ...updated } });
  return updated;
}

// --- the desk position ----------------------------------------------------------

export type DeskPosition = {
  assets: { registered: number; onSite: number; offSite: number; defective: number; neverScanned: number; items: ServiceAsset[] };
  deliveries: { expected: number; received: number; short: number; refused: number; overdue: number; items: ServiceDelivery[] };
  accommodation: {
    rooms: Array<AccommodationRoom & { occupants: string[]; free: number }>;
    beds: number;
    occupiedTonight: number;
    available: number;
    cleaning: number;
    outOfService: number;
    arrivalsDue: number;
    /** The demand the system was composed against, where the brief holds it. */
    demandBeds?: number;
    allocations: BedAllocation[];
    statement: string;
  };
  transport: {
    journeys: TransportJourney[];
    today: number;
    seatsOffered: number;
    seatsBooked: number;
    loadFactorPercent: number;
    statement: string;
  };
  statement: string;
};

export function deskPosition(ctx: EngineContext, today = new Date().toISOString().slice(0, 10)): DeskPosition {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'R');

  const assets = assetsOf(ctx);
  const deliveries = deliveriesOf(ctx);
  const rooms = roomsOf(ctx);
  const allocations = allocationsOf(ctx);
  const journeys = journeysOf(ctx);

  const roomsView = rooms.map((room) => {
    const occupants = allocations.filter((entry) => entry.roomId === room.id && entry.status === 'CHECKED_IN').map((entry) => entry.occupant);
    const live = allocations.filter((entry) => entry.roomId === room.id && LIVE.includes(entry.status)).length;
    return { ...room, occupants, free: room.status === 'OUT_OF_SERVICE' ? 0 : Math.max(0, room.beds - live) };
  });
  const beds = rooms.filter((room) => room.status !== 'OUT_OF_SERVICE').reduce((sum, room) => sum + room.beds, 0);
  const occupiedTonight = allocations.filter((entry) => entry.status === 'CHECKED_IN').length;
  const arrivalsDue = allocations.filter((entry) => entry.status === 'ALLOCATED' && entry.from <= today).length;

  const demandFact = ctx.ledger
    .list(ctx.projectId, 'SiteServiceFact')
    .map((record) => record.state as { itemId: string; value: number | string; status: string })
    .find((fact) => fact.itemId === 'accommodatedWorkers' && fact.status === 'KNOWN');
  const demandBeds = demandFact && typeof demandFact.value === 'number' ? demandFact.value : undefined;

  const todaysJourneys = journeys.filter((entry) => entry.departs.slice(0, 10) === today && entry.status !== 'CANCELLED');
  const seatsOffered = todaysJourneys.reduce((sum, entry) => sum + entry.seats, 0);
  const seatsBooked = todaysJourneys.reduce((sum, entry) => sum + entry.booked.length, 0);

  const accommodationStatement =
    rooms.length === 0
      ? 'No room is registered. The composed system says how many beds are needed; until rooms are registered beneath it, nobody can be allocated, checked in or cleaned for.'
      : `${occupiedTonight} in ${beds} bed${beds === 1 ? '' : 's'} tonight, ${roomsView.reduce((sum, room) => sum + room.free, 0)} free, ${arrivalsDue} due to arrive` +
        (demandBeds !== undefined
          ? beds < demandBeds
            ? `. The brief accommodates ${demandBeds}: ${demandBeds - beds} short of the demand the system was composed against.`
            : `, against ${demandBeds} the brief accommodates.`
          : '.');

  return {
    assets: {
      registered: assets.length,
      onSite: assets.filter((entry) => entry.status === 'ON_SITE').length,
      offSite: assets.filter((entry) => entry.status === 'OFF_SITE').length,
      defective: assets.filter((entry) => entry.status === 'DEFECTIVE').length,
      neverScanned: assets.filter((entry) => entry.scans === 0).length,
      items: assets,
    },
    deliveries: {
      expected: deliveries.filter((entry) => entry.status === 'EXPECTED').length,
      received: deliveries.filter((entry) => entry.status === 'RECEIVED').length,
      short: deliveries.filter((entry) => entry.status === 'SHORT').length,
      refused: deliveries.filter((entry) => entry.status === 'REFUSED').length,
      overdue: deliveries.filter((entry) => entry.status === 'EXPECTED' && entry.expectedOn < today).length,
      items: deliveries,
    },
    accommodation: {
      rooms: roomsView,
      beds,
      occupiedTonight,
      available: roomsView.reduce((sum, room) => sum + room.free, 0),
      cleaning: rooms.filter((room) => room.status === 'CLEANING').length,
      outOfService: rooms.filter((room) => room.status === 'OUT_OF_SERVICE').length,
      arrivalsDue,
      ...(demandBeds !== undefined ? { demandBeds } : {}),
      allocations,
      statement: accommodationStatement,
    },
    transport: {
      journeys,
      today: todaysJourneys.length,
      seatsOffered,
      seatsBooked,
      loadFactorPercent: seatsOffered === 0 ? 0 : Math.round((seatsBooked / seatsOffered) * 100),
      statement:
        journeys.length === 0
          ? 'No journey is scheduled. Transport exists as a service family with a KPI; a journey is what the KPI is measured on.'
          : `${todaysJourneys.length} journey${todaysJourneys.length === 1 ? '' : 's'} today, ${seatsBooked} of ${seatsOffered} seats booked.`,
    },
    statement: `${assets.length} asset${assets.length === 1 ? '' : 's'} registered, ${deliveries.filter((entry) => entry.status === 'EXPECTED').length} deliver${deliveries.filter((entry) => entry.status === 'EXPECTED').length === 1 ? 'y' : 'ies'} expected, ${occupiedTonight} in beds tonight, ${todaysJourneys.length} journey${todaysJourneys.length === 1 ? '' : 's'} today.`,
  };
}
