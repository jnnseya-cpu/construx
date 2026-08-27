import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as qualitycontrol from '../src/domain/qualitycontrol.ts';
import * as stagegate from '../src/domain/stagegate.ts';
import * as structure from '../src/domain/structure.ts';
import * as planning from '../src/engines/planning.ts';
import * as quality from '../src/engines/quality.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * CN-WF-06 — quality planning, inspection, testing, NCR and defect control.
 *
 * The ITP, the inspection, the hold-point register and the NCR were already
 * built. What is tested here is the five things that were missing — starting
 * with the one the existing code's own comment predicted: `assertHoldPointsClear`
 * was written with a note saying "a hold point nobody enforces is a comment in a
 * document", and nothing in the platform called it.
 */

let platform: Platform;
let seed: SeedResult;

/** Holds QUALITY_COMMISSIONING C, U and A — requests, releases, closes. */
const asQAQC = () => platform.context(seed.users.qaqc!.auth, seed.projectId, { source: 'WEB' });
/** Holds C and U but not A — inspects, cannot release. */
const asSiteManager = () => platform.context(seed.users.siteManager!.auth, seed.projectId, { source: 'WEB' });
/** Holds DESIGN_INFORMATION A — the concession authority. */
const asDesigner = () => platform.context(seed.users.designer!.auth, seed.projectId, { source: 'WEB' });
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const hash = (seedText: string) => `sha256:${seedText.padEnd(64, '0').slice(0, 64)}`;

let sequence = 0;

/** A plan with a hold point at S1 and a review point at S2, in that order. */
function planWithHoldPoint(): string {
  sequence += 1;
  const { workPackageId } = planning.createWorkPackage(asPM(), {
    wbsCode: `QC-${String(sequence).padStart(3, '0')}`,
    title: `Clarifier wall pour ${sequence}`,
    indicativeDurationDays: 15,
  });
  return quality.createInspectionPlan(asQAQC(), {
    workPackageId,
    title: `ITP for pour ${sequence}`,
    discipline: 'CIVIL',
    stages: [
      {
        reference: 'S1',
        description: 'Formwork and reinforcement before pour',
        acceptanceCriteria: 'Cover 40mm nominal, ±10mm, to BS EN 13670 clause 6.',
        type: 'HOLD',
        responsible: 'QAQC',
      },
      {
        reference: 'S2',
        description: 'Post-pour dimensional survey',
        acceptanceCriteria: 'Wall face within 10mm of the design line over any 3m.',
        type: 'REVIEW',
        responsible: 'QAQC',
      },
    ],
  }).planId;
}

function passStage(planId: string, stageReference: string): void {
  quality.recordInspection(asQAQC(), {
    planId,
    stageReference,
    outcome: 'PASS',
    inspectedBy: 'Site engineer',
    comments: 'Within tolerance.',
    evidenceHash: hash(`insp-${planId}-${stageReference}`),
  });
}

function openNCR(): string {
  sequence += 1;
  return quality.raiseNCR(asQAQC(), {
    description: `Cover to the outer face measured at 28mm against 40mm nominal, pour ${sequence}.`,
    severity: 'MAJOR',
    proposedAction: 'Assess durability, or cut out and recast.',
    evidenceHash: hash(`ncr-${sequence}`),
  }).ncrId;
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'CONSTRUCTION',
    justification: 'Inspecting the work',
  });
});

describe('CN-WF-06 the register', () => {
  it('registers its six event types', () => {
    for (const [code, entity] of [
      ['INSPECTION_REQUESTED', 'InspectionRequest'],
      ['HOLD_POINT_RELEASED', 'HoldPointRelease'],
      ['INSTRUMENT_CALIBRATED', 'Instrument'],
      ['NCR_ACTION_RECORDED', 'NCR'],
      ['CONCESSION_APPROVED', 'NCR'],
      ['NCR_REOPENED', 'NCR'],
    ] as const) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, entity);
      // "Qualified inspector controls result and disposition."
      assert.equal(definition.aiAllowed, false);
    }
    assert.equal(lookupEventType('HOLD_POINT_RELEASED')?.action, 'APPROVE');
  });

  it('classifies the new entities with quality', () => {
    for (const entity of ['InspectionRequest', 'HoldPointRelease', 'Instrument']) {
      assert.equal(classifyEntity(entity)?.area, 'QUALITY_COMMISSIONING');
    }
  });
});

