import { pruneIdempotency, rateLimiter } from '../api/middleware.ts';
import { pruneExpired as pruneAuth } from '../identity/auth.ts';
import { pruneExpiredEnrolments } from '../identity/authenticators.ts';
import { pruneExpired as pruneLockouts } from '../identity/lockout.ts';
import { pruneExpiredChallenges } from '../identity/passkeys.ts';
import { pruneExpiredStepUps } from '../identity/risk.ts';
import { pruneExpiredRegistrations } from '../identity/signup.ts';

/**
 * The sweep over operational state that only ever grew.
 *
 * Every one of these maps is process memory about the last few minutes — a
 * one-time code, a passkey ceremony, an authenticator enrolment, a step-up, a
 * failed sign-in, a rate bucket, an idempotent reply, a pending registration —
 * and every one of them was dropped only when the same key was looked up
 * again. A key never looked up again was kept for the life of the process,
 * and on a public endpoint that is one entry per stranger, for ever, until the
 * process is killed for its memory and comes back with a full replay.
 *
 * One timer, one pass over all of them, every five minutes. What it drops is
 * already expired, so nothing a client can observe changes; what it prevents
 * is the slow climb that ends in an out-of-memory restart.
 */

export type HygieneReport = {
  at: string;
  revocations: number;
  challenges: number;
  factorChallenges: number;
  passkeyCeremonies: number;
  enrolments: number;
  stepUps: number;
  lockouts: number;
  rateBuckets: number;
  idempotentReplies: number;
  registrations: number;
};

let lastReport: HygieneReport | undefined;
let timer: NodeJS.Timeout | undefined;

export const HYGIENE_INTERVAL_MS = 5 * 60_000;

/** One pass. Exported so a test can drive it without a timer, and so an operator can read what the last pass did. */
export function sweepHygiene(now = Date.now()): HygieneReport {
  const auth = pruneAuth(now);
  lastReport = {
    at: new Date(now).toISOString(),
    revocations: auth.revocations,
    challenges: auth.challenges,
    factorChallenges: auth.factorChallenges,
    passkeyCeremonies: pruneExpiredChallenges(now),
    enrolments: pruneExpiredEnrolments(now),
    stepUps: pruneExpiredStepUps(now),
    lockouts: pruneLockouts(now),
    rateBuckets: rateLimiter.prune(now),
    idempotentReplies: pruneIdempotency(now),
    registrations: pruneExpiredRegistrations(now),
  };
  return lastReport;
}

export function lastHygiene(): HygieneReport | undefined {
  return lastReport;
}

export function startHygiene(intervalMs = HYGIENE_INTERVAL_MS): NodeJS.Timeout {
  if (timer) return timer;
  timer = setInterval(() => {
    try {
      sweepHygiene();
    } catch {
      // A sweep that fails must not stop the next one; nothing here is load-bearing for a request.
    }
  }, intervalMs);
  timer.unref();
  return timer;
}

export function stopHygiene(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
