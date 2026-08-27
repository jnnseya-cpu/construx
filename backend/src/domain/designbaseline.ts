import { hashEvidence } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';
import { freezeBlockersFor } from './constructability.ts';

/**
 * D-WF-08 — design cost, programme, compliance and the baseline.
 *
 * The moment design stops moving and everything downstream starts being built
 * on it. Four things go wrong here and each of them is a refusal.
 *
 * **A baseline that does not say what it froze.** "Design is frozen" is worth
 * nothing without the revisions. A freeze copies the exact deliverable
 * references, their revisions, their CDE state and their acceptance record onto
 * itself, so a package frozen in March is still readable in September whatever
 * the model has done since. AC-D-WF-08-01.
 *
 * **A partial freeze with no boundary.** Freezing half a package is normal and
 * useful — the substructure is settled while the roof is not. It is also how a
 * project ends up with two halves nobody can tell apart, so a partial freeze
 * needs a stated boundary, the interfaces across that boundary checked by name,
 * and its own baseline reference. The specification asks for exactly those
 * three and they are the acceptance criterion.
 *
 * **A freeze that quietly goes stale.** A deliverable revised after the freeze
 * invalidates everything that depended on it. That is *derived*, never a stored
 * flag: the freeze holds what it saw, the live package holds what is true now,
 * and the difference is computed on every read. A stored flag is a second
 * answer to the same question and it is always the one nobody updated.
 * Revalidating is re-freezing at the new revisions, because there is no honest
 * way to say "still fine" without looking.
 *
 * **A tender priced on superseded information.** The last exception control and
 * the one with money behind it. `tenderReadinessFor` says whether a package's
 * design is frozen, current and accepted; `enquiry.ts` calls it before issuing
 * and refuses unless the pack carries an authorised exception naming the gap.
 * The exception mechanism already existed for missing documents — reusing it
 * means the bidder sees one list of what they are pricing without, rather than
 * two mechanisms disagreeing about whose warning is authoritative.
 */

export type FrozenDeliverable = {
  reference: string;
  title: string;
  /** The CDE state at the instant of the freeze, not now. */
  state: string;
  /** Who accepts it — the acceptance record AC-D-WF-08-01 asks for. */
  acceptingParty: string;
  approver: string;
  /** Where the freeze read it from, so a quantity can name its source. */
  sourcePackage: string;
};

export type InterfaceCheck = {
  /** The interface reference on the package. */
  reference: string;
  withPackage: string;
  /** What was checked, in the checker's words. Not a tick. */
  finding: string;
  checkedBy: string;
};

type FreezeState = {
  id: string;
  reference: string;
  packageId: string;
  packageReference: string;
  scope: 'FULL' | 'PARTIAL';
  /** What is inside a partial freeze, stated rather than implied. */
  boundary?: string;
  interfaceChecks: InterfaceCheck[];
  deliverables: FrozenDeliverable[];
  contentHash: string;
  frozenAt: string;
  frozenBy: string;
  /** Set when a re-freeze supersedes this one. */
  supersededBy?: string;
};

type BaselineState = {
  id: string;
  reference: string;
  cutOff: string;
  freezeIds: string[];
  snapshots: { costMinor?: number; costSource?: string; programmeRef?: string; riskRef?: string };
  note: string;
  contentHash: string;
  approvedAt: string;
  approvedBy: string;
};

/**
 * The CDE state a deliverable has to be at before it can be frozen.
 *
 * `PUBLISHED` is the ladder's "issued and accepted" rung in `designplan.ts`.
 * Freezing anything below it would baseline work in progress, which is the
 * failure the whole workflow exists to prevent.
 */
const FREEZABLE_STATE = 'PUBLISHED';

function requireFreeze(ctx: EngineContext, freezeId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'FrozenPackage', refId: freezeId });
  if (!record) throw new DomainError('FREEZE_NOT_FOUND', `No package freeze ${freezeId}`, 404);
  return record;
}

function freezeState(record: EntityRecord): FreezeState {
  return record.state as unknown as FreezeState;
}

