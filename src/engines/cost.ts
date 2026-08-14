import { hashEvidence } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, runAI, write, type EngineContext } from './context.ts';
import { calculateCVR, calculateEVM, sCurveDistribution, type CVRInput } from './maths/evm.ts';
import { checkNoticeCompliance, generatePaymentCycle, type PaymentTerms } from './maths/claims.ts';

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
 * Commercial ledger bridge — committed vs certified vs paid, with the exception
 * queue that closes the gap between the QS and finance.
 */
export function ledgerPosition(ctx: EngineContext): {
  committedMinor: number;
  certifiedMinor: number;
  paidMinor: number;
  retentionHeldMinor: number;
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
    exceptions,
  };
}
