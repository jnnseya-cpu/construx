import { api, entities } from '../lib/api.js';
import { command, commandBar } from '../lib/command.js';
import { badge, html, humanise, money, pct, positionReport, raw, render, table, toast } from '../lib/ui.js';
import { insightPanel } from '../lib/insight.js';
import { barChart, gauge, radarChart } from '../lib/charts.js';
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

// Enum display lists, inline as the create commands above already do for
// requirement categories, survey coverage and cost categories. The API remains
// the validator — these only populate the chooser and an unknown value is
// refused server-side exactly as a typed one would be.
const RANGE_METHOD = ['PERT', 'TRIANGULAR'];
const PROCUREMENT_ROUTE = [
  'TRADITIONAL', 'DESIGN_AND_BUILD', 'CONSTRUCTION_MANAGEMENT', 'MANAGEMENT_CONTRACTING',
  'FRAMEWORK_CALL_OFF', 'ALLIANCE', 'SINGLE_SOURCE',
];

const CLAUSE_TONE = { PASS: 'ok', FAIL: 'bad', NOT_ASSESSABLE: 'warn' };
const STATUS_TONE = { ACCEPTED: 'ok', DRAFT: '', NEEDS_REVIEW: 'warn', SUPERSEDED: '' };
const SEVERITY_TONE = { CRITICAL: 'bad', MAJOR: 'warn', MINOR: '' };

const todayIso = () => new Date().toISOString().slice(0, 10);

// --- form parsers -----------------------------------------------------------
//
// Several concept commands carry a repeating structure — a weighted set of
// criteria, a list of packages, a programme of milestones — that a flat field
// list cannot express. Rather than inventing a second schema in the browser,
// each such field is a delimited textarea and these turn what was typed into
// exactly the array or object the route's schema asks for. The server remains
// the one validator: a malformed line produces the refusal it always would.

/** Non-empty, trimmed lines of a textarea. */
const lines = (text) => String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean);

/** A comma- or newline-separated list, trimmed and emptied of blanks. */
const list = (text) => String(text ?? '').split(/[\n,]/).map((item) => item.trim()).filter(Boolean);

/** `KEY:value` pairs, comma- or newline-separated, into an object. */
const pairs = (text, cast = (value) => value) => {
  const out = {};
  for (const part of list(text)) {
    const index = part.indexOf(':');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (key) out[key] = cast(part.slice(index + 1).trim());
  }
  return out;
};

