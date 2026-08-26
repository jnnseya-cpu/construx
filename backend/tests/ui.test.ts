import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// The design system is plain ES modules with no DOM dependency in the parts
// tested here, so it can be imported directly rather than through a browser.
import { badge, esc, html, raw, resolveHtml, table } from '../../frontend/lib/ui.js';

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
