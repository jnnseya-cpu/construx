import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { authorise, write, type EngineContext } from '../../engines/context.ts';
import type { AuthContext } from '../../identity/auth.ts';
import { requireModule } from '../../identity/modules.ts';
import type { Platform } from '../../platform.ts';
import { appointmentInForce } from './appointment.ts';
import { changePosition } from './change.ts';
import { commercialPosition, type Valuation } from './commercial.ts';

/**
 * §13 Commercial, the two questions it could not answer, and the executive
 * roll-up across projects.
 *
 * **Paid, accrual and cash.** §10 certifies value and names who owes it. This
 * records what has actually been paid against a certificate — the bank's own
 * reference as the idempotency key, never more than was certified — and reads
 * back the three numbers a commercial manager keeps apart: earned (accepted
 * work), certified (what a certificate says is owed), paid (what has arrived).
 * Accrual is earned above certified; outstanding is certified above paid. They
 * are different numbers on purpose, and this never adds them together.
 *
 * **Contingency and estimate at completion.** A site-services contingency pot
 * is set once with its basis and drawn against with a reason. The EAC is
 * arithmetic over records that already exist — commitment, agreed change at
 * face, unagreed change at risk-adjusted value — plus the pot, and every term
 * is published beside the total so the number can be argued with.
 *
 * **The roll-up.** Each position is project-scoped by construction. The
 * executive read walks the caller's own tenancy's projects through the same
 * project context every other read uses, so the isolation is the same
 * isolation; a project the caller may not read, or one with nothing appointed,
 * is skipped with the reason rather than silently summed as zero.
 */

export type ValuationPayment = {
  id: string;
  projectId: string;
  valuationId: string;
  amountMinor: number;
  /** The bank's or provider's own reference. Unique for ever. */
  reference: string;
  paidAt: string;
  recordedBy: string;
  recordedAt: string;
  note?: string;
};

export type ContingencyDraw = {
  id: string;
  amountMinor: number;
  reason: string;
  changeId?: string;
  drawnBy: string;
  drawnAt: string;
};

export type Contingency = {
  id: string;
  projectId: string;
  potMinor: number;
  basis: string;
  draws: ContingencyDraw[];
  setBy: string;
  setAt: string;
};

function paymentsOf(ctx: EngineContext): ValuationPayment[] {
  return ctx.ledger.list(ctx.projectId, 'ValuationPayment').map((record) => record.state as unknown as ValuationPayment);
}

function valuationsOf(ctx: EngineContext): Valuation[] {
  return ctx.ledger.list(ctx.projectId, 'Valuation').map((record) => record.state as unknown as Valuation);
}

function contingencyOf(ctx: EngineContext): Contingency | undefined {
  const record = ctx.ledger.get({ refType: 'SiteServicesContingency', refId: `${ctx.projectId}-contingency` });
  return record ? (record.state as unknown as Contingency) : undefined;
}

