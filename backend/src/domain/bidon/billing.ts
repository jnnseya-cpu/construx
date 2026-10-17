import { DomainError } from '../../core/errors.ts';
import { formatRef, ulid } from '../../core/ids.ts';
import { authorise, write, type EngineContext } from '../../engines/context.ts';
import { requireModule, requireModuleReadable } from '../../identity/modules.ts';
import { customersOf, requireVisibleCustomer } from './customers.ts';
import { engagementsOf, type Engagement } from './engagements.ts';
import { bidsOf } from './bids.ts';

/**
 * What the customer owes the provider, and what the AI cost to produce.
 *
 * ## Two different moneys, and why they are on one screen
 *
 * A provider using Bid-On has money going both ways. It pays the platform
 * operator for access and for ACU; it charges its own customers a fee by
 * engagement. Those are separate ledgers and neither belongs to the other — but
 * the question a provider actually asks is *"what did this customer cost me and
 * what did they pay me"*, and that question has no answer unless both are
 * readable in one place against one engagement.
 *
 * So `engagementStatement` reads the invoices this module issues **and** the AI
 * executions attributed to the same engagement, and reports them side by side
 * with the margin between. The ACU figure is not re-derived: it is the charge
 * already settled on each `AIExecution` record, which is the same number the
 * wallet moved.
 *
 * ## The deposit is a gate on agent runs and nothing else
 *
 * The specification is precise: *"blocks agent runs until it is paid, unless
 * the Provider Admin waives it."* Not all work — agent runs. The distinction is
 * the whole point of putting it where it is:
 *
 *   - A customer whose deposit is unpaid can still be set up, still upload
 *     their policies and certificates, still confirm declarations, still have
 *     their question list read by a person. None of that costs the provider
 *     anything but time it has chosen to spend.
 *   - What is blocked is the spend. An agent run costs the provider real money
 *     at the moment it runs, and running them for a customer who has not paid
 *     a deposit is the provider lending money it did not agree to lend.
 *
 * Blocking everything would make the deposit a barrier to getting started
 * rather than a payment term, and the first thing it would stop is the customer
 * uploading the evidence the work depends on.
 *
 * ## No money moves here
 *
 * `docs/STATE.md` already records that BitriPay and any invoicing run are not
 * built. An invoice in this module is a **record of what is owed**, issued and
 * numbered, and `recordPayment` is somebody saying it was paid — not a payment
 * being taken. Every read says so rather than letting a statement look like a
 * reconciled account. That honesty is the difference between a tool a provider
 * trusts and one they stop using the first time it is wrong about money.
 */

export const INVOICE_KIND = ['DEPOSIT', 'BALANCE', 'STAGE', 'CYCLE', 'MONTHLY'] as const;
export type InvoiceKind = (typeof INVOICE_KIND)[number];

export const INVOICE_STATUS = ['ISSUED', 'PAID', 'WAIVED', 'VOID'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUS)[number];

export type BidOnInvoice = {
  id: string;
  reference: string;
  customerAccountId: string;
  engagementId: string;
  kind: InvoiceKind;
  /** What it is for, in the words the customer will read on it. */
  narrative: string;
  amountMinor: number;
  currency: string;
  status: InvoiceStatus;
  /** The stage or cycle it bills, where it bills one. */
  stageId?: string;
  issuedAt: string;
  issuedBy: string;
  dueOn?: string;
  paidAt?: string;
  paidBy?: string;
  /** How the provider says it was paid. Not a payment: nothing here moves money. */
  paymentReference?: string;
  waivedAt?: string;
  waivedBy?: string;
  waivedReason?: string;
  voidedAt?: string;
  voidedBy?: string;
  voidedReason?: string;
};

const REASON_MIN = 12;

function requireText(value: string, min: number, code: string, what: string): string {
  const text = value.trim();
  if (text.length < min) throw new DomainError(code, `${what} needs at least ${min} characters`, 400);
  return text;
}

export function invoicesOf(ctx: EngineContext): BidOnInvoice[] {
  return ctx.ledger
    .listByTenant(ctx.tenantId, 'BidOnInvoice')
    .map((record) => record.state as unknown as BidOnInvoice);
}

/** Days a provider gets to pay, unless the engagement says otherwise. */
const DEFAULT_TERMS_DAYS = 14;

