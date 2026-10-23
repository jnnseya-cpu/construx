import { config } from '../../config.ts';
import { secretFor } from '../../identity/credentials.ts';
import { canonicalize } from '../../core/canonical.ts';
import { DomainError } from '../../core/errors.ts';
import type { AIProvider } from '../../goldenthread/types.ts';
import type { AIProviderAdapter, ProviderCapability, ProviderRequest, ProviderResponse } from './types.ts';
import { postJson, type VendorReply } from './transport.ts';

/**
 * Live provider adapters, used when AI_MODE is staging or production.
 *
 * Two rules hold regardless of vendor:
 *   - The model is asked for structured JSON against a schema. Prose is never
 *     accepted as state; it can only ever be narrative attached to a record.
 *   - Cost is read back from the provider's own usage accounting and converted
 *     to minor units. That figure — not an estimate — is what the ACU ledger
 *     debits, so the 5x rule stays anchored to real spend.
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

/** Characters per token, at the 4:1 heuristic above. Used to size a text budget. */
export const CHARS_PER_TOKEN = 4;

/**
 * What a reply, a system prompt and the API's own scaffolding cost on top of
 * the payload. A flat allowance: the point is that the measurement is never
 * *under* the real figure, not that it is exact.
 */
const PROMPT_OVERHEAD_TOKENS = 400;

/**
 * What one page of a document is worth in input tokens.
 *
 * A vendor handed a PDF does not read it as text. It renders each page and
 * charges for the picture as well as for whatever words it recovers, so the
 * cost scales with **pages**, not with bytes — and a 200-page scan that
 * compresses to 3MB is worth far more input than 3MB of photograph. 2,000 is
 * deliberately above what a plain page of A4 costs at any of the three vendors:
 * an under-estimate here is an input sent that cannot fit, which is the failure
 * this number exists to prevent.
 */
const TOKENS_PER_PAGE = 2_000;

/**
 * What each vendor's models will hold, and how much of it is kept back for the
 * answer.
 *
 * Configuration, like `PRICING` above, and on the same terms: these are vendor
 * facts that move, and the platform stays correct when they do because every
 * budget is read through `inputBudgetTokens` rather than assumed anywhere.
 *
 * The reserve is not optional arithmetic. A vendor's window is shared between
 * what goes in and what comes back: an input sized to the whole window leaves
 * no room for the answer, and the result is not a refusal but a reply cut off
 * mid-JSON — which `parseModelOutput` then refuses as truncated, after the call
 * has been billed in full.
 */
const WINDOWS: Record<AIProvider, { windowTokens: number; outputReserveTokens: number }> = {
  // gpt-5 and gpt-5-mini: a 400,000-token window, of which the documented
  // maximum output is 128,000.
  OPENAI: { windowTokens: 400_000, outputReserveTokens: 128_000 },
  // gemini-2.5-pro: 1,048,576 input tokens, 65,536 output.
  GEMINI: { windowTokens: 1_048_576, outputReserveTokens: 65_536 },
  // The Claude models this adapter names take 200,000, and `max_tokens` below
  // caps the answer at 8,192 — so the reserve is that cap, not a guess.
  ANTHROPIC: { windowTokens: 200_000, outputReserveTokens: 8_192 },
};

function inputBudgetOf(provider: AIProvider): number {
  const window = WINDOWS[provider];
  return window.windowTokens - window.outputReserveTokens;
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
  const media = request.media;
  if (!media) return 0;
  const bytes = Math.ceil((media.base64.length * 3) / 4);
  // Whichever reads larger. Bytes alone understate a scan — the whole point of
  // `TOKENS_PER_PAGE` — and pages alone understate a single enormous image.
  return Math.max(Math.ceil(bytes / 750), (media.pages ?? 0) * TOKENS_PER_PAGE);
}

