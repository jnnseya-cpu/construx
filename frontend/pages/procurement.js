import { api, entityBundle, isWithheld } from '../lib/api.js';
import { barChart, boxPlot, funnelChart, ganttChart, radarChart, scatterPlot } from '../lib/charts.js';
import { command, commandBar } from '../lib/command.js';
import { CONTRACT_FORM, PRICING_BASIS, today } from '../lib/enums.js';
import { badge, date, days, drillable, exact, html, humanise, money, pct, positionReport, raw, render, resolveHtml, statusTone, table } from '../lib/ui.js';
import { lookupPanel, wireLookups } from '../lib/lookup.js';
import { insightPanel } from '../lib/insight.js';
import { supplierPaymentCard } from '../lib/siteportal.js';
import { blockedReason, can, draw, state } from '../app.js';

/**
 * Tender & Procurement.
 *
 * The screen where an award has to be defensible. Bid scores are deterministic,
 * so the ranking shown here can be recomputed by hand from the same submissions
 * and the same penalty profile — which is what a challenged award requires.
 */

/*
 * The run, and what it found.
 *
 * Held here rather than in `state` because it belongs to this screen and to one
 * sitting at it: a proposal is not platform state, nothing is recorded until it
 * is accepted, and reloading the page should lose it rather than resurrect a
 * price nobody remembers asking for. `#view` is rebuilt on every draw, so the
 * panel below reads this on the way past.
 */
let packRun = null;

/**
 * Price the whole pack, from the files already filed.
 *
 * The complaint this answers, in the words it was made in: nobody will use a
 * construction OS that makes them type what the platform has already read. Four
 * screens and forty fields for a £20,000 wall repair is not a tool anybody
 * chooses, whatever each screen does correctly on its own.
 *
 * So the run reads every drawing, measures it, and proposes a rate for each
 * measured line out of this business's own committed estimates — and then
 * stops, with everything on one screen, for one person to accept. That last
 * part is not hesitancy about automation. Every quantity came out of a model
 * and every rate came out of history, and both are wrong sometimes; a quotation
 * that reached a customer at rates nobody looked at would make the platform's
 * central claim false.
 */
function packRunPanel({ available, drawingsHeld, blocked }) {
  const proposal = packRun;
  return html`<div class="card pad0" style="margin-bottom:14px">
    <div style="padding:15px 17px">
      <h2>Price the pack</h2>
      <p class="metric-sub" style="margin-bottom:11px">
        One run, from the drawings already filed: every sheet read and measured, every measured line priced against
        the rates this business has actually committed on its own past estimates, and the site-wide heads and margin
        taken from your last complete estimate. It writes the readings — a reading is evidence either way — and
        nothing else. No bill, no estimate and no quotation exists until you accept, which is one decision instead of
        forty fields.
      </p>
      <div class="metric-sub" style="margin-bottom:11px">
        ${drawingsHeld} drawing${drawingsHeld === 1 ? '' : 's'} filed on this project.
      </div>
      <div class="actions">
        ${raw(
          commandBar([
            {
              id: 'price-pack',
              label: 'Read and price the pack',
              tone: 'primary',
              permitted: can('BOQ_TAKEOFF', 'C') && available && drawingsHeld > 0,
              reason:
                drawingsHeld === 0
                  ? 'No file on this project is classified as a drawing. File the pack first — the run measures what it can see.'
                  : !available
                    ? 'This deployment has no model that can be shown a drawing, so nothing can be measured off one.'
                    : blocked ?? blockedReason('BOQ_TAKEOFF', 'C'),
            },
          ]),
        )}
      </div>

      ${
        proposal
          ? html`
            <div style="margin-top:14px;border-top:1px solid var(--line);padding-top:13px">
              <h2>What the run found</h2>
              <div class="grid g4" style="margin:9px 0 12px">
                <div>
                  <div class="metric">${proposal.read.length}</div>
                  <div class="metric-sub">sheets read${proposal.unread.length > 0 ? `, ${proposal.unread.length} not` : ''}</div>
                </div>
                <div>
                  <div class="metric">${proposal.lines.length}</div>
                  <div class="metric-sub">measured lines</div>
                </div>
                <div>
                  <div class="metric ${raw(proposal.lines.every((line) => line.rate) ? 'good' : 'warn')}">
                    ${proposal.lines.filter((line) => line.rate).length}
                  </div>
                  <div class="metric-sub">priced from our own record</div>
                </div>
                <div>
                  <div class="metric orange">${proposal.indicative ? money(proposal.indicative.totalMinor) : '—'}</div>
                  <div class="metric-sub">
                    ${proposal.indicative ? 'on these rates and your last basis' : 'nothing to price it on yet'}
                  </div>
                </div>
              </div>

              ${table({
                headers: ['Description', 'Unit', 'Quantity', 'Sheet', 'Rate', 'Where the rate came from'],
                align: ['', '', 'num', '', 'num', ''],
                rows: proposal.lines.map((line) => [
                  line.description,
                  line.unit,
                  Number(line.quantity).toLocaleString('en-GB'),
                  line.sourceSheet ?? '—',
                  line.rate ? money(line.rate.allInMinor) : badge('none', 'warn'),
                  line.rate
                    ? html`<span style="font-size:12px;color:var(--text-3)">${line.rate.basis}</span>`
                    : html`<span style="font-size:12px;color:var(--text-3)">${line.unpriced}</span>`,
                ]),
              })}

              ${
                proposal.unread.length > 0
                  ? html`<div class="notice warn" style="margin-top:11px"><div>
                      <b>${proposal.unread.length} file${proposal.unread.length === 1 ? '' : 's'} could not be read</b>,
                      so anything on ${proposal.unread.length === 1 ? 'it' : 'them'} is not in this price.
                      <div class="split-list" style="margin-top:7px">
                        ${proposal.unread.map((file) => html`<div class="row"><span class="lbl">${file.filename}</span><span class="val">${file.reason}</span></div>`)}
                      </div>
                    </div></div>`
                  : ''
              }

              ${
                proposal.outstanding.length > 0
                  ? html`<div class="notice" style="margin-top:11px"><div>
                      <b>Still yours to decide.</b>
                      <div class="split-list" style="margin-top:7px">
                        ${proposal.outstanding.map((item) => html`<div class="row"><span class="lbl">${item}</span></div>`)}
                      </div>
                    </div></div>`
                  : ''
              }

              <div class="actions" style="margin-top:12px">
                ${raw(
                  commandBar([
                    {
                      id: 'accept-pack',
                      label: 'Accept — write the bill, price it and draw the quotation',
                      tone: 'primary',
                      permitted: can('ESTIMATE_TENDER', 'C') && can('EVIDENCE_AUDIT', 'I') && proposal.lines.length > 0,
                      reason:
                        proposal.lines.length === 0
                          ? 'The run measured nothing, so there is nothing to accept.'
                          : blockedReason('ESTIMATE_TENDER', 'C') ?? blockedReason('EVIDENCE_AUDIT', 'I'),
                    },
                  ]),
                )}
              </div>
            </div>`
          : ''
      }
    </div>
  </div>`;
}

