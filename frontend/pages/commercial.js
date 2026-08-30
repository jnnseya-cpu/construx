import { api, entityBundle } from '../lib/api.js';
import { command, commandBar } from '../lib/command.js';
import { today } from '../lib/enums.js';
import { badge, date, exact, html, humanise, metric, money, pct, positionReport, raw, render, statusTone, table, toast, track } from '../lib/ui.js';
import { insightPanel } from '../lib/insight.js';
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

/**
 * Running an integrated appointment without a finance team.
 *
 * A business that takes every site service under one contract pays fifteen
 * suppliers monthly and is paid by one client monthly, and nothing synchronises
 * those two facts. What decides whether it survives is not the contract value —
 * it is whether there is money in the account on the day the suppliers are due,
 * when the client has not paid.
 *
 * A large firm answers that with a finance function. This is the answer for a
 * business that has one person doing the commercial job, and it is deliberately
 * four lines rather than a dashboard.
 */
const INTEGRATOR_TONE = {
  RESERVE_SHORT: 'bad',
  PAYING_OUT_FASTER: 'bad',
  CONTINGENCY_UNDRAWN_RISK: 'warn',
  NOT_PRICED: 'warn',
};

function integrationPanel(position) {
  if (position?.error) {
    return html`<div class="card" style="margin-bottom:14px">
      <h2>Integrated appointment</h2>
      <p class="metric-sub">This could not be read: ${position.error.message}</p>
    </div>`;
  }

  const price = position?.price;
  const reserve = position?.reserve ?? {};
  const contingency = position?.contingency ?? {};

  return html`
    <div class="card pad0" style="margin-bottom:14px">
      <h2 style="padding:15px 17px 0">Integrated appointment</h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
        ${position?.summary ?? ''}
      </p>

      ${
        (position?.concerns ?? []).length > 0
          ? html`<div class="split-list" style="padding:11px 17px 0">
              ${position.concerns.map(
                (concern) => html`<div class="row">
                  <span class="lbl">${badge(humanise(concern.kind), INTEGRATOR_TONE[concern.kind] ?? 'warn')} ${concern.subject}</span>
                  <span class="val" style="font-size:12px;color:var(--text-3)">${concern.consequence}</span>
                </div>`,
              )}
            </div>`
          : html`<div style="padding:11px 17px 0">
              ${
                // No concern is not the same answer as a good one. Until
                // something has been certified down the chain there is no
                // outflow to cover, so saying the reserve covers it would tell a
                // business it was safe at the point it has not started paying
                // anybody — which is the point it can still act.
                reserve.coverDays === undefined
                  ? html`<div class="notice"><div>Nothing needs attention yet, but the reserve has not been tested:
                    ${reserve.unmeasured ?? ''}</div></div>`
                  : html`<div class="notice ok"><div>The reserve covers ${reserve.coverDays} day(s) of committed
                    supplier spend, and nothing is being funded out of this business's own money.</div></div>`
              }
            </div>`
      }

      ${
        price
          ? html`
            <div class="grid g4" style="padding:13px 17px 0">
              <div class="card">
                <h2>Contract price</h2>
                <div class="metric">${money(price.contractPriceMinor)}</div>
                <div class="metric-sub">${money(price.directSupplierCostMinor)} of supplier cost, plus ${price.additionPercent}%.</div>
              </div>
              <div class="card">
                <h2>Margin</h2>
                <div class="metric">${money(price.marginMinor)}</div>
                <div class="metric-sub">Management, overhead and profit. Contingency is not in this figure.</div>
              </div>
              <div class="card">
                <h2>Reserve held</h2>
                <div class="metric ${raw(reserve.coverDays !== undefined && reserve.coverDays < 30 ? 'bad' : 'good')}">
                  ${money(reserve.advanceHeldMinor ?? 0)}
                </div>
                <div class="metric-sub">
                  ${
                    reserve.coverDays === undefined
                      ? (reserve.unmeasured ?? '')
                      : `${reserve.coverDays} day(s) of committed supplier spend.`
                  }
                </div>
              </div>
              <div class="card">
                <h2>Contingency left</h2>
                <div class="metric ${raw((contingency.remainingMinor ?? 0) > 0 ? '' : 'warn')}">${money(contingency.remainingMinor ?? 0)}</div>
                <div class="metric-sub">${money(contingency.drawnMinor ?? 0)} drawn of ${money(contingency.pricedMinor ?? 0)} held against risk.</div>
              </div>
            </div>

            <h2 style="padding:15px 17px 0">What the price is made of</h2>
            <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
              Named separately rather than as one percentage. A single "overhead and profit" figure is the number a
              client pushes back on hardest, because it cannot be argued with — twenty per cent of what, for what?
            </p>
            ${table({
              headers: ['Component', 'Rate', 'Amount', 'What it is for'],
              align: ['', 'num', 'num', ''],
              rows: [
                [
                  html`<b>Direct supplier cost</b>`,
                  '—',
                  money(price.directSupplierCostMinor),
                  html`<span style="font-size:12px;color:var(--text-3)">What the suppliers are paid. Everything below sits on top of it.</span>`,
                ],
                ...price.components.map((component) => [
                  component.label,
                  `${component.percent}%`,
                  money(component.amountMinor),
                  html`<span style="font-size:12px;color:var(--text-3)">${component.basis}</span>`,
                ]),
                [
                  html`<b>Contract price</b>`,
                  html`<b>${price.additionPercent}%</b>`,
                  html`<b>${money(price.contractPriceMinor)}</b>`,
                  '',
                ],
              ],
            })}

            <div class="split-list" style="padding:0 17px 15px">
              <div class="row">
                <span class="lbl">Owed by the client, uncertified or unpaid</span>
                <span class="val">${money(reserve.owedByClientMinor ?? 0)}</span>
              </div>
              <div class="row">
                <span class="lbl">Certified to suppliers and unpaid</span>
                <span class="val">${money(reserve.owedToSuppliersMinor ?? 0)}</span>
              </div>
            </div>
          `
          : ''
      }
    </div>
  `;
}

