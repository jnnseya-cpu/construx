import { badge, html, humanise, table } from '../lib/ui.js';
import { personOptions, plural, roleOptions } from './imscommon.js';

/**
 * Monitoring on the Management System screen: how approved suppliers actually
 * performed, the competence matrix, and the RIDDOR clock across every project.
 */

const CELL_TONE = { HELD: 'ok', EXPIRING: 'warn', EXPIRED: 'bad', MISSING: 'bad' };
const RIDDOR_TONE = { UNCLASSIFIED: 'bad', DUE: 'warn', OVERDUE: 'bad', REPORTED: 'ok', REPORTED_LATE: 'warn' };
const RIDDOR_WORDS = { UNCLASSIFIED: 'kind not recorded', DUE: 'report due', OVERDUE: 'report overdue', REPORTED: 'reported', REPORTED_LATE: 'reported late' };

function suppliersCard(view, perms) {
  const suppliers = view.monitoring.suppliers;
  const s = view.settings;
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="ims-sup-h" data-ims-suppliers>
    <h2 id="ims-sup-h">Supplier performance</h2>
    <p class="metric-sub">Approved suppliers evaluated every ${s.supplierEvaluationMonths} months on quality, health and safety, environment, programme and commercial (1–5). A firm whose latest average is below ${s.supplierReviewBelow} is put to review — raise an action from it on the Actions tab.</p>
    ${table({
      headers: ['Supplier', 'Approval', 'Latest evaluation', 'Next due', ''],
      empty: 'No supplier in the register',
      emptyDetail: 'Suppliers are registered and prequalified under Tender & Procurement.',
      rows: suppliers.map((supplier) => [
        html`<b>${supplier.name}</b>`,
        html`${badge(humanise(supplier.status).toLowerCase(), supplier.status === 'SUSPENDED' ? 'bad' : supplier.status === 'REGISTERED' ? 'neutral' : 'ok')}${
          supplier.prequalificationExpiresOn ? html`<br><span class="metric-sub">prequalified to ${supplier.prequalificationExpiresOn}</span>` : ''
        }`,
        supplier.latest
          ? html`<b>${supplier.latest.average}</b> / 5 ${supplier.toReview ? badge('to review', 'bad') : ''}<br><span class="metric-sub">${supplier.latest.evaluatedOn} · Q${supplier.latest.scores.quality} S${supplier.latest.scores.safety} E${supplier.latest.scores.environment} P${supplier.latest.scores.programme} C${supplier.latest.scores.commercial}</span>${
              supplier.evaluations.length > 1 ? html`<details><summary style="cursor:pointer;font-size:12px">${plural(supplier.evaluations.length, 'evaluation', 'evaluations')}</summary><ul style="margin:4px 0 0 16px;font-size:12px">${supplier.evaluations.map((evaluation) => html`<li>${evaluation.evaluatedOn}: ${evaluation.average} — ${evaluation.comments}</li>`)}</ul></details>` : html`<br><span class="metric-sub">${supplier.latest.comments}</span>`
            }`
          : html`<span class="metric-sub">never evaluated</span>`,
        html`${supplier.status === 'SUSPENDED' || supplier.status === 'REGISTERED' ? '—' : supplier.nextEvaluationDue}${supplier.evaluationDue ? html`<br>${badge('due', 'warn')}` : ''}`,
        perms.create && supplier.status !== 'REGISTERED' ? html`<button class="btn quiet sm" data-command="ims-supplier-evaluate" data-supplier="${supplier.supplierId}">Evaluate</button>` : '',
      ]),
    })}
  </section>`;
}

function competenceCard(view, perms) {
  const matrix = view.monitoring.competence;
  const active = matrix.requirements.filter((entry) => entry.status === 'ACTIVE');
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="ims-comp-h" data-ims-competence>
    <h2 id="ims-comp-h">Competence matrix ${matrix.gaps ? badge(plural(matrix.gaps, 'gap', 'gaps'), 'bad') : active.length ? badge('no gap', 'ok') : ''} ${matrix.expiring ? badge(plural(matrix.expiring, 'expiring', 'expiring'), 'warn') : ''}
      ${perms.create ? html`<button class="btn quiet sm" data-command="ims-competence-require">Require a competence</button>` : ''}
      ${perms.create ? html`<button class="btn quiet sm" data-command="ims-competence-record">Record a competence held</button>` : ''}</h2>
    <p class="metric-sub">What each role requires, against what each person in it holds — from the competency and training records on every project and the company’s own. Matched by person and by the competence’s name.</p>
    ${
      active.length
        ? html`<details style="margin:6px 0"><summary style="cursor:pointer;font-size:12.5px">${plural(active.length, 'requirement', 'requirements')}</summary>${table({
            headers: ['Role', 'Competence', ''],
            rows: active.map((entry) => [humanise(entry.role), html`${entry.competence}${entry.note ? html`<br><span class="metric-sub">${entry.note}</span>` : ''}`, perms.update ? html`<button class="btn quiet sm" data-command="ims-competence-remove" data-requirement="${entry.id}">Remove</button>` : '']),
          })}</details>`
        : ''
    }
    ${table({
      headers: ['Person', 'Roles', 'Competences'],
      empty: active.length ? 'Nobody holds a role with a requirement' : 'No competence required yet',
      emptyDetail: active.length ? 'The matrix fills as people take the roles.' : 'Start with what each role must hold — SMSTS, SSSTS, CSCS, first aid.',
      rows: matrix.rows.map((row) => [
        html`<b>${row.name}</b>`,
        html`<span class="metric-sub">${row.roles.map((role) => humanise(role)).join(', ')}</span>`,
        html`${row.cells.map((cell) => html`${badge(cell.competence + ': ' + cell.status.toLowerCase(), CELL_TONE[cell.status])}${cell.expiresOn ? html`<span class="metric-sub"> to ${cell.expiresOn}</span>` : ''} `)}`,
      ]),
    })}
  </section>`;
}

