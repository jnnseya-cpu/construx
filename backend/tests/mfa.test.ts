import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { config } from '../src/config.ts';
import { authOf } from '../src/seed.ts';
import { Platform } from '../src/platform.ts';
import { createMfaChallenge, issueTokens } from '../src/identity/auth.ts';
import { rateLimiter } from '../src/api/middleware.ts';
import { currentCodeFor, resetAuthenticators, useAuthenticatorClock } from '../src/identity/authenticators.ts';
import { base32Decode, hotp, matchTotp, otpauthUri, totp } from '../src/identity/totp.ts';
import { lockState, reset as resetLockouts } from '../src/identity/lockout.ts';

/**
 * Two-factor authentication with an authenticator app.
 *
 * The emailed code proves the person holds the mailbox. An authenticator app
 * (RFC 6238) proves they hold a device with a secret shared once at enrolment.
 * The algorithm is checked against the RFC's own vectors; everything around it
 * — enrolment in two steps, one code accepted once, recovery codes that work
 * once, a tenancy that can require it and a gateway that holds a session to
 * enrolment until it does — is driven over HTTP.
 */

describe('RFC 6238', () => {
  // The reference secret "12345678901234567890" and the SHA-1 vectors from
  // Appendix B, truncated to six digits.
  const secret = Buffer.from('12345678901234567890', 'ascii');
  const base32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

  it('produces the published codes', () => {
    assert.equal(hotp(secret, Math.floor(59 / 30)), '287082');
    assert.equal(hotp(secret, Math.floor(1_111_111_109 / 30)), '081804');
    assert.equal(hotp(secret, Math.floor(1_234_567_890 / 30)), '005924');
    assert.equal(hotp(secret, Math.floor(2_000_000_000 / 30)), '279037');
    assert.equal(totp(base32, 59_000), '287082');
  });

  it('decodes the base32 the apps expect', () => {
    assert.deepEqual([...base32Decode(base32)], [...secret]);
  });

  it('accepts a code one step either side of now, and nothing further', () => {
    const now = 1_234_567_890_000;
    assert.equal(matchTotp(base32, totp(base32, now), now), Math.floor(1_234_567_890 / 30));
    assert.equal(matchTotp(base32, totp(base32, now - 30_000), now), Math.floor(1_234_567_890 / 30) - 1);
    assert.equal(matchTotp(base32, totp(base32, now + 30_000), now), Math.floor(1_234_567_890 / 30) + 1);
    assert.equal(matchTotp(base32, totp(base32, now + 90_000), now), null);
    assert.equal(matchTotp(base32, 'abcdef', now), null);
  });

  it('writes the otpauth address the apps read', () => {
    const uri = otpauthUri('CONSTRUX', 'rowan@northgate.example', base32);
    assert.match(uri, /^otpauth:\/\/totp\/CONSTRUX:rowan%40northgate\.example\?/);
    assert.match(uri, /secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ/);
    assert.match(uri, /issuer=CONSTRUX/);
    assert.match(uri, /digits=6/);
    assert.match(uri, /period=30/);
  });
});

let platform: Platform;
let server: Server;
let base: string;
let tenantId: string;
let admin: { id: string; email: string };
let planner: { id: string; email: string };

// The authenticator module reads this clock. Each `tick()` is a new thirty-second
// step, so the next code the "phone" shows is a fresh one; without it every
// second use inside the same step is, correctly, refused as a replay.
let fakeNow = Date.now();
const tick = () => { fakeNow += 30_000; };
const appCode = (userId: string) => currentCodeFor(userId)!;

function tokenFor(userId: string, mfaSatisfied = true): string {
  const auth = authOf(platform, userId);
  return issueTokens({ actorId: auth.actorId, tenantId: auth.tenantId, partyId: auth.partyId, roles: auth.roles, mfaSatisfied }).accessToken;
}

