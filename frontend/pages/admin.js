import { api } from '../lib/api.js';
import { barChart, lineChart } from '../lib/chart.js';
import { command } from '../lib/command.js';
import { badge, date, html, humanise, money, pct, raw, render, table, toast, track } from '../lib/ui.js';
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

export async function admin(root) {
  const roles = state.session.user.roles ?? [];
  const isOperator = roles.includes('PLATFORM_ADMIN');
  const operatorOnly = (path) => (isOperator ? api.get(path).catch(() => null) : Promise.resolve(null));

  const [routes, plane, matrix, overview, estate, burn, payments, security, logs, ready, vocab] = await Promise.all([
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
    // Jurisdictions and currencies for the onboarding form, published by the
    // platform rather than listed here — so the console cannot offer a
    // jurisdiction the tax engine does not know.
    operatorOnly('/v1/signup/account-types'),
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
                  <h3>Revenue — today</h3>
                  <div class="metric">${money(overview.revenue.todayMinor)}</div>
                  <div class="metric-sub">${overview.revenue.receipts} receipt${overview.revenue.receipts === 1 ? '' : 's'} recorded in total</div>
                </div>
                <div class="card">
                  <h3>Revenue — month to date</h3>
                  <div class="metric ${raw(mtdMovement === null ? '' : mtdMovement >= 0 ? 'good' : 'warn')}">${money(overview.revenue.monthToDateMinor)}</div>
                  <div class="metric-sub">${
                    mtdMovement === null
                      ? 'no revenue last month to compare against'
                      : `${mtdMovement >= 0 ? '+' : ''}${pct(mtdMovement, 1)} against ${money(overview.revenue.previousMonthMinor)} last month`
                  }</div>
                </div>
                <div class="card">
                  <h3>Revenue — lifetime</h3>
                  <div class="metric orange">${money(overview.revenue.lifetimeMinor)}</div>
                  <div class="metric-sub">every settled payment since launch</div>
                </div>
                <div class="card">
                  <h3>Awaiting payment</h3>
                  <div class="metric ${raw(overview.awaitingPayment.count > 0 ? 'info' : '')}">${money(overview.awaitingPayment.amountMinor)}</div>
                  <div class="metric-sub">${overview.awaitingPayment.count} top-up${overview.awaitingPayment.count === 1 ? '' : 's'} raised and unsettled</div>
                </div>
              </div>

              <div class="grid g4" style="margin-bottom:14px">
                <div class="card">
                  <h3>Tenancies</h3>
                  <div class="metric">${overview.tenancies.total}</div>
                  <div class="metric-sub">${overview.tenancies.active} active · ${overview.tenancies.suspended} suspended · ${overview.tenancies.cancelled} cancelled</div>
                </div>
                <div class="card">
                  <h3>New in 30 days</h3>
                  <div class="metric ${raw(overview.tenancies.newInWindow > 0 ? 'good' : '')}">${overview.tenancies.newInWindow}</div>
                  <div class="metric-sub">tenancies onboarded</div>
                </div>
                <div class="card">
                  <h3>Seats assigned</h3>
                  <div class="metric">${overview.identities.seatsUsed}${overview.identities.seatsIncluded === null ? '' : ` / ${overview.identities.seatsIncluded}`}</div>
                  <div class="metric-sub">${
                    overview.identities.seatsIncluded === null
                      ? 'an uncapped tier is on the estate, so there is no estate ceiling to report'
                      : `${overview.identities.total} identit${overview.identities.total === 1 ? 'y' : 'ies'} across the estate`
                  }</div>
                </div>
                <div class="card">
                  <h3>Run-rate — this month</h3>
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
                <h3>AI charged, provider cost and margin — last ${burn.windowDays} days</h3>
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
                <h3>Estate position</h3>
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
                <h3>Where the AI spend went</h3>
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
                <h3>Heaviest tenancies</h3>
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
          <h3>AI engines</h3>
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
                <h3>Payment rails</h3>
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
                <h3>Storage across the estate</h3>
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

      ${
        ready
          ? html`<div class="card pad0" style="margin-bottom:14px">
              <h3 style="padding:15px 17px 0">
                System control — what this deployment actually has configured
                ${
                  ready.blocking.length > 0
                    ? badge(`${ready.blocking.length} blocking go-live`, 'bad')
                    : ready.degraded > 0
                      ? badge(`${ready.degraded} half-configured`, 'warn')
                      : badge('production-ready', 'ok')
                }
              </h3>
              <div class="metric-sub" style="padding:0 17px 10px">
                ${ready.configured} of ${ready.capabilities.length} capabilities configured · environment
                <b>${ready.environment}</b>. Read from this running process, not from a checklist. Every rail is set with
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
        estate
          ? html`<div class="card pad0" style="margin-bottom:14px">
              <h3 style="padding:15px 17px 0">Tenant governance</h3>
              <div class="metric-sub" style="padding:0 17px 10px">
                Commercial terms and credit only. An operator cannot open a project, a package or a daily log from
                here — the account layer is enforced in ABAC, not in this page's markup.
              </div>
              ${table({
                headers: ['Tenant', 'Jurisdiction', 'Tier', 'Status', 'Seats', 'Isolation', 'ACU available', 'Renews', ''],
                align: ['', '', '', '', 'num', '', 'num', '', ''],
                rows: (estate.tenants ?? []).map((t) => [
                  t.legalName,
                  t.jurisdiction,
                  badge(t.tier, t.tier === 'ENTERPRISE' || t.tier === 'SOVEREIGN' ? 'ai' : 'info'),
                  badge(t.status, t.status === 'ACTIVE' ? 'ok' : 'warn'),
                  `${t.seatsUsed} / ${t.seatsIncluded ?? '∞'}`,
                  t.isolatedTenancy ? badge('dedicated', 'ok') : badge('shared', 'info'),
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
        security
          ? html`<div class="grid g2" style="margin-bottom:14px">
              <div class="card">
                <h3>Security stream</h3>
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
                <h3 style="padding:15px 17px 0">Most recent refusals</h3>
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
                <h3>Requests observed</h3>
                <div class="metric">${logs.metrics?.totalRequests ?? '—'}</div>
                <div class="metric-sub">since this process started</div>
              </div>
              <div class="card">
                <h3>p95 latency</h3>
                <div class="metric">${logs.metrics ? `${logs.metrics.p95DurationMs}ms` : '—'}</div>
                <div class="metric-sub">measured at the gateway, not estimated</div>
              </div>
              <div class="card">
                <h3>API surface</h3>
                <div class="metric orange">${routes.routes.length}</div>
                <div class="metric-sub">explicit routes, no backend discovery</div>
              </div>
              <div class="card">
                <h3>Roles enforced</h3>
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
                <h3 style="padding:15px 17px 0">Recent gateway activity</h3>
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
                <h3>Denials by reason</h3>
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

  // Every operator write route gets a door. A route only its author can reach is
  // not a feature; each of these existed and none of them was callable from the
  // console.
  document.getElementById('onboard-tenant')?.addEventListener('click', async () => {
    const result = await command({
      title: 'Onboard a tenancy',
      intent:
        'Creates the tenancy, its subscription and its ACU wallet together. The wallet opens with the free trial ' +
        'grant and the plan\'s first-period AI allowance. This is recorded in the ledger and cannot be undone — ' +
        'name a test tenancy so the record reads honestly later.',
      path: '/v1/admin/tenants',
      submitLabel: 'Onboard',
      fields: [
        { name: 'legalName', label: 'Legal name', hint: 'As it appears on the contract' },
        { name: 'enterpriseName', label: 'Enterprise name', hint: 'The group this tenancy belongs to' },
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
      toast('Tenancy onboarded', `${result.tenant.legalName} — wallet opened`, 'ok');
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
