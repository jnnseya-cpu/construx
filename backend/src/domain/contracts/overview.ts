import type { EngineContext } from '../../engines/context.ts';
import { contractTerms, legalReview, revisionHash } from './approvals.ts';
import { CATALOGUE, draftable } from './catalogue.ts';
import { drafts, draftView, guard } from './drafts.ts';
import { prefillDocuments, prefills } from './prefill.ts';
import { DESIGN, PACKAGES, PRICING, SUITES, VALUE_BANDS } from './selection.ts';
import { hasOwnSchedule } from './schedules.ts';
import { display, DRAFT_CURRENCIES } from './values.ts';

/**
 * Everything the Contracts Studio screen reads for a project: each draft with
 * its particulars and, beside each particular, what the latest pre-fill
 * proposed for it; the documents a pre-fill may read; and the catalogue.
 */
export function studioOverview(ctx: EngineContext, nameOf: (actorId: string) => string) {
  guard(ctx, 'R');
  let documents: ReturnType<typeof prefillDocuments> | { error: string };
  try {
    documents = prefillDocuments(ctx);
  } catch (error) {
    // A role that may draft but not read the evidence register is told so, not shown an empty list.
    documents = { error: (error as Error).message };
  }
  return {
    drafts: drafts(ctx)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((draft) => {
        const view = {
          ...draftView(draft, nameOf),
          // What a reviewer is shown and approves, and what review and signing will need.
          currentHash: revisionHash(draft),
          legalReasons: draft.review?.legalReasons ?? legalReview(draft),
          handoffMissing: contractTerms(draft).missing,
          review: draft.review ? { ...draft.review, submittedByName: nameOf(draft.review.submittedBy), approvals: draft.review.approvals.map((approval) => ({ ...approval, byName: nameOf(approval.by) })) } : null,
          pastReviews: (draft.pastReviews ?? []).map((entry) => ({ revision: entry.revision, how: entry.ended.how, byName: nameOf(entry.ended.by), at: entry.ended.at, note: entry.ended.note, approvals: entry.approvals.length })),
        };
        const latest = prefills(ctx, draft.id).at(-1);
        if (!latest) return { ...view, prefill: null };
        const fieldDefs = new Map(view.groups.flatMap((group) => group.fields).map((field) => [field.key, field]));
        return {
          ...view,
          groups: view.groups.map((group) => ({
            ...group,
            fields: group.fields.map((field) => ({
              ...field,
              conflict: latest.conflicts.includes(field.key),
              candidates: latest.candidates
                .filter((candidate) => candidate.fieldKey === field.key)
                .map((candidate) => ({
                  ...candidate,
                  display: display(fieldDefs.get(field.key)!, candidate.value, draft.currency),
                  inDraft: draft.fields[field.key]?.value === candidate.value,
                })),
            })),
          })),
          prefill: {
            id: latest.id,
            proposedAt: latest.proposedAt,
            requestedBy: nameOf(latest.requestedBy),
            draftRevision: latest.draftRevision,
            documents: latest.documents,
            heldBack: latest.heldBack,
            omitted: latest.omitted,
            proposed: latest.candidates.length,
            conflicts: latest.conflicts.length,
            dropped: latest.dropped,
            questions: latest.questions,
          },
        };
      }),
    documents,
    catalogue: CATALOGUE.map((entry) => ({ ...entry, draftable: draftable(entry), ownSchedule: hasOwnSchedule(entry.key) })),
    vocabulary: { packages: PACKAGES, design: DESIGN, pricing: PRICING, valueBands: VALUE_BANDS, suites: SUITES, currencies: DRAFT_CURRENCIES },
  };
}
