import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { rateLimiter } from '../src/api/middleware.ts';
import { Platform, type PlatformUser } from '../src/platform.ts';
import { authOf } from '../src/seed.ts';

/**
 * Account requests: new → contacted → qualified → provisioned, or declined
 * and then deleted. Provisioning is one act — tenancy, first administrator,
 * invitation.
 */

let platform: Platform;
let server: Server;
let base: string;
let operator: PlatformUser;

function tokenFor(user: PlatformUser): string {
  const auth = authOf(platform, user.id);
  return issueTokens({ actorId: auth.actorId, tenantId: auth.tenantId, partyId: auth.partyId, roles: auth.roles, mfaSatisfied: true }).accessToken;
}

async function send(method: string, path: string, token: string | null, payload?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const ask = { organisationName: 'Groupe Nseya', contactName: 'Justin Nseya', email: 'justin@groupe-nseya.example', jurisdiction: 'GB', currency: 'GBP', companies: 2, message: 'Two companies, ETABLIX and JN Construction' };

before(async () => {
  platform = new Platform();
  operator = platform.createOperator({ name: 'Ruth Okafor', email: 'ops@construx.example' });
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  rateLimiter.reset();
});
after(() => server.close());

describe('the request pipeline', () => {
  let id: string;

  it('arrives from the public site as NEW, and says nothing about the address', async () => {
    const received = await send('POST', '/v1/requests', null, ask);
    assert.equal(received.status, 201, JSON.stringify(received.body));
    assert.equal(received.body.received, true);
    const bad = await send('POST', '/v1/requests', null, { ...ask, email: 'not-an-address' });
    assert.equal(bad.status, 400);

    const queue = await send('GET', '/v1/admin/requests', tokenFor(operator));
    assert.equal(queue.status, 200, JSON.stringify(queue.body));
    const requests = queue.body.requests as Array<Record<string, unknown>>;
    assert.equal(requests.length, 1);
    id = String(requests[0]!.id);
    assert.equal(requests[0]!.status, 'NEW');
    assert.equal(requests[0]!.kind, 'GROUP');
    assert.equal((queue.body.counts as Record<string, number>).NEW, 1);
  });

  it('moves forward one step at a time, and cannot be provisioned before it is qualified', async () => {
    const skip = await send('POST', `/v1/admin/requests/${id}/advance`, tokenFor(operator), { status: 'QUALIFIED' });
    assert.equal(skip.body.title, 'REQUEST_STEP_INVALID');
    const early = await send('POST', `/v1/admin/requests/${id}/provision`, tokenFor(operator), { tier: 'ENTERPRISE', package: 'ENTERPRISE' });
    assert.equal(early.body.title, 'REQUEST_NOT_QUALIFIED');
    const contacted = await send('POST', `/v1/admin/requests/${id}/advance`, tokenFor(operator), { status: 'CONTACTED', note: 'Spoke on the phone' });
    assert.equal(contacted.status, 201, JSON.stringify(contacted.body));
    assert.equal(contacted.body.status, 'CONTACTED');
    const qualified = await send('POST', `/v1/admin/requests/${id}/advance`, tokenFor(operator), { status: 'QUALIFIED', note: 'Terms agreed' });
    assert.equal(qualified.body.status, 'QUALIFIED');
    assert.equal((qualified.body.notes as unknown[]).length, 2);
  });

  it('provisions in one act: tenancy, first administrator, invitation', async () => {
    const provisioned = await send('POST', `/v1/admin/requests/${id}/provision`, tokenFor(operator), { tier: 'ENTERPRISE', package: 'ENTERPRISE' });
    assert.equal(provisioned.status, 201, JSON.stringify(provisioned.body));
    const tenant = provisioned.body.tenant as Record<string, unknown>;
    const administrator = provisioned.body.administrator as Record<string, unknown>;
    assert.equal(tenant.legalName, 'Groupe Nseya');
    assert.equal(administrator.email, ask.email);
    assert.deepEqual(administrator.roles, ['ENTERPRISE_ADMIN']);
    assert.ok(['SENT', 'RECORDED', 'FAILED', 'QUEUED', 'DELIVERED'].includes(String(provisioned.body.notified)));
    const request = provisioned.body.request as Record<string, unknown>;
    assert.equal(request.status, 'PROVISIONED');
    assert.equal((request.provisioned as Record<string, unknown>).tenantId, tenant.id);
    assert.equal(platform.subscription(String(tenant.id)).package, 'ENTERPRISE');
    assert.ok(platform.userByEmail(ask.email));

    const again = await send('POST', `/v1/admin/requests/${id}/provision`, tokenFor(operator), { tier: 'ENTERPRISE', package: 'ENTERPRISE' });
    assert.equal(again.body.title, 'REQUEST_NOT_QUALIFIED');
    const decline = await send('POST', `/v1/admin/requests/${id}/decline`, tokenFor(operator), { reason: 'Too late' });
    assert.equal(decline.body.title, 'REQUEST_STEP_INVALID');
  });

  it('a declined request can be deleted, and only a declined one', async () => {
    rateLimiter.reset();
    await send('POST', '/v1/requests', null, { ...ask, organisationName: 'Tyre Kickers Ltd', email: 'kick@tyres.example', companies: 1 });
    const queue = await send('GET', '/v1/admin/requests', tokenFor(operator));
    const other = (queue.body.requests as Array<Record<string, unknown>>).find((r) => r.organisationName === 'Tyre Kickers Ltd')!;
    const notYet = await send('DELETE', `/v1/admin/requests/${other.id}`, tokenFor(operator));
    assert.equal(notYet.body.title, 'REQUEST_NOT_DECLINED');
    const declined = await send('POST', `/v1/admin/requests/${other.id}/decline`, tokenFor(operator), { reason: 'Not a construction business' });
    assert.equal(declined.status, 201, JSON.stringify(declined.body));
    const deleted = await send('DELETE', `/v1/admin/requests/${other.id}`, tokenFor(operator));
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    const after = await send('GET', '/v1/admin/requests', tokenFor(operator));
    const gone = (after.body.requests as Array<Record<string, unknown>>).find((r) => r.id === other.id)!;
    assert.equal(gone.organisationName, '(deleted)');
    assert.equal(String(gone.email).includes('tyres'), false, 'the prospect\'s details are gone');
  });

  it('is the operator\'s queue and nobody else\'s', async () => {
    const created = platform.createTenant({ legalName: 'Other Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'TEAM', package: 'CORE_PROJECT', enterpriseName: 'Other' });
    const admin = platform.createUser({ tenantId: created.tenant.id, name: 'A', email: 'a@other.example', roles: ['ENTERPRISE_ADMIN'] });
    const refused = await send('GET', '/v1/admin/requests', tokenFor(admin));
    assert.equal(refused.status, 403);
  });
});
