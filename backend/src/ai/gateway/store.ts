/**
 * The CONSTRUX AI Gateway — persisted request + approval state (spec Inc.5, §6, §11).
 *
 * A gateway task's outcome is written to the Golden Thread as an `AIGatewayRequest`
 * so it can be read back by its id and, where the output is consequential, held
 * until a named person approves it. The stored state carries **only the user-safe
 * half** — the summary, the confidence band, the evidence, the approval state and
 * the ACU figures. The provider, the model and the raw cost stay on the operator's
 * route record and never on this customer-scoped entity (spec P03), so a customer
 * reading their own ledger cannot learn which vendor answered.
 *
 * Approval and rejection are **decisions**: the ledger refuses an AI author on the
 * `AI_GATEWAY_APPROVED` / `AI_GATEWAY_REJECTED` events, which is what stops the
 * gateway approving its own proposal. The person approving must hold the authority
 * the task's risk tier demands (spec §11) — the same `{area, code}` the policy
 * named when the request was raised.
 */
import type { CapabilityArea, PermissionCode } from '../../identity/roles.ts';
import { authorise, write, type EngineContext } from '../../engines/context.ts';
import { DomainError } from '../../core/errors.ts';
import type { RequestState, TaskProfile, UserSafeResponse, UserSafeResult } from './contract.ts';

/** What the ledger holds for one gateway request — the user-safe view, never the provider. */
export type StoredGatewayRequest = {
  id: string;
  projectId: string;
  taskProfile: TaskProfile;
  status: RequestState;
  result?: UserSafeResult;
  approval: { required: boolean; roles: string[]; authority?: { area: CapabilityArea; code: PermissionCode } };
  acu: { reserved: number; settled: number };
  requestedBy: string;
  requestedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  rejectedReason?: string;
};

/** The user-safe response shape, rebuilt from stored state (no provider, model or cost). */
function toResponse(state: StoredGatewayRequest): UserSafeResponse {
  return {
    requestId: state.id,
    status: state.status,
    taskProfile: state.taskProfile,
    ...(state.result ? { result: state.result } : {}),
    approval: { required: state.approval.required, roles: state.approval.roles },
    acu: state.acu,
  };
}

function find(ctx: EngineContext, requestId: string): StoredGatewayRequest | undefined {
  const record = ctx.ledger.get({ refType: 'AIGatewayRequest', refId: requestId });
  if (!record || record.tenantId !== ctx.tenantId) return undefined;
  const state = record.state as unknown as StoredGatewayRequest;
  // A request belongs to the project it was raised in. `ledger.get` resolves by
  // ref across the whole ledger, so without this a request would be readable
  // from any sibling project in the same tenant — the request is scoped to its
  // own project, and read back only there.
  if (state.projectId !== ctx.projectId) return undefined;
  return state;
}

/** The persisted request as a user-safe response, or undefined if this tenant has none by that id. */
export function readGatewayRequest(ctx: EngineContext, requestId: string): UserSafeResponse | undefined {
  const state = find(ctx, requestId);
  return state ? toResponse(state) : undefined;
}

/**
 * Every persisted gateway request for this project, newest first, as user-safe
 * responses. The ones still `AWAITING_APPROVAL` are what a reviewer acts on; the
 * decided ones are the record of what was released or refused.
 */
export function listGatewayRequests(ctx: EngineContext): { requests: UserSafeResponse[]; awaiting: number } {
  const states = ctx.ledger
    .list(ctx.projectId, 'AIGatewayRequest')
    .map((record) => record.state as unknown as StoredGatewayRequest)
    .filter((state) => state.projectId === ctx.projectId)
    .sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : a.requestedAt > b.requestedAt ? -1 : 0));
  return {
    requests: states.map(toResponse),
    awaiting: states.filter((state) => state.status === 'AWAITING_APPROVAL').length,
  };
}

/**
 * Persist a completed run. Idempotent on the request id (the idempotency key):
 * if one is already stored, it is returned unchanged and nothing re-runs — the
 * same key gives the same request (spec §15.2).
 */
