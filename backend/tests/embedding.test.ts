import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DomainError } from '../src/core/errors.ts';
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_ENDPOINTS,
  EMBEDDING_MAX_CHARS,
  EMBEDDING_PROVIDER_NAMES,
  EmbeddingAdapter,
  hasEmbeddingEndpoint,
  meanVector,
  passagesOf,
  textsOf,
} from '../src/ai/providers/embedding.ts';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import { similarity } from '../src/evidence/ingest.ts';
import type { AIProvider } from '../src/goldenthread/types.ts';
import type { AIProviderAdapter, ProviderCapability, ProviderRequest } from '../src/ai/providers/types.ts';

/**
 * The embedding capability's wire contract and its refusals.
 *
 * `docs/STATE.md` carried "**Any semantic embedding**" under what is not built.
 * These tests are what let that entry close honestly, and they are written from
 * the vendor's side: the fixtures are the response shapes the two APIs with an
 * embedding endpoint document, including the ones that arrive when something
 * has gone wrong.
 *
 * What is **not** claimed here and must not be read into it: no call has been
 * made to either vendor from this repository, so the *quality* of an embedding
 * is unproven, on the same terms as every other provider-backed capability. The
 * contract is proven; the reading is not.
 */

const openai = EMBEDDING_ENDPOINTS.OPENAI;
const gemini = EMBEDDING_ENDPOINTS.GEMINI;

/** A vector of the right width, distinguishable by its first element. */
function vector(seed: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, at) => (at === 0 ? seed : 0.001));
}

const request = (passages: string[]): ProviderRequest => ({ task: 'document_embedding', payload: { passages } });

/** A stand-in adapter, so routing can be tested without a key or a socket. */
function adapter(name: AIProvider, capability: ProviderCapability, healthy = true): AIProviderAdapter {
  return {
    name,
    capability,
    multimodal: capability !== 'EMBEDDING',
    transmits: true,
    healthy: () => healthy,
    estimateCostMinor: () => 1,
    execute: async () => ({ provider: name, modelClass: 'x', output: {}, rawCostMinor: 1, latencyMs: 1 }),
  };
}

describe('the body each vendor is actually sent', () => {
  it('asks OpenAI for the index width, not whatever the model defaults to', () => {
    const body = openai.body(['one', 'two'], 'embedding-standard') as {
      model: string;
      input: string[];
      dimensions: number;
    };
    assert.equal(body.model, 'text-embedding-3-small');
    assert.deepEqual(body.input, ['one', 'two']);
    // The load-bearing field. Without it the vendor returns its own default
    // width, and a deployment that later switched model would produce rows that
    // cannot be compared with the ones already stored — a silent, permanent
    // split of the index that no screen would show.
    assert.equal(body.dimensions, EMBEDDING_DIMENSIONS);
  });

  it('sends the large model only when the large class is asked for', () => {
    const body = openai.body(['one'], 'embedding-large') as { model: string };
    assert.equal(body.model, 'text-embedding-3-large');
  });

  it('builds Gemini one request per passage, each carrying the width', () => {
    const body = gemini.body(['one', 'two'], 'embedding-standard') as {
      requests: Array<{ model: string; content: { parts: Array<{ text: string }> }; outputDimensionality: number }>;
    };
    assert.equal(body.requests.length, 2);
    assert.equal(body.requests[0]!.content.parts[0]!.text, 'one');
    assert.equal(body.requests[1]!.outputDimensionality, EMBEDDING_DIMENSIONS);
  });

  it('puts the Gemini key in the URL and not in a header, which is what that API takes', () => {
    const url = gemini.url('embedding-standard', 'k e y/1');
    assert.ok(url.includes('batchEmbedContents?key=k%20e%20y%2F1'), url);
    assert.equal(Object.keys(gemini.headers('secret')).join(), 'Content-Type');
    // A key that reached a header instead would simply be ignored and every
    // call refused as unauthenticated — with the key still in the process's
    // outbound requests.
    assert.ok(!JSON.stringify(gemini.headers('secret')).includes('secret'));
  });
});

