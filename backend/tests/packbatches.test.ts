import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import type { AIProviderAdapter, ProviderRequest, ProviderResponse } from '../src/ai/providers/types.ts';
import { ROUTES } from '../src/api/routes.ts';
import * as structure from '../src/domain/structure.ts';
import * as tenderintake from '../src/domain/tenderintake.ts';
import { packBatches, readTenderPack } from '../src/domain/tenderreading.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { EvidenceStore, hashBytes } from '../src/evidence/store.ts';
import { ingestFile } from '../src/evidence/pipeline.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { docxOf, paragraph } from './fixtures/zip.ts';

/**
 * A pack too large for one reading, read in batches: whole documents only, each
 * batch quoted and sent on its own, and a document larger than any batch named
 * to be read from its own row.
 */

let directory: string;
let store: EvidenceStore;
let platform: Platform;
let seed: SeedResult;
let projectId: string;
const requests: ProviderRequest[] = [];

const reasoning: AIProviderAdapter = {
  name: 'OPENAI',
  capability: 'REASONING',
  multimodal: false,
  transmits: true,
  estimateCostMinor: () => 25,
  healthy: () => true,
  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    requests.push(request);
    return {
      provider: 'OPENAI',
      modelClass: 'reasoning-standard',
      output: { requirements: [{ reference: 'Q1', category: 'TECHNICAL', requirement: 'Describe the method', mandatory: false, evidenceRequired: 'An answer' }] },
      rawCostMinor: 25,
      latencyMs: 5,
      confidence: 0.9,
    };
  },
};

const ctx = (): EngineContext => platform.context(seed.users.qs!.auth, projectId, { correlationId: 'batch-test' });

/**
 * Text that reads like a document to the scanner: varied words, not one phrase
 * repeated — a repeated phrase compresses like a zip bomb and is quarantined,
 * which is the scanner doing its job.
 */
function prose(marker: string, length: number): string {
  let seed = marker.length * 7919;
  const next = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const parts: string[] = [marker];
  let size = marker.length;
  while (size < length) {
    const word = Array.from({ length: 3 + Math.floor(next() * 7) }, () => String.fromCharCode(97 + Math.floor(next() * 26))).join('');
    parts.push(word);
    size += word.length + 1;
  }
  return `${parts.join(' ').slice(0, length - marker.length - 1)} ${marker}`;
}

async function file(name: string, words: string, length: number): Promise<void> {
  const text = prose(words, length);
  const bytes = docxOf(paragraph(text));
  const hash = hashBytes(bytes);
  tenderintake.recordTenderDocument(ctx(), { hash, filename: name });
  await store.put(seed.tenantId, hash, bytes, 'application/zip');
  await ingestFile(ctx(), store, { hash, filename: name });
}

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'construx-batch-'));
  store = new EvidenceStore(directory);
  platform = new Platform(new AIOrchestrator({ reasoning }), store);
  seed = await seedDemoProject(platform);
  const admin = seed.users.admin!.auth;
  const portfolioId = platform.ledger.listByTenant(seed.tenantId, 'Portfolio')[0]!.refId;
  projectId = structure.createProject(platform.context(admin, `${seed.tenantId}-governance`), {
    portfolioId,
    name: 'A very large tender',
    sectorType: 'TRANSPORT',
    assetType: 'Depot',
    location: { continentCode: 'EU', countryCode: 'GB', city: 'Leeds' },
    contractValueMinor: 0,
    currency: 'GBP',
    plannedStart: '2027-01-18',
    plannedCompletion: '2027-04-09',
  }).projectId;
  const pm = platform.context(seed.users.pm!.auth, projectId);
  const { packageId } = structure.createScopePackage(pm, {
    name: 'Depot',
    discipline: 'CIVILS',
    scopeOfWorks: 'Depot works.',
    inclusions: ['All'],
    exclusions: [],
    acceptanceCriteria: ['Sign-off'],
    estimatedValueMinor: 1_000_000,
    designResponsibility: 'CLIENT',
  });
  structure.transitionPhase(platform.context(admin, projectId), { to: 'DESIGN', justification: 'Scope defined' });
  structure.assessDesignMaturity(pm, {
    packageId,
    disciplineScores: [{ discipline: 'CIVILS', ribaStage: 4, completenessPercent: 90, frozen: true }],
    informationGaps: [],
    assessorNotes: 'Priceable.',
  });
  structure.transitionPhase(platform.context(admin, projectId), { to: 'TENDER', justification: 'Priceable' });
  await file('Volume 1 - Instructions.docx', 'alpha instructions', 250_000);
  await file('Volume 2 - Specification.docx', 'bravo specification', 250_000);
});

after(() => rmSync(directory, { recursive: true, force: true }));

describe('a pack too large for one reading', () => {
  it('is split into batches of whole documents, in the order the pack is read', () => {
    const split = packBatches(ctx());
    assert.equal(split.needed, true);
    assert.deepEqual(
      split.batches.map((batch) => batch.files.map((entry) => entry.filename)),
      [['Volume 1 - Instructions.docx'], ['Volume 2 - Specification.docx']],
    );
    assert.deepEqual(split.oversize, []);
  });

  it('refuses one reading of the whole pack, saying how many batches it takes', async () => {
    await assert.rejects(readTenderPack(ctx()), (error: Error & { code?: string }) => {
      assert.equal(error.code, 'PACK_TOO_LARGE');
      assert.match(error.message, /Read it in 2 batches/);
      return true;
    });
  });

  it('reads one batch: only its documents are sent, and the draft says which batch it is', async () => {
    const before = requests.length;
    const draft = await readTenderPack(ctx(), { batch: 2, today: '2026-11-16' });
    assert.equal(requests.length, before + 1);
    const sent = JSON.stringify(requests.at(-1));
    assert.match(sent, /bravo specification/);
    assert.doesNotMatch(sent, /alpha instructions/);
    const state = platform.ledger.require({ refType: 'PerceptionDraft', refId: draft.draftId }).state;
    assert.match(String(state.textLabel), /^Batch 2 of 2/);
    await assert.rejects(readTenderPack(ctx(), { batch: 3 }), (error: Error & { code?: string }) => error.code === 'BATCH_NOT_FOUND');
  });

  it('quotes a batch from that batch alone', () => {
    const route = ROUTES.find((entry) => entry.method === 'POST' && entry.pattern === '/v1/projects/:projectId/tender/read-pack')!;
    const batchText = route.ai!.quoteInputText!(ctx(), new URLSearchParams('batch=1'))!;
    assert.match(batchText, /alpha instructions/);
    assert.doesNotMatch(batchText, /bravo specification/);
    assert.ok(batchText.length < 400_000);
  });

  it('names a document too large for any batch, to be read from its own row', async () => {
    await file('Volume 3 - Drawings schedule.docx', 'charlie schedule', 450_000);
    const split = packBatches(ctx());
    assert.deepEqual(split.oversize.map((entry) => entry.filename), ['Volume 3 - Drawings schedule.docx']);
    await assert.rejects(readTenderPack(ctx()), (error: Error) => /too large for any batch: read it from its own row/.test(error.message));
  });
});
