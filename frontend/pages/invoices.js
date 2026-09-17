import { api } from '../lib/api.js';
import { barChart, lineChart, pieChart, waterfallChart } from '../lib/charts.js';
import { head, refusal } from '../lib/estate.js';
import { badge, date, html, humanise, money, raw, render, table, time } from '../lib/ui.js';

/**
 * Billing and invoices.
 *
 * Money in, and the rails it arrives on. Two things here were previously
 * reachable only by reading three screens and joining them by hand.
 *
 * **A webhook secret can be present and wrong.** Rejections climbing while
 * acceptances stay at zero is exactly that, and nothing else — customers pay,
 * deliveries are refused, and nothing is credited. The panel says so rather than
 * showing two numbers and leaving somebody to spot the pattern.
 *
 * **A top-up raised and never settled is not a failure the platform reports.**
 * The customer pressed the button; either the rail failed quietly or they
 * changed their mind. Both need somebody to look.
 */

/** The verdict's own name, in words rather than as a constant. */
const STATE_LABEL = {
  HEALTHY: 'Deliveries are verifying',
  NEVER_DELIVERED: 'Nothing has reached this endpoint',
  ALL_REFUSED: 'Every delivery is being refused',
  SOME_REFUSED: 'Some deliveries are being refused',
  NOT_CONFIGURED: 'This rail is not keyed',
  SECRET_MALFORMED: 'The configured signing secret is the wrong shape',
};

const STATE_TONE = {
  HEALTHY: 'ok',
  NEVER_DELIVERED: 'warn',
  ALL_REFUSED: 'bad',
  SOME_REFUSED: 'warn',
  NOT_CONFIGURED: 'warn',
  SECRET_MALFORMED: 'bad',
};

