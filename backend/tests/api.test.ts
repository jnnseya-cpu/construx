import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { rateLimiter } from '../src/api/middleware.ts';
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
      // The page and the API a document's *recipient* uses. Public because the
      // audience is a solicitor, an adjudicator or an insurer holding a PDF and
      // nothing else — a check behind a login is a check nobody performs, and a
      // verification nobody performs is not a control. It discloses nothing to
      // a caller who does not already hold a document this platform issued:
      // without a valid HMAC over the reference, the content hash and the
      // issuing tenancy, every request gets one identical refusal, and that is
      // tested.
      'GET /verify-document',
      // The demonstration page, re-rendered with the outcome of a booking on
      // it. A POST rather than a fetch because the booking form has to work
      // with scripting switched off: the public site's only script opens the
      // mobile menu, and a form that needed JavaScript would be the first thing
      // on these pages that did. It goes through the same booking code as
      // `POST /v1/booking` and returns HTML instead of JSON.
      'POST /demo',
      // The exposure calculator's form, submitted by a visitor with no account.
      // It stores nothing and sends nothing anywhere: the five figures are used
      // for the arithmetic on the page and then discarded, which is what stops
      // a calculator being a lead-capture form in disguise.
      'POST /exposure',
      'POST /unsubscribe',
      'POST /v1/auth/login',
      'POST /v1/auth/mfa/verify',
      // Signing in with a passkey. Public for exactly the reason the code path
      // is: it is the sign-in. The ceremony's own challenge is server-issued
      // and single-use, and `beginAuthentication` deliberately returns an empty
      // `allowCredentials` so that neither route can be used to ask whether an
      // address has an account.
      'POST /v1/auth/passkey/begin',
      'POST /v1/auth/passkey/complete',
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
      // The same check as the page below, for an integrator rather than a
      // person: a client's own system confirming a document it was sent.
      'POST /v1/verify/document',
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
      // The recipient's check, from the page. Same handler as the JSON route
      // above, so a solicitor and an integrator cannot be told different things
      // about the same document.
      'POST /verify-document',
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

describe('an invitation to tender is validated at the boundary, on both routes', () => {
  /**
   * A mistyped commercial term used to be accepted, ignored and reported as
   * priceable.
   *
   * The `terms` object was `{ type: 'object' }` — open — on the reasoning that
   * an absent field is meaningful, which it is: no stated bond is not a bond of
   * zero. But optional properties already carry that, and openness meant a
   * payload sending `paymentTermsDays` instead of `paymentDays` came back 201
   * with `readyToPrice: true` and the payment period never assessed. Silence
   * from a typo and silence from a buyer who said nothing are opposite facts,
   * and the analysis could not tell them apart.
   *
   * The second route was worse: `/v1/pipeline/tenders/:id/requirements` passed
   * the analyser's *entire* input as `{ type: 'object' }`, with a comment saying
   * the shape had its own schema on the other route — true, and worth nothing,
   * because a schema on one route validates nothing on another.
   */
  const invitation = (terms: Record<string, unknown>) => ({
    reference: 'ITT-VALIDATION-1',
    clientName: 'Northgate Developments Ltd',
    returnBy: '2026-10-15T12:00:00.000Z',
    estimatedValueMinor: 480_000_000,
    durationWeeks: 62,
    requirements: [
      { reference: 'R1', category: 'Health & safety', requirement: 'CHAS or equivalent', mandatory: true, evidenceRequired: 'Certificate' },
    ],
    terms: { contractForm: 'JCT Design and Build 2016', ...terms },
  });

  it('refuses a commercial term nobody spelled correctly', async () => {
    const reply = await call('POST', `/v1/projects/${seed.projectId}/tender/itt`, {
      token: tokenFor('qs'),
      body: invitation({ paymentTermsDays: 60 }),
    });
    assert.equal(reply.status, 400, `a misspelled payment term was accepted: ${reply.text}`);
    // Named, not just refused. The caller has to be able to see which field.
    assert.match(reply.text, /paymentTermsDays/);
  });

  it('accepts the term spelled as the analyser reads it', async () => {
    const reply = await call('POST', `/v1/projects/${seed.projectId}/tender/itt`, {
      token: tokenFor('qs'),
      body: invitation({ paymentDays: 60, retentionPercent: 5, paymentConditionalOnThirdParty: true }),
    });
    assert.equal(reply.status, 201, reply.text);

    // And the analysis is the real one: retention is cash the business funds,
    // a pay-when-paid clause is material and carries no exposure figure because
    // section 113 has already made it ineffective, and the clarification asks
    // the buyer about it rather than pricing round it.
    const terms: Array<{ term: string; severity: string; exposureMinor?: number; exposureKind?: string }> = reply.body.terms;
    const payWhenPaid = terms.find((entry) => /conditional on the buyer/i.test(entry.term));
    assert.ok(payWhenPaid, `no pay-when-paid finding: ${JSON.stringify(terms)}`);
    assert.equal(payWhenPaid.severity, 'MATERIAL');
    assert.equal(payWhenPaid.exposureMinor, undefined, 'a void clause was priced as a cash risk');
    assert.equal(reply.body.bars.length, 0, 'a clause the Act already voids was treated as a bar to bidding');
    assert.ok(
      (reply.body.clarifications as string[]).some((line) => /section 113/i.test(line)),
      'nothing asks the buyer about a clause the Act makes ineffective',
    );
    assert.equal(reply.body.quantifiedExposureMinor, 24_000_000, 'retention on £4.8m at 5% is £240,000');
  });

  it('validates the same shape on the pipeline route, which used to check nothing', async () => {
    // Any invitation id will do: the shape is refused before the id is looked
    // up, which is precisely the point — this route used to accept any object
    // at all and only then go looking for the invitation.
    const reply = await call('POST', '/v1/pipeline/tenders/01JZZZZZZZZZZZZZZZZZZZZZZZ/requirements', {
      token: tokenFor('qs'),
      body: {
        deliverables: [{ reference: 'D1', title: 'Method statement', mandatory: true }],
        analysis: invitation({ paymentTermsDays: 60 }),
      },
    });
    // 400 for the shape, before the invitation id is ever looked up — which is
    // the point: this route accepted any object at all.
    assert.equal(reply.status, 400, `the pipeline route still accepts an unchecked analysis: ${reply.text}`);
    assert.match(reply.text, /paymentTermsDays/);
  });
});

