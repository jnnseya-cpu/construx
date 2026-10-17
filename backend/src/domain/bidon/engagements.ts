import { DomainError } from '../../core/errors.ts';
import { formatRef, ulid } from '../../core/ids.ts';
import { authorise, write, type EngineContext } from '../../engines/context.ts';
import { requireModule, requireModuleReadable } from '../../identity/modules.ts';
import type { EntityRecord } from '../../goldenthread/ledger.ts';

/**
 * Bid-On: the provider, its customers, and what was agreed with each.
 *
 * ## What this module is for, and why it is a module
 *
 * Every tenancy already has Tender & Procurement, which answers "we are
 * bidding for this job". Bid-On answers a different question: "we are being
 * paid to write somebody else's bid." That changes three things, and each is
 * why this is a separate body of capability rather than a feature of the
 * existing screens.
 *
 *   1. **There is a third party.** The provider, an external customer, and a
 *      buyer. The customer's evidence is the customer's — not the provider's —
 *      and must not be visible to the provider's other customers.
 *   2. **There is a commercial relationship with terms.** A fee, a billing
 *      basis, a deposit, dates, deliverables. Work can be paused for months
 *      and resumed.
 *   3. **The provider's own staff are not the approvers of everything.** A
 *      declaration about insurance cover or an accident rate is a statement
 *      the *customer* makes about itself. A bid writer who confirmed one on
 *      their customer's behalf would be making a representation to a buyer
 *      that nobody with the facts had signed.
 *
 * ## Why an engagement rather than a flag on the customer
 *
 * A customer is a relationship; an engagement is a piece of work with terms.
 * One customer has several over time — a one-off prequalification pack, then a
 * retainer, then a staged tender — and each carries its own fee and its own
 * dates. Folding the terms onto the customer would mean the second engagement
 * overwrote the first, and the question "what did we agree for the UVDB pack
 * in March" would have no answer.
 *
 * Every bid belongs to exactly one engagement. That is what makes the ACU cost
 * of an agent run attributable to a customer and a piece of commercial work,
 * which is the only way a provider can see margin per customer.
 *
 * ## Pausing is a status, not a type
 *
 * The specification lists "stop-start" beside one-off, permanent, continuous
 * and staged, which would make it a fifth type. It is not: *any* engagement can
 * be paused and resumed, and a type for it would mean a permanent engagement
 * that goes quiet for four months has to be converted into a different kind of
 * thing and converted back. So `PAUSED` is a status every type can be in, and
 * `type` says how work opens and repeats.
 *
 * ## Terms are copied, never referenced
 *
 * An engagement created from a service offering takes a **copy** of that
 * offering's terms. The provider changes its price list next quarter; a signed
 * engagement does not move. An engagement that read its fee through a pointer
 * would silently re-price work that has already been delivered and invoiced,
 * which is the kind of defect that is discovered by a customer rather than by a
 * test.
 */

// --- The service catalogue ---------------------------------------------------

export const ENGAGEMENT_TYPE = ['ONE_OFF', 'PERMANENT', 'CONTINUOUS', 'STAGED', 'CUSTOM'] as const;
export type EngagementType = (typeof ENGAGEMENT_TYPE)[number];

export const BILLING_BASIS = ['FIXED_FEE', 'MONTHLY', 'PER_CYCLE', 'PER_STAGE', 'AS_AGREED'] as const;
export type BillingBasis = (typeof BILLING_BASIS)[number];

/**
 * How a billing basis has to match the type.
 *
 * Not decoration. A `STAGED` engagement billed `MONTHLY` has no answer to "what
 * does the next stage cost", and a `CONTINUOUS` one billed `FIXED_FEE` has no
 * answer to "what does the next cycle cost" — both are discovered when somebody
 * tries to raise the invoice, by which time the work is done. `CUSTOM` takes
 * any basis, because that is what it is for.
 */
const BASIS_FOR_TYPE: Record<EngagementType, readonly BillingBasis[]> = {
  ONE_OFF: ['FIXED_FEE', 'AS_AGREED'],
  PERMANENT: ['MONTHLY', 'AS_AGREED'],
  CONTINUOUS: ['PER_CYCLE', 'MONTHLY', 'AS_AGREED'],
  STAGED: ['PER_STAGE', 'FIXED_FEE', 'AS_AGREED'],
  CUSTOM: [...BILLING_BASIS],
};

/** How often a continuous engagement opens its next cycle. */
export const CYCLE_SCHEDULE = ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL'] as const;
export type CycleSchedule = (typeof CYCLE_SCHEDULE)[number];

