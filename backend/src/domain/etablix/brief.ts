import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { authorise, write, type EngineContext } from '../../engines/context.ts';
import { requireModule } from '../../identity/modules.ts';
import { statutoryWcs } from '../../engines/maths/demand.ts';

/**
 * §3 — the Customer Brief Intelligence Gateway, for site services.
 *
 * The module begins with evidence, not a blank questionnaire. A customer hands
 * over a programme, a layout, an employer's requirements and a workforce curve,
 * and somewhere in them are the two dozen numbers that decide how many WCs,
 * how much power, how many buses and how many beds. They are never all there,
 * and the ones that are missing are never the ones anybody notices.
 *
 * ---
 *
 * ## What this is not, because most of it already exists
 *
 * `domain/conceptbrief.ts` is the requirements register and stays it. It holds
 * requirement *statements* with their source, confidence, author, supersession
 * and verification method; it refuses to baseline a requirement with no
 * verification method; it makes an AI-extracted requirement visibly unaccepted.
 * None of that is rebuilt here and none of it is copied.
 *
 * What it cannot hold is a **number with a unit**. "Welfare shall comply with
 * Schedule 1" is a requirement. "The peak is 164 people across two shifts" is a
 * fact, and it is the fact — not the requirement — that decides whether five
 * WCs is enough. The two are different objects: a requirement is argued about,
 * a fact is measured, and a register that mixed them would be unable to check
 * either against the other.
 *
 * So a `SiteServiceFact` is its own record, and it carries a `requirementId`
 * where it was read off an accepted requirement. That is the link between the
 * two registers rather than a merge of them.
 *
 * ## Two rules from the specification that shape everything here
 *
 * **"A percentage alone is forbidden."** Completeness is reported by service
 * family, and every gap carries four things: what it decides, the date after
 * which the answer arrives too late, what would be assumed in the meantime, and
 * whose answer it is. A bare 72% tells somebody they are mostly fine, which is
 * the opposite of true when the missing 28% is the electrical load.
 *
 * **"Agents may not silently replace missing facts."** A provisional value is a
 * distinct state, not a value with a flag. It is tagged, it names the basis it
 * was assumed on, and it carries a decision date and an owner — refused
 * outright without them, because a provisional assumption nobody owns and
 * nothing expires is simply a wrong number that has stopped being questioned.
 */

// --- The seven families ------------------------------------------------------

export const SERVICE_FAMILIES = {
  TEMPORARY_INFRASTRUCTURE: {
    label: 'Temporary infrastructure and compounds',
    scope: 'Compound zoning, cabins, stores, workshops, parking, fencing, signage, fire points, furniture and ICT.',
  },
  ENABLING_CIVILS: {
    label: 'Enabling civils and reinstatement',
    scope: 'Clearance, platforms, roads, walkways, crane and laydown areas, drainage, service trenches, restoration.',
  },
  TEMPORARY_MEP: {
    label: 'Temporary MEP and building services',
    scope: 'Load schedules, generation and grid strategy, distribution, lighting, HVAC, water, foul, fire alarm, metering.',
  },
  WELFARE_ACCOMMODATION: {
    label: 'Welfare and accommodation',
    scope: 'WCs, showers, drying and changing, canteens, first aid, quiet and prayer areas, rooms, laundries, kitchens.',
  },
  CLEANING_FM: {
    label: 'Cleaning, FM and living services',
    scope: 'Area schedules, frequencies, task standards, linen, laundry, pest, waste, consumables, helpdesk, PPM.',
  },
  SECURITY_LOGISTICS: {
    label: 'Security, access, logistics and transport',
    scope: 'Posts, CCTV, access zones, credentials, deliveries, booking slots, marshals, buses, routes, parking.',
  },
  PROCUREMENT_CONTROL: {
    label: 'Procurement and supplier control',
    scope: 'Package strategy, market map, PQQ and ITT, evaluation, mobilisation evidence, contracts, KPI and escalation.',
  },
} as const;

export type ServiceFamily = keyof typeof SERVICE_FAMILIES;

/**
 * What a missing fact actually moves.
 *
 * The spec's adaptive-interview rule: the agent asks only questions that change
 * capacity, cost, risk, sequence, contract or acceptance. Declared per item so
 * the interview is derived from the catalogue rather than curated beside it —
 * a question that moves none of these is one nobody should be asked, and an
 * item with an empty list would be caught by the invariant below.
 */
export const CHANGES = ['CAPACITY', 'COST', 'RISK', 'SEQUENCE', 'CONTRACT', 'ACCEPTANCE'] as const;
export type Changes = (typeof CHANGES)[number];

export type BriefItem = {
  id: string;
  family: ServiceFamily;
  label: string;
  unit: string;
  /** What cannot be calculated without it. The consequence, in one sentence. */
  decides: string;
  /** The question, in the words it would be asked in. */
  question: string;
  changes: readonly Changes[];
  /**
   * What the platform would assume, and why.
   *
   * Stated in the catalogue rather than invented at the point of use, so a
   * provisional value is a published position somebody can disagree with rather
   * than a number that appeared.
   */
  provisionalBasis: string;
};

