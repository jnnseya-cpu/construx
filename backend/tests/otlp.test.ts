import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { config } from '../src/config.ts';
import { counters, latency, recordSecurityEvent, resetTelemetry } from '../src/api/telemetry.ts';
import {
  drainSecurityStream,
  egressConfigured,
  egressPosition,
  flush,
  logsPayload,
  metricsPayload,
  parseHeaders,
  record,
  resetEgress,
} from '../src/ops/otlp.ts';

/**
 * Shipping telemetry somewhere it outlives the container.
 *
 * Verified against a collector of this file's own — a real HTTP server that
 * captures what arrives — rather than a stub that returns 200 to anything. The
 * payload shape is the whole point: a collector rejects a malformed OTLP body
 * and the symptom is silence, which is indistinguishable from a healthy quiet
 * platform.
 *
 * The assertions that matter most are the failure ones. An exporter that grows
 * without bound takes the process down to protect its own telemetry, and one
 * that drops quietly makes a lossy pipeline look like a calm one. Both are worse
 * than having no exporter at all, which is why the drop count is itself
 * exported.
 */

type Captured = { path: string; body: any; headers: Record<string, string | undefined> };

let collector: Server | undefined;
let received: Captured[] = [];
let answer: { status: number; body: string } = { status: 200, body: '{}' };
let endpoint = '';

const original = { ...config.otlp };

function tune(over: Partial<typeof config.otlp>): void {
  Object.assign(config.otlp as object, original, over);
}

before(async () => {
  await new Promise<void>((resolve) => {
    collector = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          body = { unparseable: Buffer.concat(chunks).toString('utf8') };
        }
        received.push({ path: request.url ?? '', body, headers: request.headers as Record<string, string | undefined> });
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(answer.body);
      });
    });
    collector.listen(0, '127.0.0.1', () => {
      endpoint = `http://127.0.0.1:${(collector!.address() as { port: number }).port}`;
      resolve();
    });
  });
});

after(() => {
  collector?.close();
  Object.assign(config.otlp as object, original);
});

beforeEach(() => {
  received = [];
  answer = { status: 200, body: '{}' };
  resetTelemetry();
  resetEgress();
  tune({ endpoint, queueSize: 8, batchSize: 4, timeoutMs: 2_000 });
});

afterEach(() => {
  resetEgress();
});

describe('with nothing configured, nothing is shipped and nothing pretends otherwise', () => {
  it('says so rather than queueing into a void', async () => {
    tune({ endpoint: '' });
    assert.equal(egressConfigured(), false);

    record({ at: Date.now(), severity: 'INFO', body: 'a request', attributes: {} });
    // Queued nothing. A queue that filled with records nobody would ever ship
    // is a memory leak with a reassuring name.
    assert.equal(egressPosition().queued, 0);

    const result = await flush();
    assert.deepEqual(result, { metrics: false, logs: 0 });
    assert.equal(received.length, 0);
  });

  it('reports the deployment rather than a health it cannot know', () => {
    tune({ endpoint: '' });
    const position = egressPosition();
    assert.equal(position.configured, false);
    assert.equal(position.endpoint, undefined);
  });
});

