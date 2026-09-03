import { api } from '../lib/api.js';
import { command, commandBar } from '../lib/command.js';
import { badge, html, humanise, money, pct, positionReport, raw, render, table, toast } from '../lib/ui.js';
import { insightPanel } from '../lib/insight.js';
import { blockedReason, can, draw, state } from '../app.js';

/**
 * Concept — stage 6.
 *
 * The first stage of the lifecycle and the one where the expensive decisions
 * are made with the least information. The screen is built around that: every
 * panel leads with what is *not* yet known or agreed, because at concept the
 * gaps are the subject rather than an exception.
 *
 * Three design decisions worth stating.
 *
 * **A blocked reason is shown as a sentence, never as a count.** The server
 * returns why each thing cannot proceed — `selectionBlocked`,
 * `baselineBlocked`, `complianceBlocked` — and those sentences are printed
 * verbatim. A red "3 issues" badge sends somebody hunting; the sentence tells
 * them which constraint and who owns it.
 *
 * **A machine-extracted requirement is visibly marked until a person accepts
 * it.** AC-C-WF-02-02 is a user-interface requirement as much as a data one,
 * and it is satisfied here by a badge on the row rather than by a filter
 * somebody has to know to apply.
 *
 * **The gate is rendered from the server's own report.** The browser holds no
 * clause logic. A gate the console assembled would be a second answer to the
 * question the API already answers, and the two would disagree the first time
 * a clause changed.
 */

const CLAUSE_TONE = { PASS: 'ok', FAIL: 'bad', NOT_ASSESSABLE: 'warn' };
const STATUS_TONE = { ACCEPTED: 'ok', DRAFT: '', NEEDS_REVIEW: 'warn', SUPERSEDED: '' };
const SEVERITY_TONE = { CRITICAL: 'bad', MAJOR: 'warn', MINOR: '' };

const todayIso = () => new Date().toISOString().slice(0, 10);

