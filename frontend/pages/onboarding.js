import { api } from '../lib/api.js';
import { command } from '../lib/command.js';
import { head, refusal } from '../lib/estate.js';
import { badge, date, days, html, money, raw, render, table, time } from '../lib/ui.js';

/**
 * The onboarding queue.
 *
 * Everything between "somebody signed up" and "they are a working customer",
 * which is where accounts are lost silently. Four ways a new tenancy fails
 * without anybody being told:
 *
 * 1. **A trial ends** and nobody had the conversation.
 * 2. **Nobody can administer it** — the tenancy exists, it may even be paying,
 *    and there is no identity holding `ENTERPRISE_ADMIN`, so nothing can be
 *    configured and nobody can be invited.
 * 3. **A top-up was raised and never settled** — either the payment failed
 *    quietly or they changed their mind, and both are worth knowing.
 * 4. **Nothing was ever written** — they signed up, signed in once, and never
 *    used it.
 *
 * Each is derived rather than declared, so nobody has to remember to add a
 * tenancy to a queue for it to appear here.
 */

export async function onboarding(root) {
  const [estate, overview, events, forecast, requests] = await Promise.all([
    api.get('/v1/admin/tenants').catch((error) => ({ error })),
    api.get('/v1/admin/overview').catch(() => null),
    api.get('/v1/admin/events').catch(() => null),
    api.get('/v1/admin/forecast').catch(() => null),
    api.get('/v1/admin/requests').catch(() => null),
  ]);

  if (estate.error) {
    render(root, html`${head({ title: 'Onboarding queue' })}${refusal('The tenant estate', estate.error)}`);
    return;
  }

  const tenants = estate.tenants ?? [];
  const writesById = new Map((events?.byTenant ?? []).map((row) => [row.tenantId, row]));

  const now = Date.now();
  const ageDays = (iso) => Math.floor((now - new Date(iso).getTime()) / 86_400_000);

  // Closed tenancies are on the register and in no queue: nothing about them
  // is going to change.
  const open = tenants.filter((tenant) => !tenant.closedAt);
  // A paid package somebody signed up for and has not paid for. Nothing is
  // free unless the package is, so the tenancy waits here, read-only and
  // empty, until its first month settles — by card through Stripe, or by a
  // transfer the operator records against the reference on the row.
  const awaitingPayment = open.filter((tenant) => tenant.status === 'AWAITING_PAYMENT');
  const trials = open.filter((tenant) => tenant.tier === 'FREE_TRIAL' && tenant.status === 'ACTIVE');
  const unreachable = open.filter((tenant) => tenant.administrators === 0);
  const silent = open.filter((tenant) => (writesById.get(tenant.id)?.events ?? 0) === 0 && tenant.status !== 'AWAITING_PAYMENT');
  const unsettled = (forecast?.signals ?? []).filter((signal) => signal.id.startsWith('unsettled:'));
  const newThisMonth = open.filter((tenant) => ageDays(tenant.createdAt) <= 30);

  const nothingToDo =
    awaitingPayment.length === 0 && trials.length === 0 && unreachable.length === 0 && silent.length === 0 && unsettled.length === 0;

  render(
    root,
    html`
      ${head({
        title: 'Onboarding queue',
        intent:
          'Everything between somebody signing up and being a working customer. Each queue below is derived from the ' +
          'record rather than maintained by hand, so a tenancy cannot fail to appear because nobody remembered to add it.',
      })}

      ${requestsCard(requests)}

      <section class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h2>New in 30 days</h2>
          <div class="metric ${raw(newThisMonth.length > 0 ? 'good' : '')}">${newThisMonth.length}</div>
          <div class="metric-sub">tenancies created</div>
        </div>
        <div class="card ${raw(awaitingPayment.length > 0 ? 'warn' : '')}">
          <h2>Awaiting first payment</h2>
          <div class="metric ${raw(awaitingPayment.length > 0 ? 'warn' : '')}">${awaitingPayment.length}</div>
          <div class="metric-sub">paid packages signed up for and not yet paid</div>
        </div>
        <div class="card">
          <h2>On trial</h2>
          <div class="metric">${trials.length}</div>
          <div class="metric-sub">each ends, and then goes read-only</div>
        </div>
        <div class="card">
          <h2>Nobody can run it</h2>
          <div class="metric ${raw(unreachable.length > 0 ? 'bad' : '')}">${unreachable.length}</div>
          <div class="metric-sub">no identity holds ENTERPRISE_ADMIN</div>
        </div>
        <div class="card">
          <h2>Never used</h2>
          <div class="metric ${raw(silent.length > 0 ? 'warn' : '')}">${silent.length}</div>
          <div class="metric-sub">tenancies that have written nothing at all</div>
        </div>
      </section>

      ${nothingToDo
        ? html`<div class="empty">
            <b>Nothing is stuck.</b>Nobody is waiting to pay a first month, no trial is running, no tenancy is without an
            administrator, nothing has been raised and left unpaid, and every tenancy has written something. That is the
            queue being genuinely empty rather than not yet built.
          </div>`
        : ''}

      ${awaitingPayment.length > 0
        ? html`<div class="card pad0 warn" style="margin-bottom:14px" data-awaiting-payment>
            <h2 style="padding:15px 17px 0">Awaiting first payment ${badge(String(awaitingPayment.length), 'warn')}</h2>
            <div class="metric-sub" style="padding:0 17px 10px">
              Somebody signed up on a paid package and proved their address. Nothing is free unless the package is, so the
              tenancy exists, read-only and with an empty wallet, until its first month is paid — by card through the
              payment page, or by a transfer you record here against the reference they were shown. Recording it opens
              the tenancy and credits the month's AI allowance.
            </div>
            ${table({
              headers: ['Tenancy', 'Package', 'First month', 'Reference', 'Signed up', 'People', ''],
              align: ['', '', 'num', '', '', 'num', ''],
              rows: awaitingPayment.map((tenant) => {
                const charge = (tenant.charges ?? []).find((candidate) => candidate.status === 'DUE');
                return [
                  html`<b>${tenant.legalName}</b><div class="metric-sub">${tenant.jurisdiction} · ${tenant.currency}</div>`,
                  tenant.packageLabel ?? tenant.package,
                  money(charge?.amountMinor ?? tenant.outstandingMinor ?? tenant.monthlyPriceMinor),
                  charge ? html`<code>CX-${String(charge.id).slice(-8).toUpperCase()}</code>` : '—',
                  `${date(tenant.createdAt)} · ${days(ageDays(tenant.createdAt))} ago`,
                  tenant.identities,
                  charge
                    ? html`<button class="btn sm" data-settle-charge="${charge.id}" data-settle-tenant="${tenant.id}" data-name="${tenant.legalName}" data-amount="${charge.amountMinor}">Record payment</button>`
                    : html`<span class="metric-sub">no charge on record</span>`,
                ];
              }),
            })}
          </div>`
        : ''}

      ${newThisMonth.length > 0
        ? html`<div class="card pad0" style="margin-bottom:14px" data-new-signups>
            <h2 style="padding:15px 17px 0">Signed up in the last 30 days ${badge(String(newThisMonth.length), 'info')}</h2>
            <div class="metric-sub" style="padding:0 17px 10px">
              Every tenancy created in the window, whatever it is doing now — so a signup is on this screen the moment it
              exists, before any of the queues below has a reason to show it.
            </div>
            ${table({
              headers: ['Tenancy', 'Package', 'Status', 'Created', 'People', 'Paid to date'],
              align: ['', '', '', '', 'num', 'num'],
              rows: newThisMonth.map((tenant) => [
                html`<b>${tenant.legalName}</b><div class="metric-sub">${tenant.jurisdiction} · ${tenant.currency}</div>`,
                tenant.packageLabel ?? tenant.package,
                badge(
                  tenant.status === 'AWAITING_PAYMENT' ? 'awaiting first payment' : String(tenant.status).toLowerCase(),
                  tenant.status === 'ACTIVE' ? 'ok' : tenant.status === 'AWAITING_PAYMENT' ? 'warn' : 'bad',
                ),
                `${date(tenant.createdAt)} · ${days(ageDays(tenant.createdAt))} ago`,
                tenant.identities,
                money(tenant.lifetimeRevenueMinor),
              ]),
            })}
          </div>`
        : ''}

      ${unreachable.length > 0
        ? html`<div class="card pad0" style="margin-bottom:14px">
            <h2 style="padding:15px 17px 0">Nobody can run these ${badge(String(unreachable.length), 'bad')}</h2>
            <div class="metric-sub" style="padding:0 17px 10px">
              A tenancy with no administrator can invite nobody, configure nothing and pay for nothing, whatever tier it
              is on. Onboarding creates the tenancy and its first administrator together now, so this can only be an
              older one — and it cannot hide.
            </div>
            ${table({
              headers: ['Tenancy', 'Tier', 'Created', 'People', 'Paid to date'],
              align: ['', '', '', 'num', 'num'],
              rows: unreachable.map((tenant) => [
                tenant.legalName,
                tenant.tier,
                `${date(tenant.createdAt)} · ${days(ageDays(tenant.createdAt))} ago`,
                tenant.identities,
                money(tenant.lifetimeRevenueMinor),
              ]),
            })}
          </div>`
        : ''}

      ${trials.length > 0
        ? html`<div class="card pad0" style="margin-bottom:14px">
            <h2 style="padding:15px 17px 0">Trials running ${badge(String(trials.length), 'info')}</h2>
            <div class="metric-sub" style="padding:0 17px 10px">
              A trial that ends without a conversation does not convert — it goes read-only and the customer discovers
              that by being refused. The record column is what tells you whether there is anything to convert: somebody
              who has written nothing has not evaluated the product.
            </div>
            ${table({
              headers: ['Tenancy', 'Created', 'Ends', 'People', 'Record built', 'Credit left'],
              align: ['', '', '', 'num', 'num', 'num'],
              rows: trials.map((tenant) => {
                const written = writesById.get(tenant.id)?.events ?? 0;
                return [
                  tenant.legalName,
                  date(tenant.createdAt),
                  html`${date(tenant.renewsAt)}<div class="metric-sub">${days(
                    Math.max(0, Math.floor((new Date(tenant.renewsAt).getTime() - now) / 86_400_000)),
                  )} left</div>`,
                  tenant.identities,
                  written === 0 ? badge('nothing yet', 'warn') : written.toLocaleString('en-GB'),
                  money(tenant.wallet.availableMinor),
                ];
              }),
            })}
          </div>`
        : ''}

      ${unsettled.length > 0
        ? html`<div class="card pad0" style="margin-bottom:14px">
            <h2 style="padding:15px 17px 0">Raised and never paid ${badge(String(unsettled.length), 'warn')}</h2>
            <div class="metric-sub" style="padding:0 17px 10px">
              Somebody pressed top-up and nothing arrived. Either the payment rail failed silently or they changed their
              mind, and those need different answers.
            </div>
            ${table({
              headers: ['Tenancy', 'What happened', 'On what basis'],
              rows: unsettled.map((signal) => [signal.legalName, signal.headline, html`<span class="metric-sub">${signal.basis}</span>`]),
            })}
          </div>`
        : ''}

      ${silent.length > 0
        ? html`<div class="card pad0" style="margin-bottom:14px">
            <h2 style="padding:15px 17px 0">Signed up and never used it ${badge(String(silent.length), 'warn')}</h2>
            <div class="metric-sub" style="padding:0 17px 10px">
              Not one event on any of their chains. They have an account and have never done anything with it — which is
              the cheapest customer to save and the easiest one to never notice losing.
            </div>
            ${table({
              headers: ['Tenancy', 'Tier', 'Created', 'People', 'Administrators'],
              align: ['', '', '', 'num', 'num'],
              rows: silent.map((tenant) => [
                tenant.legalName,
                tenant.tier,
                `${date(tenant.createdAt)} · ${days(ageDays(tenant.createdAt))} ago`,
                tenant.identities,
                tenant.administrators === 0 ? badge('none', 'bad') : tenant.administrators,
              ]),
            })}
          </div>`
        : ''}

      ${overview
        ? html`<div class="card">
            <h2>How the estate has grown</h2>
            <div class="split-list" style="margin-top:8px">
              <div class="row"><span class="lbl">Tenancies</span><span class="val">${overview.tenancies.total}</span></div>
              <div class="row"><span class="lbl">Created in the last 30 days</span><span class="val">${overview.tenancies.newInWindow}</span></div>
              <div class="row"><span class="lbl">Active</span><span class="val">${overview.tenancies.active}</span></div>
              <div class="row"><span class="lbl">On trial</span><span class="val">${overview.tenancies.onTrial}</span></div>
              <div class="row"><span class="lbl">Suspended</span><span class="val">${overview.tenancies.suspended}</span></div>
              <div class="row"><span class="lbl">Cancelled</span><span class="val">${overview.tenancies.cancelled}</span></div>
              <div class="row"><span class="lbl">Identities</span><span class="val">${overview.identities.total}</span></div>
            </div>
            <div class="metric-sub" style="margin-top:12px">
              Registration is self-serve: a stranger verifies an address, and the tenancy and its first administrator are
              created together. A free package opens at once. A paid package waits, read-only, until its first month is
              paid — that is the one approval step, and it is the customer's money rather than your judgement that gives
              it. Everything else on this screen is about what happens after they are in.
            </div>
          </div>`
        : ''}
    `,
  );

  wireRequests(root, () => onboarding(root));

  // Recording a first month paid by transfer. The reference is the bank's, and
  // it is spent once: the same transfer recorded twice settles nothing further.
  for (const button of root.querySelectorAll('[data-settle-charge]')) {
    button.addEventListener('click', async () => {
      const { settleCharge, settleTenant, name, amount } = button.dataset;
      const result = await command({
        title: `${name} — record the first month paid`,
        intent:
          `${money(Number(amount))} received for the first month. Recording it settles the charge, opens the tenancy and ` +
          `credits the month's AI allowance. The reference is the bank's or provider's own, and is spent once.`,
        path: `/v1/admin/tenants/${settleTenant}/charges/${settleCharge}/settle`,
        submitLabel: 'Record payment and open the tenancy',
        fields: [
          { name: 'reference', label: 'Payment reference', hint: 'From the bank statement or the card provider. Unique for ever.' },
          {
            name: 'method',
            label: 'How it arrived',
            type: 'select',
            options: [
              { value: 'BANK_TRANSFER', label: 'Bank transfer' },
              { value: 'CARD', label: 'Card, taken outside the platform' },
              { value: 'INVOICE_SETTLEMENT', label: 'Invoice settlement' },
            ],
          },
          { name: 'note', label: 'Note', required: false },
        ],
      });
      if (result) onboarding(root);
    });
  }
}

