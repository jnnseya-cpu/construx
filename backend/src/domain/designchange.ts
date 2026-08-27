import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, write, type EngineContext } from '../engines/context.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';

/**
 * D-WF-06 — design change and impact control.
 *
 * **Not the same record as `ChangeRequest`.** That one is contractual: a change
 * with entitlement behind it, a notice type, affected subcontracts and a claim
 * for money or time. This one is a change to *approved design* — the thing that
 * happens between a design being accepted and a package being frozen, most of
 * which never becomes a contractual change at all because the designer is
 * correcting their own work. Collapsing them would put every drawing correction
 * into the variation register and make the variation register useless, which is
 * the commonest way a project loses track of what it is actually owed.
 *
 * Where a design change *does* have contractual consequence, the record carries
 * the change request reference rather than becoming one. Two registers, one
 * link, and each answering the question it is for.
 *
 * ---
 *
 * Four rules, each of them a refusal.
 *
 * **Implementation does not start before approval.** That is the whole point of
 * registering a change: a revision issued while the change is still being
 * assessed is a decision taken by whoever drew it. There is an emergency path,
 * because a safety correction cannot wait for a Tuesday meeting — and it is
 * recorded *as* an emergency, with the retrospective approval still owed. An
 * emergency change nobody went back and approved is visible for exactly as long
 * as that is true.
 *
 * **Every domain is assessed or explicitly not applicable, with a reason.** Six
 * of them: design, commercial, planning, safety, procurement, information. A
 * change assessed on cost alone is a change whose programme consequence somebody
 * will discover later, and "we looked at it and it does not affect procurement"
 * is a different statement from silence. The specification asks for exactly
 * this and it is the acceptance criterion.
 *
 * **Materiality is a proportion, never a figure.** `lifecycle/scale.ts` is the
 * platform's one place for that, and its rule is absolute: nothing hardcodes a
 * money threshold, because "£250,000 needs board approval" is sensible for an
 * £8m contractor and a rounding error for a £4bn one. What decides the approval
 * route here is the change's value as a share of the project's, plus whether it
 * touches safety or a statutory approval — because those are material at any
 * size.
 *
 * **Closure confirms every affected thing was revised, or says it was not
 * affected after all.** A change that named four packages and closed with two
 * of them untouched has left two packages built to superseded information. The
 * list is derived from what the change itself said it affects, so it cannot be
 * quietly shortened at the end.
 */

export const CHANGE_CLASS = [
  /** The designer putting their own work right. Usually no entitlement. */
  'CORRECTION',
  'CLIENT_CHANGE',
  'VALUE_ENGINEERING',
  /** Forced by a code, a standard or a consent condition. */
  'COMPLIANCE',
  'SITE_CONDITION',
] as const;
export type ChangeClass = (typeof CHANGE_CLASS)[number];

/**
 * The six domains an impact assessment has to cover.
 *
 * Named rather than free text, because the value is in the ones somebody would
 * not have thought of. A change assessed on cost alone is a change whose
 * programme consequence is discovered on site.
 */
export const IMPACT_DOMAIN = [
  'DESIGN',
  'COMMERCIAL',
  'PLANNING',
  'SAFETY',
  'PROCUREMENT',
  'INFORMATION',
] as const;
export type ImpactDomain = (typeof IMPACT_DOMAIN)[number];

export type Impact = {
  domain: ImpactDomain;
  /** False where the domain genuinely does not apply — which still needs saying. */
  applicable: boolean;
  /** What the impact is, or why there is none. Required either way. */
  assessment: string;
  assessedBy: string;
  /** Where the domain carries money or days, the figure. */
  costMinor?: number;
  days?: number;
};

export const DECISION = ['APPROVE', 'REJECT', 'MORE_INFORMATION'] as const;
export type Decision = (typeof DECISION)[number];

