import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as completion from '../src/domain/completion.ts';
import * as structure from '../src/domain/structure.ts';
import * as handover from '../src/engines/handover.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * CN-WF-12 — reporting, recovery, physical completion and turnover.
 *
 * The delay forecast and its costed measures, the CVR, the commissioning test,
 * system acceptance and the stage gate were already built. What is tested here
 * is the four things that were not: a cut-off that reconciles, a report that
 * names what it could not see, a recovery a person chose, and a turnover with a
 * boundary on it.
 */

let platform: Platform;
let seed: SeedResult;

/** Holds PROJECT_SETUP U — closes the reporting period. */
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
/**
 * Holds PROJECT_SETUP A.
 *
 * "Issue the completion certificate only by authorised party" is the
 * specification's step 5, and the matrix already answers who: the roles that
 * approve the project itself, not the ones that run it day to day.
 */
const asOwner = () => platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' });
/** Holds QUALITY_COMMISSIONING A — releases a system to commissioning. */
const asQAQC = () => platform.context(seed.users.qaqc!.auth, seed.projectId, { source: 'WEB' });
/** Holds PROGRAMME_BASELINES A — selects the recovery. */
const asPlanner = () => platform.context(seed.users.planner!.auth, seed.projectId, { source: 'WEB' });

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString();

const EVIDENCE = completion.TURNOVER_CHECK.map((check) => ({
  check: check.key,
  reference: `EV-${check.key}`,
}));

function release(systemId: string, overrides: Partial<Parameters<typeof completion.releaseSystemForTurnover>[1]> = {}) {
  return completion.releaseSystemForTurnover(asQAQC(), {
    systemId,
    systemName: `Air handling unit ${systemId}`,
    boundary:
      'From the AHU intake louvre to the first fire damper on each supply branch, including the local control panel and ' +
      'excluding the LV supply upstream of the panel isolator.',
    isolations: [
      { point: 'LV supply at panel isolator DB-3/7', heldBy: 'Electrical subcontractor' },
      { point: 'Chilled water flow and return at the plant room valves', heldBy: 'Mechanical subcontractor' },
    ],
    retainedObligations: [
      'Construction retains the temporary access platform until the ductwork insulation is signed off.',
      'Construction retains responsibility for the builders work openings until they are made good.',
    ],
    residualDefects: [],
    evidenceRefs: EVIDENCE,
    releasedBy: 'M. Reilly',
    ...overrides,
  });
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'CONSTRUCTION',
    justification: 'Running the reporting and turnover cycle',
  });
});

describe('CN-WF-12 the register', () => {
  it('registers its five event types, and none is available to an agent', () => {
    for (const [code, entity] of [
      ['REPORT_SNAPSHOT_CREATED', 'PeriodSnapshot'],
      ['RECOVERY_PLAN_APPROVED', 'RecoveryPlan'],
      ['SYSTEM_READY_FOR_TURNOVER', 'SystemTurnover'],
      ['TURNOVER_EXCEPTION_ACCEPTED', 'TurnoverException'],
      ['CONSTRUCTION_COMPLETION_ACCEPTED', 'ConstructionCompletion'],
    ] as const) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, entity);
      // "Cannot declare completion or select recovery."
      assert.equal(definition.aiAllowed, false);
    }
  });

  it('makes the report and the completion certificate carry their evidence', () => {
    assert.equal(lookupEventType('REPORT_SNAPSHOT_CREATED')!.requiresEvidence, true);
    assert.equal(lookupEventType('CONSTRUCTION_COMPLETION_ACCEPTED')!.requiresEvidence, true);
    assert.equal(classifyEntity('SystemTurnover')?.area, 'QUALITY_COMMISSIONING');
    assert.equal(classifyEntity('ConstructionCompletion')?.area, 'PROJECT_SETUP');
  });
});