/** Yes/true/1 → true; anything else → false. */
const truthy = (value) => /^(y|yes|true|1)$/i.test(String(value ?? '').trim());

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

  // The option and constraint registers carry the ids the analyse/select/reject
  // and assess commands put in the URL. The position reads above report counts
  // and comparisons, not ids — so the console cannot drive a command *at* a
  // particular option or constraint from them. The generic entity read is the
  // one place those ids are published, gated on the same PROJECT_SETUP area and
  // sensitivity the typed reads apply, so a role not cleared for it is refused
  // here exactly as it would be anywhere and the chooser is simply empty.
  const [optionRecords, constraintRecords] = await Promise.all([
    entities(projectId, 'FeasibilityOption').catch(() => []),
    entities(projectId, 'SiteConstraint').catch(() => []),
  ]);

  // Status-filtered so a command is offered only where there is something for
  // it to act on, and the chooser lists only valid targets.
  const analysableOptions = optionRecords.filter((o) => o.status === 'DRAFT' || o.status === 'ANALYSED');
  const selectableOptions = optionRecords.filter((o) => o.status === 'ANALYSED');
  const rejectableOptions = optionRecords.filter((o) => o.status !== 'SELECTED' && o.status !== 'REJECTED');
  const unassessedConstraints = constraintRecords.filter((c) => c.status !== 'ASSESSED');

  const selectedOption = options?.selected;
  const costPlan = controls?.costPlan;
  const programme = controls?.programme;
  const cashflow = controls?.cashflow;
  const controlsApproved = controls?.approved;
  const optionLabel = (o) => `${o.reference} — ${o.name}`;
  const constraintLabel = (c) => `${c.reference} — ${humanise(c.severity)} (${c.status ? humanise(c.status) : 'open'})`;

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
                id: 'authority-matrix',
                label: 'Approve authority matrix',
                permitted: can('PROJECT_SETUP', 'A'),
                reason: blockedReason('PROJECT_SETUP', 'A'),
              },
              {
                id: 'requirement',
                label: 'Add requirement',
                permitted: can('PROJECT_SETUP', 'C'),
                reason: blockedReason('PROJECT_SETUP', 'C'),
              },
              {
                id: 'baseline-brief',
                label: 'Baseline the brief',
                permitted: can('PROJECT_SETUP', 'A') && Boolean(brief) && !brief?.baseline,
                reason: !can('PROJECT_SETUP', 'A')
                  ? blockedReason('PROJECT_SETUP', 'A')
                  : brief?.baseline
                    ? 'The brief is already baselined. Supersede a requirement to re-open it.'
                    : 'No brief to baseline yet. Add and accept the requirements first.',
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
                id: 'assess-constraint',
                label: 'Assess constraint',
                permitted: can('PROJECT_SETUP', 'A') && unassessedConstraints.length > 0,
                reason: !can('PROJECT_SETUP', 'A')
                  ? blockedReason('PROJECT_SETUP', 'A')
                  : 'Every constraint on the register is assessed. Identify one first.',
              },
              {
                id: 'review-diligence',
                label: 'Review due diligence',
                permitted: can('PROJECT_SETUP', 'A') && (diligence?.surveys ?? 0) > 0,
                reason: !can('PROJECT_SETUP', 'A')
                  ? blockedReason('PROJECT_SETUP', 'A')
                  : 'Nothing has been surveyed, so there is nothing to review.',
              },
              {
                id: 'option',
                label: 'Create option',
                permitted: can('PROJECT_SETUP', 'C'),
                reason: blockedReason('PROJECT_SETUP', 'C'),
              },
              {
                id: 'analyse-option',
                label: 'Score an option',
                permitted: can('PROJECT_SETUP', 'U') && analysableOptions.length > 0,
                reason: !can('PROJECT_SETUP', 'U')
                  ? blockedReason('PROJECT_SETUP', 'U')
                  : 'No option is waiting to be scored. Create one first.',
              },
              {
                id: 'select-option',
                label: 'Select an option',
                permitted: can('PROJECT_SETUP', 'A') && selectableOptions.length > 0 && !selectedOption,
                reason: !can('PROJECT_SETUP', 'A')
                  ? blockedReason('PROJECT_SETUP', 'A')
                  : selectedOption
                    ? 'An option is already selected.'
                    : 'No scored option is waiting for a decision. Score one first.',
              },
              {
                id: 'reject-option',
                label: 'Reject an option',
                permitted: can('PROJECT_SETUP', 'A') && rejectableOptions.length > 0,
                reason: !can('PROJECT_SETUP', 'A')
                  ? blockedReason('PROJECT_SETUP', 'A')
                  : 'There is no option left to rule out.',
              },
              {
                id: 'cost-plan',
                label: 'Open cost plan',
                permitted: can('BUDGET_COST', 'C') && Boolean(selectedOption) && !costPlan,
                reason: !can('BUDGET_COST', 'C')
                  ? blockedReason('BUDGET_COST', 'C')
                  : !selectedOption
                    ? 'Select the option first — the cost plan is opened against it.'
                    : 'A cost plan is already open.',
              },
              {
                id: 'costline',
                label: 'Add cost line',
                permitted: can('BUDGET_COST', 'U') && Boolean(costPlan),
                reason: !can('BUDGET_COST', 'U')
                  ? blockedReason('BUDGET_COST', 'U')
                  : 'Open the cost plan first — a line has nowhere to go without one.',
              },
              {
                id: 'programme',
                label: 'Create programme',
                permitted: can('PROGRAMME_BASELINES', 'C') && !programme,
                reason: !can('PROGRAMME_BASELINES', 'C')
                  ? blockedReason('PROGRAMME_BASELINES', 'C')
                  : 'A milestone programme already exists.',
              },
              {
                id: 'cashflow',
                label: 'Generate cashflow',
                permitted: can('BUDGET_COST', 'C') && Boolean(costPlan),
                reason: !can('BUDGET_COST', 'C')
                  ? blockedReason('BUDGET_COST', 'C')
                  : 'Open the cost plan first — a cashflow phases it.',
              },
              {
                id: 'approve-controls',
                label: 'Approve controls',
                permitted:
                  can('BUDGET_COST', 'A') && Boolean(costPlan) && Boolean(programme) && Boolean(cashflow) && !controlsApproved,
                reason: !can('BUDGET_COST', 'A')
                  ? blockedReason('BUDGET_COST', 'A')
                  : controlsApproved
                    ? 'Cost, programme and cashflow are already approved under a cut-off.'
                    : 'Cost plan, programme and cashflow must all exist before they can be approved together.',
              },
              {
                id: 'procurement-strategy',
                label: 'Choose procurement route',
                permitted: can('PROCUREMENT_AWARD', 'A') && !strategy?.procurement,
                reason: !can('PROCUREMENT_AWARD', 'A')
                  ? blockedReason('PROCUREMENT_AWARD', 'A')
                  : 'A procurement route is already chosen.',
              },
              {
                id: 'package-strategy',
                label: 'Approve packages',
                permitted: can('PROCUREMENT_AWARD', 'A') && (strategy?.packages?.packages?.length ?? 0) === 0,
                reason: !can('PROCUREMENT_AWARD', 'A')
                  ? blockedReason('PROCUREMENT_AWARD', 'A')
                  : 'The packages are already approved.',
              },
              {
                id: 'contract-strategy',
                label: 'Select contract form',
                permitted: can('CONTRACTS_CLAIMS', 'A') && !strategy?.contract,
                reason: !can('CONTRACTS_CLAIMS', 'A')
                  ? blockedReason('CONTRACTS_CLAIMS', 'A')
                  : 'A contract form is already selected.',
              },
              {
                id: 'compliance-screen',
                label: 'Screen statutory regimes',
                permitted: can('SAFETY_RAMS', 'A') && !compliance?.screening,
                reason: !can('SAFETY_RAMS', 'A')
                  ? blockedReason('SAFETY_RAMS', 'A')
                  : 'The statutory screening is already confirmed.',
              },
              {
                id: 'risk-review',
                label: 'Approve risk review',
                permitted: can('RISK_REGISTER', 'A') && !compliance?.review,
                reason: !can('RISK_REGISTER', 'A')
                  ? blockedReason('RISK_REGISTER', 'A')
                  : 'The concept risk review is already approved.',
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

      ${conceptCharts(diligence, options, compliance)}

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

    'authority-matrix': {
      title: 'Approve the delegated authority matrix',
      intent:
        'Who may decide what, and to what value. Bound to the configuration version it is approved under, so a ' +
        'reconfiguration leaves it for re-approval rather than silently carrying authority under changed rules.',
      path: `/v1/projects/${projectId}/concept/authority-matrix`,
      submitLabel: 'Approve',
      fields: [
        {
          name: 'delegations',
          label: 'Delegations',
          type: 'textarea',
          rows: 5,
          hint:
            'One per line: decision | holderId | limit (optional, in minor units) | escalates-to id (required where a ' +
            'limit is set). e.g. Commit expenditure | user-123 | 5000000 | user-456',
        },
      ],
      transform: (values) => ({
        delegations: lines(values.delegations).map((line) => {
          const [decision, holderId, limitMinor, escalatesToId] = line.split('|').map((part) => part.trim());
          return {
            decision,
            holderId,
            ...(limitMinor ? { limitMinor: Number(limitMinor) } : {}),
            ...(escalatesToId ? { escalatesToId } : {}),
          };
        }),
      }),
    },

    'baseline-brief': {
      title: 'Baseline the brief',
      intent:
        'Freezes the hash of every accepted requirement at this moment, so a later edit shows as drift against what ' +
        'the option was chosen for. Refused while a requirement is neither accepted nor superseded.',
      path: `/v1/projects/${projectId}/concept/brief/baseline`,
      submitLabel: 'Baseline',
      fields: [{ name: 'evidenceHash', label: 'Brief pack', type: 'file' }],
    },

    'assess-constraint': {
      title: 'Assess a constraint',
      intent:
        'Records how the constraint is dealt with. An assumption leaves here with an allowance or a named acceptance; ' +
        'a critical constraint left unassessed blocks the option recommendation and the gate.',
      path: ({ constraintId }) => `/v1/projects/${projectId}/concept/constraints/${constraintId}/assess`,
      submitLabel: 'Assess',
      fields: [
        {
          name: 'constraintId',
          label: 'Constraint',
          type: 'select',
          emptyHint: 'Every constraint is assessed.',
          options: unassessedConstraints.map((c) => ({ value: c.constraintId, label: constraintLabel(c) })),
        },
        { name: 'assessment', label: 'Assessment', type: 'textarea' },
        {
          name: 'allowanceMinor',
          label: 'Allowance',
          type: 'number',
          money: true,
          required: false,
          hint: 'For an assumption carried as a provisional sum.',
        },
        {
          name: 'acceptedUnknownBy',
          label: 'Accepted as an unknown by',
          type: 'text',
          required: false,
          hint: 'Who owns the residual unknown, where it is accepted rather than priced.',
        },
      ],
      transform: ({ constraintId: _constraintId, ...rest }) => rest,
    },

    'review-diligence': {
      title: 'Review due diligence',
      intent:
        'Records a review of survey coverage and the constraint register. The readiness figure is stored as it stood ' +
        'at the review, not recomputed later, so a review means what it said at the time.',
      path: `/v1/projects/${projectId}/concept/due-diligence/review`,
      submitLabel: 'Record review',
      fields: [{ name: 'note', label: 'Note', type: 'textarea' }],
    },

    'analyse-option': {
      title: 'Score an option',
      intent:
        'Scores the option against the appraisal criteria. The raw value is preserved beside the weighted total, and ' +
        'the weights must sum to one — scoring two options on different criteria is comparing two different measurements.',
      path: ({ optionId }) => `/v1/projects/${projectId}/concept/options/${optionId}/analyse`,
      submitLabel: 'Score',
      fields: [
        {
          name: 'optionId',
          label: 'Option',
          type: 'select',
          emptyHint: 'No option is waiting to be scored.',
          options: analysableOptions.map((o) => ({ value: o.optionId, label: optionLabel(o) })),
        },
        {
          name: 'scores',
          label: 'Scores',
          type: 'textarea',
          rows: 5,
          hint:
            'One criterion per line: CRITERION | rawValue | weight | basis. The weights across all lines must sum to 1. ' +
            'e.g. CAPITAL_COST | 7 | 0.4 | Benchmark from three comparable schemes',
        },
      ],
      transform: ({ scores }) => ({
        scores: lines(scores).map((line) => {
          const [criterion, rawValue, weight, ...basis] = line.split('|').map((part) => part.trim());
          return { criterion, rawValue: Number(rawValue), weight: Number(weight), basis: basis.join(' | ') };
        }),
      }),
    },

    'select-option': {
      title: 'Select an option',
      intent:
        'Freezes the brief-baseline hash the option was chosen against, so a later change to the brief shows the ' +
        'decision was taken for a different brief. A rationale is required — a selection with none is a preference.',
      path: ({ optionId }) => `/v1/projects/${projectId}/concept/options/${optionId}/select`,
      submitLabel: 'Select',
      fields: [
        {
          name: 'optionId',
          label: 'Option',
          type: 'select',
          emptyHint: 'No scored option is waiting for a decision.',
          options: selectableOptions.map((o) => ({ value: o.optionId, label: optionLabel(o) })),
        },
        { name: 'rationale', label: 'Why this option', type: 'textarea' },
        { name: 'decisionRecordId', label: 'Decision record', type: 'text', required: false },
        { name: 'evidenceHash', label: 'Decision pack', type: 'file' },
      ],
      transform: ({ optionId: _optionId, ...rest }) => rest,
    },

    'reject-option': {
      title: 'Reject an option',
      intent:
        'Rules the option out, with its reason. A rejection with no reason is the option somebody proposes again next ' +
        'year — the rationale is the record that the decision was deliberate.',
      path: ({ optionId }) => `/v1/projects/${projectId}/concept/options/${optionId}/reject`,
      submitLabel: 'Reject',
      fields: [
        {
          name: 'optionId',
          label: 'Option',
          type: 'select',
          emptyHint: 'There is no option left to rule out.',
          options: rejectableOptions.map((o) => ({ value: o.optionId, label: optionLabel(o) })),
        },
        { name: 'rationale', label: 'Why it was rejected', type: 'textarea' },
      ],
      transform: ({ optionId: _optionId, ...rest }) => rest,
    },

    'cost-plan': {
      title: 'Open the concept cost plan',
      intent:
        'Opens a cost plan against the selected option, in the project reporting currency. Cost lines are added to it, ' +
        'and a rate with no source and base date is provisional and excluded from the high-confidence total.',
      path: `/v1/projects/${projectId}/concept/cost-plan`,
      submitLabel: 'Open',
      fields: [
        { name: 'baseDate', label: 'Price base date', type: 'date', value: todayIso() },
        {
          name: 'rangeMethod',
          label: 'Range method',
          type: 'select',
          required: false,
          placeholder: 'Platform default',
          options: RANGE_METHOD.map((value) => ({ value, label: humanise(value) })),
        },
        { name: 'budgetCapMinor', label: 'Budget cap', type: 'number', money: true, required: false },
        { name: 'tolerancePercent', label: 'Tolerance (%)', type: 'number', required: false },
      ],
    },

    programme: {
      title: 'Create the milestone programme',
      intent:
        'The milestones design works to. An undeclared open start or finish is refused — a date with no predecessor and ' +
        'no stated reason is a date nobody owns.',
      path: `/v1/projects/${projectId}/concept/programme`,
      submitLabel: 'Create',
      fields: [
        { name: 'dataDate', label: 'Data date', type: 'date', value: todayIso() },
        {
          name: 'milestones',
          label: 'Milestones',
          type: 'textarea',
          rows: 6,
          hint:
            'One per line: reference | name | plannedDate | predecessors (comma-separated) | openStartReason | ' +
            'openFinishReason | statutory (yes/no) | leadTimeDays. Leave a field empty to omit it. ' +
            'e.g. M-GW2 | Gateway 2 | 2027-05-01 | M-START |  |  | yes',
        },
      ],
      transform: (values) => ({
        dataDate: values.dataDate,
        milestones: lines(values.milestones).map((line) => {
          const [reference, name, plannedDate, predecessors, openStartReason, openFinishReason, statutory, leadTimeDays] =
            line.split('|').map((part) => part.trim());
          return {
            reference,
            name,
            plannedDate,
            ...(predecessors ? { predecessors: list(predecessors) } : {}),
            ...(openStartReason ? { openStartReason } : {}),
            ...(openFinishReason ? { openFinishReason } : {}),
            ...(statutory ? { statutory: truthy(statutory) } : {}),
            ...(leadTimeDays ? { leadTimeDays: Number(leadTimeDays) } : {}),
          };
        }),
      }),
    },

    cashflow: {
      title: 'Generate the cashflow',
      intent:
        'Time-phases the cost plan. A cashflow that does not reconcile to its own cost plan total is refused — the two ' +
        'numbers are the same money said two ways.',
      path: `/v1/projects/${projectId}/concept/cashflow`,
      submitLabel: 'Generate',
      fields: [
        {
          name: 'periods',
          label: 'Periods',
          type: 'textarea',
          rows: 5,
          hint:
            'One per line: period | spend (minor units) | funding (minor units, optional). The spend must total the ' +
            'cost plan. e.g. 2026-Q1 | 42000000 | 42000000',
        },
      ],
      transform: (values) => ({
        periods: lines(values.periods).map((line) => {
          const [period, spendMinor, fundingMinor] = line.split('|').map((part) => part.trim());
          return {
            period,
            spendMinor: Number(spendMinor),
            ...(fundingMinor ? { fundingMinor: Number(fundingMinor) } : {}),
          };
        }),
      }),
    },

    'approve-controls': {
      title: 'Approve cost, programme and cashflow',
      intent:
        'Approves the three together under one declared cut-off, so they cannot drift apart afterwards. The gate reads ' +
        'this as the single moment the controls were agreed.',
      path: `/v1/projects/${projectId}/concept/controls/approve`,
      submitLabel: 'Approve',
      fields: [
        { name: 'cutOffDate', label: 'Cut-off date', type: 'date', value: todayIso() },
        {
          name: 'affordabilityActions',
          label: 'Affordability actions',
          type: 'textarea',
          required: false,
          rows: 3,
          hint: 'One per line, where the estimate is over the budget cap.',
        },
        { name: 'evidenceHash', label: 'Controls pack', type: 'file' },
      ],
      transform: ({ affordabilityActions, ...rest }) => ({
        ...rest,
        ...(String(affordabilityActions ?? '').trim() ? { affordabilityActions: lines(affordabilityActions) } : {}),
      }),
    },

    'procurement-strategy': {
      title: 'Choose the procurement route',
      intent:
        'Scores the candidate routes against weighted criteria and records the chosen one with its rationale. A ' +
        'single-source route needs an authorised justification.',
      path: `/v1/projects/${projectId}/concept/procurement-strategy`,
      submitLabel: 'Choose',
      fields: [
        {
          name: 'weights',
          label: 'Criteria weights',
          type: 'textarea',
          rows: 3,
          hint: 'CRITERION:weight, comma- or newline-separated. Must sum to 1. e.g. SCOPE_CERTAINTY:0.3, TIME:0.3, PRICE_CERTAINTY:0.4',
        },
        {
          name: 'assessments',
          label: 'Route assessments',
          type: 'textarea',
          rows: 5,
          hint:
            'One route per line: ROUTE | CRITERION:score,CRITERION:score | note. ' +
            'e.g. DESIGN_AND_BUILD | SCOPE_CERTAINTY:5,TIME:8,PRICE_CERTAINTY:8 | Faster, less control',
        },
        {
          name: 'selectedRoute',
          label: 'Selected route',
          type: 'select',
          options: PROCUREMENT_ROUTE.map((value) => ({ value, label: humanise(value) })),
        },
        { name: 'rationale', label: 'Rationale', type: 'textarea' },
        { name: 'designResponsibility', label: 'Design responsibility', type: 'text' },
        { name: 'riskAppetite', label: 'Risk appetite', type: 'text' },
        {
          name: 'singleSourceJustification',
          label: 'Single-source justification',
          type: 'textarea',
          required: false,
          hint: 'Required only where the selected route is single-source.',
        },
        { name: 'singleSourceApprovedBy', label: 'Single-source approved by', type: 'text', required: false },
      ],
      transform: (values) => ({
        weights: pairs(values.weights, Number),
        assessments: lines(values.assessments).map((line) => {
          const [route, scores, ...note] = line.split('|').map((part) => part.trim());
          return { route, scores: pairs(scores, Number), note: note.join(' | ') };
        }),
        selectedRoute: values.selectedRoute,
        rationale: values.rationale,
        designResponsibility: values.designResponsibility,
        riskAppetite: values.riskAppetite,
        ...(String(values.singleSourceJustification ?? '').trim()
          ? { singleSourceJustification: values.singleSourceJustification }
          : {}),
        ...(String(values.singleSourceApprovedBy ?? '').trim()
          ? { singleSourceApprovedBy: values.singleSourceApprovedBy }
          : {}),
      }),
    },

    'package-strategy': {
      title: 'Approve the package strategy',
      intent:
        'The work split into packages, each with its enquiry and award dates and the milestone it is required on site ' +
        'for. A scope element in two packages, or in none, refuses the approval.',
      path: `/v1/projects/${projectId}/concept/package-strategy`,
      submitLabel: 'Approve',
      fields: [
        {
          name: 'worksScopeElements',
          label: 'Works scope elements',
          type: 'textarea',
          rows: 2,
          hint: 'Comma- or newline-separated. Every element must appear in exactly one package. e.g. CIVILS, MECHANICAL, ELECTRICAL',
        },
        {
          name: 'packages',
          label: 'Packages',
          type: 'textarea',
          rows: 6,
          hint:
            'One per line: reference | name | scopeElements (comma) | interfaces (comma) | ownerId | ' +
            'requiredOnSiteMilestoneRef | enquiryDate | awardDate | leadTimeWeeks. ' +
            'e.g. PKG-CIV | Civils | CIVILS | Hands slab to MEP | user-1 | M-SITE | 2026-06-01 | 2026-09-01 | 20',
        },
      ],
      transform: (values) => ({
        worksScopeElements: list(values.worksScopeElements),
        packages: lines(values.packages).map((line) => {
          const [
            reference, name, scopeElements, interfaces, ownerId,
            requiredOnSiteMilestoneRef, enquiryDate, awardDate, leadTimeWeeks,
          ] = line.split('|').map((part) => part.trim());
          return {
            reference,
            name,
            scopeElements: list(scopeElements),
            interfaces: list(interfaces),
            ownerId,
            requiredOnSiteMilestoneRef,
            enquiryDate,
            awardDate,
            leadTimeWeeks: Number(leadTimeWeeks),
          };
        }),
      }),
    },

    'contract-strategy': {
      title: 'Select the contract-form family',
      intent:
        'The contract family and option, its payment terms, insurances, bonds and the notices it turns on. Provisional ' +
        'until the executed contract is ingested and validated.',
      path: `/v1/projects/${projectId}/concept/contract-strategy`,
      submitLabel: 'Select',
      fields: [
        { name: 'contractFamily', label: 'Contract family', type: 'text', placeholder: 'NEC4' },
        { name: 'contractOption', label: 'Contract option', type: 'text', placeholder: 'Option C — target contract' },
        { name: 'paymentTerms', label: 'Payment terms', type: 'textarea' },
        {
          name: 'insuranceRequirements',
          label: 'Insurance requirements',
          type: 'textarea',
          rows: 2,
          hint: 'One per line.',
        },
        { name: 'bondsAndGuarantees', label: 'Bonds and guarantees', type: 'textarea', rows: 2, hint: 'One per line.' },
        { name: 'provisionalNotices', label: 'Provisional notices', type: 'textarea', rows: 2, hint: 'One per line.' },
      ],
      transform: (values) => ({
        contractFamily: values.contractFamily,
        contractOption: values.contractOption,
        paymentTerms: values.paymentTerms,
        insuranceRequirements: lines(values.insuranceRequirements),
        bondsAndGuarantees: lines(values.bondsAndGuarantees),
        provisionalNotices: lines(values.provisionalNotices),
      }),
    },

    'compliance-screen': {
      title: 'Screen the statutory regimes',
      intent:
        'Confirms which statutory regimes bind the project, by a named competent person and on a stated basis. An ' +
        'applicable regime must land on a non-bypassable milestone in the programme.',
      path: `/v1/projects/${projectId}/concept/compliance-screen`,
      submitLabel: 'Confirm',
      fields: [
        {
          name: 'regimes',
          label: 'Regimes',
          type: 'textarea',
          rows: 5,
          hint:
            'One per line: REGIME | applicable (yes/no) | basis | milestoneRef (for an applicable one). ' +
            'e.g. CDM_2015 | yes | Notifiable construction project | M-GW2',
        },
        { name: 'confirmedByName', label: 'Confirmed by', type: 'text' },
        { name: 'confirmedByRole', label: 'Their role', type: 'text' },
        { name: 'competenceBasis', label: 'Competence basis', type: 'textarea' },
        { name: 'evidenceHash', label: 'Screening pack', type: 'file' },
      ],
      transform: (values) => ({
        regimes: lines(values.regimes).map((line) => {
          const [regime, applicable, basis, milestoneRef] = line.split('|').map((part) => part.trim());
          return {
            regime,
            applicable: truthy(applicable),
            basis: basis ?? '',
            ...(milestoneRef ? { milestoneRef } : {}),
          };
        }),
        confirmedByName: values.confirmedByName,
        confirmedByRole: values.confirmedByRole,
        competenceBasis: values.competenceBasis,
        evidenceHash: values.evidenceHash,
      }),
    },

    'risk-review': {
      title: 'Approve the concept risk review',
      intent:
        'Approves the risk register for concept, reconciling the declared allowance against the RISK_ALLOWANCE in the ' +
        'cost plan. Two numbers for the same money is how a contingency gets counted twice, and it is refused.',
      path: `/v1/projects/${projectId}/concept/risk-review`,
      submitLabel: 'Approve',
      fields: [
        { name: 'declaredAllowanceMinor', label: 'Declared allowance', type: 'number', money: true },
        { name: 'retainedExposureNote', label: 'Retained exposure', type: 'textarea', hint: 'What the project is carrying.' },
        {
          name: 'escalated',
          label: 'Escalated risks',
          type: 'textarea',
          required: false,
          rows: 2,
          hint: 'One per line, where a risk is escalated above the project.',
        },
        {
          name: 'reconciliationToleranceMinor',
          label: 'Reconciliation tolerance',
          type: 'number',
          money: true,
          required: false,
        },
        { name: 'evidenceHash', label: 'Risk review pack', type: 'file' },
      ],
      transform: ({ escalated, ...rest }) => ({
        ...rest,
        ...(String(escalated ?? '').trim() ? { escalated: lines(escalated) } : {}),
      }),
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

  /*
   * Every command bar on the screen, not the first one.
   *
   * `querySelector` returns one element. A screen with more than one command
   * bar — and most of them have several, one per panel — wired the first and
   * left the rest inert: the buttons drew, they were not locked, they carried
   * their `data-command`, and pressing them did nothing at all. Reported as
   * "none of these work" on Pipeline & Bids, which renders six.
   *
   * Safe to bind every bar because the handler returns on an id this page does
   * not own, which is the pattern the evidence doors on this page already used
   * with `querySelectorAll` — one bar can carry buttons for two dispatchers.
   */
  /*
   * Delegated from the view, not from a `.cmd-bar` wrapper.
   *
   * `commandBar()` returns bare buttons. Whether they end up inside an element
   * classed `cmd-bar` is up to whichever page called it, and several wrap them
   * in `.actions` instead — so on those screens no listener was ever bound and
   * every button drew, unlocked, carrying its `data-command`, and did nothing.
   * That is seven commands on Concept, four on Field Modules and four more
   * elsewhere, all of them invisible to the suite because the markup is right
   * and only the binding is missing.
   *
   * Binding here removes the coupling rather than adding a second class to
   * remember. It is safe on both counts: the handler returns on an id this
   * page does not own, so two dispatchers can share one view, and `#view` is
   * a fresh element on every `draw()`, so listeners cannot stack.
   */
  root.addEventListener('click', async (event) => {
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

/**
 * Concept, as coverage and comparison.
 *
 * Due diligence is a coverage question before it is a list: the disciplines
 * nobody has surveyed are the ones the risk allowance is quietly carrying, and
 * a register of four completed surveys does not show the one that is missing.
 *
 * Options are a *profile* comparison, which is what the radar is for. A table
 * of scores invites a reader to total them and pick the biggest; the shape
 * shows that the cheapest option is also the one that scores worst on
 * buildability, and that is the trade-off the decision is actually about.
 */
function conceptCharts(diligence, options, compliance) {
  if (!diligence && !options) return '';

  const covered = diligence?.readiness?.covered ?? [];
  const uncovered = diligence?.readiness?.uncovered ?? [];

  // Every option scored on the same criteria, if the appraisal carries them.
  const appraised = (options?.options ?? []).filter((option) => option.scores && typeof option.scores === 'object');
  const criteria = appraised.length > 0 ? Object.keys(appraised[0].scores) : [];

  return html`
    <div class="grid g2" style="margin-bottom:14px">
      <div class="card">
        <h2>What has been surveyed, and what has not</h2>
        ${raw(
          gauge({
            title: 'Due-diligence coverage',
            value: Number(diligence?.readiness?.percent ?? 0),
            max: 100,
            format: (value) => `${Math.round(value)}%`,
            footnote:
              uncovered.length === 0
                ? `All ${covered.length} disciplines surveyed.`
                : `${uncovered.map((entry) => humanise(entry)).join(', ')} not surveyed. An unsurveyed discipline is a risk the allowance is carrying without being asked.`,
          }),
        )}
      </div>
      <div class="card">
        <h2>Where the investigations stand</h2>
        ${raw(
          barChart({
            title: 'Surveys and investigations',
            horizontal: true,
            data: [
              { label: 'Surveys live', value: Number(diligence?.liveSurveys ?? 0), tone: 'ok' },
              { label: 'Surveys expired', value: Number(diligence?.expiredSurveys ?? 0), tone: 'warn' },
              { label: 'Surveys superseded', value: Number(diligence?.supersededSurveys ?? 0) },
              { label: 'Constraints assessed', value: Number(diligence?.assessed ?? 0), tone: 'ok' },
              { label: 'Critical constraints open', value: Number(diligence?.criticalOpen ?? 0), tone: 'bad' },
              { label: 'Investigations open', value: Number(diligence?.investigationsOpen ?? 0), tone: 'warn' },
              { label: 'Investigations overdue', value: Number(diligence?.investigationsOverdue ?? 0), tone: 'bad' },
            ].filter((entry) => entry.value > 0),
            format: (value) => String(value),
            empty: 'No survey or constraint has been recorded.',
            footnote: compliance ? `Residual risk exposure ${money(compliance.residualExposureMinor)} against an allowance of ${money(compliance.costPlanAllowanceMinor)}.` : undefined,
          }),
        )}
      </div>
    </div>

    ${
      appraised.length > 1 && criteria.length >= 3
        ? html`<div class="card" style="margin-bottom:14px">
            <h2>How the options compare</h2>
            ${raw(
              radarChart({
                title: 'Option appraisal',
                axes: criteria.map((criterion) => humanise(criterion)),
                series: appraised.map((option) => ({
                  label: option.name ?? option.reference ?? '—',
                  values: criteria.map((criterion) => Number(option.scores[criterion] ?? 0)),
                })),
                format: (value) => String(value),
                empty: 'No option carries a comparable score.',
                footnote:
                  'Every axis is on the same scale deliberately. Scaling each one to its own best makes every option look ' +
                  'balanced, which flatters the one that is strong in a single place.',
              }),
            )}
          </div>`
        : ''
    }
  `;
}
