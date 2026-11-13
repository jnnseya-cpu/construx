import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ENDPOINTS, priceFor, requestInputTokens } from '../src/ai/providers/remote.ts';
import type { ProviderRequest } from '../src/ai/providers/types.ts';

/**
 * The tender pack sent once per answer, billed as a cache hit after the first.
 *
 * Each answer in a pack is drafted with the same documents. They now travel as
 * a `shared` part ahead of the task, which every vendor's prompt cache can
 * reuse, and the charge reads the vendor's own count of cached tokens and
 * prices them at the cached rate — so the saving reaches the customer rather
 * than the platform keeping the difference.
 */

const documents = '=== Document: ERCF2509N 05 Volume 1 - ITT.pdf (invitation) ===\n' + 'Volume 1 – Instructions to Tenderers. '.repeat(400);
const request = (question: string): ProviderRequest => ({
  shared: { tenderDocuments: documents },
  task: 'Now write one section of a construction tender submission',
  payload: { requirement: question, limit: { words: 1000 } },
});

describe('the shared part goes first, in the form each vendor caches', () => {
  it('OpenAI: the documents are the first input part and every answer shares one cache key', () => {
    const first = ENDPOINTS.OPENAI.body(request('Q1 approach and methodology'), 'reasoning-standard') as Record<string, any>;
    const second = ENDPOINTS.OPENAI.body(request('Q2 project management'), 'reasoning-standard') as Record<string, any>;
    const parts = first.input[1].content as Array<{ type: string; text: string }>;
    assert.equal(parts[0]!.type, 'input_text');
    assert.match(parts[0]!.text, /^\{"shared":\{"tenderDocuments":"=== Document: ERCF2509N/);
    assert.match(parts[1]!.text, /Q1 approach and methodology/);
    assert.equal(first.prompt_cache_key, second.prompt_cache_key, 'one key across the pack');
    assert.equal(parts[0]!.text, (second.input[1].content as Array<{ text: string }>)[0]!.text, 'an identical prefix');
  });

  it('Anthropic: the documents are the first block, marked for the prompt cache', () => {
    const body = ENDPOINTS.ANTHROPIC.body(request('Q1'), 'reasoning-standard') as Record<string, any>;
    const blocks = body.messages[0].content as Array<{ type: string; text: string; cache_control?: { type: string } }>;
    assert.deepEqual(blocks[0]!.cache_control, { type: 'ephemeral' });
    assert.match(blocks[0]!.text, /tenderDocuments/);
    assert.equal(blocks[1]!.cache_control, undefined);
    assert.match(blocks[1]!.text, /"task"/);
  });

  it('Gemini: the documents are the first part', () => {
    const body = ENDPOINTS.GEMINI.body(request('Q1'), 'reasoning-standard') as Record<string, any>;
    assert.match(body.contents[0].parts[0].text, /^\{"shared":/);
    assert.match(body.contents[0].parts[1].text, /"task"/);
  });

  it('a request with nothing shared is sent exactly as before', () => {
    const plain: ProviderRequest = { task: 't', payload: { a: 1 } };
    const openai = ENDPOINTS.OPENAI.body(plain, 'reasoning-standard') as Record<string, any>;
    assert.equal(typeof openai.input[1].content, 'string');
    assert.equal(openai.prompt_cache_key, undefined);
    const anthropic = ENDPOINTS.ANTHROPIC.body(plain, 'reasoning-standard') as Record<string, any>;
    assert.equal(anthropic.messages[0].content.length, 1);
  });

  it('the shared part is sized into the hold, so a hold is never smaller than the call', () => {
    const without: ProviderRequest = { task: request('Q1').task, payload: request('Q1').payload };
    assert.ok(requestInputTokens(request('Q1')) - requestInputTokens(without) >= documents.length / 4 - 10);
  });
});

describe('the charge reads each vendor’s own count of cached tokens', () => {
  const usage = (provider: 'OPENAI' | 'ANTHROPIC' | 'GEMINI', body: unknown) => ENDPOINTS[provider].extract(body);

  it('OpenAI: cached tokens are part of input_tokens and priced at a tenth', () => {
    const reply = usage('OPENAI', { output_text: '{}', usage: { input_tokens: 30_000, output_tokens: 1_500, input_tokens_details: { cached_tokens: 28_000 } } });
    assert.equal(reply.inputTokens, 30_000);
    assert.equal(reply.cachedTokens, 28_000);
    const cached = priceFor('reasoning-standard', 30_000, 1_500, { provider: 'OPENAI', cachedTokens: 28_000 });
    const uncached = priceFor('reasoning-standard', 30_000, 1_500, { provider: 'OPENAI' });
    // 2,000 ordinary + 28,000 at 10% = 4,800 input-token equivalents, against 30,000.
    assert.equal(cached, Math.ceil(((2_000 + 2_800) / 1e6) * 150 + (1_500 / 1e6) * 600));
    assert.ok(cached < uncached / 2);
  });

  it('Anthropic: cache reads and writes are reported beside input_tokens and all three are counted', () => {
    const reply = usage('ANTHROPIC', {
      content: [{ type: 'text', text: '{}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 400, output_tokens: 1_000, cache_read_input_tokens: 27_000, cache_creation_input_tokens: 0 },
    });
    assert.equal(reply.inputTokens, 27_400, 'the call carried every one of them');
    assert.equal(reply.cachedTokens, 27_000);
    const firstAnswer = usage('ANTHROPIC', {
      content: [{ type: 'text', text: '{}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 400, output_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 27_000 },
    });
    assert.equal(firstAnswer.cacheWriteTokens, 27_000);
    // The first answer writes the cache at 1.25x; the next ones read it at 0.1x.
    const write = priceFor('reasoning-standard', 27_400, 1_000, { provider: 'ANTHROPIC', cacheWriteTokens: 27_000 });
    const read = priceFor('reasoning-standard', 27_400, 1_000, { provider: 'ANTHROPIC', cachedTokens: 27_000 });
    const plain = priceFor('reasoning-standard', 27_400, 1_000, { provider: 'ANTHROPIC' });
    assert.ok(write > plain && read < plain / 2);
  });

  it('Gemini: cached tokens are part of the prompt count and priced at a quarter', () => {
    const reply = usage('GEMINI', {
      candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 30_000, candidatesTokenCount: 1_000, cachedContentTokenCount: 27_000 },
    });
    assert.equal(reply.cachedTokens, 27_000);
    assert.equal(
      priceFor('reasoning-standard', 30_000, 1_000, { provider: 'GEMINI', cachedTokens: 27_000 }),
      Math.ceil(((3_000 + 6_750) / 1e6) * 150 + (1_000 / 1e6) * 600),
    );
  });

  it('seven Conwy answers: about a third of the uncached cost on OpenAI', () => {
    // ~27,000 tokens of pack and ~1,500 of question per answer; the first
    // answer fills the cache, the next six read it.
    const pack = 27_000;
    const own = 1_500;
    const out = 1_500;
    const uncached = 7 * priceFor('reasoning-standard', pack + own, out, { provider: 'OPENAI' });
    const cached =
      priceFor('reasoning-standard', pack + own, out, { provider: 'OPENAI' }) +
      6 * priceFor('reasoning-standard', pack + own, out, { provider: 'OPENAI', cachedTokens: pack });
    assert.ok(cached < uncached * 0.45, `${cached} against ${uncached}`);
  });
});
