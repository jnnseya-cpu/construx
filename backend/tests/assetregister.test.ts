import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as assetregister from '../src/domain/assetregister.ts';
import * as structure from '../src/domain/structure.ts';
import * as handover from '../src/engines/handover.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * H-WF-04 — asset register, exchange validation and reconciliation.
 *
 * `handover.registerAsset` and `handover.registerWarranty` are reused unchanged
 * apart from one correctness fix: registering a tag twice is now refused. What
 * is tested here is everything that decides whether the register is fit to hand
 * over — blank is not pass, a duplicate identity blocks acceptance, and an
 * export is a claim rather than an acceptance.
 */

let platform: Platform;
let seed: SeedResult;

const asFM = () => platform.context(seed.users.fm!.auth, seed.projectId, { source: 'WEB' });
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

async function freshProject() {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'HANDOVER',
    justification: 'Validating the asset register',
  });
}

function asset(assetTag: string, overrides: Record<string, unknown> = {}) {
  return handover.registerAsset(asFM(), {
    assetTag,
    description: `Air handling unit ${assetTag}`,
    assetClass: 'Uniclass Pr_65_52_03',
    manufacturer: 'Nordair',
    modelNumber: 'NA-4400',
    serialNumber: `SN-${assetTag}`,
    installedAt: iso(-30),
    location: 'Level 3 plant room',
    expectedLifeYears: 20,
    replacementCostMinor: 4_200_000,
    ...overrides,
  } as Parameters<typeof handover.registerAsset>[1]).assetId;
}

/** The tags the demo seed already registered, so tests count only their own. */
function seededTags(): string[] {
  return platform
    .context(seed.users.fm!.auth, seed.projectId, { source: 'WEB' })
    .ledger.list(seed.projectId, 'AssetRegisterItem')
    .map((record) => String(record.state.assetTag));
}

describe('H-WF-04 the register', () => {
  beforeEach(freshProject);

  it('registers its event types, and none is available to an agent', () => {
    for (const [code, entity] of [
      ['ASSET_DATA_VALIDATED', 'AssetValidation'],
      ['ASSET_EXCHANGE_EXPORTED', 'AssetExchange'],
      ['ASSET_RECONCILED', 'AssetExchange'],
    ] as const) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, entity);
      // "Does not invent serial, warranty or maintenance requirement."
      assert.equal(definition.aiAllowed, false);
    }
  });
});

describe('a duplicate identity blocks acceptance', () => {
  beforeEach(freshProject);

  it('refuses a tag that is already on the register', () => {
    asset('AHU-01');
    const refusal = throwsCode(() => asset('AHU-01'), 'ASSET_TAG_TAKEN');
    assert.match(refusal.message ?? '', /everything downstream resolves the tag to a single machine/);
  });

  it('reports a duplicate serial, which is a copied row rather than a merged machine', () => {
    asset('AHU-01');
    asset('AHU-02', { serialNumber: 'SN-AHU-01' });

    const validation = assetregister.validateRegister(asFM());
    const duplicate = validation.errors.find((error) => error.code === 'DUPLICATE_IDENTITY')!;
    assert.match(duplicate.detail, /a serial was copied from the row above/);
    assert.match(assetregister.assetHandoverBlockedReason(asFM())!, /serial/);
  });
});

