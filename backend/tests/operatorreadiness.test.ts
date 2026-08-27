import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as commissioningclose from '../src/domain/commissioningclose.ts';
import * as operatorreadiness from '../src/domain/operatorreadiness.ts';
import * as structure from '../src/domain/structure.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * H-WF-06 — operator training, competence and operational readiness.
 *
 * CM-WF-08's training sessions are reused rather than duplicated: they already
 * tie a session to the revision it taught and invalidate it on supersession.
 * What is tested here is what they do not answer — whether anybody is competent,
 * and whether the roles the building needs are covered.
 */

let platform: Platform;
let seed: SeedResult;

const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
/** Holds QUALITY_COMMISSIONING C — records the CM-WF-08 training session. */
const asQAQC = () => platform.context(seed.users.qaqc!.auth, seed.projectId, { source: 'WEB' });
const asFM = () => platform.context(seed.users.fm!.auth, seed.projectId, { source: 'WEB' });

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

const ROLES = [
  {
    role: 'Estates duty engineer',
    headcountRequired: 2,
    competences: ['Start and stop the ventilation from the BMS', 'Isolate the AHU safely'],
    assessmentRequired: true,
    critical: true,
  },
  {
    role: 'Cleaning supervisor',
    headcountRequired: 1,
    competences: ['Know which plant rooms are restricted access'],
    assessmentRequired: false,
    critical: false,
  },
];

async function freshProject() {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'HANDOVER',
    justification: 'Bringing the operator up to competence',
  });
}

function needs(overrides: Record<string, unknown> = {}) {
  return operatorreadiness.defineTrainingNeeds(asFM(), {
    reference: 'TNA-001',
    operatingModel: 'In-house estates team, with the ventilation maintained under a framework contract.',
    roles: ROLES,
    definedBy: 'K. Mensah',
    ...overrides,
  } as Parameters<typeof operatorreadiness.defineTrainingNeeds>[1]);
}

/** A CM-WF-08 session, which is what an assessment hangs off. */
function session(reference: string, role: string, attendees: string[]) {
  return commissioningclose.recordTraining(asQAQC(), {
    reference,
    systemTag: 'MEC-VENT',
    role,
    deliveredAgainst: [{ reference: 'CD-VENT-01', revision: 'C' }],
    deliveredBy: 'D. Okonjo',
    deliveredAt: iso(-3),
    attendees: attendees.map((name) => ({ name, role, organisation: 'Riverside Estates', competent: false })),
  });
}

function assess(person: string, role: string, sessionReference: string, result: 'COMPETENT' | 'NOT_YET_COMPETENT') {
  return operatorreadiness.assessCompetence(asFM(), {
    person,
    employer: 'Riverside Estates',
    role,
    sessionReference,
    method: 'PRACTICAL_DEMONSTRATION',
    result,
    assessedBy: 'D. Okonjo',
    evidence: 'Demonstrated start, stop and isolation on AHU-01 unaided, witnessed at the panel.',
  });
}

describe('H-WF-06 the register', () => {
  beforeEach(freshProject);

  it('registers its five event types, and none is available to an agent', () => {
    for (const [code, entity] of [
      ['TRAINING_NEEDS_DEFINED', 'TrainingNeeds'],
      ['COMPETENCE_ASSESSED', 'CompetenceAssessment'],
      ['TRAINING_GAP_PLANNED', 'TrainingGapPlan'],
      ['RETRAINING_REQUIRED', 'RetrainingObligation'],
      ['OPERATOR_READY', 'OperatorReadiness'],
    ] as const) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, entity);
      // "Cannot certify competence; authorised assessor records result."
      assert.equal(definition.aiAllowed, false);
    }
  });

  it('restricts the competence record as far as the sensitivity ladder allows', () => {
    // The ladder has no personal-data tier. SAFETY_L2 is the nearest real
    // restriction and is not claimed to be a purpose-built one.
    assert.equal(classifyEntity('CompetenceAssessment')?.sensitivity, 'SAFETY_L2');
  });

  it('reuses CM-WF-08 training rather than keeping a second set', () => {
    assert.equal(lookupEventType('TRAINING_DELIVERED')!.entity, 'TrainingSession');
  });
});

