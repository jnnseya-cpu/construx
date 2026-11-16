import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import type { AIProviderAdapter, ProviderRequest, ProviderResponse } from '../src/ai/providers/types.ts';
import { ROUTES } from '../src/api/routes.ts';
import { config } from '../src/config.ts';
import * as aiclearance from '../src/domain/aiclearance.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { runAI } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * A company owner clears an AI provider for the company's own material.
 *
 * Built at the owner's request, after an earlier console version that could
 * refuse what the server setting granted was taken out. What is proved here is
 * the shape that makes it safe: it only ever raises the server setting, it is
 * one company's decision, only the owner makes it, and a run that would have
 * been refused for clearance goes through once it is made — and is refused
 * again once it is withdrawn.
 */

let platform: Platform;
let seed: SeedResult;
let other: SeedResult;
const sent: ProviderRequest[] = [];

const adapter: AIProviderAdapter = {
  name: 'OPENAI',
  capability: 'REASONING',
  multimodal: false,
  transmits: true,
  estimateCostMinor: () => 25,
  healthy: () => true,
  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    sent.push(request);
    return { provider: 'OPENAI', modelClass: 'reasoning-standard', output: { body: ['ok'] }, rawCostMinor: 25, latencyMs: 5, confidence: 0.9 };
  },
};

const gov = (who: string, result: SeedResult = seed): EngineContext =>
  platform.context(result.users[who]!.auth, `${result.tenantId}-governance`, { correlationId: 'clearance-test' });

/** A run carrying commercial material, as a tender answer does. */
async function commercialRun(result: SeedResult = seed) {
  const ctx = platform.context(result.users.qs!.auth, result.projectId, { correlationId: 'clearance-test' });
  const analysis = platform.ledger.listByTenant(result.tenantId, 'ITTAnalysis')[0];
  return runAI(ctx, {
    // The contracts engine runs in the demo project's phase; what decides the
    // clearance is the commercial record the run carries, not the engine.
    engine: 'CONTRACTS_CLAIMS',
    taskType: 'entitlement_assessment',
    capability: 'REASONING',
    inputRefs: [{ refType: 'ITTAnalysis', refId: analysis ? analysis.refId : 'none' }],
    request: { task: 'clearance test', payload: {} },
    toWrites: () => [],
  });
}

before(async () => {
  // Nothing cleared by the server: every vendor at the INTERNAL default.
  for (const key of Object.keys(config.ai.providerClearance)) delete config.ai.providerClearance[key];
  // Both roles taken by a vendor that transmits, as on a production deployment:
  // with the local stand-in in the chain, uncleared work would quietly go to it.
  platform = new Platform(new AIOrchestrator({ reasoning: adapter, perception: adapter }));
  seed = await seedDemoProject(platform);
  other = await seedDemoProject(platform);
  platform.wallet(seed.tenantId).topUp(1_000_000, 'test');
  platform.wallet(other.tenantId).topUp(1_000_000, 'test');
});