function riddorCard(view) {
  const list = view.monitoring.riddor;
  const open = list.filter((entry) => entry.status === 'UNCLASSIFIED' || entry.status === 'DUE' || entry.status === 'OVERDUE');
  return html`<section class="card" style="margin-bottom:14px" aria-labelledby="ims-riddor-h" data-ims-riddor>
    <h2 id="ims-riddor-h">RIDDOR across the projects ${open.length ? badge(open.length + ' open', open.some((entry) => entry.status !== 'DUE') ? 'bad' : 'warn') : list.length ? badge('all reported', 'ok') : ''}</h2>
    <p class="metric-sub">Every reportable incident on every project. The kind of report and the report itself are recorded on the project’s Risk & Safety screen.</p>
    ${table({
      headers: ['Incident', 'Project', 'Kind', 'Due', 'Status'],
      empty: 'No reportable incident',
      emptyDetail: 'Incidents recorded as reportable on any project appear here.',
      rows: list.map((entry) => [
        html`<b>${entry.reference}</b><br><span class="metric-sub">${entry.occurredOn}</span>`,
        entry.project,
        entry.kind ? (view.vocabulary.riddorKinds.find((kind) => kind.kind === entry.kind)?.label ?? entry.kind) : '—',
        entry.dueOn ?? '—',
        html`${badge(RIDDOR_WORDS[entry.status], RIDDOR_TONE[entry.status])}${entry.report ? html`<br><span class="metric-sub">${entry.report.reportedOn} · ref ${entry.report.hseReference}</span>` : ''}`,
      ]),
    })}
  </section>`;
}

export function monitoringCards(view, perms) {
  return html`${riddorCard(view)}${suppliersCard(view, perms)}${competenceCard(view, perms)}`;
}

export function monitoringCommands(view) {
  const scoreOptions = [1, 2, 3, 4, 5].map((value) => ({ value: String(value), label: String(value) }));
  const words = { quality: 'Quality', safety: 'Health and safety', environment: 'Environment', programme: 'Programme', commercial: 'Commercial' };
  return {
    'ims-supplier-evaluate': (button) => {
      const supplier = view.monitoring.suppliers.find((entry) => entry.supplierId === button.dataset.supplier);
      return {
        title: `Evaluate ${supplier.name}`,
        intent: '1 unacceptable · 2 poor · 3 acceptable · 4 good · 5 excellent. Say what the scores rest on.',
        path: `/v1/ims/suppliers/${supplier.supplierId}/evaluations`,
        submitLabel: 'Record the evaluation',
        fields: [
          { name: 'projectId', label: 'On project (optional)', type: 'select', required: false, placeholder: 'Across the company', options: view.programme.projects.map((project) => ({ value: project.id, label: project.name })) },
          ...view.vocabulary.performanceHeadings.map((heading) => ({ name: heading, label: words[heading] ?? heading, type: 'select', options: scoreOptions, value: '3' })),
          { name: 'comments', label: 'What the scores rest on', type: 'textarea', rows: 3 },
        ],
        transform: (v) => ({
          ...(v.projectId ? { projectId: v.projectId } : {}),
          scores: Object.fromEntries(view.vocabulary.performanceHeadings.map((heading) => [heading, Number(v[heading])])),
          comments: v.comments,
        }),
      };
    },
    'ims-competence-require': () => ({
      title: 'Require a competence of a role',
      intent: 'Name it exactly as the certificates do, so held records match.',
      path: '/v1/ims/competence/requirements',
      submitLabel: 'Require it',
      fields: [
        { name: 'role', label: 'Role', type: 'select', options: roleOptions(view) },
        { name: 'competence', label: 'Competence', type: 'text', placeholder: 'SMSTS' },
        { name: 'note', label: 'Note (optional)', type: 'text', required: false },
      ],
    }),
    'ims-competence-remove': (button) => ({
      title: 'Stop requiring this competence',
      intent: 'It stays on the record, removed, with your reason.',
      path: `/v1/ims/competence/requirements/${button.dataset.requirement}/remove`,
      submitLabel: 'Remove',
      fields: [{ name: 'reason', label: 'Why the role no longer needs it', type: 'text' }],
    }),
    'ims-competence-record': () => ({
      title: 'Record a competence held',
      intent: 'With its certificate, which is hashed in your browser and kept as evidence, and its expiry.',
      path: '/v1/ims/competence/records',
      submitLabel: 'Record',
      fields: [
        { name: 'personId', label: 'Person', type: 'select', options: personOptions(view) },
        { name: 'competence', label: 'Competence (as the certificate names it)', type: 'text' },
        { name: 'issuedOn', label: 'Issued', type: 'date' },
        { name: 'expiresOn', label: 'Expires', type: 'date' },
        { name: 'certificateHash', label: 'Certificate', type: 'file', voice: false },
      ],
    }),
  };
}
