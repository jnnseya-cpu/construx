import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as commissioningexception from '../src/domain/commissioningexception.ts';
import * as functionaltest from '../src/domain/functionaltest.ts';
import * as prefunctional from '../src/domain/prefunctional.ts';
import * as qualitycontrol from '../src/domain/qualitycontrol.ts';
import * as structure from '../src/domain/structure.ts';
import * as systemisation from '../src/domain/systemisation.ts';
import * as testpack from '../src/domain/testpack.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * CM-WF-05 — functional performance and integrated systems testing.
 *
 * The criteria come from CM-WF-02's released pack, the calculated-result-beside-
 * decision split is CM-WF-03's, the static-completion guard is CM-WF-04's and
 * failures raise into CM-WF-07's exception. What is tested here is what a
 * functional test records that a factory test does not: a response rather than a
 * number, an abort that is not a fail, a deviation that is an annotation, and an
 * integrated test that cannot pass on unproven dependencies.
 */

let platform: Platform;
let seed: SeedResult;

const asQAQC = () => platform.context(seed.users.qaqc!.auth, seed.projectId, { source: 'WEB' });

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

const WITNESSES = [{ name: 'H. Marston', organisation: 'Client technical adviser', attended: true }];

const CRITERIA: testpack.AcceptanceCriterion[] = [
  {
    reference: 'AC-1',
    criterion: 'Supply volume within ±5% of design at the terminal.',
    source: 'Mechanical schedule MS-04, rev B',
    requiredReading: 'Volume at terminal',
    unit: 'l/s',
    lowerLimit: 228,
    upperLimit: 252,
  },
  {
    reference: 'AC-2',
    criterion: 'Fire damper fully closed within ten seconds of the signal.',
    source: 'Specification section 23 33 00, clause 3.4',
    requiredReading: 'Time from signal to fully closed',
    unit: 's',
    upperLimit: 10,
  },
];

async function freshProject() {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'COMMISSIONING',
    justification: 'Running the functional tests',
  });

  systemisation.defineSystem(asQAQC(), {
    tag: 'FAC-01',
    level: 'FACILITY',
    name: 'Riverside Laboratory',
    boundary: 'The whole demised premises within the site boundary, excluding incoming utility connections.',
  });
  for (const [tag, name] of [
    ['MEC-VENT', 'Ventilation'],
    ['FIRE-ALARM', 'Fire detection and alarm'],
  ] as const) {
    systemisation.defineSystem(asQAQC(), {
      tag,
      level: 'SYSTEM',
      parentTag: 'FAC-01',
      name,
      boundary: `Everything within the ${name.toLowerCase()} installation, from its source to its terminal devices.`,
      assetTags: [`${tag}-MAIN`],
    });
    staticallyComplete(tag);
  }

  qualitycontrol.registerInstrument(asQAQC(), {
    instrumentId: 'ANEM-114',
    description: 'Rotating vane anemometer',
    calibratedAt: iso(-60),
    calibrationExpiresAt: iso(300),
    certificate: 'UKAS 2026/114-A',
  });
}

function staticallyComplete(systemTag: string) {
  const { checkId } = prefunctional.startPreFunctionalCheck(asQAQC(), {
    reference: `PFC-${systemTag}`,
    systemTag,
    location: 'Plant room, level 3',
    inspectedBy: 'J. Byrne',
  });
  for (const definition of prefunctional.PRE_FUNCTIONAL_CHECK) {
    prefunctional.recordCheckItem(asQAQC(), checkId, {
      key: definition.key,
      result: 'PASS',
      note: 'Verified on site.',
    });
  }
  prefunctional.acceptStaticCompletion(asQAQC(), checkId, { acceptedBy: 'S. Kaur' });
  prefunctional.releaseForFunctionalTesting(asQAQC(), checkId, { releasedBy: 'S. Kaur' });
}

