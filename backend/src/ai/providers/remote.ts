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

/**
 * What one call to a vendor came back with, before anybody tries to read it.
 *
 * `stopReason` and `cutShort` are here because the three failures that matter
 * are indistinguishable once the text is all you have. A reply cut off at the
 * token ceiling, a reply suppressed by a content filter and a reply the model
 * simply wrote badly all arrive as "this is not JSON", and only the first two
 * are the operator's to fix.
 */
type ModelReply = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** The vendor's own word for why generation stopped, where it gives one. */
  stopReason?: string;
  /** The generation hit a ceiling or a filter, so what arrived is not the whole answer. */
  cutShort?: boolean;
};

type Endpoint = {
  url: string;
  headers: (key: string) => Record<string, string>;
  body: (request: ProviderRequest, modelClass: string) => unknown;
  extract: (response: unknown) => ModelReply;
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
      status?: string;
      incomplete_details?: { reason?: string };
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = body.output_text ?? body.output?.[0]?.content?.[0]?.text ?? '';
    // This API says so at the top level rather than per-choice: `status:
    // "incomplete"` with a reason. Reading the text without reading this is how
    // a half-finished answer becomes a whole record.
    const stopReason = body.status === 'incomplete' ? (body.incomplete_details?.reason ?? 'incomplete') : undefined;
    return {
      text,
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
      stopReason,
      cutShort: body.status === 'incomplete',
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
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      promptFeedback?: { blockReason?: string };
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const candidate = body.candidates?.[0];
    const finish = candidate?.finishReason;
    // STOP is the whole answer. Everything else means generation ended for a
    // reason the caller has to be told: the ceiling, a safety filter, or a
    // recitation block. A blocked *prompt* produces no candidate at all, so
    // that reason is read from the feedback instead.
    const stopReason = body.promptFeedback?.blockReason ?? (finish && finish !== 'STOP' ? finish : undefined);
    return {
      text: candidate?.content?.parts?.[0]?.text ?? '',
      inputTokens: body.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
      stopReason,
      cutShort: stopReason !== undefined,
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
          {
            type: 'text',
            // The schema travels in the message because this API has no field
            // for one. It was being dropped entirely: the system prompt above
            // said "matching the supplied schema" and no schema was supplied,
            // so the only vendor of the three without structured-output
            // enforcement was also the only one not told what shape to answer
            // in. Every field name the engine will read is now in front of the
            // model.
            text: JSON.stringify({
              task: request.task,
              payload: request.payload,
              ...(request.responseSchema ? { responseSchema: request.responseSchema } : {}),
            }),
          },
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
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    // `end_turn` is the model finishing. `max_tokens` is the 8,192 ceiling
    // above cutting it off mid-answer, which on a large take-off is the
    // likeliest failure of the lot.
    const stop = body.stop_reason;
    const cutShort = stop !== undefined && stop !== 'end_turn' && stop !== 'stop_sequence';
    return {
      // The first text block. A response can carry more than one block, and
      // anything that is not text is not the engine's answer.
      text: body.content?.find((block) => block.type === 'text')?.text ?? '',
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
      stopReason: cutShort ? stop : undefined,
      cutShort,
    };
  },
};

/**
 * Find the JSON object inside whatever the model actually sent.
 *
 * Scans for the first `{`, then walks to its matching `}` while respecting
 * string literals and escapes — so a brace inside `"description": "bay {3}"`
 * does not close the object early. Returns undefined when there is no balanced
 * object to find, which includes the truncated case: a reply cut off mid-object
 * never balances.
 */
function firstBalancedObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let at = start; at < text.length; at += 1) {
    const char = text[at];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, at + 1);
    }
  }
  return undefined;
}

