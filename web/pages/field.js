import { entityBundle } from '../lib/api.js';
import { badge, date, days, html, humanise, pct, raw, render, statusTone, table, time, track } from '../lib/ui.js';
import { state } from '../app.js';

/**
 * Field Execution.
 *
 * What the site actually did, and the evidence for it. Progress without
 * evidence is not accepted by the platform, so everything on this screen has a
 * hashed record behind it.
 */

export async function field(root) {
  const projectId = state.session.projectId;

  const b = await entityBundle(projectId, [
    'Task',
    'ProgressMeasurement',
    'SiteObservation',
    'QualityInspection',
    'Snag',
    'NCR',
    'CommissioningTest',
    'EvidenceItem',
    'Constraint',
  ]);

  const measured = b.Task.filter((t) => Number(t.percentComplete ?? 0) > 0);
  const complete = b.Task.filter((t) => Number(t.percentComplete ?? 0) >= 100);
  const openSnags = b.Snag.filter((s) => s.status !== 'CLOSED');
  const dispatched = b.Snag.filter((s) => s.status === 'DISPATCHED');
  const openConstraints = b.Constraint.filter((c) => c.status !== 'CLOSED');

  const coverage = b.Task.length === 0 ? 0 : (measured.length / b.Task.length) * 100;

  // Snags grouped by cost code — the routing that gets them actually fixed.
  const byTrade = new Map();
  for (const snag of openSnags) {
    const key = `${snag.costCode} · ${snag.responsibleTrade}`;
    byTrade.set(key, (byTrade.get(key) ?? 0) + 1);
  }

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Field Execution</h1>
          <p>Captured on site, offline where necessary. Device timestamps are preserved, so the time on a record is the time the work happened.</p>
        </div>
      </div>

      <div class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h3>Activities complete</h3>
          <div class="metric good">${complete.length}<span style="font-size:16px;color:var(--text-3)"> / ${b.Task.length}</span></div>
          <div class="metric-sub">${pct(coverage, 0)} of activities carry a measurement</div>
        </div>
        <div class="card">
          <h3>Progress records</h3>
          <div class="metric orange">${b.ProgressMeasurement.length}</div>
          <div class="metric-sub">each one evidenced before it was accepted</div>
        </div>
        <div class="card">
          <h3>Open snags</h3>
          <div class="metric ${raw(openSnags.length > 0 ? 'warn' : 'good')}">${openSnags.length}</div>
          <div class="metric-sub">${dispatched.length} dispatched to trade</div>
        </div>
        <div class="card">
          <h3>Evidence items</h3>
          <div class="metric">${b.EvidenceItem.length}</div>
          <div class="metric-sub">hashed and linked to the events that rely on them</div>
        </div>
      </div>

      ${
        openConstraints.length > 0
          ? html`<div class="notice warn">
              <div><b>${openConstraints.length} open constraint(s).</b><br>
              Unresolved constraints on critical activities are the cheapest delay to recover — escalation costs almost nothing.</div>
            </div>`
          : ''
      }

      <div class="grid g-2-1" style="margin-bottom:14px">
        <div class="card pad0">
          <h3 style="padding:15px 17px 0">Progress by activity</h3>
          ${table({
            headers: ['Activity', 'Planned', 'Elapsed', 'Complete', 'Slippage'],
            align: ['', 'num', 'num', '', 'num'],
            rows: b.Task.map((t) => [
              t.name,
              days(t.durationDays),
              t.elapsedDays ? days(t.elapsedDays) : '—',
              track(t.percentComplete ?? 0, Number(t.percentComplete ?? 0) >= 100 ? 'good' : ''),
              Number(t.slippageDays ?? 0) > 0 ? badge(days(t.slippageDays), 'bad') : '—',
            ]),
            empty: 'No activities',
          })}
        </div>

        <div>
          <div class="card" style="margin-bottom:14px">
            <h3>Snag dispatch by cost code</h3>
            ${
              byTrade.size === 0
                ? html`<div class="empty"><b>Nothing outstanding</b>No open snags to route.</div>`
                : html`<div class="split-list">
                    ${[...byTrade.entries()].map(
                      ([key, count]) => html`<div class="row"><span class="lbl">${key}</span><span class="val">${count}</span></div>`,
                    )}
                  </div>
                  <div class="metric-sub" style="margin-top:9px">Routing by cost code is what turns a snag list into work someone actually owns.</div>`
            }
          </div>

          <div class="card">
            <h3>Quality &amp; commissioning</h3>
            <div class="split-list">
              <div class="row"><span class="lbl">Inspections</span><span class="val">${b.QualityInspection.length}</span></div>
              <div class="row"><span class="lbl">Non-conformances</span><span class="val">${b.NCR.length}</span></div>
              <div class="row"><span class="lbl">Commissioning tests</span><span class="val">${b.CommissioningTest.length}</span></div>
              <div class="row"><span class="lbl">Accepted</span><span class="val">${b.CommissioningTest.filter((t) => t.status === 'ACCEPTED').length}</span></div>
            </div>
          </div>
        </div>
      </div>

      <div class="grid g2">
        <div class="card pad0">
          <h3 style="padding:15px 17px 0">Snag register</h3>
          ${table({
            headers: ['Ref', 'Location', 'Description', 'Trade', 'Status'],
            rows: b.Snag.map((s) => [
              s.reference,
              s.location,
              s.description,
              s.responsibleTrade,
              badge(humanise(s.status), statusTone(s.status)),
            ]),
            empty: 'No snags raised',
          })}
        </div>

        <div class="card pad0">
          <h3 style="padding:15px 17px 0">Evidence register</h3>
          ${table({
            headers: ['Type', 'Description', 'Captured', 'Hash'],
            align: ['', '', '', 'mono'],
            rows: b.EvidenceItem.slice(-12)
              .reverse()
              .map((e) => [humanise(e.type), String(e.description).slice(0, 52), time(e.capturedAt), String(e.hash).slice(7, 19) + '…']),
            empty: 'No evidence registered',
          })}
        </div>
      </div>
    `,
  );
}
