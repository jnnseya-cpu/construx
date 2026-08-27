import { hashEvidence } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import { lookupEventType } from '../goldenthread/eventTypes.ts';
import { replayProject } from '../goldenthread/replay.ts';
import { constructabilityPosition, freezeBlockersFor } from './constructability.ts';
import { designBaselinePosition } from './designbaseline.ts';
import { designChangePosition } from './designchange.ts';

/**
 * The stage gate Definition of Done — 7.4 and 8.4.
 *
 * The two are **word for word identical** in the specification, and so is 6.4.
 * What differs between them is not the standard but the evidence each is
 * answered from, so the clause list, the titles, the `NOT_ASSESSABLE` rule, the
 * AI clause, the replay clause and the report arithmetic are shared outright:
 * `evaluateDesignGate` answers the same seven from the design stage,
 * `evaluateTenderGate` from the tender, and `gateFor` picks by phase. Three
 * copies of "every approval satisfies party separation" would be three answers
 * to one question inside a year.
 *
 * The lifecycle already had a gate: `evaluatePhaseGate` counts the entities a
 * phase cannot be left without, and `transitionPhase` refuses a forward move
 * that does not clear it. That is a coarse check and it stays exactly as it is.
 * This is the seven-clause Definition of Done that sits on top of it, and the
 * difference between them is the difference between "an estimate exists" and
 * "this tender is finished".
 *
 * Seven clauses, each answered from the ledger. And one rule that matters more
 * than any of them:
 *
 * **A clause the platform cannot assess is reported as unassessable, never as
 * passed.** Two of the seven are partly unassessable today and say so by name.
 * A gate that quietly passes what it did not check is worse than no gate,
 * because it converts a gap into a signed assurance — and the signature is the
 * thing somebody relies on two years later.
 *
 * ---
 *
 * The seven, and how each is answered:
 *
 * 1. **Inputs complete.** The tender review frozen with no blocked package,
 *    every measurement schedule frozen with no error and nothing unpriced,
 *    every enquiry approved before it went out.
 * 2. **Approvals governed.** Re-verified from the events themselves rather than
 *    trusted because the command refused at the time — which is the point of
 *    checking twice, and catches anything written before a control existed.
 * 3. **Blockers closed.** Every critical finding, undisposed exclusion, open
 *    material query and open award departure, by name.
 * 4. **One cut-off.** Price, programme and information all stated against the
 *    same addendum.
 * 5. **AI accounted for.** Partly assessable: provider, model class, ACU
 *    settlement and confidence are on every AI event. Prompt version,
 *    assumptions and human disposition are not recorded at all, so this clause
 *    is `NOT_ASSESSABLE` and names exactly which three.
 * 6. **Replayable.** The whole event log re-verified against its own state and
 *    chain hashes.
 * 7. **Downstream created.** The budget and buyout targets come off the
 *    estimate without re-entry. Mobilisation tasks are not built, so this too
 *    is partly `NOT_ASSESSABLE`.
 */

export const GATE_CLAUSE = [
  'INPUTS_COMPLETE',
  'APPROVALS_GOVERNED',
  'BLOCKERS_CLOSED',
  'ONE_CUT_OFF',
  'AI_ACCOUNTED',
  'REPLAYABLE',
  'DOWNSTREAM_CREATED',
] as const;
export type GateClause = (typeof GATE_CLAUSE)[number];

/**
 * `NOT_ASSESSABLE` is not a softer `FAIL`. A failure is something the platform
 * checked and found wanting; this is something it cannot see at all, and the
 * two need different answers from a person.
 */
export type ClauseState = 'PASS' | 'FAIL' | 'NOT_ASSESSABLE';

export type ClauseResult = {
  clause: GateClause;
  title: string;
  state: ClauseState;
  detail: string;
  /** What is blocking, or what cannot be seen — named, never counted. */
  blocking: string[];
};

const TITLES: Record<GateClause, string> = {
  INPUTS_COMPLETE: 'Every mandatory input is present, validated and tied to its source version',
  APPROVALS_GOVERNED: 'Every approval satisfies authority and party separation',
  BLOCKERS_CLOSED: 'Every critical and major blocker is closed or conditioned',
  ONE_CUT_OFF: 'Cost, programme and information share one declared cut-off',
  AI_ACCOUNTED: 'Every AI output in the decision is fully accounted for',
  REPLAYABLE: 'The gate, the decision and the baseline replay from the event store',
  DOWNSTREAM_CREATED: 'Downstream obligations are created without re-entry',
};

type Row = Record<string, unknown>;

function list(ctx: EngineContext, refType: string): Row[] {
  return ctx.ledger.list(ctx.projectId, refType).map((record) => record.state);
}

// --- 1. Inputs --------------------------------------------------------------

