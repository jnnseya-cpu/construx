import { api } from '../lib/api.js';
import { barChart, funnelChart, gauge, pieChart } from '../lib/charts.js';
import { command } from '../lib/command.js';
import { head, refusal } from '../lib/estate.js';
import { badge, html, humanise, raw, render, table, time, toast } from '../lib/ui.js';
import { state } from '../app.js';

/**
 * The support queue.
 *
 * One screen for both sides, because there is one record. An operator sees the
 * estate's queue and the clock the platform is running against; a customer sees
 * their own requests and what they were told. Neither view is a filtered version
 * of the other — the server decides what each may see, and this screen renders
 * whichever it was given.
 *
 * The number that leads is **waiting on us**, not open. A request the customer
 * owes a reply on is not a queue the platform is failing; a request nobody has
 * answered is. And first response is measured once, at the first reply, so the
 * figure cannot be improved by replying twice.
 */

const STATUS_TONE = { OPEN: 'warn', ANSWERED: 'info', WAITING_ON_CUSTOMER: 'info', RESOLVED: 'ok', CLOSED: 'muted' };
const PRIORITY_TONE = { URGENT: 'bad', NORMAL: 'info', LOW: 'muted' };

function thread(ticket) {
  return html`<div class="split-list" style="margin-top:10px">
    ${ticket.messages.map(
      (message) => html`<div class="row" style="align-items:flex-start;gap:14px">
        <span class="lbl" style="flex:0 0 150px;min-width:0">
          <b>${message.authorName}</b><br />
          <span class="metric-sub">${message.side === 'PLATFORM' ? 'CONSTRUX' : ticket.tenantName} · ${time(message.at)}</span>
        </span>
        <span class="val" style="flex:1 1 0;text-align:left;white-space:pre-wrap">${message.body}</span>
      </div>`,
    )}
  </div>`;
}

