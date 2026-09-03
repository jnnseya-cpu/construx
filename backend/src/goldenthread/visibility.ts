import { classifyEntity } from '../identity/entityAccess.ts';
import { evaluateAccess } from '../identity/abac.ts';
import { AUTHZ_OPTIONS } from '../engines/context.ts';
import type { AuthContext } from '../identity/auth.ts';
import type { GoldenThreadEvent } from './types.ts';

/**
 * What of an event a given identity may read.
 *
 * An audit trail has two jobs and they need separating. Proving the record is
 * complete and untampered needs the **envelope** — who acted, when, on what type
 * of thing, and the hashes that chain it. Reading what actually *changed* needs
 * the patch, and that is entity content: withholding it is the same decision the
 * entity read makes, or any feed of events becomes the way round every
 * capability boundary in the system.
 *
 * This lived inside the audit feed's route handler, which was right until a
 * second reader appeared. `SyncEngine.pull` was that second reader and it
 * withheld nothing at all: a device pull returned every event's full diff,
 * filtered only by tenancy. On the web that is a console nobody could reach it
 * from; on a field app it is the isolation the £25 subcontractor seat is sold
 * on — "a subcontractor seat can never see another trade's snags, another
 * organisation's data, or any unfiltered commercial record, and this is enforced
 * in queries and sync scoping, not in the UI".
 *
 * So it is one function now, and the comment the feed already carried is the
 * reason: "keeps one place where an event's content is authorised — a second
 * path would be a second chance to get that wrong."
 */
/**
 * An event as one identity may see it.
 *
 * `diff` becomes optional rather than empty, because an empty patch and a
 * withheld one are different claims: the first says nothing changed, the second
 * says something did and you may not read what. `contentWithheld` is what tells
 * them apart, and a reader that ignores it reports the wrong thing either way.
 */
export type VisibleEvent = Omit<GoldenThreadEvent, 'diff'> & {
  diff?: GoldenThreadEvent['diff'];
  contentWithheld?: true;
};

export function visibleTo(actor: AuthContext, projectId: string, event: GoldenThreadEvent): VisibleEvent {
  const classification = classifyEntity(event.entity.refType);

  // An entity type the classification does not know is denied rather than
  // waved through. A new entity type appears with its content withheld until
  // somebody classifies it, which is the safe direction to fail in.
  const decision = classification
    ? evaluateAccess(
        actor,
        classification.area,
        'R',
        { tenantId: actor.tenantId, projectId, dataSensitivity: classification.sensitivity },
        AUTHZ_OPTIONS,
      ).decision
    : 'DENY';

  if (decision === 'ALLOW') return event;
  return { ...event, diff: undefined, contentWithheld: true };
}

/** The same decision over a page, with the count that has to reconcile. */
export function visiblePage(
  actor: AuthContext,
  projectId: string,
  events: GoldenThreadEvent[],
): { events: VisibleEvent[]; withheldCount: number } {
  const seen = events.map((event) => visibleTo(actor, projectId, event));
  return { events: seen, withheldCount: seen.filter((event) => 'contentWithheld' in event).length };
}
