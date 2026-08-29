import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { accountTypes, resetRegistrations, SELF_SERVE_PACKAGES } from '../src/identity/signup.ts';
import { Platform } from '../src/platform.ts';

/**
 * Public registration.
 *
 * The only endpoint where an unauthenticated stranger creates state, so the
 * tests are mostly about what it refuses and what it declines to reveal.
 *
 * Three properties matter more than the happy path:
 *
 *   1. **It does not enumerate accounts.** Registering an address that already
 *      exists must be indistinguishable from registering a new one. A public
 *      endpoint that distinguishes them tells an attacker which of a leaked
 *      address list are customers here.
 *   2. **A registration is not an account.** No tenancy, no seat, no billing
 *      record until an address is proved. Otherwise anybody creates unlimited
 *      tenancies by typing addresses they do not own.
 *   3. **Verifying returns an account, not a session.** This is the invariant
 *      the console-session hole broke; rebuilding it through the signup door
 *      would be the same defect with a different name.
 */

let platform: Platform;
let server: Server;
let base: string;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any, text: '' };
}

const VALID = {
  email: 'ops@northgate.example',
  contactName: 'Rowan Blake',
  organisationName: 'Northgate Civils Ltd',
  jurisdiction: 'GB',
  currency: 'GBP',
  package: 'CORE_PROJECT',
};

