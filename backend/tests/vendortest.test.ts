import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as delivery from '../src/domain/delivery.ts';
import * as qualitycontrol from '../src/domain/qualitycontrol.ts';
import * as structure from '../src/domain/structure.ts';
import * as systemisation from '../src/domain/systemisation.ts';
import * as testpack from '../src/domain/testpack.ts';
import * as vendortest from '../src/domain/vendortest.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * CM-WF-03 — FAT, SAT and vendor test control.
 *
 * Built on CM-WF-02's released pack rather than beside it, so the criteria,
 * units and limits are the ones that workflow already refuses to accept without.
 * What is tested here is the reading that is a measurement, the result that is
 * calculated rather than asserted, and the factory exception that does not stay
 * at the factory.
 */

let platform: Platform;
let seed: SeedResult;

const asQAQC = () => platform.context(seed.users.qaqc!.auth, seed.projectId, { source: 'WEB' });
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

const CRITERIA: testpack.AcceptanceCriterion[] = [
  {
    reference: 'AC-1',
    criterion: 'Fan static pressure at duty within the schedule figure.',
    source: 'Mechanical schedule MS-04, rev B',
    requiredReading: 'Static pressure at duty',
    unit: 'Pa',
    lowerLimit: 380,
    upperLimit: 420,
  },
  {
    reference: 'AC-2',
    criterion: 'Motor full-load current at or below the nameplate figure.',
    source: 'Vendor data sheet VD-118, rev 2',
    requiredReading: 'Full-load current',
    unit: 'A',
    upperLimit: 12.5,
  },
];

let packId: string;

async function freshProject() {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'COMMISSIONING',
    justification: 'Running the factory acceptance tests',
  });

  systemisation.defineSystem(asQAQC(), {
    tag: 'FAC-01',
    level: 'FACILITY',
    name: 'Riverside Laboratory',
    boundary: 'The whole demised premises within the site boundary, excluding incoming utility connections.',
  });
  systemisation.defineSystem(asQAQC(), {
    tag: 'MEC-VENT',
    level: 'SYSTEM',
    parentTag: 'FAC-01',
    name: 'Ventilation',
    boundary: 'All supply and extract air handling from intake louvre to terminal device.',
    assetTags: ['AHU-01'],
  });

  qualitycontrol.registerInstrument(asQAQC(), {
    instrumentId: 'MANO-77',
    description: 'Digital manometer',
    calibratedAt: iso(-60),
    calibrationExpiresAt: iso(300),
    certificate: 'UKAS 2026/077-A',
  });
  qualitycontrol.registerInstrument(asQAQC(), {
    instrumentId: 'CLAMP-12',
    description: 'Clamp meter',
    calibratedAt: iso(-60),
    calibrationExpiresAt: iso(300),
    certificate: 'UKAS 2026/012-A',
  });
  qualitycontrol.registerInstrument(asQAQC(), {
    instrumentId: 'MANO-OLD',
    description: 'Digital manometer, out of certificate',
    calibratedAt: iso(-800),
    calibrationExpiresAt: iso(-60),
    certificate: 'UKAS 2024/099-A',
  });

  packId = releasedPack('TP-FAT-01');
}

function releasedPack(reference: string): string {
  const { packId: id } = testpack.createTestPack(asQAQC(), {
    reference,
    systemTag: 'MEC-VENT',
    title: 'AHU factory acceptance test',
    objective: 'Prove the fan duty and the motor current before the unit leaves the works.',
    steps: [
      { step: 1, instruction: 'Run the unit at design duty and allow it to stabilise.' },
      { step: 2, instruction: 'Record static pressure and full-load current.' },
    ],
    criteria: CRITERIA,
    instrumentIds: ['MANO-77', 'CLAMP-12'],
  });
  testpack.checkTestReadiness(asQAQC(), id, {
    checkedBy: 'J. Byrne',
    items: testpack.READINESS_ITEM.filter((item) => item.key !== 'INSTRUMENTS').map((item) => ({
      key: item.key,
      ready: true,
      note: 'Verified at the works.',
    })),
  });
  const { notificationId } = testpack.notifyWitness(asQAQC(), id, {
    recipient: 'H. Marston',
    organisation: 'Client technical adviser',
    testDate: iso(14),
    noticeDays: 10,
  });
  testpack.recordWitnessResponse(asQAQC(), id, { notificationId, attending: true, note: 'Attending.' });
  testpack.releaseForTest(asQAQC(), id, { releasedBy: 'S. Kaur' });
  return id;
}

