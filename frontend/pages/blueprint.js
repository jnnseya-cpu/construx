import { api } from '../lib/api.js';
import { barChart, funnelChart, pieChart } from '../lib/charts.js';
import { head, refusal } from '../lib/estate.js';
import { badge, html, humanise, raw, render, table } from '../lib/ui.js';

/**
 * The blueprint, against the build.
 *
 * `docs/ai-os-blueprint.md` makes claims about what this platform is and how far
 * each part of it has got, marked `[BUILT]`, `[EXTEND]` or `[NEW]`. A document
 * like that goes stale in one direction only: the claims stay and the build
 * moves.
 *
 * So this screen does not display the document. It puts the claims read out of
 * it **next to figures counted from the running process** — routes on this
 * gateway, codes in this catalogue, entity types classified, agents registered,
 * events actually written. Where a claim and a count disagree, the count is the
 * one that is true, and the disagreement is visible instead of believed.
 */

const STATUS_TONE = { BUILT: 'ok', EXTEND: 'warn', NEW: 'info' };

/** The roadmap's own status wording, tone-mapped without rewriting it. */
function phaseTone(status) {
  const text = String(status).toLowerCase();
  if (text.includes('complete')) return 'ok';
  if (text.includes('ongoing')) return 'info';
  return 'warn';
}

export async function blueprint(root) {
  const position = await api.get('/v1/admin/blueprint').catch((error) => ({ error }));

  if (position.error) {
    render(root, html`${head({ title: 'Blueprint' })}${refusal('The blueprint', position.error)}`);
    return;
  }

  render(
    root,
    html`
      ${head({ title: 'Blueprint', intent: position.note })}

      <section class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h2>Routes on this gateway</h2>
          <div class="metric">${position.measured.routes}</div>
          <div class="metric-sub">explicit, with no backend discovery</div>
        </div>
        <div class="card">
          <h2>Event catalogue</h2>
          <div class="metric">${position.measured.eventTypes}</div>
          <div class="metric-sub">${position.measured.eventTypesEverWritten} of them have actually been written</div>
        </div>
        <div class="card">
          <h2>Entity types</h2>
          <div class="metric">${position.measured.entityTypes}</div>
          <div class="metric-sub">each classified into a capability area — an unclassified type is unreadable</div>
        </div>
        <div class="card">
          <h2>Agents registered</h2>
          <div class="metric">${position.measured.agents}</div>
          <div class="metric-sub">${position.measured.eventsWritten.toLocaleString('en-GB')} events across ${position.measured.tenancies} tenanc${position.measured.tenancies === 1 ? 'y' : 'ies'}</div>
        </div>
      </section>

      ${blueprintCharts(position)}

      ${!position.available
        ? html`<div class="notice warn" style="margin-bottom:14px">
            <div><b>${position.title}</b><br />${position.note}</div>
          </div>`
        : html`
            <div class="grid g-2-1" style="margin-bottom:14px">
              <div class="card pad0">
                <h2 style="padding:15px 17px 0">Build roadmap</h2>
                <div class="metric-sub" style="padding:0 17px 10px">
                  Read out of the document itself rather than restated here, so the roadmap on this screen is the
                  roadmap in the blueprint and cannot quietly become a second, more flattering one.
                </div>
                ${table({
                  headers: ['Phase', 'Scope', 'Status'],
                  rows: (position.roadmap ?? []).map((phase) => [
                    html`<b>${phase.phase}</b>`,
                    html`<span class="metric-sub">${phase.scope}</span>`,
                    badge(phase.status, phaseTone(phase.status)),
                  ]),
                  empty: 'No roadmap table was found in the document.',
                })}
              </div>
              <div class="card">
                <h2>Claims in the document</h2>
                <div class="split-list">
                  <div class="row"><span class="lbl">Marked built</span><span class="val">${badge(String(position.claims.built), 'ok')}</span></div>
                  <div class="row"><span class="lbl">Marked to extend</span><span class="val">${badge(String(position.claims.extend), 'warn')}</span></div>
                  <div class="row"><span class="lbl">Marked not yet built</span><span class="val">${badge(String(position.claims.planned), 'info')}</span></div>
                </div>
                <div class="metric-sub" style="margin-top:12px">
                  A count of markers, which is a measure of how much the document claims rather than of how much exists.
                  The tiles above are the second half of that sentence: they are counted from this process.
                </div>
              </div>
            </div>

            <div class="card pad0">
              <h2 style="padding:15px 17px 0">${position.title}</h2>
              <div class="metric-sub" style="padding:0 17px 10px">
                ${position.sections.length} sections. The status is the one the document carries on its own heading;
                where a section has none, the document makes no claim about it either way.
              </div>
              ${table({
                headers: ['', 'Section', 'What the document claims'],
                rows: position.sections.map((section) => [
                  section.number,
                  section.title,
                  section.status ? badge(section.status.toLowerCase(), STATUS_TONE[section.status] ?? 'neutral') : html`<span class="metric-sub">no claim</span>`,
                ]),
              })}
            </div>
          `}
    `,
  );
}

