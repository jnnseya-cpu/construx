import { api } from '../lib/api.js';
import { barChart, funnelChart, pieChart } from '../lib/charts.js';
import { badge, html, humanise, raw, render, table, time } from '../lib/ui.js';
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
  const [keys, hooks, seats] = await Promise.all([
    api.get('/v1/developer/keys').catch(() => ({ keys: [], grantableScopes: [] })),
    api.get('/v1/developer/webhooks').catch(() => ({ subscriptions: [], position: null })),
    can('BILLING_ACU', 'R') ? api.get('/v1/billing/seats').catch(() => null) : Promise.resolve(null),
  ]);

  grantable = keys.grantableScopes ?? [];
  const live = (keys.keys ?? []).filter((key) => key.live);
  const position = hooks.position ?? { subscriptions: 0, active: 0, queued: 0, delivered: 0, abandoned: 0, failing: [] };
  // The package decides whether the API is part of the deal at all. The
  // pricing page says "No API access" on the smaller packages and nothing
  // enforced it; the platform now refuses to issue a key there, and this
  // screen says so before the button is pressed rather than after.
  const apiOnPlan = seats?.package ? seats.package.apiAccess !== false : true;
  const mayGovern = can('ENTERPRISE_STRUCTURE', 'G') && apiOnPlan;
  const governReason = apiOnPlan
    ? blockedReason('ENTERPRISE_STRUCTURE', 'G')
    : `API access is not part of the ${seats.package.label} package. Move package on ACU & Billing to integrate.`;

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
              { id: 'key', label: 'Issue an API key', permitted: mayGovern, reason: governReason },
              { id: 'webhook', label: 'Subscribe an endpoint', permitted: mayGovern, reason: governReason },
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

      ${developerCharts(keys, live, position, grantable)}

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
            headers: ['Name', 'Mode', 'Prefix', 'Scopes', 'Expires', 'State'],
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
            headers: ['Name', 'URL', 'Events', 'Failures', 'State'],
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
  /*
   * Delegated from the view, not from a `.cmd-bar` wrapper.
   *
   * `commandBar()` returns bare buttons. Whether they end up inside an element
   * classed `cmd-bar` is up to whichever page called it, and several wrap them
   * in `.actions` instead — so on those screens no listener was ever bound and
   * every button drew, unlocked, carrying its `data-command`, and did nothing.
   * That is seven commands on Concept, four on Field Modules and four more
   * elsewhere, all of them invisible to the suite because the markup is right
   * and only the binding is missing.
   *
   * Binding here removes the coupling rather than adding a second class to
   * remember. It is safe on both counts: the handler returns on an id this
   * page does not own, so two dispatchers can share one view, and `#view` is
   * a fresh element on every `draw()`, so listeners cannot stack.
   */
  root.addEventListener('click', async (event) => {
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

/**
 * The integration surface, and whether it is being told anything.
 *
 * Four counts. The one that matters is the last, and it matters as a
 * proportion: two abandoned deliveries out of five is a broken endpoint, two
 * out of fifty thousand is the internet. A count cannot tell those apart and a
 * funnel can.
 *
 * The scope chart is about issuance rather than traffic. A key is never wider
 * than the person who issued it, so the shape of what has actually been granted
 * against what could be is the honest measure of how much of this tenancy an
 * integration can reach.
 */
function developerCharts(keys, live, position, grantable) {
  const issued = keys?.keys ?? [];

  const delivery = [
    { label: 'Queued or sent', value: Number(position.queued ?? 0) + Number(position.delivered ?? 0) + Number(position.abandoned ?? 0) },
    { label: 'Delivered', value: Number(position.delivered ?? 0) },
  ].filter((stage) => stage.value > 0);

  // How many live keys carry each scope, against the scopes that exist.
  const scopeUse = (grantable ?? [])
    .map((scope) => ({
      label: scope,
      value: live.filter((key) => (key.scopes ?? []).includes(scope)).length,
    }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 12);

  const reach = [
    { label: 'Read only', value: (grantable ?? []).filter((scope) => scope.endsWith(':read')).length },
    { label: 'Can write', value: (grantable ?? []).filter((scope) => scope.endsWith(':write')).length },
    { label: 'Other', value: (grantable ?? []).filter((scope) => !scope.endsWith(':read') && !scope.endsWith(':write')).length },
  ].filter((slice) => slice.value > 0);

  const standing = [
    { label: 'Live', value: live.length, tone: 'ok' },
    { label: 'Sandbox', value: issued.filter((key) => !key.live && !key.revokedAt).length },
    { label: 'Revoked', value: issued.filter((key) => key.revokedAt).length, tone: 'bad' },
  ].filter((slice) => slice.value > 0);

  return html`
    <div class="grid g2" style="margin-top:14px;margin-bottom:14px">
      <div class="card">
        <h2>Is anything actually being told</h2>
        ${raw(
          funnelChart({
            title: 'Webhook deliveries since start',
            stages: delivery,
            format: (value) => `${value} deliver${value === 1 ? 'y' : 'ies'}`,
            empty: 'No endpoint has been subscribed, so nothing has been attempted.',
            footnote:
              `${position.abandoned ?? 0} abandoned across ${position.active ?? 0} active endpoint${(position.active ?? 0) === 1 ? '' : 's'}. ` +
              'Two abandoned out of five is a broken endpoint; two out of fifty thousand is the internet. The proportion ' +
              'is the finding, never the count.',
          }),
        )}
      </div>
      <div class="card">
        <h2>${standing.length > 0 ? 'What has been issued' : 'How wide the API can be opened'}</h2>
        ${raw(
          standing.length > 0
            ? pieChart({
                title: 'Keys by standing',
                data: standing,
                centreLabel: String(issued.length),
                format: (value) => `${value} key${value === 1 ? '' : 's'}`,
                empty: 'No key has been issued.',
                footnote:
                  'A sandbox key acts on a separate tenancy rather than on live data behind a flag, which is why the two ' +
                  'are counted apart and never summed.',
              })
            : pieChart({
                title: 'Grantable scopes by what they allow',
                data: reach,
                centreLabel: String((grantable ?? []).length),
                format: (value) => `${value} scope${value === 1 ? '' : 's'}`,
                empty: 'No scope may be granted on this package.',
                footnote:
                  'What could be granted, not what has been. A key is never wider than the person who issued it, so this ' +
                  'is the ceiling rather than the exposure.',
              }),
        )}
      </div>
    </div>

    ${
      scopeUse.length > 0
        ? html`<div class="card" style="margin-bottom:14px">
            <h2>What the live keys can reach</h2>
            ${raw(
              barChart({
                title: 'Live keys carrying each scope',
                horizontal: true,
                data: scopeUse,
                format: (value) => `${value} key${value === 1 ? '' : 's'}`,
                empty: 'No live key carries a scope.',
                footnote:
                  `${(grantable ?? []).length} scopes may be granted on this package. ` +
                  'A write scope on several keys is worth checking against who issued each of them.',
              }),
            )}
          </div>`
        : ''
    }
  `;
}
