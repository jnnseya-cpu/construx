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
              <h3 style="padding:15px 17px 0">On this device, not yet on the platform</h3>
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
        <div ${raw(drillable('Activities complete', taskSources))}>
          <h3>Activities complete</h3>
          <div class="metric good">${complete.length}<span style="font-size:16px;color:var(--text-3)"> / ${b.Task.length}</span></div>
          <div class="metric-sub">${pct(coverage, 0)} of activities carry a measurement</div>
        </div>
        <div ${raw(drillable('Progress records', progressSources))}>
          <h3>Progress records</h3>
          <div class="metric orange">${b.ProgressMeasurement.length}</div>
          <div class="metric-sub">each one evidenced before it was accepted</div>
        </div>
        <div ${raw(drillable('Open snags', snagSources))}>
          <h3>Open snags</h3>
          <div class="metric ${raw(openSnags.length > 0 ? 'warn' : 'good')}">${openSnags.length}</div>
          <div class="metric-sub">${dispatched.length} dispatched to trade</div>
        </div>
        <div ${raw(drillable('Evidence items', evidenceSources))}>
          <h3>Evidence items</h3>
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
          <h3 style="padding:15px 17px 0">Site walk</h3>
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
              <h3 style="padding:15px 17px 0">
                Site visit — what the walk still obliges
                ${site.latePermits.length > 0 ? badge(`${site.latePermits.length} late`, 'bad') : ''}
              </h3>
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
                      <h3 style="margin-top:12px">Logistics plan, version ${site.logistics.version}</h3>
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

      ${
        productivity
          ? html`<div class="card pad0" style="margin-top:14px">
              <div style="padding:15px 17px 0">
                <h3>Productivity against plan</h3>
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