/**
 * The facts a site-services system cannot be designed without.
 *
 * Each one is an input to a demand calculation in §4.1 — concurrent occupancy,
 * sanitary provision, water storage autonomy, maximum electrical demand, bed
 * nights, cleaning hours, gate throughput, bus seats, waste volume. That is
 * what makes the list load-bearing rather than a questionnaire: an item is
 * missing exactly when a calculation cannot run.
 */
export const BRIEF_ITEMS: readonly BriefItem[] = [
  // --- Demand, which almost everything else is derived from ------------------
  {
    id: 'peakWorkforce',
    family: 'WELFARE_ACCOMMODATION',
    label: 'Peak workforce on site',
    unit: 'persons',
    decides: 'Every welfare quantity, the canteen, the bus fleet and the gate throughput.',
    question: 'What is the peak number of people on site in a single day, across all shifts and trades?',
    changes: ['CAPACITY', 'COST', 'SEQUENCE'],
    provisionalBasis: 'The programme’s own resource histogram peak, if a programme has been loaded.',
  },
  {
    id: 'shiftOverlapPersons',
    family: 'WELFARE_ACCOMMODATION',
    label: 'People on site during shift changeover',
    unit: 'persons',
    decides:
      'Concurrent occupancy, which is what welfare is actually sized on — not the daily total, which nobody is ever all present for.',
    question: 'How many people are on site at once during the busiest shift changeover?',
    changes: ['CAPACITY', 'COST'],
    provisionalBasis: 'Both shifts fully overlapping for the changeover hour, which is the worst credible case.',
  },
  {
    id: 'visitorsPerDay',
    family: 'SECURITY_LOGISTICS',
    label: 'Visitors per day',
    unit: 'persons',
    decides: 'Gate throughput, induction capacity, visitor parking and the welfare margin.',
    question: 'How many visitors, deliveries drivers and inspectors come through the gate on a busy day?',
    changes: ['CAPACITY', 'RISK'],
    provisionalBasis: '10% of the peak workforce, which is typical for a project of this shape.',
  },
  {
    id: 'peakDurationDays',
    family: 'WELFARE_ACCOMMODATION',
    label: 'How long the peak lasts',
    unit: 'consecutive days',
    decides:
      'Whether the peak is designed for or managed. A two-day peak sized into permanent welfare is hire nobody needed for the other fifty weeks.',
    question: 'How many consecutive days does the workforce sit at its peak?',
    changes: ['CAPACITY', 'COST'],
    provisionalBasis: 'Sustained, which is the expensive assumption and the one that never leaves anybody short.',
  },
  {
    id: 'plannedGrowthPercent',
    family: 'WELFARE_ACCOMMODATION',
    label: 'Planned growth above the current peak',
    unit: '%',
    decides: 'The peak design capacity, and therefore what has to be ordered rather than added later at a premium.',
    question: 'How much growth above today’s peak should the design carry, and on what basis?',
    changes: ['CAPACITY', 'COST', 'SEQUENCE'],
    provisionalBasis: '10%, which absorbs an ordinary programme change and not a scope one.',
  },
  {
    id: 'connectedLoadKva',
    family: 'TEMPORARY_MEP',
    label: 'Connected electrical load',
    unit: 'kVA',
    decides:
      'The maximum demand once diversity is applied, and whether a stated demand figure was derived from anything.',
    question: 'What is the total connected load of the cabins, welfare, workshops and site plant?',
    changes: ['CAPACITY', 'COST'],
    provisionalBasis: 'Derived from the cabin and welfare schedule at published unit loads.',
  },
  {
    id: 'foulTankCapacityM3',
    family: 'TEMPORARY_MEP',
    label: 'Foul storage capacity',
    unit: 'm³',
    decides: 'How often a tanker must attend, and whether the achievable interval keeps up with it.',
    question: 'What foul storage is on site, and what is its working capacity?',
    changes: ['CAPACITY', 'RISK'],
    provisionalBasis: 'None, until a foul strategy exists.',
  },
  {
    id: 'operatingHours',
    family: 'SECURITY_LOGISTICS',
    label: 'Site operating hours',
    unit: 'hours per day',
    decides: 'Security posts, lighting, cleaning windows, transport timetables and the whole shift model.',
    question: 'What hours is the site live — single shift, double shift, or continuous?',
    changes: ['CAPACITY', 'COST', 'SEQUENCE', 'CONTRACT'],
    provisionalBasis: 'A single 10-hour day shift, which is the least onerous assumption and therefore the riskiest.',
  },

  // --- Welfare and accommodation --------------------------------------------
  {
    id: 'wcProvision',
    family: 'WELFARE_ACCOMMODATION',
    label: 'Sanitary conveniences provided',
    unit: 'WCs',
    decides: 'Statutory compliance under the Workplace (Health, Safety and Welfare) Regulations 1992, Schedule 1.',
    question: 'How many WCs does the current welfare layout provide?',
    changes: ['CAPACITY', 'ACCEPTANCE'],
    provisionalBasis: 'The statutory minimum for the concurrent occupancy, which is a floor and not a design.',
  },
  {
    id: 'accommodatedWorkers',
    family: 'WELFARE_ACCOMMODATION',
    label: 'Workers requiring accommodation',
    unit: 'persons',
    decides: 'Bed-night demand, the village size, the laundry, the catering covers and the bus fleet.',
    question: 'How many of the workforce need to be accommodated rather than travelling daily?',
    changes: ['CAPACITY', 'COST'],
    provisionalBasis: 'Nobody accommodated, which is only true where the whole workforce is local.',
  },
  {
    id: 'roomsAvailable',
    family: 'WELFARE_ACCOMMODATION',
    label: 'Rooms available',
    unit: 'rooms',
    decides: 'Whether the accommodated workforce fits, and the rooming policy needed if it does not.',
    question: 'How many rooms does the accommodation provide?',
    changes: ['CAPACITY', 'COST'],
    provisionalBasis: 'None, until an accommodation package is placed.',
  },
  {
    id: 'occupancyPerRoom',
    family: 'WELFARE_ACCOMMODATION',
    label: 'Occupancy per room',
    unit: 'persons per room',
    decides: 'Bed count, and whether the rooming policy is single-occupancy or shared.',
    question: 'Is the rooming policy single occupancy, or shared — and if shared, how many to a room?',
    changes: ['CAPACITY', 'COST', 'ACCEPTANCE'],
    provisionalBasis: 'Single occupancy, which is the policy most customers require and the most expensive.',
  },

  // --- Temporary MEP ---------------------------------------------------------
  {
    id: 'maximumDemandKva',
    family: 'TEMPORARY_MEP',
    label: 'Maximum electrical demand',
    unit: 'kVA',
    decides: 'Generation or grid strategy, distribution sizing, fuel logistics and the critical-load reserve.',
    question: 'What is the maximum electrical demand, after diversity, across the whole site at peak?',
    changes: ['CAPACITY', 'COST', 'SEQUENCE'],
    provisionalBasis: 'Derived from the cabin, welfare and plant schedule with a 0.7 diversity factor.',
  },
  {
    id: 'suppliedKva',
    family: 'TEMPORARY_MEP',
    label: 'Electrical supply secured',
    unit: 'kVA',
    decides: 'Whether the site can be energised at all, and the lead time if it cannot.',
    question: 'What supply is actually secured — grid connection, generation, or both?',
    changes: ['CAPACITY', 'SEQUENCE', 'RISK'],
    provisionalBasis: 'None secured, which is the correct assumption until a connection agreement exists.',
  },
  {
    id: 'waterStorageHours',
    family: 'TEMPORARY_MEP',
    label: 'Potable water storage autonomy',
    unit: 'hours',
    decides: 'How long the site runs if a delivery is missed, and therefore the tanker frequency.',
    question: 'How many hours of potable water does on-site storage hold at peak draw?',
    changes: ['CAPACITY', 'RISK'],
    provisionalBasis: '24 hours, which is the usual minimum and is not adequate for a remote site.',
  },
  {
    id: 'tankerIntervalHours',
    family: 'TEMPORARY_MEP',
    label: 'Water and wastewater tanker interval',
    unit: 'hours',
    decides: 'Whether storage covers the gap between visits, and the logistics slots the deliveries need.',
    question: 'How often can a tanker actually reach the site, allowing for access restrictions?',
    changes: ['CAPACITY', 'RISK', 'SEQUENCE'],
    provisionalBasis: 'Every 48 hours, which is achievable on most sites and not on a constrained one.',
  },

  // --- Compounds and civils --------------------------------------------------
  {
    id: 'compoundAreaSqm',
    family: 'TEMPORARY_INFRASTRUCTURE',
    label: 'Compound area available',
    unit: 'm²',
    decides: 'Whether the cabins, stores, parking and laydown fit at all, and the phasing if they do not.',
    question: 'What area is available for the compound, and is it available for the whole programme?',
    changes: ['CAPACITY', 'SEQUENCE', 'COST'],
    provisionalBasis: 'None, because a compound sized against an unknown area is a drawing rather than a plan.',
  },
  {
    id: 'groundBearingKpa',
    family: 'ENABLING_CIVILS',
    label: 'Ground bearing capacity',
    unit: 'kPa',
    decides: 'Platform build-up, crane pad design and whether double-stacked cabins are possible.',
    question: 'What is the ground bearing capacity across the compound area?',
    changes: ['COST', 'RISK', 'SEQUENCE'],
    provisionalBasis: 'Assumed poor until a survey exists, which is the expensive assumption and the safe one.',
  },
  {
    id: 'reinstatementStandard',
    family: 'ENABLING_CIVILS',
    label: 'Reinstatement standard',
    unit: 'standard',
    decides: 'The demobilisation scope, the condition survey needed now, and the landowner acceptance test.',
    question: 'What condition must the land be returned in, and against what record?',
    changes: ['COST', 'ACCEPTANCE', 'CONTRACT'],
    provisionalBasis: 'Return to the pre-existing condition evidenced by a survey taken before occupation.',
  },

  // --- Cleaning, FM and waste ------------------------------------------------
  {
    id: 'cleanableAreaSqm',
    family: 'CLEANING_FM',
    label: 'Cleanable area',
    unit: 'm²',
    decides: 'Cleaning productive hours, staffing, consumables and the reactive response cover.',
    question: 'What floor area is cleaned, and to what standard in each zone?',
    changes: ['CAPACITY', 'COST'],
    provisionalBasis: 'Derived from the cabin and welfare schedule at standard productivity rates.',
  },
  {
    id: 'wasteVolumeM3PerWeek',
    family: 'CLEANING_FM',
    label: 'Waste volume by week',
    unit: 'm³ per week',
    decides: 'Container count, collection frequency, segregation and the waste carrier contract.',
    question: 'What waste volume does the site produce weekly, split by stream?',
    changes: ['CAPACITY', 'COST', 'CONTRACT'],
    provisionalBasis: 'Derived from occupancy at industry norms per person per week.',
  },
  {
    id: 'wasteContainerCapacityM3',
    family: 'CLEANING_FM',
    label: 'Waste container capacity in place',
    unit: 'm³ per collection',
    decides: 'Whether the collection cycle keeps up, or whether the compound overflows between visits.',
    question: 'What total container capacity is on site, and how often is it emptied?',
    changes: ['CAPACITY', 'RISK'],
    provisionalBasis: 'None, until a waste package is placed.',
  },
  {
    id: 'wasteCollectionsPerWeek',
    family: 'CLEANING_FM',
    label: 'Waste collections per week',
    unit: 'collections per week',
    decides: 'Together with container capacity, whether waste leaves faster than it arrives.',
    question: 'How many waste collections per week can the site actually take?',
    changes: ['CAPACITY', 'COST'],
    provisionalBasis: 'One collection per week, which is the common default and often not enough.',
  },

  // --- Security, logistics and transport --------------------------------------
  {
    id: 'securityHoursCovered',
    family: 'SECURITY_LOGISTICS',
    label: 'Security cover provided',
    unit: 'hours per day',
    decides: 'Whether the site is manned when it is live, and the post plan and rota that follow.',
    question: 'How many hours a day is the security post manned?',
    changes: ['CAPACITY', 'RISK', 'COST'],
    provisionalBasis: '12 hours, which covers a day shift and leaves the site unmanned overnight.',
  },
  {
    id: 'gateThroughputPerHour',
    family: 'SECURITY_LOGISTICS',
    label: 'Gate throughput',
    unit: 'persons per hour',
    decides: 'Whether the workforce can be inducted and through the turnstile before the shift starts.',
    question: 'How many people per hour can the access control actually process?',
    changes: ['CAPACITY', 'SEQUENCE'],
    provisionalBasis: '120 people per hour per lane, which is a well-run turnstile and not a signing-in book.',
  },
  {
    id: 'travellingWorkforce',
    family: 'SECURITY_LOGISTICS',
    label: 'Workforce needing transport',
    unit: 'persons per shift',
    decides: 'Bus fleet, routes, parking demand and the journey plan.',
    question: 'How many people per shift arrive by site transport rather than their own vehicle?',
    changes: ['CAPACITY', 'COST'],
    provisionalBasis: 'Nobody, which is only true where parking is unlimited.',
  },
  {
    id: 'busSeatsPerShift',
    family: 'SECURITY_LOGISTICS',
    label: 'Bus seats scheduled per shift',
    unit: 'seats per shift',
    decides: 'Whether everybody who needs transport has a seat on it.',
    question: 'How many seats does the scheduled transport provide per shift?',
    changes: ['CAPACITY', 'COST'],
    provisionalBasis: 'None, until a transport package is placed.',
  },

  // --- Procurement and supplier control ---------------------------------------
  {
    id: 'packageCount',
    family: 'PROCUREMENT_CONTROL',
    label: 'Service packages to be let',
    unit: 'packages',
    decides: 'The tender programme, the interface load and whether the appointment model can carry it.',
    question: 'How many separate service packages will be let, and by whom?',
    changes: ['SEQUENCE', 'COST', 'CONTRACT'],
    provisionalBasis: 'One package per service family, which is seven and is rarely how it is actually let.',
  },
  {
    id: 'firstMobilisationDate',
    family: 'PROCUREMENT_CONTROL',
    label: 'First mobilisation date',
    unit: 'date',
    decides: 'Every lead time backwards from it, and whether a tender can be run at all before it.',
    question: 'When does the first service have to be operational on site?',
    changes: ['SEQUENCE', 'RISK', 'CONTRACT'],
    provisionalBasis: 'The project’s own start date, which assumes no enabling works precede it.',
  },
] as const;

