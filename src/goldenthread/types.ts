import type { PatchOp } from '../core/jsonpatch.ts';
import type { EventAction } from './eventTypes.ts';

export type EntityRef = { refType: string; refId: string };

export type ActorRef = { refType: 'User' | 'System' | 'AI'; refId: string };

export type EventSource = 'WEB' | 'ANDROID' | 'IOS' | 'SYSTEM' | 'AI';

export type AIProvider = 'OPENAI' | 'GEMINI';

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
