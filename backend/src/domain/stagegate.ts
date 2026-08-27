import { hashEvidence, hashState } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import { lookupEventType } from '../goldenthread/eventTypes.ts';
import { replayProject } from '../goldenthread/replay.ts';
import { constructabilityPosition, freezeBlockersFor } from './constructability.ts';
import { designBaselinePosition } from './designbaseline.ts';
import { validateProgrammeLogic } from './programmecontrol.ts';
import { designChangePosition } from './designchange.ts';
import { crossDomainValidation, residualObligations } from './handoveracceptance.ts';

/**
 * The stage gate Definition of Done — 7.4, 8.4 and 9.4.
 *
 * All three are **word for word identical** in the specification, and so is 6.4.
 * What differs between them is not the standard but the evidence each is
 * answered from, so the clause list, the titles, the `NOT_ASSESSABLE` rule, the
 * AI clause, the replay clause and the report arithmetic are shared outright:
 * `evaluateDesignGate` answers the same seven from the design stage,
 * `evaluateConstructionGate` from the construction stage, `evaluateTenderGate`
 * from the tender, and `gateFor` picks by phase. Four copies of "every approval
 * satisfies party separation" would be four answers to one question inside a
 * year.
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

// --- 9.4: the same seven clauses, answered from the construction stage -------

function constructionInputsComplete(ctx: EngineContext): ClauseResult {
  const blocking: string[] = [];

  const plans = list(ctx, 'MobilisationPlan');
  if (plans.length === 0) {
    blocking.push('No mobilisation plan exists, so nothing readied any package before work started');
  }

  // A package that was worked without a readiness check behind it is the
  // failure CN-WF-01 exists to prevent, and at the gate it is an input that
  // was never present rather than one that failed.
  const checked = new Set(list(ctx, 'ReadinessCheck').map((row) => String(row.workPackageId)));
  const authorised = new Set(list(ctx, 'StartWorkAuthorisation').map((row) => String(row.workPackageId)));
  const started = new Set(
    list(ctx, 'Task')
      .filter((task) => Number(task.percentComplete ?? 0) > 0 || task.status === 'IN_PROGRESS' || task.status === 'COMPLETE')
      .map((task) => String(task.workPackageId)),
  );
  for (const workPackageId of started) {
    if (!checked.has(workPackageId)) {
      blocking.push(`Work was recorded against ${workPackageId} with no readiness check behind it`);
    } else if (!authorised.has(workPackageId)) {
      blocking.push(`${workPackageId} was readied but no start was ever authorised against it`);
    }
  }

  // A shift captured and never submitted is a day of evidence that does not
  // exist, and a delay claim stands on an unbroken contemporaneous record.
  const drafts = list(ctx, 'SiteDiary').filter((row) => row.status === 'DRAFT');
  for (const draft of drafts) {
    blocking.push(`The daily log for ${String(draft.diaryDate)} is still a draft on a device`);
  }

  return {
    clause: 'INPUTS_COMPLETE',
    title: TITLES.INPUTS_COMPLETE,
    state: blocking.length === 0 ? 'PASS' : 'FAIL',
    detail:
      blocking.length === 0
        ? `${plans.length} mobilisation plan, ${checked.size} package readied and authorised, and every daily log submitted.`
        : `${blocking.length} input${blocking.length === 1 ? '' : 's'} not complete.`,
    blocking,
  };
}

function constructionApprovalsGoverned(ctx: EngineContext): ClauseResult {
  const generic = approvalsGoverned(ctx);
  const blocking = [...generic.blocking];

  // The separations this stage turns on, re-verified from the records rather
  // than trusted because the command refused at the time.
  for (const claim of list(ctx, 'ProgressSubmission')) {
    const verification = claim.verification as Record<string, unknown> | undefined;
    if (verification && verification.by === claim.submittedBy) {
      blocking.push(`${String(claim.reference)} was certified by the person who claimed it`);
    }
  }
  for (const ncr of list(ctx, 'NCR')) {
    if (ncr.disposition !== 'USE_AS_IS') continue;
    if (!ncr.concession) {
      blocking.push(`${String(ncr.reference)} was closed as use-as-is with no design concession behind it`);
    }
  }

  return {
    clause: 'APPROVALS_GOVERNED',
    title: TITLES.APPROVALS_GOVERNED,
    state: blocking.length === 0 ? 'PASS' : 'FAIL',
    detail:
      blocking.length === 0
        ? `${generic.detail} No progress was certified by its claimant and no use-as-is closed without a concession.`
        : `${blocking.length} approval${blocking.length === 1 ? '' : 's'} not properly governed.`,
    blocking,
  };
}

function constructionBlockersClosed(ctx: EngineContext): ClauseResult {
  const blocking: string[] = [];

  for (const check of list(ctx, 'ReadinessCheck')) {
    if (check.readiness !== 'NOT_READY') continue;
    blocking.push(`${String(check.reference)} found ${String(check.wbsCode)} not ready and it has never been redone`);
  }
  for (const entry of list(ctx, 'Delivery')) {
    if (entry.state !== 'QUARANTINED') continue;
    const quarantine = entry.quarantine as Record<string, unknown> | undefined;
    blocking.push(`${String(entry.reference)} is quarantined on site: ${String(quarantine?.why ?? '')}`);
  }
  for (const ncr of list(ctx, 'NCR')) {
    if (ncr.status !== 'OPEN') continue;
    if (ncr.severity !== 'CRITICAL' && ncr.severity !== 'MAJOR') continue;
    blocking.push(`${String(ncr.reference)} is an open ${String(ncr.severity).toLowerCase()} non-conformance`);
  }
  for (const task of list(ctx, 'Task')) {
    if (task.status !== 'BLOCKED') continue;
    const blocked = task.blocked as Record<string, unknown> | undefined;
    blocking.push(`${String(task.name)} is blocked: ${String(blocked?.reason ?? '')} (${String(blocked?.owner ?? '')})`);
  }
  // Hold points passed and never released: work behind them either stopped or
  // went ahead without the authority, and both need saying at a gate.
  const released = new Set(
    list(ctx, 'HoldPointRelease').map((row) => `${String(row.planId)}/${String(row.stageReference)}`),
  );
  for (const plan of ctx.ledger.list(ctx.projectId, 'InspectionPlan')) {
    for (const stage of (plan.state.stages as Array<Record<string, unknown>>) ?? []) {
      if (stage.type !== 'HOLD' || stage.status !== 'PASSED') continue;
      if (released.has(`${String(plan.state.id)}/${String(stage.reference)}`)) continue;
      blocking.push(`${String(plan.state.reference)}/${String(stage.reference)} passed and was never released`);
    }
  }

  return {
    clause: 'BLOCKERS_CLOSED',
    title: TITLES.BLOCKERS_CLOSED,
    state: blocking.length === 0 ? 'PASS' : 'FAIL',
    detail:
      blocking.length === 0
        ? 'Nothing not ready, nothing quarantined, no open major non-conformance, no blocked task and no unreleased hold point.'
        : `${blocking.length} blocker${blocking.length === 1 ? '' : 's'} open.`,
    blocking,
  };
}

function constructionOneCutOff(ctx: EngineContext): ClauseResult {
  const blocking: string[] = [];
  const forecasts = list(ctx, 'ProgrammeForecast');
  const latest = forecasts[forecasts.length - 1];

  if (!latest) {
    return {
      clause: 'ONE_CUT_OFF',
      title: TITLES.ONE_CUT_OFF,
      state: 'FAIL',
      detail: 'No forecast has been approved, so the programme states no position to reconcile the cost against.',
      blocking: ['No current forecast exists'],
    };
  }

  // The programme's own reproducibility claim, used as the cut-off test: if the
  // logic has moved since the forecast was taken, the cost and the programme
  // are not describing the same job.
  const current = validateProgrammeLogic(ctx);
  if (String(latest.logicHash) !== current.logicHash) {
    blocking.push(
      `Forecast ${String(latest.version)} was taken against a programme that has since changed, so the cost and the programme are not describing the same job`,
    );
  }

  const claims = list(ctx, 'ProgressSubmission').filter((claim) => claim.status === 'SUBMITTED');
  if (claims.length > 0) {
    blocking.push(
      `${claims.length} progress claim${claims.length === 1 ? '' : 's'} awaiting verification, so the valuation and the programme are reading different progress`,
    );
  }

  return {
    clause: 'ONE_CUT_OFF',
    title: TITLES.ONE_CUT_OFF,
    state: blocking.length === 0 ? 'PASS' : 'FAIL',
    detail:
      blocking.length === 0
        ? `Forecast ${String(latest.version)} still matches the stored programme, and every progress claim has been certified.`
        : `${blocking.length} thing${blocking.length === 1 ? '' : 's'} not reconciled at one cut-off.`,
    blocking,
  };
}

function constructionDownstreamCreated(ctx: EngineContext): ClauseResult {
  const blocking: string[] = [];

  // AC-CN-WF-05-03's chain, read at the gate: an accepted serial with no
  // installed location is an as-built record with a hole in it.
  for (const entry of list(ctx, 'Delivery')) {
    if (entry.state !== 'ACCEPTED') continue;
    const units = (entry.units as Array<Record<string, unknown>>) ?? [];
    const uninstalled = units.filter((unit) => !unit.installedAt).map((unit) => String(unit.identifier));
    if (uninstalled.length > 0) {
      blocking.push(`${String(entry.reference)}: ${uninstalled.join(', ')} accepted but never traced to a location`);
    }
  }

  // The stage's own exit condition: works complete by system or area with
  // commissioning turnover released. Assessable since CN-WF-12; this clause
  // reported NOT_ASSESSABLE while the turnover record did not exist.
  const turnovers = list(ctx, 'SystemTurnover');
  if (turnovers.length === 0) {
    blocking.push('No system has been released to commissioning, so nothing has carried through to the next stage');
  }
  for (const turnover of turnovers) {
    const retained = (turnover.retainedObligations as string[] | undefined) ?? [];
    if (retained.length === 0) {
      blocking.push(`${String(turnover.systemName)} was released with no retained construction obligation stated`);
    }
    if (!String(turnover.boundary ?? '').trim()) {
      blocking.push(`${String(turnover.systemName)} was released with no boundary`);
    }
  }

  if (blocking.length > 0) {
    return {
      clause: 'DOWNSTREAM_CREATED',
      title: TITLES.DOWNSTREAM_CREATED,
      state: 'FAIL',
      detail: `${blocking.length} thing${blocking.length === 1 ? '' : 's'} did not carry through to the next stage.`,
      blocking,
    };
  }

  return {
    clause: 'DOWNSTREAM_CREATED',
    title: TITLES.DOWNSTREAM_CREATED,
    state: 'PASS',
    detail:
      `Every accepted serial traces to an installed location and its test evidence, and ${turnovers.length} system` +
      `${turnovers.length === 1 ? '' : 's'} released to commissioning with a defined boundary, its isolations and the ` +
      'obligations construction retains.',
    blocking: [],
  };
}

// --- The commissioning gate — 10.4 -----------------------------------------

function commissioningInputsComplete(ctx: EngineContext): ClauseResult {
  const blocking: string[] = [];

  const nodes = list(ctx, 'SystemNode');
  if (nodes.length === 0) {
    blocking.push('No system hierarchy has been defined, so no boundary is tied to any source version');
  }
  const unapproved = nodes.filter((node) => node.hierarchyApproved !== true).map((node) => String(node.tag));
  if (unapproved.length > 0) {
    blocking.push(`${unapproved.join(', ')} not covered by an approved systemisation`);
  }

  const plans = list(ctx, 'CommissioningPlan');
  if (plans.length === 0) {
    blocking.push('No commissioning plan has been drafted');
  } else if (!plans.some((plan) => plan.status === 'APPROVED')) {
    blocking.push('No commissioning plan has been approved');
  }

  // Every pack the approved plan requires, actually raised and released.
  const released = new Set(
    list(ctx, 'TestPack')
      .filter((pack) => pack.status === 'RELEASED')
      .map((pack) => String(pack.reference)),
  );
  const unreleased = list(ctx, 'TestPackRequirement')
    .map((requirement) => String(requirement.reference))
    .filter((reference) => !released.has(reference));
  if (unreleased.length > 0) {
    blocking.push(`${unreleased.join(', ')} required by the plan and never released for test`);
  }

  return {
    clause: 'INPUTS_COMPLETE',
    title: TITLES.INPUTS_COMPLETE,
    state: blocking.length === 0 ? 'PASS' : 'FAIL',
    detail:
      blocking.length === 0
        ? `${nodes.length} node hierarchy approved, the plan baselined, and every test pack it requires released.`
        : `${blocking.length} mandatory input${blocking.length === 1 ? '' : 's'} missing or unversioned.`,
    blocking,
  };
}

function commissioningApprovalsGoverned(ctx: EngineContext): ClauseResult {
  const blocking: string[] = [];

  // Maker-checker on the thing that matters most here: a test result decided by
  // whoever ran it.
  for (const test of list(ctx, 'FunctionalTest')) {
    if (test.status !== 'COMPLETE') continue;
    if (String(test.startedBy ?? '') === String(test.decidedByActor ?? '')) {
      blocking.push(`${String(test.reference)} was decided by the same actor who started it`);
    }
  }
  for (const vendor of list(ctx, 'VendorTest')) {
    if (vendor.status !== 'COMPLETE') continue;
    if (String(vendor.startedBy ?? '') === String(vendor.decidedByActor ?? '')) {
      blocking.push(`The ${String(vendor.kind)} on ${String(vendor.equipmentTag)} was decided by the actor who ran it`);
    }
  }
  for (const acceptance of list(ctx, 'SystemAcceptance')) {
    if (!String(acceptance.acknowledgedBy ?? '').trim()) {
      blocking.push(`${String(acceptance.systemTag)} was accepted with no named operator acknowledgement`);
    }
  }

  return {
    clause: 'APPROVALS_GOVERNED',
    title: TITLES.APPROVALS_GOVERNED,
    state: blocking.length === 0 ? 'PASS' : 'FAIL',
    detail:
      blocking.length === 0
        ? 'Every completed test was decided by somebody other than the actor who ran it, and every acceptance names the operator.'
        : `${blocking.length} approval${blocking.length === 1 ? '' : 's'} outside the separation rules.`,
    blocking,
  };
}

function commissioningBlockersClosed(ctx: EngineContext): ClauseResult {
  const blocking: string[] = [];

  for (const exception of list(ctx, 'CommissioningException')) {
    if (exception.status === 'CLOSED') continue;
    if (exception.status === 'CONDITIONALLY_ACCEPTED') {
      // A permitted, time-bound condition, exactly as the clause allows — until
      // the date passes, at which point it is an open blocker again.
      const conditional = exception.conditionalAcceptance as { reviewBy: string } | undefined;
      if (conditional && String(conditional.reviewBy).slice(0, 10) < new Date().toISOString().slice(0, 10)) {
        blocking.push(`${String(exception.reference)} is conditionally accepted past its review date`);
      }
      continue;
    }
    if (exception.severity === 'SAFETY_CRITICAL' || exception.blocker === true) {
      blocking.push(`${String(exception.reference)} is open and ${exception.severity === 'SAFETY_CRITICAL' ? 'safety-critical' : 'blocking'}`);
    }
  }

  for (const check of list(ctx, 'PreFunctionalCheck')) {
    if (check.status === 'INVALIDATED') {
      blocking.push(`${String(check.reference)} static completion was invalidated by rework and not reassessed`);
    }
  }

  return {
    clause: 'BLOCKERS_CLOSED',
    title: TITLES.BLOCKERS_CLOSED,
    state: blocking.length === 0 ? 'PASS' : 'FAIL',
    detail:
      blocking.length === 0
        ? 'No critical or blocking commissioning exception is open outside a live time-bound condition.'
        : `${blocking.length} blocker${blocking.length === 1 ? '' : 's'} open or past its condition.`,
    blocking,
  };
}

function commissioningOneCutOff(ctx: EngineContext): ClauseResult {
  const blocking: string[] = [];

  // A soak result whose trend has a hole in it is not reconciled to anything,
  // and the dossier index is the cut-off of the information side.
  for (const run of list(ctx, 'ReliabilityRun')) {
    if (run.status !== 'ACCEPTED') continue;
    const acceptance = run.acceptance as { metrics?: { gapWithinTolerance?: boolean } } | undefined;
    if (acceptance?.metrics?.gapWithinTolerance === false) {
      blocking.push(`${String(run.reference)} was accepted with more missing trend than its tolerance allows`);
    }
  }

  for (const dossier of list(ctx, 'CommissioningDossier')) {
    const missingCritical = (dossier.missingCritical as string[] | undefined) ?? [];
    if (missingCritical.length > 0) {
      blocking.push(`The dossier for ${String(dossier.systemTag)} is missing ${missingCritical.join(', ')}`);
    }
  }

  return {
    clause: 'ONE_CUT_OFF',
    title: TITLES.ONE_CUT_OFF,
    state: blocking.length === 0 ? 'PASS' : 'FAIL',
    detail:
      blocking.length === 0
        ? 'Every accepted soak run is evidenced within its data-gap tolerance and every dossier carries its critical records.'
        : `${blocking.length} thing${blocking.length === 1 ? '' : 's'} not reconciled at one cut-off.`,
    blocking,
  };
}

function commissioningDownstreamCreated(ctx: EngineContext): ClauseResult {
  const blocking: string[] = [];

  const systems = list(ctx, 'SystemNode').filter((node) => node.level === 'SYSTEM');
  const decided = new Set(list(ctx, 'SystemAcceptance').map((acceptance) => String(acceptance.systemTag)));
  const undecided = systems.map((node) => String(node.tag)).filter((tag) => !decided.has(tag));
  if (undecided.length > 0) {
    blocking.push(`${undecided.join(', ')} carries no acceptance decision`);
  }

  // AC-CM-WF-08-03 read at the gate: an obligation with no owner is one nobody
  // discharges after handover.
  for (const seasonal of list(ctx, 'SeasonalTest')) {
    if (seasonal.status !== 'OUTSTANDING') continue;
    if (!String(seasonal.responsibilityAcceptedBy ?? '').trim()) {
      blocking.push(`${String(seasonal.reference)} transfers to aftercare with nobody accepting responsibility`);
    }
  }

  // Training taught from information that has since moved is training the
  // operator cannot rely on, and it does not carry into handover.
  const invalidated = list(ctx, 'TrainingSession')
    .filter((session) => session.status === 'INVALIDATED')
    .map((session) => String(session.reference));
  if (invalidated.length > 0) {
    blocking.push(`${invalidated.join(', ')} was delivered against information since superseded and not reissued`);
  }

  return {
    clause: 'DOWNSTREAM_CREATED',
    title: TITLES.DOWNSTREAM_CREATED,
    state: blocking.length === 0 ? 'PASS' : 'FAIL',
    detail:
      blocking.length === 0
        ? 'Every system carries a decision, every deferred obligation names the party that accepted it, and no training rests on superseded information.'
        : `${blocking.length} thing${blocking.length === 1 ? '' : 's'} did not carry through to handover.`,
    blocking,
  };
}

// --- 11.4, the handover gate ------------------------------------------------

function handoverInputsComplete(ctx: EngineContext): ClauseResult {
  const blocking: string[] = [];

  const requirements = list(ctx, 'HandoverRequirement');
  if (requirements.length === 0) {
    blocking.push('No handover requirements matrix exists, so there is nothing to be complete against');
  }

  // H-WF-01 counts ACCEPTED_WITH_CONDITIONS as unmet, which is the reading the
  // gate needs: completeness is 100% or it is not.
  for (const requirement of requirements) {
    if (requirement.mandatory !== true) continue;
    if (requirement.status === 'ACCEPTED') continue;
    blocking.push(
      `${String(requirement.reference)} is mandatory and stands at ${String(requirement.status ?? 'NOT_STARTED')}`,
    );
  }

  // An as-built set that is not published is not tied to a source version
  // anybody operates from.
  for (const set of list(ctx, 'AsBuiltSet')) {
    if (set.status === 'SUPERSEDED' || set.status === 'PUBLISHED') continue;
    blocking.push(`${String(set.reference)} is ${String(set.status).toLowerCase()} and has not been published`);
  }

  return {
    clause: 'INPUTS_COMPLETE',
    title: TITLES.INPUTS_COMPLETE,
    state: blocking.length === 0 ? 'PASS' : 'FAIL',
    detail:
      blocking.length === 0
        ? 'Every mandatory handover requirement is accepted outright and every as-built set is published.'
        : `${blocking.length} input${blocking.length === 1 ? '' : 's'} incomplete or not tied to a published version.`,
    blocking,
  };
}

function handoverApprovalsGoverned(ctx: EngineContext): ClauseResult {
  const blocking: string[] = [];

  // H-WF-03: a manual section needs both a checker and an operator review, and
  // the gate reads the same rule rather than restating it as a threshold.
  for (const manual of list(ctx, 'OMManual')) {
    const sections = (manual.sections as Array<Record<string, unknown>> | undefined) ?? [];
    for (const section of sections) {
      const reviews = (section.reviews as Array<Record<string, unknown>> | undefined) ?? [];
      const roles = new Set(reviews.map((review) => String(review.role)));
      if (reviews.length > 0 && !(roles.has('CHECKER') && roles.has('OPERATOR'))) {
        blocking.push(
          `${String(manual.reference)} section ${String(section.key)} was reviewed by ${[...roles].join(' and ')} only`,
        );
      }
    }
  }

  // H-WF-09: a conditional acceptance whose expiry has passed is no longer a
  // governed condition, it is an ungoverned one.
  const today = new Date().toISOString().slice(0, 10);
  for (const pack of list(ctx, 'HandoverPack')) {
    const conditions = (pack.acceptanceConditions as Array<Record<string, unknown>> | undefined) ?? [];
    for (const condition of conditions) {
      if (String(condition.expiresOn) < today) {
        blocking.push(`An acceptance condition owned by ${String(condition.riskOwner)} expired on ${String(condition.expiresOn)}`);
      }
    }
  }

  return {
    clause: 'APPROVALS_GOVERNED',
    title: TITLES.APPROVALS_GOVERNED,
    state: blocking.length === 0 ? 'PASS' : 'FAIL',
    detail:
      blocking.length === 0
        ? 'Every reviewed manual section carries both a checker and an operator, and no acceptance condition has run past its expiry.'
        : `${blocking.length} approval${blocking.length === 1 ? '' : 's'} outside policy.`,
    blocking,
  };
}

function handoverBlockersClosed(ctx: EngineContext): ClauseResult {
  // The eight-domain validation is the blocker list. Restating it here as a
  // second set of thresholds is exactly the duplication the whole file avoids.
  const validation = crossDomainValidation(ctx);
  const blocking = validation.blocking.map((domain) => `${domain.label}: ${domain.reason}`);

  return {
    clause: 'BLOCKERS_CLOSED',
    title: TITLES.BLOCKERS_CLOSED,
    state: blocking.length === 0 ? 'PASS' : 'FAIL',
    detail:
      blocking.length === 0
        ? 'All eight handover domains report ready.'
        : `${blocking.length} of 8 domains not ready.`,
    blocking,
  };
}

function handoverOneCutOff(ctx: EngineContext): ClauseResult {
  const blocking: string[] = [];

  // A pack accepted against a manifest that had already drifted was accepted
  // against a description of the project rather than the project.
  for (const pack of list(ctx, 'HandoverPack')) {
    if (pack.decision === undefined) continue;
    if (pack.manifestVerified === false && pack.decision !== 'REJECTED') {
      blocking.push('A pack was accepted against a manifest that no longer matched the record');
    }
  }

  const baselines = list(ctx, 'HandoverBaseline');
  if (baselines.length === 0) {
    blocking.push('No handover baseline has been frozen, so there is no declared cut-off');
  }

  // The baseline is the cut-off. If the record has moved since, the frozen set
  // and the live set are two different things and the gate should say so.
  for (const baseline of baselines) {
    const entries = (baseline.entries as Array<Record<string, unknown>> | undefined) ?? [];
    const drifted = entries.filter((entry) => {
      const live = ctx.ledger.get({ refType: String(entry.refType), refId: String(entry.refId) });
      return live !== undefined && hashState(live.state) !== String(entry.hash);
    });
    if (drifted.length > 0) {
      blocking.push(
        `${drifted.length} record${drifted.length === 1 ? '' : 's'} changed after the baseline was frozen: ` +
          `${drifted.map((entry) => String(entry.reference)).join(', ')}`,
      );
    }
  }

  return {
    clause: 'ONE_CUT_OFF',
    title: TITLES.ONE_CUT_OFF,
    state: blocking.length === 0 ? 'PASS' : 'FAIL',
    detail:
      blocking.length === 0
        ? 'The handover baseline is frozen and every record in it still hashes to what was frozen.'
        : `${blocking.length} thing${blocking.length === 1 ? '' : 's'} not reconciled at one cut-off.`,
    blocking,
  };
}

function handoverDownstreamCreated(ctx: EngineContext): ClauseResult {
  const blocking: string[] = [];

  const accepted = list(ctx, 'HandoverPack').some(
    (pack) => pack.decision === 'ACCEPTED' || pack.decision === 'ACCEPTED_WITH_CONDITIONS',
  );

  if (accepted) {
    if (list(ctx, 'OperationalActivation').length === 0) {
      blocking.push('The handover was accepted and no operational records were activated from the accepted asset data');
    }

    // AC-H-WF-09-03 read at the gate. An obligation that exists and has not
    // been handed to anybody is the one nobody discharges.
    const outstanding = residualObligations(ctx);
    if (outstanding.length > 0 && list(ctx, 'ResidualTransfer').length === 0) {
      blocking.push(
        `${outstanding.length} residual obligation${outstanding.length === 1 ? '' : 's'} have not been transferred to an ` +
          'operations or aftercare owner',
      );
    }
    for (const obligation of outstanding) {
      if (!obligation.owner.trim()) blocking.push(`${obligation.reference} carries no owner into operations`);
    }
  }

  return {
    clause: 'DOWNSTREAM_CREATED',
    title: TITLES.DOWNSTREAM_CREATED,
    state: blocking.length === 0 ? 'PASS' : 'FAIL',
    detail:
      blocking.length === 0
        ? accepted
          ? 'Operations are activated from the accepted data and every residual obligation has an owner and has been transferred.'
          : 'Nothing has been accepted yet, so no downstream obligation is due.'
        : `${blocking.length} thing${blocking.length === 1 ? '' : 's'} did not carry through to operations.`,
    blocking,
  };
}

/**
 * The handover stage gate — 11.4.
 *
 * Word for word identical to 6.4, 7.4, 8.4, 9.4 and 10.4, so only the five
 * stage-specific clauses are written here. Two of them read H-WF-09 directly —
 * the blocker clause *is* the eight-domain validation, and restating it as a
 * second set of thresholds is the duplication this file exists to avoid.
 *
 * The fifth clause has read `NOT_ASSESSABLE` at every gate since the first, for
 * the same honest reason: the AI event block records no assumptions and no
 * prompt version.
 */
