import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as delivery from '../src/domain/delivery.ts';
import * as structure from '../src/domain/structure.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * CN-WF-05 — resource, material, delivery and procurement control.
 *
 * The platform could buy and could not receive. What is tested is the four
 * failures that costs a project money: a long lead nobody was tracking, a
 * delivery nobody could take, a quantity nobody reconciled, and a
 * safety-critical product with no certificate.
 */

let platform: Platform;
let seed: SeedResult;

/** Holds PROCUREMENT_AWARD C and U — registers and tracks items. */
const asQS = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });
/** Holds FIELD_EXECUTION C, U and A — books, receives and accepts. */
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
/** Holds FIELD_EXECUTION C — receives. Cannot accept. */
const asSiteManager = () => platform.context(seed.users.siteManager!.auth, seed.projectId, { source: 'PWA' });
/** Holds QUALITY_COMMISSIONING A — releases from quarantine. */
const asQAQC = () => platform.context(seed.users.qaqc!.auth, seed.projectId, { source: 'WEB' });

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

let sequence = 0;

function item(overrides: Partial<Parameters<typeof delivery.registerProcurementItem>[1]> = {}) {
  sequence += 1;
  return delivery.registerProcurementItem(asQS(), {
    reference: `PI-${String(sequence).padStart(3, '0')}`,
    description: 'DN300 penstock valve, flanged, manual gearbox',
    quantity: 4,
    unit: 'nr',
    requiredOnSiteBy: day(120),
    leadTimeDays: 70,
    safetyCritical: false,
    unitRateMinor: 480_000,
    ...overrides,
  });
}

/** An item taken through to an accepted delivery. */
function delivered(
  options: { safetyCritical?: boolean; units?: delivery.TraceableUnit[]; receivedQuantity?: number } = {},
): { itemId: string; deliveryId: string } {
  const { itemId } = item({ safetyCritical: options.safetyCritical ?? false });
  delivery.advanceProcurement(asQS(), itemId, { step: 'ORDER', evidence: 'PO-9001' });
  sequence += 1;
  const { deliveryId } = delivery.bookDelivery(asPM(), itemId, {
    bookedFor: day(60 + sequence),
    slot: `0${(sequence % 8) + 1}:00-10:00`,
    craneRequired: false,
  });
  delivery.receiveDelivery(asSiteManager(), deliveryId, {
    deliveryNote: `DN-${sequence}`,
    dispatchedQuantity: 4,
    receivedQuantity: options.receivedQuantity ?? 4,
    // Deliberately contains the word "damage": an earlier version read the
    // free-text condition for it and reported a sound delivery as damaged.
    condition: 'Sound, no visible damage',
    units: options.units ?? [],
    evidenceHash: `del-${sequence}`,
  });
  return { itemId, deliveryId };
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'CONSTRUCTION',
    justification: 'Receiving material',
  });
});

describe('CN-WF-05 the register', () => {
  it('registers its seven event types', () => {
    for (const [code, entity] of [
      ['ORDER_PLACED', 'ProcurementItem'],
      ['MANUFACTURING_MILESTONE_UPDATED', 'ProcurementItem'],
      ['DELIVERY_BOOKED', 'Delivery'],
      ['DELIVERY_RECEIVED', 'Delivery'],
      ['MATERIAL_QUARANTINED', 'Delivery'],
      ['MATERIAL_ACCEPTED', 'Delivery'],
      ['MATERIAL_INSTALLED', 'Delivery'],
    ] as const) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, entity);
      // "Human confirmation for safety-critical items."
      assert.equal(definition.aiAllowed, false);
    }
    assert.equal(lookupEventType('MATERIAL_ACCEPTED')?.action, 'APPROVE');
  });

  it('classifies both entities with the buying', () => {
    assert.equal(classifyEntity('ProcurementItem')?.area, 'PROCUREMENT_AWARD');
    assert.equal(classifyEntity('Delivery')?.area, 'PROCUREMENT_AWARD');
  });
});

