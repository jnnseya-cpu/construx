import { hashState } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, write, type EngineContext } from '../engines/context.ts';
import { rolesAllow, type CapabilityArea } from '../identity/roles.ts';
import { clearedFor, type DataSensitivity } from '../identity/abac.ts';

/**
 * CN-WF-11 — meeting, action, communication and decision control.
 *
 * Most of this workflow was built and is reused rather than rebuilt.
 * `domain/meetings.ts` already holds the meeting record, attendance with
 * apologies, the agenda in the words used, actions with an owner and a date,
 * carry-forward that never resets the original date, closure with a note rather
 * than a tick, issue-once, and a correction recorded beside issued minutes with
 * both versions readable. None of that is touched.
 *
 * Three things were genuinely absent, and each is one of the acceptance
 * criteria.
 *
 * **The same action, counted twice.** AC-CN-WF-11-01. Actions are raised in a
 * meeting, on a non-conformance, against a safety observation and at a stage
 * gate, and every one of those registers reported its own. A person reading two
 * screens saw the same commitment twice and could not tell that it was one. The
 * register here derives a **stable identity from the source record** — the
 * action's own reference within the entity that raised it — so an action has
 * exactly one identity however many views read it. Nothing is copied: the
 * source register stays the only writer of its own actions, and this reads.
 *
 * **Minutes that changed after they were approved.** AC-CN-WF-11-02. Issue
 * already froze the narrative, but closing an action is deliberately permitted
 * afterwards — the register is live and freezing it would need a new meeting for
 * every closure. That means the *state* of an issued meeting is not what the
 * chair approved, and a minutes document regenerated in November would show
 * October's actions closed. Approval takes a hash-addressed snapshot of exactly
 * what was approved; issue is refused if the draft has moved since.
 *
 * **A decision with no alternatives.** AC-CN-WF-11-03. A material decision that
 * records only what was chosen is an instruction being minuted. What makes it a
 * decision, and what a reader six months later needs, is what else was on the
 * table and why it was not taken. Impacts are stated per dimension including
 * where there are none, because an unassessed impact and a nil impact look
 * identical when the field is simply absent.
 *
 * The specification's guardrail is kept exactly: the platform never converts a
 * decision into a contractual instruction. A decision that needs one says so and
 * stays on the outstanding list until `informationcontrol.issueInstruction`
 * records that a person issued it.
 */

// --- Approved minutes -------------------------------------------------------

/**
 * What is hashed at approval.
 *
 * The parts a reader of the minutes relies on, and nothing else. Deliberately
 * not the whole record: `issuedAt`, `openedBy` and the corrections list all
 * change legitimately after approval, and including them would make every
 * approval instantly stale for reasons that have nothing to do with what was
 * agreed.
 */
type ApprovedContent = {
  reference: string;
  title: string;
  heldAt: string;
  chair: string;
  attendees: unknown;
  agenda: unknown;
  /** The actions as agreed — the wording, owner and date, not their status. */
  actions: Array<{ reference: string; what: string; owner: string; ownerOrganisation: string; by: string }>;
};

function approvedContentOf(state: Record<string, unknown>): ApprovedContent {
  const actions = (state.actions as Array<Record<string, unknown>> | undefined) ?? [];
  return {
    reference: String(state.reference),
    title: String(state.title),
    heldAt: String(state.heldAt),
    chair: String(state.chair),
    attendees: state.attendees,
    agenda: state.agenda,
    actions: actions.map((action) => ({
      reference: String(action.reference),
      what: String(action.what),
      owner: String(action.owner),
      ownerOrganisation: String(action.ownerOrganisation),
      by: String(action.by),
    })),
  };
}

export type MinutesVersion = {
  versionId: string;
  meetingId: string;
  meetingReference: string;
  approvedBy: string;
  approvedAt: string;
  contentHash: string;
  content: ApprovedContent;
};

