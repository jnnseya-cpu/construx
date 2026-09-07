import { DomainError, ForbiddenError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, write, type EngineContext } from '../engines/context.ts';
import { PERMISSION_MATRIX, type CapabilityArea, type Role } from '../identity/roles.ts';
import { accessClassOf, type AcuSponsorType } from '../identity/licence.ts';
import { PACKAGES } from '../billing/seats.ts';
import { purchasedSeats } from '../billing/subscription.ts';
import { activateMembership, createMembership, endPendingMembership, holdsHostSeat, membershipOf, membershipsOf } from './membership.ts';
import type { Platform } from '../platform.ts';

/**
 * Bringing somebody onto a project.
 *
 * A construction project is not staffed by one organisation. The designer, the
 * temporary works engineer, the client's representative, the specialist
 * subcontractor's own QS — every one of them needs to be on the job, and the
 * person who knows they are needed is the project manager or the engineer
 * working alongside them, not the enterprise administrator who has never heard
 * of them.
 *
 * Until now only an `ENTERPRISE_ADMIN` or `OWNER` could create a person at all,
 * so adding a designer for two weeks meant a request to head office. That is
 * the friction that gets solved by sharing a login, which is the failure this
 * exists to prevent: one credential, several people, and an audit trail that
 * attributes every act to whoever the account is named after.
 *
 * Three rules hold it together.
 *
 * **Who may invite is "somebody working on this project", not "somebody who can
 * see it".** A regulator reads everything and delivers nothing; a supplier
 * answers an enquiry. Neither should be able to add people to a customer's
 * project. The test is whether the inviter holds a *write* on any delivery area
 * — which is exactly what distinguishes a person doing the work from a person
 * watching it, and is derived from the permission matrix rather than a second
 * list that would drift from it.
 *
 * **A seat is held from the moment the invitation is sent, not when it is
 * accepted.** Otherwise ten seats absorb fifty invitations, everybody is told
 * they are on the project, and the eleventh person to click the link is refused
 * — which is worse than refusing the sender, because by then a person outside
 * the business has been promised something the business cannot give them. The
 * cap is checked against seats plus outstanding invitations.
 *
 * **An external invitee can never be granted administration of the tenancy.**
 * Inviting a subcontractor's engineer onto a job is normal; making them an
 * administrator of the main contractor's platform is a takeover, and it is the
 * kind of thing that happens by picking the wrong item in a list.
 *
 * **An invitation never creates a paid seat on its own.** The seat rule above
 * applies to the host's own Controllers, who take one of the package's seats
 * exactly as they always did. Everybody else — a participant of any
 * organisation, or a Controller from another company or from a company of
 * the same group — is admitted on the licence they already hold, or held
 * back until the host chooses to buy a pass or to reduce the roles. Which of
 * those a person is, and whose licence covers them, is resolved when the
 * invitation is sent and recorded on the `ProjectMembership` beside it; see
 * `domain/membership.ts` and `identity/licence.ts`.
 */

/** How long an invitation stands before it lapses and gives its seat back. */
const INVITATION_TTL_DAYS = 14;

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'WITHDRAWN' | 'EXPIRED' | 'DECLINED';

/**
 * Roles that may never be given to somebody outside the organisation.
 *
 * Administration and ownership of the tenancy, which between them can grant
 * roles, change the package, and reach the money. A person from another company
 * is on the project; they are not running the business.
 */
const INTERNAL_ONLY_ROLES: Role[] = ['ENTERPRISE_ADMIN', 'OWNER'];

/**
 * Capability areas that mean "doing the work" rather than "watching it".
 *
 * Taken from the matrix itself so a new area is included without an edit here,
 * less the three that say nothing about delivery: the audit trail (a regulator
 * writes evidence and builds nothing), AI execution (everybody has it), and
 * billing (an accounts clerk is not on site).
 */
const NOT_DELIVERY: CapabilityArea[] = ['EVIDENCE_AUDIT', 'AI_EXECUTION', 'BILLING_ACU'];

const DELIVERY_AREAS: CapabilityArea[] = [
  ...new Set(Object.values(PERMISSION_MATRIX).flatMap((row) => Object.keys(row) as CapabilityArea[])),
].filter((area) => !NOT_DELIVERY.includes(area));

