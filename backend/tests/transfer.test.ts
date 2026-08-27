import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as structure from '../src/domain/structure.ts';
import * as transfer from '../src/domain/transfer.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * H-WF-07 — keys, access, credentials, spares, tools and service transfer.
 *
 * The tests that matter most here are the structural ones. AC-H-WF-07-02 says
 * no secret value appears in the audit log or export, and the way that is met is
 * that no field exists to put one in — so it is tested by walking the ledger and
 * the published position, not by asserting that a validator rejected something.
 */

let platform: Platform;
let seed: SeedResult;

const asFM = () => platform.context(seed.users.fm!.auth, seed.projectId, { source: 'WEB' });
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
/** Holds HANDOVER_OM R only — the read that is allowed and the write that is not. */
const asRegulator = () => platform.context(seed.users.regulator!.auth, seed.projectId, { source: 'WEB' });

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

async function freshProject() {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'HANDOVER',
    justification: 'Handing over the keys and the spares',
  });
}

function key(overrides: Record<string, unknown> = {}) {
  return transfer.registerTransferItem(asFM(), {
    reference: 'KEY-PLANT-01',
    kind: 'KEY',
    description: 'Plant room 1 door key, suited to the estates master',
    quantityRequired: 4,
    quantityHeld: 4,
    condition: 'New, cut from the master',
    storageLocation: 'Estates key cabinet, ground floor',
    critical: true,
    transferOwner: 'M&E subcontractor site manager',
    ...overrides,
  } as Parameters<typeof transfer.registerTransferItem>[1]);
}

function credential(overrides: Record<string, unknown> = {}) {
  return transfer.registerTransferItem(asFM(), {
    reference: 'CRED-BMS-ADMIN',
    kind: 'CREDENTIAL',
    description: 'BMS head-end administrator account for the estates team',
    quantityRequired: 1,
    quantityHeld: 1,
    condition: 'Active, password rotated at handover',
    storageLocation: 'Corporate secret store',
    critical: true,
    transferOwner: 'Controls subcontractor',
    vaultReference: 'vault://estates/bms/admin',
    ...overrides,
  } as Parameters<typeof transfer.registerTransferItem>[1]);
}

function accept(itemId: string, overrides: Record<string, unknown> = {}) {
  return transfer.acceptTransfer(asFM(), itemId, {
    quantityReceived: 4,
    condition: 'All four received, cut correctly and tested in the lock',
    sender: 'M&E subcontractor site manager',
    recipient: 'Estates manager',
    location: 'Estates office, ground floor',
    receiptReference: 'KEY-RECEIPT-001',
    receiptHash: 'a'.repeat(64),
    ...overrides,
  } as Parameters<typeof transfer.acceptTransfer>[2]);
}

