import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import type { AIProviderAdapter, ProviderRequest, ProviderResponse } from '../src/ai/providers/types.ts';
import { reviewProjectRisks, shapeProposedRisks } from '../src/domain/riskreview.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The AI risk-register review — a chartered risk manager reading the live
 * register for what is missing or weak. Under test is the engine around the
 * model: it guards whatever the model returns to a real cause→event→impact with a
 * control, it refuses rather than fabricates when no model can run, and it
 * proposes without touching the register.
 */

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

const pm = (): EngineContext => platform.context(seed.users.pm!.auth, seed.projectId, { correlationId: 'risk-test' });

async function build(orchestrator?: AIOrchestrator): Promise<void> {
  platform = orchestrator ? new Platform(orchestrator) : new Platform();
  seed = await seedDemoProject(platform);
}

describe('shapeProposedRisks guards the model output', () => {
  it('keeps a real risk, drops the stubs and duplicates, and caps the set at ten', () => {
    const output = {
      risks: [
        { subject: 'Ground conditions', category: 'GROUND_CONDITIONS', cause: 'The GI is limited to four boreholes, so made ground east of grid C may be deeper than assumed, driving piling redesign.', owner: 'SHARED', trigger: 'Trial pit depths exceed 2.5m', mitigation: 'Commission supplementary GI east of grid C before the piling package is let.', basis: 'Register has no ground risk east of grid C' },
        { subject: 'No cause', category: 'PROGRAMME', cause: 'late', owner: '', trigger: '', mitigation: 'chase it', basis: 'x' }, // cause too short → dropped
        { subject: 'No control', category: 'COMMERCIAL', cause: 'The DNO connection depends on a wayleave not yet granted, so energisation may slip past PC.', owner: 'CLIENT', trigger: '', mitigation: 'no', basis: 'register' }, // mitigation too short → dropped
        { subject: 'Ground conditions', category: 'GROUND_CONDITIONS', cause: 'The GI is limited to four boreholes, so made ground east of grid C may be deeper than assumed, driving piling redesign.', owner: 'SHARED', trigger: 'x', mitigation: 'duplicate control here', basis: 'duplicate of the first' }, // duplicate → dropped
        ...Array.from({ length: 12 }, (_v, i) => ({ subject: `R${i}`, category: 'SUPPLY_CHAIN', cause: `A genuine supply-chain risk number ${i} with a real cause, event and impact on the works.`, owner: 'CONTRACTOR', trigger: `trigger ${i}`, mitigation: `a real control for risk ${i}`, basis: `grounded in register item ${i}` })),
      ],
    };
    const shaped = shapeProposedRisks(output);
    assert.ok(shaped.length <= 10, 'the set is capped at ten');
    assert.ok(shaped.some((r) => /east of grid C/.test(r.cause)), 'the real ground risk survives');
    assert.ok(!shaped.some((r) => r.cause === 'late'), 'a no-cause stub is dropped');
    assert.ok(!shaped.some((r) => r.mitigation === 'no'), 'a risk with no real control is dropped');
    const groundCount = shaped.filter((r) => /east of grid C/.test(r.cause)).length;
    assert.equal(groundCount, 1, 'the duplicate is dropped');
  });
});

describe('the risk review refuses rather than fabricates', () => {
  before(async () => {
    await build(); // default platform: the local stand-in is synthetic
  });

  it('reports unavailable, and charges nothing, when no reasoning model can run', async () => {
    const review = await reviewProjectRisks(pm());
    assert.equal(review.available, false, 'a synthetic stand-in is not an expert risk review');
    assert.equal(review.proposed.length, 0);
    assert.equal(review.acuConsumed, 0, 'nothing is charged for a refusal');
    assert.match(review.note, /reasoning (AI )?provider/i);
  });
});

describe('the risk review proposes grounded risks from a real model', () => {
  before(async () => {
    await build(new AIOrchestrator({ reasoning: reasoningStub() }));
    stubOutput = {
      risks: [
        {
          subject: 'DNO wayleave',
          category: 'COMMERCIAL',
          cause: 'Energisation depends on a DNO connection whose wayleave across the adjoining title is not yet granted, so the integrated test and PC may slip.',
          owner: 'CLIENT',
          trigger: 'Wayleave not executed eight weeks before planned energisation',
          mitigation: 'Escalate the wayleave with the client now and hold a provisional energisation date with the DNO.',
          basis: 'Register records no energisation/connection risk',
        },
      ],
    };
  });

  it('proposes the risk, carrying its basis, and touches nothing on the register', async () => {
    const review = await reviewProjectRisks(pm());
    assert.equal(review.available, true);
    assert.ok(review.proposed.length >= 1);
    assert.match(review.proposed[0]!.cause, /wayleave/i);
    assert.ok(review.proposed[0]!.basis.length > 0, 'the proposal carries what it rests on');
    // It proposes only: nothing is added to the register.
    const before = pm().ledger.list(seed.projectId, 'RiskRegisterItem').length;
    await reviewProjectRisks(pm());
    assert.equal(pm().ledger.list(seed.projectId, 'RiskRegisterItem').length, before, 'the review adds nothing to the register');
  });
});
