import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { rateLimiter } from '../src/api/middleware.ts';
import { createMfaChallenge, identityLock, issueTokens, verifyMfaChallenge } from '../src/identity/auth.ts';
import * as lockout from '../src/identity/lockout.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { config } from '../src/config.ts';

/**
 * What stood between an attacker and an account, and what stands there now.
 *
 * The platform had one control: a rate limit of twenty auth requests a minute,
 * keyed by remote address for anybody not yet holding a token. Against one
 * machine hammering the door that is a real control. Against the thing this is
 * usually facing — a run spread over a thousand addresses — it is none at all,
 * because rotating addresses is not an evasion of an address-keyed limit, it is
 * the entire design of the equipment.
 *
 * Underneath it, measured rather than assumed: a one-time code is six hex
 * characters, and its challenge accepted **a hundred thousand wrong guesses**
 * across its five-minute life with the real code still working afterwards.
 * Sixteen million codes and unlimited free attempts is not sixteen million
 * codes.
 *
 * Three things had to be true, and each test below is one of them failing when
 * the control is taken out:
 *
 *   - a challenge dies after a handful of wrong codes;
 *   - the **identity** is counted, not the connection, so restarting the run
 *     with a fresh challenge does not reset anything;
 *   - **nothing observable distinguishes a locked account from a wrong code**,
 *     because only a real account can be locked and saying so rebuilds the
 *     account-enumeration oracle the login route goes to such lengths to close.
 */

beforeEach(() => {
  lockout.reset();
});

describe('a challenge is not an unlimited number of guesses', () => {
  it('dies after a handful of wrong codes, and the right one no longer works', () => {
    const challenge = createMfaChallenge('actor-1');

    for (let attempt = 0; attempt < config.auth.maxChallengeAttempts; attempt++) {
      assert.equal(verifyMfaChallenge('actor-1', challenge.challengeId, `WRONG${attempt}`), false);
    }

    // The assertion that matters. Before this existed, this line was `true`
    // after a hundred thousand wrong codes.
    assert.equal(
      verifyMfaChallenge('actor-1', challenge.challengeId, challenge.code),
      false,
      'a challenge survived its attempt cap and still accepted the real code',
    );
  });

  it('lets somebody who mistypes once still get in', () => {
    // A control that stopped an attacker and also stopped a person with cold
    // hands on a site would be replaced within a week, and the replacement
    // would be worse.
    const challenge = createMfaChallenge('actor-2');
    assert.equal(verifyMfaChallenge('actor-2', challenge.challengeId, 'NOPE'), false);
    assert.equal(verifyMfaChallenge('actor-2', challenge.challengeId, challenge.code), true);
  });

  it('accepts the code in either case, because a person typing it is not shouting', () => {
    const challenge = createMfaChallenge('actor-3');
    assert.equal(verifyMfaChallenge('actor-3', challenge.challengeId, challenge.code.toLowerCase()), true);
  });
});

