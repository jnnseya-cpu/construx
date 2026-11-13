import { config } from '../config.ts';
import { ulid } from '../core/ids.ts';
import { deadlineInForce, type ZonedInstant } from '../domain/tenderintake.ts';
import * as notifyEngine from '../notifications/notify.ts';
import { entriesByCodePrefix } from '../notifications/outbox.ts';
import { PLATFORM_BRANDING } from '../notifications/render.ts';
import { PLATFORM_TENANT_ID, type Platform } from '../platform.ts';

/**
 * The tender-deadline reminder sweep.
 *
 * ---
 *
 * **The failure this stops.** A bid is lost on price, on quality — and on the
 * date. The last of those is the one no estimating skill prevents and the one
 * the platform is best placed to catch, because it already holds every recorded
 * invitation's return deadline resolved to a single instant (`tenderintake.ts`
 * does the wall-clock-and-zone work). Nothing read those instants on a clock.
 * A deadline recorded the hour the ITT landed sat in the record and told nobody
 * as it approached.
 *
 * So this reads them on a timer and tells the company's own people a set number
 * of days out — the "5 days before" a first bidder asked for, `TENDER_REMINDER_LEAD_DAYS`.
 *
 * ## One reminder per deadline, and no more
 *
 * The sweep runs on its own clock (every few hours by default) and must not
 * email the same person about the same deadline every time it runs. The memory
 * is the outbox, not a flag in this process: a `tender.deadline_approaching`
 * notice is queued through the same durable outbox every other notice uses, and
 * the next sweep reads the queue back and skips an invitation whose current
 * deadline has already been reminded. That survives a restart, which a
 * process-local set would not — the one circumstance a reminder most needs to
 * not be re-sent is the one where the process has just come back up.
 *
 * **An addendum that moves the deadline earns a fresh reminder.** The idempotency
 * key is the invitation *and the instant in force*, so when an addendum moves the
 * return date the key changes and the new date is reminded on its own schedule.
 * The old reminder stays on the record as what was true then.
 *
 * ## Who is told
 *
 * The company's owners and administrators — the registered account holders who
 * act on a tender — resolved from the record exactly as the usage-limit notice
 * resolves them. A company with nobody to tell is skipped and tried again next
 * sweep, never recorded as sent to nobody.
 *
 * ## What it deliberately does not remind
 *
 * - A deadline already past: the reminder is to act before it closes, and after
 *   it there is nothing to act on.
 * - A pursuit decided as a no-bid, or already converted to a won project: the
 *   decision is made, and a nudge to meet a deadline on it is noise.
 * - The platform's own tenancy, which records no tenders.
 */

export const REMINDER_ACTOR = 'system:tender-reminders';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A reminder that was sent, for the console and the tests. */
export type ReminderSent = {
  tenantId: string;
  invitationId: string;
  reference: string;
  title: string;
  deadlineInstant: string;
  daysRemaining: number;
  recipients: number;
};

export type ReminderSkip = { tenantId: string; invitationId: string; reference: string; because: string };

export type ReminderOutcome = {
  at: string;
  durationMs: number;
  invitationsChecked: number;
  sent: ReminderSent[];
  alreadyReminded: number;
  outsideWindow: number;
  skipped: ReminderSkip[];
};

export type ReminderPosition = {
  enabled: boolean;
  leadDays: number;
  intervalMinutes: number;
  last?: ReminderOutcome;
};

let last: ReminderOutcome | undefined;
let timer: NodeJS.Timeout | undefined;

/** Test isolation only. A deployment never forgets its last pass. */
export function resetTenderReminders(): void {
  last = undefined;
}

/**
 * The company's own people a tender reminder is for.
 *
 * The owners and administrators — the account holders whose registered address a
 * reminder is meant to reach. Active only: a suspended or removed seat is not a
 * person to email a deadline to. The same resolution the usage-limit notice uses
 * for a company's administrators, so the two cannot disagree about who holds the
 * account.
 */
export function tenderReminderRecipients(
  platform: Platform,
  tenantId: string,
): Array<{ id: string; name: string; email: string; tenantId: string }> {
  const seen = new Set<string>();
  const recipients: Array<{ id: string; name: string; email: string; tenantId: string }> = [];
  for (const user of platform.users(tenantId)) {
    if (user.status !== 'ACTIVE') continue;
    if (!user.roles.includes('OWNER') && !user.roles.includes('ENTERPRISE_ADMIN')) continue;
    const key = user.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push({ id: user.id, name: user.name, email: user.email, tenantId: user.tenantId });
  }
  return recipients;
}

/**
 * Whether a reminder for this invitation's current deadline has already been
 * queued. Read from the outbox, which is ledger-backed and outlives the process,
 * so a restart does not re-send what a previous process already sent.
 */
function alreadyReminded(platform: Platform, invitationId: string, deadlineInstant: string): boolean {
  return entriesByCodePrefix(platform, 'tender.deadline_approaching', Number.MAX_SAFE_INTEGER).some(
    (entry) => entry.payload.invitationId === invitationId && entry.payload.deadlineInstant === deadlineInstant,
  );
}

/** The stage of the pursuit an invitation belongs to, or undefined where it has none on record. */
function opportunityStage(platform: Platform, opportunityId: string | undefined): string | undefined {
  if (!opportunityId) return undefined;
  const record = platform.ledger.get({ refType: 'Opportunity', refId: opportunityId });
  return record ? String(record.state.stage ?? '') : undefined;
}

