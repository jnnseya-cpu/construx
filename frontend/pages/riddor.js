import { api } from '../lib/api.js';
import { command } from '../lib/command.js';
import { badge, html, humanise, notice, table } from '../lib/ui.js';
import { draw } from '../app.js';

/**
 * The RIDDOR clock on the Risk & Safety screen: every reportable incident on the
 * project, the kind of report a competent person classified it as, when the
 * report is due, and the report made — late shown as late.
 */

const STATUS_TONE = { UNCLASSIFIED: 'bad', DUE: 'warn', OVERDUE: 'bad', REPORTED: 'ok', REPORTED_LATE: 'warn' };
const STATUS_WORDS = { UNCLASSIFIED: 'kind not recorded', DUE: 'report due', OVERDUE: 'report overdue', REPORTED: 'reported', REPORTED_LATE: 'reported late' };

export function loadRiddor(projectId) {
  return api.get(`/v1/projects/${projectId}/safety/riddor`).catch((error) => ({ error }));
}

const kindLabel = (clock, kind) => clock.kinds.find((entry) => entry.kind === kind)?.label ?? humanise(kind);
const daysWord = (n) => String(Math.abs(n)) + ' day' + (Math.abs(n) === 1 ? '' : 's');

export function riddorCard(clock, canUpdate) {
  if (!clock) return '';
  if (clock.error) return notice(`The RIDDOR clock could not be read: ${clock.error.message ?? String(clock.error)}`, 'err');
  const open = clock.incidents.filter((entry) => entry.status === 'UNCLASSIFIED' || entry.status === 'DUE' || entry.status === 'OVERDUE');
  return html`<section class="card" style="margin-top:14px" aria-labelledby="riddor-h" data-riddor>
    <h2 id="riddor-h">RIDDOR reporting ${open.length ? badge(open.length + ' open', open.some((entry) => entry.status !== 'DUE') ? 'bad' : 'warn') : ''}</h2>
    <p class="metric-sub">Deaths, specified injuries, injuries to people not at work taken to hospital and dangerous occurrences: notify without delay and report within 10 days. Over-seven-day injuries: within 15 days. Diseases: on diagnosis. The kind of report is a competent person’s judgement and sets the due date.</p>
    ${table({
      headers: ['Incident', 'Kind of report', 'Due', 'Status', ''],
      empty: 'No reportable incident on this project',
      emptyDetail: 'An incident recorded as reportable appears here until its report is made.',
      rows: clock.incidents.map((entry) => [
        html`<b>${entry.reference}</b><br><span class="metric-sub">${humanise(entry.category).toLowerCase()} · ${entry.occurredOn}</span>`,
        entry.kind ? html`${kindLabel(clock, entry.kind)}${entry.notifyWithoutDelay ? html`<br><span class="metric-sub">notify without delay</span>` : ''}` : '—',
        entry.dueOn ?? '—',
        html`${badge(STATUS_WORDS[entry.status], STATUS_TONE[entry.status])}${
          entry.daysLeft !== null ? html`<br><span class="metric-sub">${entry.daysLeft < 0 ? daysWord(entry.daysLeft) + ' over' : daysWord(entry.daysLeft) + ' left'}</span>` : ''
        }${entry.report ? html`<br><span class="metric-sub">${entry.report.reportedOn} · ref ${entry.report.hseReference} · ${entry.report.method.toLowerCase()}${entry.report.lateReason ? ' · ' + entry.report.lateReason : ''}</span>` : ''}`,
        canUpdate && !entry.report
          ? html`<button class="btn quiet sm" data-command="riddor-classify" data-incident="${entry.incidentId}">${entry.kind ? 'Reclassify' : 'Classify'}</button>${
              entry.kind ? html` <button class="btn sm" data-command="riddor-report" data-incident="${entry.incidentId}">Record the report</button>` : ''
            }`
          : '',
      ]),
    })}
  </section>`;
}

export function bindRiddor(root, clock, projectId) {
  if (!clock || clock.error) return;
  const entryOf = (button) => clock.incidents.find((entry) => entry.incidentId === button.dataset.incident);
  const today = new Date().toISOString().slice(0, 10);
  const COMMANDS = {
    'riddor-classify': (button) => {
      const entry = entryOf(button);
      return {
        title: `${entry.reference}: kind of RIDDOR report`,
        intent: 'As the competent person judges it. It sets the date the report is due; it cannot be changed once the report is made.',
        path: `/v1/projects/${projectId}/safety/incidents/${entry.incidentId}/riddor-classification`,
        submitLabel: 'Record',
        fields: [
          { name: 'kind', label: 'Kind of report', type: 'select', options: clock.kinds.map((kind) => ({ value: kind.kind, label: kind.label })), value: entry.kind ?? '' },
          { name: 'diagnosedOn', label: 'Diagnosis received on (a disease only)', type: 'date', required: false },
          { name: 'note', label: 'Why it falls in this category', type: 'textarea', rows: 2 },
        ],
      };
    },
    'riddor-report': (button) => {
      const entry = entryOf(button);
      const late = entry.dueOn && today > entry.dueOn;
      return {
        title: `${entry.reference}: report made`,
        intent: `Due by ${entry.dueOn}. Telephone is accepted for deaths and specified injuries only.${late ? ' It is now late: say why.' : ''}`,
        path: `/v1/projects/${projectId}/safety/incidents/${entry.incidentId}/riddor-report`,
        submitLabel: 'Record the report',
        fields: [
          { name: 'reportedOn', label: 'Reported on', type: 'date', value: today },
          { name: 'hseReference', label: 'Reference issued', type: 'text' },
          { name: 'method', label: 'How', type: 'select', options: clock.methods.map((method) => ({ value: method, label: humanise(method) })) },
          { name: 'lateReason', label: 'Why it was late (if it was)', type: 'text', required: false },
        ],
      };
    },
  };
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    const make = COMMANDS[button.dataset.command];
    if (!make) return;
    if (await command(make(button))) await draw();
  });
}
