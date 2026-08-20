import { api, entityBundle } from '../lib/api.js';
import { command, commandBar, confirmCost } from '../lib/command.js';
import { today as todayIso } from '../lib/enums.js';
import { badge, date, html, humanise, money, pct, raw, render, statusTone, table, toast, track } from '../lib/ui.js';
import { blockedReason, can, draw, state } from '../app.js';

/**
 * Handover & O&M.
 *
 * The point at which most construction data dies. Here the asset register still
 * resolves back through commissioning and installation to the drawing revision
 * the asset was built to — which is what makes a defect in year twelve
 * answerable rather than argued.
 */

export async function handover(root) {
  const projectId = state.session.projectId;

  const b = await entityBundle(projectId, [
    'HandoverPack',
    'AssetRegisterItem',
    'Warranty',
    'Defect',
    'WorkOrder',
    'MaintenanceForecast',
    'CommissioningTest',
    'OMManual',
  ]);

  const pack = b.HandoverPack.at(-1);
  const forecast = b.MaintenanceForecast.at(-1);
  const openDefects = b.Defect.filter((d) => d.status !== 'CLOSED');
  const coveredDefects = openDefects.filter((d) => d.warrantyCovered);
  const openOrders = b.WorkOrder.filter((w) => w.status !== 'CLOSED');
  const accepted = b.CommissioningTest.filter((t) => t.status === 'ACCEPTED');

  const today = new Date().toISOString().slice(0, 10);
  const activeWarranties = b.Warranty.filter((w) => String(w.expiryDate ?? '') >= today);

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Handover &amp; O&amp;M</h1>
          <p>The same spine that ran the build now runs the asset — no migration, because there is nothing to migrate to.</p>
        </div>
        <div class="actions cmd-bar">
          ${raw(commandBar([
            { id: 'defect', label: 'Raise defect', tone: '', permitted: can('HANDOVER_OM', 'C'), reason: blockedReason('HANDOVER_OM', 'C') },
            { id: 'asset', label: 'Register asset', permitted: can('HANDOVER_OM', 'C'), reason: blockedReason('HANDOVER_OM', 'C') },
          ]))}
          ${can('HANDOVER_OM', 'X') ? html`<button class="btn ghost" id="maintenance">Forecast maintenance</button>` : ''}
        </div>
      </div>

      ${
        coveredDefects.length > 0
          ? html`<div class="notice info">
              <div><b>${coveredDefects.length} open defect(s) sit under an active warranty.</b><br>
              Cover is checked at the moment a defect is raised, so who pays is answered before anyone argues about it.</div>
            </div>`
          : ''
      }

      <div class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h3>Handover completeness</h3>
          <div class="metric ${raw(!pack ? '' : pack.completeness === 1 ? 'good' : 'warn')}">${pack ? pct(pack.completeness * 100, 0) : '—'}</div>
          <div class="metric-sub">${pack ? `${(pack.gaps ?? []).length} gap(s) · ${humanise(pack.status)}` : 'no pack compiled'}</div>
        </div>
        <div class="card">
          <h3>Registered assets</h3>
          <div class="metric orange">${b.AssetRegisterItem.length}</div>
          <div class="metric-sub">${activeWarranties.length} under active warranty</div>
        </div>
        <div class="card">
          <h3>Open defects</h3>
          <div class="metric ${raw(openDefects.length > 0 ? 'warn' : 'good')}">${openDefects.length}</div>
          <div class="metric-sub">${coveredDefects.length} recharged to a manufacturer</div>
        </div>
        <div class="card">
          <h3>5-year maintenance</h3>
          <div class="metric">${forecast ? money(forecast.totalForecastMinor) : '—'}</div>
          <div class="metric-sub">${forecast ? `budget pressure ${forecast.budgetPressure}` : 'not forecast'}</div>
        </div>
      </div>

      <div class="grid g-2-1" style="margin-bottom:14px">
        <div class="card pad0">
          <h3 style="padding:15px 17px 0">Asset register</h3>
          ${table({
            headers: ['Tag', 'Description', 'Manufacturer', 'Installed', 'Replacement due', 'Replacement cost'],
            align: ['', '', '', '', '', 'num'],
            rows: b.AssetRegisterItem.map((a) => [
              a.assetTag,
              a.description,
              `${a.manufacturer} ${a.modelNumber}`,
              date(a.installedAt),
              date(a.expectedReplacementDate),
              money(a.replacementCostMinor),
            ]),
            empty: 'No assets registered',
          })}
        </div>

        <div>
          <div class="card" style="margin-bottom:14px">
            <h3>Handover pack</h3>
            ${
              pack
                ? html`<div class="split-list">
                    ${(pack.checklist ?? []).map(
                      (c) => html`<div class="row">
                        <span class="st" style="color:${raw(c.present ? 'var(--success)' : 'var(--critical)')}">${c.present ? '✓' : '✗'}</span>
                        <span class="lbl">${c.label}</span>
                      </div>`,
                    )}
                  </div>
                  ${
                    pack.status === 'ACCEPTED'
                      ? html`<div style="margin-top:11px">${badge(`Accepted by ${pack.acceptedBy}`, 'ok')}</div>`
                      : html`<div style="margin-top:11px">${badge(humanise(pack.status), statusTone(pack.status))}</div>`
                  }
                  ${
                    (pack.acceptanceQualifications ?? []).length > 0
                      ? html`<div class="metric-sub" style="margin-top:9px"><b>Accepted with qualifications:</b> ${pack.acceptanceQualifications.join(' · ')}</div>`
                      : ''
                  }`
                : html`<div class="empty"><b>Not compiled</b></div>`
            }
          </div>

          <div class="card">
            <h3>Commissioning</h3>
            <div class="split-list">
              <div class="row"><span class="lbl">Tests recorded</span><span class="val">${b.CommissioningTest.length}</span></div>
              <div class="row"><span class="lbl">Accepted</span><span class="val">${accepted.length}</span></div>
              <div class="row"><span class="lbl">O&amp;M manuals</span><span class="val">${b.OMManual.length}</span></div>
            </div>
            <div class="metric-sub" style="margin-top:9px">A pass cannot be recorded while any reading sits outside tolerance.</div>
          </div>
        </div>
      </div>

      <div class="grid g2" style="margin-bottom:14px">
        <div class="card pad0">
          <h3 style="padding:15px 17px 0">Defects</h3>
          ${table({
            headers: ['Ref', 'Description', 'Severity', 'Warranty', 'Target close'],
            rows: b.Defect.map((d) => [
              d.reference,
              d.description,
              badge(d.severity, statusTone(d.severity)),
              d.warrantyCovered ? badge(`covered · ${d.warrantyProvider ?? ''}`, 'ok') : badge('not covered', 'neutral'),
              date(d.targetCloseDate),
            ]),
            empty: 'No defects raised',
          })}
        </div>

        <div class="card pad0">
          <h3 style="padding:15px 17px 0">Work orders</h3>
          ${table({
            headers: ['Ref', 'Type', 'Priority', 'Estimated', 'Actual', 'Status'],
            align: ['', '', '', 'num', 'num', ''],
            rows: b.WorkOrder.map((w) => [
              w.reference,
              humanise(w.type),
              badge(w.priority, statusTone(w.priority)),
              w.estimatedCostMinor ? money(w.estimatedCostMinor) : '—',
              w.actualCostMinor ? money(w.actualCostMinor) : '—',
              badge(humanise(w.status), statusTone(w.status)),
            ]),
            empty: 'No work orders',
          })}
        </div>
      </div>

      ${
        forecast
          ? html`<div class="card pad0">
              <h3 style="padding:15px 17px 0">Maintenance forecast — reliability-adjusted, ${forecast.horizonMonths} months</h3>
              ${table({
                headers: ['Asset', 'Action', 'Due', 'Estimated cost', 'Priority'],
                align: ['', '', '', 'num', ''],
                rows: (forecast.schedule ?? []).map((s) => [
                  s.assetTag,
                  s.action,
                  date(s.dueDate),
                  money(s.estimatedCostMinor),
                  badge(s.priority, statusTone(s.priority)),
                ]),
                empty: 'No interventions forecast in the horizon',
              })}
              <div style="padding:0 17px 15px"><div class="metric-sub">
                An asset with a history of failures reaches the end of its useful life earlier than its nominal date, so failure history pulls the replacement forward.
              </div></div>
            </div>`
          : ''
      }
    `,
  );

  document.getElementById('maintenance')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const path = `/v1/projects/${state.session.projectId}/om/maintenance-forecast`;

    const accepted = await confirmCost({
      title: 'Forecast maintenance',
      intent: 'Prioritises the maintenance schedule against the available budget and identifies deferrals.',
      path,
      runLabel: 'Forecast',
    });
    if (!accepted) return;

    button.disabled = true;
    button.textContent = 'Forecasting…';
    try {
      const result = await api.post(path, {
        horizonMonths: 60,
        annualBudgetMinor: 12_000_000,
      });
      toast('Maintenance forecast complete', `${result.schedule.length} interventions · ${result.acuConsumed} ACU`, 'ok');
      await handover(root);
    } catch (error) {
      toast('Forecast failed', error.message, 'err');
      button.disabled = false;
      button.textContent = 'Forecast maintenance';
    }
  });

  const COMMANDS = {
    defect: {
      title: 'Raise defect',
      intent: 'Warranty cover is checked as the defect is raised, so who pays is settled before anyone argues about it.',
      path: `/v1/projects/${projectId}/defects`,
      submitLabel: 'Raise',
      fields: [
        { name: 'assetId', label: 'Asset', type: 'select', required: false, placeholder: 'Not asset-specific',
          options: b.AssetRegisterItem.map((a) => ({ value: a._refId, label: `${a.assetTag} · ${a.description}` })) },
        { name: 'location', label: 'Location', type: 'text' },
        { name: 'description', label: 'Defect', type: 'textarea' },
        { name: 'severity', label: 'Severity', type: 'select', options: [
          { value: 'MINOR', label: 'Minor' }, { value: 'MAJOR', label: 'Major' }, { value: 'CRITICAL', label: 'Critical' },
        ] },
        { name: 'reportedBy', label: 'Reported by', type: 'text', value: state.session.user.name },
        { name: 'evidenceHash', label: 'Evidence', type: 'file' },
      ],
    },
    asset: {
      title: 'Register asset',
      intent: 'Registered against the same spine that built it, so the maintenance forecast reads the installation record rather than a re-keyed copy.',
      path: `/v1/projects/${projectId}/assets`,
      submitLabel: 'Register',
      fields: [
        { name: 'assetTag', label: 'Asset tag', type: 'text', placeholder: 'AST-CLR-002' },
        { name: 'description', label: 'Description', type: 'text' },
        { name: 'assetClass', label: 'Class', type: 'text', placeholder: 'Rotating plant' },
        { name: 'manufacturer', label: 'Manufacturer', type: 'text' },
        { name: 'modelNumber', label: 'Model', type: 'text' },
        { name: 'serialNumber', label: 'Serial number', type: 'text', required: false },
        { name: 'installedAt', label: 'Installed', type: 'date', value: todayIso() },
        { name: 'location', label: 'Location', type: 'text' },
        { name: 'expectedLifeYears', label: 'Expected life (years)', type: 'number', min: 1 },
        { name: 'replacementCostMinor', label: 'Replacement cost', type: 'number', money: true, hint: 'In pounds' },
      ],
    },
  };

  root.querySelector('.cmd-bar')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    const spec = COMMANDS[button.dataset.command];
    if (!spec) return;
    if (await command(spec)) await draw();
  });
}