const ATTENDANCE = [
  { name: 'H. Marston', organisation: 'Client technical adviser', role: 'Witness', attended: true },
  { name: 'P. Lindqvist', organisation: 'Vendor', role: 'Test engineer', attended: true },
];

function fat(overrides: Partial<Parameters<typeof vendortest.startVendorTest>[1]> = {}) {
  return vendortest.startVendorTest(asQAQC(), {
    kind: 'FAT',
    packId,
    equipmentTag: 'AHU-01',
    orderedSerial: 'SN-4471',
    observedSerial: 'SN-4471',
    purchaseOrder: 'PO-2291',
    attendance: ATTENDANCE,
    ...overrides,
  });
}

function goodReadings(testId: string) {
  vendortest.recordReading(asQAQC(), testId, {
    criterionRef: 'AC-1',
    value: 402,
    unit: 'Pa',
    instrumentId: 'MANO-77',
    performedBy: 'P. Lindqvist',
  });
  vendortest.recordReading(asQAQC(), testId, {
    criterionRef: 'AC-2',
    value: 11.8,
    unit: 'A',
    instrumentId: 'CLAMP-12',
    performedBy: 'P. Lindqvist',
  });
}

describe('CM-WF-03 the register', () => {
  beforeEach(freshProject);

  it('registers its eight event types, and none is available to an agent', () => {
    for (const code of [
      'FAT_STARTED',
      'SAT_STARTED',
      'TEST_READING_RECORDED',
      'VENDOR_EXCEPTION_RAISED',
      'VENDOR_EXCEPTION_CLOSED',
      'FAT_COMPLETED',
      'SAT_COMPLETED',
      'SHIPPING_RELEASED',
    ] as const) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, 'VendorTest');
      // The agent extracts readings subject to confirmation; it accepts nothing.
      assert.equal(definition.aiAllowed, false);
    }
  });

  it('refuses a test against a pack nobody released', () => {
    const { packId: draft } = testpack.createTestPack(asQAQC(), {
      reference: 'TP-DRAFT',
      systemTag: 'MEC-VENT',
      title: 'Unreleased pack',
      objective: 'Nothing yet.',
      steps: [{ step: 1, instruction: 'Run the unit.' }],
      criteria: CRITERIA,
      instrumentIds: ['MANO-77'],
    });
    const refusal = throwsCode(() => fat({ packId: draft }), 'PACK_NOT_RELEASED');
    assert.match(refusal.message ?? '', /not released/);
  });
});

describe('AC-CM-WF-03-01 a reading is a measurement', () => {
  beforeEach(freshProject);

  it('keeps the instrument, the performer, the unit and the time on every reading', () => {
    const { testId } = fat();
    const result = vendortest.recordReading(asQAQC(), testId, {
      criterionRef: 'AC-1',
      value: 402,
      unit: 'Pa',
      instrumentId: 'MANO-77',
      performedBy: 'P. Lindqvist',
    });
    assert.equal(result.withinLimits, true);
    assert.equal(result.readings, 1);
  });

  it('refuses a reading from an instrument out of certificate', () => {
    const { testId } = fat();
    const refusal = throwsCode(
      () =>
        vendortest.recordReading(asQAQC(), testId, {
          criterionRef: 'AC-1',
          value: 402,
          unit: 'Pa',
          instrumentId: 'MANO-OLD',
          performedBy: 'P. Lindqvist',
        }),
      'INSTRUMENT_NOT_CALIBRATED',
    );
    assert.match(refusal.message ?? '', /not wrong so much as unknown/);
  });

  it('refuses a reading in the wrong unit and one nobody took', () => {
    const { testId } = fat();
    const refusal = throwsCode(
      () =>
        vendortest.recordReading(asQAQC(), testId, {
          criterionRef: 'AC-1',
          value: 4.02,
          unit: 'mbar',
          instrumentId: 'MANO-77',
          performedBy: 'P. Lindqvist',
        }),
      'UNIT_MISMATCH',
    );
    assert.match(refusal.message ?? '', /converted in somebody’s head/);

    throwsCode(
      () =>
        vendortest.recordReading(asQAQC(), testId, {
          criterionRef: 'AC-1',
          value: 402,
          unit: 'Pa',
          instrumentId: 'MANO-77',
          performedBy: '  ',
        }),
      'PERFORMER_REQUIRED',
    );
  });

  it('refuses a reading against a criterion that is not in the pack', () => {
    const { testId } = fat();
    throwsCode(
      () =>
        vendortest.recordReading(asQAQC(), testId, {
          criterionRef: 'AC-9',
          value: 1,
          unit: 'Pa',
          instrumentId: 'MANO-77',
          performedBy: 'P. Lindqvist',
        }),
      'CRITERION_NOT_FOUND',
    );
  });
});

