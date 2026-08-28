import { api } from '../lib/api.js';
import { head, refusal } from '../lib/estate.js';
import { badge, html, render, table } from '../lib/ui.js';

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
