import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config.ts';
import { AuthError, RateLimitError, ValidationError, toProblem, DomainError } from '../core/errors.ts';
import { assertValid, type Schema } from '../core/validate.ts';
import { counters, latency, recordSecurityEvent, truncateAddress } from './telemetry.ts';
import { verifyToken, type AuthContext } from '../identity/auth.ts';
import { checkBinding, type DeviceRecord } from '../identity/devices.ts';
import { resolveKey } from '../developer/keys.ts';
import { analyticsCspHosts } from '../site/analytics.ts';
import type { SharedLimiter } from './sharedlimiter.ts';

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
  /**
   * The request body as bytes, on the routes that take a file.
   *
   * Only ever populated for a route that declares `upload`, and `body` is left
   * undefined on those — a file is not JSON and pretending otherwise is how a
   * 50MB photograph becomes a 67MB base64 string inside an envelope that then
   * has to be parsed as text.
   */
  rawBody?: Buffer;
  /** The `Content-Type` the caller sent, on an upload route. Metadata, not trust. */
  contentType?: string;
  auth?: AuthContext;
  /**
   * The enrolled device this request proved it came from.
   *
   * Present only where the token named a device *and* the request produced that
   * device's proof, so a handler that reads it is reading a verified fact
   * rather than a header. Absent on an unbound session, which is why the risk
   * model treats absence as a signal rather than as an error.
   */
  device?: DeviceRecord;
  idempotencyKey?: string;
  /**
   * The signature on an inbound webhook, for the routes that take one.
   *
   * Captured at the edge because a handler cannot reach the raw request, and
   * named for what it is rather than exposing every header — a generic header
   * bag on the context is a surface that grows without anybody deciding to
   * grow it.
   */
  webhookSignature?: string;
  /** The `x-koda-signature` header, on the mobile-money webhook. Same job. */
  kodaSignature?: string;
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

/**
 * Trace identifiers are client-supplied, and this one is written straight back
 * out as a response header and into every log line for the request. Unbounded
 * and unchecked, that is two problems: a value containing CR or LF is rejected
 * by `writeHead` and turns the request into a 500, and a 4KB value is 4KB on
 * every log record for as long as the caller keeps sending it.
 *
 * So an inbound trace is honoured only if it looks like a trace. Anything else
 * is replaced rather than rejected — the caller gets a working request and a
 * correlation id it did not choose, which is the right trade for a header whose
 * only purpose is to help us find things later.
 */
const TRACE_ID = /^[A-Za-z0-9._-]{1,128}$/;

function safeTrace(value: string | undefined): string | undefined {
  return value !== undefined && TRACE_ID.test(value) ? value : undefined;
}