export type BriefItemId = (typeof BRIEF_ITEMS)[number]['id'];

const ITEM_BY_ID = new Map(BRIEF_ITEMS.map((item) => [item.id, item]));

export function isBriefItemId(value: string): value is BriefItemId {
  return ITEM_BY_ID.has(value as BriefItemId);
}

// --- Facts -------------------------------------------------------------------

export type FactStatus = 'KNOWN' | 'PROVISIONAL';

export type SiteServiceFact = {
  id: string;
  projectId: string;
  itemId: string;
  family: ServiceFamily;
  status: FactStatus;
  /** Numbers for everything the demand engine calculates; a date or a phrase where the unit is not numeric. */
  value: number | string;
  unit: string;
  /** Where it came from, in the words somebody could go and check. Required. */
  source: string;
  /** The accepted brief requirement it was read off, where there is one. */
  requirementId?: string;
  recordedBy: string;
  recordedAt: string;
  /** Provisional only: why this value was assumed, when it must be decided, and whose answer it is. */
  basis?: string;
  decideBy?: string;
  owner?: string;
  /** Set when a provisional value is replaced by a known one, or a known one corrected. */
  supersededBy?: string;
  supersededAt?: string;
};

function factsOf(ctx: EngineContext): SiteServiceFact[] {
  return ctx.ledger
    .list(ctx.projectId, 'SiteServiceFact')
    .map((record) => record.state as unknown as SiteServiceFact);
}

