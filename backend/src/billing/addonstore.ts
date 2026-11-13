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
import type { ModuleId } from '../identity/modules.ts';
import {
  canAllocateSeat,
  effectiveEntitlement,
  GRID_MODULE_KEY,
  moduleUsable,
  type Effective,
  type ProviderStatus,
} from './addon.ts';

/**
 * The `MODULES` catalogue id whose grant — the one the operator allocates from the
 * **Private modules** dropdown on the admin console — is the Grid add-on's admin
 * grant. Keeping the add-on's billing key (`GRID_MODULE_KEY`) and its catalogue id
 * separate is deliberate: the catalogue entry is what makes the add-on allocatable
 * in the UI and governs read-after-lapse, and the billing key is what the provider
 * and the seat store are keyed by. They refer to the same product.
 */
export const GRID_MODULE_ID: ModuleId = 'GRID_CONNECTION';

/** The billing keys whose admin grant is conferred by holding a catalogue module. */
const MODULE_ID_FOR_KEY: Readonly<Record<string, ModuleId>> = { [GRID_MODULE_KEY]: GRID_MODULE_ID };

/**
 * Whether the operator has **allocated** the add-on's module to this tenancy — the
 * grant an admin makes from the Private modules dropdown. This is the admin grant
 * the spec means by "only the operator can allocate it": a company can never set it
 * for itself. A legacy provision that carries its own `adminGrant` flag counts too,
 * so a tenancy provisioned before the module was catalogued is not silently locked.
 */
function hasAdminGrant(ctx: EngineContext, moduleKey: string): boolean {
  const moduleId = MODULE_ID_FOR_KEY[moduleKey];
  if (moduleId !== undefined && ctx.grantedModules.includes(moduleId)) return true;
  return grantOf(ctx, moduleKey)?.adminGrant === true;
}

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
  if (!hasAdminGrant(ctx, moduleKey)) throw new DomainError('NO_ADDON_GRANT', 'This tenant holds no grant for the module');

  const seats = activeSeats(ctx, moduleKey);
  const held = seats.find((s) => s.userId === input.userId);
  if (held) return held; // idempotent — a user who holds a seat is not charged a second
  // A free-exempt tenancy pays for nothing, seats included, so the paid-quantity
  // ceiling — which exists to stop a company seating more people than it bought —
  // does not apply to it. Everyone else is held to the quantity the provider billed.
  if (ctx.freeExempt !== true && !canAllocateSeat(grantOf(ctx, moduleKey)?.paidQuantity ?? 0, seats.length)) {
    throw new DomainError('SEAT_CAPACITY_EXCEEDED', `All ${grantOf(ctx, moduleKey)?.paidQuantity ?? 0} seats are assigned`);
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
  /**
   * Whether this tenancy holds the add-on free under its package exemption rather
   * than by paying for it — true only while the exemption's term is still running.
   * The console reads this to say "included free" rather than quoting a price the
   * company will never be asked for, and to warn when the term is the reason it is
   * free rather than a settled billing arrangement.
   */
  freeExempt: boolean;
  /**
   * The named seats the base fee already covers — one, always, because the £100
   * base includes a single named seat (`addon.ts`); further seats are £50 each.
   * The console shows it so a granted add-on reads "1 seat included" rather than
   * "0 seats" the moment it is active, and so the first seat is understood as
   * already paid for rather than an extra.
   */
  includedSeats: number;
  paidQuantity: number;
  assignedSeats: number;
  availableSeats: number;
  seatUserIds: string[];
};

/** The named seats the base fee includes — one, for a held add-on; none otherwise. */
const INCLUDED_SEATS = 1;

/** The tenant's own entitlement and seat usage for the module (what the console shows). */
export function addonEntitlement(ctx: EngineContext, moduleKey = GRID_MODULE_KEY): AddonEntitlement {
  authorise(ctx, 'BILLING_ACU', 'R');
  const grant = grantOf(ctx, moduleKey);
  const seats = activeSeats(ctx, moduleKey);
  const adminGrant = hasAdminGrant(ctx, moduleKey);
  const freeExempt = ctx.freeExempt === true;
  const effective = effectiveEntitlement(adminGrant, grant?.providerStatus ?? 'PENDING', { freeExempt });
  const paidQuantity = grant?.paidQuantity ?? 0;
  return {
    moduleKey,
    adminGrant,
    // A free-exempt tenancy may hold the add-on without any billing provision, so
    // there is no provider status to report — it reads NONE, and `freeExempt` is
    // why it is nevertheless ACTIVE.
    providerStatus: grant?.providerStatus ?? 'NONE',
    effective,
    usable: moduleUsable(effective),
    freeExempt,
    includedSeats: adminGrant ? INCLUDED_SEATS : 0,
    paidQuantity,
    assignedSeats: seats.length,
    // The remaining-seat count describes the billing provision, which an exempt
    // tenancy has none of. It is reported as-is (0 against a quantity it never
    // bought), and `freeExempt` above is what tells a reader the cap does not
    // apply — any of its people may use the add-on without a seat being bought.
    // A finite number rather than an unbounded one on purpose: `JSON.stringify`
    // renders Infinity as null, and a null here would read on the wire as "seat
    // data missing" rather than "seats uncapped".
    availableSeats: Math.max(0, paidQuantity - seats.length),
    seatUserIds: seats.map((s) => s.userId),
  };
}

/**
 * Enforce module entitlement for a specific user, server-side (spec §2, A01): the
 * tenant must hold an active grant, billing must permit new use, and the user must
 * hold a seat. Throws the spec's typed errors with their HTTP statuses.
 *
 * A free-exempt tenancy is the deliberate exception at both the billing gate and
 * the seat gate: its allocation alone makes the add-on usable (nothing is billed),
 * and its "all use" exemption means any of its people may use it without a named
 * seat being bought for them. The grant is still required — the exemption covers
 * the charge, it does not allocate the module.
 */
export function requireModuleSeat(ctx: EngineContext, userId: string, moduleKey = GRID_MODULE_KEY): void {
  const adminGrant = hasAdminGrant(ctx, moduleKey);
  if (!adminGrant) throw new DomainError('NO_ADDON_GRANT', 'This tenant has no grant for the module', 403);
  const freeExempt = ctx.freeExempt === true;
  if (!moduleUsable(effectiveEntitlement(adminGrant, grantOf(ctx, moduleKey)?.providerStatus ?? 'PENDING', { freeExempt }))) {
    throw new DomainError('BILLING_NOT_ACTIVE', 'The module subscription does not permit new use', 402);
  }
  if (freeExempt) return; // all use is free under the exemption; no named seat is required
  if (!activeSeats(ctx, moduleKey).some((s) => s.userId === userId)) {
    throw new DomainError('NO_SEAT', 'This user holds no module seat', 403);
  }
}
