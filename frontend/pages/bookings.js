import { api } from '../lib/api.js';
import { barChart, ganttChart, pieChart } from '../lib/charts.js';
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

      ${bookingCharts(position)}


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

/**
 * The diary, as a diary.
 *
 * Four counts and three tables. What none of them shows is the shape of the
 * week — two walkthroughs on the same afternoon and nothing for nine days is
 * invisible as a count and obvious as a timeline, and it is the only thing a
 * person running these actually needs to see before confirming another.
 */
function bookingCharts(position) {
  if (position?.error) return '';

  const upcoming = (position.upcoming ?? []).map((booking, index) => ({
    id: `booking-${index}`,
    label: booking.company ?? booking.name ?? booking.email ?? 'Walkthrough',
    start: String(booking.startsAt ?? booking.at ?? ''),
    end: String(booking.endsAt ?? booking.startsAt ?? booking.at ?? ''),
    tone: booking.confirmed ? 'ok' : 'warn',
  })).filter((task) => task.start !== '');

  const standing = [
    { label: 'Upcoming', value: Number(position.counts?.upcoming ?? 0), tone: 'ok' },
    { label: 'Held', value: Math.max(0, Number(position.counts?.total ?? 0) - Number(position.counts?.upcoming ?? 0) - Number(position.counts?.cancelled ?? 0)) },
    { label: 'Cancelled', value: Number(position.counts?.cancelled ?? 0), tone: 'bad' },
  ].filter((slice) => slice.value > 0);

  const bySource = Object.entries(
    [...(position.upcoming ?? []), ...(position.past ?? [])].reduce((counts, booking) => {
      const key = humanise(String(booking.source ?? booking.referrer ?? 'Direct'));
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {}),
  )
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);

  return html`
    <div class="grid g2" style="margin-bottom:14px">
      <div class="card">
        <h2>What the diary actually looks like</h2>
        ${raw(
          ganttChart({
            title: 'Walkthroughs ahead',
            tasks: upcoming,
            scale: 'DAY',
            showFloat: false,
            showLinks: false,
            empty: 'Nobody has booked a walkthrough. The instant demonstration accounts are the route most people take.',
            footnote:
              `${position.counts?.thisWeek ?? 0} this week. ` +
              'Two on one afternoon and nine clear days is invisible as a count and is the thing worth knowing before ' +
              'confirming another.',
          }),
        )}
      </div>
      <div class="card">
        <h2>Where the bookings stand</h2>
        ${raw(
          pieChart({
            title: 'Bookings by standing',
            data: standing,
            centreLabel: String(position.counts?.total ?? 0),
            format: (value) => `${value} booking${value === 1 ? '' : 's'}`,
            empty: 'Nothing has been booked.',
            footnote: position.canConfirm
              ? 'Confirmations are sent as they are made.'
              : 'No confirmation is reaching anybody: the booking records correctly and the email cannot be sent.',
          }),
        )}
        ${raw(
          barChart({
            title: 'Bookings by route in',
            horizontal: true,
            data: bySource,
            format: (value) => `${value} booking${value === 1 ? '' : 's'}`,
            empty: 'No booking carries a route.',
          }),
        )}
      </div>
    </div>
  `;
}