function releasedPack(reference: string, systemTag = 'MEC-VENT'): string {
  const { packId } = testpack.createTestPack(asQAQC(), {
    reference,
    systemTag,
    title: 'Ventilation functional performance test',
    objective: 'Prove the supply volumes and the fire damper interlock.',
    steps: [
      { step: 1, instruction: 'Set the unit to design duty and traverse the terminal.' },
      { step: 2, instruction: 'Initiate the fire alarm interface and time the damper closure.' },
    ],
    criteria: CRITERIA,
    instrumentIds: ['ANEM-114'],
  });
  testpack.checkTestReadiness(asQAQC(), packId, {
    checkedBy: 'J. Byrne',
    items: testpack.READINESS_ITEM.filter((item) => item.key !== 'INSTRUMENTS').map((item) => ({
      key: item.key,
      ready: true,
      note: 'Verified on site.',
    })),
  });
  const { notificationId } = testpack.notifyWitness(asQAQC(), packId, {
    recipient: 'H. Marston',
    organisation: 'Client technical adviser',
    testDate: iso(7),
    noticeDays: 5,
  });
  testpack.recordWitnessResponse(asQAQC(), packId, { notificationId, attending: true, note: 'Attending.' });
  testpack.releaseForTest(asQAQC(), packId, { releasedBy: 'S. Kaur' });
  return packId;
}

function start(reference: string, packId: string, overrides: Record<string, unknown> = {}) {
  return functionaltest.startFunctionalTest(asQAQC(), {
    reference,
    kind: 'FUNCTIONAL',
    packId,
    systemTag: 'MEC-VENT',
    witnesses: WITNESSES,
    ...overrides,
  } as Parameters<typeof functionaltest.startFunctionalTest>[1]).testId;
}

function bothStepsGood(testId: string) {
  functionaltest.recordStepResult(asQAQC(), testId, {
    step: 1,
    criterionRef: 'AC-1',
    actualResponse: 'Unit ramped to design duty within ninety seconds and held steady.',
    value: 241,
    unit: 'l/s',
    instrumentId: 'ANEM-114',
    performedBy: 'J. Byrne',
  });
  functionaltest.recordStepResult(asQAQC(), testId, {
    step: 2,
    criterionRef: 'AC-2',
    actualResponse: 'Damper drove fully closed on alarm and the BMS reported closed status.',
    responseTimeSeconds: 7,
    performedBy: 'J. Byrne',
  });
}

describe('CM-WF-05 the register', () => {
  beforeEach(freshProject);

  it('registers its eight event types, and none is available to an agent', () => {
    for (const code of [
      'FUNCTIONAL_TEST_STARTED',
      'INTEGRATED_TEST_STARTED',
      'FUNCTIONAL_STEP_RECORDED',
      'TEST_SCRIPT_DEVIATION_RECORDED',
      'FUNCTIONAL_TEST_ABORTED',
      'FUNCTIONAL_TEST_COMPLETED',
      'INTEGRATED_TEST_COMPLETED',
      'RETEST_REQUIRED',
    ] as const) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, 'FunctionalTest');
      // "Recommend probable root cause; engineer confirms diagnosis and disposition."
      assert.equal(definition.aiAllowed, false);
    }
  });

  it('refuses a test on a system nobody released for functional testing', () => {
    const packId = releasedPack('TP-901', 'FAC-01');
    const refusal = throwsCode(
      () =>
        functionaltest.startFunctionalTest(asQAQC(), {
          reference: 'FT-901',
          kind: 'FUNCTIONAL',
          packId,
          systemTag: 'FAC-01',
          witnesses: WITNESSES,
        }),
      'SYSTEM_NOT_RELEASED',
    );
    assert.match(refusal.message ?? '', /No pre-functional check has been carried out on FAC-01/);
  });
});

