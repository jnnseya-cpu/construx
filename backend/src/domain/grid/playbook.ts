/**
 * The HV Grid Connection delivery playbook — 42 steps across eight gates (G0–G7),
 * as a closed, validated domain pack.
 *
 * This is the engineering truth the Grid Connection AI module runs on. It is a pure
 * catalogue plus deterministic gate logic — no persistence, no routes — so the
 * sequence of steps, the gate each belongs to, the agent that owns it, and the rule
 * by which a gate advances are one source of truth that the rest of the module
 * (engagement store, workboard, agents) reads rather than restates.
 *
 * Safety is in the shape of the data: a step is a *digital* task an agent owns;
 * physical activity, witnessed results and legal/electrical approvals arrive as
 * external facts. An electrical gate never advances on digital readiness alone — it
 * requires a verified authority record. No step carries any switching, set-point or
 * relay-write capability; there is no such field to carry it.
 */

/** The ten agent capabilities of the grid workforce (spec §4). */
export const GRID_CAPABILITIES = [
  'DIRECTOR',
  'CONNECTION_CODE',
  'INTERFACE_PROGRAMME',
  'DESIGN_ASSURANCE',
  'FIELD_QUALITY',
  'COMMISSIONING',
  'CUTOVER_READINESS',
  'COMMERCIAL_RECORDS',
  'HANDOVER',
  'INDEPENDENT_ASSURANCE',
] as const;
export type GridCapability = (typeof GRID_CAPABILITIES)[number];

export type GateId = 'G0' | 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7';

/**
 * The eight gates. `electricalAuthority` marks the gates that advance only with a
 * verified authority record (first energisation, permission to take demand, campus
 * transfer, interim retirement, final handover) — never on digital readiness alone.
 */
export const GRID_GATES: ReadonlyArray<{ id: GateId; title: string; electricalAuthority: boolean }> = [
  { id: 'G0', title: 'Agreement & Capacity', electricalAuthority: false },
  { id: 'G1', title: 'Programme & Interfaces', electricalAuthority: false },
  { id: 'G2', title: 'Design & Equipment', electricalAuthority: false },
  { id: 'G3', title: 'Construction & Turnover', electricalAuthority: false },
  { id: 'G4', title: 'ITP & Commissioning', electricalAuthority: true },
  { id: 'G5', title: 'Energisation', electricalAuthority: true },
  { id: 'G6', title: 'Cutover & Transfer', electricalAuthority: true },
  { id: 'G7', title: 'Handover & Claims', electricalAuthority: true },
];

export type GridStep = {
  /** Two-digit step id, '01'–'42'. */
  id: string;
  gate: GateId;
  capability: GridCapability;
  /** What the agent executes (digital). */
  executes: string;
  /** The controlled output or validation the step produces. */
  output: string;
  /** A required digital task counts toward gate/engagement coverage. */
  requiredDigital: boolean;
};