export type AffectedItem = {
  /** A package, a deliverable, a drawing, an approval. */
  kind: string;
  reference: string;
  /** Confirmed at closure: revised, or established as unaffected after all. */
  outcome?: 'REVISED' | 'UNAFFECTED';
  /** The revision it went to, or why it turned out not to be affected. */
  note?: string;
};

type ChangeState = {
  id: string;
  reference: string;
  title: string;
  classification: ChangeClass;
  origin: string;
  reason: string;
  currentRevision: string;
  proposedRevision: string;
  affects: AffectedItem[];
  touchesSafety: boolean;
  touchesStatutoryApproval: boolean;
  estimatedCostMinor: number;
  impacts: Impact[];
  status: 'PROPOSED' | 'ASSESSED' | 'APPROVED' | 'REJECTED' | 'MORE_INFORMATION' | 'IMPLEMENTED' | 'CLOSED';
  materiality?: Materiality;
  decision?: { decision: Decision; by: string; at: string; rationale: string };
  emergency?: { why: string; by: string; at: string; retrospectivelyApprovedAt?: string; retrospectivelyApprovedBy?: string };
  changeRequestRef?: string;
  proposedBy: string;
  proposedAt: string;
  implementationNote?: string;
  implementedAt?: string;
  implementedBy?: string;
  closureNote?: string;
  closedAt?: string;
};

export type Materiality = {
  /** The change's value as a share of the project's. Never a fixed figure. */
  sharePercent?: number;
  route: 'DESIGN_MANAGER' | 'PROJECT_DIRECTOR' | 'CLIENT';
  why: string;
};

/**
 * Above this share of the project's own value, a design change stops being the
 * design manager's to approve.
 *
 * A proportion rather than an amount, which is `lifecycle/scale.ts`'s rule and
 * the reason it exists: an absolute threshold is always wrong at one end of the
 * market. These two numbers are the whole configuration.
 */
export const MATERIALITY = {
  /** Above this share, the project director decides. */
  significantSharePercent: 0.5,
  /** Above this share, it is the client's decision, not the project's. */
  clientSharePercent: 2,
} as const;

/**
 * Which approval route this change takes.
 *
 * Exported and pure: the console shows the route before anybody submits, so a
 * person knows who they are asking before they ask. A second copy of this in the
 * browser would be the drift settled decision 6 exists to prevent.
 */
export function materialityOf(input: {
  estimatedCostMinor: number;
  projectValueMinor?: number;
  touchesSafety: boolean;
  touchesStatutoryApproval: boolean;
}): Materiality {
  // Material at any size, whatever the money says. A change to a fire strategy
  // on a £40k job is not a design manager's decision because it is cheap.
  if (input.touchesStatutoryApproval) {
    return {
      route: 'CLIENT',
      why: 'It touches a statutory approval, which is material at any value — the consent was granted on what was submitted.',
    };
  }
  if (input.touchesSafety) {
    return {
      route: 'PROJECT_DIRECTOR',
      why: 'It touches safety, which is material at any value rather than at a threshold.',
    };
  }

  if (!input.projectValueMinor || input.projectValueMinor <= 0) {
    return {
      route: 'PROJECT_DIRECTOR',
      why:
        'The project carries no value, so this change cannot be sized against it. The higher route is taken rather than ' +
        'the lower, because an unknown proportion is not a small one.',
    };
  }

  const sharePercent = Number(((input.estimatedCostMinor / input.projectValueMinor) * 100).toFixed(3));
  if (sharePercent > MATERIALITY.clientSharePercent) {
    return {
      sharePercent,
      route: 'CLIENT',
      why: `At ${sharePercent}% of the project's value it is above the ${MATERIALITY.clientSharePercent}% share at which a change stops being the project's to decide.`,
    };
  }
  if (sharePercent > MATERIALITY.significantSharePercent) {
    return {
      sharePercent,
      route: 'PROJECT_DIRECTOR',
      why: `At ${sharePercent}% of the project's value it is above the ${MATERIALITY.significantSharePercent}% share at which the design manager stops deciding alone.`,
    };
  }
  return {
    sharePercent,
    route: 'DESIGN_MANAGER',
    why: `At ${sharePercent}% of the project's value it sits inside the design manager's authority.`,
  };
}

