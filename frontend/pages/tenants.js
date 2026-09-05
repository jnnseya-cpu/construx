import { api } from '../lib/api.js';
import { lineChart } from '../lib/charts.js';
import { command } from '../lib/command.js';
import { gb, head, refusal } from '../lib/estate.js';
import { badge, date, html, money, raw, render, table, time, toast, track } from '../lib/ui.js';

const BAND_TONE = { STRONG: 'ok', WORKABLE: 'warn', WEAK: 'bad' };
const PRIORITY_TONE = { HIGH: 'bad', MEDIUM: 'warn', LOW: 'info' };

/**
 * A recommendation's door is the row control of the same name. Clicking it runs
 * the handler the operator would have reached by hand, so there is one command
 * per act on this screen and the engine adds none of its own — except
 * `settle-charge`, which has no row control here and records a subscription
 * payment against the charge the engine named.
 */
const ROW_DOORS = {
  status: 'data-status',
  close: 'data-close',
  delete: 'data-delete',
  unfreeze: 'data-unfreeze',
  package: 'data-package',
  people: 'data-people',
  'resolve-exception': 'data-resolve-exception',
  settle: 'data-settle',
};

/**
 * Tenants and users.
 *
 * The estate, and the two commands that change it: credit a wallet against a
 * payment already received, and turn a paying customer's platform off. Both
 * were routes only their author could call before they had a door here.
 *
 * **Commercial terms and credit only.** An operator cannot open a project, a
 * package or a daily log from this screen — not because it declines to show
 * them, but because the account layer refuses to serve them at all. The one
 * thing this screen shows about *people* is how many there are and whether
 * anybody can administer the tenancy, because a tenancy with no administrator
 * can invite nobody and configure nothing, whatever it is paying.
 */

/** Whether the private-module register shows revoked grants. Off until asked; a reload starts folded again. */
let showRevoked = false;