/**
 * When the next cycle falls due, in calendar terms rather than in days.
 *
 * The first version added a fixed number of days — 365 for an annual cycle —
 * and the test caught what that does: 1 January 2028 plus 365 days is 31
 * December 2028, because 2028 is a leap year. An annual re-verification would
 * walk a day earlier every four years and drift out of step with the
 * registration it exists to renew, silently, over the life of a retainer that
 * is supposed to last.
 *
 * So the arithmetic is calendar arithmetic, and the day of the month is
 * clamped rather than allowed to roll over: 31 January plus one month is 28 or
 * 29 February, never 2 or 3 March. Rolling over would move a monthly cycle
 * forward a few days every short month, which is the same drift by a different
 * route.
 */
function nextDue(from: string, schedule: CycleSchedule): string {
  const [year, month, day] = from.slice(0, 10).split('-').map(Number) as [number, number, number];
  const months = { WEEKLY: 0, MONTHLY: 1, QUARTERLY: 3, ANNUAL: 12 }[schedule];

  if (months === 0) {
    const week = new Date(Date.UTC(year, month - 1, day + 7));
    return week.toISOString().slice(0, 10);
  }

  const target = month - 1 + months;
  const targetYear = year + Math.floor(target / 12);
  const targetMonth = ((target % 12) + 12) % 12;
  // Day 0 of the following month is the last day of the target one.
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

export type ServiceOffering = {
  id: string;
  reference: string;
  name: string;
  engagementType: EngagementType;
  billingBasis: BillingBasis;
  /** The starting price. Never a constant in code — every provider sets its own. */
  defaultFeeMinor: number;
  currency: string;
  /** Percentage taken up front, where the provider takes one. */
  depositPercent?: number;
  /** What the customer actually gets, in the words it is sold in. */
  deliverables: string[];
  /** The buyer-side rubric answers under this offering are scored against. */
  rubricScheme?: string;
  active: boolean;
  definedAt: string;
  definedBy: string;
};

export type EngagementStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';

export type EngagementStageStatus = 'PENDING' | 'OPEN' | 'SIGNED_OFF';

export type EngagementStage = {
  id: string;
  order: number;
  name: string;
  scope: string;
  feeMinor: number;
  dueOn?: string;
  status: EngagementStageStatus;
  signedOffBy?: string;
  signedOffAt?: string;
  signOffNote?: string;
  /** Which cycle of a continuous engagement this is, where it is one. */
  cycle?: number;
};

export type Engagement = {
  id: string;
  reference: string;
  customerAccountId: string;
  /** The offering it was created from, where it was. Provenance, never a live lookup. */
  offeringId?: string;
  name: string;
  type: EngagementType;
  status: EngagementStatus;
  billingBasis: BillingBasis;
  feeMinor: number;
  currency: string;
  depositPercent?: number;
  deliverables: string[];
  rubricScheme?: string;
  schedule?: CycleSchedule;
  startOn?: string;
  endOn?: string;
  stages: EngagementStage[];
  /** Free-form terms, for a CUSTOM engagement and for anything else worth recording. */
  termsText?: string;
  /**
   * Every change to the terms, kept rather than overwritten. What was agreed in
   * March is what was agreed in March, whatever the engagement says today.
   */
  termsHistory: Array<{ at: string; by: string; reason: string; feeMinor: number; billingBasis: BillingBasis }>;
  pausedAt?: string;
  pauseReason?: string;
  resumedAt?: string;
  closedAt?: string;
  closedBy?: string;
  closedReason?: string;
  openedAt: string;
  openedBy: string;
};

const NAME_MIN = 3;
const REASON_MIN = 12;
const SCOPE_MIN = 12;

function requireText(value: string, min: number, code: string, what: string): string {
  const text = value.trim();
  if (text.length < min) {
    throw new DomainError(code, `${what} needs at least ${min} characters`, 400);
  }
  return text;
}

function offeringsOf(ctx: EngineContext): ServiceOffering[] {
  return ctx.ledger
    .listByTenant(ctx.tenantId, 'BidOnOffering')
    .map((record) => record.state as unknown as ServiceOffering);
}

export function engagementsOf(ctx: EngineContext): Engagement[] {
  return ctx.ledger
    .listByTenant(ctx.tenantId, 'BidOnEngagement')
    .map((record) => record.state as unknown as Engagement);
}

function requireEngagementRecord(ctx: EngineContext, engagementId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'BidOnEngagement', refId: engagementId });
  if (!record || record.tenantId !== ctx.tenantId) {
    throw new DomainError('BID_ON_ENGAGEMENT_NOT_FOUND', `No engagement ${engagementId}`, 404);
  }
  return record;
}

// --- Offerings ---------------------------------------------------------------

/**
 * Define a service the provider sells. `G` on `BID_SERVICES`.
 *
 * Govern rather than create, because this is the provider's price list and not
 * a piece of work. The same verb that decides who may set a fee decides who may
 * publish what the fee is.
 */
