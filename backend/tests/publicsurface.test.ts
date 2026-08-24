import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { ROUTES } from '../src/api/routes.ts';
import { POST_PAGES, SITE_PAGES } from '../src/site/index.ts';
import { Platform } from '../src/platform.ts';

/**
 * The unauthenticated surface, and what it is allowed to hand out.
 *
 * `POST /v1/console/session` was `public: true` with no production gate. It
 * seeded a demonstration project and returned a working access token for
 * `pm@meridian.example` to any anonymous caller — a PM identity, with no
 * credential and no MFA, to anyone who could reach the origin. Demonstrated
 * against a running server before it was closed: the token authenticated
 * subsequent requests and was refused only by the role check on the specific
 * command tried next.
 *
 * Its sibling `/v1/console/identities` already carried the production gate,
 * which is what makes this the dangerous kind of hole — it looked handled.
 *
 * The allow-list in api.test.ts records *which* routes are public. This file
 * covers the thing that actually bites: what a public route may return, and
 * that a demonstration affordance is switched off where it matters.
 */

let server: Server;
let base: string;

before(async () => {
  server = createGateway(new Platform());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

/**
 * Run a block with NODE_ENV set, restoring it afterwards.
 *
 * `config.env` is a snapshot taken at module load, so setting the variable here
 * cannot reach it. The request-time gates call `isProduction()`, which reads
 * `process.env` fresh — that is the whole reason it exists, and why these
 * assertions are possible at all rather than only in a separately booted
 * process.
 */
async function asProduction<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

describe('what an anonymous caller can obtain', () => {
  it('names every route reachable without a credential', () => {
    // Deliberately duplicated from api.test.ts. That one asserts the list to
    // catch a route quietly becoming public; this one is the premise for the
    // assertions below, and a public route added without a thought here should
    // fail in both places rather than neither.
    const publicRoutes = ROUTES.filter((r) => r.public).map((r) => `${r.method} ${r.pattern}`).sort();
    // Marketing pages are derived rather than listed, so publishing one is not
    // a security edit. Blog posts are the same class of thing — public,
    // server-rendered, no API surface — and each has its own address because
    // nothing can count a page that has none.
    const sitePaths = new Set(
      [...SITE_PAGES.map((p) => p.path), ...POST_PAGES.map((p) => p.path)].map((path) => `GET ${path}`),
    );
    const publicApi = publicRoutes.filter((id) => !sitePaths.has(id));

    assert.deepEqual(publicApi, [
      'GET /healthz',
      'GET /readyz',
      'GET /unsubscribe',
      // Public route, private object. A signed evidence link has to work
      // without a session — that is the whole of what it is for — so the
      // handler, not the router, decides: a valid HMAC over tenant, hash and
      // expiry, or an authorised identity, or nothing is served.
      'GET /v1/evidence/:hash',
      'GET /v1/signup/account-types',
      // The landing page for the confirmation link in a signup email. Public by
      // necessity — the whole point is that the person has no account yet — and
      // it provisions nothing on GET, so a mail scanner prefetching the link
      // cannot spend the single-use token before its owner clicks it.
      'GET /verify',
      'POST /unsubscribe',
      'POST /v1/auth/login',
      'POST /v1/auth/mfa/verify',
      'POST /v1/auth/refresh',
      'POST /v1/console/identities',
      'POST /v1/console/session',
      'POST /v1/signup',
      'POST /v1/signup/verify',
      // The button on that page. Same act as POST /v1/signup/verify and the
      // same implementation behind it; what differs is that it answers with a
      // page rather than JSON, because the caller is a browser that followed a
      // link out of an inbox.
      'POST /verify',
    ]);

    // Every marketing page is public and none of them is an API surface. They
    // are derived rather than listed so adding a page is not a security edit,
    // while adding a public *endpoint* still is.
    for (const definition of SITE_PAGES) {
      assert.ok(
        publicRoutes.includes(`GET ${definition.path}`),
        `${definition.path} is in the site navigation but is not a public route`,
      );
    }
  });

  it('issues no access token from a public route in production, except by completing authentication', async () => {
    // The invariant that would have caught this, and the reason it is scoped to
    // production rather than asserted everywhere: the demonstration session
    // *does* hand out a token to an anonymous caller, and that is what a
    // demonstration is for. What it must not do is survive into production,
    // where the same behaviour is an authentication bypass.
    //
    // Anything that presents credentials is exempt by name, so a new public
    // route returning a token has to be added here deliberately.
    const mayIssueTokens = new Set(['POST /v1/auth/mfa/verify', 'POST /v1/auth/refresh']);

    await asProduction(async () => {
      for (const route of ROUTES.filter((r) => r.public)) {
        const id = `${route.method} ${route.pattern}`;
        if (mayIssueTokens.has(id) || route.pattern.includes(':')) continue;

        const response = await fetch(`${base}${route.pattern}`, {
          method: route.method,
          headers: route.method === 'POST' ? { 'content-type': 'application/json' } : {},
          body: route.method === 'POST' ? '{}' : undefined,
        });

        const text = await response.text();
        assert.ok(
          !/"accessToken"/.test(text),
          `${id} returned an access token to an anonymous caller in production. A public route may begin an authentication, never complete one.`,
        );
      }
    });
  });
});

describe('the demonstration surface in production', () => {
  it('refuses to bootstrap a console session', async () => {
    const response = await asProduction(() =>
      fetch(`${base}/v1/console/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );

    assert.equal(response.status, 403);
    const body = (await response.json()) as { title: string };
    assert.equal(body.title, 'DEMO_DISABLED');
  });

  it('refuses to list demonstration identities', async () => {
    const response = await asProduction(() =>
      fetch(`${base}/v1/console/identities`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );

    assert.equal(response.status, 403);
  });

  it('still serves both outside production, or the demonstration is broken', async () => {
    for (const path of ['/v1/console/session', '/v1/console/identities']) {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(response.status, 201, `${path} stopped working outside production`);
    }
  });

  it('does not return the MFA challenge code in production', async () => {
    // The same class of leak on the route next door: `devCode` short-circuits
    // the second factor, and is returned deliberately outside production so
    // local work does not need an SMS gateway.
    const response = await asProduction(() =>
      fetch(`${base}/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'pm@meridian.example' }),
      }),
    );

    const text = await response.text();
    assert.ok(!/"devCode"/.test(text), 'the MFA challenge code was returned in production');
  });
});

