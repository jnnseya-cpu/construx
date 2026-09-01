import { api } from '../lib/api.js';
import { command, commandBar } from '../lib/command.js';
import { badge, date, html, humanise, money, notice, pct, positionReport, raw, render, table, toast } from '../lib/ui.js';
import { insightPanel } from '../lib/insight.js';
import { blockedReason, can, draw, openProject, phaseGates, state } from '../app.js';

/**
 * Business development — the pipeline, and the discipline of refusing work.
 *
 * The scoring half of this screen is ordinary: ten weighted factors, a number,
 * a band. The half that matters is underneath it.
 *
 * A bid/no-bid algorithm nobody declines against is a form. So the no-bid rate
 * is the headline figure rather than a footnote, every override is named with
 * who took it and how it turned out, and the bands are reported against actual
 * outcomes — because weights that do not predict are a slower way of having the
 * same opinion, and the only way to find that out is to look.
 */

const BAND_TONE = { BID: 'ok', DIRECTOR_REVIEW: 'warn', NO_BID: 'bad' };
const BAND_LABEL = { BID: 'BID', DIRECTOR_REVIEW: 'Director review', NO_BID: 'NO BID' };

const STAGE_TONE = {
  IDENTIFIED: '',
  QUALIFIED: 'info',
  BID: 'ok',
  NO_BID: 'bad',
  CONVERTED: 'ok',
  LOST: 'warn',
};

/**
 * The whole IANA list, from the runtime rather than from a hand-kept copy.
 *
 * A short curated list of "common" zones is the obvious shortcut and it is
 * wrong the first time somebody bids in a country nobody thought of. The
 * browser already holds the current database; the server validates the same
 * way. Sorted with the zones a UK contractor reads most often at the top,
 * because ordering is an affordance and does not narrow what is accepted.
 */
const NEAR_THE_TOP = ['Europe/London', 'Europe/Dublin', 'Europe/Paris', 'Europe/Berlin', 'UTC'];

function timeZoneOptions() {
  const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const rest = all.filter((zone) => !NEAR_THE_TOP.includes(zone));
  return [...NEAR_THE_TOP, ...rest].map((zone) => ({ value: zone, label: zone.replace(/_/g, ' ') }));
}

const SEVERITY_TONE = { CRITICAL: 'bad', MAJOR: 'warn', MINOR: '' };

/**
 * The compliance matrix, read back.
 *
 * Producing the analysis wrote it to the ledger and put it in a response body,
 * and that was the only time anybody saw it. The matrix that says which
 * mandatory requirement has nothing behind it is the thing a bid manager opens
 * on the Monday, so it is a screen rather than a return value — and rerunning
 * the analysis to see it again would spend ACUs re-deriving a record the
 * platform already holds.
 */
const TERM_TONE = { BAR: 'bad', SEVERE: 'bad', MATERIAL: 'warn', ROUTINE: '' };
const MATRIX_TONE = { SATISFIED: 'ok', GAP: 'bad', UNKNOWN: 'warn' };

/**
 * A status is not a verdict.
 *
 * `UNKNOWN` means the platform holds no probe for this requirement, which is
 * different from holding a probe that found nothing. Collapsing the two would
 * bury the real gaps under everything nobody automated, so the distinction is
 * carried through to the screen rather than flattened into a tick or a cross.
 */
const MATRIX_MEANING = {
  SATISFIED: 'Evidenced from the company record',
  GAP: 'Nothing on file satisfies this',
  UNKNOWN: 'Not something the platform can check — somebody must',
};

/**
 * The AI reading of an invitation, which had an engine and no door.
 *
 * `ITT_REQUIREMENTS` was built end to end on the platform side — the prompt
 * that tells the model to quote rather than summarise, the response schema, a
 * route, a confirm branch that runs `analyseITT` and `extractRequirements`, and
 * tests over all of it. No page in the console called it. It was reachable only
 * through the generated command catalogue, whose form asks for an evidence
 * hash in a text box, which is not a door a bid manager can open.
 *
 * So the whole of "an ITT arrived, read it" was present in the platform and
 * absent from the product. This is the door.
 *
 * **A reading is a draft, and stays one.** Confirming runs the same commands a
 * person typing the requirements in by hand would reach — same authorisation,
 * same ACU cost, same events. Rejecting keeps the reading in the record with
 * the reason. Neither is a shortcut around the analyst.
 */