function requireChange(ctx: EngineContext, id: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'DesignChange', refId: id });
  if (!record) throw new DomainError('DESIGN_CHANGE_NOT_FOUND', `No design change ${id}`, 404);
  return record;
}

function stateOf(record: EntityRecord): ChangeState {
  return record.state as unknown as ChangeState;
}

function projectValueMinor(ctx: EngineContext): number | undefined {
  const project = ctx.ledger.get({ refType: 'Project', refId: ctx.projectId });
  const value = project?.state.contractValueMinor;
  return typeof value === 'number' ? value : undefined;
}

// --- Proposing --------------------------------------------------------------

export function proposeChange(
  ctx: EngineContext,
  input: {
    title: string;
    classification: ChangeClass;
    origin: string;
    reason: string;
    currentRevision: string;
    proposedRevision: string;
    affects: Array<{ kind: string; reference: string }>;
    touchesSafety: boolean;
    touchesStatutoryApproval: boolean;
    estimatedCostMinor: number;
    /** Where the change is a safety correction that could not wait. */
    emergency?: { why: string };
  },
): { changeId: string; reference: string; materiality: Materiality; emergency: boolean } {
  authorise(ctx, 'DESIGN_INFORMATION', 'C');

  if (!input.title.trim() || !input.reason.trim()) {
    throw new DomainError(
      'CHANGE_UNSTATED',
      'Say what is changing and why. A change register full of "revised as marked" answers nothing about a decision six ' +
        'months later, which is the only time anybody reads it.',
    );
  }
  if (!input.origin.trim()) {
    throw new DomainError(
      'ORIGIN_REQUIRED',
      'Name where this came from — the instruction, the RFI answer, the site query, the clash. A change with no origin ' +
        'cannot be traced back to whoever asked for it, and that is the first thing argued about when it is priced.',
    );
  }
  if (!input.currentRevision.trim() || !input.proposedRevision.trim()) {
    throw new DomainError(
      'REVISIONS_REQUIRED',
      'Name the revision this changes from and the revision it changes to. Without both, nothing downstream can tell ' +
        'whether it has been applied.',
    );
  }
  if (input.affects.length === 0) {
    throw new DomainError(
      'AFFECTS_NOTHING',
      'Name what this affects — the packages, deliverables, drawings or approvals. A change affecting nothing is not a ' +
        'change, and this list is what closure is checked against, so an empty one makes closure meaningless.',
    );
  }
  if (input.emergency && !input.emergency.why.trim()) {
    throw new DomainError(
      'EMERGENCY_UNJUSTIFIED',
      'An emergency change says why it could not wait for the approval route. The route exists to stop somebody deciding ' +
        'alone, and "it was urgent" with nothing behind it is that decision with a label on it.',
    );
  }

  const materiality = materialityOf({
    estimatedCostMinor: input.estimatedCostMinor,
    projectValueMinor: projectValueMinor(ctx),
    touchesSafety: input.touchesSafety,
    touchesStatutoryApproval: input.touchesStatutoryApproval,
  });

  const sequence = ctx.ledger.list(ctx.projectId, 'DesignChange').length + 1;
  const reference = `DC-${String(sequence).padStart(4, '0')}`;
  const changeId = ulid();
  const now = new Date().toISOString();

  write(ctx, {
    eventType: 'DESIGN_CHANGE_PROPOSED',
    entity: { refType: 'DesignChange', refId: changeId },
    nextState: {
      id: changeId,
      projectId: ctx.projectId,
      reference,
      title: input.title,
      classification: input.classification,
      origin: input.origin,
      reason: input.reason,
      currentRevision: input.currentRevision,
      proposedRevision: input.proposedRevision,
      affects: input.affects.map((item) => ({ kind: item.kind, reference: item.reference })),
      touchesSafety: input.touchesSafety,
      touchesStatutoryApproval: input.touchesStatutoryApproval,
      estimatedCostMinor: input.estimatedCostMinor,
      impacts: [],
      status: 'PROPOSED',
      materiality,
      // Recorded as what it is. The retrospective approval is owed from this
      // moment and the platform will keep saying so until it happens.
      ...(input.emergency ? { emergency: { why: input.emergency.why, by: ctx.auth.actorId, at: now } } : {}),
      proposedBy: ctx.auth.actorId,
      proposedAt: now,
    },
  });

  return { changeId, reference, materiality, emergency: input.emergency !== undefined };
}