export async function concept(root) {
  const projectId = state.session.projectId;

  // Every panel is independent: a project part-way through concept has most of
  // these empty, and one failing must not blank the screen.
  const [initiation, drift, sensitivity, brief, diligence, options, controls, strategy, compliance, gate] = await Promise.all([
    api.get(`/v1/projects/${projectId}/concept/initiation`).catch(() => null),
    // Whether the leading option survives a change of weighting, and what has
    // moved since the baseline froze. An option that leads on only one
    // weighting is a decision waiting to be reopened, and until now nobody
    // could see which kind they had.
    api.get(`/v1/projects/${projectId}/concept/baseline/drift`).catch((error) => ({ error })),
    api.get(`/v1/projects/${projectId}/concept/options/sensitivity`).catch((error) => ({ error })),
    api.get(`/v1/projects/${projectId}/concept/brief`).catch(() => null),
    api.get(`/v1/projects/${projectId}/concept/due-diligence`).catch(() => null),
    api.get(`/v1/projects/${projectId}/concept/options`).catch(() => null),
    api.read(`/v1/projects/${projectId}/concept/controls`, 'BUDGET_COST').catch(() => null),
    api.read(`/v1/projects/${projectId}/concept/strategy`, 'PROCUREMENT_AWARD').catch(() => null),
    api.read(`/v1/projects/${projectId}/concept/compliance`, 'RISK_REGISTER').catch(() => null),
    api.get(`/v1/projects/${projectId}/concept/gate`).catch(() => null),
  ]);

  const requirements = await api
    .get(`/v1/projects/${projectId}/concept/requirements`)
    .catch(() => ({ requirements: [] }));

  render(
    root,
    html`<div class="view">
      <div class="view-head">
        <div>
          <h1>Concept</h1>
          <p class="hint">
            Stage 6 — what the asset is for, what the site allows, which option was chosen and what it is
            expected to cost. Everything here is frozen at the 6.4 gate and cited by design.
          </p>
        </div>
        <div class="actions">
          ${raw(
            commandBar([
              {
                id: 'configuration',
                label: 'Version configuration',
                permitted: can('PROJECT_SETUP', 'C'),
                reason: blockedReason('PROJECT_SETUP', 'C'),
              },
              {
                id: 'requirement',
                label: 'Add requirement',
                permitted: can('PROJECT_SETUP', 'C'),
                reason: blockedReason('PROJECT_SETUP', 'C'),
              },
              {
                id: 'survey',
                label: 'Register survey',
                permitted: can('PROJECT_SETUP', 'C'),
                reason: blockedReason('PROJECT_SETUP', 'C'),
              },
              {
                id: 'constraint',
                label: 'Identify constraint',
                permitted: can('PROJECT_SETUP', 'C'),
                reason: blockedReason('PROJECT_SETUP', 'C'),
              },
              {
                id: 'option',
                label: 'Create option',
                permitted: can('PROJECT_SETUP', 'C'),
                reason: blockedReason('PROJECT_SETUP', 'C'),
              },
              {
                id: 'costline',
                label: 'Add cost line',
                permitted: can('BUDGET_COST', 'U'),
                reason: blockedReason('BUDGET_COST', 'U'),
              },
              {
                id: 'baseline',
                label: 'Freeze concept baseline',
                tone: '',
                permitted: can('PROJECT_SETUP', 'A'),
                reason: blockedReason('PROJECT_SETUP', 'A'),
              },
            ]),
          )}
        </div>
      </div>
      <!--
        The agents that watch this area, at the point somebody is looking at the
        number they are about. The machinery was built and reachable only from
        the autopilot queue — the screen a person opens once they have already
        decided to look at what the fleet found, which is exactly backwards.
      -->
      <div id="concept-insight" style="margin-bottom:14px"></div>

      ${gate ? gateBand(gate) : ''}

      <div class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h2>Brief</h2>
          <div class="metric ${raw(brief?.baseline ? 'good' : 'warn')}">
            ${brief ? `${brief.accepted}/${brief.total}` : '—'}
          </div>
          <div class="metric-sub">
            ${brief?.baseline ? `baselined v${brief.baseline.version}` : 'not baselined'}
          </div>
        </div>
        <div class="card">
          <h2>Due-diligence coverage</h2>
          <div class="metric ${raw((diligence?.readiness?.percent ?? 0) >= 70 ? 'good' : 'warn')}">
            ${diligence ? pct(diligence.readiness.percent, 0) : '—'}
          </div>
          <div class="metric-sub">
            ${diligence ? `${diligence.liveSurveys} live survey(s) · ${diligence.criticalOpen} critical open` : '—'}
          </div>
        </div>
        <div class="card">
          <h2>Concept cost at P80</h2>
          <div class="metric">${controls?.totals ? money(controls.totals.p80Minor) : '—'}</div>
          <div class="metric-sub">
            ${
              controls?.totals
                ? `P50 ${money(controls.totals.p50Minor)} · ${controls.totals.provisionalLines} provisional line(s)`
                : 'no cost plan'
            }
          </div>
        </div>
        <div class="card">
          <h2>Residual risk exposure</h2>
          <div class="metric">${compliance ? money(compliance.residualExposureMinor) : '—'}</div>
          <div class="metric-sub">
            ${
              compliance
                ? `${compliance.risks} risk(s) · allowance ${money(compliance.costPlanAllowanceMinor)}`
                : '—'
            }
          </div>
        </div>
      </div>

      ${initiationPanel(initiation)}
      ${briefPanel(brief, requirements.requirements ?? [])}
      ${diligencePanel(diligence)}
      ${optionsPanel(options)}
      ${controlsPanel(controls)}
      ${strategyPanel(strategy)}
      ${compliancePanel(compliance)}

      ${positionReport({
        title: 'Baseline drift',
        intent: 'Components that have moved since the concept baseline froze them.',
        data: drift,
        error: drift?.error,
        sections: [{ key: 'drift', label: 'Moved since the freeze', empty: 'Nothing has moved since the baseline froze.' }],
      })}

      ${positionReport({
        title: 'Option sensitivity',
        intent:
          'Vary one criterion and see whether the leading option still leads. A refusal here is meaningful: it says ' +
          'no option is scored against that criterion, which is different from the ranking being stable.',
        data: sensitivity,
        error: sensitivity?.error,
        sections: [
          { key: 'results', label: 'Under a varied weighting', empty: 'Nothing is scored, so there is nothing to vary.' },
        ],
      })}
    </div>`,
  );

  const COMMANDS = {
    configuration: {
      title: 'Version the project configuration',
      intent:
        'Jurisdiction, time zone and currency give every date and figure on this project its meaning. ' +
        'Changing them after work has been approved requires an impact assessment and creates a new version.',
      path: `/v1/projects/${projectId}/concept/configuration`,
      submitLabel: 'Version',
      transform: (values) => ({
        ...values,
        retentionYears: Number(values.retentionYears),
        calendar: {
          timeZone: values.timeZone,
          workingDays: [1, 2, 3, 4, 5],
          holidays: [],
        },
        timeZone: undefined,
      }),
      fields: [
        { name: 'projectCode', label: 'Project code', type: 'text', placeholder: 'AWT-P2' },
        { name: 'jurisdiction', label: 'Jurisdiction', type: 'text', placeholder: 'GB' },
        { name: 'jurisdictionPack', label: 'Jurisdiction pack', type: 'text', placeholder: 'GB-2026.1' },
        { name: 'classificationPack', label: 'Classification pack', type: 'text', placeholder: 'UNICLASS-2015' },
        { name: 'contractCalendarPack', label: 'Contract calendar pack', type: 'text', placeholder: 'NEC4-2017' },
        {
          name: 'timeZone',
          label: 'Project time zone',
          type: 'text',
          placeholder: 'Europe/London',
          hint: 'IANA name. Every date renders in this and persists as UTC.',
        },
        { name: 'reportingCurrency', label: 'Reporting currency', type: 'text', placeholder: 'GBP' },
        {
          name: 'measurementSystem',
          label: 'Measurement system',
          type: 'select',
          options: [
            { value: 'METRIC', label: 'Metric' },
            { value: 'IMPERIAL', label: 'Imperial' },
          ],
        },
        { name: 'sponsorId', label: 'Sponsor', type: 'text' },
        { name: 'projectDirectorId', label: 'Project director', type: 'text' },
        { name: 'dataResidency', label: 'Data residency', type: 'text', placeholder: 'UK' },
        { name: 'retentionYears', label: 'Retention (years)', type: 'number', min: 1 },
        { name: 'defaultSensitivity', label: 'Default sensitivity', type: 'text', placeholder: 'INTERNAL' },
        { name: 'reason', label: 'Reason for this version', type: 'textarea' },
        {
          name: 'impactAssessment',
          label: 'Impact assessment',
          type: 'textarea',
          required: false,
          hint: 'Required from version 2 — what the change reaches downstream.',
        },
      ],
    },

    requirement: {
      title: 'Add a requirement',
      intent:
        'Every requirement carries its source, its owner and how it will be shown to have been met. ' +
        'A requirement nobody can verify is a wish.',
      path: `/v1/projects/${projectId}/concept/requirements`,
      submitLabel: 'Record',
      transform: (values) => ({
        reference: values.reference,
        category: values.category,
        statement: values.statement,
        source: values.source,
        sourceAnchor: values.sourceAnchor,
        ownerId: values.ownerId,
        priority: values.priority,
        acceptanceCriteria: values.acceptanceCriteria,
        origin: 'HUMAN',
        verification: { method: values.verificationMethod, stage: values.verificationStage },
      }),
      fields: [
        { name: 'reference', label: 'Reference', type: 'text', placeholder: 'REQ-001' },
        {
          name: 'category',
          label: 'Category',
          type: 'select',
          options: [
            'FUNCTIONAL', 'CAPACITY', 'SPATIAL', 'QUALITY', 'SAFETY', 'CARBON',
            'ENERGY', 'RESILIENCE', 'ACCESSIBILITY', 'MAINTAINABILITY', 'COMMERCIAL', 'STATUTORY',
          ].map((value) => ({ value, label: humanise(value) })),
        },
        { name: 'statement', label: 'Requirement', type: 'textarea' },
        { name: 'source', label: 'Source', type: 'text', placeholder: 'Business case v2' },
        { name: 'sourceAnchor', label: 'Where in the source', type: 'text', placeholder: 'p14, §3.2' },
        { name: 'ownerId', label: 'Owner', type: 'text' },
        {
          name: 'priority',
          label: 'Priority',
          type: 'select',
          options: ['MANDATORY', 'HIGH', 'MEDIUM', 'LOW'].map((value) => ({ value, label: humanise(value) })),
        },
        { name: 'verificationMethod', label: 'Verification method', type: 'text', placeholder: 'Witnessed performance test' },
        {
          name: 'verificationStage',
          label: 'Verified at',
          type: 'select',
          options: ['CONCEPT', 'DESIGN', 'TENDER', 'CONSTRUCTION', 'COMMISSIONING', 'HANDOVER', 'OPERATION'].map(
            (value) => ({ value, label: humanise(value) }),
          ),
        },
        { name: 'acceptanceCriteria', label: 'Acceptance criteria', type: 'textarea' },
      ],
    },

    survey: {
      title: 'Register a survey',
      intent:
        'The coordinate system and the limitations are both required. A survey whose system nobody recorded ' +
        'cannot be overlaid, and one with no stated limitations is how a project prices ground nobody has seen.',
      path: `/v1/projects/${projectId}/concept/surveys`,
      submitLabel: 'Register',
      transform: (values) => ({ ...values, coverage: [values.coverage] }),
      fields: [
        { name: 'reference', label: 'Reference', type: 'text', placeholder: 'GI-01' },
        { name: 'discipline', label: 'Discipline', type: 'text', placeholder: 'Geotechnical' },
        { name: 'author', label: 'Author', type: 'text' },
        { name: 'surveyedOn', label: 'Surveyed on', type: 'date', max: todayIso() },
        {
          name: 'coverage',
          label: 'Covers',
          type: 'select',
          options: [
            'GROUND', 'CONTAMINATION', 'FLOOD', 'ECOLOGY', 'HERITAGE', 'UTILITIES',
            'ACCESS', 'PLANNING', 'NEIGHBOUR', 'OPERATIONAL', 'STRUCTURAL', 'AIR_QUALITY',
          ].map((value) => ({ value, label: humanise(value) })),
        },
        {
          name: 'coordinateSystem',
          label: 'Coordinate system',
          type: 'text',
          placeholder: 'EPSG:27700',
          hint: 'NONE for a survey with no geometry, such as a desk study.',
        },
        { name: 'limitations', label: 'Limitations', type: 'textarea', hint: 'What it did not establish.' },
        { name: 'validUntil', label: 'Valid until', type: 'date', required: false },
        { name: 'evidenceHash', label: 'The survey', type: 'file' },
      ],
    },

    constraint: {
      title: 'Identify a constraint',
      intent: 'Bound to the survey that evidences it. A constraint with no evidence is an opinion.',
      path: `/v1/projects/${projectId}/concept/constraints`,
      submitLabel: 'Identify',
      transform: (values) => ({
        ...values,
        impacts: [values.impacts],
        allowanceMinor: values.allowanceMinor === '' ? undefined : Number(values.allowanceMinor),
      }),
      fields: [
        { name: 'reference', label: 'Reference', type: 'text', placeholder: 'CON-01' },
        { name: 'description', label: 'Description', type: 'textarea' },
        {
          name: 'constraintClass',
          label: 'Class',
          type: 'select',
          options: [
            { value: 'HARD', label: 'Hard — the design must change' },
            { value: 'SOFT', label: 'Soft — the cost changes' },
            { value: 'ASSUMPTION', label: 'Assumption — needs proving' },
            { value: 'OPPORTUNITY', label: 'Opportunity' },
          ],
        },
        {
          name: 'severity',
          label: 'Severity',
          type: 'select',
          options: ['CRITICAL', 'MAJOR', 'MINOR'].map((value) => ({ value, label: humanise(value) })),
        },
        {
          name: 'impacts',
          label: 'Affects',
          type: 'select',
          options: [
            'GROUND', 'CONTAMINATION', 'FLOOD', 'ECOLOGY', 'HERITAGE', 'UTILITIES',
            'ACCESS', 'PLANNING', 'NEIGHBOUR', 'OPERATIONAL', 'STRUCTURAL', 'AIR_QUALITY',
          ].map((value) => ({ value, label: humanise(value) })),
        },
        { name: 'spatialScope', label: 'Where it applies', type: 'text' },
        { name: 'surveyId', label: 'Evidenced by survey', type: 'text', hint: 'The survey id it comes from.' },
        { name: 'ownerId', label: 'Owner', type: 'text' },
        { name: 'allowanceMinor', label: 'Allowance', type: 'number', money: true, required: false },
      ],
    },

    option: {
      title: 'Create a feasibility option',
      intent:
        'Scope, assumptions and price base are recorded because two options priced on different bases are ' +
        'not comparable, and comparing them anyway is how a cheap option wins by leaving something out.',
      path: `/v1/projects/${projectId}/concept/options`,
      submitLabel: 'Create',
      transform: (values) => ({
        reference: values.reference,
        name: values.name,
        description: values.description,
        scopeStatement: values.scopeStatement,
        assumptions: values.assumptions.split('\n').map((line) => line.trim()).filter(Boolean),
        exclusions: values.exclusions.split('\n').map((line) => line.trim()).filter(Boolean),
        baseDate: values.baseDate,
        currency: values.currency,
        orderOfCostMinor: Number(values.orderOfCostMinor),
        costLowMinor: Number(values.costLowMinor),
        costHighMinor: Number(values.costHighMinor),
        durationDaysLow: Number(values.durationDaysLow),
        durationDaysMostLikely: Number(values.durationDaysMostLikely),
        durationDaysHigh: Number(values.durationDaysHigh),
      }),
      fields: [
        { name: 'reference', label: 'Reference', type: 'text', placeholder: 'OPT-A' },
        { name: 'name', label: 'Name', type: 'text' },
        { name: 'description', label: 'Description', type: 'textarea' },
        { name: 'scopeStatement', label: 'Scope — what is in and out', type: 'textarea' },
        { name: 'assumptions', label: 'Assumptions', type: 'textarea', hint: 'One per line.' },
        { name: 'exclusions', label: 'Exclusions', type: 'textarea', hint: 'One per line.' },
        { name: 'baseDate', label: 'Price base date', type: 'date', value: todayIso() },
        { name: 'currency', label: 'Currency', type: 'text', placeholder: 'GBP' },
        { name: 'orderOfCostMinor', label: 'Order of cost', type: 'number', money: true },
        { name: 'costLowMinor', label: 'Cost — low', type: 'number', money: true },
        { name: 'costHighMinor', label: 'Cost — high', type: 'number', money: true },
        { name: 'durationDaysLow', label: 'Duration — low (days)', type: 'number', min: 1 },
        { name: 'durationDaysMostLikely', label: 'Duration — most likely (days)', type: 'number', min: 1 },
        { name: 'durationDaysHigh', label: 'Duration — high (days)', type: 'number', min: 1 },
      ],
    },

    costline: {
      title: 'Add a cost line',
      intent:
        'A rate with a named source and a base date is verified. Anything else is provisional and is ' +
        'excluded from the high-confidence total rather than carried with a footnote.',
      path: `/v1/projects/${projectId}/concept/cost-plan/lines`,
      submitLabel: 'Add',
      transform: (values) => ({
        wbsCode: values.wbsCode,
        category: values.category,
        description: values.description,
        quantity: Number(values.quantity),
        unit: values.unit,
        rateMinor: Number(values.rateMinor),
        rateSource: values.rateSource,
        rateBaseDate: values.rateBaseDate,
        lowMinor: values.lowMinor === '' ? undefined : Number(values.lowMinor),
        highMinor: values.highMinor === '' ? undefined : Number(values.highMinor),
      }),
      fields: [
        { name: 'wbsCode', label: 'WBS code', type: 'text', placeholder: '1.1' },
        {
          name: 'category',
          label: 'Category',
          type: 'select',
          options: [
            'SUBSTRUCTURE', 'SUPERSTRUCTURE', 'FINISHES', 'SERVICES', 'EXTERNAL_WORKS', 'PRELIMINARIES',
            'DESIGN_FEES', 'CLIENT_COSTS', 'RISK_ALLOWANCE', 'CONTINGENCY', 'INFLATION', 'TAX_DUTIES',
          ].map((value) => ({ value, label: humanise(value) })),
        },
        { name: 'description', label: 'Description', type: 'text' },
        { name: 'quantity', label: 'Quantity', type: 'number', min: 0 },
        { name: 'unit', label: 'Unit', type: 'text', placeholder: 'm²' },
        { name: 'rateMinor', label: 'Rate', type: 'number', money: true },
        { name: 'rateSource', label: 'Rate source', type: 'text', required: false, hint: 'Blank makes the line provisional.' },
        { name: 'rateBaseDate', label: 'Rate base date', type: 'date', required: false },
        { name: 'lowMinor', label: 'Low', type: 'number', money: true, required: false },
        { name: 'highMinor', label: 'High', type: 'number', money: true, required: false },
      ],
    },

    baseline: {
      title: 'Freeze the concept baseline',
      intent:
        'Every component with its version and the hash of its state, so design can cite exactly what was ' +
        'approved. Refused while any gate clause is failing.',
      path: `/v1/projects/${projectId}/concept/baseline`,
      submitLabel: 'Freeze',
      fields: [
        { name: 'evidenceHash', label: 'Gate pack', type: 'file' },
        { name: 'note', label: 'Note', type: 'textarea', required: false },
      ],
    },
  };

  void insightPanel(root.querySelector('#concept-insight'), {
    projectId,
    areas: ['BUDGET_COST', 'PROJECT_SETUP'],
    subject: 'the concept and its cost plan',
    onChange: draw,
  });

  root.querySelector('.cmd-bar')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    const spec = COMMANDS[button.dataset.command];
    if (!spec) return;
    if (await command(spec)) await draw();
  });

  root.addEventListener('click', async (event) => {
    const accept = event.target.closest('[data-accept-requirement]');
    if (accept) {
      try {
        await api.post(
          `/v1/projects/${projectId}/concept/requirements/${accept.dataset.acceptRequirement}/accept`,
          {},
        );
        toast('Accepted', 'The requirement is now part of the brief.', 'ok');
        await draw();
      } catch (error) {
        toast('Could not accept', error.message, 'err');
      }
    }
  });
}

