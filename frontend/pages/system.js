import { api } from '../lib/api.js';
import { barChart, funnelChart, gauge, pieChart } from '../lib/charts.js';
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

      ${systemCharts(ready, outbox, egress, repairs)}

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

      <div class="card" style="margin-bottom:14px">
        <h2>The address customers are sent to</h2>
        <div class="metric-sub" style="margin:8px 0 14px">
          Every invitation, password reset and notification this platform emails carries a link built on
          <span class="mono">PUBLIC_BASE_URL</span>, and so does every webhook endpoint quoted to a payment provider. The
          readiness map above says whether that value is <i>set</i>. It cannot say whether the host resolves, whether the
          certificate covers that exact name, or whether it reaches <i>this</i> deployment rather than a previous one — and a
          link that fails on any of those reaches a customer before it reaches you. This opens it and reports what came back.
        </div>
        <div class="split-list">
          <div class="row"><span class="lbl">Configured address</span><span class="val mono" style="font-size:11px">${ready.publicAddress?.baseUrl ?? (ready.variables?.find((v) => v.name === 'PUBLIC_BASE_URL')?.present ? 'set' : badge('not set', 'bad'))}</span></div>
          ${
            ready.publicAddress?.addresses?.length
              ? html`<div class="row"><span class="lbl">Resolves to</span><span class="val mono" style="font-size:11px">${ready.publicAddress.addresses.join(', ')}</span></div>`
              : ''
          }
        </div>
        <div id="reach-result">
          ${
            // What boot found, rather than an empty card until somebody presses
            // the button. The check runs once at start-up precisely so nobody
            // has to know this screen exists to learn the links are dead.
            ready.publicAddress
              ? html`<div class="notice ${raw(ready.publicAddress.ok ? 'ok' : 'bad')}" style="margin-top:12px">
                  <div>
                    <b>${ready.publicAddress.baseUrl}</b> — ${ready.publicAddress.because}
                    ${ready.publicAddress.remedy ? html`<br /><b>Next:</b> ${ready.publicAddress.remedy}` : ''}
                    ${ready.publicAddress.answeredBy && ready.publicAddress.answeredBy !== ready.publicAddress.thisBuild
                      ? html`<br />It answered as build <span class="mono">${ready.publicAddress.answeredBy}</span>; this process is
                          <span class="mono">${ready.publicAddress.thisBuild}</span>.`
                      : ''}
                    <br /><span class="metric-sub">Checked ${time(ready.publicAddress.checkedAt)}. DNS, a proxy and a certificate
                      all change without a restart, so press below for the position now.</span>
                  </div>
                </div>`
              : ''
          }
        </div>
        <div class="actions" style="margin-top:14px">
          <button class="btn quiet sm" id="check-reach">Open the public address now</button>
        </div>
      </div>

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

  // Not through `press`: that re-renders the whole screen on success, which
  // would throw away the answer the operator pressed the button to read. The
  // result is written into the card and left there.
  document.getElementById('check-reach')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Opening…';
    const target = document.getElementById('reach-result');
    try {
      const reach = await api.post('/v1/admin/reachability', {});
      render(
        target,
        html`<div class="notice ${raw(reach.ok ? 'ok' : 'bad')}" style="margin-top:12px">
          <div>
            <b>${reach.baseUrl}</b> — ${reach.because}
            ${reach.remedy ? html`<br /><b>Next:</b> ${reach.remedy}` : ''}
            ${reach.answeredBy && reach.answeredBy !== reach.thisBuild
              ? html`<br />It answered as build <span class="mono">${reach.answeredBy}</span>; this process is
                  <span class="mono">${reach.thisBuild}</span>.`
              : ''}
            ${(reach.addresses ?? []).length
              ? html`<br /><span class="metric-sub">Resolves to ${reach.addresses.join(', ')}.</span>`
              : ''}
          </div>
        </div>`,
      );
      toast(reach.ok ? 'The public address reaches this deployment' : 'The public address does not work', reach.because, reach.ok ? 'ok' : 'err');
    } catch (error) {
      toast('Could not check', error.message, 'err');
    }
    button.disabled = false;
    button.textContent = 'Open the public address now';
  });

  await press('flush-telemetry', 'Ship what is queued now', 'Shipping…', async () => {
    const report = await api.post('/v1/admin/telemetry/flush', {});
    toast('Telemetry flushed', `${report.shipped ?? 0} shipped`, 'ok');
  });
}

/**
 * Readiness as a shape, not a fraction.
 *
 * "4 of 12 configured" is one number covering two different situations: eight
 * capabilities nobody has set, and eight that are set to a development default
 * and will start and then fail. `DEGRADED` is the dangerous state — it boots.
 * The tile cannot separate them and the chart can.
 *
 * The outbox funnel is the other half of the same question. Queued, due, sent
 * and abandoned are four numbers on the tile above and one sequence in fact: a
 * notification that was owed, became due, and either left or ran out of
 * attempts. What matters is the drop at the end, and a drop is what a funnel is.
 */
