import { api } from '../lib/api.js';
import { barChart, lineChart } from '../lib/chart.js';
import { command } from '../lib/command.js';
import { badge, date, html, humanise, money, pct, raw, render, table, time, toast, track } from '../lib/ui.js';
import { state } from '../app.js';

/**
 * The platform command centre.
 *
 * Deliberately narrow in *scope* and complete in *depth*. A platform operator
 * manages tenancy, money and system health — and cannot see projects, packages
 * or daily logs. That separation is enforced in ABAC, not in this page's markup,
 * so nothing here needs to hide delivery data: it is not reachable with these
 * roles at all.
 *
 * Within that boundary this screen is the whole job. It was previously a read of
 * four counters and two tables, which meant every operational question — how
 * much came in this month, which tenancy is about to lose AI service, is a
 * payment rail silently rejecting webhooks, who is being denied at the gateway —
 * had to be answered somewhere other than the console. Every figure below is
 * counted from a record the platform already holds. Where there is no history
 * there is no number, and the panel says so rather than rendering a zero, since
 * zero is a claim and "no data yet" is not.
 *
 * Every write route on the operator surface has a door here: onboard a tenancy,
 * change a subscription status, credit a wallet against a received payment, and
 * appoint another operator. A route with no door is a feature only its author
 * can use.
 */

/** `2026-08-26` → `26 Aug`, for a chart axis. */
function axisDay(iso) {
  const at = new Date(`${iso}T00:00:00Z`);
  return `${at.getUTCDate()} ${at.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`;
}

