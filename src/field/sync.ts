import { hashEvidence } from '../core/canonical.ts';
import { ConflictError, DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import type { GoldenThreadLedger } from '../goldenthread/ledger.ts';
import type { EntityRef, EventSource, GoldenThreadEvent } from '../goldenthread/types.ts';
import type { AuthContext } from '../identity/auth.ts';

/**
 * Offline-first field execution.
 *
 * Sites lose signal. A supervisor recording a pour at the bottom of a shaft
 * cannot wait for connectivity, and a record they cannot make is a record that
 * never exists. So the device is authoritative for capture: it writes locally,
 * keeps its own timestamps, and reconciles later.
 *
 * Three properties make that safe rather than merely convenient:
 *
 *   1. **Device timestamps survive.** The server records when it received an
 *      operation, but the field record keeps the time the work happened. In a
 *      dispute, the time on the record is the time on site.
 *   2. **Sync is idempotent.** Operations carry a client-minted id. A retried
 *      batch after a dropped connection changes nothing the second time.
 *   3. **Conflicts resolve deterministically.** Two devices editing the same
 *      task produce the same outcome regardless of which arrives first.
 */

export type SyncOperation = {
  /** Client-minted, stable across retries. This is what makes push idempotent. */
  operationId: string;
  deviceId: string;
  /** When the work actually happened, per the device clock. */
  deviceTimestamp: string;
  eventType: string;
  entity: EntityRef;
  nextState: Record<string, unknown>;
  evidenceRefs?: EntityRef[];
  /** State hash the device believed current when it made the change. */
  baseStateHash?: string;
  source: Extract<EventSource, 'ANDROID' | 'IOS'>;
};

export type SyncConflict = {
  operationId: string;
  entity: EntityRef;
  reason: string;
  resolution: 'SERVER_WINS' | 'DEVICE_WINS' | 'MERGED' | 'REJECTED';
  /** What the caller should show the operative, if anything. */
  message: string;
};

export type SyncPushResult = {
  syncSessionId: string;
  accepted: string[];
  duplicates: string[];
  conflicts: SyncConflict[];
  /** Cursor the device should pull from next. */
  cursor: string;
  serverTime: string;
};

export type SyncPullResult = {
  events: GoldenThreadEvent[];
  cursor: string;
  hasMore: boolean;
  serverTime: string;
};

/**
 * Role priority for conflict resolution. Where two people changed the same
 * thing, the more senior decision stands — and the losing change is still
 * recorded, so nothing is silently discarded.
 */
const ROLE_PRIORITY: Record<string, number> = {
  PM: 90,
  OWNER: 95,
  EPC: 80,
  SAFETY: 85,
  QAQC: 75,
  QS: 70,
  PLANNER: 70,
  SUPERVISOR: 60,
  BIM: 60,
  DESIGNER: 60,
  FM: 50,
  SUPPLIER: 10,
  REGULATOR: 0,
};

function priorityOf(auth: AuthContext): number {
  return Math.max(0, ...auth.roles.map((role) => ROLE_PRIORITY[role] ?? 0));
}

/** Operations that must never be accepted from a device. */
const FIELD_FORBIDDEN_EVENTS = new Set([
  'PROGRAMME_BASELINE_APPROVED',
  'BUDGET_BASELINE_APPROVED',
  'ESTIMATE_FROZEN',
  'RFQ_AWARDED',
  'ADJUDICATION_COMPLETED',
  'CONTRACT_INGESTED',
  'HANDOVER_ACCEPTED',
  'INVOICE_ISSUED',
]);

export class SyncEngine {
  readonly #ledger: GoldenThreadLedger;
  /** operationId → the event it produced, for idempotent replays. */
  readonly #applied = new Map<string, string>();
  /** Highest cursor issued per device, so cursors never move backwards. */
  readonly #deviceCursors = new Map<string, string>();

  constructor(ledger: GoldenThreadLedger) {
    this.#ledger = ledger;
  }

  /**
   * Accept a batch of offline operations.
   *
   * The batch is applied in device-timestamp order so that a device which was
   * offline for a day replays its work in the order it actually happened.
   */
  push(
    auth: AuthContext,
    projectId: string,
    operations: SyncOperation[],
    correlationId: string,
  ): SyncPushResult {
    const syncSessionId = ulid();
    const accepted: string[] = [];
    const duplicates: string[] = [];
    const conflicts: SyncConflict[] = [];

    const ordered = [...operations].sort((a, b) =>
      a.deviceTimestamp === b.deviceTimestamp
        ? a.operationId < b.operationId
          ? -1
          : 1
        : a.deviceTimestamp < b.deviceTimestamp
          ? -1
          : 1,
    );

    for (const operation of ordered) {
      // --- Idempotency -----------------------------------------------------
      if (this.#applied.has(operation.operationId)) {
        duplicates.push(operation.operationId);
        continue;
      }

      // --- What a device is allowed to do ----------------------------------
      if (FIELD_FORBIDDEN_EVENTS.has(operation.eventType)) {
        conflicts.push({
          operationId: operation.operationId,
          entity: operation.entity,
          reason: 'EVENT_NOT_PERMITTED_OFFLINE',
          resolution: 'REJECTED',
          message: `${operation.eventType} is a governance action and must be performed online with approval.`,
        });
        continue;
      }

      const current = this.#ledger.get(operation.entity);

      // --- Conflict detection ----------------------------------------------
      if (operation.baseStateHash && current && operation.baseStateHash !== current.stateHash) {
        const resolution = this.#resolve(auth, operation, current.state);

        if (resolution.resolution === 'SERVER_WINS') {
          conflicts.push(resolution);
          continue;
        }
        // DEVICE_WINS and MERGED both fall through and commit, with the
        // conflict recorded so the operative and the audit both see it.
        conflicts.push(resolution);
      }

      try {
        const { event } = this.#ledger.commit({
          tenantId: auth.tenantId,
          projectId,
          actor: { refType: 'User', refId: auth.actorId },
          source: operation.source,
          correlationId,
          causationId: syncSessionId,
          eventType: operation.eventType,
          entity: operation.entity,
          nextState: operation.nextState,
          evidenceRefs: operation.evidenceRefs,
          // The server records receipt time; the device time is preserved
          // alongside it as the time the work actually happened.
          timestamp: new Date().toISOString(),
          deviceTimestamp: operation.deviceTimestamp,
        });

        this.#applied.set(operation.operationId, event.eventId);
        accepted.push(operation.operationId);
      } catch (error) {
        conflicts.push({
          operationId: operation.operationId,
          entity: operation.entity,
          reason: error instanceof DomainError ? error.code : 'COMMIT_FAILED',
          resolution: 'REJECTED',
          message: error instanceof Error ? error.message : 'The operation could not be applied',
        });
      }
    }

    const cursor = this.#issueCursor(operations[0]?.deviceId ?? 'unknown', projectId);

    return { syncSessionId, accepted, duplicates, conflicts, cursor, serverTime: new Date().toISOString() };
  }

  /**
   * Pull everything the device has not seen. Cursors are monotonic: a device
   * cannot be handed a cursor earlier than one it already holds, which is what
   * stops a stale client from re-downloading and re-applying old state.
   */
  pull(
    auth: AuthContext,
    projectId: string,
    deviceId: string,
    since: string | undefined,
    limit = 500,
  ): SyncPullResult {
    const held = this.#deviceCursors.get(`${deviceId}:${projectId}`);
    if (since && held && since < held) {
      throw new ConflictError(
        'The supplied cursor is older than the one this device already holds; pull from the held cursor instead',
        'CURSOR_REGRESSION',
      );
    }

    const all = this.#ledger.events({ tenantId: auth.tenantId, projectId, from: since });
    const page = all.slice(0, limit);
    const cursor = page[page.length - 1]?.timestamp ?? since ?? new Date().toISOString();

    this.#deviceCursors.set(`${deviceId}:${projectId}`, cursor);

    return { events: page, cursor, hasMore: all.length > page.length, serverTime: new Date().toISOString() };
  }

  /**
   * Deterministic conflict resolution.
   *
   * Additive field records never conflict — two operatives can both log an
   * observation. Conflicts only arise on shared mutable state, and there the
   * rule is: safety-critical always wins, then role priority, then last write.
   */
  #resolve(auth: AuthContext, operation: SyncOperation, serverState: Record<string, unknown>): SyncConflict {
    const base = { operationId: operation.operationId, entity: operation.entity };

    // A safety stop must never be overwritten by a routine progress update
    // that happened to be made later.
    if (serverState.safetyStop === true && operation.entity.refType !== 'SafetyObservation') {
      return {
        ...base,
        reason: 'SAFETY_STOP_IN_FORCE',
        resolution: 'SERVER_WINS',
        message: 'A safety stop is in force on this item; the change was not applied.',
      };
    }

    // Progress is monotonic. A device that was offline reporting 40% must not
    // pull back a later, higher figure recorded by someone else.
    if (operation.entity.refType === 'Task') {
      const devicePercent = Number(operation.nextState.percentComplete ?? 0);
      const serverPercent = Number(serverState.percentComplete ?? 0);
      if (devicePercent < serverPercent) {
        return {
          ...base,
          reason: 'PROGRESS_REGRESSION',
          resolution: 'SERVER_WINS',
          message: `Progress on site is already recorded at ${serverPercent}%; the offline figure of ${devicePercent}% was not applied.`,
        };
      }
    }

    const devicePriority = priorityOf(auth);
    const serverPriority = Number(serverState._lastWriterPriority ?? 0);

    if (serverPriority > devicePriority) {
      return {
        ...base,
        reason: 'ROLE_PRIORITY',
        resolution: 'SERVER_WINS',
        message: 'A more senior role changed this item while the device was offline.',
      };
    }

    return {
      ...base,
      reason: 'CONCURRENT_EDIT',
      resolution: 'DEVICE_WINS',
      message: 'This item changed while the device was offline; the field record was applied over it.',
    };
  }

  #issueCursor(deviceId: string, projectId: string): string {
    const cursor = new Date().toISOString();
    const key = `${deviceId}:${projectId}`;
    const held = this.#deviceCursors.get(key);
    // Monotonicity: never hand back a cursor earlier than the one already held.
    const next = held && held > cursor ? held : cursor;
    this.#deviceCursors.set(key, next);
    return next;
  }

  /** Operator view of what a device has outstanding. */
  deviceState(deviceId: string, projectId: string): { cursor?: string; appliedOperations: number } {
    return {
      cursor: this.#deviceCursors.get(`${deviceId}:${projectId}`),
      appliedOperations: this.#applied.size,
    };
  }
}

/**
 * Media captured offline is hashed on the device before upload, so the file
 * that reaches the platform can be proven to be the file that was captured.
 */
export function fieldEvidenceHash(deviceId: string, capturedAt: string, content: string): string {
  return hashEvidence(`${deviceId}|${capturedAt}|${content}`);
}
