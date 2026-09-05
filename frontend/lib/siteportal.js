import { badge, html, money, table } from './ui.js';
import { refusal } from './estate.js';

/**
 * The supplier portal's payment state, on the two screens that show it.
 *
 * A signed-in supplier reads it on their own screen; a buyer reads it beside
 * the supplier-portal command centre on Site Services. One card, because the
 * two readers are looking at the same record and a second rendering would be
 * a second chance to describe an apportionment differently.
 */
export function supplierPaymentCard(portal) {
  if (!portal) return '';
  if (portal.error) return refusal('The supplier portal', portal.error);
  const { supplier, payment, scopedBy } = portal;
  const t = payment.totals;
  return html`
    <div class="card" style="margin-bottom:14px">
      <h2>Valuation and payment state — ${supplier.legalName}</h2>
      <div class="metric-sub" style="margin:6px 0 12px">
        ${payment.statement}
        ${scopedBy === 'SIGN_IN'
          ? html` This sign-in belongs to ${supplier.legalName}; it sees ${supplier.legalName}’s obligations and nobody else’s.`
          : ''}
      </div>
      <section class="grid g4" style="margin-bottom:14px">
        <div class="card"><h2>Committed</h2><div class="metric">${money(t.commitmentMinor)}</div><div class="metric-sub">across the lines under award</div></div>
        <div class="card"><h2>Earned</h2><div class="metric">${money(t.earnedMinor)}</div><div class="metric-sub">${money(t.accruedMinor)} above certified is accrual</div></div>
        <div class="card"><h2>Certified</h2><div class="metric">${money(t.certifiedMinor)}</div><div class="metric-sub">on ${payment.valuations.length} certificate${payment.valuations.length === 1 ? '' : 's'}</div></div>
        <div class="card ${t.outstandingMinor > 0 ? 'warn' : ''}"><h2>Certified, unpaid</h2><div class="metric">${money(t.outstandingMinor)}</div><div class="metric-sub">${money(t.paidMinor)} paid</div></div>
      </section>
      ${table({
        headers: ['Certificate', 'Period to', 'Payer', 'Certified for you', 'Paid', 'Outstanding'],
        align: ['', '', '', 'num', 'num', 'num'],
        rows: payment.valuations.map((entry) => [
          entry.reference,
          entry.periodTo,
          entry.payer ?? '—',
          money(entry.certifiedMinor),
          html`${money(entry.paidMinor)}${entry.apportioned ? html` ${badge('apportioned', 'info')}` : ''}`,
          money(entry.outstandingMinor),
        ]),
        empty: 'No certificate carries a line under this firm’s award yet.',
      })}
      <div style="margin-top:12px">
        ${table({
          headers: ['Line', 'Description', 'Committed', 'Earned', 'Certified'],
          align: ['', '', 'num', 'num', 'num'],
          rows: payment.lines.map((line) => [line.reference, line.description, money(line.commitmentMinor), money(line.earnedMinor), money(line.certifiedMinor)]),
          empty: 'No contract line is attached to this firm’s award on this project.',
        })}
      </div>
    </div>
  `;
}
