import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';

/**
 * When one pursuit becomes more than one job.
 *
 * ## The failure this exists to prevent
 *
 * §10's rule is one persistent project aggregate, and §5's whole argument is
 * that an award converts that aggregate in place rather than producing a second
 * record. Both are right and neither covers the case where the *work itself*
 * genuinely splits: one tender, two contracts. A framework place and its first
 * three call-offs. A scheme let in two phases eighteen months apart.
 *
 * What happens without a relationship is not that the platform refuses. It is
 * that somebody opens a second project, types the client, the site, the team
 * and the contract in again, and the two records drift — which is the
 * re-keying this platform exists to remove, arriving through the one door left
 * open. The parent is the pursuit; the children are the jobs; and the link
 * between them is a record rather than a naming convention in the project name.
 *
 * ## Why not just a `parentProjectId` field
 *
 * Because the relationship carries more than an id. §10.1 asks for the type,
 * the reason and the approval behind it, and those are properties of the *link*
 * rather than of either project: the same two projects can only ever be related
 * one way, but why they were related is the thing a reader needs three years
 * later and the thing a field on the child cannot hold.
 *
 * ## No cycles
 *
 * §10.2 states it twice — `CHECK(project.parent_project_id != project.id)` and
 * "No cycles" on the relationship itself — and it is not theoretical once an
 * existing project can be adopted. A cycle makes every ancestor walk
 * non-terminating, which means the portfolio rollup that walks it hangs rather
 * than reports wrongly. `assertNoCycle` walks up from the proposed parent and
 * refuses if the child is already above it.
 */

/**
 * The ways one project can sit under another, as a closed catalogue.
 *
 * Three, each a real thing a construction business does, and none of them a
 * synonym for another. A free list would fill with "related", which is a link
 * that tells a reader nothing and a rollup nothing at all.
 */
export const RELATIONSHIP_TYPES = {
  CONTRACT_FROM_OPPORTUNITY: {
    label: 'Contract from this opportunity',
    what: 'One pursuit produced this contract, and may have produced others beside it',
  },
  FRAMEWORK_CALL_OFF: {
    label: 'Call-off under this framework',
    what: 'An instruction under a framework appointment — the appointment is the parent, the call-off is the job',
  },
  SCHEME_PHASE: {
    label: 'Phase of this scheme',
    what: 'One scheme let in phases, each with its own contract, programme and account',
  },
} as const;

export type RelationshipType = keyof typeof RELATIONSHIP_TYPES;
export const RELATIONSHIP_TYPE_CODES = Object.keys(RELATIONSHIP_TYPES) as RelationshipType[];

export type ProjectRelationship = {
  id: string;
  tenantId: string;
  parentProjectId: string;
  childProjectId: string;
  relationshipType: RelationshipType;
  reason: string;
  /** Who authorised the split, which is §10.1's `approval_id` by another name. */
  approvedBy: string;
  approvedAt: string;
  /** The client's key for the request that created it — §11.2 makes it mandatory. */
  idempotencyKey?: string;
};

/** Every relationship in this tenancy, which is what an ancestor walk needs. */
function relationshipsOf(ctx: EngineContext): ProjectRelationship[] {
  return ctx.ledger
    .listByTenant(ctx.tenantId, 'ProjectRelationship')
    .map((record) => record.state as unknown as ProjectRelationship);
}

/**
 * Refuse a link that would put a project above itself.
 *
 * Walks up from the proposed parent. If the proposed child is already anywhere
 * on that chain, adding the link closes a loop — and a loop is not a wrong
 * answer, it is a rollup that never finishes. The walk is bounded by the number
 * of relationships as well, so a chain corrupted some other way still
 * terminates rather than hanging the request that found it.
 */
