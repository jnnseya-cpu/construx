import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { evaluateAccess } from '../src/identity/abac.ts';
import { AUTHZ_OPTIONS } from '../src/engines/context.ts';
import type { AuthContext } from '../src/identity/auth.ts';
import type { CustomRole } from '../src/identity/customroles.ts';
import { requiredScope, scopesForRoles } from '../src/identity/scopes.ts';
import { Platform } from '../src/platform.ts';

/**
 * Roles a company writes for itself.
 *
 * A permission system that lets an administrator author permissions is a
 * privilege-escalation engine unless it is bounded, so most of what is asserted
 * here is refusals. The bounds are stated in `identity/customroles.ts`; this is
 * the file that proves they hold, in both directions and at both moments — a
 * role is checked when it is *defined* and again when it is *given to somebody*,
 * because those two acts can be performed by different people with different
 * authority.
 */

let platform: Platform;
let tenantId = '';
let ownerId = '';
let adminId = '';
let plannerId = '';
let pmId = '';

/**
 * A session for this person, built the way the gateway builds one.
 *
 * Scopes come from `scopesForRoles` at sign-in and are then extended by the
 * grants, which is exactly what `gateway.ts` does after resolving them — and it
 * has to, because a scope set minted from the built-in matrix knows nothing
 * about a role the company wrote last week. Building it any other way here
 * would prove the RBAC line and quietly skip the scope line beside it.
 */
function actor(userId: string): AuthContext {
  const user = platform.user(userId);
  const grants = platform.grantsFor(user.id);
  return {
    actorId: user.id,
    tenantId: user.tenantId,
    roles: user.roles,
    partyId: undefined,
    mfaSatisfied: true,
    grants,
    scopes: [...new Set([...scopesForRoles(user.roles), ...grants.map((grant) => requiredScope(grant.area, grant.code))])],
  } as unknown as AuthContext;
}

/** What the platform would decide for this person, exactly as the gateway asks it. */
function decide(userId: string, area: Parameters<typeof evaluateAccess>[1], code: Parameters<typeof evaluateAccess>[2]) {
  const auth = actor(userId);
  return evaluateAccess(auth, area, code, { tenantId: auth.tenantId }, AUTHZ_OPTIONS);
}

before(() => {
  platform = new Platform();
  const created = platform.createTenant({
    legalName: 'Kintore Civils Ltd',
    jurisdiction: 'GB',
    defaultCurrency: 'GBP',
    tier: 'ENTERPRISE',
    package: 'ENTERPRISE',
    enterpriseName: 'Kintore Civils Ltd',
    trialGrant: false,
    opensOn: 'CREATION',
  });
  tenantId = created.tenant.id;

  ownerId = platform.createUser({ tenantId, name: 'Ama Serwaa', email: 'ama@kintore.example', roles: ['OWNER', 'ENTERPRISE_ADMIN'] }).id;
  adminId = platform.createUser({ tenantId, name: 'Rory Fenn', email: 'rory@kintore.example', roles: ['ENTERPRISE_ADMIN'] }).id;
  plannerId = platform.createUser({ tenantId, name: 'Ines Duarte', email: 'ines@kintore.example', roles: ['PLANNER'] }).id;
  pmId = platform.createUser({ tenantId, name: 'Sol Adeyemi', email: 'sol@kintore.example', roles: ['PM'] }).id;
});

