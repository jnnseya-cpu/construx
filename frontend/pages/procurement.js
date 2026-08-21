import { api, entityBundle, isWithheld } from '../lib/api.js';
import { command, commandBar } from '../lib/command.js';
import { CONTRACT_FORM, PRICING_BASIS, today } from '../lib/enums.js';
import { badge, date, days, exact, html, humanise, money, pct, raw, render, statusTone, table } from '../lib/ui.js';
import { blockedReason, can, draw, state } from '../app.js';

/**
 * Tender & Procurement.
 *
 * The screen where an award has to be defensible. Bid scores are deterministic,
 * so the ranking shown here can be recomputed by hand from the same submissions
 * and the same penalty profile — which is what a challenged award requires.
 */

export async function procurement(root) {
  const projectId = state.session.projectId;

  // The supplier register, for the invite list. createRFQ refuses an enquiry
  // containing anyone unprequalified — the whole enquiry, not the ineligible
  // firms — so offering a free-text field here would produce a refusal the
  // person could not have predicted.
  // Only the eligible ones, which is what this endpoint returns by default.
  const suppliers = await api.get('/v1/supply-chain').catch(() => ({ suppliers: [] }));

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
    'FundingModel',
    'MasterPricing',
  ]);

  const rfq = b.RFQ.at(-1);
  const evaluation = b.BidEvaluation.at(-1);
  const adjudication = b.Adjudication.at(-1);
  const subcontract = b.Subcontract.at(-1);
  const estimate = b.Estimate.at(-1);
  const funding = b.FundingModel.at(-1);
  const maturity = b.DesignMaturityAssessment.at(-1);
  const pack = b.TenderPackage.at(-1);

  // Stage six: both routes converge and the sum that goes out is assembled.
  // The arithmetic is trivial; what matters is scope priced by nobody, which is
  // invisible in a spreadsheet that sums what is there.
  const master = b.MasterPricing.at(-1);

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
        <div class="actions cmd-bar">
          ${raw(commandBar([
            { id: 'rfq', label: 'Raise RFQ', tone: '', permitted: can('PROCUREMENT_AWARD', 'C'), reason: blockedReason('PROCUREMENT_AWARD', 'C') },
            { id: 'issue', label: 'Issue RFQ', permitted: can('PROCUREMENT_AWARD', 'U'), reason: blockedReason('PROCUREMENT_AWARD', 'U') },
            { id: 'submission', label: 'Record submission', permitted: can('SUPPLIER_SUBMISSION', 'C'), reason: blockedReason('SUPPLIER_SUBMISSION', 'C') },
            { id: 'award', label: 'Award', permitted: can('PROCUREMENT_AWARD', 'A'), reason: blockedReason('PROCUREMENT_AWARD', 'A') },
          ]))}
        </div>
      </div>

      ${
        master
          ? html`<div class="card pad0" style="margin-bottom:14px">
              <h3 style="padding:15px 17px 0">Master pricing — the number that goes out</h3>
              <div style="padding:0 17px"><div class="metric-sub">
                Each package is carried from its assigned route: bought packages at what a supplier agreed to do the work
                for, kept packages at the estimate. Which figure counts is decided by the route, never by which number is
                larger — carrying an estimate for work that went to market puts a price in the bid nobody has agreed to.
              </div></div>
              <div class="grid g4" style="padding:13px 17px 4px">
                <div><div class="metric orange">${money(master.totalMinor)}</div><div class="metric-sub">consolidated tender sum</div></div>
                <div><div class="metric">${money(master.marketPricedMinor)}</div><div class="metric-sub">bought — agreed by a supplier</div></div>
                <div><div class="metric">${money(master.selfPricedMinor)}</div><div class="metric-sub">self-performed — our own estimate</div></div>
                <div><div class="metric ${raw(master.unpricedPackages > 0 ? 'bad' : 'good')}">${master.unpricedPackages}</div><div class="metric-sub">packages carrying no price</div></div>
              </div>
              ${
                master.provisionalSumsMinor > 0
                  ? html`<div style="padding:4px 17px 0"><div class="notice warn">
                      <div><b>${money(master.provisionalSumsMinor)} of the total is provisional sum, not firm price.</b><br>
                      Inside the figure above rather than additional to it. It is expended against actual cost, so a tender
                      total that treats it as fixed understates the risk being taken.</div>
                    </div></div>`
                  : ''
              }
              ${table({
                headers: ['Package', 'Route', 'Priced from', 'Supplier', 'Carried'],
                align: ['', '', '', '', 'num'],
                rows: (master.lines ?? []).map((l) => [
                  l.packageName,
                  l.route ? badge(humanise(l.route), 'neutral') : badge('unrouted', 'bad'),
                  l.source === 'NONE' ? badge('nothing', 'bad') : badge(humanise(l.source), 'ok'),
                  l.supplier ?? '—',
                  l.amountMinor > 0 ? money(l.amountMinor) : '—',
                ]),
              })}
              ${(master.findings ?? [])
                .filter((f) => f.severity !== 'INFO')
                .map(
                  (f) => html`<div style="padding:0 17px 9px"><div class="notice ${raw(f.severity === 'CRITICAL' ? 'err' : 'warn')}">
                    <div><b>${f.packageName} — ${humanise(f.kind)}</b>${f.amountMinor ? html` · ${money(f.amountMinor)}` : ''}<br>
                    ${f.finding}<br>
                    <span style="color:var(--text-3)">${f.consequence}</span></div>
                  </div></div>`,
                )}
              <div style="padding:4px 17px 15px"><div class="metric-sub">${master.summary}</div></div>
            </div>`
          : ''
      }

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

      ${
        funding
          ? html`
            <div class="card pad0" style="margin-bottom:14px">
              <h3 style="padding:15px 17px 0">
                Cash flow — peak funding requirement
                ${badge(humanise(funding.verdict), funding.verdict === 'FUNDABLE' ? 'ok' : funding.verdict === 'TIGHT' ? 'warn' : 'bad')}
              </h3>
              <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
                The margin is a statement about cost. This is a statement about cash, and it is the one that closes
                companies — a contract can cover its cost, carry a healthy margin, and still take more working capital
                than the business has.
              </p>
              <div class="grid g4" style="padding:13px 17px 0">
                <div>
                  <div class="metric ${raw(funding.verdict === 'FUNDABLE' ? 'good' : funding.verdict === 'TIGHT' ? 'warn' : 'bad')}">${money(funding.peakFundingRequirementMinor)}</div>
                  <div class="metric-sub">Peak funding at week ${funding.peakWeek}, ${funding.weeksNegative} weeks cash-negative.</div>
                </div>
                <div>
                  <div class="metric">${money(funding.marginMinor)}</div>
                  <div class="metric-sub">Margin, ${pct(funding.marginPercent, 1)} of contract value.</div>
                </div>
                <div>
                  <div class="metric ${raw(funding.returnOnPeakFunding >= 1 ? 'good' : 'warn')}">${funding.returnOnPeakFunding}×</div>
                  <div class="metric-sub">Profit per pound of peak funding. Below 1 means putting in more than it returns.</div>
                </div>
                <div>
                  <div class="metric">${money(funding.retentionHeldMinor)}</div>
                  <div class="metric-sub">Retention held, last half back at week ${funding.finalRetentionWeek}.</div>
                </div>
              </div>
              ${
                (funding.remedies ?? []).length > 0
                  ? html`${table({
                      headers: ['What would change it', 'Peak becomes', 'Saves'],
                      align: ['', 'num', 'num'],
                      rows: funding.remedies.map((r) => [r.change, money(r.peakWouldBecomeMinor), money(r.improvementMinor)]),
                    })}`
                  : ''
              }
              ${
                (funding.warnings ?? []).length > 0
                  ? html`<div class="split-list" style="padding:11px 17px 15px">
                      ${funding.warnings.map((w) => html`<div class="row"><span class="lbl">${w}</span></div>`)}
                    </div>`
                  : '<div style="height:15px"></div>'
              }
            </div>`
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

  /**
   * The four transitions that move a package from enquiry to award.
   *
   * Every option list is drawn from records that exist — packages from the
   * scope, suppliers from the register, submissions from what came back. A
   * picker offering something the command will reject looks authoritative and
   * is worse than a free-text box.
   */
  const COMMANDS = {
    rfq: {
      title: 'Raise an RFQ',
      intent:
        'Design maturity is checked before the enquiry goes out, and every invited firm must be on the register and currently prequalified. ' +
        'An ineligible firm refuses the whole enquiry rather than being dropped from it.',
      path: `/v1/projects/${projectId}/procurement/rfq`,
      submitLabel: 'Raise',
      fields: [
        { name: 'packageId', label: 'Package', type: 'select',
          options: b.ScopePackage.map((p) => ({ value: p._refId, label: `${p.name} · ${p.discipline}` })) },
        { name: 'title', label: 'Enquiry title', type: 'text' },
        { name: 'pricingBasis', label: 'Pricing basis', type: 'select', options: PRICING_BASIS,
          hint: 'Two submissions on different bases are not comparable, which is how an award gets challenged.' },
        { name: 'contractSuite', label: 'Form of contract', type: 'select', options: CONTRACT_FORM },
        { name: 'returnDeadline', label: 'Returns by', type: 'date', min: today() },
        { name: 'trade', label: 'Trade', type: 'text', required: false,
          hint: 'Checked against each invited firm\u2019s assessed trades' },
        { name: 'packageValueMinor', label: 'Package value', type: 'number', money: true, required: false,
          hint: 'Nobody is invited beyond their assessed capacity' },
        { name: 'invited', label: 'Invite', type: 'select',
          options: (suppliers.suppliers ?? []).map((sup) => ({ value: sup.id, label: sup.name })) },
        { name: 'requiredInsurances', label: 'Required insurances', type: 'text',
          placeholder: 'Public liability, Employers liability', hint: 'Comma separated' },
      ],
      transform: (v) => ({
        packageId: v.packageId,
        title: v.title,
        pricingBasis: v.pricingBasis,
        contractSuite: v.contractSuite,
        returnDeadline: v.returnDeadline,
        trade: v.trade,
        packageValueMinor: v.packageValueMinor,
        invitedSupplierIds: [v.invited],
        requiredInsurances: String(v.requiredInsurances ?? '').split(',').map((x) => x.trim()).filter(Boolean),
      }),
    },
    issue: {
      title: 'Issue the enquiry',
      intent: 'Sends the RFQ to the invited firms against a tender package. The issue is the event the return deadline runs from.',
      path: (collected) => `/v1/projects/${projectId}/procurement/rfq/${collected.rfqId}/issue`,
      submitLabel: 'Issue',
      fields: [
        { name: 'rfqId', label: 'RFQ', type: 'select',
          options: b.RFQ.map((r) => ({ value: r._refId, label: `${r.reference} · ${r.title}` })) },
        { name: 'tenderPackageId', label: 'Tender package', type: 'select',
          options: b.TenderPackage.map((p) => ({ value: p._refId, label: p.reference ?? p._refId })) },
      ],
      transform: ({ rfqId, ...rest }) => rest,
    },
    submission: {
      title: 'Record a submission',
      intent:
        'What the firm actually offered, including what it excluded. Exclusions define what was not priced and carry into the subcontract \u2014 ' +
        'scope excluded here and not carried reappears later as a variation.',
      path: (collected) => `/v1/projects/${projectId}/procurement/rfq/${collected.rfqId}/submissions`,
      submitLabel: 'Record',
      fields: [
        { name: 'rfqId', label: 'Against RFQ', type: 'select',
          options: b.RFQ.map((r) => ({ value: r._refId, label: `${r.reference} · ${r.title}` })) },
        { name: 'supplierPartyId', label: 'Supplier', type: 'select',
          options: (suppliers.suppliers ?? []).map((sup) => ({ value: sup.id, label: sup.name })) },
        { name: 'supplierName', label: 'Supplier name', type: 'text' },
        { name: 'priceMinor', label: 'Price', type: 'number', money: true },
        { name: 'durationDays', label: 'Duration (days)', type: 'number', min: 1 },
        { name: 'provisionalSumsMinor', label: 'Provisional sums', type: 'number', money: true },
        { name: 'peakLabour', label: 'Peak labour', type: 'number', required: false },
        { name: 'exclusions', label: 'Exclusions', type: 'textarea', rows: 2, required: false, hint: 'One per line' },
        { name: 'contractExceptions', label: 'Contract exceptions', type: 'textarea', rows: 2, required: false, hint: 'One per line' },
        { name: 'insurancesHeld', label: 'Insurances held', type: 'text', hint: 'Comma separated' },
        { name: 'submissionHash', label: 'Submission document', type: 'file' },
      ],
      transform: ({ rfqId, exclusions, contractExceptions, insurancesHeld, ...rest }) => ({
        ...rest,
        exclusions: String(exclusions ?? '').split('\n').map((x) => x.trim()).filter(Boolean),
        contractExceptions: String(contractExceptions ?? '').split('\n').map((x) => x.trim()).filter(Boolean),
        insurancesHeld: String(insurancesHeld ?? '').split(',').map((x) => x.trim()).filter(Boolean),
      }),
    },
    award: {
      title: 'Award the package',
      intent:
        'The award is made against an adjudication, not against a price. The governance reference is what an auditor asks for first, ' +
        'and any condition attached to the approval is recorded with it.',
      path: (collected) => `/v1/projects/${projectId}/procurement/rfq/${collected.rfqId}/award`,
      submitLabel: 'Award',
      fields: [
        { name: 'rfqId', label: 'RFQ', type: 'select',
          options: b.RFQ.map((r) => ({ value: r._refId, label: `${r.reference} · ${r.title}` })) },
        { name: 'adjudicationId', label: 'Adjudication', type: 'select',
          options: b.Adjudication.map((a) => ({ value: a._refId, label: `${a.reference ?? a._refId}` })) },
        { name: 'governanceApprovalRef', label: 'Governance approval reference', type: 'text',
          hint: 'The board or delegated authority decision this award is made under' },
        { name: 'conditions', label: 'Conditions', type: 'textarea', rows: 2, required: false, hint: 'One per line' },
      ],
      transform: ({ rfqId, conditions, ...rest }) => ({
        ...rest,
        conditions: String(conditions ?? '').split('\n').map((x) => x.trim()).filter(Boolean),
      }),
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

function badgeText(status) {
  return String(status ?? '').toLowerCase();
}
