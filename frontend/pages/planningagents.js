import { api } from '../lib/api.js';
import { badge, date, html, humanise, notice, table, toast } from '../lib/ui.js';

/**
 * The planning agents on the Planning screen.
 *
 * The agents read the documents, draft the briefs and the statement and plan
 * the next actions; a person accepts or rejects each proposal. Accepting runs
 * the ordinary command under the person's own permissions, so nothing the
 * agents propose is on the record until somebody puts it there. Every run is
 * quoted before it spends anything.
 */

const KIND_WORDS = {
  PROPOSAL: 'Proposal from the need',
  SITE_FACT: 'Site fact',
  CONDITION: 'Condition',
  STUDY_SCOPE: 'Study brief',
  STATEMENT: 'Planning statement',
  ASSIGNMENT: 'Owner and date',
};
const STATUS_TONE = { PROPOSED: 'info', ACCEPTED: 'ok', REJECTED: 'neutral' };

/** The agents' proposals and the planning documents, read beside the register. */
export async function loadAgents(projectId) {
  const [agents, documents] = await Promise.all([
    api.get(`/v1/projects/${projectId}/planning/agents/proposals`).catch((error) => ({ error })),
    api.get(`/v1/projects/${projectId}/planning/documents`).catch((error) => ({ error })),
  ]);
  return { agents, documents };
}

function runReport(one, many) {
  return (res) =>
    res.proposed > 0
      ? { title: 'Proposed', message: `${res.proposed} ${res.proposed === 1 ? one : many} for you to accept or reject${res.dropped ? `; ${res.dropped} dropped because ${res.dropped === 1 ? 'it' : 'they'} could not be checked against the source` : ''}.`, tone: 'ok' }
      : { title: 'Nothing proposed', message: res.dropped ? `The agent’s ${res.dropped} answer${res.dropped === 1 ? '' : 's'} could not be checked against the source, so nothing is shown.` : 'The agent found nothing to propose.', tone: 'warn' };
}

function payloadDetail(proposal) {
  const p = proposal.payload;
  switch (proposal.kind) {
    case 'PROPOSAL':
      return html`<span style="font-size:12px">${humanise(p.category)} · ${p.route}${p.dwellings ? ` · ${p.dwellings} homes` : ''}${p.capacityUnits ? ` · ${p.capacityUnits.count} ${p.capacityUnits.unit}` : ''}${p.floorspaceM2 ? ` · ${p.floorspaceM2} m²` : ''}${
        p.temporaryMonths ? ` · temporary, ${p.temporaryMonths} months` : ''
      }${p.capacityMW ? ` · ${p.capacityMW} MW` : ''}${p.site ? ` · site ${p.site.areaHa} ha, ${p.site.authority}` : ''}</span>${
        p.questions?.length ? html`<br><span class="metric-sub">To answer: ${p.questions.join(' ')}</span>` : ''
      }`;
    case 'STUDY_SCOPE':
      return html`<details><summary style="cursor:pointer;font-size:12.5px">Read the brief</summary><p style="font-size:12px;margin:4px 0;white-space:pre-wrap">${p.scope}</p></details>`;
    case 'STATEMENT':
      return html`<details><summary style="cursor:pointer;font-size:12.5px">${p.sections.length} sections</summary>${p.sections.map(
        (section) => html`<p style="font-size:12px;margin:6px 0 2px"><b>${section.heading}</b></p><p style="font-size:12px;margin:0;white-space:pre-wrap">${section.body}</p>`,
      )}</details>`;
    case 'ASSIGNMENT':
      return html`<span class="metric-sub">${p.why}</span>`;
    case 'CONDITION':
      return html`<span class="metric-sub">${humanise(p.trigger).toLowerCase()}${p.phases?.length ? ` · ${p.phases.join(', ')}` : ''}</span>`;
    default:
      return '';
  }
}