function ittReadingPanel({ perception, evidence, projectId, projectName, blocked, tenderProjects, invitationOptions }) {
  // Three separate reasons this cannot run, and they need different sentences.
  // Collapsing them into one "unavailable" is how somebody spends an afternoon
  // fixing the wrong thing.
  if (!projectId) {
    return html`<div class="card" style="margin-bottom:14px">
      <h2>Read an invitation with AI</h2>
      <p class="metric-sub">
        A reading is filed against a project, and no project is open. Open the one this tender is being bid from and
        the reader appears here.
      </p>
    </div>`;
  }

  const available = perception?.capability?.available === true;
  const published = new Map((perception?.capability?.tasks ?? []).map((entry) => [entry.task, entry]));
  const ittTask = published.get('ITT_REQUIREMENTS');
  const readable = (evidence?.entries ?? []).filter(
    (entry) => entry.held && ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(entry.contentType ?? ''),
  );
  const drafts = (perception?.drafts ?? []).filter((d) => d.task === 'ITT_REQUIREMENTS' && d.status === 'DRAFT');

  return html`
    <div class="card pad0" style="margin-bottom:14px">
      <div style="padding:15px 17px 0">
        <h2>Read an invitation with AI</h2>
        <p class="metric-sub" style="margin-bottom:12px">
          The invitation as the buyer sent it — a PDF or a scan — read into a compliance matrix, a return register and
          a commercial assessment. The model is told to quote the document rather than summarise it, to omit anything
          it does not state rather than infer it, and to list what it left out and why. Nothing it reads reaches the
          record on its own: a reading is a draft until somebody confirms it, and confirming runs the same commands as
          typing it in by hand. Filed against <b>${projectName || projectId}</b>.
        </p>

        ${
          blocked
            ? html`<div class="notice warn" style="margin-bottom:12px">
                <div>
                  <b>Not here.</b> ${blocked}
                  ${
                    tenderProjects.length > 0
                      ? html`<div style="margin-top:6px">
                          Open a project the platform will accept a tender analysis on:
                          ${tenderProjects.map(
                            (p) => html`<button class="btn quiet sm" data-open-project="${p.id}" style="margin:3px 4px 0 0">${p.name}</button>`,
                          )}
                        </div>`
                      : html`<div style="margin-top:6px">
                          No project in this tenancy is at a phase where a tender may be analysed.
                        </div>`
                  }
                </div>
              </div>`
            : ''
        }

        ${
          !blocked && !available
            ? html`<div class="notice warn" style="margin-bottom:12px">
                <div>
                  <b>Not available on this deployment.</b><br />${perception?.capability?.reason ?? ''}
                  An invitation is not read here at all, rather than read badly and filed as fact — a fabricated
                  requirement is a bid disqualified.
                </div>
              </div>`
            : ''
        }

        ${
          !blocked && available && ittTask && ittTask.available === false
            ? html`<div class="notice warn" style="margin-bottom:12px">
                <div><b>The reader is off for invitations on this deployment.</b><br />${ittTask.reason ?? ''}</div>
              </div>`
            : ''
        }
      </div>

      ${
        !blocked && available
          ? table({
              headers: ['The document', 'Type', 'Held since', ''],
              rows: readable.slice(0, 12).map((entry) => [
                entry.description,
                html`<span style="font-size:11.5px;color:var(--text-3)">${entry.contentType}</span>`,
                entry.recordedAt ? date(entry.recordedAt) : '—',
                html`<button class="btn sm" data-read-itt="${entry.hash}">Read this invitation</button>`,
              ]),
              empty: evidence?.storeConfigured
                ? 'No invitation document is held against this project yet. Upload the ITT as evidence and it appears here — a hash on its own cannot be read.'
                : 'This deployment holds no evidence files, so there is nothing to read.',
            })
          : ''
      }

      ${
        drafts.length > 0
          ? html`<div style="padding:0 17px 15px">
              <h2 style="margin-top:14px">What the AI read, awaiting a person</h2>
              <p class="metric-sub" style="margin-bottom:10px">
                Check it against the document before confirming. Confirming produces the compliance matrix and the
                return register; rejecting keeps the reading and your reason in the record, because a reading that was
                wrong is evidence about the reader.
              </p>
              ${drafts.map((draft) => {
                const read = draft.extraction ?? {};
                const requirements = read.requirements ?? [];
                const deliverables = read.deliverables ?? [];
                const omitted = read.omitted ?? read.omissions ?? [];
                return html`<div class="card" style="margin-bottom:10px">
                  <div class="split-list">
                    <div class="row">
                      <span class="lbl">Reference it read</span>
                      <span class="val">${read.reference ?? html`<i style="color:var(--text-3)">not stated in the document</i>`}</span>
                    </div>
                    <div class="row">
                      <span class="lbl">Client</span>
                      <span class="val">${read.clientName ?? html`<i style="color:var(--text-3)">not stated</i>`}</span>
                    </div>
                    <div class="row">
                      <span class="lbl">Returns by</span>
                      <span class="val">${read.returnBy ?? html`<i style="color:var(--text-3)">not stated</i>`}</span>
                    </div>
                    <div class="row">
                      <span class="lbl">Found</span>
                      <span class="val">${requirements.length} requirement(s), ${deliverables.length} deliverable(s)</span>
                    </div>
                    <div class="row">
                      <span class="lbl">Confidence</span>
                      <span class="val">
                        ${draft.confidence === undefined || draft.confidence === null ? '—' : pct(draft.confidence * 100)}
                        ${draft.model ? badge(draft.model, '') : ''}
                      </span>
                    </div>
                    ${
                      Array.isArray(omitted) && omitted.length > 0
                        ? html`<div class="row">
                            <span class="lbl">It says it left out</span>
                            <span class="val" style="font-size:12px;color:var(--text-3)">${omitted.map(String).join('; ')}</span>
                          </div>`
                        : ''
                    }
                  </div>
                  ${
                    requirements.length > 0
                      ? table({
                          headers: ['Ref', 'Category', 'Requirement', 'Mandatory', 'Weight', 'Evidence demanded'],
                          align: ['', '', '', '', 'num', ''],
                          rows: requirements.slice(0, 40).map((r) => [
                            r.reference ?? '—',
                            html`<span style="font-size:12px;color:var(--text-3)">${humanise(String(r.category ?? ''))}</span>`,
                            r.requirement ?? '',
                            r.mandatory === true ? badge('pass/fail', 'warn') : 'scored',
                            r.weightingPercent === undefined || r.weightingPercent === null ? '—' : `${r.weightingPercent}%`,
                            html`<span style="font-size:12px;color:var(--text-3)">${r.evidenceRequired ?? ''}</span>`,
                          ]),
                        })
                      : ''
                  }
                  <div class="actions" style="margin-top:11px">
                    <button class="btn" data-confirm-itt="${draft.id}"
                      ${raw(invitationOptions.length === 0 ? 'disabled title="Record the invitation first — a reading is filed against one"' : '')}>
                      Confirm and build the matrix
                    </button>
                    <button class="btn quiet" data-reject-itt="${draft.id}">Reject this reading</button>
                  </div>
                </div>`;
              })}
            </div>`
          : ''
      }
    </div>
  `;
}

