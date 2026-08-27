import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import type { AIProviderAdapter, ProviderRequest, ProviderResponse } from '../src/ai/providers/types.ts';
import * as documents from '../src/documents/generate.ts';
import { narrativeBlocks } from '../src/documents/engine.ts';
import * as structure from '../src/domain/structure.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import type { DocumentBlock } from '../src/export/exporter.ts';

/**
 * The machine-written sections, and what the page says about them.
 *
 * Every fact on a generated document comes from a record. The reasoning engine
 * contributes the connective prose a good document has and a generated one
 * usually lacks — and the whole value of that contribution depends on the reader
 * being told who wrote it.
 *
 * The failure this file exists to prevent is subtler than a wrong figure. The
 * platform ships with a local adapter that answers every request with the same
 * sentence so it runs with no provider configured. That sentence used to land
 * on the page under a heading, followed by "Written by the platform's reasoning
 * engine from the records set out above, at a stated confidence of 84%" — an
 * attribution to reasoning that never happened, on a document that exists to
 * refuse exactly that.
 *
 * So: a synthetic answer is dropped and the section states its own absence,
 * which is what actually occurred. A real one is placed and attributed by name.
 */

/** A provider that writes prose, like a real one, and does not claim to be synthetic. */
function writingProvider(text: string, confidence = 0.81): AIProviderAdapter & { calls: number } {
  const adapter = {
    name: 'ANTHROPIC' as const,
    capability: 'REASONING' as const,
    multimodal: false,
    transmits: true,
    calls: 0,
    estimateCostMinor: () => 40,
    healthy: () => true,
    async execute(_request: ProviderRequest): Promise<ProviderResponse> {
      adapter.calls += 1;
      return {
        provider: 'ANTHROPIC',
        modelClass: 'stub-reasoning-v9',
        output: { narrative: text, confidence },
        rawCostMinor: 40,
        latencyMs: 9,
        confidence,
      };
      // No `synthetic` flag: this stands in for a model that actually answered.
    },
  };
  return adapter as AIProviderAdapter & { calls: number };
}

const text = (blocks: DocumentBlock[]): string => JSON.stringify(blocks);

/** A project carrying the RAMS the seeded demo already holds, in a phase that permits the engine. */
async function projectWith(orchestrator?: AIOrchestrator): Promise<{ platform: Platform; seed: SeedResult }> {
  const platform = orchestrator ? new Platform(orchestrator) : new Platform();
  const seed = await seedDemoProject(platform);
  // RISK_SAFETY is active in every phase, but the demo ends in OPERATIONS and
  // the safety documents read records written during construction.
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'CONSTRUCTION',
    justification: 'Reopened to generate a document with its narrative sections',
  });
  return { platform, seed };
}

const RAMS_NARRATIVE =
  'The confined space entry drives every control on this statement. The chamber is purged and gas tested before entry ' +
  'because the atmosphere is the hazard that kills without warning, and the fire watch is held for sixty minutes after ' +
  'the last arc because the specified duration assumes the residual heat in the frame rather than the flame.';

describe('documents · a section a model wrote says which model wrote it', () => {
  let rendered: string;
  let provider: AIProviderAdapter & { calls: number };
  let acuConsumed: number;

  before(async () => {
    provider = writingProvider(RAMS_NARRATIVE);
    const { platform, seed } = await projectWith(new AIOrchestrator({ reasoning: provider }));
    const ctx = platform.context(seed.users.safety!.auth, seed.projectId, { source: 'WEB' });

    const result = await documents.generateDocument(ctx, platform.exports, {
      code: 'RAMS',
      subjectId: platform.ledger.list(seed.projectId, 'RAMS')[0]!.refId,
      control: { preparedBy: 'HSE Manager', status: 'ISSUED' },
      withNarrative: true,
      correlationId: 'test-narrative',
    });

    rendered = text(result.document.blocks);
    acuConsumed = result.acuConsumed;
    assert.equal(result.narrativeSections, 1, 'the narrative section was not produced');
  });

  it('actually called the provider', () => {
    assert.ok(provider.calls > 0);
  });

  it('places what the model wrote on the page', () => {
    assert.match(rendered, /the atmosphere is the hazard that kills without warning/);
  });

  it('names the model and the provider beside it', () => {
    // "Machine-written" is not enough. A reader deciding how much weight to give
    // a paragraph is entitled to know which machine, and a document that only
    // said "the platform's reasoning engine" could not distinguish a frontier
    // model from a stand-in that reasons about nothing.
    assert.match(rendered, /by stub-reasoning-v9 via ANTHROPIC/);
  });

  it('states the model’s own confidence rather than implying certainty', () => {
    assert.match(rendered, /at a stated confidence of 81%/);
  });

  it('says on the page that the section contains no fact of its own', () => {
    assert.match(rendered, /contains no figure, date, name or reference that is not already on this document/);
  });

  it('charges for the run and reports what it charged', () => {
    assert.ok(acuConsumed > 0, 'the run was not billed');
  });
});

