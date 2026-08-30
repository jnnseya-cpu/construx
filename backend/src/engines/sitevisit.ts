import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from './context.ts';
import { raiseConstraint, type ConstraintCategory } from './planning.ts';
import type { DocumentBlock } from '../export/exporter.ts';

/**
 * The site visit, and what it obliges for the rest of the job.
 *
 * A site visit today produces a document nobody opens again. Somebody walks the
 * site, photographs eleven things, writes them into a Word template, emails it,
 * and eighteen months later a crane is erected over a boundary nobody agreed to
 * oversail. The information was not missing. It was recorded and then it stopped
 * being anybody's problem.
 *
 * So this module is not a report generator with a register attached. **Every
 * finding is an obligation with a life**, and the life runs from the walk to
 * handover:
 *
 *   walk → finding → what it obliges → who owns it → when it is discharged
 *
 * ---
 *
 * **A finding that obliges nothing is a note.** Every finding declares what it
 * does to the job — it prices something, it sequences something, it needs a
 * permission, it is a hazard, or it changes the design — and a finding that
 * claims none of those is refused. That single rule is what stops the register
 * filling with "the site is muddy".
 *
 * **A finding seen on site needs a photograph.** Not one read out of a planning
 * consent, and not one the client's agent told you over the phone — those are
 * recorded with their source instead. But an assertion about a physical
 * condition, with no image, is the thing that gets argued about later, and the
 * argument is unwinnable. The basis of every finding is on the record.
 *
 * **A finding that constrains an activity raises a real constraint.** Not a
 * second constraint register living in a site-visit module: `raiseConstraint`
 * in the planning engine, so the lookahead already refuses to commit that
 * activity and the constraint appears in the PPC trend beside every other one.
 * Zero re-entry means the walk feeds the programme, not a parallel list.
 *
 * **A permission has a lead time, and lead time is a programme fact.** A
 * highway licence quoted at eight weeks against work starting in three is not a
 * risk, it is already late — by five weeks, today, before anybody has applied.
 * That arithmetic is the single most valuable thing in this module and it is
 * why a permit finding carries a lead time and the date the work it enables
 * starts, rather than a due date somebody guessed.
 *
 * **Closure is evidenced, and the serious ones are not self-certified.** A
 * finding that needed a permission or named a hazard cannot be closed by the
 * person who raised it, and needs approval authority rather than write
 * authority: you cannot mark your own overhead-line goalposts as installed.
 * Everything else can be closed by whoever did it, because a two-person
 * contractor is a real customer and gating every closure behind a second person
 * would make the register something to avoid.
 *
 * ---
 *
 * **What this deliberately does not do.** It does not draw a logistics plan. A
 * site logistics drawing is a drawing, and producing a picture that looked like
 * one without the geometry behind it would be worse than producing nothing. It
 * records the elements, their stated dimensions and their distances, and it
 * runs the checks that arithmetic can settle — the ones that are missed most
 * often and cost the most when they are.
 */

// --- Vocabulary --------------------------------------------------------------

/**
 * Why the walk happened.
 *
 * There is no `BID` purpose, deliberately. A bid-stage walk happens before a
 * project exists and belongs with tender intake, which is tenant-scoped; a
 * purpose nobody can record would be a choice that fails on submission.
 */
export const VISIT_PURPOSE = ['PRE_CONSTRUCTION', 'MOBILISATION', 'PROGRESS', 'PRE_HANDOVER'] as const;
export type VisitPurpose = (typeof VISIT_PURPOSE)[number];

/** What the finding is about. Site conditions, not the state of the work. */
export const FINDING_CATEGORY = [
  'ACCESS_AND_EGRESS',
  'TRAFFIC_AND_HIGHWAYS',
  'GROUND_CONDITIONS',
  'EXISTING_SERVICES',
  'OVERHEAD_SERVICES',
  'BOUNDARIES_AND_NEIGHBOURS',
  'ENVIRONMENT_AND_ECOLOGY',
  'EXISTING_STRUCTURES',
  'SITE_ESTABLISHMENT',
  'SECURITY',
  'UTILITIES_AND_CONNECTIONS',
  'WORKING_HOURS_AND_NOISE',
] as const;
export type FindingCategory = (typeof FINDING_CATEGORY)[number];

/**
 * What the finding obliges.
 *
 * The whole register turns on this. A finding with no consequence is a
 * description of the weather.
 */
export const FINDING_CONSEQUENCE = ['PRICES', 'SEQUENCES', 'PERMITS', 'HAZARDS', 'DESIGNS'] as const;
export type FindingConsequence = (typeof FINDING_CONSEQUENCE)[number];

/** How it is known. An assertion about a physical thing has to be photographed. */
export const FINDING_BASIS = ['OBSERVED', 'DOCUMENT', 'ADVISED'] as const;
export type FindingBasis = (typeof FINDING_BASIS)[number];

/**
 * When the obligation is discharged.
 *
 * This is what carries the walk through to handover. A temporary access that
 * has to be reinstated closes at `HANDOVER` and stays visible for two years;
 * a hoarding closes at `MOBILISATION` and is gone in a fortnight.
 */
