import { api } from '../lib/api.js';
import { badge, date, html, humanise, notice, table } from '../lib/ui.js';
import { clauseLabel, nameOf, personOptions, plural, standardOptions } from './imscommon.js';

/**
 * The management system's agents on its screen: what to ask them for, and what
 * they propose for a person to edit and accept, or reject. Every run is quoted
 * before it spends anything; accepting runs the ordinary command as you.
 */

const KIND_WORDS = {
  PROCEDURE: 'Procedure',
  CLAUSE_MAPPING: 'Clause mapping',
  AUDIT_CHECKLIST: 'Audit checklist',
  ROOT_CAUSE: 'Root cause',
  REVIEW_MINUTES: 'Review minutes',
  ASPECT: 'Environmental aspect',
  OBLIGATION: 'Legal requirement',
  OBJECTIVE: 'Objective',
};
const FIELD_WORDS = {
  title: 'Title',
  purpose: 'Purpose',
  content: 'The document',
  rootCause: 'Root cause',
  plannedActions: 'Actions on the cause',
  correction: 'Correction',
  controls: 'Controls',
  requirement: 'What it requires',
  applicability: 'How it applies',
  howComplied: 'How the company complies',
  objective: 'Objective',
  measure: 'Measured by',
  target: 'Target',
  baseline: 'Baseline',
  dueOn: 'By (YYYY-MM-DD)',
};
const LONG = new Set(['content', 'rootCause', 'plannedActions', 'requirement', 'applicability', 'howComplied', 'controls']);

export async function loadAgents() {
  const [proposals, estimate] = await Promise.all([
    api.get('/v1/ims/agents/proposals').catch((error) => ({ error })),
    api.get('/v1/ims/agents/estimate').catch((error) => ({ error })),
  ]);
  return { proposals, estimate };
}

function detail(view, proposal) {
  const p = proposal.payload;
  switch (proposal.kind) {
    case 'PROCEDURE':
      return html`<span class="metric-sub">${humanise(p.type)} · from ${p.basedOn} · ${plural(p.clauses.length, 'clause', 'clauses')} · issued to ${p.distribution.map((role) => humanise(role)).join(', ') || 'nobody yet'}</span><details><summary style="cursor:pointer;font-size:12px">Read the draft</summary><div style="white-space:pre-wrap;font-size:12px;margin-top:4px">${p.content}</div></details>`;
    case 'CLAUSE_MAPPING':
      return html`<ul style="margin:4px 0 0 16px;font-size:12px">${p.reasons.map((entry) => html`<li>${clauseLabel(view, entry.clauseId)} — ${entry.reason}</li>`)}</ul>`;
    case 'AUDIT_CHECKLIST':
      return html`<details><summary style="cursor:pointer;font-size:12px">${plural(p.items.length, 'item', 'items')}</summary><ol style="margin:4px 0 0 18px;font-size:12px">${p.items.map((item) => html`<li>${item.question} <span class="metric-sub">${clauseLabel(view, item.clauseId)}</span></li>`)}</ol></details>`;
    case 'ROOT_CAUSE':
      return html`<span style="font-size:12px"><b>Cause:</b> ${p.rootCause}<br><b>Actions:</b> ${p.plannedActions}</span>`;
    case 'REVIEW_MINUTES':
      return html`<details><summary style="cursor:pointer;font-size:12px">${plural(p.minutes.length, 'minute', 'minutes')}, ${plural(p.outputs.length, 'output', 'outputs')}</summary><ul style="margin:4px 0 0 16px;font-size:12px">${p.minutes.map((entry) => html`<li><b>${entry.key}</b>: ${entry.text}</li>`)}${p.outputs.map((entry) => html`<li>${badge(humanise(entry.kind).toLowerCase(), 'info')} ${entry.text}</li>`)}</ul></details>`;
    case 'ASPECT':
      return html`<span class="metric-sub">${humanise(p.condition).toLowerCase()} · ${p.severity} × ${p.likelihood}${p.legalDriver ? ' · legal driver' : ''} · controls: ${p.controls}</span>`;
    case 'OBLIGATION':
      return html`<span style="font-size:12px"><b>Requires:</b> ${p.requirement}<br><b>Applies:</b> ${p.applicability}<br><b>Complied with by:</b> ${p.howComplied}</span>`;
    case 'OBJECTIVE':
      return html`<span class="metric-sub">${p.measure} · target ${p.target}${p.baseline ? ' · baseline ' + p.baseline : ''} · by ${p.dueOn}</span>`;
    default:
      return '';
  }
}

