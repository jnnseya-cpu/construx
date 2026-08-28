import { recentLogs, type LogRecord } from '../api/middleware.ts';
import { LATENCY_BUCKETS_MS, counters, latency } from '../api/telemetry.ts';

/**
 * How the platform is actually performing, per route.
 *
 * The console already had two numbers — total requests and a p95 across
 * everything — which is enough to know something is slow and useless for
 * knowing what. An estate-wide p95 of 40ms hides a document generation route at
 * four seconds, because it runs once an hour against ten thousand cheap reads.
 *
 * This aggregates the gateway's own log buffer by route: how often each is
 * called, how long it takes at the median and the tail, how often it fails, and
 * which ones are the reason the estate-wide tail looks the way it does.
 *
 * **Two honest limits, published rather than implied.**
 *
 * The buffer is in-process and bounded — `logRequest` trims it at 5,000 records
 * — so this is a window over recent traffic on *this* process, not a history of
 * the deployment. A restart empties it. Both facts are in the position, because
 * a performance screen that looks like a time series and is actually a ring
 * buffer is a screen that gets quoted wrongly in a meeting.
 *
 * The monotonic counters in `ops/metrics.ts` do survive the trim, and the
 * request total is read from there rather than from the buffer, so the one
 * number somebody watches for saturation never goes down.
 */

/** A route as it performed over the window. */
export type RoutePerformance = {
  route: string;
  /** Every method seen on this route, so a slow POST is not hidden by a fast GET. */
  method: string;
  calls: number;
  p50DurationMs: number;
  p95DurationMs: number;
  maxDurationMs: number;
  /** Responses of 500 or above — the platform's own fault. */
  failures: number;
  /** Responses of 400–499 — a refusal, which is often correct. */
  refusals: number;
  /** Slowest single call observed, with the moment it happened. */
  slowestAt?: string;
};

export type PerformancePosition = {
  /** Requests since the process started, from the counter rather than the buffer. */
  requestsTotal: number;
  /** Records held in the buffer this is computed from. */
  windowRequests: number;
  /** Whether the buffer has trimmed — if it has, the window is not the whole story. */
  windowTrimmed: boolean;
  observedFrom?: string;
  observedTo?: string;
  p50DurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;
  byStatusClass: Record<string, number>;
  /** Failures per thousand requests, which is the rate anybody actually quotes. */
  failuresPerThousand: number;
  routes: RoutePerformance[];
  slowest: RoutePerformance[];
  busiest: RoutePerformance[];
  failing: RoutePerformance[];
  /** Where the estate-wide tail comes from, named rather than left to be guessed. */
  tailAttribution: { route: string; callsOverP95: number; share: number }[];
  note: string;
};

/** The buffer's own ceiling, from `logRequest`. Stated once, here. */
const BUFFER_CEILING = 5_000;

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

/**
 * A route's identity for this report.
 *
 * Method and pattern together. `GET /v1/projects/:projectId` and
 * `POST /v1/projects/:projectId` are different work with different costs, and
 * merging them produces a p95 that describes neither.
 */
function keyOf(log: LogRecord): string {
  return `${log.method} ${log.routeId ?? log.path}`;
}

