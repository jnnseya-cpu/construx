import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { config } from '../src/config.ts';
import { ENDPOINTS, PROVIDER_NAMES, RemoteProviderAdapter, geminiSchema, isProvider } from '../src/ai/providers/remote.ts';
import { outputStandardSchema } from '../src/ai/outputstandard.ts';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import type { AIProviderAdapter, ProviderRequest, ProviderResponse } from '../src/ai/providers/types.ts';
import type { AIProvider } from '../src/goldenthread/types.ts';

/**
 * The provider gateway, and the two things that were wrong with it.
 *
 * **A third provider would have been a second one wearing another name.** The
 * adapter resolved its endpoint and its key with a pair of ternaries —
 * `name === 'OPENAI' ? OPENAI : GEMINI` — so any name that was not OPENAI got
 * Gemini's endpoint *and* Gemini's key. Adding ANTHROPIC without noticing would
 * have sent Anthropic's traffic to Google, with Google's key, and written
 * "ANTHROPIC" into the ledger against every pound of that spend. The ledger is
 * append-only, so that is not a mistake anybody could quietly correct later.
 *
 * **The provider-selection settings did nothing.** `AI_REASONING_PROVIDER` and
 * `AI_PERCEPTION_PROVIDER` were read into config and used by no code anywhere;
 * the adapters were built from hard-coded names. Setting either changed
 * nothing, while `.env.example` presented both as a supported choice.
 */

type MutableAiConfig = {
  openaiKey: string;
  geminiKey: string;
  anthropicKey: string;
  reasoningProvider: string;
  perceptionProvider: string;
};
const aiConfig = config.ai as unknown as MutableAiConfig;

function stub(name: AIProvider, healthy: boolean): AIProviderAdapter {
  return {
    name,
    capability: 'REASONING',
    multimodal: true,
    healthy: () => healthy,
    estimateCostMinor: () => 100,
    execute: (): Promise<ProviderResponse> => {
      throw new Error('not called');
    },
  } as unknown as AIProviderAdapter;
}

describe('every provider is routed to its own endpoint and its own key', () => {
  it('knows three providers, not two', () => {
    assert.deepEqual([...PROVIDER_NAMES].sort(), ['ANTHROPIC', 'GEMINI', 'OPENAI']);
  });

  it('gives each provider a distinct endpoint', () => {
    // The regression that matters. Two providers sharing a URL means one of
    // them is being called as the other, under the other's credential, and
    // recorded in the ledger under its own name.
    const urls = PROVIDER_NAMES.map((name) => ENDPOINTS[name].url);
    assert.equal(new Set(urls).size, urls.length, 'two providers resolve to the same endpoint');
  });

  it('sends each provider the credential it actually authenticates with', () => {
    // Headers are built from the key the adapter resolved. Anthropic uses
    // x-api-key, OpenAI a bearer token, Gemini a Google header — so a provider
    // handed the wrong key fails loudly rather than leaking it to the wrong
    // vendor, but only if the lookup is right in the first place.
    assert.ok('x-api-key' in ENDPOINTS.ANTHROPIC.headers('k'));
    assert.match(String(ENDPOINTS.OPENAI.headers('k').Authorization), /^Bearer /);
    assert.ok('x-goog-api-key' in ENDPOINTS.GEMINI.headers('k'));
  });

  it('reports itself as the provider it was constructed as', () => {
    // What goes into the ledger against the spend.
    for (const name of PROVIDER_NAMES) {
      assert.equal(new RemoteProviderAdapter(name, 'REASONING').name, name);
    }
  });

  it('holds a provider unhealthy while it has no key', () => {
    // Fail closed: an adapter with no credential must never be selected, or the
    // failover chain hands work to something that can only 401.
    const previous = aiConfig.anthropicKey;
    aiConfig.anthropicKey = '';
    try {
      assert.equal(new RemoteProviderAdapter('ANTHROPIC', 'REASONING').healthy(), false);
    } finally {
      aiConfig.anthropicKey = previous;
    }
  });
});

