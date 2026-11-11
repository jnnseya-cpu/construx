import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { addonEntitlement, allocateSeat, GRID_MODULE_ID, requireModuleSeat, revokeSeat } from '../src/billing/addonstore.ts';
import type { ProviderStatus } from '../src/billing/addon.ts';

/**
 * The persisted three-state add-on entitlement (spec §2): the Platform-Admin grant and
 * the verified provider status, provisioned operator-side on the platform tenancy; the
 * named seats a company assigns to its own people, tenant-side; and the effective
 * entitlement derived from both. These prove A01 (no grant / no seat / inactive billing
 * all refuse), A03 (seat contention — the last seat goes to exactly one) and A05 (a
 * decrease that would strand a seat is refused), and that the operator's grant never
 * lands on the customer's own ledger.
 */

let platform: Platform;
let seed: SeedResult;
const tenantId = (): string => seed.users.admin!.auth.tenantId;

// The enterprise admin holds BILLING_ACU R+U (seat assignment); qaqc holds R only.
const adminCtx = (): EngineContext =>
  platform.context(seed.users.admin!.auth, `${seed.users.admin!.auth.tenantId}-governance`, { correlationId: 'addon-test' });
const qaqcCtx = (): EngineContext =>
  platform.context(seed.users.qaqc!.auth, `${seed.users.qaqc!.auth.tenantId}-governance`, { correlationId: 'addon-test' });

function provision(input: { adminGrant: boolean; providerStatus: ProviderStatus; paidQuantity: number }): void {
  platform.setAddonGrant({ tenantId: tenantId(), decidedBy: seed.users.operator!.id, ...input });
}

/**
 * Turn the package's free-of-charge exemption on or off for the tenancy. The
 * seeded demonstration tenancy is granted free of charge, which would make the
 * paid add-on free too — correct behaviour, and the subject of its own block
 * below, but it must be *off* for the paid three-state machine to be tested in
 * isolation.
 */
function setFree(free: boolean, until?: string): void {
  const subscription = platform.subscription(tenantId());
  platform.setSubscriptionPackage({
    tenantId: tenantId(),
    package: subscription.package,
    reason: free ? 'Add-on test: operator exemption' : 'Add-on test: a paying customer',
    decidedBy: seed.users.operator!.id,
    grantFree: free,
    ...(free && until !== undefined ? { grantFreeUntil: until } : {}),
  });
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  // The paid machine is proven against a paying tenancy; the exemption gets its
  // own block, where it is turned back on.
  setFree(false);
});

describe('before any provision', () => {
  it('reads a LOCKED, unusable entitlement and refuses every write (A01)', () => {
    const ent = addonEntitlement(adminCtx());
    assert.equal(ent.adminGrant, false);
    assert.equal(ent.providerStatus, 'NONE');
    assert.equal(ent.effective, 'LOCKED');
    assert.equal(ent.usable, false);
    assert.equal(ent.paidQuantity, 0);
    assert.equal(ent.includedSeats, 0); // no grant → nothing included

    assert.throws(() => allocateSeat(adminCtx(), { userId: 'u-1' }), (e) => (e as { code?: string }).code === 'NO_ADDON_GRANT');
    assert.throws(() => requireModuleSeat(adminCtx(), 'u-1'), (e) => (e as { code?: string }).code === 'NO_ADDON_GRANT');
  });
});

