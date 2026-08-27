import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as qualitycontrol from '../src/domain/qualitycontrol.ts';
import * as structure from '../src/domain/structure.ts';
import * as systemisation from '../src/domain/systemisation.ts';
import * as testpack from '../src/domain/testpack.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * CM-WF-02 — the procedure, the pack and the release to test.
 *
 * The instrument register and its calibration guard are reused from CN-WF-06,
 * and the boundaries from CM-WF-01. What is tested here is the frozen revision,
 * the three blockers that mean the reading cannot be relied on, and a witness
 * who is a person and a time rather than a checkbox.
 */

let platform: Platform;
let seed: SeedResult;

const asQAQC = () => platform.context(seed.users.qaqc!.auth, seed.projectId, { source: 'WEB' });
const asPlanner = () => platform.context(seed.users.planner!.auth, seed.projectId, { source: 'WEB' });

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

const CRITERIA: testpack.AcceptanceCriterion[] = [
  {
    reference: 'AC-1',
    criterion: 'Supply air volume within ±5% of the design figure at each terminal.',
    source: 'Mechanical schedule MS-04, rev B',
    requiredReading: 'Volume at each terminal',
    unit: 'l/s',
    lowerLimit: 228,
    upperLimit: 252,
  },
  {
    reference: 'AC-2',
    criterion: 'Fire dampers close within ten seconds of the signal.',
    source: 'Specification section 23 33 00, clause 3.4',
    requiredReading: 'Time from signal to fully closed',
    unit: 's',
    upperLimit: 10,
  },
];

const STEPS: testpack.ProcedureStep[] = [
  { step: 1, instruction: 'Set the unit to full fresh air and allow the system to stabilise for ten minutes.' },
  { step: 2, instruction: 'Traverse each terminal and record the volume.' },
  { step: 3, instruction: 'Initiate the fire alarm interface and time each damper to fully closed.' },
];

const READY_ITEMS = testpack.READINESS_ITEM.filter((item) => item.key !== 'INSTRUMENTS').map((item) => ({
  key: item.key,
  ready: true,
  note: 'Verified on site.',
}));

async function freshProject() {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'COMMISSIONING',
    justification: 'Running the commissioning tests',
  });

  systemisation.defineSystem(asQAQC(), {
    tag: 'FAC-01',
    level: 'FACILITY',
    name: 'Riverside Laboratory',
    boundary: 'The whole demised premises within the site boundary, excluding the incoming utility connections.',
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
    instrumentId: 'ANEM-114',
    description: 'Rotating vane anemometer',
    calibratedAt: iso(-90),
    calibrationExpiresAt: iso(180),
    certificate: 'UKAS 2026/114-A',
  });
  qualitycontrol.registerInstrument(asQAQC(), {
    instrumentId: 'ANEM-201',
    description: 'Rotating vane anemometer, spare',
    calibratedAt: iso(-500),
    calibrationExpiresAt: iso(-40),
    certificate: 'UKAS 2025/201-A',
  });
}

function pack(overrides: Partial<Parameters<typeof testpack.createTestPack>[1]> = {}) {
  return testpack.createTestPack(asQAQC(), {
    reference: 'TP-001',
    systemTag: 'MEC-VENT',
    title: 'Ventilation functional performance test',
    objective: 'Prove the supply volumes and the fire damper interlock.',
    steps: STEPS,
    criteria: CRITERIA,
    instrumentIds: ['ANEM-114'],
    ...overrides,
  });
}

function readyPack(): string {
  const { packId } = pack();
  testpack.checkTestReadiness(asQAQC(), packId, { checkedBy: 'J. Byrne', items: READY_ITEMS });
  const { notificationId } = testpack.notifyWitness(asQAQC(), packId, {
    recipient: 'H. Marston',
    organisation: 'Client technical adviser',
    testDate: iso(14),
    noticeDays: 10,
  });
  testpack.recordWitnessResponse(asQAQC(), packId, { notificationId, attending: true, note: 'Will attend from 09:00.' });
  return packId;
}

describe('CM-WF-02 the register', () => {
  beforeEach(freshProject);

  it('registers its five event types, and none is available to an agent', () => {
    for (const code of [
      'TEST_PROCEDURE_CREATED',
      'TEST_READINESS_CHECKED',
      'WITNESS_NOTIFIED',
      'TEST_RELEASED',
      'TEST_BLOCKED',
    ] as const) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, 'TestPack');
      // "Identify missing criteria or contradictory tolerances; cannot release test."
      assert.equal(definition.aiAllowed, false);
    }
    // Release is a freeze, not an approval: what happens is that the revision
    // stops moving.
    assert.equal(lookupEventType('TEST_RELEASED')!.action, 'FREEZE');
  });
});