describe('reading what the vendor sends back', () => {
  it('reads an OpenAI batch', () => {
    const reply = openai.extract(
      { data: [{ embedding: vector(0.5), index: 0 }, { embedding: vector(0.9), index: 1 }], usage: { prompt_tokens: 40 } },
      2,
    );
    assert.equal(reply.vectors.length, 2);
    assert.equal(reply.vectors[0]![0], 0.5);
    assert.equal(reply.inputTokens, 40);
  });

  it('puts an out-of-order OpenAI batch back in order, because that API does not promise one', () => {
    // Documented as unordered, which is why the rows carry `index`. Reading
    // them as they arrive files every passage against the wrong document, and
    // it only happens under load — so it would ship.
    const reply = openai.extract(
      { data: [{ embedding: vector(0.9), index: 1 }, { embedding: vector(0.5), index: 0 }] },
      2,
    );
    assert.equal(reply.vectors[0]![0], 0.5);
    assert.equal(reply.vectors[1]![0], 0.9);
  });

  it('reads a Gemini batch, and reports no usage rather than inventing zero cost', () => {
    const reply = gemini.extract({ embeddings: [{ values: vector(0.3) }] }, 1);
    assert.equal(reply.vectors.length, 1);
    // That API reports no usage accounting. Zero here is "not stated", and the
    // adapter substitutes its own estimate rather than recording free work.
    assert.equal(reply.inputTokens, 0);
  });

  for (const [name, endpoint] of Object.entries(EMBEDDING_ENDPOINTS)) {
    it(`${name}: refuses a short batch instead of silently losing passages`, () => {
      const body = name === 'OPENAI'
        ? { data: [{ embedding: vector(0.5), index: 0 }] }
        : { embeddings: [{ values: vector(0.5) }] };
      assert.throws(
        () => endpoint.extract(body, 3),
        (error: unknown) =>
          error instanceof DomainError &&
          error.code === 'AI_EMBEDDING_MALFORMED' &&
          /sent 3 passages and returned 1 vector/.test(error.message),
      );
    });

    it(`${name}: refuses a vector of the wrong width`, () => {
      const short = [1, 2, 3];
      const body = name === 'OPENAI' ? { data: [{ embedding: short, index: 0 }] } : { embeddings: [{ values: short }] };
      assert.throws(
        () => endpoint.extract(body, 1),
        (error: unknown) =>
          error instanceof DomainError &&
          error.code === 'AI_EMBEDDING_MALFORMED' &&
          error.message.includes(`this index is built at ${EMBEDDING_DIMENSIONS}`),
      );
    });

    it(`${name}: refuses a vector carrying something that is not a finite number`, () => {
      const bad = vector(0.5).map((value, at) => (at === 7 ? ('0.4' as unknown as number) : value));
      const body = name === 'OPENAI' ? { data: [{ embedding: bad, index: 0 }] } : { embeddings: [{ values: bad }] };
      assert.throws(
        () => endpoint.extract(body, 1),
        (error: unknown) => error instanceof DomainError && error.code === 'AI_EMBEDDING_MALFORMED',
      );
    });

    it(`${name}: refuses an empty body rather than storing nothing as success`, () => {
      assert.throws(
        () => endpoint.extract({}, 1),
        (error: unknown) => error instanceof DomainError && error.code === 'AI_EMBEDDING_MALFORMED',
      );
    });
  }
});

describe('the vendors that can and cannot do this', () => {
  it('names only the vendors with an embedding endpoint', () => {
    assert.deepEqual([...EMBEDDING_PROVIDER_NAMES].sort(), ['GEMINI', 'OPENAI']);
  });

  it('refuses to construct an Anthropic embedding adapter rather than borrowing another vendor\'s endpoint', () => {
    // The failure the reasoning adapter's own comment records having made once:
    // every name that was not OPENAI resolved to Gemini's endpoint and Gemini's
    // key, so the ledger billed the wrong vendor for every pound of spend.
    assert.equal(hasEmbeddingEndpoint('ANTHROPIC'), false);
    assert.throws(
      () => new EmbeddingAdapter('ANTHROPIC'),
      (error: unknown) => error instanceof DomainError && error.code === 'AI_EMBEDDING_UNSUPPORTED',
    );
  });

  it('declares itself text-only and transmitting, so clearance and media checks read it correctly', () => {
    const adapter = new EmbeddingAdapter('OPENAI');
    assert.equal(adapter.capability, 'EMBEDDING');
    assert.equal(adapter.multimodal, false);
    assert.equal(adapter.transmits, true);
  });

  it('is unhealthy with no key, so nothing routes to it', () => {
    // No key is configured in the test environment, which is the state a fresh
    // deployment is in.
    assert.equal(new EmbeddingAdapter('OPENAI').healthy(), false);
  });
});

