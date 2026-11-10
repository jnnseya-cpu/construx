/**
 * The Grid Connection AI add-on — the commercial contract as pure, tested logic.
 *
 * Spec §1–2: a recurring module sold per business tenant at **£100 per month**
 * (one named module seat included) plus **£50 per additional named seat per month**,
 * governed by three independently-auditable states — the Platform Admin's grant, the
 * billing provider's status, and the effective entitlement computed from both.
 *
 * This module is the money maths and the state machine only. It creates no charge,
 * calls no provider and persists nothing; the persisted grant/seat store and the
 * (flagged, sign-off-gated) live Stripe wiring sit on top of it. Price and
 * entitlement are decided here, server-side, never from a client.
 */

export const GRID_MODULE_KEY = 'grid_connection_ai';

/** £100 base (one seat included) and £50 per additional seat, in GBP minor units. */
export const ADDON_BASE_FEE_MINOR = 10_000;
export const ADDON_ADDITIONAL_SEAT_FEE_MINOR = 5_000;

/** The monthly fee for a given number of *additional* seats (beyond the included one). */
export function addonMonthlyMinor(additionalSeats: number): number {
  if (!Number.isInteger(additionalSeats) || additionalSeats < 0) {
    throw new Error(`additionalSeats must be a non-negative integer, got ${additionalSeats}`);
  }
  return ADDON_BASE_FEE_MINOR + ADDON_ADDITIONAL_SEAT_FEE_MINOR * additionalSeats;
}

/** The monthly fee for a total named-seat count (the base fee always includes one). */
export function addonMonthlyMinorForSeats(totalSeats: number): number {
  if (!Number.isInteger(totalSeats) || totalSeats < 1) {
    throw new Error(`totalSeats must be an integer ≥ 1, got ${totalSeats}`);
  }
  return addonMonthlyMinor(totalSeats - 1);
}

/** The billing provider's status for the subscription (the provider is authoritative for billing). */
export type ProviderStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'PAST_DUE_GRACE'
  | 'SUSPENDED'
  | 'EXPIRED'
  | 'CANCEL_AT_PERIOD_END';

/** The effective entitlement computed from the admin grant and the provider status. */
export type Effective = 'LOCKED' | 'ACTIVE' | 'GRACE' | 'STOPPED' | 'ENDING';

/**
 * Entitlement turns active only when a Platform-Admin grant exists AND the provider
 * confirms billing (spec §2): an invoice preview, a UI redirect or an unverified
 * webhook cannot activate it. Without the grant it is LOCKED whatever the provider
 * says.
 */
export function effectiveEntitlement(adminGrant: boolean, providerStatus: ProviderStatus): Effective {
  if (!adminGrant) return 'LOCKED';
  switch (providerStatus) {
    case 'ACTIVE':
      return 'ACTIVE';
    case 'CANCEL_AT_PERIOD_END':
      return 'ENDING'; // current paid access continues through the effective date
    case 'PAST_DUE_GRACE':
      return 'GRACE'; // read prior deliverables; new runs/exports paused
    case 'SUSPENDED':
    case 'EXPIRED':
      return 'STOPPED';
    case 'PENDING':
    default:
      return 'LOCKED';
  }
}

/** Whether new module use — analysis, exports, agent runs, gated changes — is permitted. */
export function moduleUsable(effective: Effective): boolean {
  return effective === 'ACTIVE' || effective === 'ENDING';
}

/** Whether entitled history may still be read (grace and stopped keep read access; locked does not). */
export function historyReadable(effective: Effective): boolean {
  return effective !== 'LOCKED';
}

/** Seat capacity: a new allocation is permitted only within the paid quantity (spec §2 seat rules). */
export function canAllocateSeat(paidQuantity: number, activeSeats: number): boolean {
  return activeSeats < paidQuantity;
}

/** How many assignments must be released before a decrease to `newQuantity` is valid. */
export function seatsToUnassign(activeSeats: number, newQuantity: number): number {
  return Math.max(0, activeSeats - Math.max(0, newQuantity));
}