describe('AC-CN-WF-06-02 a hold point that is actually enforced', () => {
  it('refuses to inspect past a hold point that has not been released', () => {
    const planId = planWithHoldPoint();
    passStage(planId, 'S1');
    const refusal = throwsCode(
      () =>
        quality.recordInspection(asQAQC(), {
          planId,
          stageReference: 'S2',
          outcome: 'PASS',
          inspectedBy: 'QA/QC',
          comments: 'Straight on.',
          evidenceHash: hash('early'),
        }),
      'HOLD_POINT_OPEN',
    );
    // A passed inspection is a finding; the release is the authority.
    assert.match(refusal.message ?? '', /witness point with a stronger word on it/);
  });

  it('refuses a release before the stage has passed', () => {
    const planId = planWithHoldPoint();
    throwsCode(
      () =>
        qualitycontrol.releaseHoldPoint(asQAQC(), {
          planId,
          stageReference: 'S1',
          basis: 'It will be fine.',
          evidenceHash: hash('early-release'),
        }),
      'STAGE_NOT_PASSED',
    );
  });

  it('refuses a release from the role that inspects but cannot approve', () => {
    const planId = planWithHoldPoint();
    passStage(planId, 'S1');
    throwsCode(
      () =>
        qualitycontrol.releaseHoldPoint(asSiteManager(), {
          planId,
          stageReference: 'S1',
          basis: 'Passed, so proceeding.',
          evidenceHash: hash('sm-release'),
        }),
      'ACCESS_DENIED',
    );
  });

  it('releases on the authority, and then lets the successor be inspected', () => {
    const planId = planWithHoldPoint();
    passStage(planId, 'S1');
    qualitycontrol.releaseHoldPoint(asQAQC(), {
      planId,
      stageReference: 'S1',
      basis: 'Cover checked at nine positions, all within tolerance. Pour may proceed.',
      evidenceHash: hash('release-ok'),
    });
    assert.doesNotThrow(() => passStage(planId, 'S2'));
  });

  it('refuses to release the same hold point twice, or a point that holds nothing', () => {
    const planId = planWithHoldPoint();
    passStage(planId, 'S1');
    const args = { planId, stageReference: 'S1', basis: 'Checked.', evidenceHash: hash('dup') };
    qualitycontrol.releaseHoldPoint(asQAQC(), args);
    throwsCode(() => qualitycontrol.releaseHoldPoint(asQAQC(), args), 'ALREADY_RELEASED');

    passStage(planId, 'S2');
    throwsCode(
      () =>
        qualitycontrol.releaseHoldPoint(asQAQC(), {
          planId,
          stageReference: 'S2',
          basis: 'Also fine.',
          evidenceHash: hash('review-release'),
        }),
      'NOT_A_HOLD_POINT',
    );
  });

  it('surfaces a hold point that passed and nobody released', () => {
    const planId = planWithHoldPoint();
    passStage(planId, 'S1');
    const position = qualitycontrol.qualityControlPosition(asQAQC());
    assert.ok(position.awaitingRelease.some((entry) => entry.stageReference === 'S1'));
    assert.match(position.summary, /passed and not released/);
  });
});