/**
 * The live fact for each item.
 *
 * Two rules. **Superseded records are excluded**, and **among what remains the
 * later id wins** — ULIDs are monotonic, so this is "the most recent one" said
 * without depending on how the ledger happens to order a list.
 *
 * The two are not independent today: `list` sorts by refId, so the newest
 * record is last either way and the supersession guard changes no current
 * answer. It is kept because it is the rule that is actually true, and the
 * ordering is not — the day anything supersedes a fact *without* replacing it,
 * a "newest wins" rule alone would resurrect the figure that was retired. Said
 * plainly rather than claimed as tested: no mutation of this guard fails the
 * suite, because nothing yet produces the case it guards against.
 */
function liveFacts(ctx: EngineContext): Map<string, SiteServiceFact> {
  const live = new Map<string, SiteServiceFact>();
  for (const fact of factsOf(ctx)) {
    if (fact.supersededBy) continue;
    const held = live.get(fact.itemId);
    if (held && held.id > fact.id) continue;
    live.set(fact.itemId, fact);
  }
  return live;
}

function itemOrThrow(itemId: string): BriefItem {
  const item = ITEM_BY_ID.get(itemId as BriefItemId);
  if (!item) {
    throw new DomainError(
      'BRIEF_ITEM_UNKNOWN',
      `${itemId} is not a brief item. The catalogue is closed: a fact against an item nobody defined decides nothing and would sit on the register looking like it did.`,
      404,
    );
  }
  return item;
}