const addDays = (from: string, days: number): string =>
  new Date(Date.parse(from.slice(0, 10)) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Issue an invoice against an engagement. `G` on `BID_SERVICES`.
 *
 * `G` rather than `C`, for the same reason setting a fee is: an invoice is the
 * commercial relationship, not the work. Whoever may agree what a customer pays
 * is who may bill them for it, and a bid writer who could issue an invoice
 * could invent a fee the director never agreed.
 */
export function issueInvoice(
  ctx: EngineContext,
  input: {
    engagementId: string;
    kind: InvoiceKind;
    amountMinor?: number;
    narrative?: string;
    stageId?: string;
    dueOn?: string;
  },
): BidOnInvoice {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'G', { dataSensitivity: 'COMMERCIAL_L3' });

  const engagement = engagementsOf(ctx).find((entry) => entry.id === input.engagementId);
  if (!engagement) {
    throw new DomainError('BID_ON_ENGAGEMENT_NOT_FOUND', `No engagement ${input.engagementId}`, 404);
  }
  requireVisibleCustomer(ctx, engagement.customerAccountId);

  if (engagement.status === 'DRAFT') {
    throw new DomainError(
      'BID_ON_NOT_ACTIVE',
      `${engagement.reference} has not been activated, so its terms are not agreed. Billing against terms nobody has ` +
        'agreed is how a dispute starts.',
      409,
    );
  }

  const amountMinor = input.amountMinor ?? defaultAmount(engagement, input.kind, input.stageId);
  if (amountMinor === null) {
    throw new DomainError(
      'BID_ON_AMOUNT_REQUIRED',
      `Nothing on ${engagement.reference} decides what a ${input.kind.toLowerCase()} invoice is worth, so state the ` +
        'amount. A figure the platform guessed is a figure nobody agreed.',
      400,
    );
  }
  if (amountMinor < 0) throw new DomainError('BID_ON_FEE_NEGATIVE', 'An invoice cannot be negative', 400);

  // One live invoice per thing billed. Two deposit invoices on one engagement
  // is a customer asked twice, and the second one is the one that gets paid by
  // mistake.
  const duplicate = invoicesOf(ctx).find(
    (entry) =>
      entry.engagementId === engagement.id &&
      entry.kind === input.kind &&
      entry.stageId === input.stageId &&
      ['ISSUED', 'PAID'].includes(entry.status),
  );
  if (duplicate) {
    throw new DomainError(
      'BID_ON_INVOICE_EXISTS',
      `${duplicate.reference} already bills that: ${duplicate.narrative}. Void it before issuing another — a ` +
        'customer asked twice pays the wrong one.',
      409,
    );
  }

  const at = new Date().toISOString();
  const id = ulid();
  const invoice: BidOnInvoice = {
    id,
    reference: formatRef('INV', invoicesOf(ctx).length + 1),
    customerAccountId: engagement.customerAccountId,
    engagementId: engagement.id,
    kind: input.kind,
    narrative:
      input.narrative?.trim() ||
      defaultNarrative(engagement, input.kind, input.stageId),
    amountMinor,
    currency: engagement.currency,
    status: 'ISSUED',
    ...(input.stageId ? { stageId: input.stageId } : {}),
    issuedAt: at,
    issuedBy: ctx.auth.actorId,
    dueOn: input.dueOn ?? addDays(at, DEFAULT_TERMS_DAYS),
  };

  write(ctx, {
    eventType: 'BID_ON_INVOICE_ISSUED',
    entity: { refType: 'BidOnInvoice', refId: id },
    nextState: { ...invoice },
  });

  return invoice;
}

/** What the engagement's own terms make an invoice worth, where they decide it. */
function defaultAmount(engagement: Engagement, kind: InvoiceKind, stageId?: string): number | null {
  if (kind === 'DEPOSIT') {
    return engagement.depositPercent === undefined
      ? null
      : Math.round(engagement.feeMinor * (engagement.depositPercent / 100));
  }
  if (kind === 'BALANCE') {
    const deposit =
      engagement.depositPercent === undefined
        ? 0
        : Math.round(engagement.feeMinor * (engagement.depositPercent / 100));
    return engagement.feeMinor - deposit;
  }
  if (kind === 'MONTHLY') return engagement.feeMinor;
  if (kind === 'STAGE' || kind === 'CYCLE') {
    const stage = engagement.stages.find((entry) => entry.id === stageId);
    return stage ? stage.feeMinor : null;
  }
  return null;
}

