import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { rolesAllow } from '../src/identity/roles.ts';
import { Platform } from '../src/platform.ts';

/**
 * The founding administrators of a company are its owners.
 *
 * Reported as sixty-three locked doors on Site Services: the account's only
 * person held ENTERPRISE_ADMIN, which reads delivery and acts on none of it,
 * and nobody may change their own roles — so a one-person company could act
 * on nothing and nobody could unlock it. Founders are now created as OWNER and
 * ENTERPRISE_ADMIN (asserted in signup and group signup tests); this covers the
 * reconciliation that brings companies created under the old rule to the same
 * place without touching a company that has organised its roles.
 */

let platform: Platform;
let trapped = '';
let trappedAdmin = '';
let organised = '';
let organisedAdmin = '';
let pair = '';

function tenancy(name: string): string {
  return platform.createTenant({ legalName: name, jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'TEAM', package: 'CORE_PROJECT', enterpriseName: name, trialGrant: false, opensOn: 'CREATION' }).tenant.id;
}

before(() => {
  platform = new Platform();
  platform.createOperator({ name: 'Ruth', email: 'ops@construx.example' });

  // Created the old way: one administrator, nobody else.
  trapped = tenancy('ETABLIX Ltd');
  trappedAdmin = platform.createUser({ tenantId: trapped, name: 'Lea Mbala', email: 'lea@etablix.example', roles: ['ENTERPRISE_ADMIN'] }).id;

  // A company that has organised itself: an administrator and a project manager.
  organised = tenancy('Meridian Ltd');
  organisedAdmin = platform.createUser({ tenantId: organised, name: 'Amara Okafor', email: 'amara@meridian.example', roles: ['ENTERPRISE_ADMIN'] }).id;
  platform.createUser({ tenantId: organised, name: 'Tom Hale', email: 'tom@meridian.example', roles: ['PM'] });

  // Two administrators and nobody else: either could have promoted the other.
  pair = tenancy('JNN Homes Ltd');
  platform.createUser({ tenantId: pair, name: 'Esi Boateng', email: 'esi@jnnhomes.example', roles: ['ENTERPRISE_ADMIN'] });
  platform.createUser({ tenantId: pair, name: 'Kwame Mensah', email: 'kwame@jnnhomes.example', roles: ['ENTERPRISE_ADMIN'] });
});

describe('an administrator alone is locked out of delivery', () => {
  it('reads Site Services and acts on none of it, and cannot change their own roles', () => {
    const admin = platform.user(trappedAdmin);
    assert.equal(rolesAllow(admin.roles, 'SITE_SERVICES', 'R'), true);
    assert.equal(rolesAllow(admin.roles, 'SITE_SERVICES', 'C'), false);
    assert.equal(rolesAllow(admin.roles, 'WORKPACKAGES_TASKS', 'C'), false);
    assert.throws(
      () => platform.assignRoles({ actorId: trappedAdmin, tenantId: trapped, roles: admin.roles, partyId: undefined, mfaSatisfied: true } as never, { userId: trappedAdmin, roles: ['OWNER', 'ENTERPRISE_ADMIN'], reason: 'Trying to get out of the trap' }),
      (error: Error & { code?: string }) => error.code === 'SELF_ROLE_CHANGE',
    );
  });
});

describe('the founding administrators become owners', () => {
  it('makes the lone administrator an owner, on the record, and leaves the organised company alone', () => {
    const owned = platform.ownFoundingAdministrators(new Date('2026-09-05T09:00:00Z'));
    assert.deepEqual(
      owned.map((entry) => entry.tenantId).sort(),
      [trapped, pair, pair].sort(),
      'the lone administrator and the pair of administrators; the organised company is untouched',
    );

    const admin = platform.user(trappedAdmin);
    assert.deepEqual(admin.roles, ['OWNER', 'ENTERPRISE_ADMIN']);
    assert.equal(rolesAllow(admin.roles, 'SITE_SERVICES', 'C'), true);
    assert.equal(rolesAllow(admin.roles, 'SITE_SERVICES', 'A'), true);
    assert.equal(rolesAllow(admin.roles, 'WORKPACKAGES_TASKS', 'C'), true);
    assert.equal(rolesAllow(admin.roles, 'PLATFORM_ADMINISTRATION', 'R'), false, 'nothing of the operator layer');

    const record = platform.ledger.require({ refType: 'User', refId: trappedAdmin }).state as Record<string, unknown>;
    assert.deepEqual(record.roles, ['OWNER', 'ENTERPRISE_ADMIN']);
    assert.deepEqual(record.previousRoles, ['ENTERPRISE_ADMIN']);
    assert.equal(record.changedBy, 'platform');
    assert.match(String(record.reason), /Founding administrator of ETABLIX Ltd/);
    assert.match(String(record.reason), /2026-09-05/);

    assert.deepEqual(platform.user(organisedAdmin).roles, ['ENTERPRISE_ADMIN'], 'somebody in that company could have changed the roles, so nothing is changed for them');
    for (const user of platform.users(pair)) assert.deepEqual(user.roles, ['OWNER', 'ENTERPRISE_ADMIN']);
  });

  it('is idempotent: a second pass changes nothing', () => {
    assert.deepEqual(platform.ownFoundingAdministrators(), []);
    assert.deepEqual(platform.user(trappedAdmin).roles, ['OWNER', 'ENTERPRISE_ADMIN']);
  });

  it('keeps the seat: owner and administrator are the same seat class, so the tier still fits', () => {
    const subscription = platform.subscription(trapped);
    assert.equal(subscription.assignedIdentities.filter((identityId) => identityId === trappedAdmin).length, 1);
  });
});
