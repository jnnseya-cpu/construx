import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as commissioningexception from '../src/domain/commissioningexception.ts';
import * as prefunctional from '../src/domain/prefunctional.ts';
import * as qualitycontrol from '../src/domain/qualitycontrol.ts';
import * as structure from '../src/domain/structure.ts';
import * as systemisation from '../src/domain/systemisation.ts';
import * as testpack from '../src/domain/testpack.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * CM-WF-04 — pre-functional and static completion — and CM-WF-07, the exception
 * lifecycle it raises into.
 *
 * CM-WF-07 is built and tested here alongside CM-WF-04 because the two are one
 * vertical: a failed check has to go somewhere, and building two modules that
 * each kept their own idea of an open item is exactly what rule 6 forbids.
 */

let platform: Platform;
let seed: SeedResult;

const asQAQC = () => platform.context(seed.users.qaqc!.auth, seed.projectId, { source: 'WEB' });
const asPlanner = () => platform.context(seed.users.planner!.auth, seed.projectId, { source: 'WEB' });

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

async function freshProject() {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'COMMISSIONING',
    justification: 'Running the pre-functional checks',
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
}

function startCheck(reference = 'PFC-001') {
  return prefunctional.startPreFunctionalCheck(asQAQC(), {
    reference,
    systemTag: 'MEC-VENT',
    equipmentTag: 'AHU-01',
    location: 'Plant room, level 3',
    inspectedBy: 'J. Byrne',
  }).checkId;
}

/** Every item a pass, which is what a system ready for commissioning looks like. */
function passAll(checkId: string, overrides: Partial<Record<string, prefunctional.CheckItem>> = {}) {
  for (const definition of prefunctional.PRE_FUNCTIONAL_CHECK) {
    const override = overrides[definition.key];
    prefunctional.recordCheckItem(
      asQAQC(),
      checkId,
      override ?? { key: definition.key, result: 'PASS', note: 'Verified on site.', evidenceRef: `EV-${definition.key}` },
    );
  }
}

describe('CM-WF-04 and CM-WF-07 the register', () => {
  beforeEach(freshProject);

  it('registers both event sets, and none is available to an agent', () => {
    for (const [code, entity] of [
      ['PREFUNCTIONAL_CHECK_STARTED', 'PreFunctionalCheck'],
      ['PREFUNCTIONAL_ITEM_RECORDED', 'PreFunctionalCheck'],
      ['STATIC_COMPLETION_ACCEPTED', 'PreFunctionalCheck'],
      ['FUNCTIONAL_TEST_RELEASED', 'PreFunctionalCheck'],
      ['STATIC_COMPLETION_INVALIDATED', 'PreFunctionalCheck'],
      ['COMMISSIONING_EXCEPTION_RAISED', 'CommissioningException'],
      ['CORRECTIVE_ACTION_COMPLETED', 'CommissioningException'],
      ['EXCEPTION_IMPACT_ASSESSED', 'CommissioningException'],
      ['RETEST_STARTED', 'CommissioningException'],
      ['RETEST_RESULT_RECORDED', 'CommissioningException'],
      ['EXCEPTION_CLOSED', 'CommissioningException'],
      ['EXCEPTION_CONDITIONALLY_ACCEPTED', 'CommissioningException'],
    ] as const) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, entity);
      // "Image analysis may prompt inspection; it cannot establish technical pass."
      assert.equal(definition.aiAllowed, false);
    }
  });
});

