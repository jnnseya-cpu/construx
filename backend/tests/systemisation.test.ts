import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as structure from '../src/domain/structure.ts';
import * as systemisation from '../src/domain/systemisation.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * CM-WF-01 — systemisation and the commissioning plan.
 *
 * The commissioning stage's first workflow, and the one thing the platform had
 * no representation of: `engines/handover.ts` records a test against a free-text
 * `systemId`. What is tested here is that an asset ends up in exactly one
 * boundary, that a plan cannot be approved with a test nobody has to witness,
 * that the programme reaches construction and handover, and that temporary
 * operation can never be mistaken for commissioning.
 */

let platform: Platform;
let seed: SeedResult;

/** Holds QUALITY_COMMISSIONING C, U, A — the commissioning manager. */
const asQAQC = () => platform.context(seed.users.qaqc!.auth, seed.projectId, { source: 'WEB' });
/** Holds R only on quality. */
const asPlanner = () => platform.context(seed.users.planner!.auth, seed.projectId, { source: 'WEB' });

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

/** A fresh project, so each suite draws its own boundaries. */
async function freshProject() {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'COMMISSIONING',
    justification: 'Systemising for commissioning',
  });
}

function facility() {
  systemisation.defineSystem(asQAQC(), {
    tag: 'FAC-01',
    level: 'FACILITY',
    name: 'Riverside Laboratory',
    boundary: 'The whole demised premises within the site boundary, excluding the incoming utility connections.',
  });
}

function ventilationSystem(assetTags: string[] = ['AHU-01', 'FAN-01']) {
  systemisation.defineSystem(asQAQC(), {
    tag: 'MEC-VENT',
    level: 'SYSTEM',
    parentTag: 'FAC-01',
    name: 'Ventilation',
    boundary: 'All supply and extract air handling from intake louvre to terminal device, excluding local fan coils.',
  });
  systemisation.defineSystem(asQAQC(), {
    tag: 'MEC-VENT-AHU',
    level: 'SUBSYSTEM',
    parentTag: 'MEC-VENT',
    name: 'Air handling units',
    boundary: 'The AHUs, their local control panels and the ductwork to the first fire damper on each branch.',
    assetTags,
    energisationSequence: 2,
  });
}

const TESTS: systemisation.PlannedTest[] = [
  {
    reference: 'T-001',
    systemTag: 'MEC-VENT-AHU',
    stage: 'PRE_FUNCTIONAL',
    objective: 'Confirm the units are installed, clean, aligned and safe to energise.',
    owner: 'Mechanical subcontractor',
    witness: 'Commissioning engineer',
    acceptanceCriteria: 'All checklist items pass with no safety-critical observation open.',
    criteriaSource: 'Specification section 25 10 00, rev C',
    prerequisite: 'Static completion of the ductwork and the electrical supply energised to the panel.',
    noticePeriodDays: 5,
  },
  {
    reference: 'T-002',
    systemTag: 'MEC-VENT-AHU',
    stage: 'FUNCTIONAL',
    objective: 'Prove the supply volume, control response and fire damper interlock.',
    owner: 'Commissioning contractor',
    witness: 'Client technical adviser',
    acceptanceCriteria: 'Supply volume within ±5% of design at each terminal; dampers close within 10 seconds of signal.',
    criteriaSource: 'Design mechanical schedule MS-04, rev B',
    prerequisite: 'T-001 accepted and the BMS graphics released.',
    noticePeriodDays: 10,
  },
];

const MILESTONES: systemisation.MilestoneLink[] = [
  { milestone: 'Construction completion of the plant room', type: 'CONSTRUCTION', date: iso(10) },
  {
    milestone: 'Ventilation functional testing complete',
    type: 'COMMISSIONING',
    date: iso(40),
    dependsOn: 'Construction completion of the plant room',
  },
  {
    milestone: 'Handover of the laboratory',
    type: 'HANDOVER',
    date: iso(70),
    dependsOn: 'Ventilation functional testing complete',
  },
];

describe('CM-WF-01 the register', () => {
  before(freshProject);

  it('registers its seven event types, and none is available to an agent', () => {
    for (const [code, entity] of [
      ['SYSTEM_NODE_DEFINED', 'SystemNode'],
      ['SYSTEM_HIERARCHY_APPROVED', 'SystemNode'],
      ['COMMISSIONING_PLAN_DRAFTED', 'CommissioningPlan'],
      ['COMMISSIONING_PLAN_APPROVED', 'CommissioningPlan'],
      ['TEST_PACK_REQUIRED', 'TestPackRequirement'],
      ['COMMISSIONING_BASELINE_UPDATED', 'CommissioningPlan'],
      ['TEMPORARY_OPERATION_DECLARED', 'TemporaryOperation'],
    ] as const) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, entity);
      // The agent suggests the hierarchy and the missing tests; a competent
      // commissioning manager approves.
      assert.equal(definition.aiAllowed, false);
    }
  });

  it('classifies all four entities with the commissioning manager', () => {
    for (const entity of ['SystemNode', 'CommissioningPlan', 'TestPackRequirement', 'TemporaryOperation']) {
      assert.equal(classifyEntity(entity)?.area, 'QUALITY_COMMISSIONING');
    }
  });
});