function inputsComplete(ctx: EngineContext): ClauseResult {
  const blocking: string[] = [];

  const reviews = list(ctx, 'TenderReview');
  if (reviews.length === 0) {
    blocking.push('No tender review exists, so nothing has read the documents the price is built on');
  }
  for (const review of reviews) {
    if (review.status !== 'FROZEN') {
      blocking.push(`${String(review.reference)} is not frozen, so the information the price rests on is still moving`);
    }
    const blocked = (review.blockedPackages as string[]) ?? [];
    if (blocked.length > 0) {
      blocking.push(`${String(review.reference)} cannot price ${blocked.join(', ')} — a document is missing or unreadable`);
    }
  }

  const schedules = list(ctx, 'MeasurementSchedule');
  for (const schedule of schedules) {
    if (schedule.status !== 'FROZEN') {
      blocking.push(`${String(schedule.reference)} is not frozen, so the measured quantities are still moving`);
    }
  }

  const enquiries = list(ctx, 'Enquiry');
  for (const enquiry of enquiries) {
    const revisions = (enquiry.revisions as Array<Record<string, unknown>>) ?? [];
    const latest = revisions.at(-1);
    if (latest && !latest.approvedAt) {
      blocking.push(`${String(enquiry.reference)} revision ${String(latest.revision)} was never approved`);
    }
    const issues = (enquiry.issues as Array<Record<string, unknown>>) ?? [];
    const stale = issues
      .filter((issue) => !issue.revoked && issue.reacknowledgementDue !== undefined)
      .map((issue) => String(issue.name));
    if (stale.length > 0) {
      blocking.push(`${String(enquiry.reference)}: ${stale.join(', ')} priced a pack they never acknowledged`);
    }
  }

  return {
    clause: 'INPUTS_COMPLETE',
    title: TITLES.INPUTS_COMPLETE,
    state: blocking.length === 0 ? 'PASS' : 'FAIL',
    detail:
      blocking.length === 0
        ? `${reviews.length} review, ${schedules.length} measurement schedule and ${enquiries.length} enquiry, all frozen or approved against a stated source version.`
        : `${blocking.length} input${blocking.length === 1 ? '' : 's'} not complete.`,
    blocking,
  };
}

// --- 2. Approvals -----------------------------------------------------------

/**
 * The acts whose author and approver must be different people, and the field
 * on the record that names each.
 *
 * Re-verified here rather than trusted. Every one of these was refused at the
 * time by the command that wrote it — but a gate that only trusts the commands
 * cannot catch a record written before the control existed, and those are
 * precisely the records nobody thinks to look at.
 */
const SEPARATIONS: Array<{ refType: string; label: string; author: string; approver: string; when: (row: Row) => boolean }> = [
  {
    refType: 'Enquiry',
    label: 'enquiry pack',
    author: 'composedBy',
    approver: 'approvedBy',
    when: () => true,
  },
];

function approvalsGoverned(ctx: EngineContext): ClauseResult {
  const blocking: string[] = [];
  let checked = 0;

  // Every governed approval names who made it and what they held at the time.
  for (const event of ctx.ledger.events({ tenantId: ctx.tenantId, projectId: ctx.projectId })) {
    const definition = lookupEventType(event.eventType);
    if (!definition) continue;
    if (definition.action !== 'APPROVE' && definition.action !== 'FREEZE') continue;
    checked += 1;
    // A `System` or `AI` actor on an approval is exactly as wrong as no actor:
    // an approval is a person taking responsibility, and neither of those can.
    if (!event.actor?.refId || event.actor.refType !== 'User') {
      blocking.push(
        `${event.eventType} at ${event.timestamp} was approved by ${event.actor?.refType ?? 'nobody'} rather than by a person`,
      );
    }
    if (!event.roleAtAction || event.roleAtAction.length === 0) {
      blocking.push(`${event.eventType} at ${event.timestamp} does not record what its author held at the time`);
    }
  }

  // And the per-act separations, checked against the record rather than the
  // command that wrote it.
  for (const separation of SEPARATIONS) {
    for (const row of list(ctx, separation.refType)) {
      const revisions = (row.revisions as Array<Record<string, unknown>>) ?? [row];
      for (const revision of revisions) {
        if (!revision[separation.approver] || !separation.when(revision)) continue;
        if (revision[separation.author] === revision[separation.approver]) {
          blocking.push(
            `${String(row.reference)} ${separation.label} revision ${String(revision.revision ?? '')} was approved by the person who assembled it`,
          );
        }
      }
    }
  }

  return {
    clause: 'APPROVALS_GOVERNED',
    title: TITLES.APPROVALS_GOVERNED,
    state: blocking.length === 0 ? 'PASS' : 'FAIL',
    detail:
      blocking.length === 0
        ? `${checked} approval${checked === 1 ? '' : 's'} and freeze${checked === 1 ? '' : 's'} re-verified: each names its author, what they held, and a different person from the one who prepared it.`
        : `${blocking.length} approval${blocking.length === 1 ? '' : 's'} not properly governed.`,
    blocking,
  };
}

// --- 3. Blockers ------------------------------------------------------------

