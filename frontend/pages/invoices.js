import { api } from '../lib/api.js';
import { head, refusal } from '../lib/estate.js';
import { badge, date, html, money, raw, render, table, time } from '../lib/ui.js';

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

      ${cardBroken || mobileBroken
        ? html`<div class="notice bad" style="margin-bottom:14px">
            <div>
              <b>Every ${cardBroken && mobileBroken ? 'webhook' : cardBroken ? 'card webhook' : 'mobile money webhook'} so far
              has been rejected.</b><br />
              A signing secret can be present and wrong. When it is, customers pay, the platform refuses the delivery,
              and nothing is credited — so the customer has paid and has no service. Check the secret against the
              endpoint in the provider's dashboard.
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
          <div class="metric-sub" style="margin-top:12px">
            ${payments.cardPayments.configured
              ? 'A rejection is a signature that did not verify. A handful is somebody probing the endpoint; a rising count with no acceptances is the secret being wrong.'
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
