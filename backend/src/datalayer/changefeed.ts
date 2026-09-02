import { createHmac } from 'node:crypto';
import { config } from '../config.ts';
import { DomainError } from '../core/errors.ts';
import { ENTITY_ACCESS } from '../identity/entityAccess.ts';
import { evaluateAccess } from '../identity/abac.ts';
import type { AuthContext } from '../identity/auth.ts';
import type { GoldenThreadLedger } from '../goldenthread/ledger.ts';
import type { GoldenThreadEvent } from '../goldenthread/types.ts';

/**
 * The outbound change feed: an integrator's ordered, resumable view of what
 * changed in their tenancy.
 *
 * ## Why this is not the notification outbox or the webhook register
 *
 * Both exist and neither is this.
 *
 * - `notifications/outbox.ts` is **push to a person** — an email that has to go
 *   out, with attempts and a backoff. Its unit is a message.
 * - `developer/webhooks.ts` is **push to a system** — a signed POST to a URL a
 *   customer configured, which is delivery, not history.
 *
 * A change feed is **pull**, and pull is what an integrator's own system
 * actually needs to stay in step: a webhook that failed while their server was
 * down is a hole nobody can fill, and asking a customer to reconcile from a
 * dashboard is asking them to write this file themselves. A feed they can
 * re-read from where they got to closes the hole without anybody being on call.
 *
 * ## Ordering, and what "ordered" is allowed to mean here
 *
 * The ledger orders by `(timestamp, eventId)` and that ordering is total and
 * stable: two events in the same millisecond are separated by the id, which is
 * a ULID and therefore itself ordered. The cursor is that pair, so a consumer
 * resuming from it sees every subsequent event exactly once and never re-reads
 * one it has already had.
 *
 * What this cannot promise is that the feed's order matches the order things
 * happened in the world. It matches the order they were **committed**, which is
 * the only order the platform witnessed. Saying otherwise would be inventing a
 * guarantee out of a sort.
 *
 * ## At-least-once, stated rather than implied
 *
 * A consumer that reads a page, crashes before storing the cursor, and reads
 * again will see that page twice. That is inherent to a pull feed with a
 * client-held cursor and cannot be engineered away — so every entry carries an
 * **idempotency key** derived from the event, and the contract is that a
 * consumer keys on it. An exactly-once claim here would be a lie a customer
 * would design against and be burnt by.
 *
 * ## What is not in the feed
 *
 * Entity **state**. The feed says what changed and where to read it, not what
 * it now says. Two reasons and both are load-bearing: state at read time is the
 * honest answer to "what is this now" and the feed cannot give it without
 * shipping a snapshot that is stale on arrival; and streaming full state past
 * the per-entity access check is how a feed becomes the widest hole in the
 * platform. Every entry is access-checked on the **entity's** classification,
 * and an entry the caller may not read is dropped from the page rather than
 * shipped hollow — a feed is a data pipe, not a narrative, and a shell in it
 * would be a row an integrator's system would try to process.
 */

/** The largest page a consumer may ask for. */
export const MAX_PAGE = 500;
export const DEFAULT_PAGE = 100;

export type ChangeEntry = {
  /**
   * `<timestamp>|<eventId>`. The cursor to resume from, and stable for ever:
   * an event's timestamp and id never change, because the log is append-only.
   */
  cursor: string;
  /**
   * What a consumer keys on to make a repeated delivery harmless.
   *
   * Derived from the event id and the tenancy, keyed to this deployment, so it
   * is stable across re-reads and cannot be guessed or forged into a collision
   * with another tenancy's key.
   */
  idempotencyKey: string;
  eventId: string;
  occurredAt: string;
  projectId: string;
  eventType: string;
  entity: { refType: string; refId: string };
  action: string;
  actor: { refType: string; refId: string };
  correlationId: string;
  /** Where to fetch the current state, rather than a snapshot that ages. */
  readAt: string;
};

export type ChangePage = {
  entries: ChangeEntry[];
  /** Pass back as `after` to continue. Null where the feed is caught up. */
  nextCursor: string | null;
  /** True where more is waiting now — a consumer should come straight back. */
  more: boolean;
  /**
   * Events in range that this caller may not read, dropped from the page.
   *
   * Counted rather than hidden: a consumer reconciling record counts against
   * their own system needs to know the feed is not the whole log, and a silent
   * difference is a support call that takes a week.
   */
  withheld: number;
  contract: string[];
};

/** The idempotency key for one event. */
export function idempotencyKey(tenantId: string, eventId: string): string {
  return createHmac('sha256', `${config.auth.jwtSecret}:change-feed`)
    .update(`${tenantId}|${eventId}`)
    .digest('base64url')
    .slice(0, 32);
}

/** The cursor for one event. Sorts the same way the ledger does. */
export function cursorFor(event: Pick<GoldenThreadEvent, 'timestamp' | 'eventId'>): string {
  return `${event.timestamp}|${event.eventId}`;
}

/**
 * Split a cursor back into its parts.
 *
 * Refuses a malformed one rather than treating it as "start from the
 * beginning". A consumer whose cursor was corrupted and who is silently sent
 * back to the start of the log will reprocess months of history and, unless
 * their idempotency is perfect, act on all of it again.
 */
