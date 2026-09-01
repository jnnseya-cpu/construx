import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { authorise, write, type EngineContext } from '../../engines/context.ts';
import { requireModule } from '../../identity/modules.ts';
import { SERVICE_FAMILIES, type ServiceFamily } from './brief.ts';
import type { ServiceSystem } from './composer.ts';

/**
 * §9 — live operations and service assurance.
 *
 * **The loop is five steps and the fourth is the one everybody skips.** Sense,
 * interpret, act, verify, learn. Every helpdesk system in the industry does
 * sense and act; most do a version of interpret; almost none *verify*, because
 * verification means refusing to close a ticket somebody has already told you
 * is finished. A service desk whose closure evidence is "closed by supplier" is
 * a service desk that measures how quickly people press buttons.
 *
 * So an `Event` here cannot be closed without the evidence its defect type
 * demands, and what that evidence is is decided by the platform rather than by
 * the person closing it.
 *
 * **A KPI without an anti-gaming control is a target, and targets get hit.**
 * §9.2's second column is the load-bearing one. Availability measured in
 * service minutes is trivially improved by declaring an outage planned after it
 * happens; response measured to acknowledgement is improved by acknowledging
 * everything instantly and doing nothing; cleaning quality assessed by the
 * cleaner is not assessed. Each of the seven families here carries its control,
 * and the control is enforced rather than described.
 *
 * ## What this is not
 *
 * It is not CONSTRUX's `domain/qualitycontrol.ts` or its incident register.
 * Those are about the permanent works and about people getting hurt. This is
 * the service position: whether the welfare block had hot water this morning,
 * whether the bus ran, whether the gate cleared 120 people an hour. The two
 * meet at P1, where a sewage escape is both — and a P1 here says so and tells
 * the reader to raise it there too, rather than quietly becoming a second
 * incident register.
 */

// --- §9.1 Severity ------------------------------------------------------------------

export const SEVERITY_IDS = ['P1', 'P2', 'P3', 'P4'] as const;
export type Severity = (typeof SEVERITY_IDS)[number];

export type SeverityDefinition = {
  id: Severity;
  label: string;
  /** §9.1's operational definition, in the words it is argued in. */
  definition: string;
  /** What the platform does, not what somebody is asked to remember to do. */
  behaviour: readonly string[];
  /** Minutes from raise to acknowledgement. Zero means the alarm is the ack. */
  acknowledgeWithinMinutes: number;
  /**
   * Whether a temporary control has to be recorded before the event can be
   * closed. A P1 closed with no interim measure is a P1 nobody controlled.
   */
  requiresTemporaryControl: boolean;
  /** True where the clock cannot be paused at all, however good the reason. */
  clockUnpausable: boolean;
};

export const SEVERITIES: readonly SeverityDefinition[] = [
  {
    id: 'P1',
    label: 'Critical',
    definition:
      'Immediate threat to life, security, environmental compliance or project continuity — fire system unavailable, sewage escape, total welfare loss.',
    behaviour: [
      'Immediate multi-channel alarm',
      'Incident command opened',
      'Duty manager acknowledgement',
      'Temporary control recorded before anything is closed',
      'Executive escalation',
      'Event timeline preserved',
    ],
    acknowledgeWithinMinutes: 0,
    requiresTemporaryControl: true,
    // The one severity whose clock never pauses. A P1 with a paused clock is a
    // P1 that stopped being treated as one, and the pause is always agreed in
    // the room where the pressure is.
    clockUnpausable: true,
  },
  {
    id: 'P2',
    label: 'Major',
    definition:
      'Material capacity or KPI failure affecting a zone or a shift, with a workaround possible.',
    behaviour: [
      'Ownership within fifteen minutes',
      'Recovery ETA required',
      'Supplier escalation',
      'Service-credit clock running',
      'Customer impact notice',
    ],
    acknowledgeWithinMinutes: 15,
    requiresTemporaryControl: false,
    clockUnpausable: false,
  },
  {
    id: 'P3',
    label: 'Routine',
    definition: 'Local defect with no immediate compliance or capacity threat.',
    behaviour: ['Planned response within SLA', 'Batch routing', 'Evidence-based closure'],
    acknowledgeWithinMinutes: 240,
    requiresTemporaryControl: false,
    clockUnpausable: false,
  },
  {
    id: 'P4',
    label: 'Request',
    definition: 'A move, add or change, a consumable, or an information request.',
    behaviour: [
      'Entitlement and scope validated',
      'Fulfilled, or routed to change control',
      'Never closed as a defect, because it was never one',
    ],
    acknowledgeWithinMinutes: 480,
    requiresTemporaryControl: false,
    clockUnpausable: false,
  },
];

const SEVERITY_BY_ID = new Map(SEVERITIES.map((entry) => [entry.id, entry]));

export function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && SEVERITY_BY_ID.has(value as Severity);
}

// --- §9.1 The five-step loop ---------------------------------------------------------