describe('AC-CM-WF-01-01 every asset in exactly one boundary', () => {
  beforeEach(freshProject);

  it('builds a hierarchy and approves it once it holds together', () => {
    facility();
    ventilationSystem();

    const integrity = systemisation.checkHierarchy(asQAQC());
    assert.equal(integrity.sound, true);

    const result = systemisation.approveHierarchy(asQAQC(), { approvedBy: 'S. Kaur' });
    assert.equal(result.nodes, 3);
    assert.ok(systemisation.systemisationPosition(asQAQC()).hierarchy.every((node) => node.approved));
  });

  it('refuses approval while an asset sits in two boundaries', () => {
    facility();
    ventilationSystem();
    systemisation.defineSystem(asQAQC(), {
      tag: 'MEC-VENT-LAB',
      level: 'SUBSYSTEM',
      parentTag: 'MEC-VENT',
      name: 'Laboratory extract',
      boundary: 'The laboratory extract ductwork and its dedicated fan, from the fume cupboard to discharge.',
      // The same fan claimed by two subsystems: each team believes the other
      // tests it.
      assetTags: ['FAN-01', 'FAN-02'],
    });

    const integrity = systemisation.checkHierarchy(asQAQC());
    assert.equal(integrity.sound, false);
    assert.deepEqual(integrity.overlaps, [{ assetTag: 'FAN-01', claimedBy: ['MEC-VENT-AHU', 'MEC-VENT-LAB'] }]);

    const refusal = throwsCode(() => systemisation.approveHierarchy(asQAQC(), { approvedBy: 'S. Kaur' }), 'BOUNDARY_OVERLAP');
    assert.match(refusal.message ?? '', /each team believes the other is testing/);
  });

  it('refuses approval while a piece of equipment is in no boundary at all', () => {
    facility();
    ventilationSystem([]);
    systemisation.defineSystem(asQAQC(), {
      tag: 'AHU-01',
      level: 'EQUIPMENT',
      parentTag: 'MEC-VENT-AHU',
      name: 'Air handling unit 01',
      boundary: 'The unit itself, its local panel and the flexible connections at each end.',
    });

    const integrity = systemisation.checkHierarchy(asQAQC());
    assert.deepEqual(integrity.unclaimedEquipment, ['AHU-01']);
    const refusal = throwsCode(() => systemisation.approveHierarchy(asQAQC(), { approvedBy: 'S. Kaur' }), 'BOUNDARY_GAP');
    assert.match(refusal.message ?? '', /nobody’s system is the asset nobody tests/);
  });

  it('refuses a boundary drawn around nothing', () => {
    facility();
    systemisation.defineSystem(asQAQC(), {
      tag: 'MEC-VENT',
      level: 'SYSTEM',
      parentTag: 'FAC-01',
      name: 'Ventilation',
      boundary: 'All supply and extract air handling from intake louvre to terminal device.',
    });

    throwsCode(() => systemisation.approveHierarchy(asQAQC(), { approvedBy: 'S. Kaur' }), 'BOUNDARY_EMPTY');
  });

  it('refuses a duplicate tag, a skipped level and a node with no boundary', () => {
    facility();
    throwsCode(
      () =>
        systemisation.defineSystem(asQAQC(), {
          tag: 'FAC-01',
          level: 'SYSTEM',
          parentTag: 'FAC-01',
          name: 'Another one',
          boundary: 'Everything else that was not in the first one, whatever that turns out to be.',
        }),
      'TAG_TAKEN',
    );
    throwsCode(
      () =>
        systemisation.defineSystem(asQAQC(), {
          tag: 'MEC-VENT-AHU',
          level: 'SUBSYSTEM',
          parentTag: 'FAC-01',
          name: 'Air handling units',
          boundary: 'The AHUs, their local panels and the ductwork to the first fire damper.',
        }),
      'PARENT_WRONG_LEVEL',
    );
    throwsCode(
      () =>
        systemisation.defineSystem(asQAQC(), {
          tag: 'MEC-HTG',
          level: 'SYSTEM',
          parentTag: 'FAC-01',
          name: 'Heating',
          boundary: 'The heating.',
        }),
      'BOUNDARY_REQUIRED',
    );
  });

  it('refuses a definition from a role that only reads the commissioning record', () => {
    throwsCode(
      () =>
        systemisation.defineSystem(asPlanner(), {
          tag: 'ELE-LV',
          level: 'FACILITY',
          name: 'LV distribution',
          boundary: 'From the incoming switch panel to the final circuit isolators throughout the building.',
        }),
      'ACCESS_DENIED',
    );
  });
});

