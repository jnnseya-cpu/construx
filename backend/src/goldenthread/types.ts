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
