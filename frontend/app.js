import { api, ApiError, resetWithheld, session, withheldRecords } from './lib/api.js';
import { esc, html, humanise, initials, money, raw, render, toast } from './lib/ui.js';
import { wireDrill } from './lib/drill.js';
import { armInstallPrompt } from './lib/install.js';
import * as outbox from './lib/outbox.js';
import { PAGES } from './pages/index.js';

/**
 * Application shell: routing, session, and the role-aware navigation that makes
 * the permission model visible. A route the current role cannot reach is shown
 * locked with the reason, rather than hidden — people need to know a capability
 * exists and who to ask, not wonder whether the product has it.
 */

const root = document.getElementById('root');

export const state = {
  session: null,     // { accessToken, user, projectId, enterprise, portfolio }
  project: null,     // materialised project state
  gate: null,        // current phase gate evaluation
  wallet: null,      // ACU snapshot
};

// --- navigation model -------------------------------------------------------

/**
 * Each entry declares the capability area it reads. The sidebar checks that
 * against the live permission matrix, so navigation and enforcement can never
 * drift apart.
 */
export const NAV = [
  {
    group: 'Command',
    items: [
      { id: 'overview', label: 'Project Command Centre', area: 'PROJECT_SETUP', icon: 'grid' },
      { id: 'copilot', label: 'Copilot', area: 'PROJECT_SETUP', icon: 'chat' },
      { id: 'autopilot', label: 'Autopilot', area: 'AI_EXECUTION', icon: 'radar' },
      { id: 'enterprise', label: 'Enterprise & Portfolio', area: 'PROJECT_SETUP', icon: 'layers' },
    ],
  },
  {
    group: 'Deliver',
    items: [
      { id: 'programme', label: 'Programme', area: 'PROGRAMME_BASELINES', icon: 'chart' },
      { id: 'field', label: 'Field Execution', area: 'FIELD_EXECUTION', icon: 'clipboard' },
      // The five registers a site runs on: permits, method statements,
      // inductions, inspection plans and non-conformances. Under SAFETY_RAMS
      // read because that is the area the permit and the method statement live
      // in and the one a site manager is judged on; the quality half of the
      // screen authorises itself separately, panel by panel.
      { id: 'construction', label: 'Construction', area: 'SAFETY_RAMS', icon: 'shield' },
      { id: 'design', label: 'Design & BIM', area: 'BIM_TWIN', icon: 'cube' },
    ],
  },
  {
    group: 'Commercial',
    items: [
      { id: 'pipeline', label: 'Pipeline & Bids', area: 'BUSINESS_DEVELOPMENT', icon: 'target' },
      { id: 'commercial', label: 'Cost & Value', area: 'BUDGET_COST', icon: 'coins' },
      { id: 'procurement', label: 'Tender & Procurement', area: 'PROCUREMENT_AWARD', icon: 'gavel' },
      { id: 'contracts', label: 'Change & Claims', area: 'CONTRACTS_CLAIMS', icon: 'scale' },
    ],
  },
  {
    group: 'Assure',
    items: [
      { id: 'control', label: 'Project Control', area: 'PROJECT_SETUP', icon: 'checklist' },
      { id: 'risk', label: 'Risk & Safety', area: 'RISK_REGISTER', icon: 'shield' },
      { id: 'handover', label: 'Handover & O&M', area: 'HANDOVER_OM', icon: 'key' },
      { id: 'audit', label: 'Golden Thread', area: 'EVIDENCE_AUDIT', icon: 'link' },
      // The fifteen generated document types. Under EVIDENCE_AUDIT read for the
      // same reason the command catalogue is: the screen is a statement about
      // what can be composed from this project's records, and each generation
      // still authorises itself against the records it reads.
      { id: 'documents', label: 'Site Documents', area: 'EVIDENCE_AUDIT', icon: 'clipboard' },
      // Every write command, with a door generated from the platform's own
      // schema. Under EVIDENCE_AUDIT read because the catalogue is a statement
      // about what the platform accepts, not an authority to run any of it —
      // each command still authorises itself when it is pressed.
      { id: 'commands', label: 'All commands', area: 'EVIDENCE_AUDIT', icon: 'checklist' },
    ],
  },
  {
    group: 'Platform',
    items: [
      { id: 'billing', label: 'ACU & Billing', area: 'BILLING_ACU', icon: 'meter' },
      { id: 'admin', label: 'Platform Admin', area: 'PLATFORM_ADMINISTRATION', icon: 'cog' },
      { id: 'newsletter', label: 'Newsletter', area: 'PLATFORM_ADMINISTRATION', icon: 'mail' },
      { id: 'communications', label: 'Communications', area: 'ENTERPRISE_STRUCTURE', icon: 'radar' },
      // Outside the capability matrix — see `visible()`. Asking to be erased is
      // not a permission somebody else grants you, and the mobile stores
      // require the route to exist for every account.
      { id: 'account', label: 'Account', area: 'PROJECT_SETUP', icon: 'cog' },
    ],
  },
];

