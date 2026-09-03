import { api, ApiError, resetWithheld, session, setAreaReadGuard, setEntityReadGuard, withheldRecords } from './lib/api.js';
import { esc, html, humanise, initials, money, raw, render, toast } from './lib/ui.js';
import { wireDrill } from './lib/drill.js';
import { armInstallPrompt } from './lib/install.js';
import * as outbox from './lib/outbox.js';
import { PAGES } from './pages/index.js';

/**
 * Application shell: routing, session, and the role-aware navigation.
 *
 * The menu shows what this identity can do, and one line at its foot counts
 * what it cannot and links to the Permissions screen that explains it. That is
 * a correction: routes the role could not reach used to be shown locked and
 * in place, on the argument that somebody needs to know a capability exists and
 * who to ask. The first half of that argument was right and the second was not
 * being served — a padlock cannot name the colleague, cannot say which
 * permission letters are short, and cannot mention the lifecycle phase gate,
 * which is the commonest reason a command is refused to somebody who does hold
 * it. Measured across the twelve demonstration identities it came to five
 * padlocks each and eight for the planner. All of that information is on the
 * Permissions screen now, for every capability area rather than only the ones
 * with a menu entry.
 */

const root = document.getElementById('root');

export const state = {
  session: null,     // { accessToken, user, projectId, enterprise, portfolio }
  project: null,     // materialised project state
  projects: [],      // every project this identity may open, for the picker
  gate: null,        // current phase gate evaluation
  wallet: null,      // ACU snapshot
};

// --- navigation model -------------------------------------------------------

/**
 * Each entry declares the capability area it reads. The sidebar checks that
 * against the live permission matrix, so navigation and enforcement can never
 * drift apart.
 *
 * Some screens serve more than one area, and those declare `alsoArea`. The rule
 * is *any*, not *all*: a screen is reachable by anybody who can read any part
 * of it, and each panel inside then authorises itself as it already does.
 *
 * The single-area gate had a consequence nobody would defend if it were stated
 * out loud. The Construction screen holds the five site registers — permits,
 * method statements, inductions, inspection plans, non-conformances — and was
 * gated on SAFETY_RAMS alone, so the QA/QC engineer, who *owns* the quality
 * half of it and holds create, update and approve on QUALITY_COMMISSIONING, was
 * refused the entire page. The person whose registers those are could not see
 * them, and the reason on screen was an area they have no business holding.
 */