export async function invoices(root) {
  const [payments, overview, estate] = await Promise.all([
    api.get('/v1/admin/payments').catch((error) => ({ error })),
    api.get('/v1/admin/overview').catch(() => null),
    api.get('/v1/admin/tenants').catch(() => null),
  ]);

  if (payments.error) {
    render(root, html`${head({ title: 'Billing & invoices' })}${refusal('The payment position', payments.error)}`);
    return;
  }

  const names = new Map((estate?.tenants ?? []).map((tenant) => [tenant.id, tenant.legalName]));
  const cardBroken = payments.cardPayments.webhook.rejected > 0 && payments.cardPayments.webhook.accepted === 0;
  const mobileBroken = payments.mobileMoney.webhook.rejected > 0 && payments.mobileMoney.webhook.accepted === 0;

  /**
   * The rail's own verdict, rendered.
   *
   * Every word of it comes from the API. The browser decides nothing about why
   * a webhook is failing: the platform knows which refusal it issued, and a
   * second copy of that reasoning here would be a second thing to keep true.
   */
  const railPanel = (rail) => {
    const { diagnosis, secret, webhook } = rail;
    if (!diagnosis) return '';
    const tone = STATE_TONE[diagnosis.state] ?? 'warn';
    const codes = Object.entries(webhook.byCode ?? {}).sort((a, b) => b[1] - a[1]);
    return html`
      <div class="notice ${raw(tone === 'ok' ? '' : tone === 'warn' ? 'warn' : 'bad')}" style="margin-top:10px">
        <div>
          <b>${STATE_LABEL[diagnosis.state] ?? diagnosis.state}</b>
          ${diagnosis.moneyAtRisk ? badge('money at risk', 'bad') : ''}<br />
          ${diagnosis.because}<br />
          <b>Next:</b> ${diagnosis.remedy}
          ${webhook.lastRejection
            ? html`<br /><span class="metric-sub">Last refusal ${webhook.lastRejection.code} at ${time(webhook.lastRejection.at)}${
                webhook.firstRejectionAt ? html`, first at ${time(webhook.firstRejectionAt)}` : ''
              }.</span>`
            : ''}
          ${codes.length > 1
            ? html`<br /><span class="metric-sub">Refusals by code: ${raw(codes.map(([code, count]) => `${code} ×${count}`).join(', '))}</span>`
            : ''}
          ${secret && secret.present
            ? html`<br /><span class="metric-sub">The configured signing secret is ${secret.length} characters${
                secret.prefixOk === false ? ' and does not begin whsec_' : secret.prefixOk === true ? ', prefixed whsec_' : ''
              }${secret.padded ? ', with whitespace around it' : ''}${secret.quoted ? ', wrapped in quotes' : ''}. Its value is never read here.</span>`
            : ''}
        </div>
      </div>
    `;
  };

  render(
    root,
    html`
      ${head({
        title: 'Billing & invoices',
        intent:
          'Every payment the platform has received, everything raised and not yet settled, and whether the rails that ' +
          'carry them are working. Nothing here is a projection.',
      })}

      ${overview
        ? html`<section class="grid g4" style="margin-bottom:14px">
            <div class="card">
              <h2>Received today</h2>
              <div class="metric">${money(overview.revenue.todayMinor)}</div>
              <div class="metric-sub">${overview.revenue.receipts} receipts recorded in total</div>
            </div>
            <div class="card">
              <h2>Month to date</h2>
              <div class="metric">${money(overview.revenue.monthToDateMinor)}</div>
              <div class="metric-sub">against ${money(overview.revenue.previousMonthMinor)} last month</div>
            </div>
            <div class="card">
              <h2>Lifetime</h2>
              <div class="metric orange">${money(overview.revenue.lifetimeMinor)}</div>
              <div class="metric-sub">every settled payment since launch</div>
            </div>
            <div class="card">
              <h2>Raised and unsettled</h2>
              <div class="metric ${raw(overview.awaitingPayment.count > 0 ? 'warn' : '')}">${money(overview.awaitingPayment.amountMinor)}</div>
              <div class="metric-sub">${overview.awaitingPayment.count} top-up${overview.awaitingPayment.count === 1 ? '' : 's'} awaiting payment</div>
            </div>
          </section>`
        : ''}

      ${invoiceCharts(overview, payments, estate)}

      ${cardBroken || mobileBroken
        ? html`<div class="notice bad" style="margin-bottom:14px">
            <div>
              <b>Every ${cardBroken && mobileBroken ? 'webhook' : cardBroken ? 'card webhook' : 'mobile money webhook'} so far
              has been rejected.</b><br />
              ${cardBroken ? payments.cardPayments.diagnosis?.because ?? '' : payments.mobileMoney.diagnosis?.because ?? ''}
              ${cardBroken && mobileBroken ? html`<br />${payments.mobileMoney.diagnosis?.because ?? ''}` : ''}<br />
              <b>Next:</b> ${cardBroken ? payments.cardPayments.diagnosis?.remedy ?? '' : payments.mobileMoney.diagnosis?.remedy ?? ''}
            </div>
          </div>`
        : ''}

      <div class="grid g2" style="margin-bottom:14px">
        <div class="card">
          <h2>Card ${badge(payments.cardPayments.configured ? 'keyed' : 'not keyed', payments.cardPayments.configured ? 'ok' : 'warn')}</h2>
          <div class="split-list" style="margin-top:8px">
            <div class="row"><span class="lbl">Webhooks accepted</span><span class="val">${payments.cardPayments.webhook.accepted}</span></div>
            <div class="row">
              <span class="lbl">Webhooks rejected</span>
              <span class="val">${badge(String(payments.cardPayments.webhook.rejected), payments.cardPayments.webhook.rejected > 0 ? 'warn' : 'ok')}</span>
            </div>
          </div>
          ${railPanel(payments.cardPayments)}
          <div class="metric-sub" style="margin-top:12px">
            ${payments.cardPayments.configured
              ? 'A refusal is not always a bad signature. The panel above names the one this deployment actually issued; the tally is since the last restart, so a deploy zeroes it.'
              : 'No card rail is keyed on this deployment, so nobody can pay by card. Top-ups can still be credited by hand against a bank transfer.'}
          </div>
        </div>
        <div class="card">
          <h2>Mobile money ${badge(payments.mobileMoney.configured ? 'keyed' : 'not keyed', payments.mobileMoney.configured ? 'ok' : 'warn')}</h2>
          <div class="split-list" style="margin-top:8px">
            <div class="row"><span class="lbl">Accepted</span><span class="val">${payments.mobileMoney.webhook.accepted}</span></div>
            <div class="row">
              <span class="lbl">Rejected</span>
              <span class="val">${badge(String(payments.mobileMoney.webhook.rejected), payments.mobileMoney.webhook.rejected > 0 ? 'warn' : 'ok')}</span>
            </div>
            <div class="row"><span class="lbl">USD per GBP</span><span class="val">${payments.mobileMoney.usdPerGbp}</span></div>
          </div>
          ${railPanel(payments.mobileMoney)}
          <div class="metric-sub" style="margin-top:12px">
            The rate is quoted onto the intent when it is raised, so somebody mid-payment gets what they were quoted
            even if this figure moves underneath them.
          </div>
        </div>
      </div>

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">
          Awaiting payment
          ${(payments.awaitingPayment ?? []).length > 0 ? badge(String(payments.awaitingPayment.length), 'warn') : ''}
        </h2>
        <div class="metric-sub" style="padding:0 17px 10px">
          Raised by a customer and never settled. Credit one from the tenancy screen once the money has actually
          arrived — the reference is the idempotency key, so the same reference twice credits once.
        </div>
        ${table({
          headers: ['Raised', 'Tenancy', 'Amount', 'Currency', 'Raised by'],
          align: ['', '', 'num', '', ''],
          rows: (payments.awaitingPayment ?? []).map((intent) => [
            time(intent.requestedAt),
            names.get(intent.tenantId) ?? intent.tenantId,
            money(intent.amountMinor),
            intent.currency,
            intent.requestedBy,
          ]),
          empty: 'Nothing is awaiting payment.',
        })}
      </div>

      <div class="card pad0">
        <h2 style="padding:15px 17px 0">Every receipt</h2>
        <div class="metric-sub" style="padding:0 17px 10px">
          Money the platform has actually been sent. A receipt is written once against its reference and cannot be
          written again — which is what stops a retried webhook crediting a wallet twice.
        </div>
        ${table({
          headers: ['Received', 'Tenancy', 'Amount', 'How', 'Reference', 'Note'],
          align: ['', '', 'num', '', '', ''],
          rows: (payments.receipts ?? []).map((receipt) => [
            time(receipt.recordedAt),
            names.get(receipt.tenantId) ?? receipt.tenantId,
            money(receipt.amountMinor),
            badge(String(receipt.method).replace(/_/g, ' ').toLowerCase(), 'info'),
            html`<span class="mono" style="font-size:11px">${receipt.reference}</span>`,
            receipt.note ?? '—',
          ]),
          empty: 'No payment has been recorded.',
        })}
      </div>
    `,
  );
}