export const CLOSES_BY = ['MOBILISATION', 'CONSTRUCTION', 'COMPLETION', 'HANDOVER'] as const;
export type ClosesBy = (typeof CLOSES_BY)[number];

/** Consequences serious enough that closing one is an approval, not an update. */
const APPROVAL_CONSEQUENCES: readonly FindingConsequence[] = ['PERMITS', 'HAZARDS'];

/**
 * The planning-engine constraint category a site finding maps to.
 *
 * Site categories are about the ground; constraint categories are about what
 * stops an activity. The mapping is stated once here rather than asked of the
 * person raising the finding, who has already answered the question in a
 * different vocabulary.
 */
const CONSTRAINT_CATEGORY: Record<FindingCategory, ConstraintCategory> = {
  ACCESS_AND_EGRESS: 'ACCESS',
  TRAFFIC_AND_HIGHWAYS: 'ACCESS',
  GROUND_CONDITIONS: 'INFORMATION',
  EXISTING_SERVICES: 'PERMIT',
  OVERHEAD_SERVICES: 'PERMIT',
  BOUNDARIES_AND_NEIGHBOURS: 'APPROVAL',
  ENVIRONMENT_AND_ECOLOGY: 'PERMIT',
  EXISTING_STRUCTURES: 'INFORMATION',
  SITE_ESTABLISHMENT: 'ACCESS',
  SECURITY: 'ACCESS',
  UTILITIES_AND_CONNECTIONS: 'PERMIT',
  WORKING_HOURS_AND_NOISE: 'APPROVAL',
};

// --- Permits -----------------------------------------------------------------

/**
 * A permission the finding makes necessary.
 *
 * `leadTimeDays` is what the authority itself quotes, and `requiredBy` is when
 * the work it unlocks is planned to start. Those two facts and today's date are
 * enough to answer the only question that matters — is this already late — and
 * neither of them is a due date somebody estimated.
 */
export type PermitRequirement = {
  name: string;
  /** Who grants it. A permission with no grantor is a hope. */
  authority: string;
  /** Calendar days, as authorities quote them ("allow eight weeks"). */
  leadTimeDays: number;
  /** When the work this unlocks is planned to start. */
  requiredBy: string;
  appliedOn?: string;
  grantedOn?: string;
};

export type PermitStatus = 'GRANTED' | 'APPLIED' | 'NOT_APPLIED';

