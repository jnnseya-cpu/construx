import { ulid } from '../core/ids.ts';
import { groupOfTenant, groupRoles, membershipsByEmail } from '../group/directory.ts';
import * as notifyEngine from '../notifications/notify.ts';
import { PLATFORM_BRANDING } from '../notifications/render.ts';
import type { Platform } from '../platform.ts';
import type { WalletSignal } from './acu.ts';

/**
 * Who is told when a company's AI spend crosses a threshold of its monthly
 * limit, or the limit stops it (GN-SPEC-TENANCY-001 §9.3: notify company_admin
 * and group_finance; §11 `usage.threshold`, `usage.limit_reached`).
 *
 * The wallet raises the signal and records nothing about people; this module
 * resolves the people from the record — the company's administrators, and the
 * finance and administrator roles of the group the company is in, each reached
 * at whichever of their memberships is active — and sends the notice through
 * the outbox like every other notice. A company outside any group tells its
 * own administrators only. The same person in two capacities is told once.
 */

export type UsageRecipient = { id: string; name: string; email: string; tenantId: string; because: 'COMPANY_ADMIN' | 'GROUP_FINANCE' | 'GROUP_ADMIN' };

export function usageAlertRecipients(platform: Platform, tenantId: string): UsageRecipient[] {
  const seen = new Set<string>();
  const recipients: UsageRecipient[] = [];
  const add = (recipient: UsageRecipient) => {
    const key = recipient.email.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    recipients.push(recipient);
  };

  for (const user of platform.users(tenantId)) {
    if (user.status !== 'ACTIVE') continue;
    if (!user.roles.includes('ENTERPRISE_ADMIN') && !user.roles.includes('OWNER')) continue;
    add({ id: user.id, name: user.name, email: user.email, tenantId: user.tenantId, because: 'COMPANY_ADMIN' });
  }

  const group = groupOfTenant(platform, tenantId);
  if (!group) return recipients;
  for (const role of groupRoles(platform, group.id)) {
    if (role.revokedAt) continue;
    if (role.role !== 'GROUP_FINANCE' && role.role !== 'GROUP_ADMIN') continue;
    const membership = membershipsByEmail(platform, role.email).find((entry) => entry.active);
    if (!membership) continue;
    const user = platform.user(membership.userId);
    add({ id: user.id, name: user.name, email: user.email, tenantId: user.tenantId, because: role.role });
  }
  return recipients;
}

/**
 * Send the notice for one wallet signal. Returns the dispatch, or null where
 * nobody is there to tell — a tenancy with no administrator yet — which is
 * recorded by the caller and never a failure of the spend that raised it.
 */
export async function notifyWalletSignal(
  platform: Platform,
  tenantId: string,
  signal: WalletSignal,
  correlationId = ulid(),
): Promise<notifyEngine.Dispatch | null> {
  const recipients = usageAlertRecipients(platform, tenantId);
  if (recipients.length === 0) return null;
  const tenant = platform.tenant(tenantId);
  const money = (minor: number) => `${(minor / 100).toFixed(2)}`;

  const payload =
    signal.kind === 'THRESHOLD'
      ? {
          enterprise: tenant.legalName,
          percent: signal.alert.threshold,
          scope: signal.alert.scope.toLowerCase(),
          consumed: money(signal.alert.consumedMinor),
          cap: money(signal.alert.capMinor),
          actionUrl: '/app/billing',
          actionLabel: 'Open ACU & Billing',
          detail:
            `${tenant.legalName} has used ${money(signal.alert.consumedMinor)} of its ${money(signal.alert.capMinor)} monthly AI limit ` +
            `(${signal.alert.threshold}%). ` +
            (signal.alert.threshold >= 100
              ? 'The limit is reached: AI is refused until the limit is raised or the month turns. Everything else keeps working.'
              : 'Raise the limit, top up, or let it run — nothing is charged beyond the limit.'),
        }
      : {
          enterprise: tenant.legalName,
          percent: 100,
          scope: signal.breach.scope.toLowerCase(),
          consumed: money(signal.breach.spentMinor),
          cap: money(signal.breach.capMinor),
          actionUrl: '/app/billing',
          actionLabel: 'Open ACU & Billing',
          detail:
            `An AI request at ${tenant.legalName} was refused: the ${signal.breach.scope.toLowerCase()} limit of ${money(signal.breach.capMinor)} is reached ` +
            `(${money(signal.breach.spentMinor)} spent${signal.breach.scopeId ? ` on ${signal.breach.scopeId}` : ''}; ${money(signal.requestedMinor)} more was asked for). ` +
            'AI is paused under that limit until it is raised or the month turns. Nothing else is affected.',
        };

  return notifyEngine.notify(platform, {
    code: signal.kind === 'THRESHOLD' ? 'acu.threshold' : 'acu.limit_reached',
    recipients: recipients.map(({ id, name, email, tenantId: at }) => ({ id, name, email, tenantId: at })),
    payload,
    branding: platform.exports.brandingIfConfigured(tenantId) ?? PLATFORM_BRANDING,
    actorId: 'billing',
    correlationId,
  });
}
