import { DomainError, ForbiddenError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { authorise, write, type EngineContext } from '../../engines/context.ts';
import type { Role } from '../../identity/roles.ts';
import { requireModule } from '../../identity/modules.ts';
import type { ServiceFamily } from './brief.ts';
import { SERVICE_FAMILIES } from './brief.ts';
import { profileFor } from './appointment.ts';
import type { ServiceInterface, ServiceSystem } from './composer.ts';

/**
 * §8 — the Mobilisation Control Tower.
 *
 * **"Mobilisation is a dependency network, not a percentage complete."**
 *
 * That is the whole module. Every mobilisation tracker in the industry is a
 * spreadsheet of percentages supplied by the people being measured, and it
 * reads 94% until the week it reads 41% — because a percentage cannot be wrong,
 * only revised. A gate network can be wrong, which is what makes it useful: it
 * says *this specific thing is missing and until it arrives nothing downstream
 * is ready*.
 *
 * ---
 *
 * ## Not `domain/mobilisation.ts`, which is a different question
 *
 * CONSTRUX already has a module of that name and it is not this one. CN-WF-01
 * authorises a **gang starting work on a workface**: design current, RAMS
 * approved, permit live, temporary works checked, operatives ticketed,
 * possession held. It runs every time work starts somewhere new.
 *
 * This authorises a **service into operation**: from the contract being
 * effective, through off-site manufacture and site readiness, to installation,
 * integrated testing and a Mobilisation Acceptance signed by the service owner.
 * It runs once per service, and what it produces is a certificate rather than a
 * permission to start.
 *
 * The two share a conviction — readiness is calculated from evidence, never
 * declared — and nothing else. Merging them would put a welfare village's
 * catering rota and a concrete pour's temporary works check in one register.
 *
 * ## The hard stop
 *
 * The specification states it plainly and it is the single most important rule
 * here: **the scheduler cannot mark a package "ready" because the supplier
 * reports 100%.** Readiness is calculated from prerequisite evidence and
 * interface tests, and safety-critical or contractual gates require named
 * approval.
 *
 * So a supplier declaration is a first-class record — `declareProgress` writes
 * one, it appears on the tower, and it moves **nothing**. It is worth recording
 * precisely because it is worth arguing with later: the difference between what
 * a supplier said in week six and what the evidence showed is the whole
 * mobilisation dispute, and a platform that discarded the first half could not
 * settle it.
 *
 * ## Evidence is checked, not ticked
 *
 * "Machine-checkable evidence" cannot mean a checkbox. Each attestation records
 * **a reference** — the certificate number, the drawing revision, the test
 * sheet — and, where the item is one that expires, **an expiry date**. Expired
 * evidence does not satisfy its item. An insurance certificate that lapsed in
 * March is not evidence in April, and the commonest mobilisation failure is
 * exactly that: everything was in place once.
 *
 * Some items the platform can answer from its own records and does not ask
 * anybody about — whether the service system is composed, whether its interface
 * matrix is closed, whether the appointment names a contracting entity. Those
 * are **derived** and cannot be attested away.
 *
 * ## Evidence is accepted only by the authorised role
 *
 * Each gate names the roles that may pass it, taken from the specification's
 * own human approval condition. Holding `A` on `SITE_SERVICES` is not enough:
 * the site manager releases the area, the duty holder accepts energisation, and
 * the service owner signs the acceptance. A planner may hold the capability and
 * still may not sign off a safe energisation.
 */

// --- The seven gates ----------------------------------------------------------

export type EvidenceKind = 'DERIVED' | 'ATTESTED';

export type GateEvidenceItem = {
  id: string;
  label: string;
  kind: EvidenceKind;
  /** Why it is asked for — the failure it prevents, not the box it fills. */
  matters: string;
  /**
   * Items that go out of date. The attestation is refused without an expiry,
   * and lapses on it.
   */
  expiryRequired?: true;
  /** Where the item only applies to some families. Absent means all seven. */
  families?: readonly ServiceFamily[];
};

export type GateId = 'G0' | 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6';

export type GateDefinition = {
  id: GateId;
  order: number;
  name: string;
  /** The specification's own human approval condition. */
  approvalCondition: string;
  /** Who may give it. Holding the capability is not enough. */
  approvers: readonly Role[];
  /**
   * A gate whose approval is a competent person's act rather than a manager's.
   *
   * §16: AI never substitutes a legally required competent-person check, and
   * critical hold points fail closed. G5 is the energisation gate and G3
   * releases people onto an area.
   */
  safetyCritical: boolean;
  evidence: readonly GateEvidenceItem[];
};

export const GATES: readonly GateDefinition[] = [
  {
    id: 'G0',
    order: 0,
    name: 'Contract effective',
    approvalCondition: 'Correct contracting party and authority confirmed.',
    approvers: ['COMMERCIAL_MANAGER', 'PROJECT_DIRECTOR'],
    safetyCritical: false,
    evidence: [
      {
        id: 'contractingParty',
        label: 'The contracting party matches the appointment',
        kind: 'DERIVED',
        matters:
          'Under Advisory and Management the customer holds the supplier contract and ETABLIX does not. A package let by the wrong entity is unenforceable by whoever thinks they hold it.',
      },
      {
        id: 'executedContract',
        label: 'Executed contract or purchase order',
        kind: 'ATTESTED',
        matters: 'Work started against an unsigned order is work nobody has to pay for and nobody can instruct.',
      },
      {
        id: 'insurance',
        label: 'Insurance in place, to the cover this appointment requires',
        kind: 'ATTESTED',
        expiryRequired: true,
        matters:
          'A supplier on site whose cover lapsed is discovered at the claim. The cover required follows the appointment model, not the package.',
      },
      {
        id: 'bonds',
        label: 'Bond position — in place, or a recorded decision that none is required',
        kind: 'ATTESTED',
        matters: '"None required" is an answer. Silence is what turns up in a dispute as an assumption nobody made on purpose.',
      },
      {
        id: 'dataPrivacy',
        label: 'Data and privacy terms agreed',
        kind: 'ATTESTED',
        matters:
          'Worker and visitor data held with no basis and no retention limit, which is a regulatory exposure before it is a commercial one.',
      },
      {
        id: 'paymentSetup',
        label: 'Payment route set up and tested',
        kind: 'ATTESTED',
        matters: 'A valuation with nowhere to go, and a supplier who stops attending in month three.',
      },
    ],
  },
  {
    id: 'G1',
    order: 1,
    name: 'Design basis',
    approvalCondition: 'Design responsibility and review status accepted.',
    approvers: ['PRINCIPAL_DESIGNER', 'DESIGNER', 'EPC', 'PROJECT_DIRECTOR'],
    safetyCritical: false,
    evidence: [
      {
        id: 'approvedRequirements',
        label: 'A service system is composed for this scope',
        kind: 'DERIVED',
        matters: 'Without one there is no design basis to build against, only a brief somebody is interpreting.',
      },
      {
        id: 'calculations',
        label: 'The demand basis carries its calculations',
        kind: 'DERIVED',
        matters:
          'A capacity with no formula behind it cannot be checked, and cannot be defended when the workforce grows.',
      },
      {
        id: 'interfaceMatrix',
        label: 'Every non-negotiable interface accepted',
        kind: 'DERIVED',
        matters:
          'An open interface is the gap that turns up on site. This is the gate that stops a compound being built onto ground nobody tested.',
      },
      {
        id: 'layouts',
        label: 'Layouts issued for construction',
        kind: 'ATTESTED',
        matters: 'Cabins set out from a drawing that has since been superseded, and moved once at somebody’s cost.',
      },
      {
        id: 'temporaryWorksCategory',
        label: 'Temporary works category assigned and the designer appointed',
        kind: 'ATTESTED',
        matters:
          'BS 5975 puts the check level on the category. Assigning it late means the check happens after the thing is built.',
        families: ['ENABLING_CIVILS', 'TEMPORARY_INFRASTRUCTURE', 'TEMPORARY_MEP'],
      },
    ],
  },
  {
    id: 'G2',
    order: 2,
    name: 'Off-site readiness',
    approvalCondition: 'No unresolved critical nonconformance.',
    approvers: ['QAQC', 'PROJECT_DIRECTOR'],
    safetyCritical: false,
    evidence: [
      {
        id: 'manufactureStatus',
        label: 'Manufacture status confirmed against the delivery date',
        kind: 'ATTESTED',
        matters: 'The lead time nobody checked is the one that puts the compound three weeks behind the first pour.',
      },
      {
        id: 'fat',
        label: 'Factory acceptance test passed',
        kind: 'ATTESTED',
        matters: 'A generator that fails on site fails after the crane has gone.',
        families: ['TEMPORARY_MEP', 'TEMPORARY_INFRASTRUCTURE'],
      },
      {
        id: 'certifications',
        label: 'Product and system certifications',
        kind: 'ATTESTED',
        expiryRequired: true,
        matters: 'A certificate that expired between order and delivery is not a certificate.',
      },
      {
        id: 'deliveryPlan',
        label: 'Delivery plan agreed with the site',
        kind: 'ATTESTED',
        matters: 'A wagon at the gate with no slot, on a road that cannot take it.',
      },
      {
        id: 'liftingTransport',
        label: 'Lifting and transport plan',
        kind: 'ATTESTED',
        matters: 'A lift with no plan is the single most common way this work becomes a RIDDOR report.',
      },
      {
        id: 'ramsDraft',
        label: 'RAMS drafted and issued for review',
        kind: 'ATTESTED',
        matters: 'A method statement written the morning of the work is one nobody has reviewed.',
      },
    ],
  },
  {
    id: 'G3',
    order: 3,
    name: 'Site ready',
    approvalCondition: 'Area released by the construction or site manager.',
    approvers: ['CONSTRUCTION_MANAGER', 'SUPERVISOR', 'PM'],
    // People and plant go onto an area on the strength of this. It is a
    // release, not a status update.
    safetyCritical: true,
    evidence: [
      {
        id: 'survey',
        label: 'Pre-occupation condition survey recorded',
        kind: 'ATTESTED',
        matters:
          'The reinstatement argument at the end is settled by the survey taken at the beginning, or it is not settled at all.',
      },
      {
        id: 'platformRoads',
        label: 'Platform and access roads complete to the design load',
        kind: 'ATTESTED',
        matters: 'Ground that carries the cabins and not the crane that lifts them.',
      },
      {
        id: 'permits',
        label: 'Permits obtained',
        kind: 'ATTESTED',
        expiryRequired: true,
        matters: 'Work stopped by an authority nobody applied to in time — and permits run out.',
      },
      {
        id: 'utilities',
        label: 'Utilities available at the boundary of the area',
        kind: 'DERIVED',
        matters:
          'A welfare block with no supply is a welfare block nobody can use, and the connection lead time is measured in months.',
        families: ['WELFARE_ACCOMMODATION', 'TEMPORARY_INFRASTRUCTURE', 'CLEANING_FM'],
      },
      {
        id: 'exclusionZone',
        label: 'Exclusion zone established and communicated',
        kind: 'ATTESTED',
        matters: 'Deliveries and lifts alongside a live workforce nobody warned.',
      },
      {
        id: 'accessSlot',
        label: 'Access slot booked',
        kind: 'ATTESTED',
        matters: 'Two packages arriving into the same gate hour, and one of them going away again.',
      },
      {
        id: 'weatherThreshold',
        label: 'Weather thresholds stated for the operation',
        kind: 'ATTESTED',
        matters: 'A wind limit decided on the day, by the person under most pressure to proceed.',
      },
    ],
  },
  {
    id: 'G4',
    order: 4,
    name: 'Install complete',
    approvalCondition: 'Physical inspection accepted.',
    approvers: ['QAQC', 'CONSTRUCTION_MANAGER'],
    safetyCritical: false,
    evidence: [
      {
        id: 'assetIds',
        label: 'Asset identifiers recorded against the installed items',
        kind: 'ATTESTED',
        matters:
          'An asset with no identifier cannot be maintained, cannot be off-hired against a return condition, and cannot be found at demobilisation.',
      },
      {
        id: 'installRecords',
        label: 'Installation records',
        kind: 'ATTESTED',
        matters: 'What was actually done, by whom, on what date — the only defence against a later defect claim.',
      },
      {
        id: 'photos',
        label: 'Photographic record before anything is covered up',
        kind: 'ATTESTED',
        matters: 'Buried services and fixings are photographed now or excavated later.',
      },
      {
        id: 'testRecords',
        label: 'Torque and test records',
        kind: 'ATTESTED',
        matters: 'A connection nobody tested is one that fails under the first load.',
      },
      {
        id: 'snagList',
        label: 'Snag list raised and its critical items closed',
        kind: 'ATTESTED',
        matters: 'Snags carried past this gate are snags carried into operation, where nobody owns them.',
      },
      {
        id: 'asBuiltLocation',
        label: 'As-built location recorded',
        kind: 'ATTESTED',
        matters: 'The demobilisation plan is drawn from this. What is not located is not removed.',
      },
    ],
  },
  {
    id: 'G5',
    order: 5,
    name: 'Integrated test',
    approvalCondition: 'The duty holder accepts safe energisation and use.',
    // A named competent person. Not a manager, and never an agent.
    approvers: ['SAFETY', 'CONSTRUCTION_MANAGER', 'EPC'],
    safetyCritical: true,
    evidence: [
      {
        id: 'interfaceTests',
        label: 'Power, water, foul, fire, data and access interfaces tested together',
        kind: 'ATTESTED',
        matters:
          'Every one passed in isolation and the system failed on the first Monday. Integration is where mobilisation actually fails.',
      },
      {
        id: 'loadTest',
        label: 'Load test completed',
        kind: 'ATTESTED',
        matters: 'A supply that holds the commissioning load and not the shift-change load.',
        families: ['TEMPORARY_MEP', 'ENABLING_CIVILS'],
      },
      {
        id: 'alarmDrill',
        label: 'Alarm and escalation drill run, with the response times recorded',
        kind: 'ATTESTED',
        matters:
          'An alarm nobody has answered under drill conditions is an alarm nobody answers at three in the morning.',
      },
      {
        id: 'energisationAuthority',
        label: 'Energisation and isolation authority named',
        kind: 'ATTESTED',
        matters:
          'The competent person who may energise and who may isolate. Unnamed, both happen by whoever is nearest.',
        families: ['TEMPORARY_MEP'],
      },
    ],
  },
  {
    id: 'G6',
    order: 6,
    name: 'Operational ready',
    approvalCondition: 'The service owner signs the Mobilisation Acceptance.',
    approvers: ['FM', 'PM', 'PROJECT_DIRECTOR'],
    safetyCritical: false,
    evidence: [
      {
        id: 'staffing',
        label: 'Staffing in place against the roster',
        kind: 'ATTESTED',
        matters: 'A service accepted on the strength of people who start the following month.',
      },
      {
        id: 'training',
        label: 'Training completed and in date',
        kind: 'ATTESTED',
        expiryRequired: true,
        matters: 'Competence has a date on it, and the date is the thing nobody watches.',
      },
      {
        id: 'spares',
        label: 'Critical spares held',
        kind: 'ATTESTED',
        matters: 'A four-week lead time on a part that fails in week one.',
      },
      {
        id: 'consumables',
        label: 'Consumables and their reorder point',
        kind: 'ATTESTED',
        matters: 'Running out mid-shift because nobody owns the reorder point.',
      },
      {
        id: 'helpdesk',
        label: 'Helpdesk live, with its routing tested',
        kind: 'ATTESTED',
        matters: 'A number that rings out is worse than no number, because people stop reporting.',
      },
      {
        id: 'sop',
        label: 'Standard operating procedures issued',
        kind: 'ATTESTED',
        matters: 'A service run from memory is a service that changes when the person does.',
      },
      {
        id: 'emergencyContacts',
        label: 'Emergency contacts published and reconciled with the site plan',
        kind: 'ATTESTED',
        matters: 'The list on the wall and the list in the plan disagreeing, discovered during the incident.',
      },
      {
        id: 'kpiStart',
        label: 'KPI measurement started, with its baseline recorded',
        kind: 'ATTESTED',
        matters:
          'A service accepted with no measurement running has no first month to compare anything to, and the first dispute has no data.',
      },
    ],
  },
];

const GATE_BY_ID = new Map(GATES.map((gate) => [gate.id, gate]));

export function isGateId(value: string): value is GateId {
  return GATE_BY_ID.has(value as GateId);
}

/** The evidence items that apply to a family — the gate derived for this scope. */
export function evidenceFor(gate: GateDefinition, family: ServiceFamily): GateEvidenceItem[] {
  return gate.evidence.filter((item) => !item.families || item.families.includes(family));
}

// --- Records -------------------------------------------------------------------

export type GateEvidence = {
  id: string;
  projectId: string;
  systemId: string;
  gate: GateId;
  itemId: string;
  /** The certificate number, drawing revision or test sheet. Never a tick. */
  reference: string;
  expiresAt?: string;
  attestedBy: string;
  attestedAt: string;
  withdrawnBy?: string;
  withdrawnAt?: string;
  withdrawnReason?: string;
};

export type GateApproval = {
  id: string;
  projectId: string;
  systemId: string;
  gate: GateId;
  approvedBy: string;
  /** The roles the approver actually held. A snapshot, like every other. */
  roleAtApproval: string[];
  approvedAt: string;
  note: string;
};

export type SupplierDeclaration = {
  id: string;
  projectId: string;
  systemId: string;
  percent: number;
  declaredBy: string;
  declaredAt: string;
  note: string;
  /**
   * Recorded on the record itself, so it survives being read out of context.
   *
   * A declaration extracted into a report six months later must carry the fact
   * that it moved nothing, or it reads as an accepted status.
   */
  moves: string;
};

function systemOf(ctx: EngineContext, systemId: string): ServiceSystem {
  const record = ctx.ledger
    .list(ctx.projectId, 'ServiceSystem')
    .map((entry) => entry.state as unknown as ServiceSystem)
    .find((entry) => entry.id === systemId);
  if (!record) throw new DomainError('SERVICE_SYSTEM_NOT_FOUND', 'No such service system on this project', 404);
  return record;
}

function evidenceOf(ctx: EngineContext, systemId: string): GateEvidence[] {
  return ctx.ledger
    .list(ctx.projectId, 'GateEvidence')
    .map((record) => record.state as unknown as GateEvidence)
    .filter((entry) => entry.systemId === systemId && !entry.withdrawnAt);
}

function approvalsOf(ctx: EngineContext, systemId: string): GateApproval[] {
  return ctx.ledger
    .list(ctx.projectId, 'GateApproval')
    .map((record) => record.state as unknown as GateApproval)
    .filter((entry) => entry.systemId === systemId);
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

// --- Deriving what the platform already knows ----------------------------------

/**
 * The evidence items nobody is asked about, because the platform can answer
 * them from its own records.
 *
 * These cannot be attested away. An interface matrix with three open interfaces
 * is not closed because somebody typed a certificate number against it, and the
 * whole value of a derived item is that it is not somebody's opinion.
 *
 * Exported for one reason: the default case fails closed, and that guarantee is
 * only worth stating if it can be proven. Nothing in the declared gate network
 * reaches it today, so the only way to demonstrate that a derived item with no
 * rule behind it comes back unsatisfied is to ask for one.
 */
export function deriveEvidence(
  ctx: EngineContext,
  system: ServiceSystem,
  itemId: string,
): { satisfied: boolean; detail: string } {
  const interfaces = ctx.ledger
    .list(ctx.projectId, 'ServiceInterface')
    .map((record) => record.state as unknown as ServiceInterface)
    .filter((entry) => entry.systemId === system.id);

  switch (itemId) {
    case 'approvedRequirements':
      // Composing is what creates the system, so reaching this means it exists.
      // What is worth saying is which version the mobilisation is against.
      return {
        satisfied: true,
        detail: `Composed ${system.composedAt.slice(0, 10)} at version ${system.version}, ${system.basis.length} capacities.`,
      };

    case 'calculations': {
      const family = system.family;
      if (system.basis.length === 0) {
        return {
          satisfied: true,
          detail: `${SERVICE_FAMILIES[family].label} is sized on scope and sequence rather than capacity, so there is nothing to calculate.`,
        };
      }
      const unformulated = system.basis.filter((derivation) => !derivation.formula);
      return {
        satisfied: unformulated.length === 0,
        detail:
          unformulated.length === 0
            ? `${system.basis.length} capacities, each carrying its formula, inputs and assumptions.`
            : `${unformulated.length} capacities have no formula behind them.`,
      };
    }

    case 'interfaceMatrix': {
      const open = interfaces.filter((entry) => entry.status !== 'ACCEPTED');
      return {
        satisfied: interfaces.length > 0 && open.length === 0,
        detail:
          interfaces.length === 0
            ? 'No interface matrix has been raised for this system.'
            : open.length === 0
              ? `All ${interfaces.length} interfaces accepted.`
              : `${open.length} of ${interfaces.length} still open: ${open.map((entry) => entry.name).join(', ')}.`,
      };
    }

    case 'contractingParty': {
      const appointment = ctx.ledger.list(ctx.projectId, 'SiteServicesAppointment').at(0)?.state as
        | { model?: 'ADVISORY' | 'MANAGEMENT_INTEGRATOR' | 'PRINCIPAL_SERVICE_CONTRACTOR'; contractingEntity?: string }
        | undefined;
      if (!appointment?.model || !appointment.contractingEntity) {
        return { satisfied: false, detail: 'No appointment names a contracting entity for this project.' };
      }
      const profile = profileFor(appointment.model);
      return {
        satisfied: true,
        detail: `${appointment.contractingEntity}, under ${profile.label.split(' — ')[0]}. ${
          profile.mayInstructSupplier
            ? 'ETABLIX may instruct the supplier directly.'
            : 'The customer holds the supplier contract; ETABLIX specifies and recommends and cannot instruct.'
        }`,
      };
    }

    case 'utilities': {
      // The MEP system for the same zone, and whether its own interfaces are
      // closed. A welfare block is not "site ready" because a generator is on
      // order.
      const mep = ctx.ledger
        .list(ctx.projectId, 'ServiceSystem')
        .map((record) => record.state as unknown as ServiceSystem)
        .find((entry) => entry.family === 'TEMPORARY_MEP' && entry.zone === system.zone);
      if (!mep) {
        return {
          satisfied: false,
          detail: `No temporary MEP system is composed for ${system.zone}, so nothing says what supply reaches it.`,
        };
      }
      const mepInterfaces = ctx.ledger
        .list(ctx.projectId, 'ServiceInterface')
        .map((record) => record.state as unknown as ServiceInterface)
        .filter((entry) => entry.systemId === mep.id);
      const open = mepInterfaces.filter((entry) => entry.status !== 'ACCEPTED');
      return {
        satisfied: open.length === 0 && mepInterfaces.length > 0,
        detail:
          open.length === 0
            ? `Temporary MEP composed for ${system.zone} with its interfaces closed.`
            : `Temporary MEP for ${system.zone} still has ${open.length} interfaces open: ${open
                .map((entry) => entry.name)
                .join(', ')}.`,
      };
    }

    default:
      // A derived item with no rule behind it is worse than an attested one: it
      // would pass silently for ever. Fails closed and says why.
      return { satisfied: false, detail: `${itemId} is declared derived and nothing derives it.` };
  }
}

// --- Attesting -----------------------------------------------------------------

/**
 * Record a piece of evidence, with the reference it lives at.
 *
 * `C` on `SITE_SERVICES`. Never a tick: the reference is the certificate
 * number, the drawing revision or the test sheet, and it is what somebody goes
 * and finds when the evidence is challenged.
 *
 * An item that expires is refused without an expiry date. The commonest
 * mobilisation failure is not that evidence was never provided — it is that
 * everything was in place once.
 */
export function attestEvidence(
  ctx: EngineContext,
  input: { systemId: string; gate: string; itemId: string; reference: string; expiresAt?: string },
): GateEvidence {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C');

  const system = systemOf(ctx, input.systemId);
  if (!isGateId(input.gate)) {
    throw new DomainError('MOBILISATION_GATE_UNKNOWN', `${input.gate} is not one of the seven gates`, 404);
  }
  const gate = GATE_BY_ID.get(input.gate)!;
  const item = evidenceFor(gate, system.family).find((entry) => entry.id === input.itemId);
  if (!item) {
    throw new DomainError(
      'MOBILISATION_EVIDENCE_UNKNOWN',
      `${input.itemId} is not evidence ${gate.id} asks for on ${SERVICE_FAMILIES[system.family].label.toLowerCase()}.`,
      404,
    );
  }
  if (item.kind === 'DERIVED') {
    throw new DomainError(
      'MOBILISATION_EVIDENCE_DERIVED',
      `${item.label} is derived from the platform's own records and cannot be attested. ${item.matters}`,
    );
  }
  if (!input.reference?.trim()) {
    throw new DomainError(
      'MOBILISATION_EVIDENCE_UNREFERENCED',
      'Evidence is a reference, not a tick — the certificate number, the drawing revision or the test sheet. A tick proves nothing when it is challenged.',
    );
  }
  if (item.expiryRequired && !isDate(input.expiresAt)) {
    throw new DomainError(
      'MOBILISATION_EVIDENCE_UNDATED',
      `${item.label} expires, so the attestation carries the date it expires on. Everything is in place once; the question is whether it still is.`,
    );
  }
  if (input.expiresAt !== undefined && !isDate(input.expiresAt)) {
    throw new DomainError('MOBILISATION_EVIDENCE_UNDATED', 'An expiry is a date, as YYYY-MM-DD');
  }

  // A second attestation supersedes the first rather than sitting beside it —
  // a renewed certificate replaces the lapsed one, and two live records for one
  // item would leave "is this satisfied" with two answers.
  const existing = evidenceOf(ctx, input.systemId).find(
    (entry) => entry.gate === gate.id && entry.itemId === item.id,
  );

  const at = new Date().toISOString();
  const record: GateEvidence = {
    id: ulid(),
    projectId: ctx.projectId,
    systemId: system.id,
    gate: gate.id,
    itemId: item.id,
    reference: input.reference.trim(),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    attestedBy: ctx.auth.actorId,
    attestedAt: at,
  };

  write(ctx, {
    eventType: 'MOBILISATION_EVIDENCE_ATTESTED',
    entity: { refType: 'GateEvidence', refId: record.id },
    nextState: record,
  });

  if (existing) {
    write(ctx, {
      eventType: 'MOBILISATION_EVIDENCE_WITHDRAWN',
      entity: { refType: 'GateEvidence', refId: existing.id },
      nextState: {
        ...existing,
        withdrawnBy: ctx.auth.actorId,
        withdrawnAt: at,
        withdrawnReason: `Superseded by ${record.reference}`,
      },
    });
  }

  return record;
}

/**
 * Withdraw evidence.
 *
 * `U` on `SITE_SERVICES`. A certificate revoked, a test sheet found to be
 * against the wrong asset. Withdrawing it re-opens the gate it satisfied, which
 * is the point: the gate is calculated, so removing an input changes the answer
 * rather than leaving a passed gate standing on evidence that has gone.
 */
export function withdrawEvidence(
  ctx: EngineContext,
  input: { evidenceId: string; reason: string },
): GateEvidence {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'U');

  const record = ctx.ledger
    .list(ctx.projectId, 'GateEvidence')
    .map((entry) => entry.state as unknown as GateEvidence)
    .find((entry) => entry.id === input.evidenceId);
  if (!record) throw new DomainError('MOBILISATION_EVIDENCE_NOT_FOUND', 'No such evidence on this project', 404);
  if (record.withdrawnAt) return record;
  if (!input.reason?.trim()) {
    throw new DomainError('MOBILISATION_WITHDRAWAL_UNREASONED', 'Say why the evidence no longer stands');
  }

  const updated: GateEvidence = {
    ...record,
    withdrawnBy: ctx.auth.actorId,
    withdrawnAt: new Date().toISOString(),
    withdrawnReason: input.reason.trim(),
  };
  write(ctx, {
    eventType: 'MOBILISATION_EVIDENCE_WITHDRAWN',
    entity: { refType: 'GateEvidence', refId: record.id },
    nextState: updated,
  });
  return updated;
}

// --- The hard stop ---------------------------------------------------------------

/**
 * Record what the supplier says.
 *
 * **And move nothing.** The specification's hard stop: the scheduler cannot
 * mark a package ready because the supplier reports 100%.
 *
 * It is recorded rather than refused, because it is worth arguing with later.
 * The difference between what a supplier said in week six and what the evidence
 * showed is the entire mobilisation dispute, and a platform that discarded the
 * first half could not settle it.
 */
export function declareProgress(
  ctx: EngineContext,
  input: { systemId: string; percent: number; note: string },
): SupplierDeclaration {
  requireModule(ctx.grantedModules, 'ETABLIX');
  // `C`, not `A`. Saying how far along you are is a report; it is not an
  // approval, and the capability it needs should not be the one that passes a
  // gate.
  authorise(ctx, 'SITE_SERVICES', 'C');

  const system = systemOf(ctx, input.systemId);
  if (!Number.isFinite(input.percent) || input.percent < 0 || input.percent > 100) {
    throw new DomainError('SUPPLIER_DECLARATION_INVALID', 'A declaration is a percentage between 0 and 100');
  }
  if (!input.note?.trim()) {
    throw new DomainError(
      'SUPPLIER_DECLARATION_UNEXPLAINED',
      'Say what the figure is against. A bare percentage is the thing this record exists to be checkable against.',
    );
  }

  const record: SupplierDeclaration = {
    id: ulid(),
    projectId: ctx.projectId,
    systemId: system.id,
    percent: input.percent,
    declaredBy: ctx.auth.actorId,
    declaredAt: new Date().toISOString(),
    note: input.note.trim(),
    moves:
      'Nothing. Readiness is calculated from prerequisite evidence and interface tests, and every gate is approved by a ' +
      'named role. This is recorded so the difference between what was declared and what the evidence showed can be read later.',
  };

  write(ctx, {
    eventType: 'SUPPLIER_PROGRESS_DECLARED',
    entity: { refType: 'SupplierDeclaration', refId: record.id },
    nextState: record,
  });

  return record;
}

// --- Approving a gate --------------------------------------------------------------

/**
 * Pass a gate.
 *
 * `A` on `SITE_SERVICES`, **and** one of the roles the gate names. The two are
 * different questions and both have to pass: the capability says this person
 * may approve things in site services, and the gate says which people may
 * approve *this*. A planner holding `A` may not release an area to plant, and
 * may not accept a safe energisation.
 *
 * Refused unless every prior gate has passed and every evidence item is
 * satisfied. That is the dependency network: a gate is not a status somebody
 * sets, it is a conclusion the platform reaches.
 */
export function approveGate(
  ctx: EngineContext,
  input: { systemId: string; gate: string; note: string },
): GateApproval {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'A');

  const system = systemOf(ctx, input.systemId);
  if (!isGateId(input.gate)) {
    throw new DomainError('MOBILISATION_GATE_UNKNOWN', `${input.gate} is not one of the seven gates`, 404);
  }
  const gate = GATE_BY_ID.get(input.gate)!;

  // The authorised role. Checked here rather than left to the capability,
  // because "who may approve this gate" is the specification's own control and
  // the capability matrix cannot express it.
  const held = ctx.auth.roles as Role[];
  if (!gate.approvers.some((role) => held.includes(role))) {
    throw new ForbiddenError(
      `${gate.id} ${gate.name} is approved by ${gate.approvers.join(', ')}. ${gate.approvalCondition} ` +
        `You hold ${held.join(', ') || 'no role'}.` +
        (gate.safetyCritical
          ? ' This is a safety-critical hold point and it fails closed: it is a competent person’s act, not a manager’s.'
          : ''),
      'MOBILISATION_ROLE_REQUIRED',
    );
  }
  if (!input.note?.trim()) {
    throw new DomainError(
      'MOBILISATION_APPROVAL_UNEVIDENCED',
      `Say what satisfies the condition — "${gate.approvalCondition}" Approval with nothing behind it is the signature that gets read out in the inquiry.`,
    );
  }

  const position = mobilisationFor(ctx, system);
  const view = position.gates.find((entry) => entry.id === gate.id)!;

  if (view.status === 'PASSED') return approvalsOf(ctx, system.id).find((entry) => entry.gate === gate.id)!;

  if (view.blockedBy.length > 0) {
    throw new DomainError(
      'MOBILISATION_GATE_BLOCKED',
      `${gate.id} cannot be approved while ${view.blockedBy.join(' and ')} ${
        view.blockedBy.length === 1 ? 'has' : 'have'
      } not passed. Mobilisation is a dependency network, not a percentage.`,
    );
  }

  const outstanding = view.evidence.filter((entry) => !entry.satisfied);
  if (outstanding.length > 0) {
    throw new DomainError(
      'MOBILISATION_EVIDENCE_OUTSTANDING',
      `${gate.id} has ${outstanding.length} of ${view.evidence.length} evidence items outstanding: ${outstanding
        .map((entry) => `${entry.label} — ${entry.detail}`)
        .join('; ')}`,
    );
  }

  const approval: GateApproval = {
    id: ulid(),
    projectId: ctx.projectId,
    systemId: system.id,
    gate: gate.id,
    approvedBy: ctx.auth.actorId,
    roleAtApproval: [...held],
    approvedAt: new Date().toISOString(),
    note: input.note.trim(),
  };

  write(ctx, {
    eventType: gate.id === 'G6' ? 'MOBILISATION_ACCEPTED' : 'MOBILISATION_GATE_APPROVED',
    entity: { refType: 'GateApproval', refId: approval.id },
    nextState: { ...approval, gateName: gate.name, condition: gate.approvalCondition },
  });

  return approval;
}

