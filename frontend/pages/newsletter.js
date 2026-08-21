import { api } from '../lib/api.js';
import { badge, html, humanise, raw, render, table, time, toast } from '../lib/ui.js';
import { draw, isOperator, state } from '../app.js';

/**
 * Newsletter.
 *
 * Two readers, one screen. Everybody sees their own preference and exactly what
 * would be sent to them — the preview is the real message, rendered from the
 * same code path that composes it, because a preview that approximates the
 * email is a way of shipping a broken email confidently.
 *
 * The operator additionally sees the audience, the exclusions with their
 * reasons, and every issue's per-recipient outcome. `RECORDED` is shown as its
 * own state rather than folded into "sent": a message that was composed but
 * never transmitted has not reached anybody, and a screen that says otherwise
 * would be the only place in this platform that lies.
 */

const STATUS_TONE = { SENT: 'ok', RECORDED: 'info', FAILED: 'bad' };

const EXCLUSION_REASON = {
  UNSUBSCRIBED: 'Asked not to receive it',
  ROLE_EXCLUDED: 'Role is never marketed to',
  SUSPENDED: 'Account is suspended',
  NO_EMAIL: 'No usable email address',
  NOT_YET_OPTED_IN: 'Has not opted in yet',
};

export async function newsletter(root) {
  const operator = isOperator();

  const [me, audience, campaigns] = await Promise.all([
    api.get('/v1/me/newsletter'),
    operator ? api.get('/v1/newsletter/audience').catch(() => null) : Promise.resolve(null),
    operator ? api.get('/v1/newsletter/campaigns').catch(() => ({ campaigns: [] })) : Promise.resolve({ campaigns: [] }),
  ]);

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Newsletter</h1>
          <p>
            A weekly issue about what the platform does, sent to registered users who have not asked otherwise.
            It carries no project, commercial or safety data — only links back into the application.
          </p>
        </div>
        ${
          operator
            ? html`<div class="actions cmd-bar">
                <button class="btn" id="issue">Issue this week now</button>
              </div>`
            : ''
        }
      </div>

      ${operator && audience ? operatorSummary(audience) : ''}

      <div class="grid g2" style="margin-bottom:14px">
        <div class="card">
          <h3>Your subscription</h3>
          <div style="display:flex;align-items:center;gap:10px;margin:10px 0 12px 0">
            ${badge(me.subscribed ? 'Subscribed' : 'Not subscribed', me.subscribed ? 'ok' : 'neutral')}
            ${me.excludedByRole ? badge('Role excluded', 'warn') : ''}
          </div>
          <div class="metric-sub" style="margin-bottom:14px">
            ${
              me.decidedAt
                ? `You decided this ${time(me.decidedAt)} via ${humanise(me.source)}.`
                : 'You have not changed this, so the account default applies.'
            }
            ${
              me.excludedByRole
                ? ' Your role is on the excluded list, so nothing is sent regardless of this setting.'
                : ''
            }
          </div>
          <div class="cmd-error" hidden></div>
          <div class="actions">
            <button class="btn ${raw(me.subscribed ? 'quiet' : '')}" id="toggle" data-next="${String(!me.subscribed)}">
              ${me.subscribed ? 'Stop sending it to me' : 'Send it to me'}
            </button>
          </div>
        </div>

        <div class="card">
          <h3>Next issue — ${me.preview.week}</h3>
          <div style="font-size:14.5px;font-weight:650;margin:9px 0 4px 0">${me.preview.subject}</div>
          <div class="metric-sub" style="margin-bottom:11px">
            ${me.preview.features.length} ${me.preview.features.length === 1 ? 'item' : 'items'}, chosen for
            ${(state.session.user.roles ?? []).join(', ') || 'your account'}
          </div>
          <div class="split-list">
            ${me.preview.features.map(
              (feature) => html`<div class="row">
                <span class="lbl">${feature.title}</span>
                <span class="val mono" style="font-size:11px;opacity:.65">${feature.path}</span>
              </div>`,
            )}
          </div>
        </div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <h3>Exactly what would arrive</h3>
        <div class="metric-sub" style="margin-bottom:11px">
          Rendered by the same code that composes the message, so this is the email rather than an impression of it.
        </div>
        <iframe
          title="Newsletter preview"
          sandbox=""
          srcdoc="${me.preview.html}"
          style="width:100%;height:560px;border:1px solid var(--line);border-radius:8px;background:#f4f4f5"></iframe>
      </div>

      ${operator ? campaignHistory(campaigns.campaigns ?? []) : ''}
    `,
  );

  // --- preference -------------------------------------------------------------

  root.querySelector('#toggle')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const errorBox = root.querySelector('.cmd-error');
    const subscribed = button.dataset.next === 'true';

    button.disabled = true;
    button.textContent = 'Saving…';
    errorBox.hidden = true;

    try {
      await api.post('/v1/me/newsletter', { subscribed });
      toast('Preference saved', subscribed ? 'You will receive the weekly issue' : 'You will not receive it again', 'ok');
      await draw();
    } catch (error) {
      errorBox.textContent = `${error.code ? `${error.code} — ` : ''}${error.message}`;
      errorBox.hidden = false;
      button.disabled = false;
      button.textContent = subscribed ? 'Send it to me' : 'Stop sending it to me';
    }
  });

  // --- issuing ----------------------------------------------------------------

  root.querySelector('#issue')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Issuing…';

    try {
      const report = await api.post('/v1/newsletter/campaigns', {});
      if (report.alreadyIssued) {
        toast('Already issued', `The ${report.campaign.week} issue has already gone out. Nothing was re-sent.`, 'info');
      } else {
        toast(
          `${report.campaign.week} issued`,
          `${report.sent} sent, ${report.recorded} recorded, ${report.failed} failed`,
          report.failed > 0 ? 'warn' : 'ok',
        );
      }
      await draw();
    } catch (error) {
      toast('Could not issue', error.message, 'err');
      button.disabled = false;
      button.textContent = 'Issue this week now';
    }
  });

  // --- delivery drill-down ----------------------------------------------------

  root.querySelector('#campaigns')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-deliveries]');
    if (!button) return;

    const target = root.querySelector(`#deliveries-${button.dataset.deliveries}`);
    if (!target.hidden) {
      target.hidden = true;
      button.textContent = 'Show recipients';
      return;
    }

    button.disabled = true;
    try {
      const { deliveries } = await api.get(`/v1/newsletter/campaigns/${button.dataset.deliveries}/deliveries`);
      render(
        target,
        table({
          headers: ['Recipient', 'Outcome', 'Attempted', 'Detail'],
          rows: deliveries.map((d) => [
            d.email,
            badge(humanise(d.status), STATUS_TONE[d.status] ?? 'neutral'),
            time(d.attemptedAt),
            html`<span class="metric-sub">${d.detail}</span>`,
          ]),
          empty: 'No delivery records',
        }),
      );
      target.hidden = false;
      button.textContent = 'Hide recipients';
    } catch (error) {
      toast('Could not load recipients', error.message, 'err');
    } finally {
      button.disabled = false;
    }
  });
}