export type PermitPosition = {
  name: string;
  authority: string;
  status: PermitStatus;
  /** The last day an application could go in and still arrive in time. */
  applyBy: string;
  requiredBy: string;
  /** Days past the last safe application date. Zero when it is not late. */
  daysLate: number;
  note: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/**
 * Where a permission stands, in days rather than in adjectives.
 *
 * A granted permission is finished whatever the dates say. An application that
 * has gone in is late only once the work it unlocks has started without it —
 * the authority may still beat its own quoted lead time, and calling that late
 * on the day it was submitted would be crying wolf.
 */
export function permitPosition(permit: PermitRequirement, today: string): PermitPosition {
  const applyBy = addDays(permit.requiredBy, -permit.leadTimeDays);
  const base = { name: permit.name, authority: permit.authority, applyBy, requiredBy: permit.requiredBy };

  if (permit.grantedOn) {
    return { ...base, status: 'GRANTED', daysLate: 0, note: `Granted ${permit.grantedOn}` };
  }

  if (permit.appliedOn) {
    const late = Math.max(0, daysBetween(permit.requiredBy, today));
    return {
      ...base,
      status: 'APPLIED',
      daysLate: late,
      note:
        late > 0
          ? `Applied ${permit.appliedOn} and still not granted, ${late} day${late === 1 ? '' : 's'} after the work needed it`
          : `Applied ${permit.appliedOn}; ${permit.authority} quote ${permit.leadTimeDays} days`,
    };
  }

  const late = Math.max(0, daysBetween(applyBy, today));
  return {
    ...base,
    status: 'NOT_APPLIED',
    daysLate: late,
    note:
      late > 0
        ? `Not applied for. At ${permit.leadTimeDays} days from ${permit.authority}, the application needed to be in by ${applyBy} — that is ${late} day${late === 1 ? '' : 's'} ago, so the ${permit.requiredBy} start is already gone.`
        : `Not applied for. The application has to be in by ${applyBy} to hold the ${permit.requiredBy} start.`,
  };
}

// --- The visit ---------------------------------------------------------------

export function recordVisit(
  ctx: EngineContext,
  input: {
    purpose: VisitPurpose;
    /** The day it was walked, not the day it was typed up. */
    visitedOn: string;
    /** Everybody who was there, so the record says who saw it. */
    attendees: string[];
    weather?: string;
    notes?: string;
  },
): { visitId: string; reference: string } {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (input.attendees.filter((a) => a.trim()).length === 0) {
    throw new DomainError(
      'ATTENDEES_REQUIRED',
      'A site visit needs the people who were there. An unattributed walk cannot be relied on eighteen months later.',
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.visitedOn)) {
    throw new DomainError('VISIT_DATE_INVALID', 'Give the date walked as YYYY-MM-DD');
  }

  const sequence = ctx.ledger.list(ctx.projectId, 'SiteVisit').length + 1;
  const reference = `SV-${String(sequence).padStart(3, '0')}`;
  const visitId = ulid();

  write(ctx, {
    eventType: 'SITE_VISIT_RECORDED',
    entity: { refType: 'SiteVisit', refId: visitId },
    nextState: {
      id: visitId,
      projectId: ctx.projectId,
      reference,
      purpose: input.purpose,
      visitedOn: input.visitedOn,
      attendees: input.attendees.map((a) => a.trim()).filter(Boolean),
      weather: input.weather,
      notes: input.notes,
      recordedAt: new Date().toISOString(),
      recordedBy: ctx.auth.actorId,
    },
  });

  return { visitId, reference };
}

// --- Findings ----------------------------------------------------------------

export type FindingInput = {
  category: FindingCategory;
  /** What was found. Ten characters is not a finding. */
  description: string;
  /** Where on site. A finding with no location cannot be gone back to. */
  location: string;
  basis: FindingBasis;
  /** Where a DOCUMENT or ADVISED finding came from. */
  source?: string;
  consequences: FindingConsequence[];
  closesBy: ClosesBy;
  /** Who carries it. Not the person who spotted it. */
  owner: string;
  /** Required for an OBSERVED finding: the photograph. */
  evidenceHash?: string;
  permit?: PermitRequirement;
  /** The activity this constrains, where it constrains one. */
  taskId?: string;
  /** What it is expected to cost, where the finding prices something. */
  pricedNote?: string;
};

export function raiseFinding(
  ctx: EngineContext,
  visitId: string,
  input: FindingInput,
  now = new Date(),
): { findingId: string; reference: string; constraintReference?: string } {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'C', { lifecyclePhase: currentPhase(ctx) });

  const visit = ctx.ledger.require({ refType: 'SiteVisit', refId: visitId });

  if (input.description.trim().length < 15) {
    throw new DomainError(
      'FINDING_INSUBSTANTIAL',
      'Say what was actually found. "Poor access" is not a finding; "gate is 3.1m wide, an artic will not turn in" is.',
    );
  }
  if (!input.location.trim()) {
    throw new DomainError('LOCATION_REQUIRED', 'A finding with no location cannot be gone back to and checked');
  }
  if (!input.owner.trim()) {
    throw new DomainError('OWNER_REQUIRED', 'A finding needs somebody who carries it, or it is a remark');
  }

  // The rule the register lives or dies by.
  if (input.consequences.length === 0) {
    throw new DomainError(
      'CONSEQUENCE_REQUIRED',
      'Say what this obliges — it prices something, sequences something, needs a permission, is a hazard, or changes the design. ' +
        'A finding that obliges none of those is a note, and notes are what fill a register until nobody reads it.',
    );
  }

  // An assertion about a physical condition, with no image, is the thing that
  // gets argued about later — and the argument is unwinnable.
  if (input.basis === 'OBSERVED' && !input.evidenceHash) {
    throw new DomainError(
      'PHOTOGRAPH_REQUIRED',
      'A finding observed on site needs a photograph. If it was read from a document or somebody told you, record it as that instead and name the source.',
    );
  }
  if (input.basis !== 'OBSERVED' && !input.source?.trim()) {
    throw new DomainError(
      'SOURCE_REQUIRED',
      `A ${input.basis.toLowerCase()} finding has to name where it came from — the document, or who said it.`,
    );
  }

  if (input.consequences.includes('PERMITS') && !input.permit) {
    throw new DomainError(
      'PERMIT_REQUIRED',
      'A finding that needs a permission has to name it, who grants it, how long they take and when the work it unlocks starts. ' +
        'Without the lead time nothing can tell you it is already late.',
    );
  }
  if (input.permit && input.permit.leadTimeDays <= 0) {
    throw new DomainError('LEAD_TIME_INVALID', 'A permission with no lead time is not a permission, it is a formality');
  }

  const evidenceRefs = input.evidenceHash
    ? [
        registerEvidence(ctx, {
          type: 'SITE_VISIT_PHOTOGRAPH',
          hash: input.evidenceHash,
          description: `${input.category} at ${input.location}`,
          linkedEntities: [{ refType: 'SiteVisit', refId: visitId }],
        }),
      ]
    : [];

  const sequence = ctx.ledger.list(ctx.projectId, 'SiteFinding').length + 1;
  const reference = `SF-${String(sequence).padStart(4, '0')}`;
  const findingId = ulid();

  // Zero re-entry: a finding that constrains a named activity becomes a real
  // constraint in the planning engine, so the lookahead refuses to commit that
  // activity and it appears in the PPC trend beside every other constraint.
  // A second constraints log living in a site-visit module would be exactly
  // the duplication this platform exists to avoid.
  let constraintReference: string | undefined;
  let constraintId: string | undefined;
  const sequencesWork = input.consequences.includes('SEQUENCES') || input.consequences.includes('PERMITS');
  if (input.taskId && sequencesWork) {
    const raised = raiseConstraint(
      ctx,
      {
        taskId: input.taskId,
        category: CONSTRAINT_CATEGORY[input.category],
        description: `${reference}: ${input.description.trim()}`,
        owner: input.owner.trim(),
        // The date the work needs it by, where a permission says so; otherwise
        // the stage the obligation is discharged at is all the finding knows,
        // and the visit date is a lower bound rather than a guess.
        needByDate: input.permit?.requiredBy ?? String(visit.state.visitedOn),
      },
      now,
    );
    constraintReference = raised.reference;
    constraintId = raised.constraintId;
  }

  write(ctx, {
    eventType: 'SITE_FINDING_RAISED',
    entity: { refType: 'SiteFinding', refId: findingId },
    nextState: {
      id: findingId,
      projectId: ctx.projectId,
      reference,
      visitId,
      visitReference: visit.state.reference,
      category: input.category,
      description: input.description.trim(),
      location: input.location.trim(),
      basis: input.basis,
      source: input.source?.trim(),
      consequences: input.consequences,
      closesBy: input.closesBy,
      owner: input.owner.trim(),
      permit: input.permit,
      pricedNote: input.pricedNote,
      taskId: input.taskId,
      constraintId,
      constraintReference,
      evidenceHash: input.evidenceHash,
      status: 'OPEN',
      raisedAt: now.toISOString(),
      raisedBy: ctx.auth.actorId,
    },
    evidenceRefs,
  });

  return { findingId, reference, constraintReference };
}