describe('AC-CN-WF-05-01 a long lead is late on the day it is ordered', () => {
  it('derives the date it had to be ordered by', () => {
    const result = item({ requiredOnSiteBy: day(120), leadTimeDays: 70 });
    assert.equal(result.orderBy, day(50));
    assert.equal(result.alreadyLate, false);
  });

  it('says so before anybody has done anything wrong', () => {
    // Fourteen weeks of lead time, eleven weeks until it is needed.
    const result = item({ requiredOnSiteBy: day(77), leadTimeDays: 98 });
    assert.equal(result.alreadyLate, true);
    const position = delivery.procurementPosition(asQS());
    assert.ok(position.atRisk.some((entry) => entry.reference === result.reference));
    assert.match(position.summary, /past the date they had to be ordered/);
  });

  it('refuses an item with no need date or no lead time', () => {
    throwsCode(() => item({ requiredOnSiteBy: 'soon' }), 'NEED_DATE_REQUIRED');
    throwsCode(() => item({ leadTimeDays: -1 }), 'LEAD_TIME_REQUIRED');
  });

  it('refuses an unidentified item, or a second one with the same reference', () => {
    throwsCode(() => item({ reference: '  ' }), 'ITEM_UNIDENTIFIED');
    const first = item();
    throwsCode(() => item({ reference: first.reference }), 'ITEM_REFERENCE_TAKEN');
  });
});

describe('CN-WF-05 every step names its evidence', () => {
  it('refuses a milestone with nothing behind it', () => {
    const { itemId } = item();
    throwsCode(
      () => delivery.advanceProcurement(asQS(), itemId, { step: 'MANUFACTURE', evidence: '  ' }),
      'MILESTONE_UNEVIDENCED',
    );
  });

  it('records the steps that were skipped rather than passing over them', () => {
    // Nothing imported has a customs step, and that is a legitimate skip.
    const { itemId } = item();
    delivery.advanceProcurement(asQS(), itemId, { step: 'ORDER', evidence: 'PO-9002' });
    const result = delivery.advanceProcurement(asQS(), itemId, { step: 'SHIPMENT', evidence: 'Bill of lading BL-77' });
    assert.deepEqual(result.skipped, ['DESIGN_APPROVAL', 'MANUFACTURE', 'FAT']);
  });

  it('refuses a status that goes backwards', () => {
    const { itemId } = item();
    delivery.advanceProcurement(asQS(), itemId, { step: 'MANUFACTURE', evidence: 'Works order 4412' });
    throwsCode(
      () => delivery.advanceProcurement(asQS(), itemId, { step: 'ORDER', evidence: 'PO-9003' }),
      'MILESTONE_REGRESSION',
    );
  });

  it('refuses to declare delivery or acceptance rather than record them', () => {
    // An item marked delivered with nothing on site is the status every
    // procurement report has and nobody trusts.
    const { itemId } = item();
    throwsCode(
      () => delivery.advanceProcurement(asQS(), itemId, { step: 'DELIVERY', evidence: 'The supplier said so' }),
      'STEP_NOT_ASSERTABLE',
    );
  });
});

describe('CN-WF-05 two lifts in one slot', () => {
  it('refuses a second crane booking in the same slot on the same day', () => {
    const first = item();
    const second = item();
    delivery.bookDelivery(asPM(), first.itemId, { bookedFor: day(30), slot: '08:00-10:00', craneRequired: true });
    throwsCode(
      () => delivery.bookDelivery(asPM(), second.itemId, { bookedFor: day(30), slot: '08:00-10:00', craneRequired: true }),
      'LIFT_SLOT_TAKEN',
    );
  });

  it('lets two deliveries share a slot when neither needs the crane', () => {
    const first = item();
    const second = item();
    delivery.bookDelivery(asPM(), first.itemId, { bookedFor: day(31), slot: '08:00-10:00', craneRequired: false });
    const result = delivery.bookDelivery(asPM(), second.itemId, {
      bookedFor: day(31),
      slot: '08:00-10:00',
      craneRequired: false,
    });
    assert.ok(result.deliveryId);
  });

  it('says when a booking lands after the date the programme needs it', () => {
    const { itemId } = item({ requiredOnSiteBy: day(40) });
    const result = delivery.bookDelivery(asPM(), itemId, {
      bookedFor: day(50),
      slot: '13:00-15:00',
      craneRequired: false,
    });
    assert.equal(result.afterNeedDate, true);
  });
});