/**
 * The 6.4 gate, rendered from the server's own report.
 *
 * `NOT_ASSESSABLE` is shown in its own tone and with its own word. It is not a
 * softer failure: one is something the platform checked and found wanting, the
 * other is something it cannot see at all, and the two need different answers
 * from a person.
 */
function gateBand(gate) {
  const clauses = gate.clauses ?? [];
  return html`<div class="card pad0" style="margin-bottom:14px">
    <h2 style="padding:14px 16px 0">Stage gate 6.4 — Definition of Done</h2>
    <p class="hint" style="padding:0 16px">
      Seven clauses, each answered from the ledger. A clause the platform cannot assess is reported as
      unassessable and never as passed — a gate that quietly passes what it did not check turns a gap into a
      signed assurance.
    </p>
    ${table({
      headers: ['Clause', 'State', 'What it found'],
      rows: clauses.map((clause) => [
          clause.title,
          badge(humanise(clause.state), CLAUSE_TONE[clause.state] ?? ''),
          html`${clause.detail}
          ${
            (clause.blocking ?? []).length > 0
              ? html`<ul style="margin:6px 0 0 16px;color:var(--text-3)">
                  ${clause.blocking.map((item) => html`<li>${item}</li>`)}
                </ul>`
              : ''
          }`,
      ]),
    })}
  </div>`;
}

