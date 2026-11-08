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
import { reviewTenderForClarifications, shapeProposedQuestions } from '../src/domain/clarificationreview.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { config } from '../src/config.ts';

/**
 * The AI clarification review — a construction bid manager reading the tender for
 * the questions worth asking the buyer. What is under test is the engine around
 * the model: it refuses rather than fabricates when no model can run, it says so
 * when nothing is ingested, it shapes and guards whatever the model returns, and
 * it proposes without raising.
 */

let directory: string;
let store: EvidenceStore;
let platform: Platform;
let seed: SeedResult;

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

const qs = (): EngineContext => platform.context(seed.users.qs!.auth, seed.projectId, { correlationId: 'review-test' });

async function ingestDoc(bytes: Buffer, filename: string): Promise<void> {
  const hash = hashBytes(bytes);
  qs().ledger.commit({
    tenantId: seed.tenantId,
    projectId: seed.projectId,
    actor: { refType: 'User', refId: seed.users.qs!.id },
    source: 'WEB',
    correlationId: 'review-test',
    eventType: 'EVIDENCE_REGISTERED',
    entity: { refType: 'EvidenceItem', refId: `ev-${hash.slice(-12)}` },
    nextState: { id: `ev-${hash.slice(-12)}`, type: 'TENDER_DOCUMENT', hash, description: 'review fixture', linkedEntities: [], capturedAt: new Date().toISOString(), capturedBy: seed.users.qs!.id },
  });
  await store.put(seed.tenantId, hash, bytes, 'application/zip');
  await ingestFile(qs(), store, { hash, filename });
}

async function build(orchestrator?: AIOrchestrator): Promise<void> {
  platform = orchestrator ? new Platform(orchestrator, store) : new Platform(undefined, store);
  seed = await seedDemoProject(platform);
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'TENDER',
    justification: 'Reopened to review the tender for clarifications',
  });
}

let previousDefaultClearance: string;
before(() => {
  directory = mkdtempSync(join(tmpdir(), 'construx-review-'));
  store = new EvidenceStore(directory);
  previousDefaultClearance = config.ai.defaultClearance;
  (config.ai as { defaultClearance: string }).defaultClearance = 'COMMERCIAL_L3';
});
after(() => {
  rmSync(directory, { recursive: true, force: true });
  (config.ai as { defaultClearance: string }).defaultClearance = previousDefaultClearance;
});

describe('shapeProposedQuestions guards the model output', () => {
  it('keeps real questions, drops stubs and duplicates, and caps the set at eight', () => {
    const output = {
      questions: [
        { subject: 'Ink vs electronic', question: 'The ITT requires schedules written in ink and the original copy, but submission is electronic via Sell2Wales. Please confirm electronic entry satisfies this.', basis: 'written in ink and be the original copy' },
        { subject: 'Too short', question: 'Confirm?', basis: 'a clause here' }, // question too short → dropped
        { subject: 'No basis', question: 'Please confirm who holds the road closure order for the diversion route.', basis: '' }, // no basis → dropped
        { subject: 'Dup', question: 'The ITT requires schedules written in ink and the original copy, but submission is electronic via Sell2Wales. Please confirm electronic entry satisfies this.', basis: 'duplicate of the first' }, // duplicate → dropped
        ...Array.from({ length: 10 }, (_v, i) => ({ subject: `Q${i}`, question: `A genuine clarification number ${i} about a real priced item on the schedule.`, basis: `passage ${i} from the documents` })),
      ],
    };
    const shaped = shapeProposedQuestions(output);
    assert.ok(shaped.length <= 8, 'the set is capped at eight');
    assert.ok(shaped.some((q) => /written in ink/.test(q.question)), 'the real ink/electronic question survives');
    assert.ok(!shaped.some((q) => q.question === 'Confirm?'), 'a one-word stub is dropped');
    assert.ok(!shaped.some((q) => q.basis === ''), 'a question with no basis is dropped');
    const inkCount = shaped.filter((q) => /written in ink/.test(q.question)).length;
    assert.equal(inkCount, 1, 'the duplicate is dropped');
  });

  it('falls back to the question as the subject when none is given', () => {
    const shaped = shapeProposedQuestions({ questions: [{ question: 'Please confirm the required employers liability and public liability insurance limits, which the Contract Data table leaves blank.', basis: 'Insurance Table — minimum amount of cover: (blank)' }] });
    assert.equal(shaped.length, 1);
    assert.ok(shaped[0]!.subject.length > 0, 'a subject is derived from the question');
  });
});

describe('the review refuses rather than fabricates', () => {
  it('reports unavailable, and charges nothing, when no reasoning model can run', async () => {
    await build(); // default platform: the local stand-in is synthetic
    await ingestDoc(docxOf(paragraph('INSTRUCTIONS TO TENDERERS') + paragraph('All schedules must be written in ink and be the original copy.')), 'Volume 1 ITT.docx');
    const review = await reviewTenderForClarifications(qs());
    assert.equal(review.available, false, 'a synthetic stand-in is not an expert review');
    assert.equal(review.proposed.length, 0);
    assert.equal(review.acuConsumed, 0, 'nothing is charged for a refusal');
    assert.match(review.note, /reasoning (AI )?provider/i);
  });

  it('says there is nothing to review when no document carries text', async () => {
    await build(new AIOrchestrator({ reasoning: reasoningStub() }));
    const review = await reviewTenderForClarifications(qs());
    assert.equal(review.available, false);
    assert.equal(review.proposed.length, 0);
    assert.match(review.note, /No ingested tender document/);
  });
});

describe('the review proposes grounded questions from a real model', () => {
  before(async () => {
    await build(new AIOrchestrator({ reasoning: reasoningStub() }));
    await ingestDoc(
      docxOf(
        paragraph('VOLUME 1 — INSTRUCTIONS TO TENDERERS') +
          paragraph('1.8 Lump sums. These must be quoted in pounds and pence, written in ink and be the original copy.') +
          paragraph('1.15 The Client will only accept electronic tender submissions via the Sell2Wales post-box facility. Paper submissions will not be accepted.'),
      ),
      'Volume 1 ITT.docx',
    );
    stubOutput = {
      questions: [
        {
          subject: 'Ink vs electronic submission',
          question: 'Clause 1.8 requires lump-sum schedules to be “written in ink and be the original copy”, while clause 1.15 states submission is electronic only via the Sell2Wales post-box and paper is not accepted. Please confirm that completing the Price List electronically satisfies clause 1.8.',
          basis: '1.8 … written in ink and be the original copy / 1.15 … only accept electronic tender submissions … Paper submissions will not be accepted.',
        },
      ],
    };
  });

  it('proposes the question, carrying its basis, and raises nothing', async () => {
    const review = await reviewTenderForClarifications(qs());
    assert.equal(review.available, true);
    assert.equal(review.proposed.length, 1);
    assert.match(review.proposed[0]!.question, /written in ink/);
    assert.ok(review.proposed[0]!.basis.length > 0, 'the proposal carries the passage it comes from');
    assert.ok(review.documentsReviewed.includes('Volume 1 ITT.docx'), 'it names the document it read');
    // It proposes only: nothing is on the clarification register.
    assert.equal(qs().ledger.list(seed.projectId, 'Clarification').length, 0, 'the review raises nothing');
  });
});
