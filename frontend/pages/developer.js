import { api } from '../lib/api.js';
import { badge, html, raw, render, table, time } from '../lib/ui.js';
import { command, commandBar } from '../lib/command.js';
import { can, blockedReason, draw } from '../app.js';

/**
 * The developer surface.
 *
 * Two credentials live here and both are shown exactly once. The screen says so
 * at the moment of issue, where somebody is looking, and puts the value in a
 * panel that stays rather than a toast that fades — a secret that cannot be
 * recovered is the wrong thing to put behind an animation.
 *
 * Sandbox and live are presented as what they are — two different tenancies —
 * rather than as a toggle on one. A toggle invites the belief that a sandbox
 * call might touch live data; a separate tenancy is the reason it cannot.
 */

/** Held so the issue commands can offer only scopes this person actually has. */
let grantable = [];

const COMMANDS = {
  key: () => ({
    title: 'Issue an API key',
    intent:
      'For an integration rather than a person. It can never be wider than you, and the secret is shown once.',
    path: '/v1/developer/keys',
    submitLabel: 'Issue key',
    fields: [
      {
        name: 'name',
        label: 'What this key is for',
        hint: 'Named so somebody can decide later whether it is still needed. "key 4" is not a name.',
      },
      {
        name: 'mode',
        label: 'Mode',
        type: 'select',
        options: [
          { value: 'SANDBOX', label: 'Sandbox — a separate tenancy, safe to break' },
          { value: 'LIVE', label: 'Live — this tenancy’s real record' },
        ],
      },
      {
        name: 'scopes',
        label: 'Scopes',
        type: 'multiselect',
        options: grantable.map((scope) => ({ value: scope, label: scope })),
        hint: 'Only what you hold yourself. Anything wider is refused by name rather than quietly dropped.',
      },
      {
        name: 'expiresInDays',
        label: 'Expires in (days)',
        type: 'number',
        required: false,
        hint: 'Up to 366. The credential nobody remembers issuing is the one still working in three years.',
      },
    ],
  }),
  webhook: () => ({
    title: 'Subscribe an endpoint',
    intent: 'https only, and never an address inside the deployment. The signing secret is shown once.',
    path: '/v1/developer/webhooks',
    submitLabel: 'Subscribe',
    fields: [
      { name: 'name', label: 'Integration name' },
      {
        name: 'url',
        label: 'Endpoint',
        hint: 'https://… — an internal address is refused, or this feature becomes a way of making the platform fetch its own internals on request.',
      },
    ],
  }),
};

/** A secret, in a panel that stays. Never a toast: this cannot be recovered. */
function reveal(root, label, secret, notice) {
  const panel = document.createElement('div');
  panel.className = 'notice warn';
  panel.innerHTML = `<div><b>${label} — copy it now.</b><br>
    <code style="user-select:all;word-break:break-all">${secret}</code><br>
    <span class="small">${notice ?? ''}</span></div>`;
  root.querySelector('.view-head')?.after(panel);
}

