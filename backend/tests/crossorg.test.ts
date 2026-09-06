import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { rejectsCode, throwsCode } from './helpers.ts';
import { createGateway } from '../src/api/gateway.ts';
import * as collection from '../src/billing/collection.ts';
import { CONTROLLER_PASS, PACKAGES } from '../src/billing/seats.ts';
import { decideSponsorship, requestSponsorship, resolveAcu, revokeSponsorship, sponsorshipsFor, usageOf } from '../src/billing/sponsorship.ts';
import * as invitation from '../src/domain/invitation.ts';
import {
  changePermissions,
  membershipOf,
  membershipsOfUser,
  passOf,
  previewLicence,
  purchasePass,
  revokeMembership,
  revokePass,
  seatDashboard,
  sweepMemberships,
} from '../src/domain/membership.ts';
import * as structure from '../src/domain/structure.ts';
import { ENGINE_CONTRACTS, engineActiveIn, type Engine } from '../src/ai/orchestrator.ts';
import { chargeableWallet, runAI } from '../src/engines/context.ts';
import { attachCompany, createGroup } from '../src/group/directory.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { accessClassOf, licenceBadge, resolveControllerLicence, LICENCE_BADGE_LABELS } from '../src/identity/licence.ts';
import { TENANT_GRANTABLE_ROLES, type Role } from '../src/identity/roles.ts';
import { Platform } from '../src/platform.ts';
import { authOf, seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * One person, one home organisation, one Controller seat.
 *
 * Every scenario here is one the requirement names, and every one of them
 * used to charge the host: an invitation created an identity in the host's
 * tenancy and the identity took one of the host's seats, whoever the person
 * was and whatever they already paid for at home. What is asserted now is
 * the separation — identity, home organisation, licence, membership and ACU
 * sponsorship as different facts — and the money that follows from it: no
 * host seat by invitation, a seat reused from home or group, a pass only
 * when the host buys one, and AI charged to whoever agreed to pay.
 */

let platform: Platform;
let seed: SeedResult;
let host: { tenantId: string; projectId: string; second: string; pm: ReturnType<typeof authOf>; admin: ReturnType<typeof authOf>; owner: ReturnType<typeof authOf> };
let abc: { tenantId: string; admin: string; jane: string; dev: string };
let sibling: { tenantId: string; admin: string; kemi: string };
let server: Server;
let base: string;

const DAY = 86_400_000;
const soon = (days: number) => new Date(Date.now() + days * DAY).toISOString();

function tokenFor(userId: string): string {
  const auth = authOf(platform, userId);
  return issueTokens({ actorId: auth.actorId, tenantId: auth.tenantId, partyId: auth.partyId, roles: auth.roles, mfaSatisfied: true }).accessToken;
}

async function call(method: string, path: string, token: string, payload?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const hostCtx = (auth: ReturnType<typeof authOf>, projectId = host.projectId) => platform.context(auth, projectId, { source: 'WEB' });

let unique = 0;
function invite(over: Partial<Parameters<typeof invitation.inviteToProject>[2]> & { email: string; roles: Role[] }, projectId = host.projectId) {
  unique += 1;
  return invitation.inviteToProject(platform, hostCtx(host.pm, projectId), {
    name: over.name ?? `Person ${unique}`,
    external: true,
    organisation: 'Named on the invitation',
    because: 'Appointed to the project for the works described in the enquiry.',
    ...over,
  });
}

before(async () => {
  platform = new Platform();
  collection.setCollector(collection.NO_PAYMENT_METHOD);
  seed = await seedDemoProject(platform);
  const gov = platform.context(seed.users.admin!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
  const source = platform.ledger.entitiesOfType('Project').find((record) => record.state.id === seed.projectId)!;
  const second = structure.createProject(gov, {
    portfolioId: String(source.state.portfolioId),
    programmeId: String(source.state.programmeId),
    name: 'Project Beta',
    sectorType: 'UTILITIES',
    assetType: 'Fixture',
    location: { continentCode: 'EU', countryCode: 'GB', city: 'Bury' },
    contractValueMinor: 50_000_000,
    currency: 'GBP',
    plannedStart: '2026-03-02',
    plannedCompletion: '2027-03-02',
  }).projectId;
  host = { tenantId: seed.tenantId, projectId: seed.projectId, second, pm: seed.users.pm!.auth, admin: seed.users.admin!.auth, owner: seed.users.owner!.auth };

  // ABC Engineering: a paying company with its own Controllers and participants.
  const created = platform.createTenant({ legalName: 'ABC Engineering Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'TEAM', package: 'CORE_PROJECT', enterpriseName: 'ABC Engineering' });
  const abcAdmin = platform.createUser({ tenantId: created.tenant.id, name: 'Adaeze Bello', email: 'admin@abc-engineering.example', roles: ['ENTERPRISE_ADMIN', 'OWNER'] });
  const jane = platform.createUser({ tenantId: created.tenant.id, name: 'Jane Smith', email: 'jane@abc-engineering.example', roles: ['QS'] });
  const dev = platform.createUser({ tenantId: created.tenant.id, name: 'Dev Patel', email: 'dev@abc-engineering.example', roles: ['DESIGNER'] });
  abc = { tenantId: created.tenant.id, admin: abcAdmin.id, jane: jane.id, dev: dev.id };
  platform.creditFromPayment({ tenantId: abc.tenantId, amountMinor: 50_000, method: 'CARD', reference: 'ABC-TOPUP-1', recordedBy: abcAdmin.id, source: 'OPERATOR' });

  // A company of the host's own group, with a seated Controller.
  const sib = platform.createTenant({ legalName: 'JN Construction Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'TEAM', package: 'CORE_PROJECT', enterpriseName: 'JN Construction' });
  const sibAdmin = platform.createUser({ tenantId: sib.tenant.id, name: 'Sibling Admin', email: 'admin@jn-construction.example', roles: ['ENTERPRISE_ADMIN', 'OWNER'] });
  const kemi = platform.createUser({ tenantId: sib.tenant.id, name: 'Kemi Adeyemi', email: 'kemi@jn-construction.example', roles: ['PM'] });
  sibling = { tenantId: sib.tenant.id, admin: sibAdmin.id, kemi: kemi.id };
  const group = createGroup(platform, seed.users.admin!.auth, { displayName: 'Groupe Nseya Digital', currency: 'GBP' });
  attachCompany(platform, seed.users.admin!.auth, group.id, { tenantId: host.tenantId, code: 'MER' });
  attachCompany(platform, seed.users.admin!.auth, group.id, { tenantId: sibling.tenantId, code: 'JNC' });

  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

// ------------------------------------------------------------- the pure rule

describe('the licence resolution rule', () => {
  it('resolves in the order the requirement fixes: home, group, pass, none', () => {
    const base = { hasValidHomeControllerSeat: false, hasValidGroupControllerSeat: false, hasValidHostProjectPass: false };
    assert.deepEqual(resolveControllerLicence({ accessClass: 'PARTICIPANT', ...base, hasValidHomeControllerSeat: true }), {
      controllerAccessAllowed: false, licenceSource: 'NONE', hostBillableSeat: false, reasonCode: 'PARTICIPANT_SEAT_NOT_REQUIRED',
    });
    assert.equal(resolveControllerLicence({ accessClass: 'CONTROLLER', ...base, hasValidHomeControllerSeat: true, hasValidHostProjectPass: true }).licenceSource, 'HOME_ORGANISATION');
    assert.equal(resolveControllerLicence({ accessClass: 'CONTROLLER', ...base, hasValidGroupControllerSeat: true, hasValidHostProjectPass: true }).licenceSource, 'GROUP_ENTERPRISE');
    const pass = resolveControllerLicence({ accessClass: 'CONTROLLER', ...base, hasValidHostProjectPass: true });
    assert.equal(pass.licenceSource, 'HOST_SPONSORED_PASS');
    assert.equal(pass.hostBillableSeat, true, 'the pass is the one licence the host pays for');
    const none = resolveControllerLicence({ accessClass: 'CONTROLLER', ...base });
    assert.equal(none.controllerAccessAllowed, false);
    assert.equal(none.reasonCode, 'CONTROLLER_LICENCE_REQUIRED');
    assert.equal(none.hostBillableSeat, false, 'the prohibited shortcut — billable because Controller — is not taken');
  });

  it('derives the access class from the matrix: approvers of money and structure are Controllers, the site is not', () => {
    for (const role of ['ENTERPRISE_ADMIN', 'OWNER', 'EXECUTIVE', 'PROJECT_DIRECTOR', 'COMMERCIAL_MANAGER', 'QS', 'PM', 'PLANNER'] as const) {
      assert.equal(accessClassOf([role]), 'CONTROLLER', `${role} approves money, baselines or the business`);
    }
    for (const role of ['DESIGNER', 'BIM', 'SUPERVISOR', 'QAQC', 'SAFETY', 'FM', 'SUPPLIER', 'VIEWER'] as const) {
      assert.equal(accessClassOf([role]), 'PARTICIPANT', `${role} does the work and takes no seat`);
    }
    assert.equal(accessClassOf([]), 'PARTICIPANT');
    assert.equal(accessClassOf(['SUPERVISOR', 'PM']), 'CONTROLLER', 'one Controller role makes the set a Controller');
    assert.ok(TENANT_GRANTABLE_ROLES.every((role) => ['CONTROLLER', 'PARTICIPANT'].includes(accessClassOf([role]))));
  });

  it('words the badge as the requirement does', () => {
    assert.equal(LICENCE_BADGE_LABELS[licenceBadge({ accessClass: 'PARTICIPANT', relationship: 'EXTERNAL_INVITEE', licenceSource: 'NONE' })], 'Participant — No Seat Required');
    assert.equal(LICENCE_BADGE_LABELS[licenceBadge({ accessClass: 'CONTROLLER', relationship: 'EXTERNAL_INVITEE', licenceSource: 'HOME_ORGANISATION' })], 'Controller — Home Licensed');
    assert.equal(LICENCE_BADGE_LABELS[licenceBadge({ accessClass: 'CONTROLLER', relationship: 'GROUP_MEMBER', licenceSource: 'GROUP_ENTERPRISE' })], 'Controller — Group Licensed');
    assert.equal(LICENCE_BADGE_LABELS[licenceBadge({ accessClass: 'CONTROLLER', relationship: 'EXTERNAL_INVITEE', licenceSource: 'HOST_SPONSORED_PASS' })], 'Controller — Host Sponsored');
    assert.equal(LICENCE_BADGE_LABELS[licenceBadge({ accessClass: 'CONTROLLER', relationship: 'EXTERNAL_INVITEE', licenceSource: 'NONE' })], 'Controller — Licence Required');
    assert.equal(LICENCE_BADGE_LABELS[licenceBadge({ accessClass: 'CONTROLLER', relationship: 'EXTERNAL_INVITEE', licenceSource: 'NONE', lapsed: true })], 'Controller — Licence Expired');
  });
});

// --------------------------------------------------------------- scenarios

describe('SC-001 — an external participant', () => {
  it('is admitted on no seat, and the host billable count does not move', () => {
    const before = platform.subscription(host.tenantId).assignedIdentities.length;
    const sent = invite({ name: 'Dev Patel', email: 'dev@abc-engineering.example', roles: ['DESIGNER'] });
    assert.equal(sent.licence.accessClass, 'PARTICIPANT');
    assert.equal(sent.licence.source, 'NONE');
    assert.equal(sent.licence.hostBillableSeat, false);
    assert.equal(sent.licence.relationship, 'EXTERNAL_INVITEE');
    const membership = membershipOf(platform, sent.membershipId);
    assert.equal(membership.homeOrganisation.tenantId, abc.tenantId, 'the home organisation is found from the email');
    assert.equal(membership.homeOrganisation.name, 'ABC Engineering Ltd');
    assert.equal(membership.status, 'PENDING');

    const accepted = invitation.acceptInvitation(platform, hostCtx(host.pm), { invitationId: sent.invitationId });
    const user = platform.user(accepted.userId);
    assert.equal(user.external, true);
    assert.equal(user.homeTenantId, abc.tenantId);
    assert.deepEqual(user.roles, ['DESIGNER']);
    assert.equal(platform.subscription(host.tenantId).assignedIdentities.length, before, 'no host seat was taken');
    assert.equal(membershipOf(platform, sent.membershipId).status, 'ACTIVE');
    assert.equal(membershipOf(platform, sent.membershipId).userId, user.id);
  });
});

describe('SC-002 / AC-002 — an externally licensed Controller', () => {
  let membershipId: string;
  let janeAtHost: string;

  it('is verified against the seat ABC pays for, and the host is not charged', () => {
    const before = platform.subscription(host.tenantId).assignedIdentities.length;
    const preview = previewLicence(platform, { email: 'jane@abc-engineering.example', hostTenantId: host.tenantId, projectId: host.projectId, external: true }, ['QS']);
    assert.equal(preview.verdict, 'Controller licence verified');
    assert.equal(preview.hostBillableSeat, false);
    assert.equal(preview.licenceSource, 'HOME_ORGANISATION');
    // What the host may know of ABC: its name. Not its package, not its bill.
    assert.deepEqual(Object.keys(preview).sort(), ['accessClass', 'badge', 'controllerRoles', 'homeOrganisation', 'hostBillableSeat', 'licenceSource', 'reasonCode', 'relationship', 'verdict']);

    const sent = invite({ name: 'Jane Smith', email: 'jane@abc-engineering.example', roles: ['QS'] });
    membershipId = sent.membershipId;
    assert.equal(sent.licence.source, 'HOME_ORGANISATION');
    assert.equal(sent.licence.reasonCode, 'HOME_CONTROLLER_SEAT_VERIFIED');
    assert.deepEqual(sent.licence.withheldRoles, []);
    const membership = membershipOf(platform, membershipId);
    assert.equal(membership.licence.ownerTenantId, abc.tenantId, 'the licence is linked to the home organisation');
    assert.equal(membership.licence.ownerUserId, abc.jane);
    assert.ok(platform.ledger.events({ tenantId: host.tenantId }).some((event) => event.eventType === 'HOME_CONTROLLER_LICENCE_VERIFIED' && event.entity.refId === membershipId));

    janeAtHost = invitation.acceptInvitation(platform, hostCtx(host.pm), { invitationId: sent.invitationId }).userId;
    assert.deepEqual(platform.user(janeAtHost).roles, ['QS'], 'Controller access is active');
    assert.equal(platform.subscription(host.tenantId).assignedIdentities.length, before, 'no host seat');
    assert.equal(platform.subscription(abc.tenantId).assignedIdentities.filter((id) => id === abc.jane).length, 1, 'one seat at home, unchanged');
  });

  it('holds the same person on several projects on one seat (SC-006 / AC-009)', () => {
    const hostBefore = platform.subscription(host.tenantId).assignedIdentities.length;
    const sent = invite({ name: 'Jane Smith', email: 'jane@abc-engineering.example', roles: ['QS', 'PLANNER'] }, host.second);
    assert.equal(sent.licence.source, 'HOME_ORGANISATION');
    const accepted = invitation.acceptInvitation(platform, hostCtx(host.pm, host.second), { invitationId: sent.invitationId });
    assert.equal(accepted.userId, janeAtHost, 'the same identity, a second membership');
    assert.equal(membershipsOfUser(platform, host.tenantId, janeAtHost).filter((m) => m.status === 'ACTIVE').length, 2);
    assert.deepEqual([...platform.user(janeAtHost).roles].sort(), ['PLANNER', 'QS'], 'the roles are the union of the memberships');
    assert.equal(platform.subscription(host.tenantId).assignedIdentities.length, hostBefore);
    assert.equal(platform.subscription(abc.tenantId).assignedIdentities.filter((id) => id === abc.jane).length, 1);
    // A third invitation onto a project she already holds is a change, not a seat.
    throwsCode(() => invite({ name: 'Jane Smith', email: 'jane@abc-engineering.example', roles: ['QS'] }, host.second), 'ALREADY_A_MEMBER');
    // No pass may be bought for somebody already licensed: that is the duplicate charge.
    throwsCode(() => purchasePass(platform, hostCtx(host.admin), { membershipId, expiresAt: soon(30), reason: 'Trying to pay twice for Jane' }), 'DUPLICATE_SEAT_BILLING_DETECTED');
  });

  it('scopes an external identity to the projects its memberships name (SEC-002)', () => {
    const jane = authOf(platform, janeAtHost);
    assert.ok(platform.context(jane, host.projectId, { source: 'WEB' }));
    assert.ok(platform.context(jane, host.second, { source: 'WEB' }));
    assert.ok(platform.context(jane, `${host.tenantId}-governance`, { source: 'WEB' }), 'the tenancy scope, for the person’s own account');
    const other = platform.ledger.entitiesOfType('Project').find((record) => record.tenantId === host.tenantId && record.state.id !== host.projectId && record.state.id !== host.second);
    if (other) throwsCode(() => platform.context(jane, String(other.state.id), { source: 'WEB' }), 'PROJECT_PERMISSION_DENIED');
    throwsCode(() => platform.context(jane, 'no-such-project', { source: 'WEB' }), 'PROJECT_PERMISSION_DENIED');
  });

  it('shows the host the members table with licence source, seat owner and billability', () => {
    const rows = platform.ledger.listByTenant(host.tenantId, 'ProjectMembership');
    assert.ok(rows.length >= 3);
    const dashboard = seatDashboard(platform, host.tenantId);
    assert.equal(dashboard.externallyLicensedControllers >= 2, true);
    assert.equal(dashboard.externalParticipants >= 1, true);
    assert.equal(dashboard.hostSponsoredPasses, 0);
    assert.equal(dashboard.totalHostBillableLicences, dashboard.hostOwnedControllerSeats, 'externally licensed people are not in the billable total');
  });
});

describe('SC-003 / AC-003 — a group-portable Controller', () => {
  it('is covered by the seat held at the group company, with no seat at the host', () => {
    const before = platform.subscription(host.tenantId).assignedIdentities.length;
    const sent = invite({ name: 'Kemi Adeyemi', email: 'kemi@jn-construction.example', roles: ['PM'] });
    assert.equal(sent.licence.relationship, 'GROUP_MEMBER');
    assert.equal(sent.licence.source, 'GROUP_ENTERPRISE');
    assert.equal(sent.licence.hostBillableSeat, false);
    assert.ok(platform.ledger.events({ tenantId: host.tenantId }).some((event) => event.eventType === 'GROUP_CONTROLLER_LICENCE_VERIFIED' && event.entity.refId === sent.membershipId));
    const accepted = invitation.acceptInvitation(platform, hostCtx(host.pm), { invitationId: sent.invitationId });
    assert.deepEqual(platform.user(accepted.userId).roles, ['PM']);
    assert.equal(platform.subscription(host.tenantId).assignedIdentities.length, before);
    assert.equal(seatDashboard(platform, host.tenantId).groupLicensedControllers, 1);
  });
});

describe('SC-004 / AC-004 — an unlicensed external Controller', () => {
  let membershipId: string;
  let userId: string;

  it('has the Controller roles withheld and nothing bought on anybody’s behalf', () => {
    const before = platform.subscription(host.tenantId).assignedIdentities.length;
    const preview = previewLicence(platform, { email: 'consultant@independent.example', hostTenantId: host.tenantId, projectId: host.projectId, external: true, organisation: 'Independent Consulting' }, ['PM', 'SUPERVISOR']);
    assert.equal(preview.verdict, 'Controller licence required');
    assert.deepEqual(preview.controllerRoles, ['PM']);

    const sent = invite({ name: 'Ola Consultant', email: 'consultant@independent.example', roles: ['PM', 'SUPERVISOR'], organisation: 'Independent Consulting' });
    membershipId = sent.membershipId;
    assert.equal(sent.licence.reasonCode, 'CONTROLLER_LICENCE_REQUIRED');
    assert.deepEqual(sent.licence.withheldRoles, ['PM']);
    const membership = membershipOf(platform, membershipId);
    assert.deepEqual(membership.activeRoles, ['SUPERVISOR'], 'admitted as a participant');
    assert.equal(membership.homeOrganisation.tenantId, null, 'an organisation that is only a name');
    assert.ok(platform.ledger.events({ tenantId: host.tenantId }).some((event) => event.eventType === 'CONTROLLER_PERMISSION_REQUESTED' && event.entity.refId === membershipId));

    userId = invitation.acceptInvitation(platform, hostCtx(host.pm), { invitationId: sent.invitationId }).userId;
    assert.deepEqual(platform.user(userId).roles, ['SUPERVISOR'], 'the Controller role stays inactive');
    assert.equal(platform.subscription(host.tenantId).assignedIdentities.length, before, 'no automatic seat purchase');
    assert.equal(platform.ledger.listByTenant(host.tenantId, 'ControllerPass').length, 0);
  });

  it('SC-005 / AC-005 — a host-sponsored pass activates the roles, bills the host, and stops with revocation', () => {
    // Only somebody with authority over the host's money may buy one.
    throwsCode(() => purchasePass(platform, hostCtx(host.pm), { membershipId, expiresAt: soon(60), reason: 'The PM cannot spend the money' }), 'ACCESS_DENIED');
    throwsCode(() => purchasePass(platform, hostCtx(host.admin), { membershipId, expiresAt: soon(400), reason: 'Longer than a pass may run' }), 'PASS_EXPIRY_INVALID');

    const chargeBefore = collection.raiseCharge(platform, host.tenantId, new Date(Date.parse(platform.subscription(host.tenantId).renewsAt) + DAY));
    const { pass, membership } = purchasePass(platform, hostCtx(host.admin), { membershipId, expiresAt: soon(60), reason: 'Ola runs the tender comparison for Project Alpha until the award' });
    assert.equal(pass.status, 'ACTIVE');
    assert.equal(pass.monthlyPriceMinor, CONTROLLER_PASS.monthlyPriceMinor);
    assert.equal(membership.licence.source, 'HOST_SPONSORED_PASS');
    assert.equal(membership.licence.hostBillableSeat, true);
    assert.deepEqual(membership.withheldRoles, []);
    assert.deepEqual([...platform.user(userId).roles].sort(), ['PM', 'SUPERVISOR'], 'the Controller role is active now');
    assert.equal(platform.subscription(host.tenantId).assignedIdentities.includes(userId), false, 'still not one of the package’s seats');

    // On the invoice as its own line, and in the recurring charge.
    const invoice = platform.previewInvoice(host.tenantId, new Date().toISOString().slice(0, 7));
    const lines = invoice.lines.filter((line) => line.category === 'CONTROLLER_PASSES');
    assert.equal(lines.length, 1);
    assert.match(lines[0]!.description, /Project Controller Pass — Ola Consultant/);
    assert.equal(invoice.passesMinor, CONTROLLER_PASS.monthlyPriceMinor);
    assert.equal(invoice.totalMinor, invoice.subscriptionMinor + invoice.seatsMinor + invoice.storageMinor + CONTROLLER_PASS.monthlyPriceMinor);
    assert.equal(seatDashboard(platform, host.tenantId).hostSponsoredPasses, 1);
    assert.equal(seatDashboard(platform, host.tenantId).totalHostBillableLicences, seatDashboard(platform, host.tenantId).hostOwnedControllerSeats + 1);
    if (chargeBefore && !chargeBefore.alreadyRaised) {
      // The period already raised does not change; the next one carries the pass.
      assert.ok(chargeBefore.charge.amountMinor >= PACKAGES[platform.subscription(host.tenantId).package].monthlyPriceMinor);
    }

    // A second pass for the same person is the duplicate charge the rule forbids.
    throwsCode(() => purchasePass(platform, hostCtx(host.admin), { membershipId, expiresAt: soon(30), reason: 'Buying the same thing twice' }), 'DUPLICATE_SEAT_BILLING_DETECTED');

    // Ending it withdraws the authority and the charge.
    const ended = revokePass(platform, hostCtx(host.admin), { passId: pass.id, reason: 'Award made; the comparison is done' });
    assert.equal(ended.pass.status, 'REVOKED');
    assert.equal(ended.membership.licence.reasonCode, 'CONTROLLER_LICENCE_LAPSED');
    assert.deepEqual(ended.membership.withheldRoles, ['PM']);
    assert.deepEqual(platform.user(userId).roles, ['SUPERVISOR']);
    assert.equal(platform.previewInvoice(host.tenantId, new Date().toISOString().slice(0, 7)).passesMinor, 0);
    assert.equal(LICENCE_BADGE_LABELS[licenceBadge({ accessClass: 'CONTROLLER', relationship: 'EXTERNAL_INVITEE', licenceSource: 'NONE', lapsed: true })], 'Controller — Licence Expired');
  });

  it('reducing to participant removes every future Controller liability', () => {
    const reduced = changePermissions(platform, hostCtx(host.admin), { membershipId, roles: ['SUPERVISOR'], reason: 'Ola stays on as site support only' });
    assert.equal(reduced.accessClass, 'PARTICIPANT');
    assert.equal(reduced.licence.hostBillableSeat, false);
    assert.deepEqual(reduced.withheldRoles, []);
    assert.ok(platform.ledger.events({ tenantId: host.tenantId }).some((event) => event.eventType === 'PERMISSION_DOWNGRADED' && event.entity.refId === membershipId));
    throwsCode(() => purchasePass(platform, hostCtx(host.admin), { membershipId, expiresAt: soon(30), reason: 'Nothing to buy for a participant' }), 'PROJECT_PASS_NOT_REQUIRED');
    // And back up: the request runs the resolution again and withholds.
    const upgraded = changePermissions(platform, hostCtx(host.admin), { membershipId, roles: ['PM', 'SUPERVISOR'], reason: 'Ola takes the programme after all' });
    assert.deepEqual(upgraded.withheldRoles, ['PM']);
    assert.equal(upgraded.licence.reasonCode, 'CONTROLLER_LICENCE_REQUIRED');
    assert.deepEqual(platform.user(userId).roles, ['SUPERVISOR']);
    throwsCode(() => changePermissions(platform, hostCtx(host.admin), { membershipId, roles: ['ENTERPRISE_ADMIN'], reason: 'An outsider administering the tenancy' }), 'EXTERNAL_CANNOT_ADMINISTER');
  });

  it('AC-010 — revocation ends access at once, keeps the record, and blocks further AI', () => {
    const revoked = revokeMembership(platform, hostCtx(host.admin), { membershipId, reason: 'Appointment ended early' });
    assert.equal(revoked.status, 'REVOKED');
    assert.equal(platform.user(userId).status, 'SUSPENDED', 'the identity is deactivated: this was its only project');
    assert.equal(platform.user(userId).name, 'Ola Consultant', 'nothing is removed');
    throwsCode(() => platform.context(authOf(platform, userId), host.projectId, { source: 'WEB' }), 'IDENTITY_DEACTIVATED');
    throwsCode(() => changePermissions(platform, hostCtx(host.admin), { membershipId, roles: ['SUPERVISOR'], reason: 'Changing an ended membership' }), 'MEMBERSHIP_ENDED');
  });
});

// -------------------------------------------------------------- ACU money

describe('AC-006 / AC-007 — who pays for an external Controller’s AI', () => {
  let membership: ReturnType<typeof membershipOf>;
  let jane: ReturnType<typeof authOf>;
  let homeSponsorship: string;

  /** An engine that runs in the project's current phase, so the refusal under test is the money's and not the phase's. */
  let engine: Engine;

  before(() => {
    const janeAtHost = platform.users(host.tenantId).find((user) => user.email === 'jane@abc-engineering.example' && user.external)!;
    jane = authOf(platform, janeAtHost.id);
    membership = membershipsOfUser(platform, host.tenantId, janeAtHost.id).find((m) => m.projectId === host.projectId)!;
    const phase = String(platform.ledger.get({ refType: 'Project', refId: host.projectId })!.state.phase);
    engine = (Object.keys(ENGINE_CONTRACTS) as Engine[]).find((candidate) => engineActiveIn(candidate, phase as never))!;
  });

  it('funds nothing until somebody agrees to pay, and never the host by default', async () => {
    const ctx = platform.context(jane, host.projectId, { source: 'WEB' });
    assert.ok(ctx.acu, 'an external member carries the sponsor resolution');
    const position = ctx.acu!.resolve({ engine: 'PLANNING' });
    assert.equal(position.ok, false);
    if (!position.ok) assert.equal(position.code, 'ACU_SPONSOR_REQUIRED');
    throwsCode(() => chargeableWallet(ctx), 'ACU_SPONSOR_REQUIRED');
    throwsCode(() => platform.spendingWalletFor(jane, host.projectId), 'ACU_SPONSOR_REQUIRED');
    await rejectsCode(
      () => runAI(ctx, { engine, taskType: 'forecast', capability: 'REASONING', inputRefs: [], request: { task: 'forecast', payload: {} }, toWrites: () => [] }),
      'ACU_SPONSOR_REQUIRED',
    );
    // The host cannot approve on ABC's behalf: a request to ABC waits.
    const requested = requestSponsorship(platform, hostCtx(host.pm), { membershipId: membership.id, sponsorType: 'HOME_ORGANISATION', authorisationType: 'MONTHLY_ALLOWANCE', maximumMinor: 2_000, reason: 'Routine tender analysis on Project Alpha each month' });
    homeSponsorship = requested.id;
    assert.equal(requested.status, 'PENDING');
    assert.equal(requested.tenantId, abc.tenantId, 'on the sponsor’s own chain');
    const waiting = platform.context(jane, host.projectId, { source: 'WEB' }).acu!.resolve({ engine: 'PLANNING' });
    assert.equal(waiting.ok, false);
    if (!waiting.ok) assert.equal(waiting.code, 'ACU_SPONSOR_APPROVAL_REQUIRED');
    // And a host person cannot decide it.
    throwsCode(() => decideSponsorship(platform, hostCtx(host.admin), { sponsorshipId: homeSponsorship, approve: true, reason: 'The host approving the other side’s money' }), 'NOT_FOUND');
  });

  it('charges the home wallet once ABC approves, and the host wallet not at all', () => {
    const abcCtx = platform.context(authOf(platform, abc.admin), `${abc.tenantId}-governance`, { source: 'WEB' });
    const approved = decideSponsorship(platform, abcCtx, { sponsorshipId: homeSponsorship, approve: true, maximumMinor: 1_500, reason: 'Approved for the Alpha tender, capped' });
    assert.equal(approved.status, 'ACTIVE');
    assert.equal(approved.maximumMinor, 1_500);
    assert.equal(membershipOf(platform, membership.id).acu.defaultSponsor, 'HOME_ORGANISATION');
    assert.ok(platform.ledger.events({ tenantId: host.tenantId }).some((event) => event.eventType === 'BILLING_RESPONSIBILITY_CHANGED' && event.entity.refId === membership.id));

    const ctx = platform.context(jane, host.projectId, { source: 'WEB' });
    const funded = ctx.acu!.resolve({ engine: 'PLANNING' });
    assert.equal(funded.ok, true);
    if (!funded.ok) return;
    assert.equal(funded.sponsorTenantId, abc.tenantId);
    assert.equal(funded.wallet.tenantId, abc.tenantId);
    assert.equal(ctx.wallet.tenantId, abc.tenantId, 'the context spends from ABC');
    assert.equal(chargeableWallet(ctx).tenantId, abc.tenantId);

    // A charge under the sponsorship lands in ABC's wallet, against the host's project.
    const hostBefore = platform.wallet(host.tenantId).snapshot().balanceMinor;
    const abcBefore = funded.wallet.snapshot().balanceMinor;
    const hold = funded.wallet.reserve({ aiRequestId: 'req-1', estimatedRawCostMinor: 40, projectId: host.projectId, userId: jane.actorId, module: 'PLANNING', feature: 'forecast', sponsorshipId: funded.sponsorship.id });
    funded.wallet.settle(hold.holdId, 40, 'LOCAL');
    assert.equal(platform.wallet(host.tenantId).snapshot().balanceMinor, hostBefore, 'the host wallet is untouched');
    assert.ok(funded.wallet.snapshot().balanceMinor < abcBefore, 'ABC paid');
    const usage = usageOf(platform, approved);
    assert.equal(usage.consumedMinor, 200, '40 raw at the 5× multiplier');
    assert.equal(usage.remainingMinor, 1_300);
    assert.equal(funded.wallet.entries({ projectId: host.projectId, userId: jane.actorId }).filter((entry) => entry.type === 'DEBIT' && entry.sponsorshipId === approved.id).length, 1, 'the spend names the sponsorship and the host project');
  });

  it('refuses beyond the approved limit, and a host one-time authorisation takes precedence for its engine', async () => {
    const abcCtx = platform.context(authOf(platform, abc.admin), `${abc.tenantId}-governance`, { source: 'WEB' });
    // The limit is changed on the record: the remaining allowance is what the estimate is judged against.
    const tightened = decideSponsorship(platform, abcCtx, { sponsorshipId: homeSponsorship, approve: true, maximumMinor: 201, reason: 'Tightened to what is left' });
    assert.equal(tightened.previousMaximumMinor, 1_500);
    assert.equal(usageOf(platform, tightened).remainingMinor, 1);
    const ctx = platform.context(jane, host.projectId, { source: 'WEB' });
    await rejectsCode(
      () => runAI(ctx, { engine, taskType: 'forecast', capability: 'REASONING', inputRefs: [], request: { task: 'forecast', payload: {} }, toWrites: () => [] }),
      'ACU_LIMIT_EXCEEDED',
    );

    // The host authorises one engine, on its own wallet: that engine is funded by the host.
    platform.creditFromPayment({ tenantId: host.tenantId, amountMinor: 10_000, method: 'CARD', reference: 'HOST-TOPUP-1', recordedBy: host.admin.actorId, source: 'OPERATOR' });
    const oneTime = requestSponsorship(platform, hostCtx(host.admin), { membershipId: membership.id, sponsorType: 'HOST_ORGANISATION', authorisationType: 'ONE_TIME_EXECUTION', workflow: 'ESTIMATE', maximumMinor: 500, reason: 'The tender comparison, on us, up to 500 ACUs' });
    assert.equal(oneTime.status, 'ACTIVE', 'the host’s own money is approved in the act of raising it');
    const forEstimate = platform.context(jane, host.projectId, { source: 'WEB' }).acu!.resolve({ engine: 'ESTIMATE' });
    assert.equal(forEstimate.ok, true);
    if (forEstimate.ok) {
      assert.equal(forEstimate.sponsorTenantId, host.tenantId);
      assert.equal(forEstimate.sponsorType, 'ONE_TIME_AUTHORISATION');
      assert.equal(forEstimate.remainingMinor, 500);
    }
    const forPlanning = platform.context(jane, host.projectId, { source: 'WEB' }).acu!.resolve({ engine: 'PLANNING' });
    assert.equal(forPlanning.ok, true, 'the other engine still runs on ABC, within what is left');
    if (forPlanning.ok) assert.equal(forPlanning.sponsorTenantId, abc.tenantId);
    // A one-time authorisation does not move the default sponsor.
    assert.equal(membershipOf(platform, membership.id).acu.defaultSponsor, 'HOME_ORGANISATION');
    assert.equal(sponsorshipsFor(platform, membershipOf(platform, membership.id)).length, 2);
  });

  it('withdrawing the sponsorship releases what was held and stops further spend', () => {
    const abcCtx = platform.context(authOf(platform, abc.admin), `${abc.tenantId}-governance`, { source: 'WEB' });
    const wallet = platform.spendingWallet(abc.tenantId).wallet;
    const hold = wallet.reserve({ aiRequestId: 'req-2', estimatedRawCostMinor: 1, projectId: host.projectId, userId: jane.actorId, module: 'PLANNING', feature: 'forecast', sponsorshipId: homeSponsorship });
    assert.ok(wallet.openHolds().some((held) => held.holdId === hold.holdId));
    const revoked = revokeSponsorship(platform, abcCtx, { sponsorshipId: homeSponsorship, reason: 'ABC withdraws its allowance' });
    assert.equal(revoked.status, 'REVOKED');
    assert.ok(!wallet.openHolds().some((held) => held.holdId === hold.holdId), 'the hold was released');
    assert.equal(membershipOf(platform, membership.id).acu.defaultSponsor, 'NONE');
    const resolved = resolveAcu(platform, membershipOf(platform, membership.id), { engine: 'PLANNING' });
    assert.equal(resolved.ok, false);
    if (!resolved.ok) assert.equal(resolved.code, 'ACU_SPONSOR_REQUIRED');
  });
});

// ------------------------------------------------------------ the sweep

describe('expiry, on the hour', () => {
  it('ends an appointment past its date, expires its pass, and deactivates the identity', () => {
    const ends = soon(10);
    const sent = invite({ name: 'Short Term', email: 'short@term.example', roles: ['PM'], organisation: 'Short Term Ltd', expiresAt: ends });
    const userId = invitation.acceptInvitation(platform, hostCtx(host.pm), { invitationId: sent.invitationId }).userId;
    const { pass } = purchasePass(platform, hostCtx(host.admin), { membershipId: sent.membershipId, expiresAt: ends, reason: 'Ten days of programme control, on a pass' });
    assert.deepEqual([...platform.user(userId).roles].sort(), ['PM']);

    const nothingYet = sweepMemberships(platform);
    assert.ok(!nothingYet.expired.includes(sent.membershipId));

    const later = new Date(Date.now() + 11 * DAY);
    const outcome = sweepMemberships(platform, later);
    assert.ok(outcome.expired.includes(sent.membershipId));
    assert.equal(membershipOf(platform, sent.membershipId).status, 'EXPIRED');
    assert.equal(passOf(platform, pass.id).status, 'EXPIRED');
    assert.equal(platform.user(userId).status, 'SUSPENDED');
    assert.equal(seatDashboard(platform, host.tenantId, later).hostSponsoredPasses, 0);
    assert.deepEqual(sweepMemberships(platform, later).expired, [], 'idempotent: ended once');
    throwsCode(() => platform.context(authOf(platform, userId), host.projectId, { source: 'WEB' }), 'IDENTITY_DEACTIVATED');
  });

  it('withdraws a Controller’s authority when the seat at home goes, and grants it when one appears', () => {
    // A Controller at home, invited and verified; then the seat at home is released.
    const seated = platform.createUser({ tenantId: abc.tenantId, name: 'Temp Controller', email: 'temp@abc-engineering.example', roles: ['PLANNER'] });
    const sent = invite({ name: 'Temp Controller', email: 'temp@abc-engineering.example', roles: ['PLANNER'] });
    assert.equal(sent.licence.source, 'HOME_ORGANISATION');
    const userId = invitation.acceptInvitation(platform, hostCtx(host.pm), { invitationId: sent.invitationId }).userId;
    platform.deactivateUser(authOf(platform, abc.admin), { userId: seated.id, reason: 'Left ABC' });
    const lapsed = sweepMemberships(platform);
    assert.ok(lapsed.lapsed.includes(sent.membershipId));
    assert.equal(membershipOf(platform, sent.membershipId).licence.reasonCode, 'CONTROLLER_LICENCE_LAPSED');
    assert.deepEqual(platform.user(userId).roles, ['VIEWER'], 'nothing withheld leaves a viewer, never nothing');
    // The seat comes back at home: the next pass restores the roles without the host acting.
    platform.reactivateUser(authOf(platform, abc.admin), { userId: seated.id, reason: 'Back at ABC' });
    const restored = sweepMemberships(platform);
    assert.ok(!restored.lapsed.includes(sent.membershipId));
    assert.equal(membershipOf(platform, sent.membershipId).licence.source, 'HOME_ORGANISATION');
    assert.deepEqual(platform.user(userId).roles, ['PLANNER']);
  });
});

// ------------------------------------------------------------- over HTTP

describe('over HTTP', () => {
  it('invites, lists members with the badge, and keeps the host’s wallet from the guest', async () => {
    const pm = tokenFor(host.pm.actorId);
    // A person of ABC's, so the home organisation resolves to a tenancy with a wallet.
    platform.createUser({ tenantId: abc.tenantId, name: 'Http Guest', email: 'guest@abc-engineering.example', roles: ['DESIGNER'] });
    const sent = await call('POST', `/v1/projects/${host.projectId}/invitations`, pm, {
      name: 'Http Guest',
      email: 'guest@abc-engineering.example',
      roles: ['DESIGNER'],
      external: true,
      organisation: 'ABC Engineering Ltd',
      because: 'Design coordination for the substructure package.',
      expiresAt: soon(90),
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const licence = sent.body.licence as Record<string, unknown>;
    assert.equal(licence.accessClass, 'PARTICIPANT');
    assert.equal(licence.hostBillableSeat, false);

    const accepted = await call('POST', `/v1/projects/${host.projectId}/invitations/${sent.body.invitationId}/accept`, pm, {});
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));

    const members = await call('GET', `/v1/projects/${host.projectId}/members`, pm);
    assert.equal(members.status, 200);
    const row = (members.body.members as Array<Record<string, unknown>>).find((member) => member.email === 'guest@abc-engineering.example')!;
    assert.equal(row.badgeLabel, 'Participant — No Seat Required');
    assert.equal(row.organisation, 'ABC Engineering Ltd');
    assert.equal(row.status, 'ACTIVE');

    // The guest's own view of money: who pays, never the host's balance.
    const guestToken = tokenFor(String(accepted.body.userId));
    const wallet = await call('GET', '/v1/billing/wallet', guestToken);
    // A designer holds no read on billing; a Controller guest does and sees the sponsor position.
    assert.ok(wallet.status === 403 || (wallet.status === 200 && wallet.body.external === true && wallet.body.balanceMinor === undefined), JSON.stringify(wallet.body));

    // The guest cannot reach a project they are not a member of.
    const elsewhere = await call('GET', `/v1/projects/${host.second}/invitations`, guestToken);
    assert.equal(elsewhere.status, 403, JSON.stringify(elsewhere.body));
    assert.equal(elsewhere.body.title, 'PROJECT_PERMISSION_DENIED');

    const seats = await call('GET', '/v1/billing/seats', tokenFor(host.admin.actorId));
    assert.equal(seats.status, 200);
    const billable = seats.body.billable as { totalHostBillableLicences: number; hostOwnedControllerSeats: number; hostSponsoredPasses: number };
    assert.equal(billable.totalHostBillableLicences, billable.hostOwnedControllerSeats + billable.hostSponsoredPasses);
    assert.ok((seats.body.seatTypes as Array<{ controllerSeat: boolean }>).some((seat) => seat.controllerSeat === false));
  });

  it('lets the home organisation see and decide, and the host see only that the allowance stands', async () => {
    const pm = tokenFor(host.pm.actorId);
    const guest = platform.users(host.tenantId).find((user) => user.email === 'guest@abc-engineering.example')!;
    const membership = membershipsOfUser(platform, host.tenantId, guest.id)[0]!;
    const raised = await call('POST', '/v1/acu-sponsorships', pm, { membershipId: membership.id, sponsorType: 'HOME_ORGANISATION', authorisationType: 'PROJECT_ALLOWANCE', maximumMinor: 300, reason: 'Design checks on the substructure drawings' });
    assert.equal(raised.status, 201, JSON.stringify(raised.body));
    const sponsorship = raised.body.sponsorship as Record<string, unknown>;
    assert.equal(sponsorship.status, 'PENDING');

    const abcAdmin = tokenFor(abc.admin);
    const away = await call('GET', '/v1/users/external-projects', abcAdmin);
    assert.equal(away.status, 200, JSON.stringify(away.body));
    assert.ok((away.body.memberships as Array<Record<string, unknown>>).some((m) => m.membershipId === membership.id));
    assert.equal(away.body.awaitingDecision, 1);
    // What ABC sees of the host: its name and the project's, not its members or wallet.
    const listed = (away.body.memberships as Array<Record<string, unknown>>).find((m) => m.membershipId === membership.id)!;
    assert.deepEqual(Object.keys(listed).sort(), ['accessClass', 'expiresAt', 'hostName', 'licenceSource', 'membershipId', 'person', 'projectName', 'roles', 'sponsorships', 'startsAt', 'status']);

    const approved = await call('POST', `/v1/acu-sponsorships/${sponsorship.id}/approve`, abcAdmin, { maximumMinor: 250, reason: 'Approved, capped at 250' });
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    assert.equal(approved.body.status, 'ACTIVE');

    const hostView = await call('GET', `/v1/acu-sponsorships/${sponsorship.id}/usage`, tokenFor(host.admin.actorId));
    assert.equal(hostView.status, 200);
    assert.equal(hostView.body.standing, 'AVAILABLE');
    assert.equal((hostView.body.sponsorship as Record<string, unknown>).maximumMinor, undefined, 'the host is not told the size of ABC’s allowance');
    const homeView = await call('GET', `/v1/acu-sponsorships/${sponsorship.id}/usage`, abcAdmin);
    assert.equal((homeView.body.usage as Record<string, number>).maximumMinor, 250);

    // The host cannot approve on ABC's behalf.
    const forged = await call('POST', `/v1/acu-sponsorships/${sponsorship.id}/approve`, tokenFor(host.admin.actorId), { reason: 'Approving the other side’s money' });
    assert.equal(forged.status, 404, JSON.stringify(forged.body));
  });

  it('survives a restart: memberships, passes and the external flag come back from the journal', () => {
    const rebuilt = new Platform();
    rebuilt.ledger.restore(platform.ledger.events());
    rebuilt.rehydrate();
    const guest = rebuilt.users(host.tenantId).find((user) => user.email === 'guest@abc-engineering.example')!;
    assert.equal(guest.external, true);
    assert.equal(guest.homeTenantId, abc.tenantId);
    assert.equal(membershipsOfUser(rebuilt, host.tenantId, guest.id).length, 1);
    assert.equal(rebuilt.subscription(host.tenantId).assignedIdentities.length, platform.subscription(host.tenantId).assignedIdentities.length);
  });
});