export function defineOffering(
  ctx: EngineContext,
  input: {
    name: string;
    engagementType: EngagementType;
    billingBasis: BillingBasis;
    defaultFeeMinor: number;
    currency: string;
    depositPercent?: number;
    deliverables: string[];
    rubricScheme?: string;
  },
): ServiceOffering {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'G', { dataSensitivity: 'COMMERCIAL_L3' });

  const name = requireText(input.name, NAME_MIN, 'BID_ON_NAME_TOO_SHORT', 'A service name');
  requireBasis(input.engagementType, input.billingBasis);
  if (input.defaultFeeMinor < 0) {
    throw new DomainError('BID_ON_FEE_NEGATIVE', 'A fee cannot be negative', 400);
  }
  if (input.depositPercent !== undefined && (input.depositPercent < 0 || input.depositPercent > 100)) {
    throw new DomainError('BID_ON_DEPOSIT_RANGE', 'A deposit is a percentage between 0 and 100', 400);
  }
  const deliverables = input.deliverables.map((line) => line.trim()).filter(Boolean);
  if (deliverables.length === 0) {
    throw new DomainError(
      'BID_ON_NO_DELIVERABLES',
      'Say what the customer gets. A service with no stated deliverables is a price with nothing attached, and it ' +
        'is the provider who loses the argument about what was included.',
      400,
    );
  }

  const id = ulid();
  const offering: ServiceOffering = {
    id,
    reference: formatRef('SVC', offeringsOf(ctx).length + 1),
    name,
    engagementType: input.engagementType,
    billingBasis: input.billingBasis,
    defaultFeeMinor: input.defaultFeeMinor,
    currency: input.currency,
    ...(input.depositPercent === undefined ? {} : { depositPercent: input.depositPercent }),
    deliverables,
    ...(input.rubricScheme ? { rubricScheme: input.rubricScheme } : {}),
    active: true,
    definedAt: new Date().toISOString(),
    definedBy: ctx.auth.actorId,
  };

  write(ctx, {
    eventType: 'BID_ON_OFFERING_DEFINED',
    entity: { refType: 'BidOnOffering', refId: id },
    nextState: { ...offering },
  });

  return offering;
}

/** Change a service, or withdraw it. Engagements already signed are untouched. */
export function updateOffering(
  ctx: EngineContext,
  offeringId: string,
  input: { defaultFeeMinor?: number; deliverables?: string[]; rubricScheme?: string; active?: boolean },
): ServiceOffering {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'G', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = ctx.ledger.get({ refType: 'BidOnOffering', refId: offeringId });
  if (!record || record.tenantId !== ctx.tenantId) {
    throw new DomainError('BID_ON_OFFERING_NOT_FOUND', `No service ${offeringId}`, 404);
  }
  const offering = record.state as unknown as ServiceOffering;

  if (input.defaultFeeMinor !== undefined && input.defaultFeeMinor < 0) {
    throw new DomainError('BID_ON_FEE_NEGATIVE', 'A fee cannot be negative', 400);
  }
  const deliverables = input.deliverables?.map((line) => line.trim()).filter(Boolean);
  if (deliverables !== undefined && deliverables.length === 0) {
    throw new DomainError('BID_ON_NO_DELIVERABLES', 'A service cannot have its deliverables emptied', 400);
  }

  const next: ServiceOffering = {
    ...offering,
    ...(input.defaultFeeMinor === undefined ? {} : { defaultFeeMinor: input.defaultFeeMinor }),
    ...(deliverables === undefined ? {} : { deliverables }),
    ...(input.rubricScheme === undefined ? {} : { rubricScheme: input.rubricScheme }),
    ...(input.active === undefined ? {} : { active: input.active }),
  };

  write(ctx, {
    eventType: 'BID_ON_OFFERING_UPDATED',
    entity: { refType: 'BidOnOffering', refId: offeringId },
    nextState: { ...next },
  });

  return next;
}

function requireBasis(type: EngagementType, basis: BillingBasis): void {
  if (!BASIS_FOR_TYPE[type].includes(basis)) {
    throw new DomainError(
      'BID_ON_BASIS_MISMATCH',
      `A ${type.toLowerCase().replace('_', '-')} engagement cannot be billed ${basis.toLowerCase().replace('_', ' ')}. ` +
        `It takes one of: ${BASIS_FOR_TYPE[type].join(', ')}. A basis that does not fit the type has no answer to ` +
        '"what does the next one cost", and nobody finds that out until the invoice.',
      400,
    );
  }
}

// --- Opening an engagement ---------------------------------------------------

/**
 * Open an engagement with a customer. `G` on `BID_SERVICES`.
 *
 * It opens as `DRAFT`. Activation is a second act, because the terms are what
 * a customer is going to be charged against and somebody has to say they are
 * right before the work can start — the same reason a pack is issued rather
 * than appearing issued.
 */