describe('AC-CM-WF-02-02 criteria that can be argued from', () => {
  beforeEach(freshProject);

  it('accepts a criterion citing a controlled source, a reading and a unit', () => {
    const result = pack();
    assert.equal(result.revision, 1);
  });

  it('refuses a criterion with no controlled source behind it', () => {
    const refusal = throwsCode(
      () => pack({ criteria: [{ ...CRITERIA[0]!, source: '  ' }] }),
      'CRITERION_UNSOURCED',
    );
    assert.match(refusal.message ?? '', /satisfaction of the engineer/);
  });

  it('refuses a criterion nobody can measure', () => {
    throwsCode(() => pack({ criteria: [{ ...CRITERIA[0]!, requiredReading: '  ' }] }), 'CRITERION_UNMEASURED');
    throwsCode(() => pack({ criteria: [{ ...CRITERIA[0]!, unit: '  ' }] }), 'CRITERION_UNMEASURED');
  });

  it('refuses tolerances no reading can satisfy', () => {
    throwsCode(
      () => pack({ criteria: [{ ...CRITERIA[0]!, lowerLimit: 300, upperLimit: 250 }] }),
      'CRITERION_CONTRADICTORY',
    );
  });

  it('refuses a pack with no criteria, no steps, or against no boundary', () => {
    throwsCode(() => pack({ criteria: [] }), 'NO_CRITERIA');
    throwsCode(() => pack({ steps: [] }), 'NO_STEPS');
    throwsCode(() => pack({ systemTag: 'MEC-CHW' }), 'SYSTEM_NOT_FOUND');
  });
});

describe('the three blockers: the reading cannot be relied on', () => {
  beforeEach(freshProject);

  it('reads instrument calibration from the register rather than accepting a tick', () => {
    const { packId } = pack({ instrumentIds: ['ANEM-201'] });
    const readiness = testpack.checkTestReadiness(asQAQC(), packId, {
      checkedBy: 'J. Byrne',
      // Every declared item says ready. The instrument item is not declared at
      // all, and cannot be: the register is the only thing that knows.
      items: READY_ITEMS,
    });

    assert.equal(readiness.ready, false);
    assert.deepEqual(readiness.blockers, ['INSTRUMENTS']);
    assert.match(readiness.items.find((item) => item.key === 'INSTRUMENTS')!.note, /out of calibration/);
  });

  it('blocks release on an open critical defect, a missing isolation or no energisation', () => {
    for (const key of ['DEFECTS', 'PERMITS', 'ENERGISATION'] as const) {
      const { packId } = pack({ reference: `TP-${key}` });
      testpack.checkTestReadiness(asQAQC(), packId, {
        checkedBy: 'J. Byrne',
        items: READY_ITEMS.map((item) =>
          item.key === key ? { ...item, ready: false, note: `${key} outstanding on the plant room.` } : item,
        ),
      });
      const refusal = throwsCode(() => testpack.releaseForTest(asQAQC(), packId, { releasedBy: 'S. Kaur' }), 'RELEASE_BLOCKED');
      assert.match(refusal.message ?? '', new RegExp(key));
    }
  });

  it('records the block rather than only refusing it', () => {
    const { packId } = pack();
    testpack.checkTestReadiness(asQAQC(), packId, {
      checkedBy: 'J. Byrne',
      items: READY_ITEMS.map((item) =>
        item.key === 'PERMITS' ? { ...item, ready: false, note: 'No safe isolation on the LV supply.' } : item,
      ),
    });
    throwsCode(() => testpack.releaseForTest(asQAQC(), packId, { releasedBy: 'S. Kaur' }), 'RELEASE_BLOCKED');

    const position = testpack.testPackPosition(asQAQC());
    const blocked = position.blocked.find((entry) => entry.reference === 'TP-001')!;
    assert.deepEqual(blocked.blockers, ['PERMITS']);
    assert.match(blocked.detail, /No safe isolation/);
    assert.match(position.summary, /1 blocked/);
  });

  it('lets a non-blocking item stay outstanding without stopping the test', () => {
    const { packId } = pack();
    const readiness = testpack.checkTestReadiness(asQAQC(), packId, {
      checkedBy: 'J. Byrne',
      items: READY_ITEMS.map((item) =>
        item.key === 'VENDOR' ? { ...item, ready: false, note: 'Vendor attending by video rather than in person.' } : item,
      ),
    });
    assert.equal(readiness.ready, true);
    assert.deepEqual(readiness.outstanding, ['VENDOR']);
  });

  it('refuses a checklist with an item nobody answered, or a blocker nobody described', () => {
    const { packId } = pack();
    const refusal = throwsCode(
      () =>
        testpack.checkTestReadiness(asQAQC(), packId, {
          checkedBy: 'J. Byrne',
          items: READY_ITEMS.filter((item) => item.key !== 'ACCESS'),
        }),
      'READINESS_INCOMPLETE',
    );
    assert.match(refusal.message ?? '', /An unanswered item is not a passed one/);

    throwsCode(
      () =>
        testpack.checkTestReadiness(asQAQC(), packId, {
          checkedBy: 'J. Byrne',
          items: READY_ITEMS.map((item) => (item.key === 'ACCESS' ? { ...item, ready: false, note: ' ' } : item)),
        }),
      'BLOCKER_UNDESCRIBED',
    );
  });
});

