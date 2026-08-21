import { api } from '../lib/api.js';
import { badge, date, html, humanise, money, pct, raw, render, statusTone, table } from '../lib/ui.js';
import { state } from '../app.js';
import { sectorLabel } from '../lib/enums.js';

/**
 * Enterprise & Portfolio.
 *
 * Governance and portfolio performance, not an execution workspace. Delivery
 * workspaces only appear once a specific project is selected — mixing the two
 * is what produces an enterprise dashboard full of things nobody at enterprise
 * level can act on.
 */

export async function enterprise(root) {
  // The portfolio position is computed by the API, not assembled here. Every
  // figure below carries the number of projects it was built from, because a
  // total that treats a missing CVR as zero is the most confident wrong number
  // a portfolio screen can print.
  const [command, portfolios, gates] = await Promise.all([
    api.get('/v1/enterprise/command'),
    api.get('/v1/portfolios').catch(() => ({ portfolios: [] })),
    api.get('/v1/lifecycle/gates').catch(() => ({ gates: [] })),
  ]);

  const { estate, financial, delivery, risks, projects } = command;
  const currency = estate.currency ?? 'GBP';
  const mixed = estate.currency === null;

  /** "n of m projects" — the coverage line under a figure built from a subset. */
  const from = (n) => `from ${n} of ${estate.projects} project${estate.projects === 1 ? '' : 's'}`;

  const STATUS_TONE = { GREEN: 'ok', AMBER: 'warn', RED: 'bad', ON_TRACK: 'ok', AT_RISK: 'warn', BEHIND: 'bad' };

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Enterprise &amp; Portfolio</h1>
          <p>${state.session.enterprise} — governance, structure and portfolio performance. Execution happens inside a project.</p>
        </div>
      </div>

      <div class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h3>Estate</h3>
          <div class="metric orange">${estate.projects}</div>
          <div class="metric-sub">
            ${Object.entries(estate.byPhase).map(([p, c]) => `${c} ${humanise(p).toLowerCase()}`).join(' · ') || 'no projects'}
          </div>
        </div>
        <div class="card">
          <h3>Contract value</h3>
          <div class="metric">${mixed ? '—' : money(estate.totalContractValueMinor, currency)}</div>
          <div class="metric-sub">
            ${mixed
              ? 'Mixed currencies — a single total would be a wrong number'
              : `across ${portfolios.portfolios.length} portfolio${portfolios.portfolios.length === 1 ? '' : 's'}`}
          </div>
        </div>
        <div class="card">
          <h3>Forecast variance</h3>
          <div class="metric ${raw(financial.varianceMinor < 0 ? 'bad' : 'good')}">
            ${financial.coverage.withCvr === 0 ? '—' : money(financial.varianceMinor, currency)}
          </div>
          <div class="metric-sub">
            ${financial.coverage.withCvr === 0
              ? 'No project has published a CVR'
              : `${from(financial.coverage.withCvr)}${financial.lossMaking > 0 ? ` · ${financial.lossMaking} loss-making` : ''}`}
          </div>
        </div>
        <div class="card">
          <h3>Delivery</h3>
          <div class="metric ${raw(delivery.behind > 0 ? 'bad' : delivery.atRisk > 0 ? 'warn' : 'good')}">
            ${delivery.coverage.withBaseline === 0 ? '—' : `${delivery.onTrack}/${delivery.coverage.withBaseline}`}
          </div>
          <div class="metric-sub">
            ${delivery.coverage.withBaseline === 0
              ? 'No approved baseline to measure against'
              : `on track · ${delivery.atRisk} at risk · ${delivery.behind} behind · worst ${delivery.worstDelayDays}d`}
          </div>
        </div>
      </div>

      ${
        risks.length > 0
          ? html`<div class="card pad0" style="margin-bottom:14px">
              <h3 style="padding:15px 17px 0">Largest exposures across the estate</h3>
              ${table({
                headers: ['Risk', 'Project', 'Severity', 'Probability', 'Exposure'],
                align: ['', '', '', 'num', 'num'],
                rows: risks.map((r) => [
                  r.title,
                  r.projectName,
                  badge(r.severity, r.severity === 'HIGH' ? 'bad' : r.severity === 'MEDIUM' ? 'warn' : 'neutral'),
                  pct(r.probability * 100, 0),
                  money(r.exposureMinor, currency),
                ]),
              })}
              <div class="metric-sub" style="padding:0 17px 14px">
                Expected value — probability against three-point impact — not a worst case. The five largest of
                ${risks.length === 5 ? 'the open register' : `${risks.length} open`}.
              </div>
            </div>`
          : ''
      }

      <div class="card pad0" style="margin-bottom:14px">
        <h3 style="padding:15px 17px 0">Portfolios</h3>
        ${table({
          headers: ['Portfolio', 'Governance', 'Region', 'Budget target', 'Cadence', 'Risk appetite'],
          align: ['', '', '', 'num', '', ''],
          rows: portfolios.portfolios.map((p) => [
            p.name,
            p.governanceModel,
            `${p.city ?? ''}${p.countryCode ? `, ${p.countryCode}` : ''}`,
            p.targets?.budgetMinor ? money(p.targets.budgetMinor) : '—',
            humanise(p.reportingCadence ?? ''),
            p.riskAppetite ? `${p.riskAppetite.costTolerancePercent}% cost · ${p.riskAppetite.scheduleToleranceDays}d schedule` : '—',
          ]),
          empty: 'No portfolios',
        })}
      </div>

      <div class="card pad0" style="margin-bottom:14px">
        <h3 style="padding:15px 17px 0">Project control</h3>
        ${table({
          headers: ['Project', 'Sector', 'Phase', 'Progress', 'Cost', 'Schedule', 'Risk', 'Open', 'Value'],
          align: ['', '', '', 'num', '', '', 'num', 'num', 'num'],
          rows: projects.map((p) => [
            p.name,
            sectorLabel(p.sectorType),
            badge(humanise(p.phase), p.phase === 'OPERATIONS' ? 'ok' : 'info'),
            // A dash, not a nought. Nothing measured is a different statement
            // from measured at zero, and only one of them is bad news.
            p.progressPercent === undefined ? '—' : pct(p.progressPercent, 0),
            p.cost ? badge(p.cost.status, STATUS_TONE[p.cost.status]) : '—',
            p.schedule ? badge(humanise(p.schedule.status), STATUS_TONE[p.schedule.status]) : '—',
            p.riskScore === undefined ? '—' : String(p.riskScore),
            String(p.openIssues),
            money(p.contractValueMinor, p.currency),
          ]),
          empty: 'No projects',
        })}
        <div class="metric-sub" style="padding:0 17px 14px">
          A dash is not a zero. Cost is blank until a CVR is published, schedule until a baseline is approved,
          progress until something is measured — and a portfolio total that filled those in with nought would read
          as confident and be wrong.
        </div>
      </div>

      <div class="card">
        <h3>Lifecycle gates — what must be true to advance</h3>
        ${table({
          headers: ['Phase', 'Purpose', 'Exit criteria'],
          rows: (gates.gates ?? []).map((g) => [
            badge(humanise(g.phase), g.phase === state.project?.phase ? 'ai' : 'neutral'),
            g.purpose,
            (g.exitCriteria ?? []).length === 0 ? '—' : g.exitCriteria.map((c) => c.description).join(' · '),
          ]),
        })}
        <div class="metric-sub" style="margin-top:10px">
          Gates are evaluated from materialised state, never asserted. A project cannot be marked as having passed a gate it has not met.
        </div>
      </div>
    `,
  );
}