export const NAV = [
  {
    group: 'Command',
    items: [
      // First, because it is where a project comes from.
      //
      // Everything below it is about a project, and a new tenancy has none —
      // so the four screens a customer met first were the four that could not
      // answer anything yet, and the one that creates the project they were
      // waiting for was fifth. The signed-in landing already sends a tenancy
      // with no project here; the menu now agrees with that instead of
      // offering four dead ends above it.
      //
      // It stays first for a tenancy that has projects, because this is also
      // where the estate is: enterprise, portfolios, people, invitations and
      // seats. Ordering a menu by what a first-time customer needs and what a
      // daily user needs gives the same answer here.
      { id: 'enterprise', label: 'Enterprise & Portfolio', area: 'PROJECT_SETUP', icon: 'layers', tenantScoped: true },
      { id: 'overview', label: 'Project Command Centre', area: 'PROJECT_SETUP', icon: 'grid' },
      // Assembled per person from seven functions over four questions. Under
      // PROJECT_SETUP read because that is the narrowest thing every seat
      // holds; each function inside authorises itself against the area it
      // actually reads, so the sidebar entry cannot widen anything.
      { id: 'centre', label: 'Command Centre', area: 'PROJECT_SETUP', icon: 'grid' },
      { id: 'copilot', label: 'Copilot', area: 'PROJECT_SETUP', icon: 'chat' },
      { id: 'autopilot', label: 'Autopilot', area: 'AI_EXECUTION', icon: 'radar' },
    ],
  },
  {
    group: 'Deliver',
    items: [
      // First in the group because it is first in the lifecycle. Under
      // PROJECT_SETUP read, which is the area the configuration, the brief, the
      // constraints and the options all sit in; the cost and programme panels
      // authorise themselves separately from BUDGET_COST and
      // PROGRAMME_BASELINES, panel by panel.
      { id: 'concept', label: 'Concept', area: 'PROJECT_SETUP', icon: 'target' },
      // Also the lookahead and the work packages, which is the site
      // supervisor's own tool: the weekly work plan and the constraints against
      // it are theirs to keep, and gating this on the baseline alone shut the
      // person who runs Last Planner out of the screen that holds it.
      { id: 'programme', label: 'Programme', area: 'PROGRAMME_BASELINES', alsoArea: ['WORKPACKAGES_TASKS', 'LOOKAHEAD_CONSTRAINTS'], icon: 'chart' },
      // The safety half of the field screen belongs to whoever holds RAMS,
      // including the principal designer, whose CDM duties do not stop at the
      // design.
      { id: 'field', label: 'Field Execution', area: 'FIELD_EXECUTION', alsoArea: ['SAFETY_RAMS'], icon: 'clipboard' },
      // The five registers a site runs on: permits, method statements,
      // inductions, inspection plans and non-conformances. Under SAFETY_RAMS
      // read because that is the area the permit and the method statement live
      // in and the one a site manager is judged on; the quality half of the
      // screen authorises itself separately, panel by panel.
      { id: 'construction', label: 'Construction', area: 'SAFETY_RAMS', alsoArea: ['QUALITY_COMMISSIONING', 'FIELD_EXECUTION'], icon: 'shield' },
      // Gated on the model alone until the common data environment landed on
      // this screen. The CDE, the review cycle, the RFI register, submittals
      // and the drawing register are all DESIGN_INFORMATION — so the architect
      // who authors every container on the project could not open the screen
      // that holds them, while the BIM coordinator could.
      { id: 'design', label: 'Design & BIM', area: 'BIM_TWIN', alsoArea: ['DESIGN_INFORMATION'], icon: 'cube' },
      // The ETABLIX module. `module` is what makes it absent rather than locked
      // for everybody else — see `reachable()` — and the value is checked
      // against what the API said this tenancy holds, never against a constant
      // here. In the Deliver group because the temporary infrastructure and the
      // living environment are what the permanent works are built out of.
      {
        id: 'siteservices',
        label: 'Site Services',
        area: 'SITE_SERVICES',
        module: 'ETABLIX',
        icon: 'layers',
      },
    ],
  },
  {
    group: 'Commercial',
    items: [
      { id: 'pipeline', label: 'Pipeline & Bids', area: 'BUSINESS_DEVELOPMENT', icon: 'target', tenantScoped: true },
      { id: 'commercial', label: 'Cost & Value', area: 'BUDGET_COST', icon: 'coins' },
      // Measurement and the supplier's own return sit on this screen. The
      // BIM manager takes off quantities from the model and a supplier answers
      // an enquiry; neither holds procurement award, and neither could reach
      // the screen that takes their work.
      { id: 'procurement', label: 'Tender & Procurement', area: 'PROCUREMENT_AWARD', alsoArea: ['BOQ_TAKEOFF', 'ESTIMATE_TENDER', 'SUPPLIER_SUBMISSION'], icon: 'gavel' },
      // A design change is raised by the design team and valued by the
      // commercial one. Gating on contracts alone meant the half of the screen
      // that starts the process was unreachable by the people who start it.
      { id: 'contracts', label: 'Change & Claims', area: 'CONTRACTS_CLAIMS', alsoArea: ['CHANGE_VARIATION', 'DESIGN_INFORMATION'], icon: 'scale' },
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
      { id: 'commands', label: 'All commands', area: 'EVIDENCE_AUDIT', icon: 'checklist', tenantScoped: true },
    ],
  },
  {
    group: 'Platform',
    items: [
      { id: 'billing', label: 'ACU & Billing', area: 'BILLING_ACU', icon: 'meter', tenantScoped: true },
      // Beside billing, and distinct from the Cost & Value screen that also
      // carries the word "commercial". That one is the customer's money on
      // their own jobs; this is their account with us — what we earned on money
      // we carried for them, what they are against in their entitlement,
      // whether the platform is still being used, and the benchmark consent.
      { id: 'platformCommercial', label: 'Your account with us', area: 'ENTERPRISE_STRUCTURE', icon: 'coins', tenantScoped: true },
      // Under ENTERPRISE_STRUCTURE read, which is what the key register needs.
      // Issuing a credential needs G on the same area and the command bar reads
      // that separately, so the screen is visible to somebody who can see what
      // exists without being able to hand one out.
      //
      // Moved here from the Command group at the top. It is tenancy
      // administration — API keys, webhooks, scoped tokens — and only the
      // enterprise administrator holds it, so in the first group it was the
      // most prominent thing on the screen for the eleven delivery roles who
      // cannot open it. It belongs beside the other administration items.
      { id: 'developer', label: 'Developer', area: 'ENTERPRISE_STRUCTURE', icon: 'layers', tenantScoped: true },
      { id: 'admin', label: 'Platform Admin', area: 'PLATFORM_ADMINISTRATION', icon: 'cog', tenantScoped: true },
      // The self-managing layer, the telemetry egress and the agent fleet. All
      // of it ran for weeks with no door: an operator saw five items, three of
      // them locked, and two screens. Operator-only because every read behind
      // it is `operatorOnly` on the server.
      { id: 'operations', label: 'Platform Operations', area: 'PLATFORM_ADMINISTRATION', icon: 'shield', tenantScoped: true },
      { id: 'newsletter', label: 'Newsletter', area: 'PLATFORM_ADMINISTRATION', icon: 'mail', tenantScoped: true },
      // The public blog. Beside the newsletter because both are the platform
      // talking outward under its own name, and neither is a customer's.
      { id: 'blog', label: 'Blog', area: 'PLATFORM_ADMINISTRATION', icon: 'clipboard', tenantScoped: true },
      // Platform administration, not a customer screen.
      //
      // I moved this to PROJECT_SETUP on the argument that
      // `GET /v1/notifications/catalogue` is readable by any authenticated
      // identity, which is true — and it was the wrong conclusion. The screen is
      // not the catalogue: it is the *operator's* view of the event
      // architecture, with channel wiring, provider status, template QA and the
      // estate-wide coverage figures. Those are platform operations questions,
      // and the delivery log inside it is refused to an operator by name for the
      // opposite reason — it is a tenancy's own outbound mail.
      //
      // A customer who wants to know what the platform may send them reads their
      // own notification preferences on the Account screen, which is where that
      // question belongs.
      { id: 'communications', label: 'Communications', area: 'PLATFORM_ADMINISTRATION', icon: 'radar', tenantScoped: true },
      // Outside the capability matrix — see `visible()`. Asking to be erased is
      // not a permission somebody else grants you, and the mobile stores
      // require the route to exist for every account.
      // Outside the capability matrix, like Account and for the same reason:
      // your own devices and passkeys are not a permission somebody else
      // grants you. The tenancy-wide half of the screen *is* gated, by the
      // route that serves it.
      { id: 'security', label: 'Security', area: 'PLATFORM_ADMINISTRATION', icon: 'shield', tenantScoped: true },
      { id: 'account', label: 'Account', area: 'PROJECT_SETUP', icon: 'cog', tenantScoped: true },
    ],
  },
];

