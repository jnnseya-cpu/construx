import { api } from '../lib/api.js';
import { badge, html, raw, render } from '../lib/ui.js';
import { state } from '../app.js';

/**
 * The AI command centre.
 *
 * Four fixed regions — what is happening, what changed, what is at risk, what
 * to do next — populated from seven functions, each of which reads the ledger
 * through the ordinary domain path.
 *
 * The screen makes two things visible that a dashboard usually hides.
 *
 * **A function the reader may not see says so, by name.** The API returns every
 * function whether or not the viewer's authority reaches it, with the domain's
 * own sentence attached. An empty panel tells somebody nothing; "you do not hold
 * CONTRACTS_CLAIMS on this project" tells them exactly who to ask.
 *
 * **Nothing here decides what the reader may see.** There is no permission logic
 * in this file and none in the API route either — every function calls the read
 * that authorises for any other caller. A check in the browser would be a
 * suggestion; this is the enforcement.
 */

const TONE = { URGENT: 'bad', ATTENTION: 'warn', INFO: 'info' };

const REGIONS = [
  { id: 'HAPPENING', label: 'What is happening', blurb: 'The position right now, from materialised state.' },
  { id: 'CHANGED', label: 'What changed', blurb: 'Movement since yesterday, attributable to the person who caused it.' },
  { id: 'AT_RISK', label: 'What is at risk', blurb: 'Exposure the record can already see, before anybody reports it.' },
  { id: 'NEXT', label: 'What to do next', blurb: 'Decisions waiting, ordered by consequence rather than by age.' },
];

function money(minor) {
  if (minor === undefined || minor === null) return '';
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 }).format(
    minor / 100,
  );
}

function card(entry) {
  return html`
    <article class="card centre-card">
      <div class="row">
        ${raw(badge(entry.severity, TONE[entry.severity] ?? 'info'))}
        ${entry.dueBy ? html`<span class="muted small">due ${entry.dueBy}</span>` : ''}
        ${entry.valueMinor ? html`<span class="muted small">${money(entry.valueMinor)}</span>` : ''}
      </div>
      <h4>${entry.headline}</h4>
      <p class="small">${entry.detail}</p>
      ${entry.source
        ? html`<p class="muted small">Read from ${entry.source.refType} ${entry.source.refId}</p>`
        : ''}
    </article>
  `;
}

export async function centre(root) {
  const projectId = state.session.projectId;

  const report = await api.get(`/v1/projects/${projectId}/command-centre`).catch((error) => ({
    error: error?.detail ?? error?.message ?? 'The command centre could not be assembled.',
    functions: [],
    attention: [],
    headline: '',
  }));

  const functions = report.functions ?? [];
  const available = functions.filter((entry) => entry.available);
  const refused = functions.filter((entry) => !entry.available);
  const cards = available.flatMap((entry) => entry.cards.map((c) => ({ ...c, from: entry.label })));

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Command centre</h1>
          <p>
            Assembled for you, from what your authority reaches. Seven functions over four questions —
            everything here is arithmetic over the record, so every figure can be checked back to the
            events it came from.
          </p>
        </div>
      </div>

      ${report.error ? html`<div class="notice bad">${report.error}</div>` : ''}

      ${report.headline
        ? html`<div class="notice ${report.attention?.some((c) => c.severity === 'URGENT') ? 'warn' : 'info'}">
            <strong>${report.headline}</strong>
          </div>`
        : ''}

      <section class="grid cols-4">
        ${raw(
          REGIONS.map((region) => {
            const inRegion = cards.filter((entry) => entry.region === region.id);
            return html`
              <div class="col centre-region">
                <h3>${region.label}</h3>
                <p class="muted small">${region.blurb}</p>
                ${inRegion.length === 0
                  ? html`<p class="muted small">
                      Nothing in this region from the functions you can reach.
                    </p>`
                  : raw(inRegion.map((entry) => card(entry)).join(''))}
              </div>
            `;
          }).join(''),
        )}
      </section>

      <section class="card">
        <h3>The seven functions</h3>
        <p class="muted small">
          Each one calls the same domain reads any other screen does, so what appears here is exactly what
          you are entitled to see anywhere else.
        </p>
        <ul class="list">
          ${raw(
            functions
              .map(
                (entry) => html`
                  <li>
                    ${raw(badge(entry.available ? 'reaches you' : 'outside your authority', entry.available ? 'good' : 'muted'))}
                    <strong>${entry.label}</strong> — ${entry.what}
                    ${entry.available
                      ? html`<span class="muted small">${entry.cards.length} card${entry.cards.length === 1 ? '' : 's'}</span>`
                      : html`<p class="muted small">${entry.because ?? 'No reason was given.'}</p>`}
                  </li>
                `,
              )
              .join(''),
          )}
        </ul>
        ${refused.length > 0
          ? html`<p class="muted small">
              ${refused.length} function${refused.length === 1 ? ' is' : 's are'} outside your authority. They are
              listed rather than hidden: a panel that vanishes tells you nothing, and the reason names who to ask.
            </p>`
          : ''}
      </section>
    `,
  );
}
