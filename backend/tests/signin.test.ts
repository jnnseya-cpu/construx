import assert from 'node:assert/strict';
import { createServer, type Server as TcpServer } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

/**
 * Signing in to a production deployment.
 *
 * This exists because it did not work, and nothing caught it. Every credential
 * could be correct and no human being could get in.
 *
 * Three things combined. The console offered only the demonstration identity
 * picker, which reads `devCode` straight out of the login response. That code
 * is deliberately withheld in production. And nothing ever *sent* it — the
 * challenge was generated, held in memory, and returned to nobody. The visible
 * symptom was the front page of a working platform saying "Could not reach the
 * platform: Demonstration identities are not available in production", which
 * reads as an outage and was actually the security gate doing its job.
 *
 * The suite otherwise runs outside production, where `devCode` is returned and
 * the whole path is trivially satisfiable — which is exactly why this needs its
 * own file with its own environment. `isProduction()` is read fresh on every
 * call, so the flag can be flipped here; `config` is not, so the mail server
 * has to be configured before the platform is imported at all.
 */

// ------------------------------------------------------------ fake mail server

const received: string[] = [];

/**
 * Minimal SMTP, so the code is verified as having reached a socket rather than
 * as having been passed to a mock of one.
 */
const smtp: TcpServer = createServer((socket) => {
  let dataMode = false;
  let message = '';
  socket.setEncoding('utf8');
  socket.write('220 test.construx ESMTP\r\n');

  socket.on('data', (chunk: string) => {
    if (dataMode) {
      message += chunk;
      if (message.includes('\r\n.\r\n')) {
        dataMode = false;
        received.push(message.slice(0, message.indexOf('\r\n.\r\n')));
        message = '';
        socket.write('250 2.0.0 Ok: queued as TEST\r\n');
      }
      return;
    }
    for (const line of chunk.split('\r\n').filter(Boolean)) {
      const verb = line.split(' ')[0]?.toUpperCase();
      if (verb === 'EHLO' || verb === 'HELO') socket.write('250-test.construx\r\n250 AUTH PLAIN LOGIN\r\n');
      else if (verb === 'AUTH') socket.write('235 2.7.0 Authentication successful\r\n');
      else if (verb === 'MAIL' || verb === 'RCPT') socket.write('250 2.1.0 Ok\r\n');
      else if (verb === 'DATA') {
        dataMode = true;
        socket.write('354 End data\r\n');
      } else if (verb === 'QUIT') {
        socket.write('221 2.0.0 Bye\r\n');
        socket.end();
      } else socket.write('250 2.0.0 Ok\r\n');
    }
  });
});

await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', () => resolve()));

process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String((smtp.address() as { port: number }).port);
process.env.SMTP_SECURE = 'false';
process.env.SMTP_REQUIRE_TLS = 'false';
process.env.SMTP_USER = 'contact@construx.test';
process.env.SMTP_PASS = 'not-a-real-password';
process.env.NEWSLETTER_FROM_ADDRESS = 'contact@construx.test';

// Imported only now, so the snapshot they take includes the settings above.
const { Platform } = await import('../src/platform.ts');
const { createGateway } = await import('../src/api/gateway.ts');

// ------------------------------------------------------------------- harness

let platform: InstanceType<typeof Platform>;
let server: Server;
let base: string;
let email: string;

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

/** The most recent message, unfolded. Soft line breaks split long URLs and codes. */
function lastMessage(): string {
  return (received.at(-1) ?? '').replace(/=\r?\n/g, '');
}

before(async () => {
  platform = new Platform();
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  // A real tenancy with a real administrator, created the way activation
  // creates one, rather than through the demonstration seed.
  const { tenant } = platform.createTenant({
    legalName: 'Meridian Works Ltd',
    jurisdiction: 'GB',
    defaultCurrency: 'GBP',
    tier: 'BUSINESS',
    enterpriseName: 'Meridian Group',
  });
  const user = platform.createUser({
    tenantId: tenant.id,
    name: 'Rowan Blake',
    email: 'rowan@meridian.test',
    roles: ['ENTERPRISE_ADMIN'],
  });
  email = user.email;

  process.env.NODE_ENV = 'production';
  // Explicitly off. The demonstration tenancy now defaults to on, and this file
  // is about a *real* customer signing in on a deployment that offers no
  // demonstration — which is the case the whole SMTP path exists for.
  process.env.DEMO_TENANCY_ENABLED = 'false';
});

after(() => {
  process.env.NODE_ENV = 'test';
  delete process.env.DEMO_TENANCY_ENABLED;
  server.close();
  smtp.close();
});

// --------------------------------------------------------------------- tests

describe('a production deployment lets a real person sign in', () => {
  let challenge: { actorId: string; challengeId: string; devCode?: string };

  it('withholds the code from the response', async () => {
    received.length = 0;
    const reply = await call('POST', '/v1/auth/login', { email });

    assert.ok([200, 201].includes(reply.status), `login answered ${reply.status}`);
    assert.ok(reply.body.challengeId, 'a challenge is issued');
    assert.equal(reply.body.devCode, undefined, 'the code must never be handed to the browser in production');
    challenge = reply.body;
  });

  it('sends the code to the person instead', async () => {
    // The defect: it was withheld from the response and sent nowhere, so the
    // code existed only in the server's memory and sign-in was impossible.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(received.length, 1, 'exactly one message, to the person signing in');

    const message = lastMessage();
    assert.match(message, /rowan@meridian\.test/, 'addressed to the account holder');
    assert.match(message, /[A-F0-9]{6}/, 'carries a six-character code');
  });

  it('mints a token when that code is presented', async () => {
    const code = /verification code is ([A-F0-9]{6})/i.exec(lastMessage())?.[1];
    assert.ok(code, 'the code is stated in a form a person can read and retype');

    const verified = await call('POST', '/v1/auth/mfa/verify', {
      actorId: challenge.actorId,
      challengeId: challenge.challengeId,
      code,
    });

    assert.ok([200, 201].includes(verified.status), `verify answered ${verified.status}`);
    assert.ok(verified.body.accessToken, 'a token is issued');
    assert.deepEqual(verified.body.user.roles, ['ENTERPRISE_ADMIN'], 'signed in as the administrator');

    // The token has to actually work, or the sign-in was theatre.
    const projects = await call('GET', '/v1/projects', undefined, verified.body.accessToken);
    assert.equal(projects.status, 200, 'the token authorises a real request');
  });

  it('refuses a code that was not the one sent', async () => {
    const reply = await call('POST', '/v1/auth/login', { email });
    const wrong = await call('POST', '/v1/auth/mfa/verify', {
      actorId: reply.body.actorId,
      challengeId: reply.body.challengeId,
      code: 'ABC123',
    });
    assert.ok(wrong.status >= 400, 'a guessed code must not mint a token');
  });
});

describe('the demonstration doors stay shut where no demonstration is offered', () => {
  // These are what the console used to depend on entirely. The sign-in path
  // must not need them, and on a deployment with the demonstration switched
  // off they are refused outright. `/v1/console/session` is refused in
  // production whatever the switch says — see demotenancy.test.ts.
  it('refuses the demonstration identities', async () => {
    assert.equal((await call('POST', '/v1/console/identities')).status, 403);
  });

  it('refuses the demonstration session', async () => {
    assert.equal((await call('POST', '/v1/console/session')).status, 403);
  });
});
