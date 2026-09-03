import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import * as collection from '../src/billing/collection.ts';
import { PACKAGES, SEATS } from '../src/billing/seats.ts';
import { purchasedSeatEntitlements, purchasedSeats } from '../src/billing/subscription.ts';
import { authOf } from '../src/seed.ts';
import { Platform } from '../src/platform.ts';
import { issueTokens } from '../src/identity/auth.ts';

/**
 * Seats bought beyond the package.
 *
 * Reported from a live tenancy on Solo: "Redeployed, now getting seat limit
 * reached". Solo includes one seat and the administrator was it. The seat price
 * list has said since it was written that an over-cap seat is charged at the
 * seat price — and nothing let anybody buy one. The only remedy the refusal
 * named was moving to a package ten times the price, or asking the operator to
 * grant one for free.
 *
 * A bought seat is a `SeatEntitlement` on the ledger, the same shape as a bought
 * storage block: counted in the cap the moment it exists, on the invoice as a
 * line at the price it was bought at, and in the recurring charge for as long
 * as it is held.
 */

const DAY = 86_400_000;
let platform: Platform;
let server: Server;
let base: string;
let adminToken: string;
let operatorToken: string;
let tenantId: string;

function tokenFor(userId: string): string {
  const auth = authOf(platform, userId);
  return issueTokens({
    actorId: auth.actorId,
    tenantId: auth.tenantId,
    partyId: auth.partyId,
    roles: auth.roles,
    mfaSatisfied: true,
  }).accessToken;
}