export const LOOP_STEPS = [
  {
    id: 'SENSE',
    label: 'Sense',
    detail:
      'Helpdesk tickets, inspections, asset and utility telemetry, access counts, occupancy, delivery events, cleaning records, transport status, weather and supplier attendance.',
  },
  {
    id: 'INTERPRET',
    label: 'Interpret',
    detail:
      'Actual service against the KPI, the demand basis, the statutory or contract frequency, asset condition and what the programme needs next.',
  },
  {
    id: 'ACT',
    label: 'Act',
    detail:
      'Work order raised and routed, part or asset reserved, affected zone notified, response timer invoked, temporary mitigation and supplier escalation proposed.',
  },
  {
    id: 'VERIFY',
    label: 'Verify',
    detail:
      'Closure evidence appropriate to the defect type — a photograph, a meter reading, a signature, a test result, a user confirmation or a reinspection.',
  },
  {
    id: 'LEARN',
    label: 'Learn',
    detail:
      'Recurring-failure pattern, predicted failure risk, supplier score and the recommended change to planned maintenance or to the demand basis.',
  },
] as const;

export type LoopStep = (typeof LOOP_STEPS)[number]['id'];

/**
 * What closes an event, by what went wrong.
 *
 * §9.1's verify step, made specific. "Closure evidence appropriate to defect
 * type" is only a rule if the type decides the evidence, and the whole value of
 * deciding it here is that the person closing the ticket does not get to pick
 * the easiest one.
 */
export const CLOSURE_KINDS = ['PHOTO', 'METER_READING', 'SIGNATURE', 'TEST_RESULT', 'USER_CONFIRMATION', 'REINSPECTION'] as const;
export type ClosureKind = (typeof CLOSURE_KINDS)[number];

export type DefectType = {
  id: string;
  label: string;
  family: ServiceFamily;
  /** Every one of these is required before the event closes. */
  closure: readonly ClosureKind[];
  /** Why this evidence and not something cheaper. */
  matters: string;
};

export const DEFECT_TYPES: readonly DefectType[] = [
  {
    id: 'WELFARE_UNAVAILABLE',
    label: 'Welfare facility unavailable',
    family: 'WELFARE_ACCOMMODATION',
    closure: ['PHOTO', 'USER_CONFIRMATION'],
    matters:
      'A WC signed off as working by the firm that was meant to be maintaining it is the commonest false closure on any site. Somebody who uses it says it works.',
  },
  {
    id: 'HOT_WATER_LOSS',
    label: 'Hot water loss',
    family: 'WELFARE_ACCOMMODATION',
    closure: ['TEST_RESULT', 'USER_CONFIRMATION'],
    matters:
      'Temperature is a number, and legionella control is a statutory duty measured in numbers. A photograph of a tap proves nothing about what came out of it.',
  },
  {
    id: 'ROOM_DEFECT',
    label: 'Accommodation room defect',
    family: 'WELFARE_ACCOMMODATION',
    closure: ['PHOTO', 'REINSPECTION'],
    matters:
      'A blocked room is revenue and a bed somebody needs. The photograph shows the state and the reinspection shows somebody went back.',
  },
  {
    id: 'CLEANING_FAILURE',
    label: 'Cleaning standard not met',
    family: 'CLEANING_FM',
    closure: ['PHOTO', 'REINSPECTION'],
    matters:
      'Cleaning is the one service where the supplier marking their own homework is standard practice. A reinspection by somebody else is the control.',
  },
  {
    id: 'WASTE_UNCOLLECTED',
    label: 'Waste not collected',
    family: 'CLEANING_FM',
    closure: ['PHOTO', 'SIGNATURE'],
    matters:
      'A waste transfer note is a legal document with a signature on it. Without one the waste was not transferred, whatever the photograph shows.',
  },
  {
    id: 'POWER_INTERRUPTION',
    label: 'Power interruption',
    family: 'TEMPORARY_MEP',
    closure: ['METER_READING', 'TEST_RESULT'],
    matters:
      'A supply restored and not tested is a supply that trips again on the next load step, and the meter says when it actually came back.',
  },
  {
    id: 'WATER_QUALITY',
    label: 'Water quality alarm',
    family: 'TEMPORARY_MEP',
    closure: ['TEST_RESULT', 'REINSPECTION'],
    matters:
      'A sample result, not an opinion. This is the failure that reaches a coroner rather than a commercial meeting.',
  },
  {
    id: 'DISCHARGE_BREACH',
    label: 'Discharge or environmental breach',
    family: 'TEMPORARY_MEP',
    closure: ['PHOTO', 'TEST_RESULT', 'SIGNATURE'],
    matters:
      'A regulator will ask for all three, and the file assembled afterwards is never as good as the file assembled at the time.',
  },
  {
    id: 'ACCESS_DENIED',
    label: 'Access control failure',
    family: 'SECURITY_LOGISTICS',
    closure: ['TEST_RESULT', 'USER_CONFIRMATION'],
    matters:
      'A gate that reads a card in a test and not in the rain is a gate that has not been fixed. Somebody has to get through it.',
  },
  {
    id: 'TRANSPORT_MISSED',
    label: 'Transport service missed',
    family: 'SECURITY_LOGISTICS',
    closure: ['USER_CONFIRMATION'],
    matters:
      'The people left standing at the pickup are the only reliable evidence that the bus did not come.',
  },
  {
    id: 'COMPOUND_DEFECT',
    label: 'Compound or hardstanding defect',
    family: 'TEMPORARY_INFRASTRUCTURE',
    closure: ['PHOTO', 'REINSPECTION'],
    matters:
      'A pothole filled with the wrong material is a pothole again in a fortnight, and only somebody going back finds out.',
  },
  {
    id: 'GROUND_CONDITION',
    label: 'Ground or drainage condition',
    family: 'ENABLING_CIVILS',
    closure: ['PHOTO', 'TEST_RESULT'],
    matters:
      'Standing water on a haul route is a photograph; whether the drain runs is a test. The two are different questions and both get asked.',
  },
];

