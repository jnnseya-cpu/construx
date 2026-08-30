import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { ROUTES } from '../src/api/routes.ts';
import { POST_PAGES, SITE_PAGES } from '../src/site/index.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The gateway, over real HTTP.
 *
 * Everything else in this suite tests a module by calling it. This one goes
 * through the socket, because the gateway is where authentication, rate
 * limiting, body parsing, idempotency and the problem+json contract actually
 * happen — none of which a direct call to a handler exercises.
 *
 * It exists because the 117-route surface had no automated coverage at all.
 * Every capability boundary in the platform is reachable through here, so a
 * regression in this file is a security regression, not a broken feature.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;

/** A bearer token for a seeded identity. */
function tokenFor(who: string): string {
  const user = platform.user(seed.users[who]!.id);
  return issueTokens({
    actorId: user.id,
    tenantId: user.tenantId,
    partyId: user.partyId,
    roles: user.roles,
    mfaSatisfied: true,
  }).accessToken;
}

type Reply = { status: number; body: any; headers: Headers; text: string };

async function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; raw?: string; contentType?: string; acceptLanguage?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.acceptLanguage) headers['accept-language'] = options.acceptLanguage;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.contentType) headers['content-type'] = options.contentType;

  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });

  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, body, headers: response.headers, text };
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

