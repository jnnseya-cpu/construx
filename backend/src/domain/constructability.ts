import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';

/**
 * D-WF-07 — constructability, temporary works and residual design risk.
 *
 * The review where the people who will build a thing read the drawings of it
 * before anybody freezes them. It is the cheapest hour on a construction
 * project and the first one cancelled.
 *
 * What makes it worth recording is not the meeting. It is what happens to the
 * findings, and the two failures that follow from getting that wrong.
 *
 * **A finding that becomes a conversation.** "The valve chamber has no access
 * for a man with a torque wrench" is either a design change, a risk somebody
 * owns, an RFI, a constraint on the method, or a thing the review deliberately
 * accepted. Those are five different outcomes with five different owners, and a
 * finding recorded without one of them is a sentence in a set of minutes that
 * nobody reads again. Every finding here carries a disposition, an owner and a
 * date, or it is not recorded.
 *
 * **A residual risk that stops at the designer.** Under CDM the designer's duty
 * is to eliminate, then reduce, then *communicate* — and the third one is the
 * one that fails, because communicating means the risk has to reach the people
 * who will be exposed to it. A residual risk here names the drawing or model it
 * lives on and states plainly that it must reach the pre-construction
 * information and the method statement for the work it affects. It is carried
 * as an obligation with a state, not as a note.
 *
 * ---
 *
 * **Two things this deliberately does not do.**
 *
 * It does not categorise temporary works. The category of a temporary work and
 * who must check it are set by the organisation's own procedure against BS 5975,
 * and the specification says outright that they cannot be inferred by an agent.
 * So the platform records the category somebody assigned and who assigned it,
 * and refuses a temporary works interface with neither. Guessing would produce
 * a designer of record for a falsework scheme that nobody appointed.
 *
 * It does not close a review. Findings close; the review is the occasion they
 * came from and is finished when it happened. A review with a "closed" state
 * invites the register to be tidied rather than discharged, which is the exact
 * failure mode the finding disposition exists to prevent.
 */

export const FINDING_AREA = [
  'BUILDABILITY',
  'TOLERANCES',
  'ACCESS',
  'SEQUENCING',
  'TEMPORARY_WORKS',
  'TESTABILITY',
  'MAINTAINABILITY',
  'LOGISTICS',
] as const;
export type FindingArea = (typeof FINDING_AREA)[number];

/**
 * What becomes of a finding. Five outcomes, five owners.
 *
 * `ACCEPTED` is the one that matters: the review looked at it and decided to
 * live with it. That is a legitimate answer and it is recorded as a decision
 * with a name against it, not as a closure.
 */
export const DISPOSITION = ['DESIGN_CHANGE', 'RISK', 'RFI', 'METHOD_CONSTRAINT', 'ACCEPTED'] as const;
export type Disposition = (typeof DISPOSITION)[number];

/**
 * The two areas that stop a package being frozen while they are open.
 *
 * Named by the specification, and for the same reason in both cases: a thing
 * that cannot be safely reached or cannot be proved to work is a defect that
 * only becomes visible after it is buried.
 */
const BLOCKS_FREEZE: readonly FindingArea[] = ['ACCESS', 'TESTABILITY'];

export const SEVERITY = ['CRITICAL', 'MAJOR', 'MINOR'] as const;
export type Severity = (typeof SEVERITY)[number];

export type Finding = {
  reference: string;
  area: FindingArea;
  severity: Severity;
  what: string;
  /** Where on the works — a grid, a chamber, a system. */
  location: string;
  raisedBy: string;
  disposition: Disposition;
  /** Why that disposition, and not one of the other four. */
  rationale: string;
  owner: string;
  by: string;
  status: 'OPEN' | 'CLOSED';
  closure?: { what: string; at: string; by: string };
  /** The change, risk, RFI or constraint this became, where one exists yet. */
  linkedRef?: string;
};

/**
 * How a designer discharged their duty on one hazard.
 *
 * Ordered as the regulation orders it. Elimination first, because a hazard
 * designed out is not a hazard anybody has to be careful about.
 */
export const RISK_TREATMENT = ['ELIMINATED', 'REDUCED', 'COMMUNICATED'] as const;
export type RiskTreatment = (typeof RISK_TREATMENT)[number];

