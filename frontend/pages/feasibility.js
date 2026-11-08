import { api } from '../lib/api.js';
import { badge, html, money, raw, render, table, toast } from '../lib/ui.js';

/**
 * Feasibility appraisal.
 *
 * The one place the platform turns a site and a one-line brief into numbers:
 * a schedule of accommodation, a land budget, an order-of-cost and an indicative
 * programme. It is the input to a development brief or an Employer's Requirements
 * — the quantitative spine a development manager used to keep in a spreadsheet
 * nobody could audit.
 *
 * Everything shown here is computed by the server's deterministic engine
 * (`/v1/feasibility/scheme`); the browser holds no scheme logic. Every figure is
 * a concept control to be replaced by measured design and QS data before tender,
 * and the page says so rather than letting a round number read as a quote.
 */

const todayName = () => `Feasibility appraisal ${new Date().toISOString().slice(0, 10)}`;

export async function feasibility(root) {
  // The dwelling archetypes (with their NDSS areas) and the default concept
  // assumptions the engine computes under — published so the mix chooser names
  // exactly what the engine accepts, and an unknown code is refused server-side.
  const ref = await api.get('/v1/feasibility/archetypes').catch(() => null);
  const archetypes = ref?.archetypes ?? [];

  // Page-local state: the inputs last entered and the last computed scheme.
  const form = { schemeName: todayName(), authority: 'Birmingham City Council', tenure: 'Social rent', siteAreaHa: 1.0, densityDph: 50, mix: '' };
  let scheme = null;
  let error = null;

  async function compute() {
    error = null;
    const siteAreaHa = Number(form.siteAreaHa);
    if (!(siteAreaHa > 0)) { error = 'Enter a site area in hectares.'; draw(); return; }
    const body = {
      schemeName: form.schemeName || todayName(),
      authority: form.authority || '',
      tenure: form.tenure || 'Social rent',
      siteAreaHa,
      suggest: { densityDph: Number(form.densityDph) || 50 },
    };
    const mix = parseMix(form.mix);
    if (mix.length > 0) body.mix = mix;
    try {
      scheme = await api.post('/v1/feasibility/scheme', body);
    } catch (e) {
      error = e.message || 'The feasibility scheme could not be computed.';
      scheme = null;
    }
    draw();
  }

  function parseMix(text) {
    // `code: count` per line (e.g. "3b5p-house: 14"). Empty means "suggest a mix".
    return String(text ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [code, count] = line.split(':').map((p) => p.trim());
        return { code, count: Number(count) };
      })
      .filter((e) => e.code && Number.isFinite(e.count) && e.count > 0);
  }

  function requestBody(format) {
    const body = {
      schemeName: form.schemeName || todayName(),
      authority: form.authority || '',
      tenure: form.tenure || 'Social rent',
      siteAreaHa: Number(form.siteAreaHa),
      suggest: { densityDph: Number(form.densityDph) || 50 },
    };
    const mix = parseMix(form.mix);
    if (mix.length > 0) body.mix = mix;
    if (format) body.format = format;
    return body;
  }

  async function downloadBrief() {
    if (!(Number(form.siteAreaHa) > 0)) { error = 'Enter a site area in hectares.'; draw(); return; }
    try {
      // A branded DOCX of the whole brief — schedule, land budget, cost plan,
      // programme and narrative. The narrative is AI-enhanced where a reasoning
      // provider answers and deterministic prose otherwise.
      await api.download('/v1/feasibility/brief.docx', requestBody('DOCX'));
    } catch (e) {
      error = e.message || 'The brief document could not be generated.';
      draw();
    }
  }

  function bind() {
    for (const el of root.querySelectorAll('[data-field]')) {
      el.addEventListener('input', (ev) => { form[ev.target.dataset.field] = ev.target.value; });
    }
    root.querySelector('[data-compute]')?.addEventListener('click', () => compute());
    root.querySelector('[data-download]')?.addEventListener('click', () => downloadBrief());
  }

  function draw() {
    render(root, view());
    bind();
  }

  function view() {
    return html`<div class="view">
      <div class="view-head">
        <div>
          <h1>Feasibility appraisal</h1>
          <p class="hint">
            A site and a brief become a schedule of accommodation, a land budget, an order-of-cost and an indicative
            programme. Every figure is a concept control to be replaced by measured design and QS data before tender.
          </p>
        </div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <h2>The brief</h2>
        <div class="grid g3" style="gap:12px;margin-top:8px">
          ${field('Scheme name', 'schemeName', form.schemeName, 'text')}
          ${field('Planning authority', 'authority', form.authority, 'text')}
          ${field('Tenure', 'tenure', form.tenure, 'text')}
          ${field('Site area (hectares)', 'siteAreaHa', form.siteAreaHa, 'number')}
          ${field('Target density (homes/ha)', 'densityDph', form.densityDph, 'number')}
        </div>
        <div style="margin-top:10px">
          <label class="field">
            <span>Dwelling mix <span style="color:var(--text-3)">— one <code>code: count</code> per line; leave blank to suggest from the density</span></span>
            <textarea data-field="mix" rows="5" placeholder="3b5p-house: 14&#10;2b4p-house: 10&#10;1b2p-flat: 12&#10;2b4p-flat: 10&#10;3b5p-flat: 4">${form.mix}</textarea>
          </label>
          <div style="font-size:11.5px;color:var(--text-3);margin-top:4px">
            Codes: ${raw(archetypes.map((a) => `<code>${a.code}</code> (${a.label})`).join(' · '))}
          </div>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" data-compute>Compute the scheme</button>
          <button class="btn quiet" data-download>Download brief (DOCX)</button>
        </div>
        <div style="font-size:11.5px;color:var(--text-3);margin-top:6px">The downloadable brief adds narrative prose — AI-written where a reasoning provider is configured, deterministic otherwise.</div>
        ${error ? html`<div class="notice bad" style="margin-top:10px">${error}</div>` : ''}
      </div>

      ${scheme ? result(scheme) : html`<div class="card"><p class="hint">Enter a brief and compute to see the schedule, land budget, cost plan and programme.</p></div>`}
    </div>`;
  }

  draw();
}

