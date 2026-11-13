/**
 * The CONSTRUX AI Gateway — canonical, provider-neutral contract.
 *
 * Spec v1.0 §2 (P02 provider abstraction), §5 (task taxonomy), §6 (request
 * lifecycle and states), §11 (approval), §15 (schemas), Appendix A (errors).
 *
 * This file is the application boundary the whole gateway is built to protect:
 * **business services depend on these canonical types, never on a vendor SDK**,
 * and **a user-facing response never carries a provider identity, a model id or
 * a raw provider cost** (P03 hidden providers). Those live only on the admin
 * route record, which this file keeps strictly separate.
 *
 * Pure types and small pure helpers only — no provider, no I/O, no ledger. The
 * router, policy, adapters and service build on this.
 */
import type { AIProvider } from '../../goldenthread/types.ts';

/**
 * The providers the gateway's routing *policy* may name — the runtime trio plus
 * `VERTEX`, which the spec makes the enterprise control plane. Vertex is named in
 * policy (so the fallback matrix is complete and explainable) but is not wired to
 * a runtime adapter yet (`AIProvider` is the runtime set); `providerIsWired`
 * draws that line, and the router skips an unwired provider rather than failing.
 */
export type GatewayProvider = AIProvider | 'VERTEX';

/** The runtime providers that actually have an adapter today. Vertex is deferred. */
export const WIRED_PROVIDERS: readonly GatewayProvider[] = ['OPENAI', 'ANTHROPIC', 'GEMINI'];
export function providerIsWired(p: GatewayProvider): p is AIProvider {
  return (WIRED_PROVIDERS as readonly string[]).includes(p);
}

/** The closed task taxonomy (spec §5). A task profile is the unit of routing policy. */
export const TASK_PROFILES = [
  'vision.drawing_extract',
  'vision.site_evidence',
  'document.itt_ingest',
  'contract.obligation_analysis',
  'claims.entitlement_analysis',
  'tender.compliance_matrix',
  'planning.logic_review',
  'commercial.cvr_analysis',
  'risk.change_analysis',
  'procurement.vendor_analysis',
  'workflow.agent_execution',
  'document.generate',
  'executive.synthesis',
  'external.watchtower',
  'operations.maintenance',
] as const;
export type TaskProfile = (typeof TASK_PROFILES)[number];
export function isTaskProfile(v: string): v is TaskProfile {
  return (TASK_PROFILES as readonly string[]).includes(v);
}

/** What the work reads/produces, for routing (spec §4, §5). */
export type Modality = 'VISION' | 'DOCUMENT' | 'STRUCTURED' | 'MIXED';
/** Risk tier drives whether a human approval gate is mandatory (spec §6, §11). */
export type RiskTier = 'INFORMATIONAL' | 'MATERIAL' | 'CONSEQUENTIAL';
/** The band a reader sees — never a raw provider score (spec §12, §15.3). */
export type ConfidenceBand = 'LOW' | 'MEDIUM' | 'HIGH';

/** The canonical validators a task's output must pass (spec §5 "required validation"). */
export type ValidationKind =
  | 'SCHEMA'
  | 'SOURCE_ANCHORS'
  | 'CONFIDENCE_FLOOR'
  | 'CLAUSE_CITATIONS'
  | 'EVIDENCE_COVERAGE'
  | 'COMPLETENESS'
  | 'DETERMINISTIC_CALC_MATCH'
  | 'OBSERVATION_ONLY_LANGUAGE'
  | 'LEGAL_DISCLAIMER'
  | 'TOOL_POSTCONDITION';

/**
 * A canonical AI request (spec §15.2). A business module fills this; it names no
 * provider and chooses no model — the gateway does that from the task profile.
 */
export type AITaskRequest = {
  taskProfile: TaskProfile;
  tenantId: string;
  projectId: string;
  /** Golden-Thread entity refs the task may read — resolved and redacted by the context builder. */
  inputRefs: string[];
  instruction: string;
  /** The canonical output schema id the result must validate against, where one applies. */
  outputSchema?: string;
  /** Which approval policy governs a consequential output (spec §11); absent → classified from risk tier. */
  approvalPolicy?: string;
  /** Who funds the ACUs (spec §14) — e.g. 'enterprise'. */
  acuSponsor?: string;
  /** Idempotency key (spec §15.2 header) — the same key returns the same request. */
  idempotencyKey: string;
};

