import { config } from '../config.ts';
import { counters, latency, LATENCY_BUCKETS_MS, securityEvents, type CounterName } from '../api/telemetry.ts';

/**
 * Shipping the numbers somewhere that outlives the container.
 *
 * `docs/STATE.md` has said the same thing since the counters were built:
 * *structured JSON still goes to stdout and nothing collects it*. Everything
 * needed to diagnose an incident exists — counters that never go down, a
 * latency histogram with fixed buckets, a security stream, a request log
 * carrying a correlation id — and all of it dies with the process. Post-incident
 * analysis depended on whether anybody had happened to keep the container.
 *
 * This is the shipper. OTLP over HTTP with the JSON encoding, which every
 * collector accepts and which needs no protobuf runtime — the same reasoning
 * that produced an SMTP client and a clamd client rather than dependencies.
 *
 * ## Four rules, because a telemetry exporter that misbehaves is worse than none
 *
 * 1. **It never blocks a request.** Export runs on its own interval, reads the
 *    counters and ships them. Nothing on the request path awaits anything here.
 * 2. **It never grows without bound.** The queue is capped. When it fills,
 *    the oldest records are dropped and the *number dropped* is itself exported,
 *    so a silently lossy pipeline is impossible to mistake for a quiet one.
 * 3. **Local telemetry keeps working when egress fails.** The counters are the
 *    source and this is a reader; a collector being down changes nothing about
 *    what the platform knows about itself, only about what anybody else can see.
 *    The failure is recorded and surfaced rather than retried into a storm.
 * 4. **It ships no secret and no personal data.** What goes out is what the
 *    admin screens already show: route ids, status codes, counts, durations,
 *    and security events whose addresses are already truncated to a network.
 *    Request bodies, tokens, tenant content and full addresses never enter this
 *    file.
 */

/** Anything OTLP calls an attribute. Only these three types are ever sent. */
type Attribute = { key: string; value: { stringValue: string } | { intValue: string } | { doubleValue: number } };

function attributes(pairs: Record<string, string | number>): Attribute[] {
  return Object.entries(pairs).map(([key, value]) =>
    typeof value === 'number'
      ? { key, value: Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value } }
      : { key, value: { stringValue: value } },
  );
}

/** Nanoseconds since the epoch, as a string — what OTLP timestamps are. */
function nanos(at: number = Date.now()): string {
  return `${at}000000`;
}

/**
 * What identifies this process to a collector.
 *
 * `service.instance.id` is what makes two replicas distinguishable, and without
 * it their metrics are summed into one series that answers no question about
 * either.
 */
function resource(): { attributes: Attribute[] } {
  return {
    attributes: attributes({
      'service.name': config.otlp.serviceName,
      'service.version': config.buildCommit || 'unknown',
      'service.instance.id': INSTANCE_ID,
      'deployment.environment': config.env,
    }),
  };
}

/**
 * Stable for the life of the process, and derived from nothing sensitive.
 *
 * A hostname would be the obvious choice and in a container it is a hash that
 * changes on every deploy, which is the same problem wearing a better name.
 */
const INSTANCE_ID = `${process.pid}-${Date.now().toString(36)}`;

// ------------------------------------------------------------- the queue

export type ExportRecord = {
  at: number;
  severity: 'INFO' | 'WARN' | 'ERROR';
  body: string;
  attributes: Record<string, string | number>;
};

/** How the exporter is doing, for the health endpoint and the watch rule. */
export type EgressPosition = {
  configured: boolean;
  endpoint?: string;
  queued: number;
  /** Records thrown away because the queue was full. Exported as a metric too. */
  dropped: number;
  exported: number;
  failures: number;
  lastError?: string;
  lastSuccessAt?: string;
  lastAttemptAt?: string;
};

const queue: ExportRecord[] = [];
let dropped = 0;
let exported = 0;
let failures = 0;
let lastError: string | undefined;
let lastSuccessAt: string | undefined;
let lastAttemptAt: string | undefined;
let timer: NodeJS.Timeout | undefined;