describe('CN-WF-05 a safety-critical product with no certificate is quarantined', () => {
  it('quarantines on arrival when nothing traceable came with it', () => {
    const { itemId } = item({ safetyCritical: true });
    const { deliveryId } = delivery.bookDelivery(asPM(), itemId, {
      bookedFor: day(35),
      slot: '09:00-11:00',
      craneRequired: false,
    });
    const result = delivery.receiveDelivery(asSiteManager(), deliveryId, {
      deliveryNote: 'DN-SC-1',
      dispatchedQuantity: 4,
      receivedQuantity: 4,
      condition: 'Sound',
      evidenceHash: 'sc-1',
    });
    assert.equal(result.quarantined, true);
    assert.equal(result.state, 'QUARANTINED');

    const position = delivery.procurementPosition(asQS());
    assert.ok(position.quarantined.some((entry) => entry.reference === result.reference));
    assert.match(position.summary, /quarantined/);
  });

  it('quarantines a batch that arrived without its certificate', () => {
    const { itemId } = item({ safetyCritical: true });
    const { deliveryId } = delivery.bookDelivery(asPM(), itemId, {
      bookedFor: day(36),
      slot: '09:00-11:00',
      craneRequired: false,
    });
    const result = delivery.receiveDelivery(asSiteManager(), deliveryId, {
      deliveryNote: 'DN-SC-2',
      dispatchedQuantity: 2,
      receivedQuantity: 2,
      condition: 'Sound',
      units: [
        { identifier: 'HEAT-A1', certificate: 'Mill cert 3.1 ref 88221' },
        { identifier: 'HEAT-A2' },
      ],
      evidenceHash: 'sc-2',
    });
    assert.equal(result.quarantined, true);
  });

  it('refuses to accept quarantined material', () => {
    const { itemId } = item({ safetyCritical: true });
    const { deliveryId } = delivery.bookDelivery(asPM(), itemId, {
      bookedFor: day(37),
      slot: '09:00-11:00',
      craneRequired: false,
    });
    delivery.receiveDelivery(asSiteManager(), deliveryId, {
      deliveryNote: 'DN-SC-3',
      dispatchedQuantity: 4,
      receivedQuantity: 4,
      condition: 'Sound',
      evidenceHash: 'sc-3',
    });
    throwsCode(() => delivery.acceptDelivery(asPM(), deliveryId, { note: 'Looks fine.' }), 'QUARANTINED');
  });

  it('refuses a release that leaves the same gap', () => {
    const { itemId } = item({ safetyCritical: true });
    const { deliveryId } = delivery.bookDelivery(asPM(), itemId, {
      bookedFor: day(38),
      slot: '09:00-11:00',
      craneRequired: false,
    });
    delivery.receiveDelivery(asSiteManager(), deliveryId, {
      deliveryNote: 'DN-SC-4',
      dispatchedQuantity: 4,
      receivedQuantity: 4,
      condition: 'Sound',
      evidenceHash: 'sc-4',
    });
    throwsCode(
      () => delivery.releaseFromQuarantine(asQAQC(), deliveryId, { reason: 'Spoke to the supplier, it is fine.' }),
      'CERTIFICATE_STILL_MISSING',
    );
  });

  it('releases when the certificate arrives, on quality authority and not before', () => {
    const { itemId } = item({ safetyCritical: true });
    const { deliveryId } = delivery.bookDelivery(asPM(), itemId, {
      bookedFor: day(39),
      slot: '09:00-11:00',
      craneRequired: false,
    });
    delivery.receiveDelivery(asSiteManager(), deliveryId, {
      deliveryNote: 'DN-SC-5',
      dispatchedQuantity: 4,
      receivedQuantity: 4,
      condition: 'Sound',
      units: [{ identifier: 'HEAT-B1' }],
      evidenceHash: 'sc-5',
    });

    const withCert = [{ identifier: 'HEAT-B1', certificate: 'Mill cert 3.1 ref 90114, received by email 14th' }];
    // The site manager cannot clear it.
    throwsCode(
      () => delivery.releaseFromQuarantine(asSiteManager(), deliveryId, { reason: 'Cert arrived.', units: withCert }),
      'ACCESS_DENIED',
    );
    const result = delivery.releaseFromQuarantine(asQAQC(), deliveryId, {
      reason: 'Mill certificate 3.1 received and matched to heat number B1.',
      units: withCert,
    });
    assert.equal(result.released, true);
    assert.ok(delivery.acceptDelivery(asPM(), deliveryId, { note: 'Certificate matched; taken into stock.' }));
  });

  it('refuses an unexplained release', () => {
    const { deliveryId } = delivered({ safetyCritical: true });
    throwsCode(() => delivery.releaseFromQuarantine(asQAQC(), deliveryId, { reason: '  ' }), 'RELEASE_UNEXPLAINED');
  });
});

