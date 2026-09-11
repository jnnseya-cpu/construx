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
let settled = '';
let settledAdmin = '';
let alsoDelivers = '';
let alsoDeliversAdmin = '';

function tenancy(name: string): string {
  return platform.createTenant({ legalName: name, jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'TEAM', package: 'CORE_PROJECT', enterpriseName: name, trialGrant: false, opensOn: 'CREATION' }).tenant.id;
}

before(() => {
  platform = new Platform();
  platform.createOperator({ name: 'Ruth', email: 'ops@construx.example' });

  // Created the old way: one administrator, nobody else.
  trapped = tenancy('ETABLIX Ltd');
  trappedAdmin = platform.createUser({ tenantId: trapped, name: 'Lea Mbala', email: 'lea@etablix.example', roles: ['ENTERPRISE_ADMIN'] }).id;

  // An administrator who has invited somebody — and is trapped exactly as the
  // lone one is.
  //
  // This fixture used to be called "a company that has organised itself" and
  // the repair was asserted to step over it, on the reasoning that somebody
  // there could have changed the roles. That reasoning was wrong: only
  // ENTERPRISE_ADMIN and OWNER may grant roles at all, and nobody may grant
  // their own, so a project manager in the room creates nobody who could have
  // made this administrator an owner. The old rule therefore stopped helping a
  // founder the moment they did the one thing the administrator's role exists
  // for, which is to invite the rest of the company.
  organised = tenancy('Meridian Ltd');
  organisedAdmin = platform.createUser({ tenantId: organised, name: 'Amara Okafor', email: 'amara@meridian.example', roles: ['ENTERPRISE_ADMIN'] }).id;
  platform.createUser({ tenantId: organised, name: 'Tom Hale', email: 'tom@meridian.example', roles: ['PM'] });

  // A company that really has organised itself: somebody holds OWNER already.
  // Nothing here is the platform's business.
  settled = tenancy('Rossendale Ltd');
  settledAdmin = platform.createUser({ tenantId: settled, name: 'Iris Vance', email: 'iris@rossendale.example', roles: ['ENTERPRISE_ADMIN'] }).id;
  platform.createUser({ tenantId: settled, name: 'Joan Petrie', email: 'joan@rossendale.example', roles: ['OWNER'] });

  // An administrator who also carries a delivery role. Ownership is added to
  // what they hold, never swapped for it.
  alsoDelivers = tenancy('Kirkbride Ltd');
  alsoDeliversAdmin = platform.createUser({ tenantId: alsoDelivers, name: 'Sam Doyle', email: 'sam@kirkbride.example', roles: ['ENTERPRISE_ADMIN', 'QS'] }).id;

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
      [trapped, organised, pair, pair, alsoDelivers].sort(),
      'every tenancy with no owner; only the one that already has an owner is untouched',
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

    // The blind spot the old rule had. Inviting a project manager created
    // nobody who could grant ownership, and used to disqualify this founder
    // from the repair for ever.
    assert.deepEqual(platform.user(organisedAdmin).roles, ['OWNER', 'ENTERPRISE_ADMIN']);
    assert.equal(rolesAllow(platform.user(organisedAdmin).roles, 'FIELD_EXECUTION', 'C'), true);

    // Already has an owner, so the platform has no business here.
    assert.deepEqual(platform.user(settledAdmin).roles, ['ENTERPRISE_ADMIN'], 'a company with an owner is left exactly as it is');

    // Ownership is added to what they hold, not swapped for it.
    assert.deepEqual(platform.user(alsoDeliversAdmin).roles.sort(), ['ENTERPRISE_ADMIN', 'OWNER', 'QS'].sort());

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
