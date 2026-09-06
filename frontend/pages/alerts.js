import { api } from '../lib/api.js';
import { command } from '../lib/command.js';
import { head, refusal } from '../lib/estate.js';
import { badge, html, humanise, raw, render, table, time, toast } from '../lib/ui.js';

/**
 * Risk and alerts.
 *
 * What the platform has noticed about itself, and what it has proved about its
 * own record. Three sources, deliberately on one screen because they answer one
 * question — *is anything wrong right now* — and were previously in three
 * different places.
 *
 * **The watch** evaluates rules on a timer. The first evaluation after a restart
 * judges no rate, because there is nothing to difference against yet, and that
 * is stated rather than shown as "all clear".
 *
 * **Chain assurance** verifies the Golden Thread continuously on a rotating
 * slice. The date each chain was last proved matters as much as the verdict:
 * "verified continuously" means nothing without knowing how long a full circuit
 * takes. It **detects and never repairs** — a divergence in an append-only hash
 * chain cannot be repaired, and a process that "fixed" one would be
 * indistinguishable from the tampering it exists to catch.
 *
 * **The security stream** is the gateway's own record of refusals: who tried
 * what and was told no.
 */

/**
 * The on-call doors. The rota is the whole rota each time — order, rotation,
 * start — so the record is a statement rather than a diff; the override hands
 * the pager to one person until a date for a reason that stays on the chain.
 */
const ONCALL_COMMANDS = {
  rota: (position) => ({
    title: 'Set the on-call rota',
    intent:
      'Who the platform’s own alerts reach first, in handover order. Time decides the handover, not a person: period n since the start goes to operator n. The others are copied on every alert.',
    path: '/v1/admin/oncall',
    submitLabel: 'Set the rota',
    fields: [
      {
        name: 'operatorIds',
        label: 'Operators, in handover order',
        type: 'multiselect',
        options: (position.operators ?? []).map((operator) => ({ value: operator.operatorId, label: `${operator.name} — ${operator.email}` })),
        hint: 'Handover follows the order the operators are listed in.',
      },
      { name: 'rotationDays', label: 'Days each person holds the pager', type: 'number', value: position.rota?.rotationDays ?? 7, step: '1' },
      { name: 'startsAt', label: 'Period one starts', type: 'datetime-local', required: false, hint: 'Left empty, now.' },
    ],
  }),
  override: (position) => ({
    title: 'Hand the pager to one person',
    intent: 'A swap or a holiday. The override lapses on its own at the date given; the rotation resumes with whoever it names then.',
    path: '/v1/admin/oncall/override',
    submitLabel: 'Hand over',
    fields: [
      {
        name: 'operatorId',
        label: 'Who takes the pager',
        type: 'select',
        options: (position.rota?.members ?? []).map((member) => ({ value: member.operatorId, label: `${member.name} — ${member.email}` })),
      },
      { name: 'until', label: 'Until', type: 'datetime-local', required: false, hint: 'Left empty, one rotation from now.' },
      { name: 'reason', label: 'Why', type: 'text' },
    ],
  }),
  clear: () => ({
    title: 'Clear the override',
    intent: 'The rotation resumes with whoever it names now.',
    path: '/v1/admin/oncall/override',
    submitLabel: 'Clear',
    fields: [{ name: 'reason', label: 'Why', type: 'text' }],
  }),
};