function blockersClosed(ctx: EngineContext): ClauseResult {
  const blocking: string[] = [];

  for (const review of list(ctx, 'TenderReview')) {
    const findings = (review.findings as Array<Record<string, unknown>>) ?? [];
    for (const finding of findings.filter((f) => f.severity === 'CRITICAL')) {
      blocking.push(`${String(review.reference)}: ${String(finding.subject)}`);
    }
  }

  for (const schedule of list(ctx, 'MeasurementSchedule')) {
    const findings = (schedule.findings as Array<Record<string, unknown>>) ?? [];
    for (const finding of findings.filter((f) => f.severity === 'CRITICAL')) {
      blocking.push(`${String(schedule.reference)}: ${String(finding.subject)}`);
    }
    const remeasure = (schedule.remeasure as Array<Record<string, unknown>>) ?? [];
    const open = remeasure.filter((flag) => flag.status === 'OPEN').map((flag) => String(flag.reference));
    if (open.length > 0) {
      blocking.push(`${String(schedule.reference)}: ${open.join(', ')} measured from a drawing since reissued and never checked`);
    }
  }

  for (const comparison of list(ctx, 'ReturnComparison')) {
    const queries = (comparison.queries as Array<Record<string, unknown>>) ?? [];
    for (const query of queries.filter((q) => q.material && q.status === 'OPEN')) {
      blocking.push(`${String(comparison.reference)}: ${String(query.subject)}`);
    }
  }

  for (const pack of list(ctx, 'BidSubmissionPack')) {
    const departures = (pack.departures as Array<Record<string, unknown>>) ?? [];
    for (const departure of departures.filter((d) => !d.acceptedAt)) {
      blocking.push(`${String(pack.reference ?? 'bid pack')}: award departure "${String(departure.term ?? departure.subject)}" is open`);
    }
  }

  return {
    clause: 'BLOCKERS_CLOSED',
    title: TITLES.BLOCKERS_CLOSED,
    state: blocking.length === 0 ? 'PASS' : 'FAIL',
    detail:
      blocking.length === 0
        ? 'No critical finding, unchecked reissue, open material query or open award departure.'
        : `${blocking.length} blocker${blocking.length === 1 ? '' : 's'} open.`,
    blocking,
  };
}

// --- 4. One cut-off ---------------------------------------------------------

function oneCutOff(ctx: EngineContext): ClauseResult {
  const blocking: string[] = [];
  const stated = new Map<string, string[]>();

  const record = (basis: string, who: string) => {
    stated.set(basis, [...(stated.get(basis) ?? []), who]);
  };

  for (const comparison of list(ctx, 'ReturnComparison')) {
    record(String(comparison.informationCutOff), `${String(comparison.reference)} (returns)`);
  }
  for (const settlement of list(ctx, 'Settlement')) {
    const cutOff = settlement.cutOff as Record<string, unknown> | undefined;
    if (cutOff?.addendum) record(String(cutOff.addendum), `${String(settlement.reference)} (price and programme)`);
  }

  if (stated.size === 0) {
    return {
      clause: 'ONE_CUT_OFF',
      title: TITLES.ONE_CUT_OFF,
      state: 'FAIL',
      detail: 'Nothing states the information it was priced against, so there is no cut-off to reconcile.',
      blocking: ['No comparison or settlement declares an information cut-off'],
    };
  }

  if (stated.size > 1) {
    for (const [basis, holders] of stated) blocking.push(`"${basis}" — ${holders.join(', ')}`);
  }

  return {
    clause: 'ONE_CUT_OFF',
    title: TITLES.ONE_CUT_OFF,
    state: blocking.length === 0 ? 'PASS' : 'FAIL',
    detail:
      blocking.length === 0
        ? `Everything is stated against ${[...stated.keys()][0]}.`
        : `${stated.size} different cut-offs are in force, so the price and the programme are not describing the same job.`,
    blocking,
  };
}

// --- 5. AI ------------------------------------------------------------------

/**
 * What the specification asks a used AI output to carry, and whether the ledger
 * records it at all.
 *
 * The three that are absent are absent by omission rather than by decision, and
 * naming them here is the point: this clause cannot pass until they exist, and
 * the report says so on the screen rather than only in a document.
 */
const AI_REQUIREMENTS: Array<{ what: string; recorded: boolean; field?: string }> = [
  { what: 'evidence', recorded: true, field: 'inputRefs' },
  { what: 'confidence', recorded: true, field: 'confidence' },
  { what: 'model class', recorded: true, field: 'modelClass' },
  { what: 'ACU settlement', recorded: true, field: 'acuConsumed' },
  { what: 'assumptions', recorded: false },
  { what: 'prompt version', recorded: false },
  { what: 'human disposition', recorded: false },
];

/**
 * `stage` names what the report is about in the prose — "this tender", "this
 * design stage". The check itself is identical, because 6.4, 7.4 and 8.4 are
 * word for word the same clause and giving each stage its own copy of it would
 * guarantee they drifted.
 */
