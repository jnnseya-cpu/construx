import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as asbuilt from '../src/domain/asbuilt.ts';
import * as structure from '../src/domain/structure.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * H-WF-02 — as-built drawing, model and specification verification.
 *
 * `engines/bim.ts` already generates an as-built model from captured reality and
 * is untouched: that is the drafting side and it is allowed to be an AI act.
 * What is tested here is the verification layer on top — as-built status coming
 * from a person rather than a filename, every implemented change answered, and
 * the asset and the drawing opening from each other.
 */

let platform: Platform;
let seed: SeedResult;

/** Holds DESIGN_INFORMATION C and U — submits and raises variances. */
const asEPC = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
/** Holds DESIGN_INFORMATION A and I — verifies and publishes. */
const asDesigner = () => platform.context(seed.users.designer!.auth, seed.projectId, { source: 'WEB' });

const SUBMISSION = {
  reference: 'ABS-MEC-01',
  systemTag: 'MEC-VENT',
  discipline: 'Mechanical',
  approvedDesignRefs: [{ reference: 'M-1400', revision: 'C' }],
  implementedChanges: [
    { changeRef: 'DC-014', reflected: 'REFLECTED' as const, note: 'Riser re-route shown on M-1400 sheet 3.' },
    {
      changeRef: 'DC-021',
      reflected: 'NOT_APPLICABLE' as const,
      note: 'The change was withdrawn before installation; nothing was built to it.',
    },
  ],
  deliverables: [
    { format: 'NATIVE' as const, reference: 'M-1400.rvt', fileHash: 'a'.repeat(64) },
    {
      format: 'IFC' as const,
      reference: 'M-1400.ifc',
      fileHash: 'b'.repeat(64),
      conversionNotes: 'Parametric families flattened to generic solids; system classifications retained.',
    },
  ],
  metadata: { coordinateSystem: 'OSGB36 / British National Grid', units: 'millimetres', taggedObjects: 940, totalObjects: 1000 },
  submittedBy: 'Mechanical subcontractor',
};

async function freshProject() {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'HANDOVER',
    justification: 'Verifying the as-built information',
  });
}

function submit(overrides: Record<string, unknown> = {}) {
  return asbuilt.submitAsBuiltSet(asEPC(), {
    ...SUBMISSION,
    ...overrides,
  } as Parameters<typeof asbuilt.submitAsBuiltSet>[1]);
}

function verify(setId: string) {
  return asbuilt.verifyAsBuiltSet(asDesigner(), setId, {
    verifiedBy: 'A. Whitlock',
    discipline: 'Mechanical',
    registration: 'CEng MCIBSE 481207',
    statement: 'Verified against M-1400 rev C and the installed condition surveyed on the 14th, including both changes.',
  });
}

describe('H-WF-02 the register', () => {
  beforeEach(freshProject);

  it('registers its event types, and none is available to an agent', () => {
    for (const [code, entity] of [
      ['AS_BUILT_SUBMITTED', 'AsBuiltSet'],
      ['AS_BUILT_VARIANCE_IDENTIFIED', 'AsBuiltSet'],
      ['AS_BUILT_VARIANCE_RESOLVED', 'AsBuiltSet'],
      ['AS_BUILT_VERIFIED', 'AsBuiltSet'],
      ['AS_BUILT_PUBLISHED', 'AsBuiltSet'],
      ['AS_BUILT_SUPERSEDED', 'AsBuiltSet'],
      ['ASSET_INFORMATION_LINKED', 'AssetInformationLink'],
    ] as const) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, entity);
      // "Cannot certify as-built accuracy; authorised professionals verify."
      assert.equal(definition.aiAllowed, false);
    }
    assert.equal(classifyEntity('AsBuiltSet')?.area, 'DESIGN_INFORMATION');
  });

  it('leaves the AI-drafted as-built generation exactly as it was', () => {
    // The drafting side is legitimately an AI act, and this workflow does not
    // change it. What it adds is the verification the agent cannot do.
    assert.equal(lookupEventType('AS_BUILT_GENERATED')!.aiAllowed, true);
    assert.equal(lookupEventType('AS_BUILT_GENERATED')!.entity, 'Model');
  });
});

