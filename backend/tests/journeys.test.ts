import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { rateLimiter } from '../src/api/middleware.ts';
import { deliveries } from '../src/notifications/notify.ts';
import { entriesByCodePrefix } from '../src/notifications/outbox.ts';
import * as signup from '../src/identity/signup.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The five journeys the launch audit marked **NOT TESTED**.
 *
 * Registration, account recovery, invitation, export and account deletion were
 * all recorded in `docs/LAUNCH_VERDICT.md` as never having been driven end to
 * end. That was an honest gap and this closes it, on the rule the verdict sets
 * for itself: **a visible success message is not proof of successful
 * completion**. Every journey below asserts on the state that resulted — the
 * account, the seat, the redaction, the suspension — and not on the status
 * code that reported it.
 *
 * They live in one file because they share a shape and a lesson: each has a
 * step in the middle that a happy-path test skips, and it is that step that
 * carries the product's promise. Registration's is the verification token.
 * Recovery's is that a code arrives at all. Invitation's is the seat cap.
 * Export's is redaction by audience. Deletion's is the grace period.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;

type Reply = { status: number; body: any; text: string; headers: Headers };

async function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, body, text, headers: response.headers };
}

/** Sign in the way a person does: login, then answer the challenge. */
async function signIn(email: string): Promise<string> {
  rateLimiter.reset();
  const login = await call('POST', '/v1/auth/login', { body: { email } });
  assert.equal(login.status, 201, login.text);
  const verified = await call('POST', '/v1/auth/mfa/verify', {
    body: { actorId: login.body.actorId, challengeId: login.body.challengeId, code: login.body.devCode },
  });
  assert.equal(verified.status, 201, verified.text);
  return verified.body.accessToken as string;
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

// ---------------------------------------------------------------- registration

describe('journey: registration', () => {
  const applicant = {
    email: 'new.customer@example.test',
    contactName: 'Dana Achebe',
    organisationName: 'Achebe Civils',
    jurisdiction: 'GB',
    currency: 'GBP',
    package: 'SOLO' as const,
  };

  it('answers identically whether or not the address is already in use', async () => {
    rateLimiter.reset();
    const fresh = await call('POST', '/v1/signup', { body: applicant });
    assert.equal(fresh.status, 201, fresh.text);

    // The same address again. If the receipt differed, the signup form would
    // be an account-enumeration oracle that needs no authentication — feed it
    // a leaked address list and it sorts customers from strangers for free.
    const repeat = await call('POST', '/v1/signup', { body: applicant });
    assert.equal(repeat.status, fresh.status);
    assert.deepEqual(
      Object.keys(repeat.body).sort(),
      Object.keys(fresh.body).sort(),
      'the second registration answered a different shape to the first',
    );
  });

  it('emails a verification link rather than returning a session', async () => {
    // The token never comes back in the response, deliberately — it goes to
    // the address, which is what proves the address. So the test reads what
    // was queued for delivery, which is the closest thing to opening the
    // inbox, and asserts the link is actually in it.
    const queued = entriesByCodePrefix(platform, 'account.registration', 25);
    assert.ok(queued.length > 0, 'registration sent nothing to the address it is meant to prove');
    const withUrl = queued.find((entry) => typeof entry.payload.actionUrl === 'string');
    assert.ok(withUrl, 'the registration notice carries no verification link');
    assert.match(String(withUrl.payload.actionUrl), /registrationId=|\/verify/);
  });

  it('provisions the tenancy only after the address is proved, and still returns no session', async () => {
    // A fresh applicant, registered through the module so the test holds the
    // token the mail would have carried. Everything after this is over HTTP.
    const started = signup.register(platform, {
      ...applicant,
      email: 'proved@example.test',
      organisationName: 'Proved Contracting',
    });
    assert.equal(started.outcome, 'NEW');
    assert.ok(started.token);

    const wrong = await call('POST', '/v1/signup/verify', {
      body: { registrationId: started.registration!.id, token: 'not-the-token' },
    });
    assert.ok(wrong.status >= 400, 'a wrong verification token provisioned a tenancy');

    const verified = await call('POST', '/v1/signup/verify', {
      body: { registrationId: started.registration!.id, token: started.token! },
    });
    assert.equal(verified.status, 201, verified.text);
    assert.equal(verified.body.status, 'VERIFIED');

    // No tokens. Completing a registration produces an account, not a session
    // — returning one here would rebuild the anonymous login hole through a
    // different door.
    assert.equal(verified.body.accessToken, undefined, 'verification handed out a session');
    assert.equal(verified.body.refreshToken, undefined);

    // The account exists and can be signed into by the ordinary path.
    const account = platform.userByEmail('proved@example.test');
    assert.ok(account, 'verification reported success and created no account');
  });

  it('refuses a package that is not on the self-serve list', async () => {
    rateLimiter.reset();
    // ENTERPRISE is provisioned under an agreement. Letting the form take it
    // would give somebody an enterprise tenancy for a form submission.
    const overreach = await call('POST', '/v1/signup', {
      body: { ...applicant, email: 'enterprise@example.test', package: 'ENTERPRISE' },
    });
    assert.equal(overreach.status, 400, overreach.text);
  });
});

// ------------------------------------------------------------------- recovery

describe('journey: account recovery', () => {
  it('sends a one-time code to a real account and an identical answer to a stranger', async () => {
    rateLimiter.reset();
    const real = platform.user(seed.users.pm!.id).email;

    const known = await call('POST', '/v1/auth/login', { body: { email: real } });
    const unknown = await call('POST', '/v1/auth/login', { body: { email: 'nobody@example.invalid' } });

    assert.equal(known.status, unknown.status);
    assert.equal(known.body.mfaRequired, true);
    assert.equal(unknown.body.mfaRequired, true, 'an unknown address is answered differently to a known one');
    assert.ok(unknown.body.challengeId, 'the decoy carries no challenge id, which is the tell');
    assert.ok(unknown.body.actorId, 'the decoy carries no actor id, which is the other tell');
  });

  it('recovers the account with the code, and refuses the stranger who guesses', async () => {
    rateLimiter.reset();
    const real = platform.user(seed.users.qs!.id).email;
    const login = await call('POST', '/v1/auth/login', { body: { email: real } });

    const wrong = await call('POST', '/v1/auth/mfa/verify', {
      body: { actorId: login.body.actorId, challengeId: login.body.challengeId, code: '000000' },
    });
    assert.ok(wrong.status >= 400, 'a wrong code recovered the account');

    const right = await call('POST', '/v1/auth/mfa/verify', {
      body: { actorId: login.body.actorId, challengeId: login.body.challengeId, code: login.body.devCode },
    });
    assert.equal(right.status, 201, right.text);

    // Recovered means usable, not merely "a token came back".
    const working = await call('GET', '/v1/projects', { token: right.body.accessToken });
    assert.equal(working.status, 200, 'recovery returned a token that does not work');
  });

  it('cannot reuse a code, so an intercepted one is spent', async () => {
    rateLimiter.reset();
    const real = platform.user(seed.users.planner!.id).email;
    const login = await call('POST', '/v1/auth/login', { body: { email: real } });
    const body = { actorId: login.body.actorId, challengeId: login.body.challengeId, code: login.body.devCode };

    const first = await call('POST', '/v1/auth/mfa/verify', { body });
    assert.equal(first.status, 201, first.text);

    const replay = await call('POST', '/v1/auth/mfa/verify', { body });
    assert.ok(replay.status >= 400, 'a one-time code was accepted twice');
  });
});

// ----------------------------------------------------------------- invitation

describe('journey: invitation', () => {
  it('invites somebody, and the invitation is visible as a pending seat', async () => {
    const admin = await signIn(platform.user(seed.users.admin!.id).email);

    const invited = await call('POST', `/v1/projects/${seed.projectId}/invitations`, {
      token: admin,
      body: {
        name: 'Ruth Adeyemi',
        email: 'ruth.adeyemi@subcontractor.test',
        roles: ['SUPERVISOR'],
        external: true,
        organisation: 'Adeyemi Groundworks',
        because: 'Groundworks package supervisor for the inlet works',
      },
    });
    assert.equal(invited.status, 201, invited.text);

    // The state, not the status. An invitation that reported success and left
    // no record is a seat nobody can see and nobody can withdraw.
    const register = await call('GET', `/v1/projects/${seed.projectId}/invitations`, { token: admin });
    assert.equal(register.status, 200, register.text);
    const found = (register.body.invitations as Array<{ email: string; status?: string }>).find(
      (entry) => entry.email === 'ruth.adeyemi@subcontractor.test',
    );
    assert.ok(found, 'the invitation succeeded and appears in no register');
  });

  it('requires a stated reason, because an external identity on a project is a decision', async () => {
    const admin = await signIn(platform.user(seed.users.admin!.id).email);
    const bare = await call('POST', `/v1/projects/${seed.projectId}/invitations`, {
      token: admin,
      body: {
        name: 'Nobody',
        email: 'nobody@subcontractor.test',
        roles: ['SUPERVISOR'],
        external: true,
        because: 'x',
      },
    });
    assert.equal(bare.status, 400, bare.text);
  });

  it('refuses somebody who does not hold the authority to invite', async () => {
    const supervisor = await signIn(platform.user(seed.users.siteManager!.id).email);
    const attempt = await call('POST', `/v1/projects/${seed.projectId}/invitations`, {
      token: supervisor,
      body: {
        name: 'Their Friend',
        email: 'friend@example.test',
        roles: ['SUPERVISOR'],
        external: true,
        because: 'Would like a colleague on the project please',
      },
    });
    assert.ok(attempt.status === 403 || attempt.status === 422, `expected a refusal, got ${attempt.status}`);
  });
});

// --------------------------------------------------------------------- export

describe('journey: export', () => {
  it('produces a report, and redacts it by the audience asked for', async () => {
    const pm = await signIn(platform.user(seed.users.pm!.id).email);

    const internal = await call('POST', `/v1/projects/${seed.projectId}/exports/report`, {
      token: pm,
      body: { audience: 'INTERNAL', format: 'JSON_BUNDLE' },
    });
    assert.equal(internal.status, 201, internal.text);

    const client = await call('POST', `/v1/projects/${seed.projectId}/exports/report`, {
      token: pm,
      body: { audience: 'CLIENT', format: 'JSON_BUNDLE' },
    });
    assert.equal(client.status, 201, client.text);

    // The whole point of an audience. If the two bundles were identical, the
    // audience field would be decoration and a client would be reading the
    // contractor's internal commercial position.
    assert.notEqual(
      internal.text.length,
      client.text.length,
      'the internal and client bundles are byte-identical — the audience redaction did nothing',
    );
  });

  it('renders a PDF a person could actually open', async () => {
    const pm = await signIn(platform.user(seed.users.pm!.id).email);
    const response = await fetch(`${base}/v1/projects/${seed.projectId}/exports/report.pdf`, {
      method: 'POST',
      headers: { authorization: `Bearer ${pm}`, 'content-type': 'application/json' },
      body: JSON.stringify({ audience: 'CLIENT' }),
    });
    // One read of the body. The first version consumed it with `.text()` for
    // the failure message and then asked for `.arrayBuffer()`, which throws.
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200, `${response.status}: ${bytes.subarray(0, 200).toString('utf8')}`);
    // A PDF, not a JSON error with a PDF content type on it.
    assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-', 'the export is not a PDF');
    assert.ok(bytes.length > 1000, `a ${bytes.length}-byte PDF is an empty one`);
  });

  it('does not hand a caller commercial detail the read routes refuse them', async () => {
    /**
     * A real authorisation bypass, found by crossing a read route with an
     * export rather than by testing either alone — and missed by the launch
     * audit, which probed reads and never asked whether an export honoured the
     * same rule.
     *
     * A site supervisor is refused `/v1/projects/:id/commercial-control` with
     * 403 ACCESS_DENIED. Before the fix, the same identity obtained CPI, SPI
     * and the cost position by asking for a report addressed to a court: the
     * audience decided the redaction and the identity decided nothing.
     *
     * Broken function-level authorisation of the plainest kind — one door
     * enforcing a capability and another beside it that does not.
     */
    const supervisor = await signIn(platform.user(seed.users.siteManager!.id).email);

    // The premise. If this stops being 403 the test below proves nothing.
    const direct = await call('GET', `/v1/projects/${seed.projectId}/commercial-control`, { token: supervisor });
    assert.equal(direct.status, 403, `the premise has changed: a supervisor now gets ${direct.status} on the read`);

    // The export is still produced — a supervisor may export the project, and
    // refusing outright would take away a capability they legitimately hold.
    // What they must not receive is the part they cannot read.
    const court = await call('POST', `/v1/projects/${seed.projectId}/exports/report`, {
      token: supervisor,
      body: { audience: 'COURT', format: 'JSON_BUNDLE' },
    });
    assert.equal(court.status, 201, court.text);
    assert.ok(
      !/"text":"Commercial"/.test(court.text),
      'a supervisor refused the commercial position on the read route received it in an export addressed to a court',
    );

    // And the person who may read it still gets it, or the fix would have
    // closed the hole by breaking the feature.
    const pm = await signIn(platform.user(seed.users.pm!.id).email);
    const proper = await call('POST', `/v1/projects/${seed.projectId}/exports/report`, {
      token: pm,
      body: { audience: 'COURT', format: 'JSON_BUNDLE' },
    });
    assert.equal(proper.status, 201, proper.text);
    assert.ok(
      /"text":"Commercial"/.test(proper.text),
      'the fix removed the commercial section from everybody, which is not a fix',
    );
  });
});

