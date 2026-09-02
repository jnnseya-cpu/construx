import { api, entityBundle } from '../lib/api.js';
import { command, commandBar, confirmCost } from '../lib/command.js';
import { OBSERVATION_TYPE, RISK_CATEGORY } from '../lib/enums.js';
import { badge, date, days, drillable, html, humanise, money, pct, raw, render, statusTone, table, toast, track } from '../lib/ui.js';
import { insightPanel } from '../lib/insight.js';
import { barChart } from '../lib/charts.js';
import { blockedReason, can, draw, state } from '../app.js';

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

  // The records behind each figure, so a number opens to what moved it.
  const riskSources = openRisks.map((r) => ({ refType: 'RiskRegisterItem', refId: r._refId }));
  const safetySources = [
    ...(forecast ? [{ refType: 'SafetyForecast', refId: forecast._refId }] : []),
    ...b.Incident.map((i) => ({ refType: 'Incident', refId: i._refId })),
    ...b.SafetyObservation.map((o) => ({ refType: 'SafetyObservation', refId: o._refId })),
  ];
  const ramsSources = approvedRams.map((r) => ({ refType: 'RAMS', refId: r._refId }));

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
        <div class="actions cmd-bar">
          ${raw(commandBar([
            { id: 'risk', label: 'Register risk', tone: '', permitted: can('RISK_REGISTER', 'C'), reason: blockedReason('RISK_REGISTER', 'C') },
            { id: 'observation', label: 'Log observation', permitted: can('SAFETY_RAMS', 'C'), reason: blockedReason('SAFETY_RAMS', 'C') },
            { id: 'rescore', label: 'Rescore a risk', permitted: can('RISK_REGISTER', 'U'), reason: blockedReason('RISK_REGISTER', 'U') },
          ]))}
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
        <div ${raw(drillable('Expected risk cost', riskSources))}>
          <h2>Expected risk cost</h2>
          <div class="metric warn">${contingency ? money(contingency.expectedMinor) : '—'}</div>
          <div class="metric-sub">probability-weighted across ${openRisks.length} open risks</div>
        </div>
        <div ${raw(drillable('P80 contingency', riskSources))}>
          <h2>P80 contingency</h2>
          <div class="metric orange">${contingency ? money(contingency.p80Minor) : '—'}</div>
          <div class="metric-sub">the figure to hold, not the average</div>
        </div>
        <div ${raw(drillable('Safety risk index', safetySources))}>
          <h2>Safety risk index</h2>
          <div class="metric ${raw(!forecast ? '' : forecast.severity === 'LOW' ? 'good' : forecast.severity === 'CRITICAL' ? 'bad' : 'warn')}">
            ${forecast ? forecast.riskIndex : '—'}
          </div>
          <div class="metric-sub">${forecast ? `${forecast.expectedIncidents30d} expected recordables in 30 days` : 'not forecast'}</div>
        </div>
        <div ${raw(drillable('RAMS briefed', ramsSources))}>
          <h2>RAMS briefed</h2>
          <div class="metric ${raw(approvedRams.length > 0 && acknowledged.length === approvedRams.length ? 'good' : 'warn')}">
            ${acknowledged.length}<span style="font-size:16px;color:var(--text-3)"> / ${approvedRams.length}</span>
          </div>
          <div class="metric-sub">work must not start before acknowledgement</div>
        </div>
      </div>

      ${
        contingency
          ? html`<div class="card" style="margin-bottom:14px">
              <h2>What the contingency is being asked to cover</h2>
              <p class="muted">
                The three figures are not alternatives. The expected cost is what the risks are worth on average,
                the P80 is the figure to hold, and the worst case is what happens if every open risk lands. The
                gap between the second and the third is the part nobody has priced.
              </p>
              ${barChart({
                title: 'Contingency positions',
                data: [
                  { label: 'Expected', value: contingency.expectedMinor / 100 },
                  { label: 'P80', value: contingency.p80Minor / 100 },
                  { label: 'Worst case', value: contingency.worstCaseMinor / 100 },
                ],
                format: (value) => money(Math.round(value * 100)),
              })}
              ${
                (contingency.topDrivers ?? []).length > 0
                  ? barChart({
                      title: 'What drives it, by expected cost',
                      horizontal: true,
                      data: contingency.topDrivers.map((driver) => ({
                        label: driver.title,
                        value: driver.expectedCostMinor / 100,
                      })),
                      format: (value) => money(Math.round(value * 100)),
                    })
                  : ''
              }
            </div>`
          : ''
      }

      <div id="risk-insight" style="margin-bottom:14px"></div>

      <div class="grid g-2-1" style="margin-bottom:14px">
        <div class="card pad0">
          <h2 style="padding:15px 17px 0">Risk register</h2>
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
            <h2>Contingency drivers</h2>
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
            <h2>Mitigation worth funding</h2>
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
              <h2>What is driving the safety forecast</h2>
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
          <h2 style="padding:15px 17px 0">Method statements</h2>
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
          <h2 style="padding:15px 17px 0">Safety observations</h2>
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
    const path = `/v1/projects/${state.session.projectId}/safety/forecast`;

    const accepted = await confirmCost({
      title: 'Run safety forecast',
      intent: 'Interprets the safety leading indicators and prioritises the recommended controls.',
      path,
      runLabel: 'Run forecast',
    });
    if (!accepted) return;

    button.disabled = true;
    button.textContent = 'Running…';
    try {
      const result = await api.post(path, {
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

  const COMMANDS = {
    risk: {
      title: 'Register risk',
      intent: 'Three-point impact in money and days. The platform computes expected value and the P80 contingency — neither is entered.',
      path: `/v1/projects/${projectId}/risk`,
      submitLabel: 'Register',
      fields: [
        { name: 'title', label: 'Risk', type: 'text', placeholder: 'What could happen, stated as an event' },
        { name: 'category', label: 'Category', type: 'select', options: RISK_CATEGORY },
        { name: 'probability', label: 'Probability', type: 'number', step: '0.05', min: 0, hint: 'Between 0 and 1' },
        { name: 'costOptimistic', label: 'Cost impact — best case', type: 'number', money: true, hint: 'In pounds' },
        { name: 'costMostLikely', label: 'Cost impact — most likely', type: 'number', money: true },
        { name: 'costPessimistic', label: 'Cost impact — worst case', type: 'number', money: true },
        { name: 'daysOptimistic', label: 'Delay — best case (days)', type: 'number' },
        { name: 'daysMostLikely', label: 'Delay — most likely (days)', type: 'number' },
        { name: 'daysPessimistic', label: 'Delay — worst case (days)', type: 'number' },
      ],
      transform: (v) => ({
        id: '',
        title: v.title,
        category: v.category,
        probability: v.probability,
        costImpact: { optimistic: v.costOptimistic, mostLikely: v.costMostLikely, pessimistic: v.costPessimistic },
        scheduleImpactDays: { optimistic: v.daysOptimistic, mostLikely: v.daysMostLikely, pessimistic: v.daysPessimistic },
        projectValueMinor: Number(state.project?.contractValueMinor ?? 0),
        projectDurationDays: 400,
      }),
    },
    rescore: {
      title: 'Rescore a risk',
      intent:
        'The P80 contingency in every tender and cost report is computed from these scores. A register frozen at the day it was written prices the job against risks as they were understood before anybody had been on site.',
      path: (collected) => `/v1/projects/${projectId}/risk/${collected.riskId}/rescore`,
      transform: ({ riskId, costOptimistic, costMostLikely, costPessimistic, daysOptimistic, daysMostLikely, daysPessimistic, ...rest }) => ({
        ...rest,
        costImpact: { optimistic: costOptimistic, mostLikely: costMostLikely, pessimistic: costPessimistic },
        scheduleImpactDays: { optimistic: daysOptimistic, mostLikely: daysMostLikely, pessimistic: daysPessimistic },
        projectValueMinor: Number(state.project?.contractValueMinor ?? 0),
        projectDurationDays: 400,
      }),
      submitLabel: 'Rescore',
      fields: [
        { name: 'riskId', label: 'Risk', type: 'select',
          options: openRisks.map((r) => ({ value: r._refId, label: `${r.title} · ${pct((r.probability ?? 0) * 100, 0)}` })) },
        { name: 'probability', label: 'Probability', type: 'number', step: '0.05', min: 0, hint: 'Between 0 and 1' },
        { name: 'costOptimistic', label: 'Cost impact — best case', type: 'number', money: true },
        { name: 'costMostLikely', label: 'Cost impact — most likely', type: 'number', money: true },
        { name: 'costPessimistic', label: 'Cost impact — worst case', type: 'number', money: true },
        { name: 'daysOptimistic', label: 'Delay — best case (days)', type: 'number' },
        { name: 'daysMostLikely', label: 'Delay — most likely (days)', type: 'number' },
        { name: 'daysPessimistic', label: 'Delay — worst case (days)', type: 'number' },
        { name: 'reason', label: 'What changed', type: 'textarea',
          hint: 'A score that moves without a reason is an opinion. This is the answer to "why did the exposure halve the month before the tender went in".' },
      ],
    },
    observation: {
      title: 'Log safety observation',
      intent: 'Severity is assessed against the hazard library, not chosen by the reporter.',
      path: `/v1/projects/${projectId}/safety/observations`,
      aiCost: true,
      submitLabel: 'Log',
      fields: [
        { name: 'observationType', label: 'Type', type: 'select', options: OBSERVATION_TYPE },
        { name: 'location', label: 'Location', type: 'text' },
        { name: 'description', label: 'What was observed', type: 'textarea' },
        { name: 'reportedBy', label: 'Reported by', type: 'text', value: state.session.user.name },
        { name: 'mediaHash', label: 'Photograph', type: 'file' },
      ],
    },
  };

  void insightPanel(root.querySelector('#risk-insight'), {
    projectId,
    areas: ['RISK_REGISTER', 'SAFETY_RAMS'],
    subject: 'risk and safety',
    onChange: draw,
  });

  root.querySelector('.cmd-bar')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    const spec = COMMANDS[button.dataset.command];
    if (!spec) return;
    if (await command(spec)) await draw();
  });

}
