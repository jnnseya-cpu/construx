import { DomainError, ForbiddenError, NotFoundError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { CONTROLLER_PASS } from '../billing/seats.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import { groupOfTenant, membershipsByEmail } from '../group/directory.ts';
import {
  accessClassOf,
  controllerRolesOf,
  licenceBadge,
  resolveControllerLicence,
  type AccessClass,
  type AcuSponsorType,
  type LicenceBadge,
  type LicenceSource,
  type MembershipStatus,
  type OrganisationRelationship,
  type SeatResolutionReason,
} from '../identity/licence.ts';
import type { Role } from '../identity/roles.ts';
import type { Platform } from '../platform.ts';

/**
 * A person's appointment to a project, apart from the invitation that made it
 * and the identity that signs in.
 *
 * The invitation is an offer with a fortnight to live. The identity is what
 * authenticates and holds roles. The membership is the relationship between
 * the two and the host: which organisation the person is with, whether their
 * authority is a participant's or a Controller's, whose licence covers it,
 * whether the host pays anything for it, who pays for their AI, and when it
 * ends. Keeping it as its own record is what lets the same person hold a
 * dozen memberships on a dozen hosts' projects while consuming one seat at
 * home — the commercial rule `identity/licence.ts` states.
 *
 * Three consequences are enforced here rather than left to convention:
 *
 * - A membership never takes a host seat by being created. The only host
 *   seat an invitee can consume is the host's own package seat, and only when
 *   the invitee is the host's own Controller. Everybody else brings a licence
 *   or is a participant.
 * - Controller-level roles asked for with no licence to cover them are
 *   *withheld*: the person is admitted as a participant and the requested
 *   roles wait on the record until the host buys a pass, reduces them, or a
 *   licence turns up. Nothing elevates on its own.
 * - Everything that changes the host's bill or the person's authority is an
 *   event carrying what changed, who changed it, and the commercial
 *   consequence, so an invoice dispute can be answered from the chain.
 */

export type ProjectMembership = {
  id: string;
  /** The host tenancy. */
  tenantId: string;
  projectId: string;
  invitationId: string;
  /** The identity in the host tenancy, once the invitation is accepted. */
  userId: string | null;
  person: { name: string; email: string };
  /** The organisation the person belongs to: a tenancy on the platform, or a name. */
  homeOrganisation: { tenantId: string | null; name: string };
  relationship: OrganisationRelationship;
  /** The class of the roles *requested*. What is held is `activeRoles`. */
  accessClass: AccessClass;
  roles: Role[];
  /** What the identity actually holds: the requested roles less anything withheld. */
  activeRoles: Role[];
  /** Controller roles waiting on a licence decision. */
  withheldRoles: Role[];
  /** An external appointment opens one project; a home member holds the tenancy's ordinary scope. */
  scope: 'PROJECT' | 'TENANT';
  licence: {
    source: LicenceSource;
    ownerTenantId: string | null;
    ownerUserId: string | null;
    passId: string | null;
    reasonCode: SeatResolutionReason | 'CONTROLLER_LICENCE_LAPSED';
    hostBillableSeat: boolean;
    hostBillingReason: string;
    lapsedAt?: string;
  };
  acu: {
    /** Whose wallet the person's AI is charged to by default. NONE until a sponsorship is approved. */
    defaultSponsor: AcuSponsorType | 'NONE';
    sponsorTenantId: string | null;
  };
  /** The person on the host side who brought them on. */
  sponsorUserId: string;
  because: string;
  startsAt: string;
  expiresAt: string | null;
  status: MembershipStatus;
  statusReason?: string;
  createdAt: string;
  updatedAt: string;
};

export type ControllerPass = {
  id: string;
  tenantId: string;
  projectId: string;
  membershipId: string;
  person: { name: string; email: string };
  roles: Role[];
  monthlyPriceMinor: number;
  purchasedBy: string;
  purchasedAt: string;
  reason: string;
  startsAt: string;
  expiresAt: string;
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
  endedAt?: string;
  endedBy?: string;
  endedReason?: string;
};

/** What every membership event carries beside the record: the change itself. */
type Change = {
  event: string;
  at: string;
  by: string;
  reason: string;
  previous: Record<string, unknown>;
  next: Record<string, unknown>;
  /** The commercial consequence, in a sentence somebody reading the audit feed can act on. */
  consequence: string;
};

const MONTH = 30 * 86_400_000;

function asMembership(state: Record<string, unknown>): ProjectMembership {
  return state as unknown as ProjectMembership;
}

function asPass(state: Record<string, unknown>): ControllerPass {
  return state as unknown as ControllerPass;
}

// --- reads ---------------------------------------------------------------------

export function membershipOf(platform: Platform, membershipId: string): ProjectMembership {
  const record = platform.ledger.get({ refType: 'ProjectMembership', refId: membershipId });
  if (!record) throw new NotFoundError(`No project membership ${membershipId}`);
  return asMembership(record.state);
}

/** Every membership on a host tenancy, optionally for one project. */
export function membershipsOf(platform: Platform, tenantId: string, projectId?: string): ProjectMembership[] {
  return platform.ledger
    .listByTenant(tenantId, 'ProjectMembership')
    .map((record) => asMembership(record.state))
    .filter((membership) => projectId === undefined || membership.projectId === projectId);
}

/** The memberships an identity in a host tenancy holds. */
export function membershipsOfUser(platform: Platform, tenantId: string, userId: string): ProjectMembership[] {
  return membershipsOf(platform, tenantId).filter((membership) => membership.userId === userId);
}

/** Memberships across the estate whose home organisation is this tenancy — what its administrators must answer for. */
export function membershipsAwayFrom(platform: Platform, homeTenantId: string): ProjectMembership[] {
  return platform.ledger
    .entitiesOfType('ProjectMembership')
    .map((record) => asMembership(record.state))
    .filter((membership) => membership.homeOrganisation.tenantId === homeTenantId && membership.tenantId !== homeTenantId);
}

export function passOf(platform: Platform, passId: string): ControllerPass {
  const record = platform.ledger.get({ refType: 'ControllerPass', refId: passId });
  if (!record) throw new NotFoundError(`No Project Controller Pass ${passId}`);
  return asPass(record.state);
}

export function passesOf(platform: Platform, tenantId: string): ControllerPass[] {
  return platform.ledger.listByTenant(tenantId, 'ControllerPass').map((record) => asPass(record.state));
}

/** Passes the host is paying for right now: active and inside their window. */
export function activePasses(platform: Platform, tenantId: string, now = new Date()): ControllerPass[] {
  const at = now.toISOString();
  return passesOf(platform, tenantId).filter((pass) => pass.status === 'ACTIVE' && pass.startsAt <= at && pass.expiresAt > at);
}

/** What the active passes add to the host's month. */
export function passChargeMinor(platform: Platform, tenantId: string, now = new Date()): number {
  return activePasses(platform, tenantId, now).reduce((sum, pass) => sum + pass.monthlyPriceMinor, 0);
}

/** Whether a membership is live: active and inside its appointment. */
export function membershipInForce(membership: ProjectMembership, now = new Date()): boolean {
  return membership.status === 'ACTIVE' && (membership.expiresAt === null || membership.expiresAt > now.toISOString());
}

/** The seat badge the console shows for a membership. */
export function badgeOf(membership: ProjectMembership): LicenceBadge {
  return licenceBadge({
    accessClass: membership.accessClass,
    relationship: membership.relationship,
    licenceSource: membership.licence.source,
    lapsed: membership.licence.reasonCode === 'CONTROLLER_LICENCE_LAPSED',
  });
}

// --- licence verification -------------------------------------------------------

export type LicenceCheck = {
  relationship: OrganisationRelationship;
  homeOrganisation: { tenantId: string | null; name: string };
  hasValidHomeControllerSeat: boolean;
  hasValidGroupControllerSeat: boolean;
  hasValidHostProjectPass: boolean;
  /** The seat found, where one was. */
  seat: { tenantId: string; userId: string } | null;
  pass: ControllerPass | null;
};

/**
 * Where else this person exists, and whether a Controller seat covers them.
 *
 * A seat is valid when the person holds Controller-class roles in a tenancy
 * whose subscription is live and whose package counts them — the same test
 * `assignIdentity` applied when it seated them. Nothing about that tenancy's
 * subscription, invoice or balance is returned: the host learns "verified" or
 * "required", which is all the requirement allows it to see.
 */
export function checkLicence(
  platform: Platform,
  input: { email: string; hostTenantId: string; projectId: string; external: boolean; organisation?: string },
  now = new Date(),
): LicenceCheck {
  const email = input.email.trim().toLowerCase();
  const hostGroup = groupOfTenant(platform, input.hostTenantId);
  const inHostGroup = (tenantId: string) => hostGroup?.costCentres.some((centre) => centre.tenantId === tenantId) === true;

  const elsewhere = membershipsByEmail(platform, email).filter((membership) => membership.active && membership.tenantId !== input.hostTenantId);
  const seated = elsewhere.find((membership) => {
    const subscription = platform.subscription(membership.tenantId);
    return (
      subscription.status === 'ACTIVE' &&
      subscription.assignedIdentities.includes(membership.userId) &&
      accessClassOf(membership.roles as Role[]) === 'CONTROLLER'
    );
  });

  // Not external: the host's own person, and the host is home.
  if (!input.external) {
    return {
      relationship: 'HOME_MEMBER',
      homeOrganisation: { tenantId: input.hostTenantId, name: platform.tenant(input.hostTenantId).legalName },
      hasValidHomeControllerSeat: false,
      hasValidGroupControllerSeat: false,
      hasValidHostProjectPass: false,
      seat: null,
      pass: null,
    };
  }

  const groupMember = elsewhere.find((membership) => inHostGroup(membership.tenantId));
  const home = seated ?? groupMember ?? elsewhere[0];
  const homeOrganisation = home
    ? { tenantId: home.tenantId, name: home.companyName }
    : { tenantId: null, name: input.organisation?.trim() ?? '' };
  const relationship: OrganisationRelationship = groupMember ? 'GROUP_MEMBER' : 'EXTERNAL_INVITEE';

  const at = now.toISOString();
  const pass =
    passesOf(platform, input.hostTenantId).find(
      (candidate) => candidate.projectId === input.projectId && candidate.person.email === email && candidate.status === 'ACTIVE' && candidate.expiresAt > at,
    ) ?? null;

  const seatInGroup = seated !== undefined && inHostGroup(seated.tenantId);
  return {
    relationship,
    homeOrganisation,
    hasValidHomeControllerSeat: seated !== undefined && !seatInGroup,
    hasValidGroupControllerSeat: seatInGroup,
    hasValidHostProjectPass: pass !== null,
    seat: seated ? { tenantId: seated.tenantId, userId: seated.userId } : null,
    pass,
  };
}

/** The resolution as the invitation form previews it: verified or required, and nothing about the other organisation. */
export function previewLicence(platform: Platform, input: Parameters<typeof checkLicence>[1], roles: Role[], now = new Date()) {
  const check = checkLicence(platform, input, now);
  const accessClass = accessClassOf(roles);
  const resolution = resolveControllerLicence({ accessClass, ...check });
  // A home member's Controller is the host's own seat on the host's own
  // package: billable, and the ordinary case.
  const hostSeat = check.relationship === 'HOME_MEMBER' && accessClass === 'CONTROLLER';
  return {
    accessClass,
    relationship: check.relationship,
    homeOrganisation: check.homeOrganisation.name,
    licenceSource: hostSeat ? ('HOME_ORGANISATION' as const) : resolution.licenceSource,
    hostBillableSeat: hostSeat ? true : resolution.hostBillableSeat,
    reasonCode: hostSeat ? ('HOME_CONTROLLER_SEAT_VERIFIED' as const) : resolution.reasonCode,
    controllerRoles: controllerRolesOf(roles),
    verdict:
      accessClass === 'PARTICIPANT'
        ? 'No seat required'
        : hostSeat
          ? 'Takes one of this package’s seats'
          : resolution.controllerAccessAllowed
            ? 'Controller licence verified'
            : 'Controller licence required',
    badge: licenceBadge({ accessClass, relationship: check.relationship, licenceSource: hostSeat ? 'HOME_ORGANISATION' : resolution.licenceSource }),
  };
}

// --- writes ----------------------------------------------------------------------

/**
 * The membership events, as the catalogue names them, on the one writer's
 * signature: every other writer takes the same type, so nothing here can emit
 * an event the catalogue does not hold.
 */
function commitMembership(
  ctx: EngineContext,
  membership: ProjectMembership,
  eventType: 'PROJECT_MEMBERSHIP_ACTIVATED' | 'CONTROLLER_PERMISSION_REQUESTED' | 'HOME_CONTROLLER_LICENCE_VERIFIED' | 'GROUP_CONTROLLER_LICENCE_VERIFIED' | 'CONTROLLER_LICENCE_LAPSED' | 'PERMISSION_DOWNGRADED' | 'PERMISSION_UPGRADED' | 'MEMBERSHIP_SUSPENDED' | 'MEMBERSHIP_RESTORED' | 'MEMBERSHIP_EXPIRED' | 'MEMBERSHIP_REVOKED',
  change: Change,
): ProjectMembership {
  const next = { ...membership, updatedAt: change.at };
  write(ctx, {
    eventType,
    // On the project's own chain whichever context reaches it: a membership
    // is a fact about the project, and the ledger keeps an entity on one chain.
    projectId: membership.projectId,
    entity: { refType: 'ProjectMembership', refId: membership.id },
    nextState: { ...next, change } as unknown as Record<string, unknown>,
  });
  return next;
}

type MembershipEvent = Parameters<typeof commitMembership>[2];
type PassEvent = Parameters<typeof commitPass>[3];

/** The same write from platform machinery — the expiry sweep — under a system actor, on the host's chain. */
function commitBySystem(platform: Platform, membership: ProjectMembership, eventType: MembershipEvent, change: Change, actorId: string): ProjectMembership {
  const next = { ...membership, updatedAt: change.at };
  platform.ledger.commit({
    tenantId: membership.tenantId,
    projectId: membership.projectId,
    actor: { refType: 'System', refId: actorId },
    source: 'SYSTEM',
    correlationId: ulid(),
    eventType,
    entity: { refType: 'ProjectMembership', refId: membership.id },
    nextState: { ...next, change } as unknown as Record<string, unknown>,
  });
  return next;
}

function commitPass(ctx: EngineContext | null, platform: Platform, pass: ControllerPass, eventType: 'PROJECT_CONTROLLER_PASS_PURCHASED' | 'PROJECT_CONTROLLER_PASS_EXPIRED' | 'PROJECT_CONTROLLER_PASS_REVOKED', actorId: string): void {
  if (ctx) {
    write(ctx, { eventType, projectId: pass.projectId, entity: { refType: 'ControllerPass', refId: pass.id }, nextState: { ...pass } as unknown as Record<string, unknown> });
    return;
  }
  platform.ledger.commit({
    tenantId: pass.tenantId,
    projectId: pass.projectId,
    actor: { refType: 'System', refId: actorId },
    source: 'SYSTEM',
    correlationId: ulid(),
    eventType,
    entity: { refType: 'ControllerPass', refId: pass.id },
    nextState: { ...pass } as unknown as Record<string, unknown>,
  });
}

/**
 * Create the membership beside a new invitation, resolving the licence.
 *
 * The relationship and the licence are decided here, once, from the record:
 * the host's own person; somebody from a company of the same group; somebody
 * from outside. Controller roles with no licence behind them are withheld
 * and the request for them recorded, so the acceptance can admit the person
 * as a participant without anybody deciding to pay.
 */
export function createMembership(
  platform: Platform,
  ctx: EngineContext,
  input: {
    invitationId: string;
    name: string;
    email: string;
    roles: Role[];
    external: boolean;
    organisation?: string;
    because: string;
    expiresAt?: string;
    acuSponsor?: AcuSponsorType;
  },
  now = new Date(),
): { membership: ProjectMembership; holdsHostSeat: boolean } {
  const at = now.toISOString();
  const email = input.email.trim().toLowerCase();
  const check = checkLicence(platform, { email, hostTenantId: ctx.tenantId, projectId: ctx.projectId, external: input.external, organisation: input.organisation }, now);
  const accessClass = accessClassOf(input.roles);
  const controllerRoles = controllerRolesOf(input.roles);

  if (input.expiresAt !== undefined && input.expiresAt <= at) {
    throw new DomainError('MEMBERSHIP_EXPIRY_INVALID', 'The appointment has to end after today', 422, [
      { field: 'expiresAt', message: 'Choose a date in the future' },
    ]);
  }

  let licence: ProjectMembership['licence'];
  let withheld: Role[] = [];
  let holdsHostSeat = false;

  if (check.relationship === 'HOME_MEMBER') {
    // The host's own person: the package's seat, exactly as before this
    // module existed, for a Controller; nothing for a participant.
    holdsHostSeat = accessClass === 'CONTROLLER';
    licence = {
      source: 'HOME_ORGANISATION',
      ownerTenantId: ctx.tenantId,
      ownerUserId: null,
      passId: null,
      reasonCode: accessClass === 'CONTROLLER' ? 'HOME_CONTROLLER_SEAT_VERIFIED' : 'PARTICIPANT_SEAT_NOT_REQUIRED',
      hostBillableSeat: holdsHostSeat,
      hostBillingReason: holdsHostSeat ? 'A Controller of this organisation on this package’s own seats' : 'A participant takes no seat',
    };
  } else {
    const resolution = resolveControllerLicence({ accessClass, ...check });
    if (accessClass === 'CONTROLLER' && !resolution.controllerAccessAllowed) withheld = controllerRoles;
    licence = {
      source: resolution.licenceSource,
      ownerTenantId: resolution.licenceSource === 'HOST_SPONSORED_PASS' ? ctx.tenantId : (check.seat?.tenantId ?? null),
      ownerUserId: resolution.licenceSource === 'HOST_SPONSORED_PASS' ? null : (check.seat?.userId ?? null),
      passId: check.pass?.id ?? null,
      reasonCode: resolution.reasonCode,
      hostBillableSeat: resolution.hostBillableSeat,
      hostBillingReason:
        accessClass === 'PARTICIPANT'
          ? 'A participant takes no seat'
          : resolution.licenceSource === 'HOME_ORGANISATION'
            ? `Licensed by ${check.homeOrganisation.name}; nothing is charged here`
            : resolution.licenceSource === 'GROUP_ENTERPRISE'
              ? `Covered by the group’s seat held at ${check.homeOrganisation.name}; nothing is charged here`
              : resolution.licenceSource === 'HOST_SPONSORED_PASS'
                ? 'A Project Controller Pass this organisation bought'
                : 'Controller roles withheld: no licence covers them and nothing is charged until one is chosen',
    };
  }

  // Who pays for AI. A home member spends from the host as always. An external
  // person spends from nobody until a sponsorship is approved: the proposed
  // sponsor is recorded so the request can be raised, and nothing is funded by
  // proposing it.
  const acu: ProjectMembership['acu'] =
    check.relationship === 'HOME_MEMBER'
      ? { defaultSponsor: 'HOST_ORGANISATION', sponsorTenantId: ctx.tenantId }
      : { defaultSponsor: 'NONE', sponsorTenantId: null };

  const activeRoles = withheld.length > 0 ? participantRoles(input.roles) : input.roles;

  const membership: ProjectMembership = {
    id: ulid(),
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    invitationId: input.invitationId,
    userId: null,
    person: { name: input.name, email },
    homeOrganisation: check.homeOrganisation,
    relationship: check.relationship,
    accessClass,
    roles: input.roles,
    activeRoles,
    withheldRoles: withheld,
    scope: check.relationship === 'HOME_MEMBER' ? 'TENANT' : 'PROJECT',
    licence,
    acu,
    sponsorUserId: ctx.auth.actorId,
    because: input.because,
    startsAt: at,
    expiresAt: input.expiresAt ?? null,
    status: 'PENDING',
    createdAt: at,
    updatedAt: at,
  };

  write(ctx, {
    eventType: 'PROJECT_MEMBERSHIP_CREATED',
    projectId: membership.projectId,
    entity: { refType: 'ProjectMembership', refId: membership.id },
    nextState: { ...membership } as unknown as Record<string, unknown>,
  });

  // The licence facts as their own events, because they are the answer to
  // "why was this person not charged for" and have to be findable as such.
  const change = (event: string, consequence: string): Change => ({
    event,
    at,
    by: ctx.auth.actorId,
    reason: input.because,
    previous: {},
    next: { licence, accessClass, roles: input.roles },
    consequence,
  });
  if (withheld.length > 0) {
    commitMembership(ctx, membership, 'CONTROLLER_PERMISSION_REQUESTED', change('CONTROLLER_PERMISSION_REQUESTED', `${withheld.join(', ')} withheld until a licence is chosen; no seat charged`));
  } else if (licence.reasonCode === 'HOME_CONTROLLER_SEAT_VERIFIED' && check.relationship !== 'HOME_MEMBER') {
    commitMembership(ctx, membership, 'HOME_CONTROLLER_LICENCE_VERIFIED', change('HOME_CONTROLLER_LICENCE_VERIFIED', `Seat verified at ${check.homeOrganisation.name}; no host seat charged`));
  } else if (licence.reasonCode === 'GROUP_CONTROLLER_SEAT_VERIFIED') {
    commitMembership(ctx, membership, 'GROUP_CONTROLLER_LICENCE_VERIFIED', change('GROUP_CONTROLLER_LICENCE_VERIFIED', `Group seat verified at ${check.homeOrganisation.name}; no host seat charged`));
  }

  return { membership, holdsHostSeat };
}

/** The participant roles of a set, or a viewer where there are none: least privilege, never nothing. */
function participantRoles(roles: readonly Role[]): Role[] {
  const kept = roles.filter((role) => !controllerRolesOf([role]).length);
  return kept.length > 0 ? kept : ['VIEWER'];
}

/** The invitation was accepted: the membership is live and names the identity. */
export function activateMembership(platform: Platform, ctx: EngineContext, membershipId: string, userId: string, now = new Date()): ProjectMembership {
  const membership = membershipOf(platform, membershipId);
  if (membership.status !== 'PENDING') {
    throw new DomainError('MEMBERSHIP_NOT_PENDING', `That membership is already ${membership.status.toLowerCase()}`, 409);
  }
  const at = now.toISOString();
  return commitMembership(ctx, { ...membership, userId, status: 'ACTIVE', startsAt: at }, 'PROJECT_MEMBERSHIP_ACTIVATED', {
    event: 'PROJECT_MEMBERSHIP_ACTIVATED',
    at,
    by: ctx.auth.actorId,
    reason: 'Invitation accepted',
    previous: { status: membership.status, userId: null },
    next: { status: 'ACTIVE', userId },
    consequence: membership.licence.hostBillableSeat ? membership.licence.hostBillingReason : 'No host seat consumed',
  });
}

/** The invitation lapsed or was taken back: the membership never started. */
export function endPendingMembership(platform: Platform, ctx: EngineContext, membershipId: string, reason: string, now = new Date()): ProjectMembership {
  const membership = membershipOf(platform, membershipId);
  if (membership.status !== 'PENDING') return membership;
  const at = now.toISOString();
  return commitMembership(ctx, { ...membership, status: 'REVOKED', statusReason: reason }, 'MEMBERSHIP_REVOKED', {
    event: 'MEMBERSHIP_REVOKED',
    at,
    by: ctx.auth.actorId,
    reason,
    previous: { status: 'PENDING' },
    next: { status: 'REVOKED' },
    consequence: 'Nothing was charged and nothing is owed',
  });
}

/**
 * A licence decision for withheld Controller roles: buy a pass, or reduce
 * the roles to what a participant holds. The third option the requirement
 * names — asking the home organisation to buy a seat — is not an act on this
 * platform; it is a conversation, and the roles stay withheld until a seat
 * appears and the hourly check finds it.
 */
export function purchasePass(
  platform: Platform,
  ctx: EngineContext,
  input: { membershipId: string; expiresAt: string; reason: string },
  now = new Date(),
): { pass: ControllerPass; membership: ProjectMembership } {
  // Money: the same authority that buys a seat.
  authorise(ctx, 'BILLING_ACU', 'U');
  const membership = requireHostMembership(platform, ctx, input.membershipId);
  const at = now.toISOString();

  if (input.reason.trim().length < 10) throw new DomainError('REASON_REQUIRED', 'Say why the pass is being bought, in a sentence the invoice can carry');
  if (membership.accessClass !== 'CONTROLLER') {
    throw new DomainError('PROJECT_PASS_NOT_REQUIRED', `${membership.person.name} is a participant here and takes no seat. There is nothing to buy.`, 422);
  }
  if (membership.relationship === 'HOME_MEMBER') {
    throw new DomainError('PROJECT_PASS_NOT_REQUIRED', `${membership.person.name} is one of this organisation’s own people and holds a seat on this package. A pass is for somebody from outside.`, 422);
  }
  if (membership.licence.source === 'HOME_ORGANISATION' || membership.licence.source === 'GROUP_ENTERPRISE') {
    throw new DomainError(
      'DUPLICATE_SEAT_BILLING_DETECTED',
      `${membership.person.name} is already licensed by ${membership.homeOrganisation.name}. Buying a pass would charge twice for one person.`,
      409,
    );
  }
  if (membership.licence.source === 'HOST_SPONSORED_PASS' && membership.licence.passId && passOf(platform, membership.licence.passId).status === 'ACTIVE') {
    throw new DomainError('DUPLICATE_SEAT_BILLING_DETECTED', 'An active pass already covers this person on this project', 409);
  }
  if (!(input.expiresAt > at)) {
    throw new DomainError('PASS_EXPIRY_INVALID', 'A pass has to end after today', 422, [{ field: 'expiresAt', message: 'Choose a date in the future' }]);
  }
  if (Date.parse(input.expiresAt) - now.getTime() > CONTROLLER_PASS.maxMonths * MONTH) {
    throw new DomainError('PASS_EXPIRY_INVALID', `A pass runs for at most ${CONTROLLER_PASS.maxMonths} months; renew it deliberately after that`, 422, [
      { field: 'expiresAt', message: `At most ${CONTROLLER_PASS.maxMonths} months from today` },
    ]);
  }
  if (membership.expiresAt !== null && input.expiresAt > membership.expiresAt) {
    throw new DomainError('PASS_EXPIRY_INVALID', `The appointment ends on ${membership.expiresAt.slice(0, 10)}; a pass cannot outlast it`, 422, [
      { field: 'expiresAt', message: 'No later than the appointment’s end' },
    ]);
  }

  const pass: ControllerPass = {
    id: ulid(),
    tenantId: ctx.tenantId,
    projectId: membership.projectId,
    membershipId: membership.id,
    person: membership.person,
    roles: controllerRolesOf(membership.roles),
    monthlyPriceMinor: CONTROLLER_PASS.monthlyPriceMinor,
    purchasedBy: ctx.auth.actorId,
    purchasedAt: at,
    reason: input.reason,
    startsAt: at,
    expiresAt: input.expiresAt,
    status: 'ACTIVE',
  };
  commitPass(ctx, platform, pass, 'PROJECT_CONTROLLER_PASS_PURCHASED', ctx.auth.actorId);

  const previous = { licence: membership.licence, activeRoles: membership.activeRoles, withheldRoles: membership.withheldRoles };
  const licence: ProjectMembership['licence'] = {
    source: 'HOST_SPONSORED_PASS',
    ownerTenantId: ctx.tenantId,
    ownerUserId: null,
    passId: pass.id,
    reasonCode: 'HOST_PROJECT_PASS_VERIFIED',
    hostBillableSeat: true,
    hostBillingReason: `Project Controller Pass bought ${at.slice(0, 10)}, ${CONTROLLER_PASS.monthlyPriceMinor} a month until ${input.expiresAt.slice(0, 10)}`,
  };
  const updated = commitMembership(ctx, { ...membership, licence, activeRoles: membership.roles, withheldRoles: [] }, 'PERMISSION_UPGRADED', {
    event: 'PERMISSION_UPGRADED',
    at,
    by: ctx.auth.actorId,
    reason: input.reason,
    previous,
    next: { licence, activeRoles: membership.roles, withheldRoles: [] },
    consequence: `The host is charged ${CONTROLLER_PASS.monthlyPriceMinor} a month for the pass until it ends`,
  });
  if (updated.userId) platform.applyMembershipRoles(updated, `Project Controller Pass bought: ${input.reason}`, ctx.auth.actorId);
  return { pass, membership: updated };
}

export function revokePass(platform: Platform, ctx: EngineContext, input: { passId: string; reason: string }, now = new Date()): { pass: ControllerPass; membership: ProjectMembership } {
  authorise(ctx, 'BILLING_ACU', 'U');
  const pass = passOf(platform, input.passId);
  if (pass.tenantId !== ctx.tenantId) throw new NotFoundError(`No Project Controller Pass ${input.passId}`);
  if (pass.status !== 'ACTIVE') throw new DomainError('PASS_NOT_ACTIVE', `That pass is already ${pass.status.toLowerCase()}`, 409);
  if (input.reason.trim().length < 5) throw new DomainError('REASON_REQUIRED', 'Say why the pass is being revoked');
  const at = now.toISOString();
  const ended: ControllerPass = { ...pass, status: 'REVOKED', endedAt: at, endedBy: ctx.auth.actorId, endedReason: input.reason };
  commitPass(ctx, platform, ended, 'PROJECT_CONTROLLER_PASS_REVOKED', ctx.auth.actorId);
  const membership = lapseLicence(platform, ctx, membershipOf(platform, pass.membershipId), `Pass revoked: ${input.reason}`, ctx.auth.actorId, now);
  return { pass: ended, membership };
}

/**
 * The licence that covered a Controller has gone. The Controller roles are
 * withheld again, the person stays a participant, and the host is told what
 * it can do about it. Shared by revocation and the hourly check.
 */
function lapseLicence(platform: Platform, ctx: EngineContext | null, membership: ProjectMembership, reason: string, actorId: string, now: Date): ProjectMembership {
  const at = now.toISOString();
  const withheld = controllerRolesOf(membership.roles);
  const licence: ProjectMembership['licence'] = {
    source: 'NONE',
    ownerTenantId: null,
    ownerUserId: null,
    passId: null,
    reasonCode: 'CONTROLLER_LICENCE_LAPSED',
    hostBillableSeat: false,
    hostBillingReason: 'The licence that covered these Controller roles has lapsed; they are withheld and nothing is charged',
    lapsedAt: at,
  };
  const change: Change = {
    event: 'CONTROLLER_LICENCE_LAPSED',
    at,
    by: actorId,
    reason,
    previous: { licence: membership.licence, activeRoles: membership.activeRoles },
    next: { licence, activeRoles: participantRoles(membership.roles), withheldRoles: withheld },
    consequence: 'Controller authority withdrawn until a licence is chosen; pass billing, where there was one, stops',
  };
  const next = { ...membership, licence, activeRoles: participantRoles(membership.roles), withheldRoles: withheld };
  const updated = ctx ? commitMembership(ctx, next, 'CONTROLLER_LICENCE_LAPSED', change) : commitBySystem(platform, next, 'CONTROLLER_LICENCE_LAPSED', change, actorId);
  if (updated.userId && updated.status === 'ACTIVE') platform.applyMembershipRoles(updated, reason, actorId);
  return updated;
}

/**
 * Change what a member may do. An upgrade to Controller roles runs the same
 * resolution as an invitation and withholds what it cannot license; a
 * downgrade to participant ends the host's liability for a pass at once.
 */
export function changePermissions(
  platform: Platform,
  ctx: EngineContext,
  input: { membershipId: string; roles: Role[]; reason: string },
  now = new Date(),
): ProjectMembership {
  authorise(ctx, 'ENTERPRISE_STRUCTURE', 'G');
  const membership = requireHostMembership(platform, ctx, input.membershipId);
  if (input.roles.length === 0) throw new DomainError('INVITATION_ROLES_REQUIRED', 'Say what this person may do');
  if (input.reason.trim().length < 10) throw new DomainError('ROLE_CHANGE_UNEXPLAINED', 'Say why the roles are changing');
  if (membership.status === 'REVOKED' || membership.status === 'EXPIRED') {
    throw new DomainError('MEMBERSHIP_ENDED', `That membership is ${membership.status.toLowerCase()}; it cannot be changed`, 409);
  }
  if (membership.relationship !== 'HOME_MEMBER' && input.roles.some((role) => role === 'ENTERPRISE_ADMIN' || role === 'OWNER')) {
    throw new ForbiddenError('Those roles administer the tenancy and cannot be given to somebody outside the organisation', 'EXTERNAL_CANNOT_ADMINISTER');
  }
  const at = now.toISOString();
  const accessClass = accessClassOf(input.roles);
  const previous = { roles: membership.roles, activeRoles: membership.activeRoles, withheldRoles: membership.withheldRoles, licence: membership.licence, accessClass: membership.accessClass };

  let licence = membership.licence;
  let withheld: Role[] = [];
  let event: MembershipEvent = accessClass === 'CONTROLLER' && membership.accessClass === 'PARTICIPANT' ? 'PERMISSION_UPGRADED' : 'PERMISSION_DOWNGRADED';
  let consequence: string;

  if (accessClass === 'PARTICIPANT') {
    // Down to a participant: any pass is ended and the host stops paying.
    if (membership.licence.passId) {
      const pass = passOf(platform, membership.licence.passId);
      if (pass.status === 'ACTIVE') {
        commitPass(ctx, platform, { ...pass, status: 'REVOKED', endedAt: at, endedBy: ctx.auth.actorId, endedReason: `Reduced to participant: ${input.reason}` }, 'PROJECT_CONTROLLER_PASS_REVOKED', ctx.auth.actorId);
      }
    }
    licence = {
      source: membership.relationship === 'HOME_MEMBER' ? 'HOME_ORGANISATION' : 'NONE',
      ownerTenantId: membership.relationship === 'HOME_MEMBER' ? ctx.tenantId : null,
      ownerUserId: null,
      passId: null,
      reasonCode: 'PARTICIPANT_SEAT_NOT_REQUIRED',
      hostBillableSeat: false,
      hostBillingReason: 'A participant takes no seat',
    };
    event = 'PERMISSION_DOWNGRADED';
    consequence = membership.licence.hostBillableSeat ? 'The host’s seat or pass for this person is released; no further charge' : 'No change to what is charged';
  } else if (membership.relationship === 'HOME_MEMBER') {
    licence = {
      source: 'HOME_ORGANISATION',
      ownerTenantId: ctx.tenantId,
      ownerUserId: null,
      passId: null,
      reasonCode: 'HOME_CONTROLLER_SEAT_VERIFIED',
      hostBillableSeat: true,
      hostBillingReason: 'A Controller of this organisation on this package’s own seats',
    };
    consequence = 'Takes one of this package’s seats, refused if none is free';
  } else {
    const check = checkLicence(platform, { email: membership.person.email, hostTenantId: ctx.tenantId, projectId: membership.projectId, external: true, organisation: membership.homeOrganisation.name }, now);
    const resolution = resolveControllerLicence({ accessClass, ...check });
    if (!resolution.controllerAccessAllowed) withheld = controllerRolesOf(input.roles);
    licence = {
      source: resolution.licenceSource,
      ownerTenantId: resolution.licenceSource === 'HOST_SPONSORED_PASS' ? ctx.tenantId : (check.seat?.tenantId ?? null),
      ownerUserId: resolution.licenceSource === 'HOST_SPONSORED_PASS' ? null : (check.seat?.userId ?? null),
      passId: check.pass?.id ?? null,
      reasonCode: resolution.reasonCode,
      hostBillableSeat: resolution.hostBillableSeat,
      hostBillingReason: resolution.controllerAccessAllowed
        ? resolution.licenceSource === 'HOST_SPONSORED_PASS'
          ? 'A Project Controller Pass this organisation bought'
          : `Licensed by ${check.homeOrganisation.name}; nothing is charged here`
        : 'Controller roles withheld: no licence covers them and nothing is charged until one is chosen',
    };
    consequence = resolution.controllerAccessAllowed ? 'No host seat charged' : `${withheld.join(', ')} withheld until a licence is chosen; no seat charged`;
    if (!resolution.controllerAccessAllowed) event = 'CONTROLLER_PERMISSION_REQUESTED';
  }

  const activeRoles = withheld.length > 0 ? participantRoles(input.roles) : input.roles;
  const updated = commitMembership(ctx, { ...membership, roles: input.roles, activeRoles, withheldRoles: withheld, accessClass, licence }, event, {
    event,
    at,
    by: ctx.auth.actorId,
    reason: input.reason,
    previous,
    next: { roles: input.roles, activeRoles, withheldRoles: withheld, licence, accessClass },
    consequence,
  });
  if (updated.userId && updated.status === 'ACTIVE') platform.applyMembershipRoles(updated, input.reason, ctx.auth.actorId);
  return updated;
}

export function suspendMembership(platform: Platform, ctx: EngineContext, input: { membershipId: string; reason: string }, now = new Date()): ProjectMembership {
  authorise(ctx, 'ENTERPRISE_STRUCTURE', 'G');
  const membership = requireHostMembership(platform, ctx, input.membershipId);
  if (membership.status !== 'ACTIVE') throw new DomainError('MEMBERSHIP_NOT_ACTIVE', `That membership is ${membership.status.toLowerCase()}`, 409);
  if (input.reason.trim().length < 5) throw new DomainError('REASON_REQUIRED', 'Say why access is being suspended');
  const at = now.toISOString();
  const updated = commitMembership(ctx, { ...membership, status: 'SUSPENDED', statusReason: input.reason }, 'MEMBERSHIP_SUSPENDED', {
    event: 'MEMBERSHIP_SUSPENDED',
    at,
    by: ctx.auth.actorId,
    reason: input.reason,
    previous: { status: 'ACTIVE' },
    next: { status: 'SUSPENDED' },
    consequence: 'Access refused at once; a pass, where there is one, keeps running until restored or revoked',
  });
  platform.endProjectAccess(updated, `Suspended: ${input.reason}`, ctx.auth.actorId);
  return updated;
}

export function restoreMembership(platform: Platform, ctx: EngineContext, input: { membershipId: string; reason: string }, now = new Date()): ProjectMembership {
  authorise(ctx, 'ENTERPRISE_STRUCTURE', 'G');
  const membership = requireHostMembership(platform, ctx, input.membershipId);
  if (membership.status !== 'SUSPENDED') throw new DomainError('MEMBERSHIP_NOT_SUSPENDED', `That membership is ${membership.status.toLowerCase()}, not suspended`, 409);
  if (input.reason.trim().length < 5) throw new DomainError('REASON_REQUIRED', 'Say why access is being restored');
  const at = now.toISOString();
  if (membership.expiresAt !== null && membership.expiresAt <= at) {
    throw new DomainError('PROJECT_MEMBERSHIP_EXPIRED', `The appointment ended on ${membership.expiresAt.slice(0, 10)}; invite the person again rather than restoring it`, 409);
  }
  const updated = commitMembership(ctx, { ...membership, status: 'ACTIVE', statusReason: undefined }, 'MEMBERSHIP_RESTORED', {
    event: 'MEMBERSHIP_RESTORED',
    at,
    by: ctx.auth.actorId,
    reason: input.reason,
    previous: { status: 'SUSPENDED' },
    next: { status: 'ACTIVE' },
    consequence: 'Access resumes on the same licence and sponsor',
  });
  platform.restoreProjectAccess(updated, `Restored: ${input.reason}`, ctx.auth.actorId);
  return updated;
}

export function revokeMembership(platform: Platform, ctx: EngineContext, input: { membershipId: string; reason: string }, now = new Date()): ProjectMembership {
  authorise(ctx, 'ENTERPRISE_STRUCTURE', 'G');
  const membership = requireHostMembership(platform, ctx, input.membershipId);
  if (membership.status === 'REVOKED' || membership.status === 'EXPIRED') {
    throw new DomainError('MEMBERSHIP_ENDED', `That membership is already ${membership.status.toLowerCase()}`, 409);
  }
  if (input.reason.trim().length < 5) throw new DomainError('REASON_REQUIRED', 'Say why access is being revoked');
  return endMembership(platform, ctx, membership, 'REVOKED', input.reason, ctx.auth.actorId, now);
}

/** Ending, by revocation or expiry: access stops, the pass stops, holds are released, the record stays. */
function endMembership(platform: Platform, ctx: EngineContext | null, membership: ProjectMembership, status: 'REVOKED' | 'EXPIRED', reason: string, actorId: string, now: Date): ProjectMembership {
  const at = now.toISOString();
  if (membership.licence.passId) {
    const pass = passOf(platform, membership.licence.passId);
    if (pass.status === 'ACTIVE') {
      commitPass(ctx, platform, { ...pass, status: status === 'EXPIRED' ? 'EXPIRED' : 'REVOKED', endedAt: at, endedBy: actorId, endedReason: reason }, status === 'EXPIRED' ? 'PROJECT_CONTROLLER_PASS_EXPIRED' : 'PROJECT_CONTROLLER_PASS_REVOKED', actorId);
    }
  }
  const event: MembershipEvent = status === 'EXPIRED' ? 'MEMBERSHIP_EXPIRED' : 'MEMBERSHIP_REVOKED';
  const change: Change = {
    event,
    at,
    by: actorId,
    reason,
    previous: { status: membership.status, licence: membership.licence },
    next: { status },
    consequence: membership.licence.hostBillableSeat
      ? 'Access ended; the host’s seat or pass for this person is released and no further charge is raised'
      : 'Access ended; nothing was charged and nothing is owed. Everything the person recorded stays on the chain under their name',
  };
  const next = { ...membership, status, statusReason: reason };
  const updated = ctx ? commitMembership(ctx, next, event, change) : commitBySystem(platform, next, event, change, actorId);
  platform.endProjectAccess(updated, reason, actorId);
  return updated;
}

/**
 * The hourly pass over every membership: appointments that have ended,
 * passes that have run out, and external Controllers whose home seat is no
 * longer there. Idempotent — a membership ended once is not ended again.
 */
export function sweepMemberships(platform: Platform, now = new Date(), actorId = 'system:membership-sweep'): { expired: string[]; passesExpired: string[]; lapsed: string[] } {
  const at = now.toISOString();
  const outcome = { expired: [] as string[], passesExpired: [] as string[], lapsed: [] as string[] };
  for (const membership of platform.ledger.entitiesOfType('ProjectMembership').map((record) => asMembership(record.state))) {
    if (membership.status !== 'ACTIVE' && membership.status !== 'SUSPENDED' && membership.status !== 'PENDING') continue;
    if (membership.expiresAt !== null && membership.expiresAt <= at) {
      endMembership(platform, null, membership, 'EXPIRED', `The appointment ended on ${membership.expiresAt.slice(0, 10)}`, actorId, now);
      outcome.expired.push(membership.id);
      continue;
    }
    if (membership.status !== 'ACTIVE' || membership.relationship === 'HOME_MEMBER' || membership.accessClass !== 'CONTROLLER') continue;
    if (membership.licence.source === 'HOST_SPONSORED_PASS' && membership.licence.passId) {
      const pass = passOf(platform, membership.licence.passId);
      if (pass.status === 'ACTIVE' && pass.expiresAt <= at) {
        commitPass(null, platform, { ...pass, status: 'EXPIRED', endedAt: at, endedBy: actorId, endedReason: 'The pass ran out' }, 'PROJECT_CONTROLLER_PASS_EXPIRED', actorId);
        lapseLicence(platform, null, membership, `The Project Controller Pass ran out on ${pass.expiresAt.slice(0, 10)}`, actorId, now);
        outcome.passesExpired.push(pass.id);
      }
      continue;
    }
    if (membership.licence.source === 'HOME_ORGANISATION' || membership.licence.source === 'GROUP_ENTERPRISE') {
      const check = checkLicence(platform, { email: membership.person.email, hostTenantId: membership.tenantId, projectId: membership.projectId, external: true, organisation: membership.homeOrganisation.name }, now);
      if (!check.hasValidHomeControllerSeat && !check.hasValidGroupControllerSeat) {
        lapseLicence(platform, null, membership, `No Controller seat is held at ${membership.homeOrganisation.name} any more`, actorId, now);
        outcome.lapsed.push(membership.id);
      }
      continue;
    }
    if (membership.licence.source === 'NONE' && membership.withheldRoles.length > 0) {
      // A licence that has turned up since — the home organisation bought the
      // seat — lifts the withholding without anybody at the host acting.
      const check = checkLicence(platform, { email: membership.person.email, hostTenantId: membership.tenantId, projectId: membership.projectId, external: true, organisation: membership.homeOrganisation.name }, now);
      const resolution = resolveControllerLicence({ accessClass: 'CONTROLLER', ...check });
      if (resolution.controllerAccessAllowed && resolution.licenceSource !== 'HOST_SPONSORED_PASS') {
        const licence: ProjectMembership['licence'] = {
          source: resolution.licenceSource,
          ownerTenantId: check.seat?.tenantId ?? null,
          ownerUserId: check.seat?.userId ?? null,
          passId: null,
          reasonCode: resolution.reasonCode,
          hostBillableSeat: false,
          hostBillingReason: `Licensed by ${check.homeOrganisation.name}; nothing is charged here`,
        };
        const event: MembershipEvent = resolution.licenceSource === 'GROUP_ENTERPRISE' ? 'GROUP_CONTROLLER_LICENCE_VERIFIED' : 'HOME_CONTROLLER_LICENCE_VERIFIED';
        const updated = commitBySystem(platform, { ...membership, licence, activeRoles: membership.roles, withheldRoles: [] }, event, {
          event,
          at,
          by: actorId,
          reason: 'A Controller seat now covers this person',
          previous: { licence: membership.licence, withheldRoles: membership.withheldRoles },
          next: { licence, withheldRoles: [] },
          consequence: 'Withheld Controller roles granted; no host seat charged',
        }, actorId);
        if (updated.userId) platform.applyMembershipRoles(updated, 'Controller seat verified at the home organisation', actorId);
      }
    }
  }
  return outcome;
}

// --- the members table and the billing dashboard ----------------------------------

export type MemberRow = {
  membershipId: string;
  invitationId: string;
  userId: string | null;
  name: string;
  email: string;
  organisation: string;
  organisationTenantId: string | null;
  relationship: OrganisationRelationship;
  roles: Role[];
  activeRoles: Role[];
  withheldRoles: Role[];
  accessClass: AccessClass;
  licenceSource: LicenceSource;
  licenceReason: string;
  seatOwner: string | null;
  hostBillable: boolean;
  hostBillingReason: string;
  passId: string | null;
  acuSponsor: AcuSponsorType | 'NONE';
  acuSponsorName: string | null;
  startsAt: string;
  expiresAt: string | null;
  status: MembershipStatus;
  statusReason: string | null;
  badge: LicenceBadge;
};

export function memberRows(platform: Platform, tenantId: string, projectId?: string): MemberRow[] {
  const nameOf = (id: string | null) => (id ? (safeTenantName(platform, id) ?? id) : null);
  return membershipsOf(platform, tenantId, projectId)
    .map((membership) => ({
      membershipId: membership.id,
      invitationId: membership.invitationId,
      userId: membership.userId,
      name: membership.person.name,
      email: membership.person.email,
      organisation: membership.homeOrganisation.name,
      organisationTenantId: membership.homeOrganisation.tenantId,
      relationship: membership.relationship,
      roles: membership.roles,
      activeRoles: membership.activeRoles,
      withheldRoles: membership.withheldRoles,
      accessClass: membership.accessClass,
      licenceSource: membership.licence.source,
      licenceReason: membership.licence.reasonCode,
      seatOwner: nameOf(membership.licence.ownerTenantId),
      hostBillable: membership.licence.hostBillableSeat,
      hostBillingReason: membership.licence.hostBillingReason,
      passId: membership.licence.passId,
      acuSponsor: membership.acu.defaultSponsor,
      acuSponsorName: nameOf(membership.acu.sponsorTenantId),
      startsAt: membership.startsAt,
      expiresAt: membership.expiresAt,
      status: membership.status,
      statusReason: membership.statusReason ?? null,
      badge: badgeOf(membership),
    }))
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt));
}

