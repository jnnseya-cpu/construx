import { api } from '../lib/api.js';
import { command } from '../lib/command.js';
import { badge, date, html, humanise, metric, money, notice, raw, render, table, toast } from '../lib/ui.js';
import { state } from '../app.js';

/**
 * Group — the console for a group role.
 *
 * One licence agreement over several companies. What a group role sees is
 * the directory of companies, what each is entitled to, what each has used
 * of the one wallet's worth, and the month's statement with a section per
 * cost centre. What it does not see is any company's records: a group role
 * opens this screen and nothing operational, and the figures here are
 * published by each company's own ledger read one at a time. The person
 * with a group role and a membership in one company still reaches the
 * other companies' work only through a membership there, or a share.
 */

let month = new Date().toISOString().slice(0, 7);

export async function group(root) {
  const me = await api.get('/v1/users/me').catch(() => null);
  const held = me?.group;
  if (!held) {
    render(
      root,
      html`<div class="view-head"><div><h1>Group</h1><p>This company is not part of a group.</p></div></div>
        ${notice('A group is set up by the platform operator: one licence agreement, one statement, several companies. Ask them to bring this company into one.', 'info')}`,
    );
    return;
  }
  if (held.roles.length === 0) {
    render(
      root,
      html`<div class="view-head"><div><h1>${held.displayName}</h1><p>This company is one of the group’s companies.</p></div></div>
        ${notice('You hold no group role. A group administrator can grant one; until then the group console is not yours to open.', 'info')}`,
    );
    return;
  }

  const isAdmin = held.roles.includes('GROUP_ADMIN');
  const isFinance = isAdmin || held.roles.includes('GROUP_FINANCE');
  const [directory, usage, statement] = await Promise.all([
    api.get(`/v1/groups/${held.id}`).catch((error) => ({ error })),
    api.get(`/v1/groups/${held.id}/usage`).catch((error) => ({ error })),
    isFinance ? api.get(`/v1/groups/${held.id}/statement?month=${month}`).catch((error) => ({ error })) : Promise.resolve(null),
  ]);
  if (directory.error) {
    render(root, html`<div class="view-head"><div><h1>${held.displayName}</h1></div></div>${notice(directory.error.message, 'bad')}`);
    return;
  }

  const companies = directory.companies ?? [];
  const currency = directory.group?.billing?.currency ?? 'GBP';
  const usageByCompany = new Map((usage.companies ?? []).map((company) => [company.tenantId, company]));

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>${held.displayName}</h1>
          <p>
            ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'} under one agreement. Billing
            ${humanise(directory.group.billing.invoiceMode)}, ${directory.group.billing.termsDays} day terms, ${currency}.
            Your group role${held.roles.length === 1 ? '' : 's'}: ${held.roles.map((role) => humanise(role)).join(', ')}.
          </p>
        </div>
        <div class="actions cmd-bar">
          ${isAdmin ? html`<button class="btn" data-command="role">Grant a group role</button>` : ''}
          ${isFinance ? html`<button class="btn quiet" data-command="export">Export statement</button>` : ''}
        </div>
      </div>

      <div class="grid g4" style="margin-bottom:14px">
        ${raw(metric({ label: 'Companies', value: companies.length, sub: `${companies.filter((c) => c.status === 'ACTIVE').length} active` }))}
        ${raw(metric({ label: 'People', value: companies.reduce((sum, c) => sum + c.people, 0), sub: 'active across the group' }))}
        ${raw(metric({ label: 'AI spend, last 30 days', value: money((usage.companies ?? []).reduce((sum, c) => sum + (c.meters?.acu?.billedMinor ?? 0), 0), currency), sub: 'billed, every company' }))}
        ${raw(metric({ label: 'Documents issued', value: (usage.companies ?? []).reduce((sum, c) => sum + (c.meters?.document ?? 0), 0), sub: 'last 30 days' }))}
      </div>

      <div class="card pad0" style="margin-bottom:14px" data-directory>
        <h2 style="padding:15px 17px 0">Companies</h2>
        <div class="metric-sub" style="padding:6px 17px 10px">
          Each company is its own tenancy: its own people, records, wallet and identity. Nothing here reaches into one.
        </div>
        ${table({
          headers: ['Cost centre', 'Company', 'Standing', 'Package', 'Modules', 'People', 'AI available', 'Hard limit', 'Charged', ''],
          align: ['', '', '', '', '', 'num', 'num', 'num', '', ''],
          rows: companies.map((c) => [
            html`<b>${c.code}</b><div class="metric-sub">${c.slug}</div>`,
            html`${c.name}<div class="metric-sub">${c.jurisdiction}</div>`,
            badge(c.status.toLowerCase(), c.status === 'ACTIVE' ? 'ok' : 'bad'),
            html`${c.entitlements.product.planLabel}<div class="metric-sub">${c.entitlements.product.status.toLowerCase()}</div>`,
            c.entitlements.modules.length ? html`${c.entitlements.modules.map((m) => badge(m.moduleKey, 'ok'))}` : html`<span class="metric-sub">none</span>`,
            html`${c.people}<div class="metric-sub">${c.administrators} admin${c.administrators === 1 ? '' : 's'}</div>`,
            money(c.walletAvailableMinor, currency),
            c.hardLimitMinor === null ? html`<span class="metric-sub">none</span>` : money(c.hardLimitMinor, currency),
            html`${humanise(c.chargeMode)}<div class="metric-sub">${humanise(c.rateCard)}</div>`,
            html`<span class="row-actions">
              <button class="btn quiet sm" data-company-action="entitlements" data-tenant="${c.tenantId}" data-name="${c.name}">Entitlements</button>
              ${isFinance ? html`<button class="btn quiet sm" data-company-action="limit" data-tenant="${c.tenantId}" data-name="${c.name}">Hard limit</button>` : ''}
              ${isAdmin ? html`<button class="btn quiet sm" data-company-action="audit" data-tenant="${c.tenantId}" data-name="${c.name}">Audit</button>` : ''}
            </span>`,
          ]),
          empty: 'No company has been brought into this group yet.',
        })}
      </div>

      <div class="card pad0" style="margin-bottom:14px" data-usage>
        <h2 style="padding:15px 17px 0">Usage by company — last 30 days</h2>
        <div class="metric-sub" style="padding:6px 17px 10px">
          Metered per company whatever its charge mode. Waiving a subscription does not remove the AI cost, and the group sees it.
        </div>
        ${usage.error
          ? notice(usage.error.message, 'warn')
          : table({
              headers: ['Company', 'ACU raw', 'ACU billed', 'By module', 'Active seats', 'Documents', 'Storage'],
              align: ['', 'num', 'num', '', 'num', 'num', 'num'],
              rows: (usage.companies ?? []).map((c) => [
                html`<b>${c.code}</b> ${c.name}`,
                money(c.meters.acu.rawMinor, currency),
                money(c.meters.acu.billedMinor, currency),
                Object.keys(c.meters.acu.byModule).length
                  ? html`${Object.entries(c.meters.acu.byModule).map(([key, minor]) => html`<div class="metric-sub">${key}: ${money(minor, currency)}</div>`)}`
                  : html`<span class="metric-sub">—</span>`,
                html`${c.meters.seat.active}${c.meters.seat.included === null ? '' : html`<span class="metric-sub"> / ${c.meters.seat.included}</span>`}`,
                c.meters.document,
                `${(c.meters.storageBytes / 1_048_576).toFixed(1)} MB`,
              ]),
              empty: 'Nothing metered yet.',
            })}
      </div>

      ${isFinance
        ? html`<div class="card pad0" style="margin-bottom:14px" data-statement>
            <h2 style="padding:15px 17px 0">
              Statement
              <select id="statement-month" style="margin-left:10px;font-size:13px">
                ${recentMonths().map((m) => html`<option value="${m}" ${raw(m === month ? 'selected' : '')}>${m}</option>`)}
              </select>
            </h2>
            <div class="metric-sub" style="padding:6px 17px 10px">
              One section per cost centre: the plan as charged, seats, AI, documents, storage. A statement, not an invoice:
              nothing here moves money, and what is invoiced is decided by each cost centre’s charge mode.
              ${statement && !statement.error ? html`Covers ${statement.companiesIncluded.join(', ')}.` : ''}
            </div>
            ${statement?.error
              ? notice(statement.error.message, 'warn')
              : table({
                  headers: ['Cost centre', 'Package', 'Plan charged', 'Seats', 'AI billed', 'Documents', 'Total', 'Invoiced'],
                  align: ['', '', 'num', 'num', 'num', 'num', 'num', ''],
                  rows: [
                    ...(statement?.sections ?? []).map((s) => [
                      html`<b>${s.code}</b> ${s.name}<div class="metric-sub">${humanise(s.chargeMode)} · ${humanise(s.rateCard)}</div>`,
                      html`${s.plan.label}<div class="metric-sub">list ${money(s.plan.listPriceMinor, currency)}</div>`,
                      html`${money(s.plan.chargedMinor, currency)}${s.plan.chargeStatus ? html`<div class="metric-sub">${s.plan.chargeStatus.toLowerCase()}</div>` : html`<div class="metric-sub">not raised</div>`}`,
                      s.meters.seat.active,
                      money(s.acuBilledMinor, currency),
                      s.meters.document,
                      html`<b>${money(s.totalMinor, currency)}</b>`,
                      badge(s.invoiced ? 'invoiced' : 'tracked', s.invoiced ? 'ok' : 'neutral'),
                    ]),
                    ...(statement?.totals
                      ? [[html`<b>Group total</b>`, '', money(statement.totals.planMinor, currency), '', money(statement.totals.acuBilledMinor, currency), '', html`<b>${money(statement.totals.totalMinor, currency)}</b>`, html`<span class="metric-sub">${money(statement.totals.invoicedMinor, currency)} invoiced</span>`]]
                      : []),
                  ],
                  empty: 'No companies in this group.',
                })}
          </div>`
        : ''}

      <div class="card" style="margin-bottom:14px" data-roles>
        <h2>Group roles</h2>
        <div class="metric-sub" style="margin:6px 0 10px">
          A group role opens this screen. It never opens a company: operational access needs a membership there.
        </div>
        ${table({
          headers: ['Person', 'Role', 'Granted', isAdmin ? '' : ' '],
          rows: (directory.roles ?? []).map((role) => [
            role.email,
            badge(humanise(role.role), role.role === 'GROUP_ADMIN' ? 'ok' : 'neutral'),
            date(role.grantedAt),
            isAdmin ? html`<button class="btn quiet sm" data-role-revoke="${role.id}" data-role-label="${role.email} · ${humanise(role.role)}">Revoke</button>` : '',
          ]),
          empty: 'No group role has been granted.',
        })}
      </div>

      <div id="group-panel"></div>
    `,
  );

  const again = () => group(root);

  root.querySelector('#statement-month')?.addEventListener('change', (event) => {
    month = event.target.value;
    again();
  });

  root.querySelector('.cmd-bar')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    if (button.dataset.command === 'role') {
      const result = await command({
        title: 'Grant a group role',
        intent: 'To somebody already in one of the group’s companies. Admin runs the group; finance sees billing and usage; viewer sees the consolidated figures.',
        path: `/v1/groups/${held.id}/roles`,
        submitLabel: 'Grant',
        fields: [
          { name: 'email', label: 'Their email', placeholder: 'name@company.com' },
          {
            name: 'role',
            label: 'Role',
            type: 'select',
            options: [
              { value: 'GROUP_VIEWER', label: 'Group viewer — consolidated dashboards' },
              { value: 'GROUP_FINANCE', label: 'Group finance — billing, usage, limits' },
              { value: 'GROUP_ADMIN', label: 'Group admin — companies, roles, audit' },
            ],
          },
        ],
      });
      if (result) again();
    }
    if (button.dataset.command === 'export') {
      try {
        await api.download(`/v1/groups/${held.id}/statement/export`, { month });
        toast('Statement exported', `${held.displayName} · ${month}`, 'ok');
      } catch (error) {
        toast('Could not export', error.message, 'err');
      }
    }
  });

  for (const button of root.querySelectorAll('[data-role-revoke]')) {
    button.addEventListener('click', async () => {
      const result = await command({
        title: `Revoke ${button.dataset.roleLabel}`,
        intent: 'They keep every membership they hold; only the group role goes. The last group administrator cannot be revoked.',
        path: `/v1/groups/${held.id}/roles/${button.dataset.roleRevoke}/revoke`,
        submitLabel: 'Revoke',
        fields: [],
      });
      if (result) again();
    });
  }

  for (const button of root.querySelectorAll('[data-company-action]')) {
    button.addEventListener('click', async () => {
      const { companyAction, tenant, name } = button.dataset;
      const panel = root.querySelector('#group-panel');
      if (companyAction === 'entitlements') {
        const entitlements = await api.get(`/v1/groups/${held.id}/companies/${tenant}/entitlements`).catch((error) => ({ error }));
        render(
          panel,
          html`<div class="card" style="margin-bottom:14px">
            <h2>${name} — entitlements</h2>
            ${entitlements.error
              ? notice(entitlements.error.message, 'warn')
              : html`${table({
                  headers: ['Product', 'Plan', 'Status', 'Valid from', 'Seats'],
                  rows: [[
                    entitlements.product.product,
                    entitlements.product.planLabel,
                    badge(entitlements.product.status.toLowerCase(), entitlements.product.status === 'ACTIVE' ? 'ok' : 'warn'),
                    date(entitlements.product.validFrom),
                    `${entitlements.seats.used}${entitlements.seats.included === null ? '' : ` / ${entitlements.seats.included}`}`,
                  ]],
                })}
                <div class="metric-sub" style="margin-top:10px">
                  Modules: ${entitlements.modules.length ? entitlements.modules.map((m) => m.moduleKey).join(', ') : 'none. Nothing is inherited from the group; a module is granted to a company by the platform operator.'}
                </div>
                <div class="metric-sub" style="margin-top:6px">Token claims: <code>${entitlements.claims.join(' ')}</code></div>`}
          </div>`,
        );
      }
      if (companyAction === 'limit') {
        const result = await command({
          title: `${name} — monthly AI hard limit`,
          intent: 'AI work stops at this figure until it is raised or the month turns; everything else continues. Leave blank to lift the limit. Recorded on the company.',
          path: `/v1/groups/${held.id}/companies/${tenant}/usage-account`,
          method: 'PUT',
          submitLabel: 'Set',
          fields: [
            { name: 'monthlyHardLimitMinor', label: 'Hard limit, in minor units', type: 'number', required: false, hint: '100000 = £1,000.00' },
            { name: 'reason', label: 'Why', placeholder: 'Pilot budget agreed with the board' },
          ],
          transform: (values) => ({ monthlyHardLimitMinor: values.monthlyHardLimitMinor === '' || values.monthlyHardLimitMinor === undefined ? null : Number(values.monthlyHardLimitMinor), reason: values.reason }),
        });
        if (result) again();
      }
      if (companyAction === 'audit') {
        const from = new Date(Date.now() - 30 * 86_400_000).toISOString();
        const audit = await api.get(`/v1/groups/${held.id}/audit?tenantId=${tenant}&from=${encodeURIComponent(from)}`).catch((error) => ({ error }));
        render(
          panel,
          html`<div class="card pad0" style="margin-bottom:14px">
            <h2 style="padding:15px 17px 0">${name} — everything it did, last 30 days</h2>
            <div class="metric-sub" style="padding:6px 17px 10px">The company’s governance record: who did what and when. Figures, not documents.</div>
            ${audit.error
              ? notice(audit.error.message, 'warn')
              : table({
                  headers: ['When', 'What', 'On', 'By'],
                  rows: (audit.events ?? []).slice(-200).reverse().map((e) => [date(e.timestamp), humanise(e.eventType), `${e.entity.refType}`, e.actor.refId]),
                  empty: 'Nothing recorded in the window.',
                })}
          </div>`,
        );
      }
    });
  }
}

function recentMonths() {
  const out = [];
  const now = new Date();
  for (let back = 0; back < 12; back += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

/** The nav needs to know whether to show the page at all. */
export function groupVisible() {
  return Boolean(state.me?.group);
}