describe('attendance is not competence', () => {
  beforeEach(freshProject);

  it('leaves an attendee awaiting assessment where the role requires one', () => {
    needs();
    session('TR-001', 'Estates duty engineer', ['K. Osei', 'L. Rowe']);

    const coverage = operatorreadiness.roleCoverage(asFM());
    const engineers = coverage.find((role) => role.role === 'Estates duty engineer')!;
    assert.deepEqual(engineers.competent, []);
    assert.deepEqual(engineers.awaitingAssessment.sort(), ['K. Osei', 'L. Rowe']);
    assert.equal(engineers.covered, false);
  });

  it('counts attendance as competence only where no assessment is required', () => {
    needs();
    session('TR-002', 'Cleaning supervisor', ['P. Ahmed']);
    const cleaning = operatorreadiness.roleCoverage(asFM()).find((role) => role.role === 'Cleaning supervisor')!;
    assert.deepEqual(cleaning.competent, ['P. Ahmed']);
    assert.equal(cleaning.covered, true);
  });

  it('records a not-yet-competent result as the finding it is', () => {
    needs();
    session('TR-003', 'Estates duty engineer', ['K. Osei']);
    assess('K. Osei', 'Estates duty engineer', 'TR-003', 'NOT_YET_COMPETENT');

    const engineers = operatorreadiness.roleCoverage(asFM()).find((role) => role.role === 'Estates duty engineer')!;
    assert.deepEqual(engineers.notYetCompetent, ['K. Osei']);
    assert.deepEqual(engineers.awaitingAssessment, []);
    assert.match(
      operatorreadiness.trainingHandoverBlockedReason(asFM())!,
      /assessed as not yet competent in a required role/,
    );
  });

  it('lets a later competent assessment supersede an earlier failure', () => {
    needs();
    session('TR-004', 'Estates duty engineer', ['K. Osei']);
    assess('K. Osei', 'Estates duty engineer', 'TR-004', 'NOT_YET_COMPETENT');
    assess('K. Osei', 'Estates duty engineer', 'TR-004', 'COMPETENT');

    const engineers = operatorreadiness.roleCoverage(asFM()).find((role) => role.role === 'Estates duty engineer')!;
    assert.deepEqual(engineers.competent, ['K. Osei']);
    assert.deepEqual(engineers.notYetCompetent, []);
  });

  it('refuses a self-assessment, one with no evidence and one with no assessor', () => {
    needs();
    session('TR-005', 'Estates duty engineer', ['K. Osei']);
    const refusal = throwsCode(
      () =>
        operatorreadiness.assessCompetence(asFM(), {
          person: 'K. Osei',
          employer: 'Riverside Estates',
          role: 'Estates duty engineer',
          sessionReference: 'TR-005',
          method: 'OBSERVATION',
          result: 'COMPETENT',
          assessedBy: 'K. Osei',
          evidence: 'Watched myself do it and it went fine.',
        }),
      'SELF_ASSESSED',
    );
    assert.match(refusal.message ?? '', /it is a declaration/);

    throwsCode(
      () =>
        operatorreadiness.assessCompetence(asFM(), {
          person: 'K. Osei',
          employer: 'Riverside Estates',
          role: 'Estates duty engineer',
          sessionReference: 'TR-005',
          method: 'OBSERVATION',
          result: 'COMPETENT',
          assessedBy: 'D. Okonjo',
          evidence: 'Fine',
        }),
      'EVIDENCE_REQUIRED',
    );
  });

  it('refuses an assessment against a session delivered on superseded information', () => {
    needs();
    session('TR-006', 'Estates duty engineer', ['K. Osei']);
    commissioningclose.supersedeTrainingInformation(asQAQC(), {
      reference: 'CD-VENT-01',
      supersededRevision: 'C',
      newRevision: 'D',
      recordedBy: 'K. Mensah',
    });
    const refusal = throwsCode(
      () => assess('K. Osei', 'Estates duty engineer', 'TR-006', 'COMPETENT'),
      'SESSION_INVALIDATED',
    );
    assert.match(refusal.message ?? '', /a building that no longer exists/);
  });

  it('drops an invalidated session out of the coverage entirely', () => {
    needs();
    session('TR-007', 'Cleaning supervisor', ['P. Ahmed']);
    assert.equal(operatorreadiness.roleCoverage(asFM()).find((role) => role.role === 'Cleaning supervisor')!.covered, true);

    commissioningclose.supersedeTrainingInformation(asQAQC(), {
      reference: 'CD-VENT-01',
      supersededRevision: 'C',
      newRevision: 'D',
      recordedBy: 'K. Mensah',
    });
    assert.equal(operatorreadiness.roleCoverage(asFM()).find((role) => role.role === 'Cleaning supervisor')!.covered, false);
  });
});