/** The 42 delivery steps (spec §5), in order. */
export const GRID_STEPS: readonly GridStep[] = [
  // G0 — Agreement & Capacity
  { id: '01', gate: 'G0', capability: 'CONNECTION_CODE', executes: 'Collect signed offer, BCA, construction agreement, amendments, land instruments and correspondence', output: 'Signed/unsigned agreement inventory, versions, counterparties and missing schedules', requiredDigital: true },
  { id: '02', gate: 'G0', capability: 'CONNECTION_CODE', executes: 'Classify transmission, distribution, self-build and supply topology', output: 'Confirmed route and point of connection, ownership, interim sources, export/parallel/islanding flags', requiredDigital: true },
  { id: '03', gate: 'G0', capability: 'CONNECTION_CODE', executes: 'Extract import/export, units, ramp, firmness and restrictions; reconcile campus load', output: 'Approved capacity envelope by connection point and phase (MW≠MVA without verified power factor)', requiredDigital: true },
  { id: '04', gate: 'G0', capability: 'CONNECTION_CODE', executes: 'Extract obligations, deadlines and evidence by clause', output: 'Owner, accepting party, trigger, dated obligation, notice and programme links', requiredDigital: true },
  { id: '05', gate: 'G0', capability: 'CONNECTION_CODE', executes: 'Build applicable standards profile and identify conflicts', output: 'Versioned requirements and scope; unclear demand-notification pathway routed to authority', requiredDigital: true },
  { id: '06', gate: 'G0', capability: 'DIRECTOR', executes: 'Build authority matrix from documented appointments', output: 'Named authority, action, boundary, limits and expiry (job title alone grants no authority)', requiredDigital: true },
  // G1 — Programme & Interfaces
  { id: '07', gate: 'G1', capability: 'INTERFACE_PROGRAMME', executes: 'Extract asset, construction and operational boundaries', output: 'Versioned boundary overlays, demarcation matrix and responsibility schedule', requiredDigital: true },
  { id: '08', gate: 'G1', capability: 'INTERFACE_PROGRAMME', executes: 'Connect utility/client/vendor interfaces to exact outputs', output: 'Producer, receiver, required-by, dependencies and accepted deliverables', requiredDigital: true },
  { id: '09', gate: 'G1', capability: 'INTERFACE_PROGRAMME', executes: 'Build critical and near-critical paths backwards from permitted phased load', output: 'Logic-linked schedule with separate first-energisation, permitted-demand and transfer milestones', requiredDigital: true },
  { id: '10', gate: 'G1', capability: 'INTERFACE_PROGRAMME', executes: 'Prepare and track utility access/outage requests and alternatives', output: 'Draft request, approved-window evidence, named controller and conflicts (a forecast slot is tentative)', requiredDigital: true },
  { id: '11', gate: 'G1', capability: 'INTERFACE_PROGRAMME', executes: 'Prepare agenda, extract minutes and follow internal actions', output: 'Attendance, action/decision log, authorised escalations to project leadership', requiredDigital: true },
  { id: '12', gate: 'G1', capability: 'INTERFACE_PROGRAMME', executes: 'Build submission and resubmission logic', output: 'Draft/check/issue/review/acceptance dates, version, recipient, transmittal and response', requiredDigital: true },
  // G2 — Design & Equipment
  { id: '13', gate: 'G2', capability: 'DESIGN_ASSURANCE', executes: 'Consolidate network, load and plant design basis', output: 'Validated assumptions by revision and source, outstanding checks', requiredDigital: true },
  { id: '14', gate: 'G2', capability: 'DESIGN_ASSURANCE', executes: 'Map requirements to design, calculation and testing', output: 'Queryable compliance trace and accepted disposition', requiredDigital: true },
  { id: '15', gate: 'G2', capability: 'DESIGN_ASSURANCE', executes: 'Specify and call approved analysis integrations where authorised', output: 'Versioned model/inputs/results; competence referral if tool or source unavailable', requiredDigital: true },
  { id: '16', gate: 'G2', capability: 'DESIGN_ASSURANCE', executes: 'Compare switchgear, transformers, cables, protection and controls with requirements', output: 'Conformance matrix, deviations and long-lead procurement risk', requiredDigital: true },
  { id: '17', gate: 'G2', capability: 'DESIGN_ASSURANCE', executes: 'Reconcile IFC, vendor/shop drawings, calculations and site requirements', output: 'Revision delta, constructability queries and impact propagation', requiredDigital: true },
  { id: '18', gate: 'G2', capability: 'DESIGN_ASSURANCE', executes: 'Monitor procurement, configuration and FAT release dependencies', output: 'Manufacturer milestones, witness requirements, release evidence and carry-over', requiredDigital: true },
  // G3 — Construction & Turnover
  { id: '19', gate: 'G3', capability: 'FIELD_QUALITY', executes: 'Assemble work-pack readiness by location/system', output: 'Approved design/RAMS/permit references, access constraints and open items', requiredDigital: true },
  { id: '20', gate: 'G3', capability: 'FIELD_QUALITY', executes: 'Check concealed-work inspections and photo/redline evidence', output: 'Missing hold/witness alerts and immutable asset/location links', requiredDigital: true },
  { id: '21', gate: 'G3', capability: 'FIELD_QUALITY', executes: 'Reconcile serials, receipt, defects and deviations', output: 'NCRs, configuration impact and reopened evidence where required', requiredDigital: true },
  { id: '22', gate: 'G3', capability: 'FIELD_QUALITY', executes: 'Compile construction-to-test turnover packs', output: 'Separate signed construction and test-readiness records', requiredDigital: true },
  // G4 — ITP & Commissioning
  { id: '23', gate: 'G4', capability: 'COMMISSIONING', executes: 'Build joint commissioning programme, boundaries and witness logic', output: 'Versioned strategy, agreed dates, rehearsals and panel actions', requiredDigital: true },
  { id: '24', gate: 'G4', capability: 'COMMISSIONING', executes: 'Generate asset/function-level ITPs using approved criteria', output: 'Test requirement, criteria source, witness/hold, asset and revision', requiredDigital: true },
  { id: '25', gate: 'G4', capability: 'COMMISSIONING', executes: 'Ingest FAT results and match approved configuration', output: 'Result evidence, defects, retest or concession, carry-over SAT items', requiredDigital: true },
  { id: '26', gate: 'G4', capability: 'COMMISSIONING', executes: 'Reconcile SAT and end-to-end proofs for protection, controls, SCADA and metering', output: 'Installed revision, evidence and witnesses, failures, retests and missing proofs', requiredDigital: true },
  { id: '27', gate: 'G4', capability: 'COMMISSIONING', executes: 'Map compliance submissions, notices and permitted operating states', output: 'Issuer, exact permissions, capacity, conditions, timestamps and expiry (EON/ION/FON only when evidenced)', requiredDigital: true },
  { id: '28', gate: 'G4', capability: 'COMMISSIONING', executes: 'Prepare walkdown checklist and reconcile signed field results', output: 'Safety readiness matrix; missing safety-critical items block the candidate', requiredDigital: true },
  // G5 — Energisation
  { id: '29', gate: 'G5', capability: 'CUTOVER_READINESS', executes: 'Compile exact scope and approval dependencies for first energisation', output: 'Pinned notice, drawing, outage and authorised-procedure references', requiredDigital: true },
  { id: '30', gate: 'G5', capability: 'CUTOVER_READINESS', executes: 'Package the operational handoff and track authoritative acknowledgement', output: 'Controller assignment, handoff record and approved document references (no switching commands)', requiredDigital: true },
  { id: '31', gate: 'G5', capability: 'CUTOVER_READINESS', executes: 'Record first energisation and stabilisation from authorised evidence', output: 'Actual event, affected scope, observed status and remaining limits (no implied load acceptance)', requiredDigital: true },
  // G6 — Cutover & Transfer
  { id: '32', gate: 'G6', capability: 'CUTOVER_READINESS', executes: 'Map interim/permanent topology and critical load dependencies', output: 'Verified source/load inventory, shared services, backup and degraded states', requiredDigital: true },
  { id: '33', gate: 'G6', capability: 'CUTOVER_READINESS', executes: 'Assemble phase-state views from authoritative drawings and procedure references', output: 'Review-only initial, intermediate, target and fallback views; missing topology stays unresolved', requiredDigital: true },
  { id: '34', gate: 'G6', capability: 'CUTOVER_READINESS', executes: 'Model continuity, headroom and fallback dependencies with validated inputs', output: 'Agreed assumptions, loads, windows, risks and failure-case evidence (no zero-downtime claim)', requiredDigital: true },
  { id: '35', gate: 'G6', capability: 'CUTOVER_READINESS', executes: 'Generate phase decision sheets with limits and escalation triggers', output: 'Entry/exit state, relevant procedure, hold/abort criteria and rollback authority', requiredDigital: true },
  { id: '36', gate: 'G6', capability: 'CUTOVER_READINESS', executes: 'Prepare rehearsal and reconcile phase completion from authorised records', output: 'Findings, permitted telemetry evidence, holds and acceptance for each phase', requiredDigital: true },
  { id: '37', gate: 'G6', capability: 'CUTOVER_READINESS', executes: 'Track proving and interim retirement prerequisites', output: 'Stability evidence, acceptance, notices and physical disconnection records', requiredDigital: true },
  // G7 — Handover & Claims
  { id: '38', gate: 'G7', capability: 'HANDOVER', executes: 'Assemble final compliance and asset handover', output: 'Conditions, as-builts, approved settings references, test packs, maintenance, residual risk and acceptance', requiredDigital: true },
  { id: '39', gate: 'G7', capability: 'HANDOVER', executes: 'Preserve agreements, correspondence, baselines, revisions and actuals', output: 'Tamper-evident timeline and controlled evidence access', requiredDigital: true },
  { id: '40', gate: 'G7', capability: 'COMMERCIAL_RECORDS', executes: 'Detect potential delay events and draft notices', output: 'Clause, deadlines, owner, factual basis and authorisation request (no implied entitlement)', requiredDigital: true },
  { id: '41', gate: 'G7', capability: 'COMMERCIAL_RECORDS', executes: 'Reconcile schedule/cost impact and mitigation', output: 'Baseline comparisons, causation evidence and review-ready claim support', requiredDigital: true },
  { id: '42', gate: 'G7', capability: 'HANDOVER', executes: 'Generate lessons and phase transfer pack', output: 'Redacted and approved knowledge handover with assigned actions', requiredDigital: true },
];

