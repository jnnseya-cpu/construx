import { config } from '../config.ts';

/**
 * The one POST to `OPS_ALERT_WEBHOOK_URL`.
 *
 * The ops webhook is the second channel beside the outbox — a Slack or Teams
 * incoming webhook, a PagerDuty events URL, an uptime service — and more than
 * one thing now sends to it: the watch when a rule fires, and a person when
 * they report a problem. The transport is the same every time (POST JSON, short
 * timeout, never throw, a `text` field every chat service reads), so it lives
 * here once rather than being written again wherever a new sender appears.
 *
 * It is fire-and-forget by contract: it never throws and it never blocks for
 * long, because the thing it carries is already on the record (a ledger event,
 * or an outbox notice) before this is called. The webhook is the belt to that
 * brace, not the other way round, so a slow or dead endpoint degrades to a
 * recorded failure rather than stalling or losing the caller's own work.
 */

export type OpsWebhookResult = {
  /** Whether a webhook URL is configured at all. */
  configured: boolean;
  /** Whether the POST returned a 2xx. Absent when not configured or it threw. */
  ok?: boolean;
  status?: number;
  error?: string;
};

export async function postOpsWebhook(payload: Record<string, unknown>): Promise<OpsWebhookResult> {
  const url = config.ops.alertWebhookUrl;
  if (url === '') return { configured: false };
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'construx-ops/1' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
    return { configured: true, ok: response.ok, status: response.status, ...(response.ok ? {} : { error: `HTTP ${response.status}` }) };
  } catch (error) {
    return { configured: true, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
