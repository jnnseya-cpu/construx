import { config } from '../config.ts';
import type { SharedLockouts } from './sharedlockouts.ts';

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
 *
 * **Shared across replicas where a backend is attached.** One process, the
 * map is the whole truth. Four replicas behind a load balancer are four
 * counts, and a run spread across them gets four times the failures before
 * any one of them locks — the multiplied budget the shared rate limiter
 * closed for the per-address limit, on the control that exists because that
 * limit is not enough. With `attachShared`, the map becomes this process's
 * mirror of a count kept in Redis (`identity/sharedlockouts.ts`): `refresh`
 * pulls a subject's shared state in before a verification, every failure
 * recorded here is counted there atomically and the reply mirrored back, and
 * a successful sign-in clears both. The synchronous readers — the verifier,
 * the risk score — keep reading the map, which is at most one round-trip
 * behind. A backend that cannot be reached leaves the process counting on its
 * own for that request, counted and shown on the security position; the
 * per-address limiter sharing the backend is already refusing the login route
 * during that outage.
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

// --- the shared backend -----------------------------------------------------

let shared: SharedLockouts | undefined;

export type SharedLockoutState = {
  /** Where the count lives. */
  backend: 'process' | 'redis';
  host?: string;
  /** Round-trips that could not be made since boot; each one left the process counting alone for that request. */
  fallbacks: number;
  lastError?: string;
  lastErrorAt?: string;
  /** Successful round-trips since boot, so a configured backend that is never reached is visible. */
  roundTrips: number;
};

let sharedState: SharedLockoutState = { backend: 'process', fallbacks: 0, roundTrips: 0 };

/** Attach the backend every replica shares. Undefined detaches; the map is then the whole truth again. */
export function attachShared(backend: SharedLockouts | undefined): void {
  shared = backend;
  sharedState = backend ? { backend: 'redis', host: backend.host, fallbacks: 0, roundTrips: 0 } : { backend: 'process', fallbacks: 0, roundTrips: 0 };
}

export function sharedLockoutState(): SharedLockoutState {
  return { ...sharedState };
}

function noteFallback(error: unknown): void {
  sharedState = {
    ...sharedState,
    fallbacks: sharedState.fallbacks + 1,
    lastError: error instanceof Error ? error.message : String(error),
    lastErrorAt: new Date().toISOString(),
  };
}

/**
 * Ordering for the mirror, because the replies do not arrive in order.
 *
 * Every exchange with the backend is issued a number, and a reply is applied
 * only if no later exchange has already been applied for that subject. Without
 * it, two failures in quick succession fire two round-trips, and if the reply
 * carrying `failures: 1` arrives after the reply carrying `failures: 2` the
 * mirror ends up at 1 — the count goes *backwards* on the control that exists
 * precisely for a burst of attempts, and the replica lets more through than the
 * policy allows. The same race resurrects a cleared count when a failure reply
 * lands after a successful sign-in.
 *
 * The number is taken before the round-trip is issued, never after it returns,
 * so an exchange that started later always outranks one that started earlier.
 * One counter serves every subject — `refreshAll` reads subjects it does not
 * know the names of until the reply arrives, and a shared counter lets it take
 * its number up front like everything else. `applied` is per subject: the last
 * exchange whose reply reached the map.
 */
let exchanges = 0;
const applied = new Map<string, number>();

function nextExchange(): number {
  exchanges += 1;
  return exchanges;
}

function mirror(subject: string, exchange: number, state: { failures: number; windowFrom: number; lockedUntil?: number } | undefined): void {
  if ((applied.get(subject) ?? 0) > exchange) return;
  applied.set(subject, exchange);
  if (!state) {
    subjects.delete(subject);
    return;
  }
  subjects.set(subject, { failures: state.failures, windowFrom: state.windowFrom, ...(state.lockedUntil !== undefined ? { lockedUntil: state.lockedUntil } : {}) });
}

/**
 * Bring one subject's state in from the shared backend, so the synchronous
 * check that follows answers for every replica rather than this one. Nothing
 * without a backend; a backend that cannot be reached is a counted fallback
 * and the map stands as it is.
 */
export async function refresh(subject: string): Promise<void> {
  if (!shared) return;
  // Numbered before the read is issued: a push reply that was already in flight
  // when this read left is older than what the read comes back with.
  const exchange = nextExchange();
  try {
    mirror(subject, exchange, await shared.state(subject, windowMs()));
    sharedState = { ...sharedState, roundTrips: sharedState.roundTrips + 1 };
  } catch (error) {
    noteFallback(error);
  }
}

/** Every subject the backend holds, mirrored in, for the operator's view. */
export async function refreshAll(): Promise<void> {
  if (!shared) return;
  try {
    const exchange = nextExchange();
    for (const entry of await shared.subjects(windowMs())) mirror(entry.subject, exchange, entry.state);
    sharedState = { ...sharedState, roundTrips: sharedState.roundTrips + 1 };
  } catch (error) {
    noteFallback(error);
  }
}

/** The shared count, kept in step after a local change. Never awaited by the caller; the reply corrects the mirror. */
function push(subject: string, change: 'FAILURE' | 'CLEAR'): void {
  if (!shared) return;
  const backend = shared;
  const exchange = nextExchange();
  const outcome =
    change === 'CLEAR'
      ? // The clear takes the watermark as well as emptying the map, so a
        // failure reply still in flight from before the successful sign-in
        // cannot land afterwards and put the count back.
        backend.clear(subject).then(() => mirror(subject, exchange, undefined))
      : backend
          .recordFailure(subject, windowMs(), lockMs(), config.auth.maxIdentityFailures)
          .then((reply) => mirror(subject, exchange, reply.state));
  outcome
    .then(() => {
      sharedState = { ...sharedState, roundTrips: sharedState.roundTrips + 1 };
    })
    .catch((error: unknown) => noteFallback(error));
}

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
    push(subject, 'FAILURE');
    return { locked: true, retryAfterSeconds: Math.ceil(lockMs() / 1000), failures: held.failures, justLocked: true };
  }

  subjects.set(subject, held);
  push(subject, 'FAILURE');
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
  push(subject, 'CLEAR');
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
  applied.clear();
}

/** Test isolation only: forget the tallies without detaching. */
export function resetSharedTallies(): void {
  sharedState = { ...sharedState, fallbacks: 0, roundTrips: 0, lastError: undefined, lastErrorAt: undefined };
}

/**
 * Drop subjects whose window and lock have both passed. An entry per identity
 * that ever failed a sign-in, kept for ever, is the same slow growth as every
 * other operational map here; a subject past its window reads as free anyway.
 */
export function pruneExpired(now = Date.now()): number {
  let dropped = 0;
  for (const [subject, record] of subjects) {
    const lockOver = record.lockedUntil === undefined || record.lockedUntil <= now;
    const windowOver = now - record.windowFrom > windowMs();
    if (lockOver && windowOver) {
      subjects.delete(subject);
      applied.delete(subject);
      dropped += 1;
    }
  }
  return dropped;
}
