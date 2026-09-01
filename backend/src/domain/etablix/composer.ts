import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { authorise, write, type EngineContext } from '../../engines/context.ts';
import {
  demandPosition,
  deploymentExceptions,
  reforecast,
  type DemandFacts,
  type DemandPosition,
  type DeploymentException,
  type Derivation,
  type Observation,
  type Reforecast,
} from '../../engines/maths/demand.ts';
import { requireModule } from '../../identity/modules.ts';
import { SERVICE_FAMILIES, type ServiceFamily } from './brief.ts';

/**
 * §4 — the Site-Service System Composer.
 *
 * The Composer turns approved requirements into one integrated **System
 * Breakdown Structure**. Each Service System Object connects demand, location,
 * assets, temporary works, utilities, supplier packages, operating tasks,
 * evidence, KPIs, costs, risks, interfaces and removal obligations.
 *
 * ---
 *
 * ## What composing actually does
 *
 * It freezes a **design basis**. The brief keeps moving — a fact is superseded,
 * an assumption is decided, a peak is confirmed — and the compound that was
 * ordered was ordered against the numbers as they stood on a particular
 * Tuesday. So a `ServiceSystem` carries the derivations *as they were when it
 * was composed*, and every read re-derives from the live brief and reports the
 * difference.
 *
 * That comparison is the thing this module exists for. "What has changed since
 * we sized this" is the question that decides whether an order is still right,
 * and a platform that only ever showed today's numbers could not answer it.
 *
 * ## The interface matrix is not a diagram
 *
 * §4's table names, per family, the interfaces that are **non-negotiable** —
 * ground bearing for a compound, discharge consent for temporary MEP, the
 * workforce curve for welfare. Composing a system raises one `ServiceInterface`
 * record per non-negotiable interface, each needing an owner, a due date and an
 * acceptance. An interface with no owner is the definition of the gap that
 * turns up on site.
 *
 * ## What is composed and what is not
 *
 * Composed from real data: the **demand basis**, the **three capacities**, the
 * **interfaces**, the **deployment window** and the **removal obligation**.
 *
 * Not composed, because it cannot honestly be derived from a brief: the asset
 * list, the operating tasks, the supplier package, the KPIs and the cost. Those
 * come from §7 (packages), §9 (tasks and KPIs) and §10 (cost), and each system
 * says which section fills it rather than showing an empty field that reads as
 * "none required".
 */

// --- The non-negotiable interfaces, per family --------------------------------

/**
 * §4's own table, in the words it uses.
 *
 * These are not suggestions and they are not derived from anything: they are
 * the interfaces that, left unowned, produce the failure the whole module
 * exists to prevent — a cabin delivered onto ground that will not carry it, a
 * welfare block with no potable supply, a security perimeter that stops at the
 * compound edge and leaves the laydown open.
 */
export const FAMILY_DESIGN: Record<
  ServiceFamily,
  { outputs: readonly string[]; interfaces: readonly string[]; removal: string }
