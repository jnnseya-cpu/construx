import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, write, type EngineContext } from '../engines/context.ts';

/**
 * CM-WF-01 — systemisation and the commissioning plan.
 *
 * The first thing the commissioning stage needs and the one thing the platform
 * had no representation of. `engines/handover.ts` records a commissioning test
 * against a `systemId`, and until now that id was a free-text string: two
 * engineers could test "AHU-1" and "AHU-01" and the platform would hold two
 * systems, or one engineer could test a fan coil nobody had said belonged to
 * anything.
 *
 * **Every commissioned asset belongs to one boundary.** AC-CM-WF-01-01, and the
 * exception control that follows from it — a boundary overlap or gap blocks plan
 * approval. Both failures are silent and both are dangerous. A **gap** is an
 * asset in nobody's system, which is the asset nobody tests. An **overlap** is
 * an asset in two systems, which is the asset each team believes the other is
 * testing. The platform detects both rather than asking somebody to look.
 *
 * **A test with no witness is a test nobody has to attend.** AC-CM-WF-01-02
 * requires stage, owner, witness, criteria and prerequisite on every required
 * test, and the plan cannot be approved with any of them missing. The criteria
 * cite a controlled source, because "to the satisfaction of the engineer" is not
 * an acceptance criterion.
 *
 * **The programme has to trace to something.** AC-CM-WF-01-03: a commissioning
 * programme whose milestones do not connect to construction completion at one
 * end and handover at the other is a plan for a building nobody is constructing.
 *
 * **Temporary operation is a separate state.** The exception control names it,
 * and the reason is that running a system to dry out a building, power a site
 * cabin or provide temporary heat is not commissioning it — but the plant runs,
 * the hours accrue and the warranty starts. Recorded as its own declaration so
 * it can never be mistaken for a commissioned system.
 */

export const SYSTEM_LEVEL = ['FACILITY', 'SYSTEM', 'SUBSYSTEM', 'EQUIPMENT'] as const;
export type SystemLevel = (typeof SYSTEM_LEVEL)[number];

/** Which level a node may sit under. A subsystem hanging off a facility is a missing system. */
const PARENT_OF: Record<SystemLevel, SystemLevel | undefined> = {
  FACILITY: undefined,
  SYSTEM: 'FACILITY',
  SUBSYSTEM: 'SYSTEM',
  EQUIPMENT: 'SUBSYSTEM',
};

export type SystemNodeState = {
  nodeId: string;
  tag: string;
  level: SystemLevel;
  parentTag?: string;
  name: string;
  boundary: string;
  location?: string;
  /**
   * The asset tags this node's boundary contains.
   *
   * Declared on the node that owns them rather than on each asset, because the
   * question the workflow asks — "is this asset in exactly one boundary?" — is a
   * question about the boundaries, and an answer stored on the asset would let
   * two boundaries disagree with it.
   */
  assetTags: string[];
  energisationSequence?: number;
  hierarchyApproved: boolean;
};

function nodes(ctx: EngineContext): SystemNodeState[] {
  return ctx.ledger.list(ctx.projectId, 'SystemNode').map((record) => record.state as unknown as SystemNodeState);
}

