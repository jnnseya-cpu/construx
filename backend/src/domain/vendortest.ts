import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, write, type EngineContext } from '../engines/context.ts';
import { calibrationBlockedReason } from './qualitycontrol.ts';
import { executionBlockedReason, satisfies, type AcceptanceCriterion } from './testpack.ts';

/**
 * CM-WF-03 — FAT, SAT and vendor test control.
 *
 * Built on CM-WF-02 rather than beside it: a factory test runs against a
 * released test pack, so the criteria, their controlled sources, their units and
 * their limits are the ones CM-WF-02 already refuses to accept without. That
 * also means AC-CM-WF-02-01 applies at the factory: a FAT executed against an
 * unreleased procedure is refused here as it is anywhere else. Instrument
 * calibration is `qualitycontrol.calibrationBlockedReason`, unchanged.
 *
 * Three things are new, and each is one of the acceptance criteria.
 *
 * **A reading is a measurement, not a number.** AC-CM-WF-03-01. Value, unit, the
 * instrument it came off, the person who took it and when. A reading with no
 * instrument on it cannot be defended two years later when the equipment fails,
 * and a reading from an instrument out of certificate was never a measurement at
 * all.
 *
 * **The result is calculated, and the decision is a separate act.**
 * AC-CM-WF-03-02. The platform compares readings to limits and gets one answer
 * every time. What a person then does about it — accept, reject, accept subject
 * to restrictions — is recorded beside that, never in place of it. Recording a
 * pass over a reading outside its limit is refused: that is not a decision, it
 * is an overwrite.
 *
 * **An exception raised at the factory does not stay at the factory.**
 * AC-CM-WF-03-03. The commonest way a FAT exception is lost is that it is closed
 * by the shipping paperwork: the unit arrives, the delivery note is signed and
 * nobody carries the open item forward. Exceptions here follow the equipment
 * tag, stay open until somebody verifies them closed, and are refused as closed
 * on the vendor's word alone.
 *
 * The last exception control is enforced by having no way round it: **a vendor
 * PDF is not a result.** Completing a test requires a reading against every
 * criterion, so a certificate with no structured readings behind it cannot
 * complete anything.
 */

export const VENDOR_TEST_KIND = ['FAT', 'SAT'] as const;
export type VendorTestKind = (typeof VENDOR_TEST_KIND)[number];

export type TestReading = {
  criterionRef: string;
  value: number;
  unit: string;
  instrumentId: string;
  performedBy: string;
  takenAt: string;
  /** Computed here, from the criterion's limits. Never supplied. */
  withinLimits: boolean;
};

export type VendorException = {
  reference: string;
  raisedAt: string;
  description: string;
  /** Whether it stops the equipment being shipped or accepted. */
  blocking: boolean;
  owner: string;
  by: string;
  closedAt?: string;
  closedBy?: string;
  verification?: string;
};

export type VendorTestState = {
  testId: string;
  kind: VendorTestKind;
  packId: string;
  equipmentTag: string;
  /** What the order says should arrive. */
  orderedSerial: string;
  /** What was in front of the witness. */
  observedSerial: string;
  purchaseOrder: string;
  attendance: Array<{ name: string; organisation: string; role: string; attended: boolean }>;
  readings: TestReading[];
  exceptions: VendorException[];
  status: 'IN_PROGRESS' | 'COMPLETE';
  calculatedResult?: 'PASS' | 'FAIL';
  decision?: 'PASS' | 'FAIL' | 'CONDITIONAL';
  restrictions?: string;
  restrictionClearBy?: string;
  decidedBy?: string;
  shippingReleasedBy?: string;
};

function requireTest(ctx: EngineContext, testId: string) {
  const record = ctx.ledger.get({ refType: 'VendorTest', refId: testId });
  if (!record) throw new DomainError('TEST_NOT_FOUND', `No vendor test ${testId}`, 404);
  return record;
}

function criteriaOf(ctx: EngineContext, packId: string): AcceptanceCriterion[] {
  const pack = ctx.ledger.get({ refType: 'TestPack', refId: packId });
  if (!pack) throw new DomainError('PACK_NOT_FOUND', `No test pack ${packId}`, 404);
  return (pack.state.criteria as AcceptanceCriterion[] | undefined) ?? [];
}

/**
 * Open FAT or SAT exceptions against a piece of equipment.
 *
 * AC-CM-WF-03-03, exported so the delivery screen, the installation record and
 * SAT readiness all read the same list rather than each keeping their own.
 */
