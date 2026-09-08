import { api, session } from '../lib/api.js';
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

/** How a member relates to this organisation, as the members table words it. */
const RELATIONSHIP_LABEL = { HOME_MEMBER: 'Internal', GROUP_MEMBER: 'Group', EXTERNAL_INVITEE: 'External' };

/** The seat badge's tone: a licence required or lapsed is the thing to act on. */
const BADGE_TONE = {
  PARTICIPANT_NO_SEAT: 'neutral',
  CONTROLLER_HOST_SEAT: 'ai',
  CONTROLLER_HOME_LICENSED: 'ok',
  CONTROLLER_GROUP_LICENSED: 'ok',
  CONTROLLER_HOST_SPONSORED: 'warn',
  CONTROLLER_LICENCE_REQUIRED: 'bad',
  CONTROLLER_LICENCE_EXPIRED: 'bad',
};

/**
 * The acts on one member, by what the record says is open to do. A Controller
 * with no licence gets the two decisions the rule allows the host — buy a pass
 * or reduce the roles — and never a third that would add the person to the
 * paid seats unasked.
 */
function memberActions(member) {
  const act = (action, label, tone = 'quiet') =>
    html`<button class="btn ${tone} sm" data-member-action="${action}" data-membership="${member.membershipId}" data-name="${member.name}" data-pass="${member.passId ?? ''}">${label}</button>`;
  if (member.status === 'REVOKED' || member.status === 'EXPIRED') return '';
  const external = member.relationship !== 'HOME_MEMBER';
  const parts = [];
  if (member.badge === 'CONTROLLER_LICENCE_REQUIRED' || member.badge === 'CONTROLLER_LICENCE_EXPIRED') {
    parts.push(act('pass', 'Sponsor a pass'), act('reduce', 'Reduce to participant'));
  }
  if (member.status === 'ACTIVE' || member.status === 'PENDING') parts.push(act('roles', 'Roles'));
  if (external && (member.status === 'ACTIVE' || member.status === 'PENDING')) parts.push(act('sponsor', 'AI sponsor'));
  if (member.passId && member.licenceSource === 'HOST_SPONSORED_PASS') parts.push(act('revoke-pass', 'End the pass'));
  if (member.status === 'ACTIVE') parts.push(act('suspend', 'Suspend'));
  if (member.status === 'SUSPENDED') parts.push(act('restore', 'Restore'));
  if (member.status !== 'PENDING') parts.push(act('revoke', 'Revoke', 'quiet danger'));
  return html`${parts}`;
}

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
    <div class="view-head">
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

  const [position, portfolios, enterprises, gates, ownership, changes, forecast, people, invitations, register, members, sponsorships] = await Promise.all([
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
    // The supply-chain register, so an external supplier can be invited as a
    // named firm's person rather than a stranger with a supplier role. Null
    // where the reader may not see the register; the invitation still works.
    api.get('/v1/supply-chain?all=true').catch(() => null),
    // Everybody appointed to this project, with whose licence covers them and
    // who pays for their AI — the members table the commercial rule is read
    // from. Null where the reader may not see it.
    api.get(`/v1/projects/${state.session.projectId}/members`).catch(() => null),
    // Who this organisation has asked to pay for a guest's AI, and what it
    // has agreed to pay itself.
    api.get('/v1/acu-sponsorships').catch(() => null),
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
              // Open even when the package's Controller seats are all taken:
              // a participant, or a Controller licensed elsewhere, takes none,
              // and the platform refuses the one kind that does.
              permitted: can('PROJECT_SETUP', 'R'),
              reason: blockedReason('PROJECT_SETUP', 'R'),
            },
            {
              id: 'check',
              label: 'Check a licence',
              tone: '',
              permitted: can('PROJECT_SETUP', 'R'),
              reason: blockedReason('PROJECT_SETUP', 'R'),
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
          headers: ['Portfolio', 'Governance', 'Region', 'Budget target', 'Cadence', 'Risk appetite', ''],
          align: ['', '', '', 'num', '', '', 'num'],
          rows: portfolios.portfolios.map((p) => [
            p.name,
            p.governanceModel,
            html`<b>${regionLabel(p.continentCode)}</b><div class="metric-sub">${
              p.countryCode ? `${p.city ? `${p.city}, ` : ''}${p.countryCode} only` : `${p.city ?? 'multi-country'}`
            }</div>`,
            p.targets?.budgetMinor ? money(p.targets.budgetMinor) : '—',
            humanise(p.reportingCadence ?? ''),
            p.riskAppetite ? `${p.riskAppetite.costTolerancePercent}% cost · ${p.riskAppetite.scheduleToleranceDays}d schedule` : '—',
            // A portfolio goes when nothing live is filed under it; the platform
            // refuses otherwise and names the projects. The record is kept.
            can('ENTERPRISE_STRUCTURE', 'A')
              ? html`<button class="btn quiet danger" data-delete-portfolio="${p.id}" data-name="${p.name}">Delete</button>`
              : '',
          ]),
          empty: 'No portfolios',
        })}
      </div>

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">Project control</h2>
        ${table({
          headers: ['Project', 'Sector', 'Phase', 'Progress', 'Cost', 'Schedule', 'Risk', 'Open', 'Value', ''],
          align: ['', '', '', 'num', '', '', 'num', 'num', 'num', 'num'],
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
            // The record is kept; the project leaves the estate and takes no
            // further command. The platform refuses where money is certified or
            // a contract is executed, and says which.
            can('PROJECT_SETUP', 'A')
              ? html`<button class="btn quiet danger" data-delete-project="${p.projectId}" data-name="${p.name}">Delete</button>`
              : '',
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

      <div class="card pad0" style="margin-bottom:14px" data-members>
        <h2 style="padding:15px 17px 0">
          Project members
          ${
            invitations?.seats
              ? badge(
                  invitations.seats.remaining === null
                    ? 'unlimited Controller seats'
                    : `${invitations.seats.remaining} Controller seat${invitations.seats.remaining === 1 ? '' : 's'} left`,
                  invitations.seats.remaining === 0 ? 'bad' : invitations.seats.remaining === null ? 'neutral' : 'ok',
                )
              : ''
          }
        </h2>
        <div class="metric-sub" style="padding:0 17px 10px">
          Anybody working on this project may bring somebody onto it — the designer, the temporary works engineer, the
          client's representative, a subcontractor's own QS. One person, one home organisation, one Controller seat:
          a participant takes no seat; a Controller from another organisation, or from a company of the same group,
          brings their own licence with them; only this organisation's own Controller takes one of the package's seats,
          held from the moment the invitation is sent. Nobody is added to this organisation's paid seats by being invited.
        </div>
        ${table({
          headers: administers() || can('PROJECT_SETUP', 'R')
            ? ['Person', 'Organisation', 'Relationship', 'Roles', 'Licence', 'Seat owner', 'Host billable', 'ACU sponsor', 'Expiry', 'Status', '']
            : ['Person', 'Organisation', 'Relationship', 'Roles', 'Licence', 'Seat owner', 'Host billable', 'ACU sponsor', 'Expiry', 'Status'],
          rows: (members?.members ?? []).map((member) => [
            html`<div><b>${member.name}</b></div><div class="metric-sub">${member.email}</div>`,
            member.organisation || '—',
            badge(RELATIONSHIP_LABEL[member.relationship] ?? humanise(member.relationship), member.relationship === 'HOME_MEMBER' ? 'neutral' : 'warn'),
            html`${(member.activeRoles ?? []).map((role) => badge(humanise(role), 'neutral'))}${(member.withheldRoles ?? []).map((role) => badge(`${humanise(role)} — withheld`, 'bad'))}`,
            badge(member.badgeLabel ?? humanise(member.badge), BADGE_TONE[member.badge] ?? 'neutral'),
            member.seatOwner ?? html`<span class="metric-sub">none</span>`,
            member.hostBillable ? badge('yes', 'warn') : badge('no', 'ok'),
            member.acuSponsor === 'NONE' ? html`<span class="metric-sub">not sponsored</span>` : html`${member.acuSponsorName ?? humanise(member.acuSponsor)}`,
            member.expiresAt ? date(member.expiresAt) : html`<span class="metric-sub">until revoked</span>`,
            badge(member.status.toLowerCase(), member.status === 'ACTIVE' ? 'ok' : member.status === 'PENDING' ? 'warn' : member.status === 'SUSPENDED' ? 'bad' : 'neutral'),
            ...(administers() || can('PROJECT_SETUP', 'R') ? [memberActions(member)] : []),
          ]),
          empty: 'Nobody has been appointed to this project yet. Invite somebody above.',
        })}
        ${
          invitations?.seats && invitations.seats.remaining !== null
            ? html`<div class="metric-sub" style="padding:10px 17px 15px">
                ${invitations.seats.assigned} Controller seat${invitations.seats.assigned === 1 ? '' : 's'} assigned and
                ${invitations.seats.heldByInvitations} held by outstanding invitations to this organisation's own Controllers, against
                ${invitations.seats.includedSeats} in this package. A Project Controller Pass for a guest is
                ${money(invitations.passPriceMinor ?? 0, currency)} a month and is charged separately.
              </div>`
            : ''
        }
        ${
          (sponsorships?.asHost ?? []).length
            ? html`<div style="padding:0 17px 15px">
                <div class="metric-sub" style="margin-bottom:6px"><b>Sponsorships asked of other organisations</b></div>
                ${table({
                  headers: ['Person', 'Asked of', 'What', 'Standing', 'Asked'],
                  rows: sponsorships.asHost.map((s) => [
                    s.person.name,
                    s.sponsorName,
                    `${humanise(s.authorisationType)}${s.workflow ? ` · ${s.workflow}` : ''}`,
                    badge(s.standing.toLowerCase(), s.standing === 'AVAILABLE' ? 'ok' : s.standing === 'PENDING' ? 'warn' : 'neutral'),
                    date(s.requestedAt),
                  ]),
                })}
              </div>`
            : ''
        }
      </div>

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">Invitations</h2>
        ${table({
          headers: ['Name', 'Email', 'With', 'Roles', 'Licence', 'Invited by', 'Expires', 'Status'],
          rows: (invitations?.invitations ?? []).map((invite) => [
            invite.name,
            invite.email,
            invite.external
              ? html`${invite.organisation ?? '—'}${badge('external', 'warn')}`
              : html`<span class="metric-sub">this organisation</span>`,
            html`${(invite.roles ?? []).map((role) => badge(humanise(role), 'neutral'))}`,
            invite.badge ? badge(invite.badgeLabel ?? humanise(invite.badge), BADGE_TONE[invite.badge] ?? 'neutral') : '—',
            (people.users ?? []).find((u) => u.id === invite.invitedBy)?.name ?? invite.invitedBy,
            date(invite.expiresAt),
            badge(humanise(invite.status), statusTone(invite.status)),
          ]),
          empty: 'Nobody has been invited to this project yet.',
        })}
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
    check: {
      title: 'Check the licence before inviting',
      intent:
        'Whether these roles on this person need a Controller licence, whether one is already held by their own organisation ' +
        'or their group, and whether this organisation would pay anything. Says "verified" or "required" and nothing about ' +
        'the other organisation\u2019s subscription.',
      path: '/v1/controller-licences/resolve',
      submitLabel: 'Check',
      fields: [
        { name: 'email', label: 'Work email' },
        {
          name: 'external',
          label: 'Which organisation',
          type: 'select',
          options: [
            { value: 'false', label: 'Ours — they work here' },
            { value: 'true', label: 'External — another company, or a company of our group' },
          ],
        },
        { name: 'organisation', label: 'Their organisation', required: false },
        {
          name: 'roles',
          label: 'Roles to check',
          type: 'select',
          multiple: true,
          options: tenantGrantableRoles().map((role) => ({ value: role, label: humanise(role) })),
        },
      ],
      transform: (f) => ({
        ...f,
        projectId: state.session.projectId,
        external: String(f.external) === 'true',
        roles: Array.isArray(f.roles) ? f.roles : [f.roles].filter(Boolean),
        ...(f.organisation ? {} : { organisation: undefined }),
      }),
    },
    invite: {
      title: 'Invite somebody onto this project',
      intent:
        'A participant takes no seat. A Controller from another organisation brings their own licence, or is admitted as a ' +
        'participant until you buy a Project Controller Pass or reduce the roles. Only one of our own Controllers takes one ' +
        'of this package\u2019s seats, held from now rather than from when they accept. Nothing is charged to anybody by inviting.',
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
            { value: 'true', label: 'External — another company, or a company of our group' },
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
          hint: 'Controller roles — approving money, baselines and contracts, administering people — need a licence. Participant roles do not.',
        },
        {
          name: 'expiresAt',
          label: 'Appointment ends',
          type: 'datetime-local',
          required: false,
          hint: 'When their access to this project ends on its own. Left empty, it runs until revoked.',
        },
        {
          name: 'because',
          label: 'Why they are being added',
          type: 'textarea',
          rows: 3,
          hint: 'A sentence somebody reviewing the project team in six months will understand.',
        },
        {
          name: 'supplierId',
          label: 'Their firm on the supply-chain register',
          type: 'select',
          required: false,
          placeholder: 'Not a supplier’s person',
          options: (register?.suppliers ?? []).map((firm) => ({ value: firm.id, label: firm.legalName })),
          hint:
            'For an external supplier only. Links the sign-in to the firm, which is what lets them open their own portal and nobody else’s.',
        },
      ],
      // `external` arrives from a select as a string, and `Boolean('false')` is
      // true — the classic way a safety flag inverts itself in transit.
      transform: (f) => ({
        ...f,
        external: String(f.external) === 'true',
        roles: Array.isArray(f.roles) ? f.roles : [f.roles].filter(Boolean),
        ...(f.supplierId ? {} : { supplierId: undefined }),
        ...(f.expiresAt ? { expiresAt: new Date(f.expiresAt).toISOString() } : { expiresAt: undefined }),
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

  // Deleting a portfolio or a project. Each takes a reason the record keeps;
  // the platform decides whether it may go and says why not otherwise — a
  // portfolio still holding projects, a project with certified money or an
  // executed contract — and the refusal is shown as a refusal.
  root.querySelectorAll('[data-delete-portfolio]').forEach((button) =>
    button.addEventListener('click', async () => {
      const portfolioId = button.getAttribute('data-delete-portfolio');
      const result = await command({
        title: `Delete ${button.getAttribute('data-name')}`,
        intent:
          'The portfolio leaves the estate and its record is kept. It cannot go while a project is still filed under it — delete or move those first.',
        path: `/v1/portfolios/${portfolioId}/delete`,
        submitLabel: 'Delete the portfolio',
        fields: [{ name: 'reason', label: 'Why', type: 'textarea', hint: 'At least ten characters. This is the sentence the record keeps.' }],
      });
      if (result) await draw();
    }),
  );
  root.querySelectorAll('[data-delete-project]').forEach((button) =>
    button.addEventListener('click', async () => {
      const projectId = button.getAttribute('data-delete-project');
      const result = await command({
        title: `Delete ${button.getAttribute('data-name')}`,
        intent:
          'The project leaves the estate, every screen and the picker, and takes no further command. Its record is kept and stays readable by its id. Refused where money has been certified or a contract is executed.',
        path: `/v1/projects/${projectId}/delete`,
        submitLabel: 'Delete the project',
        fields: [{ name: 'reason', label: 'Why', type: 'textarea', hint: 'At least ten characters. This is the sentence the record keeps.' }],
      });
      if (!result) return;
      // The workspace was on the project just deleted: move to another, or to
      // none, rather than leaving a deleted project as the workspace.
      if (state.session?.projectId === projectId) {
        const listed = await api.get('/v1/projects').catch(() => ({ projects: [] }));
        const next = (listed.projects ?? []).find((project) => (project.id ?? project.projectId) !== projectId);
        if (next) {
          await openProject(next.id ?? next.projectId);
          return;
        }
        session.set({ ...session.get(), projectId: null });
        state.session = session.get();
        state.project = null;
        state.gate = null;
      }
      await draw();
    }),
  );

  // What may be done about one member: the licence decisions, the roles, the
  // AI sponsor, and the lifecycle. Each is a command the platform decides on;
  // the console only says what it is about to ask.
  root.querySelector('[data-members]')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-member-action]');
    if (!button) return;
    const membershipId = button.dataset.membership;
    const name = button.dataset.name ?? 'this person';
    const action = button.dataset.memberAction;
    const reason = (hint) => ({ name: 'reason', label: 'Reason', type: 'textarea', hint });
    const passPrice = money(invitations?.passPriceMinor ?? members?.passPriceMinor ?? 0, currency);
    try {
      let done = null;
      if (action === 'pass') {
        done = await command({
          title: `Sponsor a Project Controller Pass for ${name}`,
          intent:
            `These roles need a Controller licence and ${name} holds none. This does not add them to your paid seats: a pass is ` +
            `${passPrice} a month on this organisation’s invoice, opens this project only, and ends with the appointment. ` +
            'The other options are to reduce the roles, or to ask their organisation to license them.',
          path: '/v1/controller-passes/purchase',
          submitLabel: `Buy the pass — ${passPrice} a month`,
          fields: [
            { name: 'expiresAt', label: 'Pass ends', type: 'datetime-local', hint: 'No later than the appointment’s end; at most twelve months.' },
            reason('At least ten characters; this is the sentence the invoice carries.'),
          ],
          transform: (f) => ({ membershipId, expiresAt: new Date(f.expiresAt).toISOString(), reason: f.reason }),
        });
      } else if (action === 'reduce') {
        done = await command({
          title: `Reduce ${name} to a participant`,
          intent: 'The Controller roles are withdrawn and the participant roles kept — or a viewer, where there were none. Nothing is charged and nothing further will be.',
          path: `/v1/project-memberships/${membershipId}/permissions`,
          submitLabel: 'Reduce',
          fields: [
            {
              name: 'roles',
              label: 'Participant roles to keep',
              type: 'select',
              multiple: true,
              options: tenantGrantableRoles().map((role) => ({ value: role, label: humanise(role) })),
            },
            reason('At least ten characters.'),
          ],
          transform: (f) => ({ roles: Array.isArray(f.roles) ? f.roles : [f.roles].filter(Boolean), reason: f.reason }),
        });
      } else if (action === 'roles') {
        done = await command({
          title: `Change what ${name} may do on this project`,
          intent:
            'Controller roles need a licence. These permissions will not add the person automatically to your paid seats: an ' +
            'existing home or group licence is reused, or the roles are withheld until you buy a Project Controller Pass or reduce them.',
          path: `/v1/project-memberships/${membershipId}/permissions`,
          submitLabel: 'Change roles',
          fields: [
            {
              name: 'roles',
              label: 'Roles',
              type: 'select',
              multiple: true,
              options: tenantGrantableRoles().map((role) => ({ value: role, label: humanise(role) })),
            },
            reason('At least ten characters.'),
          ],
          transform: (f) => ({ roles: Array.isArray(f.roles) ? f.roles : [f.roles].filter(Boolean), reason: f.reason }),
        });
      } else if (action === 'sponsor') {
        done = await command({
          title: `Who pays for ${name}’s AI on this project`,
          intent:
            'Ask their own organisation to sponsor it — nothing is funded until one of its administrators approves, with a limit — or ' +
            'sponsor it from this organisation’s wallet, which needs authority over the money here. A one-time authorisation names one engine.',
          path: '/v1/acu-sponsorships',
          submitLabel: 'Raise the sponsorship',
          fields: [
            {
              name: 'sponsorType',
              label: 'Who pays',
              type: 'select',
              options: [
                { value: 'HOME_ORGANISATION', label: 'Their organisation — ask them to approve' },
                { value: 'HOST_ORGANISATION', label: 'This organisation — from our wallet' },
              ],
            },
            {
              name: 'authorisationType',
              label: 'What is authorised',
              type: 'select',
              options: [
                { value: 'MONTHLY_ALLOWANCE', label: 'A monthly allowance' },
                { value: 'PROJECT_ALLOWANCE', label: 'An allowance for the whole appointment' },
                { value: 'ONE_TIME_EXECUTION', label: 'One named engine, up to a maximum' },
              ],
            },
            { name: 'maximumMinor', label: 'Maximum ACUs', type: 'number', step: '1', hint: 'One ACU is one minor unit.' },
            { name: 'workflow', label: 'Engine (one-time only)', required: false, hint: 'The engine name a one-time authorisation covers, e.g. ESTIMATE_TENDER.' },
            { name: 'expiresAt', label: 'Until', type: 'datetime-local', required: false },
            reason('What the AI is for, in a sentence the sponsor can approve.'),
          ],
          transform: (f) => ({
            membershipId,
            sponsorType: f.sponsorType,
            authorisationType: f.authorisationType,
            maximumMinor: Number(f.maximumMinor),
            reason: f.reason,
            ...(f.workflow ? { workflow: f.workflow } : {}),
            ...(f.expiresAt ? { expiresAt: new Date(f.expiresAt).toISOString() } : {}),
          }),
        });
        if (done?.notified === 'NO_ADMINISTRATOR') toast('Nobody to ask', 'That organisation has no administrator to approve the request.', 'warn');
        else if (done?.sponsorship?.status === 'PENDING') toast('Sponsorship requested', `${done.sponsorship.person.name}’s organisation has been asked to approve it.`, 'ok');
      } else if (action === 'revoke-pass') {
        done = await command({
          title: `End the Project Controller Pass for ${name}`,
          intent: 'The charge stops and the Controller roles it covered are withheld. The person stays a participant.',
          path: `/v1/controller-passes/${button.dataset.pass}/revoke`,
          submitLabel: 'End the pass',
          fields: [reason('At least five characters.')],
        });
      } else if (action === 'suspend') {
        done = await command({
          title: `Suspend ${name}’s access`,
          intent: 'Refused at once and kept to restore. A pass, where there is one, keeps running until restored or ended.',
          path: `/v1/project-memberships/${membershipId}/suspend`,
          submitLabel: 'Suspend',
          fields: [reason('At least five characters.')],
        });
      } else if (action === 'restore') {
        done = await command({
          title: `Restore ${name}’s access`,
          intent: 'On the same licence and the same sponsor.',
          path: `/v1/project-memberships/${membershipId}/restore`,
          submitLabel: 'Restore',
          fields: [reason('At least five characters.')],
        });
      } else if (action === 'revoke') {
        done = await command({
          title: `Revoke ${name}’s access to this project`,
          intent:
            'Access ends now, open AI holds are released, any pass stops, and the identity is deactivated if this was its last project. ' +
            'Everything they recorded stays on the chain under their name.',
          path: `/v1/project-memberships/${membershipId}/revoke`,
          submitLabel: 'Revoke',
          fields: [reason('At least five characters.')],
        });
      }
      if (done) await draw();
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

    // The licence check answers on the spot rather than changing anything:
    // verified or required, whose seat, and whether this organisation pays.
    if (button.dataset.command === 'check') {
      toast(
        result.verdict,
        `${humanise(result.accessClass)} · ${RELATIONSHIP_LABEL[result.relationship] ?? result.relationship}${result.homeOrganisation ? ` · ${result.homeOrganisation}` : ''} · ` +
          `${result.hostBillableSeat ? 'this organisation would pay' : 'nothing charged here'}${result.controllerRoles?.length ? ` · Controller roles: ${result.controllerRoles.map(humanise).join(', ')}` : ''}`,
        result.badge === 'CONTROLLER_LICENCE_REQUIRED' ? 'warn' : 'ok',
      );
      return;
    }
    if (button.dataset.command === 'invite' && result.licence?.withheldRoles?.length) {
      toast(
        'Controller licence required',
        `${result.licence.withheldRoles.map(humanise).join(', ')} withheld until a licence is chosen. They are admitted as a participant; ` +
          'nothing has been added to your paid seats. Sponsor a pass or reduce the roles from the members table.',
        'warn',
      );
    }

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
