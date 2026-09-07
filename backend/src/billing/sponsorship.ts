import { DomainError, NotFoundError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, type EngineContext } from '../engines/context.ts';
import type { AcuSponsorType } from '../identity/licence.ts';
import type { ACUWallet } from './acu.ts';
import { membershipOf, membershipsAwayFrom, type ProjectMembership } from '../domain/membership.ts';
import type { Platform } from '../platform.ts';

/**
 * Who pays for an external person's AI, and up to how much.
 *
 * A person invited onto a host's project from another organisation spends
 * from nobody's wallet until somebody agrees to pay. The host cannot decide
 * that for the person's own company — an invitation must never let one
 * organisation create a cost in another — and the platform will not decide
 * it for the host either, because a default that spends money is a charge
 * nobody confirmed. So every sponsorship is an explicit act:
 *
 * - The host *requests* that the home organisation sponsor the person: a
 *   monthly allowance, a project allowance, or one execution of a named
 *   workflow. The request sits on the home organisation's own chain, PENDING,
 *   until one of its administrators approves it with a limit — or rejects it.
 * - The host *sponsors* the person itself: the same record on the host's own
 *   chain, approved in the act of creating it by an administrator with
 *   authority over the host's money.
 *
 * What was spent under a sponsorship is measured from the sponsor wallet's
 * own entries, which carry the sponsorship id, rather than from a counter
 * beside it: the wallet is the record of money, and a second tally of the
 * same spend is the second source of truth every balance here avoids.
 */

export const SPONSORSHIP_TYPES = ['MONTHLY_ALLOWANCE', 'PROJECT_ALLOWANCE', 'ONE_TIME_EXECUTION'] as const;
export type SponsorshipType = (typeof SPONSORSHIP_TYPES)[number];

export type SponsorshipStatus = 'PENDING' | 'ACTIVE' | 'REJECTED' | 'EXPIRED' | 'REVOKED';

export type AcuSponsorship = {
  id: string;
  /** The sponsor organisation: the chain the record lives on and the wallet it draws from. */
  tenantId: string;
  hostTenantId: string;
  projectId: string;
  membershipId: string;
  person: { name: string; email: string };
  sponsorType: 'HOME_ORGANISATION' | 'HOST_ORGANISATION';
  authorisationType: SponsorshipType;
  /** The engine a one-time authorisation covers, and nothing else. */
  workflow: string | null;
  maximumMinor: number;
  overageAllowed: boolean;
  requestedBy: { tenantId: string; userId: string; name: string };
  requestedAt: string;
  reason: string;
  decidedBy?: { tenantId: string; userId: string; name: string };
  decidedAt?: string;
  decisionReason?: string;
  startsAt: string;
  expiresAt: string | null;
  status: SponsorshipStatus;
  /** On a limit change, the limit it replaced — the previous value the audit rule asks for. */
  previousMaximumMinor?: number;
  createdAt: string;
  updatedAt: string;
};

export type SponsorshipUsage = {
  maximumMinor: number;
  consumedMinor: number;
  heldMinor: number;
  remainingMinor: number;
  /** The month a monthly allowance is measured over; the whole window otherwise. */
  period: string;
  exhausted: boolean;
};

export type AcuResolution =
  | {
      ok: true;
      sponsorship: AcuSponsorship;
      sponsorType: AcuSponsorType;
      sponsorTenantId: string;
      wallet: ACUWallet;
      remainingMinor: number;
      overageAllowed: boolean;
    }
  | { ok: false; code: string; message: string };

function asSponsorship(state: Record<string, unknown>): AcuSponsorship {
  return state as unknown as AcuSponsorship;
}

function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

// --- reads -----------------------------------------------------------------------

export function sponsorshipOf(platform: Platform, sponsorshipId: string): AcuSponsorship {
  const record = platform.ledger.get({ refType: 'AcuSponsorship', refId: sponsorshipId });
  if (!record) throw new NotFoundError(`No ACU sponsorship ${sponsorshipId}`);
  return asSponsorship(record.state);
}

