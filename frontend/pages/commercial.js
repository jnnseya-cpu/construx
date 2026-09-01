import { api, entityBundle } from '../lib/api.js';
import { donut, waterfall } from '../lib/chart.js';
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
  // A term with no legal effect is not a warning, it is a hole where the
  // business believes it has cover.
  VOID_PAYMENT_CONDITION: 'bad',
  FLOW_DOWN_BREACH: 'bad',
  FUNDING_GAP: 'warn',
  TERMS_NOT_RECORDED: 'warn',
};

/** Severity as the funding-gap findings state it, in the design system's tones. */
const FINDING_TONE = { BAR: 'bad', MATERIAL: 'warn', ROUTINE: 'ok' };

/**
 * The Construction Industry Scheme.
 *
 * Every contractor paying a subcontractor for construction work operates CIS,
 * at every size, and the penalties are for the month nobody remembered rather
 * than for the arithmetic. So the months are listed with their due dates
 * whether or not anything was paid in them.
 */
/**
 * Retention held, and what has fallen due.
 *
 * The platform withheld this on every certificate and had no way to give it
 * back. The number that matters is the one at the top: money that has fallen
 * due and nobody has claimed, because retention is lost by nobody watching a
 * date a year out rather than by anybody disputing it.
 */
function retentionPanel(position) {
  if (!position) return '';
  return html`
    <div class="card pad0" id="retention" style="margin-bottom:14px;scroll-margin-top:68px">
      <h2 style="padding:15px 17px 0">Retention</h2>
      <p style="padding:0 17px;font-size:12.5px;color:var(--text-3);margin:6px 0 10px">${position.summary}</p>
      ${
        position.overdueMinor > 0
          ? html`<div style="padding:0 17px 11px"><div class="notice warn"><div>
              <b>${exact(position.overdueMinor)} has fallen due and is unclaimed.</b><br>
              Retention is lost by nobody watching a date, not by anybody disputing it.
            </div></div></div>`
          : ''
      }
      ${table({
        headers: ['Tranche', 'Falls due', 'Under', 'Entitlement', 'Released', 'Outstanding', ''],
        align: ['', '', '', 'num', 'num', 'num', ''],
        rows: position.tranches.map((t) => [
          t.label,
          t.dueOn ? date(t.dueOn) : '—',
          t.ruleSource ?? '—',
          exact(t.entitlementMinor),
          exact(t.releasedMinor),
          exact(t.outstandingMinor),
          t.releasable
            ? badge('Releasable', 'ok')
            : t.outstandingMinor === 0
              ? badge('Released', '')
              : html`<span title="${t.blockedBy ?? ''}">${badge('Held', 'warn')}</span>`,
        ]),
      })}
      ${
        position.tranches.some((t) => t.blockedBy)
          ? html`<div style="padding:0 17px 15px"><div class="metric-sub">
              ${position.tranches.filter((t) => t.blockedBy).map((t) => html`<div>${t.label}: ${t.blockedBy}</div>`)}
            </div></div>`
          : ''
      }
    </div>
  `;
}