export function assertNoCycle(
  relationships: ProjectRelationship[],
  parentProjectId: string,
  childProjectId: string,
): void {
  if (parentProjectId === childProjectId) {
    throw new DomainError(
      'PROJECT_RELATIONSHIP_CYCLE',
      'A project cannot be its own parent.',
      422,
      [{ field: 'childProjectId', message: 'Choose a different project' }],
    );
  }

  const parentOf = new Map(relationships.map((link) => [link.childProjectId, link.parentProjectId]));
  let cursor: string | undefined = parentProjectId;
  for (let step = 0; step <= relationships.length && cursor; step += 1) {
    if (cursor === childProjectId) {
      throw new DomainError(
        'PROJECT_RELATIONSHIP_CYCLE',
        'That project is already above this one in the family, so linking them would make each the ancestor of the ' +
          'other. Nothing could then say which pursuit produced which job.',
        422,
        [{ field: 'childProjectId', message: 'Already an ancestor of the proposed parent' }],
      );
    }
    cursor = parentOf.get(cursor);
  }
}

/**
 * Put an existing project under a parent — AC-10.
 *
 * The child is a project in its own right: its own id, its own chain, its own
 * award and its own account. What this adds is the statement that it came from
 * the parent's pursuit, which is what makes "we won two contracts off that
 * tender" a thing the platform can answer rather than a thing somebody
 * remembers.
 *
 * **The child is created first, by `createProject`, and linked here.** One way
 * to make a project, which is settled decision 6 applied to the most important
 * record on the platform: a second creation path inside this function would be
 * a second place where a project's phase, gates and evidence vault are set up.
 */
export function linkChildProject(
  ctx: EngineContext,
  input: {
    /** The pursuit. `ctx.projectId` is the parent by default. */
    parentProjectId?: string;
    childProjectId: string;
    relationshipType: string;
    reason: string;
    idempotencyKey?: string;
  },
): ProjectRelationship {
  // `A` on PROJECT_SETUP: saying that one pursuit produced two jobs is a
  // governance statement about how the work is accounted for, not an edit.
  authorise(ctx, 'PROJECT_SETUP', 'A');

  if (!(input.relationshipType in RELATIONSHIP_TYPES)) {
    throw new DomainError(
      'RELATIONSHIP_TYPE_UNKNOWN',
      `"${input.relationshipType}" is not a relationship type.`,
      422,
      [{ field: 'relationshipType', message: `One of ${RELATIONSHIP_TYPE_CODES.join(', ')}` }],
    );
  }
  const relationshipType = input.relationshipType as RelationshipType;

  const reason = (input.reason ?? '').trim();
  if (reason.length < 10) {
    throw new DomainError(
      'RELATIONSHIP_UNJUSTIFIED',
      'Say why these are two jobs rather than one. That sentence is what a reader needs three years later.',
      422,
      [{ field: 'reason', message: 'Required, and long enough to be read' }],
    );
  }

  const parentProjectId = input.parentProjectId ?? ctx.projectId;
  const parent = ctx.ledger.require({ refType: 'Project', refId: parentProjectId });
  const child = ctx.ledger.require({ refType: 'Project', refId: input.childProjectId });

  // §10.2's foreign key. Both reads are already tenant-scoped by the context,
  // and this is the assertion that says so rather than assuming it.
  if (parent.tenantId !== ctx.tenantId || child.tenantId !== ctx.tenantId) {
    throw new DomainError(
      'PROJECT_RELATIONSHIP_CROSS_TENANT',
      'A project family lives inside one tenancy. Work shared across organisations is a membership, not a parent.',
      403,
    );
  }

  const existing = relationshipsOf(ctx);

  /*
   * §11.2 makes the key mandatory on child creation, and this is why: the
   * request that creates the second contract is the one a person double-clicks.
   * A retry carrying the key of an attempt that already succeeded gets that
   * relationship back rather than a second one saying the same thing.
   */
  if (input.idempotencyKey) {
    const replay = existing.find((link) => link.idempotencyKey === input.idempotencyKey);
    if (replay) return replay;
  }

  const already = existing.find(
    (link) => link.parentProjectId === parentProjectId && link.childProjectId === input.childProjectId,
  );
  if (already) {
    throw new DomainError(
      'PROJECT_RELATIONSHIP_EXISTS',
      `${String(child.state.name)} is already recorded as a ${RELATIONSHIP_TYPES[already.relationshipType].label.toLowerCase()} ` +
        `of ${String(parent.state.name)}.`,
      409,
    );
  }
  const otherParent = existing.find((link) => link.childProjectId === input.childProjectId);
  if (otherParent) {
    throw new DomainError(
      'PROJECT_RELATIONSHIP_EXISTS',
      'That project already sits under a different parent. One job comes from one pursuit, or the rollup counts it twice.',
      409,
    );
  }

  assertNoCycle(existing, parentProjectId, input.childProjectId);

  const now = new Date().toISOString();
  const relationship: ProjectRelationship = {
    id: ulid(),
    tenantId: ctx.tenantId,
    parentProjectId,
    childProjectId: input.childProjectId,
    relationshipType,
    reason,
    approvedBy: ctx.auth.actorId,
    approvedAt: now,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  };

  write(ctx, {
    eventType: 'PROJECT_CHILD_LINKED',
    entity: { refType: 'ProjectRelationship', refId: relationship.id },
    // Written on the parent's stream. The question this record answers is
    // "what did this pursuit produce", and the pursuit is where somebody asks.
    projectId: parentProjectId,
    nextState: relationship as unknown as Record<string, unknown>,
  });

  return relationship;
}

