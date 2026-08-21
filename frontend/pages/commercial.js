import { api, entityBundle } from '../lib/api.js';
import { command, commandBar, confirmCost } from '../lib/command.js';
import { today } from '../lib/enums.js';
import { badge, date, exact, html, humanise, money, pct, raw, render, statusTone, table, toast, track } from '../lib/ui.js';
import { blockedReason, can, draw, refreshContext, state } from '../app.js';

/**
 * Cost & Value.
 *
 * Budget, commitments, actuals, accruals and progress on one spine, so the
 * forecast final cost moves the moment reality does rather than at month end.
 */

/** Where the notified sum came from, said in words rather than in a constant. */
const SOURCE_LABEL = {
  PAY_LESS_NOTICE: 'Pay less notice',
  PAYMENT_NOTICE: 'Payment notice',
  APPLICATION_BY_DEFAULT: 'Application, by default — no effective notice',
  NOT_YET_DETERMINED: 'Not yet determined',
};

export async function commercial(root) {
  const projectId = state.session.projectId;

  const [bundle, ledger] = await Promise.all([
    entityBundle(projectId, [
      'CVR',
      'EarnedValueSnapshot',
      'Budget',
      'ActualCost',
      'Commitment',
      'CashflowForecast',
      'PaymentCycle',
      'PaymentApplication',
      'PaymentCertificate',
      'LedgerEntry',
      'Variation',
    ]),
    api.get(`/v1/projects/${projectId}/cost/ledger`).catch(() => null),
  ]);

  const cvr = bundle.CVR.at(-1);
  const evm = bundle.EarnedValueSnapshot.at(-1);
  const budget = bundle.Budget.filter((b) => b.status === 'APPROVED').at(-1);
  const cashflow = bundle.CashflowForecast.at(-1);
  const cycle = bundle.PaymentCycle.at(-1);

  const spendByCode = new Map();
  for (const cost of bundle.ActualCost) {
    spendByCode.set(cost.costCode, (spendByCode.get(cost.costCode) ?? 0) + Number(cost.amountMinor ?? 0));
  }

  const notices = cycle
    ? await api.get(`/v1/projects/${projectId}/cost/notices/${cycle._refId}`).catch(() => null)
    : null;

  // The statutory position is a different number from the valuation: what the
  // Act makes payable, rather than what the work was worth.
  const statutory = cycle
    ? await api.get(`/v1/projects/${projectId}/cost/statutory/${cycle._refId}`).catch(() => null)
    : null;

  // Payments are separate records from certificates, so a certificate with
  // nothing against it is visibly outstanding rather than silently assumed paid.
  const paidByCertificate = new Map();
  for (const entry of bundle.LedgerEntry ?? []) {
    if (entry.type !== 'PAYMENT') continue;
    paidByCertificate.set(entry.certificateId, (paidByCertificate.get(entry.certificateId) ?? 0) + Number(entry.amountMinor ?? 0));
  }
  const atRisk = (notices?.position ?? []).filter((p) => p.checks.some((c) => c.status === 'OVERDUE' || c.status === 'LATE'));

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Cost &amp; Value</h1>
          <p>Cost value reconciliation wired to the contract, commitments, variations and certified payments — not a spreadsheet assembled monthly.</p>
        </div>
        <div class="actions cmd-bar">
          ${raw(commandBar([
            { id: 'actual', label: 'Post actual cost', tone: '', permitted: can('BUDGET_COST', 'C'), reason: blockedReason('BUDGET_COST', 'C') },
            { id: 'application', label: 'Submit application', permitted: can('PAYMENT_APPLICATIONS', 'C'), reason: blockedReason('PAYMENT_APPLICATIONS', 'C') },
            { id: 'payless', label: 'Issue pay less notice', permitted: can('PAYMENT_APPLICATIONS', 'A'), reason: blockedReason('PAYMENT_APPLICATIONS', 'A') },
          ]))}
          ${can('BUDGET_COST', 'X') ? html`<button class="btn ghost" id="publish-cvr">Publish CVR</button>` : ''}
          ${can('BUDGET_COST', 'R') ? html`<button class="btn quiet" id="evm">Take EVM snapshot</button>` : ''}
        </div>
      </div>

      ${
        cvr && (cvr.alerts ?? []).length > 0
          ? html`<div class="notice ${raw(cvr.forecastMarginMinor < 0 ? 'err' : 'warn')}">
              <div><b>${cvr.alerts.length} commercial alert${cvr.alerts.length === 1 ? '' : 's'}</b><br>${cvr.alerts.join(' · ')}</div>
            </div>`
          : ''
      }

      <div class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h3>Forecast final value</h3>
          <div class="metric orange">${cvr ? money(cvr.forecastFinalValueMinor) : '—'}</div>
          <div class="metric-sub">contract + approved + unapproved variations</div>
        </div>
        <div class="card">
          <h3>Forecast final cost</h3>
          <div class="metric">${cvr ? money(cvr.forecastFinalCostMinor) : '—'}</div>
          <div class="metric-sub">to date + accruals + cost to complete</div>
        </div>
        <div class="card">
          <h3>Forecast margin</h3>
          <div class="metric ${raw(!cvr ? '' : cvr.forecastMarginPercent < 0 ? 'bad' : cvr.marginErosionPercent > 2 ? 'warn' : 'good')}">
            ${cvr ? pct(cvr.forecastMarginPercent, 2) : '—'}
          </div>
          <div class="metric-sub">${cvr ? `tender ${pct(cvr.marginAtTenderPercent, 0)} · ${cvr.marginErosionPercent > 0 ? 'eroded' : 'improved'} ${Math.abs(cvr.marginErosionPercent).toFixed(2)} pts` : ''}</div>
        </div>
        <div class="card">
          <h3>Cash position</h3>
          <div class="metric ${raw((cvr?.cashPositionMinor ?? 0) >= 0 ? 'good' : 'bad')}">${cvr ? money(cvr.cashPositionMinor) : '—'}</div>
          <div class="metric-sub">certified less cost incurred</div>
        </div>
      </div>

      <div class="grid g-2-1" style="margin-bottom:14px">
        <div class="card pad0">
          <h3 style="padding:15px 17px 0">Budget against actual</h3>
          ${table({
            headers: ['Cost code', 'Description', 'Budget', 'Actual', 'Used'],
            align: ['', '', 'num', 'num', ''],
            rows: (budget?.byCostCode ?? []).map((line) => {
              const actual = spendByCode.get(line.costCode) ?? 0;
              const used = line.budgetMinor === 0 ? 0 : (actual / line.budgetMinor) * 100;
              return [
                line.costCode,
                line.description,
                money(line.budgetMinor),
                money(actual),
                track(used, used > 100 ? 'bad' : used > 85 ? 'warn' : 'good'),
              ];
            }),
            empty: 'No approved cost baseline',
          })}
        </div>

        <div>
          <div class="card" style="margin-bottom:14px">
            <h3>Earned value</h3>
            ${
              evm
                ? html`<div class="split-list">
                    <div class="row"><span class="lbl">CPI</span><span class="val" style="color:${raw(evm.costPerformanceIndex >= 1 ? 'var(--success)' : 'var(--critical)')}">${evm.costPerformanceIndex}</span></div>
                    <div class="row"><span class="lbl">SPI</span><span class="val" style="color:${raw(evm.schedulePerformanceIndex >= 1 ? 'var(--success)' : 'var(--critical)')}">${evm.schedulePerformanceIndex}</span></div>
                    <div class="row"><span class="lbl">EAC</span><span class="val">${money(evm.estimateAtCompletionMinor)}</span></div>
                    <div class="row"><span class="lbl">ETC</span><span class="val">${money(evm.estimateToCompleteMinor)}</span></div>
                    <div class="row"><span class="lbl">Physical complete</span><span class="val">${pct(evm.physicalPercentComplete, 1)}</span></div>
                    <div class="row"><span class="lbl">Confidence</span><span class="val">${pct((evm.confidence ?? 0) * 100, 0)}</span></div>
                  </div>
                  <div class="metric-sub" style="margin-top:9px">Confidence reflects how much of the work carries a measurement — a forecast on thin data says so.</div>`
                : html`<div class="empty"><b>No snapshot</b>Take an EVM snapshot to see performance indices.</div>`
            }
          </div>

          <div class="card">
            <h3>Commercial ledger</h3>
            ${
              ledger
                ? html`<div class="split-list">
                    <div class="row"><span class="lbl">Committed</span><span class="val">${money(ledger.committedMinor)}</span></div>
                    <div class="row"><span class="lbl">Certified</span><span class="val">${money(ledger.certifiedMinor)}</span></div>
                    <div class="row"><span class="lbl">Paid</span><span class="val">${money(ledger.paidMinor)}</span></div>
                    <div class="row"><span class="lbl">Retention held</span><span class="val">${money(ledger.retentionHeldMinor)}</span></div>
                  </div>
                  ${
                    ledger.exceptions.length > 0
                      ? html`<div class="notice warn" style="margin:11px 0 0">
                          <div><b>${ledger.exceptions.length} exception${ledger.exceptions.length === 1 ? '' : 's'}</b><br>${ledger.exceptions.map((e) => e.detail).join(' · ')}</div>
                        </div>`
                      : ''
                  }`
                : html`<div class="empty"><b>Not available</b>Your role cannot read the commercial ledger.</div>`
            }
          </div>
        </div>
      </div>

      <div class="grid g2">
        <div class="card pad0">
          <h3 style="padding:15px 17px 0">Payment cycle — statutory dates</h3>
          ${
            atRisk.length > 0
              ? html`<div style="padding:0 17px"><div class="notice err">${atRisk.length} cycle(s) carry an overdue or late notice. A missed pay-less notice cannot be recovered by argument.</div></div>`
              : ''
          }
          ${table({
            headers: ['Cycle', 'Due', 'Payment notice by', 'Pay less by', 'Final date'],
            rows: (cycle?.periods ?? []).slice(0, 6).map((p) => [
              `#${p.cycleNumber}`,
              date(p.dueDate),
              date(p.paymentNoticeDeadline),
              date(p.payLessNoticeDeadline),
              date(p.finalDateForPayment),
            ]),
            empty: 'No payment cycle generated',
          })}
          ${
            statutory
              ? html`<div style="padding:12px 17px 15px">
                  <div class="split-list">
                    <div class="row"><span class="lbl">Exposure from missed or invalid notices</span><span class="val">${
                      statutory.totalExposureMinor > 0 ? money(statutory.totalExposureMinor) : '—'
                    }</span></div>
                    <div class="row"><span class="lbl">Notified sums unpaid past the final date</span><span class="val">${
                      statutory.totalOverdueMinor > 0 ? money(statutory.totalOverdueMinor) : '—'
                    }</span></div>
                    ${
                      statutory.nextAction
                        ? html`<div class="row"><span class="lbl">Next notice due</span><span class="val">${statutory.nextAction.notice} · cycle #${statutory.nextAction.cycleNumber} · serve by ${date(statutory.nextAction.serveBy)}</span></div>`
                        : ''
                    }
                  </div>
                  <div class="metric-sub" style="margin-top:9px">${statutory.summary}</div>
                </div>`
              : ''
          }
        </div>

        <div class="card">
          <h3>Cashflow — net of retention</h3>
          ${
            cashflow
              ? html`<div style="display:flex;align-items:flex-end;gap:2px;height:120px;margin-bottom:10px">
                    ${(cashflow.netByPeriod ?? []).map((value) => {
                      const peak = Math.max(...cashflow.netByPeriod);
                      const height = peak === 0 ? 0 : Math.max(2, Math.round((value / peak) * 100));
                      return html`<div style="flex:1;background:linear-gradient(180deg,var(--orange),rgba(255,102,0,.25));height:${raw(height)}%;border-radius:2px 2px 0 0" title="${money(value)}"></div>`;
                    })}
                  </div>
                  <div class="split-list">
                    <div class="row"><span class="lbl">Total value</span><span class="val">${money(cashflow.totalValueMinor)}</span></div>
                    <div class="row"><span class="lbl">Retention held</span><span class="val">${money(cashflow.retentionHeldMinor)}</span></div>
                    <div class="row"><span class="lbl">Periods</span><span class="val">${cashflow.periods}</span></div>
                  </div>`
              : html`<div class="empty"><b>No forecast</b>Generate a cashflow forecast to see the S-curve.</div>`
          }
        </div>
      </div>

      <div class="card pad0" style="margin-top:14px">
        <h3 style="padding:15px 17px 0">Applications and certificates</h3>
        ${table({
          headers: ['Cycle', 'Applied', 'Certified', 'Withheld', 'Retention', 'Paid', 'Final date', 'Reason'],
          align: ['', 'num', 'num', 'num', 'num', 'num', '', ''],
          rows: bundle.PaymentApplication.map((application) => {
            const certificate = bundle.PaymentCertificate.find((c) => c.applicationId === application._refId);
            const paid = certificate ? paidByCertificate.get(certificate._refId) ?? 0 : 0;
            return [
              `#${application.cycleNumber}`,
              money(application.netAppliedMinor),
              certificate ? money(certificate.certifiedMinor) : badge('awaiting certificate', 'warn'),
              certificate && certificate.withheldMinor > 0 ? money(certificate.withheldMinor) : '—',
              certificate ? money(certificate.retentionMinor) : '—',
              paid > 0 ? money(paid) : certificate ? badge('outstanding', 'bad') : '—',
              certificate ? date(certificate.finalDateForPayment) : '—',
              certificate?.reason ?? '—',
            ];
          }),
          empty: 'No applications submitted',
        })}
        <div style="padding:12px 17px 15px"><div class="metric-sub">
          Certification is where a valuation becomes a debt, so it is a separate approval from the application —
          the quantity surveyor who applies cannot certify, and every certificate names the payment notice that carries it.
        </div></div>
      </div>

      ${
        statutory
          ? html`<div class="card pad0" style="margin-top:14px">
              <h3 style="padding:15px 17px 0">Statutory position — Housing Grants Act</h3>
              <div style="padding:0 17px"><div class="metric-sub">
                What is payable under the Act, which is a different question from what the work was worth. Where no
                effective notice was given, the sum applied for becomes the notified sum however the valuation reads.
              </div></div>
              ${table({
                headers: ['Cycle', 'Applied', 'Notified sum', 'From', 'Paid', 'Exposure'],
                align: ['', 'num', 'num', '', 'num', 'num'],
                rows: statutory.cycles
                  .filter((c) => c.notifiedSumSource !== 'NOT_YET_DETERMINED' || c.appliedMinor > 0)
                  .map((c) => [
                    `#${c.cycleNumber}`,
                    money(c.appliedMinor),
                    c.notifiedSumSource === 'NOT_YET_DETERMINED' ? badge('not yet determined', 'warn') : money(c.notifiedSumMinor),
                    SOURCE_LABEL[c.notifiedSumSource] ?? c.notifiedSumSource,
                    c.paidMinor > 0 ? money(c.paidMinor) : '—',
                    c.exposureMinor > 0 ? badge(money(c.exposureMinor), 'bad') : '—',
                  ]),
                empty: 'No cycles to assess',
              })}
              ${
                statutory.cycles.flatMap((c) => c.findings.filter((f) => f.severity === 'CRITICAL').map((f) => ({ ...f, cycleNumber: c.cycleNumber }))).length > 0
                  ? html`<div style="padding:4px 17px 16px">
                      ${statutory.cycles.flatMap((c) =>
                        c.findings
                          .filter((f) => f.severity === 'CRITICAL')
                          .map(
                            (f) => html`<div class="notice err" style="margin:8px 0 0">
                              <div><b>Cycle #${c.cycleNumber} · ${f.authority}</b><br>${f.finding}<br>${f.consequence}</div>
                            </div>`,
                          ),
                      )}
                    </div>`
                  : html`<div style="padding:4px 17px 16px"><div class="notice ok">No statutory failure on any cycle.</div></div>`
              }
            </div>`
          : ''
      }
    `,
  );

  document.getElementById('publish-cvr')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const path = `/v1/projects/${state.session.projectId}/cost/cvr`;

    const accepted = await confirmCost({
      title: 'Publish CVR',
      intent: 'Explains the margin movement and identifies the commercial actions that would recover it.',
      path,
      runLabel: 'Publish',
    });
    if (!accepted) return;

    button.disabled = true;
    button.textContent = 'Publishing…';
    try {
      const result = await api.post(path, {
        period: new Date().toISOString().slice(0, 7),
        costToCompleteMinor: 1_193_000_000,
        accrualsMinor: 47_000_000,
      });
      toast('CVR published', `Margin ${result.cvr.forecastMarginPercent}% · ${result.acuConsumed} ACU`, 'ok');
      await refreshContext();
      await commercial(root);
    } catch (error) {
      toast('Could not publish', error.message, 'err');
      button.disabled = false;
      button.textContent = 'Publish CVR';
    }
  });

  document.getElementById('evm')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await api.post(`/v1/projects/${state.session.projectId}/cost/evm`, {
        period: new Date().toISOString().slice(0, 7),
        plannedValueMinor: 590_000_000,
      });
      toast('Snapshot taken', `CPI ${result.snapshot.costPerformanceIndex} · SPI ${result.snapshot.schedulePerformanceIndex}`, 'ok');
      await commercial(root);
    } catch (error) {
      toast('Snapshot failed', error.message, 'err');
      button.disabled = false;
    }
  });

  const COMMANDS = {
    actual: {
      title: 'Post actual cost',
      intent: 'Against a cost code on the approved baseline, so budget-against-actual moves the moment the spend is known.',
      path: `/v1/projects/${projectId}/cost/actuals`,
      submitLabel: 'Post',
      fields: [
        { name: 'costCode', label: 'Cost code', type: 'select',
          options: (budget?.byCostCode ?? []).map((l) => ({ value: l.costCode, label: `${l.costCode} · ${l.description}` })) },
        { name: 'amountMinor', label: 'Amount', type: 'number', money: true, hint: 'In pounds' },
        { name: 'date', label: 'Date', type: 'date', value: today() },
        { name: 'sourceSystem', label: 'Source system', type: 'text', value: 'ERP' },
        { name: 'description', label: 'Description', type: 'text' },
      ],
    },
    application: {
      title: 'Submit payment application',
      intent: 'The net applied figure is computed from gross, variations, previously certified and retention — it is not typed in.',
      path: `/v1/projects/${projectId}/cost/application`,
      submitLabel: 'Submit',
      fields: [
        { name: 'cycleId', label: 'Payment cycle', type: 'hidden', value: cycle?._refId ?? '' },
        { name: 'cycleNumber', label: 'Cycle number', type: 'number', min: 1 },
        { name: 'grossValuationMinor', label: 'Gross valuation', type: 'number', money: true },
        { name: 'variationsIncludedMinor', label: 'Variations included', type: 'number', money: true },
        { name: 'previouslyCertifiedMinor', label: 'Previously certified', type: 'number', money: true },
        { name: 'retentionMinor', label: 'Retention', type: 'number', money: true },
        { name: 'supportingEvidenceHash', label: 'Supporting valuation', type: 'file' },
      ],
    },
    payless: {
      title: 'Issue pay less notice',
      intent:
        'The only lawful route to paying less than the notified sum. It must state the sum considered due and the basis on which it is calculated — a figure on its own is not a valid notice.',
      // The notice is given against an application, so the application is in
      // the path rather than the body.
      path: (collected) => `/v1/projects/${projectId}/cost/application/${collected.applicationId}/pay-less`,
      transform: ({ applicationId, ...rest }) => rest,
      submitLabel: 'Issue notice',
      fields: [
        { name: 'applicationId', label: 'Application', type: 'select',
          options: bundle.PaymentApplication.map((a) => ({ value: a._refId, label: `#${a.cycleNumber} · ${money(a.netAppliedMinor)} applied` })) },
        { name: 'sumConsideredDueMinor', label: 'Sum considered due', type: 'number', money: true },
        { name: 'basis', label: 'Basis of calculation', type: 'text',
          hint: 'Set out how the sum was arrived at. Required by s.111(4); a notice without it is liable to be held invalid.' },
        { name: 'issuedDate', label: 'Date issued', type: 'date', value: today() },
        { name: 'noticeHash', label: 'Notice document', type: 'file' },
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