describe('AC-H-WF-06-01 every role covered, or a controlled gap plan', () => {
  beforeEach(freshProject);

  it('accepts readiness once each critical role has its competent people', () => {
    needs();
    session('TR-010', 'Estates duty engineer', ['K. Osei', 'L. Rowe']);
    assess('K. Osei', 'Estates duty engineer', 'TR-010', 'COMPETENT');
    assess('L. Rowe', 'Estates duty engineer', 'TR-010', 'COMPETENT');

    const result = operatorreadiness.acceptOperatorReadiness(asFM(), {
      acceptedBy: 'K. Mensah',
      forOperator: 'Riverside Estates',
      supportPlan: 'Vendor engineer on call for the first eight weeks, with weekly review of the BMS alarms.',
    });
    assert.equal(result.rolesCovered, 1);
    assert.equal(operatorreadiness.trainingHandoverBlockedReason(asFM()), null);
  });

  it('refuses readiness while a critical role is short, naming the numbers', () => {
    needs();
    session('TR-011', 'Estates duty engineer', ['K. Osei', 'L. Rowe']);
    assess('K. Osei', 'Estates duty engineer', 'TR-011', 'COMPETENT');

    const refusal = throwsCode(
      () =>
        operatorreadiness.acceptOperatorReadiness(asFM(), {
          acceptedBy: 'K. Mensah',
          forOperator: 'Riverside Estates',
          supportPlan: 'Vendor engineer on call for the first eight weeks.',
        }),
      'ROLE_NOT_COVERED',
    );
    assert.match(refusal.message ?? '', /needs 2 and has 1/);
    assert.match(refusal.message ?? '', /1 who attended and have not been assessed/);
  });

  it('accepts a controlled gap plan in place of a competent person', () => {
    needs();
    operatorreadiness.recordGapPlan(asFM(), {
      role: 'Estates duty engineer',
      gap: 'Only one duty engineer has been recruited and the second post is out to advert.',
      interimArrangement: 'The framework maintenance contractor provides second cover on a two-hour response until the post is filled.',
      owner: 'Riverside Estates',
      by: iso(60),
    });

    const engineers = operatorreadiness.roleCoverage(asFM()).find((role) => role.role === 'Estates duty engineer')!;
    assert.equal(engineers.covered, true);
    assert.match(engineers.gapPlan!.interimArrangement, /two-hour response/);
    assert.equal(operatorreadiness.trainingHandoverBlockedReason(asFM()), null);
  });

  it('refuses a gap plan with no interim arrangement — that is a gap, not a plan', () => {
    needs();
    const refusal = throwsCode(
      () =>
        operatorreadiness.recordGapPlan(asFM(), {
          role: 'Estates duty engineer',
          gap: 'The second duty engineer post is unfilled.',
          interimArrangement: 'Recruiting.',
          owner: 'Riverside Estates',
          by: iso(60),
        }),
      'INTERIM_REQUIRED',
    );
    assert.match(refusal.message ?? '', /somebody still has to operate the building on Monday/);
  });

  it('refuses a readiness acceptance that pretends no support is needed', () => {
    needs();
    session('TR-012', 'Estates duty engineer', ['K. Osei', 'L. Rowe']);
    assess('K. Osei', 'Estates duty engineer', 'TR-012', 'COMPETENT');
    assess('L. Rowe', 'Estates duty engineer', 'TR-012', 'COMPETENT');

    const refusal = throwsCode(
      () =>
        operatorreadiness.acceptOperatorReadiness(asFM(), {
          acceptedBy: 'K. Mensah',
          forOperator: 'Riverside Estates',
          supportPlan: 'None.',
        }),
      'SUPPORT_PLAN_REQUIRED',
    );
    assert.match(refusal.message ?? '', /the operator withdraws in week two/);
  });

  it('refuses a needs analysis with no operating model or a role with no competences', () => {
    const refusal = throwsCode(() => needs({ operatingModel: 'In-house.' }), 'OPERATING_MODEL_REQUIRED');
    assert.match(refusal.message ?? '', /depends entirely on who is going to be operating it/);
    const role = throwsCode(
      () => needs({ roles: [{ ...ROLES[0]!, competences: [] }] }),
      'ROLE_INCOMPLETE',
    );
    assert.match(role.message ?? '', /is not a competence anybody can be assessed against/);
  });

  it('refuses readiness where no needs analysis exists at all', () => {
    throwsCode(
      () =>
        operatorreadiness.acceptOperatorReadiness(asFM(), {
          acceptedBy: 'K. Mensah',
          forOperator: 'Riverside Estates',
          supportPlan: 'Vendor engineer on call for the first eight weeks.',
        }),
      'NO_NEEDS_ANALYSIS',
    );
  });
});

