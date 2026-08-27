import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';

/**
 * CN-WF-05 — resource, material, delivery and procurement control.
 *
 * The platform could already buy: `domain/procurement.ts` takes an RFQ to an
 * award, a subcontract and a commitment, and `domain/supplychain.ts` decides who
 * may be asked. What it could not do was receive anything. There was no
 * delivery, no goods receipt, no batch or serial, and therefore no answer to the
 * question every commissioning engineer eventually asks: *which valve is this,
 * and where is its certificate?*
 *
 * Four failures, and the module is built around them.
 *
 * **A long lead nobody was tracking.** AC-CN-WF-05-01. A fourteen-week item
 * ordered eleven weeks before it is needed is late on the day it is ordered, and
 * the only moment that is cheap to fix is that day. Every item carries the date
 * the programme needs it and the lead time it takes, so the platform can say —
 * before anybody has done anything wrong — that this one cannot arrive in time.
 * Its progress runs through a fixed ladder from requisition to acceptance, and
 * **every step names the evidence it rests on**, because "in manufacture" from a
 * supplier who has not started is the commonest lie on any project and the only
 * defence against it is a document.
 *
 * **A delivery nobody could take.** A twelve-tonne beam arriving at the same
 * hour as the ready-mix, with one crane, is a wasted morning and sometimes a
 * damaged beam. Bookings are against a slot, and two lifts in one slot are
 * refused rather than discovered.
 *
 * **A quantity that was never reconciled.** The second exception control. What
 * was ordered, what was dispatched and what actually turned up are three
 * different numbers, and the difference between them is either a shortage
 * somebody has to chase or an over-delivery somebody will be invoiced for. A
 * mismatch is not refused — the material is on site whatever the paperwork says
 * — but it cannot be accepted without an explicit reconciliation naming which
 * it is and who is chasing it.
 *
 * **A safety-critical product with no certificate.** The first exception
 * control, and the one that matters. A structural bolt, a fire damper, a lifting
 * eye: without its certificate and its traceable batch it is **quarantined**,
 * and quarantine is a state the material cannot leave without somebody with the
 * authority saying why. It is not a warning on a screen. Accepting it is
 * refused, installing it is refused, and it stays visible until it is resolved.
 *
 * And the two rules that make the record worth keeping afterwards:
 * **acceptance happens once**, so inventory and the accrual move once
 * (AC-CN-WF-05-02); and an accepted serial can be **installed against a
 * location and its test evidence** (AC-CN-WF-05-03), which is the chain that
 * turns a delivery note into an as-built record.
 */

/**
 * The ladder a purchased item climbs.
 *
 * Fixed rather than configurable. These are the steps that exist on every
 * project that has ever bought anything with a lead time, and a per-project list
 * is a per-project opportunity to leave out the one that was going to catch the
 * problem. Where a step does not apply — nothing is imported, so there is no
 * customs — it is skipped forward past rather than deleted.
 */
export const PROCUREMENT_STEP = [
  'REQUISITION',
  'RFQ',
  'ORDER',
  /** The supplier's drawings, approved before they cut steel. */
  'DESIGN_APPROVAL',
  'MANUFACTURE',
  /** Factory acceptance test. */
  'FAT',
  'SHIPMENT',
  'CUSTOMS',
  'DELIVERY',
  'ACCEPTANCE',
] as const;
export type ProcurementStep = (typeof PROCUREMENT_STEP)[number];

export const DELIVERY_STATE = ['BOOKED', 'RECEIVED', 'QUARANTINED', 'ACCEPTED', 'REJECTED'] as const;
export type DeliveryState = (typeof DELIVERY_STATE)[number];

export type Milestone = {
  step: ProcurementStep;
  at: string;
  by: string;
  /** What the step rests on. "In manufacture" with nothing behind it is a claim. */
  evidence: string;
  note?: string;
};

/** A batch, heat number or serial, and where it ended up. */
export type TraceableUnit = {
  identifier: string;
  /** The certificate that makes it traceable — mill cert, test cert, DoP. */
  certificate?: string;
  installedAt?: { location: string; at: string; by: string; testEvidence: string };
};

