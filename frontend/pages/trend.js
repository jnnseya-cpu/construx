import { api } from '../lib/api.js';
import { badge, html, render, resolveHtml, table, toast } from '../lib/ui.js';
import { can, state } from '../app.js';

/**
 * Trend Intelligence AI — read a change in demand, score whether the business can serve
 * it, and see the result. Embedded in the existing console: the observations and scored
 * opportunities are golden-thread records on the project, read back from the server. Every
 * figure here is the server's assessment, never a browser computation — the browser holds
 * no scoring rule the API does not publish.
 */

const bandTone = (b) => (b === 'AUTO' ? 'ok' : b === 'BRIEF' ? 'info' : b === 'WATCH' ? 'warn' : 'neutral');
const num = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v);

export async function trend(root) {
  const projectId = state.session.projectId;
  let opportunities = [];

  const load = async () => {
    try { opportunities = (await api.get(`/v1/projects/${projectId}/trend/opportunities`)).opportunities ?? []; }
    catch { opportunities = []; }
  };

  const ingest = async (form) => {
    // One observation per submit — a window count for a topic from a source. Batch ingestion
    // is the same route; the console keeps the form to a single, legible signal.
    const obs = {
      sourceId: form.sourceId, sourceFamily: form.sourceFamily, sourceRecordId: form.sourceRecordId,
      revision: form.revision || '1', topicId: form.topicId, metric: form.metric || 'count',
      observedAt: new Date().toISOString(), windowStart: form.windowStart, windowEnd: form.windowEnd,
      value: Number(form.value), evidenceHash: form.evidenceHash,
      ...(form.geography ? { geography: form.geography } : {}),
    };
    try {
      const r = await api.post(`/v1/projects/${projectId}/trend/observations`, { observations: [obs] });
      toast('Observation ingested', `accepted ${r.accepted} · duplicate ${r.duplicate} · conflicted ${r.conflicted}`, r.conflicted ? 'warn' : 'ok');
    } catch (error) { toast('Could not ingest', `${error.code ? `${error.code} — ` : ''}${error.message}`, 'err'); }
  };

  const score = async (form) => {
    const body = {
      topicId: form.topicId, market: form.market,
      fit: Number(form.fit), intent: Number(form.intent), timing: Number(form.timing),
      readiness: Number(form.readiness), sourceQuality: Number(form.sourceQuality), freshness: Number(form.freshness),
      ...(form.autoOptIn ? { autoOptIn: true } : {}),
    };
    try {
      const s = await api.post(`/v1/projects/${projectId}/trend/opportunities/score`, body);
      toast('Opportunity scored', `${s.topicId} (${s.market}) → ${s.band} · score ${num(s.score)} / confidence ${num(s.confidence)}`, bandTone(s.band) === 'ok' || bandTone(s.band) === 'info' ? 'ok' : 'warn');
      await load(); draw();
    } catch (error) { toast('Could not score', `${error.code ? `${error.code} — ` : ''}${error.message}`, 'warn'); }
  };

  function draw() {
    const canWrite = can('BUSINESS_DEVELOPMENT', 'C');
    const parts = [];

    parts.push(html`<div class="card pad">
      <h1 style="margin:0 0 4px">Trend Intelligence</h1>
      <p class="muted" style="margin:0">Read a change in what your market is searching for or buying, score whether the business can serve it, and turn a strong, corroborated signal into a reviewable Growth Brief. Demand is measured from your own observations; a thin history or a vetoed topic never drives a live change.</p>
    </div>`);

    if (canWrite) {
      parts.push(html`<div class="card pad" style="margin-top:14px">
        <b>Ingest a signal</b>
        <form id="ingest-form" class="grid g-3" style="gap:10px;margin-top:10px">
          <label class="field"><span>Topic</span><input name="topicId" placeholder="simpler-team-onboarding" required></label>
          <label class="field"><span>Source id</span><input name="sourceId" placeholder="internal_search" required></label>
          <label class="field"><span>Source family</span><input name="sourceFamily" placeholder="first_party" required></label>
          <label class="field"><span>Record id</span><input name="sourceRecordId" placeholder="w-2026-45" required></label>
          <label class="field"><span>Revision</span><input name="revision" placeholder="1"></label>
          <label class="field"><span>Evidence hash</span><input name="evidenceHash" placeholder="sha256…" required></label>
          <label class="field"><span>Window start</span><input name="windowStart" placeholder="2026-11-03" required></label>
          <label class="field"><span>Window end</span><input name="windowEnd" placeholder="2026-11-10" required></label>
          <label class="field"><span>Count / value</span><input name="value" type="number" step="any" placeholder="24" required></label>
          <label class="field"><span>Market (optional)</span><input name="geography" placeholder="CA"></label>
          <div style="grid-column:1/-1"><button class="btn" type="submit">Ingest observation</button></div>
        </form>
      </div>`);

      parts.push(html`<div class="card pad" style="margin-top:14px">
        <b>Score an opportunity</b>
        <p class="muted" style="margin:4px 0 0">Demand is taken from the topic's observation history. The rest is the platform/strategist assessment (0–100). Readiness of 0 vetoes any live change.</p>
        <form id="score-form" class="grid g-3" style="gap:10px;margin-top:10px">
          <label class="field"><span>Topic</span><input name="topicId" placeholder="simpler-team-onboarding" required></label>
          <label class="field"><span>Market</span><input name="market" placeholder="CA" required></label>
          <label class="field"><span>Fit</span><input name="fit" type="number" min="0" max="100" value="95" required></label>
          <label class="field"><span>Intent</span><input name="intent" type="number" min="0" max="100" value="85" required></label>
          <label class="field"><span>Timing</span><input name="timing" type="number" min="0" max="100" value="90" required></label>
          <label class="field"><span>Readiness</span><input name="readiness" type="number" min="0" max="100" value="80" required></label>
          <label class="field"><span>Source quality</span><input name="sourceQuality" type="number" min="0" max="100" value="90" required></label>
          <label class="field"><span>Freshness</span><input name="freshness" type="number" min="0" max="100" value="90" required></label>
          <label class="field" style="flex-direction:row;align-items:center;gap:6px"><input name="autoOptIn" type="checkbox"><span>Opt in to bounded auto-action</span></label>
          <div style="grid-column:1/-1"><button class="btn" type="submit">Score</button></div>
        </form>
      </div>`);
    }

    parts.push(html`<div class="card pad0" style="margin-top:14px">
      <div style="padding:12px 16px 0"><b>Scored opportunities</b></div>
      ${table({
        headers: ['Topic', 'Market', 'Band', 'Score', 'Confidence', 'Demand', 'History', 'Vetoes'],
        rows: opportunities.map((o) => [
          o.topicId,
          o.market,
          resolveHtml(badge(o.band, bandTone(o.band))),
          num(o.score),
          num(o.confidence),
          num(o.demand),
          `${o.comparablePeriods} prior${o.sufficientHistory ? '' : ' · thin'}${o.clearedCountGate ? '' : ' · gate not met'}`,
          o.vetoes.length ? o.vetoes.join(', ') : '—',
        ]),
        empty: 'No opportunities scored yet. Ingest signals for a topic, then score it.',
      })}
    </div>`);

    render(root, html`${parts}`);

    const ingf = root.querySelector('#ingest-form');
    if (ingf) ingf.addEventListener('submit', (ev) => { ev.preventDefault(); ingest(Object.fromEntries(new FormData(ingf).entries())); });
    const scf = root.querySelector('#score-form');
    if (scf) scf.addEventListener('submit', (ev) => { ev.preventDefault(); score(Object.fromEntries(new FormData(scf).entries())); });
  }

  await load();
  draw();
}