export function openEngagement(
  ctx: EngineContext,
  input: {
    customerAccountId: string;
    name: string;
    type: EngagementType;
    billingBasis?: BillingBasis;
    feeMinor?: number;
    currency?: string;
    depositPercent?: number;
    deliverables?: string[];
    rubricScheme?: string;
    schedule?: CycleSchedule;
    startOn?: string;
    endOn?: string;
    termsText?: string;
    /** Pre-fills every term above from the provider's own catalogue. */
    offeringId?: string;
    /** Required for a staged engagement: a stage with no scope is a line in a list. */
    stages?: Array<{ name: string; scope: string; feeMinor: number; dueOn?: string }>;
  },
): Engagement {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'G', { dataSensitivity: 'COMMERCIAL_L3' });

  const customer = ctx.ledger.get({ refType: 'BidOnCustomer', refId: input.customerAccountId });
  if (!customer || customer.tenantId !== ctx.tenantId) {
    throw new DomainError('BID_ON_CUSTOMER_NOT_FOUND', `No customer ${input.customerAccountId}`, 404);
  }
  if ((customer.state as { status?: string }).status === 'CLOSED') {
    throw new DomainError(
      'BID_ON_CUSTOMER_CLOSED',
      'That customer is closed. Reopen it before opening new work against it, so the decision to start trading with ' +
        'them again is a decision somebody made rather than a side effect of creating an engagement.',
      409,
    );
  }

  // Terms from the catalogue where one was named, and a *copy* of them. The
  // offering is provenance; nothing reads it again.
  const offering = input.offeringId
    ? offeringsOf(ctx).find((entry) => entry.id === input.offeringId)
    : undefined;
  if (input.offeringId && !offering) {
    throw new DomainError('BID_ON_OFFERING_NOT_FOUND', `No service ${input.offeringId}`, 404);
  }
  if (offering && !offering.active) {
    throw new DomainError(
      'BID_ON_OFFERING_WITHDRAWN',
      `${offering.reference} has been withdrawn from the catalogue. Price this one directly, or put the service back.`,
      409,
    );
  }

  const type = input.type ?? offering?.engagementType;
  const billingBasis = input.billingBasis ?? offering?.billingBasis;
  const feeMinor = input.feeMinor ?? offering?.defaultFeeMinor;
  const currency = input.currency ?? offering?.currency;

  if (!billingBasis || feeMinor === undefined || !currency) {
    throw new DomainError(
      'BID_ON_TERMS_INCOMPLETE',
      'An engagement needs a billing basis, a fee and a currency. Name a service from the catalogue to take them ' +
        'from it, or state all three.',
      400,
    );
  }
  requireBasis(type, billingBasis);
  if (feeMinor < 0) throw new DomainError('BID_ON_FEE_NEGATIVE', 'A fee cannot be negative', 400);

  if (type === 'CONTINUOUS' && !input.schedule) {
    throw new DomainError(
      'BID_ON_SCHEDULE_REQUIRED',
      'A continuous engagement repeats on a schedule, so it needs one. Without it nothing decides when the next ' +
        'cycle opens, and a cycle that never opens is a retainer the customer is paying for and not receiving.',
      400,
    );
  }
  if (type !== 'CONTINUOUS' && input.schedule) {
    throw new DomainError(
      'BID_ON_SCHEDULE_UNUSED',
      `A ${type.toLowerCase()} engagement does not repeat, so a schedule on it would be recorded and never read.`,
      400,
    );
  }

  const stages = (input.stages ?? []).map((stage, index) => ({
    id: ulid(),
    order: index + 1,
    name: requireText(stage.name, NAME_MIN, 'BID_ON_NAME_TOO_SHORT', 'A stage name'),
    scope: requireText(stage.scope, SCOPE_MIN, 'BID_ON_SCOPE_TOO_SHORT', 'A stage scope'),
    feeMinor: stage.feeMinor,
    ...(stage.dueOn ? { dueOn: stage.dueOn } : {}),
    // The first stage opens on activation; the rest wait for a sign-off.
    status: (index === 0 ? 'OPEN' : 'PENDING') as EngagementStageStatus,
  }));

  if (type === 'STAGED' && stages.length < 2) {
    throw new DomainError(
      'BID_ON_STAGES_REQUIRED',
      'A staged engagement needs at least two stages. One stage is a one-off engagement with extra paperwork, and ' +
        'the difference matters: a staged engagement will not open its next stage until somebody signs off the last.',
      400,
    );
  }
  if (type !== 'STAGED' && type !== 'CUSTOM' && stages.length > 0) {
    throw new DomainError(
      'BID_ON_STAGES_UNUSED',
      `A ${type.toLowerCase()} engagement does not run in stages. Open a staged engagement, or leave them out.`,
      400,
    );
  }
  if (stages.some((stage) => stage.feeMinor < 0)) {
    throw new DomainError('BID_ON_FEE_NEGATIVE', 'A stage fee cannot be negative', 400);
  }
  if (input.startOn && input.endOn && input.endOn < input.startOn) {
    throw new DomainError('BID_ON_DATES_REVERSED', 'An engagement cannot end before it starts', 400);
  }

  const id = ulid();
  const at = new Date().toISOString();
  const engagement: Engagement = {
    id,
    reference: formatRef('ENG', engagementsOf(ctx).length + 1),
    customerAccountId: input.customerAccountId,
    ...(input.offeringId ? { offeringId: input.offeringId } : {}),
    name: requireText(input.name, NAME_MIN, 'BID_ON_NAME_TOO_SHORT', 'An engagement name'),
    type,
    status: 'DRAFT',
    billingBasis,
    feeMinor,
    currency,
    ...(input.depositPercent ?? offering?.depositPercent
      ? { depositPercent: input.depositPercent ?? offering!.depositPercent! }
      : {}),
    deliverables: (input.deliverables ?? offering?.deliverables ?? []).map((line) => line.trim()).filter(Boolean),
    ...(input.rubricScheme ?? offering?.rubricScheme
      ? { rubricScheme: (input.rubricScheme ?? offering?.rubricScheme)! }
      : {}),
    ...(input.schedule ? { schedule: input.schedule } : {}),
    ...(input.startOn ? { startOn: input.startOn } : {}),
    ...(input.endOn ? { endOn: input.endOn } : {}),
    stages,
    ...(input.termsText?.trim() ? { termsText: input.termsText.trim() } : {}),
    termsHistory: [{ at, by: ctx.auth.actorId, reason: 'Opened', feeMinor, billingBasis }],
    openedAt: at,
    openedBy: ctx.auth.actorId,
  };

  write(ctx, {
    eventType: 'BID_ON_ENGAGEMENT_OPENED',
    entity: { refType: 'BidOnEngagement', refId: id },
    nextState: { ...engagement },
  });

  return engagement;
}