// --- Assessing --------------------------------------------------------------

/** Record one domain's assessment, or its reasoned absence. */
export function assessImpact(
  ctx: EngineContext,
  changeId: string,
  input: {
    domain: ImpactDomain;
    applicable: boolean;
    assessment: string;
    assessedBy: string;
    costMinor?: number;
    days?: number;
  },
): { assessed: number; outstanding: ImpactDomain[] } {
  authorise(ctx, 'DESIGN_INFORMATION', 'U');

  const record = requireChange(ctx, changeId);
  const state = stateOf(record);

  if (state.status === 'CLOSED') {
    throw new DomainError('CHANGE_CLOSED', `${state.reference} is closed.`);
  }
  if (!input.assessment.trim()) {
    throw new DomainError(
      'ASSESSMENT_REQUIRED',
      input.applicable
        ? `Say what the ${input.domain.toLowerCase()} impact is.`
        : `Say why ${input.domain.toLowerCase()} is not affected. "We looked at it and it does not apply" is a different ` +
          'statement from silence, and only one of the two is a record.',
    );
  }
  if (!input.assessedBy.trim()) {
    throw new DomainError(
      'ASSESSOR_REQUIRED',
      'Name who assessed it. Six domains means six people looked, and an assessment with no name is one nobody will stand ' +
        'behind when it turns out to have missed something.',
    );
  }

  const impact: Impact = {
    domain: input.domain,
    applicable: input.applicable,
    assessment: input.assessment,
    assessedBy: input.assessedBy,
    ...(input.costMinor === undefined ? {} : { costMinor: input.costMinor }),
    ...(input.days === undefined ? {} : { days: input.days }),
  };

  const impacts = [...state.impacts.filter((entry) => entry.domain !== input.domain), impact];
  const outstanding = IMPACT_DOMAIN.filter((domain) => !impacts.some((entry) => entry.domain === domain));

  write(ctx, {
    eventType: 'CHANGE_IMPACT_ASSESSED',
    entity: { refType: 'DesignChange', refId: changeId },
    nextState: {
      ...record.state,
      impacts,
      status: outstanding.length === 0 ? 'ASSESSED' : state.status,
    },
  });

  return { assessed: impacts.length, outstanding: [...outstanding] };
}

// --- Deciding ---------------------------------------------------------------