const DEFECT_BY_ID = new Map(DEFECT_TYPES.map((entry) => [entry.id, entry]));

// --- Records ------------------------------------------------------------------------

export type EventStatus = 'OPEN' | 'ACKNOWLEDGED' | 'ATTENDED' | 'TEMPORARILY_RESTORED' | 'CLOSED';

export type ClosureEvidence = {
  kind: ClosureKind;
  /** The reference it lives at. Never a tick, for the same reason as §8. */
  reference: string;
  recordedBy: string;
  recordedAt: string;
};

export type ClockPause = {
  from: string;
  to?: string;
  reason: string;
  /** Named customer approval. §9.2's response-family anti-gaming control. */
  approvedBy: string;
};

export type ServiceEvent = {
  id: string;
  projectId: string;
  reference: string;
  systemId: string;
  zone: string;
  family: ServiceFamily;
  defectType: string;
  severity: Severity;
  summary: string;
  /** Where it came from. The sense step, recorded rather than assumed. */
  source: string;
  status: EventStatus;
  raisedAt: string;
  raisedBy: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  attendedAt?: string;
  temporaryControl?: string;
  temporarilyRestoredAt?: string;
  closedAt?: string;
  closedBy?: string;
  evidence: ClosureEvidence[];
  pauses: ClockPause[];
  /** P4 only: what it was routed to, where it was not simply fulfilled. */
  routedToChange?: string;
};

export type ServiceObservationWindow = {
  /** Minutes the service was required to be available in the period. */
  requiredMinutes: number;
  /** Minutes it actually was. Never greater than required. */
  availableMinutes: number;
  /**
   * Minutes running at reduced capacity. Tracked separately and never counted
   * as available: §9.2's availability control in one field.
   */
  degradedMinutes: number;
};

export type ServicePeriod = {
  id: string;
  projectId: string;
  systemId: string;
  from: string;
  to: string;
  window: ServiceObservationWindow;
  /**
   * Outages the customer agreed to *before* they happened. An exclusion agreed
   * afterwards is a failure with a note on it.
   */
  plannedExclusions: { from: string; to: string; reason: string; approvedAt: string; approvedBy: string }[];
  recordedBy: string;
  recordedAt: string;
};

// --- §9.2 The KPI contract -----------------------------------------------------------

export type KpiFamilyId =
  | 'AVAILABILITY'
  | 'RESPONSE_RESTORATION'
  | 'CLEANING_QUALITY'
  | 'ACCOMMODATION'
  | 'SECURITY_ACCESS'
  | 'TRANSPORT_LOGISTICS'
  | 'UTILITIES';

export type KpiFamily = {
  id: KpiFamilyId;
  label: string;
  /** How it is measured, from §9.2. */
  method: string;
  /** The control that stops the measure being gamed. */
  antiGaming: string;
  /**
   * Whether the platform enforces the control or only reports it. Stated so a
   * screen cannot imply enforcement the code does not do.
   */
  enforcement: 'ENFORCED' | 'REPORTED';
};

export const KPI_FAMILIES: readonly KpiFamily[] = [
  {
    id: 'AVAILABILITY',
    label: 'Availability',
    method: 'Available service minutes divided by required service minutes, by asset, system and zone.',
    antiGaming:
      'A planned exclusion counts only if it was approved before the event. Degraded capacity is tracked separately and never counted as available.',
    enforcement: 'ENFORCED',
  },
  {
    id: 'RESPONSE_RESTORATION',
    label: 'Response and restoration',
    method:
      'Event timestamp to acknowledgement, to attendance, to temporary restoration, to permanent close.',
    antiGaming: 'A clock pause requires a reason and a named customer approval. A P1 clock cannot be paused at all.',
    enforcement: 'ENFORCED',
  },
  {
    id: 'CLEANING_QUALITY',
    label: 'Cleaning quality',
    method: 'Scheduled tasks, plus a risk-weighted inspection sample and the repeat-failure rate.',
    antiGaming: 'A supplier self-check cannot be the sole acceptance evidence.',
    enforcement: 'ENFORCED',
  },
  {
    id: 'ACCOMMODATION',
    label: 'Accommodation',
    method:
      'Room readiness, occupancy, defect response, linen and laundry, complaints and lost room-nights.',
    antiGaming: 'A blocked room requires a reason, a photograph and a restoration target.',
    enforcement: 'ENFORCED',
  },
  {
    id: 'SECURITY_ACCESS',
    label: 'Security and access',
    method: 'Gate throughput, denied access, credential SLA, post coverage and incident closeout.',
    antiGaming: 'Roster and access events reconcile against invoiced staffing.',
    enforcement: 'REPORTED',
  },
  {
    id: 'TRANSPORT_LOGISTICS',
    label: 'Transport and logistics',
    method: 'On-time departure and arrival, capacity, no-show, delivery slot adherence and turn time.',
    antiGaming: 'Booking or positional evidence is preferred over a manual declaration, and which was used is shown.',
    enforcement: 'REPORTED',
  },
  {
    id: 'UTILITIES',
    label: 'Utilities',
    method: 'Continuity, water quality, consumption, fuel, load, discharge and alarm response.',
    antiGaming: 'Meter quality and status are shown, and an estimated reading is labelled as estimated.',
    enforcement: 'ENFORCED',
  },
];

