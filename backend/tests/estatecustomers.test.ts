import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { PLATFORM_TENANT_ID, Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The operator's business figures are computed over customers.
 *
 * Found on a live deployment's Command Center: lifetime revenue £5.0K, run-rate
 * £50K, concentration 100% from one account, and a CRITICAL "no administrator —
 * nobody can run this tenancy". None of it was a customer. The £5.0K was the
 * demonstration's seeded opening credit, written through the payment path so
 * that it looks like a receipt; the tenancy nobody could run was the platform's
 * own, an ENTERPRISE subscription with no people in it that every screen then
 * flagged and forecast a renewal for.
 *
 * The rule is one: a customer tenancy is neither the platform's own nor a
 * demonstration, and demonstration is decided from the identities in it — the
 * mark the seed writes and no route can set. Every figure about the business
 * reads customers; the administrative register still lists a demonstration,
 * marked as one, so an operator can credit and inspect it.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;
let operatorToken: string;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const operator = platform.user(seed.users.operator!.id);
  operatorToken = issueTokens({
    actorId: operator.id,
    tenantId: operator.tenantId,
    partyId: operator.partyId,
    roles: operator.roles,
    mfaSatisfied: true,
  }).accessToken;
});

after(() => server.close());

async function read<T>(path: string): Promise<T> {
  const response = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${operatorToken}` } });
  assert.equal(response.status, 200, `${path} answered ${response.status}`);
  return (await response.json()) as T;
}

describe('a demonstration is not a customer', () => {
  it('is decided from the mark the seed writes on its identities', () => {
    assert.equal(platform.isDemonstrationTenant(seed.tenantId), true);
    assert.equal(platform.isCustomerTenant(seed.tenantId), false);
    // The platform's own tenancy holds the operator and is not a customer either.
    assert.equal(platform.isCustomerTenant(PLATFORM_TENANT_ID), false);
    assert.deepEqual(platform.customerTenants(), []);
  });

  it('counts no revenue, no tenancy and no top-up from it on the estate overview', async () => {
    const overview = await read<{
      tenancies: { total: number; active: number };
      revenue: { lifetimeMinor: number; receipts: number; runRateMinor: number | null };
      awaitingPayment: unknown;
    }>('/v1/admin/overview');
    // The seed credited the demonstration through the payment path. That is a
    // receipt on the demonstration's own record and nothing the business took.
    assert.equal(overview.revenue.lifetimeMinor, 0);
    assert.equal(overview.revenue.receipts, 0);
    assert.equal(overview.revenue.runRateMinor, null);
    assert.equal(overview.tenancies.total, 0);
  });

  it('lists it on the tenancy register, marked, and never lists the platform itself', async () => {
    const estate = await read<{
      tenants: Array<{ id: string; legalName: string; demonstration: boolean }>;
      estate: { tenancies: number };
    }>('/v1/admin/tenants');
    const demo = estate.tenants.find((tenant) => tenant.id === seed.tenantId);
    assert.ok(demo, 'the demonstration must still be administrable from the register');
    assert.equal(demo.demonstration, true);
    assert.equal(
      estate.tenants.some((tenant) => tenant.id === PLATFORM_TENANT_ID),
      false,
      'the house tenancy was listed as a customer with nobody in it',
    );
    assert.equal(estate.estate.tenancies, 0, 'storage committed counts customers only');
  });

  it('raises no forecast signal about the platform itself or the demonstration', async () => {
    const forecast = await read<{ signals: Array<{ tenantId: string; headline: string }> }>('/v1/admin/forecast');
    const offenders = forecast.signals.filter(
      (signal) => signal.tenantId === PLATFORM_TENANT_ID || signal.tenantId === seed.tenantId,
    );
    assert.deepEqual(
      offenders.map((signal) => signal.headline),
      [],
      'the operator was being told nobody could run their own platform, and to speak to the demonstration about its renewal',
    );
  });

  it('shows no demonstration receipt on the estate payment record, and does when asked about that tenancy', async () => {
    const estate = await read<{ receipts: Array<{ tenantId: string }> }>('/v1/admin/payments');
    assert.equal(estate.receipts.some((receipt) => receipt.tenantId === seed.tenantId), false);

    // The row's own Credit button asks by tenancy, and the operator crediting
    // the demonstration needs to see what it already holds.
    const own = await read<{ receipts: Array<{ tenantId: string }> }>(`/v1/admin/payments?tenantId=${seed.tenantId}`);
    assert.equal(own.receipts.length > 0, true);
    assert.equal(own.receipts.every((receipt) => receipt.tenantId === seed.tenantId), true);
  });
});

describe('a customer is counted the moment there is one', () => {
  it('appears in every figure the demonstration was excluded from', async () => {
    const { tenant } = platform.createTenant({
      legalName: 'Halden Civil Engineering Ltd',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'ENTERPRISE',
      enterpriseName: 'Halden Civil Engineering',
    });
    platform.creditFromPayment({
      tenantId: tenant.id,
      amountMinor: 250_000,
      method: 'BANK_TRANSFER',
      reference: `HALDEN-${tenant.id}`,
      recordedBy: 'operator',
      note: 'First prepaid purchase',
    });

    assert.equal(platform.isCustomerTenant(tenant.id), true);
    assert.deepEqual(
      platform.customerTenants().map((customer) => customer.id),
      [tenant.id],
    );

    const overview = await read<{ tenancies: { total: number }; revenue: { lifetimeMinor: number; receipts: number } }>(
      '/v1/admin/overview',
    );
    assert.equal(overview.tenancies.total, 1);
    assert.equal(overview.revenue.lifetimeMinor, 250_000);
    assert.equal(overview.revenue.receipts, 1);

    const estate = await read<{ tenants: Array<{ id: string; demonstration: boolean; lifetimeRevenueMinor: number }> }>(
      '/v1/admin/tenants',
    );
    const row = estate.tenants.find((candidate) => candidate.id === tenant.id);
    assert.ok(row);
    assert.equal(row.demonstration, false);
    assert.equal(row.lifetimeRevenueMinor, 250_000);

    // The new tenancy has nobody in it yet, which *is* worth a signal — it is a
    // customer nobody can run. The rule excludes what is not a customer; it
    // does not soften what is.
    const forecast = await read<{ signals: Array<{ tenantId: string; headline: string }> }>('/v1/admin/forecast');
    assert.equal(
      forecast.signals.some((signal) => signal.tenantId === tenant.id && /administrator/i.test(signal.headline)),
      true,
    );
  });
});
