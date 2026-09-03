import { api } from './api.js';
import { date, html, humanise, resolveHtml, time } from './ui.js';

/**
 * Every KPI drills to its source events.
 *
 * The Build Standard's sixth test is that a screen says what is happening, what
 * changed, what is at risk, what is costing money and what needs action today.
 * A number on a card answers the first three at best, and only if the reader
 * already trusts it. **A figure nobody can open is a figure nobody can check**,
 * and on a commercial screen that is the difference between a report and an
 * assertion.
 *
 * The platform has had the answer since the ledger was built and there has been
 * no way to ask it from a tile. This is the way.
 *
 * ---
 *
 * **A tile names the records it was computed from, not a query.** The two are
 * different in the way that matters: a query is a second description of the
 * calculation, and the day somebody changes the sum without changing the query
 * the drill starts lying. The refs are the same array the tile added up.
 *
 * **Content the reader may not see is withheld and said to be withheld.** The
 * events route already applies the entity classification per event and marks
 * what it held back, which is the same decision the audit feed makes. A drill
 * that silently omitted those rows would be a way round the capability model;
 * one that shows the envelope and withholds the content is the audit trail
 * working as designed.
 *
 * **A figure with no sources is not given a drill.** Some numbers are a count of
 * nothing, a configured constant or an estimate with no record behind it, and
 * dressing one in an affordance that opens an empty panel is worse than leaving
 * it plain. `metric()` renders those exactly as it always did.
 */

/** `[{refType, refId}]` → the query the events route takes. */
export function refsParam(sources) {
  return (sources ?? [])
    .filter((source) => source && source.refType && source.refId)
    .map((source) => `${source.refType}:${source.refId}`)
    .join(',');
}

/**
 * What changed on an event, in a line.
 *
 * The diff is a JSON Patch array. Rendering it raw would be a wall of pointers;
 * naming the fields is what a person actually wants, and the full record is one
 * click further on in the audit trail.
 */
function changed(event) {
  if (event.contentWithheld) return 'content withheld from your role';
  const diff = event.diff;
  if (!Array.isArray(diff) || diff.length === 0) return '';
  const fields = [...new Set(diff.map((op) => String(op.path ?? '').split('/')[1]).filter(Boolean))];
  if (fields.length === 0) return `${diff.length} change${diff.length === 1 ? '' : 's'}`;
  return fields.slice(0, 4).map(humanise).join(', ') + (fields.length > 4 ? ` and ${fields.length - 4} more` : '');
}

/**
 * Open the drill for one figure.
 *
 * @param projectId the project the figure belongs to
 * @param label what the number was, shown as the panel's subject
 * @param sources `[{refType, refId}]` — the records the figure was computed from
 */
export async function drill(projectId, label, sources, absence = []) {
  const refs = refsParam(sources);
  // An absence has no records to open, so a drill that had only records to show
  // used to refuse outright — or worse, open somebody else's history. With the
  // search stated it has something true to say either way.
  if (!refs && absence.length === 0) return;

  const host = document.createElement('div');
  host.className = 'modal-host';
  host.innerHTML = resolveHtml(html`<div class="modal">
    <header>
      <div>
        <h3>${label}</h3>
        <div class="metric-sub">Reading the record…</div>
      </div>
      <button data-close aria-label="Close">×</button>
    </header>
    <div class="body"><div class="empty"><b>Loading</b>The events behind this figure.</div></div>
  </div>`);

  const close = () => host.remove();
  host.addEventListener('click', (event) => {
    if (event.target === host || event.target.closest('[data-close]')) close();
  });
  document.addEventListener('keydown', function escape(event) {
    if (event.key !== 'Escape') return;
    document.removeEventListener('keydown', escape);
    close();
  });
  document.body.append(host);

  // What was looked for and not found, above the records that do exist. It is
  // the half of the finding a reader came to check: "no lookahead has ever been
  // published" is not evidenced by the project's phase history, and showing
  // that alone reads as padding.
  const searched =
    absence.length === 0
      ? ''
      : resolveHtml(html`<div class="notice info" style="margin-bottom:12px">
          ${absence.map(
            (item) => html`<div>
              <b>${humanise(item.refType)}</b> — searched ${item.looked}:
              ${item.found === 0
                ? 'nothing on this project.'
                : html`${item.found} record${item.found === 1 ? '' : 's'} exist, none of which qualifies.`}
            </div>`,
          )}
          <div class="metric-sub" style="margin-top:6px">
            This is the finding. There is no record to open, because the point is that there is none.
          </div>
        </div>`);

  if (!refs) {
    host.querySelector('.body').innerHTML = searched;
    host.querySelector('header .metric-sub').textContent = 'Read from a register that is empty';
    return;
  }

  let payload;
  try {
    payload = await api.get(`/v1/projects/${projectId}/audit/events?refs=${encodeURIComponent(refs)}`);
  } catch (error) {
    host.querySelector('.body').innerHTML = resolveHtml(
      html`<div class="notice err">${error.detail ?? error.message ?? 'The record could not be read.'}</div>`,
    );
    return;
  }

  // Newest first: the question behind opening a figure is almost always "what
  // moved it", and that is the most recent event, not the oldest.
  const events = [...(payload.events ?? [])].reverse();
  const count = sources.length;
  const withheld = payload.withheldCount ?? 0;

  host.querySelector('header .metric-sub').textContent =
    `${events.length} event${events.length === 1 ? '' : 's'} across ${count} record${count === 1 ? '' : 's'}` +
    (withheld > 0 ? ` · ${withheld} with content withheld from your role` : '');

  host.querySelector('.body').innerHTML = searched + resolveHtml(
    events.length === 0
      ? html`<div class="empty">
          <b>No events yet</b>
          ${count} record${count === 1 ? ' is' : 's are'} named as the source of this figure and
          ${count === 1 ? 'it carries' : 'they carry'} no event on this project. The figure is derived from
          state rather than from anything that has happened.
        </div>`
      : html`<div class="split-list">
          ${events.map(
            (event) => html`<div class="row">
              <span class="lbl">
                <b>${humanise(event.eventType)}</b><br>
                <span class="metric-sub">
                  ${event.entity.refType} · ${date(event.timestamp)} ${time(event.timestamp)}
                  ${event.roleAtAction?.length ? html` · ${event.roleAtAction.join(', ')}` : ''}
                  ${event.ai ? html` · AI: ${event.ai.provider}` : ''}
                </span>
              </span>
              <span class="val"><span class="metric-sub">${changed(event)}</span></span>
            </div>`,
          )}
        </div>
        <div class="metric-sub" style="margin-top:11px">
          Ordered newest first. The full record, including the hash chain and what each event was built on,
          is on the audit trail.
        </div>`,
  );
}

/**
 * Wire the drill once, for the whole application.
 *
 * Delegated on the document rather than bound per tile: every screen re-renders
 * its own root on every draw, and a per-tile listener would be re-attached on
 * each one — a leak that gets worse the longer somebody leaves a command centre
 * open. One listener, and the tile carries its sources in the markup.
 */
export function wireDrill(getProjectId) {
  document.addEventListener('click', (event) => {
    const tile = event.target.closest('[data-drill]');
    if (!tile) return;
    const projectId = getProjectId();
    if (!projectId) return;

    let sources;
    try {
      sources = JSON.parse(tile.dataset.drill);
    } catch {
      return;
    }
    if (!Array.isArray(sources) || sources.length === 0) return;
    void drill(projectId, tile.dataset.drillLabel || 'This figure', sources);
  });
}
