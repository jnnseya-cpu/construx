import { api } from '../lib/api.js';
import { command } from '../lib/command.js';
import { badge, date, html, humanise, notice, raw, reading, render, table, toast } from '../lib/ui.js';
import { can, draw } from '../app.js';
import { clauseLabel, clauseOptions, nameOf, personOptions, roleOptions, standardOptions } from './imscommon.js';
import { auditCards, auditCommands } from './imsaudits.js';
import { registerCards, registerCommands } from './imsregisters.js';
import { monitoringCards, monitoringCommands } from './imsmonitoring.js';

/**
 * The company's integrated management system — ISO 9001, 14001 and 45001 kept
 * as one system, on the company's record rather than any project's.
 *
 * Read from `GET /v1/ims`; every action is a command panel against the routes
 * beside it. The lists the forms offer (clauses, roles, people) come from that
 * read, so the screen holds no rule the platform does not publish.
 */

let tab = 'documents';
const TABS = [
  ['documents', 'Documents'],
  ['audits', 'Audits'],
  ['actions', 'Actions'],
  ['registers', 'Registers'],
  ['monitoring', 'Monitoring'],
  ['settings', 'Settings'],
];

const DOC_TONE = { DRAFT: 'warn', EFFECTIVE: 'ok', WITHDRAWN: 'neutral' };

function documentsCard(view, perms) {
  const live = view.documents.filter((document) => document.status !== 'WITHDRAWN');
  const withdrawn = view.documents.filter((document) => document.status === 'WITHDRAWN');
  const mine = live.filter((document) => document.acknowledgement.mustAcknowledge);
  const rows = (list) =>
    list.map((document) => [
      html`<b>${document.reference}</b> ${document.title}<br><span class="metric-sub">${humanise(document.type)} · ${document.standards.map((id) => view.vocabulary.standards.find((entry) => entry.id === id)?.label ?? id).join(', ')} · ${document.clauses.length} clause${document.clauses.length === 1 ? '' : 's'}</span>`,
      document.owner,
      html`${badge(document.status.toLowerCase(), DOC_TONE[document.status] ?? 'neutral')}${
        document.inForce ? html`<br><span class="metric-sub">rev ${document.inForce.revision}, approved ${date(document.inForce.approvedAt)}</span>` : ''
      }${document.draft ? html`<br>${badge('rev ' + document.draft.revision + ' awaiting approval', 'info')}${document.draft.returns?.length ? html`<br><span class="metric-sub">returned: ${document.draft.returns.at(-1).reason}</span>` : ''}` : ''}`,
      document.reviewDueOn ? html`${document.reviewDueOn}${document.reviewOverdue ? html`<br>${badge('overdue', 'bad')}` : ''}` : '—',
      document.inForce && document.distribution.length
        ? html`${badge(document.acknowledgement.acknowledged + ' of ' + document.acknowledgement.required, document.acknowledgement.acknowledged === document.acknowledgement.required ? 'ok' : 'warn')}${
            document.acknowledgement.outstanding.length
              ? html`<details><summary style="cursor:pointer;font-size:12px">Not yet</summary><span style="font-size:12px">${document.acknowledgement.outstanding.map((person) => person.name).join(', ')}</span></details>`
              : ''
          }`
        : html`<span class="metric-sub">${document.distribution.length ? 'when in force' : 'not issued to a role'}</span>`,
      html`<button class="btn quiet sm" data-ims-read="${document.id}">Read</button>${
        document.acknowledgement.mustAcknowledge ? html` <button class="btn sm" data-command="ims-ack" data-document="${document.id}">Read and understood</button>` : ''
      }${perms.approve && document.draft ? html` <button class="btn quiet sm" data-command="ims-approve" data-document="${document.id}">Approve</button> <button class="btn quiet sm" data-command="ims-return" data-document="${document.id}">Return</button>` : ''}${
        perms.update && document.status !== 'WITHDRAWN' ? html` <button class="btn quiet sm" data-command="ims-redraft" data-document="${document.id}">Redraft</button>` : ''
      }${perms.update && document.status === 'EFFECTIVE' && !document.draft ? html` <button class="btn quiet sm" data-command="ims-review" data-document="${document.id}">Reviewed, no change</button>` : ''}${
        perms.approve && document.status !== 'WITHDRAWN' ? html` <button class="btn quiet sm" data-command="ims-withdraw" data-document="${document.id}">Withdraw</button>` : ''
      }`,
    ]);
  return html`
    ${mine.length ? notice(html`You have ${mine.length} document${mine.length === 1 ? '' : 's'} to read and acknowledge: ${mine.map((document) => document.reference).join(', ')}.`, 'warn') : ''}
    <section class="card" style="margin-bottom:14px" aria-labelledby="ims-docs-h" data-ims-documents>
      <h2 id="ims-docs-h">Controlled documents ${perms.create ? html`<button class="btn quiet sm" data-command="ims-draft">Draft a document</button>` : ''}</h2>
      <p class="metric-sub">Policies, procedures, work instructions, forms and plans. A revision is in force only once somebody other than its author approves it; the revision it replaces is kept. Everyone in the roles a document is issued to acknowledges each revision in force.</p>
      ${table({
        headers: ['Document', 'Owner', 'Status', 'Review due', 'Read and understood', ''],
        empty: 'No controlled document yet',
        emptyDetail: perms.create ? 'Draft the policy first, then the procedures that put it to work.' : 'The quality or safety lead drafts the documents.',
        rows: rows(live),
      })}
      ${withdrawn.length ? html`<details style="margin-top:10px"><summary style="cursor:pointer;font-size:12.5px">${withdrawn.length} withdrawn</summary>${table({ headers: ['Document', 'Owner', 'Status', 'Review due', 'Read and understood', ''], rows: rows(withdrawn) })}</details>` : ''}
    </section>`;
}

