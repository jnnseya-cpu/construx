import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { runDueErasures } from '../src/identity/erasure.ts';
import { authOf } from '../src/seed.ts';
import { Platform } from '../src/platform.ts';
import { issueTokens } from '../src/identity/auth.ts';

/**
 * An administrator removing a person: deactivate, reactivate, delete.
 *
 * Requested from a live tenancy: "enterprise admin to be able to delete a user
 * after deactivation". Enterprise & Portfolio listed people and could do
 * nothing to any of them. The erasure request route existed with no door, and
 * `eraseUser` — the thing that actually removes the name — was called by
 * nothing at all, so a requested erasure stayed requested for ever.
 *
 * Deactivation is the reversible step: seat released, sign-in stopped, record
 * untouched. Deletion is erasure: requested with a reason, carried out after
 * the grace period by the schedule, and cancellable until then.
 */

let platform: Platform;
let server: Server;
let base: string;
let tenantId: string;
let admin: { id: string; token: string };
let second: { id: string; token: string };
let worker: { id: string };

function tokenFor(userId: string): string {
  const auth = authOf(platform, userId);
  return issueTokens({ actorId: auth.actorId, tenantId: auth.tenantId, partyId: auth.partyId, roles: auth.roles, mfaSatisfied: true })
    .accessToken;
}