describe('H-WF-07 transfer register', () => {
  beforeEach(freshProject);

  it('registers an item with its quantity, location, condition and owner', () => {
    const { itemId, shortBy } = key();
    assert.ok(itemId);
    assert.equal(shortBy, 0);

    const position = transfer.transferPosition(asFM());
    assert.equal(position.items.length, 1);
    assert.equal(position.items[0]!.reference, 'KEY-PLANT-01');
    assert.equal(position.items[0]!.status, 'REGISTERED');
    assert.equal(position.items[0]!.critical, true);
  });

  it('reports a shortfall at registration without waiting for the transfer', () => {
    const { shortBy } = key({ quantityHeld: 1 });
    assert.equal(shortBy, 3);
  });

  it('refuses an item with no transfer owner', () => {
    const error = throwsCode(() => key({ transferOwner: '  ' }), 'OWNER_REQUIRED');
    assert.match(String(error.message), /list somebody compiled/);
  });

  it('refuses an item with no reference or no description', () => {
    throwsCode(() => key({ reference: '' }), 'ITEM_UNIDENTIFIED');
    throwsCode(() => key({ description: '   ' }), 'ITEM_UNIDENTIFIED');
  });

  it('refuses a duplicate reference on the register', () => {
    key();
    throwsCode(() => key(), 'REFERENCE_TAKEN');
  });

  it('refuses an item with no location or no condition — both are what the recipient checks against', () => {
    throwsCode(() => key({ storageLocation: '' }), 'LOCATION_REQUIRED');
    throwsCode(() => key({ condition: '' }), 'LOCATION_REQUIRED');
  });

  it('refuses a required quantity of zero and a negative held quantity', () => {
    throwsCode(() => key({ quantityRequired: 0 }), 'QUANTITY_REQUIRED');
    throwsCode(() => key({ quantityHeld: -1 }), 'QUANTITY_REQUIRED');
  });

  it('denies registration to a role without HANDOVER_OM C', () => {
    throwsCode(
      () =>
        transfer.registerTransferItem(asRegulator(), {
          reference: 'KEY-X',
          kind: 'KEY',
          description: 'A key the regulator has no business registering',
          quantityRequired: 1,
          quantityHeld: 1,
          condition: 'New',
          storageLocation: 'Cabinet',
          critical: false,
          transferOwner: 'Somebody',
        }),
      'ACCESS_DENIED',
    );
  });
});

describe('H-WF-07 physical transfer', () => {
  beforeEach(freshProject);

  it('transfers an item with both parties named and the receipt retained', () => {
    const { itemId } = key();
    const result = accept(itemId);
    assert.equal(result.shortBy, 0);

    const position = transfer.transferPosition(asFM());
    assert.equal(position.items[0]!.status, 'TRANSFERRED');
    assert.equal(position.items[0]!.quantityReceived, 4);
    assert.equal(position.blockedReason, null);
  });

  it('retains the receipt as hashed evidence, not as a citation of a document nobody kept', () => {
    const { itemId } = key();
    accept(itemId);

    const evidence = platform.ledger
      .list(seed.projectId, 'EvidenceItem')
      .map((record) => record.state)
      .filter((state) => state.type === 'TRANSFER_RECEIPT');

    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]!.hash, 'a'.repeat(64));
    assert.match(String(evidence[0]!.description), /KEY-RECEIPT-001/);

    const transferEvent = platform.ledger
      .events({ projectId: seed.projectId })
      .find((event) => event.eventType === 'KEYS_TRANSFERRED');
    assert.equal((transferEvent!.evidenceRefs ?? []).length, 1);
  });

  it('refuses a transfer with only one party, or with the same person on both sides', () => {
    const { itemId } = key();
    const error = throwsCode(() => accept(itemId, { recipient: '' }), 'PARTIES_REQUIRED');
    assert.match(String(error.message), /note somebody wrote/);
    throwsCode(() => accept(itemId, { recipient: 'M&E subcontractor site manager' }), 'PARTIES_REQUIRED');
  });

  it('refuses a transfer with no retained receipt', () => {
    const { itemId } = key();
    throwsCode(() => accept(itemId, { receiptHash: '' }), 'RECEIPT_REQUIRED');
    throwsCode(() => accept(itemId, { receiptReference: '' }), 'RECEIPT_REQUIRED');
  });

  it('refuses a transfer with no arrival location or condition', () => {
    const { itemId } = key();
    throwsCode(() => accept(itemId, { location: '' }), 'LOCATION_REQUIRED');
    throwsCode(() => accept(itemId, { condition: '' }), 'LOCATION_REQUIRED');
  });

  it('refuses to transfer the same item twice', () => {
    const { itemId } = key();
    accept(itemId);
    throwsCode(() => accept(itemId), 'ALREADY_TRANSFERRED');
  });

  it('refuses to hand a credential across a table', () => {
    const { itemId } = credential();
    const error = throwsCode(() => accept(itemId, { quantityReceived: 1 }), 'CREDENTIAL_NOT_PHYSICAL');
    assert.match(String(error.message), /secret mechanism/);
  });

  it('returns 404 for an item that does not exist', () => {
    throwsCode(() => accept('NOPE'), 'ITEM_NOT_FOUND');
  });

  it('records the transfer against a KEY as KEYS_TRANSFERRED and a SPARE as SPARES_ACCEPTED', () => {
    const spare = key({ reference: 'SPARE-FILTER-01', kind: 'SPARE', description: 'Spare AHU filter set, twelve months' });
    accept(spare.itemId);
    const keyItem = key();
    accept(keyItem.itemId);

    const types = platform.ledger
      .events({ projectId: seed.projectId })
      .map((event) => event.eventType)
      .filter((type) => type === 'KEYS_TRANSFERRED' || type === 'SPARES_ACCEPTED');
    assert.deepEqual(types, ['SPARES_ACCEPTED', 'KEYS_TRANSFERRED']);
  });
});