describe('AC-CM-WF-03-02 the result is calculated, the decision is separate', () => {
  beforeEach(freshProject);

  it('computes the result from the readings and records the decision beside it', () => {
    const { testId } = fat();
    goodReadings(testId);
    const result = vendortest.completeVendorTest(asQAQC(), testId, { decision: 'PASS', decidedBy: 'S. Kaur' });
    assert.equal(result.calculatedResult, 'PASS');
    assert.equal(result.decision, 'PASS');
  });

  it('refuses a pass recorded over a reading outside its limit', () => {
    const { testId } = fat();
    vendortest.recordReading(asQAQC(), testId, {
      criterionRef: 'AC-1',
      value: 340,
      unit: 'Pa',
      instrumentId: 'MANO-77',
      performedBy: 'P. Lindqvist',
    });
    vendortest.recordReading(asQAQC(), testId, {
      criterionRef: 'AC-2',
      value: 11.8,
      unit: 'A',
      instrumentId: 'CLAMP-12',
      performedBy: 'P. Lindqvist',
    });

    const refusal = throwsCode(
      () => vendortest.completeVendorTest(asQAQC(), testId, { decision: 'PASS', decidedBy: 'S. Kaur' }),
      'DECISION_CONTRADICTS_READINGS',
    );
    assert.match(refusal.message ?? '', /not a decision, it is an overwrite/);
    assert.match(refusal.message ?? '', /AC-1 at 340Pa/);

    // The same readings accepted conditionally is a decision, and the platform
    // keeps both fields.
    const result = vendortest.completeVendorTest(asQAQC(), testId, {
      decision: 'CONDITIONAL',
      decidedBy: 'S. Kaur',
      restrictions: 'The unit may not be used above 70% duty until the fan is re-raked and re-tested on site.',
      restrictionClearBy: iso(30),
    });
    assert.equal(result.calculatedResult, 'FAIL');
    assert.equal(result.decision, 'CONDITIONAL');
  });

  it('refuses a conditional acceptance with no restriction or no date', () => {
    const { testId } = fat();
    goodReadings(testId);
    throwsCode(
      () => vendortest.completeVendorTest(asQAQC(), testId, { decision: 'CONDITIONAL', decidedBy: 'S. Kaur' }),
      'RESTRICTIONS_REQUIRED',
    );
    const refusal = throwsCode(
      () =>
        vendortest.completeVendorTest(asQAQC(), testId, {
          decision: 'CONDITIONAL',
          decidedBy: 'S. Kaur',
          restrictions: 'Not to be run above 70% duty.',
        }),
      'CLOSURE_DATE_REQUIRED',
    );
    assert.match(refusal.message ?? '', /never clears/);
  });

  it('refuses to complete a test on a vendor certificate with no readings behind it', () => {
    const { testId } = fat();
    vendortest.recordReading(asQAQC(), testId, {
      criterionRef: 'AC-1',
      value: 402,
      unit: 'Pa',
      instrumentId: 'MANO-77',
      performedBy: 'P. Lindqvist',
    });
    const refusal = throwsCode(
      () => vendortest.completeVendorTest(asQAQC(), testId, { decision: 'PASS', decidedBy: 'S. Kaur' }),
      'READINGS_MISSING',
    );
    assert.match(refusal.message ?? '', /A vendor certificate asserting/);
    assert.match(refusal.message ?? '', /AC-2/);
  });

  it('refuses a reading added after the result was relied on', () => {
    const { testId } = fat();
    goodReadings(testId);
    vendortest.completeVendorTest(asQAQC(), testId, { decision: 'PASS', decidedBy: 'S. Kaur' });
    throwsCode(
      () =>
        vendortest.recordReading(asQAQC(), testId, {
          criterionRef: 'AC-1',
          value: 410,
          unit: 'Pa',
          instrumentId: 'MANO-77',
          performedBy: 'P. Lindqvist',
        }),
      'TEST_COMPLETE',
    );
  });
});

