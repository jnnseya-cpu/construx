import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { rejectsCode } from './helpers.ts';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import type { AIProviderAdapter, ProviderRequest, ProviderResponse } from '../src/ai/providers/types.ts';
import { bidFlow } from '../src/domain/bidflow.ts';
import { acceptPackProposal, proposePackPrice } from '../src/domain/bidrun.ts';
import * as structure from '../src/domain/structure.ts';
import * as tender from '../src/engines/tender.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { ingestFile, ingestedFiles, reclassifyFile } from '../src/evidence/pipeline.ts';
import { EvidenceStore, hashBytes } from '../src/evidence/store.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * From a pack of drawings to a price, in one run.
 *
 * Every piece existed and a person carried the work between them: a button per
 * drawing, a confirmation per reading, the package name retyped, a rate typed
 * against every measured line, then the preliminaries, the waste, the insurance,
 * the overhead and the profit, then the quotation. Four screens and around forty
 * fields for a £20,000 wall repair — and the verdict from the person paying for
 * it was the right one: nobody will use a construction OS that way.
 *
 * What this pins is the division of labour. The machine reads, measures, and
 * proposes a rate **out of this business's own committed estimates**. It writes
 * the readings, because a reading is evidence either way, and it writes nothing
 * else. One person, on one screen, accepts — and that single act confirms every
 * reading, writes the bill, prices it and draws up the quotation.
 */

let directory: string;
let store: EvidenceStore;
let platform: Platform;
let seed: SeedResult;
let projectId: string;
let asked: ProviderRequest[] = [];

/** Two sheets, and what a model reports off each. */
const SHEETS = [
  {
    filename: '25133-TDC-FN-ZZ-DR-S-1600.pdf',
    bytes: Buffer.from('%PDF-1.7 wall foundation detail', 'utf8'),
    items: [
      { description: 'Rake out and repoint in lime mortar', unit: 'm2', quantity: 86, sourceSheet: 'DR-S-1600', measurementRule: 'NRM2' },
      { description: 'Rebuild collapsed section in reclaimed stone', unit: 'm2', quantity: 12, sourceSheet: 'DR-S-1600', measurementRule: 'NRM2' },
    ],
  },
  {
    filename: '25133-TDC-FN-ZZ-DR-S-1601.pdf',
    bytes: Buffer.from('%PDF-1.7 coping detail', 'utf8'),
    items: [
      { description: 'Replace coping, bed and point', unit: 'm', quantity: 34, sourceSheet: 'DR-S-1601', measurementRule: 'NRM2' },
    ],
  },
];

/** A provider that can be handed a sheet, and answers with what is on it. */
function seeingStub(): AIProviderAdapter {
  return {
    name: 'GEMINI',
    capability: 'PERCEPTION',
    multimodal: true,
    transmits: true,
    estimateCostMinor: () => 40,
    healthy: () => true,
    async execute(request: ProviderRequest): Promise<ProviderResponse> {
      asked.push(request);
      // Which sheet it was shown, by the file it carries. A stub that answered
      // the same thing whatever it was given would pass this test while the run
      // read one drawing twice.
      const sheet = SHEETS.find((candidate) => request.media?.hash === hashBytes(candidate.bytes));
      return {
        provider: 'GEMINI',
        modelClass: 'perception-standard',
        output: { items: sheet?.items ?? [], omitted: [], scale: '1:20', discipline: 'STRUCTURES' },
        rawCostMinor: 40,
        latencyMs: 8,
        confidence: 0.88,
      };
    },
  };
}

const ctxFor = (who: string): EngineContext => platform.context(seed.users[who]!.auth, projectId, { source: 'WEB' });

/**
 * One estimate already in the record, so the run has a basis and a rate history
 * to propose from. This is the point of the whole design: what the platform
 * proposes is what this business has actually priced, not an index.
 */