/** Every sponsorship on one organisation's chain: the ones it pays for. */
export function sponsorshipsOf(platform: Platform, tenantId: string): AcuSponsorship[] {
  return platform.ledger.listByTenant(tenantId, 'AcuSponsorship').map((record) => asSponsorship(record.state));
}

/** Every sponsorship a host has raised or granted, on either chain. */
export function sponsorshipsRaisedBy(platform: Platform, hostTenantId: string): AcuSponsorship[] {
  return platform.ledger
    .entitiesOfType('AcuSponsorship')
    .map((record) => asSponsorship(record.state))
    .filter((sponsorship) => sponsorship.hostTenantId === hostTenantId);
}

/** The sponsorships behind one membership, from the home chain and the host chain. */
export function sponsorshipsFor(platform: Platform, membership: ProjectMembership): AcuSponsorship[] {
  const own = sponsorshipsOf(platform, membership.tenantId).filter((sponsorship) => sponsorship.membershipId === membership.id);
  const home = membership.homeOrganisation.tenantId
    ? sponsorshipsOf(platform, membership.homeOrganisation.tenantId).filter((sponsorship) => sponsorship.membershipId === membership.id)
    : [];
  return [...own, ...home];
}

/** The wallet a sponsorship draws on: the sponsor's spending wallet, which for a covered company is its group's. */
export function walletFor(platform: Platform, sponsorship: AcuSponsorship): ACUWallet {
  return platform.spendingWallet(sponsorship.tenantId).wallet;
}

export function usageOf(platform: Platform, sponsorship: AcuSponsorship, now = new Date()): SponsorshipUsage {
  const wallet = walletFor(platform, sponsorship);
  const period = sponsorship.authorisationType === 'MONTHLY_ALLOWANCE' ? monthOf(now.toISOString()) : `${sponsorship.startsAt.slice(0, 10)} onwards`;
  const consumedMinor = wallet
    .entries(sponsorship.authorisationType === 'MONTHLY_ALLOWANCE' ? { month: period } : {})
    .filter((entry) => entry.type === 'DEBIT' && entry.sponsorshipId === sponsorship.id)
    .reduce((sum, entry) => sum + entry.billedMinor, 0);
  const heldMinor = wallet
    .openHolds()
    .filter((hold) => hold.sponsorshipId === sponsorship.id)
    .reduce((sum, hold) => sum + hold.heldMinor, 0);
  const remainingMinor = Math.max(0, sponsorship.maximumMinor - consumedMinor - heldMinor);
  return { maximumMinor: sponsorship.maximumMinor, consumedMinor, heldMinor, remainingMinor, period, exhausted: remainingMinor === 0 };
}

export function sponsorshipInForce(sponsorship: AcuSponsorship, now = new Date()): boolean {
  const at = now.toISOString();
  return sponsorship.status === 'ACTIVE' && sponsorship.startsAt <= at && (sponsorship.expiresAt === null || sponsorship.expiresAt > at);
}

/**
 * Which sponsorship funds this execution, if any.
 *
 * A one-time authorisation for the workflow in hand comes first — the host
 * said "this analysis, up to this much, on us" and that overrides the
 * default. Then the membership's default sponsor, through whichever
 * allowance that organisation approved. Nothing else: no sponsorship means
 * no AI, with the reason the person should be shown.
 */