/** Define a node of the facility → system → subsystem → equipment hierarchy. */
export function defineSystem(
  ctx: EngineContext,
  input: {
    tag: string;
    level: SystemLevel;
    parentTag?: string;
    name: string;
    boundary: string;
    location?: string;
    assetTags?: string[];
    energisationSequence?: number;
  },
): { nodeId: string; tag: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'C', { lifecyclePhase: currentPhase(ctx) });

  const tag = input.tag.trim();
  if (!tag || !input.name.trim()) {
    throw new DomainError('SYSTEM_UNTAGGED', 'A system node carries a stable tag and a name.');
  }
  if (input.boundary.trim().length < 15) {
    throw new DomainError(
      'BOUNDARY_REQUIRED',
      `${tag} has no boundary description. The tag says what it is called; the boundary says where it stops, and the ` +
        'boundary is the half that decides who tests what.',
    );
  }

  const existing = nodes(ctx);
  if (existing.some((node) => node.tag === tag)) {
    throw new DomainError(
      'TAG_TAKEN',
      `${tag} is already defined. A tag is the stable identity every test, reading and certificate hangs off, and reusing ` +
        'one silently merges two systems.',
    );
  }

  const expectedParent = PARENT_OF[input.level];
  if (expectedParent === undefined) {
    if (input.parentTag) {
      throw new DomainError('FACILITY_HAS_NO_PARENT', 'A facility sits at the top of the hierarchy.');
    }
  } else {
    if (!input.parentTag) {
      throw new DomainError(
        'PARENT_REQUIRED',
        `A ${input.level.toLowerCase()} sits under a ${expectedParent.toLowerCase()}. Without one it is an asset in nobody's ` +
          'boundary, which is the asset nobody tests.',
      );
    }
    const parent = existing.find((node) => node.tag === input.parentTag);
    if (!parent) {
      throw new DomainError('PARENT_NOT_FOUND', `No node tagged ${input.parentTag}.`, 404);
    }
    if (parent.level !== expectedParent) {
      throw new DomainError(
        'PARENT_WRONG_LEVEL',
        `${input.parentTag} is a ${parent.level.toLowerCase()}, and a ${input.level.toLowerCase()} sits under a ` +
          `${expectedParent.toLowerCase()}. A level skipped here is a level of the hierarchy nobody owns.`,
      );
    }
  }

  const nodeId = ulid();

  write(ctx, {
    eventType: 'SYSTEM_NODE_DEFINED',
    entity: { refType: 'SystemNode', refId: nodeId },
    nextState: {
      nodeId,
      projectId: ctx.projectId,
      tag,
      level: input.level,
      parentTag: input.parentTag,
      name: input.name,
      boundary: input.boundary,
      location: input.location,
      assetTags: input.assetTags ?? [],
      energisationSequence: input.energisationSequence,
      hierarchyApproved: false,
      definedBy: ctx.auth.actorId,
      definedAt: new Date().toISOString(),
    },
  });

  return { nodeId, tag };
}

export type HierarchyIntegrity = {
  /** An asset claimed by more than one boundary — each team believes the other tests it. */
  overlaps: Array<{ assetTag: string; claimedBy: string[] }>;
  /** A node that declares no assets and has no children — a boundary around nothing. */
  emptyBoundaries: string[];
  /** Equipment defined but named in no parent's asset list. */
  unclaimedEquipment: string[];
  sound: boolean;
};

/**
 * Check the hierarchy holds together.
 *
 * Read on its own as well as at approval, because the useful moment to find an
 * overlap is while somebody is still drawing the boundaries.
 */
export function checkHierarchy(ctx: EngineContext): HierarchyIntegrity {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'R');
  return integrityOf(nodes(ctx));
}

function integrityOf(all: SystemNodeState[]): HierarchyIntegrity {
  const claims = new Map<string, string[]>();
  for (const node of all) {
    for (const assetTag of node.assetTags) {
      claims.set(assetTag, [...(claims.get(assetTag) ?? []), node.tag]);
    }
  }

  const overlaps = [...claims.entries()]
    .filter(([, claimedBy]) => claimedBy.length > 1)
    .map(([assetTag, claimedBy]) => ({ assetTag, claimedBy }));

  const hasChild = new Set(all.map((node) => node.parentTag).filter((tag): tag is string => Boolean(tag)));
  const emptyBoundaries = all
    .filter((node) => node.level !== 'FACILITY' && node.assetTags.length === 0 && !hasChild.has(node.tag))
    .map((node) => node.tag);

  const unclaimedEquipment = all
    .filter((node) => node.level === 'EQUIPMENT' && !claims.has(node.tag))
    .map((node) => node.tag);

  return {
    overlaps,
    emptyBoundaries,
    unclaimedEquipment,
    sound: overlaps.length === 0 && emptyBoundaries.length === 0 && unclaimedEquipment.length === 0,
  };
}