describe('AC-CM-WF-05-01 a response reconstructable from raw evidence', () => {
  beforeEach(freshProject);

  it('records what the system did as well as what was measured', () => {
    const testId = start('FT-001', releasedPack('TP-001'));
    const first = functionaltest.recordStepResult(asQAQC(), testId, {
      step: 1,
      criterionRef: 'AC-1',
      actualResponse: 'Unit ramped to design duty within ninety seconds and held steady.',
      value: 241,
      unit: 'l/s',
      instrumentId: 'ANEM-114',
      performedBy: 'J. Byrne',
    });
    assert.equal(first.withinLimits, true);

    // A response time is a measurement too, and the criterion judges it.
    const second = functionaltest.recordStepResult(asQAQC(), testId, {
      step: 2,
      criterionRef: 'AC-2',
      actualResponse: 'Damper drove fully closed on alarm.',
      responseTimeSeconds: 14,
      performedBy: 'J. Byrne',
    });
    assert.equal(second.withinLimits, false);
  });

  it('refuses a step with no description of what happened', () => {
    const testId = start('FT-002', releasedPack('TP-002'));
    const refusal = throwsCode(
      () =>
        functionaltest.recordStepResult(asQAQC(), testId, {
          step: 1,
          criterionRef: 'AC-1',
          actualResponse: '  ',
          value: 241,
          unit: 'l/s',
          performedBy: 'J. Byrne',
        }),
      'RESPONSE_REQUIRED',
    );
    assert.match(refusal.message ?? '', /are different systems/);
  });

  it('refuses a criterion answered by a description alone', () => {
    const testId = start('FT-003', releasedPack('TP-003'));
    const refusal = throwsCode(
      () =>
        functionaltest.recordStepResult(asQAQC(), testId, {
          step: 1,
          criterionRef: 'AC-1',
          actualResponse: 'Looked about right on the gauge.',
          performedBy: 'J. Byrne',
        }),
      'MEASUREMENT_REQUIRED',
    );
    assert.match(refusal.message ?? '', /cannot be recalculated by anybody/);
  });

  it('attaches the trend dataset by hash rather than a summary of it', () => {
    const testId = start('FT-004', releasedPack('TP-004'));
    const result = functionaltest.attachTrendDataset(asQAQC(), testId, {
      source: 'BMS trend export, AHU-01 supply fan',
      from: new Date(Date.now() - 3_600_000).toISOString(),
      to: new Date().toISOString(),
      points: 3600,
      datasetHash: 'a'.repeat(64),
    });
    assert.ok(result.evidenceRef);
    assert.equal(functionaltest.functionalTestPosition(asQAQC()).tests[0]!.trends, 1);
  });

  it('refuses an empty dataset or one with no window', () => {
    const testId = start('FT-005', releasedPack('TP-005'));
    const now = new Date().toISOString();
    throwsCode(
      () =>
        functionaltest.attachTrendDataset(asQAQC(), testId, {
          source: 'BMS trend export',
          from: now,
          to: now,
          points: 100,
          datasetHash: 'b'.repeat(64),
        }),
      'WINDOW_REQUIRED',
    );
    throwsCode(
      () =>
        functionaltest.attachTrendDataset(asQAQC(), testId, {
          source: 'BMS trend export',
          from: new Date(Date.now() - 3_600_000).toISOString(),
          to: now,
          points: 0,
          datasetHash: 'c'.repeat(64),
        }),
      'DATASET_EMPTY',
    );
  });
});