function cisPanel(board, monthly) {
  const months = board?.months ?? [];
  return html`
    <div class="card pad0" id="cis" style="margin-bottom:14px;scroll-margin-top:68px">
      <h2 style="padding:15px 17px 0">CIS deductions and monthly returns</h2>
      <p style="padding:0 17px;font-size:12.5px;color:var(--text-3);margin:6px 0 10px">
        The deduction is on the labour element only — materials the subcontractor bought and VAT come out first. An
        unverified subcontractor is 30%, and the shortfall from paying 20% on an assumption is the contractor's
        liability rather than theirs. A month with nothing in it still has a return.
      </p>
      ${
        months.length === 0
          ? html`<div style="padding:0 17px 15px"><div class="notice"><div>
              No subcontractor payments have been recorded under CIS on this project yet. Record one and the tax month
              it falls in appears here with its due date.
            </div></div></div>`
          : table({
              headers: ['Tax month', 'Subcontractors', 'Withheld', 'Return due', ''],
              align: ['', 'num', 'num', '', ''],
              rows: months.map((m) => [
                m.label,
                m.subcontractors,
                exact(m.deductionMinor),
                date(m.returnDueBy),
                html`<button class="btn quiet" data-cis-month="${m.taxMonthEndsOn}">Open the return</button>`,
              ]),
            })
      }
      ${
        !monthly
          ? ''
          : html`<div style="padding:12px 17px 16px;border-top:1px solid var(--line)">
              <h2 style="margin-bottom:6px">${monthly.taxMonth.label}</h2>
              <p style="font-size:12.5px;color:var(--text-2);margin:0 0 9px">${monthly.summary}</p>
              ${
                monthly.lateness
                  ? html`<div class="notice err"><div>
                      <b>${monthly.lateness.daysLate} day(s) late — ${exact(monthly.lateness.penaltyMinor)}.</b><br>
                      ${monthly.lateness.basis}
                    </div></div>`
                  : ''
              }
              ${
                monthly.nil
                  ? ''
                  : table({
                      headers: ['Subcontractor', 'Verification', 'Rate', 'Payments', 'Gross', 'Materials', 'Labour', 'Withheld'],
                      align: ['', '', '', 'num', 'num', 'num', 'num', 'num'],
                      rows: monthly.lines.map((line) => [
                        line.instanceName ?? line.supplierName,
                        line.verificationNumber ?? badge('Not verified', 'err'),
                        `${line.status === 'GROSS' ? 0 : line.status === 'NET_20' ? 20 : 30}%`,
                        line.payments,
                        exact(line.grossMinor),
                        exact(line.materialsMinor),
                        exact(line.labourMinor),
                        exact(line.deductionMinor),
                      ]),
                    })
              }
              <div class="metric-sub" style="margin-top:10px">${monthly.status}</div>
            </div>`
      }
    </div>
  `;
}

const DEFENCE_TONE = { true: 'ok', false: 'warn' };

const INTERMEDIATION_TONE = {
  NOT_ASSESSED: 'warn',
  SPECIFICATION_NOT_OWNED: 'bad',
  SUPPLIER_CONCENTRATION: 'warn',
  // Large enough to be the service, and already talking to the client. This is
  // where the appointment is lost.
  CONCENTRATED_AND_APPROACHING: 'bad',
  DIRECT_APPROACHES: 'warn',
  FRAMEWORK_EXPIRING: 'bad',
  RELYING_ON_THE_WEAKEST: 'bad',
};

/**
 * Staying between the client and the panel.
 *
 * The other half of the integrator's exposure. `integrationPanel` answers
 * whether there is money in the account; this answers whether there will be an
 * appointment next year.
 */
const EXPOSURE_TONE = {
  HIDDEN_CONCENTRATION: 'bad',
  TENANT_CONCENTRATION: 'bad',
  ON_EVERY_PROJECT: 'warn',
  APPROACHING_MORE_THAN_ONE_CLIENT: 'bad',
};

/**
 * The same supplier, across every appointment.
 *
 * The per-project panel above is answering about one job. A supplier holding a
 * fifth of five jobs is unremarkable on each of them and is the largest single
 * thing this business depends on, and no reading order over the per-project
 * view makes that appear.
 */