/**
 * The platform operator's own navigation.
 *
 * A separate model rather than a filter over `NAV`, because it is a different
 * application. An operator cannot open a project, a drawing or a daily log —
 * that is the account layer, enforced in ABAC — so filtering the delivery
 * navigation down to what they can reach produced what it always produced: a
 * short list with locks on it and two live screens, which is what somebody
 * running a platform was being handed.
 *
 * What an operator actually does is run a business: know where the money is,
 * who is about to leave, what is failing, who is waiting for an answer, and
 * what the record says. Each entry below is a screen over reads the platform
 * already publishes, grouped the way the job is done rather than the way the
 * API is organised.
 *
 * The delivery navigation is not removed by this — a customer account still
 * gets `NAV`, unchanged. `navigation()` picks between them.
 */
export const OPERATOR_NAV = [
  {
    group: 'Overview',
    items: [
      { id: 'admin', label: 'Command Center', area: 'PLATFORM_ADMINISTRATION', icon: 'grid' },
      { id: 'performance', label: 'Performance', area: 'PLATFORM_ADMINISTRATION', icon: 'chart' },
      { id: 'value', label: 'Customer Value', area: 'PLATFORM_ADMINISTRATION', icon: 'coins' },
      { id: 'intel', label: 'Predictive Intel', area: 'PLATFORM_ADMINISTRATION', icon: 'radar' },
    ],
  },
  {
    group: 'Customers',
    items: [
      { id: 'tenants', label: 'Tenants & Users', area: 'PLATFORM_ADMINISTRATION', icon: 'layers' },
      { id: 'onboarding', label: 'Onboarding Queue', area: 'PLATFORM_ADMINISTRATION', icon: 'target' },
      // Outside PLATFORM_ADMINISTRATION deliberately: a support request belongs
      // to the tenancy that raised it, and the customer has to be able to read
      // back what they were told. The screen serves both sides.
      { id: 'support', label: 'Support Queue', area: 'ENTERPRISE_STRUCTURE', icon: 'chat' },
      // Booked from the public site by people with no account at all, which is
      // why it belongs beside the support queue rather than under Content: it
      // is somebody waiting for an answer.
      { id: 'bookings', label: 'Demo Bookings', area: 'PLATFORM_ADMINISTRATION', icon: 'checklist' },
      { id: 'communications', label: 'Communications', area: 'ENTERPRISE_STRUCTURE', icon: 'mail' },
    ],
  },
  {
    group: 'AI & economy',
    items: [
      { id: 'aiengine', label: 'AI Engine', area: 'PLATFORM_ADMINISTRATION', icon: 'radar' },
      { id: 'economy', label: 'ACU Economy', area: 'PLATFORM_ADMINISTRATION', icon: 'meter' },
      { id: 'invoices', label: 'Billing & Invoices', area: 'PLATFORM_ADMINISTRATION', icon: 'coins' },
    ],
  },
  {
    group: 'Risk & system',
    items: [
      { id: 'alerts', label: 'Risk & Alerts', area: 'PLATFORM_ADMINISTRATION', icon: 'shield' },
      { id: 'system', label: 'System Control', area: 'PLATFORM_ADMINISTRATION', icon: 'cog' },
      { id: 'operations', label: 'Platform Operations', area: 'PLATFORM_ADMINISTRATION', icon: 'checklist' },
      { id: 'auditlogs', label: 'Audit Logs', area: 'PLATFORM_ADMINISTRATION', icon: 'link' },
      { id: 'eventstore', label: 'Event Store', area: 'PLATFORM_ADMINISTRATION', icon: 'cube' },
    ],
  },
  {
    group: 'Content & reports',
    items: [
      { id: 'reports', label: 'Reports', area: 'PLATFORM_ADMINISTRATION', icon: 'clipboard' },
      { id: 'blog', label: 'SEO & Content', area: 'PLATFORM_ADMINISTRATION', icon: 'clipboard' },
      { id: 'newsletter', label: 'Newsletter', area: 'PLATFORM_ADMINISTRATION', icon: 'mail' },
      { id: 'blueprint', label: 'Blueprint', area: 'PLATFORM_ADMINISTRATION', icon: 'cube' },
    ],
  },
  {
    group: 'Account & settings',
    items: [
      { id: 'partners', label: 'Growth Partner Programme', area: 'PLATFORM_ADMINISTRATION', icon: 'layers' },
      { id: 'influencers', label: 'Influencers', area: 'PLATFORM_ADMINISTRATION', icon: 'target' },
      { id: 'company', label: 'Company Profile', area: 'PLATFORM_ADMINISTRATION', icon: 'grid' },
      { id: 'settings', label: 'Settings', area: 'PLATFORM_ADMINISTRATION', icon: 'cog' },
      { id: 'security', label: 'Security', area: 'PLATFORM_ADMINISTRATION', icon: 'shield' },
      { id: 'account', label: 'My Account', area: 'PROJECT_SETUP', icon: 'cog' },
    ],
  },
];