export function resolveAcu(platform: Platform, membership: ProjectMembership, task: { engine: string } | null, now = new Date()): AcuResolution {
  const live = sponsorshipsFor(platform, membership).filter((sponsorship) => sponsorshipInForce(sponsorship, now));
  const funded = (sponsorship: AcuSponsorship): AcuResolution => {
    const usage = usageOf(platform, sponsorship, now);
    if (usage.exhausted && !sponsorship.overageAllowed) {
      return {
        ok: false,
        code: 'ACU_LIMIT_EXCEEDED',
        message: `The ${sponsorship.maximumMinor} ACU ${sponsorship.authorisationType === 'MONTHLY_ALLOWANCE' ? 'monthly ' : ''}allowance ${sponsorTenantName(platform, sponsorship)} approved for ${membership.person.name} is used up. More needs their approval.`,
      };
    }
    return {
      ok: true,
      sponsorship,
      sponsorType: sponsorship.authorisationType === 'ONE_TIME_EXECUTION' ? 'ONE_TIME_AUTHORISATION' : sponsorship.sponsorType,
      sponsorTenantId: sponsorship.tenantId,
      wallet: walletFor(platform, sponsorship),
      remainingMinor: usage.remainingMinor,
      overageAllowed: sponsorship.overageAllowed,
    };
  };

  if (task) {
    const oneTime = live.find(
      (sponsorship) => sponsorship.authorisationType === 'ONE_TIME_EXECUTION' && sponsorship.workflow === task.engine && !usageOf(platform, sponsorship, now).exhausted,
    );
    if (oneTime) return funded(oneTime);
  }

  const allowances = live.filter((sponsorship) => sponsorship.authorisationType !== 'ONE_TIME_EXECUTION');
  const preferred = allowances.find((sponsorship) => sponsorship.sponsorType === membership.acu.defaultSponsor) ?? allowances[0];
  if (preferred) return funded(preferred);

  const pending = sponsorshipsFor(platform, membership).find((sponsorship) => sponsorship.status === 'PENDING');
  if (pending) {
    return {
      ok: false,
      code: 'ACU_SPONSOR_APPROVAL_REQUIRED',
      message: `${sponsorTenantName(platform, pending)} has not yet approved paying for ${membership.person.name}'s AI on this project. Nothing runs until they do.`,
    };
  }
  return {
    ok: false,
    code: 'ACU_SPONSOR_REQUIRED',
    message: `Nobody has agreed to pay for ${membership.person.name}'s AI on this project. Ask ${membership.homeOrganisation.name || 'their organisation'} to sponsor it, or sponsor it from this organisation's wallet.`,
  };
}

function sponsorTenantName(platform: Platform, sponsorship: AcuSponsorship): string {
  try {
    return platform.tenant(sponsorship.tenantId).legalName;
  } catch {
    return sponsorship.tenantId;
  }
}

// --- writes ----------------------------------------------------------------------

function commit(
  platform: Platform,
  sponsorship: AcuSponsorship,
  eventType: 'ACU_SPONSORSHIP_REQUESTED' | 'ACU_SPONSORSHIP_APPROVED' | 'ACU_SPONSORSHIP_REJECTED' | 'ACU_SPONSORSHIP_REVOKED' | 'ACU_LIMIT_CHANGED',
  actor: { refType: 'User' | 'System'; refId: string },
  correlationId: string,
): AcuSponsorship {
  platform.ledger.commit({
    tenantId: sponsorship.tenantId,
    projectId: `${sponsorship.tenantId}-governance`,
    actor,
    source: 'WEB',
    correlationId,
    eventType,
    entity: { refType: 'AcuSponsorship', refId: sponsorship.id },
    nextState: { ...sponsorship } as unknown as Record<string, unknown>,
  });
  return sponsorship;
}

function personName(platform: Platform, userId: string): string {
  try {
    return platform.user(userId).name;
  } catch {
    return userId;
  }
}

/**
 * The host asks somebody to pay, or agrees to pay itself.
 *
 * Raised on the sponsor's chain. When the sponsor is the host, the person
 * raising it must hold authority over the host's money and the sponsorship is
 * live at once — that *is* the confirmation the rule requires. When the
 * sponsor is the home organisation, the person raising it need only be
 * running the project: they are asking, and the answer is somebody else's.
 */
