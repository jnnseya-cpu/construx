import { api } from '../lib/api.js';
import { command, commandBar, confirmCost } from '../lib/command.js';
import { badge, date, html, money, pct, raw, render, table, toast, track } from '../lib/ui.js';
import { head, refusal } from '../lib/estate.js';
import { supplierPaymentCard } from '../lib/siteportal.js';
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

/**
 * Which of §13's eight command centres is on screen, and for whom.
 *
 * Module-level rather than in `state` because it is a view preference on one
 * page, not something any other screen or the API needs to know. It survives a
 * re-render of this page, which is exactly its job, and nothing else.
 *
 * The default is the control tower: it is the workspace that needs no
 * commercial standing and no subject to be chosen, so it is the one that
 * renders for the widest set of people on first load.
 */
let chosenWorkspace = 'CONTROL_TOWER';
let portalSupplier = '';

const PANEL_TONE = { CRITICAL: 'bad', WARNING: 'warn', INFO: 'info', OK: 'ok' };

/**
 * The doors onto §13's record families. Each returns a `command` spec, or a
 * `blocked` reason where the record it needs does not exist yet — a panel that
 * opens onto an empty select is a door onto nothing.
 */
const DESK_COMMANDS = {
  payment: ({ commercial }) => {
    const certified = (commercial.error ? [] : commercial.valuations).filter((entry) => entry.status === 'CERTIFIED');
    if (certified.length === 0) return { blocked: { title: 'Nothing certified', detail: 'Money is recorded against a certificate. Certify a valuation first.' } };
    return {
      title: 'Record a payment',
      intent:
        'A payment that has already arrived, against a certified valuation, under the bank’s own reference. The same ' +
        'reference twice records once; a sum above the certificate is refused rather than chased later.',
      path: `/v1/projects/${state.session.projectId}/site-services/payment`,
      submitLabel: 'Record',
      transform: (values) => ({ ...values, amountMinor: Number(values.amountMinor) }),
      fields: [
        { name: 'valuationId', label: 'Which valuation', type: 'select', options: certified.map((entry) => ({ value: entry.id, label: `${entry.reference} — ${money(entry.certifiedMinor)} certified` })) },
        { name: 'amountMinor', label: 'Amount (pence)', type: 'number', hint: '£1,000 is 100000.' },
        { name: 'reference', label: 'Bank reference', hint: 'Unique for ever. Do not invent one.' },
        { name: 'paidAt', label: 'Paid on', type: 'date', required: false },
        { name: 'note', label: 'Note', required: false },
      ],
      done: 'Payment recorded',
      summary: (result) => (result.alreadyRecorded ? 'That reference was already on the record — nothing was recorded twice.' : money(result.payment.amountMinor)),
    };
  },
  contingency: () => ({
    title: 'Set the contingency pot',
    intent: 'How much is held against the unknown, and what that figure is sized against. It cannot be set below what has already been drawn.',
    path: `/v1/projects/${state.session.projectId}/site-services/contingency`,
    submitLabel: 'Set',
    transform: (values) => ({ ...values, potMinor: Number(values.potMinor) }),
    fields: [
      { name: 'potMinor', label: 'Pot (pence)', type: 'number', hint: '£10,000 is 1000000.' },
      { name: 'basis', label: 'Sized against', type: 'textarea', hint: 'At least ten characters. "5% of the welfare commitment" is a basis; a number is not.' },
    ],
    done: 'Pot set',
    summary: (result) => money(result.potMinor),
  }),
  draw: () => ({
    title: 'Draw on contingency',
    intent: 'What the draw pays for. Refused beyond what remains of the pot; raise the pot with its basis, or raise a change.',
    path: `/v1/projects/${state.session.projectId}/site-services/contingency/draw`,
    submitLabel: 'Draw',
    transform: (values) => ({ ...values, amountMinor: Number(values.amountMinor) }),
    fields: [
      { name: 'amountMinor', label: 'Amount (pence)', type: 'number' },
      { name: 'reason', label: 'What it pays for', type: 'textarea' },
    ],
    done: 'Drawn',
    summary: (result) => `${result.draws.length} draw${result.draws.length === 1 ? '' : 's'} on the pot`,
  }),
  snapshot: ({ eac }) => {
    if (eac.error || (eac.commitmentMinor === 0 && eac.earnedMinor === 0)) {
      return { blocked: { title: 'Nothing to freeze', detail: 'The estimate at completion is every term at once. With nothing committed and nothing earned there is no forecast to hold anybody to.' } };
    }
    return {
      title: 'Freeze the forecast',
      intent:
        'A record of what the estimate at completion was today, term by term, so that the final account can be measured against it. ' +
        'Forecast accuracy is reported only once the account is closed out; until then a live forecast compared against itself is always right.',
      path: `/v1/projects/${state.session.projectId}/site-services/forecast/snapshot`,
      submitLabel: 'Freeze',
      fields: [
        { name: 'note', label: 'Note', required: false, hint: 'What this forecast was made in the light of: "month one, before any change".' },
        { name: 'asOf', label: 'As of', type: 'date', required: false, hint: 'Defaults to today.' },
      ],
      done: 'Forecast frozen',
      summary: (result) => `${money(result.eacMinor)} as of ${result.asOf}`,
    };
  },
  asset: ({ structure }) => {
    const systems = structure.error ? [] : structure.systems;
    if (systems.length === 0) return { blocked: { title: 'No system', detail: 'A unit is registered under a composed system. Compose one first.' } };
    return {
      title: 'Register a unit',
      intent: 'The unit a code on site resolves to. The tag is what the code says; it is unique on the project.',
      path: `/v1/projects/${state.session.projectId}/site-services/asset`,
      submitLabel: 'Register',
      fields: [
        { name: 'systemId', label: 'Under which system', type: 'select', options: systems.map((system) => ({ value: system.id, label: `${system.label} — ${system.zone}` })) },
        { name: 'tag', label: 'Tag', hint: 'As printed on the code.' },
        { name: 'kind', label: 'What it is', hint: 'A cabin, a generator, a bowser.' },
        { name: 'serial', label: 'Serial', required: false },
        { name: 'location', label: 'Where', required: false, hint: 'Defaults to the system’s zone.' },
      ],
      done: 'Registered',
      summary: (result) => result.tag,
    };
  },
  scan: ({ desk }) => {
    if (desk.error || desk.assets.registered === 0) return { blocked: { title: 'Nothing to scan', detail: 'No unit is registered, so no code resolves to anything.' } };
    return {
      title: 'Scan a unit',
      intent: 'What the code says, and what was found. The scan is recorded against the unit with where it was and what state it is in.',
      path: `/v1/projects/${state.session.projectId}/site-services/asset/scan`,
      submitLabel: 'Record the scan',
      fields: [
        { name: 'tag', label: 'Tag', hint: 'As scanned.' },
        { name: 'status', label: 'State', type: 'select', required: false, options: [{ value: 'ON_SITE', label: 'On site' }, { value: 'OFF_SITE', label: 'Off site' }, { value: 'DEFECTIVE', label: 'Defective' }] },
        { name: 'location', label: 'Where', required: false },
        { name: 'note', label: 'Note', required: false },
      ],
      done: 'Scan recorded',
      summary: (result) => `${result.tag} — ${result.kind}, ${result.status.toLowerCase().replace('_', ' ')}`,
    };
  },
  delivery: ({ structure }) => ({
    title: 'Schedule a delivery',
    intent: 'What is expected, from whom, when and how many, so the gate can check it in against something.',
    path: `/v1/projects/${state.session.projectId}/site-services/delivery`,
    submitLabel: 'Schedule',
    transform: (values) => ({ ...values, quantityExpected: Number(values.quantityExpected), ...(values.systemId ? {} : { systemId: undefined }) }),
    fields: [
      { name: 'systemId', label: 'For which system', type: 'select', required: false, options: (structure.error ? [] : structure.systems).map((system) => ({ value: system.id, label: `${system.label} — ${system.zone}` })) },
      { name: 'supplier', label: 'Supplier' },
      { name: 'description', label: 'What' },
      { name: 'expectedOn', label: 'Expected on', type: 'date' },
      { name: 'quantityExpected', label: 'How many', type: 'number' },
    ],
    done: 'Scheduled',
    summary: (result) => `${result.description} on ${result.expectedOn}`,
  }),
  deliverycheck: ({ desk }) => {
    const expected = desk.error ? [] : desk.deliveries.items.filter((entry) => entry.status === 'EXPECTED');
    if (expected.length === 0) return { blocked: { title: 'Nothing expected', detail: 'Every scheduled delivery has been checked. Schedule one first.' } };
    return {
      title: 'Check a delivery in',
      intent: 'How many actually arrived. Short, say what is missing and why; refused, say so.',
      path: `/v1/projects/${state.session.projectId}/site-services/delivery/check`,
      submitLabel: 'Check in',
      transform: (values) => ({ ...values, quantityReceived: Number(values.quantityReceived), refused: Boolean(values.refused) }),
      fields: [
        { name: 'deliveryId', label: 'Which delivery', type: 'select', options: expected.map((entry) => ({ value: entry.id, label: `${entry.description} from ${entry.supplier}, ${entry.quantityExpected} expected ${entry.expectedOn}` })) },
        { name: 'quantityReceived', label: 'Arrived', type: 'number' },
        { name: 'discrepancy', label: 'What is short, and why', required: false },
        { name: 'refused', label: 'Refused at the gate', type: 'checkbox', required: false },
      ],
      done: 'Checked in',
      summary: (result) => `${result.description}: ${result.status.toLowerCase()}`,
    };
  },
  room: ({ structure }) => {
    const systems = (structure.error ? [] : structure.systems).filter((system) => system.family === 'WELFARE_ACCOMMODATION');
    if (systems.length === 0) return { blocked: { title: 'No accommodation system', detail: 'Rooms live under a composed welfare and accommodation system. Compose one first.' } };
    return {
      title: 'Register a room',
      intent: 'A room and its beds beneath the composed accommodation system. A bed can then be pointed at.',
      path: `/v1/projects/${state.session.projectId}/site-services/room`,
      submitLabel: 'Register',
      transform: (values) => ({ ...values, beds: Number(values.beds) }),
      fields: [
        { name: 'systemId', label: 'Under which system', type: 'select', options: systems.map((system) => ({ value: system.id, label: `${system.label} — ${system.zone}` })) },
        { name: 'block', label: 'Block' },
        { name: 'number', label: 'Room' },
        { name: 'beds', label: 'Beds', type: 'number' },
      ],
      done: 'Room registered',
      summary: (result) => `${result.block} ${result.number}, ${result.beds} bed${result.beds === 1 ? '' : 's'}`,
    };
  },
  roomstatus: ({ desk }) => {
    const rooms = desk.error ? [] : desk.accommodation.rooms;
    if (rooms.length === 0) return { blocked: { title: 'No room', detail: 'Register a room first.' } };
    return {
      title: 'Set a room’s state',
      intent: 'Ready, cleaning or out of service. Occupied is a check-in, not a declaration, and a room with people in it cannot be taken out of service.',
      path: `/v1/projects/${state.session.projectId}/site-services/room/status`,
      submitLabel: 'Set',
      fields: [
        { name: 'roomId', label: 'Which room', type: 'select', options: rooms.map((room) => ({ value: room.id, label: `${room.block} ${room.number} — ${room.status.toLowerCase().replace('_', ' ')}` })) },
        { name: 'status', label: 'State', type: 'select', options: [{ value: 'READY', label: 'Ready' }, { value: 'CLEANING', label: 'Cleaning' }, { value: 'OUT_OF_SERVICE', label: 'Out of service' }] },
        { name: 'reason', label: 'Why', required: false, hint: 'Required when taking a room out of service.' },
      ],
      done: 'Room updated',
      summary: (result) => `${result.block} ${result.number}: ${result.status.toLowerCase().replace('_', ' ')}`,
    };
  },
  bed: ({ desk }) => {
    const rooms = (desk.error ? [] : desk.accommodation.rooms).filter((room) => room.free > 0);
    if (rooms.length === 0) return { blocked: { title: 'No free bed', detail: 'Every registered bed is allocated, or no room is registered.' } };
    return {
      title: 'Allocate a bed',
      intent: 'Who, in which room, from which night. Never beyond the beds the room holds.',
      path: `/v1/projects/${state.session.projectId}/site-services/bed`,
      submitLabel: 'Allocate',
      fields: [
        { name: 'roomId', label: 'Which room', type: 'select', options: rooms.map((room) => ({ value: room.id, label: `${room.block} ${room.number} — ${room.free} free` })) },
        { name: 'occupant', label: 'Who' },
        { name: 'employer', label: 'Employer', required: false },
        { name: 'from', label: 'First night', type: 'date' },
        { name: 'to', label: 'Last night', type: 'date', required: false },
      ],
      done: 'Allocated',
      summary: (result) => `${result.occupant} from ${result.from}`,
    };
  },
  checkin: ({ desk }) => {
    const arriving = (desk.error ? [] : desk.accommodation.allocations).filter((entry) => entry.status === 'ALLOCATED');
    if (arriving.length === 0) return { blocked: { title: 'Nobody arriving', detail: 'No allocation is waiting to be checked in.' } };
    const rooms = desk.accommodation.rooms;
    return {
      title: 'Check somebody in',
      intent: 'The room becomes occupied by this record.',
      path: `/v1/projects/${state.session.projectId}/site-services/bed/checkin`,
      submitLabel: 'Check in',
      fields: [{ name: 'allocationId', label: 'Who', type: 'select', options: arriving.map((entry) => { const room = rooms.find((candidate) => candidate.id === entry.roomId); return { value: entry.id, label: `${entry.occupant} — ${room ? `${room.block} ${room.number}` : entry.roomId} from ${entry.from}` }; }) }],
      done: 'Checked in',
      summary: (result) => result.occupant,
    };
  },
  checkout: ({ desk }) => {
    const staying = (desk.error ? [] : desk.accommodation.allocations).filter((entry) => entry.status === 'CHECKED_IN');
    if (staying.length === 0) return { blocked: { title: 'Nobody in', detail: 'No one is checked in tonight.' } };
    return {
      title: 'Check somebody out',
      intent: 'A vacated room goes to housekeeping by the record.',
      path: `/v1/projects/${state.session.projectId}/site-services/bed/checkout`,
      submitLabel: 'Check out',
      fields: [{ name: 'allocationId', label: 'Who', type: 'select', options: staying.map((entry) => ({ value: entry.id, label: entry.occupant })) }],
      done: 'Checked out',
      summary: (result) => result.occupant,
    };
  },
  journey: ({ structure }) => ({
    title: 'Schedule a journey',
    intent: 'A vehicle, a route, a departure and the seats on it. Seats are then booked by name.',
    path: `/v1/projects/${state.session.projectId}/site-services/journey`,
    submitLabel: 'Schedule',
    transform: (values) => ({ ...values, seats: Number(values.seats), departs: new Date(values.departs).toISOString(), ...(values.systemId ? {} : { systemId: undefined }) }),
    fields: [
      { name: 'systemId', label: 'For which system', type: 'select', required: false, options: (structure.error ? [] : structure.systems).map((system) => ({ value: system.id, label: `${system.label} — ${system.zone}` })) },
      { name: 'vehicle', label: 'Vehicle' },
      { name: 'route', label: 'Route', hint: 'From where to where.' },
      { name: 'departs', label: 'Departs', type: 'datetime-local' },
      { name: 'seats', label: 'Seats', type: 'number' },
    ],
    done: 'Scheduled',
    summary: (result) => `${result.vehicle}, ${result.route}`,
  }),
  book: ({ desk }) => {
    const open = (desk.error ? [] : desk.transport.journeys).filter((entry) => entry.status === 'SCHEDULED' && entry.booked.length < entry.seats);
    if (open.length === 0) return { blocked: { title: 'No seat', detail: 'No scheduled journey has a seat left.' } };
    return {
      title: 'Book a seat',
      intent: 'By name, never beyond the seats.',
      path: `/v1/projects/${state.session.projectId}/site-services/journey/book`,
      submitLabel: 'Book',
      fields: [
        { name: 'journeyId', label: 'Which journey', type: 'select', options: open.map((entry) => ({ value: entry.id, label: `${entry.vehicle} ${entry.route} at ${entry.departs.slice(0, 16).replace('T', ' ')} — ${entry.seats - entry.booked.length} left` })) },
        { name: 'passenger', label: 'Who' },
      ],
      done: 'Booked',
      summary: (result) => `${result.booked.length} of ${result.seats} seats`,
    };
  },
  journeystatus: ({ desk }) => {
    const live = (desk.error ? [] : desk.transport.journeys).filter((entry) => entry.status === 'SCHEDULED' || entry.status === 'DEPARTED');
    if (live.length === 0) return { blocked: { title: 'No live journey', detail: 'Nothing is scheduled or on the road.' } };
    return {
      title: 'Move a journey on',
      intent: 'Departed, arrived, or cancelled with a reason the passengers will be given.',
      path: `/v1/projects/${state.session.projectId}/site-services/journey/status`,
      submitLabel: 'Record',
      fields: [
        { name: 'journeyId', label: 'Which journey', type: 'select', options: live.map((entry) => ({ value: entry.id, label: `${entry.vehicle} ${entry.route} — ${entry.status.toLowerCase()}` })) },
        { name: 'status', label: 'Now', type: 'select', options: [{ value: 'DEPARTED', label: 'Departed' }, { value: 'ARRIVED', label: 'Arrived' }, { value: 'CANCELLED', label: 'Cancelled' }] },
        { name: 'reason', label: 'Why', required: false, hint: 'Required for a cancellation.' },
      ],
      done: 'Journey updated',
      summary: (result) => `${result.vehicle}: ${result.status.toLowerCase()}`,
    };
  },
  briefdocument: () => ({
    title: 'File a brief document',
    intent:
      'A workforce curve, a welfare schedule or a compound layout, filed as evidence under the name every fact read ' +
      'from it will carry. Reading it is a separate act, on the brief card, with its own cost and its own confirmation.',
    path: `/v1/projects/${state.session.projectId}/site-services/brief/document`,
    submitLabel: 'File',
    fields: [
      { name: 'description', label: 'What the document is', hint: '"Programme rev D, workforce curve sheet 3" — the source every fact read from it will be traced to.' },
      { name: 'hash', label: 'The document', type: 'file' },
    ],
    done: 'Filed',
    summary: (result) => `${result.description} — read it from the brief card once the upload has landed`,
  }),
  promote: () => ({
    title: 'Promote what this project learned',
    intent:
      'Supplier scores from engagements that reached Contracted or were suspended, price benchmarks from fully locked ' +
      'tenders, and package templates. Every field is checked against the names on the appointment and the project, ' +
      'and a field that names the customer is withheld and said so. Nothing already in the library goes up twice.',
    path: `/v1/projects/${state.session.projectId}/site-services/library/promote`,
    submitLabel: 'Promote',
    fields: [{ name: 'note', label: 'Note', required: false, hint: 'Why now, if it is worth saying.' }],
    done: 'Promoted',
    summary: (result) =>
      `${result.suppliers.length} supplier score${result.suppliers.length === 1 ? '' : 's'}, ${result.benchmarks.length} benchmark${result.benchmarks.length === 1 ? '' : 's'}, ${result.templates.length} template${result.templates.length === 1 ? '' : 's'}${
        result.promotion.withheld.length > 0 ? ` · ${result.promotion.withheld.length} withheld, each with its reason` : ''
      }`,
  }),
};

