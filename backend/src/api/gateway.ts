import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../core/errors.ts';
import type { Platform } from '../platform.ts';
import {
  applyRateLimit,
  authenticate,
  buildTrace,
  header,
  logRequest,
  readIdempotent,
  sendHtml,
  sendJson,
  sendProblem,
  storeIdempotent,
  validateRequest,
  type RequestContext,
  sendDocument,
} from './middleware.ts';
import { resolveLocale } from '../domain/locale.ts';
import { truncateAddress } from './telemetry.ts';
import { clientAddress } from './clientaddress.ts';
import { matchRoute, ROUTES } from './routes.ts';
import { renderLanding } from '../site/index.ts';
import { robots, sitemap } from '../site/discovery.ts';
import { serveStatic } from './static.ts';
import { mediaDir } from '../site/media.ts';
import { buildId } from './buildid.ts';

/**
 * The single internet-facing component. Order of operations is fixed:
 *
 *   trace -> rate limit (pre-auth) -> authenticate -> rate limit (post-auth)
 *   -> validate -> authorise (inside the domain) -> handle -> problem+json
 *
 * No internal service is exposed directly, and the gateway holds no state.
 */

// The frontend is a sibling of the backend, not a subdirectory of it: the two
// are separate deployables that this process happens to serve from one origin.
// Anchored to this module rather than to the working directory, so the service
// starts the same way from a container, a systemd unit or a developer's shell.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'frontend');
const APP_SHELL = join(WEB_ROOT, 'index.html');

/**
 * The routes an orchestrator polls to decide whether this process is alive and
 * whether it should receive traffic. Exempt from rate limiting — see the note
 * at the call site for the restart loop that exemption prevents.
 */
const IS_PROBE = new Set(['GET /healthz', 'GET /readyz']);
// The canonical vocabulary, served as the same bytes the route schemas
// validate against. Mounted separately rather than copied into the frontend:
// a copy is the thing this is meant to prevent.
const SHARED_ROOT = join(REPO_ROOT, 'shared');
const SHARED_PREFIX = '/shared/';
// The landing page's pictures. The root is `mediaDir()` rather than a constant
// because it reads `SITE_MEDIA_PATH` on each call, which is what lets a test
// point it at a temporary directory without reloading this module.
const MEDIA_PREFIX = '/media/';

const MAX_BODY_BYTES = 5 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new ValidationError('Request body exceeds the maximum permitted size');
    chunks.push(chunk as Buffer);
  }

  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return undefined;

  // One-click unsubscribe (RFC 8058) is posted by the recipient's mail provider
  // as a form, not as JSON. Refusing it would leave the header advertising a
  // control that fails, which is worse than not advertising it at all.
  if ((req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text));
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError('Request body is not valid JSON');
  }
}

/**
 * The body as bytes, for the routes that receive a file.
 *
 * Its own reader with its own ceiling: `MAX_BODY_BYTES` is sized for a command
 * envelope and a site photograph is an order of magnitude larger, while a
 * scanned drawing set is larger still. The limit is read from configuration so
 * the value that refuses an upload is the same value the store enforces —
 * failing at the store instead would mean reading the whole file first.
 */
async function readRawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Refused as it arrives, not after. An oversized upload is rejected part
    // way through rather than buffered to completion and then thrown away.
    if (size > limit) {
      const error = new ValidationError(`Upload exceeds the ${Math.round(limit / 1_048_576)}MB limit`);
      // The rest of the body is still arriving and will never be read. Marked
      // here, where it is known, so the error handler can close the connection
      // rather than leave the unread remainder to be parsed as the client's
      // next request. This is the only place a body is abandoned mid-stream.
      (error as { bodyAbandoned?: boolean }).bodyAbandoned = true;
      throw error;
    }
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks);
}

export function createGateway(platform: Platform): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(platform, req, res);
  });
}