type LivePackage = {
  id: string;
  reference: string;
  title: string;
  deliverables: Array<{
    reference: string;
    title: string;
    state: string;
    acceptingParty: string;
    approver: string;
    dueBy: string;
    neededBy: string;
    neededFor: string;
  }>;
  interfaces: Array<{ reference: string; withPackage: string; status: string; resolveBy: string; ourOwner: string }>;
};

function livePackages(ctx: EngineContext): LivePackage[] {
  return ctx.ledger.list(ctx.projectId, 'DesignPackage').map((record) => record.state as unknown as LivePackage);
}

/** The current freeze for a package: the newest one nothing has superseded. */
function currentFreeze(ctx: EngineContext, packageReference: string): FreezeState | undefined {
  const freezes = ctx.ledger
    .list(ctx.projectId, 'FrozenPackage')
    .map((record) => freezeState(record))
    .filter((state) => state.packageReference === packageReference && state.supersededBy === undefined);
  return freezes[freezes.length - 1];
}

// --- Step 1 to 4: validate the stage ----------------------------------------

export type DesignStageValidation = {
  packages: Array<{
    packageId: string;
    reference: string;
    /** Deliverables published and therefore freezable. */
    freezable: number;
    /** Deliverables not yet published, named — this is the missing-information list. */
    notPublished: string[];
    /** Deliverables planned to land after the thing waiting for them needs them. */
    lateForNeed: Array<{ reference: string; neededFor: string; daysLate: number }>;
    /** Open findings on access or testability, from the constructability review. */
    blockers: Array<{ reference: string; severity: string; what: string; owner: string }>;
    openInterfaces: string[];
    mayFreeze: boolean;
    mayFreezePartially: boolean;
    why: string;
  }>;
  /** Compliance evidence separated from opinion, which the specification asks for by name. */
  compliance: {
    evidenceBacked: Array<{ reference: string; what: string; evidence: string }>;
    pendingOpinion: Array<{ reference: string; what: string; whose: string }>;
  };
  /** Step 6's output: what tender is still waiting for, by package. */
  tenderReadinessWorklist: Array<{ package: string; missing: string[] }>;
  summary: string;
};

/**
 * Steps 1 to 4 of the deterministic flow, answered from the ledger.
 *
 * Read-only and idempotent, so the console can show it before anybody commits
 * to anything — which is the difference between a gate people run and a gate
 * people find out about.
 */