describe('the operator provisions the add-on and a company assigns its seats', () => {
  before(() => provision({ adminGrant: true, providerStatus: 'ACTIVE', paidQuantity: 2 }));

  it('derives an ACTIVE, usable entitlement from the grant and the provider status', () => {
    const ent = addonEntitlement(adminCtx());
    assert.equal(ent.adminGrant, true);
    assert.equal(ent.providerStatus, 'ACTIVE');
    assert.equal(ent.effective, 'ACTIVE');
    assert.equal(ent.usable, true);
    assert.equal(ent.paidQuantity, 2);
    assert.equal(ent.includedSeats, 1); // the £100 base always includes one named seat
    assert.equal(ent.assignedSeats, 0);
    assert.equal(ent.availableSeats, 2);
  });

  it('keeps the operator grant off the customer’s own ledger (account-layer separation)', () => {
    // The grant lives on the platform tenancy; the customer reads only the derived
    // entitlement, never the record, and cannot see it on their own thread.
    assert.equal(adminCtx().ledger.listByTenant(tenantId(), 'AddonGrant').length, 0);
  });

  it('refuses seat assignment to a user without BILLING_ACU update (qaqc holds read only)', () => {
    assert.throws(() => allocateSeat(qaqcCtx(), { userId: 'u-1' }), (e) => (e as { code?: string }).code === 'ACCESS_DENIED');
  });

  it('assigns seats within the paid quantity, idempotently, and refuses the overflow (A03)', () => {
    const first = allocateSeat(adminCtx(), { userId: 'u-1' });
    assert.equal(first.active, true);
    // Idempotent: the same user does not consume a second seat.
    assert.equal(allocateSeat(adminCtx(), { userId: 'u-1' }).assignedAt, first.assignedAt);
    allocateSeat(adminCtx(), { userId: 'u-2' });
    // The last seat is taken; a third contender is refused, not silently over-seated.
    assert.throws(() => allocateSeat(adminCtx(), { userId: 'u-3' }), (e) => (e as { code?: string }).code === 'SEAT_CAPACITY_EXCEEDED');

    const ent = addonEntitlement(adminCtx());
    assert.equal(ent.assignedSeats, 2);
    assert.equal(ent.availableSeats, 0);
    assert.deepEqual([...ent.seatUserIds].sort(), ['u-1', 'u-2']);
  });

  it('enforces the full A01 check: grant AND active billing AND a held seat', () => {
    requireModuleSeat(adminCtx(), 'u-1'); // seated, active billing, granted → permitted
    assert.throws(() => requireModuleSeat(adminCtx(), 'u-3'), (e) => (e as { code?: string }).code === 'NO_SEAT');
  });

  it('releases a seat, freeing its capacity for a new user', () => {
    revokeSeat(adminCtx(), { userId: 'u-1' });
    const ent = addonEntitlement(adminCtx());
    assert.equal(ent.assignedSeats, 1);
    assert.equal(ent.availableSeats, 1);
    assert.throws(() => requireModuleSeat(adminCtx(), 'u-1'), (e) => (e as { code?: string }).code === 'NO_SEAT');
    // The freed seat can be taken by someone else.
    allocateSeat(adminCtx(), { userId: 'u-3' });
    assert.equal(addonEntitlement(adminCtx()).availableSeats, 0);
    assert.throws(() => revokeSeat(adminCtx(), { userId: 'nobody' }), (e) => (e as { code?: string }).code === 'NO_SEAT');
  });
});

describe('provisioning changes that must not strand a live seat (A05)', () => {
  beforeEach(() => provision({ adminGrant: true, providerStatus: 'ACTIVE', paidQuantity: 2 }));

  it('refuses a decrease below the seats already assigned', () => {
    // Two seats (u-2, u-3) are live from the block above; dropping to one is refused.
    assert.throws(
      () => provision({ adminGrant: true, providerStatus: 'ACTIVE', paidQuantity: 1 }),
      (e) => (e as { code?: string }).code === 'SEAT_CAPACITY_EXCEEDED',
    );
  });

  it('refuses a paid quantity below one', () => {
    assert.throws(
      () => provision({ adminGrant: true, providerStatus: 'ACTIVE', paidQuantity: 0 }),
      (e) => (e as { code?: string }).code === 'BAD_SEAT_QUANTITY',
    );
  });
});