describe('AC-CN-WF-12-01 numbers that reconcile to the cut-off', () => {
  it('takes a snapshot that a second reading of the same cut-off reproduces exactly', () => {
    const cutOff = iso(0);
    const first = completion.createSnapshot(asPM(), { cutOff, audience: 'CLIENT' });
    const reconciliation = completion.reconcileSnapshot(asPM(), first.snapshotId);

    assert.equal(reconciliation.reconciles, true);
    assert.equal(reconciliation.recomputedHash, first.contentHash);
  });

  it('still reconciles after the project moves on, because the cut-off is an instant', () => {
    // The whole point. A report built from screens read on four different days
    // reconciles to nothing; one built from a cut-off reconciles for ever.
    const snapshotId = completion.createSnapshot(asPM(), { cutOff: iso(0), audience: 'BOARD' }).snapshotId;

    completion.approveRecoveryPlan(asPlanner(), {
      delayDaysForecast: 12,
      measures: [{ measure: 'Second steel-fixing gang on the slab', recoveryDays: 8, costMinor: 1_800_000, owner: 'D. Feeney' }],
      approvedBy: 'R. Nolan',
      rationale: 'Cheapest measure per day recovered, and the only one that does not need a night-shift permit.',
    });

    assert.equal(completion.reconcileSnapshot(asPM(), snapshotId).reconciles, true);
  });

  it('reports movement against the previous cut-off rather than a fresh total', () => {
    const later = completion.createSnapshot(asPM(), { cutOff: iso(0), audience: 'FUNDER' });
    const position = completion.completionPosition(asPM());
    const snapshot = position.latest!;

    assert.equal(snapshot.reference, later.reference);
    assert.ok(snapshot.changesSince, 'the second snapshot carries no comparison to the first');
    assert.ok(snapshot.changesSince!.deltas.length > 0);
  });

  it('refuses a cut-off in the future, and one earlier than the last', () => {
    throwsCode(
      () => completion.createSnapshot(asPM(), { cutOff: iso(7), audience: 'CLIENT' }),
      'CUT_OFF_IN_FUTURE',
    );
    throwsCode(
      () => completion.createSnapshot(asPM(), { cutOff: iso(-30), audience: 'CLIENT' }),
      'CUT_OFF_NOT_AFTER_LAST',
    );
  });

  it('refuses a report with no audience on it', () => {
    throwsCode(() => completion.createSnapshot(asPM(), { cutOff: iso(0), audience: '  ' }), 'AUDIENCE_REQUIRED');
  });
});

describe('the exception control: a report does not hide what it could not see', () => {
  it('names a source with no records rather than rendering it as a zero', () => {
    const position = completion.completionPosition(asPM());
    const snapshot = position.latest!;

    // Every source is either reported or named. Nothing is silently a zero.
    for (const source of snapshot.sources) {
      if (!source.reported) assert.ok(snapshot.notReported.includes(source.key), `${source.key} is a silent zero`);
    }
    assert.ok(snapshot.notReported.length > 0, 'the demo project reports against every source, so nothing is proven here');
  });

  it('separates a source whose absence is a gap from one whose absence is a nil', () => {
    const snapshot = completion.completionPosition(asPM()).latest!;
    // Every critical gap is also not reported; not every unreported source is a
    // gap. A project with no deliveries this period is not a project with no
    // progress records.
    for (const key of snapshot.criticalGaps) assert.ok(snapshot.notReported.includes(key));
    assert.ok(snapshot.criticalGaps.length <= snapshot.notReported.length);
  });

  it('says how many days behind a stale source is, not merely that it is stale', () => {
    const snapshot = completion.completionPosition(asPM()).latest!;
    for (const entry of snapshot.stale) {
      assert.ok(entry.days > 14, `${entry.key} is listed as stale at ${entry.days} days`);
    }
  });
});