export function validateDesignStage(
  ctx: EngineContext,
  today = new Date().toISOString().slice(0, 10),
): DesignStageValidation {
  authorise(ctx, 'DESIGN_INFORMATION', 'R');

  const worklist: DesignStageValidation['tenderReadinessWorklist'] = [];

  const packages = livePackages(ctx).map((designPackage) => {
    const notPublished = designPackage.deliverables
      .filter((deliverable) => deliverable.state !== FREEZABLE_STATE)
      .map((deliverable) => `${deliverable.reference} (${deliverable.state.toLowerCase()})`);

    const lateForNeed = designPackage.deliverables
      .filter((deliverable) => deliverable.state !== FREEZABLE_STATE && deliverable.neededBy < today)
      .map((deliverable) => ({
        reference: deliverable.reference,
        neededFor: deliverable.neededFor,
        daysLate: Math.round((Date.parse(today) - Date.parse(deliverable.neededBy)) / 86_400_000),
      }));

    // Reused, never re-derived. The rule about safe access and testability
    // belongs where the findings are, and a gate with its own copy of it would
    // be a second answer to the same question.
    const blockers = freezeBlockersFor(ctx, designPackage.reference).map((entry) => ({
      reference: entry.reference,
      severity: entry.severity,
      what: entry.what,
      owner: entry.owner,
    }));

    const openInterfaces = designPackage.interfaces
      .filter((entry) => entry.status !== 'AGREED')
      .map((entry) => `${entry.reference} with ${entry.withPackage}`);

    const freezable = designPackage.deliverables.length - notPublished.length;
    const critical = blockers.filter((entry) => entry.severity === 'CRITICAL' || entry.severity === 'MAJOR');

    // A critical or major blocker stops the whole baseline for that package —
    // the specification's second exception control — so it stops the partial
    // route too. Unpublished deliverables stop only a full freeze, because
    // isolating the settled part is exactly what a partial freeze is for.
    const mayFreeze = critical.length === 0 && notPublished.length === 0 && freezable > 0;
    const mayFreezePartially = critical.length === 0 && freezable > 0;

    const why = mayFreeze
      ? 'Every deliverable is published and nothing critical is open.'
      : critical.length > 0
        ? `${critical.length} critical or major constructability finding${critical.length === 1 ? '' : 's'} open against it.`
        : freezable === 0
          ? 'Nothing on it has been published.'
          : `${notPublished.length} deliverable${notPublished.length === 1 ? '' : 's'} still unpublished — a partial freeze can take the rest if the boundary is stated.`;

    const missing = [...notPublished, ...blockers.map((entry) => `${entry.reference}: ${entry.what}`), ...openInterfaces];
    if (missing.length > 0) worklist.push({ package: designPackage.reference, missing });

    return {
      packageId: designPackage.id,
      reference: designPackage.reference,
      freezable,
      notPublished,
      lateForNeed,
      blockers,
      openInterfaces,
      mayFreeze,
      mayFreezePartially,
      why,
    };
  });

  // Step 3. Evidence-backed pass separated from pending opinion, because the
  // two carry completely different weight and a single "verified" column hides
  // which one a consent actually rests on.
  const evidenceBacked: DesignStageValidation['compliance']['evidenceBacked'] = [];
  const pendingOpinion: DesignStageValidation['compliance']['pendingOpinion'] = [];

  for (const record of ctx.ledger.list(ctx.projectId, 'DesignReviewCycle')) {
    const state = record.state as Record<string, unknown>;
    const reference = String(state.reference ?? state.id);
    if (state.status !== 'ACCEPTED') continue;
    // An acceptance is evidence-backed when the ledger holds an evidence
    // reference against the event that recorded it. Anything else is a
    // reviewer's opinion, which is worth having and is not the same thing.
    const backed = ctx.ledger
      .events({ projectId: ctx.projectId })
      .some(
        (event) =>
          event.entity.refId === String(state.id) &&
          event.eventType === 'DESIGN_ACCEPTED' &&
          (event.evidenceRefs?.length ?? 0) > 0,
      );
    if (backed) {
      evidenceBacked.push({ reference, what: String(state.title ?? 'Design acceptance'), evidence: 'Acceptance evidence on the event' });
    } else {
      pendingOpinion.push({
        reference,
        what: String(state.title ?? 'Design acceptance'),
        whose: String(state.acceptedBy ?? state.reviewer ?? 'the reviewer'),
      });
    }
  }

  const freezable = packages.filter((entry) => entry.mayFreeze).length;
  const parts = [`${packages.length} package${packages.length === 1 ? '' : 's'}`];
  if (freezable > 0) parts.push(`${freezable} ready to freeze`);
  if (worklist.length > 0) parts.push(`${worklist.length} carrying something tender is waiting for`);

  return {
    packages,
    compliance: { evidenceBacked, pendingOpinion },
    tenderReadinessWorklist: worklist,
    summary: parts.join(', ') + '.',
  };
}

// --- Step 5a: freeze a package ----------------------------------------------