function defaultNarrative(engagement: Engagement, kind: InvoiceKind, stageId?: string): string {
  const stage = engagement.stages.find((entry) => entry.id === stageId);
  switch (kind) {
    case 'DEPOSIT':
      return `Deposit on ${engagement.name}${engagement.depositPercent ? ` (${engagement.depositPercent}%)` : ''}`;
    case 'BALANCE':
      return `Balance on ${engagement.name}, on delivery`;
    case 'MONTHLY':
      return `${engagement.name} — monthly fee`;
    case 'STAGE':
      return `${engagement.name} — ${stage?.name ?? 'stage'}, on sign-off`;
    case 'CYCLE':
      return `${engagement.name} — ${stage?.name ?? 'cycle'}`;
  }
}

/**
 * Record that an invoice was paid. `G` on `BID_SERVICES`.
 *
 * Somebody saying it was paid, not a payment being taken. Nothing in this
 * module moves money and every read says so — a statement that looked
 * reconciled while nothing had been reconciled is the kind of wrong about money
 * that stops a provider trusting the tool.
 */
export function recordPayment(
  ctx: EngineContext,
  invoiceId: string,
  input: { paymentReference: string; paidOn?: string },
): BidOnInvoice {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'G', { dataSensitivity: 'COMMERCIAL_L3' });

  const invoice = requireInvoice(ctx, invoiceId);
  if (invoice.status !== 'ISSUED') {
    throw new DomainError(
      'BID_ON_INVOICE_NOT_ISSUED',
      `${invoice.reference} is ${invoice.status.toLowerCase()}, so there is nothing outstanding to record against it.`,
      409,
    );
  }

  const paid: BidOnInvoice = {
    ...invoice,
    status: 'PAID',
    paidAt: (input.paidOn ?? new Date().toISOString()).slice(0, 10),
    paidBy: ctx.auth.actorId,
    paymentReference: requireText(
      input.paymentReference,
      4,
      'BID_ON_PAYMENT_REFERENCE_REQUIRED',
      'A payment reference',
    ),
  };

  write(ctx, {
    eventType: 'BID_ON_INVOICE_PAID',
    entity: { refType: 'BidOnInvoice', refId: invoiceId },
    nextState: { ...paid },
  });

  return paid;
}

/**
 * Waive a deposit, so work can start before it is paid. `G` on `BID_SERVICES`.
 *
 * The specification's own escape hatch — *"unless the Provider Admin waives
 * it"* — and the reason is commercial rather than technical: a provider who
 * knows the customer will sometimes start on a handshake, and a platform that
 * made that impossible would be a platform they work around.
 *
 * The reason is mandatory, and it is the point. A waiver with no reason is
 * indistinguishable from a deposit nobody chased, and the difference matters
 * three months later when somebody asks why this customer never paid one.
 */
export function waiveInvoice(ctx: EngineContext, invoiceId: string, input: { reason: string }): BidOnInvoice {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'G', { dataSensitivity: 'COMMERCIAL_L3' });

  const invoice = requireInvoice(ctx, invoiceId);
  if (invoice.status !== 'ISSUED') {
    throw new DomainError(
      'BID_ON_INVOICE_NOT_ISSUED',
      `${invoice.reference} is ${invoice.status.toLowerCase()} and only an outstanding invoice can be waived.`,
      409,
    );
  }

  const waived: BidOnInvoice = {
    ...invoice,
    status: 'WAIVED',
    waivedAt: new Date().toISOString(),
    waivedBy: ctx.auth.actorId,
    waivedReason: requireText(input.reason, REASON_MIN, 'BID_ON_REASON_TOO_SHORT', 'A reason for the waiver'),
  };

  write(ctx, {
    eventType: 'BID_ON_INVOICE_WAIVED',
    entity: { refType: 'BidOnInvoice', refId: invoiceId },
    nextState: { ...waived },
  });

  return waived;
}

/** Void one issued in error. Voided, never deleted — the number was used. */
export function voidInvoice(ctx: EngineContext, invoiceId: string, input: { reason: string }): BidOnInvoice {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'G', { dataSensitivity: 'COMMERCIAL_L3' });

  const invoice = requireInvoice(ctx, invoiceId);
  if (invoice.status === 'PAID') {
    throw new DomainError(
      'BID_ON_INVOICE_PAID',
      `${invoice.reference} has been paid. Voiding a paid invoice would leave money received against nothing; ` +
        'credit it instead.',
      409,
    );
  }
  if (invoice.status === 'VOID') {
    throw new DomainError('BID_ON_INVOICE_VOID', `${invoice.reference} is already void.`, 409);
  }

  const voided: BidOnInvoice = {
    ...invoice,
    status: 'VOID',
    voidedAt: new Date().toISOString(),
    voidedBy: ctx.auth.actorId,
    voidedReason: requireText(input.reason, REASON_MIN, 'BID_ON_REASON_TOO_SHORT', 'A reason'),
  };

  write(ctx, {
    eventType: 'BID_ON_INVOICE_VOIDED',
    entity: { refType: 'BidOnInvoice', refId: invoiceId },
    nextState: { ...voided },
  });

  return voided;
}