describe('HEAD, which is what probes actually send', () => {
  /**
   * Uptime monitors, load balancers and link checkers probe with HEAD. The
   * router matched on the exact method, so every path answered 404 to one —
   * including `/healthz`, which on a platform whose health probe defaults to
   * HEAD reads as a permanent outage of a healthy service.
   *
   * Node discards the body of a HEAD response by itself, so routing it as GET
   * is the whole fix.
   */
  it('answers HEAD wherever it answers GET', async () => {
    for (const path of ['/healthz', '/readyz', '/', '/about', '/status', '/v1/signup/account-types']) {
      const head = await fetch(`${base}${path}`, { method: 'HEAD' });
      const get = await fetch(`${base}${path}`);
      assert.equal(head.status, get.status, `HEAD ${path} answered ${head.status} where GET answered ${get.status}`);
    }
  });

  it('sends no body with a HEAD response', async () => {
    const response = await fetch(`${base}/healthz`, { method: 'HEAD' });
    assert.equal(await response.text(), '', 'a HEAD response carried a body');
  });

  it('still refuses HEAD on a path that has no GET', async () => {
    // /v1/signup is POST-only. HEAD must not become a way to reach it.
    const response = await fetch(`${base}/v1/signup`, { method: 'HEAD' });
    assert.equal(response.status, 404);
  });
});

/**
 * Landing imagery.
 *
 * Five slots render an image when the file is present in `frontend/media/` and
 * nothing at all when it is not. The "nothing at all" half is what needs a
 * test: the failure it prevents is a page that reserves space for an image
 * that is never coming, or shows a browser's broken-image icon on the first
 * screen a customer ever sees.
 */
describe('landing imagery', () => {
  it('emits no img element for a slot with no file behind it', async () => {
    const reply = await fetch(`${base}/`);
    const html = await reply.text();

    const { readdirSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const mediaDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend', 'media');
    const present = readdirSync(mediaDir).filter((f) => !f.endsWith('.md'));

    const rendered = [...html.matchAll(/<img src="\/media\/([^"]+)"/g)].map((m) => m[1]!);
    assert.deepEqual(
      rendered.sort(),
      present.sort(),
      'the page rendered an image for a file that is not there, or omitted one that is',
    );
  });

  it('gives every rendered image alt text and reserved dimensions', async () => {
    const html = await (await fetch(`${base}/`)).text();

    for (const tag of html.match(/<img src="\/media\/[^>]+>/g) ?? []) {
      assert.match(tag, /alt="[^"]{20,}"/, `alt text is missing or too short to be useful:\n${tag}`);
      assert.match(tag, /width="\d+"/, `no reserved width, so the page will reflow:\n${tag}`);
      assert.match(tag, /height="\d+"/, `no reserved height, so the page will reflow:\n${tag}`);
    }
  });

  it('serves media from this origin only, which is what the policy permits', async () => {
    const html = await (await fetch(`${base}/`)).text();
    // img-src is 'self' and data:. An absolute URL to any other host would be
    // blocked by the browser silently, which is the worst way to find out.
    assert.equal(/<img[^>]+src="https?:\/\//.test(html), false, 'an image is referenced from another host');
  });
});