async function priorEstimate(): Promise<void> {
  const qs = ctxFor('qs');
  const taken = await tender.runTakeoff(qs, {
    packageId: 'WALL-PRIOR',
    sources: [{ discipline: 'STRUCTURES', sheetId: 'PRIOR' }],
    costCodePrefix: 'PRIOR',
    measuredBy: 'PERSON',
    items: [
      { description: 'Rake out and repoint in lime mortar', unit: 'm2', quantity: 40 },
      { description: 'Rebuild collapsed section in reclaimed stone', unit: 'm2', quantity: 6 },
    ],
  });

  tender.buildEstimate(qs, {
    packageId: 'WALL-PRIOR',
    durationWeeks: 3,
    lines: [
      { boqItemId: taken.boqItemIds[0]!, description: 'Rake out and repoint in lime mortar', unit: 'm2', quantity: 40, labourRateMinor: 8_500, materialRateMinor: 1_200 },
      { boqItemId: taken.boqItemIds[1]!, description: 'Rebuild collapsed section in reclaimed stone', unit: 'm2', quantity: 6, labourRateMinor: 24_000, materialRateMinor: 9_000 },
    ],
    quantified: [{ head: 'WASTE', description: 'Skips and gate fees', unit: 'sum', quantity: 1, rateMinor: 45_000 }],
    insurance: { policies: [{ type: 'Contract works and liability', percentOfContractValue: 0.9 }] },
    exclusions: [{ head: 'PLANT', reason: 'Access from a tower scaffold provided by the client' }],
    margin: { overheadPercent: 8, profitPercent: 6 },
    basisOfEstimate: 'A previous churchyard wall, measured off the same kind of sheet.',
    assumptions: ['Uninterrupted access'],
  });
}

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'construx-bidrun-'));
  store = new EvidenceStore(directory);
  platform = new Platform(new AIOrchestrator({ perception: seeingStub() }), store);
  seed = await seedDemoProject(platform);

  const admin = seed.users.admin!.auth;
  const portfolioId = platform.ledger.listByTenant(seed.tenantId, 'Portfolio')[0]!.refId;
  projectId = structure.createProject(platform.context(admin, `${seed.tenantId}-governance`), {
    portfolioId,
    name: 'St Andrew’s church wall',
    sectorType: 'RMI',
    assetType: 'Boundary wall',
    location: { continentCode: 'EU', countryCode: 'GB', city: 'Rawtenstall' },
    contractValueMinor: 2_000_000,
    currency: 'GBP',
    plannedStart: '2026-02-02',
    plannedCompletion: '2026-04-30',
  }).projectId;

  structure.createScopePackage(platform.context(seed.users.pm!.auth, projectId), {
    name: 'Boundary wall repair',
    discipline: 'CIVILS',
    scopeOfWorks: 'Repoint, rebuild the collapsed section and replace the coping.',
    inclusions: ['Repointing in lime mortar'],
    exclusions: ['Anything beyond the churchyard boundary'],
    acceptanceCriteria: ['Accepted when the conservation officer signs it off'],
    estimatedValueMinor: 2_000_000,
    designResponsibility: 'CONTRACTOR',
  });
  structure.transitionPhase(platform.context(admin, projectId), { to: 'DESIGN', justification: 'Scope defined' });
  // The design gate asks for a maturity assessment before anything is priced,
  // and rightly: a bill measured off a drawing nobody has frozen is a bill
  // against a drawing that will change.
  structure.assessDesignMaturity(platform.context(seed.users.pm!.auth, projectId), {
    packageId: platform.ledger.list(projectId, 'ScopePackage')[0]!.refId,
    disciplineScores: [{ discipline: 'CIVILS', ribaStage: 4, completenessPercent: 95, frozen: true }],
    informationGaps: [],
    assessorNotes: 'The repair details are issued and priceable.',
  });
  structure.transitionPhase(platform.context(admin, projectId), { to: 'TENDER', justification: 'Pricing the repair' });

  await priorEstimate();
});

after(() => rmSync(directory, { recursive: true, force: true }));

