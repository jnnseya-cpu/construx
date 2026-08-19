import { api } from '../lib/api.js';
import { badge, date, html, money, pct, raw, render, table } from '../lib/ui.js';

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

export async function pipeline(root) {
  const [criteria, summary, discipline] = await Promise.all([
    api.get('/v1/pipeline/criteria'),
    api.get('/v1/pipeline'),
    api.get('/v1/pipeline/discipline'),
  ]);

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
      </div>

      <div class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h3>Declined</h3>
          <div class="metric ${raw(discipline.noBid > 0 ? 'good' : 'warn')}">${pct(discipline.noBidRatePercent, 1)}</div>
          <div class="metric-sub">
            ${discipline.noBid} of ${discipline.decided} decided. Refusing bad work is the point of scoring it.
          </div>
        </div>
        <div class="card">
          <h3>Bid effort released</h3>
          <div class="metric">${money(discipline.declinedValueMinor)}</div>
          <div class="metric-sub">Value walked away from — pursuits the bid team did not spend a month on.</div>
        </div>
        <div class="card">
          <h3>Overrides</h3>
          <div class="metric ${raw(discipline.overrides.length === 0 ? 'good' : 'warn')}">${discipline.overrides.length}</div>
          <div class="metric-sub">Decisions taken against the algorithm. Permitted, recorded, never silent.</div>
        </div>
        <div class="card">
          <h3>Live pipeline</h3>
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

      <div class="card pad0" style="margin-bottom:14px">
        <h3 style="padding:15px 17px 0">Do the bands predict?</h3>
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
              <h3 style="padding:15px 17px 0">Decisions taken against the score</h3>
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
          <h3 style="padding:15px 17px 0">The algorithm</h3>
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
          <h3>Where we keep scoring badly</h3>
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
        <h3 style="padding:15px 17px 0">Opportunities</h3>
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
    `,
  );
}
