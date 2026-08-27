import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { scoreClashes } from '../engines/bim.ts';
import { authorise, currentPhase, write, type EngineContext } from '../engines/context.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';

/**
 * D-WF-04 — multidiscipline coordination, clash and interface control.
 *
 * A clash report is the easiest document in construction to produce and the
 * hardest to act on. Four thousand clashes arrive, most of them the same
 * problem counted once per element, and the register is abandoned inside a
 * fortnight. Four failures follow, and this module is built around them.
 *
 * **A result nobody can reproduce.** "The models clashed" is worthless a week
 * later, because the models moved. A run here is against a **federation set**:
 * an immutable list of exact model revisions with their file hashes, created
 * once and never edited. Two runs against the same set are comparable; two runs
 * against "the current models" are two different questions with one name.
 *
 * **Four thousand rows that are forty problems.** Raw clashes are grouped into
 * coordination issues by location and by the pair of systems involved, because
 * that is what a fix addresses: a duct passing through a beam clashes with
 * every rebar it meets, and one person moves the duct once. The grouping is
 * arithmetic the platform does; the register nobody reads is the one that
 * skipped it.
 *
 * **An accepted clash marked as resolved.** The specification is explicit and
 * it is the rule that matters most: accepting a clash requires a reason, a risk
 * owner and an approval, and the issue is **not** marked resolved. Resolved
 * means the geometry changed. Accepted means somebody decided to live with it —
 * and the two look identical on every clash register that collapses them, which
 * is how a service ends up permanently routed through a structural zone with no
 * record of who agreed to it.
 *
 * **A closed issue that comes back.** The next run against a later federation
 * reopens anything closed that reappears, automatically. An issue closed on the
 * strength of a model revision that did not actually fix it is the commonest
 * way a clash reaches site.
 *
 * ---
 *
 * **What blocks a run rather than being reported by it.** Two models on
 * different coordinate systems, or in different units, produce thousands of
 * clashes that are all the same error. Reporting them as findings would bury
 * the real ones, so the federation refuses to form. The platform does not parse
 * IFC — that is a declared gap — so the units and the coordinate system are
 * **declared** when a model is federated, by the person federating it, and the
 * refusal names what disagrees with what.
 */

export const UNITS = ['METRES', 'MILLIMETRES', 'FEET'] as const;
export type Units = (typeof UNITS)[number];

export type FederatedModel = {
  modelId: string;
  discipline: string;
  /** The exact revision this set was formed from. */
  revision: string;
  /** Content hash, so the set commits to the bytes and not to a label. */
  fileHash: string;
  /**
   * Declared, not parsed.
   *
   * The platform holds a model's hash and its element count; it does not read
   * its geometry. Somebody says what the model is in, and the platform holds
   * them to it across the set.
   */
  units: Units;
  coordinateSystem: string;
};

/**
 * How a coordination issue moves.
 *
 * `ACCEPTED` is deliberately not on this ladder — it is a different ending, not
 * a further step, and putting it here would make it reachable from
 * `READY_FOR_VERIFICATION` as though verification could conclude in acceptance.
 */
export const ISSUE_STATE = ['OPEN', 'ASSIGNED', 'IN_RESOLUTION', 'READY_FOR_VERIFICATION', 'VERIFIED', 'CLOSED'] as const;
export type IssueState = (typeof ISSUE_STATE)[number];

const LADDER: Record<IssueState, IssueState[]> = {
  OPEN: ['ASSIGNED'],
  ASSIGNED: ['IN_RESOLUTION'],
  IN_RESOLUTION: ['READY_FOR_VERIFICATION'],
  // Verification can fail. Sending it back to resolution is the whole point of
  // having a verification state at all.
  READY_FOR_VERIFICATION: ['VERIFIED', 'IN_RESOLUTION'],
  VERIFIED: ['CLOSED'],
  CLOSED: [],
};

export type RawClash = {
  /** The IFC GUID, so a viewpoint in another tool resolves to the same element. */
  elementA: string;
  elementB: string;
  disciplineA: string;
  disciplineB: string;
  /** What the element is — a duct, a beam. The pair is the issue's identity. */
  systemA: string;
  systemB: string;
  overlapVolume: number;
  location: string;
};

type FederationState = {
  id: string;
  reference: string;
  models: FederatedModel[];
  units: Units;
  coordinateSystem: string;
  createdAt: string;
};