/**
 * Record a fact somebody actually knows.
 *
 * `C` on `SITE_SERVICES`. A source is required and is not a formality: the
 * whole point of this register is that every number can be traced back to the
 * document, drawing or conversation it came from, because the argument in month
 * six is always about where a figure came from rather than what it is.
 *
 * Recording a fact against an item that already has one supersedes the old
 * value rather than overwriting it. A number that changed silently is the
 * commonest cause of two teams working to different figures.
 */
export function recordFact(
  ctx: EngineContext,
  input: { itemId: string; value: number | string; source: string; requirementId?: string },
): SiteServiceFact {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C');

  const item = itemOrThrow(input.itemId);
  if (!input.source?.trim()) {
    throw new DomainError(
      'BRIEF_FACT_SOURCE_REQUIRED',
      'A fact needs the document, drawing or conversation it came from. The argument later is always about where a number came from.',
    );
  }
  assertValueUsable(item, input.value);

  return commitFact(ctx, {
    item,
    status: 'KNOWN',
    value: input.value,
    source: input.source.trim(),
    requirementId: input.requirementId,
  });
}

/**
 * Assume a value, out loud.
 *
 * The spec's rule, and it is the one that separates this from a form with
 * defaults: **agents may not silently replace missing facts.** A provisional
 * value is a distinct status carrying the basis it was assumed on, the date it
 * must be decided by, and the person whose answer it is. Without an owner and a
 * date it is refused — an assumption nobody owns and nothing expires is a wrong
 * number that has stopped being questioned.
 */
export function assumeFact(
  ctx: EngineContext,
  input: { itemId: string; value: number | string; basis: string; decideBy: string; owner: string },
): SiteServiceFact {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C');

  const item = itemOrThrow(input.itemId);
  assertValueUsable(item, input.value);
  if (!input.basis?.trim()) {
    throw new DomainError('BRIEF_ASSUMPTION_UNBASED', 'A provisional value states what it was assumed on');
  }
  if (!input.owner?.trim()) {
    throw new DomainError(
      'BRIEF_ASSUMPTION_UNOWNED',
      'A provisional value names whose answer would replace it. An assumption nobody owns is never revisited.',
    );
  }
  if (!isDate(input.decideBy)) {
    throw new DomainError(
      'BRIEF_ASSUMPTION_UNDATED',
      'A provisional value carries the date after which it is too late to change — otherwise it silently becomes the design.',
    );
  }

  return commitFact(ctx, {
    item,
    status: 'PROVISIONAL',
    value: input.value,
    source: `Provisional: ${item.provisionalBasis}`,
    basis: input.basis.trim(),
    decideBy: input.decideBy,
    owner: input.owner.trim(),
  });
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * A value has to be usable by the calculation the item feeds.
 *
 * `date` and `standard` items take text; everything else feeds arithmetic in
 * the conflict checks below, and a string where a number belongs would make
 * every comparison against it silently false rather than wrong.
 */
function assertValueUsable(item: BriefItem, value: number | string): void {
  const numeric = item.unit !== 'date' && item.unit !== 'standard';
  if (numeric) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new DomainError(
        'BRIEF_FACT_VALUE_INVALID',
        `${item.label} is measured in ${item.unit} and needs a number that is not negative. It feeds a calculation, and text here would make every check against it quietly pass.`,
      );
    }
    return;
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new DomainError('BRIEF_FACT_VALUE_INVALID', `${item.label} needs a value`);
  }
  if (item.unit === 'date' && !isDate(value)) {
    throw new DomainError('BRIEF_FACT_VALUE_INVALID', `${item.label} is a date, as YYYY-MM-DD`);
  }
}