function versionsOf(ctx: EngineContext, meetingId?: string): MinutesVersion[] {
  return ctx.ledger
    .list(ctx.projectId, 'MinutesVersion')
    .map((record) => record.state as unknown as MinutesVersion)
    .filter((version) => meetingId === undefined || version.meetingId === meetingId);
}

/**
 * The chair approves the minutes as they stand.
 *
 * Step 3 of the deterministic flow, and the step the platform did not have: the
 * chair reviewed and issued in one act, so there was no recorded moment at which
 * a named person said "this is what we agreed" against a fixed text.
 */
export function approveMinutes(
  ctx: EngineContext,
  meetingId: string,
  input: { approvedBy: string; note?: string },
): { versionId: string; contentHash: string; approvedAt: string } {
  // The chair approves. The matrix gives the minute-taker C and U and the chair
  // A, and approval is the chair's act — the same split that governs issue.
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = ctx.ledger.get({ refType: 'SiteMeeting', refId: meetingId });
  if (!record) throw new DomainError('MEETING_NOT_FOUND', `No meeting ${meetingId}`, 404);

  if (record.state.status === 'ISSUED') {
    throw new DomainError(
      'MINUTES_ISSUED',
      `${String(record.state.reference)} has already been issued. Approving them now would record an approval of a text ` +
        'that went out before anybody approved it.',
    );
  }
  if (((record.state.agenda as unknown[] | undefined) ?? []).length === 0) {
    throw new DomainError('NOTHING_MINUTED', 'Nothing was recorded as discussed, so there is nothing to approve.');
  }
  if (!input.approvedBy.trim()) {
    throw new DomainError(
      'APPROVAL_UNSIGNED',
      'Name the person approving the minutes. "The chair" is not a person, and the whole value of an approved version is ' +
        'that somebody stood behind it.',
    );
  }

  const content = approvedContentOf(record.state);
  const contentHash = hashState(content);

  const existing = versionsOf(ctx, meetingId);
  const previous = existing[existing.length - 1];
  if (previous && previous.contentHash === contentHash) {
    throw new DomainError(
      'ALREADY_APPROVED',
      `${String(record.state.reference)} was approved by ${previous.approvedBy} on ${previous.approvedAt.slice(0, 10)} and ` +
        'has not changed since. A second approval of the same text records nothing.',
    );
  }

  const versionId = ulid();
  const approvedAt = new Date().toISOString();

  write(ctx, {
    eventType: 'MINUTES_APPROVED',
    entity: { refType: 'MinutesVersion', refId: versionId },
    nextState: {
      versionId,
      projectId: ctx.projectId,
      meetingId,
      meetingReference: String(record.state.reference),
      // The revision number is the count, so a re-approval after an edit is
      // visible as a second version rather than replacing the first.
      revision: existing.length + 1,
      approvedBy: input.approvedBy,
      approvedAt,
      approvedByActor: ctx.auth.actorId,
      note: input.note ?? '',
      contentHash,
      content,
    },
  });

  return { versionId, contentHash, approvedAt };
}

/**
 * Why issue is refused, or null.
 *
 * Binds only where the workflow is in use. A project that has never approved a
 * set of minutes gets null, so this can never invent a requirement for a project
 * that predates it — the same rule every other guard in the construction block
 * follows.
 */
export function minutesIssueBlockedReason(ctx: EngineContext, meetingId: string): string | null {
  const anyApproval = ctx.ledger.list(ctx.projectId, 'MinutesVersion');
  if (anyApproval.length === 0) return null;

  const record = ctx.ledger.get({ refType: 'SiteMeeting', refId: meetingId });
  if (!record) return null;

  const versions = versionsOf(ctx, meetingId);
  const latest = versions[versions.length - 1];
  if (!latest) {
    return (
      `${String(record.state.reference)} has not been approved. This project approves minutes before issuing them, and ` +
      'issuing an unapproved set means nobody has said the text is what was agreed.'
    );
  }

  const current = hashState(approvedContentOf(record.state));
  if (current !== latest.contentHash) {
    return (
      `${String(record.state.reference)} has changed since ${latest.approvedBy} approved it on ` +
      `${latest.approvedAt.slice(0, 10)}. Issuing now would send out a text nobody approved. Approve the amended minutes, ` +
      'which records a second version beside the first.'
    );
  }

  return null;
}