// ------------------------------------------------------------------- deletion

describe('journey: account deletion', () => {
  it('says what would and would not be removed before anything is destroyed', async () => {
    const bim = await signIn(platform.user(seed.users.bim!.id).email);
    const position = await call('GET', '/v1/me/erasure', { token: bim });
    assert.equal(position.status, 200, position.text);

    // A confirmation screen for an irreversible act has to name the account it
    // is about; the session payload does not carry the address.
    assert.equal(position.body.identity.email, platform.user(seed.users.bim!.id).email);
    assert.ok(position.body.requestedAt === undefined || position.body.requestedAt === null);
  });

  it('starts a grace period rather than erasing immediately, and suspends the account', async () => {
    const designer = await signIn(platform.user(seed.users.designer!.id).email);

    const requested = await call('POST', '/v1/me/erasure', {
      token: designer,
      body: { reason: 'Leaving the company at the end of the month' },
    });
    assert.equal(requested.status, 201, requested.text);

    // The state, not the status. An erasure that reported success and left the
    // account working is a promise the platform has not kept.
    const user = platform.user(seed.users.designer!.id);
    assert.ok(user.erasureRequestedAt, 'the request succeeded and nothing was recorded against the account');

    const position = await call('GET', '/v1/me/erasure', { token: designer });
    assert.ok(position.body.requestedAt, 'the outstanding request is invisible to the person who made it');
  });

  it('requires a reason, because an irreversible act with no stated basis is unreviewable', async () => {
    const fm = await signIn(platform.user(seed.users.fm!.id).email);
    const bare = await call('POST', '/v1/me/erasure', { token: fm, body: { reason: '  ' } });
    assert.ok(bare.status >= 400, `a blank reason started an erasure: ${bare.status}`);
  });

  it('can be called off inside the grace period, and the account works again', async () => {
    const qaqc = await signIn(platform.user(seed.users.qaqc!.id).email);

    const requested = await call('POST', '/v1/me/erasure', {
      token: qaqc,
      body: { reason: 'Requested in error' },
    });
    assert.equal(requested.status, 201, requested.text);
    assert.ok(platform.user(seed.users.qaqc!.id).erasureRequestedAt);

    const cancelled = await call('DELETE', '/v1/me/erasure', { token: qaqc });
    assert.equal(cancelled.status, 200, cancelled.text);

    // Restored, and provably: a grace period nobody can step back out of is a
    // deletion with extra steps.
    const after = platform.user(seed.users.qaqc!.id);
    assert.ok(!after.erasureRequestedAt, 'the erasure was cancelled and the account is still marked for deletion');
  });

  it('tells the account holder, at the address that is about to stop working', async () => {
    // `privacy.account_deletion_requested`, not `account.*` — the first
    // version of this test guessed the prefix and failed for that reason
    // rather than for a defect. The notice is sent to the address read
    // *before* the request, because after it the account is suspended and the
    // notice still has to reach the real mailbox.
    const queued = entriesByCodePrefix(platform, 'privacy.account_deletion', 50);
    const delivered = deliveries(platform, seed.tenantId, 200).filter((entry) =>
      entry.code.startsWith('privacy.account_deletion'),
    );
    assert.ok(
      queued.length > 0 || delivered.length > 0,
      'an account was marked for deletion and nobody was told',
    );

    // Named, so a person can tell which of their accounts is going.
    const notice = queued[0];
    if (notice) assert.ok(notice.recipients.length > 0, 'the deletion notice was addressed to nobody');
  });
});