/**
 * Discharge the obligation, with what discharged it.
 *
 * A finding that needed a permission or named a hazard is closed under approval
 * authority and never by the person who raised it: you cannot certify your own
 * goalposts. Everything else can be closed by whoever did the work, because a
 * two-person contractor is a real customer and a second signature on a hoarding
 * line would only teach people to route around the register.
 */
export function closeFinding(
  ctx: EngineContext,
  findingId: string,
  input: { discharge: string; evidenceHash?: string },
  now = new Date(),
): { reference: string; daysOpen: number } {
  const finding = ctx.ledger.require({ refType: 'SiteFinding', refId: findingId });
  const consequences = (finding.state.consequences as FindingConsequence[]) ?? [];
  const serious = consequences.some((c) => APPROVAL_CONSEQUENCES.includes(c));

  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', serious ? 'A' : 'U', { lifecyclePhase: currentPhase(ctx) });

  if (finding.state.status === 'CLOSED') {
    throw new DomainError('FINDING_ALREADY_CLOSED', `${String(finding.state.reference)} is already closed`);
  }
  if (input.discharge.trim().length < 10) {
    throw new DomainError(
      'DISCHARGE_REQUIRED',
      'Say what actually discharged it. "Done" closes the line and answers nothing when it is asked about later.',
    );
  }
  if (serious && finding.state.raisedBy === ctx.auth.actorId) {
    throw new DomainError(
      'SELF_CLOSURE_REFUSED',
      `${String(finding.state.reference)} needed a permission or named a hazard, so the person who raised it cannot also close it. ` +
        'Somebody else has to confirm it was actually done.',
    );
  }
  if (serious && !input.evidenceHash) {
    throw new DomainError(
      'CLOSURE_EVIDENCE_REQUIRED',
      `${String(finding.state.reference)} needed a permission or named a hazard. Closing it needs the licence, the certificate or a photograph of the thing in place.`,
    );
  }

  const evidenceRefs = input.evidenceHash
    ? [
        registerEvidence(ctx, {
          type: 'SITE_FINDING_CLOSEOUT',
          hash: input.evidenceHash,
          description: `${String(finding.state.reference)} discharged`,
          linkedEntities: [{ refType: 'SiteFinding', refId: findingId }],
        }),
      ]
    : [];

  const daysOpen = Math.max(0, daysBetween(String(finding.state.raisedAt).slice(0, 10), now.toISOString().slice(0, 10)));

  write(ctx, {
    eventType: 'SITE_FINDING_DISCHARGED',
    entity: { refType: 'SiteFinding', refId: findingId },
    nextState: {
      ...finding.state,
      status: 'CLOSED',
      discharge: input.discharge.trim(),
      closureEvidenceHash: input.evidenceHash,
      closedBy: ctx.auth.actorId,
      closedAt: now.toISOString(),
      daysOpen,
    },
    evidenceRefs,
  });

  return { reference: String(finding.state.reference), daysOpen };
}

// --- Logistics ---------------------------------------------------------------