describe('a company defines a role of its own', () => {
  let role: CustomRole;

  it('defines it, records it, and publishes it on the register', () => {
    role = platform.defineCustomRole(actor(ownerId), {
      name: 'Planner (RFI)',
      description: 'Our planners raise and answer RFIs; the built-in role does not.',
      seatClass: 'PLANNER',
      grants: [
        { area: 'DESIGN_INFORMATION', code: 'C' },
        { area: 'DESIGN_INFORMATION', code: 'U' },
      ],
    });

    assert.equal(role.tenantId, tenantId);
    assert.equal(role.status, 'ACTIVE');
    assert.equal(role.createdBy, ownerId);
    assert.equal(role.grants.length, 2);

    // On the ledger, not only in memory: the register is read back from it.
    const record = platform.ledger.require({ refType: 'CustomRole', refId: role.id }).state as Record<string, unknown>;
    assert.equal(record.name, 'Planner (RFI)');
    assert.deepEqual(
      platform.customRoles(tenantId).map((entry) => entry.id),
      [role.id],
    );
  });

  it('refuses a second role with the same name', () => {
    assert.throws(
      () =>
        platform.defineCustomRole(actor(ownerId), {
          name: 'planner (rfi)',
          description: 'The same name in different letters is the same name.',
          seatClass: 'PLANNER',
          grants: [{ area: 'DESIGN_INFORMATION', code: 'R' }],
        }),
      (error: Error & { code?: string }) => error.code === 'CUSTOM_ROLE_NAME_TAKEN',
    );
  });

  it('grants nothing until somebody is given it, and then grants exactly what it names', () => {
    // The planner holds no create on design information from the matrix.
    assert.equal(decide(plannerId, 'DESIGN_INFORMATION', 'C').decision, 'DENY');

    platform.setCustomRoles(actor(ownerId), {
      userId: plannerId,
      roleIds: [role.id],
      reason: 'Our planners raise RFIs and the built-in role does not allow it',
    });

    assert.equal(decide(plannerId, 'DESIGN_INFORMATION', 'C').decision, 'ALLOW');
    assert.equal(decide(plannerId, 'DESIGN_INFORMATION', 'U').decision, 'ALLOW');
    // And nothing beyond it. A role is a named set, not a door left open.
    assert.equal(decide(plannerId, 'DESIGN_INFORMATION', 'A').decision, 'DENY');
    assert.equal(decide(plannerId, 'BUDGET_COST', 'A').decision, 'DENY');
  });

  it('says so in the refusal when the company has defined roles and none of them carries it', () => {
    const denial = decide(plannerId, 'BUDGET_COST', 'A');
    assert.match(String(denial.reason), /no role this company defined carries it either/);
  });

  it('takes the capability away the moment the role is retired, without editing anybody', () => {
    platform.retireCustomRole(actor(ownerId), role.id, 'The RFI process moved to the document controllers');

    assert.equal(decide(plannerId, 'DESIGN_INFORMATION', 'C').decision, 'DENY');
    // The id stays on the person: retiring is one write, not a list to rebuild.
    assert.deepEqual(platform.user(plannerId).customRoles, [role.id]);
    assert.equal(platform.customRoles(tenantId).find((entry) => entry.id === role.id)?.status, 'RETIRED');
  });

  it('refuses to amend or hand out a retired role', () => {
    assert.throws(
      () => platform.amendCustomRole(actor(ownerId), role.id, { description: 'Trying to bring it back this way' }),
      (error: Error & { code?: string }) => error.code === 'CUSTOM_ROLE_RETIRED',
    );
    assert.throws(
      () =>
        platform.setCustomRoles(actor(ownerId), {
          userId: pmId,
          roleIds: [role.id],
          reason: 'Trying to hand out a role that has been withdrawn',
        }),
      (error: Error & { code?: string }) => error.code === 'CUSTOM_ROLE_RETIRED',
    );
  });
});