describe('what the adapter refuses before it opens a socket', () => {
  const adapter = new EmbeddingAdapter('OPENAI');

  it('refuses with no key rather than calling an endpoint that will 401', async () => {
    await assert.rejects(
      adapter.execute(request(['something'])),
      (error: unknown) => error instanceof DomainError && error.code === 'AI_PROVIDER_UNCONFIGURED',
    );
  });

  it('prices an embedding per input token with no output side at all', () => {
    // A reasoning call of the same size is priced at 150 + 600 per million.
    // Charging an embedding through that table would over-bill by roughly two
    // orders of magnitude, which is the reason this is a third capability.
    // A million tokens, which is the unit the table is written in — anything
    // smaller lands on the one-minor-unit floor for both classes and compares
    // nothing.
    const million = 'x'.repeat(4_000_000);
    const small = adapter.estimateCostMinor(request([million]));
    const large = adapter.estimateCostMinor({ ...request([million]), modelClass: 'embedding-large' });
    assert.equal(small, 2);
    assert.equal(large, 13);
    // The comparison that matters: a reasoning call of the same size is priced
    // at 150 in and 600 out per million. Charging an embedding through that
    // table would over-bill by roughly two orders of magnitude, which is the
    // reason this is a third capability rather than a task on an existing one.
    assert.ok(small < 150 / 50, `${small} should be a small fraction of a reasoning call`);
    // And a thousand tokens costs the floor, not a fraction of a penny billed
    // as nothing.
    assert.equal(adapter.estimateCostMinor(request(['x'.repeat(4_000)])), 1);
  });

  it('reads its passages out of the ordinary payload', () => {
    assert.deepEqual(textsOf(request(['a', 'b'])), ['a', 'b']);
    // Blank passages are not text and would be charged for; a payload with no
    // passages at all is a caller bug, not an empty document.
    assert.deepEqual(textsOf(request(['a', '  ', ''])), ['a']);
    assert.deepEqual(textsOf({ task: 't', payload: {} }), []);
  });
});

describe('splitting a document into passages', () => {
  it('keeps paragraphs whole, because a clause cut in half embeds as neither clause', () => {
    const passages = passagesOf('First clause.\n\nSecond clause.', 100);
    assert.equal(passages.length, 1, 'two short paragraphs fit in one passage');
    assert.ok(passages[0]!.includes('First clause.'));
    assert.ok(passages[0]!.includes('Second clause.'));
  });

  it('starts a new passage rather than overflowing the ceiling', () => {
    const passages = passagesOf(`${'a'.repeat(60)}\n\n${'b'.repeat(60)}`, 100);
    assert.equal(passages.length, 2);
    assert.ok(passages.every((passage) => passage.length <= 100));
  });

  it('cuts a single oversized paragraph rather than dropping it', () => {
    // Usually a badly converted table. Dropping it would index the document as
    // though it were empty, which reads on screen as a document with nothing
    // in it rather than one the platform could not handle.
    const passages = passagesOf('x'.repeat(250), 100);
    assert.equal(passages.length, 3);
    assert.equal(passages.join('').length, 250);
  });

  it('produces nothing from nothing, so an empty document is refused rather than charged', () => {
    assert.deepEqual(passagesOf('   \n\n   '), []);
  });

  it('never emits a passage the adapter would then refuse', () => {
    const passages = passagesOf('y'.repeat(100_000));
    assert.ok(passages.every((passage) => passage.length <= EMBEDDING_MAX_CHARS));
  });
});