export function requestSponsorship(
  platform: Platform,
  ctx: EngineContext,
  input: {
    membershipId: string;
    sponsorType: 'HOME_ORGANISATION' | 'HOST_ORGANISATION';
    authorisationType: SponsorshipType;
    maximumMinor: number;
    overageAllowed?: boolean;
    workflow?: string;
    expiresAt?: string;
    reason: string;
  },
  now = new Date(),
): AcuSponsorship {
  const membership = membershipOf(platform, input.membershipId);
  if (membership.tenantId !== ctx.tenantId) throw new NotFoundError(`No project membership ${input.membershipId}`);
  if (membership.relationship === 'HOME_MEMBER') {
    throw new DomainError('ACU_SPONSOR_NOT_REQUIRED', `${membership.person.name} is one of this organisation's own people and spends from its wallet as everybody here does`, 422);
  }
  if (membership.status === 'REVOKED' || membership.status === 'EXPIRED') {
    throw new DomainError('MEMBERSHIP_ENDED', `That membership is ${membership.status.toLowerCase()}`, 409);
  }
  if (!Number.isInteger(input.maximumMinor) || input.maximumMinor <= 0) {
    throw new DomainError('ACU_LIMIT_INVALID', 'The allowance is a whole number of ACUs above zero', 422, [{ field: 'maximumMinor', message: 'A whole number above zero' }]);
  }
  if (input.reason.trim().length < 10) throw new DomainError('REASON_REQUIRED', 'Say what the AI is for, in a sentence the sponsor can approve');
  if (input.authorisationType === 'ONE_TIME_EXECUTION' && !input.workflow?.trim()) {
    throw new DomainError('WORKFLOW_REQUIRED', 'A one-time authorisation names the engine it covers', 422, [{ field: 'workflow', message: 'Name the engine' }]);
  }
  const at = now.toISOString();
  if (input.expiresAt !== undefined && input.expiresAt <= at) {
    throw new DomainError('SPONSORSHIP_EXPIRY_INVALID', 'The sponsorship has to end after today', 422, [{ field: 'expiresAt', message: 'Choose a date in the future' }]);
  }

  let sponsorTenantId: string;
  if (input.sponsorType === 'HOST_ORGANISATION') {
    // The host's own money: approval and creation are the same act.
    authorise(ctx, 'BILLING_ACU', 'U');
    sponsorTenantId = ctx.tenantId;
  } else {
    if (!membership.homeOrganisation.tenantId) {
      throw new DomainError(
        'ACU_SPONSOR_REQUIRED',
        `${membership.homeOrganisation.name || 'Their organisation'} is not on the platform, so it has no wallet to sponsor from. Only this organisation can pay for ${membership.person.name}'s AI here.`,
        422,
      );
    }
    authorise(ctx, 'PROJECT_SETUP', 'R');
    sponsorTenantId = membership.homeOrganisation.tenantId;
  }

  const duplicate = sponsorshipsFor(platform, membership).find(
    (existing) =>
      (existing.status === 'PENDING' || sponsorshipInForce(existing, now)) &&
      existing.tenantId === sponsorTenantId &&
      existing.authorisationType === input.authorisationType &&
      (existing.workflow ?? null) === (input.workflow?.trim() ?? null),
  );
  if (duplicate) {
    throw new DomainError('SPONSORSHIP_EXISTS', `A ${input.authorisationType.toLowerCase().replace(/_/g, ' ')} from that organisation is already ${duplicate.status.toLowerCase()} for this person`, 409);
  }

  const requester = { tenantId: ctx.tenantId, userId: ctx.auth.actorId, name: personName(platform, ctx.auth.actorId) };
  const host = input.sponsorType === 'HOST_ORGANISATION';

  // Overage is the sponsor's to grant, never the asker's to propose.
  //
  // `overageAllowed` does not raise the limit — it removes it. Spend continues
  // past the approved allowance against the sponsor's wallet until that wallet
  // is empty, which is the whole of the protection this record exists to give.
  //
  // Asking for it is therefore an offer the beneficiary writes and the payer
  // is invited to wave through: a host could request one ACU with overage on,
  // and an administrator glancing at "1 ACU" and pressing approve would have
  // signed away their balance. `decideSponsorship` lets the sponsor turn it on
  // themselves, at approval or later, which is where the decision belongs.
  //
  // The host sponsoring from its own wallet is a different act by the same
  // administrator — request and approval in one — so it keeps the flag.
  const overageAllowed = host && input.overageAllowed === true;
  const sponsorship: AcuSponsorship = {
    id: ulid(),
    tenantId: sponsorTenantId,
    hostTenantId: ctx.tenantId,
    projectId: membership.projectId,
    membershipId: membership.id,
    person: membership.person,
    sponsorType: input.sponsorType,
    authorisationType: input.authorisationType,
    workflow: input.authorisationType === 'ONE_TIME_EXECUTION' ? input.workflow!.trim() : null,
    maximumMinor: input.maximumMinor,
    overageAllowed,
    requestedBy: requester,
    requestedAt: at,
    reason: input.reason,
    startsAt: at,
    expiresAt: input.expiresAt ?? null,
    status: 'PENDING',
    createdAt: at,
    updatedAt: at,
  };
  commit(platform, sponsorship, 'ACU_SPONSORSHIP_REQUESTED', { refType: 'User', refId: ctx.auth.actorId }, ctx.correlationId);
  if (!host) return sponsorship;
  // The host's own money: the request and the approval are one act by one
  // administrator, and the record shows both — the ask, then the answer.
  const approved: AcuSponsorship = { ...sponsorship, status: 'ACTIVE', decidedBy: requester, decidedAt: at, decisionReason: 'Sponsored by the host organisation in the act of raising it' };
  commit(platform, approved, 'ACU_SPONSORSHIP_APPROVED', { refType: 'User', refId: ctx.auth.actorId }, ctx.correlationId);
  setDefaultSponsor(platform, membership, approved, ctx.auth.actorId, ctx.correlationId, now);
  return approved;
}

