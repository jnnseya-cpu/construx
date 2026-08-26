import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { isPlatformGovernanceEvent } from '../src/goldenthread/eventTypes.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject } from '../src/seed.ts';

/**
 * The operator's governance record.
 *
 * An operator can open a tenancy, suspend a paying customer's platform, credit a
 * wallet with money and appoint somebody who can do all three. None of that was
 * readable anywhere: the acts were in the ledger, and the ledger was reachable
 * only per project, through routes scoped to a tenant the operator is not in. So
 * the most consequential surface on the platform was also the only unaudited one
 * from the point of view of the person using it.
 *
 * The boundary is the interesting part, and the first attempt at it was wrong.
 * Every governance act is written to a `<tenantId>-governance` project, so
 * selecting those projects looked like a clean structural boundary — and it
 * handed the operator a customer's portfolios, programmes, suppliers and bid
 * pipeline, because that project is where *everything tenant-scoped* is written.
 * Every test passed, because a fresh fixture has no delivery data on it to leak.
 *
 * It is now an explicit allow-list of event codes, `PLATFORM_GOVERNANCE_EVENTS`,
 * and the suite below runs part of itself against a seeded tenancy that has
 * actually done work — which is the only way the original defect was ever going
 * to be visible.
 *
 * The other property worth a test: the screen says "hash-chained", and that is
 * only worth saying if something has walked the chain. It is verified on every
 * request through the same replay engine the project audit uses, not asserted.
 */

let server: Server;
let base: string;
let platform: Platform;
let operatorToken: string;
let customerToken: string;
let customerTenantId: string;