export async function procurement(root) {
  const projectId = state.session.projectId;

  // The supplier register, for the invite list. createRFQ refuses an enquiry
  // containing anyone unprequalified — the whole enquiry, not the ineligible
  // firms — so offering a free-text field here would produce a refusal the
  // person could not have predicted.
  // Only the eligible ones, which is what this endpoint returns by default.
  const suppliers = await api.read('/v1/supply-chain', 'PROCUREMENT_AWARD').catch(() => ({ suppliers: [] }));

  // The tenancy-level procurement intelligence, and the project's own tender
  // position. Seven engines with no screen: the twenty cost heads a tender is
  // built on, the price history to check it against, the trade catalogue, where
  // coverage is too thin to compete, the frameworks already held, what a tender
  // review found, and what has actually converted.
  const [costHeads, costIntel, trades, coverage, frameworks, reviews, awards, units, calibration, lessons, boq, ingestion, perception] = await Promise.all([
    api.get('/v1/tender/cost-heads').catch((error) => ({ error })),
    api.read('/v1/cost-intelligence', 'ESTIMATE_TENDER').catch((error) => ({ error })),
    api.get('/v1/supply-chain/trades').catch((error) => ({ error })),
    api.read('/v1/supply-chain/coverage', 'PROCUREMENT_AWARD').catch((error) => ({ error })),
    api.read('/v1/frameworks', 'PROCUREMENT_AWARD').catch((error) => ({ error })),
    api.read(`/v1/projects/${projectId}/tender-reviews`, 'ESTIMATE_TENDER').catch((error) => ({ error })),
    api.read(`/v1/projects/${projectId}/awards`, 'PROCUREMENT_AWARD', 'COMMERCIAL_L3').catch((error) => ({ error })),
    // The units the engine reads, fetched rather than restated. A hint listing
    // units the browser believes in is a second list, and the one that drifts is
    // always the one nobody tests — a form offering a unit the engine cannot
    // read produces a quantity nothing can check.
    api.get('/v1/units').catch((error) => ({ error })),
    // What the record has learned about how this business bids, and which of
    // those corrections somebody has actually promoted. Loaded beside the price
    // history because a promoted lesson is what corrects it.
    api.read('/v1/calibration', 'ESTIMATE_TENDER', 'COMMERCIAL_L3').catch((error) => ({ error })),
    api.read('/v1/calibration/lessons', 'ESTIMATE_TENDER', 'COMMERCIAL_L3').catch((error) => ({ error })),
    // What has actually been measured on this project. The bridge from a
    // take-off to an estimate: `buildEstimate` prices `lines`, each carrying a
    // `boqItemId`, and until this was readable the only way to price a measured
    // job was to retype every quantity into a form.
    api.read(`/v1/projects/${projectId}/tender/boq`, 'BOQ_TAKEOFF').catch((error) => ({ error })),
    // What the run has to work with: the files already filed, and whether this
    // deployment has a model that can be shown a drawing. Both are reads the
    // panel needs before it can honestly offer or refuse the run.
    api.get(`/v1/projects/${projectId}/ingestion`).catch(() => null),
    api.get(`/v1/projects/${projectId}/perception`).catch(() => null),
  ]);

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

  // T-WF-06. The clarification register and every return comparison, with the
  // confidence in each. Read through its own endpoint rather than the entity
  // bundle because the completeness and the carried risk are derived server-side
  // — the browser holds no rule the API does not publish.
  const intel = await api
    .read(`/v1/projects/${projectId}/tender-intelligence`, 'PROCUREMENT_AWARD', 'COMMERCIAL_L3')
    .catch(() => ({ clarifications: [], comparisons: [], summary: '' }));

  // A command whose only select would be empty is locked with the reason rather
  // than offered — an empty required dropdown is a dead end the person cannot
  // diagnose, and a lock that says why is the same affordance the permission
  // matrix already uses.
  // T-WF-03. The measured items under the estimate, and what stops each
  // schedule freezing.
  const bill = await api
    .read(`/v1/projects/${projectId}/measurement`, 'BOQ_TAKEOFF')
    .catch(() => ({ schedules: [], summary: '' }));
  const openSchedules = bill.schedules.filter((s) => s.status === 'OPEN');

  // T-WF-04. Which revision of the pack each firm actually holds.
  const enquiries = await api
    .read(`/v1/projects/${projectId}/enquiries`, 'PROCUREMENT_AWARD', 'COMMERCIAL_L3')
    .catch(() => ({ enquiries: [], summary: '' }));
  const liveEnquiries = enquiries.enquiries.filter((e) => e.status !== 'CLOSED');
  const closedEnquiries = enquiries.enquiries.filter((e) => e.status === 'CLOSED');

  const openComparisons = intel.comparisons.filter((c) => c.status === 'OPEN');

  // T-WF-05. Buy it or do it, per package.
  const routes = await api
    .read(`/v1/projects/${projectId}/pricing-routes`, 'ESTIMATE_TENDER')
    .catch(() => ({ routes: [], summary: '' }));
  const openRoutes = routes.routes.filter((r) => r.status === 'OPEN');
  const unanswered = intel.clarifications.filter((c) => c.status === 'OPEN');

  // Five reads that cannot answer until somebody chooses what to ask about.
  // Every option comes from a record this page already holds, so the chooser
  // can never offer an id the platform does not have.
  const LOOKUPS = [
    {
      id: 'framework',
      title: 'Framework position',
      intent: 'Membership balance, thin lots, concentration and expiry, for one framework.',
      empty: 'This tenancy holds no framework agreement to look into.',
      inputs: [
        {
          name: 'frameworkId',
          label: 'Framework',
          options: ((frameworks?.frameworks) ?? []).map((f) => ({
            value: f.frameworkId ?? f.id,
            label: f.name ?? f.reference ?? f.frameworkId ?? f.id,
          })),
        },
      ],
      path: (v) => `/v1/frameworks/${v.frameworkId}`,
      sections: [
        { key: 'lots', label: 'Lots', empty: 'This framework has no lots.' },
        { key: 'thin', label: 'Thin lots', empty: 'No lot is too thin to call off from.' },
        { key: 'concentration', label: 'Concentration', empty: 'No supplier is over-represented.' },
        { key: 'expiring', label: 'Expiring', empty: 'Nothing is close to expiry.' },
      ],
    },
    {
      id: 'benchmark',
      title: 'Benchmark an estimate',
      intent:
        'Compare one estimate against the business\u2019s own committed price history. A benchmark against a bought ' +
        'index tells you about the market; this tells you about you.',
      empty: 'No estimate has been produced on this project yet.',
      inputs: [
        {
          name: 'estimateId',
          label: 'Estimate',
          options: b.Estimate.map((e) => ({
            value: e._refId,
            label: `${e.reference ?? e._refId} ${e.revision ? `rev ${e.revision}` : ''}`.trim(),
          })),
        },
      ],
      path: (v) => `/v1/projects/${projectId}/tender/estimate/${v.estimateId}/benchmark`,
      sections: [
        // The keys the response actually carries. `calibrated` is every line
        // with its median corrected by a promoted estimating-bias lesson, and
        // `note` says which lesson did it or that none is promoted.
        { key: 'calibrated', label: 'Against our own history, corrected', empty: 'No line has enough history to compare against.' },
        { key: 'note', label: 'What the correction is' },
        { key: 'warnings', label: 'Warnings', empty: 'Nothing to flag.' },
      ],
    },
    {
      id: 'uncertainty',
      title: 'How firm is the quantity',
      intent:
        'How much of the direct cost sits on a quantity that is not firm, and which lines. A price built on ' +
        'provisional quantities is a price with a range, and the range is the thing worth knowing.',
      empty: 'No measurement schedule exists to assess.',
      inputs: [
        {
          name: 'scheduleId',
          label: 'Schedule',
          options: (bill.schedules ?? []).map((sch) => ({
            value: sch.scheduleId,
            label: `${sch.reference} \u00b7 ${sch.title}`,
          })),
        },
      ],
      path: (v) => `/v1/projects/${projectId}/measurement/${v.scheduleId}/uncertainty`,
      sections: [
        { key: 'lines', label: 'Lines on an unfirm quantity', empty: 'Every quantity on this schedule is firm.' },
      ],
    },
    {
      id: 'lineage',
      title: 'Why is this number',
      intent:
        'The chain behind one priced line, in the order the arithmetic ran: the drawing at its revision, the formula, ' +
        'every rate component with its cost and its productivity constant, the waste on a material, and who froze the ' +
        'schedule. Nothing here is stored — it is rebuilt from the record each time, so it cannot be stale and cannot ' +
        'disagree with the bill it projects.',
      empty: 'No measurement schedule exists to trace.',
      inputs: [
        {
          name: 'scheduleId',
          label: 'Schedule',
          options: (bill.schedules ?? []).map((sch) => ({ value: sch.scheduleId, label: `${sch.reference} \u00b7 ${sch.title}` })),
        },
        { name: 'itemReference', label: 'Item reference', type: 'text' },
      ],
      path: (v) => `/v1/projects/${projectId}/measurement/${v.scheduleId}/lineage/${encodeURIComponent(v.itemReference)}`,
      sections: [
        { key: 'nodes', label: 'The chain', empty: 'Nothing stands behind this figure.' },
        // Named rather than left blank. A chain that cannot answer something is
        // a figure somebody will have to explain from memory.
        { key: 'gaps', label: 'What the chain cannot answer', empty: 'Every step of this figure is traced.' },
      ],
    },
    {
      id: 'lineagesweep',
      title: 'Which numbers cannot be defended',
      intent:
        'The same question asked of the whole schedule, so the lines nobody can explain are one read rather than one ' +
        'read per line.',
      empty: 'No measurement schedule exists to trace.',
      inputs: [
        {
          name: 'scheduleId',
          label: 'Schedule',
          options: (bill.schedules ?? []).map((sch) => ({ value: sch.scheduleId, label: `${sch.reference} \u00b7 ${sch.title}` })),
        },
      ],
      path: (v) => `/v1/projects/${projectId}/measurement/${v.scheduleId}/lineage`,
      sections: [
        { key: 'lines', label: 'Every line, and how deeply it is traced', empty: 'This schedule carries no items.' },
        { key: 'incomplete', label: 'Chains with something missing', empty: 'Every line on this schedule is fully traced.' },
      ],
    },
    {
      id: 'reconciliation',
      title: 'Where the money went between two schedules',
      intent: 'Item by item, so a movement in a total can be attributed rather than argued about.',
      empty: 'Two schedules are needed to reconcile, and this project does not have them.',
      inputs: [
        {
          name: 'scheduleId',
          label: 'Schedule',
          options: (bill.schedules ?? []).map((sch) => ({ value: sch.scheduleId, label: `${sch.reference} \u00b7 ${sch.title}` })),
        },
        {
          name: 'againstId',
          label: 'Against',
          options: (bill.schedules ?? []).map((sch) => ({ value: sch.scheduleId, label: `${sch.reference} \u00b7 ${sch.title}` })),
        },
      ],
      path: (v) => `/v1/projects/${projectId}/measurement/${v.scheduleId}/reconciliation/${v.againstId}`,
      sections: [{ key: 'items', label: 'Movements', empty: 'Nothing moved between these two schedules.' }],
    },
    {
      id: 'bidderview',
      title: 'What one firm can see',
      intent:
        'Its own pack revision and nothing about the field. Worth checking before an enquiry goes out, because a ' +
        'bidder who can see the field is a tender that cannot be defended.',
      empty: 'No enquiry is live, so there is no bidder view to check.',
      inputs: [
        {
          name: 'enquiryId',
          label: 'Enquiry',
          options: liveEnquiries.map((e) => ({ value: e.enquiryId, label: `${e.reference} \u00b7 ${e.title}` })),
        },
        { name: 'partyId', label: 'Firm', type: 'text', placeholder: 'The party id of one bidder' },
      ],
      path: (v) => `/v1/projects/${projectId}/enquiries/${v.enquiryId}/bidder/${v.partyId}`,
      sections: [
        { key: 'pack', label: 'The pack this firm holds', empty: 'This firm has been issued nothing.' },
        { key: 'clarifications', label: 'Clarifications it can see', empty: 'Nothing has been clarified to this firm.' },
      ],
    },
  ];

  const NO_OPEN_COMPARISON = 'No comparison is open — open one, or the last was closed for adjudication';
  const NO_OPEN_SCHEDULE = 'No measurement schedule is open — open one, or the last was frozen';
  const NO_LIVE_ENQUIRY = 'No enquiry is live — open one, or the last closed for returns';
  const NO_OPEN_ROUTE = 'No package route is open — open one, or the last was selected';

  // Who was asked against who answered. Every fact was already on the record
  // and nothing stood them beside each other, which from a screen is
  // indistinguishable from not tracking bidders at all.
  const reconciliation = rfq
    ? await api.read(`/v1/projects/${projectId}/procurement/rfq/${rfq._refId}/reconciliation`, 'PROCUREMENT_AWARD', 'COMMERCIAL_L3').catch(() => null)
    : null;
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

  // The records behind each figure. Returns are withheld from some roles, and
  // where they are the tile names no sources rather than naming records the
  // reader cannot open — the drill would be a list of refused rows.
  const maturitySources = maturity ? [{ refType: 'DesignMaturityAssessment', refId: maturity._refId }] : [];
  const estimateSources = b.Estimate.map((e) => ({ refType: 'Estimate', refId: e._refId }));
  const returnSources = isWithheld('SupplierSubmission')
    ? []
    : b.SupplierSubmission.map((sub) => ({ refType: 'SupplierSubmission', refId: sub._refId }));
  const buyoutSources = [
    ...b.Subcontract.map((sc) => ({ refType: 'Subcontract', refId: sc._refId })),
    ...b.Adjudication.map((a) => ({ refType: 'Adjudication', refId: a._refId })),
  ];
  const cheapest = [...scores].sort((x, y) => x.priceMinor - y.priceMinor)[0];
  const cheapestIsNotWinner = cheapest && winner && cheapest.submissionId !== winner.submissionId;

  // A supplier's own portal, on the one screen a supplier identity reaches.
  // Resolved server-side to the firm the sign-in belongs to; the request names
  // no firm, and could not choose one. Absent for everybody else.
  const supplierSignIn = (state.session.user?.roles ?? []).includes('SUPPLIER');
  const portal = supplierSignIn
    ? await api.get(`/v1/projects/${projectId}/site-services/portal`).catch((error) => ({ error }))
    : null;

  /**
   * Who may act inside an issued enquiry, exactly as the server decides it.
   *
   * Acknowledging, asking and returning a price are conducted by the firm that
   * received the enquiry and by the buyer running the tender on behalf of a
   * bidder without a login. `authoriseAny` in `domain/procurement.ts` accepts
   * `SUPPLIER_SUBMISSION` "C" or `PROCUREMENT_AWARD` "U", so the console reads
   * the same either/or off the published matrix. Gating on the supplier area
   * alone showed a QS three permanently blocked buttons for commands the API
   * would have run — the browser holding a stricter rule than the server, which
   * is the drift `blockedReason` exists to prevent.
   *
   * Written as two `can` calls rather than one helper taking a list, so the
   * console-bindings invariant that scans literal areas at `can`/`blockedReason`
   * call sites still sees both of them.
   */
  const enquiryParticipant = can('SUPPLIER_SUBMISSION', 'C') || can('PROCUREMENT_AWARD', 'U');
  const enquiryParticipantReason = enquiryParticipant
    ? null
    : `${blockedReason('SUPPLIER_SUBMISSION', 'C')}; ${blockedReason('PROCUREMENT_AWARD', 'U')}`;

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
            // The enquiry's other half. Acknowledging, asking and returning a
            // price are conducted from both sides, so all three carry the
            // either/or the server enforces. Answering is the buyer's act alone
            // and is gated on the award area, which is what
            // `answerClarification` authorises against — and it is phase-gated
            // there, so it closes when procurement does.
            { id: 'acknowledge', label: 'Acknowledge enquiry', permitted: enquiryParticipant, reason: enquiryParticipantReason },
            { id: 'clarification', label: 'Raise clarification', permitted: enquiryParticipant, reason: enquiryParticipantReason },
            { id: 'answerclarification', label: 'Answer clarification', permitted: can('PROCUREMENT_AWARD', 'U'), reason: blockedReason('PROCUREMENT_AWARD', 'U') },
            { id: 'submission', label: 'Record submission', permitted: enquiryParticipant, reason: enquiryParticipantReason },
            { id: 'award', label: 'Award', permitted: can('PROCUREMENT_AWARD', 'A'), reason: blockedReason('PROCUREMENT_AWARD', 'A') },
            // The loop closing on the bid. Proposing and promoting are
            // deliberately different authorities, and the engine refuses a
            // promotion by whoever proposed it.
            { id: 'calibration-propose', label: 'Propose a calibration',
              permitted: can('ESTIMATE_TENDER', 'C') && (calibration?.signals ?? []).length > 0,
              reason: blockedReason('ESTIMATE_TENDER', 'C') ?? 'The record supports no signal yet — no bid has a recorded outcome' },
            { id: 'calibration-promote', label: 'Promote a calibration',
              permitted: can('ESTIMATE_TENDER', 'A') && (lessons?.counts?.PROPOSED ?? 0) > 0,
              reason: blockedReason('ESTIMATE_TENDER', 'A') ?? 'Nothing is awaiting a decision' },
            { id: 'calibration-reject', label: 'Refuse a calibration',
              permitted: can('ESTIMATE_TENDER', 'A') && (lessons?.counts?.PROPOSED ?? 0) > 0,
              reason: blockedReason('ESTIMATE_TENDER', 'A') ?? 'Nothing is awaiting a decision' },
            { id: 'calibration-retire', label: 'Retire a calibration',
              permitted: can('ESTIMATE_TENDER', 'A') && (lessons?.counts?.PROMOTED ?? 0) > 0,
              reason: blockedReason('ESTIMATE_TENDER', 'A') ?? 'Nothing is being applied' },
            { id: 'route', label: 'Buy it or do it', permitted: can('ESTIMATE_TENDER', 'C'), reason: blockedReason('ESTIMATE_TENDER', 'C') },
            { id: 'selfPerform', label: 'Price it ourselves',
              permitted: can('ESTIMATE_TENDER', 'U') && openRoutes.length > 0,
              reason: blockedReason('ESTIMATE_TENDER', 'U') ?? NO_OPEN_ROUTE },
            { id: 'evaluation', label: 'What the route costs us',
              permitted: can('ESTIMATE_TENDER', 'U') && openRoutes.length > 0,
              reason: blockedReason('ESTIMATE_TENDER', 'U') ?? NO_OPEN_ROUTE },
            { id: 'exclusion', label: 'Dispose of an exclusion',
              permitted: can('ESTIMATE_TENDER', 'U') && openRoutes.length > 0,
              reason: blockedReason('ESTIMATE_TENDER', 'U') ?? NO_OPEN_ROUTE },
            { id: 'interest', label: 'Declare an interest',
              permitted: can('ESTIMATE_TENDER', 'U') && openRoutes.length > 0,
              reason: blockedReason('ESTIMATE_TENDER', 'U') ?? NO_OPEN_ROUTE },
            { id: 'selectRoute', label: 'Choose the route',
              permitted: can('ESTIMATE_TENDER', 'A') && openRoutes.length > 0,
              reason: blockedReason('ESTIMATE_TENDER', 'A') ?? NO_OPEN_ROUTE },
            { id: 'enquiry', label: 'Open enquiry', permitted: can('PROCUREMENT_AWARD', 'C'), reason: blockedReason('PROCUREMENT_AWARD', 'C') },
            { id: 'packRevision', label: 'Compose pack revision',
              permitted: can('PROCUREMENT_AWARD', 'C') && liveEnquiries.length > 0,
              reason: blockedReason('PROCUREMENT_AWARD', 'C') ?? NO_LIVE_ENQUIRY },
            { id: 'approvePack', label: 'Approve the pack',
              permitted: can('PROCUREMENT_AWARD', 'A') && liveEnquiries.some((e) => !e.approved),
              reason: blockedReason('PROCUREMENT_AWARD', 'A') ?? 'Every composed revision has been approved' },
            { id: 'issueEnquiry', label: 'Issue to bidders',
              permitted: can('PROCUREMENT_AWARD', 'I') && liveEnquiries.some((e) => e.approved),
              reason: blockedReason('PROCUREMENT_AWARD', 'I') ?? 'No approved revision is waiting to go out' },
            { id: 'bidderState', label: 'Record a bidder response',
              permitted: can('PROCUREMENT_AWARD', 'U') && liveEnquiries.some((e) => e.issued > 0),
              reason: blockedReason('PROCUREMENT_AWARD', 'U') ?? 'Nothing has been issued to a bidder yet' },
            { id: 'revokeBidder', label: 'Remove a bidder',
              permitted: can('PROCUREMENT_AWARD', 'A') && enquiries.enquiries.some((e) => e.issued > 0),
              reason: blockedReason('PROCUREMENT_AWARD', 'A') ?? 'Nothing has been issued to a bidder yet' },
            { id: 'closeEnquiry', label: 'Close the return period',
              permitted: can('PROCUREMENT_AWARD', 'A') && liveEnquiries.some((e) => e.status === 'ISSUED'),
              reason: blockedReason('PROCUREMENT_AWARD', 'A') ?? 'No enquiry is out with bidders' },
            { id: 'lateReturn', label: 'Accept a late return',
              permitted: can('PROCUREMENT_AWARD', 'A') && closedEnquiries.length > 0,
              reason: blockedReason('PROCUREMENT_AWARD', 'A') ?? 'No return period has closed' },
            { id: 'schedule', label: 'Open measurement schedule', permitted: can('BOQ_TAKEOFF', 'C'), reason: blockedReason('BOQ_TAKEOFF', 'C') },
            { id: 'items', label: 'Record measured items',
              permitted: can('BOQ_TAKEOFF', 'U') && openSchedules.length > 0,
              reason: blockedReason('BOQ_TAKEOFF', 'U') ?? NO_OPEN_SCHEDULE },
            { id: 'rate', label: 'Build a rate',
              permitted: can('ESTIMATE_TENDER', 'U') && openSchedules.length > 0,
              reason: blockedReason('ESTIMATE_TENDER', 'U') ?? NO_OPEN_SCHEDULE },
            { id: 'revision', label: 'Drawing reissued',
              permitted: can('BOQ_TAKEOFF', 'U') && openSchedules.length > 0,
              reason: blockedReason('BOQ_TAKEOFF', 'U') ?? NO_OPEN_SCHEDULE },
            { id: 'remeasure', label: 'Record a remeasurement',
              permitted: can('BOQ_TAKEOFF', 'U') && bill.schedules.some((s) => s.openRemeasure > 0),
              reason: blockedReason('BOQ_TAKEOFF', 'U') ?? 'No item is waiting on a remeasurement' },
            { id: 'freezeSchedule', label: 'Freeze the schedule',
              permitted: can('ESTIMATE_TENDER', 'A') && openSchedules.length > 0,
              reason: blockedReason('ESTIMATE_TENDER', 'A') ?? NO_OPEN_SCHEDULE },
            { id: 'clarification', label: 'Raise clarification', permitted: can('PROCUREMENT_AWARD', 'C'), reason: blockedReason('PROCUREMENT_AWARD', 'C') },
            { id: 'issueClarification', label: 'Issue answer',
              permitted: can('PROCUREMENT_AWARD', 'U') && unanswered.length > 0,
              reason: blockedReason('PROCUREMENT_AWARD', 'U') ?? 'Every clarification on the register has been answered' },
            { id: 'comparison', label: 'Open comparison', permitted: can('PROCUREMENT_AWARD', 'C'), reason: blockedReason('PROCUREMENT_AWARD', 'C') },
            { id: 'rawReturn', label: 'Record return',
              permitted: can('PROCUREMENT_AWARD', 'U') && openComparisons.length > 0,
              reason: blockedReason('PROCUREMENT_AWARD', 'U') ?? NO_OPEN_COMPARISON },
            { id: 'adjustment', label: 'Adjust a return',
              permitted: can('PROCUREMENT_AWARD', 'U') && openComparisons.length > 0,
              reason: blockedReason('PROCUREMENT_AWARD', 'U') ?? NO_OPEN_COMPARISON },
            { id: 'comparisonQuery', label: 'Raise query',
              permitted: can('PROCUREMENT_AWARD', 'U') && openComparisons.length > 0,
              reason: blockedReason('PROCUREMENT_AWARD', 'U') ?? NO_OPEN_COMPARISON },
            { id: 'closeComparison', label: 'Close for adjudication',
              permitted: can('PROCUREMENT_AWARD', 'A') && openComparisons.length > 0,
              reason: blockedReason('PROCUREMENT_AWARD', 'A') ?? NO_OPEN_COMPARISON },
          ]))}
        </div>
      </div>

      ${supplierSignIn ? supplierPortalPanel(portal) : ''}

      ${
        master
          ? html`<div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">Master pricing — the number that goes out</h2>
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
        <div ${raw(drillable('Design maturity', maturitySources))}>
          <h2>Design maturity</h2>
          <div class="metric ${raw(!maturity ? '' : maturity.score >= 80 ? 'good' : maturity.score >= 60 ? 'warn' : 'bad')}">${maturity ? maturity.score : '—'}</div>
          <div class="metric-sub">${maturity ? `basis: ${humanise(maturity.recommendedPricingBasis)}` : 'not assessed'}</div>
        </div>
        <div ${raw(drillable('Tender estimate', estimateSources))}>
          <h2>Tender estimate</h2>
          <div class="metric orange">${estimate ? money(estimate.totalMinor) : '—'}</div>
          <div class="metric-sub">${estimate ? `${badgeText(estimate.status)} · margin ${pct(estimate.marginPercent, 1)}` : ''}</div>
        </div>
        <div ${raw(drillable('Returns received', returnSources))}>
          <h2>Returns received</h2>
          <div class="metric">${returnsCount ?? '—'}</div>
          <div class="metric-sub">${
            returnsCount === null
              ? 'submissions are not visible to your role'
              : rfq
                ? `${rfq.reference} · ${humanise(rfq.status)}`
                : 'no RFQ issued'
          }</div>
        </div>
        <div ${raw(drillable('Buyout against target', buyoutSources))}>
          <h2>Buyout against target</h2>
          <div class="metric ${raw((subcontract?.buyoutDeltaMinor ?? 0) >= 0 ? 'good' : 'bad')}">
            ${subcontract ? money(subcontract.buyoutDeltaMinor) : '—'}
          </div>
          <div class="metric-sub">${subcontract ? `${subcontract.reference} · ${humanise(subcontract.status)}` : 'not awarded'}</div>
        </div>
      </div>

      <div id="procurement-insight" style="margin-bottom:14px"></div>

      ${
        !reconciliation || reconciliation.invited === 0
          ? ''
          : html`<div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">Who was asked, and who answered</h2>
              <div style="padding:8px 17px 0"><div class="metric-sub">${reconciliation.summary}</div></div>
              ${
                reconciliation.unmatchable
                  ? html`<div style="padding:12px 17px 0"><div class="notice warn">
                      <div><b>Returns cannot be matched to invitations</b><br>${reconciliation.unmatchable}</div>
                    </div></div>`
                  : reconciliation.concern
                    ? html`<div style="padding:12px 17px 0"><div class="notice warn">
                        <div><b>The competition is thin</b><br>${reconciliation.concern}</div>
                      </div></div>`
                    : ''
              }
              ${table({
                headers: ['Invited firm', 'Acknowledged', 'Said they would bid', 'Returned', 'Queries', 'Outcome'],
                align: ['', '', '', '', 'num', ''],
                rows: reconciliation.bidders.map((bidder) => [
                  bidder.supplierName ?? bidder.supplierId,
                  bidder.acknowledgedAt ? date(bidder.acknowledgedAt) : badge('no reply', 'neutral'),
                  bidder.intendToBid === undefined
                    ? '—'
                    : bidder.intendToBid
                      ? badge('yes', 'ok')
                      : badge('no', 'neutral'),
                  bidder.returnedAt ? date(bidder.returnedAt) : '—',
                  bidder.clarificationsRaised,
                  // The word is the finding. "Declined" and "said they would bid
                  // and then went quiet" are different facts about a supply chain.
                  bidder.outcome === 'RETURNED'
                    ? badge('returned', 'ok')
                    : bidder.outcome === 'DECLINED'
                      ? badge('declined', 'neutral')
                      : bidder.outcome === 'BROKEN_PROMISE'
                        ? badge('promised, then silent', 'bad')
                        : bidder.outcome === 'SILENT'
                          ? badge('never answered', 'warn')
                          : badge('awaited', 'info'),
                ]),
              })}
              ${
                reconciliation.uninvitedReturns.length === 0 || reconciliation.unmatchable
                  ? ''
                  : html`<div style="padding:12px 17px 15px"><div class="notice err">
                      <div>
                        <b>${reconciliation.uninvitedReturns.length} return${reconciliation.uninvitedReturns.length === 1 ? '' : 's'} from a firm that was never invited</b><br>
                        ${reconciliation.uninvitedReturns.join(', ')} — either a data fault or a procurement irregularity, and both need somebody to look.
                      </div>
                    </div></div>`
              }
            </div>`
      }

      ${
        routes.routes.length === 0
          ? ''
          : html`<div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">Buy it or do it — the route on every package</h2>
              <div style="padding:8px 17px 0"><div class="metric-sub">
                Raw is what the firm sent. Normalised is the same scope, differently priced — a correction. Evaluated adds what
                choosing that route costs us in risk, interface, management and programme — an addition. Mixing the two produces a
                number nobody can defend, because half of it is arithmetic and half of it is judgement.
              </div></div>
              ${table({
                headers: ['Route', 'Package', 'Options', 'Selected', 'Basis', 'Interests', 'State'],
                align: ['', '', 'num', '', '', 'num', ''],
                rows: routes.routes.map((r) => [
                  r.reference,
                  r.packageReference,
                  r.options,
                  r.selectedName ?? (r.rankingSuppressed ? badge('ranking withheld', 'warn') : '—'),
                  r.selectedWasCheapest === false
                    ? badge('not the cheapest evaluated', 'warn')
                    : r.selectedWasCheapest === true
                      ? badge('cheapest evaluated', 'ok')
                      : '—',
                  r.interests > 0 ? badge(String(r.interests), 'warn') : '—',
                  badge(badgeText(r.status), statusTone(r.status)),
                ]),
              })}
              ${
                routes.routes.some((r) => r.selectedWasCheapest === false)
                  ? html`<div style="padding:12px 17px 0"><div class="notice info">
                      <div>
                        <b>A package was bought from somebody other than the cheapest evaluated option.</b><br>
                        That is often right — the firm that is cheaper and has no capacity until March is not cheaper — and it is
                        exactly the sentence somebody will be asked about. The rationale, and the cost, risk, programme and
                        capacity bases behind it, are on the record.
                      </div>
                    </div></div>`
                  : ''
              }
              ${
                routes.routes.some((r) => r.interests > 0)
                  ? html`<div style="padding:12px 17px 15px"><div class="notice warn">
                      <div>
                        <b>A connection to a firm being priced has been declared.</b><br>
                        Declared before the selection, which is the only time a declaration counts, and the person who declared it
                        cannot make the decision on that firm.
                      </div>
                    </div></div>`
                  : ''
              }
            </div>`
      }

      ${
        enquiries.enquiries.length === 0
          ? ''
          : html`<div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">Enquiries — which pack each firm is holding</h2>
              <div style="padding:8px 17px 0"><div class="metric-sub">
                An addendum goes out on the Tuesday and two of five bidders price the Monday pack. Nothing in the returns says so,
                and the comparison then ranks five prices for two different scopes. Every issue record names the exact revision and
                its content hash, so which pack a firm holds is a fact rather than an assumption.
              </div></div>
              ${table({
                headers: ['Enquiry', 'Package', 'Rev', 'Approved', 'Issued', 'Acknowledged', 'Declined', 'Removed', 'Return by', 'State'],
                align: ['', '', 'num', '', 'num', 'num', 'num', 'num', '', ''],
                rows: enquiries.enquiries.map((e) => [
                  e.reference,
                  e.exception ? html`${e.title} ${badge('issued short', 'warn')}` : e.title,
                  e.revision || '—',
                  e.approved ? badge('approved', 'ok') : badge('draft', 'warn'),
                  e.issued || '—',
                  e.acknowledged || '—',
                  e.declined || '—',
                  e.revoked || '—',
                  date(e.returnDeadline),
                  e.lateReturns > 0
                    ? html`${badge(badgeText(e.status), statusTone(e.status))} ${badge(`${e.lateReturns} late`, 'warn')}`
                    : badge(badgeText(e.status), statusTone(e.status)),
                ]),
              })}
              ${
                enquiries.enquiries.some((e) => e.stale.length > 0)
                  ? html`<div style="padding:12px 17px 0"><div class="notice err">
                      <div>
                        <b>Firms are pricing a superseded pack.</b><br>
                        ${enquiries.enquiries
                          .filter((e) => e.stale.length > 0)
                          .map((e) => `${e.reference}: ${e.stale.join(', ')}`)
                          .join(' · ')}<br>
                        Until each has been issued the current revision and acknowledged it, their price is for a different scope
                        — and the comparison will not say so, because the number looks like every other number.
                      </div>
                    </div></div>`
                  : ''
              }
              ${
                enquiries.enquiries.some((e) => e.exception)
                  ? html`<div style="padding:12px 17px 15px"><div class="notice warn">
                      <div>
                        <b>An enquiry went out short of a mandatory document.</b><br>
                        ${enquiries.enquiries
                          .filter((e) => e.exception)
                          .map((e) => `${e.reference}: no ${e.exception.missing.join(', no ').toLowerCase().replace(/_/g, ' ')} — ${e.exception.reason} (${e.exception.authorisedBy})`)
                          .join(' · ')}
                      </div>
                    </div></div>`
                  : ''
              }
            </div>`
      }

      ${
        bill.schedules.length === 0
          ? ''
          : html`<div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">Measurement — what the estimate is built on</h2>
              <div style="padding:8px 17px 0"><div class="metric-sub">
                Direct cost only: preliminaries, risk and overhead-and-profit are priced once at the estimate above, never spread
                across item rates. Every quantity names the drawing and revision it came off, or the person who authorised the
                allowance, and a schedule holding one that does neither will not freeze.
              </div></div>
              ${table({
                headers: ['Schedule', 'Package', 'Items', 'Direct cost', 'Not firm', 'Unpriced', 'Errors', 'Remeasure', 'State'],
                align: ['', '', 'num', 'num', 'num', 'num', 'num', 'num', ''],
                rows: bill.schedules.map((s) => [
                  s.reference,
                  s.title,
                  s.items,
                  money(s.directCostMinor),
                  s.uncertainPercent > 0 ? pct(s.uncertainPercent, 1) : '—',
                  s.unpriced > 0 ? badge(String(s.unpriced), 'warn') : '—',
                  s.critical > 0 ? badge(String(s.critical), 'bad') : '—',
                  s.openRemeasure > 0 ? badge(String(s.openRemeasure), 'warn') : '—',
                  badge(badgeText(s.status), statusTone(s.status)),
                ]),
              })}
              ${
                bill.schedules.some((s) => s.openRemeasure > 0)
                  ? html`<div style="padding:12px 17px 0"><div class="notice warn">
                      <div>
                        <b>A drawing has been reissued and ${bill.schedules.reduce((n, s) => n + s.openRemeasure, 0)} measured
                        item${bill.schedules.reduce((n, s) => n + s.openRemeasure, 0) === 1 ? ' has' : 's have'} not been looked at.</b><br>
                        Most of them will not have changed. Which ones did is the question nobody can answer three weeks later,
                        so the schedule will not freeze until each has been checked and the answer recorded — including where the
                        answer is "unchanged".
                      </div>
                    </div></div>`
                  : ''
              }
              ${
                bill.schedules.some((s) => s.uncertainPercent >= 10)
                  ? html`<div style="padding:12px 17px 15px"><div class="notice info">
                      <div>
                        <b>Part of this tender total is not the final figure.</b><br>
                        Provisional and approximate quantities are remeasured on site, and an allowance is a sum somebody
                        authorised rather than measured. Where they are a material share of a schedule, the total reads as firmer
                        than it is.
                      </div>
                    </div></div>`
                  : ''
              }
            </div>`
      }

      ${
        intel.comparisons.length === 0
          ? ''
          : html`<div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">Return comparisons — and how much of each is settled</h2>
              <div style="padding:8px 17px 0"><div class="metric-sub">
                Raw is what the firm sent and is never edited. Adjustments sit beside it, each one citing the return line it
                corrects or the clarification that authorises it. Where a firm has not returned, or a material query is still
                open, the ranking is withheld rather than published with a footnote — a ranked list is read as a
                recommendation however it is labelled.
              </div></div>
              ${table({
                headers: ['Comparison', 'Package', 'Settled', 'Confidence', 'Carried risk', 'Ranking', 'State'],
                align: ['', '', 'num', '', 'num', '', ''],
                rows: intel.comparisons.map((c) => [
                  c.reference,
                  c.packageReference,
                  pct(c.completeness, 0),
                  badge(
                    String(c.confidence).toLowerCase(),
                    c.confidence === 'HIGH' ? 'ok' : c.confidence === 'MEDIUM' ? 'warn' : 'bad',
                  ),
                  c.carriedRiskMinor > 0 ? money(c.carriedRiskMinor) : '—',
                  c.rankingSuppressed ? badge('withheld', 'warn') : badge('published', 'ok'),
                  badge(badgeText(c.status), statusTone(c.status)),
                ]),
              })}
              ${
                intel.comparisons.some((c) => c.carriedRiskMinor > 0)
                  ? html`<div style="padding:12px 17px 15px"><div class="notice warn">
                      <div>
                        <b>${money(intel.comparisons.reduce((sum, c) => sum + c.carriedRiskMinor, 0))} of unresolved variance is
                        being carried into adjudication.</b><br>
                        Not lost and not priced — it is what the open material queries are worth if they go the wrong way, and
                        it goes to the adjudication as a stated risk rather than as a surprise on site.
                      </div>
                    </div></div>`
                  : ''
              }
            </div>`
      }

      ${
        intel.clarifications.length === 0
          ? ''
          : html`<div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">Clarification register</h2>
              <div style="padding:8px 17px 0"><div class="metric-sub">
                Every question against the document, clause, drawing or package it concerns, and who the answer went to.
                A bidder who had the answer three days before the others is what makes an award challengeable, so the
                distribution and the reads are the record — not the answer.
              </div></div>
              ${table({
                headers: ['Ref', 'Side', 'Subject', 'About', 'Due', 'Issued', 'Sent to', 'Read', 'State'],
                align: ['', '', '', '', '', '', 'num', 'num', ''],
                rows: intel.clarifications.map((c) => [
                  c.reference,
                  badge(String(c.side).toLowerCase(), c.side === 'BIDDER' ? 'info' : 'neutral'),
                  c.confidentiality === 'COMMERCIAL_IN_CONFIDENCE'
                    ? html`${c.subject} ${badge('in confidence', 'warn')}`
                    : c.subject,
                  [c.links?.document, c.links?.clause && `cl. ${c.links.clause}`, c.links?.drawing, c.links?.package, c.links?.scopeItem]
                    .filter(Boolean)
                    .join(' · ') || '—',
                  c.responseDeadline ? date(c.responseDeadline) : '—',
                  c.issuedAt ? date(c.issuedAt) : '—',
                  c.recipients || '—',
                  c.recipients ? `${c.acknowledged}/${c.recipients}` : '—',
                  badge(badgeText(c.status), statusTone(c.status)),
                ]),
              })}
            </div>`
      }

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
              <h2 style="padding:15px 17px 0">
                Estimate build-up${estimate.durationWeeks ? ` — ${estimate.durationWeeks} weeks on site` : ''}
              </h2>
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
                <h2>Prelims as % of works</h2>
                <div class="metric ${raw(estimate.benchmarks.prelimsPercentOfWorks > 25 ? 'warn' : 'good')}">${pct(estimate.benchmarks.prelimsPercentOfWorks, 1)}</div>
                <div class="metric-sub">A benchmark, never an input — priced as a percentage, prelims do not move when the programme does.</div>
              </div>
              <div class="card">
                <h2>Contingency as % of cost</h2>
                <div class="metric">${pct(estimate.benchmarks.riskPercentOfCost, 1)}</div>
                <div class="metric-sub">Drawn from the quantified register at P80, not from a round number.</div>
              </div>
              <div class="card">
                <h2>Weekly burn</h2>
                <div class="metric">${money(estimate.benchmarks.weeklyBurnMinor)}</div>
                <div class="metric-sub">${money(estimate.benchmarks.costPerWeekOfSiteOverheadMinor)} of it is site-wide cost that runs whatever the works do.</div>
              </div>
              <div class="card">
                <h2>Margin</h2>
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
            }

            <div class="card" style="margin-bottom:14px">
              <h2>The quotation</h2>
              <p style="font-size:12.5px;color:var(--text-3);margin:4px 0 0">
                The last step of the line that starts at a drawing. The offer is composed from this estimate — the
                measured works with their quantities, the total apportioned across them so the lines add up exactly,
                and every assumption and exclusion carried through as a qualification. It opens as a draft under Legal
                instruments on Site Documents, and is issued from there under its own number.
              </p>
              ${
                (estimate.omissions ?? []).length > 0
                  ? html`<div class="notice warn" style="margin-top:10px">
                      <div>
                        <b>This estimate cannot be quoted yet.</b> ${estimate.omissions.length} cost
                        head${estimate.omissions.length === 1 ? ' is' : 's are'} neither priced nor excluded —
                        ${estimate.omissions.map((h) => humanise(h)).join(', ')}. Price
                        ${estimate.omissions.length === 1 ? 'it' : 'them'} or state
                        ${estimate.omissions.length === 1 ? 'it' : 'them'} as an exclusion; a nought against a head is
                        not a job without it.
                      </div>
                    </div>`
                  : ''
              }
              <div class="actions" style="margin-top:12px">
                ${raw(
                  commandBar([
                    {
                      id: 'quote',
                      label: 'Draw up the quotation',
                      tone: 'primary',
                      permitted: can('EVIDENCE_AUDIT', 'I') && can('ESTIMATE_TENDER', 'R') && (estimate.omissions ?? []).length === 0,
                      reason:
                        (estimate.omissions ?? []).length > 0
                          ? 'The estimate carries a cost head that is neither priced nor excluded.'
                          : blockedReason('EVIDENCE_AUDIT', 'I') ?? blockedReason('ESTIMATE_TENDER', 'R'),
                    },
                  ]),
                )}
              </div>
            </div>`
          : ''
      }

      ${
        funding
          ? html`
            <div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">
                Cash flow — peak funding requirement
                ${badge(humanise(funding.verdict), funding.verdict === 'FUNDABLE' ? 'ok' : funding.verdict === 'TIGHT' ? 'warn' : 'bad')}
              </h2>
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

      ${procurementCharts(scores, coverage, costIntel)}

      ${procurementProgramme(b.RFQ ?? [], b.SupplierSubmission ?? [])}

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">Bid evaluation${evaluation ? ` — ${evaluation.method.price} price / ${evaluation.method.programme} programme / ${humanise(evaluation.method.risk)} risk` : ''}</h2>
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
          <h2>Award conditions</h2>
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
          <h2>Adjudication</h2>
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
          <h2>Tender package completeness</h2>
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
          <h2>Subcontract — what carried forward</h2>
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

      ${packRunPanel({
        available: perception?.capability?.available === true,
        // `classification.kind`, not `kind` — the register publishes an ingested
        // file as the pipeline recorded it, and reading the flat name gave
        // `undefined` for every file and "0 drawings filed" on a project that
        // had them.
        drawingsHeld: (ingestion?.files ?? []).filter((file) => file.classification?.kind === 'DRAWING').length,
        blocked: null,
      })}

      ${
        /*
         * The bill, and the door that prices it.
         *
         * Both engines existed and neither had a screen: `runTakeoff` wrote
         * measured items nothing could read back, and `buildEstimate` prices
         * twenty cost heads from lines that nothing could hand it. The only
         * route to a priced job was the generated command catalogue, retyping
         * every quantity — which for a wall repair with a dozen items is not a
         * tool anybody would choose.
         *
         * The lines are handed back exactly as they were measured, each keeping
         * its `boqItemId`, so what is priced is traceably what was measured off
         * the sheet rather than a second copy of it.
         */
        boq?.error
          ? ''
          : html`<div class="card pad0" style="margin-bottom:14px">
              <div style="padding:15px 17px">
                <h2>The bill, and what it prices at</h2>
                <div class="metric-sub" style="margin-bottom:11px">
                  ${(boq?.items ?? []).length} measured item${(boq?.items ?? []).length === 1 ? '' : 's'} held against
                  ${(boq?.packages ?? []).length} package${(boq?.packages ?? []).length === 1 ? '' : 's'}. Every line
                  carries the sheet it was measured from and the rule it was measured under. An estimate is built from
                  these across the twenty heads below — time-related costs by the week, contingency from the risk
                  register at P80, margin on the cost beneath. A head neither priced nor excluded comes back as an
                  omission and the estimate says so rather than carrying it as nought.
                </div>
                ${(boq?.items ?? []).length > 0
                  ? table({
                      headers: ['Code', 'Description', 'Unit', 'Quantity', 'Measured from', 'Measured by', 'Confidence'],
                      align: ['', '', '', 'num', '', '', 'num'],
                      rows: (boq.items ?? []).slice(0, 60).map((item) => [
                        item.costCode,
                        item.description,
                        item.unit,
                        Number(item.quantity).toLocaleString('en-GB'),
                        item.sourceSheet ?? '—',
                        item.measuredBy === 'PERSON' ? badge('a surveyor', 'ok') : badge('a model', ''),
                        item.confidenceScore === null ? '—' : pct(Number(item.confidenceScore) * 100, 0),
                      ]),
                    })
                  : html`<div class="empty"><b>Nothing measured yet</b>Measure a drawing on Pipeline &amp; Bids, or enter
                      what you measured yourself below. Either way the quantities appear here ready to price.</div>`}
                <div class="actions" style="margin-top:12px">
                  ${raw(
                    commandBar([
                      {
                        id: 'measured-takeoff',
                        label: 'Enter measured quantities',
                        permitted: can('BOQ_TAKEOFF', 'C'),
                        reason: blockedReason('BOQ_TAKEOFF', 'C'),
                      },
                      {
                        id: 'build-estimate',
                        label: 'Price the bill',
                        tone: 'primary',
                        permitted: can('ESTIMATE_TENDER', 'C') && (boq?.items ?? []).length > 0,
                        reason:
                          (boq?.items ?? []).length === 0
                            ? 'Nothing has been measured yet. An estimate prices measured lines; it does not invent them.'
                            : blockedReason('ESTIMATE_TENDER', 'C'),
                      },
                    ]),
                  )}
                </div>
              </div>
            </div>`
      }

      ${positionReport({
        title: 'The twenty cost heads',
        intent:
          'What a tender is built from and the basis each head is priced on, published by the platform so an ' +
          'estimate cannot quietly omit one.',
        data: costHeads,
        error: costHeads?.error,
        sections: [{ key: 'heads', label: 'Cost heads', empty: 'No cost head is defined.' }],
      })}

      ${positionReport({
        title: 'Cost intelligence',
        intent:
          'Unit rates and package outturns from this business\u2019s own committed records — not a bought index. ' +
          'Confidence is stated, because a median of two observations is not a rate.',
        data: costIntel,
        error: costIntel?.error,
        sections: [
          { key: 'rates', label: 'Unit rates', empty: 'No rate has enough observations to publish.' },
          { key: 'outturns', label: 'Package outturns', empty: 'No package has reached outturn.' },
          { key: 'estimatingAccuracy', label: 'Estimating accuracy' },
        ],
      })}

      ${positionReport({
        title: 'What the record has learned',
        intent:
          'Every other measure on this screen looks backwards at delivery. These look forward into the next bid: how ' +
          'far our price sat from the winning price, what a win-probability score has actually been worth, how far ' +
          'our package estimates sit from the market. A signal is not a lesson — nothing here reaches an estimate ' +
          'until somebody promotes it.',
        data: calibration,
        error: calibration?.error,
        sections: [
          { key: 'signals', label: 'Signals the record supports', empty: 'No bid has a recorded outcome yet, so there is nothing to calibrate against.' },
          { key: 'settled', label: 'Settled bids' },
          { key: 'limits', label: 'What the record cannot answer', empty: 'Every question the calibration asks has an answer on the record.' },
        ],
      })}

      ${positionReport({
        title: 'Calibrations being applied',
        intent:
          'Gate G7. A proposed correction changes nothing anybody sees; a promoted one corrects every median the ' +
          'estimate benchmark compares against, carries its source bids and names its approver. The person who ' +
          'proposed it may not be the one who promotes it.',
        data: lessons,
        error: lessons?.error,
        sections: [
          { key: 'lessons', label: 'Every calibration', empty: 'Nothing has been proposed. Until a lesson is promoted, nothing the record has learned reaches an estimate.' },
          { key: 'effects', label: 'What a promoted one of each kind changes' },
          { key: 'counts', label: 'By standing' },
        ],
      })}

      ${positionReport({
        title: 'Trade catalogue',
        intent: 'Every trade, and which require third-party accreditation before anybody may be engaged.',
        data: trades,
        error: trades?.error,
        sections: [{ key: 'trades', label: 'Trades', empty: 'No trade catalogue is published.' }],
      })}

      ${positionReport({
        title: 'Supply-chain coverage',
        intent:
          'Where the chain is too thin to compete. A trade with one eligible supplier is not a market, and pricing ' +
          'it as though it were is how a tender loses money before it is submitted.',
        data: coverage,
        error: coverage?.error,
        sections: [
          { key: 'totals', label: 'Totals' },
          { key: 'gaps', label: 'Trades with no eligible supplier', empty: 'Every trade has an eligible supplier.' },
        ],
      })}

      ${positionReport({
        title: 'Framework agreements',
        intent: 'Frameworks this tenancy holds, with membership balance, thin lots, concentration and expiry.',
        data: frameworks,
        error: frameworks?.error,
        sections: [{ key: 'frameworks', label: 'Frameworks', empty: 'This tenancy holds no framework agreement.' }],
      })}

      ${positionReport({
        title: 'Tender reviews',
        intent: 'What is missing, what nobody owns, what two people own, and what the contract actually says.',
        data: reviews,
        error: reviews?.error,
        sections: [{ key: 'reviews', label: 'Reviews', empty: 'No tender review has been held.' }],
      })}

      ${raw(LOOKUPS.map((spec) => resolveHtml(lookupPanel(spec))).join(''))}

      ${positionReport({
        title: 'Submissions and awards',
        intent: 'Submission packs and their receipts, the award departures, and what has converted.',
        data: awards,
        error: awards?.error,
        sections: [
          { key: 'packs', label: 'Submission packs', empty: 'Nothing has been submitted.' },
          // Listed rather than counted. A number beside "unresolved" says there
          // is a problem; this says which promise the contract may not carry.
          {
            key: 'unresolvedQualifications',
            label: 'Bid qualifications the award did not answer',
            empty: 'Every bid qualification is either accepted or struck out by the award.',
          },
        ],
      })}
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
    /*
     * Price the measured bill across the twenty heads.
     *
     * The lines are not asked for. They are what was measured and confirmed,
     * handed back with their `boqItemId` intact so what is priced is traceably
     * what came off the sheet. What *is* asked for is everything a drawing
     * cannot tell anybody: how long the job runs, what this business adds for
     * overhead and profit, and the basis the estimate was built on — none of
     * which is in a tender pack, and none of which the platform invents.
     *
     * Rates are left to the estimator. A quantity is not a rate, and a platform
     * that filled them in from an index would be pricing somebody else's job.
     */
    /*
     * The run: read the pack, measure it, price it against our own record.
     *
     * One field, because one field is all the platform cannot work out for
     * itself. Everything else it reads, measures or takes from what this
     * business has already committed — and where it cannot, it says so on the
     * proposal rather than opening another form.
     */
    'price-pack': {
      title: 'Read and price the pack',
      intent:
        'Reads every drawing filed on this project, measures what is dimensioned on each sheet, and proposes a rate ' +
        'for every measured line from the estimates this business has actually committed — with the confidence and ' +
        'the age of the evidence behind each one. It writes the readings and nothing else: no bill, no estimate and ' +
        'no quotation exists until you accept what it found.',
      path: `/v1/projects/${projectId}/tender/pack/price`,
      submitLabel: 'Read the pack',
      aiCost: { method: 'POST', path: `/v1/projects/${projectId}/tender/pack/price` },
      fields: [
        {
          name: 'packageId',
          label: 'Work package',
          type: 'text',
          placeholder: 'WALL',
          hint: 'What to file the measured quantities under. The one thing no drawing states.',
        },
      ],
      // The proposal is the screen's, not the platform's: nothing is recorded
      // until it is accepted, so it is held here and drawn below.
      onResult: (result) => {
        packRun = result;
      },
    },
    /*
     * One decision, taken once.
     *
     * Everything the run could answer is already answered and is not asked for
     * again: the quantities, the rates it found in our own record, the
     * site-wide heads and the margin from the last complete estimate. What is
     * asked for is what nothing could tell it — the rate on a line this
     * business has never priced, and who the offer is being made to.
     */
    'accept-pack': {
      title: 'Accept the run',
      intent:
        'Confirms every reading, writes the bill, prices it across the twenty cost heads and draws up the quotation. ' +
        'The quotation opens as a draft under Legal instruments on Site Documents, where it is generated against a ' +
        'frozen manifest, approved and issued under its own number — the one step of this that is a legal act rather ' +
        'than arithmetic.',
      path: `/v1/projects/${projectId}/tender/pack/accept`,
      submitLabel: 'Accept and draw it up',
      fields: [
        {
          name: 'costCodePrefix',
          label: 'Cost code prefix',
          type: 'text',
          value: packRun?.packageId ?? '',
          hint: 'Codes run WALL.001, WALL.002 and so on.',
        },
        {
          name: 'durationWeeks',
          label: 'Weeks on site',
          type: 'number',
          step: '1',
          value: packRun?.basis?.durationWeeks ?? '',
          hint: 'Drives every time-related head. Nothing in a drawing says how long a job takes.',
        },
        {
          name: 'overheadPercent',
          label: 'Overhead (%)',
          type: 'number',
          step: '0.1',
          value: packRun?.basis?.margin?.overheadPercent ?? '',
        },
        {
          name: 'profitPercent',
          label: 'Profit (%)',
          type: 'number',
          step: '0.1',
          value: packRun?.basis?.margin?.profitPercent ?? '',
        },
        {
          name: 'basisOfEstimate',
          label: 'Basis of the estimate',
          type: 'textarea',
          rows: 2,
          value: packRun?.read?.length
            ? `Measured off ${packRun.read.map((sheet) => sheet.filename).join(', ')}; rates from this business's own committed estimates.`
            : '',
        },
        { name: 'clientName', label: 'Quoted to', type: 'text', hint: 'The client this offer is made to.' },
        { name: 'validUntil', label: 'Valid until', type: 'date', min: today(), hint: 'A quotation without a lapse date is a standing offer.' },
        { name: 'paymentTerms', label: 'Payment terms', type: 'text', required: false, placeholder: '30 days from invoice' },
        // Only the lines our own record could not price. A form that asked for
        // every rate again would be the thing this run exists to remove.
        ...(packRun?.lines ?? [])
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => !line.rate)
          .flatMap(({ line, index }) => [
            {
              name: `rate:${index}`,
              label: `${line.description} — ${line.quantity} ${line.unit}`,
              type: 'number',
              money: true,
              hint: `${line.sourceSheet ?? 'measured'} · all-in rate per ${line.unit}. This business has never priced this item.`,
            },
            {
              name: `basis:${index}`,
              label: '— priced as',
              type: 'select',
              required: false,
              value: 'labourRateMinor',
              options: [
                { value: 'labourRateMinor', label: 'Our own labour' },
                { value: 'materialRateMinor', label: 'Materials' },
                { value: 'plantRateMinor', label: 'Plant' },
                { value: 'subcontractRateMinor', label: 'Subcontract' },
              ],
            },
          ]),
      ],
      transform: (v) => ({
        packageId: packRun.packageId,
        costCodePrefix: v.costCodePrefix,
        lines: packRun.lines.map((line, index) => {
          if (line.rate) {
            return {
              draftId: line.draftId,
              index: line.index,
              labourRateMinor: line.rate.labourRateMinor,
              materialRateMinor: line.rate.materialRateMinor,
              plantRateMinor: line.rate.plantRateMinor,
              subcontractRateMinor: line.rate.subcontractRateMinor,
            };
          }
          const typed = Number(v[`rate:${index}`] ?? 0);
          const head = v[`basis:${index}`] || 'labourRateMinor';
          return { draftId: line.draftId, index: line.index, ...(typed > 0 ? { [head]: typed } : {}) };
        }),
        estimate: {
          durationWeeks: Number(v.durationWeeks),
          basisOfEstimate: v.basisOfEstimate,
          margin: { overheadPercent: Number(v.overheadPercent), profitPercent: Number(v.profitPercent) },
          ...(packRun.basis?.timeRelated?.length ? { timeRelated: packRun.basis.timeRelated } : {}),
          ...(packRun.basis?.quantified?.length ? { quantified: packRun.basis.quantified } : {}),
          ...(packRun.basis?.insurance ? { insurance: packRun.basis.insurance } : {}),
          ...(packRun.basis?.exclusions?.length ? { exclusions: packRun.basis.exclusions } : {}),
        },
        quotation: {
          clientName: v.clientName,
          validUntil: v.validUntil,
          ...(v.paymentTerms ? { paymentTerms: v.paymentTerms } : {}),
        },
      }),
      // Accepted means recorded. The proposal has become a bill, an estimate
      // and a quotation, and leaving it on screen would invite a second run
      // against readings that are now confirmed.
      onResult: () => {
        packRun = null;
      },
    },
    /*
     * The quantities a surveyor measured, entered as measured.
     *
     * The only route to a bill of quantities ran a perception model over the
     * sheets, so a company with no AI credit could not price a job it had
     * measured by hand — and a take-off done with a scale rule was charged for
     * a reading nobody performed. This calls no provider and costs nothing.
     *
     * The quantities carry no confidence score, deliberately. A number there
     * would be a score for a reading that did not happen; the bill says "a
     * surveyor" instead, which is the more useful fact anyway.
     */
    'measured-takeoff': {
      title: 'Enter measured quantities',
      intent:
        'For a take-off done off your own sheets. Nothing is read, nothing is charged, and each line is recorded as ' +
        'measured by a person against the sheet you name — which is what an estimator, and anybody auditing the bid ' +
        'years later, needs to know about a quantity.',
      path: `/v1/projects/${projectId}/tender/takeoff/measured`,
      submitLabel: 'Record the measurement',
      fields: [
        {
          name: 'packageId',
          label: 'Work package',
          type: 'text',
          suggestions: boq?.packages ?? [],
          hint: 'The package these quantities belong to. Use the same name when you price them.',
        },
        { name: 'costCodePrefix', label: 'Cost code prefix', type: 'text', placeholder: 'WALL', hint: 'Codes run WALL.001, WALL.002 and so on.' },
        { name: 'discipline', label: 'Discipline', type: 'text', placeholder: 'STRUCTURES' },
        { name: 'sheetId', label: 'Sheet', type: 'text', placeholder: '25133-TDC-FN-ZZ-DR-S-1600', hint: 'The drawing the measurement was taken off.' },
        {
          name: 'items',
          label: 'The items, one per line',
          type: 'textarea',
          rows: 8,
          placeholder:
            'Rake out and repoint in lime mortar | m2 | 86\nRebuild collapsed section in reclaimed stone | m2 | 12\nReplace coping, bed and point | m | 34',
          hint: 'description | unit | quantity — and optionally a fourth field naming a different sheet for that line.',
        },
      ],
      transform: (v) => ({
        packageId: v.packageId,
        costCodePrefix: v.costCodePrefix,
        sources: [{ discipline: v.discipline, sheetId: v.sheetId }],
        items: String(v.items ?? '')
          .split('\n')
          .map((line) => line.split('|').map((part) => part.trim()))
          .filter((parts) => parts.length >= 3 && parts[0])
          .map((parts) => ({
            description: parts[0],
            unit: parts[1],
            quantity: Number(parts[2]),
            sourceSheet: parts[3] || v.sheetId,
          })),
      }),
    },
    'build-estimate': {
      title: 'Price the bill',
      intent:
        'Prices every measured line across the twenty tender cost heads. Time-related costs are priced by the week ' +
        'rather than as a percentage of works, contingency is drawn from the risk register at P80, and margin sits on ' +
        'the cost beneath it. A head that is neither priced nor excluded comes back as an omission and the estimate is ' +
        'marked incomplete — a nought against waste is not a job with no waste in it.',
      path: `/v1/projects/${projectId}/tender/estimate`,
      submitLabel: 'Price it',
      fields: [
        {
          name: 'packageId',
          label: 'Work package',
          type: 'select',
          options: (boq?.packages ?? []).map((id) => ({ value: id, label: id })),
          hint: 'The package whose measured lines are being priced.',
        },
        {
          name: 'durationWeeks',
          label: 'Construction period (weeks)',
          type: 'number',
          step: '1',
          hint: 'Drives every time-related head. Not in the drawings, and not guessed at here.',
        },
        {
          name: 'overheadPercent',
          label: 'Overhead (%)',
          type: 'number',
          step: '0.1',
          hint: 'What this business carries, on the cost beneath it.',
        },
        { name: 'profitPercent', label: 'Profit (%)', type: 'number', step: '0.1' },
        {
          name: 'basisOfEstimate',
          label: 'Basis of the estimate',
          type: 'textarea',
          rows: 2,
          hint: 'What it was built from and what it assumes. It travels with the estimate and into the quotation.',
        },
        {
          name: 'assumptions',
          label: 'Assumptions, one per line',
          type: 'textarea',
          rows: 3,
          required: false,
          hint: 'Each becomes a stated assumption on the estimate rather than something a reader has to infer.',
        },
        // The site-wide heads a small job actually carries. Priced on their own
        // basis — by the week, or as their own sum — never as a percentage of
        // the works, which is the mistake the cost model exists to refuse.
        {
          name: 'prelimsWeeklyMinor',
          label: 'Preliminaries, per week',
          type: 'number',
          money: true,
          required: false,
          hint: 'Set-up, welfare, accommodation, utilities. Multiplied by the period above, so a longer job costs more.',
        },
        {
          name: 'safetyWeeklyMinor',
          label: 'Health and safety, per week',
          type: 'number',
          money: true,
          required: false,
          hint: 'Safety advice, inductions, PPE, monitoring.',
        },
        {
          name: 'wasteMinor',
          label: 'Waste, as a sum',
          type: 'number',
          money: true,
          required: false,
          hint: 'Skips, muck away and gate fees for the whole job.',
        },
        {
          name: 'insurancePercent',
          label: 'Insurance (% of contract value)',
          type: 'number',
          step: '0.01',
          required: false,
          hint: 'Contract works and liability premiums, on the value they insure.',
        },
        // The other half of honesty about a head. A head neither priced nor
        // excluded is an omission, the estimate is marked incomplete, and a
        // quotation cannot be drawn from it — so the way to say "not ours" has
        // to be on the same form as the way to price it.
        {
          name: 'excluded',
          label: 'Heads not included in this price',
          type: 'multiselect',
          required: false,
          options: (costHeads?.heads ?? []).map((head) => ({ value: head.head, label: `${head.label} — ${head.note}` })),
          hint:
            'Each becomes a stated exclusion carried into the quotation. Contingency belongs here unless the risk ' +
            'register is quantified, because a contingency taken as a percentage is a number nobody can defend.',
        },
        {
          name: 'exclusionReason',
          label: 'Why those are excluded',
          type: 'text',
          required: false,
          placeholder: 'Not included in this offer; by others',
        },
        // One rate field per measured line. The quantities are what came off
        // the drawings and are not asked for again; the rate is the
        // estimator's, and nothing here fills it in from an index — that would
        // be pricing somebody else's job.
        ...(boq?.items ?? []).flatMap((item) => [
          {
            name: `rate:${item.boqItemId}`,
            label: `${item.description} — ${item.quantity} ${item.unit}`,
            type: 'number',
            money: true,
            required: false,
            hint: `${item.packageId}${item.sourceSheet ? ` · measured off ${item.sourceSheet}` : ''} · all-in rate per ${item.unit}.`,
          },
          {
            name: `basis:${item.boqItemId}`,
            label: `— priced as`,
            type: 'select',
            required: false,
            value: 'labourRateMinor',
            options: [
              { value: 'labourRateMinor', label: 'Our own labour' },
              { value: 'materialRateMinor', label: 'Materials' },
              { value: 'plantRateMinor', label: 'Plant' },
              { value: 'subcontractRateMinor', label: 'Subcontract' },
            ],
          },
        ]),
      ],
      transform: (v) => {
        const excluded = Array.isArray(v.excluded) ? v.excluded : v.excluded ? [v.excluded] : [];
        const weeks = Number(v.durationWeeks);
        const timeRelated = [
          v.prelimsWeeklyMinor
            ? { head: 'PRELIMINARIES', description: 'Site set-up, welfare and establishment', weeklyRateMinor: Number(v.prelimsWeeklyMinor), quantity: 1 }
            : null,
          v.safetyWeeklyMinor
            ? { head: 'HEALTH_AND_SAFETY', description: 'Safety advice, inductions and monitoring', weeklyRateMinor: Number(v.safetyWeeklyMinor), quantity: 1 }
            : null,
        ].filter(Boolean);
        const quantified = v.wasteMinor
          ? [{ head: 'WASTE', description: 'Skips, muck away and gate fees', unit: 'sum', quantity: 1, rateMinor: Number(v.wasteMinor) }]
          : [];
        return {
          packageId: v.packageId,
          durationWeeks: weeks,
          basisOfEstimate: v.basisOfEstimate,
          assumptions: String(v.assumptions ?? '').split('\n').map((line) => line.trim()).filter(Boolean),
          margin: { overheadPercent: Number(v.overheadPercent), profitPercent: Number(v.profitPercent) },
          ...(timeRelated.length > 0 ? { timeRelated } : {}),
          ...(quantified.length > 0 ? { quantified } : {}),
          ...(v.insurancePercent
            ? { insurance: { policies: [{ type: 'Contract works and liability', percentOfContractValue: Number(v.insurancePercent) }] } }
            : {}),
          ...(excluded.length > 0
            ? { exclusions: excluded.map((head) => ({ head, reason: v.exclusionReason || 'Not included in this offer' })) }
            : {}),
          // Measured, confirmed, and handed back as measured — with the rate
          // the estimator put against each one.
          lines: (boq?.items ?? [])
            .filter((item) => item.packageId === v.packageId)
            .map((item) => {
              const rate = Number(v[`rate:${item.boqItemId}`] ?? 0);
              const basis = v[`basis:${item.boqItemId}`] || 'labourRateMinor';
              return {
                boqItemId: item.boqItemId,
                description: item.description,
                unit: item.unit,
                quantity: item.quantity,
                ...(rate > 0 ? { [basis]: rate } : {}),
              };
            }),
        };
      },
    },
    /*
     * The quotation, from the estimate rather than from somebody's memory of it.
     *
     * The last step of the line that starts at a drawing. Everything before it
     * existed — the reading, the take-off, a person confirming it, the pricing
     * across twenty heads — and then it stopped, and the only way to get a
     * quotation out was to retype the total into the legal-document screen.
     * That is the point where the traceability was being thrown away.
     *
     * What the customer sees is the works, the quantities, the money and the
     * qualifications. No overhead line, no profit line, no margin — the same
     * rule the billing screen was corrected for.
     */
    quote: {
      title: 'Draw up the quotation',
      intent:
        'Composes the quotation from the estimate: the measured works with their quantities, the tender total ' +
        'apportioned across them so the lines add up exactly, and every assumption and exclusion carried through as a ' +
        'qualification. It opens as a draft on Site Documents under Legal instruments, where it is generated against a ' +
        'frozen manifest, approved by a signatory and issued under its own number. An estimate carrying a head that is ' +
        'neither priced nor excluded is refused rather than quoted.',
      path: (collected) => `/v1/projects/${projectId}/tender/estimate/${collected.estimateId}/quotation`,
      submitLabel: 'Draw it up',
      fields: [
        {
          name: 'estimateId',
          label: 'Estimate',
          type: 'select',
          options: b.Estimate.map((e) => ({
            value: e._refId,
            label: `${e.packageId ?? e._refId} · ${e.status ?? ''}`.trim(),
          })),
        },
        { name: 'clientName', label: 'Quoted to', type: 'text', hint: 'The client this offer is made to. An estimate has no addressee; this is it.' },
        { name: 'validUntil', label: 'Valid until', type: 'date', min: today(), hint: 'A quotation without a lapse date is a standing offer.' },
        { name: 'paymentTerms', label: 'Payment terms', type: 'text', required: false, placeholder: '30 days from invoice' },
        { name: 'coveringNote', label: 'Covering note', type: 'textarea', rows: 2, required: false },
      ],
      transform: ({ estimateId, ...rest }) => rest,
    },
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
    /*
     * The three the enquiry could not do.
     *
     * `acknowledgeRFQ`, `raiseClarification` and `answerClarification` were
     * written in full — authorisation, refusals and all — and had no route and
     * no door, so a firm receiving an enquiry could not say whether it meant to
     * bid, could not ask a question about the information, and could not be
     * answered. The catalogue would have given them a generic door the moment
     * the routes existed; these are curated because each one wants this
     * project's own RFQs and its own open questions in a list, not an id typed
     * into a box.
     */
    acknowledge: {
      title: 'Acknowledge an enquiry',
      intent:
        'The firm answers the enquiry it was sent: whether it intends to bid. Recorded against the RFQ, and the reconciliation counts it — ' +
        'a firm that has said nothing is different from a firm that has declined.',
      path: (collected) => `/v1/projects/${projectId}/procurement/rfq/${collected.rfqId}/acknowledge`,
      submitLabel: 'Record',
      fields: [
        { name: 'rfqId', label: 'Against RFQ', type: 'select',
          options: b.RFQ.map((r) => ({ value: r._refId, label: `${r.reference} · ${r.title}` })) },
        { name: 'supplierId', label: 'Firm', type: 'select',
          options: (suppliers.suppliers ?? []).map((sup) => ({ value: sup.id, label: sup.name })) },
        { name: 'intendToBid', label: 'Intends to bid', type: 'select',
          options: [{ value: 'true', label: 'Yes — will return a price' }, { value: 'false', label: 'No — declining' }] },
      ],
      transform: ({ rfqId, intendToBid, ...rest }) => ({ ...rest, intendToBid: intendToBid === 'true' }),
    },
    clarification: {
      title: 'Raise a clarification',
      intent:
        'A bidder’s question about the enquiry, raised as TQ-nnn against the RFQ. Ask it here rather than answering it by email — ' +
        'an answer nobody else received is what makes an award challengeable.',
      path: (collected) => `/v1/projects/${projectId}/procurement/rfq/${collected.rfqId}/clarifications`,
      submitLabel: 'Raise',
      fields: [
        { name: 'rfqId', label: 'Against RFQ', type: 'select',
          options: b.RFQ.map((r) => ({ value: r._refId, label: `${r.reference} · ${r.title}` })) },
        { name: 'supplierId', label: 'Asked by', type: 'select',
          options: (suppliers.suppliers ?? []).map((sup) => ({ value: sup.id, label: sup.name })) },
        { name: 'question', label: 'Question', type: 'textarea', rows: 3 },
      ],
      transform: ({ rfqId, ...rest }) => rest,
    },
    answerclarification: {
      title: 'Answer a clarification',
      intent:
        'The answer goes to every bidder, not only the firm that asked. The platform refuses any other choice: a private answer means the ' +
        'returns are no longer comparable, and an award made on incomparable returns is one a losing bidder can challenge.',
      path: (collected) => `/v1/projects/${projectId}/procurement/clarifications/${collected.clarificationId}/answer`,
      submitLabel: 'Answer',
      fields: [
        { name: 'clarificationId', label: 'Question', type: 'select',
          options: (b.Clarification ?? [])
            .filter((c) => c.status !== 'ANSWERED')
            .map((c) => ({ value: c._refId, label: `${c.reference} · ${String(c.question ?? '').slice(0, 60)}` })) },
        { name: 'answer', label: 'Answer', type: 'textarea', rows: 3 },
        { name: 'issueToAllBidders', label: 'Issued to', type: 'select',
          options: [{ value: 'true', label: 'Every bidder — the only answer the platform accepts' }] },
      ],
      transform: ({ clarificationId, issueToAllBidders, ...rest }) => ({
        ...rest,
        issueToAllBidders: issueToAllBidders === 'true',
      }),
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
    /*
     * The loop closing on the bid — L7.6.
     *
     * Four doors and a gate between them. A signal is what the record supports;
     * a lesson is what somebody decided to act on; and the two are kept apart
     * because a correction that goes into every future estimate is not a thing
     * one person decides on their own.
     */
    'calibration-propose': {
      title: 'Propose a calibration',
      intent:
        'Turn a signal the record supports into a correction somebody can act on. Refused where the record is too ' +
        'thin — a factor built on a single bid is an anecdote with a percentage sign on it, and once it is in the ' +
        'library nobody remembers it was one bid.',
      path: '/v1/calibration/lessons',
      submitLabel: 'Propose',
      fields: [
        { name: 'signalId', label: 'Signal', type: 'select',
          options: (calibration?.signals ?? []).map((sig) => ({
            value: sig.id,
            label: `${sig.subject} — ${sig.deltaPercent === null ? 'no reading' : `${sig.deltaPercent}%`}, ${sig.observations} observation(s)`,
          })) },
        { name: 'adjustmentPercent', label: 'Correction (%)', type: 'number',
          hint: 'Positive means our figure runs low against what actually happened. Nothing beyond 40 either way.' },
        { name: 'rationale', label: 'Why the record supports it', type: 'textarea', rows: 3,
          hint: 'At least 20 characters. Repeating the signal’s own sentence is not a reason to act on it.' },
      ],
    },
    'calibration-promote': {
      title: 'Promote a calibration',
      intent:
        'Gate G7. Until this runs the lesson changes nothing anybody sees; after it, every median the estimate ' +
        'benchmark compares against is corrected by it and says so. You cannot promote one you proposed.',
      path: (v) => `/v1/calibration/lessons/${v.lessonId}/promote`,
      submitLabel: 'Promote',
      fields: [
        { name: 'lessonId', label: 'Calibration', type: 'select',
          options: (lessons?.lessons ?? [])
            .filter((lesson) => lesson.status === 'PROPOSED')
            .map((lesson) => ({ value: lesson.id, label: `${lesson.reference} · ${lesson.subject} · ${lesson.adjustmentPercent}%` })) },
        { name: 'note', label: 'What you checked', type: 'textarea', rows: 2,
          hint: 'At least 12 characters. A promoted lesson carries its approver, and an approver with nothing recorded is a name on a decision nobody can reconstruct.' },
      ],
      transform: ({ lessonId: _lessonId, ...rest }) => rest,
    },
    'calibration-reject': {
      title: 'Refuse a calibration',
      intent:
        'Kept rather than deleted. A correction somebody looked at and refused is part of the record, and deleting ' +
        'it means the next person proposes the same one.',
      path: (v) => `/v1/calibration/lessons/${v.lessonId}/reject`,
      submitLabel: 'Refuse',
      fields: [
        { name: 'lessonId', label: 'Calibration', type: 'select',
          options: (lessons?.lessons ?? [])
            .filter((lesson) => lesson.status === 'PROPOSED')
            .map((lesson) => ({ value: lesson.id, label: `${lesson.reference} · ${lesson.subject}` })) },
        { name: 'reason', label: 'Why', type: 'textarea', rows: 2 },
      ],
      transform: ({ lessonId: _lessonId, ...rest }) => rest,
    },
    'calibration-retire': {
      title: 'Retire a calibration',
      intent:
        'Stop applying a promoted correction. What was true about last year’s market is not true for ever, and a ' +
        'library nobody can retire from is one that accumulates.',
      path: (v) => `/v1/calibration/lessons/${v.lessonId}/retire`,
      submitLabel: 'Retire',
      fields: [
        { name: 'lessonId', label: 'Calibration', type: 'select',
          options: (lessons?.lessons ?? [])
            .filter((lesson) => lesson.status === 'PROMOTED')
            .map((lesson) => ({ value: lesson.id, label: `${lesson.reference} · ${lesson.subject} · ${lesson.adjustmentPercent}%` })) },
        { name: 'reason', label: 'Why', type: 'textarea', rows: 2 },
      ],
      transform: ({ lessonId: _lessonId, ...rest }) => rest,
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

    // ---- T-WF-05 -----------------------------------------------------------

    route: {
      title: 'Buy it or do it',
      intent:
        'Every package is priced twice and one of the two answers goes in the bid. Link the return comparison and the market side ' +
        'is read from it — there is one register of the adjustments, not two.',
      path: `/v1/projects/${projectId}/pricing-routes`,
      submitLabel: 'Open',
      fields: [
        { name: 'packageReference', label: 'Package', type: 'text' },
        { name: 'comparisonId', label: 'Return comparison', type: 'select', required: false,
          options: intel.comparisons.map((c) => ({ value: c.comparisonId, label: `${c.reference} · ${c.packageReference}` })) },
      ],
    },

    selfPerform: {
      title: 'Price it ourselves',
      intent:
        'Kept independent of the quotations. A self-perform estimate built after seeing them is not an estimate, it is a reaction ' +
        'to them, and it will land just under the cheapest one every time.',
      path: (collected) => `/v1/projects/${projectId}/pricing-routes/${collected.routeId}/self-perform`,
      submitLabel: 'Record',
      fields: [
        { name: 'routeId', label: 'Package route', type: 'select',
          options: openRoutes.map((r) => ({ value: r.routeId, label: `${r.reference} · ${r.packageReference}` })) },
        { name: 'directCostMinor', label: 'Our direct cost', type: 'number', money: true },
        { name: 'durationWeeks', label: 'Weeks on site', type: 'number', min: 1 },
        { name: 'peakLabour', label: 'Peak operatives', type: 'number', min: 1,
          hint: 'Capacity is what constrains a self-perform route' },
        { name: 'basis', label: 'How the estimate was built', type: 'textarea', rows: 2 },
        { name: 'retainedRisks', label: 'What we carry by doing it', type: 'textarea', rows: 2, required: false, hint: 'One per line' },
      ],
      transform: ({ routeId, retainedRisks, ...rest }) => ({
        ...rest,
        retainedRisks: String(retainedRisks ?? '').split('\n').map((x) => x.trim()).filter(Boolean),
      }),
    },

    evaluation: {
      title: 'What choosing this route costs us',
      intent:
        'Beyond the price. Signed, because a firm that takes design responsibility off us genuinely costs less than its price — ' +
        'and refusing that would push the saving into a fudge somewhere nobody can see it.',
      path: (collected) => `/v1/projects/${projectId}/pricing-routes/${collected.routeId}/evaluation`,
      submitLabel: 'Record',
      fields: [
        { name: 'routeId', label: 'Package route', type: 'select',
          options: openRoutes.map((r) => ({ value: r.routeId, label: `${r.reference} · ${r.packageReference}` })) },
        { name: 'partyId', label: 'Firm', type: 'text', required: false, hint: 'Leave blank for the self-perform route' },
        { name: 'head', label: 'What it is', type: 'select',
          options: [
            { value: 'RISK', label: 'Risk — what they carry back to us' },
            { value: 'INTERFACE', label: 'Interface — what somebody has to manage across' },
            { value: 'MANAGEMENT', label: 'Management — our own time on it' },
            { value: 'PROGRAMME', label: 'Programme — what their dates cost' },
          ] },
        { name: 'amountMinor', label: 'Amount', type: 'number', money: true, hint: 'Negative where the route costs us less than its price' },
        { name: 'basis', label: 'What it rests on', type: 'textarea', rows: 2 },
      ],
      transform: ({ routeId, partyId, ...rest }) => ({
        ...rest,
        ...(String(partyId ?? '').trim() ? { partyId } : {}),
      }),
    },

    exclusion: {
      title: 'Dispose of an exclusion',
      intent:
        'A return that excludes scaffold is not cheaper; it is incomplete, and the scaffold is ours until somebody says otherwise. ' +
        'Price it, point at the clarification that says it is not ours, or accept it as a project exclusion the client carries.',
      path: (collected) => `/v1/projects/${projectId}/pricing-routes/${collected.routeId}/exclusions`,
      submitLabel: 'Dispose',
      fields: [
        { name: 'routeId', label: 'Package route', type: 'select',
          options: openRoutes.map((r) => ({ value: r.routeId, label: `${r.reference} · ${r.packageReference}` })) },
        { name: 'partyId', label: 'Firm', type: 'text' },
        { name: 'exclusion', label: 'The exclusion, as they wrote it', type: 'text' },
        { name: 'disposition', label: 'What happens to it', type: 'select',
          options: [
            { value: 'PRICED', label: 'Priced — we carry an allowance for it' },
            { value: 'CLARIFIED', label: 'Clarified — an issued clarification says it is not ours' },
            { value: 'PROJECT_EXCLUSION', label: 'Project exclusion — the client carries it' },
          ] },
        { name: 'amountMinor', label: 'Allowance', type: 'number', money: true, required: false, hint: 'Required when pricing it' },
        { name: 'reference', label: 'Clarification or bid exclusion reference', type: 'text', required: false },
      ],
      transform: ({ routeId, amountMinor, reference, ...rest }) => ({
        ...rest,
        ...(String(amountMinor ?? '').trim() ? { amountMinor: Number(amountMinor) } : {}),
        ...(String(reference ?? '').trim() ? { reference } : {}),
      }),
    },

    interest: {
      title: 'Declare an interest',
      intent:
        'Before the selection, never after — declaring it afterwards is not a declaration, it is an explanation. The person who ' +
        'declares it cannot then make the decision on that firm.',
      path: (collected) => `/v1/projects/${projectId}/pricing-routes/${collected.routeId}/interests`,
      submitLabel: 'Declare',
      fields: [
        { name: 'routeId', label: 'Package route', type: 'select',
          options: openRoutes.map((r) => ({ value: r.routeId, label: `${r.reference} · ${r.packageReference}` })) },
        { name: 'partyId', label: 'Firm', type: 'text' },
        { name: 'name', label: 'Firm name', type: 'text' },
        { name: 'nature', label: 'What the connection is', type: 'textarea', rows: 2 },
      ],
      transform: ({ routeId, ...rest }) => rest,
    },

    selectRoute: {
      title: 'Choose the route',
      intent:
        'On cost, risk, programme and capacity together — none of them optional. The cheapest evaluated option does not have to ' +
        'win, but choosing another has to say so out loud, because that is the sentence somebody will be asked about.',
      path: (collected) => `/v1/projects/${projectId}/pricing-routes/${collected.routeId}/select`,
      submitLabel: 'Choose',
      fields: [
        { name: 'routeId', label: 'Package route', type: 'select',
          options: openRoutes.map((r) => ({ value: r.routeId, label: `${r.reference} · ${r.packageReference}` })) },
        { name: 'route', label: 'Which route', type: 'select',
          options: [
            { value: 'SUPPLY_CHAIN', label: 'Buy it — a firm from the market' },
            { value: 'SELF_PERFORM', label: 'Do it — our own people' },
          ] },
        { name: 'partyId', label: 'Firm', type: 'text', required: false, hint: 'For the supply-chain route' },
        { name: 'rationale', label: 'Why', type: 'textarea', rows: 2 },
        { name: 'costBasis', label: 'Cost basis', type: 'text' },
        { name: 'riskBasis', label: 'Risk basis', type: 'text' },
        { name: 'programmeBasis', label: 'Programme basis', type: 'text' },
        { name: 'capacityBasis', label: 'Capacity basis', type: 'text' },
      ],
      transform: ({ routeId, partyId, ...rest }) => ({
        ...rest,
        ...(String(partyId ?? '').trim() ? { partyId } : {}),
      }),
    },

    // ---- T-WF-04 -----------------------------------------------------------

    enquiry: {
      title: 'Open an enquiry',
      intent:
        'The pack that goes to the market, and the record of which revision of it each firm actually holds. Everything else on ' +
        'this enquiry hangs off that one fact.',
      path: `/v1/projects/${projectId}/enquiries`,
      submitLabel: 'Open',
      fields: [
        { name: 'packageReference', label: 'Package', type: 'text' },
        { name: 'title', label: 'What is being bought', type: 'text' },
        { name: 'returnDeadline', label: 'Returns by', type: 'datetime-local' },
      ],
      transform: ({ returnDeadline, ...rest }) => ({ ...rest, returnDeadline: new Date(returnDeadline).toISOString() }),
    },

    packRevision: {
      title: 'Compose a pack revision',
      intent:
        'The first is revision 1; every later one is the addendum. Composing after issue makes every firm’s acknowledgement stale ' +
        'by name, which is the single thing that stops five prices being compared across two different scopes.',
      path: (collected) => `/v1/projects/${projectId}/enquiries/${collected.enquiryId}/revisions`,
      submitLabel: 'Compose',
      fields: [
        { name: 'enquiryId', label: 'Enquiry', type: 'select',
          options: liveEnquiries.map((e) => ({ value: e.enquiryId, label: `${e.reference} · ${e.title}` })) },
        { name: 'documents', label: 'Documents', type: 'textarea', rows: 6,
          hint: 'One per line: reference, title, revision, kind. Kind is scope, pricing_schedule, drawings, specification, programme or contract_terms' },
        { name: 'note', label: 'What changed', type: 'text', required: false },
        { name: 'missing', label: 'Issuing without', type: 'text', required: false,
          hint: 'Comma-separated kinds. Only where the pack genuinely lacks them' },
        { name: 'reason', label: 'Why it is going out short', type: 'textarea', rows: 2, required: false },
        { name: 'authorisedBy', label: 'Who is accepting that risk', type: 'text', required: false },
      ],
      transform: ({ enquiryId, documents, note, missing, reason, authorisedBy }) => ({
        documents: String(documents ?? '')
          .split('\n')
          .map((line) => line.split(',').map((part) => part.trim()))
          .filter((parts) => parts[0] && parts[3])
          .map((parts) => ({
            reference: parts[0],
            title: parts[1] || parts[0],
            revision: parts[2] || 'A',
            kind: String(parts[3]).toUpperCase(),
          })),
        ...(String(note ?? '').trim() ? { note } : {}),
        ...(String(missing ?? '').trim()
          ? {
              exception: {
                missing: String(missing).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean),
                reason: String(reason ?? ''),
                authorisedBy: String(authorisedBy ?? ''),
              },
            }
          : {}),
      }),
    },

    approvePack: {
      title: 'Approve the pack for issue',
      intent:
        'Approval is somebody taking responsibility for what is about to bind every firm that prices it — so it is never a second ' +
        'click by the person who assembled it, even where that person holds the authority.',
      path: (collected) => `/v1/projects/${projectId}/enquiries/${collected.enquiryId}/approve`,
      submitLabel: 'Approve',
      fields: [
        { name: 'enquiryId', label: 'Enquiry', type: 'select',
          options: liveEnquiries
            .filter((e) => !e.approved)
            .map((e) => ({ value: e.enquiryId, label: `${e.reference} · rev ${e.revision}` })) },
      ],
      transform: () => ({}),
    },

    issueEnquiry: {
      title: 'Issue to bidders',
      intent:
        'Each firm gets its own record naming the revision it holds and that revision’s content hash. A firm whose access was ' +
        'revoked is refused here — re-inviting one is a decision, not a side effect of a distribution list.',
      path: (collected) => `/v1/projects/${projectId}/enquiries/${collected.enquiryId}/issue`,
      submitLabel: 'Issue',
      fields: [
        { name: 'enquiryId', label: 'Enquiry', type: 'select',
          options: liveEnquiries
            .filter((e) => e.approved)
            .map((e) => ({ value: e.enquiryId, label: `${e.reference} · rev ${e.revision}` })) },
        { name: 'recipients', label: 'Firms', type: 'textarea', rows: 4, hint: 'One per line: party-id, name' },
      ],
      transform: ({ enquiryId, recipients }) => ({
        recipients: String(recipients ?? '')
          .split('\n')
          .map((line) => line.split(',').map((part) => part.trim()))
          .filter((parts) => parts[0])
          .map((parts) => ({ partyId: parts[0], name: parts[1] || parts[0] })),
      }),
    },

    bidderState: {
      title: 'Record a bidder response',
      intent:
        'Forward only. A delivery receipt arriving after an acknowledgement is an out-of-order webhook, not a firm ' +
        'un-acknowledging, so the later state stands.',
      path: (collected) => `/v1/projects/${projectId}/enquiries/${collected.enquiryId}/state`,
      submitLabel: 'Record',
      fields: [
        { name: 'enquiryId', label: 'Enquiry', type: 'select',
          options: liveEnquiries
            .filter((e) => e.issued > 0)
            .map((e) => ({ value: e.enquiryId, label: `${e.reference} · ${e.title}` })) },
        { name: 'partyId', label: 'Firm', type: 'text' },
        { name: 'state', label: 'What happened', type: 'select',
          options: [
            { value: 'DELIVERED', label: 'Delivered' },
            { value: 'OPENED', label: 'Opened' },
            { value: 'ACKNOWLEDGED', label: 'Acknowledged — they have the revision they hold' },
            { value: 'DECLINED', label: 'Declined' },
          ] },
      ],
      transform: ({ enquiryId, ...rest }) => rest,
    },

    revokeBidder: {
      title: 'Remove a bidder from the enquiry',
      intent:
        'The issue evidence stays. That firm did receive the revision it received, and this is an additional fact rather than a ' +
        'correction of the earlier one.',
      path: (collected) => `/v1/projects/${projectId}/enquiries/${collected.enquiryId}/revoke`,
      submitLabel: 'Remove',
      fields: [
        { name: 'enquiryId', label: 'Enquiry', type: 'select',
          options: enquiries.enquiries
            .filter((e) => e.issued > 0)
            .map((e) => ({ value: e.enquiryId, label: `${e.reference} · ${e.title}` })) },
        { name: 'partyId', label: 'Firm', type: 'text' },
        { name: 'reason', label: 'Why', type: 'textarea', rows: 2 },
      ],
      transform: ({ enquiryId, ...rest }) => rest,
    },

    closeEnquiry: {
      title: 'Close the return period',
      intent:
        'After this the workspace takes nothing without a person putting their name to it. Declined and silent are reported ' +
        'separately, because a supply chain is read from the difference between them.',
      path: (collected) => `/v1/projects/${projectId}/enquiries/${collected.enquiryId}/close`,
      submitLabel: 'Close',
      fields: [
        { name: 'enquiryId', label: 'Enquiry', type: 'select',
          options: liveEnquiries
            .filter((e) => e.status === 'ISSUED')
            .map((e) => ({ value: e.enquiryId, label: `${e.reference} · ${e.title}` })) },
      ],
      transform: () => ({}),
    },

    lateReturn: {
      title: 'Accept a late return',
      intent:
        'Not refused — refusing outright only moves the decision into an email. It costs an approval and a named authority, and it ' +
        'sits on the record beside every return that met the date.',
      path: (collected) => `/v1/projects/${projectId}/enquiries/${collected.enquiryId}/late`,
      submitLabel: 'Accept',
      fields: [
        { name: 'enquiryId', label: 'Enquiry', type: 'select',
          options: closedEnquiries.map((e) => ({ value: e.enquiryId, label: `${e.reference} · ${e.title}` })) },
        { name: 'partyId', label: 'Firm', type: 'text' },
        { name: 'reason', label: 'Why it is being accepted', type: 'textarea', rows: 2 },
        { name: 'authority', label: 'Under whose authority', type: 'text' },
      ],
      transform: ({ enquiryId, ...rest }) => rest,
    },

    // ---- T-WF-03 -----------------------------------------------------------

    schedule: {
      title: 'Open a measurement schedule',
      intent:
        'The measured items under the estimate. Direct cost only — preliminaries, risk and OH&P are priced once above, because a ' +
        'percentage spread across item rates is how a job whose programme moves loses money quietly.',
      path: `/v1/projects/${projectId}/measurement`,
      submitLabel: 'Open',
      fields: [
        { name: 'packageReference', label: 'Package', type: 'text' },
        { name: 'title', label: 'What it measures', type: 'text' },
        { name: 'measurementRule', label: 'Measurement rule', type: 'select', required: false,
          options: [
            { value: 'NRM2', label: 'NRM2 — building works' },
            { value: 'CESMM4', label: 'CESMM4 — civil engineering' },
            { value: 'POMI', label: 'POMI — principles of measurement (international)' },
          ] },
        { name: 'currency', label: 'Currency', type: 'text', required: false, hint: 'Defaults to GBP' },
      ],
    },

    items: {
      title: 'Record measured items',
      intent:
        'Every quantity names the drawing and revision it came off, or the person who authorised the allowance. A formula is ' +
        're-evaluated against the quantity beside it — the transposition between the two is the commonest error in a bill.',
      path: (collected) => `/v1/projects/${projectId}/measurement/${collected.scheduleId}/items`,
      submitLabel: 'Record',
      fields: [
        { name: 'scheduleId', label: 'Schedule', type: 'select',
          options: openSchedules.map((s) => ({ value: s.scheduleId, label: `${s.reference} · ${s.title}` })) },
        { name: 'reference', label: 'Item reference', type: 'text', hint: 'The reference on the paper the client sees' },
        { name: 'parent', label: 'Sits under', type: 'text', required: false },
        { name: 'description', label: 'Description', type: 'textarea', rows: 2 },
        { name: 'unit', label: 'Unit', type: 'text',
          suggestions: (units.units ?? []).map((unit) => ({ value: unit.symbol, label: `${unit.label} — ${unit.dimension.toLowerCase()}` })),
          hint: 'Anything is accepted. A unit outside this list is reported as unchecked rather than refused.' },
        { name: 'quantity', label: 'Quantity', type: 'number' },
        { name: 'formula', label: 'Formula', type: 'text', required: false, hint: 'e.g. 12.4 * 3.85 * 2 — checked against the quantity' },
        { name: 'basis', label: 'Basis', type: 'select',
          options: [
            { value: 'MEASURED', label: 'Measured — firm' },
            { value: 'PROVISIONAL', label: 'Provisional — remeasured on site' },
            { value: 'APPROXIMATE', label: 'Approximate — measured off information not trusted' },
            { value: 'ALLOWANCE', label: 'Allowance — nobody measured it' },
          ] },
        { name: 'drawing', label: 'Measured from drawing', type: 'text', required: false },
        { name: 'revision', label: 'Revision', type: 'text', required: false },
        { name: 'sheet', label: 'Sheet', type: 'text', required: false },
        { name: 'modelObjectSet', label: 'Or model object set', type: 'text', required: false },
        { name: 'allowanceBasis', label: 'Allowance basis', type: 'text', required: false,
          hint: 'What the allowance is based on. Required for an allowance' },
        { name: 'authorisedBy', label: 'Allowance authorised by', type: 'text', required: false },
      ],
      transform: ({ scheduleId, drawing, revision, sheet, modelObjectSet, allowanceBasis, authorisedBy, parent, formula, ...rest }) => ({
        items: [
          {
            ...rest,
            ...(String(parent ?? '').trim() ? { parent } : {}),
            ...(String(formula ?? '').trim() ? { formula } : {}),
            quantity: Number(rest.quantity),
            source: Object.fromEntries(
              Object.entries({ drawing, revision, sheet, modelObjectSet, allowanceBasis, authorisedBy }).filter(
                ([, value]) => String(value ?? '').trim(),
              ),
            ),
          },
        ],
      }),
    },

    rate: {
      title: 'Build a rate',
      intent:
        'Resource constants times resource costs — 0.85 hours of concretor at £28.40, 1.02 m³ of ready-mix at £118 with 5% waste. ' +
        'Holding the components rather than the answer is what makes a rate arguable, reusable and repriceable when the labour rate moves.',
      path: (collected) => `/v1/projects/${projectId}/measurement/${collected.scheduleId}/rates`,
      submitLabel: 'Build',
      fields: [
        { name: 'scheduleId', label: 'Schedule', type: 'select',
          options: openSchedules.map((s) => ({ value: s.scheduleId, label: `${s.reference} · ${s.title}` })) },
        { name: 'reference', label: 'Item reference', type: 'text' },
        { name: 'components', label: 'Components', type: 'textarea', rows: 5,
          hint: 'One per line: kind, description, unit cost, constant [, waste %]. Kind is labour, material, plant or subcontract' },
      ],
      transform: ({ scheduleId, reference, components }) => ({
        reference,
        components: String(components ?? '')
          .split('\n')
          .map((line) => line.split(',').map((part) => part.trim()))
          .filter((parts) => parts[0] && parts[2] && parts[3])
          .map((parts) => ({
            kind: String(parts[0]).toUpperCase(),
            description: parts[1] || parts[0],
            unitCostMinor: Math.round(Number(parts[2]) * 100),
            constant: Number(parts[3]),
            ...(parts[4] ? { wastePercent: Number(parts[4]) } : {}),
          })),
      }),
    },

    revision: {
      title: 'A drawing has been reissued',
      intent:
        'Every item measured from the superseded revision is named, and the schedule will not freeze until each has been looked at. ' +
        'Not because they have all changed — most will not have — but because which ones did is the question nobody can answer later.',
      path: (collected) => `/v1/projects/${projectId}/measurement/${collected.scheduleId}/revisions`,
      submitLabel: 'Record the reissue',
      fields: [
        { name: 'scheduleId', label: 'Schedule', type: 'select',
          options: openSchedules.map((s) => ({ value: s.scheduleId, label: `${s.reference} · ${s.title}` })) },
        { name: 'drawing', label: 'Drawing', type: 'text' },
        { name: 'fromRevision', label: 'Superseded revision', type: 'text' },
        { name: 'toRevision', label: 'New revision', type: 'text' },
      ],
      transform: ({ scheduleId, ...rest }) => rest,
    },

    remeasure: {
      title: 'Record a remeasurement',
      intent:
        'Say what it found, including where it found nothing. "Unchanged" is a real and common answer and has to be recorded — ' +
        'otherwise there is no way to tell an item somebody checked from one nobody opened.',
      path: (collected) => `/v1/projects/${projectId}/measurement/${collected.scheduleId}/remeasure`,
      submitLabel: 'Record',
      fields: [
        { name: 'scheduleId', label: 'Schedule', type: 'select',
          options: bill.schedules
            .filter((s) => s.openRemeasure > 0)
            .map((s) => ({ value: s.scheduleId, label: `${s.reference} · ${s.openRemeasure} waiting` })) },
        { name: 'reference', label: 'Item reference', type: 'text' },
        { name: 'revision', label: 'Measured against revision', type: 'text' },
        { name: 'quantity', label: 'New quantity', type: 'number', required: false, hint: 'Leave blank where nothing changed' },
        { name: 'outcome', label: 'What the remeasurement found', type: 'textarea', rows: 2 },
      ],
      transform: ({ scheduleId, quantity, ...rest }) => ({
        ...rest,
        ...(String(quantity ?? '').trim() ? { quantity: Number(quantity) } : {}),
      }),
    },

    freezeSchedule: {
      title: 'Freeze the measurement schedule',
      intent:
        'Refused while the bill states something untrue, while an item carries no rate, or while a reissued drawing has not been ' +
        'looked at. After it, a change is a new schedule — otherwise the number that went out is no longer reproducible.',
      path: (collected) => `/v1/projects/${projectId}/measurement/${collected.scheduleId}/freeze`,
      submitLabel: 'Freeze',
      fields: [
        { name: 'scheduleId', label: 'Schedule', type: 'select',
          options: openSchedules.map((s) => ({ value: s.scheduleId, label: `${s.reference} · ${s.title}` })) },
        { name: 'reason', label: 'What it is being frozen for', type: 'textarea', rows: 2 },
      ],
      transform: ({ scheduleId, ...rest }) => rest,
    },

    // ---- T-WF-06 -----------------------------------------------------------

    clarification: {
      title: 'Raise a clarification',
      intent:
        'A question against the exact information it concerns. An answer that is not attached to a document, clause, drawing, package or ' +
        'scope item will not be found by the person who prices that thing a fortnight later, so at least one is required.',
      path: `/v1/projects/${projectId}/tender-clarifications`,
      submitLabel: 'Raise',
      fields: [
        { name: 'side', label: 'Between', type: 'select',
          options: [
            { value: 'INTERNAL', label: 'Internal — the bid team asking itself' },
            { value: 'CLIENT', label: 'To the client or their agent' },
            { value: 'BIDDER', label: 'From a firm pricing one of our packages' },
          ] },
        { name: 'subject', label: 'Subject', type: 'text' },
        { name: 'question', label: 'The question', type: 'textarea', rows: 3 },
        { name: 'document', label: 'Document', type: 'text', required: false },
        { name: 'clause', label: 'Clause', type: 'text', required: false },
        { name: 'drawing', label: 'Drawing', type: 'text', required: false },
        { name: 'package', label: 'Package', type: 'text', required: false },
        { name: 'scopeItem', label: 'Scope item', type: 'text', required: false },
        { name: 'responseDeadline', label: 'Answer needed by', type: 'date', required: false },
        { name: 'confidentiality', label: 'Confidentiality', type: 'select', required: false,
          options: [
            { value: 'OPEN', label: 'Open — goes to everybody entitled to it' },
            { value: 'COMMERCIAL_IN_CONFIDENCE', label: 'In confidence — this bidder only' },
          ] },
        { name: 'bidderPartyId', label: 'Bidder', type: 'select', required: false,
          hint: 'Required for a question from a bidder',
          options: (suppliers.suppliers ?? []).map((sup) => ({ value: sup.id, label: sup.name })) },
      ],
      transform: ({ document, clause, drawing, package: pkg, scopeItem, ...rest }) => ({
        ...rest,
        links: Object.fromEntries(
          Object.entries({ document, clause, drawing, package: pkg, scopeItem }).filter(([, value]) => String(value ?? '').trim()),
        ),
      }),
    },

    issueClarification: {
      title: 'Issue the answer',
      intent:
        'Who it goes to and when is the record. A commercial-in-confidence answer reaching a competitor is refused, and so is an open ' +
        'answer that reaches only the firm that asked — returns priced on different information are not comparable.',
      path: (collected) => `/v1/projects/${projectId}/tender-clarifications/${collected.clarificationId}/issue`,
      submitLabel: 'Issue',
      fields: [
        { name: 'clarificationId', label: 'Clarification', type: 'select',
          options: intel.clarifications
            .filter((c) => c.status === 'OPEN')
            .map((c) => ({ value: c.clarificationId, label: `${c.reference} · ${c.subject}` })) },
        { name: 'response', label: 'The answer', type: 'textarea', rows: 3 },
        { name: 'recipients', label: 'Goes to', type: 'textarea', rows: 3,
          hint: 'One per line: party-id, name, bidder or internal' },
        { name: 'entitledBidders', label: 'Every bidder entitled to it', type: 'text', required: false,
          hint: 'Comma-separated party ids. Leave blank if this is not a bidder question' },
      ],
      transform: ({ clarificationId, recipients, entitledBidders, ...rest }) => ({
        ...rest,
        recipients: String(recipients ?? '')
          .split('\n')
          .map((line) => line.split(',').map((part) => part.trim()))
          .filter((parts) => parts[0])
          .map((parts) => ({ partyId: parts[0], name: parts[1] || parts[0], isBidder: (parts[2] ?? '').toLowerCase() === 'bidder' })),
        ...(String(entitledBidders ?? '').trim()
          ? { entitledBidders: String(entitledBidders).split(',').map((x) => x.trim()).filter(Boolean) }
          : {}),
      }),
    },

    comparison: {
      title: 'Open a comparison',
      intent:
        'The returns against one package, on one basis. The deadline and the information cut-off are what the prices were built on, and ' +
        'recording them is what makes the comparison mean something six weeks later.',
      path: `/v1/projects/${projectId}/return-comparisons`,
      submitLabel: 'Open',
      fields: [
        { name: 'packageReference', label: 'Package', type: 'text' },
        { name: 'returnDeadline', label: 'Return deadline', type: 'datetime-local' },
        { name: 'informationCutOff', label: 'Information cut-off', type: 'text',
          hint: 'The last addendum the returns were priced against' },
        { name: 'bidders', label: 'Firms', type: 'textarea', rows: 3, hint: 'One per line: party-id, name' },
      ],
      transform: ({ bidders, returnDeadline, ...rest }) => ({
        ...rest,
        returnDeadline: new Date(returnDeadline).toISOString(),
        bidders: String(bidders ?? '')
          .split('\n')
          .map((line) => line.split(',').map((part) => part.trim()))
          .filter((parts) => parts[0])
          .map((parts) => ({ partyId: parts[0], name: parts[1] || parts[0] })),
      }),
    },

    rawReturn: {
      title: 'Record a return',
      intent:
        'Exactly as it arrived. It is written once and never edited — a correction to what they meant is an adjustment, which keeps ' +
        'their own number visible beside it.',
      path: (collected) => `/v1/projects/${projectId}/return-comparisons/${collected.comparisonId}/returns`,
      submitLabel: 'Record',
      fields: [
        { name: 'comparisonId', label: 'Comparison', type: 'select',
          options: intel.comparisons
            .filter((c) => c.status === 'OPEN')
            .map((c) => ({ value: c.comparisonId, label: `${c.reference} · ${c.packageReference}` })) },
        { name: 'bidderPartyId', label: 'Firm', type: 'text', hint: 'The party id used when the comparison was opened' },
        { name: 'submittedAt', label: 'Received at', type: 'datetime-local' },
        { name: 'lines', label: 'Priced lines', type: 'textarea', rows: 4,
          hint: 'One per line: ref, description, amount in major units' },
        { name: 'exclusions', label: 'Exclusions', type: 'textarea', rows: 2, required: false, hint: 'One per line' },
        { name: 'qualifications', label: 'Qualifications', type: 'textarea', rows: 2, required: false, hint: 'One per line' },
      ],
      transform: ({ comparisonId, submittedAt, lines, exclusions, qualifications, bidderPartyId }) => ({
        bidderPartyId,
        submittedAt: new Date(submittedAt).toISOString(),
        lines: String(lines ?? '')
          .split('\n')
          .map((line) => line.split(',').map((part) => part.trim()))
          .filter((parts) => parts[0] && parts[2])
          .map((parts) => ({
            reference: parts[0],
            description: parts[1] || parts[0],
            amountMinor: Math.round(Number(parts[2]) * 100),
          })),
        exclusions: String(exclusions ?? '').split('\n').map((x) => x.trim()).filter(Boolean),
        qualifications: String(qualifications ?? '').split('\n').map((x) => x.trim()).filter(Boolean),
      }),
    },

    adjustment: {
      title: 'Adjust a return onto the common basis',
      intent:
        'Every adjustment cites the return line it corrects or the clarification that authorises it. Without one, the adjustment cannot ' +
        'be told apart from a preference once the meeting is over, and it is refused.',
      path: (collected) => `/v1/projects/${projectId}/return-comparisons/${collected.comparisonId}/adjustments`,
      submitLabel: 'Adjust',
      fields: [
        { name: 'comparisonId', label: 'Comparison', type: 'select',
          options: intel.comparisons
            .filter((c) => c.status === 'OPEN')
            .map((c) => ({ value: c.comparisonId, label: `${c.reference} · ${c.packageReference}` })) },
        { name: 'bidderPartyId', label: 'Firm', type: 'text' },
        { name: 'category', label: 'What kind of adjustment', type: 'select',
          options: [
            { value: 'SCOPE_ADDED', label: 'Scope added' },
            { value: 'SCOPE_REMOVED', label: 'Scope removed' },
            { value: 'EXCLUSION_PRICED', label: 'Exclusion priced back in' },
            { value: 'QUALIFICATION_PRICED', label: 'Qualification priced' },
            { value: 'ATTENDANCE_MOVED', label: 'Attendance moved' },
            { value: 'PROGRAMME_IMPACT', label: 'Programme impact' },
            { value: 'TAX_OR_CURRENCY', label: 'Tax or currency' },
            { value: 'ARITHMETIC_CORRECTION', label: 'Arithmetic correction' },
          ] },
        { name: 'amountMinor', label: 'Amount', type: 'number', money: true,
          hint: 'Positive adds to this firm’s evaluated cost' },
        { name: 'reason', label: 'Reason', type: 'textarea', rows: 2 },
        { name: 'fromReturnLine', label: 'From return line', type: 'text', required: false },
        { name: 'fromClarification', label: 'From clarification', type: 'select', required: false,
          options: intel.clarifications
            .filter((c) => c.status !== 'OPEN')
            .map((c) => ({ value: c.reference, label: `${c.reference} · ${c.subject}` })) },
      ],
      transform: ({ comparisonId, ...rest }) => rest,
    },

    comparisonQuery: {
      title: 'Raise a query against a return',
      intent:
        'A material query is one that moves the number. While it is open the ranking is withheld and what it is worth is carried into ' +
        'adjudication as a stated risk, so a material query with nothing at stake is refused.',
      path: (collected) => `/v1/projects/${projectId}/return-comparisons/${collected.comparisonId}/queries`,
      submitLabel: 'Raise',
      fields: [
        { name: 'comparisonId', label: 'Comparison', type: 'select',
          options: intel.comparisons
            .filter((c) => c.status === 'OPEN')
            .map((c) => ({ value: c.comparisonId, label: `${c.reference} · ${c.packageReference}` })) },
        { name: 'bidderPartyId', label: 'Firm', type: 'text' },
        { name: 'subject', label: 'The query', type: 'textarea', rows: 2 },
        { name: 'material', label: 'Does it move the number?', type: 'select',
          options: [
            { value: 'true', label: 'Material — the comparison cannot be relied on until it is answered' },
            { value: 'false', label: 'Immaterial — worth recording, does not change the price' },
          ] },
        { name: 'valueAtRiskMinor', label: 'Worth, if it goes the wrong way', type: 'number', money: true },
      ],
      transform: ({ comparisonId, material, ...rest }) => ({ ...rest, material: material === 'true' }),
    },

    closeComparison: {
      title: 'Close for adjudication',
      intent:
        'Deliberately not refused while a query is open — a deadline does not wait, and refusing here would only teach people to mark ' +
        'queries immaterial. What is recorded is exactly what is being carried, so adjudication sees it.',
      path: (collected) => `/v1/projects/${projectId}/return-comparisons/${collected.comparisonId}/close`,
      submitLabel: 'Close',
      fields: [
        { name: 'comparisonId', label: 'Comparison', type: 'select',
          options: intel.comparisons
            .filter((c) => c.status === 'OPEN')
            .map((c) => ({ value: c.comparisonId, label: `${c.reference} · ${c.packageReference}` })) },
        { name: 'rationale', label: 'Why it is being closed in the state it is in', type: 'textarea', rows: 2 },
      ],
      transform: ({ comparisonId, ...rest }) => rest,
    },
  };

  void insightPanel(root.querySelector('#procurement-insight'), {
    projectId,
    areas: ['PROCUREMENT_AWARD', 'ESTIMATE_TENDER', 'BOQ_TAKEOFF'],
    subject: 'tender and procurement',
    onChange: draw,
  });

  // Each chooser fetches on demand and renders its own answer, so a page that
  // already makes a dozen calls does not make five more nobody asked for.
  wireLookups(root, LOOKUPS);

  /*
   * Every command bar on the screen, not the first one.
   *
   * `querySelector` returns one element. A screen with more than one command
   * bar — and most of them have several, one per panel — wired the first and
   * left the rest inert: the buttons drew, they were not locked, they carried
   * their `data-command`, and pressing them did nothing at all. Reported as
   * "none of these work" on Pipeline & Bids, which renders six.
   *
   * Safe to bind every bar because the handler returns on an id this page does
   * not own, which is the pattern the evidence doors on this page already used
   * with `querySelectorAll` — one bar can carry buttons for two dispatchers.
   */
  /*
   * Delegated from the view, not from a `.cmd-bar` wrapper.
   *
   * `commandBar()` returns bare buttons. Whether they end up inside an element
   * classed `cmd-bar` is up to whichever page called it, and several wrap them
   * in `.actions` instead — so on those screens no listener was ever bound and
   * every button drew, unlocked, carrying its `data-command`, and did nothing.
   * That is seven commands on Concept, four on Field Modules and four more
   * elsewhere, all of them invisible to the suite because the markup is right
   * and only the binding is missing.
   *
   * Binding here removes the coupling rather than adding a second class to
   * remember. It is safe on both counts: the handler returns on an id this
   * page does not own, so two dispatchers can share one view, and `#view` is
   * a fresh element on every `draw()`, so listeners cannot stack.
   */
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    const spec = COMMANDS[button.dataset.command];
    if (!spec) return;
    const result = await command(spec);
    if (!result) return;
    // A command whose answer belongs to this screen rather than to the record
    // says so. The pack run is the only one: its proposal is not platform state
    // and nothing is written until somebody accepts it.
    spec.onResult?.(result);
    await draw();
  });
}

