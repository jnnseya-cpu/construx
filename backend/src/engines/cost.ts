import { hashEvidence } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { formatRef, ulid } from '../core/ids.ts';
import { assertNotFuture } from '../domain/dates.ts';
import { authorise, currentPhase, registerEvidence, runAI, write, type EngineContext } from './context.ts';
import { calculateCVR, calculateEVM, sCurveDistribution, type CVRInput } from './maths/evm.ts';
import { checkNoticeCompliance, generatePaymentCycle, type PaymentTerms } from './maths/claims.ts';
import {
  assessPaymentTerms,
  compliancePosition,
  DEFAULT_CALENDAR,
  type BusinessCalendar,
  type CompliancePosition,
  type CycleInput,
  type TermsFinding,
} from './maths/constructionAct.ts';

/**
 * Engine C — Resource & Cost Intelligence.
 *
 * Cost control here is forward-looking. Budget, commitments, actuals, accruals
 * and progress are all on the same spine, so the forecast final cost moves the
 * moment reality does rather than at month end.
 */

export function approveBudget(
  ctx: EngineContext,
  input: {
    version: string;
    byCostCode: Array<{ costCode: string; description: string; budgetMinor: number }>;
    contingencyMinor: number;
    managementReserveMinor: number;
    tenderMarginPercent: number;
  },
): { budgetId: string; totalMinor: number } {
  authorise(ctx, 'BUDGET_COST', 'A', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const directTotal = input.byCostCode.reduce((s, c) => s + c.budgetMinor, 0);
  const total = directTotal + input.contingencyMinor + input.managementReserveMinor;
  const budgetId = ulid();

  const evidence = registerEvidence(ctx, {
    type: 'BUDGET_BASELINE_AUTHORITY',
    hash: hashEvidence(JSON.stringify(input)),
    description: `Cost baseline ${input.version} approved by ${ctx.auth.actorId}`,
  });

  write(ctx, {
    eventType: 'BUDGET_BASELINE_APPROVED',
    entity: { refType: 'Budget', refId: budgetId },
    nextState: {
      id: budgetId,
      projectId: ctx.projectId,
      version: input.version,
      status: 'APPROVED',
      byCostCode: input.byCostCode,
      directTotalMinor: directTotal,
      contingencyMinor: input.contingencyMinor,
      managementReserveMinor: input.managementReserveMinor,
      totalMinor: total,
      tenderMarginPercent: input.tenderMarginPercent,
      approvedAt: new Date().toISOString(),
      approvedBy: ctx.auth.actorId,
    },
    evidenceRefs: [evidence],
  });

  return { budgetId, totalMinor: total };
}

export function postActualCost(
  ctx: EngineContext,
  input: { costCode: string; amountMinor: number; date: string; sourceSystem: string; description: string },
): string {
  authorise(ctx, 'BUDGET_COST', 'C', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const id = ulid();
  write(ctx, {
    eventType: 'ACTUAL_COST_POSTED',
    entity: { refType: 'ActualCost', refId: id },
    nextState: {
      id,
      projectId: ctx.projectId,
      costCode: input.costCode,
      amountMinor: input.amountMinor,
      date: input.date,
      sourceSystem: input.sourceSystem,
      description: input.description,
      postedAt: new Date().toISOString(),
    },
  });
  return id;
}

/**
 * Earned value snapshot. Planned value comes from the baseline, earned value
 * from measured progress, actual cost from postings — three independent
 * sources, which is what makes the variance meaningful.
 */
export function takeEVMSnapshot(
  ctx: EngineContext,
  input: { period: string; plannedValueMinor: number },
): { snapshotId: string; snapshot: ReturnType<typeof calculateEVM> } {
  authorise(ctx, 'BUDGET_COST', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const budgets = ctx.ledger.list(ctx.projectId, 'Budget').filter((b) => b.state.status === 'APPROVED');
  const budget = budgets[budgets.length - 1];
  if (!budget) throw new DomainError('NO_APPROVED_BUDGET', 'An approved cost baseline is required before earned value');

  const budgetAtCompletion = Number(budget.state.totalMinor);
  const actualCost = ctx.ledger
    .list(ctx.projectId, 'ActualCost')
    .reduce((sum, record) => sum + Number(record.state.amountMinor), 0);

  const tasks = ctx.ledger.list(ctx.projectId, 'Task');
  const totalDuration = tasks.reduce((s, t) => s + Number(t.state.durationDays), 0);
  const earnedDuration = tasks.reduce(
    (s, t) => s + Number(t.state.durationDays) * (Number(t.state.percentComplete ?? 0) / 100),
    0,
  );
  const physicalPercent = totalDuration === 0 ? 0 : earnedDuration / totalDuration;
  const earnedValue = Math.round(budgetAtCompletion * physicalPercent);

  // Coverage: the share of tasks that actually carry a measurement. A forecast
  // built on a handful of measured tasks is reported as low confidence.
  const measuredTasks = tasks.filter((t) => Number(t.state.percentComplete ?? 0) > 0).length;
  const coverage = tasks.length === 0 ? 0 : measuredTasks / tasks.length;

  const snapshot = calculateEVM(
    {
      plannedValueMinor: input.plannedValueMinor,
      earnedValueMinor: earnedValue,
      actualCostMinor: actualCost,
      budgetAtCompletionMinor: budgetAtCompletion,
    },
    coverage,
  );

  const snapshotId = ulid();
  write(ctx, {
    eventType: 'EVM_SNAPSHOT_TAKEN',
    entity: { refType: 'EarnedValueSnapshot', refId: snapshotId },
    nextState: {
      id: snapshotId,
      projectId: ctx.projectId,
      period: input.period,
      physicalPercentComplete: Number((physicalPercent * 100).toFixed(2)),
      ...snapshot,
      takenAt: new Date().toISOString(),
    },
  });

  return { snapshotId, snapshot };
}

/**
 * Live cost value reconciliation. Connected to contract value, commitments,
 * variations, certified payments and the purchase ledger — the single number
 * that tells a commercial manager whether the job is making money.
 */
export async function publishCVR(
  ctx: EngineContext,
  input: { period: string; costToCompleteMinor: number; accrualsMinor: number },
): Promise<{ cvrId: string; cvr: ReturnType<typeof calculateCVR>; acuConsumed: number }> {
  authorise(ctx, 'BUDGET_COST', 'X', { dataSensitivity: 'COMMERCIAL_L3' });

  const contracts = ctx.ledger.list(ctx.projectId, 'Contract').filter((c) => c.state.status === 'EXECUTED');
  const contract = contracts[0];
  if (!contract) throw new DomainError('NO_EXECUTED_CONTRACT', 'A CVR requires an executed contract');

  const variations = ctx.ledger.list(ctx.projectId, 'Variation');
  const approvedVariations = variations
    .filter((v) => v.state.status === 'AGREED')
    .reduce((s, v) => s + Number(v.state.valuedAmountMinor ?? 0), 0);
  const unapprovedVariations = variations
    .filter((v) => v.state.status !== 'AGREED' && v.state.status !== 'REJECTED')
    .reduce((s, v) => s + Number(v.state.valuedAmountMinor ?? 0), 0);

  const certified = ctx.ledger
    .list(ctx.projectId, 'PaymentCertificate')
    .reduce((s, c) => s + Number(c.state.certifiedMinor ?? 0), 0);
  const commitments = ctx.ledger
    .list(ctx.projectId, 'Commitment')
    .reduce((s, c) => s + Number(c.state.valueMinor ?? 0), 0);
  const costToDate = ctx.ledger
    .list(ctx.projectId, 'ActualCost')
    .reduce((s, c) => s + Number(c.state.amountMinor), 0);

  const budgets = ctx.ledger.list(ctx.projectId, 'Budget').filter((b) => b.state.status === 'APPROVED');
  const tenderMargin = Number(budgets[budgets.length - 1]?.state.tenderMarginPercent ?? 0);

  const cvrInput: CVRInput = {
    contractValueMinor: Number(contract.state.contractSumMinor ?? 0),
    approvedVariationsMinor: approvedVariations,
    unapprovedVariationsMinor: unapprovedVariations,
    certifiedToDateMinor: certified,
    commitmentsMinor: commitments,
    costToDateMinor: costToDate,
    accrualsMinor: input.accrualsMinor,
    costToCompleteMinor: input.costToCompleteMinor,
  };

  // Completeness: how many of the CVR's inputs are actually populated. A CVR
  // built from two of eight sources should not be presented with confidence.
  const populated = Object.values(cvrInput).filter((v) => v !== 0).length;
  const completeness = populated / Object.keys(cvrInput).length;

  const cvr = calculateCVR(cvrInput, tenderMargin, completeness);
  const cvrId = ulid();

  const result = await runAI(ctx, {
    engine: 'RESOURCE_COST',
    taskType: 'cvr_analysis',
    capability: 'REASONING',
    inputRefs: [{ refType: 'Contract', refId: contract.refId }],
    request: {
      task: 'Explain margin movement and identify the commercial actions that would recover it',
      payload: { cvr, period: input.period },
    },
    toWrites: (output) => [
      {
        eventType: 'CVR_PUBLISHED',
        entity: { refType: 'CVR', refId: cvrId },
        nextState: {
          ...cvr,
          id: cvrId,
          projectId: ctx.projectId,
          // The contract the margin was computed against. It was known here and
          // never written down, so a published CVR could not name the contract
          // sum it started from — and `consistencyReport` reads the *latest*
          // executed contract where this reads the *first*, so on a project with
          // a supplemental agreement the two were not necessarily the same one.
          contractId: contract.refId,
          period: input.period,
          narrative: String(output.narrative ?? ''),
          publishedAt: new Date().toISOString(),
        },
      },
    ],
  });

  return { cvrId, cvr, acuConsumed: result.acuConsumed };
}

/** Cashflow forecast on an S-curve, adjusted for payment terms. */
export function forecastCashflow(
  ctx: EngineContext,
  input: { totalValueMinor: number; periods: number; paymentLagDays: number; retentionPercent: number },
): { forecastId: string; periodValues: number[]; retentionHeldMinor: number } {
  authorise(ctx, 'BUDGET_COST', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const gross = sCurveDistribution(input.totalValueMinor, input.periods);
  const retentionHeld = Math.round(input.totalValueMinor * (input.retentionPercent / 100));
  const netByPeriod = gross.map((value) => value - Math.round(value * (input.retentionPercent / 100)));

  const forecastId = ulid();
  write(ctx, {
    eventType: 'CASHFLOW_FORECAST_UPDATED',
    entity: { refType: 'CashflowForecast', refId: forecastId },
    nextState: {
      id: forecastId,
      projectId: ctx.projectId,
      curve: 'S_CURVE',
      periods: input.periods,
      grossByPeriod: gross,
      netByPeriod,
      paymentLagDays: input.paymentLagDays,
      retentionPercent: input.retentionPercent,
      retentionHeldMinor: retentionHeld,
      totalValueMinor: input.totalValueMinor,
      forecastAt: new Date().toISOString(),
    },
  });

  return { forecastId, periodValues: netByPeriod, retentionHeldMinor: retentionHeld };
}

/**
 * Payment cycle engine. Statutory notice dates are generated up front for the
 * whole contract, upstream and downstream, because a missed pay-less notice is
 * a cash loss that no amount of later argument recovers.
 */
export function generatePaymentSchedule(
  ctx: EngineContext,
  input: { contractId: string; startDate: string; cycles: number; terms: PaymentTerms; direction: 'UPSTREAM' | 'DOWNSTREAM' },
): { cycleId: string; periods: ReturnType<typeof generatePaymentCycle> } {
  authorise(ctx, 'PAYMENT_APPLICATIONS', 'C', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const periods = generatePaymentCycle(input.startDate, input.cycles, input.terms);
  const cycleId = ulid();

  write(ctx, {
    eventType: 'PAYMENT_CYCLE_GENERATED',
    entity: { refType: 'PaymentCycle', refId: cycleId },
    nextState: {
      id: cycleId,
      projectId: ctx.projectId,
      contractId: input.contractId,
      direction: input.direction,
      terms: input.terms,
      periods,
      generatedAt: new Date().toISOString(),
    },
  });

  return { cycleId, periods };
}

export function submitApplication(
  ctx: EngineContext,
  input: {
    cycleId: string;
    cycleNumber: number;
    grossValuationMinor: number;
    variationsIncludedMinor: number;
    previouslyCertifiedMinor: number;
    retentionMinor: number;
    supportingEvidenceHash: string;
  },
): { applicationId: string; netAppliedMinor: number } {
  authorise(ctx, 'PAYMENT_APPLICATIONS', 'C', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const cycle = ctx.ledger.require({ refType: 'PaymentCycle', refId: input.cycleId });
  const periods = cycle.state.periods as ReturnType<typeof generatePaymentCycle>;
  const period = periods.find((p) => p.cycleNumber === input.cycleNumber);
  if (!period) throw new DomainError('PAYMENT_PERIOD_NOT_FOUND', `Cycle ${input.cycleNumber} is not in this schedule`);

  const netApplied =
    input.grossValuationMinor + input.variationsIncludedMinor - input.previouslyCertifiedMinor - input.retentionMinor;

  const evidence = registerEvidence(ctx, {
    type: 'PAYMENT_APPLICATION_SUPPORT',
    hash: input.supportingEvidenceHash,
    description: `Supporting valuation for application ${input.cycleNumber}`,
  });

  const applicationId = ulid();
  write(ctx, {
    eventType: 'APPLICATION_SUBMITTED',
    entity: { refType: 'PaymentApplication', refId: applicationId },
    nextState: {
      id: applicationId,
      projectId: ctx.projectId,
      cycleId: input.cycleId,
      cycleNumber: input.cycleNumber,
      period,
      grossValuationMinor: input.grossValuationMinor,
      variationsIncludedMinor: input.variationsIncludedMinor,
      previouslyCertifiedMinor: input.previouslyCertifiedMinor,
      retentionMinor: input.retentionMinor,
      netAppliedMinor: netApplied,
      status: 'SUBMITTED',
      submittedAt: new Date().toISOString(),
      submittedBy: ctx.auth.actorId,
    },
    evidenceRefs: [evidence],
  });

  return { applicationId, netAppliedMinor: netApplied };
}

/**
 * Certify an application, with the payment notice the certification depends on.
 *
 * Certification is the point where a valuation becomes a debt, so it is an
 * approval rather than an update, it carries the certificate evidence, and it
 * is separated from whoever submitted the application. The payment notice is
 * written in the same command because a certificate without the notice that
 * carries it is what statutory payment disputes are made of.
 */
export function certifyApplication(
  ctx: EngineContext,
  input: {
    applicationId: string;
    certifiedMinor: number;
    retentionMinor: number;
    issuedDate: string;
    certificateHash: string;
    reason?: string;
  },
): { certificateId: string; certifiedMinor: number; withheldMinor: number } {
  authorise(ctx, 'PAYMENT_APPLICATIONS', 'A', { dataSensitivity: 'COMMERCIAL_L3' });

  const application = ctx.ledger.require({ refType: 'PaymentApplication', refId: input.applicationId });
  if (application.state.status !== 'SUBMITTED') {
    throw new DomainError('APPLICATION_NOT_SUBMITTED', 'Only a submitted application can be certified');
  }

  // The separation this function's own comment has always claimed, now enforced.
  //
  // It was not. The application recorded `submittedBy` and certification never
  // looked at it, so one identity holding both QS and OWNER could apply for a
  // payment and certify it — turning a valuation into a debt with nobody else
  // in the loop. The permission matrix does not close this: separation between
  // *roles* is not separation between *people*, and a small business stacks
  // roles on one person as a matter of course.
  //
  // A hard refusal rather than a disclosed override, matching
  // `REVIEW_SELF_APPROVAL` on design deliverables. That is the platform's
  // settled convention for separation of duties, and money is not the place to
  // start softening it: an override would be taken every time by exactly the
  // person the control exists to stop.
  if (application.state.submittedBy === ctx.auth.actorId) {
    throw new DomainError(
      'CERTIFICATION_SELF_APPROVAL',
      'The person who submitted an application may not certify it. Certification turns a valuation into a debt, ' +
        'and a second party decides. Assign the certificate to another identity with payment authority.',
      409,
    );
  }

  const applied = Number(application.state.netAppliedMinor);
  if (input.certifiedMinor > applied) {
    throw new DomainError(
      'OVERCERTIFICATION',
      'Certifying more than was applied for requires a new application, not a larger certificate',
    );
  }

  const period = application.state.period as { cycleNumber: number; paymentNoticeDeadline: string; finalDateForPayment: string };
  const evidence = registerEvidence(ctx, {
    type: 'PAYMENT_CERTIFICATE',
    hash: input.certificateHash,
    description: `Payment certificate for application ${period.cycleNumber}`,
  });

  const noticeId = ulid();
  write(ctx, {
    eventType: 'PAYMENT_NOTICE_ISSUED',
    entity: { refType: 'PaymentNotice', refId: noticeId },
    nextState: {
      id: noticeId,
      projectId: ctx.projectId,
      applicationId: input.applicationId,
      cycleNumber: period.cycleNumber,
      issuedDate: input.issuedDate,
      noticedSumMinor: input.certifiedMinor,
      deadline: period.paymentNoticeDeadline,
      // Whether this was in time is computed by checkNoticeCompliance rather
      // than asserted here — the record states when, the maths states whether.
    },
    evidenceRefs: [evidence],
  });

  const certificateId = ulid();
  write(ctx, {
    eventType: 'PAYMENT_CERTIFIED',
    entity: { refType: 'PaymentCertificate', refId: certificateId },
    nextState: {
      id: certificateId,
      projectId: ctx.projectId,
      applicationId: input.applicationId,
      noticeId,
      cycleNumber: period.cycleNumber,
      appliedMinor: applied,
      certifiedMinor: input.certifiedMinor,
      retentionMinor: input.retentionMinor,
      withheldMinor: applied - input.certifiedMinor,
      reason: input.reason,
      finalDateForPayment: period.finalDateForPayment,
      certifiedAt: new Date().toISOString(),
      certifiedBy: ctx.auth.actorId,
    },
    evidenceRefs: [evidence],
  });

  write(ctx, {
    eventType: 'APPLICATION_CERTIFIED',
    entity: { refType: 'PaymentApplication', refId: input.applicationId },
    nextState: {
      ...application.state,
      status: 'CERTIFIED',
      certificateId,
      certifiedMinor: input.certifiedMinor,
    },
  });

  return { certificateId, certifiedMinor: input.certifiedMinor, withheldMinor: applied - input.certifiedMinor };
}

/**
 * Post a payment against a certificate. Until this exists the commercial ledger
 * can only report what was certified, and the unpaid-certificate exception —
 * the whole point of the bridge between the QS and finance — never fires.
 */
export function postPayment(
  ctx: EngineContext,
  input: { certificateId: string; amountMinor: number; paidDate: string; reference: string },
): { entryId: string } {
  // The paying party posts the payment, not the party that applied for it —
  // the same separation that keeps certification away from the applicant.
  authorise(ctx, 'PAYMENT_APPLICATIONS', 'A', { dataSensitivity: 'COMMERCIAL_L3' });

  const certificate = ctx.ledger.require({ refType: 'PaymentCertificate', refId: input.certificateId });
  const certified = Number(certificate.state.certifiedMinor);
  const alreadyPaid = ctx.ledger
    .list(ctx.projectId, 'LedgerEntry')
    .filter((e) => e.state.certificateId === input.certificateId && e.state.type === 'PAYMENT')
    .reduce((sum, e) => sum + Number(e.state.amountMinor ?? 0), 0);

  if (alreadyPaid + input.amountMinor > certified) {
    throw new DomainError('OVERPAYMENT', 'Payments against a certificate cannot exceed the certified sum');
  }

  const entryId = ulid();
  write(ctx, {
    eventType: 'LEDGER_ENTRY_POSTED',
    entity: { refType: 'LedgerEntry', refId: entryId },
    nextState: {
      id: entryId,
      projectId: ctx.projectId,
      type: 'PAYMENT',
      certificateId: input.certificateId,
      amountMinor: input.amountMinor,
      paidDate: input.paidDate,
      reference: input.reference,
      postedAt: new Date().toISOString(),
    },
  });

  return { entryId };
}

/** Notice position across a payment cycle — what is overdue and what it costs. */
export function noticePosition(
  ctx: EngineContext,
  cycleId: string,
  today = new Date().toISOString().slice(0, 10),
): Array<{ cycleNumber: number; checks: ReturnType<typeof checkNoticeCompliance> }> {
  authorise(ctx, 'PAYMENT_APPLICATIONS', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const cycle = ctx.ledger.require({ refType: 'PaymentCycle', refId: cycleId });
  const periods = cycle.state.periods as ReturnType<typeof generatePaymentCycle>;

  const noticesByCycle = new Map<number, { paymentNotice?: string; payLessNotice?: string }>();
  for (const record of ctx.ledger.list(ctx.projectId, 'PaymentNotice')) {
    const entry = noticesByCycle.get(Number(record.state.cycleNumber)) ?? {};
    entry.paymentNotice = String(record.state.issuedDate);
    noticesByCycle.set(Number(record.state.cycleNumber), entry);
  }
  for (const record of ctx.ledger.list(ctx.projectId, 'PayLessNotice')) {
    const entry = noticesByCycle.get(Number(record.state.cycleNumber)) ?? {};
    entry.payLessNotice = String(record.state.issuedDate);
    noticesByCycle.set(Number(record.state.cycleNumber), entry);
  }

  return periods.map((period) => ({
    cycleNumber: period.cycleNumber,
    checks: checkNoticeCompliance(period, noticesByCycle.get(period.cycleNumber) ?? {}, today),
  }));
}

/**
 * Issue a pay less notice.
 *
 * This was the hole in the payment cycle. `PAY_LESS_NOTICE_ISSUED` sat in the
 * catalogue and `noticePosition` read the records, so the platform could tell a
 * payer the notice was overdue and give them no way at all to give one — and
 * the pay less notice is the *only* lawful route to paying less than the
 * notified sum. Without it the platform's advice was always "pay in full".
 *
 * Two statutory requirements are enforced rather than described, because a
 * notice that fails either is worth nothing and the payer finds out at
 * adjudication. It must state the sum considered due **and the basis on which
 * that sum is calculated** — a figure alone has repeatedly been held
 * insufficient — and it cannot exceed the notified sum, because a notice
 * paying *more* is not a pay less notice at all.
 *
 * A notice given after the prescribed period is still recorded, and recorded as
 * ineffective. Refusing to write it would destroy the evidence of what was said
 * and when, which is the record needed to argue about it later.
 */
export function issuePayLessNotice(
  ctx: EngineContext,
  input: {
    applicationId: string;
    /** The sum the payer considers due at the date of the notice. */
    sumConsideredDueMinor: number;
    /** The basis of calculation. s.111(4) requires it; a bare figure is not a notice. */
    basis: string;
    issuedDate: string;
    noticeHash: string;
  },
): { noticeId: string; reference: string; inTime: boolean; effective: boolean } {
  // The payer gives this notice, not the applicant — the same separation that
  // keeps certification away from whoever applied.
  authorise(ctx, 'PAYMENT_APPLICATIONS', 'A', { dataSensitivity: 'COMMERCIAL_L3' });

  const application = ctx.ledger.require({ refType: 'PaymentApplication', refId: input.applicationId });
  const period = application.state.period as {
    cycleNumber: number;
    payLessNoticeDeadline: string;
    finalDateForPayment: string;
  };

  if (input.basis.trim().length < 20) {
    throw new DomainError(
      'PAY_LESS_BASIS_REQUIRED',
      'A pay less notice must set out the basis on which the sum is calculated. A figure on its own is not a valid notice under s.111(4).',
    );
  }

  if (input.sumConsideredDueMinor < 0) {
    throw new DomainError('PAY_LESS_SUM_INVALID', 'The sum considered due cannot be negative');
  }

  // The sum the notice is measured against: the payment notice if one was
  // given, otherwise the application, which is what the Act would make the
  // notified sum in its absence.
  const notice = ctx.ledger
    .list(ctx.projectId, 'PaymentNotice')
    .find((record) => record.state.applicationId === input.applicationId);
  const notifiedSum = Number(notice?.state.noticedSumMinor ?? application.state.netAppliedMinor ?? 0);

  if (input.sumConsideredDueMinor > notifiedSum) {
    throw new DomainError(
      'PAY_LESS_EXCEEDS_NOTIFIED_SUM',
      'A pay less notice cannot state a sum above the notified sum. Certify a higher figure instead.',
    );
  }

  const inTime = input.issuedDate <= period.payLessNoticeDeadline;

  const evidence = registerEvidence(ctx, {
    type: 'PAY_LESS_NOTICE',
    hash: input.noticeHash,
    description: `Pay less notice for cycle ${period.cycleNumber}`,
  });

  const sequence = ctx.ledger.list(ctx.projectId, 'PayLessNotice').length + 1;
  const reference = `PLN-${String(sequence).padStart(4, '0')}`;
  const noticeId = ulid();

  write(ctx, {
    eventType: 'PAY_LESS_NOTICE_ISSUED',
    entity: { refType: 'PayLessNotice', refId: noticeId },
    nextState: {
      id: noticeId,
      projectId: ctx.projectId,
      reference,
      applicationId: input.applicationId,
      cycleNumber: period.cycleNumber,
      issuedDate: input.issuedDate,
      deadline: period.payLessNoticeDeadline,
      sumConsideredDueMinor: input.sumConsideredDueMinor,
      notifiedSumMinor: notifiedSum,
      withheldMinor: notifiedSum - input.sumConsideredDueMinor,
      basis: input.basis,
      basisStated: true,
      // Stated on the record because a late notice is not merely late: it has
      // no effect at all, and the payer needs to know that today rather than
      // when the money is demanded.
      inTime,
      effective: inTime,
      issuedBy: ctx.auth.actorId,
    },
    evidenceRefs: [evidence],
  });

  return { noticeId, reference, inTime, effective: inTime };
}

/**
 * The statutory position across a payment cycle: what is payable under the Act
 * rather than what anybody thinks the work was worth.
 *
 * `noticePosition` answers whether a notice was late. This answers the question
 * that follows from it — what that costs — and it is a different number from
 * the valuation in every case where a notice was missed.
 */
export function statutoryPosition(
  ctx: EngineContext,
  cycleId: string,
  today = new Date().toISOString().slice(0, 10),
  calendar: BusinessCalendar = DEFAULT_CALENDAR,
): CompliancePosition & { terms: TermsFinding[] } {
  authorise(ctx, 'PAYMENT_APPLICATIONS', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const cycle = ctx.ledger.require({ refType: 'PaymentCycle', refId: cycleId });
  const terms = cycle.state.terms as PaymentTerms;

  return {
    ...compliancePosition(paymentCycleFacts(ctx.ledger, ctx.projectId, cycleId), today, calendar),
    terms: assessPaymentTerms({
      applicationDayOfMonth: terms.applicationDayOfMonth,
      paymentNoticeDays: terms.paymentNoticeDays,
      payLessNoticeDaysBeforeFinal: terms.payLessNoticeDaysBeforeFinal,
      finalDateDays: terms.finalDateDays,
    }),
  };
}

/**
 * Assemble what the ledger holds about one payment cycle into the facts the
 * statutory maths needs.
 *
 * Separate from `statutoryPosition` and unauthorised on purpose. The morning
 * briefing reads materialised state the same way every other agent does, and
 * having it build these facts for itself would mean two places deciding which
 * notice belongs to which cycle — which is exactly the kind of quiet
 * disagreement that makes two screens report different money.
 */
export function paymentCycleFacts(
  ledger: EngineContext['ledger'],
  projectId: string,
  cycleId: string,
): CycleInput[] {
  const cycle = ledger.require({ refType: 'PaymentCycle', refId: cycleId });
  const periods = cycle.state.periods as ReturnType<typeof generatePaymentCycle>;

  const applications = ledger.list(projectId, 'PaymentApplication').filter((a) => a.state.cycleId === cycleId);
  const notices = ledger.list(projectId, 'PaymentNotice');
  const payLess = ledger.list(projectId, 'PayLessNotice');
  const certificates = ledger.list(projectId, 'PaymentCertificate');
  const entries = ledger.list(projectId, 'LedgerEntry').filter((e) => e.state.type === 'PAYMENT');

  return periods.map((period) => {
    const application = applications.find((a) => Number(a.state.cycleNumber) === period.cycleNumber);
    const notice = notices.find((n) => Number(n.state.cycleNumber) === period.cycleNumber);
    const less = payLess.find((n) => Number(n.state.cycleNumber) === period.cycleNumber);

    const certificateIds = certificates
      .filter((c) => Number(c.state.cycleNumber) === period.cycleNumber)
      .map((c) => c.refId);
    const paid = entries
      .filter((e) => certificateIds.includes(String(e.state.certificateId)))
      .reduce((sum, e) => sum + Number(e.state.amountMinor ?? 0), 0);

    return {
      cycleNumber: period.cycleNumber,
      dueDate: period.dueDate,
      paymentNoticeDeadline: period.paymentNoticeDeadline,
      payLessNoticeDeadline: period.payLessNoticeDeadline,
      finalDateForPayment: period.finalDateForPayment,
      appliedMinor: application ? Number(application.state.netAppliedMinor) : undefined,
      paymentNotice: notice
        ? {
            issuedDate: String(notice.state.issuedDate),
            sumMinor: Number(notice.state.noticedSumMinor),
            basisStated: true,
          }
        : undefined,
      payLessNotice: less
        ? {
            issuedDate: String(less.state.issuedDate),
            sumMinor: Number(less.state.sumConsideredDueMinor),
            basisStated: less.state.basisStated === true,
          }
        : undefined,
      paidMinor: paid,
    };
  });
}

/**
 * Commercial ledger bridge — committed vs certified vs paid, with the exception
 * queue that closes the gap between the QS and finance.
 */
/**
 * Forward cash, read off the live record rather than modelled at bid stage.
 *
 * The commercial centre answered "what will happen next" with a cash-flow model
 * built before the job started. That model is the right thing at tender — peak
 * funding is what closes companies, and it has to be priced before anybody signs
 * — and it is the wrong thing at month nine, when the record knows what has
 * actually been certified and paid and the model still does not.
 *
 * Three rules keep this from becoming a second, quieter bid model.
 *
 * **The run rate is measured, never assumed.** What lands in a future period is
 * the average net certification per completed cycle, taken from certificates
 * that exist. A project with nothing certified yet has no run rate, and the
 * answer says so rather than reaching for the tender figure — a forecast built
 * from the bid, presented as a forecast from the record, is the most misleading
 * thing this could do.
 *
 * **Certified-and-unpaid is not a forecast.** It is money owed on a date the
 * contract already fixed, so it lands on that date at its own value and is
 * reported separately from anything projected.
 *
 * **The low point is the answer.** Peak funding is what the finance director
 * needs, and it is the *worst* cumulative position across the horizon rather
 * than the closing one — a project that ends level having been £2m down in
 * March still had to find £2m in March.
 */
export type ForwardCashflow = {
  /** Whether the record supports a forecast at all. */
  derivable: boolean;
  reason?: string;
  /** Owed on a date the contract already fixed. Not projected. */
  certifiedUnpaidMinor: number;
  /** Measured from completed cycles, not from the tender. */
  measuredFromCycles: number;
  averageNetCertifiedMinor: number;
  /**
   * What goes out, measured the same way as what comes in — or stated as
   * unmeasured, which is the honest answer before the first subcontract
   * certificate. A cumulative line built from inflow alone is a useful number
   * and a dangerous one, so it says which it is.
   */
  outflow: {
    measured: boolean;
    reason?: string;
    /** Certified down the chain and not yet paid — an outgoing debt on a fixed date. */
    certifiedUnpaidMinor: number;
    averagePerPeriodMinor: number;
    measuredFromCertificates: number;
  };
  periods: Array<{
    period: number;
    dueDate: string;
    finalDateForPayment: string;
    /**
     * Fixed where it is already certified, nil where that certificate has been
     * settled early, projected where nothing has been certified at all.
     */
    basis: 'CERTIFIED' | 'SETTLED' | 'PROJECTED';
    inMinor: number;
    outMinor: number;
    netMinor: number;
    cumulativeMinor: number;
  }>;
  /**
   * A run rate cannot keep running past the contract sum. What remains
   * certifiable, and the period at which projecting the run rate would exhaust
   * it — which is itself a finding, because either the rate or the programme is
   * then wrong.
   */
  headroom: {
    known: boolean;
    reason?: string;
    contractValueMinor: number;
    certifiedToDateMinor: number;
    remainingCertifiableMinor: number;
    exhaustsAtPeriod?: number;
  };
  /** The worst cumulative position, which is what has to be funded. */
  lowPointMinor: number;
  lowPointDate?: string;
  closingMinor: number;
  summary: string;
};

export function forwardCashflow(
  ctx: EngineContext,
  today = new Date().toISOString().slice(0, 10),
): ForwardCashflow {
  authorise(ctx, 'BUDGET_COST', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const cycles = ctx.ledger.list(ctx.projectId, 'PaymentCycle');
  const upstream = cycles.filter((cycle) => cycle.state.direction === 'UPSTREAM');
  const downstreamCycleIds = new Set(
    cycles.filter((cycle) => cycle.state.direction === 'DOWNSTREAM').map((cycle) => cycle.refId),
  );

  // Which way a certificate points is a property of the cycle it belongs to, and
  // the only route to it is certificate → application → cycle. A payment entry
  // records no direction of its own, so inferring one from the entry would be
  // inventing a field rather than reading one.
  const applicationCycle = new Map(
    ctx.ledger
      .list(ctx.projectId, 'PaymentApplication')
      .map((application) => [application.refId, String(application.state.cycleId ?? '')]),
  );
  const certificates = ctx.ledger.list(ctx.projectId, 'PaymentCertificate').map((record) => record.state);
  const isDownstream = (certificate: Record<string, unknown>): boolean =>
    downstreamCycleIds.has(applicationCycle.get(String(certificate.applicationId ?? '')) ?? '');

  const entries = ctx.ledger.list(ctx.projectId, 'LedgerEntry').map((record) => record.state);
  const paidCertificateIds = new Set(
    entries.filter((entry) => entry.type === 'PAYMENT').map((entry) => String(entry.certificateId ?? '')),
  );
  const unpaid = (certificate: Record<string, unknown>): boolean => !paidCertificateIds.has(String(certificate.id));

  const receivable = certificates.filter((certificate) => !isDownstream(certificate));
  const payable = certificates.filter(isDownstream);

  const certifiedUnpaidMinor = receivable
    .filter(unpaid)
    .reduce((sum, certificate) => sum + Number(certificate.certifiedMinor ?? 0), 0);

  const netCertified = receivable.map((certificate) => Number(certificate.certifiedMinor ?? 0));
  const averageNetCertifiedMinor =
    netCertified.length > 0
      ? Math.round(netCertified.reduce((sum, value) => sum + value, 0) / netCertified.length)
      : 0;

  const payableMinor = payable.map((certificate) => Number(certificate.certifiedMinor ?? 0));
  const outflow: ForwardCashflow['outflow'] = {
    measured: payableMinor.length > 0,
    ...(payableMinor.length > 0
      ? {}
      : {
          reason:
            'Nothing has been certified down the chain yet, so the outflow side is unmeasured. ' +
            'The cumulative line is what comes in, not what is left — subcontract commitments will draw against it.',
        }),
    certifiedUnpaidMinor: payable
      .filter(unpaid)
      .reduce((sum, certificate) => sum + Number(certificate.certifiedMinor ?? 0), 0),
    averagePerPeriodMinor:
      payableMinor.length > 0
        ? Math.round(payableMinor.reduce((sum, value) => sum + value, 0) / payableMinor.length)
        : 0,
    measuredFromCertificates: payableMinor.length,
  };

  // A run rate cannot keep running past the contract sum. Without an executed
  // contract there is no ceiling to apply, and inventing one would be worse than
  // saying the projection is uncapped.
  const contract = ctx.ledger.list(ctx.projectId, 'Contract').find((record) => record.state.status === 'EXECUTED');
  const contractValueMinor = Number(contract?.state.contractSumMinor ?? 0);
  const variationsMinor = ctx.ledger
    .list(ctx.projectId, 'Variation')
    .filter((variation) => variation.state.status === 'AGREED')
    .reduce((sum, variation) => sum + Number(variation.state.valuedAmountMinor ?? 0), 0);
  const certifiedToDateMinor = netCertified.reduce((sum, value) => sum + value, 0);
  const ceilingMinor = contractValueMinor + variationsMinor;
  const headroom: ForwardCashflow['headroom'] = {
    known: contractValueMinor > 0,
    ...(contractValueMinor > 0
      ? {}
      : {
          reason:
            'No executed contract carries a sum, so there is no ceiling on the projection. ' +
            'The run rate is applied to every remaining period, which will overstate a project approaching completion.',
        }),
    contractValueMinor: ceilingMinor,
    certifiedToDateMinor,
    remainingCertifiableMinor: contractValueMinor > 0 ? Math.max(0, ceilingMinor - certifiedToDateMinor) : 0,
  };

  const empty = (reason: string): ForwardCashflow => ({
    derivable: false,
    reason,
    certifiedUnpaidMinor,
    headroom,
    measuredFromCycles: netCertified.length,
    averageNetCertifiedMinor,
    outflow,
    periods: [],
    lowPointMinor: 0,
    closingMinor: 0,
    summary: reason,
  });

  if (upstream.length === 0) {
    return empty('No upstream payment cycle is generated, so there are no dates to project cash against.');
  }
  if (netCertified.length === 0) {
    // The refusal that matters. Falling back to the tender model here would
    // present a bid assumption as a reading of the record.
    return empty(
      'Nothing has been certified yet, so there is no measured run rate. ' +
        'The tender cash model is the right answer until the first certificate — this one reads the record, and the record is empty.',
    );
  }

  const upstreamPeriods = (upstream[0]?.state.periods ?? []) as Array<{
    cycleNumber: number;
    dueDate: string;
    finalDateForPayment: string;
  }>;

  const future = upstreamPeriods.filter((period) => period.finalDateForPayment > today);
  let cumulative = 0;
  let lowPointMinor = 0;
  let lowPointDate: string | undefined;

  /**
   * Put a certificate on the period its own final date falls in.
   *
   * Matching on cycle number would be wrong the moment a subcontract runs a
   * different schedule from the main contract, and the date is the thing the
   * bank cares about anyway. A certificate already past its final date is
   * overdue rather than gone, so it lands on the first period still open.
   */
  const bucket = (items: Array<{ minor: number; finalDate: string }>): number[] => {
    const buckets = new Array<number>(future.length).fill(0);
    if (future.length === 0) return buckets;
    for (const item of items) {
      const found = future.findIndex((period) => period.finalDateForPayment >= item.finalDate);
      // Due beyond the horizon: carried at the end rather than dropped. Money
      // that falls off the bottom of a cashflow is the classic way to make one
      // look survivable.
      const index = found < 0 ? future.length - 1 : found;
      buckets[index] = buckets[index]! + item.minor;
    }
    return buckets;
  };

  const dated = (list: typeof certificates): Array<{ minor: number; finalDate: string }> =>
    list.map((certificate) => ({
      minor: Number(certificate.certifiedMinor ?? 0),
      finalDate: String(certificate.finalDateForPayment ?? today),
    }));

  const certifiedIn = bucket(dated(receivable.filter(unpaid)));
  const certifiedOut = bucket(dated(payable.filter(unpaid)));
  // A certificate already paid means that period's money has moved. Projecting
  // a run rate onto it as well would count the same valuation twice — which is
  // exactly what happens on a project paying ahead of its final dates.
  const settledIn = bucket(dated(receivable.filter((certificate) => !unpaid(certificate))));
  const settledOut = bucket(dated(payable.filter((certificate) => !unpaid(certificate))));

  let projectedRemaining = headroom.known ? headroom.remainingCertifiableMinor : Number.POSITIVE_INFINITY;
  let exhaustsAtPeriod: number | undefined;

  const periods = future.map((period, index) => {
    let basis: 'CERTIFIED' | 'SETTLED' | 'PROJECTED';
    let inMinor: number;

    if (certifiedIn[index]! > 0) {
      // Owed on a date the contract already fixed, at its own value.
      basis = 'CERTIFIED';
      inMinor = certifiedIn[index]!;
    } else if (settledIn[index]! > 0) {
      basis = 'SETTLED';
      inMinor = 0;
    } else {
      basis = 'PROJECTED';
      inMinor = Math.min(averageNetCertifiedMinor, Math.max(0, projectedRemaining));
      projectedRemaining -= inMinor;
      if (inMinor < averageNetCertifiedMinor && exhaustsAtPeriod === undefined) {
        exhaustsAtPeriod = period.cycleNumber;
      }
    }

    const outMinor =
      certifiedOut[index]! > 0
        ? certifiedOut[index]!
        : settledOut[index]! > 0
          ? 0
          : outflow.measured
            ? outflow.averagePerPeriodMinor
            : 0;

    const netMinor = inMinor - outMinor;
    cumulative += netMinor;

    if (cumulative < lowPointMinor) {
      lowPointMinor = cumulative;
      lowPointDate = period.finalDateForPayment;
    }

    return {
      period: period.cycleNumber,
      dueDate: period.dueDate,
      finalDateForPayment: period.finalDateForPayment,
      basis,
      inMinor,
      outMinor,
      netMinor,
      cumulativeMinor: cumulative,
    };
  });

  headroom.exhaustsAtPeriod = exhaustsAtPeriod;

  return {
    derivable: true,
    certifiedUnpaidMinor,
    measuredFromCycles: netCertified.length,
    averageNetCertifiedMinor,
    outflow,
    headroom,
    periods,
    lowPointMinor,
    lowPointDate,
    closingMinor: cumulative,
    summary:
      periods.length === 0
        ? 'Every payment period has passed its final date, so there is nothing left to project.'
        : `${periods.length} period${periods.length === 1 ? '' : 's'} remaining, projected from ${netCertified.length} completed ${
            netCertified.length === 1 ? 'certification' : 'certifications'
          } rather than from the tender. ${
            lowPointMinor < 0
              ? `The position is worst on ${lowPointDate}, and that is the figure to fund — a project that ends level having been down in March still had to find the money in March.`
              : 'The cumulative position stays positive throughout.'
          }${
            exhaustsAtPeriod !== undefined
              ? ` The run rate exhausts what is left to certify at period ${exhaustsAtPeriod}, well inside the schedule — either the rate or the programme is wrong, and the periods after it project nothing.`
              : ''
          }${headroom.known ? '' : ` ${headroom.reason}`}${outflow.measured ? '' : ` ${outflow.reason}`}`,
  };
}

export function ledgerPosition(ctx: EngineContext): {
  committedMinor: number;
  certifiedMinor: number;
  paidMinor: number;
  retentionHeldMinor: number;
  /** Set off against subcontractors, and how much of it will actually stand. */
  contraChargedMinor: number;
  contraEnforceableMinor: number;
  exceptions: Array<{ type: string; detail: string; entityRef: string }>;
} {
  authorise(ctx, 'BUDGET_COST', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const commitments = ctx.ledger.list(ctx.projectId, 'Commitment');
  const certificates = ctx.ledger.list(ctx.projectId, 'PaymentCertificate');
  const entries = ctx.ledger.list(ctx.projectId, 'LedgerEntry');

  const committed = commitments.reduce((s, c) => s + Number(c.state.valueMinor ?? 0), 0);
  const certified = certificates.reduce((s, c) => s + Number(c.state.certifiedMinor ?? 0), 0);
  const paid = entries.filter((e) => e.state.type === 'PAYMENT').reduce((s, e) => s + Number(e.state.amountMinor ?? 0), 0);
  const retention = certificates.reduce((s, c) => s + Number(c.state.retentionMinor ?? 0), 0);
  const contras = ctx.ledger.list(ctx.projectId, 'ContraCharge');
  const contraCharged = contras.reduce((s, c) => s + Number(c.state.amountMinor ?? 0), 0);
  const contraEnforceable = contras
    .filter((c) => c.state.enforceable === true)
    .reduce((s, c) => s + Number(c.state.amountMinor ?? 0), 0);

  const exceptions: Array<{ type: string; detail: string; entityRef: string }> = [];

  for (const certificate of certificates) {
    const settled = entries.some((e) => e.state.certificateId === certificate.refId);
    if (!settled) {
      exceptions.push({
        type: 'UNPAID_CERTIFICATE',
        detail: `Certificate ${certificate.refId} certified but no payment posted`,
        entityRef: certificate.refId,
      });
    }
  }
  for (const commitment of commitments) {
    if (!commitment.state.contractId) {
      exceptions.push({
        type: 'UNLINKED_COMMITMENT',
        detail: `Commitment ${commitment.refId} is not linked to a subcontract`,
        entityRef: commitment.refId,
      });
    }
  }
  for (const contra of contras) {
    if (contra.state.enforceable !== true) {
      // Not a deduction — an intention to deduct. Under the Construction Act a
      // payer cannot pay less than the notified sum without a valid pay less
      // notice, so this money comes back at adjudication and is then chased
      // separately. A forecast that counts it as recovered is wrong.
      exceptions.push({
        type: 'UNNOTIFIED_SET_OFF',
        detail: `Contra charge ${String(contra.state.reference)} — ${String(contra.state.barrier ?? 'no effective pay less notice')}`,
        entityRef: contra.refId,
      });
    }
  }
  if (certified > committed && committed > 0) {
    exceptions.push({
      type: 'OVERCERTIFICATION',
      detail: 'Certified value exceeds the value committed under subcontracts',
      entityRef: ctx.projectId,
    });
  }

  return {
    committedMinor: committed,
    certifiedMinor: certified,
    paidMinor: paid,
    retentionHeldMinor: retention,
    contraChargedMinor: contraCharged,
    contraEnforceableMinor: contraEnforceable,
    exceptions,
  };
}

/**
 * Contra charges: recovering a cost from the party that caused it.
 *
 * A main contractor cleans up after a subcontractor who left, hires plant the
 * subcontract said the subcontractor would provide, or puts right work that
 * failed inspection. The cost is real and it belongs to the subcontractor, and
 * the way it comes back is a deduction from what they are paid.
 *
 * **The rule this enforces is the one that decides whether the money is
 * actually recovered.** Under the Construction Act a payer may not pay less
 * than the notified sum without a valid pay less notice given in time. So a
 * contra charge raised without one is not a deduction — it is an intention to
 * deduct, and at adjudication it is money the payer has to hand back and then
 * chase separately. Contractors lose this argument constantly, and they lose it
 * on the notice rather than on the merits: the charge is usually justified and
 * the notice was late.
 *
 * The charge is therefore recorded either way and its **enforceability** is
 * computed rather than asserted. Refusing to record an unnotified charge would
 * destroy the evidence of the cost, which is the thing needed to recover it by
 * the route that remains open.
 */
export type ContraReason =
  | 'REMEDIAL_WORK'
  | 'ATTENDANCE'
  | 'PLANT_AND_EQUIPMENT'
  | 'CLEANING_AND_WASTE'
  | 'DELAY_TO_FOLLOWING_TRADES'
  | 'MATERIALS_SUPPLIED'
  | 'STATUTORY_OR_SAFETY';

export function raiseContraCharge(
  ctx: EngineContext,
  input: {
    /** The subcontract the charge is set off against. */
    subcontractId: string;
    reason: ContraReason;
    amountMinor: number;
    /** What was done, when, and why it was the subcontractor's cost to bear. */
    narrative: string;
    incurredOn: string;
    /** The record of the cost — a hire invoice, a labour allocation, a photograph. */
    evidenceHash: string;
    /** The pay less notice that gives effect to the deduction, where one exists. */
    payLessNoticeId?: string;
  },
): { contraChargeId: string; reference: string; enforceable: boolean; reason?: string } {
  authorise(ctx, 'PAYMENT_APPLICATIONS', 'C', { dataSensitivity: 'COMMERCIAL_L3' });

  if (input.amountMinor <= 0) {
    throw new DomainError('CONTRA_AMOUNT_INVALID', 'A contra charge must be a positive amount');
  }
  // A charge cannot recover a cost that has not been incurred. Dated in the
  // future it is a forecast, and a forecast is not a set-off.
  assertNotFuture(input.incurredOn, 'incurredOn');

  const subcontract = ctx.ledger.require({ refType: 'Subcontract', refId: input.subcontractId });

  // --- Is it actually a deduction? ------------------------------------------
  let enforceable = false;
  let barrier: string | undefined = 'No pay less notice — the deduction cannot be made from a notified sum';

  if (input.payLessNoticeId) {
    const notice = ctx.ledger.get({ refType: 'PayLessNotice', refId: input.payLessNoticeId });
    if (!notice) {
      barrier = 'The pay less notice referenced does not exist';
    } else if (notice.state.effective !== true) {
      // Recorded and ineffective — given late, or without a basis of
      // calculation. Either way it gives no effect to the set-off.
      barrier = 'The pay less notice is ineffective, so it gives no effect to the deduction';
    } else {
      enforceable = true;
      barrier = undefined;
    }
  }

  const contraChargeId = ulid();
  // Sequential per project, so a reference is quotable in a letter. Taken from
  // the count already recorded rather than from a counter that would have to be
  // stored and could drift from the ledger it describes.
  const reference = formatRef('CON', ctx.ledger.list(ctx.projectId, 'ContraCharge').length + 1);

  const evidence = registerEvidence(ctx, {
    type: 'CONTRA_CHARGE_SUPPORT',
    hash: input.evidenceHash,
    description: `${input.reason} contra charge against subcontract ${input.subcontractId}`,
    linkedEntities: [{ refType: 'Subcontract', refId: input.subcontractId }],
  });

  write(ctx, {
    eventType: 'CONTRA_CHARGE_RAISED',
    entity: { refType: 'ContraCharge', refId: contraChargeId },
    evidenceRefs: [evidence],
    nextState: {
      id: contraChargeId,
      reference,
      projectId: ctx.projectId,
      subcontractId: input.subcontractId,
      supplierId: subcontract.state.supplierId,
      reason: input.reason,
      amountMinor: input.amountMinor,
      narrative: input.narrative,
      incurredOn: input.incurredOn,
      payLessNoticeId: input.payLessNoticeId,
      // Computed, not supplied. A field the caller could set would be a field
      // the caller sets to true.
      enforceable,
      barrier,
      raisedAt: new Date().toISOString(),
    },
  });

  return { contraChargeId, reference, enforceable, ...(barrier === undefined ? {} : { reason: barrier }) };
}

/**
 * The contra position: what has been charged, and how much of it will stand.
 *
 * The distinction is the whole value. A contractor looking at £180,000 of contra
 * charges believes they have recovered £180,000; if £140,000 of it was raised
 * without a pay less notice, they have recovered £40,000 and have a debt claim
 * for the rest. Those are very different positions and only one of them is in
 * the forecast.
 */
export type ContraPosition = {
  raisedMinor: number;
  enforceableMinor: number;
  /** Raised without an effective pay less notice. Recoverable, but not by set-off. */
  atRiskMinor: number;
  bySupplier: Array<{
    supplierId: string;
    subcontractId: string;
    raisedMinor: number;
    enforceableMinor: number;
    charges: Array<{
      reference: string;
      reason: ContraReason;
      amountMinor: number;
      incurredOn: string;
      enforceable: boolean;
      barrier?: string;
    }>;
  }>;
};

export function contraPosition(ctx: EngineContext): ContraPosition {
  authorise(ctx, 'PAYMENT_APPLICATIONS', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const charges = ctx.ledger.list(ctx.projectId, 'ContraCharge');
  const grouped = new Map<string, ContraPosition['bySupplier'][number]>();

  let raisedMinor = 0;
  let enforceableMinor = 0;

  for (const record of charges) {
    const state = record.state;
    const amount = Number(state.amountMinor ?? 0);
    const enforceable = state.enforceable === true;
    const subcontractId = String(state.subcontractId ?? '');

    raisedMinor += amount;
    if (enforceable) enforceableMinor += amount;

    const group = grouped.get(subcontractId) ?? {
      supplierId: String(state.supplierId ?? ''),
      subcontractId,
      raisedMinor: 0,
      enforceableMinor: 0,
      charges: [],
    };
    group.raisedMinor += amount;
    if (enforceable) group.enforceableMinor += amount;
    group.charges.push({
      reference: String(state.reference ?? ''),
      reason: String(state.reason ?? 'REMEDIAL_WORK') as ContraReason,
      amountMinor: amount,
      incurredOn: String(state.incurredOn ?? ''),
      enforceable,
      ...(typeof state.barrier === 'string' ? { barrier: state.barrier } : {}),
    });
    grouped.set(subcontractId, group);
  }

  return {
    raisedMinor,
    enforceableMinor,
    atRiskMinor: raisedMinor - enforceableMinor,
    // Most at risk first: the money that will not stand is the work.
    bySupplier: [...grouped.values()].sort(
      (a, b) => b.raisedMinor - b.enforceableMinor - (a.raisedMinor - a.enforceableMinor),
    ),
  };
}