function aiAccounted(ctx: EngineContext, stage = 'tender'): ClauseResult {
  const blocking: string[] = [];
  let aiEvents = 0;

  for (const event of ctx.ledger.events({ tenantId: ctx.tenantId, projectId: ctx.projectId })) {
    if (!event.ai) continue;
    // The specification says "AI outputs **used in the decision**". The billing
    // group is the record of the call itself — what was spent, on which
    // provider — and it correctly carries no confidence and no input refs,
    // because it is not a change the model justified. Counting those as
    // incompletely recorded produced forty findings about the accounting
    // ledger doing exactly its job, which would have buried the one finding
    // that mattered.
    if (lookupEventType(event.eventType)?.group === 'AI_BILLING') continue;
    aiEvents += 1;
    if (!event.ai.inputRefs || event.ai.inputRefs.length === 0) {
      blocking.push(`${event.eventType} at ${event.timestamp} does not record what the model saw`);
    }
    if (event.ai.confidence === undefined) {
      blocking.push(`${event.eventType} at ${event.timestamp} records no confidence`);
    }
    if (event.ai.acuConsumed === undefined) {
      blocking.push(`${event.eventType} at ${event.timestamp} was not settled against the wallet`);
    }
  }

  const absent = AI_REQUIREMENTS.filter((requirement) => !requirement.recorded).map((requirement) => requirement.what);

  if (aiEvents === 0) {
    return {
      clause: 'AI_ACCOUNTED',
      title: TITLES.AI_ACCOUNTED,
      state: 'PASS',
      detail: `No AI output was used in this ${stage}, so there is nothing to account for.`,
      blocking: [],
    };
  }

  // Failures come first: something checked and found wanting needs a different
  // answer from something the platform cannot see.
  if (blocking.length > 0) {
    return {
      clause: 'AI_ACCOUNTED',
      title: TITLES.AI_ACCOUNTED,
      state: 'FAIL',
      detail: `${blocking.length} AI output${blocking.length === 1 ? '' : 's'} incompletely recorded across ${aiEvents} used in this ${stage}.`,
      blocking,
    };
  }

  return {
    clause: 'AI_ACCOUNTED',
    title: TITLES.AI_ACCOUNTED,
    state: 'NOT_ASSESSABLE',
    detail:
      `All ${aiEvents} AI outputs used in this ${stage} carry their evidence, confidence, model class and ACU settlement. ` +
      `The platform does not record ${absent.join(', ')} at all, so this clause cannot be assessed against the ` +
      'specification in full — and it is reported as unassessable rather than passed, because a gate that passes what it did ' +
      'not check converts a gap into an assurance.',
    blocking: absent.map((what) => `${what} is not recorded against an AI output anywhere in the platform`),
  };
}

// --- 6. Replay --------------------------------------------------------------

function replayable(ctx: EngineContext): ClauseResult {
  const report = replayProject(ctx.ledger, ctx.tenantId, ctx.projectId, new Date().toISOString());

  return {
    clause: 'REPLAYABLE',
    title: TITLES.REPLAYABLE,
    state: report.verificationStatus === 'VERIFIED' ? 'PASS' : 'FAIL',
    detail:
      report.verificationStatus === 'VERIFIED'
        ? `${report.eventsReplayed} events replayed and re-verified against their own state and chain hashes; ${report.evidenceIndex.length} evidence records reachable.`
        : `${report.failures.length} of ${report.eventsReplayed} events do not verify.`,
    blocking: report.failures.map((failure) => `${failure.eventType} ${failure.eventId}: ${failure.status} — ${failure.detail ?? ''}`),
  };
}

// --- 7. Downstream ----------------------------------------------------------

function downstreamCreated(ctx: EngineContext): ClauseResult {
  const converted = list(ctx, 'BidSubmissionPack').filter((pack) => pack.convertedAt);

  if (converted.length === 0) {
    return {
      clause: 'DOWNSTREAM_CREATED',
      title: TITLES.DOWNSTREAM_CREATED,
      state: 'FAIL',
      detail: 'No award has been converted, so nothing downstream exists yet.',
      blocking: ['No bid pack has been converted to a contract'],
    };
  }

  const blocking: string[] = [];
  for (const pack of converted) {
    if (!pack.budgetId) blocking.push(`${String(pack.reference ?? 'bid pack')} created no cost baseline`);
  }

  if (blocking.length > 0) {
    return {
      clause: 'DOWNSTREAM_CREATED',
      title: TITLES.DOWNSTREAM_CREATED,
      state: 'FAIL',
      detail: `${blocking.length} conversion${blocking.length === 1 ? '' : 's'} did not carry through.`,
      blocking,
    };
  }

  return {
    clause: 'DOWNSTREAM_CREATED',
    title: TITLES.DOWNSTREAM_CREATED,
    state: 'NOT_ASSESSABLE',
    detail:
      'The contract, the cost baseline and the buyout targets are created from the estimate without re-entry. ' +
      'Mobilisation tasks with owners and due dates, and inherited residual obligations, are not built — so the clause is met ' +
      'in part and cannot be assessed in full.',
    blocking: [
      'Mobilisation tasks with owners and due dates are not created from the award',
      'Residual obligations are not inherited from the tender into the contract',
    ],
  };
}

