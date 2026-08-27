import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';

/**
 * D-WF-01 — design mobilisation, responsibility and information planning.
 *
 * The plan for who produces what information, by when, for whom, and who checks
 * it. It is the first thing set up after the concept gate and the last thing
 * anybody looks at, which is why design programmes fail quietly.
 *
 * Three failures are what this module exists to prevent, and none of them is a
 * missing record.
 *
 * **Information that arrives after it was needed.** A deliverable has a due
 * date and the thing waiting for it has a need date, and on most projects those
 * two numbers live in different documents held by different people. Here they
 * sit on the same record and the platform subtracts them. A drawing due on the
 * 20th, needed for a procurement enquiry on the 14th, with a ten-day review
 * period, is late three ways at once — and it is late on the day it is planned,
 * not on the day it is missed.
 *
 * **An interface nobody owns.** Every expensive coordination failure lives
 * between two packages, and the reason is always the same: both sides assumed
 * the other held it. An interface here carries an owner on each side or it is
 * not recorded, because an interface with one owner is a package boundary
 * somebody has drawn and nobody has agreed.
 *
 * **Responsibility that moved without anybody accepting it.** The commonest way
 * a duty evaporates is a reassignment that the outgoing party made and the
 * incoming party never saw. A transfer here needs both names. And delegation is
 * not transfer: a lead designer who sublets a deliverable still owns the
 * interfaces it crosses, which is the rule the CDM regime already states and
 * that most information plans quietly lose.
 *
 * ---
 *
 * **A departure from the specification, recorded here rather than argued
 * later.** D-WF-01 step 4 asks for CDE states to be *configured* with
 * permission rules. That would be a second permission model sitting beside
 * `identity/roles.ts`, answering the same question differently — and settled
 * decision 6 says the browser holds no rule the API does not publish, for the
 * same reason a second permission table is worse than none. So the four states
 * are implemented as a fixed ladder with the one rule the specification
 * actually names beneath it: nothing reaches Shared without an author, a
 * checker and its metadata. Who may perform each move is the permission matrix's
 * answer, given once.
 */

export const DELIVERABLE_KIND = [
  'DRAWING',
  'MODEL',
  'CALCULATION',
  'SPECIFICATION',
  'SCHEDULE',
  'REPORT',
  'SURVEY',
] as const;
export type DeliverableKind = (typeof DELIVERABLE_KIND)[number];

/**
 * The CDE states, in the order information moves through them.
 *
 * Work in progress is one team's. Shared is visible to the project and not to
 * be built from. Published is issued and frozen. Archived is superseded and
 * still readable — a state that must exist, because the question two years
 * later is never what the current revision says.
 */
export const CDE_STATE = ['WIP', 'SHARED', 'PUBLISHED', 'ARCHIVED'] as const;
export type CDEState = (typeof CDE_STATE)[number];

const LADDER: Record<CDEState, CDEState[]> = {
  WIP: ['SHARED'],
  SHARED: ['PUBLISHED', 'WIP'],
  PUBLISHED: ['ARCHIVED'],
  ARCHIVED: [],
};

export type Deliverable = {
  reference: string;
  title: string;
  kind: DeliverableKind;
  /** Why it is issued — for comment, for construction, for information. */
  purpose: string;
  format: string;
  author: string;
  checker: string;
  approver: string;
  /** The party who accepts it. Not the same act as approving it. */
  acceptingParty: string;
  dueBy: string;
  /** The date the thing waiting for this actually needs it. */
  neededBy: string;
  /** What is waiting: a procurement enquiry, a site activity, a consent. */
  neededFor: string;
  reviewDays: number;
  state: CDEState;
  /** Set where production has been sublet. Does not move the interface duty. */
  delegatedTo?: { party: string; organisation: string; why: string; at: string };
  history: Array<{ from: CDEState; to: CDEState; by: string; at: string }>;
};

export type DesignInterface = {
  reference: string;
  description: string;
  /** The package on the other side of it. */
  withPackage: string;
  ourOwner: string;
  theirOwner: string;
  resolveBy: string;
  status: 'OPEN' | 'AGREED';
  agreement?: { what: string; at: string; by: string };
};

type PackageState = {
  id: string;
  reference: string;
  title: string;
  discipline: string;
  zone: string;
  leadDesigner: string;
  leadOrganisation: string;
  deliverables: Deliverable[];
  interfaces: DesignInterface[];
};