describe('AC-CM-WF-04-01 readiness from accepted checks, not file count', () => {
  beforeEach(freshProject);

  it('weights the checks so a system cannot reach 100% on the easy half', () => {
    const checkId = startCheck();
    // The four heaviest items failed, the light ones passed. A file count would
    // read this as almost complete.
    for (const definition of prefunctional.PRE_FUNCTIONAL_CHECK) {
      const heavy = definition.weight === 3;
      prefunctional.recordCheckItem(asQAQC(), checkId, {
        key: definition.key,
        result: heavy ? 'FAIL' : 'PASS',
        note: heavy ? 'Outstanding at inspection.' : 'Verified on site.',
        responsibility: heavy ? 'Mechanical subcontractor' : undefined,
        route: heavy ? 'RETURN_TO_CONSTRUCTION' : undefined,
      });
    }

    const position = prefunctional.preFunctionalPosition(asQAQC());
    const check = position.checks[0]!;
    // Heavy items are 5 × 3 = 15 of the 27 total weight, so passing everything
    // else leaves readiness well under half.
    assert.ok(check.readinessPercent < 50, `readiness reported as ${check.readinessPercent}%`);
    assert.equal(check.safetyCriticalFailures.length, 4);
  });

  it('leaves a not-applicable item out of the arithmetic rather than counting it as a pass', () => {
    const checkId = startCheck();
    passAll(checkId, {
      LUBRICATION: {
        key: 'LUBRICATION',
        result: 'NOT_APPLICABLE',
        note: 'Sealed-for-life bearings.',
        notApplicableRationale: 'The unit has sealed-for-life bearings; the manufacturer specifies no lubrication schedule.',
        notApplicableApprovedBy: 'S. Kaur',
      },
    });

    // Everything else passed, so readiness is 100% of what applies — not 92% of
    // a list containing an item that does not exist for this equipment.
    assert.equal(prefunctional.preFunctionalPosition(asQAQC()).checks[0]!.readinessPercent, 100);
  });

  it('counts an observation as accepted and a failure as nothing', () => {
    const items: prefunctional.CheckItem[] = [
      { key: 'LABELLING', result: 'OBSERVATION', note: 'Two valve tags handwritten rather than engraved.' },
      { key: 'ACCESS', result: 'FAIL', note: 'No safe access to the fan bearings.' },
    ];
    const readiness = prefunctional.readinessOf(items);
    // LABELLING weighs 1 and ACCESS weighs 2.
    assert.equal(readiness.accepted, 1);
    assert.equal(readiness.total, 3);
  });

  it('aggregates weighted readiness per system across its checks', () => {
    const first = startCheck('PFC-001');
    passAll(first);
    const second = startCheck('PFC-002');
    passAll(second, {
      ACCESS: { key: 'ACCESS', result: 'FAIL', note: 'No access platform.', responsibility: 'Main contractor', route: 'RETURN_TO_CONSTRUCTION' },
    });

    const system = prefunctional.preFunctionalPosition(asQAQC()).systemReadiness.find((s) => s.systemTag === 'MEC-VENT')!;
    assert.equal(system.checks, 2);
    assert.ok(system.percent > 90 && system.percent < 100);
  });
});

describe('AC-CM-WF-04-02 every failure has a route back', () => {
  beforeEach(freshProject);

  it('refuses a failure with no responsibility or no route', () => {
    const checkId = startCheck();
    const refusal = throwsCode(
      () =>
        prefunctional.recordCheckItem(asQAQC(), checkId, {
          key: 'ACCESS',
          result: 'FAIL',
          note: 'No safe access to the fan bearings.',
        }),
      'FAILURE_UNROUTED',
    );
    assert.match(refusal.message ?? '', /a finding in a folder/);

    throwsCode(
      () =>
        prefunctional.recordCheckItem(asQAQC(), checkId, {
          key: 'ACCESS',
          result: 'FAIL',
          note: 'No safe access to the fan bearings.',
          responsibility: 'Main contractor',
        }),
      'FAILURE_UNROUTED',
    );
  });

  it('refuses a not-applicable with no rationale or no approver', () => {
    const checkId = startCheck();
    const refusal = throwsCode(
      () =>
        prefunctional.recordCheckItem(asQAQC(), checkId, {
          key: 'LUBRICATION',
          result: 'NOT_APPLICABLE',
          note: 'N/A',
        }),
      'NOT_APPLICABLE_UNAPPROVED',
    );
    assert.match(refusal.message ?? '', /disproportionately the ones that would have failed/);
  });

  it('refuses a finding with nothing said about it', () => {
    const checkId = startCheck();
    throwsCode(
      () => prefunctional.recordCheckItem(asQAQC(), checkId, { key: 'LABELLING', result: 'OBSERVATION', note: '  ' }),
      'FINDING_UNDESCRIBED',
    );
  });
});

