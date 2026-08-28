import { api } from '../lib/api.js';
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
 */

const STATUS_TONE = { ACTIVE: 'ok', PAUSED: 'warn', ENDED: 'muted' };

/** Shared by both screens. `kind` selects which half of the programme is rendered. */
export async function programme(root, { kind, title, intent, redraw }) {
  const position = await api.get('/v1/admin/growth').catch((error) => ({ error }));

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

  render(
    root,
    html`
      ${head({
        title,
        intent,
        actions: `<button class="btn primary" data-command="enrol">${isPartner ? 'Enrol a partner' : 'Enrol an influencer'}</button>`,
      })}

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

      ${people.map(
        (entry) => html`
          <section class="card">
            <h3>
              ${entry.name}
              ${badge(entry.status.toLowerCase(), STATUS_TONE[entry.status] ?? 'neutral')}
              ${isPartner
                ? badge(`${((entry.commissionBps ?? 0) / 100).toFixed(1)}% of receipts`, 'info')
                : badge(`${money(entry.bountyMinor ?? 0)} per paying tenancy`, 'info')}
            </h3>
            <p class="metric-sub">
              <span class="mono">${entry.code}</span> · ${entry.email} · agreed ${time(entry.agreedAt)}
              ${entry.audience ? ` · ${entry.audience}` : ''}
              ${entry.endedReason ? ` · ended: ${entry.endedReason}` : ''}
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

            <div class="actions" style="margin-top:12px">
              <button class="btn quiet" data-payout="${entry.id}">Record a payout</button>
              <button class="btn quiet" data-status="${entry.id}">Change status</button>
            </div>
          </section>
        `,
      )}

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
        </div>
      </div>
    `,
  );

  const again = () => redraw(root);

  root.querySelector('.cmd-bar')?.addEventListener('click', async (event) => {
    if (!event.target.closest('[data-command="enrol"]')) return;
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
          hint: 'Goes in their link as ?ref=CODE. Letters, numbers and hyphens. Never reused, including after the agreement ends.',
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
                hint: 'Paid once, and only once the tenancy has actually paid something.',
              },
              { name: 'audience', label: 'Where their audience is', required: false, hint: 'For your own record. Free text.' },
            ]),
      ],
    });
    if (ok) {
      toast('Enrolled', `${ok.name} · code ${ok.code}`, 'ok');
      await again();
    }
  });

  for (const button of root.querySelectorAll('[data-payout]')) {
    button.addEventListener('click', async () => {
      const partnerId = button.getAttribute('data-payout');
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
