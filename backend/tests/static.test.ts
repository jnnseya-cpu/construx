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

  it('never caches the shell, and caches assets briefly', async () => {
    const shell = capture();
    await serveStatic(WEB_ROOT, '/index.html', shell, 'trace-2');
    assert.equal(shell.headers['Cache-Control'], 'no-cache');

    const asset = capture();
    await serveStatic(WEB_ROOT, '/app.js', asset, 'trace-3');
    assert.equal(asset.headers['Cache-Control'], 'public, max-age=300');
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
