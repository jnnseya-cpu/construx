import {
  state,
  allCapabilityAreas,
  closedAreas,
  permissionMatrix,
  phaseGates,
  rolesThatCanRead,
  tenantGrantableRoles,
} from '../app.js';
import { barChart, heatmap, pieChart } from '../lib/charts.js';
import { badge, html, humanise, raw, render, table } from '../lib/ui.js';

/**
 * What your role can do, what it cannot, and who to ask.
 *
 * This screen exists because of where the answer used to live: scattered
 * through the sidebar as a padlock beside every capability the viewer did not
 * hold. Measured across the twelve seeded identities, that was **five locks per
 * person on average and eight for the planner** — a third of their navigation
 * was grey furniture. A lock in a menu can say one thing, "not you", and it
 * says it on every screen, forever.
 *
 * Nothing has been taken away. The information has been moved somewhere it can
 * be complete, and it is much more here than it was there:
 *
 * - every one of the twenty-five capability areas, not only the ones that
 *   happen to have a navigation entry;
 * - the exact permission letters, so "read but not approve" is visible as such
 *   rather than collapsed into open-or-locked;
 * - **which colleague to ask**, computed from the roles a tenant administrator
 *   can actually grant, so it never names a role nobody in this organisation
 *   could ever hold;
 * - the lifecycle phases each area may be *written* in, which no padlock could
 *   ever have shown — a permission you hold and cannot use today because the
 *   project is in the wrong phase is a different refusal, and the commonest one
 *   people mistake for a bug.
 *
 * Every value on the page comes from `GET /v1/permissions/matrix`. The browser
 * holds no rule the API has not published, so this cannot drift from what the
 * platform actually enforces — it is the same object the shell asks before
 * offering any command.
 */

/** The letters, spelled out. A matrix of initials teaches nobody anything. */
const CODE_LABEL = {
  R: 'Read',
  C: 'Create',
  U: 'Update',
  A: 'Approve',
  G: 'Grant',
  I: 'Issue',
  X: 'Execute',
  D: 'Delete',
};

const CODE_TONE = { R: 'info', C: 'ok', U: 'ok', A: 'warn', G: 'bad', I: 'warn', X: 'warn', D: 'bad' };

/** Grouped the way the work is, not the way the enum is ordered. */
const GROUPS = [
  {
    title: 'Winning work',
    areas: ['BUSINESS_DEVELOPMENT', 'ESTIMATE_TENDER', 'BOQ_TAKEOFF', 'PROCUREMENT_AWARD', 'SUPPLIER_SUBMISSION'],
  },
  {
    title: 'Setting it up',
    areas: ['ENTERPRISE_STRUCTURE', 'PROJECT_SETUP', 'DESIGN_INFORMATION', 'BIM_TWIN'],
  },
  {
    title: 'Running it',
    areas: ['PROGRAMME_BASELINES', 'LOOKAHEAD_CONSTRAINTS', 'WORKPACKAGES_TASKS', 'FIELD_EXECUTION'],
  },
  {
    title: 'The money',
    areas: ['BUDGET_COST', 'PAYMENT_APPLICATIONS', 'CHANGE_VARIATION', 'CONTRACTS_CLAIMS', 'BILLING_ACU'],
  },
  {
    title: 'Assurance',
    areas: ['RISK_REGISTER', 'SAFETY_RAMS', 'QUALITY_COMMISSIONING', 'HANDOVER_OM', 'EVIDENCE_AUDIT'],
  },
  {
    title: 'The platform itself',
    areas: ['AI_EXECUTION', 'PLATFORM_ADMINISTRATION'],
  },
];

