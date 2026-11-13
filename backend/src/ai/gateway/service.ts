/**
 * The CONSTRUX AI Gateway — the request lifecycle service (spec §6).
 *
 * This is the one place a canonical AI task is driven through its whole life:
 * received → policy-checked → routed → run (with task-specific fallback) →
 * validated → either awaiting human approval or completed — and every transition
 * emits a `construx.ai.*` event (spec §16). It composes the pure pieces built in
 * Increment 1–2 (contract, taxonomy, router, policy) and executes through an
 * **injected seam** (`GatewayExecutor`), so the orchestrator wiring, the ACU
 * ledger and the Golden Thread are plugged in by the endpoint (Increment 3b)
 * while this logic stays pure and fully testable.
 *
 * Invariants enforced here:
 *   - A prohibited action is refused before any provider runs (P05, §11, AT-06).
 *   - No eligible route ⇒ fail closed, never fabricate (P07, AT-05).
 *   - Fallback is walked in policy order and every attempt is recorded (P08, AT-04).
 *   - A consequential output is held AWAITING_APPROVAL, not committed (P05, AT-07).
 *   - The user-safe response never carries a provider, model or raw cost (P03).
 */
import {
  isTaskProfile,
  type AITaskRequest,
  type AdminRouteRecord,
  type GatewayProvider,
  type RequestState,
  type UserSafeResponse,
  type UserSafeResult,
  type ValidationKind,
} from './contract.ts';
import { ROUTE_POLICY, PROVIDER_ROLE } from './taxonomy.ts';
import { selectRoute, routeIsEligible, type ProviderAvailability } from './router.ts';
import { approvalRequirement, screenInstruction } from './policy.ts';

/** What one provider execution returns (the adapter normalises a vendor reply to this). */
export type ExecutorResult = {
  provider: GatewayProvider;
  model: string;
  result: UserSafeResult;
  usage: Record<string, number>;
  costMinor: number;
  /** The validators this output passed (the executor/validator sets these; spec §12). */
  validation: Partial<Record<ValidationKind, 'PASS' | 'FAIL'>>;
};

/**
 * Execute the task against one provider. Throws to signal a failed attempt (the
 * service then walks to the next provider in the plan). The production executor
 * wraps the orchestrator + ACU + Golden Thread; a test executor is deterministic.
 */
export type GatewayExecutor = (input: { provider: GatewayProvider; request: AITaskRequest }) => Promise<ExecutorResult>;

/** Emits a canonical `construx.ai.*` event (spec §16). Injected; may be a no-op. */
export type GatewayEventSink = (event: { type: string; requestId: string; payload: Record<string, unknown> }) => void;

export type GatewayOutcome = { user: UserSafeResponse; admin: AdminRouteRecord };

function result(
  requestId: string,
  request: AITaskRequest,
  status: RequestState,
  admin: AdminRouteRecord,
  opts: { result?: UserSafeResult; reservedAcu?: number; settledAcu?: number } = {},
): GatewayOutcome {
  const approval = approvalRequirement(request.taskProfile, request.approvalPolicy);
  const user: UserSafeResponse = {
    requestId,
    status,
    taskProfile: request.taskProfile,
    ...(opts.result ? { result: opts.result } : {}),
    approval: {
      required: approval.required && status === 'AWAITING_APPROVAL',
      roles: approval.authority ? [`${approval.authority.area}:${approval.authority.code}`] : [],
    },
    acu: { reserved: opts.reservedAcu ?? 0, settled: opts.settledAcu ?? 0 },
  };
  return { user, admin };
}

/**
 * Drive a canonical AI task through its lifecycle. Pure: all I/O (execution, ACU,
 * events) is injected. Never throws for an expected refusal — it returns a
 * user-safe response in the right terminal state with the reason on the admin
 * record — so a caller always gets a controlled answer.
 */