describe('CN-WF-05 a quantity nobody reconciled', () => {
  it('refuses acceptance of a short delivery with no reconciliation on it', () => {
    const { deliveryId } = delivered({ receivedQuantity: 3 });
    const refusal = throwsCode(
      () => delivery.acceptDelivery(asPM(), deliveryId, { note: 'Three of four.' }),
      'RECONCILIATION_REQUIRED',
    );
    assert.match(refusal.message ?? '', /3nr against 4nr/);
  });

  it('accepts it once the shortage names who is chasing it', () => {
    const { deliveryId } = delivered({ receivedQuantity: 3 });
    const result = delivery.acceptDelivery(asPM(), deliveryId, {
      note: 'Three valves taken into stock.',
      reconciliation: {
        kind: 'SHORT',
        what: 'One valve short; the supplier confirms it shipped on the following load.',
        chasedBy: 'L. Fenwick',
      },
    });
    assert.equal(result.inventoryQuantity, 3);

    const position = delivery.procurementPosition(asQS());
    assert.ok(position.reconciliations.some((entry) => entry.chasedBy === 'L. Fenwick'));
  });

  it('refuses a reconciliation with nobody chasing it', () => {
    const { deliveryId } = delivered({ receivedQuantity: 5 });
    throwsCode(
      () =>
        delivery.acceptDelivery(asPM(), deliveryId, {
          note: 'Five received.',
          reconciliation: { kind: 'OVER', what: 'One extra', chasedBy: '  ' },
        }),
      'RECONCILIATION_UNOWNED',
    );
  });

  it('refuses a receipt with no delivery note or no condition', () => {
    const { itemId } = item();
    const { deliveryId } = delivery.bookDelivery(asPM(), itemId, {
      bookedFor: day(41),
      slot: '11:00-13:00',
      craneRequired: false,
    });
    throwsCode(
      () =>
        delivery.receiveDelivery(asSiteManager(), deliveryId, {
          deliveryNote: '  ',
          dispatchedQuantity: 4,
          receivedQuantity: 4,
          condition: 'Sound',
          evidenceHash: 'x',
        }),
      'DELIVERY_NOTE_REQUIRED',
    );
    throwsCode(
      () =>
        delivery.receiveDelivery(asSiteManager(), deliveryId, {
          deliveryNote: 'DN-9',
          dispatchedQuantity: 4,
          receivedQuantity: 4,
          condition: '',
          evidenceHash: 'x',
        }),
      'CONDITION_REQUIRED',
    );
  });

  it('refuses a second receipt against one booking', () => {
    const { deliveryId } = delivered();
    throwsCode(
      () =>
        delivery.receiveDelivery(asSiteManager(), deliveryId, {
          deliveryNote: 'DN-again',
          dispatchedQuantity: 4,
          receivedQuantity: 4,
          condition: 'Sound',
          evidenceHash: 'again',
        }),
      'ALREADY_RECEIVED',
    );
  });
});