describe('AC-CM-WF-02-03 a witness who is a person and a time', () => {
  beforeEach(freshProject);

  it('records the recipient, the organisation and when it went', () => {
    const { packId } = pack();
    const result = testpack.notifyWitness(asQAQC(), packId, {
      recipient: 'H. Marston',
      organisation: 'Client technical adviser',
      testDate: iso(14),
      noticeDays: 10,
    });
    assert.equal(result.shortNotice, false);

    const position = testpack.testPackPosition(asQAQC());
    assert.equal(position.packs[0]!.witnessesNotified, 1);
  });

  it('reports short notice rather than refusing it', () => {
    // Short notice happens, and the contractual consequence is somebody else's
    // to draw. What the platform owes is that it is visible.
    const { packId } = pack();
    const result = testpack.notifyWitness(asQAQC(), packId, {
      recipient: 'H. Marston',
      organisation: 'Client technical adviser',
      testDate: iso(2),
      noticeDays: 10,
    });
    assert.equal(result.shortNotice, true);
  });

  it('refuses a notification addressed to nobody', () => {
    const { packId } = pack();
    const refusal = throwsCode(
      () =>
        testpack.notifyWitness(asQAQC(), packId, {
          recipient: '  ',
          organisation: 'Client',
          testDate: iso(14),
          noticeDays: 10,
        }),
      'RECIPIENT_REQUIRED',
    );
    assert.match(refusal.message ?? '', /what is said when nobody was/);
  });

  it('treats a waiver as an authorised record, never as silence', () => {
    const { packId } = pack();
    testpack.checkTestReadiness(asQAQC(), packId, { checkedBy: 'J. Byrne', items: READY_ITEMS });
    const { notificationId } = testpack.notifyWitness(asQAQC(), packId, {
      recipient: 'H. Marston',
      organisation: 'Client technical adviser',
      testDate: iso(14),
      noticeDays: 10,
    });

    const refusal = throwsCode(() => testpack.releaseForTest(asQAQC(), packId, { releasedBy: 'S. Kaur' }), 'WITNESS_UNANSWERED');
    assert.match(refusal.message ?? '', /not the absence of a reply/);

    throwsCode(
      () => testpack.recordWitnessResponse(asQAQC(), packId, { notificationId, waivedBy: 'S. Kaur', contractRule: '  ' }),
      'WAIVER_UNAUTHORISED',
    );

    testpack.recordWitnessResponse(asQAQC(), packId, {
      notificationId,
      waivedBy: 'S. Kaur',
      contractRule: 'Contract clause 4.7.3 — witness requirement waived where notice has been given and not answered.',
    });
    assert.ok(testpack.releaseForTest(asQAQC(), packId, { releasedBy: 'S. Kaur' }).releasedRevisionHash);
  });

  it('refuses release before anybody was notified at all', () => {
    const { packId } = pack();
    testpack.checkTestReadiness(asQAQC(), packId, { checkedBy: 'J. Byrne', items: READY_ITEMS });
    const refusal = throwsCode(
      () => testpack.releaseForTest(asQAQC(), packId, { releasedBy: 'S. Kaur' }),
      'WITNESS_NOT_NOTIFIED',
    );
    assert.match(refusal.message ?? '', /executed in front of nobody/);
  });
});