/** Activate it, which is what lets work start. `A` on `BID_SERVICES`. */
export function activateEngagement(ctx: EngineContext, engagementId: string): Engagement {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'A', { dataSensitivity: 'COMMERCIAL_L3' });

  const engagement = requireEngagementRecord(ctx, engagementId).state as unknown as Engagement;
  if (engagement.status !== 'DRAFT') {
    throw new DomainError(
      'BID_ON_NOT_DRAFT',
      `${engagement.reference} is ${engagement.status.toLowerCase()}. Only a draft engagement is activated; a paused ` +
        'one is resumed.',
      409,
    );
  }

  const active: Engagement = { ...engagement, status: 'ACTIVE' };
  write(ctx, {
    eventType: 'BID_ON_ENGAGEMENT_ACTIVATED',
    entity: { refType: 'BidOnEngagement', refId: engagementId },
    nextState: { ...active },
  });
  return active;
}

// --- The gate every piece of work goes through -------------------------------

/**
 * Whether work may happen under this engagement right now, and why not.
 *
 * One function, called by every Bid-On command that costs money or produces a
 * deliverable. The alternative — each command deciding for itself — is how a
 * paused engagement ends up accepting an agent run through the one route
 * somebody forgot.
 */
export function engagementOpenForWork(engagement: Engagement): { open: boolean; reason?: string } {
  if (engagement.status === 'ACTIVE') return { open: true };
  if (engagement.status === 'DRAFT') {
    return {
      open: false,
      reason: `${engagement.reference} has not been activated. The terms have to be agreed before work is done ` +
        'against them.',
    };
  }
  if (engagement.status === 'PAUSED') {
    return {
      open: false,
      reason:
        `${engagement.reference} is paused${engagement.pauseReason ? ` — ${engagement.pauseReason}` : ''}. Nothing is ` +
        'lost and nothing is billed while it is; resume it and every bid is exactly as it was.',
    };
  }
  return {
    open: false,
    reason: `${engagement.reference} is ${engagement.status.toLowerCase()}. Its bids are readable and nothing more ` +
      'can be written against them.',
  };
}

/**
 * Load an engagement and refuse unless it is open for work.
 *
 * Exported because the bid side of the module calls it on every create, every
 * agent run and every export — and because a single refusal message means a
 * person sees the same sentence wherever they hit it.
 */
export function requireOpenEngagement(ctx: EngineContext, engagementId: string): Engagement {
  const engagement = requireEngagementRecord(ctx, engagementId).state as unknown as Engagement;
  const standing = engagementOpenForWork(engagement);
  if (!standing.open) {
    throw new DomainError('BID_ON_ENGAGEMENT_NOT_OPEN', standing.reason!, 409);
  }
  return engagement;
}

// --- Pausing, resuming, closing ----------------------------------------------

/**
 * Pause. Any type, any time. `U` on `BID_SERVICES`.
 *
 * Freezes rather than ends: no agent run, no recurring charge, and every bid
 * left exactly where it was. The reason is mandatory because "why is this
 * customer's work stopped" is the question somebody asks four months later, and
 * a pause with no reason reads as an oversight.
 */