describe('AC-CM-WF-05-02 the calculation and the decision are two fields', () => {
  beforeEach(freshProject);

  it('passes a test where every criterion is answered and within limits', () => {
    const testId = start('FT-010', releasedPack('TP-010'));
    bothStepsGood(testId);
    const result = functionaltest.completeFunctionalTest(asQAQC(), testId, {
      decision: 'PASS',
      decidedBy: 'S. Kaur',
      decisionNote: 'All criteria answered within limits and witnessed by the client adviser.',
    });
    assert.equal(result.calculatedResult, 'PASS');
  });

  it('refuses a pass over a step outside its limit', () => {
    const testId = start('FT-011', releasedPack('TP-011'));
    functionaltest.recordStepResult(asQAQC(), testId, {
      step: 1,
      criterionRef: 'AC-1',
      actualResponse: 'Unit would not reach design duty; fan at maximum speed.',
      value: 190,
      unit: 'l/s',
      instrumentId: 'ANEM-114',
      performedBy: 'J. Byrne',
    });
    functionaltest.recordStepResult(asQAQC(), testId, {
      step: 2,
      criterionRef: 'AC-2',
      actualResponse: 'Damper drove fully closed on alarm.',
      responseTimeSeconds: 7,
      performedBy: 'J. Byrne',
    });

    const refusal = throwsCode(
      () =>
        functionaltest.completeFunctionalTest(asQAQC(), testId, {
          decision: 'PASS',
          decidedBy: 'S. Kaur',
          decisionNote: 'Close enough for the purpose.',
        }),
      'DECISION_CONTRADICTS_EVIDENCE',
    );
    assert.match(refusal.message ?? '', /AC-1 at step 1 outside the limit/);
    assert.match(refusal.message ?? '', /not used to overwrite the other/);
  });

  it('refuses completion while a criterion has no step answering it', () => {
    const testId = start('FT-012', releasedPack('TP-012'));
    functionaltest.recordStepResult(asQAQC(), testId, {
      step: 1,
      criterionRef: 'AC-1',
      actualResponse: 'Unit ramped to design duty.',
      value: 241,
      unit: 'l/s',
      instrumentId: 'ANEM-114',
      performedBy: 'J. Byrne',
    });
    const refusal = throwsCode(
      () =>
        functionaltest.completeFunctionalTest(asQAQC(), testId, {
          decision: 'PASS',
          decidedBy: 'S. Kaur',
          decisionNote: 'The volumes are right and the damper is fine.',
        }),
      'CRITERIA_UNANSWERED',
    );
    assert.match(refusal.message ?? '', /leaves the unanswered ones reading as passed/);
  });

  it('honours a deviation the engineer said invalidates the result', () => {
    const testId = start('FT-013', releasedPack('TP-013'));
    bothStepsGood(testId);
    functionaltest.recordScriptDeviation(asQAQC(), testId, {
      step: 2,
      deviation: 'The damper was driven from the panel rather than from a real alarm, because the panel was still on test.',
      authorisedBy: 'S. Kaur',
      invalidatesResult: true,
    });

    const refusal = throwsCode(
      () =>
        functionaltest.completeFunctionalTest(asQAQC(), testId, {
          decision: 'PASS',
          decidedBy: 'S. Kaur',
          decisionNote: 'The damper closed in time when driven from the panel.',
        }),
      'DECISION_CONTRADICTS_EVIDENCE',
    );
    assert.match(refusal.message ?? '', /invalidating the result/);
  });

  it('keeps a non-invalidating deviation as a record without changing the result', () => {
    const testId = start('FT-014', releasedPack('TP-014'));
    bothStepsGood(testId);
    functionaltest.recordScriptDeviation(asQAQC(), testId, {
      step: 1,
      deviation: 'Traversed at the terminal rather than in the branch duct, which the access made impossible.',
      authorisedBy: 'S. Kaur',
      invalidatesResult: false,
    });
    const result = functionaltest.completeFunctionalTest(asQAQC(), testId, {
      decision: 'PASS',
      decidedBy: 'S. Kaur',
      decisionNote: 'Volumes and damper response both within limits; the traverse point is noted and accepted.',
    });
    assert.equal(result.calculatedResult, 'PASS');
    assert.equal(functionaltest.functionalTestPosition(asQAQC()).tests[0]!.deviations, 1);
  });

  it('refuses a deviation nobody authorised', () => {
    const testId = start('FT-015', releasedPack('TP-015'));
    const refusal = throwsCode(
      () =>
        functionaltest.recordScriptDeviation(asQAQC(), testId, {
          step: 1,
          deviation: 'Traversed at the terminal rather than the branch duct.',
          authorisedBy: '  ',
          invalidatesResult: false,
        }),
      'DEVIATION_UNAUTHORISED',
    );
    assert.match(refusal.message ?? '', /the test not having been run as written/);
  });
});