function operatorSummary(audience) {
  return html`
    <div class="grid g4" style="margin-bottom:14px">
      <div class="card">
        <h3>Next issue reaches</h3>
        <div class="metric">${audience.recipientCount}</div>
        <div class="metric-sub">${audience.excluded.length} excluded, with reasons</div>
      </div>
      <div class="card">
        <h3>Schedule</h3>
        <div class="metric" style="font-size:19px">
          ${audience.enabled ? `${dayName(audience.sendDayUtc)} ${String(audience.sendHourUtc).padStart(2, '0')}:00 UTC` : 'Disabled'}
        </div>
        <div class="metric-sub">
          ${audience.enabled ? `week ${audience.week}` : 'NEWSLETTER_ENABLED is off — nothing sends on its own'}
        </div>
      </div>
      <div class="card">
        <h3>Delivery channel</h3>
        <div class="metric" style="font-size:19px">${audience.channel === 'SMTP' ? 'SMTP' : 'Record only'}</div>
        <div class="metric-sub">
          ${audience.channel === 'SMTP' ? 'messages are transmitted' : 'no SMTP host set — issues are composed and recorded, not sent'}
        </div>
      </div>
      <div class="card">
        <h3>Default for new users</h3>
        <div class="metric" style="font-size:19px">${audience.defaultSubscribed ? 'Subscribed' : 'Opt-in first'}</div>
        <div class="metric-sub">never marketed to: ${audience.excludedRoles.join(', ') || 'no roles'}</div>
      </div>
    </div>

    ${
      audience.channel === 'RECORD_ONLY'
        ? html`<div class="notice warn" style="margin-bottom:14px">
            <div>
              <b>Nothing is being transmitted.</b><br>
              No SMTP host is configured, so an issue is composed, addressed and recorded against each recipient —
              but it does not leave the platform. Set <span class="mono">SMTP_HOST</span> to deliver.
            </div>
          </div>`
        : ''
    }

    <div class="grid g2" style="margin-bottom:14px">
      <div class="card pad0">
        <h3 style="padding:15px 17px 0">Who receives it</h3>
        ${table({
          headers: ['Role', 'Recipients'],
          rows: Object.entries(audience.byRole)
            .sort((a, b) => b[1] - a[1])
            .map(([role, count]) => [role, String(count)]),
          empty: 'Nobody is currently in the audience',
        })}
      </div>
      <div class="card pad0">
        <h3 style="padding:15px 17px 0">Who does not, and why</h3>
        ${table({
          headers: ['Person', 'Reason'],
          rows: audience.excluded.map((entry) => [
            entry.name,
            html`<span class="metric-sub">${EXCLUSION_REASON[entry.reason] ?? humanise(entry.reason)}</span>`,
          ]),
          empty: 'Nobody is excluded',
        })}
      </div>
    </div>
  `;
}

function campaignHistory(campaigns) {
  return html`<div class="card pad0" id="campaigns">
    <h3 style="padding:15px 17px 0">Issues sent</h3>
    ${table({
      headers: ['Week', 'Subject', 'Sent', 'Recorded', 'Failed', 'Issued', ''],
      rows: campaigns.map((campaign) => [
        campaign.week,
        campaign.subject,
        String(campaign.sent),
        String(campaign.recorded),
        campaign.failed > 0 ? badge(String(campaign.failed), 'bad') : '0',
        time(campaign.issuedAt),
        html`<button class="btn quiet" data-deliveries="${campaign.id}">Show recipients</button>`,
      ]),
      empty: 'No issue has gone out yet',
    })}
    ${campaigns.map((campaign) => html`<div id="deliveries-${campaign.id}" hidden style="padding:0 4px 4px"></div>`)}
  </div>`;
}

function dayName(day) {
  return ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][day] ?? `Day ${day}`;
}
