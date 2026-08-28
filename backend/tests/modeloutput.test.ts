import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { config } from '../src/config.ts';
import { DomainError } from '../src/core/errors.ts';
import { ENDPOINTS, RemoteProviderAdapter, parseModelOutput } from '../src/ai/providers/remote.ts';
import type { ProviderRequest } from '../src/ai/providers/types.ts';

/**
 * Reading what a model actually sends back.
 *
 * `docs/STATE.md` has carried the same caveat against every perception task
 * since the first one: *exercised against a stub, not a live provider*. The
 * stub answers in exactly the shape the engine asks for, because the stub was
 * written by the same hand as the engine. Real vendors do not.
 *
 * That gap was not theoretical. The path from a provider's HTTP 200 to a record
 * in the Golden Thread was `JSON.parse(text)` with the result cast to an object,
 * and three separate live behaviours went straight through it:
 *
 *   - **Fenced and prefaced answers.** A model told in a system prompt to reply
 *     in JSON frequently replies "Here is the title block:" and then a ```json
 *     block. The bare parse threw. The vendor had already billed the tokens.
 *   - **Valid JSON that is not an object.** `null`, `[]`, `42` and a quoted
 *     refusal all parse. The cast made them objects to the type system only —
 *     `null` reached the ledger as a draft's extraction and then crashed the
 *     legibility check, so the answer was a 500 with the null already committed.
 *   - **Truncation.** An answer cut off at the token ceiling was reported as
 *     "did not return valid JSON", sending the operator to look at a schema
 *     when the actionable truth was that the ceiling was too low.
 *
 * These tests are the substitute for a live call, and they are deliberately
 * written from the vendor's side: the fixtures below are the response shapes
 * the three configured APIs document, not the shape this platform would like.
 */

const anthropic = ENDPOINTS.ANTHROPIC;
const openai = ENDPOINTS.OPENAI;
const gemini = ENDPOINTS.GEMINI;

/** The one field every engine reads back, so a parse either found it or did not. */
const TITLE_BLOCK = { drawingNumber: 'A-101', revision: 'C', title: 'Ground floor plan' };

function reply(text: string, over: Partial<{ stopReason: string; cutShort: boolean }> = {}) {
  return { text, inputTokens: 100, outputTokens: 50, ...over };
}

/** The refusal, as a caller would receive it. */
function refusalFrom(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof DomainError, `expected a DomainError, got ${String(error)}`);
    return error;
  }
  throw new Error('expected a refusal');
}

