import { api } from '../lib/api.js';
import { badge, date, html, humanise, money, pct, raw, render, statusTone, table } from '../lib/ui.js';
import { state } from '../app.js';

/**
 * Enterprise & Portfolio.
 *
 * Governance and portfolio performance, not an execution workspace. Delivery
 * workspaces only appear once a specific project is selected — mixing the two
 * is what produces an enterprise dashboard full of things nobody at enterprise
 * level can act on.
 */

export async function enterprise(root) {
  const [portfolios, projects, gates] = await Promise.all([
    api.get('/v1/portfolios').catch(() => ({ portfolios: [] })),
    api.get('/v1/projects').catch(() => ({ projects: [] })),
    api.get('/v1/lifecycle/gates').catch(() => ({ gates: [] })),
  ]);

  const totalValue = projects.projects.reduce((sum, p) => sum + Number(p.contractValueMinor ?? 0), 0);
  const byPhase = new Map();
  for (const project of projects.projects) {
    byPhase.set(project.phase, (byPhase.get(project.phase) ?? 0) + 1);
  }

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
          <h3>Portfolios</h3>
          <div class="metric orange">${portfolios.portfolios.length}</div>
          <div class="metric-sub">under this enterprise</div>
        </div>
        <div class="card">
          <h3>Projects</h3>
          <div class="metric">${projects.projects.length}</div>
          <div class="metric-sub">${[...byPhase.entries()].map(([p, c]) => `${c} ${humanise(p).toLowerCase()}`).join(' · ')}</div>
        </div>
        <div class="card">
          <h3>Total contract value</h3>
          <div class="metric orange">${money(totalValue)}</div>
          <div class="metric-sub">across every active project</div>
        </div>
        <div class="card">
          <h3>Lifecycle phases</h3>
          <div class="metric">${gates.phases?.length ?? 7}</div>
          <div class="metric-sub">each with exit criteria read from state</div>
        </div>
      </div>

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
        <h3 style="padding:15px 17px 0">Projects</h3>
        ${table({
          headers: ['Project', 'Sector', 'Location', 'Value', 'Phase', 'Completion'],
          align: ['', '', '', 'num', '', ''],
          rows: projects.projects.map((p) => [
            p.name,
            humanise(p.sectorType),
            `${p.location?.city ?? ''}, ${p.location?.countryCode ?? ''}`,
            money(p.contractValueMinor, p.currency),
            badge(humanise(p.phase), p.phase === 'OPERATIONS' ? 'ok' : 'info'),
            date(p.plannedCompletion),
          ]),
          empty: 'No projects',
        })}
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