const KPI_BY_ID = new Map(KPI_FAMILIES.map((entry) => [entry.id, entry]));

/** Which KPI family each service family is actually measured under. */
export const FAMILY_KPIS: Record<ServiceFamily, readonly KpiFamilyId[]> = {
  TEMPORARY_INFRASTRUCTURE: ['AVAILABILITY', 'RESPONSE_RESTORATION'],
  ENABLING_CIVILS: ['AVAILABILITY', 'RESPONSE_RESTORATION'],
  TEMPORARY_MEP: ['AVAILABILITY', 'RESPONSE_RESTORATION', 'UTILITIES'],
  WELFARE_ACCOMMODATION: ['AVAILABILITY', 'RESPONSE_RESTORATION', 'ACCOMMODATION', 'CLEANING_QUALITY'],
  CLEANING_FM: ['CLEANING_QUALITY', 'RESPONSE_RESTORATION'],
  SECURITY_LOGISTICS: ['SECURITY_ACCESS', 'TRANSPORT_LOGISTICS', 'RESPONSE_RESTORATION'],
  PROCUREMENT_CONTROL: [],
};

// --- Reading ------------------------------------------------------------------------

function systemsOf(ctx: EngineContext): ServiceSystem[] {
  return ctx.ledger.list(ctx.projectId, 'ServiceSystem').map((record) => record.state as unknown as ServiceSystem);
}

function systemOf(ctx: EngineContext, systemId: string): ServiceSystem {
  const found = systemsOf(ctx).find((entry) => entry.id === systemId);
  if (!found) {
    throw new DomainError(
      'SERVICE_SYSTEM_NOT_FOUND',
      'No such composed system on this project. An event against nothing is an event nobody can size, price or learn from.',
      404,
    );
  }
  return found;
}

function eventsOf(ctx: EngineContext): ServiceEvent[] {
  return ctx.ledger.list(ctx.projectId, 'ServiceEvent').map((record) => record.state as unknown as ServiceEvent);
}

function eventOf(ctx: EngineContext, eventId: string): ServiceEvent {
  const found = eventsOf(ctx).find((entry) => entry.id === eventId);
  if (!found) throw new DomainError('SERVICE_EVENT_NOT_FOUND', 'No such event on this project', 404);
  return found;
}

function periodsOf(ctx: EngineContext): ServicePeriod[] {
  return ctx.ledger.list(ctx.projectId, 'ServicePeriod').map((record) => record.state as unknown as ServicePeriod);
}

function minutesBetween(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

// --- Sense: raise an event ------------------------------------------------------------

export function raiseEvent(
  ctx: EngineContext,
  input: {
    systemId: string;
    defectType: string;
    severity: string;
    summary: string;
    source: string;
    zone?: string;
  },
): ServiceEvent {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C');

  const system = systemOf(ctx, input.systemId);
  const defect = DEFECT_BY_ID.get(input.defectType);
  if (!defect) {
    throw new DomainError('SERVICE_DEFECT_UNKNOWN', `${input.defectType} is not a defect type this platform knows`, 404);
  }
  if (defect.family !== system.family) {
    throw new DomainError(
      'SERVICE_DEFECT_WRONG_FAMILY',
      `${defect.label} belongs to ${SERVICE_FAMILIES[defect.family].label.toLowerCase()}, and ${system.label} is ${SERVICE_FAMILIES[system.family].label.toLowerCase()}. A defect filed against the wrong service is a defect the wrong supplier answers for.`,
    );
  }
  if (!isSeverity(input.severity)) {
    throw new DomainError('SERVICE_SEVERITY_UNKNOWN', `${input.severity} is not one of P1 to P4`, 404);
  }
  if (!input.summary?.trim()) {
    throw new DomainError('SERVICE_EVENT_UNDESCRIBED', 'Say what happened. "Fault" is not a description of a fault.');
  }
  if (!input.source?.trim()) {
    throw new DomainError(
      'SERVICE_EVENT_UNSOURCED',
      'Say where this came from — the helpdesk call, the inspection, the meter, the roster. An event with no source cannot be reconciled against anything.',
    );
  }

  const sequence = eventsOf(ctx).length + 1;
  const record: ServiceEvent = {
    id: ulid(),
    projectId: ctx.projectId,
    reference: `SVE-${String(sequence).padStart(4, '0')}`,
    systemId: system.id,
    zone: input.zone?.trim() || system.zone,
    family: system.family,
    defectType: defect.id,
    severity: input.severity,
    summary: input.summary.trim(),
    source: input.source.trim(),
    status: 'OPEN',
    raisedAt: new Date().toISOString(),
    raisedBy: ctx.auth.actorId,
    evidence: [],
    pauses: [],
  };

  write(ctx, {
    eventType: 'SERVICE_EVENT_RAISED',
    entity: { refType: 'ServiceEvent', refId: record.id },
    nextState: record,
  });
  return record;
}

// --- Act: acknowledge, attend, restore ------------------------------------------------

export function progressEvent(
  ctx: EngineContext,
  input: { eventId: string; to: string; note?: string },
): ServiceEvent {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'U');

  const record = eventOf(ctx, input.eventId);
  if (record.status === 'CLOSED') {
    throw new DomainError(
      'SERVICE_EVENT_CLOSED',
      `${record.reference} is closed. Re-opening is a new event with a reference to this one, so the response clock on the original stays what it was.`,
    );
  }

  const at = new Date().toISOString();
  let updated: ServiceEvent;

  switch (input.to) {
    case 'ACKNOWLEDGED':
      if (record.acknowledgedAt) return record;
      updated = { ...record, status: 'ACKNOWLEDGED', acknowledgedAt: at, acknowledgedBy: ctx.auth.actorId };
      break;

    case 'ATTENDED':
      if (!record.acknowledgedAt) {
        throw new DomainError(
          'SERVICE_EVENT_UNACKNOWLEDGED',
          `${record.reference} has not been acknowledged. Attendance recorded before acknowledgement makes the response clock read zero, which is how a response measure stops measuring anything.`,
        );
      }
      if (record.attendedAt) return record;
      updated = { ...record, status: 'ATTENDED', attendedAt: at };
      break;

    case 'TEMPORARILY_RESTORED': {
      if (!input.note?.trim()) {
        throw new DomainError(
          'SERVICE_CONTROL_UNSTATED',
          'Say what the temporary control actually is. "Mitigated" is not a mitigation, and the next shift has to know what they are relying on.',
        );
      }
      updated = {
        ...record,
        status: 'TEMPORARILY_RESTORED',
        temporaryControl: input.note.trim(),
        temporarilyRestoredAt: at,
      };
      break;
    }

    default:
      throw new DomainError(
        'SERVICE_EVENT_STEP_UNKNOWN',
        `${input.to} is not a step. An event is acknowledged, attended, temporarily restored and then closed on evidence.`,
        404,
      );
  }

  write(ctx, {
    eventType: 'SERVICE_EVENT_PROGRESSED',
    entity: { refType: 'ServiceEvent', refId: record.id },
    nextState: updated,
  });
  return updated;
}