describe('AC-CN-WF-06-01 an inspection against an exact revision', () => {
  it('records the revision, the criteria and who was told', () => {
    const planId = planWithHoldPoint();
    const result = qualitycontrol.requestInspection(asQAQC(), {
      planId,
      stageReference: 'S1',
      informationRevision: 'C-3301 rev P07 and specification E10 rev 3',
      notifyParties: ['Northern Water Authority', 'Caldervale Engineering'],
      requiredBy: day(3),
      prerequisitesConfirmed: 'Reinforcement fixed and tied; formwork struck clean and released.',
    });
    assert.equal(result.type, 'HOLD');

    const position = qualitycontrol.qualityControlPosition(asQAQC());
    const request = position.requests.find((entry) => entry.reference === result.reference)!;
    assert.match(request.informationRevision, /P07/);
  });

  it('refuses an inspection against "the drawings"', () => {
    const planId = planWithHoldPoint();
    throwsCode(
      () =>
        qualitycontrol.requestInspection(asQAQC(), {
          planId,
          stageReference: 'S1',
          informationRevision: '   ',
          notifyParties: ['Client'],
          requiredBy: day(3),
          prerequisitesConfirmed: 'Ready.',
        }),
      'INFORMATION_REVISION_REQUIRED',
    );
  });

  it('refuses a request with nobody told or nothing confirmed', () => {
    const planId = planWithHoldPoint();
    const good = {
      planId,
      stageReference: 'S1',
      informationRevision: 'C-3301 P07',
      notifyParties: ['Client'],
      requiredBy: day(3),
      prerequisitesConfirmed: 'Ready.',
    };
    throwsCode(
      () => qualitycontrol.requestInspection(asQAQC(), { ...good, notifyParties: [] }),
      'NOTIFICATION_REQUIRED',
    );
    throwsCode(
      () => qualitycontrol.requestInspection(asQAQC(), { ...good, prerequisitesConfirmed: '  ' }),
      'PREREQUISITES_UNCONFIRMED',
    );
  });

  it('refuses a request past an unreleased hold point', () => {
    const planId = planWithHoldPoint();
    passStage(planId, 'S1');
    throwsCode(
      () =>
        qualitycontrol.requestInspection(asQAQC(), {
          planId,
          stageReference: 'S2',
          informationRevision: 'C-3301 P07',
          notifyParties: ['Client'],
          requiredBy: day(3),
          prerequisitesConfirmed: 'Poured.',
        }),
      'HOLD_POINT_OPEN',
    );
  });
});

describe('CN-WF-06 a reading from an instrument out of calibration', () => {
  it('reports an expired certificate as unknown rather than wrong', () => {
    qualitycontrol.registerInstrument(asQAQC(), {
      instrumentId: 'TW-114',
      description: 'Torque wrench, 40-200Nm',
      calibratedAt: day(-400),
      calibrationExpiresAt: day(-35),
      certificate: 'UKAS cert 91182',
    });
    const reason = qualitycontrol.calibrationBlockedReason(asQAQC(), 'TW-114');
    assert.ok(reason);
    assert.match(reason, /not wrong so much as unknown/);
  });

  it('accepts an instrument in date', () => {
    qualitycontrol.registerInstrument(asQAQC(), {
      instrumentId: 'TW-115',
      description: 'Torque wrench, 40-200Nm',
      calibratedAt: day(-30),
      calibrationExpiresAt: day(335),
      certificate: 'UKAS cert 91183',
    });
    assert.equal(qualitycontrol.calibrationBlockedReason(asQAQC(), 'TW-115'), null);
  });

  it('treats an instrument nobody registered as unanswerable, not as fine', () => {
    const reason = qualitycontrol.calibrationBlockedReason(asQAQC(), 'NOT-ON-THE-REGISTER');
    assert.ok(reason);
    assert.match(reason, /not on the instrument register/);
  });

  it('refuses an instrument with no certificate or impossible dates', () => {
    throwsCode(
      () =>
        qualitycontrol.registerInstrument(asQAQC(), {
          instrumentId: 'TW-116',
          description: 'Torque wrench',
          calibratedAt: day(-30),
          calibrationExpiresAt: day(335),
          certificate: '  ',
        }),
      'CALIBRATION_CERTIFICATE_REQUIRED',
    );
    throwsCode(
      () =>
        qualitycontrol.registerInstrument(asQAQC(), {
          instrumentId: 'TW-117',
          description: 'Torque wrench',
          calibratedAt: day(-30),
          calibrationExpiresAt: day(-60),
          certificate: 'c',
        }),
      'CALIBRATION_DATES_REQUIRED',
    );
  });

  it('surfaces what is out of calibration', () => {
    const position = qualitycontrol.qualityControlPosition(asQAQC());
    assert.ok(position.calibration.some((entry) => entry.instrumentId === 'TW-114' && entry.expired));
    assert.match(position.summary, /out of calibration/);
  });
});

