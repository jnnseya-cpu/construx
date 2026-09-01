import { api, entityBundle } from '../lib/api.js';
import { command, commandBar, confirmCost } from '../lib/command.js';
import { badge, date, days, html, humanise, metric, modal, pct, positionReport, raw, render, statusTone, table, toast, track } from '../lib/ui.js';
import { ganttChart, histogram, sparkline } from '../lib/chart.js';
import { insightPanel } from '../lib/insight.js';
import { blockedReason, can, draw, state } from '../app.js';

/**
 * Programme.
 *
 * The critical path is recalculated from the activity network on every load —
 * dates are an output, never an input. That is what makes "what changed and
 * why" answerable: the inputs that produced the dates are all in the ledger.
 */

/**
 * The dated programme.
 *
 * Everything else on this page is computed on abstract day indices and answers
 * "how long". This answers "what date", which is the only version of the
 * question anybody on site can act on — and it is the only panel here that can
 * show a bank holiday, a seven-day cure or an activity that started before its
 * predecessor finished.
 */
function datedPanel(view) {
  if (view?.error) {
    return html`<div class="card" style="margin-bottom:14px">
      <h2>The programme in dates</h2>
      <p class="metric-sub">This could not be read: ${view.error.message}</p>
    </div>`;
  }
  if (!view) return '';

  const activities = view.activities ?? [];
  const late = (view.constraintDriven ?? []).filter((entry) => entry.totalFloat < 0);

  return html`
    <div class="card pad0" style="margin-bottom:14px">
      <h2 style="padding:15px 17px 0">The programme in dates</h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">${view.summary ?? ''}</p>

      ${
        activities.length === 0
          ? ''
          : html`
            <div class="grid g4" style="padding:13px 17px 0">
              <div class="card">
                <h2>Finish</h2>
                <div class="metric">${date(view.finishDate)}</div>
                <div class="metric-sub">
                  ${
                    view.lastRun
                      ? `Last run ${date(view.lastRun.ranAt)} at a data date of ${view.lastRun.options.dataDate}.`
                      : 'Live calculation. The programme has never been formally run.'
                  }
                </div>
              </div>
              <div class="card">
                <h2>On the longest path</h2>
                <div class="metric">${(view.longestPath ?? []).length}</div>
                <div class="metric-sub">
                  The chain that moves the finish date. Not the same set as zero float once calendars and constraints
                  are in play.
                </div>
              </div>
              <div class="card">
                <h2>Out of sequence</h2>
                <div class="metric ${raw(view.outOfSequenceCount > 0 ? 'warn' : '')}">${view.outOfSequenceCount ?? 0}</div>
                <div class="metric-sub">
                  Started before a predecessor finished, scheduled under
                  ${humanise(view.lastRun?.options?.outOfSequence ?? 'RETAINED_LOGIC').toLowerCase()}.
                </div>
              </div>
              <div class="card">
                <h2>Constraints not met</h2>
                <div class="metric ${raw(late.length > 0 ? 'bad' : '')}">${late.length}</div>
                <div class="metric-sub">
                  Dates the current logic cannot reach. Reported as negative float rather than refused.
                </div>
              </div>
            </div>

            ${
              (view.progressDisagreement ?? []).length > 0
                ? html`<div style="padding:11px 17px 0"><div class="notice warn"><div>
                    <b>${view.progressDisagreement.length} activity(ies) are recorded complete in the field and have no
                    actual finish date.</b> The schedule needs a date, not a percentage — without one it is still
                    forecasting work that is done, so every date after them is pessimistic and an extension of time
                    argued off this programme is unarguable in the wrong direction.
                    ${view.progressDisagreement.slice(0, 6).map((entry) => entry.activityCode).join(', ')}${
                      view.progressDisagreement.length > 6 ? ` and ${view.progressDisagreement.length - 6} more` : ''
                    }. Fix it with “Update activity status”.
                  </div></div></div>`
                : ''
            }

            <div style="padding:13px 17px 0">
              ${ganttChart({
                bars: activities.slice(0, 60).map((activity) => ({
                  id: activity.id,
                  name: `${activity.activityCode} ${activity.name}`,
                  start: activity.earlyStart,
                  finish: activity.earlyFinish,
                  baselineStart: activity.baselineStart,
                  baselineFinish: activity.baselineFinish,
                  milestone: activity.type === 'START_MILESTONE' || activity.type === 'FINISH_MILESTONE',
                  longestPath: activity.longestPath,
                  critical: activity.critical,
                  percentComplete: activity.percentComplete,
                })),
                dataDate: view.lastRun?.options?.dataDate,
              })}
              ${
                activities.length > 60
                  ? html`<p style="font-size:12px;color:var(--text-3);margin:6px 0 0">
                      Showing the first 60 of ${activities.length} activities. A chart with six hundred bars is a grey
                      block, not a programme.
                    </p>`
                  : ''
              }
            </div>

            ${table({
              headers: ['Code', 'Activity', 'Held by', 'Path', 'Calendar', 'Start', 'Finish', 'Total float', 'Status'],
              align: ['', '', '', 'num', '', '', '', 'num', ''],
              rows: activities.slice(0, 60).map((activity) => [
                activity.activityCode,
                html`${activity.name}${activity.longestPath ? html` ${badge('Longest path', 'warn')}` : ''}${
                  activity.outOfSequence ? html` ${badge('Out of sequence', 'bad')}` : ''
                }${activity.constraint ? html` ${badge(humanise(activity.constraint.type), 'info')}` : ''}`,
                // The question everybody asks in front of a Gantt chart. The
                // forward pass already knows the answer and used to discard it.
                activity.drivingPredecessorName ??
                  (activity.constraint ? 'its constraint' : activity.status === 'COMPLETE' ? 'done' : 'nothing — it can start'),
                activity.floatPathRank ? (activity.floatPathRank === 1 ? badge('1', 'bad') : String(activity.floatPathRank)) : '—',
                activity.calendarId === 'STANDARD_5_DAY' ? '5-day' : activity.calendarId === 'CONTINUOUS_7_DAY' ? '7-day' : activity.calendarId,
                date(activity.earlyStart),
                date(activity.earlyFinish),
                html`<span class="${raw(activity.totalFloat < 0 ? 'bad' : activity.totalFloat === 0 ? 'warn' : '')}">${activity.totalFloat}d</span>`,
                badge(humanise(activity.status), activity.status === 'COMPLETE' ? 'ok' : activity.status === 'IN_PROGRESS' ? 'info' : 'neutral'),
              ]),
            })}

            ${
              (view.floatPaths ?? []).length > 1
                ? html`
                  <h2 style="padding:15px 17px 0">What drives the date next</h2>
                  <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
                    One critical path says what is holding the job today. These are the chains behind it, ranked by
                    what they have in hand. A chain with three days of float becomes the critical path on the fourth
                    day of a delay — and by then the argument about who caused it has already been had. Where a chain
                    merges is the number that matters: the same float feeding the critical path next month and feeding
                    nothing until handover are different risks, and one float column cannot tell them apart.
                  </p>
                  ${table({
                    headers: ['Path', 'Float', 'Chain', 'From', 'To', 'Runs into'],
                    align: ['num', 'num', '', '', '', ''],
                    rows: view.floatPaths.map((path) => [
                      path.rank === 1 ? badge('Critical', 'bad') : `#${path.rank}`,
                      html`<span class="${raw(path.totalFloat < 0 ? 'bad' : path.totalFloat === 0 ? 'warn' : '')}">${path.totalFloat}d</span>`,
                      path.activities.map((entry) => entry.activityCode).join(' → '),
                      date(path.earlyStart),
                      date(path.earlyFinish),
                      path.mergesInto
                        ? html`${path.mergesInto.activityCode} ${path.mergesInto.name} ${badge(
                            path.mergesInto.rank === 1 ? 'the critical path' : `path #${path.mergesInto.rank}`,
                            path.mergesInto.rank === 1 ? 'bad' : 'warn',
                          )}`
                        : path.rank === 1
                          ? 'the finish date'
                          : '—',
                    ]),
                  })}`
                : ''
            }

            <h2 style="padding:15px 17px 0">The breakdown, rolled up</h2>
            <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
              Progress weighted by duration, not counted. Counting activities makes a two-day snagging item worth as
              much as a forty-day pour, and reports a branch as half done when a tenth of the work is.
            </p>
            ${
              view.unassignedActivities > 0
                ? html`<div style="padding:9px 17px 0"><div class="notice"><div>
                    ${view.unassignedActivities} activity(ies) sit under no package, so they appear in no branch
                    below. An empty breakdown and a project whose activities were never filed under anything look
                    identical, and only one of them is somebody's job to fix.
                  </div></div></div>`
                : ''
            }
            ${table({
              headers: ['Breakdown', 'Activities', 'Start', 'Finish', 'Worst float', 'Complete'],
              align: ['', 'num', '', '', 'num', 'num'],
              rows: (view.wbs ?? []).map((node) => [
                node.path,
                `${node.complete} of ${node.activities}`,
                date(node.earlyStart),
                date(node.earlyFinish),
                html`<span class="${raw(node.totalFloat < 0 ? 'bad' : node.totalFloat === 0 ? 'warn' : '')}">${node.totalFloat}d</span>`,
                `${node.percentComplete}%`,
              ]),
            })}

            <h2 style="padding:15px 17px 0">Working calendars</h2>
            ${table({
              headers: ['Calendar', 'Working week', 'Exceptions'],
              align: ['', 'num', 'num'],
              rows: (view.calendars ?? []).map((calendar) => [
                calendar.name,
                `${calendar.workingDaysPerWeek} days`,
                String(calendar.exceptions),
              ]),
            })}
          `
      }
    </div>`;
}

