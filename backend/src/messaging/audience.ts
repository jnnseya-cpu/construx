import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.ts';
import { ulid } from '../core/ids.ts';
import { DomainError } from '../core/errors.ts';
import type { Platform, PlatformUser } from '../platform.ts';
import { PLATFORM_TENANT_ID } from '../platform.ts';
import type { Role } from '../identity/roles.ts';

/**
 * Who receives the newsletter, and the record of why they were entitled to.
 *
 * Consent lives in the ledger rather than on the user object, because "did this
 * person agree, when, and through what" is a question asked months later by
 * someone who was not there. A boolean on a mutable record cannot answer it; an
 * append-only chain can.
 *
 * The relationship being recorded is between the platform and a person, not
 * between a tenant and a person, so it is filed under the platform's own chain.
 * The operator already holds every user's address by virtue of onboarding them,
 * so this concentrates nothing that was not already concentrated.
 */

/** The reserved chain that platform-to-person messaging is recorded on. */
export const MARKETING_PROJECT_ID = 'platform-marketing';

export type ConsentSource = 'DEFAULT' | 'SIGNUP' | 'PREFERENCE_PAGE' | 'UNSUBSCRIBE_LINK' | 'OPERATOR';

export type MarketingConsent = {
  id: string;
  userId: string;
  tenantId: string;
  email: string;
  subscribed: boolean;
  source: ConsentSource;
  decidedAt: string;
  /** Free-text only when a person gave one. Never invented. */
  note?: string;
};

export type Recipient = {
  userId: string;
  tenantId: string;
  name: string;
  email: string;
  roles: Role[];
};

/**
 * An address the relay has refused permanently.
 *
 * One record per address, written by the issue that met the refusal and lifted
 * only by an operator. Derived here from the record rather than kept as a
 * list, so a restart cannot forget who bounced.
 */
export type Suppression = {
  id: string;
  email: string;
  userId: string;
  campaignId: string;
  /** The relay's reply, verbatim. */
  detail: string;
  status: 'ACTIVE' | 'CLEARED';
  suppressedAt: string;
  clearedAt?: string;
  clearedBy?: string;
};

/** Every address currently suppressed, keyed by the lower-cased address. */
export function suppressedAddresses(platform: Platform): Map<string, Suppression> {
  const held = new Map<string, Suppression>();
  for (const record of platform.ledger.list(MARKETING_PROJECT_ID, 'NewsletterSuppression')) {
    const suppression = record.state as unknown as Suppression;
    if (suppression.status === 'ACTIVE') held.set(suppression.email.trim().toLowerCase(), suppression);
  }
  return held;
}

/** Why a registered user is not in the audience. Shown, never silently applied. */
export type Exclusion = {
  userId: string;
  name: string;
  reason: 'UNSUBSCRIBED' | 'ROLE_EXCLUDED' | 'SUSPENDED' | 'NO_EMAIL' | 'NOT_YET_OPTED_IN' | 'SUPPRESSED';
  /** For a suppression: the server's own words, so the operator can judge whether to try again. */
  detail?: string;
};

// --- Consent ----------------------------------------------------------------

function consentRefId(userId: string): string {
  // One consent record per person, updated in place, so the entity's own history
  // is the consent history rather than a scatter of unrelated records.
  return `consent-${userId}`;
}

/** The recorded decision for a user, or undefined if they have never expressed one. */
export function readConsent(platform: Platform, userId: string): MarketingConsent | undefined {
  const record = platform.ledger.get({ refType: 'MarketingConsent', refId: consentRefId(userId) });
  return record?.state as unknown as MarketingConsent | undefined;
}

/**
 * Record a subscription decision.
 *
 * `actorId` is the person whose decision it is. The operator may record one on
 * someone's behalf — a phone request, a bounced address — but it is written as
 * an operator action so the distinction survives.
 */
export function setConsent(
  platform: Platform,
  input: { user: PlatformUser; subscribed: boolean; source: ConsentSource; actorId?: string; note?: string },
): MarketingConsent {
  const existing = readConsent(platform, input.user.id);

  const consent: MarketingConsent = {
    id: existing?.id ?? ulid(),
    userId: input.user.id,
    tenantId: input.user.tenantId,
    email: input.user.email,
    subscribed: input.subscribed,
    source: input.source,
    decidedAt: new Date().toISOString(),
    ...(input.note ? { note: input.note } : {}),
  };

  platform.ledger.commit({
    tenantId: PLATFORM_TENANT_ID,
    projectId: MARKETING_PROJECT_ID,
    actor: input.actorId ? { refType: 'User', refId: input.actorId } : { refType: 'System', refId: 'platform' },
    source: 'SYSTEM',
    correlationId: ulid(),
    eventType: 'MARKETING_CONSENT_SET',
    entity: { refType: 'MarketingConsent', refId: consentRefId(input.user.id) },
    nextState: consent as unknown as Record<string, unknown>,
  });

  return consent;
}

