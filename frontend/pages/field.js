import { api, entityBundle, hashFile } from '../lib/api.js';
import { command, commandBar } from '../lib/command.js';
import { OBSERVATION_TYPE, SITE_OBSERVATION_CATEGORY, WEATHER_CONDITION, today } from '../lib/enums.js';
import { badge, date, days, drillable, html, humanise, pct, raw, render, statusTone, table, time, toast, track } from '../lib/ui.js';
import { insightPanel } from '../lib/insight.js';
import * as outbox from '../lib/outbox.js';
import { recordVoice, recordingDescription, voiceSupport } from '../lib/voice.js';
import { blockedReason, can, draw, state } from '../app.js';

/**
 * Field Execution.
 *
 * What the site actually did, and the evidence for it. Progress without
 * evidence is not accepted by the platform, so everything on this screen has a
 * hashed record behind it.
 */

/**
 * Two records of the same thing, and what the platform did about it.
 *
 * The sync engine has to pick a side at push time — the handset is waiting on a
 * bad connection and cannot be asked — and it picks well: safety stops hold,
 * progress does not go backwards, edits to different fields merge. But every
 * pick discards somebody's work, and a pick reported only in the sync response
 * is invisible the moment the handset drops it.
 *
 * So this is the queue that outlives the connection. The ones worth acting on
 * are the ones where the site's record was thrown away: a supervisor's figure
 * refused for regression is work that was done and is not in the platform.
 * A merge is here to be confirmed, not rescued.
 */
/**
 * The four tasks that read a site photograph, and where each one lands.
 *
 * The label is the console's; the authority is not. The
 * capability endpoint publishes the area and code each task requires — which is
 * exactly what the domain command it feeds requires — so a control nobody can
 * use is not offered rather than offered and refused.
 */
const VISION_TASKS = [
  {
    task: 'PROGRESS_FROM_IMAGES',
    label: 'Progress',
    lands: 'a progress claim against an activity, for a period, which somebody else certifies',
  },
  { task: 'PPE_COMPLIANCE', label: 'PPE', lands: 'a safety observation, for a person to close out' },
  {
    task: 'EQUIPMENT_RECOGNITION',
    label: 'Plant',
    lands: 'a site observation naming the plant and whether it was standing',
  },
  { task: 'DEFECT_DETECTION', label: 'Defects', lands: 'one NCR per defect, each closed on its own' },
];

/**
 * Reading a site photograph.
 *
 * Progress estimation, PPE compliance, plant recognition and defect detection
 * were specified as a separate vision pipeline; they are four more tasks on the
 * pipeline that already reads drawings and voice notes, because everything a
 * vision pipeline needs was already in it.
 *
 * The panel exists to make two things visible at the point of use. First, that
 * nothing read here is filed: an extraction is a draft, and confirming it runs
 * the ordinary command with the ordinary rules — the unit checked against the
 * measurement basis, the severity checked against the NCR register's own three
 * words. Second, that where no provider on this deployment can see a file,
 * nothing is read at all rather than read badly.
 */
function visionPanel(perception, photographs, storeConfigured) {
  if (!perception) return '';

  const available = perception.capability?.available === true;
  const published = new Map((perception.capability?.tasks ?? []).map((entry) => [entry.task, entry]));
  const usable = VISION_TASKS.filter((entry) => {
    const declared = published.get(entry.task);
    return declared && can(declared.area, declared.code);
  });
  const drafts = (perception.drafts ?? []).filter(
    (draft) => draft.status === 'DRAFT' && VISION_TASKS.some((entry) => entry.task === draft.task),
  );

  if (usable.length === 0 && drafts.length === 0) return '';

  return html`<div class="card pad0" style="margin-bottom:14px">
    <div style="padding:15px 17px 0">
      <h2>Read a site photograph</h2>
      <p class="metric-sub" style="margin-bottom:12px">
        ${usable.map((entry) => `${entry.label} — ${entry.lands}`).join('. ')}.
        Nothing read this way is filed on its own: an extraction is a draft until somebody confirms it, and confirming
        runs the same command as typing it in, with the same rules.
      </p>
      ${available
        ? ''
        : html`<div class="notice warn" style="margin-bottom:12px">
            <div>
              <b>Not available on this deployment.</b><br />${perception.capability?.reason ?? ''} A photograph is not
              read here at all, rather than read badly and claimed against.
            </div>
          </div>`}
    </div>
    ${available && usable.length > 0
      ? table({
          headers: ['Photograph', 'Taken', 'Read for'],
          rows: photographs.slice(0, 10).map((entry) => [
            entry.description,
            date(entry.capturedAt),
            html`${usable.map(
              (task) =>
                html`<button class="btn quiet sm" data-vision="${task.task}" data-hash="${entry.hash}">
                  ${task.label}
                </button> `,
            )}`,
          ]),
          empty: storeConfigured
            ? 'No photographs are held on this project yet. A hash on its own cannot be read.'
            : 'This deployment holds no evidence files, so there is nothing to read.',
        })
      : ''}
    ${drafts.length > 0
      ? html`<div style="padding:0 17px 15px">
          <h2 style="margin-top:14px">Awaiting confirmation</h2>
          ${table({
            headers: ['Read', 'What it says', 'Confidence', ''],
            rows: drafts.map((draft) => [
              humanise(draft.task),
              visionSummary(draft),
              draft.confidence !== undefined && draft.confidence !== null ? pct(draft.confidence * 100, 0) : '—',
              html`<button class="btn sm" data-vision-confirm="${draft.id}">Review</button>
                <button class="btn quiet sm" data-vision-discard="${draft.id}">Reject</button>`,
            ]),
          })}
        </div>`
      : ''}
  </div>`;
}

/** One line saying what a draft found, in the terms of the register it feeds. */
function visionSummary(draft) {
  const extraction = draft.extraction ?? {};
  if (draft.task === 'PROGRESS_FROM_IMAGES') {
    const items = extraction.items ?? [];
    return items.length === 0
      ? 'nothing measurable'
      : `${items[0].quantity} ${items[0].unit} — ${items[0].description}${items.length > 1 ? ` (+${items.length - 1} more)` : ''}`;
  }
  if (draft.task === 'PPE_COMPLIANCE') {
    const breaches = extraction.breaches ?? [];
    return breaches.length === 0
      ? 'compliant — no breach reported'
      : `${breaches.length} breach(es): ${breaches.map((breach) => breach.item).join(', ')}`;
  }
  if (draft.task === 'EQUIPMENT_RECOGNITION') {
    const items = extraction.items ?? [];
    return items.map((item) => `${item.count} × ${item.description} (${humanise(item.state)})`).join('; ');
  }
  const defects = extraction.defects ?? [];
  return defects.map((defect) => `${defect.severity}: ${defect.description}`).join(' · ');
}