> = {
  TEMPORARY_INFRASTRUCTURE: {
    outputs: [
      'Compound zoning',
      'Cabins, stores and workshops',
      'Parking',
      'Fencing and signage',
      'Fire points',
      'Furniture and ICT',
      'Capacity and phasing',
    ],
    interfaces: [
      'Ground bearing',
      'Drainage',
      'Power and data',
      'Fire strategy',
      'Accessibility',
      'Security perimeter',
      'Future works',
    ],
    removal:
      'Every cabin, store, fence line and hardstanding removed, the compound area surveyed against the pre-occupation condition, and ICT and furniture returned or disposed of with a record.',
  },
  ENABLING_CIVILS: {
    outputs: [
      'Clearance',
      'Platforms',
      'Roads and walkways',
      'Crane and laydown areas',
      'Drainage',
      'Service trenches',
      'Foundations',
      'Dust and mud control',
      'Condition survey',
      'Restoration',
    ],
    interfaces: [
      'Earthworks balance',
      'Permits',
      'Buried services',
      'Design loads',
      'Permanent works clashes',
      'Landowner criteria',
    ],
    removal:
      'Foundations, hardstanding, drainage and haul routes broken out or left in place by agreement, material reuse and waste evidenced, and the land restored to the recorded criterion.',
  },
  TEMPORARY_MEP: {
    outputs: [
      'Load schedules',
      'Generation and grid strategy',
      'Distribution',
      'Lighting',
      'HVAC',
      'Water',
      'Foul',
      'Fire alarm',
      'Data',
      'Metering',
      'Test and inspection regime',
    ],
    interfaces: [
      'Demand coincidence',
      'Fuel logistics',
      'Earthing',
      'Discharge consent',
      'Redundancy',
      'Asset energisation and isolation',
    ],
    removal:
      'Services isolated and capped by a competent person, tanks cleaned, discharge consents closed, meters read and reconciled, and generation, cabling and distribution off-hired against a return condition.',
  },
  WELFARE_ACCOMMODATION: {
    outputs: [
      'WCs',
      'Showers',
      'Drying and changing',
      'Canteens',
      'First aid',
      'Quiet and prayer areas',
      'Rooms',
      'Laundries',
      'Kitchens',
      'Recreation',
      'Occupancy allocation',
    ],
    interfaces: [
      'Workforce curve',
      'Shifts',
      'Inclusivity',
      'Safeguarding',
      'Cleaning',
      'Fire',
      'Transport',
      'Potable water and waste',
    ],
    removal:
      'Occupancy run down without dropping below the statutory minimum for whoever is still on site, rooms inventoried against damage, and the block released only once a successor facility is accepted.',
  },
  CLEANING_FM: {
    outputs: [
      'Area schedules',
      'Frequencies',
      'Task standards',
      'Linen and laundry',
      'Pest control',
      'Waste',
      'Consumables',
      'Helpdesk',
      'PPM',
      'Reactive response',
    ],
    interfaces: [
      'Occupancy',
      'Room status',
      'Infection control',
      'Asset data',
      'Stores',
      'Waste routes',
      'Service windows',
    ],
    removal:
      'Final deep clean, consumables and stock reconciled, waste containers removed with consignment notes, and the helpdesk closed with its open tickets transferred or discharged.',
  },
  SECURITY_LOGISTICS: {
    outputs: [
      'Posts',
      'CCTV',
      'Access zones',
      'Credentials',
      'Deliveries',
      'Booking slots',
      'Marshals',
      'Buses and routes',
      'Parking',
      'Journey plans',
    ],
    interfaces: [
      'Induction',
      'Workforce roster',
      'Emergency plan',
      'Gate capacity',
      'Public interface',
      'Working hours',
      'Fatigue',
    ],
    removal:
      'Credentials revoked, CCTV footage retained or destroyed per the retention policy, posts stood down only once the site is secured by its successor, and transport contracts closed against the last shift.',
  },
  PROCUREMENT_CONTROL: {
    outputs: [
      'Package strategy',
      'Market map',
      'PQQ and ITT',
      'Evaluation',
      'Mobilisation evidence',
      'Contracts',
      'KPI and escalation',
    ],
    interfaces: [
      'Model responsibility',
      'Authority',
      'Insurance',
      'Payment route',
      'Sanctions',
      'Local content',
      'Data privacy',
    ],
    removal:
      'Every contract closed against a final account, retention released or its release date recorded, supplier performance scored, and residual liability dates carried forward.',
  },
};

/**
 * Which derivations belong to which family.
 *
 * A system shows the capacities it is actually designed against rather than all
 * of them. Concurrent occupancy appears under welfare because that is what it
 * sizes, and it is *referenced* by the others through the interface matrix
 * rather than repeated in each.
 */
const FAMILY_DERIVATIONS: Record<ServiceFamily, readonly string[]> = {
  TEMPORARY_INFRASTRUCTURE: ['concurrentOccupancy'],
  ENABLING_CIVILS: [],
  TEMPORARY_MEP: ['maximumDemand', 'potableWater', 'wastewater', 'tankerFrequency'],
  WELFARE_ACCOMMODATION: ['concurrentOccupancy', 'sanitaryProvision', 'showerProvision', 'bedDemand'],
  CLEANING_FM: ['cleaningHours', 'wasteVolume'],
  SECURITY_LOGISTICS: ['gateClearance', 'transportSeats'],
  PROCUREMENT_CONTROL: [],
};

