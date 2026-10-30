import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import type { AIProviderAdapter, ProviderRequest, ProviderResponse } from '../src/ai/providers/types.ts';
import { EvidenceStore, hashBytes } from '../src/evidence/store.ts';
import { ingestFile } from '../src/evidence/pipeline.ts';
import { docxOf, paragraph } from './fixtures/zip.ts';
import * as structure from '../src/domain/structure.ts';
import * as tenderintel from '../src/domain/tenderintel.ts';
import { checkClarificationAgainstPack } from '../src/domain/tenderpackcheck.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { config } from '../src/config.ts';

/**
 * Checking a clarification against the tender pack before it is sent.
 *
 * Raising a clarification is the cheap half; the valuable half is catching the
 * one the documents already answer. These pin the three things that make the
 * check safe to rely on: it says NO_PACK rather than guessing when nothing is
 * ingested, it returns the citing passage when the pack answers the question,
 * and it reports a genuine gap as a gap. The model's verdict is stubbed — what
 * is under test is the engine around it, not the model.
 */

let directory: string;
let store: EvidenceStore;
let platform: Platform;
let seed: SeedResult;

/** The model's verdict, set per test; the stub returns whatever is here. */
let stubOutput: Record<string, unknown> = {};
function reasoningStub(): AIProviderAdapter {
  return {
    name: 'OPENAI',
    capability: 'REASONING',
    multimodal: false,
    transmits: true,
    estimateCostMinor: () => 25,
    healthy: () => true,
    async execute(_request: ProviderRequest): Promise<ProviderResponse> {
      return { provider: 'OPENAI', modelClass: 'reasoning-standard', output: stubOutput, rawCostMinor: 25, latencyMs: 6, confidence: 0.9 };
    },
  };
}

const qs = (): EngineContext => platform.context(seed.users.qs!.auth, seed.projectId, { correlationId: 'packcheck-test' });

function registerEvidenceFor(ctx: EngineContext, hash: string, type: string): void {
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
      type,
      hash,
      description: 'pack-check fixture',
      linkedEntities: [],
      capturedAt: new Date().toISOString(),
      capturedBy: ctx.auth.actorId,
    },
  });
}

async function ingestDoc(bytes: Buffer, filename: string): Promise<void> {
  const hash = hashBytes(bytes);
  registerEvidenceFor(qs(), hash, 'TENDER_DOCUMENT');
  await store.put(seed.tenantId, hash, bytes, 'application/zip');
  await ingestFile(qs(), store, { hash, filename });
}

async function build(): Promise<void> {
  platform = new Platform(new AIOrchestrator({ reasoning: reasoningStub() }), store);
  seed = await seedDemoProject(platform);
  // PROCUREMENT_AWARD is gated to TENDER/CONSTRUCTION; the demo finishes in
  // OPERATIONS, so a governed regression puts it where the acts are writable.
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'TENDER',
    justification: 'Reopened to raise and check tender clarifications',
  });
}

function raise(subject: string, question: string): string {
  return tenderintel.raiseTenderClarification(qs(), {
    side: 'CLIENT',
    subject,
    question,
    links: { drawing: 'R4780' },
  }).clarificationId;
}

// A clarification and the tender pack are COMMERCIAL_L3, so the check only runs
// on a provider cleared for that — which is correct, and is why production
// refuses it without one. The test grants the stub that clearance and restores
// it after, the way the sensitivity-routing suite does.
let previousDefaultClearance: string;

before(() => {
  directory = mkdtempSync(join(tmpdir(), 'construx-packcheck-'));
  store = new EvidenceStore(directory);
  previousDefaultClearance = config.ai.defaultClearance;
  (config.ai as { defaultClearance: string }).defaultClearance = 'COMMERCIAL_L3';
});

after(() => {
  rmSync(directory, { recursive: true, force: true });
  (config.ai as { defaultClearance: string }).defaultClearance = previousDefaultClearance;
});

describe('clarification pack-check · nothing ingested', () => {
  before(async () => {
    await build();
  });

  it('returns NO_PACK rather than guessing when no document carries text', async () => {
    const id = raise('Foundations', 'Confirm the foundation design below DPC.');
    const res = await checkClarificationAgainstPack(qs(), { clarificationId: id });
    assert.equal(res.verdict, 'NO_PACK');
    assert.deepEqual(res.documentsSearched, []);
    assert.equal(res.citation, undefined);
  });
});

describe('clarification pack-check · against an ingested pack', () => {
  before(async () => {
    await build();
    await ingestDoc(
      docxOf(
        paragraph('PRICING SCHEDULE — 96 RAILWAY LANE SOUTH') +
          paragraph(
            'Sub-structure: Excavation for the strip foundations. Construction of the strip foundations in-line with ' +
              'the structural engineers report and construction drawings contained within the Tender Pack. The contractor ' +
              'is to carry out their own site investigation to determine the nature of the foul and surface water drainage.',
          ),
      ),
      'Appendix B pricing schedule.docx',
    );
  });

  it('returns ANSWERED, naming the document and quoting the passage, when the pack answers it', async () => {
    stubOutput = {
      answered: true,
      documentLabel: 'Appendix B pricing schedule.docx',
      passage: 'Construction of the strip foundations in-line with the structural engineers report',
      reasoning: 'The pricing schedule names the strip foundations and points to the SE report for the design.',
    };
    const id = raise('Foundations', 'Confirm the foundation type and design below DPC.');
    const res = await checkClarificationAgainstPack(qs(), { clarificationId: id });
    assert.equal(res.verdict, 'ANSWERED');
    assert.ok(res.citation, 'an answered verdict carries the citation');
    assert.match(res.citation!.passage, /strip foundations/);
    assert.equal(res.confidence, 0.9);
    assert.ok(res.documentsSearched.length >= 1, 'it names the documents it searched');
  });

  it('returns GAP, with no citation, when the pack does not answer it', async () => {
    stubOutput = { answered: false, reasoning: 'Nothing in the documents addresses the asbestos sampling methodology.' };
    const id = raise('Asbestos', 'Confirm the required asbestos sampling methodology.');
    const res = await checkClarificationAgainstPack(qs(), { clarificationId: id });
    assert.equal(res.verdict, 'GAP');
    assert.equal(res.citation, undefined);
  });

  it('refuses a clarification that is not on this project', async () => {
    await assert.rejects(
      () => checkClarificationAgainstPack(qs(), { clarificationId: 'does-not-exist' }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'CLARIFICATION_NOT_FOUND');
        return true;
      },
    );
  });
});
