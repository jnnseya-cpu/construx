import { badge, html, humanise, table } from '../lib/ui.js';
import { nameOf, personOptions, plural, standardOptions } from './imscommon.js';

/**
 * Engagement on the Management System screen: what customers said (complaints
 * and satisfaction), how the emergency arrangements were tested (drills), and
 * what workers raised and were told (consultation).
 *
 * Every list and its lateness is read from `GET /v1/ims` (`engagement`); the
 * screen only lays it out and opens the commands beside each record.
 */

const COMPLAINT_TONE = { OPEN: 'warn', RESPONDED: 'info', CLOSED: 'ok' };
const DRILL_TONE = { PLANNED: 'info', HELD: 'ok', CANCELLED: 'neutral' };
const OUTCOME_TONE = { EFFECTIVE: 'ok', PARTLY_EFFECTIVE: 'warn', NOT_EFFECTIVE: 'bad' };
const today = () => new Date().toISOString().slice(0, 10);
const projectOptions = (view) => view.programme.projects.map((project) => ({ value: project.id, label: project.name }));
const projectField = (view) => ({ name: 'projectId', label: 'On project (optional)', type: 'select', required: false, placeholder: 'Across the company', options: projectOptions(view) });
const optionsOf = (list) => list.map((value) => ({ value, label: humanise(value) }));
const withoutEmpty = (values) => Object.fromEntries(Object.entries(values).filter(([, value]) => value !== '' && value !== undefined && value !== null));

function complaintsCard(view, perms) {
  const e = view.engagement;
  const open = e.complaints.filter((entry) => entry.status !== 'CLOSED');
  const late = e.complaints.filter((entry) => entry.late).length;
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="ims-cmp-h" data-ims-complaints>
    <h2 id="ims-cmp-h">Complaints ${late ? badge(plural(late, 'unanswered after ' + e.answerDays + ' days', 'unanswered after ' + e.answerDays + ' days'), 'bad') : open.length ? badge(open.length + ' open', 'warn') : e.complaints.length ? badge('all closed', 'ok') : ''}
      ${perms.create ? html`<button class="btn quiet sm" data-command="ims-complaint-record">Record a complaint</button>` : ''}</h2>
    <p class="metric-sub">Every complaint from a client, a neighbour or the public, as it was made, with the answer given and its date. A complaint closes only once it has been answered; one that needs a fix raises a corrective action named to it.</p>
    ${table({
      headers: ['Complaint', 'From', 'Owner', 'Status', ''],
      empty: 'No complaint recorded',
      emptyDetail: perms.create ? 'Record each complaint the day it arrives, in the complainant’s words.' : 'The quality lead records complaints as they arrive.',
      rows: e.complaints.map((entry) => [
        html`<b>${entry.reference}</b> ${humanise(entry.category)}<br><span class="metric-sub">${entry.receivedOn} · ${humanise(entry.channel)}${entry.project ? ' · ' + entry.project : ''}</span><br><span style="font-size:12.5px">${entry.description}</span>`,
        entry.from,
        entry.owner,
        html`${badge(entry.status.toLowerCase(), COMPLAINT_TONE[entry.status])}${entry.late ? html` ${badge('late', 'bad')}` : ''}${
          entry.response ? html`<br><span class="metric-sub">answered ${entry.response.on}: ${entry.response.text}</span>` : ''
        }${entry.closed ? html`<br><span class="metric-sub">closed ${entry.closed.on}${entry.closed.satisfied === true ? ' · satisfied' : entry.closed.satisfied === false ? ' · not satisfied' : ''}</span>` : ''}${
          entry.actionId ? html`<br><span class="metric-sub">action ${view.actions.find((action) => action.id === entry.actionId)?.reference ?? 'raised'}</span>` : ''
        }`,
        html`${perms.update && entry.status !== 'CLOSED' ? html`<button class="btn quiet sm" data-command="ims-complaint-respond" data-complaint="${entry.id}">${entry.response ? 'Answer again' : 'Record the answer'}</button>` : ''}${
          perms.create && !entry.actionId && entry.status !== 'CLOSED' ? html` <button class="btn quiet sm" data-command="ims-complaint-action" data-complaint="${entry.id}">Raise an action</button>` : ''
        }${perms.update && entry.status === 'RESPONDED' ? html` <button class="btn quiet sm" data-command="ims-complaint-close" data-complaint="${entry.id}">Close</button>` : ''}`,
      ]),
    })}
  </section>`;
}

function satisfactionCard(view, perms) {
  const e = view.engagement;
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="ims-sat-h" data-ims-satisfaction>
    <h2 id="ims-sat-h">Customer satisfaction ${e.averageSatisfaction !== null ? badge('average ' + e.averageSatisfaction + ' / 5', e.averageSatisfaction >= 4 ? 'ok' : e.averageSatisfaction >= 3 ? 'warn' : 'bad') : ''}
      ${perms.create ? html`<button class="btn quiet sm" data-command="ims-survey-record">Record a survey</button>` : ''}</h2>
    <p class="metric-sub">What clients said when asked: 1 very dissatisfied to 5 very satisfied, with their comments. The average is of every survey recorded.</p>
    ${table({
      headers: ['Client', 'Project', 'Date', 'Score', 'Comments'],
      empty: 'No survey recorded',
      emptyDetail: 'Ask each client at handover, and once a year on long jobs.',
      rows: e.surveys.map((entry) => [html`<b>${entry.client}</b>`, entry.project ?? '—', entry.surveyedOn, html`<b>${entry.score}</b> / 5`, entry.comments]),
    })}
  </section>`;
}

