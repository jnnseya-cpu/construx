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
 *     debits, so the 4x rule stays anchored to real spend.
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

/**
 * What the attached file is worth in input tokens.
 *
 * Providers bill media by tiles or by seconds rather than by base64 length, and
 * the exact rule differs per vendor and changes. This is a deliberate
 * over-estimate at roughly one token per 750 bytes of original file: the figure
 * sizes a pre-flight hold, and a hold that is too small is the failure that
 * matters — the settled charge comes from the provider's own usage accounting
 * either way.
 */
function mediaTokens(request: ProviderRequest): number {
  if (!request.media) return 0;
  const bytes = Math.ceil((request.media.base64.length * 3) / 4);
  return Math.ceil(bytes / 750);
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
      {
        role: 'user',
        content: request.media
          ? [
              { type: 'input_text', text: JSON.stringify({ task: request.task, payload: request.payload }) },
              // A data URL, which is what this API accepts for an inline image.
              // Audio is not accepted on this endpoint, which is why the
              // perception pipeline checks the media type against the task
              // before it gets here rather than discovering it in a 400.
              { type: 'input_image', image_url: `data:${request.media.contentType};base64,${request.media.base64}` },
            ]
          : JSON.stringify({ task: request.task, payload: request.payload }),
      },
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
    contents: [
      {
        role: 'user',
        parts: [
          { text: JSON.stringify({ task: request.task, payload: request.payload }) },
          // Native inline media. Base64 stringified into the text part would be
          // the same bytes charged at text rates and looked at by nothing.
          ...(request.media
            ? [{ inline_data: { mime_type: request.media.contentType, data: request.media.base64 } }]
            : []),
        ],
      },
    ],
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


/**
 * Anthropic's Messages API.
 *
 * The third vendor, and the reason the failover below is worth having: with two
 * providers, a fallback is only vendor-diverse by accident of the two
 * capabilities sitting on different companies. With three, a provider can be
 * taken out of rotation and the platform still has somewhere to go.
 */
const ANTHROPIC_ENDPOINT: Endpoint = {
  url: 'https://api.anthropic.com/v1/messages',
  headers: (key) => ({
    'x-api-key': key,
    // Pinned for the same reason Stripe's is: a version rolled out on their
    // side cannot reshape what `extract` below is parsing.
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json',
  }),
  body: (request, modelClass) => ({
    model: modelClass === 'reasoning-deep' ? 'claude-opus-5' : 'claude-sonnet-5',
    // Required by this API, unlike the other two. Sized for a structured
    // engine response rather than prose; a schema-shaped answer that needs
    // more than this is a sign the engine is asking the wrong question.
    max_tokens: 8_192,
    system:
      'You are a construction domain analysis engine. Respond only with JSON matching the supplied schema. ' +
      'Never invent quantities, dates or costs that are not derivable from the supplied payload.',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: JSON.stringify({ task: request.task, payload: request.payload }) },
          // Native inline media, as with Gemini. Base64 in a text block would
          // be the same bytes charged at text rates and looked at by nothing.
          ...(request.media
            ? [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: request.media.contentType,
                    data: request.media.base64,
                  },
                },
              ]
            : []),
        ],
      },
    ],
  }),
  extract: (response) => {
    const body = response as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    return {
      // The first text block. A response can carry more than one block, and
      // anything that is not text is not the engine's answer.
      text: body.content?.find((block) => block.type === 'text')?.text ?? '',
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
    };
  },
};

/**
 * Every provider, and the key each one authenticates with.
 *
 * One table rather than a chain of ternaries: adding a fourth vendor should be
 * an entry here, not an edit to a conditional that already gets the wrong
 * answer when it grows a third branch.
 */