export async function tenants(root) {
  const [estate, vocab, register, refunds, groupsHeld, transfers, exceptions, engine] = await Promise.all([
    api.get('/v1/admin/tenants').catch((error) => ({ error })),
    api.get('/v1/signup/account-types').catch(() => null),
    api.get('/v1/admin/modules').catch(() => null),
    api.get('/v1/admin/refunds').catch(() => null),
    api.get('/v1/admin/groups').catch(() => null),
    api.get('/v1/admin/transfer-cases').catch(() => null),
    api.get('/v1/admin/payments/exceptions').catch(() => null),
    api.get('/v1/admin/tenants/position').catch((error) => ({ error })),
  ]);

  if (estate.error) {
    render(root, html`${head({ title: 'Tenants & users' })}${refusal('The tenant estate', estate.error)}`);
    return;
  }

  const rows = estate.tenants ?? [];
  const byId = new Map(rows.map((tenant) => [tenant.id, tenant]));
  const unreachable = rows.filter((tenant) => tenant.administrators === 0);
  const eng = engine && !engine.error ? engine : null;
  const attention = new Map((eng?.attention ?? []).map((entry) => [entry.tenantId, entry.flags]));
  const totals = eng?.results.totals;

  render(
    root,
    html`
      ${head({
        title: 'Tenants & users',
        intent:
          'Commercial terms, credit and headcount. An operator cannot open a project, a package or a daily log from ' +
          'here — the account layer refuses to serve them, which is a stronger guarantee than this screen not asking.',
        actions:
          '<button class="btn primary" data-command="onboard">Onboard a tenancy</button>' +
          '<button class="btn quiet" data-command="operator">Appoint an operator</button>' +
          '<button class="btn quiet" data-command="group">Create a group</button>' +
          '<button class="btn quiet" data-command="onboard-group">Onboard a group</button>' +
          '<button class="btn quiet" data-command="support">Support access</button>',
      })}

      ${engine?.error ? refusal('The estate position', engine.error) : ''}

      ${eng
        ? html`<section class="grid g4" style="margin-bottom:14px">
            <div class="card">
              <h2>Estate health</h2>
              <div class="metric ${raw(eng.health.band === 'STRONG' ? 'good' : eng.health.band === 'WORKABLE' ? 'warn' : 'bad')}">${eng.health.score}</div>
              <div class="metric-sub">${eng.health.passing} of ${eng.health.total} checks passing · ${eng.health.band.toLowerCase()}</div>
            </div>
            <div class="card">
              <h2>Customers</h2>
              <div class="metric">${totals.tenancies.open}</div>
              <div class="metric-sub">
                ${totals.tenancies.active} active · ${totals.tenancies.awaitingPayment} awaiting a first payment ·
                ${totals.tenancies.suspended + totals.tenancies.cancelled} switched off · ${totals.tenancies.closed} closed
              </div>
            </div>
            <div class="card">
              <h2>People who can sign in</h2>
              <div class="metric">${totals.people.active}</div>
              <div class="metric-sub">
                ${totals.people.administrators} administrator${totals.people.administrators === 1 ? '' : 's'} · ${totals.people.deactivated} deactivated ·
                ${totals.people.pendingErasure} awaiting erasure
              </div>
            </div>
            <div class="card ${raw(totals.money.outstandingMinor + totals.money.refundsDueMinor > 0 ? 'warn' : '')}">
              <h2>Money in motion</h2>
              <div class="metric ${raw(totals.money.outstandingMinor > 0 ? 'warn' : '')}">${money(totals.money.outstandingMinor)}</div>
              <div class="metric-sub">
                subscription owed to the platform · ${money(totals.money.refundsDueMinor)} owed back ·
                ${totals.money.openExceptions} open exception${totals.money.openExceptions === 1 ? '' : 's'} · ${totals.money.frozenWallets} frozen
              </div>
            </div>
          </section>`
        : ''}

      ${eng && eng.recommendations.length > 0
        ? html`<div class="card" style="margin-bottom:14px" data-recommendations>
            <h2>What the agent recommends</h2>
            <div class="metric-sub" style="margin:8px 0 12px">
              Derived from the subscriptions, the charges, the receipts, the identities and the wallets — no model, no
              invented figure. Each names what is wrong and opens the same door the row already carries. It proposes; you
              press.
            </div>
            <div class="split-list">
              ${eng.recommendations.map(
                (item) => html`<div class="row" style="align-items:flex-start;gap:14px">
                  <span class="lbl" style="flex:1 1 0;min-width:0">
                    ${badge(item.priority.toLowerCase(), PRIORITY_TONE[item.priority] ?? 'info')} <b>${item.title}</b><br />
                    <span class="metric-sub">${item.detail}</span>
                  </span>
                  ${item.action
                    ? html`<span class="val"><button class="btn quiet sm" data-act="${item.action.command}" data-tenant="${item.action.tenantId ?? ''}" data-charge="${item.action.chargeId ?? ''}" data-ref="${item.action.refundId ?? item.action.exceptionId ?? ''}">${item.action.label}</button></span>`
                    : ''}
                </div>`,
              )}
            </div>
          </div>`
        : ''}

      ${eng
        ? html`<div class="card" style="margin-bottom:14px" data-sweep>
            <h2>Estate sweep ${badge(`${eng.health.score} / 100`, BAND_TONE[eng.health.band] ?? 'neutral')}</h2>
            <div class="metric-sub" style="margin:8px 0 12px">
              ${eng.health.summary} Every check reads the record — subscriptions, charges, receipts, identities, wallets,
              the storage meter — never a setting that says it is fine. Customers only; the demonstration and the
              platform’s own tenancy are counted by none of it. The score decides nothing.
            </div>
            ${raw(
              table({
                headers: ['Check', 'Verdict', 'Weight', 'Detail'],
                align: ['', '', 'num', ''],
                rows: eng.sweep.map((finding) => [html`<b>${finding.check}</b>`, finding.ok ? badge('ok', 'ok') : badge('fix', 'bad'), String(finding.weight), finding.detail]),
              }),
            )}
          </div>`
        : ''}

      ${eng && eng.results.series.length > 0
        ? html`<div class="grid g2" style="margin-bottom:14px">
            <div class="card chart-card">
              <h2>Tenancies by month</h2>
              <div class="metric-sub" style="margin-bottom:12px">Customer tenancies that joined and that were closed, by the month it happened.</div>
              ${lineChart({
                title: 'Joined and closed, by month',
                data: eng.results.series.map((entry) => ({ label: entry.month, joined: entry.joined, closed: entry.closed })),
                series: [
                  { key: 'joined', label: 'Joined' },
                  { key: 'closed', label: 'Closed' },
                ],
                format: (value) => String(Math.round(value)),
                empty: 'No tenancy yet.',
              })}
            </div>
            <div class="card chart-card">
              <h2>Receipts by month</h2>
              <div class="metric-sub" style="margin-bottom:12px">Settled receipts from customers, by the month the money arrived. Demonstration credit is not revenue.</div>
              ${lineChart({
                title: 'Revenue received, by month',
                data: eng.results.series.map((entry) => ({ label: entry.month, revenue: entry.revenueMinor / 100 })),
                series: [{ key: 'revenue', label: 'Received' }],
                format: (value) => money(Math.round(value * 100)),
                empty: 'No receipt yet.',
              })}
            </div>
          </div>`
        : ''}

      <section class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h2>Tenancies</h2>
          <div class="metric">${rows.length}</div>
          <div class="metric-sub">${rows.filter((tenant) => tenant.status === 'ACTIVE').length} active</div>
        </div>
        <div class="card">
          <h2>People</h2>
          <div class="metric">${rows.reduce((sum, tenant) => sum + tenant.identities, 0)}</div>
          <div class="metric-sub">
            ${rows.reduce((sum, tenant) => sum + tenant.seatsUsed, 0)} seats assigned across the estate
          </div>
        </div>
        <div class="card">
          <h2>Lifetime revenue</h2>
          <div class="metric orange">${money(rows.reduce((sum, tenant) => sum + tenant.lifetimeRevenueMinor, 0))}</div>
          <div class="metric-sub">settled receipts, summed by tenancy</div>
        </div>
        <div class="card">
          <h2>No administrator</h2>
          <div class="metric ${raw(unreachable.length > 0 ? 'bad' : '')}">${unreachable.length}</div>
          <div class="metric-sub">tenancies nobody can run</div>
        </div>
      </section>

      ${unreachable.length > 0
        ? html`<div class="notice bad" style="margin-bottom:14px">
            <div>
              <b>${unreachable.length} tenanc${unreachable.length === 1 ? 'y has' : 'ies have'} no administrator.</b><br />
              Nobody can invite anybody, configure anything or pay. Onboarding makes this impossible now; an older
              tenancy in that state cannot hide. ${unreachable.map((tenant) => tenant.legalName).join(' · ')}
            </div>
          </div>`
        : ''}

      ${estate.estate
        ? html`<div class="card" style="margin-bottom:14px">
            <h2>Storage across the estate</h2>
            <div class="metric-sub" style="margin:8px 0 12px">
              ${gb(estate.estate.heldBytes)} held against ${gb(estate.estate.committedBytes)} committed. Committed is
              what the platform has <i>promised</i>, and it arrives the day a tenancy signs rather than as it uploads —
              so the volume has to stay ahead of held, with headroom.
            </div>
            ${track(
              estate.estate.committedBytes > 0 ? (estate.estate.heldBytes / estate.estate.committedBytes) * 100 : 0,
              estate.estate.atLimit > 0 ? 'bad' : estate.estate.atWarning > 0 ? 'warn' : '',
            )}
            <div class="split-list" style="margin-top:12px">
              <div class="row"><span class="lbl">Tenancies</span><span class="val">${estate.estate.tenancies}</span></div>
              <div class="row"><span class="lbl">At warning</span><span class="val">${estate.estate.atWarning}</span></div>
              <div class="row"><span class="lbl">At limit</span><span class="val">${estate.estate.atLimit}</span></div>
            </div>
          </div>`
        : ''}

      <div class="card pad0">
        <h2 style="padding:15px 17px 0">Every tenancy</h2>
        ${table({
          headers: ['Tenant', 'Tier', 'Status', 'People', 'Seats', 'Storage', 'Lifetime revenue', 'ACU available', 'Renews', ''],
          align: ['', '', '', 'num', 'num', 'num', 'num', 'num', '', ''],
          rows: rows.map((tenant) => [
            html`${tenant.legalName}
              ${
                // Not a customer. Listed because an operator credits and
                // inspects it; marked because its credit, seats and renewal are
                // counted in none of the figures on the screens around this one.
                tenant.demonstration ? badge('demonstration', 'info') : ''
              }${
                // The operator has given this package away: no monthly charge
                // is raised. The wallet is still the tenancy's own to fund.
                tenant.grantedFree ? badge('free of charge', 'ai') : ''
              }${
                // What the estate sweep found wrong with this tenancy, on the
                // row, so the register and the engine tell one story.
                (attention.get(tenant.id) ?? []).map((flag) => badge(flag, flag === 'ready to delete' ? 'neutral' : 'bad'))
              }<div class="metric-sub">${tenant.jurisdiction} · ${
              tenant.isolatedTenancy ? 'dedicated tenancy' : 'shared tenancy'
            }${tenant.referralCode ? ` · referred by ${tenant.referralCode}` : ''}</div>
              ${
                // On the row itself, because a module is capability handed to
                // this company off the price list — it belongs beside the
                // commercial terms rather than on a panel further down that
                // somebody has to know to read.
                (tenant.modules ?? []).map((module) => badge(module.name, 'ai'))
              }`,
            badge(tenant.tier, tenant.tier === 'ENTERPRISE' || tenant.tier === 'SOVEREIGN' ? 'ai' : 'info'),
            tenant.closedAt
              ? html`${badge('closed', 'bad')}<div class="metric-sub">${date(tenant.closedAt)}</div>`
              : tenant.status === 'AWAITING_PAYMENT'
                ? html`${badge('awaiting first payment', 'warn')}<div class="metric-sub">${money(tenant.outstandingMinor)} due · Onboarding queue</div>`
                : html`${badge(tenant.status, tenant.status === 'ACTIVE' ? 'ok' : 'warn')}${
                    tenant.outstandingMinor > 0 ? html`<div class="metric-sub">${money(tenant.outstandingMinor)} unpaid</div>` : ''
                  }`,
            tenant.administrators === 0
              ? badge('no administrator', 'bad')
              : `${tenant.identities} (${tenant.administrators} admin${tenant.administrators === 1 ? '' : 's'})`,
            `${tenant.seatsUsed} / ${
              tenant.seatsIncluded === null || tenant.seatsIncluded === undefined
                ? '∞'
                : tenant.seatsIncluded + (tenant.seatsPurchased ?? 0)
            }${tenant.seatsPurchased > 0 ? ` (${tenant.seatsPurchased} bought)` : ''}`,
            html`${gb(tenant.storage.usedBytes)}${
              tenant.storage.state !== 'OK' ? badge(tenant.storage.state.toLowerCase(), tenant.storage.state === 'FULL' ? 'bad' : 'warn') : ''
            }`,
            money(tenant.lifetimeRevenueMinor),
            money(tenant.wallet.availableMinor),
            date(tenant.renewsAt),
            tenant.closedAt
              ? html`<span class="metric-sub">Closed — record kept, read-only</span>
                  <button class="btn quiet danger sm" data-delete="${tenant.id}" data-name="${tenant.legalName}" data-people="${tenant.identities}">Delete</button>`
              : html`<button class="btn quiet sm" data-credit="${tenant.id}">Credit</button>
                <button class="btn quiet sm" data-reverse="${tenant.id}">Refund / chargeback</button>
                  <button class="btn quiet sm" data-package="${tenant.id}">Package</button>
                  <button class="btn quiet sm" data-status="${tenant.id}">Status</button>
                  <button class="btn quiet sm" data-modules="${tenant.id}">Modules</button>
                  <button class="btn quiet sm" data-people="${tenant.id}">People</button>
                  ${tenant.demonstration ? '' : html`<button class="btn quiet danger sm" data-close="${tenant.id}">Close</button>`}`,
          ]),
          empty: 'No tenancy on the estate yet.',
        })}
      </div>

      ${eng
        ? html`<div class="card" style="margin-top:14px">
            <h2>What this engine does not do</h2>
            <ul class="metric-sub" style="margin:8px 0 0 18px;line-height:1.6">
              ${eng.limits.map((limit) => html`<li>${limit}</li>`)}
            </ul>
          </div>`
        : ''}

      ${refunds
        ? html`<div class="card" style="margin-top:14px" data-refunds>
            <h2>Refunds owed</h2>
            <p class="metric-sub" style="margin-bottom:12px">
              What closed tenancies are owed: the unspent part of what they paid into their wallet, and the unused days of a
              subscription period they had already paid for. This deployment has no rail that moves money back on its own, so
              each is paid by the operator and recorded here with the payment reference.
              ${refunds.dueMinor > 0 ? html`<b>${money(refunds.dueMinor)} due now.</b>` : 'Nothing is due.'}
            </p>
            ${table({
              headers: ['Tenancy', 'Wallet', 'Subscription', 'Total', 'Raised', 'Status', ''],
              rows: (refunds.refunds ?? []).map((refund) => [
                html`<b>${refund.legalName}</b><div class="metric-sub">${refund.reason}</div>`,
                money(refund.walletMinor),
                money(refund.subscriptionMinor),
                money(refund.totalMinor),
                date(refund.raisedAt),
                refund.status === 'SETTLED'
                  ? html`${badge('paid', 'good')}<div class="metric-sub">${refund.settlementReference} · ${date(refund.settledAt)}</div>`
                  : badge('due', 'warn'),
                refund.status === 'DUE'
                  ? html`<button class="btn quiet sm" data-settle="${refund.id}" data-name="${refund.legalName}">Record payment</button>`
                  : '',
              ]),
              empty: 'No tenancy has been closed with money owed.',
            })}
          </div>`
        : ''}

      ${exceptions
        ? html`<div class="card" style="margin-top:14px" data-payment-exceptions>
            <h2>Payment exceptions</h2>
            <p class="metric-sub" style="margin-bottom:12px">
              Money that went back after it was spent — a refund or chargeback against credit already consumed on AI — or a subscription
              payment undone. Each is an explicit record; nothing is rewritten and no sibling wallet is touched. A disputed payment
              freezes the wallet until you lift it here.
              ${exceptions.frozenWallets.length ? html`<b>${exceptions.frozenWallets.length} wallet${exceptions.frozenWallets.length === 1 ? '' : 's'} frozen.</b>` : ''}
            </p>
            ${table({
              headers: ['Tenancy', 'Kind', 'Reversed', 'Shortfall', 'Why', 'Raised', 'Status', ''],
              rows: (exceptions.exceptions ?? []).map((e) => [
                html`<b>${e.legalName}</b><div class="metric-sub">${e.reference}</div>`,
                badge(e.kind.toLowerCase(), e.kind === 'DISPUTE' ? 'bad' : 'warn'),
                money(e.amountMinor),
                money(e.shortfallMinor),
                html`<span class="metric-sub">${e.reason}</span>`,
                date(e.raisedAt),
                e.status === 'RESOLVED' ? html`${badge('resolved', 'good')}<div class="metric-sub">${e.resolution}</div>` : badge('open', 'warn'),
                html`<span class="row-actions">
                  ${e.status === 'OPEN' ? html`<button class="btn quiet sm" data-resolve-exception="${e.id}" data-name="${e.legalName}">Resolve</button>` : ''}
                  ${e.walletFrozen ? html`<button class="btn quiet sm" data-unfreeze="${e.tenantId}" data-name="${e.legalName}">Unfreeze wallet</button>` : ''}
                </span>`,
              ]),
              empty: 'No payment has been reversed after it was spent.',
            })}
          </div>`
        : ''}

      ${register
        ? html`<div class="card pad0" style="margin-top:14px">
            <h2 style="padding:15px 17px 0">Private modules</h2>
            <div class="metric-sub" style="padding:6px 17px 0">
              Capability that is not part of the subscription and is not on the pricing page. A tenancy without the
              grant is never told the module exists; a tenancy with it keeps everything else it holds, unchanged.
            </div>
            ${register.modules.map(
              (definition) => html`<div style="padding:12px 17px 0">
                <b>${definition.name}</b>
                <div class="metric-sub" style="margin-top:4px">${definition.summary}</div>
                <div class="metric-sub" style="margin-top:4px">${definition.restricted}</div>
              </div>`,
            )}
            <div style="padding:12px 0 0">
              ${register.grants.some((grant) => grant.status !== 'ACTIVE')
                ? html`<div class="metric-sub" style="padding:0 17px 8px">
                    ${register.grants.filter((grant) => grant.status === 'ACTIVE').length} live grant${register.grants.filter((grant) => grant.status === 'ACTIVE').length === 1 ? '' : 's'} ·
                    ${register.grants.filter((grant) => grant.status !== 'ACTIVE').length} revoked, kept for access review and hidden here —
                    <button class="btn quiet sm" type="button" data-show-revoked>Show revoked</button>
                  </div>`
                : ''}
              ${table({
                headers: ['Tenancy', 'Module', 'Status', 'Granted', 'Reason', 'Revoked', ''],
                rows: register.grants.filter((grant) => grant.status === 'ACTIVE' || showRevoked).map((grant) => [
                  grant.legalName,
                  grant.moduleName,
                  badge(grant.status.toLowerCase(), grant.status === 'ACTIVE' ? 'ok' : 'warn'),
                  html`${date(grant.grantedAt)}<div class="metric-sub">${grant.grantedByName}</div>`,
                  grant.status === 'ACTIVE' ? grant.reason : grant.revokedReason ?? grant.reason,
                  grant.revokedAt
                    ? html`${date(grant.revokedAt)}<div class="metric-sub">${grant.revokedByName}</div>`
                    : '—',
                  grant.status === 'ACTIVE'
                    ? html`<button class="btn quiet danger sm" data-module-decision="REVOKED" data-tenant="${grant.tenantId}" data-module="${grant.moduleId}" data-name="${grant.legalName}" data-module-name="${grant.moduleName}">Revoke</button>`
                    : html`<button class="btn quiet sm" data-module-decision="ACTIVE" data-tenant="${grant.tenantId}" data-module="${grant.moduleId}" data-name="${grant.legalName}" data-module-name="${grant.moduleName}">Grant again</button>`,
                ]),
                // Revoked grants stay on the record on purpose: "who had this,
                // and between which dates" is what an access review asks. They
                // are folded away by default so the register reads as what is
                // live, and shown on request.
                empty: register.grants.length ? 'No module is live. Revoked grants are folded away above.' : 'No module has been granted to anybody.',
              })}
            </div>
          </div>`
        : ''}

      <div class="card pad0" style="margin-top:14px" data-groups>
        <h2 style="padding:15px 17px 0">Groups</h2>
        <div class="metric-sub" style="padding:6px 17px 10px">
          One licence agreement and one statement over several companies. A company is a tenancy — its own people,
          records, wallet and identity — and joins a group with a cost centre. Up to five companies to a group.
        </div>
        ${(groupsHeld?.groups ?? []).length === 0
          ? html`<div class="metric-sub" style="padding:0 17px 15px">No group yet. Create one, then bring tenancies in as its companies.</div>`
          : (groupsHeld.groups ?? []).map(
              (g) => html`<div style="padding:8px 17px 14px;border-top:1px solid var(--line)">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
                  <div><b>${g.displayName}</b> <span class="metric-sub">${g.slug} · ${g.billing.currency} · ${g.billing.invoiceMode.toLowerCase()} · ${g.billing.termsDays} day terms</span></div>
                  <span class="row-actions">
                    <button class="btn quiet sm" data-group-action="attach" data-group="${g.id}" data-name="${g.displayName}">Bring a company in</button>
                    <button class="btn quiet sm" data-group-action="billing" data-group="${g.id}" data-name="${g.displayName}">Billing terms</button>
                    <button class="btn quiet sm" data-group-action="agreement" data-group="${g.id}" data-name="${g.displayName}" data-currency="${g.billing.currency}">Agreement</button>
                    <button class="btn quiet sm" data-group-action="credit" data-group="${g.id}" data-name="${g.displayName}" data-currency="${g.billing.currency}">Credit the group</button>
                    <button class="btn quiet sm" data-group-action="role" data-group="${g.id}" data-name="${g.displayName}">Group role</button>
                  </span>
                </div>
                ${table({
                  headers: ['Cost centre', 'Company', 'Charge mode', 'Rate card', 'Joined', ''],
                  rows: g.companies.map((c) => [
                    html`<b>${c.code}</b><div class="metric-sub">${c.slug}</div>`,
                    html`${c.name}<div class="metric-sub">${c.jurisdiction}${c.closed ? ' · closed' : ''}</div>`,
                    c.chargeMode.toLowerCase(),
                    c.rateCard.toLowerCase(),
                    date(c.joinedAt),
                    html`<span class="row-actions">
                      <button class="btn quiet sm" data-group-action="centre" data-group="${g.id}" data-tenant="${c.tenantId}" data-name="${c.name}" data-code="${c.code}" data-mode="${c.chargeMode}" data-card="${c.rateCard}">Cost centre</button>
                      <button class="btn quiet sm" data-group-action="readiness" data-group="${g.id}" data-tenant="${c.tenantId}" data-name="${c.name}">Readiness</button>
                      <button class="btn quiet sm" data-group-action="verify" data-group="${g.id}" data-tenant="${c.tenantId}" data-name="${c.name}">Verify issuer</button>
                      <button class="btn quiet sm" data-group-action="transfer" data-group="${g.id}" data-tenant="${c.tenantId}" data-name="${c.name}">Transfer</button>
                    </span>`,
                  ]),
                  empty: 'No company in this group yet.',
                })}
              </div>`,
            )}
      </div>

      ${(transfers?.cases ?? []).length
        ? html`<div class="card pad0" style="margin-top:14px" data-transfers>
            <h2 style="padding:15px 17px 0">Transfer cases</h2>
            <div class="metric-sub" style="padding:6px 17px 10px">
              A company moving between groups keeps its identity, people, records, wallet and issued documents. The case is reviewed,
              approved by the company’s own administrator, scheduled, then executed: the old group’s reach ends, the new relation opens.
            </div>
            ${table({
              headers: ['Company', 'From', 'To', 'Standing', 'Effective', 'Approvals', ''],
              rows: transfers.cases.map((t) => [
                html`<b>${t.companyName}</b><div class="metric-sub">${t.reason}</div>`,
                t.fromGroupName,
                html`${t.toGroupName}<div class="metric-sub">as ${t.code}</div>`,
                html`${badge(t.status.toLowerCase(), t.status === 'COMPLETED' ? 'ok' : t.status === 'FAILED' ? 'bad' : t.status === 'CANCELLED' ? 'neutral' : 'warn')}${t.error ? html`<div class="metric-sub">${t.error}</div>` : ''}`,
                t.effectiveAt ? date(t.effectiveAt) : html`<span class="metric-sub">not set</span>`,
                t.approvals.map((a) => a.capacity.toLowerCase().replace('_', ' ')).join(', ') || html`<span class="metric-sub">none</span>`,
                html`<span class="row-actions">
                  ${t.status === 'DRAFT' ? html`<button class="btn quiet sm" data-transfer-action="review" data-case="${t.id}" data-name="${t.companyName}">Review</button>` : ''}
                  ${t.status === 'REVIEW' ? html`<button class="btn quiet sm" data-transfer-action="schedule" data-case="${t.id}" data-name="${t.companyName}">Schedule</button>` : ''}
                  ${t.status === 'SCHEDULED' ? html`<button class="btn sm" data-transfer-action="execute" data-case="${t.id}" data-name="${t.companyName}">Execute</button>` : ''}
                  ${['DRAFT', 'REVIEW', 'SCHEDULED', 'FAILED'].includes(t.status) ? html`<button class="btn quiet sm" data-transfer-action="cancel" data-case="${t.id}" data-name="${t.companyName}">Cancel</button>` : ''}
                </span>`,
              ]),
            })}
          </div>`
        : ''}
      <div id="support-panel"></div>
    `,
  );

  const again = () => tenants(root);

  root.querySelector('[data-show-revoked]')?.addEventListener('click', () => {
    showRevoked = !showRevoked;
    again();
  });

  // The engine's doors. Every command but one clicks the row control of the
  // same name, so the act is the one the operator would have pressed by hand.
  for (const button of root.querySelectorAll('[data-act]')) {
    button.addEventListener('click', async () => {
      const act = button.getAttribute('data-act');
      const tenantId = button.getAttribute('data-tenant');
      const ref = button.getAttribute('data-ref');
      if (act === 'onboard') {
        root.querySelector('.cmd-bar [data-command="onboard"]')?.click();
        return;
      }
      if (act === 'settle-charge') {
        const chargeId = button.getAttribute('data-charge');
        const tenant = byId.get(tenantId);
        const charge = (tenant?.charges ?? []).find((entry) => entry.id === chargeId);
        const result = await command({
          title: `Record a subscription payment — ${tenant?.legalName ?? 'tenancy'}`,
          intent:
            `${charge ? money(charge.amountMinor) : 'The amount'} for the period from ${charge ? date(charge.periodStart) : 'the charge named'} was received outside the platform. ` +
            'Recording it settles the charge; a tenancy waiting for its first month opens and its AI allowance is credited. The reference is the bank’s or provider’s own, and is spent once.',
          path: `/v1/admin/tenants/${tenantId}/charges/${chargeId}/settle`,
          submitLabel: 'Record payment',
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
                { value: 'CREDIT_NOTE', label: 'Credit note' },
                { value: 'MANUAL_ADJUSTMENT', label: 'Manual adjustment' },
              ],
            },
            { name: 'note', label: 'Note', required: false },
          ],
          transform: (values) => ({ reference: values.reference, method: values.method, ...(values.note ? { note: values.note } : {}) }),
        });
        if (result) {
          toast(result.alreadyRecorded ? 'Already recorded' : 'Payment recorded', `${tenant?.legalName ?? 'Tenancy'} · ${result.status.toLowerCase().replace('_', ' ')}`, result.alreadyRecorded ? 'warn' : 'ok');
          await again();
        }
        return;
      }
      const attribute = ROW_DOORS[act];
      const target = attribute ? root.querySelector('[' + attribute + '="' + (act === 'settle' || act === 'resolve-exception' ? ref : tenantId) + '"]') : null;
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.click();
      } else {
        toast('No door for that here', 'The row this recommendation points at is not on the register any more. Reload the screen.', 'warn');
      }
    });
  }

  /**
   * Break-glass support access: one company at a time, from a select, so the
   * command that opens it posts to that company's own path.
   */
  function renderSupportPanel() {
    const panel = root.querySelector('#support-panel');
    render(
      panel,
      html`<div class="card" style="margin-top:14px" data-support>
        <h2>Support access</h2>
        <div class="metric-sub" style="margin:6px 0 10px">
          Break-glass. A time-boxed, logged window on one company’s governance record, against a ticket. The company sees
          it was opened, by whom, why, and every read made through it. It opens nothing else.
        </div>
        <div class="actions" style="flex-wrap:wrap;gap:10px;align-items:center">
          <select id="support-tenant">${tenantOptions.map((option) => html`<option value="${option.value}">${option.label}</option>`)}</select>
          <button class="btn" data-support-action="open">Open a window</button>
          <button class="btn quiet" data-support-action="read">Read under an open window</button>
        </div>
        <div id="support-result" style="margin-top:12px"></div>
      </div>`,
    );
    panel.querySelector('[data-support-action="open"]')?.addEventListener('click', async () => {
      const tenantId = panel.querySelector('#support-tenant').value;
      const result = await command({
        title: `Open support access — ${byId.get(tenantId)?.legalName ?? tenantId}`,
        intent: 'The reason is read by the company. Five minutes to four hours.',
        path: `/v1/admin/tenants/${tenantId}/support-access`,
        submitLabel: 'Open',
        fields: [
          { name: 'ticketRef', label: 'Ticket', placeholder: 'SUP-4411' },
          { name: 'reason', label: 'Why, in the company’s words', placeholder: 'Customer reports a missing gate decision' },
          { name: 'minutes', label: 'Window, minutes', type: 'number', value: 60 },
        ],
        transform: (values) => ({ ticketRef: values.ticketRef, reason: values.reason, minutes: Number(values.minutes) }),
      });
      if (result) toast('Support access open', `Until ${time(result.expiresAt)} · ticket ${result.ticketRef}`, 'ok');
    });
    panel.querySelector('[data-support-action="read"]')?.addEventListener('click', async () => {
      const tenantId = panel.querySelector('#support-tenant').value;
      const host = panel.querySelector('#support-result');
      try {
        const read = await api.get(`/v1/admin/tenants/${tenantId}/support-access/audit`);
        render(
          host,
          html`<div class="notice"><div><b>${read.company.name}</b> · ticket ${read.grant.ticketRef} · window until ${time(read.grant.expiresAt)} · ${read.grant.uses.length} read${read.grant.uses.length === 1 ? '' : 's'} recorded
            <button class="btn quiet sm" style="margin-left:10px" data-support-close="${read.grant.id}" data-support-tenant="${tenantId}">Close the window</button></div></div>
            ${table({
              headers: ['When', 'What', 'On', 'By'],
              rows: read.events.slice(-100).reverse().map((e) => [time(e.timestamp), e.eventType, e.entity.refType, e.actor.refId]),
              empty: 'Nothing on the record in this window.',
            })}`,
        );
        host.querySelector('[data-support-close]')?.addEventListener('click', async (event) => {
          try {
            await api.post(`/v1/admin/tenants/${event.target.dataset.supportTenant}/support-access/${event.target.dataset.supportClose}/close`, {});
            toast('Support access closed', 'The company sees the window ended.', 'ok');
            render(host, html``);
          } catch (error) {
            toast('Could not close', error.message, 'err');
          }
        });
      } catch (error) {
        render(host, html`<div class="notice warn"><div><b>${error.code ?? 'Refused'}</b><br />${error.message}</div></div>`);
      }
    });
  }

  for (const button of root.querySelectorAll('[data-group-action]')) {
    button.addEventListener('click', async () => {
      const { groupAction, group: groupId, name, tenant, code, mode, card } = button.dataset;
      let result = null;
      if (groupAction === 'attach') {
        const inGroups = new Set((groupsHeld?.groups ?? []).flatMap((g) => g.companies.map((c) => c.tenantId)));
        result = await command({
          title: `Bring a company into ${name}`,
          intent: 'The tenancy keeps everything it has and gains a cost centre. A tenancy is in one group at most.',
          path: `/v1/admin/groups/${groupId}/companies`,
          submitLabel: 'Bring in',
          fields: [
            { name: 'tenantId', label: 'Company', type: 'select', options: tenantOptions.filter((option) => !inGroups.has(option.value)) },
            { name: 'code', label: 'Cost centre code', placeholder: 'ETX', hint: '2 to 8 letters or digits, unique in the group' },
            { name: 'slug', label: 'Slug', required: false, hint: 'Made from the legal name when blank' },
            { name: 'chargeMode', label: 'Charge mode', type: 'select', options: [{ value: 'INTERNAL', label: 'Internal — tracked, not invoiced' }, { value: 'INTERCOMPANY', label: 'Intercompany — cross-charged' }, { value: 'EXTERNAL', label: 'External — invoiced' }] },
            { name: 'rateCard', label: 'Rate card', type: 'select', options: [{ value: 'GROUP_INTERNAL', label: 'Group internal' }, { value: 'ENTERPRISE_GROUP', label: 'Enterprise group' }, { value: 'RETAIL', label: 'Retail' }] },
          ],
          transform: (values) => ({ ...values, ...(values.slug ? {} : { slug: undefined }) }),
        });
      }
      if (groupAction === 'billing') {
        result = await command({
          title: `${name} — billing terms`,
          intent: 'Invoice mode, payment terms and the payment provider’s customer reference. Nothing here moves money.',
          path: `/v1/admin/groups/${groupId}/billing`,
          method: 'PUT',
          submitLabel: 'Save',
          fields: [
            { name: 'invoiceMode', label: 'Invoicing', type: 'select', options: [{ value: 'CONSOLIDATED', label: 'One consolidated statement' }, { value: 'PER_COMPANY', label: 'One per company' }] },
            { name: 'termsDays', label: 'Payment terms, days', type: 'number', value: 14 },
            { name: 'paymentCustomerRef', label: 'Payment customer reference', required: false },
          ],
          transform: (values) => ({ invoiceMode: values.invoiceMode, termsDays: Number(values.termsDays), ...(values.paymentCustomerRef ? { paymentCustomerRef: values.paymentCustomerRef } : {}) }),
        });
      }
      if (groupAction === 'role') {
        result = await command({
          title: `${name} — grant a group role`,
          intent: 'To somebody already in one of the group’s companies. This is how the first group administrator is appointed.',
          path: `/v1/admin/groups/${groupId}/roles`,
          submitLabel: 'Grant',
          fields: [
            { name: 'email', label: 'Their email' },
            { name: 'role', label: 'Role', type: 'select', options: [{ value: 'GROUP_ADMIN', label: 'Group admin' }, { value: 'GROUP_FINANCE', label: 'Group finance' }, { value: 'GROUP_VIEWER', label: 'Group viewer' }] },
          ],
        });
      }
      if (groupAction === 'agreement') {
        const inGroup = (groupsHeld?.groups ?? []).find((g) => g.id === groupId)?.companies ?? [];
        const party = (label) => [
          { name: `${label}LegalName`, label: `${label === 'seller' ? 'Seller' : 'Payer'} — legal name`, placeholder: label === 'seller' ? 'CONSTRUX (the vendor)' : 'The paying legal entity' },
          { name: `${label}TenantId`, label: `${label === 'seller' ? 'Seller' : 'Payer'} — one of the group’s companies?`, type: 'select', required: false, options: [{ value: '', label: 'No — an entity outside the platform' }, ...inGroup.map((c) => ({ value: c.tenantId, label: c.name }))] },
        ];
        result = await command({
          title: `${name} — agreement terms`,
          intent: 'A new draft version the group approves on its Group screen. Mode is a billing choice: every mode meters seats, AI, documents and storage the same way. Parties are legal entities, never a display name.',
          path: `/v1/admin/groups/${groupId}/agreement`,
          method: 'PUT',
          submitLabel: 'Set as a draft',
          fields: [
            { name: 'mode', label: 'Mode', type: 'select', options: [{ value: 'INTERNAL_COST_ALLOCATION', label: 'Internal cost allocation — statement, no sale' }, { value: 'INVOICED_INTERCOMPANY', label: 'Invoiced intercompany — related-party invoice' }, { value: 'EXTERNAL_ENTERPRISE', label: 'External enterprise — customer invoice' }] },
            ...party('seller'),
            ...party('payer'),
            { name: 'currency', label: 'Currency', value: button.dataset.currency },
            { name: 'cadence', label: 'Billing cadence', type: 'select', options: [{ value: 'MONTHLY', label: 'Monthly' }, { value: 'QUARTERLY', label: 'Quarterly' }, { value: 'ANNUAL', label: 'Annual' }] },
            { name: 'effectiveFrom', label: 'Effective from', type: 'date', iso: true, required: false },
            { name: 'groupInternalDiscount', label: 'Group internal rate card — discount % off list', type: 'number', value: 0, placeholder: '0' },
            { name: 'enterpriseGroupDiscount', label: 'Enterprise group rate card — discount % off list', type: 'number', value: 0, placeholder: '0' },
            { name: 'retailDiscount', label: 'Retail rate card — discount % off list', type: 'number', value: 0, placeholder: '0' },
            { name: 'note', label: 'Note', type: 'textarea', required: false, placeholder: 'Terms as approved by finance on …' },
          ],
          transform: (v) => ({
            mode: v.mode,
            seller: { legalName: v.sellerLegalName, tenantId: v.sellerTenantId || null },
            payer: { legalName: v.payerLegalName, tenantId: v.payerTenantId || null },
            currency: v.currency,
            cadence: v.cadence,
            ...(v.effectiveFrom ? { effectiveFrom: v.effectiveFrom } : {}),
            rateCards: {
              GROUP_INTERNAL: { discountPercent: Number(v.groupInternalDiscount || 0) },
              ENTERPRISE_GROUP: { discountPercent: Number(v.enterpriseGroupDiscount || 0) },
              RETAIL: { discountPercent: Number(v.retailDiscount || 0) },
            },
            ...(v.note ? { note: v.note } : {}),
          }),
        });
      }
      if (groupAction === 'credit') {
        const inGroup = (groupsHeld?.groups ?? []).find((g) => g.id === groupId)?.companies ?? [];
        result = await command({
          title: `${name} — record a group purchase`,
          intent:
            'Group money funding the companies’ AI wallets. One payment, one reference; you say which company gets how much, and the allocations must total the amount exactly — nothing is spread or guessed. Each company is credited as its own receipt under the reference and its cost centre code.',
          path: `/v1/admin/groups/${groupId}/credit`,
          submitLabel: 'Record and credit',
          fields: [
            { name: 'amountMinor', label: 'Amount received (pence)', type: 'number', hint: 'In minor units of the billing currency. £500 is 50000.' },
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
            { name: 'reference', label: 'Payment reference', hint: 'The bank’s or provider’s identifier. Unique for ever; the companies’ receipts carry it with their cost centre code.' },
            ...inGroup.map((c) => ({ name: `alloc:${c.tenantId}`, label: `${c.name} (${c.code}) — allocation (pence)`, type: 'number', required: false, placeholder: '0' })),
            { name: 'note', label: 'Note', required: false },
          ],
          transform: (v) => ({
            amountMinor: Number(v.amountMinor),
            method: v.method,
            reference: v.reference,
            allocations: inGroup.map((c) => ({ tenantId: c.tenantId, amountMinor: Number(v[`alloc:${c.tenantId}`] || 0) })).filter((a) => a.amountMinor > 0),
            ...(v.note ? { note: v.note } : {}),
          }),
        });
        if (result) toast(result.alreadyRecorded ? 'Already recorded' : 'Group purchase recorded', result.wallets.map((w) => `${w.code} now ${money(w.availableMinor)}`).join(' · '), result.alreadyRecorded ? 'warn' : 'ok');
      }
      if (groupAction === 'readiness') {
        const host = root.querySelector('#support-panel');
        try {
          const readiness = await api.get(`/v1/admin/tenants/${tenant}/readiness`);
          const light = (r) => (r.ready ? badge('ready', 'ok') : html`${badge('not ready', 'warn')} <span class="metric-sub">${r.missing.join('; ')}</span>`);
          render(host, html`<div class="card" style="margin-top:14px"><h2>${name} — readiness</h2>
            <div class="split-list">
              <div class="row"><span class="lbl">Operational</span><span class="val">${light(readiness.operational)}</span></div>
              <div class="row"><span class="lbl">Billing</span><span class="val">${light(readiness.billing)}</span></div>
              <div class="row"><span class="lbl">Document issuance</span><span class="val">${light(readiness.issuance)}</span></div>
              <div class="row"><span class="lbl">Registered issuer</span><span class="val">${readiness.legal.verification.toLowerCase()}${readiness.legal.complete ? '' : html` · missing ${readiness.legal.missing.join(', ')}`}</span></div>
            </div>
            <div class="metric-sub" style="margin-top:8px">Three lights, kept apart. None is made green by guessing a detail: the company enters its registered issuer; you verify it.</div>
          </div>`);
        } catch (error) {
          render(host, html`<div class="notice warn"><div>${error.message}</div></div>`);
        }
        return;
      }
      if (groupAction === 'verify') {
        result = await command({
          title: `${name} — verify the registered issuer`,
          intent: 'Records that the details the company declared were checked against the register. A new profile version on the company’s chain under your name. Refused while the details are incomplete.',
          path: `/v1/admin/tenants/${tenant}/issuer/verify`,
          submitLabel: 'Record as verified',
          fields: [{ name: 'note', label: 'What was checked', placeholder: 'Companies House 12345678, matches registered name and address' }],
        });
        if (result) toast('Issuer verified', `${name} · profile version ${result.version}`, 'ok');
        return;
      }
      if (groupAction === 'transfer') {
        result = await command({
          title: `Transfer ${name} to another group`,
          intent: 'Opens a case; nothing moves. The destination is checked at review, the company’s administrator approves on Team & Access, you schedule the effective date, then execute.',
          path: `/v1/admin/tenants/${tenant}/transfer-cases`,
          submitLabel: 'Open the case',
          fields: [
            { name: 'toGroupId', label: 'Destination group', type: 'select', options: (groupsHeld?.groups ?? []).filter((g) => g.id !== groupId).map((g) => ({ value: g.id, label: g.displayName })) },
            { name: 'code', label: 'Cost centre code there', placeholder: 'ETX' },
            { name: 'chargeMode', label: 'Charge mode there', type: 'select', options: [{ value: 'INTERNAL', label: 'Internal' }, { value: 'INTERCOMPANY', label: 'Intercompany' }, { value: 'EXTERNAL', label: 'External' }] },
            { name: 'reason', label: 'Why', type: 'textarea', placeholder: 'Sale of the subsidiary completed on …' },
          ],
        });
      }
      if (groupAction === 'centre') {
        result = await command({
          title: `${name} — cost centre`,
          intent: 'Whether this company is invoiced, cross-charged or only tracked, and on which rate card. Usage is metered either way.',
          path: `/v1/admin/groups/${groupId}/companies/${tenant}/cost-centre`,
          method: 'PUT',
          submitLabel: 'Save',
          fields: [
            { name: 'code', label: 'Cost centre code', value: code },
            { name: 'chargeMode', label: 'Charge mode', type: 'select', value: mode, options: [{ value: 'INTERNAL', label: 'Internal — tracked, not invoiced' }, { value: 'INTERCOMPANY', label: 'Intercompany — cross-charged' }, { value: 'EXTERNAL', label: 'External — invoiced' }] },
            { name: 'rateCard', label: 'Rate card', type: 'select', value: card, options: [{ value: 'GROUP_INTERNAL', label: 'Group internal' }, { value: 'ENTERPRISE_GROUP', label: 'Enterprise group' }, { value: 'RETAIL', label: 'Retail' }] },
          ],
        });
      }
      if (result) again();
    });
  }

  for (const button of root.querySelectorAll('[data-transfer-action]')) {
    button.addEventListener('click', async () => {
      const { transferAction, case: caseId, name } = button.dataset;
      try {
        let result = null;
        if (transferAction === 'review') {
          result = await api.post(`/v1/admin/transfer-cases/${caseId}/review`, {});
          toast('In review', `${name}: destination checked; the company administrator approves on Team & Access.`, 'ok');
        }
        if (transferAction === 'schedule') {
          result = await command({
            title: `Schedule the transfer of ${name}`,
            intent: 'Needs the company administrator’s approval first. Billing switches at the effective date: the old group’s statement carries the company up to it, the new group’s from it.',
            path: `/v1/admin/transfer-cases/${caseId}/schedule`,
            submitLabel: 'Schedule',
            fields: [{ name: 'effectiveAt', label: 'Effective', type: 'date', iso: true }],
          });
        }
        if (transferAction === 'execute') {
          result = await command({
            title: `Execute the transfer of ${name}`,
            intent: 'The cutover: the destination is checked again, the old group’s reporting grants, shares and group roles over this company end, the company leaves the old group and joins the new one. A failed check leaves it where it is.',
            path: `/v1/admin/transfer-cases/${caseId}/execute`,
            submitLabel: 'Execute',
            fields: [],
          });
          if (result) toast(result.status === 'COMPLETED' ? 'Transferred' : 'Not transferred', result.status === 'COMPLETED' ? `${name} has moved.` : result.error ?? result.status, result.status === 'COMPLETED' ? 'ok' : 'err');
        }
        if (transferAction === 'cancel') {
          result = await command({
            title: `Cancel the transfer of ${name}`,
            path: `/v1/admin/transfer-cases/${caseId}/cancel`,
            submitLabel: 'Cancel the case',
            fields: [{ name: 'reason', label: 'Why' }],
          });
        }
        if (result) again();
      } catch (error) {
        toast('Could not do that', error.message, 'err');
      }
    });
  }

  const tenantOptions = rows.filter((tenant) => tenant.id !== 'platform').map((tenant) => ({ value: tenant.id, label: tenant.legalName }));

  root.querySelector('.cmd-bar')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;

    if (button.dataset.command === 'group') {
      const result = await command({
        title: 'Create a group',
        intent: 'One agreement, one statement, several companies. The slug becomes the group’s permanent identifier.',
        path: '/v1/admin/groups',
        submitLabel: 'Create',
        fields: [
          { name: 'displayName', label: 'Group name', placeholder: 'Groupe Nseya' },
          { name: 'slug', label: 'Slug', required: false, placeholder: 'groupe-nseya', hint: 'Letters, digits and dashes. Made from the name when blank.' },
          { name: 'currency', label: 'Billing currency', type: 'select', options: (vocab?.currencies ?? []).map((c) => ({ value: c.code, label: `${c.code} — ${c.name}` })) },
          { name: 'invoiceMode', label: 'Invoicing', type: 'select', options: [{ value: 'CONSOLIDATED', label: 'One consolidated statement to the group' }, { value: 'PER_COMPANY', label: 'One per company from the same account' }] },
          { name: 'termsDays', label: 'Payment terms, days', type: 'number', value: 14 },
        ],
        transform: (values) => ({ ...values, termsDays: Number(values.termsDays), ...(values.slug ? {} : { slug: undefined }) }),
      });
      if (result) again();
      return;
    }

    if (button.dataset.command === 'support') {
      renderSupportPanel();
      return;
    }

    if (button.dataset.command === 'onboard-group') {
      const result = await command({
        title: 'Onboard a group',
        intent:
          'One idempotent act: the group, the agreement as a draft, one company with its first administrator and invitation, and the first group administrator. ' +
          'Run it again with the same names for each further company — nothing is created twice. Registered issuer details are entered by the company afterwards; none are guessed.',
        path: '/v1/admin/groups/onboard',
        submitLabel: 'Onboard',
        fields: [
          { name: 'groupName', label: 'Group display name', placeholder: 'Groupe Nseya' },
          { name: 'groupCurrency', label: 'Group billing currency', type: 'select', options: (vocab?.currencies ?? []).map((c) => ({ value: c.code, label: `${c.code} — ${c.name}` })) },
          { name: 'mode', label: 'Agreement mode', type: 'select', options: [{ value: 'INTERNAL_COST_ALLOCATION', label: 'Internal cost allocation' }, { value: 'INVOICED_INTERCOMPANY', label: 'Invoiced intercompany' }, { value: 'EXTERNAL_ENTERPRISE', label: 'External enterprise' }] },
          { name: 'seller', label: 'Seller — legal name', placeholder: 'CONSTRUX (the vendor)' },
          { name: 'payer', label: 'Payer — legal name', placeholder: 'The paying legal entity' },
          { name: 'companyName', label: 'Company display name', placeholder: 'ETABLIX' },
          { name: 'code', label: 'Cost centre code', placeholder: 'ETX', hint: 'The company’s key within the group; the same code on a re-run finds the same company' },
          { name: 'jurisdiction', label: 'Jurisdiction', type: 'select', options: (vocab?.jurisdictions ?? []).map((j) => ({ value: j.code, label: `${j.name} (${j.taxName})` })) },
          { name: 'currency', label: 'Company currency', type: 'select', options: (vocab?.currencies ?? []).map((c) => ({ value: c.code, label: `${c.code} — ${c.name}` })) },
          { name: 'package', label: 'Package', type: 'select', options: [{ value: 'ENTERPRISE', label: 'Enterprise' }, { value: 'PROFESSIONAL_DELIVERY', label: 'Professional delivery' }, { value: 'CORE_PROJECT', label: 'Core project' }] },
          { name: 'adminName', label: 'First administrator' },
          { name: 'adminEmail', label: 'Administrator email' },
          { name: 'groupAdministrator', label: 'Group administrator email', required: false, hint: 'Somebody in the company; usually the same address' },
        ],
        transform: (v) => ({
          group: { displayName: v.groupName, currency: v.groupCurrency },
          agreement: { mode: v.mode, seller: { legalName: v.seller, tenantId: null }, payer: { legalName: v.payer, tenantId: null } },
          company: {
            displayName: v.companyName,
            code: v.code,
            jurisdiction: v.jurisdiction,
            currency: v.currency,
            tier: v.package === 'ENTERPRISE' ? 'ENTERPRISE' : v.package === 'PROFESSIONAL_DELIVERY' ? 'BUSINESS' : 'TEAM',
            package: v.package,
            administrator: { name: v.adminName, email: v.adminEmail },
          },
          ...(v.groupAdministrator ? { groupAdministrator: v.groupAdministrator } : {}),
        }),
      });
      if (result) {
        toast(
          result.company.created ? 'Company onboarded' : 'Already onboarded — nothing created twice',
          `${result.group.displayName} · ${result.company.name} (${result.company.code}) · ${result.administrator.email}${result.invitations?.length ? ` · invitation ${result.invitations[0].notified.toLowerCase()}` : ''}`,
          'ok',
        );
        await again();
      }
      return;
    }

    if (button.dataset.command === 'onboard') {
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
        toast('Tenancy onboarded', `${result.tenant.legalName} — ${result.administrator.email} can now sign in`, 'ok');
        await again();
      }
      return;
    }

    const result = await command({
      title: 'Appoint a platform operator',
      intent:
        'Creates an identity holding PLATFORM_ADMIN and nothing else — the whole operator surface, including the ' +
        'power to appoint others. Sign-in is an emailed one-time code, so the address is the credential: an operator ' +
        'created against an address nobody reads is an account nobody can use.',
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

  for (const button of root.querySelectorAll('[data-resolve-exception]')) {
    button.addEventListener('click', async () => {
      const result = await command({
        title: `Resolve — ${button.dataset.name}`,
        intent: 'Close the finance exception with how it was resolved: recovered from the customer, written off, or the period re-charged. The reversal and the exception stay on the record.',
        path: `/v1/admin/payments/exceptions/${button.dataset.resolveException}/resolve`,
        submitLabel: 'Resolve',
        fields: [{ name: 'note', label: 'How it was resolved', type: 'textarea' }],
      });
      if (result) again();
    });
  }
  for (const button of root.querySelectorAll('[data-unfreeze]')) {
    button.addEventListener('click', async () => {
      const result = await command({
        title: `Unfreeze wallet — ${button.dataset.name}`,
        intent: 'AI resumes for this tenancy. Do it once the dispute is settled; the reason is recorded.',
        path: `/v1/admin/tenants/${button.dataset.unfreeze}/wallet/unfreeze`,
        submitLabel: 'Unfreeze',
        fields: [{ name: 'reason', label: 'Reason' }],
      });
      if (result) again();
    });
  }
  for (const button of root.querySelectorAll('[data-reverse]')) {
    button.addEventListener('click', async () => {
      const tenantId = button.getAttribute('data-reverse');
      const tenant = byId.get(tenantId);
      const result = await command({
        title: `Refund or chargeback — ${tenant?.legalName ?? 'tenancy'}`,
        intent:
          'Records money that went back to the payer against a payment this platform recorded. What is still in the wallet is debited as its own entry; what was already spent becomes a finance exception. A dispute freezes the wallet. The event id is the bank’s or provider’s own, spent once.',
        path: `/v1/admin/tenants/${tenantId}/payments/reverse`,
        submitLabel: 'Record',
        fields: [
          { name: 'reference', label: 'Payment reference reversed', hint: 'The reference of the payment as it was recorded here' },
          { name: 'amountMinor', label: 'Amount reversed (pence)', type: 'number' },
          { name: 'kind', label: 'Kind', type: 'select', options: [{ value: 'REFUND', label: 'Refund — money returned' }, { value: 'DISPUTE', label: 'Dispute / chargeback — freezes the wallet' }] },
          { name: 'eventId', label: 'Reversal id', hint: 'The bank’s or provider’s identifier for the refund or dispute' },
          { name: 'note', label: 'Note', required: false },
        ],
        transform: (v) => ({ reference: v.reference, amountMinor: Number(v.amountMinor), kind: v.kind, eventId: v.eventId, ...(v.note ? { note: v.note } : {}) }),
      });
      if (result) {
        toast(result.alreadyRecorded ? 'Already recorded' : `${result.reversal.kind === 'DISPUTE' ? 'Dispute' : 'Refund'} recorded`, `${money(result.reversal.reversedMinor)} taken back from the wallet · ${money(result.reversal.shortfallMinor)} shortfall${result.exception ? ' — exception raised' : ''}${result.frozen ? ' — wallet frozen' : ''}`, result.exception ? 'warn' : 'ok');
        again();
      }
    });
  }
  for (const button of root.querySelectorAll('[data-credit]')) {
    button.addEventListener('click', async () => {
      const tenantId = button.getAttribute('data-credit');
      const tenant = byId.get(tenantId);
      const result = await command({
        title: `Credit ${tenant?.legalName ?? 'wallet'}`,
        intent:
          'Records a payment that has already been received and credits the wallet against it. The reference is the ' +
          'bank\'s or provider\'s own identifier and is the idempotency key for money — the same reference twice ' +
          'credits once. Do not invent one.',
        path: `/v1/admin/tenants/${tenantId}/credit`,
        submitLabel: 'Credit',
        fields: [
          { name: 'amountMinor', label: 'Amount received (pence)', type: 'number', hint: 'In minor units of the billing currency. £100 is 10000.' },
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
          { name: 'reference', label: 'Payment reference', hint: 'The provider\'s or bank\'s identifier for this payment. Unique for ever.' },
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

  for (const button of root.querySelectorAll('[data-package]')) {
    button.addEventListener('click', async () => {
      const tenantId = button.getAttribute('data-package');
      const tenant = byId.get(tenantId);
      const result = await command({
        title: `Package — ${tenant?.legalName ?? 'tenancy'}`,
        intent:
          'What this company is entitled to do: seats, storage, export, API access. It may be given away — tick ' +
          '"grant free of charge" and no monthly charge is raised at renewal. The reason is required and is recorded ' +
          'as evidence, because a free package handed to a named company with no stated basis is indistinguishable ' +
          'from a mistake when somebody reviews the discount list a year later. ' +
          'This does not credit the wallet and never will: the package is what they may do, the wallet is money they ' +
          'have put in to spend on AI, and this tenancy still tops up its own account before an engine will run.',
        path: `/v1/admin/tenants/${tenantId}/package`,
        submitLabel: 'Move package',
        fields: [
          {
            name: 'package',
            label: 'Package',
            type: 'select',
            value: tenant?.package,
            options: [
              { value: 'FREE_TRIAL', label: 'Trial — 1 seat, 1 GB, no export' },
              { value: 'SOLO', label: 'Solo — sole traders and single-project consultants' },
              { value: 'CORE_PROJECT', label: 'Core Project' },
              { value: 'PROFESSIONAL_DELIVERY', label: 'Professional Delivery' },
              { value: 'ENTERPRISE', label: 'Enterprise' },
            ],
          },
          {
            name: 'grantFree',
            label: 'Grant free of charge',
            type: 'checkbox',
            value: tenant?.grantedFree === true,
            hint: 'No monthly charge is raised for this package — not the first month, not a renewal. Any period already raised and unpaid is written off, and a tenancy waiting for its first payment opens. Untick to charge again from the next renewal.',
          },
          { name: 'reason', label: 'Reason', hint: 'Recorded as evidence against this decision' },
        ],
      });

      if (result) {
        toast(
          `${tenant?.legalName ?? 'Tenancy'} — ${result.package}`,
          `${result.grantedFree ? `Granted free of charge${result.status === 'ACTIVE' ? ', open' : ''}. ` : `${money(result.monthlyPriceMinor)} a month. `}` +
            `${result.includedSeats === null ? 'Unlimited' : result.includedSeats} seats, ${result.storageGb} GB. ` +
            'The wallet is untouched — this tenancy still funds its own AI spend.',
          'ok',
        );
        await again();
      }
    });
  }

  // Deleting a closed tenancy from the register. The nearest thing to deletion
  // an append-only record allows: every identity erased now, the row gone from
  // every operator screen, the events kept on the chain as evidence.
  for (const button of root.querySelectorAll('[data-delete]')) {
    button.addEventListener('click', async () => {
      const tenantId = button.getAttribute('data-delete');
      const ok = await command({
        title: `Delete ${button.dataset.name} from the register`,
        intent:
          `${button.dataset.people} identit${button.dataset.people === '1' ? 'y is' : 'ies are'} erased now rather than at the end of the grace period — ` +
          'name, address and mobile replaced by a token that names nobody — and the tenancy leaves every operator screen. ' +
          'The events stay on the chain, because the record is evidence; any refund still owed stays owed.',
        path: `/v1/admin/tenants/${tenantId}/delete`,
        submitLabel: 'Delete from the register',
        fields: [{ name: 'reason', label: 'Why', hint: 'At least ten characters. The record keeps it.' }],
      });
      if (ok) {
        toast('Deleted from the register', `${button.dataset.name} is off every operator screen. The chain keeps what happened.`, 'ok');
        await tenants(root);
      }
    });
  }

  for (const button of root.querySelectorAll('[data-close]')) {
    button.addEventListener('click', async () => {
      const tenantId = button.getAttribute('data-close');
      const tenant = byId.get(tenantId);
      try {
        // What it would do, before the reason is asked for. A closure is the
        // one operator act that ends a customer, and the person doing it
        // should see the count and the money first.
        const preview = await api.get(`/v1/admin/tenants/${tenantId}/closure`);
        const refund = preview.refund;
        const result = await command({
          title: `Close ${tenant?.legalName ?? 'tenancy'}`,
          intent:
            `Ends this customer. The subscription is cancelled and the record becomes read-only. All ${preview.identities} ` +
            `identit${preview.identities === 1 ? 'y' : 'ies'} (${preview.active} active) are deactivated now and erased after ` +
            `${preview.erasureGraceDays} days, which is also how long there is to reverse a mistake. The wallet is emptied and ` +
            `${money(refund.totalMinor)} is raised as a refund owed — ${money(refund.walletMinor)} of unspent paid-in credit and ` +
            `${money(refund.subscriptionMinor)} of unused subscription — for you to pay and record. Nothing on the record is deleted.`,
          path: `/v1/admin/tenants/${tenantId}/close`,
          submitLabel: 'Close tenancy',
          fields: [
            {
              name: 'reason',
              label: 'Reason',
              type: 'textarea',
              hint: 'At least ten characters. Quote the notice, the request or the decision this rests on; it is recorded against the closure.',
            },
          ],
        });
        if (result) {
          toast(
            `${result.legalName} closed`,
            `${result.identitiesDeactivated} identit${result.identitiesDeactivated === 1 ? 'y' : 'ies'} deactivated. ` +
              (result.refund ? `${money(result.refund.totalMinor)} raised as a refund to pay and record below.` : 'Nothing was owed.'),
            'warn',
          );
          await again();
        }
      } catch (error) {
        toast('Could not close the tenancy', error.message, 'err');
      }
    });
  }

  for (const button of root.querySelectorAll('[data-settle]')) {
    button.addEventListener('click', async () => {
      const refundId = button.getAttribute('data-settle');
      try {
        const result = await command({
          title: `Record the refund to ${button.getAttribute('data-name')}`,
          intent: 'The payment has been made outside the platform. The reference is what the customer can check against their statement.',
          path: `/v1/admin/refunds/${refundId}/settle`,
          submitLabel: 'Record payment',
          fields: [{ name: 'reference', label: 'Payment reference', hint: 'The bank or provider reference of the payment that discharged this refund.' }],
        });
        if (result) {
          toast('Refund recorded', `${money(result.totalMinor)} paid — ${result.settlementReference}.`, 'ok');
          await again();
        }
      } catch (error) {
        toast('Could not record the refund', error.message, 'err');
      }
    });
  }

  for (const button of root.querySelectorAll('[data-status]')) {
    button.addEventListener('click', async () => {
      const tenantId = button.getAttribute('data-status');
      const tenant = byId.get(tenantId);
      const result = await command({
        title: `Subscription status — ${tenant?.legalName ?? 'tenancy'}`,
        intent:
          'This is the switch that turns a paying customer\'s platform off. Suspended or cancelled, the record goes ' +
          'read-only: no writes, no AI execution, no top-ups and no export until reactivated. The reason is required ' +
          'and is recorded as evidence, because a record of this with no stated reason is useless the day somebody asks why.',
        path: `/v1/admin/tenants/${tenantId}/subscription-status`,
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

  for (const button of root.querySelectorAll('[data-module-decision]')) {
    button.addEventListener('click', async () => {
      const { moduleDecision, tenant, module, name, moduleName } = button.dataset;
      const revoke = moduleDecision === 'REVOKED';
      const result = await command({
        title: `${revoke ? 'Revoke' : 'Grant again'} — ${moduleName} for ${name}`,
        intent: revoke
          ? 'The module closes for this tenancy on its next request: routes, commands and agents alike. What was written stays on the ledger. The reason is recorded against the decision.'
          : 'The module reopens for this tenancy. The earlier grant and revocation stay on the register.',
        path: `/v1/admin/tenants/${tenant}/modules/${module}`,
        submitLabel: revoke ? 'Revoke' : 'Grant',
        fields: [{ name: 'reason', label: 'Reason', hint: 'In your own words. Recorded against the decision.' }],
        transform: (values) => ({ status: moduleDecision, reason: values.reason }),
      });
      if (result) again();
    });
  }

  for (const button of root.querySelectorAll('[data-people]')) {
    button.addEventListener('click', async () => {
      const tenantId = button.getAttribute('data-people');
      const panel = root.querySelector('#support-panel');
      const closed = await api.get(`/v1/admin/tenants/${tenantId}/users`).catch((error) => ({ error }));
      render(
        panel,
        html`<div class="card" style="margin-top:14px" data-closed-people>
          <h2>${closed.tenant?.legalName ?? byId.get(tenantId)?.legalName ?? 'Tenancy'} — closed people</h2>
          <div class="metric-sub" style="margin:6px 0 10px">
            Deactivated, deletion pending or erased. On the company's request a deactivated person can be fully deleted
            now, without the grace period; the project record stays against a pseudonym. Active people are the
            company's own to manage.
          </div>
          ${closed.error
            ? html`<div class="notice warn"><div>${closed.error.message}</div></div>`
            : table({
                headers: ['Name', 'Email', 'Roles', 'State', ''],
                rows: (closed.users ?? []).map((person) => [
                  person.name,
                  person.email,
                  person.roles.join(', '),
                  person.erasedAt ? badge('erased', 'neutral') : person.erasureDueAt ? badge(`deletion ${date(person.erasureDueAt)}`, 'warn') : badge('deactivated', 'warn'),
                  person.erasedAt ? '' : html`<button class="btn quiet danger sm" data-erase-user="${person.id}" data-erase-tenant="${tenantId}" data-name="${person.name}">Delete now</button>`,
                ]),
                empty: 'Nobody closed in this tenancy.',
              })}
        </div>`,
      );
      for (const erase of panel.querySelectorAll('[data-erase-user]')) {
        erase.addEventListener('click', async () => {
          const result = await command({
            title: `Delete ${erase.dataset.name} now`,
            intent: 'No grace period. Name, email and phone go at once; the project record stays against a pseudonym. Recorded on the company\'s own chain under your name. This cannot be undone.',
            path: `/v1/admin/tenants/${erase.dataset.eraseTenant}/users/${erase.dataset.eraseUser}/erase`,
            submitLabel: 'Delete now',
            fields: [{ name: 'reason', label: 'Reason', hint: 'At least ten characters. Quote the company\'s request.' }],
          });
          if (result) {
            toast('Deleted', `${erase.dataset.name} has been erased.`, 'warn');
            button.click();
          }
        });
      }
    });
  }

  for (const button of root.querySelectorAll('[data-modules]')) {
    button.addEventListener('click', async () => {
      const tenantId = button.getAttribute('data-modules');
      const tenant = byId.get(tenantId);
      // Two fields rather than one, because the module and the decision are
      // separate questions and a single "grant X" button would need one button
      // per module and no way to take any of them back.
      const held = new Set((tenant?.modules ?? []).map((entry) => entry.id));
      const choice = await command({
        title: `Private modules — ${tenant?.legalName ?? 'tenancy'}`,
        intent:
          'Gives this company capability that is not part of the subscription and is not on the pricing page. It sits ' +
          'beside whatever package they pay for — everything else they hold carries on unchanged — and nobody without ' +
          'the grant is told the module exists. The reason is recorded against the decision.',
        // The module is a path segment rather than a body field, so the path is
        // a function of what the person picked — the endpoint would otherwise
        // have two ways to say which module this is.
        path: (values) => `/v1/admin/tenants/${tenantId}/modules/${values.moduleId}`,
        submitLabel: 'Apply',
        fields: [
          {
            name: 'moduleId',
            label: 'Module',
            type: 'select',
            options: (register?.modules ?? []).map((definition) => ({
              value: definition.id,
              label: `${definition.name}${held.has(definition.id) ? ' — held' : ''}`,
            })),
          },
          {
            name: 'status',
            label: 'Decision',
            type: 'select',
            options: [
              { value: 'ACTIVE', label: 'Grant — the module becomes available to this tenancy' },
              { value: 'REVOKED', label: 'Revoke — the module closes; what was written stays on the ledger' },
            ],
          },
          { name: 'reason', label: 'Reason', hint: 'Why this company, in your own words. Recorded against the decision.' },
          { name: 'validFrom', label: 'Starts (optional — scheduled until then)', type: 'date', iso: true, required: false },
          { name: 'validTo', label: 'Expires (optional — closes from that day)', type: 'date', iso: true, required: false },
        ],
        // `moduleId` went into the address, so it is dropped from the body —
        // the route's schema is `additionalProperties: false` and would refuse
        // it, correctly.
        transform: (values) => ({ status: values.status, reason: values.reason, ...(values.validFrom ? { validFrom: values.validFrom } : {}), ...(values.validTo ? { validTo: values.validTo } : {}) }),
      });

      if (choice) {
        toast(`${tenant?.legalName ?? 'Tenancy'} — ${choice.moduleName}`, choice.effect, choice.status === 'ACTIVE' ? 'ok' : 'warn');
        await again();
      }
    });
  }
}
