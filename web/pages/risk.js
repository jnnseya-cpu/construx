import { api, entityBundle } from '../lib/api.js';
import { badge, date, days, html, humanise, money, pct, raw, render, statusTone, table, toast, track } from '../lib/ui.js';
import { can, state } from '../app.js';

/**
 * Risk & Safety.
 *
 * Risk is quantified in money and days so contingency can be defended line by
 * line, and safety is predicted from leading indicators so controls land before
 * an incident rather than after one.
 */

export async function risk(root) {
  const projectId = state.session.projectId;

  const [b, contingency] = await Promise.all([
    entityBundle(projectId, ['RiskRegisterItem', 'SafetyForecast', 'RAMS', 'SafetyObservation', 'Competency', 'Incident']),
    api.get(`/v1/projects/${projectId}/risk/contingency`).catch(() => null),
  ]);

  const forecast = b.SafetyForecast.at(-1);
  const openRisks = b.RiskRegisterItem.filter((r) => r.status === 'OPEN');
  const worthMitigating = openRisks.filter((r) => r.residual?.recommended);
  const approvedRams = b.RAMS.filter((r) => r.status === 'APPROVED');
  const acknowledged = approvedRams.filter((r) => (r.acknowledgements ?? []).length > 0);

  const today = new Date().toISOString();
  const expiring = b.Competency.filter((c) => String(c.expiresAt ?? '') < today);

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Risk &amp; Safety</h1>
          <p>Quantified exposure and predictive safety indicators, both computed from the register and the field record rather than assessed by feel.</p>
        </div>
        <div class="actions">
          ${can('SAFETY_RAMS', 'X') ? html`<button class="btn ghost" id="forecast-safety">Run safety forecast</button>` : ''}
        </div>
      </div>

      ${
        forecast && forecast.severity !== 'LOW'
          ? html`<div class="notice ${raw(forecast.severity === 'CRITICAL' ? 'err' : 'warn')}">
              <div><b>Safety risk index ${forecast.riskIndex} — ${forecast.severity}.</b><br>
              ${(forecast.recommendedControls ?? []).join(' · ')}</div>
            </div>`
          : ''
      }

      <div class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h3>Expected risk cost</h3>
          <div class="metric warn">${contingency ? money(contingency.expectedMinor) : '—'}</div>
          <div class="metric-sub">probability-weighted across ${openRisks.length} open risks</div>
        </div>
        <div class="card">
          <h3>P80 contingency</h3>
          <div class="metric orange">${contingency ? money(contingency.p80Minor) : '—'}</div>
          <div class="metric-sub">the figure to hold, not the average</div>
        </div>
        <div class="card">
          <h3>Safety risk index</h3>
          <div class="metric ${raw(!forecast ? '' : forecast.severity === 'LOW' ? 'good' : forecast.severity === 'CRITICAL' ? 'bad' : 'warn')}">
            ${forecast ? forecast.riskIndex : '—'}
          </div>
          <div class="metric-sub">${forecast ? `${forecast.expectedIncidents30d} expected recordables in 30 days` : 'not forecast'}</div>
        </div>
        <div class="card">
          <h3>RAMS briefed</h3>
          <div class="metric ${raw(approvedRams.length > 0 && acknowledged.length === approvedRams.length ? 'good' : 'warn')}">
            ${acknowledged.length}<span style="font-size:16px;color:var(--text-3)"> / ${approvedRams.length}</span>
          </div>
          <div class="metric-sub">work must not start before acknowledgement</div>
        </div>
      </div>

      <div class="grid g-2-1" style="margin-bottom:14px">
        <div class="card pad0">
          <h3 style="padding:15px 17px 0">Risk register</h3>
          ${table({
            headers: ['Risk', 'Category', 'P', 'Expected cost', 'Days', 'Severity', 'Mitigation'],
            align: ['', '', 'num', 'num', 'num', '', ''],
            rows: openRisks.map((r) => [
              r.title,
              humanise(r.category),
              pct((r.probability ?? 0) * 100, 0),
              money(r.expectedCostMinor),
              days(r.expectedScheduleDays),
              badge(r.severity, statusTone(r.severity)),
              r.residual?.recommended
                ? badge(`worth it — net ${money(r.residual.netBenefitMinor)}`, 'ok')
                : badge('accept / monitor', 'neutral'),
            ]),
            empty: 'No open risks',
          })}
        </div>

        <div>
          <div class="card" style="margin-bottom:14px">
            <h3>Contingency drivers</h3>
            ${
              contingency
                ? html`<div class="split-list">
                    ${(contingency.topDrivers ?? []).map(
                      (d) => html`<div class="row">
                        <span class="lbl">${d.title}</span>
                        <span class="val">${money(d.expectedCostMinor)} <span style="color:var(--text-3);font-weight:400">${pct(d.share * 100, 0)}</span></span>
                      </div>`,
                    )}
                    <div class="row"><span class="lbl">Worst case</span><span class="val" style="color:var(--critical)">${money(contingency.worstCaseMinor)}</span></div>
                  </div>`
                : html`<div class="empty"><b>Not available</b></div>`
            }
          </div>

          <div class="card">
            <h3>Mitigation worth funding</h3>
            ${
              worthMitigating.length === 0
                ? html`<div class="empty"><b>None recommended</b>No mitigation currently pays for itself.</div>`
                : html`<div class="split-list">
                    ${worthMitigating.map(
                      (r) => html`<div class="row">
                        <span class="lbl">${r.title}</span>
                        <span class="val" style="color:var(--success)">+${money(r.residual.netBenefitMinor)}</span>
                      </div>`,
                    )}
                  </div>
                  <div class="metric-sub" style="margin-top:9px">Net of what the mitigation itself costs — mitigation that does not pay for itself is not recommended.</div>`
            }
          </div>
        </div>
      </div>

      ${
        forecast
          ? html`<div class="card" style="margin-bottom:14px">
              <h3>What is driving the safety forecast</h3>
              ${table({
                headers: ['Factor', 'Contribution', 'Detail'],
                align: ['', 'num', ''],
                rows: (forecast.drivers ?? []).map((d) => [d.factor, track(d.contribution * 300, d.contribution > 0.15 ? 'bad' : 'warn'), d.detail]),
              })}
            </div>`
          : ''
      }

      <div class="grid g2">
        <div class="card pad0">
          <h3 style="padding:15px 17px 0">Method statements</h3>
          ${table({
            headers: ['Activity', 'Steps', 'Status', 'Briefed'],
            align: ['', 'num', '', 'num'],
            rows: b.RAMS.map((r) => [
              r.activityDescription,
              (r.steps ?? []).length,
              badge(humanise(r.status), statusTone(r.status)),
              (r.acknowledgements ?? []).length,
            ]),
            empty: 'No RAMS drafted',
          })}
        </div>

        <div class="card pad0">
          <h3 style="padding:15px 17px 0">Safety observations</h3>
          ${table({
            headers: ['Observation', 'Type', 'Severity', 'Review'],
            rows: b.SafetyObservation.map((o) => [
              o.description,
              humanise(o.observationType),
              badge(o.severity, statusTone(o.severity)),
              o.requiresHumanReview ? badge('human review', 'warn') : badge('closed', 'ok'),
            ]),
            empty: 'No observations logged',
          })}
          ${
            b.SafetyObservation.length > 0
              ? html`<div style="padding:0 17px 15px"><div class="metric-sub">
                  AI classification is advisory. Every observation stays flagged for human review — a model does not close a safety finding.
                </div></div>`
              : ''
          }
        </div>
      </div>

      ${
        expiring.length > 0
          ? html`<div class="notice err" style="margin-top:14px">
              <div><b>${expiring.length} competency record(s) out of date.</b><br>Affected operatives should be suspended from the relevant activities until renewed.</div>
            </div>`
          : ''
      }
    `,
  );

  document.getElementById('forecast-safety')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Running…';
    try {
      const result = await api.post(`/v1/projects/${state.session.projectId}/safety/forecast`, {
        headcount: 74,
        highRiskActivitiesPlanned: 4,
        adverseWeatherDays: 6,
      });
      toast('Safety forecast complete', `Index ${result.forecast.riskIndex} (${result.forecast.severity}) · ${result.acuConsumed} ACU`, 'ok');
      await risk(root);
    } catch (error) {
      toast('Forecast failed', error.message, 'err');
      button.disabled = false;
      button.textContent = 'Run safety forecast';
    }
  });
}