export function freezePackage(
  ctx: EngineContext,
  packageId: string,
  input: {
    scope: 'FULL' | 'PARTIAL';
    /** Required on a partial freeze: what is inside it. */
    boundary?: string;
    /** Required on a partial freeze: the interfaces across the boundary, checked. */
    interfaceChecks?: InterfaceCheck[];
    /** On a partial freeze, the deliverables being frozen. Omitted means all. */
    deliverableRefs?: string[];
    note: string;
  },
): { freezeId: string; reference: string; deliverables: number; supersedes?: string } {
  authorise(ctx, 'DESIGN_INFORMATION', 'A');

  const record = ctx.ledger.get({ refType: 'DesignPackage', refId: packageId });
  if (!record) throw new DomainError('DESIGN_PACKAGE_NOT_FOUND', `No design package ${packageId}`, 404);
  const designPackage = record.state as unknown as LivePackage;

  if (!input.note.trim()) {
    throw new DomainError('FREEZE_UNEXPLAINED', 'A freeze is the moment design stops moving. Say what it rests on.');
  }

  // The second exception control. A critical or major open item blocks the
  // affected baseline, whether the freeze is full or partial — isolating a
  // boundary does not isolate a hazard.
  const blockers = freezeBlockersFor(ctx, designPackage.reference).filter(
    (entry) => entry.severity === 'CRITICAL' || entry.severity === 'MAJOR',
  );
  if (blockers.length > 0) {
    throw new DomainError(
      'BASELINE_BLOCKED',
      `${designPackage.reference} carries ${blockers.length} open constructability finding${blockers.length === 1 ? '' : 's'} ` +
        `on access or testability: ${blockers.map((entry) => `${entry.reference} (${entry.what})`).join('; ')}. Freezing over ` +
        'them would baseline a package somebody cannot safely build or test, and the finding would then be a change.',
      409,
    );
  }

  const requested =
    input.deliverableRefs && input.deliverableRefs.length > 0
      ? designPackage.deliverables.filter((entry) => input.deliverableRefs!.includes(entry.reference))
      : designPackage.deliverables;

  const unknown = (input.deliverableRefs ?? []).filter(
    (reference) => !designPackage.deliverables.some((entry) => entry.reference === reference),
  );
  if (unknown.length > 0) {
    throw new DomainError('DELIVERABLE_NOT_FOUND', `${designPackage.reference} has no deliverable ${unknown.join(', ')}.`, 404);
  }
  if (requested.length === 0) {
    throw new DomainError(
      'NOTHING_TO_FREEZE',
      `${designPackage.reference} has no deliverable to freeze. A baseline over nothing is a date with a name on it.`,
    );
  }

  const unpublished = requested.filter((entry) => entry.state !== FREEZABLE_STATE);
  if (unpublished.length > 0) {
    throw new DomainError(
      'NOT_PUBLISHED',
      `${unpublished.map((entry) => `${entry.reference} is ${entry.state.toLowerCase()}`).join(', ')}. A baseline over work in ` +
        'progress is the thing this whole step exists to prevent — take a partial freeze of what is published and state the ' +
        'boundary, or publish the rest first.',
      409,
    );
  }

  if (input.scope === 'PARTIAL') {
    // All three, because the specification asks for all three and a partial
    // freeze missing any one of them is the half-frozen package nobody can
    // later tell apart from the whole one.
    if (!input.boundary?.trim()) {
      throw new DomainError(
        'BOUNDARY_REQUIRED',
        'A partial freeze states what is inside it. Without a boundary, two halves of a package carry the same reference ' +
          'and nobody downstream can tell which half they are pricing.',
      );
    }
    const crossing = designPackage.interfaces.filter((entry) => entry.status !== 'AGREED');
    const checked = new Set((input.interfaceChecks ?? []).map((entry) => entry.reference));
    const unchecked = crossing.filter((entry) => !checked.has(entry.reference));
    if (unchecked.length > 0) {
      throw new DomainError(
        'INTERFACE_UNCHECKED',
        `${unchecked.map((entry) => `${entry.reference} with ${entry.withPackage}`).join(', ')} ${unchecked.length === 1 ? 'is' : 'are'} ` +
          'still open and uncrossed by any check. A partial freeze is only isolated if somebody has looked at what crosses ' +
          'its boundary and said what they found.',
        409,
      );
    }
    for (const check of input.interfaceChecks ?? []) {
      if (!check.finding.trim() || !check.checkedBy.trim()) {
        throw new DomainError(
          'INTERFACE_CHECK_EMPTY',
          `The check on ${check.reference} has no ${check.finding.trim() ? 'checker' : 'finding'}. A tick with nobody behind ` +
            'it is not a check.',
        );
      }
    }
  }

  const deliverables: FrozenDeliverable[] = requested.map((entry) => ({
    reference: entry.reference,
    title: entry.title,
    state: entry.state,
    acceptingParty: entry.acceptingParty,
    approver: entry.approver,
    sourcePackage: designPackage.reference,
  }));

  // A re-freeze supersedes rather than edits: the earlier baseline stays
  // readable, which is the point of baselining at all.
  const superseded = currentFreeze(ctx, designPackage.reference);

  const freezeId = ulid();
  const sequence = ctx.ledger.list(ctx.projectId, 'FrozenPackage').length + 1;
  const reference = `BL-${designPackage.reference}-${String(sequence).padStart(2, '0')}`;

  if (superseded) {
    write(ctx, {
      eventType: 'DESIGN_PACKAGE_FROZEN',
      entity: { refType: 'FrozenPackage', refId: superseded.id },
      nextState: { ...superseded, supersededBy: reference },
    });
  }

  write(ctx, {
    eventType: 'DESIGN_PACKAGE_FROZEN',
    entity: { refType: 'FrozenPackage', refId: freezeId },
    nextState: {
      id: freezeId,
      projectId: ctx.projectId,
      reference,
      packageId,
      packageReference: designPackage.reference,
      scope: input.scope,
      ...(input.boundary ? { boundary: input.boundary } : {}),
      interfaceChecks: input.interfaceChecks ?? [],
      deliverables,
      note: input.note,
      // Over what was frozen rather than how it was described, so the hash
      // identifies the information and not the sentence about it.
      contentHash: hashEvidence(JSON.stringify(deliverables)),
      frozenAt: new Date().toISOString(),
      frozenBy: ctx.auth.actorId,
    },
  });

  return {
    freezeId,
    reference,
    deliverables: deliverables.length,
    ...(superseded ? { supersedes: superseded.reference } : {}),
  };
}

