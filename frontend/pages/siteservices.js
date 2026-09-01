import { api } from '../lib/api.js';
import { command, commandBar } from '../lib/command.js';
import { badge, date, html, pct, raw, render, table, toast, track } from '../lib/ui.js';
import { head, refusal } from '../lib/estate.js';
import { blockedReason, can, modules, state } from '../app.js';

/**
 * ETABLIX site services — the appointment, and what it decides.
 *
 * The first screen of the module, and the one everything after it depends on.
 * ETABLIX delivers the same welfare, power, roads, cleaning, security and
 * transport under three completely different appointments, and almost every
 * argument on such a job traces back to somebody assuming one of them while
 * somebody else assumed another.
 *
 * So the screen leads with the seven control points rather than the model name.
 * "Management Integrator" tells a reader nothing; *the customer holds the
 * supplier contracts and ETABLIX administers their remedies* tells them the
 * thing they will be arguing about in month four.
 *
 * The two models not in force are shown beside the one that is. Before an
 * appointment exists that comparison is the choice somebody is making; after it
 * exists, it is what they gave up — and both readings are worth the space.
 */

const MODEL_TONE = {
  ADVISORY: 'info',
  MANAGEMENT_INTEGRATOR: 'warn',
  PRINCIPAL_SERVICE_CONTRACTOR: 'ai',
};

const MODEL_OPTIONS = [
  { value: 'ADVISORY', label: 'Advisory — ETABLIX defines, the customer contracts' },
  { value: 'MANAGEMENT_INTEGRATOR', label: 'Management Integrator — the customer contracts, ETABLIX runs it' },
  { value: 'PRINCIPAL_SERVICE_CONTRACTOR', label: 'Prime Service Contractor — ETABLIX contracts, pays and delivers' },
];

/** The ten factors the Model Fit agent scores, with the sentence each one means. */
const FIT_FIELDS = [
  ['customerDeliveryCapacity', 'Customer’s own delivery capacity', 'The customer has the people to run site services themselves'],
  ['programmeUrgency', 'Programme urgency', 'Mobilisation is needed sooner than a customer-run tender can deliver'],
  ['packageCount', 'Number of service packages', 'Many packages, so the interface load between them is high'],
  ['customerProcurementMaturity', 'Customer’s procurement maturity', 'The customer runs competent tenders and holds its own supplier terms'],
  ['etablixCreditStrength', 'ETABLIX credit strength', 'Facilities and balance sheet can carry a supply chain between payments'],
  ['supplierCreditTerms', 'Supplier credit terms available', 'Suppliers will trade on terms long enough to bridge the customer’s cycle'],
  ['contractRiskTransfer', 'Risk transfer asked for', 'The customer wants performance risk carried by somebody else'],
  ['geographicSupplyDepth', 'Depth of the local supply market', 'Several credible suppliers per package within reach of site'],
  ['operationalComplexity', 'Operational complexity', 'Shifts, accommodation, transport and 24-hour services running together'],
  ['singlePointAccountability', 'Single-point accountability required', 'The customer wants one party answerable for the whole outcome'],
];

const SCALE_HINT = '0 = not at all · 2 = partly · 4 = strongly. Score what the evidence says, not what would be convenient.';