/**
 * Is this identity working on the project, as opposed to able to read it?
 *
 * Derived from the matrix the platform already enforces: holding create, update
 * or approve on any delivery area. A second list of "roles that may invite"
 * would answer the same question in a different place, and the two would
 * disagree the first time a role changed.
 */
export function worksOnProject(roles: readonly Role[]): boolean {
  return roles.some((role) =>
    DELIVERY_AREAS.some((area) => (PERMISSION_MATRIX[role]?.[area] ?? []).some((code) => 'CUA'.includes(code))),
  );
}

/** Invitations still outstanding. */
export function pendingInvitations(ctx: EngineContext, now = new Date()): Array<Record<string, unknown>> {
  return ctx.ledger
    .listByTenant(ctx.tenantId, 'ProjectInvitation')
    .map((record) => record.state)
    .filter((state) => state.status === 'PENDING' && String(state.expiresAt) > now.toISOString());
}

/**
 * The outstanding invitations that are holding one of the package's seats:
 * the host's own Controllers, and nobody else. Written before the membership
 * existed, an invitation carries no class of its own; the membership beside
 * it does, and an invitation older than that record is a home member's — the
 * only kind there was — and holds a seat as it always did.
 */
export function seatHoldingInvitations(ledger: EngineContext['ledger'], tenantId: string, now = new Date()): Array<Record<string, unknown>> {
  const memberships = new Map(
    ledger.listByTenant(tenantId, 'ProjectMembership').map((record) => [String(record.state.invitationId), record.state as unknown as Parameters<typeof holdsHostSeat>[0]]),
  );
  return ledger
    .listByTenant(tenantId, 'ProjectInvitation')
    .map((record) => record.state)
    .filter((state) => state.status === 'PENDING' && String(state.expiresAt) > now.toISOString())
    .filter((state) => {
      const membership = memberships.get(String(state.id));
      return membership ? holdsHostSeat(membership) : true;
    });
}

/**
 * Invite somebody onto this project.
 *
 * The seat is taken here. `platform.createUser` assigns it for real on
 * acceptance; between the two, the outstanding invitation is what stops the
 * same seat being promised twice.
 */