// --- The report -------------------------------------------------------------

export type GateReport = {
  projectId: string;
  phase: string;
  clauses: ClauseResult[];
  passed: boolean;
  /** Clauses that failed a check the platform ran. */
  failed: GateClause[];
  /** Clauses the platform cannot answer at all. */
  unassessable: GateClause[];
  contentHash: string;
  summary: string;
};

// --- 7.4: the same seven clauses, answered from the design stage ------------

/**
 * The design stage gate — 7.4.
 *
 * 6.4, 7.4 and 8.4 are word for word identical in the specification. What
 * differs is the evidence each is answered from, so the clause list, the titles,
 * the `NOT_ASSESSABLE` rule, the AI clause and the replay clause are shared
 * outright and only the four stage-specific checks are written twice. Three
 * copies of "every approval satisfies party separation" would be three answers
 * to one question within a year.
 */

function designInputsComplete(ctx: EngineContext): ClauseResult {
  const blocking: string[] = [];

  const packages = list(ctx, 'DesignPackage');
  if (packages.length === 0) {
    blocking.push('No design package exists, so there is no design to baseline');
  }

  const midps = list(ctx, 'MIDP');
  if (midps.length === 0) {
    blocking.push('No master information delivery plan has been approved, so nothing states what the design owes and when');
  }

  const baselines = list(ctx, 'DesignBaseline');
  if (baselines.length === 0 && packages.length > 0) {
    blocking.push('No design baseline has been approved, so nothing downstream has an accepted revision to work to');
  }

  // AC-D-WF-08-01. Every container in a baseline carries its revision, its
  // suitability and who accepts it — checked on the freeze rather than assumed
  // from the fact that a freeze happened.
  for (const freeze of list(ctx, 'FrozenPackage')) {
    if (freeze.supersededBy) continue;
    const deliverables = (freeze.deliverables as Array<Record<string, unknown>>) ?? [];
    if (deliverables.length === 0) {
      blocking.push(`${String(freeze.reference)} froze nothing`);
    }
    for (const deliverable of deliverables) {
      if (!deliverable.state) {
        blocking.push(`${String(freeze.reference)}: ${String(deliverable.reference)} carries no suitability`);
      }
      if (!deliverable.acceptingParty) {
        blocking.push(`${String(freeze.reference)}: ${String(deliverable.reference)} names nobody who accepts it`);
      }
    }
  }

  return {
    clause: 'INPUTS_COMPLETE',
    title: TITLES.INPUTS_COMPLETE,
    state: blocking.length === 0 ? 'PASS' : 'FAIL',
    detail:
      blocking.length === 0
        ? `${packages.length} package, ${midps.length} approved delivery plan and ${baselines.length} baseline, every frozen container carrying its suitability and its acceptance.`
        : `${blocking.length} input${blocking.length === 1 ? '' : 's'} not complete.`,
    blocking,
  };
}

function designApprovalsGoverned(ctx: EngineContext): ClauseResult {
  // The generic half — every APPROVE and FREEZE names a person and what they
  // held — is identical across the three gates and is reused rather than
  // rewritten. What is added here is the separation this stage cares about.
  const generic = approvalsGoverned(ctx);
  const blocking = [...generic.blocking];

  for (const change of list(ctx, 'DesignChange')) {
    const decision = change.decision as Record<string, unknown> | undefined;
    if (decision && decision.by === change.proposedBy) {
      blocking.push(`${String(change.reference)} was decided by the person who proposed it`);
    }
  }

  // A deliverable whose author checks their own work. The plan refuses it when
  // it is written; this catches anything written before that refusal existed.
  for (const designPackage of list(ctx, 'DesignPackage')) {
    const deliverables = (designPackage.deliverables as Array<Record<string, unknown>>) ?? [];
    for (const deliverable of deliverables) {
      if (deliverable.author && deliverable.author === deliverable.checker) {
        blocking.push(
          `${String(designPackage.reference)}/${String(deliverable.reference)} is checked by the person who produced it`,
        );
      }
    }
  }

  return {
    clause: 'APPROVALS_GOVERNED',
    title: TITLES.APPROVALS_GOVERNED,
    state: blocking.length === 0 ? 'PASS' : 'FAIL',
    detail:
      blocking.length === 0
        ? `${generic.detail} No design change was decided by its proposer and no deliverable is checked by its author.`
        : `${blocking.length} approval${blocking.length === 1 ? '' : 's'} not properly governed.`,
    blocking,
  };
}

