import { api } from '../lib/api.js';
import { badge, exact, html, humanise, money, pct, raw, render, table, toast, track } from '../lib/ui.js';
import { can, refreshContext, state } from '../app.js';

/**
 * ACU & Billing.
 *
 * The commercial model made visible. Every AI execution is funded before it
 * runs and billed only once its output reaches the ledger, so this screen
 * reconciles exactly against the Golden Thread rather than against a separate
 * usage log that could disagree with it.
 */

export async function billing(root) {
  const [wallet, attribution, plane, seats] = await Promise.all([
    api.get('/v1/billing/wallet'),
    api.get('/v1/billing/attribution'),
    api.get('/v1/ai/control-plane').catch(() => null),
    // What the package actually includes. A platform that refuses an export on
    // plan grounds and has no screen saying what the plan covers is a dead end.
    api.get('/v1/billing/seats').catch(() => null),
  ]);

  const effective = wallet.monthRawSpendMinor === 0 ? 0 : wallet.monthBilledMinor / wallet.monthRawSpendMinor;
  const totalBilled = attribution.attribution.reduce((sum, a) => sum + a.billedMinor, 0);
  const totalCalls = attribution.attribution.reduce((sum, a) => sum + a.calls, 0);

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>ACU &amp; Billing</h1>
          <p>Prepaid AI credit with hard caps. No provider is contacted on an empty wallet, and nothing is charged until the output is committed.</p>
        </div>
        <div class="actions">
          ${can('BILLING_ACU', 'U') ? html`<button class="btn ghost" id="topup">Top up</button>` : ''}
          ${can('BILLING_ACU', 'R') ? html`<button class="btn quiet" id="invoice">Issue invoice</button>` : ''}
        </div>
      </div>

      ${
        wallet.aiHalted
          ? html`<div class="notice err"><div><b>AI execution is halted.</b><br>${wallet.haltReason}</div></div>`
          : ''
      }
      ${
        (wallet.alerts ?? []).length > 0
          ? html`<div class="notice warn">
              <div><b>${wallet.alerts.length} budget alert(s)</b><br>
              ${wallet.alerts.map((a) => `${a.threshold}% of the ${a.scope.toLowerCase()} cap reached`).join(' · ')}</div>
            </div>`
          : ''
      }

      ${
        seats
          ? html`<div class="card" style="margin-bottom:14px">
              <h3>Your package — ${seats.package.label}</h3>
              <p class="metric-sub" style="margin-bottom:12px">
                The package is charged, not the sum of its seats. No package includes AI: ACUs are bought separately,
                which is why a heavy AI user pays for what they consume rather than everybody absorbing it.
              </p>
              <div class="split-list">
                <div class="row"><span class="lbl">Seats</span><span class="val">${seats.seatsUsed} of ${
                  seats.package.includedSeats === null ? 'unlimited' : seats.package.includedSeats
                }</span></div>
                <div class="row"><span class="lbl">Storage</span><span class="val">${
                  seats.package.storageGb === null ? 'unlimited' : `${seats.package.storageGb} GB`
                }</span></div>
                <div class="row"><span class="lbl">Export, download and print</span><span class="val">${
                  seats.package.export ? badge('included', 'good') : badge('not on this plan', 'warn')
                }</span></div>
                <div class="row"><span class="lbl">API access</span><span class="val">${
                  seats.package.apiAccess ? badge('included', 'good') : badge('not on this plan', 'warn')
                }</span></div>
                <div class="row"><span class="lbl">Isolated tenancy</span><span class="val">${
                  seats.package.isolatedTenancy ? badge('included', 'good') : '—'
                }</span></div>
              </div>
              ${
                seats.package.export
                  ? ''
                  : html`<div class="notice warn" style="margin-top:11px">
                      Everything on this plan governs, records and computes. What it does not do is let a document leave —
                      exporting and printing need a paid subscription.
                    </div>`
              }
            </div>`
          : ''
      }

      <div class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h3>Available</h3>
          <div class="metric ${raw(wallet.aiHalted ? 'bad' : 'good')}">${exact(wallet.availableMinor)}</div>
          <div class="metric-sub">of ${exact(wallet.balanceMinor)} balance</div>
        </div>
        <div class="card">
          <h3>Held</h3>
          <div class="metric warn">${exact(wallet.heldMinor)}</div>
          <div class="metric-sub">ring-fenced against running executions</div>
        </div>
        <div class="card">
          <h3>Billed this month</h3>
          <div class="metric orange">${exact(wallet.monthBilledMinor)}</div>
          <div class="metric-sub">on ${exact(wallet.monthRawSpendMinor)} of provider cost</div>
        </div>
        <div class="card">
          <h3>Effective multiplier</h3>
          <div class="metric">${effective ? `${effective.toFixed(2)}×` : '—'}</div>
          <div class="metric-sub">charged over underlying compute cost</div>
        </div>
      </div>

      <div class="grid g-2-1" style="margin-bottom:14px">
        <div class="card pad0">
          <h3 style="padding:15px 17px 0">Cost attribution by engine</h3>
          ${table({
            headers: ['Engine', 'Executions', 'Provider cost', 'Billed', 'Share'],
            align: ['', 'num', 'num', 'num', ''],
            rows: attribution.attribution.map((a) => [
              humanise(a.module),
              a.calls,
              exact(a.rawCostMinor),
              exact(a.billedMinor),
              track(totalBilled === 0 ? 0 : (a.billedMinor / totalBilled) * 100),
            ]),
            empty: 'No AI usage recorded yet',
          })}
          <div style="padding:0 17px 15px"><div class="metric-sub">
            Every line traces to tenant, project, user, engine and feature — which is what makes an AI bill explainable rather than a lump sum.
          </div></div>
        </div>

        <div>
          <div class="card" style="margin-bottom:14px">
            <h3>Enforcement sequence</h3>
            <div class="split-list">
              <div class="row"><span class="lbl">1 · Route</span><span class="val">by engine and capability</span></div>
              <div class="row"><span class="lbl">2 · Reserve</span><span class="val">or the call never happens</span></div>
              <div class="row"><span class="lbl">3 · Execute</span><span class="val">structured output only</span></div>
              <div class="row"><span class="lbl">4 · Persist</span><span class="val">to the Golden Thread</span></div>
              <div class="row"><span class="lbl">5 · Debit</span><span class="val">only now</span></div>
            </div>
            <div class="metric-sub" style="margin-top:10px">
              A failed execution releases its hold. A failed write means no charge at all.
            </div>
          </div>

          <div class="card">
            <h3>AI control plane</h3>
            ${
              plane
                ? html`<div class="split-list">
                    <div class="row"><span class="lbl">Mode</span><span class="val">${plane.mode}</span></div>
                    <div class="row">
                      <span class="lbl">Reasoning</span>
                      <span class="val">${plane.reasoning.provider} ${badge(plane.reasoning.healthy ? 'healthy' : 'degraded', plane.reasoning.healthy ? 'ok' : 'bad')}</span>
                    </div>
                    <div class="row">
                      <span class="lbl">Perception</span>
                      <span class="val">${plane.perception.provider} ${badge(plane.perception.healthy ? 'healthy' : 'degraded', plane.perception.healthy ? 'ok' : 'bad')}</span>
                    </div>
                  </div>
                  <div class="metric-sub" style="margin-top:10px">Perception observes; reasoning decides. Both sit behind adapters, so neither is a dependency.</div>`
                : html`<div class="empty"><b>Not available</b></div>`
            }
          </div>
        </div>
      </div>

      <div class="card">
        <h3>Budget caps</h3>
        ${
          Object.keys(wallet.caps ?? {}).length === 0
            ? html`<div class="empty"><b>No caps configured</b>Monthly, per-project and per-module caps can be set to make AI spend predictable.</div>`
            : html`<div class="split-list">
                ${wallet.caps.monthlyMinor ? html`<div class="row"><span class="lbl">Monthly cap</span><span class="val">${exact(wallet.caps.monthlyMinor)}</span></div>` : ''}
              </div>`
        }
        <div class="metric-sub" style="margin-top:10px">
          Total lifetime: ${exact(wallet.lifetimeBilledMinor)} billed on ${exact(wallet.lifetimeRawCostMinor)} of provider cost across ${totalCalls} executions.
        </div>
      </div>
    `,
  );

  document.getElementById('topup')?.addEventListener('click', async () => {
    try {
      await api.post('/v1/billing/top-up', { amountMinor: 100_000 });
      toast('Wallet topped up', '£1,000.00 of prepaid ACU added', 'ok');
      await refreshContext();
      await billing(root);
    } catch (error) {
      toast('Top-up failed', error.message, 'err');
    }
  });

  document.getElementById('invoice')?.addEventListener('click', async () => {
    try {
      const invoice = await api.post('/v1/billing/invoice', { period: new Date().toISOString().slice(0, 7) });
      toast(
        `Invoice ${invoice.period}`,
        `Subscription ${exact(invoice.subscriptionMinor, invoice.currency)} + AI ${exact(invoice.aiUsageMinor, invoice.currency)} = ${exact(invoice.totalMinor, invoice.currency)}`,
        'ok',
      );
    } catch (error) {
      toast('Could not issue invoice', error.message, 'err');
    }
  });
}