type ItemState = {
  id: string;
  reference: string;
  description: string;
  quantity: number;
  unit: string;
  /** From the programme. The date the thing waiting for it needs it. */
  requiredOnSiteBy: string;
  leadTimeDays: number;
  /** A bolt, a fire damper, a lifting eye. Certificate or quarantine. */
  safetyCritical: boolean;
  /** Where the product differs from what was specified. */
  substitutionSubmittalRef?: string;
  step: ProcurementStep;
  milestones: Milestone[];
  /** Accepted and in stock. Moves once per delivery. */
  inventoryQuantity: number;
  accrualMinor: number;
  unitRateMinor?: number;
};

type DeliveryStateRecord = {
  id: string;
  reference: string;
  itemId: string;
  bookedFor: string;
  slot: string;
  craneRequired: boolean;
  state: DeliveryState;
  orderedQuantity: number;
  dispatchedQuantity?: number;
  receivedQuantity?: number;
  deliveryNote?: string;
  condition?: string;
  units: TraceableUnit[];
  reconciliation?: { kind: 'SHORT' | 'OVER' | 'DAMAGED'; what: string; chasedBy: string };
  quarantine?: { why: string; at: string; by: string; releasedAt?: string; releasedBy?: string; releaseReason?: string };
  acceptedAt?: string;
  acceptedBy?: string;
};

const DAY_MS = 86_400_000;

function requireItem(ctx: EngineContext, itemId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'ProcurementItem', refId: itemId });
  if (!record) throw new DomainError('PROCUREMENT_ITEM_NOT_FOUND', `No procurement item ${itemId}`, 404);
  return record;
}

function requireDelivery(ctx: EngineContext, deliveryId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'Delivery', refId: deliveryId });
  if (!record) throw new DomainError('DELIVERY_NOT_FOUND', `No delivery ${deliveryId}`, 404);
  return record;
}

const itemOf = (record: EntityRecord): ItemState => record.state as unknown as ItemState;
const deliveryOf = (record: EntityRecord): DeliveryStateRecord => record.state as unknown as DeliveryStateRecord;

// --- Step 1 and 2: the item and its ladder ----------------------------------

export function registerProcurementItem(
  ctx: EngineContext,
  input: {
    reference: string;
    description: string;
    quantity: number;
    unit: string;
    requiredOnSiteBy: string;
    leadTimeDays: number;
    safetyCritical: boolean;
    unitRateMinor?: number;
    substitutionSubmittalRef?: string;
  },
  now = new Date(),
): { itemId: string; reference: string; orderBy: string; alreadyLate: boolean } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (!input.reference.trim() || !input.description.trim()) {
    throw new DomainError(
      'ITEM_UNIDENTIFIED',
      'Name the item and give it a reference. A procurement register of "pipework" answers nothing when three suppliers are ' +
        'each delivering some of it.',
    );
  }
  if (!(input.quantity > 0) || !input.unit.trim()) {
    throw new DomainError('QUANTITY_REQUIRED', 'Say how much, and in what.');
  }
  if (Number.isNaN(Date.parse(input.requiredOnSiteBy))) {
    throw new DomainError(
      'NEED_DATE_REQUIRED',
      'Name the date the programme needs it. An item with no need date cannot be late, which is why every late item on ' +
        'every project turns out not to have had one.',
    );
  }
  if (!(input.leadTimeDays >= 0)) {
    throw new DomainError('LEAD_TIME_REQUIRED', 'A lead time of less than zero days is not a lead time.');
  }

  const taken = ctx.ledger
    .list(ctx.projectId, 'ProcurementItem')
    .some((record) => itemOf(record).reference.toUpperCase() === input.reference.trim().toUpperCase());
  if (taken) {
    throw new DomainError('ITEM_REFERENCE_TAKEN', `${input.reference} is already a procurement item on this project.`, 409);
  }

  // AC-CN-WF-05-01, at the only moment it is cheap to fix. A fourteen-week item
  // ordered eleven weeks out is late the day it is ordered.
  const orderBy = new Date(Date.parse(input.requiredOnSiteBy) - input.leadTimeDays * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const alreadyLate = orderBy < now.toISOString().slice(0, 10);

  const itemId = ulid();

  write(ctx, {
    eventType: 'ORDER_PLACED',
    entity: { refType: 'ProcurementItem', refId: itemId },
    nextState: {
      id: itemId,
      projectId: ctx.projectId,
      reference: input.reference.trim(),
      description: input.description,
      quantity: input.quantity,
      unit: input.unit.trim(),
      requiredOnSiteBy: input.requiredOnSiteBy.slice(0, 10),
      leadTimeDays: input.leadTimeDays,
      orderBy,
      safetyCritical: input.safetyCritical,
      ...(input.substitutionSubmittalRef ? { substitutionSubmittalRef: input.substitutionSubmittalRef } : {}),
      ...(input.unitRateMinor === undefined ? {} : { unitRateMinor: input.unitRateMinor }),
      step: 'REQUISITION',
      milestones: [],
      inventoryQuantity: 0,
      accrualMinor: 0,
      registeredAt: now.toISOString(),
      registeredBy: ctx.auth.actorId,
    },
  });

  return { itemId, reference: input.reference.trim(), orderBy, alreadyLate };
}

