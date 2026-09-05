import { EVENT_TYPES, isPlatformGovernanceEvent, lookupEventType, type EventGroup } from '../goldenthread/eventTypes.ts';
import type { StorePosition } from '../goldenthread/pgstore.ts';
import type { Platform } from '../platform.ts';

/**
 * The event store, as an operator may look at it.
 *
 * The Golden Thread is the whole platform's record and the operator layer is
 * barred from customer delivery data, so the two requirements meet on one rule:
 * **this counts, and never reads.** Every figure below is derived from an
 * event's `eventType`, `tenantId`, `projectId` and `timestamp`. No `diff`, no
 * `entity` id, no evidence reference and no actor leaves this module for a
 * customer chain — those are the fields that carry what somebody is building,
 * and an operator has no business with them.
 *
 * The one exception is the platform's own governance chain, which the operator
 * *is* accountable for and which `/v1/admin/audit` already publishes in full.
 * That route stays the way to read those events; this one does not duplicate it.
 *
 * **What it is for.** Three questions the estate cannot otherwise answer:
 *
 * 1. *Is the record growing, and where?* Events by type, by group, by tenancy,
 *    over time.
 * 2. *Which of the catalogue is dead?* An event type defined and never once
 *    emitted is either a feature nobody uses or a command nobody can reach. The
 *    catalogue invariant proves a command *exists* that emits each code; it
 *    cannot prove anybody ever ran it. This can.
 * 3. *Is the journal keeping up with the ledger?* A count that disagrees with
 *    the durable journal is the shape of a write that did not survive.
 */

export type EventTypeUsage = {
  code: string;
  entity: string;
  action: string;
  group: EventGroup;
  count: number;
  /** How many tenancies have ever emitted it — one tenancy is not adoption. */
  tenancies: number;
  firstAt?: string;
  lastAt?: string;
  aiAllowed: boolean;
  requiresEvidence: boolean;
};

export type EventStorePosition = {
  /** Every event on every chain this process holds. */
  total: number;
  /** Chains, which is projects plus the governance chain of each tenancy. */
  chains: number;
  tenancies: number;
  /** Codes in the catalogue, and how many of them have ever been written. */
  catalogue: { defined: number; used: number; unused: string[] };
  byGroup: { group: EventGroup; count: number; codes: number }[];
  byType: EventTypeUsage[];
  byTenant: { tenantId: string; legalName: string; events: number; chains: number; lastAt?: string }[];
  /** Events per day over the window, so growth is visible rather than inferred. */
  daily: { date: string; count: number }[];
  windowDays: number;
  /** Events written by an AI actor against events written by a person. */
  authorship: { human: number; ai: number; system: number };
  /** How much of the record carries an evidence reference. */
  evidence: { withEvidence: number; requiringEvidence: number };
  journal: { path: string; events: number; bytes: number; truncated: boolean } | null;
  /**
   * Ledger count against journal count. A difference is not automatically a
   * defect — a process that has never restarted holds events the journal has
   * and vice versa is impossible — but it is the one number worth watching.
   */
  durability: { ledgerEvents: number; journalEvents: number; agrees: boolean; note: string };
  /**
   * The ledger store in Postgres, where one is configured: what it holds against
   * what the ledger holds, and whether shipping has stopped. Absent means the
   * journal on this volume is the only durable copy.
   */
  store: (StorePosition & { ledgerEvents: number; agrees: boolean; note: string }) | null;
  note: string;
};

const DEFAULT_WINDOW_DAYS = 30;