function systemCharts(ready, outbox, egress, repairs) {
  const states = new Map();
  for (const capability of ready?.capabilities ?? []) {
    const state = String(capability.state ?? 'NOT_SET');
    states.set(state, (states.get(state) ?? 0) + 1);
  }
  const tone = { CONFIGURED: 'ok', DEGRADED: 'warn', NOT_SET: 'bad' };
  const byState = [...states.entries()]
    .map(([state, count]) => ({ label: humanise(state), value: count, tone: tone[state] }))
    .filter((slice) => slice.value > 0);

  // Critical capabilities apart from the rest. A non-critical rail that is not
  // set is a feature nobody has switched on; a critical one is a deployment
  // that should not take a customer.
  const criticality = [
    {
      label: 'Cannot do without',
      configured: (ready?.capabilities ?? []).filter((capability) => capability.critical && capability.state === 'CONFIGURED').length,
      degraded: (ready?.capabilities ?? []).filter((capability) => capability.critical && capability.state === 'DEGRADED').length,
      missing: (ready?.capabilities ?? []).filter((capability) => capability.critical && capability.state === 'NOT_SET').length,
    },
    {
      label: 'Optional',
      configured: (ready?.capabilities ?? []).filter((capability) => !capability.critical && capability.state === 'CONFIGURED').length,
      degraded: (ready?.capabilities ?? []).filter((capability) => !capability.critical && capability.state === 'DEGRADED').length,
      missing: (ready?.capabilities ?? []).filter((capability) => !capability.critical && capability.state === 'NOT_SET').length,
    },
  ].filter((row) => row.configured + row.degraded + row.missing > 0);

  const post = outbox?.error
    ? []
    : [
        { label: 'Owed', value: Number(outbox.queued ?? 0) + Number(outbox.sent ?? 0) + Number(outbox.abandoned ?? 0) },
        { label: 'Left the building', value: Number(outbox.sent ?? 0) },
      ].filter((stage) => stage.value > 0);

  const total = (ready?.capabilities ?? []).length;

  return html`
    <div class="grid g2" style="margin-bottom:14px">
      <div class="card">
        <h2>Which rails are set, and which only look set</h2>
        ${raw(
          barChart({
            title: 'Capabilities by importance and state',
            horizontal: true,
            stacked: true,
            data: criticality,
            series: [
              { key: 'configured', label: 'Configured' },
              { key: 'degraded', label: 'Development default', colour: 'warn' },
              { key: 'missing', label: 'Not set', colour: 'bad' },
            ],
            format: (value) => `${value} capabilit${value === 1 ? 'y' : 'ies'}`,
            empty: 'No readiness report could be read from this process.',
            footnote:
              'A development default is the dangerous state, because the process boots on it. A capability that is not ' +
              'set at all fails loudly the first time something needs it.',
          }),
        )}
      </div>
      <div class="card">
        <h2>How much of this deployment is real</h2>
        ${raw(
          gauge({
            title: 'Capabilities configured',
            value: total > 0 ? (Number(ready.configured ?? 0) / total) * 100 : undefined,
            max: 100,
            format: (value) => `${Math.round(value)}%`,
            desc:
              (ready?.blocking ?? []).length > 0
                ? `${ready.blocking.length} of these block go-live`
                : `${ready?.degraded ?? 0} half-configured · nothing blocking`,
          }),
        )}
        ${raw(
          pieChart({
            title: 'Capabilities by state',
            data: byState,
            centreLabel: String(total),
            format: (value) => `${value} capabilit${value === 1 ? 'y' : 'ies'}`,
            empty: 'No capabilities are published.',
            footnote: 'Every value is read from this running process, never from a checklist, and never shown — only whether it is set.',
          }),
        )}
      </div>
    </div>

    <div class="grid g2" style="margin-bottom:14px">
      <div class="card">
        <h2>What was owed, and what actually left</h2>
        ${raw(
          funnelChart({
            title: 'Notifications since start',
            stages: post,
            format: (value) => `${value} notification${value === 1 ? '' : 's'}`,
            empty: 'Nothing has been queued for delivery.',
            footnote:
              `${outbox?.error ? 'The outbox could not be read.' : `${outbox.queued ?? 0} still queued · ${outbox.abandoned ?? 0} out of attempts · ${outbox.due ?? 0} due now.`} ` +
              'A notification out of attempts is a person who was told nothing and does not know it.',
          }),
        )}
      </div>
      <div class="card">
        <h2>What this process has fixed by itself</h2>
        ${raw(
          barChart({
            title: 'Auto-repairs by action',
            horizontal: true,
            data: Object.entries(
              (repairs?.error ? [] : repairs?.repairs ?? []).reduce((counts, repair) => {
                const key = humanise(String(repair.action ?? repair.what ?? 'Repair'));
                counts[key] = (counts[key] ?? 0) + 1;
                return counts;
              }, {}),
            ).map(([label, value]) => ({ label, value, tone: (repairs?.repeating ?? []).some((entry) => humanise(String(entry.action ?? '')) === label) ? 'warn' : undefined })),
            format: (value) => `${value} time${value === 1 ? '' : 's'}`,
            empty: 'Nothing has needed repairing since this process started.',
            footnote:
              'The repair set is deliberately small: restart a stopped drain, flush a stalled queue, and nothing else. ' +
              'A repair that keeps recurring is a defect the repair is hiding, which is why repeats are marked.',
          }),
        )}
      </div>
    </div>
  `;
}
