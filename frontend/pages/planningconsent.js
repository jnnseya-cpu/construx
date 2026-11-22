import { api } from '../lib/api.js';
import { badge, date, exact as money, html, humanise, notice, render, table, toast } from '../lib/ui.js';

/**
 * CONSTRUX Planning, after the appraisal: the gates, the applications and their
 * events, the packs, the requirements and their evidence, the permissions with
 * their conditions, the condition requests, the obligations and the release of
 * works — all read from `GET /planning/register`, every action a command panel
 * against the routes beside it. The lists the forms offer come from the
 * register's own vocabulary.
 */

const GATE_TONE = { approved: 'ok', in_review: 'info', blocked: 'bad', open: 'neutral', superseded: 'warn' };
const GATE_WORDS = { approved: 'approved', in_review: 'ready to approve', blocked: 'blocked', open: 'not yet reached', superseded: 'needs re-review' };
const GATE_NAMES = { G0: 'Appraise', G1: 'Commit to route', G2: 'Approve submission pack', G3: 'Record decision', G4: 'Release works', G5: 'Release occupation' };
const STATUS_TONE = { DRAFT: 'neutral', READY: 'info', SUBMITTED: 'info', INVALID: 'bad', VALID: 'info', DETERMINED: 'ok', WITHDRAWN: 'neutral' };
const CONDITION_TONE = { OUTSTANDING: 'warn', SUBMITTED: 'info', DISCHARGED: 'ok', REFUSED: 'bad', COMPLYING: 'ok' };
const RELEASE_TONE = { REQUESTED: 'info', APPROVED: 'ok', REVOKED: 'bad', WITHDRAWN: 'neutral' };

/** The extra fields each kind of event asks for. Which event is allowed when is the platform's to say. */
const EVENT_FIELDS = {
  submitted: [{ name: 'externalRef', label: 'Portal or authority reference', type: 'text' }],
  invalid: [{ name: 'reasons', label: 'What the authority found invalid', type: 'textarea', rows: 2 }],
  resubmitted: [{ name: 'externalRef', label: 'Reference', type: 'text', required: false }],
  validated: [
    { name: 'statutoryWeeks', label: 'Statutory weeks, if no evaluation settles it', type: 'number', min: 1, step: '1', required: false },
    { name: 'weeksBasis', label: 'Why that period applies', type: 'text', required: false },
    { name: 'authorityTargetOn', label: 'The authority’s own target date', type: 'date', required: false },
  ],
  invalidated: [{ name: 'reasons', label: 'The authority’s correction', type: 'textarea', rows: 2 }],
  withdrawn: [{ name: 'reason', label: 'Why', type: 'text' }],
  consultation: [
    { name: 'kind', label: 'Kind', type: 'select', options: [{ value: 'STATUTORY', label: 'Statutory consultation' }, { value: 'DEVELOPER_LED', label: 'Developer-led engagement' }] },
    { name: 'summary', label: 'Who responded and what they said', type: 'textarea', rows: 3 },
  ],
  amended_plans: [{ name: 'summary', label: 'What changed', type: 'text', required: false }],
  extension: [{ name: 'agreedTo', label: 'Extended to', type: 'date' }],
  committee_resolution: [
    { name: 'resolution', label: 'The resolution as minuted', type: 'textarea', rows: 2 },
    { name: 'subjectToS106', label: 'Subject to a section 106 agreement', type: 'checkbox' },
  ],
  forecast: [
    { name: 'forecastDecisionOn', label: 'Forecast decision date', type: 'date' },
    { name: 'basis', label: 'What the forecast rests on', type: 'text' },
  ],
  determined: [
    { name: 'outcome', label: 'Outcome', type: 'select', options: [{ value: 'GRANTED', label: 'Granted' }, { value: 'REFUSED', label: 'Refused' }] },
    { name: 'issuedBy', label: 'Issuing authority and decision reference', type: 'text' },
    { name: 'issuedNotice', label: 'This is the signed, issued notice — not a draft or a committee report', type: 'checkbox' },
    { name: 'commencementBy', label: 'Commencement deadline on the notice', type: 'date', required: false },
    { name: 'reservedMattersBy', label: 'Reserved matters to be applied for by (outline)', type: 'date', required: false },
    { name: 'amendmentSummary', label: 'What the amendment changes (section 96A)', type: 'text', required: false },
  ],
  appeal_lodged: [{ name: 'appealRef', label: 'Appeal reference', type: 'text' }],
  appeal_decided: [
    { name: 'outcome', label: 'Outcome', type: 'select', options: [{ value: 'ALLOWED', label: 'Allowed' }, { value: 'DISMISSED', label: 'Dismissed' }] },
    { name: 'inspectorRef', label: 'Inspector’s decision reference', type: 'text' },
    { name: 'commencementBy', label: 'Commencement deadline', type: 'date', required: false },
    { name: 'reservedMattersBy', label: 'Reserved matters by (outline)', type: 'date', required: false },
  ],
};

/** Requirement filters, kept for the session of this screen. */
const filters = { applicationId: '', gate: '', phase: '', status: '' };

/** "1 day", "12 days". */
const dayCount = (n) => (n === 1 ? '1 day' : String(n) + ' day' + 's');

/** A manifest hash as people compare it: the digits, without the algorithm prefix. */
const shortHash = (hash) => String(hash).replace(/^sha256:/, '').slice(0, 12);

/** The project id out of `/v1/projects/:id/planning`, so a read names its route in full. */
const projectIdOf = (base) => base.split('/')[3];

