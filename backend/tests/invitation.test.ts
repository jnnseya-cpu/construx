import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as invitation from '../src/domain/invitation.ts';
import { PACKAGES } from '../src/billing/seats.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { issueTokens, type AuthContext } from '../src/identity/auth.ts';

/**
 * Bringing somebody onto a project.
 *
 * A construction project is not staffed by one organisation, and the person who
 * knows a temporary works engineer is needed for two weeks is the project
 * manager working beside them — not the enterprise administrator at head office
 * who has never heard of them. Only `ENTERPRISE_ADMIN` and `OWNER` could create
 * a person at all, so adding anybody meant a request up the chain.
 *
 * That friction has a known workaround and it is the failure this exists to
 * prevent: one login, several people, and an audit trail that attributes every
 * act to whoever the account is named after. On a platform whose entire claim is
 * that the record says who decided what, a shared credential is not an
 * inconvenience — it is the product not working.
 *
 * Three rules, and each is tested by the case that breaks it rather than the
 * case that passes.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

const as = (who: string) => platform.context(seed.users[who]!.auth, seed.projectId, { source: 'WEB' });

/** A real auth context for a user, minted and decoded as a client's would be. */
function authFor(userId: string): AuthContext {
  const user = platform.user(userId);
  const tokens = issueTokens({
    actorId: user.id,
    tenantId: user.tenantId,
    partyId: user.partyId,
    roles: user.roles,
    mfaSatisfied: true,
  });
  const claims = JSON.parse(
    Buffer.from(tokens.accessToken.split('.')[1] as string, 'base64url').toString('utf8'),
  ) as { sub: string; tid: string; pid?: string; roles: AuthContext['roles']; scopes: string[]; jti: string; exp: number };
  return {
    actorId: claims.sub,
    tenantId: claims.tid,
    partyId: claims.pid,
    roles: claims.roles,
    scopes: claims.scopes,
    tokenId: claims.jti,
    expiresAt: claims.exp,
    mfaSatisfied: true,
  } as AuthContext;
}

let unique = 0;
const someone = (over: Partial<Parameters<typeof invitation.inviteToProject>[2]> = {}) => {
  unique += 1;
  return {
    name: `Invited Person ${unique}`,
    email: `invited-${unique}@elsewhere.example`,
    roles: ['DESIGNER' as const],
    external: false,
    because: 'Temporary works design for the diversion, six weeks from Monday.',
    ...over,
  };
};

describe('who may bring somebody onto a project', () => {
  it('lets a project manager invite, which is the whole point', () => {
    const result = invitation.inviteToProject(platform, as('pm'), someone());
    assert.ok(result.invitationId);
    assert.ok(result.expiresAt > new Date().toISOString(), 'the invitation is already expired');
  });

  it('refuses a regulator, who reads everything and delivers nothing', () => {
    // The distinction the rule turns on. A regulator has read access across the
    // project — wider than most of the delivery team — and adding people to a
    // contractor's tenancy is not oversight.
    throwsCode(() => invitation.inviteToProject(platform, as('regulator'), someone()), 'NOT_WORKING_ON_PROJECT');
  });

  it('derives "works on this project" from the matrix rather than a second list', () => {
    // A list of roles that may invite would answer the same question in a
    // different place, and the two would disagree the first time a role changed.
    assert.equal(invitation.worksOnProject(['PM']), true);
    assert.equal(invitation.worksOnProject(['QAQC']), true);
    assert.equal(invitation.worksOnProject(['SUPERVISOR']), true);
    assert.equal(invitation.worksOnProject(['REGULATOR']), false);
  });

  it('will not take an invitation nobody can explain', () => {
    throwsCode(() => invitation.inviteToProject(platform, as('pm'), someone({ because: 'needed' })), 'INVITATION_UNEXPLAINED');
  });

  it('refuses somebody who is already here, because that is a role change', () => {
    // Inviting an existing colleague again would take a second seat for one
    // person, which is how a seat count quietly stops meaning anything.
    throwsCode(
      () => invitation.inviteToProject(platform, as('pm'), someone({ email: 'qs@meridian.example' })),
      'ALREADY_IN_TENANCY',
    );
  });
});

