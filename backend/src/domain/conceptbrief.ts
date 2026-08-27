import { confidenceThresholdFor } from '../config.ts';
import { DomainError } from '../core/errors.ts';
import { hashState } from '../core/canonical.ts';
import { ulid } from '../core/ids.ts';
import { authorise, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import { configurationBlockedReason } from './conceptinitiation.ts';

/**
 * C-WF-02 — strategic brief and requirements baseline.
 *
 * The register of what the project is actually for. Everything downstream
 * verifies against it: a design that satisfies no requirement is decoration,
 * and a handover requirement with no brief requirement behind it is an
 * obligation nobody agreed to.
 *
 * What already exists and is not rebuilt: `handoverrequirements.ts` holds the
 * *handover* matrix, which is a different register at the far end of the
 * lifecycle — that one asks "what must be delivered before the client takes the
 * asset", this one asks "what is the asset for". They are linked by
 * `verificationStage`, not merged; merging them would put a thirty-year
 * operating outcome and a manual handover in one list.
 *
 * **An AI-extracted requirement is visibly not accepted.** AC-C-WF-02-02, and
 * it is two events rather than one record with a flag: `REQUIREMENT_EXTRACTED`
 * creates it in `DRAFT`, `REQUIREMENT_ACCEPTED` is a person's act. A single
 * event carrying `accepted: false` is exactly the shape that gets defaulted to
 * true by the next caller who finds it inconvenient.
 *
 * **Below the confidence threshold it stays Draft-Needs-Review.** The exception
 * control. `NEEDS_REVIEW` is a distinct status from `DRAFT` so the queue of
 * things a machine was unsure about is visible as its own list rather than
 * mixed into everything not yet looked at.
 *
 * **Deletion after baseline is prohibited.** Superseding is the only way out,
 * and it names the replacement or explicitly says there is none. A requirement
 * that vanishes is a requirement nobody can be shown to have dropped.
 *
 * **A requirement with no verification method cannot be baselined.**
 * AC-C-WF-02-01 asks for source, owner, priority and verification method on
 * 100% of baseline requirements. Three of those are structurally required at
 * creation; the verification method is the one that gets left as "TBC", so it
 * is checked again at the baseline, where it costs something to be missing.
 *
 * **Conflicting mandatory requirements block option approval.** Not the
 * baseline — a brief can honestly record two mandatory requirements that
 * conflict, and pretending otherwise is how the conflict gets buried. What it
 * blocks is choosing an option, because no option can satisfy both and
 * selecting one silently picks a winner. `briefConflictReason` is what C-WF-04
 * reads.
 */

export const REQUIREMENT_CATEGORY = [
  'FUNCTIONAL',
  'CAPACITY',
  'SPATIAL',
  'QUALITY',
  'SAFETY',
  'CARBON',
  'ENERGY',
  'RESILIENCE',
  'ACCESSIBILITY',
  'MAINTAINABILITY',
  'COMMERCIAL',
  'STATUTORY',
] as const;
export type RequirementCategory = (typeof REQUIREMENT_CATEGORY)[number];

export const REQUIREMENT_PRIORITY = ['MANDATORY', 'HIGH', 'MEDIUM', 'LOW'] as const;
export type RequirementPriority = (typeof REQUIREMENT_PRIORITY)[number];

export const BRIEF_REQUIREMENT_STATUS = ['DRAFT', 'NEEDS_REVIEW', 'ACCEPTED', 'SUPERSEDED'] as const;
export type BriefRequirementStatus = (typeof BRIEF_REQUIREMENT_STATUS)[number];

/**
 * How the requirement will be shown to have been met, and when.
 *
 * The lifecycle stage matters as much as the method: an operational outcome
 * verified "at handover" is an outcome nobody will ever measure, because the
 * building has not been occupied. AC-C-WF-02-01 asks for the method; the stage
 * is what makes the method honest.
 */
export type Verification = {
  method: string;
  /** CONCEPT, DESIGN, TENDER, CONSTRUCTION, COMMISSIONING, HANDOVER or OPERATION. */
  stage: string;
};

export const VERIFICATION_STAGE = [
  'CONCEPT',
  'DESIGN',
  'TENDER',
  'CONSTRUCTION',
  'COMMISSIONING',
  'HANDOVER',
  'OPERATION',
] as const;

export type BriefRequirementState = {
  requirementId: string;
  reference: string;
  category: RequirementCategory;
  statement: string;
  /** Where it came from — a document, a meeting, a person. Never blank. */
  source: string;
  /** The page, clause or minute within the source. */
  sourceAnchor: string;
  ownerId: string;
  priority: RequirementPriority;
  verification: Verification;
  acceptanceCriteria: string;
  status: BriefRequirementStatus;
  /** Machine-extracted, or typed by a person. Drives the visible marking. */
  origin: 'AI' | 'HUMAN';
  /** 0–1. Absent for a human-typed requirement, which has no confidence to state. */
  confidence?: number;
  acceptedBy?: string;
  acceptedAt?: string;
  supersededBy?: string;
  supersedeReason?: string;
  /** Requirements this one is in declared conflict with. */
  conflictsWith: readonly string[];
  createdAt: string;
};

export type BriefBaselineState = {
  baselineId: string;
  projectId: string;
  version: number;
  configurationId: string;
  /** The requirement ids frozen, with the hash of each at the moment of freezing. */
  frozen: ReadonlyArray<{ requirementId: string; reference: string; stateHash: string }>;
  baselineHash: string;
  approvedBy: string;
  approvedAt: string;
  supersedes?: string;
};

/**
 * Extraction below this stays NEEDS_REVIEW.
 *
 * Read from configuration rather than fixed here. How much a deployment trusts
 * extraction is a policy about its models and its source documents, not a fact
 * about a brief — and a constant in one domain module is a policy nobody can
 * find. `AI_CONFIDENCE_THRESHOLD` moves it; `AI_CONFIDENCE_THRESHOLDS` moves it
 * per task, because reading a title block and reading a contract clause are not
 * the same risk.
 */
export const DEFAULT_CONFIDENCE_THRESHOLD = confidenceThresholdFor('requirement_extraction');

function requirementsOf(ctx: EngineContext): BriefRequirementState[] {
  return ctx.ledger
    .list(ctx.projectId, 'ProjectRequirement')
    .map((record) => record.state as unknown as BriefRequirementState);
}

function requirement(ctx: EngineContext, requirementId: string): BriefRequirementState {
  const found = requirementsOf(ctx).find((r) => r.requirementId === requirementId);
  if (!found) throw new DomainError('NO_SUCH_REQUIREMENT', `No requirement ${requirementId} on this project`, 404);
  return found;
}

/** Every requirement on the project, superseded ones included. */
export function requirementRegister(ctx: EngineContext): BriefRequirementState[] {
  authorise(ctx, 'PROJECT_SETUP', 'R');
  return [...requirementsOf(ctx)].sort((a, b) => a.reference.localeCompare(b.reference));
}

/**
 * Create a requirement.
 *
 * One command for both origins. The difference is what it produces: a
 * machine-extracted requirement lands in `DRAFT` or `NEEDS_REVIEW` and must be
 * accepted by a person; a typed one still lands in `DRAFT`, because somebody
 * writing a requirement and somebody agreeing it is the brief are different
 * acts even when they are the same person on the same afternoon.
 */
export function extractRequirement(
  ctx: EngineContext,
  input: {
    reference: string;
    category: RequirementCategory;
    statement: string;
    source: string;
    sourceAnchor: string;
    ownerId: string;
    priority: RequirementPriority;
    verification: Verification;
    acceptanceCriteria: string;
    origin: 'AI' | 'HUMAN';
    confidence?: number;
    conflictsWith?: readonly string[];
    confidenceThreshold?: number;
  },
): { requirementId: string; status: BriefRequirementStatus } {
  authorise(ctx, 'PROJECT_SETUP', 'C');

  const blocked = configurationBlockedReason(ctx);
  if (blocked) throw new DomainError('NOT_CONFIGURED', blocked, 409);

  if (input.statement.trim() === '') {
    throw new DomainError('STATEMENT_REQUIRED', 'A requirement with no statement requires nothing', 422);
  }
  if (input.source.trim() === '' || input.sourceAnchor.trim() === '') {
    throw new DomainError(
      'SOURCE_REQUIRED',
      'Every requirement needs a source and the anchor within it. A requirement nobody can trace to ' +
        'where it came from cannot be challenged, and so cannot be changed.',
      422,
    );
  }
  if (input.ownerId.trim() === '') {
    throw new DomainError('OWNER_REQUIRED', 'Every requirement needs a named owner', 422);
  }
  if (input.verification.method.trim() === '') {
    throw new DomainError(
      'VERIFICATION_REQUIRED',
      'Name how this requirement will be shown to have been met. "TBC" is not a verification method.',
      422,
    );
  }
  if (!(VERIFICATION_STAGE as readonly string[]).includes(input.verification.stage)) {
    throw new DomainError(
      'INVALID_VERIFICATION_STAGE',
      `Verification stage must be one of ${VERIFICATION_STAGE.join(', ')}`,
      422,
    );
  }
  if (input.acceptanceCriteria.trim() === '') {
    throw new DomainError(
      'ACCEPTANCE_CRITERIA_REQUIRED',
      'A requirement with no measurable acceptance criteria cannot be passed or failed.',
      422,
    );
  }
  if (requirementsOf(ctx).some((r) => r.reference === input.reference)) {
    throw new DomainError('DUPLICATE_REFERENCE', `Requirement ${input.reference} already exists`, 409);
  }
  if (input.origin === 'AI' && input.confidence === undefined) {
    throw new DomainError(
      'CONFIDENCE_REQUIRED',
      'An extracted requirement must state its confidence. Without it the review threshold cannot be applied, ' +
        'and an uncertain extraction would be indistinguishable from a certain one.',
      422,
    );
  }

  const threshold = input.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const status: BriefRequirementStatus =
    input.origin === 'AI' && (input.confidence ?? 0) < threshold ? 'NEEDS_REVIEW' : 'DRAFT';

  const requirementId = ulid();
  const state: BriefRequirementState = {
    requirementId,
    reference: input.reference,
    category: input.category,
    statement: input.statement,
    source: input.source,
    sourceAnchor: input.sourceAnchor,
    ownerId: input.ownerId,
    priority: input.priority,
    verification: input.verification,
    acceptanceCriteria: input.acceptanceCriteria,
    status,
    origin: input.origin,
    confidence: input.confidence,
    conflictsWith: input.conflictsWith ?? [],
    createdAt: new Date().toISOString(),
  };

  write(ctx, {
    eventType: 'REQUIREMENT_EXTRACTED',
    entity: { refType: 'ProjectRequirement', refId: requirementId },
    nextState: state as unknown as Record<string, unknown>,
  });

  return { requirementId, status };
}

/**
 * Accept a requirement into the brief.
 *
 * A person's act, always. The acceptor is recorded separately from the author,
 * which is what makes AC-C-WF-02-02's visible marking meaningful — an AI
 * requirement accepted by nobody stays marked for ever.
 */
export function acceptRequirement(
  ctx: EngineContext,
  input: { requirementId: string; note?: string },
): { requirementId: string } {
  authorise(ctx, 'PROJECT_SETUP', 'A');

  const existing = requirement(ctx, input.requirementId);
  if (existing.status === 'ACCEPTED') {
    throw new DomainError('ALREADY_ACCEPTED', `${existing.reference} is already accepted`, 409);
  }
  if (existing.status === 'SUPERSEDED') {
    throw new DomainError(
      'REQUIREMENT_SUPERSEDED',
      `${existing.reference} has been superseded. Accept the requirement that replaced it.`,
      409,
    );
  }

  write(ctx, {
    eventType: 'REQUIREMENT_ACCEPTED',
    entity: { refType: 'ProjectRequirement', refId: input.requirementId },
    nextState: {
      ...existing,
      status: 'ACCEPTED',
      acceptedBy: ctx.auth.actorId,
      acceptedAt: new Date().toISOString(),
      acceptanceNote: input.note,
    } as unknown as Record<string, unknown>,
  });

  return { requirementId: input.requirementId };
}

/**
 * Supersede a requirement.
 *
 * The only way a requirement leaves the register. `replacedBy` is optional
 * because a requirement can be genuinely dropped — but the reason is not, and a
 * drop with no reason is what the exception control forbids.
 */
export function supersedeRequirement(
  ctx: EngineContext,
  input: { requirementId: string; reason: string; replacedByRequirementId?: string },
): { requirementId: string } {
  authorise(ctx, 'PROJECT_SETUP', 'A');

  const existing = requirement(ctx, input.requirementId);
  if (existing.status === 'SUPERSEDED') {
    throw new DomainError('ALREADY_SUPERSEDED', `${existing.reference} is already superseded`, 409);
  }
  if (input.reason.trim() === '') {
    throw new DomainError(
      'REASON_REQUIRED',
      'Superseding a requirement requires a reason. It is the only record that it was dropped on purpose.',
      422,
    );
  }
  if (input.replacedByRequirementId !== undefined) {
    const replacement = requirement(ctx, input.replacedByRequirementId);
    if (replacement.requirementId === existing.requirementId) {
      throw new DomainError('REPLACEMENT_SELF', 'A requirement cannot replace itself', 422);
    }
  }

  write(ctx, {
    eventType: 'REQUIREMENT_SUPERSEDED',
    entity: { refType: 'ProjectRequirement', refId: input.requirementId },
    nextState: {
      ...existing,
      status: 'SUPERSEDED',
      supersededBy: input.replacedByRequirementId,
      supersedeReason: input.reason,
      supersededAt: new Date().toISOString(),
      supersededByActorId: ctx.auth.actorId,
    } as unknown as Record<string, unknown>,
  });

  return { requirementId: input.requirementId };
}

/** The live brief: accepted requirements that have not been superseded. */
export function liveRequirements(ctx: EngineContext): BriefRequirementState[] {
  return requirementsOf(ctx).filter((r) => r.status === 'ACCEPTED');
}

// --- AC-C-WF-02-03: what a change to this requirement reaches ---------------

/** One thing downstream that was settled on the strength of this requirement. */
export type RequirementImpact = {
  /** The artefact, as it is referred to on screen. */
  what: string;
  refType: string;
  refId: string;
  /** Why a change here reaches it. Never a category — the actual link. */
  because: string;
  /** What somebody has to do about it, in the imperative. */
  action: string;
  /**
   * `HARD` where the artefact was approved against the frozen requirement and
   * the approval no longer describes what was approved. `SOFT` where the work
   * is downstream of the brief but was not frozen against this version.
   */
  severity: 'HARD' | 'SOFT';
};

export type RequirementImpactReport = {
  requirementId: string;
  reference: string;
  statement: string;
  priority: RequirementPriority;
  status: BriefRequirementStatus;
  /** Whether this requirement is in the baseline in force. */
  inBaseline: boolean;
  baselineVersion?: number;
  impacts: RequirementImpact[];
  /** The one-line answer, for the confirmation the user actually reads. */
  summary: string;
};

/**
 * What changing this requirement affects, **before** anybody changes it.
 *
 * AC-C-WF-02-03. `briefDrift()` already answers the same question backwards —
 * it reports, after the fact, that the baseline no longer matches the register.
 * That is the right thing to show on a dashboard and the wrong thing to show
 * somebody about to press supersede, because by then the damage is a fact
 * rather than a decision.
 *
 * **Every link here is one the ledger already holds.** Nothing is inferred from
 * the text of a requirement, and nothing is guessed from a category: an impact
 * appears because an artefact froze this brief baseline's hash, or was approved
 * at a cut-off after it, and both of those are recorded values. A tool that
 * guessed which cost lines "relate to" a requirement would produce a plausible
 * list that nobody could check, which is worse than no list.
 *
 * **`HARD` and `SOFT` are not severities of consequence but of provenance.**
 * Hard means an approval names the hash that is about to change, so the
 * approval will no longer describe what was approved. Soft means the work sits
 * downstream of the brief without having frozen this version of it. Only the
 * first is a contradiction; the second is a re-read.
 */
export function requirementImpact(ctx: EngineContext, requirementId: string): RequirementImpactReport {
  authorise(ctx, 'PROJECT_SETUP', 'R');

  const item = requirement(ctx, requirementId);
  const baseline = currentBriefBaseline(ctx);
  const frozen = baseline?.frozen.find((entry) => entry.requirementId === requirementId);
  const impacts: RequirementImpact[] = [];

  if (baseline && frozen) {
    impacts.push({
      what: `Brief baseline v${baseline.version}`,
      refType: 'BriefBaseline',
      refId: baseline.baselineId,
      because: `${item.reference} is one of the ${baseline.frozen.length} requirements frozen in it.`,
      action: 'Re-baseline the brief once the change is agreed, or the baseline reports drift.',
      severity: 'HARD',
    });
  }

  // The selected option froze the baseline hash it was chosen against. If this
  // requirement is in that baseline, the option was chosen on a brief that is
  // about to stop existing in the form it was read in.
  const selected = ctx.ledger
    .list(ctx.projectId, 'FeasibilityOption')
    .map(
      (record) =>
        record.state as unknown as {
          optionId: string;
          reference: string;
          name: string;
          status: string;
          briefBaselineId?: string;
        },
    )
    .find((option) => option.status === 'SELECTED');

  // Matched through the baseline the option itself froze, not through the one
  // in force. They are usually the same, and the difference matters: an option
  // chosen against an earlier baseline is affected if the requirement was in
  // *that* one, because that is the brief the decision was actually taken on.
  const optionBaseline = selected?.briefBaselineId
    ? ctx.ledger
        .list(ctx.projectId, 'BriefBaseline')
        .map((record) => record.state as unknown as BriefBaselineState)
        .find((candidate) => candidate.baselineId === selected.briefBaselineId)
    : undefined;

  if (selected && optionBaseline?.frozen.some((entry) => entry.requirementId === requirementId)) {
    impacts.push({
      what: `Selected option ${selected.reference} — ${selected.name}`,
      refType: 'FeasibilityOption',
      refId: selected.optionId,
      because: `It was selected against brief baseline v${optionBaseline.version}, whose hash is frozen on the decision.`,
      action: 'Confirm the option still satisfies the changed requirement, or re-run the comparison.',
      severity: 'HARD',
    });
  }

  // Approved concept controls and the delivery strategy carry a cut-off. Where
  // the approval came after the baseline, it was made in the knowledge of this
  // requirement — so a change to it reaches the figures that were approved.
  const controls = ctx.ledger
    .list(ctx.projectId, 'ConceptControls')
    .map((record) => record.state as unknown as { controlsId: string; version: number; approvedAt: string; totalMinor: number })
    .sort((a, b) => a.version - b.version)
    .at(-1);

  if (controls && baseline && frozen && controls.approvedAt >= baseline.approvedAt) {
    impacts.push({
      what: `Concept cost, programme and cashflow v${controls.version}`,
      refType: 'ConceptControls',
      refId: controls.controlsId,
      because: `Approved on ${controls.approvedAt.slice(0, 10)}, against the brief baseline this requirement is in.`,
      action: 'Re-check the cost plan and the milestone dates against the changed requirement before the gate.',
      severity: 'HARD',
    });
  }

  const packages = ctx.ledger
    .list(ctx.projectId, 'PackageStrategy')
    .map(
      (record) =>
        record.state as unknown as {
          packageStrategyId: string;
          version: number;
          approvedAt: string;
          packages: readonly unknown[];
        },
    )
    .sort((a, b) => a.version - b.version)
    .at(-1);

  if (packages && baseline && frozen) {
    impacts.push({
      what: `Package strategy v${packages.version}`,
      refType: 'PackageStrategy',
      refId: packages.packageStrategyId,
      because: `The ${packages.packages.length} packages were scoped from the baselined brief.`,
      action: 'Check whether the change moves scope between packages or alters a lead time.',
      severity: packages.approvedAt >= baseline.approvedAt ? 'HARD' : 'SOFT',
    });
  }

  // The concept baseline is the gate's output and freezes twelve components. A
  // requirement change after it is a change to something already signed off.
  // The concept baseline has no version of its own — it is the gate's output
  // and there is one in force — so the latest by approval date is the one.
  const conceptBaseline = ctx.ledger
    .list(ctx.projectId, 'ConceptBaseline')
    .map((record) => record.state as unknown as { baselineId: string; approvedAt: string })
    .sort((a, b) => (a.approvedAt < b.approvedAt ? -1 : 1))
    .at(-1);

  // Only where the requirement is in the brief the gate was answered from. A
  // requirement added after the baseline was not part of what the gate read,
  // and reporting the gate as affected by it would be the kind of plausible,
  // uncheckable claim this whole function exists to avoid.
  if (conceptBaseline && frozen) {
    impacts.push({
      what: 'The approved concept baseline',
      refType: 'ConceptBaseline',
      refId: conceptBaseline.baselineId,
      because: `The 6.4 gate was answered on ${conceptBaseline.approvedAt.slice(0, 10)} from a brief that included this requirement.`,
      action: 'The gate decision has to be revisited: it was taken on a brief that no longer reads this way.',
      severity: 'HARD',
    });
  }

  // Design packages are downstream of the brief without freezing an individual
  // requirement, which is exactly the SOFT case: they need re-reading by
  // somebody who knows the design, not re-approving by the platform's say-so.
  const designPackages = ctx.ledger.list(ctx.projectId, 'DesignPackage');
  if (designPackages.length > 0) {
    impacts.push({
      what: `${designPackages.length} design package${designPackages.length === 1 ? '' : 's'}`,
      refType: 'DesignPackage',
      refId: '',
      because: 'Design works to the brief, though no package freezes an individual requirement.',
      action: 'The design manager should confirm which packages the change reaches.',
      severity: 'SOFT',
    });
  }

  const hard = impacts.filter((impact) => impact.severity === 'HARD').length;

  return {
    requirementId,
    reference: item.reference,
    statement: item.statement,
    priority: item.priority,
    status: item.status,
    inBaseline: frozen !== undefined,
    baselineVersion: frozen ? baseline?.version : undefined,
    impacts,
    summary:
      impacts.length === 0
        ? `${item.reference} has not been baselined and nothing downstream has been approved against it. Changing it now costs nothing.`
        : `${item.reference} reaches ${impacts.length} downstream record${impacts.length === 1 ? '' : 's'}` +
          `${hard > 0 ? `, ${hard} of which ${hard === 1 ? 'was' : 'were'} approved against it and would no longer describe what was approved` : ''}.`,
  };
}

/**
 * Mandatory requirements in declared conflict with each other.
 *
 * Read by option selection rather than by the baseline. A brief can honestly
 * record two mandatory requirements that conflict; what it cannot do is let
 * somebody choose an option without noticing, because no option satisfies both
 * and selecting one silently picks a winner.
 *
 * Only *declared* conflicts. The platform does not infer that two requirements
 * conflict — that is a professional judgement, and a machine guessing at it
 * would produce a register of false conflicts nobody trusts.
 */
export function briefConflictReason(ctx: EngineContext): string | null {
  const live = liveRequirements(ctx);
  const byId = new Map(live.map((r) => [r.requirementId, r]));

  // A conflict declared from one side only still exists.
  //
  // The pair is normalised into sorted order and de-duplicated through a set,
  // rather than reported from whichever end declared it. Reporting only from
  // the lower-sorting end — which is what this did first — silently dropped
  // every conflict recorded on the higher-numbered requirement, which is most
  // of them: people write the conflict down when they meet the second one.
  const conflicts = new Set<string>();
  for (const item of live) {
    if (item.priority !== 'MANDATORY') continue;
    for (const otherId of item.conflictsWith) {
      const other = byId.get(otherId);
      if (!other || other.priority !== 'MANDATORY') continue;
      const pair = [item.reference, other.reference].sort();
      conflicts.add(`${pair[0]} vs ${pair[1]}`);
    }
  }
  if (conflicts.size === 0) return null;
  const listed = [...conflicts].sort();
  return (
    `${listed.length} mandatory requirement conflict${listed.length === 1 ? '' : 's'} ` +
    `remain${listed.length === 1 ? 's' : ''} open: ${listed.join('; ')}. ` +
    'No option can satisfy both sides, so selecting one would decide the conflict without saying so.'
  );
}

function baselinesOf(ctx: EngineContext): BriefBaselineState[] {
  return ctx.ledger
    .list(ctx.projectId, 'BriefBaseline')
    .map((record) => record.state as unknown as BriefBaselineState)
    .sort((a, b) => a.version - b.version);
}

/** The brief baseline in force. */
export function currentBriefBaseline(ctx: EngineContext): BriefBaselineState | undefined {
  return baselinesOf(ctx).at(-1);
}

/**
 * Why the brief cannot be baselined.
 *
 * Named as its own function because the concept gate asks the same question,
 * and a gate that re-derived it would drift from what the command enforces.
 */
export function briefBaselineBlockedReason(ctx: EngineContext): string | null {
  const configuration = configurationBlockedReason(ctx);
  if (configuration) return configuration;

  const all = requirementsOf(ctx);
  if (all.length === 0) return 'The project has no requirements. There is no brief to baseline.';

  const accepted = liveRequirements(ctx);
  if (accepted.length === 0) {
    return 'No requirement has been accepted. A baseline over drafts freezes what nobody agreed to.';
  }

  const pending = all.filter((r) => r.status === 'DRAFT' || r.status === 'NEEDS_REVIEW');
  if (pending.length > 0) {
    const review = pending.filter((r) => r.status === 'NEEDS_REVIEW').length;
    return (
      `${pending.length} requirement${pending.length === 1 ? '' : 's'} ` +
      `${pending.length === 1 ? 'is' : 'are'} neither accepted nor superseded` +
      `${review > 0 ? ` (${review} below the extraction confidence threshold)` : ''}. ` +
      'A baseline taken over them would freeze a brief with open questions inside it.'
    );
  }

  // AC-C-WF-02-01, checked where it costs something to be missing.
  const incomplete = accepted.filter(
    (r) =>
      r.source.trim() === '' ||
      r.ownerId.trim() === '' ||
      r.verification.method.trim() === '' ||
      r.acceptanceCriteria.trim() === '',
  );
  if (incomplete.length > 0) {
    return (
      `${incomplete.length} accepted requirement${incomplete.length === 1 ? '' : 's'} ` +
      `(${incomplete.map((r) => r.reference).join(', ')}) lack${incomplete.length === 1 ? 's' : ''} ` +
      'a source, owner, verification method or acceptance criteria.'
    );
  }

  return null;
}

/**
 * Freeze the brief.
 *
 * Each requirement's state hash is recorded at the moment of freezing, so the
 * gate can later prove the brief it approved is the brief still on the project.
 * A list of ids alone would prove only that the same requirements exist, which
 * is not the same claim.
 */
export function baselineBrief(
  ctx: EngineContext,
  input: { evidenceHash: string },
): { baselineId: string; version: number; requirements: number; baselineHash: string } {
  authorise(ctx, 'PROJECT_SETUP', 'A');

  const blocked = briefBaselineBlockedReason(ctx);
  if (blocked) throw new DomainError('BRIEF_NOT_READY', blocked, 409);

  const configuration = ctx.ledger
    .list(ctx.projectId, 'ProjectConfiguration')
    .map((record) => record.state as unknown as { configurationId: string; version: number })
    .sort((a, b) => a.version - b.version)
    .at(-1);
  if (!configuration) throw new DomainError('NOT_CONFIGURED', 'The project has no configuration', 409);

  const frozen = liveRequirements(ctx)
    .sort((a, b) => a.reference.localeCompare(b.reference))
    .map((r) => ({
      requirementId: r.requirementId,
      reference: r.reference,
      stateHash: hashState(r as unknown as Record<string, unknown>),
    }));

  const previous = currentBriefBaseline(ctx);
  const baselineId = ulid();
  const baselineHash = hashState({ frozen } as unknown as Record<string, unknown>);
  const state: BriefBaselineState = {
    baselineId,
    projectId: ctx.projectId,
    version: (previous?.version ?? 0) + 1,
    configurationId: configuration.configurationId,
    frozen,
    baselineHash,
    approvedBy: ctx.auth.actorId,
    approvedAt: new Date().toISOString(),
    supersedes: previous?.baselineId,
  };

  const evidence = registerEvidence(ctx, {
    type: 'BRIEF_BASELINE',
    hash: input.evidenceHash,
    description: `Brief baseline v${state.version} — ${frozen.length} requirements frozen`,
  });

  write(ctx, {
    eventType: 'BRIEF_BASELINED',
    entity: { refType: 'BriefBaseline', refId: baselineId },
    nextState: state as unknown as Record<string, unknown>,
    evidenceRefs: [evidence],
  });

  return { baselineId, version: state.version, requirements: frozen.length, baselineHash };
}

/**
 * Requirements that have moved since the baseline froze them.
 *
 * The drift check. A baseline is worth nothing if the register underneath it
 * can be edited afterwards without anybody noticing — which is exactly what a
 * list of ids would allow.
 */
export function briefDrift(ctx: EngineContext): Array<{ reference: string; state: 'DRIFTED' | 'MISSING' }> {
  const baseline = currentBriefBaseline(ctx);
  if (!baseline) return [];

  const live = new Map(requirementsOf(ctx).map((r) => [r.requirementId, r]));
  const drift: Array<{ reference: string; state: 'DRIFTED' | 'MISSING' }> = [];

  for (const entry of baseline.frozen) {
    const current = live.get(entry.requirementId);
    if (!current) {
      drift.push({ reference: entry.reference, state: 'MISSING' });
      continue;
    }
    if (hashState(current as unknown as Record<string, unknown>) !== entry.stateHash) {
      drift.push({ reference: entry.reference, state: 'DRIFTED' });
    }
  }
  return drift;
}

export type BriefPosition = {
  total: number;
  accepted: number;
  draft: number;
  needsReview: number;
  superseded: number;
  /** Extracted by a machine and not yet accepted by a person. AC-C-WF-02-02. */
  unacceptedAiRequirements: number;
  byCategory: Record<string, number>;
  mandatory: number;
  baseline?: BriefBaselineState;
  drift: Array<{ reference: string; state: 'DRIFTED' | 'MISSING' }>;
  conflictReason: string | null;
  baselineBlocked: string | null;
};

/** The brief position, derived on every read. */
export function briefPosition(ctx: EngineContext): BriefPosition {
  authorise(ctx, 'PROJECT_SETUP', 'R');

  const all = requirementsOf(ctx);
  const byCategory: Record<string, number> = {};
  for (const item of all) {
    if (item.status === 'SUPERSEDED') continue;
    byCategory[item.category] = (byCategory[item.category] ?? 0) + 1;
  }

  return {
    total: all.length,
    accepted: all.filter((r) => r.status === 'ACCEPTED').length,
    draft: all.filter((r) => r.status === 'DRAFT').length,
    needsReview: all.filter((r) => r.status === 'NEEDS_REVIEW').length,
    superseded: all.filter((r) => r.status === 'SUPERSEDED').length,
    unacceptedAiRequirements: all.filter(
      (r) => r.origin === 'AI' && (r.status === 'DRAFT' || r.status === 'NEEDS_REVIEW'),
    ).length,
    byCategory,
    mandatory: all.filter((r) => r.status === 'ACCEPTED' && r.priority === 'MANDATORY').length,
    baseline: currentBriefBaseline(ctx),
    drift: briefDrift(ctx),
    conflictReason: briefConflictReason(ctx),
    baselineBlocked: briefBaselineBlockedReason(ctx),
  };
}