export function agentsCard(view, agents, perms) {
  if (agents.proposals.error) return notice(`The agents could not be read: ${agents.proposals.error.message ?? String(agents.proposals.error)}`, 'err');
  const { proposals, share } = agents.proposals;
  const pending = proposals.filter((entry) => entry.status === 'PROPOSED');
  const decided = proposals.filter((entry) => entry.status !== 'PROPOSED');
  const perRun = agents.estimate.error ? null : agents.estimate.estimates?.[0]?.estimatedChargeMinor;
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="ims-ag-h" data-ims-agents>
    <h2 id="ims-ag-h">AI agents</h2>
    <p class="metric-sub">The agents draft procedures, map clauses, write audit checklists, find root causes, minute management reviews, and build the aspects and legal registers and the objectives. You decide: nothing they propose is recorded until you accept it — edited if you wish — under your own permissions, and approvals stay with people. Anything that fails the checks (a clause that is not a clause, an Act not on the list, a score out of range) is dropped before you see it. Each run shows its cost first${perRun ? ', from about ' + (perRun / 100).toLocaleString('en-GB', { style: 'currency', currency: 'GBP' }) : ''}.</p>
    <p style="margin:6px 0">${badge(share.pending + ' awaiting you', share.pending ? 'warn' : 'neutral')} ${badge(share.accepted + ' accepted', 'ok')} ${badge(share.rejected + ' rejected', 'neutral')}</p>
    ${
      perms.create
        ? html`<div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0">
            <button class="btn sm" data-command="ims-agent-procedure">Draft a procedure</button>
            <button class="btn quiet sm" data-command="ims-agent-aspects">Identify environmental aspects</button>
            <button class="btn quiet sm" data-command="ims-agent-obligations">Build the legal register</button>
            <button class="btn quiet sm" data-command="ims-agent-objectives">Propose objectives</button>
          </div>
          <p class="metric-sub">Clause mapping, audit checklists, root causes and review minutes are run from the document, audit, action or review they are for.</p>`
        : ''
    }
    <h3 style="margin-top:12px">Awaiting your decision</h3>
    ${table({
      headers: ['Proposal', 'What', ''],
      empty: 'Nothing awaiting you',
      emptyDetail: perms.create ? 'Ask an agent for work above, or from a document, audit, action or review.' : 'The quality or safety lead asks the agents for work.',
      rows: pending.map((entry) => [
        html`${badge(KIND_WORDS[entry.kind] ?? humanise(entry.kind), 'info')}<br><span class="metric-sub">${date(entry.proposedAt)}</span>`,
        html`<span style="font-size:12.5px">${entry.summary}</span><br>${detail(view, entry)}`,
        perms.update
          ? html`<button class="btn sm" data-command="ims-agent-decide" data-proposal="${entry.id}" data-decision="ACCEPT">Accept</button> <button class="btn quiet sm" data-command="ims-agent-decide" data-proposal="${entry.id}" data-decision="REJECT">Reject</button>`
          : '',
      ]),
    })}
    ${
      decided.length
        ? html`<details style="margin-top:10px"><summary style="cursor:pointer;font-size:12.5px">${plural(decided.length, 'decided', 'decided')}</summary>${table({
            headers: ['Proposal', 'Decision'],
            rows: decided.map((entry) => [
              html`${badge(KIND_WORDS[entry.kind] ?? humanise(entry.kind), 'neutral')} <span style="font-size:12.5px">${entry.summary}</span>`,
              html`${badge(entry.status.toLowerCase(), entry.status === 'ACCEPTED' ? 'ok' : 'neutral')}<br><span class="metric-sub">${nameOf(view, entry.decidedBy)} ${date(entry.decidedAt)}${entry.decisionNote ? ' — ' + entry.decisionNote : ''}</span>`,
            ]),
          })}</details>`
        : ''
    }
  </section>`;
}

function runReport(one, many) {
  return (res) =>
    res.proposed > 0
      ? { title: 'Proposed', message: `${res.proposed} ${res.proposed === 1 ? one : many} for you to accept or reject${res.dropped ? `; ${res.dropped} dropped because ${res.dropped === 1 ? 'it' : 'they'} failed the checks` : ''}. See the AI agents tab.`, tone: 'ok' }
      : { title: 'Nothing proposed', message: res.dropped ? `All ${res.dropped} of the agent’s answers failed the checks, so nothing is shown.` : 'The agent found nothing to propose.', tone: 'warn' };
}

export function agentCommands(view, agents) {
  const proposals = agents.proposals.error ? [] : agents.proposals.proposals;
  const editable = agents.proposals.error ? {} : agents.proposals.editable;
  const policies = view.documents.filter((document) => document.type === 'POLICY' && document.status !== 'WITHDRAWN');
  return {
    'ims-agent-procedure': () => ({
      title: 'Draft a procedure',
      intent: 'From a policy in the library, or from a brief of what it must cover. You accept it as a draft, and somebody else approves it.',
      path: '/v1/ims/agents/procedure',
      ai: true,
      submitLabel: 'Ask the agent',
      fields: [
        { name: 'title', label: 'What it is for', type: 'text', placeholder: 'Control of documented information' },
        { name: 'type', label: 'Type', type: 'select', options: view.vocabulary.documentTypes.map((type) => ({ value: type, label: humanise(type) })), value: 'PROCEDURE' },
        { name: 'standards', label: 'Standards it serves', type: 'multiselect', options: standardOptions(view) },
        { name: 'policyDocumentId', label: 'From the policy', type: 'select', required: false, placeholder: 'No policy — use the brief', options: policies.map((document) => ({ value: document.id, label: `${document.reference} ${document.title}` })) },
        { name: 'brief', label: 'Or a brief of what it must cover', type: 'textarea', rows: 4, required: false },
      ],
      report: runReport('draft procedure', 'draft procedures'),
    }),
    'ims-agent-clauses': (button) => ({
      title: 'Map the clauses',
      intent: 'The agent reads the document and says which clauses of its standards it meets. Accepting makes a draft revision to approve.',
      path: `/v1/ims/documents/${button.dataset.document}/agents/clauses`,
      ai: true,
      submitLabel: 'Ask the agent',
      fields: [],
      report: runReport('clause mapping', 'clause mappings'),
    }),
    'ims-agent-checklist': (button) => ({
      title: 'Draft the audit checklist',
      intent: 'Questions and records to see, against the audit’s clauses and the procedures it samples.',
      path: `/v1/ims/audits/${button.dataset.audit}/agents/checklist`,
      ai: true,
      submitLabel: 'Ask the agent',
      fields: [],
      report: runReport('checklist', 'checklists'),
    }),
    'ims-agent-root-cause': (button) => ({
      title: 'Propose the root cause',
      intent: 'The likely cause through the system, and the actions on it. You edit and accept it, or reject it.',
      path: `/v1/ims/actions/${button.dataset.action}/agents/root-cause`,
      ai: true,
      submitLabel: 'Ask the agent',
      fields: [],
      report: runReport('root cause', 'root causes'),
    }),
    'ims-agent-minutes': (button) => ({
      title: 'Draft the review minutes',
      intent: 'A minute for each input that has figures, from the frozen figures only, and proposed decisions. Inputs the records cannot hold stay for the meeting; a minute somebody has written stays theirs.',
      path: `/v1/ims/reviews/${button.dataset.review}/agents/minutes`,
      ai: true,
      submitLabel: 'Ask the agent',
      fields: [],
      report: runReport('set of minutes', 'sets of minutes'),
    }),
    'ims-agent-aspects': () => ({
      title: 'Identify environmental aspects',
      intent: 'Describe the activities — trades, plant, sites. Each aspect comes back as its own proposal.',
      path: '/v1/ims/agents/aspects',
      ai: true,
      submitLabel: 'Ask the agent',
      fields: [{ name: 'activities', label: 'The company’s activities', type: 'textarea', rows: 4, placeholder: 'Groundworks, drainage, concrete frames, refuelling of plant, temporary works, waste segregation' }],
      report: runReport('aspect', 'aspects'),
    }),
    'ims-agent-obligations': () => ({
      title: 'Build the legal register',
      intent: 'The agent chooses only from the legislation list — it cannot name an Act that is not on it. Leave the activities empty to use the aspects register.',
      path: '/v1/ims/agents/obligations',
      ai: true,
      submitLabel: 'Ask the agent',
      fields: [
        { name: 'regions', label: 'Where the company works', type: 'multiselect', options: view.vocabulary.regions.map((region) => ({ value: region, label: humanise(region) })), value: ['ENGLAND', 'WALES'] },
        { name: 'activities', label: 'The company’s activities (optional)', type: 'textarea', rows: 3, required: false },
      ],
      report: runReport('requirement', 'requirements'),
    }),
    'ims-agent-objectives': () => ({
      title: 'Propose objectives',
      intent: 'Measurable objectives for the year ahead, each from a figure in the company position.',
      path: '/v1/ims/agents/objectives',
      ai: true,
      submitLabel: 'Ask the agent',
      fields: [],
      report: runReport('objective', 'objectives'),
    }),
    'ims-agent-decide': (button) => {
      const entry = proposals.find((proposal) => proposal.id === button.dataset.proposal);
      const accept = button.dataset.decision === 'ACCEPT';
      const fields = accept
        ? [
            ...(editable[entry.kind] ?? []).map((name) => ({ name, label: FIELD_WORDS[name] ?? humanise(name), type: LONG.has(name) ? 'textarea' : 'text', rows: name === 'content' ? 12 : 3, required: false, value: entry.payload[name] ?? '' })),
            ...(entry.kind === 'PROCEDURE' || entry.kind === 'OBJECTIVE' ? [{ name: 'ownerId', label: 'Owner', type: 'select', options: personOptions(view), value: view.me }] : []),
            { name: 'note', label: 'Note (optional)', type: 'text', required: false },
          ]
        : [{ name: 'note', label: 'Why it is rejected (optional)', type: 'text', required: false }];
      return {
        title: `${accept ? 'Accept' : 'Reject'}: ${entry.summary}`,
        intent: accept ? 'Edit what you need to. Accepting records it as if you had entered it yourself, under your own permissions.' : 'Rejecting records nothing.',
        path: `/v1/ims/agents/proposals/${entry.id}/decide`,
        submitLabel: accept ? 'Accept' : 'Reject',
        fields,
        transform: (v) => {
          const edits = Object.fromEntries((editable[entry.kind] ?? []).filter((name) => v[name] !== undefined && String(v[name]) !== String(entry.payload[name] ?? '')).map((name) => [name, String(v[name])]));
          return { decision: button.dataset.decision, ...(v.note ? { note: v.note } : {}), ...(v.ownerId ? { ownerId: v.ownerId } : {}), ...(Object.keys(edits).length ? { edits } : {}) };
        },
        report: (res) => ({ title: res.status === 'ACCEPTED' ? 'Accepted' : 'Rejected', message: res.status === 'ACCEPTED' ? 'Recorded under your name.' : 'Nothing was recorded.', tone: 'ok' }),
      };
    },
  };
}