export function pauseEngagement(ctx: EngineContext, engagementId: string, input: { reason: string }): Engagement {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const engagement = requireEngagementRecord(ctx, engagementId).state as unknown as Engagement;
  if (engagement.status !== 'ACTIVE') {
    throw new DomainError(
      'BID_ON_NOT_ACTIVE',
      `${engagement.reference} is ${engagement.status.toLowerCase()} and only active work can be paused.`,
      409,
    );
  }
  const reason = requireText(input.reason, REASON_MIN, 'BID_ON_REASON_TOO_SHORT', 'A pause reason');

  const paused: Engagement = {
    ...engagement,
    status: 'PAUSED',
    pausedAt: new Date().toISOString(),
    pauseReason: reason,
  };
  write(ctx, {
    eventType: 'BID_ON_ENGAGEMENT_PAUSED',
    entity: { refType: 'BidOnEngagement', refId: engagementId },
    nextState: { ...paused },
  });
  return paused;
}

/** Resume exactly where it stopped. The stages and bids are untouched by design. */
export function resumeEngagement(ctx: EngineContext, engagementId: string): Engagement {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const engagement = requireEngagementRecord(ctx, engagementId).state as unknown as Engagement;
  if (engagement.status !== 'PAUSED') {
    throw new DomainError(
      'BID_ON_NOT_PAUSED',
      `${engagement.reference} is ${engagement.status.toLowerCase()} and is not paused.`,
      409,
    );
  }

  // `pausedAt` and `pauseReason` are kept rather than cleared. How long a
  // customer was away, and why, is the record — and clearing it would make a
  // stop-start engagement indistinguishable from one that never stopped.
  const resumed: Engagement = { ...engagement, status: 'ACTIVE', resumedAt: new Date().toISOString() };
  write(ctx, {
    eventType: 'BID_ON_ENGAGEMENT_RESUMED',
    entity: { refType: 'BidOnEngagement', refId: engagementId },
    nextState: { ...resumed },
  });
  return resumed;
}

/**
 * Change the terms. `G` on `BID_SERVICES`, and versioned.
 *
 * The new terms apply from now; `termsHistory` keeps what they were. A fee
 * edited in place would rewrite what the customer owed for work already
 * delivered, and the statement for last month would change after it was sent.
 */
export function retermEngagement(
  ctx: EngineContext,
  engagementId: string,
  input: {
    reason: string;
    feeMinor?: number;
    billingBasis?: BillingBasis;
    deliverables?: string[];
    endOn?: string;
    termsText?: string;
  },
): Engagement {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'G', { dataSensitivity: 'COMMERCIAL_L3' });

  const engagement = requireEngagementRecord(ctx, engagementId).state as unknown as Engagement;
  if (engagement.status === 'COMPLETED' || engagement.status === 'CANCELLED') {
    throw new DomainError(
      'BID_ON_ENGAGEMENT_CLOSED',
      `${engagement.reference} is ${engagement.status.toLowerCase()}. Closed terms are the record of what was agreed ` +
        'and are not edited; open a new engagement.',
      409,
    );
  }
  const reason = requireText(input.reason, REASON_MIN, 'BID_ON_REASON_TOO_SHORT', 'A reason for the change');

  const billingBasis = input.billingBasis ?? engagement.billingBasis;
  requireBasis(engagement.type, billingBasis);
  const feeMinor = input.feeMinor ?? engagement.feeMinor;
  if (feeMinor < 0) throw new DomainError('BID_ON_FEE_NEGATIVE', 'A fee cannot be negative', 400);

  const at = new Date().toISOString();
  const next: Engagement = {
    ...engagement,
    feeMinor,
    billingBasis,
    ...(input.deliverables ? { deliverables: input.deliverables.map((l) => l.trim()).filter(Boolean) } : {}),
    ...(input.endOn ? { endOn: input.endOn } : {}),
    ...(input.termsText?.trim() ? { termsText: input.termsText.trim() } : {}),
    termsHistory: [...engagement.termsHistory, { at, by: ctx.auth.actorId, reason, feeMinor, billingBasis }],
  };

  write(ctx, {
    eventType: 'BID_ON_ENGAGEMENT_RETERMED',
    entity: { refType: 'BidOnEngagement', refId: engagementId },
    nextState: { ...next },
  });
  return next;
}

/**
 * Sign off a stage, which is what opens the next one. `A` on `BID_SERVICES`.
 *
 * Used by a staged engagement and by each cycle of a continuous one — the same
 * record and the same act, because "this piece is delivered and the next may
 * start" is the same decision whether the pieces were planned up front or
 * generated by a schedule.
 */