/** File a sheet the way an upload does: claimed as evidence, stored, ingested. */
async function upload(sheet: (typeof SHEETS)[number]): Promise<string> {
  const hash = hashBytes(sheet.bytes);
  const ctx = ctxFor('qs');
  ctx.ledger.commit({
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    actor: { refType: 'User', refId: ctx.auth.actorId },
    source: 'WEB',
    correlationId: ctx.correlationId,
    eventType: 'EVIDENCE_REGISTERED',
    entity: { refType: 'EvidenceItem', refId: `ev-${hash.slice(-12)}` },
    nextState: {
      id: `ev-${hash.slice(-12)}`,
      type: 'DRAWING_FILE',
      hash,
      description: sheet.filename,
      linkedEntities: [],
      capturedAt: new Date().toISOString(),
    },
  });
  store.put(seed.tenantId, hash, sheet.bytes, 'application/pdf');
  await ingestFile(ctx, store, { hash, filename: sheet.filename });
  return hash;
}

describe('the run from an uploaded pack', () => {
  it('refuses to guess at a pack that is not there', async () => {
    await rejectsCode(() => proposePackPrice(ctxFor('qs'), store, { packageId: 'WALL' }), 'PACK_HAS_NO_DRAWING');
  });

  it('publishes an ingested file as the pipeline recorded it, nested', async () => {
    /*
     * The shape the console has to read, pinned.
     *
     * The register publishes `inspection`, `classification` and `extraction`.
     * Two screens read `file.kind`, which does not exist — it came back
     * `undefined` for every file, so the drawing row fell through to the text
     * path and the one button that measures a drawing never rendered, on the
     * screen holding the drawings. Nothing failed; a button was simply absent.
     */
    for (const sheet of SHEETS) await upload(sheet);
    const filed = ingestedFiles(ctxFor('qs'));

    assert.equal(filed.length, 2);
    for (const file of filed) {
      assert.equal(file.classification.kind, 'DRAWING', `${file.filename} was not classified as a drawing`);
      assert.equal(
        (file as unknown as { kind?: string }).kind,
        undefined,
        'an ingested file grew a flat `kind` — the console reads one of these two and they must not both exist',
      );
    }
  });

  it('reads a file again when the rules have moved on, and says what it used to be', async () => {
    /*
     * The trap under an append-only record. A classification is written when a
     * file is ingested, so a file filed before a rule existed keeps the answer
     * the old rules gave it — for ever. After the ISO 19650 reference rules
     * shipped, drawings already on a project stayed typed UNKNOWN: offered no
     * take-off, counted straight past by the pack run, and the only remedy was
     * to upload the pack again.
     */
    const filed = ingestedFiles(ctxFor('qs'));
    const drawing = filed[0]!;

    // Re-reading a file the rules already agree about writes nothing. An event
    // whose diff is empty records nothing, and the ledger refuses one.
    const unchanged = await reclassifyFile(ctxFor('qs'), store, drawing.ingestionId);
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.kind, 'DRAWING');
    assert.equal(unchanged.previousKind, 'DRAWING');

    await rejectsCode(() => reclassifyFile(ctxFor('qs'), store, 'not-a-file'), 'INGESTION_NOT_FOUND');
  });

  it('reads every drawing, measures it, and prices it off this business’s own record', async () => {
    asked = [];

    const proposal = await proposePackPrice(ctxFor('qs'), store, { packageId: 'WALL' });

    // Both sheets read, each once. A run that read one drawing twice would
    // double a quantity and look entirely normal doing it.
    assert.equal(proposal.read.length, 2);
    assert.equal(proposal.unread.length, 0);
    assert.equal(asked.length, 2);
    assert.equal(proposal.lines.length, 3);

    // The rate came out of the estimate this business already committed, and
    // says so in words an estimator can check.
    const repoint = proposal.lines.find((line) => line.description.startsWith('Rake out'))!;
    assert.equal(repoint.rate?.labourRateMinor, 8_500);
    assert.equal(repoint.rate?.materialRateMinor, 1_200);
    assert.equal(repoint.rate?.allInMinor, 9_700);
    assert.match(String(repoint.rate?.basis), /Median of 1 priced line/);
    assert.equal(repoint.rate?.confidence, 'THIN');

    // The line this business has never priced is not given a number. A plausible
    // guess here is how an estimate becomes confident and wrong.
    const coping = proposal.lines.find((line) => line.description.startsWith('Replace coping'))!;
    assert.equal(coping.rate, null);
    assert.match(String(coping.unpriced), /never priced this item/);
    assert.ok(proposal.outstanding.some((item) => /1 measured line has no rate/.test(item)));

    // And the heads and margin came from the last complete estimate rather than
    // being asked for again.
    assert.equal(proposal.basis?.durationWeeks, 3);
    assert.deepEqual(proposal.basis?.margin, { overheadPercent: 8, profitPercent: 6 });
    assert.equal(proposal.basis?.exclusions?.[0]?.head, 'PLANT');
    assert.ok(proposal.indicative && proposal.indicative.totalMinor > 0);
  });

  it('writes the readings and nothing else', async () => {
    // Against what the project already held, because the fixture's prior
    // estimate lives here too — the question is what the *run* wrote.
    const billBefore = platform.ledger.list(projectId, 'BoQItem').length;
    const estimatesBefore = platform.ledger.list(projectId, 'Estimate').length;

    await proposePackPrice(ctxFor('qs'), store, { packageId: 'WALL' });

    // No bill, no estimate, no quotation. A proposal is a proposal.
    assert.equal(platform.ledger.list(projectId, 'BoQItem').length, billBefore);
    assert.equal(platform.ledger.list(projectId, 'Estimate').length, estimatesBefore);
    // The readings are there, as drafts awaiting a person, because a reading is
    // evidence whether or not anybody acts on it.
    const drafts = platform.ledger.list(projectId, 'PerceptionDraft').map((record) => record.state);
    assert.ok(drafts.filter((draft) => draft.task === 'DRAWING_TAKEOFF' && draft.status === 'DRAFT').length >= 2);
  });

  it('turns one acceptance into the bill, the estimate and the quotation', async () => {
    const qs = ctxFor('qs');
    const proposal = await proposePackPrice(qs, store, { packageId: 'WALL' });
    const spentOnReading = asked.length;

    const accepted = await acceptPackProposal(platform, qs, seed.users.qs!.auth, {
      packageId: 'WALL',
      costCodePrefix: 'WALL',
      lines: proposal.lines.map((line) => ({
        draftId: line.draftId,
        index: line.index,
        // Every proposed rate taken as offered, and the one the record could
        // not answer priced by the person — which is the division of labour
        // this whole design is for.
        labourRateMinor: line.rate?.labourRateMinor ?? 6_000,
        materialRateMinor: line.rate?.materialRateMinor ?? 4_500,
      })),
      estimate: {
        durationWeeks: proposal.basis!.durationWeeks!,
        basisOfEstimate: 'Measured off the issued sheets; rates from our own committed estimates.',
        assumptions: ['Uninterrupted access to the churchyard'],
        quantified: proposal.basis!.quantified,
        insurance: proposal.basis!.insurance,
        exclusions: proposal.basis!.exclusions,
        margin: proposal.basis!.margin!,
      },
      quotation: {
        clientName: 'St Andrew’s Parochial Church Council',
        validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
        paymentTerms: '30 days from invoice',
      },
    });

    assert.equal(accepted.boqItemIds.length, 3);
    assert.ok(accepted.totalMinor > 0);
    assert.ok(accepted.quotationId, 'the run stopped short of the quotation');
    assert.equal(accepted.quotationNumberPending, true);

    // Confirming a reading calls no provider. It used to run a second model
    // over items that model had itself just extracted — a charge for a reading
    // nobody performed, on every confirmation.
    assert.equal(asked.length, spentOnReading, 'confirming the readings called a provider again');

    // The bill carries the confidence of the reading it came from, not a fresh
    // number and not a perfect one: a person accepting a machine's measurement
    // does not make the machine surer of it.
    const item = platform.ledger.list(projectId, 'BoQItem').find((record) => record.refId === accepted.boqItemIds[0])!.state;
    assert.equal(item.measuredBy, 'MODEL_CONFIRMED');
    assert.equal(item.confidenceScore, 0.88);

    // And every priced line is traceably the line that came off the sheet.
    const estimate = platform.ledger.list(projectId, 'Estimate').at(-1)!.state;
    const lines = estimate.lines as Array<{ boqItemId?: string }>;
    assert.equal(lines.length, 3);
    assert.ok(lines.every((line) => accepted.boqItemIds.includes(String(line.boqItemId))));
  });
});