export function openVendorExceptionsFor(
  ctx: EngineContext,
  equipmentTag?: string,
): Array<VendorException & { equipmentTag: string; kind: VendorTestKind }> {
  return ctx.ledger
    .list(ctx.projectId, 'VendorTest')
    .flatMap((record) => {
      const state = record.state as unknown as VendorTestState;
      if (equipmentTag && state.equipmentTag !== equipmentTag) return [];
      return state.exceptions
        .filter((exception) => !exception.closedAt)
        .map((exception) => ({ ...exception, equipmentTag: state.equipmentTag, kind: state.kind }));
    });
}

/** Schedule and start a factory or site acceptance test. */
export function startVendorTest(
  ctx: EngineContext,
  input: {
    kind: VendorTestKind;
    packId: string;
    equipmentTag: string;
    orderedSerial: string;
    observedSerial: string;
    purchaseOrder: string;
    attendance: Array<{ name: string; organisation: string; role: string; attended: boolean }>;
  },
): { testId: string; openFatExceptions: string[] } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'C', { lifecyclePhase: currentPhase(ctx) });

  // The same rule as every other test: nothing runs against a procedure nobody
  // released. A factory is not an exception to it.
  const blocked = executionBlockedReason(ctx, input.packId);
  if (blocked) throw new DomainError('PACK_NOT_RELEASED', blocked);

  if (!input.equipmentTag.trim() || !input.purchaseOrder.trim()) {
    throw new DomainError(
      'EQUIPMENT_UNIDENTIFIED',
      'A vendor test names the equipment tag and the order it was bought under. Without both, the certificate cannot be ' +
        'matched to the unit that turns up.',
    );
  }
  if (!input.orderedSerial.trim() || !input.observedSerial.trim()) {
    throw new DomainError(
      'SERIAL_REQUIRED',
      'Record the serial the order expects and the serial in front of the witness. They are usually the same, and the ' +
        'occasions they are not are the ones this exists for.',
    );
  }
  if (!input.attendance.some((person) => person.attended)) {
    throw new DomainError(
      'NOBODY_ATTENDED',
      'A witnessed test with nobody in attendance is a vendor’s own test. Record the waiver against the pack instead.',
    );
  }

  // Exceptions from the factory, surfaced at the point they matter. Reported,
  // not refused: a SAT is often exactly where a FAT exception gets verified.
  const carried = input.kind === 'SAT' ? openVendorExceptionsFor(ctx, input.equipmentTag) : [];

  const testId = ulid();

  write(ctx, {
    eventType: input.kind === 'FAT' ? 'FAT_STARTED' : 'SAT_STARTED',
    entity: { refType: 'VendorTest', refId: testId },
    nextState: {
      testId,
      projectId: ctx.projectId,
      kind: input.kind,
      packId: input.packId,
      equipmentTag: input.equipmentTag,
      orderedSerial: input.orderedSerial,
      observedSerial: input.observedSerial,
      purchaseOrder: input.purchaseOrder,
      attendance: input.attendance,
      readings: [],
      exceptions: [],
      status: 'IN_PROGRESS',
      carriedExceptions: carried.map((exception) => exception.reference),
      startedBy: ctx.auth.actorId,
      startedAt: new Date().toISOString(),
    },
  });

  return { testId, openFatExceptions: carried.map((exception) => exception.reference) };
}

/**
 * Record one reading.
 *
 * `withinLimits` is computed rather than accepted, which is half of
 * AC-CM-WF-03-02: the comparison has one answer and it is not the performer's to
 * give.
 */