const DAY_MS = 86_400_000;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

function requirePackage(ctx: EngineContext, packageId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'DesignPackage', refId: packageId });
  if (!record) throw new DomainError('DESIGN_PACKAGE_NOT_FOUND', `No design package ${packageId}`, 404);
  return record;
}

function stateOf(record: EntityRecord): PackageState {
  return record.state as unknown as PackageState;
}

function requireDeliverable(state: PackageState, reference: string): Deliverable {
  const deliverable = state.deliverables.find((entry) => entry.reference === reference);
  if (!deliverable) {
    throw new DomainError('DELIVERABLE_NOT_FOUND', `${state.reference} has no deliverable ${reference}.`, 404);
  }
  return deliverable;
}

// --- The package ------------------------------------------------------------

export function createPackage(
  ctx: EngineContext,
  input: {
    reference: string;
    title: string;
    discipline: string;
    zone: string;
    leadDesigner: string;
    leadOrganisation: string;
  },
): { packageId: string; reference: string } {
  authorise(ctx, 'DESIGN_INFORMATION', 'C');

  if (!input.reference.trim() || !input.title.trim()) {
    throw new DomainError('PACKAGE_UNNAMED', 'A design package carries a reference the project knows it by and a title.');
  }
  if (!input.leadDesigner.trim() || !input.leadOrganisation.trim()) {
    throw new DomainError(
      'PACKAGE_UNLED',
      'Name the lead designer and the organisation they answer to. A package with no lead has no interface owner, and ' +
        'every expensive coordination failure lives at an interface both sides assumed the other held.',
    );
  }

  const existing = ctx.ledger
    .list(ctx.projectId, 'DesignPackage')
    .some((record) => record.state.reference === input.reference);
  if (existing) {
    throw new DomainError(
      'PACKAGE_REFERENCE_TAKEN',
      `${input.reference} is already a package on this project. Two packages with one reference is how a deliverable ends ` +
        'up planned twice and produced once.',
    );
  }

  const packageId = ulid();

  write(ctx, {
    eventType: 'DESIGN_PACKAGE_CREATED',
    entity: { refType: 'DesignPackage', refId: packageId },
    nextState: {
      id: packageId,
      projectId: ctx.projectId,
      reference: input.reference,
      title: input.title,
      discipline: input.discipline,
      zone: input.zone,
      leadDesigner: input.leadDesigner,
      leadOrganisation: input.leadOrganisation,
      deliverables: [],
      interfaces: [],
      createdBy: ctx.auth.actorId,
      createdAt: new Date().toISOString(),
    },
  });

  return { packageId, reference: input.reference };
}

/**
 * Plan one deliverable.
 *
 * The three date fields are the point of the whole record. `dueBy` is when the
 * author says it will be issued, `neededBy` is when the thing waiting for it
 * actually needs it, and `reviewDays` is how long the review between them
 * takes. Nobody types the answer; the platform subtracts.
 */