/** The gate states a gate can hold (spec §6.5). */
export type GateState =
  | 'PENDING'
  | 'BLOCKED'
  | 'CANDIDATE_READY'
  | 'AWAITING_AUTHORITY'
  | 'APPROVED'
  | 'EXPIRED'
  | 'SUPERSEDED';

export const GATE_IDS: readonly GateId[] = GRID_GATES.map((g) => g.id);

export function gateMeta(gate: GateId): { id: GateId; title: string; electricalAuthority: boolean } {
  const found = GRID_GATES.find((g) => g.id === gate);
  if (!found) throw new Error(`Unknown gate ${gate}`);
  return found;
}

/** The steps belonging to a gate, in order. */
export function stepsOfGate(gate: GateId): readonly GridStep[] {
  return GRID_STEPS.filter((s) => s.gate === gate);
}

/** The run state of a step as the engagement tracks it (mirrors the agent-run states). */
export type StepStatus = 'OPEN' | 'VALIDATED' | 'BLOCKED';

/**
 * Deterministic gate state from the gate's step statuses and its authority/decision
 * record. An electrical gate reaching digital readiness is AWAITING_AUTHORITY, never
 * APPROVED, until a verified authority record exists — digital readiness alone never
 * advances it.
 */
export function gateState(
  gate: GateId,
  statuses: Record<string, StepStatus>,
  record: { authorityRecorded?: boolean; decisionApproved?: boolean; superseded?: boolean; expired?: boolean } = {},
): GateState {
  if (record.superseded) return 'SUPERSEDED';
  if (record.expired) return 'EXPIRED';

  const steps = stepsOfGate(gate).filter((s) => s.requiredDigital);
  const statusOf = (s: GridStep): StepStatus => statuses[s.id] ?? 'OPEN';

  if (steps.some((s) => statusOf(s) === 'BLOCKED')) return 'BLOCKED';

  const allValidated = steps.length > 0 && steps.every((s) => statusOf(s) === 'VALIDATED');
  if (!allValidated) return 'PENDING';

  // Digital readiness reached. An electrical gate needs a verified authority record;
  // a non-electrical gate needs its gate decision approved.
  const electrical = gateMeta(gate).electricalAuthority;
  if (electrical) {
    return record.authorityRecorded ? 'APPROVED' : 'AWAITING_AUTHORITY';
  }
  return record.decisionApproved ? 'APPROVED' : 'CANDIDATE_READY';
}

/** Verified digital coverage over a set of steps (completed & validated / required). */
export function coverage(statuses: Record<string, StepStatus>, steps: readonly GridStep[] = GRID_STEPS): {
  requiredDigital: number;
  validated: number;
  percent: number;
} {
  const required = steps.filter((s) => s.requiredDigital);
  const validated = required.filter((s) => (statuses[s.id] ?? 'OPEN') === 'VALIDATED');
  const percent = required.length === 0 ? 0 : Math.round((validated.length / required.length) * 100);
  return { requiredDigital: required.length, validated: validated.length, percent };
}
