import { DomainError, ForbiddenError, NotFoundError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { GROUP_LICENCE } from '../billing/seats.ts';
import type { AuthContext } from '../identity/auth.ts';
import type { Platform } from '../platform.ts';
import { attachCompany, detachCompany, groupOf, groupRoles, membershipsByEmail, revokeGroupRole, type ChargeMode } from './directory.ts';
import { revokeGrantsToGroup } from './reporting.ts';
import { revokeSharesWithGroup } from './sharing.ts';

/**
 * Moving a company from one group to another (enterprise specification
 * §16.3): draft → review → scheduled → executing → completed, with failed
 * and cancelled paths.
 *
 * A sale or a regrouping changes who administers a company. It changes
 * nothing about the company: the tenancy id, its people, its records, its
 * wallet, its issued documents and its history all stay exactly where they
 * are. What moves is the effective-dated relation to a group, and with it
 * the things the old group was allowed by that relation — its group roles
 * over this company's people, the reporting grants this company gave it,
 * and the shares between this company and the old group's companies. None
 * of that follows the company into the new group; the new group starts with
 * nothing until it is given something.
 *
 * Nobody in a console moves a company on their own say-so. The platform
 * operator opens and runs the case; the company's own administrator approves
 * it; the effective date is set before anything executes; and the execution
 * checks the destination can take the company before it detaches it from
 * the source, so a case that fails, fails with the company still in one
 * group and never in none or two.
 */

export const TRANSFER_STATUSES = ['DRAFT', 'REVIEW', 'SCHEDULED', 'EXECUTING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export type TransferCase = {
  id: string;
  tenantId: string;
  fromGroupId: string;
  toGroupId: string;
  status: TransferStatus;
  /** The cost centre the company takes in the new group. */
  code: string;
  chargeMode: ChargeMode;
  effectiveAt: string | null;
  reason: string;
  approvals: Array<{ by: string; at: string; capacity: 'OPERATOR' | 'COMPANY_ADMINISTRATOR' }>;
  steps: Array<{ name: string; at: string; outcome: string }>;
  openedBy: string;
  openedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
};

const PLATFORM = 'platform';
const governance = (id: string) => `${id}-governance`;

export function transferCases(platform: Platform): TransferCase[] {
  return platform.ledger
    .listByTenant(PLATFORM, 'TransferCase')
    .map((record) => record.state as unknown as TransferCase)
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt));
}

export function transferCasesFor(platform: Platform, tenantId: string): TransferCase[] {
  return transferCases(platform).filter((held) => held.tenantId === tenantId);
}

export function transferCase(platform: Platform, caseId: string): TransferCase {
  const record = platform.ledger.get({ refType: 'TransferCase', refId: caseId });
  if (!record) throw new NotFoundError(`No transfer case ${caseId}`);
  return record.state as unknown as TransferCase;
}

function commit(platform: Platform, actorId: string, held: TransferCase, eventType: 'TRANSFER_CASE_OPENED' | 'TRANSFER_CASE_ADVANCED' | 'TRANSFER_CASE_FAILED' | 'TRANSFER_CASE_COMPLETED'): TransferCase {
  platform.ledger.commit({
    tenantId: PLATFORM,
    projectId: governance(PLATFORM),
    actor: { refType: 'User', refId: actorId },
    source: 'WEB',
    correlationId: ulid(),
    eventType,
    entity: { refType: 'TransferCase', refId: held.id },
    nextState: { ...held } as unknown as Record<string, unknown>,
  });
  return held;
}

function step(held: TransferCase, name: string, outcome: string): TransferCase {
  const at = new Date().toISOString();
  return { ...held, steps: [...held.steps, { name, at, outcome }], updatedAt: at };
}

/** What the destination would refuse, checked before anything moves. */
function preflight(platform: Platform, held: TransferCase): string[] {
  const problems: string[] = [];
  const tenant = platform.tenant(held.tenantId);
  if (tenant.closedAt) problems.push('the company is closed');
  if (tenant.groupId !== held.fromGroupId) problems.push('the company is no longer in the group the case names');
  const to = groupOf(platform, held.toGroupId);
  if (to.status !== 'ACTIVE') problems.push(`${to.displayName} is ${to.status.toLowerCase()}`);
  if (to.costCentres.length >= GROUP_LICENCE.maxCompanies) problems.push(`${to.displayName} already holds ${GROUP_LICENCE.maxCompanies} companies`);
  if (to.costCentres.some((centre) => centre.code === held.code)) problems.push(`cost centre code ${held.code} is already in use in ${to.displayName}`);
  return problems;
}