export function egressConfigured(): boolean {
  return config.otlp.endpoint.trim() !== '';
}

export function egressPosition(): EgressPosition {
  return {
    configured: egressConfigured(),
    endpoint: egressConfigured() ? config.otlp.endpoint : undefined,
    queued: queue.length,
    dropped,
    exported,
    failures,
    lastError,
    lastSuccessAt,
    lastAttemptAt,
  };
}

/**
 * Queue one record for export.
 *
 * Returns nothing and throws nothing. A caller on the request path must never
 * learn that telemetry is unwell, because the only thing it could usefully do
 * with that knowledge is fail a request that otherwise worked.
 */
export function record(entry: ExportRecord): void {
  if (!egressConfigured()) return;
  if (queue.length >= config.otlp.queueSize) {
    // Oldest first. In an incident the newest records are the ones describing
    // it, and a queue that dropped those to keep the calm ones before it would
    // be exactly backwards.
    queue.shift();
    dropped += 1;
  }
  queue.push(entry);
}

// ----------------------------------------------------------- the payloads

/** Every counter series, as OTLP sums. */
export function metricsPayload(now = Date.now()): unknown {
  const names: CounterName[] = [
    'requests_total',
    'auth_failures_total',
    'authz_denies_total',
    'rate_limited_total',
    'validation_reject_total',
  ];

  const metrics: unknown[] = [];

  for (const name of names) {
    const points = counters.read(name).map((series) => ({
      attributes: attributes(series.labels),
      timeUnixNano: nanos(now),
      asInt: String(series.value),
    }));
    if (points.length === 0) continue;
    metrics.push({
      name: `construx.${name}`,
      sum: {
        dataPoints: points,
        // Monotonic and cumulative, which is what these are: the counters never
        // go down and are never reset in production. Declaring them as delta
        // would make a collector compute differences that are already absolute.
        aggregationTemporality: 2,
        isMonotonic: true,
      },
    });
  }

  const histograms = latency.read().map((route) => ({
    attributes: attributes({ route: route.routeId }),
    timeUnixNano: nanos(now),
    count: String(route.count),
    sum: route.sumMs,
    explicitBounds: [...LATENCY_BUCKETS_MS],
    // OTLP wants per-bucket counts; the histogram holds them cumulatively,
    // because that is what a percentile is read from. Differenced here rather
    // than stored twice.
    bucketCounts: route.buckets.map((bucket, index) =>
      String(bucket.cumulative - (index === 0 ? 0 : (route.buckets[index - 1]?.cumulative ?? 0))),
    ),
  }));

  if (histograms.length > 0) {
    metrics.push({
      name: 'construx.request.duration',
      unit: 'ms',
      histogram: { dataPoints: histograms, aggregationTemporality: 2 },
    });
  }

  // The exporter's own health, exported through the exporter. If this number is
  // rising the numbers beside it are incomplete, and there is no way to learn
  // that from the outside otherwise.
  metrics.push({
    name: 'construx.telemetry.dropped_total',
    sum: {
      dataPoints: [{ attributes: [], timeUnixNano: nanos(now), asInt: String(dropped) }],
      aggregationTemporality: 2,
      isMonotonic: true,
    },
  });

  return { resourceMetrics: [{ resource: resource(), scopeMetrics: [{ scope: { name: 'construx' }, metrics }] }] };
}

const SEVERITY_NUMBER = { INFO: 9, WARN: 13, ERROR: 17 } as const;

export function logsPayload(records: ExportRecord[]): unknown {
  return {
    resourceLogs: [
      {
        resource: resource(),
        scopeLogs: [
          {
            scope: { name: 'construx' },
            logRecords: records.map((entry) => ({
              timeUnixNano: nanos(entry.at),
              severityNumber: SEVERITY_NUMBER[entry.severity],
              severityText: entry.severity,
              body: { stringValue: entry.body },
              attributes: attributes(entry.attributes),
            })),
          },
        ],
      },
    ],
  };
}

// ------------------------------------------------------------- the export