describe('the shapes a model actually answers in', () => {
  it('reads a bare object, which is what a schema-honouring vendor sends', () => {
    const output = parseModelOutput(reply(JSON.stringify(TITLE_BLOCK)), 'OPENAI');
    assert.deepEqual(output, TITLE_BLOCK);
  });

  it('reads a fenced block behind a sentence of prose', () => {
    // The single likeliest live failure. Anthropic is configured with no
    // structured-output enforcement — only a system instruction — so this is
    // its ordinary, correct behaviour, and it used to be a 502.
    const text = `Here is the title block I read from the drawing:\n\n\`\`\`json\n${JSON.stringify(TITLE_BLOCK)}\n\`\`\`\n\nLet me know if you need the revision history.`;
    assert.deepEqual(parseModelOutput(reply(text), 'ANTHROPIC'), TITLE_BLOCK);
  });

  it('reads a fence with no language tag', () => {
    const text = `\`\`\`\n${JSON.stringify(TITLE_BLOCK)}\n\`\`\``;
    assert.deepEqual(parseModelOutput(reply(text), 'ANTHROPIC'), TITLE_BLOCK);
  });

  it('reads an object introduced by prose and no fence at all', () => {
    const text = `I was able to read the title block. ${JSON.stringify(TITLE_BLOCK)}`;
    assert.deepEqual(parseModelOutput(reply(text), 'GEMINI'), TITLE_BLOCK);
  });

  it('reads an object followed by prose', () => {
    const text = `${JSON.stringify(TITLE_BLOCK)}\n\nNote that the revision cloud on grid F is not legible.`;
    assert.deepEqual(parseModelOutput(reply(text), 'GEMINI'), TITLE_BLOCK);
  });

  it('does not close the object on a brace inside a string', () => {
    // A take-off description genuinely reads like this. A naive scan for the
    // first `}` truncates the object here and the parse fails on a valid answer.
    const payload = { items: [{ description: 'Blockwork to bay {3} — see note {a}', quantity: 42 }] };
    const text = `Result:\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
    assert.deepEqual(parseModelOutput(reply(text), 'OPENAI'), payload);
  });

  it('does not close the object on an escaped quote before a brace', () => {
    const payload = { note: 'marked \\"as built\\" {revised}', ok: true };
    const raw = JSON.stringify(payload);
    assert.deepEqual(parseModelOutput(reply(`Here you go: ${raw} — done.`), 'OPENAI'), payload);
  });

  it('prefers the whole reply when the whole reply is already JSON', () => {
    // A JSON string that happens to contain a fence must not be re-read from
    // inside itself.
    const payload = { transcript: 'the engineer said ```json is not a material```' };
    assert.deepEqual(parseModelOutput(reply(JSON.stringify(payload)), 'OPENAI'), payload);
  });
});

describe('valid JSON that is not an engine output', () => {
  it('refuses null rather than committing it as an extraction', () => {
    // The defect this closes: `JSON.parse("null")` succeeded, the cast to
    // Record<string, unknown> made it an object to the type system, the draft
    // was written to the ledger with a null extraction, and the legibility
    // check then dereferenced it — a 500, with the null already committed to an
    // append-only record.
    const refusal = refusalFrom(() => parseModelOutput(reply('null'), 'GEMINI'));
    assert.equal(refusal.code, 'AI_OUTPUT_NOT_AN_OBJECT');
    assert.equal(refusal.status, 502);
    assert.match(refusal.message, /returned null/);
    assert.match(refusal.message, /Nothing has been recorded/);
  });

  it('refuses a bare array', () => {
    const refusal = refusalFrom(() => parseModelOutput(reply('[{"drawingNumber":"A-101"}]'), 'OPENAI'));
    assert.equal(refusal.code, 'AI_OUTPUT_NOT_AN_OBJECT');
    assert.match(refusal.message, /an array/);
  });

  it('refuses a number', () => {
    assert.equal(refusalFrom(() => parseModelOutput(reply('42'), 'OPENAI')).code, 'AI_OUTPUT_NOT_AN_OBJECT');
  });

  it('refuses a quoted refusal, which is valid JSON', () => {
    const refusal = refusalFrom(() => parseModelOutput(reply('"I cannot identify a title block"'), 'ANTHROPIC'));
    assert.equal(refusal.code, 'AI_OUTPUT_NOT_AN_OBJECT');
    assert.match(refusal.message, /string/);
  });
});

describe('an answer that was cut off is not a partial answer, it is no answer', () => {
  it('refuses on truncation even when the text still parses', () => {
    // The dangerous case. A take-off truncated at item 140 of 200 can arrive as
    // well-formed JSON if the model closed its brackets, and it is *plausible*.
    // A plausible partial quantity becomes a BoQ item, then a price.
    const refusal = refusalFrom(() =>
      parseModelOutput(reply(JSON.stringify({ items: [{ quantity: 1 }] }), { cutShort: true, stopReason: 'max_tokens' }), 'ANTHROPIC'),
    );
    assert.equal(refusal.code, 'AI_OUTPUT_TRUNCATED');
    assert.equal(refusal.status, 502);
    assert.match(refusal.message, /max_tokens/);
    // Actionable, rather than "invalid JSON".
    assert.match(refusal.message, /smaller input|output ceiling/);
  });

  it('says so when the vendor gives no reason', () => {
    const refusal = refusalFrom(() => parseModelOutput(reply('{"a":1}', { cutShort: true }), 'GEMINI'));
    assert.match(refusal.message, /reason not given/);
  });
});

describe('an empty completion is a different fact from an unreadable one', () => {
  it('names it as empty rather than as invalid JSON', () => {
    // A content filter or a refusal produces this. Reporting "not valid JSON"
    // sends the operator to inspect a schema that is not the problem.
    const refusal = refusalFrom(() => parseModelOutput(reply(''), 'OPENAI'));
    assert.equal(refusal.code, 'AI_OUTPUT_EMPTY');
    assert.match(refusal.message, /no text at all/);
  });

  it('treats whitespace as empty', () => {
    assert.equal(refusalFrom(() => parseModelOutput(reply('   \n\t  '), 'OPENAI')).code, 'AI_OUTPUT_EMPTY');
  });
});

describe('when it genuinely cannot be read, it says what came back', () => {
  it('carries an excerpt an operator can act on', () => {
    const refusal = refusalFrom(() =>
      parseModelOutput(reply('I am unable to read this drawing because the scan is too low-resolution.'), 'GEMINI'),
    );
    assert.equal(refusal.code, 'AI_OUTPUT_UNPARSEABLE');
    assert.match(refusal.message, /GEMINI/);
    // "did not return valid JSON" is not something anybody can act on.
    assert.match(refusal.message, /too low-resolution/);
  });

  it('bounds the excerpt rather than logging a whole reply', () => {
    const refusal = refusalFrom(() => parseModelOutput(reply('x'.repeat(5000)), 'OPENAI'));
    assert.ok(refusal.message.length < 500, `excerpt was ${refusal.message.length} characters`);
    assert.match(refusal.message, /…$/);
  });

  it('collapses newlines so one refusal is one log line', () => {
    const refusal = refusalFrom(() => parseModelOutput(reply('line one\nline two\nline three'), 'OPENAI'));
    assert.equal(refusal.message.includes('\n'), false);
  });
});

describe('each vendor is read for whether it finished', () => {
  it('reads OpenAI incomplete status', () => {
    const out = openai.extract({
      output_text: '{"a":1',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    assert.equal(out.cutShort, true);
    assert.equal(out.stopReason, 'max_output_tokens');
  });

  it('reads an OpenAI completion as finished', () => {
    const out = openai.extract({ output_text: '{"a":1}', status: 'completed', usage: {} });
    assert.equal(out.cutShort, false);
    assert.equal(out.stopReason, undefined);
  });

  it('reads a Gemini token ceiling', () => {
    const out = gemini.extract({
      candidates: [{ content: { parts: [{ text: '{"a":1' }] }, finishReason: 'MAX_TOKENS' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 6 },
    });
    assert.equal(out.cutShort, true);
    assert.equal(out.stopReason, 'MAX_TOKENS');
  });

  it('reads a Gemini safety stop as a stop, not as a bad answer', () => {
    const out = gemini.extract({ candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'SAFETY' }] });
    assert.equal(out.stopReason, 'SAFETY');
  });

  it('reads a blocked Gemini prompt, which returns no candidate at all', () => {
    const out = gemini.extract({ promptFeedback: { blockReason: 'SAFETY' } });
    assert.equal(out.cutShort, true);
    assert.equal(out.stopReason, 'SAFETY');
    assert.equal(out.text, '');
  });

  it('reads a normal Gemini stop as finished', () => {
    const out = gemini.extract({ candidates: [{ content: { parts: [{ text: '{"a":1}' }] }, finishReason: 'STOP' }] });
    assert.equal(out.cutShort, false);
  });

  it('reads the Anthropic token ceiling, which the 8,192 limit makes reachable', () => {
    const out = anthropic.extract({
      content: [{ type: 'text', text: '{"items":[' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 9, output_tokens: 8192 },
    });
    assert.equal(out.cutShort, true);
    assert.equal(out.stopReason, 'max_tokens');
  });

  it('reads an Anthropic end_turn as finished', () => {
    const out = anthropic.extract({ content: [{ type: 'text', text: '{"a":1}' }], stop_reason: 'end_turn' });
    assert.equal(out.cutShort, false);
    assert.equal(out.stopReason, undefined);
  });
});

describe('the schema reaches the only vendor that was never sent one', () => {
  it('puts the response schema in the Anthropic message body', () => {
    // The system prompt says "matching the supplied schema" and no schema was
    // supplied: `responseSchema` was referenced by the OpenAI and Gemini bodies
    // and by nothing in this one. The vendor with no structured-output
    // enforcement was the vendor not told what shape to answer in.
    const request: ProviderRequest = {
      task: 'Read the title block',
      payload: { evidenceHash: 'abc' },
      responseSchema: { type: 'object', properties: { drawingNumber: { type: 'string' } } },
    };
    const body = anthropic.body(request, 'perception-standard') as {
      messages: Array<{ content: Array<{ type: string; text?: string }> }>;
    };
    const text = body.messages[0]!.content.find((block) => block.type === 'text')!.text!;
    assert.match(text, /responseSchema/);
    assert.match(text, /drawingNumber/);
  });

  it('omits the key entirely when the engine asked for no schema', () => {
    const body = anthropic.body({ task: 'x', payload: {} }, 'perception-standard') as {
      messages: Array<{ content: Array<{ type: string; text?: string }> }>;
    };
    const text = body.messages[0]!.content.find((block) => block.type === 'text')!.text!;
    assert.equal(text.includes('responseSchema'), false);
  });
});

describe('a provider that answers unreadably is a provider that is failing', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Answer every call with one fixed vendor body. */
  function answering(body: unknown): void {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  }

  function adapter(): RemoteProviderAdapter {
    (config.ai as unknown as { anthropicKey: string }).anthropicKey = 'test-key-not-a-real-credential';
    return new RemoteProviderAdapter('ANTHROPIC', 'PERCEPTION');
  }

  const request: ProviderRequest = { task: 'Read the title block', payload: {} };

  it('accepts the fenced answer that used to be a 502', async () => {
    answering({
      content: [{ type: 'text', text: `Here is what I read:\n\n\`\`\`json\n${JSON.stringify(TITLE_BLOCK)}\n\`\`\`` }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 900, output_tokens: 120 },
    });
    const response = await adapter().execute(request);
    assert.deepEqual(response.output, TITLE_BLOCK);
    assert.equal(response.provider, 'ANTHROPIC');
    // Billed from the vendor's own accounting, not from the estimate.
    assert.ok(response.rawCostMinor > 0);
  });

  it('goes unhealthy after three unreadable answers, so failover can happen', async () => {
    // The accounting defect this closes: the failure counter was reset on the
    // line *before* the parse. A provider answering 200 OK with prose on every
    // call therefore stayed healthy for ever — never taken out of rotation,
    // never failed over from, billing the vendor in full for every request
    // while every caller received a 502.
    answering({
      content: [{ type: 'text', text: 'I am not able to help with that.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 900, output_tokens: 10 },
    });
    const subject = adapter();
    assert.equal(subject.healthy(), true);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(() => subject.execute(request), /did not return JSON/);
    }
    assert.equal(subject.healthy(), false);
  });

  it('recovers its health once an answer can be read again', async () => {
    const subject = adapter();
    answering({ content: [{ type: 'text', text: 'nope' }], stop_reason: 'end_turn', usage: {} });
    await assert.rejects(() => subject.execute(request));
    await assert.rejects(() => subject.execute(request));

    answering({ content: [{ type: 'text', text: JSON.stringify(TITLE_BLOCK) }], stop_reason: 'end_turn', usage: {} });
    await subject.execute(request);
    assert.equal(subject.healthy(), true);
  });

  it('counts a truncated answer as a failure too', async () => {
    answering({
      content: [{ type: 'text', text: '{"items":[{"quantity":1}]}' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 900, output_tokens: 8192 },
    });
    const subject = adapter();
    await assert.rejects(() => subject.execute(request), /stopped before finishing/);
    await assert.rejects(() => subject.execute(request));
    await assert.rejects(() => subject.execute(request));
    // A model whose ceiling is too low for this workload is a provider that is
    // not working, whatever the HTTP status said.
    assert.equal(subject.healthy(), false);
  });
});