function drillsCard(view, perms) {
  const e = view.engagement;
  const overdue = e.drills.filter((entry) => entry.overdue).length;
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="ims-drl-h" data-ims-drills>
    <h2 id="ims-drl-h">Emergency drills ${overdue ? badge(plural(overdue, 'overdue', 'overdue'), 'bad') : ''}
      ${perms.create ? html`<button class="btn quiet sm" data-command="ims-drill-plan">Plan a drill</button>` : ''}</h2>
    <p class="metric-sub">How the emergency arrangements are tested — evacuation, spill, rescue — and what was learned. A drill that was not fully effective raises an action on its lesson.</p>
    ${table({
      headers: ['Drill', 'Lead', 'Planned', 'Outcome', ''],
      empty: 'No drill planned',
      emptyDetail: perms.create ? 'Plan a fire evacuation and a spill drill for each site, and a rescue drill where people work at height or in confined spaces.' : 'The safety lead plans the drills.',
      rows: e.drills.map((entry) => [
        html`<b>${entry.reference}</b> ${humanise(entry.scenario)}<br><span class="metric-sub">${entry.project ?? 'Company'}</span><br><span style="font-size:12.5px">${entry.description}</span>`,
        entry.lead,
        html`${entry.plannedOn}${entry.overdue ? html`<br>${badge('overdue', 'bad')}` : ''}`,
        entry.held
          ? html`${badge(humanise(entry.held.outcome).toLowerCase(), OUTCOME_TONE[entry.held.outcome])}<br><span class="metric-sub">${entry.held.on} · ${entry.held.participants} took part · ${entry.held.durationMinutes} min</span><br><span style="font-size:12.5px">${entry.held.lessons}</span>${
              entry.held.actionId ? html`<br><span class="metric-sub">action ${view.actions.find((action) => action.id === entry.held.actionId)?.reference ?? 'raised'}</span>` : ''
            }`
          : entry.cancelled
            ? html`${badge('cancelled', DRILL_TONE.CANCELLED)}<br><span class="metric-sub">${entry.cancelled.reason}</span>`
            : badge('planned', DRILL_TONE.PLANNED),
        perms.update && entry.status === 'PLANNED'
          ? html`<button class="btn quiet sm" data-command="ims-drill-held" data-drill="${entry.id}">Record as held</button> <button class="btn quiet sm" data-command="ims-drill-cancel" data-drill="${entry.id}">Cancel</button>`
          : '',
      ]),
    })}
  </section>`;
}

function consultationCard(view, perms) {
  const e = view.engagement;
  const open = e.consultations.filter((entry) => entry.status === 'OPEN').length;
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="ims-con-h" data-ims-consultation>
    <h2 id="ims-con-h">Worker consultation ${open ? badge(open + ' awaiting an answer', 'warn') : ''}
      ${perms.create ? html`<button class="btn quiet sm" data-command="ims-consultation-record">Record a consultation</button>` : ''}</h2>
    <p class="metric-sub">What workers raised — at toolbox talks, the safety committee, forums, surveys, through their representatives — in their words, and what they were told and what was done.</p>
    ${table({
      headers: ['Consultation', 'Took part', 'Raised', 'Answer', ''],
      empty: 'No consultation recorded',
      emptyDetail: 'Record each toolbox talk and committee meeting where workers raised something.',
      rows: e.consultations.map((entry) => [
        html`<b>${entry.reference}</b> ${entry.topic}<br><span class="metric-sub">${entry.on} · ${humanise(entry.method)}${entry.project ? ' · ' + entry.project : ''}</span>`,
        String(entry.participants),
        entry.raised,
        entry.answer ? html`${entry.answer.text}<br><span class="metric-sub">${entry.answer.on} · ${nameOf(view, entry.answer.by)}</span>` : badge('not yet answered', 'warn'),
        perms.update && entry.status === 'OPEN' ? html`<button class="btn quiet sm" data-command="ims-consultation-answer" data-consultation="${entry.id}">Record the answer</button>` : '',
      ]),
    })}
  </section>`;
}

