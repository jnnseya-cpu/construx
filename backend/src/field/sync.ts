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
  /**
   * The state the device was working from, where it still has it.
   *
   * The hash above says *that* the device was out of date. This says *what it
   * was out of date from*, which is the difference between picking a winner and
   * merging: without the base there is no way to tell a field the device
   * deliberately changed from one it merely carried along unchanged.
   *
   * Optional, and its absence changes nothing — a push without it resolves
   * exactly as it did before. The device already holds this locally; it is the
   * object it hashed.
   */
  baseState?: Record<string, unknown>;
  /**
   * Offline capture only. `WEB` is excluded deliberately: a desk browser has no
   * reason to push a batch, and allowing it would let an online client
   * backdate work through `deviceTimestamp` without the offline provenance
   * that justifies the backdating.
   */
  source: Extract<EventSource, 'PWA' | 'ANDROID' | 'IOS'>;
  /**
   * The operation shape this device speaks. Absent means 1.
   *
   * A fleet is never on one version. Stores roll out in stages, people decline
   * updates for weeks, and a phone that has been in a drawer since March comes
   * back holding a fortnight of work in a shape the server may since have
   * changed. Without a declared version the server reads whatever arrives as
   * though it were current, and an old payload is misread rather than refused —
   * silent corruption of a site record, which is the worst failure this
   * platform has.
   *
   * Optional because the shipped PWA does not send it, and breaking the client
   * that is already in the field to fix a mixed-fleet problem would be an
   * unusually direct way to prove the point.
   */
  schemaVersion?: number;
};

export type SyncConflict = {
  operationId: string;
  entity: EntityRef;
  reason: string;
  resolution: 'SERVER_WINS' | 'DEVICE_WINS' | 'MERGED' | 'REJECTED';
  /** What the caller should show the operative, if anything. */
  message: string;
  /**
   * The `SyncConflict` record this raised, for anyone who has to resolve it
   * later. Absent only where the record could not be written, which is itself
   * reported rather than swallowed.
   */
  conflictId?: string;
  /** On a merge, the fields taken from the device. Named, never counted. */
  mergedFields?: readonly string[];
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

/**
 * The operation shape this server understands, and the oldest it still accepts.
 *
 * Two numbers rather than one because they answer different questions. A device
 * *newer* than the server appears during a staged rollout, when the app updates
 * before the backend does; a device *older* than the minimum has been in a
 * drawer long enough that its shape has been retired. Both are refusals, and
 * they need different sentences — one says wait, the other says update.
 */
export const SYNC_SCHEMA_VERSION = 1;
export const MIN_SYNC_SCHEMA_VERSION = 1;

/**
 * The most operations one push may carry.
 *
 * The spec's number, and it is a real limit rather than a round one: a batch is
 * read into memory, ordered, and applied one at a time inside a single request,
 * so an unbounded batch is an unbounded allocation on a shared process. A
 * device with more than this to say makes more than one push, which the cursor
 * and the per-operation idempotency already make safe.
 */
export const MAX_SYNC_BATCH = 500;

/** A resolution, plus the state to commit where it is not the device's own. */
type Resolution = SyncConflict & { state?: Record<string, unknown> };

/** Values a merge will reason about. Anything else is left to the winner rules. */
function isScalar(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value);
}

/**
 * Merge two edits that touched different fields.
 *
 * Returns the merged state and the fields taken from the device, or `undefined`
 * where a merge is not safe — in which case the caller falls back to picking a
 * winner, exactly as it did before this existed.
 *
 * **A merge is refused unless every changed field on both sides is a scalar.**
 * Two devices appending to the same array have not edited different fields;
 * they have both edited the array, and "merging" them means choosing a
 * concatenation order that neither of them asked for. Nested objects are the
 * same problem one level down. Getting this wrong invents site data, which is
 * worse than reporting a conflict somebody has to look at.
 *
 * **And unless both sides actually changed something.** If only one did, there
 * is no conflict to merge — the hash mismatch came from somewhere else, and the
 * priority rules are the honest answer.
 */
