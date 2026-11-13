import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { Platform, type PlatformUser } from '../src/platform.ts';
import { authOf } from '../src/seed.ts';
import { createGroup, attachCompany } from '../src/group/directory.ts';
import { coverCompany } from '../src/group/onboarding.ts';
import { groupOf } from '../src/group/directory.ts';
import { addonEntitlement, GRID_MODULE_ID } from '../src/billing/addonstore.ts';
import type { EngineContext } from '../src/engines/context.ts';

/**
 * The Grid add-on is free for a company on a **free-exemption group account** —
 * and *only* then. The subtle part this proves: a company of an ordinary
 * **paying** group also carries `grantedFree` on its own subscription (coverage:
 * "the group pays centrally, nothing is billed to me"), but the add-on is a
 * priced product that paying group still owes for. Free follows the entity that
 * settles the bill — the group's primary company — so a member is free only when
 * the group itself is exempt, never from its own coverage flag.
 */

let platform: Platform;
let operator: PlatformUser;
let primary: { tenantId: string; admin: PlatformUser };
let member: { tenantId: string; admin: PlatformUser };
let solo: { tenantId: string; admin: PlatformUser };

function company(legalName: string, adminEmail: string): { tenantId: string; admin: PlatformUser } {
  const created = platform.createTenant({ legalName, jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'ENTERPRISE', package: 'ENTERPRISE', enterpriseName: legalName });
  const admin = platform.createUser({ tenantId: created.tenant.id, name: `${legalName} admin`, email: adminEmail, roles: ['ENTERPRISE_ADMIN'] });
  return { tenantId: created.tenant.id, admin };
}

/** The tenant's own BILLING_ACU-read governance context — what the console reads its add-on entitlement through. */
const ctxFor = (c: { tenantId: string; admin: PlatformUser }): EngineContext =>
  platform.context(authOf(platform, c.admin.id), `${c.tenantId}-governance`, { correlationId: 'freeexempt-test' });

function exempt(tenantId: string, free: boolean): void {
  const subscription = platform.subscription(tenantId);
  platform.setSubscriptionPackage({
    tenantId,
    package: subscription.package,
    reason: free ? 'Test: operator exemption' : 'Test: paying customer',
    decidedBy: operator.id,
    grantFree: free,
  });
}

before(() => {
  platform = new Platform();
  operator = platform.createOperator({ name: 'Ruth Okafor', email: 'ops@construx.example' });
  primary = company('JNN Global Ltd', 'admin@jnnglobal.example');
  member = company('JNN Site Services Ltd', 'admin@jnnsite.example');
  solo = company('Unrelated Civils Ltd', 'admin@unrelated.example');

  // A group: the primary company first (it holds the subscription the group runs
  // on), the member second, brought under the group's cover.
  const group = createGroup(platform, authOf(platform, operator.id), { displayName: 'JNN Global Group', currency: 'GBP' });
  attachCompany(platform, authOf(platform, operator.id), group.id, { tenantId: primary.tenantId, code: 'PRI' });
  attachCompany(platform, authOf(platform, operator.id), group.id, { tenantId: member.tenantId, code: 'MEM' });
  coverCompany(platform, groupOf(platform, group.id), member.tenantId);

  // Grid allocated to the member and to the solo company (the operator's dropdown
  // allocation — the add-on's admin grant).
  for (const tenantId of [member.tenantId, solo.tenantId]) {
    platform.setModuleGrant({ moduleId: GRID_MODULE_ID, tenantId, status: 'ACTIVE', reason: 'Test: Grid allocated', decidedBy: operator.id });
  }
});

describe('a member of a PAYING group is covered, not exempt — the add-on is still chargeable', () => {
  it('carries grantedFree as coverage yet resolves freeExempt false, and Grid is LOCKED until paid', () => {
    // The member's own subscription says granted-free (the group pays centrally)…
    assert.equal(platform.subscription(member.tenantId).grantedFree, true);
    // …but the group's primary pays, so this is coverage, not exemption.
    const ent = addonEntitlement(ctxFor(member));
    assert.equal(ent.adminGrant, true); // allocated
    assert.equal(ent.freeExempt, false); // NOT free — the group pays
    assert.equal(ent.effective, 'LOCKED'); // allocated but unpaid → not usable
    assert.equal(ent.usable, false);
  });
});

describe('once the GROUP is a free-exemption account, the add-on is free for its companies', () => {
  before(() => exempt(primary.tenantId, true)); // the operator exempts the group's paying company

  it('is free and usable for the member, on the allocation alone', () => {
    const ent = addonEntitlement(ctxFor(member));
    assert.equal(ent.freeExempt, true);
    assert.equal(ent.effective, 'ACTIVE');
    assert.equal(ent.usable, true);
  });

  it('is free for the group’s primary company too', () => {
    // The primary holds no Grid allocation here, so its entitlement is LOCKED on
    // the missing grant — but its freeExempt resolves true, which is the signal
    // that would make Grid free the moment Grid were allocated to it.
    const ctx = ctxFor(primary);
    assert.equal(ctx.freeExempt, true);
  });
});

describe('a company standing alone is free only by its own exemption', () => {
  it('pays when not exempt, and is free when the operator exempts it directly', () => {
    assert.equal(addonEntitlement(ctxFor(solo)).freeExempt, false);
    assert.equal(addonEntitlement(ctxFor(solo)).effective, 'LOCKED');

    exempt(solo.tenantId, true);
    const ent = addonEntitlement(ctxFor(solo));
    assert.equal(ent.freeExempt, true);
    assert.equal(ent.effective, 'ACTIVE');
    assert.equal(ent.usable, true);
  });
});
