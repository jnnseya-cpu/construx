import { api } from '../lib/api.js';
import { command } from '../lib/command.js';
import { badge, date, html, humanise, notice, render, table, toast } from '../lib/ui.js';
import { can, draw, state } from '../app.js';

/**
 * Contracts Studio: choosing the form, and completing its particulars.
 *
 * Read from `GET /v1/projects/:projectId/contract-studio`. The schedule each
 * draft is completed against, the form catalogue and the selection vocabulary
 * all come from that read; the screen holds no rule the platform does not
 * publish. Every value is normalised and checked by the platform, and a refusal
 * lands on the field it is about.
 */

let openDraftId = null;
let shortlist = null;
let filter = { publisher: '', q: '' };
/** What the last shortlist was asked from, kept with a draft opened from it. */
let asked = null;

const STATUS_TONE = { CURRENT: 'ok', LEGACY: 'neutral', VERIFY_ISSUE: 'warn' };
const STATUS_WORDS = { CURRENT: 'current', LEGACY: 'earlier edition', VERIFY_ISSUE: 'edition to confirm' };
const GROUP_WORDS = { PARTIES: 'Parties', PROJECT: 'The project', DATES: 'Dates', COMMERCIAL: 'Commercial', INSURANCE: 'Insurance', OBLIGATIONS: 'Obligations', ATTACHMENTS: 'Documents bound into the contract' };
const PLACEHOLDER = { MONEY: '1,250,000', PERCENT: '3', DATE: '', DURATION: '12 months', REFERENCE: 'Document title, reference and revision', TEXT: '' };