function initiationPanel(initiation) {
  if (!initiation) return '';
  const configuration = initiation.configuration;
  return html`<div class="card" style="margin-bottom:14px">
    <h2>C-WF-01 · Configuration and authority</h2>
    ${
      initiation.configurationBlocked
        ? html`<div class="notice warn">${initiation.configurationBlocked}</div>`
        : html`<p class="hint">
            ${configuration.projectCode} · ${configuration.jurisdiction} ·
            ${configuration.calendar.timeZone} · ${configuration.reportingCurrency} ·
            v${configuration.version} of ${initiation.configurationVersions}
          </p>`
    }
    ${
      initiation.authorityBlocked
        ? html`<div class="notice warn">${initiation.authorityBlocked}</div>`
        : table({
            headers: ['Decision', 'Holder', 'Limit', 'Escalates to'],
            align: ['', 'mono', 'num', 'mono'],
            rows: (initiation.authorityMatrix?.delegations ?? []).map((d) => [
              d.decision,
              html`<span class="mono">${d.holderId}</span>`,
              d.limitMinor === undefined ? '—' : money(d.limitMinor),
              d.escalatesToId ? html`<span class="mono">${d.escalatesToId}</span>` : '—',
            ]),
          })
    }
  </div>`;
}

function briefPanel(brief, requirements) {
  if (!brief) return '';
  return html`<div class="card pad0" style="margin-bottom:14px">
    <h2 style="padding:14px 16px 0">C-WF-02 · Requirements baseline</h2>
    <p class="hint" style="padding:0 16px">
      ${brief.accepted} accepted, ${brief.draft} draft, ${brief.needsReview} needing review,
      ${brief.superseded} superseded. ${brief.mandatory} mandatory.
    </p>
    ${brief.conflictReason ? html`<div class="notice warn" style="margin:0 16px">${brief.conflictReason}</div>` : ''}
    ${
      brief.baselineBlocked
        ? html`<div class="notice" style="margin:0 16px">${brief.baselineBlocked}</div>`
        : ''
    }
    ${
      brief.drift.length > 0
        ? html`<div class="notice bad" style="margin:0 16px">
            ${brief.drift.length} requirement(s) have moved since the baseline froze them:
            ${brief.drift.map((d) => `${d.reference} (${d.state.toLowerCase()})`).join(', ')}.
          </div>`
        : ''
    }
    ${table({
      headers: ['Reference', 'Requirement', 'Priority', 'Verified at', 'Status', ''],
      align: ['mono', '', '', '', '', ''],
      rows: requirements.map((r) => [
          html`<span class="mono">${r.reference}</span>`,
          html`${r.statement}
          <div class="metric-sub">${r.source} · ${r.sourceAnchor}</div>`,
          humanise(r.priority),
          `${humanise(r.verification.stage)} — ${r.verification.method}`,
          html`${badge(humanise(r.status), STATUS_TONE[r.status] ?? '')}
          ${
            // AC-C-WF-02-02. Marked on the row rather than behind a filter.
            r.origin === 'AI' && r.status !== 'ACCEPTED'
              ? badge(`AI · ${Math.round((r.confidence ?? 0) * 100)}%`, 'warn')
              : ''
          }`,
          r.status === 'DRAFT' || r.status === 'NEEDS_REVIEW'
            ? can('PROJECT_SETUP', 'A')
              ? html`<button class="btn quiet sm" data-accept-requirement="${r.requirementId}">Accept</button>`
              : ''
            : '',
      ]),
    })}
  </div>`;
}

