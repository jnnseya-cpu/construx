import { api, entityBundle } from '../lib/api.js';
import { command, commandBar } from '../lib/command.js';
import { today as todayIso } from '../lib/enums.js';
import { badge, date, html, humanise, notice, positionReport, raw, reference, render, statusTone, table, toast } from '../lib/ui.js';
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

  const b = await entityBundle(projectId, [
    'Permit', 'RAMS', 'Induction', 'Competency', 'NCR', 'InspectionPlan', 'QualityInspection', 'ToolboxTalk',
    // The registers the three write doors below operate against. Read through
    // the same classification as every other type — a role without read on the
    // area gets an empty list and the door locks with the reason, rather than a
    // modal onto nothing.
    'Task', 'Delivery', 'ProgressSubmission', 'SystemNode',
  ]);

  const [quality, cdm, requirements, safetyControl, qualityControl, holdPoints, safetyPosition, procurementItems, verification, dailyLogs, mobilisation, exceptions, testPacks] =
    await Promise.all([
      api.read(`/v1/projects/${projectId}/quality`, 'QUALITY_COMMISSIONING').catch(() => null),
      api.read(`/v1/projects/${projectId}/cdm`, 'SAFETY_RAMS').catch(() => null),
      api.get('/v1/safety/permit-requirements').catch(() => ({ requirements: [] })),
      // The control positions a site actually runs on. Every one had an engine
      // and no screen, which is why a permit could expire, a method could be
      // revised without anybody being rebriefed, and an instrument could fall
      // out of calibration with nothing on any screen saying so.
      api.read(`/v1/projects/${projectId}/safety-control`, 'SAFETY_RAMS').catch((error) => ({ error })),
      api.read(`/v1/projects/${projectId}/quality-control`, 'QUALITY_COMMISSIONING').catch((error) => ({ error })),
      api.read(`/v1/projects/${projectId}/quality/hold-points`, 'QUALITY_COMMISSIONING').catch((error) => ({ error })),
      api.read(`/v1/projects/${projectId}/safety/position`, 'SAFETY_RAMS').catch((error) => ({ error })),
      api.read(`/v1/projects/${projectId}/procurement-items`, 'PROCUREMENT_AWARD').catch((error) => ({ error })),
      api.read(`/v1/projects/${projectId}/progress-verification`, 'FIELD_EXECUTION').catch((error) => ({ error })),
      api.read(`/v1/projects/${projectId}/daily-logs`, 'FIELD_EXECUTION').catch((error) => ({ error })),
      api.read(`/v1/projects/${projectId}/mobilisation`, 'FIELD_EXECUTION').catch((error) => ({ error })),
      // CM-WF-07. The exception chain belongs to the people who hold
      // `QUALITY_COMMISSIONING`, and this is the screen they can open — a
      // supervisor holds writes on it and cannot open Handover, which is gated
      // on `HANDOVER_OM`. Putting these doors there offered them to somebody
      // who could not reach the room.
      api.read(`/v1/projects/${projectId}/commissioning-exceptions`, 'QUALITY_COMMISSIONING').catch((error) => ({ error })),
      api.read(`/v1/projects/${projectId}/test-packs`, 'QUALITY_COMMISSIONING').catch((error) => ({ error })),
    ]);

  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  // A commissioning exception that is closed takes no further act, so the five
  // doors that operate on one are locked with the reason rather than opened
  // onto an empty dropdown.
  const openExceptionList = (exceptions?.exceptions ?? []).filter((entry) => entry.status !== 'CLOSED');
  const openExceptions = openExceptionList.length;
  const noOpenException = 'No commissioning exception is open on this project';

  const approvedRams = b.RAMS.filter((r) => r.status === 'APPROVED');
  const draftRams = b.RAMS.filter((r) => r.status !== 'APPROVED');

  // Drafted means written and not yet given. A talk recorded before drafts
  // existed carries no status at all, and absent means delivered — at the time
  // it was the only kind there was.
  const draftedTalks = b.ToolboxTalk.filter((t) => t.status === 'DRAFTED');
  const deliveredTalks = b.ToolboxTalk.filter((t) => t.status !== 'DRAFTED');
  // A method statement can hold one open draft, so the ones already carrying
  // it are not offered again — the server refuses a second with a 409 and this
  // is that refusal moved to the control.
  const ramsWithOpenDraft = new Set(draftedTalks.map((t) => String(t.ramsId ?? '')));
  const briefableRams = approvedRams.filter((r) => !ramsWithOpenDraft.has(r._refId));
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

  // --- CN-WF-04 progress claim and verification (the money path) -------------
  //
  // The register was read-only: the position below reported what was claimed
  // and accepted and nothing could write to it. These three doors are the whole
  // of it — a basis to measure against, a claim, and a certification by
  // somebody else.
  const measuredActivities = verification && !verification.error ? verification.activities ?? [] : [];
  const awaitingClaims = b.ProgressSubmission.filter((s) => s.status === 'SUBMITTED');
  // The two-person rule, surfaced at the door rather than discovered at it. The
  // person who claimed the progress cannot certify it, so a verifier is never
  // offered their own claims — the platform refuses it either way.
  const verifiableClaims = awaitingClaims.filter((s) => String(s.submittedBy) !== String(state.session.user.id));
  const noTask = 'No activity exists to measure. Tasks are created on the programme.';
  const noMeasuredActivity =
    'No activity has a measurement basis. Set one first — a claim needs the unit it is made in and the control total it is checked against.';
  const noClaimToVerify =
    awaitingClaims.length > 0
      ? 'The only claims awaiting a verifier are ones you submitted, and the person who claims progress cannot be the person who certifies it.'
      : 'No progress claim is awaiting a verifier.';

  // --- CN-WF-05 deliveries / goods-in ----------------------------------------
  //
  // The page read `/procurement-items` and had no way to receive anything. The
  // ladder is register → book → receive → (quarantine → release) → accept →
  // install, and each door offers only the deliveries in the state its act
  // applies to, so the sequence is the one the platform enforces.
  const procItems = procurementItems && !procurementItems.error ? procurementItems.items ?? [] : [];
  const bookedDeliveries = b.Delivery.filter((d) => d.state === 'BOOKED');
  const receivedDeliveries = b.Delivery.filter((d) => d.state === 'RECEIVED');
  const quarantinedDeliveries = b.Delivery.filter((d) => d.state === 'QUARANTINED');
  const quarantinableDeliveries = b.Delivery.filter((d) => d.state === 'BOOKED' || d.state === 'RECEIVED');
  const installableDeliveries = b.Delivery.filter(
    (d) => d.state === 'ACCEPTED' && (d.units ?? []).some((u) => !u.installedAt),
  );
  const deliveryLabel = (d) => `${d.reference} · ${d.itemReference ?? d.itemId}`;
  const noItem = 'No procurement item is registered. Register one first — a delivery is booked against an item.';
  const noBooked = 'No delivery is booked and awaiting receipt.';
  const noReceived = 'No delivery has been received and is waiting to be accepted into stock.';
  const noQuarantined = 'Nothing is in quarantine.';
  const noQuarantinable = 'No delivery is on site to quarantine.';
  const noInstallable = 'No accepted delivery carries a serial still to be installed.';

  // --- Commissioning dossier -------------------------------------------------
  //
  // `accept-system` dead-ended with NO_DOSSIER because there was no door to
  // compile one. This is that door.
  const systemTags = [...new Set(b.SystemNode.map((n) => String(n.tag)))];
  const noSystem = 'No system is defined on this project. A dossier is compiled for a defined system.';

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
            {
              id: 'toolbox-draft',
              label: 'Draft a toolbox talk',
              permitted: can('SAFETY_RAMS', 'C') && briefableRams.length > 0,
              reason: !can('SAFETY_RAMS', 'C')
                ? blockedReason('SAFETY_RAMS', 'C')
                : approvedRams.length === 0
                  ? noApprovedRams
                  : 'Every approved method statement already has a talk drafted and waiting to be given.',
            },
            {
              id: 'toolbox-deliver',
              label: 'Give a talk',
              tone: draftedTalks.length > 0 ? 'primary' : '',
              permitted: can('SAFETY_RAMS', 'C') && draftedTalks.length > 0,
              reason: !can('SAFETY_RAMS', 'C')
                ? blockedReason('SAFETY_RAMS', 'C')
                : 'Nothing is drafted and waiting. Draft one from an approved method statement first.',
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
            // CM-WF-07 and CM-WF-08. The same authority split the table above
            // describes: recording what was done about a failure is `U`, and
            // closing it or accepting a system is `A`. Offering the approval to
            // somebody who holds only the update is offering a refusal.
            { id: 'exception-action', label: 'Record corrective action',
              permitted: can('QUALITY_COMMISSIONING', 'U') && openExceptions > 0,
              reason: !can('QUALITY_COMMISSIONING', 'U') ? blockedReason('QUALITY_COMMISSIONING', 'U') : noOpenException },
            { id: 'exception-retest', label: 'Start a retest',
              permitted: can('QUALITY_COMMISSIONING', 'U') && openExceptions > 0,
              reason: !can('QUALITY_COMMISSIONING', 'U') ? blockedReason('QUALITY_COMMISSIONING', 'U') : noOpenException },
            { id: 'exception-impact', label: 'Confirm what it invalidates',
              permitted: can('QUALITY_COMMISSIONING', 'A') && openExceptions > 0,
              reason: !can('QUALITY_COMMISSIONING', 'A') ? blockedReason('QUALITY_COMMISSIONING', 'A') : noOpenException },
            { id: 'exception-close', label: 'Close an exception',
              permitted: can('QUALITY_COMMISSIONING', 'A') && openExceptions > 0,
              reason: !can('QUALITY_COMMISSIONING', 'A') ? blockedReason('QUALITY_COMMISSIONING', 'A') : noOpenException },
            { id: 'exception-conditional', label: 'Accept conditionally',
              permitted: can('QUALITY_COMMISSIONING', 'A') && openExceptions > 0,
              reason: !can('QUALITY_COMMISSIONING', 'A') ? blockedReason('QUALITY_COMMISSIONING', 'A') : noOpenException },
            { id: 'accept-system', label: 'Accept a system',
              permitted: can('QUALITY_COMMISSIONING', 'A'), reason: blockedReason('QUALITY_COMMISSIONING', 'A') },

            // CN-WF-04. Setting the basis is a statement about scope, so it is
            // WORKPACKAGES_TASKS U; the claim is a field act (C); the
            // certification is an approval (A) the claimant may not make.
            { id: 'set-measurement-basis', label: 'Set a measurement basis',
              permitted: can('WORKPACKAGES_TASKS', 'U') && (b.Task ?? []).length > 0,
              reason: !can('WORKPACKAGES_TASKS', 'U') ? blockedReason('WORKPACKAGES_TASKS', 'U') : noTask },
            { id: 'submit-progress-claim', label: 'Claim progress',
              permitted: can('FIELD_EXECUTION', 'C') && measuredActivities.length > 0,
              reason: !can('FIELD_EXECUTION', 'C') ? blockedReason('FIELD_EXECUTION', 'C') : noMeasuredActivity },
            { id: 'verify-claim', label: 'Verify a claim',
              permitted: can('FIELD_EXECUTION', 'A') && verifiableClaims.length > 0,
              reason: !can('FIELD_EXECUTION', 'A') ? blockedReason('FIELD_EXECUTION', 'A') : noClaimToVerify },

            // CN-WF-05. Registering and tracking the item is the buyer's
            // (PROCUREMENT_AWARD); booking, receiving, accepting and installing
            // are the site's (FIELD_EXECUTION); quarantine and release are
            // quality's (QUALITY_COMMISSIONING).
            { id: 'register-item', label: 'Register a procurement item',
              permitted: can('PROCUREMENT_AWARD', 'C'), reason: blockedReason('PROCUREMENT_AWARD', 'C') },
            { id: 'advance-milestone', label: 'Advance a procurement milestone',
              permitted: can('PROCUREMENT_AWARD', 'U') && procItems.length > 0,
              reason: !can('PROCUREMENT_AWARD', 'U') ? blockedReason('PROCUREMENT_AWARD', 'U') : noItem },
            { id: 'book-delivery', label: 'Book a delivery',
              permitted: can('FIELD_EXECUTION', 'C') && procItems.length > 0,
              reason: !can('FIELD_EXECUTION', 'C') ? blockedReason('FIELD_EXECUTION', 'C') : noItem },
            { id: 'receive-delivery', label: 'Receive a delivery',
              permitted: can('FIELD_EXECUTION', 'C') && bookedDeliveries.length > 0,
              reason: !can('FIELD_EXECUTION', 'C') ? blockedReason('FIELD_EXECUTION', 'C') : noBooked },
            { id: 'quarantine-delivery', label: 'Quarantine material',
              permitted: can('QUALITY_COMMISSIONING', 'C') && quarantinableDeliveries.length > 0,
              reason: !can('QUALITY_COMMISSIONING', 'C') ? blockedReason('QUALITY_COMMISSIONING', 'C') : noQuarantinable },
            { id: 'release-delivery', label: 'Release from quarantine',
              permitted: can('QUALITY_COMMISSIONING', 'A') && quarantinedDeliveries.length > 0,
              reason: !can('QUALITY_COMMISSIONING', 'A') ? blockedReason('QUALITY_COMMISSIONING', 'A') : noQuarantined },
            { id: 'accept-delivery', label: 'Accept a delivery',
              permitted: can('FIELD_EXECUTION', 'A') && receivedDeliveries.length > 0,
              reason: !can('FIELD_EXECUTION', 'A') ? blockedReason('FIELD_EXECUTION', 'A') : noReceived },
            { id: 'install-unit', label: 'Install a serial',
              permitted: can('FIELD_EXECUTION', 'U') && installableDeliveries.length > 0,
              reason: !can('FIELD_EXECUTION', 'U') ? blockedReason('FIELD_EXECUTION', 'U') : noInstallable },

            // The door that lets `accept-system` succeed.
            { id: 'compile-dossier', label: 'Compile a dossier',
              permitted: can('QUALITY_COMMISSIONING', 'C') && systemTags.length > 0,
              reason: !can('QUALITY_COMMISSIONING', 'C') ? blockedReason('QUALITY_COMMISSIONING', 'C') : noSystem },
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

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">Toolbox talks</h2>
        <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
          Drafted from the approved method statement — its controls in sequence, nothing invented. A draft evidences
          nothing until it is given: the attendance is the record, and the CDM position counts only what was delivered.
        </p>
        ${table({
          headers: ['Subject', 'From', 'Covers', 'Points', 'State', 'Attended'],
          align: ['', '', 'num', 'num', '', 'num'],
          rows: [...draftedTalks, ...deliveredTalks].map((t) => [
            t.subject,
            t.ramsId ? reference(t.ramsId) : 'Given straight',
            // Said out loud rather than left to be discovered. A method
            // statement with more steps than a talk can carry needs two talks,
            // and a briefing that silently dropped half of one is the failure
            // this column exists to prevent.
            t.ofSteps ? `${t.coversSteps} of ${t.ofSteps}` : '—',
            (t.keyPoints ?? []).length,
            badge(
              t.status === 'DRAFTED' ? 'Drafted, not given' : 'Delivered',
              t.status === 'DRAFTED' ? 'warn' : 'ok',
            ),
            t.status === 'DRAFTED' ? '—' : (t.attendees ?? []).length,
          ]),
          empty: 'No toolbox talk drafted or given. An approved method statement nobody was briefed on is a document, not a control.',
        })}
        ${draftedTalks
          .filter((t) => (t.uncoveredSteps ?? []).length > 0)
          .map((t) =>
            notice(
              `“${t.subject}” does not cover its whole method statement — ${(t.uncoveredSteps ?? []).length} step(s) are not in it: ` +
                `${(t.uncoveredSteps ?? []).join('; ')}. A talk that long stops being a talk, so this needs a second one.`,
              'warn',
            ),
          )}
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

  // CM-WF-07 and CM-WF-08, given doors.
  //
  // Every rule below this line was already built, authorised and tested — the
  // exception chain, the retest against a released pack revision, the dossier
  // scored over its required records, the acceptance an operator puts their
  // name to. What none of it had was a way in. The generated command catalogue
  // could reach each route, but its form asks for an exception id in a text
  // box, which is not a door a commissioning manager opens at four o'clock on
  // a Friday with a fan still failing its duty test.
  //
  // So the options come from the positions this page already reads. Nothing
  // here re-decides anything: the platform still refuses a closure with no
  // succeeding result, a retest before a corrective action, and an acceptance
  // over an open safety-critical exception. These are the same refusals,
  // reachable.
  // Only the ones a retest result can be recorded against: a retest that has
  // already been decided is not offered a second verdict.
  const openExceptionOptions = openExceptionList
    .map((entry) => ({ value: entry.exceptionId, label: `${entry.reference} · ${entry.systemTag}` }));
  // Every defined system, not only the ones carrying an exception. A system
  // can be compiled and accepted with no exception against it at all, so a list
  // drawn from exceptions alone would offer `accept-system` nothing to act on
  // for exactly the systems `compile-dossier` has just made ready.
  const systemOptions = [...new Set([
    ...(exceptions?.exceptions ?? []).map((entry) => entry.systemTag),
    ...systemTags,
  ])].map((tag) => ({ value: tag, label: tag }));

  const COMMANDS = {
    'exception-action': {
      title: 'Record what was done about the failure',
      intent:
        'Containment first — what stops it mattering now — then the corrective action, with the evidence behind it. ' +
        'A retest before this is the same test again, and it fails again.',
      path: (v) => `/v1/projects/${projectId}/commissioning-exceptions/${v.exceptionId}/corrective-action`,
      submitLabel: 'Record it',
      fields: [
        { name: 'exceptionId', label: 'Exception', type: 'select', options: openExceptionOptions,
          hint: openExceptionOptions.length === 0 ? 'No exception is open on this project' : '' },
        { name: 'containment', label: 'Containment', type: 'textarea', rows: 2,
          hint: 'What stops this mattering while it is being fixed. Locking a unit off is containment; intending to fix it is not.' },
        { name: 'corrective', label: 'Corrective action', type: 'textarea', rows: 3 },
        { name: 'evidenceHash', label: 'The evidence', type: 'file', voice: false },
        { name: 'changeLinkage', label: 'Change reference', type: 'text', required: false,
          hint: 'Where the fix was a change rather than a repair, the change it was made under.' },
        { name: 'completedBy', label: 'Completed by', type: 'text', value: state.session.user.name },
      ],
      transform: ({ exceptionId, changeLinkage, ...rest }) => ({ ...rest, ...(changeLinkage ? { changeLinkage } : {}) }),
    },

    'exception-impact': {
      title: 'Confirm what else this invalidates',
      intent:
        'The tests that assumed this one was right are now unproven, and the ones already passed are the dangerous ones ' +
        'because they read as complete. The platform will not decide the scope — an engineer confirms it — but it will ' +
        'not let the exception close until somebody has.',
      path: (v) => `/v1/projects/${projectId}/commissioning-exceptions/${v.exceptionId}/impact`,
      submitLabel: 'Confirm the scope',
      fields: [
        { name: 'exceptionId', label: 'Exception', type: 'select', options: openExceptionOptions },
        { name: 'invalidatedTests', label: 'Tests this invalidates', type: 'textarea', rows: 3, required: false,
          hint: 'One reference per line. Leave blank only if nothing else is affected — and say why below.' },
        { name: 'rationale', label: 'Why these and not others', type: 'textarea', rows: 3,
          hint: '"Nothing else is affected" is a finding somebody stands behind, not a default.' },
        { name: 'confirmedBy', label: 'Confirmed by', type: 'text', value: state.session.user.name },
      ],
      transform: ({ exceptionId, invalidatedTests, ...rest }) => ({
        ...rest,
        invalidatedTests: String(invalidatedTests ?? '').split('\n').map((line) => line.trim()).filter(Boolean),
      }),
    },

    'exception-retest': {
      title: 'Start a controlled retest',
      intent:
        'Against a released pack revision, so the retest is a controlled one and the record says which revision it was ' +
        'run to. Refused before a corrective action has been recorded.',
      path: (v) => `/v1/projects/${projectId}/commissioning-exceptions/${v.exceptionId}/retest`,
      submitLabel: 'Start',
      fields: [
        { name: 'exceptionId', label: 'Exception', type: 'select', options: openExceptionOptions },
        { name: 'packId', label: 'Test pack', type: 'select',
          options: ((testPacks?.packs ?? []).filter((pack) => pack.status === 'RELEASED')
            .map((pack) => ({ value: pack.packId, label: `${pack.reference} · ${pack.systemTag}` }))),
          hint: 'Only released packs. An unreleased one is not a controlled retest.' },
        { name: 'startedBy', label: 'Run by', type: 'text', value: state.session.user.name },
      ],
      transform: ({ exceptionId, ...rest }) => rest,
    },

    'exception-close': {
      title: 'Close the exception',
      intent:
        'Closure adds a verified succeeding result. It changes nothing about the failure — the original reading, its ' +
        'instrument, its performer and its timestamp all stay exactly where they are, because the history of what ' +
        'failed is what makes the retest mean anything.',
      path: (v) => `/v1/projects/${projectId}/commissioning-exceptions/${v.exceptionId}/close`,
      submitLabel: 'Close it',
      fields: [
        { name: 'exceptionId', label: 'Exception', type: 'select', options: openExceptionOptions },
        { name: 'verifiedBy', label: 'Verified by', type: 'text', value: state.session.user.name },
        { name: 'verification', label: 'What they saw', type: 'textarea', rows: 3,
          hint: 'An exception closed on an assurance is the one found again at handover.' },
      ],
      transform: ({ exceptionId, ...rest }) => rest,
    },

    'exception-conditional': {
      title: 'Accept a safety-critical exception conditionally',
      intent:
        'Deliberately harder than a closure. What is being accepted is a system that does not do what it was specified ' +
        'to do while people are in the building, so it needs an exceptional authority by name, a restriction saying ' +
        'what may not happen until it clears, and a date it is reviewed by.',
      path: (v) => `/v1/projects/${projectId}/commissioning-exceptions/${v.exceptionId}/conditional-acceptance`,
      submitLabel: 'Accept conditionally',
      fields: [
        { name: 'exceptionId', label: 'Exception', type: 'select', options: openExceptionOptions },
        { name: 'authority', label: 'Exceptional authority', type: 'text',
          hint: 'Signed by the person who raised it is not an exceptional authority.' },
        { name: 'operatingRestriction', label: 'Operating restriction', type: 'textarea', rows: 2,
          hint: 'What may not happen while this stands. One with no restriction is an unconditional acceptance.' },
        { name: 'reviewBy', label: 'Reviewed by', type: 'date', min: todayIso() },
      ],
      transform: ({ exceptionId, ...rest }) => rest,
    },

    'accept-system': {
      title: 'Accept a system into operation',
      intent:
        'The party accepting it is the party running it at three in the morning, so it is named. Blocked over an open ' +
        'safety-critical exception, and refused while the dossier is missing a record an operator cannot start without.',
      path: `/v1/projects/${projectId}/system-acceptances`,
      submitLabel: 'Record the decision',
      fields: [
        { name: 'systemTag', label: 'System', type: 'select', options: systemOptions,
          hint: systemOptions.length === 0 ? 'No system carries an exception on this project yet' : '' },
        { name: 'decision', label: 'Decision', type: 'select', options: [
          { value: 'ACCEPTED', label: 'Accepted' },
          { value: 'CONDITIONAL', label: 'Accepted with conditions' },
          { value: 'REJECTED', label: 'Rejected' },
        ] },
        { name: 'acknowledgedBy', label: 'Operator or owner accepting', type: 'text' },
        { name: 'acknowledgedForOrganisation', label: 'Acting for', type: 'text' },
        { name: 'note', label: 'What is being accepted, or why not', type: 'textarea', rows: 2 },
        // The four parts of a condition, together. A condition missing any of
        // them becomes permanent, so the platform refuses a partial set — and
        // the form asks for all four rather than letting somebody discover that.
        { name: 'operatingLimits', label: 'Operating limits', type: 'textarea', rows: 2, required: false,
          hint: 'Conditional acceptance only.' },
        { name: 'riskOwner', label: 'Risk owner', type: 'text', required: false, hint: 'Conditional acceptance only.' },
        { name: 'expiresOn', label: 'Condition expires', type: 'date', required: false, min: todayIso() },
        { name: 'closurePlan', label: 'Plan for closing it', type: 'textarea', rows: 2, required: false },
      ],
      transform: ({ operatingLimits, riskOwner, expiresOn, closurePlan, ...rest }) => ({
        ...rest,
        ...(rest.decision === 'CONDITIONAL'
          ? { conditions: { operatingLimits, riskOwner, expiresOn, closurePlan } }
          : {}),
      }),
    },

    // ---- CN-WF-04 progress claim and verification ----------------------------

    'set-measurement-basis': {
      title: 'Set a measurement basis',
      intent:
        'What the activity is measured in, how, and against what control total — with the drawing, model or bill item it ' +
        'came from. Nothing cumulative may later exceed the control total, and a claim in another unit is refused.',
      path: (v) => `/v1/projects/${projectId}/tasks/${v.taskId}/measurement-basis`,
      submitLabel: 'Set the basis',
      fields: [
        { name: 'taskId', label: 'Activity', type: 'select',
          options: (b.Task ?? []).map((t) => ({ value: t._refId, label: `${t.activityCode ? `${t.activityCode} · ` : ''}${t.name}` })) },
        { name: 'unit', label: 'Unit', type: 'text', placeholder: 'm3',
          hint: 'What it is measured in. A claim made in a different unit is refused, because two units against one activity cannot be added.' },
        { name: 'controlTotal', label: 'Control total', type: 'number', min: 0, step: 'any',
          hint: 'The quantity that exists. More accepted than this is either a measurement error or an unraised change.' },
        { name: 'measurementRule', label: 'How it is measured', type: 'textarea', rows: 3,
          hint: 'The rule, not a number — net excavated volume to formation, structural steel by the schedule, and so on.' },
        { name: 'source', label: 'Where the control total came from', type: 'text', placeholder: 'C-2101 rev P05, bill item 2.4.1',
          hint: 'A control total nobody can trace is one nobody can argue with when a claim exceeds it.' },
      ],
      transform: ({ taskId: _taskId, controlTotal, ...rest }) => ({ ...rest, controlTotal: Number(controlTotal) }),
    },
    'submit-progress-claim': {
      title: 'Claim installed progress',
      intent:
        'Installed quantity against an activity, a location and a period, with the evidence it rests on. The same three ' +
        'again is refused — the same pour claimed twice is paid for twice. Rework is recorded and earns nothing.',
      path: (v) => `/v1/projects/${projectId}/tasks/${v.taskId}/progress-claims`,
      submitLabel: 'Submit the claim',
      fields: [
        // The claim is made in the activity's own basis unit — looked up from
        // the selected activity in the transform rather than retyped, so a
        // UNIT_MISMATCH is impossible by construction.
        { name: 'taskId', label: 'Activity', type: 'select',
          options: measuredActivities.map((a) => ({ value: a.taskId, label: `${a.name} · measured in ${a.unit}` })) },
        { name: 'quantity', label: 'Quantity installed', type: 'number', min: 0, step: 'any' },
        { name: 'location', label: 'Where', type: 'text', placeholder: 'Grid A4, pour 3',
          hint: 'A claim with no location cannot be checked against last week’s, which is how the same work gets claimed twice.' },
        { name: 'periodFrom', label: 'Period from', type: 'date' },
        { name: 'periodTo', label: 'Period to', type: 'date' },
        { name: 'costCode', label: 'Cost code', type: 'text', required: false },
        { name: 'rework', label: 'This is rework (redone work — earns nothing)', type: 'checkbox' },
        { name: 'evidenceDescription', label: 'What the evidence shows', type: 'textarea', rows: 2 },
        { name: 'evidenceHash', label: 'Evidence', type: 'file',
          hint: 'A progress claim carries the evidence it rests on — this is the record a valuation is built from.' },
      ],
      transform: ({ taskId, quantity, rework, costCode, ...rest }) => {
        const basis = measuredActivities.find((a) => a.taskId === taskId);
        return {
          ...rest,
          quantity: Number(quantity),
          unit: basis ? basis.unit : '',
          rework: rework === true,
          ...(String(costCode ?? '').trim() ? { costCode: String(costCode).trim() } : {}),
        };
      },
    },
    'verify-claim': {
      title: 'Verify a progress claim',
      intent:
        'Accept, adjust or reject what was claimed. The submitted quantity is never overwritten — the gap between claimed ' +
        'and accepted is the finding. An adjustment carries a quantity and the evidence behind it, and the person who ' +
        'submitted the claim cannot be the person who certifies it.',
      path: (v) => `/v1/projects/${projectId}/progress-claims/${v.submissionId}/verify`,
      submitLabel: 'Record the decision',
      fields: [
        { name: 'submissionId', label: 'Claim', type: 'select',
          options: verifiableClaims.map((s) => ({
            value: s._refId,
            label: `${s.reference} · ${s.submittedQuantity}${s.unit} at ${s.location}`,
          })) },
        { name: 'decision', label: 'Decision', type: 'select', options: [
          { value: 'ACCEPTED', label: 'Accepted — the claim as submitted' },
          { value: 'ADJUSTED', label: 'Adjusted — accept a different quantity, with evidence' },
          { value: 'REJECTED', label: 'Rejected — nothing is accepted' },
        ] },
        { name: 'acceptedQuantity', label: 'Accepted quantity', type: 'number', min: 0, step: 'any', required: false,
          hint: 'An adjustment only. It must differ from what was claimed, or there is nothing to adjust.' },
        { name: 'rationale', label: 'What the decision rests on', type: 'textarea', rows: 3 },
        { name: 'evidenceDescription', label: 'What the verifier saw', type: 'textarea', rows: 2, required: false,
          hint: 'Required on an adjustment — what the claim did not show.' },
        { name: 'evidenceHash', label: 'Evidence', type: 'file', required: false },
      ],
      transform: ({ submissionId: _submissionId, ...rest }) => rest,
      report: (response) =>
        response.acceptedQuantity !== response.submittedQuantity
          ? {
              title: 'Claim verified',
              message: `Claimed ${response.submittedQuantity}, accepted ${response.acceptedQuantity} — the gap is kept on the record.`,
              tone: 'warn',
            }
          : null,
    },

    // ---- CN-WF-05 deliveries / goods-in --------------------------------------

    'register-item': {
      title: 'Register a procurement item',
      intent:
        'A purchased item with the date the programme needs it and the lead time it takes. The platform works out the date ' +
        'it must be ordered by, and says — before anybody has done anything wrong — if it cannot arrive in time.',
      path: `/v1/projects/${projectId}/procurement-items`,
      submitLabel: 'Register',
      fields: [
        { name: 'reference', label: 'Reference', type: 'text', placeholder: 'PI-014' },
        { name: 'description', label: 'Description', type: 'textarea', rows: 2, placeholder: 'DN300 penstock valve, flanged, manual gearbox' },
        { name: 'quantity', label: 'Quantity', type: 'number', min: 0, step: 'any' },
        { name: 'unit', label: 'Unit', type: 'text', placeholder: 'nr' },
        { name: 'requiredOnSiteBy', label: 'Required on site by', type: 'date' },
        { name: 'leadTimeDays', label: 'Lead time in days', type: 'number', min: 0 },
        { name: 'safetyCritical', label: 'Safety-critical (needs a certificate or it is quarantined)', type: 'checkbox' },
        { name: 'unitRateMinor', label: 'Unit rate', type: 'number', min: 0, step: 'any', money: true, required: false,
          hint: 'Used to accrue on acceptance. Optional.' },
        { name: 'substitutionSubmittalRef', label: 'Substitution submittal', type: 'text', required: false,
          hint: 'Only where the product differs from what was specified.' },
      ],
      transform: ({ quantity, leadTimeDays, safetyCritical, unitRateMinor, substitutionSubmittalRef, ...rest }) => ({
        ...rest,
        quantity: Number(quantity),
        leadTimeDays: Number(leadTimeDays),
        safetyCritical: safetyCritical === true,
        ...(unitRateMinor === undefined || String(unitRateMinor) === '' ? {} : { unitRateMinor: Number(unitRateMinor) }),
        ...(String(substitutionSubmittalRef ?? '').trim() ? { substitutionSubmittalRef: String(substitutionSubmittalRef).trim() } : {}),
      }),
    },
    'advance-milestone': {
      title: 'Advance a procurement milestone',
      intent:
        'Move an item along its ladder. Every step names the evidence it rests on — the order number, the approved ' +
        'submittal, the FAT certificate, the bill of lading. Delivery and acceptance are recorded by receiving, not declared.',
      path: (v) => `/v1/projects/${projectId}/procurement-items/${v.itemId}/milestones`,
      submitLabel: 'Record the step',
      fields: [
        { name: 'itemId', label: 'Item', type: 'select',
          options: procItems.map((i) => ({ value: i.itemId, label: `${i.reference} · ${String(i.description).slice(0, 40)}` })) },
        { name: 'step', label: 'Step reached', type: 'select', options: [
          { value: 'REQUISITION', label: 'Requisition' },
          { value: 'RFQ', label: 'RFQ' },
          { value: 'ORDER', label: 'Order' },
          { value: 'DESIGN_APPROVAL', label: 'Design approval' },
          { value: 'MANUFACTURE', label: 'Manufacture' },
          { value: 'FAT', label: 'Factory acceptance test' },
          { value: 'SHIPMENT', label: 'Shipment' },
          { value: 'CUSTOMS', label: 'Customs' },
        ] },
        { name: 'evidence', label: 'Evidence', type: 'text', placeholder: 'PO-9001',
          hint: '“In manufacture” from a supplier who has not started is the commonest overstatement on any project; a document is the only defence.' },
        { name: 'note', label: 'Note', type: 'text', required: false },
      ],
      transform: ({ itemId: _itemId, note, ...rest }) => ({ ...rest, ...(String(note ?? '').trim() ? { note: String(note).trim() } : {}) }),
    },
    'book-delivery': {
      title: 'Book a delivery',
      intent:
        'Into a date and a slot. Two lifts in one slot is refused rather than discovered on the day — a wasted morning for ' +
        'one of them and sometimes a damaged load.',
      path: (v) => `/v1/projects/${projectId}/procurement-items/${v.itemId}/deliveries`,
      submitLabel: 'Book',
      fields: [
        { name: 'itemId', label: 'Item', type: 'select',
          options: procItems.map((i) => ({ value: i.itemId, label: `${i.reference} · ${String(i.description).slice(0, 40)}` })) },
        { name: 'bookedFor', label: 'Booked for', type: 'date' },
        { name: 'slot', label: 'Slot', type: 'text', placeholder: '09:00-10:00' },
        { name: 'craneRequired', label: 'Needs the crane', type: 'checkbox' },
      ],
      transform: ({ itemId: _itemId, craneRequired, ...rest }) => ({ ...rest, craneRequired: craneRequired === true }),
    },
    'receive-delivery': {
      title: 'Receive a delivery',
      intent:
        'What actually turned up. Safety-critical material with no certificate against a traceable unit is quarantined on ' +
        'arrival — while the lorry is still on site, which is the one moment it is cheap to catch.',
      path: (v) => `/v1/projects/${projectId}/deliveries/${v.deliveryId}/receive`,
      submitLabel: 'Record receipt',
      fields: [
        { name: 'deliveryId', label: 'Delivery', type: 'select',
          options: bookedDeliveries.map((d) => ({ value: d._refId, label: deliveryLabel(d) })) },
        { name: 'deliveryNote', label: 'Delivery note number', type: 'text',
          hint: 'What the invoice will be matched against. The argument three months later is always about which load it was.' },
        { name: 'dispatchedQuantity', label: 'Dispatched quantity', type: 'number', min: 0, step: 'any' },
        { name: 'receivedQuantity', label: 'Received quantity', type: 'number', min: 0, step: 'any' },
        { name: 'condition', label: 'Condition on arrival', type: 'text', placeholder: 'Sound, no visible damage' },
        { name: 'damaged', label: 'Arrived damaged', type: 'checkbox' },
        { name: 'units', label: 'Traceable units', type: 'textarea', rows: 4, required: false,
          hint: 'One per line: identifier, then its certificate. Safety-critical material needs a certificate against every unit or it is quarantined.',
          placeholder: 'VLV-0001, MillCert-AI-88213\nVLV-0002, MillCert-AI-88214' },
        { name: 'evidenceHash', label: 'Delivery note and photographs', type: 'file' },
      ],
      transform: ({ deliveryId: _deliveryId, dispatchedQuantity, receivedQuantity, damaged, units, ...rest }) => {
        const parsed = String(units ?? '')
          .split('\n')
          .map((line) => line.split(',').map((part) => part.trim()))
          .filter((parts) => parts[0])
          .map((parts) => ({ identifier: parts[0], ...(parts[1] ? { certificate: parts.slice(1).join(', ') } : {}) }));
        return {
          ...rest,
          dispatchedQuantity: Number(dispatchedQuantity),
          receivedQuantity: Number(receivedQuantity),
          damaged: damaged === true,
          ...(parsed.length > 0 ? { units: parsed } : {}),
        };
      },
      report: (response) =>
        response.quarantined
          ? { title: 'Quarantined on arrival', message: `${response.reference} is quarantined — it cannot be accepted or installed until it is released.`, tone: 'warn' }
          : null,
    },
    'quarantine-delivery': {
      title: 'Quarantine material',
      intent:
        'Hold material nobody may use, with what is wrong with it. Quarantine is a state the material cannot leave without ' +
        'somebody with quality authority saying why.',
      path: (v) => `/v1/projects/${projectId}/deliveries/${v.deliveryId}/quarantine`,
      submitLabel: 'Quarantine',
      fields: [
        { name: 'deliveryId', label: 'Delivery', type: 'select',
          options: quarantinableDeliveries.map((d) => ({ value: d._refId, label: `${deliveryLabel(d)} · ${humanise(d.state)}` })) },
        { name: 'why', label: 'What is wrong with it', type: 'textarea', rows: 3,
          hint: 'Somebody has to be able to clear it, so say what would.' },
      ],
      transform: ({ deliveryId: _deliveryId, ...rest }) => rest,
    },
    'release-delivery': {
      title: 'Release from quarantine',
      intent:
        'On quality authority, naming what resolved it — the certificate that arrived, the test that passed, the batch that ' +
        'was traced. Safety-critical material is not released while a certificate is still missing.',
      path: (v) => `/v1/projects/${projectId}/deliveries/${v.deliveryId}/release`,
      submitLabel: 'Release',
      fields: [
        { name: 'deliveryId', label: 'Delivery', type: 'select',
          options: quarantinedDeliveries.map((d) => ({ value: d._refId, label: deliveryLabel(d) })) },
        { name: 'reason', label: 'What resolved it', type: 'textarea', rows: 3 },
        { name: 'units', label: 'Traceable units now certified', type: 'textarea', rows: 3, required: false,
          hint: 'One per line: identifier, then its certificate. Supply the certificate that was missing, or the release is refused.',
          placeholder: 'VLV-0001, MillCert-AI-88213' },
      ],
      transform: ({ deliveryId: _deliveryId, units, ...rest }) => {
        const parsed = String(units ?? '')
          .split('\n')
          .map((line) => line.split(',').map((part) => part.trim()))
          .filter((parts) => parts[0])
          .map((parts) => ({ identifier: parts[0], ...(parts[1] ? { certificate: parts.slice(1).join(', ') } : {}) }));
        return { ...rest, ...(parsed.length > 0 ? { units: parsed } : {}) };
      },
    },
    'accept-delivery': {
      title: 'Accept a delivery into stock',
      intent:
        'Once, and never over an unreconciled difference or a quarantine. What was ordered, dispatched and received are ' +
        'three numbers, and a mismatch is accepted only with a reconciliation naming which it is and who is chasing it.',
      path: (v) => `/v1/projects/${projectId}/deliveries/${v.deliveryId}/accept`,
      submitLabel: 'Accept',
      fields: [
        { name: 'deliveryId', label: 'Delivery', type: 'select',
          options: receivedDeliveries.map((d) => ({ value: d._refId, label: deliveryLabel(d) })) },
        { name: 'note', label: 'What was checked', type: 'textarea', rows: 2 },
        { name: 'reconciliationKind', label: 'Reconciliation', type: 'select', required: false, placeholder: 'No difference',
          options: [
            { value: 'SHORT', label: 'Short — less arrived than was ordered' },
            { value: 'OVER', label: 'Over — more arrived than was ordered' },
            { value: 'DAMAGED', label: 'Damaged' },
          ],
          hint: 'Required where what arrived is not what was ordered, or it arrived damaged.' },
        { name: 'reconciliationWhat', label: 'What happened', type: 'textarea', rows: 2, required: false },
        { name: 'reconciliationChasedBy', label: 'Who is chasing it', type: 'text', required: false },
      ],
      transform: ({ deliveryId: _deliveryId, reconciliationKind, reconciliationWhat, reconciliationChasedBy, ...rest }) => ({
        ...rest,
        ...(reconciliationKind
          ? { reconciliation: { kind: reconciliationKind, what: String(reconciliationWhat ?? ''), chasedBy: String(reconciliationChasedBy ?? '') } }
          : {}),
      }),
    },
    'install-unit': {
      title: 'Install a serial into the works',
      intent:
        'A serial, where it went and the test that proves it works there. Those two facts turn a delivery note into an ' +
        'as-built record. Only an accepted delivery can be installed, and one serial cannot be in two places.',
      path: (v) => `/v1/projects/${projectId}/deliveries/${v.deliveryId}/install`,
      submitLabel: 'Record the installation',
      fields: [
        { name: 'deliveryId', label: 'Delivery', type: 'select',
          options: installableDeliveries.map((d) => ({
            value: d._refId,
            label: `${deliveryLabel(d)} · ${(d.units ?? []).filter((u) => !u.installedAt).length} to install`,
          })) },
        { name: 'identifier', label: 'Serial', type: 'text',
          hint: 'A batch, heat number or serial received under this delivery.' },
        { name: 'location', label: 'Where it went', type: 'text', placeholder: 'Inlet chamber, grid E4' },
        { name: 'testEvidence', label: 'The test that proves it works there', type: 'text' },
      ],
      transform: ({ deliveryId: _deliveryId, ...rest }) => rest,
    },

    // ---- Commissioning dossier -----------------------------------------------

    'compile-dossier': {
      title: 'Compile a commissioning dossier',
      intent:
        'Compile the dossier for one system. Completeness is counted over the required records, not the file count, and a ' +
        'second copy of one record raises nothing. A system is accepted into operation only once the records an operator ' +
        'cannot start without are all present.',
      path: `/v1/projects/${projectId}/commissioning-dossiers`,
      submitLabel: 'Compile',
      fields: [
        { name: 'systemTag', label: 'System', type: 'select',
          options: systemTags.map((tag) => ({ value: tag, label: tag })) },
        { name: 'compiledBy', label: 'Compiled by', type: 'text', value: state.session.user.name },
        { name: 'entries', label: 'Records', type: 'textarea', rows: 8,
          hint:
            'One per line: key, reference, revision, evidence. Keys — AS_BUILT, OM_MANUAL, TEST_RECORDS, CERTIFICATES, ' +
            'FIRE_SAFETY_INFORMATION, ASSET_DATA, TRAINING_RECORDS, SETTINGS (critical); WARRANTY, SPARES, MAINTENANCE, ' +
            'ACCESS (advisory). The critical ones are the records an operator cannot start without.',
          placeholder:
            'AS_BUILT, DOC-ASB-VENT, C, EV-ASB\nOM_MANUAL, OM-VENT, C, EV-OM\nTEST_RECORDS, TR-VENT, C, EV-TR' },
      ],
      transform: ({ systemTag, compiledBy, entries }) => ({
        systemTag,
        compiledBy,
        entries: String(entries ?? '')
          .split('\n')
          .map((line) => line.split(',').map((part) => part.trim()))
          .filter((parts) => parts[0])
          .map((parts) => ({
            key: (parts[0] ?? '').toUpperCase(),
            reference: parts[1] ?? '',
            revision: parts[2] ?? '',
            evidenceRef: parts[3] ?? '',
          })),
      }),
      report: (response) => ({
        title: 'Dossier compiled',
        message:
          `${response.completenessPercent}% complete over the required records.` +
          ((response.missing ?? []).length > 0 ? ` Missing: ${response.missing.join(', ')}.` : ' Nothing is missing — the system can be accepted.'),
        tone: (response.missing ?? []).length > 0 ? 'warn' : 'ok',
      }),
    },

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
    'toolbox-draft': {
      title: 'Draft a toolbox talk',
      intent:
        'Assembled from the approved method statement — its controls in sequence, its PPE and its competency schedule. ' +
        'Nothing is generated: every point is the statement’s own wording. Nobody is briefed until somebody gives it.',
      path: `/v1/projects/${projectId}/cdm/toolbox-talk-drafts`,
      submitLabel: 'Draft',
      fields: [
        {
          name: 'ramsId',
          label: 'Method statement',
          type: 'select',
          options: briefableRams.map((r) => ({ value: r._refId, label: `${r.activityDescription} · ${r.location}` })),
        },
        {
          name: 'subject',
          label: 'Subject',
          type: 'text',
          hint: 'Left blank, the talk takes the activity and location off the method statement.',
        },
        {
          name: 'siteSpecificApplication',
          label: 'How it applies here today',
          type: 'textarea',
          rows: 3,
          hint:
            'The half of a talk the document cannot supply — which corner, which gate, what changed since yesterday. ' +
            'Optional, and the talk is thinner without it.',
        },
      ],
      transform: ({ subject, siteSpecificApplication, ...rest }) => ({
        ...rest,
        ...(String(subject ?? '').trim() ? { subject: String(subject).trim() } : {}),
        ...(String(siteSpecificApplication ?? '').trim()
          ? { siteSpecificApplication: String(siteSpecificApplication).trim() }
          : {}),
      }),
    },
    'toolbox-deliver': {
      title: 'Give a toolbox talk',
      intent:
        'The attendance is the record. A talk with nobody against it is refused — not as a form validation but because ' +
        'a briefing nobody attended briefed nobody.',
      path: `/v1/projects/${projectId}/cdm/toolbox-talks`,
      submitLabel: 'Record',
      fields: [
        {
          name: 'draftId',
          label: 'Talk',
          type: 'select',
          options: draftedTalks.map((t) => ({
            value: t._refId,
            label: `${t.subject} · ${(t.keyPoints ?? []).length} points`,
          })),
        },
        { name: 'deliveredBy', label: 'Given by', type: 'text', value: state.session.user.name },
        {
          name: 'attendees',
          label: 'Who was there',
          type: 'textarea',
          rows: 4,
          hint: 'One identifier per line. This is the list somebody signs, not a headcount.',
        },
      ],
      transform: ({ attendees, ...rest }) => ({
        ...rest,
        attendees: String(attendees ?? '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      }),
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

  /*
   * Every command bar on the screen, not the first one.
   *
   * `querySelector` returns one element. A screen with more than one command
   * bar — and most of them have several, one per panel — wired the first and
   * left the rest inert: the buttons drew, they were not locked, they carried
   * their `data-command`, and pressing them did nothing at all. Reported as
   * "none of these work" on Pipeline & Bids, which renders six.
   *
   * Safe to bind every bar because the handler returns on an id this page does
   * not own, which is the pattern the evidence doors on this page already used
   * with `querySelectorAll` — one bar can carry buttons for two dispatchers.
   */
  /*
   * Delegated from the view, not from a `.cmd-bar` wrapper.
   *
   * `commandBar()` returns bare buttons. Whether they end up inside an element
   * classed `cmd-bar` is up to whichever page called it, and several wrap them
   * in `.actions` instead — so on those screens no listener was ever bound and
   * every button drew, unlocked, carrying its `data-command`, and did nothing.
   * That is seven commands on Concept, four on Field Modules and four more
   * elsewhere, all of them invisible to the suite because the markup is right
   * and only the binding is missing.
   *
   * Binding here removes the coupling rather than adding a second class to
   * remember. It is safe on both counts: the handler returns on an id this
   * page does not own, so two dispatchers can share one view, and `#view` is
   * a fresh element on every `draw()`, so listeners cannot stack.
   */
  root.addEventListener('click', async (event) => {
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
