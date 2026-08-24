import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '../src/api/static.ts';

/**
 * The gateway serves the application itself, which makes it a file server —
 * and a file server that can be talked out of its root is a disclosure bug.
 */

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend');

/** A response object that records what was written without needing a socket. */
function capture(): ServerResponse & { statusCode: number; headers: Record<string, unknown>; body: Buffer } {
  const res = new ServerResponse({ method: 'GET', url: '/', headers: {} } as never) as unknown as ServerResponse & {
    headers: Record<string, unknown>;
    body: Buffer;
  };
  res.headers = {};
  res.body = Buffer.alloc(0);
  res.writeHead = ((status: number, headers: Record<string, unknown>) => {
    res.statusCode = status;
    res.headers = headers ?? {};
    return res;
  }) as never;
  res.end = ((chunk?: Buffer) => {
    if (chunk) res.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    return res;
  }) as never;
  return res as never;
}

describe('static asset serving', () => {
  it('serves a file inside the root', async () => {
    const res = capture();
    const result = await serveStatic(WEB_ROOT, '/app.css', res, 'trace-1');

    assert.equal(result.served, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'text/css; charset=utf-8');
    assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
    assert.ok(res.body.length > 0);
  });

  it('makes every asset revalidate, so a deploy cannot leave a client on old code', async () => {
    // This asserted `public, max-age=300` on assets, and that window cost a live
    // deployment an afternoon. `index.html` is `no-cache` and refetches, so a
    // browser that had loaded the console within five minutes of a deploy ran
    // the *new* shell against the *old* modules — a mixture that behaves like
    // neither version, with nothing in the UI to say so. The fixed sign-in
    // screen was on the server and the browser kept drawing the broken one,
    // which reads as a failed deploy rather than as a cache.
    for (const path of ['/index.html', '/app.js', '/app.css']) {
      const res = capture();
      await serveStatic(WEB_ROOT, path, res, 'trace-2');
      assert.equal(res.headers['Cache-Control'], 'no-cache', `${path} may be served from cache unchecked`);
      assert.match(String(res.headers.ETag), /^W\/".+"$/, `${path} has nothing to revalidate against`);
    }
  });

  it('answers 304 to a client that already has the bytes', async () => {
    // `no-cache` means "ask first", not "do not store". Without the 304 the
    // revalidation above would cost a full transfer per module per page load,
    // and the fix for a correctness bug would be a performance one.
    const first = capture();
    await serveStatic(WEB_ROOT, '/app.js', first, 'trace-3');
    const etag = String(first.headers.ETag);

    const again = capture();
    const result = await serveStatic(WEB_ROOT, '/app.js', again, 'trace-4', {
      headers: { 'if-none-match': etag },
    } as never);

    assert.equal(result.served, true);
    assert.equal(again.statusCode, 304);
    assert.equal(again.body.length, 0, 'a 304 must carry no body');
    assert.equal(again.headers.ETag, etag);
  });

  it('sends the file when the client is holding a different version', async () => {
    const res = capture();
    await serveStatic(WEB_ROOT, '/app.js', res, 'trace-5', {
      headers: { 'if-none-match': 'W/"something-else-entirely"' },
    } as never);

    assert.equal(res.statusCode, 200);
    assert.ok(res.body.length > 0, 'a stale validator must produce the new bytes');
  });

  it('derives the validator from the content, not from the clock', async () => {
    // mtime changes on every `git checkout` and every container rebuild, which
    // would invalidate the whole shell on a deploy that changed one file.
    const a = capture();
    const b = capture();
    await serveStatic(WEB_ROOT, '/app.js', a, 'trace-6');
    await serveStatic(WEB_ROOT, '/app.css', b, 'trace-7');

    assert.notEqual(a.headers.ETag, b.headers.ETag, 'two different files share a validator');

    const repeat = capture();
    await serveStatic(WEB_ROOT, '/app.js', repeat, 'trace-8');
    assert.equal(repeat.headers.ETag, a.headers.ETag, 'the same bytes produced two validators');
  });

  it('refuses to climb out of the root', async () => {
    for (const path of [
      '/../package.json',
      '/../../etc/passwd',
      '/..%2f..%2fpackage.json',
      '/pages/../../package.json',
    ]) {
      const res = capture();
      const result = await serveStatic(WEB_ROOT, path, res, 'trace-4');
      assert.equal(result.served, false, `${path} must not be served`);
      assert.equal(res.body.length, 0);
    }
  });

  it('treats a malformed escape sequence as a miss, not an error', async () => {
    const res = capture();
    const result = await serveStatic(WEB_ROOT, '/%E0%A4%A', res, 'trace-5');
    assert.equal(result.served, false);
  });

  it('refuses a path carrying a null byte', async () => {
    const res = capture();
    const result = await serveStatic(WEB_ROOT, '/app.css%00.png', res, 'trace-6');
    assert.equal(result.served, false);
  });

  it('reports a miss for a file that does not exist', async () => {
    const res = capture();
    const result = await serveStatic(WEB_ROOT, '/does-not-exist.js', res, 'trace-7');
    assert.equal(result.served, false);
  });
});
