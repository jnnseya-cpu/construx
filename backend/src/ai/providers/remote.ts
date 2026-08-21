import { config } from '../../config.ts';
import { canonicalize } from '../../core/canonical.ts';
import { DomainError } from '../../core/errors.ts';
import type { AIProvider } from '../../goldenthread/types.ts';
import type { AIProviderAdapter, ProviderCapability, ProviderRequest, ProviderResponse } from './types.ts';

/**
 * Live provider adapters, used when AI_MODE is staging or production.
 *
 * Two rules hold regardless of vendor:
 *   - The model is asked for structured JSON against a schema. Prose is never
 *     accepted as state; it can only ever be narrative attached to a record.
 *   - Cost is read back from the provider's own usage accounting and converted
 *     to minor units. That figure — not an estimate — is what the ACU ledger
 *     debits, so the 3x rule stays anchored to real spend.
 */

type PricingTable = { inputPerMillion: number; outputPerMillion: number };

/**
 * Per-million-token prices in USD minor units (cents). These are configuration,
 * not constants of nature: update them when provider pricing moves. The ACU
 * model stays correct either way because the multiplier applies to whatever
 * cost is computed here.
 */
const PRICING: Record<string, PricingTable> = {
  'reasoning-standard': { inputPerMillion: 150, outputPerMillion: 600 },
  'reasoning-deep': { inputPerMillion: 500, outputPerMillion: 1500 },
  'perception-standard': { inputPerMillion: 30, outputPerMillion: 120 },
  'perception-large-context': { inputPerMillion: 125, outputPerMillion: 500 },
};

function priceFor(modelClass: string, inputTokens: number, outputTokens: number): number {
  const table = PRICING[modelClass] ?? PRICING['reasoning-standard'];
  const cost = (inputTokens / 1_000_000) * (table as PricingTable).inputPerMillion +
    (outputTokens / 1_000_000) * (table as PricingTable).outputPerMillion;
  return Math.max(1, Math.ceil(cost));
}

/** Rough token estimate for pre-flight cost holds. 4 chars per token is the usual heuristic. */
function estimateTokens(payload: unknown): number {
  return Math.ceil(canonicalize(payload).length / 4);
}

type Endpoint = {
  url: string;
  headers: (key: string) => Record<string, string>;
  body: (request: ProviderRequest, modelClass: string) => unknown;
  extract: (response: unknown) => { text: string; inputTokens: number; outputTokens: number };
};

const OPENAI_ENDPOINT: Endpoint = {
  url: 'https://api.openai.com/v1/responses',
  headers: (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }),
  body: (request, modelClass) => ({
    model: modelClass === 'reasoning-deep' ? 'gpt-5' : 'gpt-5-mini',
    input: [
      {
        role: 'system',
        content:
          'You are a construction domain analysis engine. Respond only with JSON matching the supplied schema. ' +
          'Never invent quantities, dates or costs that are not derivable from the supplied payload.',
      },
      { role: 'user', content: JSON.stringify({ task: request.task, payload: request.payload }) },
    ],
    text: request.responseSchema
      ? { format: { type: 'json_schema', name: 'engine_output', schema: request.responseSchema, strict: false } }
      : { format: { type: 'json_object' } },
  }),
  extract: (response) => {
    const body = response as {
      output_text?: string;
      output?: Array<{ content?: Array<{ text?: string }> }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = body.output_text ?? body.output?.[0]?.content?.[0]?.text ?? '';
    return {
      text,
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
    };
  },
};

const GEMINI_ENDPOINT: Endpoint = {
  url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
  headers: (key) => ({ 'x-goog-api-key': key, 'Content-Type': 'application/json' }),
  body: (request) => ({
    contents: [{ role: 'user', parts: [{ text: JSON.stringify({ task: request.task, payload: request.payload }) }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      ...(request.responseSchema ? { responseSchema: request.responseSchema } : {}),
    },
  }),
  extract: (response) => {
    const body = response as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    return {
      text: body.candidates?.[0]?.content?.parts?.[0]?.text ?? '',
      inputTokens: body.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
    };
  },
};

export class RemoteProviderAdapter implements AIProviderAdapter {
  readonly name: AIProvider;
  readonly capability: ProviderCapability;
  readonly #endpoint: Endpoint;
  readonly #apiKey: string;
  #consecutiveFailures = 0;

  constructor(name: AIProvider, capability: ProviderCapability) {
    this.name = name;
    this.capability = capability;
    this.#endpoint = name === 'OPENAI' ? OPENAI_ENDPOINT : GEMINI_ENDPOINT;
    this.#apiKey = name === 'OPENAI' ? config.ai.openaiKey : config.ai.geminiKey;
  }

  /** Three consecutive failures takes the adapter out of rotation for failover. */
  healthy(): boolean {
    return this.#apiKey !== '' && this.#consecutiveFailures < 3;
  }

  estimateCostMinor(request: ProviderRequest): number {
    const modelClass = request.modelClass ?? this.#defaultModelClass();
    const inputTokens = estimateTokens(request.payload) + 400;
    // Assume output is a quarter of input until the call reports otherwise.
    return priceFor(modelClass, inputTokens, Math.ceil(inputTokens / 4));
  }

  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    if (this.#apiKey === '') {
      throw new DomainError('AI_PROVIDER_UNCONFIGURED', `${this.name} API key is not configured`, 503);
    }

    const modelClass = request.modelClass ?? this.#defaultModelClass();
    const started = Date.now();

    try {
      const response = await fetch(this.#endpoint.url, {
        method: 'POST',
        headers: this.#endpoint.headers(this.#apiKey),
        body: JSON.stringify(this.#endpoint.body(request, modelClass)),
        signal: AbortSignal.timeout(120_000),
      });

      if (!response.ok) {
        this.#consecutiveFailures += 1;
        const detail = await response.text().catch(() => '');
        throw new DomainError(
          'AI_PROVIDER_ERROR',
          `${this.name} returned ${response.status}: ${detail.slice(0, 200)}`,
          502,
        );
      }

      const { text, inputTokens, outputTokens } = this.#endpoint.extract(await response.json());
      this.#consecutiveFailures = 0;

      let output: Record<string, unknown>;
      try {
        output = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // Unparseable output is a failed execution, not a partial result: the
        // engine would otherwise be free to write prose into the Golden Thread.
        throw new DomainError('AI_OUTPUT_UNPARSEABLE', `${this.name} did not return valid JSON`, 502);
      }

      return {
        provider: this.name,
        modelClass,
        output,
        rawCostMinor: priceFor(modelClass, inputTokens, outputTokens),
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      this.#consecutiveFailures += 1;
      throw new DomainError('AI_PROVIDER_UNREACHABLE', `${this.name} call failed: ${String(error)}`, 502);
    }
  }

  #defaultModelClass(): string {
    return this.capability === 'PERCEPTION' ? 'perception-standard' : 'reasoning-standard';
  }
}

export const remoteReasoning = new RemoteProviderAdapter('OPENAI', 'REASONING');
export const remotePerception = new RemoteProviderAdapter('GEMINI', 'PERCEPTION');