export async function alerts(root) {
  const [watch, assurance, security, oncall] = await Promise.all([
    api.get('/v1/admin/watch').catch((error) => ({ error })),
    api.get('/v1/admin/assurance').catch((error) => ({ error })),
    api.get('/v1/admin/security').catch((error) => ({ error })),
    api.get('/v1/admin/oncall').catch((error) => ({ error })),
  ]);

  const firing = watch.error ? [] : (watch.alerts ?? []).filter((alert) => alert.firing);
  const critical = firing.filter((alert) => alert.severity === 'CRITICAL');
  const diverged = assurance.error ? [] : (assurance.diverged ?? []);
  const proved = assurance.error ? [] : (assurance.projects ?? []).filter((project) => project.lastVerifiedAt);

  render(
    root,
    html`
      ${head({
        title: 'Risk & alerts',
        intent:
          'What the platform has noticed about itself and what it has proved about its own record. A rule fires on ' +
          'evidence; nothing here is a guess.',
      })}

      <section class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h2>Critical</h2>
          <div class="metric ${raw(critical.length > 0 ? 'bad' : '')}">${watch.error ? '—' : critical.length}</div>
          <div class="metric-sub">${watch.error ? 'the watch could not be read' : `of ${firing.length} rule${firing.length === 1 ? '' : 's'} firing`}</div>
        </div>
        <div class="card">
          <h2>Chains diverged</h2>
          <div class="metric ${raw(diverged.length > 0 ? 'bad' : '')}">${assurance.error ? '—' : diverged.length}</div>
          <div class="metric-sub">${assurance.error ? 'assurance could not be read' : 'a non-zero here is a platform emergency'}</div>
        </div>
        <div class="card">
          <h2>Chains proved</h2>
          <div class="metric">${assurance.error ? '—' : `${proved.length} / ${(assurance.projects ?? []).length}`}</div>
          <div class="metric-sub">
            ${assurance.error
              ? '—'
              : `${assurance.passesForFullSweep} pass${assurance.passesForFullSweep === 1 ? '' : 'es'} for a full circuit`}
          </div>
        </div>
        <div class="card">
          <h2>Refusals at the gateway</h2>
          <div class="metric ${raw(!security.error && security.summary.repeatSources.length > 0 ? 'warn' : '')}">${
            security.error ? '—' : security.summary.total
          }</div>
          <div class="metric-sub">auth failures, denials, rate limits and admin access</div>
        </div>
      </section>

      ${diverged.length > 0
        ? html`<div class="notice bad" style="margin-bottom:14px">
            <div>
              <b>A chain no longer verifies.</b><br />
              ${diverged.map((project) => project.projectId).join(' · ')}. An event has been altered, deleted or
              reordered. Treat the affected record as unreliable until it is investigated — and note that this cannot
              be repaired: that is what an append-only hash chain is for, and anything that claimed to fix it would be
              indistinguishable from the tampering it exists to catch.
            </div>
          </div>`
        : ''}

      ${oncall.error
        ? refusal('On call', oncall.error)
        : html`<div class="card" style="margin-bottom:14px" data-oncall>
            <h2>
              On call
              ${oncall.now.person ? badge(oncall.now.byOverride ? 'by override' : 'by rotation', oncall.now.byOverride ? 'warn' : 'ok') : badge('nobody named', 'bad')}
            </h2>
            <div class="metric-sub" style="margin-bottom:10px">
              ${oncall.now.person
                ? html`<b>${oncall.now.person.name}</b> (${oncall.now.person.email}) holds the pager until ${String(oncall.now.until).slice(0, 16).replace('T', ' ')} UTC${
                    oncall.now.next ? html`, then ${oncall.now.next.name}` : ''
                  }. Every alert names them in its subject and its webhook line and reaches them first; the other operators are copied.`
                : 'No rota is set. Every alert goes to every operator and names nobody, which is how an alert becomes furniture: each person assumes one of the others has it.'}
              ${!watch.error && watch.heartbeat
                ? html`<br />External monitor: ${
                    watch.heartbeat.configured
                      ? html`heartbeat every ${watch.heartbeat.intervalSeconds}s, ${watch.heartbeat.beats} sent since start${
                          watch.heartbeat.lastError ? html`, last attempt failed: ${watch.heartbeat.lastError}` : ''
                        }${watch.heartbeat.withheld > 0 ? html`, ${watch.heartbeat.withheld} withheld while the platform was not live` : ''}.`
                      : html`<b>none</b>. A dead process alerts nobody; set <code>OPS_HEARTBEAT_URL</code> and point the monitor’s HTTP check at <code>/readyz</code>.`
                  }`
                : ''}
            </div>
            ${oncall.rota
              ? table({
                  headers: ['From', 'Until', 'Holds the pager'],
                  rows: (oncall.schedule ?? []).map((slot) => [
                    String(slot.from).slice(0, 16).replace('T', ' '),
                    String(slot.until).slice(0, 16).replace('T', ' '),
                    html`${slot.person.name} <span class="metric-sub">${slot.person.email}</span>`,
                  ]),
                  empty: 'No handover is scheduled.',
                })
              : ''}
            <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn primary sm" data-oncall-command="rota">${oncall.rota ? 'Change the rota' : 'Set the rota'}</button>
              ${oncall.rota ? html`<button class="btn quiet sm" data-oncall-command="override">Hand the pager to one person</button>` : ''}
              ${oncall.rota?.override ? html`<button class="btn quiet sm" data-oncall-command="clear">Clear the override</button>` : ''}
            </div>
            ${oncall.rota
              ? html`<div class="metric-sub" style="margin-top:8px">
                  Rota set by ${oncall.rota.setBy} on ${String(oncall.rota.setAt).slice(0, 10)}: ${oncall.rota.members.map((member) => member.name).join(' → ')}, ${oncall.rota.rotationDays} day${
                    oncall.rota.rotationDays === 1 ? '' : 's'
                  } each from ${String(oncall.rota.startsAt).slice(0, 10)}.${
                    oncall.rota.override ? html` Override: ${oncall.rota.override.name} until ${String(oncall.rota.override.until).slice(0, 16).replace('T', ' ')} — ${oncall.rota.override.reason}.` : ''
                  }
                </div>`
              : ''}
          </div>`}

      ${!watch.error && watch.operational
        ? html`<div class="card" style="margin-bottom:14px" data-operational>
            <h2>Operational figures</h2>
            <p class="metric-sub" style="margin-bottom:10px">
              The measures the Enterprise / Group specification names (§17), each counted from the record — nothing here is modelled.
              A non-zero on unreconciled outcomes, frozen wallets or open exceptions is a finance decision waiting on the Tenants &amp; Users screen.
            </p>
            <div class="split-list">
              <div class="row"><span class="lbl">Authorisation denials, by reason</span><span class="val">${
                watch.operational.authorisationDenialsByReason.length
                  ? watch.operational.authorisationDenialsByReason.slice(0, 6).map((d) => `${d.reason} ${d.count}`).join(' · ')
                  : 'none since start'
              }</span></div>
              <div class="row"><span class="lbl">Unreconciled provider outcomes</span><span class="val">${badge(String(watch.operational.unreconciledProviderOutcomes), watch.operational.unreconciledProviderOutcomes > 0 ? 'warn' : 'ok')}${
                watch.operational.oldestUnreconciledSeconds !== null ? html` <span class="metric-sub">oldest ${Math.round(watch.operational.oldestUnreconciledSeconds / 60)} min</span>` : ''
              }</span></div>
              <div class="row"><span class="lbl">Open AI reservations</span><span class="val">${watch.operational.openHolds}${
                watch.operational.oldestOpenHoldSeconds !== null ? html` <span class="metric-sub">oldest ${watch.operational.oldestOpenHoldSeconds}s</span>` : ''
              }</span></div>
              <div class="row"><span class="lbl">Frozen wallets</span><span class="val">${badge(String(watch.operational.frozenWallets), watch.operational.frozenWallets > 0 ? 'bad' : 'ok')}</span></div>
              <div class="row"><span class="lbl">Open payment exceptions</span><span class="val">${badge(String(watch.operational.openPaymentExceptions), watch.operational.openPaymentExceptions > 0 ? 'warn' : 'ok')}</span></div>
              <div class="row"><span class="lbl">Issuance failures pending retry</span><span class="val">${watch.operational.issuanceFailures}</span></div>
              <div class="row"><span class="lbl">Webhook signature failures</span><span class="val">${badge(String(watch.operational.webhookSignatureFailures), watch.operational.webhookSignatureFailures > 0 ? 'warn' : 'ok')}</span></div>
              <div class="row"><span class="lbl">Ledger state-hash discrepancies</span><span class="val">${badge(String(watch.operational.ledgerDiscrepancies), watch.operational.ledgerDiscrepancies > 0 ? 'warn' : 'ok')}</span></div>
            </div>
          </div>`
        : ''}

      ${watch.error
        ? refusal('The platform watch', watch.error)
        : html`<div class="card pad0" style="margin-bottom:14px">
            <h2 style="padding:15px 17px 0">
              The watch
              ${firing.length > 0 ? badge(`${firing.length} firing`, critical.length > 0 ? 'bad' : 'warn') : badge('quiet', 'ok')}
            </h2>
            <div class="metric-sub" style="padding:0 17px 10px">
              ${(watch.alerts ?? []).length} rules, evaluated every ${watch.intervalSeconds ?? '—'} seconds against what
              the platform can measure about itself. A rule that has not had two observations yet judges no rate —
              which is why the first evaluation after a restart is not an all-clear.
              ${watch.lastEvaluatedAt ? html`Last evaluated ${time(watch.lastEvaluatedAt)}.` : 'It has not run on this process yet.'}
            </div>
            ${table({
              headers: ['Rule', 'Severity', 'State', 'What it observed'],
              rows: (watch.alerts ?? []).map((alert) => [
                html`<b>${alert.title ?? alert.id}</b>${
                  alert.description ? html`<div class="metric-sub">${alert.description}</div>` : ''
                }`,
                badge(String(alert.severity).toLowerCase(), alert.severity === 'CRITICAL' ? 'bad' : alert.severity === 'WARNING' ? 'warn' : 'info'),
                alert.firing ? badge('firing', 'bad') : badge('quiet', 'ok'),
                alert.detail ?? html`<span class="metric-sub">nothing to report</span>`,
              ]),
              empty: 'No rule is configured.',
            })}
            <div style="padding:12px 17px 15px">
              <button class="btn quiet sm" id="evaluate-watch">Evaluate every rule now</button>
              <div class="metric-sub" style="margin-top:8px">
                The same evaluation the timer runs, brought forward. It cannot make a rule fire that would not have
                fired on its own.
              </div>
            </div>
          </div>`}

      ${assurance.error
        ? refusal('Chain assurance', assurance.error)
        : html`<div class="card pad0" style="margin-bottom:14px">
            <h2 style="padding:15px 17px 0">
              Chain assurance
              ${assurance.enabled ? badge('running', 'ok') : badge('not running', 'warn')}
            </h2>
            <div class="metric-sub" style="padding:0 17px 10px">
              Every chain is recomputed and re-verified on a rotating slice — ${assurance.perPass} project${
                assurance.perPass === 1 ? '' : 's'
              } every ${assurance.intervalSeconds} seconds, so a full circuit of the estate takes
              ${assurance.passesForFullSweep} pass${assurance.passesForFullSweep === 1 ? '' : 'es'}. That second number is
              why the date each chain was last proved is a column rather than a footnote: "verified continuously" means
              nothing without it. ${assurance.lastPassAt ? html`Last pass ${time(assurance.lastPassAt)}.` : 'No pass has run yet on this process.'}
            </div>
            ${table({
              headers: ['Chain', 'Tenancy', 'Last proved', 'Verdict', 'Events'],
              align: ['', '', '', '', 'num'],
              rows: (assurance.projects ?? []).map((project) => [
                html`<span class="mono" style="font-size:11px">${project.projectId}</span>`,
                html`<span class="mono" style="font-size:10.5px">${String(project.tenantId).slice(-8)}</span>`,
                project.lastVerifiedAt ? time(project.lastVerifiedAt) : html`<span class="metric-sub">not yet in a pass</span>`,
                project.intact === undefined
                  ? html`<span class="metric-sub">unproved</span>`
                  : badge(project.intact ? 'intact' : 'DIVERGED', project.intact ? 'ok' : 'bad'),
                project.events ?? '—',
              ]),
              empty: 'No chain exists on this deployment.',
            })}
            <div style="padding:12px 17px 15px">
              <button class="btn quiet sm" id="sweep-chains">Verify the next slice now</button>
              <div class="metric-sub" style="margin-top:8px">
                <b>It detects and never repairs.</b> A verification that itself throws is recorded as a failure, never
                as intact — reporting all-clear for a check that did not run is the worst thing this could do.
              </div>
            </div>
          </div>`}

      ${security.error
        ? refusal('The security stream', security.error)
        : html`<div class="grid g2">
            <div class="card">
              <h2>Refusals by kind</h2>
              ${Object.keys(security.summary.byKind).length === 0
                ? html`<div class="empty"><b>Nothing recorded</b>No refusal has reached the gateway yet.</div>`
                : html`<div class="split-list">
                    ${Object.entries(security.summary.byKind).map(
                      ([kind, count]) => html`<div class="row"><span class="lbl">${humanise(kind)}</span><span class="val">${count}</span></div>`,
                    )}
                  </div>`}
              ${security.summary.repeatSources.length > 0
                ? html`<div class="metric-sub" style="margin-top:12px">
                    <b>${security.summary.repeatSources.length} source${
                      security.summary.repeatSources.length === 1 ? '' : 's'
                    } failing repeatedly</b> —
                    ${security.summary.repeatSources.slice(0, 3).map((source) => `${source.remote} (${source.failures})`).join(', ')}.
                    Repeated failures from one address is the brute-force shape.
                  </div>`
                : ''}
            </div>
            <div class="card pad0">
              <h2 style="padding:15px 17px 0">Most recent refusals</h2>
              ${table({
                headers: ['Kind', 'Reason', 'Path', 'Source'],
                rows: (security.events ?? [])
                  .slice(-12)
                  .reverse()
                  .map((event) => [
                    badge(humanise(event.kind), event.kind === 'AUTH_FAILURE' || event.kind === 'RATE_LIMITED' ? 'bad' : 'warn'),
                    humanise(event.reason),
                    event.path ?? '—',
                    event.remote ?? '—',
                  ]),
                empty: 'No refusal recorded.',
              })}
            </div>
          </div>`}
    `,
  );

  root.querySelector('[data-oncall]')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-oncall-command]');
    if (!button) return;
    const spec = ONCALL_COMMANDS[button.dataset.oncallCommand]?.(oncall);
    if (!spec) return;
    if (!(await command(spec))) return;
    await alerts(root);
  });

  document.getElementById('evaluate-watch')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Evaluating…';
    try {
      await api.post('/v1/admin/watch/evaluate', {});
      await alerts(root);
    } catch (error) {
      toast('Evaluation failed', error.message, 'err');
      button.disabled = false;
      button.textContent = 'Evaluate every rule now';
    }
  });

  document.getElementById('sweep-chains')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Verifying…';
    try {
      const result = await api.post('/v1/admin/assurance/sweep', {});
      toast(
        'Slice verified',
        `${result.verified ?? 0} chain${result.verified === 1 ? '' : 's'} proved` +
          ((result.diverged?.length ?? 0) > 0 ? ` — ${result.diverged.length} diverged` : ''),
        (result.diverged?.length ?? 0) > 0 ? 'err' : 'ok',
      );
      await alerts(root);
    } catch (error) {
      toast('Verification failed', error.message, 'err');
      button.disabled = false;
      button.textContent = 'Verify the next slice now';
    }
  });
}
