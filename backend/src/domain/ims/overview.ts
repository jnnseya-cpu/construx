import type { EngineContext } from '../../engines/context.ts';
import { ALL_ROLES } from '../../identity/roles.ts';
import { CLAUSES, STANDARDS } from './clauses.ts';
import { DOCUMENT_TYPES, documentOf, documentRegister } from './documents.ts';
import { activePeople, guard, settings, type Person } from './ims.ts';
import { ACTION_KINDS, SOURCE_KINDS, actionRegister, sourceCandidates } from './actions.ts';
import { FINDING_GRADES, auditProgramme } from './audits.ts';
import { CONDITIONS, EVALUATION_RESULTS, registersPosition } from './registers.ts';
import { LEGISLATION } from './legislation.ts';
import { PERFORMANCE_HEADINGS, competenceMatrix, riddorCompany, supplierPerformance } from './monitoring.ts';
import { RIDDOR_KINDS } from '../riddor.ts';
import { companyPosition, reviewRegister } from './review.ts';
import { addMonths, today } from './ims.ts';

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
    programme: auditProgramme(ctx, people),
    actions: actionRegister(ctx, people),
    sources: sourceCandidates(ctx),
    registers: registersPosition(ctx, people),
    monitoring: { suppliers: supplierPerformance(ctx, people), competence: competenceMatrix(ctx, people), riddor: riddorCompany(ctx) },
    // The last twelve months, for the company-wide view.
    position: companyPosition(ctx, people, { from: addMonths(today(), -12), to: today() }),
    review: reviewRegister(ctx, people),
    people: activePeople(people).map((person) => ({ id: person.id, name: person.name, roles: person.roles })),
    me: ctx.auth.actorId,
    vocabulary: {
      standards: Object.entries(STANDARDS).map(([id, entry]) => ({ id, ...entry })),
      clauses: CLAUSES,
      documentTypes: DOCUMENT_TYPES,
      findingGrades: FINDING_GRADES,
      actionKinds: ACTION_KINDS,
      sourceKinds: SOURCE_KINDS,
      aspectConditions: CONDITIONS,
      evaluationResults: EVALUATION_RESULTS,
      legislation: LEGISLATION,
      performanceHeadings: PERFORMANCE_HEADINGS,
      riddorKinds: Object.entries(RIDDOR_KINDS).map(([kind, entry]) => ({ kind, ...entry })),
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