function mergeDisjoint(
  baseState: Record<string, unknown> | undefined,
  deviceState: Record<string, unknown>,
  serverState: Record<string, unknown>,
): { state: Record<string, unknown>; fields: string[] } | undefined {
  if (!baseState) return undefined;

  const changed = (candidate: Record<string, unknown>): string[] =>
    [...new Set([...Object.keys(baseState), ...Object.keys(candidate)])].filter(
      (key) => JSON.stringify(candidate[key]) !== JSON.stringify(baseState[key]),
    );

  const byDevice = changed(deviceState);
  const byServer = changed(serverState);
  if (byDevice.length === 0 || byServer.length === 0) return undefined;

  // Any overlap at all, and this is a genuine disagreement about one field.
  // Not "an overlap where the values differ": two people setting the same field
  // to the same value by coincidence is not a merge, it is a race whose outcome
  // happens not to matter, and treating it as agreement would hide the next one
  // where it does.
  if (byDevice.some((key) => byServer.includes(key))) return undefined;

  for (const key of [...byDevice, ...byServer]) {
    if (!isScalar(baseState[key]) || !isScalar(deviceState[key]) || !isScalar(serverState[key])) return undefined;
  }

  const state = { ...serverState };
  for (const key of byDevice) state[key] = deviceState[key];
  return { state, fields: byDevice.sort() };
}

/**
 * Events a device may never originate, however good its authorisation.
 *
 * Exported and published at `/v1/permissions/matrix` so the installed
 * application can refuse a governance action at the point of the press. Without
 * that, the outbox queues an operation that will certainly be rejected on flush
 * and shows the operative an approval as "pending sync" until then. Settled
 * decision 6 again: the interface holds no rule the API does not publish.
 */