export type ResidualRisk = {
  reference: string;
  hazard: string;
  /** Who is exposed: the trade, the operator, the public. */
  whoIsExposed: string;
  treatment: RiskTreatment;
  /** What was actually done — the design move, not the intention. */
  what: string;
  /** The drawing or model the risk lives on, so it can be found from the works. */
  shownOn: string;
  /** Whether it has reached the pre-construction information. */
  inPreConstructionInformation: boolean;
  /** Whether it has reached a method statement for the work it affects. */
  inMethodStatement: boolean;
  recordedBy: string;
  recordedAt: string;
};

export type TemporaryWorksInterface = {
  reference: string;
  description: string;
  /** BS 5975 categories. Assigned by a person, never inferred. */
  category: '0' | '1' | '2' | '3';
  assignedBy: string;
  /** The designer of the temporary work, and the independent checker it needs. */
  designer: string;
  checker: string;
  /** What the permanent works assumes about it — the load path, the sequence. */
  permanentWorksAssumption: string;
  status: 'RAISED' | 'DESIGNED' | 'CHECKED';
};

type ReviewState = {
  id: string;
  reference: string;
  packageReference: string;
  zone: string;
  heldAt: string;
  attendees: Array<{ name: string; organisation: string; discipline: string }>;
  findings: Finding[];
  residualRisks: ResidualRisk[];
  temporaryWorks: TemporaryWorksInterface[];
};

/** The four voices the review is for. A review missing one of them is a discipline meeting. */
const REQUIRED_DISCIPLINES = ['CONSTRUCTION', 'DESIGN', 'HSE', 'OPERATIONS'] as const;

function requireReview(ctx: EngineContext, reviewId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'ConstructabilityReview', refId: reviewId });
  if (!record) throw new DomainError('REVIEW_NOT_FOUND', `No constructability review ${reviewId}`, 404);
  return record;
}

function stateOf(record: EntityRecord): ReviewState {
  return record.state as unknown as ReviewState;
}

/**
 * Hold the review.
 *
 * Refused without construction, design, HSE and operations in the room. A
 * buildability review attended only by designers is a design review, and the
 * whole value of the occasion is that the people who will build it and the
 * people who will maintain it are reading the same drawing at the same time.
 */
export function holdReview(
  ctx: EngineContext,
  input: {
    packageReference: string;
    zone: string;
    heldAt: string;
    attendees: Array<{ name: string; organisation: string; discipline: string }>;
  },
): { reviewId: string; reference: string } {
  authorise(ctx, 'DESIGN_INFORMATION', 'C');

  if (!input.packageReference.trim()) {
    throw new DomainError('PACKAGE_REQUIRED', 'A constructability review is held against a package.');
  }
  if (Number.isNaN(Date.parse(input.heldAt))) {
    throw new DomainError('HELD_AT_INVALID', `"${input.heldAt}" is not a date.`);
  }
  if (Date.parse(input.heldAt) > Date.now()) {
    throw new DomainError(
      'REVIEW_NOT_YET_HELD',
      'This review is dated in the future. A review recorded before it happens produces findings nobody has made.',
    );
  }

  const present = new Set(input.attendees.map((attendee) => attendee.discipline.toUpperCase()));
  const absent = REQUIRED_DISCIPLINES.filter((discipline) => !present.has(discipline));
  if (absent.length > 0) {
    throw new DomainError(
      'DISCIPLINE_ABSENT',
      `Nobody from ${absent.join(', ').toLowerCase()} was at this review. The whole value of the occasion is that the ` +
        'people who will build it, the people who will maintain it and the people who drew it are reading the same drawing ' +
        'at the same time. A review missing one of them is a discipline meeting with a constructability heading on it.',
    );
  }

  const sequence = ctx.ledger.list(ctx.projectId, 'ConstructabilityReview').length + 1;
  const reference = `CR-${String(sequence).padStart(3, '0')}`;
  const reviewId = ulid();

  write(ctx, {
    eventType: 'CONSTRUCTABILITY_REVIEWED',
    entity: { refType: 'ConstructabilityReview', refId: reviewId },
    nextState: {
      id: reviewId,
      projectId: ctx.projectId,
      reference,
      packageReference: input.packageReference,
      zone: input.zone,
      heldAt: input.heldAt,
      attendees: input.attendees,
      findings: [],
      residualRisks: [],
      temporaryWorks: [],
      recordedBy: ctx.auth.actorId,
      recordedAt: new Date().toISOString(),
    },
  });

  return { reviewId, reference };
}