function exposurePanel(view) {
  if (view?.error) {
    return html`<div class="card" style="margin-bottom:14px">
      <h2>Every supplier, across every appointment</h2>
      <p class="metric-sub">This could not be read: ${view.error.message}</p>
    </div>`;
  }
  if (!view) return '';

  const threshold = view.threshold ?? {};
  return html`
    <div class="card pad0" style="margin-bottom:14px">
      <h2 style="padding:15px 17px 0">Every supplier, across every appointment</h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
        ${view.summary ?? ''}
      </p>

      ${
        (view.concerns ?? []).length > 0
          ? html`<div class="split-list" style="padding:11px 17px 0">
              ${view.concerns.map(
                (concern) => html`<div class="row">
                  <span class="lbl">${badge(humanise(concern.kind), EXPOSURE_TONE[concern.kind] ?? 'warn')} ${concern.subject}</span>
                  <span class="val" style="font-size:12px;color:var(--text-3)">${concern.consequence}</span>
                </div>`,
              )}
            </div>`
          : ''
      }

      ${
        (view.suppliers ?? []).length > 0
          ? html`<div style="padding:11px 17px 0">
              ${donut({
                slices: view.suppliers.map((supplier) => ({
                  label: supplier.supplierName,
                  value: supplier.committedMinor / 100,
                })),
                format: (value) => money(Math.round(value * 100)),
              })}
            </div>
            ${table({
              headers: ['Supplier', 'Committed', 'Share of the business', 'Largest single job', 'Appointments'],
              align: ['', 'num', 'num', 'num', ''],
              rows: view.suppliers.map((supplier) => [
                html`${supplier.supplierName}${
                  supplier.approachedOnProjects > 0
                    ? html` ${badge(`Approached ${supplier.approachedOnProjects} client(s)`, 'bad')}`
                    : ''
                }`,
                money(supplier.committedMinor),
                // The two figures side by side are the point of the whole
                // table: a share of the business that nothing on any single job
                // would have raised.
                html`<span class="${raw(supplier.hiddenByProjectView ? 'bad' : supplier.tenantSharePercent > (threshold.percent ?? 100) ? 'bad' : '')}">
                  ${supplier.tenantSharePercent}%
                </span>`,
                html`<span class="${raw(supplier.largestProjectSharePercent > (threshold.percent ?? 100) ? 'bad' : '')}">
                  ${supplier.largestProjectSharePercent}%
                </span>`,
                html`<span style="font-size:12px;color:var(--text-3)">${supplier.projects
                  .map((project) => `${project.projectName} (${project.projectSharePercent}%)`)
                  .join(' · ')}</span>`,
              ]),
            })}
            <p style="padding:0 17px 15px;font-size:12px;color:var(--text-3);margin:8px 0 0">
              Judged against ${threshold.percent}% — ${threshold.source ?? ''}. A share of the business above the
              share of any single job is arithmetically impossible: the first is the value-weighted mean of the
              second. What this table finds instead is the firm that is largest overall while breaching nothing
              anywhere.
            </p>`
          : html`<div style="padding:11px 17px 15px">
              <div class="notice"><div>Nothing has been committed to a supplier on any appointment, so there is no
                exposure to measure yet.</div></div>
            </div>`
      }
    </div>`;
}

