import { config } from '../../config.ts';
import { DomainError } from '../../core/errors.ts';
import type { AIProvider } from '../../goldenthread/types.ts';
import type { AIProviderAdapter, ProviderRequest, ProviderResponse } from './types.ts';

/**
 * The embedding capability: text in, a vector out.
 *
 * `docs/STATE.md` carried "**Any semantic embedding**" under what is not built,
 * with the document index named `lexicalVector` so nobody could read it as one.
 * This is what closes that entry, and it is deliberately a *third* capability
 * rather than a new task on the two that exist, because an embedding is not a
 * reasoning call:
 *
 *   - It has its own vendor endpoint (`/v1/embeddings`, `:batchEmbedContents`)
 *     with its own request and response shape. Neither returns JSON against a
 *     schema, so `parseModelOutput` has nothing to do here.
 *   - It is priced per input token with **no output tokens at all**, at roughly
 *     a hundredth of a reasoning call. Charging it through the reasoning table
 *     would over-bill a customer by two orders of magnitude.
 *   - **It cannot fail over to a chat model.** A reasoning adapter asked for an
 *     embedding produces prose, and prose coerced into a float array is a
 *     vector of noise that then sits in the index looking exactly like a real
 *     one. So the chain here is embedding adapters only; where none is
 *     configured the call is refused and says so.
 *
 * There is also **no local stand-in**, and that is the point of the whole
 * entry. A deterministic hash dressed up as an embedding is precisely the
 * overclaim the `lexicalVector` naming was defending against — it would find
 * near-duplicates, which the lexical index already does for free, while every
 * screen above it said "semantic". A deployment with no embedding provider has
 * no semantic search and the platform says which variable turns it on.
 *
 * ## What has and has not been proven
 *
 * No call has been made to either vendor from this repository. What is verified
 * (`tests/embedding.test.ts`) is the **wire contract**: the body each vendor
 * expects, and the reading of the response shapes each actually sends,
 * including the failure shapes — a truncated batch, a refused input, a vector
 * of the wrong width. What is not verified is the *quality* of the embedding,
 * on the same terms as every other provider-backed capability here.
 */

/** Per-million-input-token prices in USD minor units. Embeddings have no output side. */
const PRICING: Record<string, number> = {
  // text-embedding-3-small.
  'embedding-standard': 2,
  // text-embedding-3-large — better recall on long technical prose, 5x the price.
  'embedding-large': 13,
};

/**
 * The width the index is built at.
 *
 * Both vendors below can be asked for a specific number of dimensions, and they
 * are asked, because a vector store whose rows are different widths cannot be
 * compared at all: cosine similarity of a 1536-wide row against a 768-wide one
 * is not a smaller number, it is undefined. Fixing the width at the request
 * means a deployment that switches vendor produces rows that are still the same
 * shape — though not the same *space*, which is why the model is recorded on
 * every row and rows from two models are never compared.
 */
export const EMBEDDING_DIMENSIONS = 1536;

/** The ceiling on one call, so a 400-page specification cannot be sent whole. */
export const EMBEDDING_MAX_CHARS = 24_000;

function priceFor(modelClass: string, inputTokens: number): number {
  const perMillion = PRICING[modelClass] ?? PRICING['embedding-standard']!;
  return Math.max(1, Math.ceil((inputTokens / 1_000_000) * perMillion));
}

/** 4 characters per token, the same heuristic the reasoning adapters size holds with. */
function estimateTokens(texts: readonly string[]): number {
  return Math.ceil(texts.reduce((sum, text) => sum + text.length, 0) / 4);
}

type EmbeddingReply = {
  vectors: number[][];
  inputTokens: number;
};

type EmbeddingEndpoint = {
  url: (modelClass: string, key: string) => string;
  headers: (key: string) => Record<string, string>;
  body: (texts: readonly string[], modelClass: string) => unknown;
  extract: (response: unknown, expected: number) => EmbeddingReply;
};

