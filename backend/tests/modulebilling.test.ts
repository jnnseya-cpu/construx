import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as collection from '../src/billing/collection.ts';
import { moduleCharges, moduleMonthlyMinor, MODULE_ADDITIONAL_SEAT_FEE_MINOR, MODULE_BASE_FEE_MINOR } from '../src/billing/modules.ts';
import { PACKAGES } from '../src/billing/seats.ts';
import { MODULES, type ModuleId } from '../src/identity/modules.ts';
import { Platform } from '../src/platform.ts';

/**
 * Every private module is a monthly item on the company's subscription: £100
 * including one named seat, £50 for each further seat, raised with the package
 * in the same monthly charge and shown on the same invoice — and free for an
 * exempt account.
 */

const DAY = 24 * 60 * 60 * 1000;

function company(options: { exempt?: boolean } = {}) {
  const platform = new Platform();
  const operator = platform.createOperator({ name: 'Ruth', email: 'ops@construx.example' });
  const { tenant } = platform.createTenant({
    legalName: 'Billed Ltd',
    jurisdiction: 'GB',
    defaultCurrency: 'GBP',
    tier: 'TEAM',
    package: 'CORE_PROJECT',
    enterpriseName: 'Billed',
    deferOpeningCharge: true,
  });
  if (platform.subscription(tenant.id).status !== 'ACTIVE') {
    platform.setSubscriptionStatus({ tenantId: tenant.id, status: 'ACTIVE', reason: 'Paying customer', decidedBy: operator.id });
  }
  if (options.exempt) {
    platform.setSubscriptionPackage({ tenantId: tenant.id, package: 'CORE_PROJECT', reason: 'Exempt by agreement', decidedBy: operator.id, grantFree: true });
  }
  const grant = (moduleId: ModuleId, seats?: number) =>
    platform.setModuleGrant({
      moduleId,
      tenantId: tenant.id,
      status: 'ACTIVE',
      reason: 'Sold to this company',
      decidedBy: operator.id,
      ...(moduleId === 'BID_ON' ? { agreementRef: 'ORDER-0042' } : {}),
      ...(seats !== undefined ? { seats } : {}),
    });
  return { platform, operator, tenantId: tenant.id, grant };
}

describe('the price of a module', () => {
  it('is the same for every module: the base with one seat, and each further seat on top', () => {
    assert.equal(MODULE_BASE_FEE_MINOR, 10_000);
    assert.equal(MODULE_ADDITIONAL_SEAT_FEE_MINOR, 5_000);
    assert.equal(moduleMonthlyMinor(1), 10_000);
    assert.equal(moduleMonthlyMinor(3), 20_000);
    assert.deepEqual(moduleCharges([{ moduleId: 'IMS', name: 'IMS', seats: 2 }], true), [], 'an exempt account pays nothing for it');
    for (const definition of Object.values(MODULES)) assert.match(definition.restricted, /£100\/month including one named seat, plus £50\/month for each additional seat/);
  });
});

describe('a module on the monthly subscription', () => {
  it('is raised with the package in the monthly charge, at the seats it is held with', () => {
    const { platform, tenantId, grant } = company();
    grant('PLANNING');
    grant('IMS', 3);
    grant('CONTRACTS_STUDIO');
    const charges = platform.moduleCharges(tenantId);
    assert.deepEqual(
      charges.map((charge) => [charge.moduleId, charge.seats, charge.amountMinor]),
      [
        ['PLANNING', 1, 10_000],
        ['IMS', 3, 20_000],
        ['CONTRACTS_STUDIO', 1, 10_000],
      ],
    );
    const subscription = platform.subscription(tenantId);
    const raised = collection.raiseCharge(platform, tenantId, new Date(Date.parse(subscription.renewsAt) + DAY));
    assert.ok(raised && !raised.alreadyRaised);
    assert.equal(raised!.charge.amountMinor, PACKAGES.CORE_PROJECT.monthlyPriceMinor + 40_000);
  });

  it('shows on the invoice as its own line, and in the total', () => {
    const { platform, tenantId, grant } = company();
    grant('ETABLIX', 2);
    const invoice = platform.previewInvoice(tenantId, new Date().toISOString().slice(0, 7));
    const line = invoice.lines.find((entry) => entry.category === 'MODULES')!;
    assert.equal(line.amountMinor, 15_000);
    assert.match(line.description, /ETABLIX AI Site Services — monthly, 2 named seats \(one included, 1 at £50\.00\)/);
    assert.equal(invoice.modulesMinor, 15_000);
    assert.equal(invoice.totalMinor, invoice.subscriptionMinor + invoice.seatsMinor + invoice.passesMinor + invoice.storageMinor + 15_000);
    assert.ok(invoice.commercialTerms.some((term) => /private module held is charged monthly/.test(term)));
  });

  it('comes off the bill when it is revoked, and a change of seats is recorded as one', () => {
    const { platform, operator, tenantId, grant } = company();
    grant('BID_ON');
    const before = platform.ledger.events().length;
    grant('BID_ON');
    assert.equal(platform.ledger.events().length, before, 'the same allocation again changes nothing');
    grant('BID_ON', 4);
    assert.equal(platform.ledger.events().length, before + 1, 'new seats are a new decision on the record');
    assert.equal(platform.moduleCharges(tenantId)[0]!.amountMinor, 25_000);
    grant('BID_ON');
    assert.equal(platform.moduleCharges(tenantId)[0]!.seats, 4, 'a re-grant without seats keeps what the company holds');
    platform.setModuleGrant({ moduleId: 'BID_ON', tenantId, status: 'REVOKED', reason: 'Agreement ended', decidedBy: operator.id });
    assert.deepEqual(platform.moduleCharges(tenantId), []);
    assert.throws(() => grant('BID_ON', 0), (error: { code?: string }) => error.code === 'MODULE_SEATS_INVALID');
  });

  it('bills Grid at the seats its provisioning records as paid, where that is more', () => {
    const { platform, operator, tenantId, grant } = company();
    grant('GRID_CONNECTION');
    platform.setAddonGrant({ tenantId, adminGrant: true, providerStatus: 'ACTIVE', paidQuantity: 3, decidedBy: operator.id });
    assert.equal(platform.moduleCharges(tenantId)[0]!.amountMinor, 20_000);
  });

  it('is free for an exempt account, and nothing is raised for it', () => {
    const { platform, tenantId, grant } = company({ exempt: true });
    grant('PLANNING', 5);
    assert.deepEqual(platform.moduleCharges(tenantId), []);
    const subscription = platform.subscription(tenantId);
    assert.equal(collection.raiseCharge(platform, tenantId, new Date(Date.parse(subscription.renewsAt) + DAY)), undefined);
  });
});