function badgeText(status) {
  return String(status ?? '').toLowerCase();
}

/**
 * The supplier portal, for a supplier's own sign-in.
 *
 * The panel is §13's supplier workspace — what the firm owes, what is falling
 * due, what it is waiting on — resolved server-side to the firm the identity
 * belongs to. A sign-in that belongs to no firm is told so, in the platform's
 * words, rather than shown somebody else's obligations or an empty screen.
 */
function supplierPortalPanel(portal) {
  if (!portal) return '';
  if (portal.error) {
    return html`<div class="card" style="margin-bottom:14px">
      <h2>Your site-services portal</h2>
      <div class="notice ${portal.error.code === 'SUPPLIER_UNLINKED' ? 'warn' : 'info'}" style="margin-top:8px">
        <div>${portal.error.message ?? portal.error.detail ?? 'The portal is not available for this sign-in.'}</div>
      </div>
    </div>`;
  }
  const { supplier, panel } = portal;
  const item = (entry) => html`<div style="padding:10px 0;border-top:1px solid var(--line)">
    <div style="display:flex;justify-content:space-between;gap:16px;align-items:baseline">
      <b>${entry.headline}</b>
      <span>${entry.overdue ? badge('overdue', 'bad') : entry.withinDays ? badge(`${entry.withinDays}d`, 'warn') : ''}</span>
    </div>
    <div class="metric-sub" style="margin-top:4px">${entry.why.evidence}</div>
    <div class="metric-sub" style="margin-top:4px"><b>Action.</b> ${entry.action.decision}${entry.action.dueAt ? ` By ${date(entry.action.dueAt)}.` : ''}</div>
  </div>`;
  return html`
    <div class="card" style="margin-bottom:14px">
      <h2>Your site-services portal — ${supplier.legalName}</h2>
      <div class="metric-sub" style="margin:6px 0 12px">${panel.statement}</div>
      <div class="grid g-2-1">
        <div>
          <h2>Now</h2>
          ${panel.now.length === 0 ? html`<div class="notice ok"><div>Nothing outstanding for ${supplier.legalName} today.</div></div>` : panel.now.map(item)}
        </div>
        <div>
          <h2>Next</h2>
          ${panel.next.length === 0 ? html`<div class="notice ok"><div>Nothing falls due for ${supplier.legalName} inside the month.</div></div>` : panel.next.map(item)}
        </div>
      </div>
    </div>
    ${supplierPaymentCard(portal)}
  `;
}