function major(minor: number): string {
  return `£${(minor / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// --- payments ---------------------------------------------------------------

export function recordPayment(
  ctx: EngineContext,
  input: { valuationId: string; amountMinor: number; reference: string; paidAt?: string; note?: string },
): { payment: ValuationPayment; alreadyRecorded: boolean } {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C', { dataSensitivity: 'COMMERCIAL_L3' });

  const reference = input.reference.trim();
  if (reference.length < 3) {
    throw new DomainError('REFERENCE_REQUIRED', 'The bank’s own reference. It is what stops the same payment being recorded twice.', 422);
  }
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new DomainError('AMOUNT_REQUIRED', 'A payment of nothing is not a payment.', 422);
  }

  const valuation = valuationsOf(ctx).find((entry) => entry.id === input.valuationId);
  if (!valuation) throw new DomainError('VALUATION_NOT_FOUND', `No valuation ${input.valuationId} on this project.`, 404);
  if (valuation.status !== 'CERTIFIED') {
    throw new DomainError(
      'VALUATION_NOT_CERTIFIED',
      `${valuation.reference} is ${valuation.status.toLowerCase()}, not certified. Money against an uncertified valuation is a payment on account with nothing behind it.`,
      409,
    );
  }

  const existing = paymentsOf(ctx).find((entry) => entry.reference === reference);
  if (existing) {
    if (existing.valuationId !== input.valuationId || existing.amountMinor !== input.amountMinor) {
      throw new DomainError(
        'PAYMENT_REFERENCE_CONFLICT',
        `Reference ${reference} is already recorded against a different valuation or amount. One reference identifies one payment.`,
        409,
      );
    }
    return { payment: existing, alreadyRecorded: true };
  }

  const paidSoFar = paymentsOf(ctx)
    .filter((entry) => entry.valuationId === valuation.id)
    .reduce((sum, entry) => sum + entry.amountMinor, 0);
  const certified = valuation.certifiedMinor ?? 0;
  if (paidSoFar + input.amountMinor > certified) {
    throw new DomainError(
      'OVERPAYMENT',
      `${major(paidSoFar + input.amountMinor)} would exceed the ${major(certified)} certified on ${valuation.reference}. A payment above the certificate is a recovery in waiting, and it is refused here rather than recorded and chased later.`,
      422,
    );
  }

  const payment: ValuationPayment = {
    id: ulid(),
    projectId: ctx.projectId,
    valuationId: valuation.id,
    amountMinor: input.amountMinor,
    reference,
    paidAt: input.paidAt ?? new Date().toISOString().slice(0, 10),
    recordedBy: ctx.auth.actorId,
    recordedAt: new Date().toISOString(),
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
  };
  write(ctx, {
    eventType: 'SERVICE_PAYMENT_RECORDED',
    entity: { refType: 'ValuationPayment', refId: payment.id },
    nextState: { ...payment },
  });
  return { payment, alreadyRecorded: false };
}

export type CashPosition = {
  valuations: Array<{
    id: string;
    reference: string;
    status: Valuation['status'];
    payer?: Valuation['payer'];
    certifiedMinor: number;
    paidMinor: number;
    outstandingMinor: number;
    payments: ValuationPayment[];
  }>;
  totals: {
    earnedMinor: number;
    certifiedMinor: number;
    paidMinor: number;
    /** Earned above certified: work accepted that no certificate yet carries. */
    accruedMinor: number;
    /** Certified above paid: what a certificate says is owed and has not arrived. */
    outstandingMinor: number;
    outstandingByPayer: { ETABLIX: number; CUSTOMER: number };
  };
  statement: string;
};

export function cashPosition(ctx: EngineContext): CashPosition {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const commercial = commercialPosition(ctx);
  const payments = paymentsOf(ctx);
  const valuations = valuationsOf(ctx).map((valuation) => {
    const own = payments.filter((entry) => entry.valuationId === valuation.id);
    const paidMinor = own.reduce((sum, entry) => sum + entry.amountMinor, 0);
    const certifiedMinor = valuation.status === 'CERTIFIED' ? (valuation.certifiedMinor ?? 0) : 0;
    return {
      id: valuation.id,
      reference: valuation.reference,
      status: valuation.status,
      ...(valuation.payer ? { payer: valuation.payer } : {}),
      certifiedMinor,
      paidMinor,
      outstandingMinor: Math.max(0, certifiedMinor - paidMinor),
      payments: own,
    };
  });

  const certifiedMinor = commercial.totals.certifiedMinor;
  const paidMinor = valuations.reduce((sum, entry) => sum + entry.paidMinor, 0);
  const outstandingByPayer = { ETABLIX: 0, CUSTOMER: 0 };
  for (const entry of valuations) {
    if (entry.payer) outstandingByPayer[entry.payer] += entry.outstandingMinor;
  }
  const totals = {
    earnedMinor: commercial.totals.earnedMinor,
    certifiedMinor,
    paidMinor,
    accruedMinor: Math.max(0, commercial.totals.earnedMinor - certifiedMinor),
    outstandingMinor: Math.max(0, certifiedMinor - paidMinor),
    outstandingByPayer,
  };

  return {
    valuations,
    totals,
    statement:
      certifiedMinor === 0
        ? 'Nothing is certified, so nothing is owed and nothing can be paid. Earned work with no certificate is accrual, and it is shown as such rather than as cash.'
        : `${major(paidMinor)} paid against ${major(certifiedMinor)} certified, ${major(totals.outstandingMinor)} outstanding` +
          (outstandingByPayer.ETABLIX > 0 ? ` (${major(outstandingByPayer.ETABLIX)} of it ETABLIX’s own liability)` : '') +
          `, and ${major(totals.accruedMinor)} earned and not yet certified. Three numbers, kept apart: an invoice is not proof of value and a certificate is not cash.`,
  };
}

// --- contingency and EAC ------------------------------------------------------

export function setContingency(ctx: EngineContext, input: { potMinor: number; basis: string }): Contingency {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C', { dataSensitivity: 'COMMERCIAL_L3' });
  if (!Number.isInteger(input.potMinor) || input.potMinor < 0) {
    throw new DomainError('POT_REQUIRED', 'The pot is a whole number of pence, and it may be zero but not less.', 422);
  }
  if (!input.basis?.trim() || input.basis.trim().length < 10) {
    throw new DomainError('BASIS_REQUIRED', 'Say what the pot is sized against. A contingency with no basis is a number somebody liked.', 422);
  }

  const existing = contingencyOf(ctx);
  const drawn = (existing?.draws ?? []).reduce((sum, entry) => sum + entry.amountMinor, 0);
  if (input.potMinor < drawn) {
    throw new DomainError(
      'POT_BELOW_DRAWS',
      `${major(drawn)} has already been drawn; the pot cannot be set below what has left it.`,
      422,
    );
  }

  const contingency: Contingency = {
    id: `${ctx.projectId}-contingency`,
    projectId: ctx.projectId,
    potMinor: input.potMinor,
    basis: input.basis.trim(),
    draws: existing?.draws ?? [],
    setBy: ctx.auth.actorId,
    setAt: new Date().toISOString(),
  };
  write(ctx, {
    eventType: existing ? 'SERVICE_CONTINGENCY_RESET' : 'SERVICE_CONTINGENCY_SET',
    entity: { refType: 'SiteServicesContingency', refId: contingency.id },
    nextState: { ...contingency },
  });
  return contingency;
}

export function drawContingency(
  ctx: EngineContext,
  input: { amountMinor: number; reason: string; changeId?: string },
): Contingency {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C', { dataSensitivity: 'COMMERCIAL_L3' });
  const existing = contingencyOf(ctx);
  if (!existing) throw new DomainError('NO_CONTINGENCY', 'No contingency pot is set on this project, so there is nothing to draw from.', 404);
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new DomainError('AMOUNT_REQUIRED', 'A draw of nothing is not a draw.', 422);
  }
  if (!input.reason?.trim() || input.reason.trim().length < 10) {
    throw new DomainError('REASON_REQUIRED', 'Say what the draw pays for. Contingency spent for no stated reason is the pot that is never there when it is needed.', 422);
  }
  const drawn = existing.draws.reduce((sum, entry) => sum + entry.amountMinor, 0);
  if (drawn + input.amountMinor > existing.potMinor) {
    throw new DomainError(
      'CONTINGENCY_EXHAUSTED',
      `${major(existing.potMinor - drawn)} remains of the ${major(existing.potMinor)} pot; ${major(input.amountMinor)} cannot be drawn. Raise the pot with its basis, or raise a change.`,
      422,
    );
  }
  if (input.changeId) {
    const change = ctx.ledger.get({ refType: 'ServiceChange', refId: input.changeId });
    if (!change || change.projectId !== ctx.projectId) {
      throw new DomainError('CHANGE_NOT_FOUND', `No change ${input.changeId} on this project.`, 404);
    }
  }

  const updated: Contingency = {
    ...existing,
    draws: [
      ...existing.draws,
      {
        id: ulid(),
        amountMinor: input.amountMinor,
        reason: input.reason.trim(),
        ...(input.changeId ? { changeId: input.changeId } : {}),
        drawnBy: ctx.auth.actorId,
        drawnAt: new Date().toISOString(),
      },
    ],
  };
  write(ctx, {
    eventType: 'SERVICE_CONTINGENCY_DRAWN',
    entity: { refType: 'SiteServicesContingency', refId: updated.id },
    nextState: { ...updated },
  });
  return updated;
}

export type EstimateAtCompletion = {
  budgetMinor: number;
  commitmentMinor: number;
  earnedMinor: number;
  certifiedMinor: number;
  /** Agreed change, at face value: certain, and in the forecast whole. */
  agreedChangeMinor: number;
  /** Unagreed change at value times probability. Never zero while a change is open. */
  exposureMinor: number;
  contingency?: Contingency;
  contingencyPotMinor: number;
  contingencyDrawnMinor: number;
  contingencyRemainingMinor: number;
  /** Commitment or earned, whichever is higher, plus agreed change, plus exposure. */
  eacMinor: number;
  /** Budget plus pot, less the EAC. Negative is the overrun. */
  headroomMinor: number;
  terms: Array<{ term: string; amountMinor: number; basis: string }>;
  statement: string;
};

export function estimateAtCompletion(ctx: EngineContext, today?: string): EstimateAtCompletion {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const commercial = commercialPosition(ctx);
  const change = changePosition(ctx, today);
  const contingency = contingencyOf(ctx);
  const drawn = (contingency?.draws ?? []).reduce((sum, entry) => sum + entry.amountMinor, 0);
  const pot = contingency?.potMinor ?? 0;

  const base = Math.max(commercial.totals.commitmentMinor, commercial.totals.earnedMinor);
  const eacMinor = base + change.agreedMinor + change.exposureMinor;
  const headroomMinor = commercial.totals.budgetMinor + pot - eacMinor;

  const terms = [
    {
      term: commercial.totals.earnedMinor > commercial.totals.commitmentMinor ? 'Earned' : 'Committed',
      amountMinor: base,
      basis:
        commercial.totals.earnedMinor > commercial.totals.commitmentMinor
          ? 'Accepted work already exceeds the commitment, so the higher figure is the floor of the outturn.'
          : 'Executed contracts and orders across every line. Work not yet done is still owed.',
    },
    { term: 'Agreed change', amountMinor: change.agreedMinor, basis: 'Changes agreed under the contract, at face value.' },
    {
      term: 'Unagreed change, risk-adjusted',
      amountMinor: change.exposureMinor,
      basis: `${major(change.exposureAtFaceMinor)} at face, carried at value times probability. The golden rule: nothing open is zero.`,
    },
  ];

  return {
    budgetMinor: commercial.totals.budgetMinor,
    commitmentMinor: commercial.totals.commitmentMinor,
    earnedMinor: commercial.totals.earnedMinor,
    certifiedMinor: commercial.totals.certifiedMinor,
    agreedChangeMinor: change.agreedMinor,
    exposureMinor: change.exposureMinor,
    ...(contingency ? { contingency } : {}),
    contingencyPotMinor: pot,
    contingencyDrawnMinor: drawn,
    contingencyRemainingMinor: pot - drawn,
    eacMinor,
    headroomMinor,
    terms,
    statement:
      commercial.lines.length === 0
        ? 'No contract line is open, so there is no commitment to forecast from. An EAC over nothing is a budget restated.'
        : headroomMinor < 0
          ? `Estimate at completion ${major(eacMinor)} against ${major(commercial.totals.budgetMinor)} budget and ${major(pot)} contingency: ${major(-headroomMinor)} over, with ${major(pot - drawn)} of the pot still undrawn. The overrun is in the forecast now, not at the final account.`
          : `Estimate at completion ${major(eacMinor)} against ${major(commercial.totals.budgetMinor)} budget and ${major(pot)} contingency, ${major(headroomMinor)} headroom, ${major(pot - drawn)} of the pot undrawn.` +
            (contingency ? '' : ' No contingency pot is set: the headroom is the budget’s alone.'),
  };
}

// --- the roll-up -------------------------------------------------------------

export type PortfolioProject = {
  projectId: string;
  name: string;
  budgetMinor: number;
  commitmentMinor: number;
  earnedMinor: number;
  certifiedMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  eacMinor: number;
  headroomMinor: number;
  openChanges: number;
};

export type PortfolioRollUp = {
  projects: PortfolioProject[];
  totals: Omit<PortfolioProject, 'projectId' | 'name'>;
  skipped: Array<{ projectId: string; name: string; because: string }>;
  statement: string;
};

/**
 * Every project of the caller's own tenancy, through the same project context
 * every other read uses. A project the caller may not read is skipped with
 * the refusal named, never summed as zero.
 */
export function portfolioRollUp(platform: Platform, auth: AuthContext, today?: string): PortfolioRollUp {
  const projects: PortfolioProject[] = [];
  const skipped: PortfolioRollUp['skipped'] = [];

  for (const record of platform.ledger.listByTenant(auth.tenantId, 'Project')) {
    const projectId = String(record.state.id ?? record.refId);
    const name = String(record.state.name ?? projectId);
    try {
      const ctx = platform.context(auth, projectId, { source: 'WEB' });
      if (appointmentInForce(ctx) === undefined) {
        skipped.push({ projectId, name, because: 'SITE_SERVICES_NOT_APPOINTED: nothing is appointed on this project' });
        continue;
      }
      const commercial = commercialPosition(ctx);
      const cash = cashPosition(ctx);
      const eac = estimateAtCompletion(ctx, today);
      const change = changePosition(ctx, today);
      projects.push({
        projectId,
        name,
        budgetMinor: commercial.totals.budgetMinor,
        commitmentMinor: commercial.totals.commitmentMinor,
        earnedMinor: commercial.totals.earnedMinor,
        certifiedMinor: commercial.totals.certifiedMinor,
        paidMinor: cash.totals.paidMinor,
        outstandingMinor: cash.totals.outstandingMinor,
        eacMinor: eac.eacMinor,
        headroomMinor: eac.headroomMinor,
        openChanges: change.changes.filter((entry) => entry.noticeOutstanding || entry.exposureMinor > 0).length,
      });
    } catch (error) {
      const because = error instanceof DomainError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
      skipped.push({ projectId, name, because });
    }
  }

  const sum = (key: keyof Omit<PortfolioProject, 'projectId' | 'name'>) => projects.reduce((total, entry) => total + entry[key], 0);
  const totals = {
    budgetMinor: sum('budgetMinor'),
    commitmentMinor: sum('commitmentMinor'),
    earnedMinor: sum('earnedMinor'),
    certifiedMinor: sum('certifiedMinor'),
    paidMinor: sum('paidMinor'),
    outstandingMinor: sum('outstandingMinor'),
    eacMinor: sum('eacMinor'),
    headroomMinor: sum('headroomMinor'),
    openChanges: sum('openChanges'),
  };

  return {
    projects,
    totals,
    skipped,
    statement:
      projects.length === 0
        ? `No project of this company carries a readable site-services position${skipped.length > 0 ? ` (${skipped.length} skipped, each with its reason)` : ''}.`
        : `${projects.length} project${projects.length === 1 ? '' : 's'}: ${major(totals.eacMinor)} estimate at completion against ${major(totals.budgetMinor)} budget, ${major(totals.outstandingMinor)} certified and unpaid, ${totals.openChanges} change${totals.openChanges === 1 ? '' : 's'} open.` +
          (skipped.length > 0 ? ` ${skipped.length} project${skipped.length === 1 ? '' : 's'} skipped, each with its reason.` : ''),
  };
}