describe('the count is against the identity, not the connection', () => {
  it('stops the run that asks for a fresh challenge each time', () => {
    // The attack a per-challenge cap alone does not stop: burn one challenge,
    // ask for another, keep going. Keyed to the account, the count carries
    // across challenges — and across addresses, which is the whole reason it
    // is not keyed to one.
    let challengesUsed = 0;
    for (let round = 0; round < 50; round++) {
      const challenge = createMfaChallenge('victim');
      challengesUsed += 1;
      for (let attempt = 0; attempt < config.auth.maxChallengeAttempts; attempt++) {
        verifyMfaChallenge('victim', challenge.challengeId, `WRONG${round}-${attempt}`);
      }
      if (identityLock('victim').locked) break;
    }

    assert.ok(identityLock('victim').locked, 'a run could restart for ever by asking for new challenges');
    assert.ok(
      challengesUsed <= Math.ceil(config.auth.maxIdentityFailures / config.auth.maxChallengeAttempts),
      `the run got through ${challengesUsed} challenges before anything stopped it`,
    );
  });

  it('shuts the account rather than slowing it — the correct code is refused too', () => {
    for (let attempt = 0; attempt < config.auth.maxIdentityFailures; attempt++) {
      lockout.recordFailure('victim');
    }

    const fresh = createMfaChallenge('victim');
    assert.equal(
      verifyMfaChallenge('victim', fresh.challengeId, fresh.code),
      false,
      'a locked identity still verified a correct code',
    );
  });

  it('lifts by itself', () => {
    // A lock somebody has to clear is a denial of service anybody can perform
    // on anybody by failing their sign-in ten times — and a locked project
    // manager cannot approve a payment.
    const start = Date.now();
    for (let attempt = 0; attempt < config.auth.maxIdentityFailures; attempt++) {
      lockout.recordFailure('victim', start);
    }
    assert.equal(lockout.lockState('victim', start).locked, true);

    const after = start + config.auth.lockoutMinutes * 60_000 + 1_000;
    assert.equal(lockout.lockState('victim', after).locked, false, 'the lock did not lift');

    // And it lifts clean. A lock that expired with the count still at the
    // threshold would re-lock on the next single mistake, which is a permanent
    // lock with extra steps.
    assert.equal(lockout.lockState('victim', after).failures, 0);
    assert.equal(lockout.recordFailure('victim', after).locked, false);
  });

  it('forgets failures that fall out of the window', () => {
    // Otherwise ten mistyped codes spread over a fortnight of ordinary use
    // eventually lock somebody who has done nothing wrong, because the count
    // only ever goes up.
    const start = Date.now();
    for (let attempt = 0; attempt < config.auth.maxIdentityFailures - 1; attempt++) {
      lockout.recordFailure('slow-typist', start);
    }

    const later = start + config.auth.failureWindowMinutes * 60_000 + 1_000;
    assert.equal(lockout.recordFailure('slow-typist', later).locked, false, 'stale failures still counted');
  });

  it('clears the count when somebody proves the account is theirs', () => {
    for (let attempt = 0; attempt < config.auth.maxIdentityFailures - 1; attempt++) {
      lockout.recordFailure('actor-4');
    }
    const challenge = createMfaChallenge('actor-4');
    assert.equal(verifyMfaChallenge('actor-4', challenge.challengeId, challenge.code), true);

    assert.equal(lockout.lockState('actor-4').failures, 0, 'signing in did not clear the failures behind it');
  });

  it('names who is locked, once, on the attempt that locked them', () => {
    // The transition is what the route notifies on. An attacker who keeps
    // going after the lock must not be able to use it to post a thousand
    // emails at the person whose account they are attacking.
    let transitions = 0;
    for (let attempt = 0; attempt < config.auth.maxIdentityFailures * 3; attempt++) {
      if (lockout.recordFailure('victim').justLocked) transitions += 1;
    }
    assert.equal(transitions, 1, 'the lock announced itself more than once');
    assert.deepEqual(
      lockout.lockedSubjects().map((entry) => entry.subject),
      ['victim'],
    );
  });
});

describe('the refusal says the same thing either way', () => {
  it('answers a locked identity exactly as it answers a wrong code', () => {
    // Only a real account can be locked. A verification step that
    // distinguished "wrong" from "locked" would sort a leaked address list
    // into customers and strangers — which is the oracle `decoyMfaResponse`
    // and the identical signup receipt exist to close.
    const wrongCode = verifyMfaChallenge('nobody-at-all', 'no-such-challenge', 'ABC123');

    for (let attempt = 0; attempt < config.auth.maxIdentityFailures; attempt++) {
      lockout.recordFailure('locked-actor');
    }
    const locked = createMfaChallenge('locked-actor');
    const lockedAnswer = verifyMfaChallenge('locked-actor', locked.challengeId, locked.code);

    assert.equal(wrongCode, lockedAnswer);
    assert.equal(lockedAnswer, false);
  });

  it('never puts the lock in anything a caller is handed', () => {
    // `identityLock` exists for the route's own notification and the
    // operator's view. If it ever reaches a response body, the point above is
    // lost — so this asserts the shape a client sees carries nothing about it.
    const challenge = createMfaChallenge('actor-5');
    assert.equal('locked' in challenge, false);
    assert.equal('attempts' in identityLock('actor-5'), false);
  });
});

// --- Over the socket ---------------------------------------------------------

/**
 * The same controls, through the gateway.
 *
 * The suite above proves the logic; this proves it is *wired* — that the route
 * consults it, that a locked identity is refused with the same problem+json a
 * wrong code produces, and that the operator can see who is shut out.
 *
 * The address-keyed rate limit is reset between calls on purpose. It is a real
 * control and it caught a single-host run when this was tried against a live
 * server — but it is not the control under test here, and leaving it in the
 * way would mean asserting a 429 and calling it a lockout. Resetting it is the
 * bench equivalent of the attacker having enough addresses that no one key
 * ever trips, which is the case this whole module exists for.
 */
