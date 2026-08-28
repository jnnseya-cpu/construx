import { DomainError, ForbiddenError, NotFoundError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import type { AuthContext } from '../identity/auth.ts';
import { PLATFORM_TENANT_ID, type Platform } from '../platform.ts';

/**
 * Where a customer's problem lands, and who owes them an answer.
 *
 * The operator console named a support queue and there was nothing behind it,
 * which is worse than not naming one: a screen that lists nothing implies
 * nothing has been raised, when in fact there was never anywhere to raise it.
 * Customers were emailing an address that reached one person's inbox and left no
 * record of who answered, when, or whether anybody did.
 *
 * The design follows the rest of the platform rather than inventing a
 * help-desk.
 *
 * **A request is a ledger record on the raising tenancy's governance chain.**
 * Not a table in the operator layer. It belongs to the customer who raised it —
 * they can see their own, they can reply, and the record of what they were told
 * survives the person who told them.
 *
 * **The operator sees the queue and never the delivery data behind it.** A
 * request carries the words the customer chose to send. It does not carry a
 * project, a document or a record — if a customer needs to show an operator
 * something, they say so in words, and somebody with the right authority looks
 * at it under their own account. The account boundary is not suspended because
 * somebody asked for help.
 *
 * **The clock is on the platform, not the customer.** `waitingOn` names who owes
 * the next move and `respondedAt` is set once, at the first operator reply, so
 * first-response time cannot be improved by replying twice. A queue that reports
 * how fast it closes things rather than how fast it answers them is a queue
 * optimised for closing things.
 */

export type TicketPriority = 'URGENT' | 'NORMAL' | 'LOW';
export type TicketStatus = 'OPEN' | 'ANSWERED' | 'WAITING_ON_CUSTOMER' | 'RESOLVED' | 'CLOSED';
export type TicketCategory = 'ACCESS' | 'BILLING' | 'DATA' | 'DEFECT' | 'HOW_TO' | 'FEATURE_REQUEST' | 'OTHER';

export type TicketMessage = {
  id: string;
  at: string;
  /** The identity that wrote it, and which side of the boundary they are on. */
  authorId: string;
  authorName: string;
  side: 'CUSTOMER' | 'PLATFORM';
  body: string;
};

export type Ticket = {
  id: string;
  reference: string;
  tenantId: string;
  tenantName: string;
  raisedBy: string;
  raisedByName: string;
  raisedAt: string;
  subject: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  waitingOn: 'PLATFORM' | 'CUSTOMER' | 'NOBODY';
  /** The first operator reply. Set once and never moved. */
  respondedAt?: string;
  resolvedAt?: string;
  resolution?: string;
  /** The operator who picked it up, if anybody has. */
  assignedTo?: string;
  assignedToName?: string;
  updatedAt: string;
  messages: TicketMessage[];
};

/**
 * How long the platform gives itself to answer, by priority.
 *
 * Published rather than implied, and used to compute whether a request is
 * overdue. A target nobody can see is not a commitment.
 */
export const RESPONSE_TARGET_HOURS: Record<TicketPriority, number> = {
  URGENT: 4,
  NORMAL: 24,
  LOW: 72,
};

export const CATEGORY_LABELS: Record<TicketCategory, string> = {
  ACCESS: 'Cannot get in, or cannot do something they should be able to',
  BILLING: 'A charge, an invoice, a wallet or a subscription',
  DATA: 'Something in their record is wrong, missing or needs removing',
  DEFECT: 'The platform did something incorrect',
  HOW_TO: 'How do I do this',
  FEATURE_REQUEST: 'The platform cannot do something they need',
  OTHER: 'Anything else',
};

/** Governance chain of a tenancy. A support request is a governance act. */
function chainFor(tenantId: string): string {
  return `${tenantId}-governance`;
}

/**
 * A reference a person can read down a telephone.
 *
 * ULIDs are correct and unusable out loud. This is derived from the id rather
 * than counted, so two processes cannot allocate the same one.
 */
function referenceFor(id: string): string {
  return `SR-${id.slice(-6).toUpperCase()}`;
}

/**
 * Write the request to the ledger.
 *
 * The event code arrives as a named field rather than a positional argument on
 * purpose. `catalogue.test.ts` proves every code in the catalogue has a command
 * that emits it by scanning for `eventType:` followed by a literal — a
 * positional parameter hides the code from that check, and a code the invariant
 * cannot see is a code nothing protects.
 */
function commit(platform: Platform, actorId: string, { eventType, ticket }: { eventType: string; ticket: Ticket }): void {
  platform.ledger.commit({
    tenantId: ticket.tenantId,
    projectId: chainFor(ticket.tenantId),
    actor: { refType: 'User', refId: actorId },
    source: 'SYSTEM',
    correlationId: ticket.id,
    eventType,
    entity: { refType: 'SupportRequest', refId: ticket.id },
    nextState: ticket as unknown as Record<string, unknown>,
  });
}

/**
 * Load one, without deciding whether the caller may see it.
 *
 * Deliberately separate from `ticket()`: every path that reads a request has to
 * make the isolation check explicitly, so a new caller cannot inherit somebody
 * else's authorisation by reusing a loader that already did it.
 */
function mustFind(platform: Platform, ticketId: string): Ticket {
  const record = platform.ledger.get({ refType: 'SupportRequest', refId: ticketId });
  if (!record) throw new NotFoundError(`No support request ${ticketId}`);
  return record.state as unknown as Ticket;
}

function isOperator(actor: AuthContext): boolean {
  return actor.roles.includes('PLATFORM_ADMIN');
}

/**
 * Everything the caller may see.
 *
 * An operator sees the estate. Anybody else sees their own tenancy and nothing
 * else — enforced here rather than filtered in a screen, because a screen that
 * filters is a screen somebody can ask for a different page of.
 */
export function tickets(platform: Platform, actor: AuthContext): Ticket[] {
  const all = platform.ledger.entitiesOfType('SupportRequest').map((record) => record.state as unknown as Ticket);
  const visible = isOperator(actor) ? all : all.filter((ticket) => ticket.tenantId === actor.tenantId);
  return visible.sort((a, b) => b.raisedAt.localeCompare(a.raisedAt));
}

export function ticket(platform: Platform, actor: AuthContext, ticketId: string): Ticket {
  const found = mustFind(platform, ticketId);
  if (!isOperator(actor) && found.tenantId !== actor.tenantId) {
    throw new ForbiddenError('That support request belongs to another tenancy', 'TENANT_ISOLATION');
  }
  return found;
}

export function raise(
  platform: Platform,
  actor: AuthContext,
  input: { subject: string; body: string; category: TicketCategory; priority?: TicketPriority },
): Ticket {
  const subject = input.subject.trim();
  const body = input.body.trim();
  if (subject.length < 8) {
    throw new DomainError('SUBJECT_TOO_SHORT', 'A subject of a few words is what makes a queue readable. Say what is wrong.', 422);
  }
  if (body.length < 20) {
    throw new DomainError(
      'BODY_TOO_SHORT',
      'Describe what happened, what you expected, and what you have already tried. A one-line request costs a round trip before anybody can start.',
      422,
    );
  }

  // An operator raising a request against their own platform tenancy is a note
  // to themselves, not support. Refused with the reason rather than silently
  // creating a request nobody will ever answer.
  if (isOperator(actor)) {
    throw new ForbiddenError(
      'A platform operator has nobody to raise a support request with. Record it as a defect instead.',
      'OPERATOR_CANNOT_RAISE',
    );
  }

  const now = new Date().toISOString();
  const id = ulid();
  const user = platform.user(actor.actorId);
  const ticket: Ticket = {
    id,
    reference: referenceFor(id),
    tenantId: actor.tenantId,
    tenantName: platform.tenant(actor.tenantId).legalName,
    raisedBy: actor.actorId,
    raisedByName: user.name,
    raisedAt: now,
    subject,
    category: input.category,
    priority: input.priority ?? 'NORMAL',
    status: 'OPEN',
    waitingOn: 'PLATFORM',
    updatedAt: now,
    messages: [{ id: ulid(), at: now, authorId: actor.actorId, authorName: user.name, side: 'CUSTOMER', body }],
  };

  commit(platform, actor.actorId, { eventType: 'SUPPORT_REQUEST_RAISED', ticket: ticket });
  return ticket;
}

/**
 * Reply, from either side.
 *
 * One command rather than two, because the difference between a customer's
 * reply and an operator's is a fact about the actor and not a decision the
 * caller gets to make. A route that took `side` as a parameter would let a
 * customer post as the platform.
 */
export function reply(platform: Platform, actor: AuthContext, ticketId: string, body: string): Ticket {
  const existing = ticket(platform, actor, ticketId);
  const message = body.trim();
  if (message.length < 2) throw new DomainError('EMPTY_REPLY', 'A reply needs words in it.', 422);
  if (existing.status === 'CLOSED') {
    throw new DomainError(
      'REQUEST_CLOSED',
      'This request is closed. Raise a new one — a closed record stays as it was, which is what makes it worth reading later.',
      409,
    );
  }

  const operator = isOperator(actor);
  const now = new Date().toISOString();
  const user = platform.user(actor.actorId);

  const updated: Ticket = {
    ...existing,
    // Set once, at the first platform reply. A later reply does not improve it,
    // which is the whole point of measuring first response.
    respondedAt: operator ? (existing.respondedAt ?? now) : existing.respondedAt,
    status: operator ? 'ANSWERED' : existing.status === 'RESOLVED' ? 'OPEN' : existing.status,
    waitingOn: operator ? 'CUSTOMER' : 'PLATFORM',
    // A resolved request that the customer replies to is open again. Resolution
    // is the platform's opinion; the customer's reply is evidence against it.
    resolvedAt: !operator && existing.status === 'RESOLVED' ? undefined : existing.resolvedAt,
    updatedAt: now,
    messages: [
      ...existing.messages,
      { id: ulid(), at: now, authorId: actor.actorId, authorName: user.name, side: operator ? 'PLATFORM' : 'CUSTOMER', body: message },
    ],
  };

  commit(platform, actor.actorId, { eventType: 'SUPPORT_REQUEST_ANSWERED', ticket: updated });
  return updated;
}

/** An operator takes ownership, so the queue shows who is actually on it. */
export function assign(platform: Platform, actor: AuthContext, ticketId: string, operatorId: string): Ticket {
  if (!isOperator(actor)) throw new ForbiddenError('Only a platform operator may assign a support request', 'PLATFORM_ADMIN_REQUIRED');
  const existing = mustFind(platform, ticketId);
  const assignee = platform.user(operatorId);
  if (!assignee.roles.includes('PLATFORM_ADMIN')) {
    throw new DomainError('NOT_AN_OPERATOR', `${assignee.name} does not hold PLATFORM_ADMIN and cannot be given a request.`, 422);
  }

  const updated: Ticket = {
    ...existing,
    assignedTo: assignee.id,
    assignedToName: assignee.name,
    updatedAt: new Date().toISOString(),
  };
  commit(platform, actor.actorId, { eventType: 'SUPPORT_REQUEST_ASSIGNED', ticket: updated });
  return updated;
}

export function resolve(platform: Platform, actor: AuthContext, ticketId: string, resolution: string): Ticket {
  if (!isOperator(actor)) throw new ForbiddenError('Only a platform operator may resolve a support request', 'PLATFORM_ADMIN_REQUIRED');
  const existing = mustFind(platform, ticketId);
  const stated = resolution.trim();
  if (stated.length < 10) {
    throw new DomainError(
      'RESOLUTION_REQUIRED',
      'Say what was done. A request closed with no stated resolution is useless the next time the same thing happens.',
      422,
    );
  }
  if (existing.status === 'CLOSED') throw new DomainError('REQUEST_CLOSED', 'This request is already closed.', 409);

  const now = new Date().toISOString();
  const updated: Ticket = {
    ...existing,
    status: 'RESOLVED',
    waitingOn: 'NOBODY',
    resolvedAt: now,
    resolution: stated,
    // A resolution the customer never saw is a request closed quietly. It is
    // recorded as a message so it appears in their thread.
    messages: [
      ...existing.messages,
      {
        id: ulid(),
        at: now,
        authorId: actor.actorId,
        authorName: platform.user(actor.actorId).name,
        side: 'PLATFORM',
        body: stated,
      },
    ],
    updatedAt: now,
  };
  commit(platform, actor.actorId, { eventType: 'SUPPORT_REQUEST_RESOLVED', ticket: updated });
  return updated;
}

export type SupportPosition = {
  open: number;
  awaitingPlatform: number;
  awaitingCustomer: number;
  resolved: number;
  unassigned: number;
  /** Past the response target for its priority, and nobody has replied. */
  overdue: number;
  breaching: { reference: string; tenantName: string; priority: TicketPriority; hoursWaiting: number; targetHours: number }[];
  /** Median hours to first platform reply, over requests that have had one. */
  medianFirstResponseHours: number | null;
  responseTargets: Record<TicketPriority, number>;
  byCategory: { category: TicketCategory; label: string; count: number }[];
  tickets: Ticket[];
  summary: string;
};

export function supportPosition(platform: Platform, actor: AuthContext, now = new Date()): SupportPosition {
  const all = tickets(platform, actor);
  const live = all.filter((entry) => entry.status !== 'CLOSED' && entry.status !== 'RESOLVED');

  const hoursSince = (iso: string): number => (now.getTime() - new Date(iso).getTime()) / 3_600_000;

  const breaching = live
    .filter((entry) => entry.waitingOn === 'PLATFORM' && !entry.respondedAt)
    .map((entry) => ({
      reference: entry.reference,
      tenantName: entry.tenantName,
      priority: entry.priority,
      hoursWaiting: Math.floor(hoursSince(entry.raisedAt)),
      targetHours: RESPONSE_TARGET_HOURS[entry.priority],
    }))
    .filter((entry) => entry.hoursWaiting > entry.targetHours)
    .sort((a, b) => b.hoursWaiting - a.hoursWaiting);

  const firstResponses = all
    .filter((entry) => entry.respondedAt)
    .map((entry) => (new Date(entry.respondedAt as string).getTime() - new Date(entry.raisedAt).getTime()) / 3_600_000)
    .sort((a, b) => a - b);

  const byCategory = (Object.keys(CATEGORY_LABELS) as TicketCategory[])
    .map((category) => ({
      category,
      label: CATEGORY_LABELS[category],
      count: all.filter((entry) => entry.category === category).length,
    }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count);

  return {
    open: live.length,
    awaitingPlatform: live.filter((entry) => entry.waitingOn === 'PLATFORM').length,
    awaitingCustomer: live.filter((entry) => entry.waitingOn === 'CUSTOMER').length,
    resolved: all.filter((entry) => entry.status === 'RESOLVED' || entry.status === 'CLOSED').length,
    unassigned: live.filter((entry) => !entry.assignedTo).length,
    overdue: breaching.length,
    breaching,
    medianFirstResponseHours:
      firstResponses.length === 0
        ? null
        : Math.round((firstResponses[Math.floor(firstResponses.length / 2)] ?? 0) * 10) / 10,
    responseTargets: RESPONSE_TARGET_HOURS,
    byCategory,
    tickets: all,
    summary:
      all.length === 0
        ? 'Nothing has been raised. The queue is empty because nobody has asked for anything, not because nothing is recorded.'
        : `${live.length} live · ${live.filter((entry) => entry.waitingOn === 'PLATFORM').length} waiting on us · ` +
          `${breaching.length} past the response target.`,
  };
}

/**
 * Whether a tenancy can raise anything at all.
 *
 * The platform tenancy cannot: it has no support to raise a request with.
 * Stated as a function so the console can ask rather than assume.
 */
export function canRaise(actor: AuthContext): boolean {
  return !actor.roles.includes('PLATFORM_ADMIN') && actor.tenantId !== PLATFORM_TENANT_ID;
}
