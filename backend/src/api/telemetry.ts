/**
 * Gateway telemetry — counters, latency, and the security audit stream.
 *
 * The platform already logged every request. What it did not have was
 * *counters*, and the difference matters more than it sounds.
 *
 * The previous metrics were derived by walking the in-memory log buffer. That
 * buffer is bounded and trims its oldest thousand entries when it fills, so
 * every figure computed from it silently went **down** as the system got
 * busier. A request counter that falls is worse than no counter at all: it is
 * the number an on-call engineer reaches for first, and it would have been
 * quietly wrong exactly when there was enough traffic to matter.
 *
 * So counters live here, monotonic, independent of any buffer, and never
 * derived from something that rotates. Latency is a histogram with fixed
 * buckets rather than a percentile over a sliding window, because a percentile
 * of the last five thousand requests answers a different question from a
 * percentile of the day.
 *
 * The audit stream is separate from the request log on purpose. A security
 * event — a failed authentication, a policy denial, an admin endpoint touched,
 * a rate limit hit — is read by a different person for a different reason, and
 * mixing it into request logging means it gets rotated away by ordinary
 * traffic. Nothing here records a credential, a token or the attribute values a
 * policy was evaluated against; a security log that leaks the thing it is
 * guarding is a liability.
 */

// --- Counters ------------------------------------------------------------------

/** The series named in the gateway specification, and nothing else. */
export type CounterName =
  | 'requests_total'
  | 'auth_failures_total'
  | 'authz_denies_total'
  | 'rate_limited_total'
  | 'validation_reject_total';

type LabelSet = Record<string, string>;

/** A label set flattened to a stable key, so ordering cannot fragment a series. */
function seriesKey(labels: LabelSet): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k]}"`)
    .join(',');
}

class Counters {
  readonly #series = new Map<CounterName, Map<string, { labels: LabelSet; value: number }>>();

  increment(name: CounterName, labels: LabelSet = {}): void {
    const series = this.#series.get(name) ?? new Map();
    const key = seriesKey(labels);
    const existing = series.get(key);
    if (existing) existing.value += 1;
    else series.set(key, { labels, value: 1 });
    this.#series.set(name, series);
  }

  read(name: CounterName): Array<{ labels: LabelSet; value: number }> {
    return [...(this.#series.get(name)?.values() ?? [])].sort((a, b) => b.value - a.value);
  }

  total(name: CounterName): number {
    return this.read(name).reduce((sum, s) => sum + s.value, 0);
  }

  /** Test isolation only. Production counters are never reset. */
  reset(): void {
    this.#series.clear();
  }
}

export const counters = new Counters();

// --- Latency -------------------------------------------------------------------

/**
 * Fixed buckets, in milliseconds.
 *
 * Chosen around the answers people actually want: is it fast, is it slow, is it
 * about to time out. Buckets are cumulative in the Prometheus sense — a request
 * at 30ms counts in every bucket from 50 upwards.
 */
export const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000] as const;

type Histogram = { counts: number[]; sum: number; count: number };

class Latency {
  readonly #byRoute = new Map<string, Histogram>();

  observe(routeId: string, durationMs: number): void {
    const histogram = this.#byRoute.get(routeId) ?? {
      counts: new Array<number>(LATENCY_BUCKETS_MS.length + 1).fill(0),
      sum: 0,
      count: 0,
    };

    // The final bucket is +Inf, which is what makes the histogram honest about
    // the tail rather than dropping anything past the last boundary.
    let index = LATENCY_BUCKETS_MS.findIndex((bound) => durationMs <= bound);
    if (index === -1) index = LATENCY_BUCKETS_MS.length;
    histogram.counts[index] = (histogram.counts[index] ?? 0) + 1;
    histogram.sum += durationMs;
    histogram.count += 1;
    this.#byRoute.set(routeId, histogram);
  }