export function advanceProcurement(
  ctx: EngineContext,
  itemId: string,
  input: { step: ProcurementStep; evidence: string; note?: string },
  now = new Date(),
): { step: ProcurementStep; skipped: ProcurementStep[] } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireItem(ctx, itemId);
  const state = itemOf(record);

  const from = PROCUREMENT_STEP.indexOf(state.step);
  const to = PROCUREMENT_STEP.indexOf(input.step);

  if (to <= from) {
    throw new DomainError(
      'MILESTONE_REGRESSION',
      `${state.reference} is already at ${state.step.toLowerCase().replace(/_/g, ' ')}. A procurement status that can go ` +
        'backwards is one that gets set to whatever makes the report look right.',
      409,
    );
  }
  // Delivery and acceptance are recorded by receiving something, not by
  // asserting them — otherwise an item is "delivered" with nothing on site.
  if (input.step === 'DELIVERY' || input.step === 'ACCEPTANCE') {
    throw new DomainError(
      'STEP_NOT_ASSERTABLE',
      `${input.step.toLowerCase()} is recorded by receiving and accepting a delivery, not by declaring it. An item marked ` +
        'delivered with nothing on site is the status every procurement report has and nobody trusts.',
    );
  }
  if (!input.evidence.trim()) {
    throw new DomainError(
      'MILESTONE_UNEVIDENCED',
      `Name what says ${input.step.toLowerCase().replace(/_/g, ' ')} has happened — the order number, the approved ` +
        'submittal, the FAT certificate, the bill of lading. "In manufacture" from a supplier who has not started is the ' +
        'commonest overstatement on any project, and a document is the only defence against it.',
    );
  }

  // Skipping is legitimate — nothing imported has a customs step — and is
  // recorded rather than silently passed over.
  const skipped = PROCUREMENT_STEP.slice(from + 1, to) as ProcurementStep[];

  const milestone: Milestone = {
    step: input.step,
    at: now.toISOString(),
    by: ctx.auth.actorId,
    evidence: input.evidence,
    ...(input.note ? { note: input.note } : {}),
  };

  write(ctx, {
    eventType: 'MANUFACTURING_MILESTONE_UPDATED',
    entity: { refType: 'ProcurementItem', refId: itemId },
    nextState: {
      ...record.state,
      step: input.step,
      milestones: [...state.milestones, milestone],
      ...(skipped.length > 0 ? { skippedSteps: [...((record.state.skippedSteps as string[]) ?? []), ...skipped] } : {}),
    },
  });

  return { step: input.step, skipped: [...skipped] };
}

// --- Step 3: the booking ----------------------------------------------------