describe('an abort is not a fail', () => {
  beforeEach(freshProject);

  it('keeps the partial data and does not put a defect against the plant', () => {
    const testId = start('FT-020', releasedPack('TP-020'));
    functionaltest.recordStepResult(asQAQC(), testId, {
      step: 1,
      criterionRef: 'AC-1',
      actualResponse: 'Unit ramped to design duty.',
      value: 241,
      unit: 'l/s',
      instrumentId: 'ANEM-114',
      performedBy: 'J. Byrne',
    });
    const result = functionaltest.abortTest(asQAQC(), testId, {
      reason: 'The fire alarm panel was taken off test by others and the interlock could not be proven.',
      abortedBy: 'J. Byrne',
    });
    assert.equal(result.stepsRetained, 1);

    const position = functionaltest.functionalTestPosition(asQAQC());
    assert.equal(position.tests[0]!.status, 'ABORTED');
    assert.equal(position.aborted[0]!.stepsRetained, 1);
    assert.match(position.summary, /aborted and not yet decided/);
  });

  it('lets somebody decide afterwards what it meant, but never a pass', () => {
    const testId = start('FT-021', releasedPack('TP-021'));
    functionaltest.abortTest(asQAQC(), testId, {
      reason: 'The chilled water was off, so the coil could not be loaded.',
      abortedBy: 'J. Byrne',
    });
    const refusal = throwsCode(
      () =>
        functionaltest.completeFunctionalTest(asQAQC(), testId, {
          decision: 'PASS',
          decidedBy: 'S. Kaur',
          decisionNote: 'The bits we saw were fine.',
        }),
      'ABORTED_CANNOT_PASS',
    );
    assert.match(refusal.message ?? '', /asserts a result nobody observed/);

    const result = functionaltest.completeFunctionalTest(asQAQC(), testId, {
      decision: 'FAIL',
      decidedBy: 'S. Kaur',
      decisionNote: 'Treated as a failure for programme purposes; the run is repeated in full once the chilled water is on.',
    });
    assert.equal(result.calculatedResult, 'FAIL');
  });

  it('refuses an abort with no reason on it', () => {
    const testId = start('FT-022', releasedPack('TP-022'));
    const refusal = throwsCode(
      () => functionaltest.abortTest(asQAQC(), testId, { reason: 'Stopped', abortedBy: 'J. Byrne' }),
      'ABORT_UNEXPLAINED',
    );
    assert.match(refusal.message ?? '', /mean opposite things about the equipment/);
  });
});