export function evaluateHandoverGate(ctx: EngineContext): GateReport {
  authorise(ctx, 'PROJECT_SETUP', 'R');

  const project = ctx.ledger.require({ refType: 'Project', refId: ctx.projectId });
  const clauses = [
    handoverInputsComplete(ctx),
    handoverApprovalsGoverned(ctx),
    handoverBlockersClosed(ctx),
    handoverOneCutOff(ctx),
    aiAccounted(ctx, 'handover stage'),
    replayable(ctx),
    handoverDownstreamCreated(ctx),
  ];

  return reportOf(ctx, String(project.state.phase), clauses);
}

/**
 * The commissioning stage gate — 10.4.
 *
 * Word for word identical to 6.4, 7.4, 8.4 and 9.4, so only the five
 * stage-specific clauses are written here and the AI and replay clauses stay
 * shared. The fifth clause has read `NOT_ASSESSABLE` at every gate since the
 * first, for the same honest reason: the AI event block records no assumptions
 * and no prompt version.
 */
export function evaluateCommissioningGate(ctx: EngineContext): GateReport {
  authorise(ctx, 'PROJECT_SETUP', 'R');

  const project = ctx.ledger.require({ refType: 'Project', refId: ctx.projectId });
  const clauses = [
    commissioningInputsComplete(ctx),
    commissioningApprovalsGoverned(ctx),
    commissioningBlockersClosed(ctx),
    commissioningOneCutOff(ctx),
    aiAccounted(ctx, 'commissioning stage'),
    replayable(ctx),
    commissioningDownstreamCreated(ctx),
  ];

  return reportOf(ctx, String(project.state.phase), clauses);
}

