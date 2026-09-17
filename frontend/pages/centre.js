import { api } from '../lib/api.js';
import { activeFilter, filterChip, narrow } from '../lib/crossfilter.js';
import { badge, html, positionReport, raw, render } from '../lib/ui.js';
import { barChart, pieChart } from '../lib/charts.js';
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
    <article class="card">
      <div class="row">
        ${raw(badge(entry.severity, TONE[entry.severity] ?? 'info'))}
        ${entry.dueBy ? html`<span class="muted small">due ${entry.dueBy}</span>` : ''}
        ${entry.valueMinor ? html`<span class="muted small">${money(entry.valueMinor)}</span>` : ''}
      </div>
      <h3>${entry.headline}</h3>
      <p class="small">${entry.detail}</p>
      ${entry.source
        ? html`<p class="muted small">Read from ${entry.source.refType} ${entry.source.refId}</p>`
        : ''}
    </article>
  `;
}

export async function centre(root) {
  const projectId = state.session.projectId;

  // The catalogue the platform publishes, so a client never hardcodes the
  // seven. Fetched alongside the report rather than derived from it: the report
  // carries what this viewer may see, and the catalogue carries what exists —
  // and the difference between those two is the point of the refusal list below.
  const catalogue = await api.get('/v1/command-centre/functions').catch((error) => ({ error }));

  const report = await api.get(`/v1/projects/${projectId}/command-centre`).catch((error) => ({
    error: error?.detail ?? error?.message ?? 'The command centre could not be assembled.',
    functions: [],
    attention: [],
    headline: '',
  }));

  const functions = report.functions ?? [];
  const available = functions.filter((entry) => entry.available);
  const refused = functions.filter((entry) => !entry.available);
  const everything = available.flatMap((entry) => entry.cards.map((c) => ({ ...c, from: entry.label })));

  /*
   * The cross-filter, applied before anything is built.
   *
   * Every figure below — the four charts, the counts in their captions, the
   * cards in the four regions, the data panels and therefore the exports — is
   * computed from `cards`. Narrowing here rather than hiding rows afterwards is
   * what makes them all agree: there is one array and everything reads it.
   *
   * `available` is narrowed too, so the by-function chart counts the same
   * cards the rest of the screen is showing rather than the unfiltered set.
   */
  const filter = activeFilter();
  // One predicate, applied to the flat list and to each function's own list, so
  // the by-function chart counts the same cards the rest of the screen shows.
  // Comparing object identity across the two shapes does not work — the flat
  // list spreads each card to add `from` — and a chart counting the unfiltered
  // set beside three that are filtered is the exact half-applied filter this
  // design exists to prevent.
  const keep = (list) => narrow(narrow(list, 'severity', (card) => card.severity), 'region', (card) => card.region);
  const cards = keep(everything);
  const shown = available.map((entry) => ({ ...entry, cards: keep(entry.cards ?? []) }));

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

      ${filterChip()}

      ${report.error ? html`<div class="notice bad">${report.error}</div>` : ''}

      ${report.headline
        ? html`<div class="notice ${report.attention?.some((c) => c.severity === 'URGENT') ? 'warn' : 'info'}">
            <strong>${report.headline}</strong>
          </div>`
        : ''}

      ${centreCharts(cards, functions, shown, refused)}

      <section class="grid cols-4">
        ${REGIONS.map((region) => {
          const inRegion = cards.filter((entry) => entry.region === region.id);
          return html`
            <div class="col centre-region">
              <h3>${region.label}</h3>
              <p class="muted small">${region.blurb}</p>
              ${inRegion.length === 0
                ? html`<p class="muted small">
                    Nothing in this region from the functions you can reach.
                  </p>`
                : inRegion.map((entry) => card(entry))}
            </div>
          `;
        })}
      </section>

      <section class="card">
        <h3>The seven functions</h3>
        <p class="muted small">
          Each one calls the same domain reads any other screen does, so what appears here is exactly what
          you are entitled to see anywhere else.
        </p>
        <ul class="list">
          ${functions.map(
            (entry) => html`
              <li>
                ${raw(badge(entry.available ? 'reaches you' : 'outside your authority', entry.available ? 'good' : 'muted'))}
                <strong>${entry.label}</strong> — ${entry.what}
                ${entry.available
                  ? html`<span class="muted small">${entry.cards.length} card${entry.cards.length === 1 ? '' : 's'}</span>`
                  : html`<p class="muted small">${entry.because ?? 'No reason was given.'}</p>`}
              </li>
            `,
          )}
        </ul>
        ${refused.length > 0
          ? html`<p class="muted small">
              ${refused.length} function${refused.length === 1 ? ' is' : 's are'} outside your authority. They are
              listed rather than hidden: a panel that vanishes tells you nothing, and the reason names who to ask.
            </p>`
          : ''}
      </section>

      ${positionReport({
        title: 'The seven functions',
        intent:
          'Published by the platform, so a client never hardcodes them. What you can reach is above; this is what ' +
          'exists.',
        data: catalogue,
        error: catalogue?.error,
        sections: [{ key: 'functions', label: 'Functions', empty: 'No function is published.' }],
      })}
    `,
  );
}