/**
 * Review and comment, for everybody the programme lands on.
 *
 * Two things this panel exists to show and no other screen does. A comment is
 * against a *run*, so it is legible later as an objection to the version it was
 * made about rather than to "the programme". And silence is shown as silence:
 * the three participation states are kept apart on screen exactly as the
 * register keeps them apart, because a party who read it and had no objection
 * and a party who never opened it are the two facts a deemed-acceptance
 * argument turns on, and a screen that merges them has decided that argument.
 */
function reviewPanel(view) {
  if (view?.error) {
    return html`<div class="card" style="margin-bottom:14px">
      <h2>Review and comment</h2>
      <p class="metric-sub">This could not be read: ${view.error.message}</p>
    </div>`;
  }
  if (!view) return '';

  const open = view.open;
  const comments = view.comments ?? [];
  const forOpen = open ? comments.filter((entry) => entry.reviewId === open.reviewId) : [];
  const silent = view.participation?.didNotRespond ?? [];

  return html`
    <div class="card pad0" style="margin-bottom:14px">
      <h2 style="padding:15px 17px 0">Review and comment</h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">${view.summary ?? ''}</p>

      ${
        !open
          ? html`<div style="padding:13px 17px 15px">
              <div class="notice"><div>
                No review is open. ${
                  view.closedReviews > 0
                    ? `${view.closedReviews} previous review(s) have been closed; their comments and dispositions are in the register below.`
                    : 'Issue a schedule run for comment to let every party say what they think of it before it becomes the thing they are measured against.'
                }
              </div></div>
            </div>`
          : html`
            <div class="grid g4" style="padding:13px 17px 0">
              <div class="card">
                <h2>Closes</h2>
                <div class="metric ${raw(open.daysRemaining < 0 ? 'bad' : open.daysRemaining <= 3 ? 'warn' : '')}">${date(open.closesOn)}</div>
                <div class="metric-sub">
                  ${
                    open.daysRemaining < 0
                      ? `${Math.abs(open.daysRemaining)} day(s) past its closing date and still open.`
                      : `${open.daysRemaining} day(s) left to comment.`
                  }
                </div>
              </div>
              <div class="card">
                <h2>Comments</h2>
                <div class="metric">${forOpen.length}</div>
                <div class="metric-sub">Against run ${open.runId.slice(-6)}, which finished ${date(open.finishDateAtIssue)} as issued.</div>
              </div>
              <div class="card">
                <h2>Unanswered</h2>
                <div class="metric ${raw(view.unanswered > 0 ? 'warn' : 'good')}">${view.unanswered}</div>
                <div class="metric-sub">The review cannot be closed while any comment has no disposition against it.</div>
              </div>
              <div class="card">
                <h2>Not responded</h2>
                <div class="metric ${raw(silent.length > 0 ? 'warn' : '')}">${silent.length}</div>
                <div class="metric-sub">Of ${open.invitedCount} invited. Not agreement — an absence of one.</div>
              </div>
            </div>

            ${
              open.supersededByLaterRun
                ? html`<div style="padding:11px 17px 0"><div class="notice warn"><div>
                    <b>The programme has been rescheduled since this went out.</b> Every comment below was made about
                    run ${open.runId.slice(-6)}, not about what the Gantt above now shows. Rescheduling deliberately
                    does not close or move the review — a comment silently reattached to a later version is a comment
                    nobody made — but the planner answering these needs to know they are answering about a superseded
                    version, and so does the party who raised them.
                  </div></div></div>`
                : ''
            }

            <h2 style="padding:15px 17px 0">Who said what, and who said nothing</h2>
            <div style="padding:4px 17px 0"><div class="metric-sub">
              Three states, kept apart. Objected is what people did. Not responded is what they did not do. The middle
              state — read it, no objection — stays empty because this platform has no way for a party to say that,
              and filling it from the invitation list would be exactly the deeming the register exists to refuse.
            </div></div>
            ${table({
              headers: ['State', 'Parties', 'What it means'],
              rows: [
                [
                  badge('Objected', 'info'),
                  (view.participation?.objected ?? []).map((party) => party.name).join(', ') || '—',
                  'Raised at least one comment against this run.',
                ],
                [
                  badge('Read it, no objection', 'neutral'),
                  (view.participation?.reviewedWithoutObjection ?? []).map((party) => party.name).join(', ') || '—',
                  'Nobody. There is no confirmation mechanism, so nobody can be recorded here without inventing the fact.',
                ],
                [
                  badge('Did not respond', silent.length > 0 ? 'warn' : 'neutral'),
                  silent.map((party) => party.name).join(', ') || '—',
                  'Invited and said nothing. Whether that becomes acceptance is a question about the contract, not about this register.',
                ],
              ],
            })}

            ${
              (view.byKind ?? []).length > 0
                ? html`
                  <h2 style="padding:15px 17px 0">What the objections are about</h2>
                  ${table({
                    headers: ['Kind', 'Raised', 'Unanswered'],
                    align: ['', 'num', 'num'],
                    rows: view.byKind.map((entry) => [
                      entry.label,
                      String(entry.count),
                      html`<span class="${raw(entry.unanswered > 0 ? 'warn' : '')}">${entry.unanswered}</span>`,
                    ]),
                  })}`
                : ''
            }
          `
      }

      ${
        comments.length > 0
          ? html`
            <h2 style="padding:15px 17px 0">Comment register</h2>
            ${table({
              headers: ['Raised', 'By', 'Activity', 'Kind', 'Comment', 'Disposition'],
              rows: comments.slice(0, 60).map((entry) => [
                date(entry.raisedAt),
                entry.raisedByName,
                entry.activityName ?? (entry.activityId ? entry.activityId.slice(-6) : '—'),
                entry.kindLabel,
                entry.body,
                entry.answered
                  ? html`${badge(
                      entry.dispositionLabel ?? humanise(entry.disposition ?? ''),
                      entry.disposition === 'ACCEPTED' ? 'ok' : entry.disposition === 'REJECTED' ? 'bad' : 'warn',
                    )}${entry.reason ? html`<div class="metric-sub" style="margin-top:4px">${entry.reason}</div>` : ''}`
                  : badge('Unanswered', 'warn'),
              ]),
            })}`
          : ''
      }
    </div>`;
}