export function recordReading(
  ctx: EngineContext,
  testId: string,
  input: { criterionRef: string; value: number; unit: string; instrumentId: string; performedBy: string; takenAt?: string },
): { withinLimits: boolean; readings: number } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireTest(ctx, testId);
  if (record.state.status === 'COMPLETE') {
    throw new DomainError(
      'TEST_COMPLETE',
      'This test has been completed. A reading added afterwards changes a result somebody has already relied on; run a ' +
        'retest instead.',
    );
  }

  const criteria = criteriaOf(ctx, String(record.state.packId));
  const criterion = criteria.find((entry) => entry.reference === input.criterionRef);
  if (!criterion) {
    throw new DomainError(
      'CRITERION_NOT_FOUND',
      `${input.criterionRef} is not a criterion in the released pack. A reading against nothing cannot be passed or failed.`,
      404,
    );
  }
  if (input.unit !== criterion.unit) {
    throw new DomainError(
      'UNIT_MISMATCH',
      `${input.criterionRef} is measured in ${criterion.unit} and the reading is in ${input.unit}. A unit converted in ` +
        'somebody’s head is the commonest way a test passes when it should not.',
    );
  }
  if (!input.performedBy.trim()) {
    throw new DomainError(
      'PERFORMER_REQUIRED',
      'Name who took the reading. A reading nobody took is one nobody can be asked about.',
    );
  }

  const takenAt = input.takenAt ?? new Date().toISOString();
  const calibration = calibrationBlockedReason(ctx, input.instrumentId, takenAt.slice(0, 10));
  if (calibration) throw new DomainError('INSTRUMENT_NOT_CALIBRATED', calibration);

  const withinLimits = satisfies(criterion, input.value);

  const reading: TestReading = {
    criterionRef: input.criterionRef,
    value: input.value,
    unit: input.unit,
    instrumentId: input.instrumentId,
    performedBy: input.performedBy,
    takenAt,
    withinLimits,
  };

  const readings = [...((record.state.readings as TestReading[] | undefined) ?? []), reading];

  write(ctx, {
    eventType: 'TEST_READING_RECORDED',
    entity: { refType: 'VendorTest', refId: testId },
    nextState: { ...record.state, readings },
  });

  return { withinLimits, readings: readings.length };
}

/** Raise an exception or punch item against the equipment. */
export function raiseVendorException(
  ctx: EngineContext,
  testId: string,
  input: { reference: string; description: string; blocking: boolean; owner: string; by: string },
): { reference: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireTest(ctx, testId);
  if (!input.description.trim() || !input.owner.trim() || Number.isNaN(Date.parse(input.by))) {
    throw new DomainError(
      'EXCEPTION_INCOMPLETE',
      'An exception names what is wrong, who is putting it right and by when. Without the last two it travels with the ' +
        'equipment and is closed by the delivery note.',
    );
  }

  const exceptions = (record.state.exceptions as VendorException[] | undefined) ?? [];
  if (exceptions.some((exception) => exception.reference === input.reference)) {
    throw new DomainError('EXCEPTION_TAKEN', `${input.reference} is already raised against this test.`);
  }

  write(ctx, {
    eventType: 'VENDOR_EXCEPTION_RAISED',
    entity: { refType: 'VendorTest', refId: testId },
    nextState: {
      ...record.state,
      exceptions: [
        ...exceptions,
        {
          reference: input.reference,
          raisedAt: new Date().toISOString(),
          description: input.description,
          blocking: input.blocking,
          owner: input.owner,
          by: input.by,
        },
      ],
    },
  });

  return { reference: input.reference };
}

/**
 * Close an exception.
 *
 * Requires the verification, not the vendor's assurance. "Rectified at works" on
 * a vendor's letterhead has closed more open items than any inspection ever has.
 */
export function closeVendorException(
  ctx: EngineContext,
  testId: string,
  input: { reference: string; closedBy: string; verification: string },
): { reference: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = requireTest(ctx, testId);
  const exceptions = (record.state.exceptions as VendorException[] | undefined) ?? [];
  const exception = exceptions.find((entry) => entry.reference === input.reference);
  if (!exception) throw new DomainError('EXCEPTION_NOT_FOUND', `No exception ${input.reference}.`, 404);
  if (exception.closedAt) throw new DomainError('EXCEPTION_CLOSED', `${input.reference} is already closed.`);

  if (!input.closedBy.trim() || input.verification.trim().length < 10) {
    throw new DomainError(
      'VERIFICATION_REQUIRED',
      'Say who verified it and what they saw. "Rectified at works" on a vendor’s letterhead has closed more open items ' +
        'than any inspection ever has.',
    );
  }

  write(ctx, {
    eventType: 'VENDOR_EXCEPTION_CLOSED',
    entity: { refType: 'VendorTest', refId: testId },
    nextState: {
      ...record.state,
      exceptions: exceptions.map((entry) =>
        entry.reference === input.reference
          ? { ...entry, closedAt: new Date().toISOString(), closedBy: input.closedBy, verification: input.verification }
          : entry,
      ),
    },
  });

  return { reference: input.reference };
}