export async function runGatewayTask(input: {
  request: AITaskRequest;
  availability: ProviderAvailability;
  execute: GatewayExecutor;
  emit?: GatewayEventSink;
  /** Reserve the ACU envelope; return false on an empty wallet (spec §14, P07). */
  reserveAcu?: () => { ok: boolean; reserved: number };
  requestId: string;
}): Promise<GatewayOutcome> {
  const { request, availability, execute, requestId } = input;
  const emit: GatewayEventSink = input.emit ?? (() => {});
  const admin: AdminRouteRecord = {
    requestId,
    policyVersion: '',
    selectedProvider: null,
    selectedModel: null,
    attempts: [],
    scoreComponents: {},
    providerUsage: {},
    providerCostMinor: 0,
    validation: {},
  };

  emit({ type: 'construx.ai.request.received', requestId, payload: { taskProfile: request.taskProfile } });

  // --- validate the canonical request ---------------------------------------
  if (!isTaskProfile(request.taskProfile) || request.instruction.trim().length === 0) {
    emit({ type: 'construx.ai.request.failed', requestId, payload: { reason: 'AI_SCHEMA_INVALID' } });
    return result(requestId, request, 'REJECTED', admin);
  }

  // --- prohibited action screen (before any provider runs, AT-06) -----------
  if (screenInstruction(request.instruction) !== null) {
    admin.validation = {};
    emit({ type: 'construx.ai.policy.evaluated', requestId, payload: { decision: 'AI_PROHIBITED_ACTION' } });
    return result(requestId, request, 'REJECTED', admin);
  }
  emit({ type: 'construx.ai.policy.evaluated', requestId, payload: { decision: 'ALLOW', riskTier: ROUTE_POLICY[request.taskProfile].riskTier } });

  // --- route (fail closed on no eligible provider) --------------------------
  const route = selectRoute(request.taskProfile, availability);
  admin.policyVersion = route.policyVersion;
  emit({ type: 'construx.ai.route.selected', requestId, payload: { policyVersion: route.policyVersion, planLength: route.plan.length, skipped: route.skipped } });
  if (!routeIsEligible(route)) {
    emit({ type: 'construx.ai.request.failed', requestId, payload: { reason: 'AI_NO_ELIGIBLE_ROUTE' } });
    return result(requestId, request, 'FAILED', admin);
  }
  // Record the providers skipped ahead of the first eligible one.
  for (const s of route.skipped) admin.attempts.push({ attempt: 0, provider: s.provider, outcome: 'SKIPPED', detail: s.reason });

  // --- fund (empty wallet ⇒ no provider is contacted, spec §14) -------------
  const reservation = input.reserveAcu ? input.reserveAcu() : { ok: true, reserved: 0 };
  if (!reservation.ok) {
    emit({ type: 'construx.ai.request.failed', requestId, payload: { reason: 'AI_WALLET_EMPTY' } });
    return result(requestId, request, 'FAILED', admin);
  }

  // --- run, walking the fallback chain in policy order (AT-04) --------------
  let executed: ExecutorResult | null = null;
  let attemptNo = admin.attempts.filter((a) => a.outcome !== 'SKIPPED').length;
  for (const provider of route.plan) {
    attemptNo += 1;
    try {
      const out = await execute({ provider, request });
      admin.attempts.push({ attempt: attemptNo, provider, outcome: 'SUCCESS' });
      emit({ type: 'construx.ai.provider.attempted', requestId, payload: { attempt: attemptNo, outcome: 'SUCCESS' } });
      executed = out;
      break;
    } catch (error) {
      admin.attempts.push({ attempt: attemptNo, provider, outcome: 'FAILURE', detail: String((error as Error).message ?? error) });
      emit({ type: 'construx.ai.provider.attempted', requestId, payload: { attempt: attemptNo, outcome: 'FAILURE' } });
    }
  }
  if (!executed) {
    emit({ type: 'construx.ai.request.failed', requestId, payload: { reason: 'AI_NO_ELIGIBLE_ROUTE' } });
    return result(requestId, request, 'FAILED', admin, { reservedAcu: reservation.reserved });
  }

  // --- record what ran (admin only — never leaks to the user) ---------------
  admin.selectedProvider = executed.provider;
  admin.selectedModel = executed.model;
  admin.providerUsage = executed.usage;
  admin.providerCostMinor = executed.costMinor;
  admin.validation = executed.validation;
  admin.scoreComponents = { role: 0, primaryRole: PROVIDER_ROLE[executed.provider] ? 1 : 0 };

  // --- validate (a FAIL on any required validator ⇒ quality floor unmet) ----
  const required = ROUTE_POLICY[request.taskProfile].validations;
  const failed = required.filter((v) => executed!.validation[v] === 'FAIL');
  emit({ type: 'construx.ai.output.validated', requestId, payload: { required, failed } });
  if (failed.length > 0) {
    emit({ type: 'construx.ai.request.failed', requestId, payload: { reason: 'AI_QUALITY_FLOOR_UNMET', failed } });
    return result(requestId, request, 'FAILED', admin, { reservedAcu: reservation.reserved });
  }

  // --- approval gate (consequential output is a proposal, AT-07) ------------
  const approval = approvalRequirement(request.taskProfile, request.approvalPolicy);
  if (approval.required) {
    emit({ type: 'construx.ai.approval.requested', requestId, payload: { authority: approval.authority, roleLabel: approval.roleLabel } });
    return result(requestId, request, 'AWAITING_APPROVAL', admin, { result: executed.result, reservedAcu: reservation.reserved });
  }

  // --- settle + complete ----------------------------------------------------
  const settled = Object.values(executed.usage).reduce((s, n) => s + (Number.isFinite(n) ? n : 0), 0);
  emit({ type: 'construx.ai.usage.settled', requestId, payload: { settled } });
  emit({ type: 'construx.ai.request.completed', requestId, payload: { confidenceBand: executed.result.confidenceBand } });
  return result(requestId, request, 'COMPLETED', admin, { result: executed.result, reservedAcu: reservation.reserved, settledAcu: reservation.reserved });
}