/**
 * The award, seen rather than read.
 *
 * A bid evaluation table is a defensible record and a poor explanation. The
 * question a challenged award has to answer is not "what did each bidder
 * score" — that is in the table — but "why did this one win", and that is a
 * shape: which criterion the winner led on, and by how much over the field.
 *
 * The scatter exists for one specific case. `cheapestIsNotWinner` is already
 * flagged in words above; plotted, the reader sees how far the cheapest bid sat
 * below the winner on quality, which is the whole of the justification.
 */
/**
 * The procurement programme, and where the field falls away.
 *
 * The charts above are about one package's returns: who scored what, and
 * whether the recommendation is defensible. What is missing from this screen —
 * and from the tables on it — is the two things that make procurement late
 * rather than wrong.
 *
 * ## When each package actually moves
 *
 * A package is not a row in a register, it is a run of dates: raised, issued,
 * returns due, awarded. The gaps between them are where the time goes, and they
 * are invisible in a table because a reader has to subtract seven ISO strings to
 * see them. Drawn as bars, a package sitting three weeks between raised and
 * issued is a shape, and so is one whose return deadline has passed with the
 * status still `ISSUED`.
 *
 * The dates are the RFQ record's own — `createdAt`, `issuedAt`,
 * `returnDeadline`, `awardedAt`, written by `backend/src/domain/procurement.ts`
 * at each transition. Nothing here is interpolated: a package with no
 * `issuedAt` is drawn up to the point it reached and no further, because a bar
 * running to a date nobody set is a schedule the platform invented.
 *
 * ## How many firms survive each step
 *
 * Invited, acknowledged, intending to bid, actually returned. Four figures that
 * exist on every enquiry and are never put beside each other, so the ordinary
 * procurement failure — eight firms invited, two returns, and the package
 * competed against itself — is discovered at the evaluation rather than in the
 * week there was still time to invite more.
 *
 * Drawn as a funnel across every package on the project rather than per
 * package, because the question it answers is about the supply chain's appetite
 * and one package is not evidence of that. The per-package position stays in
 * the register table above, which is where somebody chasing a specific enquiry
 * is already looking.
 */
