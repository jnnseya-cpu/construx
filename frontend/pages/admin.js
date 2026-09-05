import { api } from '../lib/api.js';
import { lineChart } from '../lib/charts.js';
import { axisDay, gb, head, movement, providerName, refusal } from '../lib/estate.js';
import { badge, html, humanise, money, pct, raw, render, table, time, track } from '../lib/ui.js';
import { navigate } from '../app.js';

/**
 * The Command Center.
 *
 * This screen used to be the entire operator console — every panel the platform
 * had, on one scroll, under a navigation of four items. It answered every
 * question and led with none of them, which meant an operator opening it in the
 * morning had to read four thousand pixels to find out whether anything was
 * wrong.
 *
 * It is now the first of twenty-five screens, and its job has changed
 * accordingly. **It answers one question — is anything wrong, and where is the
 * money — and hands off to the screen that goes deeper.** Every panel here is a
 * headline with a route behind it; nothing on it is the only place something can
 * be read.
 *
 * For a customer account this screen is not reachable at all: `PLATFORM_ADMINISTRATION`
 * is not an area any customer role can hold, and the operator navigation is not
 * theirs. The branch that used to render a cut-down version for them is gone
 * with it.
 */

/** A headline that leads somewhere. The whole console is one press from here. */
function lead({ title, value, tone, sub, to, cta }) {
  return html`<div class="card">
    <h2>${title}</h2>
    <div class="metric ${raw(tone ?? '')}">${value}</div>
    <div class="metric-sub">${sub}</div>
    ${to ? html`<div class="actions" style="margin-top:10px"><button class="btn quiet sm" data-go="${to}">${cta}</button></div>` : ''}
  </div>`;
}

