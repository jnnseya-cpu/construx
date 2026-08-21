import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rejectsCode, throwsCode } from './helpers.ts';
import { ACUWallet } from '../src/billing/acu.ts';
import { AIOrchestrator, ENGINE_CONTRACTS, engineActiveIn } from '../src/ai/orchestrator.ts';
import { LIFECYCLE_ORDER } from '../src/lifecycle/phases.ts';
import type { AIProviderAdapter, ProviderRequest, ProviderResponse } from '../src/ai/providers/types.ts';

/**
 * The AI control plane, and the three promises it makes.
 *
 *   1. A provider outage degrades a feature, never the platform.
 *   2. No provider is called on an empty wallet — the refusal happens before
 *      the request goes out, not after the money is spent.
 *   3. A failed call costs nothing: the hold is released, not consumed.
 *
 * All three were claimed as built and none was tested. They are the difference
 * between an AI feature and an unbounded bill.
 */

/** A provider that records what was asked of it and can be made to fail. */
function stubProvider(
  name: 'OPENAI' | 'GEMINI',
  capability: 'REASONING' | 'PERCEPTION',
  options: { healthy?: boolean; throws?: boolean; cost?: number } = {},
): AIProviderAdapter & { calls: number } {
  const provider = {
    name,
    capability,
    calls: 0,
    estimateCostMinor: () => options.cost ?? 100,
    healthy: () => options.healthy ?? true,
    async execute(request: ProviderRequest): Promise<ProviderResponse> {
      provider.calls += 1;
      if (options.throws) throw new Error('provider exploded');
      return {
        provider: name,
        modelClass: request.modelClass ?? 'default',
        output: { ok: true },
        rawCostMinor: options.cost ?? 100,
        latencyMs: 12,
      };
    },
  };
  return provider as AIProviderAdapter & { calls: number };
}

const task = (orchestrator: AIOrchestrator, wallet: ACUWallet, capability: 'REASONING' | 'PERCEPTION' = 'REASONING') =>
  orchestrator.execute(
    {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      engine: 'PLANNING',
      taskType: 'forecast',
      inputRefs: [],
      userId: 'user-1',
      aiPermitted: true,
      capability,
      request: { task: 'forecast-delay', payload: {}, modelClass: 'default' },
    },
    wallet,
  );

function fundedWallet(): ACUWallet {
  const wallet = new ACUWallet('tenant-1');
  wallet.grantTrialCredit();
  return wallet;
}

describe('provider routing and failover', () => {
  it('uses the primary provider while it is healthy', () => {
    const reasoning = stubProvider('OPENAI', 'REASONING');
    const perception = stubProvider('GEMINI', 'PERCEPTION');
    const orchestrator = new AIOrchestrator({ reasoning, perception });

    assert.equal(orchestrator.adapterFor('REASONING').name, 'OPENAI');
    assert.equal(orchestrator.adapterFor('PERCEPTION').name, 'GEMINI');
  });

  it('falls back to the other provider when the primary is down', () => {
    // A perception outage must degrade the feature, not stop the platform.
    const reasoning = stubProvider('OPENAI', 'REASONING', { healthy: true });
    const perception = stubProvider('GEMINI', 'PERCEPTION', { healthy: false });
    const orchestrator = new AIOrchestrator({ reasoning, perception });

    assert.equal(orchestrator.adapterFor('PERCEPTION').name, 'OPENAI', 'no failover happened');
  });

  it('refuses rather than pretending when every provider is down', () => {
    const orchestrator = new AIOrchestrator({
      reasoning: stubProvider('OPENAI', 'REASONING', { healthy: false }),
      perception: stubProvider('GEMINI', 'PERCEPTION', { healthy: false }),
    });

    assert.throws(() => orchestrator.adapterFor('REASONING'), /AI_UNAVAILABLE|No healthy AI provider/);
  });

  it('publishes provider health without naming a credential', () => {
    const status = new AIOrchestrator({
      reasoning: stubProvider('OPENAI', 'REASONING'),
      perception: stubProvider('GEMINI', 'PERCEPTION', { healthy: false }),
    }).controlPlaneStatus();

    assert.equal(status.reasoning.healthy, true);
    assert.equal(status.perception.healthy, false);
    assert.ok(!JSON.stringify(status).toLowerCase().includes('key'));
  });
});