function procurementProgramme(rfqs, submissions) {
  const packages = (rfqs ?? []).filter((rfq) => rfq && rfq.createdAt);
  if (packages.length === 0) return '';

  const day = (value) => (value ? String(value).slice(0, 10) : undefined);
  const now = today();

  // Returns are separate records, counted against the RFQ they answer rather
  // than taken from a figure on the RFQ — there is no such figure, and adding
  // one to the browser would be a second count of the same thing.
  const returnsBy = new Map();
  for (const submission of submissions ?? []) {
    returnsBy.set(submission.rfqId, (returnsBy.get(submission.rfqId) ?? 0) + 1);
  }

  const tasks = packages.flatMap((rfq) => {
    const reference = String(rfq.reference ?? rfq.title ?? 'Package');
    const raised = day(rfq.createdAt);
    const issued = day(rfq.issuedAt);
    const due = day(rfq.returnDeadline);
    const awarded = day(rfq.awardedAt);
    const bars = [];

    // Raised to issued: the package being made ready. A long bar here is a
    // tender pack that was not complete, which is the gate that refused it.
    if (raised && issued) {
      bars.push({ id: `${rfq.id}-prep`, label: `${reference} · preparing the pack`, start: raised, end: issued, tone: 'baseline' });
    } else if (raised && !issued) {
      bars.push({ id: `${rfq.id}-prep`, label: `${reference} · preparing the pack`, start: raised, end: now, tone: 'warn' });
    }

    // Issued to the return deadline: the firms' own time. Past the deadline
    // with no award, the bar is drawn to the deadline and the overrun is drawn
    // separately, because a tender period that has ended has ended.
    if (issued && due) {
      bars.push({ id: `${rfq.id}-tender`, label: `${reference} · out to tender`, start: issued, end: due, tone: 'actual' });
    }
    if (due && !awarded && due < now) {
      bars.push({ id: `${rfq.id}-over`, label: `${reference} · past the return deadline`, start: due, end: now, tone: 'bad' });
    }

    // Deadline to award: evaluation and the approval behind it.
    if (due && awarded) {
      bars.push({ id: `${rfq.id}-award`, label: `${reference} · evaluating and awarding`, start: due, end: awarded, tone: 'forecast' });
    }

    return bars.filter((bar) => bar.start && bar.end && bar.start <= bar.end);
  });

  const invited = packages.reduce((sum, rfq) => sum + (rfq.invitedSupplierIds ?? []).length, 0);
  const acknowledgements = packages.flatMap((rfq) => rfq.acknowledgements ?? []);
  const intending = acknowledgements.filter((entry) => entry.intendToBid !== false).length;
  const returned = packages.reduce((sum, rfq) => sum + (returnsBy.get(rfq.id) ?? 0), 0);

  const funnel =
    invited > 0
      ? funnelChart({
          title: 'Firms invited, and how many return',
          stages: [
            { label: 'Invited', value: invited, tone: 'actual' },
            { label: 'Acknowledged', value: acknowledgements.length, tone: 'cyan' },
            { label: 'Intending to bid', value: intending, tone: 'amber' },
            { label: 'Returned a price', value: returned, tone: 'green' },
          ],
          format: (value) => String(Math.round(value)),
          empty: 'No enquiry has been issued on this project.',
          footnote:
            `Across ${packages.length} package${packages.length === 1 ? '' : 's'}. ` +
            'Silence and a declined acknowledgement are different things and are counted apart: a firm that said it ' +
            'would not bid told somebody, and a firm that said nothing did not. ' +
            (returned < 3
              ? `Only ${returned} price${returned === 1 ? '' : 's'} has come back, which is a package competing against ` +
                'itself rather than against the market.'
              : 'A return that arrives after the deadline is still counted here — whether it can be accepted is the ' +
                'evaluation’s decision, not this chart’s.'),
        })
      : '';

  return html`<div class="grid g2" style="margin-bottom:14px">
    <div class="card">
      <h2>When each package actually moves</h2>
      ${raw(
        ganttChart({
          title: 'Procurement programme',
          tasks,
          scale: 'WEEK',
          showFloat: false,
          showLinks: false,
          today: now,
          empty: 'No package carries the dates to draw a programme from.',
          footnote:
            'Every date is the RFQ record’s own, written when the transition happened. A package with no issue date is ' +
            'drawn up to where it got to and no further — a bar running to a date nobody set would be a programme the ' +
            'platform invented. Red is time past a return deadline with no award against it.',
        }),
      )}
    </div>
    <div class="card">
      <h2>Where the field falls away</h2>
      ${raw(funnel)}
    </div>
  </div>`;
}

