import { config } from '../config.ts';

/**
 * Counting failures against the identity rather than the connection.
 *
 * The platform had one control between an attacker and an account: a rate
 * limit of twenty auth requests per minute, keyed by remote address for anyone
 * not yet holding a token. That is a real control against one machine
 * hammering the door and no control at all against the thing it is usually
 * facing — a run spread across a thousand addresses, which appears as a
 * thousand unremarkable keys and one account quietly under attack. Rotating
 * addresses is not an evasion of an address-keyed limit; it is the whole
 * design of the equipment being used.
 *
 * Underneath it was worse. A one-time code is six hex characters and its
 * challenge accepted wrong guesses **without limit** for its full five-minute
 * life: a hundred thousand wrong codes, and the real one still worked
 * afterwards. Measured, not assumed.
 *
 * So this counts what matters. One subject, one running total, one lock.
 *
 * ---
 *
 * **The lock is silent, and that is deliberate.**
 *
 * `identity/signup.ts` returns an identical receipt whether or not an address
 * is in use, and `POST /v1/auth/login` answers an unknown address with a decoy
 * challenge, both so that nobody can sort a leaked address list into customers
 * and strangers by asking. A lock that announced itself — "this account is
 * locked, try again in twelve minutes" — would hand back exactly that oracle,
 * because only a real account can be locked.
 *
 * A locked identity therefore fails verification with the same refusal a wrong
 * code gives. Nothing observable distinguishes them. The person who actually
 * owns the account is told through the channel that reaches only them, which is
 * their inbox, and `account.locked` was already in the notification catalogue
 * waiting for something to raise it.
 *
 * **The lock lifts by itself.** A lock somebody has to clear is a denial of
 * service anyone can perform on anyone by failing their sign-in ten times, and
 * on a platform where a locked project manager cannot approve a payment that is
 * an attack worth mounting. The cooling period is short enough to survive and
 * long enough to make a sustained run pointless: it takes a sixteen-million
 * code space from days to centuries.
 *
 * **This is memory, not a record.** It lives in the process for the same reason
 * the rate limiter does — it is operational state about the last few minutes,
 * not a fact about the business — so a restart forgives everybody. That is the
 * honest trade and it is stated rather than hidden: what a restart must never
 * forgive is a ledger entry, and none of this is one.
 */

type Subject = {
  failures: number;
  /** When the current window started. Failures older than the window are gone. */
  windowFrom: number;
  lockedUntil?: number;
};

const subjects = new Map<string, Subject>();

const windowMs = () => config.auth.failureWindowMinutes * 60_000;
const lockMs = () => config.auth.lockoutMinutes * 60_000;

export type LockState = {
  locked: boolean;
  /** Seconds until it lifts. Zero when it is not locked. */
  retryAfterSeconds: number;
  failures: number;
};

const free: LockState = { locked: false, retryAfterSeconds: 0, failures: 0 };

/** Where an identity stands, without changing it. */
export function lockState(subject: string, now = Date.now()): LockState {
  const held = subjects.get(subject);
  if (!held) return free;

  if (held.lockedUntil !== undefined && held.lockedUntil > now) {
    return {
      locked: true,
      retryAfterSeconds: Math.ceil((held.lockedUntil - now) / 1000),
      failures: held.failures,
    };
  }

  // The lock has run out, or the window it was counted in has. Either way the
  // slate is clean — a lock that lifted and left the count at the threshold
  // would re-lock on the next single mistake, which is a permanent lock with
  // extra steps.
  if (held.lockedUntil !== undefined || now - held.windowFrom > windowMs()) {
    subjects.delete(subject);
    return free;
  }

  return { locked: false, retryAfterSeconds: 0, failures: held.failures };
}

/**
 * One failure against this identity, and what it did.
 *
 * `justLocked` is true only on the failure that crossed the threshold, so the
 * caller can notify the account owner once rather than on every attempt after
 * it — an attacker who keeps going must not be able to use the lock itself to
 * post a thousand emails to somebody.
 */
export function recordFailure(subject: string, now = Date.now()): LockState & { justLocked: boolean } {
  const standing = lockState(subject, now);
  if (standing.locked) return { ...standing, justLocked: false };

  const held = subjects.get(subject) ?? { failures: 0, windowFrom: now };
  held.failures += 1;
  held.windowFrom = held.windowFrom || now;

  if (held.failures >= config.auth.maxIdentityFailures) {
    held.lockedUntil = now + lockMs();
    subjects.set(subject, held);
    return { locked: true, retryAfterSeconds: Math.ceil(lockMs() / 1000), failures: held.failures, justLocked: true };
  }

  subjects.set(subject, held);
  return { locked: false, retryAfterSeconds: 0, failures: held.failures, justLocked: false };
}

/**
 * A successful sign-in clears the count.
 *
 * Without this, ten mistyped codes spread across a fortnight of ordinary use
 * would eventually lock somebody who has done nothing wrong, because the count
 * would only ever go up. Proving you are the account holder is the strongest
 * possible evidence that the failures before it were yours.
 */
export function clearFailures(subject: string): void {
  subjects.delete(subject);
}

/** Every identity currently locked, for the operator's security view. */
export function lockedSubjects(now = Date.now()): Array<{ subject: string; retryAfterSeconds: number; failures: number }> {
  const locked: Array<{ subject: string; retryAfterSeconds: number; failures: number }> = [];
  for (const [subject] of subjects) {
    const state = lockState(subject, now);
    if (state.locked) locked.push({ subject, retryAfterSeconds: state.retryAfterSeconds, failures: state.failures });
  }
  return locked;
}

/** Test isolation only. Never called by the running platform. */
export function reset(): void {
  subjects.clear();
}