/** The request state machine (spec §6.1). */
export const REQUEST_STATES = [
  'RECEIVED',
  'POLICY_CHECKED',
  'ROUTED',
  'QUEUED',
  'RUNNING',
  'RETRYING',
  'VALIDATING',
  'AWAITING_APPROVAL',
  'COMPLETED',
  'REVISION_REQUIRED',
  'REJECTED',
  'FAILED',
] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

/** Permitted transitions (spec §6.1). A move not listed here is a programming error. */
const TRANSITIONS: Record<RequestState, readonly RequestState[]> = {
  RECEIVED: ['POLICY_CHECKED', 'REJECTED'],
  POLICY_CHECKED: ['ROUTED', 'REJECTED'],
  ROUTED: ['RUNNING', 'QUEUED'],
  QUEUED: ['RUNNING', 'FAILED'],
  RUNNING: ['VALIDATING', 'RETRYING', 'FAILED'],
  RETRYING: ['RUNNING', 'FAILED'],
  VALIDATING: ['AWAITING_APPROVAL', 'COMPLETED', 'FAILED'],
  AWAITING_APPROVAL: ['COMPLETED', 'REJECTED', 'REVISION_REQUIRED'],
  REVISION_REQUIRED: ['RUNNING', 'REJECTED'],
  COMPLETED: [],
  REJECTED: [],
  FAILED: ['QUEUED'], // a retryable failure may be re-queued; otherwise terminal
};
export function canTransition(from: RequestState, to: RequestState): boolean {
  return TRANSITIONS[from].includes(to);
}
export function isTerminal(s: RequestState): boolean {
  return TRANSITIONS[s].length === 0 || s === 'COMPLETED' || s === 'REJECTED';
}

/** One evidence reference a material finding is anchored to (spec §12.1). Never raw source text. */
export type EvidenceRef = { sourceId: string; locator?: string; confidence?: ConfidenceBand };

/**
 * The **user-safe** result (spec §15.3). This is all a person or a business
 * module ever sees. It carries findings, evidence, limitations and a confidence
 * *band* — and deliberately **no provider, model, raw cost or routing**.
 */
export type UserSafeResult = {
  summary: string;
  findings: unknown[];
  evidence: EvidenceRef[];
  limitations: string[];
  confidenceBand: ConfidenceBand;
};

export type UserSafeResponse = {
  requestId: string;
  status: RequestState;
  taskProfile: TaskProfile;
  result?: UserSafeResult;
  approval: { required: boolean; roles: string[] };
  acu: { reserved: number; settled: number };
};

/**
 * The **administrative** route record (spec §15.4) — the half that names the
 * provider, the model, the attempts and the cost. Kept in its own type so it is
 * impossible to hand an admin record where a user-safe response is expected.
 */
export type AdminRouteRecord = {
  requestId: string;
  policyVersion: string;
  selectedProvider: GatewayProvider | null;
  selectedModel: string | null;
  attempts: Array<{ attempt: number; provider: GatewayProvider; outcome: 'SUCCESS' | 'FAILURE' | 'SKIPPED'; detail?: string }>;
  scoreComponents: Record<string, number>;
  providerUsage: Record<string, number>;
  providerCostMinor: number;
  validation: Partial<Record<ValidationKind, 'PASS' | 'FAIL'>>;
};

/** Canonical gateway errors (spec Appendix A). HTTP status travels with the code. */
export const GATEWAY_ERRORS = {
  AI_POLICY_DENIED: { http: 403, meaning: 'Identity, data or task policy prohibits the request' },
  AI_APPROVAL_REQUIRED: { http: 202, meaning: 'A consequential output awaits human approval' },
  AI_APPROVAL_STALE: { http: 409, meaning: 'The output or context changed after approval was given' },
  AI_NO_ELIGIBLE_ROUTE: { http: 503, meaning: 'No cleared, healthy provider is eligible for this task' },
  AI_QUALITY_FLOOR_UNMET: { http: 422, meaning: 'No route met the evidence or confidence floor; referred to a human' },
  AI_SCHEMA_INVALID: { http: 422, meaning: 'The output failed canonical schema validation' },
  AI_PROHIBITED_ACTION: { http: 403, meaning: 'The task requested an action no model may take (approve/certify/pay/sign)' },
  AI_PROVIDER_NOT_WIRED: { http: 503, meaning: 'The only eligible provider is not yet wired on this deployment' },
  AI_WALLET_EMPTY: { http: 402, meaning: 'No ACU funding; no provider is contacted' },
  AI_IDEMPOTENT_REPLAY: { http: 200, meaning: 'A completed request already exists for this idempotency key' },
} as const;
export type GatewayErrorCode = keyof typeof GATEWAY_ERRORS;
