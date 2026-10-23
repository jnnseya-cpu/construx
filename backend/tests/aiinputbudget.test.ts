import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AIProviderAdapter, ProviderRequest, ProviderResponse } from '../src/ai/providers/types.ts';

/*
 * A key, before anything reads the environment.
 *
 * `RemoteProviderAdapter` resolves its key when it is constructed, and an
 * adapter with no key refuses on that ground before it reaches anything this
 * file is about. The value is nonsense and never leaves the process: every
 * assertion below is that **nothing is sent**, which is exactly the property
 * being tested.
 *
 * Every import below is dynamic for one reason: a static import is hoisted
 * above this assignment, `config.ts` reads the environment once when it is
 * first loaded, and the key would be missing from the only copy anything ever
 * sees. Type-only imports stay static — they are erased and load nothing.
 */
process.env.OPENAI_API_KEY = 'not-a-key-nothing-is-sent';
const { rejectsCode, throwsCode } = await import('./helpers.ts');
const { AIOrchestrator } = await import('../src/ai/orchestrator.ts');
const { documentTextOf, partsOf } = await import('../src/domain/bidon/engine.ts');
const { ENDPOINTS, RemoteProviderAdapter, requestInputTokens } = await import('../src/ai/providers/remote.ts');

/**
 * The context window, and the three places it is now known about.
 *
 * ## What happened
 *
 * A real tender was read on a live key and the command came back:
 *
 *     AI_PROVIDER_ERROR — OPENAI returned 400: Your input exceeds the context
 *     window of this model. Please adjust your input and try again.
 *
 * Nothing in the platform knew where any model's window was. An engine
 * assembled whatever the records held — a priced bill of quantities, a
 * two-hundred-page invitation — the adapter sent it, and the first thing
 * anybody learned about the limit was the vendor's refusal, reported to the
 * person who pressed the button as a provider error on a command that had
 * worked the day before with a smaller file.
 *
 * Two defects, and this file covers both.
 *
 * ## The document was being sent twice
 *
 * `documentTextOf` is the fix for the half nobody would have found from the
 * error message. A workbook's extracted `text` is built from its sheets, and
 * its `pageTables` then carry the same rows again; the reader concatenated
 * both, so every spreadsheet the module has ever read went to the vendor as
 * itself followed by itself. Twice the tokens, twice the cost, and on a large
 * bill it is what crossed the window.
 *
 * ## The window is measured, routed around, and read in parts
 *
 * Measured by `requestInputTokens`, published by each adapter as
 * `inputBudgetTokens`, routed on by `adapterFor` — a document the primary
 * cannot hold goes to a cleared vendor with a larger window where there is one
 * — and split by `partsOf` where the document is bigger than any window, so a
 * bundle nobody can send in one request is read in sequence instead of
 * refused.
 */

/** A vendor with a window of a stated size, and nothing else of interest. */
function stub(
  name: 'OPENAI' | 'GEMINI' | 'ANTHROPIC',
  inputBudgetTokens: number | undefined,
): AIProviderAdapter & { calls: number } {
  const adapter = {
    name,
    capability: 'REASONING' as const,
    multimodal: true,
    transmits: true,
    calls: 0,
    ...(inputBudgetTokens === undefined ? {} : { inputBudgetTokens }),
    estimateCostMinor: () => 10,
    healthy: () => true,
    async execute(request: ProviderRequest): Promise<ProviderResponse> {
      adapter.calls += 1;
      return { provider: name, modelClass: request.modelClass ?? 'default', output: { ok: true }, rawCostMinor: 10, latencyMs: 1 };
    },
  };
  return adapter as unknown as AIProviderAdapter & { calls: number };
}

/** A payload of roughly the requested token size, at the 4:1 heuristic. */
const payloadOf = (tokens: number): Record<string, unknown> => ({ document: 'x'.repeat(tokens * 4) });

