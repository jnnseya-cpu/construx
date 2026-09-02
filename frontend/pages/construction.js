import { api, entityBundle } from '../lib/api.js';
import { command, commandBar } from '../lib/command.js';
import { today as todayIso } from '../lib/enums.js';
import { badge, date, html, humanise, positionReport, raw, render, statusTone, table, toast } from '../lib/ui.js';
import { gauge } from '../lib/charts.js';
import { insightPanel } from '../lib/insight.js';
import { blockedReason, can, draw, state } from '../app.js';

/**
 * Whether the role holds a permission at all, with the lifecycle phase set
 * aside.
 *
 * `can` answers the question the button needs — may this person do this, here,
 * now — and collapses two very different noes into one. This tells the two
 * apart, so the screen can say "the project is in Operations" rather than
 * leaving somebody to conclude they lack an authority they actually hold.
 * Derived from the same published reason rather than from a second copy of the
 * matrix.
 */
function canRoleWrite(area, code) {
  const reason = blockedReason(area, code);
  return reason === null || reason.startsWith(humanise(area));
}

/**
 * Construction.
 *
 * The site manager's screen, and the five registers that had no door.
 *
 * Permits to work, method statements, inductions, non-conformances and
 * inspection and test plans were all reachable from the API and from nowhere a
 * person could get to — the generated command catalogue opened onto a text box
 * called `ramsId`. They are the five documents the platform generates for a
 * site, so the five records behind them belong on one screen held by the person
 * who is accountable for them.
 *
 * **The authority split is the permission matrix's, not this screen's.** The
 * site manager raises and the construction manager, safety lead or QA engineer
 * decides:
 *
 * | Act | Site manager | Construction manager | Safety lead | QA engineer |
 * |---|---|---|---|---|
 * | Draft a method statement | ✓ `SAFETY_RAMS C` | | ✓ | |
 * | Approve one | | | ✓ `SAFETY_RAMS A` | |
 * | Issue a permit | | | ✓ `SAFETY_RAMS A` | |
 * | Record an induction, a ticket | ✓ | | ✓ | |
 * | Create an ITP, record an inspection | ✓ `QUALITY_COMMISSIONING C` | | | ✓ |
 * | Raise a non-conformance | ✓ | | | ✓ |
 * | Close one with a disposition | | ✓ `QUALITY_COMMISSIONING A` | | ✓ |
 *
 * Nothing here is a second copy of that. Every button asks `can()`, which reads
 * the matrix the API publishes, and a locked button carries the reason from the
 * same place. The value of putting them on one screen is that the person who
 * raises them can see all five registers at once — which is the actual job.
 *
 * What a button *does* restate is the capability code its command authorises
 * against, and getting one wrong offers somebody a button the server refuses.
 * `backend/tests/construction.authority.test.ts` pins the whole table by
 * driving each act through the engine as each seeded role, so a code that moves
 * on either side fails there rather than in front of a site manager.
 *
 * **The panels are ordered by what stops work.** Permits expiring today, then
 * hold points nobody has released, then open non-conformances, then the
 * registers. A screen that opened on a list of inductions would be a screen
 * about administration.
 */

/** What a permit is refused for, in the words the refusal uses. */
const ACTIVITY = [
  { value: 'HOT_WORK', label: 'Hot work' },
  { value: 'CONFINED_SPACE', label: 'Confined space entry' },
  { value: 'WORK_AT_HEIGHT', label: 'Work at height' },
  { value: 'LIVE_ELECTRICAL', label: 'Live electrical' },
  { value: 'EXCAVATION', label: 'Excavation' },
  { value: 'LIFTING_OPERATIONS', label: 'Lifting operations' },
];

const SEVERITY = [
  { value: 'MINOR', label: 'Minor' },
  { value: 'MAJOR', label: 'Major' },
  { value: 'CRITICAL', label: 'Critical' },
];