/**
 * Read a vector out of whatever arrived, refusing anything that is not one.
 *
 * Shared by both endpoints because both fail the same way: a row present but
 * null, a row of strings where a retry serialised badly, a row of the wrong
 * width because the vendor ignored the dimension request on a model that does
 * not support it. Each of those, admitted into the index, is a row that
 * silently ranks wrong for ever — the search returns *something*, so nobody
 * looks. Refusing costs one call.
 */
function readVector(raw: unknown, at: number, provider: string): number[] {
  if (!Array.isArray(raw)) {
    throw new DomainError('AI_EMBEDDING_MALFORMED', `${provider} returned no vector for input ${at + 1}`, 502);
  }
  const vector = raw.map((value) => (typeof value === 'number' ? value : Number.NaN));
  if (vector.some((value) => !Number.isFinite(value))) {
    throw new DomainError(
      'AI_EMBEDDING_MALFORMED',
      `${provider} returned a vector for input ${at + 1} containing a value that is not a finite number`,
      502,
    );
  }
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new DomainError(
      'AI_EMBEDDING_MALFORMED',
      `${provider} returned a ${vector.length}-dimension vector for input ${at + 1}; this index is built at ` +
        `${EMBEDDING_DIMENSIONS}. Rows of different widths cannot be compared, so nothing has been stored.`,
      502,
    );
  }
  return vector;
}

function readBatch(rows: readonly unknown[], expected: number, provider: string): number[][] {
  // A short batch is the failure that looks like success: ask for eight
  // passages, get six back, and the index quietly loses two of them with the
  // ingestion still recorded as embedded.
  if (rows.length !== expected) {
    throw new DomainError(
      'AI_EMBEDDING_MALFORMED',
      `${provider} was sent ${expected} passage${expected === 1 ? '' : 's'} and returned ${rows.length} vector` +
        `${rows.length === 1 ? '' : 's'}. A partial batch is not stored.`,
      502,
    );
  }
  return rows.map((row, at) => readVector(row, at, provider));
}

const OPENAI_EMBEDDING: EmbeddingEndpoint = {
  url: () => 'https://api.openai.com/v1/embeddings',
  headers: (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }),
  body: (texts, modelClass) => ({
    model: modelClass === 'embedding-large' ? 'text-embedding-3-large' : 'text-embedding-3-small',
    input: texts,
    dimensions: EMBEDDING_DIMENSIONS,
  }),
  extract: (response, expected) => {
    const body = response as {
      data?: Array<{ embedding?: unknown; index?: number }>;
      usage?: { prompt_tokens?: number };
    };
    const data = body.data ?? [];
    // This API documents `data` as unordered and carries `index` for that
    // reason. Reading it in arrival order is a bug that only shows up under
    // load, when the batch comes back shuffled and every passage is filed
    // against the wrong document.
    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return {
      vectors: readBatch(ordered.map((row) => row.embedding), expected, 'OPENAI'),
      inputTokens: body.usage?.prompt_tokens ?? 0,
    };
  },
};

const GEMINI_EMBEDDING: EmbeddingEndpoint = {
  url: (_modelClass, key) =>
    `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents?key=${encodeURIComponent(key)}`,
  // The key rides in the query string on this API, so the header carries none.
  headers: () => ({ 'Content-Type': 'application/json' }),
  body: (texts) => ({
    requests: texts.map((text) => ({
      model: 'models/text-embedding-004',
      content: { parts: [{ text }] },
      outputDimensionality: EMBEDDING_DIMENSIONS,
    })),
  }),
  extract: (response, expected) => {
    const body = response as { embeddings?: Array<{ values?: unknown }> };
    return {
      vectors: readBatch((body.embeddings ?? []).map((row) => row.values), expected, 'GEMINI'),
      // This API reports no usage accounting at all. Nothing is invented: the
      // adapter falls back to its own estimate and the execution record says
      // the cost was estimated rather than read back, which is the honest
      // answer and the one reconciliation needs.
      inputTokens: 0,
    };
  },
};