function designBlockersClosed(ctx: EngineContext): ClauseResult {
  const blocking: string[] = [];

  // Constructability. Reused from D-WF-07 rather than re-derived, which is why
  // `freezeBlockersFor` is exported at all.
  for (const designPackage of list(ctx, 'DesignPackage')) {
    for (const blocker of freezeBlockersFor(ctx, String(designPackage.reference))) {
      if (blocker.severity !== 'CRITICAL' && blocker.severity !== 'MAJOR') continue;
      blocking.push(`${blocker.package}: ${blocker.reference} — ${blocker.what} (${blocker.owner})`);
    }
  }

  // Coordination. Read from the recorded state rather than through
  // `coordinationPosition`, because that read is gated on BIM_TWIN and not
  // every role that may read a gate report holds it. What is read is stored
  // state, not a rule re-implemented.
  for (const issue of list(ctx, 'CoordinationIssue')) {
    if (issue.state === 'CLOSED' || issue.state === 'VERIFIED') continue;
    if (issue.accepted) continue;
    if (issue.severity !== 'CRITICAL') continue;
    blocking.push(`${String(issue.reference)}: ${String(issue.title ?? issue.location)} is a critical clash still open`);
  }

  // Design changes. `designChangePosition` needs only read on design
  // information, which every role that can read a gate report holds.
  const changes = designChangePosition(ctx);
  for (const reference of changes.approvalOwed) {
    blocking.push(`${reference} was implemented on the emergency path and has never been approved`);
  }
  for (const entry of changes.unconfirmed) {
    blocking.push(`${entry.reference} was implemented with ${entry.items.join(', ')} unconfirmed`);
  }

  // Residual design risk that has not reached the information it has to reach.
  // A risk the designer eliminated is discharged; one that stops at the
  // designer has done two thirds of a duty.
  for (const risk of constructabilityPosition(ctx).uncommunicated) {
    blocking.push(`${risk.reference}: ${risk.hazard} does not reach ${risk.missing.join(' or ')}`);
  }

  return {
    clause: 'BLOCKERS_CLOSED',
    title: TITLES.BLOCKERS_CLOSED,
    state: blocking.length === 0 ? 'PASS' : 'FAIL',
    detail:
      blocking.length === 0
        ? 'No critical constructability finding, critical clash, unapproved emergency change or uncommunicated residual risk.'
        : `${blocking.length} blocker${blocking.length === 1 ? '' : 's'} open.`,
    blocking,
  };
}

function designOneCutOff(ctx: EngineContext): ClauseResult {
  const stated = new Map<string, string[]>();
  const record = (basis: string, who: string) => {
    stated.set(basis, [...(stated.get(basis) ?? []), who]);
  };

  for (const midp of list(ctx, 'MIDP')) {
    record(String(midp.cutOff).slice(0, 10), 'the information delivery plan');
  }
  for (const baseline of list(ctx, 'DesignBaseline')) {
    record(String(baseline.cutOff).slice(0, 10), `${String(baseline.reference)} (cost, programme and risk)`);
  }

  if (stated.size === 0) {
    return {
      clause: 'ONE_CUT_OFF',
      title: TITLES.ONE_CUT_OFF,
      state: 'FAIL',
      detail: 'Nothing declares the moment it was taken at, so there is no cut-off to reconcile.',
      blocking: ['No delivery plan or baseline declares a cut-off'],
    };
  }
  if (stated.size > 1) {
    return {
      clause: 'ONE_CUT_OFF',
      title: TITLES.ONE_CUT_OFF,
      state: 'FAIL',
      detail: `${stated.size} different cut-offs are in force, so the information plan and the baseline are not describing the same design.`,
      blocking: [...stated].map(([basis, holders]) => `"${basis}" — ${holders.join(', ')}`),
    };
  }

  return {
    clause: 'ONE_CUT_OFF',
    title: TITLES.ONE_CUT_OFF,
    state: 'PASS',
    detail: `Everything is stated against ${[...stated.keys()][0]}.`,
    blocking: [],
  };
}