function diligencePanel(diligence) {
  if (!diligence) return '';
  return html`<div class="card" style="margin-bottom:14px">
    <h2>C-WF-03 · Site and constraint due diligence</h2>
    <p class="hint">
      Readiness is evidence coverage, not document count: ${diligence.readiness.covered.length} of
      ${diligence.readiness.covered.length + diligence.readiness.uncovered.length} impact categories are
      covered by a live survey.
    </p>
    ${diligence.optionBlocked ? html`<div class="notice bad">${diligence.optionBlocked}</div>` : ''}
    ${
      diligence.uncovered?.length !== 0 && diligence.readiness.uncovered.length > 0
        ? html`<div class="notice">
            Not covered by any live survey:
            ${diligence.readiness.uncovered.map((c) => humanise(c)).join(', ')}.
          </div>`
        : ''
    }
    <div class="grid g4" style="margin-top:12px">
      <div>
        <div class="metric-sub">Surveys</div>
        <div class="metric">${diligence.liveSurveys}</div>
        <div class="metric-sub">${diligence.supersededSurveys} superseded · ${diligence.expiredSurveys} expired</div>
      </div>
      <div>
        <div class="metric-sub">Constraints assessed</div>
        <div class="metric ${raw(diligence.criticalOpen > 0 ? 'bad' : 'good')}">
          ${diligence.assessed}/${diligence.constraints}
        </div>
        <div class="metric-sub">${diligence.criticalOpen} critical still open</div>
      </div>
      <div>
        <div class="metric-sub">Investigations open</div>
        <div class="metric ${raw(diligence.investigationsOverdue > 0 ? 'bad' : '')}">
          ${diligence.investigationsOpen}
        </div>
        <div class="metric-sub">${diligence.investigationsOverdue} overdue</div>
      </div>
      <div>
        <div class="metric-sub">Allowance against unknowns</div>
        <div class="metric">${money(diligence.allowanceMinor)}</div>
        <div class="metric-sub">
          ${diligence.lastReview ? `reviewed at ${diligence.lastReview.readinessPercent}%` : 'not reviewed'}
        </div>
      </div>
    </div>
  </div>`;
}