/**
 * Resources: what the programme needs against what there is.
 *
 * The critical path assumes infinite resource — it will put two pours side by
 * side that need the same gang and report a date nobody on site can hit. This is
 * the panel that says so, and the one thing it must never do is draw the demand
 * curve at the availability line because that is what would fit.
 */
function resourcePanel(view) {
  if (view?.error) {
    return html`<div class="card" style="margin-bottom:14px">
      <h2>Resources</h2>
      <p class="metric-sub">This could not be read: ${view.error.message}</p>
    </div>`;
  }
  if (!view) return '';

  const profiles = view.profiles ?? [];
  const levelling = view.levelling;
  const over = profiles.filter((profile) => profile.overallocatedDays > 0);

  return html`
    <div class="card pad0" style="margin-bottom:14px">
      <h2 style="padding:15px 17px 0">Resources</h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">${view.summary ?? ''}</p>

      ${
        (view.resources ?? []).length === 0
          ? html`<div style="padding:13px 17px 15px"><div class="notice"><div>
              Nothing is defined, so the programme is still assuming there is enough of everything — which is what a
              critical path assumes by construction, and why two pours needing the same gang can sit side by side on a
              chart that looks fine.
            </div></div></div>`
          : html`
            <div class="grid g4" style="padding:13px 17px 0">
              <div class="card">
                <h2>Defined</h2>
                <div class="metric">${view.resources.length}</div>
                <div class="metric-sub">On ${view.activitiesWithResource} activity(ies).</div>
              </div>
              <div class="card">
                <h2>Over what there is</h2>
                <div class="metric ${raw(over.length > 0 ? 'bad' : 'good')}">${over.length}</div>
                <div class="metric-sub">Asked for more than is available on at least one day.</div>
              </div>
              <div class="card">
                <h2>Can be levelled</h2>
                <div class="metric">${levelling?.levelled?.length ?? 0}</div>
                <div class="metric-sub">Activities that fit once delayed into float the programme shows as spare.</div>
              </div>
              <div class="card">
                <h2>Will not fit</h2>
                <div class="metric ${raw((levelling?.unresolved?.length ?? 0) > 0 ? 'bad' : '')}">${levelling?.unresolved?.length ?? 0}</div>
                <div class="metric-sub">However they are moved inside their float. This is the number that is a decision.</div>
              </div>
            </div>

            ${profiles.map((profile) => html`
              <div style="padding:15px 17px 0">
                <div class="metric-sub" style="margin-bottom:7px">
                  <b>${profile.name}</b> — ${profile.availablePerDay} ${profile.unit}(s) a working day available,
                  peak demand ${profile.peakDemand}${profile.peakDate ? ` on ${date(profile.peakDate)}` : ''}.
                  ${
                    profile.overallocatedDays > 0
                      ? html`${badge(`${profile.overallocatedDays} day(s) short`, 'bad')} ${profile.shortfallUnitDays} ${profile.unit}-days that cannot be met.`
                      : 'Fits.'
                  }
                </div>
                ${histogram({
                  // Weekly, and the peak inside the week rather than its average:
                  // an average smooths away the Tuesday that needs three gangs,
                  // which is the only day on the bar anybody can act on.
                  buckets: (profile.weeks ?? []).map((week) => ({ label: week.weekStarting.slice(5), count: week.peak })),
                  limit: profile.availablePerDay,
                  limitLabel: `available (${profile.availablePerDay} ${profile.unit}/day)`,
                  markLabel: 'over what there is',
                  empty: `Nothing on the programme asks for ${profile.name} yet`,
                  emptyDetail: 'It is defined and available; no activity has been given any of it.',
                })}
              </div>`)}

            ${
              (levelling?.unresolved ?? []).length > 0
                ? html`
                  <h2 style="padding:15px 17px 0">What levelling cannot fix</h2>
                  <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
                    Levelling stops at the float. Moving work past its late finish would change the completion date,
                    and that is a commercial decision rather than an arithmetic one — hire more, resequence, or accept
                    the date. Placed at its late start anyway, over the limit, because leaving it out would understate
                    every resource day after it. Priority: ${levelling.priorityRule}
                  </p>
                  ${table({
                    headers: ['Activity', 'Resource', 'Float', 'Short by', 'Put at'],
                    align: ['', '', 'num', 'num', ''],
                    rows: levelling.unresolved.map((entry) => [
                      entry.name,
                      entry.resourceName,
                      `${entry.totalFloat}d`,
                      html`<span class="bad">${entry.daysBeyondFloat}d beyond it</span>`,
                      date(entry.placedAt),
                    ]),
                  })}`
                : ''
            }

            ${
              (levelling?.levelled ?? []).length > 0
                ? html`
                  <h2 style="padding:15px 17px 0">What would move</h2>
                  <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
                    Delayed into float the programme currently shows as spare. Every day taken here is a day of
                    protection given up, so a levelled programme with no float left is not the same programme.
                  </p>
                  ${table({
                    headers: ['Activity', 'From', 'To', 'Delay', 'Float left'],
                    align: ['', '', '', 'num', 'num'],
                    rows: levelling.levelled.slice(0, 20).map((entry) => [
                      entry.name,
                      date(entry.originalStart),
                      date(entry.levelledStart),
                      `${entry.delayDays}d`,
                      html`<span class="${raw(entry.remainingFloat === 0 ? 'warn' : '')}">${entry.remainingFloat}d</span>`,
                    ]),
                  })}`
                : ''
            }

            ${table({
              headers: ['Resource', 'Kind', 'Available/day', 'On activities', 'Peak', 'Unit-days needed'],
              align: ['', '', 'num', 'num', 'num', 'num'],
              rows: view.resources.map((resource) => {
                const profile = profiles.find((entry) => entry.resourceId === resource.resourceId);
                return [
                  resource.name,
                  resource.typeLabel,
                  `${resource.availablePerDay} ${resource.unit}`,
                  String(resource.assignedActivities),
                  html`<span class="${raw((profile?.peakDemand ?? 0) > resource.availablePerDay ? 'bad' : '')}">${profile?.peakDemand ?? 0}</span>`,
                  String(profile?.totalUnitDays ?? 0),
                ];
              }),
            })}
          `
      }
    </div>`;
}