describe('an external invitee is on the project, not running the business', () => {
  it('requires the organisation, because that is the first question anybody asks', () => {
    throwsCode(
      () => invitation.inviteToProject(platform, as('pm'), someone({ external: true })),
      'INVITATION_ORGANISATION_REQUIRED',
    );
  });

  it('accepts an external invitee who names their company', () => {
    const result = invitation.inviteToProject(
      platform,
      as('pm'),
      someone({ external: true, organisation: 'Hartley Temporary Works Ltd' }),
    );
    const record = platform.ledger.require({ refType: 'ProjectInvitation', refId: result.invitationId });
    assert.equal(record.state.external, true);
    assert.equal(record.state.organisation, 'Hartley Temporary Works Ltd');
  });

  it('will not make an outsider an administrator of the tenancy', () => {
    // A takeover, and the kind that happens by picking the wrong item in a
    // list: those roles grant roles, change the package and reach the money.
    for (const role of ['ENTERPRISE_ADMIN', 'OWNER'] as const) {
      throwsCode(
        () =>
          invitation.inviteToProject(
            platform,
            as('pm'),
            someone({ external: true, organisation: 'Someone Else Ltd', roles: [role] }),
          ),
        'EXTERNAL_CANNOT_ADMINISTER',
      );
    }
  });

  it('allows the same roles internally, because that is an ordinary appointment', () => {
    assert.ok(invitation.inviteToProject(platform, as('pm'), someone({ roles: ['OWNER'] })).invitationId);
  });
});

describe('an invitation is a seat, from the moment it is sent', () => {
  /** A tenancy of its own, so the seat arithmetic is not shared with the seed. */
  function tenancyOf(packageTier: 'SOLO' | 'CORE_PROJECT') {
    const { tenant } = platform.createTenant({
      legalName: `${packageTier} Ltd`,
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: packageTier === 'SOLO' ? 'SOLO' : 'TEAM',
      package: packageTier,
      enterpriseName: packageTier,
    });
    const admin = platform.createUser({
      tenantId: tenant.id,
      name: 'The one who invites',
      email: `admin-${tenant.id}@${packageTier.toLowerCase()}.example`,
      roles: ['PM'],
    });
    return { tenant, admin };
  }

  const smallTenancy = () => tenancyOf('SOLO');

  it('refuses the sender rather than the invitee when the package is full', () => {
    // The rule that matters. If the cap only bit on acceptance, ten seats would
    // absorb fifty invitations, everybody would be told they were on the
    // project, and the eleventh person to click the link would be refused — by
    // which point a person outside the business has been promised something the
    // business cannot give them.
    const { tenant, admin } = smallTenancy();
    assert.equal(PACKAGES.SOLO.includedSeats, 1, 'Solo is a one-seat package, which is what makes this test small');

    // A real token, decoded the way a client's would be. A hand-made auth
    // object resolves to a tenancy the platform does not know, and the seat
    // check then finds no subscription and waves the invitation through — which
    // is the test passing for the wrong reason rather than the code working.
    const ctx = platform.context(authFor(admin.id), `${tenant.id}-governance`, { source: 'WEB' });

    // The single seat is already taken by the person doing the inviting.
    throwsCode(() => invitation.inviteToProject(platform, ctx, someone()), 'SEAT_LIMIT_REACHED');
  });

  it('counts outstanding invitations against the cap, not just assigned identities', () => {
    // The rule proved properly. The Solo case above refuses because the single
    // seat is already *assigned*, which would still refuse if invitations held
    // nothing — so it does not test this at all. This one fills the package
    // with invitations rather than people: one identity assigned, nine invited,
    // and the eleventh must be refused even though only one seat is taken.
    const { tenant, admin } = tenancyOf('CORE_PROJECT');
    const limit = PACKAGES.CORE_PROJECT.includedSeats!;
    const ctx = platform.context(authFor(admin.id), `${tenant.id}-governance`, { source: 'WEB' });

    for (let i = 0; i < limit - 1; i += 1) {
      invitation.inviteToProject(platform, ctx, someone());
    }

    assert.equal(platform.subscription(tenant.id)!.assignedIdentities.length, 1, 'only the inviter holds a seat');
    assert.equal(invitation.pendingInvitations(ctx).length, limit - 1, 'the invitations are not being counted');

    throwsCode(() => invitation.inviteToProject(platform, ctx, someone()), 'SEAT_LIMIT_REACHED');
  });

  it('frees the seat again when one of those invitations is withdrawn', () => {
    // And the other half: a package that is full of invitations is not full for
    // ever. Withdrawing one has to make room, or the only way back is to move
    // package.
    const { tenant, admin } = tenancyOf('CORE_PROJECT');
    const limit = PACKAGES.CORE_PROJECT.includedSeats!;
    const ctx = platform.context(authFor(admin.id), `${tenant.id}-governance`, { source: 'WEB' });

    const sent = [];
    for (let i = 0; i < limit - 1; i += 1) sent.push(invitation.inviteToProject(platform, ctx, someone()));
    throwsCode(() => invitation.inviteToProject(platform, ctx, someone()), 'SEAT_LIMIT_REACHED');

    invitation.withdrawInvitation(ctx, { invitationId: sent[0]!.invitationId, reason: 'Role filled internally' });

    assert.ok(invitation.inviteToProject(platform, ctx, someone()).invitationId, 'withdrawing did not free the seat');
  });

  it('gives the seat back when the invitation is withdrawn', () => {
    const sent = invitation.inviteToProject(platform, as('pm'), someone());
    const held = invitation.pendingInvitations(as('pm')).length;

    invitation.withdrawInvitation(as('pm'), { invitationId: sent.invitationId, reason: 'Role filled internally' });

    assert.equal(invitation.pendingInvitations(as('pm')).length, held - 1, 'a withdrawn invitation still holds its seat');
    assert.equal(
      platform.ledger.require({ refType: 'ProjectInvitation', refId: sent.invitationId }).state.status,
      'WITHDRAWN',
    );
  });

  it('will not withdraw the same invitation twice', () => {
    const sent = invitation.inviteToProject(platform, as('pm'), someone());
    invitation.withdrawInvitation(as('pm'), { invitationId: sent.invitationId, reason: 'Not needed' });
    throwsCode(
      () => invitation.withdrawInvitation(as('pm'), { invitationId: sent.invitationId, reason: 'Not needed' }),
      'INVITATION_NOT_PENDING',
    );
  });
});