/**
 * Turn one model reply into the structured output an engine may act on.
 *
 * Exported because this is the single most dangerous function in the AI path
 * and no live provider call has ever been made from this repository. Everything
 * downstream — a title block entering the drawing register, a take-off becoming
 * BoQ items, an NCR raised against a photograph — depends on this reading the
 * reply the way a real vendor actually sends it, and the only way to establish
 * that without a key is to test this directly against the shapes vendors send.
 *
 * It was `JSON.parse(text)`, bare, with the result cast to an object. Three
 * things were wrong with that, and all three fire on live traffic:
 *
 *   1. **Fenced and prefaced replies.** A model told in a system prompt to
 *      answer in JSON very often answers "Here is the title block:" and then a
 *      ```json block. Bare `JSON.parse` throws. The vendor has already billed
 *      the tokens, the customer's hold is released, and the platform absorbs a
 *      charge that reaches no ledger.
 *   2. **Valid JSON that is not an object.** `null`, `[]`, `42` and a quoted
 *      refusal all parse. The cast to `Record<string, unknown>` made them
 *      objects to the type system only; `null` then reached the ledger as a
 *      draft's extraction and crashed the legibility check afterwards — a 500,
 *      with the null already committed.
 *   3. **Truncation read as malformation.** An answer cut off at the token
 *      ceiling is refused here even in the rare case it still parses, because a
 *      take-off truncated at item 140 of 200 is a *plausible* partial answer,
 *      and a plausible partial answer is worse than an unreadable one.
 *
 * Every refusal names the vendor and shows a bounded excerpt of what came back,
 * because "the provider did not return valid JSON" is not something an operator
 * can act on and "GEMINI returned: I cannot read this drawing…" is.
 */
export function parseModelOutput(reply: ModelReply, provider: AIProvider): Record<string, unknown> {
  const text = reply.text.trim();

  if (reply.cutShort) {
    throw new DomainError(
      'AI_OUTPUT_TRUNCATED',
      `${provider} stopped before finishing its answer (${reply.stopReason ?? 'reason not given'}). ` +
        'What arrived is part of an answer, and a partial answer is not a safe record. ' +
        'Retry with a smaller input, or raise the output ceiling for this model.',
      502,
    );
  }

  if (text === '') {
    // Distinct from unparseable on purpose: an empty completion is almost
    // always a filter or a refusal, and telling the operator "not valid JSON"
    // sends them to look at a schema when the answer is that the model declined.
    throw new DomainError(
      'AI_OUTPUT_EMPTY',
      `${provider} returned no text at all. Nothing was read from this input.`,
      502,
    );
  }

  // Whole reply first — the common case for a vendor honouring a response
  // schema, and the only one where nothing has to be guessed at.
  const candidates: string[] = [text];

  // ```json … ``` or a bare fence. Taking the fence contents rather than
  // stripping the markers, so a trailing sentence after the block is discarded
  // with the rest of the prose.
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const balanced = firstBalancedObject(text);
  if (balanced) candidates.push(balanced);

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    // The check the cast was standing in for. An array, a number, a string and
    // null are all valid JSON and none of them is an engine output.
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new DomainError(
      'AI_OUTPUT_NOT_AN_OBJECT',
      `${provider} returned ${parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : typeof parsed} ` +
        'where the engine requires a JSON object. Nothing has been recorded against this request.',
      502,
    );
  }

  throw new DomainError(
    'AI_OUTPUT_UNPARSEABLE',
    `${provider} did not return JSON the engine could read. It returned: ${excerpt(text)}`,
    502,
  );
}

/** Enough of a reply to diagnose it, never enough to fill a log with a drawing. */
function excerpt(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine;
}

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

      const reply = this.#endpoint.extract(await response.json());

      // Unreadable output is a failed execution, not a partial result: the
      // engine would otherwise be free to write prose into the Golden Thread.
      //
      // Counted as a failure, which it previously was not. The reset used to
      // happen here, before the parse, so a provider answering 200 OK with
      // something unreadable on every single call stayed "healthy" for ever:
      // never taken out of rotation, never failed over from, billing the vendor
      // in full for every request while every caller got a 502. Health is now
      // reset only once an answer has actually been read.
      let output: Record<string, unknown>;
      try {
        output = parseModelOutput(reply, this.name);
      } catch (error) {
        this.#consecutiveFailures += 1;
        throw error;
      }
      this.#consecutiveFailures = 0;
      const { inputTokens, outputTokens } = reply;

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