/**
 * The exact version that was approved, for anything that reproduces the minutes.
 *
 * AC-CN-WF-11-02 as one call. A document generated from live state would show
 * actions that have since been closed; this returns what was agreed on the day.
 */
export function approvedVersionOf(ctx: EngineContext, meetingId: string): MinutesVersion | undefined {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'R');
  const versions = versionsOf(ctx, meetingId);
  return versions[versions.length - 1];
}

// --- The decision record ----------------------------------------------------

export type DecisionImpactDimension = 'COST' | 'TIME' | 'QUALITY' | 'SAFETY' | 'SCOPE';

export const IMPACT_DIMENSION: readonly DecisionImpactDimension[] = ['COST', 'TIME', 'QUALITY', 'SAFETY', 'SCOPE'];

export type DecisionImpact = {
  dimension: DecisionImpactDimension;
  /**
   * `NONE` is a stated assessment, not an absence.
   *
   * An impact nobody assessed and an impact somebody assessed as nil look
   * identical when the field is simply left out, and only one of them is safe.
   */
  effect: 'NONE' | 'ADVERSE' | 'BENEFICIAL' | 'UNQUANTIFIED';
  detail: string;
};

export type DecisionAlternative = {
  option: string;
  /** Why it was not taken. An alternative listed without this is a menu. */
  whyNot: string;
};

export type DecisionRecordState = {
  decisionId: string;
  reference: string;
  subject: string;
  decision: string;
  rationale: string;
  authority: { name: string; role: string; basis: string };
  alternatives: DecisionAlternative[];
  impacts: DecisionImpact[];
  references: Array<{ register: string; reference: string }>;
  meetingId?: string;
  confidentiality: DataSensitivity;
  requiresInstruction: boolean;
  instructionReference?: string;
  decidedAt: string;
};

const RATIONALE_FLOOR = 30;

/**
 * Record a material decision.
 *
 * Governance decisions are human by construction — the event carries
 * `aiAllowed: false` and no agent mandate reaches `DECIDE`. The specification's
 * guardrail is that AI "cannot turn discussion into contractual instruction or
 * accepted decision without chair/authority", and the way that is enforced here
 * is that recording one needs approve authority and names the human who holds
 * it.
 */