export function planDeliverable(
  ctx: EngineContext,
  packageId: string,
  input: {
    reference: string;
    title: string;
    kind: DeliverableKind;
    purpose: string;
    format: string;
    author: string;
    checker: string;
    approver: string;
    acceptingParty: string;
    dueBy: string;
    neededBy: string;
    neededFor: string;
    reviewDays: number;
  },
): { reference: string; slackDays: number; late: boolean } {
  authorise(ctx, 'DESIGN_INFORMATION', 'U');

  const record = requirePackage(ctx, packageId);
  const state = stateOf(record);

  if (state.deliverables.some((entry) => entry.reference === input.reference)) {
    throw new DomainError('DELIVERABLE_REFERENCE_TAKEN', `${input.reference} is already planned in ${state.reference}.`);
  }

  for (const [field, value] of [
    ['author', input.author],
    ['checker', input.checker],
    ['approver', input.approver],
    ['accepting party', input.acceptingParty],
  ] as const) {
    if (!value.trim()) {
      throw new DomainError(
        'DELIVERABLE_UNOWNED',
        `No ${field} is named for ${input.reference}. Author, checker, approver and accepting party are four different ` +
          'acts; a plan that collapses them into one "responsible" column has thrown away the separation that makes the ' +
          'check worth anything.',
      );
    }
  }
  if (input.author.trim() === input.checker.trim()) {
    throw new DomainError(
      'SELF_CHECK_PLANNED',
      `${input.author} is planned as both author and checker of ${input.reference}. That is not a check; it is the same ` +
        'person reading their own work with a second box to tick.',
    );
  }
  if (!input.purpose.trim() || !input.format.trim()) {
    throw new DomainError(
      'ISSUE_PURPOSE_MISSING',
      'State the issue purpose and the format. A deliverable issued "for information" and one issued "for construction" ' +
        'are the same file and entirely different instruments, and the difference is what a recipient is entitled to act on.',
    );
  }
  for (const [field, value] of [
    ['due', input.dueBy],
    ['needed', input.neededBy],
  ] as const) {
    if (Number.isNaN(Date.parse(value))) {
      throw new DomainError('DELIVERABLE_DATE_INVALID', `The ${field} date "${value}" is not a date.`);
    }
  }
  if (!Number.isFinite(input.reviewDays) || input.reviewDays < 0) {
    throw new DomainError(
      'REVIEW_PERIOD_REQUIRED',
      'State the review period in days. Zero is a legitimate answer where nothing reviews this; leaving it out is not, ' +
        'because then nothing can say whether the plan is achievable.',
    );
  }
  if (!input.neededFor.trim()) {
    throw new DomainError(
      'NEED_UNEXPLAINED',
      'Say what is waiting for this — the enquiry, the activity, the consent. A need date with nothing behind it is a date ' +
        'somebody will move when it becomes inconvenient.',
    );
  }

  // Issued on the due date, reviewed for the review period, and then needed.
  // Negative slack is a plan that does not work, and it is visible the day it
  // is written rather than the week it fails.
  const slackDays = daysBetween(input.dueBy, input.neededBy) - input.reviewDays;

  const deliverable: Deliverable = {
    reference: input.reference,
    title: input.title,
    kind: input.kind,
    purpose: input.purpose,
    format: input.format,
    author: input.author,
    checker: input.checker,
    approver: input.approver,
    acceptingParty: input.acceptingParty,
    dueBy: input.dueBy,
    neededBy: input.neededBy,
    neededFor: input.neededFor,
    reviewDays: input.reviewDays,
    state: 'WIP',
    history: [],
  };

  write(ctx, {
    eventType: 'DESIGN_RESPONSIBILITY_ASSIGNED',
    entity: { refType: 'DesignPackage', refId: packageId },
    nextState: { ...record.state, deliverables: [...state.deliverables, deliverable] },
  });

  // Reported, not refused. A plan with negative slack is a real plan that a
  // real project is working to, and refusing to record it would push it into a
  // spreadsheet where nothing can see it.
  return { reference: input.reference, slackDays, late: slackDays < 0 };
}

/**
 * An interface between this package and another, owned on both sides.
 *
 * One owner is a boundary somebody has drawn. Two owners is a boundary two
 * parties have agreed, and only the second is worth recording.
 */
export function recordInterface(
  ctx: EngineContext,
  packageId: string,
  input: { reference: string; description: string; withPackage: string; ourOwner: string; theirOwner: string; resolveBy: string },
): { reference: string } {
  authorise(ctx, 'DESIGN_INFORMATION', 'U');

  const record = requirePackage(ctx, packageId);
  const state = stateOf(record);

  if (!input.ourOwner.trim() || !input.theirOwner.trim()) {
    throw new DomainError(
      'INTERFACE_UNOWNED',
      `${input.reference} names an owner on only one side. Every expensive coordination failure lives at an interface both ` +
        'sides assumed the other held, and an interface with one name on it is exactly that assumption written down.',
    );
  }
  if (!input.description.trim()) {
    throw new DomainError('INTERFACE_UNDESCRIBED', 'Say what crosses this interface.');
  }
  if (Number.isNaN(Date.parse(input.resolveBy))) {
    throw new DomainError('INTERFACE_UNDATED', `"${input.resolveBy}" is not a date. An interface with no date is never late.`);
  }
  if (state.interfaces.some((entry) => entry.reference === input.reference)) {
    throw new DomainError('INTERFACE_REFERENCE_TAKEN', `${input.reference} is already recorded on ${state.reference}.`);
  }

  write(ctx, {
    eventType: 'DESIGN_RESPONSIBILITY_ASSIGNED',
    entity: { refType: 'DesignPackage', refId: packageId },
    nextState: {
      ...record.state,
      interfaces: [
        ...state.interfaces,
        {
          reference: input.reference,
          description: input.description,
          withPackage: input.withPackage,
          ourOwner: input.ourOwner,
          theirOwner: input.theirOwner,
          resolveBy: input.resolveBy,
          status: 'OPEN' as const,
        },
      ],
    },
  });

  return { reference: input.reference };
}

