import { config } from '../config.ts';
import type { Platform } from '../platform.ts';

/**
 * The dead-man's switch.
 *
 * Every rule in `ops/watch.ts` runs inside the process it watches, so a dead
 * process alerts nobody: the outbox stops draining, the webhook is never
 * posted, and the operator finds out from a customer. An external uptime
 * monitor is the only thing that can notice, and it needs something to
 * notice — a ping that stops.
 *
 * This is that ping. On the interval, and **only while the platform is live**
 * (`Platform.liveness`: not shutting down, the journal not refusing writes,
 * the volume not full), the process calls `OPS_HEARTBEAT_URL`. A monitor set
 * to expect one every few minutes raises when the process dies, hangs, or is
 * up and unable to extend the record — which the probe on `/readyz` would say
 * too, but only to somebody probing. Any service with a "ping me or alert"
 * URL takes it: healthchecks.io, Cronitor, Better Stack, Grafana OnCall's
 * heartbeat, a cron-monitor of your own.
 *
 * What it is not: it does not replace probing `/readyz` from outside, which
 * also proves the front door is reachable. The runbook says to do both.
 */

export type HeartbeatState = {
  configured: boolean;
  intervalSeconds: number;
  /** Pings sent since boot. */
  beats: number;
  /** Ticks on which the platform was not live, so nothing was sent. The monitor raises on those. */
  withheld: number;
  lastAttemptAt?: string;
  lastStatus?: number;
  lastError?: string;
  /** Why the last tick sent nothing, when it did not. */
  lastWithheld?: string;
};

let state: HeartbeatState = { configured: config.ops.heartbeatUrl !== '', intervalSeconds: config.ops.heartbeatIntervalSeconds, beats: 0, withheld: 0 };
let timer: NodeJS.Timeout | undefined;

export function heartbeatState(): HeartbeatState {
  return { ...state, configured: config.ops.heartbeatUrl !== '', intervalSeconds: config.ops.heartbeatIntervalSeconds };
}

/** Test isolation only. A deployment never forgets what it sent. */
export function resetHeartbeat(): void {
  state = { configured: config.ops.heartbeatUrl !== '', intervalSeconds: config.ops.heartbeatIntervalSeconds, beats: 0, withheld: 0 };
}

/**
 * One tick. Sent only while the platform is live: a heartbeat from a process
 * that cannot extend the record is the monitor being told everything is fine
 * while every command answers 500.
 */
export async function beat(platform: Platform, now = new Date()): Promise<{ sent: boolean; because?: string }> {
  const url = config.ops.heartbeatUrl;
  if (url === '') return { sent: false, because: 'no heartbeat URL is configured' };

  const live = platform.liveness();
  if (!live.ok) {
    const because = live.reasons.join('; ');
    state = { ...state, withheld: state.withheld + 1, lastWithheld: because };
    return { sent: false, because };
  }

  state = { ...state, lastAttemptAt: now.toISOString(), lastWithheld: undefined };
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'construx-heartbeat/1' },
      // Small and useful: the commit and the event count, so a monitor that
      // keeps the body shows what was running when the pings stopped.
      body: JSON.stringify({ platform: 'CONSTRUX', at: now.toISOString(), commit: config.buildCommit || 'unknown', events: platform.ledger.size }),
      signal: AbortSignal.timeout(5_000),
    });
    state = {
      ...state,
      beats: state.beats + 1,
      lastStatus: response.status,
      ...(response.ok ? { lastError: undefined } : { lastError: `HTTP ${response.status}` }),
    };
    return { sent: true };
  } catch (error) {
    state = { ...state, lastStatus: undefined, lastError: error instanceof Error ? error.message : String(error) };
    return { sent: false, because: state.lastError };
  }
}

/** Start beating on the interval. Returns the stop, for the shutdown path. */
export function startHeartbeat(platform: Platform): () => void {
  if (config.ops.heartbeatUrl === '') return () => {};
  if (timer) return () => stopHeartbeat();
  timer = setInterval(() => {
    void beat(platform).catch(() => {
      // Recorded on the state by `beat` itself; nothing here is load-bearing for a request.
    });
  }, Math.max(5, config.ops.heartbeatIntervalSeconds) * 1000);
  timer.unref();
  return () => stopHeartbeat();
}

export function stopHeartbeat(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
