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
    const admin = (state.session?.user?.roles ?? []).some((role) => role === 'ENTERPRISE_ADMIN' || role === 'OWNER');
    render(
      root,
      html`<div class="view-head">
          <div><h1>Group</h1><p>This company is not part of a group.</p></div>
          ${admin ? html`<div class="actions cmd-bar"><button class="btn" data-command="found">Found a group from this company</button></div>` : ''}
        </div>
        ${notice(
          admin
            ? 'A group is one licence agreement, one statement, several companies — up to five. Found one from this company and it becomes the first; you add the others afterwards, each with the administrators you name. Or ask the platform operator to bring this company into an existing group.'
            : 'A group is founded at signup — choose “a group of companies” on the form — by the company’s administrator from this screen, or set up by the platform operator: one licence agreement, one statement, several companies.',
          'info',
        )}`,
    );
    root.querySelector('[data-command="found"]')?.addEventListener('click', async () => {
      const result = await command({
        title: 'Found a group from this company',
        intent:
          'This company becomes the first of a group of up to five, and you its group administrator. Nothing about the ' +
          'company changes — its people, records, wallet and subscription are as they were.',
        path: '/v1/groups',
        submitLabel: 'Found the group',
        fields: [{ name: 'displayName', label: 'Group name', required: false, hint: 'Defaults to this company’s name.' }],
        transform: (v) => (v.displayName ? { displayName: v.displayName } : {}),
      });
      if (result) {
        toast(`${result.group.displayName} founded`, `${result.company.name} is its first company. Add the next with “Add a company”.`, 'ok');
        await group(root);
      }
    });
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
  const [directory, usage, statement, billing, reports] = await Promise.all([
    api.get(`/v1/groups/${held.id}`).catch((error) => ({ error })),
    api.get(`/v1/groups/${held.id}/usage`).catch((error) => ({ error })),
    isFinance ? api.get(`/v1/groups/${held.id}/statement?month=${month}`).catch((error) => ({ error })) : Promise.resolve(null),
    isFinance ? api.get(`/v1/groups/${held.id}/billing`).catch((error) => ({ error })) : Promise.resolve(null),
    api.get(`/v1/groups/${held.id}/reports`).catch((error) => ({ error })),
  ]);
  if (directory.error) {
    render(root, html`<div class="view-head"><div><h1>${held.displayName}</h1></div></div>${notice(directory.error.message, 'bad')}`);
    return;
  }

  const companies = directory.companies ?? [];
  const maxCompanies = directory.maxCompanies ?? companies.length;
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
          ${isAdmin && companies.length < maxCompanies ? html`<button class="btn" data-command="company">Add a company</button>` : ''}
          ${isAdmin ? html`<button class="btn${companies.length < maxCompanies ? ' quiet' : ''}" data-command="role">Grant a group role</button>` : ''}
          <button class="btn quiet" data-command="report">Run a report</button>
          ${isFinance ? html`<button class="btn quiet" data-command="export">Export statement</button>` : ''}
        </div>
      </div>

      <div class="grid g4" style="margin-bottom:14px">
        ${raw(metric({ label: 'Companies', value: `${companies.length} of ${maxCompanies}`, sub: `${companies.filter((c) => c.status === 'ACTIVE').length} active · ${companies.filter((c) => c.awaitingFirstPayment).length} awaiting first payment` }))}
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
            c.awaitingFirstPayment
              ? html`${badge('awaiting first payment', 'warn')}<div class="metric-sub">${money(c.outstandingMinor, currency)} · quote ${c.paymentReference}</div>`
              : badge(c.status.toLowerCase(), c.status === 'ACTIVE' ? 'ok' : 'bad'),
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
              ${isAdmin && c.status === 'ACTIVE' ? html`<button class="btn quiet sm" data-company-action="administrator" data-tenant="${c.tenantId}" data-name="${c.name}">Add an administrator</button>` : ''}
            </span>`,
          ]),
          empty: isAdmin ? 'No company yet. Add the first with the button above.' : 'No company has been brought into this group yet.',
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

      ${isFinance && billing && !billing.error
        ? html`<div class="card" style="margin-bottom:14px" data-billing>
            <h2>Agreement and subscriptions</h2>
            <div class="metric-sub" style="margin:6px 0 12px">
              The agreement joins the companies’ subscriptions to a payer: who sells, who pays, in which currency, how often, under
              which mode. Every mode meters the same way. A group display name is not a billing identity — the parties are legal entities.
            </div>
            ${billing.inForce
              ? html`<div class="split-list" style="margin-bottom:12px">
                  <div class="row"><span class="lbl">In force</span><span class="val">version ${billing.inForce.version} · ${humanise(billing.inForce.mode.toLowerCase())} · since ${date(billing.inForce.effectiveFrom)}</span></div>
                  <div class="row"><span class="lbl">Seller</span><span class="val">${billing.inForce.seller.legalName}</span></div>
                  <div class="row"><span class="lbl">Payer</span><span class="val">${billing.inForce.payer.legalName}</span></div>
                  <div class="row"><span class="lbl">Terms</span><span class="val">${billing.inForce.currency} · ${billing.inForce.cadence.toLowerCase()} · price list ${billing.inForce.pricingPolicyVersion}</span></div>
                  <div class="row"><span class="lbl">Rate cards</span><span class="val">${['GROUP_INTERNAL', 'ENTERPRISE_GROUP', 'RETAIL']
                    .map((card) => `${humanise(card.toLowerCase())} ${billing.inForce.rateCards?.[card]?.discountPercent ? `−${billing.inForce.rateCards[card].discountPercent}%` : 'list price'}`)
                    .join(' · ')}</span></div>
                </div>`
              : notice('No approved agreement is in force. The platform operator sets the terms as a draft; the group approves them here.', 'warn')}
            ${(billing.agreement?.versions ?? []).filter((v) => v.status === 'DRAFT').map((v) => html`<div class="notice" style="margin-bottom:12px"><div>
                <b>Draft version ${v.version}</b> · ${humanise(v.mode.toLowerCase())} · ${v.seller.legalName} → ${v.payer.legalName} · ${v.currency} ${v.cadence.toLowerCase()} · effective ${date(v.effectiveFrom)}${v.note ? html` · ${v.note}` : ''}
                <button class="btn sm" style="margin-left:10px" data-agreement-approve="${v.version}">Approve</button>
              </div></div>`)}
            ${table({
              headers: ['Cost centre', 'Subscription', 'Line items', 'Seats', 'Currency', 'Charged as'],
              rows: billing.subscriptions.map((s) => [
                html`<b>${s.code}</b> ${s.name}`,
                html`${humanise(s.package.toLowerCase())}<div class="metric-sub">${s.state.toLowerCase()} · renews ${date(s.renewsAt)}</div>`,
                html`${s.items.map((item) => html`<div>${item.code}<span class="metric-sub"> · ${item.kind === 'PRODUCT' ? money(item.priceMinor, s.currency) + ' / month' : 'restricted grant, not priced'}</span></div>`)}`,
                html`${s.seatsUsed}${s.seatLimit === null ? '' : html`<span class="metric-sub"> / ${s.seatLimit}</span>`}`,
                s.currency,
                humanise(s.chargeMode.toLowerCase()),
              ]),
              empty: 'No company in this group.',
            })}
            <div class="metric-sub" style="margin-top:10px">
              ${billing.seats.used} seat${billing.seats.used === 1 ? '' : 's'} in use across the group; ${billing.seats.distinctPeople} distinct ${billing.seats.distinctPeople === 1 ? 'person' : 'people'} (one person in two companies holds a seat in each).
            </div>
            <div class="metric-sub" style="margin-top:6px">
              ${billing.invoicing.single
                ? 'One invoice may cover the invoiced companies: same seller, payer, currency and period.'
                : html`Separate invoices plus the consolidated statement${billing.invoicing.reasons.length ? html`: ${billing.invoicing.reasons.join('; ')}` : ''}.`}
              ${billing.invoicing.allocationOnly.length ? html` ${billing.invoicing.allocationOnly.join(', ')}: allocation statement, not invoiced.` : ''}
            </div>
          </div>`
        : ''}

      <div class="card pad0" style="margin-bottom:14px" data-reports>
        <h2 style="padding:15px 17px 0">Reports</h2>
        <div class="metric-sub" style="padding:6px 17px 10px">
          Read under each company’s reporting grant, one company at a time. A company that has not granted a metric is named as
          withheld — never shown as zero. Money keeps its currency; nothing is converted.
        </div>
        ${reports?.error
          ? notice(reports.error.message, 'warn')
          : table({
              headers: ['Run', 'Metrics', 'Window', 'Companies', ''],
              rows: (reports?.reports ?? []).map((r) => [
                html`${date(r.generatedAt)}<div class="metric-sub">${humanise(r.requestedRole)}</div>`,
                r.metrics.join(', '),
                `${date(r.window.from)} – ${date(r.window.to)}`,
                html`${r.included} of ${r.companies} included`,
                html`<button class="btn quiet sm" data-report-open="${r.id}">Open</button>`,
              ]),
              empty: 'No report has been run. Run one from the top of the page.',
            })}
      </div>

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
    if (button.dataset.command === 'company') {
      const result = await command({
        title: 'Add a company to the group',
        intent: `A new organisation under ${held.displayName}: its own tenancy, people, records and wallet. Its first month is charged and it opens when that is paid — the administrators you name are invited by email and see the bill on ACU & Billing. ${companies.length} of ${maxCompanies} companies used.`,
        path: `/v1/groups/${held.id}/companies`,
        submitLabel: 'Add the company',
        fields: [
          { name: 'displayName', label: 'Company name', placeholder: 'JNN Homes Ltd' },
          { name: 'code', label: 'Cost centre code', placeholder: 'Derived from the name if left blank', required: false },
          { name: 'jurisdiction', label: 'Jurisdiction', type: 'select', options: (directory.jurisdictions ?? []).map((j) => ({ value: j.code, label: j.name })), value: 'GB' },
          { name: 'currency', label: 'Currency', type: 'select', options: (directory.currencies ?? []).map((c) => ({ value: c.code, label: `${c.code} — ${c.name}` })), value: currency },
          { name: 'package', label: 'Package', type: 'select', options: (directory.packages ?? []).map((p) => ({ value: p.package, label: `${p.label} — ${money(p.monthlyPriceMinor, 'GBP')} a month` })) },
          { name: 'admin1Name', label: 'First administrator — name', placeholder: 'Rowan Blake' },
          { name: 'admin1Email', label: 'First administrator — email', placeholder: 'rowan@company.com' },
          { name: 'admin2Name', label: 'Second administrator — name', placeholder: 'Optional', required: false },
          { name: 'admin2Email', label: 'Second administrator — email', placeholder: 'Optional', required: false },
        ],
        transform: (values) => {
          const administrators = [{ name: values.admin1Name, email: values.admin1Email }];
          if (values.admin2Email) administrators.push({ name: values.admin2Name, email: values.admin2Email });
          const payload = { displayName: values.displayName, jurisdiction: values.jurisdiction, currency: values.currency, package: values.package, administrators };
          if (values.code) payload.code = values.code;
          return payload;
        },
      });
      if (result) {
        const sent = (result.invitations ?? []).map((i) => `${i.email} · ${String(i.notified).toLowerCase()}`).join(', ');
        toast(`${result.company.name} added`, result.openingCharge ? `First month ${money(result.openingCharge.amountMinor, currency)} due · quote ${result.openingCharge.paymentReference}. Invitations: ${sent}` : `Invitations: ${sent}`, 'ok');
        again();
      }
    }
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
    if (button.dataset.command === 'report') {
      const result = await command({
        title: 'Run a group report',
        intent: 'Named metrics over chosen companies and a window, read under each company’s reporting grant. What a company has not granted is named as withheld.',
        path: `/v1/groups/${held.id}/reports`,
        submitLabel: 'Run',
        fields: [
          { name: 'metrics', label: 'Metrics', type: 'multiselect', options: (reports?.metrics ?? []).map((m) => ({ value: m.key, label: m.label })) },
          { name: 'tenantIds', label: 'Companies', type: 'multiselect', required: false, options: companies.map((c) => ({ value: c.tenantId, label: c.name })), hint: 'None selected means every company in the group' },
          { name: 'from', label: 'From', type: 'date', iso: true, required: false },
          { name: 'to', label: 'To', type: 'date', iso: true, required: false },
        ],
        transform: (v) => ({ metrics: v.metrics ?? [], ...(v.tenantIds?.length ? { tenantIds: v.tenantIds } : {}), ...(v.from ? { from: v.from } : {}), ...(v.to ? { to: v.to } : {}) }),
      });
      if (result) {
        await group(root);
        showReport(root.querySelector('#group-panel'), result);
      }
    }
  });

  for (const button of root.querySelectorAll('[data-agreement-approve]')) {
    button.addEventListener('click', async () => {
      const result = await command({
        title: `Approve agreement version ${button.dataset.agreementApprove}`,
        intent: 'The terms come into force from their effective date; the previously approved version ends where this one begins. Recorded under your name.',
        path: `/v1/groups/${held.id}/agreement/${button.dataset.agreementApprove}/approve`,
        submitLabel: 'Approve',
        fields: [],
      });
      if (result) again();
    });
  }

  for (const button of root.querySelectorAll('[data-report-open]')) {
    button.addEventListener('click', async () => {
      try {
        showReport(root.querySelector('#group-panel'), await api.get(`/v1/groups/${held.id}/reports/${button.dataset.reportOpen}`));
      } catch (error) {
        toast('Could not open the report', error.message, 'err');
      }
    });
  }

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
      if (companyAction === 'administrator') {
        const result = await command({
          title: `Add an administrator to ${name}`,
          intent: 'A second person who can run the company — or the first after the original has left. They are invited by email and hold the company’s administrator role; somebody already in one of the group’s companies is added under the same identity.',
          path: `/v1/groups/${held.id}/companies/${tenant}/administrators`,
          submitLabel: 'Add and invite',
          fields: [
            { name: 'name', label: 'Name', placeholder: 'Kemi Adeyemi' },
            { name: 'email', label: 'Email', placeholder: 'kemi@company.com' },
          ],
        });
        if (result) {
          const sent = (result.invitations ?? []).map((i) => `${i.email} · ${String(i.notified).toLowerCase()}`).join(', ');
          toast(`${result.administrator.email} administers ${name}`, sent ? `Invitation: ${sent}` : 'Already held an identity here', 'ok');
          again();
        }
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

/** A report, section by section: values where granted, the reason where not. */
function showReport(panel, report) {
  const value = (v) => (v.unit === 'money' ? money(v.value, v.currency) : String(v.value));
  render(
    panel,
    html`<div class="card pad0" style="margin-bottom:14px" data-report>
      <h2 style="padding:15px 17px 0">Report · ${date(report.generatedAt)} <span class="metric-sub">${date(report.window.from)} – ${date(report.window.to)} · ${humanise(report.requestedRole)}</span></h2>
      ${report.withheldSinceGeneration?.length ? notice(`Withheld since this report was run, because the grant ended: ${report.withheldSinceGeneration.join(', ')}.`, 'warn') : ''}
      ${table({
        headers: ['Company', 'Standing', ...report.metrics],
        rows: report.sections.map((s) => [
          html`<b>${s.code}</b> ${s.name}`,
          s.status === 'INCLUDED'
            ? html`${badge('granted', 'ok')}<div class="metric-sub">grant rev. ${s.grantRevision}${s.withheld.length ? ` · withheld: ${s.withheld.join(', ')}` : ''}</div>`
            : badge(humanise(s.status.toLowerCase()), 'warn'),
          ...report.metrics.map((metric) => (s.values[metric] ? value(s.values[metric]) : html`<span class="metric-sub">withheld</span>`)),
        ]),
        empty: 'No company was asked for.',
      })}
      <div class="metric-sub" style="padding:8px 17px 15px">
        Totals over included companies, per currency — nothing converted:
        ${Object.entries(report.totals).length
          ? Object.entries(report.totals).map(([key, totals]) => html`<div>${key}: ${Object.entries(totals).map(([metric, total]) => `${metric} ${key === 'count' ? total : money(total, key)}`).join(' · ')}</div>`)
          : 'none'}
      </div>
    </div>`,
  );
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
