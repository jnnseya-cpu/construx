import { api } from '../lib/api.js';
import { badge, html, humanise, money, pct, raw, render, table } from '../lib/ui.js';
import { barChart, kpiCard, pieChart, proportionBar } from '../lib/charts.js';
import { draw, navigate, openProject } from '../app.js';

/**
 * Portfolio Dashboard.
 *
 * One question, asked across every project at once: which of these is in
 * trouble, and how much is riding on it. The Enterprise & Portfolio screen
 * answers "what does the estate consist of and who is in it"; this answers
 * "how is it going", which is a different job and was being done by reading
 * twelve project screens in sequence.
 *
 * **Every figure is read, not scored here.** `/v1/enterprise/command` already
 * computes the estate, the financial position and the delivery standing
 * server-side, under `ENTERPRISE_STRUCTURE R` and with per-project access
 * evaluated as it goes. Recomputing any of it in the browser would produce a
 * console that disagrees with the platform, and a director acting on the
 * disagreement.
 *
 * **Coverage is shown beside every roll-up, and this is the whole difference
 * between this screen and a spreadsheet.** A commercial dashboard that shows
 * "£7.42M actual against £12.80M budget" implies twelve projects reported. Here
 * three of twelve may have published a CVR and the rest have published nothing,
 * and a roll-up over three projects presented as the estate is a number a board
 * would act on. So `financial.coverage` and `delivery.coverage` are rendered as
 * prominently as the totals they qualify, and a project with no measured
 * progress shows *not measured* rather than 0%.
 *
 * **The filters are the dimensions the platform actually has.** Portfolio,
 * sector and region are on every `ProjectRow` already. Manager and department
 * are not dimensions in CONSTRUX — roles are held against a tenancy and the
 * platform has no per-project accountable manager to group by — so they are
 * absent rather than faked from whoever last touched a record.
 *
 * Filtering is client-side over rows the server has already access-filtered.
 * That is safe in a way client-side filtering usually is not: nothing is
 * hidden by the filter that the caller was not already entitled to see, and
 * `withheld` names anything policy removed before it arrived.
 */

/** The three ways a delivery standing reads, and the tone each carries. */
const SCHEDULE_TONE = { ON_TRACK: 'ok', AT_RISK: 'warn', BEHIND: 'bad' };
const COST_TONE = { GREEN: 'ok', AMBER: 'warn', RED: 'bad' };

/** Continent codes to something a person reads. Region is a filter, not a code. */
const REGION = {
  EU: 'Europe',
  NA: 'North America',
  SA: 'South America',
  AF: 'Africa',
  AS: 'Asia',
  OC: 'Oceania',
  AN: 'Antarctica',
};

function regionOf(row) {
  const code = row.location?.continentCode;
  return code ? (REGION[code] ?? code) : 'Region not set';
}

/** Options for one filter, with the count beside each so an empty one is visible before it is chosen. */
function options(rows, keyOf, labelOf = (key) => key) {
  const counts = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => String(labelOf(a[0])).localeCompare(String(labelOf(b[0]))))
    .map(([value, count]) => ({ value, label: `${labelOf(value)} (${count})` }));
}

function select(id, label, chosen, entries) {
  return html`<label class="field" style="min-width:180px">
    <span>${label}</span>
    <select data-filter="${id}">
      <option value=""${raw(chosen ? '' : ' selected')}>All</option>
      ${entries.map(
        (entry) => html`<option value="${entry.value}"${raw(entry.value === chosen ? ' selected' : '')}>${entry.label}</option>`,
      )}
    </select>
  </label>`;
}

/**
 * The filter selection, held on the page rather than in the session.
 *
 * A filter is a way of looking at something, not a fact about the estate, so it
 * does not survive a navigation and is not written anywhere. Re-deriving it
 * from the URL would make it shareable and is a different feature; this is the
 * simplest thing that answers the question.
 */
const chosen = { portfolio: '', sector: '', region: '' };