/** Approve the hierarchy. After this the tags are what every test hangs off. */
export function approveHierarchy(ctx: EngineContext, input: { approvedBy: string }): { nodes: number } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'A', { lifecyclePhase: currentPhase(ctx) });

  const all = nodes(ctx);
  if (all.length === 0) {
    throw new DomainError('HIERARCHY_EMPTY', 'Nothing has been defined, so there is no hierarchy to approve.');
  }
  if (!input.approvedBy.trim()) {
    throw new DomainError('APPROVAL_UNSIGNED', 'Name the commissioning manager approving the systemisation.');
  }

  const integrity = integrityOf(all);
  if (integrity.overlaps.length > 0) {
    const first = integrity.overlaps[0]!;
    throw new DomainError(
      'BOUNDARY_OVERLAP',
      `${first.assetTag} is inside ${first.claimedBy.join(' and ')}. An asset in two boundaries is the asset each team ` +
        `believes the other is testing${integrity.overlaps.length > 1 ? `, and ${integrity.overlaps.length - 1} more are` : ''}.`,
    );
  }
  if (integrity.unclaimedEquipment.length > 0) {
    throw new DomainError(
      'BOUNDARY_GAP',
      `${integrity.unclaimedEquipment.join(', ')} ${integrity.unclaimedEquipment.length === 1 ? 'is' : 'are'} defined but ` +
        'inside no boundary. An asset in nobody’s system is the asset nobody tests.',
    );
  }
  if (integrity.emptyBoundaries.length > 0) {
    throw new DomainError(
      'BOUNDARY_EMPTY',
      `${integrity.emptyBoundaries.join(', ')} ${integrity.emptyBoundaries.length === 1 ? 'contains' : 'contain'} nothing. ` +
        'A boundary around no assets and no subsystems produces a test pack with no scope.',
    );
  }

  const approvedAt = new Date().toISOString();
  for (const node of all) {
    write(ctx, {
      eventType: 'SYSTEM_HIERARCHY_APPROVED',
      entity: { refType: 'SystemNode', refId: node.nodeId },
      nextState: { ...node, hierarchyApproved: true, approvedBy: input.approvedBy, approvedAt },
    });
  }

  return { nodes: all.length };
}

// --- The commissioning plan -------------------------------------------------

export const TEST_STAGE = ['FAT', 'SAT', 'PRE_FUNCTIONAL', 'FUNCTIONAL', 'INTEGRATED', 'RELIABILITY'] as const;
export type TestStage = (typeof TEST_STAGE)[number];

export type PlannedTest = {
  reference: string;
  systemTag: string;
  stage: TestStage;
  objective: string;
  /** Who runs it. */
  owner: string;
  /** Who has to be there for the result to count. */
  witness: string;
  acceptanceCriteria: string;
  /** The controlled document the criteria come from. */
  criteriaSource: string;
  /** What has to be true before it can start. */
  prerequisite: string;
  noticePeriodDays: number;
};

export type MilestoneLink = {
  milestone: string;
  type: 'CONSTRUCTION' | 'COMMISSIONING' | 'HANDOVER';
  date: string;
  /** The milestone this one follows. */
  dependsOn?: string;
};

/** Draft the plan: the test matrix and the programme it hangs on. */
export function draftCommissioningPlan(
  ctx: EngineContext,
  input: { title: string; tests: PlannedTest[]; milestones: MilestoneLink[] },
): { planId: string; tests: number } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (!input.title.trim()) throw new DomainError('PLAN_UNNAMED', 'Name the plan.');
  if (input.tests.length === 0) {
    throw new DomainError('NO_TESTS', 'A commissioning plan with no tests in it commissions nothing.');
  }

  const known = new Set(nodes(ctx).map((node) => node.tag));
  const orphan = input.tests.find((test) => !known.has(test.systemTag));
  if (orphan) {
    throw new DomainError(
      'TEST_SYSTEM_UNKNOWN',
      `${orphan.reference} is planned against ${orphan.systemTag}, which is not a defined system. Every test belongs to a ` +
        'boundary, or nobody can say what passing it proves.',
    );
  }

  const planId = ulid();

  write(ctx, {
    eventType: 'COMMISSIONING_PLAN_DRAFTED',
    entity: { refType: 'CommissioningPlan', refId: planId },
    nextState: {
      planId,
      projectId: ctx.projectId,
      title: input.title,
      tests: input.tests,
      milestones: input.milestones,
      revision: 1,
      status: 'DRAFT',
      draftedBy: ctx.auth.actorId,
      draftedAt: new Date().toISOString(),
    },
  });

  return { planId, tests: input.tests.length };
}

