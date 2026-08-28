import { api } from '../lib/api.js';
import { head, refusal } from '../lib/estate.js';
import { badge, html, money, raw, render, table, time } from '../lib/ui.js';

/**
 * Predictive intel.
 *
 * A screen with this name usually shows a churn score. This one does not, and
 * the refusal is the design rather than a gap in it: a "churn risk 72%" on an
 * estate of a dozen tenancies is a number invented to look like intelligence,
 * and the first time somebody acts on one and is wrong, every other figure on
 * this console loses its credibility with it.
 *
 * What is here instead is a **queue of things that will happen unless somebody
 * does something**, each with the arithmetic it came from printed beside it, and
 * each ranked by when it lands. An operator can act on "this tenancy loses AI in
 * nine days, because it holds £41 and is spending £4.60 a day". Nobody can act
 * on a score.
 *
 * The panel at the bottom names what is deliberately not forecast, so its
 * absence is a stated position rather than something somebody discovers by
 * looking for it.
 */

const TONE = { CRITICAL: 'bad', WARNING: 'warn', WATCH: 'info' };

export async function intel(root) {
  const position = await api.get('/v1/admin/forecast').catch((error) => ({ error }));

  if (position.error) {
    render(root, html`${head({ title: 'Predictive intel' })}${refusal('The estate forecast', position.error)}`);
    return;
  }

  const signals = position.signals ?? [];
  const grouped = ['CRITICAL', 'WARNING', 'WATCH'].map((severity) => ({
    severity,
    entries: signals.filter((signal) => signal.severity === severity),
  }));

  render(
    root,
    html`
      ${head({
        title: 'Predictive intel',
        intent: position.note,
      })}

      <section class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h2>Critical</h2>
          <div class="metric ${raw(position.counts.critical > 0 ? 'bad' : '')}">${position.counts.critical}</div>
          <div class="metric-sub">something a customer will notice, soon</div>
        </div>
        <div class="card">
          <h2>Warning</h2>
          <div class="metric ${raw(position.counts.warning > 0 ? 'warn' : '')}">${position.counts.warning}</div>
          <div class="metric-sub">worth a conversation this week</div>
        </div>
        <div class="card">
          <h2>Renewing inside ${position.windowDays} days</h2>
          <div class="metric">${money(position.renewalExposureMinor)}</div>
          <div class="metric-sub">monthly subscription value coming up for renewal</div>
        </div>
        <div class="card">
          <h2>Quiet tenancies</h2>
          <div class="metric ${raw(position.quietTenancies > 0 ? 'warn' : '')}">${position.quietTenancies}</div>
          <div class="metric-sub">nothing written for ${position.quietThresholdDays}+ days</div>
        </div>
      </section>

      ${signals.length === 0
        ? html`<div class="empty">
            <b>Nothing lands inside the horizon.</b>No tenancy runs out of credit, comes up for renewal, ends a trial,
            fills its seats or goes quiet in the next ${position.windowDays} days. That is a real answer, not an empty
            screen — the arithmetic ran and found nothing.
          </div>`
        : grouped
            .filter((group) => group.entries.length > 0)
            .map(
              (group) => html`<div class="card pad0" style="margin-bottom:14px">
                <h2 style="padding:15px 17px 0">
                  ${group.severity === 'CRITICAL' ? 'Critical' : group.severity === 'WARNING' ? 'Warning' : 'Watch'}
                  ${badge(String(group.entries.length), TONE[group.severity])}
                </h2>
                <div class="metric-sub" style="padding:0 17px 10px">
                  ${group.severity === 'CRITICAL'
                    ? 'Each of these has already happened or happens within days. A customer finds out by being refused.'
                    : group.severity === 'WARNING'
                      ? 'Each of these lands soon enough that doing nothing is a decision.'
                      : 'Not urgent. Here so that it is not a surprise when it becomes urgent.'}
                </div>
                ${table({
                  headers: ['Tenancy', 'What happens', 'When', 'On what basis', 'What to do'],
                  rows: group.entries.map((signal) => [
                    signal.legalName,
                    html`<b>${signal.headline}</b>`,
                    signal.daysAway === null
                      ? html`<span class="metric-sub">no date</span>`
                      : html`${signal.daysAway} day${signal.daysAway === 1 ? '' : 's'}${
                          signal.dueAt ? html`<div class="metric-sub">${time(signal.dueAt)}</div>` : ''
                        }`,
                    html`<span class="metric-sub">${signal.basis}</span>`,
                    html`<span class="metric-sub">${signal.action}</span>`,
                  ]),
                })}
              </div>`,
            )}

      <div class="card">
        <h2>What this does not forecast</h2>
        <div class="metric-sub" style="margin:8px 0 14px">
          Stated rather than left out, so that somebody looking for one of these knows it was a decision. Each of them
          could be produced; none of them could be produced honestly from what this platform holds.
        </div>
        <div class="split-list">
          ${(position.notForecast ?? []).map((entry) => html`<div class="row"><span class="lbl">${entry}</span></div>`)}
        </div>
      </div>
    `,
  );
}