describe('the separation-of-duties control survives the gateway', () => {
  /**
   * The one case the permission matrix cannot see.
   *
   * `payments.test.ts` proves the domain refuses an identity certifying its own
   * application. This proves the refusal is what a caller actually gets over
   * HTTP, which is a different question: the gateway runs authentication, then
   * RBAC, then the handler, and a plain QS never reaches the handler at all —
   * it has no approve verb on payment applications, so it is stopped by the
   * matrix with `ACCESS_DENIED` and the control below is never consulted.
   *
   * That is why the token here stacks both roles. A small business puts the
   * commercial and the client-side hat on one person as a matter of course, and
   * separation between *roles* is not separation between *people*.
   */
  it('refuses over HTTP when one identity applies and then certifies', async () => {
    const { hashEvidence } = await import('../src/core/canonical.ts');
    const { scopesForRoles } = await import('../src/identity/scopes.ts');

    const qs = platform.user(seed.users.qs!.id);
    const roles = [...new Set([...seed.users.qs!.auth.roles, ...seed.users.owner!.auth.roles])];
    const stacked = issueTokens({
      actorId: qs.id,
      tenantId: qs.tenantId,
      partyId: qs.partyId,
      roles,
      scopes: scopesForRoles(roles),
      mfaSatisfied: true,
    }).accessToken;

    const cycle = platform.ledger.list(seed.projectId, 'PaymentCycle')[0]!;
    const applied = await call('POST', `/v1/projects/${seed.projectId}/cost/application`, {
      token: stacked,
      body: {
        cycleId: cycle.refId,
        cycleNumber: 9,
        grossValuationMinor: 50_000_000,
        variationsIncludedMinor: 0,
        previouslyCertifiedMinor: 0,
        retentionMinor: 0,
        supportingEvidenceHash: hashEvidence('http-self-cert-application'),
      },
    });
    assert.equal(applied.status, 201, applied.text);

    const certified = await call(
      'POST',
      `/v1/projects/${seed.projectId}/cost/application/${applied.body.applicationId}/certify`,
      {
        token: stacked,
        body: {
          certifiedMinor: applied.body.netAppliedMinor,
          retentionMinor: 0,
          issuedDate: '2026-12-01',
          certificateHash: hashEvidence('http-self-certificate'),
        },
      },
    );

    assert.equal(certified.status, 409, `one identity turned its own application into a debt: ${certified.text}`);
    // The specific refusal, not merely a refusal. `ACCESS_DENIED` here would
    // mean RBAC stopped it and the control was never reached — which is what
    // happens for an unstacked QS, and would make this test prove nothing.
    assert.equal(certified.body.title, 'CERTIFICATION_SELF_APPROVAL', certified.text);
    assert.match(certified.body.detail, /may not certify it/);
  });
});