describe('AC-CN-WF-06-03 a closure with something behind it', () => {
  it('refuses use-as-is without a concession from design authority', () => {
    const ncrId = openNCR();
    const refusal = throwsCode(
      () =>
        quality.closeNCR(asQAQC(), ncrId, {
          disposition: 'USE_AS_IS',
          justification: 'It will be fine.',
          evidenceHash: hash('close-1'),
        }),
      'CLOSURE_BLOCKED',
    );
    assert.match(refusal.message ?? '', /design authority/);
  });

  it('refuses a concession from the quality role that closes the record', () => {
    // Deliberately two different people: accepting non-compliant work is a
    // decision to change what the design asked for.
    const ncrId = openNCR();
    throwsCode(
      () =>
        qualitycontrol.approveConcession(asQAQC(), ncrId, {
          rationale: 'Fine.',
          limitations: 'None.',
          evidenceHash: hash('con-denied'),
        }),
      'ACCESS_DENIED',
    );
  });

  it('refuses a concession with no engineering or no limits on it', () => {
    const ncrId = openNCR();
    throwsCode(
      () =>
        qualitycontrol.approveConcession(asDesigner(), ncrId, {
          rationale: '  ',
          limitations: 'Pour CW-03 only.',
          evidenceHash: hash('con-1'),
        }),
      'CONCESSION_UNEXPLAINED',
    );
    throwsCode(
      () =>
        qualitycontrol.approveConcession(asDesigner(), ncrId, {
          rationale: 'Durability reassessed; 62-year life against 60 required.',
          limitations: '   ',
          evidenceHash: hash('con-2'),
        }),
      'CONCESSION_UNLIMITED',
    );
  });

  it('closes on a concession, and shows what it does not cover', () => {
    const ncrId = openNCR();
    qualitycontrol.approveConcession(asDesigner(), ncrId, {
      rationale: 'Durability reassessed (CE-DUR-114): 28mm cover with the 50% GGBS mix gives 62 years against 60 required.',
      limitations: 'Pour CW-03 outer face only; the area moves to a five-yearly inspection cycle in the O&M manual.',
      evidenceHash: hash('con-ok'),
    });
    const closed = quality.closeNCR(asQAQC(), ncrId, {
      disposition: 'USE_AS_IS',
      justification: 'Closed on the design concession CE-DUR-114.',
      evidenceHash: hash('close-ok'),
    });
    assert.equal(closed.status, 'CLOSED');

    const position = qualitycontrol.qualityControlPosition(asQAQC());
    const concession = position.concessions.find((entry) => entry.rationale.includes('CE-DUR-114'))!;
    assert.match(concession.limitations, /five-yearly/);
  });

  it('refuses a second concession on one record', () => {
    const ncrId = openNCR();
    const args = { rationale: 'Reassessed.', limitations: 'This pour only.', evidenceHash: hash('con-3') };
    qualitycontrol.approveConcession(asDesigner(), ncrId, args);
    throwsCode(() => qualitycontrol.approveConcession(asDesigner(), ncrId, args), 'ALREADY_CONCEDED');
  });

  it('refuses a corrective action missing any of its four parts', () => {
    const ncrId = openNCR();
    const full = {
      containment: 'Pour stopped and the adjacent bay held.',
      rootCause: 'Spacer type substituted on site without checking the cover it gives.',
      corrective: 'Cut out and recast the affected 6m².',
      preventive: 'Spacer type added to the pre-pour checklist and to the ITP hold-point criteria.',
      owner: 'S. Duarte',
      by: day(14),
      evidenceHash: hash('ca-1'),
    };
    for (const field of ['containment', 'rootCause', 'corrective', 'preventive', 'owner'] as const) {
      throwsCode(
        () => qualitycontrol.recordCorrectiveAction(asQAQC(), ncrId, { ...full, [field]: '  ' }),
        'CORRECTIVE_ACTION_INCOMPLETE',
      );
    }
    assert.ok(qualitycontrol.recordCorrectiveAction(asQAQC(), ncrId, full).recorded);
  });
});