export function inviteToProject(
  platform: Platform,
  ctx: EngineContext,
  input: {
    name: string;
    email: string;
    roles: Role[];
    /** Their organisation. Required for an external invitee — "who are they with" is the first question anybody asks. */
    organisation?: string;
    /** True where the person is not part of the inviting business. */
    external: boolean;
    /** What they are being brought on to do. Not optional: an invitation nobody can explain is one nobody can review. */
    because: string;
    /**
     * The firm on the supply-chain register this person belongs to. Only for
     * an external `SUPPLIER`; it gives the accepted identity the firm's party,
     * which is what the supplier portal resolves them to their own firm by.
     */
    supplierId?: string;
    /** When the appointment ends. Optional for the host's own people; an external appointment without one runs until revoked. */
    expiresAt?: string;
    /** Who the host proposes should pay for an external person's AI. Recorded as a proposal; nothing is funded until approved. */
    acuSponsor?: AcuSponsorType;
  },
  now = new Date(),
): {
  invitationId: string;
  membershipId: string;
  expiresAt: string;
  seatsRemaining: number | null;
  licence: { accessClass: string; relationship: string; source: string; hostBillableSeat: boolean; reasonCode: string; withheldRoles: Role[] };
} {
  // Read on project setup, so somebody who cannot see the project cannot staff
  // it. The narrower test — that they are actually working on it — follows.
  authorise(ctx, 'PROJECT_SETUP', 'R', { lifecyclePhase: currentPhase(ctx) });

  if (!worksOnProject(ctx.auth.roles)) {
    throw new ForbiddenError(
      'Only somebody working on this project may invite others onto it. ' +
        `The roles held (${ctx.auth.roles.join(', ')}) can read the project and do not deliver any part of it.`,
      'NOT_WORKING_ON_PROJECT',
    );
  }

  if (input.roles.length === 0) {
    throw new DomainError('INVITATION_ROLES_REQUIRED', 'Say what this person is being invited to do');
  }

  if (input.because.trim().length < 10) {
    throw new DomainError(
      'INVITATION_UNEXPLAINED',
      'Say why this person is being added, in a sentence somebody reviewing the team later will understand',
    );
  }

  // Nobody invites an administrator in above themselves.
  //
  // Staffing a project with roles the inviter does not hold is the ordinary
  // case and stays allowed: a project manager appoints quantity surveyors,
  // designers and supervisors, and is none of them. The escalation is narrower
  // and was completely open — the only test was `worksOnProject`, which any
  // delivery role passes.
  //
  // So a site supervisor could invite an address they owned as ENTERPRISE_ADMIN
  // and OWNER, accept the invitation themselves (an invitation is accepted by
  // whoever holds the project, not only by its subject), and sign in as an
  // administrator of the tenancy. That walked around both guards written to
  // stop exactly this: creating an identity and changing an identity's roles
  // each require ENTERPRISE_ADMIN. Invitation was the third door.
  //
  // These two roles administer the tenancy — they grant roles, change the
  // package and reach the money — so handing one on requires holding it.
  const administrative = input.roles.filter((role) => INTERNAL_ONLY_ROLES.includes(role));

  // Never to somebody outside the business, whoever is inviting. Checked
  // before the rule below so an external invite gets the refusal that names
  // the actual reason, and checked outside the `external` branch further down
  // because that branch is entered on a boolean the *caller* supplies — an
  // inviter who simply said `external: false` about somebody outside the
  // organisation skipped the guard entirely, which is the one thing it existed
  // to prevent.
  if (input.external && administrative.length > 0) {
    throw new ForbiddenError(
      `${administrative.join(' and ')} cannot be given to somebody outside the organisation. ` +
        'Those roles administer the tenancy — they grant roles, change the package and reach the money.',
      'EXTERNAL_CANNOT_ADMINISTER',
    );
  }

  // And nobody invites an administrator in above themselves.
  //
  // Staffing a project with roles the inviter does not hold is the ordinary
  // case and stays allowed: a project manager appoints quantity surveyors,
  // designers and supervisors, and is none of them. The escalation is narrower
  // and was completely open — the only test was `worksOnProject`, which any
  // delivery role passes.
  //
  // So a site supervisor could invite an address they owned as OWNER, accept
  // the invitation themselves (an invitation is accepted by whoever holds the
  // project, not only by its subject), and sign in as an administrator of the
  // tenancy. That walked around both guards written to stop exactly this:
  // creating an identity and changing an identity's roles each require
  // ENTERPRISE_ADMIN. Invitation was the third door, and it was open.
  //
  // This narrows a behaviour that used to be allowed: a project manager could
  // appoint an OWNER internally. That was the loophole rather than a feature —
  // the two roles here grant roles, change the package and reach the money, so
  // handing one on requires holding it.
  // Who may hand one on: somebody who administers identities, or somebody who
  // already holds the role being granted. `ENTERPRISE_ADMIN` is the gate the
  // rest of the platform uses for exactly this — creating an identity and
  // changing an identity's roles both require it — so the invitation door now
  // agrees with the other two instead of standing open beside them.
  const unheld = administrative.filter((role) => !ctx.auth.roles.includes(role));
  if (unheld.length > 0 && !ctx.auth.roles.includes('ENTERPRISE_ADMIN')) {
    throw new ForbiddenError(
      `You cannot invite somebody as ${unheld.join(' or ')}. ${unheld.join(' and ')} ` +
        `administer${unheld.length === 1 ? 's' : ''} the tenancy — granting roles, changing the package and reaching ` +
        `the money — so it takes an administrator, or somebody who holds the role already. You hold ` +
        `${ctx.auth.roles.join(', ')}.`,
      'INVITE_EXCEEDS_OWN_ROLES',
    );
  }

  if (input.external && !input.organisation?.trim()) {
    throw new DomainError('INVITATION_ORGANISATION_REQUIRED', 'An external invitee has to say which organisation they are with', 422, [
      { field: 'organisation', message: 'Name the company this person works for' },
    ]);
  }

  // The firm a supplier sign-in belongs to. Refused where the register does
  // not hold it, and refused on anybody who is not an external supplier: a
  // party on an internal identity would make a colleague look like a firm.
  let party: string | undefined;
  if (input.supplierId !== undefined) {
    if (!input.external || !input.roles.includes('SUPPLIER')) {
      throw new DomainError(
        'SUPPLIER_LINK_MISPLACED',
        'A supplier firm is linked to an external invitee holding the SUPPLIER role, and to nobody else.',
        422,
        [{ field: 'supplierId', message: 'Only an external SUPPLIER is linked to a firm' }],
      );
    }
    const firm = ctx.ledger
      .listByTenant(ctx.tenantId, 'Supplier')
      .map((record) => record.state as { id: string; legalName: string; partyId?: string })
      .find((entry) => entry.id === input.supplierId);
    if (!firm) {
      throw new DomainError('SUPPLIER_NOT_FOUND', 'No such supplier on the supply-chain register', 404, [
        { field: 'supplierId', message: 'Register the firm before inviting its people' },
      ]);
    }
    if (!firm.partyId) {
      throw new DomainError('SUPPLIER_PARTY_MISSING', `${firm.legalName} is registered with no party identifier, so nobody can be linked to it.`, 422);
    }
    party = firm.partyId;
  }

  // An invitation to somebody already here is a role change, and doing it this
  // way would take a second seat for one person. The exception is an external
  // person already on one of this organisation's projects: a second project
  // is a second membership of the same identity, which is exactly what the
  // one-person-many-projects rule needs.
  const existing = platform.users(ctx.tenantId).find((user) => user.email.toLowerCase() === input.email.trim().toLowerCase() && !user.erasedAt);
  if (existing && !existing.external) {
    throw new DomainError(
      'ALREADY_IN_TENANCY',
      `${input.email} already has an identity here. Change what they may do rather than inviting them again.`,
      409,
    );
  }
  if (existing && !input.external) {
    throw new DomainError(
      'ALREADY_IN_TENANCY',
      `${input.email} is here as an external member from ${existing.homeOrganisation ?? 'another organisation'}; invite them as external.`,
      409,
    );
  }
  if (existing && membershipsOf(platform, ctx.tenantId, ctx.projectId).some((membership) => membership.userId === existing.id && (membership.status === 'ACTIVE' || membership.status === 'PENDING' || membership.status === 'SUSPENDED'))) {
    throw new DomainError('ALREADY_A_MEMBER', `${input.email} already holds a membership of this project. Change it rather than inviting them again.`, 409);
  }

  const invitationId = ulid();
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_DAYS * 86_400_000).toISOString();

  // --- the seat -------------------------------------------------------------
  //
  // Held now, not on acceptance. A cap that only bites when somebody clicks a
  // link means the business has already promised a place to a person outside
  // it, and the refusal lands on the wrong person at the worst moment. Only a
  // home Controller's invitation holds one: a participant takes no seat, and
  // an external Controller brings a licence or waits for one.
  const takesSeat = !input.external && accessClassOf(input.roles) === 'CONTROLLER';
  const subscription = platform.subscription(ctx.tenantId);
  const limit = subscription ? seatLimit(subscription.package, purchasedSeats(ctx.ledger, ctx.tenantId)) : null;
  let seatsRemaining: number | null = null;

  if (limit !== null && subscription) {
    const taken = subscription.assignedIdentities.length + seatHoldingInvitations(ctx.ledger, ctx.tenantId, now).length;
    if (takesSeat && taken >= limit) {
      throw new DomainError(
        'SEAT_LIMIT_REACHED',
        `This package includes ${limit} Controller seat${limit === 1 ? '' : 's'} and ${taken} ${taken === 1 ? 'is' : 'are'} ` +
          'already taken or invited. Buy a seat on ACU & Billing, move package, or withdraw an invitation that is not going to be accepted.',
        409,
        [{ field: 'email', message: 'No seat is available for this person' }],
      );
    }
    seatsRemaining = Math.max(0, limit - taken - (takesSeat ? 1 : 0));
  }

  // Who this person is to the host, and whose licence covers them: the
  // membership beside the invitation, resolved once and recorded.
  const { membership } = createMembership(
    platform,
    ctx,
    { invitationId, name: input.name, email: input.email, roles: input.roles, external: input.external, organisation: input.organisation, because: input.because, expiresAt: input.expiresAt, acuSponsor: input.acuSponsor },
    now,
  );

  write(ctx, {
    eventType: 'PROJECT_INVITATION_SENT',
    entity: { refType: 'ProjectInvitation', refId: invitationId },
    nextState: {
      id: invitationId,
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      membershipId: membership.id,
      name: input.name,
      email: input.email.trim().toLowerCase(),
      roles: input.roles,
      external: input.external,
      organisation: input.organisation?.trim(),
      because: input.because,
      ...(input.supplierId !== undefined ? { supplierId: input.supplierId, partyId: party } : {}),
      relationship: membership.relationship,
      accessClass: membership.accessClass,
      licenceSource: membership.licence.source,
      hostBillableSeat: membership.licence.hostBillableSeat,
      withheldRoles: membership.withheldRoles,
      appointmentEndsAt: membership.expiresAt,
      invitedBy: ctx.auth.actorId,
      invitedAt: now.toISOString(),
      expiresAt,
      status: 'PENDING' satisfies InvitationStatus,
    },
  });

  return {
    invitationId,
    membershipId: membership.id,
    expiresAt,
    seatsRemaining,
    licence: {
      accessClass: membership.accessClass,
      relationship: membership.relationship,
      source: membership.licence.source,
      hostBillableSeat: membership.licence.hostBillableSeat,
      reasonCode: membership.licence.reasonCode,
      withheldRoles: membership.withheldRoles,
    },
  };
}