function optionsPanel(options) {
  if (!options) return '';
  const comparison = options.comparison ?? { rows: [] };
  return html`<div class="card pad0" style="margin-bottom:14px">
    <h2 style="padding:14px 16px 0">C-WF-04 · Feasibility options</h2>
    ${
      comparison.comparable
        ? html`<p class="hint" style="padding:0 16px">
            Comparable on a ${comparison.baseDate} base in ${comparison.currency}. Leading:
            <b>${comparison.leader}</b>.
          </p>`
        : html`<div class="notice warn" style="margin:0 16px">
            ${comparison.incomparableReason ?? 'No option has been analysed.'}
          </div>`
    }
    ${options.selectionBlocked ? html`<div class="notice" style="margin:0 16px">${options.selectionBlocked}</div>` : ''}
    ${table({
      headers: ['Option', 'Status', 'Order of cost', 'Range', 'Duration', 'Weighted score'],
      align: ['', '', 'num', 'num', 'num', 'num'],
      rows: comparison.rows.map((row) => [
          html`<span class="mono">${row.reference}</span> ${row.name}`,
          badge(humanise(row.status), row.status === 'SELECTED' ? 'ok' : ''),
          money(row.orderOfCostMinor),
          `${money(row.costLowMinor)} – ${money(row.costHighMinor)}`,
          `${row.durationDaysMostLikely} d`,
          String(row.weightedScore),
      ]),
    })}
    ${
      (options.rejectedWithRationale ?? []).length > 0
        ? html`<div style="padding:0 16px 14px">
            <div class="nav-group-label" style="margin:10px 0 6px">Rejected, and why</div>
            ${options.rejectedWithRationale.map(
              (r) => html`<p class="hint"><span class="mono">${r.reference}</span> — ${r.rationale}</p>`,
            )}
          </div>`
        : ''
    }
  </div>`;
}