// --- Records ------------------------------------------------------------------

export type ServiceSystem = {
  id: string;
  projectId: string;
  family: ServiceFamily;
  label: string;
  /** Where on site. A system is zone-specific; two compounds are two systems. */
  zone: string;
  fromDate: string;
  toDate: string;
  leadDays: number;
  composedBy: string;
  composedAt: string;
  /** The derivations as they stood when this was composed. The design basis. */
  basis: Derivation[];
  /** What §4 says this family produces. */
  outputs: readonly string[];
  removalObligation: string;
  /**
   * The fields §14 names that a brief cannot supply, and which section fills
   * each. Present so an empty field reads as "not built yet" rather than "none
   * required", which are opposite statements.
   */
  awaiting: { field: string; from: string }[];
  version: number;
};

export type InterfaceStatus = 'OPEN' | 'ACCEPTED';

export type ServiceInterface = {
  id: string;
  projectId: string;
  systemId: string;
  family: ServiceFamily;
  /** The non-negotiable interface, from §4's table. */
  name: string;
  /** The system or party on the other side, once somebody names it. */
  counterparty?: string;
  owner?: string;
  dueDate?: string;
  status: InterfaceStatus;
  /** What happens if it is never closed. Stated at creation, not at failure. */
  consequence: string;
  acceptedBy?: string;
  acceptedAt?: string;
  acceptanceNote?: string;
};

function systemsOf(ctx: EngineContext): ServiceSystem[] {
  return ctx.ledger.list(ctx.projectId, 'ServiceSystem').map((record) => record.state as unknown as ServiceSystem);
}

function interfacesOf(ctx: EngineContext): ServiceInterface[] {
  return ctx.ledger
    .list(ctx.projectId, 'ServiceInterface')
    .map((record) => record.state as unknown as ServiceInterface);
}

/** The live brief, in the shape the demand engine takes. */
export function factsFor(ctx: EngineContext): DemandFacts {
  const facts: DemandFacts = {};
  /** The id behind each fact, so the tiebreak below has something to compare. */
  const idOf = new Map<string, string>();

  for (const record of ctx.ledger.list(ctx.projectId, 'SiteServiceFact')) {
    const state = record.state as unknown as {
      id: string;
      itemId: string;
      value: number | string;
      status: 'KNOWN' | 'PROVISIONAL';
      source: string;
      supersededBy?: string;
    };
    if (state.supersededBy) continue;
    // Only numbers reach the demand engine. A date or a standard is a fact and
    // is not an input to arithmetic; passing one through would make every
    // comparison against it quietly false.
    if (typeof state.value !== 'number') continue;
    // ULIDs are monotonic, so the later id is the later fact — said explicitly
    // rather than relying on how the ledger happens to order a list.
    const held = idOf.get(state.itemId);
    if (held && held > state.id) continue;
    idOf.set(state.itemId, state.id);
    facts[state.itemId] = { value: state.value, status: state.status, source: state.source };
  }
  return facts;
}

/**
 * Compose one service system.
 *
 * `C` on `SITE_SERVICES`. Composing freezes the design basis and raises the
 * interface matrix for the family — one record per non-negotiable interface,
 * every one of them open and unowned until somebody takes it.
 *
 * Refused where the family has derivations and none of them can be run. A
 * system composed against nothing is a record asserting a design basis that
 * does not exist, and it would then sit in the SBS looking like one that does.
 */