export function recordDecision(
  ctx: EngineContext,
  input: {
    subject: string;
    decision: string;
    rationale: string;
    authority: { name: string; role: string; basis: string };
    alternatives: DecisionAlternative[];
    impacts: DecisionImpact[];
    references?: Array<{ register: string; reference: string }>;
    meetingId?: string;
    /**
     * Restricted classification for a legal or commercially sensitive
     * discussion, which is the exception control this workflow names. A decision
     * taken on legal advice is `LEGAL_L4` and is withheld from roles that do not
     * hold it, by the same ABAC rule that governs a contract's liability
     * provisions.
     */
    confidentiality?: DataSensitivity;
    /** True where giving effect to it needs a contractual instruction. */
    requiresInstruction?: boolean;
  },
): { decisionId: string; reference: string } {
  const confidentiality = input.confidentiality ?? 'INTERNAL';
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'A', {
    lifecyclePhase: currentPhase(ctx),
    dataSensitivity: confidentiality,
  });

  if (!input.subject.trim() || !input.decision.trim()) {
    throw new DomainError('DECISION_UNSTATED', 'A decision record says what was being decided and what was decided.');
  }
  if (!input.authority.name.trim() || !input.authority.role.trim() || !input.authority.basis.trim()) {
    throw new DomainError(
      'AUTHORITY_REQUIRED',
      'Name the person who took the decision, the role they took it in and what gives them that authority. A decision ' +
        'attributed to "the team" binds nobody and is the first thing challenged.',
    );
  }
  if (input.rationale.trim().length < RATIONALE_FLOOR) {
    throw new DomainError(
      'RATIONALE_REQUIRED',
      'Say why. A decision recorded with no reasoning cannot be defended by anyone who was not in the room, which is ' +
        'everybody who reads it later.',
    );
  }
  if (input.alternatives.length === 0) {
    throw new DomainError(
      'ALTERNATIVES_REQUIRED',
      'Record what else was considered. A decision with no alternative beside it is an instruction being minuted, and the ' +
        'question asked of it later is always what else you looked at.',
    );
  }
  const unexplained = input.alternatives.find((alternative) => !alternative.option.trim() || !alternative.whyNot.trim());
  if (unexplained) {
    throw new DomainError(
      'ALTERNATIVE_UNEXPLAINED',
      `"${unexplained.option || '(unnamed)'}" is listed as an alternative with no reason it was not taken. An alternative ` +
        'without that is a menu, not a consideration.',
    );
  }

  const assessed = new Set(input.impacts.map((impact) => impact.dimension));
  const missing = IMPACT_DIMENSION.filter((dimension) => !assessed.has(dimension));
  if (missing.length > 0) {
    throw new DomainError(
      'IMPACTS_UNASSESSED',
      `No assessment of the ${missing.join(', ').toLowerCase()} impact. Record NONE where there is none — an impact nobody ` +
        'looked at and an impact somebody assessed as nil are indistinguishable when the field is left out, and only one ' +
        'of them is safe.',
    );
  }
  const undetailed = input.impacts.find((impact) => impact.effect !== 'NONE' && !impact.detail.trim());
  if (undetailed) {
    throw new DomainError(
      'IMPACT_UNQUANTIFIED',
      `The ${undetailed.dimension.toLowerCase()} impact is recorded as ${undetailed.effect} with nothing said about it. ` +
        'Say what the effect is, or record UNQUANTIFIED with what is not yet known.',
    );
  }

  if (input.meetingId && !ctx.ledger.get({ refType: 'SiteMeeting', refId: input.meetingId })) {
    throw new DomainError('MEETING_NOT_FOUND', `No meeting ${input.meetingId}`, 404);
  }

  const sequence = ctx.ledger.list(ctx.projectId, 'DecisionRecord').length + 1;
  const reference = `DR-${String(sequence).padStart(4, '0')}`;
  const decisionId = ulid();

  write(ctx, {
    eventType: 'DECISION_RECORDED',
    entity: { refType: 'DecisionRecord', refId: decisionId },
    nextState: {
      decisionId,
      projectId: ctx.projectId,
      reference,
      subject: input.subject,
      decision: input.decision,
      rationale: input.rationale,
      authority: input.authority,
      alternatives: input.alternatives,
      impacts: input.impacts,
      references: input.references ?? [],
      meetingId: input.meetingId,
      confidentiality,
      requiresInstruction: input.requiresInstruction ?? false,
      decidedBy: ctx.auth.actorId,
      decidedAt: new Date().toISOString(),
    },
  });

  return { decisionId, reference };
}

/**
 * Record that the instruction giving effect to a decision has been issued.
 *
 * The platform does not issue it. `informationcontrol.issueInstruction` is the
 * only thing that issues an instruction, a person calls it, and this records the
 * reference so the decision comes off the outstanding list.
 */