/**
 * A finding, and what it becomes.
 *
 * The disposition is required at the point the finding is recorded rather than
 * left to be decided afterwards, because "we will work out what to do with it"
 * is how a review's output becomes a list nobody owns.
 */
export function recordFinding(
  ctx: EngineContext,
  reviewId: string,
  input: {
    area: FindingArea;
    severity: Severity;
    what: string;
    location: string;
    raisedBy: string;
    disposition: Disposition;
    rationale: string;
    owner: string;
    by: string;
    linkedRef?: string;
  },
): { reference: string; blocksFreeze: boolean } {
  authorise(ctx, 'DESIGN_INFORMATION', 'U');

  const record = requireReview(ctx, reviewId);
  const state = stateOf(record);

  if (!input.what.trim() || !input.location.trim()) {
    throw new DomainError(
      'FINDING_UNSTATED',
      'Say what was found and where on the works. A finding with no location cannot be checked against the drawing it is ' +
        'about.',
    );
  }
  if (!input.owner.trim()) {
    throw new DomainError(
      'FINDING_UNOWNED',
      'A finding needs an owner. Five dispositions, five different owners — and a finding recorded without one is a ' +
        'sentence in a set of minutes that nobody reads again.',
    );
  }
  if (Number.isNaN(Date.parse(input.by))) {
    throw new DomainError('FINDING_UNDATED', `"${input.by}" is not a date. A finding with no date is never late.`);
  }
  if (!input.rationale.trim()) {
    throw new DomainError(
      'DISPOSITION_UNEXPLAINED',
      `Say why this is a ${input.disposition.replace(/_/g, ' ').toLowerCase()} rather than one of the other four. The ` +
        'disposition decides who owns it and what happens next, and one chosen without a reason is one that will be ' +
        'argued about.',
    );
  }
  if (input.disposition === 'ACCEPTED' && input.severity === 'CRITICAL') {
    throw new DomainError(
      'CRITICAL_NOT_ACCEPTABLE',
      'A critical finding cannot be closed by accepting it. Accepting is a legitimate answer to a finding the review ' +
        'decided to live with; a critical one is by definition not that, and recording it as accepted would turn the ' +
        'severity into a label rather than a decision.',
    );
  }

  const reference = `${state.reference}/F${String(state.findings.length + 1).padStart(2, '0')}`;
  const blocksFreeze = BLOCKS_FREEZE.includes(input.area) && input.disposition !== 'ACCEPTED';

  const finding: Finding = {
    reference,
    area: input.area,
    severity: input.severity,
    what: input.what,
    location: input.location,
    raisedBy: input.raisedBy,
    disposition: input.disposition,
    rationale: input.rationale,
    owner: input.owner,
    by: input.by,
    // An accepted finding is decided, not outstanding. The decision is the
    // discharge, and leaving it open would fill the register with things
    // somebody already answered.
    status: input.disposition === 'ACCEPTED' ? 'CLOSED' : 'OPEN',
    linkedRef: input.linkedRef,
    ...(input.disposition === 'ACCEPTED'
      ? { closure: { what: input.rationale, at: new Date().toISOString(), by: ctx.auth.actorId } }
      : {}),
  };

  write(ctx, {
    eventType: 'DESIGN_RISK_UPDATED',
    entity: { refType: 'ConstructabilityReview', refId: reviewId },
    nextState: { ...record.state, findings: [...state.findings, finding] },
  });

  return { reference, blocksFreeze };
}

