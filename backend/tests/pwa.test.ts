import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { IOS_LAUNCH, launchImageName } from '../../tools/icons.mjs';

/**
 * The installed application.
 *
 * A splash screen is not a picture; it is a manifest, an icon set, a set of
 * exactly-sized launch images and a service worker, and it fails silently if any
 * one of them is wrong. Every check here is for a failure that produces no
 * console message and no visible symptom other than the splash not appearing.
 *
 * The service-worker tests are the important ones. They are not about splash
 * screens at all — they are the standing guarantee that the worker introduced to
 * make installation possible never becomes a cache of one person's project data
 * sitting outside the platform's access control.
 */

const read = (path: string) => readFileSync(new URL(`../../frontend/${path}`, import.meta.url), 'utf8');
const bytes = (path: string) => readFileSync(new URL(`../../frontend/${path}`, import.meta.url));

const manifest = JSON.parse(read('manifest.webmanifest')) as {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  background_color: string;
  theme_color: string;
  icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
  shortcuts: Array<{ url: string }>;
};

describe('web app manifest', () => {
  it('declares what an installable application must declare', () => {
    assert.equal(manifest.display, 'standalone', 'without standalone display there is no launch screen');
    assert.equal(manifest.start_url, '/app');
    assert.equal(manifest.scope, '/app');
    assert.ok(manifest.short_name.length <= 12, 'a long short_name is truncated under the home-screen icon');
  });

  it('carries both a maskable and a non-maskable icon at 192 and 512', () => {
    // Android needs 192 and 512; without a maskable variant it pastes the icon
    // onto a white square, which on a dark mark looks like a rendering fault.
    for (const purpose of ['any', 'maskable']) {
      for (const size of ['192x192', '512x512']) {
        assert.ok(
          manifest.icons.some((icon) => icon.purpose === purpose && icon.sizes === size),
          `no ${purpose} icon at ${size}`,
        );
      }
    }
  });

  it('points every icon and shortcut at a file that exists and a page that resolves', () => {
    for (const icon of manifest.icons) {
      const file = bytes(icon.src.replace(/^\//, ''));
      assert.ok(file.length > 0, `${icon.src} is empty`);
      // PNG signature. A manifest icon that is not really a PNG is ignored.
      assert.deepEqual([...file.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${icon.src} is not a PNG`);
    }
    for (const shortcut of manifest.shortcuts) {
      assert.ok(shortcut.url.startsWith('/app/'), `${shortcut.url} is outside the application scope`);
    }
  });

  it('agrees with the document and the stylesheet on the launch colour', () => {
    // Three places have to hold the same value or the launch flashes: the
    // manifest, the theme-color meta tag, and the splash background in the CSS.
    const html = read('index.html');
    const css = read('app.css');

    assert.equal(manifest.background_color, '#0c0c0e');
    assert.ok(html.includes('<meta name="theme-color" content="#0c0c0e">'), 'theme-color differs from the manifest');
    assert.ok(/\.splash\s*\{[^}]*background:\s*#0c0c0e/.test(css), 'the splash background differs from the manifest');
  });
});

describe('the launch screen', () => {
  const html = read('index.html');

  it('is in the document, so it paints before any script runs', () => {
    const splashAt = html.indexOf('id="splash"');
    const scriptAt = html.indexOf('src="/app.js"');

    assert.ok(splashAt > 0, 'there is no splash in the shell');
    assert.ok(splashAt < scriptAt, 'the splash is drawn after the application script, so it would flash');
    assert.ok(html.includes('Starting the operating system'), 'the splash says nothing about what is happening');
  });

  it('links the manifest, the iOS icon and the iOS standalone flags', () => {
    assert.ok(html.includes('rel="manifest" href="/manifest.webmanifest"'));
    assert.ok(html.includes('rel="apple-touch-icon"'));
    // Without this meta iOS opens the app in a Safari tab, and a tab has no
    // launch screen no matter how many startup images are declared.
    assert.ok(html.includes('name="apple-mobile-web-app-capable" content="yes"'));
    assert.ok(html.includes('viewport-fit=cover'), 'the splash would letterbox around a notch');
  });

  it('declares a launch image for every generated device size, and generates one for every declaration', () => {
    // iOS matches on exact dimensions and shows nothing at all when it misses,
    // so a startup image and its media query have to be produced together.
    for (const entry of IOS_LAUNCH) {
      const file = launchImageName(entry);
      assert.ok(html.includes(`/icons/${file}`), `${file} exists but is not linked from the shell`);
      assert.ok(
        html.includes(
          `(device-width: ${entry.cssW}px) and (device-height: ${entry.cssH}px) and (-webkit-device-pixel-ratio: ${entry.ratio})`,
        ),
        `${file} is linked without the media query that selects it`,
      );

      const png = bytes(`icons/${file}`);
      assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${file} is not a PNG`);
      // IHDR width and height, big-endian at a fixed offset in every PNG.
      assert.equal(png.readUInt32BE(16), entry.w, `${file} is the wrong width — iOS will ignore it`);
      assert.equal(png.readUInt32BE(20), entry.h, `${file} is the wrong height — iOS will ignore it`);
    }

    const linked = html.match(/\/icons\/launch-\d+x\d+\.png/g) ?? [];
    assert.equal(
      new Set(linked).size,
      IOS_LAUNCH.length,
      'the shell links a launch image that tools/icons.mjs does not generate',
    );
  });
});

describe('the service worker', () => {
  const sw = read('sw.js');

  it('never caches an authorised response', () => {
    // The whole justification for having a service worker here is
    // installability. If it ever caches /v1/, it becomes a copy of one
    // identity's project data on a shared device, outside every access check
    // the platform makes. This test is the guarantee.
    assert.ok(sw.includes("url.pathname.startsWith('/v1/')"), 'the worker does not exclude the API');

    const shell = sw.slice(sw.indexOf('const SHELL'), sw.indexOf(']', sw.indexOf('const SHELL')));
    assert.ok(!shell.includes('/v1/'), 'an API path is in the precache list');

    // Only GET is intercepted; a command must always reach the server.
    assert.ok(sw.includes("request.method !== 'GET'"), 'the worker intercepts non-GET requests');
    // Cross-origin responses are opaque and must not be stored.
    assert.ok(sw.includes('url.origin !== self.location.origin'), 'the worker handles cross-origin requests');
  });

  it('prefers the network for a navigation, so a deploy is picked up', () => {
    assert.ok(sw.includes("request.mode === 'navigate'"));
    const navigation = sw.slice(sw.indexOf("request.mode === 'navigate'"));
    const fetchAt = navigation.indexOf('await fetch(request)');
    const cacheAt = navigation.indexOf('cache.match');
    assert.ok(fetchAt > 0 && fetchAt < cacheAt, 'a navigation reads the cache before the network');
  });

  it('precaches only files that exist', () => {
    const list = sw.slice(sw.indexOf('const SHELL'), sw.indexOf('];', sw.indexOf('const SHELL')));
    const paths = [...list.matchAll(/'(\/[^']*)'/g)].map((match) => match[1]!);

    assert.ok(paths.length > 0);
    for (const path of paths) {
      // `/app` is served by the gateway rather than from disk; everything else
      // must be a real file or the worker installs with a hole in it.
      if (path === '/app') continue;
      assert.doesNotThrow(() => bytes(path.replace(/^\//, '')), `${path} is precached but does not exist`);
    }
  });

  it('is registered from the application, scoped to it', () => {
    const app = read('app.js');
    assert.ok(app.includes("navigator.serviceWorker.register('/sw.js', { scope: '/app' })"));
    // Registration failing must not surface as an error: the application works
    // without it, minus the home-screen icon.
    assert.ok(/register\([^)]*\)\.catch\(/.test(app), 'a failed registration would reject unhandled');
  });
});
