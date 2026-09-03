import { api } from '../lib/api.js';
import { badge, html, positionReport, raw, render, table, time } from '../lib/ui.js';
import { command, commandBar } from '../lib/command.js';
import { draw, isOperator } from '../app.js';
import { refusal } from '../lib/estate.js';

/**
 * Platform operations — the screen the operator did not have.
 *
 * The self-managing layer, the telemetry egress and the agent fleet were all
 * built, routed, authorised and tested, and none of them had a door. An operator
 * signing in got five sidebar items, three of them locked, and two working
 * screens. Everything this page shows was already running; nobody could see any
 * of it.
 *
 * Four questions, in the order an operator asks them when something is wrong:
 *
 *   1. **Is the record still sound?** Chain assurance. A diverged project is a
 *      platform emergency and is stated as one.
 *   2. **Is the platform complaining about itself?** The watch rules, and
 *      whether there is anybody to tell.
 *   3. **What has it repaired, and is it repairing the same thing repeatedly?**
 *      A rising count is a defect, not a fix, and the screen says so.
 *   4. **Is any of this leaving the container?** Telemetry egress — because a
 *      deployment whose observability is local has none.
 *
 * Then the fleet, which is a statement about what is allowed to act rather than
 * a control panel: the ladder, and every agent's rung.
 *
 * No permission logic lives here. Every read is authorised by the route it calls
 * — `operatorOnly` on the server — so this page cannot show a customer anything,
 * and cannot be made to by editing it.
 */

const COMMANDS = {
  sweep: () => ({
    title: 'Verify the next slice now',
    intent:
      'Brings the next scheduled pass forward. It proves chains; it never repairs one — a chain that has diverged is evidence, and evidence is not something to tidy up.',
    path: '/v1/admin/assurance/sweep',
    submitLabel: 'Verify now',
    fields: [
      {
        name: 'projects',
        label: 'How many projects',
        type: 'number',
        required: false,
        hint: 'Left empty, the configured slice size. The sweep rotates, so every project is reached in turn.',
      },
    ],
  }),
  evaluate: () => ({
    title: 'Evaluate every watch rule now',
    intent:
      'The same evaluation the timer runs, brought forward. It cannot make a rule fire that would not have fired on its own.',
    path: '/v1/admin/watch/evaluate',
    submitLabel: 'Evaluate',
    fields: [],
  }),
  repair: () => ({
    title: 'Run a repair pass now',
    intent: 'Restarts a stopped drain, moves a queue that is owed. It will not touch anything outside that.',
    path: '/v1/admin/repair',
    submitLabel: 'Repair',
    fields: [],
  }),
  flush: () => ({
    title: 'Ship queued telemetry now',
    intent: 'Sends what is queued rather than waiting for the interval.',
    path: '/v1/admin/telemetry/flush',
    submitLabel: 'Flush',
    fields: [],
  }),
};

/** Tone for a watch severity, using the platform's own vocabulary. */
function severityTone(severity) {
  if (severity === 'CRITICAL') return 'bad';
  if (severity === 'WARNING') return 'warn';
  return 'info';
}