/** Close a finding with what actually resolved it. */
export function closeFinding(
  ctx: EngineContext,
  reviewId: string,
  input: { reference: string; what: string; linkedRef?: string },
): void {
  authorise(ctx, 'DESIGN_INFORMATION', 'U');

  const record = requireReview(ctx, reviewId);
  const state = stateOf(record);
  const finding = state.findings.find((entry) => entry.reference === input.reference);

  if (!finding) throw new DomainError('FINDING_NOT_FOUND', `No finding ${input.reference} on ${state.reference}.`, 404);
  if (finding.status === 'CLOSED') throw new DomainError('FINDING_ALREADY_CLOSED', `${input.reference} is already closed.`);
  if (!input.what.trim()) {
    throw new DomainError(
      'CLOSURE_UNSTATED',
      'Say what resolved it. A finding closed with nothing beside it cannot be told apart from one closed to clear the ' +
        'register before a freeze, and those produce very different buildings.',
    );
  }

  write(ctx, {
    eventType: 'REVIEW_ACTION_CLOSED',
    entity: { refType: 'ConstructabilityReview', refId: reviewId },
    nextState: {
      ...record.state,
      findings: state.findings.map((entry) =>
        entry.reference === input.reference
          ? {
              ...entry,
              status: 'CLOSED' as const,
              linkedRef: input.linkedRef ?? entry.linkedRef,
              closure: { what: input.what, at: new Date().toISOString(), by: ctx.auth.actorId },
            }
          : entry,
      ),
    },
  });
}

/**
 * Record a residual design risk and how the designer discharged their duty.
 *
 * Elimination, reduction, communication — in that order, because a hazard
 * designed out is not a hazard anybody has to be careful about. The third is the
 * one that fails: communicating means the risk reaches the people who will be
 * exposed to it, and a risk register that stops at the designer has done the
 * first two thirds of a duty.
 */
export function recordResidualRisk(
  ctx: EngineContext,
  reviewId: string,
  input: {
    hazard: string;
    whoIsExposed: string;
    treatment: RiskTreatment;
    what: string;
    shownOn: string;
  },
): { reference: string; stillToCommunicate: boolean } {
  authorise(ctx, 'DESIGN_INFORMATION', 'U');

  const record = requireReview(ctx, reviewId);
  const state = stateOf(record);

  if (!input.hazard.trim() || !input.what.trim()) {
    throw new DomainError('RISK_UNSTATED', 'Say what the hazard is and what was actually done about it.');
  }
  if (!input.whoIsExposed.trim()) {
    throw new DomainError(
      'EXPOSURE_UNNAMED',
      'Name who is exposed — the trade, the operator, the public. A residual risk with nobody named against it cannot be ' +
        'communicated to anybody, which is the third of the designer’s three duties and the one that fails.',
    );
  }
  if (input.treatment !== 'ELIMINATED' && !input.shownOn.trim()) {
    throw new DomainError(
      'RISK_NOT_SHOWN',
      'Name the drawing or model this risk lives on. A hazard that survives into the works has to be findable *from* the ' +
        'works, and a register entry with no drawing against it is findable only by somebody who already knows it exists.',
    );
  }

  const reference = `${state.reference}/R${String(state.residualRisks.length + 1).padStart(2, '0')}`;
  // An eliminated hazard is not residual: there is nothing left to tell anybody
  // about, and marking it as outstanding communication would fill the register
  // with work nobody has to do.
  const eliminated = input.treatment === 'ELIMINATED';

  write(ctx, {
    eventType: 'DESIGN_RISK_UPDATED',
    entity: { refType: 'ConstructabilityReview', refId: reviewId },
    nextState: {
      ...record.state,
      residualRisks: [
        ...state.residualRisks,
        {
          reference,
          hazard: input.hazard,
          whoIsExposed: input.whoIsExposed,
          treatment: input.treatment,
          what: input.what,
          shownOn: input.shownOn,
          inPreConstructionInformation: eliminated,
          inMethodStatement: eliminated,
          recordedBy: ctx.auth.actorId,
          recordedAt: new Date().toISOString(),
        },
      ],
    },
  });

  return { reference, stillToCommunicate: !eliminated };
}

