import { badge, html, humanise, table } from '../lib/ui.js';
import { nameOf, personOptions, plural, standardLabel, standardOptions } from './imscommon.js';

/**
 * The registers on the Management System screen: environmental aspects and
 * impacts with their significance, legal and other requirements with their
 * compliance evaluations, and the objectives.
 */

const RESULT_TONE = { COMPLIANT: 'ok', PARTIAL: 'warn', NON_COMPLIANT: 'bad' };
const OBJECTIVE_TONE = { OPEN: 'info', ACHIEVED: 'ok', NOT_ACHIEVED: 'bad' };

function aspectsCard(view, perms) {
  const { aspects, threshold } = view.registers;
  const active = aspects.filter((aspect) => aspect.status === 'ACTIVE');
  const retired = aspects.filter((aspect) => aspect.status === 'RETIRED');
  const significant = active.filter((aspect) => aspect.significant).length;
  const headers = ['Aspect', 'Condition', 'Score', 'Controls', ''];
  const rows = (list) =>
    list.map((aspect) => [
      html`<b>${aspect.reference}</b> ${aspect.activity}<br><span style="font-size:12.5px">${aspect.aspect} → ${aspect.impact}</span>${aspect.retired ? html`<br><span class="metric-sub">Retired: ${aspect.retired.reason}</span>` : ''}`,
      humanise(aspect.condition).toLowerCase(),
      html`${aspect.severity} × ${aspect.likelihood} = <b>${aspect.score}</b>${aspect.significant ? html`<br>${badge('significant', 'warn')}` : ''}${aspect.legalDriver ? html`<br><span class="metric-sub">legal driver</span>` : ''}`,
      html`<span style="font-size:12px">${aspect.controls}</span>`,
      perms.update && aspect.status === 'ACTIVE'
        ? html`<button class="btn quiet sm" data-command="ims-aspect-revise" data-aspect="${aspect.id}">Reassess</button> <button class="btn quiet sm" data-command="ims-aspect-retire" data-aspect="${aspect.id}">Retire</button>`
        : '',
    ]);
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="ims-asp-h" data-ims-aspects>
    <h2 id="ims-asp-h">Environmental aspects and impacts ${perms.create ? html`<button class="btn quiet sm" data-command="ims-aspect-add">Add an aspect</button>` : ''}</h2>
    <p class="metric-sub">Scored severity × likelihood (each 1–5). Significant at ${threshold} or more, the company’s own threshold, or wherever a legal requirement drives it. ${active.length ? plural(significant, 'significant aspect', 'significant aspects') + ' of ' + active.length + '.' : ''}</p>
    ${table({ headers, empty: 'No aspect recorded', emptyDetail: 'List the activities first — excavation, concrete, refuelling, waste — then the aspect of each.', rows: rows(active) })}
    ${retired.length ? html`<details style="margin-top:10px"><summary style="cursor:pointer;font-size:12.5px">${plural(retired.length, 'retired aspect', 'retired aspects')}</summary>${table({ headers, rows: rows(retired) })}</details>` : ''}
  </section>`;
}

function obligationsCard(view, perms) {
  const list = view.registers.obligations;
  const active = list.filter((entry) => entry.status === 'ACTIVE');
  const withdrawn = list.filter((entry) => entry.status === 'WITHDRAWN');
  const headers = ['Requirement', 'Applies and complied with', 'Last evaluation', 'Next due', ''];
  const rows = (entries) =>
    entries.map((entry) => [
      html`<b>${entry.reference}</b> ${entry.title}<br><span class="metric-sub">${entry.extent} · ${entry.standards.map((id) => standardLabel(view, id)).join(', ')}</span>${entry.withdrawn ? html`<br><span class="metric-sub">Withdrawn: ${entry.withdrawn.reason}</span>` : ''}`,
      html`<details><summary style="cursor:pointer;font-size:12px">${entry.requirement}</summary><p style="font-size:12px;margin:4px 0"><b>Applies:</b> ${entry.applicability}</p><p style="font-size:12px;margin:4px 0"><b>Complied with by:</b> ${entry.howComplied}</p></details>`,
      entry.lastResult
        ? html`${badge(humanise(entry.lastResult).toLowerCase(), RESULT_TONE[entry.lastResult])}<br><span class="metric-sub">${entry.evaluations.at(-1).on}: ${entry.evaluations.at(-1).note}</span>`
        : badge('never evaluated', 'warn'),
      html`${entry.status === 'ACTIVE' ? entry.nextEvaluationDue : '—'}${entry.evaluationDue ? html`<br>${badge('due', 'warn')}` : ''}`,
      perms.update && entry.status === 'ACTIVE'
        ? html`<button class="btn sm" data-command="ims-obligation-evaluate" data-obligation="${entry.id}">Evaluate</button> <button class="btn quiet sm" data-command="ims-obligation-withdraw" data-obligation="${entry.id}">Withdraw</button>`
        : '',
    ]);
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="ims-leg-h" data-ims-obligations>
    <h2 id="ims-leg-h">Legal and other requirements ${perms.create ? html`<button class="btn quiet sm" data-command="ims-obligation-add">Add a requirement</button>` : ''}</h2>
    <p class="metric-sub">What applies, how, and how the company complies; evaluated on a schedule. An evaluation that finds it short raises a corrective action there and then.</p>
    ${table({ headers, empty: 'Nothing in the register', emptyDetail: 'Start from the legislation list, then add permits, consents and client requirements.', rows: rows(active) })}
    ${withdrawn.length ? html`<details style="margin-top:10px"><summary style="cursor:pointer;font-size:12.5px">${plural(withdrawn.length, 'withdrawn requirement', 'withdrawn requirements')}</summary>${table({ headers, rows: rows(withdrawn) })}</details>` : ''}
  </section>`;
}