function designDownstreamCreated(ctx: EngineContext): ClauseResult {
  const baselines = list(ctx, 'DesignBaseline');
  if (baselines.length === 0) {
    return {
      clause: 'DOWNSTREAM_CREATED',
      title: TITLES.DOWNSTREAM_CREATED,
      state: 'FAIL',
      detail: 'No baseline has been approved, so nothing downstream has been created from it.',
      blocking: ['No design baseline exists'],
    };
  }

  const blocking: string[] = [];

  // AC-D-WF-08-02. A baseline whose cost snapshot cannot say what it was
  // measured from hands the tender a figure nobody can check.
  for (const baseline of baselines) {
    const snapshots = (baseline.snapshots as Record<string, unknown> | undefined) ?? {};
    if (snapshots.costMinor !== undefined && !snapshots.costSource) {
      blocking.push(`${String(baseline.reference)} carries a cost snapshot with no stated model or drawing source`);
    }
  }

  // The tender readiness worklist is derived on every read rather than stored,
  // so it exists by construction — but a package frozen and then revised is a
  // worklist item nobody has cleared.
  const invalidated = designBaselinePosition(ctx).invalidated;
  for (const entry of invalidated) {
    blocking.push(`${entry.package}: ${entry.freeze} has been invalidated by a later revision and never re-frozen`);
  }

  if (blocking.length > 0) {
    return {
      clause: 'DOWNSTREAM_CREATED',
      title: TITLES.DOWNSTREAM_CREATED,
      state: 'FAIL',
      detail: `${blocking.length} downstream obligation${blocking.length === 1 ? '' : 's'} did not carry through.`,
      blocking,
    };
  }

  return {
    clause: 'DOWNSTREAM_CREATED',
    title: TITLES.DOWNSTREAM_CREATED,
    state: 'NOT_ASSESSABLE',
    detail:
      'The tender readiness worklist and the missing-information actions come off the baseline without re-entry, and every ' +
      'frozen package is current. Tender mobilisation tasks with owners and due dates are not built, and residual ' +
      'obligations are not inherited into the tender — so the clause is met in part and cannot be assessed in full.',
    blocking: [
      'Tender mobilisation tasks with owners and due dates are not created from the baseline',
      'Residual obligations are not inherited from the design stage into the tender',
    ],
  };
}

export function evaluateDesignGate(ctx: EngineContext): GateReport {
  authorise(ctx, 'PROJECT_SETUP', 'R');

  const project = ctx.ledger.require({ refType: 'Project', refId: ctx.projectId });
  const clauses = [
    designInputsComplete(ctx),
    designApprovalsGoverned(ctx),
    designBlockersClosed(ctx),
    designOneCutOff(ctx),
    aiAccounted(ctx, 'design stage'),
    replayable(ctx),
    designDownstreamCreated(ctx),
  ];

  return reportOf(ctx, String(project.state.phase), clauses);
}

export function evaluateTenderGate(ctx: EngineContext): GateReport {
  authorise(ctx, 'PROJECT_SETUP', 'R');

  const project = ctx.ledger.require({ refType: 'Project', refId: ctx.projectId });
  const clauses = [
    inputsComplete(ctx),
    approvalsGoverned(ctx),
    blockersClosed(ctx),
    oneCutOff(ctx),
    aiAccounted(ctx),
    replayable(ctx),
    downstreamCreated(ctx),
  ];

  return reportOf(ctx, String(project.state.phase), clauses);
}

/**
 * Turn seven clause results into a report.
 *
 * Shared by every stage gate. The arithmetic is trivial and that is exactly why
 * it should exist once: a second copy that counted `NOT_ASSESSABLE` towards a
 * pass would be the one bug this whole file is written to prevent.
 */
function reportOf(ctx: EngineContext, phase: string, clauses: ClauseResult[]): GateReport {
  const failed = clauses.filter((c) => c.state === 'FAIL').map((c) => c.clause);
  const unassessable = clauses.filter((c) => c.state === 'NOT_ASSESSABLE').map((c) => c.clause);
  const passed = failed.length === 0 && unassessable.length === 0;

  const parts: string[] = [];
  if (failed.length > 0) parts.push(`${failed.length} of 7 not met`);
  if (unassessable.length > 0) parts.push(`${unassessable.length} the platform cannot assess`);

  return {
    projectId: ctx.projectId,
    phase,
    clauses,
    passed,
    failed,
    unassessable,
    // Over the clause states rather than their prose, so the hash identifies
    // what was decided rather than how it was worded.
    contentHash: hashEvidence(JSON.stringify(clauses.map((c) => ({ clause: c.clause, state: c.state, blocking: c.blocking })))),
    summary: passed ? 'All seven clauses met.' : `${parts.join(', ')}.`,
  };
}

/**
 * Which of the seven-clause gates applies to this project right now.
 *
 * The gate is decided at the end of the phase it governs, so a project sitting
 * in DESIGN is being assessed against 7.4. Every other phase falls to the
 * tender gate, which is where the only implemented gate has always pointed —
 * existing behaviour is unchanged for a project that is not in design.
 */
export function gateFor(ctx: EngineContext): GateReport {
  const project = ctx.ledger.require({ refType: 'Project', refId: ctx.projectId });
  return String(project.state.phase) === 'DESIGN' ? evaluateDesignGate(ctx) : evaluateTenderGate(ctx);
}

// --- The decision -----------------------------------------------------------

export const GATE_DECISION = ['PASS', 'PASS_WITH_CONDITIONS', 'HOLD'] as const;
export type GateDecision = (typeof GATE_DECISION)[number];

export type GateCondition = {
  /** The clause this condition covers. */
  clause: GateClause;
  what: string;
  owner: string;
  /** Time-bound, which is what the specification requires and what makes it a condition rather than a hope. */
  by: string;
};

/**
 * Decide the gate.
 *
 * `PASS` needs all seven clauses met — including the ones the platform cannot
 * assess, which is why it is currently unreachable on a tender that used AI.
 * That is the honest state of the product and the report says so.
 *
 * `PASS_WITH_CONDITIONS` is the real route through, and it is the
 * specification's own: every clause that is not met must be covered by a
 * permitted, time-bound condition with an owner. A condition with no date is a
 * hope, and one with no owner is somebody else's problem.
 */
