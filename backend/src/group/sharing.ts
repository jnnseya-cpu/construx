import { DomainError, ForbiddenError, NotFoundError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import type { AuthContext } from '../identity/auth.ts';
import { classifyEntity } from '../identity/entityAccess.ts';
import type { Platform } from '../platform.ts';
import { groupOfTenant } from './directory.ts';

/**
 * Controlled sharing between companies in a group (§7.1).
 *
 * Two companies working one project — one providing site services on the
 * other's job — share by explicit grant on specific records. Nothing else
 * crosses the boundary: not by being in the same group, not by a person
 * holding memberships in both, not by a group role. Ownership never moves;
 * a share is read-only, expires, can be revoked, and the grantee reads the
 * record through a route of its own that checks the share on every read and
 * renders it with the owner's branding and a "shared by" marker.
 *
 * Deliberately not wired into the generic entity read. That read is the
 * isolation boundary, and a share is an exception to it that has to be
 * visible as one: a separate route, a separate record, its own events.
 */

export type RecordShare = {
  id: string;
  ownerTenantId: string;
  granteeTenantId: string;
  projectId: string;
  refType: string;
  refId: string;
  permission: 'READ';
  grantedBy: string;
  grantedAt: string;
  expiresAt: string | null;
  note: string;
  revokedAt?: string;
  revokedBy?: string;
};

/** What a share may not cover: a whole company's commercial position is not a record somebody works on together. */
const UNSHAREABLE = new Set(['Tenant', 'Subscription', 'ACUWallet', 'User', 'ClientBrandingRecord', 'IssuerProfile', 'Group', 'GroupRole', 'RecordShare', 'SupportAccessGrant', 'ApiKey', 'WebhookSubscription']);

const governance = (tenantId: string) => `${tenantId}-governance`;

export function sharesGiven(platform: Platform, tenantId: string): RecordShare[] {
  return platform.ledger.listByTenant(tenantId, 'RecordShare').map((record) => record.state as unknown as RecordShare);
}

export function sharesReceived(platform: Platform, tenantId: string): RecordShare[] {
  return platform.ledger
    .entitiesOfType('RecordShare')
    .map((record) => record.state as unknown as RecordShare)
    .filter((share) => share.granteeTenantId === tenantId);
}

export function shareIsLive(share: RecordShare, now = new Date()): boolean {
  if (share.revokedAt) return false;
  if (share.expiresAt && share.expiresAt <= now.toISOString()) return false;
  return true;
}

/**
 * Grant another company in the group read on one record of ours. The record
 * must exist here, be a kind of thing that is shared, and the grantee must be
 * a company in the same group.
 */
export function shareRecord(
  platform: Platform,
  actor: AuthContext,
  input: { granteeTenantId: string; refType: string; refId: string; expiresAt?: string; note?: string },
): RecordShare {
  const group = groupOfTenant(platform, actor.tenantId);
  if (!group) throw new DomainError('NOT_IN_GROUP', 'Sharing between companies is a group feature; this company is not in a group', 422);
  if (input.granteeTenantId === actor.tenantId) throw new DomainError('SHARE_WITH_SELF', 'A company cannot share a record with itself');
  if (!group.costCentres.some((centre) => centre.tenantId === input.granteeTenantId)) {
    throw new DomainError('GRANTEE_NOT_IN_GROUP', 'Records are shared only with companies in the same group', 422);
  }
  if (UNSHAREABLE.has(input.refType) || !classifyEntity(input.refType)) {
    throw new DomainError('RECORD_NOT_SHAREABLE', `${input.refType} is not a record that can be shared`, 422);
  }
  const record = platform.ledger.get({ refType: input.refType, refId: input.refId });
  if (!record || record.tenantId !== actor.tenantId) throw new NotFoundError(`No ${input.refType} ${input.refId} in this company`);
  if (input.expiresAt !== undefined) {
    if (Number.isNaN(Date.parse(input.expiresAt))) throw new DomainError('EXPIRY_INVALID', 'expiresAt is an ISO date-time');
    if (input.expiresAt <= new Date().toISOString()) throw new DomainError('EXPIRY_PAST', 'A share cannot expire in the past');
  }
  const duplicate = sharesGiven(platform, actor.tenantId).find(
    (share) => shareIsLive(share) && share.granteeTenantId === input.granteeTenantId && share.refType === input.refType && share.refId === input.refId,
  );
  if (duplicate) throw new DomainError('ALREADY_SHARED', 'That record is already shared with that company', 409);

  const share: RecordShare = {
    id: ulid(),
    ownerTenantId: actor.tenantId,
    granteeTenantId: input.granteeTenantId,
    projectId: record.projectId,
    refType: input.refType,
    refId: input.refId,
    permission: 'READ',
    grantedBy: actor.actorId,
    grantedAt: new Date().toISOString(),
    expiresAt: input.expiresAt ?? null,
    note: input.note?.trim() ?? '',
  };
  platform.ledger.commit({
    tenantId: actor.tenantId,
    projectId: governance(actor.tenantId),
    actor: { refType: 'User', refId: actor.actorId },
    source: 'WEB',
    correlationId: ulid(),
    eventType: 'RECORD_SHARED',
    entity: { refType: 'RecordShare', refId: share.id },
    nextState: { ...share },
  });
  return share;
}

export function revokeShare(platform: Platform, actor: AuthContext, shareId: string): RecordShare {
  const record = platform.ledger.get({ refType: 'RecordShare', refId: shareId });
  if (!record || record.tenantId !== actor.tenantId) throw new NotFoundError(`No share ${shareId} given by this company`);
  const share = record.state as unknown as RecordShare;
  if (share.revokedAt) throw new DomainError('SHARE_REVOKED', 'That share is already revoked', 409);
  const revoked: RecordShare = { ...share, revokedAt: new Date().toISOString(), revokedBy: actor.actorId };
  platform.ledger.commit({
    tenantId: actor.tenantId,
    projectId: governance(actor.tenantId),
    actor: { refType: 'User', refId: actor.actorId },
    source: 'WEB',
    correlationId: ulid(),
    eventType: 'RECORD_SHARE_REVOKED',
    entity: { refType: 'RecordShare', refId: shareId },
    nextState: { ...revoked },
  });
  return revoked;
}

/**
 * Read a record shared with us. Refused unless the share names our company,
 * is live, and still points at a record the owner holds. What comes back is
 * the record, the owner's brand and name for rendering, and the marker.
 */
export function readSharedRecord(
  platform: Platform,
  actor: AuthContext,
  shareId: string,
): { share: RecordShare; sharedBy: { tenantId: string; name: string; branding: unknown }; record: Record<string, unknown> } {
  const record = platform.ledger.get({ refType: 'RecordShare', refId: shareId });
  if (!record) throw new NotFoundError(`No share ${shareId}`);
  const share = record.state as unknown as RecordShare;
  if (share.granteeTenantId !== actor.tenantId) throw new ForbiddenError('That record was not shared with this company', 'NOT_SHARED_WITH_YOU');
  if (!shareIsLive(share)) throw new ForbiddenError('That share has ended', 'SHARE_ENDED');
  const target = platform.ledger.get({ refType: share.refType, refId: share.refId });
  if (!target || target.tenantId !== share.ownerTenantId) throw new NotFoundError('The shared record no longer exists');
  const owner = platform.tenant(share.ownerTenantId);
  return {
    share,
    sharedBy: { tenantId: owner.id, name: owner.legalName, branding: platform.exports.brandingIfConfigured(owner.id) ?? null },
    record: target.state,
  };
}