type IssueState_ = {
  id: string;
  reference: string;
  federationSetId: string;
  /** What identifies the same problem across runs. */
  signature: string;
  location: string;
  systems: string;
  severity: string;
  clashCount: number;
  elementGuids: string[];
  state: IssueState;
  owner?: string;
  affectedParties?: string[];
  by?: string;
  targetRevision?: string;
  accepted?: { reason: string; riskOwner: string; approvedBy: string; at: string };
  history: Array<{ from: string; to: string; by: string; at: string; note?: string }>;
  /** Runs in which this issue was seen, so recurrence is visible rather than inferred. */
  seenInRuns: string[];
};

function requireFederation(ctx: EngineContext, id: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'FederationSet', refId: id });
  if (!record) throw new DomainError('FEDERATION_NOT_FOUND', `No federation set ${id}`, 404);
  return record;
}

function requireIssue(ctx: EngineContext, id: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'CoordinationIssue', refId: id });
  if (!record) throw new DomainError('ISSUE_NOT_FOUND', `No coordination issue ${id}`, 404);
  return record;
}

/**
 * What makes two clashes the same problem.
 *
 * Location and the unordered pair of systems. A duct through a beam is one
 * problem whichever way round the clash engine reported it, and it is one
 * problem however many rebars it happens to intersect — somebody moves the duct
 * once. Sorting the pair is what makes it unordered, and it is why the same
 * issue is recognised again in a later run.
 */
export function signatureOf(clash: { location: string; systemA: string; systemB: string }): string {
  const systems = [clash.systemA.trim().toUpperCase(), clash.systemB.trim().toUpperCase()].sort();
  return `${clash.location.trim().toUpperCase()}|${systems.join('×')}`;
}

// --- The federation set -----------------------------------------------------

/**
 * Form an immutable set from exact model revisions.
 *
 * Never edited afterwards. A federation set that could gain a model would make
 * every run against it incomparable with every other, which is the one thing
 * the set exists to prevent.
 */
