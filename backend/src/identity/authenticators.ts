import { createHash, timingSafeEqual } from 'node:crypto';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { decrypt, encrypt, enabled as encryptionEnabled } from '../evidence/envelope.ts';
import { clearFailures, lockState, recordFailure } from './lockout.ts';
import {
  generateRecoveryCodes,
  generateSecret,
  matchTotp,
  normaliseRecoveryCode,
  otpauthUri,
  totp,
} from './totp.ts';

/**
 * Authenticator apps as a second factor.
 *
 * The emailed code proves the person holds the mailbox. An authenticator app
 * proves they hold a device with a secret shared once at enrolment — a second
 * thing, of a different kind, which is what "second factor" means. Passkeys do
 * the same and better; this exists because every organisation already has
 * phones with an authenticator on them, and an enterprise requirement of
 * "everybody has a second factor" has to be one everybody can meet today.
 *
 * Like `devices.ts` and `passkeys.ts`, this module does not import the ledger.
 * It is consulted at sign-in, before any engine context exists, so it declares a
 * narrow store and `credentialstore.ts` satisfies it against the ledger.
 *
 * ## What is kept, and how
 *
 * The secret is kept encrypted with the tenancy's data key where the
 * deployment has an evidence master key, and in the clear where it does not —
 * stated on the record (`secretProtected`) rather than hidden, because a
 * deployment should know which it is. The last counter accepted is kept so a
 * code is accepted once: the same six digits offered twice inside the thirty
 * seconds they are valid is a replay, and a replay is refused. Recovery codes
 * are kept as SHA-256 digests; the codes themselves are shown once.
 *
 * ## Enrolment is two steps
 *
 * Beginning enrolment produces a secret and hands it to the person; nothing is
 * recorded. Confirming it with a code the app produced is what enrols — an
 * authenticator that was never proved to hold the secret would be a second
 * factor nobody could pass, which is a locked door rather than a safe one.
 * Pending enrolments live in memory and die after ten minutes.
 */

export type AuthenticatorRecord = {
  id: string;
  actorId: string;
  tenantId: string;
  label: string;
  /** The shared secret, base32; ciphertext (base64, `enc:` prefix) where the deployment encrypts at rest. */
  secret: string;
  secretProtected: boolean;
  /** The last time-step counter a code was accepted for. A code at or before it is refused. */
  lastCounter: number;
  enrolledAt: string;
  lastUsedAt?: string;
  recoveryCodeHashes: string[];
  recoveryCodesIssuedAt: string;
  revokedAt?: string;
  revokedBy?: string;
};

export type AuthenticatorStore = {
  /** The live authenticator for a person, if any. */
  forActor(actorId: string): AuthenticatorRecord | undefined;
  forTenant(tenantId: string): AuthenticatorRecord[];
  put(record: AuthenticatorRecord, event: 'ENROLLED' | 'USED' | 'RECOVERY_CODES_ISSUED' | 'REVOKED'): void;
};

/** In-memory until `credentialstore.ts` binds the ledger — the same shape the other credential modules use. */
function memoryStore(): AuthenticatorStore {
  const records = new Map<string, AuthenticatorRecord>();
  return {
    forActor: (actorId) => [...records.values()].find((record) => record.actorId === actorId && !record.revokedAt),
    forTenant: (tenantId) => [...records.values()].filter((record) => record.tenantId === tenantId),
    put: (record) => void records.set(record.id, { ...record }),
  };
}

let store: AuthenticatorStore = memoryStore();

/**
 * The clock every time-based check reads. Real time in production; a test
 * steps it forward thirty seconds at a time so that one run can exercise
 * several codes without waiting for the wall clock, and so the replay rule
 * stays exactly as strict as it is for a real phone.
 */
let clock: () => Date = () => new Date();

export function useAuthenticatorStore(next: AuthenticatorStore): void {
  store = next;
}

export function useAuthenticatorClock(next?: () => Date): void {
  clock = next ?? (() => new Date());
}

export function resetAuthenticators(): void {
  store = memoryStore();
  pending.clear();
  clock = () => new Date();
}

// --- the secret at rest -----------------------------------------------------

const ENC_PREFIX = 'enc:';

function protect(tenantId: string, secretBase32: string): { secret: string; secretProtected: boolean } {
  if (!encryptionEnabled()) return { secret: secretBase32, secretProtected: false };
  return { secret: `${ENC_PREFIX}${encrypt(tenantId, Buffer.from(secretBase32, 'utf8')).toString('base64')}`, secretProtected: true };
}