describe('a recovery a person chose', () => {
  it('records what was selected, what it recovers and what it still leaves', () => {
    const result = completion.approveRecoveryPlan(asPlanner(), {
      delayDaysForecast: 20,
      measures: [
        { measure: 'Second steel-fixing gang', recoveryDays: 8, costMinor: 1_800_000, owner: 'D. Feeney' },
        { measure: 'Saturday working on the slab pours', recoveryDays: 5, costMinor: 900_000, owner: 'K. Osei' },
      ],
      approvedBy: 'R. Nolan',
      rationale: 'The two cheapest per day recovered that do not need a permit the site does not hold.',
    });

    assert.equal(result.recoveryDays, 13);
    assert.equal(result.costMinor, 2_700_000);
    // Reported rather than refused: a plan that recovers part of a delay is a
    // real plan, and one presented as recovering all of it is the problem.
    assert.equal(result.shortfallDays, 7);
  });

  it('refuses a measure nobody is carrying out, and a plan with nothing in it', () => {
    throwsCode(
      () =>
        completion.approveRecoveryPlan(asPlanner(), {
          delayDaysForecast: 5,
          measures: [],
          approvedBy: 'R. Nolan',
          rationale: 'There is nothing sensible available at this price.',
        }),
      'NO_MEASURES',
    );
    throwsCode(
      () =>
        completion.approveRecoveryPlan(asPlanner(), {
          delayDaysForecast: 5,
          measures: [{ measure: 'Accelerate the finishes', recoveryDays: 3, costMinor: 100_000, owner: '  ' }],
          approvedBy: 'R. Nolan',
          rationale: 'The finishes trade has capacity and the sequence allows it.',
        }),
      'MEASURE_UNOWNED',
    );
  });

  it('refuses a selection nobody signed', () => {
    const refusal = throwsCode(
      () =>
        completion.approveRecoveryPlan(asPlanner(), {
          delayDaysForecast: 5,
          measures: [{ measure: 'Night shift on the risers', recoveryDays: 4, costMinor: 500_000, owner: 'K. Osei' }],
          approvedBy: '  ',
          rationale: 'The risers are on the critical path and night working is permitted internally.',
        }),
      'APPROVAL_UNSIGNED',
    );
    assert.match(refusal.message ?? '', /never chooses between them/);
  });
});

describe('AC-CN-WF-12-02 a turnover with a boundary on it', () => {
  it('releases a system with its boundary, isolations and retained obligations', () => {
    const result = release('AHU-01');
    assert.equal(result.blocking, 0);

    const position = completion.completionPosition(asPM());
    const turnover = position.turnovers.find((entry) => entry.systemName.includes('AHU-01'))!;
    assert.equal(turnover.retainedObligations, 2);
  });

  it('refuses a release with no boundary, no isolations or nothing retained', () => {
    throwsCode(() => release('AHU-B1', { boundary: 'The AHU.' }), 'BOUNDARY_REQUIRED');
    throwsCode(() => release('AHU-B2', { isolations: [] }), 'ISOLATIONS_REQUIRED');
    throwsCode(() => release('AHU-B3', { retainedObligations: [] }), 'RETAINED_OBLIGATIONS_REQUIRED');
  });

  it('refuses a checklist item with no evidence behind it', () => {
    const refusal = throwsCode(
      () => release('AHU-B4', { evidenceRefs: EVIDENCE.filter((entry) => entry.check !== 'AS_BUILT') }),
      'TURNOVER_INCOMPLETE',
    );
    assert.match(refusal.message ?? '', /AS_BUILT/);
    // Rule-driven: the refusal quotes the rule and what proves it, not a count.
    assert.match(refusal.message ?? '', /As-built information reflects what was installed/);

    throwsCode(
      () =>
        release('AHU-B5', {
          evidenceRefs: EVIDENCE.map((entry) => (entry.check === 'ISOLATIONS' ? { ...entry, reference: ' ' } : entry)),
        }),
      'EVIDENCE_UNREFERENCED',
    );
  });

  it('refuses a residual defect with no owner, condition or date', () => {
    throwsCode(
      () =>
        release('AHU-B6', {
          residualDefects: [
            {
              reference: 'D-101',
              description: 'Two access panel fixings missing',
              classification: 'NON_BLOCKING',
              owner: '  ',
              completionCondition: 'Fixings installed and panel refitted',
              by: iso(14).slice(0, 10),
            },
          ],
        }),
      'DEFECT_UNCONDITIONED',
    );
  });

  it('refuses to carry a blocking defect through the release that starts commissioning', () => {
    throwsCode(
      () =>
        release('AHU-B7', {
          residualDefects: [
            {
              reference: 'D-102',
              description: 'Fire damper actuator not connected',
              classification: 'BLOCKING',
              owner: 'Mechanical subcontractor',
              completionCondition: 'Actuator connected and proven to close on signal',
              by: iso(7).slice(0, 10),
            },
          ],
        }),
      'BLOCKING_DEFECTS',
    );
  });

  it('carries a restricting defect through, and reports it', () => {
    release('AHU-02', {
      residualDefects: [
        {
          reference: 'D-103',
          description: 'Insulation outstanding on the return duct in the riser',
          classification: 'RESTRICTING',
          owner: 'Mechanical subcontractor',
          completionCondition: 'Insulation complete and inspected before the system runs continuously',
          by: iso(21).slice(0, 10),
        },
      ],
    });

    const turnover = completion.completionPosition(asPM()).turnovers.find((entry) => entry.systemName.includes('AHU-02'))!;
    assert.equal(turnover.restrictingDefects, 1);
  });

  it('refuses a second release of the same system', () => {
    throwsCode(() => release('AHU-01'), 'ALREADY_RELEASED');
  });

  it('refuses a release from a role that only records the tests', () => {
    throwsCode(() => completion.releaseSystemForTurnover(asPlanner(), {
      systemId: 'AHU-B8',
      systemName: 'Air handling unit AHU-B8',
      boundary: 'From the AHU intake louvre to the first fire damper on each supply branch, including the panel.',
      isolations: [{ point: 'LV supply at panel isolator', heldBy: 'Electrical subcontractor' }],
      retainedObligations: ['Temporary access platform retained.'],
      residualDefects: [],
      evidenceRefs: EVIDENCE,
      releasedBy: 'A. Planner',
    }), 'ACCESS_DENIED');
  });
});