// --- Unsubscribe tokens -----------------------------------------------------

/**
 * A signed unsubscribe token.
 *
 * Unsubscribing cannot require signing in — a person who wants out is the least
 * likely to remember a password, and a link that demands one is the reason
 * people press "spam" instead. So the link carries proof of itself: an HMAC
 * over the user id under the platform's signing key. It authorises exactly one
 * thing, cannot be enumerated, and grants no read access.
 */
export function unsubscribeToken(userId: string): string {
  return createHmac('sha256', config.auth.jwtSecret).update(`unsubscribe:${userId}`).digest('base64url');
}

export function verifyUnsubscribeToken(userId: string, token: string): boolean {
  const expected = Buffer.from(unsubscribeToken(userId));
  const supplied = Buffer.from(String(token ?? ''));
  // Length must match before timingSafeEqual, which throws on unequal buffers.
  if (expected.length !== supplied.length) return false;
  return timingSafeEqual(expected, supplied);
}

export function unsubscribeUrl(userId: string): string {
  const params = new URLSearchParams({ u: userId, t: unsubscribeToken(userId) });
  return `${config.publicBaseUrl}/unsubscribe?${params.toString()}`;
}

/**
 * Resolve a signed link back to the user, refusing a forged one.
 *
 * A bad signature and an unknown user id return the same error deliberately —
 * distinguishing them would turn the endpoint into a check for whether a given
 * id is registered.
 */
export function resolveUnsubscribe(platform: Platform, userId: string, token: string): PlatformUser {
  const invalid = new DomainError('INVALID_UNSUBSCRIBE_TOKEN', 'This unsubscribe link is not valid', 400);
  if (!verifyUnsubscribeToken(userId, token)) throw invalid;
  try {
    return platform.user(userId);
  } catch {
    throw invalid;
  }
}

// --- Audience ---------------------------------------------------------------

function excludedByRole(roles: Role[]): boolean {
  return roles.some((role) => config.newsletter.excludedRoles.includes(role));
}

/**
 * Everyone who should receive the next issue, and everyone who should not with
 * the reason why.
 *
 * The exclusions are returned rather than filtered away because an audience
 * that silently shrinks is indistinguishable from one that is broken. The
 * operator screen shows both counts.
 */
export function resolveAudience(platform: Platform): { recipients: Recipient[]; excluded: Exclusion[] } {
  const recipients: Recipient[] = [];
  const excluded: Exclusion[] = [];
  const suppressed = suppressedAddresses(platform);

  for (const user of platform.allUsers()) {
    const consent = readConsent(platform, user.id);

    if (user.status !== 'ACTIVE') {
      excluded.push({ userId: user.id, name: user.name, reason: 'SUSPENDED' });
      continue;
    }
    if (!user.email || !user.email.includes('@')) {
      excluded.push({ userId: user.id, name: user.name, reason: 'NO_EMAIL' });
      continue;
    }
    if (excludedByRole(user.roles)) {
      excluded.push({ userId: user.id, name: user.name, reason: 'ROLE_EXCLUDED' });
      continue;
    }
    const suppression = suppressed.get(user.email.trim().toLowerCase());
    if (suppression) {
      // The address bounced permanently on an earlier issue. Sending again is
      // what gets a sender blocklisted; the operator lifts it deliberately.
      excluded.push({ userId: user.id, name: user.name, reason: 'SUPPRESSED', detail: suppression.detail });
      continue;
    }
    if (consent && !consent.subscribed) {
      excluded.push({ userId: user.id, name: user.name, reason: 'UNSUBSCRIBED' });
      continue;
    }
    if (!consent && !config.newsletter.defaultSubscribed) {
      excluded.push({ userId: user.id, name: user.name, reason: 'NOT_YET_OPTED_IN' });
      continue;
    }

    recipients.push({
      userId: user.id,
      tenantId: user.tenantId,
      name: user.name,
      email: user.email,
      roles: user.roles,
    });
  }

  return { recipients, excluded };
}