async function post(path: string, payload: unknown): Promise<void> {
  const endpoint = config.otlp.endpoint.replace(/\/$/, '');
  const response = await fetch(`${endpoint}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...parseHeaders(config.otlp.headers),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.otlp.timeoutMs),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`${response.status} ${detail.slice(0, 200)}`);
  }
}

/**
 * `key=value,key2=value2`, which is how OTEL_EXPORTER_OTLP_HEADERS is specified.
 *
 * This is where an authorisation token for the collector arrives, so it is
 * parsed and never logged — `egressPosition()` reports the endpoint and not
 * these.
 */
export function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key !== '' && value !== '') headers[key] = value;
  }
  return headers;
}

/**
 * Ship one batch.
 *
 * Exported so a test can drive it and so an operator can force one from the
 * admin screen rather than waiting for an interval. Never throws: a failure is
 * recorded and the records are put back, because losing telemetry to a
 * collector's bad afternoon is the outcome this whole file exists to prevent.
 */
export async function flush(): Promise<{ metrics: boolean; logs: number; error?: string }> {
  if (!egressConfigured()) return { metrics: false, logs: 0 };

  lastAttemptAt = new Date().toISOString();
  const batch = queue.splice(0, config.otlp.batchSize);

  try {
    await post('/v1/metrics', metricsPayload());
    if (batch.length > 0) await post('/v1/logs', logsPayload(batch));
    exported += batch.length;
    lastSuccessAt = new Date().toISOString();
    lastError = undefined;
    return { metrics: true, logs: batch.length };
  } catch (error) {
    failures += 1;
    lastError = error instanceof Error ? error.message : String(error);

    // Put them back at the front, oldest first, so ordering survives a failure.
    // Capped on the way in, so a collector down for a week fills the queue and
    // then drops — bounded, counted, and visible — rather than growing until
    // the process is killed for memory.
    queue.unshift(...batch);
    while (queue.length > config.otlp.queueSize) {
      queue.shift();
      dropped += 1;
    }
    return { metrics: false, logs: 0, error: lastError };
  }
}

/** Everything the security stream has seen since the last call, as log records. */
export function drainSecurityStream(since?: string): ExportRecord[] {
  return securityEvents({ limit: 500 })
    .filter((event) => !since || event.timestamp > since)
    .map((event) => ({
      at: Date.parse(event.timestamp),
      severity: event.kind === 'AUTH_FAILURE' || event.kind === 'AUTHZ_DENY' ? 'WARN' : 'INFO',
      body: `${event.kind}: ${event.reason}`,
      attributes: {
        'http.method': event.method,
        'http.route': event.path,
        'http.status_code': event.status,
        'trace.id': event.traceId,
        'correlation.id': event.correlationId,
        // Already truncated to a network by `truncateAddress`. A full address is
        // personal data and is not needed to see a brute-force pattern.
        ...(event.remote ? { 'client.network': event.remote } : {}),
        // The actor id, which is an opaque identifier rather than a name or an
        // address. Enough to correlate; not enough to identify a person from the
        // telemetry alone.
        ...(event.actorId ? { 'enduser.id': event.actorId } : {}),
      },
    }));
}

let lastSecurityTimestamp: string | undefined;

/** Start the interval. Returns undefined where nothing is configured. */
export function startEgress(): NodeJS.Timeout | undefined {
  if (!egressConfigured() || timer) return timer;

  timer = setInterval(() => {
    const events = drainSecurityStream(lastSecurityTimestamp);
    if (events.length > 0) {
      lastSecurityTimestamp = new Date(Math.max(...events.map((event) => event.at))).toISOString();
      for (const event of events) record(event);
    }
    void flush();
  }, config.otlp.intervalSeconds * 1000);

  timer.unref();
  return timer;
}

export function stopEgress(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

/** Test isolation only. */
export function resetEgress(): void {
  queue.length = 0;
  dropped = 0;
  exported = 0;
  failures = 0;
  lastError = undefined;
  lastSuccessAt = undefined;
  lastAttemptAt = undefined;
  lastSecurityTimestamp = undefined;
  stopEgress();
}