export function composeSystem(
  ctx: EngineContext,
  input: { family: string; zone: string; fromDate: string; toDate: string; leadDays: number },
): { system: ServiceSystem; interfaces: ServiceInterface[] } {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C');

  if (!(input.family in SERVICE_FAMILIES)) {
    throw new DomainError('SERVICE_FAMILY_UNKNOWN', `${input.family} is not one of the seven service families`, 404);
  }
  const family = input.family as ServiceFamily;

  if (!input.zone?.trim()) {
    throw new DomainError(
      'SERVICE_ZONE_REQUIRED',
      'A service system is zone-specific. Two compounds are two systems with two demand bases, and merging them hides the one that is short.',
    );
  }
  if (!isDate(input.fromDate) || !isDate(input.toDate)) {
    throw new DomainError('SERVICE_WINDOW_INVALID', 'A deployment window needs a start and an end, as YYYY-MM-DD');
  }
  if (input.toDate <= input.fromDate) {
    throw new DomainError('SERVICE_WINDOW_INVALID', 'A service cannot come off site before it goes on');
  }
  if (!Number.isInteger(input.leadDays) || input.leadDays < 0) {
    throw new DomainError(
      'SERVICE_LEAD_INVALID',
      'Lead time is the days between ordering it and it being usable. Zero is an answer; absent is not.',
    );
  }

  const existing = systemsOf(ctx).find((system) => system.family === family && system.zone === input.zone.trim());
  if (existing) {
    throw new DomainError(
      'SERVICE_SYSTEM_EXISTS',
      `${SERVICE_FAMILIES[family].label} is already composed for ${existing.zone}. Recompose it rather than composing a second.`,
      409,
    );
  }

  const position = demandPosition(factsFor(ctx));
  const wanted = FAMILY_DERIVATIONS[family];
  const basis = position.derivations.filter((derivation) => wanted.includes(derivation.id));

  if (wanted.length > 0 && basis.length === 0) {
    throw new DomainError(
      'SERVICE_BASIS_ABSENT',
      `Nothing this family is sized on can be derived yet. Missing: ${position.notDerivable
        .filter((entry) => wanted.includes(entry.id))
        .flatMap((entry) => entry.missing)
        .join(', ')}. A system composed against nothing asserts a design basis that does not exist.`,
    );
  }

  const at = new Date().toISOString();
  const system: ServiceSystem = {
    id: ulid(),
    projectId: ctx.projectId,
    family,
    label: SERVICE_FAMILIES[family].label,
    zone: input.zone.trim(),
    fromDate: input.fromDate,
    toDate: input.toDate,
    leadDays: input.leadDays,
    composedBy: ctx.auth.actorId,
    composedAt: at,
    basis,
    outputs: FAMILY_DESIGN[family].outputs,
    removalObligation: FAMILY_DESIGN[family].removal,
    awaiting: [
      { field: 'Assets', from: '§8 mobilisation — the asset register is populated as things arrive and are tested' },
      { field: 'Operating tasks', from: '§9 live operations — the service regime and its work orders' },
      { field: 'Supplier package', from: '§7 procurement — the package this system is let under' },
      { field: 'KPIs', from: '§9.2 the KPI contract, with its anti-gaming controls' },
      { field: 'Cost', from: '§10 commercial control — budget, commitment and earned value by SBS line' },
    ],
    version: 1,
  };

  write(ctx, {
    eventType: 'SERVICE_SYSTEM_COMPOSED',
    entity: { refType: 'ServiceSystem', refId: system.id },
    nextState: system,
  });

  // The interface matrix. One record per non-negotiable interface, open and
  // unowned — because an interface nobody has taken is exactly the gap that
  // turns up on site, and it has to be visible as a gap rather than absent.
  const interfaces = FAMILY_DESIGN[family].interfaces.map((name) => {
    const record: ServiceInterface = {
      id: ulid(),
      projectId: ctx.projectId,
      systemId: system.id,
      family,
      name,
      status: 'OPEN',
      consequence: consequenceOf(family, name),
    };
    write(ctx, {
      eventType: 'SERVICE_INTERFACE_RAISED',
      entity: { refType: 'ServiceInterface', refId: record.id },
      nextState: record,
    });
    return record;
  });

  return { system, interfaces };
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * What happens if an interface is never closed.
 *
 * Written at creation rather than at failure, because the consequence is what
 * makes somebody take the interface — and a matrix of names with no consequences
 * is a table people tick rather than a list of things that will go wrong.
 */
function consequenceOf(family: ServiceFamily, name: string): string {
  const specific: Record<string, string> = {
    'Ground bearing':
      'Cabins delivered onto ground that will not carry them. The crane pad is the same question and it is the one that hurts.',
    Drainage: 'Surface water in the compound and a discharge nobody has consent for.',
    'Power and data': 'A compound built where the supply cannot reach it, discovered after the hardstanding is down.',
    'Fire strategy': 'Escape routes and fire points designed for a layout that has since changed.',
    Accessibility: 'A welfare block somebody cannot use, which is a discrimination matter as well as a design one.',
    'Security perimeter': 'A fence line that stops at the compound and leaves the laydown open.',
    'Future works': 'A compound sitting exactly where the permanent works need to be in month nine.',
    'Earthworks balance': 'Material exported and then imported back, paid for twice.',
    Permits: 'Work stopped by an authority nobody applied to in time.',
    'Buried services': 'A strike. The most common way a temporary works job becomes a RIDDOR report.',
    'Design loads': 'A platform that carries the cabins and not the crane that lifts them.',
    'Permanent works clashes': 'Enabling works built into the footprint of what they were enabling.',
    'Landowner criteria': 'A reinstatement standard nobody agreed, argued about after the plant has gone.',
    'Demand coincidence':
      'Loads added up as though everything runs at once, or diversity applied twice — the two ways a supply is wrong.',
    'Fuel logistics': 'A generator with no delivery slot, on a site with no road wide enough for the tanker.',
    Earthing: 'A distribution system nobody can energise, and a safety matter before it is a programme one.',
    'Discharge consent': 'Foul with nowhere lawful to go, and a tankering bill that was never priced.',
    Redundancy: 'A single point of failure on the supply that stops the whole site.',
    'Asset energisation and isolation':
      'Nobody named to energise or isolate, which is the gate a competent person has to hold.',
    'Workforce curve': 'Welfare sized to a headcount the programme abandoned two revisions ago.',
    Shifts: 'A changeover nobody counted, and welfare that clears one shift and not two.',
    Inclusivity: 'Facilities that do not serve the whole workforce, found out by the people they exclude.',
    Safeguarding: 'Accommodation with no policy for who may be where, which is unmanageable after an incident.',
    Cleaning: 'A welfare block that meets the statutory count and fails the first inspection on condition.',
    Fire: 'Alarm coverage that does not follow the block it protects.',
    Transport: 'Accommodation with no way to site, or a bus timetable that misses the shift.',
    'Potable water and waste': 'Welfare with no supply, or a foul tank nobody is emptying.',
    Occupancy: 'Cleaning frequencies set against an occupancy that has doubled.',
    'Room status': 'Rooms cleaned that are empty and skipped that are not.',
    'Infection control': 'An outbreak in shared accommodation with no isolation plan.',
    'Asset data': 'PPM against an asset list that does not match what is on site.',
    Stores: 'Consumables run out mid-shift because nobody owns the reorder point.',
    'Waste routes': 'Waste that cannot leave the compound because the route was never agreed.',
    'Service windows': 'Cleaning and maintenance scheduled into hours the space is occupied.',
    Induction: 'People at the gate who cannot be let in, every morning.',
    'Workforce roster': 'Security and transport sized against a roster nobody shares.',
    'Emergency plan': 'A muster point and a route nobody has reconciled with the compound layout.',
    'Gate capacity': 'A shift that loses time at the turnstile every day of the job.',
    'Public interface': 'Deliveries queuing on a public road, which is a highways matter within a week.',
    'Working hours': 'A security rota that does not cover the hours the site is live.',
    Fatigue: 'Journey plans and shift lengths that breach the driving rules.',
    'Model responsibility': 'Nobody clear on who contracts, which is the argument this whole module exists to end.',
    Authority: 'Instructions given by somebody with no power to give them.',
    Insurance: 'A supplier on site whose cover lapsed, discovered at the claim.',
    'Payment route': 'A valuation with nowhere to go and a supplier who stops attending.',
    Sanctions: 'An entity nobody screened, which is a criminal exposure rather than a commercial one.',
    'Local content': 'A commitment made to a client and never passed to the supply chain.',
    'Data privacy': 'Worker and visitor data held with no basis and no retention limit.',
  };
  return (
    specific[name] ??
    `Unowned, this interface between ${SERVICE_FAMILIES[family].label.toLowerCase()} and its neighbour is closed by whoever notices it first, on site.`
  );
}

/**
 * Take an interface, with a date.
 *
 * `U` on `SITE_SERVICES`. An owner and a due date together, because either
 * alone is unmanageable: an owner with no date cannot be late, and a date with
 * no owner is nobody's.
 */
export function assignInterface(
  ctx: EngineContext,
  input: { interfaceId: string; owner: string; dueDate: string; counterparty?: string },
): ServiceInterface {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'U');

  const record = interfacesOf(ctx).find((entry) => entry.id === input.interfaceId);
  if (!record) throw new DomainError('SERVICE_INTERFACE_NOT_FOUND', 'No such interface on this project', 404);
  if (record.status === 'ACCEPTED') {
    throw new DomainError('SERVICE_INTERFACE_ACCEPTED', 'That interface is closed. Reopening it is a change, not an edit.');
  }
  if (!input.owner?.trim()) throw new DomainError('SERVICE_INTERFACE_UNOWNED', 'An interface needs a person, not a team');
  if (!isDate(input.dueDate)) {
    throw new DomainError(
      'SERVICE_INTERFACE_UNDATED',
      'An interface with no date is one nobody can be late on, which means it cannot be managed and cannot be claimed against either.',
    );
  }

  const updated: ServiceInterface = {
    ...record,
    owner: input.owner.trim(),
    dueDate: input.dueDate,
    ...(input.counterparty?.trim() ? { counterparty: input.counterparty.trim() } : {}),
  };
  write(ctx, {
    eventType: 'SERVICE_INTERFACE_ASSIGNED',
    entity: { refType: 'ServiceInterface', refId: record.id },
    nextState: updated,
  });
  return updated;
}