describe('AC-CN-WF-05-02 inventory and the accrual move once', () => {
  it('moves them on acceptance, and refuses a second acceptance', () => {
    const { itemId, deliveryId } = delivered();
    const result = delivery.acceptDelivery(asPM(), deliveryId, { note: 'Checked against the order and taken into stock.' });
    assert.equal(result.inventoryQuantity, 4);
    // Four at £4,800 each.
    assert.equal(result.accrualMinor, 1_920_000);

    throwsCode(() => delivery.acceptDelivery(asPM(), deliveryId, { note: 'Again.' }), 'ALREADY_ACCEPTED');

    const position = delivery.procurementPosition(asQS());
    const entry = position.items.find((row) => row.itemId === itemId)!;
    assert.equal(entry.inventoryQuantity, 4);
    assert.equal(entry.accrualMinor, 1_920_000);
    assert.equal(entry.step, 'ACCEPTANCE');
  });

  it('refuses acceptance from a role that can receive but not accept', () => {
    const { deliveryId } = delivered();
    throwsCode(() => delivery.acceptDelivery(asSiteManager(), deliveryId, { note: 'Mine.' }), 'ACCESS_DENIED');
  });

  it('refuses acceptance of something nothing has been received against', () => {
    const { itemId } = item();
    const { deliveryId } = delivery.bookDelivery(asPM(), itemId, {
      bookedFor: day(42),
      slot: '15:00-17:00',
      craneRequired: false,
    });
    throwsCode(() => delivery.acceptDelivery(asPM(), deliveryId, { note: 'Early.' }), 'NOT_RECEIVED');
  });
});

describe('AC-CN-WF-05-03 a serial, a location and a test', () => {
  it('records where an accepted unit went and what proves it works there', () => {
    const units = [{ identifier: 'SN-4471', certificate: 'Works test cert 5512' }];
    const { deliveryId } = delivered({ safetyCritical: true, units });
    delivery.acceptDelivery(asPM(), deliveryId, { note: 'Certificates matched.' });

    const result = delivery.installUnit(asPM(), deliveryId, {
      identifier: 'SN-4471',
      location: 'Inlet chamber, penstock position P2',
      testEvidence: 'Functional test sheet FT-118, witnessed 14th',
    });
    assert.equal(result.location, 'Inlet chamber, penstock position P2');

    const position = delivery.procurementPosition(asQS());
    const installed = position.installed.find((entry) => entry.identifier === 'SN-4471')!;
    assert.match(installed.testEvidence, /FT-118/);
  });

  it('refuses installing a serial nobody received', () => {
    const { deliveryId } = delivered({ safetyCritical: true, units: [{ identifier: 'SN-1', certificate: 'c' }] });
    delivery.acceptDelivery(asPM(), deliveryId, { note: 'Accepted.' });
    throwsCode(
      () =>
        delivery.installUnit(asPM(), deliveryId, {
          identifier: 'SN-NOT-DELIVERED',
          location: 'Somewhere',
          testEvidence: 'FT-1',
        }),
      'SERIAL_UNKNOWN',
    );
  });

  it('refuses one serial in two places', () => {
    const { deliveryId } = delivered({ safetyCritical: true, units: [{ identifier: 'SN-2', certificate: 'c' }] });
    delivery.acceptDelivery(asPM(), deliveryId, { note: 'Accepted.' });
    delivery.installUnit(asPM(), deliveryId, { identifier: 'SN-2', location: 'Position A', testEvidence: 'FT-2' });
    throwsCode(
      () => delivery.installUnit(asPM(), deliveryId, { identifier: 'SN-2', location: 'Position B', testEvidence: 'FT-3' }),
      'SERIAL_ALREADY_INSTALLED',
    );
  });

  it('refuses installing before acceptance', () => {
    const { deliveryId } = delivered({ units: [{ identifier: 'SN-3' }] });
    throwsCode(
      () => delivery.installUnit(asPM(), deliveryId, { identifier: 'SN-3', location: 'Position C', testEvidence: 'FT-4' }),
      'NOT_ACCEPTED',
    );
  });

  it('refuses an installation with no location or no test behind it', () => {
    const { deliveryId } = delivered({ units: [{ identifier: 'SN-5' }] });
    delivery.acceptDelivery(asPM(), deliveryId, { note: 'Accepted.' });
    throwsCode(
      () => delivery.installUnit(asPM(), deliveryId, { identifier: 'SN-5', location: '  ', testEvidence: 'FT-5' }),
      'INSTALLATION_UNTRACEABLE',
    );
    throwsCode(
      () => delivery.installUnit(asPM(), deliveryId, { identifier: 'SN-5', location: 'Position D', testEvidence: '' }),
      'INSTALLATION_UNTRACEABLE',
    );
  });
});