export function linkInstruction(
  ctx: EngineContext,
  decisionId: string,
  input: { instructionReference: string },
): { reference: string } {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = ctx.ledger.get({ refType: 'DecisionRecord', refId: decisionId });
  if (!record) throw new DomainError('DECISION_NOT_FOUND', `No decision ${decisionId}`, 404);

  if (!input.instructionReference.trim()) {
    throw new DomainError('INSTRUCTION_REFERENCE_REQUIRED', 'Give the reference of the instruction that was issued.');
  }
  if (record.state.instructionReference) {
    throw new DomainError(
      'INSTRUCTION_ALREADY_LINKED',
      `${String(record.state.reference)} already carries instruction ${String(record.state.instructionReference)}.`,
    );
  }

  write(ctx, {
    eventType: 'DECISION_INSTRUCTION_LINKED',
    entity: { refType: 'DecisionRecord', refId: decisionId },
    nextState: { ...record.state, instructionReference: input.instructionReference },
  });

  return { reference: String(record.state.reference) };
}

// --- The action register ----------------------------------------------------

export type RegisterAction = {
  /**
   * Stable across every view, and derived rather than allocated.
   *
   * It is the source entity's own reference for the action, so two screens
   * reading two registers arrive at the same identity for the same commitment
   * and the dashboard cannot double-count it. Nothing here allocates an id of
   * its own, which would be a second identity for the same thing.
   */
  actionId: string;
  source: 'MEETING' | 'NCR' | 'SAFETY_OBSERVATION' | 'STAGE_GATE';
  sourceReference: string;
  what: string;
  owner: string;
  ownerOrganisation?: string;
  due?: string;
  status: 'OPEN' | 'CLOSED';
  daysOverdue: number;
  /** Who it escalates to next, given how late it is. */
  escalateTo?: string;
};

/**
 * The escalation ladder.
 *
 * Days rather than money, and roles rather than names — the exception control
 * says escalation "respects role hierarchy", so it climbs the hierarchy the
 * permission matrix already defines rather than a list of people somebody has
 * to maintain. Nothing escalates on the day it is due; a day late is late, two
 * weeks late is somebody else's problem.
 */
const ESCALATION: ReadonlyArray<{ afterDays: number; to: string }> = [
  { afterDays: 1, to: 'PROJECT_MANAGER' },
  { afterDays: 7, to: 'PROJECT_DIRECTOR' },
  { afterDays: 21, to: 'OWNER' },
];

function escalationFor(daysOverdue: number): string | undefined {
  let escalateTo: string | undefined;
  for (const step of ESCALATION) if (daysOverdue >= step.afterDays) escalateTo = step.to;
  return escalateTo;
}

function lateness(due: string | undefined, today: string): number {
  if (!due || Number.isNaN(Date.parse(due))) return 0;
  return Math.max(0, Math.floor((Date.parse(today) - Date.parse(due)) / 86_400_000));
}

/** Whether the caller may read a source at all. Not a throw — a filter. */
function mayRead(ctx: EngineContext, area: CapabilityArea): boolean {
  return rolesAllow(ctx.auth.roles, area, 'R');
}

/**
 * Every open commitment on the project, once each.
 *
 * AC-CN-WF-11-01. Reads the registers that raise actions; writes nothing. A
 * source the caller cannot read is omitted rather than refused, because a
 * register that threw on the first entry a quantity surveyor could not see would
 * be unusable for everyone — but a safety action still never reaches a role
 * without safety read, which is the point of filtering rather than redacting.
 */