/**
 * Close an interface.
 *
 * `A` on `SITE_SERVICES` — acceptance, not an update. Refused while it has no
 * owner: an interface accepted by nobody in particular is the same as one never
 * raised, and it would leave the matrix reading complete.
 */
export function acceptInterface(
  ctx: EngineContext,
  input: { interfaceId: string; note: string },
): ServiceInterface {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'A');

  const record = interfacesOf(ctx).find((entry) => entry.id === input.interfaceId);
  if (!record) throw new DomainError('SERVICE_INTERFACE_NOT_FOUND', 'No such interface on this project', 404);
  if (record.status === 'ACCEPTED') return record;
  if (!record.owner) {
    throw new DomainError(
      'SERVICE_INTERFACE_UNOWNED',
      'An interface nobody took cannot be accepted. Assign it first, so the record says who answered for it.',
    );
  }
  if (!input.note?.trim()) {
    throw new DomainError(
      'SERVICE_INTERFACE_UNEVIDENCED',
      'Say what closes it — the drawing, the survey, the consent or the agreement. "Accepted" on its own proves nothing later.',
    );
  }

  const updated: ServiceInterface = {
    ...record,
    status: 'ACCEPTED',
    acceptedBy: ctx.auth.actorId,
    acceptedAt: new Date().toISOString(),
    acceptanceNote: input.note.trim(),
  };
  write(ctx, {
    eventType: 'SERVICE_INTERFACE_ACCEPTED',
    entity: { refType: 'ServiceInterface', refId: record.id },
    nextState: updated,
  });
  return updated;
}

