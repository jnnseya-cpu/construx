import { DomainError } from '../core/errors.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import type { EntityRef } from '../goldenthread/types.ts';

/**
 * The conflicts the sync engine had to resolve on its own, and what a person
 * decided about them afterwards.
 *
 * Every offline conflict has a losing side. The engine has to pick one at push
 * time — the device is waiting on a bad connection and cannot be asked — and
 * `field/sync.ts` picks deterministically: safety stops hold, progress does not
 * go backwards, disjoint fields merge, then role priority, then the device.
 * Those are good rules and they are still not a decision.
 *
 * **What was missing was the queue.** A conflict resolved at push time and
 * reported in the response is invisible the moment the device drops the
 * response — and the device is, by construction, the one with the bad
 * connection. A supervisor's pour record refused for progress regression simply
 * vanished: the work was done, the record was made, and nothing in the platform
 * said it had been discarded.
 *
 * So `SYNC_CONFLICT_RAISED` records it with both sides kept whole, and this
 * module is where somebody with authority reads it and says what should have
 * happened.
 *
 * ---
 *
 * **Two decisions, and the second one writes.** `KEPT_SERVER` confirms the
 * engine's pick: the device's version is discarded on purpose, by a named
 * person, with a reason. `APPLIED_DEVICE` overturns it and commits the device's
 * payload now, online, as the person deciding — because a resolution that only
 * annotated the conflict would leave the site record wrong and the paperwork
 * tidy, which is the wrong way round.
 *
 * **A resolution is not a second sync.** The device's payload is replayed
 * through the ordinary ledger commit, under the resolver's own identity and
 * authority, not the device's. Somebody overturning a refusal takes
 * responsibility for the write; they do not launder it back through the
 * supervisor who was refused.
 *
 * What is deliberately absent: no automatic re-resolution, no bulk accept.
 * Every one is read and decided individually, because the queue is small by
 * design and a bulk button on a list of discarded site records is how they get
 * discarded twice.
 */

export const CONFLICT_DECISION = ['KEPT_SERVER', 'APPLIED_DEVICE'] as const;
export type ConflictDecision = (typeof CONFLICT_DECISION)[number];

export type SyncConflictState = {
  conflictId: string;
  projectId: string;
  syncSessionId: string;
  operationId: string;
  deviceId: string;
  deviceTimestamp: string;
  raisedBy: string;
  raisedAt: string;
  /** The record the two writes disagreed about. */
  subject: EntityRef;
  eventType: string;
  reason: string;
  /** What the engine did at push time, with nobody to ask. */
  autoResolution: 'SERVER_WINS' | 'DEVICE_WINS' | 'MERGED' | 'REJECTED';
  message: string;
  mergedFields: readonly string[];
  deviceState: Record<string, unknown>;
  serverState: Record<string, unknown> | null;
  baseStateHash: string | null;
  status: 'OPEN' | 'RESOLVED';
  decision?: ConflictDecision;
  decidedBy?: string;
  decidedAt?: string;
  decisionReason?: string;
  /** Set where APPLIED_DEVICE re-committed the device's payload. */
  appliedEventId?: string;
};

function conflictsOf(ctx: EngineContext): SyncConflictState[] {
  return ctx.ledger
    .list(ctx.projectId, 'SyncConflict')
    .map((record) => record.state as unknown as SyncConflictState)
    .sort((a, b) => (a.raisedAt < b.raisedAt ? 1 : -1));
}

function requireConflict(ctx: EngineContext, conflictId: string): SyncConflictState {
  const found = conflictsOf(ctx).find((entry) => entry.conflictId === conflictId);
  if (!found) throw new DomainError('NO_SUCH_CONFLICT', `No sync conflict ${conflictId} on this project`, 404);
  return found;
}

/** Every conflict on the project, newest first. Read by anyone who may read the field. */
export function syncConflicts(ctx: EngineContext): SyncConflictState[] {
  authorise(ctx, 'FIELD_EXECUTION', 'R');
  return conflictsOf(ctx);
}

export type ConflictPosition = {
  open: number;
  resolved: number;
  /** Open conflicts where the device's work was discarded outright. */
  workLost: number;
  /** Open conflicts the engine merged, which need confirming rather than deciding. */
  merged: number;
  byReason: Record<string, number>;
  oldestOpenAt?: string;
  conflicts: SyncConflictState[];
};