/**
 * The command centre, as shape before it is read as a list.
 *
 * Four regions of cards is the right structure and the wrong first impression:
 * a person opening this screen wants to know *how much* is urgent and *where*
 * it is coming from before they start reading headlines one at a time. Both
 * questions are answerable from the cards the report already returned — this
 * counts them and draws nothing it was not given.
 *
 * The refusals are charted too, deliberately. A function this reader cannot
 * reach is not an empty space on the screen; it is a named gap, and showing how
 * much of the centre is withheld is the difference between "there is nothing
 * happening" and "you are not cleared to see it".
 */
function centreCharts(cards, functions, available, refused) {
  if (cards.length === 0 && refused.length === 0) return '';

  const REGION_LABEL = {
    HAPPENING: 'What is happening',
    CHANGED: 'What changed',
    AT_RISK: 'What is at risk',
    NEXT: 'What to do next',
  };

  // `filterKey` is the value the record carries; `label` is what a reader is
  // shown. Both, because a chip reading "URGENT" is shouting an enum at somebody.
  const bySeverity = ['URGENT', 'ATTENTION', 'INFO'].map((severity) => ({
    label: severity.charAt(0) + severity.slice(1).toLowerCase(),
    filterKey: severity,
    value: cards.filter((card) => card.severity === severity).length,
    tone: TONE[severity],
  }));

  const byRegion = Object.entries(REGION_LABEL).map(([id, label]) => ({
    label,
    value: cards.filter((card) => card.region === id).length,
  }));

  const byFunction = available
    .map((entry) => ({ label: entry.label, value: (entry.cards ?? []).length }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value);

  // Money is only on some cards, and a total of the ones that carry it would
  // read as the project's exposure. Charted per card instead, largest first,
  // so the figure stays attached to the thing it belongs to.
  const valued = cards
    .filter((card) => Number(card.valueMinor) > 0)
    .sort((a, b) => Number(b.valueMinor) - Number(a.valueMinor))
    .slice(0, 8)
    .map((card) => ({ label: card.headline, value: Number(card.valueMinor) }));

  return html`
    <div class="grid g2" style="margin-bottom:14px">
      <div class="card">
        <h2>How much needs you, and how badly</h2>
        ${raw(
          pieChart({
            title: 'By severity',
            // Clicking a slice filters the whole screen to that severity: the
            // other three charts, the card regions and the exports all narrow,
            // because they are all built from the same array this one is.
            dimension: 'severity',
            data: bySeverity.filter((entry) => entry.value > 0),
            format: (value) => `${value} item${value === 1 ? '' : 's'}`,
            centreLabel: String(cards.length),
            empty: 'Nothing is raised against this project from the functions you can reach.',
            footnote: `${cards.length} item${cards.length === 1 ? '' : 's'} across ${available.length} function${available.length === 1 ? '' : 's'}` +
              `${refused.length > 0 ? `, with ${refused.length} function${refused.length === 1 ? '' : 's'} withheld from your role` : ''}.`,
          }),
        )}
      </div>
      <div class="card">
        <h2>Where it is coming from</h2>
        ${raw(
          barChart({
            title: 'By function',
            horizontal: true,
            data: byFunction,
            format: (value) => `${value} item${value === 1 ? '' : 's'}`,
            empty: 'No function you can reach has raised anything.',
            footnote: 'Each function reads the ledger through the ordinary domain path; nothing here is a separate report.',
          }),
        )}
      </div>
    </div>

    <div class="grid g2" style="margin-bottom:14px">
      <div class="card">
        <h2>Across the four questions</h2>
        ${raw(
          barChart({
            title: 'By region',
            data: byRegion,
            format: (value) => `${value} item${value === 1 ? '' : 's'}`,
            empty: 'Nothing has been raised in any region.',
          }),
        )}
      </div>
      <div class="card">
        <h2>What it is worth</h2>
        ${raw(
          barChart({
            title: 'By value',
            horizontal: true,
            data: valued,
            format: (value) =>
              new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 }).format(value / 100),
            empty: 'No item raised against this project carries a value.',
            footnote: 'Per item, not totalled — a sum of these would read as the project’s exposure, which it is not.',
          }),
        )}
      </div>
    </div>
  `;
}