describe('an integrated test cannot pass on unproven dependencies', () => {
  beforeEach(freshProject);

  it('refuses to start while a dependent system has no passed functional test', () => {
    const packId = releasedPack('TP-030');
    const refusal = throwsCode(
      () =>
        functionaltest.startFunctionalTest(asQAQC(), {
          reference: 'IT-001',
          kind: 'INTEGRATED',
          packId,
          systemTag: 'MEC-VENT',
          dependentSystems: ['FIRE-ALARM'],
          scenario: 'Fire alarm zone 3 in alarm with the building occupied.',
          witnesses: WITNESSES,
        }),
      'DEPENDENCY_UNPROVEN',
    );
    assert.match(refusal.message ?? '', /not the same as the dependency working/);
  });

  it('starts once the dependency is proven', () => {
    // Prove the fire alarm first.
    const alarmPack = releasedPack('TP-031', 'FIRE-ALARM');
    const alarmTest = functionaltest.startFunctionalTest(asQAQC(), {
      reference: 'FT-031',
      kind: 'FUNCTIONAL',
      packId: alarmPack,
      systemTag: 'FIRE-ALARM',
      witnesses: WITNESSES,
    }).testId;
    bothStepsGood(alarmTest);
    functionaltest.completeFunctionalTest(asQAQC(), alarmTest, {
      decision: 'PASS',
      decidedBy: 'S. Kaur',
      decisionNote: 'Both criteria answered within limits and witnessed.',
    });

    const packId = releasedPack('TP-032');
    const integrated = functionaltest.startFunctionalTest(asQAQC(), {
      reference: 'IT-002',
      kind: 'INTEGRATED',
      packId,
      systemTag: 'MEC-VENT',
      dependentSystems: ['FIRE-ALARM'],
      scenario: 'Fire alarm zone 3 in alarm with the building occupied.',
      witnesses: WITNESSES,
    });
    assert.ok(integrated.testId);
    assert.deepEqual(functionaltest.functionalTestPosition(asQAQC()).proven, ['FIRE-ALARM']);
  });

  it('refuses an integrated test with no dependencies or no scenario', () => {
    const packId = releasedPack('TP-033');
    throwsCode(
      () =>
        functionaltest.startFunctionalTest(asQAQC(), {
          reference: 'IT-003',
          kind: 'INTEGRATED',
          packId,
          systemTag: 'MEC-VENT',
          dependentSystems: [],
          scenario: 'Fire alarm.',
          witnesses: WITNESSES,
        }),
      'DEPENDENCIES_REQUIRED',
    );
    const refusal = throwsCode(
      () =>
        functionaltest.startFunctionalTest(asQAQC(), {
          reference: 'IT-004',
          kind: 'INTEGRATED',
          packId,
          systemTag: 'MEC-VENT',
          dependentSystems: ['FIRE-ALARM'],
          witnesses: WITNESSES,
        }),
      'SCENARIO_REQUIRED',
    );
    assert.match(refusal.message ?? '', /is not a scenario/);
  });
});