const optionsOf = (list) => list.map((value) => ({ value, label: humanise(value) }));
/** Text from a document, made safe to place in the panel's pre-rendered brief. */
const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function draftsCard(view, perms) {
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="cs-drafts-h" data-cs-drafts>
    <h2 id="cs-drafts-h">Contract drafts
      ${perms.read ? html`<button class="btn quiet sm" data-command="cs-select">Find the right form</button>` : ''}
      ${perms.create ? html`<button class="btn quiet sm" data-command="cs-open">Open a draft</button>` : ''}</h2>
    <p class="metric-sub">One form in one exact edition, and its particulars — each with where it came from. Every change is a new revision.</p>
    ${table({
      headers: ['Draft', 'Form', 'Completed', 'Status', ''],
      empty: 'No contract draft on this project',
      emptyDetail: perms.create ? 'Find the right form, then open a draft on it.' : 'The commercial team opens the drafts.',
      rows: view.drafts.map((draft) => [
        html`<b>${draft.reference}</b> ${draft.title}<br><span class="metric-sub">revision ${draft.revision} · ${draft.currency}</span>`,
        html`${draft.formLabel}${draft.schedule.ownSchedule ? '' : html`<br><span class="metric-sub">general particulars schedule</span>`}`,
        html`${badge(draft.completion.completed + ' of ' + draft.completion.required, draft.completion.completed === draft.completion.required ? 'ok' : 'warn')}${draft.blocking ? html` ${badge(draft.blocking + ' blocking', 'bad')}` : ''}`,
        badge(STATUS_WORDS_DRAFT[draft.status], STATUS_TONE_DRAFT[draft.status]),
        html`<button class="btn quiet sm" data-cs-open-draft="${draft.id}">${openDraftId === draft.id ? 'Close' : 'Open'}</button>`,
      ]),
    })}
  </section>`;
}

const STATUS_WORDS_DRAFT = { DRAFTING: 'drafting', IN_REVIEW: 'in review', APPROVED: 'approved', EXECUTED: 'executed', WITHDRAWN: 'withdrawn' };
const STATUS_TONE_DRAFT = { DRAFTING: 'info', IN_REVIEW: 'warn', APPROVED: 'ok', EXECUTED: 'ok', WITHDRAWN: 'neutral' };

/** Where the draft stands in review, and the controls that move it on. */
function reviewPanel(draft, perms) {
  const r = draft.review;
  const legal = draft.legalReasons.length ? html`<div style="margin-top:6px"><b>Legal approval needed:</b> ${draft.legalReasons.join(' ')}</div>` : '';
  const past = draft.pastReviews.length ? html`<details style="margin-top:6px"><summary style="cursor:pointer">${draft.pastReviews.length} earlier review${draft.pastReviews.length === 1 ? '' : 's'}</summary><ul style="margin:4px 0 0 16px">${draft.pastReviews.map((entry) => html`<li>Revision ${entry.revision}: ${entry.how === 'RETURNED' ? 'returned' : 'reopened after approval — approvals void'} by ${entry.byName} ${date(entry.at)}: ${entry.note}</li>`)}</ul></details>` : '';
  if (draft.status === 'DRAFTING') {
    return html`<div style="margin:8px 0;display:flex;gap:8px;flex-wrap:wrap;align-items:center" data-cs-review>
      ${perms.update && draft.blocking === 0 ? html`<button class="btn sm" data-command="cs-submit" data-draft="${draft.id}">Put up for review</button>` : html`<span class="metric-sub">Put up for review once nothing blocks it.</span>`}
    </div>${draft.legalReasons.length || draft.pastReviews.length ? notice(html`<div style="min-width:0">${legal}${past}</div>`, 'info') : ''}`;
  }
  if (!r) return '';
  const approvals = r.approvals.length ? r.approvals.map((approval) => html`<div>${approval.scope === 'COMMERCIAL' ? 'Commercial' : 'Legal'} approval: ${approval.byName}, ${date(approval.at)} — ${approval.note}</div>`) : html`<div>No approval yet.</div>`;
  const hasScope = (scope) => r.approvals.some((approval) => approval.scope === scope);
  const controls = [];
  if (draft.status === 'IN_REVIEW' && perms.approve) {
    if (!hasScope('COMMERCIAL')) controls.push(html`<button class="btn sm" data-command="cs-approve" data-draft="${draft.id}" data-scope="COMMERCIAL">Approve — commercial</button>`);
    if (r.legalRequired && !hasScope('LEGAL')) controls.push(html`<button class="btn sm" data-command="cs-approve" data-draft="${draft.id}" data-scope="LEGAL">Approve — legal</button>`);
    controls.push(html`<button class="btn quiet sm" data-command="cs-return" data-draft="${draft.id}">Return</button>`);
  }
  if (draft.status === 'APPROVED' || draft.status === 'EXECUTED') {
    controls.push(html`<button class="btn sm" data-cs-pack="PDF" data-draft="${draft.id}">Download the pack (PDF)</button> <button class="btn quiet sm" data-cs-pack="DOCX" data-draft="${draft.id}">Word</button>`);
  }
  if (draft.status === 'APPROVED') {
    if (perms.approve) controls.push(html`<button class="btn sm" data-command="cs-execute" data-draft="${draft.id}">Record the signed contract</button>`);
    if (perms.update) controls.push(html`<button class="btn quiet sm" data-command="cs-reopen" data-draft="${draft.id}">Reopen to change</button>`);
  }
  return html`${notice(
    html`<div style="min-width:0"><b>${draft.status === 'IN_REVIEW' ? 'In review' : draft.status === 'APPROVED' ? 'Approved' : 'Executed'}:</b> revision ${r.revision}, put up by ${r.submittedByName} ${date(r.submittedAt)} · <span class="mono" style="font-size:11px;word-break:break-all">${r.hash}</span>
      <div style="margin-top:6px">${approvals}</div>${legal}
      ${draft.executed ? html`<div style="margin-top:6px"><b>Signed</b> ${draft.executed.executedOn} (${draft.executed.signatureMethod}). The contract is in the register on Change & Claims.</div>` : ''}
      ${draft.status === 'APPROVED' && draft.handoffMissing.length ? html`<div style="margin-top:6px">The contract register will need ${draft.handoffMissing.join(', ')}.</div>` : ''}${past}</div>`,
    draft.status === 'IN_REVIEW' ? 'warn' : 'ok',
  )}<div style="margin:8px 0;display:flex;gap:8px;flex-wrap:wrap" data-cs-review>${controls}</div>`;
}

function draftCard(draft, perms) {
  const editable = perms.update && draft.status === 'DRAFTING';
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="cs-draft-h" data-cs-draft="${draft.id}">
    <h2 id="cs-draft-h">${draft.reference} ${draft.title} ${badge('revision ' + draft.revision, 'info')} ${badge(STATUS_WORDS_DRAFT[draft.status], STATUS_TONE_DRAFT[draft.status])}
      ${editable ? html`<button class="btn quiet sm" data-command="cs-prefill" data-draft="${draft.id}">Read the project documents (AI)</button> <button class="btn quiet sm" data-command="cs-withdraw" data-draft="${draft.id}">Withdraw</button>` : ''}</h2>
    <p class="metric-sub">${draft.formLabel} · ${draft.schedule.title} · in ${draft.currency}${draft.selection?.reasons?.length ? ' · chosen because: ' + draft.selection.reasons.join(' ') : ''}</p>
    ${draft.schedule.ownSchedule ? '' : notice('This form has no schedule of its own yet. The general particulars are recorded against it; they are a record of what was agreed, not a completed form.', 'info')}
    ${draft.withdrawn ? notice(html`Withdrawn ${date(draft.withdrawn.at)}: ${draft.withdrawn.reason}`, 'warn') : ''}
    ${reviewPanel(draft, perms)}
    ${draft.status === 'DRAFTING' ? prefillNotice(draft) : ''}
    ${draft.status === 'DRAFTING' ? draftNotice(draft) : ''}
    ${draft.groups.map(
      (group) => html`<h3 style="margin:16px 0 6px;font-size:14px">${GROUP_WORDS[group.group] ?? humanise(group.group)}</h3>
        ${table({
          headers: ['Particular', 'Value', 'Source', ''],
          rows: group.fields.map((field) => [
            html`${field.label}${field.required ? '' : html` <span class="metric-sub">optional</span>`}${field.highRisk ? html` ${badge('moves money or time', 'warn')}` : ''}${field.help ? html`<br><span class="metric-sub">${field.help}</span>` : ''}`,
            field.display !== null
              ? html`<b>${field.display}</b>${field.findings.length ? html`<br>${field.findings.map((finding) => badge(finding.message, finding.severity === 'BLOCKING' ? 'bad' : 'warn'))}` : ''}${candidatesOf(draft, field, editable)}`
              : html`${field.required ? badge('required', 'warn') : html`<span class="metric-sub">not completed</span>`}${field.findings.some((finding) => finding.code !== 'FIELD_MISSING') ? html`<br>${field.findings.filter((finding) => finding.code !== 'FIELD_MISSING').map((finding) => badge(finding.message, 'bad'))}` : ''}${candidatesOf(draft, field, editable)}`,
            field.source
              ? html`<span class="metric-sub">${field.source.kind === 'MANUAL' ? 'entered by ' + field.setBy : field.source.filename + ', ' + field.source.locator}${field.setAt ? ' · ' + date(field.setAt) : ''}${field.note ? ' · ' + field.note : ''}</span>`
              : '—',
            editable
              ? html`<button class="btn quiet sm" data-command="cs-field" data-draft="${draft.id}" data-key="${field.key}">${field.value === null ? 'Complete' : 'Change'}</button>${
                  field.value !== null ? html` <button class="btn quiet sm" data-command="cs-clear" data-draft="${draft.id}" data-key="${field.key}">Clear</button>` : ''
                }`
              : '',
          ]),
        })}`,
    )}
  </section>`;
}