describe('AC-CM-WF-03-03 an exception does not stay at the factory', () => {
  beforeEach(freshProject);

  it('carries an open factory exception into the SAT and onto the delivery screen', () => {
    const { testId } = fat();
    goodReadings(testId);
    vendortest.raiseVendorException(asQAQC(), testId, {
      reference: 'FAT-EX-01',
      description: 'Access door seal damaged on the return air section.',
      blocking: false,
      owner: 'Vendor',
      by: iso(20),
    });
    vendortest.completeVendorTest(asQAQC(), testId, { decision: 'PASS', decidedBy: 'S. Kaur' });

    // At delivery, standing next to the crate.
    const procurement = delivery.procurementPosition(asPM());
    assert.ok(procurement.vendorExceptions.some((entry) => entry.reference === 'FAT-EX-01'));
    assert.match(procurement.summary, /factory test exception still open/);

    // And at SAT readiness.
    const sat = vendortest.startVendorTest(asQAQC(), {
      kind: 'SAT',
      packId,
      equipmentTag: 'AHU-01',
      orderedSerial: 'SN-4471',
      observedSerial: 'SN-4471',
      purchaseOrder: 'PO-2291',
      attendance: ATTENDANCE,
    });
    assert.deepEqual(sat.openFatExceptions, ['FAT-EX-01']);
  });

  it('refuses to close an exception on the vendor’s assurance alone', () => {
    const { testId } = fat();
    vendortest.raiseVendorException(asQAQC(), testId, {
      reference: 'FAT-EX-02',
      description: 'Vibration isolators not the specified type.',
      blocking: true,
      owner: 'Vendor',
      by: iso(20),
    });
    const refusal = throwsCode(
      () =>
        vendortest.closeVendorException(asQAQC(), testId, {
          reference: 'FAT-EX-02',
          closedBy: 'S. Kaur',
          verification: 'Done',
        }),
      'VERIFICATION_REQUIRED',
    );
    assert.match(refusal.message ?? '', /letterhead has closed more open items/);

    vendortest.closeVendorException(asQAQC(), testId, {
      reference: 'FAT-EX-02',
      closedBy: 'S. Kaur',
      verification: 'Correct isolators fitted and photographed against the data sheet at the works on the 14th.',
    });
    assert.equal(vendortest.openVendorExceptionsFor(asQAQC(), 'AHU-01').length, 0);
  });

  it('refuses an exception with no owner or no date, which is how it travels with the crate', () => {
    const { testId } = fat();
    const refusal = throwsCode(
      () =>
        vendortest.raiseVendorException(asQAQC(), testId, {
          reference: 'FAT-EX-03',
          description: 'Paint finish marked.',
          blocking: false,
          owner: '  ',
          by: iso(20),
        }),
      'EXCEPTION_INCOMPLETE',
    );
    assert.match(refusal.message ?? '', /closed by the delivery note/);
  });
});