export function bookDelivery(
  ctx: EngineContext,
  itemId: string,
  input: { bookedFor: string; slot: string; craneRequired: boolean },
): { deliveryId: string; reference: string; afterNeedDate: boolean } {
  authorise(ctx, 'FIELD_EXECUTION', 'C', { lifecyclePhase: currentPhase(ctx) });

  const record = requireItem(ctx, itemId);
  const state = itemOf(record);

  if (Number.isNaN(Date.parse(input.bookedFor)) || !input.slot.trim()) {
    throw new DomainError('BOOKING_UNSCHEDULED', 'A delivery is booked for a date and a slot.');
  }

  // Two lifts in one slot is a wasted morning and sometimes a damaged beam.
  // Refused rather than discovered on the day.
  if (input.craneRequired) {
    const clash = ctx.ledger
      .list(ctx.projectId, 'Delivery')
      .map((entry) => deliveryOf(entry))
      .find(
        (entry) =>
          entry.state === 'BOOKED' &&
          entry.craneRequired &&
          entry.bookedFor === input.bookedFor.slice(0, 10) &&
          entry.slot.trim().toLowerCase() === input.slot.trim().toLowerCase(),
      );
    if (clash) {
      throw new DomainError(
        'LIFT_SLOT_TAKEN',
        `${clash.reference} already has the crane at ${input.slot} on ${input.bookedFor.slice(0, 10)}. Two lifts in one slot ` +
          'is a wasted morning for one of them and sometimes a damaged load.',
        409,
      );
    }
  }

  const sequence = ctx.ledger.list(ctx.projectId, 'Delivery').length + 1;
  const reference = `DEL-${String(sequence).padStart(4, '0')}`;
  const deliveryId = ulid();

  write(ctx, {
    eventType: 'DELIVERY_BOOKED',
    entity: { refType: 'Delivery', refId: deliveryId },
    nextState: {
      id: deliveryId,
      projectId: ctx.projectId,
      reference,
      itemId,
      itemReference: state.reference,
      bookedFor: input.bookedFor.slice(0, 10),
      slot: input.slot.trim(),
      craneRequired: input.craneRequired,
      state: 'BOOKED',
      orderedQuantity: state.quantity,
      units: [],
      bookedAt: new Date().toISOString(),
      bookedBy: ctx.auth.actorId,
    },
  });

  return { deliveryId, reference, afterNeedDate: input.bookedFor.slice(0, 10) > state.requiredOnSiteBy };
}

// --- Step 4 and 5: what actually turned up ----------------------------------

export function receiveDelivery(
  ctx: EngineContext,
  deliveryId: string,
  input: {
    deliveryNote: string;
    dispatchedQuantity: number;
    receivedQuantity: number;
    condition: string;
    /**
     * Whether it arrived damaged, said rather than inferred.
     *
     * An earlier version read the free-text condition for the word "damage",
     * which reported "sound, no visible damage" as damaged — the classic
     * failure of guessing a fact from prose. A person answers this one.
     */
    damaged?: boolean;
    /** Batches, heat numbers or serials, with their certificates. */
    units?: TraceableUnit[];
    evidenceHash: string;
  },
  now = new Date(),
): { reference: string; state: DeliveryState; quarantined: boolean; discrepancy: number } {
  authorise(ctx, 'FIELD_EXECUTION', 'C', { lifecyclePhase: currentPhase(ctx) });

  const record = requireDelivery(ctx, deliveryId);
  const state = deliveryOf(record);
  const item = itemOf(requireItem(ctx, state.itemId));

  if (state.state !== 'BOOKED') {
    throw new DomainError(
      'ALREADY_RECEIVED',
      `${state.reference} is ${state.state.toLowerCase()}. A delivery received twice is one counted twice.`,
      409,
    );
  }
  if (!input.deliveryNote.trim()) {
    throw new DomainError(
      'DELIVERY_NOTE_REQUIRED',
      'Record the delivery note number. It is what the invoice will be matched against, and the argument three months later ' +
        'is always about which load it was.',
    );
  }
  if (!input.condition.trim()) {
    throw new DomainError('CONDITION_REQUIRED', 'Say what condition it arrived in, including that it was fine.');
  }
  if (input.receivedQuantity < 0 || input.dispatchedQuantity < 0) {
    throw new DomainError('QUANTITY_REQUIRED', 'A negative quantity cannot be received.');
  }
  if (!input.evidenceHash.trim()) {
    throw new DomainError('EVIDENCE_REQUIRED', 'A goods receipt carries the delivery note and the photographs it rests on.');
  }

  // The first exception control. A structural bolt without its mill certificate
  // is a bolt nobody can prove anything about, and the moment to catch it is
  // while the lorry is still on site.
  const uncertified = safetyCriticalGap(item, input.units ?? []);
  const discrepancy = Number((input.receivedQuantity - state.orderedQuantity).toFixed(3));

  const quarantined = uncertified !== null;
  const nextState: DeliveryState = quarantined ? 'QUARANTINED' : 'RECEIVED';

  const evidence = registerEvidence(ctx, {
    type: 'DELIVERY_RECORD',
    hash: input.evidenceHash,
    description: `${state.reference}: delivery note ${input.deliveryNote} for ${item.reference}`,
    linkedEntities: [{ refType: 'ProcurementItem', refId: state.itemId }],
  });

  write(ctx, {
    eventType: quarantined ? 'MATERIAL_QUARANTINED' : 'DELIVERY_RECEIVED',
    entity: { refType: 'Delivery', refId: deliveryId },
    nextState: {
      ...record.state,
      state: nextState,
      deliveryNote: input.deliveryNote,
      dispatchedQuantity: input.dispatchedQuantity,
      receivedQuantity: input.receivedQuantity,
      condition: input.condition,
      damaged: input.damaged === true,
      units: input.units ?? [],
      discrepancy,
      ...(quarantined ? { quarantine: { why: uncertified, at: now.toISOString(), by: ctx.auth.actorId } } : {}),
      receivedAt: now.toISOString(),
      receivedBy: ctx.auth.actorId,
    },
    evidenceRefs: [evidence],
  });

  return { reference: state.reference, state: nextState, quarantined, discrepancy };
}