/**
 * The money, and the rails carrying it.
 *
 * Four tiles give today, month to date, lifetime and unsettled. They are four
 * true numbers that cannot be read against each other: "month to date against
 * last month" is a comparison the tile makes in words and the reader has to do
 * in their head.
 *
 * **Nothing here is a projection.** The month-to-date bar is what has been
 * received so far this month, not a run rate extrapolated to month end. The
 * platform publishes a run rate and its basis separately, and where the basis
 * is absent the run rate is `null` rather than a number — so it is stated
 * below the chart in the platform's own words rather than drawn as a trend.
 */
function invoiceCharts(overview, payments, estate) {
  if (!overview) return '';

  const revenue = overview.revenue ?? {};
  const periods = [
    { label: 'Previous month', value: Number(revenue.previousMonthMinor ?? 0) },
    { label: 'Month to date', value: Number(revenue.monthToDateMinor ?? 0) },
    { label: 'Today', value: Number(revenue.todayMinor ?? 0) },
  ];

  const byMethod = (revenue.byMethod ?? [])
    .map((entry) => ({ label: humanise(String(entry.method ?? entry.label ?? 'Other')), value: Number(entry.amountMinor ?? entry.value ?? 0) }))
    .filter((slice) => slice.value > 0);

  const byTier = (overview.tenancies?.byTier ?? [])
    .map((entry) => ({ label: humanise(String(entry.tier ?? entry.label ?? 'Other')), value: Number(entry.count ?? entry.value ?? 0) }))
    .filter((slice) => slice.value > 0);

  // Received, then what is raised and not settled, then what that would make
  // the position. A waterfall rather than two bars: the unsettled figure is
  // only meaningful as a movement on the received one.
  const position = [
    { label: 'Received, lifetime', value: Number(revenue.lifetimeMinor ?? 0) },
    { label: 'Raised, unsettled', value: Number(overview.awaitingPayment?.amountMinor ?? 0), tone: 'warn' },
    { label: 'If all settled', value: 0, total: true },
  ];

  const webhooks = [
    { label: 'Card accepted', value: Number(payments?.cardPayments?.webhook?.accepted ?? 0), tone: 'ok' },
    { label: 'Card rejected', value: Number(payments?.cardPayments?.webhook?.rejected ?? 0), tone: 'bad' },
    { label: 'Mobile money accepted', value: Number(payments?.mobileMoney?.webhook?.accepted ?? 0), tone: 'ok' },
    { label: 'Mobile money rejected', value: Number(payments?.mobileMoney?.webhook?.rejected ?? 0), tone: 'bad' },
  ].filter((row) => row.value > 0);

  return html`
    <div class="grid g2" style="margin-bottom:14px">
      <div class="card">
        <h2>This month against last</h2>
        ${raw(
          lineChart({
            title: 'Revenue received',
            data: periods,
            markers: true,
            format: (value) => money(value),
            empty: 'Nothing has been received yet.',
            footnote:
              (revenue.runRateMinor === null || revenue.runRateMinor === undefined
                ? 'No run rate is published: the platform will not project one without a basis for it. '
                : `Run rate ${money(revenue.runRateMinor)} on ${humanise(String(revenue.runRateBasis ?? 'unknown'))}. `) +
              'Month to date is what has arrived, not what the month is expected to close at.',
          }),
        )}
      </div>
      <div class="card">
        <h2>What is in and what is owed</h2>
        ${raw(
          waterfallChart({
            title: 'Position if everything raised settled',
            steps: position,
            format: (value) => money(value),
            empty: 'Nothing has been received or raised.',
            footnote:
              `${overview.awaitingPayment?.count ?? 0} top-up${(overview.awaitingPayment?.count ?? 0) === 1 ? '' : 's'} awaiting payment. ` +
              'Raised is not revenue and is never counted as it — it is shown as the movement it would be.',
          }),
        )}
      </div>
    </div>

    <div class="grid g2" style="margin-bottom:14px">
      <div class="card">
        <h2>How people are paying</h2>
        ${raw(
          pieChart({
            title: 'Receipts by method',
            data: byMethod,
            centreLabel: String(revenue.receipts ?? 0),
            format: (value) => money(value),
            empty: 'No payment has been settled through any rail yet.',
            footnote:
              'A rail with no share and a keyed configuration is a rail nobody has used. A rail with no share and no key ' +
              'is one that would refuse anything sent to it — the panels below say which.',
          }),
        )}
      </div>
      <div class="card">
        <h2>${byTier.length > 0 ? 'What the estate is on' : 'What the rails have been sent'}</h2>
        ${raw(
          byTier.length > 0
            ? barChart({
                title: 'Tenancies by tier',
                horizontal: true,
                data: byTier,
                format: (value) => `${value} tenanc${value === 1 ? 'y' : 'ies'}`,
                empty: 'No tenancy is on a tier.',
                footnote: `${overview.tenancies?.active ?? 0} active · ${overview.tenancies?.awaitingPayment ?? 0} awaiting first payment · ${overview.tenancies?.onTrial ?? 0} on trial.`,
              })
            : barChart({
                title: 'Webhook deliveries by rail',
                horizontal: true,
                data: webhooks,
                format: (value) => `${value} delivery${value === 1 ? '' : 'ies'}`,
                empty: 'No webhook has reached this deployment.',
                footnote:
                  'A rail rejecting everything it is sent is usually not keyed rather than broken. The diagnosis on each ' +
                  'panel below says which, and what to set.',
              }),
        )}
      </div>
    </div>
  `;
}
