import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { rejectsCode, throwsCode } from './helpers.ts';
import { createFederationSet } from '../src/domain/coordination.ts';
import * as structure from '../src/domain/structure.ts';
import { EvidenceStore, hashBytes } from '../src/evidence/store.ts';
import { compareModels, ingestModel, readModel } from '../src/engines/bim.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { diffIfc, IfcParseError, parseIfc } from '../src/engines/ifc.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { sampleIfc } from './fixtures/ifc.ts';

/**
 * Reading an IFC, and telling two revisions of it apart.
 *
 * The property that carries the weight is the last one: the same model
 * exported again, with every instance renumbered, reads as the same geometry.
 * Without it a revision comparison would call every re-export a change and
 * be worth nothing.
 */

describe('what an IFC says about itself', () => {
  const model = parseIfc(sampleIfc());

  it('reads the header: schema, view definition, authoring application', () => {
    assert.equal(model.schema, 'IFC4');
    assert.equal(model.viewDefinition, 'ReferenceView_V1.2');
    assert.equal(model.authoringApplication, 'Archicad 27');
    assert.equal(model.timestamp, '2026-08-30T10:15:00');
  });

  it('reads the project, its spatial structure and the length unit', () => {
    assert.equal(model.projectName, 'Inlet works');
    assert.equal(model.siteName, 'Ashworth WTW');
    assert.equal(model.buildingName, 'Inlet building');
    assert.equal(model.lengthUnit, 'mm');
    assert.deepEqual(
      model.storeys.map((storey) => [storey.name, storey.elevation, storey.elements]),
      [
        ['Ground floor', 0, 4],
        ['First floor', 3600, 1],
      ],
    );
  });

  it('counts elements as the physical things, not the spaces, openings, types or relationships', () => {
    assert.equal(model.elementCount, 5);
    assert.deepEqual(model.elementsByType, { IFCWALL: 2, IFCWALLSTANDARDCASE: 1, IFCSLAB: 1, IFCCOLUMN: 1 });
    assert.equal(model.spaces, 1);
    assert.equal(model.propertySets, 1);
    assert.equal(model.elementsWithGeometry, 5);
    assert.ok(model.entityCount > 40);
  });

  it('puts each element on its storey with its GlobalId and name', () => {
    const wall = model.elements.find((element) => element.name === 'W-03')!;
    assert.equal(wall.globalId, '1a2b3c4d5e6f7g8h9i0j3k');
    assert.equal(wall.storey, 'First floor');
    assert.equal(wall.type, 'IFCWALLSTANDARDCASE');
  });

  it('reads a metre-unit file as metres', () => {
    assert.equal(parseIfc(sampleIfc({ unit: 'METRE' })).lengthUnit, 'm');
  });
});

describe('the geometry hash', () => {
  const original = parseIfc(sampleIfc());

  it('is the same for the same model exported again with every instance renumbered', () => {
    const reexport = parseIfc(sampleIfc({ renumber: 1000 }));
    assert.equal(reexport.geometryHash, original.geometryHash);
    assert.deepEqual(
      reexport.elements.map((element) => element.geometryHash),
      original.elements.map((element) => element.geometryHash),
    );
  });

  it('changes for the one element that moved, and for no other', () => {
    const moved = parseIfc(sampleIfc({ moveWall: true }));
    assert.notEqual(moved.geometryHash, original.geometryHash);
    const differing = moved.elements.filter(
      (element) => element.geometryHash !== original.elements.find((was) => was.globalId === element.globalId)!.geometryHash,
    );
    assert.deepEqual(differing.map((element) => element.name), ['W-01']);
  });

  it('does not change when an element is only renamed', () => {
    assert.equal(parseIfc(sampleIfc({ renameWall: true })).geometryHash, original.geometryHash);
  });

  it('two walls sharing one solid but standing in different places hash differently', () => {
    const [one, two] = ['W-01', 'W-02'].map((name) => original.elements.find((element) => element.name === name)!);
    assert.notEqual(one!.geometryHash, two!.geometryHash);
  });
});

