import { applyPatch } from '../core/jsonpatch.ts';
import { DomainError } from '../core/errors.ts';
import type { GoldenThreadLedger } from './ledger.ts';
import type { EntityRef, GoldenThreadEvent } from './types.ts';

/**
 * Two time axes — `L7.4`.
 *
 * ---
 *
 * **The question a claim turns on.** *What did we know on the fourteenth about
 * the twelfth* is not the same question as *what was true on the twelfth*, and
 * neither is *what do we know now*. A record holding one axis can answer only
 * the last of the three, and answering the first two by reading today's state
 * reports the present understanding of the past as though it had been
 * understood at the time. That is exactly the mistake an adjudicator is looking
 * for.
 *
 * The ledger has always been able to answer *what was recorded by then*,
 * because it is append-only and every event is timestamped: replay the entity's
 * stream up to a moment and the state that comes out is the state as it stood.
 * What it could not do is separate that from **when the fact became true**.
 *
 * ## The two axes
 *
 * - **`recordedBy`** — the platform's own clock. When did we learn it.
 * - **`validAt`** — the world's clock. When was it true. Carried on the event as
 *   `validFrom`, and absent wherever the two coincide, which is most events.
 *
 * An absent `validFrom` is read as equal to the event's timestamp. That makes
 * every event written before this existed answer both questions correctly
 * rather than needing a backfill — and nothing may be backfilled onto an event
 * that is already hash-chained.
 *
 * ## What this is not
 *
 * It is not a second store. There is one ledger, and this replays it. A
 * materialised bitemporal table would be a copy of the truth that could
 * disagree with the chain, and the chain is the thing the platform's whole
 * argument rests on.
 *
 * It also does not let anybody rewrite history. `validFrom` is stated when the
 * event is written and is inside the hash from that moment; there is no path
 * here that edits it afterwards. A fact recorded wrongly is corrected by
 * recording the correction, which is what an append-only ledger is for.
 */

export type TemporalPoint = {
  /** Replay only what was recorded by this instant. Defaults to now. */
  recordedBy?: string;
  /** Replay only what was true by this instant. Defaults to `recordedBy`. */
  validAt?: string;
};

export type TemporalState = {
  refType: string;
  refId: string;
  /** The two instants the answer is given at. */
  recordedBy: string;
  validAt: string;
  /** The state as it stood, or `undefined` where the entity did not exist yet. */
  state?: Record<string, unknown>;
  /** How many of the entity's events were in scope. */
  applied: number;
  /** How many were excluded, and why. Said rather than left as a silent difference. */
  excluded: { notYetRecorded: number; notYetTrue: number };
  /** The last event that contributed, so the answer can be traced to a line of audit. */
  throughEventId?: string;
};

/** When the event says the fact became true. Absent means it was true when recorded. */
export function validFromOf(event: GoldenThreadEvent): string {
  return event.validFrom ?? event.timestamp;
}

/**
 * The state of one entity on both axes.
 *
 * Replays the entity's own stream rather than the project's, because an entity's
 * state is a function of its own events and nothing else — the same property
 * that lets the ledger rebuild from a journal.
 */
export function stateAsOf(
  ledger: GoldenThreadLedger,
  ref: EntityRef,
  point: TemporalPoint = {},
): TemporalState {
  const recordedBy = point.recordedBy ?? new Date().toISOString();
  // Defaults to the same instant: asking "what did we know on the fourteenth"
  // without saying about when means about the fourteenth.
  const validAt = point.validAt ?? recordedBy;

  if (point.validAt && point.recordedBy && point.validAt > point.recordedBy) {
    // Not an error in arithmetic — a question about the future. The platform
    // cannot say what will be true, and answering with today's state would be
    // the confident wrong answer.
    throw new DomainError(
      'VALID_AFTER_RECORDED',
      `Asking what was true at ${point.validAt} using only what was known by ${point.recordedBy} is asking about the ` +
        'future. Nothing recorded by then could describe it.',
    );
  }

  const events = ledger.eventsForEntity(ref);
  let state: Record<string, unknown> | undefined;
  let applied = 0;
  let notYetRecorded = 0;
  let notYetTrue = 0;
  let throughEventId: string | undefined;

  for (const event of events) {
    if (event.timestamp > recordedBy) {
      notYetRecorded += 1;
      continue;
    }
    if (validFromOf(event) > validAt) {
      notYetTrue += 1;
      continue;
    }
    state = applyPatch<Record<string, unknown>>((state ?? {}) as Record<string, unknown>, event.diff);
    applied += 1;
    throughEventId = event.eventId;
  }

  return {
    refType: ref.refType,
    refId: ref.refId,
    recordedBy,
    validAt,
    ...(state === undefined ? {} : { state }),
    applied,
    excluded: { notYetRecorded, notYetTrue },
    ...(throughEventId === undefined ? {} : { throughEventId }),
  };
}

export type TemporalStep = {
  eventId: string;
  eventType: string;
  /** When the platform learned it. */
  recordedAt: string;
  /** When it became true. Equal to `recordedAt` unless the event says otherwise. */
  validFrom: string;
  /** Whether the two differ, which is the row a reader is looking for. */
  backdated: boolean;
  /** How far apart, in days. Zero where they coincide. */
  backdatedDays: number;
  actor: string;
  reason?: string;
};

export type TemporalHistory = {
  refType: string;
  refId: string;
  steps: TemporalStep[];
  /** Events whose two axes differ. The ones a claim is argued over. */
  backdated: number;
  summary: string;
};

/**
 * Both axes of an entity's whole life, side by side.
 *
 * Built so *which of these did we learn late* is one read. An event recorded
 * three weeks after it became true is not wrong and is not suspicious; it is
 * the thing somebody has to be able to see before they rely on a date.
 */
export function temporalHistory(ledger: GoldenThreadLedger, ref: EntityRef): TemporalHistory {
  const steps: TemporalStep[] = ledger.eventsForEntity(ref).map((event) => {
    const validFrom = validFromOf(event);
    const days = Math.round((Date.parse(event.timestamp) - Date.parse(validFrom)) / 86_400_000);
    return {
      eventId: event.eventId,
      eventType: event.eventType,
      recordedAt: event.timestamp,
      validFrom,
      backdated: validFrom !== event.timestamp,
      backdatedDays: Math.max(0, days),
      actor: `${event.actor.refType}:${event.actor.refId}`,
      ...(event.reason === undefined ? {} : { reason: event.reason }),
    };
  });

  const backdated = steps.filter((step) => step.backdated).length;

  return {
    refType: ref.refType,
    refId: ref.refId,
    steps,
    backdated,
    summary:
      steps.length === 0
        ? `No event has been written against ${ref.refType} ${ref.refId}.`
        : `${steps.length} event(s)` +
          (backdated > 0
            ? `, ${backdated} of which record something that was already true when the platform learned it.`
            : ', every one recorded as it happened.'),
  };
}