describe('CN-WF-06 a defect closed on evidence that did not hold', () => {
  it('reopens it, keeping the original closure in full', () => {
    const ncrId = openNCR();
    quality.closeNCR(asQAQC(), ncrId, {
      disposition: 'REWORK',
      justification: 'Cut out and recast; verified at the post-pour survey.',
      evidenceHash: hash('close-reopen'),
    });

    const result = qualitycontrol.reopenNCR(asQAQC(), ncrId, {
      reason: 'The survey sheet closed on was for the adjacent bay; this pour was never re-surveyed.',
      withdrawnEvidence: 'Survey sheet SV-221',
    });
    assert.equal(result.reopened, true);

    const record = platform.ledger.get({ refType: 'NCR', refId: ncrId })!;
    assert.equal(record.state.status, 'OPEN');
    // Nothing about the original closure is erased.
    const history = record.state.closureHistory as Array<Record<string, unknown>>;
    assert.equal(history.length, 1);
    assert.equal(history[0]!.disposition, 'REWORK');
    assert.match(String(history[0]!.justification), /post-pour survey/);

    const position = qualitycontrol.qualityControlPosition(asQAQC());
    assert.ok(position.reopened.some((entry) => entry.withdrawnEvidence === 'Survey sheet SV-221'));
    assert.match(position.summary, /reopened/);
  });

  it('refuses to reopen something that is not closed', () => {
    const ncrId = openNCR();
    throwsCode(
      () => qualitycontrol.reopenNCR(asQAQC(), ncrId, { reason: 'Changed my mind.', withdrawnEvidence: 'x' }),
      'NCR_NOT_CLOSED',
    );
  });

  it('refuses a reopening that names no withdrawn evidence', () => {
    const ncrId = openNCR();
    quality.closeNCR(asQAQC(), ncrId, {
      disposition: 'REWORK',
      justification: 'Recast and verified.',
      evidenceHash: hash('close-2'),
    });
    throwsCode(
      () => qualitycontrol.reopenNCR(asQAQC(), ncrId, { reason: 'I disagree.', withdrawnEvidence: '  ' }),
      'REOPENING_UNEXPLAINED',
    );
  });
});

describe('9.4 the construction stage gate', () => {
  it('answers the same seven clauses as 6.4, 7.4 and 8.4', () => {
    const report = stagegate.evaluateConstructionGate(asPM());
    assert.deepEqual(
      report.clauses.map((clause) => clause.clause),
      [...stagegate.GATE_CLAUSE],
    );
  });

  it('never reports a clause it cannot assess as passed', () => {
    const report = stagegate.evaluateConstructionGate(asPM());
    for (const clause of report.clauses) {
      if (clause.state !== 'NOT_ASSESSABLE') continue;
      assert.ok(clause.blocking.length > 0, `${clause.clause} is unassessable but names nothing it cannot see`);
    }
    assert.equal(report.passed, report.failed.length === 0 && report.unassessable.length === 0);
  });

  it('names the hold points that passed and were never released', () => {
    const report = stagegate.evaluateConstructionGate(asPM());
    const blockers = report.clauses.find((clause) => clause.clause === 'BLOCKERS_CLOSED')!;
    assert.ok(blockers.blocking.some((entry) => entry.includes('never released')));
  });

  it('names the commissioning turnover it cannot see, rather than passing it', () => {
    const report = stagegate.evaluateConstructionGate(asPM());
    const downstream = report.clauses.find((clause) => clause.clause === 'DOWNSTREAM_CREATED')!;
    if (downstream.state === 'NOT_ASSESSABLE') {
      assert.match(downstream.detail, /commissioning turnover pack/);
      assert.match(downstream.detail, /CM-WF-01/);
    }
  });

  it('is the gate a project standing in construction is measured against', () => {
    // `gateFor` picks by phase, and this project was moved to CONSTRUCTION.
    assert.equal(
      stagegate.gateFor(asPM()).contentHash,
      stagegate.evaluateConstructionGate(asPM()).contentHash,
    );
  });
});