export function signOffStage(
  ctx: EngineContext,
  engagementId: string,
  stageId: string,
  input: { note: string },
): { engagement: Engagement; signedOff: EngagementStage; opened: EngagementStage | null } {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'A', { dataSensitivity: 'COMMERCIAL_L3' });

  const engagement = requireOpenEngagement(ctx, engagementId);
  const stage = engagement.stages.find((entry) => entry.id === stageId);
  if (!stage) {
    throw new DomainError('BID_ON_STAGE_NOT_FOUND', `${engagement.reference} has no stage ${stageId}`, 404);
  }
  if (stage.status === 'SIGNED_OFF') {
    throw new DomainError(
      'BID_ON_STAGE_SIGNED_OFF',
      `${stage.name} is already signed off. A second sign-off is not a correction; it would bill the stage twice.`,
      409,
    );
  }
  if (stage.status === 'PENDING') {
    throw new DomainError(
      'BID_ON_STAGE_NOT_OPEN',
      `${stage.name} has not opened yet. Stages run in order, because the next one's scope depends on what the last ` +
        'one delivered.',
      409,
    );
  }
  const note = requireText(input.note, REASON_MIN, 'BID_ON_NOTE_TOO_SHORT', 'A sign-off note');

  const at = new Date().toISOString();
  const signedOff: EngagementStage = {
    ...stage,
    status: 'SIGNED_OFF',
    signedOffBy: ctx.auth.actorId,
    signedOffAt: at,
    signOffNote: note,
  };

  // The next pending stage in order, and only one. Opening two would mean two
  // pieces of work billed at once against an engagement that bills per stage.
  const nextPending = engagement.stages
    .filter((entry) => entry.status === 'PENDING' && entry.order > stage.order)
    .sort((a, b) => a.order - b.order)[0];
  const opened: EngagementStage | null = nextPending ? { ...nextPending, status: 'OPEN' } : null;

  const next: Engagement = {
    ...engagement,
    stages: engagement.stages.map((entry) =>
      entry.id === stageId ? signedOff : opened && entry.id === opened.id ? opened : entry,
    ),
  };

  write(ctx, {
    eventType: 'BID_ON_STAGE_SIGNED_OFF',
    entity: { refType: 'BidOnEngagement', refId: engagementId },
    nextState: { ...next },
  });

  return { engagement: next, signedOff, opened };
}

/**
 * Open the next cycle of a continuous engagement. `U` on `BID_SERVICES`.
 *
 * A cycle is a stage with a number on it. Annual re-verification and a weekly
 * tender watch are the same shape — a repeating piece of scoped, priced work —
 * and giving cycles their own entity would have duplicated sign-off, billing
 * and the ordering rule for no gain.
 *
 * Refused before the schedule is due. The platform does not open a cycle the
 * customer is not yet being billed for, and `dueOn` is derived from the last
 * cycle rather than from the clock, so a gap does not silently reset the cadence.
 */
export function openNextCycle(ctx: EngineContext, engagementId: string, input: { scope: string }): Engagement {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const engagement = requireOpenEngagement(ctx, engagementId);
  if (engagement.type !== 'CONTINUOUS' || !engagement.schedule) {
    throw new DomainError(
      'BID_ON_NOT_CONTINUOUS',
      `${engagement.reference} does not repeat, so it has no next cycle.`,
      409,
    );
  }
  const live = engagement.stages.find((stage) => stage.status === 'OPEN');
  if (live) {
    throw new DomainError(
      'BID_ON_CYCLE_OPEN',
      `${live.name} is still open. Sign it off before opening the next cycle — two open cycles is two cycles billed ` +
        'for one period of work.',
      409,
    );
  }
  const scope = requireText(input.scope, SCOPE_MIN, 'BID_ON_SCOPE_TOO_SHORT', 'A cycle scope');

  const cycles = engagement.stages.filter((stage) => stage.cycle !== undefined);
  const cycle = cycles.length + 1;
  const last = cycles.sort((a, b) => (b.cycle ?? 0) - (a.cycle ?? 0))[0];
  const from = last?.dueOn ?? engagement.startOn ?? new Date().toISOString().slice(0, 10);
  const dueOn = nextDue(from, engagement.schedule);

  const stage: EngagementStage = {
    id: ulid(),
    order: engagement.stages.length + 1,
    name: `${engagement.schedule.toLowerCase()} cycle ${cycle}`,
    scope,
    feeMinor: engagement.feeMinor,
    dueOn,
    status: 'OPEN',
    cycle,
  };

  const next: Engagement = { ...engagement, stages: [...engagement.stages, stage] };
  write(ctx, {
    eventType: 'BID_ON_CYCLE_OPENED',
    entity: { refType: 'BidOnEngagement', refId: engagementId },
    nextState: { ...next },
  });
  return next;
}

/**
 * Complete or cancel. `A` on `BID_SERVICES`.
 *
 * One function for both, because the effect on the work is identical — the
 * bids become read-only and nothing more is billed — and the difference is what
 * is recorded about why. Two functions would have been two places to keep that
 * effect in step.
 */