/** Take an invitation back, returning the seat it was holding. */
export function withdrawInvitation(
  ctx: EngineContext,
  input: { invitationId: string; reason: string },
  now = new Date(),
  platform?: Platform,
): { invitationId: string } {
  authorise(ctx, 'PROJECT_SETUP', 'R', { lifecyclePhase: currentPhase(ctx) });
  if (!worksOnProject(ctx.auth.roles)) {
    throw new ForbiddenError('Only somebody working on this project may withdraw an invitation to it', 'NOT_WORKING_ON_PROJECT');
  }

  const record = ctx.ledger.require({ refType: 'ProjectInvitation', refId: input.invitationId });
  if (record.state.status !== 'PENDING') {
    throw new DomainError('INVITATION_NOT_PENDING', `That invitation is already ${String(record.state.status).toLowerCase()}`);
  }
  if (input.reason.trim().length < 5) {
    throw new DomainError('WITHDRAWAL_UNEXPLAINED', 'Say why the invitation is being withdrawn');
  }

  write(ctx, {
    eventType: 'PROJECT_INVITATION_WITHDRAWN',
    entity: { refType: 'ProjectInvitation', refId: input.invitationId },
    nextState: {
      ...record.state,
      status: 'WITHDRAWN' satisfies InvitationStatus,
      withdrawnBy: ctx.auth.actorId,
      withdrawnAt: now.toISOString(),
      withdrawalReason: input.reason,
    },
  });
  if (platform && typeof record.state.membershipId === 'string') {
    endPendingMembership(platform, ctx, record.state.membershipId, `Invitation withdrawn: ${input.reason}`, now);
  }

  return { invitationId: input.invitationId };
}