function commitFact(
  ctx: EngineContext,
  input: {
    item: BriefItem;
    status: FactStatus;
    value: number | string;
    source: string;
    requirementId?: string;
    basis?: string;
    decideBy?: string;
    owner?: string;
  },
): SiteServiceFact {
  const existing = liveFacts(ctx).get(input.item.id);
  const at = new Date().toISOString();
  const fact: SiteServiceFact = {
    id: ulid(),
    projectId: ctx.projectId,
    itemId: input.item.id,
    family: input.item.family,
    status: input.status,
    value: input.value,
    unit: input.item.unit,
    source: input.source,
    recordedBy: ctx.auth.actorId,
    recordedAt: at,
    ...(input.requirementId ? { requirementId: input.requirementId } : {}),
    ...(input.basis ? { basis: input.basis } : {}),
    ...(input.decideBy ? { decideBy: input.decideBy } : {}),
    ...(input.owner ? { owner: input.owner } : {}),
  };

  write(ctx, {
    eventType: input.status === 'KNOWN' ? 'SITE_SERVICE_FACT_RECORDED' : 'SITE_SERVICE_FACT_ASSUMED',
    entity: { refType: 'SiteServiceFact', refId: fact.id },
    nextState: fact,
  });

  if (existing) {
    // Superseded, never overwritten. A figure that changed with no record of
    // the change is how two teams end up working to different numbers with
    // nobody able to say when they diverged.
    write(ctx, {
      eventType: 'SITE_SERVICE_FACT_SUPERSEDED',
      entity: { refType: 'SiteServiceFact', refId: existing.id },
      nextState: { ...existing, supersededBy: fact.id, supersededAt: at },
    });
  }

  return fact;
}

// --- Completeness ------------------------------------------------------------

export type BriefGap = {
  itemId: string;
  label: string;
  unit: string;
  /** The four things the spec forbids a percentage from standing in for. */
  decides: string;
  latestAnswer?: string;
  provisionalAssumption: string;
  owner?: string;
  /** Present where a provisional value is standing in for the answer. */
  provisionalValue?: number | string;
  changes: readonly Changes[];
};

export type FamilyCompleteness = {
  family: ServiceFamily;
  label: string;
  scope: string;
  items: number;
  known: number;
  provisional: number;
  missing: number;
  /**
   * Provisional counts as *not* answered.
   *
   * A percentage that counted assumptions as facts would report a brief nobody
   * has answered as complete, which is precisely the reading this whole
   * structure exists to prevent.
   */
  percentKnown: number;
  gaps: BriefGap[];
};

export type BriefReadiness = {
  families: FamilyCompleteness[];
  percentKnown: number;
  /** Provisional values whose decision date has passed. */
  overdue: BriefGap[];
  /** Every check that failed, with the arithmetic it failed on. */
  conflicts: BriefConflict[];
  /** The next questions worth asking, and nothing else. */
  interview: BriefGap[];
  /** The figures in force. One per item, by construction. */
  facts: SiteServiceFact[];
  /**
   * The whole register, superseded records included.
   *
   * Separate from `facts` because they answer different questions: what is the
   * figure now, and what has this figure been. The second is what somebody
   * opens when two teams have been working to different numbers.
   */
  register: SiteServiceFact[];
};