function objectivesCard(view, perms) {
  const list = view.registers.objectives;
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="ims-obj-h" data-ims-objectives>
    <h2 id="ims-obj-h">Objectives ${perms.create ? html`<button class="btn quiet sm" data-command="ims-objective-set">Set an objective</button>` : ''}</h2>
    ${table({
      headers: ['Objective', 'Measure and target', 'Owner', 'Due', 'Latest', ''],
      empty: 'No objective set',
      emptyDetail: 'Set quality, environmental and OH&S objectives consistent with the policy.',
      rows: list.map((objective) => [
        html`<b>${objective.reference}</b> ${objective.objective}<br><span class="metric-sub">${standardLabel(view, objective.standard)}</span>`,
        html`<span style="font-size:12.5px">${objective.measure}</span><br><span class="metric-sub">target ${objective.target}${objective.baseline ? ' · baseline ' + objective.baseline : ''}</span>`,
        objective.owner,
        html`${objective.dueOn}${objective.overdue ? html`<br>${badge('overdue', 'bad')}` : ''}`,
        html`${badge(humanise(objective.status).toLowerCase(), OBJECTIVE_TONE[objective.status])}${objective.latest ? html`<br><span class="metric-sub">${objective.latest.value} (${objective.latest.on})</span>` : ''}${
          objective.closed ? html`<br><span class="metric-sub">${objective.closed.note}</span>` : ''
        }`,
        html`${perms.update && objective.status === 'OPEN' ? html`<button class="btn quiet sm" data-command="ims-objective-progress" data-objective="${objective.id}">Record progress</button> ` : ''}${
          perms.approve && objective.status === 'OPEN' ? html`<button class="btn quiet sm" data-command="ims-objective-close" data-objective="${objective.id}">Close</button>` : ''
        }`,
      ]),
    })}
  </section>`;
}

export function registerCards(view, perms) {
  return html`${aspectsCard(view, perms)}${obligationsCard(view, perms)}${objectivesCard(view, perms)}`;
}

export function registerCommands(view) {
  const aspectOf = (button) => view.registers.aspects.find((aspect) => aspect.id === button.dataset.aspect);
  const obligationOf = (button) => view.registers.obligations.find((entry) => entry.id === button.dataset.obligation);
  const objectiveOf = (button) => view.registers.objectives.find((entry) => entry.id === button.dataset.objective);
  const scoreOptions = [1, 2, 3, 4, 5].map((value) => ({ value: String(value), label: String(value) }));
  const documentOptions = view.documents.filter((document) => document.status !== 'WITHDRAWN').map((document) => ({ value: document.id, label: `${document.reference} ${document.title}` }));
  const listed = new Set(view.registers.obligations.filter((entry) => entry.status === 'ACTIVE').map((entry) => entry.catalogueKey).filter(Boolean));
  const aspectFields = (aspect) => [
    { name: 'activity', label: 'Activity', type: 'text', value: aspect?.activity ?? '', placeholder: 'Concrete washout' },
    { name: 'aspect', label: 'Aspect', type: 'text', value: aspect?.aspect ?? '', placeholder: 'Alkaline washwater' },
    { name: 'impact', label: 'Impact', type: 'text', value: aspect?.impact ?? '', placeholder: 'Pollution of surface water' },
    { name: 'condition', label: 'Condition', type: 'select', options: view.vocabulary.aspectConditions.map((value) => ({ value, label: humanise(value) })), value: aspect?.condition ?? 'NORMAL' },
    { name: 'severity', label: 'Severity (1–5)', type: 'select', options: scoreOptions, value: String(aspect?.severity ?? 3) },
    { name: 'likelihood', label: 'Likelihood (1–5)', type: 'select', options: scoreOptions, value: String(aspect?.likelihood ?? 3) },
    { name: 'legalDriver', label: 'A legal requirement drives it', type: 'checkbox', value: aspect?.legalDriver ?? false },
    { name: 'controls', label: 'Controls', type: 'textarea', rows: 2, value: aspect?.controls ?? '' },
    { name: 'documentIds', label: 'Procedures (optional)', type: 'multiselect', required: false, options: documentOptions, value: aspect?.documentIds ?? [] },
  ];
  const aspectBody = (v) => ({ ...v, severity: Number(v.severity), likelihood: Number(v.likelihood), documentIds: v.documentIds ?? [] });
  return {
    'ims-aspect-add': () => ({ title: 'Add an aspect', intent: 'One activity, one aspect, one impact, under one condition.', path: '/v1/ims/aspects', submitLabel: 'Add', fields: aspectFields(), transform: aspectBody }),
    'ims-aspect-revise': (button) => {
      const aspect = aspectOf(button);
      return { title: `Reassess ${aspect.reference}`, intent: 'The assessment is replaced and dated today; the earlier one stays on the record.', path: `/v1/ims/aspects/${aspect.id}`, method: 'PUT', submitLabel: 'Save', fields: aspectFields(aspect), transform: aspectBody };
    },
    'ims-aspect-retire': (button) => ({ title: `Retire ${aspectOf(button).reference}`, intent: 'It stays on the register, retired.', path: `/v1/ims/aspects/${button.dataset.aspect}/retire`, submitLabel: 'Retire', fields: [{ name: 'reason', label: 'Why it no longer applies', type: 'text' }] }),
    'ims-obligation-add': () => ({
      title: 'Add a requirement',
      intent: 'Choose from the legislation list, or give the title of a permit, consent, client or other requirement. Say how it applies and how the company complies, in your own words.',
      path: '/v1/ims/obligations',
      submitLabel: 'Add',
      fields: [
        { name: 'catalogueKey', label: 'From the legislation list', type: 'select', required: false, placeholder: 'Not on the list', options: view.vocabulary.legislation.filter((entry) => !listed.has(entry.key)).map((entry) => ({ value: entry.key, label: `${entry.title} (${entry.extent}) — ${entry.topic}` })) },
        { name: 'title', label: 'Or its title', type: 'text', required: false, placeholder: 'Environmental permit EPR/AB1234, Meridian depot' },
        { name: 'extent', label: 'Where it applies (if not on the list)', type: 'text', required: false, placeholder: 'England' },
        { name: 'standards', label: 'Standards (an entry from the list carries its own if none is ticked)', type: 'multiselect', required: false, options: standardOptions(view) },
        { name: 'requirement', label: 'What it requires of the company', type: 'textarea', rows: 2 },
        { name: 'applicability', label: 'How it applies', type: 'textarea', rows: 2 },
        { name: 'howComplied', label: 'How the company complies', type: 'textarea', rows: 2 },
        { name: 'documentIds', label: 'Procedures (optional)', type: 'multiselect', required: false, options: documentOptions },
        { name: 'evaluationMonths', label: 'Evaluate every (months)', type: 'number', min: 1, step: '1', value: 12 },
      ],
      transform: (v) => ({ ...v, standards: v.standards ?? [], documentIds: v.documentIds ?? [], evaluationMonths: Number(v.evaluationMonths ?? 12) }),
    }),
    'ims-obligation-evaluate': (button) => {
      const entry = obligationOf(button);
      return {
        title: `Evaluate compliance: ${entry.reference} ${entry.title}`,
        intent: `Complied with by: ${entry.howComplied}. Partial or not compliant raises a corrective action now — name its owner and due date.`,
        path: `/v1/ims/obligations/${entry.id}/evaluations`,
        submitLabel: 'Record the evaluation',
        fields: [
          { name: 'result', label: 'Result', type: 'select', options: view.vocabulary.evaluationResults.map((value) => ({ value, label: humanise(value) })) },
          { name: 'note', label: 'What was checked and found', type: 'textarea', rows: 3 },
          { name: 'actionOwnerId', label: 'Corrective action owner (if not compliant)', type: 'select', required: false, placeholder: 'Compliant — no action', options: personOptions(view) },
          { name: 'actionDueOn', label: 'Corrective action due (if not compliant)', type: 'date', required: false },
        ],
      };
    },
    'ims-obligation-withdraw': (button) => ({ title: `Withdraw ${obligationOf(button).reference}`, intent: 'It stays on the register, withdrawn.', path: `/v1/ims/obligations/${button.dataset.obligation}/withdraw`, submitLabel: 'Withdraw', fields: [{ name: 'reason', label: 'Why it no longer applies', type: 'text' }] }),
    'ims-objective-set': () => ({
      title: 'Set an objective',
      intent: 'Measurable, with a target, the resources it needs, who is responsible and by when.',
      path: '/v1/ims/objectives',
      submitLabel: 'Set',
      fields: [
        { name: 'standard', label: 'Standard', type: 'select', options: standardOptions(view) },
        { name: 'objective', label: 'Objective', type: 'text', placeholder: 'Reduce waste sent to landfill across all projects' },
        { name: 'measure', label: 'Measured by', type: 'text', placeholder: 'Tonnes to landfill per £100k turnover' },
        { name: 'target', label: 'Target', type: 'text', placeholder: '2.0' },
        { name: 'baseline', label: 'Baseline (optional)', type: 'text', required: false },
        { name: 'resources', label: 'Resources (optional)', type: 'text', required: false },
        { name: 'ownerId', label: 'Owner', type: 'select', options: personOptions(view) },
        { name: 'dueOn', label: 'By', type: 'date' },
      ],
    }),
    'ims-objective-progress': (button) => {
      const objective = objectiveOf(button);
      return { title: `${objective.reference}: progress`, intent: `Measured by ${objective.measure}; target ${objective.target}.`, path: `/v1/ims/objectives/${objective.id}/progress`, submitLabel: 'Record', fields: [{ name: 'value', label: 'Value now', type: 'text' }, { name: 'note', label: 'Where the figure comes from', type: 'text' }] };
    },
    'ims-objective-close': (button) => {
      const objective = objectiveOf(button);
      return {
        title: `Close ${objective.reference}`,
        intent: `Owner ${nameOf(view, objective.ownerId)}; target ${objective.target}.`,
        path: `/v1/ims/objectives/${objective.id}/close`,
        submitLabel: 'Close',
        fields: [
          { name: 'achieved', label: 'Achieved', type: 'checkbox' },
          { name: 'note', label: 'Final figure and what is learned', type: 'textarea', rows: 2 },
        ],
      };
    },
  };
}