describe('nobody grants what they do not hold', () => {
  it('refuses a definition carrying a capability the definer has not got', () => {
    // The enterprise administrator reads the payment applications and certifies
    // none of them. Rule 1, at the moment of definition.
    assert.throws(
      () =>
        platform.defineCustomRole(actor(adminId), {
          name: 'Commercial Signatory',
          description: 'An attempt to write payment certification into a role from an account that has none.',
          seatClass: 'QS',
          grants: [{ area: 'PAYMENT_APPLICATIONS', code: 'A' }],
        }),
      (error: Error & { code?: string }) => error.code === 'GRANT_EXCEEDS_AUTHORITY',
    );
  });

  it('refuses to hand on a role carrying more than the assigner holds', () => {
    // Rule 1 at the second moment, which is the one an escalation would use:
    // the owner may define this, and the administrator may not pass it on.
    const strong = platform.defineCustomRole(actor(ownerId), {
      name: 'Payment Signatory',
      description: 'Certifies payment applications. Defined by the owner, who holds it.',
      seatClass: 'QS',
      grants: [{ area: 'PAYMENT_APPLICATIONS', code: 'A' }],
    });

    assert.throws(
      () =>
        platform.setCustomRoles(actor(adminId), {
          userId: pmId,
          roleIds: [strong.id],
          reason: 'Passing on an authority I was never given myself',
        }),
      (error: Error & { code?: string }) => error.code === 'GRANT_EXCEEDS_AUTHORITY',
    );
  });

  it('does not let a capability held through a custom role be put into another one', () => {
    // No chains. `checkGrants` bounds a definition by the definer's *built-in*
    // roles, so a delegation cannot end anywhere its first link could not have
    // reached directly — which is what stops two administrators walking each
    // other up to an authority neither of them has.
    const governing = platform.defineCustomRole(actor(ownerId), {
      name: 'Deputy Governance',
      description: 'May change people and policy, so they can define roles of their own.',
      seatClass: 'ENTERPRISE_ADMIN',
      grants: [{ area: 'ENTERPRISE_STRUCTURE', code: 'G' }],
    });
    platform.setCustomRoles(actor(ownerId), {
      userId: pmId,
      roleIds: [governing.id],
      reason: 'Sol deputises for governance while Rory is away',
    });

    // The grant works: they may now reach the governance capability.
    assert.equal(decide(pmId, 'ENTERPRISE_STRUCTURE', 'G').decision, 'ALLOW');

    // And it is not re-grantable. A PM certifies no payments on the matrix.
    assert.throws(
      () =>
        platform.defineCustomRole(actor(pmId), {
          name: 'Second Hand Signatory',
          description: 'An attempt to launder an authority through a chain of delegations.',
          seatClass: 'QS',
          grants: [{ area: 'PAYMENT_APPLICATIONS', code: 'A' }],
        }),
      (error: Error & { code?: string }) => error.code === 'GRANT_EXCEEDS_AUTHORITY',
    );
  });

  it('refuses the operator layer outright, to anybody, including the owner', () => {
    assert.throws(
      () =>
        platform.defineCustomRole(actor(ownerId), {
          name: 'Super Admin',
          description: 'An attempt to reach the platform operator layer from inside a tenancy.',
          seatClass: 'ENTERPRISE_ADMIN',
          grants: [{ area: 'PLATFORM_ADMINISTRATION', code: 'R' }],
        }),
      (error: Error & { code?: string }) => error.code === 'ACCOUNT_LAYER_SEPARATION',
    );
  });

  it('refuses an operator role as a seat class', () => {
    assert.throws(
      () =>
        platform.defineCustomRole(actor(ownerId), {
          name: 'Inspector',
          description: 'An attempt to occupy a seat that does not exist inside a tenancy.',
          seatClass: 'REGULATOR',
          grants: [{ area: 'EVIDENCE_AUDIT', code: 'R' }],
        }),
      (error: Error & { code?: string }) => error.code === 'ACCOUNT_LAYER_SEPARATION',
    );
  });

  it('refuses a role that grants nothing', () => {
    assert.throws(() =>
      platform.defineCustomRole(actor(ownerId), {
        name: 'Empty',
        description: 'A role that grants nothing is not a role.',
        seatClass: 'VIEWER',
        grants: [],
      }),
    );
  });
});

describe('a seat is still a seat', () => {
  it('refuses a participant seat class on a role carrying Controller authority', () => {
    // The whole of the revenue hole in one assertion: the declaration was
    // honest about the name and silent about the contents, and a person
    // approving payments would have been counted as a free participant.
    assert.throws(
      () =>
        platform.defineCustomRole(actor(ownerId), {
          name: 'Site Helper',
          description: 'Certifies payments while being named after a role that takes no seat.',
          seatClass: 'VIEWER',
          grants: [{ area: 'PAYMENT_APPLICATIONS', code: 'A' }],
        }),
      (error: Error & { code?: string }) => error.code === 'CUSTOM_ROLE_SEAT_UNDERSTATED',
    );
  });

  it('refuses the same understatement introduced by an amendment', () => {
    const modest = platform.defineCustomRole(actor(ownerId), {
      name: 'Site Reader',
      description: 'Reads the payment applications and changes nothing.',
      seatClass: 'VIEWER',
      grants: [{ area: 'PAYMENT_APPLICATIONS', code: 'R' }],
    });
    assert.throws(
      () =>
        platform.amendCustomRole(actor(ownerId), modest.id, {
          grants: [{ area: 'PAYMENT_APPLICATIONS', code: 'A' }],
        }),
      (error: Error & { code?: string }) => error.code === 'CUSTOM_ROLE_SEAT_UNDERSTATED',
    );
  });

  it('refuses a Controller-class role to somebody holding no Controller seat', () => {
    const signatory = platform.customRoles(tenantId).find((entry) => entry.name === 'Payment Signatory');
    assert.ok(signatory, 'the owner-defined signatory role from the previous block');

    // A VIEWER takes no seat. Giving them Controller authority without one
    // would be Controller work billed as nothing.
    const viewerId = platform.createUser({ tenantId, name: 'Noor Haddad', email: 'noor@kintore.example', roles: ['VIEWER'] }).id;
    assert.throws(
      () =>
        platform.setCustomRoles(actor(ownerId), {
          userId: viewerId,
          roleIds: [signatory.id],
          reason: 'Giving Controller authority to somebody who takes no seat',
        }),
      (error: Error & { code?: string }) => error.code === 'CUSTOM_ROLE_SEAT_REQUIRED',
    );
  });

  it('refuses to reduce somebody to a participant while they hold a Controller-class role', () => {
    const signatory = platform.customRoles(tenantId).find((entry) => entry.name === 'Payment Signatory');
    assert.ok(signatory);

    const qsId = platform.createUser({ tenantId, name: 'Dario Vella', email: 'dario@kintore.example', roles: ['QS'] }).id;
    platform.setCustomRoles(actor(ownerId), {
      userId: qsId,
      roleIds: [signatory.id],
      reason: 'Dario certifies the payment applications for the northern programme',
    });

    // The same hole walked backwards: keep the authority, give the seat back.
    assert.throws(
      () =>
        platform.assignRoles(actor(ownerId), {
          userId: qsId,
          roles: ['VIEWER'],
          reason: 'Reducing them to a viewer while the company role stays on',
        }),
      (error: Error & { code?: string }) => error.code === 'CUSTOM_ROLE_SEAT_REQUIRED',
    );

    // Take the company role off first and the reduction goes through.
    platform.setCustomRoles(actor(ownerId), { userId: qsId, roleIds: [], reason: 'Dario no longer certifies the payment applications' });
    assert.doesNotThrow(() =>
      platform.assignRoles(actor(ownerId), { userId: qsId, roles: ['VIEWER'], reason: 'Dario has moved to a reporting role' }),
    );
  });
});

