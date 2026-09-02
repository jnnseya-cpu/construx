import { api } from '../lib/api.js';
import { command } from '../lib/command.js';
import { badge, html, money, notice, raw, render, table, toast } from '../lib/ui.js';
import { barChart, gauge, kpiCard } from '../lib/charts.js';

/**
 * Your account with us — the tenancy's commercial relationship with **this
 * platform**, as distinct from its commercial position on its own projects.
 *
 * Named apart from `commercial.js` deliberately. That screen is Cost & Value:
 * budget, commitments and actuals on the customer's own jobs, which is the
 * customer's money moving between them and their supply chain. This one is what
 * the customer pays us, what we earned on money we carried for them, what they
 * are up against in their entitlement, and whether they have consented to
 * contribute to cross-company benchmarks. Two screens with the word "commercial"
 * in them is a naming problem; one screen carrying both subjects would be a
 * comprehension problem, which is worse.
 *
 * Four things that were built and unreachable until this existed.
 *
 * The screen is shown to the **customer**, not only to an operator. A platform
 * that computes "this account is decaying, propose an upgrade" and shows it only
 * to its own sales team has built a file on somebody. The same reading handed to
 * the customer is a service: it names what they pay for and do not use, and it
 * tells them their own usage is falling — their information, which almost no
 * supplier gives them.
 */

let chosenTab = 'position';

const BAND_TONE = { ENGAGED: 'ok', SOFTENING: 'warn', DECAYING: 'bad', DORMANT: 'bad', TOO_NEW_TO_SAY: 'neutral' };
const PROPOSAL_TONE = { EXPAND: 'warn', REDUCE: 'info', NOTHING_TO_PROPOSE: 'neutral' };