describe('AC-H-WF-06-03 retraining and the handover blocker', () => {
  beforeEach(freshProject);

  it('blocks the handover while retraining is outstanding', () => {
    needs();
    session('TR-020', 'Estates duty engineer', ['K. Osei', 'L. Rowe']);
    assess('K. Osei', 'Estates duty engineer', 'TR-020', 'COMPETENT');
    assess('L. Rowe', 'Estates duty engineer', 'TR-020', 'COMPETENT');
    assert.equal(operatorreadiness.trainingHandoverBlockedReason(asFM()), null);

    operatorreadiness.requireRetraining(asFM(), {
      role: 'Estates duty engineer',
      reason: 'The control strategy was reissued at revision D after the fire alarm interface was rewired.',
      owner: 'Riverside Estates',
      by: iso(30),
    });
    assert.match(operatorreadiness.trainingHandoverBlockedReason(asFM())!, /awaiting retraining after a material change/);

    const position = operatorreadiness.operatorReadinessPosition(asFM());
    assert.equal(position.retraining[0]!.owner, 'Riverside Estates');
    assert.match(position.summary, /awaiting retraining/);
  });

  it('refuses retraining with no reason or nobody owning it', () => {
    needs();
    throwsCode(
      () =>
        operatorreadiness.requireRetraining(asFM(), {
          role: 'Estates duty engineer',
          reason: 'Changed',
          owner: 'Riverside Estates',
          by: iso(30),
        }),
      'REASON_REQUIRED',
    );
    throwsCode(
      () =>
        operatorreadiness.requireRetraining(asFM(), {
          role: 'Estates duty engineer',
          reason: 'The control strategy was reissued at revision D.',
          owner: '  ',
          by: iso(30),
        }),
      'RETRAINING_UNOWNED',
    );
  });

  it('binds nothing on a project with no needs analysis', () => {
    assert.equal(operatorreadiness.trainingHandoverBlockedReason(asFM()), null);
    assert.match(operatorreadiness.operatorReadinessPosition(asFM()).summary, /No training needs analysis/);
  });

  it('refuses a needs analysis or a gap plan from a role that only reads handover', () => {
    const asRegulator = () => platform.context(seed.users.regulator!.auth, seed.projectId, { source: 'WEB' });
    throwsCode(
      () =>
        operatorreadiness.defineTrainingNeeds(asRegulator(), {
          reference: 'TNA-X',
          operatingModel: 'In-house estates team with a framework maintenance contract.',
          roles: ROLES,
          definedBy: 'A regulator',
        }),
      'ACCESS_DENIED',
    );
    needs();
    throwsCode(
      () =>
        operatorreadiness.recordGapPlan(asPM(), {
          role: 'Estates duty engineer',
          gap: 'The second duty engineer post is unfilled.',
          interimArrangement: 'The framework contractor provides second cover on a two-hour response.',
          owner: 'Riverside Estates',
          by: iso(60),
        }),
      'ACCESS_DENIED',
    );
  });
});
