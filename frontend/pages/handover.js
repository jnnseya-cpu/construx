import { api, entityBundle } from '../lib/api.js';
import { command, commandBar, confirmCost } from '../lib/command.js';
import { today as todayIso } from '../lib/enums.js';
import { badge, date, drillable, esc, html, humanise, money, pct, raw, render, shortHash, statusTone, table, toast, track } from '../lib/ui.js';
import { insightPanel } from '../lib/insight.js';
import { blockedReason, can, draw, state } from '../app.js';

/**
 * Handover & O&M.
 *
 * The point at which most construction data dies. Here the asset register still
 * resolves back through commissioning and installation to the drawing revision
 * the asset was built to — which is what makes a defect in year twelve
 * answerable rather than argued.
 */

/**
 * 11.2 — the stage workspace band.
 *
 * The specification asks for a page that opens on a stage-specific **action
 * queue, not a static summary**, under a header carrying the gate state,
 * completeness, blockers, the accountable owner, the last cut-off and the
 * permitted next command.
 *
 * Everything here is read from `/handover-acceptance` and `/stage-gate`.
 * Nothing is scored in the browser: the eight-domain validation and the seven
 * gate clauses are server-side, and duplicating either as a threshold in
 * JavaScript is how a console ends up disagreeing with the platform it is a
 * window onto.
 *
 * **The queue is the failing domains and the open residual obligations**, in
 * that order, because those are the two lists a person on this page can
 * actually act on. When both are empty the band says the stage is ready rather
 * than showing an empty table — an action queue with nothing in it should read
 * as finished, not as broken.
 */
