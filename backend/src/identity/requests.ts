import { DomainError, NotFoundError, ValidationError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import type { AuthContext } from '../identity/auth.ts';
import { CURRENCIES, JURISDICTIONS } from '../domain/locale.ts';
import type { PackageTier } from '../billing/seats.ts';
import type { Platform } from '../platform.ts';

/**
 * Account requests: the pipeline behind "Talk to us".
 *
 * Enterprise and group accounts are provisioned with an agreement rather
 * than a form, and until now the public site had nowhere to put the request
 * and the operator had nowhere to see it — the honest instruction was an
 * email address. This is the queue that makes a form honest: a request
 * arrives as NEW, the operator moves it through CONTACTED and QUALIFIED as
 * the conversation goes, and PROVISIONED is one act — the tenancy, its first
 * administrator and the invitation to sign in, together, recorded. A request
 * that comes to nothing is DECLINED with a reason and can then be deleted:
 * the person asked once and was told no, and there is no record to keep.
 *
 * Kept on the platform's own tenancy: a request is the operator's record
 * about a prospect, not a customer's record about themselves.
 */

export const REQUEST_STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'PROVISIONED', 'DECLINED'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** Forward only, one step at a time or straight to declined; provisioned is terminal. */
const NEXT: Record<RequestStatus, RequestStatus[]> = {
  NEW: ['CONTACTED', 'DECLINED'],
  CONTACTED: ['QUALIFIED', 'DECLINED'],
  QUALIFIED: ['PROVISIONED', 'DECLINED'],
  PROVISIONED: [],
  DECLINED: [],
};

export type AccountRequest = {
  id: string;
  status: RequestStatus;
  organisationName: string;
  contactName: string;
  email: string;
  phone: string;
  jurisdiction: string;
  currency: string;
  /** What they asked for: an enterprise account, or a group over several companies. */
  kind: 'ENTERPRISE' | 'GROUP';
  companies: number;
  message: string;
  receivedAt: string;
  notes: Array<{ at: string; by: string; status: RequestStatus; note: string }>;
  declinedReason?: string;
  provisioned?: { tenantId: string; administratorId: string; at: string; notified: string };
};

const PLATFORM = 'platform';
const governance = `${PLATFORM}-governance`;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function accountRequests(platform: Platform): AccountRequest[] {
  return platform.ledger
    .listByTenant(PLATFORM, 'AccountRequest')
    .map((record) => record.state as unknown as AccountRequest)
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

export function accountRequest(platform: Platform, id: string): AccountRequest {
  const record = platform.ledger.get({ refType: 'AccountRequest', refId: id });
  if (!record) throw new NotFoundError(`No request ${id}`);
  return record.state as unknown as AccountRequest;
}

function commit(platform: Platform, actor: { refType: 'User' | 'System'; refId: string }, request: AccountRequest, act: { eventType: string }): void {
  platform.ledger.commit({
    tenantId: PLATFORM,
    projectId: governance,
    actor,
    source: 'WEB',
    correlationId: ulid(),
    eventType: act.eventType,
    entity: { refType: 'AccountRequest', refId: request.id },
    nextState: { ...request } as unknown as Record<string, unknown>,
  });
}

/** From the public site. Answers the same whether or not the address has asked before. */
export function receiveAccountRequest(
  platform: Platform,
  input: { organisationName: string; contactName: string; email: string; phone?: string; jurisdiction: string; currency: string; kind?: 'ENTERPRISE' | 'GROUP'; companies?: number; message?: string },
): { id: string; receivedAt: string } {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email)) throw new ValidationError('A valid email address is required', [{ field: 'email', message: 'not an address' }]);
  if (input.contactName.trim().length < 2) throw new ValidationError('A contact name is required', [{ field: 'contactName', message: 'too short' }]);
  if (input.organisationName.trim().length < 2) throw new ValidationError('An organisation name is required', [{ field: 'organisationName', message: 'too short' }]);
  if (!JURISDICTIONS[input.jurisdiction]) throw new ValidationError(`${input.jurisdiction} is not a jurisdiction the platform holds rules for`, [{ field: 'jurisdiction', message: 'unknown' }]);
  if (!CURRENCIES[input.currency]) throw new ValidationError(`${input.currency} is not a currency the platform counts in`, [{ field: 'currency', message: 'unknown' }]);
  const companies = Math.max(1, Math.min(5, Math.trunc(input.companies ?? 1)));
  const request: AccountRequest = {
    id: ulid(),
    status: 'NEW',
    organisationName: input.organisationName.trim().slice(0, 200),
    contactName: input.contactName.trim().slice(0, 120),
    email,
    phone: (input.phone ?? '').trim().slice(0, 40),
    jurisdiction: input.jurisdiction,
    currency: input.currency,
    kind: input.kind === 'GROUP' || companies > 1 ? 'GROUP' : 'ENTERPRISE',
    companies,
    message: (input.message ?? '').trim().slice(0, 2000),
    receivedAt: new Date().toISOString(),
    notes: [],
  };
  commit(platform, { refType: 'System', refId: 'public-site' }, request, { eventType: 'ACCOUNT_REQUEST_RECEIVED' });
  return { id: request.id, receivedAt: request.receivedAt };
}