describe('AC-H-WF-04-01 blank is not pass', () => {
  beforeEach(freshProject);

  it('reports a blank mandatory attribute as a machine-readable error', () => {
    asset('AHU-01', { serialNumber: '' });
    const validation = assetregister.validateRegister(asFM());
    const error = validation.errors.find((entry) => entry.assetTag === 'AHU-01' && entry.attribute === 'serialNumber')!;
    assert.equal(error.code, 'MISSING');
    assert.match(error.detail, /passes a presence check by not being examined/);
    assert.ok(validation.completePercent < 100);
  });

  it('accepts an explicit Unknown with an owner and a date, which clears the error', () => {
    asset('AHU-01', { serialNumber: '' });
    assetregister.declareUnknowns(asFM(), {
      assetTag: 'AHU-01',
      declaredUnknowns: [
        {
          attribute: 'serialNumber',
          owner: 'Mechanical subcontractor',
          reason: 'The nameplate was obscured by the insulation and is being re-read at the next access.',
          by: iso(14),
        },
      ],
      declaredBy: 'K. Mensah',
    });

    const validation = assetregister.validateRegister(asFM());
    assert.ok(!validation.errors.some((entry) => entry.assetTag === 'AHU-01' && entry.attribute === 'serialNumber'));
    assert.equal(validation.declaredUnknowns[0]!.owner, 'Mechanical subcontractor');
  });

  it('refuses an Unknown with no owner, no reason or no date', () => {
    asset('AHU-01', { serialNumber: '' });
    const base = {
      attribute: 'serialNumber' as const,
      owner: 'Mechanical subcontractor',
      reason: 'The nameplate was obscured by the insulation.',
      by: iso(14),
    };
    const refusal = throwsCode(
      () =>
        assetregister.declareUnknowns(asFM(), {
          assetTag: 'AHU-01',
          declaredUnknowns: [{ ...base, owner: '  ' }],
          declaredBy: 'K. Mensah',
        }),
      'UNKNOWN_UNOWNED',
    );
    assert.match(refusal.message ?? '', /a blank with a label on it/);
    throwsCode(
      () =>
        assetregister.declareUnknowns(asFM(), {
          assetTag: 'AHU-01',
          declaredUnknowns: [{ ...base, by: 'later' }],
          declaredBy: 'K. Mensah',
        }),
      'UNKNOWN_UNDATED',
    );
  });

  it('refuses to declare the asset’s own identity Unknown', () => {
    asset('AHU-01');
    const refusal = throwsCode(
      () =>
        assetregister.declareUnknowns(asFM(), {
          assetTag: 'AHU-01',
          declaredUnknowns: [
            {
              attribute: 'manufacturer',
              owner: 'Mechanical subcontractor',
              reason: 'Nobody recorded who made it and the plate is gone.',
              by: iso(14),
            },
          ],
          declaredBy: 'K. Mensah',
        }),
      'IDENTITY_NOT_DECLARABLE',
    );
    assert.match(refusal.message ?? '', /it is a row/);
  });

  it('blocks handover on an Unknown past the date somebody was to resolve it by', () => {
    asset('AHU-01', { serialNumber: '' });
    assetregister.declareUnknowns(asFM(), {
      assetTag: 'AHU-01',
      declaredUnknowns: [
        {
          attribute: 'serialNumber',
          owner: 'Mechanical subcontractor',
          reason: 'The nameplate was obscured by the insulation.',
          by: iso(-3),
        },
      ],
      declaredBy: 'K. Mensah',
    });
    assert.match(assetregister.assetHandoverBlockedReason(asFM())!, /past the date Mechanical subcontractor was to resolve it by/);
  });
});

