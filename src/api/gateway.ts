import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';
import { NotFoundError, ValidationError } from '../core/errors.ts';
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
} from './middleware.ts';
import { matchRoute, ROUTES } from './routes.ts';
import { serveStatic } from './static.ts';

/**
 * The single internet-facing component. Order of operations is fixed:
 *
 *   trace -> rate limit (pre-auth) -> authenticate -> rate limit (post-auth)
 *   -> validate -> authorise (inside the domain) -> handle -> problem+json
 *
 * No internal service is exposed directly, and the gateway holds no state.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(HERE, '..', '..', 'web');
const APP_SHELL = join(WEB_ROOT, 'index.html');
const LANDING = join(WEB_ROOT, 'landing.html');

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

export function createGateway(platform: Platform): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(platform, req, res);
  });
}

async function handle(platform: Platform, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { traceId, correlationId } = buildTrace(req);
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  const ctx: RequestContext = {
    traceId,
    correlationId,
    method: req.method ?? 'GET',
    path: url.pathname,
    params: {},
    query: url.searchParams,
    body: undefined,
    idempotencyKey: header(req, 'idempotency-key'),
    startedAt: Date.now(),
  };

  try {
    // The marketing page is the front door; the application lives at /app.
    if (ctx.method === 'GET' && (ctx.path === '/' || ctx.path === '/landing')) {
      const html = await readFile(LANDING, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'x-trace-id': traceId });
      res.end(html);
      logRequest(ctx, 200);
      return;
    }

    // The application is a single-page shell: every /app route serves the same
    // document and the client router resolves the view.
    if (ctx.method === 'GET' && (ctx.path === '/app' || ctx.path.startsWith('/app/'))) {
      const html = await readFile(APP_SHELL, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'x-trace-id': traceId, 'Cache-Control': 'no-cache' });
      res.end(html);
      logRequest(ctx, 200);
      return;
    }

    // Static assets: stylesheets, client modules, images.
    if (ctx.method === 'GET' && !ctx.path.startsWith('/v1/')) {
      const result = await serveStatic(WEB_ROOT, ctx.path, res, traceId);
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
    const isPublic = matched.route.public === true;

    // Pre-auth limiting keyed by IP protects the login surface.
    applyRateLimit(ctx, req.socket.remoteAddress ?? 'unknown');

    authenticate(req, ctx, isPublic);

    // Re-apply post-auth so the tenant-aware key takes effect once known.
    if (ctx.auth) applyRateLimit(ctx, req.socket.remoteAddress ?? 'unknown');

    ctx.body = await readBody(req);
    validateRequest(ctx, matched.route.schema, isPublic);

    // Idempotency: a retried command returns the original result rather than
    // performing the state change twice.
    const cached = readIdempotent(ctx.idempotencyKey);
    if (cached) {
      sendJson(res, ctx, cached.status, cached.body);
      logRequest(ctx, cached.status);
      return;
    }

    const result = await matched.route.handler(platform, ctx);
    const status = ctx.method === 'POST' ? 201 : 200;

    // A handful of routes answer a browser rather than the application. They
    // are marked on the route, never inferred from the shape of the result.
    if (matched.route.html) {
      // A page is 200 even when it is the result of a POST — 201 Created would
      // describe a resource, and there is no resource here to point at.
      sendHtml(res, ctx, 200, String(result));
      logRequest(ctx, 200);
      return;
    }

    const payload = result ?? { ok: true };

    storeIdempotent(ctx.idempotencyKey, status, payload);
    sendJson(res, ctx, status, payload);
    logRequest(ctx, status);
  } catch (error) {
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
