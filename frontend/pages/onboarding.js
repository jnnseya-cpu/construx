import { api } from '../lib/api.js';
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
  const [estate, overview, events, forecast] = await Promise.all([
    api.get('/v1/admin/tenants').catch((error) => ({ error })),
    api.get('/v1/admin/overview').catch(() => null),
    api.get('/v1/admin/events').catch(() => null),
    api.get('/v1/admin/forecast').catch(() => null),
  ]);

  if (estate.error) {
    render(root, html`${head({ title: 'Onboarding queue' })}${refusal('The tenant estate', estate.error)}`);
    return;
  }

  const tenants = estate.tenants ?? [];
  const writesById = new Map((events?.byTenant ?? []).map((row) => [row.tenantId, row]));

  const now = Date.now();
  const ageDays = (iso) => Math.floor((now - new Date(iso).getTime()) / 86_400_000);

  const trials = tenants.filter((tenant) => tenant.tier === 'FREE_TRIAL' && tenant.status === 'ACTIVE');
  const unreachable = tenants.filter((tenant) => tenant.administrators === 0);
  const silent = tenants.filter((tenant) => (writesById.get(tenant.id)?.events ?? 0) === 0);
  const unsettled = (forecast?.signals ?? []).filter((signal) => signal.id.startsWith('unsettled:'));
  const newThisMonth = tenants.filter((tenant) => ageDays(tenant.createdAt) <= 30);

  const nothingToDo = trials.length === 0 && unreachable.length === 0 && silent.length === 0 && unsettled.length === 0;

  render(
    root,
    html`
      ${head({
        title: 'Onboarding queue',
        intent:
          'Everything between somebody signing up and being a working customer. Each queue below is derived from the ' +
          'record rather than maintained by hand, so a tenancy cannot fail to appear because nobody remembered to add it.',
      })}

      <section class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h2>New in 30 days</h2>
          <div class="metric ${raw(newThisMonth.length > 0 ? 'good' : '')}">${newThisMonth.length}</div>
          <div class="metric-sub">tenancies created</div>
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
            <b>Nothing is stuck.</b>No trial is running, no tenancy is without an administrator, nothing has been raised
            and left unpaid, and every tenancy has written something. That is the queue being genuinely empty rather
            than not yet built.
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
              created together. There is no approval step, so there is no queue of applications — this screen is about
              what happens after they are already in.
            </div>
          </div>`
        : ''}
    `,
  );
}
