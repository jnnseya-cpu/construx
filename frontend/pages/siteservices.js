import { api } from '../lib/api.js';
import { command, commandBar } from '../lib/command.js';
import { badge, date, html, money, pct, raw, render, table, toast, track } from '../lib/ui.js';
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
  const [position, readiness, structure] = await Promise.all([
    api.get(`/v1/projects/${state.session.projectId}/site-services/appointment`).catch((error) => ({ error })),
    api.get(`/v1/projects/${state.session.projectId}/site-services/brief`).catch((error) => ({ error })),
    api.get(`/v1/projects/${state.session.projectId}/site-services/sbs`).catch((error) => ({ error })),
  ]);

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
          {
            id: 'fact',
            label: 'Record a brief fact',
            permitted: can('SITE_SERVICES', 'C'),
            reason: blockedReason('SITE_SERVICES', 'C'),
          },
          {
            id: 'assume',
            label: 'Assume a value',
            permitted: can('SITE_SERVICES', 'C'),
            reason: blockedReason('SITE_SERVICES', 'C'),
          },
          {
            id: 'compose',
            label: 'Compose a system',
            permitted: can('SITE_SERVICES', 'C'),
            reason: blockedReason('SITE_SERVICES', 'C'),
          },
          {
            id: 'interface',
            label: 'Take an interface',
            permitted: can('SITE_SERVICES', 'U'),
            reason: blockedReason('SITE_SERVICES', 'U'),
          },
          {
            id: 'accept',
            label: 'Close an interface',
            permitted: can('SITE_SERVICES', 'A'),
            reason: blockedReason('SITE_SERVICES', 'A'),
          },
          {
            id: 'recompose',
            label: 'Recompose a system',
            permitted: can('SITE_SERVICES', 'A'),
            reason: blockedReason('SITE_SERVICES', 'A'),
          },
          {
            id: 'observe',
            label: 'Record what it consumed',
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
              <h2>What ETABLIX undertakes to do</h2>
              <div class="metric-sub" style="margin:6px 0 4px">
                <b>${profile.headline}</b> ${profile.fee}.
              </div>
              ${profile.undertakes.map(
                (pillar) => html`<div style="padding:10px 0;border-top:1px solid var(--line)">
                  <b>${pillar.pillar}</b>
                  <div class="metric-sub" style="margin-top:4px">${pillar.detail}</div>
                </div>`,
              )}
              <div class="notice" style="margin-top:12px"><div>${profile.chooseWhen}</div></div>
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
              <div class="split-list" style="margin-top:12px">
                <div class="row">
                  <span class="lbl">Delegated instruction limit</span>
                  <span class="val">
                    ${profile.approvals.delegatedInstructionMinor > 0
                      ? money(profile.approvals.delegatedInstructionMinor)
                      : badge('nothing delegated', 'warn')}
                  </span>
                </div>
                <div class="row"><span class="lbl">Above it</span><span class="val">${profile.approvals.above}</span></div>
                <div class="row">
                  <span class="lbl">Insurance ETABLIX must evidence</span>
                  <span class="val">${profile.insuranceRequired.join(' · ')}</span>
                </div>
              </div>
              <div class="notice warn" style="margin-top:12px">
                <div>
                  <b>Never delegated, under any model.</b> ${profile.approvals.neverDelegated.join(' · ')}. An agent
                  may prepare any of these and may not take one.
                </div>
              </div>
              <div class="notice" style="margin-top:8px">
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

      ${readiness.error ? refusal('Brief readiness', readiness.error) : briefCard(readiness)}

      ${structure.error ? refusal('The system breakdown structure', structure.error) : sbsCard(structure)}

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

    if (which === 'fact' || which === 'assume') {
      // The picker offers only what is not already settled, and each option
      // says what the gap decides. A dropdown of twenty-five item names tells
      // somebody nothing about which one to answer first.
      const options = (readiness.error ? [] : readiness.interview).map((gap) => ({
        value: gap.itemId,
        label: `${gap.label} (${gap.unit})${gap.provisionalValue !== undefined ? ' — currently assumed' : ''}`,
      }));
      if (options.length === 0) {
        toast('Nothing outstanding', 'Every fact this brief needs is already settled.', 'ok');
        return;
      }

      const assuming = which === 'assume';
      const result = await command({
        title: assuming ? 'Assume a value' : 'Record a brief fact',
        intent: assuming
          ? 'Records an assumption as an assumption. It is tagged, it names what it was assumed on, and it carries a ' +
            'decision date and an owner — because an assumption nobody owns and nothing expires stops being questioned ' +
            'and quietly becomes the design.'
          : 'A number the brief actually establishes, with the document, drawing or conversation it came from. ' +
            'Recording over an existing figure supersedes it rather than replacing it: a number that changed silently ' +
            'is how two teams end up working to different ones.',
        // Two whole paths rather than one with the last segment interpolated.
        // The doors invariant matches the literal a screen calls, and a path
        // whose last segment is an expression matches no route — which is the
        // same shape as a screen calling an endpoint that does not exist.
        path: assuming
          ? `/v1/projects/${state.session.projectId}/site-services/brief/assumption`
          : `/v1/projects/${state.session.projectId}/site-services/brief/fact`,
        submitLabel: assuming ? 'Assume' : 'Record',
        transform: (values) => {
          const numeric = values.value !== '' && Number.isFinite(Number(values.value));
          const body = { itemId: values.itemId, value: numeric ? Number(values.value) : values.value };
          return assuming
            ? { ...body, basis: values.basis, decideBy: values.decideBy, owner: values.owner }
            : { ...body, source: values.source };
        },
        fields: [
          { name: 'itemId', label: 'Which fact', type: 'select', options },
          {
            name: 'value',
            label: 'Value',
            hint: 'A number for anything the demand engine calculates; a date as YYYY-MM-DD; text for a standard.',
          },
          ...(assuming
            ? [
                { name: 'basis', label: 'Assumed on what basis', type: 'textarea' },
                {
                  name: 'decideBy',
                  label: 'Decide by',
                  type: 'date',
                  hint: 'After this date the assumption is too late to change — it has become the design.',
                },
                { name: 'owner', label: 'Whose answer replaces it', hint: 'A person, not a team' },
              ]
            : [
                {
                  name: 'source',
                  label: 'Source',
                  hint: 'The document, drawing revision or conversation. The argument in month six is always about where a number came from.',
                },
              ]),
        ],
      });

      if (result) {
        toast(
          assuming ? 'Assumed' : 'Recorded',
          `${result.itemId} = ${result.value} ${result.unit}${assuming ? ` · ${result.owner} by ${result.decideBy}` : ''}`,
          assuming ? 'warn' : 'ok',
        );
        await again();
      }
      return;
    }

    if (which === 'compose') {
      // Only the families with no system yet. Composing a second for the same
      // zone is refused, and offering it would be offering a refusal.
      const options = (structure.error ? [] : structure.uncomposed).map((entry) => ({
        value: entry.family,
        label: entry.label,
      }));
      const result = await command({
        title: 'Compose a service system',
        intent:
          'Freezes the design basis for one family in one zone — every capacity with the formula, the inputs and the ' +
          'rates behind it — and raises the interfaces it cannot be built without, open and unowned. Capacity is ' +
          'zone-specific: two compounds are two systems, and merging them hides the one that is short.',
        path: `/v1/projects/${state.session.projectId}/site-services/system`,
        submitLabel: 'Compose',
        transform: (values) => ({ ...values, leadDays: Number(values.leadDays) }),
        fields: [
          {
            name: 'family',
            label: 'Service family',
            type: 'select',
            options: options.length > 0 ? options : [{ value: '', label: 'Every family is already composed' }],
          },
          { name: 'zone', label: 'Zone', hint: 'Where on site. Two compounds are two systems.' },
          { name: 'fromDate', label: 'Operational from', type: 'date' },
          { name: 'toDate', label: 'No longer needed after', type: 'date' },
          {
            name: 'leadDays',
            label: 'Lead time in days',
            type: 'number',
            hint: 'Between ordering it and it being usable. Zero is an answer; absent is not.',
          },
        ],
      });
      if (result) {
        toast('Composed', `${result.system.label} — ${result.system.zone}`, 'ok');
        await again();
      }
      return;
    }

    if (which === 'recompose') {
      const options = (structure.error ? [] : structure.systems).map((system) => ({
        value: system.id,
        label: `${system.label} — ${system.zone}${system.drift.length > 0 ? ` (${system.drift.length} drifted)` : ''}`,
      }));
      if (options.length === 0) {
        toast('Nothing composed', 'There is no service system to recompose yet.', 'warn');
        return;
      }
      const result = await command({
        title: 'Recompose a system',
        intent:
          'Re-freezes the design basis against the brief as it now stands. The version it was ordered against stays on ' +
          'the record — that is the whole point of freezing one.',
        path: `/v1/projects/${state.session.projectId}/site-services/system/recompose`,
        submitLabel: 'Recompose',
        fields: [
          { name: 'systemId', label: 'System', type: 'select', options },
          { name: 'reason', label: 'Why the basis is changing', type: 'textarea' },
        ],
      });
      if (result) {
        toast('Recomposed', `${result.label} now at version ${result.version}`, 'ok');
        await again();
      }
      return;
    }

    if (which === 'interface' || which === 'accept') {
      const closing = which === 'accept';
      const open = (structure.error ? [] : structure.systems).flatMap((system) =>
        system.interfaces
          .filter((entry) => (closing ? entry.status === 'OPEN' && entry.owner : entry.status === 'OPEN'))
          .map((entry) => ({
            value: entry.id,
            label: `${entry.name} — ${system.label}, ${system.zone}${entry.owner ? ` (${entry.owner})` : ' — unowned'}`,
          })),
      );
      if (open.length === 0) {
        toast(
          closing ? 'Nothing to close' : 'Nothing open',
          closing
            ? 'Every open interface still needs an owner before it can be accepted.'
            : 'No interface is open. Compose a system to raise its matrix.',
          'warn',
        );
        return;
      }

      const result = await command({
        title: closing ? 'Close an interface' : 'Take an interface',
        intent: closing
          ? 'Acceptance, not an update. Say what closes it — the drawing, the survey, the consent or the agreement. ' +
            '"Accepted" on its own proves nothing later.'
          : 'An owner and a date together. Either alone is unmanageable: an owner with no date cannot be late, and a ' +
            'date with no owner is nobody’s.',
        path: closing
          ? `/v1/projects/${state.session.projectId}/site-services/interface/accept`
          : `/v1/projects/${state.session.projectId}/site-services/interface`,
        submitLabel: closing ? 'Accept' : 'Take it',
        fields: [
          { name: 'interfaceId', label: 'Interface', type: 'select', options: open },
          ...(closing
            ? [{ name: 'note', label: 'What closes it', type: 'textarea' }]
            : [
                { name: 'owner', label: 'Owner', hint: 'A person, not a team' },
                { name: 'dueDate', label: 'Due', type: 'date' },
                { name: 'counterparty', label: 'Other side', required: false, hint: 'The system or party it is with' },
              ]),
        ],
      });
      if (result) {
        toast(closing ? 'Interface closed' : 'Interface taken', result.name, closing ? 'ok' : '');
        await again();
      }
      return;
    }

    if (which === 'observe') {
      const options = (structure.error ? [] : structure.demand.derivations).map((derivation) => ({
        value: derivation.id,
        label: `${derivation.label} — basis ${derivation.normal} ${derivation.unit}`,
      }));
      if (options.length === 0) {
        toast('Nothing sized yet', 'There is no design basis to measure against.', 'warn');
        return;
      }
      const result = await command({
        title: 'Record what it consumed',
        intent:
          'A meter reading, a tanker ticket or a count. What follows from it is a proposal: consumption below the ' +
          'basis does not reduce the basis, because that is what the service was sized, contracted and priced against.',
        path: `/v1/projects/${state.session.projectId}/site-services/observation`,
        submitLabel: 'Record',
        transform: (values) => ({ ...values, observed: Number(values.observed) }),
        fields: [
          { name: 'derivationId', label: 'Against which capacity', type: 'select', options },
          { name: 'observed', label: 'Observed', type: 'number' },
          { name: 'over', label: 'Measured over', hint: 'The period — a day, a week, the four weeks to a date' },
          { name: 'source', label: 'Source', hint: 'The meter, the ticket or the count' },
        ],
      });
      if (result) {
        toast('Recorded', `${result.derivationId} = ${result.observed} over ${result.over}`, 'ok');
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

/**
 * Brief readiness, with the percentage kept firmly in its place.
 *
 * The specification forbids reporting completeness as a percentage alone, and
 * the reason is visible the moment you try: 72% reads as *mostly fine*, which is
 * the opposite of true when the missing 28% is the electrical load and the
 * water storage. So the number is a caption and the gaps are the content —
 * every one carrying what it decides, when the answer arrives too late, what is
 * being assumed in the meantime, and whose answer it is.
 *
 * Conflicts sit above completeness, because a contradiction between two facts
 * that are both recorded is worse than a fact that is missing: nobody is
 * looking for it.
 */
function briefCard(readiness) {
  const { families, percentKnown, conflicts, overdue, interview } = readiness;
  return html`
    <div class="card" style="margin-bottom:14px">
      <h2>Brief readiness</h2>
      <div class="metric-sub" style="margin:6px 0 12px">
        ${pct(percentKnown)} of the ${families.reduce((sum, family) => sum + family.items, 0)} facts a site-services
        system is designed from are settled. The percentage is a caption, not the answer — what each gap decides is
        below it.
      </div>

      ${conflicts.length > 0
        ? html`<div style="margin-bottom:14px">
            <h2>What contradicts what</h2>
            <div class="metric-sub" style="margin:6px 0 10px">
              Both figures in each of these is recorded. A contradiction between two facts is worse than a missing one,
              because nobody is looking for it.
            </div>
            ${conflicts.map(
              (conflict) => html`<div class="notice ${conflict.severity === 'BLOCKING' ? 'bad' : 'warn'}" style="margin-bottom:8px">
                <div>
                  <b>${conflict.statement}</b><br />
                  ${conflict.resolution}
                </div>
              </div>`,
            )}
          </div>`
        : html`<div class="notice ok" style="margin-bottom:14px">
            <div>Nothing recorded contradicts anything else recorded. Checks only run where both figures exist.</div>
          </div>`}

      ${overdue.length > 0
        ? html`<div class="notice bad" style="margin-bottom:14px">
            <div>
              <b>${overdue.length} provisional value${overdue.length === 1 ? '' : 's'} past the decision date.</b>
              ${overdue.map((gap) => `${gap.label} (${gap.owner ?? 'unowned'}, due ${gap.latestAnswer})`).join(' · ')}
            </div>
          </div>`
        : ''}

      ${families.map(
        (family) => html`<div style="padding:12px 0;border-top:1px solid var(--line)">
          <div style="display:flex;justify-content:space-between;gap:16px;align-items:baseline">
            <b>${family.label}</b>
            <span>
              ${family.known} settled${family.provisional > 0 ? ` · ${family.provisional} assumed` : ''}${
                family.missing > 0 ? ` · ${family.missing} unanswered` : ''
              }
            </span>
          </div>
          ${track(family.percentKnown, family.percentKnown === 100 ? 'ok' : family.missing > 0 ? 'bad' : 'warn')}
          ${family.gaps.length > 0
            ? table({
                headers: ['Not settled', 'What it decides', 'Assumed meanwhile', 'Answer by', 'Whose'],
                rows: family.gaps.map((gap) => [
                  html`${gap.label}
                    <div class="metric-sub">${gap.changes.join(' · ').toLowerCase()}</div>`,
                  gap.decides,
                  gap.provisionalValue !== undefined
                    ? html`<b>${gap.provisionalValue} ${gap.unit}</b>
                        <div class="metric-sub">${gap.provisionalAssumption}</div>`
                    : html`<span class="metric-sub">${gap.provisionalAssumption}</span>`,
                  gap.latestAnswer ?? badge('no date', 'warn'),
                  gap.owner ?? badge('unowned', 'warn'),
                ]),
              })
            : html`<div class="metric-sub" style="margin-top:6px">Every fact this family needs is settled.</div>`}
        </div>`,
      )}

      ${interview.length > 0
        ? html`<div style="padding:14px 0 0;border-top:1px solid var(--line)">
            <h2>The next questions worth asking</h2>
            <div class="metric-sub" style="margin:6px 0 10px">
              Only the ones that change capacity, cost, risk, sequence, contract or acceptance, soonest deadline first.
              Nothing here is general discovery.
            </div>
            ${interview
              .slice(0, 5)
              .map(
                (gap, index) => html`<div class="metric-sub" style="margin-top:6px">
                  <b>${index + 1}.</b> ${QUESTIONS[gap.itemId] ?? gap.label}
                </div>`,
              )}
          </div>`
        : ''}
    </div>
  `;
}

/**
 * The system breakdown structure, and the two things it exists to show.
 *
 * **The design basis, frozen.** Every capacity carries the formula it came
 * from, the inputs with their sources, and the rates applied with the basis
 * each rests on. A screen showing "7 WCs" cannot answer *seven from what*, and
 * that is the only question anybody asks six months later.
 *
 * **What has moved since.** The compound was ordered against the numbers as
 * they stood on a particular Tuesday, and the brief has not stopped. Drift is
 * the difference, and it is the thing that decides whether an order is still
 * right.
 */
function sbsCard(structure) {
  const { systems, uncomposed, demand, deployment, reforecasts, interfaceMatrix } = structure;

  return html`
    <div class="card" style="margin-bottom:14px">
      <h2>System breakdown structure</h2>
      <div class="metric-sub" style="margin:6px 0 12px">
        ${systems.length} of ${systems.length + uncomposed.length} service families composed. Each carries the demand
        basis it was frozen against, the interfaces it cannot be built without, and what has to be removed at the end.
      </div>

      ${deployment.length > 0
        ? html`<div style="margin-bottom:14px">
            ${deployment.map(
              (entry) => html`<div class="notice ${entry.kind === 'PREMATURE_REMOVAL' ? 'bad' : 'warn'}" style="margin-bottom:8px">
                <div>
                  <b>${humaniseKind(entry.kind)}.</b> ${entry.statement}<br />
                  ${entry.resolution}
                </div>
              </div>`,
            )}
          </div>`
        : ''}

      ${reforecasts.length > 0
        ? html`<div style="margin-bottom:14px">
            <h2>Observed against basis</h2>
            ${reforecasts.map(
              (entry) => html`<div class="notice ${entry.reducesBaseline ? 'warn' : 'bad'}" style="margin-bottom:8px">
                <div>
                  <b>${entry.label}: ${entry.observed} against a basis of ${entry.basis} ${entry.unit}
                  (${entry.variancePercent > 0 ? '+' : ''}${pct(entry.variancePercent)}).</b><br />
                  ${entry.proposal}
                  ${entry.requiresApproval ? html`<br /><b>${entry.requiresApproval}</b>` : ''}
                </div>
              </div>`,
            )}
          </div>`
        : ''}

      ${systems.map(
        (system) => html`<div style="padding:14px 0;border-top:1px solid var(--line)">
          <div style="display:flex;justify-content:space-between;gap:16px;align-items:baseline">
            <b>${system.label} — ${system.zone}</b>
            <span>
              ${badge(`v${system.version}`, 'info')}
              ${system.openInterfaces > 0
                ? badge(`${system.openInterfaces} interfaces open`, 'warn')
                : badge('interfaces closed', 'ok')}
              ${system.drift.length > 0 ? badge(`${system.drift.length} drifted`, 'bad') : ''}
            </span>
          </div>
          <div class="metric-sub" style="margin-top:4px">
            On site ${date(system.fromDate)} to ${date(system.toDate)} · ${system.leadDays} days lead
          </div>

          ${system.drift.length > 0
            ? html`<div class="notice bad" style="margin-top:10px">
                <div>
                  <b>The brief has moved since this was sized.</b>
                  ${system.drift.map(
                    (entry) =>
                      html`<br />${entry.label}: ${entry.composedAt} → ${entry.now} ${entry.unit}
                        (${entry.changePercent > 0 ? '+' : ''}${pct(entry.changePercent)}). ${entry.consequence}`,
                  )}
                </div>
              </div>`
            : ''}

          ${system.basis.length > 0
            ? html`<div style="margin-top:10px">
                ${table({
                  headers: ['Capacity', 'Normal', 'Peak', 'Held in reserve', 'Because'],
                  align: ['', 'num', 'num', '', ''],
                  rows: system.basis.map((derivation) => [
                    html`${derivation.label}
                      <div class="metric-sub mono">${derivation.formula}</div>
                      ${derivation.inputs.map(
                        (input) =>
                          html`<div class="metric-sub">
                            ${input.label}: ${input.value} ${input.unit}
                            ${input.status === 'PROVISIONAL' ? badge('assumed', 'warn') : ''} · ${input.source}
                          </div>`,
                      )}
                      ${derivation.assumptions.map(
                        (assumption) =>
                          html`<div class="metric-sub">
                            ${assumption.name} = ${assumption.value}${assumption.unit ? ` ${assumption.unit}` : ''} —
                            ${assumption.basis}
                          </div>`,
                      )}`,
                    `${derivation.normal} ${derivation.unit}`,
                    `${derivation.peak} ${derivation.unit}`,
                    `${derivation.continuity} ${derivation.continuityUnit}`,
                    html`${derivation.continuityBasis}
                      ${derivation.exceptions.map(
                        (exception) => html`<div class="metric-sub bad" style="margin-top:4px">· ${exception}</div>`,
                      )}`,
                  ]),
                })}
              </div>`
            : html`<div class="metric-sub" style="margin-top:8px">
                Sized on scope and sequence rather than capacity. The interfaces are what this family turns on.
              </div>`}

          <div class="metric-sub" style="margin-top:10px"><b>Removal obligation.</b> ${system.removalObligation}</div>
          <div class="metric-sub" style="margin-top:6px">
            <b>Not yet populated.</b>
            ${system.awaiting.map((entry) => `${entry.field} — ${entry.from}`).join(' · ')}
          </div>
        </div>`,
      )}

      ${interfaceMatrix.length > 0
        ? html`<div style="padding:14px 0 0;border-top:1px solid var(--line)">
            <h2>Interface matrix</h2>
            <div class="metric-sub" style="margin:6px 0 10px">
              Rolled up by name across every zone, because "who owns ground bearing on this job" is asked once.
            </div>
            ${table({
              headers: ['Interface', 'Open', 'Unowned', 'Accepted'],
              align: ['', 'num', 'num', 'num'],
              rows: interfaceMatrix.map((entry) => [
                entry.name,
                entry.open,
                entry.unowned > 0 ? badge(String(entry.unowned), 'bad') : '0',
                entry.accepted,
              ]),
            })}
          </div>`
        : ''}

      ${uncomposed.length > 0
        ? html`<div class="notice warn" style="margin-top:14px">
            <div>
              <b>${uncomposed.length} famil${uncomposed.length === 1 ? 'y has' : 'ies have'} no system.</b>
              ${uncomposed.map((entry) => entry.label).join(' · ')}. Absent is not the same as complete.
            </div>
          </div>`
        : ''}

      ${demand.notDerivable.length > 0
        ? html`<div class="metric-sub" style="margin-top:12px">
            <b>Cannot be derived yet:</b>
            ${demand.notDerivable.map((entry) => `${entry.label} (needs ${entry.missing.join(', ')})`).join(' · ')}
          </div>`
        : ''}
    </div>
  `;
}

function humaniseKind(kind) {
  return (
    {
      STRANDED_HIRE: 'Stranded hire',
      PREMATURE_REMOVAL: 'Premature removal',
      LEAD_TIME_MISSED: 'Lead time already gone',
    }[kind] ?? kind
  );
}

/**
 * The interview questions, keyed by item.
 *
 * Held here rather than sent with each gap because the readiness response
 * already carries four fields per gap and the question is the fifth thing only
 * this panel needs. Nothing in this object is a rule — the *list* of questions
 * to ask is decided by the server, and this only supplies the wording.
 */
const QUESTIONS = {
  peakWorkforce: 'What is the peak number of people on site in a single day, across all shifts and trades?',
  shiftOverlapPersons: 'How many people are on site at once during the busiest shift changeover?',
  visitorsPerDay: 'How many visitors, delivery drivers and inspectors come through the gate on a busy day?',
  operatingHours: 'What hours is the site live — single shift, double shift, or continuous?',
  wcProvision: 'How many WCs does the current welfare layout provide?',
  accommodatedWorkers: 'How many of the workforce need accommodation rather than travelling daily?',
  roomsAvailable: 'How many rooms does the accommodation provide?',
  occupancyPerRoom: 'Is the rooming policy single occupancy, or shared — and if shared, how many to a room?',
  maximumDemandKva: 'What is the maximum electrical demand, after diversity, across the whole site at peak?',
  suppliedKva: 'What supply is actually secured — grid connection, generation, or both?',
  waterStorageHours: 'How many hours of potable water does on-site storage hold at peak draw?',
  tankerIntervalHours: 'How often can a tanker actually reach the site, allowing for access restrictions?',
  compoundAreaSqm: 'What area is available for the compound, and is it available for the whole programme?',
  groundBearingKpa: 'What is the ground bearing capacity across the compound area?',
  reinstatementStandard: 'What condition must the land be returned in, and against what record?',
  cleanableAreaSqm: 'What floor area is cleaned, and to what standard in each zone?',
  wasteVolumeM3PerWeek: 'What waste volume does the site produce weekly, split by stream?',
  wasteContainerCapacityM3: 'What total container capacity is on site, and how often is it emptied?',
  wasteCollectionsPerWeek: 'How many waste collections per week can the site actually take?',
  securityHoursCovered: 'How many hours a day is the security post manned?',
  gateThroughputPerHour: 'How many people per hour can the access control actually process?',
  travellingWorkforce: 'How many people per shift arrive by site transport rather than their own vehicle?',
  busSeatsPerShift: 'How many seats does the scheduled transport provide per shift?',
  packageCount: 'How many separate service packages will be let, and by whom?',
  firstMobilisationDate: 'When does the first service have to be operational on site?',
};

/** A contribution reads as a direction, not a magnitude, so the sign is kept. */
function signed(value) {
  if (value === 0) return raw('<span class="metric-sub">0</span>');
  return html`<span class="${value > 0 ? 'ok' : 'bad'}">${value > 0 ? `+${value}` : value}</span>`;
}