/**
 * The blueprint against the build.
 *
 * The blueprint is a document and the four tiles are measurements of a running
 * process. The only useful thing to draw is where the two meet: how much of the
 * event catalogue has ever actually been written, and how much of the specified
 * scope is still marked new or as an extension.
 *
 * A closed catalogue with types nobody has written is not a defect — some
 * events belong to workflows this deployment has not run. It is a fact about
 * coverage, and it is the fact a reader of a blueprint wants.
 */
function blueprintCharts(position) {
  const measured = position?.measured ?? {};
  const sections = position?.sections ?? [];

  const catalogue = [
    { label: 'Event types declared', value: Number(measured.eventTypes ?? 0) },
    { label: 'Ever written', value: Number(measured.eventTypesEverWritten ?? 0) },
  ].filter((stage) => stage.value > 0);

  const status = [
    { label: 'Specified and built', value: sections.filter((section) => !section.status).length },
    { label: 'New in this revision', value: sections.filter((section) => section.status === 'NEW').length, tone: 'warn' },
    { label: 'Extended', value: sections.filter((section) => section.status === 'EXTEND').length },
  ].filter((slice) => slice.value > 0);

  const surface = [
    { label: 'Routes', value: Number(measured.routes ?? 0) },
    { label: 'Event types', value: Number(measured.eventTypes ?? 0) },
    { label: 'Entity types', value: Number(measured.entityTypes ?? 0) },
    { label: 'Agents', value: Number(measured.agents ?? 0) },
  ].filter((row) => row.value > 0);

  if (catalogue.length === 0 && status.length === 0 && surface.length === 0) return '';

  return html`
    <div class="grid g2" style="margin-bottom:14px">
      <div class="card">
        <h2>How much of the catalogue has actually been used</h2>
        ${raw(
          funnelChart({
            title: 'Event types declared against written',
            stages: catalogue,
            format: (value) => `${value} type${value === 1 ? '' : 's'}`,
            empty: 'No event catalogue is published.',
            footnote:
              'The catalogue is closed, so the gap is coverage rather than a defect — some events belong to workflows ' +
              'this deployment has not run. It is the figure a blueprint reader is actually asking for.',
          }),
        )}
      </div>
      <div class="card">
        <h2>What the blueprint still calls new</h2>
        ${raw(
          pieChart({
            title: 'Sections by standing',
            data: status,
            centreLabel: String(sections.length),
            format: (value) => `${value} section${value === 1 ? '' : 's'}`,
            empty: position?.available ? 'The blueprint publishes no sections.' : 'No blueprint is carried on this deployment.',
            footnote: 'The document’s own marks, not an assessment of the code. The tiles above are the running process.',
          }),
        )}
      </div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <h2>The size of the surface this process actually carries</h2>
      ${raw(
        barChart({
          title: 'Declared surface, measured live',
          horizontal: true,
          data: surface,
          format: (value) => String(value),
          empty: 'Nothing could be measured from this process.',
          footnote:
            `${Number(measured.eventsWritten ?? 0).toLocaleString('en-GB')} events across ${measured.tenancies ?? 0} tenanc${(measured.tenancies ?? 0) === 1 ? 'y' : 'ies'}. ` +
            'Every figure is counted from the running gateway rather than read off the document.',
        }),
      )}
    </div>
  `;
}
