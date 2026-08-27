import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as ommanual from '../src/domain/ommanual.ts';
import * as structure from '../src/domain/structure.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * H-WF-03 — O&M manuals and technical file assembly.
 *
 * `handover.publishOMManual` still extracts maintenance tasks from manufacturer
 * documentation and is untouched: that is a legitimate AI act producing a draft.
 * What is tested here is the structure, the two reviews and the acceptance that
 * turn a draft into something an operator can run a building on.
 */

let platform: Platform;
let seed: SeedResult;

/** Holds HANDOVER_OM C and U — authors and reviews. */
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
/** Holds HANDOVER_OM A — accepts the manual. */
const asFM = () => platform.context(seed.users.fm!.auth, seed.projectId, { source: 'WEB' });

async function freshProject() {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'HANDOVER',
    justification: 'Assembling the O&M manuals',
  });
}

function manual(overrides: Record<string, unknown> = {}) {
  return ommanual.createManual(asPM(), {
    reference: 'OM-VENT',
    systemTag: 'MEC-VENT',
    assetTags: ['AHU-01', 'AHU-02'],
    title: 'Ventilation operation and maintenance manual',
    author: 'D. Okonjo',
    ...overrides,
  } as Parameters<typeof ommanual.createManual>[1]).manualId;
}

/** A section written to satisfy every rule, which the tests then vary from. */
function section(
  manualId: string,
  key: ommanual.ManualSectionKey,
  overrides: Record<string, unknown> = {},
) {
  const base: Parameters<typeof ommanual.writeSection>[2] = {
    key,
    content: `Content for ${key}, describing the installed units and how they are operated and maintained.`,
    source: { kind: 'DESIGN', reference: 'M-1400', revision: 'C' },
    mappedAssetTags: ['AHU-01', 'AHU-02'],
    authoredBy: 'D. Okonjo',
    aiDrafted: false,
  };
  if (key === 'TROUBLESHOOTING') {
    base.symptoms = [
      { symptom: 'No heating on level three', probableCause: 'Frost coil valve stuck closed', task: 'Exercise the valve and check the actuator signal' },
    ];
  }
  if (key === 'MAINTENANCE_TASKS') {
    base.tasks = [{ task: 'Change the primary filters', frequency: 'Quarterly', skill: 'Mechanical technician' }];
  }
  return ommanual.writeSection(asPM(), manualId, { ...base, ...overrides } as Parameters<typeof ommanual.writeSection>[2]);
}

/** Both reviews on one section, which is what makes it accepted. */
function reviewed(manualId: string, key: ommanual.ManualSectionKey) {
  ommanual.reviewSection(asPM(), manualId, {
    key,
    role: 'CHECKER',
    decision: 'ACCEPTED',
    reviewedBy: 'A. Whitlock',
    comment: 'Checked against the design and the commissioning record.',
  });
  ommanual.reviewSection(asPM(), manualId, {
    key,
    role: 'OPERATOR',
    decision: 'ACCEPTED',
    reviewedBy: 'K. Mensah',
    comment: 'Usable by the duty engineers.',
  });
}

/** A complete, fully reviewed manual. */
function completeManual(): string {
  const manualId = manual();
  for (const definition of ommanual.MANUAL_SECTION) {
    section(manualId, definition.key);
    reviewed(manualId, definition.key);
  }
  return manualId;
}

describe('H-WF-03 the register', () => {
  beforeEach(freshProject);

  it('registers its event types, and none is available to an agent', () => {
    for (const code of [
      'OM_MANUAL_DRAFTED',
      'OM_SECTION_WRITTEN',
      'OM_SECTION_REVIEWED',
      'OM_SECTION_REVISION_REQUIRED',
      'OM_MANUAL_ACCEPTED',
      'OM_MANUAL_REJECTED',
    ] as const) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, 'OMManualStructure');
      // "AI-generated text must cite source and remains draft until accepted."
      assert.equal(definition.aiAllowed, false);
    }
  });

  it('leaves the AI extraction that feeds it exactly as it was', () => {
    assert.equal(lookupEventType('OM_MANUAL_PUBLISHED')!.aiAllowed, true);
    assert.equal(lookupEventType('OM_MANUAL_PUBLISHED')!.entity, 'OMManual');
  });
});