export function actionRegister(
  ctx: EngineContext,
  today = new Date().toISOString().slice(0, 10),
): RegisterAction[] {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'R');

  const actions: RegisterAction[] = [];

  if (mayRead(ctx, 'LOOKAHEAD_CONSTRAINTS')) {
    for (const record of ctx.ledger.list(ctx.projectId, 'SiteMeeting')) {
      const state = record.state as Record<string, unknown>;
      const meetingActions = (state.actions as Array<Record<string, unknown>> | undefined) ?? [];
      for (const action of meetingActions) {
        const due = (action.originallyDue as string | undefined) ?? (action.by as string | undefined);
        const daysOverdue = action.status === 'OPEN' ? lateness(due, today) : 0;
        actions.push({
          actionId: String(action.reference),
          source: 'MEETING',
          sourceReference: String(state.reference),
          what: String(action.what),
          owner: String(action.owner),
          ownerOrganisation: String(action.ownerOrganisation),
          due,
          status: action.status === 'CLOSED' ? 'CLOSED' : 'OPEN',
          daysOverdue,
          escalateTo: escalationFor(daysOverdue),
        });
      }
    }
  }

  if (mayRead(ctx, 'QUALITY_COMMISSIONING')) {
    for (const record of ctx.ledger.list(ctx.projectId, 'NCR')) {
      const state = record.state as Record<string, unknown>;
      const corrective = state.correctiveAction as Record<string, unknown> | undefined;
      if (!corrective) continue;
      const open = state.status !== 'CLOSED';
      const due = corrective.by as string | undefined;
      const daysOverdue = open ? lateness(due, today) : 0;
      actions.push({
        // The NCR raises one corrective action, so the NCR's own reference is
        // the action's identity. Inventing `NCR-001/A01` here would be a second
        // identity for a thing that already has one.
        actionId: `${String(state.reference)}/CA`,
        source: 'NCR',
        sourceReference: String(state.reference),
        what: String(corrective.corrective ?? ''),
        owner: String(corrective.owner ?? ''),
        due,
        status: open ? 'OPEN' : 'CLOSED',
        daysOverdue,
        escalateTo: escalationFor(daysOverdue),
      });
    }
  }

  if (mayRead(ctx, 'SAFETY_RAMS')) {
    for (const record of ctx.ledger.list(ctx.projectId, 'SafetyObservation')) {
      const state = record.state as Record<string, unknown>;
      const open = state.status !== 'CLOSED';
      actions.push({
        actionId: `${String(state.id)}/ACTION`,
        source: 'SAFETY_OBSERVATION',
        sourceReference: String(state.location ?? ''),
        what: String(state.recommendedControls || state.description),
        owner: String(state.owner ?? state.reportedBy ?? ''),
        // A safety observation carries no due date: the platform does not invent
        // one, and its lateness is measured from when it was reported rather
        // than from a date nobody agreed.
        due: undefined,
        status: open ? 'OPEN' : 'CLOSED',
        daysOverdue: open ? lateness(String(state.reportedAt ?? '').slice(0, 10), today) : 0,
        escalateTo: open ? escalationFor(lateness(String(state.reportedAt ?? '').slice(0, 10), today)) : undefined,
      });
    }
  }

  if (mayRead(ctx, 'PROJECT_SETUP')) {
    for (const record of ctx.ledger.list(ctx.projectId, 'StageInstance')) {
      const state = record.state as Record<string, unknown>;
      const gateActions = (state.openActions as Array<Record<string, unknown>> | undefined) ?? [];
      for (const action of gateActions) {
        const due = action.dueDate as string | undefined;
        const open = action.status !== 'CLOSED';
        const daysOverdue = open ? lateness(due, today) : 0;
        actions.push({
          actionId: String(action.id ?? action.reference ?? `${String(state.stage)}/${String(action.description)}`),
          source: 'STAGE_GATE',
          sourceReference: String(state.stage ?? ''),
          what: String(action.description ?? action.what ?? ''),
          owner: String(action.owner ?? ''),
          due,
          status: open ? 'OPEN' : 'CLOSED',
          daysOverdue,
          escalateTo: escalationFor(daysOverdue),
        });
      }
    }
  }

  actions.sort((a, b) => b.daysOverdue - a.daysOverdue);
  return actions;
}

// --- The position -----------------------------------------------------------