/**
 * The sponsor's answer. Only an administrator with authority over the
 * sponsor organisation's money may give it, and the record it decides on
 * has to be on that organisation's own chain.
 */
export function decideSponsorship(
  platform: Platform,
  ctx: EngineContext,
  input: { sponsorshipId: string; approve: boolean; maximumMinor?: number; overageAllowed?: boolean; expiresAt?: string; reason: string },
  now = new Date(),
): AcuSponsorship {
  authorise(ctx, 'BILLING_ACU', 'U');
  const sponsorship = sponsorshipOf(platform, input.sponsorshipId);
  if (sponsorship.tenantId !== ctx.tenantId) throw new NotFoundError(`No ACU sponsorship ${input.sponsorshipId}`);
  if (input.reason.trim().length < 5) throw new DomainError('REASON_REQUIRED', 'Say why');
  const at = now.toISOString();
  const decider = { tenantId: ctx.tenantId, userId: ctx.auth.actorId, name: personName(platform, ctx.auth.actorId) };

  if (!input.approve) {
    if (sponsorship.status !== 'PENDING') throw new DomainError('SPONSORSHIP_NOT_PENDING', `That sponsorship is ${sponsorship.status.toLowerCase()}`, 409);
    return commit(platform, { ...sponsorship, status: 'REJECTED', decidedBy: decider, decidedAt: at, decisionReason: input.reason, updatedAt: at }, 'ACU_SPONSORSHIP_REJECTED', { refType: 'User', refId: ctx.auth.actorId }, ctx.correlationId);
  }

  if (input.maximumMinor !== undefined && (!Number.isInteger(input.maximumMinor) || input.maximumMinor <= 0)) {
    throw new DomainError('ACU_LIMIT_INVALID', 'The allowance is a whole number of ACUs above zero', 422, [{ field: 'maximumMinor', message: 'A whole number above zero' }]);
  }
  if (input.expiresAt !== undefined && input.expiresAt <= at) {
    throw new DomainError('SPONSORSHIP_EXPIRY_INVALID', 'The sponsorship has to end after today', 422, [{ field: 'expiresAt', message: 'Choose a date in the future' }]);
  }

  if (sponsorship.status === 'ACTIVE') {
    // Approving again is changing the terms: the limit, the overage, the end.
    const next: AcuSponsorship = {
      ...sponsorship,
      maximumMinor: input.maximumMinor ?? sponsorship.maximumMinor,
      overageAllowed: input.overageAllowed ?? sponsorship.overageAllowed,
      expiresAt: input.expiresAt ?? sponsorship.expiresAt,
      decidedBy: decider,
      decidedAt: at,
      decisionReason: input.reason,
      updatedAt: at,
    };
    if (next.maximumMinor === sponsorship.maximumMinor && next.overageAllowed === sponsorship.overageAllowed && next.expiresAt === sponsorship.expiresAt) {
      throw new DomainError('NO_CHANGE', 'Nothing about the sponsorship would change', 409);
    }
    return commit(platform, { ...next, previousMaximumMinor: sponsorship.maximumMinor }, 'ACU_LIMIT_CHANGED', { refType: 'User', refId: ctx.auth.actorId }, ctx.correlationId);
  }
  if (sponsorship.status !== 'PENDING') throw new DomainError('SPONSORSHIP_NOT_PENDING', `That sponsorship is ${sponsorship.status.toLowerCase()}`, 409);

  const approved: AcuSponsorship = {
    ...sponsorship,
    maximumMinor: input.maximumMinor ?? sponsorship.maximumMinor,
    overageAllowed: input.overageAllowed ?? sponsorship.overageAllowed,
    expiresAt: input.expiresAt ?? sponsorship.expiresAt,
    decidedBy: decider,
    decidedAt: at,
    decisionReason: input.reason,
    startsAt: at,
    status: 'ACTIVE',
    updatedAt: at,
  };
  commit(platform, approved, 'ACU_SPONSORSHIP_APPROVED', { refType: 'User', refId: ctx.auth.actorId }, ctx.correlationId);
  setDefaultSponsor(platform, membershipOf(platform, sponsorship.membershipId), approved, ctx.auth.actorId, ctx.correlationId, now);
  return approved;
}