export async function commercial(root) {
  const projectId = state.session.projectId;

  const [bundle, ledger, forward, commercialControl, settlements, integration] = await Promise.all([
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
      // For the contra form: the subcontracts a charge can be set off against,
      // and the pay less notices that can give effect to one.
      'Subcontract',
      'PayLessNotice',
    ]),
    api.get(`/v1/projects/${projectId}/cost/ledger`).catch(() => null),
    // Cash as the record now says it will be, rather than as the tender assumed.
    // The S-curve above is a bid document and stays one; this is measured.
    api.get(`/v1/projects/${projectId}/cost/forward-cashflow`).catch(() => null),
    // Submitted against assessed, certified against paid, and the time bars
    // nobody has checked. A time bar that passes unnoticed does not become a
    // dispute later; it becomes money that was never recoverable.
    api.get(`/v1/projects/${projectId}/commercial-control`).catch((error) => ({ error })),
    api.get(`/v1/projects/${projectId}/settlements`).catch((error) => ({ error })),
    // Running an integrated appointment: what the price is made of, and whether
    // the money will be in the account when the suppliers are due.
    api.get(`/v1/projects/${projectId}/integration`).catch((error) => ({ error }))
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

  /**
   * What each headline figure was computed from.
   *
   * Taken from the records this page already holds rather than from a
   * description of the calculation — the same array the number came out of. A
   * separate query would be a second statement of the sum, and the day one
   * changes without the other the drill starts lying.
   *
   * The CVR record is named on all four because it is the record that carries
   * them; the inputs it read are named beside it so the drill shows what moved.
   */
  const refsOf = (records, refType) => (records ?? []).map((r) => ({ refType, refId: r._refId }));

  const cvrRef = cvr ? [{ refType: 'CVR', refId: cvr._refId }] : [];
  const valueSources = [
    ...cvrRef,
    ...refsOf(bundle.Variation, 'Variation'),
  ];
  const costSources = [
    ...cvrRef,
    ...refsOf(bundle.ActualCost, 'ActualCost'),
    ...refsOf(bundle.Commitment, 'Commitment'),
  ];
  const marginSources = [...cvrRef, ...refsOf(bundle.Budget, 'Budget')];
  // A starting point for the cost-to-complete field, derived from records this
  // page already holds. Offered as a default and never as the answer: what it
  // costs to finish is a judgement the quantity surveyor makes, and the platform
  // has no basis for one.
  const budgetTotal = (budget?.byCostCode ?? []).reduce((sum, line) => sum + Number(line.budgetMinor ?? 0), 0);
  const costToDate = bundle.ActualCost.reduce((sum, cost) => sum + Number(cost.amountMinor ?? 0), 0);
  const remainingBudget = Math.max(0, budgetTotal - costToDate);

  const cashSources = [
    ...cvrRef,
    ...refsOf(bundle.PaymentCertificate, 'PaymentCertificate'),
    ...refsOf(bundle.LedgerEntry, 'LedgerEntry'),
  ];

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
            { id: 'price', label: 'Price the appointment', permitted: can('BUDGET_COST', 'C'), reason: blockedReason('BUDGET_COST', 'C') },
            { id: 'advance', label: 'Record client advance', permitted: can('BUDGET_COST', 'U'), reason: blockedReason('BUDGET_COST', 'U') },
            // Approval authority rather than the QS who maintains the budget. A
            // business where the person spending the contingency is the person
            // recording it has no contingency, it has a slower profit.
            { id: 'contingency', label: 'Draw contingency', permitted: can('BUDGET_COST', 'A'), reason: blockedReason('BUDGET_COST', 'A') },
            { id: 'application', label: 'Submit application', permitted: can('PAYMENT_APPLICATIONS', 'C'), reason: blockedReason('PAYMENT_APPLICATIONS', 'C') },
            { id: 'payless', label: 'Issue pay less notice', permitted: can('PAYMENT_APPLICATIONS', 'A'), reason: blockedReason('PAYMENT_APPLICATIONS', 'A') },
            { id: 'contra', label: 'Raise contra charge', permitted: can('PAYMENT_APPLICATIONS', 'C'), reason: blockedReason('PAYMENT_APPLICATIONS', 'C') },
          ]))}
          ${can('BUDGET_COST', 'X') ? html`<button class="btn ghost" id="publish-cvr">Publish CVR</button>` : ''}
          ${can('BUDGET_COST', 'R') ? html`<button class="btn quiet" id="evm">Take EVM snapshot</button>` : ''}
        </div>
      </div>

      ${integrationPanel(integration)}

      ${
        cvr && (cvr.alerts ?? []).length > 0
          ? html`<div class="notice ${raw(cvr.forecastMarginMinor < 0 ? 'err' : 'warn')}">
              <div><b>${cvr.alerts.length} commercial alert${cvr.alerts.length === 1 ? '' : 's'}</b><br>${cvr.alerts.join(' · ')}</div>
            </div>`
          : ''
      }

      <div class="grid g4" style="margin-bottom:14px">
        ${metric({
          label: 'Forecast final value',
          value: cvr ? money(cvr.forecastFinalValueMinor) : '—',
          tone: 'orange',
          sub: 'contract + approved + unapproved variations',
          sources: valueSources,
        })}
        ${metric({
          label: 'Forecast final cost',
          value: cvr ? money(cvr.forecastFinalCostMinor) : '—',
          sub: 'to date + accruals + cost to complete',
          sources: costSources,
        })}
        ${metric({
          label: 'Forecast margin',
          value: cvr ? pct(cvr.forecastMarginPercent, 2) : '—',
          tone: !cvr ? '' : cvr.forecastMarginPercent < 0 ? 'bad' : cvr.marginErosionPercent > 2 ? 'warn' : 'good',
          sub: cvr
            ? `tender ${pct(cvr.marginAtTenderPercent, 0)} · ${cvr.marginErosionPercent > 0 ? 'eroded' : 'improved'} ${Math.abs(cvr.marginErosionPercent).toFixed(2)} pts`
            : '',
          sources: marginSources,
        })}
        ${metric({
          label: 'Cash position',
          value: cvr ? money(cvr.cashPositionMinor) : '—',
          tone: (cvr?.cashPositionMinor ?? 0) >= 0 ? 'good' : 'bad',
          sub: 'certified less cost incurred',
          sources: cashSources,
        })}
      </div>

      <div id="commercial-insight" style="margin-bottom:14px"></div>

      <div class="grid g-2-1" style="margin-bottom:14px">
        <div class="card pad0">
          <h2 style="padding:15px 17px 0">Budget against actual</h2>
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
            <h2>Earned value</h2>
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
            <h2>Commercial ledger</h2>
            ${
              ledger
                ? html`<div class="split-list">
                    <div class="row"><span class="lbl">Committed</span><span class="val">${money(ledger.committedMinor)}</span></div>
                    <div class="row"><span class="lbl">Certified</span><span class="val">${money(ledger.certifiedMinor)}</span></div>
                    <div class="row"><span class="lbl">Paid</span><span class="val">${money(ledger.paidMinor)}</span></div>
                    <div class="row"><span class="lbl">Retention held</span><span class="val">${money(ledger.retentionHeldMinor)}</span></div>
                    ${
                      // Both figures, always. £180K charged reads as £180K
                      // recovered; if most of it was raised without a pay less
                      // notice it comes back at adjudication and is then chased
                      // separately, and only one of those numbers belongs in a
                      // forecast.
                      ledger.contraChargedMinor > 0
                        ? html`<div class="row">
                              <span class="lbl">Contra charged</span>
                              <span class="val">${money(ledger.contraChargedMinor)}</span>
                            </div>
                            <div class="row">
                              <span class="lbl">Contra enforceable</span>
                              <span class="val ${raw(ledger.contraEnforceableMinor < ledger.contraChargedMinor ? 'bad' : '')}">
                                ${money(ledger.contraEnforceableMinor)}
                              </span>
                            </div>`
                        : ''
                    }
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
          <h2 style="padding:15px 17px 0">Payment cycle — statutory dates</h2>
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
          <h2>Cashflow — net of retention</h2>
          ${
            cashflow
              ? html`<div style="display:flex;align-items:flex-end;gap:2px;height:120px;margin-bottom:10px">
                    ${(cashflow.netByPeriod ?? []).map((value) => {
                      const peak = Math.max(...cashflow.netByPeriod);
                      const height = peak === 0 ? 0 : Math.max(2, Math.round((value / peak) * 100));
                      return html`<div style="flex:1;background:linear-gradient(180deg,var(--orange),rgba(255,106,26,.25));height:${raw(height)}%;border-radius:2px 2px 0 0" title="${money(value)}"></div>`;
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
        <h2 style="padding:15px 17px 0">Forward cashflow — measured, not tendered</h2>
        ${
          !forward
            ? html`<div style="padding:0 17px 15px"><div class="empty"><b>Not available</b>The forward position could not be read.</div></div>`
            : !forward.derivable
              ? html`<div style="padding:12px 17px 15px">
                  <div class="notice">
                    <div>
                      <b>Nothing to project yet</b><br>${forward.reason}
                      ${forward.certifiedUnpaidMinor > 0
                        ? html`<br>${money(forward.certifiedUnpaidMinor)} is certified and unpaid, which is owed rather than forecast.`
                        : ''}
                    </div>
                  </div>
                </div>`
              : html`
                  <div class="grid g3" style="padding:12px 17px 0">
                    <div>
                      <div class="metric-sub">Worst cumulative position</div>
                      <div class="metric ${raw(forward.lowPointMinor < 0 ? 'bad' : 'good')}">${money(forward.lowPointMinor)}</div>
                      <div class="metric-sub">
                        ${forward.lowPointMinor < 0
                          ? `on ${date(forward.lowPointDate)} — this is the figure to fund`
                          : 'the cumulative position never goes negative'}
                      </div>
                    </div>
                    <div>
                      <div class="metric-sub">Certified and unpaid</div>
                      <div class="metric ${raw(forward.certifiedUnpaidMinor > 0 ? 'warn' : '')}">${money(forward.certifiedUnpaidMinor)}</div>
                      <div class="metric-sub">owed on a date the contract fixed, shown on that period at its own value</div>
                    </div>
                    <div>
                      <div class="metric-sub">Run rate per period</div>
                      <div class="metric">${money(forward.averageNetCertifiedMinor)}</div>
                      <div class="metric-sub">mean of ${forward.measuredFromCycles} certification${forward.measuredFromCycles === 1 ? '' : 's'}</div>
                    </div>
                  </div>
                  ${
                    forward.outflow.measured
                      ? ''
                      : html`<div style="padding:12px 17px 0"><div class="notice warn">
                          <div><b>Inflow only</b><br>${forward.outflow.reason}</div>
                        </div></div>`
                  }
                  ${
                    !forward.headroom.known
                      ? html`<div style="padding:12px 17px 0"><div class="notice warn">
                          <div><b>Uncapped projection</b><br>${forward.headroom.reason}</div>
                        </div></div>`
                      : forward.headroom.exhaustsAtPeriod !== undefined
                        ? html`<div style="padding:12px 17px 0"><div class="notice warn">
                            <div>
                              <b>The run rate outruns the contract at period ${forward.headroom.exhaustsAtPeriod}</b><br>
                              ${money(forward.headroom.remainingCertifiableMinor)} is left to certify against
                              ${money(forward.headroom.contractValueMinor)} of contract and agreed variations.
                              Either the rate or the programme is wrong; the periods after it project nothing rather than
                              money the contract cannot pay.
                            </div>
                          </div></div>`
                        : ''
                  }
                  ${table({
                    headers: ['Period', 'Final date', 'Basis', 'In', 'Out', 'Net', 'Cumulative'],
                    align: ['', '', '', 'num', 'num', 'num', 'num'],
                    rows: forward.periods.map((period) => [
                      `#${period.period}`,
                      date(period.finalDateForPayment),
                      period.basis === 'CERTIFIED'
                        ? badge('certified', 'ok')
                        : period.basis === 'SETTLED'
                          ? badge('settled', 'info')
                          : badge('projected', 'neutral'),
                      money(period.inMinor),
                      period.outMinor > 0 ? money(-period.outMinor) : '—',
                      money(period.netMinor),
                      period.cumulativeMinor < 0
                        ? html`<span style="color:var(--critical)">${money(period.cumulativeMinor)}</span>`
                        : money(period.cumulativeMinor),
                    ]),
                    empty: 'Every payment period has passed its final date',
                  })}
                  <div style="padding:12px 17px 15px"><div class="metric-sub">${forward.summary}</div></div>
                `
        }
      </div>

      <div class="card pad0" style="margin-top:14px">
        <h2 style="padding:15px 17px 0">Applications and certificates</h2>
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
              <h2 style="padding:15px 17px 0">Statutory position — Housing Grants Act</h2>
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

      ${positionReport({
        title: 'Commercial control',
        intent:
          'Submitted against assessed, certified against paid, and the time bars nobody has checked. A time bar ' +
          'that passes unnoticed is not a dispute later — it is money that stopped being recoverable.',
        data: commercialControl,
        error: commercialControl?.error,
        sections: [
          { key: 'unpaid', label: 'Certified and unpaid', empty: 'Everything certified has been paid.' },
          { key: 'unvalidatedTimeBars', label: 'Time bars nobody has checked', empty: 'Every time bar has been checked.' },
          { key: 'deadlines', label: 'Deadlines', empty: 'No contractual deadline is approaching.' },
          { key: 'largestNegotiations', label: 'Largest gaps between submitted and assessed', empty: 'Nothing is in negotiation.' },
          { key: 'chains', label: 'Payment chains', empty: 'No payment chain is running.' },
        ],
      })}

      ${positionReport({
        title: 'Settlements',
        intent:
          'The adjustment bridge, the actions out of it, and whether the price and the programme share a cut-off. ' +
          'A settlement agreed to one cut-off and a programme to another is two settlements.',
        data: settlements,
        error: settlements?.error,
        sections: [{ key: 'settlements', label: 'Settlements', empty: 'Nothing has been settled.' }],
      })}
    `,
  );

  /**
   * The two figures the CVR cannot derive, entered by the person publishing it.
   *
   * They were hardcoded — £11,930,000 to complete and £470,000 of accruals,
   * posted on every publish, on every project, for every customer. The forecast
   * final cost is the number that decides whether a job is making money, it was
   * being computed from a cost-to-complete that came from nowhere, and the
   * result was written to an append-only ledger. Nothing on the screen said so.
   *
   * `aiCost: true` keeps the ACU quote on the panel, so the cost is still shown
   * before the button is pressed — which is what the confirmation dialog this
   * replaces was there for.
   */
  document.getElementById('publish-cvr')?.addEventListener('click', async () => {
    const published = await command({
      title: 'Publish CVR',
      intent:
        'The cost report reads the contract, commitments, variations and certified payments from the record. ' +
        'These two it cannot: what it will cost to finish, and what has been done but not yet invoiced.',
      path: `/v1/projects/${projectId}/cost/cvr`,
      submitLabel: 'Publish',
      aiCost: true,
      fields: [
        { name: 'period', label: 'Period', type: 'month', value: new Date().toISOString().slice(0, 7) },
        {
          name: 'costToCompleteMinor',
          label: 'Cost to complete',
          type: 'number',
          money: true,
          value: budgetTotal > 0 ? remainingBudget / 100 : undefined,
          hint:
            budgetTotal > 0
              ? `Starts at the approved budget less cost to date. That is a starting point, not a forecast — correct it.`
              : 'No approved budget to start from. Your forecast of what it will cost to finish the work.',
        },
        {
          name: 'accrualsMinor',
          label: 'Accruals',
          type: 'number',
          money: true,
          hint: 'Work done and not yet invoiced. Leaving this at zero understates cost and flatters the margin.',
        },
      ],
    });

    if (published) {
      toast('CVR published', 'Margin recalculated from the figures you entered.', 'ok');
      await refreshContext();
      await commercial(root);
    }
  });

  /**
   * Planned value, likewise entered rather than assumed.
   *
   * It was hardcoded at £5,900,000 — the same figure on every project. CPI and
   * SPI are both computed against it, so both indices were meaningless anywhere
   * except the project the number came from, and they render on three screens.
   */
  document.getElementById('evm')?.addEventListener('click', async () => {
    const taken = await command({
      title: 'Take an earned value snapshot',
      intent:
        'Planned value is what the baseline says should have been earned by the end of this period. ' +
        'CPI and SPI are both computed against it, so a wrong figure here makes both indices wrong.',
      path: `/v1/projects/${projectId}/cost/evm`,
      submitLabel: 'Take snapshot',
      fields: [
        { name: 'period', label: 'Period', type: 'month', value: new Date().toISOString().slice(0, 7) },
        {
          name: 'plannedValueMinor',
          label: 'Planned value to date',
          type: 'number',
          money: true,
          hint: 'From the approved programme baseline, for the period ending above.',
        },
      ],
    });

    if (taken) {
      toast('Snapshot taken', 'CPI and SPI recalculated.', 'ok');
      await commercial(root);
    }
  });

  const COMMANDS = {
    price: {
      title: 'Price the appointment',
      intent:
        'The build-up a client is shown, with each part named. A single "overhead and profit" percentage is the ' +
        'number a client pushes back on hardest, because it cannot be argued with. Contingency is priced here and ' +
        'is not margin — it is drawn only against a risk that has materialised, and by somebody with approval ' +
        'authority.',
      path: () => `/v1/projects/${projectId}/integration`,
      submitLabel: 'Price it',
      fields: [
        {
          name: 'directSupplierCost',
          label: 'Forecast supplier cost (£)',
          type: 'number',
          step: '1',
          hint: 'What the suppliers will be paid. Everything above it is the build-up.',
        },
        {
          name: 'model',
          label: 'Delivery model',
          type: 'select',
          options: [
            { value: 'MANAGEMENT_INTEGRATOR', label: 'Management integrator — the client contracts the suppliers' },
            { value: 'ADVISORY', label: 'Advisory — strategy, requirements and procurement only' },
            { value: 'PRINCIPAL_SERVICE_CONTRACTOR', label: 'Principal service contractor — we contract every supplier' },
          ],
          hint: 'The third carries supplier default, cash-flow gaps and interface liability. It needs working capital behind it.',
        },
        { name: 'note', label: 'Note', type: 'textarea', rows: 2, required: false },
      ],
      transform: (v) => ({
        directSupplierCostMinor: Math.round(Number(v.directSupplierCost) * 100),
        model: v.model,
        ...(v.note ? { note: v.note } : {}),
      }),
    },
    advance: {
      title: 'Record the client advance',
      intent:
        'The mobilisation advance and every monthly replenishment take this same command, because they are the same ' +
        'thing: the client funding the reserve the suppliers are paid out of. The reserve should always hold the ' +
        'next period’s committed spend, so that a client paying late is an inconvenience rather than an insolvency.',
      path: () => `/v1/projects/${projectId}/integration/advance`,
      submitLabel: 'Record it',
      fields: [
        { name: 'amount', label: 'Amount received (£)', type: 'number', step: '0.01' },
        { name: 'receivedOn', label: 'Received on', type: 'date' },
        { name: 'reference', label: 'Their reference', type: 'text' },
        { name: 'covers', label: 'What it covers', type: 'text', required: false, placeholder: 'Month 1 committed supplier spend' },
      ],
      transform: (v) => ({
        amountMinor: Math.round(Number(v.amount) * 100),
        receivedOn: v.receivedOn,
        reference: v.reference,
        ...(v.covers ? { covers: v.covers } : {}),
      }),
    },
    contingency: {
      title: 'Draw against contingency',
      intent:
        'For a risk that has actually materialised, named. Money spent on something nobody identified as a risk is ' +
        'an underestimate or a scope change, and both have their own route — recorded here it looks like neither, ' +
        'and the next job is priced on the same wrong figure.',
      path: () => `/v1/projects/${projectId}/integration/contingency`,
      submitLabel: 'Draw it',
      fields: [
        { name: 'amount', label: 'Amount (£)', type: 'number', step: '0.01' },
        { name: 'riskReference', label: 'Which risk', type: 'text', placeholder: 'RR-014' },
        { name: 'reason', label: 'What happened', type: 'textarea', rows: 2 },
      ],
      transform: (v) => ({
        amountMinor: Math.round(Number(v.amount) * 100),
        riskReference: v.riskReference,
        reason: v.reason,
      }),
    },
    contra: {
      title: 'Raise a contra charge',
      intent:
        'A deduction only where a valid pay less notice gives effect to it. Without one this is recorded as a cost to recover by another route, not as money taken.',
      path: `/v1/projects/${projectId}/cost/contra`,
      submitLabel: 'Raise charge',
      fields: [
        {
          name: 'subcontractId',
          label: 'Subcontract',
          type: 'select',
          options: (bundle.Subcontract ?? []).map((sc) => ({
            value: sc.id,
            label: `${sc.reference ?? sc.id.slice(-6)} · ${sc.supplierName ?? sc.supplierId ?? ''}`,
          })),
        },
        {
          name: 'reason',
          label: 'Reason',
          type: 'select',
          options: [
            { value: 'REMEDIAL_WORK', label: 'Remedial work' },
            { value: 'ATTENDANCE', label: 'Attendance' },
            { value: 'PLANT_AND_EQUIPMENT', label: 'Plant and equipment' },
            { value: 'CLEANING_AND_WASTE', label: 'Cleaning and waste' },
            { value: 'DELAY_TO_FOLLOWING_TRADES', label: 'Delay to following trades' },
            { value: 'MATERIALS_SUPPLIED', label: 'Materials supplied' },
            { value: 'STATUTORY_OR_SAFETY', label: 'Statutory or safety' },
          ],
        },
        { name: 'amountMinor', label: 'Amount', type: 'number', hint: 'In minor units — pence for GBP' },
        {
          name: 'narrative',
          label: 'What was done, and why it is their cost',
          type: 'textarea',
          hint: 'The first thing an adjudicator asks for. A charge nobody can explain is one that comes back.',
        },
        { name: 'incurredOn', label: 'Incurred on', type: 'date', value: today() },
        {
          name: 'payLessNoticeId',
          label: 'Pay less notice giving effect to it',
          type: 'select',
          required: false,
          placeholder: 'None — recorded as unenforceable',
          options: (bundle.PayLessNotice ?? [])
            .filter((n) => n.effective)
            .map((n) => ({ value: n.id, label: `${n.reference ?? n.id.slice(-6)} · ${n.issuedDate ?? ''}` })),
          hint: 'Only an effective notice is offered. Without one the charge is an intention to deduct.',
        },
        { name: 'evidenceHash', label: 'Evidence of the cost', type: 'file' },
      ],
      transform: (f) => ({
        ...f,
        amountMinor: Number(f.amountMinor),
        ...(f.payLessNoticeId ? {} : { payLessNoticeId: undefined }),
      }),
    },
    actual: {
      title: 'Post actual cost',
      intent: 'Against a cost code on the approved baseline, so budget-against-actual moves the moment the spend is known.',
      path: `/v1/projects/${projectId}/cost/actuals`,
      submitLabel: 'Post',
      fields: [
        { name: 'costCode', label: 'Cost code', type: 'select',
          options: (budget?.byCostCode ?? []).map((l) => ({ value: l.costCode, label: `${l.costCode} · ${l.description}` })) },
        { name: 'amountMinor', label: 'Amount', type: 'number', money: true, hint: 'In pounds' },
        { name: 'date', label: 'Date', type: 'date', value: today(), max: today() },
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
        { name: 'issuedDate', label: 'Date issued', type: 'date', value: today(), max: today() },
        { name: 'noticeHash', label: 'Notice document', type: 'file' },
      ],
    },
  };

  // Every command centre carries the panel, scoped to the areas it owns. The
  // commercial screen owns the four the QS authors and the Commercial Manager
  // approves; anything outside them belongs on the screen it is about.
  void insightPanel(root.querySelector('#commercial-insight'), {
    projectId,
    areas: ['BUDGET_COST', 'PAYMENT_APPLICATIONS', 'CHANGE_VARIATION', 'CONTRACTS_CLAIMS'],
    subject: 'the commercial position',
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