export function closeEngagement(
  ctx: EngineContext,
  engagementId: string,
  input: { outcome: 'COMPLETED' | 'CANCELLED'; reason: string },
): Engagement {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'A', { dataSensitivity: 'COMMERCIAL_L3' });

  const engagement = requireEngagementRecord(ctx, engagementId).state as unknown as Engagement;
  if (engagement.status === 'COMPLETED' || engagement.status === 'CANCELLED') {
    throw new DomainError(
      'BID_ON_ENGAGEMENT_CLOSED',
      `${engagement.reference} is already ${engagement.status.toLowerCase()}.`,
      409,
    );
  }
  if (engagement.status === 'DRAFT' && input.outcome === 'COMPLETED') {
    throw new DomainError(
      'BID_ON_NOT_ACTIVE',
      `${engagement.reference} was never activated, so there is nothing to complete. Cancel it instead — the record ` +
        'should say the work never started rather than that it finished.',
      409,
    );
  }
  const reason = requireText(input.reason, REASON_MIN, 'BID_ON_REASON_TOO_SHORT', 'A reason');

  const closed: Engagement = {
    ...engagement,
    status: input.outcome,
    closedAt: new Date().toISOString(),
    closedBy: ctx.auth.actorId,
    closedReason: reason,
  };

  write(ctx, {
    eventType: input.outcome === 'COMPLETED' ? 'BID_ON_ENGAGEMENT_COMPLETED' : 'BID_ON_ENGAGEMENT_CANCELLED',
    entity: { refType: 'BidOnEngagement', refId: engagementId },
    nextState: { ...closed },
  });
  return closed;
}

// --- Reads -------------------------------------------------------------------

export type OfferingCatalogue = { offerings: ServiceOffering[]; summary: string };

export function offeringCatalogue(ctx: EngineContext): OfferingCatalogue {
  requireModuleReadable(ctx.grantedModules, ctx.heldModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const offerings = offeringsOf(ctx).sort((a, b) => a.reference.localeCompare(b.reference));
  const active = offerings.filter((entry) => entry.active).length;
  return {
    offerings,
    summary:
      offerings.length === 0
        ? 'No service defined yet. Define what this business sells once, and every engagement is priced from it.'
        : `${active} active service(s) of ${offerings.length} defined.`,
  };
}

export type EngagementSummary = Engagement & {
  openForWork: boolean;
  blockedReason?: string;
  /** The stage or cycle work is being done under, where there is one. */
  openStage: EngagementStage | null;
  stagesSignedOff: number;
};

export type EngagementRegister = {
  engagements: EngagementSummary[];
  /** What the register cannot answer, said rather than left for somebody to assume. */
  limits: string[];
  summary: string;
};

/**
 * Every engagement the tenancy holds, with what is stopping each.
 *
 * Computed on read rather than stored, for the reason every other position in
 * this platform is: a stored "open for work" is a second copy of a conclusion
 * that changes the moment somebody pauses the engagement.
 */
export function engagementRegister(
  ctx: EngineContext,
  filter: { customerAccountId?: string } = {},
): EngagementRegister {
  requireModuleReadable(ctx.grantedModules, ctx.heldModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const engagements = engagementsOf(ctx)
    .filter((entry) => !filter.customerAccountId || entry.customerAccountId === filter.customerAccountId)
    .map((entry) => {
      const standing = engagementOpenForWork(entry);
      return {
        ...entry,
        openForWork: standing.open,
        ...(standing.reason ? { blockedReason: standing.reason } : {}),
        openStage: entry.stages.find((stage) => stage.status === 'OPEN') ?? null,
        stagesSignedOff: entry.stages.filter((stage) => stage.status === 'SIGNED_OFF').length,
      };
    })
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt));

  const active = engagements.filter((entry) => entry.status === 'ACTIVE').length;
  const paused = engagements.filter((entry) => entry.status === 'PAUSED').length;

  const limits: string[] = [];
  const overdue = engagements.filter(
    (entry) =>
      entry.status === 'ACTIVE' &&
      entry.type === 'CONTINUOUS' &&
      entry.openStage === null &&
      entry.stages.length > 0,
  );
  if (overdue.length > 0) {
    limits.push(
      `${overdue.length} continuous engagement(s) have no open cycle. A retainer with no cycle open is one the ` +
        'customer is being billed for and not receiving.',
    );
  }
  const draft = engagements.filter((entry) => entry.status === 'DRAFT').length;
  if (draft > 0) {
    limits.push(`${draft} engagement(s) are drafted and not activated, so no work can be done under them yet.`);
  }

  return {
    engagements,
    limits,
    summary:
      engagements.length === 0
        ? 'No engagement opened yet. Every bid belongs to one, which is what makes its AI cost attributable to a ' +
          'customer and a piece of commercial work.'
        : `${engagements.length} engagement(s): ${active} active` +
          (paused > 0 ? `, ${paused} paused` : '') +
          `, ${engagements.filter((e) => e.status === 'COMPLETED').length} completed.`,
  };
}
