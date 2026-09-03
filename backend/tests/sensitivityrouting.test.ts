import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import { clearanceFor, higher, mayReceive, sensitivityOf, sensitivityOfType, within } from '../src/ai/sensitivity.ts';
import { ENTITY_ACCESS } from '../src/identity/entityAccess.ts';
import { config } from '../src/config.ts';
import { throwsCode } from './helpers.ts';
import type { AIProviderAdapter, ProviderCapability, ProviderRequest, ProviderResponse } from '../src/ai/providers/types.ts';
import type { AIProvider } from '../src/goldenthread/types.ts';

/**
 * Which vendor a record may be sent to.
 *
 * `DataSensitivity` had been a first-class concept since the access model was
 * built, and it governed exactly one thing: who may *read* a record. It said
 * nothing about who the platform may *hand the record to*. So a `LEGAL_L4`
 * contract clause — one a safety manager inside the customer's own company is
 * barred from opening — could be posted verbatim to any configured AI vendor,
 * because an engine happened to include it in its inputs.
 *
 * That is a disclosure, not a performance problem, and no test would have caught
 * it: every existing test passed while it was true.
 *
 * The control has three edges, and each one is a way it could be got wrong:
 *
 * **It must not be declarable by the caller.** An engine that could state its
 * own sensitivity would eventually state it too low, and the failure would be
 * silent. It is derived from the classification of the records being sent.
 *
 * **It must not fail over around itself.** Falling back from a cleared vendor to
 * an uncleared one because the first was unhealthy turns an outage into a
 * disclosure, at exactly the moment nobody is watching.
 *
 * **It must not refuse the engine that transmits nothing.** The deterministic
 * adapter answers from a hash of its inputs and opens no socket. Refusing it
 * would guard data against a journey it never takes, and would remove the
 * platform's only always-available engine from precisely the work that most
 * needs to stay in-house.
 */

function adapter(name: AIProvider, options: { transmits?: boolean; healthy?: boolean } = {}): AIProviderAdapter {
  return {
    name,
    capability: 'REASONING' as ProviderCapability,
    multimodal: false,
    transmits: options.transmits ?? true,
    estimateCostMinor: () => 100,
    healthy: () => options.healthy ?? true,
    async execute(request: ProviderRequest): Promise<ProviderResponse> {
      void request;
      return { provider: name, modelClass: 'test', output: {}, rawCostMinor: 100, latencyMs: 1 };
    },
  };
}

/** Run with a clearance configuration applied, restoring it afterwards. */
function withClearance<T>(
  clearance: Record<string, string>,
  run: () => T,
  fallback = config.ai.defaultClearance,
): T {
  const previousMap = { ...config.ai.providerClearance };
  const previousDefault = config.ai.defaultClearance;
  for (const key of Object.keys(config.ai.providerClearance)) delete config.ai.providerClearance[key];
  Object.assign(config.ai.providerClearance, clearance);
  (config.ai as { defaultClearance: string }).defaultClearance = fallback;
  try {
    return run();
  } finally {
    for (const key of Object.keys(config.ai.providerClearance)) delete config.ai.providerClearance[key];
    Object.assign(config.ai.providerClearance, previousMap);
    (config.ai as { defaultClearance: string }).defaultClearance = previousDefault;
  }
}

describe('how sensitive a request is', () => {
  it('is read from the same classification the entity read enforces', () => {
    // One table, not two. A second list of "what is sensitive for AI purposes"
    // would drift from the first, and the drift would be invisible.
    assert.equal(sensitivityOfType('Contract'), ENTITY_ACCESS['Contract']!.sensitivity);
    assert.equal(sensitivityOfType('Contract'), 'LEGAL_L4');
    assert.equal(sensitivityOfType('Claim'), 'LEGAL_L4');
  });

  it('treats a classified type with no stated level as ordinary project information', () => {
    assert.equal(ENTITY_ACCESS['Project']!.sensitivity, undefined);
    assert.equal(sensitivityOfType('Project'), 'INTERNAL');
  });

  it('treats an unmapped type as the most sensitive thing there is', () => {
    // Fail closed. An unclassified record is one nobody has thought about, and
    // the safe reading of "nobody has thought about it" is not "send it".
    assert.equal(sensitivityOfType('SomethingNobodyClassified'), 'LEGAL_L4');
  });

  it('takes the highest among everything being sent, not the average', () => {
    // A request carrying one privileged clause among twenty ordinary records is
    // a privileged request. Averaging would let a sensitive record ride along
    // inside a batch that looks routine.
    const mixed = sensitivityOf([
      { refType: 'Project', refId: 'p1' },
      { refType: 'WorkPackage', refId: 'w1' },
      { refType: 'Contract', refId: 'c1' },
    ]);

    assert.equal(mixed, 'LEGAL_L4');
  });

  it('treats a request naming no records as internal, not public', () => {
    // It still carries whatever the caller put in its prompt, and the platform
    // cannot inspect that.
    assert.equal(sensitivityOf([]), 'INTERNAL');
  });
});