function reveal(record: AuthenticatorRecord): string {
  if (!record.secret.startsWith(ENC_PREFIX)) return record.secret;
  return decrypt(record.tenantId, Buffer.from(record.secret.slice(ENC_PREFIX.length), 'base64')).toString('utf8');
}

function digest(code: string): string {
  return createHash('sha256').update(normaliseRecoveryCode(code)).digest('hex');
}

// --- enrolment ----------------------------------------------------------------

type PendingEnrolment = { actorId: string; tenantId: string; label: string; secret: string; expiresAt: number };

const pending = new Map<string, PendingEnrolment>();
const PENDING_TTL_MS = 10 * 60 * 1000;

export type EnrolmentStart = {
  enrolmentId: string;
  /** The secret, base32, for typing into an app by hand. Shown once. */
  secret: string;
  /** The otpauth:// address an app scans or opens. */
  uri: string;
  expiresAt: string;
};

/**
 * Begin enrolling an authenticator. Nothing is recorded until a code proves the
 * app holds the secret. A person already enrolled must revoke first: two live
 * authenticators is a second factor with two answers.
 */
export function beginEnrolment(input: { actorId: string; tenantId: string; account: string; issuer: string; label?: string }): EnrolmentStart {
  if (store.forActor(input.actorId)) {
    throw new DomainError('AUTHENTICATOR_ALREADY_ENROLLED', 'An authenticator app is already enrolled. Remove it before enrolling another.', 409);
  }
  const secret = generateSecret();
  const enrolmentId = ulid();
  const expiresAt = clock().getTime() + PENDING_TTL_MS;
  pending.set(enrolmentId, { actorId: input.actorId, tenantId: input.tenantId, label: input.label?.trim() || 'Authenticator app', secret, expiresAt });
  return { enrolmentId, secret, uri: otpauthUri(input.issuer, input.account, secret), expiresAt: new Date(expiresAt).toISOString() };
}

export type EnrolmentResult = { authenticator: PublicAuthenticator; recoveryCodes: string[] };

/**
 * Confirm enrolment with a code the app produced. The recovery codes are
 * returned exactly once, here.
 */
export function confirmEnrolment(input: { actorId: string; enrolmentId: string; code: string }, now = clock()): EnrolmentResult {
  const started = pending.get(input.enrolmentId);
  if (!started || started.actorId !== input.actorId) {
    throw new DomainError('AUTHENTICATOR_ENROLMENT_UNKNOWN', 'That enrolment does not exist or has expired. Start again.', 404);
  }
  if (started.expiresAt < now.getTime()) {
    pending.delete(input.enrolmentId);
    throw new DomainError('AUTHENTICATOR_ENROLMENT_EXPIRED', 'That enrolment expired. Start again.', 410);
  }
  const counter = matchTotp(started.secret, input.code, now.getTime());
  if (counter === null) {
    throw new DomainError('AUTHENTICATOR_CODE_WRONG', 'That code did not match. Check the app shows CONSTRUX and try the next code.', 422);
  }
  pending.delete(input.enrolmentId);

  const recoveryCodes = generateRecoveryCodes();
  const record: AuthenticatorRecord = {
    id: ulid(),
    actorId: started.actorId,
    tenantId: started.tenantId,
    label: started.label,
    ...protect(started.tenantId, started.secret),
    lastCounter: counter,
    enrolledAt: now.toISOString(),
    recoveryCodeHashes: recoveryCodes.map(digest),
    recoveryCodesIssuedAt: now.toISOString(),
  };
  store.put(record, 'ENROLLED');
  return { authenticator: publicView(record), recoveryCodes };
}

// --- verification -------------------------------------------------------------

export type FactorOutcome = { ok: true; method: 'AUTHENTICATOR' | 'RECOVERY_CODE'; recoveryCodesLeft: number } | { ok: false };

/**
 * Offer a code — six digits from the app, or a recovery code — for a person.
 *
 * One `false` for every refusal, for the reason `verifyMfaChallenge` gives:
 * wrong, replayed, locked and not-enrolled must be indistinguishable to whoever
 * is guessing. Failures count against the identity's lock like first-factor
 * failures do, so a guessing run against the second factor is stopped by the
 * same control.
 */
