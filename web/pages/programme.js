import { api, entityBundle } from '../lib/api.js';
import { command, commandBar } from '../lib/command.js';
import { badge, date, days, html, humanise, modal, pct, raw, render, statusTone, table, toast, track } from '../lib/ui.js';
import { blockedReason, can, draw, state } from '../app.js';

/**
 * Programme.
 *
 * The critical path is recalculated from the activity network on every load —
 * dates are an output, never an input. That is what makes "what changed and
 * why" answerable: the inputs that produced the dates are all in the ledger.
 */

export async function programme(root) {
  const projectId = state.session.projectId;

  const [calc, bundle] = await Promise.all([
    api.get(`/v1/projects/${projectId}/programme?contractualDurationDays=400`).catch((error) => ({ error })),
    entityBundle(projectId, ['Task', 'ProgrammeBaseline', 'DelayRiskSnapshot', 'Dependency', 'Constraint', 'WorkPackage', 'ScopePackage']),
  ]);

  const tasks = bundle.Task;
  const baseline = bundle.ProgrammeBaseline.filter((b) => b.status === 'APPROVED').at(-1);
  const delay = bundle.DelayRiskSnapshot.at(-1);
  const criticalIds = new Set(calc.criticalPath?.map((c) => c.taskId) ?? []);

  const complete = tasks.filter((t) => Number(t.percentComplete ?? 0) >= 100).length;
  const slipping = tasks.filter((t) => Number(t.slippageDays ?? 0) > 0);

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Programme</h1>
          <p>Computed from ${tasks.length} activities and ${bundle.Dependency.length} logic links. Every figure below is derived, not entered.</p>
        </div>
        <div class="actions cmd-bar">
          ${raw(commandBar([
            { id: 'task', label: 'Create activity', tone: '', permitted: can('WORKPACKAGES_TASKS', 'C'), reason: blockedReason('WORKPACKAGES_TASKS', 'C') },
          ]))}
          ${can('PROGRAMME_BASELINES', 'X') ? html`<button class="btn ghost" id="forecast">Run delay forecast</button>` : ''}
          ${can('PROGRAMME_BASELINES', 'R') ? html`<button class="btn quiet" id="whatif">What-if analysis</button>` : ''}
        </div>
      </div>

      ${calc.error ? html`<div class="notice err">${calc.error.message}</div>` : ''}

      <div class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h3>Programme duration</h3>
          <div class="metric orange">${calc.projectDurationDays ? days(calc.projectDurationDays) : '—'}</div>
          <div class="metric-sub">from the activity network</div>
        </div>
        <div class="card">
          <h3>P80 duration</h3>
          <div class="metric warn">${calc.p80DurationDays ? days(calc.p80DurationDays) : '—'}</div>
          <div class="metric-sub">aggregated PERT variance on the critical path</div>
        </div>
        <div class="card">
          <h3>On-time probability</h3>
          <div class="metric ${raw((calc.probabilityOnTime ?? 0) >= 0.8 ? 'good' : 'warn')}">
            ${calc.probabilityOnTime !== undefined ? pct(calc.probabilityOnTime * 100, 0) : '—'}
          </div>
          <div class="metric-sub">against a 400-day contractual duration</div>
        </div>
        <div class="card">
          <h3>Critical / near-critical</h3>
          <div class="metric bad">${calc.criticalPath?.length ?? 0}<span style="font-size:16px;color:var(--text-3)"> / ${calc.nearCritical?.length ?? 0}</span></div>
          <div class="metric-sub">zero float / five days or less</div>
        </div>
      </div>

      ${
        delay
          ? html`<div class="card" style="margin-bottom:14px">
              <h3>Delay forecast — ${delay.severity}</h3>
              <div class="grid g3" style="margin-bottom:14px">
                <div><div class="metric bad">${days(delay.expectedDelayDays)}</div><div class="metric-sub">expected overrun</div></div>
                <div><div class="metric warn">${days(delay.p80DelayDays)}</div><div class="metric-sub">P80 overrun</div></div>
                <div><div class="metric">${pct((delay.confidence ?? 0) * 100, 0)}</div><div class="metric-sub">data completeness behind the forecast</div></div>
              </div>
              <h3>Corrective measures, cheapest first</h3>
              ${table({
                headers: ['Measure', 'Recovers', 'Cost', 'Per day', 'Applicability'],
                align: ['', 'num', 'num', 'num', ''],
                rows: (delay.correctiveMeasures ?? [])
                  .slice(0, 5)
                  .map((m) => [m.measure, days(m.recoveryDays), moneyOf(m.costMinor), moneyOf(m.costPerDayMinor), m.applicability]),
              })}
            </div>`
          : ''
      }

      <div class="grid g-2-1" style="margin-bottom:14px">
        <div class="card pad0">
          <h3 style="padding:15px 17px 0">Activities</h3>
          ${table({
            headers: ['Activity', 'Duration', 'Progress', 'Slippage', 'Path', 'Status'],
            align: ['', 'num', '', 'num', '', ''],
            rows: tasks.map((t) => [
              t.name,
              days(t.durationDays),
              track(t.percentComplete ?? 0, Number(t.percentComplete ?? 0) >= 100 ? 'good' : criticalIds.has(t._refId) ? 'bad' : ''),
              Number(t.slippageDays ?? 0) > 0 ? badge(days(t.slippageDays), 'bad') : '—',
              criticalIds.has(t._refId) ? badge('CRITICAL', 'bad') : badge('float', 'neutral'),
              badge(humanise(t.status), statusTone(t.status)),
            ]),
          })}
        </div>

        <div>
          <div class="card" style="margin-bottom:14px">
            <h3>Approved baseline</h3>
            <div class="split-list">
              <div class="row"><span class="lbl">Version</span><span class="val">${baseline?.version ?? 'none'}</span></div>
              <div class="row"><span class="lbl">Duration</span><span class="val">${baseline ? days(baseline.durationDays) : '—'}</span></div>
              <div class="row"><span class="lbl">Completion</span><span class="val">${date(baseline?.contractualCompletionDate)}</span></div>
              <div class="row"><span class="lbl">Approved</span><span class="val">${date(baseline?.approvedAt)}</span></div>
            </div>
            ${
              baseline
                ? html`<div style="margin-top:11px">${badge('Frozen — variance measured against this', 'ok')}</div>`
                : html`<div class="notice warn" style="margin:11px 0 0">No approved baseline. Delay cannot be measured against anything.</div>`
            }
          </div>

          <div class="card">
            <h3>Slipping activities</h3>
            ${
              slipping.length === 0
                ? html`<div class="empty"><b>Nothing slipping</b>Every activity is tracking to plan.</div>`
                : html`<div class="split-list">
                    ${slipping.map(
                      (t) => html`<div class="row">
                        <span class="lbl">${t.name}</span>
                        <span class="val" style="color:var(--critical)">${days(t.slippageDays)}</span>
                      </div>`,
                    )}
                  </div>`
            }
          </div>
        </div>
      </div>

      <div class="card">
        <h3>Near-critical — the path about to become critical</h3>
        ${table({
          headers: ['Activity', 'Total float'],
          align: ['', 'num'],
          rows: (calc.nearCritical ?? []).map((a) => [a.name, days(a.totalFloat)]),
          empty: 'No activity is within five days of critical',
        })}
      </div>
    `,
  );

  document.getElementById('forecast')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Running…';
    try {
      const result = await api.post(`/v1/projects/${state.session.projectId}/programme/delay-forecast`, {
        dailyPreliminariesMinor: 1_850_000,
        contractualDurationDays: 400,
      });
      toast('Delay forecast complete', `${result.snapshot.expectedDelayDays}d expected · ${result.acuConsumed} ACU consumed`, 'ok');
      await refreshContext();
      await programme(root);
    } catch (error) {
      toast('Forecast failed', error.message, 'err');
      button.disabled = false;
      button.textContent = 'Run delay forecast';
    }
  });

  document.getElementById('whatif')?.addEventListener('click', async () => {
    const first = tasks[0];
    const values = await modal({
      title: 'What-if analysis',
      submitLabel: 'Run scenario',
      fields: [
        {
          name: 'taskId',
          label: 'Activity',
          type: 'select',
          options: tasks.map((t) => ({ value: t._refId, label: `${t.name} (${t.durationDays}d)` })),
        },
        { name: 'duration', label: 'New duration (days)', type: 'number', value: String(first?.durationDays ?? 30) },
      ],
    });
    if (!values) return;

    try {
      const result = await api.post(`/v1/projects/${state.session.projectId}/programme/what-if`, {
        changes: [{ taskId: values.taskId, newDurationDays: Number(values.duration) }],
      });
      const direction = result.deltaDays > 0 ? 'later' : result.deltaDays < 0 ? 'earlier' : 'unchanged';
      toast(
        'Scenario complete — nothing was written',
        `${result.baselineDurationDays}d → ${result.scenarioDurationDays}d (${Math.abs(result.deltaDays)}d ${direction})`,
        'ok',
      );
    } catch (error) {
      toast('Scenario failed', error.message, 'err');
    }
  });
}

function moneyOf(minor) {
  return `£${(Number(minor ?? 0) / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

  const COMMANDS = {
    task: {
      title: 'Create activity',
      intent: 'Duration drives the critical path. Optimistic and pessimistic durations are what make the P80 forecast meaningful rather than a single guess.',
      path: `/v1/projects/${projectId}/programme/tasks`,
      submitLabel: 'Create',
      fields: [
        { name: 'workPackageId', label: 'Work package', type: 'select',
          options: (bundle.WorkPackage ?? []).map((w) => ({ value: w._refId, label: w.name })) },
        { name: 'activityCode', label: 'Activity code', type: 'text', placeholder: 'A900' },
        { name: 'name', label: 'Activity', type: 'text' },
        { name: 'durationDays', label: 'Duration (days)', type: 'number', min: 1 },
        { name: 'costCode', label: 'Cost code', type: 'text', placeholder: 'CIV.001' },
        { name: 'optimisticDays', label: 'Optimistic duration', type: 'number', required: false, hint: 'Leave blank to treat the duration as certain' },
        { name: 'pessimisticDays', label: 'Pessimistic duration', type: 'number', required: false },
      ],
      // The endpoint takes a batch; a single activity is a batch of one.
      transform: (v) => ({ tasks: [v] }),
    },
  };

  root.querySelector('.cmd-bar')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    const spec = COMMANDS[button.dataset.command];
    if (!spec) return;
    if (await command(spec)) await draw();
  });
}