describe('what a vendor may receive', () => {
  it('permits a level within the vendor\'s clearance and refuses one above it', () => {
    withClearance({ OPENAI: 'INTERNAL', ANTHROPIC: 'LEGAL_L4' }, () => {
      assert.equal(mayReceive(adapter('OPENAI'), 'INTERNAL'), true);
      assert.equal(mayReceive(adapter('OPENAI'), 'COMMERCIAL_L3'), false);
      assert.equal(mayReceive(adapter('ANTHROPIC'), 'LEGAL_L4'), true);
    });
  });

  it('falls back to the default clearance for a vendor nobody has spoken about', () => {
    withClearance({ ANTHROPIC: 'LEGAL_L4' }, () => {
      assert.equal(clearanceFor('GEMINI'), 'INTERNAL');
      assert.equal(mayReceive(adapter('GEMINI'), 'SAFETY_L2'), false);
    });
  });

  it('always permits an adapter that transmits nothing, at any level', () => {
    // Clearance is a statement about a vendor contract. Where there is no
    // vendor, there is nothing for it to be a statement about.
    withClearance({}, () => {
      assert.equal(mayReceive(adapter('OPENAI', { transmits: false }), 'LEGAL_L4'), true);
    });
  });

  it('orders the levels so a ceiling means what it says', () => {
    assert.equal(within('PUBLIC', 'INTERNAL'), true);
    assert.equal(within('LEGAL_L4', 'COMMERCIAL_L3'), false);
    assert.equal(higher('PUBLIC', 'COMMERCIAL_L3'), 'COMMERCIAL_L3');
  });
});

describe('routing refuses rather than leaking', () => {
  it('will not send privileged material to a vendor cleared only for internal work', () => {
    const orchestrator = new AIOrchestrator({
      reasoning: adapter('OPENAI'),
      perception: adapter('GEMINI'),
    });

    withClearance({ OPENAI: 'INTERNAL', GEMINI: 'INTERNAL' }, () => {
      throwsCode(() => orchestrator.adapterFor('REASONING', 'LEGAL_L4'), 'AI_CLEARANCE_REQUIRED');
    });
  });

  it('chooses the cleared vendor even when it is not the primary', () => {
    const orchestrator = new AIOrchestrator({
      reasoning: adapter('OPENAI'),
      perception: adapter('ANTHROPIC'),
    });

    withClearance({ OPENAI: 'INTERNAL', ANTHROPIC: 'LEGAL_L4' }, () => {
      assert.equal(orchestrator.adapterFor('REASONING', 'LEGAL_L4').name, 'ANTHROPIC');
      // And the ordinary case still leads with the primary.
      assert.equal(orchestrator.adapterFor('REASONING', 'INTERNAL').name, 'OPENAI');
    });
  });

  it('does not fail over from a cleared vendor to an uncleared one', () => {
    // The edge that matters most. An outage must not become a disclosure: if
    // the only cleared vendor is down, the answer is "no", not "send it
    // somewhere else".
    const orchestrator = new AIOrchestrator({
      reasoning: adapter('ANTHROPIC', { healthy: false }),
      perception: adapter('OPENAI', { healthy: true }),
    });

    withClearance({ ANTHROPIC: 'LEGAL_L4', OPENAI: 'INTERNAL' }, () => {
      // Healthy and available — and not allowed to see this.
      throwsCode(() => orchestrator.adapterFor('REASONING', 'LEGAL_L4'), 'AI_UNAVAILABLE');
      // The same call at a level OPENAI is cleared for does fail over.
      assert.equal(orchestrator.adapterFor('REASONING', 'INTERNAL').name, 'OPENAI');
    });
  });

  it('refuses with a code that says it is a refusal, not an outage', () => {
    // 403, not 503. Nothing is broken and retrying will not help; a client that
    // reads a deliberate refusal as an outage will keep trying.
    const orchestrator = new AIOrchestrator({ reasoning: adapter('OPENAI'), perception: adapter('GEMINI') });

    withClearance({}, () => {
      try {
        orchestrator.adapterFor('REASONING', 'LEGAL_L4');
        assert.fail('privileged material was routed to an uncleared vendor');
      } catch (error) {
        const problem = error as { code: string; status: number; message: string };
        assert.equal(problem.code, 'AI_CLEARANCE_REQUIRED');
        assert.equal(problem.status, 403);
        assert.match(problem.message, /LEGAL_L4/, 'the refusal does not say which level was refused');
        assert.match(problem.message, /AI_PROVIDER_CLEARANCE/, 'the refusal does not say how to fix it');
      }
    });
  });

  it('serves the deterministic engine at any level, because it transmits nothing', () => {
    const orchestrator = new AIOrchestrator({
      reasoning: adapter('OPENAI', { transmits: false }),
      perception: adapter('GEMINI', { transmits: false }),
    });

    withClearance({}, () => {
      assert.equal(orchestrator.adapterFor('REASONING', 'LEGAL_L4').name, 'OPENAI');
    });
  });
});