describe('documents · a synthetic answer is never presented as reasoning', () => {
  let rendered: string;
  let result: Awaited<ReturnType<typeof documents.generateDocument>>;

  before(async () => {
    // No orchestrator override: the platform's own local adapter, which is what
    // every deployment with no provider key configured actually runs.
    const { platform, seed } = await projectWith();
    const ctx = platform.context(seed.users.safety!.auth, seed.projectId, { source: 'WEB' });

    result = await documents.generateDocument(ctx, platform.exports, {
      code: 'RAMS',
      subjectId: platform.ledger.list(seed.projectId, 'RAMS')[0]!.refId,
      control: { preparedBy: 'HSE Manager', status: 'ISSUED' },
      withNarrative: true,
      correlationId: 'test-narrative-local',
    });
    rendered = text(result.document.blocks);
  });

  it('keeps the heading, so the document does not silently drop a section it was meant to have', () => {
    assert.match(rendered, /Where this method is most sensitive to being worked out of sequence/);
  });

  it('does not put the local adapter’s stand-in sentence on the page', () => {
    // The sentence that used to appear, under a heading claiming a model wrote
    // it from the records.
    assert.equal(rendered.includes('Deterministic local analysis'), false);
    assert.equal(rendered.includes('No external provider was called'), false);
  });

  it('does not attribute anything to the reasoning engine', () => {
    assert.equal(rendered.includes('Written by the platform’s reasoning engine from the records set out above'), false);
    assert.equal(rendered.includes('at a stated confidence of'), false);
  });

  it('says instead that the section could not be produced', () => {
    assert.match(rendered, /could not be produced for this issue/);
    assert.match(rendered, /everything factual in this document is on the pages above/);
  });

  it('reports no narrative section, and still reports the ACUs the run cost', () => {
    assert.equal(result.narrativeSections, 0);
    // The run happened and was charged for. Hiding that to make the report tidy
    // would be a second untruth in service of covering the first.
    assert.ok(result.acuConsumed > 0, 'the local run was not billed, so the charge is being hidden');
  });
});

describe('documents · the narrative block itself', () => {
  it('states the absence when nothing was written', () => {
    const blocks = narrativeBlocks('Why this matters', undefined);
    assert.equal(blocks.length, 2);
    assert.match(text(blocks), /could not be produced for this issue/);
  });

  it('attributes by model where one is named, and does not invent one where it is not', () => {
    const named = text(narrativeBlocks('H', { text: 'Prose.', modelClass: 'm-1', provider: 'OPENAI', confidence: 0.5 }));
    assert.match(named, /by m-1 via OPENAI/);
    assert.match(named, /at a stated confidence of 50%/);

    const unnamed = text(narrativeBlocks('H', { text: 'Prose.' }));
    assert.match(unnamed, /Written by the platform’s reasoning engine/);
    assert.equal(unnamed.includes(' via '), false);
    assert.equal(unnamed.includes('confidence'), false);
  });
});

describe('documents · every type asks the engine something worth asking', () => {
  it('gives every narrative brief a question about relationships, not a request for facts', () => {
    for (const definition of documents.DOCUMENT_TYPES) {
      for (const section of definition.narrative) {
        // "Reason about" rather than "write" or "describe". The distinction is
        // the whole architecture: a model handed a blank page and a document
        // title writes an excellent, entirely invented document.
        assert.match(
          section.brief,
          /^Reason about/,
          `${definition.code} · ${section.heading} does not ask the engine to reason about the records`,
        );
      }
    }
  });
});
