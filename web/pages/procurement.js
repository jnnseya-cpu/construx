import { entityBundle, isWithheld } from '../lib/api.js';
import { badge, date, days, exact, html, humanise, money, pct, raw, render, statusTone, table } from '../lib/ui.js';
import { state } from '../app.js';

/**
 * Tender & Procurement.
 *
 * The screen where an award has to be defensible. Bid scores are deterministic,
 * so the ranking shown here can be recomputed by hand from the same submissions
 * and the same penalty profile — which is what a challenged award requires.
 */

export async function procurement(root) {
  const projectId = state.session.projectId;

  const b = await entityBundle(projectId, [
    'RFQ',
    'SupplierSubmission',
    'BidEvaluation',
    'Adjudication',
    'Subcontract',
    'Commitment',
    'Estimate',
    'BidSubmissionPack',
    'TenderPackage',
    'DesignMaturityAssessment',
    'ScopePackage',
    'BoQItem',
  ]);

  const rfq = b.RFQ.at(-1);
  const evaluation = b.BidEvaluation.at(-1);
  const adjudication = b.Adjudication.at(-1);
  const subcontract = b.Subcontract.at(-1);
  const estimate = b.Estimate.at(-1);
  const maturity = b.DesignMaturityAssessment.at(-1);
  const pack = b.TenderPackage.at(-1);

  const scores = evaluation?.scores ?? [];
  const winner = scores[0];

  // Supplier submissions live in the suppliers' own lane, so most delivery
  // roles cannot read them. Reporting the empty list as "0 returns" would be a
  // different — and wrong — statement from "you cannot see them".
  const returnsCount = isWithheld('SupplierSubmission') ? null : b.SupplierSubmission.length;
  const cheapest = [...scores].sort((x, y) => x.priceMinor - y.priceMinor)[0];
  const cheapestIsNotWinner = cheapest && winner && cheapest.submissionId !== winner.submissionId;

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Tender &amp; Procurement</h1>
          <p>Take-off through award as a state machine. Every transition is a Golden Thread event, so the commercial basis of the award survives the people who made it.</p>
        </div>
      </div>

      <div class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h3>Design maturity</h3>
          <div class="metric ${raw(!maturity ? '' : maturity.score >= 80 ? 'good' : maturity.score >= 60 ? 'warn' : 'bad')}">${maturity ? maturity.score : '—'}</div>
          <div class="metric-sub">${maturity ? `basis: ${humanise(maturity.recommendedPricingBasis)}` : 'not assessed'}</div>
        </div>
        <div class="card">
          <h3>Tender estimate</h3>
          <div class="metric orange">${estimate ? money(estimate.totalMinor) : '—'}</div>
          <div class="metric-sub">${estimate ? `${badgeText(estimate.status)} · margin ${pct(estimate.marginPercent, 1)}` : ''}</div>
        </div>
        <div class="card">
          <h3>Returns received</h3>
          <div class="metric">${returnsCount ?? '—'}</div>
          <div class="metric-sub">${
            returnsCount === null
              ? 'submissions are not visible to your role'
              : rfq
                ? `${rfq.reference} · ${humanise(rfq.status)}`
                : 'no RFQ issued'
          }</div>
        </div>
        <div class="card">
          <h3>Buyout against target</h3>
          <div class="metric ${raw((subcontract?.buyoutDeltaMinor ?? 0) >= 0 ? 'good' : 'bad')}">
            ${subcontract ? money(subcontract.buyoutDeltaMinor) : '—'}
          </div>
          <div class="metric-sub">${subcontract ? `${subcontract.reference} · ${humanise(subcontract.status)}` : 'not awarded'}</div>
        </div>
      </div>

      ${
        cheapestIsNotWinner
          ? html`<div class="notice info">
              <div>
                <b>The cheapest bid is not the recommendation.</b><br>
                ${cheapest.supplierName} priced ${money(cheapest.priceMinor)} against ${winner.supplierName} at ${money(winner.priceMinor)},
                but scored ${cheapest.totalScore} against ${winner.totalScore} once
                ${cheapest.flags.length} flag${cheapest.flags.length === 1 ? '' : 's'} were applied.
              </div>
            </div>`
          : ''
      }

      ${
        estimate?.heads
          ? html`
            <div class="card pad0" style="margin-bottom:14px">
              <h3 style="padding:15px 17px 0">
                Estimate build-up${estimate.durationWeeks ? ` — ${estimate.durationWeeks} weeks on site` : ''}
              </h3>
              <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
                Each head is priced on the basis it actually has. Site staff, welfare, logistics, safety and quality are
                weekly costs, so a programme that moves re-prices the tender instead of quietly eating the margin.
              </p>
              ${table({
                headers: ['Cost head', 'Basis', 'Amount', 'How it was arrived at'],
                align: ['', '', 'num', ''],
                rows: estimate.heads.map((h) => [
                  h.status === 'PRICED' ? h.label : html`<span style="color:var(--text-3)">${h.label}</span>`,
                  badge(humanise(h.basis), h.basis === 'MARGIN' ? 'ok' : ''),
                  h.status === 'PRICED'
                    ? money(h.amountMinor)
                    : h.status === 'EXCLUDED'
                      ? badge('excluded', 'warn')
                      : badge('NOT PRICED', 'bad'),
                  html`<span style="font-size:12px;color:var(--text-3)">${h.excludedReason ?? h.derivation}</span>`,
                ]),
                empty: 'No estimate built',
              })}
              <div class="split-list" style="padding:0 17px 15px">
                <div class="row"><span class="lbl">Net measured works</span><span class="val">${money(estimate.subtotals.netMeasuredMinor)}</span></div>
                <div class="row"><span class="lbl">Site-wide and time-related</span><span class="val">${money(estimate.subtotals.siteOverheadMinor)}</span></div>
                <div class="row"><span class="lbl">Fees</span><span class="val">${money(estimate.subtotals.feesMinor)}</span></div>
                <div class="row"><span class="lbl">Inflation</span><span class="val">${money(estimate.subtotals.inflationMinor)}</span></div>
                <div class="row"><span class="lbl">Contingency from the risk register</span><span class="val">${money(estimate.subtotals.riskMinor)}</span></div>
                <div class="row"><span class="lbl">Insurance</span><span class="val">${money(estimate.subtotals.insuranceMinor)}</span></div>
                <div class="row"><span class="lbl"><b>Total cost</b></span><span class="val"><b>${money(estimate.subtotals.totalCostMinor)}</b></span></div>
                <div class="row"><span class="lbl">Overhead</span><span class="val">${money(estimate.subtotals.overheadMinor)}</span></div>
                <div class="row"><span class="lbl">Profit</span><span class="val">${money(estimate.subtotals.profitMinor)}</span></div>
                <div class="row"><span class="lbl"><b>Tender total</b></span><span class="val"><b style="color:var(--orange)">${money(estimate.totalMinor)}</b></span></div>
              </div>
            </div>

            <div class="grid g4" style="margin-bottom:14px">
              <div class="card">
                <h3>Prelims as % of works</h3>
                <div class="metric ${raw(estimate.benchmarks.prelimsPercentOfWorks > 25 ? 'warn' : 'good')}">${pct(estimate.benchmarks.prelimsPercentOfWorks, 1)}</div>
                <div class="metric-sub">A benchmark, never an input — priced as a percentage, prelims do not move when the programme does.</div>
              </div>
              <div class="card">
                <h3>Contingency as % of cost</h3>
                <div class="metric">${pct(estimate.benchmarks.riskPercentOfCost, 1)}</div>
                <div class="metric-sub">Drawn from the quantified register at P80, not from a round number.</div>
              </div>
              <div class="card">
                <h3>Weekly burn</h3>
                <div class="metric">${money(estimate.benchmarks.weeklyBurnMinor)}</div>
                <div class="metric-sub">${money(estimate.benchmarks.costPerWeekOfSiteOverheadMinor)} of it is site-wide cost that runs whatever the works do.</div>
              </div>
              <div class="card">
                <h3>Margin</h3>
                <div class="metric ${raw(estimate.marginPercent > 0 ? 'good' : 'bad')}">${pct(estimate.marginPercent, 2)}</div>
                <div class="metric-sub">Profit over the tender total, which is always below the percentage applied.</div>
              </div>
            </div>

            ${
              (estimate.warnings ?? []).length > 0
                ? html`<div class="notice warn" style="margin-bottom:14px">
                    <div>
                      <b>The build-up raises ${estimate.warnings.length} point${estimate.warnings.length === 1 ? '' : 's'}.</b>
                      <div class="split-list" style="margin-top:8px">
                        ${estimate.warnings.map((w) => html`<div class="row"><span class="lbl">${w}</span></div>`)}
                      </div>
                    </div>
                  </div>`
                : ''
            }`
          : ''
      }

      <div class="card pad0" style="margin-bottom:14px">
        <h3 style="padding:15px 17px 0">Bid evaluation${evaluation ? ` — ${evaluation.method.price} price / ${evaluation.method.programme} programme / ${humanise(evaluation.method.risk)} risk` : ''}</h3>
        ${table({
          headers: ['Rank', 'Supplier', 'Price', 'Duration', 'Price', 'Prog', 'Risk', 'Total', 'Flags', 'Award'],
          align: ['', '', 'num', 'num', 'num', 'num', 'num', 'num', '', ''],
          rows: scores.map((s, i) => [
            `#${i + 1}`,
            s.supplierName,
            money(s.priceMinor),
            days(s.durationDays),
            s.priceScore.toFixed(3),
            s.programmeScore.toFixed(3),
            s.riskScore.toFixed(3),
            html`<b style="color:${raw(i === 0 ? 'var(--orange)' : 'inherit')}">${s.totalScore.toFixed(4)}</b>`,
            s.flags.length === 0 ? badge('clean', 'ok') : html`${s.flags.map((f) => badge(humanise(f), f === 'INSURANCE_GAPS' ? 'bad' : 'warn'))}`,
            s.blockedFromAward ? badge('BLOCKED', 'bad') : badge('eligible', 'ok'),
          ]),
          empty: 'No evaluation has been run',
        })}
      </div>

      <div class="grid g2" style="margin-bottom:14px">
        <div class="card">
          <h3>Award conditions</h3>
          ${
            winner
              ? html`<p style="font-size:13px;color:var(--text-2);margin-bottom:12px">${evaluation.recommendation}</p>
                  ${
                    winner.conditions.length === 0
                      ? badge('No conditions attached', 'ok')
                      : html`<div class="split-list">${winner.conditions.map((c) => html`<div class="row"><span class="lbl">${c}</span></div>`)}</div>`
                  }`
              : html`<div class="empty"><b>No recommendation</b>Run an evaluation to produce one.</div>`
          }
        </div>

        <div class="card">
          <h3>Adjudication</h3>
          ${
            adjudication
              ? html`<div class="split-list">
                    <div class="row"><span class="lbl">Selected</span><span class="val">${winner?.supplierName ?? '—'}</span></div>
                    <div class="row"><span class="lbl">Buyout target</span><span class="val">${money(adjudication.buyoutTargetMinor)}</span></div>
                    <div class="row"><span class="lbl">Deviated from recommendation</span><span class="val">${adjudication.deviatedFromRecommendation ? badge('YES', 'warn') : badge('no', 'ok')}</span></div>
                    <div class="row"><span class="lbl">Adjudicated</span><span class="val">${date(adjudication.adjudicatedAt)}</span></div>
                  </div>
                  <p style="font-size:12.5px;color:var(--text-3);margin-top:11px">${adjudication.rationale}</p>`
              : html`<div class="empty"><b>Not adjudicated</b>The commercial decision has not been recorded.</div>`
          }
        </div>
      </div>

      <div class="grid g2">
        <div class="card">
          <h3>Tender package completeness</h3>
          ${
            pack
              ? html`<div class="metric ${raw(pack.completenessScore === 1 ? 'good' : 'warn')}">${pct(pack.completenessScore * 100, 0)}</div>
                  <div class="metric-sub" style="margin-bottom:11px">An incomplete package produces incomparable returns, so it cannot be issued.</div>
                  ${
                    (pack.missingComponents ?? []).length === 0
                      ? badge('Every component present', 'ok')
                      : html`<div class="split-list">${pack.missingComponents.map((m) => html`<div class="row"><span class="lbl">${m}</span>${badge('missing', 'bad')}</div>`)}</div>`
                  }`
              : html`<div class="empty"><b>No package composed</b></div>`
          }
        </div>

        <div class="card">
          <h3>Subcontract — what carried forward</h3>
          ${
            subcontract
              ? html`<div class="split-list">
                    <div class="row"><span class="lbl">Tendered value</span><span class="val">${money(subcontract.tenderedValueMinor)}</span></div>
                    <div class="row"><span class="lbl">Negotiated value</span><span class="val">${money(subcontract.valueMinor)}</span></div>
                    <div class="row"><span class="lbl">Carried exclusions</span><span class="val">${(subcontract.carriedExclusions ?? []).length}</span></div>
                    <div class="row"><span class="lbl">Carried exceptions</span><span class="val">${(subcontract.carriedExceptions ?? []).length}</span></div>
                  </div>
                  <div class="metric-sub" style="margin-top:10px">
                    Exclusions define what was <i>not</i> priced. They travel into the subcontract, or the scope gap reappears later as a variation.
                  </div>`
              : html`<div class="empty"><b>No subcontract</b></div>`
          }
        </div>
      </div>
    `,
  );
}

function badgeText(status) {
  return String(status ?? '').toLowerCase();
}