/** Move a request one step: NEW → CONTACTED → QUALIFIED, with a note the record keeps. */
export function advanceAccountRequest(platform: Platform, actor: AuthContext, id: string, input: { status: RequestStatus; note?: string }): AccountRequest {
  const request = accountRequest(platform, id);
  if (input.status === 'PROVISIONED') throw new DomainError('PROVISION_SEPARATELY', 'Provisioning creates the tenancy; use the provision act', 422);
  if (input.status === 'DECLINED') throw new DomainError('DECLINE_SEPARATELY', 'Declining needs a reason; use the decline act', 422);
  if (!NEXT[request.status].includes(input.status)) {
    throw new DomainError('REQUEST_STEP_INVALID', `A ${request.status.toLowerCase()} request cannot move to ${input.status.toLowerCase()}`, 409);
  }
  const next: AccountRequest = {
    ...request,
    status: input.status,
    notes: [...request.notes, { at: new Date().toISOString(), by: actor.actorId, status: input.status, note: (input.note ?? '').trim().slice(0, 1000) }],
  };
  commit(platform, { refType: 'User', refId: actor.actorId }, next, { eventType: 'ACCOUNT_REQUEST_ADVANCED' });
  return next;
}

export function declineAccountRequest(platform: Platform, actor: AuthContext, id: string, reason: string): AccountRequest {
  const request = accountRequest(platform, id);
  if (!NEXT[request.status].includes('DECLINED')) throw new DomainError('REQUEST_STEP_INVALID', `A ${request.status.toLowerCase()} request cannot be declined`, 409);
  if (reason.trim().length < 5) throw new DomainError('REASON_REQUIRED', 'Say why; the record keeps it until the request is deleted');
  const next: AccountRequest = {
    ...request,
    status: 'DECLINED',
    declinedReason: reason.trim().slice(0, 1000),
    notes: [...request.notes, { at: new Date().toISOString(), by: actor.actorId, status: 'DECLINED', note: reason.trim().slice(0, 1000) }],
  };
  commit(platform, { refType: 'User', refId: actor.actorId }, next, { eventType: 'ACCOUNT_REQUEST_DECLINED' });
  return next;
}

/**
 * Delete a declined request. The one place on this platform where a record
 * goes: the person asked once and was told no, and a prospect's name and
 * address are not something to keep. The deletion is itself an event, so the
 * chain still says a request existed and was removed, without the details.
 */
export function deleteAccountRequest(platform: Platform, actor: AuthContext, id: string): { id: string; deletedAt: string } {
  const request = accountRequest(platform, id);
  if (request.status !== 'DECLINED') throw new DomainError('REQUEST_NOT_DECLINED', 'Only a declined request can be deleted', 409);
  const deletedAt = new Date().toISOString();
  const emptied: AccountRequest = {
    ...request,
    organisationName: '(deleted)',
    contactName: '(deleted)',
    email: `deleted-${request.id.slice(-8).toLowerCase()}@invalid`,
    phone: '',
    message: '',
    notes: [],
    declinedReason: '',
  };
  platform.ledger.commit({
    tenantId: PLATFORM,
    projectId: governance,
    actor: { refType: 'User', refId: actor.actorId },
    source: 'WEB',
    correlationId: ulid(),
    eventType: 'ACCOUNT_REQUEST_DELETED',
    entity: { refType: 'AccountRequest', refId: id },
    nextState: { ...emptied, deletedAt } as unknown as Record<string, unknown>,
  });
  return { id, deletedAt };
}

/**
 * One act: the tenancy, its first administrator and the invitation. Refused
 * unless the request is QUALIFIED — a request nobody has spoken to is not
 * provisioned by accident — and refused when the address already holds an
 * identity, because one human is one identity.
 */
export function provisionAccountRequest(
  platform: Platform,
  actor: AuthContext,
  id: string,
  input: { tier: 'ENTERPRISE' | 'BUSINESS' | 'TEAM'; package: PackageTier; enterpriseName?: string },
): { request: AccountRequest; tenantId: string; administratorId: string } {
  const request = accountRequest(platform, id);
  if (request.status !== 'QUALIFIED') throw new DomainError('REQUEST_NOT_QUALIFIED', `Only a qualified request is provisioned; this one is ${request.status.toLowerCase()}`, 409);
  if (platform.userByEmail(request.email)) {
    throw new ValidationError('That address already holds an identity on this platform', [{ field: 'email', message: 'Already in use — one human, one identity' }]);
  }
  const created = platform.createTenant({
    legalName: request.organisationName,
    jurisdiction: request.jurisdiction,
    defaultCurrency: request.currency,
    tier: input.tier,
    package: input.package,
    enterpriseName: input.enterpriseName?.trim() || request.organisationName,
  });
  const administrator = platform.createUser({ tenantId: created.tenant.id, name: request.contactName, email: request.email, roles: ['ENTERPRISE_ADMIN'] });
  const next: AccountRequest = {
    ...request,
    status: 'PROVISIONED',
    provisioned: { tenantId: created.tenant.id, administratorId: administrator.id, at: new Date().toISOString(), notified: 'PENDING' },
    notes: [...request.notes, { at: new Date().toISOString(), by: actor.actorId, status: 'PROVISIONED', note: `Tenancy ${created.tenant.id} on ${input.package}` }],
  };
  commit(platform, { refType: 'User', refId: actor.actorId }, next, { eventType: 'ACCOUNT_REQUEST_PROVISIONED' });
  return { request: next, tenantId: created.tenant.id, administratorId: administrator.id };
}

/** Record how the invitation went, once the notice has been sent or recorded. */
export function recordProvisionNotice(platform: Platform, actor: AuthContext, id: string, notified: string): AccountRequest {
  const request = accountRequest(platform, id);
  if (!request.provisioned) return request;
  const next: AccountRequest = { ...request, provisioned: { ...request.provisioned, notified } };
  commit(platform, { refType: 'User', refId: actor.actorId }, next, { eventType: 'ACCOUNT_REQUEST_ADVANCED' });
  return next;
}