describe('static completion is a statement, not a percentage', () => {
  beforeEach(freshProject);

  it('accepts it once every item is answered and nothing is failed', () => {
    const checkId = startCheck();
    passAll(checkId);
    const result = prefunctional.acceptStaticCompletion(asQAQC(), checkId, { acceptedBy: 'S. Kaur' });
    assert.equal(result.readinessPercent, 100);
  });

  it('refuses it while an item is unanswered', () => {
    const checkId = startCheck();
    prefunctional.recordCheckItem(asQAQC(), checkId, { key: 'GUARDING', result: 'PASS', note: 'Guards fitted.' });
    const refusal = throwsCode(
      () => prefunctional.acceptStaticCompletion(asQAQC(), checkId, { acceptedBy: 'S. Kaur' }),
      'CHECKLIST_INCOMPLETE',
    );
    assert.match(refusal.message ?? '', /An unanswered item is not a passed one/);
  });

  it('refuses it over a safety-critical failure, naming the four that are never carried', () => {
    const checkId = startCheck();
    passAll(checkId, {
      ISOLATION: {
        key: 'ISOLATION',
        result: 'FAIL',
        note: 'Isolator not lockable and unlabelled.',
        responsibility: 'Electrical subcontractor',
        route: 'RETURN_TO_CONSTRUCTION',
      },
    });
    const refusal = throwsCode(
      () => prefunctional.acceptStaticCompletion(asQAQC(), checkId, { acceptedBy: 'S. Kaur' }),
      'SAFETY_CRITICAL_FAILURE',
    );
    assert.match(refusal.message ?? '', /not one anybody should be energising/);
  });

  it('refuses it over an ordinary open failure too', () => {
    const checkId = startCheck();
    passAll(checkId, {
      LABELLING: {
        key: 'LABELLING',
        result: 'FAIL',
        note: 'Valve tags missing throughout.',
        responsibility: 'Mechanical subcontractor',
        route: 'COMMISSIONING_EXCEPTION',
      },
    });
    const refusal = throwsCode(
      () => prefunctional.acceptStaticCompletion(asQAQC(), checkId, { acceptedBy: 'S. Kaur' }),
      'OPEN_FAILURES',
    );
    assert.match(refusal.message ?? '', /not a percentage/);
  });
});

describe('AC-CM-WF-04-03 functional testing cannot start before release', () => {
  beforeEach(freshProject);

  it('blocks it before static completion and permits it after release', () => {
    const checkId = startCheck();
    assert.match(prefunctional.functionalTestBlockedReason(asQAQC(), 'MEC-VENT')!, /has not been released/);

    passAll(checkId);
    prefunctional.acceptStaticCompletion(asQAQC(), checkId, { acceptedBy: 'S. Kaur' });
    assert.ok(prefunctional.functionalTestBlockedReason(asQAQC(), 'MEC-VENT'));

    prefunctional.releaseForFunctionalTesting(asQAQC(), checkId, { releasedBy: 'S. Kaur' });
    assert.equal(prefunctional.functionalTestBlockedReason(asQAQC(), 'MEC-VENT'), null);
  });

  it('blocks a system nobody has checked at all, once the project runs checks', () => {
    const checkId = startCheck();
    passAll(checkId);
    prefunctional.acceptStaticCompletion(asQAQC(), checkId, { acceptedBy: 'S. Kaur' });
    prefunctional.releaseForFunctionalTesting(asQAQC(), checkId, { releasedBy: 'S. Kaur' });

    const reason = prefunctional.functionalTestBlockedReason(asQAQC(), 'FAC-01')!;
    assert.match(reason, /No pre-functional check has been carried out on FAC-01/);
  });

  it('refuses release before static completion, and from a role that only reads', () => {
    const checkId = startCheck();
    throwsCode(
      () => prefunctional.releaseForFunctionalTesting(asQAQC(), checkId, { releasedBy: 'S. Kaur' }),
      'NOT_STATICALLY_COMPLETE',
    );
    passAll(checkId);
    throwsCode(() => prefunctional.acceptStaticCompletion(asPlanner(), checkId, { acceptedBy: 'A. Planner' }), 'ACCESS_DENIED');
  });
});

