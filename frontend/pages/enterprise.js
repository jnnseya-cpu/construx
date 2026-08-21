import { api } from '../lib/api.js';
import { badge, date, html, humanise, money, pct, raw, render, statusTone, table } from '../lib/ui.js';
import { blockedReason, can, state } from '../app.js';
import { command, commandBar } from '../lib/command.js';
import { CONTINENT, SECTOR_GROUPED, sectorLabel, today } from '../lib/enums.js';

/**
 * Enterprise & Portfolio.
 *
 * Governance and portfolio performance, not an execution workspace. Delivery
 * workspaces only appear once a specific project is selected — mixing the two
 * is what produces an enterprise dashboard full of things nobody at enterprise
 * level can act on.
 */

export async function enterprise(root) {
  await draw();

  async function draw() {
  // The portfolio position is computed by the API, not assembled here. Every
  // figure below carries the number of projects it was built from, because a
  // total that treats a missing CVR as zero is the most confident wrong number
  // a portfolio screen can print.
  const [position, portfolios, enterprises, gates, ownership] = await Promise.all([
    api.get('/v1/enterprise/command'),
    api.get('/v1/portfolios').catch(() => ({ portfolios: [] })),
    api.get('/v1/enterprises').catch(() => ({ enterprises: [] })),
    api.get('/v1/lifecycle/gates').catch(() => ({ gates: [] })),
    api.get('/v1/ownership').catch(() => ({ areas: [] })),
  ]);

  const { estate, financial, delivery, risks, projects } = position;
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
        <div class="actions cmd-bar">
          ${raw(commandBar([
            {
              id: 'portfolio',
              label: 'Create portfolio',
              permitted: can('ENTERPRISE_STRUCTURE', 'C') && enterprises.enterprises.length > 0,
              reason: enterprises.enterprises.length === 0
                ? 'A portfolio belongs to an enterprise, and this tenancy has none.'
                : blockedReason('ENTERPRISE_STRUCTURE', 'C'),
            },
            {
              id: 'project',
              label: 'Create project',
              tone: '',
              permitted: can('ENTERPRISE_STRUCTURE', 'C') && portfolios.portfolios.length > 0,
              reason: portfolios.portfolios.length === 0
                ? 'A project belongs to a portfolio. Create one first.'
                : blockedReason('ENTERPRISE_STRUCTURE', 'C'),
            },
          ]))}
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

      <div class="card pad0" style="margin-bottom:14px">
        <h3 style="padding:15px 17px 0">Who owns the decision</h3>
        ${table({
          headers: ['Capability', 'Approves', 'Escalates to', 'Creates'],
          rows: (ownership.areas ?? [])
            // Areas nobody approves by design are not gaps and would be noise
            // here. A seat gap is the opposite: it is the row that matters most.
            .filter((a) => a.noApprover !== 'NOT_APPROVABLE')
            .map((a) => {
              const first = a.approve[0];
              const behind = a.approve.slice(1);
              return [
                humanise(a.area),
                // Guarded on the name being there rather than on the flag. The
                // flag says why it is missing; the name is what this cell needs,
                // and a page that reads one and dereferences the other is one
                // API change away from rendering nothing at all.
                // `html` rather than a plain string: table cells are escaped by
                // default, which is right — a person's name is data, not markup.
                first === undefined
                  ? badge('No seat', 'bad')
                  : html`${first.name} <span class="metric-sub">${first.role}</span>`,
                behind.length === 0 ? '—' : behind.map((o) => o.name).join(' → '),
                a.create.length === 0 ? '—' : `${a.create[0].name}${a.create.length > 1 ? ` +${a.create.length - 1}` : ''}`,
              ];
            }),
          empty: 'No capability areas resolved',
        })}
        <div class="metric-sub" style="padding:0 17px 14px">
          Named from the permission matrix, most specialised first — the planner owns a baseline, the project
          manager is the escalation, the client is behind both. <b>No seat</b> means roles approve in that area
          and nobody in this tenancy holds one, so the queue cannot drain until a seat is filled.
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

  /**
   * The two commands that put something into the estate.
   *
   * This page read the portfolio and could not add to it: `POST /v1/portfolios`
   * and `POST /v1/projects` existed with no way to reach them from the console,
   * so an enterprise admin could see the estate and not create a project in it.
   *
   * `location` is sent as the nested object the schema now requires, which is
   * why `transform` exists here — the form is flat because a person fills in
   * three boxes, and the command is nested because that is the shape the ledger
   * stores.
   */
  const COMMANDS = {
    portfolio: {
      title: 'Create a portfolio',
      intent: 'A portfolio is the reporting and governance boundary a project is created inside.',
      path: '/v1/portfolios',
      submitLabel: 'Create portfolio',
      fields: [
        { name: 'name', label: 'Portfolio name' },
        {
          name: 'enterpriseId',
          label: 'Enterprise',
          type: 'select',
          options: enterprises.enterprises.map((e) => ({ value: e.id, label: e.name })),
        },
        {
          name: 'governanceModel',
          label: 'Governance model',
          type: 'select',
          options: [
            { value: 'CENTRALISED', label: 'Centralised' },
            { value: 'DEVOLVED', label: 'Devolved' },
            { value: 'HYBRID', label: 'Hybrid' },
          ],
        },
        { name: 'continentCode', label: 'Region', type: 'select', options: CONTINENT },
        { name: 'countryCode', label: 'Country code', hint: 'Two letters, ISO 3166-1 — GB, US, AE' },
        { name: 'city', label: 'City' },
        {
          name: 'reportingCadence',
          label: 'Reporting cadence',
          type: 'select',
          options: [
            { value: 'MONTHLY', label: 'Monthly' },
            { value: 'FORTNIGHTLY', label: 'Fortnightly' },
            { value: 'WEEKLY', label: 'Weekly' },
          ],
        },
      ],
      transform: (f) => ({ ...f, countryCode: String(f.countryCode ?? '').toUpperCase() }),
    },

    project: {
      title: 'Create a project',
      intent: 'The project starts at CONCEPT. Every later phase is reached by meeting a gate, not by being set here.',
      path: '/v1/projects',
      submitLabel: 'Create project',
      fields: [
        {
          name: 'portfolioId',
          label: 'Portfolio',
          type: 'select',
          options: portfolios.portfolios.map((p) => ({ value: p.id, label: p.name })),
        },
        { name: 'name', label: 'Project name' },
        // Grouped so a reader looking for "Building" finds it, while the value
        // stored stays one of the nine ONS categories.
        { name: 'sectorType', label: 'Sector', type: 'select', options: SECTOR_GROUPED },
        { name: 'assetType', label: 'Asset type', hint: 'What is being built — "Reservoir spillway", "Distribution centre"' },
        { name: 'continentCode', label: 'Region', type: 'select', options: CONTINENT },
        { name: 'countryCode', label: 'Country code', hint: 'Two letters, ISO 3166-1' },
        { name: 'city', label: 'City' },
        { name: 'contractValueMinor', label: 'Contract value', type: 'number', hint: 'In minor units — pence for GBP' },
        {
          name: 'currency',
          label: 'Currency',
          type: 'select',
          options: [
            { value: 'GBP', label: 'GBP — pound sterling' },
            { value: 'EUR', label: 'EUR — euro' },
            { value: 'USD', label: 'USD — US dollar' },
            { value: 'AED', label: 'AED — UAE dirham' },
          ],
        },
        { name: 'plannedStart', label: 'Planned start', type: 'date', value: today() },
        { name: 'plannedCompletion', label: 'Planned completion', type: 'date' },
      ],
      transform: ({ continentCode, countryCode, city, contractValueMinor, ...rest }) => ({
        ...rest,
        contractValueMinor: Number(contractValueMinor),
        location: { continentCode, countryCode: String(countryCode ?? '').toUpperCase(), city },
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
}