export const FIELD_FORBIDDEN_EVENTS = new Set([
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
  /**
   * batch key → the result that batch produced.
   *
   * Operations are already individually idempotent, so a replayed batch was
   * always *safe*; what it was not was cheap or honest. Five hundred operations
   * were re-read and re-checked to conclude that all five hundred were
   * duplicates, and the device was handed a result that said `duplicates: 500`
   * for a push it had every reason to believe was its first. Keyed on the batch
   * the device names, the same answer comes back — which is what a device
   * retrying after a dropped connection is asking for.
   */
  readonly #batches = new Map<string, SyncPushResult>();

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
    batchKey?: string,
  ): SyncPushResult {
    // --- The batch itself, before anything in it -----------------------------
    //
    // Refused whole rather than partially applied. A batch the server cannot
    // read is not a batch to make a best effort at: the device still holds
    // every operation, and holding them until it can be understood loses
    // nothing, where guessing at them loses the record.
    if (operations.length > MAX_SYNC_BATCH) {
      throw new DomainError(
        'SYNC_BATCH_TOO_LARGE',
        `A push carries at most ${MAX_SYNC_BATCH} operations; this one carried ${operations.length}. ` +
          'Split it — per-operation idempotency and the cursor make more than one push safe.',
        413,
      );
    }

    const versions = operations.map((operation) => operation.schemaVersion ?? 1);
    const tooNew = Math.max(...versions, 0);
    if (tooNew > SYNC_SCHEMA_VERSION) {
      throw new DomainError(
        'SYNC_SCHEMA_UNSUPPORTED',
        `This device speaks operation schema ${tooNew} and the server understands ${SYNC_SCHEMA_VERSION}. ` +
          'Nothing has been applied. Hold the batch and push again once the platform has been upgraded — ' +
          'reading a shape it does not know would misfile the record rather than refuse it.',
        409,
      );
    }
    const tooOld = Math.min(...versions, SYNC_SCHEMA_VERSION);
    if (tooOld < MIN_SYNC_SCHEMA_VERSION) {
      throw new DomainError(
        'SYNC_SCHEMA_RETIRED',
        `This device speaks operation schema ${tooOld}, which is no longer accepted (the oldest is ` +
          `${MIN_SYNC_SCHEMA_VERSION}). Nothing has been applied and nothing has been lost. Update the app; ` +
          'the work it is holding pushes unchanged afterwards.',
        409,
      );
    }

    // A batch the device has already sent gets the answer it got before, rather
    // than five hundred fresh duplicate reports.
    if (batchKey !== undefined) {
      const seen = this.#batches.get(batchKey);
      if (seen) return seen;
    }

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
        const refusal: Resolution = {
          operationId: operation.operationId,
          entity: operation.entity,
          reason: 'EVENT_NOT_PERMITTED_OFFLINE',
          resolution: 'REJECTED',
          message: `${operation.eventType} is a governance action and must be performed online with approval.`,
        };
        conflicts.push({
          ...refusal,
          conflictId: this.#raise(auth, projectId, correlationId, syncSessionId, operation, refusal, undefined),
        });
        continue;
      }

      const current = this.#ledger.get(operation.entity);

      // --- Conflict detection ----------------------------------------------
      //
      // Every resolution has a losing side, so every one of them is recorded
      // as a `SyncConflict` before anything else happens. Reporting it in the
      // response alone loses it the moment the device drops the response —
      // and the device is, by construction, the one with the bad connection.
      let toCommit = operation.nextState;

      if (operation.baseStateHash && current && operation.baseStateHash !== current.stateHash) {
        const resolution = this.#resolve(auth, operation, current.state);
        const conflictId = this.#raise(auth, projectId, correlationId, syncSessionId, operation, resolution, current.state);

        // `state` is the engine's business, not the caller's: it is how a
        // merge reaches the commit below, and publishing it would invite a
        // client to send one back.
        const { state, ...reported } = resolution;
        conflicts.push({ ...reported, conflictId });

        if (resolution.resolution === 'SERVER_WINS') continue;
        // DEVICE_WINS and MERGED both fall through and commit, with the
        // conflict recorded so the operative and the audit both see it.
        if (state) toCommit = state;
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
          // The device's own state, except on a merge, where it is the server's
          // record with the device's disjoint fields laid over it.
          nextState: toCommit,
          evidenceRefs: operation.evidenceRefs,
          // The server records receipt time; the device time is preserved
          // alongside it as the time the work actually happened.
          timestamp: new Date().toISOString(),
          deviceTimestamp: operation.deviceTimestamp,
        });

        this.#applied.set(operation.operationId, event.eventId);
        accepted.push(operation.operationId);
      } catch (error) {
        const rejection: Resolution = {
          operationId: operation.operationId,
          entity: operation.entity,
          reason: error instanceof DomainError ? error.code : 'COMMIT_FAILED',
          resolution: 'REJECTED',
          message: error instanceof Error ? error.message : 'The operation could not be applied',
        };
        // A rejection loses the device's work outright, so it is the case that
        // most needs a record somebody can find later.
        const conflictId = this.#raise(
          auth,
          projectId,
          correlationId,
          syncSessionId,
          operation,
          rejection,
          current?.state,
        );
        conflicts.push({ ...rejection, conflictId });
      }
    }

    const cursor = this.#issueCursor(operations[0]?.deviceId ?? 'unknown', projectId);

    const result: SyncPushResult = {
      syncSessionId,
      accepted,
      duplicates,
      conflicts,
      cursor,
      serverTime: new Date().toISOString(),
    };
    if (batchKey !== undefined) this.#batches.set(batchKey, result);
    return result;
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
  #resolve(auth: AuthContext, operation: SyncOperation, serverState: Record<string, unknown>): Resolution {
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

    // Field-level merge, before anybody has to win.
    //
    // Two people editing one record usually edited different parts of it: a
    // supervisor sets the plant on site while the engineer sets the pour
    // volume. Picking a winner there throws away a change nobody disagreed
    // with, and it is the most common conflict on a site.
    //
    // Only possible with the base state — see `SyncOperation.baseState`. Where
    // the device did not send it this falls straight through to the priority
    // rule, exactly as before.
    const merged = mergeDisjoint(operation.baseState, operation.nextState, serverState);

    // Progress is monotonic. A device that was offline reporting 40% must not
    // pull back a later, higher figure recorded by someone else.
    //
    // Read from what would actually be committed, not from the device's raw
    // payload. A device sends the whole record, so a handset that never touched
    // progress still carries the figure it last saw — and reading that as the
    // device's claim refused a note about formwork because somebody else had
    // moved the percentage in the meantime. The merged state keeps the server's
    // figure, so the rule now fires on a device that really did report
    // backwards and not on one that merely carried a stale field along.
    if (operation.entity.refType === 'Task') {
      const candidate = merged?.state ?? operation.nextState;
      const devicePercent = Number(candidate.percentComplete ?? 0);
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

    if (merged) {
      return {
        ...base,
        reason: 'DISJOINT_FIELDS',
        resolution: 'MERGED',
        message:
          `This item changed while the device was offline, but in different fields. ` +
          `${merged.fields.join(', ')} ${merged.fields.length === 1 ? 'was' : 'were'} taken from the device and the ` +
          'rest of the record was left as the server had it.',
        mergedFields: merged.fields,
        state: merged.state,
      };
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

  /**
   * Record that two writes disagreed, and what was done about it.
   *
   * A `SyncConflict` in `OPEN` state, holding enough for somebody who was not
   * there to decide what should have happened: the device's payload, the
   * server's state at the moment, and which side the engine took automatically.
   *
   * **The automatic resolution is not the end of it.** The engine has to pick
   * something at push time — the device is waiting and cannot be asked — but
   * every pick discards somebody's work, and until now the only trace of that
   * was a line in a response the device may never have received. This is the
   * queue that outlives the connection.
   *
   * Failure to write the record is reported through the absent `conflictId`
   * rather than thrown: the batch is half-applied by this point, and abandoning
   * it over a bookkeeping write would lose more than it protects.
   */
  #raise(
    auth: AuthContext,
    projectId: string,
    correlationId: string,
    syncSessionId: string,
    operation: SyncOperation,
    resolution: Resolution,
    serverState: Record<string, unknown> | undefined,
  ): string | undefined {
    const conflictId = ulid();
    try {
      this.#ledger.commit({
        tenantId: auth.tenantId,
        projectId,
        actor: { refType: 'User', refId: auth.actorId },
        source: operation.source,
        correlationId,
        causationId: syncSessionId,
        eventType: 'SYNC_CONFLICT_RAISED',
        entity: { refType: 'SyncConflict', refId: conflictId },
        nextState: {
          conflictId,
          projectId,
          syncSessionId,
          operationId: operation.operationId,
          deviceId: operation.deviceId,
          deviceTimestamp: operation.deviceTimestamp,
          raisedBy: auth.actorId,
          raisedAt: new Date().toISOString(),
          subject: operation.entity,
          eventType: operation.eventType,
          reason: resolution.reason,
          autoResolution: resolution.resolution,
          message: resolution.message,
          mergedFields: resolution.mergedFields ?? [],
          // Both sides, kept whole. Deciding after the fact means reading what
          // each party actually wrote, not a summary of the difference.
          deviceState: operation.nextState,
          serverState: serverState ?? null,
          baseStateHash: operation.baseStateHash ?? null,
          status: 'OPEN',
        },
        timestamp: new Date().toISOString(),
        deviceTimestamp: operation.deviceTimestamp,
      });
      return conflictId;
    } catch {
      return undefined;
    }
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
