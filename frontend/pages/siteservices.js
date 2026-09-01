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
  const [position, readiness, structure, tower, factory] = await Promise.all([
    api.get(`/v1/projects/${state.session.projectId}/site-services/appointment`).catch((error) => ({ error })),
    api.get(`/v1/projects/${state.session.projectId}/site-services/brief`).catch((error) => ({ error })),
    api.get(`/v1/projects/${state.session.projectId}/site-services/sbs`).catch((error) => ({ error })),
    api.get(`/v1/projects/${state.session.projectId}/site-services/mobilisation`).catch((error) => ({ error })),
    api.get(`/v1/projects/${state.session.projectId}/site-services/procurement`).catch((error) => ({ error })),
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
          {
            id: 'attest',
            label: 'Attest gate evidence',
            permitted: can('SITE_SERVICES', 'C'),
            reason: blockedReason('SITE_SERVICES', 'C'),
          },
          {
            id: 'withdraw',
            label: 'Withdraw evidence',
            permitted: can('SITE_SERVICES', 'U'),
            reason: blockedReason('SITE_SERVICES', 'U'),
          },
          {
            id: 'gate',
            label: 'Pass a gate',
            permitted: can('SITE_SERVICES', 'A'),
            reason: blockedReason('SITE_SERVICES', 'A'),
          },
          {
            id: 'declare',
            label: 'Record a supplier declaration',
            permitted: can('SITE_SERVICES', 'C'),
            reason: blockedReason('SITE_SERVICES', 'C'),
          },
          {
            id: 'packaging',
            label: 'Argue the packaging',
            permitted: can('SITE_SERVICES', 'C'),
            reason: blockedReason('SITE_SERVICES', 'C'),
          },
          {
            id: 'package',
            label: 'Create a package',
            permitted: can('SITE_SERVICES', 'C'),
            reason: blockedReason('SITE_SERVICES', 'C'),
          },
          {
            id: 'field',
            label: 'State a package field',
            permitted: can('SITE_SERVICES', 'U'),
            reason: blockedReason('SITE_SERVICES', 'U'),
          },
          {
            id: 'issue',
            label: 'Issue to tender',
            permitted: can('SITE_SERVICES', 'A'),
            reason: blockedReason('SITE_SERVICES', 'A'),
          },
          {
            id: 'bid',
            label: 'Record a return',
            permitted: can('SITE_SERVICES', 'C'),
            reason: blockedReason('SITE_SERVICES', 'C'),
          },
          {
            id: 'lock',
            label: 'Lock a return',
            permitted: can('SITE_SERVICES', 'U'),
            reason: blockedReason('SITE_SERVICES', 'U'),
          },
          {
            id: 'award',
            label: 'Recommend an award',
            permitted: can('SITE_SERVICES', 'A'),
            reason: blockedReason('SITE_SERVICES', 'A'),
          },
          {
            id: 'engage',
            label: 'Engage a supplier',
            permitted: can('SITE_SERVICES', 'C'),
            reason: blockedReason('SITE_SERVICES', 'C'),
          },
          {
            id: 'advance',
            label: 'Advance a supplier',
            permitted: can('SITE_SERVICES', 'U'),
            reason: blockedReason('SITE_SERVICES', 'U'),
          },
          {
            id: 'suspend',
            label: 'Suspend a supplier',
            permitted: can('SITE_SERVICES', 'A'),
            reason: blockedReason('SITE_SERVICES', 'A'),
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

      ${factory.error ? refusal('The procurement factory', factory.error) : factoryCard(factory)}

      ${tower.error ? refusal('The mobilisation control tower', tower.error) : towerCard(tower)}

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

    if (which === 'attest') {
      // Only the items that are actually outstanding, and only the attested
      // kind. A derived item is refused by the command, and offering it in the
      // picker would be offering a refusal.
      const options = (tower.error ? [] : tower.systems).flatMap((system) =>
        system.gates.flatMap((gate) =>
          gate.evidence
            .filter((item) => item.kind === 'ATTESTED' && !item.satisfied)
            .map((item) => ({
              value: `${system.systemId}~${gate.id}~${item.itemId}`,
              label: `${system.label}, ${system.zone} — ${gate.id} ${item.label}${item.expired ? ' (expired)' : ''}`,
            })),
        ),
      );
      if (options.length === 0) {
        toast('Nothing outstanding', 'Every attested item on every gate is in place.', 'ok');
        return;
      }
      const result = await command({
        title: 'Attest gate evidence',
        intent:
          'A reference, never a tick — the certificate number, the drawing revision or the test sheet, so somebody can ' +
          'go and find it when the evidence is challenged. Anything that expires carries the date it expires on: the ' +
          'commonest mobilisation failure is not that evidence was never provided, it is that everything was in place once.',
        path: `/v1/projects/${state.session.projectId}/site-services/mobilisation/evidence`,
        submitLabel: 'Attest',
        transform: (values) => {
          const [systemId, gate, itemId] = values.item.split('~');
          return {
            systemId,
            gate,
            itemId,
            reference: values.reference,
            ...(values.expiresAt ? { expiresAt: values.expiresAt } : {}),
          };
        },
        fields: [
          { name: 'item', label: 'Which item', type: 'select', options },
          { name: 'reference', label: 'Reference', hint: 'Where the evidence lives, not that it exists' },
          {
            name: 'expiresAt',
            label: 'Expires',
            type: 'date',
            required: false,
            hint: 'Required for anything that lapses — insurance, a competency, a calibration. Refused without it.',
          },
        ],
      });
      if (result) {
        toast('Attested', `${result.gate} ${result.itemId} — ${result.reference}`, 'ok');
        await again();
      }
      return;
    }

    if (which === 'withdraw') {
      const options = (tower.error ? [] : tower.systems).flatMap((system) =>
        system.gates.flatMap((gate) =>
          gate.evidence
            .filter((item) => item.evidenceId)
            .map((item) => ({
              value: item.evidenceId,
              label: `${system.label}, ${system.zone} — ${gate.id} ${item.label} (${item.reference})`,
            })),
        ),
      );
      if (options.length === 0) {
        toast('Nothing attested', 'There is no evidence on this project to withdraw.', 'warn');
        return;
      }
      const result = await command({
        title: 'Withdraw evidence',
        intent:
          'A certificate revoked, or a test sheet found to be against the wrong asset. Withdrawing it re-opens the gate ' +
          'it satisfied — the gate is calculated, so removing an input changes the answer rather than leaving a passed ' +
          'gate standing on evidence that has gone.',
        path: `/v1/projects/${state.session.projectId}/site-services/mobilisation/withdraw`,
        submitLabel: 'Withdraw',
        fields: [
          { name: 'evidenceId', label: 'Which evidence', type: 'select', options },
          { name: 'reason', label: 'Why it no longer stands', type: 'textarea' },
        ],
      });
      if (result) {
        toast('Withdrawn', `${result.gate} ${result.itemId} — ${result.withdrawnReason}`, 'warn');
        await again();
      }
      return;
    }

    if (which === 'gate') {
      // Only the gate each system is actually at. Offering G5 on a system
      // sitting at G1 offers a refusal, and the refusal it offers is the one
      // that matters least.
      const options = (tower.error ? [] : tower.systems)
        .filter((system) => !system.accepted)
        .map((system) => {
          const at = system.gates.find((gate) => gate.id === system.atGate);
          return {
            value: `${system.systemId}~${system.atGate}`,
            label: `${system.label}, ${system.zone} — ${at.id} ${at.name} (${at.satisfied}/${at.total} evidence, ${at.approvers.join(' or ')})`,
          };
        });
      if (options.length === 0) {
        toast('Nothing to pass', 'Every composed system has reached mobilisation acceptance.', 'ok');
        return;
      }
      const result = await command({
        title: 'Pass a mobilisation gate',
        intent:
          'Refused unless every prior gate has passed, every evidence item on this one is satisfied, and you hold a role ' +
          'the gate names. Holding the capability is not enough: releasing an area and accepting a safe energisation are ' +
          'competent persons’ acts, and they fail closed.',
        path: `/v1/projects/${state.session.projectId}/site-services/mobilisation/gate`,
        submitLabel: 'Pass it',
        transform: (values) => {
          const [systemId, gate] = values.gate.split('~');
          return { systemId, gate, note: values.note };
        },
        fields: [
          { name: 'gate', label: 'Which gate', type: 'select', options },
          {
            name: 'note',
            label: 'What satisfies the condition',
            type: 'textarea',
            hint: 'Approval with nothing behind it is the signature that gets read out in the inquiry.',
          },
        ],
      });
      if (result) {
        toast('Gate passed', `${result.gate} — ${result.roleAtApproval.join(', ')}`, 'ok');
        await again();
      }
      return;
    }

    if (which === 'declare') {
      const options = (tower.error ? [] : tower.systems).map((system) => ({
        value: system.systemId,
        label: `${system.label} — ${system.zone}`,
      }));
      if (options.length === 0) {
        toast('Nothing composed', 'There is no service system for a supplier to report against.', 'warn');
        return;
      }
      const result = await command({
        title: 'Record a supplier declaration',
        intent:
          'What the supplier says its progress is. It moves nothing: readiness is calculated from the evidence and the ' +
          'interface tests, and a supplier reporting 100% cannot make a package ready. It is recorded because the ' +
          'difference between what was declared and what the evidence showed is the entire mobilisation dispute.',
        path: `/v1/projects/${state.session.projectId}/site-services/mobilisation/declaration`,
        submitLabel: 'Record it',
        transform: (values) => ({ ...values, percent: Number(values.percent) }),
        fields: [
          { name: 'systemId', label: 'Which system', type: 'select', options },
          { name: 'percent', label: 'Percent declared', type: 'number' },
          { name: 'note', label: 'What they said', type: 'textarea' },
        ],
      });
      if (result) {
        toast('Declaration recorded', result.moves, 'warn');
        await again();
      }
      return;
    }

    if (which === 'packaging') {
      const result = await command({
        title: 'Argue the packaging',
        intent:
          'Examines every pair of composed systems and produces an argument in one direction or the other — never a ' +
          'preference. Bundling has to be justified by the interfaces it removes; splitting by the competition or the ' +
          'specialist performance it protects. Bidder counts come from the supply-chain register, so a bundle only one ' +
          'firm can price is reported as the negotiation it would be.',
        path: `/v1/projects/${state.session.projectId}/site-services/packaging`,
        submitLabel: 'Argue it',
        fields: [],
      });
      if (result) {
        toast('Packaging argued', `${result.options.length} options, floor of ${result.competitionFloor} bidders`, 'ok');
        await again();
      }
      return;
    }

    if (which === 'package') {
      const options = (factory.error ? [] : factory.unpackaged).map((entry) => ({
        value: entry.id,
        label: `${entry.label} — ${entry.zone}`,
      }));
      if (options.length === 0) {
        toast('Nothing to buy', 'Every composed system is already in a package.', 'warn');
        return;
      }
      const result = await command({
        title: 'Create a service package',
        intent:
          'A package buys composed systems, and one system is bought once. Five of the twelve minimum fields come from ' +
          'the systems themselves — the interfaces, the quantities, the programme and the removal obligation — so they ' +
          'are never retyped and never disagree with the design.',
        path: `/v1/projects/${state.session.projectId}/site-services/package`,
        submitLabel: 'Create',
        transform: (values) => ({ title: values.title, systemIds: [values.systemId] }),
        fields: [
          { name: 'title', label: 'What it buys' },
          { name: 'systemId', label: 'Against which system', type: 'select', options },
        ],
      });
      if (result) {
        toast('Package created', `${result.reference} — ${result.title}`, 'ok');
        await again();
      }
      return;
    }

    if (which === 'field') {
      // Only the outstanding stated fields, on packages not yet issued. A
      // derived field is refused by the command, and a tendered package needs
      // an addendum rather than an edit.
      const options = (factory.error ? [] : factory.packages)
        .filter((entry) => !entry.tenderedAt)
        .flatMap((entry) =>
          entry.requirements
            .filter((requirement) => requirement.kind === 'STATED' && !requirement.satisfied)
            .map((requirement) => ({
              value: `${entry.id}~${requirement.id}`,
              label: `${entry.reference} — ${requirement.label}`,
            })),
        );
      if (options.length === 0) {
        toast('Nothing outstanding', 'Every package not yet issued has all seven stated fields.', 'ok');
        return;
      }
      const result = await command({
        title: 'State a package field',
        intent:
          'One of the seven fields nothing can infer. Each is a thing that gets argued about later if it is silent now, ' +
          'and the moment of issue is the last moment it is free to fix.',
        path: `/v1/projects/${state.session.projectId}/site-services/package/field`,
        submitLabel: 'State it',
        transform: (values) => {
          const [packageId, field] = values.which.split('~');
          return { packageId, field, value: values.value };
        },
        fields: [
          { name: 'which', label: 'Which field', type: 'select', options },
          { name: 'value', label: 'What it says', type: 'textarea' },
        ],
      });
      if (result) {
        toast('Stated', result.reference, 'ok');
        await again();
      }
      return;
    }

    if (which === 'issue') {
      const options = (factory.error ? [] : factory.packages)
        .filter((entry) => !entry.tenderedAt)
        .map((entry) => ({
          value: entry.id,
          label: `${entry.reference} ${entry.title}${entry.outstanding > 0 ? ` — ${entry.outstanding} fields outstanding` : ' — complete'}`,
        }));
      if (options.length === 0) {
        toast('Nothing to issue', 'Every package has been issued to tender.', 'warn');
        return;
      }
      const result = await command({
        title: 'Issue a package to tender',
        intent:
          'Opens a controlled enquiry — recipients, acknowledgement, addenda, return completeness and the audit log. ' +
          'Refused while any of the twelve minimum fields is outstanding, and the refusal names them and says what each ' +
          'one prevents. After issue the scope is frozen: a change is an addendum every bidder has to re-acknowledge.',
        path: `/v1/projects/${state.session.projectId}/site-services/package/tender`,
        submitLabel: 'Issue',
        fields: [
          { name: 'packageId', label: 'Which package', type: 'select', options },
          { name: 'returnDeadline', label: 'Returns by', type: 'date' },
        ],
      });
      if (result) {
        toast('Issued', `${result.package.reference} as ${result.reference}`, 'ok');
        await again();
      }
      return;
    }

    if (which === 'bid') {
      const options = (factory.error ? [] : factory.packages)
        .filter((entry) => entry.tenderedAt)
        .map((entry) => ({ value: entry.id, label: `${entry.reference} ${entry.title}` }));
      if (options.length === 0) {
        toast('Nothing at tender', 'No package has been issued, so there is nothing to return against.', 'warn');
        return;
      }
      const result = await command({
        title: 'Record a return',
        intent:
          'The priced return and the basis it is priced on. The basis is what makes the comparison possible: currency, ' +
          'tax, hire period, escalation, and whether mobilisation, standby, supervision and reinstatement are in the ' +
          'price. A basis left silent is reported as unknown rather than assumed included.',
        path: `/v1/projects/${state.session.projectId}/site-services/bid`,
        submitLabel: 'Record',
        transform: (values) => ({
          packageId: values.packageId,
          supplierId: values.supplierId,
          supplierName: values.supplierName,
          basis: {
            currency: values.currency,
            taxBasis: values.taxBasis,
            ...(values.hirePeriodWeeks ? { hirePeriodWeeks: Number(values.hirePeriodWeeks) } : {}),
            ...(values.escalationPercent ? { escalationPercent: Number(values.escalationPercent) } : {}),
            mobilisationIncluded: values.mobilisationIncluded === 'yes',
            demobilisationIncluded: values.demobilisationIncluded === 'yes',
            reinstatementIncluded: values.reinstatementIncluded === 'yes',
          },
          lines: JSON.parse(values.lines),
          ...(values.exclusions ? { exclusions: values.exclusions.split(',').map((entry) => entry.trim()).filter(Boolean) } : {}),
          ...(values.technicalScore ? { technicalScore: Number(values.technicalScore) } : {}),
        }),
        fields: [
          { name: 'packageId', label: 'Against which package', type: 'select', options },
          { name: 'supplierId', label: 'Supplier id', hint: 'From the supply-chain register' },
          { name: 'supplierName', label: 'Supplier' },
          {
            name: 'lines',
            label: 'Priced lines',
            type: 'textarea',
            hint: 'JSON: [{"scheduleItemId":"…","description":"…","quantity":1,"unit":"nr","rateMinor":100000}]',
          },
          { name: 'currency', label: 'Currency', value: 'GBP' },
          {
            name: 'taxBasis',
            label: 'Tax basis',
            type: 'select',
            options: [
              { value: 'EXCLUSIVE', label: 'Exclusive — as issued' },
              { value: 'INCLUSIVE', label: 'Inclusive — reported as incomparable' },
            ],
          },
          { name: 'hirePeriodWeeks', label: 'Hire period in weeks', type: 'number', required: false },
          { name: 'escalationPercent', label: 'Escalation percent', type: 'number', required: false },
          ...[
            ['mobilisationIncluded', 'Mobilisation included'],
            ['demobilisationIncluded', 'Demobilisation included'],
            ['reinstatementIncluded', 'Reinstatement included'],
          ].map(([name, label]) => ({
            name,
            label,
            type: 'select',
            required: false,
            options: [
              { value: '', label: 'Not stated — reported as unknown' },
              { value: 'yes', label: 'In the price' },
              { value: 'no', label: 'Out, and priced at the median' },
            ],
          })),
          {
            name: 'exclusions',
            label: 'Excluded schedule items',
            required: false,
            hint: 'Comma-separated schedule item ids. Each is priced at the median compliant rate, visibly.',
          },
          { name: 'technicalScore', label: 'Technical score out of 100', type: 'number', required: false },
        ],
      });
      if (result) {
        toast('Return recorded', `${result.supplierName} — ${result.lines.length} lines`, 'ok');
        await again();
      }
      return;
    }

    if (which === 'lock' || which === 'award') {
      const options = (factory.error ? [] : factory.packages)
        .filter((entry) => entry.returns > 0)
        .map((entry) => ({
          value: entry.id,
          label: `${entry.reference} ${entry.title} — ${entry.lockedReturns} of ${entry.returns} locked`,
        }));
      if (options.length === 0) {
        toast('No returns', 'Nothing has been returned against any package yet.', 'warn');
        return;
      }

      if (which === 'award') {
        const result = await command({
          title: 'Recommend an award',
          intent:
            'Eligibility from the supply-chain register, the normalised price with every exclusion priced into it, the ' +
            'worst sensitivity case and the delivery risk. Refused while any return is unlocked or any award-blocking ' +
            'clarification stands — each of those is a question whose answer changes the answer.',
          path: `/v1/projects/${state.session.projectId}/site-services/award`,
          submitLabel: 'Recommend',
          fields: [{ name: 'packageId', label: 'Which package', type: 'select', options }],
        });
        if (result) {
          toast(
            result.recommended ? 'Recommended' : 'No recommendation',
            result.recommended ? result.recommended.supplierName : result.refusedBecause,
            result.recommended ? 'ok' : 'warn',
          );
          await again();
        }
        return;
      }

      // The lock needs a specific return, and the returns live behind the
      // normalisation read rather than on the register — a rate is
      // commercial-in-confidence and the register is not.
      const chosen = options[0].value;
      const normalisation = await api
        .get(`/v1/projects/${state.session.projectId}/site-services/normalisation/${chosen}`)
        .catch(() => null);
      const unlocked = (normalisation?.bids ?? []).filter((entry) => !entry.locked);
      if (unlocked.length === 0) {
        toast('Nothing to lock', 'Every return against that package is already locked.', 'ok');
        return;
      }
      const result = await command({
        title: 'Lock a clarified return',
        intent:
          'The sixth normalisation step. Award analysis run on an unacknowledged return is analysis of what the buyer ' +
          'believes the bidder meant, and the first thing that happens after award is a conversation about what was ' +
          'actually priced.',
        path: `/v1/projects/${state.session.projectId}/site-services/bid/lock`,
        submitLabel: 'Lock',
        fields: [
          {
            name: 'bidId',
            label: 'Which return',
            type: 'select',
            options: unlocked.map((entry) => ({ value: entry.bidId, label: entry.supplierName })),
          },
          { name: 'acknowledgedBy', label: 'Acknowledged by', hint: 'Who at the supplier agreed the clarified position' },
        ],
      });
      if (result) {
        toast('Locked', `${result.supplierName} — ${result.acknowledgedBy}`, 'ok');
        await again();
      }
      return;
    }

    if (which === 'engage') {
      const options = (factory.error ? [] : factory.packages).map((entry) => ({
        value: entry.id,
        label: `${entry.reference} ${entry.title}`,
      }));
      if (options.length === 0) {
        toast('No packages', 'There is no package for a supplier to be engaged on.', 'warn');
        return;
      }
      const result = await command({
        title: 'Engage a supplier',
        intent:
          'Opens the engagement at Prospect. This is where a firm stands on *this package* — the same firm can be ' +
          'operational on welfare and tendering on cleaning on the same Tuesday, and a single status field cannot say so. ' +
          'Whether they may be used at all is the supply-chain register’s question, and it is read rather than repeated.',
        path: `/v1/projects/${state.session.projectId}/site-services/engagement`,
        submitLabel: 'Engage',
        fields: [
          { name: 'packageId', label: 'On which package', type: 'select', options },
          { name: 'supplierId', label: 'Supplier id', hint: 'From the supply-chain register' },
          { name: 'supplierName', label: 'Supplier' },
        ],
      });
      if (result) {
        toast('Engaged', `${result.supplierName} at prospect`, 'ok');
        await again();
      }
      return;
    }

    if (which === 'advance' || which === 'suspend') {
      const suspending = which === 'suspend';
      const options = (factory.error ? [] : factory.packages).flatMap((entry) =>
        entry.engagements
          .filter((engagement) => (suspending ? engagement.state !== 'SUSPENDED_RECOVERY' : engagement.nextState))
          .map((engagement) => ({
            value: engagement.id,
            label: `${engagement.supplierName} on ${entry.reference}${
              suspending ? '' : ` — ${engagement.nextState}${engagement.nextBlocked ? ' (blocked)' : ''}`
            }`,
          })),
      );
      if (options.length === 0) {
        toast(
          suspending ? 'Nothing to suspend' : 'Nothing to advance',
          suspending
            ? 'No supplier is engaged and unsuspended on any package.'
            : 'No engagement has a next state to move to.',
          'warn',
        );
        return;
      }

      const result = await command({
        title: suspending ? 'Suspend a supplier' : 'Advance a supplier',
        intent: suspending
          ? 'Blocks new work and starts the recovery. Name the material failure or the evidence that lapsed — a ' +
            'suspension with no cause cannot be recovered from, because nobody can say what would fix it.'
          : 'Moves the engagement to the next control state, and only if the platform’s own records meet the entry ' +
            'criteria. Contracted because somebody typed contracted is the control that fails in the month it matters.',
        path: suspending
          ? `/v1/projects/${state.session.projectId}/site-services/engagement/suspend`
          : `/v1/projects/${state.session.projectId}/site-services/engagement/advance`,
        submitLabel: suspending ? 'Suspend' : 'Advance',
        fields: [
          { name: 'engagementId', label: 'Which engagement', type: 'select', options },
          ...(suspending
            ? [{ name: 'reason', label: 'What failed, or what lapsed', type: 'textarea' }]
            : [
                {
                  name: 'to',
                  label: 'To which state',
                  type: 'select',
                  options: (factory.error ? [] : factory.states)
                    .filter((entry) => entry.id !== 'SUSPENDED_RECOVERY')
                    .map((entry) => ({ value: entry.id, label: `${entry.label} — ${entry.entryCriteria}` })),
                },
              ]),
        ],
      });
      if (result) {
        toast(
          suspending ? 'Suspended' : 'Advanced',
          `${result.supplierName} — ${result.state.replaceAll('_', ' ').toLowerCase()}`,
          suspending ? 'warn' : 'ok',
        );
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

/** Where a firm stands on a package, and how urgent that is to look at. */
const STATE_TONE = {
  PROSPECT: 'info',
  PREQUALIFIED: 'info',
  TENDERING: 'warn',
  PREFERRED: 'warn',
  CONTRACTED: 'ok',
  MOBILISING: 'ok',
  OPERATIONAL: 'ok',
  SUSPENDED_RECOVERY: 'bad',
  CLOSED: 'info',
};

/**
 * The procurement factory: packages, the argument behind them, and where every
 * supplier stands on each.
 *
 * Three things are deliberately given the space rather than the summary.
 *
 * **The packaging argument, in full.** A bundling recommendation that says
 * "recommended" and nothing else is a preference. The argument names the
 * interfaces bundling would remove, or the bidder counts splitting would
 * protect, and it is shown as the sentence it would be defended in.
 *
 * **The twelve minimum fields, one row each.** Not a completeness percentage:
 * eleven of twelve reads as *nearly there*, which is the opposite of true when
 * the missing one is the change mechanism. Each row says what its absence
 * causes, because that is what makes somebody go and fill it in.
 *
 * **The next control state and what is blocking it.** A register showing only
 * where a firm is now leaves "why has this not moved" to a conversation.
 */
function factoryCard(factory) {
  const { packages, unpackaged, strategy, states, competitionFloor } = factory;

  return html`
    <div class="card" style="margin-bottom:14px">
      <h2>Procurement factory</h2>
      <div class="metric-sub" style="margin:6px 0 12px">
        ${packages.length} package${packages.length === 1 ? '' : 's'} against the composed systems. Packaging is an
        argument rather than a preference, and a package cannot be issued while any of its twelve minimum fields is
        silent — the moment of issue is the last moment they are free to fix.
      </div>

      ${unpackaged.length > 0
        ? html`<div class="notice warn" style="margin-bottom:14px">
            <div>
              <b>${unpackaged.length} composed system${unpackaged.length === 1 ? '' : 's'} nothing buys.</b>
              ${unpackaged.map((entry) => `${entry.label} (${entry.zone})`).join(' · ')}. A system with no package is a
              service nobody has been asked to price.
            </div>
          </div>`
        : ''}

      ${strategy
        ? html`<div style="margin-bottom:14px">
            <h2>The packaging argument — ${date(strategy.assessedAt)}</h2>
            <div class="metric-sub" style="margin:6px 0 10px">
              ${strategy.modelEffect} Competition floor ${competitionFloor} bidders.
            </div>
            ${strategy.options.map(
              (option) => html`<div style="padding:12px 0;border-top:1px solid var(--line)">
                <div style="display:flex;justify-content:space-between;gap:16px;align-items:baseline">
                  <b>${option.label}</b>
                  ${option.recommendation === 'BUNDLE' ? badge('bundle', 'ok') : badge('split', 'warn')}
                </div>
                <div class="metric-sub" style="margin-top:6px">${option.argument}</div>
                <div class="metric-sub" style="margin-top:6px">
                  ${option.internalised.length} interface${option.internalised.length === 1 ? '' : 's'} internalised ·
                  ${option.externalRemaining} external either way · ${option.biddersIfBundled} bidders bundled
                </div>
                ${option.factors.map(
                  (factor) => html`<div class="metric-sub" style="margin-top:4px">
                    <b>${factor.label}.</b> ${factor.says}
                  </div>`,
                )}
              </div>`,
            )}
          </div>`
        : html`<div class="notice" style="margin-bottom:14px">
            <div>
              No packaging argument has been made. Whether welfare and cleaning are one package or two decides how many
              interfaces exist and how many firms can bid, and it is worth arguing before it is assumed.
            </div>
          </div>`}

      ${packages.map(
        (record) => html`<div style="padding:14px 0;border-top:1px solid var(--line)">
          <div style="display:flex;justify-content:space-between;gap:16px;align-items:baseline">
            <b>${record.reference} — ${record.title}</b>
            <span>
              ${record.tenderedAt ? badge('at tender', 'warn') : badge('drafting', 'info')}
              ${record.outstanding > 0
                ? badge(`${record.outstanding} of 12 outstanding`, 'bad')
                : badge('twelve fields complete', 'ok')}
              ${record.returns > 0 ? badge(`${record.lockedReturns}/${record.returns} returns locked`, 'info') : ''}
            </span>
          </div>
          <div class="metric-sub" style="margin-top:4px">
            Buys ${record.systems.map((entry) => `${entry.label} (${entry.zone})`).join(' · ')}
          </div>

          ${table({
            headers: ['Minimum field', 'From', 'Position'],
            rows: record.requirements.map((requirement) => [
              html`${requirement.label}
                <div class="metric-sub">${requirement.matters}</div>`,
              requirement.kind === 'DERIVED' ? badge('derived', 'info') : badge('stated', 'warn'),
              html`${requirement.satisfied ? badge('in place', 'ok') : badge('outstanding', 'bad')}
                <div class="metric-sub">${requirement.detail}</div>`,
            ]),
          })}

          ${record.engagements.length > 0
            ? html`<div style="margin-top:12px">
                <h2>Where each supplier stands</h2>
                ${table({
                  headers: ['Supplier', 'State', 'What is being watched', 'Next'],
                  rows: record.engagements.map((engagement) => [
                    engagement.supplierName,
                    html`${badge(
                      engagement.state.replaceAll('_', ' ').toLowerCase(),
                      STATE_TONE[engagement.state] ?? 'info',
                    )}
                      ${engagement.suspendedReason
                        ? html`<div class="metric-sub bad">${engagement.suspendedReason}</div>`
                        : ''}`,
                    engagement.controls.join(' · '),
                    engagement.nextState
                      ? html`${engagement.nextState}
                          ${engagement.nextBlocked
                            ? html`<div class="metric-sub bad">${engagement.nextBlocked}</div>`
                            : html`<div class="metric-sub ok">Entry criteria met.</div>`}`
                      : html`<span class="metric-sub">Nothing further on this package.</span>`,
                  ]),
                })}
              </div>`
            : html`<div class="metric-sub" style="margin-top:10px">
                No supplier is engaged on this package yet.
              </div>`}
        </div>`,
      )}

      <div style="padding:14px 0 0;border-top:1px solid var(--line)">
        <h2>The nine control states</h2>
        <div class="metric-sub" style="margin:6px 0 10px">
          Where a firm stands on a package, not what the business thinks of the firm. Whether they may be used at all is
          the supply-chain register’s question, and this reads it rather than repeating it.
        </div>
        ${table({
          headers: ['State', 'Entered when', 'What is watched'],
          rows: states.map((entry) => [
            html`${badge(entry.label.toLowerCase(), STATE_TONE[entry.id] ?? 'info')}`,
            entry.entryCriteria,
            entry.automatedControls.join(' · '),
          ]),
        })}
      </div>
    </div>
  `;
}

/** The four gate states, and the tone each one deserves at a glance. */
const GATE_TONE = { PASSED: 'ok', AWAITING_APPROVAL: 'info', EVIDENCE_OUTSTANDING: 'warn', BLOCKED: 'bad' };

const GATE_STATUS = {
  PASSED: 'passed',
  AWAITING_APPROVAL: 'evidence complete, awaiting approval',
  EVIDENCE_OUTSTANDING: 'evidence outstanding',
  BLOCKED: 'blocked',
};

/**
 * The mobilisation control tower.
 *
 * **Mobilisation is a dependency network, not a percentage complete.** Every
 * mobilisation tracker in the industry is a spreadsheet of percentages supplied
 * by the people being measured, and it reads 94% until the week it reads 41% —
 * because a percentage cannot be wrong, only revised.
 *
 * So the panel refuses to lead with a number. It leads with the gate each system
 * is actually at, and under it every evidence item with the reference it lives
 * at or the reason it is not satisfied. The evidence percentage is a caption on
 * calculated evidence, never a status somebody typed.
 *
 * The supplier's own declaration is shown *beside* the calculated position
 * rather than instead of it. That juxtaposition is the whole point: the
 * difference between what was declared and what the evidence showed is the
 * entire mobilisation dispute, and a screen carrying only one half of it cannot
 * settle one.
 */
function towerCard(tower) {
  const { systems, gates, expiringSoon } = tower;

  if (systems.length === 0) {
    return html`<div class="card" style="margin-bottom:14px">
      <h2>Mobilisation control tower</h2>
      <div class="metric-sub" style="margin:6px 0 10px">
        Seven gates per service system, each calculated from evidence rather than reported. Nothing is composed yet, so
        there is nothing to mobilise.
      </div>
      ${table({
        headers: ['Gate', 'Passes when', 'Approved by'],
        rows: gates.map((gate) => [
          html`<b>${gate.id} ${gate.name}</b>
            ${gate.safetyCritical ? badge('safety-critical', 'bad') : ''}`,
          gate.approvalCondition,
          gate.approvers.join(' · '),
        ]),
      })}
    </div>`;
  }

  return html`
    <div class="card" style="margin-bottom:14px">
      <h2>Mobilisation control tower</h2>
      <div class="metric-sub" style="margin:6px 0 12px">
        Mobilisation is a dependency network, not a percentage complete. Each gate below is calculated from its evidence
        and from the gates before it — no gate is a status anybody sets, and no supplier declaration moves one.
      </div>

      ${expiringSoon.length > 0
        ? html`<div class="notice warn" style="margin-bottom:14px">
            <div>
              <b>${expiringSoon.length} piece${expiringSoon.length === 1 ? '' : 's'} of evidence lapse within the month.</b>
              ${expiringSoon.map((entry) => `${entry.label}: ${entry.reference} to ${entry.expiresAt}`).join(' · ')}.
              Expired evidence is not evidence, and the gate it satisfies re-opens on the day it goes.
            </div>
          </div>`
        : ''}

      ${systems.map(
        (system) => html`<div style="padding:14px 0;border-top:1px solid var(--line)">
          <div style="display:flex;justify-content:space-between;gap:16px;align-items:baseline">
            <b>${system.label} — ${system.zone}</b>
            <span>
              ${system.accepted
                ? badge('mobilisation accepted', 'ok')
                : badge(`at ${system.atGate}`, 'info')}
              ${badge(`${pct(system.evidencePercent)} of evidence in place`, system.evidencePercent === 100 ? 'ok' : 'warn')}
            </span>
          </div>

          <!--
            The declaration is dated in the headline rather than underneath it.
            The percentage beside it is today's, calculated live, and the
            declaration is whatever was last said — so a sentence putting the
            two together in the present tense would imply the supplier is
            standing by a figure they gave six weeks ago.
          -->
          ${system.declarations.length > 0
            ? html`<div class="notice warn" style="margin-top:10px">
                <div>
                  <b>On ${date(system.declarations[0].declaredAt)} the supplier declared
                  ${system.declarations[0].percent}%. The evidence puts it at ${pct(system.evidencePercent)} today,
                  at ${system.atGate}.</b><br />
                  “${system.declarations[0].note}”<br />
                  ${system.declarations[0].moves}
                </div>
              </div>`
            : ''}

          ${system.gates.map(
            (gate) => html`<div style="padding:10px 0 0">
              <div style="display:flex;justify-content:space-between;gap:16px;align-items:baseline">
                <b>${gate.id} ${gate.name}</b>
                <span>
                  ${gate.safetyCritical ? badge('safety-critical', 'bad') : ''}
                  ${badge(GATE_STATUS[gate.status] ?? gate.status, GATE_TONE[gate.status] ?? 'info')}
                  ${gate.satisfied}/${gate.total}
                </span>
              </div>
              <div class="metric-sub" style="margin-top:4px">
                ${gate.approvalCondition} Approved by ${gate.approvers.join(' or ')}.
              </div>
              ${gate.blockedBy.length > 0
                ? html`<div class="metric-sub bad" style="margin-top:4px">
                    Cannot be approved while ${gate.blockedBy.join(' and ')}
                    ${gate.blockedBy.length === 1 ? 'has' : 'have'} not passed.
                  </div>`
                : ''}
              ${gate.approval
                ? html`<div class="metric-sub ok" style="margin-top:4px">
                    Passed ${date(gate.approval.approvedAt)} by ${gate.approval.roleAtApproval.join(', ')} —
                    ${gate.approval.note}
                  </div>`
                : ''}
              ${table({
                headers: ['Evidence', 'Kind', 'Position'],
                rows: gate.evidence.map((item) => [
                  html`${item.label}
                    <div class="metric-sub">${item.matters}</div>`,
                  item.kind === 'DERIVED' ? badge('derived', 'info') : badge('attested', 'warn'),
                  html`${item.satisfied ? badge('satisfied', 'ok') : badge(item.expired ? 'expired' : 'outstanding', 'bad')}
                    <div class="metric-sub">${item.detail}</div>`,
                ]),
              })}
            </div>`,
          )}

          ${system.declarations.length > 1
            ? html`<div style="padding:12px 0 0">
                <h2>What the supplier has said, over time</h2>
                ${table({
                  headers: ['When', 'Declared', 'Said'],
                  align: ['', 'num', ''],
                  rows: system.declarations.map((entry) => [date(entry.declaredAt), `${entry.percent}%`, entry.note]),
                })}
              </div>`
            : ''}
        </div>`,
      )}
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
