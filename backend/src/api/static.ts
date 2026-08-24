import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

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
  // Served with its own type, not as JSON. A browser that receives the manifest
  // as application/json ignores it, and the application silently stops being
  // installable with nothing in the console to say why.
  '.webmanifest': 'application/manifest+json; charset=utf-8',
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
  req?: IncomingMessage,
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

  // Revalidate, never guess.
  //
  // These modules used to be served `public, max-age=300`, which meant a
  // browser that had loaded the console within five minutes of a deploy kept
  // running the old JavaScript against the new server and had no way to know.
  // The symptom is worse than a stale page: `index.html` is `no-cache` and
  // refetches, so the new shell loads the old modules, and the mixture behaves
  // like neither version. It cost a live deployment an afternoon — the fixed
  // sign-in screen was on the server and the browser kept drawing the broken
  // one, which reads as a failed deploy.
  //
  // `no-cache` does not mean "do not store"; it means "ask first". With the
  // content hash as the validator the browser sends `If-None-Match` and gets a
  // 304 with no body, so the saving that `max-age` was buying is kept and the
  // window where a client can be wrong disappears. Weak, because the comparison
  // is byte-for-byte on the file rather than on a transfer encoding.
  const etag = `W/"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;

  if (req?.headers['if-none-match']?.split(',').some((candidate) => candidate.trim() === etag)) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache', 'x-trace-id': traceId });
    res.end();
    return { served: true };
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': body.length,
    'x-trace-id': traceId,
    ETag: etag,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);

  return { served: true };
}