describe('shipping release', () => {
  beforeEach(freshProject);

  it('releases a passed test under a named authority', () => {
    const { testId } = fat();
    goodReadings(testId);
    vendortest.completeVendorTest(asQAQC(), testId, { decision: 'PASS', decidedBy: 'S. Kaur' });

    const result = vendortest.releaseForShipping(asQAQC(), testId, {
      releasedBy: 'S. Kaur',
      authority: 'Commissioning manager, under the employer’s requirements clause 8.2',
    });
    assert.equal(result.serial, 'SN-4471');
    assert.equal(vendortest.vendorTestPosition(asQAQC()).tests[0]!.shipped, true);
  });

  it('refuses release when the unit tested is not the unit ordered', () => {
    const { testId } = fat({ observedSerial: 'SN-4472' });
    goodReadings(testId);
    vendortest.completeVendorTest(asQAQC(), testId, { decision: 'PASS', decidedBy: 'S. Kaur' });

    const refusal = throwsCode(
      () => vendortest.releaseForShipping(asQAQC(), testId, { releasedBy: 'S. Kaur', authority: 'Commissioning manager' }),
      'SERIAL_MISMATCH',
    );
    assert.match(refusal.message ?? '', /both are found on site months later/);
    assert.equal(vendortest.vendorTestPosition(asQAQC()).tests[0]!.serialMismatch, true);
  });

  it('refuses release over an open blocking exception', () => {
    const { testId } = fat();
    goodReadings(testId);
    vendortest.raiseVendorException(asQAQC(), testId, {
      reference: 'FAT-EX-04',
      description: 'Control panel wired to the superseded schematic.',
      blocking: true,
      owner: 'Vendor',
      by: iso(10),
    });
    vendortest.completeVendorTest(asQAQC(), testId, { decision: 'PASS', decidedBy: 'S. Kaur' });

    const refusal = throwsCode(
      () => vendortest.releaseForShipping(asQAQC(), testId, { releasedBy: 'S. Kaur', authority: 'Commissioning manager' }),
      'BLOCKING_EXCEPTIONS',
    );
    assert.match(refusal.message ?? '', /closed by the shipping paperwork/);
  });

  it('refuses release with no authority named, on a SAT, or before completion', () => {
    const { testId } = fat();
    throwsCode(
      () => vendortest.releaseForShipping(asQAQC(), testId, { releasedBy: 'S. Kaur', authority: 'Commissioning manager' }),
      'TEST_INCOMPLETE',
    );
    goodReadings(testId);
    vendortest.completeVendorTest(asQAQC(), testId, { decision: 'PASS', decidedBy: 'S. Kaur' });
    throwsCode(
      () => vendortest.releaseForShipping(asQAQC(), testId, { releasedBy: 'S. Kaur', authority: '  ' }),
      'RELEASE_UNAUTHORISED',
    );

    const sat = vendortest.startVendorTest(asQAQC(), {
      kind: 'SAT',
      packId,
      equipmentTag: 'AHU-01',
      orderedSerial: 'SN-4471',
      observedSerial: 'SN-4471',
      purchaseOrder: 'PO-2291',
      attendance: ATTENDANCE,
    });
    throwsCode(
      () => vendortest.releaseForShipping(asQAQC(), sat.testId, { releasedBy: 'S. Kaur', authority: 'Commissioning manager' }),
      'NOT_A_FAT',
    );
  });

  it('reports a conditional acceptance whose restriction has passed its date', () => {
    const { testId } = fat();
    vendortest.recordReading(asQAQC(), testId, {
      criterionRef: 'AC-1',
      value: 340,
      unit: 'Pa',
      instrumentId: 'MANO-77',
      performedBy: 'P. Lindqvist',
    });
    vendortest.recordReading(asQAQC(), testId, {
      criterionRef: 'AC-2',
      value: 11.8,
      unit: 'A',
      instrumentId: 'CLAMP-12',
      performedBy: 'P. Lindqvist',
    });
    vendortest.completeVendorTest(asQAQC(), testId, {
      decision: 'CONDITIONAL',
      decidedBy: 'S. Kaur',
      restrictions: 'Not above 70% duty until the fan is re-raked and re-tested on site.',
      restrictionClearBy: iso(-2),
    });

    const position = vendortest.vendorTestPosition(asQAQC());
    assert.equal(position.conditional[0]!.overdue, true);
    assert.match(position.summary, /1 conditional acceptance/);
  });

  it('refuses a test with nobody in attendance', () => {
    throwsCode(
      () => fat({ attendance: ATTENDANCE.map((person) => ({ ...person, attended: false })) }),
      'NOBODY_ATTENDED',
    );
  });
});