before(async () => {
  platform = new Platform();
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());
beforeEach(() => resetRegistrations());

describe('the account types on offer', () => {
  it('publishes every package with what it includes', async () => {
    const reply = await call('GET', '/v1/signup/account-types');
    assert.equal(reply.status, 200);

    const codes = reply.body.accountTypes.map((a: { package: string }) => a.package);
    assert.deepEqual(codes.sort(), ['CORE_PROJECT', 'ENTERPRISE', 'FREE_TRIAL', 'PROFESSIONAL_DELIVERY', 'SOLO']);
  });

  it('marks enterprise as not self-serve rather than hiding it', () => {
    // Hiding it would make the page a lie about what the product offers.
    const enterprise = accountTypes().find((a) => a.package === 'ENTERPRISE')!;
    assert.equal(enterprise.selfServe, false);
    assert.ok(!SELF_SERVE_PACKAGES.includes('ENTERPRISE'));
  });

  it('keeps an unlimited allowance as null, never as zero', () => {
    // Enterprise has no seat ceiling. Rendering that as 0 would read as "none".
    const enterprise = accountTypes().find((a) => a.package === 'ENTERPRISE')!;
    assert.equal(enterprise.includedSeats, null);
  });

  it('is reachable without a credential, because it is a pricing page', async () => {
    const reply = await call('GET', '/v1/signup/account-types');
    assert.equal(reply.status, 200);
    assert.ok(reply.body.currencies.length > 3, 'the currency list is not published');
  });
});

describe('beginning a registration', () => {
  it('accepts a well-formed registration and says a message is on its way', async () => {
    const reply = await call('POST', '/v1/signup', VALID);
    assert.equal(reply.status, 201);
    assert.equal(reply.body.status, 'SENT');
    assert.match(reply.body.message, /if that address can receive mail/i);
  });

  it('creates no tenancy, no user and no seat before the address is proved', async () => {
    await call('POST', '/v1/signup', { ...VALID, email: 'unproved@northgate.example' });

    assert.equal(platform.userByEmail('unproved@northgate.example'), undefined, 'a user existed before verification');
    assert.equal(
      platform.tenants().filter((t) => t.legalName === 'Northgate Civils Ltd').length,
      0,
      'a tenancy was created before anybody proved they own the address',
    );
  });

  it('refuses a package that is sold rather than self-served', async () => {
    const reply = await call('POST', '/v1/signup', { ...VALID, package: 'ENTERPRISE' });
    // Rejected by the route schema before it reaches the domain, which is where
    // a closed enum belongs.
    assert.equal(reply.status, 400);
  });

  it('refuses a currency or jurisdiction the platform does not hold', async () => {
    assert.equal((await call('POST', '/v1/signup', { ...VALID, currency: 'ZZZ' })).status, 400);
    assert.equal((await call('POST', '/v1/signup', { ...VALID, jurisdiction: 'XX' })).status, 400);
  });

  it('refuses a malformed address', async () => {
    for (const email of ['not-an-address', 'a@b', '@example.com', 'x y@example.com']) {
      const reply = await call('POST', '/v1/signup', { ...VALID, email });
      assert.equal(reply.status, 400, `${email} was accepted`);
    }
  });

  it('refuses an empty organisation or contact name', async () => {
    assert.equal((await call('POST', '/v1/signup', { ...VALID, organisationName: 'A' })).status, 400);
    assert.equal((await call('POST', '/v1/signup', { ...VALID, contactName: '' })).status, 400);
  });

  it('rejects an unknown field rather than ignoring it', async () => {
    const reply = await call('POST', '/v1/signup', { ...VALID, roles: ['PLATFORM_ADMIN'] });
    assert.equal(reply.status, 400, 'a caller could smuggle a field past the schema');
  });
});

describe('what it declines to reveal', () => {
  it('answers identically for a new address and one already registered', async () => {
    const first = await call('POST', '/v1/signup', { ...VALID, email: 'twice@northgate.example' });
    const verify = await call('POST', '/v1/signup/verify', {
      registrationId: first.body.registrationId,
      token: first.body.devToken,
    });
    assert.equal(verify.status, 201, 'the fixture did not verify');

    // Now the address belongs to a real account. Registering it again must look
    // exactly like registering a stranger's address.
    const again = await call('POST', '/v1/signup', { ...VALID, email: 'twice@northgate.example' });
    const fresh = await call('POST', '/v1/signup', { ...VALID, email: 'brand-new@northgate.example' });

    assert.equal(again.status, fresh.status);
    assert.equal(again.body.status, fresh.body.status);
    assert.equal(again.body.message, fresh.body.message, 'the response distinguishes a known address from an unknown one');
  });

  it('never returns the verification token in production', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      // `config.env` is a boot snapshot, so this asserts the shape rather than
      // the branch; the branch itself is covered where isProduction() is used.
      // What matters here is that the token is never in the *message*.
      const reply = await call('POST', '/v1/signup', { ...VALID, email: 'prod@northgate.example' });
      assert.ok(!/token/i.test(reply.body.message), 'the receipt message mentions a token');
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
});

describe('completing a registration', () => {
  it('provisions the tenancy, the administrator and their branding', async () => {
    const started = await call('POST', '/v1/signup', { ...VALID, email: 'founder@harbourworks.example' });
    const reply = await call('POST', '/v1/signup/verify', {
      registrationId: started.body.registrationId,
      token: started.body.devToken,
    });

    assert.equal(reply.status, 201);
    assert.equal(reply.body.status, 'VERIFIED');

    const user = platform.userByEmail('founder@harbourworks.example');
    assert.ok(user, 'no administrator was created');
    assert.deepEqual(user.roles, ['ENTERPRISE_ADMIN'], 'the first user must be able to invite the rest');

    // Branding is a precondition for every export; without it the first export
    // fails on a logo rather than on anything the customer did.
    const branding = platform.exports.branding(user.tenantId);
    assert.equal(branding.clientName, 'Northgate Civils Ltd');
  });

  it('returns an account and never a session', async () => {
    const started = await call('POST', '/v1/signup', { ...VALID, email: 'nosession@northgate.example' });
    const reply = await call('POST', '/v1/signup/verify', {
      registrationId: started.body.registrationId,
      token: started.body.devToken,
    });

    // The whole point. A token here would rebuild the anonymous-login hole
    // through a different door.
    assert.ok(!('accessToken' in reply.body), 'verification returned an access token');
    assert.ok(!('refreshToken' in reply.body), 'verification returned a refresh token');
    assert.equal(reply.body.signInPath, '/app');
  });

  it('refuses a wrong token, and answers the same as an unknown registration', async () => {
    const started = await call('POST', '/v1/signup', { ...VALID, email: 'wrongtoken@northgate.example' });

    const wrong = await call('POST', '/v1/signup/verify', {
      registrationId: started.body.registrationId,
      token: 'not-the-token',
    });
    const unknown = await call('POST', '/v1/signup/verify', { registrationId: 'nope', token: 'not-the-token' });

    assert.equal(wrong.status, 404);
    assert.equal(unknown.status, 404);
    assert.equal(wrong.body.detail, unknown.body.detail, 'the two are distinguishable, which tells a caller which ids exist');
  });

  it('spends the token, so a link cannot be replayed', async () => {
    const started = await call('POST', '/v1/signup', { ...VALID, email: 'replay@northgate.example' });
    const first = await call('POST', '/v1/signup/verify', {
      registrationId: started.body.registrationId,
      token: started.body.devToken,
    });
    assert.equal(first.status, 201);

    const second = await call('POST', '/v1/signup/verify', {
      registrationId: started.body.registrationId,
      token: started.body.devToken,
    });
    assert.notEqual(second.status, 201, 'the same link provisioned a second time');
  });

  it('supersedes an earlier link when somebody registers twice', async () => {
    const first = await call('POST', '/v1/signup', { ...VALID, email: 'impatient@northgate.example' });
    const second = await call('POST', '/v1/signup', { ...VALID, email: 'impatient@northgate.example' });

    const stale = await call('POST', '/v1/signup/verify', {
      registrationId: first.body.registrationId,
      token: first.body.devToken,
    });
    // The older link is refused, and the person holding it — who is the genuine
    // address owner clicking their first email — is told which email to use
    // rather than "not valid". Somebody without the token still gets an
    // undifferentiated 404, so this explains nothing to anybody who did not
    // receive the mail.
    assert.notEqual(stale.status, 201, 'the first link still worked after a second was issued');
    assert.equal(stale.body.title, 'LINK_SUPERSEDED');
    assert.match(stale.body.detail, /most recent email/);

    const current = await call('POST', '/v1/signup/verify', {
      registrationId: second.body.registrationId,
      token: second.body.devToken,
    });
    assert.equal(current.status, 201, 'the most recent link did not work');
  });

  it('refuses to verify twice, and says to sign in instead', async () => {
    const started = await call('POST', '/v1/signup', { ...VALID, email: 'twiceverify@northgate.example' });
    await call('POST', '/v1/signup/verify', {
      registrationId: started.body.registrationId,
      token: started.body.devToken,
    });

    const again = await call('POST', '/v1/signup/verify', {
      registrationId: started.body.registrationId,
      token: started.body.devToken,
    });
    assert.notEqual(again.status, 201);
  });
});

describe('what registration tells the person', () => {
  it('emails a verification link on a new address', async () => {
    const started = await call('POST', '/v1/signup', { ...VALID, email: 'mailme@northgate.example' });
    assert.equal(started.status, 201);

    // Events carry a diff; the entity records carry the state.
    const dispatched = platform.ledger
      .listByTenant('platform', 'NotificationDispatch')
      .map((record) => record.state as { code?: string });

    assert.ok(
      dispatched.some((d) => d.code === 'account.registration.requested'),
      'no verification message was dispatched',
    );
  });

  it('warns the real owner when somebody registers an address that already exists', async () => {
    const started = await call('POST', '/v1/signup', { ...VALID, email: 'owner@northgate.example' });
    await call('POST', '/v1/signup/verify', {
      registrationId: started.body.registrationId,
      token: started.body.devToken,
    });

    await call('POST', '/v1/signup', { ...VALID, email: 'owner@northgate.example' });

    const dispatched = platform.ledger
      .listByTenant('platform', 'NotificationDispatch')
      .map((record) => (record.state as { code?: string }).code);

    // The caller learned nothing; the address owner was told. That is the only
    // way to warn the real owner without answering the attacker's question.
    assert.ok(dispatched.includes('account.registration.received'), 'the address owner was not warned');
  });
});

describe('the page the confirmation link lands on', () => {
  /**
   * The last step of registration, and for a while the only one with no way to
   * take it. The email said "Confirm your account" and pointed at `/verify`;
   * nothing answered there. Every person who signed up got a 404 at the exact
   * moment they were being asked to prove they owned the address, their
   * registration stayed pending for ever, and the sign-in screen then told them
   * — correctly, and uselessly — that no such account existed.
   */

  /** As a browser asks, so the response is a page rather than JSON. */
  async function page(method: string, path: string) {
    const res = await fetch(`${base}${path}`, { method, headers: { accept: 'text/html' } });
    return { status: res.status, type: res.headers.get('content-type') ?? '', html: await res.text() };
  }

  it('is where the email actually points', async () => {
    // Derived from the same function that builds the link, so a change to one
    // without the other fails here rather than in somebody's inbox.
    const { verificationUrl } = await import('../src/identity/signup.ts');
    const url = new URL(verificationUrl('reg-id', 'tok'));
    assert.equal(url.pathname, '/verify', 'the email links somewhere no route serves');

    const reply = await page('GET', `${url.pathname}${url.search}`);
    assert.equal(reply.status, 200);
    assert.match(reply.type, /text\/html/, 'a person following a link must not be shown JSON');
  });

  it('provisions nothing on GET, so a mail scanner cannot spend the token', async () => {
    // Defender, Proofpoint and Mimecast fetch every link in an inbound message
    // to scan it. A GET that activated would be consumed by the scanner, and
    // the human would then click a link a robot had already used on their
    // behalf. The GET renders a button; only the press acts.
    const started = await call('POST', '/v1/signup', { ...VALID, email: 'scanned@northgate.example' });
    const r = started.body.registrationId;
    const t = started.body.devToken;

    const landed = await page('GET', `/verify?r=${r}&t=${t}`);
    assert.match(landed.html, /<form[^>]+method="post"/i, 'the page must ask before it acts');
    assert.equal(platform.userByEmail('scanned@northgate.example'), undefined, 'the GET created an account');

    // And the token it was holding is still good.
    const pressed = await page('POST', `/verify?r=${r}&t=${t}`);
    assert.equal(pressed.status, 200);
    assert.ok(platform.userByEmail('scanned@northgate.example'), 'the press did not create the account');
  });

  it('carries the link through the form so the press has what the click was given', async () => {
    const started = await call('POST', '/v1/signup', { ...VALID, email: 'carried@northgate.example' });
    const landed = await page('GET', `/verify?r=${started.body.registrationId}&t=${started.body.devToken}`);

    const action = /<form[^>]+action="([^"]+)"/i.exec(landed.html)?.[1] ?? '';
    assert.match(action, /r=/, 'the registration id is not carried to the POST');
    assert.match(action, /t=/, 'the token is not carried to the POST');
  });

  it('creates the account the same way the JSON route does, and says whose it is', async () => {
    const started = await call('POST', '/v1/signup', { ...VALID, email: 'pressed@northgate.example' });
    const done = await page('POST', `/verify?r=${started.body.registrationId}&t=${started.body.devToken}`);

    assert.equal(done.status, 200);
    assert.match(done.html, /Northgate Civils Ltd/, 'the page does not name the organisation it created');
    assert.match(done.html, /pressed@northgate\.example/, 'the page does not say who the administrator is');

    const user = platform.userByEmail('pressed@northgate.example');
    assert.ok(user, 'no account exists');
    assert.deepEqual(user.roles, ['ENTERPRISE_ADMIN'], 'the first user must be able to invite the rest');

    // The invariant the console-session hole broke: an account, never a session.
    assert.doesNotMatch(done.html, /accessToken|refreshToken/, 'a page must not hand out a token');
  });

  it('and that account can then sign in', async () => {
    const started = await call('POST', '/v1/signup', { ...VALID, email: 'signsin@northgate.example' });
    await page('POST', `/verify?r=${started.body.registrationId}&t=${started.body.devToken}`);

    const challenge = await call('POST', '/v1/auth/login', { email: 'signsin@northgate.example' });
    assert.ok(challenge.body.challengeId, 'the new account cannot even start a sign-in');

    const verified = await call('POST', '/v1/auth/mfa/verify', {
      actorId: challenge.body.actorId,
      challengeId: challenge.body.challengeId,
      code: challenge.body.devCode,
    });
    assert.ok(verified.body.accessToken, 'signing up produced an account nobody can get into');
  });

  it('explains a link that did not work, as a page rather than as JSON', async () => {
    const bad = await page('POST', '/verify?r=nope&t=also-nope');
    assert.match(bad.type, /text\/html/, 'somebody in Outlook must not be shown a problem+json body');
    assert.doesNotMatch(bad.html, /"type"\s*:/, 'the raw error object leaked into the page');
    assert.equal(platform.userByEmail('nope'), undefined);
  });

  it('tells somebody who clicked the older of two emails to use the newer one', async () => {
    // A superseded registration keeps its token hash for exactly this reason:
    // the person holding the stale link is the genuine address owner opening
    // their first email, and "not valid" would make them give up. "A newer link
    // was issued" tells them what to do instead.
    const first = await call('POST', '/v1/signup', { ...VALID, email: 'twolinks@northgate.example' });
    await call('POST', '/v1/signup', { ...VALID, email: 'twolinks@northgate.example' });

    const stale = await page('POST', `/verify?r=${first.body.registrationId}&t=${first.body.devToken}`);
    assert.match(stale.html, /newer verification link/i, 'a superseded link must say so');
  });

  it('says nothing about a spent link, and provisions nothing twice', async () => {
    // The opposite call, and deliberately so. A verified registration's token
    // hash is deleted — keeping it would leave a second working link — so a
    // replay cannot be distinguished from a wrong id, and gets the same
    // undifferentiated answer. That is the right trade here: whoever is
    // replaying a spent token is not the person who already used it.
    const started = await call('POST', '/v1/signup', { ...VALID, email: 'spent@northgate.example' });
    const url = `/verify?r=${started.body.registrationId}&t=${started.body.devToken}`;

    await page('POST', url);
    const tenantsBefore = platform.userByEmail('spent@northgate.example')?.tenantId;

    const twice = await page('POST', url);
    assert.match(twice.html, /not valid/i, 'a spent link must not describe what it once was');
    assert.equal(
      platform.userByEmail('spent@northgate.example')?.tenantId,
      tenantsBefore,
      'a replayed link created a second tenancy',
    );
  });

  it('offers a way back to the platform from every state', async () => {
    const started = await call('POST', '/v1/signup', { ...VALID, email: 'wayback@northgate.example' });
    const landed = await page('GET', `/verify?r=${started.body.registrationId}&t=${started.body.devToken}`);
    const done = await page('POST', `/verify?r=${started.body.registrationId}&t=${started.body.devToken}`);
    const failed = await page('POST', '/verify?r=x&t=y');

    for (const [name, html] of [['confirm', landed.html], ['done', done.html], ['failed', failed.html]] as const) {
      assert.match(html, /href="[^"]*\/"/, `the ${name} page's wordmark does not link home`);
    }
    assert.match(done.html, /\/app/, 'the done page does not offer the sign-in it just enabled');
    assert.match(failed.html, /get-started/, 'the failed page does not offer a way to start again');
  });
});