export function persistGatewayRequest(
  ctx: EngineContext,
  input: {
    response: UserSafeResponse;
    authority?: { area: CapabilityArea; code: PermissionCode };
  },
): { response: UserSafeResponse; reused: boolean } {
  const existing = find(ctx, input.response.requestId);
  if (existing) return { response: toResponse(existing), reused: true };

  const state: StoredGatewayRequest = {
    id: input.response.requestId,
    projectId: ctx.projectId,
    taskProfile: input.response.taskProfile,
    status: input.response.status,
    ...(input.response.result ? { result: input.response.result } : {}),
    approval: {
      required: input.response.approval.required,
      roles: input.response.approval.roles,
      ...(input.authority ? { authority: input.authority } : {}),
    },
    acu: input.response.acu,
    requestedBy: ctx.auth.actorId,
    requestedAt: new Date().toISOString(),
  };

  write(ctx, {
    eventType: 'AI_GATEWAY_REQUESTED',
    entity: { refType: 'AIGatewayRequest', refId: state.id },
    nextState: state as unknown as Record<string, unknown>,
  });

  return { response: toResponse(state), reused: false };
}

function requireAwaiting(ctx: EngineContext, requestId: string): StoredGatewayRequest {
  const state = find(ctx, requestId);
  if (!state) throw new DomainError('AI_GATEWAY_REQUEST_NOT_FOUND', `No AI request ${requestId}`, 404);
  if (state.status !== 'AWAITING_APPROVAL') {
    throw new DomainError(
      'AI_GATEWAY_NOT_AWAITING_APPROVAL',
      `${requestId} is ${state.status.toLowerCase()}, not awaiting approval. There is no decision open on it.`,
      409,
    );
  }
  return state;
}

/** The authority the approver must hold, or AI_EXECUTION:A where the request named none. */
function approvalAuthority(state: StoredGatewayRequest): { area: CapabilityArea; code: PermissionCode } {
  return state.approval.authority ?? { area: 'AI_EXECUTION', code: 'A' };
}

/** Approve a held consequential output. The result is released; the request completes. */
export function approveGatewayRequest(ctx: EngineContext, requestId: string): UserSafeResponse {
  const state = requireAwaiting(ctx, requestId);
  const authority = approvalAuthority(state);
  authorise(ctx, authority.area, authority.code);

  const next: StoredGatewayRequest = {
    ...state,
    status: 'COMPLETED',
    approval: { ...state.approval, required: false },
    decidedBy: ctx.auth.actorId,
    decidedAt: new Date().toISOString(),
  };
  write(ctx, {
    eventType: 'AI_GATEWAY_APPROVED',
    entity: { refType: 'AIGatewayRequest', refId: requestId },
    nextState: next as unknown as Record<string, unknown>,
  });
  return toResponse(next);
}

/** Reject a held output, with the reason. The result is not released. */
export function rejectGatewayRequest(ctx: EngineContext, requestId: string, input: { reason: string }): UserSafeResponse {
  const reason = input.reason.trim();
  if (reason.length < 4) {
    throw new DomainError('AI_GATEWAY_REJECT_REASON', 'Say why the output is rejected — the reason stays on the record.', 422, [
      { field: 'reason', message: 'At least 4 characters' },
    ]);
  }
  const state = requireAwaiting(ctx, requestId);
  const authority = approvalAuthority(state);
  authorise(ctx, authority.area, authority.code);

  const next: StoredGatewayRequest = {
    ...state,
    status: 'REJECTED',
    result: undefined,
    approval: { ...state.approval, required: false },
    decidedBy: ctx.auth.actorId,
    decidedAt: new Date().toISOString(),
    rejectedReason: reason,
  };
  write(ctx, {
    eventType: 'AI_GATEWAY_REJECTED',
    entity: { refType: 'AIGatewayRequest', refId: requestId },
    nextState: next as unknown as Record<string, unknown>,
  });
  return toResponse(next);
}
