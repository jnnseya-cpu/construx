import { api } from './api.js';
import { html, positionReport, raw, render } from './ui.js';

/**
 * A read that cannot answer until somebody chooses what to ask about.
 *
 * Twelve of the platform's reads are like this. `/measurement/:scheduleId/
 * reconciliation/:againstId` compares two schedules; `/assets/:assetTag/
 * information` answers the tag-on-a-plate question; `/handover-manifests/
 * :manifestId/verify` re-hashes one manifest against the live record. None of
 * them has a standing answer, so none of them can be a panel that simply
 * renders on load — a panel would have to invent an id, and inventing an id is
 * how a screen ends up confidently describing the wrong thing.
 *
 * So they get a chooser instead: the ids the page already holds, offered by
 * name, and the answer rendered underneath when somebody asks for it.
 *
 * Two properties this keeps.
 *
 * **The options come from records the page already has.** Never a free-text box
 * called `manifestId`. If the page holds no manifests the chooser says so and
 * offers nothing, which is the truth — rather than a text field that can only
 * produce a 404.
 *
 * **A refusal is rendered as a refusal.** These reads are authorised
 * individually and some of them will be denied; `positionReport` shows that as
 * a named refusal rather than as an empty answer.
 */

/**
 * @param {object}   spec
 * @param {string}   spec.id        Unique on the page; ties the control to its output.
 * @param {string}   spec.title
 * @param {string}  [spec.intent]
 * @param {Array}    spec.inputs    `{ name, label, options }` or `{ name, label, type: 'text', placeholder }`
 * @param {Function} spec.path      `(values) => '/v1/...'`
 * @param {Array}    spec.sections  Passed to `positionReport`.
 * @param {string}   spec.empty     Shown when there is nothing to choose from.
 */
export function lookupPanel(spec) {
  // Every select that has nothing to offer means this lookup cannot be used
  // yet. Said plainly rather than rendering a dead control.
  const unusable = spec.inputs.some((input) => input.type !== 'text' && (input.options ?? []).length === 0);

  return html`<div class="card" data-lookup="${spec.id}">
    <h2>${spec.title}</h2>
    ${spec.intent ? html`<div class="metric-sub" style="margin-bottom:10px">${spec.intent}</div>` : ''}
    ${unusable
      ? html`<div class="empty"><b>${spec.empty}</b></div>`
      : html`
          <div class="actions" style="gap:10px;flex-wrap:wrap;align-items:flex-end">
            ${spec.inputs.map(
              (input) => html`<label class="field" style="min-width:220px">
                <span>${input.label}</span>
                ${input.type === 'text'
                  ? html`<input type="text" name="${input.name}" placeholder="${input.placeholder ?? ''}" />`
                  : html`<select name="${input.name}">
                      ${(input.options ?? []).map((option) => html`<option value="${option.value}">${option.label}</option>`)}
                    </select>`}
              </label>`,
            )}
            <button class="btn quiet" data-lookup-go="${spec.id}">Look up</button>
          </div>
          <div data-lookup-out="${spec.id}"></div>
        `}
  </div>`;
}

/**
 * Wire every lookup on the page. Call once, after `render`.
 *
 * @param {HTMLElement} root
 * @param {Array} specs The same specs passed to `lookupPanel`.
 */
export function wireLookups(root, specs) {
  for (const spec of specs) {
    const host = root.querySelector(`[data-lookup="${spec.id}"]`);
    const button = host?.querySelector(`[data-lookup-go="${spec.id}"]`);
    const out = host?.querySelector(`[data-lookup-out="${spec.id}"]`);
    if (!host || !button || !out) continue;

    button.addEventListener('click', async () => {
      const values = {};
      for (const input of spec.inputs) {
        values[input.name] = host.querySelector(`[name="${input.name}"]`)?.value ?? '';
      }
      // A text lookup with nothing typed would ask the platform about the empty
      // string, which is a question with no useful answer.
      if (spec.inputs.some((input) => !values[input.name])) {
        render(out, html`<div class="notice warn">Choose something to look up first.</div>`);
        return;
      }

      button.disabled = true;
      const previous = button.textContent;
      button.textContent = 'Looking up…';
      try {
        const data = await api.get(spec.path(values));
        render(out, positionReport({ title: spec.title, data, sections: spec.sections }));
      } catch (error) {
        // Through `positionReport` so a refusal here looks exactly like a
        // refusal anywhere else on the platform, rather than a toast that fades.
        render(out, positionReport({ title: spec.title, data: {}, error, sections: [] }));
      } finally {
        button.disabled = false;
        button.textContent = previous;
      }
    });
  }
}