// --- The third exception control: staleness is derived ----------------------

export type PackageReadiness = {
  packageReference: string;
  frozen: boolean;
  freezeReference?: string;
  scope?: 'FULL' | 'PARTIAL';
  boundary?: string;
  /** Deliverables that have moved since the freeze — reference, then and now. */
  moved: Array<{ reference: string; frozenAt: string; nowAt: string }>;
  /** Published since the freeze and not in it. Only meaningful on a partial. */
  notInFreeze: string[];
  ready: boolean;
  why: string;
};

/**
 * Whether a package's design is frozen, current and accepted.
 *
 * Derived on every read rather than stored, which is the whole reason the third
 * exception control can be honest: a deliverable revised this morning
 * invalidates this afternoon's answer with nothing needing to have run.
 *
 * Called by `enquiry.ts` before a pack is issued. Exported for that reason
 * rather than for a screen.
 */
export function packageReadiness(ctx: EngineContext, packageReference: string): PackageReadiness {
  const live = livePackages(ctx).find((entry) => entry.reference === packageReference);
  const freeze = currentFreeze(ctx, packageReference);

  if (!freeze) {
    return {
      packageReference,
      frozen: false,
      moved: [],
      notInFreeze: [],
      ready: false,
      why: live
        ? `${packageReference} has never been frozen, so there is no accepted revision to price against.`
        : `${packageReference} is not a design package on this project, so nothing here can say whether its information is current.`,
    };
  }

  const moved: PackageReadiness['moved'] = [];
  const notInFreeze: string[] = [];

  for (const frozen of freeze.deliverables) {
    const now = live?.deliverables.find((entry) => entry.reference === frozen.reference);
    if (!now) {
      moved.push({ reference: frozen.reference, frozenAt: frozen.state, nowAt: 'removed from the package' });
    } else if (now.state !== frozen.state) {
      moved.push({ reference: frozen.reference, frozenAt: frozen.state, nowAt: now.state });
    }
  }
  for (const deliverable of live?.deliverables ?? []) {
    if (!freeze.deliverables.some((entry) => entry.reference === deliverable.reference)) {
      notInFreeze.push(deliverable.reference);
    }
  }

  const ready = moved.length === 0;

  return {
    packageReference,
    frozen: true,
    freezeReference: freeze.reference,
    scope: freeze.scope,
    ...(freeze.boundary ? { boundary: freeze.boundary } : {}),
    moved,
    notInFreeze,
    ready,
    why: ready
      ? `${freeze.reference} holds ${freeze.deliverables.length} deliverable${freeze.deliverables.length === 1 ? '' : 's'} and every one of them still stands where it was frozen.`
      : `${moved.map((entry) => `${entry.reference} was ${entry.frozenAt.toLowerCase()} and is now ${entry.nowAt.toLowerCase()}`).join('; ')}. ` +
        'A later revision invalidates what depended on the earlier one until somebody re-freezes at the new revisions.',
  };
}