function requirePlan(ctx: EngineContext, planId: string) {
  const record = ctx.ledger.get({ refType: 'CommissioningPlan', refId: planId });
  if (!record) throw new DomainError('PLAN_NOT_FOUND', `No commissioning plan ${planId}`, 404);
  return record;
}

/**
 * Approve the plan.
 *
 * Every refusal here is one of the acceptance criteria, checked rather than
 * asserted: the hierarchy holds, each test carries its five mandatory fields,
 * and the programme reaches construction at one end and handover at the other.
 */
export function approveCommissioningPlan(
  ctx: EngineContext,
  planId: string,
  input: { approvedBy: string },
): { revision: number; packsRequired: number } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = requirePlan(ctx, planId);
  if (record.state.status === 'APPROVED') {
    throw new DomainError('ALREADY_APPROVED', `Revision ${String(record.state.revision)} is already approved.`);
  }
  if (!input.approvedBy.trim()) {
    throw new DomainError('APPROVAL_UNSIGNED', 'Name the competent commissioning manager approving the plan.');
  }

  const all = nodes(ctx);
  if (all.length === 0 || !all.every((node) => node.hierarchyApproved)) {
    throw new DomainError(
      'HIERARCHY_NOT_APPROVED',
      'The system hierarchy has not been approved. A plan approved over unapproved boundaries is a plan whose scope can ' +
        'still change underneath it.',
    );
  }

  const tests = (record.state.tests as PlannedTest[] | undefined) ?? [];
  for (const test of tests) {
    const missing = (['owner', 'witness', 'acceptanceCriteria', 'criteriaSource', 'prerequisite'] as const).filter(
      (field) => !String(test[field] ?? '').trim(),
    );
    if (missing.length > 0) {
      throw new DomainError(
        'TEST_INCOMPLETE',
        `${test.reference} has no ${missing.join(', no ')}. A test with no witness is a test nobody has to attend, and one ` +
          'whose criteria cite no controlled source cannot be argued from.',
      );
    }
    if (test.noticePeriodDays <= 0) {
      throw new DomainError(
        'NOTICE_PERIOD_REQUIRED',
        `${test.reference} gives no notice period. A witness who finds out on the day does not attend.`,
      );
    }
  }

  const milestones = (record.state.milestones as MilestoneLink[] | undefined) ?? [];
  const types = new Set(milestones.map((milestone) => milestone.type));
  if (!types.has('CONSTRUCTION') || !types.has('HANDOVER')) {
    throw new DomainError(
      'PROGRAMME_UNTRACED',
      'The commissioning programme names no ' +
        [!types.has('CONSTRUCTION') ? 'construction' : '', !types.has('HANDOVER') ? 'handover' : '']
          .filter(Boolean)
          .join(' or ') +
        ' milestone. A commissioning programme that connects to neither end is a plan for a building nobody is ' +
        'constructing and nobody is taking over.',
    );
  }
  const named = new Set(milestones.map((milestone) => milestone.milestone));
  const dangling = milestones.find((milestone) => milestone.dependsOn && !named.has(milestone.dependsOn));
  if (dangling) {
    throw new DomainError(
      'MILESTONE_DANGLING',
      `${dangling.milestone} depends on ${dangling.dependsOn}, which is not in the programme.`,
    );
  }

  const revision = Number(record.state.revision ?? 1);
  const approvedAt = new Date().toISOString();

  write(ctx, {
    eventType: 'COMMISSIONING_PLAN_APPROVED',
    entity: { refType: 'CommissioningPlan', refId: planId },
    nextState: { ...record.state, status: 'APPROVED', approvedBy: input.approvedBy, approvedAt },
  });

  // One requirement per planned test. The pack itself is CM-WF-02's; what is
  // recorded here is that the plan says one is owed, so a test executed without
  // one is visibly outside the plan rather than merely undocumented.
  for (const test of tests) {
    write(ctx, {
      eventType: 'TEST_PACK_REQUIRED',
      entity: { refType: 'TestPackRequirement', refId: `${planId}-${test.reference}` },
      nextState: {
        planId,
        projectId: ctx.projectId,
        reference: test.reference,
        systemTag: test.systemTag,
        stage: test.stage,
        owner: test.owner,
        witness: test.witness,
        acceptanceCriteria: test.acceptanceCriteria,
        criteriaSource: test.criteriaSource,
        prerequisite: test.prerequisite,
        noticePeriodDays: test.noticePeriodDays,
        planRevision: revision,
        requiredAt: approvedAt,
      },
    });
  }

  return { revision, packsRequired: tests.length };
}

