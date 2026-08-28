import { api } from '../lib/api.js';
import { head, refusal } from '../lib/estate.js';
import { badge, html, humanise, raw, render, table } from '../lib/ui.js';

/**
 * Settings.
 *
 * There is nothing to change here, and that is the design rather than an
 * omission. **Every setting on this platform is an environment variable on the
 * server**, and a console that could edit them would be a console that could
 * turn off authentication, change the AI markup or point the payment rail
 * somewhere else — from a browser session, with no deployment and no review. The
 * settings screen therefore publishes what the platform *enforces* rather than
 * offering to change it, and System Control reports what is configured.
 *
 * What is published here is the machinery a customer never sees and an operator
 * is asked about constantly: the permission matrix the server actually
 * evaluates, every route on the gateway, the commercial rules, and the closed
 * vocabularies. All of it read from the platform, so none of it can drift from
 * what is enforced.
 */

export async function settings(root) {
  const [matrix, routes, catalogue, ready] = await Promise.all([
    api.get('/v1/permissions/matrix').catch((error) => ({ error })),
    api.get('/v1/routes').catch(() => ({ routes: [] })),
    api.get('/v1/billing/catalogue').catch(() => null),
    api.get('/v1/admin/readiness').catch(() => null),
  ]);

  if (matrix.error) {
    render(root, html`${head({ title: 'Settings' })}${refusal('The permission matrix', matrix.error)}`);
    return;
  }

  const areas = new Set();
  for (const entry of Object.values(matrix.matrix)) {
    for (const area of Object.keys(entry)) areas.add(area);
  }
  const orderedAreas = [...areas].sort();
  const orderedRoles = Object.keys(matrix.matrix);
  const publicRoutes = (routes.routes ?? []).filter((route) => route.public);

  render(
    root,
    html`
      ${head({
        title: 'Settings',
        intent:
          'What the platform enforces, read from the platform itself. Nothing here is editable: every setting is an ' +
          'environment variable on the server, and a console that could change them could turn off authentication from ' +
          'a browser session.',
      })}

      <section class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h2>Roles</h2>
          <div class="metric">${orderedRoles.length}</div>
          <div class="metric-sub">across ${orderedAreas.length} capability areas</div>
        </div>
        <div class="card">
          <h2>Routes</h2>
          <div class="metric orange">${(routes.routes ?? []).length}</div>
          <div class="metric-sub">explicit, with no backend discovery</div>
        </div>
        <div class="card">
          <h2>Public routes</h2>
          <div class="metric ${raw(publicRoutes.length > 0 ? 'warn' : '')}">${publicRoutes.length}</div>
          <div class="metric-sub">reachable with no session at all</div>
        </div>
        <div class="card">
          <h2>Environment</h2>
          <div class="metric">${ready ? `${ready.variables.filter((v) => v.present).length} / ${ready.variables.length}` : '—'}</div>
          <div class="metric-sub">variables set · change them on the server, never here</div>
        </div>
      </section>

      <div class="notice info" style="margin-bottom:14px">
        <div>
          <b>Why nothing on this screen is editable.</b><br />
          A settings page that could write to configuration is a page that can disable authentication, move the AI
          markup, or repoint a payment rail — from a browser, with no deployment and no review. Configuration is set
          with environment variables on the server and read once at boot. <b>System Control</b> reports what this process
          actually received, which is the useful half: it tells you whether the value you set is the value that arrived.
        </div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <h2>Permission matrix — what the platform actually enforces</h2>
        <div class="metric-sub" style="margin:8px 0 14px">
          ${orderedRoles.length} roles × ${orderedAreas.length} capability areas, published by the server rather than
          restated in the browser — so navigation, enforcement and this table cannot drift apart. The console fetches
          this; it holds no rule of its own.
        </div>
        <div class="table-scroll">
          <table>
            <thead>
              <tr><th>Capability area</th>${orderedRoles.map((role) => html`<th style="text-align:center">${role}</th>`)}</tr>
            </thead>
            <tbody>
              ${orderedAreas.map(
                (area) => html`<tr>
                  <td style="white-space:nowrap">${humanise(area)}</td>
                  ${orderedRoles.map((role) => {
                    const codes = matrix.matrix[role]?.[area] ?? [];
                    return html`<td style="text-align:center;font-family:var(--mono);font-size:10.5px;color:${raw(
                      codes.length === 0 ? 'var(--text-3)' : codes.includes('A') || codes.includes('G') ? 'var(--orange)' : 'var(--text-2)',
                    )}">${codes.length === 0 ? '—' : codes.join('')}</td>`;
                  })}
                </tr>`,
              )}
            </tbody>
          </table>
        </div>
        <div class="metric-sub" style="margin-top:12px">
          R read · C create · U update · A approve, freeze or execute · I import or export · X run AI · G governance.
          <b>An absent entry is no access at all</b> — the matrix is an allow-list, not a deny-list, so a capability area
          added tomorrow is unreachable by every role until somebody deliberately grants it.
        </div>
      </div>

      ${catalogue
        ? html`<div class="card" style="margin-bottom:14px">
            <h2>Commercial rules</h2>
            <div class="metric-sub" style="margin:8px 0 14px">
              Published by the platform, not hard-coded in this screen. Seats, packages and bundles come from one place
              in the source, which is also the place the billing arithmetic reads.
            </div>
            ${table({
              headers: ['Package', 'Seats included', 'Monthly', 'Dedicated tenancy'],
              align: ['', 'num', 'num', ''],
              rows: (catalogue.packages ?? []).map((entry) => [
                entry.label ?? entry.id,
                entry.includedIdentities ?? '∞',
                entry.monthlyPriceMinor !== undefined ? `£${(entry.monthlyPriceMinor / 100).toFixed(2)}` : '—',
                entry.isolatedTenancy ? badge('yes', 'ai') : badge('shared', 'info'),
              ]),
              empty: 'No package is published.',
            })}
          </div>`
        : ''}

      <div class="card">
        <details>
          <summary>API surface
            <span class="metric-sub">${(routes.routes ?? []).length} explicit routes · ${publicRoutes.length} public</span>
          </summary>
          <div class="details-body">
            <div class="metric-sub" style="margin-bottom:12px">
              Every route the gateway serves. There is no backend discovery and no dynamic mounting: a route exists
              because somebody wrote it into the table, which is why this list can be a complete answer rather than a
              best guess. A route marked <b>public</b> is reachable with no session at all — that set is deliberately
              small and worth reading in full.
            </div>
            ${table({
              headers: ['Method', 'Path', 'Description', 'Auth'],
              rows: (routes.routes ?? []).map((route) => [
                badge(route.method, route.method === 'GET' ? 'info' : 'ai'),
                html`<span class="mono" style="font-size:11px">${route.path}</span>`,
                route.description,
                route.public ? badge('public', 'warn') : badge('protected', 'ok'),
              ]),
            })}
          </div>
        </details>
      </div>
    `,
  );
}