export async function siteservices(root) {
  const position = await api
    .get(`/v1/projects/${state.session.projectId}/site-services/appointment`)
    .catch((error) => ({ error }));

  if (position.error) {
    render(root, html`${head({ title: 'Site Services' })}${refusal('The site-services appointment', position.error)}`);
    return;
  }

  const held = modules().find((entry) => entry.id === 'ETABLIX');
  const { appointment, profile, controlPoints, models, assessment } = position;

  render(
    root,
    html`
      ${head({
        title: 'Site Services',
        intent:
          held?.summary ??
          'The temporary infrastructure and the living environment: compounds, enabling civils, temporary MEP, welfare and accommodation, cleaning and FM, security, logistics and transport.',
        actions: commandBar([
          appointment
            ? {
                id: 'transition',
                label: 'Change the appointment',
                permitted: can('SITE_SERVICES', 'A'),
                reason: blockedReason('SITE_SERVICES', 'A'),
              }
            : {
                id: 'appoint',
                label: 'Appoint ETABLIX',
                tone: 'primary',
                permitted: can('SITE_SERVICES', 'C'),
                reason: blockedReason('SITE_SERVICES', 'C'),
              },
          appointment && !appointment.baselined
            ? {
                id: 'baseline',
                label: 'Baseline agreed',
                permitted: can('SITE_SERVICES', 'A'),
                reason: blockedReason('SITE_SERVICES', 'A'),
              }
            : null,
          {
            id: 'modelfit',
            label: 'Run model fit',
            permitted: can('SITE_SERVICES', 'C'),
            reason: blockedReason('SITE_SERVICES', 'C'),
          },
        ]),
      })}

      ${appointment
        ? html`
            <section class="grid g3" style="margin-bottom:14px">
              <div class="card">
                <h2>Appointment in force</h2>
                <div style="margin:8px 0">
                  ${badge(profile.label.split(' — ')[0], MODEL_TONE[appointment.model] ?? 'info')}
                </div>
                <div class="metric-sub">${profile.label.split(' — ')[1] ?? ''}</div>
                <div class="metric-sub" style="margin-top:6px">${appointment.basis}</div>
              </div>
              <div class="card">
                <h2>Who is on the other side</h2>
                <div class="split-list">
                  <div class="row"><span class="lbl">Contracting entity</span><span class="val">${appointment.contractingEntity}</span></div>
                  <div class="row"><span class="lbl">Funding source</span><span class="val">${appointment.fundingSource}</span></div>
                  <div class="row"><span class="lbl">Appointed</span><span class="val">${date(appointment.setAt)}</span></div>
                </div>
              </div>
              <div class="card">
                <h2>Baseline</h2>
                <div style="margin:8px 0">
                  ${appointment.baselined
                    ? badge(`agreed ${date(appointment.baselinedAt)}`, 'ok')
                    : badge('not yet agreed', 'warn')}
                </div>
                <div class="metric-sub">
                  ${appointment.baselined
                    ? 'A change of model from here is a commercial transition and needs the commercial basis recorded with it.'
                    : 'Until the baseline is agreed a change of model is an ordinary correction.'}
                </div>
              </div>
            </section>

            <div class="card" style="margin-bottom:14px">
              <h2>What this appointment decides</h2>
              <div class="metric-sub" style="margin:6px 0 12px">
                Seven control points. Each one is a question that gets assumed rather than agreed, and each answer
                below is the one this appointment actually gives.
              </div>
              ${controlPoints.map(
                (point) => html`<div class="lifespan-row" style="padding:10px 0;border-top:1px solid var(--line)">
                  <div style="display:flex;justify-content:space-between;gap:16px">
                    <b>${point.label}</b>
                    <span class="val" style="text-align:right;max-width:60%">${point.answer}</span>
                  </div>
                  <div class="metric-sub" style="margin-top:4px">${point.matters}</div>
                </div>`,
              )}
            </div>

            <div class="card" style="margin-bottom:14px">
              <h2>What ETABLIX may and may not do here</h2>
              <div class="split-list" style="margin-top:8px">
                <div class="row">
                  <span class="lbl">Instruct a supplier</span>
                  <span class="val">${profile.mayInstructSupplier ? badge('yes', 'ok') : badge('no', 'bad')}</span>
                </div>
                <div class="row">
                  <span class="lbl">Enforce a service level directly</span>
                  <span class="val">
                    ${profile.mayEnforceDirectly
                      ? badge('yes', 'ok')
                      : badge(profile.mayInstructSupplier ? 'administers the customer’s remedy' : 'no', 'warn')}
                  </span>
                </div>
                <div class="row">
                  <span class="lbl">Funds supplier cost</span>
                  <span class="val">${profile.fundsSupplierCost ? badge('yes', 'warn') : badge('no', 'ok')}</span>
                </div>
                <div class="row">
                  <span class="lbl">Highest class an agent may act at unattended</span>
                  <span class="val">
                    ${badge(
                      profile.agentCeiling === 'A' ? 'A — inside an approved baseline only' : 'B — prepare, then a person approves',
                      profile.agentCeiling === 'A' ? 'warn' : 'ok',
                    )}
                  </span>
                </div>
              </div>
              <div class="notice" style="margin-top:12px">
                <div><b>Cash exposure.</b> ${profile.cashRisk}</div>
              </div>
              <div class="notice warn" style="margin-top:8px">
                <div><b>Margin exposure.</b> ${profile.marginRisk}</div>
              </div>
            </div>

            ${appointment.history.length > 1
              ? html`<div class="card pad0" style="margin-bottom:14px">
                  <h2 style="padding:15px 17px 0">How the appointment got here</h2>
                  ${table({
                    headers: ['When', 'From', 'To', 'Why', 'Commercially'],
                    rows: appointment.history.map((entry) => [
                      date(entry.at),
                      entry.from ? MODEL_LABEL(models, entry.from) : '—',
                      MODEL_LABEL(models, entry.model),
                      entry.basis,
                      entry.commercialBasis ?? '—',
                    ]),
                  })}
                </div>`
              : ''}
          `
        : html`<div class="notice warn" style="margin-bottom:14px">
            <div>
              <b>No appointment yet.</b> Nothing else in this module can be decided until it is known which of the
              three ETABLIX is on this job — the answers below differ on every one of the seven control points.
            </div>
          </div>`}

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">The three appointments, side by side</h2>
        <div class="metric-sub" style="padding:6px 17px 0">
          ${appointment ? 'What the other two would have meant.' : 'The choice, in the terms it is actually argued in.'}
        </div>
        ${table({
          headers: ['Control point', ...models.map((entry) => entry.label.split(' — ')[0])],
          rows: controlPointRows(models),
        })}
      </div>

      ${assessment ? assessmentCard(assessment, models) : ''}
    `,
  );

  const again = () => siteservices(root);

  root.querySelector('.cmd-bar')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    const which = button.dataset.command;

    if (which === 'appoint') {
      const result = await command({
        title: 'Appoint ETABLIX',
        intent:
          'Which of the three appointments this is. It decides who holds the supplier contracts, who pays them, who ' +
          'coordinates the operation, who may enforce a service level and what ETABLIX is exposed to. Changing it ' +
          'later, once a baseline exists, is a commercial transition rather than an edit.',
        path: `/v1/projects/${state.session.projectId}/site-services/appointment`,
        submitLabel: 'Appoint',
        fields: [
          { name: 'model', label: 'Appointment model', type: 'select', options: MODEL_OPTIONS },
          {
            name: 'contractingEntity',
            label: 'Contracting entity',
            hint: 'The legal entity ETABLIX is appointed by. Without it there is nobody to enforce against and nobody to invoice.',
          },
          {
            name: 'fundingSource',
            label: 'Funding source',
            hint: 'Where the money comes from. Under Prime this is what ETABLIX is lending against.',
          },
          { name: 'basis', label: 'Why this model', type: 'textarea', hint: 'In the words it would be defended in' },
        ],
      });
      if (result) {
        toast('Appointed', `${result.model.replaceAll('_', ' ').toLowerCase()} · ${result.contractingEntity}`, 'ok');
        await again();
      }
      return;
    }

    if (which === 'baseline') {
      const result = await command({
        title: 'Baseline agreed',
        intent:
          'Records that the requirements baseline is settled. From here a change of appointment model is a governed ' +
          'commercial transition and will be refused without the commercial basis recorded against it.',
        path: `/v1/projects/${state.session.projectId}/site-services/appointment/baseline`,
        submitLabel: 'Record',
        fields: [],
      });
      if (result) {
        toast('Baseline agreed', 'A change of model from here needs a commercial basis.', 'ok');
        await again();
      }
      return;
    }

    if (which === 'transition') {
      const result = await command({
        title: 'Change the appointment',
        intent: appointment?.baselined
          ? 'The baseline is agreed, so this is a commercial transition: ETABLIX is taking on — or putting down — a ' +
            'supply chain, a cash exposure and a liability it did not have this morning. The commercial basis is required.'
          : 'No baseline yet, so this is a correction rather than a transition. It is still recorded as a change with a reason.',
        path: `/v1/projects/${state.session.projectId}/site-services/appointment/transition`,
        submitLabel: 'Apply',
        fields: [
          {
            name: 'model',
            label: 'New appointment model',
            type: 'select',
            options: MODEL_OPTIONS.filter((option) => option.value !== appointment?.model),
          },
          { name: 'basis', label: 'Why it is changing', type: 'textarea' },
          {
            name: 'commercialBasis',
            label: 'What was agreed commercially',
            type: 'textarea',
            required: Boolean(appointment?.baselined),
            hint: 'The fee change, who now holds the supplier contracts, and from when. Required once the baseline is agreed.',
          },
        ],
      });
      if (result) {
        toast('Appointment changed', result.model.replaceAll('_', ' ').toLowerCase(), 'ok');
        await again();
      }
      return;
    }

    if (which === 'modelfit') {
      const result = await command({
        title: 'Model fit assessment',
        intent:
          'Scores the three appointments against the evidence and produces a decision paper — never an appointment. ' +
          'All ten factors are required: a recommendation made on a subset is an opinion with arithmetic on it. A ' +
          'model whose viability gate fails is reported as blocked and cannot be recommended however well it scores.',
        path: `/v1/projects/${state.session.projectId}/site-services/model-fit`,
        submitLabel: 'Assess',
        transform: (values) => ({
          scores: Object.fromEntries(FIT_FIELDS.map(([id]) => [id, Number(values[id])])),
          evidence: {
            creditLimitMinor: numberOrUndefined(values.creditLimitMinor),
            mobilisationCashMinor: numberOrUndefined(values.mobilisationCashMinor),
            mobilisationCostMinor: numberOrUndefined(values.mobilisationCostMinor),
            insuranceCover: values.insuranceCover,
            bonds: values.bonds,
            delegatedAuthority: values.delegatedAuthority,
            paymentWorkflow: values.paymentWorkflow,
            advisoryOutputs: values.advisoryOutputs,
            procurementOwner: values.procurementOwner,
            handoverDate: values.handoverDate,
            postAwardResponsibilities: values.postAwardResponsibilities,
          },
          contractingEntity: values.contractingEntity,
          fundingSource: values.fundingSource,
        }),
        fields: [
          {
            name: 'contractingEntity',
            label: 'Contracting entity',
            required: false,
            value: appointment?.contractingEntity,
            hint: 'Leave blank if genuinely unknown — the assessment will then refuse to recommend anything, which is the honest answer.',
          },
          {
            name: 'fundingSource',
            label: 'Funding source',
            required: false,
            value: appointment?.fundingSource,
          },
          ...FIT_FIELDS.map(([id, label, high]) => ({
            name: id,
            label,
            type: 'number',
            hint: `${high}. ${SCALE_HINT}`,
          })),
          {
            name: 'mobilisationCostMinor',
            label: 'Mobilisation cost before recovery (pence)',
            type: 'number',
            required: false,
            hint: 'What it costs to mobilise before the first customer payment. The Prime treasury test runs against this.',
          },
          { name: 'creditLimitMinor', label: 'Credit facility available (pence)', type: 'number', required: false },
          { name: 'mobilisationCashMinor', label: 'Cash in hand to mobilise (pence)', type: 'number', required: false },
          { name: 'insuranceCover', label: 'Insurance cover in place', required: false },
          { name: 'bonds', label: 'Bond position', required: false, hint: '"None required" is an answer; silence is not.' },
          { name: 'delegatedAuthority', label: 'Delegated authority ETABLIX holds', required: false },
          { name: 'paymentWorkflow', label: 'Customer payment workflow', required: false },
          { name: 'advisoryOutputs', label: 'Advisory deliverables', required: false },
          { name: 'procurementOwner', label: 'Customer procurement owner', required: false },
          { name: 'handoverDate', label: 'Handover date', type: 'date', required: false },
          {
            name: 'postAwardResponsibilities',
            label: 'Post-award operational responsibilities',
            type: 'textarea',
            required: false,
            hint: 'Advisory ends at award unless this says otherwise, and that is exactly what gets assumed either way.',
          },
        ],
      });
      if (result) {
        toast(
          result.recommended ? 'Assessed' : 'No recommendation',
          result.recommended
            ? `${result.recommended.replaceAll('_', ' ').toLowerCase()}, with ${
                result.fallback ? result.fallback.replaceAll('_', ' ').toLowerCase() : 'no'
              } fallback`
            : result.refusedBecause,
          result.recommended ? 'ok' : 'warn',
        );
        await again();
      }
    }
  });
}