// --- account requests: new → contacted → qualified → provisioned, or declined and deleted ---

const STEP_LABEL = { NEW: 'new', CONTACTED: 'contacted', QUALIFIED: 'qualified', PROVISIONED: 'provisioned', DECLINED: 'declined' };
const STEP_TONE = { NEW: 'info', CONTACTED: 'warn', QUALIFIED: 'ok', PROVISIONED: 'ok', DECLINED: 'neutral' };

function requestsCard(requests) {
  if (!requests) return '';
  const counts = requests.counts ?? {};
  return html`<div class="card pad0" style="margin-bottom:14px" data-requests>
    <h2 style="padding:15px 17px 0">
      Requests
      ${badge(`${counts.NEW ?? 0} new`, counts.NEW ? 'info' : 'neutral')}
      ${badge(`${counts.CONTACTED ?? 0} contacted`, 'neutral')}
      ${badge(`${counts.QUALIFIED ?? 0} qualified`, counts.QUALIFIED ? 'ok' : 'neutral')}
    </h2>
    <div class="metric-sub" style="padding:6px 17px 10px">
      Enterprise and group accounts asked for on the site. New → contacted → qualified → provisioned: the last is one act —
      the tenancy, its first administrator and the invitation to sign in. Declined requests can be deleted.
    </div>
    ${table({
      headers: ['Received', 'Organisation', 'Contact', 'Asked for', 'Status', 'Last note', ''],
      rows: (requests.requests ?? []).map((r) => [
        date(r.receivedAt),
        html`<b>${r.organisationName}</b><div class="metric-sub">${r.jurisdiction} · ${r.currency}</div>`,
        html`${r.contactName}<div class="metric-sub">${r.email}${r.phone ? ` · ${r.phone}` : ''}</div>`,
        html`${r.kind === 'GROUP' ? `Group, ${r.companies} companies` : 'Enterprise'}${r.message ? html`<div class="metric-sub" title="${r.message}">${r.message.slice(0, 90)}${r.message.length > 90 ? '…' : ''}</div>` : ''}`,
        badge(STEP_LABEL[r.status] ?? r.status, STEP_TONE[r.status] ?? 'neutral'),
        r.notes.length ? html`${r.notes[r.notes.length - 1].note || '—'}<div class="metric-sub">${date(r.notes[r.notes.length - 1].at)}</div>` : html`<span class="metric-sub">—</span>`,
        html`<span class="row-actions">
          ${r.status === 'NEW' ? html`<button class="btn quiet sm" data-request-action="CONTACTED" data-request="${r.id}" data-name="${r.organisationName}">Mark contacted</button>` : ''}
          ${r.status === 'CONTACTED' ? html`<button class="btn quiet sm" data-request-action="QUALIFIED" data-request="${r.id}" data-name="${r.organisationName}">Mark qualified</button>` : ''}
          ${r.status === 'QUALIFIED' ? html`<button class="btn sm" data-request-action="PROVISION" data-request="${r.id}" data-name="${r.organisationName}" data-kind="${r.kind}">Provision</button>` : ''}
          ${['NEW', 'CONTACTED', 'QUALIFIED'].includes(r.status) ? html`<button class="btn quiet danger sm" data-request-action="DECLINE" data-request="${r.id}" data-name="${r.organisationName}">Decline</button>` : ''}
          ${r.status === 'DECLINED' ? html`<button class="btn quiet danger sm" data-request-action="DELETE" data-request="${r.id}" data-name="${r.organisationName}">Delete</button>` : ''}
          ${r.status === 'PROVISIONED' && r.provisioned ? html`<span class="metric-sub">invitation ${String(r.provisioned.notified).toLowerCase()}</span>` : ''}
        </span>`,
      ]),
      empty: 'No request yet. They arrive from “Talk to us” on the public site.',
    })}
  </div>`;
}