/** The agents card: what to ask them for, the documents they read, and what they propose. */
export function agentsCard(loaded, reg, view, perms) {
  const { agents, documents } = loaded;
  if (agents.error) return notice(`The planning agents could not be read: ${agents.error.message ?? String(agents.error)}`, 'err');
  const { canCreate, canUpdate } = perms;
  const docs = documents.error ? [] : documents;
  const readable = docs.filter((entry) => entry.status !== 'QUARANTINED' && entry.characters > 0);
  const pending = agents.proposals.filter((entry) => entry.status === 'PROPOSED');
  const decided = agents.proposals.filter((entry) => entry.status !== 'PROPOSED');
  const applications = reg.error ? [] : reg.applications.filter((entry) => entry.status === 'DRAFT' || entry.status === 'READY');
  const consents = reg.error ? [] : reg.consents;
  const share = agents.share;
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="pl-agents-h" data-planning-agents>
    <h2 id="pl-agents-h">Planning agents</h2>
    <p class="metric-sub">The agents read the documents, draft the briefs and the statement, and plan who does what. You decide: nothing they propose is recorded until you accept it, under your own permissions, and gates and second-person checks stay with people. A quote the agent cannot show in the document is dropped before you see it.</p>
    <p style="margin:6px 0">${badge(`${share.pending} awaiting you`, share.pending ? 'warn' : 'neutral')} ${badge(`${share.accepted} accepted`, 'ok')} ${badge(`${share.rejected} rejected`, 'neutral')}</p>
    ${
      canCreate
        ? html`<div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0">
            <button class="btn sm" data-command="pl-agent-intake">Describe what you need</button>
            <button class="btn quiet sm" data-command="pl-doc-upload">Upload planning documents</button>
            ${readable.length ? html`<button class="btn quiet sm" data-command="pl-agent-facts">Read the site facts</button>` : ''}
            ${applications.map(
              (application) => html`<button class="btn quiet sm" data-command="pl-agent-scopes" data-application="${application.id}">Brief ${application.reference}’s studies</button>
                <button class="btn quiet sm" data-command="pl-agent-statement" data-application="${application.id}">Draft ${application.reference}’s statement</button>
                <button class="btn quiet sm" data-command="pl-agent-actions" data-application="${application.id}">Plan ${application.reference}’s next actions</button>`,
            )}
            ${readable.length ? consents.map((consent) => html`<button class="btn quiet sm" data-command="pl-agent-conditions" data-consent="${consent.id}">Read ${consent.reference}’s conditions</button>`) : ''}
          </div>`
        : ''
    }
    ${documents.error ? notice(`The planning documents could not be read: ${documents.error.message ?? String(documents.error)}`, 'err') : ''}
    ${
      docs.length
        ? html`<details style="margin:6px 0"><summary style="cursor:pointer;font-size:12.5px">${docs.length} planning document${docs.length === 1 ? '' : 's'}</summary>${table({
            headers: ['Document', 'Read'],
            rows: docs.map((entry) => [
              entry.filename,
              entry.status === 'QUARANTINED'
                ? badge('flagged by the scanner — not read', 'bad')
                : entry.characters > 0
                  ? html`${badge('read', 'ok')} <span class="metric-sub">${entry.characters.toLocaleString('en-GB')} characters</span>`
                  : badge('no text could be read', 'warn'),
            ]),
          })}</details>`
        : ''
    }
    <h3 style="margin-top:12px">Awaiting your decision</h3>
    ${table({
      headers: ['Proposal', 'What', 'Source', ''],
      empty: 'Nothing awaiting you',
      emptyDetail: canCreate ? 'Describe what you need, or upload the documents for the agents to read.' : 'A planning lead asks the agents for work.',
      rows: pending.map((proposal) => [
        html`${badge(KIND_WORDS[proposal.kind] ?? humanise(proposal.kind), 'info')}<br><span class="metric-sub">${date(proposal.proposedAt)}</span>`,
        html`<span style="font-size:12.5px">${proposal.summary}</span><br>${payloadDetail(proposal)}`,
        proposal.citation
          ? html`<details><summary style="cursor:pointer;font-size:12px">${proposal.citation.document}</summary><p style="font-size:12px;margin:4px 0">“${proposal.citation.quote}”</p></details>`
          : html`<span class="metric-sub">drafted from the record</span>`,
        canUpdate
          ? html`<button class="btn sm" data-command="pl-agent-decide" data-proposal="${proposal.id}" data-decision="ACCEPT">Accept</button> <button class="btn quiet sm" data-command="pl-agent-decide" data-proposal="${proposal.id}" data-decision="REJECT">Reject</button>`
          : '',
      ]),
    })}
    ${
      decided.length
        ? html`<details style="margin-top:10px"><summary style="cursor:pointer;font-size:12.5px">${decided.length} decided</summary>${table({
            headers: ['Proposal', 'Decision', ''],
            rows: decided
              .slice()
              .reverse()
              .map((proposal) => [
                html`${badge(KIND_WORDS[proposal.kind] ?? humanise(proposal.kind), 'neutral')} <span style="font-size:12.5px">${proposal.summary}</span>`,
                html`${badge(proposal.status.toLowerCase(), STATUS_TONE[proposal.status])}<br><span class="metric-sub">${date(proposal.decidedAt)}${proposal.decisionNote ? ` — ${proposal.decisionNote}` : ''}</span>`,
                proposal.kind === 'STATEMENT' && proposal.status === 'ACCEPTED' ? html`<button class="btn quiet sm" data-statement-download="${proposal.id}">Download the draft</button>` : '',
              ]),
          })}</details>`
        : ''
    }
  </section>`;
}

/** The command panels: each agent run is quoted before it spends anything. */
export function agentCommands(loaded, reg, base) {
  const projectId = base.split('/')[3];
  const docs = loaded.documents.error ? [] : loaded.documents.filter((entry) => entry.status !== 'QUARANTINED' && entry.characters > 0);
  const proposals = loaded.agents.error ? [] : loaded.agents.proposals;
  const appRef = (id) => (reg.error ? id : reg.applications.find((entry) => entry.id === id)?.reference ?? id);
  return {
    'pl-agent-intake': () => ({
      title: 'Describe what you need',
      intent: 'In your own words: what is to be built, how big the site is, where, and for how long if it is temporary. The agent proposes the site area and a structured proposal with its assumptions and the questions to answer; you accept it or not.',
      path: `/v1/projects/${projectId}/planning/agents/intake`,
      ai: true,
      submitLabel: 'Ask the agent',
      fields: [{ name: 'need', label: 'The need', type: 'textarea', rows: 4, placeholder: 'A 120-bed care home on 0.9 ha in Example District, with a substation for the site supply…' }],
      report: runReport('proposal', 'proposals'),
    }),
    'pl-doc-upload': () => ({
      title: 'Upload planning documents',
      intent: 'Flood map extracts, desk studies, surveys, pre-application letters, decision notices. Each is scanned and read on arrival, and only then can the agents read it.',
      path: `/v1/projects/${projectId}/planning/documents`,
      submitLabel: 'Upload',
      fields: [{ name: 'hash', label: 'Documents', type: 'file', multiple: true, nameInto: 'filename', voice: false }],
    }),
    'pl-agent-facts': () => ({
      title: 'Read the site facts',
      intent: 'The agent reads the planning documents and proposes each fact the rules read — flood zone, designations, ecology, the local validation list — with the passage it came from. A fact the documents do not state is left unknown.',
      path: `/v1/projects/${projectId}/planning/agents/site-facts`,
      ai: true,
      submitLabel: 'Read them',
      fields: [
        {
          name: 'ingestionIds',
          label: 'Documents to read',
          type: 'multiselect',
          required: false,
          hint: 'Leave all unticked to read every planning document.',
          options: docs.map((entry) => ({ value: entry.ingestionId, label: entry.filename })),
        },
      ],
      report: runReport('site fact', 'site facts'),
    }),
    'pl-agent-conditions': (button) => ({
      title: 'Read the conditions from the decision notice',
      intent: 'The agent proposes every condition word for word, with its trigger and phases. Accepted conditions still need a second person to verify the wording.',
      path: `/v1/projects/${projectId}/planning/consents/${button.dataset.consent}/agents/conditions`,
      ai: true,
      submitLabel: 'Read them',
      fields: [{ name: 'ingestionId', label: 'The decision notice', type: 'select', options: docs.map((entry) => ({ value: entry.ingestionId, label: entry.filename })) }],
      report: runReport('condition', 'conditions'),
    }),
    'pl-agent-scopes': (button) => ({
      title: `Brief ${appRef(button.dataset.application)}’s studies`,
      intent: 'A consultant’s brief for each study not yet briefed or ruled out: the questions it must answer, the survey work and timing, and the outputs the application needs.',
      path: `/v1/projects/${projectId}/planning/applications/${button.dataset.application}/agents/study-scopes`,
      ai: true,
      submitLabel: 'Draft the briefs',
      fields: [],
      report: runReport('study brief', 'study briefs'),
    }),
    'pl-agent-statement': (button) => ({
      title: `Draft ${appRef(button.dataset.application)}’s planning statement`,
      intent: 'Drafted only from the record — the site, the proposal, the facts and the findings. Anything unknown is marked to be confirmed rather than invented.',
      path: `/v1/projects/${projectId}/planning/applications/${button.dataset.application}/agents/statement`,
      ai: true,
      submitLabel: 'Draft it',
      fields: [],
      report: runReport('draft statement', 'draft statements'),
    }),
    'pl-agent-actions': (button) => ({
      title: `Plan ${appRef(button.dataset.application)}’s next actions`,
      intent: 'An owner and a needed-by date for each open requirement, working back from the target submission. Accepting one sets it on the requirement.',
      path: `/v1/projects/${projectId}/planning/applications/${button.dataset.application}/agents/next-actions`,
      ai: true,
      submitLabel: 'Plan them',
      fields: [],
      report: runReport('owner and date', 'owners and dates'),
    }),
    'pl-agent-decide': (button) => {
      const proposal = proposals.find((entry) => entry.id === button.dataset.proposal);
      const accept = button.dataset.decision === 'ACCEPT';
      return {
        title: `${accept ? 'Accept' : 'Reject'}: ${proposal?.summary ?? 'the proposal'}`,
        intent: accept
          ? 'Accepting records it as if you had entered it yourself, under your own permissions. Check it against its source first.'
          : 'Rejecting changes nothing on the record; the proposal stays listed as rejected.',
        path: `/v1/projects/${projectId}/planning/agents/proposals/${button.dataset.proposal}/decide`,
        submitLabel: accept ? 'Accept' : 'Reject',
        fields: [{ name: 'note', label: 'Note', type: 'text', required: false }],
        transform: (v) => ({ decision: button.dataset.decision, ...(v.note ? { note: v.note } : {}) }),
        report: (res) => ({ title: res.status === 'ACCEPTED' ? 'Accepted' : 'Rejected', message: res.status === 'ACCEPTED' ? 'Recorded under your name.' : 'Nothing was changed.', tone: 'ok' }),
      };
    },
  };
}

/** The accepted statement, downloaded as text for a person to finish. */
export function bindAgentExtras(root, loaded) {
  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-statement-download]');
    if (!button) return;
    const proposal = (loaded.agents.error ? [] : loaded.agents.proposals).find((entry) => entry.id === button.dataset.statementDownload);
    if (!proposal) {
      toast('Not downloaded', 'That draft is no longer on the screen; reload the page.', 'err');
      return;
    }
    const text = proposal.payload.sections.map((section) => `${section.heading}\n\n${section.body}`).join('\n\n');
    const blob = new Blob([`${proposal.summary}\n\nDrafted by the planning agent; accepted ${String(proposal.decidedAt).slice(0, 10)}. To be checked and finished by the planning lead.\n\n${text}\n`], { type: 'text/plain' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'planning-statement-draft.txt';
    link.click();
    URL.revokeObjectURL(link.href);
  });
}