const ICONS = {
  grid: 'M3 3h7v7H3zM11 3h7v7h-7zM3 11h7v7H3zM11 11h7v7h-7z',
  chat: 'M3 4h15v10H8l-5 4z',
  layers: 'M10 2 2 7l8 5 8-5zM2 12l8 5 8-5',
  chart: 'M3 17V7M8 17V3M13 17v-7M18 17v-4',
  clipboard: 'M6 3h8v3H6zM4 6h12v12H4z',
  cube: 'M10 2 3 6v8l7 4 7-4V6zM3 6l7 4 7-4M10 10v8',
  coins: 'M10 3c4 0 7 1.3 7 3s-3 3-7 3-7-1.3-7-3 3-3 7-3zM3 9c0 1.7 3 3 7 3s7-1.3 7-3M3 13c0 1.7 3 3 7 3s7-1.3 7-3',
  gavel: 'M3 16h8M5 12l6-6M8 3l6 6M4 9l4 4',
  scale: 'M10 3v14M4 7h12M4 7 2 13h4zM16 7l-2 6h4z',
  shield: 'M10 2 3 5v5c0 4 3 7 7 8 4-1 7-4 7-8V5z',
  key: 'M13 3a4 4 0 1 0-3.5 6L4 14.5V17h3l6-6a4 4 0 0 0 0-8z',
  link: 'M8 11a4 4 0 0 0 6 0l2-2a4 4 0 0 0-6-6L9 4M12 9a4 4 0 0 0-6 0l-2 2a4 4 0 0 0 6 6l1-1',
  meter: 'M3 15a7 7 0 1 1 14 0M10 15l4-5',
  radar: 'M10 2a8 8 0 1 0 8 8M10 6a4 4 0 1 0 4 4M10 10l6-5',
  cog: 'M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM10 2v2M10 16v2M2 10h2M16 10h2M4.5 4.5 6 6M14 14l1.5 1.5M15.5 4.5 14 6M6 14l-1.5 1.5',
  mail: 'M2 5h16v10H2zM2 5l8 6 8-6',
  target: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  checklist: 'M7 3h10v14H7zM3 5l1.5 1.5L7 4M3 10l1.5 1.5L7 8M3 15l1.5 1.5L7 13',
};

export function icon(name) {
  return raw(
    // `aria-hidden` because every one of these sits beside its own text label.
    // An icon that is announced as well as its label reads the item twice, and
    // WCAG 1.1.1 is satisfied by the label rather than by naming the glyph.
    `<svg class="ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${ICONS[name] ?? ICONS.grid}"/></svg>`,
  );
}

// --- permissions ------------------------------------------------------------

let matrix = null;
let writePhaseGates = {};
/** The roles a tenant admin may grant — published by the API, not assumed here. */
let grantableRoles = [];

async function loadMatrix() {
  if (matrix) return matrix;
  const result = await api.get('/v1/permissions/matrix');
  matrix = result.matrix;
  writePhaseGates = result.writePhaseGates ?? {};
  grantableRoles = result.tenantGrantableRoles ?? [];
  // The same call carries which events a device may never originate, so the
  // outbox refuses a governance action at the point of the press rather than
  // queuing one the sync engine will certainly reject.
  outbox.useNeverOffline(result.neverOffline);
  return matrix;
}