describe('the decision is recorded with the input it was made on', () => {
  it('records the sensitivity, the vendor, its clearance and who was excluded', async () => {
    // "All routing decisions are logged" is not satisfied by recording which
    // vendor served the call. That is the outcome; without the input the choice
    // cannot be re-derived, and re-deriving it is the whole point the day
    // somebody asks why a particular document went to a particular company.
    const { ACUWallet } = await import('../src/billing/acu.ts');
    const orchestrator = new AIOrchestrator({
      reasoning: adapter('ANTHROPIC'),
      perception: adapter('OPENAI'),
    });
    const wallet = new ACUWallet('tenant-1');
    // Funded explicitly: the default trial grant is sized as a first task and is
    // smaller than what this run reserves. The test is about routing, not trials.
    wallet.grantTrialCredit(1_000);

    const run = await withClearance({ ANTHROPIC: 'LEGAL_L4', OPENAI: 'INTERNAL' }, () =>
      orchestrator.execute(
        {
          tenantId: 'tenant-1',
          projectId: 'p-1',
          engine: 'CONTRACTS_CLAIMS',
          taskType: 'clause_analysis',
          capability: 'REASONING',
          userId: 'u-1',
          inputRefs: [{ refType: 'Contract', refId: 'c-1' }],
          request: { task: 'Assess', payload: {} },
          aiPermitted: true,
        },
        wallet,
      ),
    );

    const routing = run.aiRequest.routing;
    assert.equal(routing.sensitivity, 'LEGAL_L4', 'the sensitivity that drove the choice was not recorded');
    assert.equal(routing.provider, 'ANTHROPIC');
    assert.equal(routing.clearance, 'LEGAL_L4');
    assert.deepEqual(
      routing.excluded,
      [{ provider: 'OPENAI', clearance: 'INTERNAL' }],
      'an audit cannot tell "the others were down" from "the others were not allowed to see this"',
    );

    run.abandon('test');
  });

  it('files no request at all when the call is refused on clearance', async () => {
    // A queued request claiming a routing that never happened would be a record
    // of something that did not occur.
    const { ACUWallet } = await import('../src/billing/acu.ts');
    const orchestrator = new AIOrchestrator({ reasoning: adapter('OPENAI'), perception: adapter('GEMINI') });
    const wallet = new ACUWallet('tenant-2');
    wallet.grantTrialCredit(1_000);

    await withClearance({ OPENAI: 'INTERNAL', GEMINI: 'INTERNAL' }, async () => {
      await assert.rejects(
        orchestrator.execute(
          {
            tenantId: 'tenant-2',
            projectId: 'p-2',
            engine: 'CONTRACTS_CLAIMS',
            taskType: 'clause_analysis',
            capability: 'REASONING',
            userId: 'u-2',
            inputRefs: [{ refType: 'Contract', refId: 'c-2' }],
            request: { task: 'Assess', payload: {} },
            aiPermitted: true,
          },
          wallet,
        ),
        (error: { code?: string }) => error.code === 'AI_CLEARANCE_REQUIRED',
      );

      assert.equal(
        orchestrator.requests().length,
        0,
        'a refused call left a queued request behind claiming a routing that never happened',
      );
    });
  });
});
