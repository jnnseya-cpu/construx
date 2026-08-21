/**
 * Service worker for the installed application.
 *
 * It exists so the application is installable, which is what makes the operating
 * system show a launch screen at all. Everything it does is in service of that
 * and of the first paint being instant; it is deliberately not an offline
 * strategy.
 *
 * The one rule that matters:
 *
 *   THIS WORKER MUST NEVER TOUCH /v1/.
 *
 * Every response under /v1/ is authorised for one identity, in one tenancy, at
 * one moment. Caching any of it — even accidentally, even briefly — would put a
 * copy of one person's project data somewhere the platform's access control
 * cannot reach, and serve it to whoever opens the application on that device
 * next. Offline field work is handled server-side by the sync protocol in
 * `src/field/sync.ts`, which was built to reconcile deliberately. A cache is not
 * a substitute for it and must not become an accidental one.
 *
 * So: the shell is cached, the API is not, and a navigation prefers the network
 * and only falls back to the cached shell when there is none.
 */

const VERSION = 'construx-shell-v1';

/**
 * The application shell — the files that are identical for every user and
 * contain no data. If a file is not on this list it is not precached.
 */
const SHELL = [
  '/app',
  '/app.css',
  '/app.js',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-192.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      // Individually, so one 404 during development does not fail the whole
      // installation and leave the app uninstallable with no explanation.
      await Promise.all(
        SHELL.map((path) => cache.add(new Request(path, { cache: 'reload' })).catch(() => undefined)),
      );
      // Take over immediately: waiting for every tab to close means a fix can
      // sit undeployed on a device that is never fully quit, which on a phone
      // is most of them.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== VERSION) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

/** True for anything that must reach the network untouched, every time. */
function mustNotCache(url) {
  return (
    url.pathname.startsWith('/v1/') ||
    url.pathname === '/unsubscribe' ||
    url.pathname === '/healthz' ||
    url.pathname === '/readyz'
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Same-origin GET only. A cross-origin request or a command is none of this
  // worker's business, and passing it through untouched is the correct answer.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (mustNotCache(url)) return;

  // A navigation prefers the network so a deployed change is picked up on the
  // next launch, and falls back to the shell so a cold start with no signal
  // opens the application rather than the browser's error page.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cache = await caches.open(VERSION);
          return (await cache.match('/app')) ?? Response.error();
        }
      })(),
    );
    return;
  }

  // Static assets: serve from cache, refresh in the background. These are the
  // shell only, so a stale copy is a stale stylesheet, never stale project data.
  event.respondWith(
    (async () => {
      const cache = await caches.open(VERSION);
      const cached = await cache.match(request);

      const network = fetch(request)
        .then((response) => {
          if (response.ok && response.type === 'basic') void cache.put(request, response.clone());
          return response;
        })
        .catch(() => undefined);

      return cached ?? (await network) ?? Response.error();
    })(),
  );
});