const WRITE_CODES = new Set(['C', 'U', 'A', 'I', 'G']);

/**
 * Why a command is unavailable, or null if it is available.
 *
 * Both halves come from the API — the permission matrix and the phase gates —
 * so the interface cannot offer a command the platform will refuse, and cannot
 * hide one it would accept. Duplicating either rule here is how the two drift.
 */
export function blockedReason(area, code = 'R', { tenantScoped = false } = {}) {
  const roles = state.session?.user?.roles ?? [];
  if (matrix && !roles.some((role) => (matrix[role]?.[area] ?? []).includes(code))) {
    return `No role of ${roles.join('/')} holds "${code}" on ${area}`;
  }

  // A tenant-scoped command runs against the tenant's governance scope, which
  // has no lifecycle phase — the bid pipeline exists precisely because there is
  // no project yet. Gating it on whatever delivery project the console happens
  // to have selected is the browser holding a rule the server does not, which
  // is the exact drift this function exists to prevent: the API accepts these
  // commands whatever phase an unrelated project is in.
  const phase = tenantScoped ? undefined : state.project?.phase;
  const allowed = writePhaseGates[area];
  if (WRITE_CODES.has(code) && phase && allowed && !allowed.includes(phase)) {
    return `${humanise(area)} cannot be written during the ${humanise(phase)} phase`;
  }

  return null;
}

/**
 * Can the current identity run this, here, now? Reads are role-only; writes are
 * additionally gated by the lifecycle phase, exactly as the platform gates them
 * — unless the command is tenant-scoped, in which case there is no project and
 * therefore no phase to gate on.
 */
export function can(area, code = 'R', options) {
  if (!matrix) return true;
  return blockedReason(area, code, options) === null;
}

/**
 * Platform operators are a different account layer, not a senior customer role:
 * they run tenancy, billing and system health and are barred from delivery data
 * altogether. The shell has to know that, because an operator has no project to
 * load a context for.
 */
export function isOperator() {
  return (state.session?.user?.roles ?? []).includes('PLATFORM_ADMIN');
}

// --- routing ----------------------------------------------------------------

function currentRoute() {
  const path = location.pathname.replace(/^\/app\/?/, '');
  const [page, ...rest] = path.split('/').filter(Boolean);
  return { page: page || (isOperator() ? 'admin' : 'overview'), params: rest };
}

export function navigate(page, params = []) {
  const path = ['/app', page, ...params].join('/').replace(/\/+$/, '');
  history.pushState({}, '', path);
  void draw();
}

window.addEventListener('popstate', () => void draw());

document.addEventListener('click', (event) => {
  const link = event.target.closest('[data-nav]');
  if (!link) return;
  event.preventDefault();
  navigate(link.dataset.nav);
});

// Every KPI opens to the events behind it. Wired once for the whole
// application: each screen re-renders its own root on every draw, so a listener
// bound per tile would be re-attached on each one.
wireDrill(() => state.session?.projectId);

// --- session ----------------------------------------------------------------

/**
 * Sign in with a real credential: verify the MFA code and establish the session.
 *
 * Separate from `signIn` below for one reason that matters — it does not touch
 * `/v1/console/identities`. That route seeds and returns the demonstration
 * project and is refused in production, so the demo path could not establish a
 * session on a real deployment even holding a perfectly valid token. Context
 * here comes from what the tenancy actually has: its own projects, or none.
 *
 * A brand new tenancy has no projects, and that is a normal state rather than a
 * failure. The console opens on the enterprise view, which is where a project
 * gets created.
 */
export async function signInWithCredentials({ actorId, challengeId, code }) {
  const verified = await api.post('/v1/auth/mfa/verify', { actorId, challengeId, code }, { anonymous: true });

  session.set({
    accessToken: verified.accessToken,
    refreshToken: verified.refreshToken,
    user: verified.user,
  });
  state.session = session.get();

  // What this tenancy can see, asked with the token we just earned. Failure is
  // not fatal: an account with no projects is a new account, not a broken one.
  let projects = [];
  try {
    const listed = await api.get('/v1/projects');
    projects = listed?.projects ?? listed?.items ?? (Array.isArray(listed) ? listed : []);
  } catch {
    projects = [];
  }

  const first = projects[0];
  session.set({ ...session.get(), projectId: first?.id ?? first?.projectId ?? null });
  state.session = session.get();
  state.project = null;
  state.gate = null;
  state.wallet = null;
  matrix = null;

  navigate(isOperator() ? 'admin' : state.session.projectId ? 'overview' : 'enterprise');
}

