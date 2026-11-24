import { api } from '../lib/api.js';
import { badge, html, humanise, notice, render, table } from '../lib/ui.js';
import { nameOf, personOptions, standardOptions } from './imscommon.js';

/**
 * The company-wide view and management review on the Management System screen.
 *
 * The overview is the company's position for a period, counted from the records
 * across every project. A review freezes that position as its inputs, minutes
 * each one, records its decisions and actions, and is approved by top
 * management.
 */

function positionTable(position) {
  return table({
    headers: ['Input', 'The position'],
    rows: position.inputs.map((input) => [html`<b>${input.title}</b><br><span class="metric-sub">${input.clauses}</span>`, html`<span style="font-size:12.5px">${input.summary}</span>`]),
  });
}

export function overviewCard(view) {
  const figure = (key, name) => view.position.inputs.find((input) => input.key === key)?.figures?.[name] ?? 0;
  const tiles = [
    ['Incidents', figure('incidents', 'incidents'), figure('incidents', 'notReported') ? 'bad' : 'neutral', `${figure('incidents', 'notReported')} RIDDOR report(s) outstanding`],
    ['Open actions', figure('nonconformities', 'actionsOpen'), figure('nonconformities', 'actionsOverdue') ? 'bad' : 'neutral', `${figure('nonconformities', 'actionsOverdue')} past due`],
    ['Audit nonconformities', Number(figure('audits', 'majorNc')) + Number(figure('audits', 'minorNc')), figure('audits', 'majorNc') ? 'bad' : 'neutral', `${figure('audits', 'uncoveredClauses')} clause(s) not covered`],
    ['Compliance', figure('compliance', 'requirements'), figure('compliance', 'nonCompliant') ? 'bad' : figure('compliance', 'due') ? 'warn' : 'neutral', `${figure('compliance', 'due')} due for evaluation`],
    ['Competence gaps', figure('resources', 'gaps'), figure('resources', 'gaps') ? 'bad' : 'neutral', `${figure('resources', 'expiring')} expiring`],
    ['Documents in force', figure('documents', 'inForce'), figure('documents', 'reviewOverdue') ? 'warn' : 'neutral', `${figure('documents', 'acknowledgementsOutstanding')} acknowledgement(s) outstanding`],
  ];
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="ims-ov-h" data-ims-overview>
    <h2 id="ims-ov-h">The company position</h2>
    <p class="metric-sub">Counted from the records across ${view.position.projects} project(s) and the system itself — nothing here is entered.</p>
    <div class="grid g3" style="margin:10px 0">
      ${tiles.map(([label, value, tone, sub]) => html`<div><h3>${label}</h3><p style="margin:4px 0">${badge(String(value), tone)}</p><p class="metric-sub">${sub}</p></div>`)}
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:end;margin:10px 0">
      <label style="font-size:12px">From <input type="date" data-ims-from value="${view.position.period.from}"></label>
      <label style="font-size:12px">To <input type="date" data-ims-to value="${view.position.period.to}"></label>
      <button class="btn quiet sm" data-ims-period>Show this period</button>
    </div>
    <div data-ims-position>${positionTable(view.position)}</div>
  </section>`;
}

export function reviewCard(view, perms, canApproveReview) {
  const register = view.review;
  const draft = register.reviews.find((entry) => entry.status === 'DRAFT');
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="ims-rev-h" data-ims-reviews>
    <h2 id="ims-rev-h">Management review ${perms.create && !draft ? html`<button class="btn quiet sm" data-command="ims-review-open">Open a review</button>` : ''}</h2>
    <p class="metric-sub">Chaired by top management. Opening a review freezes the company position for its period as its inputs; each input is minuted, decisions and actions recorded, and it is approved by top management other than the person who prepared it.${
      register.lastApprovedOn ? ` Last approved review held ${register.lastApprovedOn}; next due by ${register.nextDueBy}.` : ' No review has been approved yet.'
    }</p>
    ${register.reviews.length === 0 ? html`<p class="metric-sub">No review yet.</p>` : ''}
    ${register.reviews
      .slice()
      .reverse()
      .map(
        (review) => html`<div style="border-top:1px solid var(--line);padding-top:10px;margin-top:10px">
          <h3 style="margin:0">${review.reference} ${badge(review.status.toLowerCase(), review.status === 'APPROVED' ? 'ok' : 'warn')}</h3>
          <p class="metric-sub" style="margin:4px 0">Held ${review.heldOn} · period ${review.periodFrom} to ${review.periodTo} · chair ${review.chair} · prepared by ${review.preparer}${review.attendees.length ? ' · ' + review.attendees.join(', ') : ''} · inputs frozen ${review.frozenAt.slice(0, 10)}, <code>${review.inputsHash.replace(/^sha256:/, '').slice(0, 12)}</code>${
            review.approved ? ` · approved by ${nameOf(view, review.approved.by)}: ${review.approved.note}` : ''
          }</p>
          ${table({
            headers: ['Input', 'The position', 'Minuted', ''],
            rows: review.inputs.map((input) => [
              html`<b>${input.title}</b>`,
              html`<span style="font-size:12px">${input.summary}</span>`,
              review.minutes[input.key] ? html`<span style="font-size:12px">${review.minutes[input.key]}</span>` : badge('not yet', 'warn'),
              review.status === 'DRAFT' && perms.update ? html`<button class="btn quiet sm" data-command="ims-review-minute" data-review="${review.id}" data-key="${input.key}" data-minuted="${review.minutes[input.key] ? 'yes' : 'no'}">${review.minutes[input.key] ? 'Change' : 'Minute'}</button>` : '',
            ]),
          })}
          <h4 style="margin:10px 0 4px">Outputs</h4>
          ${
            review.outputs.length
              ? html`<ul style="margin:0 0 0 16px;font-size:12.5px">${review.outputs.map((output) => html`<li>${badge(humanise(output.kind).toLowerCase(), 'info')} ${output.text}${output.actionId ? html` <span class="metric-sub">(${view.actions.find((action) => action.id === output.actionId)?.reference ?? 'action'})</span>` : ''}</li>`)}</ul>`
              : html`<p class="metric-sub">None yet.</p>`
          }
          ${
            review.status === 'DRAFT'
              ? html`<p style="margin:8px 0">${perms.update ? html`<button class="btn quiet sm" data-command="ims-review-output" data-review="${review.id}">Add a decision or action</button> <button class="btn quiet sm" data-command="ims-review-refresh" data-review="${review.id}">Freeze the inputs again</button> ` : ''}${
                  canApproveReview && review.preparedBy !== view.me ? html`<button class="btn sm" data-command="ims-review-approve" data-review="${review.id}">Approve</button>` : ''
                }</p>`
              : ''
          }
        </div>`,
      )}
  </section>`;
}

