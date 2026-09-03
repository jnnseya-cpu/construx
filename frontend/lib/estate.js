import { html, humanise, money, raw } from './ui.js';

/**
 * The formatting the operator console shares.
 *
 * Extracted from `admin.js` when that one screen became a console of
 * twenty-five, so the same number is written the same way on every one of them.
 * Formatting only — nothing here fetches, decides or authorises. A helper that
 * did any of those would be a second place the operator surface makes decisions,
 * and there is already one.
 */

/** `2026-08-26` → `26 Aug`, for a chart axis. */
export function axisDay(iso) {
  const at = new Date(`${iso}T00:00:00Z`);
  return `${at.getUTCDate()} ${at.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`;
}

/**
 * Bytes as the operator reads them. Storage is quoted in GB in the contract.
 *
 * Above a terabyte it is quoted in terabytes: an Enterprise tenancy commits four
 * thousand GB on the day it signs, and a four-figure GB number is misread at a
 * glance.
 */
export function gb(bytes) {
  const value = (bytes ?? 0) / 1_000_000_000;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)} TB`;
  return `${value < 10 ? value.toFixed(2) : Math.round(value)} GB`;
}

/**
 * How a provider is written down.
 *
 * The ledger stores the routing token. `humanise` would render `OPENAI` as
 * "Openai", which is nobody's name for it — these are vendors on an invoice and
 * are spelled the way they spell themselves.
 */
const PROVIDER_NAMES = {
  OPENAI: 'OpenAI',
  GEMINI: 'Google Gemini',
  ANTHROPIC: 'Anthropic Claude',
  UNATTRIBUTED: 'Unattributed',
};

export const providerName = (token) => PROVIDER_NAMES[token] ?? humanise(token);

/**
 * How much AI service a tenancy has left, in the unit that means something.
 *
 * Runway is credit divided by daily burn, so a tenancy that spends almost
 * nothing produces a number in the tens of thousands of days. That is
 * arithmetically correct and operationally meaningless — sixty-six years of
 * credit is not a fact anybody acts on. Beyond the window the balance itself is
 * the honest statement.
 */
export function runway(tenant, windowDays) {
  if (tenant.runwayDays === null) return `${money(tenant.availableMinor)} available · not spending`;
  if (tenant.runwayDays > windowDays) return `${money(tenant.availableMinor)} available · beyond ${windowDays} days at this rate`;
  return `${money(tenant.availableMinor)} available · ${tenant.runwayDays} day${tenant.runwayDays === 1 ? '' : 's'} left at this rate`;
}

/**
 * A month-on-month movement, or nothing.
 *
 * Withheld where the previous month recorded nothing: a rise from zero is not a
 * percentage, and rendering one as `+100%` or `+∞%` describes a first sale as
 * growth.
 */
export function movement(current, previous) {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}

/**
 * The environment report, grouped the way an operator thinks about it.
 *
 * By what a variable is *for*, not by its prefix — somebody setting up mail
 * looks for the mail block, and `SMTP_*`, `NOTIFICATIONS_*` and `NEWSLETTER_*`
 * are all in it. Presentation only: the report itself is a flat list, and
 * anything a rule below does not claim lands in "Everything else" rather than
 * disappearing, because a variable nobody can find is the bug this exists to
 * catch.
 */
export function envGroups(vars) {
  const rules = [
    ['AI providers', /^(AI_|OPENAI|GEMINI|ANTHROPIC)/],
    ['Payments — card', /^STRIPE_/],
    ['Payments — mobile money', /^KODA_/],
    ['Email and messaging', /^(SMTP_|NOTIFICATIONS_|NEWSLETTER_)/],
    ['Identity and gateway', /^GATEWAY_/],
    ['Record and evidence', /^(LEDGER_|EVIDENCE_|SIGNING_)/],
    ['Commercial rules', /^(ACU_|STORAGE_|MAXIMUM_|FREE_TRIAL|TRIALS_)/],
    ['Platform and site', /^(PLATFORM_|PUBLIC_|SITE_|ANALYTICS_|NODE_ENV|PORT|ERASURE_)/],
  ];

  const claimed = new Set();
  const groups = rules
    .map(([label, pattern]) => {
      const matched = vars.filter((v) => pattern.test(v.key));
      for (const v of matched) claimed.add(v.key);
      return { label, vars: matched };
    })
    .filter((group) => group.vars.length > 0);

  const rest = vars.filter((v) => !claimed.has(v.key));
  return rest.length > 0 ? [...groups, { label: 'Everything else', vars: rest }] : groups;
}

/**
 * The standard head of an operator screen.
 *
 * One shape across twenty-five screens, so that "what is this page" is answered
 * in the same place every time. The intent line is not decoration: several of
 * these screens report numbers that are easy to read as something they are not,
 * and the sentence under the title is where that gets said.
 */
export function head({ title, intent, actions }) {
  return html`<div class="view-head">
    <div>
      <h1>${title}</h1>
      ${intent ? html`<p>${intent}</p>` : ''}
    </div>
    ${actions ? html`<div class="actions cmd-bar">${raw(actions)}</div>` : ''}
  </div>`;
}

/**
 * A refusal, rendered as a refusal.
 *
 * Every operator read on these screens can fail — a route can be denied, a
 * position can throw — and the failure has to look different from an empty
 * register. "You may not see this" and "there is nothing here" are different
 * answers and this console shows them differently.
 */
export function refusal(what, error) {
  // Denied and failed are different answers too. A refusal is the permission
  // model working and is said quietly; a failure stays red. The same split
  // `positionReport` makes on the delivery screens.
  if (error?.status === 403) {
    return html`<div class="notice">
      <div>
        <b>${what} is outside your role</b><br />
        ${error?.message ?? String(error)}
      </div>
    </div>`;
  }
  return html`<div class="notice err">
    <div>
      <b>${what} could not be read</b><br />
      ${error?.code ? html`<span class="mono">${error.code}</span> — ` : ''}${error?.message ?? String(error)}
    </div>
  </div>`;
}
