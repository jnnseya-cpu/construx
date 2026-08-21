import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  counters,
  gatewayMetrics,
  latency,
  LATENCY_BUCKETS_MS,
  recordSecurityEvent,
  resetTelemetry,
  securityEvents,
  securitySummary,
  truncateAddress,
} from '../src/api/telemetry.ts';

/**
 * Gateway telemetry.
 *
 * The specification names six metric series and an audit stream. What these
 * tests actually guard is the property that made the previous implementation
 * wrong: counters must be monotonic and independent of any buffer that trims.
 * A request count that falls under load is the number an on-call engineer
 * reaches for first, and it was quietly decreasing.
 */

beforeEach(() => resetTelemetry());

describe('Counters', () => {
  it('only ever go up, and never come from a rotating buffer', () => {
    for (let i = 0; i < 12_000; i++) {
      counters.increment('requests_total', { route: 'GET /v1/projects', status: '200' });
    }
    // Well past the 5,000-entry log buffer that used to back these figures.
    assert.equal(counters.total('requests_total'), 12_000);
  });

  it('keeps a series per label set, and orders by volume', () => {
    counters.increment('requests_total', { route: 'GET /a', status: '200' });
    counters.increment('requests_total', { route: 'GET /a', status: '200' });
    counters.increment('requests_total', { route: 'GET /a', status: '500' });
    counters.increment('requests_total', { route: 'GET /b', status: '200' });

    const series = counters.read('requests_total');
    assert.equal(series.length, 3);
    assert.equal(series[0]!.value, 2);
    assert.equal(series[0]!.labels.status, '200');
    assert.equal(counters.total('requests_total'), 4);
  });

  it('does not fragment a series on label ordering', () => {
    counters.increment('authz_denies_total', { route: 'GET /a', policyId: 'ACCESS_DENIED' });
    counters.increment('authz_denies_total', { policyId: 'ACCESS_DENIED', route: 'GET /a' });
    assert.equal(counters.read('authz_denies_total').length, 1, 'the same labels produced two series');
    assert.equal(counters.total('authz_denies_total'), 2);
  });

  it('publishes exactly the series the specification names', () => {
    const published = gatewayMetrics();
    assert.deepEqual(Object.keys(published.totals).sort(), [
      'auth_failures_total',
      'authz_denies_total',
      'rate_limited_total',
      'requests_total',
      'validation_reject_total',
    ]);
    assert.ok('request_latency_ms' in published);
  });
});

describe('Latency', () => {
  it('buckets cumulatively and keeps the tail', () => {
    latency.observe('GET /v1/projects', 3);
    latency.observe('GET /v1/projects', 40);
    latency.observe('GET /v1/projects', 9_000);

    const [route] = latency.read();
    assert.equal(route!.count, 3);
    assert.equal(route!.routeId, 'GET /v1/projects');

    // Cumulative: the 50ms bucket holds the 3ms and the 40ms request.
    const at50 = route!.buckets.find((b) => b.leMs === 50)!;
    assert.equal(at50.cumulative, 2);

    // The 9-second request falls past every boundary and must still be counted,
    // or the histogram would hide exactly the requests worth knowing about.
    const infinite = route!.buckets.at(-1)!;
    assert.equal(infinite.leMs, '+Inf');
    assert.equal(infinite.cumulative, 3);
    assert.equal(route!.buckets.length, LATENCY_BUCKETS_MS.length + 1);
  });

  it('groups by route rather than by path', () => {
    latency.observe('GET /v1/projects/:projectId', 10);
    latency.observe('GET /v1/projects/:projectId', 20);
    assert.equal(latency.read().length, 1, 'a path with an id in it would produce one series per project');
    assert.equal(latency.read()[0]!.meanMs, 15);
  });
});

describe('The security audit stream', () => {
  const event = (over: Partial<Parameters<typeof recordSecurityEvent>[0]> = {}) =>
    recordSecurityEvent({
      kind: 'AUTH_FAILURE',
      reason: 'NO_CREDENTIAL',
      method: 'POST',
      path: 'POST /v1/auth/login',
      traceId: 't',
      correlationId: 'c',
      remote: '203.0.113.0/24',
      status: 401,
      ...over,
    });

  it('truncates a source to a network, never a person', () => {
    // A full address is personal data and is not needed to see a pattern.
    assert.equal(truncateAddress('203.0.113.47'), '203.0.113.0/24');
    assert.equal(truncateAddress('::ffff:198.51.100.9'), '198.51.100.0/24');
    assert.equal(truncateAddress('2001:db8:85a3:8d3:1319:8a2e:370:7348'), '2001:db8:85a3::/48');
    assert.equal(truncateAddress(undefined), undefined);
    assert.equal(truncateAddress('garbage'), undefined);
  });

  it('records reason codes, never the credential that failed', () => {
    event({ reason: 'TOKEN_EXPIRED', kind: 'TOKEN_ANOMALY' });
    const [recorded] = securityEvents();

    assert.equal(recorded!.reason, 'TOKEN_EXPIRED');
    const serialised = JSON.stringify(recorded);
    assert.ok(!/Bearer|eyJ|password|secret/i.test(serialised), 'a credential reached the audit stream');
  });

  it('shows the brute-force shape: one source, many failures', () => {
    for (let i = 0; i < 5; i++) event({ remote: '203.0.113.0/24' });
    event({ remote: '198.51.100.0/24' });

    const summary = securitySummary();
    assert.equal(summary.total, 6);
    assert.equal(summary.byKind.AUTH_FAILURE, 6);
    // Only sources with more than one failure are worth a name.
    assert.deepEqual(summary.repeatSources, [{ remote: '203.0.113.0/24', failures: 5 }]);
  });

  it('filters by kind so a denial is not lost in ordinary traffic', () => {
    event({ kind: 'AUTH_FAILURE' });
    event({ kind: 'AUTHZ_DENY', reason: 'ACCESS_DENIED', status: 403 });
    event({ kind: 'ADMIN_ACCESS', reason: 'ADMIN_ENDPOINT_REACHED', status: 200 });

    assert.equal(securityEvents({ kind: 'AUTHZ_DENY' }).length, 1);
    assert.equal(securityEvents().length, 3);
    assert.equal(securityEvents({ limit: 2 }).length, 2);
  });

  it('loses history when it trims, but never corrupts a total', () => {
    for (let i = 0; i < 6_000; i++) event();
    // The stream is bounded; the counters are not derived from it.
    assert.ok(securitySummary().total <= 5_000);
    counters.increment('auth_failures_total', { reason: 'NO_CREDENTIAL' });
    assert.equal(counters.total('auth_failures_total'), 1);
  });
});