describe('two revisions compared', () => {
  const before = parseIfc(sampleIfc());

  it('a re-export is the same geometry', () => {
    const diff = diffIfc(before, parseIfc(sampleIfc({ renumber: 500 })));
    assert.equal(diff.sameGeometry, true);
    assert.equal(diff.unchanged, 5);
    assert.deepEqual([diff.added, diff.removed, diff.changed, diff.renamed], [[], [], [], []]);
    assert.match(diff.summary, /^Same geometry: 5 elements unchanged\.$/);
  });

  it('names what was added, removed, moved and renamed, by GlobalId', () => {
    const diff = diffIfc(before, parseIfc(sampleIfc({ moveWall: true, renameWall: true, dropSlab: true, addBeam: true })));
    assert.equal(diff.sameGeometry, false);
    assert.deepEqual(diff.added.map((element) => [element.type, element.name, element.storey]), [['IFCBEAM', 'B-01', 'First floor']]);
    assert.deepEqual(diff.removed.map((element) => element.name), ['S-01']);
    assert.deepEqual(diff.changed.map((element) => element.globalId), ['1a2b3c4d5e6f7g8h9i0j1k']);
    assert.deepEqual(diff.renamed, [{ globalId: '1a2b3c4d5e6f7g8h9i0j1k', type: 'IFCWALL', from: 'W-01', to: 'W-01 renamed' }]);
    assert.equal(diff.unchanged, 3);
    assert.deepEqual(diff.byType.IFCSLAB, { added: 0, removed: 1, changed: 0 });
    assert.match(diff.summary, /1 element added, 1 element removed, 1 element moved or reshaped, 3 unchanged, 1 element renamed\./);
  });
});

/**
 * A ZIP written by hand: local headers, a central directory and the end record,
 * so the reader's preferred path is exercised. `descriptor` writes zero sizes
 * into the local header the way an archiver streaming its output does, leaving
 * the central directory as the only place the sizes are stated.
 */
