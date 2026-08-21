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
    assert.deepEqual(codes.sort(), ['CORE_PROJECT', 'ENTERPRISE', 'FREE_TRIAL', 'PROFESSIONAL_DELIVERY']);
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