function safeTenantName(platform: Platform, tenantId: string): string | undefined {
  try {
    return platform.tenant(tenantId).legalName;
  } catch {
    return undefined;
  }
}

/**
 * The billing dashboard's split between people and paid licences. Counted
 * from the record, never modelled: the host's own Controllers are the seats
 * the subscription holds, the passes are the ones in force, and the rest
 * are people who cost the host nothing.
 */
export function seatDashboard(platform: Platform, tenantId: string, now = new Date()) {
  const subscription = platform.subscription(tenantId);
  const people = platform.users(tenantId).filter((user) => user.status === 'ACTIVE' && !user.erasedAt);
  const memberships = membershipsOf(platform, tenantId).filter((membership) => membershipInForce(membership, now));
  const external = memberships.filter((membership) => membership.relationship !== 'HOME_MEMBER');
  const passes = activePasses(platform, tenantId, now);
  const internal = people.filter((user) => !user.external);
  const hostOwnedControllerSeats = subscription.assignedIdentities.filter((id) => people.some((user) => user.id === id)).length;
  return {
    totalActiveUsers: people.length,
    hostOwnedControllerSeats,
    internalParticipants: internal.filter((user) => !subscription.assignedIdentities.includes(user.id) && accessClassOf(user.roles) === 'PARTICIPANT').length,
    externalParticipants: external.filter((membership) => membership.accessClass === 'PARTICIPANT').length,
    externallyLicensedControllers: external.filter((membership) => membership.licence.source === 'HOME_ORGANISATION').length,
    groupLicensedControllers: external.filter((membership) => membership.licence.source === 'GROUP_ENTERPRISE').length,
    hostSponsoredPasses: passes.length,
    controllersAwaitingLicence: external.filter((membership) => membership.withheldRoles.length > 0).length,
    totalHostBillableLicences: hostOwnedControllerSeats + passes.length,
    passChargeMinor: passes.reduce((sum, pass) => sum + pass.monthlyPriceMinor, 0),
    formula: 'Host-owned Controller seats + active Project Controller Passes. Externally and group-licensed Controllers are not counted.',
  };
}

// --- helpers ---------------------------------------------------------------------------

function requireHostMembership(platform: Platform, ctx: EngineContext, membershipId: string): ProjectMembership {
  const membership = membershipOf(platform, membershipId);
  if (membership.tenantId !== ctx.tenantId) throw new NotFoundError(`No project membership ${membershipId}`);
  // The project in the path has to be the membership's own: a membership on
  // one project cannot be reached through another's route.
  if (ctx.projectId !== membership.projectId && ctx.projectId !== `${ctx.tenantId}-governance`) {
    throw new NotFoundError(`No project membership ${membershipId} on this project`);
  }
  return membership;
}

/** Whether a pending invitation is holding one of the host's package seats. */
export function holdsHostSeat(membership: Pick<ProjectMembership, 'relationship' | 'accessClass' | 'status'>): boolean {
  return membership.status === 'PENDING' && membership.relationship === 'HOME_MEMBER' && membership.accessClass === 'CONTROLLER';
}