export function briefReadiness(ctx: EngineContext, asAt?: string): BriefReadiness {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'R');

  const live = liveFacts(ctx);
  const today = asAt ?? new Date().toISOString().slice(0, 10);

  const gapFor = (item: BriefItem): BriefGap => {
    const fact = live.get(item.id);
    return {
      itemId: item.id,
      label: item.label,
      unit: item.unit,
      decides: item.decides,
      provisionalAssumption: item.provisionalBasis,
      changes: item.changes,
      ...(fact?.decideBy ? { latestAnswer: fact.decideBy } : {}),
      ...(fact?.owner ? { owner: fact.owner } : {}),
      ...(fact?.status === 'PROVISIONAL' ? { provisionalValue: fact.value } : {}),
    };
  };

  const families = (Object.keys(SERVICE_FAMILIES) as ServiceFamily[]).map((family) => {
    const items = BRIEF_ITEMS.filter((item) => item.family === family);
    const known = items.filter((item) => live.get(item.id)?.status === 'KNOWN');
    const provisional = items.filter((item) => live.get(item.id)?.status === 'PROVISIONAL');
    return {
      family,
      label: SERVICE_FAMILIES[family].label,
      scope: SERVICE_FAMILIES[family].scope,
      items: items.length,
      known: known.length,
      provisional: provisional.length,
      missing: items.length - known.length - provisional.length,
      percentKnown: items.length > 0 ? Math.round((known.length / items.length) * 1000) / 10 : 0,
      // Every item that is not a settled fact, with its consequence, its
      // deadline, what is being assumed instead and whose answer it is.
      gaps: items.filter((item) => live.get(item.id)?.status !== 'KNOWN').map(gapFor),
    };
  });

  const knownCount = BRIEF_ITEMS.filter((item) => live.get(item.id)?.status === 'KNOWN').length;

  return {
    families,
    percentKnown: Math.round((knownCount / BRIEF_ITEMS.length) * 1000) / 10,
    overdue: BRIEF_ITEMS.filter((item) => {
      const fact = live.get(item.id);
      return fact?.status === 'PROVISIONAL' && fact.decideBy !== undefined && fact.decideBy < today;
    }).map(gapFor),
    conflicts: briefConflicts(ctx),
    // The adaptive interview: only what is unanswered, ordered by how soon the
    // answer stops being useful — so the first question is the one that runs
    // out first rather than the first one somebody happened to write.
    //
    // There is no second filter for "only questions that change something",
    // and there was one. It never removed anything: the catalogue invariant
    // already refuses an item that changes nothing, so the filter was a second
    // statement of a rule enforced above it, and the two would eventually
    // disagree about which was in force. One rule, in the catalogue.
    interview: BRIEF_ITEMS.filter((item) => live.get(item.id)?.status !== 'KNOWN')
      .map(gapFor)
      .sort((a, b) => (a.latestAnswer ?? '9999-12-31').localeCompare(b.latestAnswer ?? '9999-12-31')),
    facts: [...live.values()],
    register: factsOf(ctx).sort((a, b) => a.itemId.localeCompare(b.itemId) || a.id.localeCompare(b.id)),
  };
}

// --- Cross-document conflict checks ------------------------------------------

export type BriefConflict = {
  id: string;
  /** The families it sits between, because a conflict is always between two people's work. */
  families: ServiceFamily[];
  /** What is wrong, with both numbers in it. */
  statement: string;
  /** What has to happen. The spec's own example ends in a choice, not a warning. */
  resolution: string;
  severity: 'BLOCKING' | 'MATERIAL';
};

/**
 * The statutory minimum number of WCs, re-exported from the demand engine.
 *
 * The rule lives once, in `engines/maths/demand.ts`, because two copies of a
 * statutory table are two chances to be wrong in the one conversation this
 * platform exists to be right in. Re-exported here so the conflict checks below
 * read it from the module they belong to rather than reaching across.
 */
export { statutoryWcs };

/**
 * Every cross-check the recorded facts allow.
 *
 * A check is only run where both of its inputs exist. Running it against a
 * missing value would produce a conflict against zero, which is a false alarm
 * with arithmetic on it — and the missing value is already reported as a gap,
 * which is the honest way to say the check could not be made.
 */