/**
 * Everything that can appear on a site layout.
 *
 * Extended rather than duplicated. The SiteCapture specification arrives with
 * its own twenty-code zone taxonomy that overlaps these eleven about nine ways —
 * its `Z-OFF` is `SITE_OFFICE`, its `Z-GTE` is `GATE` — and standing a second
 * vocabulary next to this one would give the platform two names for one thing
 * and no way to reconcile a plan drawn under each. So the codes it genuinely
 * adds are added here, and there is still one list.
 *
 * The additions are the ones a capture sees and a compound-only list has no
 * word for: what the ground is doing, what is already in it, and what may not
 * be built on.
 */
export const LOGISTICS_ELEMENT = [
  'GATE',
  'HOARDING',
  'WELFARE',
  'SITE_OFFICE',
  'STORAGE',
  'LAYDOWN',
  'PARKING',
  'WHEEL_WASH',
  'WASTE',
  'TEMPORARY_SUPPLY',
  'PEDESTRIAN_ROUTE',
  // --- from the capture taxonomy ---
  'HAUL_ROAD',
  'SPOIL_HEAP',
  'EXCAVATION',
  'CRANE_POSITION',
  'SCAFFOLD',
  'EXCLUSION_ZONE',
  'MUSTER_POINT',
  'EXISTING_SERVICES',
  'STANDING_WATER',
  'VEGETATION',
  'PERMANENT_WORKS',
  'TEMPORARY_WORKS',
  'DELIVERY_HOLDING',
  'FIRE_POINT',
] as const;
export type LogisticsElement = (typeof LOGISTICS_ELEMENT)[number];

export type CranePosition = {
  reference: string;
  type: 'TOWER' | 'MOBILE' | 'CRAWLER';
  /** Working radius of the jib. */
  radiusMetres: number;
  /** Shortest distance from the slew centre to the site boundary. */
  distanceToBoundaryMetres: number;
  tipHeightMetres: number;
  /**
   * The nearest overhead line and the exclusion the network operator stated.
   * The operator's own figure, not a guess from the voltage — asking the DNO is
   * how this is done, and a platform that invented a clearance would be worse
   * than one that holds the number somebody was told.
   */
  overhead?: { distanceMetres: number; exclusionMetres: number };
};

export type AccessRoute = {
  reference: string;
  description: string;
  maxVehicleLengthMetres?: number;
  maxHeightMetres?: number;
  maxWeightTonnes?: number;
  /** Hours deliveries may arrive, where the consent restricts them. */
  deliveryWindow?: { from: string; to: string };
};

export type LargestDelivery = {
  description: string;
  lengthMetres: number;
  heightMetres: number;
  weightTonnes: number;
};

export type LogisticsWarning = {
  severity: 'CRITICAL' | 'MAJOR';
  subject: string;
  detail: string;
};

export type LogisticsPlanInput = {
  elements: Array<{ type: LogisticsElement; reference: string; description: string }>;
  cranes?: CranePosition[];
  routes?: AccessRoute[];
  largestDelivery?: LargestDelivery;
  notes?: string;
};

/**
 * The checks arithmetic can settle.
 *
 * Every one of these is a thing that is missed often and costs a great deal
 * when it is. None of them needs judgement — they are geometry against a stated
 * limit — which is exactly why leaving them to somebody's memory on a wet
 * Tuesday is how they get missed.
 */
export function logisticsWarnings(plan: LogisticsPlanInput): LogisticsWarning[] {
  const warnings: LogisticsWarning[] = [];

  for (const crane of plan.cranes ?? []) {
    if (crane.radiusMetres > crane.distanceToBoundaryMetres) {
      const over = (crane.radiusMetres - crane.distanceToBoundaryMetres).toFixed(1);
      warnings.push({
        severity: 'CRITICAL',
        subject: `${crane.reference} oversails the boundary`,
        detail:
          `A ${crane.radiusMetres}m radius against a boundary ${crane.distanceToBoundaryMetres}m away puts the jib ${over}m ` +
          'over the adjoining land. That needs an oversail agreement from the adjoining owner before the crane is erected, ' +
          'and it is a negotiation with somebody who has no reason to hurry.',
      });
    }

    if (crane.overhead) {
      const { distanceMetres, exclusionMetres } = crane.overhead;
      if (crane.radiusMetres >= distanceMetres) {
        warnings.push({
          severity: 'CRITICAL',
          subject: `${crane.reference} can reach the overhead line`,
          detail:
            `The jib reaches ${crane.radiusMetres}m and the line is ${distanceMetres}m away, so the crane can be slewed into it. ` +
            `The network operator's exclusion is ${exclusionMetres}m. This needs a physical restraint on the slew, a diversion, or a different position.`,
        });
      } else if (distanceMetres <= exclusionMetres) {
        warnings.push({
          severity: 'CRITICAL',
          subject: `${crane.reference} stands inside the exclusion zone`,
          detail:
            `The crane is ${distanceMetres}m from the line and the network operator's exclusion is ${exclusionMetres}m. ` +
            'Nothing may be positioned inside it without the operator agreeing the arrangement.',
        });
      }
    }
  }

  const delivery = plan.largestDelivery;
  if (delivery) {
    for (const route of plan.routes ?? []) {
      const breaches: string[] = [];
      if (route.maxVehicleLengthMetres !== undefined && delivery.lengthMetres > route.maxVehicleLengthMetres) {
        breaches.push(`${delivery.lengthMetres}m long against a ${route.maxVehicleLengthMetres}m limit`);
      }
      if (route.maxHeightMetres !== undefined && delivery.heightMetres > route.maxHeightMetres) {
        breaches.push(`${delivery.heightMetres}m high against a ${route.maxHeightMetres}m limit`);
      }
      if (route.maxWeightTonnes !== undefined && delivery.weightTonnes > route.maxWeightTonnes) {
        breaches.push(`${delivery.weightTonnes}t against a ${route.maxWeightTonnes}t limit`);
      }
      if (breaches.length > 0) {
        warnings.push({
          severity: 'CRITICAL',
          subject: `${delivery.description} cannot use ${route.reference}`,
          detail: `${route.description}: ${breaches.join('; ')}. The delivery either takes another route or does not arrive.`,
        });
      }
    }
  }

  const types = new Set((plan.elements ?? []).map((e) => e.type));
  if (!types.has('WELFARE')) {
    warnings.push({
      severity: 'MAJOR',
      subject: 'No welfare on the plan',
      detail:
        'Schedule 2 of CDM 2015 requires welfare from the first day anybody works on site, not from the week the compound is finished. ' +
        'A plan with no welfare on it is a plan that has not been thought through.',
    });
  }
  if (!types.has('GATE') && (plan.routes ?? []).length === 0) {
    warnings.push({
      severity: 'MAJOR',
      subject: 'No way in',
      detail: 'The plan names neither a gate nor an access route, so nothing on it says how anything gets to the site.',
    });
  }

  return warnings;
}