/** The operator opens the case as a draft. Nothing about the company changes. */
export function openTransferCase(
  platform: Platform,
  actor: AuthContext,
  input: { tenantId: string; toGroupId: string; code: string; chargeMode?: ChargeMode; reason: string; effectiveAt?: string },
): TransferCase {
  const tenant = platform.tenant(input.tenantId);
  if (!tenant.groupId) throw new DomainError('NOT_IN_GROUP', `${tenant.legalName} is not in a group; bring it into one rather than transferring it`, 422);
  if (tenant.groupId === input.toGroupId) throw new DomainError('SAME_GROUP', `${tenant.legalName} is already in that group`, 409);
  groupOf(platform, input.toGroupId);
  if (transferCasesFor(platform, tenant.id).some((held) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(held.status))) {
    throw new DomainError('TRANSFER_OPEN', `${tenant.legalName} already has an open transfer case`, 409);
  }
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(code)) throw new DomainError('COST_CENTRE_CODE_INVALID', 'A cost centre code is 2 to 8 letters or digits');
  if (input.reason.trim().length < 10) throw new DomainError('REASON_REQUIRED', 'Say why the company is moving; the case keeps it');
  if (input.effectiveAt !== undefined && Number.isNaN(Date.parse(input.effectiveAt))) throw new DomainError('EFFECTIVE_AT_INVALID', 'effectiveAt is an ISO date-time');
  const now = new Date().toISOString();
  const held: TransferCase = {
    id: ulid(),
    tenantId: tenant.id,
    fromGroupId: tenant.groupId,
    toGroupId: input.toGroupId,
    status: 'DRAFT',
    code,
    chargeMode: input.chargeMode ?? 'INTERNAL',
    effectiveAt: input.effectiveAt ? new Date(input.effectiveAt).toISOString() : null,
    reason: input.reason.trim().slice(0, 1000),
    approvals: [],
    steps: [{ name: 'OPENED', at: now, outcome: 'Draft opened by the platform operator' }],
    openedBy: actor.actorId,
    openedAt: now,
    updatedAt: now,
  };
  return commit(platform, actor.actorId, held, 'TRANSFER_CASE_OPENED');
}

/** Into review: the destination is checked and the company's administrator is asked. */
export function reviewTransferCase(platform: Platform, actor: AuthContext, caseId: string): TransferCase {
  const held = transferCase(platform, caseId);
  if (held.status !== 'DRAFT') throw new DomainError('TRANSFER_STEP_INVALID', `A ${held.status.toLowerCase()} case is not put into review`, 409);
  const problems = preflight(platform, held);
  if (problems.length > 0) throw new DomainError('TRANSFER_NOT_POSSIBLE', `The destination cannot take the company: ${problems.join('; ')}`, 409);
  const next = step({ ...held, status: 'REVIEW', approvals: [...held.approvals, { by: actor.actorId, at: new Date().toISOString(), capacity: 'OPERATOR' }] }, 'REVIEW', 'Destination checked; awaiting the company administrator');
  return commit(platform, actor.actorId, next, 'TRANSFER_CASE_ADVANCED');
}

/** The company's own administrator approves — the recorded governance the spec requires, not a group owner's say-so. */
export function approveTransferCase(platform: Platform, actor: AuthContext, caseId: string): TransferCase {
  const held = transferCase(platform, caseId);
  if (held.tenantId !== actor.tenantId) throw new ForbiddenError('This case concerns another company', 'NOT_YOUR_CASE');
  if (held.status !== 'REVIEW') throw new DomainError('TRANSFER_STEP_INVALID', `A ${held.status.toLowerCase()} case is not approved`, 409);
  if (held.approvals.some((approval) => approval.capacity === 'COMPANY_ADMINISTRATOR')) throw new DomainError('TRANSFER_APPROVED', 'The company has already approved', 409);
  const next = step({ ...held, approvals: [...held.approvals, { by: actor.actorId, at: new Date().toISOString(), capacity: 'COMPANY_ADMINISTRATOR' }] }, 'COMPANY_APPROVAL', 'Approved by the company administrator');
  return commit(platform, actor.actorId, next, 'TRANSFER_CASE_ADVANCED');
}

/** Fix the effective date. Needs the company's approval. */
export function scheduleTransferCase(platform: Platform, actor: AuthContext, caseId: string, effectiveAt: string): TransferCase {
  const held = transferCase(platform, caseId);
  if (held.status !== 'REVIEW') throw new DomainError('TRANSFER_STEP_INVALID', `A ${held.status.toLowerCase()} case is not scheduled`, 409);
  if (!held.approvals.some((approval) => approval.capacity === 'COMPANY_ADMINISTRATOR')) {
    throw new DomainError('COMPANY_APPROVAL_REQUIRED', 'The company\'s administrator approves the move before it is scheduled', 409);
  }
  if (Number.isNaN(Date.parse(effectiveAt))) throw new DomainError('EFFECTIVE_AT_INVALID', 'effectiveAt is an ISO date-time');
  const next = step({ ...held, status: 'SCHEDULED', effectiveAt: new Date(effectiveAt).toISOString() }, 'SCHEDULED', `Effective ${new Date(effectiveAt).toISOString()}`);
  return commit(platform, actor.actorId, next, 'TRANSFER_CASE_ADVANCED');
}

