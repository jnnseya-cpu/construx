import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform, type PlatformUser } from '../src/platform.ts';
import { authOf } from '../src/seed.ts';

/**
 * A closed identity can be fully deleted now, by the company's administrator
 * or by the platform operator on the company's request — without the grace
 * period, never while the person is still active.
 */

let platform: Platform;
let server: Server;
let base: string;
let operator: PlatformUser;
let admin: PlatformUser;
let leaver: PlatformUser;
let other: PlatformUser;
let tenantId: string;

function tokenFor(user: PlatformUser): string {
  const auth = authOf(platform, user.id);
  return issueTokens({ actorId: auth.actorId, tenantId: auth.tenantId, partyId: auth.partyId, roles: auth.roles, mfaSatisfied: true }).accessToken;
}

async function send(method: string, path: string, token: string, payload?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

before(async () => {
  platform = new Platform();
  operator = platform.createOperator({ name: 'Ruth Okafor', email: 'ops@construx.example' });
  const created = platform.createTenant({ legalName: 'Northgate Build Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'ENTERPRISE', package: 'ENTERPRISE', enterpriseName: 'Northgate' });
  tenantId = created.tenant.id;
  admin = platform.createUser({ tenantId, name: 'Rowan Adeyemi', email: 'rowan@northgate.example', roles: ['ENTERPRISE_ADMIN'] });
  leaver = platform.createUser({ tenantId, name: 'Esi Mensah', email: 'esi@northgate.example', roles: ['PLANNER'] });
  other = platform.createUser({ tenantId, name: 'Lee Morgan', email: 'lee@northgate.example', roles: ['SUPERVISOR'] });
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => server.close());

describe('deleting a closed person now', () => {
  it('refuses while the person is still active', async () => {
    const refused = await send('POST', `/v1/users/${leaver.id}/erase`, tokenFor(admin), { reason: 'Left the company on Friday' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.title, 'ERASE_ACTIVE_USER');
  });

  it('the administrator deletes a deactivated person at once, and the record stays pseudonymous', async () => {
    const off = await send('POST', `/v1/users/${leaver.id}/deactivate`, tokenFor(admin), { reason: 'Left the company on Friday' });
    assert.equal(off.status, 201, JSON.stringify(off.body));
    const gone = await send('POST', `/v1/users/${leaver.id}/erase`, tokenFor(admin), { reason: 'Written request received, delete today' });
    assert.equal(gone.status, 201, JSON.stringify(gone.body));
    const after = platform.user(leaver.id);
    assert.ok(after.erasedAt);
    assert.notEqual(after.email, 'esi@northgate.example');
    const again = await send('POST', `/v1/users/${leaver.id}/erase`, tokenFor(admin), { reason: 'Written request received, delete today' });
    assert.equal(again.body.title, 'ALREADY_ERASED');
  });

  it('a planner cannot, and the operator can on the company\'s request', async () => {
    await send('POST', `/v1/users/${other.id}/deactivate`, tokenFor(admin), { reason: 'Contract ended' });
    const planner = platform.createUser({ tenantId, name: 'Kemi Bello', email: 'kemi@northgate.example', roles: ['PLANNER'] });
    const refused = await send('POST', `/v1/users/${other.id}/erase`, tokenFor(planner), { reason: 'Contract ended, delete' });
    assert.equal(refused.status, 403);

    const listed = await send('GET', `/v1/admin/tenants/${tenantId}/users`, tokenFor(operator));
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const closed = listed.body.users as Array<Record<string, unknown>>;
    assert.ok(closed.some((person) => person.id === other.id), 'the deactivated person is listed for the operator');
    assert.equal(closed.some((person) => person.id === planner.id), false, 'active people are not');

    const gone = await send('POST', `/v1/admin/tenants/${tenantId}/users/${other.id}/erase`, tokenFor(operator), { reason: 'Company asked by ticket SUP-2' });
    assert.equal(gone.status, 201, JSON.stringify(gone.body));
    assert.ok(platform.user(other.id).erasedAt);
    const record = platform.ledger.events({ tenantId }).filter((event) => event.entity.refId === other.id && event.actor.refId === operator.id);
    assert.ok(record.length > 0, 'the operator’s act is on the company’s own chain under their name');
    const notOperator = await send('GET', `/v1/admin/tenants/${tenantId}/users`, tokenFor(admin));
    assert.equal(notOperator.status, 403);
  });
});