const PROVIDERS: Record<AIProvider, { endpoint: Endpoint; key: () => string }> = {
  OPENAI: { endpoint: OPENAI_ENDPOINT, key: () => config.ai.openaiKey },
  GEMINI: { endpoint: GEMINI_ENDPOINT, key: () => config.ai.geminiKey },
  ANTHROPIC: { endpoint: ANTHROPIC_ENDPOINT, key: () => config.ai.anthropicKey },
};

/** Whether a configured string names a provider the platform can actually call. */
export function isProvider(value: string): value is AIProvider {
  return value in PROVIDERS;
}

export const PROVIDER_NAMES = Object.keys(PROVIDERS) as AIProvider[];

export class RemoteProviderAdapter implements AIProviderAdapter {
  readonly name: AIProvider;
  readonly capability: ProviderCapability;
  /** Both endpoints below place media in their own API's native form. */
  readonly multimodal = true;
  /** Over the network, to a third party. Clearance applies. */
  readonly transmits = true;
  readonly #endpoint: Endpoint;
  readonly #apiKey: string;
  #consecutiveFailures = 0;

  constructor(name: AIProvider, capability: ProviderCapability) {
    this.name = name;
    this.capability = capability;
    // Looked up rather than branched on. The pair of ternaries this replaces
    // resolved every name that was not OPENAI to Gemini's endpoint *and*
    // Gemini's key — so a third provider would have silently been Gemini
    // wearing another name, and the ledger would have recorded the wrong
    // vendor against every pound of that spend.
    const provider = PROVIDERS[name];
    this.#endpoint = provider.endpoint;
    this.#apiKey = provider.key();
  }

  /** Three consecutive failures takes the adapter out of rotation for failover. */
  healthy(): boolean {
    return this.#apiKey !== '' && this.#consecutiveFailures < 3;
  }

  estimateCostMinor(request: ProviderRequest): number {
    const modelClass = request.modelClass ?? this.#defaultModelClass();
    // Media counts. A 4MB photograph carries orders of magnitude more input
    // than the JSON describing it, and an estimate that ignored it would size
    // the ACU hold from the wrong number entirely — the customer would be
    // quoted pennies and charged pounds.
    const inputTokens = estimateTokens(request.payload) + mediaTokens(request) + 400;
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

/**
 * The two request shapes, exported so a test can check that a file is attached
 * where each vendor expects it.
 *
 * No call to either vendor has been made from this repository, so the alternative
 * to inspecting the built body is inspecting nothing: an `inline_data` part that
 * had silently become a text part would look identical from the outside and cost
 * the same, while the model saw no drawing at all.
 */
export const ENDPOINTS = { OPENAI: OPENAI_ENDPOINT, GEMINI: GEMINI_ENDPOINT, ANTHROPIC: ANTHROPIC_ENDPOINT };

/**
 * Resolve a configured provider name, falling back to a default it announces.
 *
 * `AI_REASONING_PROVIDER` and `AI_PERCEPTION_PROVIDER` were read into config
 * and never used by anything — the adapters below were constructed from
 * hard-coded names, so setting either variable changed nothing at all. A knob
 * that does nothing is worse than no knob: it reads as a supported choice.
 */
function configured(value: string, fallback: AIProvider): AIProvider {
  return isProvider(value) ? value : fallback;
}

export const remoteReasoning = new RemoteProviderAdapter(
  configured(config.ai.reasoningProvider, 'OPENAI'),
  'REASONING',
);
export const remotePerception = new RemoteProviderAdapter(
  configured(config.ai.perceptionProvider, 'GEMINI'),
  'PERCEPTION',
);

/**
 * Every provider that holds a key, as adapters available for failover.
 *
 * Built from the key table rather than from the two primaries, so a third
 * vendor configured with nothing but a key is still somewhere to go when the
 * other two are failing.
 */
export function spareAdapters(capability: ProviderCapability): AIProviderAdapter[] {
  return PROVIDER_NAMES.filter((name) => PROVIDERS[name].key() !== '').map(
    (name) => new RemoteProviderAdapter(name, capability),
  );
}
