import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import { CDE_STATE, type CDEState } from './designplan.ts';

/**
 * The common data environment.
 *
 * One place every drawing, model, specification and schedule lives, so that
 * "the current version" is a fact the platform can state rather than something
 * four people believe four different answers to. The cost of not having one is
 * not confusion; it is a gang building to a superseded detail, and finding out
 * at the inspection.
 *
 * The platform already had most of the parts and none of the middle. Deliverables
 * carried a CDE state and were *planned* items — a promise that a drawing will
 * exist by a date. Drawings carried revisions. Transmittals recorded issuing
 * documents to people. The evidence store held the bytes. What was missing was
 * the thing all of those are about: **the container** — this file, at this
 * revision, at this state, superseding that one.
 *
 * Four rules make it a single source of truth rather than a folder.
 *
 * **A new revision supersedes the old, in the same act.** Not a tidy-up job
 * somebody does later. This is the whole mechanism behind "everyone works from
 * the same current file": there is exactly one current revision of a reference
 * at any moment, because publishing a new one archives its predecessor before
 * anybody can read either.
 *
 * **Nothing is shared without a checker, and nothing is published without an
 * approver.** They are different people from the author and the platform
 * refuses when they are not — the whole value of a state ladder is that moving
 * up it means somebody else looked.
 *
 * **A container holds a file.** The evidence hash is required at deposit. A
 * container with no file is a promise, which is what a deliverable already is;
 * two records for a promise and none for the document is how a register comes
 * to show a hundred percent complete against an empty folder.
 *
 * **Suitability says what the file may be used for, and publishing checks it.**
 * A drawing issued for comment is not a drawing to build from. ISO 19650 gives
 * the codes; the platform refuses to publish an S-code as though it were an
 * A-code, because that single substitution is how work gets built off a review
 * issue.
 */

/** The CDE states, from the one place they are defined. */
export { CDE_STATE, type CDEState };

/**
 * ISO 19650-2 suitability, which says what a container may be *used* for.
 *
 * The distinction that matters on site is between the S codes and the A codes.
 * S3 is "issued for review and comment" — an invitation to disagree with it. A1
 * is "issued for construction" — an instruction to build it. They can look
 * identical on a title block, and a container issued at S3 that somebody builds
 * from is the commonest expensive mistake in design management.
 */
export const SUITABILITY = [
  { code: 'S0', label: 'Work in progress', authorisesConstruction: false, shareable: false },
  { code: 'S1', label: 'Shared for coordination', authorisesConstruction: false, shareable: true },
  { code: 'S2', label: 'Shared for information', authorisesConstruction: false, shareable: true },
  { code: 'S3', label: 'Shared for review and comment', authorisesConstruction: false, shareable: true },
  { code: 'S4', label: 'Shared for stage approval', authorisesConstruction: false, shareable: true },
  { code: 'A1', label: 'Authorised for construction', authorisesConstruction: true, shareable: true },
  { code: 'A2', label: 'Authorised for construction with comments', authorisesConstruction: true, shareable: true },
  { code: 'B1', label: 'Partially authorised — comments to resolve', authorisesConstruction: false, shareable: true },
  { code: 'CR', label: 'As-built record', authorisesConstruction: false, shareable: true },
] as const;

export type SuitabilityCode = (typeof SUITABILITY)[number]['code'];

export const SUITABILITY_CODES = SUITABILITY.map((s) => s.code);

const suitability = (code: string) => SUITABILITY.find((s) => s.code === code);

/** What a container is. */
export const CONTAINER_KIND = ['DRAWING', 'MODEL', 'SPECIFICATION', 'SCHEDULE', 'REPORT', 'CALCULATION', 'SURVEY'] as const;
export type ContainerKind = (typeof CONTAINER_KIND)[number];

export type InformationContainer = {
  id: string;
  projectId: string;
  /** The document's own reference, stable across every revision of it. */
  reference: string;
  revision: string;
  title: string;
  kind: ContainerKind;
  discipline: string;
  suitability: SuitabilityCode;
  state: CDEState;
  /** Hash of the file itself. A container without one is a promise. */
  fileHash: string;
  author: string;
  checker?: string;
  approver?: string;
  depositedAt: string;
  sharedAt?: string;
  publishedAt?: string;
  /** The revision this one replaced, and the one that replaced it. */
  supersedes?: string;
  supersededBy?: string;
  supersededAt?: string;
  archivedAt?: string;
};