/**
 * Read every recorded invitation once, and remind on the ones inside the window
 * that have not been reminded yet.
 */
export async function sweepTenderReminders(platform: Platform, now = new Date()): Promise<ReminderOutcome> {
  const started = Date.now();
  const leadDays = config.ops.tenderReminderLeadDays;
  const windowMs = leadDays * DAY_MS;
  const nowMs = now.getTime();
  const outcome: ReminderOutcome = {
    at: now.toISOString(),
    durationMs: 0,
    invitationsChecked: 0,
    sent: [],
    alreadyReminded: 0,
    outsideWindow: 0,
    skipped: [],
  };

  for (const record of platform.ledger.entitiesOfType('TenderInvitation')) {
    if (record.tenantId === PLATFORM_TENANT_ID) continue;
    // Between invitations, let a request through: the sweep runs on the thread
    // that serves everybody, exactly as the chain-break sweep does.
    await new Promise<void>((resolve) => setImmediate(resolve));

    const state = record.state;
    const invitationId = String(state.id ?? record.refId);
    const reference = String(state.reference ?? invitationId);
    const title = String(state.title ?? reference);

    let deadline: ZonedInstant;
    try {
      deadline = deadlineInForce(state);
    } catch (error) {
      outcome.skipped.push({ tenantId: record.tenantId, invitationId, reference, because: `no readable deadline: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }

    outcome.invitationsChecked += 1;
    const instantMs = Date.parse(deadline.instant);
    const msLeft = instantMs - nowMs;

    // Past the deadline, or further out than the window: nothing to send now.
    if (msLeft <= 0 || msLeft > windowMs) {
      outcome.outsideWindow += 1;
      continue;
    }

    const stage = opportunityStage(platform, state.opportunityId ? String(state.opportunityId) : undefined);
    if (stage === 'NO_BID' || stage === 'CONVERTED') {
      outcome.skipped.push({
        tenantId: record.tenantId,
        invitationId,
        reference,
        because: stage === 'NO_BID' ? 'pursuit decided a no-bid' : 'pursuit already converted to a won project',
      });
      continue;
    }

    if (alreadyReminded(platform, invitationId, deadline.instant)) {
      outcome.alreadyReminded += 1;
      continue;
    }

    const tenant = platform.tenants().find((candidate) => candidate.id === record.tenantId);
    if (tenant?.closedAt) {
      outcome.skipped.push({ tenantId: record.tenantId, invitationId, reference, because: 'tenancy closed — the record is read-only' });
      continue;
    }

    const recipients = tenderReminderRecipients(platform, record.tenantId);
    if (recipients.length === 0) {
      // Nobody to tell yet. Not recorded as reminded, so the next sweep tries
      // again once the company has an administrator on record.
      outcome.skipped.push({ tenantId: record.tenantId, invitationId, reference, because: 'no owner or administrator on record to remind' });
      continue;
    }

    const daysRemaining = Math.max(1, Math.ceil(msLeft / DAY_MS));
    const dayWord = daysRemaining === 1 ? 'day' : 'days';
    const readable = `${deadline.local.replace('T', ' ')} ${deadline.timeZone}`;

    await notifyEngine.notify(platform, {
      code: 'tender.deadline_approaching',
      recipients,
      payload: {
        // Subject placeholders.
        reference,
        title,
        days: `${daysRemaining} ${dayWord}`,
        // Carried so a later sweep can tell this reminder was already sent for
        // this exact deadline, and not re-send it.
        invitationId,
        deadlineInstant: deadline.instant,
        actionUrl: '/app/#/procurement',
        actionLabel: 'Open the tender',
        detail:
          `The return deadline for ${reference} — ${title} — is ${readable}, which is ${daysRemaining} ${dayWord} away. ` +
          'Make sure the submission is assembled, checked and uploaded before it closes. ' +
          'If the deadline has moved, record the addendum so this reminder follows the new date.',
      },
      branding: platform.exports.brandingIfConfigured(record.tenantId) ?? PLATFORM_BRANDING,
      actorId: REMINDER_ACTOR,
      correlationId: `tender-reminder-${invitationId}-${ulid()}`,
    });

    outcome.sent.push({
      tenantId: record.tenantId,
      invitationId,
      reference,
      title,
      deadlineInstant: deadline.instant,
      daysRemaining,
      recipients: recipients.length,
    });
  }

  outcome.durationMs = Date.now() - started;
  last = outcome;
  return outcome;
}

export function tenderReminderPosition(): ReminderPosition {
  return {
    enabled: config.ops.tenderReminderEnabled && config.ops.tenderReminderIntervalMinutes > 0,
    leadDays: config.ops.tenderReminderLeadDays,
    intervalMinutes: config.ops.tenderReminderIntervalMinutes,
    ...(last ? { last } : {}),
  };
}

/** Start the sweep on a timer. Returns the stop, for the shutdown path. */
export function startTenderReminderSweep(platform: Platform): () => void {
  if (!config.ops.tenderReminderEnabled || config.ops.tenderReminderIntervalMinutes <= 0 || timer) {
    return () => {};
  }
  timer = setInterval(() => {
    void sweepTenderReminders(platform).catch((error: unknown) => {
      process.stderr.write(`[tender-reminders] sweep failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }, config.ops.tenderReminderIntervalMinutes * 60_000);
  timer.unref();
  return () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
}