/** Agree an interface, with what was actually agreed rather than a tick. */
export function agreeInterface(
  ctx: EngineContext,
  packageId: string,
  input: { reference: string; what: string },
): void {
  authorise(ctx, 'DESIGN_INFORMATION', 'U');

  const record = requirePackage(ctx, packageId);
  const state = stateOf(record);
  const found = state.interfaces.find((entry) => entry.reference === input.reference);

  if (!found) throw new DomainError('INTERFACE_NOT_FOUND', `No interface ${input.reference} on ${state.reference}.`, 404);
  if (found.status === 'AGREED') throw new DomainError('INTERFACE_ALREADY_AGREED', `${input.reference} is already agreed.`);
  if (!input.what.trim()) {
    throw new DomainError(
      'AGREEMENT_UNSTATED',
      'Say what was agreed. An interface closed with nothing beside it cannot be told apart from one closed to tidy the ' +
        'register, and the two produce very different buildings.',
    );
  }

  write(ctx, {
    eventType: 'DESIGN_RESPONSIBILITY_ASSIGNED',
    entity: { refType: 'DesignPackage', refId: packageId },
    nextState: {
      ...record.state,
      interfaces: state.interfaces.map((entry) =>
        entry.reference === input.reference
          ? { ...entry, status: 'AGREED' as const, agreement: { what: input.what, at: new Date().toISOString(), by: ctx.auth.actorId } }
          : entry,
      ),
    },
  });
}

/**
 * Sublet the production of a deliverable.
 *
 * Delegation is not transfer, and the platform will not let it become one. The
 * author of record does not change and the package's interface obligations do
 * not move, because a lead designer who sublets a deliverable still owns the
 * boundaries it crosses. That is the rule the CDM regime already states and the
 * one most information plans quietly lose the moment a specialist is appointed.
 */
export function delegate(
  ctx: EngineContext,
  packageId: string,
  input: { deliverableReference: string; party: string; organisation: string; why: string },
): { author: string; interfacesStillOwnedByLead: number } {
  authorise(ctx, 'DESIGN_INFORMATION', 'U');

  const record = requirePackage(ctx, packageId);
  const state = stateOf(record);
  const deliverable = requireDeliverable(state, input.deliverableReference);

  if (!input.party.trim() || !input.organisation.trim() || !input.why.trim()) {
    throw new DomainError(
      'DELEGATION_UNSTATED',
      'Name who the work is sublet to, the organisation, and why. A delegation with no reason is indistinguishable from a ' +
        'transfer nobody accepted.',
    );
  }

  write(ctx, {
    eventType: 'DESIGN_RESPONSIBILITY_ASSIGNED',
    entity: { refType: 'DesignPackage', refId: packageId },
    nextState: {
      ...record.state,
      deliverables: state.deliverables.map((entry) =>
        entry.reference === input.deliverableReference
          ? {
              ...entry,
              delegatedTo: { party: input.party, organisation: input.organisation, why: input.why, at: new Date().toISOString() },
            }
          : entry,
      ),
    },
  });

  // Returned so the caller can say it rather than assume it.
  return {
    author: deliverable.author,
    interfacesStillOwnedByLead: state.interfaces.filter((entry) => entry.ourOwner === state.leadDesigner).length,
  };
}

/**
 * Move responsibility for a deliverable from one party to another.
 *
 * Both names or nothing. The commonest way a duty evaporates on a design
 * project is a reassignment the outgoing party made and the incoming party
 * never saw, and every record of it afterwards shows a clean handover.
 */