describe('a manual is not a folder of PDFs', () => {
  beforeEach(freshProject);

  it('refuses a generic catalogue against an asset-specific section', () => {
    const manualId = manual();
    const refusal = throwsCode(
      () =>
        section(manualId, 'MAINTENANCE_TASKS', {
          source: { kind: 'MANUFACTURER', reference: 'Pump catalogue 2024', revision: '1' },
          mappedAssetTags: [],
        }),
      'SECTION_UNMAPPED',
    );
    assert.match(refusal.message ?? '', /forty models tells an operator nothing about the two in the plant room/);
  });

  it('permits a generic source once it is mapped to the installed tags', () => {
    const manualId = manual();
    const result = section(manualId, 'MAINTENANCE_TASKS', {
      source: { kind: 'MANUFACTURER', reference: 'Pump catalogue 2024', revision: '1' },
      mappedAssetTags: ['AHU-01'],
    });
    assert.equal(result.status, 'DRAFT');
  });

  it('refuses a section mapped to an asset the manual does not cover', () => {
    const manualId = manual();
    throwsCode(() => section(manualId, 'OPERATION', { mappedAssetTags: ['AHU-99'] }), 'ASSET_OUTSIDE_MANUAL');
  });

  it('refuses a manual covering no assets, and a section that is a heading', () => {
    throwsCode(() => manual({ reference: 'OM-X', assetTags: [] }), 'ASSETS_REQUIRED');
    const manualId = manual();
    throwsCode(() => section(manualId, 'OPERATION', { content: 'See manual.' }), 'SECTION_EMPTY');
  });

  it('refuses a troubleshooting section with no symptoms, and a maintenance one with no tasks', () => {
    const manualId = manual();
    const refusal = throwsCode(() => section(manualId, 'TROUBLESHOOTING', { symptoms: [] }), 'SYMPTOMS_REQUIRED');
    assert.match(refusal.message ?? '', /no heating on level three/);
    throwsCode(() => section(manualId, 'MAINTENANCE_TASKS', { tasks: [] }), 'TASKS_REQUIRED');
  });
});

describe('AC-H-WF-03-02 every section shows source, version and approval', () => {
  beforeEach(freshProject);

  it('refuses a section citing no source or no revision', () => {
    const manualId = manual();
    const refusal = throwsCode(
      () => section(manualId, 'OPERATION', { source: { kind: 'DESIGN', reference: 'M-1400', revision: '  ' } }),
      'SOURCE_REQUIRED',
    );
    assert.match(refusal.message ?? '', /nobody trusts twice/);
  });

  it('needs both the checker and the operator before a section is accepted', () => {
    const manualId = manual();
    section(manualId, 'OPERATION');

    const checked = ommanual.reviewSection(asPM(), manualId, {
      key: 'OPERATION',
      role: 'CHECKER',
      decision: 'ACCEPTED',
      reviewedBy: 'A. Whitlock',
      comment: 'Technically correct against the design.',
    });
    assert.equal(checked.status, 'CHECKED');

    const accepted = ommanual.reviewSection(asPM(), manualId, {
      key: 'OPERATION',
      role: 'OPERATOR',
      decision: 'ACCEPTED',
      reviewedBy: 'K. Mensah',
      comment: 'The duty engineers can work from this.',
    });
    assert.equal(accepted.status, 'ACCEPTED');
  });

  it('refuses a section checked by the person who wrote it', () => {
    const manualId = manual();
    section(manualId, 'OPERATION');
    const refusal = throwsCode(
      () =>
        ommanual.reviewSection(asPM(), manualId, {
          key: 'OPERATION',
          role: 'CHECKER',
          decision: 'ACCEPTED',
          reviewedBy: 'D. Okonjo',
          comment: 'Looks right to me.',
        }),
      'SELF_REVIEW',
    );
    assert.match(refusal.message ?? '', /has been checked by nobody/);
  });

  it('returns a rejected section to draft, and needs a reason for the rejection', () => {
    const manualId = manual();
    section(manualId, 'OPERATION');
    throwsCode(
      () =>
        ommanual.reviewSection(asPM(), manualId, {
          key: 'OPERATION',
          role: 'CHECKER',
          decision: 'REJECTED',
          reviewedBy: 'A. Whitlock',
          comment: 'No',
        }),
      'COMMENT_REQUIRED',
    );
    const result = ommanual.reviewSection(asPM(), manualId, {
      key: 'OPERATION',
      role: 'CHECKER',
      decision: 'REJECTED',
      reviewedBy: 'A. Whitlock',
      comment: 'The start-up sequence is the pre-commissioning one, not the sequence as commissioned.',
    });
    assert.equal(result.status, 'DRAFT');
  });
});