describe('through the gateway', () => {
  let platform: Platform;
  let seed: SeedResult;
  let server: Server;
  let base: string;

  before(async () => {
    platform = new Platform();
    seed = await seedDemoProject(platform);
    server = createGateway(platform);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(() => server.close());

  const post = async (path: string, body: unknown, token?: string) => {
    rateLimiter.reset();
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
  };

  it('refuses a locked identity with the same problem a wrong code gives', async () => {
    lockout.reset();
    const target = seed.users.pm!.id;

    // The run: guess, and when the challenge dies ask for another. Exactly the
    // shape a per-challenge cap alone would not stop.
    let guesses = 0;
    for (let round = 0; round < 40; round++) {
      const challenge = await post('/v1/auth/login', { email: 'pm@meridian.example' });
      for (let attempt = 0; attempt < config.auth.maxChallengeAttempts; attempt++) {
        guesses += 1;
        await post('/v1/auth/mfa/verify', {
          actorId: challenge.body.actorId,
          challengeId: challenge.body.challengeId,
          code: `BAD${round}${attempt}`,
        });
      }
      if (identityLock(target).locked) break;
    }

    assert.ok(identityLock(target).locked, `${guesses} guesses through the gateway and nothing stopped the run`);
    assert.ok(guesses <= config.auth.maxIdentityFailures, 'the account answered more guesses than it should have');

    // The correct code, during the lock. Refused — and refused as MFA_FAILED,
    // not as a distinct "you are locked", which would tell an attacker they
    // had found a real account.
    const mine = await post('/v1/auth/login', { email: 'pm@meridian.example' });
    const refused = await post('/v1/auth/mfa/verify', {
      actorId: mine.body.actorId,
      challengeId: mine.body.challengeId,
      code: mine.body.devCode,
    });
    assert.equal(refused.status, 401);
    assert.equal(refused.body.title, 'MFA_FAILED');

    // A stranger's address, for comparison. Byte-identical but for the trace
    // ids — if these two ever diverge, the lock has become the oracle that
    // `decoyMfaResponse` exists to close.
    const decoy = await post('/v1/auth/login', { email: 'nobody@nowhere.invalid' });
    const stranger = await post('/v1/auth/mfa/verify', {
      actorId: decoy.body.actorId,
      challengeId: decoy.body.challengeId,
      code: 'ABC123',
    });
    assert.equal(stranger.status, refused.status);
    assert.equal(stranger.body.title, refused.body.title);
    assert.equal(stranger.body.detail, refused.body.detail);
  });

  it('shows the operator who is locked, and refuses everybody else the answer', async () => {
    lockout.reset();
    for (let attempt = 0; attempt < config.auth.maxIdentityFailures; attempt++) {
      lockout.recordFailure(seed.users.qs!.id);
    }

    const operatorToken = issueTokens({
      actorId: seed.users.operator!.id,
      tenantId: platform.user(seed.users.operator!.id).tenantId,
      roles: ['PLATFORM_ADMIN'],
      mfaSatisfied: true,
    }).accessToken;

    rateLimiter.reset();
    const seen = await fetch(`${base}/v1/admin/security`, { headers: { authorization: `Bearer ${operatorToken}` } });
    const body = (await seen.json()) as { lockedIdentities: Array<{ actorId: string; unlocksInSeconds: number }> };
    assert.equal(seen.status, 200);
    assert.deepEqual(
      body.lockedIdentities.map((entry) => entry.actorId),
      [seed.users.qs!.id],
    );
    assert.ok(body.lockedIdentities[0]!.unlocksInSeconds > 0);

    // A map of where the locks are is operator-only, for the same reason the
    // gateway logs are.
    rateLimiter.reset();
    const customer = await fetch(`${base}/v1/admin/security`, {
      headers: {
        authorization: `Bearer ${issueTokens({
          actorId: seed.users.pm!.id,
          tenantId: platform.user(seed.users.pm!.id).tenantId,
          roles: platform.user(seed.users.pm!.id).roles,
          mfaSatisfied: true,
        }).accessToken}`,
      },
    });
    assert.equal(customer.status, 403);
  });
});