describe('AC-CM-WF-01-02 and -03 a plan that can be argued from', () => {
  beforeEach(async () => {
    await freshProject();
    facility();
    ventilationSystem();
    systemisation.approveHierarchy(asQAQC(), { approvedBy: 'S. Kaur' });
  });

  it('approves a complete plan and records the pack each test now owes', () => {
    const { planId } = systemisation.draftCommissioningPlan(asQAQC(), {
      title: 'Ventilation commissioning plan',
      tests: TESTS,
      milestones: MILESTONES,
    });

    const result = systemisation.approveCommissioningPlan(asQAQC(), planId, { approvedBy: 'S. Kaur' });
    assert.equal(result.packsRequired, 2);

    const position = systemisation.systemisationPosition(asQAQC());
    const pack = position.packsRequired.find((entry) => entry.reference === 'T-002')!;
    assert.equal(pack.witness, 'Client technical adviser');
    assert.equal(pack.noticePeriodDays, 10);
  });

  it('refuses a test with no witness, no criteria source or no prerequisite', () => {
    for (const field of ['witness', 'criteriaSource', 'prerequisite'] as const) {
      const { planId } = systemisation.draftCommissioningPlan(asQAQC(), {
        title: `Plan missing ${field}`,
        tests: [{ ...TESTS[0]!, [field]: '  ' }],
        milestones: MILESTONES,
      });
      const refusal = throwsCode(
        () => systemisation.approveCommissioningPlan(asQAQC(), planId, { approvedBy: 'S. Kaur' }),
        'TEST_INCOMPLETE',
      );
      assert.match(refusal.message ?? '', new RegExp(field));
    }
  });

  it('refuses a test whose witness finds out on the day', () => {
    const { planId } = systemisation.draftCommissioningPlan(asQAQC(), {
      title: 'Plan with no notice',
      tests: [{ ...TESTS[0]!, noticePeriodDays: 0 }],
      milestones: MILESTONES,
    });
    throwsCode(
      () => systemisation.approveCommissioningPlan(asQAQC(), planId, { approvedBy: 'S. Kaur' }),
      'NOTICE_PERIOD_REQUIRED',
    );
  });

  it('refuses a programme that reaches neither construction nor handover', () => {
    const { planId } = systemisation.draftCommissioningPlan(asQAQC(), {
      title: 'Plan floating free of the project',
      tests: TESTS,
      milestones: MILESTONES.filter((milestone) => milestone.type === 'COMMISSIONING').map((milestone) => ({
        ...milestone,
        dependsOn: undefined,
      })),
    });
    const refusal = throwsCode(
      () => systemisation.approveCommissioningPlan(asQAQC(), planId, { approvedBy: 'S. Kaur' }),
      'PROGRAMME_UNTRACED',
    );
    assert.match(refusal.message ?? '', /construction or handover/);
  });

  it('refuses a milestone that depends on one nobody planned', () => {
    const { planId } = systemisation.draftCommissioningPlan(asQAQC(), {
      title: 'Plan with a dangling dependency',
      tests: TESTS,
      milestones: [...MILESTONES, { milestone: 'Witness attendance', type: 'COMMISSIONING', date: iso(45), dependsOn: 'Nothing at all' }],
    });
    throwsCode(
      () => systemisation.approveCommissioningPlan(asQAQC(), planId, { approvedBy: 'S. Kaur' }),
      'MILESTONE_DANGLING',
    );
  });

  it('refuses a test planned against a system nobody defined', () => {
    throwsCode(
      () =>
        systemisation.draftCommissioningPlan(asQAQC(), {
          title: 'Plan against a phantom',
          tests: [{ ...TESTS[0]!, systemTag: 'MEC-CHW' }],
          milestones: MILESTONES,
        }),
      'TEST_SYSTEM_UNKNOWN',
    );
  });

  it('requires the impact on tests, assets and handover before the baseline moves', () => {
    const { planId } = systemisation.draftCommissioningPlan(asQAQC(), {
      title: 'Ventilation commissioning plan',
      tests: TESTS,
      milestones: MILESTONES,
    });
    systemisation.approveCommissioningPlan(asQAQC(), planId, { approvedBy: 'S. Kaur' });

    const refusal = throwsCode(
      () =>
        systemisation.updateCommissioningBaseline(asQAQC(), planId, {
          change: 'The laboratory extract has moved into its own system.',
          impactOnTests: 'Two new tests.',
          impactOnAssets: '  ',
          impactOnHandover: 'One extra O&M section.',
          updatedBy: 'S. Kaur',
        }),
      'IMPACT_UNSTATED',
    );
    assert.match(refusal.message ?? '', /impactOnAssets/);

    const result = systemisation.updateCommissioningBaseline(asQAQC(), planId, {
      change: 'The laboratory extract has moved out of the ventilation system into one of its own.',
      impactOnTests: 'Two functional tests transfer to the new system and one integrated test is added.',
      impactOnAssets: 'FAN-02 and the fume cupboard extract move to the new boundary in the asset register.',
      impactOnHandover: 'The O&M gains a section for the new system and the training schedule gains one session.',
      updatedBy: 'S. Kaur',
    });
    assert.equal(result.revision, 2);

    // The change is kept beside the plan rather than replacing it: the pattern of
    // baseline moves is what a late programme is diagnosed from.
    const plan = systemisation.systemisationPosition(asQAQC()).plans.find((entry) => entry.planId === planId)!;
    assert.equal(plan.changes, 1);
  });

  it('refuses a plan approved over an unapproved hierarchy', async () => {
    await freshProject();
    facility();
    ventilationSystem();
    const { planId } = systemisation.draftCommissioningPlan(asQAQC(), {
      title: 'Plan ahead of the boundaries',
      tests: TESTS,
      milestones: MILESTONES,
    });
    const refusal = throwsCode(
      () => systemisation.approveCommissioningPlan(asQAQC(), planId, { approvedBy: 'S. Kaur' }),
      'HIERARCHY_NOT_APPROVED',
    );
    assert.match(refusal.message ?? '', /scope can still change underneath it/);
  });
});

