import { api } from '../lib/api.js';
import { barChart } from '../lib/charts.js';
import { gb, head, refusal, runway } from '../lib/estate.js';
import { badge, date, html, money, pct, raw, render, table, time } from '../lib/ui.js';

/**
 * Customer value.
 *
 * The estate table answers "who are they". This answers "what is each of them
 * worth, and is that going up or down" — which is a different question and had
 * no screen at all.
 *
 * Value is composed from four things the platform genuinely knows: **what they
 * have paid**, **what they consume**, **how many of them there are**, and **how
 * much record they are building**. The last one is the closest thing to
 * engagement that exists here and is deliberately labelled as what it is — a
 * count of events, not a measure of how much anybody likes the product. A
 * tenancy between projects is quiet and perfectly healthy.
 *
 * There is no health score. Four honest columns beat one invented number, and a
 * score would be the number people quoted.
 */

export async function value(root) {
  const [estate, burn, events] = await Promise.all([
    api.get('/v1/admin/tenants').catch((error) => ({ error })),
    api.get('/v1/admin/burn').catch((error) => ({ error })),
    api.get('/v1/admin/events').catch(() => null),
  ]);

  if (estate.error) {
    render(root, html`${head({ title: 'Customer value' })}${refusal('The tenant estate', estate.error)}`);
    return;
  }

  const tenants = estate.tenants ?? [];
  const burnById = new Map((burn.tenants ?? []).map((row) => [row.tenantId, row]));
  const eventsById = new Map((events?.byTenant ?? []).map((row) => [row.tenantId, row]));

  const rows = tenants
    .map((tenant) => {
      const spend = burnById.get(tenant.id);
      const record = eventsById.get(tenant.id);
      return {
        ...tenant,
        billedMinor: spend?.billedMinor ?? 0,
        runwayDays: spend?.runwayDays ?? null,
        availableMinor: spend?.availableMinor ?? tenant.wallet.availableMinor,
        events: record?.events ?? 0,
        lastWriteAt: record?.lastAt,
      };
    })
    .sort((a, b) => b.lifetimeRevenueMinor - a.lifetimeRevenueMinor);

  const totalRevenue = rows.reduce((sum, row) => sum + row.lifetimeRevenueMinor, 0);
  const paying = rows.filter((row) => row.lifetimeRevenueMinor > 0);
  const largest = paying[0];

  render(
    root,
    html`
      ${head({
        title: 'Customer value',
        intent:
          'What each tenancy has paid, what it consumes, how many people are on it and how much record it is building. ' +
          'Four columns rather than one score — a score would be the number people quoted, and there is nothing here ' +
          'honest enough to build one from.',
      })}

      <section class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h2>Lifetime revenue</h2>
          <div class="metric orange">${money(totalRevenue)}</div>
          <div class="metric-sub">across ${paying.length} paying tenanc${paying.length === 1 ? 'y' : 'ies'} of ${rows.length}</div>
        </div>
        <div class="card">
          <h2>Average per paying tenancy</h2>
          <div class="metric">${paying.length === 0 ? '—' : money(Math.round(totalRevenue / paying.length))}</div>
          <div class="metric-sub">
            ${paying.length === 0 ? 'nothing has been paid yet' : 'lifetime, not annualised — a mean over very few accounts moves a lot'}
          </div>
        </div>
        <div class="card">
          <h2>Concentration</h2>
          <div class="metric ${raw(largest && totalRevenue > 0 && largest.lifetimeRevenueMinor / totalRevenue > 0.5 ? 'warn' : '')}">${
            largest && totalRevenue > 0 ? pct((largest.lifetimeRevenueMinor / totalRevenue) * 100, 0) : '—'
          }</div>
          <div class="metric-sub">
            ${largest && totalRevenue > 0 ? `from ${largest.legalName}, the largest single account` : 'no revenue to concentrate yet'}
          </div>
        </div>
        <div class="card">
          <h2>Record being built</h2>
          <div class="metric">${(events?.total ?? 0).toLocaleString('en-GB')}</div>
          <div class="metric-sub">events across every customer chain</div>
        </div>
      </section>

      ${largest && totalRevenue > 0 && largest.lifetimeRevenueMinor / totalRevenue > 0.5
        ? html`<div class="notice warn" style="margin-bottom:14px">
            <div>
              <b>More than half of all revenue comes from one account.</b><br />
              ${largest.legalName} is ${pct((largest.lifetimeRevenueMinor / totalRevenue) * 100, 0)} of everything the
              platform has been paid. That is a fact about the business, not a fault in it — but it is the fact that
              decides how much a single renewal conversation matters.
            </div>
          </div>`
        : ''}

      <div class="grid g2" style="margin-bottom:14px">
        <div class="card chart-card">
          <h2>By lifetime revenue</h2>
          <div class="metric-sub" style="margin-bottom:12px">Settled receipts only. Largest first.</div>
          ${barChart({
            horizontal: true,
            data: paying.slice(0, 8).map((row) => ({
              label: row.legalName,
              sub: `${row.tier} · ${row.identities} ${row.identities === 1 ? 'person' : 'people'} · ${row.seatsUsed} of ${row.seatsIncluded ?? '∞'} seats`,
              value: row.lifetimeRevenueMinor,
            })),
            format: (value) => money(value),
            empty: 'Nothing has been paid yet.',
          })}
        </div>
        <div class="card chart-card">
          <h2>By AI consumed</h2>
          <div class="metric-sub" style="margin-bottom:12px">
            Charged over the last ${burn.windowDays ?? 30} days. Consumption and revenue are different rankings, and
            where they disagree is where the pricing is wrong in one direction or the other.
          </div>
          ${barChart({
            horizontal: true,
            data: rows
              .filter((row) => row.billedMinor > 0)
              .slice(0, 8)
              .map((row) => ({
                label: row.legalName,
                sub: runway(row, burn.windowDays ?? 30),
                value: row.billedMinor,
                tone: row.runwayDays !== null && row.runwayDays <= 7 ? 'bad' : row.runwayDays !== null && row.runwayDays <= 30 ? 'warn' : '',
              })),
            format: (value) => money(value),
            empty: 'No tenancy has consumed AI in this window.',
          })}
        </div>
      </div>

      <div class="card pad0">
        <h2 style="padding:15px 17px 0">Every tenancy, by what it is worth</h2>
        <div class="metric-sub" style="padding:0 17px 10px">
          <b>Record built</b> is a count of events, and nothing more. A tenancy between projects writes nothing and is
          perfectly healthy; a tenancy that has stopped writing after a busy year is worth asking about. The column
          cannot tell those apart and does not claim to.
        </div>
        ${table({
          headers: ['Tenancy', 'Tier', 'People', 'Seats', 'Lifetime paid', 'AI charged', 'Credit left', 'Storage', 'Record built', 'Last wrote'],
          align: ['', '', 'num', 'num', 'num', 'num', 'num', 'num', 'num', ''],
          rows: rows.map((row) => [
            html`${row.legalName}<div class="metric-sub">${row.jurisdiction} · joined ${date(row.createdAt)}</div>`,
            badge(row.tier, row.tier === 'ENTERPRISE' || row.tier === 'SOVEREIGN' ? 'ai' : 'info'),
            row.identities,
            `${row.seatsUsed} / ${row.seatsIncluded ?? '∞'}`,
            money(row.lifetimeRevenueMinor),
            money(row.billedMinor),
            html`${money(row.availableMinor)}${
              row.runwayDays !== null && row.runwayDays <= 30
                ? badge(`${row.runwayDays}d`, row.runwayDays <= 7 ? 'bad' : 'warn')
                : ''
            }`,
            gb(row.storage.usedBytes),
            row.events.toLocaleString('en-GB'),
            row.lastWriteAt ? time(row.lastWriteAt) : html`<span class="metric-sub">never</span>`,
          ]),
          empty: 'No tenancy on the estate yet.',
        })}
      </div>
    `,
  );
}