describe('H-WF-07 shortages', () => {
  beforeEach(freshProject);

  it('refuses a short delivery that nobody owns', () => {
    const { itemId } = key();
    const error = throwsCode(() => accept(itemId, { quantityReceived: 2 }), 'SHORTAGE_UNOWNED');
    assert.match(String(error.message), /only moment anybody is looking/);
  });

  it('refuses a shortage with no owner or no date to be made good by', () => {
    const { itemId } = key();
    throwsCode(
      () => accept(itemId, { quantityReceived: 2, shortage: { owner: '', by: iso(14), note: 'Two outstanding' } }),
      'SHORTAGE_UNOWNED',
    );
    throwsCode(
      () => accept(itemId, { quantityReceived: 2, shortage: { owner: 'M&E', by: 'soon', note: 'Two outstanding' } }),
      'SHORTAGE_UNOWNED',
    );
  });

  it('records the transfer and the shortage as two separate events', () => {
    const { itemId } = key();
    const result = accept(itemId, {
      quantityReceived: 2,
      shortage: { owner: 'M&E subcontractor site manager', by: iso(14), note: 'Two more to be cut from the master' },
    });
    assert.equal(result.shortBy, 2);

    const types = platform.ledger
      .events({ projectId: seed.projectId })
      .map((event) => event.eventType)
      .filter((type) => type === 'KEYS_TRANSFERRED' || type === 'TRANSFER_SHORTAGE_RECORDED');
    assert.deepEqual(types, ['KEYS_TRANSFERRED', 'TRANSFER_SHORTAGE_RECORDED']);
  });

  it('keeps the shortage linked to its owner and its date in the position', () => {
    const { itemId } = key();
    accept(itemId, {
      quantityReceived: 2,
      shortage: { owner: 'M&E subcontractor site manager', by: iso(14), note: 'Two more to be cut' },
    });

    const position = transfer.transferPosition(asFM());
    assert.equal(position.shortages.length, 1);
    assert.equal(position.shortages[0]!.shortBy, 2);
    assert.equal(position.shortages[0]!.owner, 'M&E subcontractor site manager');
    assert.equal(position.shortages[0]!.overdue, false);
    assert.equal(position.items[0]!.status, 'SHORT');
  });

  it('blocks the handover on a critical item short', () => {
    const { itemId } = key();
    accept(itemId, {
      quantityReceived: 2,
      shortage: { owner: 'M&E subcontractor site manager', by: iso(14), note: 'Two more to be cut' },
    });

    const reason = transfer.transferBlockedReason(asFM());
    assert.match(reason!, /KEY-PLANT-01/);
    assert.match(reason!, /cannot run the building/);
  });

  it('does not block on a non-critical item short', () => {
    const { itemId } = key({ reference: 'CONS-LAMP-01', kind: 'CONSUMABLE', critical: false });
    accept(itemId, {
      quantityReceived: 1,
      shortage: { owner: 'M&E subcontractor site manager', by: iso(14), note: 'Rest on the next delivery' },
    });
    assert.equal(transfer.transferBlockedReason(asFM()), null);
  });

  it('flags a shortage past the date it was to be made good by', () => {
    const { itemId } = key({ reference: 'CONS-LAMP-01', kind: 'CONSUMABLE', critical: false });
    accept(itemId, {
      quantityReceived: 1,
      shortage: { owner: 'M&E subcontractor site manager', by: iso(-3), note: 'Was due last week' },
    });

    const position = transfer.transferPosition(asFM());
    assert.equal(position.shortages[0]!.overdue, true);
    assert.match(position.blockedReason!, /past the date/);
  });
});