/**
 * What this request will cost in input tokens, near enough to decide whether it
 * fits.
 *
 * One function for the two questions that were being answered differently: how
 * big a hold to place, and whether the vendor will accept the call at all. The
 * hold was sized from `payload` alone, which left out the task, the schema and
 * — before `mediaTokens` existed — the file; and nothing at all answered the
 * second question, so an input past the window was discovered as a vendor 400.
 *
 * Deliberately an over-estimate. The settled charge comes from the provider's
 * own usage accounting either way, so the cost of reading high is a hold that
 * is slightly too large, and the cost of reading low is a call that fails after
 * the customer has committed to it.
 */
export function requestInputTokens(request: ProviderRequest): number {
  return (
    estimateTokens({
      task: request.task,
      payload: request.payload,
      schema: request.responseSchema ?? null,
    }) +
    mediaTokens(request) +
    PROMPT_OVERHEAD_TOKENS
  );
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
  /** The most input one call here may carry, after the answer's reserve. */
  inputBudgetTokens: number;
  /** The most one answer may be. The other half of the window. */
  answerBudgetTokens: number;
};

/**
 * The engine schemas, in the shape Gemini's `responseSchema` will accept.
 *
 * ## What happened
 *
 * Every Gemini call failed with:
 *
 *     400 Invalid JSON payload received. Unknown name "type" at
 *     'generation_config.response_schema.properties[0].value':
 *     Proto field is not repeating, cannot start list
 *
 * `responseSchema` is a proto built on the OpenAPI 3 subset, not JSON Schema.
 * Its `type` is a single enum value. The platform's schemas express "a number
 * or nothing" the JSON Schema way — `type: ['number', 'null']` — and a list
 * where the proto wants a scalar is rejected before the model sees anything.
 * The first such property in `outputStandardSchema` is `amountMinor`, which is
 * `properties[0].value` in the message above.
 *
 * Nothing about the schemas was wrong. They are correct JSON Schema, OpenAI and
 * Anthropic take them as they are, and this is the one provider that needs them
 * translated — so the translation lives here, in its adapter, rather than
 * narrowing every engine's schema to the least capable provider.
 *
 * ## What it does
 *
 * - `type: ['x', 'null']` becomes `type: 'x'` with `nullable: true`.
 * - An `enum` containing `null` drops the null and becomes nullable, because
 *   the proto's enum is a list of strings.
 * - Validation keywords the proto has no field for — `minLength`, `minimum`,
 *   `maximum`, `pattern`, `additionalProperties`, `const` — are dropped. They
 *   are bounds, not structure: losing them means a value this platform would
 *   have rejected can come back, and `conformToOutputStandard` rejects it on
 *   arrival exactly as it does for any other provider. Keeping them would mean
 *   no answer at all.
 */
export function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map((entry) => geminiSchema(entry));
  if (schema === null || typeof schema !== 'object') return schema;

  const DROPPED = new Set(['minLength', 'maxLength', 'minimum', 'maximum', 'pattern', 'additionalProperties', 'const', '$schema']);
  const source = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let nullable = false;

  for (const [key, value] of Object.entries(source)) {
    if (DROPPED.has(key)) continue;

    if (key === 'type' && Array.isArray(value)) {
      const named = value.filter((entry) => entry !== 'null');
      if (named.length !== value.length) nullable = true;
      // A union of two real types has no proto equivalent; the first is the one
      // the engines mean, and the rest were only ever there to allow absence.
      out.type = named[0] ?? 'string';
      continue;
    }

    if (key === 'enum' && Array.isArray(value)) {
      const named = value.filter((entry) => entry !== null && entry !== undefined);
      if (named.length !== value.length) nullable = true;
      out.enum = named;
      continue;
    }

    out[key] = geminiSchema(value);
  }

  if (nullable) out.nullable = true;
  return out;
}

/**
 * Whether an attachment is a document rather than a picture.
 *
 * Every adapter here sent whatever it was given as an **image**, which is right
 * for a site photograph and wrong for a PDF — and a tender arrives as PDFs.
 * OpenAI refused it outright ("Expected a base64-encoded data URL with an image
 * MIME type"), which is the good outcome; the quiet one would have been a
 * provider accepting the bytes and answering about nothing.
 *
 * Each vendor carries a document differently — OpenAI as `input_file` with a
 * filename, Anthropic as a `document` block, Gemini as the same `inline_data`
 * it uses for everything — so the branch lives at each call site and the
 * question being asked lives here.
 */
