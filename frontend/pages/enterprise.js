import { api } from '../lib/api.js';
import { badge, date, html, humanise, money, pct, raw, render, statusTone, table, toast } from '../lib/ui.js';
import { blockedReason, can, openProject, state, tenantGrantableRoles } from '../app.js';
import { command, commandBar } from '../lib/command.js';
import { CONTINENT, COUNTRY, SECTOR_GROUPED, sectorLabel, today } from '../lib/enums.js';

/**
 * Enterprise & Portfolio.
 *
 * Governance and portfolio performance, not an execution workspace. Delivery
 * workspaces only appear once a specific project is selected — mixing the two
 * is what produces an enterprise dashboard full of things nobody at enterprise
 * level can act on.
 *
 * **Where you operate** leads the page, because this is a worldwide platform
 * and the estate had no view of that at all. The region was a column on the
 * portfolio table showing the city and the country code, which is an address
 * rather than a region: an estate of forty portfolios could not be read as
 * "we are in four regions and two of them are one project deep". It is the
 * first question anybody running a multi-country business asks and it was the
 * one thing the enterprise screen could not answer.
 */

/** The region's name, from the shared vocabulary rather than a second list. */
const regionLabel = (code) => CONTINENT.find((option) => option.value === code)?.label ?? code ?? 'Not stated';

/**
 * The page for somebody the estate position is refused to.
 *
 * A project manager holds read on project setup, so the screen opens; they do
 * not hold enterprise-level commercial authority, so `/v1/enterprise/command`
 * refuses them. Both are right. What was wrong was rendering nothing: the
 * refusal threw before the first element was drawn, and a project manager
 * opening Enterprise & Portfolio saw an empty page with no explanation.
 *
 * This is what is left when the money is taken out — the structure the platform
 * is built on, which is not sensitive and is the thing a project manager most
 * needs from this screen: which portfolio their project sits under and where in
 * the world it operates.
 */
function structureOnly(refusal, portfolios, enterprises, gates) {
  const regions = new Map();
  for (const portfolio of portfolios.portfolios ?? []) {
    const code = portfolio.continentCode ?? '';
    const entry = regions.get(code) ?? { code, portfolios: [], countries: new Set() };
    entry.portfolios.push(portfolio);
    if (portfolio.countryCode) entry.countries.add(portfolio.countryCode);
    regions.set(code, entry);
  }

  return html`
    <div class="page-head">
      <h1>Enterprise &amp; Portfolio</h1>
      <p>Where the business operates, and the gates every project is held to.</p>
    </div>

    <div class="notice warn" style="margin-bottom:14px">
      <div>
        <b>The estate position is not yours to see</b><br />
Enterprise-wide cost, margin and risk need enterprise-level authority${
          refusal?.message ? html` — ${refusal.message}` : ''
        }. The structure below is not commercial and is shown in full.
      </div>
    </div>

    <div class="card pad0" style="margin-bottom:14px">
      <h2 style="padding:15px 17px 0">
        Where you operate
        ${badge(`${regions.size} region${regions.size === 1 ? '' : 's'}`, regions.size > 1 ? 'ok' : 'neutral')}
      </h2>
      <div class="metric-sub" style="padding:0 17px 10px">
        A portfolio names the region it operates in, and every project is held to its portfolio's region — so a European
        portfolio refuses a Kenyan project rather than filing it and producing a European rollup that is quietly wrong.
      </div>
      ${table({
        headers: ['Region', 'Countries', 'Portfolios'],
        align: ['', '', 'num'],
        rows: [...regions.values()].map((r) => [
          html`<b>${regionLabel(r.code)}</b>`,
          r.countries.size > 0 ? [...r.countries].join(', ') : html`<span class="metric-sub">multi-country</span>`,
          r.portfolios.length,
        ]),
        empty: 'No portfolios yet. The first one names the region it operates in.',
      })}
    </div>

    <div class="card pad0" style="margin-bottom:14px">
      <h2 style="padding:15px 17px 0">Portfolios</h2>
      ${table({
        headers: ['Portfolio', 'Enterprise', 'Governance', 'Region'],
        rows: (portfolios.portfolios ?? []).map((p) => [
          p.name,
          (enterprises.enterprises ?? []).find((e) => e.id === p.enterpriseId)?.name ?? '—',
          p.governanceModel,
          html`<b>${regionLabel(p.continentCode)}</b><div class="metric-sub">${
            p.countryCode ? `${p.countryCode} only` : 'multi-country'
          }</div>`,
        ]),
        empty: 'No portfolios',
      })}
    </div>

    <div class="card pad0">
      <h2 style="padding:15px 17px 0">Lifecycle gates — what must be true to advance</h2>
      ${table({
        headers: ['Phase', 'Purpose', 'Exit criteria'],
        rows: (gates.gates ?? []).map((g) => [
          humanise(g.phase),
          g.purpose,
          (g.exitCriteria ?? []).length === 0 ? '—' : g.exitCriteria.map((c) => c.description).join(' · '),
        ]),
        empty: 'No gates published',
      })}
    </div>
  `;
}