/**
 * The family around this project — what it came from, and what came from it.
 *
 * Both directions in one answer, because a person on a child project needs the
 * parent as much as a person on the parent needs the children, and two reads
 * for one question is two screens for one question.
 */
export function projectFamily(ctx: EngineContext): {
  projectId: string;
  parent: { projectId: string; name: string; relationshipType: RelationshipType; reason: string } | null;
  children: Array<{
    projectId: string;
    name: string;
    relationshipType: RelationshipType;
    reason: string;
    lifecycleState: string | null;
    contractValueMinor: number | null;
  }>;
  types: Array<{ code: RelationshipType; label: string; what: string }>;
  summary: string;
} {
  authorise(ctx, 'PROJECT_SETUP', 'R');

  const links = relationshipsOf(ctx);
  const nameOf = (projectId: string): string =>
    String(ctx.ledger.get({ refType: 'Project', refId: projectId })?.state.name ?? projectId);

  const up = links.find((link) => link.childProjectId === ctx.projectId);
  const down = links.filter((link) => link.parentProjectId === ctx.projectId);

  const children = down.map((link) => {
    const state = ctx.ledger.get({ refType: 'Project', refId: link.childProjectId })?.state ?? {};
    return {
      projectId: link.childProjectId,
      name: String(state.name ?? link.childProjectId),
      relationshipType: link.relationshipType,
      reason: link.reason,
      lifecycleState: typeof state.lifecycleState === 'string' ? state.lifecycleState : null,
      contractValueMinor: typeof state.contractValueMinor === 'number' ? state.contractValueMinor : null,
    };
  });

  return {
    projectId: ctx.projectId,
    parent: up
      ? {
          projectId: up.parentProjectId,
          name: nameOf(up.parentProjectId),
          relationshipType: up.relationshipType,
          reason: up.reason,
        }
      : null,
    children,
    types: RELATIONSHIP_TYPE_CODES.map((code) => ({
      code,
      label: RELATIONSHIP_TYPES[code].label,
      what: RELATIONSHIP_TYPES[code].what,
    })),
    summary:
      children.length === 0 && !up
        ? 'This project stands on its own: it came from no other pursuit and has produced no separate contracts.'
        : [
            up ? `Came from ${nameOf(up.parentProjectId)} — ${RELATIONSHIP_TYPES[up.relationshipType].label.toLowerCase()}.` : '',
            children.length > 0
              ? `${children.length} separate contract${children.length === 1 ? '' : 's'} came out of this one, each with its own award and account.`
              : '',
          ]
            .filter(Boolean)
            .join(' '),
  };
}