export function quarantineDelivery(
  ctx: EngineContext,
  deliveryId: string,
  input: { why: string },
  now = new Date(),
): { reference: string; quarantined: true } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'C', { lifecyclePhase: currentPhase(ctx) });

  const record = requireDelivery(ctx, deliveryId);
  const state = deliveryOf(record);

  if (state.state === 'ACCEPTED') {
    throw new DomainError(
      'ALREADY_ACCEPTED',
      `${state.reference} was accepted on ${String(state.acceptedAt).slice(0, 10)}. Material already in the works is an ` +
        'inspection or a nonconformance, not a quarantine — quarantine is for material nobody has used yet.',
      409,
    );
  }
  if (state.state === 'QUARANTINED') {
    throw new DomainError('ALREADY_QUARANTINED', `${state.reference} is already quarantined.`);
  }
  if (!input.why.trim()) {
    throw new DomainError('QUARANTINE_UNEXPLAINED', 'Say what is wrong with it. Somebody has to be able to clear it.');
  }

  write(ctx, {
    eventType: 'MATERIAL_QUARANTINED',
    entity: { refType: 'Delivery', refId: deliveryId },
    nextState: {
      ...record.state,
      state: 'QUARANTINED',
      quarantine: { why: input.why, at: now.toISOString(), by: ctx.auth.actorId },
    },
  });

  return { reference: state.reference, quarantined: true };
}

/**
 * Release material from quarantine.
 *
 * Quarantine is a state the material cannot leave without somebody with the
 * authority saying why — approve on quality, not create. A quarantine anybody
 * could clear is a warning on a screen.
 */
