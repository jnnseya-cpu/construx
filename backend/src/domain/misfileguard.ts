/**
 * The project-level misfile guard — stop a tender document being recorded against
 * the wrong project.
 *
 * `misfile.ts` holds the pure, general placement check. This binds it to a project:
 * it reads the project's established buyer (its own `client`, or the client on the
 * opportunity that pursues it) and the other projects/opportunities in the tenancy,
 * and decides whether a document being recorded here — an ITT, a brief — actually
 * belongs to this project.
 *
 * The decisive, high-precision signal is the buyer's name: recording an invitation
 * whose buyer is "North Lincolnshire Council" against a project whose buyer is
 * "Telford and Wrekin Council" names two clients that share no distinctive word, and
 * is almost certainly a misfile. A softer, content-based cross-match against the
 * other projects catches the rest. The guard only blocks on a clear conflict, and
 * no-ops where the project has no established buyer to compare against — so it never
 * stands in the way of ordinary use.
 */

import { DomainError } from '../core/errors.ts';
import type { EngineContext } from '../engines/context.ts';
import { assessPlacement, identityTokens, type PlacementAssessment, type PlacementIdentity } from './misfile.ts';

/**
 * Pure placement decision for a document being recorded against a project with a
 * known buyer, given the sibling projects. Side-effect free and fully testable.
 */
export function assessAgainstBuyer(input: {
  projectClient?: string;
  projectLocation?: string;
  statedClient?: string;
  text?: string;
  siblings?: PlacementIdentity[];
}): PlacementAssessment {
  const { projectClient, projectLocation, statedClient, text = '', siblings = [] } = input;

  // Rule 1 — buyer-name mismatch: the strongest, most precise signal. Both the
  // project's buyer and the document's stated buyer are named, and they share no
  // distinctive word. (Generic words like "council" are dropped by identityTokens,
  // so "Telford … Council" vs "North Lincolnshire Council" does not match on
  // "council".)
  const projTokens = identityTokens({ client: projectClient });
  const statedTokens = identityTokens({ client: statedClient });
  if (
    projectClient && statedClient &&
    projTokens.length > 0 && statedTokens.length > 0 &&
    !statedTokens.some((tk) => projTokens.includes(tk))
  ) {
    return {
      verdict: 'CONFLICT',
      reason: `This document names ${statedClient}, but this project's buyer is ${projectClient}.`,
      matchedTokens: [],
      foreignReferences: [],
      likelyBelongsTo: { client: statedClient },
    };
  }

  // Rule 2 — content cross-match: does the document, as a whole, belong to a
  // sibling project far more closely than to this one?
  const target: PlacementIdentity = { client: projectClient, location: projectLocation };
  return assessPlacement(target, `${statedClient ?? ''}\n${text}`, siblings);
}

/** The project's established buyer: its own client, else the client on its opportunity. */
function projectBuyer(ctx: EngineContext): { client?: string; location?: string } {
  const project = ctx.ledger.get({ refType: 'Project', refId: ctx.projectId }) as
    | { tenantId?: string; state?: { client?: string; name?: string; location?: { city?: string } } }
    | undefined;
  const scoped = project && project.tenantId === ctx.tenantId ? project.state : undefined;
  const opp = ctx.ledger
    .listByTenant(ctx.tenantId, 'Opportunity')
    .find((r) => (r.state as { projectId?: string }).projectId === ctx.projectId);
  return {
    client: scoped?.client ?? (opp?.state as { clientName?: string } | undefined)?.clientName,
    location: scoped?.location?.city,
  };
}

/** The other projects and opportunities in the tenancy, as identities to match against. */
function siblingIdentities(ctx: EngineContext): PlacementIdentity[] {
  const out: PlacementIdentity[] = [];
  for (const r of ctx.ledger.listByTenant(ctx.tenantId, 'Project')) {
    const s = r.state as { id?: string; name?: string; client?: string; status?: string; location?: { city?: string } };
    if (s.id === ctx.projectId || s.status === 'DELETED') continue;
    out.push({ reference: s.name, client: s.client ?? s.name, location: s.location?.city });
  }
  for (const r of ctx.ledger.listByTenant(ctx.tenantId, 'Opportunity')) {
    const s = r.state as { projectId?: string; title?: string; clientName?: string };
    if (s.projectId === ctx.projectId) continue;
    out.push({ reference: s.title, client: s.clientName });
  }
  return out;
}

/**
 * Refuse a document that belongs to another project, unless placement is confirmed.
 * Returns the assessment (OK/REVIEW) when it does not block, so a caller may surface
 * a soft warning.
 */
export function assertProjectPlacement(
  ctx: EngineContext,
  input: { statedClient?: string; text?: string; confirmPlacement?: boolean },
): PlacementAssessment {
  const buyer = projectBuyer(ctx);
  const assessment = assessAgainstBuyer({
    projectClient: buyer.client,
    projectLocation: buyer.location,
    statedClient: input.statedClient,
    text: input.text,
    siblings: siblingIdentities(ctx),
  });
  if (assessment.verdict === 'CONFLICT' && !input.confirmPlacement) {
    throw new DomainError(
      'MISFILED_DOCUMENT',
      `${assessment.reason} Re-submit with confirmPlacement to record it against this project anyway.`,
    );
  }
  return assessment;
}

/**
 * The same guard for a pipeline tender invitation (which is tenant-scoped, not
 * project-scoped): the established buyer is the invitation's own `clientName`,
 * copied from the opportunity it pursues. Refuses an ITT whose stated buyer belongs
 * to a different tender, unless placement is confirmed.
 */
export function assertInvitationPlacement(
  ctx: EngineContext,
  invitationId: string,
  input: { statedClient?: string; text?: string; confirmPlacement?: boolean },
): PlacementAssessment {
  const invitation = ctx.ledger.get({ refType: 'TenderInvitation', refId: invitationId }) as
    | { tenantId?: string; state?: { clientName?: string } }
    | undefined;
  // A missing or cross-tenant invitation is not ours to judge — let the downstream
  // require() raise the proper NOT_FOUND rather than a misfile error.
  const established = invitation && invitation.tenantId === ctx.tenantId ? invitation.state?.clientName : undefined;

  const siblings: PlacementIdentity[] = [];
  for (const r of ctx.ledger.listByTenant(ctx.tenantId, 'Opportunity')) {
    const s = r.state as { title?: string; clientName?: string };
    siblings.push({ reference: s.title, client: s.clientName });
  }
  for (const r of ctx.ledger.listByTenant(ctx.tenantId, 'TenderInvitation')) {
    const s = r.state as { id?: string; reference?: string; clientName?: string };
    if (s.id === invitationId) continue;
    siblings.push({ reference: s.reference, client: s.clientName });
  }

  const assessment = assessAgainstBuyer({ projectClient: established, statedClient: input.statedClient, text: input.text, siblings });
  if (assessment.verdict === 'CONFLICT' && !input.confirmPlacement) {
    throw new DomainError(
      'MISFILED_DOCUMENT',
      `${assessment.reason} Re-submit with confirmPlacement to record it against this tender anyway.`,
    );
  }
  return assessment;
}