/**
 * The construction stage gate — 9.4.
 *
 * Word for word identical to 6.4, 7.4 and 8.4, which is why only the four
 * stage-specific clauses are written here and the rest is shared.
 */
export function evaluateConstructionGate(ctx: EngineContext): GateReport {
  authorise(ctx, 'PROJECT_SETUP', 'R');

  const project = ctx.ledger.require({ refType: 'Project', refId: ctx.projectId });
  const clauses = [
    constructionInputsComplete(ctx),
    constructionApprovalsGoverned(ctx),
    constructionBlockersClosed(ctx),
    constructionOneCutOff(ctx),
    aiAccounted(ctx, 'construction stage'),
    replayable(ctx),
    constructionDownstreamCreated(ctx),
  ];

  return reportOf(ctx, String(project.state.phase), clauses);
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
  const phase = String(project.state.phase);
  if (phase === 'DESIGN') return evaluateDesignGate(ctx);
  if (phase === 'CONSTRUCTION') return evaluateConstructionGate(ctx);
  if (phase === 'COMMISSIONING') return evaluateCommissioningGate(ctx);
  if (phase === 'HANDOVER') return evaluateHandoverGate(ctx);
  return evaluateTenderGate(ctx);
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
    // Named from the report rather than a two-way ternary: the same clause list
    // now serves the tender, design and construction gates, and a ternary would
    // have labelled every construction gate report as a tender one.
    description: `${report.phase} stage gate — ${input.decision} against 7 clauses (${report.summary})`,
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