/**
 * Set the site logistics plan.
 *
 * One current plan per project, superseding rather than accumulating — a site
 * with two logistics plans has none. Every version stays in the ledger, which
 * is where "what did we agree in March" is answered from.
 */
export function setLogisticsPlan(
  ctx: EngineContext,
  input: LogisticsPlanInput,
): { planId: string; version: number; warnings: LogisticsWarning[] } {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'C', { lifecyclePhase: currentPhase(ctx) });

  if ((input.elements ?? []).length === 0) {
    throw new DomainError('ELEMENTS_REQUIRED', 'A logistics plan with nothing on it is not a plan');
  }

  const existing = ctx.ledger.list(ctx.projectId, 'SiteLogisticsPlan')[0];
  const planId = existing ? String(existing.state.id) : ulid();
  const version = existing ? Number(existing.state.version) + 1 : 1;
  const warnings = logisticsWarnings(input);

  write(ctx, {
    eventType: 'LOGISTICS_PLAN_SET',
    entity: { refType: 'SiteLogisticsPlan', refId: planId },
    nextState: {
      id: planId,
      projectId: ctx.projectId,
      version,
      elements: input.elements,
      cranes: input.cranes ?? [],
      routes: input.routes ?? [],
      largestDelivery: input.largestDelivery,
      notes: input.notes,
      // Recorded as well as returned: the warnings standing when the plan was
      // set are a fact about that version, and recomputing them later against a
      // changed plan would answer a different question.
      warnings,
      setAt: new Date().toISOString(),
      setBy: ctx.auth.actorId,
    },
  });

  return { planId, version, warnings };
}

// --- The position ------------------------------------------------------------

export type FindingRow = {
  /** The id, because the console has to be able to address it. */
  findingId: string;
  reference: string;
  category: FindingCategory;
  description: string;
  location: string;
  basis: FindingBasis;
  consequences: FindingConsequence[];
  closesBy: ClosesBy;
  owner: string;
  status: 'OPEN' | 'CLOSED';
  hasPhotograph: boolean;
  constraintReference?: string;
  permit?: PermitPosition;
  daysOpen?: number;
};

export type SitePosition = {
  visits: Array<{
    visitId: string;
    reference: string;
    purpose: VisitPurpose;
    visitedOn: string;
    attendees: string[];
    findings: number;
  }>;
  findings: FindingRow[];
  open: number;
  closed: number;
  byCategory: Array<{ category: FindingCategory; open: number; total: number }>;
  byConsequence: Array<{ consequence: FindingConsequence; open: number; total: number }>;
  /** What is still owed at each stage — the walk carried through to handover. */
  byStage: Array<{ closesBy: ClosesBy; open: number; total: number }>;
  permits: PermitPosition[];
  latePermits: PermitPosition[];
  logistics: { version: number; warnings: LogisticsWarning[] } | null;
  /** Open findings that were never going to close before handover. */
  handoverBlockers: FindingRow[];
  photographs: number;
  summary: string;
};