describe('the payload is the shape a collector actually accepts', () => {
  it('sends counters as monotonic cumulative sums', () => {
    counters.increment('requests_total', { route: 'GET /v1/x', status: '200' });
    counters.increment('requests_total', { route: 'GET /v1/x', status: '200' });
    counters.increment('auth_failures_total', { reason: 'EXPIRED' });

    const payload = metricsPayload(1_700_000_000_000) as any;
    const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
    const requests = metrics.find((metric: any) => metric.name === 'construx.requests_total');

    assert.ok(requests, 'requests_total was not exported');
    // Cumulative (2) and monotonic: these counters never go down and are never
    // reset in production, so declaring them delta would make a collector
    // difference numbers that are already absolute.
    assert.equal(requests.sum.aggregationTemporality, 2);
    assert.equal(requests.sum.isMonotonic, true);
    assert.equal(requests.sum.dataPoints[0].asInt, '2');
    // Integers travel as strings in OTLP/JSON. Sending a number is the mistake
    // that a collector rejects with a 400 nobody reads.
    assert.equal(typeof requests.sum.dataPoints[0].asInt, 'string');
    assert.equal(requests.sum.dataPoints[0].timeUnixNano, '1700000000000000000');
  });

  it('differences the histogram, because OTLP wants per-bucket and the source is cumulative', () => {
    latency.observe('GET /v1/x', 3);
    latency.observe('GET /v1/x', 3);
    latency.observe('GET /v1/x', 400);

    const payload = metricsPayload() as any;
    const histogram = payload.resourceMetrics[0].scopeMetrics[0].metrics.find(
      (metric: any) => metric.name === 'construx.request.duration',
    );
    assert.ok(histogram);

    const point = histogram.histogram.dataPoints[0];
    assert.equal(point.count, '3');
    // Buckets sum back to the count. A cumulative array sent as if it were
    // per-bucket produces a total several times the real one, and every
    // percentile computed from it is wrong in a way that looks plausible.
    const total = point.bucketCounts.reduce((sum: number, value: string) => sum + Number(value), 0);
    assert.equal(total, 3);
    assert.equal(point.bucketCounts[0], '2', 'both 3ms requests belong in the first bucket');
    assert.equal(point.explicitBounds.length + 1, point.bucketCounts.length);
  });

  it('identifies the instance, so two replicas are not summed into one series', () => {
    const payload = metricsPayload() as any;
    const keys = payload.resourceMetrics[0].resource.attributes.map((attribute: any) => attribute.key);
    assert.ok(keys.includes('service.name'));
    assert.ok(keys.includes('service.instance.id'));
    assert.ok(keys.includes('deployment.environment'));
  });

  it('exports its own drop count, because a lossy pipeline must not look like a quiet one', () => {
    const payload = metricsPayload() as any;
    const dropped = payload.resourceMetrics[0].scopeMetrics[0].metrics.find(
      (metric: any) => metric.name === 'construx.telemetry.dropped_total',
    );
    assert.ok(dropped, 'the exporter does not report its own losses');
    assert.equal(dropped.sum.isMonotonic, true);
  });

  it('maps severity to the numbers OTLP defines', () => {
    const payload = logsPayload([
      { at: 1_700_000_000_000, severity: 'ERROR', body: 'it broke', attributes: { 'http.route': 'GET /v1/x' } },
    ]) as any;
    const entry = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    assert.equal(entry.severityNumber, 17);
    assert.equal(entry.severityText, 'ERROR');
    assert.equal(entry.body.stringValue, 'it broke');
    assert.equal(entry.timeUnixNano, '1700000000000000000');
  });
});

describe('what is shipped, and what is never shipped', () => {
  it('carries the correlation id, which is how an alert becomes a root cause', () => {
    recordSecurityEvent({
      kind: 'AUTHZ_DENY',
      reason: 'ACCESS_DENIED',
      method: 'POST',
      path: '/v1/projects/:projectId/payments',
      traceId: 'trace-1',
      correlationId: 'corr-1',
      actorId: 'user-9',
      remote: '203.0.113.0/24',
      status: 403,
    });

    const records = drainSecurityStream();
    assert.equal(records.length, 1);
    assert.equal(records[0]!.attributes['correlation.id'], 'corr-1');
    assert.equal(records[0]!.attributes['trace.id'], 'trace-1');
    assert.equal(records[0]!.severity, 'WARN');
  });

  it('ships an address already truncated to a network, never a whole one', () => {
    recordSecurityEvent({
      kind: 'AUTH_FAILURE',
      reason: 'BAD_SIGNATURE',
      method: 'POST',
      path: '/v1/auth/login',
      traceId: 't',
      correlationId: 'c',
      remote: '198.51.100.0/24',
      status: 401,
    });
    const records = drainSecurityStream();
    // A full address is personal data under GDPR and is not needed to see a
    // brute-force pattern. The truncation happens upstream; this asserts nothing
    // here un-truncates it.
    assert.equal(records[0]!.attributes['client.network'], '198.51.100.0/24');
    assert.equal(JSON.stringify(records[0]).includes('198.51.100.14'), false);
  });

  it('never puts the collector token in the position report', () => {
    tune({ endpoint, headers: 'authorization=Bearer not-a-real-token' });
    const position = egressPosition();
    assert.equal(JSON.stringify(position).includes('not-a-real-token'), false);
    assert.equal(position.endpoint, endpoint);
  });

  it('parses collector headers in the documented form', () => {
    assert.deepEqual(parseHeaders('authorization=Bearer abc,x-tenant=acme'), {
      authorization: 'Bearer abc',
      'x-tenant': 'acme',
    });
    assert.deepEqual(parseHeaders(''), {});
    assert.deepEqual(parseHeaders('malformed'), {});
  });
});