export function briefConflicts(ctx: EngineContext): BriefConflict[] {
  const live = liveFacts(ctx);
  const num = (id: string): number | undefined => {
    const fact = live.get(id);
    return typeof fact?.value === 'number' ? fact.value : undefined;
  };

  const conflicts: BriefConflict[] = [];

  // 1. Concurrent occupancy against the welfare basis. The specification's own
  //    worked example, and the commonest real one: the brief says 100, the
  //    programme peaks at 164 across two shifts, and welfare was sized on 100.
  const peak = num('peakWorkforce');
  const overlap = num('shiftOverlapPersons');
  const visitors = num('visitorsPerDay');
  const concurrent = overlap !== undefined ? overlap + (visitors ?? 0) : undefined;
  const wcs = num('wcProvision');

  if (concurrent !== undefined && wcs !== undefined) {
    const required = statutoryWcs(concurrent);
    if (wcs < required) {
      conflicts.push({
        id: 'WELFARE_BELOW_STATUTORY',
        families: ['WELFARE_ACCOMMODATION'],
        statement:
          `Concurrent occupancy is ${concurrent} people at changeover${
            visitors ? ` (${overlap} on shift plus ${visitors} visitors)` : ''
          }, which needs ${required} WCs under Schedule 1 of the Workplace Regulations 1992. The layout provides ${wcs}.`,
        resolution:
          `Confirm the peak concurrent occupancy, or accept a provisional design basis of ${Math.ceil(
            concurrent * 1.15,
          )} persons — ${concurrent} plus 15% resilience — and provide ${statutoryWcs(
            Math.ceil(concurrent * 1.15),
          )} WCs.`,
        severity: 'BLOCKING',
      });
    }
  }

  if (peak !== undefined && overlap !== undefined && overlap > peak) {
    conflicts.push({
      id: 'OVERLAP_EXCEEDS_PEAK',
      families: ['WELFARE_ACCOMMODATION'],
      statement: `The shift changeover is stated at ${overlap} people, which is more than the ${peak} stated as the daily peak.`,
      resolution: 'One of the two figures is wrong. The changeover cannot exceed the number of people on site that day.',
      severity: 'BLOCKING',
    });
  }

  // 2. Security cover against operating hours. A site live for twenty-four
  //    hours with twelve hours of security is unmanned for half its life, and
  //    it is almost always priced from the day shift.
  const hours = num('operatingHours');
  const security = num('securityHoursCovered');
  if (hours !== undefined && security !== undefined && security < hours) {
    conflicts.push({
      id: 'SECURITY_BELOW_OPERATING_HOURS',
      families: ['SECURITY_LOGISTICS'],
      statement: `The site is live ${hours} hours a day and security is manned for ${security}. It is unmanned for ${
        hours - security
      } hours while work is going on.`,
      resolution:
        'Either extend the post plan to cover the operating hours, or record a decision that the uncovered hours are accepted and by whom.',
      severity: 'BLOCKING',
    });
  }

  // 3. Water storage against the tanker interval. Storage that does not bridge
  //    the gap between deliveries means the site runs dry on the first missed
  //    slot, which is the failure that sends everybody home.
  const storage = num('waterStorageHours');
  const interval = num('tankerIntervalHours');
  if (storage !== undefined && interval !== undefined && storage < interval) {
    conflicts.push({
      id: 'WATER_AUTONOMY_BELOW_INTERVAL',
      families: ['TEMPORARY_MEP'],
      statement: `Potable storage holds ${storage} hours at peak draw and tankers reach the site every ${interval} hours. The site runs dry ${
        interval - storage
      } hours before the next delivery.`,
      resolution: 'Increase storage to at least the tanker interval, or secure a shorter interval and evidence it.',
      severity: 'BLOCKING',
    });
  }

  // 4. Electrical demand against secured supply.
  const demand = num('maximumDemandKva');
  const supply = num('suppliedKva');
  if (demand !== undefined && supply !== undefined && supply < demand) {
    conflicts.push({
      id: 'SUPPLY_BELOW_DEMAND',
      families: ['TEMPORARY_MEP'],
      statement: `Maximum demand after diversity is ${demand} kVA and the secured supply is ${supply} kVA — short by ${
        demand - supply
      } kVA.`,
      resolution:
        'Secure additional supply or generation, or reduce the load schedule. A grid connection carries a lead time measured in months, so this is a sequence problem before it is a cost one.',
      severity: 'BLOCKING',
    });
  }

  // 5. Beds against the accommodated workforce.
  const accommodated = num('accommodatedWorkers');
  const rooms = num('roomsAvailable');
  const perRoom = num('occupancyPerRoom');
  if (accommodated !== undefined && rooms !== undefined && perRoom !== undefined) {
    const beds = rooms * perRoom;
    if (beds < accommodated) {
      conflicts.push({
        id: 'BEDS_BELOW_DEMAND',
        families: ['WELFARE_ACCOMMODATION'],
        statement: `${accommodated} people need accommodation and ${rooms} rooms at ${perRoom} per room provide ${beds} beds — short by ${
          accommodated - beds
        }.`,
        resolution:
          'Add rooms, change the rooming policy, or move part of the workforce to daily travel — which then lands on the transport demand.',
        severity: 'BLOCKING',
      });
    }
  }

  // 6. Bus seats against the travelling workforce.
  const travelling = num('travellingWorkforce');
  const seats = num('busSeatsPerShift');
  if (travelling !== undefined && seats !== undefined && seats < travelling) {
    conflicts.push({
      id: 'SEATS_BELOW_TRAVELLING',
      families: ['SECURITY_LOGISTICS'],
      statement: `${travelling} people per shift need transport and ${seats} seats are scheduled — ${
        travelling - seats
      } people have no way to site.`,
      resolution: 'Add services or capacity, or record where the remainder park and whether the parking exists.',
      severity: 'BLOCKING',
    });
  }

  // 7. Waste out against waste produced.
  const wasteVolume = num('wasteVolumeM3PerWeek');
  const containers = num('wasteContainerCapacityM3');
  const collections = num('wasteCollectionsPerWeek');
  if (wasteVolume !== undefined && containers !== undefined && collections !== undefined) {
    const removed = containers * collections;
    if (removed < wasteVolume) {
      conflicts.push({
        id: 'WASTE_ACCUMULATES',
        families: ['CLEANING_FM'],
        statement: `The site produces ${wasteVolume} m³ a week and removes ${removed} m³ (${containers} m³ × ${collections} collections). ${
          Math.round((wasteVolume - removed) * 10) / 10
        } m³ accumulates every week.`,
        resolution: 'Increase container capacity or collection frequency. Waste that accumulates becomes a compound and a fire risk.',
        severity: 'MATERIAL',
      });
    }
  }

  // 8. Gate throughput against getting a shift on site. Not a capacity failure
  //    so much as a programme one: a shift that takes ninety minutes to get
  //    through the gate has lost ninety minutes.
  const throughput = num('gateThroughputPerHour');
  if (throughput !== undefined && overlap !== undefined && throughput > 0) {
    const minutes = Math.ceil((overlap / throughput) * 60);
    if (minutes > 30) {
      conflicts.push({
        id: 'GATE_QUEUE',
        families: ['SECURITY_LOGISTICS'],
        statement: `Putting ${overlap} people through a gate rated at ${throughput} an hour takes ${minutes} minutes. The shift starts that much later, every day.`,
        resolution: 'Add lanes, stagger the start, or price the lost time into the programme rather than discovering it on site.',
        severity: 'MATERIAL',
      });
    }
  }

  return conflicts;
}