/** Plain names for the areas. The enum is a key, not a label. */
const AREA_LABEL = {
  PLATFORM_ADMINISTRATION: 'Platform administration',
  BUSINESS_DEVELOPMENT: 'Pipeline, opportunities and bid decisions',
  ENTERPRISE_STRUCTURE: 'Enterprise, portfolios, people and roles',
  PROJECT_SETUP: 'Project configuration and the brief',
  DESIGN_INFORMATION: 'Drawings, specifications and RFIs',
  WORKPACKAGES_TASKS: 'Work packages and tasks',
  PROGRAMME_BASELINES: 'Programme, baselines and the critical path',
  LOOKAHEAD_CONSTRAINTS: 'Lookahead planning and constraints',
  BOQ_TAKEOFF: 'Measurement and bills of quantities',
  ESTIMATE_TENDER: 'Estimates and tender submissions',
  PROCUREMENT_AWARD: 'Enquiries, comparison and award',
  SUPPLIER_SUBMISSION: 'What a supplier submits',
  BUDGET_COST: 'Budget, commitments and cost value',
  PAYMENT_APPLICATIONS: 'Applications, certificates and payment',
  CHANGE_VARIATION: 'Change control and variations',
  CONTRACTS_CLAIMS: 'Contracts, claims and disputes',
  RISK_REGISTER: 'Risk register',
  SAFETY_RAMS: 'Permits, method statements and safety',
  FIELD_EXECUTION: 'Site records, diaries and progress',
  QUALITY_COMMISSIONING: 'Inspection, test plans and commissioning',
  BIM_TWIN: 'Models, clashes and the asset twin',
  HANDOVER_OM: 'Handover and thirty-year operations',
  EVIDENCE_AUDIT: 'Evidence, the Golden Thread and export',
  AI_EXECUTION: 'Running the AI engines',
  BILLING_ACU: 'Subscription, wallet and AI spend',
};

/**
 * Name a colleague, not a directory.
 *
 * Eighteen roles are grantable and the commercial areas are readable by nine of
 * them, so the honest full list was nine names in a table cell — which answers
 * "who has this" and not the question somebody is actually asking, which is
 * "who do I go to". Three, then a count.
 *
 * Ordered by seniority rather than by matrix order, so the first name offered is
 * somebody who can usually authorise the change rather than whoever happens to
 * sit first in the enum.
 */
const ASK_FIRST = ['PM', 'PROJECT_DIRECTOR', 'COMMERCIAL_MANAGER', 'ENTERPRISE_ADMIN', 'QS', 'OWNER'];