function requireInvoice(ctx: EngineContext, invoiceId: string): BidOnInvoice {
  const record = ctx.ledger.get({ refType: 'BidOnInvoice', refId: invoiceId });
  if (!record || record.tenantId !== ctx.tenantId) {
    throw new DomainError('BID_ON_INVOICE_NOT_FOUND', `No invoice ${invoiceId}`, 404);
  }
  const invoice = record.state as unknown as BidOnInvoice;
  requireVisibleCustomer(ctx, invoice.customerAccountId);
  return invoice;
}

// --- The gate on an agent run ------------------------------------------------

export type FundingStanding = { funded: boolean; reason?: string };

/**
 * Whether this engagement's deposit has been settled, one way or another.
 *
 * Pure, and takes the invoices rather than reading them, so the four AI
 * commands and the screen that explains the refusal agree by construction.
 *
 * "Settled" is paid **or** waived **or** never required. A waiver is a decision
 * somebody made with their name on it, and treating it as still outstanding
 * would make the escape hatch useless.
 */
export function depositStanding(engagement: Engagement, invoices: BidOnInvoice[]): FundingStanding {
  const deposits = invoices.filter(
    (entry) => entry.engagementId === engagement.id && entry.kind === 'DEPOSIT' && entry.status !== 'VOID',
  );
  if (deposits.length === 0) return { funded: true };

  const settled = deposits.some((entry) => entry.status === 'PAID' || entry.status === 'WAIVED');
  if (settled) return { funded: true };

  const outstanding = deposits[0]!;
  return {
    funded: false,
    reason:
      `${outstanding.reference} — ${outstanding.narrative} — is outstanding, so no agent run can be started on this ` +
      'engagement. A person can still set the customer up, file their evidence and confirm a question list: what is ' +
      'blocked is the spend, because an agent run costs real money the moment it runs and running one for an unpaid ' +
      'deposit is lending money nobody agreed to lend. Record the payment, or waive it with a reason.',
  };
}

/**
 * Refuse an agent run where the deposit is outstanding.
 *
 * Called by the Bid Engine's shared gate, beside `requireOpenEngagement` rather
 * than inside it — the two answer different questions. One asks whether work
 * may happen at all; this asks whether the provider has been paid enough to
 * spend money on it. A paused engagement blocks everything; an unpaid deposit
 * blocks only the spend.
 */
export function requireFundedEngagement(ctx: EngineContext, engagement: Engagement): void {
  const standing = depositStanding(engagement, invoicesOf(ctx));
  if (!standing.funded) {
    throw new DomainError('BID_ON_DEPOSIT_OUTSTANDING', standing.reason!, 402);
  }
}

// --- The statement -----------------------------------------------------------

export type StatementLine = {
  on: string;
  kind: 'INVOICE' | 'PAYMENT' | 'AI_RUN';
  reference: string;
  narrative: string;
  /** Positive is owed to the provider; AI cost is reported separately. */
  amountMinor: number;
};

export type EngagementStatement = {
  engagementId: string;
  reference: string;
  customer: { id: string; legalName: string };
  period: { from: string; to: string };
  /** What the provider delivered in the period. */
  work: { bidsStarted: number; packsExported: number; answersApproved: number; stagesSignedOff: number };
  invoicedMinor: number;
  receivedMinor: number;
  outstandingMinor: number;
  waivedMinor: number;
  /** What the AI cost the provider, from the runs attributed to this engagement. */
  acuChargedMinor: number;
  acuRuns: number;
  /** Received less what the AI cost. Not profit — it ignores the provider's time. */
  contributionMinor: number;
  lines: StatementLine[];
  limits: string[];
  summary: string;
};

