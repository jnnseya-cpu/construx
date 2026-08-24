import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGateway } from '../src/api/gateway.ts';
import { resetBuildId } from '../src/api/buildid.ts';
import { Platform } from '../src/platform.ts';

/**
 * The installed application.
 *
 * A PWA is three things that have to agree: a manifest the browser accepts, a
 * service worker that installs, and icons that exist at the sizes the manifest
 * promises. Any one of them wrong and the install prompt never appears, with
 * nothing in the interface to say why.
 *
 * The defect these were written for is subtler than that, and worse. The
 * worker's cache key was the literal `construx-shell-v1`, and a browser
 * installs a new worker only when the bytes of `/sw.js` change. They never did,
 * so the version never changed, so the cache was never invalidated: an installed
 * device served the shell it downloaded on the day it installed, permanently.
 * The API stayed current underneath it, so there was no error, no stale-data
 * warning, nothing — just a phone running last month's JavaScript against this
 * month's platform, on a site, where nobody can reach it to clear the cache.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const MANIFEST = JSON.parse(readFileSync(resolve(ROOT, 'frontend/manifest.webmanifest'), 'utf8')) as {
  start_url: string;
  scope: string;
  display: string;
  icons: { src: string; sizes: string; type: string; purpose: string }[];
  shortcuts: { url: string }[];
};

let platform: Platform;
let server: Server;
let base: string;

async function get(path: string) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, headers: res.headers, body: await res.text() };
}

before(async () => {
  platform = new Platform();
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

describe('the service worker can be replaced by a deploy', () => {
  it('carries a version derived from what is being served', async () => {
    const worker = await get('/sw.js');

    assert.equal(worker.status, 200);
    assert.doesNotMatch(worker.body, /__BUILD_ID__/, 'the placeholder was never substituted');
    assert.doesNotMatch(
      worker.body,
      /const VERSION = 'construx-shell-v1'/,
      'a fixed version means an installed device can never be updated',
    );
    assert.match(worker.body, /const VERSION = 'construx-shell-[A-Za-z0-9_-]{12}'/, 'the version must be a build id');
  });

  it('changes when a served file changes, and only then', async () => {
    const before = /construx-shell-([A-Za-z0-9_-]+)/.exec((await get('/sw.js')).body)?.[1];

    // Same content, recomputed from scratch: the id must be a function of the
    // bytes, not of the walk order or the clock. readdir returns filesystem
    // order, which differs between a container and a laptop, and an id that
    // depended on it would change without the content changing.
    resetBuildId();
    const again = /construx-shell-([A-Za-z0-9_-]+)/.exec((await get('/sw.js')).body)?.[1];
    assert.equal(again, before, 'the same frontend produced two different ids');

    // Now actually change something the browser loads.
    const css = resolve(ROOT, 'frontend/app.css');
    const original = readFileSync(css, 'utf8');
    try {
      writeFileSync(css, `${original}\n/* deploy marker */\n`);
      resetBuildId();
      const changed = /construx-shell-([A-Za-z0-9_-]+)/.exec((await get('/sw.js')).body)?.[1];
      assert.notEqual(changed, before, 'a changed stylesheet did not produce a new cache version');
    } finally {
      writeFileSync(css, original);
      resetBuildId();
    }
  });

  it('is never cached itself', async () => {
    // The one file that must always come from the network. A cached worker is a
    // device that cannot be updated by any means, because the file that would
    // update it is the one being served from cache.
    const worker = await get('/sw.js');
    assert.equal(worker.headers.get('cache-control'), 'no-store');
  });

  it('is allowed to claim the scope it registers for', async () => {
    // A worker served from the root registering for /app needs the server's
    // permission. Without the header the registration is refused and the
    // application silently stops being installable.
    const worker = await get('/sw.js');
    assert.equal(worker.headers.get('service-worker-allowed'), '/app');
    assert.match(worker.headers.get('content-type') ?? '', /javascript/, 'a worker served as text/plain will not run');
  });
});

describe('the worker never touches project data', () => {
  const source = readFileSync(resolve(ROOT, 'frontend/sw.js'), 'utf8');

  it('excludes every authorised surface from the cache', () => {
    // The rule the worker's own header states. Every response under /v1/ is
    // authorised for one identity in one tenancy at one moment; a cached copy
    // sits somewhere the platform's access control cannot reach and is served
    // to whoever opens the app on that device next.
    assert.match(source, /pathname\.startsWith\('\/v1\/'\)/, '/v1/ must be excluded by path prefix');
    assert.match(source, /request\.method !== 'GET'/, 'a command must never be served from cache');
    assert.match(source, /url\.origin !== self\.location\.origin/, 'cross-origin requests are not this worker\'s business');
  });

  it('precaches only files that are identical for every user', () => {
    const shell = /const SHELL = \[([\s\S]*?)\]/.exec(source)?.[1] ?? '';
    const paths = [...shell.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');

    assert.ok(paths.length > 0, 'the shell list is empty');
    for (const path of paths) {
      assert.doesNotMatch(path, /^\/v1\//, `${path} is an API path and must not be precached`);
    }
  });

  it('prefers the network for navigations, so a deploy lands on the next launch', () => {
    assert.match(source, /request\.mode === 'navigate'/, 'navigations need their own strategy');
  });
});

describe('the manifest promises nothing that is missing', () => {
  it('serves every icon it lists, at the type it claims', async () => {
    // A 404 here does not break the app; it stops the install prompt appearing,
    // which is indistinguishable from the browser simply not offering it.
    for (const icon of MANIFEST.icons) {
      const response = await get(icon.src);
      assert.equal(response.status, 200, `${icon.src} is in the manifest and is not served`);
      assert.match(
        response.headers.get('content-type') ?? '',
        /image\/png/,
        `${icon.src} is declared as ${icon.type}`,
      );
    }
  });

  it('offers both a maskable and an unmaskable icon at each size', () => {
    // Android crops an `any` icon to whatever shape the launcher uses, which
    // clips a logo that fills its canvas. A maskable icon carries the safe zone.
    const purposes = new Set(MANIFEST.icons.map((i) => `${i.sizes}:${i.purpose}`));
    for (const size of ['192x192', '512x512']) {
      assert.ok(purposes.has(`${size}:any`), `no plain icon at ${size}`);
      assert.ok(purposes.has(`${size}:maskable`), `no maskable icon at ${size}`);
    }
  });

  it('starts inside its own scope', async () => {
    // A start_url outside scope means the launched application immediately
    // leaves the worker's control and opens in a browser tab instead.
    assert.ok(
      MANIFEST.start_url.startsWith(MANIFEST.scope),
      `start_url ${MANIFEST.start_url} is outside scope ${MANIFEST.scope}`,
    );
    assert.equal(MANIFEST.display, 'standalone', 'the point of installing is not to get a browser tab');
    assert.equal((await get(MANIFEST.start_url)).status, 200, 'start_url must be served');
  });

  it('points every shortcut at a route that exists', async () => {
    for (const shortcut of MANIFEST.shortcuts) {
      assert.ok(shortcut.url.startsWith(MANIFEST.scope), `${shortcut.url} is outside scope`);
      assert.equal((await get(shortcut.url)).status, 200, `${shortcut.url} is a shortcut to nothing`);
    }
  });

  it('is served as a manifest rather than as JSON', async () => {
    // A browser that receives it as application/json ignores it, and the app
    // silently stops being installable with nothing in the console to say why.
    const response = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/manifest\+json/);
  });
});