/**
 * Pause the response clock.
 *
 * §9.2's response control: a pause needs a reason *and* a named customer
 * approval, because the clock is what the service credit is calculated from and
 * an unapproved pause is a supplier adjusting its own score.
 *
 * A P1 clock cannot be paused at all. That is not an oversight to be configured
 * around: the pause on a critical event is always agreed in the room where the
 * pressure is, and a system that accepted it would be recording the pressure
 * rather than the response.
 */
export function pauseClock(
  ctx: EngineContext,
  input: { eventId: string; reason: string; approvedBy: string },
): ServiceEvent {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'U');

  const record = eventOf(ctx, input.eventId);
  const severity = SEVERITY_BY_ID.get(record.severity)!;
  if (severity.clockUnpausable) {
    throw new DomainError(
      'SERVICE_CLOCK_UNPAUSABLE',
      `${record.reference} is a ${severity.id} ${severity.label.toLowerCase()}. Its clock does not pause: the pause on a critical event is always agreed in the room where the pressure is, and recording it would measure the pressure rather than the response.`,
    );
  }
  if (!input.reason?.trim()) {
    throw new DomainError('SERVICE_PAUSE_UNREASONED', 'Say why the clock is stopping.');
  }
  if (!input.approvedBy?.trim()) {
    throw new DomainError(
      'SERVICE_PAUSE_UNAPPROVED',
      'Name the customer who agreed the pause. A pause the customer did not approve is a supplier adjusting its own score.',
    );
  }
  if (record.pauses.some((entry) => !entry.to)) {
    throw new DomainError('SERVICE_CLOCK_ALREADY_PAUSED', `${record.reference} is already paused.`);
  }

  const updated: ServiceEvent = {
    ...record,
    pauses: [
      ...record.pauses,
      { from: new Date().toISOString(), reason: input.reason.trim(), approvedBy: input.approvedBy.trim() },
    ],
  };
  write(ctx, {
    eventType: 'SERVICE_CLOCK_PAUSED',
    entity: { refType: 'ServiceEvent', refId: record.id },
    nextState: updated,
  });
  return updated;
}

export function resumeClock(ctx: EngineContext, input: { eventId: string }): ServiceEvent {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'U');

  const record = eventOf(ctx, input.eventId);
  const open = record.pauses.findIndex((entry) => !entry.to);
  if (open === -1) return record;

  const pauses = record.pauses.map((entry, index) =>
    index === open ? { ...entry, to: new Date().toISOString() } : entry,
  );
  const updated: ServiceEvent = { ...record, pauses };
  write(ctx, {
    eventType: 'SERVICE_CLOCK_RESUMED',
    entity: { refType: 'ServiceEvent', refId: record.id },
    nextState: updated,
  });
  return updated;
}

// --- Verify: the step everybody skips --------------------------------------------------

