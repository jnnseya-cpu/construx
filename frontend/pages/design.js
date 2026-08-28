import { api, entities, entityBundle } from '../lib/api.js';
import { command, commandBar } from '../lib/command.js';
import { DISCIPLINE, today } from '../lib/enums.js';
import { badge, date, drillable, html, humanise, money, pct, positionReport, raw, render, statusTone, table, time, toast } from '../lib/ui.js';
import { insightPanel } from '../lib/insight.js';
import { blockedReason, can, draw, state } from '../app.js';

/**
 * Design & BIM.
 *
 * Drawing control matters as much as the model: most projects price and build
 * from 2D long before a model is trustworthy, and someone working to a
 * superseded revision is a defect waiting to happen. Supersession is enforced
 * by the platform, not left to a filing convention.
 */

export async function design(root) {
  const projectId = state.session.projectId;

  // Activities, so a markup can name what its answer is holding up.
  const tasks = await entities(projectId, 'Task').catch(() => []);

  const b = await entityBundle(projectId, [
    'Drawing',
    'DrawingMarkup',
    'Model',
    'Clash',
    'DigitalTwinState',
    'RFI',
    'DesignMaturityAssessment',
    // The clauses a submittal cites. A submittal that answers nothing cannot be
    // reviewed against anything, so the form offers real clauses rather than a
    // text box called clauseId.
    'SpecClause',
  ]);

  const clauses = b.SpecClause;

  // Where every review stands. The engine computes duration, overdue and whose
  // it is, so the screen renders an answer rather than doing arithmetic.
  const reviews = await api.get(`/v1/projects/${projectId}/design/reviews`).catch(() => null);

  // Material and technical submittals. On this screen because a submittal
  // answers a specification clause and is decided by the designer, which is the
  // same two parties and the same area as everything else here.
  const submittals = await api
    .get(`/v1/projects/${projectId}/submittals`)
    .catch(() => ({ submittals: [], summary: '', pastOrderingDate: 0, reviewsOverdue: 0, atRisk: 0, circling: 0 }));

  // Who could check a design, read from the ownership map rather than guessed.
  // The author picks a name from people the matrix says can actually do it —
  // and the engine refuses the author themselves, whoever is chosen.
  const ownership = await api.get('/v1/ownership').catch(() => ({ areas: [] }));
  const designOwners = (ownership.areas ?? []).find((entry) => entry.area === 'DESIGN_INFORMATION');

  const current = b.Drawing.filter((d) => d.status === 'CURRENT');
  const superseded = b.Drawing.filter((d) => d.status === 'SUPERSEDED');
  const openClashes = b.Clash.filter((c) => c.status === 'OPEN');
  const criticalClashes = openClashes.filter((c) => c.severity === 'CRITICAL');
  const asBuilt = b.Model.filter((m) => m.status === 'AS_BUILT');
  const maturity = b.DesignMaturityAssessment.at(-1);
  const twin = b.DigitalTwinState.at(-1);

  // The register read as a delay exhibit rather than a count: how long questions
  // stayed open, and whether the answers arrived after they were needed.
  const rfi = await api.get(`/v1/projects/${projectId}/rfi/position`).catch(() => null);

  // What the late information is worth. "Eleven RFIs overdue" gets noted;
  // a figure in money gets acted on.
  const exposure = await api.get(`/v1/projects/${projectId}/rfi/exposure`).catch(() => null);

  // Not the count. What is still critical, and where a closeout left the model
  // describing something that was not built.
  const clashes = await api.get(`/v1/projects/${projectId}/bim/clashes/position`).catch(() => null);

  // What the specification demands against what the inspection plans actually
  // check. The gap exists only between the two documents, so neither the
  // quality manager nor the engineer can see it on their own.
  const spec = await api.get(`/v1/projects/${projectId}/specifications/coverage`).catch(() => null);
  const deviations = b.DigitalTwinState.reduce((sum, s) => sum + Number(s.deviationCount ?? 0), 0);

  // Each tile's own records, so opening a figure shows the events that moved it.
  const drawingSources = current.map((d) => ({ refType: 'Drawing', refId: d._refId }));
  const modelSources = b.Model.map((m) => ({ refType: 'Model', refId: m._refId }));
  const clashSources = openClashes.map((c) => ({ refType: 'Clash', refId: c._refId }));
  const twinSources = b.DigitalTwinState.map((t) => ({ refType: 'DigitalTwinState', refId: t._refId }));

  // Reading a drawing rather than being told what it says. Both are fetched
  // rather than assumed: whether this deployment has a provider that can look
  // at a file is a fact about the deployment, and which evidence the platform
  // actually holds is a fact about the project.
  // What the next few weeks of work is waiting on. Answerable only because an
  // RFI now names the activity it holds up.
  const readiness = await api.get(`/v1/projects/${projectId}/design/readiness`).catch(() => null);

  const [perception, evidence, packages, constructability, coordination, changes, baselines, gate, infoControl, currentInfo] =
    await Promise.all([
      api.get(`/v1/projects/${projectId}/perception`).catch(() => null),
      api.get(`/v1/projects/${projectId}/evidence`).catch(() => null),
      // The design plan and the control positions over it. Every one of these
      // had an engine, a route and tests, and no screen — so the MIDP could
      // disagree with itself, a package could be frozen against a revision a
      // later one invalidated, and nobody could see either.
      api.get(`/v1/projects/${projectId}/design-packages`).catch((error) => ({ error })),
      api.get(`/v1/projects/${projectId}/constructability`).catch((error) => ({ error })),
      api.get(`/v1/projects/${projectId}/coordination`).catch((error) => ({ error })),
      api.get(`/v1/projects/${projectId}/design-changes`).catch((error) => ({ error })),
      api.get(`/v1/projects/${projectId}/design-baselines`).catch((error) => ({ error })),
      api.get(`/v1/projects/${projectId}/stages/design/validate`).catch((error) => ({ error })),
      api.get(`/v1/projects/${projectId}/information-control`).catch((error) => ({ error })),
      api.get(`/v1/projects/${projectId}/current-information`).catch((error) => ({ error })),
    ]);
  const readable = (evidence?.entries ?? []).filter(
    (entry) => entry.held && ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(entry.contentType ?? ''),
  );
  const openDrafts = (perception?.drafts ?? []).filter((d) => d.status === 'DRAFT');

  // Declared here rather than below the render call, which is where they used
  // to sit.
  //
  // The command bar reads `underReview.length` inside the template, and a
  // template literal is evaluated where it is written — so for any role holding
  // `A` on DESIGN_INFORMATION the whole screen died with "Cannot access
  // 'underReview' before initialization". Every other role was spared only
  // because `can(...)` short-circuits ahead of it, which is why a latent
  // reference error survived in a page that looked fine to most people.
  const openReviews = (reviews?.cycles ?? []).filter((cycle) => cycle.status === 'IN_REVIEW');
  const underReview = (submittals.submittals ?? []).filter((sub) => sub.status === 'UNDER_REVIEW');

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Design &amp; BIM</h1>
          <p>Drawing control, model ingestion, clash triage by rework cost, and a twin fed by what the site actually looks like.</p>
        </div>
        <div class="actions cmd-bar">
          ${raw(commandBar([
            { id: 'drawing', label: 'Register drawing', tone: '', permitted: can('DESIGN_INFORMATION', 'C'), reason: blockedReason('DESIGN_INFORMATION', 'C') },
            { id: 'submit-review', label: 'Submit for review', permitted: can('DESIGN_INFORMATION', 'C'), reason: blockedReason('DESIGN_INFORMATION', 'C') },
            { id: 'comment', label: 'Raise a review comment', permitted: can('DESIGN_INFORMATION', 'R'), reason: blockedReason('DESIGN_INFORMATION', 'R') },
            { id: 'decide-review', label: 'Decide a review', permitted: can('DESIGN_INFORMATION', 'A'), reason: blockedReason('DESIGN_INFORMATION', 'A') },
            { id: 'markup', label: 'Add markup', permitted: can('DESIGN_INFORMATION', 'C'), reason: blockedReason('DESIGN_INFORMATION', 'C') },
            { id: 'answer', label: 'Answer an RFI', permitted: can('DESIGN_INFORMATION', 'U'), reason: blockedReason('DESIGN_INFORMATION', 'U') },
            { id: 'resolve-clash', label: 'Close a clash', permitted: can('BIM_TWIN', 'A'), reason: blockedReason('BIM_TWIN', 'A') },
            { id: 'specification', label: 'Read a specification', permitted: can('DESIGN_INFORMATION', 'I'), reason: blockedReason('DESIGN_INFORMATION', 'I') },
            {
              id: 'submittal',
              label: 'Raise a submittal',
              permitted: can('DESIGN_INFORMATION', 'C') && clauses.length > 0,
              reason: !can('DESIGN_INFORMATION', 'C')
                ? blockedReason('DESIGN_INFORMATION', 'C')
                : 'No specification clause has been read on this project. A submittal answers a clause, and one citing a clause that does not exist cannot be reviewed against anything.',
            },
            {
              id: 'decide-submittal',
              label: 'Decide a submittal',
              permitted: can('DESIGN_INFORMATION', 'A') && underReview.length > 0,
              reason: !can('DESIGN_INFORMATION', 'A')
                ? blockedReason('DESIGN_INFORMATION', 'A')
                : 'Nothing is with the reviewer.',
            },
          ]))}
        </div>
      </div>

      ${
        exposure && exposure.overdueCount > 0
          ? html`<div class="card" style="margin-bottom:14px">
              <h2>What the late design information is costing</h2>
              <div class="grid g4" style="margin-top:10px">
                <div>
                  <div class="metric-sub">Overdue</div>
                  <div class="metric">${exposure.overdueCount}</div>
                  <div class="metric-sub">worst ${exposure.worstDaysOverdue}d late</div>
                </div>
                <div>
                  <div class="metric-sub">Programme float</div>
                  <div class="metric">${exposure.floatDays}d</div>
                  <div class="metric-sub">before any delay reaches completion</div>
                </div>
                <div>
                  <div class="metric-sub">Beyond float</div>
                  <div class="metric ${raw(exposure.daysBeyondFloatIfCritical > 0 ? 'bad' : 'good')}">
                    ${exposure.daysBeyondFloatIfCritical}d
                  </div>
                  <div class="metric-sub">${money(exposure.dailyDamagesMinor)} per day under the contract</div>
                </div>
                <div>
                  <div class="metric-sub">${exposure.basis === 'COMPUTED' ? 'Exposure' : 'Exposure if critical'}</div>
                  <div class="metric ${raw((exposure.basis === 'CONDITIONAL' ? exposure.exposureIfCriticalMinor : exposure.computedExposureMinor) > 0 ? 'bad' : 'good')}">
                    ${money(exposure.basis === 'CONDITIONAL' ? exposure.exposureIfCriticalMinor : exposure.computedExposureMinor)}
                  </div>
                  <div class="metric-sub">
                    ${
                      exposure.basis === 'CONDITIONAL'
                        ? 'conditional — no overdue RFI names an activity'
                        : exposure.basis === 'COMPUTED'
                          ? 'read off the network, not supposed'
                          : `computed from ${exposure.linkedCount} of ${exposure.overdueCount}`
                    }
                  </div>
                </div>
              </div>
              <div class="metric-sub" style="margin-top:11px">
                ${exposure.qualification}
                ${exposure.toMakeExact ? html`<br><b>To make it exact:</b> ${exposure.toMakeExact}` : ''}
              </div>
              ${
                (exposure.blockedActivities ?? []).length > 0
                  ? html`<div style="margin-top:12px">
                      ${table({
                        headers: ['Activity', 'On critical path', 'Float', 'Days late', 'Beyond float', 'Questions'],
                        align: ['', '', 'num', 'num', 'num', ''],
                        rows: exposure.blockedActivities.map((a) => [
                          a.taskName,
                          a.onCriticalPath ? badge('critical', 'bad') : badge('has slack', 'neutral'),
                          `${a.totalFloat}d`,
                          `${a.daysOverdue}d`,
                          `${a.daysBeyondFloat}d`,
                          a.rfiReferences.join(', '),
                        ]),
                      })}
                      <div class="metric-sub" style="margin-top:8px">
                        One row per activity, not per question: two RFIs against the same activity hold it up once. Concurrent
                        critical delays are not added either — the job finishes late by the worst of them.
                      </div>
                    </div>`
                  : ''
              }
            </div>`
          : ''
      }

      ${
        criticalClashes.length > 0
          ? html`<div class="notice warn">
              <div><b>${criticalClashes.length} critical clash(es) unresolved.</b><br>
              Severity is weighted by the cost of fixing it once built — structural and below-ground clashes triage ahead of finishes.</div>
            </div>`
          : ''
      }

      <div class="grid g4" style="margin-bottom:14px">
        <div ${raw(drillable('Current drawings', drawingSources))}>
          <h2>Current drawings</h2>
          <div class="metric orange">${current.length}</div>
          <div class="metric-sub">${superseded.length} superseded and locked from markup</div>
        </div>
        <div ${raw(drillable('Models ingested', modelSources))}>
          <h2>Models ingested</h2>
          <div class="metric">${b.Model.length}</div>
          <div class="metric-sub">${asBuilt.length} as-built · ${b.Model.reduce((s, m) => s + Number(m.elementCount ?? 0), 0).toLocaleString()} elements</div>
        </div>
        <div ${raw(drillable('Open clashes', clashSources))}>
          <h2>Open clashes</h2>
          <div class="metric ${raw(criticalClashes.length > 0 ? 'bad' : openClashes.length > 0 ? 'warn' : 'good')}">${openClashes.length}</div>
          <div class="metric-sub">${criticalClashes.length} critical</div>
        </div>
        <div ${raw(drillable('Site deviations', twinSources))}>
          <h2>Site deviations</h2>
          <div class="metric ${raw(deviations > 0 ? 'warn' : 'good')}">${deviations}</div>
          <div class="metric-sub">observed against ${b.DigitalTwinState.length} capture(s)</div>
        </div>
      </div>

      ${
        reviews && reviews.cycles.length > 0
          ? html`<div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">Design review</h2>
              <div style="padding:0 17px"><div class="metric-sub">${reviews.summary}</div></div>
              <div style="padding:11px 17px 15px">
                ${table({
                  headers: ['Review', 'Deliverable', 'Rev', 'State', 'Comments', 'Open', 'Days', 'Waiting on'],
                  align: ['', '', 'num', '', 'num', 'num', 'num', ''],
                  rows: reviews.cycles.map((cycle) => [
                    cycle.reference,
                    `${cycle.deliverable.refType} ${String(cycle.deliverable.refId).slice(-8)}`,
                    cycle.revision,
                    cycle.decision
                      ? badge(humanise(cycle.decision), cycle.decision.startsWith('ACCEPTED') ? 'good' : 'bad')
                      : badge(humanise(cycle.cdeState), ''),
                    cycle.comments.total,
                    // The number that decides whether it can be published, and
                    // it is shown as a warning rather than as a count.
                    cycle.comments.blocking > 0
                      ? badge(`${cycle.comments.blocking} blocking`, 'bad')
                      : cycle.comments.open,
                    cycle.daysOverdue !== undefined
                      ? badge(`${cycle.daysOverdue}d late`, 'bad')
                      : cycle.durationDays,
                    cycle.waitingOn,
                  ]),
                })}
                <div class="metric-sub" style="margin-top:9px">
                  A deliverable cannot be published while a critical or major comment is open — including under
                  "accepted with comments", which is the status that otherwise hides them.
                </div>
              </div>
            </div>`
          : ''
      }

      <div id="design-insight" style="margin-bottom:14px"></div>

      <div class="grid g-2-1" style="margin-bottom:14px">
        <div class="card pad0">
          <h2 style="padding:15px 17px 0">Drawing register</h2>
          ${table({
            headers: ['Number', 'Title', 'Rev', 'Discipline', 'Status', 'Registered'],
            rows: b.Drawing.map((d) => [
              d.drawingNumber,
              d.title,
              d.revision,
              d.discipline,
              d.status === 'CURRENT' ? badge('CURRENT', 'ok') : badge('superseded', 'neutral'),
              date(d.registeredAt),
            ]),
            empty: 'No drawings registered',
          })}
        </div>

        <div>
          <div class="card" style="margin-bottom:14px">
            <h2>Design maturity</h2>
            ${
              maturity
                ? html`<div class="metric ${raw(maturity.score >= 80 ? 'good' : maturity.score >= 60 ? 'warn' : 'bad')}">${maturity.score}</div>
                    <div class="metric-sub" style="margin-bottom:12px">Supportable pricing basis: <b>${humanise(maturity.recommendedPricingBasis)}</b></div>
                    <div class="split-list">
                      ${(maturity.disciplineScores ?? []).map(
                        (d) => html`<div class="row">
                          <span class="lbl">${humanise(d.discipline)} <span style="color:var(--text-3)">RIBA ${d.ribaStage}</span></span>
                          <span class="val">${pct(d.completenessPercent, 0)} ${d.frozen ? badge('frozen', 'ok') : badge('moving', 'warn')}</span>
                        </div>`,
                      )}
                    </div>
                    ${
                      (maturity.informationGaps ?? []).length > 0
                        ? html`<div class="metric-sub" style="margin-top:10px"><b>Gaps:</b> ${maturity.informationGaps.join(' · ')}</div>`
                        : ''
                    }`
                : html`<div class="empty"><b>Not assessed</b>A package cannot go to market before this is done.</div>`
            }
          </div>

          <div class="card">
            <h2>Latest site capture</h2>
            ${
              twin
                ? html`<div class="split-list">
                    <div class="row"><span class="lbl">Zone</span><span class="val">${twin.zone}</span></div>
                    <div class="row"><span class="lbl">Source</span><span class="val">${humanise(twin.source)}</span></div>
                    <div class="row"><span class="lbl">Deviations</span><span class="val" style="color:${raw(twin.deviationCount > 0 ? 'var(--warning)' : 'var(--success)')}">${twin.deviationCount}</span></div>
                    <div class="row"><span class="lbl">Confidence</span><span class="val">${pct((twin.observationConfidence ?? 0) * 100, 0)}</span></div>
                  </div>`
                : html`<div class="empty"><b>No capture</b></div>`
            }
          </div>
        </div>
      </div>

      ${
        spec && spec.specifications > 0
          ? html`<div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">Specification against the inspection plans</h2>
              <div style="padding:0 17px"><div class="metric-sub">
                ${spec.clauses} clauses read, ${spec.requiringVerification} of which impose a test, a submittal or a hold point.
                A clause requiring one with no inspection stage against it is work that gets built and then argued about —
                and it is invisible to both sides, because the gap exists only between the two documents.
              </div></div>
              <div class="grid g4" style="padding:13px 17px 4px">
                <div><div class="metric ${raw(spec.coveragePercent >= 90 ? 'good' : spec.coveragePercent >= 50 ? 'warn' : 'bad')}">${pct(spec.coveragePercent, 0)}</div><div class="metric-sub">verification clauses inspected</div></div>
                <div><div class="metric">${spec.covered}<span style="font-size:16px;color:var(--text-3)"> / ${spec.requiringVerification}</span></div><div class="metric-sub">covered by an ITP stage</div></div>
                <div><div class="metric ${raw(spec.gaps.filter((g) => g.mandatory).length > 0 ? 'bad' : '')}">${spec.gaps.filter((g) => g.mandatory).length}</div><div class="metric-sub">mandatory and uncovered</div></div>
                <div><div class="metric">${spec.advisoryGaps}</div><div class="metric-sub">advisory — a should, not a shall</div></div>
              </div>
              ${table({
                headers: ['Clause', 'Requires', 'What it says', 'If nobody notices'],
                rows: spec.gaps.map((g) => [
                  g.clauseRef,
                  badge(humanise(g.kind), g.mandatory ? (g.kind === 'HOLD_POINT' ? 'bad' : 'warn') : 'neutral'),
                  String(g.text).slice(0, 70) + (String(g.text).length > 70 ? '…' : ''),
                  g.consequence,
                ]),
                empty: 'Every specified test, submittal and hold point has an inspection stage against it.',
              })}
              <div style="padding:8px 17px 15px"><div class="metric-sub">${spec.summary}</div></div>
            </div>`
          : ''
      }

      <div class="grid g2">
        <div class="card pad0">
          <h2 style="padding:15px 17px 0">Clash detection — triaged by rework cost</h2>
          ${table({
            headers: ['Location', 'Disciplines', 'Overlap', 'Severity', 'Status'],
            align: ['', '', 'num', '', ''],
            rows: openClashes.map((c) => [
              c.location,
              `${humanise(c.disciplineA)} / ${humanise(c.disciplineB)}`,
              `${c.overlapVolume} m³`,
              badge(c.severity, statusTone(c.severity)),
              badge(humanise(c.status), statusTone(c.status)),
            ]),
            empty: 'No open clashes',
          })}
          ${
            clashes
              ? html`<div style="padding:0 17px 15px">
                  <div class="metric-sub">${clashes.summary}</div>
                  ${
                    clashes.modelOutOfDate > 0
                      ? html`<div class="notice warn" style="margin-top:10px">
                          <div><b>${clashes.modelOutOfDate} clash(es) resolved on site.</b><br>
                          The model still shows the design in those places. As-built generation inherits the difference, and nobody
                          finds it until somebody drills into it.</div>
                        </div>`
                      : ''
                  }
                  ${
                    clashes.dismissedCritical > 0
                      ? html`<div class="notice err" style="margin-top:10px">
                          <div><b>${clashes.dismissedCritical} critical clash(es) closed as detection artefacts.</b><br>
                          Each one carries a written reason. They are worth reading, because this is the cheapest way to make a
                          clash register look healthy.</div>
                        </div>`
                      : ''
                  }
                </div>`
              : ''
          }
        </div>

        ${
          readiness
            ? html`<div class="card pad0">
                <div style="padding:15px 17px 0">
                  <h2>What the next weeks are waiting on</h2>
                  <p class="metric-sub" style="margin-bottom:12px">
                    Not "is the design finished", which no project can answer — of the work in the published lookahead, what is
                    waiting on a question nobody has answered. ${readiness.summary}
                    ${readiness.toMakeExact ? html`<br><b>To see more:</b> ${readiness.toMakeExact}` : ''}
                  </p>
                </div>
                ${
                  readiness.hasLookahead
                    ? table({
                        headers: ['Activity', 'Promised', 'On critical path', 'Waiting on', 'Worst overdue'],
                        align: ['', '', '', '', 'num'],
                        rows: readiness.waiting.map((entry) => [
                          entry.taskName,
                          entry.committed ? badge('promised', 'bad') : badge('planned', 'neutral'),
                          entry.onCriticalPath ? badge('critical', 'bad') : '—',
                          entry.openRfis.map((r) => r.reference).join(', '),
                          `${entry.openRfis[0]?.daysOverdue ?? 0}d`,
                        ]),
                        empty: `All ${readiness.plannedActivities} activities in the window have their information.`,
                      })
                    : ''
                }
              </div>`
            : ''
        }

        ${
          perception
            ? html`<div class="card pad0">
                <div style="padding:15px 17px 0">
                  <h2>Read a drawing</h2>
                  <p class="metric-sub" style="margin-bottom:12px">
                    The title block and the quantities, read off the sheet the platform holds rather than typed in from it.
                    Nothing read this way reaches the register on its own — an extraction is a draft until somebody confirms it,
                    and confirming runs the same command as entering it by hand.
                  </p>
                  ${
                    perception.capability.available
                      ? ''
                      : html`<div class="notice warn" style="margin-bottom:12px">
                          <div><b>Not available on this deployment.</b><br>${perception.capability.reason}
                          A drawing is not read here at all — rather than read badly and filed as fact.</div>
                        </div>`
                  }
                </div>
                ${
                  perception.capability.available
                    ? table({
                        headers: ['Evidence', 'Type', 'Read'],
                        rows: readable.slice(0, 12).map((entry) => [
                          entry.description,
                          entry.contentType,
                          html`<button class="btn quiet sm" data-read="TITLE_BLOCK" data-hash="${entry.hash}">Title block</button>
                            <button class="btn quiet sm" data-read="DRAWING_TAKEOFF" data-hash="${entry.hash}">Quantities</button>`,
                        ]),
                        empty: evidence?.storeConfigured
                          ? 'No drawing files are held yet. A hash on its own cannot be read.'
                          : 'This deployment holds no evidence files, so there is nothing to read.',
                      })
                    : ''
                }
                ${
                  openDrafts.length > 0
                    ? html`<div style="padding:0 17px 15px">
                        <h2 style="margin-top:14px">Awaiting confirmation</h2>
                        ${table({
                          headers: ['Read', 'What it says', 'Confidence', ''],
                          rows: openDrafts.map((draft) => [
                            humanise(draft.task),
                            draft.task === 'TITLE_BLOCK'
                              ? `${draft.extraction.drawingNumber ?? '—'} rev ${draft.extraction.revision ?? '—'} · ${draft.extraction.title ?? ''}`
                              : draft.task === 'DRAWING_TAKEOFF'
                                ? `${(draft.extraction.items ?? []).length} measured item(s)`
                                : String(draft.extraction.transcript ?? '').slice(0, 70),
                            draft.confidence !== undefined && draft.confidence !== null ? pct(draft.confidence * 100) : '—',
                            html`<button class="btn sm" data-confirm="${draft.id}">Confirm</button>
                              <button class="btn quiet sm" data-discard="${draft.id}">Reject</button>`,
                          ]),
                        })}
                      </div>`
                    : ''
                }
              </div>`
            : ''
        }

        <div class="card pad0">
          <h2 style="padding:15px 17px 0">Material and technical submittals</h2>
          <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
            ${submittals.summary || 'Nothing submitted for approval on this project.'}
            Ordered by when the decision is needed — the date the material has to be on site less its procurement lead
            time — rather than by when it was raised.
          </p>
          ${table({
            // Five columns, not eight. This card sits in a half-width column,
            // and the last two of eight were being clipped — a number nobody
            // can see is worse than one that was never offered.
            headers: ['Ref', 'Product and clause', 'Status', 'Decision needed', 'Days'],
            align: ['', '', '', '', 'num'],
            rows: (submittals.submittals ?? []).map((sub) => [
              html`${sub.reference}<span class="metric-sub"> rev ${sub.revision}</span>`,
              html`${sub.manufacturer} ${sub.productReference}<span class="metric-sub"> · ${sub.clauseRef}</span>${
                sub.isSubstitution ? badge('substitution', 'warn') : ''
              }${sub.departures ? badge(`${sub.departures} departure(s)`, 'warn') : ''}${
                // Three cycles is a product nobody is converging on, which is
                // the one fact this register exists to surface.
                sub.cycles >= 3 ? badge(`${sub.cycles} cycles`, 'warn') : ''
              }`,
              html`${badge(humanise(sub.status), statusTone(sub.status))}${
                sub.orderedAtRisk ? badge('ordered at risk', 'warn') : ''
              }${sub.reviewOverdueByDays ? badge(`review ${sub.reviewOverdueByDays}d late`, 'warn') : ''}`,
              sub.approvalNeededBy,
              sub.daysToDecision < 0 ? badge(`${Math.abs(sub.daysToDecision)} past`, 'warn') : sub.daysToDecision,
            ]),
            empty: 'Nothing submitted for approval — the approval status of what is being installed cannot be asserted',
          })}
          ${
            submittals.pastOrderingDate > 0
              ? html`<div style="padding:0 17px 15px">
                  <div class="notice warn">
                    <b>${submittals.pastOrderingDate} submittal(s) are past the date the material had to be ordered and
                    are still undecided.</b><br>
                    That date is worked back from the lead time rather than typed, which is why it is visible here and
                    not on a register that tracks status alone.
                  </div>
                </div>`
              : ''
          }
        </div>

        <div class="card pad0">
          <h2 style="padding:15px 17px 0">RFIs raised from markups</h2>
          ${table({
            headers: ['Ref', 'Question', 'Against rev', 'Due', 'Days open', 'Status'],
            rows: b.RFI.map((r) => [
              r.reference,
              String(r.question).slice(0, 62) + (String(r.question).length > 62 ? '…' : ''),
              `${r.linkedDrawingRevision ?? '—'}`,
              date(r.dueDate),
              r.daysOpen !== undefined ? `${r.daysOpen}` : '—',
              r.status === 'ANSWERED'
                ? badge(r.answeredLate ? 'answered late' : 'answered', r.answeredLate ? 'warn' : 'good')
                : badge(humanise(r.status), statusTone(r.status)),
            ]),
            empty: 'No RFIs raised',
          })}
          ${
            rfi
              ? html`<div style="padding:0 17px 15px">
                  <div class="notice ${raw(rfi.overdue.length > 0 ? 'warn' : 'ok')}" style="margin-bottom:9px">${rfi.summary}</div>
                  <div class="split-list">
                    ${
                      rfi.averageDaysToAnswer !== undefined
                        ? html`<div class="row"><span class="lbl">Average days to answer</span><span class="val">${rfi.averageDaysToAnswer}</span></div>`
                        : html`<div class="row"><span class="lbl">Average days to answer</span><span class="val">nothing answered yet</span></div>`
                    }
                    <div class="row"><span class="lbl">Answered after the return date</span><span class="val">${rfi.answeredLate}</span></div>
                    <div class="row"><span class="lbl">Answers that changed the design</span><span class="val">${rfi.designChanges}</span></div>
                  </div>
                  <div class="metric-sub" style="margin-top:9px">
                    Each RFI records the drawing revision it was raised against, and the answer records the revision it was given against —
                    answering the wrong revision is how RFI answers become disputes.
                  </div>
                </div>`
              : ''
          }
        </div>
      </div>

      ${positionReport({
        title: 'Design packages and the MIDP',
        intent: 'The plan the design is being produced against, and whether it reconciles to itself.',
        data: packages,
        error: packages?.error,
        sections: [
          { key: 'packages', label: 'Packages', empty: 'No design package has been planned.' },
        ],
      })}

      ${positionReport({
        title: 'Design baselines and freezes',
        intent: 'What is frozen, what is approved, and which freezes a later revision has quietly invalidated.',
        data: baselines,
        error: baselines?.error,
        sections: [
          { key: 'freezes', label: 'Freezes', empty: 'Nothing is frozen.' },
          { key: 'baselines', label: 'Approved baselines', empty: 'No design baseline has been approved.' },
          {
            key: 'invalidated',
            label: 'Freezes a later revision invalidated',
            empty: 'No freeze has been overtaken by a later revision.',
          },
        ],
      })}

      ${positionReport({
        title: 'The design stage gate',
        intent: 'What may freeze, what is late for its need date, and what tender is waiting for.',
        data: gate,
        error: gate?.error,
        sections: [
          { key: 'tenderReadinessWorklist', label: 'Tender is waiting for', empty: 'Tender is not held up by design.' },
          { key: 'packages', label: 'Packages at the gate', empty: 'No package is at the gate.' },
        ],
      })}

      ${positionReport({
        title: 'Constructability',
        intent: 'Reviews held, findings still open, and residual risks nobody has passed on to the people who inherit them.',
        data: constructability,
        error: constructability?.error,
        sections: [
          { key: 'reviews', label: 'Reviews', empty: 'No constructability review has been held.' },
          { key: 'freezeBlockers', label: 'Blocking a package freeze', empty: 'No finding blocks a freeze.' },
          {
            key: 'uncommunicated',
            label: 'Residual risks nobody has been told about',
            empty: 'Every residual risk has been passed on.',
          },
        ],
      })}

      ${positionReport({
        title: 'Model coordination',
        intent: 'Federation runs, the issues grouped out of them, and which critical ones are still unresolved.',
        data: coordination,
        error: coordination?.error,
        sections: [
          { key: 'federations', label: 'Federation sets', empty: 'No federation has been run.' },
          { key: 'blockers', label: 'Critical and unresolved', empty: 'No critical coordination issue is open.' },
          { key: 'acceptedNotResolved', label: 'Accepted but not resolved' },
        ],
      })}

      ${positionReport({
        title: 'Design change register',
        intent: 'The approval route each change took, domains nobody assessed, and anything implemented unapproved.',
        data: changes,
        error: changes?.error,
        sections: [
          { key: 'changes', label: 'Changes', empty: 'No design change has been raised.' },
          { key: 'approvalOwed', label: 'Awaiting approval', empty: 'No change is waiting on an approval.' },
          {
            key: 'unconfirmed',
            label: 'Implemented without approval',
            empty: 'Nothing has been implemented ahead of its approval.',
          },
        ],
      })}

      ${positionReport({
        title: 'Information control',
        intent:
          'Who is still holding superseded information, what was only ever said verbally, and which RFIs have no float left.',
        data: infoControl,
        error: infoControl?.error,
        sections: [
          {
            key: 'holdingSuperseded',
            label: 'Holding superseded information',
            empty: 'Nobody is recorded as holding a superseded revision.',
          },
          {
            key: 'unconfirmedDirections',
            label: 'Said verbally, never confirmed',
            empty: 'Every direction given has been confirmed in writing.',
          },
          { key: 'rfiPressure', label: 'RFIs with no float', empty: 'No RFI is holding up work that cannot wait.' },
          { key: 'transmittals', label: 'Transmittals', empty: 'Nothing has been transmitted.' },
        ],
      })}

      ${positionReport({
        title: 'What is current',
        intent: 'The live revision of each document, what it replaced, and who has not acknowledged the replacement.',
        data: currentInfo,
        error: currentInfo?.error,
        sections: [
          { key: 'current', label: 'Current revisions', empty: 'No document has been issued.' },
          {
            key: 'holdingSuperseded',
            label: 'Not acknowledged the replacement',
            empty: 'Everybody is working to the current revision.',
          },
        ],
      })}
    `,
  );

  const COMMANDS = {
    submittal: {
      title: 'Raise a submittal',
      intent:
        'A product proposed against a clause, with what the specification demands and what the product achieves side by ' +
        'side. The date approval is needed is worked back from the lead time rather than asked for.',
      path: `/v1/projects/${projectId}/submittals`,
      submitLabel: 'Raise',
      fields: [
        { name: 'clauseId', label: 'Clause it answers', type: 'select',
          hint: 'A submittal with no clause behind it approves a product rather than a compliance.',
          options: clauses.map((c) => ({ value: c._refId, label: `${c.specificationRef}/${c.clauseRef} — ${String(c.text).slice(0, 60)}…` })) },
        { name: 'kind', label: 'Kind', type: 'select', options: [
          { value: 'MATERIAL', label: 'Material — a named product' },
          { value: 'SAMPLE', label: 'Sample or benchmark panel' },
          { value: 'SHOP_DRAWING', label: 'Shop drawing' },
          { value: 'CALCULATION', label: 'Calculation' },
          { value: 'METHOD', label: 'Method of installation' },
          { value: 'CERTIFICATE', label: 'Certificate or declaration of performance' },
        ] },
        { name: 'title', label: 'What it is', type: 'text', placeholder: 'Concrete mix design — clarifier walls' },
        { name: 'manufacturer', label: 'Manufacturer', type: 'text' },
        { name: 'productReference', label: 'Product reference', type: 'text',
          hint: '“Proprietary insulation board” is not something anybody can order or check on delivery.' },
        {
          name: 'claims',
          label: 'What is specified, and what is offered',
          type: 'textarea',
          rows: 6,
          hint: 'One per line: requirement, specified, offered, and — where it does not comply — the reason it is offered anyway.',
          placeholder: 'Strength class, C32/40, C32/40\nCement type, CEM I with 25% PFA, CEM IIIA 50% GGBS, the PFA source named in the specification closed',
        },
        { name: 'requiredOnSiteBy', label: 'Required on site by', type: 'date' },
        { name: 'procurementLeadTimeDays', label: 'Procurement lead time (days)', type: 'number', min: 0,
          hint: 'Zero is a legitimate answer for something held in stock. Leaving it out is not — without it nothing can say when this decision is needed.' },
        { name: 'reviewPeriodDays', label: 'Contractual review period (days)', type: 'number', min: 1 },
        { name: 'differsFrom', label: 'It is offered instead of', type: 'text', required: false,
          placeholder: 'Only if this is a substitution' },
        { name: 'whyProposed', label: 'Why the substitution', type: 'textarea', rows: 2, required: false },
      ],
      transform: ({ claims, differsFrom, whyProposed, procurementLeadTimeDays, reviewPeriodDays, ...rest }) => ({
        ...rest,
        procurementLeadTimeDays: Number(procurementLeadTimeDays),
        reviewPeriodDays: Number(reviewPeriodDays),
        ...(String(differsFrom ?? '').trim()
          ? { substitution: { differsFrom: String(differsFrom), whyProposed: String(whyProposed ?? '') } }
          : {}),
        claims: String(claims ?? '')
          .split('\n')
          .map((line) => line.split(',').map((part) => part.trim()))
          .filter((parts) => parts[0])
          .map((parts) => ({
            requirement: parts[0],
            specified: parts[1] ?? '',
            offered: parts[2] ?? '',
            // A fourth field on the line is the reason it does not comply, so
            // its presence is what marks the departure. The server refuses a
            // departure with no reason either way.
            compliant: parts.length < 4 || !parts[3],
            ...(parts[3] ? { justification: parts.slice(3).join(', ') } : {}),
          })),
      }),
    },
    'decide-submittal': {
      title: 'Decide a submittal',
      intent:
        'Approved with comments still permits the order; revise-and-resubmit does not. The person who submitted it ' +
        'cannot be the person who approves it.',
      path: ({ submittalId }) => `/v1/projects/${projectId}/submittals/${submittalId}/review`,
      submitLabel: 'Record the decision',
      fields: [
        { name: 'submittalId', label: 'Submittal', type: 'select',
          options: underReview.map((sub) => ({ value: sub.submittalId, label: `${sub.reference} rev ${sub.revision} — ${sub.title}` })) },
        { name: 'outcome', label: 'Outcome', type: 'select', options: [
          { value: 'APPROVED', label: 'Approved' },
          { value: 'APPROVED_WITH_COMMENTS', label: 'Approved with comments — work may proceed and something still has to be done' },
          { value: 'REVISE_AND_RESUBMIT', label: 'Revise and resubmit' },
          { value: 'REJECTED', label: 'Rejected' },
        ] },
        { name: 'comments', label: 'Comments', type: 'textarea', rows: 4,
          hint: 'Required for anything but a clean approval. A rejection with nothing beside it sends the contractor back to guess.' },
      ],
      transform: ({ submittalId: _submittalId, ...rest }) => rest,
    },
    'submit-review': {
      title: 'Submit for review',
      intent:
        'Your own check goes on the record with it. A submission without one is a deliverable thrown over a wall, ' +
        'and the person who submits it cannot then check, answer-and-close, or accept it.',
      path: `/v1/projects/${projectId}/design/reviews`,
      submitLabel: 'Submit',
      transform: (values) => ({
        deliverable: { refType: 'Drawing', refId: values.drawingId },
        selfCheck: values.selfCheck,
        checkerId: values.checkerId,
        dueBy: values.dueBy,
      }),
      fields: [
        {
          name: 'drawingId',
          label: 'Deliverable',
          type: 'select',
          options: current.map((drawing) => ({
            value: drawing._refId,
            label: `${drawing.drawingNumber} rev ${drawing.revision} · ${drawing.title ?? ''}`,
          })),
        },
        {
          name: 'selfCheck',
          label: 'What you checked',
          type: 'textarea',
          rows: 3,
          hint: 'Required, and recorded verbatim. Name what you verified, not that you verified it.',
        },
        {
          name: 'checkerId',
          label: 'Who is to check it',
          type: 'select',
          options: [...(designOwners?.approve ?? []), ...(designOwners?.create ?? [])]
            // The same person may appear as both an approver and an author.
            .filter((owner, index, all) => all.findIndex((other) => other.userId === owner.userId) === index)
            .map((owner) => ({ value: owner.userId, label: `${owner.name} · ${humanise(owner.role)}` })),
          hint: '"The design team" is not an owner. A review with no name against it is one nobody is doing.',
        },
        { name: 'dueBy', label: 'Due back by', type: 'date', min: today() },
      ],
    },

    comment: {
      title: 'Raise a review comment',
      intent:
        'Critical and major comments block publication until the person who raised them agrees they are settled. ' +
        'Minor and observation do not.',
      path: (collected) => `/v1/projects/${projectId}/design/reviews/${collected.cycleId}/comments`,
      submitLabel: 'Raise',
      transform: ({ cycleId, ...rest }) => rest,
      fields: [
        {
          name: 'cycleId',
          label: 'Review',
          type: 'select',
          options: openReviews.map((cycle) => ({
            value: cycle.cycleId,
            label: `${cycle.reference} · ${cycle.deliverable.refType} rev ${cycle.revision}`,
          })),
        },
        {
          name: 'severity',
          label: 'Severity',
          type: 'select',
          options: [
            { value: 'CRITICAL', label: 'Critical — blocks publication' },
            { value: 'MAJOR', label: 'Major — blocks publication' },
            { value: 'MINOR', label: 'Minor' },
            { value: 'OBSERVATION', label: 'Observation' },
          ],
        },
        {
          name: 'location',
          label: 'Where',
          type: 'text',
          placeholder: 'Grid C/4, clause 3.2, object GUID…',
          hint: 'Required. A comment nobody can locate is a comment nobody can action.',
        },
        { name: 'comment', label: 'The comment', type: 'textarea', rows: 3 },
        { name: 'evidenceHash', label: 'Evidence', type: 'file', required: false },
      ],
    },

    'decide-review': {
      title: 'Decide a review',
      intent:
        'Accepting publishes the revision. It is refused while a critical or major comment is open — including under ' +
        '"accepted with comments", which is the status that otherwise hides them.',
      path: (collected) => `/v1/projects/${projectId}/design/reviews/${collected.cycleId}/decide`,
      submitLabel: 'Decide',
      transform: ({ cycleId, ...rest }) => rest,
      fields: [
        {
          name: 'cycleId',
          label: 'Review',
          type: 'select',
          options: openReviews.map((cycle) => ({
            value: cycle.cycleId,
            label:
              `${cycle.reference} · ${cycle.comments.blocking > 0 ? `${cycle.comments.blocking} blocking open` : 'nothing blocking'}`,
          })),
        },
        {
          name: 'decision',
          label: 'Decision',
          type: 'select',
          options: [
            { value: 'ACCEPTED', label: 'Accepted — publishes the revision' },
            { value: 'ACCEPTED_WITH_COMMENTS', label: 'Accepted with comments — publishes, minor comments outstanding' },
            { value: 'REVISE_AND_RESUBMIT', label: 'Revise and resubmit — back to the author' },
            { value: 'REJECTED', label: 'Rejected' },
          ],
        },
        { name: 'reason', label: 'Why', type: 'textarea', rows: 2, hint: 'Recorded with the decision.' },
      ],
    },

    drawing: {
      title: 'Register drawing',
      intent: 'Registering a revision supersedes the previous one automatically. Marking up a superseded drawing is then refused.',
      path: `/v1/projects/${projectId}/bim/drawings`,
      aiCost: true,
      submitLabel: 'Register',
      fields: [
        { name: 'fileHash', label: 'Drawing file', type: 'file', hint: 'Hashed in your browser' },
        { name: 'drawingNumber', label: 'Drawing number', type: 'text', placeholder: 'C-1002' },
        { name: 'title', label: 'Title', type: 'text' },
        { name: 'revision', label: 'Revision', type: 'text', placeholder: 'P01' },
        { name: 'discipline', label: 'Discipline', type: 'select', options: DISCIPLINE },
      ],
      transform: (v) => ({
        fileHash: v.fileHash,
        titleBlock: {
          drawingNumber: v.drawingNumber,
          title: v.title,
          revision: v.revision,
          discipline: v.discipline,
        },
      }),
    },
    markup: {
      title: 'Add markup',
      intent: 'A markup can be converted to an RFI or an instruction as it is raised, so the question and the drawing stay linked.',
      path: `/v1/projects/${projectId}/bim/markups`,
      submitLabel: 'Add',
      fields: [
        { name: 'drawingId', label: 'Drawing', type: 'select',
          options: b.Drawing.filter((d) => d.status === 'CURRENT').map((d) => ({ value: d._refId, label: `${d.drawingNumber} rev ${d.revision} · ${d.title}` })) },
        { name: 'note', label: 'Markup', type: 'textarea' },
        { name: 'author', label: 'Author', type: 'text', value: state.session.user.name },
        { name: 'convertTo', label: 'Convert to', type: 'select', options: [
          { value: 'NONE', label: 'Leave as a markup' },
          { value: 'RFI', label: 'Raise as an RFI' },
          { value: 'INSTRUCTION', label: 'Raise as an instruction' },
        ] },
        // The one field that turns the delay exposure from conditional into
        // computed. Optional, because a question can genuinely precede the
        // programme — the hint says what leaving it out costs rather than
        // making it required and pushing people back to email.
        { name: 'taskId', label: 'Activity held up', type: 'select', required: false,
          placeholder: 'Not tied to an activity',
          hint: 'Named here, the platform reads that activity’s own float off the network and prices the delay. Left blank, the exposure stays conditional.',
          options: tasks.map((t) => ({ value: t._refId, label: t.name })) },
      ],
    },
    answer: {
      title: 'Answer an RFI',
      intent:
        'The answer records the drawing revision it was given against. A design team answering against a revision the site no longer holds is how an answer becomes a dispute.',
      path: (collected) => `/v1/projects/${projectId}/rfi/${collected.rfiId}/answer`,
      // A select yields a string; the endpoint takes a boolean and refuses
      // anything else, which is the validation working rather than a nuisance.
      transform: ({ rfiId, changesDesign, ...rest }) => ({ ...rest, changesDesign: changesDesign === 'true' }),
      submitLabel: 'Answer',
      fields: [
        { name: 'rfiId', label: 'RFI', type: 'select',
          options: b.RFI.filter((r) => r.status !== 'ANSWERED').map((r) => ({ value: r._refId, label: `${r.reference} · ${String(r.question).slice(0, 50)}` })) },
        { name: 'answer', label: 'Answer', type: 'textarea', hint: 'It has to say something a site team can build to' },
        { name: 'answeredBy', label: 'Answered by', type: 'text', value: state.session.user.name },
        { name: 'changesDesign', label: 'Does this change the design?', type: 'select', options: [
          { value: 'false', label: 'No — it explains the existing design' },
          { value: 'true', label: 'Yes — the design changes' },
        ] },
        { name: 'evidenceHash', label: 'Answer document', type: 'file' },
      ],
    },
    specification: {
      title: 'Read a specification',
      intent:
        'Paste the section. Clauses are classified by the words they use, so the same text gives the same answer twice — and a scan cannot be read, because OCR is not built.',
      path: `/v1/projects/${projectId}/specifications`,
      aiCost: true,
      submitLabel: 'Read',
      fields: [
        { name: 'sectionRef', label: 'Section', type: 'text', placeholder: 'E10',
          hint: 'As the specification numbers it. Clause references are built from this.' },
        { name: 'title', label: 'Title', type: 'text', placeholder: 'In situ concrete' },
        { name: 'revision', label: 'Revision', type: 'text', placeholder: 'C' },
        { name: 'specificationText', label: 'The text', type: 'textarea', rows: 10 },
        { name: 'documentHash', label: 'Source document', type: 'file' },
      ],
      transform: ({ documentHash, ...rest }) => ({ ...rest, documentHash }),
    },
    'resolve-clash': {
      title: 'Close a clash',
      intent:
        'For a model revision, name the discipline that moved. That is who bears the rework, and it is the fact nobody can establish six months later.',
      path: (collected) => `/v1/projects/${projectId}/bim/clashes/${collected.clashId}/resolve`,
      transform: ({ clashId, ...rest }) => rest,
      submitLabel: 'Close out',
      fields: [
        { name: 'clashId', label: 'Clash', type: 'select',
          options: openClashes.map((c) => ({
            value: c._refId,
            label: `${c.severity} · ${c.location} · ${humanise(c.disciplineA)}/${humanise(c.disciplineB)}`,
          })) },
        { name: 'method', label: 'How was it resolved', type: 'select', options: [
          { value: 'MODEL_REVISED', label: 'A discipline moved — model revised' },
          { value: 'WITHIN_TOLERANCE', label: 'Within tolerance — real geometry, acceptable overlap' },
          { value: 'NOT_A_CLASH', label: 'Not a clash — the detection run was wrong' },
          { value: 'RESOLVED_ON_SITE', label: 'Built around on site — model not updated' },
        ] },
        { name: 'movedDiscipline', label: 'Which discipline moved', type: 'select', required: false,
          placeholder: 'Only for a model revision', options: DISCIPLINE },
        { name: 'resolvedInModelId', label: 'Resolved in model', type: 'select', required: false,
          placeholder: 'Only for a model revision',
          options: b.Model.map((m) => ({ value: m._refId, label: `${m.discipline ?? 'Federated'} · LOD ${m.lod ?? '—'}` })) },
        { name: 'justification', label: 'What was done', type: 'textarea',
          hint: 'A coordinator has to be able to check it. Dismissing a critical clash as a false positive needs the reason in full.' },
        { name: 'resolvedBy', label: 'Resolved by', type: 'text', value: state.session.user.name },
        { name: 'evidenceHash', label: 'Evidence', type: 'file' },
      ],
    },
  };

  root.addEventListener('click', async (event) => {
    const read = event.target.closest('[data-read]');
    if (read) {
      // Written out rather than interpolated. One route per task is what makes
      // each one quotable, and a path assembled from a variable is a path
      // nothing can check against the route table.
      const path =
        read.dataset.read === 'TITLE_BLOCK'
          ? `/v1/projects/${projectId}/perception/title-block`
          : `/v1/projects/${projectId}/perception/take-off`;
      read.disabled = true;
      read.textContent = 'Reading…';
      try {
        await api.post(path, { hash: read.dataset.hash });
        await draw();
      } catch (error) {
        // A refusal here is usually a true statement about the file or the
        // deployment, so it is shown as it was given rather than retitled.
        toast('Not read', error.message, error.code === 'PERCEPTION_PROVIDER_UNAVAILABLE' ? 'warn' : 'err');
        read.disabled = false;
        read.textContent = read.dataset.read === 'TITLE_BLOCK' ? 'Title block' : 'Quantities';
      }
      return;
    }

    const confirmDraft = event.target.closest('[data-confirm]');
    if (confirmDraft) {
      confirmDraft.disabled = true;
      try {
        await api.post(`/v1/projects/${projectId}/perception/${confirmDraft.dataset.confirm}/confirm`, {});
        toast('Confirmed', 'Filed through the same command as entering it by hand', 'ok');
        await draw();
      } catch (error) {
        toast('Not confirmed', error.message, 'err');
        confirmDraft.disabled = false;
      }
      return;
    }

    const discardDraft = event.target.closest('[data-discard]');
    if (discardDraft) {
      const reason = window.prompt('Why is this reading wrong? It stays in the record either way.');
      if (!reason) return;
      try {
        await api.post(`/v1/projects/${projectId}/perception/${discardDraft.dataset.discard}/discard`, { reason });
        await draw();
      } catch (error) {
        toast('Not rejected', error.message, 'err');
      }
    }
  });

  void insightPanel(root.querySelector('#design-insight'), {
    projectId,
    areas: ['DESIGN_INFORMATION', 'BIM_TWIN'],
    subject: 'design and information',
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