describe('the owner clears a provider for the company’s own material', () => {
  it('starts at the server setting, and refuses commercial material to an uncleared provider', async () => {
    const position = aiclearance.clearancePosition(gov('owner'));
    assert.deepEqual(position.providers.map((entry) => entry.provider), ['OPENAI']);
    assert.equal(position.providers[0]!.server, 'INTERNAL');
    assert.equal(position.providers[0]!.effective, 'INTERNAL');
    assert.equal(position.canChange, true);
    await assert.rejects(commercialRun(), (error: Error & { code?: string }) => {
      assert.equal(error.code, 'AI_CLEARANCE_REQUIRED');
      assert.match(error.message, /ACU & Billing/, 'the refusal names where the owner clears it');
      return true;
    });
  });

  it('is the owner’s alone: anyone else is refused before anything is recorded', () => {
    assert.throws(
      () => aiclearance.grantClearance(gov('qs'), { provider: 'OPENAI', level: 'COMMERCIAL_L3', reason: 'Signed DPA, zero retention' }),
      (error: Error & { code?: string }) => error.code === 'OWNER_ONLY',
    );
    assert.equal(platform.ledger.listByTenant(seed.tenantId, 'ProviderClearance').length, 0);
    assert.equal(aiclearance.clearancePosition(gov('qs')).canChange, false);
  });

  it('refuses a provider that is not configured, a level that is not grantable, and no reason', () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return (error as { code?: string }).code;
      }
      return undefined;
    };
    assert.equal(code(() => aiclearance.grantClearance(gov('owner'), { provider: 'MADEUP', level: 'COMMERCIAL_L3', reason: 'Signed DPA, zero retention' })), 'PROVIDER_NOT_CONFIGURED');
    assert.equal(code(() => aiclearance.grantClearance(gov('owner'), { provider: 'OPENAI', level: 'PUBLIC', reason: 'Signed DPA, zero retention' })), 'CLEARANCE_LEVEL_INVALID');
    assert.equal(code(() => aiclearance.grantClearance(gov('owner'), { provider: 'OPENAI', level: 'COMMERCIAL_L3', reason: 'ok' })), 'CLEARANCE_REASON_REQUIRED');
  });

  it('once cleared, the same commercial run goes through for this company, and the record says who and why', async () => {
    const granted = aiclearance.grantClearance(gov('owner'), { provider: 'OPENAI', level: 'COMMERCIAL_L3', reason: 'Data processing addendum signed, zero retention' });
    assert.equal(granted.effective, 'COMMERCIAL_L3');
    const before = sent.length;
    await commercialRun();
    assert.equal(sent.length, before + 1, 'the provider was called');
    const record = platform.ledger.listByTenant(seed.tenantId, 'ProviderClearance')[0]!;
    const grant = (record.state.grants as Record<string, aiclearance.ClearanceGrant>).OPENAI!;
    assert.equal(grant.grantedBy, seed.users.owner!.auth.actorId);
    assert.match(grant.reason, /Data processing addendum/);
  });

  it('is one company’s decision: another company on the same platform is still refused', async () => {
    assert.equal(aiclearance.clearancePosition(gov('owner', other)).providers[0]!.effective, 'INTERNAL');
    await assert.rejects(commercialRun(other), (error: Error & { code?: string }) => error.code === 'AI_CLEARANCE_REQUIRED');
  });

  it('never lowers what the server allows: a grant below the server setting leaves the server setting in force', () => {
    config.ai.providerClearance.OPENAI = 'LEGAL_L4';
    try {
      aiclearance.grantClearance(gov('owner'), { provider: 'OPENAI', level: 'SAFETY_L2', reason: 'Lower grant recorded for the test' });
      assert.equal(platform.orchestrator.clearanceOf('OPENAI', seed.tenantId), 'LEGAL_L4');
      assert.equal(aiclearance.clearancePosition(gov('owner')).providers[0]!.effective, 'LEGAL_L4');
    } finally {
      delete config.ai.providerClearance.OPENAI;
    }
    aiclearance.grantClearance(gov('owner'), { provider: 'OPENAI', level: 'COMMERCIAL_L3', reason: 'Data processing addendum signed, zero retention' });
  });

  it('withdrawn, the next commercial run is refused again', async () => {
    const withdrawn = aiclearance.withdrawClearance(gov('owner'), { provider: 'OPENAI', reason: 'Contract with the provider ended' });
    assert.equal(withdrawn.effective, 'INTERNAL');
    await assert.rejects(commercialRun(), (error: Error & { code?: string }) => error.code === 'AI_CLEARANCE_REQUIRED');
    assert.throws(
      () => aiclearance.withdrawClearance(gov('owner'), { provider: 'OPENAI', reason: 'Nothing left to withdraw here' }),
      (error: Error & { code?: string }) => error.code === 'CLEARANCE_NOT_GRANTED',
    );
  });

  it('is reachable through three routes, the two writes owner-checked in the domain', () => {
    const patterns = ROUTES.filter((route) => route.pattern.startsWith('/v1/ai/clearance')).map((route) => `${route.method} ${route.pattern}`);
    assert.deepEqual(patterns.sort(), ['GET /v1/ai/clearance', 'POST /v1/ai/clearance', 'POST /v1/ai/clearance/withdraw']);
  });
});