export async function portfolio(root) {
  const [command, portfolios] = await Promise.all([
    api.get('/v1/enterprise/command').catch((error) => ({ error })),
    api.get('/v1/portfolios').catch(() => ({ portfolios: [] })),
  ]);

  if (command.error) {
    render(
      root,
      html`<div class="view-head"><div><h1>Portfolio Dashboard</h1></div></div>
        <div class="notice warn">
          <div>
            <b>The estate is not visible to your role.</b><br />${command.error.message ?? ''}
            An enterprise administrator, project director or owner sees it; a role scoped to one project sees that
            project's own screens instead.
          </div>
        </div>`,
    );
    return;
  }

  const names = new Map((portfolios.portfolios ?? []).map((entry) => [entry.portfolioId ?? entry.id, entry.name]));
  const portfolioName = (id) => names.get(id) ?? id ?? 'Portfolio not set';

  const all = command.projects ?? [];
  const rows = all.filter(
    (row) =>
      (!chosen.portfolio || row.portfolioId === chosen.portfolio) &&
      (!chosen.sector || row.sectorType === chosen.sector) &&
      (!chosen.region || regionOf(row) === chosen.region),
  );
  const filtered = rows.length !== all.length;
  const currency = command.estate?.currency ?? 'GBP';

  // Recomputed over the filtered set, and only for the figures that are a plain
  // sum of a per-project value. Nothing derived — forecast variance, unapproved
  // exposure and the risk register stay as the platform reported them for the
  // whole estate, because a subset of a derived figure is not that figure.
  const contractValue = rows.reduce((sum, row) => sum + (row.contractValueMinor ?? 0), 0);
  const byStatus = {
    ON_TRACK: rows.filter((row) => row.schedule?.status === 'ON_TRACK').length,
    AT_RISK: rows.filter((row) => row.schedule?.status === 'AT_RISK').length,
    BEHIND: rows.filter((row) => row.schedule?.status === 'BEHIND').length,
  };
  const noBaseline = rows.filter((row) => !row.schedule).length;
  const measured = rows.filter((row) => row.progressPercent !== undefined);
  const withCvr = rows.filter((row) => row.cost !== undefined);
  const openIssues = rows.reduce((sum, row) => sum + (row.openIssues ?? 0), 0);

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Portfolio Dashboard</h1>
          <p>
            Every project at once, as at ${command.asAt?.slice(0, 10) ?? 'now'}. Each figure carries how many projects
            it was computed from — a roll-up over the three that reported is not a statement about the twelve that
            exist.
          </p>
        </div>
        <div class="actions cmd-bar">
          <button class="btn quiet" data-enterprise>Enterprise &amp; Portfolio</button>
        </div>
      </div>

      <section class="card" style="margin-bottom:14px" aria-labelledby="pf-filters-h">
        <h2 id="pf-filters-h">Filters</h2>
        <div class="actions" style="gap:12px;flex-wrap:wrap;align-items:flex-end">
          ${select('portfolio', 'Portfolio', chosen.portfolio, options(all, (row) => row.portfolioId, portfolioName))}
          ${select('sector', 'Sector', chosen.sector, options(all, (row) => row.sectorType, humanise))}
          ${select('region', 'Region', chosen.region, options(all, regionOf))}
          ${filtered ? html`<button class="btn quiet sm" data-filter-clear>Clear</button>` : ''}
        </div>
        ${
          filtered
            ? html`<p class="metric-sub" style="margin-top:10px">
                Showing <b>${rows.length}</b> of ${all.length} projects. The estate totals below follow the filter; the
                risk register and the forecast variance are reported for the whole estate and say so.
              </p>`
            : ''
        }
      </section>

      <div class="grid g4" style="margin-bottom:14px">
        ${kpiCard({
          label: 'Projects',
          value: String(rows.length),
          sub: `${Object.entries(command.estate?.byPhase ?? {}).length} lifecycle phases represented across the estate.`,
        })}
        ${kpiCard({
          label: 'On track',
          value: String(byStatus.ON_TRACK),
          tone: 'good',
          sub: `${byStatus.AT_RISK} at risk, ${byStatus.BEHIND} behind. ${noBaseline} have no approved baseline to judge against.`,
        })}
        ${kpiCard({
          label: 'Contract value',
          value: money(contractValue, currency),
          sub: command.estate?.currency
            ? 'One currency across the estate.'
            : 'The estate holds more than one currency; this total adds minor units and is indicative only.',
          tone: command.estate?.currency ? '' : 'warn',
        })}
        ${kpiCard({
          label: 'Forecast variance',
          value: money(command.financial?.varianceMinor ?? 0, currency),
          tone: (command.financial?.varianceMinor ?? 0) < 0 ? 'bad' : 'good',
          sub:
            `Whole estate, from ${command.financial?.coverage?.withCvr ?? 0} of ` +
            `${command.financial?.coverage?.of ?? 0} projects that have published a CVR.`,
        })}
      </div>

      <div class="grid g2" style="margin-bottom:14px">
        <section class="card" aria-labelledby="pf-cover-h">
          <h2 id="pf-cover-h">What these figures are made of</h2>
          <p class="metric-sub">
            The number that matters before any other. A project with no CVR has published no commercial position, and a
            project with no baseline cannot be called on track or late — neither is counted as good news.
          </p>
          <div class="split-list">
            <div class="row">
              <span class="lbl">Commercial position published</span>
              <span class="val">${command.financial?.coverage?.withCvr ?? 0} of ${command.financial?.coverage?.of ?? 0}</span>
            </div>
            <div class="row">
              <span class="lbl">Approved delivery baseline</span>
              <span class="val">${command.delivery?.coverage?.withBaseline ?? 0} of ${command.delivery?.coverage?.of ?? 0}</span>
            </div>
            <div class="row">
              <span class="lbl">Progress measured</span>
              <span class="val">${measured.length} of ${rows.length}</span>
            </div>
            <div class="row">
              <span class="lbl">Loss-making</span>
              <span class="val ${raw((command.financial?.lossMaking ?? 0) > 0 ? 'bad' : '')}">
                ${command.financial?.lossMaking ?? 0}
              </span>
            </div>
            <div class="row">
              <span class="lbl">Unapproved change exposure</span>
              <span class="val">${money(command.financial?.unapprovedExposureMinor ?? 0, currency)}</span>
            </div>
            <div class="row">
              <span class="lbl">Open issues</span>
              <span class="val">${openIssues}</span>
            </div>
          </div>
          ${
            (command.withheld ?? []).length > 0
              ? html`<div class="notice warn" style="margin-top:12px">
                  <div>
                    <b>${command.withheld.length} thing(s) your role may not see</b> were withheld rather than silently
                    dropped: ${command.withheld.join('; ')}.
                  </div>
                </div>`
              : ''
          }
        </section>

        <section class="card" aria-labelledby="pf-status-h">
          <h2 id="pf-status-h">Delivery standing</h2>
          <p class="metric-sub">
            Against each project's own approved baseline. The fourth bar is the one to read first: a project with no
            baseline is not on track, it is unmeasured.
          </p>
          ${barChart({
            title: 'Projects by delivery standing',
            data: [
              { label: 'On track', value: byStatus.ON_TRACK },
              { label: 'At risk', value: byStatus.AT_RISK },
              { label: 'Behind', value: byStatus.BEHIND },
              { label: 'No baseline', value: noBaseline },
            ],
            format: (value) => String(Math.round(value)),
            empty: 'No project in this filter.',
          })}
        </section>
      </div>

      <div class="grid g2" style="margin-bottom:14px">
        <section class="card" aria-labelledby="pf-sector-h">
          <h2 id="pf-sector-h">Contract value by sector</h2>
          ${pieChart({
            title: 'By sector',
            data: [...options(rows, (row) => row.sectorType).map((entry) => entry.value)].map((sector) => ({
              label: humanise(sector),
              value: rows.filter((row) => row.sectorType === sector).reduce((sum, row) => sum + (row.contractValueMinor ?? 0), 0),
            })),
            format: (value) => money(value, currency),
            empty: 'No project in this filter.',
          })}
        </section>

        <section class="card" aria-labelledby="pf-region-h">
          <h2 id="pf-region-h">The estate by region</h2>
          <p class="metric-sub">
            Regions come from the platform's own grouping of portfolios and projects, so a portfolio recorded before
            regions existed reports as unset rather than being placed somewhere.
          </p>
          ${table({
            headers: ['Region', 'Countries', 'Portfolios', 'Projects', 'Contract value'],
            align: ['', '', 'num', 'num', 'num'],
            rows: (command.byRegion ?? []).map((region) => [
              region.continentCode ? (REGION[region.continentCode] ?? region.continentCode) : 'Not set',
              region.countryCodes.join(', ') || '—',
              region.portfolios,
              region.projects,
              region.currency
                ? money(region.contractValueMinor, region.currency)
                : html`<span title="More than one currency in this region">${money(region.contractValueMinor, currency)}*</span>`,
            ]),
            empty: 'No region has a project in it yet.',
          })}
        </section>
      </div>

      <section class="card pad0" style="margin-bottom:14px" aria-labelledby="pf-summary-h">
        <h2 id="pf-summary-h" style="padding:15px 17px 0">Portfolio summary</h2>
        <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
          Every project the filter admits. <b>Not measured</b> is not zero — it is a project nobody has measured, and
          showing it as 0% would report work that has not been assessed as work that has not been done.
        </p>
        ${table({
          headers: ['Project', 'Portfolio', 'Sector', 'Phase', 'Complete', 'Delivery', 'Commercial', 'Risk', 'Open', 'Contract value'],
          align: ['', '', '', '', 'num', '', '', 'num', 'num', 'num'],
          rows: rows.map((row) => [
            html`<button class="btn quiet sm" data-open-project="${row.projectId}">${row.name}</button>`,
            html`<span style="font-size:12px;color:var(--text-3)">${portfolioName(row.portfolioId)}</span>`,
            html`<span style="font-size:12px;color:var(--text-3)">${humanise(row.sectorType ?? '')}</span>`,
            badge(humanise(row.phase ?? ''), ''),
            row.progressPercent === undefined
              ? html`<span style="color:var(--text-3)">not measured</span>`
              : html`${pct(row.progressPercent, 0)}`,
            row.schedule
              ? html`${badge(humanise(row.schedule.status), SCHEDULE_TONE[row.schedule.status] ?? '')}
                  ${row.schedule.expectedDelayDays > 0
                    ? html`<span style="font-size:11.5px;color:var(--text-3)">${row.schedule.expectedDelayDays}d</span>`
                    : ''}`
              : html`<span style="color:var(--text-3)">no baseline</span>`,
            row.cost
              ? html`${badge(row.cost.status, COST_TONE[row.cost.status] ?? '')}
                  <span style="font-size:11.5px;color:var(--text-3)">${pct(row.cost.forecastMarginPercent, 1)} margin</span>`
              : html`<span style="color:var(--text-3)">no CVR</span>`,
            row.riskScore === undefined ? html`<span style="color:var(--text-3)">—</span>` : Math.round(row.riskScore),
            row.openIssues ?? 0,
            money(row.contractValueMinor ?? 0, row.currency ?? currency),
          ]),
          empty: 'No project matches this filter.',
        })}
        ${
          rows.length > 0
            ? html`<div style="padding:12px 17px 16px">
                ${proportionBar({
                  parts: [
                    { label: 'On track', value: byStatus.ON_TRACK, tone: 'ok' },
                    { label: 'At risk', value: byStatus.AT_RISK, tone: 'warn' },
                    { label: 'Behind', value: byStatus.BEHIND, tone: 'bad' },
                    { label: 'No baseline', value: noBaseline, tone: '' },
                  ],
                  format: (value) => `${value} project${value === 1 ? '' : 's'}`,
                })}
              </div>`
            : ''
        }
      </section>

      <section class="card pad0" aria-labelledby="pf-risk-h">
        <h2 id="pf-risk-h" style="padding:15px 17px 0">Risks across the estate</h2>
        <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
          Reported for the whole estate rather than the filter, because a risk register scoped to a filter reads as a
          smaller exposure than the business carries. ${withCvr.length} of ${rows.length} projects in view have
          published the commercial position these exposures sit against.
        </p>
        ${table({
          headers: ['Project', 'Risk', 'Severity', 'Probability', 'Exposure'],
          align: ['', '', '', 'num', 'num'],
          rows: (command.risks ?? []).map((risk) => [
            html`<button class="btn quiet sm" data-open-project="${risk.projectId}">${risk.projectName}</button>`,
            risk.title,
            badge(risk.severity, risk.severity === 'HIGH' ? 'bad' : risk.severity === 'MEDIUM' ? 'warn' : ''),
            pct(risk.probability * 100, 0),
            money(risk.exposureMinor, currency),
          ]),
          empty: 'No risk is on any project register.',
        })}
      </section>
    `,
  );

  root.addEventListener('change', async (event) => {
    const control = event.target.closest('[data-filter]');
    if (!control) return;
    chosen[control.dataset.filter] = control.value;
    await draw();
  });

  root.addEventListener('click', async (event) => {
    if (event.target.closest('[data-enterprise]')) {
      navigate('enterprise');
      return;
    }

    if (event.target.closest('[data-filter-clear]')) {
      chosen.portfolio = '';
      chosen.sector = '';
      chosen.region = '';
      await draw();
      return;
    }

    const open = event.target.closest('[data-open-project]');
    if (open) {
      // The same act as choosing a project anywhere else. `openProject` does
      // more than set an id — it reloads what the session is allowed to see
      // for that project — so assigning the id here would leave every other
      // screen reading the previous project's permissions.
      await openProject(open.dataset.openProject);
    }
  });
}
