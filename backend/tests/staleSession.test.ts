import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { config } from '../src/config.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The stored session that could never work again, and trapped somebody.
 *
 * Reported as "I cannot access and test: UNAUTHENTICATED — Token issuer or
 * audience mismatch", and reproduced exactly.
 *
 * The issuer string moved from `construx.ai` to `construxvg.com`. Both builds
 * default to the same JWT secret, so a token minted by the *older* build passes
 * the signature check — the first thing `verifyToken` does — and then fails the
 * issuer check. A browser holding one from before that change was refused on
 * every request.
 *
 * That refusal was correct. What was wrong is what happened next: **nothing**.
 *
 *   - `rotate()` returned `null` when the refresh was refused and left the dead
 *     session in `localStorage`, so the next request repeated the same failure.
 *   - `draw()` called `loadMatrix()` *outside* its try/catch, so the 401 escaped
 *     the function entirely — no sign-out, no redirect, just an unhandled
 *     rejection and a shell that never rendered.
 *
 * The result was permanent: every reload produced the same refusal for ever,
 * and the only way out was clearing browser storage by hand. Nobody discovers
 * that, and on a field device nobody can reach it to do it.
 *
 * Fixed in two places, because the two failures are different.
 *
 * **Server-side**, a token minted under the platform's *previous* issuer can be
 * traded for a current one at `/v1/auth/refresh` and nowhere else. That is the
 * standard migration for an issuer rename, and the bound is what makes it safe:
 * the signature must still verify, it is refused on every ordinary route, the
 * presented token is revoked as the new pair is minted, and the window closes
 * with the refresh token's own expiry. So anybody holding a stale session gets
 * back in on one transparent round trip, having cleared nothing.
 *
 * **Client-side**, a refresh that is genuinely *refused* — an expired refresh
 * token, a revoked one, a rotated secret — clears the stored session, because a
 * refusal is final. A network failure does not, because the session may be
 * perfectly good and the browser simply offline.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const API_CLIENT = readFileSync(resolve(ROOT, 'frontend/lib/api.js'), 'utf8');
const APP = readFileSync(resolve(ROOT, 'frontend/app.js'), 'utf8');

let server: Server;
let platform: Platform;
let seed: SeedResult;
let port = 0;

/** A token minted the way the older build did: same secret, previous issuer. */
function mintStale(over: Record<string, unknown> = {}): string {
  const secret = config.auth.jwtSecret;
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);

  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({
    sub: 'user-from-an-older-build',
    tid: 'tenant-old',
    eid: 'ent',
    pid: 'party',
    roles: ['PM'],
    scopes: [],
    jti: `stale-${Math.random().toString(36).slice(2)}`,
    mfa: false,
    rai: false,
    iat: now,
    // The old value. Everything else is exactly what the current build writes.
    iss: 'https://construx.ai',
    aud: 'construx-gateway',
    typ: 'access',
    exp: now + 900,
    ...over,
  });
  return `${header}.${body}.${createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')}`;
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  server = createGateway(platform);
  await new Promise<void>((resolve_) => server.listen(0, '127.0.0.1', resolve_));
  port = (server.address() as { port: number }).port;
});

after(() => server.close());

const call = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
  return { status: response.status, body: await response.text() };
};