// --- The tower --------------------------------------------------------------------

export type GateEvidenceView = {
  itemId: string;
  label: string;
  kind: EvidenceKind;
  matters: string;
  satisfied: boolean;
  detail: string;
  /**
   * The attestation's own id, where one exists. Carried so a screen can offer
   * to withdraw a specific piece of evidence: without it the only way to
   * withdraw a certificate found to be against the wrong asset would be to
   * attest something else over the top of it, which is not the same act.
   */
  evidenceId?: string;
  reference?: string;
  expiresAt?: string;
  /** True where evidence exists and has lapsed. Different from never provided. */
  expired?: boolean;
};

export type GateStatus = 'BLOCKED' | 'EVIDENCE_OUTSTANDING' | 'AWAITING_APPROVAL' | 'PASSED';

export type GateView = {
  id: GateId;
  order: number;
  name: string;
  approvalCondition: string;
  approvers: readonly Role[];
  safetyCritical: boolean;
  evidence: GateEvidenceView[];
  satisfied: number;
  total: number;
  /** Prior gates that have not passed. */
  blockedBy: GateId[];
  status: GateStatus;
  approval?: GateApproval;
};

export type SystemMobilisation = {
  systemId: string;
  label: string;
  zone: string;
  family: ServiceFamily;
  gates: GateView[];
  /** The gate the system is actually at. */
  atGate: GateId;
  accepted: boolean;
  /**
   * What the supplier says, alongside what the evidence shows.
   *
   * Both, deliberately. One of them is the record and the other is the claim,
   * and putting them side by side is what makes the difference legible.
   */
  declarations: SupplierDeclaration[];
  /** Evidence satisfied over evidence asked for, across all seven gates. */
  evidencePercent: number;
};