function wireRequests(root, again) {
  for (const button of root.querySelectorAll('[data-request-action]')) {
    button.addEventListener('click', async () => {
      const { requestAction, request, name, kind } = button.dataset;
      let result = null;
      if (requestAction === 'CONTACTED' || requestAction === 'QUALIFIED') {
        result = await command({
          title: `${name} — mark ${STEP_LABEL[requestAction]}`,
          intent: requestAction === 'CONTACTED' ? 'You have been in touch. Note what was said.' : 'Terms are agreed in principle and this is a real customer. Note the basis; provisioning is the next step.',
          path: `/v1/admin/requests/${request}/advance`,
          submitLabel: `Mark ${STEP_LABEL[requestAction]}`,
          fields: [{ name: 'note', label: 'Note', required: false, placeholder: 'Spoke to them on the phone; sending terms' }],
          transform: (values) => ({ status: requestAction, ...(values.note ? { note: values.note } : {}) }),
        });
      }
      if (requestAction === 'DECLINE') {
        result = await command({
          title: `${name} — decline`,
          intent: 'The request comes to nothing. The reason is kept until the request is deleted.',
          path: `/v1/admin/requests/${request}/decline`,
          submitLabel: 'Decline',
          fields: [{ name: 'reason', label: 'Why' }],
        });
      }
      if (requestAction === 'DELETE') {
        if (!confirm(`Delete the request from ${name}? Their name, address and message go; the chain keeps that a request existed.`)) return;
        try {
          await api.delete(`/v1/admin/requests/${request}`);
          result = { deleted: true };
        } catch (error) {
          alert(error.message);
        }
      }
      if (requestAction === 'PROVISION') {
        result = await command({
          title: `Provision ${name}`,
          intent:
            'One act: the tenancy, its subscription and wallet, the contact as first administrator, and the invitation to sign in — ' +
            'emailed where a mail server is configured, recorded otherwise. Recorded in the ledger and not undone.' +
            (kind === 'GROUP' ? ' A group: provision the first company here, then create the group on Tenants & Users and bring the companies in.' : ''),
          path: `/v1/admin/requests/${request}/provision`,
          submitLabel: 'Provision',
          fields: [
            { name: 'tier', label: 'Tier', type: 'select', options: [{ value: 'ENTERPRISE', label: 'Enterprise' }, { value: 'BUSINESS', label: 'Business' }, { value: 'TEAM', label: 'Team' }] },
            { name: 'package', label: 'Package', type: 'select', options: [{ value: 'ENTERPRISE', label: 'Enterprise' }, { value: 'PROFESSIONAL_DELIVERY', label: 'Professional Delivery' }, { value: 'CORE_PROJECT', label: 'Core Project' }] },
            { name: 'enterpriseName', label: 'Enterprise name', required: false, hint: 'Defaults to the organisation name' },
          ],
          transform: (values) => ({ tier: values.tier, package: values.package, ...(values.enterpriseName ? { enterpriseName: values.enterpriseName } : {}) }),
        });
      }
      if (result) again();
    });
  }
}
