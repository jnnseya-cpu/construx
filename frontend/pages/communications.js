import { api } from '../lib/api.js';
import { barChart, heatmap, pieChart } from '../lib/charts.js';
import { blockedReason, can } from '../app.js';
import { badge, html, humanise, raw, render, table, time, toast } from '../lib/ui.js';

/**
 * Communication Event Architecture.
 *
 * One engine, 177 events, fanning out across email, in-app, SMS, push and
 * WhatsApp. The screen's job is to make two things impossible to misread.
 *
 * The first is which channels actually carry anything. A channel wired into the
 * engine with no provider behind it is shown as wired-and-unconnected rather
 * than as working, because "logged" and "sent" are different facts and the day
 * somebody asks whether the payment-failure notice went out, the difference is
 * the whole answer.
 *
 * The second is that mandatory notices override preferences. They are marked
 * everywhere they appear, and the count is on the header, because a preference
 * centre that quietly ignores a switch is worse than one that says so.
 */

const CHANNEL_LABEL = {
  EMAIL: 'email',
  INAPP: 'in-app',
  SMS: 'sms',
  PUSH: 'push',
  WHATSAPP: 'whatsapp',
};

const SEVERITY_TONE = { INFO: 'info', SUCCESS: 'ok', WARNING: 'warn', CRITICAL: 'bad' };
const STATUS_TONE = { SENT: 'ok', RECORDED: 'info', FAILED: 'bad', SUPPRESSED: 'warn' };

/** "sent" and "logged" are different claims; the label says which. */
const STATUS_LABEL = { SENT: 'sent', RECORDED: 'logged', FAILED: 'failed', SUPPRESSED: 'suppressed' };