export function recordClosureEvidence(
  ctx: EngineContext,
  input: { eventId: string; kind: string; reference: string },
): ServiceEvent {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C');

  const record = eventOf(ctx, input.eventId);
  const defect = DEFECT_BY_ID.get(record.defectType)!;
  if (!(CLOSURE_KINDS as readonly string[]).includes(input.kind)) {
    throw new DomainError('SERVICE_EVIDENCE_KIND_UNKNOWN', `${input.kind} is not a kind of closure evidence`, 404);
  }
  if (!defect.closure.includes(input.kind as ClosureKind)) {
    throw new DomainError(
      'SERVICE_EVIDENCE_IRRELEVANT',
      `${defect.label} closes on ${defect.closure.join(' and ').toLowerCase().replaceAll('_', ' ')}. ${defect.matters}`,
    );
  }
  if (!input.reference?.trim()) {
    throw new DomainError(
      'SERVICE_EVIDENCE_UNREFERENCED',
      'Evidence is a reference — the photograph, the reading, the sheet. A tick proves nothing when the closure is challenged.',
    );
  }

  const evidence: ClosureEvidence = {
    kind: input.kind as ClosureKind,
    reference: input.reference.trim(),
    recordedBy: ctx.auth.actorId,
    recordedAt: new Date().toISOString(),
  };
  // A second piece of the same kind supersedes the first, so "is this
  // satisfied" has one answer rather than two.
  const updated: ServiceEvent = {
    ...record,
    evidence: [...record.evidence.filter((entry) => entry.kind !== evidence.kind), evidence],
  };
  write(ctx, {
    eventType: 'SERVICE_EVIDENCE_RECORDED',
    entity: { refType: 'ServiceEvent', refId: record.id },
    nextState: updated,
  });
  return updated;
}

/**
 * Close an event.
 *
 * Refused unless every piece of evidence the defect type demands is on the
 * record, and — for a P1 — unless a temporary control was recorded. A P1 closed
 * with no interim measure is a P1 nobody controlled, and the closure is the
 * only moment at which that is still cheap to notice.
 */
export function closeEvent(ctx: EngineContext, input: { eventId: string; note: string }): ServiceEvent {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'A');

  const record = eventOf(ctx, input.eventId);
  if (record.status === 'CLOSED') return record;

  const defect = DEFECT_BY_ID.get(record.defectType)!;
  const severity = SEVERITY_BY_ID.get(record.severity)!;

  if (!input.note?.trim()) {
    throw new DomainError('SERVICE_CLOSURE_UNEXPLAINED', 'Say what was actually done.');
  }
  if (severity.requiresTemporaryControl && !record.temporaryControl) {
    throw new DomainError(
      'SERVICE_CONTROL_ABSENT',
      `${record.reference} is a ${severity.id} and no temporary control was ever recorded. A critical event closed with no interim measure is a critical event nobody controlled, and this is the last moment that is cheap to notice.`,
    );
  }

  const missing = defect.closure.filter((kind) => !record.evidence.some((entry) => entry.kind === kind));
  if (missing.length > 0) {
    throw new DomainError(
      'SERVICE_CLOSURE_UNEVIDENCED',
      `${record.reference} closes on ${defect.closure.length} pieces of evidence and ${missing.length} ${
        missing.length === 1 ? 'is' : 'are'
      } missing: ${missing.join(', ').toLowerCase().replaceAll('_', ' ')}. ${defect.matters}`,
    );
  }
  if (record.pauses.some((entry) => !entry.to)) {
    throw new DomainError(
      'SERVICE_CLOCK_PAUSED',
      `${record.reference} still has a paused clock. Closing it paused would leave the response time reading whatever it read when somebody stopped it.`,
    );
  }

  const updated: ServiceEvent = {
    ...record,
    status: 'CLOSED',
    closedAt: new Date().toISOString(),
    closedBy: ctx.auth.actorId,
  };
  write(ctx, {
    eventType: 'SERVICE_EVENT_CLOSED',
    entity: { refType: 'ServiceEvent', refId: record.id },
    nextState: { ...updated, closureNote: input.note.trim() },
  });
  return updated;
}

/**
 * Route a P4 to change control.
 *
 * §9.1's fourth row, and the reason it is a separate act: a move-add-change
 * fulfilled as if it were a defect is scope delivered for nothing. It is not a
 * failure of the service and it does not belong in the availability figure.
 */
export function routeToChange(
  ctx: EngineContext,
  input: { eventId: string; reason: string },
): ServiceEvent {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'U');

  const record = eventOf(ctx, input.eventId);
  if (record.severity !== 'P4') {
    throw new DomainError(
      'SERVICE_ROUTING_NOT_A_REQUEST',
      `${record.reference} is a ${record.severity}, which is a failure of the service rather than a request for more of it. A defect routed to change control is a defect nobody fixed.`,
    );
  }
  if (!input.reason?.trim()) {
    throw new DomainError('SERVICE_ROUTING_UNREASONED', 'Say what makes this a change rather than an entitlement.');
  }

  const updated: ServiceEvent = { ...record, routedToChange: input.reason.trim() };
  write(ctx, {
    eventType: 'SERVICE_EVENT_ROUTED',
    entity: { refType: 'ServiceEvent', refId: record.id },
    nextState: updated,
  });
  return updated;
}

// --- Availability -----------------------------------------------------------------------

/**
 * Record a service period.
 *
 * The availability measure, and its anti-gaming control in the refusal: a
 * planned exclusion whose approval is dated after the outage started is not a
 * planned exclusion, it is a failure with a note on it. Degraded minutes are a
 * separate field and are never counted as available.
 */