export async function signIn(identity) {
  const challenge = await api.post('/v1/auth/login', { email: identity.email }, { anonymous: true });
  // The code comes back in the response rather than by email, and the platform
  // decides under which of two rules: `devCode` outside production, where every
  // account is a fixture; `demoCode` in production, where only an identity the
  // demonstration seed created qualifies and a customer's account never will.
  // Neither shortens the flow — the challenge is real, expires in five minutes,
  // is single-use, and the token is only minted once /mfa/verify accepts it.
  const code = challenge.devCode ?? challenge.demoCode;
  const verified = await api.post(
    '/v1/auth/mfa/verify',
    { actorId: challenge.actorId, challengeId: challenge.challengeId, code },
    { anonymous: true },
  );

  const bootstrap = await api.post('/v1/console/identities', {}, { anonymous: true });

  session.set({
    accessToken: verified.accessToken,
    refreshToken: verified.refreshToken,
    user: verified.user,
    projectId: bootstrap.projectId,
    enterprise: bootstrap.enterprise,
    portfolio: bootstrap.portfolio,
  });
  state.session = session.get();
  state.project = null;
  state.gate = null;
  state.wallet = null;
  matrix = null;
  navigate(isOperator() ? 'admin' : 'overview');
}

export function signOut() {
  session.clear();
  state.session = null;
  state.project = null;
  // Queued operations were authorised for the identity signing out, and a site
  // handset changes hands. Leaving them to flush under the next operative's
  // token would attribute one person's record to another.
  void outbox.clear();
  navigate('login');
}

/**
 * Push whatever the outbox is holding, and say what happened.
 *
 * Called when the browser reports it is back online and once on load, because
 * `online` does not fire for an application launched with signal already
 * present. Silent on success with nothing to send; a rejected operation is
 * always surfaced, because finding out at the end of the week that a record
 * did not stick is how a field log loses its authority.
 */
async function drainOutbox() {
  if (!state.session || !navigator.onLine) return;

  let result;
  try {
    result = await outbox.flush((path, body) => api.post(path, body));
  } catch {
    return; // Nothing was decided. The queue keeps everything and tries again.
  }

  if (result.accepted > 0) {
    toast('Field records synced', `${result.accepted} operation${result.accepted === 1 ? '' : 's'} filed`, 'ok');
  }
  for (const conflict of result.conflicts) {
    if (conflict.resolution === 'REJECTED' || conflict.resolution === 'SERVER_WINS') {
      toast('Field record not accepted', conflict.message, 'err');
    }
  }

  // Files after operations, never before: an upload is refused unless a ledger
  // record already names its hash, so the record has to land first. A file the
  // platform is not ready for stays on the handset rather than being dropped.
  const files = await outbox.flushFiles((path, blob) => api.upload(path, blob));
  if (files.stored > 0) {
    toast('Evidence uploaded', `${files.stored} file${files.stored === 1 ? '' : 's'} now held by the platform`, 'ok');
  }
  if (files.rejected > 0) {
    toast(
      'Evidence not stored',
      `${files.rejected} file${files.rejected === 1 ? ' does' : 's do'} not match the hash recorded against them and cannot be attached.`,
      'err',
    );
  }

  if (result.accepted > 0 || files.stored > 0) await draw();
}

window.addEventListener('online', () => void drainOutbox());

// --- shell ------------------------------------------------------------------