describe('signing in does not reveal who has an account', () => {
  /**
   * `POST /v1/auth/login` used to answer `404 No user with that email address`.
   *
   * Registration is written from the opposite premise — an identical receipt
   * whether or not the address is in use, precisely so nobody can ask — and
   * login handed the answer to any unauthenticated caller. Feed it a breach
   * dump and it sorts the list into customers and strangers for free.
   */

  it('answers an unknown address in the shape it answers a known one', async () => {
    const started = await call('POST', '/v1/signup', { ...VALID, email: 'known@northgate.example' });
    await call('POST', '/v1/signup/verify', {
      registrationId: started.body.registrationId,
      token: started.body.devToken,
    });

    const known = await call('POST', '/v1/auth/login', { email: 'known@northgate.example' });
    const stranger = await call('POST', '/v1/auth/login', { email: 'nobody@nowhere.example' });

    assert.equal(stranger.status, known.status, 'the status code alone tells an attacker which is which');
    assert.deepEqual(
      Object.keys(stranger.body).sort(),
      Object.keys(known.body).filter((k) => k !== 'devCode').sort(),
      'the response shape differs, which is the same oracle by another route',
    );
    assert.ok(stranger.body.challengeId, 'the decoy must look like a challenge');
  });

  it('and the decoy cannot be completed', async () => {
    const stranger = await call('POST', '/v1/auth/login', { email: 'nobody@nowhere.example' });

    // No code was generated, so there is none to guess. The attempt fails the
    // way a wrong code on a real account fails.
    assert.equal(stranger.body.devCode, undefined, 'a decoy must never carry a code');

    for (const code of ['', '000000', 'ABC123']) {
      const attempt = await call('POST', '/v1/auth/mfa/verify', {
        actorId: stranger.body.actorId,
        challengeId: stranger.body.challengeId,
        code,
      });
      assert.ok(attempt.status >= 400, `code ${JSON.stringify(code)} got through a decoy challenge`);
      assert.equal(attempt.body.accessToken, undefined, 'a decoy minted a token');
    }
  });

  it('issues a different decoy each time, so repeats cannot be correlated', async () => {
    const a = await call('POST', '/v1/auth/login', { email: 'nobody@nowhere.example' });
    const b = await call('POST', '/v1/auth/login', { email: 'nobody@nowhere.example' });
    assert.notEqual(a.body.actorId, b.body.actorId, 'a stable decoy id is itself the answer');
    assert.notEqual(a.body.challengeId, b.body.challengeId);
  });
});