describe('what a request costs in input tokens', () => {
  it('counts the task, the payload and the schema, not the payload alone', () => {
    const bare = requestInputTokens({ task: 'read', payload: {} });
    const withPayload = requestInputTokens({ task: 'read', payload: payloadOf(10_000) });
    const withSchema = requestInputTokens({
      task: 'read',
      payload: payloadOf(10_000),
      responseSchema: { type: 'object', properties: { passages: { type: 'array' } } },
    });

    assert.ok(withPayload > bare + 9_000, `payload should dominate: ${bare} then ${withPayload}`);
    assert.ok(withSchema > withPayload, 'the schema travels with the request and is charged for');
  });

  it('sizes a scan by its pages, because that is what the vendor charges for', () => {
    // Three megabytes of base64 — small enough to pass every byte ceiling on
    // the platform — against two hundred pages of it.
    const base64 = 'A'.repeat(3 * 1_048_576);
    const byBytes = requestInputTokens({ task: 'read', payload: {}, media: { contentType: 'application/pdf', base64, hash: 'sha256:a' } });
    const byPages = requestInputTokens({
      task: 'read',
      payload: {},
      media: { contentType: 'application/pdf', base64, hash: 'sha256:a', pages: 200 },
    });

    assert.ok(byPages > byBytes * 2, `pages must dominate bytes on a scan: ${byBytes} then ${byPages}`);
    assert.ok(byPages > ENDPOINTS.OPENAI.inputBudgetTokens, 'a 200-page scan does not fit a 400k window');
  });
});

describe('every vendor publishes the window it has', () => {
  it('keeps room for the answer inside the window', () => {
    for (const [name, endpoint] of Object.entries(ENDPOINTS)) {
      assert.ok(endpoint.inputBudgetTokens > 0, `${name} has no input budget`);
      // The reserve is the point: an input sized to the whole window leaves no
      // room for the reply, and the failure is a truncated answer rather than a
      // refusal.
      assert.ok(endpoint.inputBudgetTokens < 1_048_576, `${name} claims the whole window as input`);
    }
  });

  it('ranks them as the vendors do, so routing to a larger window means something', () => {
    assert.ok(ENDPOINTS.GEMINI.inputBudgetTokens > ENDPOINTS.OPENAI.inputBudgetTokens);
    assert.ok(ENDPOINTS.OPENAI.inputBudgetTokens > ENDPOINTS.ANTHROPIC.inputBudgetTokens);
  });

  it('refuses an oversized call at the adapter without opening a socket', async () => {
    const adapter = new RemoteProviderAdapter('OPENAI', 'REASONING');
    assert.equal(adapter.inputBudgetTokens, ENDPOINTS.OPENAI.inputBudgetTokens);

    // Past the window by a wide margin. If the guard were missing this would
    // reach api.openai.com with a nonsense key and fail some other way, which
    // is what makes the assertion worth making.
    const refusal = await rejectsCode(
      () => adapter.execute({ task: 'read', payload: payloadOf(adapter.inputBudgetTokens + 50_000) }),
      'AI_INPUT_TOO_LARGE',
    );
    assert.match(refusal.message ?? '', /nothing was charged/i);
    assert.match(refusal.message ?? '', /OPENAI accepts/);
  });
});

describe('the vendor that serves a call is chosen with its window in mind', () => {
  it('routes a document the primary cannot hold to a cleared vendor that can', () => {
    const small = stub('OPENAI', 100_000);
    const large = stub('GEMINI', 900_000);
    const orchestrator = new AIOrchestrator({ reasoning: small, perception: large });

    assert.equal(orchestrator.adapterFor('REASONING', 'INTERNAL', 50_000).name, 'OPENAI', 'small enough for the primary');
    assert.equal(orchestrator.adapterFor('REASONING', 'INTERNAL', 500_000).name, 'GEMINI', 'past the primary, inside the spare');
  });

  it('refuses by size when no cleared window holds it, before anything is reserved', () => {
    const small = stub('OPENAI', 100_000);
    const also = stub('GEMINI', 120_000);
    const orchestrator = new AIOrchestrator({ reasoning: small, perception: also });

    const refusal = throwsCode(() => orchestrator.adapterFor('REASONING', 'INTERNAL', 400_000), 'AI_INPUT_TOO_LARGE');
    assert.match(refusal.message ?? '', /400k tokens/);
    assert.match(refusal.message ?? '', /120k/, 'names the largest window actually available');
    assert.match(refusal.message ?? '', /in parts/, 'says what to do about it');
    assert.equal(small.calls + also.calls, 0, 'nothing was sent');
  });

  it('leaves an unmeasured call alone', () => {
    const small = stub('OPENAI', 100_000);
    const orchestrator = new AIOrchestrator({ reasoning: small, perception: small });
    assert.equal(orchestrator.adapterFor('REASONING').name, 'OPENAI');
  });
});