describe('the Anthropic request shape', () => {
  it('sends max_tokens, which this API requires and the others do not', () => {
    const body = ENDPOINTS.ANTHROPIC.body({ task: 't', payload: {} } as ProviderRequest, 'reasoning') as {
      max_tokens?: number;
      model?: string;
    };
    assert.ok(typeof body.max_tokens === 'number' && body.max_tokens > 0);
  });

  it('escalates the model for a deep reasoning request', () => {
    const shallow = ENDPOINTS.ANTHROPIC.body({ task: 't', payload: {} } as ProviderRequest, 'reasoning') as {
      model: string;
    };
    const deep = ENDPOINTS.ANTHROPIC.body({ task: 't', payload: {} } as ProviderRequest, 'reasoning-deep') as {
      model: string;
    };
    assert.notEqual(shallow.model, deep.model, 'a deep request used the same model as a shallow one');
  });

  it('carries media natively rather than as base64 in the text', () => {
    // Base64 stringified into a text block is the same bytes charged at text
    // rates and looked at by nothing.
    const body = ENDPOINTS.ANTHROPIC.body(
      { task: 't', payload: {}, media: { contentType: 'image/png', base64: 'AAAA' } } as ProviderRequest,
      'reasoning',
    ) as { messages: Array<{ content: Array<{ type: string }> }> };

    assert.ok(body.messages[0]!.content.some((part) => part.type === 'image'));
  });

  it('reads the text block and the token counts out of a response', () => {
    const extracted = ENDPOINTS.ANTHROPIC.extract({
      content: [{ type: 'thinking', text: 'ignore me' }, { type: 'text', text: '{"ok":true}' }],
      usage: { input_tokens: 11, output_tokens: 22 },
    });

    // The first *text* block, not the first block: a response can carry more
    // than one, and anything that is not text is not the engine's answer.
    assert.equal(extracted.text, '{"ok":true}');
    assert.equal(extracted.inputTokens, 11);
    assert.equal(extracted.outputTokens, 22);
  });

  it('survives a response with nothing usable in it', () => {
    // A provider returning an unexpected shape must not throw here — the
    // caller counts a failure and fails the adapter over.
    const extracted = ENDPOINTS.ANTHROPIC.extract({});
    assert.equal(extracted.text, '');
    assert.equal(extracted.inputTokens, 0);
  });
});

describe('the provider-selection settings actually select a provider', () => {
  it('recognises a configured provider name', () => {
    assert.equal(isProvider('ANTHROPIC'), true);
    assert.equal(isProvider('OPENAI'), true);
    assert.equal(isProvider('DEEPSEEK'), false);
  });

  it('does not treat an unknown name as a provider', () => {
    // A typo in an environment variable must not resolve to a real vendor by
    // accident, which is exactly what the old ternary did with every name it
    // did not recognise.
    assert.equal(isProvider(''), false);
    assert.equal(isProvider('openai'), false, 'case matters — the ledger records this string');
  });
});

describe('failover across three vendors', () => {
  it('uses the primary while it is healthy', () => {
    const orchestrator = new AIOrchestrator({
      reasoning: stub('OPENAI', true),
      perception: stub('GEMINI', true),
    });
    assert.equal(orchestrator.adapterFor('REASONING').name, 'OPENAI');
    assert.equal(orchestrator.adapterFor('PERCEPTION').name, 'GEMINI');
  });

  it('crosses to the other capability when the primary is failing', () => {
    // A perception outage should degrade the platform, not stop it.
    const orchestrator = new AIOrchestrator({
      reasoning: stub('OPENAI', true),
      perception: stub('GEMINI', false),
    });
    assert.equal(orchestrator.adapterFor('PERCEPTION').name, 'OPENAI');
  });

  it('refuses rather than returning an unhealthy adapter', () => {
    // Fail closed. Returning a dead adapter would reserve ACU against a call
    // that cannot succeed.
    const orchestrator = new AIOrchestrator({
      reasoning: stub('OPENAI', false),
      perception: stub('GEMINI', false),
    });
    assert.throws(() => orchestrator.adapterFor('REASONING'), /AI_UNAVAILABLE|No healthy AI provider/);
  });

  it('keeps a test\'s injected adapters isolated from the network', () => {
    // The spare chain is built from whatever keys the environment holds. A
    // suite that hands in two adapters must get exactly those two, or a test
    // of the exhausted-provider path would quietly reach a real vendor.
    const previous = aiConfig.anthropicKey;
    aiConfig.anthropicKey = 'sk-ant-set-in-the-environment';
    try {
      const orchestrator = new AIOrchestrator({
        reasoning: stub('OPENAI', false),
        perception: stub('GEMINI', false),
      });
      assert.throws(() => orchestrator.adapterFor('REASONING'), /AI_UNAVAILABLE|No healthy AI provider/);
    } finally {
      aiConfig.anthropicKey = previous;
    }
  });
});

