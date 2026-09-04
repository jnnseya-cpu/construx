import { canonicalize, hashState, sha256, EMPTY_STATE_HASH } from '../core/canonical.ts';
import { applyPatch, diffState, orderPatch, validatePatch, type PatchOp } from '../core/jsonpatch.ts';
import { ConflictError, DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { assertValid, type Schema } from '../core/validate.ts';
import { lookupEventType } from './eventTypes.ts';
import type { ActorRef, EntityRef, EventSource, GoldenThreadEvent, AIEventBlock, PolicyBlock } from './types.ts';
import type { Journal } from './journal.ts';

/**
 * The Golden Thread ledger: append-only, hash-chained, and the only route by
 * which entity state may change. Nothing in this system writes an entity
 * directly — a caller submits a change, the ledger derives the patch, verifies
 * it, and commits event + state together or not at all.
 */

export type EntityRecord = {
  refType: string;
  refId: string;
  tenantId: string;
  projectId: string;
  state: Record<string, unknown>;
  stateHash: string;
  lastEventId: string;
  version: number;
};

export type CommitInput = {
  tenantId: string;
  projectId: string;
  actor: ActorRef;
  source: EventSource;
  eventType: string;
  entity: EntityRef;
  /** Next full state. The ledger derives the patch by diffing against current state. */
  nextState: Record<string, unknown>;
  evidenceRefs?: EntityRef[];
  ai?: AIEventBlock;
  policy?: PolicyBlock;
  correlationId: string;
  causationId?: string;
  timestamp?: string;
  deviceTimestamp?: string;
  /**
   * The roles the actor held at this moment, and the project's lifecycle phase.
   *
   * Filled by `write()` and `runAI` rather than by each command, so no call site
   * can forget them. Optional here because the ledger is also driven by the
   * journal restore path, which replays events exactly as they were written —
   * including events written before these fields existed.
   */
  roleAtAction?: string[];
  lifecyclePhase?: string;
  /** Why this act was taken. The human's stated reason or the agent's rationale. */
  reason?: string;
  /** Optimistic concurrency: reject if current state hash has moved on. */
  expectedStateHash?: string;
};

export type LedgerSubscriber = (event: GoldenThreadEvent) => void;

/** Entity JSON Schemas, registered by refType, enforced after every patch. */
const entitySchemas = new Map<string, Schema>();

export function registerEntitySchema(refType: string, schema: Schema): void {
  entitySchemas.set(refType, schema);
}

export function getEntitySchema(refType: string): Schema | undefined {
  return entitySchemas.get(refType);
}

function entityKey(ref: EntityRef): string {
  return `${ref.refType}:${ref.refId}`;
}

/**
 * An event whose chain hash verifies — it is the event as written — but whose
 * recorded state hash is not the hash of the state its own patch produces.
 * The cause seen in production: a restarted process held the ledger's own
 * state object in its working maps, changed it in place, and the next commit
 * diffed against the changed object — so the patch omitted the change and
 * the hash included it. The ledger now freezes what it holds and the
 * platform copies what it restores. Reported at boot; the record is not
 * rewritten.
 */
export type StateHashDiscrepancy = {
  index: number;
  eventId: string;
  eventType: string;
  entity: EntityRef;
  recorded: string;
  computed: string;
};

/**
 * The ledger's own copy of a state is nobody else's to change. Frozen all the
 * way down, so `record.state.status = 'SUSPENDED'` throws where it is written
 * instead of rewriting the before-state the next commit diffs against — which
 * is how a production journal came to record a hash its own patch could not
 * reproduce. Readers spread or clone; they never assign into it.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value as Record<string, unknown>)) deepFreeze((value as Record<string, unknown>)[key]);
  return Object.freeze(value);
}

/** Canonical body used for chain hashing — excludes the chain fields themselves. */
function chainBody(event: GoldenThreadEvent): string {
  const { chainHash: _chain, previousChainHash: _previous, ...body } = event;
  return canonicalize(body);
}

export class GoldenThreadLedger {
  readonly #events: GoldenThreadEvent[] = [];
  readonly #entities = new Map<string, EntityRecord>();
  /** Head of the hash chain, per project. Tenants never share a chain. */
  readonly #chainHeads = new Map<string, string>();
  readonly #subscribers: LedgerSubscriber[] = [];
  /** eventId de-duplication — replayed sync batches must be idempotent. */
  readonly #seenEventIds = new Set<string>();
  /**
   * Per entity, the state hash the last replayed event *recorded* where it
   * differed from the hash of the replayed state. The writer that recorded it
   * carried on from the object it had, so the next event it wrote chains
   * from this value; replay accepts either.
   */
  readonly #recordedHashes = new Map<string, string>();
  readonly #discrepancies: StateHashDiscrepancy[] = [];
  /**
   * Durable log, when one is configured. Absent means in-process only, which
   * is correct for a test and is data loss on restart anywhere else.
   */
  #journal: Journal | undefined;

  /**
   * Attach a journal. Every subsequent commit is written and flushed to it
   * before any in-memory state changes.
   */
  attachJournal(journal: Journal): void {
    this.#journal = journal;
  }

  get journal(): Journal | undefined {
    return this.#journal;
  }

  subscribe(subscriber: LedgerSubscriber): void {
    this.#subscribers.push(subscriber);
  }

  /**
   * Commit a state change. Either the event and the new state both land, or
   * neither does: validation happens before anything is stored.
   */
  commit(input: CommitInput): { event: GoldenThreadEvent; record: EntityRecord } {
    const definition = lookupEventType(input.eventType);
    if (!definition) {
      throw new DomainError('EVENT_TYPE_UNKNOWN', `Event type "${input.eventType}" is not in the catalogue`);
    }
    if (definition.entity !== input.entity.refType) {
      throw new DomainError(
        'EVENT_ENTITY_MISMATCH',
        `Event "${input.eventType}" applies to ${definition.entity}, not ${input.entity.refType}`,
      );
    }
    if (input.actor.refType === 'AI' && !definition.aiAllowed) {
      throw new DomainError('AI_NOT_PERMITTED', `Event "${input.eventType}" may not be produced by an AI actor`);
    }
    if (definition.action === 'AI_EXECUTE' && !definition.aiAllowed) {
      throw new DomainError('AI_NOT_PERMITTED', `Event "${input.eventType}" declares AI_EXECUTE but forbids AI`);
    }
    const evidenceRefs = input.evidenceRefs ?? [];
    if (definition.requiresEvidence && evidenceRefs.length === 0) {
      throw new DomainError(
        'EVIDENCE_REQUIRED',
        `Event "${input.eventType}" requires at least one evidence reference`,
      );
    }
    if (input.ai && input.actor.refType !== 'AI' && input.ai.acuConsumed > 0) {
      throw new DomainError('AI_ACTOR_REQUIRED', 'Events consuming ACUs must be attributed to an AI actor');
    }

    const key = entityKey(input.entity);
    const existing = this.#entities.get(key);

    if (existing && (existing.tenantId !== input.tenantId || existing.projectId !== input.projectId)) {
      // Cross-tenant writes are a hard isolation breach, not a validation nit.
      throw new DomainError('TENANT_ISOLATION_BREACH', 'Entity belongs to a different tenant or project', 403);
    }
    // CREATE and IMPORT bring an entity into existence; EXECUTE and AI_EXECUTE
    // may also produce a first record (a snapshot, an evaluation, an execution
    // log). Every other action requires the entity to already exist.
    const mayCreate =
      definition.action === 'CREATE' ||
      definition.action === 'IMPORT' ||
      definition.action === 'EXECUTE' ||
      definition.action === 'AI_EXECUTE' ||
      definition.creates;
    if (!existing && !mayCreate) {
      throw new DomainError('ENTITY_NOT_FOUND', `${input.entity.refType} ${input.entity.refId} does not exist`, 404);
    }
    if (existing && (definition.action === 'CREATE')) {
      throw new ConflictError(`${input.entity.refType} ${input.entity.refId} already exists`, 'ENTITY_EXISTS');
    }

    const beforeState = existing ? existing.state : undefined;
    const beforeHash = existing ? existing.stateHash : EMPTY_STATE_HASH;

    if (input.expectedStateHash && input.expectedStateHash !== beforeHash) {
      throw new ConflictError('Entity has changed since it was read', 'STALE_STATE');
    }

    // Diff against a copy the caller does not hold a reference to.
    //
    // A patch operation carries its value by reference. Left aliased to the
    // caller's object, anything that object does afterwards happens inside an
    // event that has already been hashed: `analyseITT` sorted its assessed
    // terms after committing, which reordered the very array the event's patch
    // pointed at, and the chain hash stopped verifying on replay. Nothing in
    // the caller was obviously wrong, and nothing in the ledger noticed.
    //
    // Committed history cannot be hostage to what a caller does next, so the
    // ledger takes its own copy before it derives anything from the proposal.
    //
    // The copy is a JSON round trip, not `structuredClone`, and the
    // difference is what a production journal refused to replay. A clone
    // keeps a `Date`, a `Buffer` or a `Map` as it is; the journal writes JSON,
    // where a Date is a string and a Buffer is `{ type, data }`. The hash was
    // computed over the object in memory and recorded beside a patch that,
    // read back from disk, produced a different object — and the chain
    // refused to start on its own record. Hashing what will be written, as it
    // will be read, is the only way the two can agree.
    const proposed = JSON.parse(JSON.stringify(input.nextState)) as Record<string, unknown>;
    const diff: PatchOp[] = orderPatch(diffState(beforeState ?? {}, proposed));
    validatePatch(diff);
    if (diff.length === 0 && existing) {
      throw new DomainError('NO_OP_CHANGE', 'Commit produced no state change');
    }

    // Re-derive the after-state by applying the patch, rather than trusting the
    // caller's object. If patch and intent disagree, replay would diverge later.
    const afterState = applyPatch<Record<string, unknown>>((beforeState ?? {}) as Record<string, unknown>, diff);

    const schema = entitySchemas.get(input.entity.refType);
    if (schema) assertValid(afterState, schema, `${input.entity.refType} state`);

    const afterHash = hashState(afterState);
    const timestamp = input.timestamp ?? new Date().toISOString();
    const eventId = ulid();

    const event: GoldenThreadEvent = {
      eventId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      timestamp,
      // Copied, like the state above and for the same reason: an actor or an
      // entity reference the caller still holds must not be something the
      // caller can edit after it has been hashed. The event owns everything it
      // carries, or it owns none of it.
      actor: structuredClone(input.actor),
      source: input.source,
      eventType: input.eventType,
      entity: structuredClone(input.entity),
      action: definition.action,
      ...(input.roleAtAction ? { roleAtAction: input.roleAtAction } : {}),
      ...(input.lifecyclePhase ? { lifecyclePhase: input.lifecyclePhase } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      beforeHash,
      afterHash,
      diff,
      correlationId: input.correlationId,
    };
    if (evidenceRefs.length > 0) event.evidenceRefs = structuredClone(evidenceRefs);
    if (input.ai) event.ai = structuredClone(input.ai);
    if (input.policy) event.policy = structuredClone(input.policy);
    if (input.causationId) event.causationId = input.causationId;
    if (input.deviceTimestamp) event.deviceTimestamp = input.deviceTimestamp;

    const previousChainHash = this.#chainHeads.get(input.projectId) ?? EMPTY_STATE_HASH;
    event.previousChainHash = previousChainHash;
    event.chainHash = sha256(`${previousChainHash}\n${chainBody(event)}`);

    const record: EntityRecord = {
      refType: input.entity.refType,
      refId: input.entity.refId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      state: deepFreeze(afterState),
      stateHash: afterHash,
      lastEventId: eventId,
      version: (existing?.version ?? 0) + 1,
    };

    // Write-ahead. If this throws, nothing below runs and no state changed —
    // which is the whole point. Acknowledging a commit that is not on disk
    // means telling somebody their payment notice was issued and losing it.
    this.#journal?.append(event);

    this.#events.push(event);
    this.#seenEventIds.add(eventId);
    this.#entities.set(key, record);
    this.#chainHeads.set(input.projectId, event.chainHash);

    for (const subscriber of this.#subscribers) {
      // A misbehaving projection must not roll back a committed event.
      try {
        subscriber(event);
      } catch {
        /* projections are best-effort; the ledger remains the source of truth */
      }
    }

    return { event, record };
  }

  /**
   * Rebuild state from a journal, verifying the chain as it goes.
   *
   * Not a fast path that trusts the file. Each event's chain hash is
   * recomputed from its predecessor and each state hash from the applied
   * patch, so a journal edited by hand — or corrupted on disk — is refused
   * rather than loaded. A record that verifies against nothing is worse than no
   * record, because somebody will rely on it.
   *
   * Deliberately does not re-run authorisation or domain validation. Those
   * decisions were made when the event was committed, by an actor whose
   * permissions may since have changed; re-evaluating them now would rewrite
   * history according to today's permission matrix.
   */
  restore(events: readonly GoldenThreadEvent[]): { restored: number; entities: number; discrepancies: StateHashDiscrepancy[] } {
    const discrepancies: StateHashDiscrepancy[] = [];
    for (const [index, event] of events.entries()) {
      const key = entityKey(event.entity);
      const existing = this.#entities.get(key);
      const beforeState = existing?.state;

      // The hash the process that wrote the next event believed this entity
      // had. Normally the hash of the replayed state; where an earlier event
      // recorded a hash over a value JSON changed, the process kept working
      // from the object in memory, and the events it wrote afterwards chain
      // from the hash it recorded — which is the one to accept.
      const beforeHash = beforeState === undefined ? EMPTY_STATE_HASH : hashState(beforeState);
      const recorded = this.#recordedHashes.get(key);
      if (event.beforeHash !== beforeHash && event.beforeHash !== recorded) {
        throw new DomainError(
          'JOURNAL_CHAIN_BROKEN',
          `Journal event ${index + 1} (${event.eventId}) expects prior state ${event.beforeHash} for ` +
            `${event.entity.refType} ${event.entity.refId}, but replay produced ${beforeHash}. ` +
            'An event is missing, reordered, or the file has been altered.',
        );
      }

      const afterState = applyPatch<Record<string, unknown>>((beforeState ?? {}) as Record<string, unknown>, event.diff);
      const afterHash = hashState(afterState);
      // Decided after the chain hash below has verified: the chain hash
      // covers the patch and the recorded state hash together, so an event
      // that verifies is the event as written, and a state hash that still
      // disagrees with its own patch is the writer's arithmetic, not an
      // alteration. It is recorded and reported, never hidden.
      const stateMismatch = event.afterHash !== afterHash;

      const previousChainHash = this.#chainHeads.get(event.projectId) ?? EMPTY_STATE_HASH;
      if (event.previousChainHash !== previousChainHash) {
        throw new DomainError(
          'JOURNAL_CHAIN_BROKEN',
          `Journal event ${index + 1} (${event.eventId}) chains from ${event.previousChainHash}, ` +
            `but the head of project ${event.projectId} is ${previousChainHash}.`,
        );
      }

      const expectedChainHash = sha256(`${previousChainHash}\n${chainBody(event)}`);
      if (event.chainHash !== expectedChainHash) {
        throw new DomainError(
          'JOURNAL_CHAIN_BROKEN',
          `Journal event ${index + 1} (${event.eventId}) carries chain hash ${event.chainHash}, ` +
            `but recomputing it gives ${expectedChainHash}. The record has been tampered with.`,
        );
      }

      if (stateMismatch) {
        discrepancies.push({
          index: index + 1,
          eventId: event.eventId,
          eventType: event.eventType,
          entity: { refType: event.entity.refType, refId: event.entity.refId },
          recorded: event.afterHash,
          computed: afterHash,
        });
        this.#recordedHashes.set(key, event.afterHash);
      } else {
        this.#recordedHashes.delete(key);
      }

      this.#events.push(event);
      this.#seenEventIds.add(event.eventId);
      this.#entities.set(key, {
        refType: event.entity.refType,
        refId: event.entity.refId,
        tenantId: event.tenantId,
        projectId: event.projectId,
        state: deepFreeze(afterState),
        // The hash of the state as replayed — what the next commit chains
        // from, and what every commit from now on records, since the hash is
        // now taken over the JSON that is written.
        stateHash: afterHash,
        lastEventId: event.eventId,
        version: (existing?.version ?? 0) + 1,
      });
      this.#chainHeads.set(event.projectId, event.chainHash);
    }

    this.#discrepancies.push(...discrepancies);
    return { restored: events.length, entities: this.#entities.size, discrepancies };
  }

  /** Every state-hash discrepancy found on replay since this ledger was built. */
  discrepancies(): readonly StateHashDiscrepancy[] {
    return this.#discrepancies;
  }

  /** Idempotent ingestion of an event minted elsewhere (offline device, replica). */
  hasEvent(eventId: string): boolean {
    return this.#seenEventIds.has(eventId);
  }

  get(ref: EntityRef): EntityRecord | undefined {
    return this.#entities.get(entityKey(ref));
  }

  require(ref: EntityRef): EntityRecord {
    const record = this.#entities.get(entityKey(ref));
    if (!record) throw new DomainError('ENTITY_NOT_FOUND', `${ref.refType} ${ref.refId} not found`, 404);
    return record;
  }

  /** Every entity of a type within a project, ordered by refId for determinism. */
  list(projectId: string, refType: string): EntityRecord[] {
    return [...this.#entities.values()]
      .filter((r) => r.projectId === projectId && r.refType === refType)
      .sort((a, b) => (a.refId < b.refId ? -1 : a.refId > b.refId ? 1 : 0));
  }

  /**
   * Every record of a type, across all projects and tenancies.
   *
   * Only for rebuilding platform-level state at boot, which is why it takes no
   * tenant: at that moment there is no caller to scope it to. Nothing serving a
   * request may use it — `list` and `listByTenant` are the scoped reads, and
   * every request path goes through one of those.
   */
  entitiesOfType(refType: string): EntityRecord[] {
    return [...this.#entities.values()].filter((r) => r.refType === refType);
  }

  listByTenant(tenantId: string, refType: string): EntityRecord[] {
    return [...this.#entities.values()]
      .filter((r) => r.tenantId === tenantId && r.refType === refType)
      .sort((a, b) => (a.refId < b.refId ? -1 : a.refId > b.refId ? 1 : 0));
  }

  /** Ordered event stream. Ordering is (timestamp, eventId) — the replay contract. */
  events(filter: { projectId?: string; tenantId?: string; until?: string; from?: string } = {}): GoldenThreadEvent[] {
    return this.#events
      .filter((e) => {
        if (filter.projectId && e.projectId !== filter.projectId) return false;
        if (filter.tenantId && e.tenantId !== filter.tenantId) return false;
        if (filter.until && e.timestamp > filter.until) return false;
        if (filter.from && e.timestamp < filter.from) return false;
        return true;
      })
      .sort((a, b) => (a.timestamp === b.timestamp ? (a.eventId < b.eventId ? -1 : 1) : a.timestamp < b.timestamp ? -1 : 1));
  }

  eventsForEntity(ref: EntityRef): GoldenThreadEvent[] {
    return this.#events
      .filter((e) => e.entity.refType === ref.refType && e.entity.refId === ref.refId)
      .sort((a, b) => (a.timestamp === b.timestamp ? (a.eventId < b.eventId ? -1 : 1) : a.timestamp < b.timestamp ? -1 : 1));
  }

  chainHead(projectId: string): string {
    return this.#chainHeads.get(projectId) ?? EMPTY_STATE_HASH;
  }

  get size(): number {
    return this.#events.length;
  }
}