function isDocument(contentType: string): boolean {
  return contentType === 'application/pdf';
}

const OPENAI_ENDPOINT: Endpoint = {
  url: 'https://api.openai.com/v1/responses',
  inputBudgetTokens: inputBudgetOf('OPENAI'),
  answerBudgetTokens: WINDOWS.OPENAI.outputReserveTokens,
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
              // A data URL either way, under the part type this API expects
              // for the kind of file it is. Audio is not accepted on this
              // endpoint, which is why the perception pipeline checks the
              // media type against the task before it gets here rather than
              // discovering it in a 400.
              isDocument(request.media.contentType)
                ? {
                    type: 'input_file',
                    // Named from the hash rather than invented. The API wants a
                    // filename and the platform does not keep one — the chain
                    // is over content, not over what a device called the file.
                    filename: `${(request.media.hash ?? 'document').replace(':', '-')}.pdf`,
                    file_data: `data:${request.media.contentType};base64,${request.media.base64}`,
                  }
                : { type: 'input_image', image_url: `data:${request.media.contentType};base64,${request.media.base64}` },
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
    /*
     * Every output item, not the first one.
     *
     * This read `output[0].content[0].text`. The Responses API returns a list,
     * and for a reasoning model the first item is a `reasoning` entry carrying
     * no `content` at all — the message comes after it. So the text was never
     * found, `''` came back, and the platform reported "OPENAI returned no text
     * at all. Nothing was read from this input" for a call the provider had
     * answered perfectly well and charged for.
     *
     * `output_text` is the convenience field and is used when present; the walk
     * is the fallback for every shape that does not carry it.
     */
    const text =
      body.output_text ??
      (body.output ?? [])
        .flatMap((item) => item.content ?? [])
        .map((part) => part.text ?? '')
        .find((candidate) => candidate.trim() !== '') ??
      '';
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
  inputBudgetTokens: inputBudgetOf('GEMINI'),
  answerBudgetTokens: WINDOWS.GEMINI.outputReserveTokens,
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
      ...(request.responseSchema ? { responseSchema: geminiSchema(request.responseSchema) } : {}),
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
  inputBudgetTokens: inputBudgetOf('ANTHROPIC'),
  answerBudgetTokens: WINDOWS.ANTHROPIC.outputReserveTokens,
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
            //
            // The schema as written, not the narrowed one Gemini's proto needs.
            // Nothing here is parsed by a proto — it is read by the model — so
            // the bounds Gemini has no field for (`minLength`, `minimum`) are
            // worth keeping: they are instructions to it.
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
                  // A PDF is a document to this API and an image is an image.
                  // Sending one as the other is refused, which is the kind
                  // outcome; the unkind one is a provider that accepts it.
                  type: isDocument(request.media.contentType) ? 'document' : 'image',
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

/**
 * Why a call never got an answer, in words an operator can act on.
 *
 * ## What happened
 *
 * A live run reported, in full:
 *
 *     AI_PROVIDER_UNREACHABLE — OPENAI call failed: TypeError: fetch failed
 *
 * That is the whole of what `String(error)` yields, and it is the same sentence
 * for a DNS failure, a refused connection, an expired certificate, a proxy that
 * denied the request, a socket the vendor closed mid-answer and a network that
 * went away. Node puts the actual reason in `error.cause` — one or two levels
 * down, and in an `AggregateError` when a host resolves to several addresses
 * and every one of them failed. None of it was being read, so an operator was
 * told their AI was broken and given nothing to check.
 *
 * ## The distinction that costs money
 *
 * These failures are not one kind of thing, and the difference decides what
 * happens to the customer's hold:
 *
 *   - **Nothing was sent.** DNS did not resolve, the connection was refused,
 *     the certificate did not verify, the proxy said no. The vendor has no
 *     record of a request, so the failure is *certain*: the hold goes back, and
 *     one retry is safe because there is nothing to duplicate.
 *   - **The call was in flight.** The socket was reset, the other side closed,
 *     the headers or the body timed out. The request may have arrived in full
 *     and been answered and billed, with only the answer lost. That is the same
 *     unknown outcome as the deadline case (§10.2): the hold is **parked** for
 *     the operator to reconcile against the vendor's own account, never
 *     silently released and never charged, and it is never retried
 *     automatically — a retry there is a second call the vendor may bill.
 *
 * `transportFailure` classifies it and says the host, the code and the chain of
 * causes. Nothing from the request body is in the message.
 */
type TransportFailure = {
  /** `CONNECT` — nothing reached the vendor. `IN_FLIGHT` — the outcome is unknown. */
  stage: 'CONNECT' | 'IN_FLIGHT';
  /** The vendor's own code, where it gave one: `ENOTFOUND`, `ECONNRESET`, `UND_ERR_SOCKET`. */
  code: string;
  /** The cause chain, outermost first, as one line. */
  because: string;
};

/**
 * Codes for a failure that happened **before** the request was transmitted.
 *
 * Everything not named here is treated as in-flight, which is the safe
 * direction: an unknown code becomes a parked hold an operator looks at, never
 * a release that forgives a charge the vendor is going to make, and never an
 * automatic retry.
 */
const CONNECT_CODES = new Set([
  // Name resolution.
  'ENOTFOUND', 'EAI_AGAIN',
  // Nothing listening, nothing routable, or the host refused outright.
  'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EACCES', 'EPERM',
  // The connect attempt itself timed out, before any byte of the request.
  'UND_ERR_CONNECT_TIMEOUT',
  // TLS: the certificate chain was refused, so the session was never established.
  'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export function transportFailure(error: unknown): TransportFailure {
  const reasons: string[] = [];
  let code = '';
  /*
   * What the transport itself knows, where it knows it.
   *
   * `postJson` records whether the request body was fully written and whether
   * a status line came back, so the stage is a **fact** rather than an
   * inference from an error code. The code table below stays for the cases
   * nothing observed — an error thrown before the request was built, or one
   * raised by something other than this transport.
   */
  const observed = error as { sent?: unknown; responded?: unknown };
  const sawTransport = typeof observed.sent === 'boolean';

  // Down the `cause` chain, and through an `AggregateError`'s branches, which
  // is the shape a host with an IPv6 and an IPv4 address produces when both
  // refuse. Bounded, because a cause chain is a graph somebody else built.
  const visit = (value: unknown, depth: number): void => {
    if (value === null || typeof value !== 'object' || depth > 4) return;
    const node = value as { message?: unknown; code?: unknown; errno?: unknown; syscall?: unknown; cause?: unknown; errors?: unknown };
    const message = typeof node.message === 'string' ? node.message : '';
    const named = typeof node.code === 'string' ? node.code : '';
    if (named !== '' && code === '') code = named;
    const syscall = typeof node.syscall === 'string' ? ` (${node.syscall})` : '';
    const line = `${message}${named === '' || message.includes(named) ? '' : ` [${named}]`}${syscall}`.trim();
    if (line !== '' && !reasons.includes(line)) reasons.push(line);
    if (Array.isArray(node.errors)) for (const branch of node.errors) visit(branch, depth + 1);
    visit(node.cause, depth + 1);
  };
  visit(error, 0);

  return {
    stage: sawTransport
      ? // Nothing was written and nothing came back: the vendor never saw it.
        observed.sent === false && observed.responded === false
        ? 'CONNECT'
        : 'IN_FLIGHT'
      : CONNECT_CODES.has(code)
        ? 'CONNECT'
        : 'IN_FLIGHT',
    code: code === '' ? 'unknown' : code,
    because: reasons.length > 0 ? reasons.join(' <- ') : String(error),
  };
}

/**
 * The refusals whose outcome at the vendor is **unknown**.
 *
 * Read by the orchestrator, which parks the hold for these and releases it for
 * every other failure. One exported set rather than a code compared in two
 * files, because the consequence of the two disagreeing is a customer charged
 * for a call nobody can account for, or a charge the platform absorbs.
 */
export const UNRESOLVED_PROVIDER_CODES = new Set(['AI_PROVIDER_TIMEOUT', 'AI_PROVIDER_DROPPED']);

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
  // The credential store first, then the environment.
  //
  // That order because the store is the newer and revocable place: clearing a
  // credential there falls back to whatever `.env` holds rather than leaving
  // the platform with nothing — unless the operator has retired that copy,
  // which is the third clause and the reason the rule now lives in one
  // function instead of being spelled out here. A deployment configured
  // entirely through the environment behaves exactly as it did.
  OPENAI: { endpoint: OPENAI_ENDPOINT, key: () => secretFor('OPENAI_API_KEY') },
  GEMINI: { endpoint: GEMINI_ENDPOINT, key: () => secretFor('GEMINI_API_KEY') },
  ANTHROPIC: { endpoint: ANTHROPIC_ENDPOINT, key: () => secretFor('ANTHROPIC_API_KEY') },
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
  /** This vendor's window, less the room its answer needs. */
  readonly inputBudgetTokens: number;
  /** The most this vendor will write in one answer. */
  readonly answerBudgetTokens: number;
  readonly #endpoint: Endpoint;
  readonly #apiKey: string;
  #consecutiveFailures = 0;

  /**
   * @param endpoint Answer somewhere other than the vendor's own address.
   *
   * The seam a test needs to behave as a vendor does. It exists because the
   * alternative — replacing `globalThis.fetch` — stopped working the day this
   * adapter started using the platform's own transport, and because a test
   * that swaps the transport out is not testing the transport. With an
   * endpoint pointed at a local server, the status handling, the JSON parse
   * and the socket are all the real ones.
   */
  constructor(name: AIProvider, capability: ProviderCapability, endpoint?: Endpoint) {
    this.name = name;
    this.capability = capability;
    // Looked up rather than branched on. The pair of ternaries this replaces
    // resolved every name that was not OPENAI to Gemini's endpoint *and*
    // Gemini's key — so a third provider would have silently been Gemini
    // wearing another name, and the ledger would have recorded the wrong
    // vendor against every pound of that spend.
    const provider = PROVIDERS[name];
    this.#endpoint = endpoint ?? provider.endpoint;
    this.#apiKey = provider.key();
    this.inputBudgetTokens = this.#endpoint.inputBudgetTokens;
    this.answerBudgetTokens = this.#endpoint.answerBudgetTokens;
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
    const inputTokens = requestInputTokens(request);
    // Assume output is a quarter of input until the call reports otherwise.
    return priceFor(modelClass, inputTokens, Math.ceil(inputTokens / 4));
  }

  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    if (this.#apiKey === '') {
      throw new DomainError('AI_PROVIDER_UNCONFIGURED', `${this.name} API key is not configured`, 503);
    }

    /*
     * The window, checked here rather than learned from a 400.
     *
     * The orchestrator routes around this: it measures the request and picks a
     * vendor whose window holds it, so a call reaching this line past the
     * budget means somebody built a request and executed an adapter directly.
     * It is still refused, and refused *before* the socket opens — the vendor
     * would reject it anyway, and a provider error costs the caller a failed
     * command and an operator a line in the log that reads like an outage.
     *
     * Not counted against health. Nothing is wrong with the vendor.
     */
    const inputTokens = requestInputTokens(request);
    if (inputTokens > this.inputBudgetTokens) {
      throw new DomainError(
        'AI_INPUT_TOO_LARGE',
        `This call carries about ${Math.ceil(inputTokens / 1_000)}k tokens of input and ${this.name} accepts ` +
          `${Math.floor(this.inputBudgetTokens / 1_000)}k in one request. Nothing was sent and nothing was charged.`,
        413,
      );
    }

    const modelClass = request.modelClass ?? this.#defaultModelClass();
    const started = Date.now();

    try {
      /*
       * No deadline, by default and by decision.
       *
       * This was `AbortSignal.timeout(120_000)` — a business value hardcoded in
       * a transport file, and the wrong one. A perception task over a full
       * drawing set and a reasoning task with a long schema both genuinely
       * exceed two minutes, and every one of them was aborted at the deadline
       * and parked as an unknown outcome for an operator to reconcile: the work
       * was done, the vendor billed for it, and the customer got a 504.
       *
       * The rule is that AI work runs until it produces the answer, so the
       * deadline comes from configuration and its default is none. A deployment
       * that would rather refuse than wait sets `AI_PROVIDER_DEADLINE_MS`.
       */
      const deadlineMs = config.ai.providerDeadlineMs;
      const body = JSON.stringify(this.#endpoint.body(request, modelClass));
      const send = (): Promise<VendorReply> =>
        postJson({ url: this.#endpoint.url, headers: this.#endpoint.headers(this.#apiKey), body, deadlineMs });

      /*
       * One retry, and only where nothing was sent.
       *
       * A name that did not resolve or a connection that was refused is a
       * failure the vendor has no record of, and the commonest cause of one is
       * a few seconds of DNS or egress trouble inside a container. Losing a
       * tender reading to that — after the hold, after the wait — is the kind
       * of fragility that makes a platform untrustworthy on a bad network, and
       * retrying it duplicates nothing because nothing arrived.
       *
       * A socket reset or a timeout is **not** retried here. The request may
       * have been received and answered in full, so a second attempt is a
       * second call the vendor may bill, and the hold is parked for
       * reconciliation instead.
       */
      let response: VendorReply;
      try {
        response = await send();
      } catch (error) {
        if (error instanceof DomainError) throw error;
        const first = transportFailure(error);
        if (first.stage !== 'CONNECT' || (error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError') throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
        response = await send();
      }

      if (!response.ok) {
        this.#consecutiveFailures += 1;
        throw new DomainError(
          'AI_PROVIDER_ERROR',
          `${this.name} returned ${response.status}: ${response.text.slice(0, 200)}`,
          502,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(response.text);
      } catch {
        this.#consecutiveFailures += 1;
        throw new DomainError(
          'AI_PROVIDER_ERROR',
          `${this.name} answered ${response.status} with something that is not JSON: ${excerpt(response.text)}`,
          502,
        );
      }
      const reply = this.#endpoint.extract(parsed);

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
      // The request left and no answer came back within the deadline. The
      // provider may have done the work and billed for it, or dropped it: the
      // outcome is unknown, and the orchestrator holds the reservation for
      // reconciliation rather than releasing or charging it (§10.2).
      if ((error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError') {
        throw new DomainError('AI_PROVIDER_TIMEOUT', `${this.name} did not answer within the deadline; the call may have completed`, 504);
      }

      // `TypeError: fetch failed` is where this used to stop. The reason is one
      // or two levels down the cause chain, and which level it is decides
      // whether the customer's hold goes back or waits for an operator.
      const failure = transportFailure(error);
      const host = new URL(this.#endpoint.url).host;

      if (failure.stage === 'IN_FLIGHT') {
        throw new DomainError(
          'AI_PROVIDER_DROPPED',
          `The connection to ${host} dropped after the request had gone out (${failure.code}: ${failure.because}). ` +
            `${this.name} may have answered and billed for it, so the hold is held for reconciliation rather than ` +
            'released. Nothing has been recorded against this request, and it has not been retried — a retry would ' +
            'be a second call the vendor may charge for.',
          // 504, as with the deadline: the outcome is unknown, not refused.
          504,
        );
      }

      throw new DomainError(
        'AI_PROVIDER_UNREACHABLE',
        `${this.name} could not be reached at ${host} (${failure.code}: ${failure.because}). It was tried twice. ` +
          'Nothing was sent, nothing was charged, and the hold has gone back. Check that this container can resolve ' +
          `and reach ${host} on 443 — outbound DNS, egress rules, and any proxy — and whether the vendor is down.`,
        502,
      );
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