describe('acceptance is refused on what an operator cannot start without', () => {
  beforeEach(freshProject);

  it('accepts a complete, reviewed manual', () => {
    const manualId = completeManual();
    const result = ommanual.acceptManual(asFM(), manualId, { acceptedBy: 'K. Mensah', forOperator: 'Riverside Estates' });
    assert.equal(result.completenessPercent, 100);
  });

  it('refuses one missing the emergency or safety sections', () => {
    const manualId = manual();
    for (const definition of ommanual.MANUAL_SECTION) {
      if (definition.key === 'EMERGENCY_PROCEDURES') continue;
      section(manualId, definition.key);
      reviewed(manualId, definition.key);
    }
    const refusal = throwsCode(
      () => ommanual.acceptManual(asFM(), manualId, { acceptedBy: 'K. Mensah', forOperator: 'Riverside Estates' }),
      'BLOCKER_SECTION_MISSING',
    );
    assert.match(refusal.message ?? '', /cannot run one without knowing what to do when it fails/);
  });

  it('refuses one carrying AI-drafted text nobody accepted', () => {
    const manualId = manual();
    for (const definition of ommanual.MANUAL_SECTION) {
      section(manualId, definition.key, { aiDrafted: definition.key === 'SPARES' });
      if (definition.key !== 'SPARES') reviewed(manualId, definition.key);
    }
    const refusal = throwsCode(
      () => ommanual.acceptManual(asFM(), manualId, { acceptedBy: 'K. Mensah', forOperator: 'Riverside Estates' }),
      'AI_DRAFT_UNACCEPTED',
    );
    assert.match(refusal.message ?? '', /draft until a person stands behind it/);
  });

  it('refuses one where the same task is given two different frequencies', () => {
    const manualId = manual();
    for (const definition of ommanual.MANUAL_SECTION) {
      section(
        manualId,
        definition.key,
        definition.key === 'SPARES'
          ? { tasks: [{ task: 'Change the primary filters', frequency: 'Six-monthly', skill: 'Mechanical technician' }] }
          : {},
      );
      reviewed(manualId, definition.key);
    }
    const refusal = throwsCode(
      () => ommanual.acceptManual(asFM(), manualId, { acceptedBy: 'K. Mensah', forOperator: 'Riverside Estates' }),
      'CONTRADICTORY_CONTENT',
    );
    assert.match(refusal.message ?? '', /given as Quarterly and Six-monthly/);
    assert.match(refusal.message ?? '', /neither of which was wrong/);
  });

  it('refuses one naming an asset that appears in no section', () => {
    const manualId = manual({ reference: 'OM-VENT-3', assetTags: ['AHU-01', 'AHU-02', 'AHU-03'] });
    for (const definition of ommanual.MANUAL_SECTION) {
      section(manualId, definition.key, { mappedAssetTags: ['AHU-01', 'AHU-02'] });
      reviewed(manualId, definition.key);
    }
    const refusal = throwsCode(
      () => ommanual.acceptManual(asFM(), manualId, { acceptedBy: 'K. Mensah', forOperator: 'Riverside Estates' }),
      'ASSET_UNCOVERED',
    );
    assert.match(refusal.message ?? '', /the one nobody can maintain/);
  });

  it('refuses a rejection with no reasons, and a section rewritten after acceptance', () => {
    const manualId = completeManual();
    throwsCode(() => ommanual.rejectManual(asFM(), manualId, { reasons: ['No'], rejectedBy: 'K. Mensah' }), 'REASONS_REQUIRED');
    ommanual.acceptManual(asFM(), manualId, { acceptedBy: 'K. Mensah', forOperator: 'Riverside Estates' });
    const refusal = throwsCode(() => section(manualId, 'OPERATION'), 'MANUAL_ACCEPTED');
    assert.match(refusal.message ?? '', /what the operator agreed to run the building on/);
  });

  it('refuses acceptance from a role that authors but does not approve', () => {
    const manualId = completeManual();
    throwsCode(
      () => ommanual.acceptManual(asPM(), manualId, { acceptedBy: 'A PM', forOperator: 'Riverside Estates' }),
      'ACCESS_DENIED',
    );
  });
});