function field(label, key, value, type) {
  return html`<label class="field">
    <span>${label}</span>
    <input data-field="${key}" type="${type}" value="${value}" ${type === 'number' ? raw('step="any"') : ''} />
  </label>`;
}

function result(s) {
  const t = s.totals;
  const metric = (n, k, tone = '') => html`<div class="card"><h2>${k}</h2><div class="metric ${tone}">${n}</div></div>`;
  return html`
    <div class="card pad0" style="margin-bottom:14px">
      <h2 style="padding:15px 17px 0">${s.schemeName} · ${s.authority}</h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
        ${t.homes} homes on ${(s.siteAreaM2).toLocaleString('en-GB')} m² (${t.densityDph} homes/ha), ${s.tenure}.
      </p>
      <div class="grid g4" style="padding:13px 17px 15px">
        ${metric(t.homes, 'Homes')}
        ${metric(`${t.familyHomePercent}%`, 'Family homes (3+ bed)')}
        ${metric(money(s.costPlan.forecastOutturnMinor), 'Forecast outturn')}
        ${metric(`${s.programme.totalMonths} mo`, 'To completion')}
      </div>
    </div>

    <div class="card pad0" style="margin-bottom:14px">
      <h2 style="padding:15px 17px 0">Schedule of accommodation</h2>
      ${table({
        headers: ['Type', 'No.', 'Bedspaces', 'NDSS m²', 'Design m²', 'Total GIA'],
        align: ['', 'num', 'num', 'num', 'num', 'num'],
        rows: s.schedule.map((l) => [
          l.label, String(l.count), String(l.bedspacesEach), `${l.ndssMinM2}`, `${l.designM2}`, `${l.totalDesignM2.toLocaleString('en-GB')} m²`,
        ]).concat([[
          raw('<b>Total</b>'), raw(`<b>${t.homes}</b>`), raw(`<b>${t.bedspaces}</b>`), '', '',
          raw(`<b>${t.netDwellingGiaM2.toLocaleString('en-GB')} m² net</b>`),
        ]]),
      })}
      <p style="padding:4px 17px 12px;font-size:12px;color:var(--text-3)">
        Costed building GIA ${t.costedBuildingGiaM2.toLocaleString('en-GB')} m² (adds ${s.assumptions.flatCommonPercent}% flat common area).
        Accessibility: ${s.accessibility.m4_2} × M4(2) (${s.accessibility.m4_2Percent}%) ${raw(badge(s.accessibility.meetsPolicy ? 'meets 30%' : 'below policy', s.accessibility.meetsPolicy ? 'ok' : 'bad'))}, ${s.accessibility.m4_3} × M4(3).
        Parking ${s.parking.totalSpaces} spaces, ${s.parking.cycleSpaces} cycle.
      </p>
    </div>

    <div class="card pad0" style="margin-bottom:14px">
      <h2 style="padding:15px 17px 0">Land budget</h2>
      ${table({
        headers: ['Land use', 'Area', 'Note'],
        align: ['', 'num', ''],
        rows: s.landBudget.uses.map((u) => [
          u.use, `${u.areaM2.toLocaleString('en-GB')} m²`, html`<span style="font-size:12px;color:var(--text-3)">${u.note}</span>`,
        ]),
      })}
      ${s.landBudget.overSite ? html`<div class="notice bad" style="margin:0 17px 12px">The mix exceeds the site — reduce the density or the unit count.</div>` : ''}
    </div>

    <div class="card pad0" style="margin-bottom:14px">
      <h2 style="padding:15px 17px 0">Order-of-cost plan</h2>
      <p style="padding:4px 17px 0;font-size:12px;color:var(--text-3)">${s.assumptions.baseDate} concept allowances — £${s.assumptions.houseRatePerM2}/m² houses, £${s.assumptions.flatRatePerM2}/m² flats. Replace with QS package data at Stage 2.</p>
      ${table({
        headers: ['Item', 'Basis', '£'],
        align: ['', '', 'num'],
        rows: s.costPlan.lines.map((l) => {
          const emphatic = ['Direct works', 'Base construction cost', 'Base total including risk', 'Forecast outturn'].includes(l.item);
          return [
            emphatic ? raw(`<b>${l.item}</b>`) : l.item,
            html`<span style="font-size:12px;color:var(--text-3)">${l.basis}</span>`,
            emphatic ? raw(`<b>${money(l.amountMinor)}</b>`) : money(l.amountMinor),
          ];
        }),
      })}
      <p style="padding:4px 17px 12px;font-size:12px;color:var(--text-3)">
        ≈ ${money(s.costPlan.perHomeMinor)}/home outturn; ${money(s.costPlan.perM2Minor)}/m² base construction.
      </p>
    </div>

    <div class="card pad0" style="margin-bottom:14px">
      <h2 style="padding:15px 17px 0">Indicative programme</h2>
      ${table({
        headers: ['RIBA stage', 'Work', 'Months', 'Cumulative'],
        align: ['', '', 'num', 'num'],
        rows: s.programme.stages.map((st) => [st.stage, st.label, String(st.months), `${st.cumulativeMonths} mo`]),
      })}
      <p style="padding:4px 17px 12px;font-size:12px;color:var(--text-3)">
        ≈ ${s.programme.totalMonths} months mobilisation to completion, ${s.programme.onSiteMonths} on site.
      </p>
    </div>

    <div class="card">
      <h2>Assumptions and limits</h2>
      <ul style="margin:6px 0 0 16px;color:var(--text-3);font-size:12.5px">
        ${s.assumptionsNarrative.map((a) => html`<li>${a}</li>`)}
        ${s.limits.map((l) => html`<li>${l}</li>`)}
      </ul>
    </div>`;
}