export async function construction(root) {
  const projectId = state.session.projectId;

  const b = await entityBundle(projectId, ['Permit', 'RAMS', 'Induction', 'Competency', 'NCR', 'InspectionPlan', 'QualityInspection']);

  const [quality, cdm, requirements, safetyControl, qualityControl, holdPoints, safetyPosition, procurementItems, verification, dailyLogs, mobilisation] =
    await Promise.all([
      api.get(`/v1/projects/${projectId}/quality`).catch(() => null),
      api.get(`/v1/projects/${projectId}/cdm`).catch(() => null),
      api.get('/v1/safety/permit-requirements').catch(() => ({ requirements: [] })),
      // The control positions a site actually runs on. Every one had an engine
      // and no screen, which is why a permit could expire, a method could be
      // revised without anybody being rebriefed, and an instrument could fall
      // out of calibration with nothing on any screen saying so.
      api.get(`/v1/projects/${projectId}/safety-control`).catch((error) => ({ error })),
      api.get(`/v1/projects/${projectId}/quality-control`).catch((error) => ({ error })),
      api.get(`/v1/projects/${projectId}/quality/hold-points`).catch((error) => ({ error })),
      api.get(`/v1/projects/${projectId}/safety/position`).catch((error) => ({ error })),
      api.get(`/v1/projects/${projectId}/procurement-items`).catch((error) => ({ error })),
      api.get(`/v1/projects/${projectId}/progress-verification`).catch((error) => ({ error })),
      api.get(`/v1/projects/${projectId}/daily-logs`).catch((error) => ({ error })),
      api.get(`/v1/projects/${projectId}/mobilisation`).catch((error) => ({ error })),
    ]);

  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  const approvedRams = b.RAMS.filter((r) => r.status === 'APPROVED');
  const draftRams = b.RAMS.filter((r) => r.status !== 'APPROVED');
  const livePermits = b.Permit.filter((p) => String(p.validTo ?? '') >= now && p.status !== 'CLOSED');
  const openNcrs = b.NCR.filter((n) => n.status === 'OPEN');
  const openPlans = b.InspectionPlan.filter((p) => p.status !== 'CLOSED');

  // A ticket that lapses inside the next month is the one worth chasing: the
  // permit that needs it has usually not been written yet.
  const monthOut = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const expiringTickets = b.Competency.filter((c) => {
    const expires = String(c.expiresAt ?? '').slice(0, 10);
    return expires !== '' && expires <= monthOut;
  }).sort((a, b2) => String(a.expiresAt).localeCompare(String(b2.expiresAt)));

  // Everybody the platform knows is on this site, and whether they were
  // inducted. Read from the induction register itself rather than a headcount:
  // the question a site manager has is who is on site *without* one.
  const inducted = new Set(b.Induction.map((i) => String(i.personId)));
  const onSiteWithoutInduction = [...new Set(b.Competency.map((c) => String(c.operativeId)))].filter(
    (person) => !inducted.has(person),
  );

  // Locks with a reason, rather than a modal whose required dropdown is empty.
  const noApprovedRams =
    'No method statement is approved on this project. A permit is issued against one, and the platform refuses a permit ' +
    'that cites a draft.';
  const noOpenPlan = 'No inspection and test plan is open. An inspection is recorded against a stage of one.';
  // An inspection can only be recorded against a plan the other side has
  // agreed, so an unapproved plan is not an available one. Offering the action
  // and letting the platform refuse it would be a lock in the wrong place.
  const agreedPlans = openPlans.filter((p) => p.approvalStatus === 'APPROVED');
  const unagreedPlans = openPlans.filter((p) => p.approvalStatus !== 'APPROVED');
  const noAgreedPlan =
    unagreedPlans.length > 0
      ? `${unagreedPlans.length} plan(s) are written and not yet agreed. Nothing can be inspected against a plan the other side has not approved.`
      : noOpenPlan;
  const noOpenNcr = 'No non-conformance is open.';

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Construction</h1>
          <p>
            The five registers a site runs on. The site manager raises them and the construction manager, safety lead or
            QA engineer decides — which is the permission matrix’s split, not this screen’s.
          </p>
        </div>
        <div class="actions cmd-bar">
          ${raw(commandBar([
            {
              id: 'permit',
              label: 'Issue a permit',
              tone: '',
              // `A`, not `C`. Issuing a permit is an authorisation — it is the
              // act of allowing dangerous work to start — so `issuePermit`
              // requires approve and the safety lead, project director or owner
              // holds it. Asking for `C` here offered the site manager a button
              // the server refused, which is the dead end this screen exists to
              // remove rather than reproduce.
              permitted: can('SAFETY_RAMS', 'A') && approvedRams.length > 0,
              reason: !can('SAFETY_RAMS', 'A') ? blockedReason('SAFETY_RAMS', 'A') : noApprovedRams,
            },
            { id: 'rams', label: 'Draft a method statement', permitted: can('SAFETY_RAMS', 'C'), reason: blockedReason('SAFETY_RAMS', 'C') },
            {
              id: 'approve-rams',
              label: 'Approve one',
              permitted: can('SAFETY_RAMS', 'A') && draftRams.length > 0,
              reason: !can('SAFETY_RAMS', 'A')
                ? blockedReason('SAFETY_RAMS', 'A')
                : 'Nothing is waiting for approval.',
            },
            { id: 'induction', label: 'Record an induction', permitted: can('SAFETY_RAMS', 'C'), reason: blockedReason('SAFETY_RAMS', 'C') },
            { id: 'competency', label: 'Record a ticket', permitted: can('SAFETY_RAMS', 'C'), reason: blockedReason('SAFETY_RAMS', 'C') },
            { id: 'itp', label: 'Create an ITP', permitted: can('QUALITY_COMMISSIONING', 'C'), reason: blockedReason('QUALITY_COMMISSIONING', 'C') },
            {
              id: 'inspection',
              label: 'Record an inspection',
              // `C`, matching `recordInspection`. Asking for `U` would have
              // locked out a role that holds create and not update.
              permitted: can('QUALITY_COMMISSIONING', 'C') && agreedPlans.length > 0,
              reason: !can('QUALITY_COMMISSIONING', 'C') ? blockedReason('QUALITY_COMMISSIONING', 'C') : noAgreedPlan,
            },
            {
              id: 'approve-itp',
              label: 'Agree an ITP',
              permitted: can('QUALITY_COMMISSIONING', 'A') && unagreedPlans.length > 0,
              reason: !can('QUALITY_COMMISSIONING', 'A')
                ? blockedReason('QUALITY_COMMISSIONING', 'A')
                : 'Every inspection plan on this project has been agreed.',
            },
            { id: 'ncr', label: 'Raise a non-conformance', permitted: can('QUALITY_COMMISSIONING', 'C'), reason: blockedReason('QUALITY_COMMISSIONING', 'C') },
            {
              id: 'close-ncr',
              label: 'Disposition one',
              permitted: can('QUALITY_COMMISSIONING', 'A') && openNcrs.length > 0,
              reason: !can('QUALITY_COMMISSIONING', 'A') ? blockedReason('QUALITY_COMMISSIONING', 'A') : noOpenNcr,
            },
          ]))}
        </div>
      </div>
      <!--
        The agents that watch this area, at the point somebody is looking at the
        number they are about. The machinery was built and reachable only from
        the autopilot queue — the screen a person opens once they have already
        decided to look at what the fleet found, which is exactly backwards.
      -->
      <div id="construction-insight" style="margin-bottom:14px"></div>

      <div class="grid g4" style="margin-bottom:14px">
        <div>
          <h2>Permits live now</h2>
          <div class="metric ${raw(livePermits.length === 0 ? '' : 'good')}">${livePermits.length}</div>
          <div class="metric-sub">${b.Permit.length} issued on this project</div>
        </div>
        <div>
          <h2>Hold points not released</h2>
          <div class="metric ${raw((quality?.holdPointsOpen ?? 0) > 0 ? 'warn' : 'good')}">${quality?.holdPointsOpen ?? '—'}</div>
          <div class="metric-sub">work should not proceed past any of them</div>
        </div>
        <div>
          <h2>Non-conformances open</h2>
          <div class="metric ${raw(openNcrs.length > 0 ? 'warn' : 'good')}">${openNcrs.length}</div>
          <div class="metric-sub">${b.NCR.length - openNcrs.length} dispositioned</div>
        </div>
        <div>
          <h2>Tickets expiring within a month</h2>
          <div class="metric ${raw(expiringTickets.length > 0 ? 'warn' : 'good')}">${expiringTickets.length}</div>
          <div class="metric-sub">${b.Competency.length} qualifications on the register</div>
        </div>
      </div>

      ${
        // The quality half of this screen is phase-gated and the safety half is
        // not, so on a project past commissioning three buttons grey out with
        // the reason only in a tooltip. Said on the page instead: a person
        // looking at a disabled button is entitled to know it is the project's
        // phase and not their own permissions.
        !can('QUALITY_COMMISSIONING', 'C') && canRoleWrite('QUALITY_COMMISSIONING', 'C')
          ? html`<div class="notice info" style="margin-bottom:14px">
              <div><b>Inspection plans, inspections and non-conformances cannot be written while this project is in
              ${humanise(state.project?.phase ?? '')}.</b><br>
              That is the project's phase, not your permissions — quality records are writable from construction through
              to handover. The registers below are still readable, and the permit and method statement panels are
              unaffected.</div>
            </div>`
          : ''
      }

      ${
        onSiteWithoutInduction.length > 0
          ? html`<div class="notice warn" style="margin-bottom:14px">
              <div><b>${onSiteWithoutInduction.length} person(s) hold a ticket on this project and have no induction recorded.</b><br>
              Read from the induction register rather than from a headcount: the question is who is on site
              <em>without</em> one, and a count of inductions cannot answer it.</div>
            </div>`
          : ''
      }

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">Permits to work</h2>
        <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
          One activity, one location, two times. Work outside any of the three is unauthorised work, so the register
          shows the window rather than a status.
        </p>
        ${table({
          headers: ['Permit', 'Activity', 'Location', 'Valid from', 'Valid to', 'Operatives', 'Status'],
          align: ['', '', '', '', '', 'num', ''],
          rows: [...b.Permit]
            .sort((a, b2) => String(b2.validTo ?? '').localeCompare(String(a.validTo ?? '')))
            .map((p) => [
              p.reference,
              humanise(p.activity),
              p.location,
              date(String(p.validFrom ?? '').slice(0, 10)),
              date(String(p.validTo ?? '').slice(0, 10)),
              (p.operativeIds ?? []).length,
              String(p.validTo ?? '') < now
                ? badge('expired', 'neutral')
                : badge(humanise(p.status ?? 'ISSUED'), statusTone(p.status ?? 'ISSUED')),
            ]),
          empty: 'No permit issued — nothing high-risk on this site is authorised',
        })}
      </div>

      <div class="grid g2" style="margin-bottom:14px">
        <div class="card pad0">
          <h2 style="padding:15px 17px 0">Method statements</h2>
          <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
            A permit cites one, and the platform refuses a permit that cites a draft. The approver is never the author.
          </p>
          ${table({
            headers: ['Activity', 'Version', 'Location', 'Steps', 'Status'],
            align: ['', '', '', 'num', ''],
            rows: b.RAMS.map((r) => [
              r.activityDescription,
              r.version ?? '—',
              r.location,
              (r.steps ?? []).length,
              badge(humanise(r.status), statusTone(r.status)),
            ]),
            empty: 'No method statement drafted',
          })}
        </div>

        <div class="card pad0">
          <h2 style="padding:15px 17px 0">Inductions</h2>
          <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
            Recorded before first shift. The platform refuses one until the construction phase plan is approved, which is
            CDM enforced rather than a note.
          </p>
          ${table({
            headers: ['Person', 'Employer', 'Inducted by', 'On', 'Checked'],
            align: ['', '', '', '', 'num'],
            rows: b.Induction.map((i) => [
              i.personName ?? i.personId,
              i.employer,
              i.inductedBy,
              date(String(i.inductedAt ?? '').slice(0, 10)),
              (i.competenciesChecked ?? []).length,
            ]),
            empty: 'Nobody inducted — no record that anybody was told the site rules',
          })}
        </div>
      </div>

      ${
        expiringTickets.length > 0
          ? html`<div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">Qualifications expiring, soonest first</h2>
              <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
                A ticket that lapses on the Wednesday does not cover a permit that runs to the Friday, and the permit
                that needs it has usually not been written yet.
              </p>
              ${table({
                headers: ['Operative', 'Qualification', 'Issued', 'Expires', ''],
                rows: expiringTickets.map((c) => [
                  c.operativeId,
                  c.qualification,
                  date(String(c.issuedAt ?? '').slice(0, 10)),
                  date(String(c.expiresAt ?? '').slice(0, 10)),
                  String(c.expiresAt ?? '').slice(0, 10) < today
                    ? badge('expired', 'bad')
                    : badge('within a month', 'warn'),
                ]),
              })}
            </div>`
          : ''
      }

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">Inspection and test plans</h2>
        <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
          A hold point stops the work. A witness point must be attended. A review point is checked afterwards. The
          difference decides whether a missed step is a defect or a paperwork gap.
          ${quality?.conformancePercent === null || quality?.conformancePercent === undefined
            ? ''
            : ` ${quality.conformancePercent}% of stages have passed.`}
        </p>
        ${
          quality && (quality.stagesTotal ?? 0) > 0
            ? html`<div style="padding:4px 17px 0">
                ${gauge({
                  title: 'Stages passed',
                  value: quality.stagesPassed ?? 0,
                  max: quality.stagesTotal,
                  format: (value) => `${value} of ${quality.stagesTotal}`,
                  footnote:
                    'A stage that has not been reached counts the same as one that failed, because neither has been ' +
                    'passed. This rises as the work is inspected, not as it is built.',
                })}
              </div>`
            : ''
        }
        ${table({
          headers: ['Plan', 'Title', 'Discipline', 'Spec', 'Stages', 'Hold points', 'Agreed', 'Status'],
          align: ['', '', '', '', 'num', 'num', '', ''],
          rows: b.InspectionPlan.map((p) => [
            p.reference,
            p.title,
            humanise(p.discipline),
            p.specificationRef ?? '—',
            (p.stages ?? []).length,
            (p.stages ?? []).filter((s) => s.type === 'HOLD').length,
            // Nothing can be inspected against a plan the other side has not
            // agreed, so an unapproved plan is a blocked package rather than a
            // tidiness problem, and it belongs on the row.
            p.approvalStatus === 'APPROVED'
              ? badge(p.approvingRole ?? 'approved', 'good')
              : badge('not agreed', 'warn'),
            badge(humanise(p.status), statusTone(p.status)),
          ]),
          empty: 'No inspection plan — nothing states what is inspected or against what',
        })}
      </div>

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">Non-conformances</h2>
        <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
          Work that does not meet the specification. Use-as-is is a legitimate disposition and the one that matters: it
          accepts a departure into the permanent works, so it carries a justification and a name.
        </p>
        ${table({
          headers: ['Ref', 'What does not conform', 'Severity', 'Raised', 'Disposition', 'Status'],
          rows: b.NCR.map((n) => [
            n.reference,
            String(n.description).slice(0, 70) + (String(n.description).length > 70 ? '…' : ''),
            badge(humanise(n.severity), n.severity === 'CRITICAL' ? 'bad' : n.severity === 'MAJOR' ? 'warn' : 'neutral'),
            date(String(n.raisedAt ?? '').slice(0, 10)),
            n.disposition ? humanise(n.disposition) : '—',
            badge(humanise(n.status), statusTone(n.status)),
          ]),
          empty: 'No non-conformance raised',
        })}
      </div>

      <div class="card">
        <h2>What each of these authorises</h2>
        <p>
          These five registers are what the platform generates a permit to work, a method statement, an induction
          register, an inspection and test plan and a non-conformance report from. Each document is composed from the
          record rather than written, so what is on this screen is what appears on the page — and a register with
          nothing in it produces a refusal naming exactly what is missing, not a document with the section invented.
        </p>
        <p class="metric-sub">
          ${/* An HTML entity written here arrives on the page as its own source:
                the template escapes what it interpolates, so a bare ampersand
                is what to write. */ ''}
          ${cdm?.summary ?? 'The Principal Contractor position is on the Risk & Safety screen.'}
          ${requirements.requirements?.length ? ` ${requirements.requirements.length} permitted activities each require a named competency.` : ''}
        </p>
      </div>

      ${positionReport({
        title: 'Safety control',
        intent:
          'Revised methods nobody has been rebriefed on, permits past their expiry, and incidents never investigated. ' +
          'A permit that has expired is not a paperwork problem; it is work proceeding without the control that allowed it.',
        data: safetyControl,
        error: safetyControl?.error,
        sections: [
          { key: 'awaitingRebriefing', label: 'Method revised, nobody rebriefed', empty: 'Everybody is briefed on the current method.' },
          { key: 'expiredPermits', label: 'Permits past expiry', empty: 'No permit has expired.' },
          { key: 'uninvestigated', label: 'Incidents never investigated', empty: 'Every incident has been investigated.' },
          { key: 'openObservations', label: 'Open observations', empty: 'No site observation is open.' },
          { key: 'outstandingActions', label: 'Outstanding actions', empty: 'No safety action is outstanding.' },
        ],
      })}

      ${positionReport({
        title: 'Safety position',
        intent: 'Incidents, escalations, lost time and whether training is still current.',
        data: safetyPosition,
        error: safetyPosition?.error,
        sections: [
          { key: 'incidents', label: 'Incidents', empty: 'No incident has been recorded.' },
          { key: 'training', label: 'Training', empty: 'No training record exists.' },
          { key: 'ramsApproved', label: 'Approved method statements' },
        ],
      })}

      ${positionReport({
        title: 'Quality control',
        intent:
          'Hold points passed without release, instruments out of calibration, reopened non-conformances and ' +
          'concessions in force. An inspection signed with an out-of-calibration instrument proves nothing.',
        data: qualityControl,
        error: qualityControl?.error,
        sections: [
          { key: 'awaitingRelease', label: 'Passed, not released', empty: 'No hold point is waiting on a release.' },
          { key: 'calibration', label: 'Instruments out of calibration', empty: 'Every instrument is in calibration.' },
          { key: 'reopened', label: 'Reopened non-conformances', empty: 'No NCR has been reopened.' },
          { key: 'concessions', label: 'Concessions in force', empty: 'Nothing is being accepted by concession.' },
        ],
      })}

      ${positionReport({
        title: 'Hold points not yet released',
        intent: 'Work that cannot proceed until somebody with the authority releases it.',
        data: holdPoints,
        error: holdPoints?.error,
        sections: [{ key: 'holdPoints', label: 'Awaiting release', empty: 'No hold point is holding work up.' }],
      })}

      ${positionReport({
        title: 'Materials and long leads',
        intent: 'Long leads against their order-by dates, quarantined material, open discrepancies and installed serials.',
        data: procurementItems,
        error: procurementItems?.error,
        sections: [
          { key: 'atRisk', label: 'Past or near the order-by date', empty: 'No long lead is at risk.' },
          { key: 'quarantined', label: 'Quarantined', empty: 'Nothing is quarantined.' },
          { key: 'reconciliations', label: 'Open discrepancies', empty: 'Every delivery reconciles.' },
          { key: 'installed', label: 'Installed serials', empty: 'No serial-tracked item is recorded as installed.' },
        ],
      })}

      ${positionReport({
        title: 'Progress verification',
        intent:
          'What was claimed against what was accepted, and the rework that earns nothing. Progress nobody verified ' +
          'is an assertion, and it is the assertion payment applications are built on.',
        data: verification,
        error: verification?.error,
        sections: [
          { key: 'awaiting', label: 'Awaiting a verifier', empty: 'Nothing is waiting to be verified.' },
          { key: 'adjustments', label: 'Claimed against accepted', empty: 'No claim has been adjusted.' },
          { key: 'rework', label: 'Rework, which earns nothing', empty: 'No rework has been recorded.' },
        ],
      })}

      ${positionReport({
        title: 'Daily logs',
        intent:
          'Drafts still sitting on a device, amendments with their before and after, and any device clock drift. ' +
          'A contemporaneous record written late is worth less, and the platform records which is which.',
        data: dailyLogs,
        error: dailyLogs?.error,
        sections: [
          { key: 'drafts', label: 'Still on a device', empty: 'No draft is unsubmitted.' },
          { key: 'submitted', label: 'Submitted', empty: 'No day has been recorded.' },
          { key: 'amendments', label: 'Amendments', empty: 'No log has been amended.' },
          { key: 'clockDrift', label: 'Device clock drift', empty: 'No device clock disagreed with the platform.' },
        ],
      })}

      ${positionReport({
        title: 'Mobilisation',
        intent: 'Readiness by package, and which start authorities the information has since overtaken.',
        data: mobilisation,
        error: mobilisation?.error,
        sections: [
          { key: 'checks', label: 'Readiness checks', empty: 'No mobilisation check has been recorded.' },
          { key: 'authorisations', label: 'Start authorities', empty: 'Nothing has been authorised to start.' },
          { key: 'overdueConditions', label: 'Conditions now overdue', empty: 'No start condition is overdue.' },
        ],
      })}
    `,
  );

  const COMMANDS = {
    permit: {
      title: 'Issue a permit to work',
      intent:
        'One activity, one location, two times. The platform refuses it where an operative’s ticket does not cover the ' +
        'whole permit, checked against the permit’s end date rather than against today.',
      path: `/v1/projects/${projectId}/safety/permits`,
      submitLabel: 'Issue',
      fields: [
        { name: 'activity', label: 'Activity', type: 'select', options: ACTIVITY },
        { name: 'location', label: 'Precise location', type: 'text', placeholder: 'Inlet chamber, grid E4' },
        {
          name: 'ramsId',
          label: 'Method statement',
          type: 'select',
          hint: 'Only approved statements are offered; the platform refuses a permit that cites a draft.',
          options: approvedRams.map((r) => ({ value: r._refId, label: `${r.activityDescription} · ${r.location}` })),
        },
        {
          name: 'operativeIds',
          label: 'Operatives',
          type: 'textarea',
          rows: 3,
          hint: 'One identifier per line. Each is checked against the competency register for the whole permit window.',
        },
        { name: 'validFrom', label: 'Valid from', type: 'datetime-local' },
        { name: 'validTo', label: 'Valid to', type: 'datetime-local' },
        {
          name: 'precautions',
          label: 'Precautions',
          type: 'textarea',
          rows: 4,
          hint: 'What has to be in place before it starts and what stops it. This appears on the permit itself.',
        },
        { name: 'evidenceHash', label: 'Signed permit or briefing record', type: 'file' },
      ],
      transform: ({ operativeIds, validFrom, validTo, ...rest }) => ({
        ...rest,
        validFrom: new Date(validFrom).toISOString(),
        validTo: new Date(validTo).toISOString(),
        operativeIds: String(operativeIds ?? '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      }),
    },
    rams: {
      title: 'Draft a method statement',
      intent:
        'Drafted from the hazard library against the activity types in the steps. Every hazard the library knows for ' +
        'each step arrives with its control, so the draft is a starting point a competent person edits.',
      path: `/v1/projects/${projectId}/safety/rams`,
      aiCost: true,
      submitLabel: 'Draft',
      fields: [
        { name: 'activityDescription', label: 'Activity', type: 'text', placeholder: 'Hot work — welding of the inlet chamber access frame' },
        { name: 'location', label: 'Location', type: 'text' },
        { name: 'workPackageId', label: 'Work package', type: 'text' },
        {
          name: 'steps',
          label: 'Method steps',
          type: 'textarea',
          rows: 6,
          hint: 'One per line: what happens, then the activity type. HOT_WORK, CONFINED_SPACE, WORK_AT_HEIGHT, LIVE_ELECTRICAL, EXCAVATION, LIFTING_OPERATIONS.',
          placeholder: 'Isolate and purge the chamber, then gas test, CONFINED_SPACE\nErect the welding screen and post the fire watch, HOT_WORK',
        },
      ],
      transform: ({ steps, ...rest }) => ({
        ...rest,
        steps: String(steps ?? '')
          .split('\n')
          .map((line) => line.split(','))
          .filter((parts) => parts[0]?.trim())
          .map((parts) => ({
            description: parts.slice(0, -1).join(',').trim() || parts[0].trim(),
            activityType: (parts.length > 1 ? parts[parts.length - 1] : '').trim().toUpperCase() || 'GENERAL',
          })),
      }),
    },
    'approve-rams': {
      title: 'Approve a method statement',
      intent:
        'The approver is never the author. What is written here is on the statement and on every permit issued against ' +
        'it, so it says what was actually reviewed.',
      path: ({ ramsId }) => `/v1/projects/${projectId}/safety/rams/${ramsId}/approve`,
      submitLabel: 'Approve',
      fields: [
        {
          name: 'ramsId',
          label: 'Method statement',
          type: 'select',
          options: draftRams.map((r) => ({ value: r._refId, label: `${r.activityDescription} · ${humanise(r.status)}` })),
        },
        { name: 'reviewComments', label: 'What was reviewed', type: 'textarea', rows: 4 },
      ],
      transform: ({ ramsId: _ramsId, ...rest }) => rest,
    },
    induction: {
      title: 'Record a site induction',
      intent:
        'Before first shift. The platform refuses this until the construction phase plan is approved — CDM enforced ' +
        'rather than noted.',
      path: `/v1/projects/${projectId}/cdm/inductions`,
      submitLabel: 'Record',
      fields: [
        { name: 'personId', label: 'Person identifier', type: 'text', placeholder: 'op-welder-1' },
        { name: 'personName', label: 'Name', type: 'text' },
        { name: 'employer', label: 'Employer', type: 'text' },
        { name: 'inductedBy', label: 'Inducted by', type: 'text', value: state.session.user.name },
        {
          name: 'competenciesChecked',
          label: 'Cards and tickets checked',
          type: 'textarea',
          rows: 3,
          hint: 'One per line. This is what was seen at the gate, not what the register holds.',
        },
      ],
      transform: ({ competenciesChecked, ...rest }) => ({
        ...rest,
        competenciesChecked: String(competenciesChecked ?? '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      }),
    },
    competency: {
      title: 'Record a qualification',
      intent:
        'The register a permit is checked against. Each qualification carries its expiry, and a permit is refused where ' +
        'the ticket lapses before the permit does.',
      path: `/v1/projects/${projectId}/safety/competencies`,
      submitLabel: 'Record',
      fields: [
        { name: 'operativeId', label: 'Operative identifier', type: 'text', placeholder: 'op-welder-1' },
        { name: 'qualification', label: 'Qualification', type: 'text', placeholder: 'Hot work permit issuer' },
        { name: 'issuedAt', label: 'Issued', type: 'date', max: todayIso() },
        { name: 'expiresAt', label: 'Expires', type: 'date' },
        { name: 'certificateHash', label: 'Certificate', type: 'file' },
      ],
    },
    itp: {
      title: 'Create an inspection and test plan',
      intent:
        'Each stage names what is inspected, the criterion it is accepted against, and who is responsible. A hold point ' +
        'stops the work; a witness point does not but must be attended.',
      path: `/v1/projects/${projectId}/quality/plans`,
      submitLabel: 'Create',
      fields: [
        { name: 'title', label: 'Title', type: 'text', placeholder: 'In situ concrete — clarifier walls' },
        { name: 'workPackageId', label: 'Work package', type: 'text' },
        { name: 'discipline', label: 'Discipline', type: 'text', placeholder: 'CIVILS' },
        { name: 'specificationRef', label: 'Specification section', type: 'text', required: false, placeholder: 'E10' },
        {
          name: 'stages',
          label: 'Stages',
          type: 'textarea',
          rows: 7,
          hint: 'One per line: reference, what is inspected, acceptance criterion, type (HOLD, WITNESS or REVIEW), who is responsible.',
          placeholder:
            'S1, Reinforcement inspection before covering, E10/3.4 — released by the Engineer, HOLD, Engineer\n' +
            'S2, Cube sampling at the specified rate, E10/3.5 — one set per 50m3, WITNESS, QA engineer',
        },
      ],
      transform: ({ stages, ...rest }) => ({
        ...rest,
        stages: String(stages ?? '')
          .split('\n')
          .map((line) => line.split(',').map((part) => part.trim()))
          .filter((parts) => parts[0])
          .map((parts) => ({
            reference: parts[0],
            description: parts[1] ?? '',
            acceptanceCriteria: parts[2] ?? '',
            type: (parts[3] ?? 'REVIEW').toUpperCase(),
            responsible: parts[4] ?? '',
            status: 'PENDING',
          })),
      }),
    },
    'approve-itp': {
      title: 'Agree an inspection and test plan',
      intent:
        'Approval is the other side agreeing what will be inspected and against what. Nothing can be inspected against a ' +
        'plan until it happens, and the person who wrote the plan cannot approve it.',
      path: ({ planId }) => `/v1/projects/${projectId}/quality/plans/${planId}/approve`,
      submitLabel: 'Agree the plan',
      fields: [
        {
          name: 'planId',
          label: 'Inspection plan',
          type: 'select',
          options: unagreedPlans.map((plan) => ({
            value: plan._refId,
            label: `${plan.reference} · ${String(plan.title).slice(0, 50)}`,
          })),
        },
        { name: 'approvedBy', label: 'Approving identity', type: 'text', hint: 'Not the identity that wrote the plan.' },
        {
          name: 'approvingRole',
          label: 'Approving as',
          type: 'text',
          placeholder: "Employer's Representative",
          hint: 'Whose approval this is. It goes on the record beside the plan.',
        },
        {
          name: 'note',
          label: 'Qualification',
          type: 'textarea',
          rows: 3,
          required: false,
          hint: 'Approving with comments is normal. Say what they are.',
        },
        { name: 'evidenceHash', label: 'Evidence of the approval', type: 'file' },
      ],
    },
    inspection: {
      title: 'Record an inspection',
      intent:
        'Against a stage of a plan, at the point it can still be seen. A failure raises the non-conformance in the same ' +
        'act — leaving it to be raised separately is how a failed inspection becomes a verbal conversation.',
      path: `/v1/projects/${projectId}/quality/inspections`,
      submitLabel: 'Record',
      fields: [
        {
          name: 'planId',
          label: 'Plan',
          type: 'select',
          options: openPlans.map((p) => ({ value: p._refId, label: `${p.reference} · ${p.title}` })),
        },
        { name: 'stageReference', label: 'Stage', type: 'text', placeholder: 'S1' },
        {
          name: 'outcome',
          label: 'Outcome',
          type: 'select',
          options: [
            { value: 'PASS', label: 'Pass' },
            { value: 'PASS_WITH_COMMENT', label: 'Pass with comment' },
            { value: 'FAIL', label: 'Fail — raises a non-conformance' },
          ],
        },
        { name: 'inspectedBy', label: 'Inspected by', type: 'text', value: state.session.user.name },
        { name: 'comments', label: 'Comments', type: 'textarea', rows: 3 },
        { name: 'evidenceHash', label: 'Photograph or test record', type: 'file' },
        {
          name: 'ncrDescription',
          label: 'If it failed: what does not conform',
          type: 'textarea',
          rows: 3,
          required: false,
          hint: 'Required on a failure. Ten characters or more, because "not right" is not a non-conformance.',
        },
        {
          name: 'ncrSeverity',
          label: 'If it failed: severity',
          type: 'select',
          required: false,
          placeholder: 'Not a failure',
          options: SEVERITY,
        },
        { name: 'ncrAction', label: 'If it failed: proposed action', type: 'textarea', rows: 2, required: false },
      ],
      transform: ({ ncrDescription, ncrSeverity, ncrAction, ...rest }) => ({
        ...rest,
        // Only where there is one. Sending an empty non-conformance object with
        // a passing inspection would be a defect raised against work that passed.
        ...(String(ncrDescription ?? '').trim()
          ? {
              nonConformance: {
                description: String(ncrDescription),
                severity: String(ncrSeverity || 'MAJOR'),
                proposedAction: String(ncrAction ?? ''),
              },
            }
          : {}),
      }),
    },
    ncr: {
      title: 'Raise a non-conformance',
      intent:
        'Work that does not meet the specification and needs a disposition. Distinct from a snag: a snag is put right ' +
        'before handover, a non-conformance is a decision somebody has to own.',
      path: `/v1/projects/${projectId}/quality/ncrs`,
      submitLabel: 'Raise',
      fields: [
        { name: 'description', label: 'What does not conform', type: 'textarea', rows: 4 },
        { name: 'severity', label: 'Severity', type: 'select', options: SEVERITY },
        { name: 'proposedAction', label: 'Proposed action', type: 'textarea', rows: 3 },
        { name: 'workPackageId', label: 'Work package', type: 'text', required: false },
        { name: 'evidenceHash', label: 'Photograph or test record', type: 'file' },
      ],
    },
    'close-ncr': {
      title: 'Disposition a non-conformance',
      intent:
        'Use-as-is is permitted and is the one that matters: accepting work that does not meet specification is a ' +
        'decision with a name against it, and it goes on the report in those words.',
      path: ({ ncrId }) => `/v1/projects/${projectId}/quality/ncrs/${ncrId}/close`,
      submitLabel: 'Record the disposition',
      fields: [
        {
          name: 'ncrId',
          label: 'Non-conformance',
          type: 'select',
          options: openNcrs.map((n) => ({ value: n._refId, label: `${n.reference} · ${String(n.description).slice(0, 50)}` })),
        },
        {
          name: 'disposition',
          label: 'Disposition',
          type: 'select',
          options: [
            { value: 'REWORK', label: 'Rework — take it out and do it again' },
            { value: 'REPAIR', label: 'Repair — a concession against the specification' },
            { value: 'USE_AS_IS', label: 'Use as is — a departure accepted into the permanent works' },
            { value: 'REJECT', label: 'Reject — it is removed' },
          ],
        },
        {
          name: 'justification',
          label: 'Justification',
          type: 'textarea',
          rows: 4,
          hint: 'On the non-conformance report, in full. Anybody relying on this project meeting its specification will read it.',
        },
        { name: 'evidenceHash', label: 'Evidence of the disposition', type: 'file' },
      ],
      transform: ({ ncrId: _ncrId, ...rest }) => rest,
    },
  };

  void insightPanel(root.querySelector('#construction-insight'), {
    projectId,
    areas: ['SAFETY_RAMS', 'QUALITY_COMMISSIONING', 'FIELD_EXECUTION'],
    subject: 'the site registers',
    onChange: draw,
  });

  root.querySelector('.cmd-bar')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    const spec = COMMANDS[button.dataset.command];
    if (!spec) return;
    const result = await command(spec);
    if (!result) return;
    // A failed inspection that raised one says so, because the person who
    // recorded the failure is the person who has to chase it.
    if (result.ncrId) toast('Non-conformance raised', `${result.ncrReference ?? result.ncrId} — it now needs a disposition.`, 'warn');
    await draw();
  });
}