export type DecisionControlPosition = {
  actions: RegisterAction[];
  /** Grouped for a role dashboard, which is the same list read by owner. */
  byOwner: Array<{ owner: string; open: number; overdue: number }>;
  escalations: RegisterAction[];
  decisions: Array<{
    reference: string;
    subject: string;
    decision: string;
    authority: string;
    alternativesConsidered: number;
    adverseImpacts: DecisionImpactDimension[];
    requiresInstruction: boolean;
    instructionReference?: string;
  }>;
  /** Decisions that need an instruction and have not had one issued. */
  awaitingInstruction: string[];
  unapprovedMinutes: Array<{ meetingId: string; reference: string; reason: string }>;
  summary: string;
};

export function decisionControlPosition(
  ctx: EngineContext,
  today = new Date().toISOString().slice(0, 10),
): DecisionControlPosition {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'R');

  const actions = actionRegister(ctx, today);
  const open = actions.filter((action) => action.status === 'OPEN');

  const owners = new Map<string, { open: number; overdue: number }>();
  for (const action of open) {
    const key = action.owner || '(unassigned)';
    const entry = owners.get(key) ?? { open: 0, overdue: 0 };
    entry.open += 1;
    if (action.daysOverdue > 0) entry.overdue += 1;
    owners.set(key, entry);
  }

  const decisions = ctx.ledger
    .list(ctx.projectId, 'DecisionRecord')
    .map((record) => record.state as unknown as DecisionRecordState)
    // A restricted decision is withheld from a role that does not hold the
    // classification, by the same rule the rest of the platform applies.
    .filter((decision) => canSee(ctx, decision.confidentiality));

  const unapprovedMinutes: DecisionControlPosition['unapprovedMinutes'] = [];
  if (ctx.ledger.list(ctx.projectId, 'MinutesVersion').length > 0) {
    for (const record of ctx.ledger.list(ctx.projectId, 'SiteMeeting')) {
      if (record.state.status === 'ISSUED') continue;
      const reason = minutesIssueBlockedReason(ctx, String(record.state.id));
      if (reason) {
        unapprovedMinutes.push({ meetingId: String(record.state.id), reference: String(record.state.reference), reason });
      }
    }
  }

  const escalations = open.filter((action) => action.escalateTo !== undefined);
  const awaitingInstruction = decisions
    .filter((decision) => decision.requiresInstruction && !decision.instructionReference)
    .map((decision) => decision.reference);

  const parts = [`${open.length} action${open.length === 1 ? '' : 's'} open across every register`];
  if (escalations.length > 0) parts.push(`${escalations.length} past the date agreed`);
  if (decisions.length > 0) parts.push(`${decisions.length} decision${decisions.length === 1 ? '' : 's'} recorded`);
  if (awaitingInstruction.length > 0) parts.push(`${awaitingInstruction.length} awaiting an instruction`);
  if (unapprovedMinutes.length > 0) parts.push(`${unapprovedMinutes.length} set of minutes not approved`);

  return {
    actions,
    byOwner: [...owners.entries()]
      .map(([owner, counts]) => ({ owner, ...counts }))
      .sort((a, b) => b.overdue - a.overdue || b.open - a.open),
    escalations,
    decisions: decisions.map((decision) => ({
      reference: decision.reference,
      subject: decision.subject,
      decision: decision.decision,
      authority: `${decision.authority.name} (${decision.authority.role})`,
      alternativesConsidered: decision.alternatives.length,
      adverseImpacts: decision.impacts.filter((i) => i.effect === 'ADVERSE').map((i) => i.dimension),
      requiresInstruction: decision.requiresInstruction,
      instructionReference: decision.instructionReference,
    })),
    awaitingInstruction,
    unapprovedMinutes,
    summary: parts.join(', ') + '.',
  };
}

/**
 * Whether the caller may see a restricted decision.
 *
 * Reads the same clearance the access decision reads, rather than a second list
 * of roles kept beside it. Filtering here rather than refusing the whole call is
 * deliberate: a legally privileged decision is withheld from a role without the
 * clearance, and the rest of the position still answers.
 */
function canSee(ctx: EngineContext, confidentiality: DataSensitivity): boolean {
  return clearedFor(ctx.auth.roles, confidentiality);
}