/** Record that a residual risk has reached the information it has to reach. */
export function communicateRisk(
  ctx: EngineContext,
  reviewId: string,
  input: { reference: string; reached: 'PRE_CONSTRUCTION_INFORMATION' | 'METHOD_STATEMENT'; where: string },
): { stillToCommunicate: boolean } {
  authorise(ctx, 'DESIGN_INFORMATION', 'U');

  const record = requireReview(ctx, reviewId);
  const state = stateOf(record);
  const risk = state.residualRisks.find((entry) => entry.reference === input.reference);

  if (!risk) throw new DomainError('RISK_NOT_FOUND', `No residual risk ${input.reference} on ${state.reference}.`, 404);
  if (!input.where.trim()) {
    throw new DomainError(
      'REFERENCE_REQUIRED',
      'Name the document it reached. "It is in the pre-construction information" with no reference is the assertion this ' +
        'record exists to replace.',
    );
  }

  const updated = state.residualRisks.map((entry) =>
    entry.reference === input.reference
      ? {
          ...entry,
          ...(input.reached === 'PRE_CONSTRUCTION_INFORMATION'
            ? { inPreConstructionInformation: true, preConstructionInformationRef: input.where }
            : { inMethodStatement: true, methodStatementRef: input.where }),
        }
      : entry,
  );

  write(ctx, {
    eventType: 'DESIGN_RISK_UPDATED',
    entity: { refType: 'ConstructabilityReview', refId: reviewId },
    nextState: { ...record.state, residualRisks: updated },
  });

  const after = updated.find((entry) => entry.reference === input.reference)!;
  return { stillToCommunicate: !(after.inPreConstructionInformation && after.inMethodStatement) };
}

/**
 * A temporary works interface.
 *
 * The category and the checking requirement are the organisation's own decision
 * under BS 5975, and the specification says outright that they cannot be
 * inferred by an agent. So the platform records who assigned the category and
 * refuses one with nobody's name on it. Guessing would produce a designer of
 * record for a falsework scheme that nobody appointed.
 */
export function raiseTemporaryWorks(
  ctx: EngineContext,
  reviewId: string,
  input: {
    description: string;
    category: '0' | '1' | '2' | '3';
    assignedBy: string;
    designer: string;
    checker: string;
    permanentWorksAssumption: string;
  },
): { reference: string; needsIndependentCheck: boolean } {
  authorise(ctx, 'DESIGN_INFORMATION', 'U');

  const record = requireReview(ctx, reviewId);
  const state = stateOf(record);

  if (!input.assignedBy.trim()) {
    throw new DomainError(
      'CATEGORY_UNASSIGNED',
      'Name who assigned the category. Under BS 5975 the category and the checking regime that follows from it are a ' +
        'competent person’s decision, and a category with nobody’s name on it produces a designer of record for a ' +
        'falsework scheme nobody appointed.',
    );
  }
  if (!input.designer.trim() || !input.checker.trim()) {
    throw new DomainError(
      'TEMPORARY_WORKS_UNCHECKED',
      'Name the temporary works designer and the checker. Every category from 1 upwards requires a check independent of ' +
        'the designer, and category 0 still requires somebody to have said it is category 0.',
    );
  }
  if (input.designer.trim() === input.checker.trim() && input.category !== '0') {
    throw new DomainError(
      'TEMPORARY_WORKS_SELF_CHECKED',
      `Category ${input.category} temporary works are checked by somebody other than the person who designed them. ` +
        `${input.designer} cannot be both.`,
    );
  }
  if (!input.permanentWorksAssumption.trim()) {
    throw new DomainError(
      'ASSUMPTION_UNSTATED',
      'State what the permanent works assumes about this temporary work — the load path, the sequence, the props that ' +
        'stay in. That assumption is the interface, and it is the thing that gets lost when the temporary works designer ' +
        'and the permanent works designer are different firms.',
    );
  }

  const reference = `${state.reference}/TW${String(state.temporaryWorks.length + 1).padStart(2, '0')}`;

  write(ctx, {
    eventType: 'TEMPORARY_WORKS_INTERFACE_RAISED',
    entity: { refType: 'ConstructabilityReview', refId: reviewId },
    nextState: {
      ...record.state,
      temporaryWorks: [
        ...state.temporaryWorks,
        {
          reference,
          description: input.description,
          category: input.category,
          assignedBy: input.assignedBy,
          designer: input.designer,
          checker: input.checker,
          permanentWorksAssumption: input.permanentWorksAssumption,
          status: 'RAISED' as const,
        },
      ],
    },
  });

  return { reference, needsIndependentCheck: input.category !== '0' };
}