export async function communications(root) {
  const [catalogue, feed] = await Promise.all([
    api.get('/v1/notifications/catalogue'),
    // The refusal is kept rather than flattened to an empty feed.
    //
    // The catalogue is readable by anybody — a person is entitled to know what
    // the platform may send them. The delivery log is the tenant's own
    // outbound mail, so a platform operator is refused it, correctly. Swallowing
    // that into `deliveries: []` showed an operator an empty table, which reads
    // as "this tenancy has sent nothing" when the truth is "you may not see
    // this". Those are different facts and the screen now says which one it has.
    can('ENTERPRISE_STRUCTURE', 'R')
      ? api.get('/v1/notifications/deliveries').catch((error) => ({ deliveries: [], totals: null, error }))
      : Promise.resolve({ deliveries: [], totals: null, error: { message: blockedReason('ENTERPRISE_STRUCTURE', 'R') } }),
  ]);

  const feedRefused = Boolean(feed.error);

  const wired = catalogue.channels.filter((c) => c.wired);
  const totals = feed.totals ?? { attempted: 0, sent: 0, recorded: 0, failed: 0, suppressed: 0 };
  const delivered = totals.sent + totals.recorded;

  const channelRow = (channel) => {
    const count = catalogue.coverage[channel.channel] ?? 0;
    // Only counted when the feed was actually readable. A refused feed has no
    // deliveries to count, and reporting "0 sent" from one would be the same
    // lie the tile below refuses to tell.
    const sent = feedRefused ? null : feed.deliveries.filter((d) => d.channel === channel.channel && d.status !== 'SUPPRESSED').length;
    return html`
      <div class="row">
        <span class="lbl">
          ${CHANNEL_LABEL[channel.channel] ?? channel.channel}
          ${channel.wired ? '' : html` ${badge('no provider', 'warn')}`}
        </span>
        <span class="val">${count} event${count === 1 ? '' : 's'}${sent ? ` · ${sent} sent` : ''}</span>
      </div>
    `;
  };

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Communication Event Architecture</h1>
          <p>One event engine — ${catalogue.totals.events} events fan out across email, in-app, SMS, push and WhatsApp.</p>
        </div>
      </div>

      <div class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h2>Catalogue events</h2>
          <div class="metric orange">${catalogue.totals.events}</div>
          <div class="metric-sub">${catalogue.totals.categories} categories, closed catalogue</div>
        </div>
        <div class="card">
          <h2>Mandatory notices</h2>
          <div class="metric">${catalogue.mandatory}</div>
          <div class="metric-sub">sent regardless of a recipient’s preferences</div>
        </div>
        <div class="card">
          <h2>Messages delivered</h2>
          <!-- A denial is shown as a denial, never as zero.
               This tile read "0 of 0 attempted" for a platform operator, whose
               request for the delivery log is refused because the log is the
               tenant's own outbound mail. That is not "nothing has been sent" —
               it is "you may not see this", and the two look identical as a
               zero. The refusal is now the tile. -->
          ${feedRefused
            ? html`<div class="metric" style="font-size:15px">not yours to see</div>
                <div class="metric-sub">
                  The delivery log is the tenancy's own outbound mail and a platform operator is refused it —
                  correctly. This is a refusal, not an empty log.
                </div>`
            : html`<div class="metric ${raw(totals.failed > 0 ? 'bad' : 'good')}">${delivered}</div>
                <div class="metric-sub">
                  of ${totals.attempted} attempted${totals.failed > 0 ? ` · ${totals.failed} failed` : ''}${
                    totals.suppressed > 0 ? ` · ${totals.suppressed} suppressed` : ''
                  }
                </div>`}
        </div>
        <div class="card">
          <h2>Channels wired</h2>
          <div class="metric">${wired.length}<span style="font-size:16px;opacity:.5"> / ${catalogue.channels.length}</span></div>
          <div class="metric-sub">${catalogue.channels.map((c) => CHANNEL_LABEL[c.channel]).join(' · ')}</div>
        </div>
      </div>

      ${communicationCharts(catalogue, feed, feedRefused)}

      <div class="grid g-2-1" style="margin-bottom:14px">
        <div class="card">
          <h2>Template QA</h2>
          <p class="metric-sub" style="margin-bottom:12px">
            Preview the branded email — your organisation’s mark, colour and registered detail on every outbound message — or
            fire an event to yourself across its channels. A test is only ever sent to the signed-in account.
          </p>
          <form class="input-zone" id="qa">
            <div class="field" style="flex:2 1 320px">
              <label for="qa-event">Event</label>
              <select id="qa-event" name="code">
                ${catalogue.events.map(
                  (e) => html`<option value="${e.code}">${e.title} — ${e.code}</option>`,
                )}
              </select>
            </div>
            <div class="actions">
              <button class="btn quiet" type="button" id="qa-preview">Preview email</button>
              <button class="btn" type="submit">Send test to me</button>
            </div>
          </form>
          <div id="qa-result" style="margin-top:13px"></div>
        </div>

        <div class="card">
          <h2>Channel coverage</h2>
          <p class="metric-sub" style="margin-bottom:10px">How many catalogue events fire on each channel by default.</p>
          <div class="split-list">${catalogue.channels.map(channelRow)}</div>
        </div>
      </div>

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">Recent deliveries</h2>
        ${feedRefused
          ? html`<div style="padding:0 17px 14px"><div class="notice warn">
              <div>
                <b>Not yours to read.</b><br />
                A delivery log is a tenancy's own outbound mail to its own people, and a platform operator is
                outside that tenancy. The catalogue above is the platform's; this is not. Shown as a refusal
                rather than an empty table, because an empty table here would say this tenancy had sent nothing.
              </div>
            </div></div>`
          : ''}
        <p class="metric-sub" style="padding:0 17px">Every event × channel × recipient with its delivery status.</p>
        ${table({
          headers: ['Time', 'Channel', 'Event', 'Status', 'Transport', 'Detail'],
          rows: feed.deliveries.slice(0, 40).map((d) => [
            time(d.at),
            CHANNEL_LABEL[d.channel] ?? d.channel,
            d.code,
            badge(STATUS_LABEL[d.status] ?? d.status, STATUS_TONE[d.status] ?? 'neutral'),
            d.transport,
            d.detail,
          ]),
          empty: 'Nothing has been dispatched yet. Fire a test above and it will appear here.',
        })}
      </div>

      ${catalogue.categories.map((category) => {
        const events = catalogue.events.filter((e) => e.category === category.code);
        return html`
          <div class="card pad0" style="margin-bottom:14px">
            <h2 style="padding:15px 17px 0">${category.title} <span style="opacity:.55;font-weight:500">· ${category.events} events</span></h2>
            ${table({
              headers: ['Event', 'Code', 'Subject', 'Severity', 'Channels'],
              rows: events.map((e) => [
                html`${e.title}${e.mandatory ? html` ${badge('mandatory', 'bad')}` : ''}`,
                e.code,
                e.subject,
                badge(humanise(e.severity), SEVERITY_TONE[e.severity] ?? 'neutral'),
                e.channels.map((c) => CHANNEL_LABEL[c] ?? c).join(' · '),
              ]),
            })}
          </div>
        `;
      })}
    `,
  );

  const host = () => document.getElementById('qa-result');
  const selected = () => document.getElementById('qa-event').value;

  document.getElementById('qa-preview')?.addEventListener('click', async () => {
    render(host(), html`<div class="notice info">Rendering…</div>`);
    try {
      const preview = await api.post('/v1/notifications/preview', { code: selected() });
      const frame = document.createElement('iframe');
      frame.setAttribute('title', `Preview of ${preview.subject}`);
      frame.setAttribute('sandbox', '');
      frame.style.cssText = 'width:100%;height:520px;border:1px solid var(--line);border-radius:9px;background:#fff';
      frame.srcdoc = preview.html;

      render(
        host(),
        html`<div class="metric-sub" style="margin-bottom:8px">
          <b>From</b> ${preview.from} &nbsp;·&nbsp; <b>Subject</b> ${preview.subject}
        </div>`,
      );
      host().append(frame);
    } catch (error) {
      render(host(), html`<div class="notice err">${error.message}</div>`);
    }
  });

  document.getElementById('qa')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.target.querySelector('button[type=submit]');
    button.disabled = true;
    button.textContent = 'Sending…';
    try {
      const dispatch = await api.post('/v1/notifications/test', { code: selected() });
      render(
        host(),
        html`
          <div class="notice ${raw(dispatch.deliveries.some((d) => d.status === 'FAILED') ? 'warn' : 'ok')}">
            <div>
              <b>${dispatch.subject}</b>${dispatch.mandatory ? html` ${badge('mandatory', 'bad')}` : ''}<br>
              Fanned out across ${dispatch.deliveries.length} channel${dispatch.deliveries.length === 1 ? '' : 's'}.
            </div>
          </div>
          ${table({
            headers: ['Channel', 'Status', 'Transport', 'What happened'],
            rows: dispatch.deliveries.map((d) => [
              CHANNEL_LABEL[d.channel] ?? d.channel,
              badge(STATUS_LABEL[d.status] ?? d.status, STATUS_TONE[d.status] ?? 'neutral'),
              d.transport,
              d.detail,
            ]),
          })}
        `,
      );
      toast('Test fired', `${dispatch.deliveries.length} channel(s) — see the outcome per channel`, 'ok');
    } catch (error) {
      render(host(), html`<div class="notice err">${error.message}</div>`);
      toast('Could not send', error.message, 'err');
    }
    button.disabled = false;
    button.textContent = 'Send test to me';
  });
}

/**
 * The catalogue is closed, which makes it drawable.
 *
 * A fixed set of events, each with a category, a severity and the channels it
 * fans out to. The grid of category against channel answers the question the
 * event list cannot: which parts of the platform reach a person only by email,
 * which is the failure mode when email is the rail that is down.
 *
 * **A denial is not a zero.** Where the delivery feed is refused — a platform
 * operator asking for a tenancy's own outbound mail is refused, correctly — no
 * delivery chart is drawn at all, rather than one reading nothing was sent.
 */
function communicationCharts(catalogue, feed, feedRefused) {
  const events = catalogue?.events ?? [];
  if (events.length === 0) return '';

  const categories = [...new Set(events.map((event) => String(event.category ?? 'OTHER')))];
  const channels = (catalogue.channels ?? []).map((entry) => String(entry.channel));
  const values = categories.map((category) =>
    channels.map((channel) => events.filter((event) => String(event.category) === category && (event.channels ?? []).includes(channel)).length),
  );

  const severityTone = { CRITICAL: 'bad', WARNING: 'warn', INFO: undefined };
  const bySeverity = [...new Set(events.map((event) => String(event.severity ?? 'INFO')))]
    .map((severity) => ({
      label: humanise(severity),
      value: events.filter((event) => String(event.severity ?? 'INFO') === severity).length,
      tone: severityTone[severity],
    }))
    .filter((slice) => slice.value > 0);

  const byCategory = categories
    .map((category) => ({
      label: humanise(category),
      mandatory: events.filter((event) => String(event.category) === category && event.mandatory).length,
      optional: events.filter((event) => String(event.category) === category && !event.mandatory).length,
    }))
    .sort((a, b) => b.mandatory + b.optional - (a.mandatory + a.optional));

  const deliveries = feedRefused
    ? []
    : Object.entries(
        (feed?.deliveries ?? []).reduce((counts, delivery) => {
          const key = humanise(String(delivery.status ?? delivery.state ?? 'Unknown'));
          counts[key] = (counts[key] ?? 0) + 1;
          return counts;
        }, {}),
      ).map(([label, value]) => ({ label, value, tone: /fail/i.test(label) ? 'bad' : /suppress/i.test(label) ? 'warn' : 'ok' }));

  return html`
    <div class="card" style="margin-bottom:14px">
      <h2>Which parts of the platform can only reach a person one way</h2>
      ${raw(
        heatmap({
          title: 'Events by category and channel',
          rows: categories.map((category) => humanise(category)),
          columns: channels.map((channel) => CHANNEL_LABEL[channel] ?? humanise(channel)),
          values,
          format: (value) => `${value} event${value === 1 ? '' : 's'}`,
          empty: 'The catalogue publishes no channels.',
          footnote:
            'A row with one dark column is a category that reaches people by exactly one rail. When that rail is the one ' +
            'that is down, nobody in that category is told anything and the outbox looks healthy.',
        }),
      )}
    </div>

    <div class="grid g2" style="margin-bottom:14px">
      <div class="card">
        <h2>What the catalogue is made of</h2>
        ${raw(
          barChart({
            title: 'Events by category',
            horizontal: true,
            stacked: true,
            data: byCategory,
            series: [
              { key: 'mandatory', label: 'Mandatory', colour: 'warn' },
              { key: 'optional', label: 'Preference applies' },
            ],
            format: (value) => `${value} event${value === 1 ? '' : 's'}`,
            empty: 'The catalogue is empty.',
            footnote:
              'A mandatory notice is sent regardless of a recipient’s preferences, because it is a notice the platform ' +
              'owes rather than one it offers.',
          }),
        )}
      </div>
      <div class="card">
        <h2>${feedRefused ? 'How urgent the catalogue is' : 'What happened to what was sent'}</h2>
        ${raw(
          feedRefused
            ? pieChart({
                title: 'Events by severity',
                data: bySeverity,
                centreLabel: String(events.length),
                format: (value) => `${value} event${value === 1 ? '' : 's'}`,
                empty: 'The catalogue is empty.',
                footnote:
                  'The delivery log is the tenancy’s own outbound mail and a platform operator is refused it. That is ' +
                  'a refusal, not an empty log, so no delivery chart is drawn here at all.',
              })
            : pieChart({
                title: 'Deliveries by outcome',
                data: deliveries,
                centreLabel: String((feed?.deliveries ?? []).length),
                format: (value) => `${value} message${value === 1 ? '' : 's'}`,
                empty: 'Nothing has been sent from this tenancy yet.',
                footnote:
                  'A suppressed message was not attempted, because the recipient’s preference or a bounce record said ' +
                  'not to. It is neither a success nor a failure and is counted as neither.',
              }),
        )}
      </div>
    </div>
  `;
}