export function eventStorePosition(platform: Platform, windowDays = DEFAULT_WINDOW_DAYS): EventStorePosition {
  const events = platform.ledger.events();
  const tenants = platform.tenants();
  const namesById = new Map(tenants.map((tenant) => [tenant.id, tenant.legalName]));

  const byType = new Map<string, { count: number; tenancies: Set<string>; firstAt?: string; lastAt?: string }>();
  const byTenant = new Map<string, { events: number; chains: Set<string>; lastAt?: string }>();
  const chains = new Set<string>();
  const daily = new Map<string, number>();
  const authorship = { human: 0, ai: 0, system: 0 };
  let withEvidence = 0;
  let requiringEvidence = 0;

  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  for (const event of events) {
    chains.add(event.projectId);

    const type = byType.get(event.eventType) ?? { count: 0, tenancies: new Set<string>() };
    type.count += 1;
    type.tenancies.add(event.tenantId);
    if (!type.firstAt || event.timestamp < type.firstAt) type.firstAt = event.timestamp;
    if (!type.lastAt || event.timestamp > type.lastAt) type.lastAt = event.timestamp;
    byType.set(event.eventType, type);

    const tenant = byTenant.get(event.tenantId) ?? { events: 0, chains: new Set<string>() };
    tenant.events += 1;
    tenant.chains.add(event.projectId);
    if (!tenant.lastAt || event.timestamp > tenant.lastAt) tenant.lastAt = event.timestamp;
    byTenant.set(event.tenantId, tenant);

    if (event.timestamp >= since) {
      const day = event.timestamp.slice(0, 10);
      daily.set(day, (daily.get(day) ?? 0) + 1);
    }

    // Who wrote it. `source` distinguishes a person's action from an agent's
    // from the platform acting on its own — and the split is the one number
    // that answers "how much of this record did a model produce", which is a
    // question every regulator eventually asks.
    if (event.actor.refType === 'System') authorship.system += 1;
    else if (event.ai) authorship.ai += 1;
    else authorship.human += 1;

    if ((event.evidenceRefs ?? []).length > 0) withEvidence += 1;
    if (lookupEventType(event.eventType)?.requiresEvidence) requiringEvidence += 1;
  }

  const usage: EventTypeUsage[] = EVENT_TYPES.map((definition) => {
    const seen = byType.get(definition.code);
    return {
      code: definition.code,
      entity: definition.entity,
      action: definition.action,
      group: definition.group,
      count: seen?.count ?? 0,
      tenancies: seen?.tenancies.size ?? 0,
      firstAt: seen?.firstAt,
      lastAt: seen?.lastAt,
      aiAllowed: definition.aiAllowed,
      requiresEvidence: definition.requiresEvidence,
    };
  }).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

  const groups = new Map<EventGroup, { count: number; codes: number }>();
  for (const entry of usage) {
    const group = groups.get(entry.group) ?? { count: 0, codes: 0 };
    group.count += entry.count;
    group.codes += 1;
    groups.set(entry.group, group);
  }

  const journal = platform.ledger.journal?.stats() ?? null;
  const shipping = platform.ledgerStore?.position();
  const store =
    shipping === undefined
      ? null
      : {
          ...shipping,
          ledgerEvents: platform.ledger.size,
          agrees: shipping.stored === platform.ledger.size && shipping.pending === 0 && !shipping.halted,
          note: shipping.halted
            ? shipping.mode === 'follower'
              ? `Following has stopped: ${shipping.halted}`
              : `Shipping to Postgres has stopped: ${shipping.halted}`
            : shipping.mode === 'follower'
              ? `This process follows Postgres and extends nothing: ${
                  shipping.following?.behind === 0
                    ? 'it holds every event the database holds'
                    : `it is ${shipping.following?.behind ?? 0} event${shipping.following?.behind === 1 ? '' : 's'} behind the database`
                }, polling every ${shipping.following?.intervalMs ?? 0}ms${
                  shipping.following?.lastError ? ` — the last poll failed: ${shipping.following.lastError}` : ''
                }. Every write here is refused; the primary takes them. Promote this process by restarting it in primary mode once the primary has stopped.`
            : shipping.pending > 0
              ? `${shipping.pending} event${shipping.pending === 1 ? '' : 's'} committed here and not yet in Postgres${
                  shipping.lastError ? ` — the last attempt failed: ${shipping.lastError}` : ' — shipping is in progress'
                }. Every one of them is in the journal on this volume.`
              : shipping.mode === 'primary'
                ? `Postgres holds every event the ledger holds. A new host replays from it; this process ${
                    shipping.restoredFrom === 'POSTGRES' ? 'came up from it' : 'came up from the journal and brought it up to date'
                  }.`
                : 'Postgres holds every event the ledger holds, beside the journal a restart still replays. The two agree; LEDGER_POSTGRES_MODE=primary would make Postgres the copy a new host comes up from.',
        };

  return {
    total: events.length,
    chains: chains.size,
    tenancies: byTenant.size,
    catalogue: {
      defined: EVENT_TYPES.length,
      used: usage.filter((entry) => entry.count > 0).length,
      // Named rather than counted. "Forty-one unused" is a statistic; the list
      // is the work.
      unused: usage.filter((entry) => entry.count === 0).map((entry) => entry.code),
    },
    byGroup: [...groups.entries()]
      .map(([group, value]) => ({ group, ...value }))
      .sort((a, b) => b.count - a.count),
    byType: usage,
    byTenant: [...byTenant.entries()]
      .map(([tenantId, value]) => ({
        tenantId,
        legalName: namesById.get(tenantId) ?? tenantId,
        events: value.events,
        chains: value.chains.size,
        lastAt: value.lastAt,
      }))
      .sort((a, b) => b.events - a.events),
    daily: [...daily.entries()].map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date)),
    windowDays,
    authorship,
    evidence: { withEvidence, requiringEvidence },
    journal,
    store,
    durability: journal
      ? {
          ledgerEvents: events.length,
          journalEvents: journal.events,
          agrees: journal.events === events.length,
          note:
            journal.events === events.length
              ? 'The durable journal holds exactly what the ledger holds.'
              : 'The journal and the ledger disagree on how many events exist. A restart replays the journal, so the ' +
                'journal is what survives — a ledger holding more than the journal means writes that would be lost.',
        }
      : {
          ledgerEvents: events.length,
          journalEvents: 0,
          agrees: false,
          note:
            'No journal is attached, so nothing here survives a restart. Set LEDGER_JOURNAL_PATH to a path on the ' +
            'volume. This is correct for a test process and is not correct for a deployment holding anybody’s record.',
        },
    note:
      'Counts only. This screen reads an event’s type, tenancy, chain and timestamp and never its content — the diff, ' +
      'the entity, the evidence and the actor of a customer chain are not reachable from the operator layer, and that ' +
      'is enforced in the account boundary rather than by this screen choosing not to show them. The platform’s own ' +
      'governance events are published in full under Audit Logs, which is the record an operator is accountable for.',
  };
}