/**
 * Record what a service actually consumed.
 *
 * The input to §4.1's fifth calculation control. A meter reading, a fuel
 * delivery, a tanker ticket or a headcount — the observation is a fact about
 * the world, and what the platform does with it is propose, never reduce.
 */
export function recordObservation(
  ctx: EngineContext,
  input: { derivationId: string; observed: number; over: string; source: string },
): Observation & { id: string } {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C');

  if (!Number.isFinite(input.observed) || input.observed < 0) {
    throw new DomainError('OBSERVATION_INVALID', 'An observation is a measured quantity that is not negative');
  }
  if (!input.over?.trim()) {
    throw new DomainError(
      'OBSERVATION_UNPERIODISED',
      'Say what period it was measured over. A consumption figure with no period cannot be compared to a daily or weekly basis.',
    );
  }
  if (!input.source?.trim()) {
    throw new DomainError('OBSERVATION_UNSOURCED', 'A meter, a ticket or a count — say which');
  }

  const record = {
    id: ulid(),
    derivationId: input.derivationId,
    observed: input.observed,
    over: input.over.trim(),
    source: input.source.trim(),
    recordedBy: ctx.auth.actorId,
    recordedAt: new Date().toISOString(),
  };
  write(ctx, {
    eventType: 'SERVICE_OBSERVATION_RECORDED',
    entity: { refType: 'ServiceObservation', refId: record.id },
    nextState: record,
  });
  return record;
}

