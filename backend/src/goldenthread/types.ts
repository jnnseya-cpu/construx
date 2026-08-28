import type { PatchOp } from '../core/jsonpatch.ts';
import type { EventAction } from './eventTypes.ts';

export type EntityRef = { refType: string; refId: string };

export type ActorRef = { refType: 'User' | 'System' | 'AI'; refId: string };

/**
 * Where a record was made. Written into every event and never editable after.
 *
 * `PWA` is the installed browser application on a device — a phone on a site,
 * launched from the home screen, capturing work that may have happened with no
 * signal. It is separate from `WEB` because a record typed at a desk and a
 * record captured at a work face are different evidence, and separate from
 * `ANDROID`/`IOS` because those mean a native client, which is not built. A
 * browser claiming to be Android would put a false provenance into an
 * append-only ledger, where it cannot afterwards be corrected.
 */
export type EventSource = 'WEB' | 'PWA' | 'ANDROID' | 'IOS' | 'SYSTEM' | 'AI';

/**
 * The providers the platform will call.
 *
 * Additive only. Every AI spend event records the provider that served it, so a
 * value removed here would orphan history that already names it — the journal
 * is forward-compatible, not backward-compatible.
 */
export type AIProvider = 'OPENAI' | 'GEMINI' | 'ANTHROPIC';

export type AIEventBlock = {
  aiRequestId: string;
  aiExecutionId?: string;
  provider: AIProvider;
  modelClass?: string;
  acuHeld: number;
  acuConsumed: number;
  /** Inputs the model actually saw — required so an AI change is reproducible. */
  inputRefs?: EntityRef[];
  /**
   * How sure the model was, 0.00–1.00.
   *
   * Optional because a provider may not return one, and a missing confidence
   * must read as missing rather than as zero — zero is a claim that the model
   * had no confidence at all, which is a different and much stronger statement.
   * The value already reached the engine, which used it to decide what to
   * write; it was simply never recorded beside the change it justified.
   */
  confidence?: number;
  /**
   * Which prompt produced this, and which version of it.
   *
   * Derived rather than declared: `${taskType}@${hash}` over the canonical
   * task and response schema the engine actually sent. A hand-maintained
   * version string is one somebody forgets to bump on the change that
   * mattered; this one changes exactly when the prompt changes and cannot
   * disagree with what was sent.
   *
   * Optional on the type because events written before this field existed do
   * not carry it, and nothing may be backfilled onto a hash-chained event.
   * Every event written from now on has it.
   */
  promptVersion?: string;
  /**
   * What the model took as given.
   *
   * `[]` means the model declared none, which is a recorded answer. The field
   * being *absent* means the event predates the field. The stage gates
   * distinguish the two, because "it assumed nothing" and "nobody wrote down
   * what it assumed" are different facts.
   */
  assumptions?: string[];
  /**
   * What the model could not see, and knew it could not see.
   *
   * The other half of an assumption. An assumption is something taken as given
   * and probably true; a known gap is something the answer needed and did not
   * have — a drawing that was not in the inputs, a rate with no base date, a
   * ground investigation that stops above the founding level. The distinction
   * matters at a gate: a decision resting on assumptions is one somebody can
   * check, and a decision resting on gaps is one somebody has to close.
   *
   * `[]` means the model declared none. Absent means the event predates the
   * field, and the two are never conflated.
   */
  knownGaps?: string[];
  /**
   * What else the model considered and did not choose.
   *
   * Recorded because an option nobody wrote down is one nobody can reopen. In
   * a dispute three years later the question is rarely "was this reasonable"
   * but "what else was on the table", and an answer that lists one course of
   * action reads as though there was only ever one.
   *
   * Each entry states the alternative and why it was not taken. An entry that
   * names an alternative with no reason is worse than none, so the mock
   * declares both and a provider that returns bare strings has them recorded
   * as given rather than dressed up.
   */
  alternativesConsidered?: string[];
};

export type PolicyBlock = {
  policyId: string;
  decision: 'ALLOW' | 'DENY' | 'REDACT';
};

/**
 * The immutable wrapper for every Golden Thread event. No state change, AI
 * execution, approval or import may occur without one of these.
 */
export type GoldenThreadEvent = {
  eventId: string;
  tenantId: string;
  projectId: string;
  timestamp: string;
  actor: ActorRef;
  source: EventSource;
  eventType: string;
  entity: EntityRef;
  action: EventAction;
  beforeHash: string;
  afterHash: string;
  diff: PatchOp[];
  evidenceRefs?: EntityRef[];
  ai?: AIEventBlock;
  policy?: PolicyBlock;
  correlationId: string;
  causationId?: string;
  /**
   * Hash chain over the whole ledger for this project: sha256 of the previous
   * event's chainHash concatenated with this event's canonical body. Detects
   * deletion or reordering of events, which per-entity hashes alone cannot.
   */
  chainHash?: string;
  previousChainHash?: string;
  /** Device timestamp preserved verbatim when the record originated offline. */
  deviceTimestamp?: string;
  /**
   * The roles the actor held at the moment they acted.
   *
   * A snapshot, not a reference. Roles change: somebody promoted, moved team or
   * removed from a project still acted under the mandate they had at the time,
   * and an audit that resolves their *current* roles reports the wrong
   * authority for every historic act. Under an append-only record the snapshot
   * is the only version that can never become wrong.
   *
   * Absent on events written before this field existed. The journal is
   * forward-compatible, not backward-compatible, and nothing may be backfilled
   * onto an event that is already hash-chained.
   */
  roleAtAction?: string[];
  /**
   * The project's lifecycle state when the event fired.
   *
   * The phase already governs what may be written and which engines may run, so
   * a refusal or an approval only makes sense read against the phase it happened
   * in. Recording it removes the need to reconstruct the phase by replaying the
   * project up to that moment in order to understand a single line of audit.
   *
   * Absent where the event is not project-scoped — a tenancy being opened has no
   * lifecycle phase — and on events written before this field existed.
   */
  lifecyclePhase?: string;
  /**
   * Why. The human's stated reason, or the agent's rationale.
   *
   * Several commands already demand a reason — suspending a tenancy, changing a
   * role, moving a spend cap — and every one of them buried it in the entity's
   * state, where it is reachable only by knowing which field of which record to
   * look in. It belongs on the event, beside the change it explains, because a
   * record of a consequential act with no stated reason is useless the day
   * somebody asks why it happened.
   */
  reason?: string;
};

export type VerificationStatus =
  | 'VERIFIED'
  | 'FAILED_HASH'
  | 'FAILED_SCHEMA'
  | 'FAILED_PATCH'
  | 'FAILED_CHAIN'
  | 'FAILED_CATALOG'
  | 'MISSING_EVIDENCE';

export type EventVerification = {
  eventId: string;
  eventType: string;
  entity: EntityRef;
  status: VerificationStatus;
  detail?: string;
};
