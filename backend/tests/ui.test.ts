import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
// The design system is plain ES modules with no DOM dependency in the parts
// tested here, so it can be imported directly rather than through a browser.
import { badge, ellipsis, esc, html, raw, reference, resolveHtml, table } from '../../frontend/lib/ui.js';

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