async function send(method: string, path: string, token: string, payload?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function listed(userId: string) {
  const { body } = await send('GET', '/v1/users', admin.token);
  return (body.users as Array<Record<string, unknown>>).find((u) => u.id === userId)!;
}

before(async () => {
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
  const b = platform.createUser({ tenantId, name: 'Sam Kaur', email: 'sam@northgate.example', roles: ['ENTERPRISE_ADMIN'] });
  const w = platform.createUser({ tenantId, name: 'Lee Morgan', email: 'lee@northgate.example', roles: ['SUPERVISOR'] });
  admin = { id: a.id, token: tokenFor(a.id) };
  second = { id: b.id, token: tokenFor(b.id) };
  worker = { id: w.id };

  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

describe('deactivating', () => {
  it('needs a reason, and is refused to a non-administrator', async () => {
    const noReason = await send('POST', `/v1/users/${worker.id}/deactivate`, admin.token, {});
    assert.equal(noReason.status, 400);
    const asWorker = await send('POST', `/v1/users/${admin.id}/deactivate`, tokenFor(worker.id), { reason: 'Trying it on' });
    assert.equal(asWorker.status, 403);
    assert.equal(asWorker.body.title, 'ENTERPRISE_ADMIN_REQUIRED');
  });

  it('refuses self-deactivation', async () => {
    const self = await send('POST', `/v1/users/${admin.id}/deactivate`, admin.token, { reason: 'Leaving' });
    assert.equal(self.status, 422, JSON.stringify(self.body));
    assert.equal(self.body.title, 'CANNOT_DEACTIVATE_SELF');
  });

  it('releases the seat, stops sign-in and keeps the record', async () => {
    const seatsBefore = platform.subscription(tenantId).assignedIdentities.length;
    const done = await send('POST', `/v1/users/${worker.id}/deactivate`, admin.token, { reason: 'Contract ended 31 August' });
    assert.equal(done.status, 201, JSON.stringify(done.body));
    assert.equal(done.body.status, 'SUSPENDED');
    assert.equal(platform.subscription(tenantId).assignedIdentities.length, seatsBefore - 1);

    const row = await listed(worker.id);
    assert.equal(row.status, 'SUSPENDED');
    assert.equal(row.name, 'Lee Morgan', 'deactivation removes nothing');
    assert.equal(row.erasureRequestedAt, null);

    assert.throws(() => platform.login('lee@northgate.example'), (error: { code?: string }) => error.code === 'USER_SUSPENDED');
  });

  it('refuses to do it twice', async () => {
    const again = await send('POST', `/v1/users/${worker.id}/deactivate`, admin.token, { reason: 'Again' });
    assert.equal(again.status, 409);
    assert.equal(again.body.title, 'ALREADY_DEACTIVATED');
  });

  it('survives a restart as deactivated', () => {
    const rebuilt = new Platform();
    rebuilt.ledger.restore(platform.ledger.events());
    rebuilt.rehydrate();
    assert.equal(rebuilt.user(worker.id).status, 'SUSPENDED');
  });

  it('never removes the last active administrator', async () => {
    const deactivateSecond = await send('POST', `/v1/users/${second.id}/deactivate`, admin.token, { reason: 'Moved on' });
    assert.equal(deactivateSecond.status, 201, JSON.stringify(deactivateSecond.body));

    // Rowan is now the only active administrator, and nobody may take Rowan
    // out — asserted at the platform level with Sam as the actor, so the check
    // under test is the last-administrator rule and not the suspended token.
    assert.throws(
      () => platform.deactivateUser(authOf(platform, second.id), { userId: admin.id, reason: 'Coup' }),
      (error: { code?: string }) => error.code === 'LAST_ADMINISTRATOR',
    );

    // Restore Sam so the rest of the file has two administrators again. With
    // two active, taking one out is allowed — it is the last that is protected.
    const back = await send('POST', `/v1/users/${second.id}/reactivate`, admin.token, { reason: 'Back on the team' });
    assert.equal(back.status, 201, JSON.stringify(back.body));
  });
});

describe('reactivating', () => {
  it('takes a seat again and restores sign-in', async () => {
    const seatsBefore = platform.subscription(tenantId).assignedIdentities.length;
    const back = await send('POST', `/v1/users/${worker.id}/reactivate`, admin.token, { reason: 'Contract renewed' });
    assert.equal(back.status, 201, JSON.stringify(back.body));
    assert.equal(back.body.status, 'ACTIVE');
    assert.equal(platform.subscription(tenantId).assignedIdentities.length, seatsBefore + 1);
    assert.equal((await listed(worker.id)).status, 'ACTIVE');
    assert.equal(platform.login('lee@northgate.example').user.id, worker.id);
  });

  it('refuses when already active', async () => {
    const again = await send('POST', `/v1/users/${worker.id}/reactivate`, admin.token, { reason: 'Again' });
    assert.equal(again.status, 409);
    assert.equal(again.body.title, 'ALREADY_ACTIVE');
  });
});

describe('deleting — erasure with a grace period', () => {
  it('is requested with a reason and shows on the list as pending', async () => {
    await send('POST', `/v1/users/${worker.id}/deactivate`, admin.token, { reason: 'Left the company' });
    const requested = await send('POST', `/v1/users/${worker.id}/erasure`, admin.token, {
      reason: 'Written request from Lee Morgan dated 1 September',
    });
    assert.equal(requested.status, 201, JSON.stringify(requested.body));
    assert.ok(requested.body.dueAt);

    const row = await listed(worker.id);
    assert.equal(row.status, 'SUSPENDED');
    assert.equal(row.erasureDueAt, requested.body.dueAt);
    assert.equal(row.erasedAt, null);
  });

  it('cannot be reactivated around: cancel the erasure instead', async () => {
    const around = await send('POST', `/v1/users/${worker.id}/reactivate`, admin.token, { reason: 'Oops' });
    assert.equal(around.status, 409);
    assert.equal(around.body.title, 'ERASURE_OUTSTANDING');
  });

  it('an administrator can cancel it, which restores the person', async () => {
    const cancelled = await send('DELETE', `/v1/users/${worker.id}/erasure`, admin.token);
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    const row = await listed(worker.id);
    assert.equal(row.status, 'ACTIVE');
    assert.equal(row.erasureRequestedAt, null);
  });

  it('is carried out by the schedule once the grace period has run, and not before', async () => {
    await send('POST', `/v1/users/${worker.id}/deactivate`, admin.token, { reason: 'Left the company' });
    const requested = await send('POST', `/v1/users/${worker.id}/erasure`, admin.token, {
      reason: 'Written request from Lee Morgan dated 1 September',
    });
    assert.equal(requested.status, 201);

    const early = await runDueErasures(platform, new Date());
    assert.equal(early.due, 0);
    assert.equal(early.erased, 0);
    assert.equal((await listed(worker.id)).name, 'Lee Morgan');

    const afterGrace = new Date(Date.parse(String(requested.body.dueAt)) + 60_000);
    const run = await runDueErasures(platform, afterGrace);
    assert.equal(run.due, 1);
    assert.equal(run.erased, 1, JSON.stringify(run.failed));

    const row = await listed(worker.id);
    assert.ok(row.erasedAt);
    assert.notEqual(row.name, 'Lee Morgan');
    assert.match(String(row.email), /@erased\.invalid$/);
    assert.equal(row.status, 'SUSPENDED');

    // Nothing to do on the next pass, and the erased identity cannot come back.
    const again = await runDueErasures(platform, afterGrace);
    assert.equal(again.due, 0);
    const restore = await send('POST', `/v1/users/${worker.id}/reactivate`, admin.token, { reason: 'Please' });
    assert.equal(restore.status, 409);
    assert.equal(restore.body.title, 'ALREADY_ERASED');
  });
});