const containers = (ctx: EngineContext): InformationContainer[] =>
  ctx.ledger.list(ctx.projectId, 'InformationContainer').map((record) => record.state as unknown as InformationContainer);

/**
 * The current revision of a reference — the answer to the only question a CDE
 * exists to answer.
 *
 * Published beats shared beats work in progress: somebody asking "what is the
 * current General Arrangement" wants what they may build from, and if there is
 * no published revision they want to know that rather than to be handed a
 * draft as though it were one.
 */
export function currentRevision(ctx: EngineContext, reference: string): InformationContainer | undefined {
  const live = containers(ctx).filter(
    (container) => container.reference === reference && container.state !== 'ARCHIVED' && !container.supersededBy,
  );
  const order: CDEState[] = ['PUBLISHED', 'SHARED', 'WIP'];
  for (const state of order) {
    const match = live.filter((container) => container.state === state).sort((a, b) => a.revision.localeCompare(b.revision));
    if (match.length > 0) return match.at(-1);
  }
  return undefined;
}

/** Everything in the environment, current first. */
export function register(
  ctx: EngineContext,
): {
  containers: InformationContainer[];
  byState: Record<CDEState, number>;
  /** References whose current revision is not published, so nothing may be built from them. */
  nothingToBuildFrom: string[];
  /** Published in the environment and never issued to anybody. */
  publishedButNeverIssued: Array<{ reference: string; revision: string; publishedAt: string }>;
  summary: string;
} {
  authorise(ctx, 'DESIGN_INFORMATION', 'R');

  const all = containers(ctx);
  const byState = Object.fromEntries(CDE_STATE.map((state) => [state, 0])) as Record<CDEState, number>;
  for (const container of all) byState[container.state] += 1;

  const references = [...new Set(all.map((container) => container.reference))];
  const nothingToBuildFrom = references.filter((reference) => {
    const current = currentRevision(ctx, reference);
    return !current || !suitability(current.suitability)?.authorisesConstruction;
  });

  return {
    containers: all.sort((a, b) => a.reference.localeCompare(b.reference) || a.revision.localeCompare(b.revision)),
    byState,
    nothingToBuildFrom,
    publishedButNeverIssued: publishedButNeverIssued(ctx, all),
    summary:
      references.length === 0
        ? 'Nothing has been deposited.'
        : `${references.length} document${references.length === 1 ? '' : 's'}, ${byState.PUBLISHED} published revision${byState.PUBLISHED === 1 ? '' : 's'}. ` +
          `${nothingToBuildFrom.length} carr${nothingToBuildFrom.length === 1 ? 'ies' : 'y'} no revision authorised for construction.`,
  };
}

/**
 * Published here, and never sent to anybody.
 *
 * The environment being right is only half of it. A revision can be authored,
 * checked, approved and published, and the gang in the cabin can still be
 * building from the one before it, because publishing changes the register and
 * a transmittal is what reaches a person. The platform already records the
 * issue and who has not acknowledged it; what nothing joined up was the
 * revision that was never issued at all — which does not appear in either
 * register, because the transmittal record has no row for a document nobody
 * sent.
 *
 * Read off the transmittals rather than kept as a flag on the container, so it
 * cannot drift from the issuing record it is a statement about.
 */
function publishedButNeverIssued(
  ctx: EngineContext,
  all: InformationContainer[],
): Array<{ reference: string; revision: string; publishedAt: string }> {
  const issued = new Set<string>();
  for (const record of ctx.ledger.list(ctx.projectId, 'Transmittal')) {
    const state = record.state as unknown as { documents?: Array<{ reference: string; revision: string }> };
    for (const document of state.documents ?? []) issued.add(`${document.reference} ${document.revision}`);
  }

  return all
    .filter((container) => container.state === 'PUBLISHED' && !issued.has(`${container.reference} ${container.revision}`))
    .map((container) => ({ reference: container.reference, revision: container.revision, publishedAt: container.publishedAt! }));
}

/**
 * Put a file into the environment, at work in progress.
 *
 * A revision of an existing reference is allowed and expected; what is refused
 * is the same revision twice, because two files claiming to be revision C of
 * the same drawing is the exact ambiguity a CDE exists to remove.
 */