export function sitePosition(ctx: EngineContext, options: { today?: string } = {}): SitePosition {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'R');

  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const visitRecords = ctx.ledger.list(ctx.projectId, 'SiteVisit');
  const findingRecords = ctx.ledger.list(ctx.projectId, 'SiteFinding');

  const findings: FindingRow[] = findingRecords.map((record) => {
    const state = record.state;
    const permit = state.permit as PermitRequirement | undefined;
    return {
      findingId: String(state.id),
      reference: String(state.reference),
      category: state.category as FindingCategory,
      description: String(state.description),
      location: String(state.location),
      basis: state.basis as FindingBasis,
      consequences: (state.consequences as FindingConsequence[]) ?? [],
      closesBy: state.closesBy as ClosesBy,
      owner: String(state.owner),
      status: state.status === 'CLOSED' ? 'CLOSED' : 'OPEN',
      hasPhotograph: Boolean(state.evidenceHash),
      constraintReference: state.constraintReference as string | undefined,
      permit: permit ? permitPosition(permit, today) : undefined,
      daysOpen: state.daysOpen as number | undefined,
    };
  });

  const open = findings.filter((f) => f.status === 'OPEN');
  const countBy = <T extends string>(values: readonly T[], pick: (f: FindingRow) => T[] | T) =>
    values
      .map((value) => {
        const matches = findings.filter((f) => {
          const held = pick(f);
          return Array.isArray(held) ? held.includes(value) : held === value;
        });
        return { value, open: matches.filter((f) => f.status === 'OPEN').length, total: matches.length };
      })
      .filter((row) => row.total > 0);

  const permits = findings.filter((f) => f.permit).map((f) => f.permit!);
  // A permission on a discharged finding is finished whatever its dates say.
  const livePermits = findings.filter((f) => f.status === 'OPEN' && f.permit).map((f) => f.permit!);
  const latePermits = livePermits.filter((p) => p.daysLate > 0);

  const planRecord = ctx.ledger.list(ctx.projectId, 'SiteLogisticsPlan')[0];
  const logistics = planRecord
    ? { version: Number(planRecord.state.version), warnings: (planRecord.state.warnings as LogisticsWarning[]) ?? [] }
    : null;

  const handoverBlockers = open.filter((f) => f.closesBy === 'HANDOVER');
  const photographs = findings.filter((f) => f.hasPhotograph).length;

  const parts: string[] = [
    `${visitRecords.length} visit${visitRecords.length === 1 ? '' : 's'}, ${findings.length} finding${findings.length === 1 ? '' : 's'}, ${open.length} still open`,
  ];
  if (latePermits.length > 0) {
    const worst = latePermits.reduce((a, b) => (b.daysLate > a.daysLate ? b : a));
    parts.push(
      `${latePermits.length} permission${latePermits.length === 1 ? '' : 's'} late, the worst by ${worst.daysLate} days (${worst.name})`,
    );
  }
  const criticalLogistics = (logistics?.warnings ?? []).filter((w) => w.severity === 'CRITICAL').length;
  if (criticalLogistics > 0) parts.push(`${criticalLogistics} critical logistics warning${criticalLogistics === 1 ? '' : 's'}`);
  if (handoverBlockers.length > 0) parts.push(`${handoverBlockers.length} still to discharge before handover`);
  if (parts.length === 1) parts.push('nothing outstanding');

  return {
    visits: visitRecords.map((record) => ({
      visitId: String(record.state.id),
      reference: String(record.state.reference),
      purpose: record.state.purpose as VisitPurpose,
      visitedOn: String(record.state.visitedOn),
      attendees: (record.state.attendees as string[]) ?? [],
      findings: findingRecords.filter((f) => f.state.visitId === record.state.id).length,
    })),
    findings,
    open: open.length,
    closed: findings.length - open.length,
    byCategory: countBy(FINDING_CATEGORY, (f) => f.category).map((r) => ({ category: r.value, open: r.open, total: r.total })),
    byConsequence: countBy(FINDING_CONSEQUENCE, (f) => f.consequences).map((r) => ({
      consequence: r.value,
      open: r.open,
      total: r.total,
    })),
    byStage: countBy(CLOSES_BY, (f) => f.closesBy).map((r) => ({ closesBy: r.value, open: r.open, total: r.total })),
    permits,
    latePermits,
    logistics,
    handoverBlockers,
    photographs,
    summary: `${parts.join('. ')}.`,
  };
}

// --- The report --------------------------------------------------------------

/**
 * The site visit report, as document blocks.
 *
 * Built here rather than in the exporter because this is where the meaning of a
 * finding lives. The exporter brands it, hashes it and records the two events
 * that make it provable; it should not also need to know what a permit lead
 * time is.
 *
 * The order is the order somebody reads it in on the way back from site: what
 * has to happen first, then the walk itself, then the plan, then the pictures.
 * Findings that are already late come before findings that are merely open,
 * because a report that buries the late one under a heading called "findings"
 * has told you nothing you did not know.
 */