describe('where the job is, and the one thing to do next', () => {
  /*
   * The complaint this answers, in the words it was made in: "the flow is not
   * working everywhere in this OS". Every screen was right on its own, and
   * walking one enquiry through four of them produced three truthful refusals
   * in a row with nothing anywhere saying that this job does not need a
   * compliance matrix at all — it needs a price.
   */
  it('names the road from what the enquiry asks for, not from a preference', () => {
    const flow = bidFlow(platform, ctxFor('qs'));
    // No invitation asking for more than a price is recorded here, so this is a
    // quotation. The submission steps are present and marked not needed, which
    // is a statement rather than a silence: somebody looking for the compliance
    // matrix is told this job does not want one.
    assert.equal(flow.road, 'PRICE');
    const matrix = flow.steps.find((step) => step.id === 'MATRIX')!;
    assert.equal(matrix.state, 'NOT_NEEDED');
    assert.match(matrix.detail, /asks only for a price/);
  });

  it('reads every step from the record rather than from a checklist', () => {
    const flow = bidFlow(platform, ctxFor('qs'));
    const state = (id: string): string => flow.steps.find((step) => step.id === id)!.state;

    // By this point in the file the pack is filed, measured, priced and quoted.
    assert.equal(state('PACK_FILED'), 'DONE');
    assert.equal(state('MEASURED'), 'DONE');
    assert.equal(state('ESTIMATED'), 'DONE');
    assert.equal(state('QUOTED'), 'DONE');
    // And the one thing outstanding is the one step that is a legal act rather
    // than arithmetic.
    assert.equal(state('ISSUED'), 'READY');
    assert.equal(flow.nowDo?.id, 'ISSUED');
    assert.equal(flow.nowDo?.screen, 'documents');
    assert.match(flow.summary, /Next: issue it/);
  });

  it('names what to do, not only what is missing', () => {
    const flow = bidFlow(platform, ctxFor('qs'));
    for (const step of flow.steps) {
      if (step.state === 'READY' || step.state === 'BLOCKED') {
        assert.ok(step.next, `${step.id} says it is outstanding and does not say what to do about it`);
        assert.ok(step.next!.length > 20, `${step.id}'s remedy is too short to be a remedy: ${step.next}`);
      }
    }
  });

  it('has nothing to do on a project where nothing has started, and says what to start with', () => {
    // A fresh project: the road exists, the first step is the only one that can
    // be taken, and everything after it is waiting rather than broken.
    const admin = seed.users.admin!.auth;
    const portfolioId = platform.ledger.listByTenant(seed.tenantId, 'Portfolio')[0]!.refId;
    const empty = structure.createProject(platform.context(admin, `${seed.tenantId}-governance`), {
      portfolioId,
      name: 'Nothing has happened here',
      sectorType: 'RMI',
      assetType: 'Boundary wall',
      location: { continentCode: 'EU', countryCode: 'GB', city: 'Rawtenstall' },
      contractValueMinor: 500_000,
      currency: 'GBP',
      plannedStart: '2026-05-04',
      plannedCompletion: '2026-06-01',
    }).projectId;

    const flow = bidFlow(platform, platform.context(seed.users.qs!.auth, empty, { source: 'WEB' }));
    assert.equal(flow.nowDo?.id, 'PACK_FILED');
    assert.match(String(flow.nowDo?.next), /Upload the drawings/);
    assert.equal(flow.steps.find((step) => step.id === 'MEASURED')!.state, 'BLOCKED');
  });
});