before(async () => {
  platform = new Platform();

  const operator = platform.createOperator({ name: 'Operator', email: 'ops@construxvg.com' });
  operatorToken = issueTokens({
    actorId: operator.id,
    tenantId: operator.tenantId,
    roles: operator.roles,
    mfaSatisfied: true,
  }).accessToken;

  const { tenant } = platform.createTenant({
    legalName: 'Meridian Infrastructure Ltd',
    enterpriseName: 'Meridian Group',
    jurisdiction: 'GB',
    defaultCurrency: 'GBP',
    tier: 'TEAM',
  });
  customerTenantId = tenant.id;

  const customer = platform.createUser({
    tenantId: tenant.id,
    name: 'Rowan',
    email: 'rowan@meridian.test',
    roles: ['ENTERPRISE_ADMIN'],
  });
  customerToken = issueTokens({
    actorId: customer.id,
    tenantId: customer.tenantId,
    roles: customer.roles,
    mfaSatisfied: true,
  }).accessToken;

  // Acts an operator is accountable for, so there is a record to read.
  platform.setSubscriptionStatus({
    tenantId: tenant.id,
    status: 'SUSPENDED',
    reason: 'non-payment, pending review',
    decidedBy: operator.id,
  });
  platform.creditFromPayment({
    tenantId: tenant.id,
    amountMinor: 25_000,
    method: 'BANK_TRANSFER',
    reference: 'BACS-GOV-0001',
    recordedBy: operator.id,
    source: 'OPERATOR',
  });

  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

type Record = {
  total: number;
  intact: boolean;
  byType: Record_<string, number>;
  chains: Array<{ projectId: string; tenant: string; verified: number; failures: number; chainHead: string }>;
  events: Array<{
    eventType: string;
    tenant: string;
    entity: { refType: string; refId: string };
    chainHash?: string;
    afterHash: string;
  }>;
};
type Record_<K extends string, V> = { [key in K]: V };

const read = async (): Promise<Record> => {
  const response = await fetch(`${base}/v1/admin/audit`, { headers: { authorization: `Bearer ${operatorToken}` } });
  assert.equal(response.status, 200);
  return (await response.json()) as Record;
};

describe('what the governance record contains', () => {
  it('carries the acts an operator is answerable for', async () => {
    const record = await read();

    for (const act of ['TENANT_CREATED', 'USER_CREATED', 'SUBSCRIPTION_STATUS_CHANGED', 'PAYMENT_RECEIVED']) {
      assert.ok(record.byType[act], `${act} is missing from the governance record`);
    }
  });

  it('names the tenancy each act was performed on', async () => {
    // An audit line that says a subscription was suspended without saying whose
    // is not an audit line.
    const record = await read();
    const suspension = record.events.find((event) => event.eventType === 'SUBSCRIPTION_STATUS_CHANGED');

    assert.ok(suspension, 'the suspension is not in the record');
    assert.equal(suspension.tenant, 'Meridian Infrastructure Ltd');
  });

  it('carries both hashes on every event', async () => {
    // The per-entity hash proves the record was not edited. The chain hash
    // proves none was deleted or reordered around it, which a per-entity hash
    // alone cannot detect.
    const record = await read();
    assert.ok(record.events.length > 0);

    for (const event of record.events) {
      assert.ok(event.afterHash, `${event.eventType} carries no entity hash`);
      assert.ok(event.chainHash, `${event.eventType} carries no chain hash`);
    }
  });

  it('reports the chain as verified rather than asserting it', async () => {
    const record = await read();

    assert.equal(record.intact, true);
    assert.ok(record.chains.length > 0, 'no chain was walked');
    for (const chain of record.chains) {
      assert.equal(chain.failures, 0);
      assert.ok(chain.verified > 0, `${chain.projectId} reported no verified events`);
      assert.ok(chain.chainHead, `${chain.projectId} has no chain head`);
    }
  });
});

describe('the account boundary', () => {
  /**
   * The test that would have caught the first attempt, and did not exist.
   *
   * The original filter selected every event on a `-governance` project. That
   * looked right, passed every test, and was wrong: the governance project is
   * where all tenant-scoped work is written, so it handed the operator a
   * customer's portfolios, programmes, suppliers and bid pipeline. It was
   * invisible because the fixture had no delivery data on it — which is what
   * every fresh `new Platform()` is.
   *
   * So this suite runs against a tenancy that has actually done work, and the
   * assertion is stated against the whole ledger rather than against the
   * fixture's expectations.
   */
  it('shows nothing but the acts the catalogue names as governance', async () => {
    const record = await read();
    for (const event of record.events) {
      assert.ok(
        isPlatformGovernanceEvent(event.eventType),
        `${event.eventType} is not a platform governance act and reached the operator`,
      );
    }
  });

  it('withholds every event the catalogue does not name, on a tenancy that has done real work', async () => {
    // A seeded estate, so there is genuine delivery data to leak. Anything the
    // allow-list does not name must be absent — checked by counting, so an
    // event type added to the platform later is caught rather than assumed.
    const seeded = new Platform();
    const operator = seeded.createOperator({ name: 'Operator', email: 'ops2@construxvg.com' });
    await seedDemoProject(seeded);

    const token = issueTokens({
      actorId: operator.id,
      tenantId: operator.tenantId,
      roles: operator.roles,
      mfaSatisfied: true,
    }).accessToken;

    const local = createGateway(seeded);
    await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));

    try {
      const url = `http://127.0.0.1:${(local.address() as { port: number }).port}/v1/admin/audit?limit=100000`;
      const body = (await (await fetch(url, { headers: { authorization: `Bearer ${token}` } })).json()) as Record;

      const all = seeded.ledger.events({});
      const withheld = all.filter((event) => !isPlatformGovernanceEvent(event.eventType));

      assert.ok(withheld.length > 0, 'the fixture produced no delivery data, so this test proves nothing');
      assert.equal(
        body.total,
        all.length - withheld.length,
        'the governance record is not exactly the governance acts',
      );

      // Named explicitly, because these are the shapes whose exposure matters
      // most and the ones the broken filter actually leaked.
      for (const leaked of ['Opportunity', 'Supplier', 'Programme', 'Portfolio', 'RadarRun', 'DailyLog', 'WorkPackage']) {
        assert.ok(
          !body.events.some((event) => event.entity.refType === leaked),
          `${leaked} reached the operator through the governance record`,
        );
      }
    } finally {
      local.close();
    }
  });

  it('names no delivery entity type', async () => {
    const record = await read();
    const delivery = ['DailyLog', 'WorkPackage', 'Drawing', 'RFI', 'Inspection', 'Opportunity', 'Supplier'];

    for (const event of record.events) {
      assert.ok(
        !delivery.includes(event.entity.refType),
        `${event.entity.refType} reached the operator through the governance audit`,
      );
    }
  });
});

describe('who may read it', () => {
  it('refuses an anonymous caller', async () => {
    const response = await fetch(`${base}/v1/admin/audit`);
    assert.equal(response.status, 401);
  });

  it('refuses the most privileged customer identity', async () => {
    // It spans every tenancy on the estate. An enterprise admin reading it would
    // see who else is a customer, what they pay and when they were suspended.
    const response = await fetch(`${base}/v1/admin/audit`, {
      headers: { authorization: `Bearer ${customerToken}` },
    });
    assert.equal(response.status, 403, 'a customer read the estate-wide governance record');
  });

  it('keeps the tenancy that customer belongs to out of their reach entirely', async () => {
    // Not a filtered view — no view. The route is the operator surface.
    void customerTenantId;
    const response = await fetch(`${base}/v1/admin/audit?limit=1`, {
      headers: { authorization: `Bearer ${customerToken}` },
    });
    assert.equal(response.status, 403);
  });
});