function procurementCharts(scores, coverage, costIntel) {
  const ranked = (scores ?? []).filter((score) => score && Number.isFinite(Number(score.totalScore)));

  // Coverage is a tenancy fact rather than a project one, and it is the only
  // chart here that draws when no tender is running.
  const groups = new Map();
  for (const trade of coverage?.trades ?? []) {
    const group = String(trade.group ?? 'OTHER');
    const row = groups.get(group) ?? { eligible: 0, registered: 0, trades: 0, covered: 0 };
    row.eligible += Number(trade.eligible ?? 0);
    row.registered += Number(trade.registered ?? 0);
    row.trades += 1;
    if (Number(trade.eligible ?? 0) > 0) row.covered += 1;
    groups.set(group, row);
  }
  const coverageRows = [...groups.entries()].map(([group, row]) => ({
    label: humanise(group),
    eligible: row.eligible,
    // Trades with nobody eligible are the finding. A group of eight trades and
    // three eligible firms is not "three suppliers", it is five packages that
    // cannot be competed.
    uncovered: row.trades - row.covered,
  }));

  // Rate spread, widest first. A rate the business has priced once is a data
  // point and the engine says so; a box of one observation is a line, which is
  // the honest picture of it.
  const spreads = (costIntel?.rates ?? [])
    .filter((rate) => Number(rate.observations ?? 0) > 1)
    .sort((a, b) => Number(b.spreadPercent ?? 0) - Number(a.spreadPercent ?? 0))
    .slice(0, 6)
    .map((rate) => ({
      label: `${String(rate.description).slice(0, 26)} /${rate.unit}`,
      values: [Number(rate.lowMinor), Number(rate.medianMinor), Number(rate.highMinor)],
    }));

  if (ranked.length === 0 && coverageRows.length === 0 && spreads.length === 0) return '';

  return html`
    <div class="grid g2" style="margin-bottom:14px">
      <div class="card">
        <h2>What each bid scored, and on what</h2>
        ${raw(
          barChart({
            title: 'Score composition by bidder',
            stacked: true,
            data: ranked.map((score) => ({
              label: score.supplierName,
              price: Number(score.priceScore ?? 0),
              programme: Number(score.programmeScore ?? 0),
              risk: Number(score.riskScore ?? 0),
            })),
            series: [
              { key: 'price', label: 'Price' },
              { key: 'programme', label: 'Programme' },
              { key: 'risk', label: 'Risk' },
            ],
            format: (value) => value.toFixed(3),
            empty: 'No evaluation has been run on this package.',
            footnote:
              'The weightings are the ones recorded with the evaluation, not defaults — a bar taller on price means the ' +
              'method favoured price, which is a decision somebody made before the returns were opened.',
          }),
        )}
      </div>
      <div class="card">
        <h2>Price against what the money buys</h2>
        ${raw(
          scatterPlot({
            title: 'Bid price against total score',
            points: ranked.map((score, index) => ({
              x: Number(score.priceMinor ?? 0),
              y: Number(score.totalScore ?? 0),
              label: score.supplierName,
              tone: index === 0 ? 'ok' : score.blockedFromAward ? 'bad' : undefined,
            })),
            xLabel: 'Tendered price',
            yLabel: 'Total score',
            formatX: (value) => money(value),
            formatY: (value) => value.toFixed(3),
            empty: 'No priced returns to compare.',
            footnote:
              'A cheapest bid sitting low and left of the recommendation is the award that has to be justified in writing. ' +
              'The distance between the two points is the size of that argument.',
          }),
        )}
      </div>
    </div>

    ${
      ranked.length > 1
        ? html`<div class="grid g2" style="margin-bottom:14px">
            <div class="card">
              <h2>The shortlist, side by side</h2>
              ${raw(
                radarChart({
                  title: 'Profile across the three criteria',
                  axes: ['Price', 'Programme', 'Risk'],
                  max: 1,
                  series: ranked.slice(0, 4).map((score) => ({
                    label: score.supplierName,
                    values: [Number(score.priceScore ?? 0), Number(score.programmeScore ?? 0), Number(score.riskScore ?? 0)],
                  })),
                  format: (value) => value.toFixed(2),
                  empty: 'Only one bidder — there is no field to compare against.',
                  footnote:
                    'Each axis is the normalised criterion score, so the shapes are comparable. A bidder strong on two ' +
                    'axes and weak on the third is a conditional award, not a rejection.',
                }),
              )}
            </div>
            <div class="card">
              <h2>Where the rates have been tested</h2>
              ${raw(
                boxPlot({
                  title: 'Observed rate spread',
                  groups: spreads,
                  format: (value) => money(value),
                  empty: 'No rate has more than one observation behind it yet.',
                  footnote:
                    'Low, median and high of the observations actually recorded. A wide box is a rate the estimate should ' +
                    'not carry at its median without knowing which end of it this project resembles.',
                }),
              )}
            </div>
          </div>`
        : ''
    }

    ${
      coverageRows.length > 0
        ? html`<div class="card" style="margin-bottom:14px">
            <h2>Where the supply chain can and cannot compete</h2>
            ${raw(
              barChart({
                title: 'Eligible firms and uncovered trades, by group',
                horizontal: true,
                data: coverageRows,
                series: [
                  { key: 'eligible', label: 'Eligible firms' },
                  { key: 'uncovered', label: 'Trades with nobody eligible', colour: 'bad' },
                ],
                format: (value) => String(value),
                empty: 'The trade catalogue has not been populated.',
                footnote:
                  'Eligible means prequalified and in date. An enquiry containing one firm that is not is refused whole, ' +
                  'so an uncovered trade is a package that cannot go out, not one that goes out thin.',
              }),
            )}
          </div>`
        : ''
    }
  `;
}