export async function admin(root) {
  const [overview, burn, forecast, watch, ready, plane, support, estate, trialBudget] = await Promise.all([
    api.get('/v1/admin/overview').catch((error) => ({ error })),
    api.get('/v1/admin/burn').catch(() => null),
    api.get('/v1/admin/forecast').catch(() => null),
    api.get('/v1/admin/watch').catch(() => null),
    api.get('/v1/admin/readiness').catch(() => null),
    api.get('/v1/ai/control-plane').catch(() => null),
    api.get('/v1/support').catch(() => null),
    api.get('/v1/admin/tenants').catch(() => null),
    // How much of this month's free trial credit has gone. The free tier is
    // the one line of the business whose cost scales with signups rather than
    // revenue, so the ceiling on it belongs on the first screen.
    api.get('/v1/admin/trial-budget').catch(() => null),
  ]);

  if (overview.error) {
    render(root, html`${head({ title: 'Command Center' })}${refusal('The estate position', overview.error)}`);
    return;
  }

  const mtd = movement(overview.revenue.monthToDateMinor, overview.revenue.previousMonthMinor);
  const firing = (watch?.alerts ?? []).filter((alert) => alert.firing);
  const critical = firing.filter((alert) => alert.severity === 'CRITICAL');
  const urgent = (forecast?.signals ?? []).filter((signal) => signal.severity === 'CRITICAL');
  const blocking = ready?.blocking ?? [];
  const providers = plane?.available ?? [];
  const healthy = providers.filter((provider) => provider.healthy);
  const owed = support?.awaitingPlatform ?? 0;
  const overdue = support?.overdue ?? 0;

  /**
   * What needs somebody today, from every source at once.
   *
   * Assembled here rather than on each screen, because the point of a command
   * centre is that you do not have to visit six screens to find out whether to
   * visit any of them. Each line names where it came from and goes there.
   */
  const attention = [
    ...(blocking.length > 0
      ? [{
          tone: 'bad',
          text: `${blocking.length} capabilit${blocking.length === 1 ? 'y is' : 'ies are'} not configured and the platform cannot do without ${blocking.length === 1 ? 'it' : 'them'}: ${blocking.join(', ')}`,
          to: 'system',
          cta: 'System control',
        }]
      : []),
    ...critical.map((alert) => ({ tone: 'bad', text: `${alert.title ?? alert.id} — ${alert.detail ?? 'firing'}`, to: 'alerts', cta: 'Risk & alerts' })),
    ...urgent.slice(0, 5).map((signal) => ({ tone: 'bad', text: `${signal.legalName}: ${signal.headline}`, to: 'intel', cta: 'Predictive intel' })),
    ...(overdue > 0
      ? [{ tone: 'bad', text: `${overdue} support request${overdue === 1 ? ' is' : 's are'} past the response target with no reply`, to: 'support', cta: 'Support queue' }]
      : []),
    ...(healthy.length === 0 && providers.length > 0
      ? [{ tone: 'warn', text: 'No AI provider is answering — everything falls back to the local stand-in', to: 'aiengine', cta: 'AI engine' }]
      : []),
    ...(overview.tenancies.unreachable > 0
      ? [{
          tone: 'bad',
          text: `${overview.tenancies.unreachable} tenanc${overview.tenancies.unreachable === 1 ? 'y has' : 'ies have'} no administrator — nobody can run them`,
          to: 'onboarding',
          cta: 'Onboarding queue',
        }]
      : []),
    ...firing
      .filter((alert) => alert.severity !== 'CRITICAL')
      .slice(0, 3)
      .map((alert) => ({ tone: 'warn', text: `${alert.title ?? alert.id} — ${alert.detail ?? 'firing'}`, to: 'alerts', cta: 'Risk & alerts' })),
  ];

  render(
    root,
    html`
      ${head({
        title: 'Command Center',
        intent:
          `${overview.tenancies.total} tenanc${overview.tenancies.total === 1 ? 'y' : 'ies'} · ` +
          `${overview.identities.active} active ${overview.identities.active === 1 ? 'identity' : 'identities'} · ` +
          `${overview.identities.operators} operator${overview.identities.operators === 1 ? '' : 's'}. ` +
          'Is anything wrong, and where is the money — everything else has a screen of its own.',
      })}

      ${attention.length === 0
        ? html`<div class="notice ok" style="margin-bottom:14px">
            <div>
              <b>Nothing needs you right now.</b><br />
              No rule is firing, no capability is unconfigured, no tenancy is about to lose service, nobody is waiting
              past a response target and every tenancy has somebody who can run it. That is five checks that ran, not a
              screen with nothing on it.
            </div>
          </div>`
        : html`<div class="card pad0" style="margin-bottom:14px">
            <h2 style="padding:15px 17px 0">
              Needs you today
              ${badge(String(attention.length), attention.some((entry) => entry.tone === 'bad') ? 'bad' : 'warn')}
            </h2>
            <div class="metric-sub" style="padding:0 17px 10px">
              Assembled from the watch, the forecast, the readiness report, the support queue and the estate — so that
              finding out whether anything is wrong does not require visiting five screens.
            </div>
            <div style="padding:0 17px 15px">
              <div class="split-list">
                ${attention.map(
                  (entry) => html`<div class="row" style="align-items:flex-start;gap:14px">
                    <span class="lbl" style="flex:1 1 0;min-width:0">
                      ${badge(entry.tone === 'bad' ? 'critical' : 'warning', entry.tone)} ${entry.text}
                    </span>
                    <span class="val"><button class="btn quiet sm" data-go="${entry.to}">${entry.cta}</button></span>
                  </div>`,
                )}
              </div>
            </div>
          </div>`}

      <section class="grid g4" style="margin-bottom:14px">
        ${lead({
          title: 'Revenue — month to date',
          value: money(overview.revenue.monthToDateMinor),
          tone: mtd === null ? '' : mtd >= 0 ? 'good' : 'warn',
          sub:
            mtd === null
              ? 'no revenue last month to compare against'
              : `${mtd >= 0 ? '+' : ''}${pct(mtd, 1)} against ${money(overview.revenue.previousMonthMinor)} last month`,
          to: 'invoices',
          cta: 'Billing & invoices',
        })}
        ${lead({
          title: 'Revenue — lifetime',
          value: money(overview.revenue.lifetimeMinor),
          tone: 'orange',
          sub: `${overview.revenue.receipts} settled receipt${overview.revenue.receipts === 1 ? '' : 's'} since launch`,
          to: 'value',
          cta: 'Customer value',
        })}
        ${lead({
          title: 'Run-rate this month',
          value: overview.revenue.runRateMinor === null ? '—' : money(overview.revenue.runRateMinor),
          sub: overview.revenue.runRateBasis
            ? `${money(overview.revenue.runRateBasis.monthToDateMinor)} ÷ ${overview.revenue.runRateBasis.elapsedDays} days × ${overview.revenue.runRateBasis.daysInMonth} — arithmetic, not a forecast`
            : 'withheld: too little of the month has elapsed to extrapolate honestly',
        })}
        ${lead({
          title: 'Awaiting payment',
          value: money(overview.awaitingPayment.amountMinor),
          tone: overview.awaitingPayment.count > 0 ? 'info' : '',
          sub: `${overview.awaitingPayment.count} top-up${overview.awaitingPayment.count === 1 ? '' : 's'} raised and unsettled`,
          to: 'invoices',
          cta: 'Chase them',
        })}
      </section>

      <section class="grid g4" style="margin-bottom:14px">
        ${lead({
          title: 'Tenancies',
          value: overview.tenancies.total,
          tone: overview.tenancies.unreachable > 0 ? 'bad' : '',
          sub:
            `${overview.tenancies.active} active · ${overview.tenancies.onTrial} on trial · ${overview.tenancies.suspended} suspended` +
            // Closed tenancies are counted in nothing above — not the total, not
            // the identities, not the money awaited — and named here so the
            // register's row for one is not a surprise.
            (overview.tenancies.closed > 0 ? ` · ${overview.tenancies.closed} closed and counted in nothing here` : '') +
            (trialBudget
              ? ` · trial credit ${money(trialBudget.issuedMinor)} of ${money(trialBudget.budgetMinor)} given away this month` +
                (trialBudget.remainingMinor === 0 ? ' — the allocation is spent; new signups open with an empty wallet' : '')
              : ''),
          to: 'tenants',
          cta: 'Tenants & users',
        })}
        ${lead({
          title: 'New in 30 days',
          value: overview.tenancies.newInWindow,
          tone: overview.tenancies.newInWindow > 0 ? 'good' : '',
          sub: 'tenancies onboarded',
          to: 'onboarding',
          cta: 'Onboarding queue',
        })}
        ${lead({
          title: 'Seats assigned',
          value: `${overview.identities.seatsUsed}${overview.identities.seatsIncluded === null ? '' : ` / ${overview.identities.seatsIncluded}`}`,
          sub:
            overview.identities.seatsIncluded === null
              ? 'an uncapped tier is on the estate, so there is no estate ceiling to report'
              : `${overview.identities.total} identit${overview.identities.total === 1 ? 'y' : 'ies'} across the estate`,
        })}
        ${lead({
          title: 'Waiting on us',
          value: owed,
          tone: overdue > 0 ? 'bad' : owed > 0 ? 'warn' : '',
          sub: support ? `${support.open} live request${support.open === 1 ? '' : 's'} · ${overdue} past the target` : 'the queue could not be read',
          to: 'support',
          cta: 'Support queue',
        })}
      </section>

      ${burn
        ? html`<div class="grid g-2-1" style="margin-bottom:14px">
            <div class="card chart-card">
              <h2>AI charged, provider cost and margin — last ${burn.windowDays} days</h2>
              <div class="metric-sub" style="margin-bottom:12px">
                Subscription revenue is not in this line — it is in the tiles above. The full economics, the realised
                routing split and every tenancy's consumption are on the ACU Economy screen.
              </div>
              ${lineChart({
                title: 'AI spend, day by day',
                data: burn.daily.map((day) => ({
                  label: axisDay(day.date),
                  billed: day.billedMinor,
                  cost: day.rawCostMinor,
                  margin: day.marginMinor,
                })),
                series: [
                  { key: 'billed', label: 'Charged' },
                  { key: 'cost', label: 'Provider cost' },
                  { key: 'margin', label: 'Margin' },
                ],
                format: (value) => money(value),
                empty: 'No AI spend in this window.',
              })}
              <div class="actions" style="margin-top:12px">
                <button class="btn quiet sm" data-go="economy">ACU economy</button>
              </div>
            </div>
            <div class="card">
              <h2>Platform</h2>
              <div class="split-list">
                <div class="row">
                  <span class="lbl">AI providers</span>
                  <span class="val">${badge(`${healthy.length} of ${providers.length} live`, healthy.length === 0 ? 'bad' : 'ok')}</span>
                </div>
                <div class="row">
                  <span class="lbl">Reasoning</span>
                  <span class="val">${providerName(plane?.reasoning?.provider ?? '—')}</span>
                </div>
                <div class="row">
                  <span class="lbl">Capabilities configured</span>
                  <span class="val">${ready ? `${ready.configured} / ${ready.capabilities.length}` : '—'}</span>
                </div>
                <div class="row">
                  <span class="lbl">Rules firing</span>
                  <span class="val">${badge(String(firing.length), firing.length > 0 ? 'warn' : 'ok')}</span>
                </div>
                ${estate?.estate
                  ? html`<div class="row">
                      <span class="lbl">Evidence held</span>
                      <span class="val">${gb(estate.estate.heldBytes)} of ${gb(estate.estate.committedBytes)}</span>
                    </div>`
                  : ''}
              </div>
              ${estate?.estate
                ? html`<div style="margin-top:12px">
                    ${track(
                      estate.estate.committedBytes > 0 ? (estate.estate.heldBytes / estate.estate.committedBytes) * 100 : 0,
                      estate.estate.atLimit > 0 ? 'bad' : estate.estate.atWarning > 0 ? 'warn' : '',
                    )}
                    <div class="metric-sub" style="margin-top:8px">
                      Committed is what the platform has <i>promised</i>, and it arrives the day a tenancy signs rather
                      than as it uploads. The volume has to stay ahead of held, with headroom.
                    </div>
                  </div>`
                : ''}
              <div class="actions" style="margin-top:12px">
                <button class="btn quiet sm" data-go="system">System control</button>
                <button class="btn quiet sm" data-go="performance">Performance</button>
              </div>
            </div>
          </div>`
        : ''}

      ${forecast && forecast.signals.length > 0
        ? html`<div class="card pad0">
            <h2 style="padding:15px 17px 0">
              What lands next
              ${badge(`${forecast.counts.critical} critical`, forecast.counts.critical > 0 ? 'bad' : 'ok')}
            </h2>
            <div class="metric-sub" style="padding:0 17px 10px">
              The next ${forecast.windowDays} days, each with the arithmetic it came from. No score and no probability —
              the full queue and the reasoning behind every line are on Predictive Intel.
            </div>
            ${table({
              headers: ['Tenancy', 'What happens', 'When', 'On what basis'],
              rows: forecast.signals.slice(0, 8).map((signal) => [
                signal.legalName,
                html`<b>${signal.headline}</b>`,
                signal.daysAway === null ? '—' : `${signal.daysAway} day${signal.daysAway === 1 ? '' : 's'}`,
                html`<span class="metric-sub">${signal.basis}</span>`,
              ]),
            })}
            <div style="padding:12px 17px 15px">
              <button class="btn quiet sm" data-go="intel">Predictive intel</button>
            </div>
          </div>`
        : ''}
    `,
  );

  for (const button of root.querySelectorAll('[data-go]')) {
    button.addEventListener('click', () => navigate(button.getAttribute('data-go')));
  }
}
