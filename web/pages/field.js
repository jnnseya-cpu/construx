import { api, entityBundle } from '../lib/api.js';
import { command, commandBar } from '../lib/command.js';
import { OBSERVATION_TYPE, WEATHER_CONDITION, today } from '../lib/enums.js';
import { badge, date, days, html, humanise, pct, raw, render, statusTone, table, time, track } from '../lib/ui.js';
import { blockedReason, can, draw, state } from '../app.js';

/**
 * Field Execution.
 *
 * What the site actually did, and the evidence for it. Progress without
 * evidence is not accepted by the platform, so everything on this screen has a
 * hashed record behind it.
 */

export async function field(root) {
  const projectId = state.session.projectId;

  const b = await entityBundle(projectId, [
    'Task',
    'ProgressMeasurement',
    'SiteObservation',
    'QualityInspection',
    'Snag',
    'NCR',
    'CommissioningTest',
    'EvidenceItem',
    'Constraint',
    'SiteDiary',
  ]);

  // The diary read as evidence rather than as a list of days. A gap and a late
  // entry are the two things the other side's expert looks for first, and
  // neither is visible reading the diary a page at a time.
  const diary = await api
    .get(`/v1/projects/${projectId}/site-diary/position`)
    .catch(() => null);

  const measured = b.Task.filter((t) => Number(t.percentComplete ?? 0) > 0);
  const complete = b.Task.filter((t) => Number(t.percentComplete ?? 0) >= 100);
  const openSnags = b.Snag.filter((s) => s.status !== 'CLOSED');
  const dispatched = b.Snag.filter((s) => s.status === 'DISPATCHED');
  const openConstraints = b.Constraint.filter((c) => c.status !== 'CLOSED');

  const coverage = b.Task.length === 0 ? 0 : (measured.length / b.Task.length) * 100;

  // Snags grouped by cost code — the routing that gets them actually fixed.
  const byTrade = new Map();
  for (const snag of openSnags) {
    const key = `${snag.costCode} · ${snag.responsibleTrade}`;
    byTrade.set(key, (byTrade.get(key) ?? 0) + 1);
  }

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Field Execution</h1>
          <p>Captured on site, offline where necessary. Device timestamps are preserved, so the time on a record is the time the work happened.</p>
        </div>
        <div class="actions cmd-bar">
          ${raw(
            commandBar([
              { id: 'progress', label: 'Record progress', tone: '', permitted: can('FIELD_EXECUTION', 'C'), reason: blockedReason('FIELD_EXECUTION', 'C') },
              { id: 'observation', label: 'Log safety observation', permitted: can('SAFETY_RAMS', 'C'), reason: blockedReason('SAFETY_RAMS', 'C') },
              { id: 'work-order', label: 'Raise work order', permitted: can('FIELD_EXECUTION', 'C'), reason: blockedReason('FIELD_EXECUTION', 'C') },
            ]),
          )}
        </div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <h3>Daily site record</h3>
        <p class="metric-sub" style="margin-bottom:12px">
          Labour, plant and weather for the shift. These are the numbers a delay claim is later argued from,
          so they are captured once, on the day, against the activity they relate to.
        </p>
        <form class="input-zone" id="daily">
          <div class="field">
            <label for="d-date">Date</label>
            <input id="d-date" name="diaryDate" type="date" value="${today()}" max="${today()}">
          </div>
          <div class="field">
            <label for="d-trade">Trade on site</label>
            <input id="d-trade" name="trade" type="text" placeholder="Groundworks">
          </div>
          <div class="field">
            <label for="d-labour">Operatives</label>
            <input id="d-labour" name="headcount" type="number" min="0" step="1" placeholder="8">
          </div>
          <div class="field">
            <label for="d-hours">Hours each</label>
            <input id="d-hours" name="hours" type="number" min="0" step="0.5" value="9">
          </div>
          <div class="field">
            <label for="d-plantdesc">Plant</label>
            <input id="d-plantdesc" name="plantDescription" type="text" placeholder="13t excavator">
          </div>
          <div class="field">
            <label for="d-plant">Plant hours worked</label>
            <input id="d-plant" name="plantHours" type="number" min="0" step="0.5" placeholder="hours">
          </div>
          <div class="field">
            <label for="d-idle">Plant hours idle</label>
            <input id="d-idle" name="plantIdle" type="number" min="0" step="0.5" value="0">
          </div>
          <div class="field">
            <label for="d-weather">Weather</label>
            <select id="d-weather" name="weather">
              ${WEATHER_CONDITION.map((o) => html`<option value="${o.value}">${o.label}</option>`)}
            </select>
          </div>
          <div class="field">
            <label for="d-stopped">Did weather stop work?</label>
            <select id="d-stopped" name="workingStopped">
              <option value="false">No</option>
              <option value="true">Yes</option>
            </select>
          </div>
          <div class="field">
            <label for="d-lost">Hours lost</label>
            <input id="d-lost" name="hoursLost" type="number" min="0" step="0.5" value="0">
          </div>
          <div class="actions">
            <button class="btn" type="submit" ${raw(can('FIELD_EXECUTION', 'C') ? '' : `disabled title="${blockedReason('FIELD_EXECUTION', 'C')}"`)}>Save day</button>
          </div>
        </form>
        <div class="metric-sub" style="margin-top:11px" id="daily-note"></div>
      </div>

      ${
        diary
          ? html`<div class="card" style="margin-bottom:14px">
              <h3>The diary as evidence</h3>
              <p class="metric-sub" style="margin-bottom:12px">
                A delay claim stands on an unbroken contemporaneous record. What decides whether it is one is
                the days with no entry and the entries written long after the event — both invisible reading it a day at a time.
              </p>
              <div class="grid g4" style="margin-bottom:11px">
                <div><div class="metric ${raw(diary.missingDates.length === 0 ? 'good' : 'warn')}">${diary.recorded}<span style="font-size:16px;color:var(--text-3)"> / ${diary.daysInWindow}</span></div><div class="metric-sub">working days recorded</div></div>
                <div><div class="metric ${raw(diary.lateEntries.length === 0 ? '' : 'warn')}">${diary.lateEntries.length}</div><div class="metric-sub">written after the event</div></div>
                <div><div class="metric">${diary.weatherDaysLost}</div><div class="metric-sub">days weather stopped work</div></div>
                <div><div class="metric">${diary.blockedDays.length}</div><div class="metric-sub">days a blocker was recorded</div></div>
              </div>
              <div class="notice ${raw(diary.missingDates.length === 0 ? 'ok' : 'warn')}">${diary.completeness}</div>
              ${
                diary.missingDates.length > 0
                  ? html`<div class="metric-sub" style="margin-top:9px">No entry: ${diary.missingDates.slice(0, 12).map((d) => date(d)).join(' · ')}${diary.missingDates.length > 12 ? ` and ${diary.missingDates.length - 12} more` : ''}</div>`
                  : ''
              }
              ${
                diary.lateEntries.length > 0
                  ? html`<div class="metric-sub" style="margin-top:6px">Written late: ${diary.lateEntries.slice(0, 8).map((e) => `${date(e.diaryDate)} (+${e.daysLate}d)`).join(' · ')}</div>`
                  : ''
              }
            </div>`
          : ''
      }

      <div class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h3>Activities complete</h3>
          <div class="metric good">${complete.length}<span style="font-size:16px;color:var(--text-3)"> / ${b.Task.length}</span></div>
          <div class="metric-sub">${pct(coverage, 0)} of activities carry a measurement</div>
        </div>
        <div class="card">
          <h3>Progress records</h3>
          <div class="metric orange">${b.ProgressMeasurement.length}</div>
          <div class="metric-sub">each one evidenced before it was accepted</div>
        </div>
        <div class="card">
          <h3>Open snags</h3>
          <div class="metric ${raw(openSnags.length > 0 ? 'warn' : 'good')}">${openSnags.length}</div>
          <div class="metric-sub">${dispatched.length} dispatched to trade</div>
        </div>
        <div class="card">
          <h3>Evidence items</h3>
          <div class="metric">${b.EvidenceItem.length}</div>
          <div class="metric-sub">hashed and linked to the events that rely on them</div>
        </div>
      </div>

      ${
        openConstraints.length > 0
          ? html`<div class="notice warn">
              <div><b>${openConstraints.length} open constraint(s).</b><br>
              Unresolved constraints on critical activities are the cheapest delay to recover — escalation costs almost nothing.</div>
            </div>`
          : ''
      }

      <div class="grid g-2-1" style="margin-bottom:14px">
        <div class="card pad0">
          <h3 style="padding:15px 17px 0">Progress by activity</h3>
          ${table({
            headers: ['Activity', 'Planned', 'Elapsed', 'Complete', 'Slippage'],
            align: ['', 'num', 'num', '', 'num'],
            rows: b.Task.map((t) => [
              t.name,
              days(t.durationDays),
              t.elapsedDays ? days(t.elapsedDays) : '—',
              track(t.percentComplete ?? 0, Number(t.percentComplete ?? 0) >= 100 ? 'good' : ''),
              Number(t.slippageDays ?? 0) > 0 ? badge(days(t.slippageDays), 'bad') : '—',
            ]),
            empty: 'No activities',
          })}
        </div>

        <div>
          <div class="card" style="margin-bottom:14px">
            <h3>Snag dispatch by cost code</h3>
            ${
              byTrade.size === 0
                ? html`<div class="empty"><b>Nothing outstanding</b>No open snags to route.</div>`
                : html`<div class="split-list">
                    ${[...byTrade.entries()].map(
                      ([key, count]) => html`<div class="row"><span class="lbl">${key}</span><span class="val">${count}</span></div>`,
                    )}
                  </div>
                  <div class="metric-sub" style="margin-top:9px">Routing by cost code is what turns a snag list into work someone actually owns.</div>`
            }
          </div>

          <div class="card">
            <h3>Quality &amp; commissioning</h3>
            <div class="split-list">
              <div class="row"><span class="lbl">Inspections</span><span class="val">${b.QualityInspection.length}</span></div>
              <div class="row"><span class="lbl">Non-conformances</span><span class="val">${b.NCR.length}</span></div>
              <div class="row"><span class="lbl">Commissioning tests</span><span class="val">${b.CommissioningTest.length}</span></div>
              <div class="row"><span class="lbl">Accepted</span><span class="val">${b.CommissioningTest.filter((t) => t.status === 'ACCEPTED').length}</span></div>
            </div>
          </div>
        </div>
      </div>

      <div class="grid g2">
        <div class="card pad0">
          <h3 style="padding:15px 17px 0">Snag register</h3>
          ${table({
            headers: ['Ref', 'Location', 'Description', 'Trade', 'Status'],
            rows: b.Snag.map((s) => [
              s.reference,
              s.location,
              s.description,
              s.responsibleTrade,
              badge(humanise(s.status), statusTone(s.status)),
            ]),
            empty: 'No snags raised',
          })}
        </div>

        <div class="card pad0">
          <h3 style="padding:15px 17px 0">Evidence register</h3>
          ${table({
            headers: ['Type', 'Description', 'Captured', 'Hash'],
            align: ['', '', '', 'mono'],
            rows: b.EvidenceItem.slice(-12)
              .reverse()
              .map((e) => [humanise(e.type), String(e.description).slice(0, 52), time(e.capturedAt), String(e.hash).slice(7, 19) + '…']),
            empty: 'No evidence registered',
          })}
        </div>
      </div>
    `,
  );

  // --- commands -------------------------------------------------------------

  const COMMANDS = {
    progress: {
      title: 'Record progress',
      intent: 'Progress is not accepted without evidence, and it cannot go backwards.',
      path: `/v1/projects/${projectId}/progress`,
      submitLabel: 'Record',
      fields: [
        { name: 'taskId', label: 'Activity', type: 'select', options: b.Task.map((t) => ({ value: t._refId, label: `${t.activityCode} · ${t.name}` })) },
        { name: 'percentComplete', label: 'Percent complete', type: 'number', min: 0, hint: 'Cannot be lower than the value already recorded' },
        { name: 'elapsedDays', label: 'Elapsed days', type: 'number', min: 0 },
        { name: 'quantityComplete', label: 'Quantity complete', type: 'number', required: false },
        { name: 'evidenceDescription', label: 'What the evidence shows', type: 'text', placeholder: 'Survey, photograph, measurement sheet…' },
        { name: 'evidenceHash', label: 'Evidence file', type: 'file', hint: 'Hashed in your browser; the platform records the hash, not the file' },
      ],
    },
    observation: {
      title: 'Log safety observation',
      intent: 'Severity is assessed from the description against the hazard library, not chosen by the reporter.',
      path: `/v1/projects/${projectId}/safety/observations`,
      aiCost: true,
      submitLabel: 'Log',
      fields: [
        { name: 'observationType', label: 'Type', type: 'select', options: OBSERVATION_TYPE },
        { name: 'location', label: 'Location', type: 'text', placeholder: 'Zone 2, north face' },
        { name: 'description', label: 'What was observed', type: 'textarea' },
        { name: 'reportedBy', label: 'Reported by', type: 'text', value: state.session.user.name },
        { name: 'mediaHash', label: 'Photograph or video', type: 'file' },
      ],
    },
    'work-order': {
      title: 'Raise work order',
      intent: 'Routed by cost code, so the work lands with whoever owns it.',
      path: `/v1/projects/${projectId}/work-orders`,
      submitLabel: 'Raise',
      fields: [
        { name: 'title', label: 'Title', type: 'text' },
        { name: 'description', label: 'Scope of the work', type: 'textarea' },
        { name: 'costCode', label: 'Cost code', type: 'text', placeholder: 'CIV.003' },
        { name: 'priority', label: 'Priority', type: 'select', options: [
          { value: 'ROUTINE', label: 'Routine' },
          { value: 'URGENT', label: 'Urgent' },
          { value: 'EMERGENCY', label: 'Emergency' },
        ] },
      ],
    },
  };

  root.querySelector('.cmd-bar')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    const spec = COMMANDS[button.dataset.command];
    if (!spec) return;
    const result = await command(spec);
    if (result) await draw();
  });

  // The daily record used to be a progress measurement with the shift's
  // conditions flattened into a free-text evidence description, because there
  // was no diary to write. There is now, so labour, plant and weather are
  // structured facts the delay engine and the control standard can read rather
  // than a sentence nobody can query.
  root.querySelector('#daily')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const note = root.querySelector('#daily-note');
    const data = Object.fromEntries(new FormData(form).entries());

    note.textContent = '';
    const stopped = data.workingStopped === 'true';

    await command({
      title: 'Daily site diary',
      intent:
        'The contemporaneous record a delay claim stands on. Its weight depends on when it was written, so the platform records that too — an entry written weeks later is marked as what it is.',
      path: `/v1/projects/${projectId}/site-diary`,
      submitLabel: 'Record the day',
      fields: [
        { name: 'diaryDate', label: 'Date', type: 'hidden', value: data.diaryDate },
        { name: 'progressNarrative', label: 'What the site did today', type: 'textarea' },
        { name: 'blockers', label: 'Anything that stopped or slowed work', type: 'text', required: false,
          hint: 'One per line. These become the delay evidence.' },
        { name: 'deliveries', label: 'Deliveries', type: 'text', required: false },
        { name: 'visitors', label: 'Visitors and inspections', type: 'text', required: false },
        { name: 'evidenceHash', label: 'Signed day sheet or photographs', type: 'file' },
      ],
      transform: (collected) => ({
        diaryDate: data.diaryDate,
        weather: {
          conditions: humanise(String(data.weather)),
          workingStopped: stopped,
          ...(Number(data.hoursLost) > 0 ? { hoursLost: Number(data.hoursLost) } : {}),
        },
        labour: data.trade ? [{ trade: String(data.trade), headcount: Number(data.headcount || 0), hours: Number(data.hours || 0) }] : [],
        plant: data.plantDescription
          ? [{ description: String(data.plantDescription), hoursWorked: Number(data.plantHours || 0), hoursIdle: Number(data.plantIdle || 0) }]
          : [],
        progressNarrative: collected.progressNarrative,
        // A blank line is not a blocker. Splitting and filtering keeps empty
        // strings out of a list a claim would later be built from.
        blockers: String(collected.blockers ?? '').split('\n').map((s) => s.trim()).filter(Boolean),
        deliveries: String(collected.deliveries ?? '').split('\n').map((s) => s.trim()).filter(Boolean),
        visitors: String(collected.visitors ?? '').split('\n').map((s) => s.trim()).filter(Boolean),
        evidenceHash: collected.evidenceHash,
      }),
    }).then((result) => {
      if (result) {
        if (result.contemporaneous === false) {
          note.textContent = `Recorded, and marked as written ${result.daysLate} days after the event. A late entry carries less weight than one written on the day, so the record says so.`;
        }
        void draw();
      }
    });
  });
}