function whoToAsk(roles) {
  const ordered = [...roles].sort((a, b) => {
    const ai = ASK_FIRST.indexOf(a);
    const bi = ASK_FIRST.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  const named = ordered.slice(0, 3).map((r) => humanise(r)).join(', ');
  return ordered.length > 3 ? `${named} — or ${ordered.length - 3} others` : named;
}

export async function permissions(root) {
  const matrix = permissionMatrix();
  const gates = phaseGates();
  const roles = state.session?.user?.roles ?? [];

  if (!matrix) {
    render(
      root,
      html`<div class="view-head"><div><h1>What your role can do</h1></div></div>
        <div class="notice">The permission matrix has not loaded. Reload the page.</div>`,
    );
    return;
  }

  /** Every code this identity holds on an area, across all of its roles. */
  const held = (area) => {
    const codes = new Set();
    for (const role of roles) for (const code of matrix[role]?.[area] ?? []) codes.add(code);
    return [...codes];
  };

  // The areas come from the matrix, and the grouping below is presentation
  // only. An area the server adds and this file has not been told about would
  // otherwise vanish from a page whose whole claim is completeness, so anything
  // ungrouped is collected rather than dropped.
  const grouped = new Set(GROUPS.flatMap((g) => g.areas));
  const allAreas = allCapabilityAreas();
  const ungrouped = allAreas.filter((area) => !grouped.has(area));
  const groups = ungrouped.length > 0 ? [...GROUPS, { title: 'Everything else', areas: ungrouped }] : GROUPS;

  const readable = allAreas.filter((area) => held(area).includes('R'));
  const closed = closedAreas();
  // Closed to this identity *and* to every role a tenant administrator could
  // grant. There is no colleague to ask and no promotion that would open it, so
  // it is reported as a different fact rather than as a longer wait.
  const closedToEveryone = closed.filter((area) => rolesThatCanRead(area).length === 0);

  const phaseLine = (area) => {
    const allowed = gates[area];
    if (!allowed) return html`<span class="metric-sub">any phase</span>`;
    return html`<span class="metric-sub">${allowed.map((p) => humanise(p)).join(', ')}</span>`;
  };

  const areaRow = (area) => {
    const codes = held(area);
    const canRead = codes.includes('R');
    const others = canRead ? [] : rolesThatCanRead(area);
    return [
      html`<b>${AREA_LABEL[area] ?? humanise(area)}</b><div class="metric-sub mono" style="font-size:10.5px">${area}</div>`,
      codes.length > 0
        ? html`${codes.map((code) => badge(CODE_LABEL[code] ?? code, CODE_TONE[code] ?? 'neutral'))}`
        : html`<span class="metric-sub">nothing</span>`,
      canRead ? phaseLine(area) : html`<span class="metric-sub">—</span>`,
      canRead
        ? html`<span class="metric-sub">yours</span>`
        : others.length > 0
          ? html`<span class="metric-sub">ask ${whoToAsk(others)}</span>`
          : html`<span class="metric-sub">nobody here — it is not a role this tenancy can grant</span>`,
    ];
  };

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>What your role can do</h1>
          <p>
            You are signed in as <b>${roles.map((r) => humanise(r)).join(', ')}</b>. Everything below is the platform's
            own enforcement, published by the API and not restated here — the same answer the console asks before it
            offers you any command.
          </p>
        </div>
      </div>

      <section class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h2>Areas you can open</h2>
          <div class="metric good">${readable.length}</div>
          <div class="metric-sub">of ${allAreas.length} the platform enforces</div>
        </div>
        <div class="card">
          <h2>Closed to you</h2>
          <div class="metric">${closed.length}</div>
          <div class="metric-sub">
            ${closed.length - closedToEveryone.length} a colleague holds and could be granted to you
          </div>
        </div>
        <div class="card">
          <h2>Not this tenancy's to grant</h2>
          <div class="metric">${closedToEveryone.length}</div>
          <div class="metric-sub">a different account layer, not a senior role — nobody here can open it</div>
        </div>
        <div class="card">
          <h2>Roles that exist</h2>
          <div class="metric">${tenantGrantableRoles().length}</div>
          <div class="metric-sub">an administrator can grant any of them</div>
        </div>
      </section>

      ${permissionCharts(matrix, allAreas, roles, held, readable, closed, closedToEveryone, gates)}

      <div class="notice" style="margin-bottom:14px">
        <div>
          <b>A permission is only half of a refusal.</b><br />
          Reads are decided by role alone. <b>Writes are also gated by the lifecycle phase</b> — holding "Create" on
          measurement does not let you write one while the project is in operations, and that refusal is the one most
          often mistaken for a fault. The phase column below is why, and it is the platform's own gate rather than a
          copy of it.
        </div>
      </div>

      ${groups.map(
        (group) => html`<div class="card pad0" style="margin-bottom:14px">
          <h2 style="padding:15px 17px 0">
            ${group.title}
            ${badge(
              `${group.areas.filter((a) => held(a).includes('R')).length} of ${group.areas.length} open`,
              group.areas.every((a) => held(a).includes('R')) ? 'ok' : 'neutral',
            )}
          </h2>
          ${table({
            headers: ['Capability area', 'What you hold', 'Writable in', 'If it is closed'],
            rows: group.areas.map(areaRow),
          })}
        </div>`,
      )}

      <div class="card">
        <h2>Why this is a page and not a padlock</h2>
        <p class="metric-sub" style="margin-top:6px">
          The navigation used to carry a padlock beside every capability you do not hold. Across the twelve
          demonstration identities that came to five per person and eight for the planner — a third of the menu was
          furniture that said "not you" and nothing else. It could not say which permission letters you were short, it
          could not name a colleague, it could not mention the phase gate at all, and it could not show you the areas
          that have no menu entry. All four are here. The menu now shows what you can do.
        </p>
      </div>
    `,
  );
}

/**
 * The permission matrix, as a matrix.
 *
 * It is a grid by construction — roles down one side, capability areas across
 * the other — and it has only ever been rendered as prose and a list of letters.
 * Drawn, three things are visible that the list cannot show:
 *
 * - **which role is nearest to what you are missing.** A bright cell in a column
 *   where yours is empty is the colleague to ask, and it is one glance rather
 *   than a walk through twenty-five areas.
 * - **which areas nobody in this tenancy holds.** An entirely dark column is
 *   not a senior role you have not thought of; it is a different account layer,
 *   and no promotion opens it.
 * - **where authority concentrates.** A role holding every letter across most
 *   of the grid is the one worth a second factor.
 *
 * Every figure is the matrix the API published. This screen restates nothing
 * and computes no rule of its own — which is the whole reason it can be
 * trusted as an answer to "why was I refused".
 */
function permissionCharts(matrix, allAreas, roles, held, readable, closed, closedToEveryone, gates) {
  const grantable = tenantGrantableRoles();
  if (grantable.length === 0 || allAreas.length === 0) return '';

  // Areas across, roles down. The cell is how many of the seven permission
  // codes that role holds there, which is the closest thing to "how much
  // authority" the matrix carries.
  const rows = grantable.map((role) => humanise(role));
  const values = grantable.map((role) => allAreas.map((area) => (matrix[role]?.[area] ?? []).length));

  const standing = [
    { label: 'Open to you', value: readable.length, tone: 'ok' },
    { label: 'A colleague holds it', value: closed.length - closedToEveryone.length, tone: 'warn' },
    { label: 'Nobody here can open it', value: closedToEveryone.length, tone: 'bad' },
  ].filter((slice) => slice.value > 0);

  // How much of the grid each role carries, so concentration is visible.
  const reach = grantable
    .map((role) => ({
      label: humanise(role),
      value: allAreas.filter((area) => (matrix[role]?.[area] ?? []).length > 0).length,
      tone: roles.includes(role) ? 'ok' : undefined,
    }))
    .sort((a, b) => b.value - a.value);

  const gated = allAreas.filter((area) => gates?.[area]).length;

  return html`
    <div class="card" style="margin-bottom:14px">
      <h2>Who holds what, across the whole platform</h2>
      ${raw(
        heatmap({
          title: 'Permission codes held, by role and capability area',
          rows,
          columns: allAreas.map((area) => humanise(area)),
          values,
          format: (value) => (value === 0 ? 'nothing' : `${value} of 7 codes`),
          empty: 'The permission matrix has not loaded.',
          footnote:
            'A bright cell in a column where your own row is empty is the colleague to ask. An entirely dark column is a ' +
            'different account layer — no role this organisation can grant opens it.',
        }),
      )}
    </div>

    <div class="grid g2" style="margin-bottom:14px">
      <div class="card">
        <h2>Where you stand</h2>
        ${raw(
          pieChart({
            title: 'Capability areas by what they are to you',
            data: standing,
            centreLabel: String(allAreas.length),
            format: (value) => `${value} area${value === 1 ? '' : 's'}`,
            empty: 'No capability area is published.',
            footnote:
              `${gated} area${gated === 1 ? '' : 's'} also depend on the project’s phase. Holding the permission and being ` +
              'in the wrong phase is a refusal too, and it is the half people do not expect.',
          }),
        )}
      </div>
      <div class="card">
        <h2>How far each role reaches</h2>
        ${raw(
          barChart({
            title: 'Capability areas a role touches at all',
            horizontal: true,
            data: reach,
            format: (value) => `${value} of ${allAreas.length} areas`,
            empty: 'No role is grantable in this organisation.',
            footnote:
              'Yours is marked. Reach is breadth, not depth — a role touching every area with one letter each holds far ' +
              'less than the grid above makes it look.',
          }),
        )}
      </div>
    </div>
  `;
}