function controlsPanel(controls) {
  if (!controls) return '';
  const totals = controls.totals;
  return html`<div class="card pad0" style="margin-bottom:14px">
    <h2 style="padding:14px 16px 0">C-WF-05 · Cost, programme and cashflow</h2>
    ${controls.blocked ? html`<div class="notice warn" style="margin:0 16px">${controls.blocked}</div>` : ''}
    ${
      controls.approved
        ? html`<p class="hint" style="padding:0 16px">
            Approved at cut-off ${controls.approved.cutOffDate} by the ${controls.approved.rangeMethod} method.
            ${
              controls.approved.affordabilityGapMinor > 0
                ? `Affordability gap ${money(controls.approved.affordabilityGapMinor)}, with ${controls.approved.affordabilityActions.length} action(s).`
                : 'Within the budget cap.'
            }
          </p>`
        : ''
    }
    ${
      totals
        ? html`<div class="grid g4" style="padding:0 16px 12px">
            <div>
              <div class="metric-sub">Total</div>
              <div class="metric">${money(totals.totalMinor)}</div>
            </div>
            <div>
              <div class="metric-sub">Of which verified</div>
              <div class="metric">${money(totals.verifiedTotalMinor)}</div>
              <div class="metric-sub">${totals.provisionalLines} provisional line(s)</div>
            </div>
            <div>
              <div class="metric-sub">P50 / P80</div>
              <div class="metric">${money(totals.p50Minor)}</div>
              <div class="metric-sub">P80 ${money(totals.p80Minor)}</div>
            </div>
            <div>
              <div class="metric-sub">Lines with no range</div>
              <div class="metric ${raw(controls.pointOnlyLines > 0 ? 'warn' : '')}">${controls.pointOnlyLines}</div>
              <div class="metric-sub">a P80 built from these is a P80 of nothing</div>
            </div>
          </div>`
        : ''
    }
    ${table({
      headers: ['Milestone', 'Date', 'Follows', 'Statutory'],
      rows: (controls.programme?.milestones ?? []).map((m) => [
          html`<span class="mono">${m.reference}</span> ${m.name}`,
          m.plannedDate,
          m.predecessors.length > 0 ? m.predecessors.join(', ') : (m.openStartReason ?? '—'),
          m.statutory ? badge('Statutory', 'warn') : '',
      ]),
    })}
  </div>`;
}