export function engagementCards(view, perms) {
  return html`${complaintsCard(view, perms)}${satisfactionCard(view, perms)}${drillsCard(view, perms)}${consultationCard(view, perms)}`;
}

export function engagementCommands(view) {
  const v = view.engagement.vocabulary;
  const complaintOf = (button) => view.engagement.complaints.find((entry) => entry.id === button.dataset.complaint);
  const drillOf = (button) => view.engagement.drills.find((entry) => entry.id === button.dataset.drill);
  const consultationOf = (button) => view.engagement.consultations.find((entry) => entry.id === button.dataset.consultation);
  return {
    'ims-complaint-record': () => ({
      title: 'Record a complaint',
      intent: 'As it was made, and who will answer it. It shows as late if it is unanswered after ' + view.engagement.answerDays + ' days.',
      path: '/v1/ims/complaints',
      submitLabel: 'Record the complaint',
      fields: [
        { name: 'receivedOn', label: 'Received', type: 'date', value: today() },
        { name: 'from', label: 'From', type: 'text', placeholder: 'The client, a neighbour, a member of the public' },
        { name: 'channel', label: 'Received by', type: 'select', options: optionsOf(v.channels) },
        { name: 'category', label: 'About', type: 'select', options: optionsOf(v.complaintCategories) },
        projectField(view),
        { name: 'description', label: 'The complaint', type: 'textarea', rows: 4 },
        { name: 'ownerId', label: 'Who answers it', type: 'select', options: personOptions(view) },
      ],
      transform: withoutEmpty,
    }),
    'ims-complaint-respond': (button) => {
      const complaint = complaintOf(button);
      return {
        title: `Answer ${complaint.reference}`,
        intent: 'What the complainant was told, and when.',
        path: `/v1/ims/complaints/${complaint.id}/response`,
        submitLabel: 'Record the answer',
        fields: [
          { name: 'respondedOn', label: 'Answered', type: 'date', value: today() },
          { name: 'text', label: 'What they were told', type: 'textarea', rows: 4 },
        ],
      };
    },
    'ims-complaint-action': (button) => {
      const complaint = complaintOf(button);
      return {
        title: `Raise an action on ${complaint.reference}`,
        intent: 'A corrective action named to the complaint. Leave the description empty to use the complaint’s own words.',
        path: `/v1/ims/complaints/${complaint.id}/action`,
        submitLabel: 'Raise the action',
        fields: [
          { name: 'ownerId', label: 'Owner', type: 'select', options: personOptions(view) },
          { name: 'dueOn', label: 'Due', type: 'date' },
          { name: 'standards', label: 'Standards (optional)', type: 'multiselect', required: false, options: standardOptions(view) },
          { name: 'description', label: 'What is to be done (optional)', type: 'textarea', rows: 3, required: false },
        ],
        transform: withoutEmpty,
      };
    },
    'ims-complaint-close': (button) => {
      const complaint = complaintOf(button);
      return {
        title: `Close ${complaint.reference}`,
        intent: 'Say why it can be closed, and whether the complainant was satisfied if you know.',
        path: `/v1/ims/complaints/${complaint.id}/close`,
        submitLabel: 'Close it',
        fields: [
          { name: 'note', label: 'Why it can be closed', type: 'textarea', rows: 3 },
          {
            name: 'satisfied',
            label: 'Was the complainant satisfied?',
            type: 'select',
            required: false,
            placeholder: 'Not known',
            options: [
              { value: 'yes', label: 'Yes' },
              { value: 'no', label: 'No' },
            ],
          },
        ],
        transform: (values) => ({ note: values.note, satisfied: values.satisfied === 'yes' ? true : values.satisfied === 'no' ? false : null }),
      };
    },
    'ims-survey-record': () => ({
      title: 'Record a satisfaction survey',
      intent: '1 very dissatisfied · 2 dissatisfied · 3 neither · 4 satisfied · 5 very satisfied.',
      path: '/v1/ims/satisfaction',
      submitLabel: 'Record the survey',
      fields: [
        { name: 'client', label: 'Client', type: 'text' },
        projectField(view),
        { name: 'surveyedOn', label: 'Answered', type: 'date', value: today() },
        { name: 'score', label: 'Score', type: 'select', options: [1, 2, 3, 4, 5].map((value) => ({ value: String(value), label: String(value) })), value: '4' },
        { name: 'comments', label: 'What they said', type: 'textarea', rows: 3 },
      ],
      transform: (values) => ({ ...withoutEmpty(values), score: Number(values.score) }),
    }),
    'ims-drill-plan': () => ({
      title: 'Plan an emergency drill',
      intent: 'What is tested, where, and who leads it.',
      path: '/v1/ims/drills',
      submitLabel: 'Plan the drill',
      fields: [
        { name: 'scenario', label: 'Scenario', type: 'select', options: optionsOf(v.drillScenarios) },
        { name: 'description', label: 'What is tested', type: 'textarea', rows: 3, placeholder: 'The plan, the place, the people' },
        projectField(view),
        { name: 'plannedOn', label: 'Planned for', type: 'date' },
        { name: 'leadId', label: 'Lead', type: 'select', options: personOptions(view) },
      ],
      transform: withoutEmpty,
    }),
    'ims-drill-held': (button) => {
      const drill = drillOf(button);
      return {
        title: `Record ${drill.reference} as held`,
        intent: 'If it was not fully effective, name who acts on the lesson and by when — that raises the action.',
        path: `/v1/ims/drills/${drill.id}/held`,
        submitLabel: 'Record the drill',
        fields: [
          { name: 'heldOn', label: 'Held', type: 'date', value: today() },
          { name: 'participants', label: 'How many took part', type: 'number', step: '1' },
          { name: 'durationMinutes', label: 'How long (minutes)', type: 'number', step: '1' },
          { name: 'outcome', label: 'Outcome', type: 'select', options: optionsOf(['EFFECTIVE', 'PARTLY_EFFECTIVE', 'NOT_EFFECTIVE']) },
          { name: 'lessons', label: 'What was learned', type: 'textarea', rows: 3 },
          { name: 'actionOwnerId', label: 'Who acts on the lesson (if not fully effective)', type: 'select', required: false, placeholder: 'No action', options: personOptions(view) },
          { name: 'actionDueOn', label: 'By when', type: 'date', required: false },
        ],
        transform: (values) => ({ ...withoutEmpty(values), participants: Number(values.participants), durationMinutes: Number(values.durationMinutes) }),
      };
    },
    'ims-drill-cancel': (button) => {
      const drill = drillOf(button);
      return {
        title: `Cancel ${drill.reference}`,
        intent: 'It stays on the record, cancelled, with your reason.',
        path: `/v1/ims/drills/${drill.id}/cancel`,
        submitLabel: 'Cancel the drill',
        fields: [{ name: 'reason', label: 'Why, and when it is re-planned', type: 'text' }],
      };
    },
    'ims-consultation-record': () => ({
      title: 'Record a consultation',
      intent: 'What the workers raised, in their words. It stays open until they are told what was done.',
      path: '/v1/ims/consultations',
      submitLabel: 'Record it',
      fields: [
        { name: 'on', label: 'Held', type: 'date', value: today() },
        { name: 'method', label: 'How', type: 'select', options: optionsOf(v.consultationMethods) },
        { name: 'topic', label: 'About', type: 'text' },
        projectField(view),
        { name: 'participants', label: 'How many workers took part', type: 'number', step: '1' },
        { name: 'raised', label: 'What they raised', type: 'textarea', rows: 4 },
      ],
      transform: (values) => ({ ...withoutEmpty(values), participants: Number(values.participants) }),
    }),
    'ims-consultation-answer': (button) => {
      const consultation = consultationOf(button);
      return {
        title: `Answer ${consultation.reference}`,
        intent: 'What the workers were told and what was done.',
        path: `/v1/ims/consultations/${consultation.id}/answer`,
        submitLabel: 'Record the answer',
        fields: [
          { name: 'answeredOn', label: 'Told', type: 'date', value: today() },
          { name: 'text', label: 'What they were told and what was done', type: 'textarea', rows: 4 },
        ],
      };
    },
  };
}
