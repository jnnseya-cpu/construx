import type { Role } from '../identity/roles.ts';

/**
 * What the newsletter says, and what it links to.
 *
 * Every entry names a capability that exists and links to the screen that
 * actually serves it. That constraint is the whole design: marketing copy is
 * the easiest thing in a codebase to invent, and a newsletter promising a
 * feature the product does not have is a defect that reaches customers before
 * it reaches a test. If a capability is partial, it is described as partial.
 *
 * Adding a feature here without the screen behind it will fail
 * `tests/newsletter.test.ts`, which checks every path against the router.
 */

export type Feature = {
  id: string;
  /** Subject-line-worthy summary. */
  title: string;
  /** What it does, in the reader's terms rather than the platform's. */
  blurb: string;
  /** Application path. Verified against the router by the test suite. */
  path: string;
  cta: string;
  /** Roles this matters most to. Empty means everyone. */
  roles: Role[];
};

/** The reader's own reason to click, chosen by role rather than by guesswork. */
export const FEATURES: Feature[] = [
  {
    id: 'autopilot',
    title: 'The agents watch the project; you decide',
    blurb:
      'Eight agents read programme, cost, risk, contracts, design, field, handover and tender data continuously, and raise what they think should happen next — each with the records it read and what happens if you decline. Nothing runs until a nominated approver approves it.',
    path: '/app/autopilot',
    cta: 'Open the approval queue',
    roles: [],
  },
  {
    id: 'programme',
    title: 'Critical path, float and a real probability of finishing on time',
    blurb:
      'Forward and backward pass with total and free float, plus a PERT distribution that gives the completion date a confidence rather than a promise. Delay forecasts carry the recovery days they assume.',
    path: '/app/programme',
    cta: 'See the critical path',
    roles: ['PLANNER', 'PM', 'EPC', 'SUPERVISOR'],
  },
  {
    id: 'commercial',
    title: 'Earned value, CVR and where the margin actually went',
    blurb:
      'CPI and SPI with three EAC scenarios, cost-value reconciliation that shows margin erosion line by line, and an S-curve built from the programme rather than drawn by hand.',
    path: '/app/commercial',
    cta: 'Open cost and value',
    roles: ['QS', 'OWNER', 'EPC', 'PM'],
  },
  {
    id: 'payments',
    title: 'Payment cycles that refuse to be paid twice',
    blurb:
      'Application, certification, payment notice and settlement with statutory dates calculated for you. The applicant cannot certify their own work, over-certification and overpayment are refused outright, and every withheld sum carries its reason.',
    path: '/app/commercial',
    cta: 'Review the payment cycle',
    roles: ['QS', 'OWNER', 'EPC'],
  },
  {
    id: 'contracts',
    title: 'Delay claims assessed with concurrency, not argued from memory',
    blurb:
      'Attribution across employer, contractor and neutral events, with concurrent delay handled explicitly. The evidence trail behind an extension of time is assembled as the claim is built.',
    path: '/app/contracts',
    cta: 'Open change and claims',
    roles: ['QS', 'PM', 'EPC', 'OWNER'],
  },
  {
    id: 'risk',
    title: 'Contingency sized at P80, not by instinct',
    blurb:
      'Expected value across the register and a P80 contingency figure you can defend in a board paper. Safety cases and RAMS sit in the same thread as the risks they control.',
    path: '/app/risk',
    cta: 'Open risk and safety',
    roles: ['SAFETY', 'PM', 'OWNER', 'EPC'],
  },
  {
    id: 'procurement',
    title: 'Bid scoring that produces the same answer twice',
    blurb:
      'Deterministic evaluation against published weightings, with penalty flags raised where a return is non-compliant. Supplier submissions stay sealed from other suppliers by construction, not by convention.',
    path: '/app/procurement',
    cta: 'Open tender and procurement',
    roles: ['QS', 'EPC', 'PM', 'OWNER'],
  },
  {
    id: 'field',
    title: 'Site records that survive no signal',
    blurb:
      'Daily records, weather, labour, plant and progress captured offline and reconciled on reconnection — device timestamps preserved, duplicates refused by operation id, conflicts resolved the same way every time. A register of plant on hire, with utilisation and standing cost derived from the diary rather than entered twice.',
    path: '/app/field',
    cta: 'Open field execution',
    roles: ['SUPERVISOR', 'PM', 'QAQC', 'SAFETY'],
  },
  {
    id: 'design',
    title: 'Drawings, revisions and the RFI that came from a markup',
    blurb:
      'A drawing register with supersession, markups that become RFIs, and model records carrying hash, discipline and LOD — an IFC read for its structure and a geometry fingerprint per element, revisions compared by GlobalId. Quantities are governed and priced against the sheet, revision or bill they came from, and a bill’s rows come off the PDF as rows.',
    path: '/app/design',
    cta: 'Open design and BIM',
    roles: ['DESIGNER', 'BIM', 'PM', 'QAQC'],
  },
  {
    id: 'handover',
    title: 'Handover that starts on day one, not at practical completion',
    blurb:
      'O&M assets, commissioning results and reliability-adjusted maintenance forecasting across a thirty-year horizon — assembled continuously, so the handover pack is a report rather than a project.',
    path: '/app/handover',
    cta: 'Open handover and O&M',
    roles: ['FM', 'QAQC', 'OWNER', 'PM'],
  },
  {
    id: 'audit',
    title: 'A Golden Thread that detects its own tampering',
    blurb:
      'Every state change is an append-only hash-chained event, journalled before it is acknowledged and shipped to Postgres behind that, where a standby can follow it live. Replay reconstructs the project from its own history and reports a root hash — so "has this record been altered" has an answer, not an opinion.',
    path: '/app/audit',
    cta: 'Open the Golden Thread',
    roles: ['REGULATOR', 'OWNER', 'QAQC', 'PM'],
  },
  {
    id: 'copilot',
    title: 'Ask the project a question in plain English',
    blurb:
      'The copilot routes your question to the engine that can answer it and shows the records behind the answer. Where it cannot answer, it says so rather than inventing a number.',
    path: '/app/copilot',
    cta: 'Ask the copilot',
    roles: [],
  },
  {
    id: 'enterprise',
    title: 'Portfolio and programme above the project line',
    blurb:
      'Enterprises, portfolios and programmes with roll-up across projects, so a board sees the same numbers the site sees rather than a re-typed version of them.',
    path: '/app/enterprise',
    cta: 'Open enterprise and portfolio',
    roles: ['OWNER', 'ENTERPRISE_ADMIN', 'PM'],
  },
  {
    id: 'billing',
    title: 'AI spend you can see before it is spent',
    blurb:
      'Every AI call is routed, reserved, executed and only then billed — prepaid, hard-capped and attributed per engine. An empty wallet stops the call rather than producing an invoice.',
    path: '/app/billing',
    cta: 'Open ACU and billing',
    roles: ['ENTERPRISE_ADMIN', 'OWNER', 'PLATFORM_ADMIN'],
  },
];