export function transferResponsibility(
  ctx: EngineContext,
  packageId: string,
  input: {
    deliverableReference: string;
    role: 'author' | 'checker' | 'approver' | 'acceptingParty';
    to: string;
    acceptedByOutgoing: string;
    acceptedByIncoming: string;
    reason: string;
  },
): { from: string; to: string } {
  authorise(ctx, 'DESIGN_INFORMATION', 'U');

  const record = requirePackage(ctx, packageId);
  const state = stateOf(record);
  const deliverable = requireDeliverable(state, input.deliverableReference);
  const from = deliverable[input.role];

  if (!input.acceptedByOutgoing.trim() || !input.acceptedByIncoming.trim()) {
    throw new DomainError(
      'TRANSFER_UNACCEPTED',
      'A responsibility transfer needs both parties: the one giving it up and the one taking it on. A reassignment the ' +
        'incoming party never saw reads afterwards exactly like a clean handover, which is how a duty evaporates.',
    );
  }
  if (!input.reason.trim()) {
    throw new DomainError('TRANSFER_UNEXPLAINED', 'Say why the responsibility moved.');
  }
  if (from === input.to) {
    throw new DomainError('TRANSFER_TO_SAME_PARTY', `${from} already holds ${input.role} on ${input.deliverableReference}.`);
  }
  // The separation the plan was created with has to survive the transfer.
  const after = { ...deliverable, [input.role]: input.to } as Deliverable;
  if (after.author === after.checker) {
    throw new DomainError(
      'SELF_CHECK_AFTER_TRANSFER',
      `That transfer would make ${input.to} both author and checker of ${input.deliverableReference}. The separation is ` +
        'worth as much after a reassignment as it was when the plan was written.',
    );
  }

  write(ctx, {
    eventType: 'DESIGN_RESPONSIBILITY_TRANSFERRED',
    entity: { refType: 'DesignPackage', refId: packageId },
    nextState: {
      ...record.state,
      deliverables: state.deliverables.map((entry) =>
        entry.reference === input.deliverableReference
          ? {
              ...after,
              // Kept, not replaced. Somebody who held a duty for four months
              // held it for four months, and an audit resolving only the
              // current holder reports the wrong party for every historic act.
              transfers: [
                ...((entry as unknown as { transfers?: unknown[] }).transfers ?? []),
                {
                  role: input.role,
                  from,
                  to: input.to,
                  reason: input.reason,
                  acceptedByOutgoing: input.acceptedByOutgoing,
                  acceptedByIncoming: input.acceptedByIncoming,
                  at: new Date().toISOString(),
                  recordedBy: ctx.auth.actorId,
                },
              ],
            }
          : entry,
      ),
    },
  });

  return { from, to: input.to };
}

/**
 * Move a deliverable along the CDE ladder.
 *
 * The one rule beneath the four states: nothing reaches Shared without an
 * author, a checker and its metadata. Everything visible to the project has
 * been through somebody other than the person who drew it.
 */
export function advanceDeliverable(
  ctx: EngineContext,
  packageId: string,
  input: { reference: string; to: CDEState },
): { from: CDEState; to: CDEState } {
  authorise(ctx, 'DESIGN_INFORMATION', 'U');

  const record = requirePackage(ctx, packageId);
  const state = stateOf(record);
  const deliverable = requireDeliverable(state, input.reference);
  const from = deliverable.state;

  if (!LADDER[from].includes(input.to)) {
    throw new DomainError(
      'CDE_TRANSITION_REFUSED',
      `${input.reference} is ${from.toLowerCase()} and cannot move to ${input.to.toLowerCase()}. The permitted moves from ` +
        `${from.toLowerCase()} are ${LADDER[from].join(', ').toLowerCase() || 'none — it is the end of the ladder'}.`,
    );
  }
  if (input.to === 'SHARED') {
    const missing = [
      deliverable.author.trim() ? '' : 'an author',
      deliverable.checker.trim() ? '' : 'a checker',
      deliverable.purpose.trim() ? '' : 'an issue purpose',
      deliverable.format.trim() ? '' : 'a format',
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new DomainError(
        'NOT_READY_TO_SHARE',
        `${input.reference} has ${missing.join(', ')} missing. Nothing reaches Shared without them: Shared is where the ` +
          'rest of the project starts reading it, and a recipient cannot tell an unchecked issue from a checked one.',
      );
    }
  }

  write(ctx, {
    eventType: 'DESIGN_RESPONSIBILITY_ASSIGNED',
    entity: { refType: 'DesignPackage', refId: packageId },
    nextState: {
      ...record.state,
      deliverables: state.deliverables.map((entry) =>
        entry.reference === input.reference
          ? {
              ...entry,
              state: input.to,
              history: [...entry.history, { from, to: input.to, by: ctx.auth.actorId, at: new Date().toISOString() }],
            }
          : entry,
      ),
    },
  });

  return { from, to: input.to };
}

// --- The MIDP ---------------------------------------------------------------