describe('a token from another issuer is refused, and says which check failed', () => {
  it('refuses it on an ordinary read', async () => {
    const reply = await call('/v1/permissions/matrix', {
      headers: { Authorization: `Bearer ${mintStale()}` },
    });
    assert.equal(reply.status, 401);
    assert.match(reply.body, /Token issuer or audience mismatch/);
  });

  it('gets past the signature check first, which is why the message is about the issuer', async () => {
    // The signature is *valid* — same secret, both builds defaulting to it.
    // That is precisely why this was confusing: the token is well-formed and
    // correctly signed, and still worthless.
    const tampered = `${mintStale().slice(0, -4)}zzzz`;
    const reply = await call('/v1/permissions/matrix', { headers: { Authorization: `Bearer ${tampered}` } });
    assert.match(reply.body, /Invalid token signature/);
  });

  it('trades a legacy refresh token for a current pair, rather than stranding it', async () => {
    // The migration path, and the reason this stops being a permanent lockout.
    // A session minted before the rename can be exchanged exactly here — the
    // signature still verifies, so the token is genuinely ours; it is refused
    // everywhere else, so nothing is *used* under a legacy issuer; and the
    // presented token is revoked as the new pair is minted, so the exchange
    // works once.
    const reply = await call('/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: mintStale({ typ: 'refresh' }) }),
    });
    assert.equal(reply.status, 201, reply.body);

    const { accessToken } = JSON.parse(reply.body) as { accessToken: string };
    // And what comes back is a current token, usable on an ordinary route.
    const claims = JSON.parse(Buffer.from(accessToken.split('.')[1]!, 'base64url').toString('utf8')) as {
      iss: string;
    };
    assert.equal(claims.iss, 'https://construxvg.com');
  });

  it('accepts a legacy issuer only when trading it in, never for ordinary use', async () => {
    // The bound that makes the migration safe rather than a weakened check. A
    // legacy access token is worthless on every route; only the exchange works.
    const legacy = mintStale();
    const reply = await call('/v1/permissions/matrix', { headers: { Authorization: `Bearer ${legacy}` } });
    assert.equal(reply.status, 401);
    assert.match(reply.body, /Token issuer or audience mismatch/);
  });

  it('lets the exchange happen once, because the presented token is revoked as the new pair is minted', async () => {
    const legacy = mintStale({ typ: 'refresh' });
    const exchange = () =>
      call('/v1/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: legacy }),
      });

    assert.equal((await exchange()).status, 201);
    // Replaying it is refused: rotation revokes as it mints.
    const second = await exchange();
    assert.equal(second.status, 401, second.body);
  });

  it('still lets a current token in, so this is about the token and not the route', async () => {
    // Minted by this build, through the platform's own issuer. Same route, same
    // secret, same everything except the issuer string — which is the whole
    // difference between working and permanently locked out.
    const { accessToken } = issueTokens({
      actorId: seed.users.pm!.id,
      tenantId: seed.tenantId,
      roles: ['PM'],
    });

    const reply = await call('/v1/permissions/matrix', { headers: { Authorization: `Bearer ${accessToken}` } });
    assert.equal(reply.status, 200, reply.body);
  });
});

