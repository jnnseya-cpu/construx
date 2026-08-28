import { api } from '../lib/api.js';
import { command } from '../lib/command.js';
import { head, refusal } from '../lib/estate.js';
import { badge, html, humanise, raw, render, table, time, toast } from '../lib/ui.js';

/**
 * The walkthrough diary.
 *
 * Somebody who wants twenty minutes and a person rather than a sandbox books
 * one from the public site, and it has to land somewhere an operator will
 * actually look. Before this the only route in was the contact address, which
 * is an email and a hope.
 *
 * Two things on this screen are worth more than the list itself.
 *
 * **Whether a confirmation can be sent at all.** A booking recorded and never
 * confirmed is somebody expecting a call that nobody knows to make. With no
 * mail server configured the record is still correct and the person has been
 * told nothing, and the screen leads with that rather than letting it be
 * discovered by a no-show.
 *
 * **What they said they wanted.** The most useful field on the form is the free
 * one, and it is the first thing somebody preparing for the call needs — not
 * the reference, not the timezone.
 */

export async function bookings(root) {
  const position = await api.get('/v1/admin/bookings').catch((error) => ({ error }));

  if (position.error) {
    render(root, html`${head({ title: 'Walkthrough bookings' })}${refusal('The booking diary', position.error)}`);
    return;
  }

  const row = (booking) => [
    html`<b>${time(booking.startsAt)}</b><div class="metric-sub">${booking.minutes} minutes · UTC</div>`,
    html`${booking.name}<div class="metric-sub">${booking.email}</div>`,
    booking.organisation,
    badge(booking.language === 'FR' ? 'French' : 'English', 'info'),
    booking.about
      ? html`<span class="metric-sub">${booking.about}</span>`
      : html`<span class="metric-sub">they did not say</span>`,
    html`<span class="mono" style="font-size:11px">${booking.reference}</span>`,
  ];

  render(
    root,
    html`
      ${head({
        title: 'Walkthrough bookings',
        intent: position.summary,
      })}

      <section class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h2>Upcoming</h2>
          <div class="metric ${raw(position.counts.upcoming > 0 ? 'good' : '')}">${position.counts.upcoming}</div>
          <div class="metric-sub">${position.counts.thisWeek} inside the next seven days</div>
        </div>
        <div class="card">
          <h2>Booked in total</h2>
          <div class="metric">${position.counts.total}</div>
          <div class="metric-sub">${position.counts.cancelled} cancelled</div>
        </div>
        <div class="card">
          <h2>Confirmations</h2>
          <div class="metric ${raw(position.canConfirm ? 'good' : 'bad')}">${position.canConfirm ? 'sending' : 'not sending'}</div>
          <div class="metric-sub">
            ${position.canConfirm
              ? 'a confirmation goes out through the outbox when somebody books'
              : 'no mail server is configured, so nobody who books is told anything'}
          </div>
        </div>
        <div class="card">
          <h2>Already passed</h2>
          <div class="metric">${position.past.length}</div>
          <div class="metric-sub">still marked booked — nobody has closed them off</div>
        </div>
      </section>

      ${!position.canConfirm
        ? html`<div class="notice bad" style="margin-bottom:14px">
            <div>
              <b>Nobody who books is being told anything.</b><br />
              The booking is recorded correctly and the confirmation cannot be sent, because no SMTP host is
              configured on this deployment. Every person in the list below is expecting a call they have had no
              acknowledgement of. Set the mail server, or contact each of them by hand until it is set.
            </div>
          </div>`
        : ''}

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">
          Coming up
          ${position.counts.upcoming > 0 ? badge(String(position.counts.upcoming), 'ok') : ''}
        </h2>
        <div class="metric-sub" style="padding:0 17px 10px">
          Times are UTC. <b>What they want out of it</b> is the column to read before the call — it is the one field
          on the form that is free text, and the one that decides whether twenty minutes is useful.
        </div>
        ${table({
          headers: ['When', 'Who', 'Organisation', 'Language', 'What they want out of it', 'Reference', ''],
          rows: position.upcoming.map((booking) => [
            ...row(booking),
            html`<button class="btn quiet sm" data-cancel="${booking.id}">Cancel</button>`,
          ]),
          empty: 'Nothing is booked. The instant demonstration accounts are the route most people take.',
        })}
      </div>

      ${position.past.length > 0
        ? html`<div class="card pad0" style="margin-bottom:14px">
            <h2 style="padding:15px 17px 0">Passed, and still open ${badge(String(position.past.length), 'warn')}</h2>
            <div class="metric-sub" style="padding:0 17px 10px">
              These times have gone by and nothing has been recorded against them. The platform does not close a
              booking on its own — whether the call happened is a fact somebody knows and it does not.
            </div>
            ${table({
              headers: ['When', 'Who', 'Organisation', 'Language', 'What they wanted', 'Reference'],
              rows: position.past.map(row),
            })}
          </div>`
        : ''}

      ${position.cancelled.length > 0
        ? html`<div class="card pad0">
            <h2 style="padding:15px 17px 0">Cancelled</h2>
            ${table({
              headers: ['When it was', 'Who', 'Cancelled', 'Why'],
              rows: position.cancelled.map((booking) => [
                time(booking.startsAt),
                html`${booking.name}<div class="metric-sub">${booking.organisation}</div>`,
                time(booking.cancelledAt),
                booking.cancelledReason ?? '—',
              ]),
            })}
          </div>`
        : ''}
    `,
  );

  for (const button of root.querySelectorAll('[data-cancel]')) {
    button.addEventListener('click', async () => {
      const bookingId = button.getAttribute('data-cancel');
      const ok = await command({
        title: 'Cancel this walkthrough',
        intent:
          'The slot goes back on offer immediately. Nothing is sent automatically — this platform integrates with no ' +
          'calendar and cancelling here does not reach their diary, so tell them.',
        path: `/v1/admin/bookings/${bookingId}/cancel`,
        submitLabel: 'Cancel it',
        fields: [
          {
            name: 'reason',
            label: 'Why',
            hint: 'Recorded against the booking. Somebody has this in their diary and is owed an explanation.',
          },
        ],
      });
      if (ok) {
        toast('Cancelled', 'The slot is back on offer. They have not been told — that is yours to do.', 'warn');
        await bookings(root);
      }
    });
  }
}
