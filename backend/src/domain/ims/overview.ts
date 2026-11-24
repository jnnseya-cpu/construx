import type { EngineContext } from '../../engines/context.ts';
import { ALL_ROLES } from '../../identity/roles.ts';
import { CLAUSES, STANDARDS } from './clauses.ts';
import { DOCUMENT_TYPES, documentOf, documentRegister } from './documents.ts';
import { activePeople, guard, settings, type Person } from './ims.ts';

/**
 * The one read the Management System screen is drawn from.
 *
 * Content is left out of the list — a library of procedures is a lot of text,
 * and the screen opens one at a time through `documentDetail`.
 */
export function imsOverview(ctx: EngineContext, people: readonly Person[]) {
  guard(ctx, 'R');
  const register = documentRegister(ctx, people).map((document) => ({
    ...document,
    revisions: document.revisions.map(({ content, ...revision }) => ({ ...revision, characters: content.length })),
    inForce: document.inForce ? { ...document.inForce, content: undefined } : null,
    draft: document.draft ? { ...document.draft, content: undefined } : null,
  }));
  return {
    settings: settings(ctx),
    documents: register,
    people: activePeople(people).map((person) => ({ id: person.id, name: person.name, roles: person.roles })),
    me: ctx.auth.actorId,
    vocabulary: {
      standards: Object.entries(STANDARDS).map(([id, entry]) => ({ id, ...entry })),
      clauses: CLAUSES,
      documentTypes: DOCUMENT_TYPES,
      roles: ALL_ROLES.filter((role) => role !== 'PLATFORM_ADMIN'),
    },
  };
}

/** One document with every revision's text, for reading and for the record. */
export function documentDetail(ctx: EngineContext, id: string, people: readonly Person[]) {
  guard(ctx, 'R');
  const document = documentOf(ctx, id);
  const position = documentRegister(ctx, people).find((entry) => entry.id === id)!;
  return { ...document, acknowledgement: position.acknowledgement, owner: position.owner, reviewOverdue: position.reviewOverdue };
}