/** The period picker on the overview: the position for any period, read from the platform. */
export function bindOverview(root) {
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-ims-period]');
    if (!button) return;
    const from = root.querySelector('[data-ims-from]')?.value;
    const to = root.querySelector('[data-ims-to]')?.value;
    const host = root.querySelector('[data-ims-position]');
    if (!host || !from || !to) return;
    try {
      const position = await api.get(`/v1/ims/position?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      render(host, positionTable(position));
    } catch (error) {
      render(host, notice(`The position could not be read: ${error.message ?? String(error)}`, 'err'));
    }
  });
}

export function reviewCommands(view) {
  const reviewOf = (button) => view.review.reviews.find((entry) => entry.id === button.dataset.review);
  const today = new Date().toISOString().slice(0, 10);
  const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
  const chairs = view.people.filter((person) => person.roles.some((role) => view.review.topManagementRoles.includes(role)));
  return {
    'ims-review-open': () => ({
      title: 'Open a management review',
      intent: 'The company position for the period is frozen now as the review’s inputs. The chair is top management.',
      path: '/v1/ims/reviews',
      submitLabel: 'Open it',
      fields: [
        { name: 'periodFrom', label: 'Period from', type: 'date', value: yearAgo },
        { name: 'periodTo', label: 'Period to', type: 'date', value: today },
        { name: 'heldOn', label: 'Held on', type: 'date', value: today },
        { name: 'chairId', label: 'Chair', type: 'select', options: chairs.map((person) => ({ value: person.id, label: person.name })) },
        { name: 'attendees', label: 'Attendees (comma-separated)', type: 'text', required: false },
      ],
      transform: (v) => ({ ...v, attendees: String(v.attendees ?? '').split(',').map((name) => name.trim()).filter(Boolean) }),
    }),
    'ims-review-minute': (button) => {
      const review = reviewOf(button);
      const input = review.inputs.find((entry) => entry.key === button.dataset.key);
      return {
        title: `${review.reference}: ${input.title}`,
        intent: input.summary,
        path: `/v1/ims/reviews/${review.id}/minutes`,
        method: 'PUT',
        submitLabel: 'Minute it',
        fields: [{ name: 'text', label: 'What the review concluded', type: 'textarea', rows: 4, value: review.minutes[input.key] ?? '' }],
        transform: (v) => ({ key: input.key, text: v.text }),
      };
    },
    'ims-review-output': (button) => ({
      title: `${reviewOf(button).reference}: decision or action`,
      intent: 'An improvement, a change to the system, a resource need or a decision. Give it an owner and a date to raise it as an action.',
      path: `/v1/ims/reviews/${button.dataset.review}/outputs`,
      submitLabel: 'Record',
      fields: [
        { name: 'kind', label: 'Kind', type: 'select', options: view.review.outputKinds.map((kind) => ({ value: kind, label: humanise(kind) })) },
        { name: 'text', label: 'The decision or action', type: 'textarea', rows: 3 },
        { name: 'ownerId', label: 'Action owner (optional)', type: 'select', required: false, placeholder: 'A decision only', options: personOptions(view) },
        { name: 'dueOn', label: 'Action due (optional)', type: 'date', required: false },
        { name: 'standards', label: 'Standards (for an action)', type: 'multiselect', required: false, options: standardOptions(view) },
      ],
      transform: (v) => ({ kind: v.kind, text: v.text, ...(v.ownerId && v.dueOn ? { action: { ownerId: v.ownerId, dueOn: v.dueOn, standards: v.standards?.length ? v.standards : ['ISO9001'] } } : {}) }),
    }),
    'ims-review-refresh': (button) => ({
      title: `Freeze ${reviewOf(button).reference}’s inputs again`,
      intent: 'The position for its period is counted again now; minutes already written stay.',
      path: `/v1/ims/reviews/${button.dataset.review}/refresh`,
      submitLabel: 'Freeze again',
      fields: [],
    }),
    'ims-review-approve': (button) => ({
      title: `Approve ${reviewOf(button).reference}`,
      intent: 'Every input must be minuted and at least one output recorded. Once approved it does not change.',
      path: `/v1/ims/reviews/${button.dataset.review}/approve`,
      submitLabel: 'Approve',
      fields: [{ name: 'note', label: 'Conclusion', type: 'text', placeholder: 'The system is suitable, adequate and effective, with the actions recorded' }],
    }),
  };
}
