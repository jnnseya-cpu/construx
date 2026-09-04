import { DomainError, ForbiddenError, NotFoundError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import type { AuthContext } from '../identity/auth.ts';
import type { Platform } from '../platform.ts';

/**
 * Break-glass support access (§4, §13).
 *
 * A platform operator has no default read on any company's records. The
 * account-layer separation in `identity/abac.ts` and the gateway already
 * refuse every delivery route to an operator; this is the one way through it,
 * and it is narrow on purpose: opened by the operator with a reason and a
 * ticket, time-boxed to a few hours at most, recorded on the company's own
 * chain where the company's administrator can see it, and every read made
 * under it recorded too. What it opens is the company's governance record —
 * the audit feed — read-only. It does not open projects, documents,
 * commercial positions or correspondence, and there is no route that would.
 */

export const SUPPORT_ACCESS_MAX_MINUTES = 240;

export type SupportAccessGrant = {
  id: string;
  tenantId: string;
  operatorId: string;
  operatorName: string;
  reason: string;
  ticketRef: string;
  openedAt: string;
  expiresAt: string;
  closedAt?: string;
  closedBy?: string;
  uses: Array<{ at: string; what: string }>;
};

const governance = (tenantId: string) => `${tenantId}-governance`;

export function supportGrants(platform: Platform, tenantId: string): SupportAccessGrant[] {
  return platform.ledger
    .listByTenant(tenantId, 'SupportAccessGrant')
    .map((record) => record.state as unknown as SupportAccessGrant)
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt));
}

export function grantIsOpen(grant: SupportAccessGrant, now = new Date()): boolean {
  return !grant.closedAt && grant.expiresAt > now.toISOString();
}

export function openSupportAccess(
  platform: Platform,
  actor: AuthContext,
  input: { tenantId: string; reason: string; ticketRef: string; minutes?: number },
): SupportAccessGrant {
  if (!actor.roles.includes('PLATFORM_ADMIN')) throw new ForbiddenError('Only a platform operator opens support access', 'PLATFORM_ADMIN_REQUIRED');
  const tenant = platform.tenant(input.tenantId);
  if (tenant.id === 'platform') throw new DomainError('PLATFORM_TENANCY', "The platform's own tenancy needs no support access", 422);
  const reason = input.reason.trim();
  const ticketRef = input.ticketRef.trim();
  if (reason.length < 10) throw new DomainError('REASON_REQUIRED', 'Say why, in at least ten characters; the company reads this');
  if (!ticketRef) throw new DomainError('TICKET_REQUIRED', 'Support access is opened against a ticket');
  const minutes = input.minutes ?? 60;
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > SUPPORT_ACCESS_MAX_MINUTES) {
    throw new DomainError('WINDOW_INVALID', `Support access lasts between 5 and ${SUPPORT_ACCESS_MAX_MINUTES} minutes`);
  }
  if (supportGrants(platform, tenant.id).some((grant) => grantIsOpen(grant) && grant.operatorId === actor.actorId)) {
    throw new DomainError('SUPPORT_ACCESS_OPEN', 'You already hold open support access on this company', 409);
  }
  const now = new Date();
  const operator = platform.user(actor.actorId);
  const grant: SupportAccessGrant = {
    id: ulid(),
    tenantId: tenant.id,
    operatorId: actor.actorId,
    operatorName: operator.name,
    reason,
    ticketRef,
    openedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + minutes * 60_000).toISOString(),
    uses: [],
  };
  platform.ledger.commit({
    tenantId: tenant.id,
    projectId: governance(tenant.id),
    actor: { refType: 'User', refId: actor.actorId },
    source: 'WEB',
    correlationId: ulid(),
    eventType: 'SUPPORT_ACCESS_OPENED',
    entity: { refType: 'SupportAccessGrant', refId: grant.id },
    nextState: { ...grant } as unknown as Record<string, unknown>,
  });
  return grant;
}

export function closeSupportAccess(platform: Platform, actor: AuthContext, tenantId: string, grantId: string): SupportAccessGrant {
  const record = platform.ledger.get({ refType: 'SupportAccessGrant', refId: grantId });
  if (!record || record.tenantId !== tenantId) throw new NotFoundError(`No support access ${grantId} on this company`);
  const grant = record.state as unknown as SupportAccessGrant;
  if (!grantIsOpen(grant)) throw new DomainError('SUPPORT_ACCESS_CLOSED', 'That support access is already closed', 409);
  // The operator who opened it, or the company's own administrator: the
  // company can end the window early, which is the point of it being visible.
  const operator = actor.roles.includes('PLATFORM_ADMIN');
  const company = actor.tenantId === tenantId && (actor.roles.includes('ENTERPRISE_ADMIN') || actor.roles.includes('OWNER'));
  if (!operator && !company) throw new ForbiddenError('Only the operator or the company administrator closes support access', 'SUPPORT_ACCESS_NOT_YOURS');
  const closed: SupportAccessGrant = { ...grant, closedAt: new Date().toISOString(), closedBy: actor.actorId };
  platform.ledger.commit({
    tenantId,
    projectId: governance(tenantId),
    actor: { refType: 'User', refId: actor.actorId },
    source: 'WEB',
    correlationId: ulid(),
    eventType: 'SUPPORT_ACCESS_CLOSED',
    entity: { refType: 'SupportAccessGrant', refId: grantId },
    nextState: { ...closed } as unknown as Record<string, unknown>,
  });
  return closed;
}

/**
 * Use the open window: read the company's governance record. Refused without
 * an open grant held by this operator; every use is written to the grant so
 * the company sees not only that the door was opened but what was read
 * through it.
 */
export function readUnderSupportAccess(
  platform: Platform,
  actor: AuthContext,
  tenantId: string,
  what: string,
  from?: string,
  to?: string,
): { grant: SupportAccessGrant; company: { tenantId: string; name: string }; events: Array<Record<string, unknown>> } {
  if (!actor.roles.includes('PLATFORM_ADMIN')) throw new ForbiddenError('Only a platform operator reads under support access', 'PLATFORM_ADMIN_REQUIRED');
  const grant = supportGrants(platform, tenantId).find((candidate) => grantIsOpen(candidate) && candidate.operatorId === actor.actorId);
  if (!grant) {
    throw new ForbiddenError(
      'No open support access on this company. Open one with a reason and a ticket; the company will see it.',
      'SUPPORT_ACCESS_REQUIRED',
    );
  }
  const used: SupportAccessGrant = { ...grant, uses: [...grant.uses, { at: new Date().toISOString(), what }] };
  platform.ledger.commit({
    tenantId,
    projectId: governance(tenantId),
    actor: { refType: 'User', refId: actor.actorId },
    source: 'WEB',
    correlationId: ulid(),
    eventType: 'SUPPORT_ACCESS_USED',
    entity: { refType: 'SupportAccessGrant', refId: grant.id },
    nextState: { ...used } as unknown as Record<string, unknown>,
  });
  const tenant = platform.tenant(tenantId);
  const events = platform.ledger
    .events({ tenantId, ...(from ? { from } : {}), ...(to ? { until: to } : {}) })
    .filter((event) => event.projectId === governance(tenantId))
    .map((event) => ({
      eventId: event.eventId,
      timestamp: event.timestamp,
      eventType: event.eventType,
      entity: event.entity,
      actor: event.actor,
      correlationId: event.correlationId,
    }));
  return { grant: used, company: { tenantId, name: tenant.legalName }, events };
}