function intermediationPanel(position) {
  if (position?.error) {
    return html`<div class="card" style="margin-bottom:14px">
      <h2>Staying between the client and the panel</h2>
      <p class="metric-sub">This could not be read: ${position.error.message}</p>
    </div>`;
  }
  if (!position) return '';

  const threshold = position.concentrationThreshold ?? {};
  return html`
    <div class="card pad0" style="margin-bottom:14px">
      <h2 style="padding:15px 17px 0">Staying between the client and the panel</h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
        ${position.summary ?? ''}
      </p>

      ${
        (position.concerns ?? []).length > 0
          ? html`<div class="split-list" style="padding:11px 17px 0">
              ${position.concerns.map(
                (concern) => html`<div class="row">
                  <span class="lbl">${badge(humanise(concern.kind), INTERMEDIATION_TONE[concern.kind] ?? 'warn')} ${concern.subject}</span>
                  <span class="val" style="font-size:12px;color:var(--text-3)">${concern.consequence}</span>
                </div>`,
              )}
            </div>`
          : ''
      }

      <h2 style="padding:15px 17px 0">What keeps this business in the middle</h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
        Every supplier on this appointment is introduced to the client, and next time the client can buy from any of
        them directly. What each defence <b>does not</b> do is the more useful column: a business with three of these
        that believes it therefore cannot be displaced has stopped doing the thing that keeps it there.
      </p>
      ${table({
        headers: ['Defence', 'In place', 'What it buys', 'What it does not do'],
        rows: (position.defences ?? []).map((defence) => [
          defence.label,
          // Never assessed and assessed as absent are different facts, and
          // only one of them is somebody's decision.
          defence.assessed
            ? badge(defence.inPlace ? 'Yes' : 'No', DEFENCE_TONE[String(defence.inPlace)])
            : badge('Not assessed', 'warn'),
          html`<span style="font-size:12px;color:var(--text-3)">${defence.holds}</span>${
            // On its own line. Appended to the sentence above it, the evidence
            // read as the end of that sentence — "...the easiest line on the
            // account to question. One consolidated application per month".
            defence.evidence
              ? html`<div style="font-size:12px;margin-top:5px"><span class="lbl">Where it lives</span> <b>${defence.evidence}</b></div>`
              : ''
          }`,
          html`<span style="font-size:12px;color:var(--text-3)">${defence.doesNotHold}</span>`,
        ]),
      })}

      <h2 style="padding:15px 17px 0">Where the committed value sits</h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
        Measured off the subcontracts rather than from an impression. Judged against
        ${threshold.percent}% — ${threshold.source ?? ''}.
      </p>
      ${
        (position.shares ?? []).length > 0
          ? table({
              headers: ['Supplier', 'Committed', 'Share', 'Has approached the client'],
              align: ['', 'num', 'num', ''],
              rows: position.shares.map((share) => [
                share.supplierName,
                money(share.committedMinor),
                html`<span class="${raw(share.sharePercent > (threshold.percent ?? 100) ? 'bad' : '')}">${share.sharePercent}%</span>`,
                share.hasApproachedClient ? badge('Yes', 'bad') : '—',
              ]),
            })
          : html`<div style="padding:11px 17px 15px">
              <div class="notice"><div>Nothing has been committed to a supplier yet, so there is no concentration to
                measure. It becomes measurable with the first subcontract.</div></div>
            </div>`
      }

      <h2 style="padding:15px 17px 0">Who at the client this business knows</h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
        Nothing above survives the only person at the client who rates us moving on, and nothing survives the only
        person here who knows them leaving either. Names, their part in the decision, and who here holds the
        relationship — nothing else, because this is not a place to build a file on a person.
      </p>
      ${
        (position.relationship?.contacts ?? []).length > 0
          ? table({
              headers: ['Name', 'Their part in it', 'Held here by', 'Still in post'],
              rows: position.relationship.contacts.map((contact) => [
                contact.name,
                contact.roleLabel,
                contact.ownedBy,
                contact.departed ? badge('Has left', 'bad') : badge('Yes', 'ok'),
              ]),
            })
          : html`<div style="padding:11px 17px 15px">
              <div class="notice"><div>Nobody at the client has been recorded. On a renewal the question is whether
                this business knows the person who signs, and it is answerable now and not in the month it
                matters.</div></div>
            </div>`
      }

      ${
        (position.approaches ?? []).length > 0
          ? html`<h2 style="padding:15px 17px 0">Direct approaches on the record</h2>
            <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
              One is a conversation. A pattern is the appointment being priced by somebody else, and it shows up
              months before the renewal it decides.
            </p>
            ${table({
              headers: ['When', 'Supplier', 'What happened', 'Outcome'],
              rows: position.approaches.map((entry) => [
                entry.occurredOn,
                entry.supplierName,
                html`<span style="font-size:12px;color:var(--text-3)">${entry.what}</span>`,
                badge(entry.outcomeLabel, entry.outcome === 'PROCEEDED' ? 'bad' : 'warn'),
              ]),
            })}`
          : ''
      }
    </div>`;
}

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
  const gap = position?.fundingGap;

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
                <h2>${price.passThroughMinor === 0 ? 'Fee income' : 'Contract price'}</h2>
                <div class="metric">${money(price.contractPriceMinor)}</div>
                <div class="metric-sub">
                  ${
                    // On a fee appointment the supplier cost never reaches this
                    // business's books, so quoting it as part of the contract
                    // price would state a turnover that will never exist.
                    price.passThroughMinor === 0
                      ? `${price.additionPercent}% of ${money(price.directSupplierCostMinor)} coordinated. The client contracts and pays the suppliers directly.`
                      : `${money(price.directSupplierCostMinor)} of supplier cost, plus ${price.additionPercent}%.`
                  }
                </div>
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

            <p style="padding:12px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
              The same build-up as a shape: where the price starts, what each component adds, and where it ends. A
              client arguing about "twenty per cent" is arguing about a total; this is the only view that shows which
              step they are actually objecting to.
            </p>
            <div style="padding:6px 17px 4px">
              ${waterfall({
                steps: [
                  { label: 'Supplier cost', value: price.directSupplierCostMinor / 100, kind: 'BASE' },
                  ...price.components
                    .filter((component) => component.amountMinor > 0)
                    .map((component) => ({ label: component.label, value: component.amountMinor / 100, kind: 'ADD' })),
                  { label: 'Contract price', value: price.contractPriceMinor / 100, kind: 'TOTAL' },
                ],
                format: (value) => money(Math.round(value * 100)),
              })}
            </div>

            <div class="split-list" style="padding:0 17px 15px">
              <div class="row">
                <span class="lbl">Owed by the client, uncertified or unpaid</span>
                <span class="val">${money(reserve.owedByClientMinor ?? 0)}</span>
              </div>
              <div class="row">
                <span class="lbl">Certified to suppliers and unpaid</span>
                <span class="val">${money(reserve.owedToSuppliersMinor ?? 0)}</span>
              </div>
              ${
                position?.trading
                  ? html`<div class="row">
                      <span class="lbl">${position.trading.label}</span>
                      <span class="val" style="font-size:12px;color:var(--text-3)">${position.trading.cashRisk}</span>
                    </div>
                    <div class="row">
                      <span class="lbl">What this model costs on margin</span>
                      <span class="val" style="font-size:12px;color:var(--text-3)">${position.trading.marginRisk}</span>
                    </div>`
                  : ''
              }
            </div>

            <h2 style="padding:0 17px 0">When the client pays, and when the suppliers are paid</h2>
            <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
              The usual answer to a cash trap is "back-to-back terms", and the phrase covers two arrangements that
              behave completely differently. Making payment <b>conditional</b> on the client having paid is of no
              effect under section 113 of the Construction Act, so it protects nothing. Setting the subcontract
              payment <b>period</b> so the money arrives before it has to leave is a payment period, which nothing
              prohibits, and it is the one that works.
            </p>
            ${
              gap
                ? html`
                  <div class="split-list" style="padding:11px 17px 0">
                    <div class="row">
                      <span class="lbl">Client pays</span>
                      <span class="val">${gap.clientPaymentDays} day(s) from application</span>
                    </div>
                    <div class="row">
                      <span class="lbl">Suppliers are paid</span>
                      <span class="val">${gap.supplierPaymentDays} day(s) from application</span>
                    </div>
                    <div class="row">
                      <span class="lbl">${gap.gapDays > 0 ? 'Funded by this business' : 'Held before it is paid out'}</span>
                      <span class="val ${raw(gap.gapDays > 0 ? 'bad' : 'good')}">
                        ${Math.abs(gap.gapDays)} day(s)${gap.exposureMinor ? ` · ${money(gap.exposureMinor)}` : ''}
                      </span>
                    </div>
                    ${
                      // Absent is not zero. With nothing certified down the
                      // chain there is no rate of spend to price the gap at,
                      // and "£0 exposed" would be read as safety.
                      gap.exposureMinor === undefined
                        ? html`<div class="row">
                            <span class="lbl">Not yet priced</span>
                            <span class="val" style="font-size:12px;color:var(--text-3)">${gap.unmeasured ?? ''}</span>
                          </div>`
                        : ''
                    }
                  </div>
                  ${table({
                    headers: ['Authority', 'What it means here'],
                    rows: gap.findings.map((finding) => [
                      badge(finding.authority, FINDING_TONE[finding.severity] ?? 'warn'),
                      html`<span style="font-size:12px;color:var(--text-3)">${finding.finding}</span>`,
                    ]),
                  })}`
                : html`<div style="padding:11px 17px 15px">
                    <div class="notice"><div>
                      Nobody has recorded the two payment periods yet, so the platform cannot say which happens first.
                      That difference is the whole cash exposure of the model, and it is the one number that can be
                      fixed before the contracts are signed rather than argued about afterwards.
                    </div></div>
                  </div>`
            }
          `
          : ''
      }
    </div>
  `;
}