/**
 * The vendors with an embedding endpoint, and the one that has none.
 *
 * Anthropic publishes no embedding API. It is absent from this table rather
 * than mapped onto another vendor's endpoint — the mistake the reasoning
 * adapter's own comment records having made once, where every name that was not
 * OPENAI silently resolved to Gemini's endpoint and Gemini's key, so the ledger
 * billed the wrong vendor for every pound.
 */
const EMBEDDING_PROVIDERS: Partial<Record<AIProvider, { endpoint: EmbeddingEndpoint; key: () => string }>> = {
  OPENAI: { endpoint: OPENAI_EMBEDDING, key: () => config.ai.openaiKey },
  GEMINI: { endpoint: GEMINI_EMBEDDING, key: () => config.ai.geminiKey },
};

/** Which vendors this platform can ask for an embedding at all. */
export const EMBEDDING_PROVIDER_NAMES = Object.keys(EMBEDDING_PROVIDERS) as AIProvider[];

export function hasEmbeddingEndpoint(provider: string): provider is AIProvider {
  return provider in EMBEDDING_PROVIDERS;
}

/**
 * Split a document into passages small enough to embed.
 *
 * Paragraph boundaries first, because a paragraph is the unit a specification
 * is written in and a clause cut in half embeds as neither clause. A paragraph
 * longer than the ceiling on its own is cut on the ceiling rather than dropped
 * — a 30,000-character wall of text is usually a badly converted table, and
 * losing it entirely would leave a document indexed as though it were empty.
 */
export function passagesOf(text: string, maxChars = 2_000): string[] {
  const passages: string[] = [];
  let current = '';
  for (const paragraph of text.split(/\n\s*\n/)) {
    const trimmed = paragraph.trim();
    if (trimmed === '') continue;
    if (trimmed.length > maxChars) {
      if (current !== '') { passages.push(current); current = ''; }
      for (let at = 0; at < trimmed.length; at += maxChars) passages.push(trimmed.slice(at, at + maxChars));
      continue;
    }
    if (current === '') current = trimmed;
    else if (current.length + trimmed.length + 2 <= maxChars) current = `${current}\n\n${trimmed}`;
    else { passages.push(current); current = trimmed; }
  }
  if (current !== '') passages.push(current);
  return passages;
}

/**
 * The mean of a document's passage vectors, renormalised.
 *
 * One row per document is what the register compares, and averaging the
 * passages is the standard way to get there. It is a real loss of resolution —
 * a long document averages towards the middle of everything it discusses — and
 * the register says so rather than implying the row is the document.
 */
export function meanVector(vectors: readonly (readonly number[])[]): number[] {
  if (vectors.length === 0) return [];
  const width = vectors[0]!.length;
  const sum = new Array<number>(width).fill(0);
  for (const vector of vectors) {
    for (let at = 0; at < width; at += 1) sum[at] = (sum[at] ?? 0) + (vector[at] ?? 0);
  }
  const magnitude = Math.sqrt(sum.reduce((total, value) => total + value * value, 0));
  if (magnitude === 0) return sum;
  return sum.map((value) => Number((value / magnitude).toFixed(6)));
}

/**
 * An embedding adapter, shaped as an ordinary provider adapter.
 *
 * Deliberately the same interface as the reasoning and perception adapters, so
 * the orchestrator holds, charges, records, fails over and reports on an
 * embedding call through exactly the code that already does it for the other
 * two. The output is a record like any other — `{ vectors: number[][] }` — so
 * nothing downstream of the orchestrator needed a new shape.
 */
export class EmbeddingAdapter implements AIProviderAdapter {
  readonly name: AIProvider;
  readonly capability = 'EMBEDDING' as const;
  /** Text only. An embedding endpoint is handed no files. */
  readonly multimodal = false;
  /** Over the network, to a third party. Clearance applies exactly as elsewhere. */
  readonly transmits = true;
  readonly #endpoint: EmbeddingEndpoint;
  readonly #apiKey: string;
  #consecutiveFailures = 0;

