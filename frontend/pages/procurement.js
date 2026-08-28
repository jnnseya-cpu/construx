import { api, entityBundle, isWithheld } from '../lib/api.js';
import { command, commandBar } from '../lib/command.js';
import { CONTRACT_FORM, PRICING_BASIS, today } from '../lib/enums.js';
import { badge, date, days, drillable, exact, html, humanise, money, pct, positionReport, raw, render, statusTone, table } from '../lib/ui.js';
import { insightPanel } from '../lib/insight.js';
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

  // The tenancy-level procurement intelligence, and the project's own tender
  // position. Seven engines with no screen: the twenty cost heads a tender is
  // built on, the price history to check it against, the trade catalogue, where
  // coverage is too thin to compete, the frameworks already held, what a tender
  // review found, and what has actually converted.
  const [costHeads, costIntel, trades, coverage, frameworks, reviews, awards] = await Promise.all([
    api.get('/v1/tender/cost-heads').catch((error) => ({ error })),
    api.get('/v1/cost-intelligence').catch((error) => ({ error })),
    api.get('/v1/supply-chain/trades').catch((error) => ({ error })),
    api.get('/v1/supply-chain/coverage').catch((error) => ({ error })),
    api.get('/v1/frameworks').catch((error) => ({ error })),
    api.get(`/v1/projects/${projectId}/tender-reviews`).catch((error) => ({ error })),
    api.get(`/v1/projects/${projectId}/awards`).catch((error) => ({ error })),
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
    .get(`/v1/projects/${projectId}/tender-intelligence`)
    .catch(() => ({ clarifications: [], comparisons: [], summary: '' }));

  // A command whose only select would be empty is locked with the reason rather
  // than offered — an empty required dropdown is a dead end the person cannot
  // diagnose, and a lock that says why is the same affordance the permission
  // matrix already uses.
  // T-WF-03. The measured items under the estimate, and what stops each
  // schedule freezing.
  const bill = await api
    .get(`/v1/projects/${projectId}/measurement`)
    .catch(() => ({ schedules: [], summary: '' }));
  const openSchedules = bill.schedules.filter((s) => s.status === 'OPEN');

  // T-WF-04. Which revision of the pack each firm actually holds.
  const enquiries = await api
    .get(`/v1/projects/${projectId}/enquiries`)
    .catch(() => ({ enquiries: [], summary: '' }));
  const liveEnquiries = enquiries.enquiries.filter((e) => e.status !== 'CLOSED');
  const closedEnquiries = enquiries.enquiries.filter((e) => e.status === 'CLOSED');

  const openComparisons = intel.comparisons.filter((c) => c.status === 'OPEN');

  // T-WF-05. Buy it or do it, per package.
  const routes = await api
    .get(`/v1/projects/${projectId}/pricing-routes`)
    .catch(() => ({ routes: [], summary: '' }));
  const openRoutes = routes.routes.filter((r) => r.status === 'OPEN');
  const unanswered = intel.clarifications.filter((c) => c.status === 'OPEN');
  const NO_OPEN_COMPARISON = 'No comparison is open — open one, or the last was closed for adjudication';
  const NO_OPEN_SCHEDULE = 'No measurement schedule is open — open one, or the last was frozen';
  const NO_LIVE_ENQUIRY = 'No enquiry is live — open one, or the last closed for returns';
  const NO_OPEN_ROUTE = 'No package route is open — open one, or the last was selected';

  // Who was asked against who answered. Every fact was already on the record
  // and nothing stood them beside each other, which from a screen is
  // indistinguishable from not tracking bidders at all.
  const reconciliation = rfq
    ? await api.get(`/v1/projects/${projectId}/procurement/rfq/${rfq._refId}/reconciliation`).catch(() => null)
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
            }`
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

      ${positionReport({
        title: 'Submissions and awards',
        intent: 'Submission packs and their receipts, the award departures, and what has converted.',
        data: awards,
        error: awards?.error,
        sections: [{ key: 'packs', label: 'Submission packs', empty: 'Nothing has been submitted.' }],
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
        { name: 'unit', label: 'Unit', type: 'text', hint: 'm3, m2, m, t, nr, item' },
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