// ── What the providers actually accept and return ──────────────────────────

describe('the schemas the engines write are the schemas each provider takes', () => {
  /*
   * Reported from a deployment with live keys on all three: every reading came
   * back "Not read".
   *
   *   GEMINI returned 400: Invalid JSON payload received. Unknown name "type"
   *   at 'generation_config.response_schema.properties[0].value':
   *   Proto field is not repeating, cannot start list
   *
   *   OPENAI returned no text at all. Nothing was read from this input.
   *
   * Two unrelated faults with one symptom, and neither could fail a test
   * before: the mock provider takes any schema and returns text in the simple
   * shape, so the suite was green while no real provider could answer.
   */

  it('gives Gemini a single type, never a list', () => {
    // The exact failure. `responseSchema` is a proto on the OpenAPI subset and
    // its `type` is one enum value; the platform writes correct JSON Schema
    // unions, which the proto rejects before the model sees anything.
    const converted = geminiSchema(outputStandardSchema()) as Record<string, unknown>;
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) { node.forEach((entry, i) => walk(entry, `${path}[${i}]`)); return; }
      if (node === null || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      assert.ok(!Array.isArray(record.type), `${path}.type is still a list — Gemini refuses the whole request`);
      for (const key of ['minLength', 'minimum', 'maximum', 'additionalProperties']) {
        assert.equal(record[key], undefined, `${path}.${key} has no field on the proto`);
      }
      if (Array.isArray(record.enum)) {
        assert.ok(!record.enum.includes(null), `${path}.enum carries null, which the proto's string enum cannot hold`);
      }
      for (const [key, value] of Object.entries(record)) walk(value, `${path}.${key}`);
    };
    walk(converted, 'schema');
  });

  it('keeps nullability rather than silently losing it', () => {
    // Dropping the null would make every optional figure required, and the
    // model would invent one rather than say it could not find it.
    const converted = geminiSchema({
      type: 'object',
      properties: { amountMinor: { type: ['number', 'null'] } },
    }) as { properties: { amountMinor: Record<string, unknown> } };
    assert.equal(converted.properties.amountMinor.type, 'number');
    assert.equal(converted.properties.amountMinor.nullable, true);
  });

  it('leaves a schema Gemini already accepts alone', () => {
    const plain = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] };
    assert.deepEqual(geminiSchema(plain), plain);
  });

  it('reads OpenAI text from wherever in the output it is', () => {
    /*
     * The Responses API returns a list. For a reasoning model the first entry
     * is a `reasoning` item with no content at all and the message follows it,
     * so reading `output[0].content[0].text` found nothing and the platform
     * reported "no text at all" for a call that had been answered and charged.
     */
    const extract = (body: unknown) => ENDPOINTS.OPENAI.extract(body);
    assert.equal(extract({ output_text: 'straight from the convenience field' }).text, 'straight from the convenience field');
    assert.equal(
      extract({
        output: [
          { type: 'reasoning' },
          { type: 'message', content: [{ type: 'output_text', text: '{"summary":"found it"}' }] },
        ],
      }).text,
      '{"summary":"found it"}',
    );
    assert.equal(extract({ output: [{ type: 'reasoning' }] }).text, '', 'an output with no message must still read as empty');
  });
});