describe('AC-H-WF-02-01 status is verification, not a filename', () => {
  beforeEach(freshProject);

  it('leaves a submitted set as submitted, however it is named', () => {
    const { setId } = submit({ reference: 'AS-BUILT-FINAL-rev-C' });
    assert.equal(asbuilt.asBuiltPosition(asDesigner()).sets[0]!.status, 'SUBMITTED');
    // And an unverified set cannot be published for operational use.
    const refusal = throwsCode(
      () => asbuilt.publishAsBuiltSet(asDesigner(), setId, { publishedBy: 'A. Whitlock', supersedes: [] }),
      'NOT_VERIFIED',
    );
    assert.match(refusal.message ?? '', /in front of the people who maintain the building/);
  });

  it('records the professional and the registration on the verification', () => {
    const { setId } = submit();
    const result = verify(setId);
    assert.equal(result.status, 'VERIFIED');
    assert.equal(asbuilt.asBuiltPosition(asDesigner()).sets[0]!.verifiedBy, 'A. Whitlock');
  });

  it('refuses a verification with no registration or no statement', () => {
    const { setId } = submit();
    const refusal = throwsCode(
      () =>
        asbuilt.verifyAsBuiltSet(asDesigner(), setId, {
          verifiedBy: 'A. Whitlock',
          discipline: 'Mechanical',
          registration: '  ',
          statement: 'Verified against the approved design and the installed condition.',
        }),
      'VERIFICATION_UNSIGNED',
    );
    assert.match(refusal.message ?? '', /not a filename/);
    throwsCode(
      () =>
        asbuilt.verifyAsBuiltSet(asDesigner(), setId, {
          verifiedBy: 'A. Whitlock',
          discipline: 'Mechanical',
          registration: 'CEng MCIBSE 481207',
          statement: 'Checked.',
        }),
      'STATEMENT_REQUIRED',
    );
  });

  it('refuses verification from the party that produced it', () => {
    const { setId } = submit();
    throwsCode(
      () =>
        asbuilt.verifyAsBuiltSet(asEPC(), setId, {
          verifiedBy: 'Mechanical subcontractor',
          discipline: 'Mechanical',
          registration: 'n/a',
          statement: 'We drew it, so we know it is right.',
        }),
      'ACCESS_DENIED',
    );
  });
});

describe('AC-H-WF-02-02 every implemented change reflected, or explicitly not', () => {
  beforeEach(freshProject);

  it('accepts a change answered either way, with a reason', () => {
    const result = submit();
    assert.equal(result.taggedPercent, 94);
    assert.equal(asbuilt.asBuiltPosition(asDesigner()).sets[0]!.changesNotApplicable, 1);
  });

  it('refuses a change answered with nothing said about it', () => {
    const refusal = throwsCode(
      () =>
        submit({
          implementedChanges: [{ changeRef: 'DC-014', reflected: 'NOT_APPLICABLE', note: '  ' }],
        }),
      'CHANGE_UNANSWERED',
    );
    assert.match(refusal.message ?? '', /how a change gets lost/);
  });

  it('refuses a set with no approved design behind it', () => {
    const refusal = throwsCode(() => submit({ approvedDesignRefs: [] }), 'APPROVED_DESIGN_REQUIRED');
    assert.match(refusal.message ?? '', /checking it against something is the entire exercise/);
    throwsCode(() => submit({ approvedDesignRefs: [{ reference: 'M-1400', revision: '  ' }] }), 'APPROVED_DESIGN_REQUIRED');
  });
});