/** Either side may end it: the sponsor because it is their money, the host because it is their project. */
export function revokeSponsorship(platform: Platform, ctx: EngineContext, input: { sponsorshipId: string; reason: string }, now = new Date()): AcuSponsorship {
  const sponsorship = sponsorshipOf(platform, input.sponsorshipId);
  if (sponsorship.tenantId !== ctx.tenantId && sponsorship.hostTenantId !== ctx.tenantId) throw new NotFoundError(`No ACU sponsorship ${input.sponsorshipId}`);
  authorise(ctx, sponsorship.tenantId === ctx.tenantId ? 'BILLING_ACU' : 'PROJECT_SETUP', sponsorship.tenantId === ctx.tenantId ? 'U' : 'R');
  if (sponsorship.status !== 'ACTIVE' && sponsorship.status !== 'PENDING') {
    throw new DomainError('SPONSORSHIP_ENDED', `That sponsorship is already ${sponsorship.status.toLowerCase()}`, 409);
  }
  if (input.reason.trim().length < 5) throw new DomainError('REASON_REQUIRED', 'Say why the sponsorship is being withdrawn');
  const at = now.toISOString();
  const revoked = commit(
    platform,
    { ...sponsorship, status: 'REVOKED', decidedBy: { tenantId: ctx.tenantId, userId: ctx.auth.actorId, name: personName(platform, ctx.auth.actorId) }, decidedAt: at, decisionReason: input.reason, updatedAt: at },
    'ACU_SPONSORSHIP_REVOKED',
    { refType: 'User', refId: ctx.auth.actorId },
    ctx.correlationId,
  );
  // Holds the person still has open against this sponsorship are released:
  // nothing more runs on it, and nothing in flight is charged to it.
  const wallet = walletFor(platform, sponsorship);
  for (const hold of wallet.openHolds().filter((held) => held.sponsorshipId === sponsorship.id)) {
    wallet.release(hold.holdId, `Sponsorship revoked: ${input.reason}`);
  }
  const membership = membershipOf(platform, sponsorship.membershipId);
  if (membership.acu.sponsorTenantId === sponsorship.tenantId && sponsorship.authorisationType !== 'ONE_TIME_EXECUTION') {
    const stillFunded = sponsorshipsFor(platform, membership).some((other) => other.id !== sponsorship.id && sponsorshipInForce(other, now) && other.authorisationType !== 'ONE_TIME_EXECUTION');
    if (!stillFunded) clearDefaultSponsor(platform, membership, ctx.auth.actorId, ctx.correlationId, input.reason, now);
  }
  return revoked;
}

