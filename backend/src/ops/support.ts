import { config } from '../config.ts';
import { ulid } from '../core/ids.ts';
import { DomainError } from '../core/errors.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import * as notifyEngine from '../notifications/notify.ts';
import { PLATFORM_BRANDING } from '../notifications/render.ts';
import type { Platform } from '../platform.ts';
import { postOpsWebhook } from './opswebhook.ts';

/**
 * The report-when-stuck / report-the-error channel.
 *
 * ---
 *
 * **The honest version of "the AI gets help when it struggles".** The platform
 * cannot silently reach a developer or silently repair itself — "AI proposes, a
 * person confirms" and "no agent mandate exceeds PROPOSE" are settled decisions,
 * and an AI changing a paying subscriber's work unseen is the trust failure the
 * platform is sold against. What it *can* do is make a struggle or a bug reach a
 * watched place automatically, with the person seeing it happen. That is this.
 *
 * A person files a report — the copilot could not help (`STUCK`), a request
 * errored (`ERROR`, carrying the failed request's correlation id so it can be
 * found in the logs), or a plain piece of feedback. Three things then happen,
 * and the caller is told which:
 *
 *  1. **It is put on the record.** A `SUPPORT_REPORT_FILED` event on the
 *     tenancy's own governance chain, so the report is never lost and an audit
 *     can see it was raised, by whom, when.
 *  2. **It reaches someone in-platform, always.** The tenancy's owners and
 *     administrators are notified through the same durable outbox every other
 *     notice uses. This is the floor: even a deployment with no ops webhook
 *     configured still surfaces the report to a human who can act on it, rather
 *     than recording it into silence.
 *  3. **It reaches the watched ops channel, where one is configured.** The
 *     same `OPS_ALERT_WEBHOOK_URL` the watch fires to — a Slack/Teams channel,
 *     a PagerDuty queue — so a developer or on-call agent sees it and can pick
 *     up the repair. Best-effort: a dead endpoint is reported as not-forwarded,
 *     never swallowed and never fatal to the report.
 *
 * The report is filed **by a person, never by an AI.** A report is a human
 * saying "this is wrong", which is exactly the judgement an AI must not
 * fabricate on their behalf — so the copilot can *pre-fill* a report for the
 * person to send, but the act of sending it is theirs.
 */

export const REPORT_KINDS = ['STUCK', 'ERROR', 'FEEDBACK'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export type SupportReportInput = {
  kind: ReportKind;
  message: string;
  /** The console screen the person was on, for context. */
  screen?: string;
  /** The failed request's `x-correlation-id`, so an ERROR can be found in the logs. */
  correlationId?: string;
  /** The copilot question behind a STUCK report. */
  question?: string;
};

export type SupportReportResult = {
  reportId: string;
  /** The human reference shown to the person and carried on every channel. */
  reference: string;
  recordedAt: string;
  /** How many in-platform recipients the notice went to. */
  deliveredTo: number;
  /** Whether the ops webhook was configured and accepted it. */
  forwardedToOps: boolean;
};

/** CONSTRUX Report. */
const REFERENCE_PREFIX = 'CXR';

/**
 * The owners and administrators of a tenancy — the registered account holders
 * who act on what their people report. The same filter the tender reminder and
 * the usage-limit notice use; kept local because each is its own concern and a
 * shared "who are the admins" helper would couple them.
 */
function reportRecipients(
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

export async function fileSupportReport(
  platform: Platform,
  ctx: EngineContext,
  input: SupportReportInput,
): Promise<SupportReportResult> {
  // Held by every seat, down to a subcontractor — reporting a problem is not a
  // privilege, and a person locked out of saying "this is broken" is exactly
  // how a bug goes unreported.
  authorise(ctx, 'PROJECT_SETUP', 'R');

  const kind: ReportKind = REPORT_KINDS.includes(input.kind) ? input.kind : 'FEEDBACK';
  const message = String(input.message ?? '').trim();
  if (message.length < 3) {
    throw new DomainError('SUPPORT_REPORT_EMPTY', 'A report needs a sentence saying what went wrong.', 422);
  }
  if (message.length > 4000) {
    throw new DomainError('SUPPORT_REPORT_TOO_LONG', 'Keep the report under 4000 characters.', 422);
  }
  const screen = input.screen ? String(input.screen).slice(0, 80) : undefined;
  const correlationId = input.correlationId ? String(input.correlationId).slice(0, 120) : undefined;
  const question = input.question ? String(input.question).slice(0, 2000) : undefined;

  const reportId = ulid();
  const reference = `${REFERENCE_PREFIX}-${reportId.slice(-8)}`;
  const recordedAt = new Date().toISOString();

  let reporterName = 'A member';
  try {
    reporterName = platform.user(ctx.auth.actorId).name;
  } catch {
    // A report from an actor the directory cannot name is still a report; it is
    // filed under the id either way.
  }

  // 1 — on the record, on the tenancy's own governance chain.
  write(ctx, {
    eventType: 'SUPPORT_REPORT_FILED',
    entity: { refType: 'SupportReport', refId: reportId },
    nextState: {
      id: reportId,
      reference,
      kind,
      message,
      ...(screen ? { screen } : {}),
      ...(correlationId ? { correlationId } : {}),
      ...(question ? { question } : {}),
      reportedBy: ctx.auth.actorId,
      reportedByName: reporterName,
      reportedAt: recordedAt,
    },
  });

  // 2 — reaches someone in-platform, always.
  const recipients = reportRecipients(platform, ctx.tenantId);
  if (recipients.length > 0) {
    await notifyEngine.notify(platform, {
      code: 'support.report_filed',
      recipients,
      payload: {
        reporter: reporterName,
        kind: kind.toLowerCase(),
        screen: screen ?? 'the platform',
        reference,
        message,
        ...(correlationId ? { correlationId } : {}),
      },
      branding: PLATFORM_BRANDING,
      actorId: ctx.auth.actorId,
      correlationId: ctx.correlationId ?? reference,
    });
  }

  // 3 — reaches the watched ops channel, where one is configured. Best-effort.
  const webhook = await postOpsWebhook({
    text: `[CONSTRUX] Problem reported (${kind}) on ${screen ?? 'the platform'} — ${reference}: ${message.slice(0, 500)}`,
    platform: 'CONSTRUX',
    kind,
    reference,
    screen: screen ?? null,
    correlationId: correlationId ?? null,
    question: question ?? null,
    message,
    reportedBy: reporterName,
    tenantId: ctx.tenantId,
    reportedAt: recordedAt,
    publicBaseUrl: config.publicBaseUrl,
  });

  return {
    reportId,
    reference,
    recordedAt,
    deliveredTo: recipients.length,
    forwardedToOps: webhook.configured && webhook.ok !== false,
  };
}