/**
 * The same answer as one sentence, for a caller that only needs to refuse.
 *
 * Returns null when the package is ready or when the project runs no design
 * packages at all — a straight tender off client information has no design
 * baseline to check against and refusing it would be inventing a requirement.
 */
export function tenderReadinessFor(ctx: EngineContext, packageReference: string): string | null {
  // The package has to be one this project actually designs. A straight tender
  // off client information runs no design packages at all, and refusing it for
  // want of a baseline would be inventing a requirement rather than enforcing
  // one.
  if (!livePackages(ctx).some((entry) => entry.reference === packageReference)) return null;
  const readiness = packageReadiness(ctx, packageReference);
  return readiness.ready ? null : readiness.why;
}

// --- Step 5b: approve the baseline ------------------------------------------

export function approveBaseline(
  ctx: EngineContext,
  input: {
    reference: string;
    cutOff: string;
    freezeIds: string[];
    snapshots: { costMinor?: number; costSource?: string; programmeRef?: string; riskRef?: string };
    note: string;
  },
): { baselineId: string; reference: string; packages: string[] } {
  authorise(ctx, 'DESIGN_INFORMATION', 'A');

  if (!input.reference.trim() || !input.note.trim()) {
    throw new DomainError('BASELINE_UNNAMED', 'A baseline carries a reference and what it rests on.');
  }
  if (Number.isNaN(Date.parse(input.cutOff))) {
    throw new DomainError('CUT_OFF_REQUIRED', 'A baseline is a position at a moment. Say which moment.');
  }
  if (input.freezeIds.length === 0) {
    throw new DomainError(
      'BASELINE_EMPTY',
      'A baseline over no frozen package is a date with a name on it. Freeze what is settled first.',
    );
  }

  const taken = ctx.ledger
    .list(ctx.projectId, 'DesignBaseline')
    .some((record) => String(record.state.reference).toUpperCase() === input.reference.trim().toUpperCase());
  if (taken) {
    throw new DomainError(
      'BASELINE_REFERENCE_TAKEN',
      `${input.reference} is already a baseline on this project. Two baselines with one reference is the ambiguity the ` +
        'reference exists to remove.',
      409,
    );
  }

  const freezes = input.freezeIds.map((freezeId) => freezeState(requireFreeze(ctx, freezeId)));

  const superseded = freezes.filter((freeze) => freeze.supersededBy !== undefined);
  if (superseded.length > 0) {
    throw new DomainError(
      'FREEZE_SUPERSEDED',
      `${superseded.map((freeze) => `${freeze.reference} was superseded by ${freeze.supersededBy}`).join('; ')}. Baselining a ` +
        'superseded freeze would lock the project to information the platform already knows has moved.',
      409,
    );
  }

  // AC-D-WF-08-02. A cost snapshot has to say where the quantities came from,
  // or the baseline records a number nobody can trace to a drawing.
  if (input.snapshots.costMinor !== undefined && !input.snapshots.costSource?.trim()) {
    throw new DomainError(
      'COST_SOURCE_REQUIRED',
      'A cost snapshot states the model or drawing revisions it was measured from. A figure with no source is a figure ' +
        'nobody can check, and it is the one the tender is built on.',
    );
  }

  const stale = freezes
    .map((freeze) => packageReadiness(ctx, freeze.packageReference))
    .filter((readiness) => !readiness.ready);
  if (stale.length > 0) {
    throw new DomainError(
      'BASELINE_STALE',
      `${stale.map((readiness) => readiness.why).join(' ')} Approving it would baseline a revision the project has already ` +
        'left behind.',
      409,
    );
  }

  const baselineId = ulid();

  write(ctx, {
    eventType: 'DESIGN_BASELINE_APPROVED',
    entity: { refType: 'DesignBaseline', refId: baselineId },
    nextState: {
      id: baselineId,
      projectId: ctx.projectId,
      reference: input.reference.trim(),
      cutOff: input.cutOff,
      freezeIds: input.freezeIds,
      packages: freezes.map((freeze) => freeze.packageReference),
      snapshots: input.snapshots,
      note: input.note,
      contentHash: hashEvidence(JSON.stringify(freezes.map((freeze) => freeze.contentHash))),
      approvedAt: new Date().toISOString(),
      approvedBy: ctx.auth.actorId,
    },
  });

  return { baselineId, reference: input.reference.trim(), packages: freezes.map((freeze) => freeze.packageReference) };
}