describe('AC-H-WF-03-01 searchable by tag, system, symptom and task', () => {
  beforeEach(freshProject);

  it('finds a section by the asset tag on the plate', () => {
    const manualId = manual();
    section(manualId, 'OPERATION', { mappedAssetTags: ['AHU-01'] });
    const hits = ommanual.searchManuals(asPM(), { assetTag: 'AHU-01' });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.matchedOn, 'ASSET');
    assert.equal(hits[0]!.source, 'M-1400 rev C');
  });

  it('finds the task by the symptom an operator actually starts from', () => {
    const manualId = manual();
    section(manualId, 'TROUBLESHOOTING');
    const hits = ommanual.searchManuals(asPM(), { symptom: 'no heating' });
    assert.equal(hits[0]!.matchedOn, 'SYMPTOM');
    assert.match(hits[0]!.detail, /Frost coil valve stuck closed/);
    assert.match(hits[0]!.detail, /Exercise the valve/);
  });

  it('finds a maintenance task by name, with its frequency and the skill it needs', () => {
    const manualId = manual();
    section(manualId, 'MAINTENANCE_TASKS');
    const hits = ommanual.searchManuals(asPM(), { task: 'filters' });
    assert.equal(hits[0]!.matchedOn, 'TASK');
    assert.match(hits[0]!.detail, /Quarterly, Mechanical technician/);
  });

  it('shows the section status, so nobody works from a draft believing it is accepted', () => {
    const manualId = manual();
    section(manualId, 'TROUBLESHOOTING');
    assert.equal(ommanual.searchManuals(asPM(), { symptom: 'no heating' })[0]!.status, 'DRAFT');
    reviewed(manualId, 'TROUBLESHOOTING');
    assert.equal(ommanual.searchManuals(asPM(), { symptom: 'no heating' })[0]!.status, 'ACCEPTED');
  });

  it('returns the whole system when only the system is asked for', () => {
    const manualId = manual();
    section(manualId, 'OPERATION');
    section(manualId, 'CONTROLS');
    assert.equal(ommanual.searchManuals(asPM(), { systemTag: 'MEC-VENT' }).length, 2);
    assert.equal(ommanual.searchManuals(asPM(), { systemTag: 'ELE-LV' }).length, 0);
  });
});

describe('AC-H-WF-03-03 changed asset data finds its sections', () => {
  beforeEach(freshProject);

  it('flags every section that described the asset, and leaves the rest alone', () => {
    const manualId = manual();
    section(manualId, 'MAINTENANCE_TASKS', { mappedAssetTags: ['AHU-01'] });
    section(manualId, 'SPARES', { mappedAssetTags: ['AHU-02'] });
    section(manualId, 'SYSTEM_DESCRIPTION', { mappedAssetTags: [] });

    const result = ommanual.flagAssetDataChange(asPM(), {
      assetTag: 'AHU-01',
      what: 'The unit was replaced under warranty with a different model and a different filter size.',
      changedBy: 'K. Mensah',
    });
    assert.deepEqual(result.flagged.map((entry) => entry.section), ['MAINTENANCE_TASKS']);

    const position = ommanual.omManualPosition(asPM());
    assert.deepEqual(position.manuals[0]!.revisionRequired, ['MAINTENANCE_TASKS']);
    assert.match(position.summary, /a section the asset data has overtaken/);
  });

  it('refuses a change nobody described', () => {
    manual();
    throwsCode(
      () => ommanual.flagAssetDataChange(asPM(), { assetTag: 'AHU-01', what: 'Changed', changedBy: 'K. Mensah' }),
      'CHANGE_UNDESCRIBED',
    );
  });

  it('reports validation as arithmetic over the sections rather than a stored number', () => {
    const manualId = manual();
    section(manualId, 'OPERATION');
    const first = ommanual.validateManual(asPM(), manualId);
    assert.equal(first.completenessPercent, Math.round((1 / ommanual.MANUAL_SECTION.length) * 100));
    assert.ok(first.missingBlockers.includes('EMERGENCY_PROCEDURES'));
    assert.equal(first.acceptable, false);

    section(manualId, 'EMERGENCY_PROCEDURES');
    const second = ommanual.validateManual(asPM(), manualId);
    assert.ok(!second.missingBlockers.includes('EMERGENCY_PROCEDURES'));
  });
});