/** The invitee saying no. The record shows a refusal, not a withdrawal, and nothing was ever charged. */
export function declineInvitation(
  platform: Platform,
  ctx: EngineContext,
  input: { invitationId: string; reason?: string },
  now = new Date(),
): { invitationId: string } {
  const record = ctx.ledger.require({ refType: 'ProjectInvitation', refId: input.invitationId });
  if (record.state.status !== 'PENDING') {
    throw new DomainError('INVITATION_NOT_PENDING', `That invitation is ${String(record.state.status).toLowerCase()}`, 409);
  }
  write(ctx, {
    eventType: 'PROJECT_INVITATION_DECLINED',
    entity: { refType: 'ProjectInvitation', refId: input.invitationId },
    nextState: {
      ...record.state,
      status: 'DECLINED' satisfies InvitationStatus,
      declinedBy: ctx.auth.actorId,
      declinedAt: now.toISOString(),
      ...(input.reason ? { declineReason: input.reason } : {}),
    },
  });
  if (typeof record.state.membershipId === 'string') {
    endPendingMembership(platform, ctx, record.state.membershipId, `Invitation declined${input.reason ? `: ${input.reason}` : ''}`, now);
  }
  return { invitationId: input.invitationId };
}

/**
 * Accept an invitation, which is where the identity is actually created.
 *
 * The seat was reserved when the invitation was sent, so `createUser` finds one
 * free. Where it does not — a package moved down between invitation and
 * acceptance — the seat error surfaces here, which is the one case where the
 * invitee is the right person to be told: their place genuinely went away.
 */