describe('AC-CM-WF-02-01 no test without a released revision', () => {
  beforeEach(freshProject);

  it('freezes the revision at release, and lets execution proceed', () => {
    const packId = readyPack();
    assert.equal(testpack.executionBlockedReason(asQAQC(), packId)?.includes('not released'), true);

    const release = testpack.releaseForTest(asQAQC(), packId, { releasedBy: 'S. Kaur' });
    assert.match(release.releasedRevisionHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(testpack.executionBlockedReason(asQAQC(), packId), null);
  });

  it('refuses execution against a pack that was never released', () => {
    const { packId } = pack();
    const reason = testpack.executionBlockedReason(asQAQC(), packId)!;
    assert.match(reason, /proves nothing, because nobody has said the procedure is the one to work to/);
  });

  it('cancels the release when the procedure changes afterwards', () => {
    // The failure the frozen hash exists for: the pack reads as released, the
    // result reads as a pass, and the steps are not the ones anybody checked.
    const packId = readyPack();
    testpack.releaseForTest(asQAQC(), packId, { releasedBy: 'S. Kaur' });

    const revision = testpack.reviseTestPack(asQAQC(), packId, {
      reason: 'The damper timing step now measures from the interface relay rather than the panel.',
      steps: [...STEPS, { step: 4, instruction: 'Repeat the damper timing from the interface relay.' }],
    });
    assert.equal(revision.revision, 2);
    assert.equal(revision.releaseCancelled, true);

    const reason = testpack.executionBlockedReason(asQAQC(), packId)!;
    assert.match(reason, /not released/);

    // And the readiness check has to be run again against the new revision.
    throwsCode(() => testpack.releaseForTest(asQAQC(), packId, { releasedBy: 'S. Kaur' }), 'NOT_CHECKED');
  });

  it('refuses a revision with no reason on it', () => {
    const { packId } = pack();
    throwsCode(() => testpack.reviseTestPack(asQAQC(), packId, { reason: 'Fixed' }), 'REVISION_UNEXPLAINED');
  });

  it('refuses a second release and an unsigned one', () => {
    const packId = readyPack();
    throwsCode(() => testpack.releaseForTest(asQAQC(), packId, { releasedBy: '  ' }), 'RELEASE_UNSIGNED');
    testpack.releaseForTest(asQAQC(), packId, { releasedBy: 'S. Kaur' });
    throwsCode(() => testpack.releaseForTest(asQAQC(), packId, { releasedBy: 'S. Kaur' }), 'ALREADY_RELEASED');
  });

  it('refuses release from a role that does not run commissioning', () => {
    const packId = readyPack();
    throwsCode(() => testpack.releaseForTest(asPlanner(), packId, { releasedBy: 'A. Planner' }), 'ACCESS_DENIED');
  });
});

describe('what the plan requires that nobody raised', () => {
  beforeEach(freshProject);

  it('names a required pack against which nothing has been created', () => {
    systemisation.approveHierarchy(asQAQC(), { approvedBy: 'S. Kaur' });
    const { planId } = systemisation.draftCommissioningPlan(asQAQC(), {
      title: 'Ventilation commissioning plan',
      tests: [
        {
          reference: 'TP-002',
          systemTag: 'MEC-VENT',
          stage: 'INTEGRATED',
          objective: 'Prove the ventilation responds correctly to the fire alarm cause and effect.',
          owner: 'Commissioning contractor',
          witness: 'Client technical adviser',
          acceptanceCriteria: 'Every zone responds within the times in the cause and effect matrix.',
          criteriaSource: 'Cause and effect matrix CE-02, rev A',
          prerequisite: 'Fire alarm system accepted and the ventilation functional test passed.',
          noticePeriodDays: 10,
        },
      ],
      milestones: [
        { milestone: 'Plant room construction complete', type: 'CONSTRUCTION', date: iso(10) },
        { milestone: 'Handover', type: 'HANDOVER', date: iso(70), dependsOn: 'Plant room construction complete' },
      ],
    });
    systemisation.approveCommissioningPlan(asQAQC(), planId, { approvedBy: 'S. Kaur' });

    const position = testpack.testPackPosition(asQAQC());
    assert.deepEqual(position.packsNotRaised, ['TP-002']);
    assert.match(position.summary, /the plan requires that nobody has raised/);
  });
});