// --- The position -----------------------------------------------------------

export type DesignBaselinePosition = {
  freezes: Array<{
    freezeId: string;
    reference: string;
    packageReference: string;
    scope: string;
    boundary?: string;
    deliverables: number;
    frozenAt: string;
    supersededBy?: string;
    ready: boolean;
    why: string;
  }>;
  baselines: Array<{
    baselineId: string;
    reference: string;
    cutOff: string;
    packages: string[];
    costMinor?: number;
    costSource?: string;
    approvedAt: string;
  }>;
  /** Frozen, then moved. What tender is pricing on superseded information. */
  invalidated: Array<{ package: string; freeze: string; why: string }>;
  summary: string;
};

export function designBaselinePosition(ctx: EngineContext): DesignBaselinePosition {
  authorise(ctx, 'DESIGN_INFORMATION', 'R');

  const invalidated: DesignBaselinePosition['invalidated'] = [];

  const freezes = ctx.ledger.list(ctx.projectId, 'FrozenPackage').map((record) => {
    const state = freezeState(record);
    const readiness = state.supersededBy
      ? { ready: true, why: `Superseded by ${state.supersededBy}.` }
      : packageReadiness(ctx, state.packageReference);

    if (!readiness.ready) {
      invalidated.push({ package: state.packageReference, freeze: state.reference, why: readiness.why });
    }

    return {
      freezeId: state.id,
      reference: state.reference,
      packageReference: state.packageReference,
      scope: state.scope,
      ...(state.boundary ? { boundary: state.boundary } : {}),
      deliverables: state.deliverables.length,
      frozenAt: state.frozenAt,
      ...(state.supersededBy ? { supersededBy: state.supersededBy } : {}),
      ready: readiness.ready,
      why: readiness.why,
    };
  });

  const baselines = ctx.ledger.list(ctx.projectId, 'DesignBaseline').map((record) => {
    const state = record.state as unknown as BaselineState & { packages: string[] };
    return {
      baselineId: state.id,
      reference: state.reference,
      cutOff: state.cutOff,
      packages: state.packages,
      ...(state.snapshots.costMinor === undefined ? {} : { costMinor: state.snapshots.costMinor }),
      ...(state.snapshots.costSource ? { costSource: state.snapshots.costSource } : {}),
      approvedAt: state.approvedAt,
    };
  });

  const live = freezes.filter((freeze) => freeze.supersededBy === undefined).length;
  const parts = [`${live} package${live === 1 ? '' : 's'} frozen`];
  if (baselines.length > 0) parts.push(`${baselines.length} baseline${baselines.length === 1 ? '' : 's'} approved`);
  if (invalidated.length > 0) parts.push(`${invalidated.length} invalidated by a later revision`);

  return { freezes, baselines, invalidated, summary: parts.join(', ') + '.' };
}