describe('H-WF-07 credentials', () => {
  beforeEach(freshProject);

  it('requires a vault reference on a credential', () => {
    const error = throwsCode(() => credential({ vaultReference: undefined }), 'VAULT_REFERENCE_REQUIRED');
    assert.match(String(error.message), /never holds the value/);
  });

  it('refuses a vault reference on a physical item', () => {
    throwsCode(() => key({ vaultReference: 'vault://nope' }), 'VAULT_REFERENCE_UNEXPECTED');
  });

  it('confirms a credential transfer by mechanism and confirmer, never by value', () => {
    const { itemId } = credential();
    const result = transfer.confirmCredentialTransfer(asFM(), itemId, {
      mechanism: 'Corporate secret store, shared to the estates group and acknowledged in the vault audit log',
      confirmedBy: 'Estates manager',
    });
    assert.equal(result.vaultReference, 'vault://estates/bms/admin');

    const position = transfer.transferPosition(asFM());
    assert.equal(position.items[0]!.status, 'TRANSFERRED');
    assert.equal(position.items[0]!.vaultReference, 'vault://estates/bms/admin');
  });

  it('refuses a vague mechanism — the difference between a secret store and an email is the whole control', () => {
    const { itemId } = credential();
    const error = throwsCode(
      () => transfer.confirmCredentialTransfer(asFM(), itemId, { mechanism: 'Sent it', confirmedBy: 'Estates manager' }),
      'MECHANISM_REQUIRED',
    );
    assert.match(String(error.message), /whole control/);
  });

  it('refuses an unsigned confirmation and a second confirmation', () => {
    const { itemId } = credential();
    throwsCode(
      () =>
        transfer.confirmCredentialTransfer(asFM(), itemId, {
          mechanism: 'Corporate secret store, acknowledged in the vault audit log',
          confirmedBy: '',
        }),
      'CONFIRMATION_UNSIGNED',
    );
    transfer.confirmCredentialTransfer(asFM(), itemId, {
      mechanism: 'Corporate secret store, acknowledged in the vault audit log',
      confirmedBy: 'Estates manager',
    });
    throwsCode(
      () =>
        transfer.confirmCredentialTransfer(asFM(), itemId, {
          mechanism: 'Corporate secret store, acknowledged in the vault audit log',
          confirmedBy: 'Estates manager',
        }),
      'ALREADY_CONFIRMED',
    );
  });

  it('refuses to confirm a physical item through the secret mechanism', () => {
    const { itemId } = key();
    throwsCode(
      () =>
        transfer.confirmCredentialTransfer(asFM(), itemId, {
          mechanism: 'Corporate secret store, acknowledged in the vault audit log',
          confirmedBy: 'Estates manager',
        }),
      'NOT_A_CREDENTIAL',
    );
  });

  /**
   * AC-H-WF-07-02, tested structurally.
   *
   * Every string the credential path writes to the ledger is walked, and the
   * only credential identifier that appears anywhere is the vault reference. The
   * point is not that a validator stripped a secret — it is that no field on the
   * type could carry one, so there is nothing for a future caller to fill in.
   */
  it('never writes a secret value to the ledger, because no field exists to hold one', () => {
    const { itemId } = credential();
    transfer.confirmCredentialTransfer(asFM(), itemId, {
      mechanism: 'Corporate secret store, shared to the estates group and acknowledged in the vault audit log',
      confirmedBy: 'Estates manager',
    });

    const written = JSON.stringify(
      platform.ledger.events({ projectId: seed.projectId }).filter((event) => event.entity.refType === 'TransferItem'),
    );

    // Every credential-shaped key that could hold a value is absent from the
    // serialised events, and the vault reference is what stands in its place.
    for (const forbidden of ['password', 'secret', 'apiKey', 'token', 'passphrase', 'credentialValue']) {
      assert.equal(written.includes(`"${forbidden}"`), false, `${forbidden} appears in the ledger`);
    }
    assert.equal(written.includes('vault://estates/bms/admin'), true);

    const position = transfer.transferPosition(asFM());
    assert.deepEqual(Object.keys(position.items[0]!).filter((field) => field.toLowerCase().includes('value')), []);
  });
});