/**
 * The features to lead with for a reader, most relevant first.
 *
 * Role-targeted rather than personalised from project data: this email leaves
 * the platform's access controls behind the moment it is sent, so it carries
 * no project figures, no commercial values and nothing a recipient's role would
 * not already permit. What it personalises is which capabilities are worth
 * their attention.
 */
export function featuresFor(roles: Role[], limit = 6): Feature[] {
  const scored = FEATURES.map((feature) => ({
    feature,
    // Universal entries score 1 so they stay in the running without displacing
    // something chosen specifically for this reader.
    score: feature.roles.length === 0 ? 1 : feature.roles.filter((role) => roles.includes(role)).length * 2,
  }));

  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || FEATURES.indexOf(a.feature) - FEATURES.indexOf(b.feature))
    .slice(0, limit)
    .map((entry) => entry.feature);
}

/** Links that appear on every issue regardless of role. */
export const STANDING_LINKS: Array<{ label: string; path: string }> = [
  { label: 'Sign in', path: '/app' },
  { label: 'Project command centre', path: '/app/overview' },
  { label: 'The seven engines', path: '/#engines' },
  { label: 'How the Golden Thread works', path: '/#thread' },
  { label: 'What it costs', path: '/#pricing' },
  { label: 'See the demo', path: '/#demo' },
];