describe('money is reserved before anything is spent', () => {
  it('never calls a provider on an empty wallet', async () => {
    const reasoning = stubProvider('OPENAI', 'REASONING', { cost: 500 });
    const orchestrator = new AIOrchestrator({ reasoning, perception: stubProvider('GEMINI', 'PERCEPTION') });
    const empty = new ACUWallet('tenant-1'); // no grant, no top-up

    await rejectsCode(() => task(orchestrator, empty), 'ACU_EXHAUSTED');
    assert.equal(reasoning.calls, 0, 'the provider was called despite an empty wallet — that is a real bill');
  });

  it('debits nothing until the output has been written to the Golden Thread', async () => {
    // Settlement is deliberately deferred: execute() returns, the caller
    // commits the output, and only then is the wallet charged. That ordering
    // is what makes "no charge without a ledger write" true rather than hoped.
    const wallet = fundedWallet();
    const before = wallet.snapshot().balanceMinor;

    const result = await task(new AIOrchestrator({
      reasoning: stubProvider('OPENAI', 'REASONING', { cost: 50 }),
      perception: stubProvider('GEMINI', 'PERCEPTION'),
    }), wallet);

    assert.equal(wallet.snapshot().balanceMinor, before, 'the wallet was debited before the output was persisted');

    result.settle([]);
    assert.ok(wallet.snapshot().balanceMinor < before, 'settlement charged nothing');
  });

  it('refuses to settle the same execution twice', async () => {
    const result = await task(new AIOrchestrator({
      reasoning: stubProvider('OPENAI', 'REASONING', { cost: 50 }),
      perception: stubProvider('GEMINI', 'PERCEPTION'),
    }), fundedWallet());

    result.settle([]);
    throwsCode(() => result.settle([]), 'AI_ALREADY_SETTLED');
  });

  it('abandoning an execution releases the hold without charge', async () => {
    const wallet = fundedWallet();
    const before = wallet.snapshot().balanceMinor;

    const result = await task(new AIOrchestrator({
      reasoning: stubProvider('OPENAI', 'REASONING', { cost: 50 }),
      perception: stubProvider('GEMINI', 'PERCEPTION'),
    }), wallet);

    result.abandon('the engine rejected the output');
    assert.equal(wallet.snapshot().balanceMinor, before, 'an abandoned execution was still charged');
  });

  it('releases the hold when the provider fails, so a failure is free', async () => {
    const wallet = fundedWallet();
    const before = wallet.snapshot().balanceMinor;

    const failing = stubProvider('OPENAI', 'REASONING', { throws: true, cost: 50 });
    const orchestrator = new AIOrchestrator({ reasoning: failing, perception: stubProvider('GEMINI', 'PERCEPTION') });

    await assert.rejects(() => task(orchestrator, wallet), /provider exploded/);

    assert.equal(failing.calls, 1);
    assert.equal(
      wallet.snapshot().balanceMinor,
      before,
      'a failed AI call was still charged — the hold was not released',
    );
  });

  it('refuses an actor who is not permitted to run AI at all', async () => {
    const orchestrator = new AIOrchestrator({
      reasoning: stubProvider('OPENAI', 'REASONING'),
      perception: stubProvider('GEMINI', 'PERCEPTION'),
    });

    await rejectsCode(
      () =>
        orchestrator.execute(
          {
            tenantId: 'tenant-1',
            projectId: 'project-1',
            engine: 'PLANNING',
            taskType: 'forecast',
            inputRefs: [],
            userId: 'user-1',
            aiPermitted: false,
            capability: 'REASONING',
            request: { task: 'forecast-delay', payload: {}, modelClass: 'default' },
          },
          fundedWallet(),
        ),
      'AI_NOT_ENABLED',
    );
  });
});

/**
 * Engine contracts: when each engine may run.
 *
 * The routing matrix says which provider an engine reaches. It said nothing
 * about when the engine is applicable, so every engine was reachable in every
 * phase — a handover engine could be asked to assemble an O&M manual for a
 * project still at CONCEPT. It would produce an answer, spend the ACUs and
 * write it to a ledger that cannot be edited, and the answer would be worthless.
 *
 * The binding is a contract rather than documentation because `runAI` enforces
 * it and `/v1/ai/control-plane` publishes the same table.
 */
describe('when an engine may run', () => {
  it('binds every engine to at least one phase', () => {
    for (const [engine, contract] of Object.entries(ENGINE_CONTRACTS)) {
      assert.ok(
        contract.activeInPhases.length > 0,
        `${engine} is active in no phase, so it can never run`,
      );
      assert.ok(contract.purpose.length > 0, `${engine} declares no purpose`);
      assert.ok(contract.inputs.length > 0, `${engine} declares no inputs`);
      assert.ok(contract.outputs.length > 0, `${engine} declares no outputs`);
    }
  });

  it('declares only phases that exist', () => {
    // A typo here would silently disable an engine everywhere rather than fail.
    for (const [engine, contract] of Object.entries(ENGINE_CONTRACTS)) {
      for (const phase of contract.activeInPhases) {
        assert.ok(LIFECYCLE_ORDER.includes(phase), `${engine} names a phase that does not exist: ${phase}`);
      }
    }
  });

  it('keeps handover out of concept and tender out of operations', () => {
    // The two that matter commercially: an O&M manual for a project that has no
    // scope yet, and a tender price for an asset handed over three years ago.
    assert.equal(engineActiveIn('HANDOVER_OM', 'CONCEPT'), false);
    assert.equal(engineActiveIn('HANDOVER_OM', 'OPERATIONS'), true);
    assert.equal(engineActiveIn('TENDER', 'OPERATIONS'), false);
    assert.equal(engineActiveIn('TENDER', 'TENDER'), true);
  });

  it('leaves the portfolio engine unbound, deliberately', () => {
    // A portfolio spans projects in different phases, so binding this would
    // bind it to whichever project happened to be asked about.
    for (const phase of LIFECYCLE_ORDER) {
      assert.equal(engineActiveIn('EXECUTIVE', phase), true, `EXECUTIVE was blocked in ${phase}`);
    }
  });

  it('publishes the same table it enforces', () => {
    const published = new AIOrchestrator().controlPlaneStatus().engineContracts;
    assert.deepEqual(published, ENGINE_CONTRACTS, 'the console would be shown a rule the API does not apply');
  });
});