describe('H-WF-07 lost items', () => {
  beforeEach(freshProject);

  it('reports a lost key as a security incident, not a shortage', () => {
    const { itemId } = key();
    const result = transfer.reportLostItem(asFM(), itemId, {
      what: 'One of the four plant room keys is not in the cabinet and the last holder has left site',
      reportedBy: 'Estates manager',
    });
    assert.equal(result.securityIncident, true);

    const position = transfer.transferPosition(asFM());
    assert.equal(position.lost.length, 1);
    assert.equal(position.shortages.length, 0);
    assert.equal(position.items[0]!.status, 'LOST');
  });

  it('blocks the handover on a lost item ahead of every other reason', () => {
    const short = key({ reference: 'CONS-LAMP-01', kind: 'CONSUMABLE', critical: false });
    accept(short.itemId, {
      quantityReceived: 1,
      shortage: { owner: 'M&E', by: iso(-3), note: 'Overdue as well' },
    });
    const lost = key();
    transfer.reportLostItem(asFM(), lost.itemId, {
      what: 'Plant room key unaccounted for after the last holder left site',
      reportedBy: 'Estates manager',
    });

    const reason = transfer.transferBlockedReason(asFM());
    assert.match(reason!, /KEY-PLANT-01/);
    assert.match(reason!, /somebody may be able to get into/);
  });

  it('refuses a loss report that says nothing security can act on', () => {
    const { itemId } = key();
    const error = throwsCode(() => transfer.reportLostItem(asFM(), itemId, { what: 'lost', reportedBy: 'x' }), 'LOSS_UNDESCRIBED');
    assert.match(String(error.message), /cannot be acted on by security/);
  });

  it('refuses an unsigned loss report', () => {
    const { itemId } = key();
    throwsCode(
      () =>
        transfer.reportLostItem(asFM(), itemId, {
          what: 'One of the plant room keys is not in the cabinet',
          reportedBy: '',
        }),
      'REPORT_UNSIGNED',
    );
  });
});