// --- The SBS, read back --------------------------------------------------------

export type SystemDrift = {
  derivationId: string;
  label: string;
  unit: string;
  composedAt: number;
  now: number;
  /** Positive means demand has grown since the basis was frozen. */
  changePercent: number;
  consequence: string;
};

export type ComposedSystem = ServiceSystem & {
  interfaces: ServiceInterface[];
  openInterfaces: number;
  /** Where the live brief no longer agrees with the frozen basis. */
  drift: SystemDrift[];
};

export type SbsPosition = {
  systems: ComposedSystem[];
  /** Every family, so what has not been composed is visible as a gap. */
  uncomposed: { family: ServiceFamily; label: string; scope: string }[];
  /** The live demand engine output, whether or not anything is composed. */
  demand: DemandPosition;
  deployment: DeploymentException[];
  reforecasts: Reforecast[];
  interfaceMatrix: { name: string; open: number; accepted: number; unowned: number }[];
};

export function sbs(ctx: EngineContext, today?: string): SbsPosition {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'R');

  const systems = systemsOf(ctx);
  const allInterfaces = interfacesOf(ctx);
  const demand = demandPosition(factsFor(ctx));
  const liveById = new Map(demand.derivations.map((derivation) => [derivation.id, derivation]));

  const composed: ComposedSystem[] = systems.map((system) => {
    const interfaces = allInterfaces.filter((entry) => entry.systemId === system.id);
    return {
      ...system,
      interfaces,
      openInterfaces: interfaces.filter((entry) => entry.status === 'OPEN').length,
      // The comparison this module exists for. The compound was ordered against
      // the numbers as they stood on a particular day, and the brief has moved
      // since.
      drift: system.basis.flatMap((frozen) => {
        const live = liveById.get(frozen.id);
        if (!live || live.normal === frozen.normal) return [];
        const change = frozen.normal > 0 ? ((live.normal - frozen.normal) / frozen.normal) * 100 : 100;
        return [
          {
            derivationId: frozen.id,
            label: frozen.label,
            unit: frozen.unit,
            composedAt: frozen.normal,
            now: live.normal,
            changePercent: Math.round(change * 10) / 10,
            consequence:
              change > 0
                ? 'The system was sized below what the brief now says it needs. Whatever was ordered against the frozen basis is short.'
                : 'The brief now says less than the system was sized for. That is spare capacity being paid for, and it is not a reason to reduce anything without change control.',
          },
        ];
      }),
    };
  });

  const observations = ctx.ledger
    .list(ctx.projectId, 'ServiceObservation')
    .map((record) => record.state as unknown as Observation);

  // The interface matrix, rolled up by name across every system — because the
  // question "who owns ground bearing on this job" is asked once, not per zone.
  const names = [...new Set(allInterfaces.map((entry) => entry.name))].sort();

  return {
    systems: composed,
    uncomposed: (Object.keys(SERVICE_FAMILIES) as ServiceFamily[])
      .filter((family) => !systems.some((system) => system.family === family))
      .map((family) => ({ family, label: SERVICE_FAMILIES[family].label, scope: SERVICE_FAMILIES[family].scope })),
    demand,
    deployment: deploymentExceptions(
      systems.map((system) => ({
        systemId: system.id,
        label: `${system.label} (${system.zone})`,
        fromDate: system.fromDate,
        toDate: system.toDate,
        leadDays: system.leadDays,
      })),
      dependenciesBetween(systems),
      today ?? new Date().toISOString().slice(0, 10),
    ),
    // Against the **frozen** basis, not the live re-derivation.
    //
    // "Observed consumption vs basis" means the figure the service was sized,
    // contracted and priced against — and that figure stopped moving the day
    // the system was composed. Comparing a meter reading to a number that
    // shifts every time the brief does produces a variance that reflects the
    // brief rather than the consumption, which is the opposite of the control's
    // purpose.
    //
    // An observation against a capacity nobody has composed has no design basis
    // to compare to, and is left out rather than measured against a live figure
    // nothing was ordered on.
    reforecasts: reforecast(frozenBases(systems), observations),
    interfaceMatrix: names.map((name) => {
      const held = allInterfaces.filter((entry) => entry.name === name);
      return {
        name,
        open: held.filter((entry) => entry.status === 'OPEN').length,
        accepted: held.filter((entry) => entry.status === 'ACCEPTED').length,
        unowned: held.filter((entry) => entry.status === 'OPEN' && !entry.owner).length,
      };
    }),
  };
}

