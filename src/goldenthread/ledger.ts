import { canonicalize, hashState, sha256, EMPTY_STATE_HASH } from '../core/canonical.ts';
import { applyPatch, diffState, orderPatch, validatePatch, type PatchOp } from '../core/jsonpatch.ts';
import { ConflictError, DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { assertValid, type Schema } from '../core/validate.ts';
import { lookupEventType } from './eventTypes.ts';
import type { ActorRef, EntityRef, EventSource, GoldenThreadEvent, AIEventBlock, PolicyBlock } from './types.ts';

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

    const diff: PatchOp[] = orderPatch(diffState(beforeState ?? {}, input.nextState));
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
      actor: input.actor,
      source: input.source,
      eventType: input.eventType,
      entity: input.entity,
      action: definition.action,
      beforeHash,
      afterHash,
      diff,
      correlationId: input.correlationId,
    };
    if (evidenceRefs.length > 0) event.evidenceRefs = evidenceRefs;
    if (input.ai) event.ai = input.ai;
    if (input.policy) event.policy = input.policy;
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
      state: afterState,
      stateHash: afterHash,
      lastEventId: eventId,
      version: (existing?.version ?? 0) + 1,
    };

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