export function recordPeriod(
  ctx: EngineContext,
  input: {
    systemId: string;
    from: string;
    to: string;
    requiredMinutes: number;
    availableMinutes: number;
    degradedMinutes?: number;
    plannedExclusions?: { from: string; to: string; reason: string; approvedAt: string; approvedBy: string }[];
  },
): ServicePeriod {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C');

  const system = systemOf(ctx, input.systemId);
  if (!isTimestamp(input.from) || !isTimestamp(input.to) || Date.parse(input.to) <= Date.parse(input.from)) {
    throw new DomainError('SERVICE_PERIOD_INVALID', 'A period runs from a date to a later one.');
  }
  if (!(input.requiredMinutes > 0)) {
    throw new DomainError(
      'SERVICE_PERIOD_UNREQUIRED',
      'Say how many minutes the service was required for. Availability against a requirement of zero is a percentage of nothing.',
    );
  }
  if (input.availableMinutes < 0 || input.availableMinutes > input.requiredMinutes) {
    throw new DomainError(
      'SERVICE_PERIOD_IMPOSSIBLE',
      `Available minutes cannot exceed the ${input.requiredMinutes} required. A service cannot be up for longer than it was needed.`,
    );
  }
  const degraded = input.degradedMinutes ?? 0;
  if (degraded < 0 || degraded > input.availableMinutes) {
    throw new DomainError(
      'SERVICE_PERIOD_DEGRADED_IMPOSSIBLE',
      'Degraded minutes are a subset of the available ones — the service was up and not fully up. More degraded than available is not a state anything can be in.',
    );
  }

  for (const exclusion of input.plannedExclusions ?? []) {
    if (!isTimestamp(exclusion.from) || !isTimestamp(exclusion.to) || !isTimestamp(exclusion.approvedAt)) {
      throw new DomainError('SERVICE_EXCLUSION_UNDATED', 'A planned exclusion carries its window and when it was approved.');
    }
    if (!exclusion.approvedBy?.trim() || !exclusion.reason?.trim()) {
      throw new DomainError('SERVICE_EXCLUSION_UNAPPROVED', 'A planned exclusion names who approved it and why.');
    }
    // §9.2's availability control, enforced rather than described.
    if (Date.parse(exclusion.approvedAt) > Date.parse(exclusion.from)) {
      throw new DomainError(
        'SERVICE_EXCLUSION_RETROSPECTIVE',
        `That exclusion was approved on ${exclusion.approvedAt.slice(0, 10)} for an outage that began on ${exclusion.from.slice(0, 10)}. An exclusion approved after the event is not a planned exclusion — it is a failure with a note on it, and counting it as planned is the commonest way an availability figure stops meaning anything.`,
      );
    }
  }

  const record: ServicePeriod = {
    id: ulid(),
    projectId: ctx.projectId,
    systemId: system.id,
    from: input.from,
    to: input.to,
    window: {
      requiredMinutes: input.requiredMinutes,
      availableMinutes: input.availableMinutes,
      degradedMinutes: degraded,
    },
    plannedExclusions: input.plannedExclusions ?? [],
    recordedBy: ctx.auth.actorId,
    recordedAt: new Date().toISOString(),
  };
  write(ctx, {
    eventType: 'SERVICE_PERIOD_RECORDED',
    entity: { refType: 'ServicePeriod', refId: record.id },
    nextState: record,
  });
  return record;
}

// --- The position -----------------------------------------------------------------------

export type EventView = ServiceEvent & {
  defectLabel: string;
  severityLabel: string;
  behaviour: readonly string[];
  /** Every kind the defect demands, and whether it is on the record. */
  closure: { kind: ClosureKind; satisfied: boolean; reference?: string }[];
  /** Minutes to acknowledgement, net of approved pauses. */
  minutesToAcknowledge?: number;
  minutesToAttend?: number;
  minutesOpen: number;
  /** True where acknowledgement took longer than the severity allows. */
  acknowledgementBreached: boolean;
  pausedMinutes: number;
  blocking: string[];
};

export type AvailabilityView = {
  systemId: string;
  label: string;
  zone: string;
  requiredMinutes: number;
  availableMinutes: number;
  degradedMinutes: number;
  excludedMinutes: number;
  /** Available over required, with approved exclusions removed from both. */
  availabilityPercent: number;
  /**
   * The same figure with every exclusion ignored. Shown beside it because the
   * gap between the two is the size of the argument about what was planned.
   */
  rawPercent: number;
  periods: number;
};

export type OperationsPosition = {
  events: EventView[];
  open: number;
  severities: readonly SeverityDefinition[];
  steps: typeof LOOP_STEPS;
  kpis: readonly KpiFamily[];
  defectTypes: readonly DefectType[];
  availability: AvailabilityView[];
  /** §9.1's learn step: what has failed more than once, and where. */
  patterns: { defectType: string; label: string; zone: string; occurrences: number; statement: string }[];
  /** Which KPI families apply to what is actually composed here. */
  measuredUnder: { family: ServiceFamily; label: string; kpis: KpiFamily[] }[];
};

