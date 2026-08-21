import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config.ts';
import { AuthError, RateLimitError, ValidationError, toProblem, DomainError } from '../core/errors.ts';
import { assertValid, type Schema } from '../core/validate.ts';
import { counters, latency, recordSecurityEvent, truncateAddress } from './telemetry.ts';
import { verifyToken, type AuthContext } from '../identity/auth.ts';

/**
 * Gateway middleware. The gateway is the only internet-facing component and it
 * is entirely stateless — it verifies, limits, validates, and forwards. Nothing
 * about a session is stored here.
 */

export type RequestContext = {
  traceId: string;
  correlationId: string;
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  auth?: AuthContext;
  idempotencyKey?: string;
  /** The route pattern this matched, so metrics group by route not by path. */
  routeId?: string;
  /** Truncated source, for the audit stream. Never the full address. */
  remote?: string;
  /** Outcome of authentication, with a reason code when it failed. */
  authResult?: { ok: boolean; reason?: string };
  /** Outcome of authorisation, with the area and code that were checked. */
  authzDecision?: { allow: boolean; policyId?: string; reason?: string };
  rateLimitKey?: string;
  rateLimitRemaining?: number;
  /**
   * The locale this request should be answered in, resolved from
   * `Accept-Language` at the edge and validated there. Handlers get a usable
   * tag rather than a client-supplied string that would throw at a formatter.
   */
  locale: string;
  startedAt: number;
};

// --- Tracing ----------------------------------------------------------------

export function buildTrace(req: IncomingMessage): { traceId: string; correlationId: string } {
  // Propagate an inbound trace where one exists so a request can be followed
  // across the client, the gateway and every downstream service.
  const traceId = header(req, 'x-trace-id') ?? randomUUID();
  const correlationId = header(req, 'x-correlation-id') ?? traceId;
  return { traceId, correlationId };
}

export function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

// --- Rate limiting ----------------------------------------------------------

type Bucket = { tokens: number; lastRefill: number };

/**
 * Token bucket with burst capacity. Keys are tenant-aware so one tenant cannot
 * exhaust another's capacity, and pre-auth routes fall back to IP.
 */
class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  #backendHealthy = true;

  setBackendHealthy(healthy: boolean): void {
    this.#backendHealthy = healthy;
  }

  consume(
    key: string,
    options: { max: number; burst: number; windowSeconds: number },
  ): { allowed: boolean; retryAfter: number; remaining: number } {
    // Fail closed: if the shared limiter backend is unavailable, deny rather
    // than allow. An open door during an outage is how brute force gets in.
    if (!this.#backendHealthy) return { allowed: false, retryAfter: options.windowSeconds, remaining: 0 };

    const now = Date.now();
    const capacity = options.max + options.burst;
    const refillPerMs = options.max / (options.windowSeconds * 1000);

    const bucket = this.#buckets.get(key) ?? { tokens: capacity, lastRefill: now };
    bucket.tokens = Math.min(capacity, bucket.tokens + (now - bucket.lastRefill) * refillPerMs);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      this.#buckets.set(key, bucket);
      return { allowed: false, retryAfter: Math.ceil((1 - bucket.tokens) / refillPerMs / 1000), remaining: 0 };
    }

    bucket.tokens -= 1;
    this.#buckets.set(key, bucket);
    return { allowed: true, retryAfter: 0, remaining: Math.floor(bucket.tokens) };
  }

  reset(): void {
    this.#buckets.clear();
  }
}

export const rateLimiter = new RateLimiter();

/** Auth routes carry a tighter limit — they are the brute-force surface. */
const ROUTE_GROUP_LIMITS: Record<string, { max: number; burst: number }> = {
  auth: { max: 20, burst: 5 },
  ai: { max: 100, burst: 20 },
  default: { max: config.rateLimit.max, burst: config.rateLimit.burst },
};

export function applyRateLimit(ctx: RequestContext, remoteAddress: string): void {
  const group = ctx.path.startsWith('/v1/auth') ? 'auth' : ctx.path.includes('/ai/') ? 'ai' : 'default';
  const limits = ROUTE_GROUP_LIMITS[group] ?? ROUTE_GROUP_LIMITS.default;

  const key = ctx.auth
    ? `rl:${ctx.auth.tenantId}:${ctx.auth.actorId}:${group}`
    : `rl:ip:${remoteAddress}:${group}`;

  const result = rateLimiter.consume(key, {
    max: (limits as { max: number }).max,
    burst: (limits as { burst: number }).burst,
    windowSeconds: config.rateLimit.windowSeconds,
  });

  ctx.rateLimitKey = key;
  ctx.rateLimitRemaining = result.remaining;

  if (!result.allowed) {
    counters.increment('rate_limited_total', { route: ctx.routeId ?? ctx.path, group });
    recordSecurityEvent({
      kind: 'RATE_LIMITED',
      reason: ctx.auth ? 'TOKEN_RATE_LIMIT' : 'IP_RATE_LIMIT',
      method: ctx.method,
      path: ctx.routeId ?? ctx.path,
      traceId: ctx.traceId,
      correlationId: ctx.correlationId,
      tenantId: ctx.auth?.tenantId,
      actorId: ctx.auth?.actorId,
      remote: ctx.remote,
      status: 429,
    });
    throw new RateLimitError('Rate limit exceeded for this key', result.retryAfter);
  }
}