export async function programme(root) {
  const projectId = state.session.projectId;

  const [calc, bundle, ppc, logic, control, dated] = await Promise.all([
    api.get(`/v1/projects/${projectId}/programme?contractualDurationDays=400`).catch((error) => ({ error })),
    entityBundle(projectId, ['Task', 'ProgrammeBaseline', 'DelayRiskSnapshot', 'Dependency', 'Constraint', 'LookaheadPlan', 'WorkPackage', 'ScopePackage', 'ScheduleRun']),
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
    // The dated programme: every activity on its own calendar, against a data
    // date, with the longest path traced back from what finishes last. The
    // critical path above is computed on abstract day indices and answers a
    // different question — this one answers "what date".
    api.get(`/v1/projects/${projectId}/programme/schedule`).catch((error) => ({ error })),
  ]);

  // Who said what about which version, and who said nothing. Read separately
  // because it is readable by every participant, including people who cannot
  // change a single date on the programme they are commenting on.
  const review = await api.get(`/v1/projects/${projectId}/programme/review`).catch((error) => ({ error }));

  // Who there is to ask. An invitation carries the identity a comment will be
  // matched against, so the list has to come from the people this platform
  // actually knows — typing a name would put the invitation and the objection
  // in different vocabularies and report every objector as silent.
  const people = await api.get('/v1/users').then((r) => r.users ?? []).catch(() => []);

  // What the programme needs against what there is. Read after the schedule
  // because it is computed from it: a stored demand curve disagrees with the
  // programme the moment a date moves, and somebody orders labour off the wrong
  // one.
  const resourcing = await api.get(`/v1/projects/${projectId}/programme/resources`).catch((error) => ({ error }));

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
          ${raw(commandBar([
            { id: 'schedule', label: 'Schedule the programme', permitted: can('PROGRAMME_BASELINES', 'U'), reason: blockedReason('PROGRAMME_BASELINES', 'U') },
            { id: 'activityAttributes', label: 'Activity calendar & constraint', permitted: can('PROGRAMME_BASELINES', 'U'), reason: blockedReason('PROGRAMME_BASELINES', 'U') },
            { id: 'activityStatus', label: 'Update activity status', permitted: can('PROGRAMME_BASELINES', 'U'), reason: blockedReason('PROGRAMME_BASELINES', 'U') },
            { id: 'calendar', label: 'Define a calendar', permitted: can('PROGRAMME_BASELINES', 'U'), reason: blockedReason('PROGRAMME_BASELINES', 'U') },
            { id: 'resource', label: 'Define a resource', permitted: can('PROGRAMME_BASELINES', 'U'), reason: blockedReason('PROGRAMME_BASELINES', 'U') },
            { id: 'assignResource', label: 'Put a resource on an activity', permitted: can('PROGRAMME_BASELINES', 'U'), reason: blockedReason('PROGRAMME_BASELINES', 'U') },
          ]))}
          ${raw(commandBar([
            // Commenting sits on read, not on update: the objection worth having
            // comes from the party who has to do the work, and requiring the
            // authority to change a programme in order to say something about it
            // would leave only the planner able to comment on it.
            { id: 'comment', label: 'Comment on the programme', permitted: can('PROGRAMME_BASELINES', 'R'), reason: blockedReason('PROGRAMME_BASELINES', 'R') },
            { id: 'openReview', label: 'Issue for comment', permitted: can('PROGRAMME_BASELINES', 'A'), reason: blockedReason('PROGRAMME_BASELINES', 'A') },
            { id: 'respond', label: 'Answer a comment', permitted: can('PROGRAMME_BASELINES', 'A'), reason: blockedReason('PROGRAMME_BASELINES', 'A') },
            { id: 'closeReview', label: 'Close the review', permitted: can('PROGRAMME_BASELINES', 'A'), reason: blockedReason('PROGRAMME_BASELINES', 'A') },
          ]))}
          ${can('PROGRAMME_BASELINES', 'R') ? html`<button class="btn quiet" id="whatif">What-if analysis</button>` : ''}
        </div>
      </div>

      ${calc.error ? html`<div class="notice err">${calc.error.message}</div>` : ''}

      ${datedPanel(dated)}

      ${resourcePanel(resourcing)}

      ${reviewPanel(review)}

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
    schedule: {
      title: 'Schedule the programme',
      intent:
        'Press F9 and keep the answer. The data date is the line between what happened and what is forecast: nothing ' +
        'unstarted is scheduled before it, and running work is forecast from it on what remains rather than on what ' +
        'was planned. The out-of-sequence setting changes the completion date, so the run records which was used.',
      path: () => `/v1/projects/${projectId}/programme/run`,
      submitLabel: 'Schedule it',
      fields: [
        { name: 'dataDate', label: 'Data date', type: 'date', hint: 'Progress is true up to this day and forecast after it.' },
        { name: 'projectStart', label: 'Project start', type: 'date', required: false, hint: 'Where the programme begins if nothing constrains it earlier.' },
        {
          name: 'outOfSequence',
          label: 'Work that started before its predecessor finished',
          type: 'select',
          options: [
            { value: 'RETAINED_LOGIC', label: 'Retained logic — the remainder still waits for the predecessor' },
            { value: 'PROGRESS_OVERRIDE', label: 'Progress override — the spent logic no longer holds it back' },
          ],
          hint: 'Both are defensible and they give different completion dates. The run records which produced this one.',
        },
        {
          name: 'lagCalendar',
          label: 'Calendar that measures relationship lag',
          type: 'select',
          options: [
            { value: 'PREDECESSOR', label: 'The predecessor’s calendar' },
            { value: 'SUCCESSOR', label: 'The successor’s calendar' },
            { value: 'CONTINUOUS', label: 'Seven-day — a lag that counts weekends' },
          ],
          hint: 'A two-day lag means something different on a five-day calendar than on a seven-day one.',
        },
      ],
      transform: (v) => ({
        dataDate: v.dataDate,
        ...(v.projectStart ? { projectStart: v.projectStart } : {}),
        outOfSequence: v.outOfSequence,
        lagCalendar: v.lagCalendar,
      }),
    },
    activityAttributes: {
      title: 'Activity calendar and constraint',
      intent:
        'What makes an activity schedulable in dates. A cure on a seven-day calendar runs through the weekend the ' +
        'site does not work; a milestone marks a moment and has no duration whatever its record says. A constraint ' +
        'that the logic cannot meet is scheduled anyway and reported as negative float, which is what a planner ' +
        'needs to see rather than a rejection.',
      path: () => `/v1/projects/${projectId}/programme/activity`,
      submitLabel: 'Apply',
      fields: [
        {
          name: 'taskId',
          label: 'Activity',
          type: 'select',
          options: (dated?.activities ?? []).map((activity) => ({
            value: activity.id,
            label: `${activity.activityCode} ${activity.name}`,
          })),
        },
        {
          name: 'type',
          label: 'Activity type',
          type: 'select',
          options: [
            { value: 'TASK_DEPENDENT', label: 'Task' },
            { value: 'START_MILESTONE', label: 'Start milestone' },
            { value: 'FINISH_MILESTONE', label: 'Finish milestone' },
            { value: 'RESOURCE_DEPENDENT', label: 'Resource dependent' },
            { value: 'LEVEL_OF_EFFORT', label: 'Level of effort' },
            { value: 'WBS_SUMMARY', label: 'WBS summary' },
          ],
        },
        {
          name: 'calendarId',
          label: 'Calendar',
          type: 'select',
          // From the calendars the project actually has, so the form cannot
          // offer one that would be refused.
          options: (dated?.calendars ?? []).map((calendar) => ({
            value: calendar.id,
            label: `${calendar.name} — ${calendar.workingDaysPerWeek} day week`,
          })),
        },
        {
          name: 'constraintType',
          label: 'Constraint',
          type: 'select',
          required: false,
          options: [
            { value: '', label: 'None' },
            { value: 'CLEAR', label: 'Remove the existing constraint' },
            { value: 'START_ON', label: 'Start on' },
            { value: 'START_ON_OR_AFTER', label: 'Start on or after' },
            { value: 'START_ON_OR_BEFORE', label: 'Start on or before' },
            { value: 'FINISH_ON', label: 'Finish on' },
            { value: 'FINISH_ON_OR_AFTER', label: 'Finish on or after' },
            { value: 'FINISH_ON_OR_BEFORE', label: 'Finish on or before' },
            { value: 'MANDATORY_START', label: 'Mandatory start — overrides the logic' },
            { value: 'MANDATORY_FINISH', label: 'Mandatory finish — overrides the logic' },
            { value: 'AS_LATE_AS_POSSIBLE', label: 'As late as possible' },
          ],
          hint: 'The two mandatory types break the network rather than bounding it. A programme full of them is a bar chart.',
        },
        { name: 'constraintDate', label: 'Constraint date', type: 'date', required: false },
      ],
      transform: (v) => ({
        taskId: v.taskId,
        type: v.type,
        calendarId: v.calendarId,
        // Leaving the constraint alone, clearing it and setting one are three
        // different intentions, and the middle one has to be sayable.
        ...(v.constraintType === 'CLEAR'
          ? { constraint: null }
          : v.constraintType && v.constraintDate
            ? { constraint: { type: v.constraintType, date: v.constraintDate } }
            : {}),
      }),
    },
    activityStatus: {
      title: 'Update activity status',
      intent:
        'The planner’s monthly update: actual dates and what is left. A percentage is what gets reported and a ' +
        'remaining duration is what schedules, and the two disagree constantly — an activity can be ninety per cent ' +
        'complete with three weeks left, and only one of those numbers moves the finish date.',
      path: () => `/v1/projects/${projectId}/programme/activity-status`,
      submitLabel: 'Record it',
      fields: [
        {
          name: 'taskId',
          label: 'Activity',
          type: 'select',
          options: (dated?.activities ?? []).map((activity) => ({
            value: activity.id,
            label: `${activity.activityCode} ${activity.name} — ${humanise(activity.status).toLowerCase()}`,
          })),
        },
        { name: 'actualStart', label: 'Actual start', type: 'date', required: false },
        { name: 'actualFinish', label: 'Actual finish', type: 'date', required: false, hint: 'A finish with no start is refused: the schedule could not say how long the work took.' },
        { name: 'remainingDuration', label: 'Working days remaining', type: 'number', required: false, step: '1' },
        { name: 'percentComplete', label: 'Percent complete', type: 'number', required: false, step: '1' },
      ],
      transform: (v) => ({
        taskId: v.taskId,
        ...(v.actualStart ? { actualStart: v.actualStart } : {}),
        ...(v.actualFinish ? { actualFinish: v.actualFinish } : {}),
        ...(v.remainingDuration !== '' && v.remainingDuration !== undefined ? { remainingDuration: Number(v.remainingDuration) } : {}),
        ...(v.percentComplete !== '' && v.percentComplete !== undefined ? { percentComplete: Number(v.percentComplete) } : {}),
      }),
    },
    calendar: {
      title: 'Define a working calendar',
      intent:
        'Which days the site works, and the days it does not. A bank holiday taken out moves every date after it; a ' +
        'Saturday pour put in pulls them back. Redefining a calendar by its own id replaces it, because a correction ' +
        'is not a new calendar and two differing by one holiday is how half a programme ends up on the wrong one.',
      path: () => `/v1/projects/${projectId}/programme/calendar`,
      submitLabel: 'Define it',
      fields: [
        { name: 'id', label: 'Calendar id', type: 'text', placeholder: 'STANDARD_5_DAY' },
        { name: 'name', label: 'Name', type: 'text', placeholder: 'Five-day week' },
        {
          name: 'week',
          label: 'Working week',
          type: 'select',
          options: [
            { value: '5', label: 'Monday to Friday' },
            { value: '6', label: 'Monday to Saturday' },
            { value: '7', label: 'Every day' },
          ],
        },
        {
          name: 'exceptionDate',
          label: 'Exception date',
          type: 'date',
          required: false,
          hint: 'One at a time. A holiday out, or an extra shift in.',
        },
        {
          name: 'exceptionWorking',
          label: 'That day is',
          type: 'select',
          required: false,
          options: [
            { value: 'no', label: 'Not worked — a holiday or shutdown' },
            { value: 'yes', label: 'Worked — an extra shift' },
          ],
        },
        { name: 'exceptionReason', label: 'Why', type: 'text', required: false, placeholder: 'August bank holiday' },
      ],
      transform: (v) => ({
        id: v.id,
        name: v.name,
        workingWeekdays:
          v.week === '7'
            ? [true, true, true, true, true, true, true]
            : v.week === '6'
              ? [false, true, true, true, true, true, true]
              : [false, true, true, true, true, true, false],
        ...(v.exceptionDate
          ? {
              exceptions: [
                {
                  date: v.exceptionDate,
                  working: v.exceptionWorking === 'yes',
                  ...(v.exceptionReason ? { reason: v.exceptionReason } : {}),
                },
              ],
            }
          : {}),
      }),
    },
    resource: {
      title: 'Define a resource',
      intent:
        'What one unit is and how many there are on a working day. It is a limit, not a plan — nothing here reduces ' +
        'demand to fit it. A curve quietly drawn at the availability line is a programme made to look achievable ' +
        'rather than made achievable, and the person it fools is whoever has to build it.',
      path: () => `/v1/projects/${projectId}/programme/resource`,
      submitLabel: 'Define it',
      fields: [
        { name: 'id', label: 'Resource id', type: 'text', placeholder: 'CONCRETE_GANG' },
        { name: 'name', label: 'Name', type: 'text', placeholder: 'Concrete gang' },
        {
          name: 'type',
          label: 'Kind',
          type: 'select',
          options: [
            { value: 'LABOUR', label: 'Labour — a gang, a trade, a shift' },
            { value: 'PLANT', label: 'Plant — a crane, a rig, an item on hire' },
            { value: 'MATERIAL', label: 'Material — a delivery rate, not a stock' },
            { value: 'SUBCONTRACT', label: 'Subcontract — a trade contractor’s own capacity' },
          ],
        },
        { name: 'unit', label: 'One unit is', type: 'text', placeholder: 'gang' },
        {
          name: 'availablePerDay',
          label: 'Available on a working day',
          type: 'number',
          step: '0.5',
          min: 0,
          hint: 'How many there actually are, not how many the programme would like.',
        },
        { name: 'dayRateMinor', label: 'Day rate (pence)', type: 'number', required: false, step: '1' },
      ],
      transform: (v) => ({
        id: v.id,
        name: v.name,
        type: v.type,
        unit: v.unit,
        availablePerDay: Number(v.availablePerDay),
        ...(v.dayRateMinor !== '' && v.dayRateMinor !== undefined ? { dayRateMinor: Number(v.dayRateMinor) } : {}),
      }),
    },
    assignResource: {
      title: 'Put a resource on an activity',
      intent:
        'How much of it the activity occupies on each of its working days. Zero takes it off rather than recording a ' +
        'demand of nothing — a zero row reads as “checked, needs none” when what happened was somebody removing it.',
      path: () => `/v1/projects/${projectId}/programme/resource-assignment`,
      submitLabel: 'Assign it',
      fields: [
        {
          name: 'taskId',
          label: 'Activity',
          type: 'select',
          options: (dated?.activities ?? []).map((activity) => ({
            value: activity.id,
            label: `${activity.activityCode} ${activity.name}`,
          })),
        },
        {
          name: 'resourceId',
          label: 'Resource',
          type: 'select',
          options: (resourcing?.resources ?? []).map((resource) => ({
            value: resource.resourceId,
            label: `${resource.name} — ${resource.availablePerDay} ${resource.unit}/day`,
          })),
          hint: (resourcing?.resources ?? []).length > 0 ? '' : 'Define a resource first, or the demand has no limit to compare against.',
        },
        { name: 'unitsPerDay', label: 'Units a day', type: 'number', step: '0.5', min: 0 },
      ],
      transform: (v) => ({ taskId: v.taskId, resourceId: v.resourceId, unitsPerDay: Number(v.unitsPerDay) }),
    },
    openReview: {
      title: 'Issue the programme for comment',
      intent:
        'A review is opened against one schedule run, not against “the programme”. Every comment made under it is ' +
        'then anchored to the version it was made about, which is the difference between a register that can be read ' +
        'back in two years and a pile of objections to something nobody can reconstruct. Name who is being asked: a ' +
        'review with no invitation list cannot tell a party who looked and had no objection from one who never saw it.',
      path: () => `/v1/projects/${projectId}/programme/review`,
      submitLabel: 'Issue it',
      fields: [
        {
          name: 'runId',
          label: 'Which run',
          type: 'select',
          options: (bundle.ScheduleRun ?? [])
            .slice()
            .reverse()
            .map((run) => ({
              value: run._refId,
              label: `${String(run.ranAt ?? '').slice(0, 16).replace('T', ' ')} — finishing ${run.finishDate} (data date ${run.options?.dataDate ?? '—'})`,
            })),
          hint: 'Schedule the programme first if there is nothing here: a review needs a version to be about.',
        },
        { name: 'closesOn', label: 'Comments close on', type: 'date' },
        {
          name: 'invited',
          label: 'Who is being asked',
          type: 'multiselect',
          options: people.map((person) => ({
            value: person.id,
            label: `${person.name} — ${(person.roles ?? []).map((role) => humanise(role)).join(', ')}`,
          })),
          hint: 'Everybody the dates land on, not only the people who can change them.',
        },
        { name: 'note', label: 'Covering note', type: 'text', required: false },
      ],
      transform: (v) => ({
        runId: v.runId,
        closesOn: v.closesOn,
        // Id and name together: the id is matched against a comment's author,
        // the name keeps the closed register readable years later.
        invited: (Array.isArray(v.invited) ? v.invited : [v.invited].filter(Boolean)).map((id) => ({
          id,
          name: people.find((person) => person.id === id)?.name ?? id,
        })),
        ...(v.note ? { note: v.note } : {}),
      }),
    },
    comment: {
      title: 'Comment on the programme',
      intent:
        'Say what is wrong with it while it can still change. The kind is a closed list because the register’s use is ' +
        'that it can be read as a pattern — twelve access objections against one area is a different conversation ' +
        'from twelve scattered ones — and free text cannot be counted.',
      path: () => `/v1/projects/${projectId}/programme/review/comment`,
      submitLabel: 'Raise it',
      fields: [
        {
          name: 'reviewId',
          label: 'Review',
          type: 'select',
          options: review?.open ? [{ value: review.open.reviewId, label: `Run ${review.open.runId.slice(-6)}, closing ${review.open.closesOn}` }] : [],
          hint: review?.open ? '' : 'No review is open. Comments are raised against an open review so they are anchored to a version.',
        },
        {
          name: 'kind',
          label: 'What kind of objection',
          type: 'select',
          options: [
            { value: 'SEQUENCE', label: 'The order of the work' },
            { value: 'DURATION', label: 'How long an activity is allowed' },
            { value: 'ACCESS', label: 'When the area is actually available' },
            { value: 'RESOURCE', label: 'What it would take to achieve it' },
            { value: 'CONSTRAINT', label: 'A date the programme is pinned to' },
            { value: 'OMISSION', label: 'Work that is not on the programme at all' },
            { value: 'OTHER', label: 'Something else' },
          ],
        },
        {
          name: 'activityId',
          label: 'Against which activity',
          type: 'select',
          required: false,
          options: (dated?.activities ?? []).map((activity) => ({
            value: activity.id,
            label: `${activity.activityCode} ${activity.name}`,
          })),
          hint: 'Leave blank for an objection to the programme as a whole, or for work that is not on it.',
        },
        {
          name: 'body',
          label: 'The objection',
          type: 'textarea',
          hint: 'What is wrong and what it should be. “Disagree” cannot be answered.',
        },
      ],
      transform: (v) => ({
        reviewId: v.reviewId,
        kind: v.kind,
        body: v.body,
        ...(v.activityId ? { activityId: v.activityId } : {}),
      }),
    },
    respond: {
      title: 'Answer a comment',
      intent:
        'Everything but a plain acceptance carries a reason. “Noted” is a real answer and deliberately not a synonym ' +
        'for accepted — it means the point is understood and the programme is not changing, which the party who ' +
        'raised it is entitled to be told rather than left to infer from the dates staying the same.',
      path: () => `/v1/projects/${projectId}/programme/review/respond`,
      submitLabel: 'Answer it',
      fields: [
        {
          name: 'commentId',
          label: 'Comment',
          type: 'select',
          options: (review?.comments ?? [])
            .filter((entry) => !entry.answered)
            .map((entry) => ({
              value: entry.commentId,
              label: `${entry.raisedBy} · ${entry.kindLabel} · ${String(entry.body).slice(0, 60)}`,
            })),
          hint: 'Only unanswered comments. An answer already given cannot be rewritten — answer the next issue instead.',
        },
        {
          name: 'disposition',
          label: 'What is happening to it',
          type: 'select',
          options: [
            { value: 'ACCEPTED', label: 'Accepted — the programme will change' },
            { value: 'ACCEPTED_IN_PART', label: 'Accepted in part' },
            { value: 'REJECTED', label: 'Rejected' },
            { value: 'NOTED', label: 'Noted, and the programme is not changing' },
          ],
        },
        {
          name: 'reason',
          label: 'Why',
          type: 'textarea',
          required: false,
          hint: 'Required for anything but a plain acceptance.',
        },
      ],
      transform: (v) => ({
        commentId: v.commentId,
        disposition: v.disposition,
        ...(v.reason ? { reason: v.reason } : {}),
      }),
    },
    closeReview: {
      title: 'Close the review',
      intent:
        'Refused while any comment is unanswered. A review closed over an open objection is a record that says the ' +
        'party was heard when they were not, and that is exactly the record somebody will rely on later.',
      path: () => `/v1/projects/${projectId}/programme/review/close`,
      submitLabel: 'Close it',
      fields: [
        {
          name: 'reviewId',
          label: 'Review',
          type: 'select',
          options: review?.open ? [{ value: review.open.reviewId, label: `Run ${review.open.runId.slice(-6)}, closing ${review.open.closesOn}` }] : [],
        },
        {
          name: 'note',
          label: 'What this review concluded',
          type: 'textarea',
          hint:
            'Recorded now rather than recomputed later. Say what changed as a result and what did not — including ' +
            'who did not respond, because that is what somebody will argue about.',
        },
      ],
    },
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
