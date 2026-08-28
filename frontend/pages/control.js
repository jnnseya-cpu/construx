import { api, entities } from '../lib/api.js';
/**
 * Now, in the shape a `datetime-local` input wants and in the viewer's own
 * timezone. `toISOString` would give UTC and set the field an hour out for
 * anybody east or west of it.
 */
function localNow() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
import { command, commandBar } from '../lib/command.js';
import { badge, drillable, html, humanise, money, pct, positionReport, raw, render, resolveHtml, table, toast } from '../lib/ui.js';
import { lookupPanel, wireLookups } from '../lib/lookup.js';
import { blockedReason, can, draw, state } from '../app.js';
import { insightPanel } from '../lib/insight.js';

/**
 * Corporate project control.
 *
 * Three views of one standard: this project against it, every project against
 * it, and what the business learned along the way.
 *
 * The design decision that matters is how the four statuses are shown. A
 * checklist that renders "we do not track this" the same as "you have not done
 * this" trains people to ignore both. Untracked items are greyed and excluded
 * from every percentage on the page, and the reason is printed next to them —
 * they are the platform's gap, not the project's.
 */

const STATUS_TONE = { PRESENT: 'ok', MISSING: 'bad', NOT_YET_DUE: '', NOT_TRACKED: '', NOT_PROPORTIONATE: '' };
const STATUS_LABEL = {
  PRESENT: 'in place',
  MISSING: 'MISSING',
  NOT_YET_DUE: 'not yet due',
  NOT_TRACKED: 'not tracked',
  NOT_PROPORTIONATE: 'not at this size',
};

const KIND_TONE = { WENT_WRONG: 'bad', WENT_WELL: 'ok' };

/**
 * The links of Bid → Contract → Subcontract → Commitment → Application → CVR.
 *
 * Held here rather than derived from the response so that a break in the chain
 * reads differently from a disagreement: the rest of this panel is two records
 * that contradict each other, and these are records attached to nothing.
 */
const CHAIN_CHECKS = new Set([
  'Contract from the winning bid',
  'Subcontract from the awarded enquiry',
  'Commitment against a subcontract',
  'Payment cycle against the contract',
  'Application against a payment cycle',
  'CVR from the contract',
]);