export function buildTrace(req: IncomingMessage): { traceId: string; correlationId: string } {
  // Propagate an inbound trace where one exists so a request can be followed
  // across the client, the gateway and every downstream service.
  const traceId = safeTrace(header(req, 'x-trace-id')) ?? randomUUID();
  const correlationId = safeTrace(header(req, 'x-correlation-id')) ?? traceId;
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
  #shared: SharedLimiter | undefined;

  setBackendHealthy(healthy: boolean): void {
    this.#backendHealthy = healthy;
  }

  /**
   * Move the buckets off this process.
   *
   * In one process the `Map` below is exactly right. Behind a load balancer
   * with four replicas it is four separate buckets, so the configured limit is
   * silently multiplied by the replica count and the login route — the one with
   * the tightest limit precisely because it is the brute-force surface — hands
   * out four times the budget. Attaching a shared store is what makes the
   * number in the configuration the number that is actually enforced.
   */
  attachShared(shared: SharedLimiter | undefined): void {
    this.#shared = shared;
  }

  get shared(): boolean {
    return this.#shared !== undefined;
  }

  /**
   * The shared path. Falls back to nothing: if the backend cannot answer, the
   * request is denied rather than waved through on the local bucket, because a
   * local bucket during a backend outage is the multiplied limit again, and the
   * outage is exactly when somebody is most likely to be pushing.
   */
  async consumeShared(
    key: string,
    options: { max: number; burst: number; windowSeconds: number },
  ): Promise<{ allowed: boolean; retryAfter: number; remaining: number }> {
    if (!this.#shared) return this.consume(key, options);
    if (!this.#backendHealthy) return { allowed: false, retryAfter: options.windowSeconds, remaining: 0 };

    try {
      return await this.#shared.consume(key, options);
    } catch {
      return { allowed: false, retryAfter: options.windowSeconds, remaining: 0 };
    }
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

export async function applyRateLimit(ctx: RequestContext, remoteAddress: string): Promise<void> {
  const group = ctx.path.startsWith('/v1/auth') ? 'auth' : ctx.path.includes('/ai/') ? 'ai' : 'default';
  const limits = ROUTE_GROUP_LIMITS[group] ?? ROUTE_GROUP_LIMITS.default;

  const key = ctx.auth
    ? `rl:${ctx.auth.tenantId}:${ctx.auth.actorId}:${group}`
    : `rl:ip:${remoteAddress}:${group}`;

  // One await, and it resolves synchronously when no shared store is attached —
  // which is every test and every single-process deployment, so the local path
  // keeps behaving exactly as it did.
  const result = await rateLimiter.consumeShared(key, {
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

  // An API key, for the integrator who is not a person. Recognised by its
  // public prefix rather than by trying to parse it as a JWT and falling
  // through — a credential that fails one scheme and is then tried against
  // another produces error messages that describe the wrong thing.
  //
  // A key resolves to an identity whose scopes are narrower than the person who
  // issued it, and whose tenancy is the sandbox one where the key is a sandbox
  // key. Everything after this point treats it exactly like any other caller.
  if (token!.startsWith('ck_live_') || token!.startsWith('ck_test_')) {
    const identity = resolveKey(token!);
    // One answer for an unknown key, a revoked one and an expired one. Three
    // different answers would let somebody enumerate which keys exist.
    if (!identity) fail('KEY_INVALID', 'That API key is not valid');
    ctx.auth = identity;
    ctx.authResult = { ok: true };
    return;
  }

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

  /*
   * Device binding.
   *
   * A valid token is not sufficient on a bound session: the request must also
   * carry a proof computed from a secret that never travels in the same header
   * the token does. So a token lifted from a log, a proxy, a screenshot or a
   * support ticket is not enough on its own, and revoking a device ends every
   * session on it here, on the next request.
   *
   * Three outcomes, and the middle one is the reason this is not a single
   * boolean:
   *
   *   - **Bound and proved.** The device is recorded as seen, from this
   *     network, which is what the risk model's "somewhere it has been before"
   *     is built from.
   *   - **Not bound at all.** No `did` on the token, so this is a session from
   *     before the person enrolled anything. Refused only where the deployment
   *     has turned binding on; otherwise it is *scored* by `identity/risk.ts`,
   *     which charges thirty points and asks for a step-up as soon as the
   *     session tries anything serious.
   *   - **Bound and not proved.** Refused, always, whatever the configuration.
   *     A token that names a device and cannot produce that device's proof is
   *     the exact case binding exists to catch, and making it configurable
   *     would make the control optional at the moment it fires.
   */
  const binding = checkBinding({
    tokenDeviceId: ctx.auth!.deviceId,
    tokenId: ctx.auth!.tokenId,
    presentedDeviceId: header(req, 'x-device-id'),
    presentedProof: header(req, 'x-device-proof'),
    remote: ctx.remote,
  });
  if (!binding.ok) {
    fail(binding.reason, 'This session is bound to a device, and this request did not prove it came from that device');
  } else if (binding.bound) {
    ctx.device = binding.device;
  } else if (config.auth.requireDeviceBinding) {
    fail('DEVICE_BINDING_REQUIRED', 'This deployment requires every session to be bound to an enrolled device');
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

/**
 * The cache key for a replayed request.
 *
 * The client-supplied header alone is not it, and the reason is not subtle: the
 * key is chosen by the caller. Keyed on the header by itself, a tenant sending
 * `Idempotency-Key: abc` receives whatever another tenant's request under the
 * same key returned — somebody else's project data, wallet snapshot or invoice,
 * served from cache with no authorisation involved at all, because the cache is
 * consulted before the handler runs. The console generates a UUID per request so
 * it never collided by accident, which is exactly why it was never noticed.
 *
 * The identity and the route are therefore part of the key. A replay now means
 * the same actor repeating the same call, which is the only thing idempotency
 * was ever meant to cover.
 */
function idempotencyScope(key: string, ctx: RequestContext): string {
  // Tenant *and* actor: two people in one tenancy issuing the same key are
  // still two different requests, and one must not see the other's answer.
  const tenantId = ctx.auth?.tenantId ?? 'anonymous';
  const actorId = ctx.auth?.actorId ?? 'anonymous';
  // The route pattern rather than the path, so `/v1/projects/:id` replays
  // per-project rather than across every project the actor can reach.
  return `${tenantId} ${actorId} ${ctx.method} ${ctx.routeId ?? ctx.path} ${key}`;
}

export function readIdempotent(
  key: string | undefined,
  ctx: RequestContext,
): { status: number; body: unknown } | undefined {
  if (!key) return undefined;
  const cached = idempotencyCache.get(idempotencyScope(key, ctx));
  if (!cached) return undefined;
  if (Date.now() - cached.storedAt > IDEMPOTENCY_TTL_MS) {
    idempotencyCache.delete(idempotencyScope(key, ctx));
    return undefined;
  }
  return { status: cached.status, body: cached.body };
}

export function storeIdempotent(
  key: string | undefined,
  ctx: RequestContext,
  status: number,
  body: unknown,
): void {
  if (!key) return;
  // Only successful writes are replayable. Caching a failure means a caller who
  // fixed their request and retried with the same key — which is what a retry
  // looks like from a phone with one bar — gets the old error back for a day.
  if (status >= 400) return;
  idempotencyCache.set(idempotencyScope(key, ctx), { status, body, storedAt: Date.now() });
}

/** Cleared between tests; the cache is process-local and holds no durable state. */
export function resetIdempotency(): void {
  idempotencyCache.clear();
}

/**
 * The three headers every response carries, whatever it is.
 *
 * Named once rather than repeated across `sendJson`, `sendHtml` and
 * `sendDocument`, which is how the last set drifted: `Permissions-Policy`,
 * `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy` were absent
 * from all three, and a scanner reports that on every surface at once.
 *
 * - **Permissions-Policy** switches off the powerful features this origin never
 *   uses. The console does use the camera and geolocation — the field app
 *   photographs work and stamps where it was taken — so those are `self`
 *   rather than off, and everything else is denied outright. Denying a feature
 *   the product needs is worse than not sending the header: the refusal is
 *   silent and looks like a broken camera.
 * - **Cross-Origin-Opener-Policy** severs the `window.opener` link, so a page
 *   this one opens cannot reach back into it.
 * - **Cross-Origin-Resource-Policy** stops another site embedding this
 *   origin's responses. `same-site` rather than `same-origin` because the
 *   public site and the console are one origin today and may not always be.
 */
const BASELINE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy':
    'accelerometer=(), autoplay=(), browsing-topics=(), camera=(self), display-capture=(), encrypted-media=(), ' +
    'fullscreen=(self), gamepad=(), geolocation=(self), gyroscope=(), hid=(), idle-detection=(), ' +
    'local-fonts=(), magnetometer=(), microphone=(self), midi=(), payment=(), picture-in-picture=(), ' +
    'publickey-credentials-get=(self), screen-wake-lock=(), serial=(), usb=(), xr-spatial-tracking=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-site',
} as const;

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
    ...BASELINE_HEADERS,
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
/**
 * Content-security policies for the two kinds of page this server returns.
 *
 * `SELF_CONTAINED` is the unsubscribe page: no stylesheet, no script, no
 * images, and it stays that tight because a page reached from a link in an
 * email is the one most likely to be attacked.
 *
 * `PUBLIC_SITE` is the marketing pages, which do load a stylesheet and one
 * script — both from this origin and nowhere else. There is no `unsafe-inline`
 * for script: the mobile-menu handler lives in `/site.js` precisely so this
 * policy does not need one. Discovered by loading the pages in a real browser,
 * where the strict policy blocked the stylesheet and every page rendered
 * unstyled while the markup tests passed.
 */
const CSP = {
  // `frame-ancestors 'none'` for the same reason the other two carry it: this
  // page is reached from a link in an email and it carries a form that acts on
  // the reader's behalf. A page that can be framed is a page whose button can
  // be clicked by somebody else's, and unsubscribing somebody is a small harm
  // that costs nothing to close.
  SELF_CONTAINED: "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  /**
   * The marketing pages, which load a stylesheet and scripts from this origin
   * and — only if an operator configured a measurement id — from the two
   * vendors those ids belong to.
   *
   * The widening is conditional on purpose. With no id set, `analyticsCspHosts`
   * returns empty strings and this is character-for-character the policy it was
   * before measurement existed: a deployment that does not advertise should not
   * be running a policy that permits advertising scripts. `connect-src` is
   * absent entirely in that case, because the site makes no requests of its own.
   *
   * Note what is never added: `unsafe-inline` for script. Meta and Google both
   * publish their tags as inline blocks, which is exactly why those are not
   * used — `/analytics.js` loads them from this origin instead, so the policy
   * keeps a protection that pasting a snippet would have traded away across
   * every page of the site.
   *
   * This cannot reach the console. `APP_SHELL` below is a separate entry, no
   * measurement tag is served there, and that is the point rather than an
   * oversight.
   */
  PUBLIC_SITE:
    `default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'${analyticsCspHosts().script}; ` +
    `img-src 'self' data:${analyticsCspHosts().img}; ` +
    // `connect-src 'self'` always: the account request form on /contact posts
    // to this origin, and a policy that only allowed it when an advertising
    // tag was configured would make the form work on a deployment that
    // measures and fail on one that does not.
    `connect-src 'self'${analyticsCspHosts().connect}; ` +
    "font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  /**
   * The application shell. It was being written with no security headers at all
   * — no policy, no frame refusal, no nosniff — because it is the one response
   * that writes its own head instead of going through here. A console that can
   * be framed is a console whose buttons can be clicked by somebody else's page,
   * and the buttons on this one certify payments.
   *
   * `connect-src 'self'` is what the shell needs and all it needs: the client
   * calls this origin and nowhere else. `style-src 'unsafe-inline'` is required
   * because the views set style attributes on elements they build.
   */
  APP_SHELL:
    "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; " +
    // `blob:` because an account picture lives behind the gateway and an <img>
    // cannot carry the bearer token: the console fetches the bytes itself and
    // hands them to the element as an object URL, which this origin's own
    // script minted. Without it the picture fetched, decoded to nothing, and
    // the initials stayed.
    "img-src 'self' data: blob:; font-src 'self'; manifest-src 'self'; form-action 'self'; " +
    "base-uri 'none'; frame-ancestors 'none'",
} as const;

export type HtmlPolicy = keyof typeof CSP;

export function sendHtml(
  res: ServerResponse,
  ctx: RequestContext,
  status: number,
  html: string,
  policy: HtmlPolicy = 'SELF_CONTAINED',
  // The shell is revalidated rather than never stored: it carries no data, and
  // `no-store` would re-download it on every navigation of a single-page app.
  cacheControl = 'no-store',
): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'x-trace-id': ctx.traceId,
    'x-correlation-id': ctx.correlationId,
    'Cache-Control': cacheControl,
    'Content-Security-Policy': CSP[policy],
    ...BASELINE_HEADERS,
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  });
  res.end(html);
}

/**
 * A plain text or XML document — `robots.txt` and `sitemap.xml`.
 *
 * Neither is HTML and neither should be treated as it: a crawler reading a
 * sitemap wants `application/xml`, and `nosniff` on a `text/plain` response is
 * what stops a browser deciding for itself that a robots file is something it
 * should render.
 *
 * Cached for an hour rather than not at all. These change when a page is
 * published, which is rarely, and a crawler asking for a sitemap on every visit
 * is a crawler wasting the budget it could have spent on pages.
 */
export function sendDocument(
  res: ServerResponse,
  ctx: RequestContext,
  contentType: string,
  body: string,
): void {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'x-trace-id': ctx.traceId,
    'x-correlation-id': ctx.correlationId,
    'Cache-Control': 'public, max-age=3600',
    ...BASELINE_HEADERS,
  });
  res.end(body);
}

export function sendProblem(res: ServerResponse, ctx: RequestContext, error: unknown): void {
  const problem = toProblem(error, ctx.path, ctx.traceId, ctx.correlationId);
  const payload = JSON.stringify(problem);

  // An unexpected error is answered as a 500 with a reference and nothing
  // else, which is right for the caller and was the whole of the record: the
  // cause went nowhere. An administrator hit "The request could not be
  // completed" on "Add a person" and there was nothing for anybody to search.
  // The cause is written here, once, against the reference the person sees —
  // to stderr, where the platform's own diagnostics go, never to the response.
  if (problem.status >= 500) {
    const cause = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) };
    process.stderr.write(
      `${JSON.stringify({
        level: 'error',
        event: 'unhandled_error',
        traceId: ctx.traceId,
        correlationId: ctx.correlationId,
        method: ctx.method,
        path: ctx.routeId ?? ctx.path,
        ...cause,
      })}\n`,
    );
  }

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
