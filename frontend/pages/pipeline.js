import { api } from '../lib/api.js';
import { command, commandBar } from '../lib/command.js';
import { badge, date, html, humanise, money, notice, pct, positionReport, raw, render, table } from '../lib/ui.js';
import { blockedReason, can, draw } from '../app.js';

/**
 * Business development — the pipeline, and the discipline of refusing work.
 *
 * The scoring half of this screen is ordinary: ten weighted factors, a number,
 * a band. The half that matters is underneath it.
 *
 * A bid/no-bid algorithm nobody declines against is a form. So the no-bid rate
 * is the headline figure rather than a footnote, every override is named with
 * who took it and how it turned out, and the bands are reported against actual
 * outcomes — because weights that do not predict are a slower way of having the
 * same opinion, and the only way to find that out is to look.
 */

const BAND_TONE = { BID: 'ok', DIRECTOR_REVIEW: 'warn', NO_BID: 'bad' };
const BAND_LABEL = { BID: 'BID', DIRECTOR_REVIEW: 'Director review', NO_BID: 'NO BID' };

const STAGE_TONE = {
  IDENTIFIED: '',
  QUALIFIED: 'info',
  BID: 'ok',
  NO_BID: 'bad',
  CONVERTED: 'ok',
  LOST: 'warn',
};

/**
 * The whole IANA list, from the runtime rather than from a hand-kept copy.
 *
 * A short curated list of "common" zones is the obvious shortcut and it is
 * wrong the first time somebody bids in a country nobody thought of. The
 * browser already holds the current database; the server validates the same
 * way. Sorted with the zones a UK contractor reads most often at the top,
 * because ordering is an affordance and does not narrow what is accepted.
 */
const NEAR_THE_TOP = ['Europe/London', 'Europe/Dublin', 'Europe/Paris', 'Europe/Berlin', 'UTC'];

function timeZoneOptions() {
  const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const rest = all.filter((zone) => !NEAR_THE_TOP.includes(zone));
  return [...NEAR_THE_TOP, ...rest].map((zone) => ({ value: zone, label: zone.replace(/_/g, ' ') }));
}

const SEVERITY_TONE = { CRITICAL: 'bad', MAJOR: 'warn', MINOR: '' };

/**
 * The compliance matrix, read back.
 *
 * Producing the analysis wrote it to the ledger and put it in a response body,
 * and that was the only time anybody saw it. The matrix that says which
 * mandatory requirement has nothing behind it is the thing a bid manager opens
 * on the Monday, so it is a screen rather than a return value — and rerunning
 * the analysis to see it again would spend ACUs re-deriving a record the
 * platform already holds.
 */
const TERM_TONE = { BAR: 'bad', SEVERE: 'bad', MATERIAL: 'warn', ROUTINE: '' };
const MATRIX_TONE = { SATISFIED: 'ok', GAP: 'bad', UNKNOWN: 'warn' };

/**
 * A status is not a verdict.
 *
 * `UNKNOWN` means the platform holds no probe for this requirement, which is
 * different from holding a probe that found nothing. Collapsing the two would
 * bury the real gaps under everything nobody automated, so the distinction is
 * carried through to the screen rather than flattened into a tick or a cross.
 */
const MATRIX_MEANING = {
  SATISFIED: 'Evidenced from the company record',
  GAP: 'Nothing on file satisfies this',
  UNKNOWN: 'Not something the platform can check — somebody must',
};