export function createFederationSet(
  ctx: EngineContext,
  input: { reference: string; models: FederatedModel[] },
): { federationSetId: string; reference: string; models: number } {
  authorise(ctx, 'BIM_TWIN', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (input.models.length < 2) {
    throw new DomainError(
      'FEDERATION_TOO_SMALL',
      'A federation set needs at least two models. One model clashes with nothing, and a set of one is a model with a ' +
        'longer name.',
    );
  }

  for (const model of input.models) {
    const record = ctx.ledger.get({ refType: 'Model', refId: model.modelId });
    if (!record || record.state.projectId !== ctx.projectId) {
      throw new DomainError(
        'MODEL_NOT_FOUND',
        `No model ${model.modelId} on this project. A federation set names exact revisions, so every one of them has to ` +
          'exist — a set citing a model nobody ingested cannot be reproduced, which is the whole point of forming one.',
        404,
      );
    }
    if (model.fileHash !== record.state.fileHash) {
      throw new DomainError(
        'MODEL_HASH_MISMATCH',
        `The hash given for ${model.discipline} does not match the model this platform holds. The set commits to the ` +
          'bytes rather than to a label, because "revision C" is a name somebody typed and a hash is not.',
      );
    }
  }

  // The refusal that saves the register. Two models in different units produce
  // thousands of clashes that are all one error, and reporting them as findings
  // buries the real ones.
  const units = [...new Set(input.models.map((model) => model.units))];
  if (units.length > 1) {
    throw new DomainError(
      'UNIT_MISMATCH',
      `These models are not in the same units: ${input.models
        .map((model) => `${model.discipline} in ${model.units.toLowerCase()}`)
        .join(', ')}. A clash run across them would report thousands of overlaps that are all the same error, and the ` +
        'real ones would be somewhere in the middle of them.',
    );
  }
  const systems = [...new Set(input.models.map((model) => model.coordinateSystem.trim().toUpperCase()))];
  if (systems.length > 1) {
    throw new DomainError(
      'COORDINATE_MISMATCH',
      `These models are not on the same coordinate system: ${input.models
        .map((model) => `${model.discipline} on ${model.coordinateSystem}`)
        .join(', ')}. Misaligned models clash everywhere, and a run against them is a measurement of the misalignment ` +
        'rather than of the design.',
    );
  }

  const federationSetId = ulid();

  write(ctx, {
    eventType: 'MODEL_FEDERATION_CREATED',
    entity: { refType: 'FederationSet', refId: federationSetId },
    nextState: {
      id: federationSetId,
      projectId: ctx.projectId,
      reference: input.reference,
      models: input.models,
      units: units[0],
      coordinateSystem: input.models[0]!.coordinateSystem,
      createdBy: ctx.auth.actorId,
      createdAt: new Date().toISOString(),
    },
  });

  return { federationSetId, reference: input.reference, models: input.models.length };
}

// --- The run ----------------------------------------------------------------

export type RunResult = {
  runId: string;
  reference: string;
  clashes: number;
  issues: number;
  /** Issues this run found that no previous run against this set had. */
  newIssues: number;
  /** Issues closed by a previous run and found again by this one. */
  reopened: string[];
  /** Issues a previous run found and this one did not. */
  noLongerFound: string[];
  critical: number;
};

/**
 * Run the checks and group what they find.
 *
 * The grouping is the product. Raw clashes go into the ledger as they are —
 * `Clash` records already exist for that and are not duplicated here — and what
 * this writes is the *issues*, which is the thing somebody is assigned and
 * verifies.
 *
 * Severity comes from `scoreClashes` in the BIM engine rather than from a scale
 * of this module's own: two severity scales over one set of clashes would let
 * the same overlap read CRITICAL on one screen and MEDIUM on another.
 */
export function runClashDetection(
  ctx: EngineContext,
  federationSetId: string,
  input: { ruleSet: string; clashes: RawClash[] },
): RunResult {
  authorise(ctx, 'BIM_TWIN', 'C', { lifecyclePhase: currentPhase(ctx) });

  const federation = requireFederation(ctx, federationSetId);
  const state = federation.state as unknown as FederationState;

  if (!input.ruleSet.trim()) {
    throw new DomainError(
      'RULE_SET_REQUIRED',
      'Name the rule set the run was made with — tolerances, clearances, exclusions. A clash result with no rule set ' +
        'behind it cannot be compared with the next one, because nobody can say whether the difference is the design or ' +
        'the settings.',
    );
  }

  const scored = scoreClashes(input.clashes);
  const runId = ulid();
  const sequence = ctx.ledger.list(ctx.projectId, 'ClashRun').filter((r) => r.state.federationSetId === federationSetId).length + 1;
  const reference = `${state.reference}/R${sequence}`;

  // Group. This is the arithmetic that turns a report into a register.
  const grouped = new Map<string, { clashes: typeof scored; signature: string }>();
  for (const clash of scored) {
    const signature = signatureOf(clash);
    const existing = grouped.get(signature);
    if (existing) existing.clashes.push(clash);
    else grouped.set(signature, { signature, clashes: [clash] });
  }

  // Everything this set has seen before, by signature.
  const known = new Map<string, EntityRecord>();
  for (const record of ctx.ledger.list(ctx.projectId, 'CoordinationIssue')) {
    if (record.state.federationSetId === federationSetId) known.set(String(record.state.signature), record);
  }

  const now = new Date().toISOString();
  const reopened: string[] = [];
  let newIssues = 0;
  let critical = 0;

  write(ctx, {
    eventType: 'CLASH_RUN_COMPLETED',
    entity: { refType: 'ClashRun', refId: runId },
    nextState: {
      id: runId,
      projectId: ctx.projectId,
      federationSetId,
      reference,
      ruleSet: input.ruleSet,
      // The exact revisions, copied onto the run. A run that pointed at the set
      // and nothing else would stop being readable if the set were ever
      // deleted, and the acceptance criterion is that each result references
      // exact model revisions.
      models: state.models.map((model) => ({
        discipline: model.discipline,
        revision: model.revision,
        fileHash: model.fileHash,
      })),
      clashCount: scored.length,
      issueCount: grouped.size,
      runAt: now,
      runBy: ctx.auth.actorId,
    },
  });

  for (const group of grouped.values()) {
    const worst = group.clashes.reduce((a, b) => (a.severityScore >= b.severityScore ? a : b));
    if (worst.severity === 'CRITICAL') critical += 1;

    const guids = [...new Set(group.clashes.flatMap((clash) => [clash.elementA, clash.elementB]))];
    const previous = known.get(group.signature);

    if (!previous) {
      newIssues += 1;
      const issueId = ulid();
      write(ctx, {
        eventType: 'COORDINATION_ISSUE_ASSIGNED',
        entity: { refType: 'CoordinationIssue', refId: issueId },
        nextState: {
          id: issueId,
          projectId: ctx.projectId,
          federationSetId,
          reference: `${state.reference}/I${String(known.size + newIssues).padStart(3, '0')}`,
          signature: group.signature,
          location: group.clashes[0]!.location,
          systems: group.signature.split('|')[1],
          severity: worst.severity,
          clashCount: group.clashes.length,
          elementGuids: guids,
          state: 'OPEN',
          history: [],
          seenInRuns: [reference],
        },
      });
      continue;
    }

    const before = previous.state as unknown as IssueState_;
    // Recurrence. A closed issue that appears again was closed on the strength
    // of a revision that did not fix it, and reopening automatically is the
    // difference between finding that out now and finding it out on site.
    const recurred = before.state === 'CLOSED' || before.state === 'VERIFIED';
    if (recurred) reopened.push(before.reference);

    const entity = { refType: 'CoordinationIssue', refId: previous.refId };
    const seen = {
      ...previous.state,
      severity: worst.severity,
      clashCount: group.clashes.length,
      elementGuids: guids,
      seenInRuns: [...before.seenInRuns, reference],
    };

    // Two writes rather than one with the event type computed. The catalogue
    // guardrail reads the source for what each command can emit, and an event
    // name hidden inside a ternary is one it cannot see — which is exactly the
    // silent dead event the guardrail exists to catch.
    if (recurred) {
      write(ctx, {
        eventType: 'COORDINATION_ISSUE_REOPENED',
        entity,
        nextState: {
          ...seen,
          state: 'OPEN' as const,
          history: [
            ...before.history,
            {
              from: before.state,
              to: 'OPEN',
              by: ctx.auth.actorId,
              at: now,
              note: `Found again by ${reference}. It was ${before.state.toLowerCase().replace(/_/g, ' ')} before this run.`,
            },
          ],
        },
      });
    } else {
      write(ctx, { eventType: 'COORDINATION_ISSUE_ASSIGNED', entity, nextState: seen });
    }
  }

  // What a previous run found and this one did not. Reported rather than
  // closed: a clash disappearing from a run is evidence, not a decision, and
  // closing on it would let a model somebody broke close forty issues.
  const noLongerFound = [...known.entries()]
    .filter(([signature, record]) => !grouped.has(signature) && !['CLOSED', 'VERIFIED'].includes(String(record.state.state)))
    .map(([, record]) => String(record.state.reference));

  return {
    runId,
    reference,
    clashes: scored.length,
    issues: grouped.size,
    newIssues,
    reopened,
    noLongerFound,
    critical,
  };
}

// --- The issue lifecycle ----------------------------------------------------

/** Give the issue an owner, the parties it affects, a date and the revision it will be fixed in. */
export function assignIssue(
  ctx: EngineContext,
  issueId: string,
  input: { owner: string; affectedParties: string[]; by: string; targetRevision: string },
): { state: IssueState } {
  authorise(ctx, 'BIM_TWIN', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireIssue(ctx, issueId);
  const before = record.state as unknown as IssueState_;

  if (!input.owner.trim()) {
    throw new DomainError(
      'ISSUE_UNOWNED',
      'A coordination issue needs one owner. "The design team" is not an owner, and an issue owned by a discipline is an ' +
        'issue every member of it believes somebody else has.',
    );
  }
  if (input.affectedParties.length === 0) {
    throw new DomainError(
      'AFFECTED_PARTIES_REQUIRED',
      'Name the parties this affects. A clash is between two disciplines by definition, so an issue affecting nobody but ' +
        'its owner is one where the other side has not been told.',
    );
  }
  if (Number.isNaN(Date.parse(input.by))) {
    throw new DomainError('ISSUE_UNDATED', `"${input.by}" is not a date.`);
  }
  if (!input.targetRevision.trim()) {
    throw new DomainError(
      'TARGET_REVISION_REQUIRED',
      'Name the model revision this will be fixed in. Without it there is nothing for the next run to check against, and ' +
        '"fixed" becomes a claim rather than something the platform can confirm.',
    );
  }

  return moveTo(ctx, record, before, 'ASSIGNED', {
    owner: input.owner,
    affectedParties: input.affectedParties,
    by: input.by,
    targetRevision: input.targetRevision,
  });
}

/** Move an issue along its ladder. */
export function advanceIssue(
  ctx: EngineContext,
  issueId: string,
  input: { to: IssueState; note: string },
): { state: IssueState } {
  authorise(ctx, 'BIM_TWIN', input.to === 'VERIFIED' || input.to === 'CLOSED' ? 'A' : 'U', {
    lifecyclePhase: currentPhase(ctx),
  });

  const record = requireIssue(ctx, issueId);
  const before = record.state as unknown as IssueState_;

  if (before.accepted) {
    throw new DomainError(
      'ISSUE_ACCEPTED',
      `${before.reference} was accepted, not resolved. An accepted issue does not move through verification — there is ` +
        'nothing to verify, because the geometry did not change. Reopen it by running the federation again if the ' +
        'decision no longer holds.',
    );
  }
  if (!LADDER[before.state].includes(input.to)) {
    throw new DomainError(
      'ISSUE_TRANSITION_REFUSED',
      `${before.reference} is ${before.state.toLowerCase().replace(/_/g, ' ')} and cannot move to ` +
        `${input.to.toLowerCase().replace(/_/g, ' ')}. The permitted moves are ` +
        `${LADDER[before.state].map((s) => s.toLowerCase().replace(/_/g, ' ')).join(' or ') || 'none — it is closed'}.`,
    );
  }
  if (!input.note.trim()) {
    throw new DomainError(
      'NOTE_REQUIRED',
      'Say what changed. A coordination issue that walks its whole ladder with nothing written against any step is a ' +
        'status field somebody advanced, not a problem somebody fixed.',
    );
  }

  return moveTo(ctx, record, before, input.to, {}, input.note);
}

function moveTo(
  ctx: EngineContext,
  record: EntityRecord,
  before: IssueState_,
  to: IssueState,
  extra: Record<string, unknown>,
  note?: string,
): { state: IssueState } {
  const entity = { refType: 'CoordinationIssue', refId: record.refId };
  const nextState = {
    ...record.state,
    ...extra,
    state: to,
    history: [
      ...before.history,
      { from: before.state, to, by: ctx.auth.actorId, at: new Date().toISOString(), ...(note ? { note } : {}) },
    ],
  };

  // Verification is its own event: it is the moment somebody other than the
  // party who says they fixed it confirms the geometry actually changed, and an
  // audit reading the ledger should find it without inspecting state. Written
  // as two literals rather than one computed name so the catalogue guardrail
  // can see both.
  if (to === 'VERIFIED') write(ctx, { eventType: 'ISSUE_VERIFIED', entity, nextState });
  else write(ctx, { eventType: 'COORDINATION_ISSUE_ASSIGNED', entity, nextState });

  return { state: to };
}

/**
 * Accept a clash rather than resolve it.
 *
 * The rule the specification states outright, and the one that matters most.
 * Accepting needs a reason, a risk owner and an approval, and the issue is
 * **not** marked resolved: resolved means the geometry changed, accepted means
 * somebody decided to live with it. Every clash register that collapses the two
 * is how a service ends up permanently routed through a structural zone with
 * nobody's name against the decision.
 */
export function acceptIssue(
  ctx: EngineContext,
  issueId: string,
  input: { reason: string; riskOwner: string },
): { state: string; accepted: true } {
  // Approve, not update. Deciding to live with a clash is an authorisation.
  authorise(ctx, 'BIM_TWIN', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = requireIssue(ctx, issueId);
  const before = record.state as unknown as IssueState_;

  if (before.accepted) {
    throw new DomainError('ISSUE_ALREADY_ACCEPTED', `${before.reference} has already been accepted.`);
  }
  if (before.state === 'VERIFIED' || before.state === 'CLOSED') {
    throw new DomainError(
      'ISSUE_ALREADY_RESOLVED',
      `${before.reference} was resolved — the geometry changed. There is nothing left to accept.`,
    );
  }
  if (!input.reason.trim()) {
    throw new DomainError(
      'ACCEPTANCE_UNEXPLAINED',
      'Say why this clash is being lived with. An acceptance with no reason is indistinguishable from an issue somebody ' +
        'closed to clear the register, and the two produce very different buildings.',
    );
  }
  if (!input.riskOwner.trim()) {
    throw new DomainError(
      'RISK_OWNER_REQUIRED',
      'Name who carries the risk. Accepting a clash moves it out of the model and into somebody’s operational life — the ' +
        'person who will be told about it when the valve cannot be reached — and an acceptance with nobody named is a ' +
        'decision the project took collectively, which means nobody took it.',
    );
  }

  write(ctx, {
    eventType: 'COORDINATION_ISSUE_ACCEPTED',
    entity: { refType: 'CoordinationIssue', refId: issueId },
    nextState: {
      ...record.state,
      // The state does not become CLOSED. It stays where it was, with an
      // acceptance recorded against it, so every report can tell an accepted
      // clash from a fixed one without reading a field called `disposition`.
      accepted: {
        reason: input.reason,
        riskOwner: input.riskOwner,
        approvedBy: ctx.auth.actorId,
        at: new Date().toISOString(),
      },
      history: [
        ...before.history,
        {
          from: before.state,
          to: before.state,
          by: ctx.auth.actorId,
          at: new Date().toISOString(),
          note: `Accepted, not resolved. Risk carried by ${input.riskOwner}. ${input.reason}`,
        },
      ],
    },
  });

  return { state: before.state, accepted: true };
}

// --- The position -----------------------------------------------------------

export type CoordinationPosition = {
  federations: Array<{
    federationSetId: string;
    reference: string;
    models: number;
    units: string;
    coordinateSystem: string;
    runs: number;
    lastRunAt?: string;
  }>;
  issues: Array<{
    issueId: string;
    reference: string;
    location: string;
    systems: string;
    severity: string;
    clashCount: number;
    state: string;
    owner?: string;
    by?: string;
    targetRevision?: string;
    accepted: boolean;
    riskOwner?: string;
    /** Runs it has appeared in. More than one closure in the history means it came back. */
    timesSeen: number;
    reopenings: number;
  }>;
  /** Critical, not accepted, not verified. These are stage blockers. */
  blockers: Array<{ reference: string; location: string; systems: string; owner?: string; by?: string }>;
  acceptedNotResolved: number;
  summary: string;
};

export function coordinationPosition(ctx: EngineContext): CoordinationPosition {
  authorise(ctx, 'BIM_TWIN', 'R');

  const runs = ctx.ledger.list(ctx.projectId, 'ClashRun');

  const federations = ctx.ledger.list(ctx.projectId, 'FederationSet').map((record) => {
    const state = record.state as unknown as FederationState;
    const own = runs.filter((run) => run.state.federationSetId === state.id);
    return {
      federationSetId: state.id,
      reference: state.reference,
      models: state.models.length,
      units: state.units,
      coordinateSystem: state.coordinateSystem,
      runs: own.length,
      lastRunAt: own.map((run) => String(run.state.runAt)).sort().at(-1),
    };
  });

  const blockers: CoordinationPosition['blockers'] = [];

  const issues = ctx.ledger.list(ctx.projectId, 'CoordinationIssue').map((record) => {
    const state = record.state as unknown as IssueState_;
    const accepted = state.accepted !== undefined;
    const resolved = state.state === 'VERIFIED' || state.state === 'CLOSED';

    // A critical clash nobody has resolved and nobody has accepted. Accepted is
    // not a blocker — somebody with the authority decided — and pretending
    // otherwise would produce a list that never clears and stops being read.
    if (state.severity === 'CRITICAL' && !accepted && !resolved) {
      blockers.push({
        reference: state.reference,
        location: state.location,
        systems: state.systems,
        owner: state.owner,
        by: state.by,
      });
    }

    return {
      issueId: state.id,
      reference: state.reference,
      location: state.location,
      systems: state.systems,
      severity: state.severity,
      clashCount: state.clashCount,
      state: state.state,
      owner: state.owner,
      by: state.by,
      targetRevision: state.targetRevision,
      accepted,
      riskOwner: state.accepted?.riskOwner,
      timesSeen: state.seenInRuns.length,
      reopenings: state.history.filter((entry) => entry.to === 'OPEN' && entry.from !== 'OPEN').length,
    };
  });

  const rank: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  issues.sort((a, b) => (rank[a.severity] ?? 4) - (rank[b.severity] ?? 4) || b.clashCount - a.clashCount);

  const acceptedNotResolved = issues.filter((issue) => issue.accepted).length;
  const parts = [`${federations.length} federation set${federations.length === 1 ? '' : 's'}`, `${issues.length} issues`];
  const rawClashes = runs.reduce((sum, run) => sum + Number(run.state.clashCount ?? 0), 0);
  if (rawClashes > 0) parts.push(`grouped from ${rawClashes} clashes`);
  if (blockers.length > 0) parts.push(`${blockers.length} critical and unresolved`);
  if (acceptedNotResolved > 0) parts.push(`${acceptedNotResolved} accepted rather than resolved`);
  const recurred = issues.filter((issue) => issue.reopenings > 0).length;
  if (recurred > 0) parts.push(`${recurred} found again after being closed`);

  return { federations, issues, blockers, acceptedNotResolved, summary: parts.join(', ') + '.' };
}