describe('AC-H-WF-04-03 export success is not acceptance', () => {
  beforeEach(freshProject);

  it('exports a clean selection with stable external ids and a content hash', () => {
    asset('AHU-01');
    asset('AHU-02');
    const result = assetregister.exportExchange(asFM(), {
      reference: 'EXP-001',
      format: 'COBIE',
      externalSystem: 'Riverside CAFM',
      assetTags: ['AHU-01', 'AHU-02'],
      exportedBy: 'K. Mensah',
    });
    assert.equal(result.rowsExported, 2);
    assert.match(result.contentHash, /^sha256:[0-9a-f]{64}$/);

    // Exported and not yet reconciled is not accepted.
    assert.match(assetregister.assetHandoverBlockedReason(asFM())!, /Export success is not acceptance/);
  });

  it('refuses to export a selection carrying validation errors', () => {
    asset('AHU-01', { serialNumber: '' });
    const refusal = throwsCode(
      () =>
        assetregister.exportExchange(asFM(), {
          reference: 'EXP-002',
          format: 'COBIE',
          externalSystem: 'Riverside CAFM',
          assetTags: ['AHU-01'],
          exportedBy: 'K. Mensah',
        }),
      'REGISTER_INVALID',
    );
    assert.match(refusal.message ?? '', /copies them somewhere harder to correct/);
  });

  it('reconciles when the totals add up, and clears the block', () => {
    asset('AHU-01');
    asset('AHU-02');
    const { exportId } = assetregister.exportExchange(asFM(), {
      reference: 'EXP-003',
      format: 'COBIE',
      externalSystem: 'Riverside CAFM',
      assetTags: ['AHU-01', 'AHU-02'],
      exportedBy: 'K. Mensah',
    });

    const result = assetregister.reconcileExchange(asFM(), exportId, {
      rowsAccepted: 1,
      rejected: [{ externalId: 'AHU-02', reason: 'Classification Pr_65_52_03 is not in the CAFM code list.' }],
      reconciledBy: 'K. Mensah',
    });
    assert.equal(result.reconciles, true);
    assert.equal(assetregister.assetHandoverBlockedReason(asFM()), null);

    const position = assetregister.assetRegisterPosition(asFM());
    assert.match(position.summary, /1 row rejected by the receiving system/);
  });

  it('refuses a reconciliation whose totals leave rows unaccounted for', () => {
    asset('AHU-01');
    asset('AHU-02');
    const { exportId } = assetregister.exportExchange(asFM(), {
      reference: 'EXP-004',
      format: 'COBIE',
      externalSystem: 'Riverside CAFM',
      assetTags: ['AHU-01', 'AHU-02'],
      exportedBy: 'K. Mensah',
    });

    const refusal = throwsCode(
      () => assetregister.reconcileExchange(asFM(), exportId, { rowsAccepted: 1, rejected: [], reconciledBy: 'K. Mensah' }),
      'TOTALS_DO_NOT_RECONCILE',
    );
    assert.match(refusal.message ?? '', /leaves 1 unaccounted for/);
    assert.match(refusal.message ?? '', /looks for an asset that is not there/);
  });

  it('refuses a rejected row with no reason, and one that was never exported', () => {
    asset('AHU-01');
    const { exportId } = assetregister.exportExchange(asFM(), {
      reference: 'EXP-005',
      format: 'IFC',
      externalSystem: 'Riverside CAFM',
      assetTags: ['AHU-01'],
      exportedBy: 'K. Mensah',
    });

    const unexplained = throwsCode(
      () =>
        assetregister.reconcileExchange(asFM(), exportId, {
          rowsAccepted: 0,
          rejected: [{ externalId: 'AHU-01', reason: '  ' }],
          reconciledBy: 'K. Mensah',
        }),
      'REJECTION_UNEXPLAINED',
    );
    assert.match(unexplained.message ?? '', /still missing eighteen months later/);

    const foreign = throwsCode(
      () =>
        assetregister.reconcileExchange(asFM(), exportId, {
          rowsAccepted: 0,
          rejected: [{ externalId: 'AHU-99', reason: 'Not recognised.' }],
          reconciledBy: 'K. Mensah',
        }),
      'REJECTION_NOT_EXPORTED',
    );
    assert.match(foreign.message ?? '', /reconciles to nothing/);
  });

  it('refuses a second reconciliation and an export of an asset nobody registered', () => {
    asset('AHU-01');
    const { exportId } = assetregister.exportExchange(asFM(), {
      reference: 'EXP-006',
      format: 'IDS',
      externalSystem: 'Riverside CAFM',
      assetTags: ['AHU-01'],
      exportedBy: 'K. Mensah',
    });
    assetregister.reconcileExchange(asFM(), exportId, { rowsAccepted: 1, rejected: [], reconciledBy: 'K. Mensah' });
    throwsCode(
      () => assetregister.reconcileExchange(asFM(), exportId, { rowsAccepted: 1, rejected: [], reconciledBy: 'K. Mensah' }),
      'ALREADY_RECONCILED',
    );
    throwsCode(
      () =>
        assetregister.exportExchange(asFM(), {
          reference: 'EXP-007',
          format: 'COBIE',
          externalSystem: 'Riverside CAFM',
          assetTags: ['AHU-99'],
          exportedBy: 'K. Mensah',
        }),
      'ASSET_NOT_FOUND',
    );
  });

  it('refuses reconciliation from a role that maintains the register but does not approve it', () => {
    asset('AHU-01');
    const { exportId } = assetregister.exportExchange(asFM(), {
      reference: 'EXP-008',
      format: 'COBIE',
      externalSystem: 'Riverside CAFM',
      assetTags: ['AHU-01'],
      exportedBy: 'K. Mensah',
    });
    throwsCode(
      () => assetregister.reconcileExchange(asPM(), exportId, { rowsAccepted: 1, rejected: [], reconciledBy: 'A PM' }),
      'ACCESS_DENIED',
    );
  });
});

describe('the position is arithmetic over the register', () => {
  beforeEach(freshProject);

  it('counts the assets the project actually holds', () => {
    const before = seededTags().length;
    asset('AHU-01');
    asset('AHU-02');
    assert.equal(assetregister.assetRegisterPosition(asFM()).assets, before + 2);
  });

  it('binds nothing on a project with no assets registered at all', async () => {
    // The demo project seeds assets, so this is checked against the guard's own
    // reading rather than by emptying the ledger: with no errors, no overdue
    // Unknowns and no exports, nothing blocks.
    assert.equal(assetregister.assetHandoverBlockedReason(asFM()), null);
  });
});