describe('rework invalidates the static completion it reaches', () => {
  beforeEach(freshProject);

  it('returns the affected items to unanswered rather than marking them failed', () => {
    const checkId = startCheck();
    passAll(checkId);
    prefunctional.acceptStaticCompletion(asQAQC(), checkId, { acceptedBy: 'S. Kaur' });

    const result = prefunctional.recordRework(asQAQC(), checkId, {
      reason: 'The supply ductwork was re-routed to clear a new structural opening on level 3.',
      affectedChecks: ['INSTALLATION', 'PRESSURE_INTEGRITY', 'AS_INSTALLED'],
      recordedBy: 'J. Byrne',
    });
    assert.equal(result.invalidated, 3);

    const check = prefunctional.preFunctionalPosition(asQAQC()).checks[0]!;
    assert.equal(check.status, 'INVALIDATED');
    // Nobody has looked at them since the rework, and "not looked at" is the
    // true state — not "failed", which nobody established.
    assert.equal(check.unanswered, 3);
    assert.deepEqual(check.failures, []);

    const refusal = throwsCode(
      () => prefunctional.releaseForFunctionalTesting(asQAQC(), checkId, { releasedBy: 'S. Kaur' }),
      'STATIC_COMPLETION_INVALIDATED',
    );
    assert.match(refusal.message ?? '', /re-routed to clear a new structural opening/);
  });

  it('refuses rework that names no affected checks', () => {
    const checkId = startCheck();
    passAll(checkId);
    const refusal = throwsCode(
      () =>
        prefunctional.recordRework(asQAQC(), checkId, {
          reason: 'Some ductwork was moved.',
          affectedChecks: [],
          recordedBy: 'J. Byrne',
        }),
      'AFFECTED_CHECKS_REQUIRED',
    );
    assert.match(refusal.message ?? '', /no longer the system installed/);
  });
});

