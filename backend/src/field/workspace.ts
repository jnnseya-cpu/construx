import { DomainError } from '../core/errors.ts';
import { authorise, type EngineContext } from '../engines/context.ts';
import type { LifecyclePhase } from '../lifecycle/phases.ts';
import {
  FIELD_MODULES,
  MODULE_TAB,
  moduleBySlug,
  type FieldModule,
  type ModuleTab,
} from './modules.ts';

/**
 * The module workspace: one shell, four modules.
 *
 * §9.1, §10.1, §11.1 and §12.1 specify the same screen four times over — a
 * header carrying stage, project, package/location/system context, pack
 * freshness, unsynced count and current shift; six tabs; and lists filtered by
 * status, owner, location, due date and offline state. Building that four times
 * would be four screens that drift apart, so it is built once and each module
 * supplies its own record types, criteria and home indicators from
 * `field/modules.ts`.
 *
 * The stage workflows this sits on — tender, construction, commissioning and
 * handover — are already built and are what fills these tabs. What is new here
 * is the field-shaped way in, not a second copy of any of them.
 *
 * ---
 *
 * ## What the platform can honestly say, and what it cannot
 *
 * Three figures in the header are about a *device*, not a project, and each is
 * answered only as far as the server actually knows.
 *
 * **Records waiting** is the count of events on the project the reading device
 * has not yet pulled — derived from its sync cursor. It is deliberately not
 * called "unsynced", because the interesting number to a person on site is
 * usually the opposite one: how much their handset is still holding that the
 * platform has not got. **The server cannot know that.** An outbox on a device
 * with no signal is, by construction, invisible until it arrives. So the count
 * published here is the direction the server can measure, named for what it
 * actually is, and the application shows its own outbox depth beside it.
 *
 * **Pack freshness** is when that device last pulled, and whether anything has
 * been committed since. A device that has never pulled says so rather than
 * reporting a stale pack as current.
 *
 * **Current shift** is read from the open daily-log draft for today, because
 * that is the only record in which somebody has actually declared which shift
 * they are on. Where there is no draft the shift is unknown and is published as
 * unknown — guessing it from the server's clock would be wrong by hours on a
 * night shift and wrong by a day at a site in another timezone.
 *
 * ## The indicators do not guess at status vocabularies
 *
 * See the comment on `ModuleIndicator`. A breakdown's groups come from the
 * values the records actually carry; nothing here decides what "open" means for
 * an entity it does not own.
 */

/** Fields a record may name its owner in, in the order they are consulted. */
const OWNER_FIELDS = ['owner', 'ownerId', 'assignedTo', 'responsibleParty', 'accountableOwner'] as const;

/** Fields a record may carry a location in. */
const LOCATION_FIELDS = ['location', 'locationRef', 'area', 'zone'] as const;

/** Fields a record may carry a date that falls due. */
const DUE_FIELDS = ['dueAt', 'dueBy', 'dueDate', 'requiredBy', 'validTo', 'closesBy'] as const;

