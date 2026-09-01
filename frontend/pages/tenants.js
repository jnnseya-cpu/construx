import { api } from '../lib/api.js';
import { command } from '../lib/command.js';
import { gb, head, refusal } from '../lib/estate.js';
import { badge, date, html, money, raw, render, table, time, toast, track } from '../lib/ui.js';

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

export async function tenants(root) {
  const [estate, vocab, register] = await Promise.all([
    api.get('/v1/admin/tenants').catch((error) => ({ error })),
    api.get('/v1/signup/account-types').catch(() => null),
    api.get('/v1/admin/modules').catch(() => null),
  ]);

  if (estate.error) {
    render(root, html`${head({ title: 'Tenants & users' })}${refusal('The tenant estate', estate.error)}`);
    return;
  }

  const rows = estate.tenants ?? [];
  const byId = new Map(rows.map((tenant) => [tenant.id, tenant]));
  const unreachable = rows.filter((tenant) => tenant.administrators === 0);

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
          '<button class="btn quiet" data-command="operator">Appoint an operator</button>',
      })}

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
            html`${tenant.legalName}<div class="metric-sub">${tenant.jurisdiction} · ${
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
            badge(tenant.status, tenant.status === 'ACTIVE' ? 'ok' : 'warn'),
            tenant.administrators === 0
              ? badge('no administrator', 'bad')
              : `${tenant.identities} (${tenant.administrators} admin${tenant.administrators === 1 ? '' : 's'})`,
            `${tenant.seatsUsed} / ${tenant.seatsIncluded ?? '∞'}`,
            html`${gb(tenant.storage.usedBytes)}${
              tenant.storage.state !== 'OK' ? badge(tenant.storage.state.toLowerCase(), tenant.storage.state === 'FULL' ? 'bad' : 'warn') : ''
            }`,
            money(tenant.lifetimeRevenueMinor),
            money(tenant.wallet.availableMinor),
            date(tenant.renewsAt),
            html`<button class="btn quiet sm" data-credit="${tenant.id}">Credit</button>
              <button class="btn quiet sm" data-status="${tenant.id}">Status</button>
              <button class="btn quiet sm" data-modules="${tenant.id}">Modules</button>`,
          ]),
          empty: 'No tenancy on the estate yet.',
        })}
      </div>

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
              ${table({
                headers: ['Tenancy', 'Module', 'Status', 'Granted', 'Reason', 'Revoked'],
                rows: register.grants.map((grant) => [
                  grant.legalName,
                  grant.moduleName,
                  badge(grant.status.toLowerCase(), grant.status === 'ACTIVE' ? 'ok' : 'warn'),
                  html`${date(grant.grantedAt)}<div class="metric-sub">${grant.grantedByName}</div>`,
                  grant.status === 'ACTIVE' ? grant.reason : grant.revokedReason ?? grant.reason,
                  grant.revokedAt
                    ? html`${date(grant.revokedAt)}<div class="metric-sub">${grant.revokedByName}</div>`
                    : '—',
                ]),
                // Revoked grants stay on this table on purpose: "who had this,
                // and between which dates" is what an access review asks, and a
                // register showing only live grants cannot answer it.
                empty: 'No module has been granted to anybody.',
              })}
            </div>
          </div>`
        : ''}
    `,
  );

  const again = () => tenants(root);

  root.querySelector('.cmd-bar')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;

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
        ],
        // `moduleId` went into the address, so it is dropped from the body —
        // the route's schema is `additionalProperties: false` and would refuse
        // it, correctly.
        transform: (values) => ({ status: values.status, reason: values.reason }),
      });

      if (choice) {
        toast(`${tenant?.legalName ?? 'Tenancy'} — ${choice.moduleName}`, choice.effect, choice.status === 'ACTIVE' ? 'ok' : 'warn');
        await again();
      }
    });
  }
}