/** Which navigation this identity gets. The operator's is a different app. */
export function navigation() {
  return isOperator() ? OPERATOR_NAV : NAV;
}

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
/**
 * The private modules this tenancy holds. Almost always empty.
 *
 * Published by the API with the matrix, never assumed here: a module is
 * capability an operator has handed to a named company off the price list, and
 * the browser deciding for itself which company that is would be the browser
 * holding a rule the server does not.
 */
let heldModules = [];

/**
 * The grantable roles, for a screen that offers them.
 *
 * A getter rather than the array, because the value arrives with the permission
 * matrix: a page importing the binding directly would capture the empty array
 * this module starts with and offer a role picker with nothing in it.
 *
 * Whatever a form offers, the server intersects against `TENANT_GRANTABLE_ROLES`
 * again — this list makes the picker honest, it does not make it authoritative.
 */
export function tenantGrantableRoles() {
  return grantableRoles;
}

/**
 * The whole enforcement picture, for the screen that explains it.
 *
 * Getters for the same reason as above — these arrive with the matrix, and a
 * page importing the bindings directly would capture the empty values this
 * module starts with. Nothing here is a second copy of a rule: it is the
 * server's own answer, handed on.
 */
export function permissionMatrix() {
  return matrix;
}

export function phaseGates() {
  return writePhaseGates;
}

/**
 * The private modules this tenancy holds, for a screen that shows them.
 *
 * A getter for the same reason as the two above: the value arrives with the
 * matrix, so a page importing the binding directly would capture the empty
 * array this module starts with.
 */
export function modules() {
  return heldModules;
}

/**
 * Does this tenancy hold a module?
 *
 * Used to gate navigation, so a module screen is *absent* for a tenancy without
 * the grant rather than present and refusing. The server refuses it either way
 * — `requireModule` runs on every module route — and this only decides whether
 * to offer something that would be refused.
 *
 * Note the direction: unlike `can()`, which returns true before the matrix has
 * loaded so the interface does not flicker into a locked state, this returns
 * false. Offering a capability early is a cosmetic problem; showing somebody a
 * module their company has not been given is the one thing this must not do.
 */
export function hasModule(id) {
  return heldModules.some((entry) => entry.id === id);
}

/**
 * Forget everything the last session was told about what it may do.
 *
 * Called on every sign-in, sign-out and token expiry. All four values arrive
 * together from `/v1/permissions/matrix` and only `matrix` was being cleared,
 * which left the previous identity's grantable roles — and, once modules
 * existed, the previous *tenancy's* module list — readable in the window
 * between the reset and the next load. For the matrix that was harmless
 * because it is the same for everybody; for a module grant it is not.
 */
function forgetPermissions() {
  matrix = null;
  writePhaseGates = {};
  grantableRoles = [];
  heldModules = [];
}

/**
 * Which roles in this customer's world can read an area, excluding the viewer's.
 *
 * This is the sentence a lock is actually for — not "you cannot", which the
 * absence of the screen already says, but *who to ask*. Operator-only roles are
 * excluded because a tenant administrator cannot grant them, so naming one would
 * send somebody to a colleague who cannot exist in their organisation.
 */
export function rolesThatCanRead(area) {
  if (!matrix) return [];
  const mine = new Set(state.session?.user?.roles ?? []);
  return grantableRoles.filter((role) => !mine.has(role) && (matrix[role]?.[area] ?? []).includes('R'));
}