export async function commercial(root) {
  const projectId = state.session.projectId;

  const [bundle, ledger, forward, commercialControl, settlements, integration, intermediation, exposure, cisMonths] = await Promise.all([
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
      // For the retention position: the contract the retention is held under.
      'Contract',
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
    api.get(`/v1/projects/${projectId}/integration`).catch((error) => ({ error })),
    api.get(`/v1/projects/${projectId}/intermediation`).catch((error) => ({ error })),
    api.get('/v1/supplier-exposure').catch((error) => ({ error })),
    // Tax months with CIS payments on this project. The board is cheap; the
    // return itself is fetched only for the month somebody opened.
    api.get(`/v1/projects/${projectId}/cis/returns`).catch(() => null),
  ]);

  // Retention held against the main contract, and what has fallen due. Fetched
  // after the bundle because it needs the contract the bundle carries.
  const mainContract = bundle.Contract?.at(-1);
  const retention = mainContract
    ? await api.get(`/v1/projects/${projectId}/contracts/${mainContract._refId}/retention`).catch(() => null)
    : null;

  const openCisMonth = state.cisMonth ?? null;
  const cisReturn = openCisMonth
    ? await api.get(`/v1/projects/${projectId}/cis/returns/${openCisMonth}?asAt=${today()}`).catch(() => null)
    : null;

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
            { id: 'tradingTerms', label: 'Record payment periods', permitted: can('BUDGET_COST', 'U'), reason: blockedReason('BUDGET_COST', 'U') },
            { id: 'defence', label: 'Record a margin defence', permitted: can('BUDGET_COST', 'U'), reason: blockedReason('BUDGET_COST', 'U') },
            { id: 'directApproach', label: 'Log a direct approach', permitted: can('BUDGET_COST', 'U'), reason: blockedReason('BUDGET_COST', 'U') },
            { id: 'clientContact', label: 'Record a client contact', permitted: can('BUDGET_COST', 'U'), reason: blockedReason('BUDGET_COST', 'U') },
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
      ${intermediationPanel(intermediation)}
      ${exposurePanel(exposure)}

      ${retentionPanel(retention)}

      ${cisPanel(cisMonths, cisReturn)}

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
  root.addEventListener('click', async (event) => {
    const openMonth = event.target.closest('[data-cis-month]');
    if (!openMonth) return;
    state.cisMonth = openMonth.dataset.cisMonth;
    await draw();
    document.getElementById('cis')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

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
          // From the catalogue the position publishes, not from three lines
          // written here. These are commercial rules — which model funds
          // supplier cost, and what each costs in cash and in margin — and a
          // screen that names them itself is a second source of truth for them.
          // Two of the three descriptions written here had already drifted into
          // saying the opposite of what the platform does with them.
          options: (integration?.models ?? []).map((entry) => ({ value: entry.model, label: entry.label })),
          hint: 'Whose money pays the supplier is the question. Everything else — the reserve, the price build-up, the margin exposure — follows from the answer.',
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
    tradingTerms: {
      title: 'Record the payment periods',
      intent:
        'When the client pays, and when the suppliers are paid. The gap between them is funded by this business on ' +
        'every cycle, it scales with the job rather than with the fee, and it is the one number that can be fixed ' +
        'before the contracts are signed. A clause making payment conditional on the client having paid is recorded ' +
        'here too — not because it helps, but because it is of no effect under section 113 and the business needs to ' +
        'know it is relying on nothing.',
      path: () => `/v1/projects/${projectId}/integration/trading-terms`,
      submitLabel: 'Record them',
      fields: [
        {
          name: 'clientPaymentDays',
          label: 'Client pays, in days from application',
          type: 'number',
          step: '1',
          hint: 'The final date for payment under the main contract.',
        },
        {
          name: 'supplierPaymentDays',
          label: 'Suppliers are paid, in days from their application',
          type: 'number',
          step: '1',
          hint: 'Longer than the line above and the money is in the account before it leaves. That is the mitigation that works.',
        },
        {
          name: 'conditionalOnClientPayment',
          label: 'Does the subcontract pay only when this business is paid?',
          type: 'select',
          options: [
            { value: 'no', label: 'No' },
            { value: 'yes', label: 'Yes — there is a pay-when-paid clause' },
          ],
          hint: 'Section 113 makes that term ineffective except on the client’s insolvency. Recorded so the exposure is counted as if it were not there.',
        },
        {
          name: 'publicSectorClient',
          label: 'Is the client a contracting authority?',
          type: 'select',
          options: [
            { value: 'no', label: 'No — private client' },
            { value: 'yes', label: 'Yes — public body' },
          ],
          hint: 'On public work, regulation 113 requires 30-day terms to be passed down the whole chain.',
        },
      ],
      transform: (v) => ({
        clientPaymentDays: Math.round(Number(v.clientPaymentDays)),
        supplierPaymentDays: Math.round(Number(v.supplierPaymentDays)),
        conditionalOnClientPayment: v.conditionalOnClientPayment === 'yes',
        publicSectorClient: v.publicSectorClient === 'yes',
      }),
    },
    defence: {
      title: 'Record a margin defence',
      intent:
        'Five things keep a coordinator between its client and the panel, and each one has a limit worth knowing. ' +
        'A non-circumvention term binds the supplier and not the client — the client may appoint whoever it likes ' +
        'and is not a party to it. Recording a defence as in place with nothing behind it is the belief this ' +
        'register exists to test, written down as a fact, so where it lives is required.',
      path: () => `/v1/projects/${projectId}/intermediation/defence`,
      submitLabel: 'Record it',
      fields: [
        {
          name: 'kind',
          label: 'Which defence',
          type: 'select',
          // From the position, which publishes all five with their limits, so
          // the form and the rule come from the same place.
          options: (intermediation?.defences ?? []).map((entry) => ({ value: entry.kind, label: entry.label })),
        },
        {
          name: 'inPlace',
          label: 'Is it in place?',
          type: 'select',
          options: [
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
          ],
        },
        {
          name: 'evidence',
          label: 'Where does it live?',
          type: 'text',
          required: false,
          placeholder: 'Clause 14.3 of the standard subcontract',
          hint: 'Required where the answer is yes. The clause, the framework, the document.',
        },
        {
          name: 'relation',
          label: 'For a non-circumvention term: what is the other party?',
          type: 'select',
          required: false,
          options: [
            { value: '', label: '—' },
            { value: 'OWN_SUPPLIER', label: 'A supplier or subcontractor this business appoints' },
            { value: 'COMPETITOR', label: 'A business that competes for the same appointment' },
            { value: 'PANEL_TO_PANEL', label: 'An arrangement between the panel suppliers themselves' },
          ],
          hint:
            'With your own supplier this is an ordinary vertical restraint. Between competitors, or among the panel ' +
            'itself, the same words are customer allocation and unlawful — the platform refuses to record it.',
        },
      ],
      transform: (v) => ({
        kind: v.kind,
        inPlace: v.inPlace === 'yes',
        ...(v.evidence ? { evidence: v.evidence } : {}),
        ...(v.relation ? { relation: v.relation } : {}),
      }),
    },
    directApproach: {
      title: 'Log a direct approach',
      intent:
        'A panel supplier went to the client without us. Written down at the time, because the value is in the ' +
        'pattern and the pattern is invisible in hindsight — one is a conversation, three in a quarter is the ' +
        'appointment being priced by somebody else while there is still time to answer it.',
      path: () => `/v1/projects/${projectId}/intermediation/direct-approach`,
      submitLabel: 'Log it',
      fields: [
        {
          name: 'supplierPartyId',
          label: 'Supplier',
          type: 'select',
          // The suppliers this project has actually committed to, so the log
          // cannot name a firm the project does not buy from.
          options: (intermediation?.shares ?? []).map((share) => ({
            value: share.supplierPartyId,
            label: `${share.supplierName} — ${share.sharePercent}% of committed value`,
          })),
        },
        { name: 'occurredOn', label: 'When', type: 'date' },
        {
          name: 'what',
          label: 'What happened',
          type: 'textarea',
          rows: 2,
          hint: 'This is a record about a named business. A line with no facts in it is an allegation.',
        },
        {
          name: 'outcome',
          label: 'What came of it',
          type: 'select',
          options: [
            { value: 'UNKNOWN', label: 'Not known what came of it' },
            { value: 'SUPPLIER_DECLINED', label: 'The supplier declined and told us' },
            { value: 'CLIENT_REDIRECTED', label: 'The client redirected it back to us' },
            { value: 'PROCEEDED', label: 'It went ahead without us' },
          ],
        },
      ],
      transform: (v) => ({
        supplierPartyId: v.supplierPartyId,
        supplierName:
          (intermediation?.shares ?? []).find((share) => share.supplierPartyId === v.supplierPartyId)?.supplierName ??
          v.supplierPartyId,
        occurredOn: v.occurredOn,
        what: v.what,
        outcome: v.outcome,
      }),
    },
    clientContact: {
      title: 'Record a client contact',
      intent:
        'Who at the client this business actually knows, their part in the decision, and who here holds the ' +
        'relationship. The two things it is looking for are a set of contacts with nobody in it who signs off the ' +
        'next appointment, and a relationship where every name is held by one employee — which means it belongs to ' +
        'them rather than to the business, and leaves when they do.',
      path: () => `/v1/projects/${projectId}/intermediation/client-contact`,
      submitLabel: 'Record them',
      fields: [
        { name: 'name', label: 'Their name', type: 'text' },
        {
          name: 'role',
          label: 'Their part in the decision',
          type: 'select',
          options: [
            { value: 'DECISION_MAKER', label: 'Signs off the next appointment' },
            { value: 'BUDGET_HOLDER', label: 'Holds the budget this is paid from' },
            { value: 'OPERATIONAL', label: 'Runs the current job day to day' },
            { value: 'TECHNICAL', label: 'Sets or approves the requirement' },
            { value: 'PROCUREMENT', label: 'Runs the buying process' },
          ],
          hint: 'Knowing four people who run the job and nobody who decides the next one is the commonest version of this.',
        },
        {
          name: 'ownedBy',
          label: 'Who here holds this relationship',
          type: 'text',
          hint: 'A contact nobody owns is a name in a list. The point is to find out how much rests on one person.',
        },
        {
          name: 'departed',
          label: 'Are they still in post?',
          type: 'select',
          options: [
            { value: 'no', label: 'Yes, still there' },
            { value: 'yes', label: 'No — they have left' },
          ],
          hint: 'Marked rather than deleted. That the person who rated this business has gone is the most useful thing on this register at a renewal.',
        },
        {
          name: 'contactId',
          label: 'Correcting an existing entry?',
          type: 'select',
          required: false,
          options: [
            { value: '', label: 'No — a new person' },
            ...(intermediation?.relationship?.contacts ?? []).map((contact) => ({
              value: contact.contactId,
              label: `Update ${contact.name}`,
            })),
          ],
        },
      ],
      transform: (v) => ({
        name: v.name,
        role: v.role,
        ownedBy: v.ownedBy,
        departed: v.departed === 'yes',
        ...(v.contactId ? { contactId: v.contactId } : {}),
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
