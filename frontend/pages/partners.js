import { api } from '../lib/api.js';
import { lineChart } from '../lib/charts.js';
import { command } from '../lib/command.js';
import { head, refusal } from '../lib/estate.js';
import { badge, date, html, money, pct, raw, render, table, time, toast } from '../lib/ui.js';

/**
 * The growth programme — the reseller half.
 *
 * Influencers use the same records and the same routes and are on their own
 * screen, because the two are read for different reasons: a partner is a
 * recurring commercial relationship you manage, an influencer is a campaign you
 * measure. `programme()` below is shared by both and takes the kind it renders.
 *
 * **One rule runs through the whole thing: commission is computed from payments
 * the platform has actually received.** Not signups, not pipeline, not a
 * tenancy's stated intent. A referral programme that accrues against expected
 * revenue eventually pays commission on money that never arrived, and the person
 * it paid is not going to give it back. So the screen shows attributed revenue
 * beside earned, and both are walked from settled receipts.
 *
 * A payout is recorded, never made. There is no outbound payment rail on this
 * platform and pretending otherwise inside a financial record would be the worst
 * kind of fiction to write.
 *
 * Above the agreements sits the programme read as a whole — the engine: a sweep
 * of eleven things read off the served signup form, the route table, the public
 * page, the agreements and the receipts; a health score that is the weights of
 * what passes and decides nothing; results by month; what the agent recommends,
 * each with its door; and for every agreement a kit — the links and the copy,
 * with the relationship disclosed — and a statement of every receipt the
 * earnings rest on.
 */

const STATUS_TONE = { ACTIVE: 'ok', PAUSED: 'warn', ENDED: 'muted' };
const BAND_TONE = { STRONG: 'ok', WORKABLE: 'warn', WEAK: 'bad' };
const PRIORITY_TONE = { HIGH: 'bad', MEDIUM: 'warn', LOW: 'info' };