function strategyPanel(strategy) {
  if (!strategy) return '';
  return html`<div class="card pad0" style="margin-bottom:14px">
    <h2 style="padding:14px 16px 0">C-WF-06 · Procurement and contract strategy</h2>
    ${strategy.blocked ? html`<div class="notice warn" style="margin:0 16px">${strategy.blocked}</div>` : ''}
    ${
      strategy.procurement
        ? html`<p class="hint" style="padding:0 16px">
            ${humanise(strategy.procurement.selectedRoute)} — ${strategy.procurement.rationale}
            ${
              strategy.contract
                ? html`<br>${strategy.contract.contractFamily} ${strategy.contract.contractOption} —
                    <b>provisional</b> until the executed contract is ingested and validated.`
                : ''
            }
          </p>`
        : ''
    }
    ${
      strategy.scopeIssues?.gaps?.length > 0 || strategy.scopeIssues?.overlaps?.length > 0
        ? html`<div class="notice bad" style="margin:0 16px">
            ${strategy.scopeIssues.gaps.length > 0 ? `Gaps: ${strategy.scopeIssues.gaps.join(', ')}. ` : ''}
            ${
              strategy.scopeIssues.overlaps.length > 0
                ? `Overlaps: ${strategy.scopeIssues.overlaps.map((o) => `${o.element} (${o.packages.join(', ')})`).join('; ')}.`
                : ''
            }
          </div>`
        : ''
    }
    ${table({
      headers: ['Package', 'Scope', 'Enquiry', 'Award', 'Lead time', 'Required on site'],
      align: ['', '', '', '', 'num', 'mono'],
      rows: (strategy.packages?.packages ?? []).map((p) => [
          html`<span class="mono">${p.reference}</span> ${p.name}`,
          p.scopeElements.join(', '),
          p.enquiryDate,
          p.awardDate,
          html`${p.leadTimeWeeks} wk ${p.leadTimeWeeks >= 26 ? badge('Long lead', 'warn') : ''}`,
          p.requiredOnSiteMilestoneRef,
      ]),
    })}
  </div>`;
}

function compliancePanel(compliance) {
  if (!compliance) return '';
  return html`<div class="card" style="margin-bottom:14px">
    <h2>C-WF-07 · Risk and statutory compliance</h2>
    ${compliance.complianceBlocked ? html`<div class="notice bad">${compliance.complianceBlocked}</div>` : ''}
    ${compliance.riskReviewBlocked ? html`<div class="notice warn">${compliance.riskReviewBlocked}</div>` : ''}
    ${
      compliance.screening
        ? html`<p class="hint">
            Confirmed by ${compliance.screening.confirmedByName} (${compliance.screening.confirmedByRole}) —
            ${compliance.screening.competenceBasis}.
            ${
              compliance.applicableRegimes.length > 0
                ? `Applicable: ${compliance.applicableRegimes.map((r) => humanise(r)).join(', ')}.`
                : 'No statutory regime applies.'
            }
          </p>`
        : ''
    }
    <div class="grid g4" style="margin-top:12px">
      <div>
        <div class="metric-sub">Risks on the register</div>
        <div class="metric">${compliance.risks}</div>
        <div class="metric-sub">${compliance.criticalRisks} critical</div>
      </div>
      <div>
        <div class="metric-sub">Critical without an owner</div>
        <div class="metric ${raw(compliance.unownedCritical > 0 ? 'bad' : 'good')}">
          ${compliance.unownedCritical}
        </div>
      </div>
      <div>
        <div class="metric-sub">Inherent exposure</div>
        <div class="metric">${money(compliance.inherentExposureMinor)}</div>
      </div>
      <div>
        <div class="metric-sub">Allowance in the cost plan</div>
        <div class="metric">${money(compliance.costPlanAllowanceMinor)}</div>
        <div class="metric-sub">
          ${
            compliance.review
              ? `reconciles to ${compliance.review.reconciliationDifferenceMinor === 0 ? 'the penny' : money(compliance.review.reconciliationDifferenceMinor)}`
              : 'no risk review approved'
          }
        </div>
      </div>
    </div>
  </div>`;
}