describe('AC-CN-WF-12-03 commissioning does not start without a boundary', () => {
  const TEST = {
    testType: 'Air volume balance',
    testStandard: 'BSRIA BG 49/2015',
    result: 'PASS' as const,
    readings: [{ parameter: 'Supply volume', expected: '2.4 m3/s', actual: '2.38 m3/s', withinTolerance: true }],
    witnessedBy: 'M. Reilly',
    certificateHash: 'a'.repeat(64),
  };

  it('runs a test on a released system', () => {
    const result = handover.recordCommissioningTest(asQAQC(), {
      systemId: 'AHU-01',
      systemName: 'Air handling unit AHU-01',
      ...TEST,
    });
    assert.equal(result.outstandingObservations, 0);
  });

  it('refuses a test on a system nobody released', () => {
    const refusal = throwsCode(
      () =>
        handover.recordCommissioningTest(asQAQC(), {
          systemId: 'AHU-99',
          systemName: 'Air handling unit AHU-99',
          ...TEST,
        }),
      'SYSTEM_NOT_RELEASED',
    );
    assert.match(refusal.message ?? '', /each believe the other holds the isolation/);
  });

  it('allows it under a signed, explained and dated exception', () => {
    completion.recordTurnoverException(asQAQC(), {
      systemId: 'AHU-99',
      systemName: 'Air handling unit AHU-99',
      whatIsMissing: 'As-built ductwork drawings for the third-floor branch',
      why: 'The branch is isolated at the riser and the test is confined to the plant room, which is fully as-built.',
      acceptedBy: 'M. Reilly',
      expiresOn: iso(21).slice(0, 10),
    });

    assert.ok(
      handover.recordCommissioningTest(asQAQC(), {
        systemId: 'AHU-99',
        systemName: 'Air handling unit AHU-99',
        ...TEST,
      }).testId,
    );
  });

  it('refuses an exception that explains nothing, or never expires', () => {
    throwsCode(
      () =>
        completion.recordTurnoverException(asQAQC(), {
          systemId: 'AHU-98',
          systemName: 'Air handling unit AHU-98',
          whatIsMissing: 'Paperwork',
          why: 'Agreed.',
          acceptedBy: 'M. Reilly',
          expiresOn: iso(21).slice(0, 10),
        }),
      'EXCEPTION_UNEXPLAINED',
    );
    const refusal = throwsCode(
      () =>
        completion.recordTurnoverException(asQAQC(), {
          systemId: 'AHU-98',
          systemName: 'Air handling unit AHU-98',
          whatIsMissing: 'As-built drawings for the branch',
          why: 'The branch is isolated at the riser and the test is confined to the plant room.',
          acceptedBy: 'M. Reilly',
          expiresOn: 'when we get to it',
        }),
      'EXCEPTION_UNBOUNDED',
    );
    assert.match(refusal.message ?? '', /becomes the permanent state/);
  });
});