export async function platformCommercial(root) {
  const [position, revenue] = await Promise.all([
    api.get('/v1/admin/commercial').catch((error) => ({ error })),
    api.get('/v1/admin/transaction-revenue').catch((error) => ({ error })),
  ]);

  if (position.error) {
    render(
      root,
      html`
        <div class="view-head"><div><h1>Your account with us</h1></div></div>
        ${notice(
          'This screen needs enterprise administrator access on this tenancy, which this identity does not hold.',
          'warn',
        )}
      `,
    );
    return;
  }

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Your account with us</h1>
          <p>${position.expansion.summary}</p>
        </div>
        <div class="actions">
          <button class="btn ${raw(chosenTab === 'position' ? '' : 'ghost')}" data-tab="position">Your position</button>
          <button class="btn ${raw(chosenTab === 'revenue' ? '' : 'ghost')}" data-tab="revenue">Money we carried</button>
          <button class="btn ${raw(chosenTab === 'benchmark' ? '' : 'ghost')}" data-tab="benchmark">Benchmarks</button>
        </div>
      </div>

      ${chosenTab === 'position'
        ? positionView(position)
        : chosenTab === 'revenue'
          ? revenueView(revenue)
          : benchmarkView(position)}
    `,
  );

  for (const button of root.querySelectorAll('[data-tab]')) {
    button.addEventListener('click', () => {
      chosenTab = button.dataset.tab;
      platformCommercial(root);
    });
  }

  const consentButton = root.querySelector('[data-consent]');
  consentButton?.addEventListener('click', () => {
    const granting = consentButton.dataset.consent === 'grant';
    command({
      title: granting ? 'Contribute to benchmarks' : 'Withdraw from benchmarks',
      intent: granting
        ? position.benchmarkConsent.scope
        : 'Stop contributing this company’s figures to future benchmarks. Nothing that named this company was ever ' +
          'in one, and withdrawing takes effect on every benchmark published from here.',
      method: 'POST',
      path: '/v1/admin/benchmark-consent',
      fields: [],
      body: { granted: granting },
      onDone: () => {
        toast(
          granting ? 'Consent recorded' : 'Consent withdrawn',
          granting
            ? 'This company now contributes to cross-company benchmarks.'
            : 'This company no longer contributes to future benchmarks.',
          'ok',
        );
        platformCommercial(root);
      },
    });
  });
}

/** Entitlement pressure and the engagement reading. */
function positionView(position) {
  const engagement = position.engagement;
  const proposals = position.expansion.proposals;

  return html`
    <div class="chart-row">
      ${kpiCard({
        label: 'Package',
        value: position.expansion.tier,
        detail: position.expansion.largerPackageExists ? 'A larger package exists' : 'The largest package there is',
        tone: 'neutral',
      })}
      ${kpiCard({
        label: 'Engagement',
        value: engagement.band.replace(/_/g, ' '),
        detail:
          engagement.decay === null
            ? 'Not enough history to read a change'
            : `${Math.round(Math.abs(engagement.decay) * 100)}% ${engagement.decay > 0 ? 'down' : 'up'} on the period before`,
        tone: BAND_TONE[engagement.band] ?? 'neutral',
      })}
      ${gauge({
        label: 'Days with work on them',
        value: engagement.window.activeDays,
        max: engagement.window.periodDays,
        caption: `Work happened on ${engagement.window.activeDays} of the last ${engagement.window.periodDays} days.`,
      })}
    </div>

    <section class="card">
      <h2>What you are against</h2>
      ${table({
        headers: ['', 'Measured', 'Finding', 'What to do'],
        rows: proposals.map((proposal) => [
          badge(proposal.kind.replace(/_/g, ' '), PROPOSAL_TONE[proposal.kind] ?? 'neutral'),
          proposal.measurement,
          proposal.finding,
          proposal.action,
        ]),
        empty: 'Everything is comfortably within its limits.',
        emptyDetail: 'Nothing is close to a ceiling, and nothing is being paid for and left unused.',
      })}
    </section>

    <section class="card">
      <h2>Whether the platform is being used</h2>
      ${barChart({
        title: 'Events written, this period against the last',
        data: [
          { label: 'Previous', value: engagement.window.prior },
          { label: 'Latest', value: engagement.window.recent },
        ],
        labelKey: 'label',
        valueKey: 'value',
      })}

      <h3>What was measured</h3>
      <ul>${raw(engagement.measurements.map((line) => `<li>${escapeText(line)}</li>`).join(''))}</ul>

      <h3>What it might mean</h3>
      <ul>${raw(engagement.interpretations.map((line) => `<li>${escapeText(line)}</li>`).join(''))}</ul>

      ${notice(engagement.action, BAND_TONE[engagement.band] === 'bad' ? 'warn' : 'info')}

      <p class="muted">
        A measurement, not a prediction. There is no model behind this and no probability: this platform has not been
        running long enough to have trained one, and a percentage produced without that would be a number with a
        decimal point and nothing behind it.
      </p>
    </section>
  `;
}

/** Transaction revenue: what the platform earned on money it actually carried. */
function revenueView(revenue) {
  if (revenue.error) {
    return notice('This part of the page needs enterprise administrator access on this tenancy.', 'warn');
  }
  const position = revenue.revenue;

  return html`
    <div class="chart-row">
      ${kpiCard({
        label: 'Fees settled',
        value: money(position.earnedMinor, position.currency),
        detail: `${position.settlements.settled} settlement${position.settlements.settled === 1 ? '' : 's'}`,
        tone: 'ok',
      })}
      ${kpiCard({
        label: 'Value carried',
        value: money(position.facilitatedMinor, position.currency),
        detail: 'Money the platform took in, held and paid out',
        tone: 'neutral',
      })}
      ${kpiCard({
        label: 'Take rate',
        value: position.takeRate === null ? '—' : `${(position.takeRate * 100).toFixed(3)}%`,
        detail: position.takeRate === null ? 'Nothing carried yet' : 'Fees as a share of value carried',
        tone: 'info',
      })}
    </div>

    <section class="card">
      <h2>What is charged, and what is not</h2>
      <p class="muted">
        A fee is earned only where this platform <b>carried</b> the money. Recording a payment the parties made
        directly is what the subscription buys and is charged nothing — those appear below with a zero fee and a
        stated reason, rather than not appearing at all.
      </p>
      ${table({
        headers: ['Up to', 'Rate'],
        rows: revenue.bands.map((band) => [
          band.uptoMinor === null ? 'Above that' : money(band.uptoMinor, position.currency),
          `${(band.rate * 100).toFixed(2)}%`,
        ]),
        empty: 'No bands configured.',
      })}
      ${notice(
        `Never less than ${plainMoney(revenue.floorMinor, position.currency)} — below that the fee costs less than ` +
          `making the transfer. Never more than ${plainMoney(revenue.capMinor, position.currency)}, whatever the ` +
          'transaction: an uncapped percentage on construction payments is not a pricing model, it is a tax.',
        'info',
      )}
    </section>

    <section class="card">
      <h2>Settlements</h2>
      ${table({
        headers: ['Raised', 'Against', 'Amount', 'Rail', 'Fee', 'Net', 'Status'],
        rows: revenue.settlements.map((record) => [
          record.raisedAt.slice(0, 10),
          `${record.againstRef.refType} ${String(record.againstRef.refId).slice(-8)}`,
          money(record.amountMinor, record.currency),
          badge(
            record.rail === 'FACILITATED' ? 'Carried' : 'Recorded',
            record.rail === 'FACILITATED' ? 'info' : 'neutral',
          ),
          money(record.feeMinor, record.currency),
          money(record.netMinor, record.currency),
          badge(record.status, record.status === 'SETTLED' ? 'ok' : record.status === 'REVERSED' ? 'bad' : 'warn'),
        ]),
        empty: 'No settlements have been raised on this tenancy.',
        emptyDetail: 'A settlement is raised against a certificate or invoice when money moves through the platform.',
      })}
    </section>
  `;
}

/** Benchmark consent, and what is guaranteed either way. */
function benchmarkView(position) {
  const consent = position.benchmarkConsent;

  return html`
    <section class="card">
      <h2>Cross-company benchmarks</h2>
      ${notice(
        consent.granted
          ? `This company contributes to benchmarks. Recorded ${consent.decidedAt ? consent.decidedAt.slice(0, 10) : ''}.`
          : 'This company does not contribute to benchmarks. Nothing about it enters any published figure.',
        consent.granted ? 'ok' : 'neutral',
      )}

      <h3>What you would be agreeing to</h3>
      <p>${consent.scope}</p>

      <h3>What is guaranteed either way</h3>
      <ul>
        <li>${consent.note}</li>
        <li>
          No minimum or maximum is ever published. Either would be one company's own figure, and calling it "the
          lowest in the cohort" does not change what it is.
        </li>
        <li>
          A cohort too small to hide in is refused rather than thinned — and refused again where one company
          dominates it, which a count on its own cannot detect.
        </li>
        <li>Consent can be withdrawn at any time and takes effect on every benchmark published afterwards.</li>
      </ul>

      <div class="actions">
        <button
          class="btn ${raw(consent.granted ? 'ghost' : '')}"
          data-consent="${raw(consent.granted ? 'withdraw' : 'grant')}"
        >
          ${consent.granted ? 'Withdraw from benchmarks' : 'Contribute to benchmarks'}
        </button>
      </div>
    </section>
  `;
}

/** Money as a plain string, for the sentences the tagged template is not in. */
function plainMoney(minor, currency) {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency || 'GBP' }).format(minor / 100);
}

/** Text into an HTML-safe string, for the list items built as raw markup. */
function escapeText(value) {
  return String(value).replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`);
}

export const _internals = { positionView, revenueView, benchmarkView, plainMoney };
