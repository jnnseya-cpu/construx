/**
 * The tenant-side half of a commercial add-on: the named module seats, and the
 * entitlement a company reads for itself.
 *
 * The operator-side half — the Platform-Admin grant, the verified provider status and
 * the paid seat quantity — is provisioned by `platform.setAddonGrant` and resolved
 * onto the context as `ctx.addonGrant` (see `billing/addongrant.ts`). This module
 * never writes that record and a client can never set it. What a company *does* do
 * for itself is assign its paid seats to its own people, and that is what lives here,
 * on the customer's own ledger through the one `write` path.
 *
 * Entitlement is enforced server-side: `addon.ts` is the pure contract, this binds it
 * to the resolved grant and the assigned seats. Price and entitlement are never taken
 * from a client.
 */

import { DomainError } from '../core/errors.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import {
  canAllocateSeat,
  effectiveEntitlement,
  GRID_MODULE_KEY,
  moduleUsable,
  type Effective,
  type ProviderStatus,
} from './addon.ts';

type SeatState = {
  tenantId: string;
  moduleKey: string;
  userId: string;
  active: boolean;
  assignedBy: string;
  assignedAt: string;
  revokedAt?: string;
};

const seatRef = (ctx: EngineContext, moduleKey: string, userId: string): string => `${ctx.tenantId}:${moduleKey}:${userId}`;

/** The grant resolved onto the context for a module, if the tenant holds a provision for it. */
function grantOf(ctx: EngineContext, moduleKey: string): EngineContext['addonGrant'] | undefined {
  const grant = ctx.addonGrant;
  return grant && grant.moduleKey === moduleKey ? grant : undefined;
}

function activeSeats(ctx: EngineContext, moduleKey: string): SeatState[] {
  return ctx.ledger
    .listByTenant(ctx.tenantId, 'AddonSeat')
    .map((r) => r.state as SeatState)
    .filter((s) => s.moduleKey === moduleKey && s.active);
}

/** Allocate a named module seat to a user, within the paid quantity. Idempotent. */
export function allocateSeat(ctx: EngineContext, input: { moduleKey?: string; userId: string }): SeatState {
  authorise(ctx, 'BILLING_ACU', 'U');
  const moduleKey = input.moduleKey ?? GRID_MODULE_KEY;
  const grant = grantOf(ctx, moduleKey);
  if (!grant || !grant.adminGrant) throw new DomainError('NO_ADDON_GRANT', 'This tenant holds no grant for the module');

  const seats = activeSeats(ctx, moduleKey);
  const held = seats.find((s) => s.userId === input.userId);
  if (held) return held; // idempotent — a user who holds a seat is not charged a second
  if (!canAllocateSeat(grant.paidQuantity, seats.length)) {
    throw new DomainError('SEAT_CAPACITY_EXCEEDED', `All ${grant.paidQuantity} seats are assigned`);
  }
  const state: SeatState = {
    tenantId: ctx.tenantId,
    moduleKey,
    userId: input.userId,
    active: true,
    assignedBy: ctx.auth.actorId,
    assignedAt: new Date().toISOString(),
  };
  write(ctx, {
    eventType: 'ADDON_SEAT_ASSIGNED',
    entity: { refType: 'AddonSeat', refId: seatRef(ctx, moduleKey, input.userId) },
    nextState: state,
  });
  return state;
}

/** Revoke a user's seat, releasing capacity. */
export function revokeSeat(ctx: EngineContext, input: { moduleKey?: string; userId: string }): SeatState {
  authorise(ctx, 'BILLING_ACU', 'U');
  const moduleKey = input.moduleKey ?? GRID_MODULE_KEY;
  const rec = ctx.ledger.get({ refType: 'AddonSeat', refId: seatRef(ctx, moduleKey, input.userId) });
  if (!rec || rec.tenantId !== ctx.tenantId) throw new DomainError('NO_SEAT', `No seat for ${input.userId}`);
  const current = rec.state as SeatState;
  const state: SeatState = { ...current, active: false, revokedAt: new Date().toISOString() };
  write(ctx, {
    eventType: 'ADDON_SEAT_REVOKED',
    entity: { refType: 'AddonSeat', refId: seatRef(ctx, moduleKey, input.userId) },
    nextState: state,
  });
  return state;
}

export type AddonEntitlement = {
  moduleKey: string;
  adminGrant: boolean;
  providerStatus: ProviderStatus | 'NONE';
  effective: Effective;
  usable: boolean;
  paidQuantity: number;
  assignedSeats: number;
  availableSeats: number;
  seatUserIds: string[];
};

/** The tenant's own entitlement and seat usage for the module (what the console shows). */
export function addonEntitlement(ctx: EngineContext, moduleKey = GRID_MODULE_KEY): AddonEntitlement {
  authorise(ctx, 'BILLING_ACU', 'R');
  const grant = grantOf(ctx, moduleKey);
  const seats = activeSeats(ctx, moduleKey);
  const effective = grant ? effectiveEntitlement(grant.adminGrant, grant.providerStatus) : 'LOCKED';
  const paidQuantity = grant?.paidQuantity ?? 0;
  return {
    moduleKey,
    adminGrant: grant?.adminGrant ?? false,
    providerStatus: grant?.providerStatus ?? 'NONE',
    effective,
    usable: moduleUsable(effective),
    paidQuantity,
    assignedSeats: seats.length,
    availableSeats: Math.max(0, paidQuantity - seats.length),
    seatUserIds: seats.map((s) => s.userId),
  };
}

/**
 * Enforce module entitlement for a specific user, server-side (spec §2, A01): the
 * tenant must hold an active grant, billing must permit new use, and the user must
 * hold a seat. Throws the spec's typed errors with their HTTP statuses.
 */
export function requireModuleSeat(ctx: EngineContext, userId: string, moduleKey = GRID_MODULE_KEY): void {
  const grant = grantOf(ctx, moduleKey);
  if (!grant || !grant.adminGrant) throw new DomainError('NO_ADDON_GRANT', 'This tenant has no grant for the module', 403);
  if (!moduleUsable(effectiveEntitlement(grant.adminGrant, grant.providerStatus))) {
    throw new DomainError('BILLING_NOT_ACTIVE', 'The module subscription does not permit new use', 402);
  }
  if (!activeSeats(ctx, moduleKey).some((s) => s.userId === userId)) {
    throw new DomainError('NO_SEAT', 'This user holds no module seat', 403);
  }
}