/**
 * One engagement's account for a period: work done, ACU used, charges.
 *
 * ## Why the margin figure is called a contribution
 *
 * `receivedMinor - acuChargedMinor` is not profit and must not be labelled as
 * one. It ignores the provider's own time, which is the largest cost in a bid
 * support business by a wide margin, and a screen that called it profit would
 * be telling a provider they made £1,420 on a pack that took them three days.
 * Contribution is the honest name for what it is: what the fee left after the
 * AI it took to produce.
 *
 * ## Why the ACU figure is not re-derived
 *
 * It is the charge already settled on each `AIExecution` record — the same
 * number the wallet moved. Recomputing it from tokens and a multiplier would
 * produce a second figure that disagrees with the wallet whenever the
 * multiplier changes, and the one somebody would believe is whichever screen
 * they opened.
 */
export function engagementStatement(
  ctx: EngineContext,
  engagementId: string,
  period: { from?: string; to?: string } = {},
): EngagementStatement {
  requireModuleReadable(ctx.grantedModules, ctx.heldModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const engagement = engagementsOf(ctx).find((entry) => entry.id === engagementId);
  if (!engagement) {
    throw new DomainError('BID_ON_ENGAGEMENT_NOT_FOUND', `No engagement ${engagementId}`, 404);
  }
  const customer = requireVisibleCustomer(ctx, engagement.customerAccountId);

  const from = (period.from ?? engagement.openedAt).slice(0, 10);
  const to = (period.to ?? new Date().toISOString()).slice(0, 10);
  const within = (day: string): boolean => {
    const date = day.slice(0, 10);
    return date >= from && date <= to;
  };

  const invoices = invoicesOf(ctx).filter((entry) => entry.engagementId === engagement.id);
  const lines: StatementLine[] = [];

  let invoicedMinor = 0;
  let receivedMinor = 0;
  let outstandingMinor = 0;
  let waivedMinor = 0;

  for (const invoice of invoices) {
    if (invoice.status === 'VOID') continue;
    if (within(invoice.issuedAt)) {
      invoicedMinor += invoice.amountMinor;
      lines.push({
        on: invoice.issuedAt.slice(0, 10),
        kind: 'INVOICE',
        reference: invoice.reference,
        narrative: invoice.narrative,
        amountMinor: invoice.amountMinor,
      });
    }
    if (invoice.status === 'PAID' && invoice.paidAt && within(invoice.paidAt)) {
      receivedMinor += invoice.amountMinor;
      lines.push({
        on: invoice.paidAt,
        kind: 'PAYMENT',
        reference: invoice.paymentReference ?? invoice.reference,
        narrative: `Payment against ${invoice.reference}`,
        amountMinor: -invoice.amountMinor,
      });
    }
    if (invoice.status === 'ISSUED') outstandingMinor += invoice.amountMinor;
    if (invoice.status === 'WAIVED') waivedMinor += invoice.amountMinor;
  }

  /*
   * The AI, from the executions attributed to this engagement.
   *
   * Read from `AIExecution` rather than from a Bid-On record, because that is
   * where the settled charge lives and a second copy would be a second answer
   * to "what did this cost". The attribution is the field the Bid Engine sets
   * on every run.
   */
  let acuChargedMinor = 0;
  let acuRuns = 0;
  for (const record of ctx.ledger.listByTenant(ctx.tenantId, 'AIExecution')) {
    const state = record.state as {
      attribution?: { engagementId?: string };
      acuConsumed?: number;
      endedAt?: string;
      taskType?: string;
    };
    if (state.attribution?.engagementId !== engagement.id) continue;
    const on = (state.endedAt ?? '').slice(0, 10);
    if (on && !within(on)) continue;
    acuRuns += 1;
    acuChargedMinor += Number(state.acuConsumed ?? 0);
    lines.push({
      on: on || from,
      kind: 'AI_RUN',
      reference: String(state.taskType ?? 'agent run'),
      narrative: 'Agent run on this engagement',
      amountMinor: 0,
    });
  }

  // What was delivered in the period, from the records rather than a counter.
  const bids = bidsOf(ctx).filter((bid) => bid.engagementId === engagement.id);
  const work = {
    bidsStarted: bids.filter((bid) => within(bid.createdAt)).length,
    packsExported: bids.filter((bid) => bid.exportedAt && within(bid.exportedAt)).length,
    answersApproved: bids.reduce(
      (sum, bid) =>
        sum +
        bid.answers.filter((answer) => answer.status === 'APPROVED' && answer.reviewedAt && within(answer.reviewedAt))
          .length,
      0,
    ),
    stagesSignedOff: engagement.stages.filter(
      (stage) => stage.signedOffAt && within(stage.signedOffAt),
    ).length,
  };

  lines.sort((a, b) => a.on.localeCompare(b.on) || a.kind.localeCompare(b.kind));

  const limits: string[] = [
    // Said on every statement. A statement that looked reconciled while nothing
    // had been reconciled is the kind of wrong about money that stops a
    // provider trusting the tool.
    'No money has moved. An invoice here is a record of what is owed and a payment is somebody recording that it ' +
      'arrived; the payment gateway is not built.',
    'The contribution figure is the fee less what the AI cost. It is not profit — it ignores the provider’s own ' +
      'time, which is the largest cost in this business.',
  ];
  if (acuRuns === 0) {
    limits.push(
      'No agent run is attributed to this engagement in the period, so the AI cost is nil rather than unknown.',
    );
  }
  const unpaid = invoices.filter((entry) => entry.status === 'ISSUED' && entry.dueOn && entry.dueOn < to);
  if (unpaid.length > 0) {
    limits.push(
      `${unpaid.length} invoice(s) are past their due date: ${unpaid.map((entry) => entry.reference).join(', ')}.`,
    );
  }

  return {
    engagementId: engagement.id,
    reference: engagement.reference,
    customer: { id: customer.id, legalName: customer.legalName },
    period: { from, to },
    work,
    invoicedMinor,
    receivedMinor,
    outstandingMinor,
    waivedMinor,
    acuChargedMinor,
    acuRuns,
    contributionMinor: receivedMinor - acuChargedMinor,
    lines,
    limits,
    summary:
      `${engagement.reference} · ${from} to ${to}: ${work.bidsStarted} bid(s) started, ${work.packsExported} pack(s) ` +
      `exported, ${work.answersApproved} answer(s) approved. Invoiced ${invoicedMinor}, received ${receivedMinor}, ` +
      `${outstandingMinor} outstanding. ${acuRuns} agent run(s) costing ${acuChargedMinor}.`,
  };
}

export type InvoiceRegister = {
  invoices: Array<BidOnInvoice & { customerName: string; engagementReference: string; overdue: boolean }>;
  outstandingMinor: number;
  limits: string[];
  summary: string;
};

/** Every invoice for a customer this person may see. */
export function invoiceRegister(ctx: EngineContext, asAt?: string): InvoiceRegister {
  requireModuleReadable(ctx.grantedModules, ctx.heldModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const day = (asAt ?? new Date().toISOString()).slice(0, 10);
  const customers = new Map(customersOf(ctx).map((entry) => [entry.id, entry]));
  const engagements = new Map(engagementsOf(ctx).map((entry) => [entry.id, entry]));

  const visible = invoicesOf(ctx).filter((invoice) => {
    const customer = customers.get(invoice.customerAccountId);
    if (!customer) return false;
    return (
      customer.guests.some((guest) => guest.actorId === ctx.auth.actorId) ||
      customer.assignedStaff.includes(ctx.auth.actorId) ||
      customer.openedBy === ctx.auth.actorId
    );
  });

  const invoices = visible
    .map((invoice) => ({
      ...invoice,
      customerName: customers.get(invoice.customerAccountId)?.legalName ?? '—',
      engagementReference: engagements.get(invoice.engagementId)?.reference ?? '—',
      overdue: invoice.status === 'ISSUED' && Boolean(invoice.dueOn && invoice.dueOn < day),
    }))
    .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));

  const outstandingMinor = invoices
    .filter((invoice) => invoice.status === 'ISSUED')
    .reduce((sum, invoice) => sum + invoice.amountMinor, 0);

  const limits: string[] = [
    'No money has moved. The payment gateway is not built, so a paid invoice here is somebody recording that it was ' +
      'paid.',
  ];
  const blocked = engagementsOf(ctx).filter(
    (engagement) => engagement.status === 'ACTIVE' && !depositStanding(engagement, visible).funded,
  );
  if (blocked.length > 0) {
    limits.push(
      `${blocked.length} engagement(s) cannot start an agent run until their deposit is settled: ` +
        `${blocked.map((engagement) => engagement.reference).join(', ')}. A person can still work on them.`,
    );
  }

  return {
    invoices,
    outstandingMinor,
    limits,
    summary:
      invoices.length === 0
        ? 'Nothing invoiced yet. A deposit is issued when an engagement is activated, where its terms include one.'
        : `${invoices.filter((invoice) => invoice.status === 'ISSUED').length} outstanding of ${invoices.length} ` +
          `issued, ${invoices.filter((invoice) => invoice.overdue).length} past due.`,
  };
}