describe('billing that no longer permits new use (A06)', () => {
  before(() => provision({ adminGrant: true, providerStatus: 'PAST_DUE_GRACE', paidQuantity: 2 }));

  it('reads GRACE — history readable, new use paused — and refuses a seated user a new run', () => {
    const ent = addonEntitlement(adminCtx());
    assert.equal(ent.effective, 'GRACE');
    assert.equal(ent.usable, false);
    // u-2 still holds a seat, but billing does not permit new use.
    assert.throws(() => requireModuleSeat(adminCtx(), 'u-2'), (e) => (e as { code?: string }).code === 'BILLING_NOT_ACTIVE');
  });

  it('locks entirely when the admin grant is withdrawn, whatever the provider says', () => {
    provision({ adminGrant: false, providerStatus: 'ACTIVE', paidQuantity: 2 });
    const ent = addonEntitlement(adminCtx());
    assert.equal(ent.effective, 'LOCKED');
    assert.throws(() => requireModuleSeat(adminCtx(), 'u-2'), (e) => (e as { code?: string }).code === 'NO_ADDON_GRANT');
  });
});

describe('a free-exemption account holds the fully priced add-on free of charge', () => {
  // The add-on is a fully priced product that whoever is allocated it must pay
  // for — except a company on a free-of-charge package (the operator's
  // exemption, e.g. a group account free until its term ends). For that company
  // the operator's allocation alone makes the add-on usable, with no billing
  // provider in the loop, and every use is free; the moment the exemption's term
  // ends it becomes chargeable like everyone else. The *admin grant* here is the
  // module allocation itself — the operator's Private-modules dropdown — not a
  // separate billing provision.
  before(() => {
    // Allocate the module to the company (the operator's dropdown allocation),
    // leave the billing provider explicitly *not* paying-active, and exempt the
    // package until a fixed term.
    platform.setModuleGrant({
      moduleId: GRID_MODULE_ID,
      tenantId: tenantId(),
      status: 'ACTIVE',
      reason: 'Add-on test: Grid allocated to an exempt account',
      decidedBy: seed.users.operator!.id,
    });
    provision({ adminGrant: false, providerStatus: 'SUSPENDED', paidQuantity: 2 });
    setFree(true, '2027-09-01T00:00:00.000Z');
  });

  after(() => {
    setFree(false);
    platform.setModuleGrant({
      moduleId: GRID_MODULE_ID,
      tenantId: tenantId(),
      status: 'REVOKED',
      reason: 'Add-on test: cleanup',
      decidedBy: seed.users.operator!.id,
    });
  });

  it('is ACTIVE and usable on the module allocation alone, overriding a non-paying provider', () => {
    const ent = addonEntitlement(adminCtx());
    assert.equal(ent.adminGrant, true); // the module allocation IS the Platform-Admin grant
    assert.equal(ent.freeExempt, true);
    assert.equal(ent.providerStatus, 'SUSPENDED'); // billing is not active…
    assert.equal(ent.effective, 'ACTIVE'); // …yet the exemption makes it usable, free
    assert.equal(ent.usable, true);
  });

  it('lets any user use it without a named seat being bought (all use is free)', () => {
    requireModuleSeat(adminCtx(), 'nobody-holds-a-seat'); // does not throw
  });

  it('allocates named seats beyond the paid quantity without a capacity refusal', () => {
    const before = addonEntitlement(adminCtx()).assignedSeats;
    allocateSeat(adminCtx(), { userId: 'free-1' });
    allocateSeat(adminCtx(), { userId: 'free-2' });
    allocateSeat(adminCtx(), { userId: 'free-3' }); // past the paid quantity of 2 — allowed, because free
    assert.equal(addonEntitlement(adminCtx()).assignedSeats, before + 3);
  });

  it('becomes chargeable the instant the exemption is not in force — the allocation alone no longer suffices', () => {
    setFree(false);
    const ent = addonEntitlement(adminCtx());
    assert.equal(ent.freeExempt, false);
    assert.equal(ent.adminGrant, true); // still allocated…
    assert.equal(ent.effective, 'STOPPED'); // …but the provider is suspended and nothing covers the charge now
    assert.equal(ent.usable, false);
    assert.throws(
      () => requireModuleSeat(adminCtx(), 'free-1'),
      (e) => (e as { code?: string }).code === 'BILLING_NOT_ACTIVE',
    );
  });
});