describe('H-WF-07 service contacts', () => {
  beforeEach(freshProject);

  function contact(overrides: Record<string, unknown> = {}) {
    return transfer.registerServiceContact(asFM(), {
      system: 'AHU-01 ventilation',
      provider: 'Controls subcontractor',
      contractReference: 'SC-2024-118',
      contact: 'Duty engineer desk',
      telephone: '0800 000 0000',
      responseTime: '4 hours, 24/7',
      escalation: 'Escalate to the account manager after two hours with no answer, then to the operations director.',
      coverUntil: iso(365),
      ...overrides,
    } as Parameters<typeof transfer.registerServiceContact>[1]);
  }

  it('registers a contact with its response time, escalation and cover end', () => {
    const { contactId } = contact();
    assert.ok(contactId);

    const position = transfer.transferPosition(asFM());
    assert.equal(position.serviceContacts.length, 1);
    assert.equal(position.serviceContacts[0]!.provider, 'Controls subcontractor');
    assert.equal(position.serviceContacts[0]!.responseTime, '4 hours, 24/7');
  });

  it('refuses a contact with no person or no number', () => {
    const error = throwsCode(() => contact({ contact: '' }), 'CONTACT_REQUIRED');
    assert.match(String(error.message), /nobody asked the supplier/);
    throwsCode(() => contact({ telephone: '' }), 'CONTACT_REQUIRED');
    throwsCode(() => contact({ provider: '' }), 'CONTACT_REQUIRED');
  });

  it('refuses a contact with no response time or no escalation route', () => {
    throwsCode(() => contact({ responseTime: '' }), 'ESCALATION_REQUIRED');
    const error = throwsCode(() => contact({ escalation: 'Call' }), 'ESCALATION_REQUIRED');
    assert.match(String(error.message), /two in the morning/);
  });

  it('refuses cover with no end date', () => {
    const error = throwsCode(() => contact({ coverUntil: 'ongoing' }), 'COVER_REQUIRED');
    assert.match(String(error.message), /assumed to be for ever/);
  });
});

describe('H-WF-07 readiness and the position', () => {
  beforeEach(freshProject);

  it('binds nothing where the project keeps no transfer register', () => {
    assert.equal(transfer.transferBlockedReason(asFM()), null);
    const position = transfer.transferPosition(asFM());
    assert.equal(position.items.length, 0);
    assert.match(position.summary, /0 transfer items/);
  });

  it('blocks on a critical item registered and never transferred', () => {
    key();
    const reason = transfer.transferBlockedReason(asFM());
    assert.match(reason!, /registered and never transferred/);
  });

  it('does not block on a non-critical item registered and never transferred', () => {
    key({ reference: 'CONS-LAMP-01', kind: 'CONSUMABLE', critical: false });
    assert.equal(transfer.transferBlockedReason(asFM()), null);
  });

  it('summarises the register', () => {
    const keyItem = key();
    accept(keyItem.itemId);
    const cred = credential();
    transfer.confirmCredentialTransfer(asFM(), cred.itemId, {
      mechanism: 'Corporate secret store, acknowledged in the vault audit log',
      confirmedBy: 'Estates manager',
    });

    const position = transfer.transferPosition(asFM());
    assert.match(position.summary, /2 transfer items/);
    assert.match(position.summary, /2 transferred/);
  });

  it('lets a role holding HANDOVER_OM R read the position', () => {
    key();
    const position = transfer.transferPosition(asPM());
    assert.equal(position.items.length, 1);
  });
});

describe('H-WF-07 catalogue and classification', () => {
  it('registers every transfer event against the handover group with no AI mandate', () => {
    for (const code of [
      'TRANSFER_ITEM_REGISTERED',
      'KEYS_TRANSFERRED',
      'SPARES_ACCEPTED',
      'TRANSFER_SHORTAGE_RECORDED',
      'CREDENTIAL_TRANSFER_CONFIRMED',
      'TRANSFER_ITEM_LOST',
      'SERVICE_CONTACT_REGISTERED',
    ]) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.group, 'HANDOVER_OM', `${code} group`);
      assert.equal(
        definition.aiAllowed,
        false,
        `${code} must carry no AI mandate — a credential's whereabouts is as useful to an attacker as its value`,
      );
    }
  });

  it('requires the retained receipt on both transfer events', () => {
    assert.equal(lookupEventType('KEYS_TRANSFERRED')?.requiresEvidence, true);
    assert.equal(lookupEventType('SPARES_ACCEPTED')?.requiresEvidence, true);
  });

  it('classifies the transfer register as internal and the service contacts as ordinary handover records', () => {
    assert.equal(classifyEntity('TransferItem')?.area, 'HANDOVER_OM');
    assert.equal(classifyEntity('TransferItem')?.sensitivity, 'INTERNAL');
    assert.equal(classifyEntity('ServiceContact')?.area, 'HANDOVER_OM');
  });
});