function sidebar(active) {
  // A real link with a real href, not a click handler: the wordmark is the one
  // thing on every screen a person expects to take them home, and a plain
  // anchor is also what lets them middle-click it, copy the address, or see
  // where it goes before they press it. `/` leaves the shell for the public
  // site, so it is a document navigation rather than a client route.
  return html`<aside class="sidebar" aria-label="Primary">
    <a class="sidebar-mark" href="/" aria-label="CONSTRUX home">
      <!-- The reduced mark. Geometry matches frontend/logo-glyph.svg; at 19px
           the full mark's crane and ground line become grey smudges, which read
           as a rendering fault rather than as a logo. -->
      <svg width="19" height="19" viewBox="0 0 64 64" fill="none" aria-hidden="true">
        <path fill="#6b727b" d="M12 14 L22 9 L22 40 L12 40 Z"/>
        <path fill="#8b939d" d="M24 12 L31 8 L31 40 L24 40 Z"/>
        <path fill="#6b727b" d="M30 30 L38 30 L45 40 L41 45 Z"/>
        <path fill="#6b727b" d="M43 38 L50 38 L56 52 L47 52 Z"/>
        <path fill="#ff6600" d="M45 30 L56 30 L41 52 L31 52 Z"/>
      </svg>
      <span style="white-space:nowrap">CONSTRU<span class="x">X</span></span>
    </a>

    ${NAV.map((group) => {
      // A group where the viewer can reach nothing is hidden outright — an
      // entire section of locks teaches less than it costs. Within a group the
      // viewer *can* use, the unreachable items stay visible and locked,
      // because there a lock names a colleague to ask.
      if (!group.items.some((item) => reachable(item))) return '';
      const visible = group.items.filter((item) => worthShowing(item));
      return html`<nav class="nav-group" aria-labelledby="navgroup-${raw(group.group.toLowerCase().replace(/[^a-z]+/g, '-'))}">
        <div class="nav-group-label" id="navgroup-${raw(group.group.toLowerCase().replace(/[^a-z]+/g, '-'))}">${group.group}</div>
        ${visible.map((item) => {
          if (!reachable(item)) {
            return html`<button class="nav-item locked" title="${lockReason(item)}">
              ${icon(item.icon)}<span>${item.label}</span><span class="lock">🔒</span>
            </button>`;
          }
          return html`<button class="nav-item ${raw(active === item.id ? 'active' : '')}" data-nav="${item.id}">
            ${icon(item.icon)}<span>${item.label}</span>
          </button>`;
        })}
      </nav>`;
    })}

    <div class="sidebar-foot">
      ${
        isOperator()
          ? html`<div class="acu-mini"><div class="l">Account layer</div><div class="v">Platform operator</div></div>`
          : html`<div class="acu-mini">
              <div class="l">ACU available</div>
              <div class="v">${state.wallet ? money(state.wallet.availableMinor) : '—'}</div>
              <div class="acu-bar"><i style="width:${raw(walletPercent())}%"></i></div>
            </div>`
      }
    </div>
  </aside>`;
}

/**
 * Navigation mirrors enforcement rather than restating it. Overview and Copilot
 * are open to any customer role because both are grounded reads of a project
 * the user is already on; everything else asks the live permission matrix.
 */
function reachable(item) {
  // An operator holds billing and audit rights at the platform level, but every
  // billing and audit *screen* in this product is scoped to a tenant's project —
  // and an operator has none. So the Platform page is the whole operator app.
  if (isOperator()) return item.area === 'PLATFORM_ADMINISTRATION';
  if (item.area === 'PLATFORM_ADMINISTRATION') return false;
  return can(item.area, 'R') || item.id === 'overview' || item.id === 'copilot' || item.id === 'account';
}

/**
 * Is this item worth showing at all, locked or not?
 *
 * The sidebar's rule is that a capability the viewer cannot reach is shown
 * locked with the reason, because somebody needs to know the capability exists
 * and who to ask for it. That is right for a capability a *colleague* holds —
 * an FM seeing Programme locked learns something true and actionable.
 *
 * It is wrong for a capability nobody in the customer's world can ever hold.
 * Platform Admin and Newsletter sit under an area only the platform operator
 * role holds, and that role is not one a tenant administrator can grant — so
 * for every customer account, on every screen, forever, those two were dead
 * items with a lock on them. There is no colleague to ask. That is not
 * information, it is furniture.
 *
 * Reachability-by-anybody is computed from the published matrix and the
 * published grantable-role list rather than from a hard-coded role name here,
 * so it cannot drift from the server's own answer.
 */