/** An allowance approved becomes the membership's default sponsor, recorded on the host's chain as a change of who pays. */
function setDefaultSponsor(platform: Platform, membership: ProjectMembership, sponsorship: AcuSponsorship, actorId: string, correlationId: string, now: Date): void {
  if (sponsorship.authorisationType === 'ONE_TIME_EXECUTION') return;
  if (membership.acu.defaultSponsor === sponsorship.sponsorType && membership.acu.sponsorTenantId === sponsorship.tenantId) return;
  const at = now.toISOString();
  const acu = { defaultSponsor: sponsorship.sponsorType, sponsorTenantId: sponsorship.tenantId };
  platform.ledger.commit({
    tenantId: membership.tenantId,
    projectId: membership.projectId,
    actor: { refType: 'User', refId: actorId },
    source: 'WEB',
    correlationId,
    eventType: 'BILLING_RESPONSIBILITY_CHANGED',
    entity: { refType: 'ProjectMembership', refId: membership.id },
    nextState: {
      ...membership,
      acu,
      updatedAt: at,
      change: {
        event: 'BILLING_RESPONSIBILITY_CHANGED',
        at,
        by: actorId,
        reason: sponsorship.decisionReason ?? sponsorship.reason,
        previous: { acu: membership.acu },
        next: { acu, sponsorshipId: sponsorship.id, maximumMinor: sponsorship.maximumMinor },
        consequence: `${sponsorTenantName(platform, sponsorship)} pays for ${membership.person.name}'s AI on this project, up to ${sponsorship.maximumMinor} ACUs${sponsorship.authorisationType === 'MONTHLY_ALLOWANCE' ? ' a month' : ''}`,
      },
    } as unknown as Record<string, unknown>,
  });
}

function clearDefaultSponsor(platform: Platform, membership: ProjectMembership, actorId: string, correlationId: string, reason: string, now: Date): void {
  const at = now.toISOString();
  const acu = { defaultSponsor: 'NONE' as const, sponsorTenantId: null };
  platform.ledger.commit({
    tenantId: membership.tenantId,
    projectId: membership.projectId,
    actor: { refType: 'User', refId: actorId },
    source: 'WEB',
    correlationId,
    eventType: 'BILLING_RESPONSIBILITY_CHANGED',
    entity: { refType: 'ProjectMembership', refId: membership.id },
    nextState: {
      ...membership,
      acu,
      updatedAt: at,
      change: { event: 'BILLING_RESPONSIBILITY_CHANGED', at, by: actorId, reason, previous: { acu: membership.acu }, next: { acu }, consequence: `Nobody pays for ${membership.person.name}'s AI on this project until a sponsorship is approved` },
    } as unknown as Record<string, unknown>,
  });
}

