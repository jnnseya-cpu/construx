import { api } from '../lib/api.js';
import { head, refusal } from '../lib/estate.js';
import { badge, html, humanise, raw, render, table, time } from '../lib/ui.js';

/**
 * Audit logs.
 *
 * Three records, and they are genuinely different things rather than three views
 * of one:
 *
 * **The governance record** is every act an operator is accountable for — a
 * tenancy opened, an identity created, a seat assigned, a subscription
 * suspended, a payment received. Append-only and hash-chained, and the chain is
 * **verified by walking it on this request** rather than asserted. Nothing here
 * is edited or deleted: a correction is a new event, and the chain hash makes a
 * deletion or reordering detectable rather than merely forbidden.
 *
 * **The security stream** is who tried and was refused.
 *
 * **Gateway activity** is every request, which is neither of the above and is
 * the one people reach for when something is behaving strangely.
 *
 * Delivery work is written to its own project and is not reachable from here.
 * That boundary is the shape of the record, not a filter on this page.
 */

export async function auditlogs(root) {
  const [governance, security, logs] = await Promise.all([
    api.get('/v1/admin/audit').catch((error) => ({ error })),
    api.get('/v1/admin/security').catch((error) => ({ error })),
    api.get('/v1/admin/logs').catch((error) => ({ error })),
  ]);

  if (governance.error) {
    render(root, html`${head({ title: 'Audit logs' })}${refusal('The governance record', governance.error)}`);
    return;
  }

  const brokenChains = (governance.chains ?? []).filter((chain) => chain.failures > 0);
  // Verified, with a recorded state hash the patch does not reproduce. The
  // chain vouches for the event; the writer's arithmetic is what disagreed.
  // Named beside the chain, never folded into "intact" and never called a
  // break — both would be a lie in a different direction.
  const discrepantChains = (governance.chains ?? []).filter((chain) => (chain.discrepancies ?? 0) > 0);

  render(
    root,
    html`
      ${head({
        title: 'Audit logs',
        intent:
          'Every act an operator is accountable for, every refusal at the gateway, and every request. Append-only: a ' +
          'correction is a new event, never an edit.',
      })}

      <section class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h2>Governance acts</h2>
          <div class="metric">${governance.total}</div>
          <div class="metric-sub">across ${governance.chains.length} chain${governance.chains.length === 1 ? '' : 's'}</div>
        </div>
        <div class="card">
          <h2>Chain</h2>
          <div class="metric ${raw(governance.intact ? 'good' : 'bad')}">${governance.intact ? 'intact' : 'BROKEN'}</div>
          <div class="metric-sub">
            ${governance.intact
              ? discrepantChains.length > 0
                ? 'verified by walking every chain on this request; recorded-hash discrepancies noted below'
                : 'verified by walking every chain on this request'
              : 'a chain failed verification'}
          </div>
        </div>
        <div class="card">
          <h2>Refusals</h2>
          <div class="metric ${raw(!security.error && security.summary.repeatSources.length > 0 ? 'warn' : '')}">${
            security.error ? '—' : security.summary.total
          }</div>
          <div class="metric-sub">recorded at the gateway</div>
        </div>
        <div class="card">
          <h2>Requests</h2>
          <div class="metric">${logs.error ? '—' : (logs.metrics?.totalRequests ?? 0).toLocaleString('en-GB')}</div>
          <div class="metric-sub">${logs.error ? 'the log could not be read' : `p95 ${logs.metrics?.p95DurationMs ?? '—'}ms at the gateway`}</div>
        </div>
      </section>

      ${discrepantChains.length > 0
        ? html`<div class="notice warn" style="margin-bottom:14px">
            <div>
              <b>Recorded state hashes that the events' own patches do not reproduce.</b><br />
              ${discrepantChains.map((chain) => `${chain.tenant}: ${chain.discrepancies} event${chain.discrepancies === 1 ? '' : 's'}`).join(' · ')}.
              Each of these events verifies against the chain — it is the event as written — but the process that
              wrote it hashed a copy of the record that had moved on from the ledger's own. Nothing was altered,
              deleted or reordered; the arithmetic was the writer's. The cause is fixed; the record is kept as it was
              written, and replay names these events every time rather than rewriting them.
            </div>
          </div>`
        : ''}

      ${!governance.intact
        ? html`<div class="notice bad" style="margin-bottom:14px">
            <div>
              <b>A governance chain failed verification.</b><br />
              ${brokenChains.map((chain) => `${chain.tenant}: ${chain.failures} event${chain.failures === 1 ? '' : 's'}`).join(' · ')}.
              An event has been altered, deleted or reordered. Treat the affected record as unreliable until it is
              investigated.
            </div>
          </div>`
        : ''}

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">
          Governance record ${governance.intact ? badge('chain intact', 'ok') : badge('CHAIN BROKEN', 'bad')}
        </h2>
        <div class="metric-sub" style="padding:0 17px 10px">
          A tenancy opened, an identity created, a seat assigned, a subscription suspended, a payment received, a wallet
          credited. Restricted by an explicit list of event codes rather than by which project they sit on — the first
          version of this filtered by project and handed an operator a customer's portfolios, programmes and bid
          pipeline, because the governance chain is where <i>everything</i> tenant-scoped goes. A code not on the list
          is out of reach by default, which is the right direction for the failure to fall.
        </div>
        ${table({
          headers: ['When', 'Act', 'Tenant', 'On', 'By', 'Chain'],
          rows: (governance.events ?? []).slice(0, 60).map((event) => [
            time(event.timestamp),
            humanise(event.eventType),
            event.tenant,
            humanise(event.entity.refType),
            event.actor?.refType === 'System' ? badge('system', 'info') : (event.actor?.refId ?? '—'),
            html`<span class="mono" style="font-size:10.5px;color:var(--text-3)">${
              event.chainHash ? `${event.chainHash.slice(0, 12)}…` : '—'
            }</span>`,
          ]),
          empty: 'No governance act has been recorded yet.',
        })}
        <div style="padding:12px 17px 15px">
          <div class="metric-sub">
            Append-only. Nothing here is edited or deleted — a correction is a new event, and the chain hash makes a
            deletion or a reordering detectable rather than merely forbidden.
          </div>
        </div>
      </div>

      ${
        // Who is shut out right now, above the history of who was refused
        // when. It is the question an operator is actually asked — somebody
        // rings up unable to sign in — and reading it backwards out of a
        // scrolling stream means hoping nothing expired in between.
        //
        // Shown only when somebody is locked. A permanent panel reading zero
        // is furniture; this appearing means something is happening.
        security.error || (security.lockedIdentities ?? []).length === 0
          ? ''
          : html`<div class="card" style="margin-bottom:14px">
              <h2>Identities locked right now</h2>
              <div class="metric-sub" style="margin-bottom:10px">
                Repeated failed verifications against one account. The lock is counted against the identity rather than
                the address it came from, because a run spread over a thousand addresses is a thousand unremarkable
                rate-limit keys and one account being attacked. Each lifts by itself, and the account holder has been
                emailed.
              </div>
              ${table({
                headers: ['Identity', 'Failed attempts', 'Unlocks in'],
                align: ['', 'num', 'num'],
                rows: security.lockedIdentities.map((entry) => [
                  html`<span class="mono" style="font-size:10.5px">${entry.actorId}</span>`,
                  entry.failures,
                  `${Math.ceil(entry.unlocksInSeconds / 60)} min`,
                ]),
                empty: 'Nobody is locked out.',
              })}
            </div>`
      }

      ${security.error
        ? refusal('The security stream', security.error)
        : html`<div class="card pad0" style="margin-bottom:14px">
            <h2 style="padding:15px 17px 0">Security stream</h2>
            <div class="metric-sub" style="padding:0 17px 10px">
              Authentication failures, authorisation denials, rate limits and every administrative endpoint reached —
              whether the call succeeded or not, because who <i>tried</i> matters as much as who managed to.
            </div>
            ${table({
              headers: ['When', 'Kind', 'Reason', 'Path', 'Source', 'Status'],
              rows: (security.events ?? [])
                .slice(-40)
                .reverse()
                .map((event) => [
                  time(event.timestamp),
                  badge(humanise(event.kind), event.kind === 'AUTH_FAILURE' || event.kind === 'RATE_LIMITED' ? 'bad' : event.kind === 'ADMIN_ACCESS' ? 'info' : 'warn'),
                  humanise(event.reason),
                  html`<span class="mono" style="font-size:10.5px">${event.path ?? '—'}</span>`,
                  event.remote ?? '—',
                  event.status ?? '—',
                ]),
              empty: 'No refusal has been recorded.',
            })}
          </div>`}

      ${logs.error
        ? refusal('Gateway activity', logs.error)
        : html`<div class="grid g-2-1">
            <div class="card pad0">
              <h2 style="padding:15px 17px 0">Recent gateway activity</h2>
              <div class="metric-sub" style="padding:0 17px 10px">
                Every request this process has served, newest first. Bounded in memory — a real deployment ships these
                to a log sink, and this is the tail of what is still held here.
              </div>
              ${table({
                headers: ['When', 'Method', 'Path', 'Status', 'Duration'],
                align: ['', '', '', '', 'num'],
                rows: (logs.logs ?? [])
                  .slice(-30)
                  .reverse()
                  .map((entry) => [
                    time(entry.timestamp),
                    entry.method,
                    html`<span class="mono" style="font-size:10.5px">${entry.path}</span>`,
                    badge(String(entry.status), entry.status >= 500 ? 'bad' : entry.status >= 400 ? 'warn' : 'ok'),
                    `${entry.durationMs}ms`,
                  ]),
                empty: 'No request recorded yet.',
              })}
            </div>
            <div class="card">
              <h2>Denials by reason</h2>
              ${Object.keys(logs.metrics?.denialsByReason ?? {}).length === 0
                ? html`<div class="empty"><b>No denials</b>Every request so far was authorised.</div>`
                : html`<div class="split-list">
                    ${Object.entries(logs.metrics.denialsByReason).map(
                      ([reason, count]) => html`<div class="row"><span class="lbl">${humanise(reason)}</span><span class="val">${count}</span></div>`,
                    )}
                  </div>`}
              <div class="metric-sub" style="margin-top:12px">
                A denial names the policy that refused it, not just the status code. Which one is climbing tells you
                whether somebody is being blocked by a role, a scope, a lifecycle phase or the account layer — and those
                have completely different answers.
              </div>
            </div>
          </div>`}
    `,
  );
}