export function decideGate(
  ctx: EngineContext,
  input: { decision: GateDecision; rationale: string; conditions?: GateCondition[] },
): { decision: GateDecision; contentHash: string; conditions: number } {
  authorise(ctx, 'PROJECT_SETUP', 'A');

  const report = gateFor(ctx);

  if (!input.rationale.trim()) {
    throw new DomainError('RATIONALE_REQUIRED', 'A gate decision is a governance record. Say what it rests on.');
  }

  const outstanding = [...report.failed, ...report.unassessable];

  if (input.decision === 'PASS' && outstanding.length > 0) {
    throw new DomainError(
      'GATE_NOT_MET',
      `${outstanding.length} clause${outstanding.length === 1 ? '' : 's'} outstanding: ${outstanding.join(', ')}. ` +
        'Pass with conditions, naming an owner and a date against each, or hold the gate — but a clean pass over an open ' +
        'clause is an assurance nobody checked.',
    );
  }

  if (input.decision === 'PASS_WITH_CONDITIONS') {
    const conditions = input.conditions ?? [];
    if (conditions.length === 0) {
      throw new DomainError('CONDITIONS_REQUIRED', 'A conditional pass with no conditions on it is a pass.');
    }
    const covered = new Set(conditions.map((condition) => condition.clause));
    const uncovered = outstanding.filter((clause) => !covered.has(clause));
    if (uncovered.length > 0) {
      throw new DomainError(
        'CLAUSE_UNCONDITIONED',
        `${uncovered.join(', ')} ${uncovered.length === 1 ? 'is' : 'are'} outstanding and carry no condition. ` +
          'Every clause that is not met needs one, or the pass is silently covering it.',
      );
    }
    for (const condition of conditions) {
      if (!condition.owner.trim() || !condition.by.trim()) {
        throw new DomainError(
          'CONDITION_UNBOUND',
          `The condition on ${condition.clause} has no ${!condition.owner.trim() ? 'owner' : 'date'}. ` +
            'A condition with no date is a hope, and one with no owner is somebody else’s problem.',
        );
      }
      if (Number.isNaN(Date.parse(condition.by))) {
        throw new DomainError('CONDITION_UNBOUND', `"${condition.by}" is not a date.`);
      }
    }
  }

  const decisionId = ulid();
  const decidedAt = new Date().toISOString();

  const evidence = registerEvidence(ctx, {
    type: 'STAGE_GATE_REPORT',
    hash: report.contentHash,
    description: `${report.phase === 'DESIGN' ? 'Design' : 'Tender'} stage gate — ${input.decision} against 7 clauses (${report.summary})`,
    linkedEntities: [{ refType: 'Project', refId: ctx.projectId }],
  });

  write(ctx, {
    eventType: 'STAGE_GATE_DECIDED',
    entity: { refType: 'StageGateDecision', refId: decisionId },
    nextState: {
      id: decisionId,
      projectId: ctx.projectId,
      phase: report.phase,
      decision: input.decision,
      rationale: input.rationale,
      conditions: input.conditions ?? [],
      clauses: report.clauses,
      reportHash: report.contentHash,
      decidedAt,
      decidedBy: ctx.auth.actorId,
    },
    evidenceRefs: [evidence],
  });

  return { decision: input.decision, contentHash: report.contentHash, conditions: (input.conditions ?? []).length };
}

export type StageGatePosition = {
  decisions: Array<{
    decisionId: string;
    phase: string;
    decision: string;
    conditions: GateCondition[];
    /** Conditions whose date has passed and which nothing has discharged. */
    overdue: GateCondition[];
    decidedAt: string;
    reportHash: string;
  }>;
  summary: string;
};

export function stageGatePosition(ctx: EngineContext, today = new Date().toISOString().slice(0, 10)): StageGatePosition {
  authorise(ctx, 'PROJECT_SETUP', 'R');

  const decisions = ctx.ledger.list(ctx.projectId, 'StageGateDecision').map((record) => {
    const conditions = (record.state.conditions as GateCondition[]) ?? [];
    return {
      decisionId: String(record.state.id),
      phase: String(record.state.phase),
      decision: String(record.state.decision),
      conditions,
      overdue: conditions.filter((condition) => condition.by.slice(0, 10) < today),
      decidedAt: String(record.state.decidedAt),
      reportHash: String(record.state.reportHash),
    };
  });

  const overdue = decisions.reduce((n, decision) => n + decision.overdue.length, 0);
  const parts = [`${decisions.length} gate decision${decisions.length === 1 ? '' : 's'}`];
  if (overdue > 0) parts.push(`${overdue} condition${overdue === 1 ? '' : 's'} past its date`);

  return { decisions, summary: parts.join(', ') + '.' };
}