/** What the agent proposed for one particular: each value with its passage, side by side where the documents disagree. */
function candidatesOf(draft, field, editable) {
  const list = field.candidates ?? [];
  if (!list.length) return '';
  return html`<div style="margin-top:6px;display:flex;flex-direction:column;gap:6px" data-cs-candidates="${field.key}">
    ${field.conflict ? badge('the documents disagree', 'bad') : ''}
    ${list.map(
      (candidate) => html`<div style="border-left:2px solid var(--line, #444);padding-left:8px;font-size:12.5px">
        Proposed: <b>${candidate.display}</b> ${candidate.inDraft ? badge('in the draft', 'ok') : editable ? html`<button class="btn quiet sm" data-command="cs-accept" data-draft="${draft.id}" data-candidate="${candidate.id}">Use this</button>` : ''}
        ${candidate.supports.map((support) => html`<div class="metric-sub">${support.filename}, ${support.locator}: “${support.quote}”</div>`)}
      </div>`,
    )}
  </div>`;
}

/** What the latest pre-fill read, held back and could not find. */
function prefillNotice(draft) {
  const p = draft.prefill;
  if (!p) return '';
  return notice(
    html`<div style="min-width:0"><b>Read by the agent ${date(p.proposedAt)}</b> (asked by ${p.requestedBy}, at revision ${p.draftRevision}): ${p.proposed} value${p.proposed === 1 ? '' : 's'} proposed from ${p.documents.map((doc) => doc.filename).join(', ')}${p.conflicts ? html` — ${badge(p.conflicts + ' in conflict', 'bad')}` : ''}. Nothing is in the draft until you choose it.
      ${p.heldBack.length ? html`<div style="margin-top:6px"><b>Not sent:</b> ${p.heldBack.map((doc) => doc.filename + ' — ' + doc.reason).join(' ')}</div>` : ''}
      ${p.omitted.length ? html`<div style="margin-top:6px"><b>Left out:</b> ${p.omitted.map((doc) => doc.filename + ' — ' + doc.reason).join(' ')}</div>` : ''}
      ${p.dropped.length ? html`<details style="margin-top:6px"><summary style="cursor:pointer">${p.dropped.length} answer${p.dropped.length === 1 ? '' : 's'} dropped by the checks</summary><ul style="margin:4px 0 0 16px">${p.dropped.map((entry) => html`<li>${entry.fieldKey}: ${entry.reason}</li>`)}</ul></details>` : ''}
      ${p.questions.length ? html`<details style="margin-top:6px"><summary style="cursor:pointer">${p.questions.length} question${p.questions.length === 1 ? '' : 's'} to settle</summary><ul style="margin:4px 0 0 16px">${p.questions.map((question) => html`<li>${question}</li>`)}</ul></details>` : ''}</div>`,
    p.conflicts ? 'warn' : 'info',
  );
}