describe('the routing table itself', () => {
  it('declares no duplicate method and path', () => {
    const seen = new Set<string>();
    for (const route of ROUTES) {
      const key = `${route.method} ${route.pattern}`;
      assert.ok(!seen.has(key), `${key} is declared twice — the first one wins silently`);
      seen.add(key);
    }
  });

  it('gives every route a description, because /v1/routes is the API documentation', () => {
    for (const route of ROUTES) {
      assert.ok(route.description?.length > 10, `${route.method} ${route.pattern} has no usable description`);
    }
  });

  it('keeps the public surface to the short list it is supposed to be', () => {
    // A route becoming public by accident is the single worst edit anyone can
    // make to this file, and it is one word long. Pin the list.
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
      // A post published from the console rather than compiled into the build.
      // It is the same class of thing as the six above — public,
      // server-rendered, no API surface — but it cannot be derived from
      // POST_PAGES because it did not exist when that list was built, so it is
      // one pattern and is named here. `site.render` serves only a post whose
      // status is PUBLISHED, so a draft is not reachable by guessing its
      // address, and that refusal is tested.
      'GET /blog/:slug',
      'GET /healthz',
      'GET /readyz',
      'GET /unsubscribe',
      // Public so a signed evidence link works without a session, which is the
      // only thing a signed link is for. The route is public; the *object* is
      // not — the handler demands either an HMAC over tenant, hash and expiry,
      // or an authenticated identity with EVIDENCE_AUDIT read on the project
      // the evidence belongs to. Refused either way, and the refusal is tested.
      // Slots for a guided walkthrough. Public because the entire point is that
      // somebody who has never signed in can book one, and it discloses nothing
      // about anybody: a taken slot is simply absent from the list, so the
      // response cannot be read as a diary of who the company is meeting.
      'GET /v1/booking/availability',
      'GET /v1/evidence/:hash',
      'GET /v1/signup/account-types',
      // The confirmation link in a signup email lands here. Public because the
      // person has no account yet, and inert on GET so a mail scanner cannot
      // spend the single-use token before its owner clicks.
      'GET /verify',
      // The demonstration page, re-rendered with the outcome of a booking on
      // it. A POST rather than a fetch because the booking form has to work
      // with scripting switched off: the public site's only script opens the
      // mobile menu, and a form that needed JavaScript would be the first thing
      // on these pages that did. It goes through the same booking code as
      // `POST /v1/booking` and returns HTML instead of JSON.
      'POST /demo',
      'POST /unsubscribe',
      'POST /v1/auth/login',
      'POST /v1/auth/mfa/verify',
      'POST /v1/auth/refresh',
      // Booking one. Public for the same reason, and it creates a record rather
      // than an account — a stranger's name and address, not an identity that
      // can sign in. Rate limited by the gateway like every other public route.
      'POST /v1/booking',
      'POST /v1/console/identities',
      'POST /v1/console/session',
      'POST /v1/signup',
      'POST /v1/signup/verify',
      // The mobile-money rail. Same arrangement as the card one below: KODA
      // holds no credential of ours, so the HMAC over the raw body is the
      // credential. It signs no timestamp, so there is no tolerance window to
      // fall back on and replay is stopped by the payment reference alone.
      'POST /v1/webhooks/koda',
      // Stripe cannot hold a credential of ours either, so the payment
      // notification arrives unauthenticated and the signature stands in: an
      // HMAC over the exact bytes received, checked in constant time inside a
      // tolerance window, before a single field of the body is read. Everything
      // the route does with money — the amount, the currency, the paid flag —
      // comes out of the object Stripe signed.
      'POST /v1/webhooks/stripe',
      // The button on that page: the same activation, answering with a page
      // rather than JSON because the caller is a browser, not a client.
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
});

describe('authentication', () => {
  it('refuses an unauthenticated request to a protected route', async () => {
    const reply = await call('GET', '/v1/newsletter/audience');
    assert.equal(reply.status, 401);
  });

  it('refuses a forged token', async () => {
    const good = tokenFor('pm');
    // Flip the last character of the signature; everything else stays valid.
    const forged = good.slice(0, -1) + (good.at(-1) === 'a' ? 'b' : 'a');

    const reply = await call('GET', `/v1/projects/${seed.projectId}/entities/Task`, { token: forged });
    assert.equal(reply.status, 401);
  });

  it('lets the health probes through without a token', async () => {
    for (const path of ['/healthz', '/readyz']) {
      const reply = await call('GET', path);
      assert.equal(reply.status, 200, `${path} should be public`);
    }
  });
});

describe('the error contract', () => {
  it('answers with RFC 7807 problem+json, not a bare string', async () => {
    const reply = await call('GET', `/v1/projects/${seed.projectId}/entities/NoSuchType`, { token: tokenFor('pm') });

    assert.ok(reply.status >= 400);
    assert.match(reply.headers.get('content-type') ?? '', /json/);
    assert.ok(reply.body.title, 'a problem document must carry a title');
    assert.ok(reply.body.status, 'a problem document must carry a status');
    assert.equal(reply.body.status, reply.status, 'the document and the response disagree on the status');
  });

  it('carries a correlation id on every response, so a failure is traceable', async () => {
    const ok = await call('GET', '/healthz');
    const bad = await call('GET', '/v1/nothing-here', { token: tokenFor('pm') });

    for (const reply of [ok, bad]) {
      assert.ok(reply.headers.get('x-correlation-id'), 'no correlation id on the response');
      assert.ok(reply.headers.get('x-trace-id'), 'no trace id on the response');
    }
  });

  it('never caches an authorised response at an intermediary', async () => {
    const reply = await call('GET', '/v1/permissions/matrix', { token: tokenFor('pm') });
    assert.equal(reply.headers.get('cache-control'), 'no-store');
    assert.equal(reply.headers.get('x-content-type-options'), 'nosniff');
  });

  it('rejects a body that is not JSON rather than guessing', async () => {
    const reply = await call('POST', '/v1/auth/login', { raw: '{not json', contentType: 'application/json' });
    assert.equal(reply.status, 400);
  });
});

describe('authorisation is enforced at the edge, not only in the engines', () => {
  it('refuses the operator layer to a project user', async () => {
    for (const path of ['/v1/newsletter/audience', '/v1/newsletter/campaigns', '/v1/admin/tenants']) {
      const reply = await call('GET', path, { token: tokenFor('qs') });
      assert.equal(reply.status, 403, `${path} should be operator-only`);
    }
  });

  it('refuses project data to the platform operator', async () => {
    // The operator runs the business and is deliberately blind to delivery.
    // Refused on the account layer, before anything looks for a wallet.
    const reply = await call('GET', `/v1/projects/${seed.projectId}/programme`, { token: tokenFor('operator') });
    assert.equal(reply.status, 403, `operator reached project data with ${reply.status}`);
    // The machine-readable code travels as `title`; `detail` carries the prose.
    // The browser client reads it the same way, so this pins the contract.
    assert.equal(reply.body.title, 'ACCOUNT_LAYER_SEPARATION');
  });

  it('is deliberately quiet about a project the caller cannot see', async () => {
    // Not an error: a 404 for unknown and a 403 for forbidden would together
    // tell an attacker which project ids exist. An empty list tells them
    // nothing, and is the same answer for both cases.
    const missing = await call('GET', '/v1/projects/does-not-exist/entities/Task', { token: tokenFor('pm') });
    assert.equal(missing.status, 200);
    assert.deepEqual(missing.body.entities, []);
  });

  it('withholds a commercial record from the regulator through the generic entity read', async () => {
    // The generic read is the one endpoint that can return any record in the
    // system. Without classification it would bypass every other boundary.
    const regulator = await call('GET', `/v1/projects/${seed.projectId}/entities/CVR`, { token: tokenFor('regulator') });
    const qs = await call('GET', `/v1/projects/${seed.projectId}/entities/CVR`, { token: tokenFor('qs') });

    assert.equal(regulator.status, 403, 'the regulator read a cost-value reconciliation');
    assert.equal(qs.status, 200, 'the quantity surveyor cannot read their own CVR');
  });

  it('refuses an entity type that has never been classified', async () => {
    // An unmapped type must not be readable — that is what makes the
    // classification map safe to extend.
    const reply = await call('GET', `/v1/projects/${seed.projectId}/entities/NotAThing`, { token: tokenFor('pm') });
    assert.ok(reply.status === 403 || reply.status === 404, `unclassified type answered ${reply.status}`);
  });

  it('withholds the patch but keeps the envelope on the audit feed', async () => {
    const regulator = await call('GET', `/v1/projects/${seed.projectId}/audit/events`, { token: tokenFor('regulator') });
    assert.equal(regulator.status, 200);

    const events = regulator.body.events ?? regulator.body.entries ?? [];
    assert.ok(events.length > 0, 'the regulator sees no audit trail at all');

    const withheld = events.filter((e: any) => e.diff === undefined || e.withheld);
    assert.ok(withheld.length > 0, 'nothing was withheld from a regulator reading the whole feed');
    for (const event of events) {
      assert.ok(event.eventType || event.type, 'the envelope must survive even when the patch is withheld');
    }
  });
});

describe('tenant isolation on the generic entity read', () => {
  /**
   * The endpoint that can return any record in the system is the one worth
   * proving. An earlier version of this test asked for an entity type the
   * caller had no capability on, so it was refused before the tenant filter
   * was ever reached — it passed without testing anything. This one uses a
   * type the caller may freely read, so only the tenant boundary can stop it.
   */
  let rivalProject: string;
  let rivalToken: string;

  before(() => {
    const other = platform.createTenant({
      legalName: 'Rival Contracting Ltd',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'TEAM',
      enterpriseName: 'Rival Group',
    });
    const rivalPm = platform.createUser({
      tenantId: other.tenant.id,
      name: 'Rival PM',
      email: 'pm@rival.example',
      roles: ['PM'],
    });
    rivalToken = issueTokens({
      actorId: rivalPm.id,
      tenantId: rivalPm.tenantId,
      roles: rivalPm.roles,
      mfaSatisfied: true,
    }).accessToken;

    rivalProject = `${other.tenant.id}-scheme`;
    platform.ledger.commit({
      tenantId: other.tenant.id,
      projectId: rivalProject,
      actor: { refType: 'User', refId: rivalPm.id },
      source: 'WEB',
      correlationId: 'isolation-test',
      eventType: 'PROJECT_CREATED',
      entity: { refType: 'Project', refId: rivalProject },
      nextState: { id: rivalProject, name: 'RIVAL CONFIDENTIAL SCHEME', phase: 'CONSTRUCTION', sector: 'BUILDING' },
    });
  });

  it('shows a tenant its own record', async () => {
    const own = await call('GET', `/v1/projects/${rivalProject}/entities/Project`, { token: rivalToken });
    assert.equal(own.status, 200);
    assert.equal(own.body.entities.length, 1, 'the owning tenant cannot see its own project');
  });

  it('shows another tenant nothing at all, on a type it is fully entitled to read', async () => {
    const across = await call('GET', `/v1/projects/${rivalProject}/entities/Project`, { token: tokenFor('pm') });

    assert.equal(across.status, 200);
    assert.deepEqual(across.body.entities, [], 'a project manager read across the tenant boundary');
    assert.ok(!across.text.includes('RIVAL CONFIDENTIAL'), 'another tenant\'s data appeared in the response');
  });
});

describe('the newsletter surface', () => {
  it('lets the operator see the audience and refuses everyone else', async () => {
    const operator = await call('GET', '/v1/newsletter/audience', { token: tokenFor('operator') });
    assert.equal(operator.status, 200);
    assert.ok(typeof operator.body.recipientCount === 'number');
    // Addresses belong in the delivery log, behind its own read — not in a summary.
    assert.equal(operator.body.recipients, undefined, 'the audience summary leaked addresses');
  });

  it('lets a person read and set their own preference', async () => {
    const token = tokenFor('planner');

    const before = await call('GET', '/v1/me/newsletter', { token });
    assert.equal(before.status, 200);
    assert.equal(typeof before.body.subscribed, 'boolean');

    const set = await call('POST', '/v1/me/newsletter', { token, body: { subscribed: false } });
    assert.equal(set.status, 201);

    const after = await call('GET', '/v1/me/newsletter', { token });
    assert.equal(after.body.subscribed, false);
    assert.equal(after.body.source, 'PREFERENCE_PAGE');
  });

  it('validates the preference body rather than accepting anything', async () => {
    const reply = await call('POST', '/v1/me/newsletter', {
      token: tokenFor('planner'),
      body: { subscribed: 'yes please' },
    });
    assert.equal(reply.status, 400);
  });
});

describe('the unsubscribe link, which a mail client follows', () => {
  /** The signed link as it appears in a real issue. */
  async function linkFor(who: string): Promise<string> {
    const preview = await call('GET', '/v1/me/newsletter', { token: tokenFor(who) });
    const match = /href="([^"]*\/unsubscribe\?[^"]*)"/.exec(preview.body.preview.html);
    assert.ok(match, 'the rendered email carries no unsubscribe link');
    return match[1]!.replace('&amp;', '&').replace(/^https?:\/\/[^/]+/, '');
  }

  it('answers a browser with HTML, not JSON', async () => {
    const reply = await call('GET', await linkFor('bim'));

    assert.equal(reply.status, 200);
    assert.match(reply.headers.get('content-type') ?? '', /text\/html/);
    assert.match(reply.text, /<!doctype html>/i);
    // A page served to a signed-out browser must not be allowed to load anything.
    assert.match(reply.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  });

  it('does not act on the GET, so a link prefetch cannot unsubscribe anybody', async () => {
    const token = tokenFor('bim');
    const link = await linkFor('bim');

    await call('GET', link);
    const after = await call('GET', '/v1/me/newsletter', { token });
    assert.notEqual(after.body.subscribed, false, 'a GET unsubscribed the user');
  });

  it('honours a one-click POST with the form body a mail provider sends', async () => {
    const token = tokenFor('bim');
    const link = await linkFor('bim');

    const reply = await call('POST', link, {
      raw: 'List-Unsubscribe=One-Click',
      contentType: 'application/x-www-form-urlencoded',
    });

    assert.equal(reply.status, 200, 'the one-click POST was refused');
    assert.match(reply.headers.get('content-type') ?? '', /text\/html/);

    const after = await call('GET', '/v1/me/newsletter', { token });
    assert.equal(after.body.subscribed, false);
    assert.equal(after.body.source, 'UNSUBSCRIBE_LINK');
  });

  it('refuses a forged token with the same answer as an unknown user', async () => {
    const forged = await call('GET', `/unsubscribe?u=${seed.users.pm!.id}&t=not-a-signature`);
    const unknown = await call('GET', '/unsubscribe?u=nobody&t=not-a-signature');

    assert.equal(forged.status, 400);
    assert.equal(unknown.status, 400);
  });
});

describe('the agent surface', () => {
  it('publishes the fleet so the interface never hardcodes the roster', async () => {
    const reply = await call('GET', '/v1/agents', { token: tokenFor('pm') });

    assert.equal(reply.status, 200);
    assert.ok(reply.body.agents.length >= 8);
    for (const agent of reply.body.agents) {
      assert.ok(agent.approvers.length > 0, `${agent.name} publishes no approvers`);
      // An ACT ceiling is published as eligibility, and the published record
      // has to say what such a grant could ever cover — otherwise the interface
      // shows a machine with unattended authority and no stated bound.
      if (agent.maxUnattended === 'ACT') {
        assert.ok(agent.envelope, `${agent.name} advertises unattended authority with no declared envelope`);
        assert.ok(agent.envelope.commands.length > 0);
      }
      // Running or declared, never silently absent.
      assert.ok(['DEPLOYED', 'DECLARED'].includes(agent.deployment), `${agent.name} publishes no deployment state`);
      if (agent.deployment === 'DECLARED') {
        assert.ok(agent.needs, `${agent.name} is published as declared without saying what it needs`);
      }
    }
  });

  it('refuses a fleet run to a role without AI execution', async () => {
    const reply = await call('POST', `/v1/projects/${seed.projectId}/agents/run`, {
      token: tokenFor('regulator'),
      body: {},
    });
    assert.equal(reply.status, 403);
  });
});

describe('the interface is given the rules rather than holding them', () => {
  it('publishes the permission matrix and the phase gates', async () => {
    const matrix = await call('GET', '/v1/permissions/matrix', { token: tokenFor('pm') });
    const gates = await call('GET', '/v1/lifecycle/gates', { token: tokenFor('pm') });

    assert.equal(matrix.status, 200);
    assert.ok(matrix.body.matrix?.PM ?? matrix.body.PM, 'the matrix does not describe the PM role');
    assert.equal(gates.status, 200);
  });

  it('publishes the route table as its own documentation', async () => {
    const reply = await call('GET', '/v1/routes');
    assert.equal(reply.status, 200);
    assert.equal(reply.body.routes.length, ROUTES.length);
  });

  it('never exposes a provider credential through the control plane', async () => {
    const reply = await call('GET', '/v1/ai/control-plane', { token: tokenFor('pm') });

    assert.equal(reply.status, 200);
    const serialised = JSON.stringify(reply.body).toLowerCase();
    for (const secret of ['sk-', 'apikey', 'api_key', 'secret', 'password', 'token']) {
      assert.ok(!serialised.includes(secret), `the control plane response mentions "${secret}"`);
    }
  });
});

describe('localisation is resolved at the edge, from what the device sent', () => {
  it('answers in the locale the request asked for', async () => {
    const reply = await call('GET', '/v1/localisation', {
      token: tokenFor('pm'),
      acceptLanguage: 'fr-CA,fr;q=0.9,en;q=0.8',
    });

    assert.equal(reply.status, 200);
    assert.equal(reply.body.locale, 'fr-CA');
  });

  it('falls back rather than failing on a header a client made up', async () => {
    // The tag reaches a formatter that would throw. A request must not 500
    // because somebody sent an odd string.
    const reply = await call('GET', '/v1/localisation', {
      token: tokenFor('pm'),
      acceptLanguage: 'not a language tag at all!!',
    });

    assert.equal(reply.status, 200);
    assert.equal(reply.body.locale, 'en-GB');
  });

  it('publishes the currency exponents rather than assuming two everywhere', async () => {
    const reply = await call('GET', '/v1/localisation', { token: tokenFor('pm') });
    const byCode = new Map(reply.body.currencies.map((c: { code: string; exponent: number }) => [c.code, c.exponent]));

    assert.equal(byCode.get('GBP'), 2);
    assert.equal(byCode.get('JPY'), 0);
    assert.equal(byCode.get('KWD'), 3);
  });

  it('is not a public route', async () => {
    // Reference data, but tenant-facing. A route becoming public by accident is
    // a one-word edit, so this is asserted rather than trusted.
    const reply = await call('GET', '/v1/localisation');
    assert.equal(reply.status, 401);
  });
});

/**
 * The console shell, which was the one response on this server that wrote its
 * own head. It carried a trace id and a cache directive and nothing else — no
 * policy, no frame refusal, no nosniff — while every other page went through
 * `sendHtml` and got all three. Found by reading the headers of a running
 * server rather than by a test, because no test asked.
 *
 * Framing is the one that matters. The buttons in this shell certify payments
 * and approve baselines; a page that can put it in an invisible iframe can have
 * somebody else press them.
 */
describe('the application shell', () => {
  it('refuses to be framed and declares a policy', async () => {
    const reply = await call('GET', '/app');
    assert.equal(reply.status, 200);

    const csp = reply.headers.get('content-security-policy') ?? '';
    assert.match(csp, /frame-ancestors 'none'/, 'the console can be framed');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/, 'the shell would run inline script');
    // The client calls this origin. Anything else is exfiltration.
    assert.match(csp, /connect-src 'self'/);
    assert.equal(reply.headers.get('x-content-type-options'), 'nosniff');
  });

  it('is revalidated rather than never stored, so navigation is not a re-download', async () => {
    const reply = await call('GET', '/app/overview');
    assert.equal(reply.headers.get('cache-control'), 'no-cache');
  });
});

/**
 * Trace identifiers arrive from the client and are written straight back out as
 * a response header and into every log line. Unchecked, a value carrying CR or
 * LF is refused by `writeHead` and turns the request into a 500, and a value of
 * arbitrary length sits on every log record the caller generates.
 */
describe('inbound trace headers', () => {
  async function traceOf(sent: string): Promise<string> {
    const response = await fetch(`${base}/healthz`, { headers: { 'x-trace-id': sent } });
    await response.text();
    return response.headers.get('x-trace-id') ?? '';
  }

  it('propagates a well-formed trace so a request can be followed', async () => {
    assert.equal(await traceOf('edge-7f3a_b21.4'), 'edge-7f3a_b21.4');
  });

  it('replaces one carrying a header separator instead of failing the request', async () => {
    // `fetch` rejects a raw CR/LF in a header value, so the injection is tried
    // in its encoded form — which is what reaches a log file as text anyway.
    const echoed = await traceOf('abc%0d%0aX-Injected:%201');
    assert.notEqual(echoed, 'abc%0d%0aX-Injected:%201');
    assert.match(echoed, /^[0-9a-f-]{36}$/, 'expected a freshly minted uuid');
  });

  it('replaces an oversized trace rather than carrying it on every log line', async () => {
    const echoed = await traceOf('a'.repeat(4096));
    assert.match(echoed, /^[0-9a-f-]{36}$/);
  });
});

/**
 * A route schema that disagrees with the command behind it.
 *
 * This was found by running a real business through the platform rather than
 * by a test: `enforcementNotices` was declared `integer` on the prequalify
 * route while `assessPrequalification` reads each notice's type, date and
 * whether it was resolved. So a caller who sent the field as the schema
 * documented it got `500 INTERNAL_ERROR`, and one who sent what the command
 * actually reads was refused at the door. Either way an unresolved HSE
 * prohibition notice — which is a bar, and the most serious thing on the whole
 * assessment — could not be recorded at all.
 *
 * Both directions are asserted, because fixing only the crash would leave the
 * bar unreachable and the route would still look like it worked.
 */
describe('the prequalification schema and the assessment agree', () => {
  const supplier = async (partyId: string): Promise<string> => {
    const created = await call('POST', '/v1/supply-chain/suppliers', {
      token: tokenFor('pm'),
      body: {
        partyId,
        legalName: 'Katanga Power Services SARL',
        trades: ['ELECTRICAL'],
        contactName: 'Chef de site',
        contactEmail: 'ops@katangapower.example',
        countryCode: 'CD',
      },
    });
    assert.equal(created.status, 201, created.text);
    return created.body.supplierId;
  };

  const assessment = (over: Record<string, unknown>) => ({
    identity: { companyNumber: 'CD-99231', cisStatus: 'NET_20' },
    insurances: [
      { type: 'PUBLIC_LIABILITY', insurer: 'SONAS', limitMinor: 500_000_00, expiresOn: '2027-06-30' },
      { type: 'EMPLOYERS_LIABILITY', insurer: 'SONAS', limitMinor: 1_000_000_00, expiresOn: '2027-06-30' },
    ],
    safetyAccreditations: ['CHAS'],
    qualityAccreditations: ['ISO 9001'],
    riddorLastThreeYears: 0,
    capacity: { concurrentProjects: 3, turnoverMinor: 2_000_000_00 },
    complianceConfirmed: true,
    evidenceHash: 'a'.repeat(64),
    packageValueMinor: 15_000_00,
    ...over,
  });

  it('bars a supplier carrying an unresolved prohibition notice', async () => {
    // The regulator stopped them working. Nothing else on the assessment
    // matters, and the platform has to be able to hear it.
    const reply = await call('POST', `/v1/supply-chain/suppliers/${await supplier('SUP-PROHIBITED')}/prequalify`, {
      token: tokenFor('pm'),
      body: assessment({
        enforcementNotices: [{ type: 'PROHIBITION', issuedOn: '2026-03-04', resolved: false }],
      }),
    });

    assert.equal(reply.status, 201, reply.text);
    assert.equal(reply.body.status, 'DO_NOT_USE');
    assert.ok(
      (reply.body.bars as string[]).some((bar) => /prohibition notice/i.test(bar)),
      `the prohibition notice was accepted and then ignored: ${JSON.stringify(reply.body.bars)}`,
    );
  });

  it('does not turn a resolved notice into a bar', async () => {
    const reply = await call('POST', `/v1/supply-chain/suppliers/${await supplier('SUP-RESOLVED')}/prequalify`, {
      token: tokenFor('pm'),
      body: assessment({
        enforcementNotices: [{ type: 'PROHIBITION', issuedOn: '2024-01-09', resolved: true }],
      }),
    });

    assert.equal(reply.status, 201, reply.text);
    assert.ok(
      !(reply.body.bars as string[]).some((bar) => /prohibition notice/i.test(bar)),
      'a notice the regulator has closed was still treated as a bar',
    );
  });

  it('refuses a count where notices belong, rather than failing inside the command', async () => {
    // The shape that used to produce a 500. A refusal at the door is the
    // contract; an internal error tells the caller nothing and pages somebody.
    const reply = await call('POST', `/v1/supply-chain/suppliers/${await supplier('SUP-COUNTED')}/prequalify`, {
      token: tokenFor('pm'),
      body: assessment({ enforcementNotices: 2 }),
    });

    assert.equal(reply.status, 400, reply.text);
    assert.equal(reply.body.title, 'VALIDATION_FAILED');
  });
});

/**
 * A path naming a project that is not a project.
 *
 * Found by running a business through the platform: a client interpolated
 * `undefined` into the URL and `POST /v1/projects/undefined/integration`
 * returned **201**, writing a priced commercial account — contract sum, margin,
 * contingency — into a ledger scope no project owns. The ledger is append-only,
 * so a record filed that way cannot afterwards be removed. It is invisible to
 * every project listing and readable only by repeating the same wrong URL, so
 * nobody would find it either.
 *
 * `projectContext` checked that the path *had* a project segment, never that it
 * named one. Handlers that happened to call `ledger.require` themselves were
 * safe; the rest were not, and which was which was invisible from the outside.
 * The check belongs at the funnel all 565 project-scoped routes pass through.
 */
describe('a project-scoped path has to name a real project', () => {
  it('refuses a write against a project that does not exist', async () => {
    const reply = await call('POST', '/v1/projects/NO-SUCH-PROJECT/integration', {
      token: tokenFor('qs'),
      body: { directSupplierCostMinor: 500_000_00, model: 'ADVISORY' },
    });

    assert.equal(reply.status, 404, `a commercial account was written to a phantom project: ${reply.text}`);
  });

  it('refuses the literal string a broken client interpolates', async () => {
    // The exact shape that produced the record. Worth its own case: `undefined`
    // is what a template writes when the id it was given was missing, and it is
    // the one wrong value a real client actually sends.
    const reply = await call('POST', '/v1/projects/undefined/integration', {
      token: tokenFor('qs'),
      body: { directSupplierCostMinor: 500_000_00, model: 'ADVISORY' },
    });

    assert.equal(reply.status, 404, reply.text);
  });

  it('refuses a read against one too, rather than answering emptily', async () => {
    // An empty answer for a project that does not exist is indistinguishable
    // from an empty answer for one that does, which is how a mistyped id gets
    // read as "nothing has happened yet".
    const reply = await call('GET', '/v1/projects/NO-SUCH-PROJECT/integration', { token: tokenFor('qs') });
    assert.equal(reply.status, 404, reply.text);
  });

  it('still serves a project that does exist', async () => {
    // The guard must not be a wall. Without this the other three would pass on
    // a `projectContext` that refused everything.
    const reply = await call('GET', `/v1/projects/${seed.projectId}/integration`, { token: tokenFor('qs') });
    assert.equal(reply.status, 200, reply.text);
  });
});