export function depositContainer(
  ctx: EngineContext,
  input: {
    reference: string;
    revision: string;
    title: string;
    kind: ContainerKind;
    discipline: string;
    author: string;
    /** Hash of the file. Required — see the note on `fileHash`. */
    fileHash: string;
  },
  now = new Date(),
): { containerId: string; state: CDEState } {
  authorise(ctx, 'DESIGN_INFORMATION', 'C', { lifecyclePhase: currentPhase(ctx) });

  const clash = containers(ctx).find(
    (container) => container.reference === input.reference && container.revision === input.revision,
  );
  if (clash) {
    throw new DomainError(
      'REVISION_ALREADY_DEPOSITED',
      `${input.reference} revision ${input.revision} is already in the environment. ` +
        'Two files claiming to be the same revision is the ambiguity this exists to remove — deposit the next revision.',
      409,
      [{ field: 'revision', message: `Revision ${input.revision} is taken` }],
    );
  }

  const containerId = ulid();
  const evidence = registerEvidence(ctx, {
    type: 'INFORMATION_CONTAINER',
    hash: input.fileHash,
    description: `${input.reference} rev ${input.revision} — ${input.title}`,
    linkedEntities: [],
  });

  const container: InformationContainer = {
    id: containerId,
    projectId: ctx.projectId,
    reference: input.reference,
    revision: input.revision,
    title: input.title,
    kind: input.kind,
    discipline: input.discipline,
    // Deposited at work in progress, which is what S0 means. Nothing arrives
    // in the environment already authorised.
    suitability: 'S0',
    state: 'WIP',
    fileHash: input.fileHash,
    author: input.author,
    depositedAt: now.toISOString(),
  };

  write(ctx, {
    eventType: 'CONTAINER_DEPOSITED',
    entity: { refType: 'InformationContainer', refId: containerId },
    nextState: { ...container },
    evidenceRefs: [evidence],
  });

  return { containerId, state: 'WIP' };
}

/**
 * Share a container, which is somebody other than the author saying it is fit
 * to be seen.
 *
 * The checker is the point. A ladder anybody can climb alone is a folder with
 * extra steps, and "shared" then means nothing more than "the author was ready
 * to stop working on it".
 */