/** What stands between the draft and approval: the missing particulars counted, everything else said. */
function draftNotice(draft) {
  const missing = draft.findings.filter((finding) => finding.code === 'FIELD_MISSING').length;
  const other = draft.findings.filter((finding) => finding.code !== 'FIELD_MISSING');
  if (!missing && !other.length) return notice('Every required particular is completed and nothing conflicts.', 'ok');
  return notice(
    html`<div style="min-width:0"><b>Before it can be approved:</b>${missing ? html` ${missing} required particular${missing === 1 ? ' is' : 's are'} not completed (marked below).` : ''}${
      other.length ? html`<ul style="margin:6px 0 0 16px">${other.map((finding) => html`<li>${finding.severity === 'WARNING' ? 'Note: ' : ''}${finding.message}</li>`)}</ul>` : ''
    }</div>`,
    draft.blocking ? 'warn' : 'info',
  );
}

function shortlistCard(perms) {
  if (!shortlist) return '';
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="cs-short-h" data-cs-shortlist>
    <h2 id="cs-short-h">Forms that suit the job <button class="btn quiet sm" data-cs-clear-shortlist>Dismiss</button></h2>
    <p class="metric-sub">${shortlist.note}</p>
    ${shortlist.missing.length ? notice('Say ' + shortlist.missing.map((key) => humanise(key).toLowerCase()).join(', ') + ' for a sharper shortlist.', 'info') : ''}
    ${table({
      headers: ['Form', 'Why', ''],
      empty: 'No form matched what was described',
      emptyDetail: 'Browse the catalogue below instead.',
      rows: shortlist.recommendations.map((entry) => [
        html`<b>${entry.label}</b>${entry.ownSchedule ? html`<br>${badge('own schedule', 'ok')}` : ''}`,
        html`<span style="font-size:12.5px">${entry.reasons.join(' ')}</span>`,
        perms.create ? html`<button class="btn quiet sm" data-command="cs-open" data-form="${entry.key}">Draft on this</button>` : '',
      ]),
    })}
  </section>`;
}

function catalogueCard(view, perms) {
  const publishers = [...new Set(view.catalogue.map((entry) => entry.publisher))];
  const q = filter.q.trim().toLowerCase();
  const shown = view.catalogue.filter((entry) => (!filter.publisher || entry.publisher === filter.publisher) && (!q || (entry.publisher + ' ' + entry.code + ' ' + entry.title + ' ' + entry.edition).toLowerCase().includes(q)));
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="cs-cat-h" data-cs-catalogue>
    <h2 id="cs-cat-h">Form catalogue ${badge(view.catalogue.length + ' forms', 'neutral')}</h2>
    <p class="metric-sub">The UK published forms by exact edition — what each is, never its wording. An entry marked “edition to confirm” is a family or an earlier-editions route: name the exact issue before drafting on it.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0">
      <label class="metric-sub" style="display:flex;gap:6px;align-items:center">Publisher
        <select data-cs-publisher><option value="">All</option>${publishers.map((publisher) => html`<option value="${publisher}" ${filter.publisher === publisher ? 'selected' : ''}>${publisher}</option>`)}</select></label>
      <label class="metric-sub" style="display:flex;gap:6px;align-items:center">Search
        <input type="search" data-cs-search value="${filter.q}" placeholder="Design and Build, ECC, Yellow…" /></label>
    </div>
    ${table({
      headers: ['Form', 'Edition', 'Kind', 'Status', ''],
      empty: 'No form matches',
      rows: shown.map((entry) => [
        html`<b>${entry.publisher} ${entry.code}</b> ${entry.title}${entry.ownSchedule ? html` ${badge('own schedule', 'ok')}` : ''}`,
        entry.edition,
        humanise(entry.type),
        badge(STATUS_WORDS[entry.status], STATUS_TONE[entry.status]),
        perms.create && entry.draftable ? html`<button class="btn quiet sm" data-command="cs-open" data-form="${entry.key}">Draft on this</button>` : '',
      ]),
    })}
  </section>`;
}