/** Sponsorships past their end, marked so. Idempotent. */
export function sweepSponsorships(platform: Platform, now = new Date(), actorId = 'system:membership-sweep'): string[] {
  const at = now.toISOString();
  const expired: string[] = [];
  for (const record of platform.ledger.entitiesOfType('AcuSponsorship')) {
    const sponsorship = asSponsorship(record.state);
    if ((sponsorship.status === 'ACTIVE' || sponsorship.status === 'PENDING') && sponsorship.expiresAt !== null && sponsorship.expiresAt <= at) {
      platform.ledger.commit({
        tenantId: sponsorship.tenantId,
        projectId: `${sponsorship.tenantId}-governance`,
        actor: { refType: 'System', refId: actorId },
        source: 'SYSTEM',
        correlationId: ulid(),
        eventType: 'ACU_SPONSORSHIP_REVOKED',
        entity: { refType: 'AcuSponsorship', refId: sponsorship.id },
        nextState: { ...sponsorship, status: 'EXPIRED', decisionReason: `Ran out on ${sponsorship.expiresAt.slice(0, 10)}`, updatedAt: at } as unknown as Record<string, unknown>,
      });
      expired.push(sponsorship.id);
    }
  }
  return expired;
}

/**
 * The host's view of who pays for whom, and the sponsor's view of what it
 * has been asked to pay for — the same records read from either side, with
 * each side seeing only what is its own to see.
 */
export function sponsorshipPosition(platform: Platform, tenantId: string, now = new Date()) {
  const asSponsor = sponsorshipsOf(platform, tenantId).map((sponsorship) => ({
    ...sponsorship,
    hostName: safeName(platform, sponsorship.hostTenantId),
    projectName: projectName(platform, sponsorship.projectId),
    usage: sponsorship.status === 'ACTIVE' ? usageOf(platform, sponsorship, now) : null,
  }));
  const asHost = sponsorshipsRaisedBy(platform, tenantId)
    .filter((sponsorship) => sponsorship.tenantId !== tenantId)
    .map((sponsorship) => ({
      id: sponsorship.id,
      membershipId: sponsorship.membershipId,
      projectId: sponsorship.projectId,
      projectName: projectName(platform, sponsorship.projectId),
      person: sponsorship.person,
      sponsorName: safeName(platform, sponsorship.tenantId),
      authorisationType: sponsorship.authorisationType,
      workflow: sponsorship.workflow,
      status: sponsorship.status,
      requestedAt: sponsorship.requestedAt,
      expiresAt: sponsorship.expiresAt,
      reason: sponsorship.reason,
      // What the host may know of the other organisation's money: whether the
      // allowance stands and whether it is used up. Not its size, not the
      // wallet behind it.
      standing: sponsorship.status === 'ACTIVE' ? (usageOf(platform, sponsorship, now).exhausted ? 'EXHAUSTED' : 'AVAILABLE') : sponsorship.status,
    }));
  return {
    asSponsor,
    asHost,
    awaitingDecision: asSponsor.filter((sponsorship) => sponsorship.status === 'PENDING').length,
  };
}

function safeName(platform: Platform, tenantId: string): string {
  try {
    return platform.tenant(tenantId).legalName;
  } catch {
    return tenantId;
  }
}

function projectName(platform: Platform, projectId: string): string {
  return String(platform.ledger.get({ refType: 'Project', refId: projectId })?.state.name ?? projectId);
}

/**
 * Every membership an organisation's people hold on other organisations'
 * projects, with what this organisation has been asked to pay for each. What
 * the home side is shown of the host: the host's name, the project's name,
 * the person, the roles asked for and the dates — and nothing of the host's
 * other members, wallet or commercial record.
 */
export function externalMembershipsOf(platform: Platform, homeTenantId: string, now = new Date()) {
  return membershipsAwayFrom(platform, homeTenantId).map((membership) => ({
    membershipId: membership.id,
    hostName: safeName(platform, membership.tenantId),
    projectName: projectName(platform, membership.projectId),
    person: membership.person,
    accessClass: membership.accessClass,
    roles: membership.roles,
    licenceSource: membership.licence.source,
    status: membership.status,
    startsAt: membership.startsAt,
    expiresAt: membership.expiresAt,
    sponsorships: sponsorshipsOf(platform, homeTenantId)
      .filter((sponsorship) => sponsorship.membershipId === membership.id)
      .map((sponsorship) => ({ ...sponsorship, usage: sponsorship.status === 'ACTIVE' ? usageOf(platform, sponsorship, now) : null })),
  }));
}