function settingsCard(view, perms) {
  const s = view.settings;
  const rows = [
    ['Documents reviewed every', `${s.documentReviewMonths} months`],
    ['An environmental aspect is significant at', `severity × likelihood of ${s.aspectSignificanceThreshold} or more`],
    ['Suppliers evaluated every', `${s.supplierEvaluationMonths} months`],
    ['A supplier is put to review below an average of', `${s.supplierReviewBelow} out of 5`],
    ['Competence shown as expiring within', String(s.competenceWarningDays) + ' day' + (s.competenceWarningDays === 1 ? '' : 's')],
  ];
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="ims-set-h" data-ims-settings>
    <h2 id="ims-set-h">Settings ${perms.approve ? html`<button class="btn quiet sm" data-command="ims-settings">Change</button>` : ''}</h2>
    <p class="metric-sub">The decisions the standards leave to the company. Each change is recorded with its reason.</p>
    ${table({ headers: ['Setting', 'Value'], rows })}
    ${s.updatedAt ? html`<p class="metric-sub">Last changed ${date(s.updatedAt)} by ${nameOf(view, s.updatedBy)}: ${s.note}</p>` : html`<p class="metric-sub">These are the starting values; nobody has changed them yet.</p>`}
  </section>`;
}

function documentFields(view, document) {
  return [
    { name: 'title', label: 'Title', type: 'text', value: document?.title ?? '' },
    { name: 'purpose', label: 'Purpose (optional)', type: 'text', required: false, value: document?.purpose ?? '' },
    { name: 'standards', label: 'Standards it serves', type: 'multiselect', options: standardOptions(view), value: document?.standards ?? [] },
    { name: 'clauses', label: 'Clauses it meets', type: 'multiselect', required: false, options: clauseOptions(view), value: document?.clauses ?? [] },
    { name: 'ownerId', label: 'Owner', type: 'select', options: personOptions(view), value: document?.ownerId ?? '' },
    { name: 'distribution', label: 'Issued to (each person in these roles acknowledges it)', type: 'multiselect', required: false, options: roleOptions(view), value: document?.distribution ?? [] },
  ];
}

export async function ims(root) {
  let view;
  try {
    view = await api.get('/v1/ims');
  } catch (error) {
    render(
      root,
      html`<div class="view-head"><div><h1>Management System</h1></div></div>
        ${notice(`The management system could not be read: ${error.message ?? String(error)}`, 'err')}`,
    );
    return;
  }
  const may = (code) => can('MANAGEMENT_SYSTEM', code, { tenantScoped: true });
  const perms = { create: may('C'), update: may('U'), approve: may('A') };

  render(
    root,
    html`<div class="view-head"><div><h1>Management System</h1>
        <p class="metric-sub">ISO 9001, ISO 14001 and ISO 45001 as one system for the whole company, reading the records every project already keeps.</p></div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px" role="tablist" aria-label="Management system sections">
        ${TABS.map(([id, label]) => html`<button class="btn ${raw(tab === id ? '' : 'ghost')}" role="tab" aria-selected="${tab === id ? 'true' : 'false'}" data-ims-tab="${id}">${label}</button>`)}
      </div>
      ${tab === 'documents' ? documentsCard(view, perms) : ''}
      ${tab === 'audits' || tab === 'actions' ? auditCards(view, perms, tab) : ''}
      ${tab === 'registers' ? registerCards(view, perms) : ''}
      ${tab === 'monitoring' ? monitoringCards(view, perms) : ''}
      ${tab === 'settings' ? settingsCard(view, perms) : ''}`,
  );

  const docOf = (button) => view.documents.find((document) => document.id === button.dataset.document);
  const COMMANDS = {
    ...auditCommands(view),
    ...registerCommands(view),
    ...monitoringCommands(view),
    'ims-draft': () => ({
      title: 'Draft a controlled document',
      intent: 'It is a draft until somebody other than you approves it. Write the document here, or attach the file it is kept in.',
      path: '/v1/ims/documents',
      submitLabel: 'Draft it',
      fields: [
        { name: 'type', label: 'Type', type: 'select', options: view.vocabulary.documentTypes.map((type) => ({ value: type, label: humanise(type) })), value: 'PROCEDURE' },
        ...documentFields(view),
        { name: 'content', label: 'The document', type: 'textarea', rows: 10, required: false, placeholder: 'Purpose, scope, responsibilities, the procedure step by step, records kept…' },
        { name: 'fileHash', label: 'Or attach the file (optional)', type: 'file', required: false, nameInto: 'fileName', voice: false },
      ],
      transform: (v) => {
        const { fileHash, fileName, ...rest } = v;
        return { ...rest, clauses: v.clauses ?? [], distribution: v.distribution ?? [], ...(fileHash ? { file: { hash: fileHash, filename: fileName } } : {}) };
      },
      report: (res) => ({ title: 'Drafted', message: `${res.reference} is a draft. Somebody other than you approves it to bring it into force.`, tone: 'ok' }),
    }),
    'ims-redraft': (button) => {
      const document = docOf(button);
      return {
        title: `Redraft ${document.reference}`,
        intent: document.inForce ? `Revision ${document.inForce.revision} stays in force until this draft is approved.` : 'The draft is replaced by what you write here.',
        path: `/v1/ims/documents/${document.id}/redraft`,
        submitLabel: 'Save the draft',
        fields: [
          ...documentFields(view, document),
          { name: 'changeSummary', label: 'What changes and why', type: 'text' },
          { name: 'content', label: 'The document (leave empty to keep the current text)', type: 'textarea', rows: 10, required: false },
          { name: 'fileHash', label: 'Replace the attached file (optional)', type: 'file', required: false, nameInto: 'fileName', voice: false },
        ],
        transform: (v) => {
          const { fileHash, fileName, content, ...rest } = v;
          return { ...rest, clauses: v.clauses ?? [], distribution: v.distribution ?? [], ...(content ? { content } : {}), ...(fileHash ? { file: { hash: fileHash, filename: fileName } } : {}) };
        },
      };
    },
    'ims-approve': (button) => {
      const document = docOf(button);
      return {
        title: `Approve ${document.reference} revision ${document.draft.revision}`,
        intent: `Drafted by ${nameOf(view, document.draft.author)}: “${document.draft.changeSummary}”. Read it before approving — it comes into force and everyone it is issued to acknowledges it again.`,
        path: `/v1/ims/documents/${document.id}/approve`,
        submitLabel: 'Approve',
        fields: [{ name: 'note', label: 'What you checked', type: 'text' }],
      };
    },
    'ims-return': (button) => ({
      title: `Return ${docOf(button).reference}`,
      intent: 'It stays a draft; the author sees what has to change.',
      path: `/v1/ims/documents/${button.dataset.document}/return`,
      submitLabel: 'Return',
      fields: [{ name: 'reason', label: 'What has to change', type: 'text' }],
    }),
    'ims-review': (button) => ({
      title: `Periodic review of ${docOf(button).reference}`,
      intent: 'Records that the document still describes how the work is done. If it does not, redraft it instead.',
      path: `/v1/ims/documents/${button.dataset.document}/review`,
      submitLabel: 'Record the review',
      fields: [{ name: 'note', label: 'What it was checked against', type: 'text' }],
    }),
    'ims-withdraw': (button) => ({
      title: `Withdraw ${docOf(button).reference}`,
      intent: 'It stays on the record, withdrawn, with your reason.',
      path: `/v1/ims/documents/${button.dataset.document}/withdraw`,
      submitLabel: 'Withdraw',
      fields: [{ name: 'reason', label: 'Why, and what replaces it', type: 'text' }],
    }),
    'ims-ack': (button) => {
      const document = docOf(button);
      return {
        title: `${document.reference} ${document.title}`,
        intent: `Confirm you have read and understood revision ${document.inForce.revision}. Use “Read” first if you have not.`,
        path: `/v1/ims/documents/${document.id}/acknowledge`,
        submitLabel: 'Read and understood',
        fields: [],
      };
    },
    'ims-settings': () => {
      const s = view.settings;
      return {
        title: 'Change the settings',
        intent: 'Each is a decision the standards leave to the company; the change is recorded with your reason.',
        path: '/v1/ims/settings',
        method: 'PUT',
        submitLabel: 'Save',
        fields: [
          { name: 'documentReviewMonths', label: 'Review documents every (months)', type: 'number', min: 1, step: '1', value: s.documentReviewMonths },
          { name: 'aspectSignificanceThreshold', label: 'Aspect significant at severity × likelihood of', type: 'number', min: 1, step: '1', value: s.aspectSignificanceThreshold },
          { name: 'supplierEvaluationMonths', label: 'Evaluate suppliers every (months)', type: 'number', min: 1, step: '1', value: s.supplierEvaluationMonths },
          { name: 'supplierReviewBelow', label: 'Put a supplier to review below (1–5)', type: 'number', min: 1, step: 'any', value: s.supplierReviewBelow },
          { name: 'competenceWarningDays', label: 'Show competence as expiring within (days)', type: 'number', min: 1, step: '1', value: s.competenceWarningDays },
          { name: 'note', label: 'Why', type: 'text' },
        ],
      };
    },
  };

  root.addEventListener('click', async (event) => {
    const tabButton = event.target.closest('[data-ims-tab]');
    if (tabButton) {
      tab = tabButton.dataset.imsTab;
      await draw();
      return;
    }
    const readButton = event.target.closest('[data-ims-read]');
    if (readButton) {
      try {
        const document = await api.get(`/v1/ims/documents/${readButton.dataset.imsRead}`);
        await reading({
          title: `${document.reference} ${document.title}`,
          intent: `${humanise(document.type)} · owner ${document.owner} · ${document.clauses.map((id) => clauseLabel(view, id)).join('; ') || 'no clause mapped'}`,
          content: html`${document.revisions
            .slice()
            .reverse()
            .map(
              (revision) => html`<section style="margin-bottom:14px">
                <h3 style="margin:0">Revision ${revision.revision} ${badge(revision.status.toLowerCase(), DOC_TONE[revision.status] ?? 'neutral')}</h3>
                <p class="metric-sub" style="margin:4px 0">${revision.changeSummary} · drafted by ${nameOf(view, revision.author)} ${date(revision.draftedAt)}${
                  revision.approvedBy ? ` · approved by ${nameOf(view, revision.approvedBy)} ${date(revision.approvedAt)}: ${revision.approvalNote}` : ''
                }${revision.draftedByAgent ? ' · drafted by the AI agent, accepted by a person' : ''}</p>
                ${revision.file ? html`<p class="metric-sub">Attached: ${revision.file.filename}</p>` : ''}
                ${revision.content ? html`<div style="white-space:pre-wrap;font-size:13px;line-height:1.5">${revision.content}</div>` : ''}
              </section>`,
            )}`,
        });
      } catch (error) {
        toast('Could not be read', error.message ?? String(error), 'err');
      }
      return;
    }
    const button = event.target.closest('[data-command]');
    if (!button) return;
    const make = COMMANDS[button.dataset.command];
    if (!make) return;
    if (await command(make(button, root))) await draw();
  });
}