export function acceptInvitation(
  platform: Platform,
  ctx: EngineContext,
  input: { invitationId: string },
  now = new Date(),
): { userId: string; email: string; roles: Role[] } {
  const record = ctx.ledger.require({ refType: 'ProjectInvitation', refId: input.invitationId });

  if (record.state.status !== 'PENDING') {
    throw new DomainError('INVITATION_NOT_PENDING', `That invitation is ${String(record.state.status).toLowerCase()}`, 409);
  }
  if (String(record.state.expiresAt) <= now.toISOString()) {
    throw new DomainError(
      'INVITATION_EXPIRED',
      `That invitation lapsed on ${String(record.state.expiresAt).slice(0, 10)}. Ask whoever sent it to send another.`,
      409,
    );
  }

  const requested = record.state.roles as Role[];
  const membership = typeof record.state.membershipId === 'string' ? membershipOf(platform, record.state.membershipId) : undefined;
  // What the identity is given: the membership's active roles — the request
  // less anything withheld for want of a licence. An invitation written
  // before memberships existed carries its roles as they were.
  const roles = membership ? membership.activeRoles : requested;
  const external = membership !== undefined && membership.relationship !== 'HOME_MEMBER';

  // An external person already here on another project: the same identity,
  // one more membership, the roles the union of what the memberships grant.
  const existing = external
    ? platform.users(String(record.state.tenantId)).find((user) => user.external && user.email.toLowerCase() === String(record.state.email) && !user.erasedAt)
    : undefined;
  const user =
    existing ??
    platform.createUser({
      tenantId: String(record.state.tenantId),
      name: String(record.state.name),
      email: String(record.state.email),
      roles,
      // The firm's party, where the invitation named a firm. This is the whole
      // of what makes the identity a supplier's rather than a stranger's with a
      // supplier role.
      ...(typeof record.state.partyId === 'string' ? { partyId: record.state.partyId } : {}),
      ...(external && membership ? { external: { homeTenantId: membership.homeOrganisation.tenantId, homeOrganisation: membership.homeOrganisation.name } } : {}),
    });

  write(ctx, {
    eventType: 'PROJECT_INVITATION_ACCEPTED',
    entity: { refType: 'ProjectInvitation', refId: input.invitationId },
    nextState: {
      ...record.state,
      status: 'ACCEPTED' satisfies InvitationStatus,
      acceptedAt: now.toISOString(),
      userId: user.id,
    },
  });
  if (membership) {
    const activated = activateMembership(platform, ctx, membership.id, user.id, now);
    if (existing) platform.applyMembershipRoles(activated, 'Accepted an invitation onto a further project', ctx.auth.actorId);
  }

  return { userId: user.id, email: String(record.state.email), roles: platform.user(user.id).roles };
}

/** Whether a set of roles is a Controller's — published so the invitation form can say what it is about to ask for. */
export function classOf(roles: readonly Role[]): 'PARTICIPANT' | 'CONTROLLER' {
  return accessClassOf(roles);
}

/** The seat ceiling for a package plus the seats bought beyond it, or null where there is none. */
function seatLimit(packageTier: string, purchased: number): number | null {
  // From the billing model, which is the one place seats are sized. A bought
  // seat counts here for the same reason it counts in `assignIdentity`: an
  // invitation is a seat, and a seat paid for must be one that can be given.
  const included = PACKAGES[packageTier as keyof typeof PACKAGES]?.includedSeats ?? null;
  return included === null ? null : included + purchased;
}