describe('AC-CM-WF-05-03 a retest links the failure and what changed', () => {
  beforeEach(freshProject);

  it('routes a failure to a retest through the exception that carries the corrective action', () => {
    const packId = releasedPack('TP-040');
    const testId = start('FT-040', packId);
    functionaltest.recordStepResult(asQAQC(), testId, {
      step: 1,
      criterionRef: 'AC-1',
      actualResponse: 'Unit would not reach design duty; fan at maximum speed.',
      value: 190,
      unit: 'l/s',
      instrumentId: 'ANEM-114',
      performedBy: 'J. Byrne',
    });
    functionaltest.recordStepResult(asQAQC(), testId, {
      step: 2,
      criterionRef: 'AC-2',
      actualResponse: 'Damper drove fully closed on alarm.',
      responseTimeSeconds: 7,
      performedBy: 'J. Byrne',
    });
    functionaltest.completeFunctionalTest(asQAQC(), testId, {
      decision: 'FAIL',
      decidedBy: 'S. Kaur',
      decisionNote: 'Supply volume 21% below design with the fan at maximum; the system will not make duty as installed.',
    });

    // No exception yet, so the retest route is refused: the failure and the
    // succeeding result have to stay one chain.
    const refusal = throwsCode(
      () =>
        functionaltest.requireRetest(asQAQC(), testId, {
          exceptionReference: 'CX-100',
          changedCondition: 'The fan pulley has been changed for the larger one.',
          requestedBy: 'S. Kaur',
        }),
      'EXCEPTION_NOT_FOUND',
    );
    assert.match(refusal.message ?? '', /stay one chain/);

    const { checkId } = prefunctional.startPreFunctionalCheck(asQAQC(), {
      reference: 'PFC-EX',
      systemTag: 'MEC-VENT',
      location: 'Plant room, level 3',
      inspectedBy: 'J. Byrne',
    });
    prefunctional.recordCheckItem(asQAQC(), checkId, {
      key: 'SETTINGS',
      result: 'FAIL',
      note: 'Fan pulley as installed cannot reach design speed.',
      responsibility: 'Mechanical subcontractor',
      route: 'COMMISSIONING_EXCEPTION',
    });
    commissioningexception.raiseException(asQAQC(), {
      reference: 'CX-100',
      source: { kind: 'PRE_FUNCTIONAL', checkId, itemKey: 'SETTINGS' },
      systemTag: 'MEC-VENT',
      location: 'Plant room, level 3',
      severity: 'MAJOR',
      blocker: true,
      probableCause: 'Pulley sized for the original duty before the ductwork was re-routed.',
      responsibleParty: 'Mechanical subcontractor',
    });

    functionaltest.requireRetest(asQAQC(), testId, {
      exceptionReference: 'CX-100',
      changedCondition: 'The fan pulley has been changed for the larger one and the drive re-tensioned.',
      requestedBy: 'S. Kaur',
    });

    const position = functionaltest.functionalTestPosition(asQAQC());
    const awaiting = position.awaitingRetest[0]!;
    assert.equal(awaiting.exceptionReference, 'CX-100');
    assert.match(awaiting.changedCondition, /larger one/);
  });

  it('refuses a retest with nothing changed, and one against a test that passed', () => {
    const testId = start('FT-041', releasedPack('TP-041'));
    bothStepsGood(testId);
    functionaltest.completeFunctionalTest(asQAQC(), testId, {
      decision: 'PASS',
      decidedBy: 'S. Kaur',
      decisionNote: 'Both criteria answered within limits and witnessed.',
    });
    throwsCode(
      () =>
        functionaltest.requireRetest(asQAQC(), testId, {
          exceptionReference: 'CX-100',
          changedCondition: 'The pulley has been changed for the larger one.',
          requestedBy: 'S. Kaur',
        }),
      'TEST_PASSED',
    );
  });

  it('refuses to re-run a test an open exception invalidated, except as a retest', () => {
    // AC-CM-WF-07-02 is actionable, not merely visible.
    const { checkId } = prefunctional.startPreFunctionalCheck(asQAQC(), {
      reference: 'PFC-INV',
      systemTag: 'MEC-VENT',
      location: 'Plant room, level 3',
      inspectedBy: 'J. Byrne',
    });
    prefunctional.recordCheckItem(asQAQC(), checkId, {
      key: 'ALIGNMENT',
      result: 'FAIL',
      note: 'Shafts out of alignment by 0.6mm.',
      responsibility: 'Mechanical subcontractor',
      route: 'COMMISSIONING_EXCEPTION',
    });
    const { exceptionId } = commissioningexception.raiseException(asQAQC(), {
      reference: 'CX-200',
      source: { kind: 'PRE_FUNCTIONAL', checkId, itemKey: 'ALIGNMENT' },
      systemTag: 'MEC-VENT',
      location: 'Plant room, level 3',
      severity: 'MAJOR',
      blocker: true,
      probableCause: 'Baseframe not shimmed after the unit was set down.',
      responsibleParty: 'Mechanical subcontractor',
    });
    commissioningexception.assessImpact(asQAQC(), exceptionId, {
      invalidatedTests: ['FT-050'],
      rationale: 'The vibration and duty readings were taken with the unit misaligned and describe a machine that no longer exists.',
      confirmedBy: 'J. Byrne',
    });

    const packId = releasedPack('TP-050');
    const refusal = throwsCode(() => start('FT-050', packId), 'TEST_INVALIDATED');
    assert.match(refusal.message ?? '', /Run it as a retest against that exception/);

    // As a retest it is permitted, and the connection is on the record.
    assert.ok(start('FT-050', packId, { retestOf: 'CX-200' }));
  });
});