export function releaseFromQuarantine(
  ctx: EngineContext,
  deliveryId: string,
  input: { reason: string; units?: TraceableUnit[] },
  now = new Date(),
): { reference: string; released: true } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = requireDelivery(ctx, deliveryId);
  const state = deliveryOf(record);

  if (state.state !== 'QUARANTINED') {
    throw new DomainError('NOT_QUARANTINED', `${state.reference} is ${state.state.toLowerCase()}, not quarantined.`);
  }
  if (!input.reason.trim()) {
    throw new DomainError(
      'RELEASE_UNEXPLAINED',
      'Say what resolved it — the certificate that arrived, the test that passed, the batch that was traced. A release with ' +
        'no reason on it is the quarantine never having meant anything.',
    );
  }

  const units = input.units ?? state.units;
  const item = itemOf(requireItem(ctx, state.itemId));
  const stillMissing = safetyCriticalGap(item, units);
  if (stillMissing) {
    throw new DomainError(
      'CERTIFICATE_STILL_MISSING',
      `${stillMissing} Releasing it now would leave the same material on site with the same gap and a note saying somebody ` +
        'looked at it.',
      409,
    );
  }

  write(ctx, {
    eventType: 'MATERIAL_QUARANTINED',
    entity: { refType: 'Delivery', refId: deliveryId },
    nextState: {
      ...record.state,
      state: 'RECEIVED',
      units,
      quarantine: {
        ...(state.quarantine ?? { why: '', at: now.toISOString(), by: ctx.auth.actorId }),
        releasedAt: now.toISOString(),
        releasedBy: ctx.auth.actorId,
        releaseReason: input.reason,
      },
    },
  });

  return { reference: state.reference, released: true };
}

// --- Step 6: acceptance moves inventory and the accrual, once ---------------