/** Whether the signed-in identity administers this tenancy — the same test the routes apply. */
function administers() {
  const roles = state.session?.user?.roles ?? [];
  return roles.includes('ENTERPRISE_ADMIN') || roles.includes('OWNER');
}

/** Where a person is: active, deactivated, deletion pending with its date, or erased. */
function personStatus(person) {
  if (person.erasedAt) return badge('erased', 'neutral');
  if (person.erasureDueAt) return html`${badge('deletion pending', 'warn')} <span class="metric-sub">on ${date(person.erasureDueAt)}</span>`;
  if (person.status === 'SUSPENDED') return badge('deactivated', 'warn');
  return badge(String(person.status ?? '').toLowerCase() || 'unknown', statusTone(person.status));
}

/**
 * The actions an administrator has on a person, by where they are. Nothing is
 * offered on the administrator's own row: the platform refuses it, and a button
 * that only ever refuses is a trap.
 */
function personActions(person) {
  const self = person.id === state.session?.user?.id;
  if (self || person.erasedAt) return '';
  const act = (action, label, tone = 'quiet') =>
    html`<button class="btn ${tone} sm" data-person-action="${action}" data-user="${person.id}" data-name="${person.name}">${label}</button>`;
  if (person.erasureDueAt) return html`${act('cancel-erasure', 'Cancel deletion')} ${act('erase', 'Delete now', 'quiet danger')}`;
  if (person.status === 'SUSPENDED') return html`${act('reactivate', 'Reactivate')} ${act('delete', 'Delete', 'quiet danger')} ${act('erase', 'Delete now', 'quiet danger')}`;
  return act('deactivate', 'Deactivate');
}