function fieldControl(field) {
  if (field.type === 'CHOICE') return { type: 'select', options: field.options, value: field.value ?? '' };
  if (field.type === 'DATE') return { type: 'date', value: field.value ?? '' };
  if (field.type === 'TEXT') return { type: 'textarea', rows: 3, value: field.value ?? '' };
  return { type: 'text', value: field.display ?? '', placeholder: PLACEHOLDER[field.type] ?? '' };
}

export async function contractstudio(root) {
  const projectId = state.session.projectId;
  let view;
  try {
    view = await api.get(`/v1/projects/${projectId}/contract-studio`);
  } catch (error) {
    render(root, html`<div class="view-head"><div><h1>Contracts Studio</h1></div></div>${notice(`Contracts Studio could not be read: ${error.message ?? String(error)}`, 'err')}`);
    return;
  }
  const perms = { read: can('CONTRACTS_CLAIMS', 'R'), create: can('CONTRACTS_CLAIMS', 'C'), update: can('CONTRACTS_CLAIMS', 'U'), approve: can('CONTRACTS_CLAIMS', 'A') };
  const open = view.drafts.find((draft) => draft.id === openDraftId);
  if (!open) openDraftId = null;

  render(
    root,
    html`<div class="view-head"><div><h1>Contracts Studio</h1>
        <p class="metric-sub">Choose the form, pin its edition, and complete its particulars — each value with where it came from.</p></div></div>
      ${shortlistCard(perms)}
      ${draftsCard(view, perms)}
      ${open ? draftCard(open, perms) : ''}
      ${catalogueCard(view, perms)}`,
  );

  const draftOf = (button) => view.drafts.find((draft) => draft.id === button.dataset.draft);
  const fieldOf = (draft, key) => draft.groups.flatMap((group) => group.fields).find((field) => field.key === key);
  const draftable = view.catalogue.filter((entry) => entry.draftable);
  const v = view.vocabulary;

  const COMMANDS = {
    'cs-select': () => ({
      title: 'Find the right form',
      intent: 'Describe the job. The shortlist comes with the reason for each form; you confirm the form and its edition.',
      path: `/v1/projects/${projectId}/contract-studio/selection`,
      submitLabel: 'Show the shortlist',
      fields: [
        { name: 'package', label: 'What is being bought', type: 'select', options: optionsOf(v.packages) },
        { name: 'design', label: 'Who designs it', type: 'select', required: false, placeholder: 'Not relevant', options: optionsOf(v.design) },
        { name: 'pricing', label: 'How it is priced', type: 'select', required: false, placeholder: 'Not decided', options: optionsOf(v.pricing) },
        { name: 'valueBand', label: 'Size', type: 'select', required: false, placeholder: 'Not decided', options: [
          { value: 'SMALL', label: 'Small — minor works' },
          { value: 'MEDIUM', label: 'Medium' },
          { value: 'LARGE', label: 'Large' },
          { value: 'MAJOR', label: 'Major project' },
        ] },
        { name: 'preferredSuite', label: 'Preferred suite', type: 'select', required: false, placeholder: 'No preference', options: optionsOf(v.suites) },
        { name: 'international', label: 'International works', type: 'checkbox', required: false },
        { name: 'tenderNamedFormKey', label: 'The form the tender names (if any)', type: 'select', required: false, placeholder: 'None named', options: draftable.map((entry) => ({ value: entry.key, label: entry.publisher + ' ' + entry.code + ' ' + entry.title + ' (' + entry.edition + ')' })) },
      ],
      transform: (values) => {
        asked = values;
        return values;
      },
      report: (result) => {
        shortlist = { ...result, input: asked };
        return { title: 'Shortlist ready', message: result.recommendations.length + ' form(s) suggested, with the reason for each.', tone: 'ok' };
      },
    }),
    'cs-open': (button) => {
      const chosen = button.dataset.form ? view.catalogue.find((entry) => entry.key === button.dataset.form) : null;
      return {
        title: chosen ? 'Open a draft on ' + chosen.publisher + ' ' + chosen.code : 'Open a contract draft',
        intent: 'Type the edition exactly as shown, to confirm which issue of the form this draft completes.',
        path: `/v1/projects/${projectId}/contract-studio/drafts`,
        submitLabel: 'Open the draft',
        fields: [
          chosen
            ? { name: 'formKey', type: 'hidden', value: chosen.key }
            : { name: 'formKey', label: 'Form', type: 'select', options: draftable.map((entry) => ({ value: entry.key, label: entry.publisher + ' ' + entry.code + ' ' + entry.title + ' (' + entry.edition + ')' })) },
          { name: 'confirmEdition', label: chosen ? 'Edition — type “' + chosen.edition + '”' : 'Edition, exactly as the form shows it', type: 'text' },
          { name: 'title', label: 'What the contract is for', type: 'text', placeholder: 'Main contract — depot refurbishment' },
          { name: 'currency', label: 'Currency', type: 'select', options: v.currencies.map((code) => ({ value: code, label: code })), value: 'GBP' },
        ],
        transform: (values) => ({ ...values, ...(shortlist?.input ? { selection: shortlist.input } : {}) }),
        report: (result) => {
          openDraftId = result.id;
          return { title: 'Draft opened', message: result.reference + ' is open on ' + result.form.publisher + ' ' + result.form.code + ' (' + result.form.edition + ').', tone: 'ok' };
        },
      };
    },
    'cs-field': (button) => {
      const draft = draftOf(button);
      const field = fieldOf(draft, button.dataset.key);
      return {
        title: field.label,
        intent: (field.help ? field.help + ' ' : '') + (field.source && field.source.kind !== 'MANUAL' ? 'This value came from ' + field.source.filename + '; say why you are replacing it.' : ''),
        path: `/v1/projects/${projectId}/contract-studio/drafts/${draft.id}/fields`,
        submitLabel: 'Save',
        fields: [
          { name: 'value', label: 'Value', ...fieldControl(field) },
          { name: 'note', label: 'Note (why, or where it comes from)', type: 'text', required: false },
        ],
        transform: (values) => ({ key: field.key, value: values.value, ...(values.note ? { note: values.note } : {}), expectedRevision: draft.revision }),
      };
    },
    'cs-clear': (button) => {
      const draft = draftOf(button);
      const field = fieldOf(draft, button.dataset.key);
      return {
        title: 'Clear ' + field.label,
        intent: 'The value is removed in a new revision; the earlier revision keeps it.',
        path: `/v1/projects/${projectId}/contract-studio/drafts/${draft.id}/fields`,
        submitLabel: 'Clear it',
        fields: [{ name: 'note', label: 'Why (optional)', type: 'text', required: false }],
        transform: (values) => ({ key: field.key, value: null, ...(values.note ? { note: values.note } : {}), expectedRevision: draft.revision }),
      };
    },
    'cs-prefill': (button) => {
      const draft = draftOf(button);
      const docs = Array.isArray(view.documents) ? view.documents : [];
      return {
        title: 'Read the project documents',
        intent:
          'The agent reads the project’s own read documents and proposes each particular it finds, quoting the passage. Nothing goes into the draft until you choose it. ' +
          'A document carrying a publisher’s copyright notice (a copy of an NEC, JCT or FIDIC form) is not sent.',
        path: `/v1/projects/${projectId}/contract-studio/drafts/${draft.id}/prefill`,
        ai: true,
        submitLabel: 'Read them',
        fields: [
          {
            name: 'ingestionIds',
            label: 'Documents to read (none ticked: all of them)',
            type: 'multiselect',
            required: false,
            options: docs.map((doc) => ({ value: doc.ingestionId, label: doc.filename + (doc.heldBack ? ' — not sent: ' + doc.heldBack : '') })),
          },
        ],
        report: (result) => ({
          title: 'Read',
          message: result.proposed + ' value(s) proposed, ' + result.conflicts + ' in conflict, ' + result.dropped + ' dropped by the checks' + (result.heldBack ? ', ' + result.heldBack + ' document(s) not sent' : '') + '. Choose the ones to use.',
          tone: result.conflicts ? 'warn' : 'ok',
        }),
      };
    },
    'cs-accept': (button) => {
      const draft = draftOf(button);
      const field = draft.groups.flatMap((group) => group.fields).find((entry) => (entry.candidates ?? []).some((candidate) => candidate.id === button.dataset.candidate));
      const candidate = field.candidates.find((entry) => entry.id === button.dataset.candidate);
      return {
        title: 'Use this for ' + field.label,
        intent: field.conflict ? 'The documents disagree on this particular. Say why this value is the one.' : 'The value goes into the draft with its source.',
        brief: candidate.supports.map((support) => '<p><b>' + escape(support.filename) + '</b>, ' + escape(support.locator) + ':<br>“' + escape(support.quote) + '”</p>').join(''),
        path: `/v1/projects/${projectId}/contract-studio/drafts/${draft.id}/accept`,
        submitLabel: 'Use ' + candidate.display,
        fields: [{ name: 'note', label: field.conflict ? 'Why this value' : 'Note (optional)', type: 'text', required: Boolean(field.conflict) }],
        transform: (values) => ({ prefillId: draft.prefill.id, candidateId: candidate.id, ...(values.note ? { note: values.note } : {}), expectedRevision: draft.revision }),
      };
    },
    'cs-submit': (button) => {
      const draft = draftOf(button);
      return {
        title: 'Put ' + draft.reference + ' up for review',
        intent: 'Revision ' + draft.revision + ' is fixed for review. It changes again only if it is returned, or reopened after approval — which voids the approvals.',
        path: `/v1/projects/${projectId}/contract-studio/drafts/${draft.id}/submit`,
        submitLabel: 'Put it up',
        fields: [{ name: 'expectedRevision', type: 'hidden', value: String(draft.revision) }],
        transform: () => ({ expectedRevision: draft.revision }),
      };
    },
    'cs-approve': (button) => {
      const draft = draftOf(button);
      const scope = button.dataset.scope;
      const rows = draft.groups.flatMap((group) => group.fields).filter((field) => field.display !== null);
      return {
        title: (scope === 'LEGAL' ? 'Legal' : 'Commercial') + ' approval of ' + draft.reference,
        intent: 'You approve revision ' + draft.review.revision + ' exactly as below. If it has changed since you opened it, the approval is refused.',
        brief:
          '<table style="width:100%;font-size:12.5px;border-collapse:collapse">' +
          rows.map((field) => '<tr><td style="padding:3px 6px 3px 0;vertical-align:top">' + escape(field.label) + '</td><td style="padding:3px 0"><b>' + escape(field.display) + '</b></td></tr>').join('') +
          '</table>' +
          (scope === 'LEGAL' && draft.legalReasons.length ? '<p><b>Why legal review:</b> ' + escape(draft.legalReasons.join(' ')) + '</p>' : ''),
        path: `/v1/projects/${projectId}/contract-studio/drafts/${draft.id}/approve`,
        submitLabel: 'Approve',
        fields: [{ name: 'note', label: 'What you checked', type: 'textarea', rows: 2 }],
        transform: (values) => ({ scope, revisionHash: draft.review.hash, note: values.note }),
      };
    },
    'cs-return': (button) => {
      const draft = draftOf(button);
      return {
        title: 'Return ' + draft.reference,
        intent: 'Back to drafting; any approval given is set aside with the review.',
        path: `/v1/projects/${projectId}/contract-studio/drafts/${draft.id}/return`,
        submitLabel: 'Return it',
        fields: [{ name: 'note', label: 'What needs to change', type: 'textarea', rows: 2 }],
      };
    },
    'cs-reopen': (button) => {
      const draft = draftOf(button);
      return {
        title: 'Reopen ' + draft.reference,
        intent: 'Its approvals are voided and kept on the record as voided. The changed draft is approved again before it is issued or signed.',
        path: `/v1/projects/${projectId}/contract-studio/drafts/${draft.id}/reopen`,
        submitLabel: 'Reopen',
        fields: [{ name: 'reason', label: 'What is to change', type: 'text' }],
      };
    },
    'cs-execute': (button) => {
      const draft = draftOf(button);
      return {
        title: 'Record the signed contract for ' + draft.reference,
        intent: 'The signed copy is kept as evidence by its hash. The contract is then created in the register on Change & Claims from the approved particulars, and executed there.',
        path: `/v1/projects/${projectId}/contract-studio/drafts/${draft.id}/execute`,
        submitLabel: 'Record it',
        fields: [
          { name: 'signedDocumentHash', label: 'The signed contract', type: 'file', voice: false },
          { name: 'signatureMethod', label: 'How it was signed', type: 'text', placeholder: 'Executed as a deed; wet ink' },
          { name: 'executedOn', label: 'Signed on', type: 'date' },
        ],
      };
    },
    'cs-withdraw': (button) => {
      const draft = draftOf(button);
      return {
        title: 'Withdraw ' + draft.reference,
        intent: 'It stays on the record, withdrawn, with your reason.',
        path: `/v1/projects/${projectId}/contract-studio/drafts/${draft.id}/withdraw`,
        submitLabel: 'Withdraw',
        fields: [{ name: 'reason', label: 'Why', type: 'text' }],
      };
    },
  };

  root.addEventListener('click', async (event) => {
    const opener = event.target.closest('[data-cs-open-draft]');
    if (opener) {
      openDraftId = openDraftId === opener.dataset.csOpenDraft ? null : opener.dataset.csOpenDraft;
      await draw();
      return;
    }
    const packButton = event.target.closest('[data-cs-pack]');
    if (packButton) {
      try {
        await api.download(`/v1/projects/${projectId}/contract-studio/drafts/${packButton.dataset.draft}/pack.pdf`, { format: packButton.dataset.csPack });
        toast('Downloaded', 'The completion pack has been saved.', 'ok');
      } catch (error) {
        toast('Not issued', error.message ?? String(error), 'err');
      }
      return;
    }
    if (event.target.closest('[data-cs-clear-shortlist]')) {
      shortlist = null;
      await draw();
      return;
    }
    const button = event.target.closest('[data-command]');
    if (!button) return;
    const make = COMMANDS[button.dataset.command];
    if (!make) return;
    if (await command(make(button, root))) await draw();
  });
  root.querySelector('[data-cs-publisher]')?.addEventListener('change', async (event) => {
    filter = { ...filter, publisher: event.target.value };
    await draw();
  });
  root.querySelector('[data-cs-search]')?.addEventListener('change', async (event) => {
    filter = { ...filter, q: event.target.value };
    await draw();
  });
}