  read(): Array<{
    routeId: string;
    count: number;
    sumMs: number;
    meanMs: number;
    buckets: Array<{ leMs: number | '+Inf'; cumulative: number }>;
  }> {
    return [...this.#byRoute.entries()]
      .map(([routeId, histogram]) => {
        let cumulative = 0;
        const buckets = [...LATENCY_BUCKETS_MS, '+Inf' as const].map((bound, i) => {
          cumulative += histogram.counts[i] ?? 0;
          return { leMs: bound, cumulative };
        });
        return {
          routeId,
          count: histogram.count,
          sumMs: Math.round(histogram.sum),
          meanMs: histogram.count === 0 ? 0 : Math.round(histogram.sum / histogram.count),
          buckets,
        };
      })
      .sort((a, b) => b.count - a.count);
  }

  reset(): void {
    this.#byRoute.clear();
  }
}

export const latency = new Latency();

// --- Security audit stream -------------------------------------------------------

export type SecurityEventKind =
  /** Authentication failed: no token, bad signature, expired, revoked. */
  | 'AUTH_FAILURE'
  /** Authorisation denied after successful authentication. */
  | 'AUTHZ_DENY'
  /** A token that parsed but should not exist: wrong issuer, wrong audience. */
  | 'TOKEN_ANOMALY'
  /** A rate limit refused a request. */
  | 'RATE_LIMITED'
  /** An administrative endpoint was reached, successfully or not. */
  | 'ADMIN_ACCESS'
  /** A request body or parameters failed schema validation. */
  | 'VALIDATION_REJECT'
  /**
   * A session was deliberately ended and its tokens revoked.
   *
   * Not a failure, and recorded for the same reason a successful admin access
   * is: "when did this identity stop being able to act" is a question an
   * investigation asks, and an audit trail that only holds refusals cannot
   * answer it.
   */
  | 'SESSION_ENDED';

export type SecurityEvent = {
  timestamp: string;
  kind: SecurityEventKind;
  /** Machine-readable category. Never free text, so these can be counted. */
  reason: string;
  method: string;
  path: string;
  traceId: string;
  correlationId: string;
  /** Present only where authentication succeeded far enough to know. */
  tenantId?: string;
  actorId?: string;
  /**
   * Truncated remote address. A full address is personal data under GDPR and
   * is not needed to spot a brute-force pattern.
   */
  remote?: string;
  status: number;
};

const auditStream: SecurityEvent[] = [];

/**
 * Truncate an address to the network it came from.
 *
 * Enough to see one source hammering the login endpoint; not enough to be a
 * record of who was where. IPv4 loses the final octet, IPv6 keeps the first
 * three hextets.
 */
export function truncateAddress(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  const address = remote.replace(/^::ffff:/, '');
  if (address.includes('.')) {
    const parts = address.split('.');
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0/24` : undefined;
  }
  if (address.includes(':')) {
    return `${address.split(':').slice(0, 3).join(':')}::/48`;
  }
  return undefined;
}

export function recordSecurityEvent(event: Omit<SecurityEvent, 'timestamp'>): void {
  auditStream.push({ timestamp: new Date().toISOString(), ...event });
  // Bounded, like the request log — but the counters above are not derived from
  // it, so trimming loses history rather than corrupting a total.
  if (auditStream.length > 5000) auditStream.splice(0, 1000);
}

export function securityEvents(options: { limit?: number; kind?: SecurityEventKind } = {}): SecurityEvent[] {
  const filtered = options.kind ? auditStream.filter((e) => e.kind === options.kind) : auditStream;
  return filtered.slice(-(options.limit ?? 100));
}

/** What the audit stream is seeing, grouped so a pattern is visible. */
export function securitySummary(): {
  total: number;
  byKind: Record<string, number>;
  byReason: Record<string, number>;
  /** Sources with more than one failure, worst first — the brute-force shape. */
  repeatSources: Array<{ remote: string; failures: number }>;
} {
  const byKind: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  const bySource = new Map<string, number>();

  for (const event of auditStream) {
    byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;
    byReason[event.reason] = (byReason[event.reason] ?? 0) + 1;
    if (event.remote && (event.kind === 'AUTH_FAILURE' || event.kind === 'RATE_LIMITED')) {
      bySource.set(event.remote, (bySource.get(event.remote) ?? 0) + 1);
    }
  }

  return {
    total: auditStream.length,
    byKind,
    byReason,
    repeatSources: [...bySource.entries()]
      .filter(([, failures]) => failures > 1)
      .map(([remote, failures]) => ({ remote, failures }))
      .sort((a, b) => b.failures - a.failures)
      .slice(0, 20),
  };
}

/** Test isolation only. */
export function resetTelemetry(): void {
  counters.reset();
  latency.reset();
  auditStream.length = 0;
}

// --- The published view ------------------------------------------------------------

export type GatewayMetrics = {
  requests_total: Array<{ labels: LabelSet; value: number }>;
  request_latency_ms: ReturnType<Latency['read']>;
  auth_failures_total: Array<{ labels: LabelSet; value: number }>;
  authz_denies_total: Array<{ labels: LabelSet; value: number }>;
  rate_limited_total: Array<{ labels: LabelSet; value: number }>;
  validation_reject_total: Array<{ labels: LabelSet; value: number }>;
  totals: Record<CounterName, number>;
};

export function gatewayMetrics(): GatewayMetrics {
  return {
    requests_total: counters.read('requests_total'),
    request_latency_ms: latency.read(),
    auth_failures_total: counters.read('auth_failures_total'),
    authz_denies_total: counters.read('authz_denies_total'),
    rate_limited_total: counters.read('rate_limited_total'),
    validation_reject_total: counters.read('validation_reject_total'),
    totals: {
      requests_total: counters.total('requests_total'),
      auth_failures_total: counters.total('auth_failures_total'),
      authz_denies_total: counters.total('authz_denies_total'),
      rate_limited_total: counters.total('rate_limited_total'),
      validation_reject_total: counters.total('validation_reject_total'),
    },
  };
}
