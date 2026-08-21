import { api } from '../lib/api.js';
import { badge, date, html, humanise, money, pct, raw, render, table } from '../lib/ui.js';
import { state } from '../app.js';

/**
 * Platform administration.
 *
 * Deliberately narrow. A platform operator manages tenancy, billing and system
 * health — and cannot see projects, packages or daily logs. That separation is
 * enforced in ABAC, so this page shows what an operator can act on and states
 * plainly what they cannot.
 */

export async function admin(root) {
  const roles = state.session.user.roles ?? [];
  const isOperator = roles.includes('PLATFORM_ADMIN');

  const [routes, plane, matrix, logs, estate, burn] = await Promise.all([
    api.get('/v1/routes').catch(() => ({ routes: [] })),
    api.get('/v1/ai/control-plane').catch(() => null),
    api.get('/v1/permissions/matrix').catch(() => ({ matrix: {} })),
    isOperator ? api.get('/v1/admin/logs').catch(() => null) : Promise.resolve(null),
    isOperator ? api.get('/v1/admin/tenants').catch(() => null) : Promise.resolve(null),
    isOperator ? api.get('/v1/admin/burn').catch(() => null) : Promise.resolve(null),
  ]);

  const areas = new Set();
  for (const entry of Object.values(matrix.matrix)) {
    for (const area of Object.keys(entry)) areas.add(area);
  }
  const orderedAreas = [...areas].sort();
  const orderedRoles = Object.keys(matrix.matrix);

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Platform</h1>
          <p>${isOperator ? 'Operator surface: tenancy, billing and system health.' : 'You are signed in as a customer account, so operator controls are not available to you.'}</p>
        </div>
      </div>

      ${
        !isOperator
          ? html`<div class="notice info">
              <div><b>Account-layer separation.</b><br>
              Platform operators manage tenants, billing and global configuration and cannot see project delivery data.
              Customer accounts cannot see platform administration. The read below is what your role is permitted.</div>
            </div>`
          : ''
      }

      <div class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h3>API surface</h3>
          <div class="metric orange">${routes.routes.length}</div>
          <div class="metric-sub">explicit routes, no backend discovery</div>
        </div>
        <div class="card">
          <h3>Roles enforced</h3>
          <div class="metric">${orderedRoles.length}</div>
          <div class="metric-sub">across ${orderedAreas.length} capability areas</div>
        </div>
        <div class="card">
          <h3>AI mode</h3>
          <div class="metric ${raw(plane?.mode === 'local' ? 'info' : 'good')}">${plane?.mode ?? '—'}</div>
          <div class="metric-sub">${plane ? `${plane.reasoning.provider} + ${plane.perception.provider}` : ''}</div>
        </div>
        <div class="card">
          <h3>Requests observed</h3>
          <div class="metric">${logs?.metrics?.totalRequests ?? '—'}</div>
          <div class="metric-sub">${logs?.metrics ? `p95 ${logs.metrics.p95DurationMs}ms` : 'operator access required'}</div>
        </div>
      </div>

      ${
        burn
          ? html`<div class="card pad0" style="margin-bottom:14px">
              <h3 style="padding:15px 17px 0">AI spend across the estate — last ${burn.windowDays} days</h3>
              <div class="grid g4" style="padding:12px 17px 0">
                <div>
                  <div class="metric-sub">Billed</div>
                  <div class="metric">${money(burn.billedMinor)}</div>
                  <div class="metric-sub">${money(burn.dailyBurnMinor)} per day</div>
                </div>
                <div>
                  <div class="metric-sub">Provider cost</div>
                  <div class="metric">${money(burn.rawCostMinor)}</div>
                  <div class="metric-sub">margin ${money(burn.marginMinor)}</div>
                </div>
                <div>
                  <div class="metric-sub">Realised multiplier</div>
                  <div class="metric ${raw(burn.realisedMultiplier === null ? '' : burn.realisedMultiplier < 3 ? 'warn' : 'good')}">
                    ${burn.realisedMultiplier === null ? '—' : `${burn.realisedMultiplier}x`}
                  </div>
                  <div class="metric-sub">
                    ${
                      burn.realisedMultiplier === null
                        ? 'Nothing spent in the window'
                        : burn.absorbedMinor > 0
                          ? html`${money(burn.absorbedMinor)} absorbed — executions that overran their estimate`
                          : 'what was charged, not what is configured'
                    }
                  </div>
                </div>
                <div>
                  <div class="metric-sub">Concentration</div>
                  <div class="metric ${raw(burn.concentration !== null && burn.concentration > 0.6 ? 'warn' : '')}">
                    ${burn.concentration === null ? '—' : pct(burn.concentration * 100, 0)}
                  </div>
                  <div class="metric-sub">from the largest single tenant</div>
                </div>
              </div>
              ${table({
                headers: ['Tenant', 'Billed', 'Provider cost', 'Realised', 'Absorbed', 'Per day', 'Available', 'Runway'],
                align: ['', 'num', 'num', 'num', 'num', 'num', 'num', 'num'],
                rows: burn.tenants.map((t) => [
                  t.legalName,
                  money(t.billedMinor),
                  money(t.rawCostMinor),
                  t.realisedMultiplier === null ? '—' : `${t.realisedMultiplier}x`,
                  t.absorbedMinor > 0 ? money(t.absorbedMinor) : '—',
                  money(t.dailyBurnMinor),
                  money(t.availableMinor),
                  // Null is not a long runway. A tenant that is not spending has
                  // no runway to report, and a large number would read as the
                  // healthiest account on the estate.
                  t.runwayDays === null
                    ? html`<span class="metric-sub">not spending</span>`
                    : t.runwayDays <= burn.windowDays
                      ? badge(`${t.runwayDays}d`, t.runwayDays <= 7 ? 'bad' : 'warn')
                      : `${t.runwayDays}d`,
                ]),
                empty: 'No tenancy has spent in this window',
              })}
              <div style="padding:0 17px 15px"><div class="metric-sub">
                ${
                  burn.runningOut.length > 0
                    ? html`<b>${burn.runningOut.length} tenanc${burn.runningOut.length === 1 ? 'y' : 'ies'} lose AI service inside the window</b>
                        at the current rate: ${burn.runningOut.map((t) => `${t.legalName} (${t.runwayDays}d)`).join(', ')}.`
                    : 'No tenancy runs out of credit inside the window at its current rate.'
                }
                Absorbed margin is an estimation-quality signal, not a leak: a charge is capped at the amount held, so
                a customer is never billed above what was reserved and disclosed, and an execution that overruns its
                estimate costs the platform the difference.
                Spend and margin only — an ACU entry names a module and a feature, both billing facts, and never the
                content of the work that produced the charge.
              </div></div>
            </div>`
          : ''
      }

      ${
        estate
          ? html`<div class="card pad0" style="margin-bottom:14px">
              <h3 style="padding:15px 17px 0">Tenant estate — tenancy, seats and prepaid credit</h3>
              ${table({
                headers: ['Tenant', 'Jurisdiction', 'Tier', 'Status', 'Seats', 'Isolation', 'ACU available', 'Renews'],
                align: ['', '', '', '', 'num', '', 'num', ''],
                rows: (estate.tenants ?? []).map((t) => [
                  t.legalName,
                  t.jurisdiction,
                  badge(t.tier, t.tier === 'ENTERPRISE' || t.tier === 'SOVEREIGN' ? 'ai' : 'info'),
                  badge(t.status, t.status === 'ACTIVE' ? 'ok' : 'warn'),
                  `${t.seatsUsed} / ${t.seatsIncluded ?? '∞'}`,
                  t.isolatedTenancy ? badge('dedicated', 'ok') : badge('shared', 'info'),
                  money(t.wallet.availableMinor),
                  date(t.renewsAt),
                ]),
              })}
              <div style="padding:12px 17px 15px"><div class="metric-sub">
                Commercial terms and credit only. An operator cannot open a project, a package or a daily log from here —
                the account layer is enforced in ABAC, not in this page's markup.
              </div></div>
            </div>`
          : ''
      }

      ${
        logs
          ? html`<div class="grid g2" style="margin-bottom:14px">
              <div class="card pad0">
                <h3 style="padding:15px 17px 0">Recent gateway activity</h3>
                ${table({
                  headers: ['Method', 'Path', 'Status', 'Duration'],
                  align: ['', '', '', 'num'],
                  rows: (logs.logs ?? [])
                    .slice(-14)
                    .reverse()
                    .map((l) => [
                      l.method,
                      l.path,
                      badge(String(l.status), l.status >= 500 ? 'bad' : l.status >= 400 ? 'warn' : 'ok'),
                      `${l.durationMs}ms`,
                    ]),
                })}
              </div>
              <div class="card">
                <h3>Denials by reason</h3>
                ${
                  Object.keys(logs.metrics?.denialsByReason ?? {}).length === 0
                    ? html`<div class="empty"><b>No denials</b>Every request so far was authorised.</div>`
                    : html`<div class="split-list">
                        ${Object.entries(logs.metrics.denialsByReason).map(
                          ([reason, count]) => html`<div class="row"><span class="lbl">${humanise(reason)}</span><span class="val">${count}</span></div>`,
                        )}
                      </div>`
                }
              </div>
            </div>`
          : ''
      }

      <div class="card pad0" style="margin-bottom:14px">
        <h3 style="padding:15px 17px 0">Permission matrix — what the platform actually enforces</h3>
        <div class="table-scroll"><table>
          <thead><tr><th>Capability area</th>${orderedRoles.map((r) => html`<th style="text-align:center">${r}</th>`)}</tr></thead>
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
        </table></div>
        <div style="padding:12px 17px 15px"><div class="metric-sub">
          R read · C create · U update · A approve/freeze/execute · I import/export · X run AI · G governance.
          An absent entry is no access at all — the matrix is allow-list, not deny-list.
        </div></div>
      </div>

      <div class="card pad0">
        <h3 style="padding:15px 17px 0">API surface</h3>
        ${table({
          headers: ['Method', 'Path', 'Description', 'Auth'],
          rows: routes.routes.map((r) => [
            badge(r.method, r.method === 'GET' ? 'info' : 'ai'),
            r.path,
            r.description,
            r.public ? badge('public', 'warn') : badge('protected', 'ok'),
          ]),
        })}
      </div>
    `,
  );
}