async function post(path: string, token: string, payload: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function get(path: string, token: string) {
  const response = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

before(async () => {
  platform = new Platform();
  collection.setCollector(collection.NO_PAYMENT_METHOD);
  const created = platform.createTenant({
    legalName: 'Solo Surveys Ltd',
    jurisdiction: 'GB',
    defaultCurrency: 'GBP',
    tier: 'SOLO',
    package: 'SOLO',
    enterpriseName: 'Solo Surveys',
  });
  tenantId = created.tenant.id;
  const admin = platform.createUser({ tenantId, name: 'Rowan Adeyemi', email: 'rowan@solosurveys.example', roles: ['ENTERPRISE_ADMIN'] });
  adminToken = tokenFor(admin.id);

  const operator = platform.createUser({
    tenantId: 'platform',
    name: 'Ops',
    email: 'ops@construx.example',
    roles: ['PLATFORM_ADMIN'],
  });
  operatorToken = tokenFor(operator.id);

  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

describe('buying a seat beyond the package', () => {
  it('starts refused: Solo is one seat and the administrator is it', async () => {
    assert.equal(PACKAGES.SOLO.includedSeats, 1);
    const refused = await post('/v1/users', adminToken, { name: 'Second', email: 'second@solosurveys.example', roles: ['SUPERVISOR'] });
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.equal(refused.body.title, 'SEAT_LIMIT_REACHED');
    assert.match(String(refused.body.detail), /buy a seat on acu & billing/i);
  });

  it('the seats position publishes the cap and nothing bought yet', async () => {
    const seats = await get('/v1/billing/seats', adminToken);
    assert.equal(seats.status, 200);
    assert.equal(seats.body.seatsUsed, 1);
    assert.equal(seats.body.seatsPurchased, 0);
    assert.equal(seats.body.seatCap, 1);
  });

  it('is refused for an unknown seat type and an absurd count', async () => {
    const unknown = await post('/v1/billing/seats/purchase', adminToken, { seat: 'ASTRONAUT', count: 1 });
    assert.equal(unknown.status, 400, JSON.stringify(unknown.body));
    const many = await post('/v1/billing/seats/purchase', adminToken, { seat: 'SITE_SUPERVISOR', count: 21 });
    assert.equal(many.status, 400, JSON.stringify(many.body));
    assert.equal(purchasedSeats(platform.ledger, tenantId), 0);
  });

  it('is barred to the platform operator — a tenancy commits itself to a charge', async () => {
    const refused = await post('/v1/billing/seats/purchase', operatorToken, { seat: 'SITE_SUPERVISOR', count: 1 });
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.equal(refused.body.title, 'ACCOUNT_LAYER_SEPARATION');
  });

  it('buys one seat at the seat price and lifts the cap by one', async () => {
    const bought = await post('/v1/billing/seats/purchase', adminToken, { seat: 'SITE_SUPERVISOR', count: 1 });
    assert.equal(bought.status, 201, JSON.stringify(bought.body));
    assert.equal(bought.body.seats, 1);
    assert.equal(bought.body.label, SEATS.SITE_SUPERVISOR.label);
    assert.equal(bought.body.monthlyPriceMinor, SEATS.SITE_SUPERVISOR.monthlyPriceMinor);
    assert.equal(bought.body.seatsUsed, 1);
    assert.equal(bought.body.seatCap, 2);
    assert.equal(bought.body.seatsPurchased, 1);

    const entitlements = purchasedSeatEntitlements(platform.ledger, tenantId);
    assert.equal(entitlements.length, 1);
    assert.equal(entitlements[0]?.unitMinor, SEATS.SITE_SUPERVISOR.monthlyPriceMinor);
    assert.equal(entitlements[0]?.id, bought.body.entitlementId);
  });

  it('admits the second person on the bought seat, and refuses a third', async () => {
    const admitted = await post('/v1/users', adminToken, { name: 'Second', email: 'second@solosurveys.example', roles: ['SUPERVISOR'] });
    assert.equal(admitted.status, 201, JSON.stringify(admitted.body));
    assert.equal(platform.users(tenantId).length, 2);

    const third = await post('/v1/users', adminToken, { name: 'Third', email: 'third@solosurveys.example', roles: ['PLANNER'] });
    assert.equal(third.status, 422, JSON.stringify(third.body));
    assert.equal(third.body.title, 'SEAT_LIMIT_REACHED');
    // The refusal states both what the package includes and what has been bought.
    assert.match(String(third.body.detail), /includes 1 seat and 1 more has been bought/);
    assert.equal(platform.users(tenantId).length, 2);
  });

  it('shows the bought seat on the seats position', async () => {
    const seats = await get('/v1/billing/seats', adminToken);
    assert.equal(seats.body.seatsUsed, 2);
    assert.equal(seats.body.seatsPurchased, 1);
    assert.equal(seats.body.seatCap, 2);
    assert.equal(seats.body.purchasedMonthlyMinor, SEATS.SITE_SUPERVISOR.monthlyPriceMinor);
    assert.equal((seats.body.purchasedSeats as unknown[]).length, 1);
  });

  it('puts the seat on the invoice as its own line, at the price it was bought at', () => {
    const period = new Date().toISOString().slice(0, 7);
    const invoice = platform.previewInvoice(tenantId, period);
    const seatLines = invoice.lines.filter((line) => line.category === 'SEATS');
    assert.equal(seatLines.length, 1);
    assert.equal(seatLines[0]?.amountMinor, SEATS.SITE_SUPERVISOR.monthlyPriceMinor);
    assert.match(seatLines[0]?.description ?? '', /Additional seat — Site Manager \/ Supervisor × 1/);
    assert.equal(invoice.seatsMinor, SEATS.SITE_SUPERVISOR.monthlyPriceMinor);
    assert.equal(invoice.totalMinor, PACKAGES.SOLO.monthlyPriceMinor + SEATS.SITE_SUPERVISOR.monthlyPriceMinor);
    assert.ok(invoice.commercialTerms.some((term) => /seats bought beyond the package/i.test(term)));
  });

  it('is collected with the package when the period falls due', () => {
    const subscription = platform.subscription(tenantId);
    const dueAt = new Date(Date.parse(subscription.renewsAt) + DAY);
    const raised = collection.raiseCharge(platform, tenantId, dueAt);
    assert.ok(raised, 'a due period raises a charge');
    assert.equal(raised.charge.amountMinor, PACKAGES.SOLO.monthlyPriceMinor + SEATS.SITE_SUPERVISOR.monthlyPriceMinor);
  });

  it('counts bought seats when judging a package move', () => {
    // Two identities assigned, one on a bought seat. Moving to the Free package
    // (one included) still holds them, because the bought seat travels.
    const moved = platform.setSubscriptionPackage({
      tenantId,
      package: 'FREE_TRIAL',
      reason: 'Test — a bought seat is counted in the target cap',
      decidedBy: 'operator',
      grantFree: false,
    });
    assert.equal(moved.package, 'FREE_TRIAL');
    assert.equal(moved.assignedIdentities.length, 2);
  });

  it('the operator sees the bought seats on the estate', async () => {
    const tenants = await get('/v1/admin/tenants', operatorToken);
    assert.equal(tenants.status, 200, JSON.stringify(tenants.body));
    const row = (tenants.body.tenants as Array<Record<string, unknown>>).find((t) => t.id === tenantId);
    assert.ok(row, 'the tenancy is listed');
    assert.equal(row.seatsPurchased, 1);
    assert.equal(row.seatsUsed, 2);
  });
});