export function acceptDelivery(
  ctx: EngineContext,
  deliveryId: string,
  input: {
    /** Required where what arrived is not what was ordered. */
    reconciliation?: { kind: 'SHORT' | 'OVER' | 'DAMAGED'; what: string; chasedBy: string };
    note: string;
  },
  now = new Date(),
): { reference: string; inventoryQuantity: number; accrualMinor: number } {
  authorise(ctx, 'FIELD_EXECUTION', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = requireDelivery(ctx, deliveryId);
  const state = deliveryOf(record);
  const itemRecord = requireItem(ctx, state.itemId);
  const item = itemOf(itemRecord);

  if (state.state === 'QUARANTINED') {
    throw new DomainError(
      'QUARANTINED',
      `${state.reference} is quarantined: ${state.quarantine?.why ?? ''} It is released by somebody with quality authority ` +
        'before it can be accepted, and not before.',
      409,
    );
  }
  if (state.state === 'ACCEPTED') {
    // AC-CN-WF-05-02. Inventory and the accrual move once.
    throw new DomainError(
      'ALREADY_ACCEPTED',
      `${state.reference} was accepted on ${String(state.acceptedAt).slice(0, 10)}. Accepting it again would put the same ` +
        'load into stock twice and accrue for it twice.',
      409,
    );
  }
  if (state.state !== 'RECEIVED') {
    throw new DomainError('NOT_RECEIVED', `${state.reference} is ${state.state.toLowerCase()}; nothing has been received yet.`);
  }
  if (!input.note.trim()) {
    throw new DomainError('ACCEPTANCE_UNEXPLAINED', 'Say what was checked before it was taken into stock.');
  }

  // The second exception control. The material is on site whatever the
  // paperwork says, so a mismatch is not refused — but it cannot pass into
  // stock without somebody naming which it is and who is chasing it.
  const received = state.receivedQuantity ?? 0;
  const mismatch = received !== state.orderedQuantity || (record.state as Record<string, unknown>).damaged === true;
  if (mismatch && !input.reconciliation) {
    throw new DomainError(
      'RECONCILIATION_REQUIRED',
      received === state.orderedQuantity
        ? `${state.reference} arrived damaged: ${state.condition ?? ''} Say what is being done about it and who is chasing ` +
          'it — damage taken into stock unrecorded becomes a defect nobody can attribute.'
        : `${state.reference} received ${received}${item.unit} against ${state.orderedQuantity}${item.unit} ordered. Say ` +
          'whether that is a shortage, an over-delivery or damage, and who is chasing it — an unreconciled difference ' +
          'becomes an invoice query nobody can answer.',
      409,
    );
  }
  if (input.reconciliation && (!input.reconciliation.what.trim() || !input.reconciliation.chasedBy.trim())) {
    throw new DomainError('RECONCILIATION_UNOWNED', 'A reconciliation names what happened and who is chasing it.');
  }

  const inventoryQuantity = Number((item.inventoryQuantity + received).toFixed(3));
  const accrualMinor = item.accrualMinor + Math.round(received * (item.unitRateMinor ?? 0));

  write(ctx, {
    eventType: 'MATERIAL_ACCEPTED',
    entity: { refType: 'Delivery', refId: deliveryId },
    nextState: {
      ...record.state,
      state: 'ACCEPTED',
      ...(input.reconciliation ? { reconciliation: input.reconciliation } : {}),
      acceptanceNote: input.note,
      acceptedAt: now.toISOString(),
      acceptedBy: ctx.auth.actorId,
    },
  });

  write(ctx, {
    eventType: 'MANUFACTURING_MILESTONE_UPDATED',
    entity: { refType: 'ProcurementItem', refId: state.itemId },
    nextState: {
      ...itemRecord.state,
      step: 'ACCEPTANCE',
      milestones: [
        ...item.milestones,
        {
          step: 'ACCEPTANCE',
          at: now.toISOString(),
          by: ctx.auth.actorId,
          evidence: `${state.reference}, delivery note ${state.deliveryNote ?? ''}`,
        },
      ],
      inventoryQuantity,
      accrualMinor,
    },
  });

  return { reference: state.reference, inventoryQuantity, accrualMinor };
}

// --- AC-CN-WF-05-03: a serial, a location and a test ------------------------

export function installUnit(
  ctx: EngineContext,
  deliveryId: string,
  input: { identifier: string; location: string; testEvidence: string },
  now = new Date(),
): { identifier: string; location: string } {
  authorise(ctx, 'FIELD_EXECUTION', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireDelivery(ctx, deliveryId);
  const state = deliveryOf(record);

  if (state.state !== 'ACCEPTED') {
    throw new DomainError(
      'NOT_ACCEPTED',
      `${state.reference} is ${state.state.toLowerCase()}. Material goes into the works after it is accepted, which is the ` +
        'point of accepting it.',
      409,
    );
  }
  const unit = state.units.find((entry) => entry.identifier === input.identifier);
  if (!unit) {
    throw new DomainError(
      'SERIAL_UNKNOWN',
      `${input.identifier} was not delivered under ${state.reference}. A serial installed that nobody received is one nothing ` +
        'can be traced back from.',
      404,
    );
  }
  if (unit.installedAt) {
    throw new DomainError(
      'SERIAL_ALREADY_INSTALLED',
      `${input.identifier} is already recorded at ${unit.installedAt.location}. One serial in two places is one of them wrong, ` +
        'and at handover nobody can tell which.',
      409,
    );
  }
  if (!input.location.trim() || !input.testEvidence.trim()) {
    throw new DomainError(
      'INSTALLATION_UNTRACEABLE',
      'Name where it went and the test that proves it works there. Those two facts are what turn a delivery note into an ' +
        'as-built record, and they are what the commissioning engineer asks for.',
    );
  }

  write(ctx, {
    eventType: 'MATERIAL_INSTALLED',
    entity: { refType: 'Delivery', refId: deliveryId },
    nextState: {
      ...record.state,
      units: state.units.map((entry) =>
        entry.identifier === input.identifier
          ? {
              ...entry,
              installedAt: {
                location: input.location,
                at: now.toISOString(),
                by: ctx.auth.actorId,
                testEvidence: input.testEvidence,
              },
            }
          : entry,
      ),
    },
  });

  return { identifier: input.identifier, location: input.location };
}

// --- The rule that decides quarantine ---------------------------------------

/**
 * Why this delivery has to be quarantined, or null.
 *
 * A safety-critical product needs a traceable unit *and* a certificate against
 * it. Either alone is not traceability: a batch number with no certificate
 * proves nothing about the batch, and a certificate with nothing to attach it to
 * proves nothing about what arrived.
 */
export function safetyCriticalGap(item: ItemState, units: TraceableUnit[]): string | null {
  if (!item.safetyCritical) return null;
  if (units.length === 0) {
    return `${item.reference} is safety-critical and arrived with no batch, heat number or serial against it, so nothing on site can be traced to a certificate.`;
  }
  const uncertified = units.filter((unit) => !unit.certificate?.trim()).map((unit) => unit.identifier);
  if (uncertified.length > 0) {
    return `${item.reference} is safety-critical and ${uncertified.join(', ')} arrived with no certificate.`;
  }
  return null;
}

// --- The position -----------------------------------------------------------

export type ProcurementPosition = {
  items: Array<{
    itemId: string;
    reference: string;
    description: string;
    step: string;
    requiredOnSiteBy: string;
    orderBy: string;
    /** Days between the last recorded step and the date it had to be ordered. */
    lateBy: number;
    inventoryQuantity: number;
    accrualMinor: number;
    safetyCritical: boolean;
  }>;
  /** Items whose order-by date has passed and which are not yet ordered. */
  atRisk: Array<{ reference: string; orderBy: string; step: string; requiredOnSiteBy: string }>;
  /** Material on site that nobody may use. */
  quarantined: Array<{ reference: string; itemReference: string; why: string }>;
  /** What arrived differing from what was ordered, and who is chasing it. */
  reconciliations: Array<{ reference: string; kind: string; what: string; chasedBy: string }>;
  /** Serials in the works, with where they went and what proves it. */
  installed: Array<{ identifier: string; itemReference: string; location: string; testEvidence: string }>;
  summary: string;
};

export function procurementPosition(
  ctx: EngineContext,
  today = new Date().toISOString().slice(0, 10),
): ProcurementPosition {
  authorise(ctx, 'PROCUREMENT_AWARD', 'R');

  const atRisk: ProcurementPosition['atRisk'] = [];

  const items = ctx.ledger.list(ctx.projectId, 'ProcurementItem').map((record) => {
    const state = itemOf(record);
    const orderBy = String((record.state as Record<string, unknown>).orderBy ?? '');
    const ordered = PROCUREMENT_STEP.indexOf(state.step) >= PROCUREMENT_STEP.indexOf('ORDER');

    if (!ordered && orderBy < today) {
      atRisk.push({
        reference: state.reference,
        orderBy,
        step: state.step,
        requiredOnSiteBy: state.requiredOnSiteBy,
      });
    }

    return {
      itemId: state.id,
      reference: state.reference,
      description: state.description,
      step: state.step,
      requiredOnSiteBy: state.requiredOnSiteBy,
      orderBy,
      lateBy: ordered || orderBy === '' ? 0 : Math.max(0, Math.round((Date.parse(today) - Date.parse(orderBy)) / DAY_MS)),
      inventoryQuantity: state.inventoryQuantity,
      accrualMinor: state.accrualMinor,
      safetyCritical: state.safetyCritical,
    };
  });

  const quarantined: ProcurementPosition['quarantined'] = [];
  const reconciliations: ProcurementPosition['reconciliations'] = [];
  const installed: ProcurementPosition['installed'] = [];

  for (const record of ctx.ledger.list(ctx.projectId, 'Delivery')) {
    const state = deliveryOf(record);
    const itemReference = String((record.state as Record<string, unknown>).itemReference ?? '');
    if (state.state === 'QUARANTINED') {
      quarantined.push({ reference: state.reference, itemReference, why: state.quarantine?.why ?? '' });
    }
    if (state.reconciliation) {
      reconciliations.push({
        reference: state.reference,
        kind: state.reconciliation.kind,
        what: state.reconciliation.what,
        chasedBy: state.reconciliation.chasedBy,
      });
    }
    for (const unit of state.units) {
      if (!unit.installedAt) continue;
      installed.push({
        identifier: unit.identifier,
        itemReference,
        location: unit.installedAt.location,
        testEvidence: unit.installedAt.testEvidence,
      });
    }
  }

  // Quarantine first: it is material on site that nobody may use, and every day
  // it sits there is a day somebody might.
  const parts = [`${items.length} procurement item${items.length === 1 ? '' : 's'}`];
  if (quarantined.length > 0) parts.push(`${quarantined.length} quarantined`);
  if (atRisk.length > 0) parts.push(`${atRisk.length} past the date they had to be ordered`);
  if (reconciliations.length > 0) parts.push(`${reconciliations.length} delivery discrepanc${reconciliations.length === 1 ? 'y' : 'ies'} open`);

  return { items, atRisk, quarantined, reconciliations, installed, summary: parts.join(', ') + '.' };
}