// --- Authentication ---------------------------------------------------------

export function authenticate(req: IncomingMessage, ctx: RequestContext, routeIsPublic: boolean): void {
  const authorization = header(req, 'authorization');

  /** Reason codes only. A security log that records the token is the leak. */
  const fail = (reason: string, message: string): never => {
    ctx.authResult = { ok: false, reason };
    counters.increment('auth_failures_total', { reason });
    recordSecurityEvent({
      kind: reason === 'TOKEN_INVALID' || reason === 'TOKEN_EXPIRED' ? 'TOKEN_ANOMALY' : 'AUTH_FAILURE',
      reason,
      method: ctx.method,
      path: ctx.routeId ?? ctx.path,
      traceId: ctx.traceId,
      correlationId: ctx.correlationId,
      remote: ctx.remote,
      status: 401,
    });
    throw new AuthError(message);
  };

  if (!authorization) {
    if (routeIsPublic || !config.auth.required) return;
    fail('NO_CREDENTIAL', 'Authorization header is required');
  }

  const [scheme, token] = authorization!.split(' ');
  if (scheme !== 'Bearer' || !token) fail('MALFORMED_HEADER', 'Expected a Bearer token');

  // Expiry, signature and revocation are all enforced before routing.
  try {
    ctx.auth = verifyToken(token!, 'access');
  } catch (error) {
    const code = (error as { code?: string }).code ?? '';
    fail(
      /EXPIRED/i.test(code) ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
      error instanceof Error ? error.message : 'Token rejected',
    );
  }
  ctx.authResult = { ok: true };
}

// --- Validation -------------------------------------------------------------

export function validateRequest(ctx: RequestContext, schema: Schema | undefined, isPublicRoute: boolean): void {
  if (!config.validation.required || !schema) return;

  const rejected = (): void => {
    counters.increment('validation_reject_total', { route: ctx.routeId ?? ctx.path });
    recordSecurityEvent({
      kind: 'VALIDATION_REJECT',
      reason: 'SCHEMA_VIOLATION',
      method: ctx.method,
      path: ctx.routeId ?? ctx.path,
      traceId: ctx.traceId,
      correlationId: ctx.correlationId,
      tenantId: ctx.auth?.tenantId,
      actorId: ctx.auth?.actorId,
      remote: ctx.remote,
      status: 400,
    });
  };

  try {
    assertValid(ctx.body ?? {}, schema, 'request body');
  } catch (error) {
    rejected();
    // Public auth endpoints get a generic message: detailed validation errors
    // are a user-enumeration aid on a login route.
    if (isPublicRoute && error instanceof ValidationError) {
      throw new ValidationError('The request could not be processed');
    }
    throw error;
  }
}

// --- Idempotency ------------------------------------------------------------

const idempotencyCache = new Map<string, { status: number; body: unknown; storedAt: number }>();
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export function readIdempotent(key: string | undefined): { status: number; body: unknown } | undefined {
  if (!key) return undefined;
  const cached = idempotencyCache.get(key);
  if (!cached) return undefined;
  if (Date.now() - cached.storedAt > IDEMPOTENCY_TTL_MS) {
    idempotencyCache.delete(key);
    return undefined;
  }
  return { status: cached.status, body: cached.body };
}

export function storeIdempotent(key: string | undefined, status: number, body: unknown): void {
  if (!key) return;
  idempotencyCache.set(key, { status, body, storedAt: Date.now() });
}

// --- Response helpers -------------------------------------------------------

export function sendJson(res: ServerResponse, ctx: RequestContext, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'x-trace-id': ctx.traceId,
    'x-correlation-id': ctx.correlationId,
    // Zero-trust posture: no caching of authorised responses by intermediaries.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  });
  res.end(payload);
}

/**
 * Send an HTML page from a route handler.
 *
 * Only one surface needs this: the unsubscribe link, which is followed by a
 * mail client rather than by the application. It has to render for someone who
 * is not signed in and may have scripting disabled, so the page is self
 * contained and the content-security-policy forbids everything except the
 * inline styling it carries.
 */
export function sendHtml(res: ServerResponse, ctx: RequestContext, status: number, html: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'x-trace-id': ctx.traceId,
    'x-correlation-id': ctx.correlationId,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  });
  res.end(html);
}