/** Shared by both screens. `kind` selects which half of the programme is rendered. */
export async function programme(root, { kind, title, intent, redraw }) {
  const [position, engine] = await Promise.all([
    api.get('/v1/admin/growth').catch((error) => ({ error })),
    api.get('/v1/admin/growth/position').catch((error) => ({ error })),
  ]);

  if (position.error) {
    render(root, html`${head({ title })}${refusal('The growth programme', position.error)}`);
    return;
  }

  const isPartner = kind === 'PARTNER';
  const people = (isPartner ? position.partners : position.influencers) ?? [];
  const totals = {
    referred: people.reduce((sum, entry) => sum + entry.referredCount, 0),
    converted: people.reduce((sum, entry) => sum + entry.convertedCount, 0),
    revenue: people.reduce((sum, entry) => sum + entry.attributedRevenueMinor, 0),
    earned: people.reduce((sum, entry) => sum + entry.earnedMinor, 0),
    paid: people.reduce((sum, entry) => sum + entry.paidMinor, 0),
    owed: people.reduce((sum, entry) => sum + entry.owedMinor, 0),
  };
  const eng = engine && !engine.error ? engine : null;
  const extras = new Map((eng?.people ?? []).map((entry) => [entry.id, entry]));

  render(
    root,
    html`
      ${head({
        title,
        intent,
        actions: `<button class="btn primary" data-command="enrol">${isPartner ? 'Enrol a partner' : 'Enrol an influencer'}</button>`,
      })}

      ${engine?.error ? refusal('The programme position', engine.error) : ''}

      ${eng
        ? html`<section class="grid g4" style="margin-bottom:14px">
            <div class="card">
              <h2>Programme health</h2>
              <div class="metric ${raw(eng.health.band === 'STRONG' ? 'good' : eng.health.band === 'WORKABLE' ? 'warn' : 'bad')}">${eng.health.score}</div>
              <div class="metric-sub">${eng.health.passing} of ${eng.health.total} checks passing · ${eng.health.band.toLowerCase()}</div>
            </div>
            <div class="card">
              <h2>Whole programme</h2>
              <div class="metric">${eng.results.totals.referredTenancies}</div>
              <div class="metric-sub">
                tenancies attributed across ${eng.results.totals.enrolled} agreement${eng.results.totals.enrolled === 1 ? '' : 's'} ·
                ${eng.results.totals.conversionPercent === null ? 'no conversion yet' : `${eng.results.totals.conversionPercent}% have paid`}
              </div>
            </div>
            <div class="card">
              <h2>Revenue attributed</h2>
              <div class="metric">${money(eng.results.totals.attributedRevenueMinor)}</div>
              <div class="metric-sub">settled receipts, both halves of the programme · ${money(eng.results.totals.earnedMinor)} earned by partners</div>
            </div>
            <div class="card ${raw(eng.results.totals.owedMinor > 0 ? 'warn' : '')}">
              <h2>Owed, programme-wide</h2>
              <div class="metric ${raw(eng.results.totals.owedMinor > 0 ? 'warn' : '')}">${money(eng.results.totals.owedMinor)}</div>
              <div class="metric-sub">${money(eng.results.totals.paidMinor)} recorded as paid · ${eng.people.filter((entry) => entry.overdue).length} overdue</div>
            </div>
          </section>`
        : ''}

      <section class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h2>${isPartner ? 'Partners' : 'Influencers'}</h2>
          <div class="metric">${people.filter((entry) => entry.status === 'ACTIVE').length}</div>
          <div class="metric-sub">active of ${people.length} enrolled</div>
        </div>
        <div class="card">
          <h2>Tenancies brought</h2>
          <div class="metric">${totals.referred}</div>
          <div class="metric-sub">
            ${totals.converted} ${totals.converted === 1 ? 'has' : 'have'} paid something ·
            ${totals.referred === 0 ? 'no conversion rate yet' : `${pct((totals.converted / totals.referred) * 100, 0)} converted`}
          </div>
        </div>
        <div class="card">
          <h2>Revenue attributed</h2>
          <div class="metric">${money(totals.revenue)}</div>
          <div class="metric-sub">settled receipts on tenancies carrying one of these codes</div>
        </div>
        <div class="card">
          <h2>Owed</h2>
          <div class="metric ${raw(totals.owed > 0 ? 'warn' : '')}">${money(totals.owed)}</div>
          <div class="metric-sub">${money(totals.earned)} earned · ${money(totals.paid)} recorded as paid</div>
        </div>
      </section>

      ${eng && eng.recommendations.length > 0
        ? html`<div class="card" style="margin-bottom:14px">
            <h2>What the agent recommends</h2>
            <div class="metric-sub" style="margin:8px 0 12px">
              Derived from the sweep, the agreements and the receipts — no model, no invented figure. Each names what it
              costs and offers the door that fixes it. It proposes; you press.
            </div>
            <div class="split-list">
              ${eng.recommendations.map(
                (item) => html`<div class="row" style="align-items:flex-start;gap:14px">
                  <span class="lbl" style="flex:1 1 0;min-width:0">
                    ${badge(item.priority.toLowerCase(), PRIORITY_TONE[item.priority] ?? 'info')} <b>${item.title}</b><br />
                    <span class="metric-sub">${item.detail}</span>
                  </span>
                  ${item.action
                    ? html`<span class="val"><button class="btn quiet sm" data-act="${item.action.command}" data-partner="${item.action.partnerId ?? ''}" data-code="${item.action.code ?? ''}">${item.action.label}</button></span>`
                    : ''}
                </div>`,
              )}
            </div>
          </div>`
        : ''}

      ${eng
        ? html`<div class="card" style="margin-bottom:14px">
            <h2>Programme sweep ${badge(`${eng.health.score} / 100`, BAND_TONE[eng.health.band] ?? 'neutral')}</h2>
            <div class="metric-sub" style="margin:8px 0 12px">
              ${eng.health.summary} Every check reads the served signup form, the route table, the public page, the
              agreements or the receipts — never a setting that says it is fine. The score decides nothing: commission is
              computed from settled receipts whatever it says.
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
        ? html`<div class="card chart-card" style="margin-bottom:14px">
            <h2>Results by month</h2>
            <div class="metric-sub" style="margin-bottom:12px">
              Settled receipts on attributed tenancies, and what those receipts earned across the programme, by the month
              the money arrived. Both halves of the programme.
            </div>
            ${lineChart({
              title: 'Attributed revenue and earnings, by month',
              data: eng.results.series.map((entry) => ({ label: entry.month, revenue: entry.revenueMinor / 100, earned: entry.earnedMinor / 100 })),
              series: [
                { key: 'revenue', label: 'Revenue attributed' },
                { key: 'earned', label: 'Earned by partners' },
              ],
              format: (value) => money(Math.round(value * 100)),
              empty: 'No attributed receipt yet.',
            })}
          </div>`
        : ''}

      ${(position.unattributed ?? []).length > 0
        ? html`<div class="notice warn" style="margin-bottom:14px">
            <div>
              <b>${position.unattributed.length} tenanc${position.unattributed.length === 1 ? 'y' : 'ies'} arrived with a
              code nobody holds.</b><br />
              Almost always a typo in somebody's link — which means somebody is sending traffic and getting no credit
              for it. ${position.unattributed
                .slice(0, 6)
                .map((entry) => `${entry.legalName} (${entry.code}, ${date(entry.joinedAt)})`)
                .join(' · ')}
            </div>
          </div>`
        : ''}

      ${people.length === 0
        ? html`<div class="empty">
            <b>Nobody is enrolled.</b>A signup link carrying <span class="mono">?ref=CODE</span> credits whoever holds
            that code, fixed at the moment somebody signs up. Until somebody is enrolled, every code that arrives is
            unattributed.
          </div>`
        : ''}

      ${people.map((entry) => {
        const extra = extras.get(entry.id);
        return html`
          <section class="card" id="partner-${entry.id}">
            <h3>
              ${entry.name}
              ${badge(entry.status.toLowerCase(), STATUS_TONE[entry.status] ?? 'neutral')}
              ${isPartner
                ? badge(`${((entry.commissionBps ?? 0) / 100).toFixed(1)}% of receipts`, 'info')
                : badge(`${money(entry.bountyMinor ?? 0)} per paying tenancy`, 'info')}
              ${extra?.overdue ? badge('payout overdue', 'bad') : ''}
              ${extra?.idleDays !== null && extra?.idleDays !== undefined && extra.idleDays > 30 ? badge('idle ' + extra.idleDays + ' days', 'warn') : ''}
            </h3>
            <p class="metric-sub">
              <span class="mono">${entry.code}</span> · ${entry.email} · agreed ${time(entry.agreedAt)}
              ${entry.audience ? ` · ${entry.audience}` : ''}
              ${entry.endedReason ? ` · ended: ${entry.endedReason}` : ''}
              ${extra?.newestReceiptAt ? ` · last receipt ${date(extra.newestReceiptAt)}` : ''}
            </p>

            <div class="split-list">
              <div class="row"><span class="lbl">Tenancies brought</span><span class="val">${entry.referredCount}</span></div>
              <div class="row"><span class="lbl">Of those, paying</span><span class="val">${entry.convertedCount}</span></div>
              <div class="row"><span class="lbl">Revenue attributed</span><span class="val">${money(entry.attributedRevenueMinor)}</span></div>
              <div class="row"><span class="lbl">Earned</span><span class="val">${money(entry.earnedMinor)}</span></div>
              <div class="row"><span class="lbl">Recorded as paid</span><span class="val">${money(entry.paidMinor)}</span></div>
              <div class="row">
                <span class="lbl">Owed</span>
                <span class="val">${badge(money(entry.owedMinor), entry.owedMinor > 0 ? 'warn' : 'ok')}</span>
              </div>
            </div>

            ${entry.referrals.length > 0
              ? html`<div style="margin-top:12px">
                  ${raw(
                    table({
                      headers: ['Tenancy', 'Joined', 'Tier', 'Status', 'Paid to date', 'Their share'],
                      align: ['', '', '', '', 'num', 'num'],
                      rows: entry.referrals.map((referral) => [
                        referral.legalName,
                        date(referral.joinedAt),
                        referral.tier,
                        badge(referral.status.toLowerCase(), referral.status === 'ACTIVE' ? 'ok' : 'warn'),
                        money(referral.lifetimeRevenueMinor),
                        money(referral.earnedMinor),
                      ]),
                    }),
                  )}
                </div>`
              : html`<div class="metric-sub" style="margin-top:12px">
                  Nothing has arrived on this code yet.
                </div>`}

            ${entry.payouts.length > 0
              ? html`<div style="margin-top:12px">
                  ${raw(
                    table({
                      headers: ['Paid', 'Amount', 'Reference', 'Note'],
                      align: ['', 'num', '', ''],
                      rows: entry.payouts.map((payout) => [time(payout.at), money(payout.amountMinor), payout.reference, payout.note ?? '—']),
                    }),
                  )}
                </div>`
              : ''}

            ${extra
              ? html`<details style="margin-top:12px" data-kit="${entry.id}">
                  <summary class="metric-sub"><b>Referral kit</b> — the links and the copy to send them, relationship disclosed</summary>
                  ${raw(
                    table({
                      headers: ['Channel', 'Paste this', ''],
                      rows: extra.kit.map((item) => [
                        html`<b>${item.label}</b>`,
                        html`<span style="white-space:pre-wrap;font-size:12px">${item.text}</span>`,
                        item.url ? html`<a class="btn quiet sm" href="${item.url}" target="_blank" rel="noreferrer">Open</a>` : '',
                      ]),
                    }),
                  )}
                </details>`
              : ''}

            <div class="actions" style="margin-top:12px">
              <button class="btn quiet" data-payout="${entry.id}">Record a payout</button>
              <button class="btn quiet" data-status="${entry.id}">Change status</button>
              <button class="btn quiet" data-statement="${entry.id}" data-name="${entry.name}">Statement (CSV)</button>
            </div>
          </section>
        `;
      })}

      <div class="card" style="margin-top:14px">
        <h2>How this is computed</h2>
        <div class="metric-sub" style="margin-top:8px">
          ${position.summary}<br /><br />
          <b>Attribution is fixed at signup.</b> The referral code is written onto the tenancy when it is created and
          never afterwards — attribution that can be edited later is attribution somebody can rewrite once they know
          what a tenancy turned out to be worth.<br /><br />
          <b>A code is never reused</b>, including after an agreement ends. An old link that quietly starts crediting a
          different person is an error nobody can detect from the outside.<br /><br />
          <b>Recording a payout does not send money.</b> There is no outbound payment rail here. This writes down that
          somebody was paid, against the bank's own reference — which is the idempotency key, so the same reference
          twice records once.
          ${eng ? html`<br /><br /><b>What this screen is not.</b>${eng.limits.map((limit) => html`<div>· ${limit}</div>`)}` : ''}
        </div>
      </div>
    `,
  );

  const again = () => redraw(root);

  const enrol = async (presetCode = '') => {
    const ok = await command({
      title: isPartner ? 'Enrol a partner' : 'Enrol an influencer',
      intent: isPartner
        ? 'A reseller or consultancy who introduces tenancies and takes a share of what those tenancies pay, for as ' +
          'long as they keep paying. The share applies to settled receipts only.'
        : 'Somebody with an audience, paid a fixed amount for each tenancy they bring that goes on to pay something. ' +
          'Not a share of revenue — a bounty per conversion.',
      path: '/v1/admin/growth',
      submitLabel: 'Enrol',
      fields: [
        { name: 'kind', label: 'Kind', type: 'select', value: kind, options: [{ value: kind, label: isPartner ? 'Partner' : 'Influencer' }] },
        { name: 'name', label: 'Name', hint: 'The person or company the agreement is with' },
        { name: 'email', label: 'Email', hint: 'How they are reached about what they are owed' },
        {
          name: 'code',
          label: 'Referral code',
          value: presetCode,
          hint: presetCode
            ? `A tenancy already arrived carrying ${presetCode}; enrolling under this exact code attributes it from the record.`
            : 'Goes in their link as ?ref=CODE. Letters, numbers and hyphens. Never reused, including after the agreement ends.',
        },
        ...(isPartner
          ? [
              {
                name: 'commissionBps',
                label: 'Commission (basis points)',
                type: 'number',
                hint: '1000 is 10% of everything a referred tenancy ever pays. The ceiling is 5000.',
              },
            ]
          : [
              {
                name: 'bountyMinor',
                label: 'Bounty per paying tenancy (pence)',
                type: 'number',
                hint: 'Paid once, and only once the tenancy has actually paid something. Keep it under the cheapest paid month, or a conversion pays out more than arrives.',
              },
              { name: 'audience', label: 'Where their audience is', required: false, hint: 'For your own record. Free text.' },
            ]),
      ],
    });
    if (ok) {
      toast('Enrolled', `${ok.name} · code ${ok.code}`, 'ok');
      await again();
    }
  };

  const payout = async (partnerId) => {
    const ok = await command({
      title: 'Record a payout',
      intent:
        'This records money that has already been sent. It does not transfer anything — the platform has no outbound ' +
        'rail. The reference is the bank’s and is the idempotency key: the same reference twice records once.',
      path: `/v1/admin/growth/${partnerId}/payout`,
      submitLabel: 'Record it',
      fields: [
        { name: 'amountMinor', label: 'Amount sent (pence)', type: 'number', hint: '£100 is 10000.' },
        { name: 'reference', label: 'Bank reference', hint: 'Unique for ever. Do not invent one.' },
        { name: 'note', label: 'Note', required: false },
      ],
    });
    if (ok) {
      toast(ok.alreadyRecorded ? 'Already recorded' : 'Payout recorded', ok.alreadyRecorded ? 'That reference was already on the record — nothing was recorded twice.' : '', ok.alreadyRecorded ? 'warn' : 'ok');
      await again();
    }
  };

  root.querySelector('.cmd-bar')?.addEventListener('click', async (event) => {
    if (!event.target.closest('[data-command="enrol"]')) return;
    await enrol();
  });

  // A recommendation's own door: the same commands the buttons offer, pressed
  // from the line that says why. `kit` opens the partner's kit; `deploy` names
  // what is missing on the server rather than pretending a button fixes it.
  for (const button of root.querySelectorAll('[data-act]')) {
    button.addEventListener('click', async () => {
      const act = button.getAttribute('data-act');
      const partnerId = button.getAttribute('data-partner');
      if (act === 'enrol') await enrol(button.getAttribute('data-code') || '');
      else if (act === 'payout' && partnerId) await payout(partnerId);
      else if (act === 'kit' && partnerId) {
        const kit = root.querySelector(`[data-kit="${CSS.escape(partnerId)}"]`);
        if (kit) {
          kit.open = true;
          kit.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
          toast('On the other screen', 'This agreement is on the other half of the programme — Influencers or Growth partner programme.', 'err');
        }
      } else if (act === 'deploy') {
        toast('Deploy the current build', 'The referral link needs the served signup form to read ?ref= and the signup route to accept referralCode. Both are in this build; the sweep reads the deployment.', 'err');
      }
    });
  }

  for (const button of root.querySelectorAll('[data-payout]')) {
    button.addEventListener('click', () => payout(button.getAttribute('data-payout')));
  }

  for (const button of root.querySelectorAll('[data-statement]')) {
    button.addEventListener('click', async () => {
      // Hoisted rather than interpolated inline: the doors invariant reads the
      // literal path this console calls and matches its segments to the route.
      const partnerId = button.getAttribute('data-statement');
      try {
        await api.download(`/v1/admin/growth/${partnerId}/statement`);
        toast('Statement downloaded', `${button.getAttribute('data-name')} — every receipt the earnings rest on, what was earned, paid and is owed.`, 'ok');
      } catch (error) {
        toast('Could not download', error.message, 'err');
      }
    });
  }

  for (const button of root.querySelectorAll('[data-status]')) {
    button.addEventListener('click', async () => {
      const partnerId = button.getAttribute('data-status');
      const ok = await command({
        title: 'Change the agreement',
        intent:
          'Paused stops nothing already attributed — the tenancies they brought keep paying and keep accruing. Ended ' +
          'closes the agreement, and their code is still never reused.',
        path: `/v1/admin/growth/${partnerId}/status`,
        submitLabel: 'Apply',
        fields: [
          {
            name: 'status',
            label: 'Status',
            type: 'select',
            options: [
              { value: 'ACTIVE', label: 'Active' },
              { value: 'PAUSED', label: 'Paused' },
              { value: 'ENDED', label: 'Ended' },
            ],
          },
          { name: 'reason', label: 'Why', hint: 'Recorded against the change. A commercial agreement altered with no stated reason is unreadable later.' },
        ],
      });
      if (ok) await again();
    });
  }
}

export async function partners(root) {
  await programme(root, {
    kind: 'PARTNER',
    title: 'Growth partner programme',
    intent:
      'Resellers, consultancies and integrators who introduce tenancies and take a share of what those tenancies pay. ' +
      'Commission is walked from settled payment receipts, so nothing is owed against money that has not arrived.',
    redraw: partners,
  });
}
