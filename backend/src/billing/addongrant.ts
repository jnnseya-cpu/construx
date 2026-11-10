/**
 * The persisted Platform-Admin provision for a commercial add-on — the operator-side
 * half of the three states the spec §2 demands.
 *
 * Kept on the **platform tenancy**, not the customer's, for exactly the reason
 * `identity/modules.ts`' `ModuleGrant` is: the grant and the verified provider status
 * are the operator's decision about a company, and a tenancy that could read its own
 * provision could eventually write it — self-activating an add-on the spec says only a
 * Platform-Admin grant and *verified* billing may turn on. The customer reads only the
 * derived entitlement (`billing/addonstore.ts`), never this record.
 *
 * This is the record; `billing/addon.ts` is the pure logic that computes entitlement
 * from it, and `platform.ts` writes and resolves it. The named seats are separate and
 * tenant-side — a company assigns its own people — so they are not here.
 */

import type { ProviderStatus } from './addon.ts';

/** The operator-provisioned grant and verified provider status for a module, per tenant. */
export type AddonGrantRecord = {
  moduleKey: string;
  tenantId: string;
  /** The Platform-Admin grant: the off-price-list decision to enable the add-on for this company. */
  adminGrant: boolean;
  /** The billing provider's status, from verified provisioning or reconciliation — never from a client. */
  providerStatus: ProviderStatus;
  /** The number of named seats the company has paid for (the base always includes one). */
  paidQuantity: number;
  /** Which price version this provision was recorded against. */
  priceVersion: string;
  updatedBy: string;
  updatedAt: string;
};

/** The refId a provision is stored under on the platform tenancy. One per tenant per module. */
export function addonGrantRef(moduleKey: string, tenantId: string): string {
  return `${moduleKey}:${tenantId}`;
}