export function parseCursor(cursor: string): { timestamp: string; eventId: string } {
  const index = cursor.indexOf('|');
  const timestamp = index === -1 ? '' : cursor.slice(0, index);
  const eventId = index === -1 ? '' : cursor.slice(index + 1);
  if (!timestamp || !eventId || Number.isNaN(Date.parse(timestamp))) {
    throw new DomainError(
      'CHANGE_CURSOR_INVALID',
      `"${cursor}" is not a cursor this feed issued. Cursors are returned as \`nextCursor\` and are passed back ` +
        'unchanged. This is refused rather than treated as "from the beginning", because a consumer silently sent ' +
        'back to the start of the log would reprocess its whole history.',
    );
  }
  return { timestamp, eventId };
}

/** True where `event` sorts strictly after the cursor, in the ledger's own order. */
function isAfter(event: GoldenThreadEvent, after: { timestamp: string; eventId: string }): boolean {
  if (event.timestamp !== after.timestamp) return event.timestamp > after.timestamp;
  return event.eventId > after.eventId;
}

const CONTRACT = [
  'Ordered by commit time, then by event id. That ordering is total and stable, and it is the order the platform ' +
    'witnessed rather than the order things happened in the world.',
  'At least once. Read a page, crash before storing the cursor, read again, and you will see it twice — that is ' +
    'inherent to a pull feed and is why every entry carries an idempotency key. Key on it.',
  'No entity state. Each entry says what changed and where to read it; state at read time is the honest answer to ' +
    'what a record now says, and a snapshot in the feed would be stale on arrival.',
  'Access is checked per entry against the entity, not once at the feed. Entries you may not read are dropped and ' +
    'counted in `withheld`, so a count that does not reconcile has a visible reason.',
  'Cursors never expire and never change: the log is append-only, so an event’s position in it is permanent.',
];

/**
 * Read a page of the feed.
 *
 * `events({ tenantId })` is the scoped read — never `entitiesOfType`, which is
 * documented boot-only. The tenancy filter is applied by the ledger and the
 * per-entity check is applied here, so a caller cannot reach another tenancy's
 * events by any combination of cursor and page size.
 */
export function changePage(
  ledger: GoldenThreadLedger,
  auth: AuthContext,
  options: {
    after?: string;
    limit?: number;
    projectId?: string;
    /** Passed through so the feed authorises exactly as every other read does. */
    authzOptions?: Parameters<typeof evaluateAccess>[4];
  } = {},
): ChangePage {
  const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(options.limit ?? DEFAULT_PAGE)));
  const after = options.after ? parseCursor(options.after) : undefined;

  const all = ledger.events({
    tenantId: auth.tenantId,
    ...(options.projectId ? { projectId: options.projectId } : {}),
  });

  const entries: ChangeEntry[] = [];
  let withheld = 0;
  let index = 0;
  let exhausted = true;

  for (; index < all.length; index += 1) {
    const event = all[index]!;
    if (after && !isAfter(event, after)) continue;

    if (entries.length >= limit) {
      // Stopped early: there is more behind this page.
      exhausted = false;
      break;
    }

    const classification = ENTITY_ACCESS[event.entity.refType];
    if (classification) {
      const decision = evaluateAccess(
        auth,
        classification.area,
        'R',
        {
          tenantId: event.tenantId,
          projectId: event.projectId,
          dataSensitivity: classification.sensitivity,
        },
        // The same fallback `lineage` uses, so a feed entry and a lineage node
        // cannot disagree about whether the same record is readable.
        options.authzOptions ?? {
          rbacEnabled: config.authz.rbac,
          scopesEnabled: config.authz.scopes,
          abacEnabled: config.authz.abac,
        },
      );
      if (decision.decision !== 'ALLOW') {
        withheld += 1;
        continue;
      }
    }

    entries.push({
      cursor: cursorFor(event),
      idempotencyKey: idempotencyKey(event.tenantId, event.eventId),
      eventId: event.eventId,
      occurredAt: event.timestamp,
      projectId: event.projectId,
      eventType: event.eventType,
      entity: { refType: event.entity.refType, refId: event.entity.refId },
      action: event.action,
      actor: { refType: event.actor.refType, refId: event.actor.refId },
      correlationId: event.correlationId,
      readAt: `/v1/projects/${event.projectId}/entities/${event.entity.refType}/${event.entity.refId}`,
    });
  }

  // The cursor advances past everything examined, withheld entries included,
  // rather than only past what was returned.
  //
  // Mutation testing showed the two are behaviourally equivalent to a consumer:
  // a page is only ever entirely withheld at the very tail of the log, where
  // `more` is already false, so the weaker version costs re-examination on the
  // next poll and never loses or repeats an entry. It is kept because the
  // cursor should mean "this is how far the feed has been read", and because
  // the equivalence depends on the scan reaching the end — a future change that
  // bounded the scan would turn the weaker version into a stall with no test
  // standing against it.
  const lastExamined = entries.length > 0 || withheld > 0 ? all[Math.min(index, all.length) - 1] : undefined;

  return {
    entries,
    nextCursor: lastExamined ? cursorFor(lastExamined) : (options.after ?? null),
    more: !exhausted,
    withheld,
    contract: CONTRACT,
  };
}