export function performancePosition(): PerformancePosition {
  const logs = recentLogs(BUFFER_CEILING);

  const grouped = new Map<string, { method: string; route: string; durations: number[]; failures: number; refusals: number; slowest: number; slowestAt?: string }>();
  const byStatusClass: Record<string, number> = {};

  for (const log of logs) {
    const cls = `${Math.floor(log.status / 100)}xx`;
    byStatusClass[cls] = (byStatusClass[cls] ?? 0) + 1;

    const key = keyOf(log);
    let entry = grouped.get(key);
    if (!entry) {
      entry = { method: log.method, route: log.routeId ?? log.path, durations: [], failures: 0, refusals: 0, slowest: 0 };
      grouped.set(key, entry);
    }
    entry.durations.push(log.durationMs);
    if (log.status >= 500) entry.failures += 1;
    else if (log.status >= 400) entry.refusals += 1;
    if (log.durationMs > entry.slowest) {
      entry.slowest = log.durationMs;
      entry.slowestAt = log.timestamp;
    }
  }

  const routes: RoutePerformance[] = [...grouped.values()]
    .map((entry) => {
      const sorted = [...entry.durations].sort((a, b) => a - b);
      return {
        route: entry.route,
        method: entry.method,
        calls: sorted.length,
        p50DurationMs: percentile(sorted, 0.5),
        p95DurationMs: percentile(sorted, 0.95),
        maxDurationMs: entry.slowest,
        failures: entry.failures,
        refusals: entry.refusals,
        slowestAt: entry.slowestAt,
      };
    })
    .sort((a, b) => b.calls - a.calls);

  const allDurations = logs.map((log) => log.durationMs).sort((a, b) => a - b);
  const estateP95 = percentile(allDurations, 0.95);

  /**
   * Which routes are the tail.
   *
   * Not "which route has the highest p95" — a route called twice, slowly, has a
   * terrible p95 and contributes nothing to the estate's. This counts calls that
   * landed *above the estate-wide p95* and attributes the tail to whoever is
   * actually in it, which is the question somebody optimising asks.
   */
  const overP95 = new Map<string, number>();
  for (const log of logs) {
    if (log.durationMs < estateP95 || estateP95 === 0) continue;
    const key = keyOf(log);
    overP95.set(key, (overP95.get(key) ?? 0) + 1);
  }
  const overP95Total = [...overP95.values()].reduce((sum, n) => sum + n, 0);
  const tailAttribution = [...overP95.entries()]
    .map(([route, callsOverP95]) => ({ route, callsOverP95, share: overP95Total === 0 ? 0 : callsOverP95 / overP95Total }))
    .sort((a, b) => b.callsOverP95 - a.callsOverP95)
    .slice(0, 8);

  const requestsTotal = counters.total('requests_total');

  const failures = logs.filter((log) => log.status >= 500).length;

  return {
    requestsTotal: requestsTotal || logs.length,
    windowRequests: logs.length,
    windowTrimmed: (requestsTotal || logs.length) > logs.length,
    observedFrom: logs[0]?.timestamp,
    observedTo: logs[logs.length - 1]?.timestamp,
    p50DurationMs: percentile(allDurations, 0.5),
    p95DurationMs: estateP95,
    p99DurationMs: percentile(allDurations, 0.99),
    byStatusClass,
    failuresPerThousand: logs.length === 0 ? 0 : Math.round((failures / logs.length) * 1000 * 10) / 10,
    routes,
    // A route called once is not a performance signal, so the rankings ignore
    // them rather than putting a single cold-start read at the top of the list
    // of things to fix.
    slowest: routes.filter((route) => route.calls >= 3).sort((a, b) => b.p95DurationMs - a.p95DurationMs).slice(0, 10),
    busiest: [...routes].slice(0, 10),
    failing: routes.filter((route) => route.failures > 0).sort((a, b) => b.failures - a.failures).slice(0, 10),
    tailAttribution,
    note:
      'Measured at the gateway on this process. The log buffer holds the most recent ' +
      `${BUFFER_CEILING.toLocaleString('en-GB')} requests and a restart empties it, so this is a window over recent ` +
      'traffic rather than a history of the deployment. The request total is read from a monotonic counter instead, ' +
      'so it never goes down when the buffer trims.',
  };
}

/**
 * Latency as the metrics registry holds it, for every route it has ever seen.
 *
 * Published beside the buffer-derived numbers rather than instead of them: the
 * registry survives the trim but holds only histogram buckets, and the buffer
 * holds individual calls but forgets. Neither alone answers "is it slow, and
 * when did it become slow".
 *
 * The percentiles here are **bucketed**, and named as such in the field. A p95
 * read off a cumulative histogram is the boundary of the bucket the 95th call
 * fell into, not that call's duration — so it is a ceiling, and the field says
 * `p95AtMostMs` rather than `p95Ms` so nobody reports it as a measurement.
 */
export type LatencySummary = {
  route: string;
  count: number;
  meanMs: number;
  p50AtMostMs: number | null;
  p95AtMostMs: number | null;
  p99AtMostMs: number | null;
  /** Calls that landed past the last finite bucket, so the tail is never dropped. */
  beyondLastBucket: number;
};

function bucketedPercentile(buckets: readonly { leMs: number | '+Inf'; cumulative: number }[], count: number, p: number): number | null {
  if (count === 0) return null;
  const target = count * p;
  for (const bucket of buckets) {
    if (bucket.cumulative >= target) return bucket.leMs === '+Inf' ? null : bucket.leMs;
  }
  return null;
}

export function latencySummaries(): LatencySummary[] {
  const last = LATENCY_BUCKETS_MS[LATENCY_BUCKETS_MS.length - 1] ?? 0;
  return latency.read().map((entry) => {
    const finite = entry.buckets.find((bucket) => bucket.leMs === last)?.cumulative ?? entry.count;
    return {
      route: entry.routeId,
      count: entry.count,
      meanMs: entry.meanMs,
      p50AtMostMs: bucketedPercentile(entry.buckets, entry.count, 0.5),
      p95AtMostMs: bucketedPercentile(entry.buckets, entry.count, 0.95),
      p99AtMostMs: bucketedPercentile(entry.buckets, entry.count, 0.99),
      beyondLastBucket: entry.count - finite,
    };
  });
}