export function sendProblem(res: ServerResponse, ctx: RequestContext, error: unknown): void {
  const problem = toProblem(error, ctx.path, ctx.traceId, ctx.correlationId);
  const payload = JSON.stringify(problem);

  const headers: Record<string, string | number> = {
    'Content-Type': 'application/problem+json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'x-trace-id': ctx.traceId,
    'x-correlation-id': ctx.correlationId,
    'Cache-Control': 'no-store',
  };
  if (error instanceof RateLimitError) headers['Retry-After'] = error.retryAfterSeconds;

  res.writeHead(problem.status, headers);
  res.end(payload);
}

// --- Structured logging -----------------------------------------------------

export type LogRecord = {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  traceId: string;
  correlationId: string;
  method: string;
  path: string;
  /** The matched route pattern. A path has an id in it; a route does not. */
  routeId?: string;
  status: number;
  durationMs: number;
  tenantId?: string;
  actorId?: string;
  authResult?: string;
  authzDecision?: string;
  rateLimitKey?: string;
  rateLimitRemaining?: number;
  /** Present when the request was denied, so denials are queryable. */
  denyReason?: string;
};

const logs: LogRecord[] = [];

export function logRequest(ctx: RequestContext, status: number, error?: unknown): void {
  const durationMs = Date.now() - ctx.startedAt;
  const routeId = ctx.routeId ?? ctx.path;
  const denyReason = error instanceof DomainError ? error.code : undefined;

  // Counters first, and never from the log buffer below — that buffer trims,
  // and a request counter that goes down is worse than no counter.
  counters.increment('requests_total', { route: routeId, status: String(status) });
  latency.observe(routeId, durationMs);

  // An authorisation denial is a security event, not just a 403 in the log.
  if (status === 403) {
    counters.increment('authz_denies_total', { route: routeId, policyId: denyReason ?? 'unknown' });
    recordSecurityEvent({
      kind: 'AUTHZ_DENY',
      reason: denyReason ?? 'FORBIDDEN',
      method: ctx.method,
      path: routeId,
      traceId: ctx.traceId,
      correlationId: ctx.correlationId,
      tenantId: ctx.auth?.tenantId,
      actorId: ctx.auth?.actorId,
      remote: ctx.remote,
      status,
    });
  }

  // Administrative surfaces are audited whether the call succeeded or not,
  // because "who tried" matters as much as "who managed to".
  if (ctx.path.startsWith('/v1/console') || ctx.path.startsWith('/v1/admin') || ctx.path.startsWith('/v1/platform')) {
    recordSecurityEvent({
      kind: 'ADMIN_ACCESS',
      reason: status < 400 ? 'ADMIN_ENDPOINT_REACHED' : (denyReason ?? 'ADMIN_ENDPOINT_REFUSED'),
      method: ctx.method,
      path: routeId,
      traceId: ctx.traceId,
      correlationId: ctx.correlationId,
      tenantId: ctx.auth?.tenantId,
      actorId: ctx.auth?.actorId,
      remote: ctx.remote,
      status,
    });
  }

  const record: LogRecord = {
    timestamp: new Date().toISOString(),
    level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
    traceId: ctx.traceId,
    correlationId: ctx.correlationId,
    method: ctx.method,
    path: ctx.path,
    routeId: ctx.routeId,
    status,
    durationMs,
    tenantId: ctx.auth?.tenantId,
    actorId: ctx.auth?.actorId,
    authResult: ctx.authResult ? (ctx.authResult.ok ? 'success' : `fail:${ctx.authResult.reason}`) : undefined,
    authzDecision: status === 403 ? `deny:${denyReason ?? 'unknown'}` : status < 400 ? 'allow' : undefined,
    rateLimitKey: ctx.rateLimitKey,
    rateLimitRemaining: ctx.rateLimitRemaining,
    denyReason,
  };

  logs.push(record);
  // Bound the in-memory buffer; a real deployment ships these to a log sink.
  if (logs.length > 5000) logs.splice(0, 1000);

  if (config.env !== 'test') {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }
}

export function recentLogs(limit = 100): LogRecord[] {
  return logs.slice(-limit);
}

/** Minimal request metrics — enough to see saturation and error rates. */
export function metrics(): {
  totalRequests: number;
  byStatusClass: Record<string, number>;
  p50DurationMs: number;
  p95DurationMs: number;
  denialsByReason: Record<string, number>;
} {
  const durations = logs.map((l) => l.durationMs).sort((a, b) => a - b);
  const percentile = (p: number): number => (durations.length === 0 ? 0 : (durations[Math.floor(durations.length * p)] ?? 0));

  const byStatusClass: Record<string, number> = {};
  const denialsByReason: Record<string, number> = {};
  for (const log of logs) {
    const cls = `${Math.floor(log.status / 100)}xx`;
    byStatusClass[cls] = (byStatusClass[cls] ?? 0) + 1;
    if (log.denyReason) denialsByReason[log.denyReason] = (denialsByReason[log.denyReason] ?? 0) + 1;
  }

  return {
    totalRequests: logs.length,
    byStatusClass,
    p50DurationMs: percentile(0.5),
    p95DurationMs: percentile(0.95),
    denialsByReason,
  };
}