async function handle(platform: Platform, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { traceId, correlationId } = buildTrace(req);
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // HEAD is GET without a body. Node discards the body on a HEAD response by
  // itself, so routing it as GET is the whole fix — and it matters because
  // uptime monitors, load balancers and link checkers probe with HEAD, and
  // /healthz answering 404 to one of those reads as an outage.
  const requested = req.method ?? 'GET';
  const method = requested === 'HEAD' ? 'GET' : requested;

  const ctx: RequestContext = {
    traceId,
    correlationId,
    method,
    path: url.pathname,
    params: {},
    query: url.searchParams,
    body: undefined,
    idempotencyKey: header(req, 'idempotency-key'),
    // The webhook signatures, captured unconditionally: the alternative is the
    // gateway knowing which routes are webhooks, and each costs one header read.
    webhookSignature: header(req, 'stripe-signature'),
    kodaSignature: header(req, 'x-koda-signature'),
    // Resolved and validated here rather than in a handler: the header is
    // client-supplied and ends up at a formatter that would throw on a bad tag.
    locale: resolveLocale(header(req, 'accept-language')),
    startedAt: Date.now(),
  };

  try {
    // The marketing page is the front door; the application lives at /app.
    // Rendered rather than read from disk: every figure on it comes from the
    // route table and the event catalogues, so a landing page cannot drift
    // into claiming a number the product does not have.
    if (ctx.method === 'GET' && (ctx.path === '/' || ctx.path === '/landing')) {
      // Limited like everything else. This early return sits above `matchRoute`
      // and therefore above `applyRateLimit`, so the single highest-traffic
      // public surface on the platform was the one surface with no budget at
      // all — found while writing a regression test that kept passing because
      // hammering `/` spent nothing. Inert today (it is a pure render holding
      // no state) and exactly the wrong shape to leave in place.
      //
      // `matchRoute` has not run, so there is no `routeId` yet; the limiter
      // keys on the group derived from the path, which for `/` is `default` —
      // the same bucket every other public page uses, which is what makes one
      // client hammering the landing page count against the budget it is
      // actually consuming.
      ctx.remote = truncateAddress(clientAddress(req.socket.remoteAddress, header(req, 'x-forwarded-for')));
      await applyRateLimit(ctx, clientAddress(req.socket.remoteAddress, header(req, 'x-forwarded-for')));

      // Through the same helper as the rest of the site so it gets the same
      // security headers. It was writing its own head with none of them.
      sendHtml(res, ctx, 200, renderLanding(), 'PUBLIC_SITE');
      logRequest(ctx, 200);
      return;
    }

    // How a crawler discovers the site at all. Neither existed: a missing
    // robots.txt answers 404, which every audit tool reports as a fault, and
    // with no sitemap the only pages indexed are the ones something already
    // links to from outside. Both are derived from the same lists that build
    // the navigation, so a page cannot be published and left out of them.
    if (ctx.method === 'GET' && ctx.path === '/robots.txt') {
      sendDocument(res, ctx, 'text/plain; charset=utf-8', robots());
      logRequest(ctx, 200);
      return;
    }
    if (ctx.method === 'GET' && ctx.path === '/sitemap.xml') {
      sendDocument(res, ctx, 'application/xml; charset=utf-8', sitemap(platform));
      logRequest(ctx, 200);
      return;
    }

    // The application is a single-page shell: every /app route serves the same
    // document and the client router resolves the view.
    if (ctx.method === 'GET' && (ctx.path === '/app' || ctx.path.startsWith('/app/'))) {
      // Through `sendHtml` so the console gets the same security headers as
      // every other page. Writing its own head is how it ended up as the only
      // response on this server with no policy and no frame refusal on it.
      const html = await readFile(APP_SHELL, 'utf8');
      sendHtml(res, ctx, 200, html, 'APP_SHELL', 'no-cache');
      logRequest(ctx, 200);
      return;
    }

    // The service worker, with this deployment's id substituted in.
    //
    // Served through a route rather than as a static file because the browser
    // installs a new worker only when these bytes change. With the version
    // hardcoded they never did, so an installed device served the shell it
    // downloaded on the day it installed — permanently, and invisibly, because
    // the API stayed current underneath it. `Service-Worker-Allowed` is what
    // lets a worker at the root claim the /app scope it registers for.
    if (ctx.method === 'GET' && ctx.path === '/sw.js') {
      // replaceAll rather than replace: a single substitution takes the first
      // occurrence, and if the placeholder is ever mentioned in a comment above
      // the constant, that is the one it takes — leaving the version fixed and
      // the placeholder gone, which looks exactly like it worked.
      const worker = (await readFile(join(WEB_ROOT, 'sw.js'), 'utf8')).replaceAll(
        '__BUILD_ID__',
        await buildId(WEB_ROOT),
      );
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': Buffer.byteLength(worker),
        'x-trace-id': traceId,
        // Never cached. A stale worker is a device that cannot be updated by
        // any means, because the file that would update it is the one being
        // served from cache.
        'Cache-Control': 'no-store',
        'Service-Worker-Allowed': '/app',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(worker);
      logRequest(ctx, 200);
      return;
    }

    // The landing page's pictures, from wherever they are configured to live.
    //
    // Served from their own root rather than from `frontend/` because the whole
    // point of `SITE_MEDIA_PATH` is that an uploaded picture can sit on the
    // volume and survive a redeploy, which a path inside the image cannot. Ahead
    // of the frontend so a file committed at `frontend/media/` cannot shadow the
    // one the operator uploaded; when the path is unset both resolve to the same
    // directory and this is simply the shorter way there.
    if (ctx.method === 'GET' && ctx.path.startsWith(MEDIA_PREFIX)) {
      const result = await serveStatic(mediaDir(), ctx.path.slice(MEDIA_PREFIX.length - 1), res, traceId, req);
      if (result.served) {
        logRequest(ctx, 200);
        return;
      }
    }

    // The shared vocabulary, from its own root. Served ahead of the frontend so
    // a file placed at frontend/shared/ could never shadow it.
    if (ctx.method === 'GET' && ctx.path.startsWith(SHARED_PREFIX)) {
      const result = await serveStatic(SHARED_ROOT, ctx.path.slice(SHARED_PREFIX.length - 1), res, traceId, req);
      if (result.served) {
        logRequest(ctx, 200);
        return;
      }
    }

    // Static assets: stylesheets, client modules, images.
    if (ctx.method === 'GET' && !ctx.path.startsWith('/v1/')) {
      const result = await serveStatic(WEB_ROOT, ctx.path, res, traceId, req);
      if (result.served) {
        logRequest(ctx, 200);
        return;
      }
    }

    if (ctx.method === 'GET' && ctx.path === '/v1/routes') {
      const body = {
        routes: ROUTES.map((r) => ({ method: r.method, path: r.pattern, description: r.description, public: r.public === true })),
      };
      sendJson(res, ctx, 200, body);
      logRequest(ctx, 200);
      return;
    }

    const matched = matchRoute(ctx.method, ctx.path);
    if (!matched) throw new NotFoundError(`No route for ${ctx.method} ${ctx.path}`);

    ctx.params = matched.params;
    // Who the request is from, for rate limiting and telemetry.
    //
    // The socket address unless the socket is a proxy the operator has named,
    // in which case the forwarded chain is read from the right. With no
    // configured proxies — the default — this is the socket address, exactly
    // as it was before `clientaddress.ts` existed.
    const remote = clientAddress(req.socket.remoteAddress, header(req, 'x-forwarded-for'));
    ctx.remote = truncateAddress(remote);
    // Metrics group by route pattern, never by path: a path carries ids and
    // would produce one series per project.
    ctx.routeId = `${matched.route.method} ${matched.route.pattern}`;
    const isPublic = matched.route.public === true;

    // Pre-auth limiting keyed by IP protects the login surface.
    //
    // The two orchestrator probes are exempt, and the reason is a failure this
    // audit reproduced rather than a theoretical one. `/healthz` and `/readyz`
    // shared the ordinary per-IP budget with every other request: 400 calls to
    // `/healthz` consumed it, and 195 of the next 200 calls to `/readyz` came
    // back 429. The container's own HEALTHCHECK polls `/readyz` and treats a
    // non-2xx as a failure, so a burst of traffic from one address — which is
    // *every* address once a reverse proxy is in front, since the key is the
    // socket's — marks a perfectly healthy container unhealthy, restarts it,
    // and drops capacity at exactly the moment the load arrives. The remaining
    // containers then take more of it. That is a restart loop built out of a
    // working rate limiter and a working health check.
    //
    // Neither probe reads a body, touches the ledger or names an identity, so
    // exempting them costs nothing an attacker can use: the worst available is
    // to learn that the process is running, which any TCP connection already
    // says. Every other route, `/v1/auth/*` included, is limited exactly as
    // before.
    if (!IS_PROBE.has(ctx.routeId)) {
      await applyRateLimit(ctx, remote);
    }

    authenticate(req, ctx, isPublic);

    // Re-apply post-auth so the tenant-aware key takes effect once known.
    if (ctx.auth && !IS_PROBE.has(ctx.routeId)) {
      await applyRateLimit(ctx, remote);
    }

    // The account layer, before the body is looked at.
    //
    // `projectContext` already refuses the operator, and it is reached inside
    // the handler — which is after schema validation. So an operator posting to
    // a customer's quality register got `400 VALIDATION_FAILED`: a refusal, but
    // the wrong one. It reads as "fix your body and retry" for an actor who is
    // categorically barred whatever the body says, and it hands out the shape of
    // every customer route to somebody who may not use any of them.
    //
    // Enforced here on the route *pattern* rather than left to each handler,
    // because "every project route remembers to build a project context" is not
    // a property a codebase can hold. The lineage route already had to carry its
    // own copy of this check for exactly that reason.
    if (matched.route.pattern.includes(':projectId') && ctx.auth?.roles.includes('PLATFORM_ADMIN')) {
      throw new ForbiddenError(
        'Platform operators are barred from customer delivery data',
        'ACCOUNT_LAYER_SEPARATION',
      );
    }

    if (matched.route.upload) {
      ctx.rawBody = await readRawBody(req, matched.route.maxBytes ?? config.evidence.maxBytes);
      ctx.contentType = header(req, 'content-type');
    } else {
      ctx.body = await readBody(req);
    }
    validateRequest(ctx, matched.route.schema, isPublic);

    // Idempotency: a retried command returns the original result rather than
    // performing the state change twice.
    const cached = readIdempotent(ctx.idempotencyKey, ctx);
    if (cached) {
      sendJson(res, ctx, cached.status, cached.body);
      logRequest(ctx, cached.status);
      return;
    }

    const result = await matched.route.handler(platform, ctx);
    const status = ctx.method === 'POST' && !matched.route.readOnly ? 201 : 200;

    // A handful of routes answer a browser rather than the application. They
    // are marked on the route, never inferred from the shape of the result.
    if (matched.route.html) {
      // A page is 200 even when it is the result of a POST — 201 Created would
      // describe a resource, and there is no resource here to point at.
      sendHtml(res, ctx, 200, String(result), matched.route.htmlPolicy);
      logRequest(ctx, 200);
      return;
    }

    // A file, not a payload. Sent with the headers that make a browser save it
    // under the document's own reference rather than a route name.
    if (matched.route.binary) {
      const file = result as {
        contentType: string;
        filename: string;
        bytes: Uint8Array;
        disposition?: 'attachment' | 'inline';
      };
      res.writeHead(200, {
        'Content-Type': file.contentType,
        'Content-Length': file.bytes.byteLength,
        'Content-Disposition': `${file.disposition ?? 'attachment'}; filename="${file.filename}"`,
        // Evidence is bytes somebody uploaded, and the content type came from
        // the same upload. Without these two headers, storing an HTML file and
        // opening its link is stored cross-site scripting on the platform's own
        // origin: `nosniff` stops the browser second-guessing the declared
        // type, and the policy denies the document every capability — no
        // script, no fetch, no frames, an opaque origin — so a document served
        // inline can render itself and nothing else.
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
        'x-trace-id': ctx.traceId,
        'x-correlation-id': ctx.correlationId,
        'Cache-Control': 'no-store',
      });
      res.end(Buffer.from(file.bytes));
      logRequest(ctx, 200);
      return;
    }

    const payload = result ?? { ok: true };

    storeIdempotent(ctx.idempotencyKey, ctx, status, payload);
    sendJson(res, ctx, status, payload);
    logRequest(ctx, status);
  } catch (error) {
    // An upload refused over its ceiling, with the rest of the body still
    // arriving and nothing left to read it. The unread remainder sits in the
    // socket, so whatever the client sends next on this connection would be
    // parsed as a continuation of it. Say the connection is finished — which is
    // what HTTP provides this header for — or a keep-alive client's *next*
    // request fails for no visible reason.
    if ((error as { bodyAbandoned?: boolean })?.bodyAbandoned) {
      res.setHeader('Connection', 'close');
    }
    sendProblem(res, ctx, error);
    logRequest(ctx, error instanceof Error && 'status' in error ? (error as { status: number }).status : 500, error);
  }
}

export function startGateway(platform: Platform, port = config.port): Promise<Server> {
  const server = createGateway(platform);
  return new Promise((resolve) => {
    server.listen(port, () => resolve(server));
  });
}