async function loadMatrix() {
  if (matrix) return matrix;
  const result = await api.get('/v1/permissions/matrix');
  matrix = result.matrix;
  writePhaseGates = result.writePhaseGates ?? {};
  grantableRoles = result.tenantGrantableRoles ?? [];
  heldModules = result.modules ?? [];
  // The record-type classification the API authorises reads against, so a
  // screen can withhold a type this role cannot read without asking first.
  // Unclassified means ask: the server decides, and this only ever narrows what
  // is requested.
  const entityAccess = result.entityAccess ?? {};
  // The other half of the same decision: a type in an area this role reads can
  // still be Commercial-L3 or Legal-L4, and the roles cleared for each come
  // from the API too. Unpublished means cleared here and decided by the server.
  const clearance = result.sensitivityClearance ?? {};
  const sensitivityReason = (sensitivity) => {
    const cleared = sensitivity ? clearance[sensitivity] : undefined;
    if (!cleared) return null;
    const roles = state.session?.user?.roles ?? [];
    if (roles.some((role) => cleared.includes(role))) return null;
    // The server's own words for it, so the two paths read the same.
    const label = { COMMERCIAL_L3: 'Commercial-L3', LEGAL_L4: 'Legal-L4' }[sensitivity] ?? humanise(sensitivity);
    return `${label} content withheld from this role`;
  };
  setAreaReadGuard((area, sensitivity) => (area ? blockedReason(area, 'R') : null) ?? sensitivityReason(sensitivity));
  setEntityReadGuard((refType) => {
    const classification = entityAccess[refType];
    if (!classification) return null;
    const reason = blockedReason(classification.area, 'R') ?? sensitivityReason(classification.sensitivity);
    return reason ? { reason } : null;
  });
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

  // The breadcrumb names the estate the project sits in, and the demonstration
  // bootstrap used to be the only thing that supplied those two names — so every
  // sign-in through this path printed "undefined › undefined" above the work.
  // They are two ordinary tenant-scoped reads; a tenancy that has neither yet is
  // a new tenancy, and the crumb below falls back rather than inventing one.
  const [enterprise, portfolio] = await Promise.all([
    api.get('/v1/enterprises').then((r) => r.enterprises?.[0]?.name ?? null).catch(() => null),
    api.get('/v1/portfolios').then((r) => r.portfolios?.[0]?.name ?? null).catch(() => null),
  ]);

  session.set({
    ...session.get(),
    projectId: first?.id ?? first?.projectId ?? null,
    enterprise,
    portfolio,
  });
  state.session = session.get();
  state.project = null;
  state.gate = null;
  state.wallet = null;
  forgetPermissions();

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
  forgetPermissions();
  navigate(isOperator() ? 'admin' : 'overview');
}

/**
 * End the session — on the server first, then here.
 *
 * This used to clear `localStorage` and navigate away, which is not signing
 * out: the access token stayed valid on the server until it expired, so
 * anybody who had captured it still held a working session. On a site handset
 * that changes hands between operatives, "I signed out" has to mean the token
 * stops working rather than that one browser stopped presenting it.
 *
* The local half runs whatever the server says. A logout that fails because
 * the device is offline, or because the token had already expired, must still
 * take the identity off this handset — refusing to would leave somebody signed
 * in *because* the network was down, which is precisely backwards.
 */