const evidenceOptions = (reg) => reg.evidence.map((entry) => ({ value: `${entry.refType}|${entry.refId}`, label: `${entry.label}${entry.quarantined ? ' — flagged by the scanner' : ''}` }));
const evidenceField = (reg, name = 'evidence', label = 'Evidence', required = false) => ({
  name,
  label,
  type: 'multiselect',
  options: evidenceOptions(reg),
  required,
  hint: reg.evidence.length === 0 ? 'No document you can cite is on this project yet — deposit it in the CDE on Design & BIM.' : 'CDE revisions and filed documents on this project.',
});
const refs = (values) => (values ?? []).map((value) => {
  const [refType, ...rest] = String(value).split('|');
  return { refType, refId: rest.join('|') };
});
const list = (value) => String(value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
const appName = (reg, id) => reg.applications.find((entry) => entry.id === id)?.reference ?? '—';

function blockerList(blockers) {
  if (blockers.length === 0) return html`<span class="metric-sub">nothing blocking</span>`;
  return html`<details><summary style="cursor:pointer;font-size:12.5px">${blockers.length} blocker(s)</summary><ul style="margin:4px 0 0 16px;font-size:12px">${blockers.map(
    (blocker) => html`<li>${badge(humanise(blocker.kind).toLowerCase(), blocker.kind === 'COMMERCIAL' ? 'warn' : blocker.kind === 'EVIDENCE' ? 'info' : 'bad')} ${blocker.reason}</li>`,
  )}</ul></details>`;
}

function gateRow(position, applicationId, canApprove) {
  const approve =
    canApprove && position.status !== 'approved' && position.status !== 'open'
      ? applicationId
        ? html`<button class="btn quiet sm" data-command="pl-gate" data-gate="${position.gate}" data-application="${applicationId}">Approve</button>`
        : html`<button class="btn quiet sm" data-command="pl-gate" data-gate="${position.gate}">Approve</button>`
      : '';
  return [
    html`<b>${position.gate}</b> ${GATE_NAMES[position.gate]}`,
    html`${badge(GATE_WORDS[position.status], GATE_TONE[position.status])}${
      position.review?.invalidated ? html`<br><span class="metric-sub">${position.review.invalidated.reasons.slice(0, 2).join(' ')}</span>` : ''
    }${position.review?.status === 'APPROVED' ? html`<br><span class="metric-sub">${date(position.review.approvedAt)}: ${position.review.rationale}</span>` : ''}${
      position.review?.riskAcceptances?.length
        ? html`<br><span class="metric-sub">Risk accepted: ${position.review.riskAcceptances.map((entry) => `${entry.reason} — ${entry.rationale}`).join('; ')}</span>`
        : ''
    }`,
    blockerList(position.blockers),
    approve,
  ];
}

export function consentCards(reg, view, perms) {
  if (reg.error) return notice(`The applications and gates could not be read: ${reg.error.message ?? String(reg.error)}`, 'err');
  const { canCreate, canUpdate, canApprove } = perms;
  return html`
    <section class="card" style="margin-bottom:14px" aria-labelledby="pl-gates-h" data-planning-gates>
      <h2 id="pl-gates-h">Gates</h2>
      <p class="metric-sub">Each gate is approved only when nothing blocks it at that moment. A commercial assumption can be accepted as a risk; nothing statutory can. An approval whose inputs change afterwards is marked for re-review.</p>
      ${table({
        headers: ['Gate', 'Status', 'What stands in the way', ''],
        rows: [
          gateRow(reg.gates.project, undefined, canApprove),
          ...reg.gates.applications.flatMap((entry) =>
            entry.gates.map((position) => {
              const row = gateRow(position, entry.applicationId, canApprove);
              row[0] = html`${row[0]} <span class="metric-sub">${entry.reference}</span>`;
              return row;
            }),
          ),
        ],
      })}
    </section>

    <section class="card" style="margin-bottom:14px" aria-labelledby="pl-apps-h" data-planning-applications>
      <h2 id="pl-apps-h">Applications and decisions ${canCreate ? html`<button class="btn quiet sm" data-command="pl-app">Promote a proposal</button>` : ''}</h2>
      ${table({
        headers: ['Application', 'Status', 'Clock', 'Decision', 'Record an event', ''],
        empty: 'No application yet',
        emptyDetail: 'Promote a proposal to a full or outline application; reserved matters, section 73 and 96A are drafted from a permission.',
        rows: reg.applications.map((application) => [
          html`<b>${application.reference}</b> ${humanise(application.route)}<br><span class="metric-sub">${application.phases.join(', ')}${application.externalRef ? ` · ${application.externalRef}` : ''}${
            application.reservedMatters ? ` · matters: ${application.reservedMatters.join(', ')}` : ''
          }</span>`,
          badge(humanise(application.status).toLowerCase(), STATUS_TONE[application.status] ?? 'neutral'),
          application.clock
            ? html`${application.clock.weeks} weeks to ${application.clock.statutoryTargetOn}${application.extension ? html`<br>extended to ${application.extension.agreedTo}` : ''}${
                application.clockPosition ? html`<br>${badge(application.clockPosition.overdue ? dayCount(-application.clockPosition.daysLeft) + ' over' : dayCount(application.clockPosition.daysLeft) + ' left', application.clockPosition.overdue ? 'bad' : 'info')}` : ''
              }${application.forecastDecisionOn ? html`<br><span class="metric-sub">forecast ${application.forecastDecisionOn}</span>` : ''}`
            : html`<span class="metric-sub">${application.madeOn ? `made ${application.madeOn}` : application.targetSubmissionOn ? `target submission ${application.targetSubmissionOn}` : '—'}</span>`,
          html`${application.decision ? html`${badge(application.decision.outcome.toLowerCase(), application.decision.outcome === 'GRANTED' ? 'ok' : 'bad')} ${application.decision.decidedOn}` : '—'}${
            application.committee && !application.decision ? html`<br><span class="metric-sub">committee: ${application.committee.resolution}</span>` : ''
          }${application.appeal ? html`<br>appeal ${application.appeal.reference}: ${application.appeal.outcome ? badge(application.appeal.outcome.toLowerCase(), application.appeal.outcome === 'ALLOWED' ? 'ok' : 'bad') : 'pending'}` : ''}`,
          canUpdate
            ? html`<select data-event-type="${application.id}" aria-label="Event for ${application.reference}" style="max-width:160px">${reg.vocabulary.events.map(
                (type) => html`<option value="${type}">${humanise(type)}</option>`,
              )}</select> <button class="btn quiet sm" data-command="pl-event" data-application="${application.id}">Record</button>`
            : '',
          canCreate && (application.status === 'DRAFT' || application.status === 'INVALID')
            ? html`<button class="btn quiet sm" data-command="pl-pack" data-application="${application.id}">Assemble pack</button>`
            : '',
        ]),
      })}
      ${
        reg.packs.length
          ? html`<h3 style="margin-top:12px">Submission packs</h3>
              ${table({
                headers: ['Pack', 'Application', 'Status', 'Items', ''],
                rows: reg.packs.map((pack) => [
                  html`<code>${shortHash(pack.manifestHash)}</code><br><span class="metric-sub">${date(pack.assembledAt)}</span>`,
                  appName(reg, pack.applicationId),
                  html`${badge(pack.status.toLowerCase(), pack.status === 'APPROVED' ? 'ok' : 'info')}${pack.stale.length ? html`<br><span class="metric-sub">stale: ${pack.stale.join(' ')}</span>` : ''}`,
                  html`<details><summary style="cursor:pointer;font-size:12.5px">${pack.items.length} frozen items</summary><ul style="margin:4px 0 0 16px;font-size:12px">${pack.items.map(
                    (item) => html`<li>${humanise(item.kind)}: ${item.label}</li>`,
                  )}</ul></details>`,
                  html`<button class="btn quiet sm" data-pack-manifest="${pack.id}">Export manifest</button>`,
                ]),
              })}`
          : ''
      }
    </section>

    ${requirementsCard(reg, canCreate, canUpdate)}
    ${studiesCard(reg, canCreate, canUpdate)}
    ${permissionsCard(reg, canCreate, canUpdate, canApprove)}
    ${obligationsCard(reg, canCreate, canUpdate)}
    ${releasesCard(reg, canCreate, canUpdate, canApprove)}
  `;
}

function requirementsCard(reg, canCreate, canUpdate) {
  const phases = [...new Set(reg.applications.flatMap((application) => application.phases))];
  const shown = reg.requirements.filter(
    (entry) =>
      (!filters.applicationId || entry.applicationId === filters.applicationId) &&
      (!filters.gate || entry.gate === filters.gate) &&
      (!filters.phase || entry.phase === filters.phase) &&
      (!filters.status || (filters.status === 'OPEN' ? !['ACCEPTED', 'NOT_APPLICABLE'].includes(entry.delivery) : entry.delivery === filters.status)),
  );
  const select = (name, label, options) =>
    html`<label style="font-size:12px">${label} <select data-req-filter="${name}">${[{ value: '', label: 'All' }, ...options].map(
      (option) => html`<option value="${option.value}" ${filters[name] === option.value ? 'selected' : ''}>${option.label}</option>`,
    )}</select></label>`;
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="pl-req-h" data-planning-requirements id="planning-requirements">
    <h2 id="pl-req-h">Requirements and evidence ${canCreate && reg.applications.length ? html`<button class="btn quiet sm" data-command="pl-req-add">Add a requirement</button>` : ''}</h2>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin:6px 0">
      ${select('applicationId', 'Application', reg.applications.map((entry) => ({ value: entry.id, label: entry.reference })))}
      ${select('gate', 'Gate', ['G1', 'G2', 'G3', 'G4', 'G5'].map((gate) => ({ value: gate, label: gate })))}
      ${select('phase', 'Phase', phases.map((phase) => ({ value: phase, label: phase })))}
      ${select('status', 'Status', [{ value: 'OPEN', label: 'Open' }, ...['ACCEPTED', 'NOT_APPLICABLE', 'RETURNED'].map((value) => ({ value, label: humanise(value) }))])}
      ${canCreate ? reg.applications.map((application) => html`<button class="btn quiet sm" data-command="pl-req-generate" data-application="${application.id}">Refresh ${application.reference}’s list</button>`) : ''}
    </div>
    ${table({
      headers: ['Requirement', 'Application', 'Gate', 'Delivery', 'Evidence', ''],
      empty: reg.requirements.length ? 'Nothing matches these filters' : 'No requirement yet',
      emptyDetail: reg.requirements.length ? 'Clear a filter to see more.' : 'An application generates its requirements when it is drafted.',
      rows: shown.map((entry) => [
        html`${entry.title}${entry.submissionCritical ? html` ${badge('submission-critical', 'warn')}` : ''}<br><span class="metric-sub">${humanise(entry.kind)} · ${entry.basis}</span>${
          entry.reviews.length ? html`<br><span class="metric-sub">Last review: ${humanise(entry.reviews.at(-1).decision).toLowerCase()} — ${entry.reviews.at(-1).rationale}${entry.reviews.at(-1).source ? ` (source: ${entry.reviews.at(-1).source})` : ''}</span>` : ''
        }`,
        appName(reg, entry.applicationId),
        html`${entry.gate}${entry.phase ? html`<br><span class="metric-sub">${entry.phase}</span>` : ''}`,
        html`${badge(humanise(entry.delivery).toLowerCase(), entry.delivery === 'ACCEPTED' || entry.delivery === 'NOT_APPLICABLE' ? 'ok' : entry.delivery === 'RETURNED' ? 'bad' : 'neutral')}${
          entry.owner ? html`<br><span class="metric-sub">${entry.owner}${entry.dueOn ? `, due ${entry.dueOn}` : ''}</span>` : ''
        }`,
        html`<span style="font-size:12px">${entry.evidence.map((item) => item.label).join('; ') || '—'}</span>`,
        canUpdate
          ? html`<button class="btn quiet sm" data-command="pl-req-update" data-requirement="${entry.id}">Update</button> <button class="btn quiet sm" data-command="pl-req-review" data-requirement="${entry.id}">Review</button>`
          : '',
      ]),
    })}
  </section>`;
}

function studiesCard(reg, canCreate, canUpdate) {
  const tone = { REQUIRED: 'warn', REVIEW: 'info', NOT_REQUIRED: 'neutral' };
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="pl-study-h" data-planning-studies>
    <h2 id="pl-study-h">Studies ${canCreate ? reg.applications.filter((entry) => entry.status === 'DRAFT').map((application) => html`<button class="btn quiet sm" data-command="pl-study-generate" data-application="${application.id}">Plan ${application.reference}’s studies</button> `) : ''}</h2>
    <p class="metric-sub">Scheduled forward from each commission date, through its dependencies and the next open survey window. A study that would finish after the target submission or the land option is flagged.</p>
    ${table({
      headers: ['Study', 'Application', 'Applies', 'Schedule', 'Critical', ''],
      empty: 'No study planned',
      emptyDetail: 'Plan an application’s studies once it is drafted.',
      rows: reg.studies.map((study) => [
        html`${study.title}${study.consultant ? html`<br><span class="metric-sub">${study.consultant}</span>` : ''}`,
        appName(reg, study.applicationId),
        html`${badge(humanise(study.applicability).toLowerCase(), tone[study.applicability])}<br><span class="metric-sub">${study.applicabilityNote ?? study.basis}</span>`,
        study.start
          ? html`${study.start} → ${study.finish}${study.surveyWindow ? html`<br><span class="metric-sub">window ${study.surveyWindow.from} to ${study.surveyWindow.to}${study.waitedForWindowDays ? ', waits ' + dayCount(study.waitedForWindowDays) : ''}</span>` : ''}`
          : html`<span class="metric-sub">not scheduled</span>`,
        study.critical.length ? html`${badge('on the critical path', 'bad')}<br><span style="font-size:12px">${study.critical.join(' ')}</span>` : '—',
        canUpdate ? html`<button class="btn quiet sm" data-command="pl-study-update" data-study="${study.id}">Update</button>` : '',
      ]),
    })}
  </section>`;
}

function permissionsCard(reg, canCreate, canUpdate, canApprove) {
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="pl-perm-h" data-planning-permissions>
    <h2 id="pl-perm-h">Permissions and conditions ${canCreate && reg.consents.length ? html`<button class="btn quiet sm" data-command="pl-cond-request">Record a discharge request</button>` : ''}</h2>
    ${
      reg.consents.length === 0
        ? html`<p class="metric-sub">No permission yet. A granted decision, or an appeal allowed, records one.</p>`
        : reg.consents.map(
            (consent) => html`<div style="border-top:1px solid var(--line);padding-top:10px;margin-top:10px">
              <h3 style="margin:0">${consent.reference} ${badge(humanise(consent.type).toLowerCase(), 'info')} ${badge(consent.status.toLowerCase(), consent.status === 'EFFECTIVE' ? 'ok' : 'neutral')}${consent.viaAppeal ? html` ${badge('on appeal', 'info')}` : ''}</h3>
              <p class="metric-sub" style="margin:4px 0">Decided ${consent.decidedOn} · phases ${consent.phases.join(', ')}${consent.timeLimits.commencementBy ? ` · begin by ${consent.timeLimits.commencementBy}` : ''}${
                consent.timeLimits.reservedMattersBy ? ` · reserved matters by ${consent.timeLimits.reservedMattersBy}` : ''
              }${consent.lineage.length ? ` · rests on ${consent.lineage.map((entry) => entry.reference).join(' ← ')}` : ''}${consent.amendments.length ? ` · ${consent.amendments.length} s96A amendment(s)` : ''}</p>
              ${
                consent.outstandingMatters
                  ? html`<p class="metric-sub" style="margin:4px 0">Reserved matters outstanding: ${Object.entries(consent.outstandingMatters)
                      .map(([phase, matters]) => `${phase}: ${matters.length ? matters.join(', ') : 'none'}`)
                      .join(' · ')}</p>`
                  : ''
              }
              <p style="margin:6px 0">
                ${canCreate ? html`<button class="btn quiet sm" data-command="pl-cond-add" data-consent="${consent.id}">Add a condition</button>` : ''}
                ${canUpdate && !consent.conditionsComplete ? html` <button class="btn quiet sm" data-command="pl-cond-complete" data-consent="${consent.id}" data-count="${consent.conditions.filter((entry) => !entry.statutory).length}">Confirm all conditions entered</button>` : ''}
                ${consent.conditionsComplete ? badge(`all ${consent.conditionsComplete.count} conditions entered`, 'ok') : ''}
                ${canCreate && consent.status === 'EFFECTIVE' ? html` <button class="btn quiet sm" data-command="pl-app-linked" data-consent="${consent.id}" data-type="${consent.type}">Draft a linked application</button>` : ''}
                ${canApprove && consent.status === 'EFFECTIVE' ? html` <button class="btn quiet sm" data-command="pl-consent-status" data-consent="${consent.id}">Mark lapsed or superseded</button>` : ''}
              </p>
              ${table({
                headers: ['No.', 'Condition', 'Trigger', 'Status', ''],
                empty: 'No condition entered',
                emptyDetail: 'Enter each condition exactly as the notice words it.',
                rows: consent.conditions.map((condition) => [
                  condition.number,
                  html`<details><summary style="cursor:pointer;font-size:12.5px">${condition.interpretation}</summary><p style="font-size:12px;margin:4px 0">“${condition.wording}”</p></details>`,
                  html`${humanise(condition.trigger).toLowerCase()}${condition.triggerText ? html`<br><span class="metric-sub">${condition.triggerText}</span>` : ''}${condition.phases.length ? html`<br><span class="metric-sub">${condition.phases.join(', ')}</span>` : ''}`,
                  html`${badge(humanise(condition.status).toLowerCase(), CONDITION_TONE[condition.status] ?? 'neutral')}${condition.verified ? '' : html` ${badge('wording not verified', 'warn')}`}${
                    condition.responses.length ? html`<br><span class="metric-sub">${condition.responses.at(-1).outcome.toLowerCase()} ${condition.responses.at(-1).on}: ${condition.responses.at(-1).note}</span>` : ''
                  }`,
                  canUpdate && !condition.verified ? html`<button class="btn quiet sm" data-command="pl-cond-verify" data-condition="${condition.id}" data-number="${condition.number}">Verify wording</button>` : '',
                ]),
              })}
            </div>`,
          )
    }
    ${
      reg.conditionRequests.length
        ? html`<h3 style="margin-top:12px">Discharge requests</h3>
            ${table({
              headers: ['Request', 'Conditions', 'Status', ''],
              rows: reg.conditionRequests.map((request) => {
                const conditions = reg.consents.flatMap((consent) => consent.conditions);
                return [
                  html`${request.reference}<br><span class="metric-sub">made ${request.madeOn}${request.externalRef ? ` · ${request.externalRef}` : ''}${request.feeQuoteId ? ' · fee quoted' : ''}</span>`,
                  html`<span style="font-size:12px">${request.conditionIds
                    .map((id) => {
                      const condition = conditions.find((entry) => entry.id === id);
                      const outcome = request.outcomes[id];
                      return `${condition?.number ?? id}${outcome ? ` (${outcome.outcome.toLowerCase()})` : ''}`;
                    })
                    .join(', ')}</span>`,
                  badge(humanise(request.status).toLowerCase(), request.status === 'DECIDED' ? 'ok' : 'info'),
                  canUpdate && request.status !== 'DECIDED' ? html`<button class="btn quiet sm" data-command="pl-cond-response" data-request="${request.id}">Record the authority’s answer</button>` : '',
                ];
              }),
            })}`
        : ''
    }
  </section>`;
}

function obligationsCard(reg, canCreate, canUpdate) {
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="pl-obl-h" data-planning-obligations>
    <h2 id="pl-obl-h">Obligations ${canCreate ? html`<button class="btn quiet sm" data-command="pl-obl-add">Register an obligation</button>` : ''}</h2>
    ${table({
      headers: ['Obligation', 'Triggers', 'Phases', 'Status', 'Owner', ''],
      empty: 'No obligation registered',
      emptyDetail: 'Section 106 heads of terms, section 278, undertakings and CIL notices are registered here with their triggers.',
      rows: reg.obligations.map((obligation) => [
        html`<b>${obligation.reference}</b> ${obligation.instrument} ${obligation.clause}<br><span style="font-size:12.5px">${obligation.description}</span>${
          obligation.amountMinor !== undefined ? html`<br><span class="metric-sub">${obligation.amountMinor === null ? 'amount unknown' : money(obligation.amountMinor)}${obligation.indexation ? ` · indexed ${obligation.indexation}` : ''}${obligation.cap ? ` · cap ${obligation.cap}` : ''}</span>` : ''
        }`,
        html`<span style="font-size:12px">${obligation.triggers.map((trigger) => `${humanise(trigger.event).toLowerCase()}${trigger.count ? ` ${trigger.count}` : ''}${trigger.on ? ` ${trigger.on}` : ''}${trigger.text ? ` — ${trigger.text}` : ''}`).join('; ')}</span>`,
        obligation.phases.length ? obligation.phases.join(', ') : 'all',
        html`${badge(obligation.status.toLowerCase(), obligation.status === 'SATISFIED' ? 'ok' : obligation.status === 'EXECUTED' ? 'info' : 'warn')}${obligation.dueSince ? html` ${badge(`due since ${obligation.dueSince}`, 'bad')}` : ''}`,
        obligation.owner,
        canUpdate && obligation.status !== 'SATISFIED' ? html`<button class="btn quiet sm" data-command="pl-obl-progress" data-obligation="${obligation.id}">Record progress</button>` : '',
      ]),
    })}
  </section>`;
}

function releasesCard(reg, canCreate, canUpdate, canApprove) {
  const effective = reg.consents.filter((consent) => consent.status === 'EFFECTIVE');
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="pl-rel-h" data-planning-releases>
    <h2 id="pl-rel-h">Release of works and occupation ${canCreate && effective.length ? html`<button class="btn quiet sm" data-command="pl-rel-request">Request a release</button>` : ''}</h2>
    <p class="metric-sub">A release covers one phase and one operation. It is revoked on the record — and Delivery alerted — if anything it rests on changes. Link a programme task so works recorded without a live release are flagged.</p>
    ${table({
      headers: ['Release', 'Scope', 'Status', 'What stands in the way', ''],
      empty: 'No release requested',
      emptyDetail: 'Delivery requests the release of a phase once its permission is recorded.',
      rows: reg.gates.releases.map((release) => [
        html`<b>${release.reference}</b> ${release.gate}<br><span class="metric-sub">${reg.consents.find((consent) => consent.id === release.consentId)?.reference ?? ''}</span>`,
        html`${release.phase} · ${humanise(release.operation).toLowerCase()}<br><span class="metric-sub">${release.description}${release.task ? ` · task ${release.task.name} (${release.task.percentComplete}%)` : ''}</span>`,
        html`${badge(release.status.toLowerCase(), RELEASE_TONE[release.status] ?? 'neutral')}${release.revoked ? html`<br><span class="metric-sub">${release.revoked.reasons.slice(0, 2).join(' ')}</span>` : ''}`,
        release.status === 'REQUESTED' ? blockerList(release.position.blockers) : '—',
        html`${canApprove && release.status === 'REQUESTED' ? html`<button class="btn quiet sm" data-command="pl-gate" data-gate="${release.gate}" data-release="${release.id}">Approve</button> ` : ''}${
          canUpdate && release.status === 'REQUESTED' ? html`<button class="btn quiet sm" data-command="pl-rel-withdraw" data-release="${release.id}">Withdraw</button>` : ''
        }`,
      ]),
    })}
  </section>`;
}

/** The command panels for everything above. */
export function consentCommands(reg, view, base) {
  if (reg.error) return {};
  const vocab = reg.vocabulary;
  const options = (values) => values.map((value) => ({ value, label: humanise(value) }));
  const conditionsOf = (consentId) => reg.consents.find((consent) => consent.id === consentId)?.conditions ?? [];
  const today = new Date().toISOString().slice(0, 10);
  return {
    'pl-gate': (button) => {
      const gate = button.dataset.gate;
      const position = button.dataset.release
        ? reg.gates.releases.find((entry) => entry.id === button.dataset.release)?.position
        : button.dataset.application
          ? reg.gates.applications.find((entry) => entry.applicationId === button.dataset.application)?.gates.find((entry) => entry.gate === gate)
          : reg.gates.project;
      const commercial = (position?.blockers ?? []).filter((blocker) => blocker.kind === 'COMMERCIAL');
      return {
        title: `Approve ${gate} — ${GATE_NAMES[gate]}`,
        intent: 'The platform re-checks every blocker as you approve. Only a commercial assumption can be accepted as a risk, with its rationale.',
        path: `${base}/gates/${gate}/reviews`,
        submitLabel: 'Approve',
        fields: [
          { name: 'rationale', label: 'Rationale', type: 'textarea', rows: 3 },
          ...(commercial.length
            ? [
                { name: 'accept', label: 'Accept as a commercial risk', type: 'multiselect', required: false, options: commercial.map((blocker) => ({ value: blocker.id, label: blocker.reason })) },
                { name: 'acceptRationale', label: 'Why the risk is accepted', type: 'text', required: false },
              ]
            : []),
        ],
        transform: (v) => ({
          rationale: v.rationale,
          ...(button.dataset.application ? { applicationId: button.dataset.application } : {}),
          ...(button.dataset.release ? { releaseId: button.dataset.release } : {}),
          ...(v.accept?.length ? { riskAcceptances: v.accept.map((blockerId) => ({ blockerId, rationale: v.acceptRationale ?? '' })) } : {}),
        }),
      };
    },
    'pl-app': () => ({
      title: 'Promote a proposal to an application',
      intent: 'The proposal version becomes a draft application with its requirements. The alternatives stay on record.',
      path: `${base}/applications`,
      submitLabel: 'Draft it',
      fields: [
        { name: 'proposalId', label: 'Proposal', type: 'select', options: view.scenarios.map((entry) => ({ value: entry.proposal.id, label: `${entry.proposal.scenarioName} v${entry.proposal.version} (${entry.proposal.route})` })) },
        { name: 'phases', label: 'Phases, comma-separated', type: 'text', required: false, placeholder: 'Phase 1, Phase 2', hint: 'Left blank, the whole site is one phase.' },
        { name: 'targetSubmissionOn', label: 'Target submission date', type: 'date', required: false },
        { name: 'landOptionExpiresOn', label: 'Land option expires', type: 'date', required: false },
        ...vocab.matters.map((matter) => ({ name: `matter_${matter}`, label: `Outline only — ${matter}`, type: 'select', required: false, options: [{ value: '', label: '—' }, { value: 'DETERMINED', label: 'Determined now' }, { value: 'RESERVED', label: 'Reserved' }] })),
      ],
      transform: (v) => {
        const proposal = view.scenarios.find((entry) => entry.proposal.id === v.proposalId)?.proposal;
        const matters = Object.fromEntries(vocab.matters.filter((matter) => v[`matter_${matter}`]).map((matter) => [matter, v[`matter_${matter}`]]));
        return {
          route: proposal?.route ?? 'full',
          proposalId: v.proposalId,
          phases: list(v.phases),
          ...(v.targetSubmissionOn ? { targetSubmissionOn: v.targetSubmissionOn } : {}),
          ...(v.landOptionExpiresOn ? { landOptionExpiresOn: v.landOptionExpiresOn } : {}),
          ...(proposal?.route === 'outline' ? { matters } : {}),
        };
      },
    }),
    'pl-app-linked': (button) => {
      const consent = reg.consents.find((entry) => entry.id === button.dataset.consent);
      const outstanding = consent.outstandingMatters ? [...new Set(Object.values(consent.outstandingMatters).flat())] : [];
      return {
        title: `Draft an application linked to ${consent.reference}`,
        intent: 'Reserved matters approve matters reserved under an outline; section 73 varies a condition and gives a new permission; section 96A makes a non-material amendment.',
        path: `${base}/applications`,
        submitLabel: 'Draft it',
        fields: [
          {
            name: 'route',
            label: 'Route',
            type: 'select',
            options: [
              ...(consent.type === 'OUTLINE' ? [{ value: 'reserved_matters', label: 'Reserved matters' }] : []),
              { value: 'section_73', label: 'Section 73 — vary or remove a condition' },
              { value: 'section_96a', label: 'Section 96A — non-material amendment' },
            ],
          },
          { name: 'phases', label: 'Phases', type: 'multiselect', options: consent.phases.map((phase) => ({ value: phase, label: phase })), value: consent.phases },
          ...(outstanding.length ? [{ name: 'reservedMatters', label: 'Reserved matters sought (outstanding ones)', type: 'multiselect', required: false, options: outstanding.map((matter) => ({ value: matter, label: matter })) }] : []),
          { name: 'targetSubmissionOn', label: 'Target submission date', type: 'date', required: false },
        ],
        transform: (v) => ({
          route: v.route,
          parentConsentId: consent.id,
          phases: v.phases,
          ...(v.route === 'reserved_matters' ? { reservedMatters: v.reservedMatters ?? [] } : {}),
          ...(v.targetSubmissionOn ? { targetSubmissionOn: v.targetSubmissionOn } : {}),
        }),
      };
    },
    'pl-event': (button, root) => {
      const application = reg.applications.find((entry) => entry.id === button.dataset.application);
      const type = root.querySelector(`[data-event-type="${CSS.escape(application.id)}"]`)?.value ?? 'consultation';
      const extra = EVENT_FIELDS[type] ?? [];
      const evidenceLabel = { determined: 'The issued decision notice', appeal_decided: 'The appeal decision', submitted: 'Receipt', validated: 'Validation letter' }[type] ?? 'Evidence';
      return {
        title: `${application.reference}: ${humanise(type).toLowerCase()}`,
        intent: 'A dated event, recorded once it has happened, with its evidence. The platform says whether it can follow the application’s current status.',
        path: `${base}/applications/${application.id}/events`,
        submitLabel: 'Record',
        fields: [
          { name: 'occurredOn', label: 'On', type: 'date', value: today },
          ...extra,
          ...(type === 'determined' || type === 'appeal_decided' ? [evidenceField(reg, 'approvedDrawings', 'Approved drawings (if granted)')] : []),
          evidenceField(reg, 'evidence', evidenceLabel),
        ],
        transform: (v) => {
          const payload = {};
          for (const field of extra) {
            if (v[field.name] === undefined || v[field.name] === '') continue;
            payload[field.name] = field.type === 'number' ? Number(v[field.name]) : v[field.name];
          }
          if (v.approvedDrawings?.length) payload.approvedDrawings = refs(v.approvedDrawings);
          return { type, occurredOn: v.occurredOn, evidence: refs(v.evidence), payload };
        },
      };
    },
    'pl-pack': (button) => {
      const application = reg.applications.find((entry) => entry.id === button.dataset.application);
      const evaluations = view.scenarios.map((entry) => entry.evaluation).filter((entry) => entry && entry.proposalId === application.proposalId);
      return {
        title: `Assemble the submission pack for ${application.reference}`,
        intent: 'The pack freezes the proposal, the rule evaluation, the rule versions, the fee quote and the documents, with a manifest hash. G2 approves it.',
        path: `${base}/packs`,
        submitLabel: 'Assemble',
        fields: [
          ...(application.proposalId ? [{ name: 'evaluationId', label: 'Evaluation', type: 'select', options: evaluations.map((entry) => ({ value: entry.id, label: `${entry.ruleVersion}, ${date(entry.evaluatedAt)}` })) }] : []),
          { name: 'feeQuoteId', label: 'Fee quote', type: 'select', options: view.quotes.map((quote) => ({ value: quote.id, label: `${humanise(quote.route)} made ${quote.madeOn}: ${quote.amountMinor === null ? 'review required' : money(quote.amountMinor)}` })) },
          evidenceField(reg, 'documents', 'Documents submitted', true),
        ],
        transform: (v) => ({ applicationId: application.id, ...(v.evaluationId ? { evaluationId: v.evaluationId } : {}), feeQuoteId: v.feeQuoteId, documents: refs(v.documents) }),
      };
    },
    'pl-req-generate': (button) => ({
      title: 'Refresh the requirements',
      intent: 'Adds what the application now needs from the national list, the gates and its latest rule findings. Nothing is removed.',
      path: `${base}/applications/${button.dataset.application}/requirements/generate`,
      submitLabel: 'Refresh',
      fields: [],
      report: (res) => ({ title: 'Refreshed', message: `${res.length} requirement(s) added.`, tone: 'ok' }),
    }),
    'pl-req-add': () => ({
      title: 'Add a requirement',
      intent: 'A local validation item, or a consent needed from another body (highways, Environment Agency, Natural England) before a phase starts.',
      path: `${base}/requirements`,
      submitLabel: 'Add',
      fields: [
        { name: 'applicationId', label: 'Application', type: 'select', options: reg.applications.map((entry) => ({ value: entry.id, label: entry.reference })) },
        { name: 'kind', label: 'Kind', type: 'select', options: [{ value: 'LOCAL', label: 'Local requirement' }, { value: 'EXTERNAL_CONSENT', label: 'External consent' }] },
        { name: 'title', label: 'Requirement', type: 'text' },
        { name: 'gate', label: 'Gate', type: 'select', options: ['G1', 'G2', 'G3', 'G4', 'G5'].map((gate) => ({ value: gate, label: `${gate} ${GATE_NAMES[gate]}` })), value: 'G2' },
        { name: 'phase', label: 'Phase (if one only)', type: 'text', required: false },
        { name: 'basis', label: 'Basis — the local list item, the body, the policy', type: 'text' },
        { name: 'submissionCritical', label: 'Submission-critical', type: 'checkbox', value: true },
      ],
    }),
    'pl-req-update': (button) => {
      const entry = reg.requirements.find((candidate) => candidate.id === button.dataset.requirement);
      return {
        title: `Update: ${entry.title}`,
        intent: 'Owner, due date, progress and evidence. New evidence on an accepted requirement sends it back to review.',
        path: `${base}/requirements/${entry.id}`,
        method: 'PATCH',
        ifMatch: entry.version,
        submitLabel: 'Save',
        fields: [
          { name: 'owner', label: 'Owner', type: 'text', required: false, value: entry.owner ?? '' },
          { name: 'dueOn', label: 'Due', type: 'date', required: false, value: entry.dueOn ?? '' },
          { name: 'delivery', label: 'Progress', type: 'select', required: false, options: options(['NOT_STARTED', 'COMMISSIONED', 'IN_PROGRESS', 'SUBMITTED_FOR_REVIEW']), value: ['ACCEPTED', 'NOT_APPLICABLE', 'RETURNED'].includes(entry.delivery) ? '' : entry.delivery, placeholder: 'Leave as it is' },
          { ...evidenceField(reg), value: entry.evidence.map((item) => `${item.refType}|${item.refId}`) },
        ],
        transform: (v) => ({ ...(v.owner ? { owner: v.owner } : {}), ...(v.dueOn ? { dueOn: v.dueOn } : {}), ...(v.delivery ? { delivery: v.delivery } : {}), evidence: refs(v.evidence) }),
      };
    },
    'pl-req-review': (button) => {
      const entry = reg.requirements.find((candidate) => candidate.id === button.dataset.requirement);
      return {
        title: `Review: ${entry.title}`,
        intent: 'Accept it on its evidence, return it with the reason, or record that it does not apply with the source that says so. You cannot accept evidence you attached.',
        path: `${base}/requirements/${entry.id}/reviews`,
        submitLabel: 'Record',
        brief: html`<p style="font-size:13px"><b>Evidence:</b> ${entry.evidence.map((item) => item.label).join('; ') || 'none linked'}</p>`,
        fields: [
          { name: 'decision', label: 'Decision', type: 'select', options: [{ value: 'ACCEPTED', label: 'Accept' }, { value: 'RETURNED', label: 'Return' }, { value: 'NOT_APPLICABLE', label: 'Not applicable' }] },
          { name: 'rationale', label: 'Rationale', type: 'textarea', rows: 2 },
          { name: 'source', label: 'Source (for not applicable)', type: 'text', required: false },
        ],
      };
    },
    'pl-cond-add': (button) => {
      const consent = reg.consents.find((entry) => entry.id === button.dataset.consent);
      return {
        title: `Add a condition to ${consent.reference}`,
        intent: 'Exactly as the notice words it, with what it requires, when it bites and which phases. A second person verifies the wording.',
        path: `${base}/consents/${consent.id}/conditions`,
        submitLabel: 'Add',
        fields: [
          { name: 'number', label: 'Number on the notice', type: 'text' },
          { name: 'wording', label: 'Wording, verbatim', type: 'textarea', rows: 4 },
          { name: 'interpretation', label: 'What it requires', type: 'textarea', rows: 2 },
          { name: 'trigger', label: 'Trigger', type: 'select', options: options(vocab.triggers) },
          { name: 'triggerText', label: 'Bespoke trigger, quoted', type: 'text', required: false },
          { name: 'phases', label: 'Phases (none ticked: all)', type: 'multiselect', required: false, options: consent.phases.map((phase) => ({ value: phase, label: phase })) },
        ],
        transform: (v) => ({ ...v, phases: v.phases ?? [], ...(v.triggerText ? {} : { triggerText: undefined }) }),
      };
    },
    'pl-cond-verify': (button) => ({
      title: `Verify condition ${button.dataset.number}`,
      intent: 'Confirm the wording matches the issued notice word for word. The person who entered it cannot verify it.',
      path: `${base}/conditions/${button.dataset.condition}/verify`,
      submitLabel: 'Verified against the notice',
      fields: [],
    }),
    'pl-cond-complete': (button) => ({
      title: 'Confirm every condition is entered',
      intent: 'Count the conditions on the notice. The platform checks the count against what is entered.',
      path: `${base}/consents/${button.dataset.consent}/conditions-complete`,
      submitLabel: 'Confirm',
      fields: [{ name: 'count', label: 'Conditions on the notice', type: 'number', min: 0, step: '1', value: button.dataset.count }],
      transform: (v) => ({ count: Number(v.count) }),
    }),
    'pl-consent-status': (button) => ({
      title: 'Mark the permission lapsed or superseded',
      intent: 'It stops being effective and stays on the record. Any release that rests on it is revoked.',
      path: `${base}/consents/${button.dataset.consent}/status`,
      submitLabel: 'Record',
      fields: [
        { name: 'status', label: 'Status', type: 'select', options: [{ value: 'SUPERSEDED', label: 'Superseded' }, { value: 'LAPSED', label: 'Lapsed' }] },
        { name: 'reason', label: 'Why', type: 'text' },
      ],
    }),
    'pl-cond-request': () => {
      const consent = reg.consents.find((entry) => entry.status === 'EFFECTIVE') ?? reg.consents[0];
      const open = reg.consents.flatMap((entry) => entry.conditions.filter((condition) => ['OUTSTANDING', 'REFUSED'].includes(condition.status)).map((condition) => ({ consent: entry, condition })));
      return {
        title: 'Record a discharge request',
        intent: 'One request may cover several conditions of one permission; the authority answers each. Nothing is discharged by submission or silence.',
        path: `${base}/condition-requests`,
        submitLabel: 'Record',
        fields: [
          { name: 'consentId', label: 'Permission', type: 'select', options: reg.consents.map((entry) => ({ value: entry.id, label: entry.reference })), value: consent?.id },
          { name: 'conditionIds', label: 'Conditions', type: 'multiselect', options: open.map(({ consent: owner, condition }) => ({ value: condition.id, label: `${owner.reference} condition ${condition.number}: ${condition.interpretation}` })) },
          { name: 'madeOn', label: 'Made on', type: 'date', value: today },
          { name: 'phase', label: 'Phase (if one only)', type: 'text', required: false },
          { name: 'externalRef', label: 'Authority reference', type: 'text', required: false },
          { name: 'feeQuoteId', label: 'Fee quote', type: 'select', required: false, placeholder: 'No fee, or not yet quoted', options: view.quotes.filter((quote) => quote.route === 'condition_details').map((quote) => ({ value: quote.id, label: `made ${quote.madeOn}: ${quote.amountMinor === null ? 'review required' : money(quote.amountMinor)}` })) },
          evidenceField(reg, 'evidence', 'Details submitted', true),
        ],
        transform: (v) => ({ ...v, evidence: refs(v.evidence), ...(v.feeQuoteId ? {} : { feeQuoteId: undefined }) }),
      };
    },
    'pl-cond-response': (button) => {
      const request = reg.conditionRequests.find((entry) => entry.id === button.dataset.request);
      const conditions = conditionsOf(request.consentId).filter((condition) => request.conditionIds.includes(condition.id) && !request.outcomes[condition.id]);
      return {
        title: `The authority’s answer to ${request.reference}`,
        intent: 'Record each condition approved or refused. Only an approval discharges a condition.',
        path: `${base}/condition-requests/${request.id}`,
        method: 'PATCH',
        submitLabel: 'Record',
        fields: [
          { name: 'on', label: 'Decision date', type: 'date', value: today },
          { name: 'approved', label: 'Approved', type: 'multiselect', required: false, options: conditions.map((condition) => ({ value: condition.id, label: `Condition ${condition.number}` })) },
          { name: 'refused', label: 'Refused', type: 'multiselect', required: false, options: conditions.map((condition) => ({ value: condition.id, label: `Condition ${condition.number}` })) },
          { name: 'note', label: 'What the authority said', type: 'text' },
          evidenceField(reg, 'evidence', 'The decision', true),
        ],
        validate: (v) => ((v.approved ?? []).some((id) => (v.refused ?? []).includes(id)) ? { field: 'refused', message: 'A condition is approved or refused, not both.' } : undefined),
        transform: (v) => ({
          on: v.on,
          evidence: refs(v.evidence),
          outcomes: [
            ...(v.approved ?? []).map((conditionId) => ({ conditionId, outcome: 'APPROVED', note: v.note })),
            ...(v.refused ?? []).map((conditionId) => ({ conditionId, outcome: 'REFUSED', note: v.note })),
          ],
        }),
      };
    },
    'pl-obl-add': () => ({
      title: 'Register an obligation',
      intent: 'From the agreement or notice: instrument, clause, what is owed, the trigger and the phases. Heads of terms are registered as estimated until executed.',
      path: `${base}/obligations`,
      submitLabel: 'Register',
      fields: [
        { name: 'applicationId', label: 'Application', type: 'select', required: false, placeholder: 'Not tied to one application', options: reg.applications.map((entry) => ({ value: entry.id, label: entry.reference })) },
        { name: 'instrument', label: 'Instrument', type: 'select', options: options(vocab.instruments) },
        { name: 'instrumentRef', label: 'Agreement or notice reference', type: 'text' },
        { name: 'clause', label: 'Clause or schedule', type: 'text' },
        { name: 'kind', label: 'Kind', type: 'select', options: options(['FINANCIAL', 'DELIVERABLE', 'NOTICE']) },
        { name: 'description', label: 'What is owed or delivered', type: 'text' },
        { name: 'amountMinor', label: 'Amount (£), if financial', type: 'number', money: true, min: 0, required: false },
        { name: 'indexation', label: 'Indexation', type: 'text', required: false },
        { name: 'cap', label: 'Cap', type: 'text', required: false },
        { name: 'phases', label: 'Phases, comma-separated (blank: all)', type: 'text', required: false },
        { name: 'triggerEvent', label: 'Trigger', type: 'select', options: options(vocab.obligationTriggers) },
        { name: 'triggerCount', label: 'Homes occupied (occupation count)', type: 'number', min: 1, step: '1', required: false },
        { name: 'triggerOn', label: 'Date (date trigger)', type: 'date', required: false },
        { name: 'triggerText', label: 'Trigger as worded (other)', type: 'text', required: false },
        { name: 'owner', label: 'Accountable owner', type: 'text' },
        evidenceField(reg),
      ],
      transform: (v) => ({
        ...(v.applicationId ? { applicationId: v.applicationId } : {}),
        instrument: v.instrument,
        instrumentRef: v.instrumentRef,
        clause: v.clause,
        kind: v.kind,
        description: v.description,
        ...(v.kind === 'FINANCIAL' ? { amountMinor: v.amountMinor ?? null } : {}),
        ...(v.indexation ? { indexation: v.indexation } : {}),
        ...(v.cap ? { cap: v.cap } : {}),
        phases: list(v.phases),
        triggers: [{ event: v.triggerEvent, ...(v.triggerCount ? { count: Number(v.triggerCount) } : {}), ...(v.triggerOn ? { on: v.triggerOn } : {}), ...(v.triggerText ? { text: v.triggerText } : {}) }],
        owner: v.owner,
        evidence: refs(v.evidence),
      }),
    }),
    'pl-obl-progress': (button) => {
      const obligation = reg.obligations.find((entry) => entry.id === button.dataset.obligation);
      return {
        title: `${obligation.reference}: record progress`,
        intent: 'Executed when the agreement is signed, satisfied when the payment, the works or the notice is done — each on its evidence.',
        path: `${base}/obligations/${obligation.id}`,
        method: 'PATCH',
        submitLabel: 'Record',
        fields: [
          { name: 'to', label: 'Now', type: 'select', options: [{ value: 'EXECUTED', label: 'Executed' }, { value: 'ACKNOWLEDGED', label: 'Acknowledged by the authority' }, { value: 'SATISFIED', label: 'Satisfied' }] },
          { name: 'on', label: 'On', type: 'date', value: today },
          { name: 'note', label: 'Note', type: 'text', required: false },
          evidenceField(reg, 'evidence', 'Evidence', true),
        ],
        transform: (v) => ({ ...v, evidence: refs(v.evidence) }),
      };
    },
    'pl-rel-request': () => {
      const effective = reg.consents.filter((consent) => consent.status === 'EFFECTIVE');
      return {
        title: 'Request a release',
        intent: 'Works (G4) for one phase — commencement, or above-ground works after it — or occupation (G5). An approver releases it when nothing blocks it.',
        path: `${base}/releases`,
        submitLabel: 'Request',
        fields: [
          { name: 'consentId', label: 'Permission', type: 'select', options: effective.map((consent) => ({ value: consent.id, label: `${consent.reference} (${humanise(consent.type).toLowerCase()}) — ${consent.phases.join(', ')}` })) },
          { name: 'phase', label: 'Phase', type: 'select', options: [...new Set(effective.flatMap((consent) => consent.phases))].map((phase) => ({ value: phase, label: phase })) },
          { name: 'operation', label: 'Operation', type: 'select', options: [{ value: 'COMMENCEMENT', label: 'Commencement (G4)' }, { value: 'ABOVE_GROUND', label: 'Above-ground works (G4)' }, { value: 'OCCUPATION', label: 'Occupation (G5)' }] },
          { name: 'description', label: 'What is being released', type: 'text', placeholder: 'Groundworks, plots 1–20' },
          { name: 'programmeTaskId', label: 'Programme task id (optional)', type: 'text', required: false, hint: 'Works recorded on this task without a live release are flagged.' },
        ],
        transform: (v) => ({ ...v, gate: v.operation === 'OCCUPATION' ? 'G5' : 'G4', ...(v.programmeTaskId ? {} : { programmeTaskId: undefined }) }),
      };
    },
    'pl-study-generate': (button) => ({
      title: 'Plan the studies',
      intent: 'Adds the specification’s study templates: required where a rule finding applies, otherwise for a planner to decide.',
      path: `${base}/applications/${button.dataset.application}/studies/generate`,
      submitLabel: 'Plan them',
      fields: [],
      report: (res) => ({ title: 'Planned', message: `${res.length} stud${res.length === 1 ? 'y' : 'ies'} added.`, tone: 'ok' }),
    }),
    'pl-study-update': (button) => {
      const study = reg.studies.find((entry) => entry.id === button.dataset.study);
      const siblings = reg.studies.filter((entry) => entry.applicationId === study.applicationId && entry.id !== study.id);
      return {
        title: `Update: ${study.title}`,
        intent: 'Applicability is a planner’s decision with its reason. The survey window is the consultant’s, as month-days.',
        path: `${base}/studies/${study.id}`,
        method: 'PATCH',
        submitLabel: 'Save',
        fields: [
          { name: 'applicability', label: 'Applies', type: 'select', required: false, placeholder: 'Leave as it is', options: [{ value: 'REQUIRED', label: 'Required' }, { value: 'NOT_REQUIRED', label: 'Not required' }] },
          { name: 'applicabilityNote', label: 'Why', type: 'text', required: false },
          { name: 'status', label: 'Status', type: 'select', options: options(['CANDIDATE', 'COMMISSIONED', 'IN_PROGRESS', 'COMPLETE']), value: study.status },
          { name: 'consultant', label: 'Consultant', type: 'text', required: false, value: study.consultant ?? '' },
          { name: 'commissionBy', label: 'Commission by', type: 'date', required: false, value: study.commissionBy ?? '' },
          { name: 'durationWeeks', label: 'Duration (weeks)', type: 'number', min: 1, step: '1', required: false, value: study.durationWeeks ?? '' },
          { name: 'windowFrom', label: 'Survey window from (MM-DD)', type: 'text', required: false, value: study.surveyWindow?.from ?? '', placeholder: '04-15' },
          { name: 'windowTo', label: 'Survey window to (MM-DD)', type: 'text', required: false, value: study.surveyWindow?.to ?? '', placeholder: '09-30' },
          { name: 'dependsOn', label: 'Depends on', type: 'multiselect', required: false, options: siblings.map((entry) => ({ value: entry.id, label: entry.title })), value: study.dependsOn },
          { name: 'validUntil', label: 'Findings valid until', type: 'date', required: false, value: study.validUntil ?? '' },
        ],
        transform: (v) => ({
          ...(v.applicability ? { applicability: v.applicability, applicabilityNote: v.applicabilityNote ?? '' } : {}),
          status: v.status,
          ...(v.consultant ? { consultant: v.consultant } : {}),
          ...(v.commissionBy ? { commissionBy: v.commissionBy } : {}),
          ...(v.durationWeeks ? { durationWeeks: Number(v.durationWeeks) } : {}),
          ...(v.windowFrom && v.windowTo ? { surveyWindow: { from: v.windowFrom, to: v.windowTo } } : {}),
          dependsOn: v.dependsOn ?? [],
          ...(v.validUntil ? { validUntil: v.validUntil } : {}),
        }),
      };
    },
    'pl-rel-withdraw': (button) => ({
      title: 'Withdraw the release request',
      intent: 'The request stays on the record as withdrawn.',
      path: `${base}/releases/${button.dataset.release}/withdraw`,
      submitLabel: 'Withdraw',
      fields: [{ name: 'reason', label: 'Why', type: 'text' }],
    }),
  };
}

/** Requirement filters and the two reads that open in place: a pack's manifest and a rule version's differences. */
export function bindConsentExtras(root, base, redraw) {
  root.addEventListener('change', (event) => {
    const select = event.target.closest('[data-req-filter]');
    if (!select) return;
    filters[select.dataset.reqFilter] = select.value;
    redraw();
  });
  root.addEventListener('click', async (event) => {
    const manifest = event.target.closest('[data-pack-manifest]');
    if (manifest) {
      try {
        const pack = await api.get(`/v1/projects/${projectIdOf(base)}/planning/packs/${manifest.dataset.packManifest}`);
        const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `planning-pack-${shortHash(pack.manifestHash)}.json`;
        link.click();
        URL.revokeObjectURL(link.href);
        toast('Manifest exported', `${pack.items.length} items, manifest ${shortHash(pack.manifestHash)}${pack.stale.length ? ' — note: it no longer matches the project' : ''}.`, pack.stale.length ? 'warn' : 'ok');
      } catch (error) {
        toast('Not exported', error.message ?? String(error), 'err');
      }
      return;
    }
    const detail = event.target.closest('[data-rule-detail]');
    if (!detail) return;
    const host = root.querySelector(`[data-rule-detail-for="${CSS.escape(detail.dataset.ruleDetail)}"]`);
    if (!host) return;
    try {
      const rule = await api.get(`/v1/projects/${projectIdOf(base)}/planning/rule-versions/${detail.dataset.ruleDetail}`);
      const fmt = (value) => (value === null || value === undefined ? '—' : String(value));
      render(
        host,
        html`<div style="font-size:12.5px;margin-top:6px">
          <p class="metric-sub">Impact in this company: ${rule.impact.projects} project(s); ${rule.impact.payableQuotes} payable and ${rule.impact.unpayableQuotes} unpayable quote(s) on it; ${rule.impact.staleEvaluations} evaluation(s) pinned to older content; ${rule.impact.openPacks} open pack(s).</p>
          ${rule.changedSinceChecked.length ? notice(html`Changed since it was checked: ${rule.changedSinceChecked.map((entry) => `${entry.path} ${fmt(entry.from)} → ${fmt(entry.to)}`).join('; ')}`, 'warn') : ''}
          ${
            rule.comparedWith
              ? html`<p style="margin:6px 0 2px"><b>Differences from ${rule.comparedWith}</b></p>${table({
                  headers: ['Item', rule.comparedWith, rule.version],
                  rows: rule.differences.map((entry) => [entry.path, fmt(entry.from), fmt(entry.to)]),
                  empty: 'No differences',
                })}`
              : html`<p class="metric-sub">No earlier version to compare with.</p>`
          }
        </div>`,
      );
    } catch (error) {
      render(host, notice(`Could not be read: ${error.message ?? String(error)}`, 'err'));
    }
  });
}