export type MIDPReconciliation = {
  packages: number;
  deliverables: number;
  /** One reference planned in more than one package. */
  duplicated: Array<{ reference: string; packages: string[] }>;
  /** An interface naming a package that does not exist on this project. */
  danglingInterfaces: Array<{ package: string; reference: string; namesPackage: string }>;
  /** Planned to arrive after the thing waiting for it needs it. */
  lateByPlan: Array<{ package: string; reference: string; slackDays: number; neededFor: string }>;
  openInterfaces: number;
  ready: boolean;
  summary: string;
};

/**
 * Reconcile every package's own plan into the project's.
 *
 * The MIDP is not a document somebody writes; it is what the TIDPs add up to.
 * Computing it is the only way it can ever disagree with them, which is the
 * point — a master plan maintained by hand beside the team plans it is supposed
 * to summarise diverges within a fortnight and nobody notices for a quarter.
 */
export function reconcileMIDP(ctx: EngineContext): MIDPReconciliation {
  authorise(ctx, 'DESIGN_INFORMATION', 'R');

  const packages = ctx.ledger.list(ctx.projectId, 'DesignPackage').map((record) => stateOf(record));
  const references = new Set(packages.map((entry) => entry.reference));

  const seen = new Map<string, string[]>();
  const lateByPlan: MIDPReconciliation['lateByPlan'] = [];
  const danglingInterfaces: MIDPReconciliation['danglingInterfaces'] = [];
  let openInterfaces = 0;

  for (const designPackage of packages) {
    for (const deliverable of designPackage.deliverables) {
      seen.set(deliverable.reference, [...(seen.get(deliverable.reference) ?? []), designPackage.reference]);
      const slackDays = daysBetween(deliverable.dueBy, deliverable.neededBy) - deliverable.reviewDays;
      if (slackDays < 0) {
        lateByPlan.push({
          package: designPackage.reference,
          reference: deliverable.reference,
          slackDays,
          neededFor: deliverable.neededFor,
        });
      }
    }
    for (const boundary of designPackage.interfaces) {
      if (boundary.status === 'OPEN') openInterfaces += 1;
      if (boundary.withPackage && !references.has(boundary.withPackage)) {
        danglingInterfaces.push({
          package: designPackage.reference,
          reference: boundary.reference,
          namesPackage: boundary.withPackage,
        });
      }
    }
  }

  const duplicated = [...seen.entries()]
    .filter(([, where]) => where.length > 1)
    .map(([reference, where]) => ({ reference, packages: where }));

  // Worst first, because a plan with forty problems is read from the top.
  lateByPlan.sort((a, b) => a.slackDays - b.slackDays);

  const deliverables = packages.reduce((count, entry) => count + entry.deliverables.length, 0);
  const ready = duplicated.length === 0 && danglingInterfaces.length === 0 && lateByPlan.length === 0;

  const parts = [`${packages.length} package${packages.length === 1 ? '' : 's'}`, `${deliverables} deliverables`];
  if (duplicated.length > 0) parts.push(`${duplicated.length} planned in more than one package`);
  if (danglingInterfaces.length > 0) parts.push(`${danglingInterfaces.length} interface(s) naming a package that does not exist`);
  if (lateByPlan.length > 0) parts.push(`${lateByPlan.length} planned to arrive after they are needed`);
  if (openInterfaces > 0) parts.push(`${openInterfaces} interface(s) still open`);

  return {
    packages: packages.length,
    deliverables,
    duplicated,
    danglingInterfaces,
    lateByPlan,
    openInterfaces,
    ready,
    summary: parts.join(', ') + '.',
  };
}

/**
 * Approve the MIDP.
 *
 * Refused while the reconciliation shows a contradiction, because approving a
 * plan the platform can already prove does not work is the signature that makes
 * everything downstream somebody else's problem.
 */