function viewOf(record: ServiceEvent, now: number): EventView {
  const defect = DEFECT_BY_ID.get(record.defectType)!;
  const severity = SEVERITY_BY_ID.get(record.severity)!;

  const pausedMinutes = record.pauses.reduce(
    (sum, entry) => sum + minutesBetween(entry.from, entry.to ?? new Date(now).toISOString()),
    0,
  );
  const minutesToAcknowledge = record.acknowledgedAt
    ? Math.max(0, minutesBetween(record.raisedAt, record.acknowledgedAt) - pausedMinutes)
    : undefined;
  const minutesToAttend = record.attendedAt
    ? Math.max(0, minutesBetween(record.raisedAt, record.attendedAt) - pausedMinutes)
    : undefined;

  const closure = defect.closure.map((kind) => {
    const held = record.evidence.find((entry) => entry.kind === kind);
    return { kind, satisfied: Boolean(held), ...(held ? { reference: held.reference } : {}) };
  });

  const blocking: string[] = [];
  if (record.status !== 'CLOSED') {
    for (const entry of closure) {
      if (!entry.satisfied) blocking.push(`${entry.kind.toLowerCase().replaceAll('_', ' ')} not recorded`);
    }
    if (severity.requiresTemporaryControl && !record.temporaryControl) {
      blocking.push('no temporary control recorded');
    }
    if (record.pauses.some((entry) => !entry.to)) blocking.push('clock still paused');
  }

  return {
    ...record,
    defectLabel: defect.label,
    severityLabel: `${severity.id} ${severity.label}`,
    behaviour: severity.behaviour,
    closure,
    ...(minutesToAcknowledge === undefined ? {} : { minutesToAcknowledge }),
    ...(minutesToAttend === undefined ? {} : { minutesToAttend }),
    minutesOpen: minutesBetween(record.raisedAt, record.closedAt ?? new Date(now).toISOString()),
    // An unacknowledged event past its window is breached now, not once
    // somebody gets round to acknowledging it.
    acknowledgementBreached:
      severity.acknowledgeWithinMinutes > 0 &&
      (minutesToAcknowledge ?? minutesBetween(record.raisedAt, new Date(now).toISOString()) - pausedMinutes) >
        severity.acknowledgeWithinMinutes,
    pausedMinutes,
    blocking,
  };
}

export function operationsPosition(ctx: EngineContext, today?: string): OperationsPosition {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'R');

  const now = today ? Date.parse(today) : Date.now();
  const systems = systemsOf(ctx);
  const events = eventsOf(ctx).map((record) => viewOf(record, now));
  const periods = periodsOf(ctx);

  const availability: AvailabilityView[] = systems.map((system) => {
    const mine = periods.filter((entry) => entry.systemId === system.id);
    const requiredMinutes = mine.reduce((sum, entry) => sum + entry.window.requiredMinutes, 0);
    const availableMinutes = mine.reduce((sum, entry) => sum + entry.window.availableMinutes, 0);
    const degradedMinutes = mine.reduce((sum, entry) => sum + entry.window.degradedMinutes, 0);
    const excludedMinutes = mine.reduce(
      (sum, entry) => sum + entry.plannedExclusions.reduce((inner, x) => inner + minutesBetween(x.from, x.to), 0),
      0,
    );
    const net = Math.max(0, requiredMinutes - excludedMinutes);
    return {
      systemId: system.id,
      label: system.label,
      zone: system.zone,
      requiredMinutes,
      availableMinutes,
      degradedMinutes,
      excludedMinutes,
      availabilityPercent: net > 0 ? Math.round((Math.min(availableMinutes, net) / net) * 1000) / 10 : 0,
      rawPercent: requiredMinutes > 0 ? Math.round((availableMinutes / requiredMinutes) * 1000) / 10 : 0,
      periods: mine.length,
    };
  });

  // The learn step. A defect that has happened twice in one zone is a pattern
  // and a defect that has happened once is a defect, and the difference is what
  // decides whether the answer is a repair or a change to the regime.
  const counted = new Map<string, { defectType: string; zone: string; occurrences: number }>();
  for (const entry of events) {
    const key = `${entry.defectType}@${entry.zone}`;
    const held = counted.get(key) ?? { defectType: entry.defectType, zone: entry.zone, occurrences: 0 };
    held.occurrences += 1;
    counted.set(key, held);
  }
  const patterns = [...counted.values()]
    .filter((entry) => entry.occurrences > 1)
    .map((entry) => {
      const defect = DEFECT_BY_ID.get(entry.defectType)!;
      return {
        defectType: entry.defectType,
        label: defect.label,
        zone: entry.zone,
        occurrences: entry.occurrences,
        statement: `${defect.label} has happened ${entry.occurrences} times in ${entry.zone}. Repeated failure of one thing in one place is a question about the regime or the asset, not about the last repair.`,
      };
    })
    .sort((a, b) => b.occurrences - a.occurrences);

  const families = systems
    .map((entry) => entry.family)
    .filter((family, index, list) => list.indexOf(family) === index);

  return {
    events: events.sort((a, b) => b.raisedAt.localeCompare(a.raisedAt)),
    open: events.filter((entry) => entry.status !== 'CLOSED').length,
    severities: SEVERITIES,
    steps: LOOP_STEPS,
    kpis: KPI_FAMILIES,
    defectTypes: DEFECT_TYPES,
    availability,
    patterns,
    measuredUnder: families.map((family) => ({
      family,
      label: SERVICE_FAMILIES[family].label,
      kpis: FAMILY_KPIS[family].map((id) => KPI_BY_ID.get(id)!),
    })),
  };
}