function stageWorkspace(acceptance, gate) {
  // Absent rather than zero. A project that has not reached the stage, or a
  // reader without the handover read, gets no band at all — showing "0 of 8
  // domains ready" to somebody who simply cannot see them would be a lie.
  if (!acceptance) return '';

  const domains = acceptance.domains ?? [];
  const notReady = domains.filter((domain) => !domain.ready);
  const blockingDomains = notReady.filter((domain) => domain.blocking);
  const advisory = notReady.filter((domain) => !domain.blocking);
  const residual = acceptance.residual ?? [];
  const readiness = acceptance.readiness;
  const baseline = acceptance.baseline;
  const packs = acceptance.packs ?? [];

  const gatePassed = gate?.passed === true;
  const gateFailed = (gate?.failed ?? []).length;
  const gateUnassessable = (gate?.unassessable ?? []).length;

  const today = new Date().toISOString().slice(0, 10);
  const overdue = residual.filter((item) => item.dueDate && item.dueDate < today);

  // The permitted next command, derived from where the stage actually is rather
  // than from a wish. Each step names the one thing that unblocks the next.
  const nextCommand = blockingDomains.length > 0
    ? `Close ${blockingDomains[0].label.toLowerCase()}`
    : packs.every((p) => !p.decision)
      ? 'Compile a manifest and decide the pack'
      : !acceptance.activation
        ? 'Activate operations from the accepted register'
        : !baseline
          ? 'Freeze the handover baseline'
          : !acceptance.transferred && residual.length > 0
            ? 'Transfer the residual obligations'
            : 'Nothing outstanding on this stage';

  const queueRows = [
    ...blockingDomains.map((domain) => [badge('BLOCKER', 'bad'), domain.label, domain.reason ?? '', '—']),
    ...residual.map((item) => [
      badge(humanise(item.kind), item.dueDate && item.dueDate < today ? 'bad' : 'warn'),
      item.description,
      item.owner,
      item.dueDate ? date(item.dueDate) : '—',
    ]),
    ...advisory.map((domain) => [badge('ADVISORY', 'neutral'), domain.label, domain.reason ?? '', '—']),
  ];

  const gateCell = !gate
    ? html`<span style="color:var(--text-3)">not visible to your role</span>`
    : html`${badge(
        gatePassed ? 'PASSED' : gateUnassessable > 0 && gateFailed === 0 ? 'NOT ASSESSABLE' : 'NOT MET',
        gatePassed ? 'ok' : gateFailed > 0 ? 'bad' : 'warn',
      )} <span style="color:var(--text-3);font-weight:400">${gate.summary ?? ''}</span>`;

  // A requirements matrix that does not exist is not a matrix scoring zero, and
  // showing 0% would read as a project that has done none of its handover
  // rather than one that has not written the matrix yet.
  const completenessCell = !readiness || (readiness.weightTotal ?? 0) === 0
    ? html`<span style="color:var(--text-3)">no requirements matrix</span>`
    : html`${pct(readiness.percent ?? 0, 0)}`;

  const baselineCell = baseline
    ? html`${shortHash(acceptance.manifests?.[0]?.manifestHash ?? '')} <span style="color:var(--text-3);font-weight:400">retained to ${baseline.retainUntil}${baseline.legalHold ? ' · legal hold' : ''}</span>`
    : html`<span style="color:var(--text-3)">not frozen</span>`;

  return html`
    <section class="card pad0" style="margin-bottom:14px" aria-labelledby="stage-workspace-h">
      <h3 id="stage-workspace-h" style="padding:16px 18px 0">Handover stage — action queue</h3>

      <div class="split-list" style="padding:0 18px">
        <div class="row"><span class="lbl">Gate</span><span class="val">${gateCell}</span></div>
        <div class="row"><span class="lbl">Domains ready</span><span class="val">${domains.length - notReady.length} of ${domains.length}</span></div>
        <div class="row"><span class="lbl">Requirement completeness</span><span class="val">${completenessCell}</span></div>
        <div class="row"><span class="lbl">Blockers &middot; warnings</span><span class="val">${blockingDomains.length} &middot; ${advisory.length}</span></div>
        <div class="row"><span class="lbl">Approved baseline</span><span class="val">${baselineCell}</span></div>
        <div class="row"><span class="lbl">Overdue residual items</span><span class="val">${overdue.length}</span></div>
        <div class="row"><span class="lbl">Permitted next command</span><span class="val" style="font-family:inherit">${nextCommand}</span></div>
      </div>

      <div style="padding:14px 18px 18px">
        ${
          queueRows.length === 0
            ? html`<div class="empty"><b>Nothing in the queue.</b>All ${domains.length} domains report ready and no residual obligation is outstanding.</div>`
            : table({ headers: ['', 'What', 'Owner or reason', 'Due'], rows: queueRows })
        }
      </div>
    </section>
  `;
}

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

  // The operating position, which is what an FM opens this screen for. A list of
  // assets is not an operating position any more than a list of events is an
  // audit, and four of this centre's nine panels were partial for that reason.
  // 11.2's stage workspace reads the eight-domain validation and the 11.4 gate
  // rather than scoring the stage a second time here. Both are allowed to be
  // absent: a reader without the handover read, or a project that has not
  // reached the stage, gets the operating position without the workspace band
  // instead of an error.
  const [position, queue, acceptance, gate] = await Promise.all([
    api.get(`/v1/projects/${projectId}/om/position`).catch(() => null),
    api.get(`/v1/projects/${projectId}/om/queue`).catch(() => null),
    api.get(`/v1/projects/${projectId}/handover-acceptance`).catch(() => null),
    api.get(`/v1/projects/${projectId}/stage-gate`).catch(() => null),
  ]);

  const pack = b.HandoverPack.at(-1);
  const forecast = b.MaintenanceForecast.at(-1);
  const openDefects = b.Defect.filter((d) => d.status !== 'CLOSED');
  const coveredDefects = openDefects.filter((d) => d.warrantyCovered);
  const openOrders = b.WorkOrder.filter((w) => w.status !== 'CLOSED');
  const accepted = b.CommissioningTest.filter((t) => t.status === 'ACCEPTED');

  // The records behind each figure. Completeness is scored across the pack and
  // the manuals and tests it is scored against, so all three are named.
  const packSources = [
    ...b.HandoverPack.map((h) => ({ refType: 'HandoverPack', refId: h._refId })),
    ...b.OMManual.map((m) => ({ refType: 'OMManual', refId: m._refId })),
    ...b.CommissioningTest.map((t) => ({ refType: 'CommissioningTest', refId: t._refId })),
  ];
  const assetSources = b.AssetRegisterItem.map((a) => ({ refType: 'AssetRegisterItem', refId: a._refId }));
  const defectSources = openDefects.map((d) => ({ refType: 'Defect', refId: d._refId }));
  const forecastSources = forecast ? [{ refType: 'MaintenanceForecast', refId: forecast._refId }] : [];

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

      ${stageWorkspace(acceptance, gate)}

      ${
        coveredDefects.length > 0
          ? html`<div class="notice info">
              <div><b>${coveredDefects.length} open defect(s) sit under an active warranty.</b><br>
              Cover is checked at the moment a defect is raised, so who pays is answered before anyone argues about it.</div>
            </div>`
          : ''
      }

      <div class="grid g4" style="margin-bottom:14px">
        <div ${raw(drillable('Handover completeness', packSources))}>
          <h3>Handover completeness</h3>
          <div class="metric ${raw(!pack ? '' : pack.completeness === 1 ? 'good' : 'warn')}">${pack ? pct(pack.completeness * 100, 0) : '—'}</div>
          <div class="metric-sub">${pack ? `${(pack.gaps ?? []).length} gap(s) · ${humanise(pack.status)}` : 'no pack compiled'}</div>
        </div>
        <div ${raw(drillable('Registered assets', assetSources))}>
          <h3>Registered assets</h3>
          <div class="metric orange">${b.AssetRegisterItem.length}</div>
          <div class="metric-sub">${activeWarranties.length} under active warranty</div>
        </div>
        <div ${raw(drillable('Open defects', defectSources))}>
          <h3>Open defects</h3>
          <div class="metric ${raw(openDefects.length > 0 ? 'warn' : 'good')}">${openDefects.length}</div>
          <div class="metric-sub">${coveredDefects.length} recharged to a manufacturer</div>
        </div>
        <div ${raw(drillable('5-year maintenance', forecastSources))}>
          <h3>5-year maintenance</h3>
          <div class="metric">${forecast ? money(forecast.totalForecastMinor) : '—'}</div>
          <div class="metric-sub">${forecast ? `budget pressure ${forecast.budgetPressure}` : 'not forecast'}</div>
        </div>
      </div>

      <div id="handover-insight" style="margin-bottom:14px"></div>

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

      ${
        position
          ? html`<div class="card pad0" style="margin-top:14px">
              <div style="padding:15px 17px 0">
                <h3>Operating position</h3>
                <p class="metric-sub" style="margin-bottom:12px">${position.summary}</p>
                <div class="grid g4" style="margin-bottom:12px">
                  <div>
                    <div class="metric-sub">Assets</div>
                    <div class="metric">${position.assets.total}</div>
                    <div class="metric-sub">${money(position.assets.byClass.reduce((sum, c) => sum + c.replacementCostMinor, 0))} to replace</div>
                  </div>
                  <div>
                    <div class="metric-sub">Past expected life</div>
                    <div class="metric ${raw(position.lifeExpired.count > 0 ? 'warn' : 'good')}">${position.lifeExpired.count}</div>
                    <div class="metric-sub">${money(position.lifeExpired.replacementCostMinor)} — due, not failed</div>
                  </div>
                  <div>
                    <div class="metric-sub">Open work orders</div>
                    <div class="metric ${raw(position.workOrders.overdue > 0 ? 'bad' : 'good')}">${position.workOrders.open}</div>
                    <div class="metric-sub">${position.workOrders.overdue} overdue</div>
                  </div>
                  <div>
                    <div class="metric-sub">Defects outside warranty</div>
                    <div class="metric ${raw(position.defects.notCovered > 0 ? 'bad' : 'good')}">${position.defects.notCovered}</div>
                    <div class="metric-sub">${position.defects.underWarranty} covered by somebody else</div>
                  </div>
                </div>
                ${
                  position.cost.recorded
                    ? html`<div class="split-list" style="margin-bottom:12px">
                        <div class="row"><span class="lbl">Recorded operating cost</span><span class="val">${money(position.cost.totalMinor)}</span></div>
                        <div class="row"><span class="lbl">Reactive maintenance</span><span class="val">${money(position.cost.reactiveMinor)}</span></div>
                        <div class="row"><span class="lbl">Planned maintenance</span><span class="val">${money(position.cost.plannedMinor)}</span></div>
                        <div class="row"><span class="lbl">Reactive share of maintenance</span>
                          <span class="val">${position.cost.reactiveShare === null ? 'not computable' : pct(position.cost.reactiveShare * 100)}</span></div>
                      </div>
                      <div class="metric-sub" style="margin-bottom:12px">
                        The share matters more than the total: a facility spending more overall but less of it reactively is
                        being run better, and a total alone cannot tell the two apart.
                      </div>`
                    : html`<div class="notice info" style="margin-bottom:12px"><div>${position.notRecorded}</div></div>`
                }
              </div>
              ${table({
                headers: ['Asset class', 'Count', 'Replacement value'],
                align: ['', 'num', 'num'],
                rows: position.assets.byClass.map((c) => [c.assetClass, c.count, money(c.replacementCostMinor)]),
                empty: 'No assets registered.',
              })}
            </div>`
          : ''
      }

      ${
        queue && queue.items.length > 0
          ? html`<div class="card pad0" style="margin-top:14px">
              <div style="padding:15px 17px 0">
                <h3>What needs doing</h3>
                <p class="metric-sub" style="margin-bottom:12px">
                  ${queue.summary} Statutory inspections sort above emergencies — that looks wrong for a day and is right for
                  a year, because a missed statutory date is an offence and the emergency will still be an emergency in an hour.
                </p>
              </div>
              ${table({
                headers: ['Reference', 'What', 'Asset', 'Priority', 'Due', 'Late by', 'Who pays'],
                align: ['', '', '', '', '', 'num', ''],
                rows: queue.items.slice(0, 20).map((item) => [
                  item.reference,
                  String(item.description).slice(0, 60),
                  item.assetTag ?? '—',
                  item.statutory ? badge('statutory', 'bad') : badge(humanise(item.priority), statusTone(item.priority)),
                  item.dueDate ? date(item.dueDate) : '—',
                  item.daysOverdue > 0 ? `${item.daysOverdue}d` : '—',
                  item.kind === 'DEFECT'
                    ? item.warrantyCovered ? badge('warranty', 'good') : badge('us', 'warn')
                    : '—',
                ]),
              })}
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
        { name: 'installedAt', label: 'Installed', type: 'date', value: todayIso(), max: todayIso() },
        { name: 'location', label: 'Location', type: 'text' },
        { name: 'expectedLifeYears', label: 'Expected life (years)', type: 'number', min: 1 },
        { name: 'replacementCostMinor', label: 'Replacement cost', type: 'number', money: true, hint: 'In pounds' },
      ],
    },
  };

  void insightPanel(root.querySelector('#handover-insight'), {
    projectId,
    areas: ['HANDOVER_OM'],
    subject: 'handover and operations',
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