export function shareContainer(
  ctx: EngineContext,
  input: { containerId: string; checker: string; suitability: SuitabilityCode },
  now = new Date(),
): { containerId: string; state: CDEState } {
  authorise(ctx, 'DESIGN_INFORMATION', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = ctx.ledger.require({ refType: 'InformationContainer', refId: input.containerId });
  const container = record.state as unknown as InformationContainer;

  if (container.state !== 'WIP') {
    throw new DomainError('CONTAINER_NOT_WIP', `${container.reference} rev ${container.revision} is already ${container.state.toLowerCase()}`);
  }
  if (container.author === input.checker) {
    throw new DomainError(
      'AUTHOR_CANNOT_CHECK',
      'The author of a container cannot be its checker. Moving up the ladder has to mean somebody else looked.',
      403,
      [{ field: 'checker', message: 'This is the author' }],
    );
  }
  const code = suitability(input.suitability);
  if (!code?.shareable) {
    throw new DomainError(
      'SUITABILITY_NOT_SHAREABLE',
      `${input.suitability} is a work-in-progress code, so it cannot describe something being shared with the project.`,
      422,
      [{ field: 'suitability', message: 'Choose a shared code — S1 to S4, or an authorised one' }],
    );
  }

  write(ctx, {
    eventType: 'CONTAINER_SHARED',
    entity: { refType: 'InformationContainer', refId: input.containerId },
    nextState: { ...container, state: 'SHARED', suitability: input.suitability, checker: input.checker, sharedAt: now.toISOString() },
  });

  return { containerId: input.containerId, state: 'SHARED' };
}

/**
 * Publish a container, and supersede whatever it replaces.
 *
 * The supersession happens here rather than as a separate act somebody
 * remembers, because that is what makes the environment a single source of
 * truth: at the instant this returns, there is exactly one current revision of
 * this reference and every older one says what replaced it.
 */
export function publishContainer(
  ctx: EngineContext,
  input: { containerId: string; approver: string; suitability: SuitabilityCode },
  now = new Date(),
): { containerId: string; state: CDEState; superseded?: string } {
  authorise(ctx, 'DESIGN_INFORMATION', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = ctx.ledger.require({ refType: 'InformationContainer', refId: input.containerId });
  const container = record.state as unknown as InformationContainer;

  if (container.state !== 'SHARED') {
    throw new DomainError(
      'CONTAINER_NOT_SHARED',
      `${container.reference} rev ${container.revision} is ${container.state.toLowerCase()}. A container is checked before it is approved.`,
    );
  }
  if (container.author === input.approver || container.checker === input.approver) {
    throw new DomainError(
      'APPROVER_ALREADY_INVOLVED',
      'The approver cannot be the author or the checker. Three roles, three people — that is what the ladder is for.',
      403,
      [{ field: 'approver', message: 'This person has already handled this container' }],
    );
  }
  if (!suitability(input.suitability)) {
    throw new DomainError('SUITABILITY_UNKNOWN', `${input.suitability} is not an ISO 19650 suitability code`);
  }

  // The one already current for this reference, which this replaces.
  const previous = containers(ctx).find(
    (other) =>
      other.reference === container.reference &&
      other.id !== container.id &&
      other.state === 'PUBLISHED' &&
      !other.supersededBy,
  );

  write(ctx, {
    eventType: 'CONTAINER_PUBLISHED',
    entity: { refType: 'InformationContainer', refId: input.containerId },
    nextState: {
      ...container,
      state: 'PUBLISHED',
      suitability: input.suitability,
      approver: input.approver,
      publishedAt: now.toISOString(),
      ...(previous ? { supersedes: previous.id } : {}),
    },
  });

  if (previous) {
    write(ctx, {
      eventType: 'CONTAINER_SUPERSEDED',
      entity: { refType: 'InformationContainer', refId: previous.id },
      nextState: {
        ...previous,
        state: 'ARCHIVED',
        supersededBy: container.id,
        supersededAt: now.toISOString(),
        archivedAt: now.toISOString(),
      },
    });
  }

  return { containerId: input.containerId, state: 'PUBLISHED', superseded: previous?.id };
}

/**
 * What a person is allowed to build from, and why not where they are not.
 *
 * The read that stops the mistake. Asking for a reference returns the current
 * revision *and* whether its suitability authorises construction — so "I have
 * the latest drawing" and "I may build from it" stop being the same sentence.
 */
export function buildableFrom(
  ctx: EngineContext,
  reference: string,
): { container?: InformationContainer; mayBuild: boolean; because: string } {
  authorise(ctx, 'DESIGN_INFORMATION', 'R');

  const current = currentRevision(ctx, reference);
  if (!current) {
    return { mayBuild: false, because: `Nothing has been deposited under ${reference}.` };
  }

  const code = suitability(current.suitability)!;
  if (current.state !== 'PUBLISHED') {
    return {
      container: current,
      mayBuild: false,
      because:
        `${reference} rev ${current.revision} is ${current.state.toLowerCase()}, not published. ` +
        'The latest file and an approved file are different things.',
    };
  }
  if (!code.authorisesConstruction) {
    return {
      container: current,
      mayBuild: false,
      because:
        `${reference} rev ${current.revision} is issued at ${current.suitability} — ${code.label.toLowerCase()}. ` +
        'That is an invitation to comment on it, not an instruction to build it.',
    };
  }

  return {
    container: current,
    mayBuild: true,
    because: `${reference} rev ${current.revision} is published at ${current.suitability} — ${code.label.toLowerCase()}.`,
  };
}

/** Take a container out of use without a replacement — a drawing withdrawn. */
export function archiveContainer(
  ctx: EngineContext,
  input: { containerId: string; reason: string },
  now = new Date(),
): { containerId: string } {
  authorise(ctx, 'DESIGN_INFORMATION', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = ctx.ledger.require({ refType: 'InformationContainer', refId: input.containerId });
  const container = record.state as unknown as InformationContainer;

  if (container.state === 'ARCHIVED') {
    throw new DomainError('CONTAINER_ALREADY_ARCHIVED', `${container.reference} rev ${container.revision} is already archived`);
  }
  if (input.reason.trim().length < 10) {
    throw new DomainError('WITHDRAWAL_UNEXPLAINED', 'Say why this is being withdrawn — somebody may be building from it right now');
  }

  write(ctx, {
    eventType: 'CONTAINER_ARCHIVED',
    entity: { refType: 'InformationContainer', refId: input.containerId },
    nextState: { ...container, state: 'ARCHIVED', archivedAt: now.toISOString(), archiveReason: input.reason },
  });

  return { containerId: input.containerId };
}