describe('how much document text one call can carry', () => {
  it('answers in characters, below the window it came from', () => {
    const orchestrator = new AIOrchestrator({ reasoning: stub('OPENAI', 200_000), perception: stub('OPENAI', 200_000) });
    const budget = orchestrator.textBudgetChars({ capability: 'REASONING' });

    assert.ok(budget > 100_000, 'a window of 200k tokens is worth more than 100k characters');
    assert.ok(budget < 200_000 * 4, 'the task, the schema and the constraint travel with every part');
  });

  it('sizes parts to the smallest cleared window, so any vendor can serve any part', () => {
    const orchestrator = new AIOrchestrator({ reasoning: stub('GEMINI', 900_000), perception: stub('OPENAI', 200_000) });
    const budget = orchestrator.textBudgetChars({ capability: 'REASONING' });

    // Not the primary's 900k. A part sized for it would fail over to nowhere
    // the moment the primary went unhealthy — half way through a document, with
    // the earlier parts already charged.
    assert.ok(budget < 200_000 * 4, `sized to the smallest window, not the largest: ${budget}`);
  });

  it('does not split anything for an adapter with no window', () => {
    // The deterministic local engines, which read their inputs in process.
    const orchestrator = new AIOrchestrator({ reasoning: stub('OPENAI', undefined), perception: stub('OPENAI', undefined) });
    assert.equal(orchestrator.textBudgetChars({ capability: 'REASONING' }), Number.MAX_SAFE_INTEGER);
  });
});

describe('one document, each word of it sent once', () => {
  it('does not send a workbook twice over', () => {
    // What `office.ts` returns: `text` built from the sheets, and the same rows
    // again under `pageTables`.
    const rows = [
      ['Item', 'Description', 'Qty', 'Rate'],
      ['A10', 'Excavate to reduce level', '1200', '14.50'],
      ['A20', 'Disposal off site', '980', '22.00'],
    ];
    const text = `Bill 1\n${rows.map((row) => row.join('\t')).join('\n')}`;

    const once = documentTextOf({ method: 'NATIVE', text, tables: rows, pageTables: [{ page: 1, rows }] });

    assert.ok(once.includes('Excavate to reduce level'));
    assert.equal(
      once.split('Excavate to reduce level').length - 1,
      1,
      'the bill was being sent as itself followed by itself',
    );
    assert.ok(once.length < text.length * 1.2, `no doubling: ${text.length} in, ${once.length} out`);
  });

  it('keeps a table row the text does not already carry', () => {
    // A PDF whose reconstructed columns are not how the text layer flowed.
    const once = documentTextOf({
      method: 'NATIVE',
      text: 'Schedule of rates\n(see table overleaf)',
      pageTables: [{ page: 2, rows: [['B10', 'Formwork to soffits', '340']] }],
    });

    assert.ok(once.includes('Schedule of rates'));
    assert.ok(once.includes('Formwork to soffits'), 'a row the prose does not hold is worth having');
  });

  it('carries a document with no tables through unchanged', () => {
    assert.equal(documentTextOf({ method: 'NATIVE', text: 'Clause 4.2 — the Contractor shall insure.' }), 'Clause 4.2 — the Contractor shall insure.');
  });
});

describe('a document bigger than any window is read in parts', () => {
  const clause = (number: number): string =>
    `Clause ${number}. The Contractor shall provide everything necessary for the completion of the Works, ` +
    'including supervision, plant and materials, to the satisfaction of the Employer.';

  it('returns the document whole when it fits', () => {
    const text = clause(1);
    assert.deepEqual(partsOf(text, 10_000), [text]);
  });

  it('splits at blank lines, keeps every part inside the budget, and loses nothing', () => {
    const clauses = Array.from({ length: 200 }, (_, index) => clause(index + 1));
    const text = clauses.join('\n\n');
    const budget = 2_000;

    const parts = partsOf(text, budget);

    assert.ok(parts.length > 1, 'a document of this size does not fit in one part');
    for (const part of parts) assert.ok(part.length <= budget, `a part of ${part.length} exceeds the budget`);
    // Nothing dropped: every clause survives somewhere, and a clause is never
    // cut in half — a passage quoted across a boundary would be a sentence the
    // document does not contain.
    const rejoined = parts.join('\n\n');
    for (const one of clauses) assert.ok(rejoined.includes(one), `${one.slice(0, 12)} was lost in the split`);
  });

  it('cuts a single line longer than a whole part, because the alternative is a part that cannot be sent', () => {
    const parts = partsOf('x'.repeat(5_000), 1_000);
    assert.equal(parts.length, 5);
    for (const part of parts) assert.ok(part.length <= 1_000);
    assert.equal(parts.join(''), 'x'.repeat(5_000));
  });

  it('never returns nothing', () => {
    assert.deepEqual(partsOf('', 100), ['']);
    assert.deepEqual(partsOf('   ', 100), ['   ']);
  });
});