function firstString(state: Record<string, unknown>, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const value = state[field];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

export type WorkspaceRecord = {
  refType: string;
  refId: string;
  /** The record's own reference where it has one, so a person can say it out loud. */
  reference?: string;
  title?: string;
  status?: string;
  owner?: string;
  location?: string;
  due?: string;
  updatedAt: string;
  /** The event that last changed it. A ULID, so it also orders the list. */
  lastEventId: string;
};

function summarise(
  refType: string,
  refId: string,
  state: Record<string, unknown>,
  updatedAt: string,
  lastEventId: string,
): WorkspaceRecord {
  const status = state.status;
  return {
    refType,
    refId,
    ...(typeof state.reference === 'string' ? { reference: state.reference } : {}),
    ...(firstString(state, ['title', 'description', 'purpose', 'scopeNarrative', 'activity'])
      ? { title: firstString(state, ['title', 'description', 'purpose', 'scopeNarrative', 'activity']) }
      : {}),
    ...(typeof status === 'string' ? { status } : {}),
    ...(firstString(state, OWNER_FIELDS) ? { owner: firstString(state, OWNER_FIELDS) } : {}),
    ...(firstString(state, LOCATION_FIELDS) ? { location: firstString(state, LOCATION_FIELDS) } : {}),
    ...(firstString(state, DUE_FIELDS) ? { due: firstString(state, DUE_FIELDS) } : {}),
    updatedAt,
    lastEventId,
  };
}

/**
 * When each event happened, by id.
 *
 * A projection carries `lastEventId` but not a timestamp, so the time a record
 * last changed comes from the event that changed it. Built once per read rather
 * than looked up per row.
 */
function eventTimes(ctx: EngineContext): Map<string, string> {
  const at = new Map<string, string>();
  for (const event of ctx.ledger.events({ projectId: ctx.projectId })) at.set(event.eventId, event.timestamp);
  return at;
}

/** Every record of the named types on this project, newest first. */
function recordsOfTypes(ctx: EngineContext, types: readonly string[], at: Map<string, string>): WorkspaceRecord[] {
  const rows: WorkspaceRecord[] = [];
  for (const refType of types) {
    for (const record of ctx.ledger.list(ctx.projectId, refType)) {
      rows.push(
        summarise(refType, record.refId, record.state, at.get(record.lastEventId) ?? '', record.lastEventId),
      );
    }
  }
  // `lastEventId` is a ULID, so it orders by commit even where two records
  // share a timestamp to the millisecond.
  return rows.sort((a, b) => (a.lastEventId < b.lastEventId ? 1 : -1));
}

export type IndicatorReading = {
  label: string;
  /** Absent where the figure is not measured. Never zero to mean "unknown". */
  total?: number;
  /** Counts by the declared field's value, where one was declared. */
  breakdown?: Array<{ key: string; count: number }>;
  measured: boolean;
  /** Where it is not measured, what would produce it. */
  pending?: string;
};

function readIndicators(ctx: EngineContext, module: FieldModule): IndicatorReading[] {
  return module.indicators.map((indicator) => {
    if (indicator.pending || indicator.entities.length === 0) {
      return {
        label: indicator.label,
        measured: false,
        ...(indicator.pending ? { pending: indicator.pending } : {}),
      };
    }

    const rows = indicator.entities.flatMap((refType) => ctx.ledger.list(ctx.projectId, refType));
    const reading: IndicatorReading = { label: indicator.label, total: rows.length, measured: true };

    if (indicator.breakdownBy) {
      const counts = new Map<string, number>();
      for (const record of rows) {
        const value = (record.state as Record<string, unknown>)[indicator.breakdownBy];
        // A record that does not carry the field is counted under a name that
        // says so, rather than being dropped — a breakdown that silently loses
        // rows does not add up to the total printed beside it.
        const key = typeof value === 'string' && value.trim() !== '' ? value : 'not stated';
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      reading.breakdown = [...counts]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    }

    return reading;
  });
}

export type TabReading = {
  id: ModuleTab;
  label: string;
  count: number;
  /** What the count is of, so a person reading it knows what they are looking at. */
  basis: string;
};

const TAB_LABEL: Record<ModuleTab, string> = {
  ACTION_QUEUE: 'Action Queue',
  CAPTURE: 'Capture',
  PLANS_CRITERIA: 'Plans & Criteria',
  RECORDS: 'Records',
  EVIDENCE: 'Evidence',
  HISTORY: 'History',
};

export type PackPosition = {
  freshness: 'CURRENT' | 'BEHIND' | 'NEVER_PULLED' | 'NO_DEVICE';
  /** Events on this project the device has not been given. */
  recordsWaiting: number;
  lastPulledCursor?: string;
  /** When the newest event on the project was committed. */
  projectLastChangedAt?: string;
  note: string;
};

export type ShiftPosition = {
  shift?: string;
  diaryDate?: string;
  logId?: string;
  /** Present where the shift is not known, saying why rather than defaulting to DAY. */
  unknownBecause?: string;
};

export type ModuleWorkspace = {
  module: FieldModule['id'];
  slug: string;
  label: string;
  outcome: string;
  header: {
    projectId: string;
    projectName?: string;
    phase: LifecyclePhase;
    /** Whether the module is open in the phase the project is actually in. */
    openNow: boolean;
    /** Where it is not open, what phase it belongs to. */
    opensIn: LifecyclePhase[];
    context: {
      packages: Array<{ refId: string; label: string }>;
      systems: Array<{ refId: string; label: string }>;
      /** Locations are not an entity; these are the values the module's own records carry. */
      locations: string[];
    };
    pack: PackPosition;
    shift: ShiftPosition;
  };
  indicators: IndicatorReading[];
  tabs: TabReading[];
  /** Controls that are refused from a field device, so the application can grey them rather than fail them. */
  webOnly: string[];
};

/**
 * Where this device stands against the project.
 *
 * The cursor is a ULID-ordered event id, so "waiting" is the number of events
 * committed after it. No device means no answer — an unbound session is not
 * assumed to be up to date.
 */
function packPosition(ctx: EngineContext, deviceId: string | undefined, cursor: string | undefined): PackPosition {
  const events = ctx.ledger.events({ projectId: ctx.projectId });
  const projectLastChangedAt = events.at(-1)?.timestamp;

  if (!deviceId) {
    return {
      freshness: 'NO_DEVICE',
      recordsWaiting: 0,
      ...(projectLastChangedAt ? { projectLastChangedAt } : {}),
      note: 'This session is not bound to a device, so the platform cannot say what it is holding.',
    };
  }

  if (!cursor) {
    return {
      freshness: 'NEVER_PULLED',
      recordsWaiting: events.length,
      ...(projectLastChangedAt ? { projectLastChangedAt } : {}),
      note: 'This device has not pulled this project. Everything on it is still to come down.',
    };
  }

  const waiting = events.filter((event) => event.eventId > cursor).length;
  return {
    freshness: waiting === 0 ? 'CURRENT' : 'BEHIND',
    recordsWaiting: waiting,
    lastPulledCursor: cursor,
    ...(projectLastChangedAt ? { projectLastChangedAt } : {}),
    note:
      waiting === 0
        ? 'This device holds everything the platform has for this project.'
        : `${waiting} record${waiting === 1 ? '' : 's'} to come down. What the device is still holding to send is only known to the device.`,
  };
}

/**
 * The shift somebody is on, read from where somebody actually declared it.
 *
 * A daily log carries the shift as a stated fact. Nothing else does, so where
 * there is no log for today the answer is that it is not known.
 */
function shiftPosition(ctx: EngineContext, today: string): ShiftPosition {
  const logs = ctx.ledger
    .list(ctx.projectId, 'SiteDiary')
    .map((record) => record.state as Record<string, unknown>)
    .filter((state) => state.diaryDate === today);

  const mine = logs.find((state) => state.recordedBy === ctx.auth.actorId) ?? logs[0];
  if (!mine) {
    return {
      diaryDate: today,
      unknownBecause: 'No daily log has been opened for today, and the shift is only known once somebody states it.',
    };
  }

  return {
    ...(typeof mine.shift === 'string' ? { shift: mine.shift } : {}),
    diaryDate: today,
    ...(typeof mine.id === 'string' ? { logId: mine.id } : {}),
    ...(typeof mine.shift === 'string'
      ? {}
      : { unknownBecause: 'The log for today does not name a shift.' }),
  };
}

/**
 * The module workspace for one project.
 *
 * `FIELD_EXECUTION` read authority, which is what the field seat carries. The
 * module is offered outside its own lifecycle phase — a person may need to look
 * back at the tender visits during construction — but the header says plainly
 * that it is not the phase the project is in, so nothing reads as live that is
 * not.
 */
export function moduleWorkspace(
  ctx: EngineContext,
  input: {
    module: string;
    today?: string;
    /**
     * Where the reading device's sync cursor stands, supplied by the caller.
     *
     * The sync engine hangs off the platform rather than the engine context, and
     * widening the context so one read can reach it would put a field concern on
     * every command in the system. The route passes it in.
     */
    deviceCursor?: string;
  },
): ModuleWorkspace {
  authorise(ctx, 'FIELD_EXECUTION', 'R');

  const module = moduleBySlug(input.module);
  if (!module) {
    throw new DomainError(
      'NO_SUCH_MODULE',
      `There is no field module "${input.module}". The modules are ${Object.values(FIELD_MODULES)
        .map((entry) => entry.slug)
        .join(', ')}.`,
      404,
    );
  }

  const project = ctx.ledger.get({ refType: 'Project', refId: ctx.projectId });
  if (!project) throw new DomainError('NO_SUCH_PROJECT', `No project ${ctx.projectId}`, 404);
  const projectState = project.state as Record<string, unknown>;
  const phase = projectState.phase as LifecyclePhase;

  const at = eventTimes(ctx);
  const records = recordsOfTypes(ctx, module.records, at);
  const plans = recordsOfTypes(ctx, module.plans, at);
  const queue = recordsOfTypes(ctx, module.queue, at).filter((row) => row.owner !== undefined);

  const moduleTypes = new Set([...module.records, ...module.plans]);
  const evidence = ctx.ledger.list(ctx.projectId, 'EvidenceItem').filter((record) => {
    const linked = (record.state as { linkedEntities?: Array<{ refType?: string }> }).linkedEntities;
    return Array.isArray(linked) && linked.some((entry) => entry.refType && moduleTypes.has(entry.refType));
  });
  const history = ctx.ledger
    .events({ projectId: ctx.projectId })
    .filter((event) => moduleTypes.has(event.entity.refType));

  const tabs: TabReading[] = MODULE_TAB.map((id) => {
    switch (id) {
      case 'ACTION_QUEUE':
        return {
          id,
          label: TAB_LABEL[id],
          count: queue.length,
          basis: 'Records in this module that name somebody as owner.',
        };
      case 'CAPTURE':
        return {
          id,
          label: TAB_LABEL[id],
          count: module.records.length,
          basis: 'The kinds of record this module captures.',
        };
      case 'PLANS_CRITERIA':
        return { id, label: TAB_LABEL[id], count: plans.length, basis: 'The approved criteria this module works to.' };
      case 'RECORDS':
        return { id, label: TAB_LABEL[id], count: records.length, basis: 'Every record this module has produced.' };
      case 'EVIDENCE':
        return {
          id,
          label: TAB_LABEL[id],
          count: evidence.length,
          basis: 'Evidence filed against one of this module’s records.',
        };
      case 'HISTORY':
        return { id, label: TAB_LABEL[id], count: history.length, basis: 'Ledger events on this module’s records.' };
    }
  });

  const locations = [...new Set(records.map((row) => row.location).filter((value): value is string => !!value))].sort();

  return {
    module: module.id,
    slug: module.slug,
    label: module.label,
    outcome: module.outcome,
    header: {
      projectId: ctx.projectId,
      ...(typeof projectState.name === 'string' ? { projectName: projectState.name } : {}),
      phase,
      openNow: module.phases.includes(phase),
      opensIn: module.phases,
      context: {
        packages: ctx.ledger.list(ctx.projectId, 'WorkPackage').map((record) => ({
          refId: record.refId,
          label: firstString(record.state, ['wbsCode', 'title']) ?? record.refId,
        })),
        systems: ctx.ledger.list(ctx.projectId, 'SystemNode').map((record) => ({
          refId: record.refId,
          label: firstString(record.state, ['code', 'name', 'title']) ?? record.refId,
        })),
        locations,
      },
      pack: packPosition(ctx, ctx.auth.deviceId, input.deviceCursor),
      shift: shiftPosition(ctx, input.today ?? new Date().toISOString().slice(0, 10)),
    },
    indicators: readIndicators(ctx, module),
    tabs,
    webOnly: module.webOnly,
  };
}

export type ModuleTabContents = {
  module: FieldModule['id'];
  tab: ModuleTab;
  rows: WorkspaceRecord[];
  /** Values present on these rows, so the application's filters offer only what is there. */
  filters: { status: string[]; owner: string[]; location: string[] };
};

/**
 * One tab's rows.
 *
 * Filters are applied here rather than in the browser because the list can be
 * long and the device asking is the one on a bad connection. The values offered
 * are the values present — a filter listing a status no record holds is a dead
 * control.
 */
export function moduleTab(
  ctx: EngineContext,
  input: { module: string; tab: string; status?: string; owner?: string; location?: string; dueBefore?: string },
): ModuleTabContents {
  authorise(ctx, 'FIELD_EXECUTION', 'R');

  const module = moduleBySlug(input.module);
  if (!module) throw new DomainError('NO_SUCH_MODULE', `There is no field module "${input.module}"`, 404);
  if (!(MODULE_TAB as readonly string[]).includes(input.tab)) {
    throw new DomainError('NO_SUCH_TAB', `"${input.tab}" is not a tab of the module workspace`, 404);
  }
  const tab = input.tab as ModuleTab;
  const at = eventTimes(ctx);

  let rows: WorkspaceRecord[];
  switch (tab) {
    case 'PLANS_CRITERIA':
      rows = recordsOfTypes(ctx, module.plans, at);
      break;
    case 'ACTION_QUEUE':
      rows = recordsOfTypes(ctx, module.queue, at).filter((row) => row.owner !== undefined);
      break;
    case 'EVIDENCE': {
      const moduleTypes = new Set([...module.records, ...module.plans]);
      rows = ctx.ledger
        .list(ctx.projectId, 'EvidenceItem')
        .filter((record) => {
          const linked = (record.state as { linkedEntities?: Array<{ refType?: string }> }).linkedEntities;
          return Array.isArray(linked) && linked.some((entry) => entry.refType && moduleTypes.has(entry.refType));
        })
        .map((record) =>
          summarise('EvidenceItem', record.refId, record.state, at.get(record.lastEventId) ?? '', record.lastEventId),
        )
        .sort((a, b) => (a.lastEventId < b.lastEventId ? 1 : -1));
      break;
    }
    case 'HISTORY': {
      const moduleTypes = new Set([...module.records, ...module.plans]);
      rows = ctx.ledger
        .events({ projectId: ctx.projectId })
        .filter((event) => moduleTypes.has(event.entity.refType))
        .reverse()
        .map((event) => ({
          refType: event.entity.refType,
          refId: event.entity.refId,
          title: event.eventType,
          owner: event.actor.refId,
          updatedAt: event.timestamp,
          lastEventId: event.eventId,
        }));
      break;
    }
    // Capture offers the kinds of record this module makes; the doors themselves
    // live on the stage screens, which is where the authority to press them is
    // already resolved.
    case 'CAPTURE':
      rows = module.records.map((refType) => ({ refType, refId: refType, title: refType, updatedAt: '', lastEventId: '' }));
      break;
    case 'RECORDS':
      rows = recordsOfTypes(ctx, module.records, at);
      break;
  }

  const filters = {
    status: [...new Set(rows.map((row) => row.status).filter((v): v is string => !!v))].sort(),
    owner: [...new Set(rows.map((row) => row.owner).filter((v): v is string => !!v))].sort(),
    location: [...new Set(rows.map((row) => row.location).filter((v): v is string => !!v))].sort(),
  };

  if (input.status) rows = rows.filter((row) => row.status === input.status);
  if (input.owner) rows = rows.filter((row) => row.owner === input.owner);
  if (input.location) rows = rows.filter((row) => row.location === input.location);
  if (input.dueBefore) rows = rows.filter((row) => row.due !== undefined && row.due <= input.dueBefore!);

  return { module: module.id, tab, rows, filters };
}