  constructor(name: AIProvider) {
    const provider = EMBEDDING_PROVIDERS[name];
    if (!provider) {
      throw new DomainError(
        'AI_EMBEDDING_UNSUPPORTED',
        `${name} publishes no embedding endpoint. Set AI_EMBEDDING_PROVIDER to one of ` +
          `${EMBEDDING_PROVIDER_NAMES.join(', ')}, or leave it unset and the platform will say semantic search is off.`,
        500,
      );
    }
    this.name = name;
    this.#endpoint = provider.endpoint;
    this.#apiKey = provider.key();
  }

  healthy(): boolean {
    return this.#apiKey !== '' && this.#consecutiveFailures < 3;
  }

  estimateCostMinor(request: ProviderRequest): number {
    return priceFor(request.modelClass ?? 'embedding-standard', estimateTokens(textsOf(request)));
  }

  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    if (this.#apiKey === '') {
      throw new DomainError('AI_PROVIDER_UNCONFIGURED', `${this.name} API key is not configured`, 503);
    }

    const texts = textsOf(request);
    if (texts.length === 0) {
      throw new DomainError('AI_EMBEDDING_EMPTY', 'An embedding request carried no text to embed', 422);
    }
    const oversized = texts.findIndex((text) => text.length > EMBEDDING_MAX_CHARS);
    if (oversized !== -1) {
      throw new DomainError(
        'AI_EMBEDDING_TOO_LONG',
        `Passage ${oversized + 1} is ${texts[oversized]!.length} characters; the ceiling is ${EMBEDDING_MAX_CHARS}. ` +
          'Split the document into passages before embedding it.',
        422,
      );
    }

    const modelClass = request.modelClass ?? 'embedding-standard';
    const started = Date.now();

    try {
      const response = await fetch(this.#endpoint.url(modelClass, this.#apiKey), {
        method: 'POST',
        headers: this.#endpoint.headers(this.#apiKey),
        body: JSON.stringify(this.#endpoint.body(texts, modelClass)),
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

      let reply: EmbeddingReply;
      try {
        reply = this.#endpoint.extract(await response.json(), texts.length);
      } catch (error) {
        // Health is reset only once an answer has actually been read, for the
        // reason the reasoning adapter records: a vendor answering 200 with
        // something unreadable on every call would otherwise stay "healthy"
        // for ever, never failed over from and billed in full.
        this.#consecutiveFailures += 1;
        throw error;
      }
      this.#consecutiveFailures = 0;

      // Gemini reports no usage; fall back to the estimate rather than record a
      // cost of zero for work that was done and will appear on the invoice.
      const inputTokens = reply.inputTokens > 0 ? reply.inputTokens : estimateTokens(texts);

      return {
        provider: this.name,
        modelClass,
        output: { vectors: reply.vectors },
        rawCostMinor: priceFor(modelClass, inputTokens),
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      this.#consecutiveFailures += 1;
      if ((error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError') {
        throw new DomainError(
          'AI_PROVIDER_TIMEOUT',
          `${this.name} did not answer within the deadline; the call may have completed`,
          504,
        );
      }
      throw new DomainError('AI_PROVIDER_UNREACHABLE', `${this.name} call failed: ${String(error)}`, 502);
    }
  }
}

/** The passages an embedding request carries, read out of the ordinary payload. */
export function textsOf(request: ProviderRequest): string[] {
  const raw = (request.payload as { passages?: unknown }).passages;
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === 'string' && value.trim() !== '');
}

/**
 * The configured embedding adapter, or none.
 *
 * Absent is a supported state and the one every deployment starts in. Callers
 * check for it and refuse with a message naming the variable, rather than
 * falling back to something that is not an embedding.
 */
export function configuredEmbeddingAdapter(): EmbeddingAdapter | undefined {
  const name = config.ai.embeddingProvider;
  if (name === '' || !hasEmbeddingEndpoint(name)) return undefined;
  if (config.ai.mode === 'local') return undefined;
  return new EmbeddingAdapter(name);
}

/** The two exported so a test can check the body each vendor is actually sent. */
export const EMBEDDING_ENDPOINTS = { OPENAI: OPENAI_EMBEDDING, GEMINI: GEMINI_EMBEDDING };