describe('conversion loss is reported, not silently accepted', () => {
  beforeEach(freshProject);

  it('refuses an IFC with no native file behind it', () => {
    const refusal = throwsCode(
      () =>
        submit({
          deliverables: [
            {
              format: 'IFC',
              reference: 'M-1400.ifc',
              fileHash: 'b'.repeat(64),
              conversionNotes: 'Families flattened.',
            },
          ],
        }),
      'NATIVE_REQUIRED',
    );
    assert.match(refusal.message ?? '', /nobody can go back to/);
  });

  it('refuses a conversion with no note of what it dropped', () => {
    const refusal = throwsCode(
      () =>
        submit({
          deliverables: [
            { format: 'NATIVE', reference: 'M-1400.rvt', fileHash: 'a'.repeat(64) },
            { format: 'PDF', reference: 'M-1400.pdf', fileHash: 'c'.repeat(64) },
          ],
        }),
      'CONVERSION_LOSS_UNREPORTED',
    );
    assert.match(refusal.message ?? '', /one where nobody looked/);
  });

  it('refuses a model delivered with no coordinate system or units', () => {
    const refusal = throwsCode(
      () => submit({ metadata: { ...SUBMISSION.metadata, coordinateSystem: '  ' } }),
      'METADATA_REQUIRED',
    );
    assert.match(refusal.message ?? '', /inserted at the wrong origin/);
  });
});

describe('a material variance blocks the handover it affects', () => {
  beforeEach(freshProject);

  it('blocks verification while it is open, and permits it once resolved', () => {
    const { setId } = submit();
    asbuilt.recordVariance(asEPC(), setId, {
      reference: 'VAR-001',
      description: 'The riser is shown on grid 6 and is installed on grid 7.',
      material: true,
      location: 'Level 3 riser cupboard',
      raisedBy: 'J. Byrne',
    });

    const refusal = throwsCode(() => verify(setId), 'MATERIAL_VARIANCE_OPEN');
    assert.match(refusal.message ?? '', /known to disagree with what is installed/);

    // And the handover of that system is blocked while it stands.
    const blocked = asbuilt.asBuiltBlockedReason(asEPC(), 'MEC-VENT')!;
    assert.match(blocked, /VAR-001/);
    assert.match(blocked, /wrong about it/);

    asbuilt.resolveVariance(asEPC(), setId, {
      reference: 'VAR-001',
      resolution: 'Drawing corrected to grid 7 and reissued at revision D within this set.',
      resolvedBy: 'A. Whitlock',
    });
    assert.equal(verify(setId).status, 'VERIFIED');
  });

  it('lets a non-material variance stand without blocking anything', () => {
    const { setId } = submit();
    asbuilt.recordVariance(asEPC(), setId, {
      reference: 'VAR-002',
      description: 'Two valve tags shown in the wrong font on sheet 4.',
      material: false,
      location: 'Sheet 4',
      raisedBy: 'J. Byrne',
    });
    assert.equal(verify(setId).unresolvedVariances, 1);
    assert.deepEqual(asbuilt.asBuiltPosition(asDesigner()).blocking, []);
  });

  it('reports a system with no as-built at all, and one not yet published', () => {
    const { setId } = submit();
    assert.match(asbuilt.asBuiltBlockedReason(asEPC(), 'ELE-LV')!, /No as-built information has been submitted for ELE-LV/);
    verify(setId);
    assert.match(asbuilt.asBuiltBlockedReason(asEPC(), 'MEC-VENT')!, /has not been published for operational use/);

    asbuilt.publishAsBuiltSet(asDesigner(), setId, { publishedBy: 'A. Whitlock', supersedes: ['M-1400 rev C'] });
    assert.equal(asbuilt.asBuiltBlockedReason(asEPC(), 'MEC-VENT'), null);
  });

  it('binds nothing on a project that submits no as-built sets', () => {
    assert.equal(asbuilt.asBuiltBlockedReason(asEPC(), 'MEC-VENT'), null);
  });

  it('refuses a variance nobody described, and a resolution that says nothing', () => {
    const { setId } = submit();
    throwsCode(
      () =>
        asbuilt.recordVariance(asEPC(), setId, {
          reference: 'VAR-003',
          description: 'Discrepancy',
          material: true,
          location: 'Level 3',
          raisedBy: 'J. Byrne',
        }),
      'VARIANCE_UNDESCRIBED',
    );
    asbuilt.recordVariance(asEPC(), setId, {
      reference: 'VAR-004',
      description: 'The riser is shown on grid 6 and is installed on grid 7.',
      material: true,
      location: 'Level 3 riser cupboard',
      raisedBy: 'J. Byrne',
    });
    throwsCode(
      () => asbuilt.resolveVariance(asEPC(), setId, { reference: 'VAR-004', resolution: 'Fixed', resolvedBy: 'A. W' }),
      'RESOLUTION_REQUIRED',
    );
  });
});