function zipOf(entries: Array<{ name: string; data: Buffer; stored?: boolean }>, options: { descriptor?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const compressed = entry.stored ? entry.data : deflateRawSync(entry.data);
    const name = Buffer.from(entry.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(options.descriptor ? 8 : 0, 6);
    local.writeUInt16LE(entry.stored ? 0 : 8, 8);
    local.writeUInt32LE(options.descriptor ? 0 : compressed.length, 18);
    local.writeUInt32LE(options.descriptor ? 0 : entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, compressed);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(entry.stored ? 0 : 8, 10);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += 30 + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

describe('an .ifczip is the same file in a container', () => {
  it('reads the .ifc entry out of the container and says which entry it read', () => {
    const plain = parseIfc(sampleIfc());
    const zipped = parseIfc(zipOf([{ name: 'model/Ashworth-STR.ifc', data: sampleIfc() }]));
    assert.equal(zipped.container, 'IFCZIP');
    assert.equal(zipped.containerEntry, 'model/Ashworth-STR.ifc');
    assert.equal(plain.container, 'STEP');
    assert.equal(zipped.elementCount, plain.elementCount);
    assert.equal(zipped.geometryHash, plain.geometryHash, 'the same model hashes the same however it is wrapped');
  });

  it('takes the sizes from the central directory when the local header defers them, and reads a stored entry', () => {
    assert.equal(parseIfc(zipOf([{ name: 'a.ifc', data: sampleIfc() }], { descriptor: true })).elementCount, 5);
    assert.equal(parseIfc(zipOf([{ name: 'a.ifc', data: sampleIfc(), stored: true }])).elementCount, 5);
  });

  it('prefers the .ifc entry over anything else packed beside it', () => {
    const zipped = parseIfc(zipOf([{ name: 'readme.txt', data: Buffer.from('exported 3 March') }, { name: 'a.ifc', data: sampleIfc() }]));
    assert.equal(zipped.containerEntry, 'a.ifc');
  });

  it('refuses an empty container, and ifcXML inside one, by name', () => {
    assert.throws(() => parseIfc(zipOf([])), (error: unknown) => error instanceof IfcParseError && error.code === 'IFC_ZIP_EMPTY');
    assert.throws(
      () => parseIfc(zipOf([{ name: 'a.ifcxml', data: Buffer.from('<?xml version="1.0"?><ifcXML/>') }])),
      (error: unknown) => error instanceof IfcParseError && error.code === 'IFC_XML_NOT_READ',
    );
  });
});

describe('what is refused', () => {
  it('a file that is not a STEP physical file, and ifcXML by its own name', () => {
    assert.throws(() => parseIfc(Buffer.from('<?xml version="1.0"?><ifcXML/>')), (error: unknown) => error instanceof IfcParseError && error.code === 'IFC_XML_NOT_READ');
    assert.throws(() => parseIfc(Buffer.from('%PDF-1.7 not a model')), (error: unknown) => error instanceof IfcParseError && error.code === 'IFC_NOT_STEP');
  });

  it('a header with nothing after it', () => {
    assert.throws(
      () => parseIfc(Buffer.from("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nEND-ISO-10303-21;")),
      (error: unknown) => error instanceof IfcParseError && error.code === 'IFC_NO_DATA',
    );
  });

  it('a statement that is not an instance is skipped and counted, not fatal', () => {
    const text = sampleIfc().toString('latin1').replace('DATA;', 'DATA;\nthis is not an instance;');
    const model = parseIfc(Buffer.from(text, 'latin1'));
    assert.equal(model.elementCount, 5);
    assert.match(model.warnings[0] ?? '', /1 statement in the data section could not be read/);
  });
});

/**
 * The same reading, through the platform: a model is ingested on what was
 * declared, its file is supplied, and reading it puts what the file says on
 * the record — beside the declaration where the two disagree. Two read
 * revisions are compared from the files the platform holds, and a federation
 * set is refused where the declared unit is not the one the file carries.
 */
describe('reading a held model onto its record', () => {
  let directory: string;
  let store: EvidenceStore;
  let platform: Platform;
  let seed: SeedResult;
  let projectId: string;
  const ctxFor = (who: string): EngineContext => platform.context(seed.users[who]!.auth, projectId, { correlationId: 'ifc-test' });

  const ORIGINAL = sampleIfc();
  const REVISED = sampleIfc({ moveWall: true, addBeam: true, renumber: 300 });
  let originalId = '';
  let revisedId = '';

  before(async () => {
    directory = mkdtempSync(join(tmpdir(), 'construx-ifc-'));
    store = new EvidenceStore(directory);
    platform = new Platform(undefined, store);
    seed = await seedDemoProject(platform);
    // A project in DESIGN, where the BIM engine is in contract; the seeded one
    // is in OPERATIONS, where ingestion is refused by the engine phase gate.
    const admin = seed.users.admin!.auth;
    const portfolioId = platform.ledger.listByTenant(seed.tenantId, 'Portfolio')[0]!.refId;
    projectId = structure.createProject(platform.context(admin, `${seed.tenantId}-governance`), {
      portfolioId,
      name: 'IFC fixture',
      sectorType: 'UTILITIES',
      assetType: 'Treatment works',
      location: { continentCode: 'EU', countryCode: 'GB', city: 'Leeds' },
      contractValueMinor: 50_000_000,
      currency: 'GBP',
      plannedStart: '2026-01-05',
      plannedCompletion: '2027-01-05',
    }).projectId;
    structure.createScopePackage(platform.context(seed.users.pm!.auth, projectId), {
      name: 'Inlet works',
      discipline: 'CIVIL',
      scopeOfWorks: 'Construct the inlet works including screens and flow control.',
      inclusions: ['Screens'],
      exclusions: ['Process mechanical'],
      acceptanceCriteria: ['Witnessed flow test'],
      estimatedValueMinor: 20_000_000,
      designResponsibility: 'CONTRACTOR',
    });
    structure.transitionPhase(platform.context(admin, projectId), { to: 'DESIGN', justification: 'Scope defined; design engines are applicable from here.' });

    originalId = (await ingestModel(ctxFor('bim'), { fileHash: hashBytes(ORIGINAL), format: 'IFC', discipline: 'ARCHITECTURE', lod: 300, elementCount: 6 })).modelId;
    revisedId = (await ingestModel(ctxFor('bim'), { fileHash: hashBytes(REVISED), format: 'IFC', discipline: 'ARCHITECTURE', lod: 300, elementCount: 6 })).modelId;
  });

  after(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('refuses to read a model whose file the platform does not hold, and says the count is a declaration', async () => {
    const error = await rejectsCode(() => readModel(ctxFor('bim'), store, { modelId: originalId }), 'MODEL_FILE_NOT_HELD');
    assert.match(error.message ?? '', /what was declared, not what was read/);
  });

  it('reads the held file onto the record, keeping the declared count beside the one read', async () => {
    store.put(seed.tenantId, hashBytes(ORIGINAL), ORIGINAL, 'application/x-step');
    const result = await readModel(ctxFor('bim'), store, { modelId: originalId });
    assert.equal(result.reading.schema, 'IFC4');
    assert.equal(result.reading.elementCount, 5);
    assert.equal(result.declaredElementCount, 6, 'six were declared; five are in the file');
    assert.equal(result.reading.lengthUnit, 'mm');
    assert.equal(result.reading.storeys.length, 2);
    assert.equal(result.reading.readBy, seed.users.bim!.id);

    const model = platform.ledger.require({ refType: 'Model', refId: originalId });
    assert.equal(model.state.elementCount, 5);
    assert.equal(model.state.declaredElementCount, 6);
    assert.equal((model.state.read as { geometryHash: string }).geometryHash, parseIfc(ORIGINAL).geometryHash);
    assert.equal('elements' in (model.state.read as object), false, 'the per-element list is not put on the ledger');
  });

  it('refuses a proprietary format rather than pretending to read it', async () => {
    const rvt = await ingestModel(ctxFor('bim'), { fileHash: hashBytes(Buffer.from('binary')), format: 'RVT', discipline: 'STRUCTURE', lod: 300, elementCount: 10 });
    store.put(seed.tenantId, hashBytes(Buffer.from('binary')), Buffer.from('binary'), 'application/octet-stream');
    await rejectsCode(() => readModel(ctxFor('bim'), store, { modelId: rvt.modelId }), 'MODEL_FORMAT_OPAQUE');
  });

  it('refuses a file that is not a STEP physical file, by name', async () => {
    const xml = Buffer.from('<?xml version="1.0"?><ifcXML/>');
    const bad = await ingestModel(ctxFor('bim'), { fileHash: hashBytes(xml), format: 'IFC', discipline: 'MEP', lod: 200, elementCount: 1 });
    store.put(seed.tenantId, hashBytes(xml), xml, 'application/x-step');
    // ifcXML is refused by its own name, so the person knows which export to ask for.
    await rejectsCode(() => readModel(ctxFor('bim'), store, { modelId: bad.modelId }), 'IFC_XML_NOT_READ');
  });

  it('compares two held revisions from their files, base first', async () => {
    store.put(seed.tenantId, hashBytes(REVISED), REVISED, 'application/x-step');
    await readModel(ctxFor('bim'), store, { modelId: revisedId });
    const result = await compareModels(ctxFor('designer'), store, { modelId: revisedId, baseModelId: originalId });
    assert.equal(result.base.elementCount, 5);
    assert.equal(result.model.elementCount, 6);
    assert.deepEqual(result.diff.added.map((entry) => entry.name), ['B-01']);
    assert.deepEqual(result.diff.changed.map((entry) => entry.name), ['W-01']);
    assert.equal(result.diff.removed.length, 0);
    assert.equal(result.diff.unchanged, 4);
    await rejectsCode(() => compareModels(ctxFor('designer'), store, { modelId: originalId, baseModelId: originalId }), 'MODEL_SAME');
  });

  it('holds a federation to the unit the file carries, not only to the one declared', () => {
    const federate = (units: 'METRES' | 'MILLIMETRES') =>
      createFederationSet(ctxFor('bim'), {
        reference: `FED-${units}`,
        models: [
          { modelId: originalId, discipline: 'ARCHITECTURE', revision: 'A', fileHash: hashBytes(ORIGINAL), units, coordinateSystem: 'OSGB36' },
          { modelId: revisedId, discipline: 'ARCHITECTURE', revision: 'B', fileHash: hashBytes(REVISED), units, coordinateSystem: 'OSGB36' },
        ],
      });
    const error = throwsCode(() => federate('METRES'), 'UNIT_DECLARATION_MISMATCH');
    assert.match(error.message ?? '', /declared in metres/i);
    assert.match(error.message ?? '', /file says millimetres/i);
    assert.equal(federate('MILLIMETRES').models, 2);
  });
});