function matrixDetail(analysis) {
  const gapRefs = new Set(analysis.mandatoryGaps.map((line) => line.reference));

  return html`
    <div class="card pad0">
      <h2 style="padding:15px 17px 0">
        ${analysis.reference} · ${analysis.clientName}
        ${analysis.readyToPrice ? badge('ready to price', 'ok') : badge('not ready to price', 'bad')}
      </h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
        Returns ${date(analysis.returnBy)}. Analysed ${date(analysis.analysedAt)} against
        ${money(analysis.estimatedValueMinor)} over ${analysis.durationWeeks} weeks — every exposure below is computed
        against those two figures, so a matrix read months later still shows what it was judged on.
      </p>

      <div class="grid g4" style="padding:13px 17px 0">
        <div class="card">
          <h2>Requirements</h2>
          <div class="metric">${analysis.matrix.length}</div>
          <div class="metric-sub">${analysis.matrix.filter((l) => l.mandatory).length} pass/fail, the rest scored.</div>
        </div>
        <div class="card">
          <h2>Mandatory gaps</h2>
          <div class="metric ${raw(analysis.mandatoryGaps.length === 0 ? 'good' : 'bad')}">${analysis.mandatoryGaps.length}</div>
          <div class="metric-sub">Requirements that end the bid if they are still open on the day.</div>
        </div>
        <div class="card">
          <h2>Quantified exposure</h2>
          <div class="metric orange">${money(analysis.quantifiedExposureMinor)}</div>
          <div class="metric-sub">
            Money at risk: damages and retention. Bonding is shown per term as facility committed rather than loss, so
            the column below can total more than this.
          </div>
        </div>
        <div class="card">
          <h2>To ask the buyer</h2>
          <div class="metric ${raw(analysis.clarifications.length === 0 ? 'good' : 'warn')}">${analysis.clarifications.length}</div>
          <div class="metric-sub">Questions that have to go before the clarification deadline, not after.</div>
        </div>
      </div>

      ${
        analysis.bars.length > 0
          ? html`<div class="notice bad" style="margin:13px 17px 0">
              <div>
                <b>This invitation carries a bar, not a negotiation.</b>
                ${analysis.bars.map((bar) => html`<div style="margin-top:4px">${bar}</div>`)}
              </div>
            </div>`
          : ''
      }

      <h2 style="padding:15px 17px 0">Commercial terms, assessed against this business</h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
        Not transcribed. Each term is judged against the company's own margin, cover and balance sheet — which is why
        the same clause is routine on one tender and severe on another.
      </p>
      ${table({
        headers: ['Term', 'As stated', 'Severity', 'Exposure', 'What it means here'],
        align: ['', '', '', 'num', ''],
        rows: analysis.terms.map((t) => [
          t.term,
          t.stated,
          badge(humanise(t.severity), TERM_TONE[t.severity] ?? ''),
          t.exposureMinor === undefined ? '—' : money(t.exposureMinor),
          html`<span style="font-size:12px;color:var(--text-3)">${t.assessment}</span>`,
        ]),
        empty: 'No commercial term was recorded on this invitation',
      })}

      <h2 style="padding:15px 17px 0">Every requirement, with an owner</h2>
      <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
        A matrix without an owner is a list, and a list is what reaches the day before return with three items nobody
        claimed. Bids are lost over one missing certificate on a price that was right.
      </p>
      ${table({
        headers: ['Ref', 'Category', 'Requirement', 'Owner', 'Evidence required', 'On file', 'Weight', 'Due', 'Status'],
        align: ['', '', '', '', '', '', 'num', '', ''],
        rows: analysis.matrix.map((line) => [
          html`${line.reference}${line.mandatory ? badge('mandatory', gapRefs.has(line.reference) ? 'bad' : '') : ''}`,
          html`<span style="font-size:12px;color:var(--text-3)">${humanise(line.category)}</span>`,
          line.requirement,
          humanise(line.owner),
          html`<span style="font-size:12px;color:var(--text-3)">${line.evidenceRequired}</span>`,
          line.evidenceHeld
            ? html`<span style="font-size:12px;color:var(--text-3)">${line.evidenceHeld}</span>`
            : '—',
          line.weightingPercent === undefined ? '—' : `${line.weightingPercent}%`,
          line.dueBy ? date(line.dueBy) : '—',
          html`${badge(humanise(line.status), MATRIX_TONE[line.status] ?? '')}<br><span style="font-size:11px;color:var(--text-3)">${MATRIX_MEANING[line.status] ?? ''}</span>`,
        ]),
        empty: 'This analysis carries no requirements',
      })}

      <div class="grid g2" style="padding:13px 17px 15px">
        <div>
          <h2 style="margin-bottom:6px">The buyer's marking scheme</h2>
          <p style="font-size:12.5px;color:var(--text-3);margin:0 0 8px">
            ${
              analysis.weightings.stated === 0
                ? 'The invitation stated no weightings. Ask for the breakdown before pricing — an evaluation nobody can see is one nobody can bid to.'
                : analysis.weightings.complete
                  ? 'The stated weightings total 100%. The full breakdown is published.'
                  : `The stated weightings total ${analysis.weightings.stated}%, not 100%. Part of how this is being marked has not been disclosed.`
            }
          </p>
          <div class="split-list">
            ${analysis.weightings.declared.map(
              (w) => html`<div class="row"><span class="lbl">${humanise(w.category)}</span><span class="val">${w.percent}%</span></div>`,
            )}
            <div class="row">
              <span class="lbl"><b>Stated total</b></span>
              <span class="val">${badge(`${analysis.weightings.stated}%`, analysis.weightings.complete ? 'ok' : 'warn')}</span>
            </div>
          </div>
        </div>
        <div>
          <h2 style="margin-bottom:6px">Questions for the buyer</h2>
          <p style="font-size:12.5px;color:var(--text-3);margin:0 0 8px">
            Raised by the analysis rather than typed by somebody. These go through the clarification process and are
            answered to every bidder, so asking late is asking the competition's question for them.
          </p>
          ${
            analysis.clarifications.length === 0
              ? html`<div class="empty"><b>Nothing to ask</b>The invitation is internally consistent and insurable as written.</div>`
              : html`<div class="split-list">
                  ${analysis.clarifications.map((c) => html`<div class="row"><span class="lbl">${c}</span></div>`)}
                </div>`
          }
        </div>
      </div>
    </div>
  `;
}

/** Every command on this screen runs before a project exists. */
const TENANT = { tenantScoped: true };