/** Bytes as the operator reads them. Storage is quoted in GB in the contract. */
function gb(bytes) {
  const value = (bytes ?? 0) / 1_000_000_000;
  // An Enterprise tenancy commits four thousand GB on the day it signs, and a
  // four-figure GB number is read wrongly at a glance. Above a terabyte it is
  // quoted in terabytes, which is the unit the contract uses at that size.
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
const PROVIDER_NAMES = { OPENAI: 'OpenAI', GEMINI: 'Google Gemini', ANTHROPIC: 'Anthropic Claude', UNATTRIBUTED: 'Unattributed' };
const providerName = (token) => PROVIDER_NAMES[token] ?? humanise(token);

/**
 * How much AI service a tenancy has left, said in the unit that means something.
 *
 * Runway is available credit divided by daily burn, so a tenancy that spends
 * almost nothing produces a number in the tens of thousands of days. That is
 * arithmetically correct and operationally meaningless — sixty-six years of
 * credit is not a fact anybody acts on. Beyond the window the balance itself is
 * the honest statement.
 */
function runway(tenant, windowDays) {
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
function movement(current, previous) {
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
function envGroups(vars) {
  const rules = [
    ['AI providers', /^(AI_|OPENAI|GEMINI|ANTHROPIC)/],
    ['Payments — card', /^STRIPE_/],
    ['Payments — mobile money', /^KODA_/],
    ['Email and messaging', /^(SMTP_|NOTIFICATIONS_|NEWSLETTER_)/],
    ['Identity and gateway', /^GATEWAY_/],
    ['Record and evidence', /^(LEDGER_|EVIDENCE_|SIGNING_)/],
    ['Commercial rules', /^(ACU_|STORAGE_|MAXIMUM_|FREE_TRIAL|TRIALS_)/],
    ['Platform and site', /^(PLATFORM_|PUBLIC_|ANALYTICS_|NODE_ENV|PORT|ERASURE_)/],
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
 * The pictures on the landing page.
 *
 * Five slots have been on that page since it was built, and until now the only
 * way to fill one was to copy a file into the checkout and restart the process
 * — which on a deployed container is a rebuild. The pictures could not be put
 * there by the person whose pictures they are.
 *
 * Each slot shows what it is for and what it has to show, because a picture
 * chosen without knowing where it lands is a picture that has to be replaced.
 * An empty slot is stated as empty: the page renders nothing at all for one, so
 * there is no broken frame on the site to notice it by.
 */
function mediaPanel(media) {
  return html`<div class="card" id="site-media" style="margin-bottom:14px">
    <h2>Pictures on the landing page</h2>
    <p class="metric-sub" style="margin:8px 0 14px">
      Five slots. A slot with no picture renders nothing at all — no empty frame — so the page is never broken by one
      being absent. Export at the size given and compress; the ceiling is ${Math.round(media.maxBytes / 1_048_576)}MB per
      picture. PNG, JPEG or WebP, read from the file itself rather than from its name.
    </p>

    <div class="split-list">
      ${media.slots.map(
        (slot) => html`<div class="row" data-slot="${slot.id}" style="align-items:flex-start;gap:14px">
          <!-- A zero flex-basis with min-width 0, so the description column
               shrinks and every row's buttons land in the same place. On an
               auto basis the longest description pushed its own buttons onto a
               second line while the shorter rows kept theirs on one. -->
          <span class="lbl" style="flex:1 1 0;min-width:0">
            <b>${slot.where}</b><br>
            <span class="metric-sub">${slot.alt}</span><br>
            <span class="metric-sub">${slot.width}×${slot.height}px · ${
              slot.held
                ? `${slot.file} · ${Math.round((slot.bytes ?? 0) / 1024)}KB · replaced ${time(slot.updatedAt)}`
                : 'nothing here yet'
            }</span>
          </span>
          <span class="val" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            ${slot.held ? badge('filled', 'ok') : badge('empty', 'warn')}
            <label class="btn quiet sm" style="cursor:pointer">
              ${slot.held ? 'Replace' : 'Add picture'}
              <input type="file" accept="image/png,image/jpeg,image/webp" data-put="${slot.id}" style="display:none">
            </label>
            ${slot.held ? html`<button class="btn quiet sm" data-clear="${slot.id}">Remove</button>` : ''}
          </span>
        </div>`,
      )}
    </div>

    <div class="cmd-error" hidden style="margin-top:12px"></div>
    <div class="metric-sub" style="margin-top:12px">
      Held in <span class="mono">${media.directory}</span>. Point <span class="mono">SITE_MEDIA_PATH</span> at the volume
      and an uploaded picture survives a redeploy; leave it unset and it lives in the checkout, where it does not.
    </div>
  </div>`;
}

export async function admin(root) {
  const roles = state.session.user.roles ?? [];
  const isOperator = roles.includes('PLATFORM_ADMIN');
  const operatorOnly = (path) => (isOperator ? api.get(path).catch(() => null) : Promise.resolve(null));

  const [routes, plane, matrix, overview, estate, burn, payments, security, logs, ready, governance, vocab, media] =
    await Promise.all([
      api.get('/v1/routes').catch(() => ({ routes: [] })),
      api.get('/v1/ai/control-plane').catch(() => null),
      api.get('/v1/permissions/matrix').catch(() => ({ matrix: {} })),
      operatorOnly('/v1/admin/overview'),
      operatorOnly('/v1/admin/tenants'),
      operatorOnly('/v1/admin/burn'),
      operatorOnly('/v1/admin/payments'),
      operatorOnly('/v1/admin/security'),
      operatorOnly('/v1/admin/logs'),
      operatorOnly('/v1/admin/readiness'),
      operatorOnly('/v1/admin/audit'),
      // Jurisdictions and currencies for the onboarding form, published by the
      // platform rather than listed here — so the console cannot offer a
      // jurisdiction the tax engine does not know.
      operatorOnly('/v1/signup/account-types'),
      // The landing page's own pictures. Operator-only in both directions: a
      // customer has no business editing the marketing site.
      operatorOnly('/v1/site/media'),
    ]);

  const areas = new Set();
  for (const entry of Object.values(matrix.matrix)) {
    for (const area of Object.keys(entry)) areas.add(area);
  }
  const orderedAreas = [...areas].sort();
  const orderedRoles = Object.keys(matrix.matrix);

  const mtdMovement = overview ? movement(overview.revenue.monthToDateMinor, overview.revenue.previousMonthMinor) : null;
  const tenantsById = new Map((estate?.tenants ?? []).map((tenant) => [tenant.id, tenant]));

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>${isOperator ? 'Command centre' : 'Platform'}</h1>
          <p>${
            isOperator
              ? overview
                ? `${overview.tenancies.total} tenanc${overview.tenancies.total === 1 ? 'y' : 'ies'} · ${overview.identities.active} active ${overview.identities.active === 1 ? 'identity' : 'identities'} · ${overview.identities.operators} operator${overview.identities.operators === 1 ? '' : 's'}`
                : 'Tenancy, money and system health.'
              : 'You are signed in as a customer account, so operator controls are not available to you.'
          }</p>
        </div>
        ${
          isOperator
            ? html`<div class="actions">
                <button class="btn" id="onboard-tenant">Onboard a tenancy</button>
                <button class="btn quiet" id="appoint-operator">Appoint an operator</button>
              </div>`
            : ''
        }
      </div>

      ${
        !isOperator
          ? html`<div class="notice info">
              <div><b>Account-layer separation.</b><br>
              Platform operators manage tenants, billing and global configuration and cannot see project delivery data.
              Customer accounts cannot see platform administration. The read below is what your role is permitted.</div>
            </div>`
          : ''
      }

      ${
        overview
          ? html`
              <div class="grid g4" style="margin-bottom:14px">
                <div class="card">
                  <h2>Revenue — today</h2>
                  <div class="metric">${money(overview.revenue.todayMinor)}</div>
                  <div class="metric-sub">${overview.revenue.receipts} receipt${overview.revenue.receipts === 1 ? '' : 's'} recorded in total</div>
                </div>
                <div class="card">
                  <h2>Revenue — month to date</h2>
                  <div class="metric ${raw(mtdMovement === null ? '' : mtdMovement >= 0 ? 'good' : 'warn')}">${money(overview.revenue.monthToDateMinor)}</div>
                  <div class="metric-sub">${
                    mtdMovement === null
                      ? 'no revenue last month to compare against'
                      : `${mtdMovement >= 0 ? '+' : ''}${pct(mtdMovement, 1)} against ${money(overview.revenue.previousMonthMinor)} last month`
                  }</div>
                </div>
                <div class="card">
                  <h2>Revenue — lifetime</h2>
                  <div class="metric orange">${money(overview.revenue.lifetimeMinor)}</div>
                  <div class="metric-sub">every settled payment since launch</div>
                </div>
                <div class="card">
                  <h2>Awaiting payment</h2>
                  <div class="metric ${raw(overview.awaitingPayment.count > 0 ? 'info' : '')}">${money(overview.awaitingPayment.amountMinor)}</div>
                  <div class="metric-sub">${overview.awaitingPayment.count} top-up${overview.awaitingPayment.count === 1 ? '' : 's'} raised and unsettled</div>
                </div>
              </div>

              <div class="grid g4" style="margin-bottom:14px">
                <div class="card">
                  <h2>Tenancies</h2>
                  <div class="metric ${raw(overview.tenancies.unreachable > 0 ? 'bad' : '')}">${overview.tenancies.total}</div>
                  <div class="metric-sub">
                    ${overview.tenancies.active} active · ${overview.tenancies.onTrial} on trial ·
                    ${overview.tenancies.suspended} suspended · ${overview.tenancies.cancelled} cancelled
                    ${
                      overview.tenancies.unreachable > 0
                        ? html`<br><b>${overview.tenancies.unreachable} with no administrator — nobody can run them</b>`
                        : ''
                    }
                  </div>
                </div>
                <div class="card">
                  <h2>New in 30 days</h2>
                  <div class="metric ${raw(overview.tenancies.newInWindow > 0 ? 'good' : '')}">${overview.tenancies.newInWindow}</div>
                  <div class="metric-sub">tenancies onboarded</div>
                </div>
                <div class="card">
                  <h2>Seats assigned</h2>
                  <div class="metric">${overview.identities.seatsUsed}${overview.identities.seatsIncluded === null ? '' : ` / ${overview.identities.seatsIncluded}`}</div>
                  <div class="metric-sub">${
                    overview.identities.seatsIncluded === null
                      ? 'an uncapped tier is on the estate, so there is no estate ceiling to report'
                      : `${overview.identities.total} identit${overview.identities.total === 1 ? 'y' : 'ies'} across the estate`
                  }</div>
                </div>
                <div class="card">
                  <h2>Run-rate — this month</h2>
                  <div class="metric">${overview.revenue.runRateMinor === null ? '—' : money(overview.revenue.runRateMinor)}</div>
                  <div class="metric-sub">${
                    overview.revenue.runRateBasis
                      ? `${money(overview.revenue.runRateBasis.monthToDateMinor)} ÷ ${overview.revenue.runRateBasis.elapsedDays} days × ${overview.revenue.runRateBasis.daysInMonth} — arithmetic, not a forecast`
                      : 'withheld: too little of the month has elapsed to extrapolate honestly'
                  }</div>
                </div>
              </div>
            `
          : ''
      }

      ${
        burn
          ? html`<div class="grid g-2-1" style="margin-bottom:14px">
              <div class="card chart-card">
                <h2>AI charged, provider cost and margin — last ${burn.windowDays} days</h2>
                <div class="metric-sub" style="margin-bottom:12px">
                  What the estate was charged for AI against what the providers cost. Subscription revenue is not in
                  this line — it is in the tiles above.
                </div>
                ${lineChart({
                  labels: burn.daily.map((day) => axisDay(day.date)),
                  series: [
                    { label: 'Charged', points: burn.daily.map((day) => day.billedMinor) },
                    { label: 'Provider cost', points: burn.daily.map((day) => day.rawCostMinor) },
                    { label: 'Margin', points: burn.daily.map((day) => day.marginMinor) },
                  ],
                  format: (value) => money(value),
                  empty: 'No AI spend in this window',
                })}
              </div>
              <div class="card">
                <h2>Estate position</h2>
                <div class="split-list">
                  <div class="row"><span class="lbl">Charged</span><span class="val">${money(burn.billedMinor)}</span></div>
                  <div class="row"><span class="lbl">Provider cost</span><span class="val">${money(burn.rawCostMinor)}</span></div>
                  <div class="row"><span class="lbl">Margin</span><span class="val">${money(burn.marginMinor)}</span></div>
                  <div class="row"><span class="lbl">Per day</span><span class="val">${money(burn.dailyBurnMinor)}</span></div>
                  <div class="row"><span class="lbl">ACU consumed</span><span class="val">${burn.acuUnits.toLocaleString('en-GB')}</span></div>
                  <div class="row"><span class="lbl">Realised multiplier</span><span class="val">${
                    burn.realisedMultiplier === null ? '—' : `${burn.realisedMultiplier}x`
                  }</span></div>
                  <div class="row"><span class="lbl">Absorbed</span><span class="val">${
                    burn.absorbedMinor > 0 ? money(burn.absorbedMinor) : '—'
                  }</span></div>
                  <div class="row"><span class="lbl">Concentration</span><span class="val">${
                    burn.concentration === null ? '—' : pct(burn.concentration * 100, 0)
                  }</span></div>
                </div>
                <div class="metric-sub" style="margin-top:12px">
                  Absorbed margin is an estimation-quality signal, not a leak: a charge is capped at the amount held,
                  so a customer is never billed above what was reserved and disclosed.
                </div>
              </div>
            </div>`
          : ''
      }

      ${
        burn
          ? html`<div class="grid g2" style="margin-bottom:14px">
              <div class="card">
                <h2>Where the AI spend went</h2>
                <div class="metric-sub" style="margin-bottom:12px">
                  Realised routing split — computed from what was charged, not from the configured routing table. The
                  two differ every time a provider is unhealthy and traffic fails over.
                </div>
                ${barChart({
                  bars: burn.providers.map((provider) => ({
                    label: providerName(provider.provider),
                    sub: `${provider.executions} execution${provider.executions === 1 ? '' : 's'} · ${pct(provider.share * 100, 1)}`,
                    value: provider.billedMinor,
                  })),
                  format: (value) => money(value),
                  empty: 'No AI spend in this window',
                })}
              </div>
              <div class="card">
                <h2>Heaviest tenancies</h2>
                <div class="metric-sub" style="margin-bottom:12px">By AI charged over the window, largest first.</div>
                ${barChart({
                  bars: burn.tenants
                    .filter((tenant) => tenant.billedMinor > 0)
                    .slice(0, 5)
                    .map((tenant) => ({
                      label: tenant.legalName,
                      sub: runway(tenant, burn.windowDays),
                      value: tenant.billedMinor,
                      tone: tenant.runwayDays !== null && tenant.runwayDays <= 7 ? 'bad' : tenant.runwayDays !== null && tenant.runwayDays <= burn.windowDays ? 'warn' : '',
                    })),
                  format: (value) => money(value),
                  empty: 'No tenancy has spent in this window',
                })}
                <div class="metric-sub" style="margin-top:12px">
                  ${
                    burn.runningOut.length > 0
                      ? html`<b>${burn.runningOut.length} tenanc${burn.runningOut.length === 1 ? 'y' : 'ies'} lose AI service inside the window</b>
                          at the current rate: ${burn.runningOut.map((t) => `${t.legalName} (${t.runwayDays}d)`).join(', ')}.`
                      : 'No tenancy runs out of credit inside the window at its current rate.'
                  }
                </div>
              </div>
            </div>`
          : ''
      }

      <div class="grid g3" style="margin-bottom:14px">
        <div class="card">
          <h2>AI engines</h2>
          <div class="metric ${raw(plane?.mode === 'local' ? 'info' : 'good')}">${
            plane ? `${(plane.available ?? []).filter((p) => p.healthy).length} of ${(plane.available ?? []).length} live` : '—'
          }</div>
          <div class="metric-sub" style="margin-bottom:12px">mode: ${plane?.mode ?? '—'}</div>
          <div class="split-list">
            ${(plane?.available ?? []).map(
              (provider) => html`<div class="row">
                <span class="lbl">${providerName(provider.provider)}</span>
                <span class="val">${badge(humanise(provider.role), provider.role === 'FAILOVER' ? 'info' : 'ai')} ${badge(
                  provider.healthy ? 'live' : 'unhealthy',
                  provider.healthy ? 'ok' : 'bad',
                )}</span>
              </div>`,
            )}
          </div>
          <div class="metric-sub" style="margin-top:12px">
            A provider appears here only when it is keyed. A failover engine is one nothing routes to until a primary
            fails — it is still a vendor the platform can spend money with.
          </div>
        </div>

        ${
          payments
            ? html`<div class="card">
                <h2>Payment rails</h2>
                <div class="metric ${raw(
                  payments.cardPayments.webhook.rejected > 0 && payments.cardPayments.webhook.accepted === 0 ? 'bad' : '',
                )}">${[payments.cardPayments.configured, payments.mobileMoney.configured].filter(Boolean).length} of 2 keyed</div>
                <div class="metric-sub" style="margin-bottom:12px">card and mobile money</div>
                <div class="split-list">
                  <div class="row"><span class="lbl">Card — configured</span><span class="val">${badge(
                    payments.cardPayments.configured ? 'yes' : 'no',
                    payments.cardPayments.configured ? 'ok' : 'warn',
                  )}</span></div>
                  <div class="row"><span class="lbl">Card — webhooks accepted</span><span class="val">${payments.cardPayments.webhook.accepted}</span></div>
                  <div class="row"><span class="lbl">Card — webhooks rejected</span><span class="val">${payments.cardPayments.webhook.rejected}</span></div>
                  <div class="row"><span class="lbl">Mobile money — configured</span><span class="val">${badge(
                    payments.mobileMoney.configured ? 'yes' : 'no',
                    payments.mobileMoney.configured ? 'ok' : 'warn',
                  )}</span></div>
                  <div class="row"><span class="lbl">Mobile money — accepted</span><span class="val">${payments.mobileMoney.webhook.accepted}</span></div>
                  <div class="row"><span class="lbl">Mobile money — rejected</span><span class="val">${payments.mobileMoney.webhook.rejected}</span></div>
                  <div class="row"><span class="lbl">USD per GBP</span><span class="val">${payments.mobileMoney.usdPerGbp}</span></div>
                </div>
                <div class="metric-sub" style="margin-top:12px">
                  ${
                    payments.cardPayments.webhook.rejected > 0 && payments.cardPayments.webhook.accepted === 0
                      ? html`<b>Every card webhook so far has been rejected.</b> A signing secret can be present and
                          wrong — customers pay, deliveries are refused, and nothing is credited. Check the secret
                          against the endpoint in the provider dashboard.`
                      : 'A webhook secret can be present and wrong. Rejections climbing while acceptances stay at zero is that, and nothing else.'
                  }
                </div>
              </div>`
            : ''
        }

        ${
          estate?.estate
            ? html`<div class="card">
                <h2>Storage across the estate</h2>
                <div class="metric ${raw(estate.estate.atLimit > 0 ? 'bad' : estate.estate.atWarning > 0 ? 'warn' : '')}">${gb(estate.estate.heldBytes)}</div>
                <div class="metric-sub" style="margin-bottom:12px">held against ${gb(estate.estate.committedBytes)} committed</div>
                ${track(
                  estate.estate.committedBytes > 0 ? (estate.estate.heldBytes / estate.estate.committedBytes) * 100 : 0,
                  estate.estate.atLimit > 0 ? 'bad' : estate.estate.atWarning > 0 ? 'warn' : '',
                )}
                <div class="split-list" style="margin-top:12px">
                  <div class="row"><span class="lbl">Tenancies</span><span class="val">${estate.estate.tenancies}</span></div>
                  <div class="row"><span class="lbl">At warning</span><span class="val">${estate.estate.atWarning}</span></div>
                  <div class="row"><span class="lbl">At limit</span><span class="val">${estate.estate.atLimit}</span></div>
                </div>
                <div class="metric-sub" style="margin-top:12px">
                  Committed is what the platform has promised, and it arrives the day a tenancy signs rather than as it
                  uploads. The volume has to stay ahead of held, with headroom.
                </div>
              </div>`
            : ''
        }
      </div>

      ${media ? mediaPanel(media) : ''}

      ${
        ready
          ? html`<div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">
                System control — what this deployment actually has configured
                ${
                  ready.blocking.length > 0
                    ? badge(`${ready.blocking.length} blocking go-live`, 'bad')
                    : ready.degraded > 0
                      ? badge(`${ready.degraded} half-configured`, 'warn')
                      : badge('production-ready', 'ok')
                }
              </h2>
              <div class="metric-sub" style="padding:0 17px 10px">
                ${ready.configured} of ${ready.capabilities.length} capabilities configured · environment
                <b>${ready.variables}</b>. Read from this running process, not from a checklist. Every rail is set with
                environment variables on the server, never from this screen — and this screen reports whether a value is
                set, never what it is.
              </div>
              ${
                ready.blocking.length > 0
                  ? html`<div style="padding:0 17px 12px"><div class="notice bad">
                      <div><b>Not fit to hold a paying customer yet.</b><br>
                      ${ready.blocking.join(' · ')} — each of these is a capability the platform cannot do without.</div>
                    </div></div>`
                  : ''
              }
              ${table({
                headers: ['Capability', 'State', 'What that means right now', 'Set with'],
                rows: ready.capabilities.map((capability) => [
                  html`${capability.label}${capability.critical ? badge('critical', 'warn') : ''}`,
                  badge(
                    capability.state === 'CONFIGURED' ? 'configured' : capability.state === 'DEGRADED' ? 'half-configured' : 'not set',
                    capability.state === 'CONFIGURED' ? 'ok' : capability.state === 'DEGRADED' ? 'bad' : 'neutral',
                  ),
                  capability.detail,
                  html`<span class="mono" style="font-size:10.5px;color:var(--text-3)">${capability.env.join(' · ')}</span>`,
                ]),
              })}
              ${
                ready.warnings.length > 0
                  ? html`<div style="padding:12px 17px 15px">
                      <div class="metric-sub" style="margin-bottom:8px"><b>Boot warnings</b> — what this process said about itself when it started</div>
                      <div class="split-list">
                        ${ready.warnings.map((warning) => html`<div class="row"><span class="lbl">${warning}</span></div>`)}
                      </div>
                    </div>`
                  : html`<div style="padding:12px 17px 15px"><div class="metric-sub">
                      This process raised no configuration warning at boot.
                    </div></div>`
              }
            </div>`
          : ''
      }

      ${
        ready
          ? html`<div class="card" style="margin-bottom:14px">
              <details>
                <summary>Runtime environment — what this process actually received
                  <span class="metric-sub">${ready.variables.filter((v) => v.present).length} of ${ready.variables.length} variables set</span>
                </summary>
                <div class="details-body">
                  <div class="metric-sub" style="margin-bottom:12px">
                    Every variable this build reads, registered by the readers themselves so the list cannot go stale.
                    <b>“not set” means this running server received no value under that exact name</b> — if you set it on the
                    server and it still reads not set, check the spelling, that it is in the file the process loaded, and that
                    the container was recreated afterwards. Secret values are never shown; their length is, because a key
                    truncated by a paste looks correct from every other angle and its length does not.
                  </div>
                  ${envGroups(ready.variables).map(
                    (group) => html`<div style="margin-bottom:14px">
                      <div class="metric-sub" style="margin-bottom:6px"><b>${group.label}</b></div>
                      ${table({
                        headers: ['Variable', 'State', 'Value'],
                        rows: group.vars.map((v) => [
                          html`<span class="mono" style="font-size:11px">${v.key}</span>`,
                          v.present ? badge('set', 'ok') : badge('not set', 'neutral'),
                          v.present
                            ? v.secret
                              ? html`<span class="metric-sub">hidden · ${v.length} character${v.length === 1 ? '' : 's'}</span>`
                              : html`<span class="mono" style="font-size:11px">${v.value}</span>`
                            : html`<span class="metric-sub">—</span>`,
                        ]),
                      })}
                    </div>`,
                  )}
                </div>
              </details>
            </div>`
          : ''
      }

      ${
        estate
          ? html`<div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">Tenant governance</h2>
              <div class="metric-sub" style="padding:0 17px 10px">
                Commercial terms and credit only. An operator cannot open a project, a package or a daily log from
                here — the account layer is enforced in ABAC, not in this page's markup.
              </div>
              ${table({
                headers: ['Tenant', 'Tier', 'Status', 'People', 'Seats', 'Lifetime revenue', 'ACU available', 'Renews', ''],
                align: ['', '', '', 'num', 'num', 'num', 'num', '', ''],
                rows: (estate.tenants ?? []).map((t) => [
                  html`${t.legalName}<div class="metric-sub">${t.jurisdiction} · ${
                    t.isolatedTenancy ? 'dedicated tenancy' : 'shared tenancy'
                  }</div>`,
                  badge(t.tier, t.tier === 'ENTERPRISE' || t.tier === 'SOVEREIGN' ? 'ai' : 'info'),
                  badge(t.status, t.status === 'ACTIVE' ? 'ok' : 'warn'),
                  // A tenancy with no administrator can invite nobody and be
                  // configured by nobody, whatever it is paying. Onboarding now
                  // makes that impossible, and it is shown so an older tenancy
                  // in that state cannot hide.
                  t.administrators === 0
                    ? badge('no administrator', 'bad')
                    : `${t.identities} (${t.administrators} admin${t.administrators === 1 ? '' : 's'})`,
                  `${t.seatsUsed} / ${t.seatsIncluded ?? '∞'}`,
                  money(t.lifetimeRevenueMinor),
                  money(t.wallet.availableMinor),
                  date(t.renewsAt),
                  html`<button class="btn quiet sm" data-credit="${t.id}">Credit</button>
                    <button class="btn quiet sm" data-status="${t.id}">Status</button>`,
                ]),
                empty: 'No tenancy on the estate yet',
              })}
            </div>`
          : ''
      }

      ${
        governance
          ? html`<div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">
                Governance record — every act an operator is accountable for
                ${governance.intact ? badge('chain intact', 'ok') : badge('CHAIN BROKEN', 'bad')}
              </h2>
              <div class="metric-sub" style="padding:0 17px 10px">
                ${governance.total} event${governance.total === 1 ? '' : 's'} across
                ${governance.chains.length} chain${governance.chains.length === 1 ? '' : 's'}.
                A tenancy opened, an identity created, a seat assigned, a subscription suspended, a payment received,
                a wallet credited. Delivery work is written to its own project and is not reachable from here —
                that boundary is the shape of the record, not a filter on this page.
                <b>${governance.intact ? 'Verified by walking every chain on this request' : 'A chain failed verification'}</b>,
                not asserted.
              </div>
              ${
                !governance.intact
                  ? html`<div style="padding:0 17px 12px"><div class="notice bad">
                      <div><b>A governance chain failed verification.</b><br>
                      ${governance.chains
                        .filter((c) => c.failures > 0)
                        .map((c) => `${c.tenant}: ${c.failures} event${c.failures === 1 ? '' : 's'}`)
                        .join(' · ')}.
                      An event has been altered, deleted or reordered. Treat the affected record as unreliable until
                      it is investigated.</div>
                    </div></div>`
                  : ''
              }
              ${table({
                headers: ['When', 'Act', 'Tenant', 'On', 'By', 'Chain'],
                rows: (governance.events ?? []).slice(0, 25).map((event) => [
                  time(event.timestamp),
                  humanise(event.eventType),
                  event.tenant,
                  `${humanise(event.entity.refType)}`,
                  event.actor?.refType === 'System' ? badge('system', 'info') : (event.actor?.refId ?? '—'),
                  html`<span class="mono" style="font-size:10.5px;color:var(--text-3)">${
                    event.chainHash ? `${event.chainHash.slice(0, 12)}…` : '—'
                  }</span>`,
                ]),
                empty: 'No governance act recorded yet',
              })}
              <div style="padding:12px 17px 15px"><div class="metric-sub">
                Append-only. Nothing here is edited or deleted — a correction is a new event, and the chain hash makes
                a deletion or a reordering detectable rather than merely forbidden.
              </div></div>
            </div>`
          : ''
      }

      ${
        security
          ? html`<div class="grid g2" style="margin-bottom:14px">
              <div class="card">
                <h2>Security stream</h2>
                <div class="metric ${raw(security.summary.repeatSources.length > 0 ? 'warn' : '')}">${security.summary.total}</div>
                <div class="metric-sub" style="margin-bottom:12px">auth failures, denials, rate limits and admin access recorded at the gateway</div>
                ${
                  Object.keys(security.summary.byKind).length === 0
                    ? html`<div class="empty"><b>Nothing recorded</b>No refusal has reached the gateway yet.</div>`
                    : html`<div class="split-list">
                        ${Object.entries(security.summary.byKind).map(
                          ([kind, count]) => html`<div class="row"><span class="lbl">${humanise(kind)}</span><span class="val">${count}</span></div>`,
                        )}
                      </div>`
                }
                ${
                  security.summary.repeatSources.length > 0
                    ? html`<div class="metric-sub" style="margin-top:12px">
                        <b>${security.summary.repeatSources.length} source${security.summary.repeatSources.length === 1 ? '' : 's'} failing repeatedly</b> —
                        ${security.summary.repeatSources.slice(0, 3).map((s) => `${s.remote} (${s.failures})`).join(', ')}.
                        Repeated failures from one address is the brute-force shape.
                      </div>`
                    : ''
                }
              </div>
              <div class="card pad0">
                <h2 style="padding:15px 17px 0">Most recent refusals</h2>
                ${table({
                  headers: ['Kind', 'Reason', 'Path', 'Source'],
                  rows: (security.events ?? [])
                    .slice(-10)
                    .reverse()
                    .map((event) => [
                      badge(humanise(event.kind), event.kind === 'AUTH_FAILURE' || event.kind === 'RATE_LIMITED' ? 'bad' : 'warn'),
                      humanise(event.reason),
                      event.path ?? '—',
                      event.remote ?? '—',
                    ]),
                  empty: 'No refusal recorded',
                })}
              </div>
            </div>`
          : ''
      }

      ${
        logs
          ? html`<div class="grid g4" style="margin-bottom:14px">
              <div class="card">
                <h2>Requests observed</h2>
                <div class="metric">${logs.metrics?.totalRequests ?? '—'}</div>
                <div class="metric-sub">since this process started</div>
              </div>
              <div class="card">
                <h2>p95 latency</h2>
                <div class="metric">${logs.metrics ? `${logs.metrics.p95DurationMs}ms` : '—'}</div>
                <div class="metric-sub">measured at the gateway, not estimated</div>
              </div>
              <div class="card">
                <h2>API surface</h2>
                <div class="metric orange">${routes.routes.length}</div>
                <div class="metric-sub">explicit routes, no backend discovery</div>
              </div>
              <div class="card">
                <h2>Roles enforced</h2>
                <div class="metric">${orderedRoles.length}</div>
                <div class="metric-sub">across ${orderedAreas.length} capability areas</div>
              </div>
            </div>`
          : ''
      }

      ${
        logs
          ? html`<div class="grid g-2-1" style="margin-bottom:14px">
              <div class="card pad0">
                <h2 style="padding:15px 17px 0">Recent gateway activity</h2>
                ${table({
                  headers: ['Method', 'Path', 'Status', 'Duration'],
                  align: ['', '', '', 'num'],
                  rows: (logs.logs ?? [])
                    .slice(-14)
                    .reverse()
                    .map((l) => [
                      l.method,
                      l.path,
                      badge(String(l.status), l.status >= 500 ? 'bad' : l.status >= 400 ? 'warn' : 'ok'),
                      `${l.durationMs}ms`,
                    ]),
                  empty: 'No request recorded yet',
                })}
              </div>
              <div class="card">
                <h2>Denials by reason</h2>
                ${
                  Object.keys(logs.metrics?.denialsByReason ?? {}).length === 0
                    ? html`<div class="empty"><b>No denials</b>Every request so far was authorised.</div>`
                    : html`<div class="split-list">
                        ${Object.entries(logs.metrics.denialsByReason).map(
                          ([reason, count]) => html`<div class="row"><span class="lbl">${humanise(reason)}</span><span class="val">${count}</span></div>`,
                        )}
                      </div>`
                }
              </div>
            </div>`
          : ''
      }

      <!--
        Reference, not operations. Both of these are the platform stating what it
        enforces, and both are long enough to bury every live figure above them
        if left open — the permission matrix is a full role-by-area grid and the
        API surface is every route on the platform. Folded shut by default and
        one click from open: an operator reads them when auditing, not daily.
      -->
      <div class="card" style="margin-bottom:14px">
        <details>
          <summary>Permission matrix — what the platform actually enforces
            <span class="metric-sub">${orderedRoles.length} roles × ${orderedAreas.length} capability areas</span>
          </summary>
          <div class="details-body">
            <div class="table-scroll"><table>
              <thead><tr><th>Capability area</th>${orderedRoles.map((r) => html`<th style="text-align:center">${r}</th>`)}</tr></thead>
              <tbody>
                ${orderedAreas.map(
                  (area) => html`<tr>
                    <td style="white-space:nowrap">${humanise(area)}</td>
                    ${orderedRoles.map((role) => {
                      const codes = matrix.matrix[role]?.[area] ?? [];
                      return html`<td style="text-align:center;font-family:var(--mono);font-size:10.5px;color:${raw(
                        codes.length === 0 ? 'var(--text-3)' : codes.includes('A') || codes.includes('G') ? 'var(--orange)' : 'var(--text-2)',
                      )}">${codes.length === 0 ? '—' : codes.join('')}</td>`;
                    })}
                  </tr>`,
                )}
              </tbody>
            </table></div>
            <div class="metric-sub" style="margin-top:12px">
              R read · C create · U update · A approve/freeze/execute · I import/export · X run AI · G governance.
              An absent entry is no access at all — the matrix is allow-list, not deny-list.
            </div>
          </div>
        </details>
      </div>

      <div class="card">
        <details>
          <summary>API surface
            <span class="metric-sub">${routes.routes.length} explicit routes · ${routes.routes.filter((r) => r.public).length} public</span>
          </summary>
          <div class="details-body">
            ${table({
              headers: ['Method', 'Path', 'Description', 'Auth'],
              rows: routes.routes.map((r) => [
                badge(r.method, r.method === 'GET' ? 'info' : 'ai'),
                r.path,
                r.description,
                r.public ? badge('public', 'warn') : badge('protected', 'ok'),
              ]),
            })}
          </div>
        </details>
      </div>
    `,
  );

  if (!isOperator) return;

  const again = () => admin(root);

  // The landing page's pictures. A file input rather than a generated command
  // form: the body is the image itself, not JSON, so this posts the bytes the
  // way the evidence upload does.
  const mediaPanelEl = document.getElementById('site-media');
  const mediaError = (message) => {
    const box = mediaPanelEl?.querySelector('.cmd-error');
    if (!box) return;
    box.textContent = message;
    box.hidden = message === '';
  };

  for (const input of mediaPanelEl?.querySelectorAll('input[data-put]') ?? []) {
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      mediaError('');
      try {
        const result = await api.upload(`/v1/site/media/${encodeURIComponent(input.dataset.put)}`, file);
        toast('Picture set', `${result.file} · ${Math.round(result.bytes / 1024)}KB — live on the landing page now`, 'ok');
        await again();
      } catch (error) {
        // Named on the panel rather than only in a toast: the refusals here are
        // specific ("that is not a PNG, JPEG or WebP") and worth reading twice.
        mediaError(`${error.code ? `${error.code} — ` : ''}${error.message}`);
        input.value = '';
      }
    });
  }

  for (const button of mediaPanelEl?.querySelectorAll('[data-clear]') ?? []) {
    button.addEventListener('click', async () => {
      mediaError('');
      button.disabled = true;
      try {
        await api.delete(`/v1/site/media/${encodeURIComponent(button.dataset.clear)}`);
        toast('Picture removed', 'The slot renders nothing at all now, which is how the page is designed', 'ok');
        await again();
      } catch (error) {
        mediaError(`${error.code ? `${error.code} — ` : ''}${error.message}`);
        button.disabled = false;
      }
    });
  }

  // Every operator write route gets a door. A route only its author can reach is
  // not a feature; each of these existed and none of them was callable from the
  // console.
  document.getElementById('onboard-tenant')?.addEventListener('click', async () => {
    const result = await command({
      title: 'Onboard a tenancy',
      intent:
        'Creates the tenancy, its subscription, its ACU wallet and its first administrator together. The wallet ' +
        'opens with the free trial grant and the plan\'s first-period AI allowance. This is recorded in the ledger ' +
        'and cannot be undone — name a test tenancy so the record reads honestly later.',
      path: '/v1/admin/tenants',
      submitLabel: 'Onboard',
      fields: [
        { name: 'legalName', label: 'Legal name', hint: 'As it appears on the contract' },
        { name: 'enterpriseName', label: 'Enterprise name', hint: 'The group this tenancy belongs to' },
        // Required, and required for a reason: creating a user demands
        // ENTERPRISE_ADMIN of that tenancy, and a tenancy seconds old has none.
        // Without these two the tenancy is provisioned and nobody can ever
        // sign in to it.
        { name: 'adminName', label: 'First administrator', hint: 'The person who will run this tenancy — not a role' },
        {
          name: 'adminEmail',
          label: 'Administrator email',
          hint: 'Where their sign-in code goes. There is no password, so this address is the credential — and it is the only way into this tenancy.',
        },
        {
          name: 'jurisdiction',
          label: 'Jurisdiction',
          type: 'select',
          options: (vocab?.jurisdictions ?? []).map((j) => ({ value: j.code, label: `${j.name} (${j.taxName})` })),
          hint: 'Sets the tax rules and the statutory framework applied to this tenancy',
        },
        {
          name: 'defaultCurrency',
          label: 'Working currency',
          type: 'select',
          options: (vocab?.currencies ?? []).map((c) => ({ value: c.code, label: `${c.code} — ${c.name}` })),
          hint: 'What this tenancy reports in. The platform bills in GBP regardless.',
        },
        {
          name: 'tier',
          label: 'Tier',
          type: 'select',
          options: [
            { value: 'FREE_TRIAL', label: 'Free trial' },
            { value: 'SOLO', label: 'Solo' },
            { value: 'TEAM', label: 'Team' },
            { value: 'BUSINESS', label: 'Business' },
            { value: 'ENTERPRISE', label: 'Enterprise' },
            { value: 'SOVEREIGN', label: 'Sovereign' },
          ],
          hint: 'Determines seats, package and the AI allowance credited each period',
        },
      ],
    });

    if (result) {
      toast(
        'Tenancy onboarded',
        `${result.tenant.legalName} — ${result.administrator.email} can now sign in and invite the rest`,
        'ok',
      );
      await again();
    }
  });

  document.getElementById('appoint-operator')?.addEventListener('click', async () => {
    const result = await command({
      title: 'Appoint a platform operator',
      intent:
        'Creates an identity holding PLATFORM_ADMIN and nothing else — the whole operator surface, including the ' +
        'power to appoint others. Sign-in is an emailed one-time code, so the address is the credential: an ' +
        'operator created against an address nobody reads is an account nobody can use.',
      path: '/v1/operators',
      submitLabel: 'Appoint',
      fields: [
        { name: 'name', label: 'Name', hint: 'The person, not a role — this is who the record will name' },
        { name: 'email', label: 'Email address', hint: 'Where their sign-in code will be sent' },
      ],
    });

    if (result) {
      toast('Operator appointed', `${result.name} holds PLATFORM_ADMIN`, 'ok');
      await again();
    }
  });

  for (const button of document.querySelectorAll('[data-credit]')) {
    button.addEventListener('click', async () => {
      const tenantId = button.getAttribute('data-credit');
      const tenant = tenantsById.get(tenantId);
      const result = await command({
        title: `Credit ${tenant?.legalName ?? 'wallet'}`,
        intent:
          'Records a payment that has already been received and credits the wallet against it. The reference is the ' +
          'bank\'s or provider\'s own identifier and is the idempotency key for money — the same reference twice ' +
          'credits once. Do not invent one.',
        path: `/v1/admin/tenants/${encodeURIComponent(tenantId)}/credit`,
        submitLabel: 'Credit',
        fields: [
          {
            name: 'amountMinor',
            label: 'Amount received (pence)',
            type: 'number',
            hint: 'In minor units of the billing currency. £100 is 10000.',
          },
          {
            name: 'method',
            label: 'How it arrived',
            type: 'select',
            options: [
              { value: 'BANK_TRANSFER', label: 'Bank transfer' },
              { value: 'CARD', label: 'Card' },
              { value: 'INVOICE_SETTLEMENT', label: 'Invoice settlement' },
              { value: 'CREDIT_NOTE', label: 'Credit note' },
              { value: 'MANUAL_ADJUSTMENT', label: 'Manual adjustment' },
            ],
          },
          {
            name: 'reference',
            label: 'Payment reference',
            hint: 'The provider\'s or bank\'s identifier for this payment. Unique for ever.',
          },
          { name: 'note', label: 'Note', required: false, hint: 'Why this credit exists, for whoever reads the record later' },
        ],
      });

      if (result) {
        toast(
          result.alreadyRecorded ? 'Already recorded' : 'Wallet credited',
          result.alreadyRecorded
            ? 'That reference was already settled — nothing was credited twice.'
            : `${money(result.receipt.amountMinor)} · available ${money(result.wallet.availableMinor)}`,
          result.alreadyRecorded ? 'warn' : 'ok',
        );
        await again();
      }
    });
  }

  for (const button of document.querySelectorAll('[data-status]')) {
    button.addEventListener('click', async () => {
      const tenantId = button.getAttribute('data-status');
      const tenant = tenantsById.get(tenantId);
      const result = await command({
        title: `Subscription status — ${tenant?.legalName ?? 'tenancy'}`,
        intent:
          'This is the switch that turns a paying customer\'s platform off. Suspended or cancelled, the record goes ' +
          'read-only: no writes, no AI execution, no top-ups and no export until reactivated. The reason is required ' +
          'and is recorded as evidence, because a record of this with no stated reason is useless the day somebody asks why.',
        path: `/v1/admin/tenants/${encodeURIComponent(tenantId)}/subscription-status`,
        submitLabel: 'Apply',
        fields: [
          {
            name: 'status',
            label: 'Status',
            type: 'select',
            value: tenant?.status,
            options: [
              { value: 'ACTIVE', label: 'Active — writes, AI, top-ups and export permitted' },
              { value: 'SUSPENDED', label: 'Suspended — read-only' },
              { value: 'CANCELLED', label: 'Cancelled — read-only' },
            ],
          },
          { name: 'reason', label: 'Reason', hint: 'Recorded as evidence against this decision' },
        ],
      });

      if (result) {
        toast(`${tenant?.legalName ?? 'Tenancy'} — ${result.status}`, result.effect, result.status === 'ACTIVE' ? 'ok' : 'warn');
        await again();
      }
    });
  }
}