export async function developer(root) {
  const [keys, hooks] = await Promise.all([
    api.get('/v1/developer/keys').catch(() => ({ keys: [], grantableScopes: [] })),
    api.get('/v1/developer/webhooks').catch(() => ({ subscriptions: [], position: null })),
  ]);

  grantable = keys.grantableScopes ?? [];
  const live = (keys.keys ?? []).filter((key) => key.live);
  const position = hooks.position ?? { subscriptions: 0, active: 0, queued: 0, delivered: 0, abandoned: 0, failing: [] };
  const mayGovern = can('ENTERPRISE_STRUCTURE', 'G');

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Developer</h1>
          <p>
            Keys for integrations that are not people, and endpoints to be told what happened.
            A key is never wider than the person who issued it, and a sandbox key acts on a separate
            tenancy rather than on live data behind a flag.
          </p>
        </div>
        <div class="actions cmd-bar">
          ${raw(
            commandBar([
              { id: 'key', label: 'Issue an API key', permitted: mayGovern, reason: blockedReason('ENTERPRISE_STRUCTURE', 'G') },
              { id: 'webhook', label: 'Subscribe an endpoint', permitted: mayGovern, reason: blockedReason('ENTERPRISE_STRUCTURE', 'G') },
            ]),
          )}
        </div>
      </div>

      <section class="grid g4">
        <div class="metric"><span>Keys live</span><strong>${live.length}</strong></div>
        <div class="metric"><span>Endpoints active</span><strong>${position.active}</strong></div>
        <div class="metric"><span>Deliveries owed</span><strong>${position.queued}</strong></div>
        <div class="metric"><span>Abandoned</span><strong>${position.abandoned}</strong></div>
      </section>

      ${position.abandoned > 0
        ? html`<div class="notice warn">
            <div>
              <b>${position.abandoned} deliveries were abandoned.</b><br />
              That is data an integrator never received. Shown rather than hidden, because a screen carrying
              only successes lets somebody believe an integration is complete when it has gaps.
            </div>
          </div>`
        : ''}

      ${(position.failing ?? []).length > 0
        ? html`<div class="notice warn">
            <div>
              <b>${position.failing.length} endpoint${position.failing.length === 1 ? '' : 's'} failing.</b><br />
              ${raw(
                position.failing
                  .map(
                    (entry) =>
                      `${entry.name}: ${entry.consecutiveFailures} consecutive — ${entry.lastFailureReason ?? 'no reason recorded'}`,
                  )
                  .join('<br>'),
              )}
            </div>
          </div>`
        : ''}

      <section class="card">
        <h3>API keys</h3>
        ${raw(
          table({
            columns: ['Name', 'Mode', 'Prefix', 'Scopes', 'Expires', 'State'],
            rows: (keys.keys ?? []).map((key) => [
              key.name,
              badge(key.mode === 'LIVE' ? 'live' : 'sandbox', key.mode === 'LIVE' ? 'warn' : 'info'),
              `<code>${key.prefix}</code>`,
              (key.scopes ?? []).join(', '),
              time(key.expiresAt),
              key.revokedAt
                ? badge('withdrawn', 'muted')
                : key.live
                  ? badge('live', 'good')
                  : badge('expired', 'muted'),
            ]),
            empty: 'No keys have been issued. An integration needs one; a person does not.',
          }),
        )}
      </section>

      <section class="card">
        <h3>Webhook endpoints</h3>
        <p class="metric-sub">
          Every delivery carries <code>x-construx-signature: t=&lt;seconds&gt;,v1=&lt;hex&gt;</code> — HMAC-SHA256 over
          <code>"&lt;t&gt;.&lt;body&gt;"</code> with the endpoint's own secret. Reject a timestamp more than 300
          seconds old: without that check a captured delivery verifies for ever. Deliveries are at-least-once and
          carry a stable <code>x-construx-delivery-id</code>, so you can make them exactly-once on your side.
        </p>
        ${raw(
          table({
            columns: ['Name', 'URL', 'Events', 'Failures', 'State'],
            rows: (hooks.subscriptions ?? []).map((entry) => [
              entry.name,
              `<code>${entry.url}</code>`,
              (entry.eventTypes ?? []).length === 0 ? 'every event' : entry.eventTypes.join(', '),
              String(entry.consecutiveFailures ?? 0),
              entry.active ? badge('active', 'good') : badge('disabled', 'muted'),
            ]),
            empty: 'No endpoints. Without one, an integration has to poll.',
          }),
        )}
      </section>
    `,
  );

  root.querySelector('.cmd-bar')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    const spec = COMMANDS[button.dataset.command]?.();
    if (!spec) return;

    const result = await command(spec);
    if (!result) return;

    if (result.secret) {
      reveal(root, button.dataset.command === 'key' ? 'API key secret' : 'Signing secret', result.secret, result.notice);
      // Deliberately not redrawn. A redraw would replace the panel holding the
      // one copy of a secret that cannot be recovered, which is the worst
      // possible moment to refresh a screen.
      return;
    }
    await draw();
  });
}