describe('temporary operation is not commissioning', () => {
  beforeEach(async () => {
    await freshProject();
    facility();
    ventilationSystem();
    systemisation.approveHierarchy(asQAQC(), { approvedBy: 'S. Kaur' });
  });

  it('records it as its own declaration, with what is not in place', () => {
    systemisation.declareTemporaryOperation(asQAQC(), {
      systemTag: 'MEC-VENT-AHU',
      purpose: 'Running the supply air to dry out the screed on the second floor ahead of the flooring.',
      from: iso(0),
      until: iso(21),
      responsibleParty: 'Main contractor',
      conditions: [
        'Fire damper interlocks not yet proven',
        'Filters are builders-work grade, not the specified final filters',
        'Control strategy running in hand, not under the BMS',
      ],
    });

    const position = systemisation.systemisationPosition(asQAQC());
    const declaration = position.temporaryOperation[0]!;
    assert.equal(declaration.systemTag, 'MEC-VENT-AHU');
    assert.equal(declaration.expired, false);
    assert.equal(declaration.responsibleParty, 'Main contractor');
    // Nothing about this makes the system commissioned.
    assert.equal(position.packsRequired.length, 0);
  });

  it('names a system running past the end of its period', () => {
    systemisation.declareTemporaryOperation(asQAQC(), {
      systemTag: 'MEC-VENT-AHU',
      purpose: 'Temporary heat to the ground floor while the permanent boilers are replaced under warranty.',
      from: iso(-40),
      until: iso(-5),
      responsibleParty: 'Main contractor',
      conditions: ['Permanent boilers not installed'],
    });

    const position = systemisation.systemisationPosition(asQAQC());
    assert.equal(position.temporaryOperation[0]!.expired, true);
    assert.match(position.summary, /past the end of its temporary operation period/);
  });

  it('refuses an open-ended period, an unexplained purpose and no stated conditions', () => {
    const base = {
      systemTag: 'MEC-VENT-AHU',
      purpose: 'Drying out the screed on the second floor ahead of the flooring.',
      from: iso(0),
      until: iso(21),
      responsibleParty: 'Main contractor',
      conditions: ['Fire damper interlocks not yet proven'],
    };
    throwsCode(() => systemisation.declareTemporaryOperation(asQAQC(), { ...base, purpose: 'Drying' }), 'PURPOSE_REQUIRED');
    throwsCode(() => systemisation.declareTemporaryOperation(asQAQC(), { ...base, until: base.from }), 'PERIOD_REQUIRED');
    const refusal = throwsCode(
      () => systemisation.declareTemporaryOperation(asQAQC(), { ...base, conditions: [] }),
      'CONDITIONS_REQUIRED',
    );
    assert.match(refusal.message ?? '', /ready to be commissioned rather than temporarily operated/);
  });
});