describe('publication supersedes the earlier revision', () => {
  beforeEach(freshProject);

  it('leaves exactly one current revision of a reference', () => {
    const first = submit();
    verify(first.setId);
    asbuilt.publishAsBuiltSet(asDesigner(), first.setId, { publishedBy: 'A. Whitlock', supersedes: ['M-1400 rev C'] });

    // A late correction is a new revision, which is the exception control.
    const second = submit();
    assert.equal(second.revision, 2);
    verify(second.setId);
    const result = asbuilt.publishAsBuiltSet(asDesigner(), second.setId, {
      publishedBy: 'A. Whitlock',
      supersedes: ['ABS-MEC-01 rev 1'],
    });
    assert.deepEqual(result.supersededSets, ['ABS-MEC-01 rev 1']);

    const position = asbuilt.asBuiltPosition(asDesigner());
    // An operator with two current as-builts has none.
    assert.equal(position.sets.filter((set) => set.status === 'PUBLISHED').length, 1);
    assert.equal(position.sets.find((set) => set.revision === 1)!.status, 'SUPERSEDED');
  });
});

describe('AC-H-WF-02-03 the asset and the drawing open from each other', () => {
  beforeEach(freshProject);

  it('answers both directions from one record', () => {
    const { setId } = submit();
    asbuilt.linkAssetInformation(asEPC(), {
      assetTag: 'AHU-01',
      setId,
      drawingReference: 'M-1400 sheet 3',
      modelElementId: 'ifc:1a2b3c',
      location: 'Level 3 plant room, grid D4',
    });

    // The tag-on-a-plate direction, at two in the morning.
    const information = asbuilt.informationForAsset(asEPC(), 'AHU-01');
    assert.equal(information[0]!.drawingReference, 'M-1400 sheet 3');
    assert.equal(information[0]!.status, 'SUBMITTED');

    // And the other direction, from the same record.
    const assets = asbuilt.assetsOnDrawing(asEPC(), 'M-1400 sheet 3');
    assert.deepEqual(assets.map((asset) => asset.assetTag), ['AHU-01']);
    assert.equal(assets[0]!.location, 'Level 3 plant room, grid D4');
  });

  it('refuses a link that only works in one direction, and a duplicate', () => {
    const { setId } = submit();
    const refusal = throwsCode(
      () =>
        asbuilt.linkAssetInformation(asEPC(), {
          assetTag: 'AHU-01',
          setId,
          drawingReference: '  ',
          location: 'Level 3 plant room',
        }),
      'LINK_INCOMPLETE',
    );
    assert.match(refusal.message ?? '', /only works in one direction/);

    asbuilt.linkAssetInformation(asEPC(), {
      assetTag: 'AHU-01',
      setId,
      drawingReference: 'M-1400 sheet 3',
      location: 'Level 3 plant room, grid D4',
    });
    throwsCode(
      () =>
        asbuilt.linkAssetInformation(asEPC(), {
          assetTag: 'AHU-01',
          setId,
          drawingReference: 'M-1400 sheet 3',
          location: 'Level 3 plant room, grid D4',
        }),
      'LINK_EXISTS',
    );
  });

  it('shows the reader the status of the information the asset points at', () => {
    const { setId } = submit();
    asbuilt.linkAssetInformation(asEPC(), {
      assetTag: 'AHU-01',
      setId,
      drawingReference: 'M-1400 sheet 3',
      location: 'Level 3 plant room, grid D4',
    });
    verify(setId);
    asbuilt.publishAsBuiltSet(asDesigner(), setId, { publishedBy: 'A. Whitlock', supersedes: [] });

    // The maintenance engineer needs to know they are looking at published
    // information rather than a submission somebody is still arguing about.
    assert.equal(asbuilt.informationForAsset(asEPC(), 'AHU-01')[0]!.status, 'PUBLISHED');
  });
});
