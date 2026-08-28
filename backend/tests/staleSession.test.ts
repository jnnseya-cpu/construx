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
 * These tests hold the two halves. The server must refuse a token from another
 * issuer — including on the refresh route, because "refused" rather than
 * "unreachable" is what tells the client the session is finished — and the
 * client must clear it rather than keep presenting it.
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

  it('refuses it on the refresh route too, which is what makes recovery possible', async () => {
    // The client distinguishes "refused" from "unreachable". A refusal here is
    // final and the session must be discarded; a network failure is not, and
    // discarding on that would sign a site operative out for driving through a
    // tunnel.
    const reply = await call('/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: mintStale({ typ: 'refresh' }) }),
    });
    assert.equal(reply.status, 401);
    assert.match(reply.body, /Token issuer or audience mismatch/);
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