export function decideChange(
  ctx: EngineContext,
  changeId: string,
  input: { decision: Decision; rationale: string },
): { status: string; mayImplement: boolean } {
  authorise(ctx, 'DESIGN_INFORMATION', 'A');

  const record = requireChange(ctx, changeId);
  const state = stateOf(record);

  if (state.decision) {
    throw new DomainError(
      'CHANGE_ALREADY_DECIDED',
      `${state.reference} was already ${state.decision.decision.toLowerCase().replace(/_/g, ' ')}d. Raise a new change ` +
        'rather than re-deciding this one — the record of what was decided is what makes the register worth keeping.',
    );
  }
  if (!input.rationale.trim()) {
    throw new DomainError('DECISION_UNEXPLAINED', 'Say what the decision rests on.');
  }

  const outstanding = IMPACT_DOMAIN.filter((domain) => !state.impacts.some((entry) => entry.domain === domain));
  if (input.decision === 'APPROVE' && outstanding.length > 0) {
    throw new DomainError(
      'IMPACT_ASSESSMENT_INCOMPLETE',
      `${state.reference} cannot be approved with ${outstanding.map((d) => d.toLowerCase()).join(', ')} unassessed. Each ` +
        'domain is either assessed or recorded as not applicable with a reason — a change approved on cost alone is a ' +
        'change whose programme consequence somebody discovers on site.',
      409,
    );
  }
  if (state.proposedBy === ctx.auth.actorId) {
    throw new DomainError(
      'SELF_APPROVAL_REFUSED',
      'The person who proposed a change cannot be the person who decides it. That is the separation the approval route ' +
        'exists for, and it is worth as much on a correction as on a client change.',
    );
  }

  const now = new Date().toISOString();
  const status =
    input.decision === 'APPROVE' ? 'APPROVED' : input.decision === 'REJECT' ? 'REJECTED' : 'MORE_INFORMATION';

  const decided = {
    ...record.state,
    status,
    decision: { decision: input.decision, by: ctx.auth.actorId, at: now, rationale: input.rationale },
  };

  // Two explicit writes rather than one with the event type chosen inside it.
  // The catalogue is a closed list and the thing that keeps it closed is a test
  // that can read which codes the source actually emits; an expression it has to
  // evaluate reads as a dead event, and a dead event is how a code gets deleted
  // out from under working behaviour.
  if (input.decision === 'APPROVE') {
    write(ctx, {
      eventType: 'DESIGN_CHANGE_APPROVED',
      entity: { refType: 'DesignChange', refId: changeId },
      nextState: {
        ...decided,
        // The retrospective approval an emergency change owed, discharged.
        ...(state.emergency
          ? {
              emergency: {
                ...state.emergency,
                retrospectivelyApprovedAt: now,
                retrospectivelyApprovedBy: ctx.auth.actorId,
              },
            }
          : {}),
      },
    });
  } else {
    write(ctx, {
      eventType: 'DESIGN_CHANGE_DECIDED',
      entity: { refType: 'DesignChange', refId: changeId },
      nextState: decided,
    });
  }

  return { status, mayImplement: input.decision === 'APPROVE' };
}

// --- Implementing and closing -----------------------------------------------

/**
 * Record that the change has been made in the design.
 *
 * Refused before approval, except on the emergency path — which is recorded as
 * an emergency and still owes its retrospective approval. A safety correction
 * cannot wait for a Tuesday meeting; a convenience cannot call itself one.
 */
export function recordImplemented(
  ctx: EngineContext,
  changeId: string,
  input: { note: string; changeRequestRef?: string },
): { emergency: boolean; retrospectiveApprovalOwed: boolean } {
  authorise(ctx, 'DESIGN_INFORMATION', 'U');

  const record = requireChange(ctx, changeId);
  const state = stateOf(record);

  if (state.status === 'REJECTED') {
    throw new DomainError('CHANGE_REJECTED', `${state.reference} was rejected. It is not implemented.`);
  }
  if (state.status !== 'APPROVED' && !state.emergency) {
    throw new DomainError(
      'NOT_APPROVED',
      `${state.reference} is ${state.status.toLowerCase().replace(/_/g, ' ')}, not approved. A revision issued while a ` +
        'change is still being assessed is a decision taken by whoever drew it, which is the whole reason the change was ' +
        'registered. Where it genuinely could not wait, record it as an emergency when it is proposed — that route is ' +
        'open and it is recorded as what it is.',
      409,
    );
  }
  if (!input.note.trim()) {
    throw new DomainError('IMPLEMENTATION_UNSTATED', 'Say what was actually changed in the design.');
  }

  const owed = state.emergency !== undefined && state.emergency.retrospectivelyApprovedAt === undefined;

  write(ctx, {
    eventType: 'CHANGE_IMPLEMENTED',
    entity: { refType: 'DesignChange', refId: changeId },
    nextState: {
      ...record.state,
      status: 'IMPLEMENTED',
      implementationNote: input.note,
      // Two registers, one link. A design change with contractual consequence
      // names the change request rather than becoming one.
      ...(input.changeRequestRef ? { changeRequestRef: input.changeRequestRef } : {}),
      implementedAt: new Date().toISOString(),
      implementedBy: ctx.auth.actorId,
    },
  });

  return { emergency: state.emergency !== undefined, retrospectiveApprovalOwed: owed };
}