export function verifyFactor(actorId: string, code: string, now = clock()): FactorOutcome {
  if (lockState(actorId).locked) return { ok: false };
  const record = store.forActor(actorId);
  if (!record) {
    recordFailure(actorId);
    return { ok: false };
  }

  const offered = code.trim();
  if (/^\d{6}$/.test(offered.replace(/\s+/g, ''))) {
    const counter = matchTotp(reveal(record), offered, now.getTime());
    // At or before the last accepted counter is a replay, however right the
    // digits are.
    if (counter !== null && counter > record.lastCounter) {
      store.put({ ...record, lastCounter: counter, lastUsedAt: now.toISOString() }, 'USED');
      clearFailures(actorId);
      return { ok: true, method: 'AUTHENTICATOR', recoveryCodesLeft: record.recoveryCodeHashes.length };
    }
  } else {
    const hash = digest(offered);
    const index = record.recoveryCodeHashes.findIndex((held) => held.length === hash.length && timingSafeEqual(Buffer.from(held), Buffer.from(hash)));
    if (index >= 0) {
      const remaining = record.recoveryCodeHashes.filter((_, position) => position !== index);
      store.put({ ...record, recoveryCodeHashes: remaining, lastUsedAt: now.toISOString() }, 'USED');
      clearFailures(actorId);
      return { ok: true, method: 'RECOVERY_CODE', recoveryCodesLeft: remaining.length };
    }
  }

  recordFailure(actorId);
  return { ok: false };
}

/** Whether a fresh code from this person's app is right — for the acts that demand one, like turning it off. */
export function confirmsWithCurrentCode(actorId: string, code: string, now = clock()): boolean {
  const record = store.forActor(actorId);
  if (!record) return false;
  const counter = matchTotp(reveal(record), code, now.getTime());
  return counter !== null && counter > record.lastCounter;
}

// --- management ---------------------------------------------------------------

export type PublicAuthenticator = {
  id: string;
  label: string;
  enrolledAt: string;
  lastUsedAt?: string;
  recoveryCodesLeft: number;
  recoveryCodesIssuedAt: string;
  secretProtected: boolean;
};

export function publicView(record: AuthenticatorRecord): PublicAuthenticator {
  return {
    id: record.id,
    label: record.label,
    enrolledAt: record.enrolledAt,
    ...(record.lastUsedAt ? { lastUsedAt: record.lastUsedAt } : {}),
    recoveryCodesLeft: record.recoveryCodeHashes.length,
    recoveryCodesIssuedAt: record.recoveryCodesIssuedAt,
    secretProtected: record.secretProtected,
  };
}

export function authenticatorFor(actorId: string): PublicAuthenticator | undefined {
  const record = store.forActor(actorId);
  return record ? publicView(record) : undefined;
}

export function hasAuthenticator(actorId: string): boolean {
  return store.forActor(actorId) !== undefined;
}

export function authenticatorsForTenant(tenantId: string): PublicAuthenticator[] {
  return store.forTenant(tenantId).filter((record) => !record.revokedAt).map(publicView);
}

/** Fresh recovery codes, replacing every unused one. Returned once. */
export function reissueRecoveryCodes(actorId: string, now = clock()): string[] {
  const record = store.forActor(actorId);
  if (!record) throw new DomainError('AUTHENTICATOR_NOT_ENROLLED', 'No authenticator app is enrolled', 404);
  const codes = generateRecoveryCodes();
  store.put({ ...record, recoveryCodeHashes: codes.map(digest), recoveryCodesIssuedAt: now.toISOString() }, 'RECOVERY_CODES_ISSUED');
  return codes;
}

/** Remove the authenticator. The person is back to the emailed code alone. */
export function revokeAuthenticator(input: { actorId: string; by: string }, now = clock()): PublicAuthenticator {
  const record = store.forActor(input.actorId);
  if (!record) throw new DomainError('AUTHENTICATOR_NOT_ENROLLED', 'No authenticator app is enrolled', 404);
  const revoked: AuthenticatorRecord = { ...record, revokedAt: now.toISOString(), revokedBy: input.by };
  store.put(revoked, 'REVOKED');
  return publicView(revoked);
}

/** For tests and the demonstration: the code the app would show right now. */
export function currentCodeFor(actorId: string, now = clock()): string | undefined {
  const record = store.forActor(actorId);
  return record ? totp(reveal(record), now.getTime()) : undefined;
}
