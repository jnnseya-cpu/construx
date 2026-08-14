import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';

/**
 * Static asset serving for the application shell.
 *
 * The gateway serves the app itself so a single process is all that is needed
 * to run the platform. In a real deployment this sits behind a CDN, but the
 * path-traversal protection below matters either way — it is the difference
 * between serving `web/app.js` and serving `/etc/passwd`.
 */

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export type StaticResult = { served: true } | { served: false };

/**
 * Serve a file from `root`, or report that it was not served so the caller can
 * fall through to the API router.
 */
export async function serveStatic(
  root: string,
  requestPath: string,
  res: ServerResponse,
  traceId: string,
): Promise<StaticResult> {
  // Resolve inside the root and verify containment. Checking the resolved path
  // rather than the raw one defeats encoded traversal (`%2e%2e%2f`) too, since
  // the caller has already decoded it.
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    // A malformed escape sequence is not a file. Falling through produces a 404
    // rather than a 500 from the decoder.
    return { served: false };
  }

  // A null byte truncates the path in some syscalls; refuse it outright.
  if (decoded.includes('\0')) return { served: false };

  const candidate = resolve(join(root, normalize(decoded)));
  const rootResolved = resolve(root);

  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + sep)) {
    return { served: false };
  }

  let target = candidate;
  try {
    const info = await stat(target);
    if (info.isDirectory()) target = join(target, 'index.html');
  } catch {
    return { served: false };
  }

  let body: Buffer;
  try {
    body = await readFile(target);
  } catch {
    return { served: false };
  }

  const type = CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': body.length,
    'x-trace-id': traceId,
    // The shell and its modules change with every deploy; the API is never cached.
    'Cache-Control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);

  return { served: true };
}
