import { entityBundle } from '../lib/api.js';
import { badge, date, html, humanise, pct, raw, render, statusTone, table } from '../lib/ui.js';
import { state } from '../app.js';

/**
 * Design & BIM.
 *
 * Drawing control matters as much as the model: most projects price and build
 * from 2D long before a model is trustworthy, and someone working to a
 * superseded revision is a defect waiting to happen. Supersession is enforced
 * by the platform, not left to a filing convention.
 */

export async function design(root) {
  const projectId = state.session.projectId;

  const b = await entityBundle(projectId, [
    'Drawing',
    'DrawingMarkup',
    'Model',
    'Clash',
    'DigitalTwinState',
    'RFI',
    'DesignMaturityAssessment',
  ]);

  const current = b.Drawing.filter((d) => d.status === 'CURRENT');
  const superseded = b.Drawing.filter((d) => d.status === 'SUPERSEDED');
  const openClashes = b.Clash.filter((c) => c.status === 'OPEN');
  const criticalClashes = openClashes.filter((c) => c.severity === 'CRITICAL');
  const asBuilt = b.Model.filter((m) => m.status === 'AS_BUILT');
  const maturity = b.DesignMaturityAssessment.at(-1);
  const twin = b.DigitalTwinState.at(-1);
  const deviations = b.DigitalTwinState.reduce((sum, s) => sum + Number(s.deviationCount ?? 0), 0);

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Design &amp; BIM</h1>
          <p>Drawing control, model ingestion, clash triage by rework cost, and a twin fed by what the site actually looks like.</p>
        </div>
      </div>

      ${
        criticalClashes.length > 0
          ? html`<div class="notice warn">
              <div><b>${criticalClashes.length} critical clash(es) unresolved.</b><br>
              Severity is weighted by the cost of fixing it once built — structural and below-ground clashes triage ahead of finishes.</div>
            </div>`
          : ''
      }

      <div class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h3>Current drawings</h3>
          <div class="metric orange">${current.length}</div>
          <div class="metric-sub">${superseded.length} superseded and locked from markup</div>
        </div>
        <div class="card">
          <h3>Models ingested</h3>
          <div class="metric">${b.Model.length}</div>
          <div class="metric-sub">${asBuilt.length} as-built · ${b.Model.reduce((s, m) => s + Number(m.elementCount ?? 0), 0).toLocaleString()} elements</div>
        </div>
        <div class="card">
          <h3>Open clashes</h3>
          <div class="metric ${raw(criticalClashes.length > 0 ? 'bad' : openClashes.length > 0 ? 'warn' : 'good')}">${openClashes.length}</div>
          <div class="metric-sub">${criticalClashes.length} critical</div>
        </div>
        <div class="card">
          <h3>Site deviations</h3>
          <div class="metric ${raw(deviations > 0 ? 'warn' : 'good')}">${deviations}</div>
          <div class="metric-sub">observed against ${b.DigitalTwinState.length} capture(s)</div>
        </div>
      </div>

      <div class="grid g-2-1" style="margin-bottom:14px">
        <div class="card pad0">
          <h3 style="padding:15px 17px 0">Drawing register</h3>
          ${table({
            headers: ['Number', 'Title', 'Rev', 'Discipline', 'Status', 'Registered'],
            rows: b.Drawing.map((d) => [
              d.drawingNumber,
              d.title,
              d.revision,
              d.discipline,
              d.status === 'CURRENT' ? badge('CURRENT', 'ok') : badge('superseded', 'neutral'),
              date(d.registeredAt),
            ]),
            empty: 'No drawings registered',
          })}
        </div>

        <div>
          <div class="card" style="margin-bottom:14px">
            <h3>Design maturity</h3>
            ${
              maturity
                ? html`<div class="metric ${raw(maturity.score >= 80 ? 'good' : maturity.score >= 60 ? 'warn' : 'bad')}">${maturity.score}</div>
                    <div class="metric-sub" style="margin-bottom:12px">Supportable pricing basis: <b>${humanise(maturity.recommendedPricingBasis)}</b></div>
                    <div class="split-list">
                      ${(maturity.disciplineScores ?? []).map(
                        (d) => html`<div class="row">
                          <span class="lbl">${humanise(d.discipline)} <span style="color:var(--text-3)">RIBA ${d.ribaStage}</span></span>
                          <span class="val">${pct(d.completenessPercent, 0)} ${d.frozen ? badge('frozen', 'ok') : badge('moving', 'warn')}</span>
                        </div>`,
                      )}
                    </div>
                    ${
                      (maturity.informationGaps ?? []).length > 0
                        ? html`<div class="metric-sub" style="margin-top:10px"><b>Gaps:</b> ${maturity.informationGaps.join(' · ')}</div>`
                        : ''
                    }`
                : html`<div class="empty"><b>Not assessed</b>A package cannot go to market before this is done.</div>`
            }
          </div>

          <div class="card">
            <h3>Latest site capture</h3>
            ${
              twin
                ? html`<div class="split-list">
                    <div class="row"><span class="lbl">Zone</span><span class="val">${twin.zone}</span></div>
                    <div class="row"><span class="lbl">Source</span><span class="val">${humanise(twin.source)}</span></div>
                    <div class="row"><span class="lbl">Deviations</span><span class="val" style="color:${raw(twin.deviationCount > 0 ? 'var(--warning)' : 'var(--success)')}">${twin.deviationCount}</span></div>
                    <div class="row"><span class="lbl">Confidence</span><span class="val">${pct((twin.observationConfidence ?? 0) * 100, 0)}</span></div>
                  </div>`
                : html`<div class="empty"><b>No capture</b></div>`
            }
          </div>
        </div>
      </div>

      <div class="grid g2">
        <div class="card pad0">
          <h3 style="padding:15px 17px 0">Clash detection — triaged by rework cost</h3>
          ${table({
            headers: ['Location', 'Disciplines', 'Overlap', 'Severity', 'Status'],
            align: ['', '', 'num', '', ''],
            rows: openClashes.map((c) => [
              c.location,
              `${humanise(c.disciplineA)} / ${humanise(c.disciplineB)}`,
              `${c.overlapVolume} m³`,
              badge(c.severity, statusTone(c.severity)),
              badge(humanise(c.status), statusTone(c.status)),
            ]),
            empty: 'No open clashes',
          })}
        </div>

        <div class="card pad0">
          <h3 style="padding:15px 17px 0">RFIs raised from markups</h3>
          ${table({
            headers: ['Ref', 'Question', 'Against rev', 'Due', 'Status'],
            rows: b.RFI.map((r) => [
              r.reference,
              String(r.question).slice(0, 70) + (String(r.question).length > 70 ? '…' : ''),
              `${r.linkedDrawingRevision ?? '—'}`,
              date(r.dueDate),
              badge(humanise(r.status), statusTone(r.status)),
            ]),
            empty: 'No RFIs raised',
          })}
          ${
            b.RFI.length > 0
              ? html`<div style="padding:0 17px 15px"><div class="metric-sub">
                  Each RFI records the drawing revision it was raised against — answering the wrong revision is how RFI answers become disputes.
                </div></div>`
              : ''
          }
        </div>
      </div>
    `,
  );
}