export function approveMIDP(ctx: EngineContext, input: { cutOff: string; note: string }): { midpId: string; deliverables: number } {
  authorise(ctx, 'DESIGN_INFORMATION', 'A');

  const reconciliation = reconcileMIDP(ctx);

  if (reconciliation.packages === 0) {
    throw new DomainError('NO_PACKAGES', 'There is no design package on this project, so there is no plan to approve.');
  }
  if (!reconciliation.ready) {
    const reasons: string[] = [];
    if (reconciliation.duplicated.length > 0) {
      reasons.push(
        `${reconciliation.duplicated
          .map((entry) => `${entry.reference} is planned in ${entry.packages.join(' and ')}`)
          .join('; ')} — one reference produced twice is one produced once and paid for twice`,
      );
    }
    if (reconciliation.danglingInterfaces.length > 0) {
      reasons.push(
        `${reconciliation.danglingInterfaces
          .map((entry) => `${entry.package}/${entry.reference} names package ${entry.namesPackage}`)
          .join('; ')}, which is not on this project`,
      );
    }
    if (reconciliation.lateByPlan.length > 0) {
      reasons.push(
        `${reconciliation.lateByPlan
          .map(
            (entry) =>
              `${entry.package}/${entry.reference} is ${Math.abs(entry.slackDays)} days late for ${entry.neededFor} on the ` +
              'plan as written',
          )
          .join('; ')}`,
      );
    }
    throw new DomainError(
      'MIDP_DOES_NOT_RECONCILE',
      `This plan cannot be approved as it stands: ${reasons.join('. ')}. Approving a plan the platform can already prove ` +
        'does not work is the signature that makes everything downstream somebody else’s problem.',
      409,
    );
  }
  if (!input.note.trim() || Number.isNaN(Date.parse(input.cutOff))) {
    throw new DomainError('MIDP_CUT_OFF_REQUIRED', 'An approved plan carries the date it was cut off at and what it rests on.');
  }

  const midpId = ulid();

  write(ctx, {
    eventType: 'MIDP_APPROVED',
    entity: { refType: 'MIDP', refId: midpId },
    nextState: {
      id: midpId,
      projectId: ctx.projectId,
      cutOff: input.cutOff,
      note: input.note,
      packages: reconciliation.packages,
      deliverables: reconciliation.deliverables,
      openInterfaces: reconciliation.openInterfaces,
      approvedBy: ctx.auth.actorId,
      approvedAt: new Date().toISOString(),
    },
  });

  return { midpId, deliverables: reconciliation.deliverables };
}

// --- The position -----------------------------------------------------------

export type DesignPlanPosition = {
  packages: Array<{
    packageId: string;
    reference: string;
    title: string;
    discipline: string;
    zone: string;
    leadDesigner: string;
    deliverables: number;
    shared: number;
    published: number;
    delegated: number;
    openInterfaces: number;
    /** Interfaces past the date they were to be resolved by. */
    overdueInterfaces: number;
    worstSlackDays: number;
  }>;
  midp: MIDPReconciliation;
  approvedMIDP?: { cutOff: string; approvedAt: string; deliverables: number };
  summary: string;
};

export function designPlanPosition(ctx: EngineContext, today = new Date().toISOString().slice(0, 10)): DesignPlanPosition {
  authorise(ctx, 'DESIGN_INFORMATION', 'R');

  const packages = ctx.ledger.list(ctx.projectId, 'DesignPackage').map((record) => {
    const state = stateOf(record);
    const slacks = state.deliverables.map(
      (entry) => daysBetween(entry.dueBy, entry.neededBy) - entry.reviewDays,
    );
    return {
      packageId: state.id,
      reference: state.reference,
      title: state.title,
      discipline: state.discipline,
      zone: state.zone,
      leadDesigner: state.leadDesigner,
      deliverables: state.deliverables.length,
      shared: state.deliverables.filter((entry) => entry.state === 'SHARED').length,
      published: state.deliverables.filter((entry) => entry.state === 'PUBLISHED').length,
      delegated: state.deliverables.filter((entry) => entry.delegatedTo !== undefined).length,
      openInterfaces: state.interfaces.filter((entry) => entry.status === 'OPEN').length,
      overdueInterfaces: state.interfaces.filter((entry) => entry.status === 'OPEN' && entry.resolveBy < today).length,
      // Infinity would not serialise; a package with nothing planned has no
      // worst case, and zero would read as "tight" rather than "empty".
      worstSlackDays: slacks.length === 0 ? 0 : Math.min(...slacks),
    };
  });

  packages.sort((a, b) => a.worstSlackDays - b.worstSlackDays);

  const approved = ctx.ledger.list(ctx.projectId, 'MIDP').at(-1);
  const midp = reconcileMIDP(ctx);

  return {
    packages,
    midp,
    approvedMIDP: approved
      ? {
          cutOff: String(approved.state.cutOff),
          approvedAt: String(approved.state.approvedAt),
          deliverables: Number(approved.state.deliverables ?? 0),
        }
      : undefined,
    summary: midp.summary,
  };
}