export type MobilisationPosition = {
  systems: SystemMobilisation[];
  /** Every gate definition, so a screen can show what is coming. */
  gates: readonly GateDefinition[];
  /** Evidence in place today and lapsing within the month. */
  expiringSoon: { systemId: string; label: string; itemId: string; reference: string; expiresAt: string }[];
};

function mobilisationFor(ctx: EngineContext, system: ServiceSystem, today?: string): SystemMobilisation {
  const now = today ?? new Date().toISOString().slice(0, 10);
  const attested = evidenceOf(ctx, system.id);
  const approvals = approvalsOf(ctx, system.id);
  const passed = new Set(approvals.map((entry) => entry.gate));

  const gates: GateView[] = GATES.map((gate) => {
    const items = evidenceFor(gate, system.family);
    const evidence: GateEvidenceView[] = items.map((item) => {
      if (item.kind === 'DERIVED') {
        const result = deriveEvidence(ctx, system, item.id);
        return { itemId: item.id, label: item.label, kind: item.kind, matters: item.matters, ...result };
      }
      const record = attested.find((entry) => entry.gate === gate.id && entry.itemId === item.id);
      if (!record) {
        return {
          itemId: item.id,
          label: item.label,
          kind: item.kind,
          matters: item.matters,
          satisfied: false,
          detail: 'Nothing attested.',
        };
      }
      // Expired evidence is not evidence. Reported as expired rather than as
      // missing, because "it lapsed" and "it never existed" are different
      // conversations with different people.
      const expired = record.expiresAt !== undefined && record.expiresAt < now;
      return {
        itemId: item.id,
        label: item.label,
        kind: item.kind,
        matters: item.matters,
        satisfied: !expired,
        detail: expired
          ? `${record.reference} expired ${record.expiresAt}.`
          : `${record.reference}${record.expiresAt ? `, valid to ${record.expiresAt}` : ''}.`,
        evidenceId: record.id,
        reference: record.reference,
        ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
        ...(expired ? { expired: true } : {}),
      };
    });

    const blockedBy = GATES.filter((prior) => prior.order < gate.order && !passed.has(prior.id)).map(
      (prior) => prior.id,
    );
    const satisfied = evidence.filter((entry) => entry.satisfied).length;
    const approval = approvals.find((entry) => entry.gate === gate.id);

    const status: GateStatus = approval
      ? 'PASSED'
      : blockedBy.length > 0
        ? 'BLOCKED'
        : satisfied < evidence.length
          ? 'EVIDENCE_OUTSTANDING'
          : 'AWAITING_APPROVAL';

    return {
      id: gate.id,
      order: gate.order,
      name: gate.name,
      approvalCondition: gate.approvalCondition,
      approvers: gate.approvers,
      safetyCritical: gate.safetyCritical,
      evidence,
      satisfied,
      total: evidence.length,
      blockedBy,
      status,
      ...(approval ? { approval } : {}),
    };
  });

  const totalItems = gates.reduce((sum, gate) => sum + gate.total, 0);
  const totalSatisfied = gates.reduce((sum, gate) => sum + gate.satisfied, 0);

  return {
    systemId: system.id,
    label: system.label,
    zone: system.zone,
    family: system.family,
    gates,
    atGate: (gates.find((gate) => gate.status !== 'PASSED')?.id ?? 'G6') as GateId,
    accepted: passed.has('G6'),
    declarations: ctx.ledger
      .list(ctx.projectId, 'SupplierDeclaration')
      .map((record) => record.state as unknown as SupplierDeclaration)
      .filter((entry) => entry.systemId === system.id)
      .sort((a, b) => b.declaredAt.localeCompare(a.declaredAt)),
    evidencePercent: totalItems > 0 ? Math.round((totalSatisfied / totalItems) * 1000) / 10 : 0,
  };
}

export function mobilisationPosition(ctx: EngineContext, today?: string): MobilisationPosition {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'R');

  const now = today ?? new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.parse(now) + 30 * 86_400_000).toISOString().slice(0, 10);

  const systems = ctx.ledger
    .list(ctx.projectId, 'ServiceSystem')
    .map((record) => record.state as unknown as ServiceSystem);

  return {
    systems: systems.map((system) => mobilisationFor(ctx, system, today)),
    gates: GATES,
    // The register §7.3 calls evidence-expiry monitoring, at the one place the
    // evidence actually lives. A certificate that lapses next Tuesday is a
    // problem this week, not next.
    expiringSoon: systems.flatMap((system) =>
      evidenceOf(ctx, system.id)
        .filter((entry) => entry.expiresAt !== undefined && entry.expiresAt >= now && entry.expiresAt <= horizon)
        .map((entry) => ({
          systemId: system.id,
          label: `${system.label} (${system.zone})`,
          itemId: entry.itemId,
          reference: entry.reference,
          expiresAt: entry.expiresAt!,
        })),
    ),
  };
}
