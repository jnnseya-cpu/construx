import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createGateway } from '../src/api/gateway.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { bareConstructionProject } from './helpers.ts';

/**
 * CN-WF-05 deliveries / goods-in, driven through the real HTTP gateway with the
 * exact request bodies the console's new commands send.
 *
 * The backend delivery ladder was already complete and tested, but Construction
 * only ever read `/procurement-items`. There was no way from the product to
 * register an item, book a delivery, receive it, quarantine or release it,
 * accept it into stock, or install a serial. This proves the commands added to
 * `construction.js` post bodies each route accepts and that a delivery walks
 * the ladder the platform enforces: register → book → receive → accept →
 * install, with the safety-critical quarantine-and-release branch alongside it.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;
let projectId: string;

type Who = 'qs' | 'pm' | 'siteManager' | 'qaqc';

const tokenFor = (who: Who): string => {
  const auth = seed.users[who]!.auth;
  return issueTokens({
    actorId: auth.actorId,
    tenantId: auth.tenantId,
    enterpriseId: auth.enterpriseId,
    roles: auth.roles,
    mfaSatisfied: true,
  }).accessToken;
};

async function call(
  method: string,
  path: string,
  who: Who,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${tokenFor(who)}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const position = async (): Promise<Record<string, unknown>> => {
  const { json } = await call('GET', `/v1/projects/${projectId}/procurement-items`, 'qs');
  return json;
};

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  ({ projectId } = await bareConstructionProject(platform, seed, 'Delivery gateway fixture'));

  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

describe('the delivery vertical completes through the gateway', () => {
  it('registers, books, receives, accepts and installs a serial', async () => {
    // register-item: the buyer (PROCUREMENT_AWARD C). Not safety-critical, so
    // it is not quarantined on arrival.
    const registered = await call('POST', `/v1/projects/${projectId}/procurement-items`, 'qs', {
      reference: 'PI-100',
      description: 'DN300 penstock valve, flanged, manual gearbox',
      quantity: 2,
      unit: 'nr',
      requiredOnSiteBy: day(120),
      leadTimeDays: 70,
      safetyCritical: false,
      unitRateMinor: 480_000,
    });
    assert.equal(registered.status, 201, JSON.stringify(registered.json));
    const itemId = String(registered.json.itemId);

    // advance-milestone: the order is placed, with the evidence it rests on.
    const ordered = await call('POST', `/v1/projects/${projectId}/procurement-items/${itemId}/milestones`, 'qs', {
      step: 'ORDER',
      evidence: 'PO-9100',
    });
    assert.equal(ordered.status, 201, JSON.stringify(ordered.json));

    // book-delivery: the site (FIELD_EXECUTION C).
    const booked = await call('POST', `/v1/projects/${projectId}/procurement-items/${itemId}/deliveries`, 'pm', {
      bookedFor: day(60),
      slot: '09:00-10:00',
      craneRequired: false,
    });
    assert.equal(booked.status, 201, JSON.stringify(booked.json));
    const deliveryId = String(booked.json.deliveryId);

    // receive-delivery: what turned up, with the traceable units the receive
    // transform parses from the textarea.
    const received = await call('POST', `/v1/projects/${projectId}/deliveries/${deliveryId}/receive`, 'siteManager', {
      deliveryNote: 'DN-100',
      dispatchedQuantity: 2,
      receivedQuantity: 2,
      condition: 'Sound, no visible damage',
      damaged: false,
      units: [
        { identifier: 'VLV-0001', certificate: 'TestCert-88213' },
        { identifier: 'VLV-0002', certificate: 'TestCert-88214' },
      ],
      evidenceHash: 'del-100-receive',
    });
    assert.equal(received.status, 201, JSON.stringify(received.json));
    assert.equal(received.json.state, 'RECEIVED');
    assert.equal(received.json.quarantined, false);

    // accept-delivery: the site (FIELD_EXECUTION A). Quantities reconcile, so
    // no reconciliation object is sent.
    const accepted = await call('POST', `/v1/projects/${projectId}/deliveries/${deliveryId}/accept`, 'pm', {
      note: 'Two valves checked against the delivery note and taken into stock.',
    });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.json));
    assert.equal(accepted.json.inventoryQuantity, 2);
    assert.equal(accepted.json.accrualMinor, 960_000);

    // install-unit: a serial, where it went and the test that proves it works.
    const installed = await call('POST', `/v1/projects/${projectId}/deliveries/${deliveryId}/install`, 'pm', {
      identifier: 'VLV-0001',
      location: 'Inlet chamber, grid E4',
      testEvidence: 'Operational test sheet OT-14, passed',
    });
    assert.equal(installed.status, 201, JSON.stringify(installed.json));
    assert.equal(installed.json.identifier, 'VLV-0001');

    const pos = await position();
    const installedList = (pos.installed as Array<Record<string, unknown>>) ?? [];
    assert.ok(
      installedList.some((u) => u.identifier === 'VLV-0001' && u.location === 'Inlet chamber, grid E4'),
      'the installed serial is on the procurement position',
    );
  });

  it('quarantines a safety-critical delivery with no certificate, then releases and accepts it', async () => {
    const registered = await call('POST', `/v1/projects/${projectId}/procurement-items`, 'qs', {
      reference: 'PI-200',
      description: 'M24 structural holding-down bolts, grade 8.8',
      quantity: 50,
      unit: 'nr',
      requiredOnSiteBy: day(90),
      leadTimeDays: 30,
      safetyCritical: true,
      unitRateMinor: 1_200,
    });
    const itemId = String(registered.json.itemId);
    await call('POST', `/v1/projects/${projectId}/procurement-items/${itemId}/milestones`, 'qs', {
      step: 'ORDER',
      evidence: 'PO-9200',
    });
    const booked = await call('POST', `/v1/projects/${projectId}/procurement-items/${itemId}/deliveries`, 'pm', {
      bookedFor: day(45),
      slot: '11:00-12:00',
      craneRequired: false,
    });
    const deliveryId = String(booked.json.deliveryId);

    // Safety-critical, received with a traceable unit but no certificate — the
    // platform quarantines it on arrival.
    const received = await call('POST', `/v1/projects/${projectId}/deliveries/${deliveryId}/receive`, 'siteManager', {
      deliveryNote: 'DN-200',
      dispatchedQuantity: 50,
      receivedQuantity: 50,
      condition: 'Boxed, intact',
      damaged: false,
      units: [{ identifier: 'BATCH-8213' }],
      evidenceHash: 'del-200-receive',
    });
    assert.equal(received.status, 201, JSON.stringify(received.json));
    assert.equal(received.json.quarantined, true);
    assert.equal(received.json.state, 'QUARANTINED');

    // It cannot be accepted while quarantined.
    const blocked = await call('POST', `/v1/projects/${projectId}/deliveries/${deliveryId}/accept`, 'pm', {
      note: 'Trying to accept a quarantined load.',
    });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.json));
    assert.equal(blocked.json.title, 'QUARANTINED');

    // release-delivery: quality authority (QUALITY_COMMISSIONING A), supplying
    // the certificate that was missing.
    const released = await call('POST', `/v1/projects/${projectId}/deliveries/${deliveryId}/release`, 'qaqc', {
      reason: 'Mill certificate located and matched to the batch.',
      units: [{ identifier: 'BATCH-8213', certificate: 'MillCert-8213' }],
    });
    assert.equal(released.status, 201, JSON.stringify(released.json));
    assert.equal(released.json.released, true);

    // Now it accepts.
    const accepted = await call('POST', `/v1/projects/${projectId}/deliveries/${deliveryId}/accept`, 'pm', {
      note: 'Bolts accepted into stock with the mill certificate on file.',
    });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.json));
    assert.equal(accepted.json.inventoryQuantity, 50);
  });
});