export function cancelTransferCase(platform: Platform, actor: AuthContext, caseId: string, reason: string): TransferCase {
  const held = transferCase(platform, caseId);
  if (['EXECUTING', 'COMPLETED', 'CANCELLED'].includes(held.status)) throw new DomainError('TRANSFER_STEP_INVALID', `A ${held.status.toLowerCase()} case is not cancelled`, 409);
  const next = step({ ...held, status: 'CANCELLED' }, 'CANCELLED', reason.trim().slice(0, 500) || 'Cancelled');
  return commit(platform, actor.actorId, next, 'TRANSFER_CASE_ADVANCED');
}

/**
 * The cutover, in one authoritative sequence: check the destination again,
 * close the old relation and everything it carried, open the new one. A
 * failed check leaves the company where it was, with the case marked failed
 * and the reason on it; the case can be reopened by cancelling and opening
 * another once the obstacle is gone.
 */
export function executeTransferCase(platform: Platform, actor: AuthContext, caseId: string, now = new Date()): TransferCase {
  const held = transferCase(platform, caseId);
  if (held.status !== 'SCHEDULED') throw new DomainError('TRANSFER_STEP_INVALID', `A ${held.status.toLowerCase()} case is not executed`, 409);
  if (held.effectiveAt && held.effectiveAt > now.toISOString()) throw new DomainError('TRANSFER_NOT_DUE', `The move is effective ${held.effectiveAt}; it is not due yet`, 409);

  const problems = preflight(platform, held);
  if (problems.length > 0) {
    const failed = step({ ...held, status: 'FAILED', error: problems.join('; ') }, 'PREFLIGHT', `Refused before any change: ${problems.join('; ')}`);
    return commit(platform, actor.actorId, failed, 'TRANSFER_CASE_FAILED');
  }

  let current = commit(platform, actor.actorId, step({ ...held, status: 'EXECUTING' }, 'EXECUTING', 'Cutover started'), 'TRANSFER_CASE_ADVANCED');
  const from = groupOf(platform, held.fromGroupId);
  const fromTenantIds = from.costCentres.map((centre) => centre.tenantId);
  const tenant = platform.tenant(held.tenantId);

  // The old group's reach into this company ends: reporting grants to it,
  // shares with its companies, and group roles held by people whose only
  // standing in the old group was through this company.
  const grants = revokeGrantsToGroup(platform, actor, held.tenantId, held.fromGroupId);
  const shares = revokeSharesWithGroup(platform, actor, held.tenantId, fromTenantIds);
  let roles = 0;
  const remaining = new Set(fromTenantIds.filter((id) => id !== held.tenantId));
  for (const role of groupRoles(platform, held.fromGroupId)) {
    const elsewhere = membershipsByEmail(platform, role.email).some((membership) => remaining.has(membership.tenantId));
    if (elsewhere) continue;
    try {
      revokeGroupRole(platform, actor, held.fromGroupId, role.id);
      roles += 1;
    } catch (error) {
      // The last administrator of the old group stays; the group cannot be left with none.
      if (!(error instanceof DomainError && error.code === 'LAST_GROUP_ADMIN')) throw error;
    }
  }
  current = commit(platform, actor.actorId, step(current, 'OLD_GROUP_REVOKED', `${grants} reporting grant(s), ${shares} share(s), ${roles} group role(s) ended`), 'TRANSFER_CASE_ADVANCED');

  detachCompany(platform, actor, held.fromGroupId, held.tenantId, `Transfer case ${held.id}: ${held.reason}`);
  current = commit(platform, actor.actorId, step(current, 'DETACHED', `Left ${from.displayName}`), 'TRANSFER_CASE_ADVANCED');

  try {
    attachCompany(platform, actor, held.toGroupId, { tenantId: held.tenantId, code: held.code, chargeMode: held.chargeMode });
  } catch (error) {
    // Checked a moment ago, so this is the platform changing under the
    // case. The company stands alone — in one group at most, never two — and
    // the case says so, so the recovery is a visible act, not a guess.
    const message = error instanceof Error ? error.message : String(error);
    const failed = step({ ...current, status: 'FAILED', error: `Detached from ${from.displayName} but not attached: ${message}` }, 'ATTACH', `Failed: ${message}. ${tenant.legalName} stands alone until brought into a group.`);
    return commit(platform, actor.actorId, failed, 'TRANSFER_CASE_FAILED');
  }
  const done = step({ ...current, status: 'COMPLETED', completedAt: new Date().toISOString() }, 'ATTACHED', `Joined ${groupOf(platform, held.toGroupId).displayName} as ${held.code}`);
  return commit(platform, actor.actorId, done, 'TRANSFER_CASE_COMPLETED');
}