/**
 * Update the approved baseline.
 *
 * The exception control: a change to systemisation requires its impact on tests,
 * assets and handover records. All three, because a boundary that moves without
 * anybody saying what it does to the test matrix leaves a plan that reads as
 * current and tests a system that no longer exists.
 */
export function updateCommissioningBaseline(
  ctx: EngineContext,
  planId: string,
  input: {
    change: string;
    impactOnTests: string;
    impactOnAssets: string;
    impactOnHandover: string;
    updatedBy: string;
    tests?: PlannedTest[];
    milestones?: MilestoneLink[];
  },
): { revision: number } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = requirePlan(ctx, planId);
  if (record.state.status !== 'APPROVED') {
    throw new DomainError(
      'NOT_BASELINED',
      'This plan has not been approved, so there is no baseline to change — edit the draft.',
    );
  }

  const missing = (['change', 'impactOnTests', 'impactOnAssets', 'impactOnHandover'] as const).filter(
    (field) => input[field].trim().length < 10,
  );
  if (missing.length > 0) {
    throw new DomainError(
      'IMPACT_UNSTATED',
      `No ${missing.join(', no ')} recorded. A change to systemisation reaches the test matrix, the asset register and the ` +
        'handover record, and one made without saying how leaves a plan that reads as current and tests a system that no ' +
        'longer exists.',
    );
  }
  if (!input.updatedBy.trim()) throw new DomainError('UPDATE_UNSIGNED', 'Name the person making the change.');

  const revision = Number(record.state.revision ?? 1) + 1;

  write(ctx, {
    eventType: 'COMMISSIONING_BASELINE_UPDATED',
    entity: { refType: 'CommissioningPlan', refId: planId },
    nextState: {
      ...record.state,
      revision,
      tests: input.tests ?? record.state.tests,
      milestones: input.milestones ?? record.state.milestones,
      changes: [
        ...((record.state.changes as unknown[] | undefined) ?? []),
        {
          revision,
          change: input.change,
          impactOnTests: input.impactOnTests,
          impactOnAssets: input.impactOnAssets,
          impactOnHandover: input.impactOnHandover,
          updatedBy: input.updatedBy,
          updatedAt: new Date().toISOString(),
        },
      ],
    },
  });

  return { revision };
}

/**
 * Declare temporary operation of a system.
 *
 * Its own record, never a state of commissioning. Running plant to dry out a
 * building, power a cabin or provide temporary heat is not commissioning it —
 * but the plant runs, the hours accrue and the manufacturer's warranty starts,
 * and a platform that let this be entered as a commissioning run would report a
 * system as proven when nobody had tested anything.
 */