describe('AC-CM-WF-07-01 criterion to raw result to action to retest to closure', () => {
  let checkId: string;

  beforeEach(async () => {
    await freshProject();
    checkId = startCheck();
    passAll(checkId, {
      ALIGNMENT: {
        key: 'ALIGNMENT',
        result: 'FAIL',
        note: 'Fan and motor shafts out of alignment by 0.6mm against a 0.05mm tolerance.',
        responsibility: 'Mechanical subcontractor',
        route: 'COMMISSIONING_EXCEPTION',
      },
    });
  });

  it('raises the exception from the failed item, carrying its raw result', () => {
    const { exceptionId } = commissioningexception.raiseException(asQAQC(), {
      reference: 'CX-001',
      source: { kind: 'PRE_FUNCTIONAL', checkId, itemKey: 'ALIGNMENT' },
      systemTag: 'MEC-VENT',
      equipmentTag: 'AHU-01',
      location: 'Plant room, level 3',
      severity: 'MAJOR',
      blocker: true,
      probableCause: 'Baseframe not shimmed after the unit was set down.',
      responsibleParty: 'Mechanical subcontractor',
    });

    const position = commissioningexception.exceptionPosition(asQAQC());
    const exception = position.exceptions.find((entry) => entry.exceptionId === exceptionId)!;
    assert.equal(exception.blocker, true);
    assert.deepEqual(position.blocking, ['CX-001']);
  });

  it('refuses an exception raised against an item that passed', () => {
    const refusal = throwsCode(
      () =>
        commissioningexception.raiseException(asQAQC(), {
          reference: 'CX-002',
          source: { kind: 'PRE_FUNCTIONAL', checkId, itemKey: 'GUARDING' },
          systemTag: 'MEC-VENT',
          location: 'Plant room',
          severity: 'MINOR',
          blocker: false,
          probableCause: 'Nothing is wrong with it.',
          responsibleParty: 'Mechanical subcontractor',
        }),
      'ITEM_DID_NOT_FAIL',
    );
    assert.match(refusal.message ?? '', /nobody can trace to anything/);
  });

  it('runs the whole chain and closes only on a verified succeeding result', () => {
    const { exceptionId } = commissioningexception.raiseException(asQAQC(), {
      reference: 'CX-003',
      source: { kind: 'PRE_FUNCTIONAL', checkId, itemKey: 'ALIGNMENT' },
      systemTag: 'MEC-VENT',
      location: 'Plant room, level 3',
      severity: 'MAJOR',
      blocker: true,
      probableCause: 'Baseframe not shimmed after the unit was set down.',
      responsibleParty: 'Mechanical subcontractor',
    });

    // Closure before anything else is refused, and the refusal names why.
    throwsCode(
      () =>
        commissioningexception.closeException(asQAQC(), exceptionId, {
          verifiedBy: 'S. Kaur',
          verification: 'Looked at it and it seems fine now.',
        }),
      'IMPACT_UNASSESSED',
    );

    commissioningexception.completeCorrectiveAction(asQAQC(), exceptionId, {
      containment: 'Unit locked off and removed from the commissioning sequence.',
      corrective: 'Baseframe shimmed and the shafts re-aligned to 0.03mm, recorded on the alignment sheet.',
      evidenceHash: 'a'.repeat(64),
      completedBy: 'Mechanical subcontractor',
    });

    commissioningexception.assessImpact(asQAQC(), exceptionId, {
      invalidatedTests: ['TP-VIB-01'],
      rationale: 'The vibration survey was taken with the unit misaligned, so its result describes a machine that no longer exists.',
      confirmedBy: 'J. Byrne',
    });

    // AC-CM-WF-07-02: visible and actionable, to whatever is about to run it.
    const invalidated = commissioningexception.invalidatedTests(asQAQC());
    assert.deepEqual(invalidated.map((entry) => entry.testRef), ['TP-VIB-01']);

    // Still no succeeding result.
    const refusal = throwsCode(
      () =>
        commissioningexception.closeException(asQAQC(), exceptionId, {
          verifiedBy: 'S. Kaur',
          verification: 'Alignment sheet reviewed and accepted.',
        }),
      'NO_SUCCEEDING_RESULT',
    );
    assert.match(refusal.message ?? '', /A fail is never edited into a pass/);

    const packId = releasedPack('TP-RETEST-01');
    const first = commissioningexception.startRetest(asQAQC(), exceptionId, { packId, startedBy: 'J. Byrne' });
    commissioningexception.recordRetestResult(asQAQC(), exceptionId, {
      retestId: first.retestId,
      result: 'FAIL',
      evidence: 'Alignment sheet AS-114',
    });
    const second = commissioningexception.startRetest(asQAQC(), exceptionId, { packId, startedBy: 'J. Byrne' });
    commissioningexception.recordRetestResult(asQAQC(), exceptionId, {
      retestId: second.retestId,
      result: 'PASS',
      evidence: 'Alignment sheet AS-118',
    });

    const closure = commissioningexception.closeException(asQAQC(), exceptionId, {
      verifiedBy: 'S. Kaur',
      verification: 'Alignment sheet AS-118 witnessed and the vibration survey re-run within limits.',
    });

    // AC-CM-WF-07-03: the failed attempt is still there after closure.
    assert.equal(closure.attempts, 2);
    assert.equal(closure.failuresRetained, 1);

    const position = commissioningexception.exceptionPosition(asQAQC());
    assert.deepEqual(position.blocking, []);
    // And a closed exception no longer invalidates anything.
    assert.deepEqual(position.invalidated, []);
  });

  it('refuses a retest before anything was done about the failure', () => {
    const { exceptionId } = commissioningexception.raiseException(asQAQC(), {
      reference: 'CX-004',
      source: { kind: 'PRE_FUNCTIONAL', checkId, itemKey: 'ALIGNMENT' },
      systemTag: 'MEC-VENT',
      location: 'Plant room',
      severity: 'MAJOR',
      blocker: false,
      probableCause: 'Baseframe not shimmed.',
      responsibleParty: 'Mechanical subcontractor',
    });
    const packId = releasedPack('TP-RETEST-02');
    const refusal = throwsCode(
      () => commissioningexception.startRetest(asQAQC(), exceptionId, { packId, startedBy: 'J. Byrne' }),
      'NO_CORRECTIVE_ACTION',
    );
    assert.match(refusal.message ?? '', /the same test again, and it fails again/);
  });

  it('escalates a subject that keeps failing', () => {
    const packId = releasedPack('TP-RETEST-03');
    const { exceptionId } = commissioningexception.raiseException(asQAQC(), {
      reference: 'CX-005',
      source: { kind: 'PRE_FUNCTIONAL', checkId, itemKey: 'ALIGNMENT' },
      systemTag: 'MEC-VENT',
      location: 'Plant room',
      severity: 'MAJOR',
      blocker: false,
      probableCause: 'Baseframe not shimmed.',
      responsibleParty: 'Mechanical subcontractor',
    });
    commissioningexception.completeCorrectiveAction(asQAQC(), exceptionId, {
      containment: 'Unit locked off and removed from the sequence.',
      corrective: 'Baseframe shimmed and the shafts re-aligned.',
      evidenceHash: 'b'.repeat(64),
      completedBy: 'Mechanical subcontractor',
    });

    for (const label of ['AS-201', 'AS-202']) {
      const retest = commissioningexception.startRetest(asQAQC(), exceptionId, { packId, startedBy: 'J. Byrne' });
      commissioningexception.recordRetestResult(asQAQC(), exceptionId, {
        retestId: retest.retestId,
        result: 'FAIL',
        evidence: label,
      });
    }

    const position = commissioningexception.exceptionPosition(asQAQC());
    assert.ok(position.repeatedFailure.some((entry) => entry.kind === 'SYSTEM' && entry.subject === 'MEC-VENT'));
    assert.ok(position.repeatedFailure.some((entry) => entry.kind === 'PARTY' && entry.subject === 'Mechanical subcontractor'));
    assert.match(position.summary, /failing repeatedly/);
  });

  it('makes a safety-critical conditional acceptance harder than a closure', () => {
    const { exceptionId } = commissioningexception.raiseException(asQAQC(), {
      reference: 'CX-006',
      source: { kind: 'PRE_FUNCTIONAL', checkId, itemKey: 'ALIGNMENT' },
      systemTag: 'MEC-VENT',
      location: 'Plant room',
      severity: 'SAFETY_CRITICAL',
      blocker: true,
      probableCause: 'Baseframe not shimmed.',
      responsibleParty: 'Mechanical subcontractor',
    });

    throwsCode(
      () =>
        commissioningexception.acceptConditionally(asQAQC(), exceptionId, {
          authority: 'S. Kaur',
          operatingRestriction: 'Careful.',
          reviewBy: iso(30),
        }),
      'RESTRICTION_REQUIRED',
    );
    throwsCode(
      () =>
        commissioningexception.acceptConditionally(asQAQC(), exceptionId, {
          authority: 'S. Kaur',
          operatingRestriction: 'The unit may not run above 60% duty and the plant room stays restricted access.',
          reviewBy: 'soon',
        }),
      'REVIEW_DATE_REQUIRED',
    );

    commissioningexception.acceptConditionally(asQAQC(), exceptionId, {
      authority: 'Project director, under the employer’s requirements clause 9.4',
      operatingRestriction: 'The unit may not run above 60% duty and the plant room stays restricted access.',
      reviewBy: iso(-1),
    });

    const position = commissioningexception.exceptionPosition(asQAQC());
    assert.equal(position.conditionallyAccepted[0]!.overdue, true);
    // A conditionally accepted blocker is no longer blocking, but it is visible.
    assert.deepEqual(position.blocking, []);
  });

  it('refuses an impact assessment nobody explained', () => {
    const { exceptionId } = commissioningexception.raiseException(asQAQC(), {
      reference: 'CX-007',
      source: { kind: 'PRE_FUNCTIONAL', checkId, itemKey: 'ALIGNMENT' },
      systemTag: 'MEC-VENT',
      location: 'Plant room',
      severity: 'MINOR',
      blocker: false,
      probableCause: 'Baseframe not shimmed.',
      responsibleParty: 'Mechanical subcontractor',
    });
    const refusal = throwsCode(
      () =>
        commissioningexception.assessImpact(asQAQC(), exceptionId, {
          invalidatedTests: [],
          rationale: 'None',
          confirmedBy: 'J. Byrne',
        }),
      'RATIONALE_REQUIRED',
    );
    assert.match(refusal.message ?? '', /a finding somebody has to stand behind/);
  });
});

/** A released pack, so a retest has a defined revision to run against. */
function releasedPack(reference: string): string {
  qualitycontrol.registerInstrument(asQAQC(), {
    instrumentId: `DIAL-${reference}`,
    description: 'Dial indicator set',
    calibratedAt: iso(-30),
    calibrationExpiresAt: iso(300),
    certificate: `UKAS 2026/${reference}`,
  });

  const { packId } = testpack.createTestPack(asQAQC(), {
    reference,
    systemTag: 'MEC-VENT',
    title: 'Fan and motor alignment retest',
    objective: 'Prove the shafts are aligned within tolerance after shimming.',
    steps: [{ step: 1, instruction: 'Set the dial indicators and record radial and axial runout.' }],
    criteria: [
      {
        reference: 'AC-1',
        criterion: 'Shaft alignment within 0.05mm.',
        source: 'Vendor installation manual VM-118, section 4',
        requiredReading: 'Radial offset',
        unit: 'mm',
        upperLimit: 0.05,
      },
    ],
    instrumentIds: [`DIAL-${reference}`],
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