describe('the stage 9 exit', () => {
  it('accepts construction completion across the systems released', () => {
    const result = completion.acceptConstructionCompletion(asOwner(), {
      acceptedBy: 'The Employer, by its project director',
      statement:
        'The works are physically complete by system, records are reconciled and the systems listed are released to ' +
        'commissioning with the retained obligations stated against each.',
      certificateHash: 'b'.repeat(64),
    });

    assert.ok(result.systems >= 2);
    assert.ok(result.retainedObligations >= 2);

    const position = completion.completionPosition(asPM());
    assert.equal(position.completionAccepted?.acceptedBy, 'The Employer, by its project director');
    assert.match(position.summary, /construction completion accepted/);
  });

  it('refuses a second acceptance', () => {
    throwsCode(
      () =>
        completion.acceptConstructionCompletion(asOwner(), {
          acceptedBy: 'The Employer',
          statement: 'The works are physically complete and the records are reconciled as previously stated.',
          certificateHash: 'c'.repeat(64),
        }),
      'ALREADY_ACCEPTED',
    );
  });
});

describe('the stage 9 exit refusals, on a project of their own', () => {
  let clean: Platform;
  let cleanSeed: SeedResult;
  const asCleanOwner = () => clean.context(cleanSeed.users.owner!.auth, cleanSeed.projectId, { source: 'WEB' });
  const asCleanQAQC = () => clean.context(cleanSeed.users.qaqc!.auth, cleanSeed.projectId, { source: 'WEB' });

  before(async () => {
    clean = new Platform();
    cleanSeed = await seedDemoProject(clean);
    structure.transitionPhase(clean.context(cleanSeed.users.owner!.auth, cleanSeed.projectId, { source: 'WEB' }), {
      to: 'CONSTRUCTION',
      justification: 'Testing the completion refusals',
    });
  });

  it('refuses completion when no system has been turned over', () => {
    const refusal = throwsCode(
      () =>
        completion.acceptConstructionCompletion(asCleanOwner(), {
          acceptedBy: 'The Employer',
          statement: 'The works are complete and everything is in order, on the word of the person typing this.',
          certificateHash: 'd'.repeat(64),
        }),
      'NOTHING_TURNED_OVER',
    );
    assert.match(refusal.message ?? '', /neither has been recorded/);
  });

  it('refuses completion over an exception that has passed its date', () => {
    completion.releaseSystemForTurnover(asCleanQAQC(), {
      systemId: 'LV-01',
      systemName: 'LV distribution board LV-01',
      boundary: 'From the incoming switch panel to the final circuit isolators on the second floor, excluding the busbar riser.',
      isolations: [{ point: 'Incoming switch panel', heldBy: 'Electrical subcontractor' }],
      retainedObligations: ['Construction retains the temporary supply until the permanent metering is commissioned.'],
      residualDefects: [],
      evidenceRefs: EVIDENCE,
      releasedBy: 'M. Reilly',
    });

    completion.recordTurnoverException(asCleanQAQC(), {
      systemId: 'LV-02',
      systemName: 'LV distribution board LV-02',
      whatIsMissing: 'Earth loop impedance test records for the second-floor circuits',
      why: 'The testing engineer was on site and the results are known; the certificates had not been issued.',
      acceptedBy: 'M. Reilly',
      expiresOn: iso(-3).slice(0, 10),
    });

    const refusal = throwsCode(
      () =>
        completion.acceptConstructionCompletion(asCleanOwner(), {
          acceptedBy: 'The Employer',
          statement: 'The works are physically complete by system and the records are reconciled as stated.',
          certificateHash: 'e'.repeat(64),
        }),
      'EXCEPTIONS_EXPIRED',
    );
    assert.match(refusal.message ?? '', /without saying so/);
  });

  it('refuses a certificate nobody signed or evidenced', () => {
    throwsCode(
      () =>
        completion.acceptConstructionCompletion(asCleanOwner(), {
          acceptedBy: '  ',
          statement: 'The works are physically complete by system and the records are reconciled as stated.',
          certificateHash: 'f'.repeat(64),
        }),
      'COMPLETION_UNSIGNED',
    );
    throwsCode(
      () =>
        completion.acceptConstructionCompletion(asCleanOwner(), {
          acceptedBy: 'The Employer',
          statement: 'The works are physically complete by system and the records are reconciled as stated.',
          certificateHash: '  ',
        }),
      'CERTIFICATE_REQUIRED',
    );
  });
});
