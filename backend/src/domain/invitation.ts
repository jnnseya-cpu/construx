import { DomainError, ForbiddenError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, write, type EngineContext } from '../engines/context.ts';
import { PERMISSION_MATRIX, type CapabilityArea, type Role } from '../identity/roles.ts';
import { PACKAGES } from '../billing/seats.ts';
import { purchasedSeats } from '../billing/subscription.ts';
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
 */

/** How long an invitation stands before it lapses and gives its seat back. */
const INVITATION_TTL_DAYS = 14;

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'WITHDRAWN' | 'EXPIRED';

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

/** Invitations still outstanding, which are holding seats. */
export function pendingInvitations(ctx: EngineContext, now = new Date()): Array<Record<string, unknown>> {
  return ctx.ledger
    .listByTenant(ctx.tenantId, 'ProjectInvitation')
    .map((record) => record.state)
    .filter((state) => state.status === 'PENDING' && String(state.expiresAt) > now.toISOString());
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
  },
  now = new Date(),
): { invitationId: string; expiresAt: string; seatsRemaining: number | null } {
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

  if (input.external) {
    if (!input.organisation?.trim()) {
      throw new DomainError('INVITATION_ORGANISATION_REQUIRED', 'An external invitee has to say which organisation they are with', 422, [
        { field: 'organisation', message: 'Name the company this person works for' },
      ]);
    }
    const forbidden = input.roles.filter((role) => INTERNAL_ONLY_ROLES.includes(role));
    if (forbidden.length > 0) {
      throw new ForbiddenError(
        `${forbidden.join(' and ')} cannot be given to somebody outside the organisation. ` +
          'Those roles administer the tenancy — they grant roles, change the package and reach the money.',
        'EXTERNAL_CANNOT_ADMINISTER',
      );
    }
  }

  // An invitation to somebody already here is a role change, and doing it this
  // way would take a second seat for one person.
  const existing = platform.users(ctx.tenantId).find((user) => user.email.toLowerCase() === input.email.trim().toLowerCase());
  if (existing) {
    throw new DomainError(
      'ALREADY_IN_TENANCY',
      `${input.email} already has an identity here. Change what they may do rather than inviting them again.`,
      409,
    );
  }

  // --- the seat -------------------------------------------------------------
  //
  // Held now, not on acceptance. A cap that only bites when somebody clicks a
  // link means the business has already promised a place to a person outside
  // it, and the refusal lands on the wrong person at the worst moment.
  const subscription = platform.subscription(ctx.tenantId);
  const limit = subscription ? seatLimit(subscription.package, purchasedSeats(ctx.ledger, ctx.tenantId)) : null;
  let seatsRemaining: number | null = null;

  if (limit !== null && subscription) {
    const taken = subscription.assignedIdentities.length + pendingInvitations(ctx, now).length;
    if (taken >= limit) {
      throw new DomainError(
        'SEAT_LIMIT_REACHED',
        `This package includes ${limit} identit${limit === 1 ? 'y' : 'ies'} and ${taken} ${taken === 1 ? 'is' : 'are'} ` +
          'already taken or invited. Move package, or withdraw an invitation that is not going to be accepted.',
        409,
        [{ field: 'email', message: 'No seat is available for this person' }],
      );
    }
    seatsRemaining = limit - taken - 1;
  }

  const invitationId = ulid();
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_DAYS * 86_400_000).toISOString();

  write(ctx, {
    eventType: 'PROJECT_INVITATION_SENT',
    entity: { refType: 'ProjectInvitation', refId: invitationId },
    nextState: {
      id: invitationId,
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      name: input.name,
      email: input.email.trim().toLowerCase(),
      roles: input.roles,
      external: input.external,
      organisation: input.organisation?.trim(),
      because: input.because,
      invitedBy: ctx.auth.actorId,
      invitedAt: now.toISOString(),
      expiresAt,
      status: 'PENDING' satisfies InvitationStatus,
    },
  });

  return { invitationId, expiresAt, seatsRemaining };
}

/** Take an invitation back, returning the seat it was holding. */
export function withdrawInvitation(
  ctx: EngineContext,
  input: { invitationId: string; reason: string },
  now = new Date(),
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

  const roles = record.state.roles as Role[];
  const user = platform.createUser({
    tenantId: String(record.state.tenantId),
    name: String(record.state.name),
    email: String(record.state.email),
    roles,
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

  return { userId: user.id, email: String(record.state.email), roles };
}

/** The seat ceiling for a package plus the seats bought beyond it, or null where there is none. */
function seatLimit(packageTier: string, purchased: number): number | null {
  // From the billing model, which is the one place seats are sized. A bought
  // seat counts here for the same reason it counts in `assignIdentity`: an
  // invitation is a seat, and a seat paid for must be one that can be given.
  const included = PACKAGES[packageTier as keyof typeof PACKAGES]?.includedSeats ?? null;
  return included === null ? null : included + purchased;
}