/**
 * Complete the test.
 *
 * The result is calculated from the readings and the limits; the decision is
 * recorded beside it. AC-CM-WF-03-02 is that these are two fields, and the
 * refusal below is what makes it more than a convention.
 */
export function completeVendorTest(
  ctx: EngineContext,
  testId: string,
  input: { decision: 'PASS' | 'FAIL' | 'CONDITIONAL'; decidedBy: string; restrictions?: string; restrictionClearBy?: string },
): { calculatedResult: 'PASS' | 'FAIL'; decision: string; openExceptions: number } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = requireTest(ctx, testId);
  if (record.state.status === 'COMPLETE') {
    throw new DomainError('ALREADY_COMPLETE', 'This test has already been completed.');
  }
  if (!input.decidedBy.trim()) {
    throw new DomainError('DECISION_UNSIGNED', 'Name the authority accepting or rejecting the test.');
  }

  const criteria = criteriaOf(ctx, String(record.state.packId));
  const readings = (record.state.readings as TestReading[] | undefined) ?? [];
  const measured = new Set(readings.map((reading) => reading.criterionRef));
  const unmeasured = criteria.filter((criterion) => !measured.has(criterion.reference));

  if (unmeasured.length > 0) {
    throw new DomainError(
      'READINGS_MISSING',
      `No reading against ${unmeasured.map((criterion) => criterion.reference).join(', ')}. A vendor certificate asserting ` +
        'the equipment passed is not a result: the raw readings are what a result is calculated from, and without them ' +
        'nothing here can be recalculated by anybody.',
    );
  }

  const calculatedResult: 'PASS' | 'FAIL' = readings.every((reading) => reading.withinLimits) ? 'PASS' : 'FAIL';

  if (input.decision === 'PASS' && calculatedResult === 'FAIL') {
    const failed = readings.filter((reading) => !reading.withinLimits);
    throw new DomainError(
      'DECISION_CONTRADICTS_READINGS',
      `${failed.map((reading) => `${reading.criterionRef} at ${reading.value}${reading.unit}`).join(', ')} ` +
        `${failed.length === 1 ? 'is' : 'are'} outside the limit. Recording a pass over that is not a decision, it is an ` +
        'overwrite. Record a conditional acceptance with the restrictions on it, or a fail.',
    );
  }

  if (input.decision === 'CONDITIONAL') {
    if (!input.restrictions?.trim()) {
      throw new DomainError(
        'RESTRICTIONS_REQUIRED',
        'A conditional acceptance states what the equipment may not be used for until the condition clears. Without that ' +
          'it is an unconditional acceptance with a note attached.',
      );
    }
    if (!input.restrictionClearBy || Number.isNaN(Date.parse(input.restrictionClearBy))) {
      throw new DomainError(
        'CLOSURE_DATE_REQUIRED',
        'A conditional acceptance carries the date the condition has to clear by. One with no date never clears.',
      );
    }
  }

  const exceptions = (record.state.exceptions as VendorException[] | undefined) ?? [];
  const open = exceptions.filter((exception) => !exception.closedAt);

  write(ctx, {
    eventType: record.state.kind === 'FAT' ? 'FAT_COMPLETED' : 'SAT_COMPLETED',
    entity: { refType: 'VendorTest', refId: testId },
    nextState: {
      ...record.state,
      status: 'COMPLETE',
      calculatedResult,
      decision: input.decision,
      restrictions: input.restrictions,
      restrictionClearBy: input.restrictionClearBy,
      decidedBy: input.decidedBy,
      decidedByActor: ctx.auth.actorId,
      decidedAt: new Date().toISOString(),
    },
  });

  return { calculatedResult, decision: input.decision, openExceptions: open.length };
}

/**
 * Release the equipment for shipping.
 *
 * FAT only, and the point at which a serial mismatch stops being a curiosity: the
 * unit tested and the unit shipped have to be the same unit, or the whole test
 * belongs to something else.
 */
