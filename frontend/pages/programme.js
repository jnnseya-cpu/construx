import { api, entityBundle } from '../lib/api.js';
import { command, commandBar, confirmCost } from '../lib/command.js';
import { badge, date, days, html, humanise, metric, modal, pct, positionReport, raw, render, statusTone, table, toast, track } from '../lib/ui.js';
import { insightPanel } from '../lib/insight.js';
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

  const [calc, bundle, ppc, logic, control] = await Promise.all([
    api.get(`/v1/projects/${projectId}/programme?contractualDurationDays=400`).catch((error) => ({ error })),
    entityBundle(projectId, ['Task', 'ProgrammeBaseline', 'DelayRiskSnapshot', 'Dependency', 'Constraint', 'LookaheadPlan', 'WorkPackage', 'ScopePackage']),
    // Percent Plan Complete and the constraints log. The critical path says
    // what the programme needs; PPC says whether the team can be relied on to
    // deliver a week of it, which is a different and more useful question.
    api.get(`/v1/projects/${projectId}/lookahead/ppc`).catch(() => null),
    // Whether the network holds together at all, and whether the programme has
    // moved since the forecast was taken. Both existed as engines with no
    // screen: a critical path computed from open ends is arithmetic on a
    // network nobody has checked.
    api.get(`/v1/projects/${projectId}/programme/logic`).catch((error) => ({ error })),
    api.get(`/v1/projects/${projectId}/programme/control`).catch((error) => ({ error })),
  ]);

  // The simulated distribution, alongside the analytic figure rather than
  // instead of it — people have been quoting the analytic one and need to be
  // able to explain the difference.
  const sim = await api
    .get(`/v1/projects/${projectId}/programme/simulate?contractualDurationDays=400`)
    .catch(() => null);

  const tasks = bundle.Task;
  const baseline = bundle.ProgrammeBaseline.filter((b) => b.status === 'APPROVED').at(-1);
  const delay = bundle.DelayRiskSnapshot.at(-1);
  const criticalIds = new Set(calc.criticalPath?.map((c) => c.taskId) ?? []);

  const complete = tasks.filter((t) => Number(t.percentComplete ?? 0) >= 100).length;
  const slipping = tasks.filter((t) => Number(t.slippageDays ?? 0) > 0);

  // What each headline figure was computed from. The network figures are a
  // function of the activities and their logic, so both are named; the critical
  // path names only the activities actually on it, because naming all of them
  // would make the drill useless on a programme of any size.
  const networkSources = [
    ...tasks.map((task) => ({ refType: 'Task', refId: task._refId })),
    ...bundle.Dependency.map((dependency) => ({ refType: 'Dependency', refId: dependency._refId })),
  ];
  const criticalSources = tasks
    .filter((task) => criticalIds.has(task._refId) || criticalIds.has(task.id))
    .map((task) => ({ refType: 'Task', refId: task._refId }));

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
            { id: 'constraint', label: 'Raise constraint', permitted: can('LOOKAHEAD_CONSTRAINTS', 'C'), reason: blockedReason('LOOKAHEAD_CONSTRAINTS', 'C') },
            { id: 'clear', label: 'Clear constraint', permitted: can('LOOKAHEAD_CONSTRAINTS', 'U'), reason: blockedReason('LOOKAHEAD_CONSTRAINTS', 'U') },
          ]))}
          ${can('PROGRAMME_BASELINES', 'X') ? html`<button class="btn ghost" id="forecast">Run delay forecast</button>` : ''}
          ${can('PROGRAMME_BASELINES', 'R') ? html`<button class="btn quiet" id="whatif">What-if analysis</button>` : ''}
        </div>
      </div>

      ${calc.error ? html`<div class="notice err">${calc.error.message}</div>` : ''}

      ${
        sim
          ? html`<div class="card" style="margin-bottom:14px">
              <h2>Simulated completion — ${sim.iterations.toLocaleString()} runs of the whole network</h2>
              <p class="metric-sub" style="margin-bottom:12px">
                The published P80 sums the variance along the deterministic critical path. That path is only critical
                for the durations it assumed, and where several paths are critical at once it adds up work that runs
                side by side as though it ran end to end. This resamples every activity and recomputes the path each
                time. Seeded from the project, so the same programme gives the same answer twice.
              </p>
              <div class="grid g5" style="margin-bottom:11px">
                <div><div class="metric">${days(sim.deterministicDays)}</div><div class="metric-sub">deterministic</div></div>
                <div><div class="metric">${days(sim.p50)}</div><div class="metric-sub">P50 simulated</div></div>
                <div><div class="metric orange">${days(sim.p80)}</div><div class="metric-sub">P80 simulated</div></div>
                <div><div class="metric">${days(sim.p90)}</div><div class="metric-sub">P90 simulated</div></div>
                <div><div class="metric ${raw(sim.probabilityOnTime >= 0.8 ? 'good' : sim.probabilityOnTime >= 0.5 ? 'warn' : 'bad')}">${pct((sim.probabilityOnTime ?? 0) * 100, 0)}</div><div class="metric-sub">on the contractual date</div></div>
              </div>
              <div class="notice ${raw(Math.abs(sim.analyticErrorDays) < 1 ? 'ok' : sim.analyticErrorDays > 0 ? 'warn' : '')}">
                ${
                  Math.abs(sim.analyticErrorDays) < 1
                    ? `The analytic P80 of ${sim.analyticP80Days.toFixed(1)}d agrees with the simulation.`
                    : html`The analytic P80 of ${sim.analyticP80Days.toFixed(1)}d is
                        ${Math.abs(sim.analyticErrorDays).toFixed(1)}d ${sim.analyticErrorDays > 0 ? 'optimistic' : 'pessimistic'}
                        against the simulation. ${days(Math.abs(sim.skewDays))} of that is skew — it centres on the sum of
                        most-likely durations, and the expected duration of a right-skewed estimate is higher than its
                        most likely. The remaining ${days(Math.abs(sim.residualDays))} is path effects and the normal
                        approximation's own understatement of the tail.`
                }
              </div>
              ${
                sim.criticalityIndex.length > 0
                  ? html`<div style="margin-top:12px">
                      <div class="metric-sub" style="margin-bottom:7px">
                        <b>Criticality index</b> — how often each activity landed on the critical path. An activity with
                        float today and a high index is a risk the critical path never shows.
                      </div>
                      ${table({
                        headers: ['Activity', 'On the critical path in'],
                        align: ['', 'num'],
                        rows: sim.criticalityIndex.slice(0, 8).map((c) => [c.name, pct(c.index * 100, 0)]),
                        empty: 'No activity was ever critical',
                      })}
                    </div>`
                  : ''
              }
            </div>`
          : ''
      }

      ${
        ppc
          ? html`<div class="card" style="margin-bottom:14px">
              <h2>Percent Plan Complete</h2>
              <p class="metric-sub" style="margin-bottom:12px">
                The critical path says what the programme needs. PPC says whether a week of it can be relied on —
                promises kept over promises made, with no partial credit, because the reason planning fails is almost
                never that people finished ten percent short.
              </p>
              <div class="grid g4" style="margin-bottom:11px">
                <div><div class="metric ${raw(ppc.meanPpcPercent === null ? '' : ppc.meanPpcPercent >= 85 ? 'good' : ppc.meanPpcPercent >= 65 ? 'warn' : 'bad')}">${
                  ppc.meanPpcPercent === null ? '—' : `${ppc.meanPpcPercent}%`
                }</div><div class="metric-sub">across ${ppc.weeks.length} reviewed ${ppc.weeks.length === 1 ? 'week' : 'weeks'}</div></div>
                <div><div class="metric ${raw(ppc.openConstraints.length === 0 ? 'good' : 'warn')}">${ppc.openConstraints.length}</div><div class="metric-sub">open constraints</div></div>
                <div><div class="metric ${raw(ppc.openConstraints.filter((c) => c.overdue).length === 0 ? '' : 'bad')}">${ppc.openConstraints.filter((c) => c.overdue).length}</div><div class="metric-sub">past their need-by date</div></div>
                <div><div class="metric">${ppc.meanDaysToClear === null ? '—' : days(ppc.meanDaysToClear)}</div><div class="metric-sub">average to clear one</div></div>
              </div>
              <div class="notice ${raw(ppc.meanPpcPercent === null ? '' : ppc.meanPpcPercent >= 85 ? 'ok' : 'warn')}">${ppc.summary}</div>
              ${
                ppc.weeks.length > 0
                  ? html`<div style="display:flex;align-items:flex-end;gap:4px;height:80px;margin:12px 0 4px">
                      ${ppc.weeks.map((w) => html`<div style="flex:1;background:linear-gradient(180deg,var(--orange),rgba(255,106,26,.25));height:${raw(Math.max(2, Math.round(w.ppcPercent)))}%;border-radius:2px 2px 0 0" title="${w.weekStarting}: ${w.completed}/${w.promised}"></div>`)}
                    </div>
                    <div class="metric-sub">${ppc.weeks.map((w) => `${w.weekStarting} ${w.ppcPercent}%`).join(' · ')}</div>`
                  : ''
              }
              ${
                ppc.topReasons.length > 0
                  ? html`<div class="split-list" style="margin-top:11px">
                      ${ppc.topReasons.map((r) => html`<div class="row"><span class="lbl">${humanise(r.reason)}</span><span class="val">${r.count} · ${r.share}% of broken promises</span></div>`)}
                    </div>`
                  : ''
              }
            </div>`
          : ''
      }

      ${
        ppc && ppc.openConstraints.length > 0
          ? html`<div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">Constraints log</h2>
              <div style="padding:0 17px"><div class="metric-sub">
                Work that cannot be committed to until somebody clears it. An owner and a need-by date against every
                line is what stops the log becoming wallpaper.
              </div></div>
              ${table({
                headers: ['Ref', 'Category', 'Owner', 'Needed by', 'On critical path'],
                rows: ppc.openConstraints.map((c) => [
                  c.reference,
                  humanise(c.category),
                  c.owner,
                  c.overdue ? html`${date(c.needByDate)} ${badge('overdue', 'bad')}` : date(c.needByDate),
                  c.blocksCriticalPath ? badge('yes', 'bad') : 'no',
                ]),
                empty: 'No open constraints',
              })}
            </div>`
          : ''
      }

      <div class="grid g4" style="margin-bottom:14px">
        ${metric({
          label: 'Programme duration',
          value: calc.projectDurationDays ? days(calc.projectDurationDays) : '—',
          tone: 'orange',
          sub: 'from the activity network',
          sources: networkSources,
        })}
        ${metric({
          label: 'P80 duration',
          value: calc.p80DurationDays ? days(calc.p80DurationDays) : '—',
          tone: 'warn',
          sub: 'aggregated PERT variance on the critical path',
          sources: networkSources,
        })}
        ${metric({
          label: 'On-time probability',
          value: calc.probabilityOnTime !== undefined ? pct(calc.probabilityOnTime * 100, 0) : '—',
          tone: (calc.probabilityOnTime ?? 0) >= 0.8 ? 'good' : 'warn',
          sub: 'against a 400-day contractual duration',
          sources: networkSources,
        })}
        ${metric({
          label: 'Critical / near-critical',
          value: raw(`${calc.criticalPath?.length ?? 0}<span style="font-size:16px;color:var(--text-3)"> / ${calc.nearCritical?.length ?? 0}</span>`),
          tone: 'bad',
          sub: 'zero float / five days or less',
          sources: criticalSources,
        })}
      </div>

      <div id="programme-insight" style="margin-bottom:14px"></div>

      ${
        delay
          ? html`<div class="card" style="margin-bottom:14px">
              <h2>Delay forecast — ${delay.severity}</h2>
              <div class="grid g3" style="margin-bottom:14px">
                <div><div class="metric bad">${days(delay.expectedDelayDays)}</div><div class="metric-sub">expected overrun</div></div>
                <div><div class="metric warn">${days(delay.p80DelayDays)}</div><div class="metric-sub">P80 overrun</div></div>
                <div><div class="metric">${pct((delay.confidence ?? 0) * 100, 0)}</div><div class="metric-sub">data completeness behind the forecast</div></div>
              </div>
              <h2>Corrective measures, cheapest first</h2>
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
          <h2 style="padding:15px 17px 0">Activities</h2>
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
            <h2>Approved baseline</h2>
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
            <h2>Slipping activities</h2>
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
        <h2>Near-critical — the path about to become critical</h2>
        ${table({
          headers: ['Activity', 'Total float'],
          align: ['', 'num'],
          rows: (calc.nearCritical ?? []).map((a) => [a.name, days(a.totalFloat)]),
          empty: 'No activity is within five days of critical',
        })}
      </div>

      ${positionReport({
        title: 'Programme logic — is the network sound',
        intent:
          'A critical path computed over open ends and dangling logic is arithmetic on a network nobody has ' +
          'checked. Each finding is named rather than counted, because "6 issues" cannot be fixed.',
        data: logic,
        error: logic?.error,
        sections: [
          { key: 'findings', label: 'Findings', empty: 'The network has no open ends, dangling logic, negative float or out-of-sequence work.' },
          { key: 'blocking', label: 'Blocking a baseline', empty: 'Nothing in the logic prevents this programme being baselined.' },
          { key: 'activities', label: 'Activities' },
          { key: 'dependencies', label: 'Dependencies' },
        ],
      })}

      ${positionReport({
        title: 'Programme control — baseline against forecast',
        intent: 'Whether the forecast is still current, what is blocked and why, and what has moved since it was taken.',
        data: control,
        error: control?.error,
        sections: [
          { key: 'forecastCurrent', label: 'Forecast still current' },
          { key: 'blocked', label: 'Blocked, and why', empty: 'Nothing is recorded as blocked.' },
          { key: 'outOfSequence', label: 'Working out of sequence', empty: 'No activity has started before its predecessor finished.' },
          { key: 'frozenWeeks', label: 'Frozen weeks', empty: 'No week is frozen.' },
        ],
      })}
    `,
  );

  document.getElementById('forecast')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const path = `/v1/projects/${state.session.projectId}/programme/delay-forecast`;

    const accepted = await confirmCost({
      title: 'Run delay forecast',
      intent: 'Ranks the delay drivers on the current network and prices the corrective measures.',
      path,
      runLabel: 'Run forecast',
    });
    if (!accepted) return;

    button.disabled = true;
    button.textContent = 'Running…';
    try {
      const result = await api.post(path, {
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
    constraint: {
      title: 'Raise constraint',
      intent:
        'Something that must be cleared before the work can start. It needs an owner and a date it is needed by — a log without either is a list of complaints.',
      path: `/v1/projects/${projectId}/constraints`,
      submitLabel: 'Raise',
      fields: [
        { name: 'taskId', label: 'Activity', type: 'select', options: tasks.map((t) => ({ value: t._refId, label: `${t.activityCode} · ${t.name}` })) },
        { name: 'category', label: 'Category', type: 'select', options: [
          { value: 'DESIGN', label: 'Design information' },
          { value: 'MATERIALS', label: 'Materials' },
          { value: 'LABOUR', label: 'Labour' },
          { value: 'PLANT', label: 'Plant' },
          { value: 'ACCESS', label: 'Access' },
          { value: 'PERMIT', label: 'Permit or consent' },
          { value: 'PREDECESSOR', label: 'Predecessor work' },
          { value: 'INFORMATION', label: 'Information' },
          { value: 'APPROVAL', label: 'Approval' },
        ] },
        { name: 'description', label: 'What is blocking it', type: 'textarea' },
        { name: 'owner', label: 'Who has to clear it', type: 'text', hint: 'Not the person raising it' },
        { name: 'needByDate', label: 'Needed by', type: 'date' },
      ],
    },
    clear: {
      title: 'Clear constraint',
      intent: 'What actually cleared it, so the next job can see how this one was unblocked.',
      path: (collected) => `/v1/projects/${projectId}/constraints/${collected.constraintId}/close`,
      transform: ({ constraintId, ...rest }) => rest,
      submitLabel: 'Clear',
      fields: [
        { name: 'constraintId', label: 'Constraint', type: 'select',
          options: (bundle.Constraint ?? []).filter((c) => c.status !== 'CLOSED').map((c) => ({ value: c._refId, label: `${c.reference} · ${String(c.description).slice(0, 46)}` })) },
        { name: 'resolution', label: 'What cleared it', type: 'textarea', hint: '"Resolved" tells the next job nothing' },
      ],
    },
  };

  void insightPanel(root.querySelector('#programme-insight'), {
    projectId,
    areas: ['PROGRAMME_BASELINES', 'WORKPACKAGES_TASKS', 'LOOKAHEAD_CONSTRAINTS'],
    subject: 'the programme',
    onChange: draw,
  });

  root.querySelector('.cmd-bar')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    const spec = COMMANDS[button.dataset.command];
    if (!spec) return;
    if (await command(spec)) await draw();
  });
}

function moneyOf(minor) {
  return `£${(Number(minor ?? 0) / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