/**
 * Confirm one affected thing was revised, or that it turned out not to be
 * affected after all.
 *
 * The list comes from what the change itself said it affects, so it cannot be
 * quietly shortened at the end. AC-D-WF-06-03.
 */
export function confirmAffected(
  ctx: EngineContext,
  changeId: string,
  input: { reference: string; outcome: 'REVISED' | 'UNAFFECTED'; note: string },
): { confirmed: number; outstanding: string[] } {
  authorise(ctx, 'DESIGN_INFORMATION', 'U');

  const record = requireChange(ctx, changeId);
  const state = stateOf(record);
  const item = state.affects.find((entry) => entry.reference === input.reference);

  if (!item) {
    throw new DomainError(
      'NOT_AFFECTED_BY_THIS_CHANGE',
      `${state.reference} does not name ${input.reference} among what it affects. Confirming something the change never ` +
        'claimed to touch would let the closure list be written at the end rather than at the start.',
      404,
    );
  }
  if (!input.note.trim()) {
    throw new DomainError(
      'CONFIRMATION_UNSTATED',
      input.outcome === 'REVISED'
        ? 'Name the revision it went to.'
        : 'Say why it turned out not to be affected. A change that named four packages and closed with two untouched has ' +
          'left two packages built to superseded information, and the difference between that and a correct assessment is ' +
          'this sentence.',
    );
  }

  const affects = state.affects.map((entry) =>
    entry.reference === input.reference ? { ...entry, outcome: input.outcome, note: input.note } : entry,
  );
  const outstanding = affects.filter((entry) => entry.outcome === undefined).map((entry) => entry.reference);

  write(ctx, {
    eventType: 'CHANGE_VERIFIED',
    entity: { refType: 'DesignChange', refId: changeId },
    nextState: { ...record.state, affects },
  });

  return { confirmed: affects.length - outstanding.length, outstanding };
}

export function closeChange(ctx: EngineContext, changeId: string, input: { note: string }): { closed: true } {
  authorise(ctx, 'DESIGN_INFORMATION', 'A');

  const record = requireChange(ctx, changeId);
  const state = stateOf(record);

  if (state.status === 'CLOSED') throw new DomainError('CHANGE_CLOSED', `${state.reference} is already closed.`);

  if (state.status === 'REJECTED') {
    // A rejected change closes on the rejection. Nothing was implemented, so
    // there is nothing to confirm, and demanding confirmations would leave the
    // register full of decisions nobody can clear.
    write(ctx, {
      eventType: 'CHANGE_VERIFIED',
      entity: { refType: 'DesignChange', refId: changeId },
      nextState: { ...record.state, status: 'CLOSED', closedAt: new Date().toISOString(), closureNote: input.note },
    });
    return { closed: true };
  }

  if (state.status !== 'IMPLEMENTED') {
    throw new DomainError(
      'NOT_IMPLEMENTED',
      `${state.reference} is ${state.status.toLowerCase().replace(/_/g, ' ')}. A change closes once it has been made and ` +
        'every affected thing has been confirmed.',
    );
  }

  const outstanding = state.affects.filter((entry) => entry.outcome === undefined);
  if (outstanding.length > 0) {
    throw new DomainError(
      'AFFECTED_UNCONFIRMED',
      `${state.reference} cannot close with ${outstanding.map((entry) => entry.reference).join(', ')} unconfirmed. Each ` +
        'was either revised or turned out not to be affected, and a change that closed with them untouched has left them ' +
        'built to superseded information.',
      409,
    );
  }
  if (state.emergency && !state.emergency.retrospectivelyApprovedAt) {
    throw new DomainError(
      'RETROSPECTIVE_APPROVAL_OWED',
      `${state.reference} was implemented on the emergency path and has never been approved. The expedited route does not ` +
        'remove the approval; it defers it, and closing without it would turn a deferral into a bypass.',
      409,
    );
  }

  write(ctx, {
    eventType: 'CHANGE_VERIFIED',
    entity: { refType: 'DesignChange', refId: changeId },
    nextState: { ...record.state, status: 'CLOSED', closedAt: new Date().toISOString(), closureNote: input.note },
  });

  return { closed: true };
}