/**
 * The design bases in force, across every composed system.
 *
 * One derivation per id. Where two systems in different zones carry the same
 * capacity, the later composition wins — a reforecast is a project-level
 * comparison and there is no zone on a meter reading. That is a limitation
 * worth naming rather than hiding: per-zone observations need a zone on the
 * observation, and nothing yet supplies one.
 */
function frozenBases(systems: readonly ServiceSystem[]): Derivation[] {
  const held = new Map<string, Derivation>();
  for (const system of [...systems].sort((a, b) => a.composedAt.localeCompare(b.composedAt))) {
    for (const derivation of system.basis) held.set(derivation.id, derivation);
  }
  return [...held.values()];
}

/**
 * Which systems cannot come out before which others.
 *
 * Derived from the families rather than declared, because these dependencies
 * are physical and are the same on every job: welfare cannot outlast the
 * services feeding it, and nothing can outlast the compound it stands in.
 */
function dependenciesBetween(systems: readonly ServiceSystem[]): { from: string; to: string; note: string }[] {
  const byFamily = new Map(systems.map((system) => [system.family, system]));
  const pairs: [ServiceFamily, ServiceFamily, string][] = [
    ['TEMPORARY_MEP', 'WELFARE_ACCOMMODATION', 'Welfare has no power, water or foul without it.'],
    ['TEMPORARY_MEP', 'CLEANING_FM', 'Cleaning and laundry stop with the water.'],
    ['TEMPORARY_MEP', 'SECURITY_LOGISTICS', 'CCTV, lighting and access control run off it.'],
    ['TEMPORARY_INFRASTRUCTURE', 'WELFARE_ACCOMMODATION', 'The welfare block stands in the compound.'],
    ['TEMPORARY_INFRASTRUCTURE', 'SECURITY_LOGISTICS', 'The gate and the posts are part of the compound.'],
    ['ENABLING_CIVILS', 'TEMPORARY_INFRASTRUCTURE', 'The compound sits on the platform and the roads reach it.'],
  ];

  return pairs.flatMap(([from, to, note]) => {
    const supplier = byFamily.get(from);
    const dependent = byFamily.get(to);
    return supplier && dependent ? [{ from: supplier.id, to: dependent.id, note }] : [];
  });
}

/**
 * Re-freeze a system against the brief as it now stands.
 *
 * `A` on `SITE_SERVICES`, not `U`. Recomposing changes what the service is
 * designed to deliver, and the previous basis stays on the record — the whole
 * point of freezing one is being able to say what was ordered against what.
 */
export function recomposeSystem(ctx: EngineContext, input: { systemId: string; reason: string }): ServiceSystem {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'A');

  const system = systemsOf(ctx).find((entry) => entry.id === input.systemId);
  if (!system) throw new DomainError('SERVICE_SYSTEM_NOT_FOUND', 'No such service system on this project', 404);
  if (!input.reason?.trim()) {
    throw new DomainError('SERVICE_RECOMPOSE_UNREASONED', 'Say why the design basis is being changed');
  }

  const wanted = FAMILY_DERIVATIONS[system.family];
  const basis = demandPosition(factsFor(ctx)).derivations.filter((derivation) => wanted.includes(derivation.id));

  const updated: ServiceSystem = {
    ...system,
    basis,
    version: system.version + 1,
    composedBy: ctx.auth.actorId,
    composedAt: new Date().toISOString(),
  };
  write(ctx, {
    eventType: 'SERVICE_SYSTEM_RECOMPOSED',
    entity: { refType: 'ServiceSystem', refId: system.id },
    nextState: { ...updated, recomposeReason: input.reason.trim(), previousVersion: system.version },
  });
  return updated;
}