export async function enterprise(root) {
  await draw();

  async function draw() {
  // The portfolio position is computed by the API, not assembled here. Every
  // figure below carries the number of projects it was built from, because a
  // total that treats a missing CVR as zero is the most confident wrong number
  // a portfolio screen can print.
  // The estate position needs enterprise authority, and the matrix the API
  // publishes already says whether this role holds it. Asking anyway produced
  // three refusals the page then handled correctly — and three red lines in the
  // browser console on every visit by a project-level role, which is what a
  // person opening the developer tools reads as "this screen is broken". The
  // refusal is the same either way; it is decided here from the published
  // matrix rather than learned from the server, and the server still decides
  // for anybody who edits this file.
  const estateVisible = can('ENTERPRISE_STRUCTURE', 'R');
  const refusedLocally = { refused: { message: blockedReason('ENTERPRISE_STRUCTURE', 'R') } };

  const [position, portfolios, enterprises, gates, ownership, changes, forecast, people, invitations] = await Promise.all([
    // Caught rather than thrown. A project-level role is *correctly* refused
    // the estate-wide commercial position — and for every role below
    // enterprise level the refusal once took the whole screen down and
    // rendered nothing at all. Not a permission problem: a blank page where a
    // refusal belonged.
    estateVisible ? api.get('/v1/enterprise/command').catch((error) => ({ refused: error })) : Promise.resolve(refusedLocally),
    api.get('/v1/portfolios').catch(() => ({ portfolios: [] })),
    api.get('/v1/enterprises').catch(() => ({ enterprises: [] })),
    api.get('/v1/lifecycle/gates').catch(() => ({ gates: [] })),
    api.get('/v1/ownership').catch(() => ({ areas: [] })),
    estateVisible ? api.get('/v1/enterprise/changes').catch(() => null) : Promise.resolve(null),
    estateVisible ? api.get('/v1/enterprise/forecast').catch(() => null) : Promise.resolve(null),
    // Everybody in this tenancy. A tenancy that can create people but never
    // list them makes "change what somebody may do" unusable, because you
    // cannot change the roles of a person you cannot find.
    api.get('/v1/users').catch(() => ({ users: [] })),
    // Who has been asked onto this project and whether they took it up, with
    // the seat position beside it — an invitation holds a seat, and somebody
    // about to send one needs to know whether there is one to give.
    api.get(`/v1/projects/${state.session.projectId}/invitations`).catch(() => null),
  ]);

  // What somebody without enterprise authority can still see: where the
  // business operates, what the portfolios are, and the gates every project is
  // held to. None of it is commercially sensitive, and it is the structure the
  // platform is built on — enterprise, portfolio, region, project.
  if (position.refused) {
    render(root, structureOnly(position.refused, portfolios, enterprises, gates));
    return;
  }

  const { estate, financial, delivery, risks, projects } = position;
  const currency = estate.currency ?? 'GBP';
  const mixed = estate.currency === null;

  /** "n of m projects" — the coverage line under a figure built from a subset. */
  const from = (n) => `from ${n} of ${estate.projects} project${estate.projects === 1 ? '' : 's'}`;

  const STATUS_TONE = { GREEN: 'ok', AMBER: 'warn', RED: 'bad', ON_TRACK: 'ok', AT_RISK: 'warn', BEHIND: 'bad' };

  // The API's answer, not a second one assembled here.
  //
  // This was computed in the browser from `/v1/portfolios` joined to the estate
  // rows — and it did not work, because a project row carried no portfolio to
  // join on, so every project landed under "Not stated" while the regions that
  // actually held them read zero. The rollup is a rule about the estate rather
  // than a way of drawing it, and the console holds no rule the API has not
  // published. `enterpriseCommand` computes it now, from the portfolio each
  // project is filed under rather than from the project's own location, because
  // that is the direction the hierarchy runs.
  const regions = position.byRegion ?? [];

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Enterprise &amp; Portfolio</h1>
          <p>
            ${state.session.enterprise ?? 'Nothing has been created here yet'} — governance, structure and portfolio
            performance. Execution happens inside a project.
          </p>
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
            {
              id: 'invite',
              label: 'Invite to this project',
              // Not `ENTERPRISE_STRUCTURE:G`, which is the administrator's
              // grant. Anybody working on the project may bring somebody onto
              // it — that is the whole point of the command — and the platform
              // decides whether the caller is working on it or merely reading
              // it, from the same matrix this screen reads.
              permitted: can('PROJECT_SETUP', 'R') && (invitations?.seats?.remaining ?? 1) !== 0,
              reason:
                invitations?.seats?.remaining === 0
                  ? `Every identity in this package is taken or invited (${invitations.seats.assigned} assigned, ${invitations.seats.heldByInvitations} invited). Move package, or withdraw an invitation.`
                  : blockedReason('PROJECT_SETUP', 'R'),
            },
            {
              id: 'person',
              label: 'Add a person',
              // `G` rather than `C`: adding somebody to the tenancy grants them
              // authority, which is a governance act rather than the creation
              // of a record.
              permitted: can('ENTERPRISE_STRUCTURE', 'G'),
              reason: blockedReason('ENTERPRISE_STRUCTURE', 'G'),
            },
          ]))}
        </div>
      </div>

      <div class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h2>Estate</h2>
          <div class="metric orange">${estate.projects}</div>
          <div class="metric-sub">
            ${Object.entries(estate.byPhase).map(([p, c]) => `${c} ${humanise(p).toLowerCase()}`).join(' · ') || 'no projects'}
          </div>
        </div>
        <div class="card">
          <h2>Contract value</h2>
          <div class="metric">${mixed ? '—' : money(estate.totalContractValueMinor, currency)}</div>
          <div class="metric-sub">
            ${mixed
              ? 'Mixed currencies — a single total would be a wrong number'
              : `across ${portfolios.portfolios.length} portfolio${portfolios.portfolios.length === 1 ? '' : 's'}`}
          </div>
        </div>
        <div class="card">
          <h2>Forecast variance</h2>
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
          <h2>Delivery</h2>
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
              <h2 style="padding:15px 17px 0">Largest exposures across the estate</h2>
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
        <h2 style="padding:15px 17px 0">
          Where you operate
          ${badge(`${regions.length} region${regions.length === 1 ? '' : 's'}`, regions.length > 1 ? 'ok' : 'neutral')}
        </h2>
        <div class="metric-sub" style="padding:0 17px 10px">
          A portfolio names the region it operates in, and every project is held to its portfolio's region — so a
          European portfolio refuses a Kenyan project rather than filing it and producing a European rollup that is
          quietly wrong. A portfolio with no country is regional on purpose and takes any country inside its region.
        </div>
        ${table({
          headers: ['Region', 'Countries', 'Portfolios', 'Projects', 'Contract value'],
          align: ['', '', 'num', 'num', 'num'],
          rows: regions.map((r) => [
            html`<b>${regionLabel(r.continentCode)}</b>${
              r.continentCode
                ? html`<div class="metric-sub mono" style="font-size:10.5px">${r.continentCode}</div>`
                : html`<div class="metric-sub">recorded before a region was required</div>`
            }`,
            r.countryCodes.length > 0
              ? r.countryCodes.join(', ')
              : html`<span class="metric-sub">no country recorded yet</span>`,
            r.portfolios,
            r.projects,
            r.contractValueMinor > 0
              ? r.currency
                ? money(r.contractValueMinor, r.currency)
                : html`<span class="metric-sub">mixed currencies</span>`
              : '—',
          ]),
          empty: 'No portfolios yet. The first one names the region it operates in.',
        })}
      </div>

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">Portfolios</h2>
        ${table({
          headers: ['Portfolio', 'Governance', 'Region', 'Budget target', 'Cadence', 'Risk appetite'],
          align: ['', '', '', 'num', '', ''],
          rows: portfolios.portfolios.map((p) => [
            p.name,
            p.governanceModel,
            html`<b>${regionLabel(p.continentCode)}</b><div class="metric-sub">${
              p.countryCode ? `${p.city ? `${p.city}, ` : ''}${p.countryCode} only` : `${p.city ?? 'multi-country'}`
            }</div>`,
            p.targets?.budgetMinor ? money(p.targets.budgetMinor) : '—',
            humanise(p.reportingCadence ?? ''),
            p.riskAppetite ? `${p.riskAppetite.costTolerancePercent}% cost · ${p.riskAppetite.scheduleToleranceDays}d schedule` : '—',
          ]),
          empty: 'No portfolios',
        })}
      </div>

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">Project control</h2>
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

      ${
        changes && changes.total > 0
          ? html`<div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">What changed — last seven days</h2>
              ${table({
                headers: ['Area', 'Movements', 'Most recent'],
                align: ['', 'num', ''],
                rows: changes.groups.map((g) => [
                  humanise(g.group),
                  // The count is the honest headline; the sample is what to
                  // look at. A change the reader may not open is counted and
                  // said to be withheld, never described and never dropped.
                  g.withheld > 0
                    ? html`${g.count} <span class="metric-sub">${g.withheld} withheld</span>`
                    : String(g.count),
                  g.sample.length === 0
                    ? '—'
                    : html`${humanise(g.sample[0].eventType)}
                        <span class="metric-sub">${g.sample[0].projectName} · ${date(g.sample[0].timestamp)}</span>`,
                ]),
              })}
              <div class="metric-sub" style="padding:0 17px 14px">
                ${changes.total} movement${changes.total === 1 ? '' : 's'} across the estate, grouped by the event
                catalogue. Busiest first — what moved most is what to look at.
              </div>
            </div>`
          : ''
      }

      ${
        forecast
          ? html`<div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">Completion confidence</h2>
              ${table({
                headers: ['Project', 'P50 (wd)', 'P80 (wd)', 'Contract (wd)', 'Overrun at P80'],
                align: ['', 'num', 'num', 'num', 'num'],
                rows: forecast.projects.map((p) => [
                  p.name,
                  String(p.p50Days),
                  String(p.p80Days),
                  p.contractualDurationDays === undefined ? '—' : String(p.contractualDurationDays),
                  p.overrunAtP80Days === undefined
                    ? badge('On time', 'ok')
                    : badge(`+${p.overrunAtP80Days}d`, 'bad'),
                ]),
                empty: 'No project has a network to simulate',
              })}
              <div class="metric-sub" style="padding:0 17px 14px">
                ${forecast.lateAtP80} of ${forecast.coverage.simulated} miss their date at P80${
                  forecast.exposedContractValueMinor > 0 && forecast.currency
                    ? ` · ${money(forecast.exposedContractValueMinor, forecast.currency)} of contract value exposed`
                    : ''
                }.
                From ${forecast.iterations} iterations per project.
                ${
                  forecast.notSimulated.length > 0
                    ? html`<br>Not simulated: ${forecast.notSimulated.map((n) => n.name).join(', ')} — no network to run.`
                    : ''
                }
                There is no portfolio P80: two projects do not share a critical path, so a combined figure would
                have a confidence interval and no meaning.
              </div>
            </div>`
          : ''
      }

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">Who owns the decision</h2>
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
        <h2>Lifecycle gates — what must be true to advance</h2>
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

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">
          Invited onto this project
          ${
            invitations?.seats
              ? badge(
                  invitations.seats.remaining === null
                    ? 'unlimited identities'
                    : `${invitations.seats.remaining} identit${invitations.seats.remaining === 1 ? 'y' : 'ies'} left`,
                  invitations.seats.remaining === 0 ? 'bad' : invitations.seats.remaining === null ? 'neutral' : 'ok',
                )
              : ''
          }
        </h2>
        <div class="metric-sub" style="padding:0 17px 10px">
          Anybody working on this project may bring somebody onto it — the designer, the temporary works engineer, the
          client's representative, a subcontractor's own QS. Internal or external, each one is a full identity against
          the package's allowance, and the seat is held from the moment the invitation is sent rather than when it is
          accepted: promising a place the business cannot give is worse than refusing the person who sent it.
        </div>
        ${table({
          headers: ['Name', 'Email', 'With', 'Roles', 'Invited by', 'Expires', 'Status'],
          rows: (invitations?.invitations ?? []).map((invite) => [
            invite.name,
            invite.email,
            invite.external
              ? html`${invite.organisation ?? '—'}${badge('external', 'warn')}`
              : html`<span class="metric-sub">this organisation</span>`,
            html`${(invite.roles ?? []).map((role) => badge(humanise(role), 'neutral'))}`,
            (people.users ?? []).find((u) => u.id === invite.invitedBy)?.name ?? invite.invitedBy,
            date(invite.expiresAt),
            badge(humanise(invite.status), statusTone(invite.status)),
          ]),
          empty: 'Nobody has been invited to this project yet.',
        })}
        ${
          invitations?.seats && invitations.seats.remaining !== null
            ? html`<div class="metric-sub" style="padding:10px 17px 15px">
                ${invitations.seats.assigned} identit${invitations.seats.assigned === 1 ? 'y' : 'ies'} assigned and
                ${invitations.seats.heldByInvitations} held by outstanding invitations, against
                ${invitations.seats.includedSeats} in this package.
              </div>`
            : ''
        }
      </div>

      <div class="card" data-people>
        <h2>People in this tenancy</h2>
        ${table({
          headers: administers() ?['Name', 'Email', 'Roles', 'Status', ''] : ['Name', 'Email', 'Roles', 'Status'],
          rows: (people.users ?? []).map((person) => [
            person.name,
            person.email,
            // Not `.join(' ')`: `badge` returns a template rather than a
            // string, so joining stringifies each one to "[object Object]".
            // The tagged template resolves an array of them properly.
            html`${(person.roles ?? []).map((role) => badge(humanise(role), 'neutral'))}`,
            personStatus(person),
            ...(administers() ?[personActions(person)] : []),
          ]),
          empty:
            'Nobody has been added yet. A tenancy with one administrator and no colleagues cannot separate ' +
            'who proposes from who approves, which is what most of the governance in this platform rests on.',
        })}
        <div class="metric-sub" style="margin-top:10px">
          Roles are offered from the list the platform publishes as grantable. The operator roles are not on it:
          an administrator who could mint a platform operator would hold the power to credit their own wallet,
          which would defeat every control on the money model.
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
    invite: {
      title: 'Invite somebody onto this project',
      intent:
        'Internal or external. They become a full identity against this package\u2019s allowance, and the seat is held ' +
        'from now rather than from when they accept.',
      path: `/v1/projects/${state.session.projectId}/invitations`,
      submitLabel: 'Send the invitation',
      fields: [
        { name: 'name', label: 'Name' },
        { name: 'email', label: 'Work email' },
        {
          name: 'external',
          label: 'Which organisation',
          type: 'select',
          options: [
            { value: 'false', label: 'Ours — they work here' },
            { value: 'true', label: 'External — another company' },
          ],
        },
        {
          name: 'organisation',
          label: 'Their organisation',
          required: false,
          hint: 'Required for an external invitee. "Who are they with" is the first question anybody asks.',
        },
        {
          name: 'roles',
          label: 'What they may do',
          type: 'select',
          multiple: true,
          options: tenantGrantableRoles().map((role) => ({ value: role, label: humanise(role) })),
        },
        {
          name: 'because',
          label: 'Why they are being added',
          type: 'textarea',
          rows: 3,
          hint: 'A sentence somebody reviewing the project team in six months will understand.',
        },
      ],
      // `external` arrives from a select as a string, and `Boolean('false')` is
      // true — the classic way a safety flag inverts itself in transit.
      transform: (f) => ({
        ...f,
        external: String(f.external) === 'true',
        roles: Array.isArray(f.roles) ? f.roles : [f.roles].filter(Boolean),
      }),
    },

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
        // A list of countries, not a box for a code. The stored value is
        // still the two-letter code — that is the standard and every reader
        // downstream expects it — but nobody has to know their own country's
        // code to fill the form in, and the picker cannot produce a
        // jurisdiction that does not exist.
        { name: 'countryCode', label: 'Country', type: 'select', options: COUNTRY,
          hint: 'Stored as its ISO 3166-1 alpha-2 code. Leave as it is for a multi-country portfolio.' },
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
        { name: 'countryCode', label: 'Country', type: 'select', options: COUNTRY, hint: 'Where the works are. Stored as its ISO 3166-1 alpha-2 code.' },
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
    person: {
      title: 'Add a person',
      intent:
        'Creates an identity in this tenancy and takes a seat against the subscription. There is no password — ' +
        'the email address is the credential, because sign-in is a one-time code sent to it.',
      path: '/v1/users',
      submitLabel: 'Add',
      fields: [
        { name: 'name', label: 'Name', hint: 'The person, not a role. This is who the record will name for everything they do.' },
        {
          name: 'email',
          label: 'Email address',
          hint: 'Where their sign-in code goes. An address nobody reads is an account nobody can use.',
        },
        {
          name: 'roles',
          label: 'Roles',
          type: 'multiselect',
          options: tenantGrantableRoles().map((role) => ({ value: role, label: humanise(role) })),
          hint:
            'What they may do. Offered from the list the platform publishes as grantable — the operator roles are ' +
            'not on it, and asking for one is refused by name rather than quietly dropped.',
        },
      ],
    },
  };

  // What an administrator may do to a person, from the row. Each one is a
  // recorded governance act with a reason, so each opens the same modal the
  // other commands use rather than a bare confirm(). Bound to the card, which
  // every render recreates — bound to `root`, which persists, each redraw
  // added another listener and one click opened two modals.
  root.querySelector('[data-people]')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-person-action]');
    if (!button) return;
    const userId = button.dataset.user;
    const name = button.dataset.name ?? 'this person';
    const action = button.dataset.personAction;
    const reasonField = (hint) => ({ name: 'reason', label: 'Reason', type: 'textarea', hint });

    try {
      if (action === 'deactivate') {
        const done = await command({
          title: `Deactivate ${name}`,
          intent:
            'Their seat is released and they can no longer sign in. Nothing is removed: every approval, ' +
            'signature and record still carries their name, and you can reactivate them at any time.',
          path: `/v1/users/${userId}/deactivate`,
          submitLabel: 'Deactivate',
          fields: [reasonField('Recorded against this decision — "left the company", "contract ended".')],
        });
        if (done) await draw();
      } else if (action === 'reactivate') {
        const done = await command({
          title: `Reactivate ${name}`,
          intent: 'Gives their access back and takes a seat again. Refused if every seat is taken.',
          path: `/v1/users/${userId}/reactivate`,
          submitLabel: 'Reactivate',
          fields: [reasonField('Why they are coming back.')],
        });
        if (done) await draw();
      } else if (action === 'delete') {
        const done = await command({
          title: `Delete ${name}`,
          intent:
            'Irreversible once carried out. Their name, email address and telephone number are removed from the ' +
            'platform after the grace period; the project record they took part in is kept, as the law requires, ' +
            'against an identity that no longer names anybody. The person is notified and the request can be ' +
            'cancelled until the date.',
          path: `/v1/users/${userId}/erasure`,
          submitLabel: 'Delete',
          fields: [reasonField('At least ten characters. Quote the written request or the decision this rests on.')],
        });
        if (done) {
          toast('Deletion scheduled', `${name} will be erased on ${date(done.dueAt)}.`, 'warn');
          await draw();
        }
      } else if (action === 'erase') {
        const done = await command({
          title: `Delete ${name} now`,
          intent:
            'No grace period. Their name, email address and telephone number are removed from the platform at once; ' +
            'the project record they took part in is kept, as the law requires, against an identity that no longer ' +
            'names anybody. This cannot be undone.',
          path: `/v1/users/${userId}/erase`,
          submitLabel: 'Delete now',
          fields: [reasonField('At least ten characters. Quote the written request or the decision this rests on.')],
        });
        if (done) {
          toast('Deleted', `${name} has been erased.`, 'warn');
          await draw();
        }
      } else if (action === 'cancel-erasure') {
        if (!confirm(`Keep ${name}? The scheduled deletion is cancelled and their access is restored.`)) return;
        await api.delete(`/v1/users/${userId}/erasure`);
        toast('Deletion cancelled', `${name} is restored.`, 'ok');
        await draw();
      }
    } catch (error) {
      toast('Could not do that', error.message, 'err');
    }
  });

  root.querySelector('.cmd-bar')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    const spec = COMMANDS[button.dataset.command];
    if (!spec) return;
    const result = await command(spec);
    if (!result) return;

    // A workspace with no project yet adopts the one just created. The
    // project-scoped screens all said "there is not one here yet — Enterprise &
    // Portfolio takes all three in order", the person did exactly that, and
    // every one of those screens went on saying it: the session's project was
    // chosen once at sign-in and nothing here ever set it. Signing out and back
    // in was the only way through, and nothing said so.
    if (button.dataset.command === 'project' && !state.session?.projectId && result.projectId) {
      await openProject(result.projectId);
      return;
    }
    // Whether the person was actually told. A deployment with no mail server
    // records the notice and sends nothing, and an administrator who believes
    // an email went out will wait for a reply that is never coming.
    if ((button.dataset.command === 'person' || button.dataset.command === 'invite') && result.notified) {
      if (result.notified === 'SENT') {
        toast('They have been emailed', `${result.email ?? 'The person'} has been told how to sign in.`, 'ok');
      } else {
        toast(
          'No email left the platform',
          `${result.email ?? 'The person'} was not emailed: this deployment has no mail server configured, so the ` +
            'message was recorded and not sent. Tell them to sign in at /app with their email address; the one-time ' +
            'code will reach them once mail is set up.',
          'warn',
        );
      }
    }
    await draw();
  });
  }
}