export async function control(root) {
  const projectId = state.session.projectId;

  const [project, estate, lessons, gate, gateDecisions, standard, stages, decisions, actions, reusable] = await Promise.all([
    api.get(`/v1/projects/${projectId}/control`),
    api.get('/v1/control/estate').catch(() => null),
    api.get('/v1/lessons').catch(() => null),
    // 8.4. The seven-clause Definition of Done, answered server-side — the
    // browser holds no rule the API does not publish, and a gate report the
    // browser assembled would be a second answer to the same question.
    api.get(`/v1/projects/${projectId}/stage-gate`).catch(() => null),
    api.get(`/v1/projects/${projectId}/stage-gate/decisions`).catch(() => ({ decisions: [], summary: '' })),
    // The corporate standard the project is being run against, the stages it
    // has occupied, every open commitment in one place, and the lessons other
    // projects have already paid for. All four had engines and no screen.
    api.get('/v1/control/standard').catch((error) => ({ error })),
    api.get(`/v1/projects/${projectId}/stages`).catch((error) => ({ error })),
    api.get(`/v1/projects/${projectId}/decisions`).catch((error) => ({ error })),
    api.get(`/v1/projects/${projectId}/actions`).catch((error) => ({ error })),
    api.get(`/v1/projects/${projectId}/lessons/reusable`).catch((error) => ({ error })),
  ]);

  // Meetings and the actions out of them. On this screen rather than its own,
  // because a meeting action nobody closed and a control item nobody evidenced
  // are the same failure seen twice, and a person chasing one is chasing both.
  const meetings = await api
    .get(`/v1/projects/${projectId}/meetings`)
    .catch(() => ({ meetings: [], openActions: [], summary: '' }));

  // Only a draft meeting can still be minuted into. Issued minutes are not
  // amended, so offering them in the dropdown would offer a refusal.
  const draftMeetings = (meetings.meetings ?? []).filter((m) => m.status === 'DRAFT');

  // The snapshots themselves, for the reconcile chooser. Read as entities
  // rather than from `/completion`, because the completion position publishes a
  // snapshot's reference and not the identifier the reconcile route needs — and
  // offering a reference where an id is required produces a 404 with a
  // plausible-looking cause.
  const snapshots = await entities(projectId, 'PeriodSnapshot').catch(() => []);

  const LOOKUPS = [
    {
      id: 'reconcile',
      title: 'Does this report still hold',
      intent:
        'Re-run the cut-off and compare it with the hash the report was built on. A report whose figures have ' +
        'moved since it was issued is the one somebody is about to quote in a meeting.',
      empty: 'No period report has been taken on this project.',
      inputs: [
        {
          name: 'snapshotId',
          label: 'Report',
          options: snapshots.map((snap) => ({
            value: snap._refId,
            label: `${snap.reference ?? snap._refId} \u00b7 cut-off ${String(snap.cutOff ?? '').slice(0, 10)}`,
          })),
        },
      ],
      path: (v) => `/v1/projects/${projectId}/reports/${v.snapshotId}/reconcile`,
      sections: [
        { key: 'reconciles', label: 'Still reconciles' },
        { key: 'reference', label: 'Report' },
        { key: 'contentHash', label: 'Hash it was built on' },
        { key: 'recomputedHash', label: 'Hash now' },
      ],
    },
    {
      id: 'approvedminutes',
      title: 'The exact text that was approved',
      intent:
        'For anything that reproduces the minutes. What was approved and what the record says now are not always ' +
        'the same sentence, and only one of them is evidence.',
      empty: 'No meeting has been minuted on this project.',
      inputs: [
        {
          name: 'meetingId',
          label: 'Meeting',
          options: (meetings.meetings ?? []).map((m) => ({
            value: m.meetingId,
            label: `${m.reference ?? m.meetingId} \u00b7 ${m.title}`,
          })),
        },
      ],
      path: (v) => `/v1/projects/${projectId}/meetings/${v.meetingId}/approved-version`,
      sections: [
        { key: 'approvedAt', label: 'Approved' },
        { key: 'items', label: 'As approved', empty: 'These minutes carry no items.' },
      ],
    },
  ];
  const draftReason = (code) =>
    !can('LOOKAHEAD_CONSTRAINTS', code)
      ? blockedReason('LOOKAHEAD_CONSTRAINTS', code)
      : 'No meeting is still in draft. Minutes are written into the meeting they belong to, and issued minutes are not amended.';

  // What the records say against each other. Every module here is right about
  // its own subject and none of them looks at the others, which is where the
  // expensive mistakes live.
  const consistency = await api.get(`/v1/projects/${projectId}/consistency`).catch(() => null);
  const chainBreaks = (consistency?.findings ?? []).filter((finding) => CHAIN_CHECKS.has(finding.check));

  // The records behind the summary counts, collected from the per-item evidence
  // the control report now carries.
  //
  // Three of the five tiles are deliberately not drillable, and for the same
  // reason each time: they count the *absence* of records.
  //
  // A gap is an item with no evidence behind it — that is what makes it a gap —
  // so a drill on it would always open empty. "Not at this size" counts items
  // that do not apply to a project of this value, and "Not tracked here" counts
  // items the platform has no evidence path for at all. None of the three has
  // anything to show, and an affordance promising otherwise is the placeholder
  // rule 9 forbids. The gaps themselves are listed in full below, by name.
  const allItems = project.stages.flatMap((stage) => stage.items);
  const presentSources = allItems
    .filter((item) => item.status === 'PRESENT')
    .flatMap((item) => item.evidenceRefs ?? []);
  const lessonSources = (lessons?.lessons ?? [])
    .map((lesson) => ({ refType: 'LessonLearned', refId: lesson.id ?? lesson._refId }))
    .filter((ref) => ref.refId);

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Project Control</h1>
          <p>
            One standard, every project — sized to the job. ${project.applicableItems} of
            ${project.stages.reduce((n, s) => n + s.items.length, 0)} items apply to a ${project.projectScaleLabel} project, measured
            against what the Golden Thread can actually evidence and honest about what it cannot.
          </p>
        </div>
        <div class="actions cmd-bar">
          ${raw(commandBar([
            { id: 'gate', label: 'Decide the stage gate', tone: '', permitted: can('PROJECT_SETUP', 'A'), reason: blockedReason('PROJECT_SETUP', 'A') },
            { id: 'meeting', label: 'Minute a meeting', permitted: can('LOOKAHEAD_CONSTRAINTS', 'C'), reason: blockedReason('LOOKAHEAD_CONSTRAINTS', 'C') },
            {
              id: 'item',
              label: 'Minute an item',
              permitted: can('LOOKAHEAD_CONSTRAINTS', 'U') && draftMeetings.length > 0,
              // The dead end this affordance exists to prevent: a modal whose
              // required dropdown is empty, which a person cannot diagnose.
              reason: draftReason('U'),
            },
            {
              id: 'action',
              label: 'Record an action',
              permitted: can('LOOKAHEAD_CONSTRAINTS', 'U') && draftMeetings.length > 0,
              reason: draftReason('U'),
            },
            {
              id: 'issue',
              label: 'Issue minutes',
              permitted: can('LOOKAHEAD_CONSTRAINTS', 'A') && draftMeetings.length > 0,
              reason: draftReason('A'),
            },
          ]))}
        </div>
      </div>

      ${
        !gate
          ? ''
          : html`<div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">Stage gate — Definition of Done</h2>
              <div style="padding:8px 17px 0"><div class="metric-sub">
                Seven clauses, each answered from the ledger rather than from a checklist somebody ticked. A clause the platform
                cannot assess is reported as unassessable and never as passed — a gate that quietly passes what it did not check
                turns a gap into a signed assurance, and the signature is what somebody relies on two years later.
              </div></div>
              ${table({
                headers: ['Clause', 'State', 'What it found'],
                rows: gate.clauses.map((clause) => [
                  clause.title,
                  clause.state === 'PASS'
                    ? badge('met', 'ok')
                    : clause.state === 'FAIL'
                      ? badge('not met', 'bad')
                      : badge('cannot assess', 'warn'),
                  clause.detail,
                ]),
              })}
              ${gate.clauses
                .filter((clause) => clause.blocking.length > 0)
                .map(
                  (clause) => html`<div style="padding:12px 17px 0"><div class="notice ${raw(clause.state === 'FAIL' ? 'err' : 'warn')}">
                    <div>
                      <b>${clause.title}</b><br>
                      ${clause.blocking.map((item) => html`${item}<br>`)}
                    </div>
                  </div></div>`,
                )}
              <div style="padding:14px 17px 15px"><div class="metric-sub">
                Report hash <span class="mono">${gate.contentHash}</span> — a gate decision is recorded against this, so what was
                decided can be told apart from how it was worded.
              </div></div>
            </div>`
      }

      ${
        gateDecisions.decisions.length === 0
          ? ''
          : html`<div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">Gate decisions and their conditions</h2>
              ${table({
                headers: ['Decided', 'Phase', 'Decision', 'Conditions', 'Past their date'],
                align: ['', '', '', 'num', 'num'],
                rows: gateDecisions.decisions.map((decision) => [
                  decision.decidedAt.slice(0, 10),
                  humanise(decision.phase),
                  decision.decision === 'PASS'
                    ? badge('passed', 'ok')
                    : decision.decision === 'HOLD'
                      ? badge('held', 'bad')
                      : badge('passed with conditions', 'warn'),
                  decision.conditions.length || '—',
                  decision.overdue.length > 0 ? badge(String(decision.overdue.length), 'bad') : '—',
                ]),
              })}
              ${
                gateDecisions.decisions.some((decision) => decision.overdue.length > 0)
                  ? html`<div style="padding:12px 17px 15px"><div class="notice err">
                      <div>
                        <b>A condition the gate was passed on has gone past its date.</b><br>
                        ${gateDecisions.decisions
                          .flatMap((decision) => decision.overdue)
                          .map((condition) => html`${condition.what} — ${condition.owner}, due ${condition.by}<br>`)}
                        On the day after the date, a conditional pass stops being a pass and becomes a list of things somebody
                        promised.
                      </div>
                    </div></div>`
                  : ''
              }
            </div>`
      }

      ${
        consistency
          ? html`<div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">Do the records agree?</h2>
              <div style="padding:0 17px"><div class="metric-sub">
                The programme computes a duration, the contract records a date, the estimate prices a scope and the
                field record measures progress. Each is right about its own subject; none of them looks at the others.
              </div></div>
              ${
                consistency.findings.length > 0
                  ? html`<div style="padding:11px 17px 4px">
                      ${consistency.findings.map(
                        (f) => html`<div class="notice ${raw(f.severity === 'CRITICAL' ? 'err' : 'warn')}" style="margin:0 0 9px">
                          <div>
                            <b>${f.check}</b>${f.exposureMinor ? html` · ${money(f.exposureMinor)}` : ''}${f.exposureDays ? html` · ${f.exposureDays} days` : ''}<br>
                            ${f.finding}<br>${f.consequence}
                          </div>
                        </div>`,
                      )}
                    </div>`
                  : html`<div style="padding:11px 17px 4px"><div class="notice ok">${consistency.summary}</div></div>`
              }
              <div style="padding:4px 17px 15px">
                <div class="split-list">
                  ${consistency.passed.map((p) => html`<div class="row"><span class="lbl">${p.split(' — ')[0]}</span><span class="val">${badge('agrees', 'good')}</span></div>`)}
                  ${consistency.skipped.map((sk) => html`<div class="row"><span class="lbl">${sk.check}</span><span class="val">${badge('not run', 'warn')} <span class="metric-sub">${sk.reason}</span></span></div>`)}
                </div>
                ${
                  consistency.skipped.length > 0
                    ? html`<div class="metric-sub" style="margin-top:9px">
                        A check that could not run has not passed. It has not been taken, and the two are different things.
                      </div>`
                    : ''
                }
                ${
                  consistency.commercialWithheld
                    ? html`<div class="metric-sub" style="margin-top:9px">Commercial detail is withheld from your role. The disagreements themselves stand.</div>`
                    : ''
                }
                ${
                  // A break in Bid → Contract → Subcontract → Commitment →
                  // Application → CVR is not two numbers disagreeing; it is a
                  // record attached to nothing, invisible precisely because
                  // nobody is looking at where it should have been. It is raised
                  // as an exception rather than left to be read — and raising it
                  // writes, so it is a button rather than a side effect of
                  // opening this page.
                  chainBreaks.length > 0
                    ? html`<div style="margin-top:12px">
                        <div class="metric-sub" style="margin-bottom:7px">
                          The data flow is broken at ${chainBreaks.length}
                          link${raw(chainBreaks.length === 1 ? '' : 's')}. Raising it records the exception and notifies
                          whoever owns the commercial position. The same break is only ever raised once, and it closes
                          itself when the link traces again.
                        </div>
                        ${
                          can('BUDGET_COST', 'R')
                            ? html`<button class="btn" id="raise-chain">Raise the exception</button>`
                            : html`<button class="btn quiet locked" disabled title="${blockedReason('BUDGET_COST', 'R')}">
                                Raise the exception 🔒
                              </button>`
                        }
                      </div>`
                    : ''
                }
              </div>
            </div>`
          : ''
      }

      <div id="control-insight" style="margin-bottom:14px"></div>

      <div class="grid g5" style="margin-bottom:14px">
        <div ${raw(drillable('This project', presentSources))}>
          <h2>This project</h2>
          <div class="metric ${raw(
            project.completenessPercent === null ? '' : project.completenessPercent >= 90 ? 'good' : project.completenessPercent >= 70 ? 'warn' : 'bad',
          )}">${project.completenessPercent === null ? '—' : pct(project.completenessPercent, 1)}</div>
          <div class="metric-sub">Of what is due and trackable in ${humanise(project.phase)}.</div>
        </div>
        <div class="card">
          <h2>Gaps</h2>
          <div class="metric ${raw(project.gaps.length === 0 ? 'good' : 'warn')}">${project.gaps.length}</div>
          <div class="metric-sub">
            ${project.blockingGaps.length > 0
              ? `${project.blockingGaps.length} of them stop the project moving on.`
              : 'None of them stop the project moving on — the rest is discipline.'}
          </div>
        </div>
        <div class="card">
          <h2>Not at this size</h2>
          <div class="metric">${project.stages.reduce((n, s) => n + s.notProportionate, 0)}</div>
          <div class="metric-sub">
            A ${project.projectScaleLabel} job does not need a programme baseline or a document control procedure. Demanding
            them is how a standard gets ignored.
          </div>
        </div>
        <div class="card">
          <h2>Not tracked here</h2>
          <div class="metric">${project.notTracked.length}</div>
          <div class="metric-sub">Real control items with no home in the platform yet. Excluded from the score, not hidden.</div>
        </div>
        <div ${raw(drillable('Lessons captured', lessonSources))}>
          <h2>Lessons captured</h2>
          <div class="metric orange">${lessons ? lessons.lessons.length : '—'}</div>
          <div class="metric-sub">
            ${lessons ? `Across ${lessons.contributingProjects} project${lessons.contributingProjects === 1 ? '' : 's'}.` : 'Not visible to your role.'}
          </div>
        </div>
      </div>

      ${
        project.blockingGaps.length > 0
          ? html`<div class="notice err" style="margin-bottom:14px">
              <div>
                <b>${project.blockingGaps.length} gap${project.blockingGaps.length === 1 ? '' : 's'} will stop this project at the phase gate.</b><br>
                ${project.blockingGaps.join(', ')}
              </div>
            </div>`
          : ''
      }

      ${project.stages.map(
        (stage) => html`
          <div class="card pad0" style="margin-bottom:14px">
            <h2 style="padding:15px 17px 0">
              ${stage.label}
              ${stage.completenessPercent === null ? badge('not yet due', '') : badge(pct(stage.completenessPercent, 0), stage.completenessPercent === 100 ? 'ok' : stage.completenessPercent >= 70 ? 'warn' : 'bad')}
            </h2>
            <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">${stage.purpose}</p>
            ${table({
              headers: ['Item', 'Status', 'Found', 'Why it is on the list'],
              align: ['', '', 'num', ''],
              rows: stage.items.map((item) => [
                item.status === 'NOT_TRACKED' || item.status === 'NOT_PROPORTIONATE'
                  ? html`<span style="color:var(--text-3)">${item.label}</span>`
                  : html`${item.label}${item.gateEnforced ? badge('gate', 'info') : ''}`,
                badge(STATUS_LABEL[item.status], STATUS_TONE[item.status]),
                item.found === undefined ? '—' : `${item.found} ${item.counts}`,
                html`<span style="font-size:12px;color:var(--text-3)">${
                  item.notTrackedReason ??
                  (item.status === 'NOT_PROPORTIONATE' ? `Applies from ${item.appliesFrom.toLowerCase()} projects upwards` : item.purpose)
                }</span>`,
              ]),
            })}
          </div>
        `,
      )}

      ${
        estate
          ? html`
            <div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">Every project against the same standard</h2>
              <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
                Worst first. A project manager can see their own gaps; only this view can see that the business keeps
                missing the same thing.
              </p>
              ${table({
                headers: ['Project', 'Phase', 'Complete', 'Gaps', 'Blocking'],
                align: ['', '', 'num', 'num', ''],
                rows: estate.projects.map((p) => [
                  p.name,
                  badge(humanise(p.phase), ''),
                  p.completenessPercent === null ? '—' : pct(p.completenessPercent, 1),
                  p.gaps,
                  p.blockingGaps.length === 0 ? badge('clear', 'ok') : badge(`${p.blockingGaps.length}`, 'bad'),
                ]),
                empty: 'No projects',
              })}
            </div>

            ${
              estate.systemicGaps.length > 0
                ? html`<div class="card pad0" style="margin-bottom:14px">
                    <h2 style="padding:15px 17px 0">What the business is systematically missing</h2>
                    ${table({
                      headers: ['Item', 'Stage', 'Missing on', 'Why it matters'],
                      align: ['', '', 'num', ''],
                      rows: estate.systemicGaps.map((g) => [
                        g.label,
                        badge(humanise(g.stage), ''),
                        `${g.missingOn} of ${g.ofProjects}`,
                        html`<span style="font-size:12px;color:var(--text-3)">${g.purpose}</span>`,
                      ]),
                    })}
                  </div>`
                : ''
            }
          `
          : ''
      }

      ${
        lessons
          ? html`
            <div class="grid g2" style="margin-bottom:14px">
              <div class="card">
                <h2>What keeps costing money</h2>
                <p style="font-size:12.5px;color:var(--text-3);margin-bottom:11px">
                  One project getting ground conditions wrong is bad luck. The same category recurring across projects is
                  a business problem no project team was in a position to see.
                </p>
                ${
                  lessons.recurring.length === 0
                    ? html`<div class="empty"><b>Nothing recurring yet</b>Too few lessons to see a pattern.</div>`
                    : html`<div class="split-list">
                        ${lessons.recurring.map(
                          (r) => html`<div class="row">
                            <span class="lbl">${humanise(r.category)} — ${r.occurrences} on ${r.projects} project${r.projects === 1 ? '' : 's'}</span>
                            <span class="val">${money(r.costImpactMinor)}</span>
                          </div>`,
                        )}
                      </div>`
                }
              </div>
              <div class="card">
                <h2>Where the library stands</h2>
                ${
                  lessons.observations.length === 0
                    ? html`<div class="empty"><b>Nothing to report</b></div>`
                    : html`<div class="split-list">
                        ${lessons.observations.map((o) => html`<div class="row"><span class="lbl">${o}</span></div>`)}
                      </div>`
                }
              </div>
            </div>

            <div class="card pad0">
              <h2 style="padding:15px 17px 0">Lessons learned</h2>
              <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
                Captured on the project that produced it and read from every other one, because a lesson only pays for
                itself on a different job.
              </p>
              ${table({
                headers: ['Lesson', 'Category', 'Stage', 'Cost', 'Days', 'Do this instead'],
                align: ['', '', '', 'num', 'num', ''],
                rows: lessons.lessons.map((l) => [
                  html`${l.title}${badge(l.kind === 'WENT_WELL' ? 'repeat this' : 'avoid this', KIND_TONE[l.kind])}`,
                  humanise(l.category),
                  humanise(l.stage),
                  l.costImpactMinor ? money(l.costImpactMinor) : '—',
                  l.scheduleImpactDays || '—',
                  html`<span style="font-size:12px;color:var(--text-3)">${l.recommendation}</span>`,
                ]),
                empty: 'No lessons captured — the business is paying for the same mistakes without a record of them',
              })}
            </div>
          `
          : ''
      }

      <div class="card pad0" style="margin-top:14px">
        <h2 style="padding:15px 17px 0">Meetings, and what came out of them</h2>
        <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
          ${meetings.summary || 'No meeting has been minuted on this project.'}
          An action carried from an earlier meeting keeps the date it was originally given, so the overdue column below
          measures against that date and not against the date it was last restated.
        </p>
        ${table({
          headers: ['Meeting', 'Type', 'Held', 'Present', 'Apologies', 'Open actions', 'Overdue', 'Minutes'],
          align: ['', '', '', 'num', 'num', 'num', 'num', ''],
          rows: (meetings.meetings ?? []).map((m) => [
            m.title,
            humanise(m.type),
            String(m.heldAt ?? '').slice(0, 10),
            m.attended,
            m.apologies || '—',
            m.openActions || '—',
            m.overdueActions ? badge(String(m.overdueActions), 'warn') : '—',
            html`${badge(humanise(m.status), m.status === 'ISSUED' ? 'ok' : 'info')}${
              m.corrections ? badge(`${m.corrections} correction(s)`, 'warn') : ''
            }`,
          ]),
          empty: 'No meeting minuted — nothing agreed on this project has a record behind it',
        })}
      </div>

      ${
        (meetings.openActions ?? []).length === 0
          ? ''
          : html`<div class="card pad0" style="margin-top:14px">
              <h2 style="padding:15px 17px 0">Every open action, worst first</h2>
              ${table({
                headers: ['Ref', 'Action', 'Owner', 'Organisation', 'Due', 'Overdue by'],
                align: ['', '', '', '', '', 'num'],
                rows: meetings.openActions.map((a) => [
                  a.reference,
                  a.what,
                  a.owner,
                  a.ownerOrganisation,
                  String(a.originallyDue ?? a.by ?? '').slice(0, 10),
                  a.daysOverdue > 0 ? badge(`${a.daysOverdue} days`, 'warn') : '—',
                ]),
              })}
            </div>`
      }

      ${raw(LOOKUPS.map((spec) => resolveHtml(lookupPanel(spec))).join(''))}

      ${positionReport({
        title: 'The corporate control standard',
        intent:
          'The four stages every project in this business is run against, and each item in them. Published by the ' +
          'platform rather than kept in a document nobody opens.',
        data: standard,
        error: standard?.error,
        sections: [
          { key: 'stages', label: 'Stages', empty: 'No control standard is defined.' },
          { key: 'items', label: 'Items', empty: 'The standard contains no items.' },
        ],
      })}

      ${positionReport({
        title: 'Stages this project has occupied',
        intent: 'What was frozen at each, and what is still open now. A stage nobody closed is a stage still accruing.',
        data: stages,
        error: stages?.error,
        sections: [
          { key: 'history', label: 'History', empty: 'This project has occupied no recorded stage.' },
          { key: 'openActions', label: 'Open at this stage', empty: 'Nothing is open at the current stage.' },
          { key: 'gateReviews', label: 'Gate reviews', empty: 'No gate review has been held.' },
        ],
      })}

      ${positionReport({
        title: 'Every open commitment, once each',
        intent:
          'Across meetings, non-conformances, safety observations and stage gates. Once each, because the same ' +
          'commitment counted three times is how a register stops being believed.',
        data: { actions: Array.isArray(actions) ? actions : [] },
        error: actions?.error,
        sections: [{ key: 'actions', label: 'Open commitments', empty: 'Nothing is open against anybody.' }],
      })}

      ${positionReport({
        title: 'Decisions and escalations',
        intent: 'The action register by owner, what has escalated, and the decisions with what else was considered.',
        data: decisions,
        error: decisions?.error,
        sections: [
          { key: 'byOwner', label: 'By owner', empty: 'Nothing is owned by anybody.' },
          { key: 'escalations', label: 'Escalated', empty: 'Nothing has escalated.' },
          { key: 'decisions', label: 'Decisions, and what else was considered', empty: 'No decision has been recorded.' },
          { key: 'awaitingInstruction', label: 'Awaiting instruction', empty: 'Nothing is waiting on an instruction.' },
          { key: 'unapprovedMinutes', label: 'Minutes nobody approved', empty: 'Every set of minutes has been approved.' },
        ],
      })}

      ${positionReport({
        title: 'Lessons this project can reuse',
        intent:
          'Approved lessons only, filtered to the sector and stage their own tags say they apply to. An unfiltered ' +
          'library is one nobody reads.',
        data: { lessons: Array.isArray(reusable) ? reusable : [] },
        error: reusable?.error,
        sections: [
          { key: 'lessons', label: 'Applicable lessons', empty: 'No approved lesson applies to this sector and stage.' },
        ],
      })}
    `,
  );

  void insightPanel(root.querySelector('#control-insight'), {
    projectId,
    areas: ['PROJECT_SETUP', 'EVIDENCE_AUDIT', 'RISK_REGISTER'],
    subject: 'project control and assurance',
    onChange: draw,
  });

  // Every outstanding clause needs its own condition, so the form offers one
  // line per clause rather than a free-text box somebody fills in once.
  const outstanding = [...(gate?.failed ?? []), ...(gate?.unassessable ?? [])];

  const GATE_COMMAND = {
    title: 'Decide the stage gate',
    intent:
      'A clean pass needs all seven clauses met — including the ones the platform cannot assess, which is why it says so rather ' +
      'than passing them. A conditional pass is the real route through, and every outstanding clause needs an owner and a date.',
    path: `/v1/projects/${projectId}/stage-gate`,
    submitLabel: 'Record the decision',
    fields: [
      { name: 'decision', label: 'Decision', type: 'select',
        options: [
          { value: 'PASS_WITH_CONDITIONS', label: 'Pass with conditions' },
          { value: 'PASS', label: 'Pass' },
          { value: 'HOLD', label: 'Hold' },
        ] },
      { name: 'rationale', label: 'What the decision rests on', type: 'textarea', rows: 3 },
      { name: 'owner', label: 'Condition owner', type: 'text', required: false,
        hint: outstanding.length > 0
          ? `Applied to all ${outstanding.length} outstanding clauses: ${outstanding.join(', ')}`
          : 'No clause is outstanding' },
      { name: 'by', label: 'Conditions due by', type: 'date', required: false },
      { name: 'what', label: 'What has to happen', type: 'text', required: false },
    ],
    transform: ({ decision, rationale, owner, by, what }) =>
      decision === 'PASS_WITH_CONDITIONS'
        ? {
            decision,
            rationale,
            conditions: outstanding.map((clause) => ({
              clause,
              what: String(what ?? '').trim() || `Close ${clause}`,
              owner: String(owner ?? ''),
              by: String(by ?? ''),
            })),
          }
        : { decision, rationale },
  };

  const COMMANDS = {
    gate: GATE_COMMAND,
    meeting: {
      title: 'Minute a meeting',
      intent:
        'The record a set of minutes is generated from. Apologies are recorded rather than omitted: a decision taken in ' +
        'the absence of the party it binds is a different decision from one taken in front of them.',
      path: `/v1/projects/${projectId}/meetings`,
      submitLabel: 'Open the record',
      fields: [
        { name: 'type', label: 'Meeting', type: 'select', options: [
          { value: 'PROGRESS', label: 'Progress' },
          { value: 'DESIGN_COORDINATION', label: 'Design coordination' },
          { value: 'SITE_SAFETY', label: 'Site safety' },
          { value: 'COMMERCIAL', label: 'Commercial' },
          { value: 'PRE_START', label: 'Pre-start' },
          { value: 'SUBCONTRACTOR', label: 'Subcontractor' },
          { value: 'CLIENT', label: 'Client' },
        ] },
        { name: 'title', label: 'Subject', type: 'text', placeholder: 'Monthly progress meeting no.7' },
        {
          // `datetime-local`, not `date`. A date alone had to be turned into an
          // instant somewhere, and midday was chosen — which is in the future
          // for anybody minuting a morning meeting before lunch, so the record
          // was refused with a message about the future that made no sense to
          // the person reading it. The time is asked for instead of guessed,
          // and the document prints it: "Held 2027-06-10 at 10:00".
          name: 'heldAt',
          label: 'Held',
          type: 'datetime-local',
          value: localNow(),
          max: localNow(),
          hint: 'A meeting is minuted after it happens, so a time in the future is refused.',
        },
        { name: 'location', label: 'Where', type: 'text', placeholder: 'Site office, meeting room 1' },
        { name: 'chair', label: 'Chaired by', type: 'text' },
        {
          name: 'attendees',
          label: 'Who was there',
          type: 'textarea',
          rows: 5,
          hint: 'One per line: name, organisation, role. Add "apologies" to the end of the line for anyone who did not attend.',
          placeholder: 'A. Okafor, Meridian Infrastructure Group, Project manager\nT. Brennan, Northgate Mechanical, Package manager, apologies',
        },
      ],
      transform: ({ attendees, heldAt, ...rest }) => ({
        ...rest,
        // Parsed as local time and converted, because that is what the person
        // typed. Sending the string through as though it were UTC would move a
        // London afternoon meeting by an hour in summer.
        heldAt: new Date(heldAt).toISOString(),
        attendees: String(attendees ?? '')
          .split('\n')
          .map((line) => line.split(',').map((part) => part.trim()))
          .filter((parts) => parts[0])
          .map((parts) => ({
            name: parts[0],
            organisation: parts[1] ?? 'Not recorded',
            role: parts[2] ?? 'Not recorded',
            attended: !parts.some((part) => /^apolog/i.test(part)),
          })),
      }),
    },
    item: {
      title: 'Minute an item',
      intent:
        'What was actually said and decided, not the agenda heading repeated. Minutes with no item recorded cannot be ' +
        'issued, because there is nothing in them to issue.',
      // The meeting is chosen in the form, so the path is not known until it is.
      path: ({ meetingId }) => `/v1/projects/${projectId}/meetings/${meetingId}/agenda`,
      submitLabel: 'Minute it',
      fields: [
        { name: 'meetingId', label: 'Which meeting', type: 'select',
          options: draftMeetings.map((m) => ({ value: m.meetingId, label: `${m.reference} — ${m.title}` })) },
        { name: 'subject', label: 'Item', type: 'text', placeholder: 'Programme' },
        { name: 'discussion', label: 'What was said about it', type: 'textarea', rows: 5 },
      ],
      transform: ({ meetingId: _meetingId, ...rest }) => rest,
    },
    issue: {
      title: 'Issue the minutes',
      intent:
        'After this they are the record of what was agreed and are not amended. A correction is recorded beside them, ' +
        'never applied to them. Closing an action stays possible, because the register is live and the minutes are not.',
      path: ({ meetingId }) => `/v1/projects/${projectId}/meetings/${meetingId}/issue`,
      submitLabel: 'Issue',
      fields: [
        { name: 'meetingId', label: 'Which meeting', type: 'select',
          options: draftMeetings.map((m) => ({ value: m.meetingId, label: `${m.reference} — ${m.title}` })) },
      ],
      transform: () => ({}),
    },
    action: {
      title: 'Record an action',
      intent:
        'An action needs a person and a date. Without both it is a topic somebody mentioned, and a register of those ' +
        'stops being read.',
      path: ({ meetingId }) => `/v1/projects/${projectId}/meetings/${meetingId}/actions`,
      submitLabel: 'Record',
      fields: [
        { name: 'meetingId', label: 'Out of which meeting', type: 'select',
          options: draftMeetings.map((m) => ({ value: m.meetingId, label: `${m.reference} — ${m.title}` })) },
        { name: 'what', label: 'What has to happen', type: 'textarea', rows: 3 },
        { name: 'owner', label: 'Owner', type: 'text' },
        { name: 'ownerOrganisation', label: 'Their organisation', type: 'text' },
        { name: 'by', label: 'By', type: 'date' },
        { name: 'raisedAtMeeting', label: 'Carried from', type: 'text', required: false,
          placeholder: 'PROGRESS-002', hint: 'Leave blank if this was raised here.' },
        { name: 'originallyDue', label: 'Originally due', type: 'date', required: false,
          hint: 'For a carried action. The overdue count is measured against this, never against the restated date.' },
      ],
      transform: ({ meetingId: _meetingId, raisedAtMeeting, originallyDue, ...rest }) => ({
        ...rest,
        ...(raisedAtMeeting ? { raisedAtMeeting } : {}),
        ...(originallyDue ? { originallyDue } : {}),
      }),
    },
  };

  wireLookups(root, LOOKUPS);

  root.querySelector('.cmd-bar')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    const spec = COMMANDS[button.dataset.command];
    if (!spec) return;
    if (await command(spec)) await draw();
  });

  root.querySelector('#raise-chain')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await api.post(`/v1/projects/${projectId}/consistency/chain-exceptions`, {});
      // Said as it happened rather than as a generic success. "Raised 2" and
      // "already open, nobody re-notified" are different outcomes and a person
      // deciding whether to chase somebody needs to know which one this was.
      const parts = [];
      if (result.raised.length > 0) parts.push(`${result.raised.length} raised`);
      if (result.alreadyOpen.length > 0) parts.push(`${result.alreadyOpen.length} already open`);
      if (result.cleared.length > 0) parts.push(`${result.cleared.length} closed`);
      toast(
        parts.length > 0 ? 'Chain exception' : 'Nothing to raise',
        parts.length > 0 ? parts.join(' · ') : 'Every link traces end to end.',
        parts.length > 0 ? 'warn' : 'ok',
      );
      if (result.unaddressed) {
        toast(
          'Recorded, but not addressed',
          'Nobody on this tenancy holds Commercial Manager or Project Director, so nobody was told.',
          'warn',
        );
      }
      await draw();
    } catch (error) {
      button.disabled = false;
      toast('The exception could not be raised', error.detail ?? error.message ?? '', 'err');
    }
  });
}