export async function siteservices(root) {
  const [position, readiness, structure, tower, factory, live, commercial, changes, closeout, cash, eac, forecast, desk, portfolio, library, perception, evidence] = await Promise.all([
    api.get(`/v1/projects/${state.session.projectId}/site-services/appointment`).catch((error) => ({ error })),
    api.get(`/v1/projects/${state.session.projectId}/site-services/brief`).catch((error) => ({ error })),
    api.get(`/v1/projects/${state.session.projectId}/site-services/sbs`).catch((error) => ({ error })),
    api.get(`/v1/projects/${state.session.projectId}/site-services/mobilisation`).catch((error) => ({ error })),
    api.get(`/v1/projects/${state.session.projectId}/site-services/procurement`).catch((error) => ({ error })),
    api.get(`/v1/projects/${state.session.projectId}/site-services/operations`).catch((error) => ({ error })),
    api.get(`/v1/projects/${state.session.projectId}/site-services/commercial`).catch((error) => ({ error })),
    api.get(`/v1/projects/${state.session.projectId}/site-services/change`).catch((error) => ({ error })),
    api.get(`/v1/projects/${state.session.projectId}/site-services/demobilisation`).catch((error) => ({ error })),
    api.get(`/v1/projects/${state.session.projectId}/site-services/cash`).catch((error) => ({ error })),
    api.get(`/v1/projects/${state.session.projectId}/site-services/eac`).catch((error) => ({ error })),
    api.get(`/v1/projects/${state.session.projectId}/site-services/forecast`).catch((error) => ({ error })),
    api.get(`/v1/projects/${state.session.projectId}/site-services/desk`).catch((error) => ({ error })),
    api.get('/v1/site-services/portfolio').catch((error) => ({ error })),
    api.get(`/v1/projects/${state.session.projectId}/site-services/library`).catch((error) => ({ error })),
    // What this deployment can read from a file, and the brief drafts waiting
    // to be confirmed. Null, not a refusal card: a reader without the evidence
    // audit capability still gets the brief, only without the reading.
    api.get(`/v1/projects/${state.session.projectId}/perception`).catch(() => null),
    api.get(`/v1/projects/${state.session.projectId}/evidence`).catch(() => null),
  ]);

  // §13 and §17. Separate from the block above because the workspace is chosen
  // on this page and the supplier portal will not answer without a subject —
  // firing it inside the parallel block would mean re-firing all nine every
  // time somebody switched workspace.
  const [centre, automation, workflow, portal] = await Promise.all([
    api
      .get(
        `/v1/projects/${state.session.projectId}/site-services/command-centre/${chosenWorkspace}` +
          (chosenWorkspace === 'SUPPLIER_PORTAL' && portalSupplier ? `?supplierId=${encodeURIComponent(portalSupplier)}` : ''),
      )
      .catch((error) => ({ error })),
    api.get(`/v1/projects/${state.session.projectId}/site-services/automation`).catch((error) => ({ error })),
    api.get(`/v1/projects/${state.session.projectId}/site-services/workflow`).catch((error) => ({ error })),
    // The chosen supplier's valuation and payment state, beside their portal.
    chosenWorkspace === 'SUPPLIER_PORTAL' && portalSupplier
      ? api.get(`/v1/projects/${state.session.projectId}/site-services/portal?supplierId=${encodeURIComponent(portalSupplier)}`).catch((error) => ({ error }))
      : Promise.resolve(null),
  ]);

  // The reconciliation itself, for the valuation that is actually live. It is
  // a second fetch because it is per-valuation, and it is the most useful thing
  // in §10 — a summary of a valuation without its exceptions is the summary the
  // supplier would write.
  const latest = commercial.error ? undefined : commercial.valuations.at(-1);
  const reconciliation = latest
    ? await api
        .get(`/v1/projects/${state.session.projectId}/site-services/assessment/${latest.id}`)
        .catch((error) => ({ error }))
    : undefined;

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
          // Only under Prime. Under the other two the customer's own purchase
          // order is the authority, and the command refuses rather than storing
          // a second answer to who authorised the work — so the door is absent
          // rather than present-and-refused.
          appointment?.model === 'PRINCIPAL_SERVICE_CONTRACTOR'
            ? {
                id: 'authority',
                label: 'Record the authority to proceed',
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
            id: 'briefdocument',
            label: 'File a brief document',
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
          {
            id: 'raise',
            label: 'Raise a service event',
            permitted: can('SITE_SERVICES', 'C'),
            reason: blockedReason('SITE_SERVICES', 'C'),
          },
          {
            id: 'progress',
            label: 'Move an event on',
            permitted: can('SITE_SERVICES', 'U'),
            reason: blockedReason('SITE_SERVICES', 'U'),
          },
          {
            id: 'evidence',
            label: 'Record closure evidence',
            permitted: can('SITE_SERVICES', 'C'),
            reason: blockedReason('SITE_SERVICES', 'C'),
          },
          {
            id: 'closeevent',
            label: 'Close an event',
            permitted: can('SITE_SERVICES', 'A'),
            reason: blockedReason('SITE_SERVICES', 'A'),
          },
          {
            id: 'pause',
            label: 'Pause the response clock',
            permitted: can('SITE_SERVICES', 'A'),
            reason: blockedReason('SITE_SERVICES', 'A'),
          },
          {
            id: 'resume',
            label: 'Resume the clock',
            permitted: can('SITE_SERVICES', 'U'),
            reason: blockedReason('SITE_SERVICES', 'U'),
          },
          {
            id: 'reroute',
            label: 'Route a request to change',
            permitted: can('SITE_SERVICES', 'U'),
            reason: blockedReason('SITE_SERVICES', 'U'),
          },
          {
            id: 'period',
            label: 'Record a service period',
            permitted: can('SITE_SERVICES', 'C'),
            reason: blockedReason('SITE_SERVICES', 'C'),
          },
          {
            id: 'line',
            label: 'Open a contract line',
            permitted: can('SITE_SERVICES', 'C'),
            reason: blockedReason('SITE_SERVICES', 'C'),
          },
          {
            id: 'accepted',
            label: 'Record accepted progress',
            permitted: can('SITE_SERVICES', 'C'),
            reason: blockedReason('SITE_SERVICES', 'C'),
          },
          {
            id: 'valuation',
            label: 'Open a valuation',
            permitted: can('SITE_SERVICES', 'C'),
            reason: blockedReason('SITE_SERVICES', 'C'),
          },
          {
            id: 'application',
            label: 'Record an application',
            permitted: can('SITE_SERVICES', 'C'),
            reason: blockedReason('SITE_SERVICES', 'C'),
          },
          {
            id: 'certify',
            label: 'Certify a valuation',
            permitted: can('SITE_SERVICES', 'A'),
            reason: blockedReason('SITE_SERVICES', 'A'),
          },
          { id: 'payment', label: 'Record a payment', permitted: can('SITE_SERVICES', 'C'), reason: blockedReason('SITE_SERVICES', 'C') },
          { id: 'contingency', label: 'Set the contingency pot', permitted: can('SITE_SERVICES', 'C'), reason: blockedReason('SITE_SERVICES', 'C') },
          { id: 'draw', label: 'Draw on contingency', permitted: can('SITE_SERVICES', 'C'), reason: blockedReason('SITE_SERVICES', 'C') },
          { id: 'snapshot', label: 'Freeze the forecast', permitted: can('SITE_SERVICES', 'C'), reason: blockedReason('SITE_SERVICES', 'C') },
          { id: 'asset', label: 'Register a unit', permitted: can('SITE_SERVICES', 'C'), reason: blockedReason('SITE_SERVICES', 'C') },
          { id: 'scan', label: 'Scan a unit', permitted: can('SITE_SERVICES', 'U'), reason: blockedReason('SITE_SERVICES', 'U') },
          { id: 'delivery', label: 'Schedule a delivery', permitted: can('SITE_SERVICES', 'C'), reason: blockedReason('SITE_SERVICES', 'C') },
          { id: 'deliverycheck', label: 'Check a delivery in', permitted: can('SITE_SERVICES', 'U'), reason: blockedReason('SITE_SERVICES', 'U') },
          { id: 'room', label: 'Register a room', permitted: can('SITE_SERVICES', 'C'), reason: blockedReason('SITE_SERVICES', 'C') },
          { id: 'roomstatus', label: 'Set a room’s state', permitted: can('SITE_SERVICES', 'U'), reason: blockedReason('SITE_SERVICES', 'U') },
          { id: 'bed', label: 'Allocate a bed', permitted: can('SITE_SERVICES', 'C'), reason: blockedReason('SITE_SERVICES', 'C') },
          { id: 'checkin', label: 'Check somebody in', permitted: can('SITE_SERVICES', 'U'), reason: blockedReason('SITE_SERVICES', 'U') },
          { id: 'checkout', label: 'Check somebody out', permitted: can('SITE_SERVICES', 'U'), reason: blockedReason('SITE_SERVICES', 'U') },
          { id: 'journey', label: 'Schedule a journey', permitted: can('SITE_SERVICES', 'C'), reason: blockedReason('SITE_SERVICES', 'C') },
          { id: 'book', label: 'Book a seat', permitted: can('SITE_SERVICES', 'U'), reason: blockedReason('SITE_SERVICES', 'U') },
          { id: 'journeystatus', label: 'Move a journey on', permitted: can('SITE_SERVICES', 'U'), reason: blockedReason('SITE_SERVICES', 'U') },
          { id: 'promote', label: 'Promote what this project learned', permitted: can('SITE_SERVICES', 'A'), reason: blockedReason('SITE_SERVICES', 'A') },
          {
            id: 'credit',
            label: 'Raise a service credit',
            permitted: can('SITE_SERVICES', 'C'),
            reason: blockedReason('SITE_SERVICES', 'C'),
          },
          {
            id: 'approvecredit',
            label: 'Approve a service credit',
            permitted: can('SITE_SERVICES', 'A'),
            reason: blockedReason('SITE_SERVICES', 'A'),
          },
          {
            id: 'change',
            label: 'Raise a change',
            permitted: can('SITE_SERVICES', 'C'),
            reason: blockedReason('SITE_SERVICES', 'C'),
          },
          {
            id: 'notice',
            label: 'Record a contract notice',
            permitted: can('SITE_SERVICES', 'U'),
            reason: blockedReason('SITE_SERVICES', 'U'),
          },
          {
            id: 'movechange',
            label: 'Move a change on',
            permitted: can('SITE_SERVICES', 'A'),
            reason: blockedReason('SITE_SERVICES', 'A'),
          },
          {
            id: 'removal',
            label: 'Agree a removal plan',
            permitted: can('SITE_SERVICES', 'C'),
            reason: blockedReason('SITE_SERVICES', 'C'),
          },
          {
            id: 'rundown',
            label: 'Propose a run-down',
            permitted: can('SITE_SERVICES', 'C'),
            reason: blockedReason('SITE_SERVICES', 'C'),
          },
          {
            id: 'closeout',
            label: 'Open a closeout workstream',
            permitted: can('SITE_SERVICES', 'C'),
            reason: blockedReason('SITE_SERVICES', 'C'),
          },
          {
            id: 'closeoutevidence',
            label: 'Record closeout evidence',
            permitted: can('SITE_SERVICES', 'C'),
            reason: blockedReason('SITE_SERVICES', 'C'),
          },
          {
            id: 'acceptcloseout',
            label: 'Accept a workstream',
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

      ${workflow.error ? refusal('The workflow engine', workflow.error) : workflowCard(workflow)}

      ${library.error ? refusal('The knowledge library', library.error) : libraryCard(library)}

      ${commandCentreCard(centre, factory)}

      ${supplierPaymentCard(portal)}

      ${automation.error ? refusal('The automation measure', automation.error) : automationCard(automation)}

      ${readiness.error ? refusal('Brief readiness', readiness.error) : briefCard(readiness, perception, evidence)}

      ${structure.error ? refusal('The system breakdown structure', structure.error) : sbsCard(structure)}

      ${live.error ? refusal('Live operations', live.error) : operationsCard(live)}

      ${desk.error ? refusal('The desk', desk.error) : deskCard(desk)}

      ${commercial.error ? refusal('Commercial control', commercial.error) : commercialCard(commercial, reconciliation)}

      ${cash.error ? refusal('Cash and the estimate at completion', cash.error) : cashCard(cash, eac, forecast, portfolio)}

      ${changes.error ? refusal('The change register', changes.error) : changeCard(changes)}

      ${closeout.error ? refusal('Demobilisation', closeout.error) : demobCard(closeout)}

      ${factory.error ? refusal('The procurement factory', factory.error) : factoryCard(factory)}

      ${tower.error ? refusal('The mobilisation control tower', tower.error) : towerCard(tower)}

      ${assessment ? assessmentCard(assessment, models) : ''}
    `,
  );

  const again = () => siteservices(root);

  // Switching workspace re-fetches rather than filtering what is already here.
  // The eight command centres do not read the same positions — the control
  // tower is not entitled to the commercial ones — so a client-side filter over
  // one fetch would either over-fetch for everybody or show the wrong refusal.
  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-workspace]');
    if (!button) return;
    chosenWorkspace = button.dataset.workspace;
    if (chosenWorkspace !== 'SUPPLIER_PORTAL') portalSupplier = '';
    again();
  });

  root.querySelector('[data-portal-supplier]')?.addEventListener('change', (event) => {
    portalSupplier = event.target.value;
    again();
  });

  // Reading a filed document, and settling what was read. Written out rather
  // than interpolated: one route per perception task is what makes each one
  // quotable, and the cost is on screen before the provider is asked.
  root.addEventListener('click', async (event) => {
    const read = event.target.closest('[data-read-brief]');
    if (read) {
      const path = `/v1/projects/${state.session.projectId}/perception/site-services-brief`;
      const go = await confirmCost({
        title: 'Read the brief from this document',
        intent:
          'A provider that can see the document reports each brief fact it finds with the words it read it from. ' +
          'Nothing reaches the register until the draft is confirmed here.',
        path,
        runLabel: 'Read',
      });
      if (!go) return;
      read.disabled = true;
      try {
        const draft = await api.post(path, { hash: read.dataset.readBrief });
        toast('Read', `${draft.extraction.facts.length} fact${draft.extraction.facts.length === 1 ? '' : 's'} drafted — confirm or reject each reading below`, 'ok');
        await again();
      } catch (error) {
        toast('Not read', error.message, error.code === 'PERCEPTION_PROVIDER_UNAVAILABLE' ? 'warn' : 'err');
        read.disabled = false;
      }
      return;
    }
    const confirmDraft = event.target.closest('[data-confirm-brief]');
    if (confirmDraft) {
      confirmDraft.disabled = true;
      try {
        const result = await api.post(`/v1/projects/${state.session.projectId}/perception/${confirmDraft.dataset.confirmBrief}/confirm`, {});
        toast('Confirmed', `${result.result.recorded} fact${result.result.recorded === 1 ? '' : 's'} recorded through the same command as typing them in`, 'ok');
        await again();
      } catch (error) {
        toast('Not confirmed', error.message, 'err');
        confirmDraft.disabled = false;
      }
      return;
    }
    const discardDraft = event.target.closest('[data-discard-brief]');
    if (discardDraft) {
      const reason = window.prompt('Why is this reading wrong? It stays on the record either way.');
      if (!reason) return;
      try {
        await api.post(`/v1/projects/${state.session.projectId}/perception/${discardDraft.dataset.discardBrief}/discard`, { reason });
        toast('Rejected', 'The draft stays on the record with your reason; nothing reached the register', 'ok');
        await again();
      } catch (error) {
        toast('Not rejected', error.message, 'err');
      }
    }
  });

  root.querySelector('.cmd-bar')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    const which = button.dataset.command;

    // §13's record families: one spec each, the same panel as every other door.
    const extra = DESK_COMMANDS[which]?.({ commercial, cash, eac, desk, structure, library });
    if (extra) {
      if (extra.blocked) {
        toast(extra.blocked.title, extra.blocked.detail, 'warn');
        return;
      }
      const result = await command(extra);
      if (result) {
        toast(extra.done ?? 'Recorded', extra.summary ? extra.summary(result) : '', 'ok');
        await again();
      }
      return;
    }

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

    if (which === 'authority') {
      const result = await command({
        title: 'Authority to proceed',
        intent:
          'The customer’s instruction and the facility that funds the supply chain until the first customer payment. ' +
          'Under Prime Service Contractor no supplier may be moved to Contracted ahead of both — a commitment without ' +
          'them is one ETABLIX has given with nobody’s authority and nobody’s money.',
        path: `/v1/projects/${state.session.projectId}/site-services/authority`,
        submitLabel: 'Record',
        fields: [
          { name: 'reference', label: 'Customer instruction reference', required: true, hint: 'A document reference, not “verbally agreed”.' },
          { name: 'grantedBy', label: 'Given by', required: true, hint: 'Who at the customer instructed it.' },
          { name: 'grantedOn', label: 'Date given', type: 'date', required: true },
          {
            name: 'creditFacilityMinor',
            label: 'Credit facility',
            type: 'money',
            required: true,
            hint: 'What funds the supply chain until the first customer payment lands.',
          },
        ],
      });
      if (result) {
        toast('Authority recorded', 'Prime awards may now be placed against it.', 'ok');
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

    if (which === 'line') {
      const packages = (factory.error ? [] : factory.packages).map((entry) => ({
        value: entry.id,
        label: `${entry.reference} ${entry.title}`,
      }));
      if (packages.length === 0) {
        toast('No packages', 'A line hangs from a package. Create one first.', 'warn');
        return;
      }
      const result = await command({
        title: 'Open a contract line',
        intent:
          'The earned-value method is chosen here and it decides what the line can ever claim. Hire earns by time and ' +
          'cannot go faster by working harder; a compound earns by milestone and earns nothing until it is accepted; ' +
          'cleaning earns by weighted evidence against the inspection sample. One method applied to all three is how a ' +
          'percentage gets reported that nobody can defend.',
        path: `/v1/projects/${state.session.projectId}/site-services/line`,
        submitLabel: 'Open',
        transform: (values) => ({
          packageId: values.packageId,
          description: values.description,
          budgetMinor: Number(values.budgetMinor),
          commitmentMinor: Number(values.commitmentMinor),
          currency: values.currency,
          method: values.method,
          ...(values.contractQuantity ? { contractQuantity: Number(values.contractQuantity) } : {}),
          ...(values.unit ? { unit: values.unit } : {}),
          ...(values.contractWeeks ? { contractWeeks: Number(values.contractWeeks) } : {}),
          ...(values.systemId ? { systemId: values.systemId } : {}),
        }),
        fields: [
          { name: 'packageId', label: 'Against which package', type: 'select', options: packages },
          { name: 'description', label: 'What the line buys' },
          { name: 'budgetMinor', label: 'Budget in pence', type: 'number' },
          { name: 'commitmentMinor', label: 'Committed in pence', type: 'number' },
          { name: 'currency', label: 'Currency', value: 'GBP' },
          {
            name: 'method',
            label: 'Earns by',
            type: 'select',
            options: (commercial.error ? [] : commercial.methods).map((entry) => ({
              value: entry.id,
              label: `${entry.label} — ${entry.suits}`,
            })),
          },
          { name: 'contractQuantity', label: 'Contract quantity', type: 'number', required: false, hint: 'Required for a quantity line' },
          { name: 'unit', label: 'Unit', required: false },
          { name: 'contractWeeks', label: 'Contract weeks', type: 'number', required: false, hint: 'Required for a time line' },
          {
            name: 'systemId',
            label: 'Against which service',
            type: 'select',
            required: false,
            options: [
              { value: '', label: 'Not tied to one system' },
              ...(structure.error ? [] : structure.systems).map((system) => ({
                value: system.id,
                label: `${system.label} — ${system.zone}`,
              })),
            ],
          },
        ],
      });
      if (result) {
        toast('Line open', `${result.reference} — earns by ${result.method.toLowerCase()}`, 'ok');
        await again();
      }
      return;
    }

    if (which === 'accepted' || which === 'credit') {
      const lines = (commercial.error ? [] : commercial.lines).map((entry) => ({
        value: entry.id,
        label: `${entry.reference} ${entry.description} (${entry.methodLabel.toLowerCase()})`,
      }));
      if (lines.length === 0) {
        toast('No lines', 'Open a contract line before recording anything against one.', 'warn');
        return;
      }

      if (which === 'accepted') {
        const result = await command({
          title: 'Record accepted progress',
          intent:
            'What the platform actually saw, in the line’s own units — accepted quantity, elapsed weeks, the milestone ' +
            'reached, or evidence accepted over evidence required. This is the number the valuation reconciles a claim ' +
            'against, and the difference between the two is the entire valuation.',
          path: `/v1/projects/${state.session.projectId}/site-services/progress`,
          submitLabel: 'Record',
          transform: (values) => ({ ...values, accepted: Number(values.accepted) }),
          fields: [
            { name: 'lineId', label: 'Which line', type: 'select', options: lines },
            { name: 'periodTo', label: 'Position at', type: 'date' },
            {
              name: 'accepted',
              label: 'Accepted',
              type: 'number',
              hint: 'Cumulative, not the period. Three readings of 40, 60 and 80 are one line at 80.',
            },
            {
              name: 'evidence',
              label: 'What was seen',
              type: 'textarea',
              hint: 'The gate, the work order, the meter, the inspection. "Agreed" is what a claim says.',
            },
          ],
        });
        if (result) {
          toast('Recorded', `${result.accepted} accepted to ${result.periodTo}`, 'ok');
          await again();
        }
        return;
      }

      const events = (live.error ? [] : live.events).map((entry) => ({
        value: entry.id,
        label: `${entry.reference} ${entry.defectLabel} (${entry.severity})`,
      }));
      if (events.length === 0) {
        toast('No events', 'A service credit arises from a recorded KPI event, not from a number somebody chose.', 'warn');
        return;
      }
      const result = await command({
        title: 'Raise a service credit',
        intent:
          'Against a recorded KPI event and under the contract formula. Kept as a separate transparent adjustment and ' +
          'never netted into a rate — a rate with a credit inside it is a rate nobody can check and a credit nobody can ' +
          'dispute. A cure period, where the contract gives one, stops it being approved until it has run.',
        path: `/v1/projects/${state.session.projectId}/site-services/credit`,
        submitLabel: 'Raise',
        transform: (values) => ({
          lineId: values.lineId,
          eventId: values.eventId,
          formula: values.formula,
          amountMinor: Number(values.amountMinor),
          ...(values.capMinor ? { capMinor: Number(values.capMinor) } : {}),
          ...(values.cureUntil ? { cureUntil: values.cureUntil } : {}),
        }),
        fields: [
          { name: 'lineId', label: 'Against which line', type: 'select', options: lines },
          { name: 'eventId', label: 'Arising from', type: 'select', options: events },
          { name: 'formula', label: 'Contract formula', type: 'textarea' },
          { name: 'amountMinor', label: 'Amount in pence', type: 'number' },
          { name: 'capMinor', label: 'Contract cap in pence', type: 'number', required: false },
          { name: 'cureUntil', label: 'Cure period runs to', type: 'date', required: false },
        ],
      });
      if (result) {
        toast('Credit raised', money(result.amountMinor) + ' under the contract formula', 'warn');
        await again();
      }
      return;
    }

    if (which === 'approvecredit') {
      const options = (commercial.error ? [] : commercial.credits)
        .filter((entry) => !entry.approvedAt)
        .map((entry) => ({
          value: entry.id,
          label: `${entry.reference} — ${money(entry.amountMinor)}${entry.cureUntil ? ` (cure to ${entry.cureUntil})` : ''}`,
        }));
      if (options.length === 0) {
        toast('Nothing to approve', 'No service credit is waiting.', 'ok');
        return;
      }
      const result = await command({
        title: 'Approve a service credit',
        intent:
          'The deduction becomes real here. Refused inside the cure period, because that period is the supplier’s ' +
          'contractual chance to put it right and deducting inside it deducts for a failure they are still entitled to fix.',
        path: `/v1/projects/${state.session.projectId}/site-services/credit/approve`,
        submitLabel: 'Approve',
        fields: [{ name: 'creditId', label: 'Which credit', type: 'select', options }],
      });
      if (result) {
        toast('Approved', money(result.amountMinor) + ' deducted', 'warn');
        await again();
      }
      return;
    }

    if (which === 'valuation') {
      const result = await command({
        title: 'Open a valuation',
        intent:
          'Opens the period and freezes its cut-off. Only one valuation is open at a time: two means one period’s ' +
          'progress can be claimed in both, which is the commonest way a supplier is paid twice for one week.',
        path: `/v1/projects/${state.session.projectId}/site-services/valuation`,
        submitLabel: 'Open',
        fields: [
          { name: 'periodFrom', label: 'Period from', type: 'date' },
          { name: 'periodTo', label: 'Period to', type: 'date' },
        ],
      });
      if (result) {
        toast('Valuation open', `${result.reference} to ${result.periodTo}`, 'ok');
        await again();
      }
      return;
    }

    if (which === 'application' || which === 'certify') {
      const open = (commercial.error ? [] : commercial.valuations).filter((entry) => entry.status !== 'CERTIFIED');
      if (open.length === 0) {
        toast('No open valuation', 'Open a valuation period first.', 'warn');
        return;
      }

      if (which === 'application') {
        const lines = (commercial.error ? [] : commercial.lines).map((entry) => ({
          value: entry.id,
          label: `${entry.reference} ${entry.description}`,
        }));
        const result = await command({
          title: 'Record the supplier application',
          intent:
            'What the supplier says it did, mapped to a contract line. It is a claim and it is recorded as one — what ' +
            'the platform accepted is a different number, and the reconciliation between them is the valuation.',
          path: `/v1/projects/${state.session.projectId}/site-services/application`,
          submitLabel: 'Record',
          transform: (values) => ({
            valuationId: values.valuationId,
            lines: [{ lineId: values.lineId, claimed: Number(values.claimed), narrative: values.narrative }],
          }),
          fields: [
            {
              name: 'valuationId',
              label: 'Which valuation',
              type: 'select',
              options: open.map((entry) => ({ value: entry.id, label: `${entry.reference} to ${entry.periodTo}` })),
            },
            { name: 'lineId', label: 'Which line', type: 'select', options: lines },
            { name: 'claimed', label: 'Claimed', type: 'number', hint: 'In the line’s own units, cumulative' },
            { name: 'narrative', label: 'What they say they did', type: 'textarea', required: false },
          ],
        });
        if (result) {
          toast('Application recorded', result.reference, 'ok');
          await again();
        }
        return;
      }

      const result = await command({
        title: 'Certify a valuation',
        intent:
          'Refused while any line claims more than the accepted evidence supports. That refusal is the whole point: a ' +
          'certificate issued over an unreconciled overclaim is the moment a claim becomes an actual, and every ' +
          'downstream number — cost, forecast, cash — is wrong from then on.',
        path: `/v1/projects/${state.session.projectId}/site-services/certify`,
        submitLabel: 'Certify',
        fields: [
          {
            name: 'valuationId',
            label: 'Which valuation',
            type: 'select',
            options: open.map((entry) => ({
              value: entry.id,
              label: `${entry.reference} — ${entry.exceptions} exception${entry.exceptions === 1 ? '' : 's'}`,
            })),
          },
          { name: 'note', label: 'What is certified and on what basis', type: 'textarea' },
        ],
      });
      if (result) {
        toast('Certified', `${result.reference} — ${money(result.certifiedMinor)}`, 'ok');
        await again();
      }
      return;
    }

    if (which === 'change') {
      const result = await command({
        title: 'Raise a change',
        intent:
          'Entitlement, probability and value are three separate fields and stay that way — collapsed into one expected ' +
          'value, nobody can see which of the three is the weak one, and it is always a different one. What it is worth ' +
          'goes onto the forecast risk-adjusted from today, with no quotation anywhere near it.',
        path: `/v1/projects/${state.session.projectId}/site-services/change`,
        submitLabel: 'Raise',
        transform: (values) => ({
          trigger: values.trigger,
          summary: values.summary,
          difference: values.difference,
          entitlement: values.entitlement,
          probabilityPercent: Number(values.probabilityPercent),
          valueMinor: Number(values.valueMinor),
          ...(values.noticeDueBy ? { noticeDueBy: values.noticeDueBy } : {}),
        }),
        fields: [
          {
            name: 'trigger',
            label: 'Trigger',
            type: 'select',
            options: (changes.error ? [] : changes.triggers).map((entry) => ({
              value: entry.id,
              label: `${entry.label} — ${entry.analysis}`,
            })),
          },
          { name: 'summary', label: 'What the change is' },
          {
            name: 'difference',
            label: 'What is different from the baseline',
            type: 'textarea',
            hint: '"As discussed" is not a difference, and a change that cannot name what moved cannot be defended.',
          },
          {
            name: 'entitlement',
            label: 'Entitlement',
            type: 'select',
            options: (changes.error ? [] : changes.entitlements).map((entry) => ({
              value: entry.id,
              label: `${entry.label} — ${entry.detail}`,
            })),
          },
          { name: 'probabilityPercent', label: 'Probability the entitlement holds', type: 'number' },
          { name: 'valueMinor', label: 'Worth in pence if it does', type: 'number', hint: 'Zero is a value; absent is not' },
          { name: 'noticeDueBy', label: 'Contract notice due by', type: 'date', required: false },
        ],
      });
      if (result) {
        toast('Raised', `${result.reference} — ${money(result.valueMinor)} at ${result.probabilityPercent}%`, 'warn');
        await again();
      }
      return;
    }

    if (which === 'notice' || which === 'movechange') {
      const live2 = (changes.error ? [] : changes.changes).filter(
        (entry) => entry.status !== 'AGREED' && entry.status !== 'REJECTED',
      );
      if (live2.length === 0) {
        toast('Nothing live', 'Every change is agreed or rejected.', 'ok');
        return;
      }

      if (which === 'notice') {
        const outstanding = live2.filter((entry) => entry.noticeOutstanding);
        if (outstanding.length === 0) {
          toast('No notice outstanding', 'Every notice-bearing change has one on the file.', 'ok');
          return;
        }
        const result = await command({
          title: 'Record the contract notice',
          intent:
            'A notice is a contractual act with a reference and a date. The commonest way an entitlement is lost is ' +
            'that everybody assumed somebody had sent one.',
          path: `/v1/projects/${state.session.projectId}/site-services/change/notified`,
          submitLabel: 'Record',
          fields: [
            {
              name: 'changeId',
              label: 'Which change',
              type: 'select',
              options: outstanding.map((entry) => ({
                value: entry.id,
                label: `${entry.reference} ${entry.summary}${entry.noticeLapsed ? ' — period passed' : ''}`,
              })),
            },
            { name: 'reference', label: 'Notice reference', hint: 'The letter, the portal entry, the email' },
          ],
        });
        if (result) {
          toast('Notice recorded', result.noticeReference, 'ok');
          await again();
        }
        return;
      }

      const result = await command({
        title: 'Move a change on',
        intent:
          'The value and the probability are re-stated with the move rather than edited separately, because a change ' +
          'that has reached instruction still carrying the early-warning guess is a change nobody re-thought. Agreeing ' +
          'one sets its probability to certainty, and a change still below that has been quoted, not agreed.',
        path: `/v1/projects/${state.session.projectId}/site-services/change/progress`,
        submitLabel: 'Move it',
        transform: (values) => ({
          changeId: values.changeId,
          to: values.to,
          basis: values.basis,
          ...(values.valueMinor ? { valueMinor: Number(values.valueMinor) } : {}),
          ...(values.probabilityPercent ? { probabilityPercent: Number(values.probabilityPercent) } : {}),
          ...(values.entitlement ? { entitlement: values.entitlement } : {}),
        }),
        fields: [
          {
            name: 'changeId',
            label: 'Which change',
            type: 'select',
            options: live2.map((entry) => ({
              value: entry.id,
              label: `${entry.reference} ${entry.summary} (${entry.status.replaceAll('_', ' ').toLowerCase()})`,
            })),
          },
          {
            name: 'to',
            label: 'To',
            type: 'select',
            options: [
              { value: 'NOTIFIED', label: 'Notified' },
              { value: 'QUOTED', label: 'Quoted' },
              { value: 'INSTRUCTED', label: 'Instructed' },
              { value: 'AGREED', label: 'Agreed — certain by definition' },
              { value: 'REJECTED', label: 'Rejected' },
            ],
          },
          { name: 'basis', label: 'What moved it', type: 'textarea' },
          { name: 'valueMinor', label: 'Revised worth in pence', type: 'number', required: false },
          { name: 'probabilityPercent', label: 'Revised probability', type: 'number', required: false },
          {
            name: 'entitlement',
            label: 'Revised entitlement',
            type: 'select',
            required: false,
            options: [
              { value: '', label: 'Unchanged' },
              ...(changes.error ? [] : changes.entitlements).map((entry) => ({ value: entry.id, label: entry.label })),
            ],
          },
        ],
      });
      if (result) {
        toast('Moved', `${result.reference} — ${result.status.replaceAll('_', ' ').toLowerCase()}`, 'ok');
        await again();
      }
      return;
    }

    if (which === 'removal' || which === 'rundown') {
      const systems = (structure.error ? [] : structure.systems).map((system) => ({
        value: system.id,
        label: `${system.label} — ${system.zone}`,
      }));
      if (systems.length === 0) {
        toast('Nothing composed', 'Demobilisation begins at design, and the design has not started.', 'warn');
        return;
      }

      if (which === 'removal') {
        const result = await command({
          title: 'Agree the removal plan',
          intent:
            'At design, not at the end. Six fields, and every one becomes an argument if it is agreed later: who does ' +
            'it, how, what starts it, what it costs, where the material goes and what condition the land comes back in. ' +
            'The moment to agree who breaks out a hardstanding is the moment before it is poured.',
          path: `/v1/projects/${state.session.projectId}/site-services/removal`,
          submitLabel: 'Agree',
          transform: (values) => ({ ...values, costMinor: Number(values.costMinor) }),
          fields: [
            { name: 'systemId', label: 'Which system', type: 'select', options: systems },
            { name: 'owner', label: 'Who does it', hint: 'A firm, not a function' },
            { name: 'method', label: 'How', type: 'textarea', hint: '"Removed" is not a method' },
            { name: 'trigger', label: 'What starts it', hint: 'A date, a milestone, or a successor being ready' },
            { name: 'costMinor', label: 'Cost in pence', type: 'number', hint: 'Zero is allowed; absent is not' },
            { name: 'currency', label: 'Currency', value: 'GBP', required: false },
            { name: 'wasteRoute', label: 'Where the material goes', hint: 'A licensed destination, not "off site"' },
            { name: 'reinstatementCriterion', label: 'Returned in what condition', type: 'textarea', hint: 'And against which record' },
          ],
        });
        if (result) {
          toast('Plan agreed', `${result.owner} — ${money(result.costMinor)}`, 'ok');
          await again();
        }
        return;
      }

      const result = await command({
        title: 'Propose a demand run-down',
        intent:
          'Refused where it would take welfare below the statutory minimum for the people still on site — the same ' +
          'Schedule 1 table the welfare was sized from, read in reverse. This is the phase where the last WCs go back ' +
          'because the compound is "finishing" and there are still forty people working.',
        path: `/v1/projects/${state.session.projectId}/site-services/rundown`,
        submitLabel: 'Propose',
        transform: (values) => ({
          systemId: values.systemId,
          remainingPersons: Number(values.remainingPersons),
          remainingWcs: Number(values.remainingWcs),
          effectiveFrom: values.effectiveFrom,
          ...(values.successor ? { successor: values.successor } : {}),
          basis: values.basis,
        }),
        fields: [
          { name: 'systemId', label: 'Which system', type: 'select', options: systems },
          { name: 'effectiveFrom', label: 'Effective from', type: 'date' },
          { name: 'remainingPersons', label: 'People still on site after this', type: 'number' },
          { name: 'remainingWcs', label: 'WCs remaining', type: 'number' },
          {
            name: 'successor',
            label: 'Successor facility',
            required: false,
            hint: 'Where the provision moves to, if it moves rather than goes',
          },
          { name: 'basis', label: 'Where the headcount comes from', type: 'textarea' },
        ],
      });
      if (result) {
        toast('Run-down proposed', `${result.remainingPersons} people, ${result.remainingWcs} WCs`, 'warn');
        await again();
      }
      return;
    }

    if (which === 'closeout' || which === 'closeoutevidence' || which === 'acceptcloseout') {
      if (which === 'closeout') {
        const result = await command({
          title: 'Open a closeout workstream',
          intent:
            'Closeout is planned backwards from land, customer and permanent-works acceptance. Each of the seven ' +
            'workstreams closes on the evidence it declares, and none of them closes on a narrative.',
          path: `/v1/projects/${state.session.projectId}/site-services/closeout`,
          submitLabel: 'Open',
          transform: (values) => ({
            workstream: values.workstream,
            ...(values.systemId ? { systemId: values.systemId } : {}),
          }),
          fields: [
            {
              name: 'workstream',
              label: 'Which workstream',
              type: 'select',
              options: (closeout.error ? [] : closeout.workstreams).map((entry) => ({
                value: entry.id,
                label: `${entry.label} — closes on ${entry.acceptance}`,
              })),
            },
            {
              name: 'systemId',
              label: 'Against which system',
              type: 'select',
              required: false,
              options: [
                { value: '', label: 'The whole project' },
                ...(structure.error ? [] : structure.systems).map((system) => ({
                  value: system.id,
                  label: `${system.label} — ${system.zone}`,
                })),
              ],
            },
          ],
        });
        if (result) {
          toast('Opened', result.workstream.replaceAll('_', ' ').toLowerCase(), 'ok');
          await again();
        }
        return;
      }

      const accepting = which === 'acceptcloseout';
      const records = (closeout.error ? [] : closeout.workstreams).flatMap((workstream) =>
        workstream.records
          .filter((record) => (accepting ? record.status !== 'ACCEPTED' : record.status !== 'ACCEPTED'))
          .map((record) => ({
            value: record.id,
            label: `${workstream.label}${record.systemLabel ? ` — ${record.systemLabel}` : ''} (${record.evidence.length} evidenced)`,
          })),
      );
      if (records.length === 0) {
        toast('Nothing open', 'No closeout workstream is open.', 'warn');
        return;
      }

      const result = await command({
        title: accepting ? 'Accept a workstream' : 'Record closeout evidence',
        intent: accepting
          ? 'Refused on a narrative. A closeout accepted without the evidence its workstream declares reopens the day ' +
            'the landowner walks the site — and the demand run-down cannot be accepted with no run-down behind it, ' +
            'because that accepts the assumption that everybody left.'
          : 'A reference and what it shows: the consignment note number and what it consigned, the survey and what it ' +
            'surveyed. Evidence added after acceptance is evidence for a dispute, not for the acceptance.',
        path: accepting
          ? `/v1/projects/${state.session.projectId}/site-services/closeout/accept`
          : `/v1/projects/${state.session.projectId}/site-services/closeout/evidence`,
        submitLabel: accepting ? 'Accept' : 'Record',
        fields: [
          { name: 'recordId', label: 'Which workstream', type: 'select', options: records },
          ...(accepting
            ? [{ name: 'note', label: 'What is being accepted', type: 'textarea' }]
            : [
                { name: 'reference', label: 'Reference' },
                { name: 'description', label: 'What it shows', type: 'textarea' },
              ]),
        ],
      });
      if (result) {
        toast(accepting ? 'Accepted' : 'Recorded', result.workstream.replaceAll('_', ' ').toLowerCase(), 'ok');
        await again();
      }
      return;
    }

    if (which === 'raise') {
      const systems = (structure.error ? [] : structure.systems).map((system) => ({
        value: system.id,
        label: `${system.label} — ${system.zone}`,
      }));
      if (systems.length === 0) {
        toast('Nothing composed', 'An event against nothing cannot be sized, priced or learned from.', 'warn');
        return;
      }
      const result = await command({
        title: 'Raise a service event',
        intent:
          'The sense step. What happened, where it came from, and how bad it is — and the severity decides what the ' +
          'platform does about it, not just what colour it is. A P1 gets an immediate acknowledgement, an incident ' +
          'command and a temporary control it cannot be closed without.',
        path: `/v1/projects/${state.session.projectId}/site-services/event`,
        submitLabel: 'Raise',
        fields: [
          { name: 'systemId', label: 'Against which service', type: 'select', options: systems },
          {
            name: 'defectType',
            label: 'What has gone wrong',
            type: 'select',
            options: (live.error ? [] : live.defectTypes).map((entry) => ({
              value: entry.id,
              label: `${entry.label} — closes on ${entry.closure.join(', ').toLowerCase().replaceAll('_', ' ')}`,
            })),
          },
          {
            name: 'severity',
            label: 'Severity',
            type: 'select',
            options: (live.error ? [] : live.severities).map((entry) => ({
              value: entry.id,
              label: `${entry.id} ${entry.label} — ${entry.definition}`,
            })),
          },
          { name: 'summary', label: 'What happened', type: 'textarea' },
          {
            name: 'source',
            label: 'Where it came from',
            hint: 'The call, the inspection, the meter, the roster. An event with no source reconciles against nothing.',
          },
          { name: 'zone', label: 'Zone', required: false, hint: 'Leave blank for the whole service' },
        ],
      });
      if (result) {
        toast('Raised', `${result.reference} — ${result.severity}`, result.severity === 'P1' ? 'bad' : 'warn');
        await again();
      }
      return;
    }

    if (which === 'progress' || which === 'evidence' || which === 'closeevent' || which === 'pause' || which === 'resume' || which === 'reroute') {
      const openEvents = (live.error ? [] : live.events).filter((entry) => entry.status !== 'CLOSED');
      const options = openEvents.map((entry) => ({
        value: entry.id,
        label: `${entry.reference} ${entry.defectLabel} (${entry.severity}, ${entry.status.replaceAll('_', ' ').toLowerCase()})`,
      }));
      if (options.length === 0) {
        toast('Nothing open', 'Every service event on this project is closed.', 'ok');
        return;
      }

      if (which === 'progress') {
        const result = await command({
          title: 'Move an event on',
          intent:
            'Acknowledged, then attended, then temporarily restored — in that order, because the response clock is ' +
            'measured between them. Attendance recorded before acknowledgement makes the response time read zero, ' +
            'which is how a response measure stops measuring anything.',
          path: `/v1/projects/${state.session.projectId}/site-services/event/progress`,
          submitLabel: 'Record it',
          fields: [
            { name: 'eventId', label: 'Which event', type: 'select', options },
            {
              name: 'to',
              label: 'To',
              type: 'select',
              options: [
                { value: 'ACKNOWLEDGED', label: 'Acknowledged — somebody owns it' },
                { value: 'ATTENDED', label: 'Attended — somebody is there' },
                { value: 'TEMPORARILY_RESTORED', label: 'Temporarily restored — there is an interim measure' },
              ],
            },
            {
              name: 'note',
              label: 'The temporary control',
              type: 'textarea',
              required: false,
              hint: 'Required when temporarily restoring. The next shift has to know what they are relying on.',
            },
          ],
        });
        if (result) {
          toast('Recorded', `${result.reference} — ${result.status.replaceAll('_', ' ').toLowerCase()}`, 'ok');
          await again();
        }
        return;
      }

      if (which === 'evidence') {
        const chosen = openEvents[0];
        const result = await command({
          title: 'Record closure evidence',
          intent:
            'The verify step, and the one every service desk skips. The defect type decides which kinds count — a ' +
            'photograph of a tap proves nothing about the water temperature, and a supplier signing off their own ' +
            'cleaning is not an inspection. Evidence of a kind the defect does not close on is refused.',
          path: `/v1/projects/${state.session.projectId}/site-services/event/evidence`,
          submitLabel: 'Record',
          fields: [
            { name: 'eventId', label: 'Which event', type: 'select', options },
            {
              name: 'kind',
              label: 'Kind',
              type: 'select',
              options: (chosen?.closure ?? []).map((entry) => ({
                value: entry.kind,
                label: `${entry.kind.replaceAll('_', ' ').toLowerCase()}${entry.satisfied ? ' — already held' : ''}`,
              })),
              hint: 'The kinds listed are the ones the first open event needs; another event may need different ones.',
            },
            { name: 'reference', label: 'Reference', hint: 'The photograph, the reading, the sheet. Never a tick.' },
          ],
        });
        if (result) {
          toast('Recorded', `${result.reference} — ${result.evidence.length} pieces held`, 'ok');
          await again();
        }
        return;
      }

      if (which === 'closeevent') {
        const result = await command({
          title: 'Close an event',
          intent:
            'Refused while any evidence the defect type demands is missing, while a critical event has no temporary ' +
            'control recorded, or while the clock is still stopped. A closure is the moment the service is declared ' +
            'restored, and it is the last moment any of that is cheap to notice.',
          path: `/v1/projects/${state.session.projectId}/site-services/event/close`,
          submitLabel: 'Close',
          fields: [
            { name: 'eventId', label: 'Which event', type: 'select', options },
            { name: 'note', label: 'What was actually done', type: 'textarea' },
          ],
        });
        if (result) {
          toast('Closed', result.reference, 'ok');
          await again();
        }
        return;
      }

      if (which === 'pause') {
        const result = await command({
          title: 'Pause the response clock',
          intent:
            'The clock is what the service credit is calculated from, so a pause needs a reason and the customer who ' +
            'agreed it. A P1 clock does not pause at all: the pause on a critical event is always agreed in the room ' +
            'where the pressure is, and recording it would measure the pressure rather than the response.',
          path: `/v1/projects/${state.session.projectId}/site-services/event/pause`,
          submitLabel: 'Pause',
          fields: [
            {
              name: 'eventId',
              label: 'Which event',
              type: 'select',
              options: options.filter((entry) => !entry.label.includes('(P1')),
            },
            { name: 'reason', label: 'Why it is stopping', type: 'textarea' },
            { name: 'approvedBy', label: 'Approved by', hint: 'The customer, by name' },
          ],
        });
        if (result) {
          toast('Paused', `${result.reference} — ${result.pauses.at(-1).approvedBy}`, 'warn');
          await again();
        }
        return;
      }

      if (which === 'resume') {
        const paused = openEvents.filter((entry) => entry.pauses.some((pause) => !pause.to));
        if (paused.length === 0) {
          toast('Nothing paused', 'No response clock is stopped.', 'ok');
          return;
        }
        const result = await command({
          title: 'Resume the clock',
          intent: 'The clock starts again from now, and the paused minutes come out of the response time rather than out of the record.',
          path: `/v1/projects/${state.session.projectId}/site-services/event/resume`,
          submitLabel: 'Resume',
          fields: [
            {
              name: 'eventId',
              label: 'Which event',
              type: 'select',
              options: paused.map((entry) => ({ value: entry.id, label: `${entry.reference} ${entry.defectLabel}` })),
            },
          ],
        });
        if (result) {
          toast('Resumed', result.reference, 'ok');
          await again();
        }
        return;
      }

      const requests = openEvents.filter((entry) => entry.severity === 'P4' && !entry.routedToChange);
      if (requests.length === 0) {
        toast('No requests', 'Nothing open is a P4. A defect routed to change control is a defect nobody fixed.', 'warn');
        return;
      }
      const result = await command({
        title: 'Route a request to change control',
        intent:
          'A move, add or change is not a failure of the service and does not belong in the availability figure. ' +
          'Fulfilled as if it were a defect it is scope delivered for nothing.',
        path: `/v1/projects/${state.session.projectId}/site-services/event/route`,
        submitLabel: 'Route it',
        fields: [
          {
            name: 'eventId',
            label: 'Which request',
            type: 'select',
            options: requests.map((entry) => ({ value: entry.id, label: `${entry.reference} ${entry.summary}` })),
          },
          { name: 'reason', label: 'What makes this a change rather than an entitlement', type: 'textarea' },
        ],
      });
      if (result) {
        toast('Routed', result.reference, 'warn');
        await again();
      }
      return;
    }

    if (which === 'period') {
      const systems = (structure.error ? [] : structure.systems).map((system) => ({
        value: system.id,
        label: `${system.label} — ${system.zone}`,
      }));
      if (systems.length === 0) {
        toast('Nothing composed', 'There is no service to measure availability against.', 'warn');
        return;
      }
      const result = await command({
        title: 'Record a service period',
        intent:
          'Available minutes over required minutes. Degraded minutes are a separate figure and are never counted as ' +
          'available. A planned exclusion counts only if it was approved before the outage began — approved ' +
          'afterwards it is a failure with a note on it, and counting it as planned is the commonest way an ' +
          'availability figure stops meaning anything.',
        path: `/v1/projects/${state.session.projectId}/site-services/period`,
        submitLabel: 'Record',
        transform: (values) => ({
          systemId: values.systemId,
          from: values.from,
          to: values.to,
          requiredMinutes: Number(values.requiredMinutes),
          availableMinutes: Number(values.availableMinutes),
          ...(values.degradedMinutes ? { degradedMinutes: Number(values.degradedMinutes) } : {}),
          ...(values.exclusionFrom
            ? {
                plannedExclusions: [
                  {
                    from: values.exclusionFrom,
                    to: values.exclusionTo,
                    reason: values.exclusionReason,
                    approvedAt: values.exclusionApprovedAt,
                    approvedBy: values.exclusionApprovedBy,
                  },
                ],
              }
            : {}),
        }),
        fields: [
          { name: 'systemId', label: 'Which service', type: 'select', options: systems },
          { name: 'from', label: 'Period from', type: 'date' },
          { name: 'to', label: 'Period to', type: 'date' },
          { name: 'requiredMinutes', label: 'Minutes required', type: 'number' },
          { name: 'availableMinutes', label: 'Minutes available', type: 'number' },
          { name: 'degradedMinutes', label: 'Minutes degraded', type: 'number', required: false },
          { name: 'exclusionFrom', label: 'Planned exclusion from', type: 'date', required: false },
          { name: 'exclusionTo', label: 'Planned exclusion to', type: 'date', required: false },
          { name: 'exclusionReason', label: 'Exclusion reason', required: false },
          {
            name: 'exclusionApprovedAt',
            label: 'Exclusion approved on',
            type: 'date',
            required: false,
            hint: 'Must be before the outage started, or it is not a planned exclusion.',
          },
          { name: 'exclusionApprovedBy', label: 'Exclusion approved by', required: false },
        ],
      });
      if (result) {
        toast('Recorded', `${result.window.availableMinutes} of ${result.window.requiredMinutes} minutes`, 'ok');
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
function briefCard(readiness, perception, evidence) {
  const { families, percentKnown, conflicts, overdue, interview } = readiness;
  return html`
    <div class="card" style="margin-bottom:14px">
      <h2>Brief readiness</h2>
      <div class="metric-sub" style="margin:6px 0 12px">
        ${pct(percentKnown)} of the ${families.reduce((sum, family) => sum + family.items, 0)} facts a site-services
        system is designed from are settled. The percentage is a caption, not the answer — what each gap decides is
        below it.
      </div>

      ${briefReading(perception, evidence)}

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

const CHANGE_TONE = {
  EARLY_WARNING: 'warn',
  NOTIFIED: 'info',
  QUOTED: 'info',
  INSTRUCTED: 'warn',
  AGREED: 'ok',
  REJECTED: '',
};
const ENTITLEMENT_TONE = { CLEAR: 'ok', ARGUABLE: 'warn', WEAK: 'bad', NONE: 'bad' };

/**
 * Commercial control, with three numbers kept apart.
 *
 * Budget, earned and certified are three different figures and every commercial
 * system on the market collapses them into one. That collapse is why a job can
 * be 40% paid, 25% delivered and reported as on track — so this shows all
 * three, and the exception list underneath is the difference between what was
 * claimed and what the platform's own records support.
 */
function commercialCard(control, assessment) {
  const { lines, valuations, credits, totals, methods, records, statement } = control;

  return html`
    <div class="card" style="margin-bottom:14px">
      <h2>Commercial control</h2>
      <div class="metric-sub" style="margin:6px 0 12px">${statement}</div>

      ${lines.length > 0
        ? html`<section class="grid g4" style="margin-bottom:14px">
              <div class="card">
                <h2>Budget</h2>
                <div class="metric">${money(totals.budgetMinor)}</div>
                <div class="metric-sub">Approved control budget across every line</div>
              </div>
              <div class="card">
                <h2>Committed</h2>
                <div class="metric">${money(totals.commitmentMinor)}</div>
                <div class="metric-sub">Executed contracts and orders</div>
              </div>
              <div class="card">
                <h2>Earned</h2>
                <div class="metric">${money(totals.earnedMinor)}</div>
                <div class="metric-sub">Budgeted value of accepted progress</div>
              </div>
              <div class="card">
                <h2>Certified</h2>
                <div class="metric">${money(totals.certifiedMinor)}</div>
                <div class="metric-sub">What somebody signed for</div>
              </div>
            </section>

            ${table({
              headers: ['Line', 'Earns by', 'Budget', 'Committed', 'Earned', 'Credits'],
              align: ['', '', 'num', 'num', 'num', 'num'],
              rows: lines.map((line) => [
                html`<b>${line.reference}</b>
                  <div class="metric-sub">${line.description}</div>`,
                html`${badge(line.methodLabel.toLowerCase(), 'info')}
                  <div class="metric-sub">
                    ${methods.find((entry) => entry.id === line.method)?.detail ?? ''}
                  </div>`,
                money(line.budgetMinor),
                money(line.commitmentMinor),
                money(line.earnedMinor),
                line.credits > 0 ? badge(String(line.credits), 'warn') : '0',
              ]),
            })}`
        : ''}

      ${valuations.length > 0
        ? html`<div style="padding:14px 0 0;border-top:1px solid var(--line)">
            <h2>Valuations</h2>
            ${table({
              headers: ['Period', 'Status', 'Gross', 'Net', 'Exceptions', 'Certified'],
              align: ['', '', 'num', 'num', 'num', 'num'],
              rows: valuations.map((entry) => [
                html`<b>${entry.reference}</b>
                  <div class="metric-sub">${entry.periodFrom} to ${entry.periodTo}</div>`,
                badge(entry.status.toLowerCase(), entry.status === 'CERTIFIED' ? 'ok' : 'warn'),
                money(entry.grossMinor),
                money(entry.netMinor),
                entry.exceptions > 0 ? badge(String(entry.exceptions), 'bad') : '0',
                entry.certifiedMinor === undefined ? '—' : money(entry.certifiedMinor),
              ]),
            })}
          </div>`
        : ''}

      ${assessment && !assessment.error
        ? html`<div style="padding:14px 0 0;border-top:1px solid var(--line)">
            <h2>${assessment.reference} — reconciled</h2>
            <div class="metric-sub" style="margin:6px 0 10px">
              ${assessment.periodFrom} to ${assessment.periodTo}. Claimed against what the accepted evidence supports.
              <b>${assessment.issues}</b>
            </div>
            ${table({
              headers: ['Line', 'Earns by', 'Claimed', 'Accepted', 'Earned', 'This period'],
              align: ['', '', 'num', 'num', 'num', 'num'],
              rows: assessment.lines.map((line) => [
                html`${line.reference}
                  <div class="metric-sub">${line.acceptedEvidence ?? 'Nothing accepted yet.'}</div>`,
                line.methodLabel.toLowerCase(),
                line.claimed === undefined ? html`<span class="metric-sub">not claimed</span>` : line.claimed,
                line.accepted,
                money(line.earnedMinor),
                money(line.movementMinor),
              ]),
            })}
            ${assessment.exceptions.length > 0
              ? html`<div style="margin-top:12px">
                  ${assessment.exceptions.map(
                    (exception) => html`<div class="notice ${exception.effectMinor < 0 ? 'bad' : 'warn'}" style="margin-bottom:8px">
                      <div>
                        <b>${exception.kind.replaceAll('_', ' ').toLowerCase()} — ${exception.reference}.</b>
                        ${exception.statement}
                        ${exception.effectMinor !== 0
                          ? html`<br /><b>Worth ${money(Math.abs(exception.effectMinor))}.</b>`
                          : ''}
                      </div>
                    </div>`,
                  )}
                </div>`
              : html`<div class="notice ok" style="margin-top:12px">
                  <div>Nothing claimed exceeds what the evidence supports.</div>
                </div>`}
            <!--
              A valuation that has been certified is not "not certifiable" —
              that reads as a problem when it is the opposite. The flag means
              "can be certified now", and once it has been the honest word is
              the past tense.
            -->
            <div class="metric-sub" style="margin-top:10px">
              Gross ${money(assessment.grossMinor)} · net ${money(assessment.netMinor)} ·
              ${assessment.status === 'CERTIFIED'
                ? badge('certified', 'ok')
                : assessment.certifiable
                  ? badge('ready to certify', 'ok')
                  : html`${badge('not certifiable', 'bad')}
                      <div class="metric-sub bad">${assessment.blockedBecause}</div>`}
            </div>
          </div>`
        : ''}

      ${credits.length > 0
        ? html`<div style="padding:14px 0 0;border-top:1px solid var(--line)">
            <h2>Service credits</h2>
            <div class="metric-sub" style="margin:6px 0 10px">
              Kept as separate transparent adjustments and never netted into a rate — a rate with a credit inside it is
              a rate nobody can check and a credit nobody can dispute.
            </div>
            ${table({
              headers: ['Line', 'Formula', 'Amount', 'Position'],
              align: ['', '', 'num', ''],
              rows: credits.map((credit) => [
                credit.reference,
                credit.formula,
                money(credit.amountMinor),
                credit.approvedAt
                  ? badge('approved', 'ok')
                  : credit.cureUntil
                    ? badge(`in cure to ${credit.cureUntil}`, 'warn')
                    : badge('raised', 'info'),
              ]),
            })}
          </div>`
        : ''}

      <div style="padding:14px 0 0;border-top:1px solid var(--line)">
        <h2>The eight records</h2>
        <div class="metric-sub" style="margin:6px 0 10px">
          Kept apart on purpose. An invoice is not proof of value, and a system that collapses commitment, actual and
          earned value into one number cannot tell you which of the three is wrong.
        </div>
        ${table({
          headers: ['Record', 'What it controls'],
          rows: records.map((record) => [html`<b>${record.label}</b>`, record.control]),
        })}
      </div>
    </div>
  `;
}

/**
 * The change register, and the number the golden rule exists to keep on it.
 *
 * Pending change is shown risk-adjusted *and* at face value. A forecast that
 * carries only the agreed changes is a forecast that says the job is on budget
 * until the month somebody agrees a number, and the gap between those two
 * figures is exactly what is being ignored.
 */
function changeCard(register) {
  const { changes, triggers, agreedMinor, exposureMinor, exposureAtFaceMinor, goldenRule, statement } = register;

  return html`
    <div class="card" style="margin-bottom:14px">
      <h2>Change, early warning and recovery</h2>
      <div class="metric-sub" style="margin:6px 0 12px">${statement}</div>

      <div class="notice warn" style="margin-bottom:14px">
        <div><b>The golden rule.</b> ${goldenRule}</div>
      </div>

      ${changes.length > 0
        ? html`<section class="grid g3" style="margin-bottom:14px">
              <div class="card">
                <h2>Agreed</h2>
                <div class="metric">${money(agreedMinor)}</div>
                <div class="metric-sub">Certain, and in the forecast at face value</div>
              </div>
              <div class="card">
                <h2>Exposure</h2>
                <div class="metric">${money(exposureMinor)}</div>
                <div class="metric-sub">Pending change, risk-adjusted</div>
              </div>
              <div class="card">
                <h2>At face</h2>
                <div class="metric">${money(exposureAtFaceMinor)}</div>
                <div class="metric-sub">The same change if every entitlement holds</div>
              </div>
            </section>

            ${changes.map(
              (entry) => html`<div style="padding:12px 0;border-top:1px solid var(--line)">
                <div style="display:flex;justify-content:space-between;gap:16px;align-items:baseline">
                  <b>${entry.reference} — ${entry.summary}</b>
                  <span>
                    ${badge(entry.triggerLabel.toLowerCase(), 'info')}
                    ${badge(entry.status.replaceAll('_', ' ').toLowerCase(), CHANGE_TONE[entry.status] ?? 'info')}
                    ${badge(entry.entitlementLabel.toLowerCase(), ENTITLEMENT_TONE[entry.entitlement] ?? 'info')}
                  </span>
                </div>
                <div class="metric-sub" style="margin-top:4px">${entry.difference}</div>
                <div class="metric-sub" style="margin-top:6px">
                  <b>${money(entry.valueMinor)}</b> at ${entry.probabilityPercent}% —
                  <b>${money(entry.exposureMinor)}</b> on the forecast today.
                </div>
                ${entry.noticeLapsed
                  ? html`<div class="notice bad" style="margin-top:8px">
                      <div>
                        <b>Notice period passed on ${entry.noticeDueBy} with nothing sent.</b> ${entry.analysis} The
                        entitlement is what is at risk, not the value.
                      </div>
                    </div>`
                  : entry.noticeOutstanding
                    ? html`<div class="metric-sub warn" style="margin-top:4px">
                        Contract notice outstanding${entry.noticeDueBy ? `, due by ${entry.noticeDueBy}` : ''}.
                      </div>`
                    : entry.noticeReference
                      ? html`<div class="metric-sub ok" style="margin-top:4px">
                          Notice given ${date(entry.noticeGivenAt)} — ${entry.noticeReference}
                        </div>`
                      : ''}
                <div class="metric-sub" style="margin-top:6px"><b>Controlled result.</b> ${entry.result}</div>
              </div>`,
            )}`
        : ''}

      <div style="padding:14px 0 0;border-top:1px solid var(--line)">
        <h2>The six triggers</h2>
        ${table({
          headers: ['Trigger', 'What is analysed', 'Controlled result', ''],
          rows: triggers.map((trigger) => [
            html`<b>${trigger.label}</b>`,
            trigger.analysis,
            trigger.result,
            trigger.noticeBearing ? badge('notice', 'warn') : '',
          ]),
        })}
      </div>
    </div>
  `;
}

/**
 * Demobilisation, which begins at design.
 *
 * The panel leads with what has *no* removal plan, because that is the number
 * that is cheap to fix today and expensive to fix at the end. Every run-down is
 * shown against the statutory minimum for the people still there, whether it
 * passed or not — a successor facility is the reason a run-down below the
 * minimum is acceptable, not a reason it stops being below it.
 */
function demobCard(closeout) {
  const { workstreams, plans, runDowns, removalCostMinor, unplanned, statement } = closeout;

  return html`
    <div class="card" style="margin-bottom:14px">
      <h2>Demobilisation and reinstatement</h2>
      <div class="metric-sub" style="margin:6px 0 12px">${statement}</div>

      ${unplanned > 0
        ? html`<div class="notice warn" style="margin-bottom:14px">
            <div>
              <b>${unplanned} system${unplanned === 1 ? '' : 's'} with no removal plan.</b>
              ${plans
                .filter((entry) => !entry.plan)
                .map((entry) => `${entry.label} (${entry.zone})`)
                .join(' · ')}. The moment to agree who breaks out a hardstanding is the moment before it is poured.
            </div>
          </div>`
        : ''}

      ${runDowns.length > 0
        ? html`<div style="margin-bottom:14px">
            <h2>Demand run-down</h2>
            ${table({
              headers: ['System', 'From', 'People left', 'WCs left', 'Statutory minimum', 'Position'],
              align: ['', '', 'num', 'num', 'num', ''],
              rows: runDowns.map((entry) => [
                entry.label,
                entry.effectiveFrom,
                entry.remainingPersons,
                entry.remainingWcs,
                entry.requiredWcs,
                entry.belowStatutory
                  ? html`${badge('below the minimum', 'bad')}
                      <div class="metric-sub">
                        ${entry.successor ? `Carried by: ${entry.successor}` : 'No successor named.'}
                      </div>`
                  : badge('above the minimum', 'ok'),
              ]),
            })}
          </div>`
        : ''}

      ${plans.some((entry) => entry.plan)
        ? html`<div style="margin-bottom:14px">
            <h2>Removal plans — ${money(removalCostMinor)} agreed</h2>
            ${plans
              .filter((entry) => entry.plan)
              .map(
                (entry) => html`<div style="padding:10px 0;border-top:1px solid var(--line)">
                  <b>${entry.label} — ${entry.zone}</b>
                  <div class="metric-sub" style="margin-top:4px">
                    <b>${entry.plan.owner}</b> · ${entry.plan.method} · triggered by ${entry.plan.trigger} ·
                    ${money(entry.plan.costMinor)}
                  </div>
                  <div class="metric-sub" style="margin-top:4px">
                    Waste: ${entry.plan.wasteRoute} · Returned as: ${entry.plan.reinstatementCriterion}
                  </div>
                  <div class="metric-sub" style="margin-top:4px"><b>Obligation.</b> ${entry.obligation}</div>
                </div>`,
              )}
          </div>`
        : ''}

      <div style="padding:14px 0 0;border-top:1px solid var(--line)">
        <h2>The seven workstreams</h2>
        ${table({
          headers: ['Workstream', 'Controls', 'Closes on', 'Position'],
          rows: workstreams.map((workstream) => [
            html`<b>${workstream.label}</b>`,
            workstream.controls,
            workstream.acceptance,
            workstream.records.length === 0
              ? html`<span class="metric-sub">not opened</span>`
              : html`${workstream.accepted > 0 ? badge(`${workstream.accepted} accepted`, 'ok') : ''}
                  ${workstream.open > 0 ? badge(`${workstream.open} open`, 'warn') : ''}
                  ${workstream.records.map(
                    (record) => html`<div class="metric-sub">
                      ${record.systemLabel ? `${record.systemLabel}: ` : ''}${record.evidence.length} piece${
                        record.evidence.length === 1 ? '' : 's'
                      } of evidence
                    </div>`,
                  )}`,
          ]),
        })}
      </div>
    </div>
  `;
}

const SEVERITY_TONE = { P1: 'bad', P2: 'warn', P3: 'info', P4: '' };
const EVENT_TONE = { OPEN: 'bad', ACKNOWLEDGED: 'warn', ATTENDED: 'warn', TEMPORARILY_RESTORED: 'info', CLOSED: 'ok' };

/**
 * Live operations, and the one number that is not on it.
 *
 * There is no "tickets closed this week". Every helpdesk dashboard leads with
 * one and it is the least informative figure in the building: it counts how
 * quickly people pressed buttons. What is here instead is what is *blocking*
 * each closure — the evidence the defect type demands and does not have — so
 * the screen answers "why is this still open" rather than "how many are".
 *
 * Availability is shown twice on purpose. Once net of the exclusions the
 * customer approved before the outage, and once raw. The gap between the two is
 * the size of the argument about what was actually planned, and a screen
 * showing only the first is a screen the supplier writes.
 */
function operationsCard(live) {
  const { events, open, severities, kpis, availability, patterns, measuredUnder, steps } = live;

  return html`
    <div class="card" style="margin-bottom:14px">
      <h2>Live operations</h2>
      <div class="metric-sub" style="margin:6px 0 12px">
        ${open} event${open === 1 ? '' : 's'} open of ${events.length}. The loop is
        ${steps.map((step) => step.label.toLowerCase()).join(' · ')} — and the fourth is the one that decides whether
        any of the rest meant anything, so nothing closes on a tick.
      </div>

      ${patterns.length > 0
        ? html`<div style="margin-bottom:14px">
            ${patterns.map(
              (pattern) => html`<div class="notice warn" style="margin-bottom:8px">
                <div><b>${pattern.label} — ${pattern.zone}.</b> ${pattern.statement}</div>
              </div>`,
            )}
          </div>`
        : ''}

      ${availability.length > 0
        ? html`<div style="margin-bottom:14px">
            <h2>Availability</h2>
            <div class="metric-sub" style="margin:6px 0 10px">
              Net of exclusions the customer approved <b>before</b> the outage, and raw beside it. Degraded minutes are
              counted separately and never as available.
            </div>
            ${table({
              headers: ['System', 'Net', 'Raw', 'Required', 'Excluded', 'Degraded', 'Periods'],
              align: ['', 'num', 'num', 'num', 'num', 'num', 'num'],
              rows: availability.map((entry) => [
                html`${entry.label}<div class="metric-sub">${entry.zone}</div>`,
                entry.periods > 0 ? pct(entry.availabilityPercent) : html`<span class="metric-sub">no periods</span>`,
                entry.periods > 0 ? pct(entry.rawPercent) : '—',
                entry.requiredMinutes,
                entry.excludedMinutes,
                entry.degradedMinutes > 0 ? badge(String(entry.degradedMinutes), 'warn') : '0',
                entry.periods,
              ]),
            })}
          </div>`
        : ''}

      ${events.length > 0
        ? events.map(
            (event) => html`<div style="padding:12px 0;border-top:1px solid var(--line)">
              <div style="display:flex;justify-content:space-between;gap:16px;align-items:baseline">
                <b>${event.reference} — ${event.defectLabel}</b>
                <span>
                  ${badge(event.severityLabel, SEVERITY_TONE[event.severity] ?? 'info')}
                  ${badge(event.status.replaceAll('_', ' ').toLowerCase(), EVENT_TONE[event.status] ?? 'info')}
                  ${event.acknowledgementBreached ? badge('acknowledgement late', 'bad') : ''}
                </span>
              </div>
              <div class="metric-sub" style="margin-top:4px">
                ${event.zone} · ${event.summary} · from ${event.source} · open ${event.minutesOpen} minutes${
                  event.pausedMinutes > 0 ? `, ${event.pausedMinutes} of them paused` : ''
                }
              </div>
              ${event.temporaryControl
                ? html`<div class="metric-sub ok" style="margin-top:4px">
                    <b>Temporary control.</b> ${event.temporaryControl}
                  </div>`
                : ''}
              ${event.routedToChange
                ? html`<div class="metric-sub" style="margin-top:4px"><b>Routed to change.</b> ${event.routedToChange}</div>`
                : ''}
              ${event.pauses.map(
                (pause) => html`<div class="metric-sub warn" style="margin-top:4px">
                  Clock paused ${date(pause.from)}${pause.to ? ` to ${date(pause.to)}` : ' — still stopped'} —
                  ${pause.reason}, approved by ${pause.approvedBy}
                </div>`,
              )}
              <div class="metric-sub" style="margin-top:6px">
                ${event.closure.map(
                  (entry) => html`${badge(
                    entry.kind.replaceAll('_', ' ').toLowerCase(),
                    entry.satisfied ? 'ok' : 'bad',
                  )}
                  ${entry.reference ? html`<span class="metric-sub">${entry.reference}</span> ` : ''}`,
                )}
              </div>
              ${event.blocking.length > 0
                ? html`<div class="metric-sub bad" style="margin-top:4px">
                    <b>Cannot close:</b> ${event.blocking.join(' · ')}
                  </div>`
                : ''}
              ${event.behaviour.length > 0 && event.status !== 'CLOSED'
                ? html`<div class="metric-sub" style="margin-top:4px">
                    <b>What a ${event.severity} gets.</b> ${event.behaviour.join(' · ')}
                  </div>`
                : ''}
            </div>`,
          )
        : html`<div class="notice" style="margin-bottom:14px">
            <div>
              Nothing has been raised against any service. That is either a very good week or a helpdesk nobody is
              feeding — and the difference matters, because an availability figure with no events behind it is a figure
              nobody has tested.
            </div>
          </div>`}

      <div style="padding:14px 0 0;border-top:1px solid var(--line)">
        <h2>The KPI contract</h2>
        <div class="metric-sub" style="margin:6px 0 10px">
          Every measure carries the control that stops it being gamed, and whether the platform enforces that control or
          only reports it. A screen implying enforcement the code does not do is worse than no screen.
        </div>
        ${table({
          headers: ['Family', 'Measured by', 'Anti-gaming control', ''],
          rows: kpis.map((family) => [
            html`<b>${family.label}</b>`,
            family.method,
            family.antiGaming,
            family.enforcement === 'ENFORCED' ? badge('enforced', 'ok') : badge('reported', 'warn'),
          ]),
        })}
        ${measuredUnder.length > 0
          ? html`<div class="metric-sub" style="margin-top:10px">
              ${measuredUnder
                .map((entry) => `${entry.label}: ${entry.kpis.map((kpi) => kpi.label.toLowerCase()).join(', ') || 'none'}`)
                .join(' · ')}
            </div>`
          : ''}
      </div>

      <div style="padding:14px 0 0;border-top:1px solid var(--line)">
        <h2>What each severity gets</h2>
        ${table({
          headers: ['Severity', 'When', 'What happens'],
          rows: severities.map((entry) => [
            html`${badge(`${entry.id} ${entry.label}`, SEVERITY_TONE[entry.id] ?? 'info')}
              <div class="metric-sub">
                ${entry.acknowledgeWithinMinutes === 0
                  ? 'Acknowledged immediately'
                  : `Acknowledged within ${entry.acknowledgeWithinMinutes} minutes`}${
                  entry.clockUnpausable ? ' · clock never pauses' : ''
                }
              </div>`,
            entry.definition,
            entry.behaviour.join(' · '),
          ]),
        })}
      </div>
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

/**
 * §6 — the nine stages, and where the project actually is.
 *
 * Every gate on this card is derived from the records rather than set, so the
 * card has no controls on it at all: there is nothing to click, because there is
 * no way to move a stage other than by making the underlying records true. That
 * is the point of the panel and it is worth the reader noticing.
 *
 * A condition that cannot be answered is shown as neither passed nor
 * outstanding. Outstanding says somebody has work to do; not derivable says the
 * platform cannot answer the question, which is a different conversation.
 */
function workflowCard(position) {
  const { stages, at, changeRunning, statement } = position;
  const tone = { SATISFIED: 'ok', OUTSTANDING: 'warn', NOT_DERIVABLE: 'info' };

  return html`
    <div class="card" style="margin-bottom:14px">
      <h2>The nine stages</h2>
      <div class="metric-sub" style="margin:6px 0 12px">${statement}</div>
      <div class="notice info" style="margin-bottom:14px">
        <div>
          <b>Every gate below is derived, never set.</b> There is no control on this card because there is no way to
          move a stage other than by making the records behind it true.
        </div>
      </div>

      ${stages.map(
        (stage) => html`<div style="padding:12px 0;border-top:1px solid var(--line)">
          <div style="display:flex;justify-content:space-between;gap:16px;align-items:baseline">
            <b>${stage.order} ${stage.label}</b>
            <span>
              ${stage.concurrent ? badge('concurrent', 'info') : ''}
              ${
                // One state badge, not two. "here entered" read as a pair of
                // words rather than as a status, and "here" already says the
                // stage has been entered.
                stage.complete
                  ? badge('complete', 'ok')
                  : stage.id === at
                    ? badge('here', 'ai')
                    : stage.entered
                      ? badge('entered', 'warn')
                      : badge('not entered', '')
              }
            </span>
          </div>
          <div class="metric-sub" style="margin-top:4px">${stage.work}</div>
          <div class="metric-sub" style="margin-top:4px"><b>Authoritative record.</b> ${stage.authoritativeRecord}</div>
          ${table({
            headers: ['Gate', 'What it prevents', 'Read'],
            rows: [...stage.entry, ...stage.exit].map((gate) => [
              html`<b>${gate.label}</b>
                ${badge(gate.outcome.replaceAll('_', ' ').toLowerCase(), tone[gate.outcome] ?? 'info')}`,
              html`<span class="metric-sub">${gate.matters}</span>`,
              gate.detail,
            ]),
          })}
        </div>`,
      )}

      ${changeRunning
        ? html`<div class="metric-sub" style="padding-top:12px;border-top:1px solid var(--line)">
            Change and recovery is running alongside whatever stage the project is at. It is entered by something
            happening, not by somebody deciding to enter it.
          </div>`
        : ''}
    </div>
  `;
}

/**
 * §13's eight command centres, and §13.1's universal panel.
 *
 * The panel is the point of this card, and it is deliberately not a wall of
 * tiles. Every entry carries the rule that produced it, the record it was read
 * from, the decision somebody has to take, who takes it, by when, and what
 * happens if nobody does. A tile that says "3 amber" is a screen you have to
 * trust; this is a screen you can check, and §13.1 asks for the second one in
 * as many words.
 *
 * What each workspace *cannot* answer is shown at the bottom of it rather than
 * left out. A command centre that silently omits the questions it has no
 * records for is a command centre that reads as complete, and the first person
 * to rely on it finds the gap at the worst possible moment.
 */
function commandCentreCard(centre, factory) {
  if (centre.error && centre.error.code !== 'SUPPLIER_REQUIRED') {
    return html`<div class="card" style="margin-bottom:14px">
      ${workspaceChooser(centre.workspaces)} ${refusal('This command centre', centre.error)}
    </div>`;
  }

  // The chooser has to render even when the fetch refused, or somebody who
  // lands on a workspace they cannot see has no way back to one they can.
  const workspaces = centre.workspaces ?? FALLBACK_WORKSPACES;

  if (centre.error) {
    const suppliers = supplierOptions(factory);
    return html`<div class="card" style="margin-bottom:14px">
      <h2>Command centres</h2>
      ${workspaceChooser(workspaces)}
      <div class="notice info" style="margin-top:12px">
        <div>
          <b>The supplier portal is one supplier’s obligations.</b> Choose which — an unscoped portal would show every
          supplier their competitors’ position.
        </div>
      </div>
      ${suppliers.length === 0
        ? html`<div class="metric-sub" style="margin-top:10px">
            No supplier is engaged on any package yet, so there is nobody to open a portal for.
          </div>`
        : html`<div class="field" style="margin-top:10px">
            <label for="portal-supplier">Supplier</label>
            <select id="portal-supplier" data-portal-supplier>
              <option value="">Choose a supplier…</option>
              ${suppliers.map(
                (entry) => html`<option value="${entry.id}" ${entry.id === portalSupplier ? 'selected' : ''}>
                  ${entry.name}
                </option>`,
              )}
            </select>
          </div>`}
    </div>`;
  }

  const { workspace, now, next, unanswered, statement } = centre;

  return html`
    <div class="card" style="margin-bottom:14px">
      <h2>${workspace.label}</h2>
      <div class="metric-sub" style="margin:6px 0 12px">${workspace.mustAnswer}</div>
      ${workspaceChooser(workspaces)}

      <div class="metric-sub" style="margin:12px 0">${statement}</div>

      <div style="padding:12px 0 0;border-top:1px solid var(--line)">
        <h2>Now</h2>
        <div class="metric-sub" style="margin:4px 0 10px">
          Service health, active critical events, capacity against demand, and today’s mobilisation and delivery
          constraints.
        </div>
        ${now.length === 0
          ? html`<div class="notice ok"><div>Nothing outstanding on this workspace today.</div></div>`
          : now.map((entry) => panelEntry(entry))}
      </div>

      <div style="padding:14px 0 0;border-top:1px solid var(--line);margin-top:14px">
        <h2>Next</h2>
        <div class="metric-sub" style="margin:4px 0 10px">
          Falling due within 2, 7 or 30 days, and needing evidence, space, utilities, supplier action, approval or
          funding.
        </div>
        ${next.length === 0
          ? html`<div class="notice ok"><div>Nothing falls due on this workspace inside the month.</div></div>`
          : next.map((entry) => panelEntry(entry))}
      </div>

      ${unanswered.length > 0
        ? html`<div style="padding:14px 0 0;border-top:1px solid var(--line);margin-top:14px">
            <h2>What this workspace cannot answer</h2>
            <div class="metric-sub" style="margin:4px 0 10px">
              Stated rather than left out. Each is a record that does not exist, not a screen that has not been drawn.
            </div>
            ${table({
              headers: ['Question', 'Why not'],
              rows: unanswered.map((question) => [html`<b>${question.question}</b>`, question.basis]),
            })}
          </div>`
        : ''}
    </div>
  `;
}

/**
 * The eight workspaces, as a row of doors.
 *
 * §13's own sentence sits under each as the title attribute rather than on the
 * screen: eight paragraphs of "must answer immediately" is not a navigation
 * control, and the chosen one shows its sentence in full above the panel.
 */
function workspaceChooser(workspaces) {
  return html`<div style="display:flex;flex-wrap:wrap;gap:6px">
    ${workspaces.map(
      (entry) => html`<button
        type="button"
        class="btn ${entry.id === chosenWorkspace ? '' : 'ghost'}"
        data-workspace="${entry.id}"
        title="${entry.mustAnswer}"
      >
        ${entry.label}
      </button>`,
    )}
  </div>`;
}

/**
 * The eight, for a chooser that has to render when the fetch refused.
 *
 * Labels only. The authoritative list, the questions and the sensitivity of
 * each all live server-side in `commandcentre.ts`; this is a way back to a
 * workspace the reader can see, not a second copy of §13.
 */
const FALLBACK_WORKSPACES = [
  { id: 'EXECUTIVE_PORTFOLIO', label: 'Executive Portfolio', mustAnswer: '' },
  { id: 'CUSTOMER_PROJECT', label: 'Customer Project', mustAnswer: '' },
  { id: 'CONTROL_TOWER', label: 'ETABLIX Control Tower', mustAnswer: '' },
  { id: 'COMMERCIAL', label: 'Commercial', mustAnswer: '' },
  { id: 'PROCUREMENT', label: 'Procurement', mustAnswer: '' },
  { id: 'SUPPLIER_PORTAL', label: 'Supplier Portal', mustAnswer: '' },
  { id: 'FIELD_MOBILE', label: 'Field Mobile', mustAnswer: '' },
  { id: 'ACCOMMODATION_DESK', label: 'Accommodation Desk', mustAnswer: '' },
];

/** Suppliers the page already holds, so the chooser cannot offer one that is not engaged. */
function supplierOptions(factory) {
  if (!factory || factory.error) return [];
  const seen = new Map();
  for (const pack of factory.packages ?? []) {
    for (const engagement of pack.engagements ?? []) seen.set(engagement.supplierId, engagement.supplierName);
  }
  return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One panel entry, with §13.1's four parts on it.
 *
 * WHY and ACTION are rendered every time, without a disclosure control. A rule
 * behind a chevron is a rule most people never read, and the entire argument
 * for this panel is that the reader can check the status rather than trust it.
 */
function panelEntry(entry) {
  const owner = entry.action.owner;
  const named = owner.named ?? [];
  return html`<div style="padding:12px 0;border-top:1px solid var(--line)">
    <div style="display:flex;justify-content:space-between;gap:16px;align-items:baseline">
      <b>${entry.headline}</b>
      <span>
        ${entry.overdue ? badge('overdue', 'bad') : entry.withinDays ? badge(`${entry.withinDays}d`, 'warn') : ''}
        ${badge((entry.subject ?? entry.need).replaceAll('_', ' ').toLowerCase(), PANEL_TONE[entry.tone] ?? 'info')}
      </span>
    </div>

    <div class="metric-sub" style="margin-top:6px"><b>Why.</b> ${entry.why.rule}</div>
    <div class="metric-sub" style="margin-top:4px">
      ${entry.why.evidence}
      ${entry.why.source
        ? html`<span class="metric-sub"> · ${entry.why.source.refType} ${entry.why.source.refId}</span>`
        : ''}
    </div>

    <div class="metric-sub" style="margin-top:8px"><b>Action.</b> ${entry.action.decision}</div>
    <div class="metric-sub" style="margin-top:4px">
      <b>Owner:</b>
      ${named.length > 0
        ? named.map((person) => `${person.name} (${person.role.replaceAll('_', ' ').toLowerCase()})`).join(' · ')
        : `nobody on this project holds ${owner.roles.join(' or ').replaceAll('_', ' ').toLowerCase()}`}
      — ${owner.basis}
    </div>
    <div class="metric-sub" style="margin-top:4px">
      <b>By:</b> ${entry.action.dueAt ? date(entry.action.dueAt) : 'no date'} — ${entry.action.deadlineBasis}
    </div>
    <div class="metric-sub ${entry.tone === 'CRITICAL' ? 'bad' : ''}" style="margin-top:4px">
      <b>If nobody does:</b> ${entry.action.consequence}
    </div>
    <div class="metric-sub" style="margin-top:4px"><b>Already prepared:</b> ${entry.action.prepared}</div>
  </div>`;
}

/**
 * §17 — "90% AI-driven", measured by workflow touch rather than claimed.
 *
 * The card leads with the denominator, because that is where this measure is
 * usually made dishonest. Class C is human-controlled by design and is excluded
 * from the ratio, and saying so on the screen is what stops the figure being
 * read as "the platform decides 90% of things" — which is the opposite of what
 * the governance model does.
 *
 * A metric with no records behind it shows what is missing rather than zero.
 * Zero and "nothing has happened yet" look identical on a gauge and mean
 * opposite things.
 */
function automationCard(measure) {
  const { classes, metrics, byWorkflow, target, totals, statement } = measure;
  const headline = metrics.find((metric) => metric.id === 'AGENT_DRIVEN_RATIO');

  return html`
    <div class="card" style="margin-bottom:14px">
      <h2>Automation measure</h2>
      <div class="metric-sub" style="margin:6px 0 12px">${statement}</div>

      <section class="grid g3" style="margin-bottom:14px">
        <div class="card">
          <h2>Agent-driven</h2>
          <div class="metric ${headline?.value === undefined ? '' : headline.value >= target ? 'ok' : 'warn'}">
            ${headline?.value === undefined ? '—' : pct(headline.value / 100)}
          </div>
          <div class="metric-sub">Against a ${target}% target</div>
        </div>
        <div class="card">
          <h2>Eligible activities</h2>
          <div class="metric">${totals.eligible}</div>
          <div class="metric-sub">Class A and B, of ${totals.recorded} recorded</div>
        </div>
        <div class="card">
          <h2>Human-controlled</h2>
          <div class="metric">${totals.humanControlled}</div>
          <div class="metric-sub">Class C — excluded from the ratio by design</div>
        </div>
      </section>

      <div style="padding:12px 0 0;border-top:1px solid var(--line)">
        <h2>The automation boundary</h2>
        ${table({
          headers: ['Class', 'AI authority', 'Examples'],
          rows: classes.map((entry) => [
            html`<b>${entry.id} — ${entry.label}</b>`,
            entry.authority,
            html`<span class="metric-sub">${entry.examples}</span>`,
          ]),
        })}
      </div>

      <div style="padding:14px 0 0;border-top:1px solid var(--line);margin-top:14px">
        <h2>By workflow</h2>
        <div class="metric-sub" style="margin:4px 0 10px">
          Never one blended figure. A platform automated at recording facts and manual at valuation reports well
          overall, and the manual half is where the money is.
        </div>
        ${table({
          headers: ['Workflow', 'Eligible', 'Autonomous', 'Agent-prepared', 'Human', 'Ratio', 'Straight through'],
          rows: byWorkflow.map((row) => [
            html`<b>${row.label}</b> <span class="metric-sub">${row.section}</span>`,
            row.eligible,
            row.autonomous,
            row.agentPrepared,
            row.human,
            row.ratioPercent === undefined
              ? html`<span class="metric-sub">nothing yet</span>`
              : html`<span class="${row.ratioPercent >= target ? 'ok' : 'warn'}">${row.ratioPercent}%</span>`,
            row.straightThroughPercent === undefined
              ? html`<span class="metric-sub">—</span>`
              : `${row.straightThroughPercent}%`,
          ]),
        })}
      </div>

      <div style="padding:14px 0 0;border-top:1px solid var(--line);margin-top:14px">
        <h2>The ten metrics</h2>
        ${metrics.map(
          (metric) => html`<div style="padding:10px 0;border-top:1px solid var(--line)">
            <div style="display:flex;justify-content:space-between;gap:16px;align-items:baseline">
              <b>${metric.label}</b>
              <span>
                ${metric.value === undefined
                  ? badge('not measurable yet', 'info')
                  : badge(`${metric.value}${metric.unit === 'days' ? ' days' : '%'}`, 'ok')}
              </span>
            </div>
            <div class="metric-sub" style="margin-top:4px">${metric.definition}</div>
            <div class="metric-sub" style="margin-top:4px"><b>Target:</b> ${metric.target}</div>
            <div class="metric-sub" style="margin-top:4px"><b>Basis:</b> ${metric.basis}</div>
          </div>`,
        )}
      </div>
    </div>
  `;
}

/** A contribution reads as a direction, not a magnitude, so the sign is kept. */
function signed(value) {
  if (value === 0) return raw('<span class="metric-sub">0</span>');
  return html`<span class="${value > 0 ? 'ok' : 'bad'}">${value > 0 ? `+${value}` : value}</span>`;
}


function forecastSection(forecast) {
  if (forecast.error) return refusal('Forecast accuracy', forecast.error);
  const signed = (minor) => (minor > 0 ? `+${money(minor)}` : minor < 0 ? `−${money(-minor)}` : money(0));
  const percent = (value) => (value === undefined ? '—' : `${value > 0 ? '+' : ''}${value}%`);
  return html`
    <div style="margin-top:14px">
      <h2>Forecast accuracy</h2>
      <div class="metric-sub" style="margin:6px 0 12px">${forecast.basis}</div>
      ${forecast.measurable
        ? html`<section class="grid g4" style="margin-bottom:12px">
            <div class="card"><h2>Outturn</h2><div class="metric">${money(forecast.outturnMinor)}</div><div class="metric-sub">certified at close</div></div>
            <div class="card ${raw(forecast.meanAbsoluteErrorPercent > 10 ? 'warn' : '')}"><h2>Mean absolute error</h2><div class="metric">${forecast.meanAbsoluteErrorPercent}%</div><div class="metric-sub">across ${forecast.snapshots.length} snapshot${forecast.snapshots.length === 1 ? '' : 's'}, change agreed after each taken out</div></div>
            <div class="card"><h2>Accuracy</h2><div class="metric">${Math.round((100 - forecast.meanAbsoluteErrorPercent) * 10) / 10}%</div><div class="metric-sub">§17: 100 less the mean absolute error</div></div>
            <div class="card"><h2>Snapshots</h2><div class="metric">${forecast.snapshots.length}</div><div class="metric-sub">the earliest of ${forecast.snapshots[0].asOf}</div></div>
          </section>`
        : ''}
      ${table({
        headers: forecast.measurable
          ? ['As of', 'EAC then', 'Variance', 'Customer change after', 'Other change after', 'Forecaster’s error', 'Note']
          : ['As of', 'EAC then', 'Committed', 'Earned', 'Agreed change', 'Exposure', 'Note'],
        align: forecast.measurable ? ['', 'num', 'num', 'num', 'num', 'num', ''] : ['', 'num', 'num', 'num', 'num', 'num', ''],
        rows: forecast.snapshots.map((entry) =>
          forecast.measurable
            ? [
                entry.asOf,
                money(entry.eacMinor),
                `${signed(entry.varianceMinor)} (${percent(entry.variancePercent)})`,
                money(entry.customerChangeMinor),
                money(entry.otherChangeMinor),
                html`<span class="${raw(Math.abs(entry.forecastErrorPercent) > 10 ? 'bad' : '')}">${signed(entry.forecastErrorMinor)} (${percent(entry.forecastErrorPercent)})</span>`,
                html`<span class="metric-sub">${entry.note ?? '—'}</span>`,
              ]
            : [
                entry.asOf,
                money(entry.eacMinor),
                money(entry.commitmentMinor),
                money(entry.earnedMinor),
                money(entry.agreedChangeMinor),
                money(entry.exposureMinor),
                html`<span class="metric-sub">${entry.note ?? '—'}</span>`,
              ],
        ),
        empty: 'No forecast has been frozen. Freeze one from the command bar; the final account is measured against it once the closeout is accepted.',
      })}
    </div>
  `;
}

function cashCard(cash, eac, forecast, portfolio) {
  const t = cash.totals;
  return html`
    <div class="card" style="margin-bottom:14px">
      <h2>Cash and the estimate at completion</h2>
      <div class="metric-sub" style="margin:6px 0 12px">${cash.statement}</div>
      <section class="grid g4" style="margin-bottom:14px">
        <div class="card"><h2>Earned</h2><div class="metric">${money(t.earnedMinor)}</div><div class="metric-sub">accepted work, whether or not a certificate carries it</div></div>
        <div class="card"><h2>Certified</h2><div class="metric">${money(t.certifiedMinor)}</div><div class="metric-sub">${money(t.accruedMinor)} earned above this is accrual</div></div>
        <div class="card"><h2>Paid</h2><div class="metric">${money(t.paidMinor)}</div><div class="metric-sub">what has actually arrived</div></div>
        <div class="card ${raw(t.outstandingMinor > 0 ? 'warn' : '')}"><h2>Outstanding</h2><div class="metric">${money(t.outstandingMinor)}</div><div class="metric-sub">${money(t.outstandingByPayer.ETABLIX)} ETABLIX’s own liability · ${money(t.outstandingByPayer.CUSTOMER)} the customer’s</div></div>
      </section>
      ${table({
        headers: ['Valuation', 'Status', 'Payer', 'Certified', 'Paid', 'Outstanding'],
        align: ['', '', '', 'num', 'num', 'num'],
        rows: cash.valuations.map((entry) => [
          entry.reference,
          badge(entry.status.toLowerCase(), entry.status === 'CERTIFIED' ? 'ok' : 'info'),
          entry.payer ?? '—',
          money(entry.certifiedMinor),
          money(entry.paidMinor),
          money(entry.outstandingMinor),
        ]),
        empty: 'No valuation yet.',
      })}
      ${eac.error
        ? refusal('The estimate at completion', eac.error)
        : html`<div style="margin-top:14px">
            <h2>Estimate at completion</h2>
            <div class="metric-sub" style="margin:6px 0 12px">${eac.statement}</div>
            <section class="grid g4" style="margin-bottom:12px">
              <div class="card"><h2>EAC</h2><div class="metric">${money(eac.eacMinor)}</div><div class="metric-sub">every term below</div></div>
              <div class="card"><h2>Budget</h2><div class="metric">${money(eac.budgetMinor)}</div><div class="metric-sub">approved across every line</div></div>
              <div class="card"><h2>Contingency</h2><div class="metric">${money(eac.contingencyRemainingMinor)}</div><div class="metric-sub">${money(eac.contingencyDrawnMinor)} drawn of ${money(eac.contingencyPotMinor)}${eac.contingency ? ` · ${eac.contingency.basis}` : ' · no pot set'}</div></div>
              <div class="card ${raw(eac.headroomMinor < 0 ? 'bad' : '')}"><h2>${eac.headroomMinor < 0 ? 'Over' : 'Headroom'}</h2><div class="metric">${money(Math.abs(eac.headroomMinor))}</div><div class="metric-sub">budget plus pot, less the EAC</div></div>
            </section>
            ${table({
              headers: ['Term', 'Amount', 'Basis'],
              align: ['', 'num', ''],
              rows: eac.terms.map((term) => [term.term, money(term.amountMinor), html`<span class="metric-sub">${term.basis}</span>`]),
              empty: 'Nothing to forecast from.',
            })}
          </div>`}
      ${forecastSection(forecast)}
      ${portfolio.error
        ? refusal('The portfolio', portfolio.error)
        : html`<div style="margin-top:14px">
            <h2>Every project at once</h2>
            <div class="metric-sub" style="margin:6px 0 12px">${portfolio.statement}</div>
            ${table({
              headers: ['Project', 'Budget', 'Committed', 'Certified', 'Paid', 'Outstanding', 'EAC', 'Headroom', 'Open changes'],
              align: ['', 'num', 'num', 'num', 'num', 'num', 'num', 'num', 'num'],
              rows: portfolio.projects.map((entry) => [
                entry.name,
                money(entry.budgetMinor),
                money(entry.commitmentMinor),
                money(entry.certifiedMinor),
                money(entry.paidMinor),
                money(entry.outstandingMinor),
                money(entry.eacMinor),
                html`<span class="${raw(entry.headroomMinor < 0 ? 'bad' : '')}">${money(entry.headroomMinor)}</span>`,
                String(entry.openChanges),
              ]),
              empty: 'No project of this company carries a readable site-services position.',
            })}
            ${portfolio.skipped.length > 0
              ? html`<div class="metric-sub" style="margin-top:8px">Skipped, with the reason: ${portfolio.skipped.map((entry) => `${entry.name} (${entry.because})`).join(' · ')}</div>`
              : ''}
          </div>`}
    </div>
  `;
}

function deskCard(desk) {
  const a = desk.accommodation;
  const t = desk.transport;
  return html`
    <div class="card" style="margin-bottom:14px">
      <h2>The desk</h2>
      <div class="metric-sub" style="margin:6px 0 12px">${desk.statement}</div>
      <section class="grid g4" style="margin-bottom:14px">
        <div class="card"><h2>Units</h2><div class="metric">${desk.assets.registered}</div><div class="metric-sub">${desk.assets.onSite} on site · ${desk.assets.defective} defective · ${desk.assets.neverScanned} never scanned</div></div>
        <div class="card ${raw(desk.deliveries.overdue > 0 ? 'warn' : '')}"><h2>Deliveries expected</h2><div class="metric">${desk.deliveries.expected}</div><div class="metric-sub">${desk.deliveries.overdue} overdue · ${desk.deliveries.short} short · ${desk.deliveries.refused} refused</div></div>
        <div class="card ${raw(a.demandBeds !== undefined && a.beds < a.demandBeds ? 'warn' : '')}"><h2>In beds tonight</h2><div class="metric">${a.occupiedTonight} / ${a.beds}</div><div class="metric-sub">${a.available} free · ${a.arrivalsDue} due · ${a.cleaning} cleaning · ${a.outOfService} out of service${a.demandBeds !== undefined ? ` · brief accommodates ${a.demandBeds}` : ''}</div></div>
        <div class="card"><h2>Journeys today</h2><div class="metric">${t.today}</div><div class="metric-sub">${t.seatsBooked} of ${t.seatsOffered} seats booked${t.seatsOffered > 0 ? ` (${t.loadFactorPercent}%)` : ''}</div></div>
      </section>
      <div class="grid g-2-1">
        <div>
          <h2>Rooms</h2>
          <div class="metric-sub" style="margin:6px 0 10px">${a.statement}</div>
          ${table({
            headers: ['Room', 'Beds', 'State', 'Tonight'],
            align: ['', 'num', '', ''],
            rows: a.rooms.map((room) => [
              `${room.block} ${room.number}`,
              `${room.beds - room.free} / ${room.beds}`,
              badge(room.status.toLowerCase().replace('_', ' '), room.status === 'READY' ? 'ok' : room.status === 'OUT_OF_SERVICE' ? 'bad' : room.status === 'CLEANING' ? 'warn' : 'info'),
              room.occupants.join(', ') || '—',
            ]),
            empty: 'No room registered beneath the accommodation system.',
          })}
        </div>
        <div>
          <h2>Journeys</h2>
          <div class="metric-sub" style="margin:6px 0 10px">${t.statement}</div>
          ${table({
            headers: ['Vehicle', 'Route', 'Departs', 'Seats', 'State'],
            align: ['', '', '', 'num', ''],
            rows: t.journeys.map((journey) => [
              journey.vehicle,
              journey.route,
              journey.departs.slice(0, 16).replace('T', ' '),
              `${journey.booked.length} / ${journey.seats}`,
              badge(journey.status.toLowerCase(), journey.status === 'ARRIVED' ? 'ok' : journey.status === 'CANCELLED' ? 'bad' : 'info'),
            ]),
            empty: 'No journey scheduled.',
          })}
        </div>
      </div>
      <div style="margin-top:14px">
        ${table({
          headers: ['Delivery', 'Supplier', 'Expected', 'Arrived', 'State'],
          align: ['', '', '', 'num', ''],
          rows: desk.deliveries.items.map((entry) => [
            entry.description,
            entry.supplier,
            entry.expectedOn,
            entry.quantityReceived === undefined ? `${entry.quantityExpected} expected` : `${entry.quantityReceived} of ${entry.quantityExpected}`,
            badge(entry.status.toLowerCase(), entry.status === 'RECEIVED' ? 'ok' : entry.status === 'EXPECTED' ? 'info' : 'bad'),
          ]),
          empty: 'No delivery scheduled.',
        })}
      </div>
      <div style="margin-top:14px">
        ${table({
          headers: ['Tag', 'Unit', 'Where', 'State', 'Scans'],
          align: ['mono', '', '', '', 'num'],
          rows: desk.assets.items.map((asset) => [
            html`<code>${asset.tag}</code>`,
            asset.kind,
            asset.location ?? '—',
            badge(asset.status.toLowerCase().replace('_', ' '), asset.status === 'ON_SITE' ? 'ok' : asset.status === 'DEFECTIVE' ? 'bad' : 'info'),
            String(asset.scans),
          ]),
          empty: 'No unit registered.',
        })}
      </div>
    </div>
  `;
}

/**
 * §6 stage 8 — the knowledge library, read against this project.
 *
 * Three tables the next job is meant to open with, and beneath them what the
 * library says about *this* project's own firms and prices. A benchmark is a
 * price, so it is withheld from a reader without commercial standing and the
 * card says so rather than showing an empty table.
 */
function libraryCard(library) {
  const applied = library.applied;
  const promotions = library.promotions;
  return html`
    <div class="card" style="margin-bottom:14px">
      <h2>The knowledge library</h2>
      <div class="metric-sub" style="margin:6px 0 12px">${library.statement}</div>
      <section class="grid g4" style="margin-bottom:14px">
        <div class="card"><h2>Suppliers scored</h2><div class="metric">${library.suppliers.length}</div><div class="metric-sub">written back from engagements that reached contract or were suspended</div></div>
        <div class="card"><h2>Price benchmarks</h2><div class="metric">${library.benchmarks ? library.benchmarks.length : '—'}</div><div class="metric-sub">${library.benchmarks ? 'median compliant rates from fully locked tenders, no bidder named' : 'withheld without commercial standing'}</div></div>
        <div class="card"><h2>Package templates</h2><div class="metric">${library.templates.length}</div><div class="metric-sub">the seven stated fields, the customer’s names withheld</div></div>
        <div class="card"><h2>Promoted from here</h2><div class="metric">${promotions.length}</div><div class="metric-sub">${promotions.length > 0 ? `last ${promotions.at(-1).promotedAt.slice(0, 10)} · checked against ${promotions.at(-1).checkedAgainst.length} name${promotions.at(-1).checkedAgainst.length === 1 ? '' : 's'}` : 'nothing yet'}</div></div>
      </section>
      <div class="grid g-2-1">
        <div>
          <h2>Supplier scores</h2>
          ${table({
            headers: ['Firm', 'Score', 'Engagements', 'To contract', 'To operation', 'Suspensions', 'Deliveries'],
            align: ['', 'num', 'num', 'num', 'num', 'num', ''],
            rows: library.suppliers.map((entry) => [
              entry.supplierName,
              html`<b class="${raw(entry.score >= 80 ? 'ok' : entry.score >= 50 ? 'warn' : 'bad')}">${String(entry.score)}</b>`,
              String(entry.engagements),
              String(entry.contracted),
              String(entry.operational),
              String(entry.suspensions),
              `${entry.deliveries.checked} checked · ${entry.deliveries.short} short · ${entry.deliveries.refused} refused`,
            ]),
            empty: 'No firm has a score yet. One is written back when a project promotes an engagement that reached Contracted or was suspended.',
          })}
        </div>
        <div>
          <h2>Templates</h2>
          ${table({
            headers: ['Families', 'Fields', 'Used'],
            align: ['', 'num', 'num'],
            rows: library.templates.map((entry) => [
              entry.label,
              `${Object.keys(entry.stated).length}${entry.withheldFields.length > 0 ? ` (${entry.withheldFields.join(', ')} withheld last time)` : ''}`,
              String(entry.uses),
            ]),
            empty: 'No template yet. One is promoted from a package that went to tender.',
          })}
        </div>
      </div>
      <div style="margin-top:14px">
        <h2>Price benchmarks</h2>
        ${library.benchmarks
          ? table({
              headers: ['Family', 'Item', 'Unit', 'Low', 'Median', 'High', 'Packages', 'Returns'],
              align: ['', '', '', 'num', 'num', 'num', 'num', 'num'],
              rows: library.benchmarks.map((entry) => [
                entry.familyLabel,
                entry.description,
                entry.unit,
                money(entry.lowMinor),
                money(entry.medianMinor),
                money(entry.highMinor),
                String(entry.packages),
                String(entry.returns),
              ]),
              empty: 'No benchmark yet. One is promoted per schedule item from a tender with every return locked and at least two compliant prices.',
            })
          : html`<div class="notice info"><div>${library.benchmarksWithheld}</div></div>`}
      </div>
      ${applied.packages.length > 0
        ? html`<div style="margin-top:14px">
            <h2>This project against the library</h2>
            ${applied.packages.map(
              (pkg) => html`<div class="metric-sub" style="margin:6px 0"><b>${pkg.reference}</b></div>
                ${table({
                  headers: ['Item', 'Field median', 'Library median', 'Variance', 'Samples'],
                  align: ['', 'num', 'num', 'num', 'num'],
                  rows: pkg.items.map((item) => [
                    item.description,
                    money(item.fieldMedianMinor),
                    money(item.libraryMedianMinor),
                    html`<span class="${raw(Math.abs(item.variancePercent) > 15 ? 'warn' : '')}">${item.variancePercent > 0 ? '+' : ''}${String(item.variancePercent)}%</span>`,
                    String(item.samples),
                  ]),
                })}`,
            )}
          </div>`
        : ''}
      ${applied.suppliers.length > 0
        ? html`<div style="margin-top:14px">
            <h2>This project’s firms, as the library knows them</h2>
            ${table({
              headers: ['Firm', 'Here', 'Library score', 'Engagements scored'],
              align: ['', '', 'num', 'num'],
              rows: applied.suppliers.map((entry) => [
                entry.supplierName,
                badge(entry.state.toLowerCase().replaceAll('_', ' '), entry.state === 'SUSPENDED_RECOVERY' ? 'bad' : 'info'),
                entry.score === undefined ? '—' : String(entry.score),
                entry.engagements === undefined ? 'never scored' : String(entry.engagements),
              ]),
            })}
          </div>`
        : ''}
      ${promotions.length > 0 && promotions.at(-1).withheld.length > 0
        ? html`<div class="metric-sub" style="margin-top:10px">Withheld at the last promotion: ${promotions.at(-1).withheld.map((entry) => `${entry.what} — ${entry.why}`).join(' · ')}</div>`
        : ''}
    </div>
  `;
}

/**
 * §3 read from a document, §19.10 kept honest.
 *
 * The documents filed for reading, whether the platform actually holds the
 * file behind each, and the drafts a provider produced from them. A draft is
 * shown with what the model read and the words it read it from, and it changes
 * nothing until somebody confirms it; a reading below the threshold is on this
 * list with its provenance rather than in the register. Where the deployment
 * cannot read a file the card says so at the control, in the platform's own
 * words, rather than after the attempt.
 */
function briefReading(perception, evidence) {
  const documents = (evidence?.entries ?? []).filter((entry) => entry.type === 'SITE_SERVICES_BRIEF_DOCUMENT');
  const drafts = (perception?.drafts ?? []).filter((draft) => draft.task === 'SITE_SERVICES_BRIEF');
  const open = drafts.filter((draft) => draft.status === 'DRAFT');
  const available = perception?.capability?.available === true;
  if (documents.length === 0 && drafts.length === 0) return '';
  const documentOf = (draft) => documents.find((entry) => entry.hash === draft.evidenceHash)?.description ?? draft.evidenceHash.slice(0, 16);
  return html`
    <div style="margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--line)">
      <h2>Read from a document</h2>
      ${perception && !available
        ? html`<div class="notice info" style="margin:6px 0 10px"><div><b>Not readable on this deployment.</b> ${perception.capability?.reason ?? ''} A filed document is still evidence; its facts are typed in until a provider that can see it is configured.</div></div>`
        : ''}
      ${table({
        headers: ['Document', 'Filed', 'File', ''],
        rows: documents.map((entry) => [
          entry.description,
          entry.capturedAt.slice(0, 10),
          entry.held ? badge('held', 'ok') : badge('not held', 'warn'),
          entry.held && available && state.session.user
            ? html`<button class="btn sm" data-read-brief="${entry.hash}">Read</button>`
            : html`<span class="metric-sub">${entry.held ? 'no provider can read it' : 'upload has not landed'}</span>`,
        ]),
        empty: 'No document filed for reading.',
      })}
      ${open.map(
        (draft) => html`<div class="notice ${raw((draft.confidence ?? 1) < 0.7 ? 'warn' : 'info')}" style="margin-top:10px">
          <div style="width:100%">
            <b>Read from ${documentOf(draft)}</b>
            <span class="metric-sub"> · by ${draft.aiProvenance?.provider ?? 'the provider'}${draft.aiProvenance?.synthetic ? ' (local stand-in)' : ''}${
              draft.confidence !== undefined ? ` · confidence ${Math.round(draft.confidence * 100)}%` : ''
            }${(draft.confidence ?? 1) < 0.7 ? ' · below the threshold: check every figure against the page' : ''}</span>
            ${table({
              headers: ['Item', 'Value', 'Read from', 'Page'],
              rows: (draft.extraction.facts ?? []).map((fact) => [
                fact.itemId,
                String(fact.value),
                html`<span class="metric-sub">${fact.quoted ?? ''}</span>`,
                fact.page == null ? '—' : String(fact.page),
              ]),
            })}
            ${(draft.extraction.omitted ?? []).length > 0
              ? html`<div class="metric-sub" style="margin-top:6px">Looked for and not found: ${draft.extraction.omitted.join(' · ')}</div>`
              : ''}
            <div style="margin-top:8px;display:flex;gap:8px">
              <button class="btn sm" data-confirm-brief="${draft.id}">Confirm into the register</button>
              <button class="btn sm quiet" data-discard-brief="${draft.id}">Reject</button>
            </div>
          </div>
        </div>`,
      )}
      ${drafts.length > open.length
        ? html`<div class="metric-sub" style="margin-top:8px">${drafts.length - open.length} earlier reading${drafts.length - open.length === 1 ? '' : 's'} settled: ${drafts
            .filter((draft) => draft.status !== 'DRAFT')
            .map((draft) => `${documentOf(draft)} ${draft.status.toLowerCase()}`)
            .join(' · ')}</div>`
        : ''}
    </div>
  `;
}