function numberOrUndefined(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function MODEL_LABEL(models, id) {
  return models.find((entry) => entry.model === id)?.label.split(' — ')[0] ?? id;
}

/** One row per control point, one column per model. Read across, not down. */
function controlPointRows(models) {
  const ids = Object.keys(models[0]?.answers ?? {});
  return ids.map((id) => [
    html`<b>${LABELS[id] ?? id}</b>`,
    ...models.map((entry) => entry.answers[id]),
  ]);
}

/**
 * The control-point labels, for the comparison table only.
 *
 * The appointment panel above gets its labels from the API, which is where they
 * belong. This table renders every model including the two not in force, and
 * the API sends those as an id-keyed map — so the heading has to be resolved
 * here. Kept to labels: nothing in this object is a rule.
 */
const LABELS = {
  SUPPLIER_CONTRACTING: 'Who holds the supplier contract',
  SUPPLIER_PAYMENT: 'Who pays the supplier',
  OPERATIONAL_COORDINATION: 'Who runs the operation day to day',
  PERFORMANCE_ENFORCEMENT: 'Who enforces performance',
  COMMERCIAL_EXPOSURE: 'What ETABLIX is exposed to',
  FEE_LOGIC: 'What ETABLIX is paid',
  INVOICE_OBJECT: 'What the customer receives',
};

function assessmentCard(assessment, models) {
  return html`
    <div class="card" style="margin-bottom:14px">
      <h2>Model fit — ${date(assessment.assessedAt)}</h2>
      <div class="metric-sub" style="margin:6px 0 12px">${assessment.standing}</div>

      ${assessment.refusedBecause
        ? html`<div class="notice bad" style="margin-bottom:12px">
            <div><b>No recommendation.</b> ${assessment.refusedBecause}</div>
          </div>`
        : html`<div class="notice ok" style="margin-bottom:12px">
            <div>
              <b>Recommended: ${MODEL_LABEL(models, assessment.recommended)}.</b>
              ${assessment.fallback
                ? `Fallback ${MODEL_LABEL(models, assessment.fallback)}.`
                : 'No fallback — every other model is blocked.'}
            </div>
          </div>`}

      ${assessment.viability.map(
        (entry) => html`<div style="padding:12px 0;border-top:1px solid var(--line)">
          <div style="display:flex;justify-content:space-between;gap:16px;align-items:baseline">
            <b>${entry.label}</b>
            <span>
              ${entry.viable ? badge('viable', 'ok') : badge('blocked', 'bad')}
              ${entry.score > 0 ? `${pct(entry.fitPercent)} fit` : 'argued against'}
            </span>
          </div>
          <!--
            The bar is clamped at zero and the raw score is not. A model the
            evidence argues *against* scores negative, and showing only the
            percentage rendered that identically to a model nothing was said
            about — "viable, 0.0% fit" beside a bar at zero reads as neutral
            when it is the opposite. The score is stated alongside so the two
            cannot be confused.
          -->
          ${track(entry.fitPercent, entry.viable ? 'ok' : 'bad')}
          <div class="metric-sub" style="margin-top:4px">
            Raw score ${entry.score > 0 ? `+${entry.score}` : entry.score} across the ten factors.
            ${entry.score <= 0 ? 'The evidence argues against this appointment, not merely not for it.' : ''}
          </div>
          <div class="metric-sub" style="margin-top:6px"><b>Gate.</b> ${entry.gate}</div>
          ${entry.blockers.map((blocker) => html`<div class="metric-sub bad" style="margin-top:4px">· ${blocker}</div>`)}
        </div>`,
      )}

      <h2 style="margin-top:16px">What each factor contributed</h2>
      ${table({
        headers: ['Factor', 'Score', ...models.map((entry) => entry.label.split(' — ')[0])],
        align: ['', 'num', 'num', 'num', 'num'],
        rows: assessment.factors.map((factor) => [
          html`${factor.label}<div class="metric-sub">${factor.high}</div>`,
          `${factor.score} / 4`,
          ...models.map((entry) => signed(factor.contribution[entry.model])),
        ]),
      })}
    </div>
  `;
}

/** A contribution reads as a direction, not a magnitude, so the sign is kept. */
function signed(value) {
  if (value === 0) return raw('<span class="metric-sub">0</span>');
  return html`<span class="${value > 0 ? 'ok' : 'bad'}">${value > 0 ? `+${value}` : value}</span>`;
}
