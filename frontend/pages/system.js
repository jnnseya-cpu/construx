import { api } from '../lib/api.js';
import { envGroups, head, refusal } from '../lib/estate.js';
import { badge, html, humanise, raw, render, table, time, toast } from '../lib/ui.js';

/**
 * System control.
 *
 * What this deployment actually has configured, what it still owes, and the two
 * things an operator may safely make happen now rather than on a timer.
 *
 * The readiness report is read **from this running process**, not from a
 * checklist. That distinction is the whole value of it: somebody who sets a
 * variable on the server and still sees "not set" here has learned something
 * true — the spelling is wrong, the file was not loaded, or the container was
 * not recreated. A checklist would have said yes.
 *
 * Secret values are never shown. Their length is, because a key truncated by a
 * bad paste looks correct from every other angle and its length does not.
 */

export async function system(root) {
  const [ready, outbox, egress, repairs] = await Promise.all([
    api.get('/v1/admin/readiness').catch((error) => ({ error })),
    api.get('/v1/admin/outbox').catch((error) => ({ error })),
    api.get('/v1/admin/telemetry/egress').catch((error) => ({ error })),
    api.get('/v1/admin/repair').catch((error) => ({ error })),
  ]);

  if (ready.error) {
    render(root, html`${head({ title: 'System control' })}${refusal('The readiness report', ready.error)}`);
    return;
  }

  render(
    root,
    html`
      ${head({
        title: 'System control',
        intent:
          'Read from this running process rather than from a checklist. Every rail is set with environment variables ' +
          'on the server, never from this screen — and this screen reports whether a value is set, never what it is.',
      })}

      <section class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h2>Capabilities configured</h2>
          <div class="metric ${raw(ready.blocking.length > 0 ? 'bad' : ready.degraded > 0 ? 'warn' : 'good')}">
            ${ready.configured} / ${ready.capabilities.length}
          </div>
          <div class="metric-sub">
            ${ready.blocking.length > 0
              ? `${ready.blocking.length} blocking go-live`
              : ready.degraded > 0
                ? `${ready.degraded} half-configured`
                : 'production-ready'}
          </div>
        </div>
        <div class="card">
          <h2>Notifications owed</h2>
          <div class="metric ${raw(!outbox.error && outbox.abandoned > 0 ? 'bad' : '')}">${outbox.error ? '—' : outbox.queued}</div>
          <div class="metric-sub">
            ${outbox.error ? 'the outbox could not be read' : `${outbox.sent} delivered · ${outbox.abandoned} out of attempts`}
          </div>
        </div>
        <div class="card">
          <h2>Telemetry</h2>
          <div class="metric ${raw(!egress.error && egress.enabled ? 'good' : 'info')}">${
            egress.error ? '—' : egress.enabled ? 'shipping' : 'local only'
          }</div>
          <div class="metric-sub">
            ${egress.error
              ? 'egress could not be read'
              : egress.enabled
                ? `${egress.queued ?? 0} queued · ${egress.dropped ?? 0} dropped`
                : 'no collector is configured, so metrics stay in this process'}
          </div>
        </div>
        <div class="card">
          <h2>Auto-repairs</h2>
          <div class="metric ${raw(!repairs.error && (repairs.repeating ?? []).length > 0 ? 'warn' : '')}">${
            repairs.error ? '—' : (repairs.repairs ?? []).length
          }</div>
          <div class="metric-sub">
            ${repairs.error ? 'the repair position could not be read' : 'restart a stopped drain, flush a stalled queue — and nothing else'}
          </div>
        </div>
      </section>

      ${ready.blocking.length > 0
        ? html`<div class="notice bad" style="margin-bottom:14px">
            <div>
              <b>Not fit to hold a paying customer yet.</b><br />
              ${ready.blocking.join(' · ')} — each of these is a capability the platform cannot do without.
            </div>
          </div>`
        : ''}

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">What this deployment has configured</h2>
        <div class="metric-sub" style="padding:0 17px 10px">
          ${ready.configured} of ${ready.capabilities.length} capabilities. A capability marked <b>half-configured</b> is
          worse than one that is off: it looks present, and it fails at the moment somebody depends on it.
        </div>
        ${table({
          headers: ['Capability', 'State', 'What that means right now', 'Set with'],
          rows: ready.capabilities.map((capability) => [
            html`${capability.label}${capability.critical ? badge('critical', 'warn') : ''}`,
            badge(
              capability.state === 'CONFIGURED' ? 'configured' : capability.state === 'DEGRADED' ? 'half-configured' : 'not set',
              capability.state === 'CONFIGURED' ? 'ok' : capability.state === 'DEGRADED' ? 'bad' : 'neutral',
            ),
            capability.detail,
            html`<span class="mono" style="font-size:10.5px;color:var(--text-3)">${capability.env.join(' · ')}</span>`,
          ]),
        })}
        <div style="padding:12px 17px 15px">
          ${ready.warnings.length > 0
            ? html`<div class="metric-sub" style="margin-bottom:8px">
                  <b>Boot warnings</b> — what this process said about itself when it started
                </div>
                <div class="split-list">
                  ${ready.warnings.map((warning) => html`<div class="row"><span class="lbl">${warning}</span></div>`)}
                </div>`
            : html`<div class="metric-sub">This process raised no configuration warning at boot.</div>`}
        </div>
      </div>

      ${outbox.error
        ? refusal('The notification outbox', outbox.error)
        : html`<div class="card" id="outbox" style="margin-bottom:14px">
            <h2>Notifications the platform owes</h2>
            <div class="metric-sub" style="margin:8px 0 14px">
              Every notice is written down before it is transmitted, so nothing is lost between deciding to tell
              somebody and telling them. Queued clears on the next drain. <b>Out of attempts does not</b> — each one is
              somebody who was entitled to a notice and did not get it, and nothing will try again.
            </div>
            <div class="split-list">
              <div class="row"><span class="lbl">Delivered</span><span class="val">${outbox.sent}</span></div>
              <div class="row">
                <span class="lbl">Queued</span>
                <span class="val">${outbox.queued}${outbox.due > 0 ? ` · ${outbox.due} due now` : ''}</span>
              </div>
              <div class="row">
                <span class="lbl">Out of attempts</span>
                <span class="val">${badge(String(outbox.abandoned), outbox.abandoned > 0 ? 'bad' : 'ok')}</span>
              </div>
              ${outbox.oldestQueuedAt
                ? html`<div class="row"><span class="lbl">Oldest still owed</span><span class="val">${time(outbox.oldestQueuedAt)}</span></div>`
                : ''}
            </div>
            ${outbox.abandonedEntries.length > 0
              ? html`<div style="margin-top:14px">
                  ${table({
                    headers: ['Notice', 'Tenancy', 'Attempts', 'Queued', 'Last error'],
                    align: ['', 'mono', 'num', '', ''],
                    rows: outbox.abandonedEntries.map((entry) => [
                      entry.code,
                      String(entry.tenantId).slice(-8),
                      entry.attempts,
                      time(entry.queuedAt),
                      entry.lastError ?? '—',
                    ]),
                  })}
                </div>`
              : ''}
            <div class="actions" style="margin-top:14px">
              <button class="btn quiet sm" id="drain-outbox">Deliver what is owed now</button>
            </div>
          </div>`}

      ${repairs.error
        ? ''
        : html`<div class="card pad0" style="margin-bottom:14px">
            <h2 style="padding:15px 17px 0">Auto-repair</h2>
            <div class="metric-sub" style="padding:0 17px 10px">
              Two silent failures are worth fixing without asking, and both have a blast radius identical to normal
              operation: <b>a timer that stopped</b> and <b>a queue that is owed and idle</b>. A stopped drain produces
              no error — the outbox fills, nothing sends, and the first symptom is a customer saying they never received
              something. <b>A repair that keeps firing is reported as a finding rather than a fix:</b> once is a blip,
              five times means something is re-breaking and the thing meant to paper over a blip is hiding a defect.
            </div>
            ${table({
              headers: ['Repair', 'Times run', 'Last run', 'State'],
              align: ['', 'num', '', ''],
              rows: (repairs.repairs ?? []).map((entry) => [
                html`<b>${entry.label ?? entry.id}</b>${entry.detail ? html`<div class="metric-sub">${entry.detail}</div>` : ''}`,
                entry.count ?? 0,
                entry.lastAt ? time(entry.lastAt) : '—',
                (entry.count ?? 0) >= 5 ? badge('re-breaking', 'bad') : badge('quiet', 'ok'),
              ]),
              empty: 'Nothing has needed repairing on this process.',
            })}
            <div style="padding:0 17px 15px">
              <div class="metric-sub" style="margin-bottom:8px"><b>What it refuses to do</b>, published rather than assumed:</div>
              <div class="split-list">
                ${(repairs.refuses ?? []).map((entry) => html`<div class="row"><span class="lbl">${entry}</span></div>`)}
              </div>
              <div class="actions" style="margin-top:12px">
                <button class="btn quiet sm" id="run-repair">Run a repair pass now</button>
              </div>
            </div>
          </div>`}

      ${egress.error
        ? ''
        : html`<div class="card" style="margin-bottom:14px">
            <h2>Telemetry egress</h2>
            <div class="metric-sub" style="margin:8px 0 14px">
              Whether metrics are reaching a collector, what is queued, and what has been dropped. The endpoint is
              reported and the collector's token never is — a screen that showed the header would put a credential on an
              operator's display and in whatever captured it.
            </div>
            <div class="split-list">
              <div class="row"><span class="lbl">Enabled</span><span class="val">${badge(egress.enabled ? 'yes' : 'no', egress.enabled ? 'ok' : 'neutral')}</span></div>
              <div class="row"><span class="lbl">Endpoint</span><span class="val mono" style="font-size:11px">${egress.endpoint ?? '—'}</span></div>
              <div class="row"><span class="lbl">Queued</span><span class="val">${egress.queued ?? 0}</span></div>
              <div class="row"><span class="lbl">Shipped</span><span class="val">${egress.shipped ?? 0}</span></div>
              <div class="row"><span class="lbl">Dropped</span><span class="val">${badge(String(egress.dropped ?? 0), (egress.dropped ?? 0) > 0 ? 'warn' : 'ok')}</span></div>
              ${egress.lastError ? html`<div class="row"><span class="lbl">Last error</span><span class="val">${egress.lastError}</span></div>` : ''}
            </div>
            <div class="actions" style="margin-top:14px">
              <button class="btn quiet sm" id="flush-telemetry">Ship what is queued now</button>
            </div>
          </div>`}

      <div class="card">
        <details>
          <summary>Runtime environment — what this process actually received
            <span class="metric-sub">${ready.variables.filter((v) => v.present).length} of ${ready.variables.length} variables set</span>
          </summary>
          <div class="details-body">
            <div class="metric-sub" style="margin-bottom:12px">
              Every variable this build reads, registered by the readers themselves so the list cannot go stale.
              <b>"not set" means this running server received no value under that exact name</b> — if you set it on the
              server and it still reads not set, check the spelling, that it is in the file the process loaded, and that
              the container was recreated afterwards. Secret values are never shown; their length is, because a key
              truncated by a paste looks correct from every other angle and its length does not.
            </div>
            ${envGroups(ready.variables).map(
              (group) => html`<div style="margin-bottom:14px">
                <div class="metric-sub" style="margin-bottom:6px"><b>${group.label}</b></div>
                ${table({
                  headers: ['Variable', 'State', 'Value'],
                  rows: group.vars.map((v) => [
                    html`<span class="mono" style="font-size:11px">${v.key}</span>`,
                    v.present ? badge('set', 'ok') : badge('not set', 'neutral'),
                    v.present
                      ? v.secret
                        ? html`<span class="metric-sub">hidden · ${v.length} character${v.length === 1 ? '' : 's'}</span>`
                        : html`<span class="mono" style="font-size:11px">${v.value}</span>`
                      : html`<span class="metric-sub">—</span>`,
                  ]),
                })}
              </div>`,
            )}
          </div>
        </details>
      </div>
    `,
  );

  const press = async (id, label, working, run) => {
    document.getElementById(id)?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = working;
      try {
        await run();
        await system(root);
      } catch (error) {
        toast('That did not work', error.message, 'err');
        button.disabled = false;
        button.textContent = label;
      }
    });
  };

  await press('drain-outbox', 'Deliver what is owed now', 'Delivering…', async () => {
    const report = await api.post('/v1/admin/outbox/drain', {});
    toast(
      'Outbox drained',
      `${report.sent} sent, ${report.retrying} still owed, ${report.abandoned} out of attempts`,
      report.abandoned > 0 ? 'warn' : 'ok',
    );
  });

  await press('run-repair', 'Run a repair pass now', 'Repairing…', async () => {
    const report = await api.post('/v1/admin/repair', {});
    toast('Repair pass complete', `${(report.actions ?? []).length} action${(report.actions ?? []).length === 1 ? '' : 's'} taken`, 'ok');
  });

  await press('flush-telemetry', 'Ship what is queued now', 'Shipping…', async () => {
    const report = await api.post('/v1/admin/telemetry/flush', {});
    toast('Telemetry flushed', `${report.shipped ?? 0} shipped`, 'ok');
  });
}