export function siteVisitReportBlocks(
  ctx: EngineContext,
  visitId: string,
  options: { today?: string } = {},
): { title: string; subtitle: string; blocks: DocumentBlock[] } {
  const visit = ctx.ledger.require({ refType: 'SiteVisit', refId: visitId });
  const position = sitePosition(ctx, options);
  const reference = String(visit.state.reference);

  const findingRecords = ctx.ledger
    .list(ctx.projectId, 'SiteFinding')
    .filter((record) => record.state.visitId === visitId);
  const references = new Set(findingRecords.map((r) => String(r.state.reference)));
  const findings = position.findings.filter((f) => references.has(f.reference));

  const blocks: DocumentBlock[] = [];

  blocks.push({
    kind: 'KEY_VALUES',
    rows: [
      { label: 'Visit', value: reference },
      { label: 'Purpose', value: humanise(String(visit.state.purpose)) },
      { label: 'Walked', value: String(visit.state.visitedOn) },
      { label: 'Attended by', value: ((visit.state.attendees as string[]) ?? []).join(', ') },
      ...(visit.state.weather ? [{ label: 'Weather', value: String(visit.state.weather) }] : []),
      { label: 'Findings', value: `${findings.length}` },
    ],
  });

  // What is already late, first and on its own.
  const late = findings.filter((f) => f.status === 'OPEN' && f.permit && f.permit.daysLate > 0);
  if (late.length > 0) {
    blocks.push({ kind: 'HEADING', level: 2, text: 'Already late' });
    blocks.push({
      kind: 'PARAGRAPH',
      text:
        'These permissions cannot arrive in time for the work they unlock, on the lead times the authorities themselves quote. ' +
        'Nothing here is a forecast — it is arithmetic on dates that have already passed.',
    });
    blocks.push({
      kind: 'TABLE',
      headers: ['Ref', 'Permission', 'Authority', 'Apply by', 'Needed by', 'Days late'],
      rows: late.map((f) => [
        f.reference,
        f.permit!.name,
        f.permit!.authority,
        f.permit!.applyBy,
        f.permit!.requiredBy,
        String(f.permit!.daysLate),
      ]),
    });
  }

  blocks.push({ kind: 'HEADING', level: 2, text: 'Findings' });
  if (findings.length === 0) {
    blocks.push({ kind: 'PARAGRAPH', text: 'Nothing was recorded against this visit.' });
  } else {
    blocks.push({
      kind: 'TABLE',
      headers: ['Ref', 'Category', 'What was found', 'Where', 'Obliges', 'Discharged by', 'Owner', 'Status'],
      rows: findings.map((f) => [
        f.reference,
        humanise(f.category),
        f.description,
        f.location,
        f.consequences.map(humanise).join(', '),
        humanise(f.closesBy),
        f.owner,
        f.status === 'CLOSED' ? 'Discharged' : 'Open',
      ]),
    });
  }

  const constrained = findings.filter((f) => f.constraintReference);
  if (constrained.length > 0) {
    blocks.push({ kind: 'HEADING', level: 3, text: 'Carried into the programme' });
    blocks.push({
      kind: 'LIST',
      ordered: false,
      items: constrained.map(
        (f) => `${f.reference} raised constraint ${f.constraintReference}, which now blocks its activity in the lookahead`,
      ),
    });
  }

  const toHandover = findings.filter((f) => f.closesBy === 'HANDOVER');
  if (toHandover.length > 0) {
    blocks.push({ kind: 'HEADING', level: 3, text: 'Still owed at handover' });
    blocks.push({
      kind: 'PARAGRAPH',
      text:
        'These are the obligations this walk created that are not discharged until the job is handed over. They stay on the ' +
        'register for the life of the project, which is the whole reason a site visit is worth recording rather than filing.',
    });
    blocks.push({
      kind: 'LIST',
      ordered: false,
      items: toHandover.map((f) => `${f.reference} — ${f.description} (${f.owner}) — ${f.status === 'CLOSED' ? 'discharged' : 'open'}`),
    });
  }

  if (position.logistics) {
    blocks.push({ kind: 'HEADING', level: 2, text: `Site logistics plan, version ${position.logistics.version}` });
    if (position.logistics.warnings.length === 0) {
      blocks.push({ kind: 'PARAGRAPH', text: 'The checks the platform can settle by arithmetic all pass.' });
    } else {
      blocks.push({
        kind: 'TABLE',
        headers: ['Severity', 'Subject', 'What it means'],
        rows: position.logistics.warnings.map((w) => [humanise(w.severity), w.subject, w.detail]),
      });
    }
  }

  // The pictures last, captioned with the finding they belong to. A photograph
  // with no caption is a photograph of a wall.
  const photographed = findingRecords.filter((record) => record.state.evidenceHash);
  if (photographed.length > 0) {
    blocks.push({ kind: 'HEADING', level: 2, text: 'Photographs' });
    for (const record of photographed) {
      blocks.push({
        kind: 'PHOTOGRAPH',
        caption: `${String(record.state.reference)} — ${String(record.state.description)} (${String(record.state.location)})`,
        evidenceHash: String(record.state.evidenceHash),
        takenOn: String(visit.state.visitedOn),
      });
    }
  }

  return {
    title: `Site visit report — ${reference}`,
    subtitle: position.summary,
    blocks,
  };
}

/** `SITE_ESTABLISHMENT` reads badly on a page somebody hands to a client. */
function humanise(token: string): string {
  const words = token.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