describe('the client discards a session that can never work again', () => {
  it('clears the stored session when the refresh is refused', () => {
    // Asserted against the source because there is no browser here. The
    // property is narrow and exact: inside the `!response.ok` branch of
    // `rotate`, the session is cleared.
    const rotate = /async function rotate\(\)[\s\S]*?\n}/.exec(API_CLIENT)?.[0] ?? '';
    assert.ok(rotate.length > 0, 'rotate() could not be found');

    const refused = /if \(!response\.ok\)\s*\{([\s\S]*?)\n      \}/.exec(rotate)?.[1] ?? '';
    assert.match(refused, /session\.clear\(\)/, 'a refused refresh does not clear the dead session');
  });

  it('does not clear it on a network failure, which is not a refusal', () => {
    // A session may be perfectly good and the browser simply offline. Clearing
    // here would sign somebody out for losing signal, which on a site is most
    // of the day.
    const rotate = /async function rotate\(\)[\s\S]*?\n}/.exec(API_CLIENT)?.[0] ?? '';
    const caught = /\} catch \{([\s\S]*?)\} finally \{/.exec(rotate)?.[1] ?? '';
    assert.ok(caught.length > 0, 'the catch block could not be found');
    assert.equal(/session\.clear\(\)/.test(caught), false, 'a network failure signs the user out');
  });

  it('discards a stored session that has no refresh token at all', () => {
    const rotate = /async function rotate\(\)[\s\S]*?\n}/.exec(API_CLIENT)?.[0] ?? '';
    const noRefresh = /if \(!current\?\.refreshToken\)\s*\{([\s\S]*?)\n  \}/.exec(rotate)?.[1] ?? '';
    assert.match(noRefresh, /session\.clear\(\)/, 'a session that cannot be renewed is kept anyway');
  });

  it('offers a way back in from a device that has wedged itself', () => {
    // The clears above handle a session the server refuses. They do not handle
    // the other two things that survive a deploy on a browser: a service worker
    // still serving the shell it installed months ago, and the caches behind
    // it. A device holding those reports the same symptom — "it worked
    // yesterday and now nothing loads" — and every fix for it is a devtools
    // instruction, which is useless for a handset in a site cabin.
    //
    // `/app?reset=1` throws all three away and reloads. Asserted against the
    // source because there is no browser here; the behaviour itself was driven
    // through a real Chromium, which confirmed a planted cache from a build
    // that no longer exists does not survive it.
    const reset = /async function resetIfAsked\(\)[\s\S]*?\n}/.exec(APP)?.[0] ?? '';
    assert.ok(reset.length > 0, 'there is no recovery path for a wedged device');

    assert.match(reset, /reset'\) === '1'/, 'the recovery is not reachable from the address bar');
    assert.match(reset, /localStorage\.clear\(\)/, 'the stored session survives a reset');
    assert.match(reset, /unregister\(\)/, 'the service worker survives a reset');
    assert.match(reset, /caches\.delete/, 'the caches survive a reset');
    // `replace`, not `assign`: going back would re-run the reset and discard
    // whatever the person had just done.
    assert.match(reset, /location\.replace\('\/app'\)/, 'a reset leaves itself in the history');
  });

  it('does not re-register the worker it just removed', () => {
    // The subtle way this recovery fails: the `load` handler fires during the
    // navigation and puts a worker straight back, so the unregister above is
    // undone before the reload happens and the device stays wedged.
    const at = APP.indexOf("navigator.serviceWorker.register('/sw.js'");
    assert.ok(at > 0, 'the service worker is not registered');
    assert.match(APP.slice(Math.max(0, at - 400), at), /resetting/, 'registration is not held off during a reset');
  });

  it('draws nothing behind a reset that is navigating away', () => {
    // Drawing a screen, or draining the outbox under a session that was just
    // cleared, is work against a document about to be replaced — and the drain
    // would try to send queued operations with no credential to send them
    // under.
    const at = APP.indexOf('void resetIfAsked()');
    assert.ok(at > 0, 'the reset does not gate the boot');
    const boot = APP.slice(at, at + 900);
    assert.match(boot, /if \(reset\) return undefined;/, 'the shell boots behind a reset');
    assert.ok(boot.indexOf('drainOutbox') > boot.indexOf('if (reset) return undefined;'), 'the outbox drains behind a reset');
  });

  it('loads the permission matrix inside a guard, so a 401 there signs out rather than escaping', () => {
    // This is the half that made it permanent. `loadMatrix()` sat above the
    // try/catch, so its 401 left `draw()` without rendering anything and
    // without clearing anything — an unhandled rejection, and a shell that
    // never appeared.
    // A window around the call rather than a regex for the whole block: the
    // property is about what surrounds `await loadMatrix()`, and a regex that
    // tried to match balanced braces would fail for reasons unrelated to it.
    const at = APP.indexOf('await loadMatrix();');
    assert.ok(at > 0, 'loadMatrix() is not called from draw()');
    const guarded = APP.slice(Math.max(0, at - 400), at + 400);
    assert.match(guarded, /try \{/, 'loadMatrix() is not inside a try block');
    assert.match(guarded, /signOut\(\)/, 'a 401 from the matrix load does not sign out');
    // And only a 401. Treating every failure as an expired session would sign
    // somebody out for a server error and hide the defect behind a login form.
    assert.match(guarded, /throw error/, 'every failure is treated as an expired session');
    assert.match(guarded, /status === 401/, 'the guard does not distinguish a 401 from anything else');
  });
});