describe('who may change what, and what is written down', () => {
  it('refuses to let anybody give themselves a company role', () => {
    const role = platform.customRoles(tenantId).find((entry) => entry.name === 'Deputy Governance');
    assert.ok(role);
    assert.throws(
      () =>
        platform.setCustomRoles(actor(ownerId), {
          userId: ownerId,
          roleIds: [role.id],
          reason: 'An identity cannot change its own authority',
        }),
      (error: Error & { code?: string }) => error.code === 'SELF_ROLE_CHANGE',
    );
  });

  it('requires a reason for a change and for a retirement', () => {
    const role = platform.customRoles(tenantId).find((entry) => entry.name === 'Deputy Governance');
    assert.ok(role);
    assert.throws(
      () => platform.setCustomRoles(actor(ownerId), { userId: pmId, roleIds: [], reason: 'tidy' }),
      (error: Error & { code?: string }) => error.code === 'ROLE_CHANGE_UNEXPLAINED',
    );
    assert.throws(
      () => platform.retireCustomRole(actor(ownerId), role.id, 'no'),
      (error: Error & { code?: string }) => error.code === 'CUSTOM_ROLE_RETIREMENT_UNEXPLAINED',
    );
  });

  it('records the set before and after, against whoever changed it', () => {
    const role = platform.customRoles(tenantId).find((entry) => entry.name === 'Deputy Governance');
    assert.ok(role);
    platform.setCustomRoles(actor(ownerId), {
      userId: pmId,
      roleIds: [],
      reason: 'Rory is back from leave and takes governance again',
    });

    const record = platform.ledger.require({ refType: 'User', refId: pmId }).state as Record<string, unknown>;
    assert.deepEqual(record.customRoles, []);
    assert.deepEqual(record.previousCustomRoles, [role.id]);
    assert.equal(record.changedBy, ownerId);
    assert.match(String(record.reason), /back from leave/);
    // And the authority is gone with it.
    assert.equal(decide(pmId, 'ENTERPRISE_STRUCTURE', 'G').decision, 'DENY');
  });

  it('keeps one company’s roles out of another’s', () => {
    const other = platform.createTenant({
      legalName: 'Braemar Plant Ltd',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'TEAM',
      package: 'CORE_PROJECT',
      enterpriseName: 'Braemar Plant Ltd',
      trialGrant: false,
      opensOn: 'CREATION',
    }).tenant.id;
    const otherOwner = platform.createUser({ tenantId: other, name: 'Fen Liu', email: 'fen@braemar.example', roles: ['OWNER', 'ENTERPRISE_ADMIN'] }).id;
    const otherStaff = platform.createUser({ tenantId: other, name: 'Gil Roux', email: 'gil@braemar.example', roles: ['QS'] }).id;

    assert.deepEqual(platform.customRoles(other), [], 'a new company has none of anybody else’s');

    const mine = platform.customRoles(tenantId).find((entry) => entry.name === 'Deputy Governance');
    assert.ok(mine);
    assert.throws(
      () =>
        platform.setCustomRoles(actor(otherOwner), {
          userId: otherStaff,
          roleIds: [mine.id],
          reason: 'Reaching for a role defined inside another company',
        }),
      // Not found rather than forbidden: the role is not theirs to know about.
      (error: Error & { status?: number }) => error.status === 404,
    );
  });
});
