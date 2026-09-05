import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import * as collection from '../src/billing/collection.ts';
import * as mandate from '../src/billing/mandate.ts';
import { PACKAGES } from '../src/billing/seats.ts';
import { attachCompany, createGroup, grantGroupRole } from '../src/group/directory.ts';
import { addCompany } from '../src/group/onboarding.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { authOf } from '../src/seed.ts';

/**
 * How a paying account agrees to be collected from, going forward: the popup's
 * record. Required for a paid package that nobody covers; never for a company
 * covered by its group, a package granted free, or a cancelled subscription.
 */

let platform: Platform;
let server: Server;
let base: string;
let tenantId = '';
let adminToken = '';
let plannerToken = '';
let operatorId = '';

function tokenFor(userId: string): string {
  const auth = authOf(platform, userId);
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
  collection.setCollector(collection.NO_PAYMENT_METHOD);
  operatorId = platform.createOperator({ name: 'Ruth', email: 'ops@construx.example' }).id;
  const created = platform.createTenant({ legalName: 'JNN GLOBAL LTD', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'TEAM', package: 'CORE_PROJECT', enterpriseName: 'JNN GLOBAL', trialGrant: false, opensOn: 'FIRST_PAYMENT' });
  tenantId = created.tenant.id;
  adminToken = tokenFor(platform.createUser({ tenantId, name: 'Jean Nseya', email: 'jean@jnnglobal.example', roles: ['ENTERPRISE_ADMIN'] }).id);
  plannerToken = tokenFor(platform.createUser({ tenantId, name: 'Esi Mensah', email: 'esi@jnnglobal.example', roles: ['PLANNER'] }).id);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

describe('the activation position', () => {
  it('says a paid signup has a subscription to activate, what the first month is, and what the deployment can take', async () => {
    const position = await send('GET', '/v1/billing/mandate', adminToken);
    assert.equal(position.status, 200, JSON.stringify(position.body));
    assert.equal(position.body.required, true);
    assert.equal(position.body.mandate, null);
    assert.equal(position.body.packageLabel, PACKAGES.CORE_PROJECT.label);
    assert.equal(position.body.monthlyPriceMinor, PACKAGES.CORE_PROJECT.monthlyPriceMinor);
    const first = position.body.firstCharge as { amountMinor: number; paymentReference: string };
    assert.equal(first.amountMinor, PACKAGES.CORE_PROJECT.monthlyPriceMinor);
    assert.match(first.paymentReference, /^CX-[A-Z0-9]{8}$/);
    const rails = position.body.rails as { card: boolean; directDebit: boolean; bankTransfer: boolean };
    assert.equal(rails.directDebit, false, 'no Direct Debit rail is connected, and the position says so');
    assert.equal(rails.bankTransfer, true);
    const wording = position.body.wording as Record<string, string>;
    assert.match(wording.DIRECT_DEBIT!, /I authorise CONSTRUX to collect £950\.00 today and the same amount each month by direct debit, until I cancel\. I confirm I’m authorised to set up payments for JNN GLOBAL LTD\./);
    assert.match(wording.RECURRING_CARD!, /by card, until I cancel/);
  });

  it('is nothing to somebody who cannot act on billing', async () => {
    const refused = await send('POST', '/v1/billing/mandate', plannerToken, { method: 'DIRECT_DEBIT', authorised: true });
    assert.equal(refused.status, 403);
  });
});

describe('authorising', () => {
  it('records nothing without the tick', async () => {
    const refused = await send('POST', '/v1/billing/mandate', adminToken, { method: 'DIRECT_DEBIT', authorised: false });
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.equal(refused.body.title, 'AUTHORISATION_REQUIRED');
    assert.equal(mandate.mandates(platform, tenantId).length, 0);
  });

  it('records the method, the amount, the company and the exact sentence, under the person', async () => {
    const authorised = await send('POST', '/v1/billing/mandate', adminToken, { method: 'DIRECT_DEBIT', authorised: true, companyName: 'JNN GLOBAL LTD' });
    assert.equal(authorised.status, 201, JSON.stringify(authorised.body));
    const held = authorised.body.mandate as Record<string, unknown>;
    assert.equal(held.status, 'AUTHORISED');
    assert.equal(held.method, 'DIRECT_DEBIT');
    assert.equal(held.amountMinor, PACKAGES.CORE_PROJECT.monthlyPriceMinor);
    assert.equal(held.authorisedByName, 'Jean Nseya');
    assert.match(String(held.wording), /by direct debit/);
    const position = await send('GET', '/v1/billing/mandate', adminToken);
    assert.equal((position.body.mandate as { id: string }).id, held.id);
    // Still to activate: authorising is not paying. The first month is still owed.
    assert.equal(position.body.required, true);
    assert.ok(position.body.firstCharge);
    assert.equal(platform.subscription(tenantId).status, 'AWAITING_PAYMENT');
  });

  it('supersedes the one in force, so there is one at a time, and both stay on the record', async () => {
    const card = await send('POST', '/v1/billing/mandate', adminToken, { method: 'RECURRING_CARD', authorised: true });
    assert.equal(card.status, 201, JSON.stringify(card.body));
    const all = mandate.mandates(platform, tenantId);
    assert.equal(all.length, 2);
    assert.equal(all[0]!.status, 'CANCELLED');
    assert.match(String(all[0]!.cancelReason), /Superseded by a Recurring card/);
    assert.equal(all[1]!.status, 'AUTHORISED');
    assert.equal(all[1]!.method, 'RECURRING_CARD');
    assert.equal(mandate.currentMandate(platform, tenantId)!.id, all[1]!.id);
  });

  it('survives a restart', () => {
    const rebuilt = new Platform();
    rebuilt.ledger.restore(platform.ledger.events());
    rebuilt.rehydrate();
    assert.equal(mandate.currentMandate(rebuilt, tenantId)!.method, 'RECURRING_CARD');
  });

  it('can be cancelled with a reason, once', async () => {
    const cancelled = await send('POST', '/v1/billing/mandate/cancel', adminToken, { reason: 'Switching bank accounts' });
    assert.equal(cancelled.status, 201, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.status, 'CANCELLED');
    assert.equal(mandate.currentMandate(platform, tenantId), null);
    const again = await send('POST', '/v1/billing/mandate/cancel', adminToken, { reason: 'Nothing left' });
    assert.equal(again.status, 404);
    assert.equal(again.body.title, 'NO_MANDATE');
  });
});

describe('who never sees the popup', () => {
  it('a company covered by its group, and a package granted free', async () => {
    const admin = platform.users(tenantId).find((user) => user.roles.includes('ENTERPRISE_ADMIN'))!;
    const group = createGroup(platform, authOf(platform, admin.id), { displayName: 'JNN GLOBAL LTD', currency: 'GBP' });
    attachCompany(platform, authOf(platform, admin.id), group.id, { tenantId, code: 'JNN' });
    grantGroupRole(platform, authOf(platform, admin.id), group.id, { email: admin.email, role: 'GROUP_ADMIN' });
    const added = addCompany(platform, authOf(platform, admin.id), group.id, {
      displayName: 'ETABLIX',
      jurisdiction: 'GB',
      currency: 'GBP',
      administrators: [{ name: 'Lea Mbala', email: 'lea@etablix.example' }],
    });
    const covered = await send('GET', '/v1/billing/mandate', tokenFor(added.administrators[0]!.id));
    assert.equal(covered.status, 200);
    assert.equal(covered.body.required, false);
    assert.match(String(covered.body.reason), /covered by its subscription/);
    const attempt = await send('POST', '/v1/billing/mandate', tokenFor(added.administrators[0]!.id), { method: 'DIRECT_DEBIT', authorised: true });
    assert.equal(attempt.status, 409);
    assert.equal(attempt.body.title, 'NOTHING_TO_COLLECT');

    // The primary itself, granted free by the operator: nothing to collect either.
    platform.setSubscriptionPackage({ tenantId, package: 'CORE_PROJECT', reason: 'Exempt from the monthly subscription by agreement', decidedBy: operatorId, grantFree: true });
    const free = await send('GET', '/v1/billing/mandate', adminToken);
    assert.equal(free.body.required, false);
    assert.match(String(free.body.reason), /granted free of charge/);
  });
});