describe('against a collector that answers', () => {
  it('posts metrics and logs to the paths OTLP defines', async () => {
    tune({ endpoint, headers: 'authorization=Bearer collector-token' });
    counters.increment('requests_total', { route: 'GET /v1/x', status: '200' });
    record({ at: Date.now(), severity: 'INFO', body: 'a request', attributes: { 'http.route': 'GET /v1/x' } });

    const result = await flush();
    assert.equal(result.metrics, true);
    assert.equal(result.logs, 1);

    assert.deepEqual(
      received.map((capture) => capture.path).sort(),
      ['/v1/logs', '/v1/metrics'],
    );
    // The token reaches the collector and nowhere else.
    assert.equal(received[0]!.headers.authorization, 'Bearer collector-token');
    assert.equal(received[0]!.headers['content-type'], 'application/json');
  });

  it('sends metrics even when there is nothing in the log queue', async () => {
    counters.increment('requests_total', { route: 'GET /v1/x', status: '200' });
    const result = await flush();
    assert.equal(result.metrics, true);
    assert.equal(result.logs, 0);
    assert.deepEqual(received.map((capture) => capture.path), ['/v1/metrics']);
  });

  it('respects the batch size rather than shipping the whole queue at once', async () => {
    for (let index = 0; index < 6; index += 1) {
      record({ at: Date.now(), severity: 'INFO', body: `record ${index}`, attributes: {} });
    }
    const first = await flush();
    assert.equal(first.logs, 4);
    assert.equal(egressPosition().queued, 2);

    const second = await flush();
    assert.equal(second.logs, 2);
    assert.equal(egressPosition().queued, 0);
  });
});

describe('against a collector that does not', () => {
  it('records the failure and keeps the records rather than losing them', async () => {
    answer = { status: 503, body: 'collector unavailable' };
    record({ at: Date.now(), severity: 'ERROR', body: 'the one record that mattered', attributes: {} });

    const result = await flush();
    assert.equal(result.metrics, false);
    assert.match(result.error ?? '', /503/);

    const position = egressPosition();
    assert.equal(position.failures, 1);
    // Put back, not dropped. Losing telemetry to a collector's bad afternoon is
    // the outcome this whole module exists to prevent.
    assert.equal(position.queued, 1);
    assert.match(position.lastError ?? '', /503/);
  });

  it('keeps the platform own counters working while egress is broken', async () => {
    answer = { status: 500, body: 'nope' };
    counters.increment('requests_total', { route: 'GET /v1/x', status: '200' });
    await flush();
    // The counters are the source and the exporter is a reader. A collector
    // being down changes what anybody else can see, not what the platform knows
    // about itself.
    assert.equal(counters.total('requests_total'), 1);
  });

  it('drops the oldest and counts it rather than growing without bound', async () => {
    answer = { status: 503, body: 'still down' };
    // Queue size is 8. Twenty records arrive while the collector is down.
    for (let index = 0; index < 20; index += 1) {
      record({ at: Date.now(), severity: 'INFO', body: `record ${index}`, attributes: {} });
    }
    const position = egressPosition();
    assert.equal(position.queued, 8, 'the queue grew past its bound');
    assert.equal(position.dropped, 12);

    // Oldest first: in an incident the newest records describe it, and dropping
    // those to keep the calm ones before them would be exactly backwards.
    await flush();
    assert.equal(egressPosition().queued, 8);
  });

  it('does not throw at a caller who has no use for the knowledge', async () => {
    answer = { status: 500, body: 'broken' };
    // A caller on the request path must never learn that telemetry is unwell:
    // the only thing it could do with that is fail a request that worked.
    await flush();
    record({ at: Date.now(), severity: 'INFO', body: 'still fine', attributes: {} });
    assert.ok(egressPosition().failures >= 1);
  });

  it('gives up rather than hanging when a collector accepts and never answers', async () => {
    const silent = createServer(() => {
      /* accepts the connection, answers nothing */
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    tune({ endpoint: `http://127.0.0.1:${(silent.address() as { port: number }).port}`, timeoutMs: 300 });

    const started = Date.now();
    const result = await flush();
    assert.equal(result.metrics, false);
    assert.ok(Date.now() - started < 5_000, 'the export did not time out');
    silent.close();
  });
});