function matrixDetail(analysis) {
  const gapRefs = new Set(analysis.mandatoryGaps.map((line) => line.reference));

  return html`
    <div class="card pad0">
      <h2 style="padding:15px 17px 0">
        ${analysis.reference} · ${analysis.clientName}
        ${analysis.readyToPrice ? badge('ready to price', 'ok') : badge('not ready to price', 'bad')}
      </h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
        Returns ${date(analysis.returnBy)}. Analysed ${date(analysis.analysedAt)} against
        ${money(analysis.estimatedValueMinor)} over ${analysis.durationWeeks} weeks — every exposure below is computed
        against those two figures, so a matrix read months later still shows what it was judged on.
      </p>

      <div class="grid g4" style="padding:13px 17px 0">
        <div class="card">
          <h2>Requirements</h2>
          <div class="metric">${analysis.matrix.length}</div>
          <div class="metric-sub">${analysis.matrix.filter((l) => l.mandatory).length} pass/fail, the rest scored.</div>
        </div>
        <div class="card">
          <h2>Mandatory gaps</h2>
          <div class="metric ${raw(analysis.mandatoryGaps.length === 0 ? 'good' : 'bad')}">${analysis.mandatoryGaps.length}</div>
          <div class="metric-sub">Requirements that end the bid if they are still open on the day.</div>
        </div>
        <div class="card">
          <h2>Quantified exposure</h2>
          <div class="metric orange">${money(analysis.quantifiedExposureMinor)}</div>
          <div class="metric-sub">
            Money at risk: damages and retention. Bonding is shown per term as facility committed rather than loss, so
            the column below can total more than this.
          </div>
        </div>
        <div class="card">
          <h2>To ask the buyer</h2>
          <div class="metric ${raw(analysis.clarifications.length === 0 ? 'good' : 'warn')}">${analysis.clarifications.length}</div>
          <div class="metric-sub">Questions that have to go before the clarification deadline, not after.</div>
        </div>
      </div>

      ${
        analysis.bars.length > 0
          ? html`<div class="notice bad" style="margin:13px 17px 0">
              <div>
                <b>This invitation carries a bar, not a negotiation.</b>
                ${analysis.bars.map((bar) => html`<div style="margin-top:4px">${bar}</div>`)}
              </div>
            </div>`
          : ''
      }

      <h2 style="padding:15px 17px 0">Commercial terms, assessed against this business</h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
        Not transcribed. Each term is judged against the company's own margin, cover and balance sheet — which is why
        the same clause is routine on one tender and severe on another.
      </p>
      ${table({
        headers: ['Term', 'As stated', 'Severity', 'Exposure', 'What it means here'],
        align: ['', '', '', 'num', ''],
        rows: analysis.terms.map((t) => [
          t.term,
          t.stated,
          badge(humanise(t.severity), TERM_TONE[t.severity] ?? ''),
          t.exposureMinor === undefined ? '—' : money(t.exposureMinor),
          html`<span style="font-size:12px;color:var(--text-3)">${t.assessment}</span>`,
        ]),
        empty: 'No commercial term was recorded on this invitation',
      })}

      <h2 style="padding:15px 17px 0">Every requirement, with an owner</h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
        A matrix without an owner is a list, and a list is what reaches the day before return with three items nobody
        claimed. Bids are lost over one missing certificate on a price that was right.
      </p>
      ${table({
        headers: ['Ref', 'Category', 'Requirement', 'Owner', 'Evidence required', 'On file', 'Weight', 'Due', 'Status'],
        align: ['', '', '', '', '', '', 'num', '', ''],
        rows: analysis.matrix.map((line) => [
          html`${line.reference}${line.mandatory ? badge('mandatory', gapRefs.has(line.reference) ? 'bad' : '') : ''}`,
          html`<span style="font-size:12px;color:var(--text-3)">${humanise(line.category)}</span>`,
          line.requirement,
          humanise(line.owner),
          html`<span style="font-size:12px;color:var(--text-3)">${line.evidenceRequired}</span>`,
          line.evidenceHeld
            ? html`<span style="font-size:12px;color:var(--text-3)">${line.evidenceHeld}</span>`
            : '—',
          line.weightingPercent === undefined ? '—' : `${line.weightingPercent}%`,
          line.dueBy ? date(line.dueBy) : '—',
          html`${badge(humanise(line.status), MATRIX_TONE[line.status] ?? '')}<br><span style="font-size:11px;color:var(--text-3)">${MATRIX_MEANING[line.status] ?? ''}</span>`,
        ]),
        empty: 'This analysis carries no requirements',
      })}

      <div class="grid g2" style="padding:13px 17px 15px">
        <div>
          <h2 style="margin-bottom:6px">The buyer's marking scheme</h2>
          <p style="font-size:12.5px;color:var(--text-3);margin:0 0 8px">
            ${
              analysis.weightings.stated === 0
                ? 'The invitation stated no weightings. Ask for the breakdown before pricing — an evaluation nobody can see is one nobody can bid to.'
                : analysis.weightings.complete
                  ? 'The stated weightings total 100%. The full breakdown is published.'
                  : `The stated weightings total ${analysis.weightings.stated}%, not 100%. Part of how this is being marked has not been disclosed.`
            }
          </p>
          <div class="split-list">
            ${analysis.weightings.declared.map(
              (w) => html`<div class="row"><span class="lbl">${humanise(w.category)}</span><span class="val">${w.percent}%</span></div>`,
            )}
            <div class="row">
              <span class="lbl"><b>Stated total</b></span>
              <span class="val">${badge(`${analysis.weightings.stated}%`, analysis.weightings.complete ? 'ok' : 'warn')}</span>
            </div>
          </div>
        </div>
        <div>
          <h2 style="margin-bottom:6px">Questions for the buyer</h2>
          <p style="font-size:12.5px;color:var(--text-3);margin:0 0 8px">
            Raised by the analysis rather than typed by somebody. These go through the clarification process and are
            answered to every bidder, so asking late is asking the competition's question for them.
          </p>
          ${
            analysis.clarifications.length === 0
              ? html`<div class="empty"><b>Nothing to ask</b>The invitation is internally consistent and insurable as written.</div>`
              : html`<div class="split-list">
                  ${analysis.clarifications.map((c) => html`<div class="row"><span class="lbl">${c}</span></div>`)}
                </div>`
          }
        </div>
      </div>
    </div>
  `;
}