function worthShowing(item) {
  if (isOperator()) return true;
  if (!matrix || grantableRoles.length === 0) return true;
  if (reachable(item)) return true;
  return grantableRoles.some((role) => (matrix[role]?.[item.area] ?? []).includes('R'));
}

function lockReason(item) {
  if (isOperator()) {
    return item.area === 'BILLING_ACU' || item.area === 'EVIDENCE_AUDIT'
      ? 'Operator billing and audit are estate-wide and shown on the Platform page'
      : 'Platform operators are barred from customer delivery data';
  }
  if (item.area === 'PLATFORM_ADMINISTRATION') return 'Platform administration is not visible to customer accounts';
  return `Your role has no read access to ${item.area}`;
}

function walletPercent() {
  if (!state.wallet) return 0;
  const total = state.wallet.balanceMinor || 1;
  return Math.max(2, Math.min(100, Math.round((state.wallet.availableMinor / total) * 100)));
}

function topbar() {
  const user = state.session?.user;
  return html`<header class="topbar">
    <div class="crumb">
      ${
        isOperator()
          ? html`CONSTRUX <span style="opacity:.4">›</span> <b>Platform operations</b>`
          : html`${state.session?.enterprise} <span style="opacity:.4">›</span> ${state.session?.portfolio}
              <span style="opacity:.4">›</span> <b>${state.project?.name ?? 'Loading…'}</b>`
      }
    </div>
    <div class="spacer"></div>
    ${isOperator() ? html`<span class="phase-tag">OPERATOR</span>` : state.project ? html`<span class="phase-tag">${state.project.phase}</span>` : ''}
    <button class="user-chip" id="user-chip">
      <span class="avatar">${initials(user?.name)}</span>
      <span><span class="nm">${user?.name}</span><br><span class="rl">${(user?.roles ?? []).join(', ')}</span></span>
    </button>
  </header>`;
}

async function loadContext() {
  // An operator has no project context to load — asking for one would be denied,
  // correctly, by the same rule that hides delivery navigation from them.
  if (isOperator()) return;

  const { projectId } = state.session;
  const [detail, wallet] = await Promise.all([
    api.get(`/v1/projects/${projectId}`),
    api.get('/v1/billing/wallet').catch(() => null),
  ]);
  state.project = detail.project;
  state.gate = detail.gate;
  state.wallet = wallet;
}

async function draw() {
  state.session = session.get();
  const { page, params } = currentRoute();

  if (!state.session) {
    // Two views are reachable without one, and only two. Registration has to be,
    // or the pricing page's buttons lead to a screen asking for the credentials
    // of the account somebody is trying to create — which is what they did.
    // Anything else falls through to sign-in rather than 404ing, because a
    // signed-out person following a deep link wants the door, not an error.
    await (page === 'signup' ? PAGES.signup(root) : PAGES.login(root));
    return;
  }

  // The signed-out views are not shell views. Drawing one inside the shell puts
  // a sign-in panel over the top of a signed-in session; somebody who kept the
  // registration link open in a tab and then signed in elsewhere belongs at
  // their overview, not at a form for an account they already have.
  if (page === 'signup' || page === 'login') {
    navigate(isOperator() ? 'admin' : 'overview');
    return;
  }

  await loadMatrix();

  const view = PAGES[page] ?? PAGES.overview;

  render(
    root,
    html`<div class="shell">
      ${sidebar(page)}
      <main class="main">
        ${topbar()}
        <div class="view" id="view"><div class="grid g4">
          <div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>
        </div></div>
      </main>
    </div>`,
  );

  document.getElementById('user-chip')?.addEventListener('click', () => {
    if (confirm('Sign out and choose a different identity?')) signOut();
  });

  try {
    if (!state.project) await loadContext();
    // Redraw the shell now that project and wallet context exist.
    render(
      root,
      html`<div class="shell">
        ${sidebar(page)}
        <main class="main">${topbar()}<div class="view" id="view"></div></main>
      </div>`,
    );
    document.getElementById('user-chip')?.addEventListener('click', () => {
      if (confirm('Sign out and choose a different identity?')) signOut();
    });

    const navEntry = NAV.flatMap((group) => group.items).find((item) => item.id === page);
    if (navEntry && !reachable(navEntry)) {
      render(
        document.getElementById('view'),
        html`<div class="notice err"><div><b>Not authorised</b><br>${lockReason(navEntry)}.</div></div>`,
      );
      return;
    }

    resetWithheld();
    await view(document.getElementById('view'), params);

    // Say what was withheld rather than letting a denial read as an empty
    // record. "You may not see this" and "there is nothing here" are different
    // answers, and on a construction record the difference matters.
    const denied = withheldRecords();
    if (denied.length > 0) {
      document.getElementById('view')?.insertAdjacentHTML(
        'afterbegin',
        resolveNotice(denied),
      );
    }
  } catch (error) {
    const detail = error instanceof ApiError ? error.message : String(error);
    render(
      document.getElementById('view') ?? root,
      html`<div class="notice err"><div><b>${error instanceof ApiError ? error.code : 'Error'}</b><br>${detail}</div></div>`,
    );
    if (error instanceof ApiError && error.status === 401) signOut();
  }
}