/**
 * The platform's own chain, as a stream rather than a summary.
 *
 * Distinct from `/v1/admin/audit`, which verifies the chain and is arranged
 * around accountability. This is arranged around the record: newest first, one
 * page at a time, with the chain link on each so an operator can follow it.
 * Restricted to platform governance codes by the same list the audit route uses
 * — a code not on that list is a customer's work and is not reachable here.
 */
export function platformEventStream(platform: Platform, limit = 100): {
  events: {
    eventId: string;
    timestamp: string;
    eventType: string;
    tenantId: string;
    projectId: string;
    entity: string;
    action: string;
    actor: string;
    source: string;
    chainHash?: string;
    previousChainHash?: string;
  }[];
  total: number;
  limit: number;
} {
  const all = platform.ledger
    .events()
    .filter((event) => isPlatformGovernanceEvent(event.eventType))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return {
    total: all.length,
    limit,
    events: all.slice(0, limit).map((event) => ({
      eventId: event.eventId,
      timestamp: event.timestamp,
      eventType: event.eventType,
      tenantId: event.tenantId,
      projectId: event.projectId,
      entity: event.entity.refType,
      action: event.action,
      actor: event.actor.refType === 'System' ? 'system' : event.actor.refId,
      source: event.source,
      chainHash: event.chainHash,
      previousChainHash: event.previousChainHash,
    })),
  };
}