// --- The position -----------------------------------------------------------

export type DesignChangePosition = {
  changes: Array<{
    changeId: string;
    reference: string;
    title: string;
    classification: string;
    status: string;
    route: string;
    sharePercent?: number;
    domainsAssessed: number;
    outstandingDomains: string[];
    affected: number;
    affectedConfirmed: number;
    emergency: boolean;
    retrospectiveApprovalOwed: boolean;
    changeRequestRef?: string;
  }>;
  /** Implemented on the emergency path and never retrospectively approved. */
  approvalOwed: string[];
  /** Implemented, and still carrying something nobody has confirmed. */
  unconfirmed: Array<{ reference: string; items: string[] }>;
  summary: string;
};

export function designChangePosition(ctx: EngineContext): DesignChangePosition {
  authorise(ctx, 'DESIGN_INFORMATION', 'R');

  const approvalOwed: string[] = [];
  const unconfirmed: DesignChangePosition['unconfirmed'] = [];

  const changes = ctx.ledger.list(ctx.projectId, 'DesignChange').map((record) => {
    const state = stateOf(record);
    const outstandingDomains = IMPACT_DOMAIN.filter((domain) => !state.impacts.some((entry) => entry.domain === domain));
    const owed = state.emergency !== undefined && state.emergency.retrospectivelyApprovedAt === undefined;
    const open = state.affects.filter((entry) => entry.outcome === undefined);

    if (owed && state.status === 'IMPLEMENTED') approvalOwed.push(state.reference);
    if (state.status === 'IMPLEMENTED' && open.length > 0) {
      unconfirmed.push({ reference: state.reference, items: open.map((entry) => entry.reference) });
    }

    return {
      changeId: state.id,
      reference: state.reference,
      title: state.title,
      classification: state.classification,
      status: state.status,
      route: state.materiality?.route ?? 'UNKNOWN',
      sharePercent: state.materiality?.sharePercent,
      domainsAssessed: state.impacts.length,
      outstandingDomains: outstandingDomains.map((domain) => domain.toLowerCase()),
      affected: state.affects.length,
      affectedConfirmed: state.affects.filter((entry) => entry.outcome !== undefined).length,
      emergency: state.emergency !== undefined,
      retrospectiveApprovalOwed: owed,
      changeRequestRef: state.changeRequestRef,
    };
  });

  // Emergencies first, then anything implemented and unconfirmed. Both are
  // things that will be somebody's problem later and are nobody's now.
  changes.sort((a, b) => Number(b.retrospectiveApprovalOwed) - Number(a.retrospectiveApprovalOwed));

  const parts = [`${changes.length} design change${changes.length === 1 ? '' : 's'}`];
  const open = changes.filter((change) => change.status !== 'CLOSED' && change.status !== 'REJECTED').length;
  if (open > 0) parts.push(`${open} open`);
  if (approvalOwed.length > 0) parts.push(`${approvalOwed.length} implemented on the emergency path and never approved`);
  if (unconfirmed.length > 0) parts.push(`${unconfirmed.length} implemented with something unconfirmed`);

  return { changes, approvalOwed, unconfirmed, summary: parts.join(', ') + '.' };
}