describe('acceptance is where the identity is created', () => {
  it('creates the person and takes the seat', () => {
    const sent = invitation.inviteToProject(platform, as('pm'), someone({ name: 'Priya Raman', roles: ['PLANNER'] }));
    const before = platform.users(seed.tenantId).length;

    const accepted = invitation.acceptInvitation(platform, as('pm'), { invitationId: sent.invitationId });

    assert.equal(platform.users(seed.tenantId).length, before + 1);
    const created = platform.users(seed.tenantId).find((user) => user.id === accepted.userId)!;
    assert.equal(created.name, 'Priya Raman');
    assert.deepEqual(created.roles, ['PLANNER']);

    // And the invitation stops holding a seat, because the identity holds it now.
    assert.ok(!invitation.pendingInvitations(as('pm')).some((state) => state.id === sent.invitationId));
  });

  it('refuses an invitation that has lapsed', () => {
    // Fourteen days. An invitation that stands for ever is a seat nobody can
    // account for and a link that still works a year after somebody left.
    const sent = invitation.inviteToProject(platform, as('pm'), someone());
    const later = new Date(Date.parse(sent.expiresAt) + 1000);
    throwsCode(
      () => invitation.acceptInvitation(platform, as('pm'), { invitationId: sent.invitationId }, later),
      'INVITATION_EXPIRED',
    );
  });

  it('refuses to accept one that was withdrawn', () => {
    const sent = invitation.inviteToProject(platform, as('pm'), someone());
    invitation.withdrawInvitation(as('pm'), { invitationId: sent.invitationId, reason: 'Sent to the wrong address' });
    throwsCode(
      () => invitation.acceptInvitation(platform, as('pm'), { invitationId: sent.invitationId }),
      'INVITATION_NOT_PENDING',
    );
  });

  it('cannot be accepted twice', () => {
    const sent = invitation.inviteToProject(platform, as('pm'), someone());
    invitation.acceptInvitation(platform, as('pm'), { invitationId: sent.invitationId });
    throwsCode(
      () => invitation.acceptInvitation(platform, as('pm'), { invitationId: sent.invitationId }),
      'INVITATION_NOT_PENDING',
    );
  });
});
