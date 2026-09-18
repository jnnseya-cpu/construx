import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
// The design system is plain ES modules with no DOM dependency in the parts
// tested here, so it can be imported directly rather than through a browser.
import { badge, ellipsis, esc, html, raw, reference, resolveHtml, table } from '../../frontend/lib/ui.js';

/** The console's source, for the check that no file declares a weaker escaper. */
const FRONTEND_DIR = resolve(import.meta.dirname, '..', '..', 'frontend');

/**
 * The escaping layer.
 *
 * Two things have to hold and neither is obvious from reading a call site.
 * Anything interpolated is escaped unless it was deliberately marked as markup,
 * and marking something that is already markup must not destroy it — which is
 * exactly what used to happen, silently, in the rendered output rather than at
 * the call.
 */

describe('the design system escapes what it should', () => {
  it('escapes an interpolated value', () => {
    assert.equal(resolveHtml(html`<p>${'<script>alert(1)</script>'}</p>`), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('escapes the characters that break out of an attribute', () => {
    assert.equal(esc('a"b<c>d&e'), 'a&quot;b&lt;c&gt;d&amp;e');
  });

  it('leaves a value marked as markup alone', () => {
    assert.equal(resolveHtml(html`<p>${raw('<b>bold</b>')}</p>`), '<p><b>bold</b></p>');
  });

  /**
   * The defect. `raw(badge(...))` reads naturally, because most interpolations
   * do need wrapping — and `badge` already returns markup, so `String()` over it
   * produced the literal text `[object Object]` on the screen. It failed in the
   * output rather than at the call, and a browser found one on the clarification
   * register that no test had.
   */
  it('passes an already-marked value through rather than stringifying it', () => {
    assert.equal(resolveHtml(raw(badge('open', 'ok'))), '<span class="badge ok">open</span>');
    assert.equal(resolveHtml(html`${raw(raw('<i>x</i>'))}`), '<i>x</i>');
  });

  it('renders a badge inside a table cell as markup, not as an object', () => {
    const rendered = resolveHtml(table({ headers: ['Ref', 'State'], rows: [['TQ-002', badge('open', 'info')]] }));
    assert.match(rendered, /<span class="badge info">open<\/span>/);
    assert.doesNotMatch(rendered, /\[object Object\]/);
  });

  it('renders a nested fragment inside a table cell', () => {
    const rendered = resolveHtml(
      table({ headers: ['Subject'], rows: [[html`Amey rate build-up ${badge('in confidence', 'warn')}`]] }),
    );
    assert.match(rendered, /Amey rate build-up <span class="badge warn">in confidence<\/span>/);
    assert.doesNotMatch(rendered, /\[object Object\]/);
  });

  it('renders nothing for a null or undefined cell rather than the word', () => {
    const rendered = resolveHtml(table({ headers: ['A', 'B'], rows: [[null, undefined]] }));
    assert.doesNotMatch(rendered, /null|undefined/);
  });
});

/**
 * Shortening a reference without destroying it.
 *
 * Both of these reached a live screen. The autopilot evidence line ran
 * `String(refId).slice(-8)`, which is right for a ULID — the last eight
 * characters are the handle people quote — and wrong for every reference the
 * ledger stores as a sentence. Under a finding about unsafe configuration it
 * rendered `guration` and `oduction`: the tails of "…configuration" and
 * "…production". On a screen whose whole claim is that every figure traces to a
 * record, the reference reading as a word fragment looks like corruption.
 *
 * The decision-owner picker cut labels at 70 characters with no ellipsis, so a
 * finding ended "…no lookahead has ever been publishe" — which reads as a
 * truncated database column rather than as a label that was deliberately
 * shortened.
 */
describe('a reference is shortened only where shortening keeps its meaning', () => {
  it('takes the tail of an opaque handle, which is what people quote', () => {
    assert.equal(reference('01M156V768H1393C3QBVGK54GX'), 'BVGK54GX');
  });

  it('never turns a sentence into a word fragment', () => {
    // The exact two values that produced `guration` and `oduction` on screen.
    const configuration = 'AI_PROVIDER_CLEARANCE is unset, which is unsafe configuration';
    const production = 'NODE_ENV is not production';

    assert.doesNotMatch(reference(configuration), /^guration$/);
    assert.doesNotMatch(reference(production), /^oduction$/);
    // And it still says something a reader can act on.
    assert.match(reference(production), /NODE_ENV/);
  });

  it('leaves a short reference exactly as it is', () => {
    assert.equal(reference('TQ-002'), 'TQ-002');
    assert.equal(reference(''), '');
    assert.equal(reference(undefined), '');
  });

  it('marks a shortened label as shortened, at a word boundary', () => {
    const summary = 'The project is in construction and no lookahead has ever been published.';
    const label = ellipsis(summary, 70);

    assert.ok(label.endsWith('…'), `no ellipsis on a cut label: ${label}`);
    assert.doesNotMatch(label, /publishe…$/, 'cut in the middle of a word');
    assert.ok(label.length <= 71, `longer than asked for: ${label.length}`);
  });

  it('leaves a label that fits completely alone, with no ellipsis', () => {
    assert.equal(ellipsis('Short enough', 70), 'Short enough');
  });

  it('still cuts a single word that has no boundary to respect', () => {
    const long = 'x'.repeat(200);
    assert.equal(ellipsis(long, 20), `${'x'.repeat(20)}…`);
  });
});

/**
 * The bug that put `[object Object]` on the command centre, made unrepeatable.
 *
 * `html` returns a marked object, not a string — that is what lets `resolve`
 * tell markup from text and escape the text. So `array.map(x => html`…`)` is
 * an array of *objects*, and `.join('')` on it calls `String()` on each one.
 * The screen showed four `[object Object]` where the four regions belonged and
 * seven more where the functions belonged, and the headline above them —
 * "1 thing needs deciding today" — proved there was real content behind it.
 *
 * The interpolation already handles arrays: `resolve` maps over them. So the
 * fix is to stop joining, and this is the test that stops it coming back.
 */
describe('a markup fragment survives being stringified', () => {
  it('joins into markup rather than into the word "object"', () => {
    const joined = ['a', 'b'].map((x) => html`<li>${x}</li>`).join('');
    assert.equal(joined, '<li>a</li><li>b</li>');
    assert.doesNotMatch(joined, /\[object Object\]/);
  });

  /**
   * The exact shape that shipped. `card` is a function returning a fragment, so
   * the callback holds no template literal — which is why the source-scan test
   * written first could not see it, and why the fix belongs in `raw` instead.
   */
  it('survives a join whose callback calls a fragment-returning helper', () => {
    const card = (entry: string) => html`<article>${entry}</article>`;
    const rendered = ['one', 'two'].map((entry) => card(entry)).join('');
    assert.equal(rendered, '<article>one</article><article>two</article>');
  });

  it('interpolates into a plain template literal as markup', () => {
    assert.equal(`<ul>${html`<li>x</li>`}</ul>`, '<ul><li>x</li></ul>');
  });

  it('still escapes text and still does not escape markup, which is the point of the marker', () => {
    // Nothing about the escaping decision may move: `resolve` reads the symbol,
    // never `toString`. A fragment that started escaping itself would be a
    // far worse defect than the one this fixes.
    assert.equal(resolveHtml(html`<p>${'<b>x</b>'}</p>`), '<p>&lt;b&gt;x&lt;/b&gt;</p>');
    assert.equal(resolveHtml(html`<p>${raw('<b>x</b>')}</p>`), '<p><b>x</b></p>');
  });

  it('renders an array of fragments without a join at all', () => {
    assert.equal(resolveHtml(html`<ul>${['a', 'b'].map((x) => html`<li>${x}</li>`)}</ul>`), '<ul><li>a</li><li>b</li></ul>');
  });

  it('marks a value once, so wrapping an already-marked fragment is not double work', () => {
    const once = html`<i>x</i>`;
    assert.equal(raw(once), once);
  });

});

describe('the escaper closes every attribute context', () => {
  /**
   * Found in a launch audit, by feeding the escaper an apostrophe.
   *
   * `esc` escaped `&`, `<`, `>` and `"`, which is enough for every attribute in
   * this console *except one*: `copilot.js` writes `data-drill='…'` in single
   * quotes. An apostrophe reaching that value closes the attribute and starts a
   * new one, which is attribute-injection XSS.
   *
   * Nothing could reach it — the value is `JSON.stringify` of a closed-catalogue
   * entity type and a ULID. But that is a fact about data in two other files,
   * and a safety property that holds only while nobody adds an identifier with a
   * quote in it is one with a date on it.
   *
   * The same audit found `copilot.js` declaring its own escaper that handled
   * neither `"` nor `'`, while using it inside two double-quoted attributes.
   * That one is deleted; this asserts the survivor is strong enough to be the
   * only one.
   */
  it('escapes all five characters that can break out of markup', () => {
    for (const [input, expected] of [
      ['&', '&amp;'],
      ['<', '&lt;'],
      ['>', '&gt;'],
      ['"', '&quot;'],
      ["'", '&#39;'],
    ] as const) {
      assert.equal(esc(input), expected, `${input} is not escaped`);
    }
  });

  it('cannot be broken out of a single-quoted attribute', () => {
    const payload = "x' onmouseover='alert(1)";
    const markup = resolveHtml(html`<span data-drill='${payload}'></span>`);
    // The word survives as text — that is fine and expected. What must not
    // survive is the quote that would end the attribute and begin a new one.
    assert.doesNotMatch(markup, /'\s*onmouseover/, 'the payload closed the attribute');
    assert.match(markup, /&#39;/, 'the apostrophe was not encoded');
    // Exactly two apostrophes in the output: the ones this template wrote.
    assert.equal((markup.match(/'/g) ?? []).length, 2, 'an unescaped apostrophe reached the markup');
  });

  it('cannot be broken out of a double-quoted attribute', () => {
    const payload = 'x" onmouseover="alert(1)';
    const markup = resolveHtml(html`<span title="${payload}"></span>`);
    assert.doesNotMatch(markup, /"\s*onmouseover/, 'the payload closed the attribute');
    assert.equal((markup.match(/"/g) ?? []).length, 2, 'an unescaped double quote reached the markup');
  });

  it('leaves no private escaper in the console weaker than this one', () => {
    /*
     * The pattern, not the instance. A file that declares its own escaper is a
     * file where somebody has to get escaping right a second time, and the one
     * found in this audit got it wrong in exactly the way that matters.
     *
     * Escaping `'` is the test: anything that handles the apostrophe is at
     * least as strong as `esc`, and anything that does not is a downgrade
     * waiting for an attribute to be written in single quotes.
     */
    const weak: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!['icons', 'shots', 'media'].includes(entry.name)) walk(full);
          continue;
        }
        if (!entry.name.endsWith('.js')) continue;
        const source = readFileSync(full, 'utf8');
        for (const match of source.matchAll(/function (escape\w*)\s*\(value\)\s*\{([\s\S]{0,400}?)\n\}/g)) {
          const body = match[2] as string;
          // A handler named `escape` for the Escape key is not an escaper.
          if (!body.includes('replace')) continue;
          if (!/&#39;|&apos;|'\\''|\[&<>"']/.test(body) && !body.includes("'/g")) {
            weak.push(`${full.slice(full.indexOf('frontend'))} — ${match[1]} does not escape the apostrophe`);
          }
        }
      }
    };
    walk(FRONTEND_DIR);
    assert.deepEqual(weak, [], `\n${weak.join('\n')}\n`);
  });
});
