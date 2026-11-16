import { DomainError, ForbiddenError } from '../core/errors.ts';
import type { GoldenThreadLedger } from '../goldenthread/ledger.ts';
import { clearanceFor, SENSITIVITY_ORDER } from '../ai/sensitivity.ts';
import type { DataSensitivity } from '../identity/abac.ts';
import { write, type EngineContext } from '../engines/context.ts';

/**
 * What a company has cleared each AI provider to receive — set by its owner.
 *
 * Tender answers carry the company's commercial position, and the platform
 * sends nothing above a vendor's clearance. Until now the only way to clear a
 * vendor was the server setting `AI_PROVIDER_CLEARANCE` and a restart: a bid
 * manager meeting the refusal on a return date had no way forward of their own.
 *
 * Asked for by the owner after an earlier console version was taken out (see
 * "The vendor clearance stays where it was" in docs/STATE.md). That version
 * read first and could refuse what the server setting had always granted. This
 * one only ever adds:
 *
 *   - the effective clearance is the **higher** of the server setting and the
 *     company's grant (`AIOrchestrator.clearanceOf`) — nothing recorded here
 *     ever lowers what the server allows;
 *   - it belongs to **one company**: its owner's decision about its own data,
 *     never another company's;
 *   - only the company's **owner** sets or withdraws it, with a reason (the
 *     contract or data-processing terms that permit it), on the record.
 */

/** The levels a company may clear a vendor to. Below SAFETY_L2 the server default already covers it. */
export const GRANTABLE_LEVELS = SENSITIVITY_ORDER.filter(
  (level) => SENSITIVITY_ORDER.indexOf(level) > SENSITIVITY_ORDER.indexOf('INTERNAL'),
) as DataSensitivity[];

export type ClearanceGrant = {
  level: DataSensitivity;
  reason: string;
  grantedBy: string;
  grantedAt: string;
};

type ClearanceState = {
  id: string;
  tenantId: string;
  grants: Record<string, ClearanceGrant>;
};

const refFor = (tenantId: string) => ({ refType: 'ProviderClearance', refId: `${tenantId}-ai-clearance` });

/** The grant this company holds for this vendor, if any — read on every routed AI call. */
export function grantedClearance(ledger: GoldenThreadLedger, tenantId: string, provider: string): DataSensitivity | undefined {
  const record = ledger.get(refFor(tenantId));
  if (!record || record.tenantId !== tenantId) return undefined;
  return (record.state as unknown as ClearanceState).grants?.[provider]?.level;
}

function requireOwner(ctx: EngineContext): void {
  if (!ctx.auth.roles.includes('OWNER')) {
    throw new ForbiddenError(
      'Only the company owner decides what an AI provider may receive. Ask them to clear it on ACU & Billing.',
      'OWNER_ONLY',
    );
  }
}

function current(ctx: EngineContext): ClearanceState | undefined {
  const record = ctx.ledger.get(refFor(ctx.tenantId));
  return record && record.tenantId === ctx.tenantId ? (record.state as unknown as ClearanceState) : undefined;
}

function requireProvider(ctx: EngineContext, provider: string): void {
  const providers = ctx.orchestrator.transmittingProviders();
  if (!providers.includes(provider as never)) {
    throw new DomainError(
      'PROVIDER_NOT_CONFIGURED',
      `${provider} is not an AI provider this platform sends anything to. ` +
        (providers.length > 0 ? `Configured: ${providers.join(', ')}.` : 'None is configured.'),
      422,
      [{ field: 'provider', message: 'choose a configured provider' }],
    );
  }
}

export function grantClearance(
  ctx: EngineContext,
  input: { provider: string; level: DataSensitivity; reason: string },
): { provider: string; level: DataSensitivity; effective: DataSensitivity } {
  requireOwner(ctx);
  requireProvider(ctx, input.provider);
  if (!GRANTABLE_LEVELS.includes(input.level)) {
    throw new DomainError('CLEARANCE_LEVEL_INVALID', `A provider is cleared to one of ${GRANTABLE_LEVELS.join(', ')}.`, 422, [
      { field: 'level', message: 'choose a level' },
    ]);
  }
  const reason = input.reason.trim();
  if (reason.length < 10) {
    throw new DomainError(
      'CLEARANCE_REASON_REQUIRED',
      'Say what permits it — the contract or data-processing terms with this provider — so the record shows why.',
      422,
      [{ field: 'reason', message: 'at least ten characters' }],
    );
  }
  const state = current(ctx);
  const grant: ClearanceGrant = { level: input.level, reason, grantedBy: ctx.auth.actorId, grantedAt: new Date().toISOString() };
  write(ctx, {
    eventType: 'AI_PROVIDER_CLEARANCE_GRANTED',
    entity: refFor(ctx.tenantId),
    nextState: {
      id: refFor(ctx.tenantId).refId,
      tenantId: ctx.tenantId,
      grants: { ...(state?.grants ?? {}), [input.provider]: grant },
    },
    reason: `${input.provider} cleared to ${input.level}: ${reason}`,
  });
  return { provider: input.provider, level: input.level, effective: ctx.orchestrator.clearanceOf(input.provider, ctx.tenantId) };
}

export function withdrawClearance(
  ctx: EngineContext,
  input: { provider: string; reason: string },
): { provider: string; effective: DataSensitivity } {
  requireOwner(ctx);
  const state = current(ctx);
  if (!state?.grants?.[input.provider]) {
    throw new DomainError('CLEARANCE_NOT_GRANTED', `This company has not cleared ${input.provider} itself, so there is nothing to withdraw.`, 404);
  }
  const reason = input.reason.trim();
  if (reason.length < 10) {
    throw new DomainError('CLEARANCE_REASON_REQUIRED', 'Say why it is withdrawn, so the record shows it.', 422, [
      { field: 'reason', message: 'at least ten characters' },
    ]);
  }
  const grants = { ...state.grants };
  delete grants[input.provider];
  write(ctx, {
    eventType: 'AI_PROVIDER_CLEARANCE_WITHDRAWN',
    entity: refFor(ctx.tenantId),
    nextState: { id: state.id, tenantId: ctx.tenantId, grants },
    reason: `${input.provider} clearance withdrawn: ${reason}`,
  });
  return { provider: input.provider, effective: ctx.orchestrator.clearanceOf(input.provider, ctx.tenantId) };
}

export type ClearancePosition = {
  providers: Array<{
    provider: string;
    /** What the server setting allows (`AI_PROVIDER_CLEARANCE`, or the default). */
    server: DataSensitivity;
    granted: ClearanceGrant | null;
    /** What it may receive for this company: the higher of the two. */
    effective: DataSensitivity;
  }>;
  levels: DataSensitivity[];
  /** Whether the person asking may change it — the owner only. */
  canChange: boolean;
};

export function clearancePosition(ctx: EngineContext): ClearancePosition {
  const state = current(ctx);
  return {
    providers: ctx.orchestrator.transmittingProviders().map((provider) => ({
      provider,
      server: clearanceFor(provider),
      granted: state?.grants?.[provider] ?? null,
      effective: ctx.orchestrator.clearanceOf(provider, ctx.tenantId),
    })),
    levels: GRANTABLE_LEVELS,
    canChange: ctx.auth.roles.includes('OWNER'),
  };
}