// --- The position, and what it blocks ---------------------------------------

export type ConstructabilityPosition = {
  reviews: Array<{
    reviewId: string;
    reference: string;
    packageReference: string;
    zone: string;
    heldAt: string;
    findings: number;
    openFindings: number;
    overdueFindings: number;
    residualRisks: number;
    risksNotYetCommunicated: number;
    temporaryWorks: number;
  }>;
  /** Open findings on access or testability, by package. These stop a freeze. */
  freezeBlockers: Array<{ package: string; reference: string; area: string; severity: string; what: string; owner: string }>;
  /** Residual risks that have not reached the information they have to reach. */
  uncommunicated: Array<{ reference: string; hazard: string; whoIsExposed: string; shownOn: string; missing: string[] }>;
  summary: string;
};

export function constructabilityPosition(
  ctx: EngineContext,
  today = new Date().toISOString().slice(0, 10),
): ConstructabilityPosition {
  authorise(ctx, 'DESIGN_INFORMATION', 'R');

  const freezeBlockers: ConstructabilityPosition['freezeBlockers'] = [];
  const uncommunicated: ConstructabilityPosition['uncommunicated'] = [];

  const reviews = ctx.ledger.list(ctx.projectId, 'ConstructabilityReview').map((record) => {
    const state = stateOf(record);
    const open = state.findings.filter((entry) => entry.status === 'OPEN');

    for (const finding of open) {
      if (BLOCKS_FREEZE.includes(finding.area)) {
        freezeBlockers.push({
          package: state.packageReference,
          reference: finding.reference,
          area: finding.area,
          severity: finding.severity,
          what: finding.what,
          owner: finding.owner,
        });
      }
    }
    for (const risk of state.residualRisks) {
      const missing = [
        risk.inPreConstructionInformation ? '' : 'the pre-construction information',
        risk.inMethodStatement ? '' : 'a method statement',
      ].filter(Boolean);
      if (missing.length > 0) {
        uncommunicated.push({
          reference: risk.reference,
          hazard: risk.hazard,
          whoIsExposed: risk.whoIsExposed,
          shownOn: risk.shownOn,
          missing,
        });
      }
    }

    return {
      reviewId: state.id,
      reference: state.reference,
      packageReference: state.packageReference,
      zone: state.zone,
      heldAt: state.heldAt,
      findings: state.findings.length,
      openFindings: open.length,
      overdueFindings: open.filter((entry) => entry.by < today).length,
      residualRisks: state.residualRisks.length,
      risksNotYetCommunicated: state.residualRisks.filter(
        (entry) => !(entry.inPreConstructionInformation && entry.inMethodStatement),
      ).length,
      temporaryWorks: state.temporaryWorks.length,
    };
  });

  // Critical first, then major. A blocker list read from the top should start
  // with the thing that will hurt somebody.
  const rank = { CRITICAL: 0, MAJOR: 1, MINOR: 2 } as const;
  freezeBlockers.sort((a, b) => rank[a.severity as Severity] - rank[b.severity as Severity]);

  const parts = [`${reviews.length} review${reviews.length === 1 ? '' : 's'}`];
  const open = reviews.reduce((count, entry) => count + entry.openFindings, 0);
  if (open > 0) parts.push(`${open} finding${open === 1 ? '' : 's'} open`);
  if (freezeBlockers.length > 0) parts.push(`${freezeBlockers.length} blocking a package freeze`);
  if (uncommunicated.length > 0) parts.push(`${uncommunicated.length} residual risk(s) not yet communicated`);

  return { reviews, freezeBlockers, uncommunicated, summary: parts.join(', ') + '.' };
}

/**
 * Whether a package may be frozen, and what stops it.
 *
 * Exported for D-WF-08 to call rather than re-derive: the rule about safe access
 * and testability belongs where the findings are, and a gate that reimplemented
 * it would be a second answer to the same question.
 */
export function freezeBlockersFor(ctx: EngineContext, packageReference: string): ConstructabilityPosition['freezeBlockers'] {
  return constructabilityPosition(ctx).freezeBlockers.filter((entry) => entry.package === packageReference);
}