function conflictPanel(position) {
  if (!position || position.conflicts.length === 0) return '';

  const open = position.conflicts.filter((entry) => entry.status === 'OPEN');
  if (open.length === 0) return '';

  const mayDecide = can('FIELD_EXECUTION', 'A');
  const lost = (entry) => entry.autoResolution === 'SERVER_WINS' || entry.autoResolution === 'REJECTED';

  return html`<div id="sync-conflicts" style="margin-bottom:14px">
    <div class="card" style="margin-bottom:${raw(mayDecide ? '12px' : '0')}">
      <h2>Two records of the same thing</h2>
      <p class="metric-sub" style="margin:8px 0 12px">
        The handset and the platform both had a version, and the engine had to pick one with nobody to ask.
        ${position.workLost > 0
          ? html`<b>${position.workLost} of these threw away what the site recorded.</b> That work was done; it is not
              in the platform until somebody says it should be.`
          : 'None of these discarded a site record outright — each one committed something and wants confirming.'}
      </p>
      <div class="split-list">
        <div class="row"><span class="lbl">Site record discarded</span><span class="val">${position.workLost}</span></div>
        <div class="row"><span class="lbl">Merged, awaiting confirmation</span><span class="val">${position.merged}</span></div>
        <div class="row"><span class="lbl">Already decided</span><span class="val">${position.resolved}</span></div>
        ${position.oldestOpenAt
          ? html`<div class="row"><span class="lbl">Oldest still open</span><span class="val">${time(position.oldestOpenAt)}</span></div>`
          : ''}
      </div>
      ${mayDecide
        ? ''
        : html`<div class="metric-sub" style="margin-top:12px">
            ${blockedReason('FIELD_EXECUTION', 'A') ?? 'Deciding between two site records is not yours to do.'}
          </div>`}
    </div>

    ${!mayDecide
      ? ''
      : open.map(
          (entry) => html`<div class="card proposal" data-conflict="${entry.conflictId}" style="margin-bottom:12px">
            <div style="display:flex;gap:11px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
              ${badge(humanise(entry.reason), lost(entry) ? 'bad' : 'warn')}
              ${badge(humanise(entry.autoResolution), 'neutral')}
              ${badge(`${humanise(entry.subject.refType)} ${String(entry.subject.refId).slice(-6)}`, '')}
              <div class="metric-sub" style="margin-left:auto">
                ${entry.deviceId} · captured ${time(entry.deviceTimestamp)}
              </div>
            </div>

            <div style="font-size:14.5px;font-weight:650;margin-bottom:6px">${entry.message}</div>
            <div class="metric-sub" style="margin-bottom:12px">
              ${lost(entry)
                ? 'The handset’s version was not applied. Applying it now writes it as you.'
                : 'The handset’s version was applied. Keeping the server’s version is no longer possible without a new record.'}
              ${entry.mergedFields.length > 0
                ? ` Fields taken from the handset: ${entry.mergedFields.join(', ')}.`
                : ''}
            </div>

            <div class="cmd-error" hidden></div>

            <div class="input-zone">
              <div class="field">
                <label for="why-${entry.conflictId}">Reason</label>
                <input id="why-${entry.conflictId}" name="why" type="text"
                  placeholder="Why this version and not the other">
              </div>
              <div class="actions">
                ${lost(entry)
                  ? html`<button class="btn" data-decide="APPLIED_DEVICE">Apply the site’s record</button>`
                  : ''}
                <button class="btn quiet" data-decide="KEPT_SERVER">Confirm what the platform holds</button>
              </div>
            </div>
          </div>`,
        )}
  </div>`;
}

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

  // The walk register ordered by what is overdue. Sorted by date, the one that
  // matters is the one furthest down.
  const walk = await api.get(`/v1/projects/${projectId}/observations/position`).catch(() => null);

  // Whether this deployment can actually transcribe. A recording is worth
  // filing either way — it is what a delay claim is argued from — but the
  // screen must not imply a transcript is coming when no provider can produce
  // one.
  const perception = await api.get(`/v1/projects/${projectId}/perception`).catch(() => null);

  // The photographs this project already holds. A vision task reads a file the
  // platform has, so the register is the list of what can be read — the same
  // approach the design screen takes with drawings, rather than a second upload
  // path into the evidence store.
  const evidence = await api.get(`/v1/projects/${projectId}/evidence`).catch(() => null);
  const photographs = (evidence?.entries ?? []).filter(
    (entry) => entry.held && String(entry.contentType ?? '').startsWith('image/'),
  );

  // Days earned against days spent. The arithmetic already existed inside the
  // delay forecast, where nothing could read it on its own.
  const productivity = await api.get(`/v1/projects/${projectId}/productivity`).catch(() => null);

  // The site visit: findings that outlive the walk. Not the same thing as the
  // observation register above — an observation is about the state of the work
  // and closes next week, a finding is about the state of the site and governs
  // the job until handover.
  const site = await api.get(`/v1/projects/${projectId}/site-visits`).catch(() => null);

  // What this handset is still holding. The outbox retries on its own, but a
  // file whose operation the platform rejected outright waits for a record that
  // will never exist — and until this screen there was nothing that could tell
  // anybody a photograph was sitting on a phone rather than in the record.
  const carrying = await outbox.pendingFiles().catch(() => []);

  // Conflicts the sync engine resolved on its own. Every resolution has a
  // losing side, and until these were recorded the only trace of a discarded
  // site record was a line in a response the handset may never have received.
  const conflicts = await api.get(`/v1/projects/${projectId}/sync/conflicts`).catch(() => null);
  const openObservations = b.SiteObservation.filter((o) => o.status === 'OPEN');

  const measured = b.Task.filter((t) => Number(t.percentComplete ?? 0) > 0);
  const complete = b.Task.filter((t) => Number(t.percentComplete ?? 0) >= 100);
  const openSnags = b.Snag.filter((s) => s.status !== 'CLOSED');
  const dispatched = b.Snag.filter((s) => s.status === 'DISPATCHED');
  const openConstraints = b.Constraint.filter((c) => c.status !== 'CLOSED');

  const coverage = b.Task.length === 0 ? 0 : (measured.length / b.Task.length) * 100;

  // The records behind each figure. Evidence is capped: a mature project holds
  // thousands of items and a drill listing all of them answers nothing, so the
  // most recent are named and the tile says how many it stands for.
  const taskSources = b.Task.map((t) => ({ refType: 'Task', refId: t._refId }));
  const progressSources = b.ProgressMeasurement.map((m) => ({ refType: 'ProgressMeasurement', refId: m._refId }));
  const snagSources = openSnags.map((snag) => ({ refType: 'Snag', refId: snag._refId }));
  const evidenceSources = b.EvidenceItem.slice(-40).map((e) => ({ refType: 'EvidenceItem', refId: e._refId }));

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
              // First, and the only one carrying the accent. The specification
              // calls voice-first an adoption requirement rather than a
              // convenience, and a button placed fifth is a convenience.
              { id: 'dictate', label: 'Walk and record', permitted: can('FIELD_EXECUTION', 'C'), reason: blockedReason('FIELD_EXECUTION', 'C') },
              { id: 'progress', label: 'Record progress', tone: '', permitted: can('FIELD_EXECUTION', 'C'), reason: blockedReason('FIELD_EXECUTION', 'C') },
              { id: 'observation', label: 'Log safety observation', permitted: can('SAFETY_RAMS', 'C'), reason: blockedReason('SAFETY_RAMS', 'C') },
              { id: 'work-order', label: 'Raise work order', permitted: can('FIELD_EXECUTION', 'C'), reason: blockedReason('FIELD_EXECUTION', 'C') },
              { id: 'walk', label: 'Log site observation', permitted: can('FIELD_EXECUTION', 'C'), reason: blockedReason('FIELD_EXECUTION', 'C') },
              { id: 'close-walk', label: 'Close an observation', permitted: can('FIELD_EXECUTION', 'U'), reason: blockedReason('FIELD_EXECUTION', 'U') },
              // The site visit sits under LOOKAHEAD_CONSTRAINTS rather than
              // FIELD_EXECUTION: a pre-construction walk happens before the
              // phase that gates field work opens, and gating it there would
              // lock the one screen somebody needs before they mobilise.
              { id: 'site-visit', label: 'Record a site visit', permitted: can('LOOKAHEAD_CONSTRAINTS', 'C'), reason: blockedReason('LOOKAHEAD_CONSTRAINTS', 'C') },
              { id: 'finding', label: 'Raise a site finding', permitted: can('LOOKAHEAD_CONSTRAINTS', 'C'), reason: blockedReason('LOOKAHEAD_CONSTRAINTS', 'C') },
              { id: 'discharge', label: 'Discharge a finding', permitted: can('LOOKAHEAD_CONSTRAINTS', 'U'), reason: blockedReason('LOOKAHEAD_CONSTRAINTS', 'U') },
              { id: 'logistics', label: 'Set the logistics plan', permitted: can('LOOKAHEAD_CONSTRAINTS', 'C'), reason: blockedReason('LOOKAHEAD_CONSTRAINTS', 'C') },
            ]),
          )}
        </div>
      </div>

      ${
        carrying.length === 0
          ? ''
          : html`<div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">On this device, not yet on the platform</h2>
              <div style="padding:8px 17px 0"><div class="metric-sub">
                ${carrying.length} file${carrying.length === 1 ? '' : 's'} captured here and still waiting.
                The outbox retries whenever this device is online and the record that names a file has to land
                before its bytes can, so most of these clear on their own. One does not: a file whose record the
                platform refused waits for something that will never arrive, and only a person can decide to let
                it go.
              </div></div>
              ${table({
                headers: ['File', 'Type', 'Captured', 'Address', ''],
                align: ['', '', '', 'mono', ''],
                rows: carrying.map((file) => [
                  file.name || 'Unnamed capture',
                  file.type || 'unknown',
                  time(file.queuedAt),
                  // The hash, shortened. It is what the record will name, so it
                  // is the one value that identifies this file anywhere else.
                  `${String(file.hash).slice(7, 19)}…`,
                  html`<button class="btn quiet" data-discard="${file.hash}">Discard</button>`,
                ]),
              })}
            </div>`
      }

      ${conflictPanel(conflicts)}

      ${visionPanel(perception, photographs, evidence?.storeConfigured === true)}

      <div class="card" style="margin-bottom:14px">
        <h2>Daily site record</h2>
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
              <h2>The diary as evidence</h2>
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
        <div ${raw(drillable('Activities complete', taskSources))}>
          <h2>Activities complete</h2>
          <div class="metric good">${complete.length}<span style="font-size:16px;color:var(--text-3)"> / ${b.Task.length}</span></div>
          <div class="metric-sub">${pct(coverage, 0)} of activities carry a measurement</div>
        </div>
        <div ${raw(drillable('Progress records', progressSources))}>
          <h2>Progress records</h2>
          <div class="metric orange">${b.ProgressMeasurement.length}</div>
          <div class="metric-sub">each one evidenced before it was accepted</div>
        </div>
        <div ${raw(drillable('Open snags', snagSources))}>
          <h2>Open snags</h2>
          <div class="metric ${raw(openSnags.length > 0 ? 'warn' : 'good')}">${openSnags.length}</div>
          <div class="metric-sub">${dispatched.length} dispatched to trade</div>
        </div>
        <div ${raw(drillable('Evidence items', evidenceSources))}>
          <h2>Evidence items</h2>
          <div class="metric">${b.EvidenceItem.length}</div>
          <div class="metric-sub">hashed and linked to the events that rely on them</div>
        </div>
      </div>

      <div id="field-insight" style="margin-bottom:14px"></div>

      ${
        openConstraints.length > 0
          ? html`<div class="notice warn">
              <div><b>${openConstraints.length} open constraint(s).</b><br>
              Unresolved constraints on critical activities are the cheapest delay to recover — escalation costs almost nothing.</div>
            </div>`
          : ''
      }

      ${
        walk && walk.overdue.length > 0
          ? html`<div class="notice warn">
              <div><b>${walk.overdue.length} site observation(s) past the date somebody agreed to deal with them.</b><br>
              ${walk.overdue[0].reference} — ${walk.overdue[0].description} · ${walk.overdue[0].actionOwner ?? 'unowned'},
              ${walk.overdue[0].daysOverdue} days over.</div>
            </div>`
          : ''
      }

      <div class="grid g-2-1" style="margin-bottom:14px">
        <div class="card pad0">
          <h2 style="padding:15px 17px 0">Progress by activity</h2>
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
            <h2>Snag dispatch by cost code</h2>
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
            <h2>Quality &amp; commissioning</h2>
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
          <h2 style="padding:15px 17px 0">Snag register</h2>
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
          <h2 style="padding:15px 17px 0">Site walk</h2>
          ${table({
            headers: ['Ref', 'Category', 'What was seen', 'Owner', 'By', 'Status'],
            rows: b.SiteObservation.map((o) => [
              o.reference,
              badge(humanise(o.category), 'neutral'),
              String(o.description).slice(0, 54) + (String(o.description).length > 54 ? '…' : ''),
              o.actionOwner ?? '—',
              o.actionByDate ? date(o.actionByDate) : '—',
              o.status === 'CLOSED'
                ? badge(o.closedLate ? `closed ${o.daysOpen}d — late` : `closed ${o.daysOpen}d`, o.closedLate ? 'warn' : 'ok')
                : badge(humanise(o.status), statusTone(o.status)),
            ]),
            empty: 'No site walk recorded',
          })}
          ${walk ? html`<div class="metric-sub" style="padding:0 17px 15px">${walk.summary}</div>` : ''}
        </div>
      </div>

      ${
        site
          ? html`
            <div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">
                Site visit — what the walk still obliges
                ${site.latePermits.length > 0 ? badge(`${site.latePermits.length} late`, 'bad') : ''}
              </h2>
              <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
                ${site.summary} A finding is not closed when the visit ends — it is closed when the thing it obliged has
                been done, and some of them are not done until handover.
              </p>

              ${
                site.latePermits.length > 0
                  ? html`<div class="notice bad" style="margin:12px 17px">
                      <div>
                        <b>Permissions that cannot arrive in time</b>
                        ${site.latePermits.map(
                          (p) => html`<div style="margin-top:6px">${p.name} — ${p.authority}. ${p.note}</div>`,
                        )}
                      </div>
                    </div>`
                  : ''
              }

              ${table({
                headers: ['Ref', 'Category', 'What was found', 'Where', 'Obliges', 'Discharged by', 'Owner', 'Photo', 'Status'],
                rows: site.findings.map((f) => [
                  html`${f.reference}${f.constraintReference ? badge(f.constraintReference, 'info') : ''}`,
                  badge(humanise(f.category), 'neutral'),
                  String(f.description).slice(0, 60) + (String(f.description).length > 60 ? '…' : ''),
                  f.location,
                  f.consequences.map((c) => humanise(c)).join(', '),
                  badge(humanise(f.closesBy), f.closesBy === 'HANDOVER' ? 'warn' : ''),
                  f.owner,
                  f.hasPhotograph ? '📷' : badge(humanise(f.basis), ''),
                  f.status === 'CLOSED' ? badge(`discharged ${f.daysOpen ?? 0}d`, 'ok') : badge('open', 'warn'),
                ]),
                empty: 'No site visit recorded',
              })}

              ${
                site.logistics
                  ? html`<div style="padding:0 17px 4px">
                      <h2 style="margin-top:12px">Logistics plan, version ${site.logistics.version}</h2>
                      ${
                        site.logistics.warnings.length === 0
                          ? html`<div class="metric-sub">Every check the platform can settle by arithmetic passes.</div>`
                          : html`<div class="split-list">
                              ${site.logistics.warnings.map(
                                (w) => html`<div class="row">
                                  <span class="lbl">${badge(humanise(w.severity), w.severity === 'CRITICAL' ? 'bad' : 'warn')} ${w.subject}</span>
                                  <span class="val" style="font-size:12px;color:var(--text-3)">${w.detail}</span>
                                </div>`,
                              )}
                            </div>`
                      }
                    </div>`
                  : ''
              }

              ${
                site.visits.length > 0
                  ? html`<div style="padding:8px 17px 15px">
                      <div class="split-list">
                        ${site.visits.map(
                          (v) => html`<div class="row">
                            <span class="lbl">${v.reference} · ${humanise(v.purpose)} · ${date(v.visitedOn)} · ${v.attendees.join(', ')}</span>
                            <span class="val">
                              ${v.findings} finding${v.findings === 1 ? '' : 's'}
                              <button class="btn quiet sm" data-report="${raw(v.reference)}">Report</button>
                            </span>
                          </div>`,
                        )}
                      </div>
                    </div>`
                  : ''
              }
            </div>`
          : ''
      }

      <div class="grid g2">
        <div class="card pad0">
          <h2 style="padding:15px 17px 0">Evidence register</h2>
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

      ${
        productivity
          ? html`<div class="card pad0" style="margin-top:14px">
              <div style="padding:15px 17px 0">
                <h2>Productivity against plan</h2>
                <p class="metric-sub" style="margin-bottom:12px">
                  Days earned over days spent. Below 1.0 an activity is taking longer than the work done justifies —
                  which is a different fact from being behind, and the one that says whether it will catch up.
                  ${productivity.summary}
                </p>
                ${
                  productivity.projectFactor !== null
                    ? html`<div class="grid g4" style="margin:0 17px 12px">
                        <div>
                          <div class="metric-sub">Project</div>
                          <div class="metric ${raw(productivity.projectFactor < 1 ? 'bad' : 'good')}">
                            ${productivity.projectFactor.toFixed(2)}
                          </div>
                          <div class="metric-sub">weighted by planned duration</div>
                        </div>
                        <div>
                          <div class="metric-sub">Measured</div>
                          <div class="metric">${productivity.measured}</div>
                          <div class="metric-sub">${productivity.notStarted} not started</div>
                        </div>
                        <div>
                          <div class="metric-sub">Days earned</div>
                          <div class="metric">${productivity.earnedDays}</div>
                          <div class="metric-sub">against ${productivity.elapsedDays} spent</div>
                        </div>
                        <div>
                          <div class="metric-sub">Unmeasurable</div>
                          <div class="metric ${raw(productivity.unmeasurable.length > 0 ? 'warn' : 'good')}">
                            ${productivity.unmeasurable.length}
                          </div>
                          <div class="metric-sub">progress recorded without the days it took</div>
                        </div>
                      </div>`
                    : ''
                }
                ${
                  productivity.unmeasurable.length > 0
                    ? html`<div class="notice warn" style="margin:0 17px 12px">
                        <div><b>${productivity.unmeasurable.length} activity(ies) record progress against no elapsed time.</b><br>
                        That is a data fault rather than infinite productivity, so ${productivity.unmeasurable.length === 1 ? 'it is' : 'they are'} excluded and named:
                        ${productivity.unmeasurable.map((entry) => entry.taskName).join(', ')}.</div>
                      </div>`
                    : ''
                }
              </div>
              ${table({
                headers: ['Activity', 'Planned', 'Complete', 'Elapsed', 'Earned', 'Factor', 'On critical path'],
                align: ['', 'num', 'num', 'num', 'num', 'num', ''],
                rows: productivity.activities.slice(0, 15).map((a) => [
                  a.taskName,
                  `${a.plannedDays}d`,
                  pct(a.percentComplete),
                  `${a.elapsedDays}d`,
                  `${a.earnedDays}d`,
                  badge(a.factor.toFixed(2), a.factor < 0.9 ? 'bad' : a.factor < 1 ? 'warn' : 'good'),
                  a.onCriticalPath ? badge('critical', 'bad') : '—',
                ]),
                empty: 'Nothing has both progress and elapsed time recorded against it.',
              })}
            </div>`
          : ''
      }
    `,
  );

  // --- commands -------------------------------------------------------------

  // The site visit vocabularies. Held here rather than fetched because the route
  // schemas validate against the same closed lists on the server — a value the
  // browser offers that the API refuses is caught by the console-forms test.
  const opts = (values) => values.map((v) => ({ value: v, label: humanise(v) }));
  const VISIT_PURPOSE = ['PRE_CONSTRUCTION', 'MOBILISATION', 'PROGRESS', 'PRE_HANDOVER'];
  const FINDING_CATEGORY = [
    'ACCESS_AND_EGRESS', 'TRAFFIC_AND_HIGHWAYS', 'GROUND_CONDITIONS', 'EXISTING_SERVICES',
    'OVERHEAD_SERVICES', 'BOUNDARIES_AND_NEIGHBOURS', 'ENVIRONMENT_AND_ECOLOGY', 'EXISTING_STRUCTURES',
    'SITE_ESTABLISHMENT', 'SECURITY', 'UTILITIES_AND_CONNECTIONS', 'WORKING_HOURS_AND_NOISE',
  ];
  const FINDING_CONSEQUENCE = ['PRICES', 'SEQUENCES', 'PERMITS', 'HAZARDS', 'DESIGNS'];
  const FINDING_BASIS = ['OBSERVED', 'DOCUMENT', 'ADVISED'];
  const CLOSES_BY = ['MOBILISATION', 'CONSTRUCTION', 'COMPLETION', 'HANDOVER'];

  const openFindings = (site?.findings ?? []).filter((f) => f.status === 'OPEN');

  const COMMANDS = {
    'site-visit': {
      title: 'Record a site visit',
      intent:
        'Who walked it, when, and why. Everything found on the walk hangs off this record, and an unattributed walk ' +
        'cannot be relied on eighteen months later when somebody asks who saw the overhead line.',
      path: `/v1/projects/${projectId}/site-visits`,
      submitLabel: 'Record',
      fields: [
        { name: 'purpose', label: 'Purpose', type: 'select', options: opts(VISIT_PURPOSE) },
        { name: 'visitedOn', label: 'Walked on', type: 'date', max: today(),
          hint: 'The day it was walked, not the day it was written up' },
        { name: 'attendees', label: 'Who was there', type: 'text',
          placeholder: 'Site Manager, Planner, Client’s agent', hint: 'Comma separated' },
        { name: 'weather', label: 'Weather', type: 'text', required: false, placeholder: 'Dry, 11°C' },
        { name: 'notes', label: 'Notes', type: 'textarea', rows: 2, required: false },
      ],
      transform: (v) => ({
        purpose: v.purpose,
        visitedOn: v.visitedOn,
        attendees: String(v.attendees).split(',').map((a) => a.trim()).filter(Boolean),
        ...(v.weather ? { weather: v.weather } : {}),
        ...(v.notes ? { notes: v.notes } : {}),
      }),
    },

    finding: {
      title: 'Raise a site finding',
      intent:
        'Say what it obliges — it prices something, sequences something, needs a permission, is a hazard, or changes ' +
        'the design. A finding that obliges none of those is a note, and notes are what fill a register until nobody ' +
        'reads it. Seen on site? It needs a photograph.',
      path: (v) => `/v1/projects/${projectId}/site-visits/${v.visitId}/findings`,
      submitLabel: 'Raise',
      fields: [
        { name: 'visitId', label: 'Visit', type: 'select',
          options: (site?.visits ?? []).map((v) => ({ value: v.visitId, label: `${v.reference} · ${v.visitedOn} · ${humanise(v.purpose)}` })) },
        { name: 'category', label: 'Category', type: 'select', options: opts(FINDING_CATEGORY) },
        { name: 'description', label: 'What was found', type: 'textarea', rows: 3,
          placeholder: 'Site gate measures 3.1m between posts; a 16.5m artic cannot turn in off the main road' },
        { name: 'location', label: 'Where', type: 'text', placeholder: 'North gate, off Ashworth Road' },
        { name: 'basis', label: 'How it is known', type: 'select', options: opts(FINDING_BASIS),
          hint: 'Observed on site needs a photograph; anything else has to name its source' },
        { name: 'source', label: 'Source', type: 'text', required: false,
          placeholder: 'Planning consent 2026/00412/FUL, condition 14' },
        { name: 'consequences', label: 'What it obliges', type: 'select', options: opts(FINDING_CONSEQUENCE) },
        { name: 'closesBy', label: 'Discharged by', type: 'select', options: opts(CLOSES_BY),
          hint: 'A reinstatement is not discharged until handover, and stays on the register until it is' },
        { name: 'owner', label: 'Who carries it', type: 'text', placeholder: 'Site Manager' },
        { name: 'taskId', label: 'Activity it constrains', type: 'select', required: false,
          options: [{ value: '', label: 'None' }, ...b.Task.map((t) => ({ value: t._refId, label: `${t.activityCode} · ${t.name}` }))],
          hint: 'A finding that sequences work raises a real constraint against the activity' },
        { name: 'permitName', label: 'Permission needed', type: 'text', required: false,
          placeholder: 'Section 50 highway licence' },
        { name: 'permitAuthority', label: 'Who grants it', type: 'text', required: false },
        { name: 'permitLeadTimeDays', label: 'Lead time they quote (days)', type: 'number', required: false, min: 1 },
        { name: 'permitRequiredBy', label: 'The work it unlocks starts', type: 'date', required: false,
          hint: 'Lead time and this date are what tell you it is already late' },
        { name: 'evidenceHash', label: 'Photograph', type: 'file', required: false,
          nameInto: 'photographName',
          hint: 'Required for anything observed on site' },
      ],
      transform: (v) => ({
        category: v.category,
        description: v.description,
        location: v.location,
        basis: v.basis,
        ...(v.source ? { source: v.source } : {}),
        consequences: [v.consequences],
        closesBy: v.closesBy,
        owner: v.owner,
        ...(v.taskId ? { taskId: v.taskId } : {}),
        ...(v.evidenceHash ? { evidenceHash: v.evidenceHash } : {}),
        ...(v.permitName
          ? {
              permit: {
                name: v.permitName,
                authority: v.permitAuthority,
                leadTimeDays: Number(v.permitLeadTimeDays),
                requiredBy: v.permitRequiredBy,
              },
            }
          : {}),
      }),
    },

    discharge: {
      title: 'Discharge a finding',
      intent:
        'What actually discharged it. "Done" closes the line and answers nothing when it is asked about later. ' +
        'A finding that needed a permission or named a hazard needs the licence, the certificate or a photograph — ' +
        'and cannot be closed by whoever raised it.',
      path: (v) => `/v1/projects/${projectId}/site-findings/${v.findingId}/discharge`,
      submitLabel: 'Discharge',
      fields: [
        { name: 'findingId', label: 'Finding', type: 'select',
          options: openFindings.map((f) => ({ value: f.findingId, label: `${f.reference} · ${String(f.description).slice(0, 50)}` })) },
        { name: 'discharge', label: 'What discharged it', type: 'textarea', rows: 3,
          placeholder: 'Gate posts moved to 4.8m and the kerb radius eased; swept path re-checked against a 16.5m artic' },
        { name: 'evidenceHash', label: 'Evidence', type: 'file', required: false,
          hint: 'Required where the finding needed a permission or named a hazard' },
      ],
      transform: (v) => ({ discharge: v.discharge, ...(v.evidenceHash ? { evidenceHash: v.evidenceHash } : {}) }),
    },

    logistics: {
      title: 'Set the site logistics plan',
      intent:
        'The platform does not draw a logistics plan — a drawing is a drawing. It records the elements and the ' +
        'dimensions, and runs the checks arithmetic can settle: whether the jib crosses the boundary, whether it can ' +
        'reach the overhead line, and whether the longest delivery can actually get down the road.',
      path: `/v1/projects/${projectId}/logistics-plan`,
      submitLabel: 'Set',
      fields: [
        { name: 'elements', label: 'What is on the plan', type: 'text',
          placeholder: 'GATE, HOARDING, WELFARE, STORAGE, WHEEL_WASH',
          hint: 'Comma separated. Welfare is a legal duty from day one, so a plan without it is flagged.' },
        { name: 'craneReference', label: 'Crane', type: 'text', required: false, placeholder: 'TC1' },
        { name: 'craneType', label: 'Crane type', type: 'select', required: false,
          options: [{ value: '', label: '—' }, ...opts(['TOWER', 'MOBILE', 'CRAWLER'])] },
        { name: 'radiusMetres', label: 'Working radius (m)', type: 'number', required: false, min: 0 },
        { name: 'distanceToBoundaryMetres', label: 'Slew centre to boundary (m)', type: 'number', required: false, min: 0,
          hint: 'A radius greater than this puts the jib over the neighbour’s land' },
        { name: 'tipHeightMetres', label: 'Tip height (m)', type: 'number', required: false, min: 0 },
        { name: 'overheadDistanceMetres', label: 'Distance to overhead line (m)', type: 'number', required: false, min: 0 },
        { name: 'overheadExclusionMetres', label: 'Exclusion the network operator stated (m)', type: 'number', required: false, min: 0,
          hint: 'Their figure, not one derived from the voltage — you ask the DNO' },
        { name: 'routeReference', label: 'Access route', type: 'text', required: false, placeholder: 'R1' },
        { name: 'routeDescription', label: 'Route', type: 'text', required: false,
          placeholder: 'Ashworth Road via the railway bridge' },
        { name: 'maxVehicleLengthMetres', label: 'Route length limit (m)', type: 'number', required: false, min: 0 },
        { name: 'maxHeightMetres', label: 'Route height limit (m)', type: 'number', required: false, min: 0 },
        { name: 'maxWeightTonnes', label: 'Route weight limit (t)', type: 'number', required: false, min: 0 },
        { name: 'deliveryDescription', label: 'Largest delivery', type: 'text', required: false,
          placeholder: 'Precast stair flights' },
        { name: 'lengthMetres', label: 'Its length (m)', type: 'number', required: false, min: 0 },
        { name: 'heightMetres', label: 'Its height (m)', type: 'number', required: false, min: 0 },
        { name: 'weightTonnes', label: 'Its weight (t)', type: 'number', required: false, min: 0 },
      ],
      transform: (v) => {
        const elements = String(v.elements)
          .split(',')
          .map((token) => token.trim().toUpperCase().replace(/[^A-Z_]/g, '_'))
          .filter(Boolean)
          .map((type, i) => ({ type, reference: `E${i + 1}`, description: humanise(type) }));

        const crane =
          v.craneReference && v.craneType
            ? [
                {
                  reference: v.craneReference,
                  type: v.craneType,
                  radiusMetres: Number(v.radiusMetres ?? 0),
                  distanceToBoundaryMetres: Number(v.distanceToBoundaryMetres ?? 0),
                  tipHeightMetres: Number(v.tipHeightMetres ?? 0),
                  ...(v.overheadDistanceMetres && v.overheadExclusionMetres
                    ? {
                        overhead: {
                          distanceMetres: Number(v.overheadDistanceMetres),
                          exclusionMetres: Number(v.overheadExclusionMetres),
                        },
                      }
                    : {}),
                },
              ]
            : [];

        const route = v.routeReference
          ? [
              {
                reference: v.routeReference,
                description: v.routeDescription ?? v.routeReference,
                ...(v.maxVehicleLengthMetres ? { maxVehicleLengthMetres: Number(v.maxVehicleLengthMetres) } : {}),
                ...(v.maxHeightMetres ? { maxHeightMetres: Number(v.maxHeightMetres) } : {}),
                ...(v.maxWeightTonnes ? { maxWeightTonnes: Number(v.maxWeightTonnes) } : {}),
              },
            ]
          : [];

        return {
          elements,
          ...(crane.length > 0 ? { cranes: crane } : {}),
          ...(route.length > 0 ? { routes: route } : {}),
          ...(v.deliveryDescription
            ? {
                largestDelivery: {
                  description: v.deliveryDescription,
                  lengthMetres: Number(v.lengthMetres ?? 0),
                  heightMetres: Number(v.heightMetres ?? 0),
                  weightTonnes: Number(v.weightTonnes ?? 0),
                },
              }
            : {}),
        };
      },
    },

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
    walk: {
      title: 'Log site observation',
      intent:
        'What a walk turns up — quality, access, materials, housekeeping. Free: a walk produces twenty of these in an hour, and charging for them teaches people not to record them.',
      path: `/v1/projects/${projectId}/observations`,
      // A select yields a string; the endpoint takes a boolean and refuses
      // anything else. An action with no owner is refused by the platform, not
      // hidden by the form.
      transform: ({ requiresAction, ...rest }) => ({ ...rest, requiresAction: requiresAction === 'true' }),
      submitLabel: 'Log',
      fields: [
        { name: 'category', label: 'Category', type: 'select', options: SITE_OBSERVATION_CATEGORY },
        { name: 'description', label: 'What was seen', type: 'textarea',
          hint: 'In terms somebody who was not there can act on' },
        { name: 'location', label: 'Location', type: 'text', placeholder: 'Filter gallery, south face' },
        { name: 'taskId', label: 'Against activity', type: 'select', required: false, placeholder: 'Not activity-specific',
          options: b.Task.map((t) => ({ value: t._refId, label: `${t.activityCode} · ${t.name}` })) },
        { name: 'observedBy', label: 'Observed by', type: 'text', value: state.session.user.name },
        { name: 'requiresAction', label: 'Does somebody have to do something?', type: 'select', options: [
          { value: 'false', label: 'No — noted for the record' },
          { value: 'true', label: 'Yes — needs an owner and a date' },
        ] },
        { name: 'actionOwner', label: 'Action owner', type: 'text', required: false },
        { name: 'actionByDate', label: 'Needed by', type: 'date', required: false, min: today() },
        { name: 'evidenceHash', label: 'Photograph', type: 'file',
          hint: 'An observation without one is an assertion' },
      ],
    },
    'close-walk': {
      title: 'Close an observation',
      intent: 'Say what was actually done. A register that only grows stops being read.',
      path: (collected) => `/v1/projects/${projectId}/observations/${collected.observationId}/close`,
      transform: ({ observationId, ...rest }) => rest,
      submitLabel: 'Close',
      fields: [
        { name: 'observationId', label: 'Observation', type: 'select',
          options: openObservations.map((o) => ({
            value: o._refId,
            label: `${o.reference} · ${String(o.description).slice(0, 46)}`,
          })) },
        { name: 'actionTaken', label: 'What was done', type: 'textarea' },
        { name: 'closedBy', label: 'Closed by', type: 'text', value: state.session.user.name },
        { name: 'evidenceHash', label: 'Closeout evidence', type: 'file', required: false },
      ],
    },
  };

  // Giving up on a capture is a decision, so it is confirmed and it names what
  // is being lost. The bytes exist nowhere else — that is the whole reason this
  // panel had to be built.
  root.addEventListener('click', async (event) => {
    // The site visit report. Rendered from the ledger every time rather than
    // stored, so a report pulled today reflects what has been discharged since
    // the walk — which is the point of the register outliving the visit.
    const report = event.target.closest('[data-report]');
    if (report) {
      const visit = (site?.visits ?? []).find((v) => v.reference === report.dataset.report);
      if (!visit) return;
      report.disabled = true;
      try {
        const { filename } = await api.download(
          `/v1/projects/${projectId}/site-visits/${visit.visitId}/report.pdf`,
          { audience: 'INTERNAL' },
        );
        toast('Report downloaded', `${filename} — findings, what is late, the logistics checks and the photographs.`, 'ok');
      } catch (error) {
        toast('Report not produced', error.message, 'err');
      } finally {
        report.disabled = false;
      }
      return;
    }

    const button = event.target.closest('[data-discard]');
    if (!button) return;
    const file = carrying.find((entry) => entry.hash === button.dataset.discard);
    if (!confirm(`Discard ${file?.name || 'this capture'}? The platform never received it and nothing else holds a copy.`)) return;
    await outbox.discardFile(button.dataset.discard);
    toast('Capture discarded', 'The file was removed from this device and was never filed.', 'err');
    await draw();
  });

  root.querySelector('#sync-conflicts')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-decide]');
    if (!button) return;

    const card = button.closest('[data-conflict]');
    const reason = card.querySelector('[name="why"]').value.trim();
    const errorBox = card.querySelector('.cmd-error');
    errorBox.hidden = true;

    // The server refuses this too. Saying it beside the field is the difference
    // between an answer and a round trip that returns the same answer slower.
    if (!reason) {
      errorBox.textContent =
        'A reason is required — it is the only account of why the other record is not the one that stands.';
      errorBox.hidden = false;
      return;
    }

    button.disabled = true;
    const original = button.textContent;
    button.textContent = 'Recording…';
    try {
      const result = await api.post(
        `/v1/projects/${projectId}/sync/conflicts/${encodeURIComponent(card.dataset.conflict)}/resolve`,
        { decision: button.dataset.decide, reason },
      );
      toast(
        'Decided',
        result.appliedEventId ? 'The site’s record was written, as you' : 'The platform’s record stands',
        'ok',
      );
      await draw();
    } catch (error) {
      errorBox.textContent = `${error.code ? `${error.code} — ` : ''}${error.message}`;
      errorBox.hidden = false;
      button.disabled = false;
      button.textContent = original;
    }
  });

  void insightPanel(root.querySelector('#field-insight'), {
    projectId,
    areas: ['FIELD_EXECUTION', 'QUALITY_COMMISSIONING'],
    subject: 'field execution and quality',
    onChange: draw,
  });

  /**
   * Walk and record.
   *
   * The whole record made during the walk: dictate, file, transcribe, correct,
   * send. No desk return and no typing beyond fixing what the transcript got
   * wrong.
   *
   * Four steps, each of which already existed and none of which had a way in.
   *
   *   1. Record. Native `MediaRecorder`; works with no signal at all.
   *   2. File the recording as evidence, on its own, before anything is said
   *      about it. That is what makes capture-first possible: on a walk nobody
   *      knows the category, the location or the owner until it has been
   *      listened to.
   *   3. Transcribe. An ACU-consuming perception task that also classifies the
   *      note, reads the location out of it and names who was said to be
   *      responsible.
   *   4. Review and confirm. The transcript is shown before anything is filed
   *      and the person corrects it. The confirmation — not the model — is what
   *      creates the observation.
   *
   * Step 3 is the only one that needs a connection, and where it cannot happen
   * the recording is still filed and the screen says exactly that rather than
   * appearing to work and losing the audio.
   */
  async function walkAndRecord() {
    const support = voiceSupport();
    if (!support.available) {
      toast('Cannot record here', `${support.reason} Everything on this screen can still be typed.`, 'warn');
      return;
    }

    const recording = await recordVoice({
      title: 'Walk and record',
      intent: 'Say where you are, what you saw, and who needs to do something about it.',
    });
    if (!recording) return;

    // --- file it, before anything is said about it -------------------------
    const hash = await hashFile(recording);
    let filed;
    try {
      filed = await api.post(`/v1/projects/${projectId}/field/recordings`, {
        hash,
        description: recordingDescription(recording),
      });
    } catch (error) {
      toast('The recording could not be filed', error.detail ?? error.message ?? '', 'err');
      return;
    }

    // The bytes follow the record, never the other way round: the upload is
    // refused until something in the ledger names the hash.
    let held = false;
    try {
      await api.upload(`/v1/evidence/${encodeURIComponent(hash)}`, recording);
    } catch {
      try {
        await outbox.queueFile(recording, projectId);
      } catch {
        /* no IndexedDB — a private window. The record and its hash still stand. */
      }
      held = true;
    }

    if (held) {
      toast(
        'Recorded and held on this device',
        'The evidence record is filed. The audio follows on the next sync, and it can be transcribed then.',
        'warn',
      );
      await draw();
      return;
    }

    if (!perception?.capability?.available) {
      toast(
        'Recorded and filed',
        perception?.capability?.reason ??
          'This deployment cannot transcribe, so the recording is filed as evidence and nothing is read from it.',
        'warn',
      );
      await draw();
      return;
    }

    // --- transcribe --------------------------------------------------------
    toast('Transcribing', 'Reading the recording. It is shown to you before anything is filed.', 'ok');
    let draft;
    try {
      draft = await api.post(`/v1/projects/${projectId}/perception/voice-note`, { hash });
    } catch (error) {
      toast(
        'Filed, but not transcribed',
        `${error.detail ?? error.message ?? 'The transcription failed.'} The recording is on the record and can be read later.`,
        'warn',
      );
      await draw();
      return;
    }

    await reviewTranscript(draft);
  }

  /**
   * The draft, shown before anything is filed.
   *
   * Every field is editable, because the model is reading a person talking on a
   * building site with a excavator running, and the platform's position on AI
   * output is that a person confirms it. What the person changes is recorded
   * separately from what the model returned, so an observation argued about in
   * three years can be traced to whichever of the two said it.
   */
  async function reviewTranscript(draft) {
    const extraction = draft.extraction ?? {};

    const confirmed = await command({
      title: 'Review before it is filed',
      intent:
        `Transcribed${draft.confidence !== undefined && draft.confidence !== null ? ` at ${pct(draft.confidence * 100, 0)} confidence` : ''}. ` +
        'Correct anything it got wrong. What you change is recorded separately from what the model returned.',
      path: `/v1/projects/${projectId}/perception/${draft.id}/confirm`,
      submitLabel: 'File the observation',
      transform: (values) => ({
        corrections: {
          transcript: values.transcript,
          category: values.category,
          location: values.location,
          requiresAction: values.requiresAction === 'YES',
          ...(values.actionOwner ? { actionOwner: values.actionOwner } : {}),
        },
        observedBy: state.session.user?.name ?? undefined,
      }),
      fields: [
        {
          name: 'transcript',
          label: 'What was said',
          type: 'textarea',
          rows: 5,
          value: String(extraction.transcript ?? ''),
          hint: 'Verbatim. Correct mishearings; do not tidy it into something you did not say.',
        },
        {
          name: 'category',
          label: 'Category',
          type: 'select',
          value: String(extraction.category ?? ''),
          options: SITE_OBSERVATION_CATEGORY,
        },
        {
          name: 'location',
          label: 'Location',
          type: 'text',
          value: String(extraction.location ?? ''),
          placeholder: 'Where on site this was',
        },
        {
          name: 'requiresAction',
          label: 'Does somebody have to do something?',
          type: 'select',
          value: extraction.requiresAction === true ? 'YES' : 'NO',
          options: [
            { value: 'NO', label: 'No — recorded for the file' },
            { value: 'YES', label: 'Yes — it needs an owner' },
          ],
        },
        {
          name: 'actionOwner',
          label: 'Who owns it',
          type: 'text',
          required: false,
          value: String(extraction.actionOwner ?? ''),
          hint: 'Named in the recording where the model heard one. An action with no owner is not an action.',
        },
      ],
    });

    if (confirmed) {
      toast('Filed', `Observation ${confirmed.reference ?? ''} recorded, with the recording as its evidence.`, 'ok');
      await draw();
    }
  }

  /**
   * A vision draft, shown before anything is filed.
   *
   * Every task ends in a different register, so every task asks for the fields
   * that register needs and no others. The pattern the forms enforce is the one
   * the engine enforces: what a photograph can show is offered as a correction,
   * and what it cannot — the activity a claim is against, the period it falls
   * in, the date an action is needed by — is asked of the person, because those
   * are the fields somebody is later held to.
   */
  async function reviewVision(draft) {
    const extraction = draft.extraction ?? {};
    const read = `Read${
      draft.confidence !== undefined && draft.confidence !== null ? ` at ${pct(draft.confidence * 100, 0)} confidence` : ''
    }.`;
    const path = `/v1/projects/${projectId}/perception/${draft.id}/confirm`;

    if (draft.task === 'PROGRESS_FROM_IMAGES') {
      const items = extraction.items ?? [];
      const confirmed = await command({
        title: 'Progress read from a photograph',
        intent:
          `${read} One claim is made against one activity, so say which item is being claimed and what it is claimed ` +
          `against.${
            (extraction.obstructed ?? []).length > 0
              ? ` Not measured: ${extraction.obstructed.join('; ')}.`
              : ''
          }`,
        path,
        submitLabel: 'Submit the claim',
        fields: [
          {
            name: 'itemIndex',
            label: 'What is being claimed',
            type: 'select',
            options: items.map((item, index) => ({
              value: String(index),
              label: `${item.quantity} ${item.unit} — ${item.description}`,
            })),
          },
          {
            name: 'quantity',
            label: 'Quantity',
            type: 'number',
            required: false,
            placeholder: 'As read',
            hint: 'Leave blank to claim what was read. What you change is recorded separately from what the model returned.',
          },
          {
            name: 'taskId',
            label: 'Against which activity',
            type: 'select',
            options: b.Task.map((task) => ({ value: task._refId, label: `${task.activityCode} · ${task.name}` })),
            hint: 'Not visible in a photograph. The unit is checked against this activity’s measurement basis.',
          },
          { name: 'periodFrom', label: 'Period from', type: 'date', value: today() },
          { name: 'periodTo', label: 'Period to', type: 'date', value: today() },
          { name: 'costCode', label: 'Cost code', type: 'text', required: false },
          {
            name: 'rework',
            label: 'Is this rework?',
            type: 'select',
            options: [
              { value: 'NO', label: 'No — new work' },
              { value: 'YES', label: 'Yes — redone work, recorded and earning nothing' },
            ],
          },
        ],
        transform: (values) => {
          const index = Number(values.itemIndex ?? 0);
          return {
            itemIndex: index,
            taskId: values.taskId,
            periodFrom: values.periodFrom,
            periodTo: values.periodTo,
            ...(values.costCode ? { costCode: values.costCode } : {}),
            rework: values.rework === 'YES',
            ...(values.quantity
              ? {
                  corrections: {
                    items: items.map((item, at) => (at === index ? { ...item, quantity: Number(values.quantity) } : item)),
                  },
                }
              : {}),
          };
        },
      });
      if (confirmed) {
        toast(
          'Claim submitted',
          `${confirmed.reference ?? ''} — ${confirmed.cumulativeIfAccepted} cumulative if accepted.` +
            (confirmed.exceedsControlTotal ? ' This would exceed the control total.' : ''),
          confirmed.exceedsControlTotal ? 'warn' : 'ok',
        );
        await draw();
      }
      return;
    }

    if (draft.task === 'PPE_COMPLIANCE') {
      const breaches = extraction.breaches ?? [];
      const confirmed = await command({
        title: 'PPE read from a photograph',
        intent:
          `${read} ${
            breaches.length === 0
              ? 'No breach was reported.'
              : `${breaches.map((breach) => `${breach.item}: ${breach.description}`).join('; ')}.`
          }${
            (extraction.notJudgeable ?? []).length > 0 ? ` Could not be judged: ${extraction.notJudgeable.join('; ')}.` : ''
          } Nobody in the photograph is named by any of this.`,
        path,
        submitLabel: 'File the observation',
        fields: [
          {
            name: 'observationType',
            label: 'What this is',
            type: 'select',
            value: extraction.compliant === true && breaches.length === 0 ? 'GOOD_PRACTICE' : 'UNSAFE_ACT',
            options: OBSERVATION_TYPE,
          },
          { name: 'location', label: 'Where on site', type: 'text', value: String(extraction.location ?? '') },
          {
            name: 'narrative',
            label: 'What was seen',
            type: 'textarea',
            rows: 4,
            value: String(extraction.narrative ?? ''),
          },
        ],
        transform: (values) => ({
          observationType: values.observationType,
          corrections: { narrative: values.narrative, location: values.location },
        }),
      });
      if (confirmed) {
        toast('Filed', `Safety observation recorded at ${confirmed.severity ?? 'unclassified'} severity.`, 'ok');
        await draw();
      }
      return;
    }

    if (draft.task === 'EQUIPMENT_RECOGNITION') {
      const items = extraction.items ?? [];
      const confirmed = await command({
        title: 'Plant read from a photograph',
        intent:
          `${read} ${items.map((item) => `${item.count} × ${item.description} (${humanise(item.state)})`).join('; ')}. ` +
          'There is no plant register on this platform, so this is filed as a site observation naming what was seen.',
        path,
        submitLabel: 'File the observation',
        fields: [
          { name: 'category', label: 'Category', type: 'select', value: 'PROGRESS', options: SITE_OBSERVATION_CATEGORY },
          { name: 'location', label: 'Where on site', type: 'text', value: String(extraction.location ?? '') },
          {
            name: 'actionByDate',
            label: 'Needed by',
            type: 'date',
            required: false,
            hint: 'Left blank this is recorded for the file. A date makes it an action, and you own it.',
          },
        ],
        transform: (values) => ({
          category: values.category,
          ...(values.actionByDate ? { actionByDate: values.actionByDate } : {}),
          corrections: { location: values.location },
        }),
      });
      if (confirmed) {
        toast(
          'Filed',
          `Observation ${confirmed.reference ?? ''} — ${confirmed.itemsRecorded} item(s), ${confirmed.idle} standing.`,
          'ok',
        );
        await draw();
      }
      return;
    }

    const defects = extraction.defects ?? [];
    const confirmed = await command({
      title: 'Defects read from a photograph',
      intent:
        `${read} One NCR is raised per defect, so each can be closed on its own evidence.${
          (extraction.workInProgress ?? []).length > 0
            ? ` Reported as still in progress rather than defective: ${extraction.workInProgress.join('; ')}.`
            : ''
        }`,
      path,
      submitLabel: `Raise ${defects.length} NCR${defects.length === 1 ? '' : 's'}`,
      fields: [
        ...defects.flatMap((defect, index) => [
          {
            name: `severity${index}`,
            label: `${index + 1}. ${defect.description}`,
            type: 'select',
            value: ['MINOR', 'MAJOR', 'CRITICAL'].includes(defect.severity) ? defect.severity : 'MINOR',
            options: [
              { value: 'MINOR', label: 'Minor' },
              { value: 'MAJOR', label: 'Major' },
              { value: 'CRITICAL', label: 'Critical' },
            ],
            hint: defect.standardBreached ? `Against ${defect.standardBreached}.` : undefined,
          },
          {
            name: `action${index}`,
            label: `${index + 1}. Corrective action`,
            type: 'text',
            value: String(defect.proposedAction ?? ''),
          },
        ]),
      ],
      transform: (values) => ({
        corrections: {
          defects: defects.map((defect, index) => ({
            ...defect,
            severity: values[`severity${index}`],
            proposedAction: values[`action${index}`],
          })),
        },
      }),
    });
    if (confirmed) {
      toast('Raised', (confirmed.ncrs ?? []).map((ncr) => `${ncr.reference} (${ncr.severity})`).join(' · '), 'ok');
      await draw();
    }
  }

  root.addEventListener('click', async (event) => {
    const start = event.target.closest('[data-vision]');
    if (start) {
      const hash = start.dataset.hash;
      // One entry per task, each with its endpoint written out. The path could
      // be interpolated from the task name in one line; written out, every one
      // of the four is a literal the console-forms test can resolve against the
      // route table, and a renamed route fails the suite rather than the site.
      const endpoints = {
        PROGRESS_FROM_IMAGES: () => api.post(`/v1/projects/${projectId}/perception/progress`, { hash }),
        PPE_COMPLIANCE: () => api.post(`/v1/projects/${projectId}/perception/ppe`, { hash }),
        EQUIPMENT_RECOGNITION: () => api.post(`/v1/projects/${projectId}/perception/equipment`, { hash }),
        DEFECT_DETECTION: () => api.post(`/v1/projects/${projectId}/perception/defects`, { hash }),
      };
      let draft;
      try {
        draft = await endpoints[start.dataset.vision]();
      } catch (error) {
        toast('Nothing was read', error.detail ?? error.message ?? 'The read failed.', 'warn');
        return;
      }
      // The response is the extraction; the draft the review form needs carries
      // the same fields under the names the register uses.
      await reviewVision({ id: draft.draftId, task: draft.task, extraction: draft.extraction, confidence: draft.confidence });
      return;
    }

    const review = event.target.closest('[data-vision-confirm]');
    if (review) {
      const draft = (perception?.drafts ?? []).find((entry) => entry.id === review.dataset.visionConfirm);
      if (draft) await reviewVision(draft);
      return;
    }

    const reject = event.target.closest('[data-vision-discard]');
    if (reject) {
      const result = await command({
        title: 'Reject this reading',
        intent: 'The record of what the model read is kept. Say why it is not being used.',
        path: `/v1/projects/${projectId}/perception/${reject.dataset.visionDiscard}/discard`,
        submitLabel: 'Reject',
        fields: [{ name: 'reason', label: 'Why', type: 'text' }],
      });
      if (result) await draw();
    }
  });

  root.querySelector('.cmd-bar')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    if (button.dataset.command === 'dictate') return void walkAndRecord();

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