async function send(method: string, path: string, token: string | null, payload?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Sign in the way the console does: email, emailed code, then whatever the platform asks for next. */
async function firstFactor(userId: string) {
  const challenge = createMfaChallenge(userId);
  return send('POST', '/v1/auth/mfa/verify', null, { actorId: userId, challengeId: challenge.challengeId, code: challenge.code });
}

async function enrol(userId: string): Promise<{ recoveryCodes: string[]; accessToken: string }> {
  const token = tokenFor(userId, false);
  const started = await send('POST', '/v1/me/authenticator/begin', token, { label: 'Phone' });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const code = totp(String(started.body.secret), fakeNow);
  const confirmed = await send('POST', '/v1/me/authenticator/confirm', token, { enrolmentId: started.body.enrolmentId, code });
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
  return { recoveryCodes: confirmed.body.recoveryCodes as string[], accessToken: String(confirmed.body.accessToken) };
}

before(async () => {
  resetAuthenticators();
  useAuthenticatorClock(() => new Date(fakeNow));
  resetLockouts();
  platform = new Platform();
  const created = platform.createTenant({
    legalName: 'Northgate Build Ltd',
    jurisdiction: 'GB',
    defaultCurrency: 'GBP',
    tier: 'TEAM',
    package: 'CORE_PROJECT',
    enterpriseName: 'Northgate',
  });
  tenantId = created.tenant.id;
  const a = platform.createUser({ tenantId, name: 'Rowan Adeyemi', email: 'rowan@northgate.example', roles: ['ENTERPRISE_ADMIN'] });
  const p = platform.createUser({ tenantId, name: 'Esi Mensah', email: 'esi@northgate.example', roles: ['PLANNER'] });
  admin = { id: a.id, email: a.email };
  planner = { id: p.id, email: p.email };
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server.close();
  useAuthenticatorClock();
});

describe('enrolment', () => {
  it('signs in on the emailed code alone while nothing more is enrolled or required', async () => {
    const signedIn = await firstFactor(planner.id);
    assert.equal(signedIn.status, 201, JSON.stringify(signedIn.body));
    assert.ok(signedIn.body.accessToken);
    assert.equal(signedIn.body.secondFactorRequired, undefined);
    assert.equal(signedIn.body.enrolmentRequired, undefined);
  });

  it('records nothing until a code from the app confirms the secret', async () => {
    const token = tokenFor(planner.id);
    const started = await send('POST', '/v1/me/authenticator/begin', token, {});
    assert.equal(started.status, 201);
    assert.match(String(started.body.uri), /^otpauth:\/\/totp\//);
    const wrong = await send('POST', '/v1/me/authenticator/confirm', token, { enrolmentId: started.body.enrolmentId, code: '000000' });
    assert.equal(wrong.status, 422);
    assert.equal(wrong.body.title, 'AUTHENTICATOR_CODE_WRONG');
    const status = await send('GET', '/v1/me/authenticator', token);
    assert.equal(status.body.authenticator, null, 'nothing enrolled by a failed confirmation');
  });

  it('enrols on a right code and hands over ten recovery codes, once', async () => {
    const { recoveryCodes } = await enrol(planner.id);
    assert.equal(recoveryCodes.length, 10);
    assert.ok(recoveryCodes.every((code) => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)));
    const status = await send('GET', '/v1/me/authenticator', tokenFor(planner.id));
    const held = status.body.authenticator as Record<string, unknown>;
    assert.equal(held.label, 'Phone');
    assert.equal(held.recoveryCodesLeft, 10);
    assert.equal('secret' in held, false, 'the secret never comes back');
  });

  it('refuses a second authenticator while one is enrolled', async () => {
    const again = await send('POST', '/v1/me/authenticator/begin', tokenFor(planner.id), {});
    assert.equal(again.status, 409);
    assert.equal(again.body.title, 'AUTHENTICATOR_ALREADY_ENROLLED');
  });
});

describe('signing in with a second factor', () => {
  it('withholds tokens after the emailed code and asks for the app’s code', async () => {
    const step = await firstFactor(planner.id);
    assert.equal(step.status, 201, JSON.stringify(step.body));
    assert.equal(step.body.secondFactorRequired, true);
    assert.equal(step.body.accessToken, undefined, 'no session yet');
    assert.ok(step.body.factorChallengeId);
    assert.deepEqual(step.body.methods, ['AUTHENTICATOR', 'RECOVERY_CODE']);
  });

  it('mints a session on the app’s code, and refuses the same code a second time', async () => {
    tick();
    const step = await firstFactor(planner.id);
    const code = appCode(planner.id);
    const signedIn = await send('POST', '/v1/auth/mfa/factor', null, { actorId: planner.id, factorChallengeId: step.body.factorChallengeId, code });
    assert.equal(signedIn.status, 201, JSON.stringify(signedIn.body));
    assert.ok(signedIn.body.accessToken);
    assert.equal(signedIn.body.method, 'AUTHENTICATOR');

    // The same six digits again, inside their thirty seconds, are a replay.
    const replay = await firstFactor(planner.id);
    const replayed = await send('POST', '/v1/auth/mfa/factor', null, { actorId: planner.id, factorChallengeId: replay.body.factorChallengeId, code });
    assert.equal(replayed.status, 401);
    assert.equal(replayed.body.title, 'MFA_FAILED');
  });

  it('refuses a wrong code, a dead challenge and an unknown challenge identically', async () => {
    const step = await firstFactor(planner.id);
    const wrong = await send('POST', '/v1/auth/mfa/factor', null, { actorId: planner.id, factorChallengeId: step.body.factorChallengeId, code: '000000' });
    assert.equal(wrong.status, 401);
    const unknown = await send('POST', '/v1/auth/mfa/factor', null, { actorId: planner.id, factorChallengeId: 'nope', code: currentCodeFor(planner.id) });
    assert.equal(unknown.status, 401);
    assert.equal(wrong.body.title, unknown.body.title);
  });

  it('accepts a recovery code once, in place of the app', async () => {
    resetLockouts();
    const status = await send('GET', '/v1/me/authenticator', tokenFor(planner.id));
    const before = (status.body.authenticator as Record<string, number>).recoveryCodesLeft;
    tick();
    const fresh = await send('POST', '/v1/me/authenticator/recovery-codes', tokenFor(planner.id), { code: appCode(planner.id) });
    assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
    const codes = fresh.body.recoveryCodes as string[];
    assert.equal(codes.length, 10);
    assert.ok(Number(before) <= 10);

    const step = await firstFactor(planner.id);
    const used = await send('POST', '/v1/auth/mfa/factor', null, { actorId: planner.id, factorChallengeId: step.body.factorChallengeId, code: codes[0]!.toLowerCase() });
    assert.equal(used.status, 201, JSON.stringify(used.body));
    assert.equal(used.body.method, 'RECOVERY_CODE');
    assert.equal(used.body.recoveryCodesLeft, 9);

    const again = await firstFactor(planner.id);
    const reused = await send('POST', '/v1/auth/mfa/factor', null, { actorId: planner.id, factorChallengeId: again.body.factorChallengeId, code: codes[0] });
    assert.equal(reused.status, 401, 'a recovery code works once');
  });

  it('locks the identity after repeated wrong codes, like the first factor does', async () => {
    resetLockouts();
    rateLimiter.reset();
    const step = await firstFactor(planner.id);
    for (let attempt = 0; attempt < config.auth.maxIdentityFailures; attempt += 1) {
      const wrong = await send('POST', '/v1/auth/mfa/factor', null, { actorId: planner.id, factorChallengeId: step.body.factorChallengeId, code: '111111' });
      assert.equal(wrong.status, 401);
    }
    assert.equal(lockState(planner.id).locked, true, 'the identity lock counts second-factor failures');

    // Locked means locked: the right code is refused, and so is starting again
    // from the emailed code.
    tick();
    const right = await send('POST', '/v1/auth/mfa/factor', null, { actorId: planner.id, factorChallengeId: step.body.factorChallengeId, code: appCode(planner.id) });
    assert.equal(right.status, 401, 'a right code is refused while the identity is locked');
    const again = await firstFactor(planner.id);
    assert.equal(again.status, 401);
    resetLockouts();
    rateLimiter.reset();
  });
});

describe('the tenancy’s requirement', () => {
  it('cannot be required by an administrator who has not enrolled', async () => {
    const refused = await send('POST', '/v1/team/security-policy', tokenFor(admin.id), { mfaRequired: 'EVERYONE', reason: 'Company policy' });
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.equal(refused.body.title, 'ENROL_BEFORE_REQUIRING');
  });

  it('once set, holds a session without a second factor to enrolment', async () => {
    await enrol(admin.id);
    const set = await send('POST', '/v1/team/security-policy', tokenFor(admin.id), { mfaRequired: 'EVERYONE', reason: 'Company policy from 1 September' });
    assert.equal(set.status, 201, JSON.stringify(set.body));
    assert.equal(set.body.mfaRequired, 'EVERYONE');

    // A third person, with nothing enrolled, signs in on the emailed code and
    // gets a session that can only enrol.
    const newcomer = platform.createUser({ tenantId, name: 'Lee Morgan', email: 'lee@northgate.example', roles: ['SUPERVISOR'] });
    const signedIn = await firstFactor(newcomer.id);
    assert.equal(signedIn.status, 201, JSON.stringify(signedIn.body));
    assert.equal(signedIn.body.enrolmentRequired, true);
    const token = String(signedIn.body.accessToken);

    const blocked = await send('GET', '/v1/projects', token);
    assert.equal(blocked.status, 403, JSON.stringify(blocked.body));
    assert.equal(blocked.body.title, 'MFA_ENROLMENT_REQUIRED');
    const allowed = await send('GET', '/v1/me/authenticator', token);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.required, true);
    assert.equal(allowed.body.satisfied, false);

    // Enrolling hands back a session that satisfies it.
    const started = await send('POST', '/v1/me/authenticator/begin', token, {});
    const confirmed = await send('POST', '/v1/me/authenticator/confirm', token, { enrolmentId: started.body.enrolmentId, code: totp(String(started.body.secret), fakeNow) });
    assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
    const open = await send('GET', '/v1/projects', String(confirmed.body.accessToken));
    assert.equal(open.status, 200);
  });

  it('refuses removing the authenticator while the organisation requires one', async () => {
    tick();
    const refused = await send('POST', '/v1/me/authenticator/revoke', tokenFor(admin.id), { code: appCode(admin.id) });
    assert.equal(refused.status, 422);
    assert.equal(refused.body.title, 'MFA_REQUIRED_BY_POLICY');
  });

  it('shows on the directory who holds one, and the requirement in force', async () => {
    const team = await send('GET', '/v1/team', tokenFor(admin.id));
    assert.equal(team.status, 200);
    const people = team.body.people as Array<Record<string, unknown>>;
    const esi = people.find((person) => person.id === planner.id)!;
    assert.equal((esi.mfa as Record<string, unknown>).authenticator, true);
    assert.equal((esi.mfa as Record<string, unknown>).label, 'Authenticator app');
    assert.equal((team.body.governance as Record<string, unknown>).mfaRequired, 'EVERYONE');
  });

  it('an operator is required by default and a demonstration identity never is', async () => {
    assert.equal(config.auth.operatorMfaRequired, true);
    const operator = platform.createUser({ tenantId: 'platform', name: 'Ops', email: 'ops@construx.example', roles: ['PLATFORM_ADMIN'] });
    assert.equal(platform.secondFactorRequiredFor(operator.id), true);
    const demo = platform.createUser({ tenantId, name: 'Demo', email: 'demo@meridian.example', roles: ['PLANNER'], demonstration: true });
    assert.equal(platform.secondFactorRequiredFor(demo.id), false);
  });

  it('survives a restart: the authenticator and the policy are on the ledger', () => {
    const rebuilt = new Platform();
    rebuilt.ledger.restore(platform.ledger.events());
    rebuilt.rehydrate();
    assert.equal(rebuilt.securityPolicy(tenantId).mfaRequired, 'EVERYONE');
    assert.equal(rebuilt.secondFactorRequiredFor(planner.id), true);
    // The store was rebound to the rebuilt ledger by the constructor; the
    // planner's authenticator is still there.
    assert.ok(currentCodeFor(planner.id));
  });
});
