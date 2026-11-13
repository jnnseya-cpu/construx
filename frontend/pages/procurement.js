import { api, entityBundle, isWithheld } from '../lib/api.js';
import { barChart, boxPlot, funnelChart, ganttChart, radarChart, scatterPlot } from '../lib/charts.js';
import { command, commandBar } from '../lib/command.js';
import { CONTRACT_FORM, METHOD_OF_MEASUREMENT, PRICING_BASIS, today } from '../lib/enums.js';
import { badge, date, days, drillable, exact, html, humanise, money, pct, positionReport, raw, render, resolveHtml, statusTone, table, toast } from '../lib/ui.js';
import { lookupPanel, wireLookups } from '../lib/lookup.js';
import { flowPanel, loadFlow } from '../lib/flow.js';
import { insightPanel } from '../lib/insight.js';
import { supplierPaymentCard } from '../lib/siteportal.js';
import { csvRateCardToLines, parseRateCardEntries, rateCardReport } from '../lib/ratecard.js';
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
                    ${proposal.lines.filter((line) => line.rate?.source === 'OUR_RECORD').length}
                  </div>
                  <div class="metric-sub">
                    priced from our own record${
                      proposal.lines.some((line) => line.rate?.source === 'MARKET_AI')
                        ? html`, ${proposal.lines.filter((line) => line.rate?.source === 'MARKET_AI').length} at a market view`
                        : ''
                    }
                  </div>
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
                  line.rate
                    ? html`${money(line.rate.allInMinor)}${
                        line.rate.source === 'MARKET_AI' ? html`<br />${badge('market view', 'warn')}` : ''
                      }`
                    : badge('none', 'warn'),
                  line.rate
                    ? html`<span style="font-size:12px;color:var(--text-3)">${line.rate.basis}${
                        line.rate.lowMinor && line.rate.highMinor
                          ? html` Expect ${money(line.rate.lowMinor)}–${money(line.rate.highMinor)}.`
                          : ''
                      }</span>`
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
                /*
                 * What happened when the market was asked, in numbers.
                 *
                 * Twice the run told somebody "the market view returned no rate
                 * it could support" for every line — once because the answers
                 * were joined on a reworded description, once because no
                 * reasoning model was configured and a stand-in answered. Both
                 * sentences were true about the call and useless about the
                 * cause, and each cost a round trip to find. The screen says
                 * what was asked and what came back.
                 */
                proposal.marketView && proposal.marketView.used < proposal.marketView.asked
                  ? html`<div class="notice warn" style="margin-top:11px"><div>
                      <b>The market view priced ${proposal.marketView.used} of ${proposal.marketView.asked}
                      line${proposal.marketView.asked === 1 ? '' : 's'}.</b> ${proposal.marketView.note}
                      ${
                        proposal.marketView.dropped.length > 0
                          ? html`<div class="split-list" style="margin-top:7px">
                              ${proposal.marketView.dropped
                                .slice(0, 6)
                                .map((reason) => html`<div class="row"><span class="lbl">${reason}</span></div>`)}
                            </div>`
                          : ''
                      }
                    </div></div>`
                  : ''
              }

              ${
                /*
                 * Said before anything else on this panel, because it decides
                 * whether any of the rest is worth reading.
                 *
                 * A bill arrived holding seventy-nine items across six
                 * packages for a job with three drawings on it. Every
                 * acceptance had failed at the quotation step after writing
                 * the bill, so the screen looked as though nothing had
                 * happened and the obvious thing to do was press it again.
                 */
                proposal.alreadyMeasured
                  ? html`<div class="notice bad" style="margin-top:11px"><div>
                      <b>This package is already on the bill —
                      ${proposal.alreadyMeasured.items} measured item${proposal.alreadyMeasured.items === 1 ? '' : 's'}.</b>
                      Accepting this run would add a second copy of the same works and price the job twice, so it is
                      refused. Price the bill you already have, or run this under a different package name if the
                      drawings have been revised — a re-measure of a revision is a different measure.
                    </div></div>`
                  : ''
              }

              ${
                proposal.headsToSettle?.length > 0
                  ? html`<div class="notice warn" style="margin-top:11px"><div>
                      <b>${proposal.headsToSettle.length} cost head${proposal.headsToSettle.length === 1 ? '' : 's'}
                      ${proposal.headsToSettle.length === 1 ? 'is' : 'are'} neither priced nor excluded.</b>
                      A quotation cannot be drawn from an estimate that carries one, so accepting asks you for each:
                      a figure, or blank to say it is not in this offer.
                      <div class="split-list" style="margin-top:7px">
                        ${proposal.headsToSettle.map(
                          (entry) => html`<div class="row">
                            <span class="lbl"><b>${entry.label}</b>
                              <span class="metric-sub" style="display:block">${entry.note}</span>
                            </span>
                            <span class="val metric-sub">${humanise(entry.basis).toLowerCase()}</span>
                          </div>`,
                        )}
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
                      permitted:
                        can('ESTIMATE_TENDER', 'C') &&
                        can('EVIDENCE_AUDIT', 'I') &&
                        proposal.lines.length > 0 &&
                        !proposal.alreadyMeasured,
                      reason:
                        proposal.lines.length === 0
                          ? 'The run measured nothing, so there is nothing to accept.'
                          : proposal.alreadyMeasured
                            ? `This package already holds ${proposal.alreadyMeasured.items} measured items. The platform refuses to bill the same works twice.`
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
  const [costHeads, costIntel, trades, coverage, frameworks, reviews, awards, units, calibration, lessons, boq, ingestion, perception, flow, contingency, settlements] = await Promise.all([
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
    // Where this job is on the road from an enquiry to a price. Computed
    // server-side: the console holds no copy of what happens next.
    loadFlow(projectId),
    // The priced risk register as a contingency: expected value, a P80 tail and
    // the top drivers. Held beside the base estimate, counted once, so a
    // contingency can be defended line by line rather than taken as a percentage.
    api.read(`/v1/projects/${projectId}/risk/contingency`, 'RISK_REGISTER').catch((error) => ({ error })),
    // The settlement: the cost-to-price bridge, the actions carried as conditions
    // and whether the price and the programme share a cut-off. Assembled with the
    // risk exposures and the award departures into one settlement pack below.
    api.read(`/v1/projects/${projectId}/settlements`, 'ESTIMATE_TENDER', 'COMMERCIAL_L3').catch((error) => ({ error })),
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
    // Without this, the "Answer clarification" question picker read `b.Clarification`,
    // which was never fetched, so it was always empty and the form showed "nothing
    // to act on" even with open bidder queries on file — a buyer could never answer
    // a TQ from the screen. The entities exist on the ledger; they just weren't read.
    'Clarification',
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
  // The measured works rolled up by cost-code section, summed across every
  // schedule — what a sectional pricing schedule (sub-structure, superstructure
  // and the rest) is built from, each section still tracing to its lines.
  const billSections = (() => {
    const map = new Map();
    for (const s of bill.schedules ?? []) {
      for (const sec of s.sections ?? []) {
        const cur = map.get(sec.code) ?? { code: sec.code, amountMinor: 0, items: 0, priced: 0 };
        cur.amountMinor += sec.amountMinor;
        cur.items += sec.items;
        cur.priced += sec.priced;
        map.set(sec.code, cur);
      }
    }
    return [...map.values()].sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
  })();

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
  // The client-side questions still to be sent to the buyer's portal. The
  // platform drafts and registers them; it does not transmit to the portal, so
  // the one friction left is copying each question out by hand. These are the
  // ones a single "copy all" collects — open, client-side, not the internal
  // notes or the bidders' own queries.
  const toSendToClient = intel.clarifications.filter((c) => c.status === 'OPEN' && c.side === 'CLIENT');

  // The firm's own rate library, grouped by unit so a measured line can be
  // priced by picking a stored rate rather than retyping it — and crucially
  // without the line's wording having to match the rate card's. A pack-run
  // take-off and a hand-built rate card describe the same work in different
  // words; keying on an exact description would hand the picker nothing on
  // exactly the lines it is meant to help with. So the picker offers every
  // library rate in the item's unit and pre-selects the closest by shared words.
  const libraryRates = (costIntel?.rates ?? []).filter((rate) => Number(rate?.medianMinor) > 0);
  const libraryByUnit = new Map();
  for (const rate of libraryRates) {
    const unit = String(rate.unit ?? '').toLowerCase().trim();
    if (!libraryByUnit.has(unit)) libraryByUnit.set(unit, []);
    libraryByUnit.get(unit).push(rate);
  }
  for (const list of libraryByUnit.values()) {
    list.sort((a, b) => String(a.description).localeCompare(String(b.description), 'en', { numeric: true }));
  }
  // Shared-word overlap, so the right rate is usually already selected and the
  // estimator confirms rather than hunts. Short/noise words are dropped so "the"
  // and "to" do not make two unrelated lines look alike.
  const STOP = new Set(['the', 'to', 'of', 'in', 'and', 'a', 'on', 'for', 'with', 'at', 'by', 'mm', 'new']);
  const wordsOf = (text) =>
    new Set(
      String(text ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 1 && !STOP.has(w)),
    );
  const bestLibraryRate = (description, unit) => {
    const candidates = libraryByUnit.get(String(unit ?? '').toLowerCase().trim()) ?? [];
    if (candidates.length === 0) return null;
    const want = wordsOf(description);
    let best = null;
    let bestScore = 0;
    for (const rate of candidates) {
      const have = wordsOf(rate.description);
      let shared = 0;
      for (const w of want) if (have.has(w)) shared += 1;
      if (shared > bestScore) {
        bestScore = shared;
        best = rate;
      }
    }
    // Two shared meaningful words is enough to pre-select; below that, leave it
    // to the estimator rather than pre-fill a wrong rate they might not catch.
    return bestScore >= 2 ? best : null;
  };

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
  // The commercial inputs of the last estimate, so "Price the bill" opens with
  // them filled rather than blank — re-pricing after a change should not mean
  // re-typing the overhead, profit, programme and weekly prelims every time.
  // Money is stored in minor and the form's money fields take pounds, so these
  // divide by 100; a missing value falls back to an empty field.
  const priorModel = estimate?.model ?? {};
  const priorHead = (list, head, key) => {
    const found = (list ?? []).find((entry) => entry.head === head);
    return found && found[key] != null ? found[key] : undefined;
  };
  const priorWeekly = (head) => {
    const minor = priorHead(priorModel.timeRelated, head, 'weeklyRateMinor');
    return minor == null ? '' : minor / 100;
  };
  const priorSum = (head) => {
    const minor = priorHead(priorModel.quantified, head, 'rateMinor');
    return minor == null ? '' : minor / 100;
  };
  const priorFee = (head) => {
    const minor = priorHead(priorModel.fees, head, 'lumpSumMinor');
    return minor == null ? '' : minor / 100;
  };
  const funding = b.FundingModel.at(-1);
  const maturity = b.DesignMaturityAssessment.at(-1);
  const pack = b.TenderPackage.at(-1);

  // Two packages can read identically on screen and differ only by a character
  // nobody can see — a dash variant, a stray space — so a dropdown of their
  // names alone cannot be chosen between. Annotating each with the number of
  // live lines it holds makes "…South · 43 items" and "…South · 6 items"
  // tellable apart, which is the whole point of offering a move between them.
  const packLineCount = {};
  (boq?.items ?? []).forEach((item) => {
    const id = String(item.packageId ?? '');
    if (id) packLineCount[id] = (packLineCount[id] ?? 0) + 1;
  });
  const packLabel = (id) => {
    const n = packLineCount[id] ?? 0;
    return `${id} · ${n} item${n === 1 ? '' : 's'}`;
  };
  const packageOptions = () => (boq?.packages ?? []).map((id) => ({ value: id, label: packLabel(id) }));
  // The sentinel the "Work package" select uses to mean "not one of these — a new
  // one, named below". A builder does not type this as a package name; and were it
  // ever chosen as a real name, the backend would snap it to any match anyway.
  const NEW_PACKAGE = '__CONSTRUX_NEW_PACKAGE__';
  // Lines measured at zero quantity — placeholders that price at nothing and that
  // the estimate already flags as a defect. Clearing them is one click rather than
  // ticking them out of a list of fifty, because they are an exact, machine-known
  // set: every live line whose quantity is zero.
  const emptyLines = (boq?.items ?? []).filter((item) => Number(item.quantity) === 0);
  const emptyLineIds = emptyLines.map((item) => item.boqItemId);

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
            { id: 'rfq-clarification', label: 'Raise an RFQ query (TQ)', permitted: enquiryParticipant, reason: enquiryParticipantReason },
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
            { id: 'duration-estimate', label: 'Estimate the programme duration',
              permitted: can('ESTIMATE_TENDER', 'R'), reason: blockedReason('ESTIMATE_TENDER', 'R') },
            { id: 'clarification', label: 'Raise clarification', permitted: can('PROCUREMENT_AWARD', 'C'), reason: blockedReason('PROCUREMENT_AWARD', 'C') },
            { id: 'clarification-batch', label: 'Raise several clarifications', permitted: can('PROCUREMENT_AWARD', 'C'), reason: blockedReason('PROCUREMENT_AWARD', 'C') },
            { id: 'clarification-packcheck', label: 'Check against the pack',
              permitted: can('PROCUREMENT_AWARD', 'C') && (intel.clarifications ?? []).some((c) => c.status === 'OPEN'),
              reason: blockedReason('PROCUREMENT_AWARD', 'C') ?? 'No open clarification to check' },
            { id: 'clarification-withdraw', label: 'Withdraw a clarification',
              permitted: can('PROCUREMENT_AWARD', 'U') && (intel.clarifications ?? []).some((c) => c.status === 'OPEN'),
              reason: blockedReason('PROCUREMENT_AWARD', 'U') ?? 'No open clarification to withdraw' },
            { id: 'clarification-answer', label: 'Record the client’s answer',
              permitted: can('PROCUREMENT_AWARD', 'U') && (intel.clarifications ?? []).some((c) => c.status === 'OPEN' && c.side !== 'BIDDER'),
              reason: blockedReason('PROCUREMENT_AWARD', 'U') ?? 'No open client-side clarification awaiting an answer' },
            { id: 'close-tender', label: 'Close the tender — lost or withdrawn',
              permitted: can('PROJECT_SETUP', 'A'), reason: blockedReason('PROJECT_SETUP', 'A') },
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

      ${
        /*
         * First on the screen, not sixty per cent down it.
         *
         * Reported as "I can't see this price the bill", against a screenshot
         * of the top of this page. The panel that says what to do next sat
         * below the supply-chain chart, the bid evaluation, the award
         * conditions, the adjudication and the package completeness — every
         * one of which is empty on a job nobody has priced yet. A screen that
         * opens with nine empty panels and puts the one live action underneath
         * them is a screen nobody scrolls.
         */
        raw(flowPanel(flow, { here: 'procurement' }))
      }

      ${packRunPanel({
        available: perception?.capability?.available === true,
        // `classification.kind`, not `kind` — the register publishes an ingested
        // file as the pipeline recorded it, and reading the flat name gave
        // `undefined` for every file and "0 drawings filed" on a project that
        // had them.
        drawingsHeld: (ingestion?.files ?? []).filter((file) => file.classification?.kind === 'DRAWING').length,
        blocked: null,
      })}

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
                billSections.length === 0
                  ? ''
                  : html`<div style="padding:14px 17px 2px"><div class="metric-sub">
                        <b>Priced works by section.</b> The roll-up a sectional pricing schedule is built from — each
                        section is a lump sum that still traces back to the measured lines beneath it.
                      </div></div>
                      ${table({
                        headers: ['Section', 'Items', 'Priced', 'Amount'],
                        align: ['', 'num', 'num', 'num'],
                        rows: [
                          ...billSections.map((sec) => [
                            sec.code,
                            sec.items,
                            sec.priced < sec.items ? badge(`${sec.priced}/${sec.items}`, 'warn') : `${sec.priced}/${sec.items}`,
                            money(sec.amountMinor),
                          ]),
                          [
                            html`<b>Total</b>`,
                            billSections.reduce((n, sec) => n + sec.items, 0),
                            '',
                            html`<b>${money(billSections.reduce((n, sec) => n + sec.amountMinor, 0))}</b>`,
                          ],
                        ],
                      })}`
              }
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
              <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 17px 0">
                <h2 style="padding:0">Clarification register</h2>
                ${
                  toSendToClient.length > 0
                    ? html`<button class="btn quiet sm" data-copy-clarifications="1" title="Put every open client-side question on your clipboard, numbered, to paste into the buyer’s portal.">Copy all ${toSendToClient.length} question${toSendToClient.length === 1 ? '' : 's'} to send</button>`
                    : ''
                }
              </div>
              ${
                intel.clarificationStanding && (intel.clarificationStanding.overdue > 0 || intel.clarificationStanding.dueSoon > 0)
                  ? html`<div style="padding:10px 17px 0"><div class="notice ${intel.clarificationStanding.overdue > 0 ? 'bad' : 'warn'}"><div>
                      ${
                        intel.clarificationStanding.overdue > 0
                          ? html`<b>${intel.clarificationStanding.overdue} client clarification${intel.clarificationStanding.overdue === 1 ? ' is' : 's are'} past the answer-by date and still open.</b>
                              Submit them to the client, or withdraw the ones the pack answers, before the window shuts.`
                          : html`<b>${intel.clarificationStanding.dueSoon} client clarification${intel.clarificationStanding.dueSoon === 1 ? ' is' : 's are'} due within a week and still open.</b>
                              Get them to the client before the clarification deadline.`
                      }
                    </div></div></div>`
                  : ''
              }
              <div style="padding:8px 17px 0"><div class="metric-sub">
                Every question against the document, clause, drawing or package it concerns, and who the answer went to.
                A bidder who had the answer three days before the others is what makes an award challengeable, so the
                distribution and the reads are the record — not the answer.
              </div></div>
              ${table({
                headers: ['Ref', 'Side', 'Subject', 'About', 'Due', 'Issued', 'Sent to', 'Read', 'State', 'Outcome'],
                align: ['', '', '', '', '', '', 'num', 'num', '', ''],
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
                  // The client's answer, or why the question was withdrawn — the
                  // thing a client-side question's whole life comes down to.
                  c.answer
                    ? `${c.answer.length > 90 ? `${c.answer.slice(0, 90)}…` : c.answer}${c.answeredOn ? ` · ${c.answeredOn}` : ''}`
                    : c.withdrawnReason
                      ? c.withdrawnReason.length > 90
                        ? `${c.withdrawnReason.slice(0, 90)}…`
                        : c.withdrawnReason
                      : '—',
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
                Estimate build-up${estimate.durationWeeks ? ` — ${estimate.durationWeeks} week${estimate.durationWeeks === 1 ? '' : 's'} on site` : ''}
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

      ${
        /*
         * The tender risk register, priced as a contingency.
         *
         * cause → event → impact as one record, with who carries it. A client-
         * owned risk is not priced into our contingency; a contractor-owned one
         * is. The contingency is held beside the base estimate — expected value
         * plus a P80 tail — so it is counted once and can be defended line by
         * line rather than taken as a percentage buried in a rate.
         */
        contingency?.error
          ? ''
          : html`<div class="card pad0" style="margin-bottom:14px">
              <div style="padding:15px 17px">
                <h2>The risk register, priced</h2>
                <div class="metric-sub" style="margin-bottom:11px">
                  Each risk is a cause, the event it leads to, and the cost and time if it happens — scored at a
                  probability, with who carries it. The contingency below is held beside the base estimate, not inside a
                  rate, so the exposure is counted once and defended line by line.
                </div>
                <div style="display:flex;gap:22px;flex-wrap:wrap;margin-bottom:11px">
                  <div><div class="metric">${money(contingency?.expectedMinor ?? 0)}</div><div class="metric-sub">expected value</div></div>
                  <div><div class="metric">${money(contingency?.p80Minor ?? 0)}</div><div class="metric-sub">P80 contingency to hold</div></div>
                  <div><div class="metric">${money(contingency?.worstCaseMinor ?? 0)}</div><div class="metric-sub">worst case</div></div>
                </div>
                ${(contingency?.topDrivers ?? []).length > 0
                  ? table({
                      headers: ['Risk', 'Expected cost', 'Share'],
                      align: ['', 'num', 'num'],
                      rows: (contingency.topDrivers ?? []).map((driver) => [
                        driver.title,
                        money(driver.expectedCostMinor),
                        pct(Number(driver.share ?? 0) * 100, 0),
                      ]),
                    })
                  : html`<div class="empty"><b>No risks priced yet</b>Register the tender's risks — ground, access,
                      energisation, supply chain — so the contingency is a number you can defend, not a percentage.</div>`}
                <div class="actions" style="margin-top:12px">
                  ${raw(
                    commandBar([
                      {
                        id: 'register-risk',
                        label: 'Register a tender risk',
                        tone: 'primary',
                        permitted: can('RISK_REGISTER', 'C'),
                        reason: blockedReason('RISK_REGISTER', 'C'),
                      },
                    ]),
                  )}
                </div>
              </div>
            </div>`
      }

      ${
        /*
         * The settlement pack, on one screen.
         *
         * The engine was complete and had no screen: open the meeting, move the
         * price with a reason and an owner, carry what is unresolved as a stated
         * condition, approve under a named authority. This assembles the four
         * things a settlement approver needs in front of them at once — the
         * cost-to-price bridge, the risk exposures held as contingency, the
         * contract departures the submission will carry, and the sign-off — so the
         * decision is taken against the whole position rather than four screens.
         */
        settlements?.error
          ? ''
          : (() => {
              const list = settlements?.settlements ?? [];
              const current = list.at(-1);
              const departures = (awards?.packs ?? []).flatMap((p) => p.departures ?? []);
              const departuresOutstanding = (awards?.packs ?? []).reduce((n, p) => n + (p.departuresOutstanding ?? 0), 0);
              const open = current && current.status === 'OPEN';
              return html`<div class="card pad0" style="margin-bottom:14px">
                <div style="padding:15px 17px">
                  <h2>The settlement pack</h2>
                  <div class="metric-sub" style="margin-bottom:11px">
                    ${settlements?.summary ?? 'No settlement opened yet.'} Everything an approver signs against, in one
                    place: the bridge from cost to price, the risk held as contingency, the departures the submission
                    carries, and the authority the price goes out under.
                  </div>
                  ${current
                    ? html`<div class="split-list">
                        <div class="row"><span class="lbl">Pre-settlement</span><span class="val">${money(current.bridge.preSettlementMinor)}</span></div>
                        <div class="row"><span class="lbl">Adjustments (${current.bridge.adjustments.length})</span><span class="val">${money(current.bridge.adjustmentTotalMinor)}</span></div>
                        <div class="row"><span class="lbl"><b>Settled price</b></span><span class="val"><b style="color:var(--orange)">${money(current.bridge.postSettlementMinor)}</b></span></div>
                        <div class="row"><span class="lbl">Risk contingency (P80)</span><span class="val">${money(contingency?.p80Minor ?? 0)}</span></div>
                        <div class="row"><span class="lbl">Contract departures</span><span class="val">${departures.length}${departuresOutstanding > 0 ? raw(` ${badge(`${departuresOutstanding} outstanding`, 'bad')}`) : ''}</span></div>
                        <div class="row"><span class="lbl">Programme shares the price’s cut-off</span><span class="val">${current.programmeAligned === null ? '—' : current.programmeAligned ? raw(badge('yes', 'ok')) : raw(badge('no', 'warn'))}</span></div>
                        <div class="row"><span class="lbl">Conditions carried to the submission</span><span class="val">${(current.conditions ?? []).length}</span></div>
                        <div class="row"><span class="lbl">Actions open</span><span class="val">${current.actions.open}</span></div>
                        ${current.finalPriceMinor !== undefined
                          ? html`<div class="row"><span class="lbl"><b>Approved price</b></span><span class="val"><b>${money(current.finalPriceMinor)}</b></span></div>`
                          : ''}
                      </div>
                      ${current.bridge.adjustments.length > 0
                        ? table({
                            headers: ['Category', 'Reason', 'Owner', 'Amount'],
                            align: ['', '', '', 'num'],
                            rows: current.bridge.adjustments.map((a) => [a.category, a.reason, a.owner, money(a.amountMinor)]),
                          })
                        : ''}
                      ${departures.length > 0
                        ? html`<div class="metric-sub" style="margin-top:10px"><b>Departures the submission carries:</b>
                            ${departures.slice(0, 6).map((d) => d.summary ?? d.topic ?? '').filter(Boolean).join('; ')}</div>`
                        : ''}`
                    : html`<div class="empty"><b>No settlement opened</b>Freeze the pre-settlement position and open the
                        meeting to move the price, carry conditions and approve it under a named authority.</div>`}
                  <div class="actions" style="margin-top:12px">
                    ${raw(
                      commandBar([
                        {
                          id: 'open-settlement',
                          label: 'Open the settlement',
                          permitted: can('ESTIMATE_TENDER', 'C') && !!estimate,
                          reason: !estimate
                            ? 'Price the bill first — a settlement is opened against an estimate.'
                            : blockedReason('ESTIMATE_TENDER', 'C'),
                        },
                        {
                          id: 'settlement-adjustment',
                          label: 'Move the price',
                          permitted: can('ESTIMATE_TENDER', 'U') && !!open,
                          reason: !open ? 'Open a settlement first.' : blockedReason('ESTIMATE_TENDER', 'U'),
                        },
                        {
                          id: 'approve-settlement',
                          label: 'Approve the price',
                          tone: 'primary',
                          permitted: can('ESTIMATE_TENDER', 'A') && !!open,
                          reason: !open ? 'Open a settlement first.' : blockedReason('ESTIMATE_TENDER', 'A'),
                        },
                      ]),
                    )}
                  </div>
                </div>
              </div>`;
            })()
      }

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
                ${(boq?.superseded ?? []).length > 0
                  ? html`<div class="notice" style="margin:11px 17px 0"><div>
                      <b>${boq.superseded.length} retired item${boq.superseded.length === 1 ? '' : 's'}</b>
                      — no longer the measure, still on the record. ${boq.superseded[0].supersededReason ?? ''}
                    </div></div>`
                  : ''}
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
                        id: 'price-fee-schedule',
                        label: 'Price as a fee (day-rates)',
                        permitted: can('ESTIMATE_TENDER', 'C') && can('BOQ_TAKEOFF', 'C'),
                        reason: blockedReason('ESTIMATE_TENDER', 'C') ?? blockedReason('BOQ_TAKEOFF', 'C'),
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
                      {
                        id: 'register-risk',
                        label: 'Register a tender risk',
                        permitted: can('RISK_REGISTER', 'C'),
                        reason: blockedReason('RISK_REGISTER', 'C'),
                      },
                      /*
                       * The way out of a bill that is wrong.
                       *
                       * There is no delete and there will not be one: a
                       * quantity somebody priced against is a fact about what
                       * was believed at the time, and a bill that quietly
                       * loses items is a bill whose history cannot be read.
                       * This records that a package's measure no longer
                       * stands, with a reason against it, and the items stay
                       * on the chain.
                       *
                       * Two things reach it. A drawing was revised, so the
                       * measure it produced no longer describes the job. Or a
                       * run was repeated and the bill holds the same sheets
                       * measured twice — which happened, six times over, and
                       * left somebody with no way to put it right.
                       */
                      {
                        id: 'supersede-measure',
                        label: 'Retire a package’s measure',
                        permitted: can('BOQ_TAKEOFF', 'U') && (boq?.items ?? []).length > 0,
                        reason:
                          (boq?.items ?? []).length === 0
                            ? 'Nothing is measured, so there is nothing to retire.'
                            : blockedReason('BOQ_TAKEOFF', 'U'),
                      },
                      /*
                       * The bill splitting into two packages for one job is the
                       * other way a measure goes wrong: a name keyed by hand that
                       * reads the same as one a model confirmed, differing by a
                       * dash or a space nobody can see. An estimate prices one
                       * package at a time, so a line in the second is dropped
                       * from the price silently. This re-files those lines under
                       * the package they belong to. It is only offered when there
                       * is more than one package to move between.
                       */
                      {
                        id: 'move-measure',
                        label: 'Move a measure to another package',
                        permitted: can('BOQ_TAKEOFF', 'U') && (boq?.packages ?? []).length > 1,
                        reason:
                          (boq?.packages ?? []).length > 1
                            ? blockedReason('BOQ_TAKEOFF', 'U')
                            : 'There is only one package, so there is nothing to move between.',
                      },
                      /*
                       * The common case made one click. A line measured at zero
                       * prices at nothing and the estimate flags it; the set is
                       * exact, so clearing all of them is one decision rather than
                       * ticking each out of a long list. Offered only when there
                       * is at least one such line.
                       */
                      {
                        id: 'clear-empty-lines',
                        label: `Clear the lines priced at nothing${emptyLines.length ? ` (${emptyLines.length})` : ''}`,
                        permitted: can('BOQ_TAKEOFF', 'U') && emptyLines.length > 0,
                        reason:
                          emptyLines.length === 0
                            ? 'No line is measured at zero, so there is nothing priced at nothing to clear.'
                            : blockedReason('BOQ_TAKEOFF', 'U'),
                      },
                      /*
                       * Retiring a package is too blunt once a job is one
                       * package: a few stale lines — an empty placeholder left
                       * when the real line was measured under another code, a
                       * line entered twice — cannot be cleared without taking the
                       * whole measure with them. This retires the named lines and
                       * leaves the rest standing.
                       */
                      {
                        id: 'retire-items',
                        label: 'Retire specific lines',
                        permitted: can('BOQ_TAKEOFF', 'U') && (boq?.items ?? []).length > 0,
                        reason:
                          (boq?.items ?? []).length === 0
                            ? 'Nothing is measured, so there is no line to retire.'
                            : blockedReason('BOQ_TAKEOFF', 'U'),
                      },
                    ]),
                  )}
                  ${
                    (boq?.items ?? []).length > 0
                      ? html`<button class="btn sm" data-download-schedule="1" style="margin-top:9px">Download pricing schedule (PDF)</button>
                          <button class="btn quiet sm" data-copy-schedule="1" style="margin-top:9px">Copy for Appendix B</button>`
                      : ''
                  }
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
          'Confidence is stated, because a median of two observations is not a rate. Seed the library from your own ' +
          'rate card below; an imported rate shows as imported and stays THIN until a committed bid proves it.',
        data: costIntel,
        error: costIntel?.error,
        sections: [
          {
            key: 'rates',
            label: 'Unit rates',
            // Provenance made visible beside the figure: a reader must be able
            // to tell a rate seeded from the firm's own card from one earned on
            // a committed bid.
            columns: ['description', 'unit', 'confidence', 'provenance', 'observations', 'medianMinor', 'lowMinor', 'highMinor'],
            empty: 'No rate has enough observations to publish.',
          },
          { key: 'outturns', label: 'Package outturns', empty: 'No package has reached outturn.' },
          { key: 'estimatingAccuracy', label: 'Estimating accuracy' },
        ],
      })}

      <div class="actions" style="margin:12px 0">
        ${raw(
          commandBar([
            {
              id: 'import-rate-card',
              label: 'Import a rate card',
              permitted: can('ESTIMATE_TENDER', 'C'),
              reason: blockedReason('ESTIMATE_TENDER', 'C'),
            },
          ]),
        )}
      </div>

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

      <div class="card pad0" style="margin-bottom:14px">
        <div style="padding:15px 17px">
          <h2>After submission</h2>
          <div class="metric-sub" style="margin-bottom:11px">
            Record the client’s award notice against the pack — won, lost or withdrawn — with any standstill window it
            opened. A win computes what departs from what was bid; a standstill is counted down above. Why a bid was lost,
            and the marks, go on the opportunity’s outcome on Pipeline &amp; Bids, which the calibration reads.
          </div>
          <div class="actions">
            ${raw(
              commandBar([
                {
                  id: 'log-query',
                  label: 'Log a post-tender query',
                  permitted: can('PROCUREMENT_AWARD', 'U'),
                  reason: blockedReason('PROCUREMENT_AWARD', 'U'),
                },
                {
                  id: 'answer-query',
                  label: 'Answer a query',
                  permitted: can('PROCUREMENT_AWARD', 'U') && (awards?.packs ?? []).some((p) => (p.queriesOpen ?? 0) > 0),
                  reason: (awards?.packs ?? []).some((p) => (p.queriesOpen ?? 0) > 0)
                    ? blockedReason('PROCUREMENT_AWARD', 'U')
                    : 'No post-tender query is open.',
                },
                {
                  id: 'price-challenge',
                  label: 'Record a price challenge',
                  permitted: can('PROCUREMENT_AWARD', 'U'),
                  reason: blockedReason('PROCUREMENT_AWARD', 'U'),
                },
                {
                  id: 'substantiate-price-challenge',
                  label: 'Substantiate the price',
                  permitted: can('PROCUREMENT_AWARD', 'U') && (awards?.packs ?? []).some((p) => p.priceChallenge && !p.priceChallenge.substantiated),
                  reason: (awards?.packs ?? []).some((p) => p.priceChallenge && !p.priceChallenge.substantiated)
                    ? blockedReason('PROCUREMENT_AWARD', 'U')
                    : 'No open price challenge to substantiate.',
                },
                {
                  id: 'record-award',
                  label: 'Record the award outcome',
                  permitted: can('PROCUREMENT_AWARD', 'A'),
                  reason: blockedReason('PROCUREMENT_AWARD', 'A'),
                },
              ]),
            )}
          </div>
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
    /*
     * Seed the rate library from the firm's own rate card.
     *
     * For a firm whose library is empty — most of all a one-person firm pricing
     * its first bid, which is the case this serves. One rate per line, so a
     * whole card goes in on one paste instead of being built rate by rate. The
     * figures are the firm's own and are loaded under its own name; they enter
     * the library as THIN, imported starting rates and stay there until a
     * committed bid proves the item — which is said in the hint, so nobody
     * mistakes a pasted number for proven history.
     */
    'import-rate-card': {
      title: 'Import a rate card',
      intent:
        'Load your own unit rates in one paste to seed the library — your own numbers, not a bought index. Each ' +
        'rate enters as an imported, THIN starting point and stays there until a committed bid proves the item. A ' +
        'line the platform cannot read is reported back to you, not dropped.',
      path: `/v1/rate-card/import`,
      submitLabel: 'Import the rates',
      fields: [
        {
          name: 'cardFile',
          label: 'Choose a CSV file',
          type: 'textfile',
          into: 'card',
          accept: '.csv,.tsv,.txt',
          required: false,
          parse: csvRateCardToLines,
          hint:
            'Export your price list from a spreadsheet as CSV (Save As → CSV) and choose it here — its columns are ' +
            'read into the box below for you to check before importing. It finds the code, description, unit, rate ' +
            'and a note/inclusions column by their headers; the adopted rate wins over a low/high band. Or skip this ' +
            'and paste into the box instead.',
        },
        {
          name: 'card',
          label: 'The rate card, one rate per line',
          type: 'textarea',
          rows: 10,
          placeholder:
            'E20.007, Facing-brick outer leaf, m2, 145\nF10.001, Blockwork inner leaf 100mm, m2, 62\nR10.004, Readymix GEN3 to foundations, m3, 148, supply and place',
          hint:
            'code, description, unit, rate — and an optional note at the end. The code is your own reference and may ' +
            'be left off (just description, unit, rate). Rate is £ per unit. Or copy the Code, Description, Unit and ' +
            'rate columns straight from a spreadsheet and paste — tab-separated columns are read as they stand, so a ' +
            'description with its own commas (e.g. "Trench, max 2m deep") stays whole. Blank lines are skipped; a ' +
            'line missing a description, unit or rate is reported back. The grey example is a format guide, not ' +
            'content — type or paste your own rows over it.',
        },
      ],
      // Stop the round trip when the box is empty rather than letting it return
      // a bare VALIDATION_FAILED: the grey placeholder reads like content, so a
      // person can click Import over an empty box and get an opaque refusal.
      validate: (v) => {
        const lines = String(v.card ?? '').split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
        if (lines.length === 0) {
          return {
            field: 'card',
            message:
              'Paste at least one rate line. The grey example is a format guide, not content — type or paste your ' +
              'own rows over it.',
          };
        }
        return undefined;
      },
      transform: (v) => ({ entries: parseRateCardEntries(v.card) }),
      // Say what actually landed. The server returns which lines imported, which
      // replaced an existing key and which it could not read and why; without
      // this the console showed only a generic "Recorded" and a person could not
      // tell a 37-line import from a 3-line one, nor see a skipped line.
      report: (res) =>
        rateCardReport(
          res,
          'Added to the library as THIN, imported starting rates — they hold at THIN until a committed bid proves the item.',
        ),
    },
    'supersede-measure': {
      title: 'Retire a package’s measure',
      intent:
        'The items stay on the record and stop being the current measure. Nothing is deleted — a quantity somebody ' +
        'priced against is a fact about what was believed at the time, and a bill that quietly loses lines is a bill ' +
        'whose history cannot be read. Once retired, the package can be measured again.',
      path: `/v1/projects/${projectId}/tender/boq/supersede`,
      submitLabel: 'Retire this measure',
      fields: [
        {
          name: 'packageId',
          label: 'Package',
          type: 'select',
          options: packageOptions(),
          hint: 'Every item still standing against this package is retired together — a half-retired measure is not a measure. The item count tells two same-named packages apart.',
        },
        {
          name: 'reason',
          label: 'Why it no longer stands',
          type: 'textarea',
          rows: 2,
          hint: 'Somebody reading the bill in a year needs to know whether the drawing changed or the run was repeated — the two lead to different questions.',
        },
      ],
    },
    'move-measure': {
      title: 'Move a measure to another package',
      intent:
        'Two readings of one job can end up filed under names that read the same but differ by a dash or a space nobody ' +
        'can see, so the bill holds two packages for one job — and because an estimate prices one package at a time, the ' +
        'lines in the second are left out of the price with nothing to show them missing. This re-files them under the ' +
        'package they belong to, keeping their quantities and cost codes. Nothing is created and nothing is deleted.',
      path: `/v1/projects/${projectId}/tender/boq/move`,
      submitLabel: 'Move these lines',
      fields: [
        {
          name: 'fromPackageId',
          label: 'Move from',
          type: 'select',
          options: packageOptions(),
          hint: 'The package to empty. Every line still standing against it moves together. Use the item count to pick the stray one.',
        },
        {
          name: 'toPackageId',
          label: 'Move into',
          type: 'select',
          options: packageOptions(),
          hint: 'The package they belong to — usually the one holding the rest of the job.',
        },
        {
          name: 'reason',
          label: 'Why they are moving',
          type: 'textarea',
          rows: 2,
          hint: 'Somebody reading the bill in a year needs to know whether two readings of one job were merged or a line was re-scoped — the two lead to different questions.',
        },
      ],
    },
    'clear-empty-lines': {
      title: 'Clear the lines priced at nothing',
      intent:
        emptyLines.length > 0
          ? `Retires the ${emptyLines.length} line${emptyLines.length === 1 ? '' : 's'} measured at zero quantity, which ` +
            `price at nothing and which the estimate flags as a defect: ${emptyLines
              .map((item) => item.costCode)
              .join(', ')}. They stay on the record with a reason against them; nothing else on the bill is touched. ` +
            'Clear them before pricing so the quotation does not carry an empty line.'
          : 'No line is measured at zero quantity. There is nothing priced at nothing to clear.',
      path: `/v1/projects/${projectId}/tender/boq/retire-items`,
      submitLabel: `Clear ${emptyLines.length} line${emptyLines.length === 1 ? '' : 's'}`,
      fields: [
        {
          name: 'reason',
          label: 'Why they no longer stand',
          type: 'textarea',
          rows: 2,
          value: 'Placeholder lines measured at zero quantity — the real scope is measured on other lines of the bill.',
          hint: 'Recorded against each retired line. Edit it if these zeros were something other than placeholders.',
        },
      ],
      // The lines are the exact zero-quantity set, computed here rather than ticked
      // out of a list — the same retire-items endpoint, a determined selection.
      transform: (v) => ({ boqItemIds: emptyLineIds, reason: v.reason }),
    },
    'retire-items': {
      title: 'Retire specific lines',
      intent:
        'For a bill where a few lines are stale — an empty placeholder left behind when the real line was measured ' +
        'under another code, or a line entered twice — and the rest of the package is the measure. The chosen lines ' +
        'stop being the current measure and stay on the record with a reason against them; nothing is deleted, and ' +
        'everything you do not tick is left exactly as it stands.',
      path: `/v1/projects/${projectId}/tender/boq/retire-items`,
      submitLabel: 'Retire these lines',
      fields: [
        {
          name: 'boqItemIds',
          label: 'Lines to retire',
          type: 'multiselect',
          options: (boq?.items ?? []).map((item) => ({
            value: item.boqItemId,
            label: `${item.costCode} · ${item.description} (${item.quantity} ${item.unit})`,
          })),
          hint: 'Tick each line that no longer stands. A placeholder priced at nothing, or a duplicate of a line measured elsewhere, is the usual case.',
        },
        {
          name: 'reason',
          label: 'Why they no longer stand',
          type: 'textarea',
          rows: 2,
          hint: 'Somebody reading the bill in a year needs to know whether they were duplicates, placeholders or re-scoped — the three lead to different questions.',
        },
      ],
    },
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
        /*
         * The heads this job carries and nothing has answered for.
         *
         * Met as ESTIMATE_INCOMPLETE after an acceptance: a business with no
         * previous estimate has no basis to inherit, so the estimate carried
         * nothing against insurance or waste and the quotation refused it —
         * correctly, and after the work, leaving somebody holding an estimate
         * they could not send.
         *
         * Each head is one field, labelled in the unit the cost model prices it
         * in, and **blank means excluded**. That is the honest default: a head
         * somebody deliberately left empty is a head they are saying is not in
         * this offer, and the reason travels into the quotation as a stated
         * qualification rather than being inferred by a reader.
         */
        ...(packRun?.headsToSettle ?? []).map((entry) => ({
          name: `head:${entry.head}`,
          label:
            entry.basis === 'TIME_RELATED'
              ? `${entry.label}, per week (£)`
              : entry.basis === 'VALUE_RELATED'
                ? `${entry.label} (% of contract value)`
                : entry.basis === 'RISK_REGISTER' || entry.basis === 'MEASURED'
                  ? `${entry.label} — not priceable here`
                  : `${entry.label}, as a sum (£)`,
          type: entry.basis === 'VALUE_RELATED' ? 'number' : 'number',
          ...(entry.basis === 'VALUE_RELATED' ? { step: '0.01' } : { money: true }),
          required: false,
          hint:
            entry.basis === 'RISK_REGISTER'
              ? 'Contingency comes from a quantified risk register, never from a percentage — leave this blank and it is excluded, which is the honest answer until the register exists.'
              : entry.basis === 'MEASURED'
                ? 'Priced from the measured lines above. Nothing on this bill carries it, so leaving it blank excludes it.'
                : `${entry.note}. Leave blank and it is excluded from this offer.`,
        })),
        {
          name: 'exclusionReason',
          label: 'Why the heads you left blank are not in this offer',
          type: 'text',
          required: (packRun?.headsToSettle ?? []).length === 0,
          value: (packRun?.headsToSettle ?? []).length > 0 ? 'Not included in this offer' : '',
          hint: 'It travels into the quotation as a stated qualification, so the customer reads it rather than assuming it.',
        },
        { name: 'clientName', label: 'Quoted to', type: 'text', required: false, hint: 'The client this offer is made to. Leave blank and it goes to the tender’s buyer.' },
        { name: 'validUntil', label: 'Valid until', type: 'date', min: today(), hint: 'A quotation without a lapse date is a standing offer.' },
        { name: 'paymentTerms', label: 'Payment terms', type: 'text', required: false, placeholder: '30 days from invoice' },
        /*
         * The lines that want a person's eye, and only those.
         *
         * Two kinds. A line nothing could price is an empty box somebody has to
         * fill. A line priced at a model's view of the market is filled in
         * already and wants looking at — it is the one number in the run that
         * nothing in this company's record stands behind, and the form's job is
         * to put it in front of somebody rather than let it through unread.
         *
         * A line priced from our own committed estimates is not asked about
         * again. Asking for every rate is the thing this run exists to remove.
         */
        ...(packRun?.lines ?? [])
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => !line.rate || line.rate.source === 'MARKET_AI')
          .flatMap(({ line, index }) => [
            {
              name: `rate:${index}`,
              label: `${line.description} — ${line.quantity} ${line.unit}`,
              type: 'number',
              money: true,
              ...(line.rate ? { value: line.rate.allInMinor / 100 } : {}),
              hint: line.rate
                ? `${line.rate.basis}${
                    line.rate.lowMinor && line.rate.highMinor
                      ? ` Expect ${money(line.rate.lowMinor)}–${money(line.rate.highMinor)}.`
                      : ''
                  } Keep it or change it — it is a starting point, not this business's own rate.`
                : `${line.sourceSheet ?? 'measured'} · all-in rate per ${line.unit}. Neither this business's record nor the market view could price it.`,
            },
            /*
             * The least this line costs at all, beside the rate.
             *
             * A month of work on a churchyard wall came back priced at a few
             * hundred pounds, and the rates were not wrong — the quantities
             * were tiny. 1.69m³ of pad excavation at £90/m³ is £152. Nobody
             * brings an excavator to a churchyard for £152, and nobody sends a
             * ready-mix truck for £378: the truck has a minimum load and
             * charges for it whether you take it or not.
             *
             * A unit rate is what one more of something costs once you are
             * there. On a small job most of the cost is being there at all.
             * The model is asked for both and the line is priced at whichever
             * is greater, so the figure that usually decides a small price is
             * on the screen rather than absent from the arithmetic.
             */
            {
              name: `minimum:${index}`,
              label: '— least it costs at all',
              type: 'number',
              money: true,
              required: false,
              ...(line.rate?.minimumChargeMinor ? { value: line.rate.minimumChargeMinor / 100 } : {}),
              hint: line.rate?.minimumChargeMinor
                ? `At ${line.quantity} ${line.unit} the rate alone comes to ${money(
                    Math.round(line.rate.allInMinor * line.quantity),
                  )}, which does not cover turning up. The line is priced at whichever is greater.`
                : 'Delivery, minimum load, mobilisation, the smallest sensible visit. Blank means quantity times rate is the whole price.',
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
          // Priced from our own committed estimates: taken as it stands, and
          // the estimate line says where it came from.
          if (line.rate && line.rate.source === 'OUR_RECORD') {
            return {
              draftId: line.draftId,
              index: line.index,
              labourRateMinor: line.rate.labourRateMinor,
              materialRateMinor: line.rate.materialRateMinor,
              plantRateMinor: line.rate.plantRateMinor,
              subcontractRateMinor: line.rate.subcontractRateMinor,
              rateSource: 'OUR_RECORD',
            };
          }

          const typed = Number(v[`rate:${index}`] ?? 0);
          const head = v[`basis:${index}`] || 'labourRateMinor';
          // Kept or changed like the rate above it, and carried whichever way
          // the rate itself went.
          const minimumTyped = Number(v[`minimum:${index}`] ?? 0);
          const minimum = minimumTyped > 0 ? { minimumChargeMinor: Math.round(minimumTyped) } : {};

          // A market view left exactly as the model gave it is a market view
          // somebody kept, and it keeps the model's own split across the cost
          // heads. Changed by so much as a pound, it is that person's rate and
          // is recorded as theirs.
          if (line.rate && typed === line.rate.allInMinor) {
            return {
              draftId: line.draftId,
              index: line.index,
              labourRateMinor: line.rate.labourRateMinor,
              materialRateMinor: line.rate.materialRateMinor,
              plantRateMinor: line.rate.plantRateMinor,
              subcontractRateMinor: line.rate.subcontractRateMinor,
              rateSource: 'MARKET_AI',
              ...minimum,
            };
          }

          return {
            draftId: line.draftId,
            index: line.index,
            ...(typed > 0 ? { [head]: typed, rateSource: 'PERSON' } : {}),
            ...minimum,
          };
        }),
        estimate: (() => {
          // What was inherited from the last complete estimate, plus what was
          // just answered for the heads nothing covered. A head left blank is
          // excluded with the stated reason — never carried as a nought.
          const timeRelated = [...(packRun.basis?.timeRelated ?? [])];
          const quantified = [...(packRun.basis?.quantified ?? [])];
          const policies = [...(packRun.basis?.insurance?.policies ?? [])];
          const exclusions = [...(packRun.basis?.exclusions ?? [])];
          const why = v.exclusionReason || 'Not included in this offer';

          for (const entry of packRun.headsToSettle ?? []) {
            const answered = Number(v[`head:${entry.head}`] ?? 0);
            // Contingency comes from a quantified risk register and a measured
            // head comes from the bill. Neither can be answered with a number
            // typed into a box, and putting one there would be exactly the
            // percentage-contingency the cost model exists to refuse — so both
            // are excluded whatever was typed.
            const cannotBePriced = entry.basis === 'RISK_REGISTER' || entry.basis === 'MEASURED';
            if (cannotBePriced || !(answered > 0)) {
              exclusions.push({ head: entry.head, reason: why });
              continue;
            }
            if (entry.basis === 'TIME_RELATED') {
              timeRelated.push({ head: entry.head, description: entry.label, weeklyRateMinor: answered, quantity: 1 });
            } else if (entry.basis === 'VALUE_RELATED') {
              policies.push({ type: entry.label, percentOfContractValue: answered });
            } else if (entry.basis === 'FEE') {
              // The cost model takes a fee as a lump sum on its own list.
              quantified.push({ head: entry.head, description: entry.label, unit: 'sum', quantity: 1, rateMinor: answered });
            } else {
              quantified.push({ head: entry.head, description: entry.label, unit: 'sum', quantity: 1, rateMinor: answered });
            }
          }

          return {
            durationWeeks: Number(v.durationWeeks),
            basisOfEstimate: v.basisOfEstimate,
            margin: { overheadPercent: Number(v.overheadPercent), profitPercent: Number(v.profitPercent) },
            ...(timeRelated.length > 0 ? { timeRelated } : {}),
            ...(quantified.length > 0 ? { quantified } : {}),
            ...(policies.length > 0 ? { insurance: { policies } } : {}),
            ...(exclusions.length > 0 ? { exclusions } : {}),
          };
        })(),
        quotation: {
          clientName: v.clientName,
          validUntil: v.validUntil,
          ...(v.paymentTerms ? { paymentTerms: v.paymentTerms } : {}),
        },
      }),
      // Accepted means recorded. The proposal has become a bill, an estimate
      // and a quotation, and leaving it on screen would invite a second run
      // against readings that are now confirmed.
      //
      // The quotation is the one step that can fail on its own: an estimate
      // still carrying a head that is neither priced nor excluded cannot be
      // quoted. The bill and the estimate are written either way, and the run
      // now says so rather than reporting a failure over work that succeeded —
      // which is what sent somebody back to run the pack again, and again.
      onResult: (result) => {
        packRun = null;
        if (result?.quotationBlocked) {
          toast(
            'Bill and estimate written — no quotation yet',
            `${result.quotationBlocked.message} Price or exclude ${
              result.quotationBlocked.heads.length === 1 ? 'it' : 'them'
            } on the estimate, then draw the quotation from it. Do not run the pack again — it is measured.`,
            'warn',
          );
        }
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
        // When packages already exist, this is a real dropdown of them — not a
        // free-typed box. A typed box let the browser's own autofill offer a name
        // the person had keyed once with a stray space or a different dash, and
        // the bill split into two packages for one job that an estimate then
        // priced one at a time. Picking an existing package reuses its exact id;
        // a genuinely new one is opened through the last option and named below.
        (boq?.packages ?? []).length > 0
          ? {
              name: 'packageId',
              label: 'Work package',
              type: 'select',
              options: [
                ...packageOptions(),
                { value: NEW_PACKAGE, label: '＋ A new package — name it below' },
              ],
              hint: 'Pick the package these quantities belong to; the item count tells two same-named packages apart. Choose the last option only to open a genuinely new package.',
            }
          : {
              name: 'packageId',
              label: 'Work package',
              type: 'text',
              hint: 'Name the package these quantities belong to — this opens the first one. Use the same name when you price them.',
            },
        {
          name: 'newPackageName',
          label: 'New package name',
          type: 'text',
          required: false,
          hint: 'Only if you chose “a new package” above. Otherwise leave this blank.',
        },
        { name: 'costCodePrefix', label: 'Cost code prefix', type: 'text', required: false, placeholder: 'WALL', hint: 'Codes run WALL.001, WALL.002 and so on. Optional — defaults to ITEM.' },
        { name: 'discipline', label: 'Discipline', type: 'text', required: false, placeholder: 'STRUCTURES', hint: 'Optional. Defaults to “By hand” for a measurement taken off your own sheets.' },
        { name: 'sheetId', label: 'Sheet', type: 'text', required: false, placeholder: '25133-TDC-FN-ZZ-DR-S-1600', hint: 'The drawing the measurement was taken off. Leave blank if there is no drawing — a fee or services bill has none.' },
        {
          name: 'items',
          label: 'The items, one per line',
          type: 'textarea',
          rows: 8,
          placeholder:
            'Rake out and repoint in lime mortar | m2 | 86\nRebuild collapsed section in reclaimed stone | m2 | 12\nReplace coping, bed and point | m | 34',
          hint: 'description | unit | quantity — and optionally a fourth field naming a different sheet for that line.',
        },
        {
          // Asked, not assumed. Without it every hand-entered line was tagged
          // NRM2 — a building standard — on a highways bill measured to MMHW.
          name: 'measurementRule',
          label: 'Method of measurement',
          type: 'select',
          options: METHOD_OF_MEASUREMENT,
          hint: 'The rule the buyer’s bill is drawn to — the preamble usually says. NRM2 is building work; a highways or civils bill is usually MMHW or CESMM.',
        },
      ],
      transform: (v) => {
        // A measurement taken off your own sheets may have no drawing number at
        // all — a fee or services bill has none. Rather than refuse eleven lines
        // with a validation error about an empty sheet, a blank one is recorded
        // honestly as "By hand", which is exactly what it was.
        const sheet = String(v.sheetId ?? '').trim() || 'By hand';
        const discipline = String(v.discipline ?? '').trim() || 'Professional services';
        return {
          // A new package takes the name typed below; otherwise the chosen package's
          // exact id is used, so re-measuring into an existing package never forks it.
          packageId: v.packageId === NEW_PACKAGE ? String(v.newPackageName ?? '').trim() : v.packageId,
          costCodePrefix: String(v.costCodePrefix ?? '').trim() || 'ITEM',
          sources: [{ discipline, sheetId: sheet }],
          items: String(v.items ?? '')
            .split('\n')
            .map((line) => line.split('|').map((part) => part.trim()))
            .filter((parts) => parts.length >= 3 && parts[0])
            .map((parts) => ({
              description: parts[0],
              unit: parts[1],
              quantity: Number(parts[2]),
              sourceSheet: parts[3] || sheet,
              ...(v.measurementRule ? { measurementRule: v.measurementRule } : {}),
            })),
        };
      },
    },
    'price-fee-schedule': {
      title: 'Price as a fee — day-rates',
      intent:
        'For a professional-services or consultancy bid priced by resource and day-rate rather than a measured ' +
        'construction bill — a fee bid has no drawings to measure. Each line is a role and its day-rate; add a day ' +
        'count in the middle only if you are pricing a fee for a defined scope. With rates alone it is a schedule of ' +
        'rates — what a framework or DPS tenders, applied by the buyer to its own call-off volumes. Disbursements are ' +
        'expenses carried at cost and never marked up. It files the lines and prices them in one step, and the ' +
        'quotation and pricing schedule follow exactly as for any priced bill.',
      path: `/v1/projects/${projectId}/tender/fee-schedule`,
      submitLabel: 'Price the fee',
      fields: [
        {
          name: 'packageName',
          label: 'What the fee is for',
          type: 'text',
          required: false,
          placeholder: 'Professional services',
          hint: 'The package the fee lines are filed under. Leave blank for “Professional services”.',
        },
        {
          name: 'resources',
          label: 'Resource lines, one per line',
          type: 'textarea',
          rows: 6,
          placeholder: 'Project Director | 875\nSenior Project Manager | 725\nQuantity Surveyor | 575',
          hint:
            'role | day-rate in pounds — e.g. “Project Director | 875”. That is a schedule of rates, which is what a ' +
            'framework or DPS tenders. To price a fee for a defined scope instead, add the days in the middle: ' +
            '“Project Director | 5 | 875” is 5 days at £875.',
        },
        {
          name: 'disbursements',
          label: 'Disbursements (optional), one per line',
          type: 'textarea',
          rows: 3,
          required: false,
          placeholder: 'Travel and subsistence | 500\nPrinting and plotting | 150',
          hint: 'label | amount in pounds — carried at cost after margin, never marked up.',
        },
        {
          name: 'overheadPercent',
          label: 'Overhead (%)',
          type: 'number',
          step: '0.1',
          required: false,
          value: 0,
          hint: 'Leave at 0 if your day-rate is all-in (the usual case).',
        },
        { name: 'profitPercent', label: 'Profit (%)', type: 'number', step: '0.1', required: false, value: 0 },
        {
          name: 'basisOfEstimate',
          label: 'Basis of the fee',
          type: 'textarea',
          rows: 2,
          required: false,
          placeholder: 'Professional-services fee, priced by resource and day-rate.',
          hint: 'Travels with the estimate and into the quotation.',
        },
      ],
      transform: (v) => ({
        ...(String(v.packageName ?? '').trim() ? { packageName: String(v.packageName).trim() } : {}),
        resources: String(v.resources ?? '')
          .split('\n')
          .map((line) => line.split('|').map((part) => part.trim()))
          // Two columns is a rate card (role | rate); three is an extended fee
          // (role | days | rate). Keep a line when it has a role and a final rate.
          .filter((parts) => parts.length >= 2 && parts[0] && parts[parts.length - 1])
          .map((parts) =>
            parts.length >= 3
              ? { role: parts[0], days: Number(parts[1]), dayRateMinor: Math.round(Number(parts[2]) * 100) }
              : { role: parts[0], dayRateMinor: Math.round(Number(parts[1]) * 100) },
          ),
        disbursements: String(v.disbursements ?? '')
          .split('\n')
          .map((line) => line.split('|').map((part) => part.trim()))
          .filter((parts) => parts.length >= 2 && parts[0] && parts[1])
          .map((parts) => ({ label: parts[0], amountMinor: Math.round(Number(parts[1]) * 100) })),
        overheadPercent: Number(v.overheadPercent) || 0,
        profitPercent: Number(v.profitPercent) || 0,
        ...(String(v.basisOfEstimate ?? '').trim() ? { basisOfEstimate: String(v.basisOfEstimate).trim() } : {}),
      }),
    },
    'duration-estimate': {
      title: 'Estimate the programme duration',
      intent:
        'How long the job is, proposed from the measured works rather than guessed — the one input the drawings never ' +
        'state, and the one that drives every time-related head and the whole programme. A structural estimate to ' +
        'confirm, not a market-researched or resource-loaded programme: it carries low confidence and states its own ' +
        'basis. Take the figure to the construction-period field, and to the WBS generator on the programme side.',
      path: `/v1/projects/${projectId}/programme/duration-estimate`,
      submitLabel: 'Estimate it',
      // Before the form opens, read the two figures off the priced bill and fill
      // them in — so the common case is a glance and one press, not retyping a
      // total the measurement already holds. Where nothing is priced the fields
      // open blank with a hint, and the person can type them.
      prepare: async () => {
        const { basis } = await api.get(`/v1/projects/${projectId}/programme/duration-basis`).catch(() => ({ basis: null }));
        if (!basis) return {};
        // The money field is entered in major units (command.js multiplies by
        // 100 on submit), so the net-measured minor figure is shown in major.
        return { values: { netMeasuredMinor: basis.netMeasuredMinor / 100, tradeGroups: basis.tradeGroups } };
      },
      fields: [
        {
          name: 'netMeasuredMinor',
          label: 'Net measured works',
          type: 'number',
          money: true,
          required: false,
          hint: 'The measured-works total — direct cost only, before heads, overhead and profit. Filled from the priced bill; leave it to use that, or type your own.',
        },
        {
          name: 'tradeGroups',
          label: 'Trade phases the works span',
          type: 'number',
          step: '1',
          required: false,
          hint: 'How many distinct trade phases are in the bill — groundworks, walls, roof, finishes, externals. Filled from the bill’s work sections.',
        },
        {
          name: 'complexity',
          label: 'Complexity',
          type: 'select',
          required: false,
          options: [
            { value: 'NORMAL', label: 'Normal' },
            { value: 'SIMPLE', label: 'Simple — repetitive, few interfaces' },
            { value: 'COMPLEX', label: 'Complex — constrained site, many interfaces' },
          ],
        },
      ],
      // Blank means "use the priced bill" — omit it so the server derives it,
      // rather than sending a 0 or a NaN that would estimate a fortnight from
      // nothing.
      transform: (v) => ({
        ...(v.netMeasuredMinor !== '' && v.netMeasuredMinor != null ? { netMeasuredMinor: Number(v.netMeasuredMinor) } : {}),
        ...(v.tradeGroups !== '' && v.tradeGroups != null ? { tradeGroups: Number(v.tradeGroups) } : {}),
        ...(v.complexity ? { complexity: v.complexity } : {}),
      }),
      report: (res) => ({
        title: `About ${res.weeks} week${res.weeks === 1 ? '' : 's'} — low confidence`,
        message: `${res.basis} Take it to the construction period and confirm it; this is an estimate from the works, not a programme a planner has built.`,
        tone: 'ok',
      }),
    },
    'register-risk': {
      title: 'Register a tender risk',
      intent:
        'A tender risk is one record: the cause, the event it leads to, and the cost and time if it happens — scored ' +
        'at a probability, with who carries it. A client-owned risk is not priced into our contingency; a contractor-' +
        'owned one is. The register produces a P80 contingency held beside the base estimate, so the exposure is ' +
        'counted once and defended line by line rather than taken as a percentage.',
      path: `/v1/projects/${projectId}/risk`,
      submitLabel: 'Register it',
      fields: [
        { name: 'title', label: 'The risk, in a line', type: 'text',
          hint: 'The event — "temporary generation runs beyond the priced period".' },
        { name: 'cause', label: 'Cause', type: 'textarea', rows: 2, required: false,
          hint: 'What gives rise to it — "DNO energisation depends on a wayleave not yet granted". A control acts on the cause, not the event.' },
        { name: 'category', label: 'Category', type: 'select',
          options: [
            { value: 'GROUND_CONDITIONS', label: 'Ground conditions' },
            { value: 'PROGRAMME', label: 'Programme' },
            { value: 'COMMERCIAL', label: 'Commercial' },
            { value: 'DESIGN', label: 'Design' },
            { value: 'SUPPLY_CHAIN', label: 'Supply chain' },
            { value: 'SAFETY', label: 'Safety' },
            { value: 'QUALITY', label: 'Quality' },
            { value: 'ENVIRONMENTAL', label: 'Environmental' },
            { value: 'REGULATORY', label: 'Regulatory' },
            { value: 'WEATHER', label: 'Weather' },
          ] },
        { name: 'allocation', label: 'Who carries it', type: 'select',
          options: [
            { value: 'CONTRACTOR', label: 'Us — priced into our contingency' },
            { value: 'CLIENT', label: 'The client — not priced into our contingency' },
            { value: 'SHARED', label: 'Shared' },
          ],
          hint: 'A client-owned risk is left out of our contingency, so the same exposure is never funded twice.' },
        { name: 'probability', label: 'Probability (0–1)', type: 'number', step: '0.05', min: 0, max: 1,
          hint: 'A proportion, not a percentage. 0.4 means a four-in-ten chance.' },
        { name: 'costOptimistic', label: 'Cost if it happens — best case (£)', type: 'number', money: true },
        { name: 'costMostLikely', label: 'Cost if it happens — most likely (£)', type: 'number', money: true },
        { name: 'costPessimistic', label: 'Cost if it happens — worst case (£)', type: 'number', money: true },
        { name: 'dayOptimistic', label: 'Delay if it happens — best case (days)', type: 'number', required: false, value: 0 },
        { name: 'dayMostLikely', label: 'Delay if it happens — most likely (days)', type: 'number', required: false, value: 0 },
        { name: 'dayPessimistic', label: 'Delay if it happens — worst case (days)', type: 'number', required: false, value: 0 },
      ],
      transform: (v) => ({
        title: String(v.title ?? '').trim(),
        category: v.category,
        ...(String(v.cause ?? '').trim() ? { cause: String(v.cause).trim() } : {}),
        ...(v.allocation ? { allocation: v.allocation } : {}),
        probability: Number(v.probability ?? 0),
        costImpact: {
          optimistic: Math.round(Number(v.costOptimistic ?? 0)),
          mostLikely: Math.round(Number(v.costMostLikely ?? 0)),
          pessimistic: Math.round(Number(v.costPessimistic ?? 0)),
        },
        scheduleImpactDays: {
          optimistic: Number(v.dayOptimistic ?? 0),
          mostLikely: Number(v.dayMostLikely ?? 0),
          pessimistic: Number(v.dayPessimistic ?? 0),
        },
        // Score normalisation only — the expected cost that drives the
        // contingency is independent of these. Taken from the priced estimate
        // where there is one, with a sensible fallback where there is not.
        projectValueMinor: Number(estimate?.totalMinor ?? 0),
        projectDurationDays: Math.max(1, Math.round(Number(estimate?.durationWeeks ?? 26) * 7)),
      }),
    },
    'open-settlement': {
      title: 'Open the settlement',
      intent:
        'Freezes the pre-settlement position — the estimate total as it stands — and opens the meeting. From here the ' +
        'price is moved with a reason and an owner, what cannot be closed is carried as a stated condition, and the ' +
        'result is approved under a named authority.',
      path: `/v1/projects/${projectId}/settlements`,
      submitLabel: 'Open it',
      fields: [
        { name: 'estimateId', label: 'Estimate', type: 'select',
          options: b.Estimate.map((e) => ({ value: String(e.id), label: `${e.reference ?? e.id} · ${money(e.totalMinor ?? 0)}` })) },
        { name: 'informationAt', label: 'Information cut-off', type: 'date',
          hint: 'The revision of the information the price is settled against — so the price and the programme can be checked to share it.' },
        { name: 'addendum', label: 'Against addendum', type: 'text', required: false,
          hint: 'The last addendum reflected, where one applies.' },
      ],
      transform: (v) => ({
        estimateId: v.estimateId,
        cutOff: { informationAt: String(v.informationAt ?? ''), ...(String(v.addendum ?? '').trim() ? { addendum: String(v.addendum).trim() } : {}) },
      }),
    },
    'settlement-adjustment': {
      title: 'Move the price',
      intent:
        'Every movement carries a category, a reason and the person who decided it — taking money out of a price is the ' +
        'commonest thing that happens in this meeting, so the amount is signed. Supplier, scope and benchmark ' +
        'corrections point at a document; the judgements taken in the room do not.',
      path: (v) => `/v1/projects/${projectId}/settlements/${v.settlementId}/adjustments`,
      submitLabel: 'Record it',
      fields: [
        { name: 'settlementId', label: 'Settlement', type: 'select',
          options: (settlements?.settlements ?? []).filter((s) => s.status === 'OPEN').map((s) => ({ value: s.settlementId, label: s.reference })) },
        { name: 'category', label: 'Category', type: 'select',
          options: [
            { value: 'SUPPLIER_PRICE', label: 'Supplier price (needs evidence)' },
            { value: 'SCOPE_CORRECTION', label: 'Scope correction (needs evidence)' },
            { value: 'BENCHMARK_CORRECTION', label: 'Benchmark correction (needs evidence)' },
            { value: 'RISK_ALLOWANCE', label: 'Risk allowance' },
            { value: 'CONTINGENCY', label: 'Contingency' },
            { value: 'INFLATION', label: 'Inflation' },
            { value: 'MARGIN', label: 'Margin' },
            { value: 'COMMERCIAL_OPPORTUNITY', label: 'Commercial opportunity' },
          ] },
        { name: 'amountMinor', label: 'Amount (£, negative to take out)', type: 'number', money: true,
          hint: 'Signed. A reduction is negative.' },
        { name: 'reason', label: 'Reason', type: 'textarea', rows: 2 },
        { name: 'owner', label: 'Decided by', type: 'text' },
      ],
      transform: (v) => ({
        category: v.category,
        amountMinor: Math.round(Number(v.amountMinor ?? 0)),
        reason: String(v.reason ?? '').trim(),
        owner: String(v.owner ?? '').trim(),
      }),
    },
    'approve-settlement': {
      title: 'Approve the price',
      intent:
        'The settled price goes out under a named authority and within its limit. The cost-to-price bridge, the risk ' +
        'contingency and the departures the submission carries are on the screen behind this — the approval is taken ' +
        'against the whole position.',
      path: (v) => `/v1/projects/${projectId}/settlements/${v.settlementId}/approve`,
      submitLabel: 'Approve',
      fields: [
        { name: 'settlementId', label: 'Settlement', type: 'select',
          options: (settlements?.settlements ?? []).filter((s) => s.status === 'OPEN').map((s) => ({ value: s.settlementId, label: `${s.reference} · ${money(s.bridge.postSettlementMinor)}` })) },
        { name: 'finalPriceMinor', label: 'Final price (£)', type: 'number', money: true,
          hint: 'The number that goes out. Normally the settled price above.' },
        { name: 'delegatedTo', label: 'Authority delegated to', type: 'text',
          hint: 'The person or office approving it, not the system.' },
        { name: 'limitMinor', label: 'The limit that authority carries (£)', type: 'number', money: true },
        { name: 'authorityReference', label: 'Under what authority', type: 'text', required: false,
          hint: 'Scheme of delegation, board minute or policy.' },
        { name: 'summary', label: 'Approval summary', type: 'textarea', rows: 2,
          hint: 'What is being approved and on what basis — read back on the thread.' },
      ],
      transform: (v) => ({
        finalPriceMinor: Math.round(Number(v.finalPriceMinor ?? 0)),
        authority: {
          delegatedTo: String(v.delegatedTo ?? '').trim(),
          limitMinor: Math.round(Number(v.limitMinor ?? 0)),
          ...(String(v.authorityReference ?? '').trim() ? { reference: String(v.authorityReference).trim() } : {}),
        },
        summary: String(v.summary ?? '').trim(),
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
          options: packageOptions(),
          hint: 'The package whose measured lines are being priced. The item count tells two same-named packages apart — if the job split into two, move them into one package first.',
        },
        {
          name: 'durationWeeks',
          label: 'Construction period (weeks)',
          type: 'number',
          step: '1',
          value: priorModel.durationWeeks ?? estimate?.durationWeeks ?? '',
          hint: 'Drives every time-related head. Not in the drawings, and not guessed at here.',
        },
        {
          name: 'overheadPercent',
          label: 'Overhead (%)',
          type: 'number',
          step: '0.1',
          value: priorModel.margin?.overheadPercent ?? '',
          hint: 'What this business carries, on the cost beneath it.',
        },
        { name: 'profitPercent', label: 'Profit (%)', type: 'number', step: '0.1', value: priorModel.margin?.profitPercent ?? '' },
        {
          name: 'basisOfEstimate',
          label: 'Basis of the estimate',
          type: 'textarea',
          rows: 2,
          value: estimate?.basisOfEstimate ?? '',
          hint: 'What it was built from and what it assumes. It travels with the estimate and into the quotation.',
        },
        {
          name: 'assumptions',
          label: 'Assumptions, one per line',
          type: 'textarea',
          rows: 3,
          required: false,
          value: Array.isArray(estimate?.assumptions) ? estimate.assumptions.join('\n') : '',
          hint: 'Each becomes a stated assumption on the estimate rather than something a reader has to infer.',
        },
        {
          name: 'fixedSums',
          label: 'Provisional and fixed sums (one per line, as "label: amount")',
          type: 'textarea',
          rows: 3,
          required: false,
          value: Array.isArray(estimate?.fixedSums)
            ? estimate.fixedSums.map((s) => `${s.label}: ${(Number(s.amountMinor) / 100).toFixed(2)}`).join('\n')
            : '',
          hint:
            'All-in sums the contractor does not mark up — provisional sums (soakaway, asbestos) and nominated allowances. ' +
            'Each is added to the tender total AFTER margin, never marked up, so a sum that already carries its own overhead ' +
            'and profit is not charged twice. Enter the amount in pounds, e.g. "Soakaway: 2750".',
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
          value: priorWeekly('PRELIMINARIES'),
          hint: 'Set-up, welfare, accommodation, utilities. Multiplied by the period above, so a longer job costs more.',
        },
        {
          name: 'siteManagementWeeklyMinor',
          label: 'Site management, per week',
          type: 'number',
          money: true,
          required: false,
          value: priorWeekly('SITE_MANAGEMENT'),
          hint: 'A visiting or resident manager — the site-staff establishment, by the week. Price it here rather than excluding it.',
        },
        {
          name: 'safetyWeeklyMinor',
          label: 'Health and safety, per week',
          type: 'number',
          money: true,
          required: false,
          value: priorWeekly('HEALTH_AND_SAFETY'),
          hint: 'Safety advice, inductions, PPE, monitoring.',
        },
        {
          name: 'logisticsWeeklyMinor',
          label: 'Logistics, per week',
          type: 'number',
          money: true,
          required: false,
          value: priorWeekly('LOGISTICS'),
          hint: 'Gate, marshalling, hoists, cranage, deliveries — by the week.',
        },
        {
          name: 'qualityWeeklyMinor',
          label: 'Quality, per week',
          type: 'number',
          money: true,
          required: false,
          value: priorWeekly('QUALITY'),
          hint: 'Inspection, ITP administration, snagging and handover evidence — by the week.',
        },
        {
          name: 'temporaryWorksMinor',
          label: 'Temporary works, as a sum',
          type: 'number',
          money: true,
          required: false,
          value: priorSum('TEMPORARY_WORKS'),
          hint: 'Design-and-check plus hire — scaffold, props, support. A CDM duty, not a percentage allowance.',
        },
        {
          name: 'testingMinor',
          label: 'Testing, as a sum',
          type: 'number',
          money: true,
          required: false,
          value: priorSum('TESTING'),
          hint: 'Materials, structural and systems testing against the ITP.',
        },
        {
          name: 'commissioningMinor',
          label: 'Commissioning, as a sum',
          type: 'number',
          money: true,
          required: false,
          value: priorSum('COMMISSIONING'),
          hint: 'Systems commissioning, witnessing and demonstration.',
        },
        {
          name: 'wasteMinor',
          label: 'Waste, as a sum',
          type: 'number',
          money: true,
          required: false,
          value: priorSum('WASTE'),
          hint: 'Skips, muck away and gate fees for the whole job.',
        },
        {
          name: 'designMinor',
          label: 'Design, as a lump sum',
          type: 'number',
          money: true,
          required: false,
          value: priorFee('DESIGN'),
          hint: 'The contractor-designed portion, per the design responsibility matrix.',
        },
        {
          name: 'professionalFeesMinor',
          label: 'Professional fees, as a lump sum',
          type: 'number',
          money: true,
          required: false,
          value: priorFee('PROFESSIONAL_FEES'),
          hint: 'External consultants, surveys, statutory and planning fees.',
        },
        {
          name: 'insurancePercent',
          label: 'Insurance (% of contract value)',
          type: 'number',
          step: '0.01',
          required: false,
          value: priorModel.insurance?.policies?.[0]?.percentOfContractValue ?? '',
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
          value: (priorModel.exclusions ?? []).map((exclusion) => exclusion.head),
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
          value: (priorModel.exclusions ?? [])[0]?.reason ?? '',
          placeholder: 'Not included in this offer; by others',
        },
        // One rate field per measured line. The quantities are what came off
        // the drawings and are not asked for again; the rate is the
        // estimator's, and nothing here fills it in from an index — that would
        // be pricing somebody else's job.
        ...(boq?.items ?? []).flatMap((item) => {
          // The library rates in this item's unit, with the closest by shared
          // words pre-selected. The estimator confirms a rate rather than types
          // it — and it works whatever the line is called, because the match is
          // by unit and word overlap, not an exact description. Typing a rate in
          // the box above always overrides the pick.
          const candidates = libraryByUnit.get(String(item.unit ?? '').toLowerCase().trim()) ?? [];
          const suggested = bestLibraryRate(item.description, item.unit);
          const fields = [
            {
              name: `rate:${item.boqItemId}`,
              label: `${item.description} — ${item.quantity} ${item.unit}`,
              type: 'number',
              money: true,
              required: false,
              hint:
                `${item.packageId}${item.sourceSheet ? ` · measured off ${item.sourceSheet}` : ''} · all-in rate per ${item.unit}.` +
                (candidates.length ? ' Leave blank to use the library rate chosen below, or type one here to override it.' : ''),
            },
            {
              name: `basis:${item.boqItemId}`,
              label: `— a typed rate is`,
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
          ];
          if (candidates.length > 0) {
            fields.push({
              name: `libRate:${item.boqItemId}`,
              label: `— or a rate from your library`,
              type: 'select',
              required: false,
              // Pre-selected to the closest match so the common case is one
              // confirmation, not a search. Blank where nothing is close enough.
              // The value carries the rate AND the description, because two items
              // can share a rate (£32 plasterboard and £32 hardcore) and a value
              // of the rate alone would pre-select whichever came first in the
              // list — showing the wrong name against the right money.
              value: suggested ? `${suggested.medianMinor}|${suggested.description}` : '',
              options: [
                { value: '', label: '— none; I will type the rate —' },
                ...candidates.map((rate) => ({
                  value: `${rate.medianMinor}|${rate.description}`,
                  label: `${rate.description} · ${exact(rate.medianMinor)}/${item.unit} · ${String(rate.confidence ?? '').toLowerCase()}`,
                })),
              ],
              hint: suggested
                ? 'Pre-selected as the closest match in your library — change it if it is wrong, or type a rate above to override.'
                : 'Pick the stored rate for this item, or type one above.',
            });
          }
          return fields;
        }),
      ],
      transform: (v) => {
        const excluded = Array.isArray(v.excluded) ? v.excluded : v.excluded ? [v.excluded] : [];
        const weeks = Number(v.durationWeeks);
        const timeRelated = [
          v.prelimsWeeklyMinor
            ? { head: 'PRELIMINARIES', description: 'Site set-up, welfare and establishment', weeklyRateMinor: Number(v.prelimsWeeklyMinor), quantity: 1 }
            : null,
          v.siteManagementWeeklyMinor
            ? { head: 'SITE_MANAGEMENT', description: 'Site management establishment', weeklyRateMinor: Number(v.siteManagementWeeklyMinor), quantity: 1 }
            : null,
          v.safetyWeeklyMinor
            ? { head: 'HEALTH_AND_SAFETY', description: 'Safety advice, inductions and monitoring', weeklyRateMinor: Number(v.safetyWeeklyMinor), quantity: 1 }
            : null,
          v.logisticsWeeklyMinor
            ? { head: 'LOGISTICS', description: 'Gate, deliveries, hoists and cranage', weeklyRateMinor: Number(v.logisticsWeeklyMinor), quantity: 1 }
            : null,
          v.qualityWeeklyMinor
            ? { head: 'QUALITY', description: 'Inspection, ITP administration and handover', weeklyRateMinor: Number(v.qualityWeeklyMinor), quantity: 1 }
            : null,
        ].filter(Boolean);
        const quantified = [
          v.temporaryWorksMinor
            ? { head: 'TEMPORARY_WORKS', description: 'Temporary works design, check and hire', unit: 'sum', quantity: 1, rateMinor: Number(v.temporaryWorksMinor) }
            : null,
          v.testingMinor
            ? { head: 'TESTING', description: 'Materials, structural and systems testing', unit: 'sum', quantity: 1, rateMinor: Number(v.testingMinor) }
            : null,
          v.commissioningMinor
            ? { head: 'COMMISSIONING', description: 'Systems commissioning and demonstration', unit: 'sum', quantity: 1, rateMinor: Number(v.commissioningMinor) }
            : null,
          v.wasteMinor
            ? { head: 'WASTE', description: 'Skips, muck away and gate fees', unit: 'sum', quantity: 1, rateMinor: Number(v.wasteMinor) }
            : null,
        ].filter(Boolean);
        const fees = [
          v.designMinor ? { head: 'DESIGN', description: 'Contractor-designed portion', lumpSumMinor: Number(v.designMinor) } : null,
          v.professionalFeesMinor
            ? { head: 'PROFESSIONAL_FEES', description: 'Consultants, surveys and statutory fees', lumpSumMinor: Number(v.professionalFeesMinor) }
            : null,
        ].filter(Boolean);
        // Provisional and fixed sums, one per line as "label: amount" in pounds.
        // Converted to minor here and added after margin by the cost model — not
        // marked up, because they already carry their own.
        const fixedSums = String(v.fixedSums ?? '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const split = line.lastIndexOf(':');
            const label = (split >= 0 ? line.slice(0, split) : line).trim();
            const amount = Number(String(split >= 0 ? line.slice(split + 1) : '').replace(/[^0-9.]/g, ''));
            return {
              label: label || 'Fixed sum',
              amountMinor: Math.round((Number.isFinite(amount) ? amount : 0) * 100),
              provisional: /provisional|soakaway|asbestos|allowance|contingen/i.test(label),
            };
          })
          .filter((sum) => sum.amountMinor > 0);
        return {
          packageId: v.packageId,
          durationWeeks: weeks,
          basisOfEstimate: v.basisOfEstimate,
          assumptions: String(v.assumptions ?? '').split('\n').map((line) => line.trim()).filter(Boolean),
          margin: { overheadPercent: Number(v.overheadPercent), profitPercent: Number(v.profitPercent) },
          ...(timeRelated.length > 0 ? { timeRelated } : {}),
          ...(quantified.length > 0 ? { quantified } : {}),
          ...(fees.length > 0 ? { fees } : {}),
          ...(v.insurancePercent
            ? { insurance: { policies: [{ type: 'Contract works and liability', percentOfContractValue: Number(v.insurancePercent) }] } }
            : {}),
          ...(excluded.length > 0
            ? { exclusions: excluded.map((head) => ({ head, reason: v.exclusionReason || 'Not included in this offer' })) }
            : {}),
          ...(fixedSums.length > 0 ? { fixedSums } : {}),
          // Measured, confirmed, and handed back as measured — with the rate
          // the estimator put against each one.
          lines: (boq?.items ?? [])
            .filter((item) => item.packageId === v.packageId)
            .map((item) => {
              const base = {
                boqItemId: item.boqItemId,
                description: item.description,
                unit: item.unit,
                quantity: item.quantity,
              };
              // A typed rate always wins — it is the estimator overriding the
              // suggestion. Otherwise the library rate picked (or pre-selected)
              // for this line applies: carried all-in as a priced package and
              // tagged LIBRARY so the rate history does not take it back as a
              // fresh pricing — an applied rate is a copy, not evidence of itself.
              const typed = Number(v[`rate:${item.boqItemId}`] ?? 0);
              if (typed > 0) {
                const basis = v[`basis:${item.boqItemId}`] || 'labourRateMinor';
                return { ...base, [basis]: typed };
              }
              // The value is "rateMinor|description"; the rate is the part before
              // the first bar, so a description of its own cannot corrupt it.
              const picked = Number(String(v[`libRate:${item.boqItemId}`] ?? '').split('|')[0]);
              if (picked > 0) {
                return { ...base, subcontractRateMinor: picked, rateSource: 'LIBRARY' };
              }
              return { ...base };
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
          // The newest quotable estimate first, so it is the one already
          // selected. Listed oldest-first, the default was the first incomplete
          // draft of the job — which the platform refuses to quote — with the
          // finished one fourth in a list of identically named lines. An id is
          // a ULID, so it orders by when the estimate was made.
          options: [...b.Estimate]
            .sort((a, z) =>
              (a.status === 'INCOMPLETE') - (z.status === 'INCOMPLETE') || String(z._refId).localeCompare(String(a._refId)),
            )
            .map((e) => ({
              value: e._refId,
              label:
                `${e.packageId ?? e._refId} · ${money(e.totalMinor ?? 0)} · ` +
                (e.status === 'INCOMPLETE' ? 'incomplete — cannot be quoted' : String(e.status ?? '').toLowerCase()),
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
    'rfq-clarification': {
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
    'log-query': {
      title: 'Log a post-tender query',
      intent:
        'The buyer’s question during evaluation, against the pack it is about. Logged so the answer, when it comes, is ' +
        'tied to the bid and the evaluator’s view of it rather than living in an inbox — a query answered off the record ' +
        'is how a scored bid is tripped up after the hard work is done.',
      path: (v) => `/v1/projects/${projectId}/bid-packs/${v.packId}/queries`,
      submitLabel: 'Log it',
      fields: [
        { name: 'packId', label: 'Submission pack', type: 'select',
          options: (awards?.packs ?? []).filter((p) => p.submitted).map((p) => ({ value: p.packId, label: `${p.packId.slice(-8)} · ${p.status}` })),
          emptyHint: 'Nothing has been submitted yet, so there is no bid for a buyer to ask about.' },
        { name: 'question', label: 'The buyer’s question', type: 'textarea', rows: 3 },
        { name: 'receivedOn', label: 'Received on', type: 'date' },
        { name: 'replyDueBy', label: 'Reply due by', type: 'date', required: false,
          hint: 'The buyer’s deadline for our answer, where one was set.' },
      ],
      transform: (v) => ({
        question: String(v.question ?? '').trim(),
        receivedOn: String(v.receivedOn ?? '').trim(),
        ...(String(v.replyDueBy ?? '').trim() ? { replyDueBy: String(v.replyDueBy).trim() } : {}),
      }),
    },
    'answer-query': {
      title: 'Answer a post-tender query',
      intent:
        'Our reply, and what answering it changed. Naming the impact is the point: a query that moved the price or the ' +
        'scope is not a clarification, and a reply that quietly changed what was bid is the one the award departs on.',
      path: (v) => {
        const [packId, queryId] = String(v.target ?? '').split('::');
        return `/v1/projects/${projectId}/bid-packs/${packId}/queries/${queryId}/answer`;
      },
      submitLabel: 'Record the reply',
      fields: [
        { name: 'target', label: 'Open query', type: 'select',
          options: (awards?.packs ?? []).flatMap((p) =>
            (p.postTenderQueries ?? []).filter((q) => !q.reply).map((q) => ({
              value: `${p.packId}::${q.id}`,
              label: `${q.id} · ${String(q.question).slice(0, 60)}${String(q.question).length > 60 ? '…' : ''}`,
            })),
          ),
          emptyHint: 'No post-tender query is open. Log one first, or every one is already answered.' },
        { name: 'reply', label: 'Our reply', type: 'textarea', rows: 3 },
        { name: 'impact', label: 'What it changed', type: 'select',
          options: [
            { value: 'NONE', label: 'Nothing — a clarification' },
            { value: 'PRICE', label: 'The price' },
            { value: 'SCOPE', label: 'The scope' },
            { value: 'PROGRAMME', label: 'The programme' },
          ] },
      ],
      transform: (v) => ({ reply: String(v.reply ?? '').trim(), impact: v.impact }),
    },
    'price-challenge': {
      title: 'Record a price challenge',
      intent:
        'The buyer has challenged the price as abnormally low. Under the Procurement Act they must give a reasonable ' +
        'opportunity to demonstrate it can be performed at before disregarding the tender on that ground — logging the ' +
        'challenge starts that clock on the record.',
      path: (v) => `/v1/projects/${projectId}/bid-packs/${v.packId}/price-challenge`,
      submitLabel: 'Record it',
      fields: [
        { name: 'packId', label: 'Submission pack', type: 'select',
          options: (awards?.packs ?? []).filter((p) => p.submitted && !p.priceChallenge).map((p) => ({ value: p.packId, label: `${p.packId.slice(-8)} · ${p.status}` })),
          emptyHint: 'No submitted pack is without a challenge already — or nothing has been submitted.' },
        { name: 'raisedOn', label: 'Raised on', type: 'date' },
        { name: 'responseDueBy', label: 'Our response due by', type: 'date', required: false },
        { name: 'concern', label: 'What the buyer said looked low', type: 'textarea', rows: 2, required: false },
      ],
      transform: (v) => ({
        raisedOn: String(v.raisedOn ?? '').trim(),
        ...(String(v.responseDueBy ?? '').trim() ? { responseDueBy: String(v.responseDueBy).trim() } : {}),
        ...(String(v.concern ?? '').trim() ? { concern: String(v.concern).trim() } : {}),
      }),
    },
    'substantiate-price-challenge': {
      title: 'Substantiate the price',
      intent:
        'The evidence the bid can be performed at the offered price: the cost build-up, productivity, supplier coverage, ' +
        'programme and the exclusions that explain the number — the same things the settlement already holds. Recorded so ' +
        'the response that kept the bid in is on the thread, not in an email nobody can find when the next one lands.',
      path: (v) => `/v1/projects/${projectId}/bid-packs/${v.packId}/price-challenge/substantiate`,
      submitLabel: 'Substantiate',
      fields: [
        { name: 'packId', label: 'Submission pack', type: 'select',
          options: (awards?.packs ?? []).filter((p) => p.priceChallenge && !p.priceChallenge.substantiated).map((p) => ({ value: p.packId, label: `${p.packId.slice(-8)} · challenged ${p.priceChallenge.raisedOn}` })),
          emptyHint: 'No open price challenge to substantiate.' },
        { name: 'basis', label: 'The substantiation, one point per line', type: 'textarea', rows: 5,
          hint: 'Productivity, quantities, supplier coverage, programme, exclusions, cost drivers — each the evidence the number holds.' },
        { name: 'directCostMinor', label: 'Direct cost the price rests on (£)', type: 'number', money: true, required: false },
        { name: 'netMarginPercent', label: 'Net margin on the offered price (%)', type: 'number', required: false,
          hint: '"Abnormally low" is answered with the actual figure, not an assurance.' },
      ],
      transform: (v) => ({
        basis: String(v.basis ?? '').split('\n').map((line) => line.trim()).filter(Boolean),
        ...(v.directCostMinor !== undefined && v.directCostMinor !== '' ? { directCostMinor: Math.round(Number(v.directCostMinor)) } : {}),
        ...(v.netMarginPercent !== undefined && v.netMarginPercent !== '' ? { netMarginPercent: Number(v.netMarginPercent) } : {}),
      }),
    },
    'record-award': {
      title: 'Record the award outcome',
      intent:
        'The client’s award notice against the submission pack: won, lost or withdrawn, with its reference and the date ' +
        'it arrived. A win records the terms awarded so what departs from what was bid is computed while that comparison ' +
        'is still cheap. Where the notice opened a standstill, record when it ends — a challenge filed after it closes is ' +
        'out of time. Why a bid was lost is recorded on the opportunity’s own outcome, which the calibration reads.',
      path: (v) => `/v1/projects/${projectId}/bid-packs/${v.packId}/award`,
      submitLabel: 'Record',
      fields: [
        { name: 'packId', label: 'Submission pack', type: 'select',
          options: (awards?.packs ?? []).filter((p) => !p.outcome).map((p) => ({ value: p.packId, label: `${p.packId.slice(-8)} · ${p.status}` })),
          emptyHint: 'Every submitted pack already carries an outcome, or nothing has been submitted yet.' },
        { name: 'outcome', label: 'Outcome', type: 'select',
          options: [{ value: 'WON', label: 'Won' }, { value: 'LOST', label: 'Lost' }, { value: 'WITHDRAWN', label: 'Withdrawn' }] },
        { name: 'reference', label: 'Award / notice reference', type: 'text' },
        { name: 'receivedOn', label: 'Received on', type: 'date' },
        { name: 'standstillEndsOn', label: 'Standstill ends (if any)', type: 'date', required: false,
          hint: 'The end of the standstill window the notice opened. Left blank where none applies.' },
        { name: 'contractSumMinor', label: 'Awarded contract sum (£, on a win)', type: 'number', money: true, required: false },
        { name: 'commencementDate', label: 'Commencement (on a win)', type: 'date', required: false },
        { name: 'completionDate', label: 'Completion (on a win)', type: 'date', required: false },
        { name: 'winnerName', label: 'Who won (on a loss, where disclosed)', type: 'text', required: false },
        { name: 'winnerSumMinor', label: 'Winning price (on a loss, where disclosed)', type: 'number', money: true, required: false },
        { name: 'notes', label: 'Notes', type: 'textarea', rows: 2, required: false },
      ],
      transform: (v) => ({
        outcome: v.outcome,
        reference: String(v.reference ?? '').trim(),
        receivedOn: String(v.receivedOn ?? '').trim(),
        ...(String(v.standstillEndsOn ?? '').trim() ? { standstillEndsOn: String(v.standstillEndsOn).trim() } : {}),
        ...(v.outcome === 'WON'
          ? {
              terms: {
                ...(v.contractSumMinor !== undefined && v.contractSumMinor !== '' ? { contractSumMinor: Math.round(Number(v.contractSumMinor)) } : {}),
                ...(String(v.commencementDate ?? '').trim() ? { commencementDate: String(v.commencementDate).trim() } : {}),
                ...(String(v.completionDate ?? '').trim() ? { completionDate: String(v.completionDate).trim() } : {}),
              },
            }
          : {}),
        ...((String(v.winnerName ?? '').trim() || (v.winnerSumMinor !== undefined && v.winnerSumMinor !== ''))
          ? {
              winner: {
                ...(String(v.winnerName ?? '').trim() ? { name: String(v.winnerName).trim() } : {}),
                ...(v.winnerSumMinor !== undefined && v.winnerSumMinor !== '' ? { sumMinor: Math.round(Number(v.winnerSumMinor)) } : {}),
              },
            }
          : {}),
        ...(String(v.notes ?? '').trim() ? { notes: String(v.notes).trim() } : {}),
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

    'clarification-batch': {
      title: 'Raise several clarifications',
      intent:
        'A reviewed set of questions onto the register in one act, rather than a form at a time. Each line becomes its own ' +
        'TQ against the information it names. The set is all-or-nothing: if one line has no question or nothing to attach to, ' +
        'none is raised and the line is named — the register never carries half a batch.',
      path: `/v1/projects/${projectId}/tender-clarifications/batch`,
      submitLabel: 'Raise them',
      fields: [
        { name: 'side', label: 'Between', type: 'select',
          options: [
            { value: 'CLIENT', label: 'To the client or their agent' },
            { value: 'INTERNAL', label: 'Internal — the bid team asking itself' },
          ] },
        { name: 'linkType', label: 'Each question is about', type: 'select',
          options: [
            { value: 'scopeItem', label: 'A scope item' },
            { value: 'drawing', label: 'A drawing' },
            { value: 'document', label: 'A document' },
            { value: 'clause', label: 'A clause' },
            { value: 'package', label: 'A package' },
          ],
          hint: 'What the third column on each line points at.' },
        { name: 'responseDeadline', label: 'Answer needed by', type: 'date', required: false,
          hint: 'Applied to every question in the set.' },
        { name: 'items', label: 'One clarification per line', type: 'textarea', rows: 8,
          placeholder:
            'Foundations | Confirm foundation type, depth and concrete grade — not detailed below DPC | R4780\n' +
            'Drainage | Confirm whether below-ground drainage is in this contract or by others | R4780-8',
          hint: 'subject | question | the drawing or scope item it is about' },
      ],
      transform: (v) => ({
        items: String(v.items ?? '')
          .split('\n')
          .map((line) => line.split('|').map((part) => part.trim()))
          .filter((parts) => parts.length >= 2 && parts[0] && parts[1])
          .map((parts) => ({
            side: v.side,
            subject: parts[0],
            question: parts[1],
            links: parts[2] ? { [v.linkType]: parts[2] } : {},
            ...(v.responseDeadline ? { responseDeadline: v.responseDeadline } : {}),
          })),
      }),
    },
    'clarification-packcheck': {
      title: 'Check a clarification against the pack',
      intent:
        'Before you send a clarification, check whether the tender documents already answer it. The agent reads the ' +
        'ingested pack — the ITT, the pricing schedule, the specification — and comes back with a verdict and, where ' +
        'it finds one, the passage that answers it. It is advice you verify: it never withdraws the question. A ' +
        'clarification the pack already answers is one to withdraw in the portal before the deadline.',
      path: (collected) => `/v1/projects/${projectId}/tender-clarifications/${collected.clarificationId}/pack-check`,
      submitLabel: 'Check it',
      fields: [
        { name: 'clarificationId', label: 'Clarification', type: 'select',
          options: (intel.clarifications ?? [])
            .filter((c) => c.status === 'OPEN')
            .map((c) => ({ value: c.clarificationId, label: `${c.reference} · ${c.subject}` })),
          emptyHint:
            'Only an open clarification can be checked against the pack. One already answered, issued or withdrawn is ' +
            'settled, and there is nothing left to check. Raise a clarification first, or clear its filter by reopening the register.' },
      ],
      transform: () => ({}),
      report: (res) => {
        if (res.verdict === 'NO_PACK') {
          return { title: 'No pack to check against', message: res.reasoning, tone: 'warn' };
        }
        if (res.verdict === 'ANSWERED') {
          const cite = res.citation ? ` — ${res.citation.document}: "${res.citation.passage}"` : '';
          const conf = res.confidence != null ? ` (${Math.round(res.confidence * 100)}% confidence)` : '';
          return {
            title: `Likely already answered${conf}`,
            message: `${res.reasoning}${cite} Verify it — and if it holds, withdraw ${res.reference} in the portal before the deadline.`,
            tone: 'warn',
          };
        }
        return {
          title: 'No answer found in the pack — looks like a genuine gap',
          message: `${res.reasoning} Checked against: ${(res.documentsSearched || []).join(', ') || 'nothing'}. Keep ${res.reference}.`,
          tone: 'ok',
        };
      },
    },
    'clarification-withdraw': {
      title: 'Withdraw a clarification',
      intent:
        'Drop a question you raised against the client before it is answered — because the pack already answers it, or ' +
        'it is no longer needed. A reason is required so the register shows why it was dropped rather than leaving a ' +
        'question nobody can tell was answered elsewhere, judged irrelevant, or missed. It does not touch anything the ' +
        'client has already answered.',
      path: (collected) => `/v1/projects/${projectId}/tender-clarifications/${collected.clarificationId}/withdraw`,
      submitLabel: 'Withdraw',
      fields: [
        { name: 'clarificationId', label: 'Clarification', type: 'select',
          options: (intel.clarifications ?? [])
            .filter((c) => c.status === 'OPEN')
            .map((c) => ({ value: c.clarificationId, label: `${c.reference} · ${c.subject}` })),
          emptyHint:
            'Only an open clarification can be withdrawn. One the client has already answered, or that has been issued ' +
            'to bidders or withdrawn before, is settled and is not touched here.' },
        { name: 'reason', label: 'Why it is being withdrawn', type: 'textarea', rows: 2,
          hint: 'e.g. “Answered by Appendix B, Section 3 — strip foundations priced per the SE report.”' },
      ],
      // `clarificationId` is the path param, not a body field the route accepts
      // (`additionalProperties: false`, reason only). Strip it so the body is
      // just the reason.
      transform: ({ clarificationId, ...rest }) => rest,
      report: (res) => ({ title: `${res.reference} withdrawn`, message: 'It is off the open register, with the reason on the record.', tone: 'ok' }),
    },
    'clarification-answer': {
      title: 'Record the client’s answer',
      intent:
        'When the client answers a question you asked them, record their answer in their own words — it is part of the ' +
        'tender documents from the moment they give it, and a paraphrase is a new claim with nobody’s name on it. The ' +
        'date is kept because a dispute about a late question turns on it. A bidder’s question is not answered here; ' +
        'its answer is issued to every bidder.',
      path: (collected) => `/v1/projects/${projectId}/tender-clarifications/${collected.clarificationId}/record-answer`,
      submitLabel: 'Record it',
      fields: [
        { name: 'clarificationId', label: 'Clarification', type: 'select',
          options: (intel.clarifications ?? [])
            .filter((c) => c.status === 'OPEN' && c.side !== 'BIDDER')
            .map((c) => ({ value: c.clarificationId, label: `${c.reference} · ${c.subject}` })),
          emptyHint:
            'This records an answer to a question you put to the client, while it is still open. A bidder’s own question ' +
            'is not answered here — its answer is issued to every bidder. One already answered or withdrawn is settled.' },
        { name: 'answer', label: 'The client’s answer, in their words', type: 'textarea', rows: 3 },
        { name: 'answeredOn', label: 'Date answered', type: 'date', required: false },
      ],
      // `clarificationId` names the question in the path, so it is not part of
      // the body the route accepts (`additionalProperties: false`, answer only).
      // Strip it here, exactly as `issueClarification` strips its own path param,
      // and carry the date only when one was entered.
      transform: ({ clarificationId, answeredOn, ...rest }) => ({
        ...rest,
        ...(String(answeredOn ?? '').trim() ? { answeredOn } : {}),
      }),
      report: (res) => ({ title: `${res.reference} answered`, message: 'The client’s answer is on the record; the question is closed.', tone: 'ok' }),
    },
    'close-tender': {
      title: 'Close the tender',
      intent:
        'The tender was lost, or we have decided not to bid. Closing moves the project to a closed state so it is not ' +
        'left sitting open in the pipeline — and, on a loss, records who won and at what value, which is what the ' +
        'estimate learns a sharper number from next time. A closed project can be reopened, but that is a separate, ' +
        'deliberate act, not this one.',
      path: `/v1/projects/${projectId}/lifecycle`,
      submitLabel: 'Close it',
      fields: [
        { name: 'to', label: 'Outcome', type: 'select',
          options: [
            { value: 'CLOSED_LOST', label: 'Lost — the tender was awarded elsewhere' },
            { value: 'WITHDRAWN', label: 'Withdrawn — we pulled out, or did not bid' },
          ] },
        { name: 'reason', label: 'What happened', type: 'textarea', rows: 2,
          hint: 'Enough to be read later — the debrief, or the reason for the no-bid.' },
        { name: 'wonBy', label: 'Won by', type: 'text', required: false,
          hint: 'On a loss, the firm that won — where it is known.' },
        { name: 'winningValueMinor', label: 'Winning price', type: 'number', money: true, required: false,
          hint: 'What it was won at, where it is known. This is what sharpens the next estimate.' },
      ],
      transform: (v) => ({
        to: v.to,
        reason: v.reason,
        ...(v.to === 'CLOSED_LOST' ? { commercialOutcome: 'LOST' } : {}),
        ...(v.wonBy ? { wonBy: v.wonBy } : {}),
        ...(v.winningValueMinor ? { winningValueMinor: Number(v.winningValueMinor) } : {}),
      }),
      report: (res) => ({
        title: 'Tender closed',
        message: `Moved to ${String(res.to ?? '').replace(/_/g, ' ').toLowerCase()}. It is out of the open pipeline; reopening it is a separate, deliberate act.`,
        tone: 'ok',
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
    // The priced take-off as a branded, downloadable file — the end-to-end
    // answer: a tender's pricing is produced and downloaded in the platform, not
    // copied out and finished elsewhere.
    const downloadSchedule = event.target.closest('[data-download-schedule]');
    if (downloadSchedule) {
      try {
        await api.download(`/v1/projects/${projectId}/tender/pricing-schedule.pdf`, { format: 'PDF' });
        toast('Downloaded', 'Your pricing schedule PDF has been saved.', 'ok');
      } catch (error) {
        toast('Could not download', error?.message ?? 'Finish pricing the bill first — there is no complete estimate to export.', 'err');
      }
      return;
    }

    // The priced take-off, exported for the buyer's own pricing schedule
    // ("Appendix B"). It is a read, not a command, so it is handled here rather
    // than through the command dispatcher: fetch the apportioned lines the
    // platform already computes and put them on the clipboard to transcribe.
    const copySchedule = event.target.closest('[data-copy-schedule]');
    if (copySchedule) {
      try {
        const sched = await api.get(`/v1/projects/${projectId}/tender/pricing-schedule`);
        const lines = (sched.lines ?? []).map(
          (l) => `${l.n}. ${l.description} — ${Number(l.quantity).toLocaleString('en-GB')} ${l.unit} — ${money(l.amountMinor)}`,
        );
        const quals = [
          ...(sched.assumptions ?? []).map((a) => `Assumed: ${a}`),
          ...(sched.exclusions ?? []).map((e) => `Not included — ${e.label}: ${e.reason}`),
        ];
        // The note has to match what the schedule actually carries. Once
        // provisional and fixed sums are on it, "measured works only — add the
        // contingency and provisional sums separately" contradicts the lines
        // the buyer can see, so it only stands where no sums were added.
        const hasSums = Number(sched.fixedSumsMinor ?? 0) > 0;
        const hasContingency = (sched.lines ?? []).some((l) => /contingen/i.test(String(l.description ?? '')));
        const note = hasSums
          ? `NOTE: this schedule carries the measured works and the provisional and fixed sums listed above${hasContingency ? ', including a contingency' : ''}. ` +
            `Add VAT${hasContingency ? '' : ', a contingency'} and any M&E fix or external works the take-off does not itself cover before submission.`
          : 'NOTE: these are the measured works only. On the buyer’s Appendix B also add a contingency, the provisional sums (soakaway, plumbing, asbestos) and any M&E fix / external works the take-off does not itself cover.';
        const text = [
          `PRICING SCHEDULE (priced take-off) — ${sched.projectName}${sched.packageId ? ` · ${sched.packageId}` : ''}`,
          `Period on site: ${sched.durationWeeks} weeks`,
          '',
          ...lines,
          '',
          `TOTAL (excluding VAT): ${money(sched.totalMinor)}`,
          ...(quals.length ? ['', 'Qualifications:', ...quals] : []),
          '',
          note,
        ].join('\n');
        await navigator.clipboard.writeText(text);
        toast('Copied', `${(sched.lines ?? []).length} priced lines on your clipboard — paste them into your Appendix B.`, 'ok');
      } catch (error) {
        toast('Could not export the schedule', error?.message ?? 'No complete estimate to export yet — finish pricing the bill first.', 'err');
      }
      return;
    }

    // Every open client-side question, numbered, on the clipboard — so the one
    // manual step the platform cannot do (it is not wired into the buyer's
    // portal) is one press, not one copy per question. Built from the register
    // already on the page, not re-fetched: the questions are the tenant's own.
    const copyClarifications = event.target.closest('[data-copy-clarifications]');
    if (copyClarifications) {
      if (toSendToClient.length === 0) {
        toast('Nothing to copy', 'No open question is waiting to go to the client.', 'warn');
        return;
      }
      const lines = toSendToClient.map((c, i) => {
        const about = [c.links?.document, c.links?.clause && `clause ${c.links.clause}`, c.links?.drawing, c.links?.package, c.links?.scopeItem]
          .filter(Boolean)
          .join(', ');
        return `${i + 1}. [${c.reference}] ${c.question}${about ? ` (re: ${about})` : ''}`;
      });
      const text = [
        `Tender clarification questions — ${intel.projectName ?? 'this tender'}`,
        '',
        ...lines,
      ].join('\n');
      try {
        await navigator.clipboard.writeText(text);
        toast(
          'Copied',
          `${toSendToClient.length} question${toSendToClient.length === 1 ? '' : 's'} on your clipboard. Paste ${toSendToClient.length === 1 ? 'it' : 'them'} into the buyer’s portal before the clarification deadline — the platform does not transmit to the portal itself.`,
          'ok',
        );
      } catch {
        toast('Not copied', 'This browser would not write to the clipboard. The questions are listed in the register below to copy by hand.', 'warn');
      }
      return;
    }

    const button = event.target.closest('[data-command]');
    if (!button) return;
    let spec = COMMANDS[button.dataset.command];
    if (!spec) return;
    // A command may read state before it opens — the duration estimate fills its
    // fields from the priced bill. `prepare` returns `false` to cancel, or
    // `{ values }` to pre-fill matching fields; the spec is cloned so the shared
    // COMMANDS entry is never mutated.
    if (spec.prepare) {
      const prepared = await spec.prepare();
      if (prepared === false) return;
      if (prepared?.values) {
        spec = {
          ...spec,
          fields: spec.fields.map((field) =>
            field.name in prepared.values ? { ...field, value: prepared.values[field.name] } : field,
          ),
        };
      }
    }
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