export async function pipeline(root) {
  const [criteria, summary, discipline, profile, radar, tenders, permissions, matrices] = await Promise.all([
    api.get('/v1/pipeline/criteria'),
    api.get('/v1/pipeline'),
    api.get('/v1/pipeline/discipline'),
    // The company's own verified facts — everything the radar is allowed to
    // assert on a bid. Held here rather than on a settings page because this is
    // where somebody discovers the radar filtered them out of a job.
    api.get('/v1/company/profile').catch((error) => ({ error })),
    api.get('/v1/radar/latest').catch(() => ({ run: null })),
    api.get('/v1/pipeline/tenders'),
    api.get('/v1/permissions/matrix'),
    // Every matrix the tenancy holds, not only one produced in this session.
    api.get('/v1/pipeline/analyses'),
  ]);

  // The reader is project-scoped: a reading is filed against the project the
  // tender is bid from, and it costs ACUs against that project's tenancy.
  const projectId = state.session?.projectId;
  const [perception, evidence] = projectId
    ? await Promise.all([
        api.get(`/v1/projects/${projectId}/perception`).catch(() => null),
        api.get(`/v1/projects/${projectId}/evidence`).catch(() => null),
      ])
    : [null, null];

  // Why the reader cannot run here, in the platform's own words rather than a
  // rule copied into the browser: `blockedReason` reads the published
  // permission matrix and the published phase gates. Not tenant-scoped —
  // unlike the commands on this screen, an analysis is written to a project and
  // is gated by that project's lifecycle phase.
  const readBlocked = blockedReason('ESTIMATE_TENDER', 'C');
  const tenderPhases = phaseGates().ESTIMATE_TENDER ?? [];
  const tenderProjects = (state.projects ?? []).filter(
    (p) => tenderPhases.includes(p.phase) && p.id !== projectId,
  );

  const run = radar?.run ?? null;
  const board = tenders.tenders ?? [];
  // The role list comes from the published matrix rather than a second copy in
  // the browser: an owner on a deliverable has to be a role the platform knows.
  const roleOptions = Object.keys(permissions.matrix ?? {}).sort().map((role) => ({ value: role, label: humanise(role) }));
  const invitationOptions = board.map((t) => ({ value: t.invitationId, label: `${t.reference} · ${t.title}` }));
  const biddableOptions = board
    .filter((t) => t.stage === 'BID')
    .map((t) => ({ value: t.invitationId, label: `${t.reference} · closes ${t.deadline.local}` }));

  const thresholds = criteria.thresholds;
  const opportunities = summary.opportunities ?? [];

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Pipeline &amp; Bid Decisions</h1>
          <p>
            Ten weighted factors, one score, and a published rule. The platform recommends; a person decides. What it
            will not do is let an override pass unremarked.
          </p>
        </div>
        <div class="actions cmd-bar">
          ${raw(
            commandBar([
              // Tenant-scoped: the bid pipeline exists before there is a
              // project, so no project's lifecycle phase gates it. The API
              // runs these against the tenant governance scope.
              { id: 'invitation', label: 'Record an ITT', tone: '',
                permitted: can('ESTIMATE_TENDER', 'C', TENANT), reason: blockedReason('ESTIMATE_TENDER', 'C', TENANT) },
              { id: 'deliverable', label: 'Add a deliverable',
                permitted: can('ESTIMATE_TENDER', 'U', TENANT), reason: blockedReason('ESTIMATE_TENDER', 'U', TENANT) },
              { id: 'addendum', label: 'Record an addendum',
                permitted: can('ESTIMATE_TENDER', 'U', TENANT), reason: blockedReason('ESTIMATE_TENDER', 'U', TENANT) },
              { id: 'programme', label: 'Build tender programme',
                permitted: can('ESTIMATE_TENDER', 'C', TENANT), reason: blockedReason('ESTIMATE_TENDER', 'C', TENANT) },
            ]),
          )}
        </div>
      </div>
      <!--
        The agents that watch this area, at the point somebody is looking at the
        number they are about. The machinery was built and reachable only from
        the autopilot queue — the screen a person opens once they have already
        decided to look at what the fleet found, which is exactly backwards.
      -->
      <div id="pipeline-insight" style="margin-bottom:14px"></div>

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">Invitations in hand</h2>
        <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
          ${tenders.summary} The deadline is recorded in the zone it is read in and resolved to one instant — a portal
          that closes at noon in Dublin has closed an hour before noon here.
        </p>
        ${table({
          headers: ['Reference', 'Client', 'Closes', 'Zone', 'Left', 'Deliverables', 'Addenda', 'Stage', 'Ready to bid', 'Matrix'],
          align: ['', '', '', '', 'num', 'num', 'num', '', '', ''],
          rows: board.map((t) => [
            html`${t.reference}<br><span style="font-size:11.5px;color:var(--text-3)">${t.title}</span>`,
            t.clientName,
            t.deadline.local.replace('T', ' '),
            html`<span style="font-size:11.5px;color:var(--text-3)">${t.deadline.timeZone}</span>${
              t.deadline.anomaly ? badge(humanise(t.deadline.anomaly), 'bad') : ''
            }`,
            html`<span style="${raw(t.businessDaysRemaining <= 10 ? 'color:var(--orange)' : '')}">${t.businessDaysRemaining}d</span>`,
            `${t.deliverables.mandatory}/${t.deliverables.total}`,
            t.addenda,
            badge(BAND_LABEL[t.stage] ?? humanise(t.stage), STAGE_TONE[t.stage] ?? ''),
            t.reReviewReasons.length > 0
              ? badge('re-review', 'warn')
              : t.blockers.length > 0
                ? badge(`${t.blockers.length} blocking`, 'bad')
                : badge('ready', 'ok'),
            // The route from the invitation to the analysis of it. Without
            // this the matrix is a record with nothing pointing at it from the
            // thing it describes.
            t.analysisId
              ? html`<button class="btn sm" data-matrix="${t.analysisId}">Open</button>`
              : html`<span style="font-size:11.5px;color:var(--text-3)">Not analysed</span>`,
          ]),
          empty: 'No invitation recorded',
        })}
        ${
          board.some((t) => t.blockers.length > 0 || t.reReviewReasons.length > 0 || t.clarifications.length > 0)
            ? html`<div class="split-list" style="padding:0 17px 15px">
                ${board.flatMap((t) => [
                  ...t.reReviewReasons.map(
                    (reason) => html`<div class="row"><span class="lbl">${t.reference} ${badge('re-review', 'warn')} ${reason}</span></div>`,
                  ),
                  ...t.blockers.map(
                    (blocker) => html`<div class="row"><span class="lbl">${t.reference} ${badge('blocks the bid', 'bad')} ${blocker}</span></div>`,
                  ),
                  ...t.clarifications.map(
                    (c) => html`<div class="row">
                      <span class="lbl">${t.reference} ${badge(humanise(c.severity), SEVERITY_TONE[c.severity] ?? '')} ${c.subject}</span>
                      <span class="val" style="font-size:12px;color:var(--text-3)">${c.question}</span>
                    </div>`,
                  ),
                ])}
              </div>`
            : ''
        }
      </div>

      ${ittReadingPanel({
        perception,
        evidence,
        projectId,
        projectName: state.project?.name ?? '',
        blocked: readBlocked,
        tenderProjects,
        invitationOptions,
      })}

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">Compliance matrices on file</h2>
        <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
          ${matrices.summary} Every analysis stays readable after the session that produced it — rerunning one to see it
          again would spend AI budget re-deriving a record the platform already holds, and would write a second analysis
          of the same invitation into the record.
        </p>
        ${table({
          headers: ['Reference', 'Client', 'Returns', 'Requirements', 'Mandatory gaps', 'Bars', 'To ask', 'Exposure', 'Worst term', 'Verdict', ''],
          align: ['', '', '', 'num', 'num', 'num', 'num', 'num', '', '', ''],
          rows: (matrices.analyses ?? []).map((a) => [
            a.reference,
            a.clientName,
            date(a.returnBy),
            a.requirements,
            html`<span style="${raw(a.mandatoryGaps > 0 ? 'color:var(--critical)' : '')}">${a.mandatoryGaps}</span>`,
            html`<span style="${raw(a.bars > 0 ? 'color:var(--critical)' : '')}">${a.bars}</span>`,
            a.clarifications,
            money(a.quantifiedExposureMinor),
            a.worstTerm ? badge(humanise(a.worstTerm), TERM_TONE[a.worstTerm] ?? '') : '—',
            a.readyToPrice ? badge('ready to price', 'ok') : badge('not ready', 'bad'),
            html`<button class="btn sm" data-matrix="${a.analysisId}">Open</button>`,
          ]),
          empty: 'No invitation has been analysed yet',
        })}
      </div>

      <!-- The topbar is 54px and sticky, so scrolling this into view without a
           margin puts the matrix's own heading underneath it. -->
      <div id="matrix-detail" style="margin-bottom:14px;scroll-margin-top:68px"></div>

      <div class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h2>Declined</h2>
          <div class="metric ${raw(discipline.noBid > 0 ? 'good' : 'warn')}">${pct(discipline.noBidRatePercent, 1)}</div>
          <div class="metric-sub">
            ${discipline.noBid} of ${discipline.decided} decided. Refusing bad work is the point of scoring it.
          </div>
        </div>
        <div class="card">
          <h2>Bid effort released</h2>
          <div class="metric">${money(discipline.declinedValueMinor)}</div>
          <div class="metric-sub">Value walked away from — pursuits the bid team did not spend a month on.</div>
        </div>
        <div class="card">
          <h2>Overrides</h2>
          <div class="metric ${raw(discipline.overrides.length === 0 ? 'good' : 'warn')}">${discipline.overrides.length}</div>
          <div class="metric-sub">Decisions taken against the algorithm. Permitted, recorded, never silent.</div>
        </div>
        <div class="card">
          <h2>Live pipeline</h2>
          <div class="metric orange">${money(summary.liveValueMinor)}</div>
          <div class="metric-sub">${money(summary.wonValueMinor)} converted to projects.</div>
        </div>
      </div>

      ${
        discipline.observations.length > 0
          ? html`<div class="notice ${raw(discipline.noBid === 0 && discipline.decided > 0 ? 'warn' : 'info')}" style="margin-bottom:14px">
              <div>
                ${discipline.observations.map((o) => html`<div style="margin-bottom:4px">${o}</div>`)}
              </div>
            </div>`
          : ''
      }

      ${
        run
          ? html`
            <div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">
                Tender radar — ${run.ranOn}
                ${badge(`${run.shortlisted} of ${run.screened} worth reading`, run.shortlisted > 0 ? 'ok' : '')}
              </h2>
              <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
                Screened against the company's own recorded facts. It never claims a capability that is not on file — an
                invented reference is what a bid gets disqualified for.
              </p>
              ${table({
                headers: ['Opportunity', 'Value', 'Region', 'Closes', 'Competition', 'Score', 'Verdict'],
                align: ['', 'num', '', 'num', '', 'num', ''],
                rows: (run.results ?? []).map((r) => [
                  html`${r.title}<br><span style="font-size:11.5px;color:var(--text-3)">${r.reference} · ${r.clientName}</span>`,
                  money(r.estimatedValueMinor),
                  r.region,
                  html`<span style="${raw(r.daysToDeadline <= 14 ? 'color:var(--orange)' : '')}">${r.daysToDeadline}d</span>`,
                  badge(humanise(r.competition), r.competition === 'LOW' ? 'ok' : r.competition === 'HIGH' ? 'bad' : ''),
                  r.qualification.score,
                  r.eligible
                    ? badge(BAND_LABEL[r.qualification.recommendation], BAND_TONE[r.qualification.recommendation])
                    : badge('INELIGIBLE', 'bad'),
                ]),
                empty: 'Nothing screened',
              })}
              <div class="split-list" style="padding:0 17px 15px">
                ${(run.observations ?? []).map((o) => html`<div class="row"><span class="lbl">${o}</span></div>`)}
              </div>
            </div>

            ${(run.results ?? [])
              .filter((r) => !r.eligible || r.mitigations.length > 0)
              .map(
                (r) => html`<div class="card" style="margin-bottom:14px">
                  <h2>${r.title} ${r.eligible ? '' : badge('ineligible', 'bad')}</h2>
                  <div class="split-list">
                    ${r.eligibilityFailures.map(
                      (f) => html`<div class="row"><span class="lbl">✗ ${f.requirement}</span><span class="val">${f.reason}</span></div>`,
                    )}
                    ${r.strengths.map((x) => html`<div class="row"><span class="lbl">+ ${x}</span></div>`)}
                    ${r.risks.map((x) => html`<div class="row"><span class="lbl">! ${x}</span></div>`)}
                    ${r.mitigations.map((x) => html`<div class="row"><span class="lbl">→ ${x}</span></div>`)}
                    <div class="row"><span class="lbl">Margin target</span><span class="val">${r.marginTargetPercent.min}–${r.marginTargetPercent.max}%</span></div>
                  </div>
                </div>`,
              )}
          `
          : ''
      }

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">Do the bands predict?</h2>
        <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
          If jobs above ${thresholds.bidAbove} do not convert better than jobs pushed through from the review band, the
          weights are wrong. An algorithm nobody checks against outcomes is an opinion with arithmetic on it.
        </p>
        ${table({
          headers: ['Band', 'Score', 'Decided', 'Bid', 'Declined', 'Won', 'Lost', 'Win rate'],
          align: ['', '', 'num', 'num', 'num', 'num', 'num', 'num'],
          rows: discipline.byBand.map((b) => [
            badge(BAND_LABEL[b.band], BAND_TONE[b.band]),
            b.range,
            b.decided,
            b.bid,
            b.noBid,
            b.converted,
            b.lost,
            b.winRatePercent === null ? '—' : pct(b.winRatePercent, 1),
          ]),
          empty: 'No decisions recorded',
        })}
      </div>

      ${
        discipline.overrides.length > 0
          ? html`<div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">Decisions taken against the score</h2>
              <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
                The tool advises and the business decides. This is the list a post-mortem asks for and nobody writes down
                at the time.
              </p>
              ${table({
                headers: ['Opportunity', 'Score', 'Recommended', 'Decided', 'Outcome', 'Rationale'],
                align: ['', 'num', '', '', '', ''],
                rows: discipline.overrides.map((o) => [
                  o.title,
                  o.score,
                  badge(BAND_LABEL[o.recommendation], BAND_TONE[o.recommendation]),
                  badge(BAND_LABEL[o.decision] ?? o.decision, o.decision === 'BID' ? 'warn' : ''),
                  o.outcome,
                  html`<span style="font-size:12px;color:var(--text-3)">${o.rationale}</span>`,
                ]),
              })}
            </div>`
          : ''
      }

      <div class="grid g2" style="margin-bottom:14px">
        <div class="card pad0">
          <h2 style="padding:15px 17px 0">The algorithm</h2>
          <p style="padding:4px 17px 0;font-size:12.5px;color:var(--text-3);margin:0">
            Five is always good for us — including on the two factors named as risks, where reading the heading the other
            way round inverts the result.
          </p>
          ${table({
            headers: ['Factor', 'Weight', '5 means', '1 means'],
            align: ['', 'num', '', ''],
            rows: criteria.criteria.map((c) => [
              c.label,
              c.weight,
              html`<span style="font-size:12px;color:var(--text-3)">${c.good}</span>`,
              html`<span style="font-size:12px;color:var(--text-3)">${c.bad}</span>`,
            ]),
          })}
          <div class="split-list" style="padding:0 17px 15px">
            <div class="row"><span class="lbl">Below ${thresholds.noBidBelow}</span><span class="val">${badge('NO BID', 'bad')}</span></div>
            <div class="row"><span class="lbl">${thresholds.noBidBelow} to ${thresholds.bidAbove}</span><span class="val">${badge('Director review', 'warn')}</span></div>
            <div class="row"><span class="lbl">Above ${thresholds.bidAbove}</span><span class="val">${badge('BID', 'ok')}</span></div>
            <div class="row"><span class="lbl">Any factor at 1/5</span><span class="val">${badge('Held for review', 'warn')}</span></div>
          </div>
        </div>

        <div class="card">
          <h2>Where we keep scoring badly</h2>
          <p style="font-size:12.5px;color:var(--text-3);margin-bottom:11px">
            Factors scoring 2 or below across the pipeline. A recurring weakness is a business problem, not a run of bad
            opportunities.
          </p>
          ${
            discipline.recurringConcerns.length === 0
              ? html`<div class="empty"><b>Nothing recurring</b>No factor is repeatedly scoring badly.</div>`
              : html`<div class="split-list">
                  ${discipline.recurringConcerns.map(
                    (c) => html`<div class="row"><span class="lbl">${c.factor}</span><span class="val">${c.count}</span></div>`,
                  )}
                </div>`
          }
        </div>
      </div>

      <div class="card pad0">
        <h2 style="padding:15px 17px 0">Opportunities</h2>
        ${table({
          headers: ['Opportunity', 'Client', 'Value', 'Score', 'Recommended', 'Stage', 'Due'],
          align: ['', '', 'num', 'num', '', '', ''],
          rows: opportunities.map((o) => {
            const q = o.qualification;
            return [
              o.title,
              o.clientName,
              money(o.estimatedValueMinor),
              q ? q.score : '—',
              q
                ? html`${badge(BAND_LABEL[q.recommendation], BAND_TONE[q.recommendation])}${
                    q.cappedBy ? badge('capped', 'warn') : ''
                  }`
                : '—',
              badge(BAND_LABEL[o.stage] ?? o.stage, STAGE_TONE[o.stage] ?? ''),
              o.submissionDueAt ? date(o.submissionDueAt) : '—',
            ];
          }),
          empty: 'No opportunities registered',
        })}
      </div>

      ${positionReport({
        title: 'What this company can claim',
        intent:
          'Turnover, insurances, accreditations, references and capacity. The radar may assert none of it unless it ' +
          'is here, which is why an opportunity is sometimes filtered out for a fact nobody has recorded yet.',
        data: profile,
        error: profile?.error,
        sections: [
          { key: 'accreditations', label: 'Accreditations', empty: 'No accreditation is recorded.' },
          { key: 'insurances', label: 'Insurances', empty: 'No insurance is recorded.' },
          { key: 'references', label: 'References', empty: 'No reference is recorded.' },
          { key: 'sectors', label: 'Sectors', empty: 'No sector is claimed.' },
          { key: 'regions', label: 'Regions', empty: 'No region is claimed.' },
          { key: 'selfDeliveredTrades', label: 'Self-delivered trades', empty: 'Nothing is self-delivered.' },
          { key: 'capacity', label: 'Capacity' },
        ],
      })}
    `,
  );

  const COMMANDS = {
    invitation: {
      title: 'Record an invitation to tender',
      intent:
        'The deadline is registered before anybody reads the documents, because a countdown that starts when somebody ' +
        'gets round to it is not a countdown. The time zone is part of the deadline, not a detail — where the invitation ' +
        'did not state one, say so and the platform raises it as a question for the buyer.',
      path: (v) => `/v1/pipeline/opportunities/${v.opportunityId}/tenders`,
      submitLabel: 'Record',
      fields: [
        { name: 'opportunityId', label: 'Opportunity', type: 'select',
          options: opportunities.map((o) => ({ value: o.id, label: `${o.title} · ${o.clientName}` })) },
        { name: 'reference', label: 'The buyer’s reference', type: 'text', placeholder: 'ITT/2027/014' },
        { name: 'issuedAt', label: 'Issued', type: 'datetime-local',
          hint: 'When the invitation landed. Immutable — addenda append to it and never rewrite it.' },
        { name: 'returnLocal', label: 'Returns by (as the invitation states it)', type: 'datetime-local',
          hint: 'The wall-clock time printed in the ITT, not converted' },
        { name: 'timeZone', label: 'Read in', type: 'select', options: timeZoneOptions(), value: 'Europe/London' },
        { name: 'timeZoneStated', label: 'Did the invitation state the zone?', type: 'select',
          options: [{ value: 'true', label: 'Yes — it says so in the documents' }, { value: 'false', label: 'No — the zone above is our assumption' }],
          hint: 'An assumed deadline is a critical clarification, not a default' },
        { name: 'channel', label: 'Returned through', type: 'select',
          options: ['PORTAL', 'EMAIL', 'PHYSICAL', 'HAND_DELIVERY'].map((c) => ({ value: c, label: humanise(c) })) },
        { name: 'clarificationLocal', label: 'Last date for questions', type: 'datetime-local', required: false },
        { name: 'siteVisitLocal', label: 'Site visit', type: 'datetime-local', required: false },
      ],
      transform: (v) => ({
        reference: v.reference,
        issuedAt: new Date(v.issuedAt).toISOString(),
        returnLocal: v.returnLocal,
        timeZone: v.timeZone,
        timeZoneStated: v.timeZoneStated === 'true',
        channel: v.channel,
        ...(v.clarificationLocal ? { clarificationLocal: v.clarificationLocal } : {}),
        ...(v.siteVisitLocal ? { siteVisitLocal: v.siteVisitLocal } : {}),
      }),
    },

    deliverable: {
      title: 'Add a return deliverable',
      intent:
        'A mandatory deliverable needs a source in the invitation, an owner, and our own date — all three, before a bid ' +
        'can be approved. A bid disqualified for a missing certificate was priced correctly and lost anyway.',
      path: (v) => `/v1/pipeline/tenders/${v.invitationId}/deliverables`,
      submitLabel: 'Add',
      fields: [
        { name: 'invitationId', label: 'Invitation', type: 'select', options: invitationOptions },
        { name: 'reference', label: 'Reference', type: 'text', placeholder: 'D-01' },
        { name: 'title', label: 'What has to be returned', type: 'text', placeholder: 'Priced pricing schedule' },
        { name: 'mandatory', label: 'Pass / fail?', type: 'select',
          options: [{ value: 'true', label: 'Mandatory — failing it ends the bid' }, { value: 'false', label: 'Optional' }] },
        { name: 'owner', label: 'Owner', type: 'select', options: roleOptions, required: false,
          hint: 'Required on anything mandatory' },
        { name: 'internalDueBy', label: 'Our date', type: 'date', required: false,
          hint: 'Earlier than the buyer’s, and the one that actually binds' },
        { name: 'sourceDocument', label: 'Source document', type: 'text', required: false,
          placeholder: 'Instructions to Tenderers' },
        { name: 'sourceClause', label: 'Clause', type: 'text', required: false },
        { name: 'sourcePage', label: 'Page', type: 'number', required: false, min: 1 },
        { name: 'pageLimit', label: 'Page limit', type: 'number', required: false, min: 1 },
        { name: 'signatureRequired', label: 'Needs a signature?', type: 'select', required: false,
          options: [{ value: '', label: '—' }, { value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }],
          hint: 'A wet signature is a lead time, not a task' },
      ],
      transform: (v) => ({
        reference: v.reference,
        title: v.title,
        mandatory: v.mandatory === 'true',
        ...(v.owner ? { owner: v.owner } : {}),
        ...(v.internalDueBy ? { internalDueBy: v.internalDueBy } : {}),
        ...(v.pageLimit ? { pageLimit: Number(v.pageLimit) } : {}),
        ...(v.signatureRequired ? { signatureRequired: v.signatureRequired === 'true' } : {}),
        ...(v.sourceDocument
          ? {
              source: {
                document: v.sourceDocument,
                ...(v.sourceClause ? { clause: v.sourceClause } : {}),
                ...(v.sourcePage ? { page: Number(v.sourcePage) } : {}),
              },
            }
          : {}),
      }),
    },

    addendum: {
      title: 'Record an addendum',
      intent:
        'It appends. The original issue stays exactly as it was recorded, because "what was the deadline when we planned ' +
        'the bid" is what a late submission turns into a dispute about.',
      path: (v) => `/v1/pipeline/tenders/${v.invitationId}/addenda`,
      submitLabel: 'Record',
      fields: [
        { name: 'invitationId', label: 'Invitation', type: 'select', options: invitationOptions },
        { name: 'reference', label: 'Addendum reference', type: 'text', placeholder: 'ADD-01' },
        { name: 'issuedAt', label: 'Issued', type: 'datetime-local' },
        { name: 'summary', label: 'What it changed', type: 'textarea', rows: 3 },
        { name: 'returnLocal', label: 'Revised return time', type: 'datetime-local', required: false,
          hint: 'Leave blank where the addendum does not move the date. Moving it forces the bid decision to be taken again.' },
      ],
      transform: (v) => ({
        reference: v.reference,
        issuedAt: new Date(v.issuedAt).toISOString(),
        summary: v.summary,
        ...(v.returnLocal ? { returnLocal: v.returnLocal } : {}),
      }),
    },

    programme: {
      title: 'Build the tender programme',
      intent:
        'Back-planned from the return deadline across the working calendar, bank holidays included. Where the window ' +
        'cannot hold the eight stages, the platform refuses and shows the arithmetic rather than compressing them silently.',
      path: (v) => `/v1/pipeline/tenders/${v.invitationId}/programme`,
      submitLabel: 'Build',
      fields: [
        { name: 'invitationId', label: 'Invitation', type: 'select', options: biddableOptions,
          hint: biddableOptions.length === 0 ? 'Nothing has been decided as a bid yet' : 'Only invitations decided as a bid appear here' },
      ],
      transform: () => ({}),
    },
  };

  // Opening a matrix, from either the invitation it belongs to or the list of
  // every matrix on file. One handler, because both buttons are asking for the
  // same thing and a second path to it would be a second thing to keep right.
  // The AI reading of an invitation: read it, then confirm or reject what it
  // read. Written out per action rather than assembled from a variable, so each
  // path is a quotable route the door invariant can see.
  root.addEventListener('click', async (event) => {
    const readIt = event.target.closest('[data-read-itt]');
    if (readIt) {
      readIt.disabled = true;
      readIt.textContent = 'Reading…';
      try {
        await api.post(`/v1/projects/${projectId}/perception/itt`, { hash: readIt.dataset.readItt });
        await draw();
      } catch (error) {
        // A refusal here is usually a true statement about the file, the
        // deployment or the wallet, so it is shown as it was given.
        toast('Not read', error.message, error.code === 'PERCEPTION_PROVIDER_UNAVAILABLE' ? 'warn' : 'err');
        readIt.disabled = false;
        readIt.textContent = 'Read this invitation';
      }
      return;
    }

    const confirmIt = event.target.closest('[data-confirm-itt]');
    if (confirmIt) {
      // Three figures the analyst needs and no invitation states, because none
      // of them is about the buyer: what this business expects to price, over
      // how long, and at what margin. Asked here rather than guessed, because
      // every exposure figure in the matrix is computed against them.
      const accepted = await command({
        title: 'Confirm what the AI read',
        intent:
          'Confirming files the reading through the same commands as typing the requirements in by hand — the ' +
          'analyst, its authorisation and its ACU cost are unchanged. The three figures below are not in the ' +
          'invitation: an ITT states what the buyer wants, not what this business expects to price it at, and ' +
          'every exposure in the matrix is set against them.',
        path: () => `/v1/projects/${projectId}/perception/${confirmIt.dataset.confirmItt}/confirm`,
        submitLabel: 'Confirm and build the matrix',
        fields: [
          {
            name: 'invitationId',
            label: 'Against which invitation',
            type: 'select',
            options: invitationOptions,
            hint: 'The reading is filed against the invitation it came from.',
          },
          {
            name: 'estimatedValue',
            label: 'What we expect to price (£)',
            type: 'number',
            step: '1',
            hint: 'The contract value this business is bidding, not the buyer’s published budget.',
          },
          { name: 'durationWeeks', label: 'Priced over (weeks)', type: 'number', step: '1' },
          {
            name: 'targetMarginPercent',
            label: 'Target margin (%)',
            type: 'number',
            step: '0.1',
            required: false,
            hint: 'Left blank, the company profile’s own minimum is used.',
          },
        ],
        transform: (v) => ({
          invitationId: v.invitationId,
          // Pounds in the form, minor units on the wire. Asking a bid manager
          // for pennies is how a value lands two orders of magnitude out.
          estimatedValueMinor: Math.round(Number(v.estimatedValue) * 100),
          durationWeeks: Number(v.durationWeeks),
          ...(v.targetMarginPercent ? { targetMarginPercent: Number(v.targetMarginPercent) } : {}),
        }),
      });
      if (accepted) {
        toast('Filed', 'The compliance matrix and the return register are on the record', 'ok');
        await draw();
      }
      return;
    }

    const rejectIt = event.target.closest('[data-reject-itt]');
    if (rejectIt) {
      const reason = window.prompt('Why is this reading wrong? It stays in the record either way.');
      if (!reason) return;
      try {
        await api.post(`/v1/projects/${projectId}/perception/${rejectIt.dataset.rejectItt}/discard`, { reason });
        await draw();
      } catch (error) {
        toast('Not rejected', error.message, 'err');
      }
      return;
    }

    // Switching to a project the platform will accept a tender analysis on,
    // through the console's own project switcher rather than a second one.
    const openProjectButton = event.target.closest('[data-open-project]');
    if (openProjectButton) {
      await openProject(openProjectButton.dataset.openProject);
      return;
    }
  });

  const detail = root.querySelector('#matrix-detail');
  root.addEventListener('click', async (event) => {
    const open = event.target.closest('[data-matrix]');
    if (!open || !detail) return;

    const analysisId = open.dataset.matrix;
    open.disabled = true;
    open.textContent = 'Opening…';
    try {
      const analysis = await api.get(`/v1/pipeline/analyses/${analysisId}`);
      render(detail, matrixDetail(analysis));
      detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      // Shown as a denial rather than as an empty panel. A matrix that failed
      // to load and a matrix with nothing in it must not look the same.
      render(detail, notice(`This compliance matrix could not be opened: ${error.message}`, 'err'));
    } finally {
      open.disabled = false;
      open.textContent = 'Open';
    }
  });

  void insightPanel(root.querySelector('#pipeline-insight'), {
    projectId,
    areas: ['BUSINESS_DEVELOPMENT', 'ESTIMATE_TENDER'],
    subject: 'the pipeline and what to bid',
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
