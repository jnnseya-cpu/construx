import { config } from '../config.ts';

/**
 * The right to erasure, against a ledger that cannot be erased.
 *
 * These two obligations look like a contradiction and are not. UK GDPR Art. 17
 * gives a data subject the right to have their personal data erased; Art. 17(3)
 * withdraws that right where processing is necessary to comply with a legal
 * obligation (b) or for the establishment, exercise or defence of legal claims
 * (e). A construction record is squarely inside both: CDM 2015 and the Building
 * Safety Act require the safety file and the golden thread to be retained, and
 * an adjudication three years from now is decided on what the record says
 * happened and who did it.
 *
 * So the ledger is not touched. Deleting events would break the hash chain,
 * which is the thing that makes the record evidence at all, and would destroy a
 * statutory record to satisfy a request the statute exempts.
 *
 * What is erased is the identity. Name, email and telephone number are replaced
 * with a token that identifies nobody. Events keep referring to the same actor
 * id, so the chain still verifies and the sequence of who-did-what still reads,
 * but that id no longer resolves to a person. The retained record is
 * pseudonymised, and the data subject is not identifiable from it.
 *
 * The Apple and Google stores require an in-app route to account deletion. This
 * is that route, and it is the same one on the web — a person should not have
 * to install an app to leave.
 */

export type ErasureState = {
  /** When the person asked. Absent means no request is outstanding. */
  requestedAt?: string;
  /** When the grace period expires and the erasure becomes due. */
  dueAt?: string;
  /** When it was actually carried out. Present means the identity is gone. */
  erasedAt?: string;
  /** Who asked — the person themselves, or an administrator acting for them. */
  requestedBy?: string;
};

/**
 * Days between the request and the erasure.
 *
 * The delay is a safety feature, not a dark pattern. Erasure is irreversible
 * and an account takeover is a real way to use it as a weapon: without a
 * window, whoever holds the session can destroy an identity that a competent
 * person's approvals are recorded against. The window is also when the
 * mandatory `privacy.account_deletion_requested` notice reaches the real
 * mailbox, which is what lets the true owner stop it.
 */
export function graceDays(): number {
  return config.privacy.erasureGraceDays;
}

/** When a request made now becomes due. */
export function dueAt(requestedAt: string, now = new Date()): string {
  void now;
  const due = new Date(Date.parse(requestedAt) + graceDays() * 86_400_000);
  return due.toISOString();
}

/** Whether an outstanding request has reached its due date. */
export function isDue(state: ErasureState, now = new Date()): boolean {
  if (state.erasedAt !== undefined || state.dueAt === undefined) return false;
  return Date.parse(state.dueAt) <= now.getTime();
}

/**
 * The pseudonym an erased identity carries afterwards.
 *
 * Derived from the user id rather than random, so the same identity reads the
 * same way everywhere it appears and two erased people are not conflated. It
 * carries no part of the name or address it replaced — a hash of the email
 * would still let somebody confirm a guess by hashing an address they suspect.
 */
export function pseudonym(userId: string): { name: string; email: string } {
  const suffix = userId.slice(-6).toUpperCase();
  return {
    name: `Erased identity ${suffix}`,
    // `.invalid` is reserved by RFC 2606 and can never be delivered to, so this
    // cannot become a real address by accident or be mistaken for one.
    email: `erased-${suffix.toLowerCase()}@erased.invalid`,
  };
}

/**
 * What the record says was kept, and why.
 *
 * Written into the `USER_ERASED` event rather than left implicit. Art. 5(2)
 * makes the controller responsible for demonstrating compliance, and "we erased
 * what we could and kept what we must" is only a defence if the record says
 * which was which at the time.
 */
export function retentionBasis(): { removed: string[]; retained: string[]; lawfulBasis: string } {
  return {
    removed: ['name', 'email', 'mobile'],
    retained: [
      'the actor reference on every event the identity authored',
      'the hash chain over those events',
      'approvals, certifications and signatures recorded against the identity',
    ],
    lawfulBasis:
      'UK GDPR Art. 17(3)(b) and (e) — retention required to comply with a legal obligation ' +
      '(CDM 2015 health and safety file, Building Safety Act golden thread) and for the ' +
      'establishment, exercise or defence of legal claims',
  };
}

// --- carrying it out ---------------------------------------------------------

import type { Platform } from '../platform.ts';
import type { AuthContext } from './auth.ts';
import * as notifyEngine from '../notifications/notify.ts';

export type ErasureRunReport = { due: number; erased: number; failed: Array<{ userId: string; because: string }> };

/**
 * The actor a scheduled erasure is recorded against. Not a person: nobody
 * pressed anything, the grace period ran out, and the event should say so
 * rather than borrow an administrator's name.
 */
function scheduledActor(tenantId: string): AuthContext {
  return {
    actorId: 'system:erasure',
    tenantId,
    roles: [],
    scopes: [],
    tokenId: 'system:erasure',
    mfaSatisfied: true,
    regulatorAiEnabled: false,
    expiresAt: Date.now() + 60_000,
  };
}

/**
 * Erase every identity whose grace period has expired.
 *
 * `Platform.eraseUser` and `dueErasures` existed and nothing called either: an
 * erasure could be requested, the account suspended, the mandatory notice
 * sent — and the name stayed on the identity for ever, because no code ran
 * when the date came. The completion notice goes to the real address first,
 * because a moment later there is no real address to send it to.
 */
export async function runDueErasures(platform: Platform, now = new Date()): Promise<ErasureRunReport> {
  const due = platform.dueErasures(now);
  const report: ErasureRunReport = { due: due.length, erased: 0, failed: [] };

  for (const user of due) {
    try {
      const recipient = { id: user.id, name: user.name, email: user.email, tenantId: user.tenantId };
      await notifyEngine
        .notify(platform, {
          code: 'privacy.account_deletion_completed',
          recipients: [recipient],
          payload: {
            detail:
              'Your name, email address and telephone number have been removed from this platform. ' +
              `The project record is kept: ${retentionBasis().lawfulBasis}`,
          },
          branding: platform.exports.branding(user.tenantId),
          actorId: 'system:erasure',
          correlationId: `erasure-${user.id}`,
        })
        // A notice that cannot be delivered must not keep the identity alive:
        // the outbox retries it, and the erasure is what was promised.
        .catch(() => undefined);

      platform.eraseUser(scheduledActor(user.tenantId), { userId: user.id, now });
      report.erased += 1;
    } catch (error) {
      report.failed.push({ userId: user.id, because: error instanceof Error ? error.message : String(error) });
    }
  }

  return report;
}

/** Hourly, like collection: a grace period that ended at 09:00 should not wait for midnight. */
export function startErasureSchedule(
  platform: Platform,
  onRun: (report: ErasureRunReport) => void = () => {},
): { stop: () => void } {
  const tick = async () => {
    try {
      const report = await runDueErasures(platform);
      if (report.erased > 0 || report.failed.length > 0) onRun(report);
    } catch {
      // The next hour is the retry. A dead scheduler is an erasure never done.
    }
  };
  const timer = setInterval(() => void tick(), 3_600_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