export async function support(root) {
  const isOperator = (state.session?.user?.roles ?? []).includes('PLATFORM_ADMIN');
  const position = await api.get('/v1/support').catch((error) => ({ error }));

  if (position.error) {
    render(root, html`${head({ title: 'Support' })}${refusal('The support queue', position.error)}`);
    return;
  }

  const tickets = position.tickets ?? [];
  const live = tickets.filter((ticket) => ticket.status !== 'RESOLVED' && ticket.status !== 'CLOSED');
  const settled = tickets.filter((ticket) => ticket.status === 'RESOLVED' || ticket.status === 'CLOSED');

  render(
    root,
    html`
      ${head({
        title: isOperator ? 'Support queue' : 'Support',
        intent: isOperator
          ? `${position.summary} A request is a record on the raising tenancy's own chain, so what somebody was told outlives whoever told them.`
          : 'Anything you raise here is recorded against your tenancy. You can read back exactly what you were told, and when.',
        actions: position.canRaise ? '<button class="btn primary" data-command="raise">Raise a request</button>' : '',
      })}

      ${isOperator
        ? html`<section class="grid g4" style="margin-bottom:14px">
            <div class="card">
              <h2>Waiting on us</h2>
              <div class="metric ${raw(position.awaitingPlatform > 0 ? 'warn' : '')}">${position.awaitingPlatform}</div>
              <div class="metric-sub">of ${position.open} live · ${position.awaitingCustomer} waiting on the customer</div>
            </div>
            <div class="card">
              <h2>Past the target</h2>
              <div class="metric ${raw(position.overdue > 0 ? 'bad' : '')}">${position.overdue}</div>
              <div class="metric-sub">
                urgent ${position.responseTargets.URGENT}h · normal ${position.responseTargets.NORMAL}h · low
                ${position.responseTargets.LOW}h
              </div>
            </div>
            <div class="card">
              <h2>Median first response</h2>
              <div class="metric">${
                position.medianFirstResponseHours === null ? '—' : `${position.medianFirstResponseHours}h`
              }</div>
              <div class="metric-sub">
                ${position.medianFirstResponseHours === null
                  ? 'nothing has been answered yet'
                  : 'first reply only — a queue judged on how fast it closes is a queue optimised for closing'}
              </div>
            </div>
            <div class="card">
              <h2>Unassigned</h2>
              <div class="metric ${raw(position.unassigned > 0 ? 'warn' : '')}">${position.unassigned}</div>
              <div class="metric-sub">live requests nobody has picked up</div>
            </div>
          </section>`
        : ''}

      ${supportCharts(position)}

      ${(position.breaching ?? []).length > 0
        ? html`<div class="notice bad" style="margin-bottom:14px">
            <div>
              <b>${position.breaching.length} request${position.breaching.length === 1 ? ' is' : 's are'} past the
              response target and nobody has replied.</b><br />
              ${position.breaching
                .slice(0, 5)
                .map((entry) => `${entry.reference} (${entry.tenantName}, ${entry.hoursWaiting}h against a ${entry.targetHours}h target)`)
                .join(' · ')}
            </div>
          </div>`
        : ''}

      ${live.length === 0 && settled.length === 0
        ? html`<div class="empty">
            <b>Nothing has been raised.</b>${
              isOperator
                ? 'The queue is empty because nobody has asked for anything, not because nothing is being recorded.'
                : 'If something is wrong or you need something the platform will not do, raise it here and it becomes a record rather than an email.'
            }
          </div>`
        : ''}

      ${live.map(
        (ticket) => html`
          <section class="card">
            <h3>
              <span class="mono">${ticket.reference}</span> ${ticket.subject}
              ${badge(humanise(ticket.status).toLowerCase(), STATUS_TONE[ticket.status] ?? 'neutral')}
              ${badge(ticket.priority.toLowerCase(), PRIORITY_TONE[ticket.priority] ?? 'neutral')}
              ${ticket.waitingOn === 'PLATFORM' ? badge('waiting on us', 'warn') : badge('waiting on them', 'info')}
            </h3>
            <p class="metric-sub">
              ${isOperator ? html`${ticket.tenantName} · ` : ''}raised by ${ticket.raisedByName} ${time(ticket.raisedAt)} ·
              ${humanise(ticket.category).toLowerCase()}
              ${ticket.assignedToName ? ` · picked up by ${ticket.assignedToName}` : isOperator ? ' · nobody has picked this up' : ''}
              ${ticket.respondedAt ? ` · first answered ${time(ticket.respondedAt)}` : ' · not yet answered'}
            </p>

            ${thread(ticket)}

            <div class="actions" style="margin-top:12px">
              <button class="btn" data-reply="${ticket.id}">Reply</button>
              ${isOperator
                ? html`${ticket.assignedTo ? '' : html`<button class="btn quiet" data-assign="${ticket.id}">Pick this up</button>`}
                    <button class="btn quiet" data-resolve="${ticket.id}">Resolve</button>`
                : ''}
            </div>
          </section>
        `,
      )}

      ${settled.length > 0
        ? html`<div class="card pad0" style="margin-top:14px">
            <h2 style="padding:15px 17px 0">Resolved and closed</h2>
            <div class="metric-sub" style="padding:0 17px 10px">
              A resolved request keeps what was done. Replying to one opens it again — a resolution is the platform's
              opinion, and the customer's reply is evidence against it.
            </div>
            ${table({
              headers: isOperator
                ? ['Reference', 'Tenancy', 'Subject', 'Resolved', 'What was done']
                : ['Reference', 'Subject', 'Resolved', 'What was done'],
              rows: settled.map((ticket) =>
                isOperator
                  ? [ticket.reference, ticket.tenantName, ticket.subject, time(ticket.resolvedAt), ticket.resolution ?? '—']
                  : [ticket.reference, ticket.subject, time(ticket.resolvedAt), ticket.resolution ?? '—'],
              ),
            })}
          </div>`
        : ''}
    `,
  );

  /*
   * Every command bar on the screen, not the first one.
   *
   * `querySelector` returns one element. A screen with more than one command
   * bar — and most of them have several, one per panel — wired the first and
   * left the rest inert: the buttons drew, they were not locked, they carried
   * their `data-command`, and pressing them did nothing at all. Reported as
   * "none of these work" on Pipeline & Bids, which renders six.
   *
   * Safe to bind every bar because the handler returns on an id this page does
   * not own, which is the pattern the evidence doors on this page already used
   * with `querySelectorAll` — one bar can carry buttons for two dispatchers.
   */
  for (const bar of root.querySelectorAll('.cmd-bar')) bar.addEventListener('click', async (event) => {
    if (!event.target.closest('[data-command="raise"]')) return;
    const ok = await command({
      title: 'Raise a support request',
      intent:
        'This is recorded against your tenancy rather than sent as an email, so what you are told stays readable later ' +
        'and does not depend on whoever answered still being here.',
      path: '/v1/support',
      submitLabel: 'Raise it',
      fields: [
        { name: 'subject', label: 'In a few words, what is wrong', hint: 'At least eight characters. This is what the queue shows.' },
        {
          name: 'category',
          label: 'What kind of thing is it',
          type: 'select',
          options: Object.entries(position.categories ?? {}).map(([value, label]) => ({ value, label })),
        },
        {
          name: 'priority',
          label: 'How urgent',
          type: 'select',
          required: false,
          value: 'NORMAL',
          options: [
            { value: 'URGENT', label: `Urgent — answered inside ${position.responseTargets?.URGENT ?? 4} hours` },
            { value: 'NORMAL', label: `Normal — answered inside ${position.responseTargets?.NORMAL ?? 24} hours` },
            { value: 'LOW', label: `Low — answered inside ${position.responseTargets?.LOW ?? 72} hours` },
          ],
        },
        {
          name: 'body',
          label: 'What happened',
          type: 'textarea',
          hint: 'What you did, what you expected, and what you have already tried. A one-line request costs a round trip before anybody can start.',
        },
      ],
    });
    if (ok) {
      toast('Raised', `${ok.reference} — it is in the queue`, 'ok');
      await support(root);
    }
  });

  for (const button of root.querySelectorAll('[data-reply]')) {
    button.addEventListener('click', async () => {
      const ticketId = button.getAttribute('data-reply');
      const ok = await command({
        title: 'Reply',
        intent: 'Added to the thread. Which side you are on is taken from your identity, never from this form.',
        path: `/v1/support/${ticketId}/reply`,
        submitLabel: 'Send',
        fields: [{ name: 'body', label: 'Your reply', type: 'textarea' }],
      });
      if (ok) await support(root);
    });
  }

  for (const button of root.querySelectorAll('[data-assign]')) {
    button.addEventListener('click', async () => {
      const ticketId = button.getAttribute('data-assign');
      const ok = await command({
        title: 'Pick this up',
        intent: 'The queue then shows who is actually on it, rather than everybody assuming somebody else is.',
        path: `/v1/support/${ticketId}/assign`,
        submitLabel: 'Take it',
        fields: [
          {
            name: 'operatorId',
            label: 'Operator',
            value: state.session?.user?.id,
            hint: 'Defaults to you. Only an identity holding PLATFORM_ADMIN can be given a request.',
          },
        ],
      });
      if (ok) await support(root);
    });
  }

  for (const button of root.querySelectorAll('[data-resolve]')) {
    button.addEventListener('click', async () => {
      const ticketId = button.getAttribute('data-resolve');
      const ok = await command({
        title: 'Resolve this request',
        intent:
          'What you write is added to the thread, so the customer sees it. A request closed with no stated resolution ' +
          'is useless the next time the same thing happens.',
        path: `/v1/support/${ticketId}/resolve`,
        submitLabel: 'Resolve',
        fields: [{ name: 'resolution', label: 'What was done', type: 'textarea', hint: 'At least ten characters.' }],
      });
      if (ok) await support(root);
    });
  }
}

/**
 * The queue, and whether it is moving.
 *
 * Five tiles and a table. What they do not answer is the one thing a queue is
 * judged on — whether requests are leaving it as fast as they arrive — and the
 * funnel is where that shows: raised, answered, resolved, with the drop between
 * two stages being the backlog rather than a number somebody has to compute.
 *
 * The response target gauge is a measured median against a published target,
 * and where nothing has been answered it is drawn as unmeasured rather than as
 * zero hours, which would read as instant.
 */
function supportCharts(position) {
  if (position?.error) return '';

  const byCategory = (position.byCategory ?? [])
    .map((entry) => ({ label: humanise(String(entry.category ?? entry.label ?? 'Other')), value: Number(entry.count ?? entry.value ?? 0) }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value);

  const total = Number(position.open ?? 0) + Number(position.resolved ?? 0);
  const flow = [
    { label: 'Raised', value: total },
    { label: 'Picked up', value: Math.max(0, total - Number(position.unassigned ?? 0)) },
    { label: 'Resolved', value: Number(position.resolved ?? 0) },
  ].filter((stage) => stage.value > 0);

  const waiting = [
    { label: 'Awaiting us', value: Number(position.awaitingPlatform ?? 0), tone: 'warn' },
    { label: 'Awaiting the customer', value: Number(position.awaitingCustomer ?? 0) },
    { label: 'Nobody has picked it up', value: Number(position.unassigned ?? 0), tone: 'bad' },
  ].filter((slice) => slice.value > 0);

  // The normal target, because a single gauge cannot carry three. Urgent and
  // low are named in the footnote rather than averaged into one figure.
  const target = Number(position.responseTargets?.NORMAL ?? 24);

  return html`
    <div class="grid g2" style="margin-bottom:14px">
      <div class="card">
        <h2>Is the queue moving</h2>
        ${raw(
          funnelChart({
            title: 'Requests raised, picked up, resolved',
            stages: flow,
            format: (value) => `${value} request${value === 1 ? '' : 's'}`,
            empty: position.summary ?? 'Nothing has been raised.',
            footnote:
              'The drop between two stages is the backlog. A wide gap at "picked up" is a staffing problem; a wide gap ' +
              'at "resolved" is usually one request nobody can close.',
          }),
        )}
      </div>
      <div class="card">
        <h2>Who the queue is waiting on</h2>
        ${raw(
          pieChart({
            title: 'Open requests by who holds them',
            data: waiting,
            centreLabel: String(position.open ?? 0),
            format: (value) => `${value} request${value === 1 ? '' : 's'}`,
            empty: 'Nothing is open.',
            footnote:
              `${position.overdue ?? 0} past target. ` +
              'A request awaiting the customer is not a request that has stalled — it is counted apart for exactly ' +
              'that reason.',
          }),
        )}
      </div>
    </div>

    <div class="grid g2" style="margin-bottom:14px">
      <div class="card">
        <h2>How quickly a first answer arrives</h2>
        ${raw(
          gauge({
            title: 'Median first response',
            value: position.medianFirstResponseHours === null || position.medianFirstResponseHours === undefined
              ? undefined
              : Number(position.medianFirstResponseHours),
            max: Math.max(target * 2, Number(position.medianFirstResponseHours ?? 0) * 1.2, 1),
            target,
            format: (value) => `${Math.round(value)}h`,
            desc:
              position.medianFirstResponseHours === null || position.medianFirstResponseHours === undefined
                ? 'Nothing has been answered yet, so there is no median. Not zero hours.'
                : `Target ${target}h for a normal request · urgent ${position.responseTargets?.URGENT ?? '—'}h · low ${position.responseTargets?.LOW ?? '—'}h`,
          }),
        )}
      </div>
      <div class="card">
        <h2>What people are asking about</h2>
        ${raw(
          barChart({
            title: 'Requests by category',
            horizontal: true,
            data: byCategory,
            format: (value) => `${value} request${value === 1 ? '' : 's'}`,
            empty: 'Nothing has been raised in any category.',
            footnote:
              'A category is chosen by whoever raised the request. A rise in "the platform did something incorrect" is a ' +
              'defect signal; a rise in "how do I do this" is a documentation one.',
          }),
        )}
      </div>
    </div>
  `;
}
