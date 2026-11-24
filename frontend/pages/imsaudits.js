import { badge, html, humanise, table } from '../lib/ui.js';
import { clauseLabel, clauseOptions, nameOf, personOptions, plural, standardLabel, standardOptions } from './imscommon.js';

/**
 * Internal audit and corrective action on the Management System screen: the
 * audit programme with its findings and clause coverage, and every corrective
 * and improvement action from raised to verified closed.
 */

const AUDIT_TONE = { PLANNED: 'info', IN_PROGRESS: 'warn', COMPLETED: 'ok', CANCELLED: 'neutral' };
const GRADE_TONE = { MAJOR_NC: 'bad', MINOR_NC: 'warn', OBSERVATION: 'info', OPPORTUNITY: 'neutral' };
const GRADE_WORDS = { MAJOR_NC: 'major nonconformity', MINOR_NC: 'minor nonconformity', OBSERVATION: 'observation', OPPORTUNITY: 'opportunity for improvement' };
const ACTION_TONE = { OPEN: 'warn', IMPLEMENTED: 'info', CLOSED: 'ok' };

function programmeCard(view, perms) {
  const { audits, coverage } = view.programme;
  const uncovered = coverage.filter((entry) => entry.uncovered);
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="ims-aud-h" data-ims-audits>
    <h2 id="ims-aud-h">Audit programme ${perms.create ? html`<button class="btn quiet sm" data-command="ims-audit-plan">Plan an audit</button>` : ''}</h2>
    <p class="metric-sub">Each audit is against clauses, procedures and projects, led by somebody independent of the work audited. Only the lead auditor records findings; a nonconformity raises its corrective action as it is recorded.</p>
    ${table({
      headers: ['Audit', 'Planned', 'Lead auditor', 'Status', 'Findings', ''],
      empty: 'No audit planned',
      emptyDetail: perms.create ? 'Plan the year’s audits so every clause in use is covered.' : 'The quality lead plans the audit programme.',
      rows: audits.map((audit) => {
        const lead = audit.leadAuditorId === view.me;
        return [
          html`<b>${audit.reference}</b> ${audit.title}<br><span class="metric-sub">${audit.standards.map((id) => standardLabel(view, id)).join(', ')} · ${plural(audit.clauses.length, 'clause', 'clauses')}${audit.projects.length ? ' · ' + audit.projects.join(', ') : ''}</span>${
            audit.checklist.length
              ? html`<details><summary style="cursor:pointer;font-size:12px">Checklist (${audit.checklist.length})</summary><ol style="margin:4px 0 0 18px;font-size:12px">${audit.checklist.map(
                  (item) => html`<li>${item.question}${item.clauseId ? html` <span class="metric-sub">${clauseLabel(view, item.clauseId)}</span>` : ''}</li>`,
                )}</ol></details>`
              : ''
          }`,
          html`${audit.plannedOn}${audit.overdue ? html`<br>${badge('overdue', 'bad')}` : ''}`,
          audit.leadAuditor,
          html`${badge(humanise(audit.status).toLowerCase(), AUDIT_TONE[audit.status] ?? 'neutral')}${
            audit.completed ? html`<br><span class="metric-sub">${audit.completed.on}: ${audit.completed.conclusion}</span>` : ''
          }${audit.cancelled ? html`<br><span class="metric-sub">${audit.cancelled.reason}</span>` : ''}`,
          audit.findings.length
            ? html`<details><summary style="cursor:pointer;font-size:12.5px">${plural(audit.findings.length, 'finding', 'findings')}</summary><ul style="margin:4px 0 0 16px;font-size:12px">${audit.findings.map(
                (finding) =>
                  html`<li>${badge(GRADE_WORDS[finding.grade], GRADE_TONE[finding.grade])} <b>${finding.reference}</b> ${clauseLabel(view, finding.clauseId)}: ${finding.statement}<br><span class="metric-sub">Seen: ${finding.evidence}${
                    finding.action ? ` · ${finding.action.reference} ${finding.action.status.toLowerCase()}` : ''
                  }</span></li>`,
              )}</ul></details>`
            : '—',
          html`${lead && perms.update && audit.status !== 'COMPLETED' && audit.status !== 'CANCELLED' ? html`<button class="btn quiet sm" data-command="ims-audit-checklist" data-audit="${audit.id}">Checklist</button> ` : ''}${
            lead && perms.update && audit.status === 'PLANNED' ? html`<button class="btn sm" data-command="ims-audit-start" data-audit="${audit.id}">Start</button> ` : ''
          }${lead && perms.update && audit.status === 'IN_PROGRESS' ? html`<button class="btn sm" data-command="ims-audit-finding" data-audit="${audit.id}">Record a finding</button> <button class="btn quiet sm" data-command="ims-audit-complete" data-audit="${audit.id}">Complete</button> ` : ''}${
            perms.approve && (audit.status === 'PLANNED' || audit.status === 'IN_PROGRESS') && audit.findings.length === 0 ? html`<button class="btn quiet sm" data-command="ims-audit-cancel" data-audit="${audit.id}">Cancel</button>` : ''
          }`,
        ];
      }),
    })}
    <h3 style="margin-top:12px">Clause coverage ${uncovered.length ? badge(plural(uncovered.length, 'clause', 'clauses') + ' not covered', 'warn') : coverage.length ? badge('every clause covered', 'ok') : ''}</h3>
    <p class="metric-sub">A clause of a standard in use that was not audited in the last twelve months and is not planned is not covered.</p>
    ${
      coverage.length
        ? html`<details><summary style="cursor:pointer;font-size:12.5px">Clause by clause</summary>${table({
            headers: ['Clause', 'Last audited', 'Next planned', ''],
            rows: coverage.map((entry) => [clauseLabel(view, entry.clauseId), entry.lastAuditedOn ?? '—', entry.nextPlannedOn ?? '—', entry.uncovered ? badge('not covered', 'warn') : badge('covered', 'ok')]),
          })}</details>`
        : html`<p class="metric-sub">No standard is in use yet: draft a document or plan an audit first.</p>`
    }
  </section>`;
}

function actionsCard(view, perms) {
  const open = view.actions.filter((action) => action.status !== 'CLOSED');
  const closed = view.actions.filter((action) => action.status === 'CLOSED');
  const rows = (list) =>
    list.map((action) => [
      html`<b>${action.reference}</b> ${badge(action.kind.toLowerCase(), action.kind === 'CORRECTIVE' ? 'warn' : 'info')}<br><span style="font-size:12.5px">${action.description}</span><br><span class="metric-sub">From ${humanise(action.source.kind).toLowerCase()}: ${action.source.label}</span>`,
      action.owner,
      html`${action.dueOn}${action.overdue ? html`<br>${badge('overdue', 'bad')}` : ''}`,
      html`${badge(action.status.toLowerCase(), ACTION_TONE[action.status] ?? 'neutral')}${
        action.verification && !action.verification.effective && action.status === 'OPEN' ? html`<br><span class="metric-sub">Not effective: ${action.verification.note}</span>` : ''
      }`,
      action.rootCause || action.correction || action.plannedActions
        ? html`<details><summary style="cursor:pointer;font-size:12px">Investigation</summary><div style="font-size:12px">${action.correction ? html`<p style="margin:4px 0"><b>Correction:</b> ${action.correction}</p>` : ''}${
            action.rootCause ? html`<p style="margin:4px 0"><b>Root cause:</b> ${action.rootCause}</p>` : ''
          }${action.plannedActions ? html`<p style="margin:4px 0"><b>Actions:</b> ${action.plannedActions}</p>` : ''}${action.implemented ? html`<p style="margin:4px 0"><b>Done:</b> ${action.implemented.note}</p>` : ''}</div></details>`
        : html`<span class="metric-sub">not investigated</span>`,
      html`${perms.update && action.status === 'OPEN' ? html`<button class="btn quiet sm" data-command="ims-action-investigate" data-action="${action.id}">Investigate</button> <button class="btn quiet sm" data-command="ims-action-implement" data-action="${action.id}">Done</button>` : ''}${
        perms.update && action.status === 'IMPLEMENTED' && action.implemented?.by !== view.me ? html`<button class="btn sm" data-command="ims-action-verify" data-action="${action.id}">Verify</button>` : ''
      }${action.status === 'IMPLEMENTED' && action.implemented?.by === view.me ? html`<span class="metric-sub">awaiting somebody else to verify</span>` : ''}`,
    ]);
  const headers = ['Action', 'Owner', 'Due', 'Status', 'Investigation', ''];
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="ims-act-h" data-ims-actions>
    <h2 id="ims-act-h">Corrective and improvement actions ${perms.create ? html`<button class="btn quiet sm" data-command="ims-action-raise">Raise an action</button>` : ''}</h2>
    <p class="metric-sub">From audit findings, incidents and NCRs on any project, management review, compliance evaluation, suppliers or complaints. A corrective action is implemented on its root cause and verified effective by somebody other than the person who did it.</p>
    ${table({ headers, empty: 'No open action', emptyDetail: 'Actions appear here as findings, incidents and reviews raise them.', rows: rows(open) })}
    ${closed.length ? html`<details style="margin-top:10px"><summary style="cursor:pointer;font-size:12.5px">${plural(closed.length, 'action', 'actions')} verified and closed</summary>${table({ headers, rows: rows(closed) })}</details>` : ''}
  </section>`;
}

