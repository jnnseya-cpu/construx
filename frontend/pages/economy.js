import { api } from '../lib/api.js';
import { barChart, lineChart } from '../lib/charts.js';
import { axisDay, head, providerName, refusal, runway } from '../lib/estate.js';
import { badge, html, money, pct, raw, render, table } from '../lib/ui.js';

/**
 * The ACU economy.
 *
 * What the estate was charged for AI, what the providers cost, and what is left
 * over. The margin here is enforced by the architecture rather than by pricing
 * discipline: every execution is reserved before it runs and debited only after
 * its output reaches the ledger, at a disclosed multiplier over provider cost.
 *
 * Three numbers on this screen are routinely misread, so each carries its
 * explanation rather than a tooltip:
 *
 * **Absorbed** is not a leak. A charge is capped at the amount that was reserved
 * and disclosed, so when an execution costs more than the estimate the customer
 * is not billed the difference — the platform is. It is an estimation-quality
 * signal.
 *
 * **The realised multiplier** is computed from what was actually charged, not
 * from the configured one. They differ every time an execution is capped.
 *
 * **Concentration** is the share from the single heaviest tenancy, and it is the
 * number that says how much one customer's behaviour moves the whole line.
 */

export async function economy(root) {
  const [burn, catalogue] = await Promise.all([
    api.get('/v1/admin/burn').catch((error) => ({ error })),
    api.get('/v1/billing/catalogue').catch(() => null),
  ]);

  if (burn.error) {
    render(root, html`${head({ title: 'ACU economy' })}${refusal('Estate AI spend', burn.error)}`);
    return;
  }

  render(
    root,
    html`
      ${head({
        title: 'ACU economy',
        intent:
          `What the estate was charged for AI over the last ${burn.windowDays} days against what the providers cost. ` +
          'Subscription revenue is not in this line — it is on the Command Center.',
      })}

      <section class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h2>Charged</h2>
          <div class="metric">${money(burn.billedMinor)}</div>
          <div class="metric-sub">${burn.acuUnits.toLocaleString('en-GB')} ACU consumed</div>
        </div>
        <div class="card">
          <h2>Provider cost</h2>
          <div class="metric">${money(burn.rawCostMinor)}</div>
          <div class="metric-sub">what the vendors will invoice for it</div>
        </div>
        <div class="card">
          <h2>Margin</h2>
          <div class="metric ${raw(burn.marginMinor >= 0 ? 'good' : 'bad')}">${money(burn.marginMinor)}</div>
          <div class="metric-sub">
            realised multiplier ${burn.realisedMultiplier === null ? '—' : `${burn.realisedMultiplier}x`} · ${money(burn.dailyBurnMinor)} per day
          </div>
        </div>
        <div class="card">
          <h2>Absorbed</h2>
          <div class="metric ${raw(burn.absorbedMinor > 0 ? 'warn' : '')}">${money(burn.absorbedMinor)}</div>
          <div class="metric-sub">the platform's own cost above what was quoted</div>
        </div>
      </section>

      <div class="grid g-2-1" style="margin-bottom:14px">
        <div class="card chart-card">
          <h2>Charged, cost and margin — last ${burn.windowDays} days</h2>
          <div class="metric-sub" style="margin-bottom:12px">
            The three lines should move together. Cost rising while charged stays flat is executions being capped;
            charged rising while cost stays flat is a provider getting cheaper or a routing change.
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
        </div>
        <div class="card">
          <h2>How the margin holds</h2>
          <div class="split-list">
            <div class="row"><span class="lbl">Charged</span><span class="val">${money(burn.billedMinor)}</span></div>
            <div class="row"><span class="lbl">Provider cost</span><span class="val">${money(burn.rawCostMinor)}</span></div>
            <div class="row"><span class="lbl">Margin</span><span class="val">${money(burn.marginMinor)}</span></div>
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
            <b>Absorbed is not a leak.</b> A charge is capped at the amount reserved and disclosed before the work ran,
            so a customer is never billed above what they agreed to. When an execution costs more than the estimate,
            the platform carries it — which makes this an estimation-quality number, not a revenue one.
          </div>
        </div>
      </div>

      <div class="grid g2" style="margin-bottom:14px">
        <div class="card chart-card">
          <h2>Where the spend actually went</h2>
          <div class="metric-sub" style="margin-bottom:12px">
            <b>Realised</b> routing, computed from what was charged rather than from the configured routing table. The
            two differ every time a provider is unhealthy and traffic fails over — which is exactly when nobody is
            looking at the routing table.
          </div>
          ${barChart({
            horizontal: true,
            data: burn.providers.map((provider) => ({
              label: providerName(provider.provider),
              sub: `${provider.executions} execution${provider.executions === 1 ? '' : 's'} · ${pct(provider.share * 100, 1)}`,
              value: provider.billedMinor,
            })),
            format: (value) => money(value),
            empty: 'No AI spend in this window.',
          })}
        </div>
        <div class="card chart-card">
          <h2>Heaviest tenancies</h2>
          <div class="metric-sub" style="margin-bottom:12px">By AI charged over the window, largest first.</div>
          ${barChart({
            horizontal: true,
            data: burn.tenants
              .filter((tenant) => tenant.billedMinor > 0)
              .slice(0, 6)
              .map((tenant) => ({
                label: tenant.legalName,
                sub: runway(tenant, burn.windowDays),
                value: tenant.billedMinor,
                tone:
                  tenant.runwayDays !== null && tenant.runwayDays <= 7
                    ? 'bad'
                    : tenant.runwayDays !== null && tenant.runwayDays <= burn.windowDays
                      ? 'warn'
                      : '',
              })),
            format: (value) => money(value),
            empty: 'No tenancy has spent in this window.',
          })}
          <div class="metric-sub" style="margin-top:12px">
            ${burn.runningOut.length > 0
              ? html`<b>${burn.runningOut.length} tenanc${burn.runningOut.length === 1 ? 'y loses' : 'ies lose'} AI service
                  inside the window</b> at the current rate:
                  ${burn.runningOut.map((tenant) => `${tenant.legalName} (${tenant.runwayDays}d)`).join(', ')}.`
              : 'No tenancy runs out of credit inside the window at its current rate.'}
          </div>
        </div>
      </div>

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">Every tenancy's consumption</h2>
        ${table({
          headers: ['Tenancy', 'Charged', 'Provider cost', 'Their multiplier', 'Absorbed', 'Available', 'Days left'],
          align: ['', 'num', 'num', 'num', 'num', 'num', 'num'],
          rows: burn.tenants.map((tenant) => [
            tenant.legalName,
            money(tenant.billedMinor),
            money(tenant.rawCostMinor),
            tenant.realisedMultiplier === null ? '—' : `${tenant.realisedMultiplier}x`,
            tenant.absorbedMinor > 0 ? money(tenant.absorbedMinor) : '—',
            money(tenant.availableMinor),
            tenant.runwayDays === null
              ? html`<span class="metric-sub">not spending</span>`
              : badge(String(tenant.runwayDays), tenant.runwayDays <= 7 ? 'bad' : tenant.runwayDays <= 30 ? 'warn' : 'ok'),
          ]),
          empty: 'No tenancy has consumed AI.',
        })}
      </div>

      ${catalogue
        ? html`<div class="card">
            <details>
              <summary>What is sold
                <span class="metric-sub">${(catalogue.bundles ?? []).length} ACU bundles · ${(catalogue.packages ?? []).length} packages</span>
              </summary>
              <div class="details-body">
                <div class="metric-sub" style="margin-bottom:12px">
                  The published price list, read from the platform rather than restated here. These are the prices a
                  customer sees; the multiplier above is the platform's own arithmetic and is not published to them.
                </div>
                ${table({
                  headers: ['Bundle', 'ACU', 'Price'],
                  align: ['', 'num', 'num'],
                  rows: (catalogue.bundles ?? []).map((bundle) => [
                    bundle.label ?? bundle.id,
                    (bundle.units ?? 0).toLocaleString('en-GB'),
                    money(bundle.priceMinor ?? 0),
                  ]),
                  empty: 'No bundle is published.',
                })}
              </div>
            </details>
          </div>`
        : ''}
    `,
  );
}