/** Every command on this screen runs before a project exists. */
const TENANT = { tenantScoped: true };

export async function pipeline(root) {
  const [criteria, summary, discipline, profile, radar, tenders, permissions, matrices] = await Promise.all([
    api.get('/v1/pipeline/criteria'),
    api.get('/v1/pipeline'),
    api.get('/v1/pipeline/discipline'),
    // The company's own verified facts — everything the radar is allowed to
    // assert on a bid. Held here rather than on a settings page because this is
    // where somebody discovers the radar filtered them out of a job.
    api.get('/v1/company/profile').catch((error) => ({ error })),
    api.get('/v1/radar/latest').catch(() => ({ run: null })),
    api.get('/v1/pipeline/tenders'),
    api.get('/v1/permissions/matrix'),
    // Every matrix the tenancy holds, not only one produced in this session.
    api.get('/v1/pipeline/analyses'),
  ]);

  const run = radar?.run ?? null;
  const board = tenders.tenders ?? [];
  // The role list comes from the published matrix rather than a second copy in
  // the browser: an owner on a deliverable has to be a role the platform knows.
  const roleOptions = Object.keys(permissions.matrix ?? {}).sort().map((role) => ({ value: role, label: humanise(role) }));
  const invitationOptions = board.map((t) => ({ value: t.invitationId, label: `${t.reference} · ${t.title}` }));
  const biddableOptions = board
    .filter((t) => t.stage === 'BID')
    .map((t) => ({ value: t.invitationId, label: `${t.reference} · closes ${t.deadline.local}` }));

  const thresholds = criteria.thresholds;
  const opportunities = summary.opportunities ?? [];

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Pipeline &amp; Bid Decisions</h1>
          <p>
            Ten weighted factors, one score, and a published rule. The platform recommends; a person decides. What it
            will not do is let an override pass unremarked.
          </p>
        </div>
        <div class="actions cmd-bar">
          ${raw(
            commandBar([
              // Tenant-scoped: the bid pipeline exists before there is a
              // project, so no project's lifecycle phase gates it. The API
              // runs these against the tenant governance scope.
              { id: 'invitation', label: 'Record an ITT', tone: '',
                permitted: can('ESTIMATE_TENDER', 'C', TENANT), reason: blockedReason('ESTIMATE_TENDER', 'C', TENANT) },
              { id: 'deliverable', label: 'Add a deliverable',
                permitted: can('ESTIMATE_TENDER', 'U', TENANT), reason: blockedReason('ESTIMATE_TENDER', 'U', TENANT) },
              { id: 'addendum', label: 'Record an addendum',
                permitted: can('ESTIMATE_TENDER', 'U', TENANT), reason: blockedReason('ESTIMATE_TENDER', 'U', TENANT) },
              { id: 'programme', label: 'Build tender programme',
                permitted: can('ESTIMATE_TENDER', 'C', TENANT), reason: blockedReason('ESTIMATE_TENDER', 'C', TENANT) },
            ]),
          )}
        </div>
      </div>

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">Invitations in hand</h2>
        <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
          ${tenders.summary} The deadline is recorded in the zone it is read in and resolved to one instant — a portal
          that closes at noon in Dublin has closed an hour before noon here.
        </p>
        ${table({
          headers: ['Reference', 'Client', 'Closes', 'Zone', 'Left', 'Deliverables', 'Addenda', 'Stage', 'Ready to bid', 'Matrix'],
          align: ['', '', '', '', 'num', 'num', 'num', '', '', ''],
          rows: board.map((t) => [
            html`${t.reference}<br><span style="font-size:11.5px;color:var(--text-3)">${t.title}</span>`,
            t.clientName,
            t.deadline.local.replace('T', ' '),
            html`<span style="font-size:11.5px;color:var(--text-3)">${t.deadline.timeZone}</span>${
              t.deadline.anomaly ? badge(humanise(t.deadline.anomaly), 'bad') : ''
            }`,
            html`<span style="${raw(t.businessDaysRemaining <= 10 ? 'color:var(--orange)' : '')}">${t.businessDaysRemaining}d</span>`,
            `${t.deliverables.mandatory}/${t.deliverables.total}`,
            t.addenda,
            badge(BAND_LABEL[t.stage] ?? humanise(t.stage), STAGE_TONE[t.stage] ?? ''),
            t.reReviewReasons.length > 0
              ? badge('re-review', 'warn')
              : t.blockers.length > 0
                ? badge(`${t.blockers.length} blocking`, 'bad')
                : badge('ready', 'ok'),
            // The route from the invitation to the analysis of it. Without
            // this the matrix is a record with nothing pointing at it from the
            // thing it describes.
            t.analysisId
              ? html`<button class="btn sm" data-matrix="${t.analysisId}">Open</button>`
              : html`<span style="font-size:11.5px;color:var(--text-3)">Not analysed</span>`,
          ]),
          empty: 'No invitation recorded',
        })}
        ${
          board.some((t) => t.blockers.length > 0 || t.reReviewReasons.length > 0 || t.clarifications.length > 0)
            ? html`<div class="split-list" style="padding:0 17px 15px">
                ${board.flatMap((t) => [
                  ...t.reReviewReasons.map(
                    (reason) => html`<div class="row"><span class="lbl">${t.reference} ${badge('re-review', 'warn')} ${reason}</span></div>`,
                  ),
                  ...t.blockers.map(
                    (blocker) => html`<div class="row"><span class="lbl">${t.reference} ${badge('blocks the bid', 'bad')} ${blocker}</span></div>`,
                  ),
                  ...t.clarifications.map(
                    (c) => html`<div class="row">
                      <span class="lbl">${t.reference} ${badge(humanise(c.severity), SEVERITY_TONE[c.severity] ?? '')} ${c.subject}</span>
                      <span class="val" style="font-size:12px;color:var(--text-3)">${c.question}</span>
                    </div>`,
                  ),
                ])}
              </div>`
            : ''
        }
      </div>

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">Compliance matrices on file</h2>
        <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
          ${matrices.summary} Every analysis stays readable after the session that produced it — rerunning one to see it
          again would spend AI budget re-deriving a record the platform already holds, and would write a second analysis
          of the same invitation into the record.
        </p>
        ${table({
          headers: ['Reference', 'Client', 'Returns', 'Requirements', 'Mandatory gaps', 'Bars', 'To ask', 'Exposure', 'Worst term', 'Verdict', ''],
          align: ['', '', '', 'num', 'num', 'num', 'num', 'num', '', '', ''],
          rows: (matrices.analyses ?? []).map((a) => [
            a.reference,
            a.clientName,
            date(a.returnBy),
            a.requirements,
            html`<span style="${raw(a.mandatoryGaps > 0 ? 'color:var(--critical)' : '')}">${a.mandatoryGaps}</span>`,
            html`<span style="${raw(a.bars > 0 ? 'color:var(--critical)' : '')}">${a.bars}</span>`,
            a.clarifications,
            money(a.quantifiedExposureMinor),
            a.worstTerm ? badge(humanise(a.worstTerm), TERM_TONE[a.worstTerm] ?? '') : '—',
            a.readyToPrice ? badge('ready to price', 'ok') : badge('not ready', 'bad'),
            html`<button class="btn sm" data-matrix="${a.analysisId}">Open</button>`,
          ]),
          empty: 'No invitation has been analysed yet',
        })}
      </div>

      <!-- The topbar is 54px and sticky, so scrolling this into view without a
           margin puts the matrix's own heading underneath it. -->
      <div id="matrix-detail" style="margin-bottom:14px;scroll-margin-top:68px"></div>

      <div class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h2>Declined</h2>
          <div class="metric ${raw(discipline.noBid > 0 ? 'good' : 'warn')}">${pct(discipline.noBidRatePercent, 1)}</div>
          <div class="metric-sub">
            ${discipline.noBid} of ${discipline.decided} decided. Refusing bad work is the point of scoring it.
          </div>
        </div>
        <div class="card">
          <h2>Bid effort released</h2>
          <div class="metric">${money(discipline.declinedValueMinor)}</div>
          <div class="metric-sub">Value walked away from — pursuits the bid team did not spend a month on.</div>
        </div>
        <div class="card">
          <h2>Overrides</h2>
          <div class="metric ${raw(discipline.overrides.length === 0 ? 'good' : 'warn')}">${discipline.overrides.length}</div>
          <div class="metric-sub">Decisions taken against the algorithm. Permitted, recorded, never silent.</div>
        </div>
        <div class="card">
          <h2>Live pipeline</h2>
          <div class="metric orange">${money(summary.liveValueMinor)}</div>
          <div class="metric-sub">${money(summary.wonValueMinor)} converted to projects.</div>
        </div>
      </div>

      ${
        discipline.observations.length > 0
          ? html`<div class="notice ${raw(discipline.noBid === 0 && discipline.decided > 0 ? 'warn' : 'info')}" style="margin-bottom:14px">
              <div>
                ${discipline.observations.map((o) => html`<div style="margin-bottom:4px">${o}</div>`)}
              </div>
            </div>`
          : ''
      }

      ${
        run
          ? html`
            <div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">
                Tender radar — ${run.ranOn}
                ${badge(`${run.shortlisted} of ${run.screened} worth reading`, run.shortlisted > 0 ? 'ok' : '')}
              </h2>
              <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
                Screened against the company's own recorded facts. It never claims a capability that is not on file — an
                invented reference is what a bid gets disqualified for.
              </p>
              ${table({
                headers: ['Opportunity', 'Value', 'Region', 'Closes', 'Competition', 'Score', 'Verdict'],
                align: ['', 'num', '', 'num', '', 'num', ''],
                rows: (run.results ?? []).map((r) => [
                  html`${r.title}<br><span style="font-size:11.5px;color:var(--text-3)">${r.reference} · ${r.clientName}</span>`,
                  money(r.estimatedValueMinor),
                  r.region,
                  html`<span style="${raw(r.daysToDeadline <= 14 ? 'color:var(--orange)' : '')}">${r.daysToDeadline}d</span>`,
                  badge(humanise(r.competition), r.competition === 'LOW' ? 'ok' : r.competition === 'HIGH' ? 'bad' : ''),
                  r.qualification.score,
                  r.eligible
                    ? badge(BAND_LABEL[r.qualification.recommendation], BAND_TONE[r.qualification.recommendation])
                    : badge('INELIGIBLE', 'bad'),
                ]),
                empty: 'Nothing screened',
              })}
              <div class="split-list" style="padding:0 17px 15px">
                ${(run.observations ?? []).map((o) => html`<div class="row"><span class="lbl">${o}</span></div>`)}
              </div>
            </div>

            ${(run.results ?? [])
              .filter((r) => !r.eligible || r.mitigations.length > 0)
              .map(
                (r) => html`<div class="card" style="margin-bottom:14px">
                  <h2>${r.title} ${r.eligible ? '' : badge('ineligible', 'bad')}</h2>
                  <div class="split-list">
                    ${r.eligibilityFailures.map(
                      (f) => html`<div class="row"><span class="lbl">✗ ${f.requirement}</span><span class="val">${f.reason}</span></div>`,
                    )}
                    ${r.strengths.map((x) => html`<div class="row"><span class="lbl">+ ${x}</span></div>`)}
                    ${r.risks.map((x) => html`<div class="row"><span class="lbl">! ${x}</span></div>`)}
                    ${r.mitigations.map((x) => html`<div class="row"><span class="lbl">→ ${x}</span></div>`)}
                    <div class="row"><span class="lbl">Margin target</span><span class="val">${r.marginTargetPercent.min}–${r.marginTargetPercent.max}%</span></div>
                  </div>
                </div>`,
              )}
          `
          : ''
      }

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">Do the bands predict?</h2>
        <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
          If jobs above ${thresholds.bidAbove} do not convert better than jobs pushed through from the review band, the
          weights are wrong. An algorithm nobody checks against outcomes is an opinion with arithmetic on it.
        </p>
        ${table({
          headers: ['Band', 'Score', 'Decided', 'Bid', 'Declined', 'Won', 'Lost', 'Win rate'],
          align: ['', '', 'num', 'num', 'num', 'num', 'num', 'num'],
          rows: discipline.byBand.map((b) => [
            badge(BAND_LABEL[b.band], BAND_TONE[b.band]),
            b.range,
            b.decided,
            b.bid,
            b.noBid,
            b.converted,
            b.lost,
            b.winRatePercent === null ? '—' : pct(b.winRatePercent, 1),
          ]),
          empty: 'No decisions recorded',
        })}
      </div>

      ${
        discipline.overrides.length > 0
          ? html`<div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">Decisions taken against the score</h2>
              <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
                The tool advises and the business decides. This is the list a post-mortem asks for and nobody writes down
                at the time.
              </p>
              ${table({
                headers: ['Opportunity', 'Score', 'Recommended', 'Decided', 'Outcome', 'Rationale'],
                align: ['', 'num', '', '', '', ''],
                rows: discipline.overrides.map((o) => [
                  o.title,
                  o.score,
                  badge(BAND_LABEL[o.recommendation], BAND_TONE[o.recommendation]),
                  badge(BAND_LABEL[o.decision] ?? o.decision, o.decision === 'BID' ? 'warn' : ''),
                  o.outcome,
                  html`<span style="font-size:12px;color:var(--text-3)">${o.rationale}</span>`,
                ]),
              })}
            </div>`
          : ''
      }

      <div class="grid g2" style="margin-bottom:14px">
        <div class="card pad0">
          <h2 style="padding:15px 17px 0">The algorithm</h2>
          <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
            Five is always good for us — including on the two factors named as risks, where reading the heading the other
            way round inverts the result.
          </p>
          ${table({
            headers: ['Factor', 'Weight', '5 means', '1 means'],
            align: ['', 'num', '', ''],
            rows: criteria.criteria.map((c) => [
              c.label,
              c.weight,
              html`<span style="font-size:12px;color:var(--text-3)">${c.good}</span>`,
              html`<span style="font-size:12px;color:var(--text-3)">${c.bad}</span>`,
            ]),
          })}
          <div class="split-list" style="padding:0 17px 15px">
            <div class="row"><span class="lbl">Below ${thresholds.noBidBelow}</span><span class="val">${badge('NO BID', 'bad')}</span></div>
            <div class="row"><span class="lbl">${thresholds.noBidBelow} to ${thresholds.bidAbove}</span><span class="val">${badge('Director review', 'warn')}</span></div>
            <div class="row"><span class="lbl">Above ${thresholds.bidAbove}</span><span class="val">${badge('BID', 'ok')}</span></div>
            <div class="row"><span class="lbl">Any factor at 1/5</span><span class="val">${badge('Held for review', 'warn')}</span></div>
          </div>
        </div>

        <div class="card">
          <h2>Where we keep scoring badly</h2>
          <p style="font-size:12.5px;color:var(--text-3);margin-bottom:11px">
            Factors scoring 2 or below across the pipeline. A recurring weakness is a business problem, not a run of bad
            opportunities.
          </p>
          ${
            discipline.recurringConcerns.length === 0
              ? html`<div class="empty"><b>Nothing recurring</b>No factor is repeatedly scoring badly.</div>`
              : html`<div class="split-list">
                  ${discipline.recurringConcerns.map(
                    (c) => html`<div class="row"><span class="lbl">${c.factor}</span><span class="val">${c.count}</span></div>`,
                  )}
                </div>`
          }
        </div>
      </div>

      <div class="card pad0">
        <h2 style="padding:15px 17px 0">Opportunities</h2>
        ${table({
          headers: ['Opportunity', 'Client', 'Value', 'Score', 'Recommended', 'Stage', 'Due'],
          align: ['', '', 'num', 'num', '', '', ''],
          rows: opportunities.map((o) => {
            const q = o.qualification;
            return [
              o.title,
              o.clientName,
              money(o.estimatedValueMinor),
              q ? q.score : '—',
              q
                ? html`${badge(BAND_LABEL[q.recommendation], BAND_TONE[q.recommendation])}${
                    q.cappedBy ? badge('capped', 'warn') : ''
                  }`
                : '—',
              badge(BAND_LABEL[o.stage] ?? o.stage, STAGE_TONE[o.stage] ?? ''),
              o.submissionDueAt ? date(o.submissionDueAt) : '—',
            ];
          }),
          empty: 'No opportunities registered',
        })}
      </div>

      ${positionReport({
        title: 'What this company can claim',
        intent:
          'Turnover, insurances, accreditations, references and capacity. The radar may assert none of it unless it ' +
          'is here, which is why an opportunity is sometimes filtered out for a fact nobody has recorded yet.',
        data: profile,
        error: profile?.error,
        sections: [
          { key: 'accreditations', label: 'Accreditations', empty: 'No accreditation is recorded.' },
          { key: 'insurances', label: 'Insurances', empty: 'No insurance is recorded.' },
          { key: 'references', label: 'References', empty: 'No reference is recorded.' },
          { key: 'sectors', label: 'Sectors', empty: 'No sector is claimed.' },
          { key: 'regions', label: 'Regions', empty: 'No region is claimed.' },
          { key: 'selfDeliveredTrades', label: 'Self-delivered trades', empty: 'Nothing is self-delivered.' },
          { key: 'capacity', label: 'Capacity' },
        ],
      })}
    `,
  );

  const COMMANDS = {
    invitation: {
      title: 'Record an invitation to tender',
      intent:
        'The deadline is registered before anybody reads the documents, because a countdown that starts when somebody ' +
        'gets round to it is not a countdown. The time zone is part of the deadline, not a detail — where the invitation ' +
        'did not state one, say so and the platform raises it as a question for the buyer.',
      path: (v) => `/v1/pipeline/opportunities/${v.opportunityId}/tenders`,
      submitLabel: 'Record',
      fields: [
        { name: 'opportunityId', label: 'Opportunity', type: 'select',
          options: opportunities.map((o) => ({ value: o.id, label: `${o.title} · ${o.clientName}` })) },
        { name: 'reference', label: 'The buyer’s reference', type: 'text', placeholder: 'ITT/2027/014' },
        { name: 'issuedAt', label: 'Issued', type: 'datetime-local',
          hint: 'When the invitation landed. Immutable — addenda append to it and never rewrite it.' },
        { name: 'returnLocal', label: 'Returns by (as the invitation states it)', type: 'datetime-local',
          hint: 'The wall-clock time printed in the ITT, not converted' },
        { name: 'timeZone', label: 'Read in', type: 'select', options: timeZoneOptions(), value: 'Europe/London' },
        { name: 'timeZoneStated', label: 'Did the invitation state the zone?', type: 'select',
          options: [{ value: 'true', label: 'Yes — it says so in the documents' }, { value: 'false', label: 'No — the zone above is our assumption' }],
          hint: 'An assumed deadline is a critical clarification, not a default' },
        { name: 'channel', label: 'Returned through', type: 'select',
          options: ['PORTAL', 'EMAIL', 'PHYSICAL', 'HAND_DELIVERY'].map((c) => ({ value: c, label: humanise(c) })) },
        { name: 'clarificationLocal', label: 'Last date for questions', type: 'datetime-local', required: false },
        { name: 'siteVisitLocal', label: 'Site visit', type: 'datetime-local', required: false },
      ],
      transform: (v) => ({
        reference: v.reference,
        issuedAt: new Date(v.issuedAt).toISOString(),
        returnLocal: v.returnLocal,
        timeZone: v.timeZone,
        timeZoneStated: v.timeZoneStated === 'true',
        channel: v.channel,
        ...(v.clarificationLocal ? { clarificationLocal: v.clarificationLocal } : {}),
        ...(v.siteVisitLocal ? { siteVisitLocal: v.siteVisitLocal } : {}),
      }),
    },

    deliverable: {
      title: 'Add a return deliverable',
      intent:
        'A mandatory deliverable needs a source in the invitation, an owner, and our own date — all three, before a bid ' +
        'can be approved. A bid disqualified for a missing certificate was priced correctly and lost anyway.',
      path: (v) => `/v1/pipeline/tenders/${v.invitationId}/deliverables`,
      submitLabel: 'Add',
      fields: [
        { name: 'invitationId', label: 'Invitation', type: 'select', options: invitationOptions },
        { name: 'reference', label: 'Reference', type: 'text', placeholder: 'D-01' },
        { name: 'title', label: 'What has to be returned', type: 'text', placeholder: 'Priced pricing schedule' },
        { name: 'mandatory', label: 'Pass / fail?', type: 'select',
          options: [{ value: 'true', label: 'Mandatory — failing it ends the bid' }, { value: 'false', label: 'Optional' }] },
        { name: 'owner', label: 'Owner', type: 'select', options: roleOptions, required: false,
          hint: 'Required on anything mandatory' },
        { name: 'internalDueBy', label: 'Our date', type: 'date', required: false,
          hint: 'Earlier than the buyer’s, and the one that actually binds' },
        { name: 'sourceDocument', label: 'Source document', type: 'text', required: false,
          placeholder: 'Instructions to Tenderers' },
        { name: 'sourceClause', label: 'Clause', type: 'text', required: false },
        { name: 'sourcePage', label: 'Page', type: 'number', required: false, min: 1 },
        { name: 'pageLimit', label: 'Page limit', type: 'number', required: false, min: 1 },
        { name: 'signatureRequired', label: 'Needs a signature?', type: 'select', required: false,
          options: [{ value: '', label: '—' }, { value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }],
          hint: 'A wet signature is a lead time, not a task' },
      ],
      transform: (v) => ({
        reference: v.reference,
        title: v.title,
        mandatory: v.mandatory === 'true',
        ...(v.owner ? { owner: v.owner } : {}),
        ...(v.internalDueBy ? { internalDueBy: v.internalDueBy } : {}),
        ...(v.pageLimit ? { pageLimit: Number(v.pageLimit) } : {}),
        ...(v.signatureRequired ? { signatureRequired: v.signatureRequired === 'true' } : {}),
        ...(v.sourceDocument
          ? {
              source: {
                document: v.sourceDocument,
                ...(v.sourceClause ? { clause: v.sourceClause } : {}),
                ...(v.sourcePage ? { page: Number(v.sourcePage) } : {}),
              },
            }
          : {}),
      }),
    },

    addendum: {
      title: 'Record an addendum',
      intent:
        'It appends. The original issue stays exactly as it was recorded, because "what was the deadline when we planned ' +
        'the bid" is what a late submission turns into a dispute about.',
      path: (v) => `/v1/pipeline/tenders/${v.invitationId}/addenda`,
      submitLabel: 'Record',
      fields: [
        { name: 'invitationId', label: 'Invitation', type: 'select', options: invitationOptions },
        { name: 'reference', label: 'Addendum reference', type: 'text', placeholder: 'ADD-01' },
        { name: 'issuedAt', label: 'Issued', type: 'datetime-local' },
        { name: 'summary', label: 'What it changed', type: 'textarea', rows: 3 },
        { name: 'returnLocal', label: 'Revised return time', type: 'datetime-local', required: false,
          hint: 'Leave blank where the addendum does not move the date. Moving it forces the bid decision to be taken again.' },
      ],
      transform: (v) => ({
        reference: v.reference,
        issuedAt: new Date(v.issuedAt).toISOString(),
        summary: v.summary,
        ...(v.returnLocal ? { returnLocal: v.returnLocal } : {}),
      }),
    },

    programme: {
      title: 'Build the tender programme',
      intent:
        'Back-planned from the return deadline across the working calendar, bank holidays included. Where the window ' +
        'cannot hold the eight stages, the platform refuses and shows the arithmetic rather than compressing them silently.',
      path: (v) => `/v1/pipeline/tenders/${v.invitationId}/programme`,
      submitLabel: 'Build',
      fields: [
        { name: 'invitationId', label: 'Invitation', type: 'select', options: biddableOptions,
          hint: biddableOptions.length === 0 ? 'Nothing has been decided as a bid yet' : 'Only invitations decided as a bid appear here' },
      ],
      transform: () => ({}),
    },
  };

  // Opening a matrix, from either the invitation it belongs to or the list of
  // every matrix on file. One handler, because both buttons are asking for the
  // same thing and a second path to it would be a second thing to keep right.
  const detail = root.querySelector('#matrix-detail');
  root.addEventListener('click', async (event) => {
    const open = event.target.closest('[data-matrix]');
    if (!open || !detail) return;

    const analysisId = open.dataset.matrix;
    open.disabled = true;
    open.textContent = 'Opening…';
    try {
      const analysis = await api.get(`/v1/pipeline/analyses/${analysisId}`);
      render(detail, matrixDetail(analysis));
      detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      // Shown as a denial rather than as an empty panel. A matrix that failed
      // to load and a matrix with nothing in it must not look the same.
      render(detail, notice(`This compliance matrix could not be opened: ${error.message}`, 'err'));
    } finally {
      open.disabled = false;
      open.textContent = 'Open';
    }
  });

  root.querySelector('.cmd-bar')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    const spec = COMMANDS[button.dataset.command];
    if (!spec) return;
    if (await command(spec)) await draw();
  });
}