export function auditCards(view, perms, which) {
  return which === 'audits' ? programmeCard(view, perms) : actionsCard(view, perms);
}

export function auditCommands(view) {
  const auditOf = (button) => view.programme.audits.find((audit) => audit.id === button.dataset.audit);
  const actionOf = (button) => view.actions.find((action) => action.id === button.dataset.action);
  const today = new Date().toISOString().slice(0, 10);
  const documentOptions = view.documents.filter((document) => document.status !== 'WITHDRAWN').map((document) => ({ value: document.id, label: `${document.reference} ${document.title}` }));
  const sourceOptions = [
    ...view.sources.incidents.map((entry) => ({ value: `INCIDENT|Incident|${entry.refId}`, label: `Incident ${entry.reference} — ${entry.project}, ${humanise(entry.category).toLowerCase()}, ${entry.occurredAt}` })),
    ...view.sources.ncrs.map((entry) => ({ value: `NCR|NCR|${entry.refId}`, label: `NCR ${entry.reference} — ${entry.project}, ${entry.severity.toLowerCase()}, ${entry.status.toLowerCase()}` })),
    ...view.sources.suppliers.map((entry) => ({ value: `SUPPLIER|Supplier|${entry.refId}`, label: `Supplier ${entry.reference}` })),
  ];
  return {
    'ims-audit-plan': () => ({
      title: 'Plan an audit',
      intent: 'Against the clauses and procedures it samples, on the projects it visits. The lead auditor must not own, have drafted or approved anything audited, and records the findings.',
      path: '/v1/ims/audits',
      submitLabel: 'Plan it',
      fields: [
        { name: 'title', label: 'What it covers', type: 'text', placeholder: 'Document control and competence on site' },
        { name: 'standards', label: 'Standards', type: 'multiselect', options: standardOptions(view) },
        { name: 'clauses', label: 'Clauses', type: 'multiselect', options: clauseOptions(view) },
        { name: 'documentIds', label: 'Procedures sampled (optional)', type: 'multiselect', required: false, options: documentOptions },
        { name: 'projectIds', label: 'Projects visited (optional)', type: 'multiselect', required: false, options: view.programme.projects.map((project) => ({ value: project.id, label: project.name })) },
        { name: 'plannedOn', label: 'Planned for', type: 'date', value: today },
        { name: 'leadAuditorId', label: 'Lead auditor', type: 'select', options: personOptions(view) },
      ],
      transform: (v) => ({ ...v, documentIds: v.documentIds ?? [], projectIds: v.projectIds ?? [] }),
    }),
    'ims-audit-checklist': (button) => {
      const audit = auditOf(button);
      return {
        title: `${audit.reference} checklist`,
        intent: 'One question or record to see per line. Each line is tied to the first clause in scope it names, if any; replaces the checklist.',
        path: `/v1/ims/audits/${audit.id}/checklist`,
        method: 'PUT',
        submitLabel: 'Save the checklist',
        fields: [{ name: 'lines', label: 'Questions, one per line (start a line with a clause number, e.g. “7.5 …”, to tie it)', type: 'textarea', rows: 10, value: audit.checklist.map((item) => (item.clauseId ? item.clauseId.split(':')[1] + ' ' : '') + item.question).join('\n') }],
        transform: (v) => ({
          items: String(v.lines ?? '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              const match = line.match(/^(\d+(?:\.\d+)*)\s+(.*)$/);
              const clauseId = match ? audit.clauses.find((id) => id.split(':')[1] === match[1]) : undefined;
              return { question: clauseId ? match[2] : line, ...(clauseId ? { clauseId } : {}) };
            }),
        }),
      };
    },
    'ims-audit-start': (button) => ({
      title: `Start ${auditOf(button).reference}`,
      intent: 'Findings can be recorded once it is started.',
      path: `/v1/ims/audits/${button.dataset.audit}/start`,
      submitLabel: 'Start',
      fields: [],
    }),
    'ims-audit-finding': (button) => {
      const audit = auditOf(button);
      return {
        title: `${audit.reference}: record a finding`,
        intent: 'Against a clause, with what was seen. A major or minor nonconformity raises its corrective action now, so name its owner and due date.',
        path: `/v1/ims/audits/${audit.id}/findings`,
        submitLabel: 'Record',
        fields: [
          { name: 'grade', label: 'Grade', type: 'select', options: view.vocabulary.findingGrades.map((grade) => ({ value: grade, label: GRADE_WORDS[grade] })) },
          { name: 'clauseId', label: 'Clause', type: 'select', options: audit.clauses.map((id) => ({ value: id, label: clauseLabel(view, id) })) },
          { name: 'documentId', label: 'Procedure (optional)', type: 'select', required: false, placeholder: 'None', options: documentOptions.filter((option) => audit.documentIds.includes(option.value)) },
          { name: 'projectId', label: 'Project (optional)', type: 'select', required: false, placeholder: 'None', options: view.programme.projects.filter((project) => audit.projectIds.includes(project.id)).map((project) => ({ value: project.id, label: project.name })) },
          { name: 'statement', label: 'The finding', type: 'textarea', rows: 3 },
          { name: 'evidence', label: 'What was seen', type: 'textarea', rows: 2 },
          { name: 'actionOwnerId', label: 'Corrective action owner (for a nonconformity)', type: 'select', required: false, placeholder: 'Not a nonconformity', options: personOptions(view) },
          { name: 'actionDueOn', label: 'Corrective action due (for a nonconformity)', type: 'date', required: false },
        ],
      };
    },
    'ims-audit-complete': (button) => ({
      title: `Complete ${auditOf(button).reference}`,
      intent: 'Findings cannot be added once it is complete.',
      path: `/v1/ims/audits/${button.dataset.audit}/complete`,
      submitLabel: 'Complete',
      fields: [
        { name: 'summary', label: 'Summary — what was audited and seen', type: 'textarea', rows: 4 },
        { name: 'conclusion', label: 'Conclusion', type: 'text', placeholder: 'Conforming and effectively implemented, with one minor nonconformity' },
      ],
    }),
    'ims-audit-cancel': (button) => ({
      title: `Cancel ${auditOf(button).reference}`,
      intent: 'It stays on the programme, cancelled, with your reason.',
      path: `/v1/ims/audits/${button.dataset.audit}/cancel`,
      submitLabel: 'Cancel the audit',
      fields: [{ name: 'reason', label: 'Why, and when it is re-planned', type: 'text' }],
    }),
    'ims-action-raise': () => ({
      title: 'Raise an action',
      intent: 'Name where it came from: an incident, NCR or supplier on the record, or describe a complaint or anything else.',
      path: '/v1/ims/actions',
      submitLabel: 'Raise it',
      fields: [
        { name: 'kind', label: 'Kind', type: 'select', options: [{ value: 'CORRECTIVE', label: 'Corrective — something went wrong' }, { value: 'IMPROVEMENT', label: 'Improvement — it could go better' }] },
        { name: 'record', label: 'From a record', type: 'select', required: false, placeholder: 'Not from a record (complaint or other)', options: sourceOptions },
        { name: 'sourceLabel', label: 'Or describe where it came from', type: 'text', required: false, placeholder: 'Client complaint about the site entrance, 12 Nov' },
        { name: 'standards', label: 'Standards', type: 'multiselect', options: standardOptions(view) },
        { name: 'description', label: 'The problem or opportunity, as found', type: 'textarea', rows: 3 },
        { name: 'correction', label: 'Immediate correction (optional)', type: 'text', required: false },
        { name: 'ownerId', label: 'Owner', type: 'select', options: personOptions(view) },
        { name: 'dueOn', label: 'Due', type: 'date' },
      ],
      transform: (v) => {
        const { record, sourceLabel, ...rest } = v;
        const [kind, refType, refId] = record ? record.split('|') : [];
        return {
          ...rest,
          source: record ? { kind, refType, refId } : { kind: /complain/i.test(sourceLabel ?? '') ? 'COMPLAINT' : 'OTHER', label: sourceLabel ?? '' },
        };
      },
    }),
    'ims-action-investigate': (button) => {
      const action = actionOf(button);
      return {
        title: `${action.reference}: investigation`,
        intent: 'The correction made, why it happened, and what will be done about the cause.',
        path: `/v1/ims/actions/${action.id}`,
        method: 'PATCH',
        submitLabel: 'Save',
        fields: [
          { name: 'correction', label: 'Correction', type: 'text', required: false, value: action.correction ?? '' },
          { name: 'rootCause', label: 'Root cause', type: 'textarea', rows: 3, required: false, value: action.rootCause ?? '' },
          { name: 'plannedActions', label: 'Actions on the cause', type: 'textarea', rows: 3, required: false, value: action.plannedActions ?? '' },
          { name: 'ownerId', label: 'Owner', type: 'select', options: personOptions(view), value: action.ownerId },
          { name: 'dueOn', label: 'Due', type: 'date', value: action.dueOn },
        ],
      };
    },
    'ims-action-implement': (button) => {
      const action = actionOf(button);
      return {
        title: `${action.reference}: done`,
        intent: action.kind === 'CORRECTIVE' ? 'A corrective action needs its root cause and actions recorded first. Somebody else then verifies it worked.' : 'Somebody else then verifies it worked.',
        path: `/v1/ims/actions/${action.id}/implement`,
        submitLabel: 'Record',
        fields: [
          { name: 'note', label: 'What was done', type: 'textarea', rows: 3 },
          { name: 'evidenceHash', label: 'Evidence (optional)', type: 'file', required: false, voice: false },
        ],
      };
    },
    'ims-action-verify': (button) => {
      const action = actionOf(button);
      return {
        title: `${action.reference}: verify effectiveness`,
        intent: `${nameOf(view, action.implemented?.by)} recorded: “${action.implemented?.note ?? ''}”. Effective closes it; not effective reopens it.`,
        path: `/v1/ims/actions/${action.id}/verify`,
        submitLabel: 'Record the verification',
        fields: [
          { name: 'effective', label: 'It was effective — the problem has not recurred', type: 'checkbox' },
          { name: 'note', label: 'What showed it', type: 'textarea', rows: 3 },
        ],
      };
    },
  };
}