export async function operations(root) {
  // Each read is separate and each may legitimately fail — a deployment with no
  // collector configured still has chains to prove. A failed panel says so
  // rather than rendering as an empty one, because "nothing to report" and
  // "this is broken" must never look the same.
  const [assurance, watch, repair, egress, fleet, ladder, retention] = await Promise.all([
    api.get('/v1/admin/assurance').catch((error) => ({ error })),
    api.get('/v1/admin/watch').catch((error) => ({ error })),
    api.get('/v1/admin/repair').catch((error) => ({ error })),
    api.get('/v1/admin/telemetry/egress').catch((error) => ({ error })),
    api.get('/v1/agents/fleet').catch((error) => ({ error })),
    api.get('/v1/agents/ladder').catch((error) => ({ error })),
    // What the object store actually holds, what no record names, and the
    // policy on removing any of it. An orphan is a file the platform is storing
    // for nobody, which is both a cost and a data-protection question.
    //
    // Project evidence is customer delivery data, and the account-layer fence
    // bars a platform operator from it before the route is even considered.
    // The fence is known here, so the operator is not sent to it.
    isOperator()
      ? Promise.resolve({ error: { status: 403, message: 'Platform operators are barred from customer delivery data' } })
      : api.get('/v1/evidence/retention').catch((error) => ({ error })),
  ]);

  const failed = (panel) => (panel && panel.error ? panel.error.message ?? 'This could not be read' : null);

  const diverged = assurance.error ? [] : (assurance.diverged ?? []);
  const firing = watch.error ? [] : (watch.firing ?? []);
  const recurring = repair.error ? [] : (repair.recurring ?? []);
  const agents = fleet.error ? [] : (fleet.divisions ?? []);
  const agentCount = agents.reduce((total, division) => total + (division.agents ?? []).length, 0);

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Platform operations</h1>
          <p>
            Whether the record is still sound, what the platform is saying about itself, what it has
            repaired, and whether any of it is leaving this container. Every panel is a live read; none
            of it is a summary of something written down earlier.
          </p>
        </div>
        <div class="actions cmd-bar">
          ${raw(
            commandBar([
              { id: 'sweep', label: 'Verify chains now', permitted: true },
              { id: 'evaluate', label: 'Evaluate rules', permitted: true },
              { id: 'repair', label: 'Repair pass', permitted: true },
              { id: 'flush', label: 'Flush telemetry', permitted: true },
            ]),
          )}
        </div>
      </div>

      ${diverged.length > 0
        ? html`<div class="notice err">
            <div>
              <b>${diverged.length} project${diverged.length === 1 ? '' : 's'} no longer verify.</b><br />
              A chain that has diverged is the one thing this platform cannot argue its way out of. It is
              reported and never repaired: overwriting the divergence would destroy the evidence that it
              happened.
              <br />${raw(diverged.map((entry) => `<code>${entry.projectId}</code>`).join(' '))}
            </div>
          </div>`
        : ''}

      ${firing.length > 0
        ? html`<div class="notice warn">
            <div>
              <b>${firing.length} rule${firing.length === 1 ? ' is' : 's are'} firing.</b><br />
              ${raw(firing.map((state) => `${state.id}${state.detail ? ` — ${state.detail}` : ''}`).join('<br>'))}
            </div>
          </div>`
        : ''}

      ${!watch.error && watch.enabled && watch.operators === 0
        ? html`<div class="notice warn">
            <div>
              <b>Nothing would be told.</b><br />
              The watch is armed and there is no operator to notify, so this deployment is watching itself
              in silence. A rule that fires into an empty room has not been handled.
            </div>
          </div>`
        : ''}

      <section class="card">
        <h3>Chain assurance</h3>
        ${assurance.error
          ? refusal('Chain assurance', assurance.error)
          : html`
              <div class="grid g4">
                <div class="metric"><span>Projects tracked</span><strong>${(assurance.projects ?? []).length}</strong></div>
                <div class="metric"><span>Diverged</span><strong>${diverged.length}</strong></div>
                <div class="metric"><span>Per pass</span><strong>${assurance.perPass ?? 0}</strong></div>
                <div class="metric"><span>Passes for a full sweep</span><strong>${assurance.passesForFullSweep ?? 0}</strong></div>
              </div>
              <p class="metric-sub">
                ${assurance.enabled
                  ? `Verifying a rotating slice every ${assurance.intervalSeconds}s. Last pass ${assurance.lastPassAt ? time(assurance.lastPassAt) : 'not yet run'}.`
                  : 'Continuous verification is off. Chains are proved only when somebody asks.'}
              </p>
              ${raw(
                table({
                  headers: ['Project', 'Last proved', 'Events', 'Root hash', 'State'],
                  align: ['', '', 'num', 'mono', ''],
                  rows: (assurance.projects ?? []).map((entry) => [
                    entry.projectId,
                    entry.lastVerifiedAt ? time(entry.lastVerifiedAt) : 'never',
                    String(entry.events ?? 0),
                    entry.rootHash ? `<code>${String(entry.rootHash).slice(0, 12)}</code>` : '—',
                    entry.intact === false ? badge('diverged', 'bad') : entry.intact ? badge('intact', 'good') : badge('unproved', 'muted'),
                  ]),
                  empty: 'No project has been verified yet. Nothing is wrong; nothing has been proved either.',
                }),
              )}
            `}
      </section>

      <section class="card">
        <h3>What the platform says about itself</h3>
        ${watch.error
          ? refusal('The watch', watch.error)
          : raw(
              table({
                headers: ['Rule', 'What it watches', 'Why it matters', 'Severity', 'State'],
                rows: (watch.rules ?? []).map((rule) => [
                  rule.id,
                  rule.what,
                  rule.because,
                  badge(String(rule.severity ?? '').toLowerCase(), severityTone(rule.severity)),
                  firing.some((state) => state.id === rule.id) ? badge('firing', 'bad') : badge('clear', 'good'),
                ]),
                empty: 'No rules are declared, which means the platform is not watching itself at all.',
              }),
            )}
      </section>

      <section class="card">
        <h3>What it has repaired</h3>
        ${repair.error
          ? refusal('Repair', repair.error)
          : html`
              ${recurring.length > 0
                ? html`<div class="notice warn">
                    <div>
                      <b>${recurring.length} repair${recurring.length === 1 ? ' is' : 's are'} recurring.</b><br />
                      Past a threshold a repair stops being a remedy and becomes a symptom. These are named
                      so the platform cannot quietly paper over the same fault indefinitely.<br />
                      ${raw(recurring.map((entry) => `${entry.action} ×${entry.count} — ${entry.because}`).join('<br>'))}
                    </div>
                  </div>`
                : ''}
              ${raw(
                table({
                  headers: ['When', 'Action', 'Outcome'],
                  rows: (repair.attempts ?? [])
                    .slice(-25)
                    .reverse()
                    .map((attempt) => [
                      time(attempt.at),
                      attempt.action,
                      attempt.ok === false ? badge('failed', 'bad') : badge('taken', 'good'),
                    ]),
                  empty: 'Nothing has needed repairing.',
                }),
              )}
              <h4>What it refuses to do</h4>
              <p class="metric-sub">
                Published rather than assumed. A self-repairing platform that did not state its limits would
                be indistinguishable from one that had none.
              </p>
              <ul>${(repair.refuses ?? []).map((line) => html`<li>${line}</li>`)}</ul>
            `}
      </section>

      <section class="card">
        <h3>Telemetry egress</h3>
        ${egress.error
          ? refusal('Telemetry egress', egress.error)
          : egress.configured
            ? html`
                <div class="grid g4">
                  <div class="metric"><span>Exported</span><strong>${egress.exported ?? 0}</strong></div>
                  <div class="metric"><span>Queued</span><strong>${egress.queued ?? 0}</strong></div>
                  <div class="metric ${raw((egress.dropped ?? 0) > 0 ? 'bad' : '')}"><span>Dropped</span><strong>${egress.dropped ?? 0}</strong></div>
                  <div class="metric"><span>Failures</span><strong>${egress.failures ?? 0}</strong></div>
                </div>
                <p class="metric-sub">
                  Shipping to <code>${egress.endpoint ?? 'an unnamed collector'}</code>. Last success
                  ${egress.lastSuccessAt ? time(egress.lastSuccessAt) : 'none yet'}.
                  ${egress.lastError ? ` Last error: ${egress.lastError}` : ''}
                </p>
              `
            : html`<div class="notice warn">
                <div>
                  <b>No collector is configured.</b><br />
                  Counters and the security stream are held in this process and die with the container. That
                  is a stated limit of this deployment, not a fault — but nothing here survives a restart, so
                  an incident cannot be reconstructed after one.
                </div>
              </div>`}
      </section>

      <section class="card">
        <h3>The agent workforce</h3>
        ${fleet.error
          ? refusal('The fleet', fleet.error)
          : html`
              <p class="metric-sub">
                ${agentCount} agents across ${agents.length} divisions. The rung is the whole safety property:
                no agent approves its own proposal, and none acts unattended without a granted envelope.
              </p>
              ${!ladder.error
                ? raw(
                    table({
                      headers: ['Rung', 'What it may do', 'Who is in the loop'],
                      rows: (ladder.ladder ?? []).map((rung) => [rung.level, rung.what, rung.humanInTheLoop]),
                      empty: 'The ladder is not published, which means nothing constrains what an agent may do.',
                    }),
                  )
                : ''}
              ${agents.map(
                (division) => html`
                  <h4>${division.division}</h4>
                  ${raw(
                    table({
                      headers: ['Agent', 'What it is for', 'Highest rung'],
                      rows: (division.agents ?? []).map((agent) => [
                        agent.name,
                        agent.purpose,
                        badge(String(agent.mandate?.maxUnattended ?? 'OBSERVE').toLowerCase(), 'info'),
                      ]),
                      empty: 'No agents in this division.',
                    }),
                  )}
                `,
              )}
            `}
      </section>

      ${positionReport({
        title: 'Evidence retention',
        intent:
          'What the object store holds, what no record names, and the policy on removing any of it. An orphan is a ' +
          'file being kept for nobody — a cost and a data-protection question at once.',
        data: retention,
        error: retention?.error,
        sections: [
          { key: 'configured', label: 'Object store configured' },
          { key: 'heldObjects', label: 'Objects held' },
          { key: 'recordedNotHeld', label: 'Named in the record, not held' },
          { key: 'orphans', label: 'Held but named by nothing', empty: 'Every stored object is named by a record.' },
        ],
      })}
    `,
  );

  root.querySelector('.cmd-bar')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    const spec = COMMANDS[button.dataset.command]?.();
    if (!spec) return;
    if (!(await command(spec))) return;
    await draw();
  });
}