export function declareTemporaryOperation(
  ctx: EngineContext,
  input: {
    systemTag: string;
    purpose: string;
    from: string;
    until: string;
    responsibleParty: string;
    /** What is not in place that commissioning would require. */
    conditions: string[];
  },
): { declarationId: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'A', { lifecyclePhase: currentPhase(ctx) });

  if (!nodes(ctx).some((node) => node.tag === input.systemTag)) {
    throw new DomainError('SYSTEM_NOT_FOUND', `No system tagged ${input.systemTag}.`, 404);
  }
  if (input.purpose.trim().length < 10) {
    throw new DomainError(
      'PURPOSE_REQUIRED',
      'Say what the system is being run for. Temporary operation is a controlled state, and the control is that somebody ' +
        'wrote down why the plant is running before it was commissioned.',
    );
  }
  if (Number.isNaN(Date.parse(input.from)) || Number.isNaN(Date.parse(input.until))) {
    throw new DomainError('PERIOD_REQUIRED', 'Temporary operation runs between two dates. Open-ended is not temporary.');
  }
  if (Date.parse(input.until) <= Date.parse(input.from)) {
    throw new DomainError('PERIOD_REQUIRED', 'The end of the period is not after the start of it.');
  }
  if (!input.responsibleParty.trim()) {
    throw new DomainError(
      'RESPONSIBILITY_REQUIRED',
      'Name the party operating it. Running hours accrue against somebody, and the warranty follows them.',
    );
  }
  if (input.conditions.length === 0) {
    throw new DomainError(
      'CONDITIONS_REQUIRED',
      'State what is not in place that commissioning would require. If the answer is genuinely nothing, the system is ready ' +
        'to be commissioned rather than temporarily operated.',
    );
  }

  const declarationId = ulid();

  write(ctx, {
    eventType: 'TEMPORARY_OPERATION_DECLARED',
    entity: { refType: 'TemporaryOperation', refId: declarationId },
    nextState: {
      declarationId,
      projectId: ctx.projectId,
      systemTag: input.systemTag,
      purpose: input.purpose,
      from: input.from,
      until: input.until,
      responsibleParty: input.responsibleParty,
      conditions: input.conditions,
      declaredBy: ctx.auth.actorId,
      declaredAt: new Date().toISOString(),
    },
  });

  return { declarationId };
}

// --- The position -----------------------------------------------------------

export type SystemisationPosition = {
  hierarchy: Array<{ tag: string; level: SystemLevel; name: string; parentTag?: string; assets: number; approved: boolean }>;
  integrity: HierarchyIntegrity;
  plans: Array<{ planId: string; title: string; revision: number; status: string; tests: number; changes: number }>;
  packsRequired: Array<{ reference: string; systemTag: string; stage: TestStage; witness: string; noticePeriodDays: number }>;
  temporaryOperation: Array<{ systemTag: string; purpose: string; until: string; expired: boolean; responsibleParty: string }>;
  summary: string;
};

export function systemisationPosition(
  ctx: EngineContext,
  today = new Date().toISOString().slice(0, 10),
): SystemisationPosition {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'R');

  const all = nodes(ctx);
  const integrity = integrityOf(all);

  const plans = ctx.ledger.list(ctx.projectId, 'CommissioningPlan').map((record) => ({
    planId: String(record.state.planId),
    title: String(record.state.title),
    revision: Number(record.state.revision ?? 1),
    status: String(record.state.status),
    tests: ((record.state.tests as unknown[] | undefined) ?? []).length,
    changes: ((record.state.changes as unknown[] | undefined) ?? []).length,
  }));

  const temporaryOperation = ctx.ledger.list(ctx.projectId, 'TemporaryOperation').map((record) => ({
    systemTag: String(record.state.systemTag),
    purpose: String(record.state.purpose),
    until: String(record.state.until),
    expired: String(record.state.until).slice(0, 10) < today,
    responsibleParty: String(record.state.responsibleParty),
  }));

  const parts: string[] = [];
  parts.push(`${all.length} node${all.length === 1 ? '' : 's'} defined`);
  if (!integrity.sound) {
    if (integrity.overlaps.length > 0) parts.push(`${integrity.overlaps.length} asset in two boundaries`);
    if (integrity.unclaimedEquipment.length > 0) parts.push(`${integrity.unclaimedEquipment.length} in none`);
    if (integrity.emptyBoundaries.length > 0) parts.push(`${integrity.emptyBoundaries.length} boundary around nothing`);
  }
  const expired = temporaryOperation.filter((entry) => entry.expired).length;
  if (expired > 0) parts.push(`${expired} system running past the end of its temporary operation period`);

  return {
    hierarchy: all.map((node) => ({
      tag: node.tag,
      level: node.level,
      name: node.name,
      parentTag: node.parentTag,
      assets: node.assetTags.length,
      approved: node.hierarchyApproved,
    })),
    integrity,
    plans,
    packsRequired: ctx.ledger.list(ctx.projectId, 'TestPackRequirement').map((record) => ({
      reference: String(record.state.reference),
      systemTag: String(record.state.systemTag),
      stage: record.state.stage as TestStage,
      witness: String(record.state.witness),
      noticePeriodDays: Number(record.state.noticePeriodDays),
    })),
    temporaryOperation,
    summary: parts.join(', ') + '.',
  };
}