function resolveNotice(denied) {
  const reasons = [...new Set(denied.map((d) => d.reason))];
  const types = denied.map((d) => humanise(d.refType)).join(', ');
  return `<div class="notice info" style="margin-bottom:14px"><div><b>${denied.length} record type${
    denied.length === 1 ? '' : 's'
  } withheld from your role: ${esc(types)}.</b><br>${esc(reasons.join(' · '))}</div></div>`;
}

/** Refresh cached project context — called by pages after a command. */
export async function refreshContext() {
  await loadContext();
}

export { draw };

// --- splash and installation ------------------------------------------------

/**
 * Take the splash down once a real screen is behind it.
 *
 * The splash is markup in index.html, so it is on screen before this file has
 * parsed — which is what makes the handover from the operating system's launch
 * screen invisible. It comes down here rather than on `load` because `load`
 * fires when assets have arrived, not when the application has something to
 * show, and dropping it early would reveal an empty page.
 */
function dismissSplash() {
  const splash = document.getElementById('splash');
  if (!splash || splash.classList.contains('done')) return;
  splash.classList.add('done');
  splash.addEventListener('transitionend', () => splash.remove(), { once: true });
  // A transition that never fires — reduced motion, a backgrounded tab — must
  // not leave the splash covering the application for ever.
  setTimeout(() => splash.remove(), 600);
}

/** Say so on the splash when the first draw fails, rather than spinning. */
function splashFailed(message) {
  const note = document.getElementById('splash-note');
  if (!note) return;
  note.textContent = message;
  note.classList.add('failed');
}

void draw()
  .then(dismissSplash)
  // Once on load as well as on `online`: the event does not fire for an
  // application launched with signal already present, which is the common case
  // for a handset that queued work yesterday and is opened back at the office.
  .then(() => drainOutbox())
  .catch((error) => {
    // draw() handles its own errors, so reaching here means the shell itself
    // failed. Leaving the splash up with its progress bar sweeping would imply
    // the application is still starting when it has already given up.
    splashFailed(
      error instanceof ApiError
        ? `${error.code ?? 'Error'} — ${error.message}`
        : 'The application could not start. Reload to try again.',
    );
  });

/**
 * Register the service worker.
 *
 * It is what makes the application installable, and installation is what makes
 * the operating system show a launch screen. It caches the shell and nothing
 * else — see the rule at the top of sw.js about /v1/.
 *
 * Registration failing is not an error worth showing anybody: the application
 * runs identically without it, minus the home-screen icon.
 */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/app' }).catch(() => {});
  });
}

// Armed after registration, not before: it only listens, and what it offers is
// worth nothing until there is a service worker behind it to install.
armInstallPrompt();

window.addEventListener('unhandledrejection', (event) => {
  const error = event.reason;
  if (error instanceof ApiError) {
    toast(error.code ?? 'Request failed', error.message, 'err');
    event.preventDefault();
  }
});