export async function signOut() {
  try {
    // No refresh token is sent, and none is needed: the pair shares one
    // identifier, so revoking the access token ends both halves.
    await api.post('/v1/auth/logout', {});
  } catch {
    // Offline, expired, or already revoked. Nothing here changes what happens
    // next, and telling somebody their sign-out "failed" while taking them to
    // the sign-in screen is a message that describes nothing they can act on.
  }

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
 * Bind both ways out of a session.
 *
 * Two call sites render the shell — once with a skeleton before the project
 * context loads, once with it — and both bind, because somebody who decides to
 * sign out during a slow load must not have to wait for the load to finish.
 */
function bindSignOut() {
  const end = () => {
    if (confirm('Sign out of this account?')) void signOut();
  };
  document.getElementById('sign-out')?.addEventListener('click', end);
  // The chip keeps working, because people have learnt it. It is no longer the
  // only way, which is what was wrong with it.
  document.getElementById('user-chip')?.addEventListener('click', end);
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

    ${navigation().map((group) => {
      // The menu shows what you can do. Nothing else.
      //
      // It used to carry a padlock beside every capability the viewer did not
      // hold, on the argument that a lock names a colleague to ask. Measured
      // across the twelve demonstration identities, that was five locks per
      // person and eight for the planner — a third of the menu was grey
      // furniture, and it could not actually name the colleague, say which
      // permission letters were short, or mention the phase gate that is the
      // commonest reason a command is refused to somebody who *does* hold it.
      //
      // All of that is now on the Permissions screen, in full and for all
      // twenty-five capability areas rather than only the ones with a menu
      // entry. The count below is the one line the menu keeps, and it is a link
      // to the answer rather than a statement of the problem.
      const visible = group.items.filter((item) => reachable(item));
      if (visible.length === 0) return '';
      return html`<nav class="nav-group" aria-labelledby="navgroup-${raw(group.group.toLowerCase().replace(/[^a-z]+/g, '-'))}">
        <div class="nav-group-label" id="navgroup-${raw(group.group.toLowerCase().replace(/[^a-z]+/g, '-'))}">${group.group}</div>
        ${visible.map(
          (item) => html`<button class="nav-item ${raw(active === item.id ? 'active' : '')}" data-nav="${item.id}">
            ${icon(item.icon)}<span>${item.label}</span>
          </button>`,
        )}
      </nav>`;
    })}

    ${closedAreaCount() > 0
      ? html`<button class="nav-closed" data-nav="permissions">
          <span>What your role can do</span>
          <span class="n">${closedAreaCount()} areas closed</span>
        </button>`
      : ''}

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
  // Your own account is never somebody else's to grant. Asking to be erased, or
  // to see what is held about you, is not a capability in the matrix — and this
  // branch used to sit below the operator return, so the one identity that
  // administers the platform was the one identity that could not reach its own
  // account page. The mobile stores also require the route to exist for every
  // account, which it did not.
  if (item.id === 'account' || item.id === 'security') return true;
  // Communications is the platform's own event architecture — 177 events and
  // which channels actually carry them — and its catalogue is readable by any
  // authenticated identity. Hiding it from the operator was wrong: whether a
  // channel is wired to a provider is a platform operations question, and the
  // operator is the person who answers it. The delivery log inside it stays
  // the tenancy's own and is refused by name rather than shown empty.
  // Every item in the operator's own navigation is one an operator holds. The
  // filter that used to sit here was answering a different question — which of
  // the *delivery* items can an operator reach — and the answer was "almost
  // none", which is how the sidebar came to be mostly locks.
  if (isOperator()) return OPERATOR_NAV.some((group) => group.items.some((entry) => entry.id === item.id));
  if (item.area === 'PLATFORM_ADMINISTRATION') return false;
  if (item.id === 'overview' || item.id === 'copilot') return true;
  // A screen belonging to a private module is absent, not locked, for a tenancy
  // without the grant — and absent rather than locked is the whole requirement:
  // a padlock labelled "ETABLIX AI Site Services" tells somebody the module
  // exists, which is exactly what a company that has not been given it must
  // never learn. The server refuses the routes either way.
  if (item.module && !hasModule(item.module)) return false;
  return readableAreas(item).some((area) => can(area, 'R'));
}

/** Every area a screen serves — its own, plus any it also carries. */
function readableAreas(item) {
  return [item.area, ...(item.alsoArea ?? [])];
}

/**
 * Every capability area the platform enforces, taken from the matrix itself.
 *
 * Derived rather than listed, so an area added on the server appears here.
 *
 * The **union** of every role's keys, not one role's. The matrix rows are
 * sparse — a role carries only the areas it holds something on — so reading the
 * first row asks "what can this one role touch" and answers with that. It
 * reported the planner as shut out of two areas when the true number is seven,
 * and the count was the whole point of the line.
 */
export function allCapabilityAreas() {
  if (!matrix) return [];
  const areas = new Set();
  for (const row of Object.values(matrix)) for (const area of Object.keys(row)) areas.add(area);
  return [...areas];
}

/**
 * The areas this identity cannot read.
 *
 * One source of truth for two callers: the line at the foot of the navigation,
 * and the Permissions screen it opens. They quoted different numbers when each
 * counted for itself, which is worse than either number being wrong.
 */
export function closedAreas() {
  if (!matrix) return [];
  const roles = state.session?.user?.roles ?? [];
  return allCapabilityAreas().filter((area) => !roles.some((role) => (matrix[role]?.[area] ?? []).includes('R')));
}

/**
 * How many, for the navigation footer.
 *
 * Zero for an operator: their navigation is a different application with every
 * item reachable, and counting the delivery areas they are barred from would
 * offer a page about capabilities no colleague could ever grant them.
 */
function closedAreaCount() {
  if (isOperator()) return 0;
  return closedAreas().length;
}

function lockReason(item) {
  if (isOperator()) {
    return item.area === 'BILLING_ACU' || item.area === 'EVIDENCE_AUDIT'
      ? 'Operator billing and audit are estate-wide and shown on the Platform page'
      : 'Platform operators are barred from customer delivery data';
  }
  if (item.area === 'PLATFORM_ADMINISTRATION') return 'Platform administration is not visible to customer accounts';
  // Names every area that would have opened it, not just the first. "No read
  // access to SAFETY_RAMS" sends somebody to ask for the wrong thing when what
  // they actually needed was quality.
  const areas = readableAreas(item);
  return areas.length === 1
    ? `Your role has no read access to ${areas[0]}`
    : `Your role has no read access to any of ${areas.join(', ')}`;
}

function walletPercent() {
  if (!state.wallet) return 0;
  const total = state.wallet.balanceMinor || 1;
  return Math.max(2, Math.min(100, Math.round((state.wallet.availableMinor / total) * 100)));
}

/**
 * The project, and a way to change it.
 *
 * A native `<select>`, deliberately. It is the control every browser and every
 * assistive technology already knows how to operate, it works on a phone
 * without a custom sheet, and the alternative — a bespoke menu — would be a new
 * component in a design system that has one for everything it actually needs.
 *
 * The phase is on each option because it is the fact that decides what can be
 * done there: with the lifecycle gates in force, "Ashworth WTW — Operations"
 * and "Ashworth WTW — Tender" are two different sets of available commands, and
 * choosing between them blind is choosing blind.
 *
 * With one project it renders as plain text. A picker offering a single choice
 * is a control that does nothing, and it invites the press that proves it.
 */
function projectPicker() {
  const current = state.project?.name ?? (state.session?.projectId ? 'Loading…' : 'no project yet');
  const projects = state.projects ?? [];
  if (projects.length < 2) return html`<b>${current}</b>`;

  return html`<select
    class="project-pick"
    id="project-pick"
    aria-label="Project — changing this changes what you are looking at"
  >
    ${projects.map((project) => {
      const id = project.id ?? project.projectId;
      const phase = project.phase ? ` · ${humanise(project.phase)}` : '';
      return html`<option value="${id}" ${raw(id === state.session?.projectId ? 'selected' : '')}>
        ${project.name}${phase}
      </option>`;
    })}
  </select>`;
}

function topbar() {
  const user = state.session?.user;
  return html`<header class="topbar">
    <div class="crumb">
      ${
        isOperator()
          ? html`CONSTRUX <span style="opacity:.4">›</span> <b>Platform operations</b>`
          : html`${state.session?.enterprise ?? 'Your enterprise'} <span style="opacity:.4">›</span>
              ${state.session?.portfolio ?? 'no portfolio yet'}
              <span style="opacity:.4">›</span>
              ${projectPicker()}`
      }
    </div>
    <div class="spacer"></div>
    ${isOperator() ? html`<span class="phase-tag">OPERATOR</span>` : state.project ? html`<span class="phase-tag">${state.project.phase}</span>` : ''}
    <button class="user-chip" id="user-chip" aria-label="Signed in as ${user?.name ?? 'this identity'}. Sign out.">
      <span class="avatar">${
        user?.pictureHash
          ? html`<img src="/v1/users/${user.id}/picture" alt="" width="26" height="26" />`
          : initials(user?.name)
      }</span>
      <span><span class="nm">${user?.name}</span><br><span class="rl">${(user?.roles ?? []).join(', ')}</span></span>
    </button>
    <!--
      A sign-out control that says "Sign out".

      There was none. The only way to end a session was to click the name chip,
      which is a button with no label, no title and no accessible name, and
      which most people read as an account badge rather than a control. The
      words "sign out" appeared nowhere in the console — confirmed by reading
      the rendered DOM, not the source — so the honest description of the state
      was that the account could not be signed out.
    -->
    <button class="btn ghost sign-out" id="sign-out" type="button" title="Sign out of this account">
      <span aria-hidden="true">⏻</span> Sign out
    </button>
  </header>`;
}

async function loadContext() {
  // An operator has no project context to load — asking for one would be denied,
  // correctly, by the same rule that hides delivery navigation from them.
  if (isOperator()) return;

  const { projectId } = state.session;

  // A tenancy minutes old has no project, and that is a normal state rather
  // than a failure. Without this the console interpolated `undefined` into the
  // path and asked the platform for `/v1/projects/undefined` — so the first
  // thing a new customer's administrator did was generate two 404s, and the
  // wallet went unread because the rejected read took the whole `Promise.all`
  // down with it.
  if (!projectId) {
    state.project = null;
    state.gate = null;
    // The wallet needs BILLING_ACU, which most delivery roles do not hold. The
    // matrix is already loaded by this point, so the refusal is known in
    // advance and the request is not made — the same rule the command bar
    // applies, and one fewer red line in the console for every planner and
    // supervisor on every sign-in.
    state.wallet = can('BILLING_ACU', 'R') ? await api.get('/v1/billing/wallet').catch(() => null) : null;
    return;
  }

  const [detail, wallet, listed] = await Promise.all([
    api.get(`/v1/projects/${projectId}`),
    can('BILLING_ACU', 'R') ? api.get('/v1/billing/wallet').catch(() => null) : Promise.resolve(null),
    // What else this identity can open. Read here rather than at sign-in
    // because a project created during the session should appear in the picker
    // without signing out, and this already runs on every context load.
    api.get('/v1/projects').catch(() => null),
  ]);
  state.project = detail.project;
  state.gate = detail.gate;
  state.wallet = wallet;
  state.projects = listed?.projects ?? listed?.items ?? (Array.isArray(listed) ? listed : []);
}

/**
 * Move to another project.
 *
 * The console had no way to do this at all. `projectId` was chosen once at
 * sign-in — the first project the tenancy returned — and nothing could change
 * it afterwards, so a customer with three jobs could reach exactly one of them
 * and the other two were unreachable from the interface that listed them.
 *
 * It matters twice over. For a customer it is the plainest kind of missing
 * capability. For anybody evaluating the product it was worse than that,
 * because **writes are gated by lifecycle phase**: the demonstration project
 * sits in Operations, so procurement, estimating and field execution are
 * closed on it to every role, correctly, and with no way to reach a project at
 * an earlier phase the product looked like a viewer with the buttons painted
 * on.
 *
 * Everything derived from the project is dropped rather than left to be
 * noticed: the materialised project, the phase gate and the wallet all belong
 * to the one being left.
 */
export async function openProject(projectId) {
  if (!projectId || projectId === state.session?.projectId) return;
  session.set({ ...session.get(), projectId });
  state.session = session.get();
  state.project = null;
  state.gate = null;
  state.wallet = null;
  await draw();
}

async function draw() {
  state.session = session.get();
  const { page, params } = currentRoute();

  // A demonstration link carries the identity in the query string, and clicking
  // one while already signed in did nothing at all: the shell saw a session,
  // drew the console, and `login()` — the only thing that reads `as` — never
  // ran. Somebody exploring the roles would sign in as the first one and find
  // every link after it inert, which is exactly the walk the page invites.
  //
  // The link wins. It is an explicit instruction to become somebody else, so
  // the session in hand is dropped first — including the outbox, for the same
  // reason `signOut` drops it: those operations were authorised for the
  // identity leaving, and flushing them under the next one's token would put
  // one person's name on another's record.
  if (state.session && new URLSearchParams(location.search).has('as')) {
    session.clear();
    void outbox.clear();
    state.session = null;
    state.project = null;
    state.gate = null;
    state.wallet = null;
    forgetPermissions();
  }

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

  // Inside the guard, not before it. This used to sit above the try below, so a
  // 401 here escaped `draw()` entirely: no sign-out, a stored session that was
  // never cleared, and the same refusal on every load with no way out but
  // clearing browser storage by hand. The refusal is now handled like any other.
  try {
    await loadMatrix();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      signOut();
      return;
    }
    throw error;
  }

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

  bindSignOut();

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
    bindSignOut();
    // Bound after the second render, which is the one that has the project list
    // to build the picker from. The first render happens before `loadContext`
    // and shows the skeleton.
    document.getElementById('project-pick')?.addEventListener('change', (event) => {
      void openProject(event.target.value);
    });

    const navEntry = navigation().flatMap((group) => group.items).find((item) => item.id === page);
    if (navEntry && !reachable(navEntry)) {
      render(
        document.getElementById('view'),
        html`<div class="notice err"><div><b>Not authorised</b><br>${lockReason(navEntry)}.</div></div>`,
      );
      return;
    }

    // A screen about a project, and no project to be about.
    //
    // Every screen not marked `tenantScoped` reads this project's records, and
    // reaches for `state.project` to do it. A brand new tenancy has no project,
    // and the sign-in path knows that — it sends them to Enterprise & Portfolio
    // instead. What it could not cover is arriving any other way: a reload, a
    // bookmark, a link, a browser restoring the tab. The router then rendered
    // the project screen anyway, the page dereferenced a null project, and the
    // first thing a customer saw on their own platform was
    //
    //     Error
    //     TypeError: Cannot read properties of null (reading 'phase')
    //
    // A stack trace, on the landing screen, on the live site.
    //
    // Guarded once here rather than with a null check on each of twenty
    // screens: the condition is a fact about the session, not about any one
    // page, and twenty guards is nineteen chances to forget the twentieth. The
    // default is "needs a project" because that is true of the large majority,
    // and because the failure mode of the default is an empty state rather
    // than a crash.
    //
    // Operators are exempt: they hold no project by construction, and every
    // screen in their navigation is about the estate rather than a job.
    if (navEntry && !navEntry.tenantScoped && !isOperator() && !state.project) {
      render(
        document.getElementById('view'),
        html`<div class="card">
          <h2>${state.session?.projectId ? 'That project could not be opened' : 'No project on this workspace yet'}</h2>
          <p class="metric-sub" style="margin:8px 0 14px">
            ${state.session?.projectId
              ? html`<b>${navEntry.label}</b> reads a project, and this one could not be loaded. It may have been
                  removed, or your access to it withdrawn.`
              : html`<b>${navEntry.label}</b> reads a project, and there is not one here yet. A project is created
                  under an enterprise and a portfolio, and <b>Enterprise &amp; Portfolio</b> takes all three in
                  order.`}
          </p>
          <button class="btn" data-go="enterprise">Go to Enterprise &amp; Portfolio</button>
        </div>`,
      );
      document
        .querySelector('[data-go="enterprise"]')
        ?.addEventListener('click', () => navigate('enterprise'));
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

/**
 * The way back in from a device that has wedged itself.
 *
 * Three things on a browser survive a deploy and can each strand somebody with
 * no way to say so: a stored session the server will never accept again, a
 * service worker still serving the shell it installed months ago, and the
 * caches behind it. Any one of them produces the same report — "it worked
 * yesterday and now nothing loads" — and every fix for it is a devtools
 * instruction, which is useless advice for a handset in a site cabin.
 *
 * So `/app?reset=1` throws all three away and reloads. It is deliberately not a
 * button in the interface: it is destructive of queued offline work, and the
 * address bar is a high enough bar that nobody reaches it by accident while
 * meaning to sign out.
 *
 * It runs before `draw()` because a shell that cannot start is exactly the case
 * this exists for — putting it after would make the recovery depend on the
 * thing being recovered.
 */
async function resetIfAsked() {
  const asked = new URLSearchParams(window.location.search).get('reset') === '1';
  if (!asked) return false;

  // Each in its own guard: a browser with storage blocked, or no service
  // worker support, must still get the rest of the clean-up rather than
  // stopping at the first thing it cannot do.
  try {
    localStorage.clear();
  } catch {
    /* storage disabled — nothing stored, nothing to clear */
  }
  try {
    if ('serviceWorker' in navigator) {
      const workers = await navigator.serviceWorker.getRegistrations();
      await Promise.all(workers.map((worker) => worker.unregister()));
    }
  } catch {
    /* no worker to remove */
  }
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch {
    /* no cache storage */
  }

  // `replace`, not `assign`: going back to the reset URL would run it again and
  // discard whatever the person had just done.
  window.location.replace('/app');
  return true;
}

/** True once a reset has begun, so nothing else starts behind the navigation. */
let resetting = false;

void resetIfAsked().then((reset) => {
  resetting = reset;
  // A reset is navigating away. Drawing a screen, or draining the outbox under
  // a session that was just cleared, would be work against a document about to
  // be replaced — and the drain in particular would try to send queued
  // operations with no credential to send them under.
  if (reset) return undefined;

  return draw()
    .then(dismissSplash)
    // Once on load as well as on `online`: the event does not fire for an
    // application launched with signal already present, which is the common
    // case for a handset that queued work yesterday and is opened back at the
    // office.
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
    // Not while a reset is in flight: re-registering here would put a worker
    // back before the navigation that follows the unregister, which is the one
    // thing the recovery path exists to undo. The reload registers it again
    // from a clean start.
    if (resetting) return;
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