/**
 * What is outstanding, and how much of it is somebody's discarded work.
 *
 * `workLost` is the number worth acting on: a `SERVER_WINS` or a `REJECTED`
 * means a record was made on site and is not in the platform. A `MERGED` or a
 * `DEVICE_WINS` committed something, and the open item is a confirmation rather
 * than a rescue.
 */
export function conflictPosition(ctx: EngineContext): ConflictPosition {
  authorise(ctx, 'FIELD_EXECUTION', 'R');

  const all = conflictsOf(ctx);
  const open = all.filter((entry) => entry.status === 'OPEN');
  const byReason: Record<string, number> = {};
  for (const entry of open) byReason[entry.reason] = (byReason[entry.reason] ?? 0) + 1;

  return {
    open: open.length,
    resolved: all.length - open.length,
    workLost: open.filter((entry) => entry.autoResolution === 'SERVER_WINS' || entry.autoResolution === 'REJECTED')
      .length,
    merged: open.filter((entry) => entry.autoResolution === 'MERGED').length,
    byReason,
    oldestOpenAt: open.map((entry) => entry.raisedAt).sort().at(0),
    conflicts: all,
  };
}

/**
 * Decide what should have happened.
 *
 * `APPLIED_DEVICE` re-commits the device's payload as the person deciding.
 * That is the whole point of the queue — a conflict resolved on paper and not
 * in the record is a conflict that has been filed rather than fixed.
 */
export function resolveSyncConflict(
  ctx: EngineContext,
  input: { conflictId: string; decision: ConflictDecision; reason: string },
): { conflictId: string; decision: ConflictDecision; appliedEventId?: string } {
  // `A` rather than `U`. Overturning the engine and writing the device's
  // version over the current record is an approval, not an edit, and the site
  // supervisor whose record was refused must not be the one who reinstates it.
  authorise(ctx, 'FIELD_EXECUTION', 'A');

  const conflict = requireConflict(ctx, input.conflictId);

  if (conflict.status === 'RESOLVED') {
    throw new DomainError(
      'ALREADY_RESOLVED',
      `${conflict.conflictId} was resolved ${conflict.decision} by ${conflict.decidedBy} on ` +
        `${String(conflict.decidedAt).slice(0, 10)}. Re-deciding would overwrite somebody's decision about ` +
        'somebody else’s work.',
      409,
    );
  }

  if (!CONFLICT_DECISION.includes(input.decision)) {
    throw new DomainError('INVALID_DECISION', `${input.decision} is not a conflict decision`, 422);
  }

  if (input.reason.trim() === '') {
    throw new DomainError(
      'REASON_REQUIRED',
      'A conflict resolution discards one of two records somebody made. Say which and why — it is the only ' +
        'account of why the other one is not there.',
      422,
    );
  }

  // A model may not decide whose site record survives. The catalogue says the
  // same on `SYNC_CONFLICT_RESOLVED`; this is the refusal at the command.
  if (ctx.source === 'AI') {
    throw new DomainError(
      'AI_CANNOT_RESOLVE',
      'Choosing between two people’s records of what happened on site is a human decision.',
      403,
    );
  }

  let appliedEventId: string | undefined;

  if (input.decision === 'APPLIED_DEVICE') {
    // Committed under the resolver's identity, not the device's. Overturning a
    // refusal means taking responsibility for the write.
    const { event } = ctx.ledger.commit({
      tenantId: ctx.auth.tenantId,
      projectId: ctx.projectId,
      actor: { refType: 'User', refId: ctx.auth.actorId },
      source: ctx.source,
      correlationId: ctx.correlationId,
      causationId: conflict.conflictId,
      eventType: conflict.eventType,
      entity: conflict.subject,
      nextState: conflict.deviceState,
      // The time the work happened is still the time on site. A reinstated
      // record that claims to have been made at the desk it was reinstated
      // from is the provenance this platform exists to keep.
      timestamp: new Date().toISOString(),
      deviceTimestamp: conflict.deviceTimestamp,
    });
    appliedEventId = event.eventId;
  }

  write(ctx, {
    eventType: 'SYNC_CONFLICT_RESOLVED',
    entity: { refType: 'SyncConflict', refId: conflict.conflictId },
    nextState: {
      ...conflict,
      status: 'RESOLVED',
      decision: input.decision,
      decidedBy: ctx.auth.actorId,
      decidedAt: new Date().toISOString(),
      decisionReason: input.reason,
      appliedEventId,
    } as unknown as Record<string, unknown>,
  });

  return { conflictId: conflict.conflictId, decision: input.decision, appliedEventId };
}