describe('routing: an embedding never falls back to a chat model', () => {
  it('refuses by name where no embedding provider is configured', () => {
    // The whole point of the not-built entry. With the ternary this replaced,
    // `EMBEDDING` resolved to the reasoning adapter, and a chat model asked for
    // an embedding returns prose — which coerced to a float array is a row of
    // noise that then sits in the index looking exactly like a real one.
    const orchestrator = new AIOrchestrator({
      reasoning: adapter('OPENAI', 'REASONING'),
      perception: adapter('GEMINI', 'PERCEPTION'),
    });
    assert.throws(
      () => orchestrator.adapterFor('EMBEDDING'),
      (error: unknown) =>
        error instanceof DomainError &&
        error.code === 'AI_EMBEDDING_NOT_CONFIGURED' &&
        // 501, not 503: nothing is down and retrying will never help.
        error.status === 501 &&
        error.message.includes('AI_EMBEDDING_PROVIDER'),
    );
  });

  it('routes to the embedding adapter where one is configured, and to nothing else', () => {
    const orchestrator = new AIOrchestrator({
      reasoning: adapter('OPENAI', 'REASONING'),
      perception: adapter('GEMINI', 'PERCEPTION'),
      embedding: adapter('GEMINI', 'EMBEDDING'),
    });
    assert.equal(orchestrator.adapterFor('EMBEDDING').capability, 'EMBEDDING');
    assert.equal(orchestrator.adapterFor('REASONING').capability, 'REASONING');
  });

  it('refuses rather than failing over when the embedding vendor is down', () => {
    // A reasoning adapter is healthy and present. It must not be reached.
    const orchestrator = new AIOrchestrator({
      reasoning: adapter('OPENAI', 'REASONING'),
      perception: adapter('GEMINI', 'PERCEPTION'),
      embedding: adapter('GEMINI', 'EMBEDDING', false),
    });
    assert.throws(
      () => orchestrator.adapterFor('EMBEDDING'),
      (error: unknown) => error instanceof DomainError && error.code === 'AI_UNAVAILABLE',
    );
  });

  it('says on the control plane whether semantic search is on, and why not where it is off', () => {
    const off = new AIOrchestrator({
      reasoning: adapter('OPENAI', 'REASONING'),
      perception: adapter('GEMINI', 'PERCEPTION'),
    }).controlPlaneStatus();
    assert.equal(off.embedding.configured, false);
    assert.ok(off.embedding.reason && off.embedding.reason.length > 20, 'an operator needs the reason, not a false');

    const on = new AIOrchestrator({
      reasoning: adapter('OPENAI', 'REASONING'),
      perception: adapter('GEMINI', 'PERCEPTION'),
      embedding: adapter('ANTHROPIC', 'EMBEDDING'),
    }).controlPlaneStatus();
    assert.equal(on.embedding.configured, true);
    assert.equal(on.embedding.provider, 'ANTHROPIC');
    // And it appears in the vendor list under its own role, so nobody reading
    // that list is unaware of a third vendor receiving document text.
    assert.ok(on.available.some((entry) => entry.role === 'EMBEDDING' && entry.provider === 'ANTHROPIC'));
  });
});

describe('the document vector', () => {
  it('is the mean of its passages, renormalised so cosine is a dot product', () => {
    const mean = meanVector([vector(1), vector(1)]);
    const magnitude = Math.sqrt(mean.reduce((sum, value) => sum + value * value, 0));
    assert.ok(Math.abs(magnitude - 1) < 1e-3, `expected unit length, got ${magnitude}`);
  });

  it('puts two documents made of the same passages at the same point', () => {
    // Not exactly 1: the components are rounded to six places on the way in, so
    // a self-comparison lands a hair under. That is the same arithmetic the
    // lexical vector has always used, and the tolerance here is the honest
    // assertion — demanding exactly 1 would be asserting against the rounding
    // rather than against the property.
    const same = similarity(meanVector([vector(1), vector(2)]), meanVector([vector(2), vector(1)]));
    assert.ok(Math.abs(same - 1) < 1e-5, `expected the same point, got ${same}`);
  });

  it('answers an empty batch with an empty vector rather than a row of zeroes', () => {
    // A row of 1536 zeroes is a valid-looking row that scores 0 against
    // everything — it would sit in the index for ever, never matching, and
    // never explaining why.
    assert.deepEqual(meanVector([]), []);
  });
});