describe('the orchestrator probes stay answerable under load', () => {
  /**
   * The failure this stands against, reproduced against a running server
   * before it was fixed.
   *
   * `/healthz` and `/readyz` shared the ordinary per-IP request budget with
   * every other route. Four hundred calls to `/healthz` consumed it, and 195
   * of the next 200 calls to `/readyz` came back 429.
   *
   * That is not an abstract problem. `deploy/Dockerfile` runs
   *
   *     HEALTHCHECK ... CMD fetch('.../readyz').then(r => exit(r.ok ? 0 : 1))
   *
   * every thirty seconds with three retries, and the rate-limit key is the
   * *socket's* address — so behind a reverse proxy every request in the world
   * shares one bucket, the probe included. A burst of ordinary traffic
   * therefore starves the health check, Docker marks a healthy container
   * unhealthy, restarts it, capacity drops, and the load moves to the
   * containers still standing. A restart loop assembled entirely out of a
   * working rate limiter and a working health check.
   *
   * Neither probe reads a body, touches the ledger or names an identity. The
   * most an attacker gets from an unlimited one is confirmation that the
   * process is running, which a TCP handshake already gives them.
   */
  /**
   * The test has to spend the budget first, which is the whole point.
   *
   * Written the obvious way — burst the probe on a fresh limiter — it passes
   * whether the exemption is there or not, because the default budget is
   * larger than any reasonable burst. The production failure is not "the probe
   * is called a lot"; it is "the probe is called while *something else* has
   * spent the budget". So this exhausts the anonymous bucket against an
   * ordinary public route and only then asks whether the orchestrator can
   * still get an answer.
   */
  async function exhaustTheAnonymousBudget(): Promise<number> {
    // Against a route in the *same* limiter group as the probes. Buckets are
    // keyed `rl:ip:<address>:<group>`, and `/v1/auth/*` is its own group with
    // its own much tighter budget — so flooding the login surface exhausts a
    // bucket the probes never touch and proves nothing about them. The public
    // A routed public page is group `default`, which is where the probes sit.
    // Not `/`: the landing page is answered before the limiter runs at all, so
    // hammering it spends nothing.
    let spent = 0;
    for (let i = 0; i < 1400; i += 1) {
      const response = await fetch(`${base}/exposure`);
      await response.text();
      if (response.status === 429) spent += 1;
    }
    return spent;
  }

  it('answers the liveness probe after the request budget is spent', async () => {
    const refused = await exhaustTheAnonymousBudget();
    assert.ok(refused > 0, 'the budget was never exhausted, so this proves nothing');

    let limited = 0;
    for (let i = 0; i < 40; i += 1) {
      const response = await fetch(`${base}/healthz`);
      await response.text();
      if (response.status === 429) limited += 1;
    }
    assert.equal(limited, 0, `${limited} of 40 liveness probes were rate limited after a traffic burst`);
  });

  it('answers the readiness probe after the request budget is spent', async () => {
    // The one the container's HEALTHCHECK actually calls. Without the
    // exemption this is 429 and Docker restarts a healthy container.
    const refused = await exhaustTheAnonymousBudget();
    assert.ok(refused > 0, 'the budget was never exhausted, so this proves nothing');

    let limited = 0;
    for (let i = 0; i < 40; i += 1) {
      const response = await fetch(`${base}/readyz`);
      await response.text();
      if (response.status === 429) limited += 1;
    }
    assert.equal(limited, 0, `${limited} of 40 readiness probes were rate limited after a traffic burst`);
  });

  it('still rate limits everything else', async () => {
    // The exemption must be the two probes and nothing else. If this stops
    // failing, the limiter has been switched off rather than narrowed.
    let limited = 0;
    for (let i = 0; i < 200; i += 1) {
      const response = await fetch(`${base}/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: `burst${i}@example.invalid` }),
      });
      await response.text();
      if (response.status === 429) limited += 1;
    }
    assert.ok(limited > 0, 'the login surface is no longer rate limited at all');
  });
});

describe('logout, over real HTTP', () => {
  // The probe-exemption suite above deliberately spends the auth bucket, and
  // this one signs in. Without the reset it fails with a 429 that has nothing
  // to do with logout — a green suite that went red for a reason no reader
  // would connect to the test's name.
  before(() => rateLimiter.reset());

  /**
   * The console had no way to end a session on the server. This drives the
   * whole thing through the socket: sign in, confirm the token works, sign
   * out, confirm both halves are dead.
   */
  it('ends the session so neither half of the pair is accepted again', async () => {
    const login = await call('POST', '/v1/auth/login', { body: { email: platform.user(seed.users.pm!.id).email } });
    assert.equal(login.status, 201, login.text);
    const verified = await call('POST', '/v1/auth/mfa/verify', { body: {
      actorId: login.body.actorId,
      challengeId: login.body.challengeId,
      code: login.body.devCode,
    } });
    assert.equal(verified.status, 201, verified.text);
    const { accessToken, refreshToken } = verified.body as { accessToken: string; refreshToken: string };

    const working = await call('GET', '/v1/projects', { token: accessToken });
    assert.equal(working.status, 200, 'the session should work before signing out');

    const out = await call('POST', '/v1/auth/logout', { body: {}, token: accessToken });
    assert.equal(out.status, 201, out.text);
    assert.equal(out.body.signedOut, true);

    const afterAccess = await call('GET', '/v1/projects', { token: accessToken });
    assert.equal(afterAccess.status, 401, 'the access token still works after signing out');

    // The half that makes it a logout rather than a gesture. A live refresh
    // token means the holder mints a fresh session immediately.
    const afterRefresh = await call('POST', '/v1/auth/refresh', { body: { refreshToken } });
    assert.equal(afterRefresh.status, 401, 'the refresh token still mints a session after signing out');
    assert.match(afterRefresh.body.detail, /revoked/i);
  });

  it('cannot be called without a session, so it is not a way to end somebody else’s', async () => {
    const anonymous = await call('POST', '/v1/auth/logout', { body: {} });
    assert.equal(anonymous.status, 401, 'an unauthenticated revoke endpoint is a denial-of-service primitive');
  });
});

describe('rate limiting behind a reverse proxy', () => {
  /**
   * Driven through the socket, because the defect was in the gateway rather
   * than in the address parser.
   *
   * With no trusted proxy configured — the default, and what this suite runs
   * under — the forwarded header must change nothing at all. That is the
   * property that keeps the naive fix from being worse than the defect: a
   * caller who can reach the process must not be able to hand themselves a
   * private rate-limit bucket by writing a header.
   */
  before(() => rateLimiter.reset());

  it('ignores a forged forwarded header when no proxy is trusted', async () => {
    // Two bursts under two different forged client addresses. If the header
    // were believed, each would get its own budget and neither would ever be
    // refused. Sharing one budget is the correct behaviour here.
    let refused = 0;
    for (let i = 0; i < 1400; i += 1) {
      const response = await fetch(`${base}/exposure`, {
        headers: { 'x-forwarded-for': `203.0.113.${i % 200}` },
      });
      await response.text();
      if (response.status === 429) refused += 1;
    }
    assert.ok(
      refused > 0,
      'a forged x-forwarded-for bought an unlimited number of private rate-limit buckets',
    );
  });
});

describe('the operator moves a tenancy between packages', () => {
  /**
   * Two rules, and the second is the one worth writing tests for.
   *
   * An operator may give a company a better package for nothing — that is a
   * commercial decision they are entitled to make, and it costs the platform
   * nothing per request. The company still funds its own AI spend, because a
   * credited wallet is money spent against providers who invoice this platform
   * for it, and it would arrive in the burn figures as revenue nobody received.
   *
   * So: the package moves, the wallet does not.
   */
  before(() => rateLimiter.reset());

  async function operatorToken(): Promise<string> {
    const login = await call('POST', '/v1/auth/login', {
      body: { email: platform.user(seed.users.operator!.id).email },
    });
    const verified = await call('POST', '/v1/auth/mfa/verify', {
      body: { actorId: login.body.actorId, challengeId: login.body.challengeId, code: login.body.devCode },
    });
    return (verified.body as { accessToken: string }).accessToken;
  }

  it('changes the package, records a reason, and leaves the wallet alone', async () => {
    const token = await operatorToken();
    const tenantId = seed.tenantId;
    const walletBefore = platform.wallet(tenantId).snapshot().balanceMinor;

    const moved = await call('POST', `/v1/admin/tenants/${tenantId}/package`, {
      token,
      body: { package: 'ENTERPRISE', reason: 'Agreed at the pilot review', grantFree: true },
    });

    assert.equal(moved.status, 201, moved.text);
    assert.equal(moved.body.package, 'ENTERPRISE');
    assert.equal(moved.body.grantedFree, true);
    assert.equal(moved.body.monthlyPriceMinor, 0, 'a free grant must raise no monthly charge');
    assert.ok(moved.body.listPriceMinor > 0, 'the list price is still stated, so the discount is visible');

    // The rule.
    assert.equal(
      platform.wallet(tenantId).snapshot().balanceMinor,
      walletBefore,
      'a package grant credited the wallet — the tenancy must fund its own AI spend',
    );
    assert.equal(moved.body.wallet.unchanged, true);
    assert.match(moved.body.wallet.note, /topping up|funds its own/i);
  });

  it('states the list price when the package is not being given away', async () => {
    const token = await operatorToken();
    const paid = await call('POST', `/v1/admin/tenants/${seed.tenantId}/package`, {
      token,
      // Professional Delivery holds 25, and the seeded tenancy carries 12. A
      // package that could not hold them is what the seat guard below is for,
      // and picking one here would be testing that instead of this.
      body: { package: 'PROFESSIONAL_DELIVERY', reason: 'Moved at renewal on request' },
    });
    assert.equal(paid.status, 201, paid.text);
    assert.equal(paid.body.grantedFree, false, 'a package change nobody said was free is one the customer pays for');
    assert.equal(paid.body.monthlyPriceMinor, paid.body.listPriceMinor);
  });

  it('refuses a reason nobody wrote', async () => {
    const token = await operatorToken();
    const bare = await call('POST', `/v1/admin/tenants/${seed.tenantId}/package`, {
      token,
      body: { package: 'ENTERPRISE' },
    });
    assert.equal(bare.status, 400, 'a free package handed to a named company with no stated basis is unreviewable');
  });

  it('refuses a reason that is only whitespace, which the schema lets through', async () => {
    // Mutation testing found this gap: removing the domain's reason guard broke
    // nothing, because the test above sends no `reason` at all and the schema
    // rejects that before the handler runs. Three spaces satisfy `minLength: 3`
    // and reach the domain, which is the only thing standing between an
    // operator and an unreviewable free grant.
    const token = await operatorToken();
    const blank = await call('POST', `/v1/admin/tenants/${seed.tenantId}/package`, {
      token,
      body: { package: 'ENTERPRISE', reason: '   ', grantFree: true },
    });
    assert.equal(blank.status, 422, blank.text);
    assert.equal(blank.body.title, 'SUBSCRIPTION_REASON_REQUIRED');
  });

  it('refuses anybody who is not the platform operator', async () => {
    // A tenant administrator upgrading their own package free of charge is the
    // same class of escalation as granting themselves a module.
    const login = await call('POST', '/v1/auth/login', {
      body: { email: platform.user(seed.users.admin!.id).email },
    });
    const verified = await call('POST', '/v1/auth/mfa/verify', {
      body: { actorId: login.body.actorId, challengeId: login.body.challengeId, code: login.body.devCode },
    });
    const attempt = await call('POST', `/v1/admin/tenants/${seed.tenantId}/package`, {
      token: (verified.body as { accessToken: string }).accessToken,
      body: { package: 'ENTERPRISE', reason: 'I would like this', grantFree: true },
    });
    assert.equal(attempt.status, 403, attempt.text);
    assert.equal(attempt.body.title, 'PLATFORM_ADMIN_REQUIRED');
  });

  it('refuses a downgrade that would leave more identities than the package holds', async () => {
    const token = await operatorToken();
    // The seeded tenancy carries a full team. Moving it to a one-seat package
    // would otherwise leave every existing identity working and the next
    // assignment refused against a cap nobody knowingly crossed.
    const squeezed = await call('POST', `/v1/admin/tenants/${seed.tenantId}/package`, {
      token,
      body: { package: 'SOLO', reason: 'Testing the seat cap' },
    });
    assert.equal(squeezed.status, 422, squeezed.text);
    assert.equal(squeezed.body.title, 'PACKAGE_SEATS_EXCEEDED');
    assert.match(squeezed.body.detail, /Revoke seats first/);
    // The numbers, so an operator knows how many seats to revoke rather than
    // being told only that they cannot do this.
    assert.match(squeezed.body.detail, /\d+ identities are assigned/);
  });
});