export function releaseForShipping(
  ctx: EngineContext,
  testId: string,
  input: { releasedBy: string; authority: string },
): { equipmentTag: string; serial: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = requireTest(ctx, testId);
  const state = record.state as unknown as VendorTestState;

  if (state.kind !== 'FAT') {
    throw new DomainError('NOT_A_FAT', 'Shipping release follows a factory acceptance test, not a site one.');
  }
  if (state.status !== 'COMPLETE') {
    throw new DomainError('TEST_INCOMPLETE', 'The test has not been completed, so there is no result to release against.');
  }
  if (!input.releasedBy.trim() || !input.authority.trim()) {
    throw new DomainError(
      'RELEASE_UNAUTHORISED',
      'Name the person releasing the equipment and the authority they hold. Shipping release is a designated authority, ' +
        'not a step in the paperwork.',
    );
  }
  if (state.observedSerial !== state.orderedSerial) {
    throw new DomainError(
      'SERIAL_MISMATCH',
      `The order expects ${state.orderedSerial} and the unit tested was ${state.observedSerial}. Either the wrong unit was ` +
        'tested or the wrong unit is being shipped, and both are found on site months later.',
    );
  }
  if (state.decision === 'FAIL') {
    throw new DomainError('TEST_FAILED', 'A failed factory test does not release equipment for shipping.');
  }

  const blocking = state.exceptions.filter((exception) => !exception.closedAt && exception.blocking);
  if (blocking.length > 0) {
    throw new DomainError(
      'BLOCKING_EXCEPTIONS',
      `${blocking.map((exception) => exception.reference).join(', ')} ${blocking.length === 1 ? 'is' : 'are'} open and ` +
        'blocking. An exception closed by the shipping paperwork is an exception nobody rectified.',
    );
  }

  write(ctx, {
    eventType: 'SHIPPING_RELEASED',
    entity: { refType: 'VendorTest', refId: testId },
    nextState: {
      ...record.state,
      shippingReleasedBy: input.releasedBy,
      shippingAuthority: input.authority,
      shippingReleasedAt: new Date().toISOString(),
    },
  });

  return { equipmentTag: state.equipmentTag, serial: state.observedSerial };
}

// --- The position -----------------------------------------------------------

export type VendorTestPosition = {
  tests: Array<{
    testId: string;
    kind: VendorTestKind;
    equipmentTag: string;
    serial: string;
    serialMismatch: boolean;
    status: string;
    calculatedResult?: string;
    decision?: string;
    readings: number;
    openExceptions: number;
    shipped: boolean;
  }>;
  /** Every open factory or site exception, by equipment. AC-CM-WF-03-03. */
  openExceptions: Array<VendorException & { equipmentTag: string; kind: VendorTestKind; overdue: boolean }>;
  /** Conditional acceptances whose restriction has not cleared. */
  conditional: Array<{ equipmentTag: string; restrictions: string; clearBy: string; overdue: boolean }>;
  summary: string;
};

export function vendorTestPosition(
  ctx: EngineContext,
  today = new Date().toISOString().slice(0, 10),
): VendorTestPosition {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'R');

  const states = ctx.ledger
    .list(ctx.projectId, 'VendorTest')
    .map((record) => record.state as unknown as VendorTestState);

  const openExceptions = openVendorExceptionsFor(ctx).map((exception) => ({
    ...exception,
    overdue: exception.by.slice(0, 10) < today,
  }));

  const conditional = states
    .filter((state) => state.decision === 'CONDITIONAL')
    .map((state) => ({
      equipmentTag: state.equipmentTag,
      restrictions: state.restrictions ?? '',
      clearBy: state.restrictionClearBy ?? '',
      overdue: (state.restrictionClearBy ?? '').slice(0, 10) < today,
    }));

  const mismatches = states.filter((state) => state.observedSerial !== state.orderedSerial).length;

  const parts = [`${states.length} vendor test${states.length === 1 ? '' : 's'}`];
  if (openExceptions.length > 0) parts.push(`${openExceptions.length} exception still open`);
  if (conditional.length > 0) parts.push(`${conditional.length} conditional acceptance`);
  if (mismatches > 0) parts.push(`${mismatches} serial not matching the order`);

  return {
    tests: states.map((state) => ({
      testId: state.testId,
      kind: state.kind,
      equipmentTag: state.equipmentTag,
      serial: state.observedSerial,
      serialMismatch: state.observedSerial !== state.orderedSerial,
      status: state.status,
      calculatedResult: state.calculatedResult,
      decision: state.decision,
      readings: state.readings.length,
      openExceptions: state.exceptions.filter((exception) => !exception.closedAt).length,
      shipped: Boolean(state.shippingReleasedBy),
    })),
    openExceptions,
    conditional,
    summary: parts.join(', ') + '.',
  };
}
