import { reckonPeriod, type BusinessCalendar } from './constructionAct.ts';

/**
 * Delay attribution, entitlement assessment and payment-cycle arithmetic.
 *
 * The purpose of this module is to turn a dispute into arithmetic. Every figure
 * here traces to dated records in the Golden Thread, so a position can be
 * defended by pointing at events rather than at opinions.
 */

export type DelayCause =
  | 'CLIENT_CHANGE'
  | 'DESIGN_LATE'
  | 'ACCESS_DENIED'
  | 'STATUTORY_UNDERTAKER'
  | 'EXCEPTIONAL_WEATHER'
  | 'GROUND_CONDITIONS'
  | 'CONTRACTOR_RESOURCE'
  | 'CONTRACTOR_PRODUCTIVITY'
  | 'SUBCONTRACTOR_DEFAULT'
  | 'MATERIAL_LEAD_TIME'
  | 'FORCE_MAJEURE';

/**
 * Who bears each cause, and what it entitles. This mapping is the contractual
 * spine of any extension-of-time assessment.
 */
export const CAUSE_LIABILITY: Record<
  DelayCause,
  { responsibility: 'EMPLOYER' | 'CONTRACTOR' | 'NEUTRAL'; timeEntitlement: boolean; moneyEntitlement: boolean }
> = {
  CLIENT_CHANGE: { responsibility: 'EMPLOYER', timeEntitlement: true, moneyEntitlement: true },
  DESIGN_LATE: { responsibility: 'EMPLOYER', timeEntitlement: true, moneyEntitlement: true },
  ACCESS_DENIED: { responsibility: 'EMPLOYER', timeEntitlement: true, moneyEntitlement: true },
  STATUTORY_UNDERTAKER: { responsibility: 'NEUTRAL', timeEntitlement: true, moneyEntitlement: false },
  EXCEPTIONAL_WEATHER: { responsibility: 'NEUTRAL', timeEntitlement: true, moneyEntitlement: false },
  GROUND_CONDITIONS: { responsibility: 'EMPLOYER', timeEntitlement: true, moneyEntitlement: true },
  CONTRACTOR_RESOURCE: { responsibility: 'CONTRACTOR', timeEntitlement: false, moneyEntitlement: false },
  CONTRACTOR_PRODUCTIVITY: { responsibility: 'CONTRACTOR', timeEntitlement: false, moneyEntitlement: false },
  SUBCONTRACTOR_DEFAULT: { responsibility: 'CONTRACTOR', timeEntitlement: false, moneyEntitlement: false },
  MATERIAL_LEAD_TIME: { responsibility: 'CONTRACTOR', timeEntitlement: false, moneyEntitlement: false },
  FORCE_MAJEURE: { responsibility: 'NEUTRAL', timeEntitlement: true, moneyEntitlement: false },
};

export type DelayEventInput = {
  id: string;
  cause: DelayCause;
  description: string;
  start: string;
  end: string;
  /** Days of critical-path impact established by the programme analysis. */
  criticalDelayDays: number;
  affectedTaskIds: string[];
  /** Evidence refs supporting the event — an unevidenced event scores nothing. */
  evidenceCount: number;
  /** Whether a contractual notice was served, and whether it was in time. */
  noticeServed: boolean;
  noticeWithinTimeBar: boolean;
};

export type ConcurrencyFinding = {
  eventIds: string[];
  overlapDays: number;
  /** Apportionment approach applied to the concurrent window. */
  treatment: 'DOMINANT_CAUSE' | 'APPORTIONED' | 'TIME_BUT_NO_MONEY';
  rationale: string;
};

export type DelayAttribution = {
  totalCriticalDelayDays: number;
  employerRiskDays: number;
  contractorRiskDays: number;
  neutralRiskDays: number;
  concurrency: ConcurrencyFinding[];
  /** Days of extension of time supportable on the evidence. */
  extensionOfTimeDays: number;
  /** Days for which prolongation cost is also recoverable. */
  compensableDays: number;
  perEvent: Array<{
    eventId: string;
    cause: DelayCause;
    responsibility: string;
    criticalDelayDays: number;
    entitlementDays: number;
    compensableDays: number;
    evidenceStrength: number;
    notes: string[];
  }>;
};

function overlapDays(a: { start: string; end: string }, b: { start: string; end: string }): number {
  const start = Math.max(Date.parse(a.start), Date.parse(b.start));
  const end = Math.min(Date.parse(a.end), Date.parse(b.end));
  if (end <= start) return 0;
  return Math.round((end - start) / 86_400_000);
}

/**
 * Attribute critical delay across events, handling concurrency explicitly.
 *
 * The prevailing approach in most standard forms: where employer-risk and
 * contractor-risk delay run concurrently, the contractor gets time but not
 * money. That is applied here rather than left to argument.
 */
export function attributeDelay(events: DelayEventInput[]): DelayAttribution {
  const ordered = [...events].sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || (a.id < b.id ? -1 : 1));

  const concurrency: ConcurrencyFinding[] = [];
  const concurrentEmployerDays = new Map<string, number>();

  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const a = ordered[i] as DelayEventInput;
      const b = ordered[j] as DelayEventInput;
      const overlap = overlapDays(a, b);
      if (overlap <= 0) continue;

      const aLiability = CAUSE_LIABILITY[a.cause];
      const bLiability = CAUSE_LIABILITY[b.cause];
      const employerSide = aLiability.responsibility === 'EMPLOYER' ? a : bLiability.responsibility === 'EMPLOYER' ? b : undefined;
      const contractorSide =
        aLiability.responsibility === 'CONTRACTOR' ? a : bLiability.responsibility === 'CONTRACTOR' ? b : undefined;

      if (employerSide && contractorSide) {
        concurrency.push({
          eventIds: [a.id, b.id],
          overlapDays: overlap,
          treatment: 'TIME_BUT_NO_MONEY',
          rationale:
            'Employer-risk and contractor-risk delay run concurrently: extension of time is supportable, prolongation cost is not.',
        });
        concurrentEmployerDays.set(employerSide.id, (concurrentEmployerDays.get(employerSide.id) ?? 0) + overlap);
      } else if (aLiability.responsibility === bLiability.responsibility) {
        concurrency.push({
          eventIds: [a.id, b.id],
          overlapDays: overlap,
          treatment: 'DOMINANT_CAUSE',
          rationale: 'Both events sit on the same side of the risk allocation; the dominant cause carries the period.',
        });
      } else {
        concurrency.push({
          eventIds: [a.id, b.id],
          overlapDays: overlap,
          treatment: 'APPORTIONED',
          rationale: 'Mixed employer and neutral risk: the overlap is apportioned between the two causes.',
        });
      }
    }
  }

  let employerRiskDays = 0;
  let contractorRiskDays = 0;
  let neutralRiskDays = 0;
  let extensionOfTime = 0;
  let compensable = 0;

  const perEvent = ordered.map((event) => {
    const liability = CAUSE_LIABILITY[event.cause];
    const notes: string[] = [];

    // Evidence strength gates entitlement. An unevidenced event is a position,
    // not a claim, and the platform will not inflate it into one.
    const evidenceStrength = Number(Math.min(1, event.evidenceCount / 3).toFixed(3));
    if (event.evidenceCount === 0) notes.push('No evidence attached — entitlement cannot be substantiated');
    else if (event.evidenceCount < 3) notes.push('Evidence is thin; strengthen before submission');

    let entitlementDays = liability.timeEntitlement ? event.criticalDelayDays : 0;

    if (liability.timeEntitlement && !event.noticeServed) {
      notes.push('No contractual notice served — entitlement is at risk irrespective of merit');
      entitlementDays *= 0.5;
    } else if (liability.timeEntitlement && !event.noticeWithinTimeBar) {
      notes.push('Notice served outside the contractual time bar');
      entitlementDays *= 0.7;
    }

    entitlementDays *= evidenceStrength === 0 ? 0 : Math.max(0.5, evidenceStrength);

    let eventCompensable = liability.moneyEntitlement ? entitlementDays : 0;
    const concurrentDays = concurrentEmployerDays.get(event.id) ?? 0;
    if (concurrentDays > 0 && eventCompensable > 0) {
      eventCompensable = Math.max(0, eventCompensable - concurrentDays);
      notes.push(`${concurrentDays}d of concurrency removes cost entitlement for that period`);
    }

    if (liability.responsibility === 'EMPLOYER') employerRiskDays += event.criticalDelayDays;
    else if (liability.responsibility === 'CONTRACTOR') contractorRiskDays += event.criticalDelayDays;
    else neutralRiskDays += event.criticalDelayDays;

    extensionOfTime += entitlementDays;
    compensable += eventCompensable;

    return {
      eventId: event.id,
      cause: event.cause,
      responsibility: liability.responsibility,
      criticalDelayDays: event.criticalDelayDays,
      entitlementDays: Number(entitlementDays.toFixed(2)),
      compensableDays: Number(eventCompensable.toFixed(2)),
      evidenceStrength,
      notes,
    };
  });

  return {
    totalCriticalDelayDays: ordered.reduce((s, e) => s + e.criticalDelayDays, 0),
    employerRiskDays,
    contractorRiskDays,
    neutralRiskDays,
    concurrency,
    extensionOfTimeDays: Number(extensionOfTime.toFixed(2)),
    compensableDays: Number(compensable.toFixed(2)),
    perEvent,
  };
}

export type ClaimAssessment = {
  claimedDays: number;
  claimedAmountMinor: number;
  assessedDays: number;
  assessedAmountMinor: number;
  /** Probability the claim succeeds substantially as assessed, in [0,1]. */
  entitlementScore: number;
  strengths: string[];
  weaknesses: string[];
  recommendation: string;
};

/**
 * Score a claim on the four things that actually decide construction disputes:
 * entitlement in the contract, causation, evidence, and procedural compliance.
 */
export function assessClaim(input: {
  attribution: DelayAttribution;
  dailyProlongationMinor: number;
  claimedDays: number;
  claimedAmountMinor: number;
  contractualBasisIdentified: boolean;
  recordsContemporaneous: boolean;
  programmeBaselineApproved: boolean;
}): ClaimAssessment {
  const assessedDays = input.attribution.extensionOfTimeDays;
  const assessedAmount = Math.round(input.attribution.compensableDays * input.dailyProlongationMinor);

  const strengths: string[] = [];
  const weaknesses: string[] = [];

  let score = 0;

  if (input.contractualBasisIdentified) {
    score += 0.3;
    strengths.push('A specific contractual basis for the claim has been identified');
  } else {
    weaknesses.push('No contractual clause identified as the basis of entitlement');
  }

  if (input.programmeBaselineApproved) {
    score += 0.2;
    strengths.push('Delay is measured against an approved baseline programme');
  } else {
    weaknesses.push('No approved baseline: causation will be contested on the programme alone');
  }

  if (input.recordsContemporaneous) {
    score += 0.2;
    strengths.push('Records are contemporaneous and hash-sealed in the Golden Thread');
  } else {
    weaknesses.push('Records are reconstructed rather than contemporaneous');
  }

  const evidenceAverage =
    input.attribution.perEvent.length === 0
      ? 0
      : input.attribution.perEvent.reduce((s, e) => s + e.evidenceStrength, 0) / input.attribution.perEvent.length;
  score += evidenceAverage * 0.2;
  if (evidenceAverage < 0.5) weaknesses.push('Evidence density is low across the delay events relied on');
  else strengths.push('Delay events are supported by multiple evidence items each');

  const noticeIssues = input.attribution.perEvent.filter((e) => e.notes.some((n) => n.includes('notice'))).length;
  if (noticeIssues === 0) {
    score += 0.1;
    strengths.push('Contractual notices were served in time for every event relied on');
  } else {
    weaknesses.push(`${noticeIssues} event(s) have notice defects`);
  }

  if (input.attribution.concurrency.length > 0) {
    weaknesses.push(`${input.attribution.concurrency.length} concurrency finding(s) reduce cost recovery`);
  }

  const entitlementScore = Number(Math.max(0, Math.min(1, score)).toFixed(3));
  const overclaimRatio = input.claimedDays === 0 ? 1 : assessedDays / input.claimedDays;

  let recommendation: string;
  if (entitlementScore >= 0.75 && overclaimRatio >= 0.8) {
    recommendation = 'Strong position: submit as assessed and pursue agreement.';
  } else if (entitlementScore >= 0.5) {
    recommendation = `Submit at the assessed figure (${assessedDays.toFixed(1)}d), not the claimed figure. Close the listed weaknesses first.`;
  } else if (entitlementScore >= 0.3) {
    recommendation = 'Weak position: remedy the evidence and notice defects before submitting, or negotiate commercially.';
  } else {
    recommendation = 'Do not submit in this form. The entitlement basis and records will not survive scrutiny.';
  }

  return {
    claimedDays: input.claimedDays,
    claimedAmountMinor: input.claimedAmountMinor,
    assessedDays: Number(assessedDays.toFixed(2)),
    assessedAmountMinor: assessedAmount,
    entitlementScore,
    strengths,
    weaknesses,
    recommendation,
  };
}

// --- Payment cycle ----------------------------------------------------------

export type PaymentTerms = {
  /** Day of the month applications are due. */
  applicationDayOfMonth: number;
  /** Days after the due date by which the payment notice must be issued. */
  paymentNoticeDays: number;
  /** Days before the final date for payment by which a pay less notice must be issued. */
  payLessNoticeDaysBeforeFinal: number;
  /** Days from the due date to the final date for payment. */
  finalDateDays: number;
};

export type PaymentCyclePeriod = {
  cycleNumber: number;
  periodStart: string;
  periodEnd: string;
  applicationDate: string;
  dueDate: string;
  paymentNoticeDeadline: string;
  payLessNoticeDeadline: string;
  finalDateForPayment: string;
};

function addDays(iso: string, days: number): string {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Generate a statutory payment cycle. Missing a payment or pay-less notice
 * deadline has direct cash consequences, so the dates are computed and tracked
 * rather than left in someone's calendar.
 *
 * The payment notice deadline is reckoned under s.116 rather than by adding
 * days, because the Scheme's period is five days and s.116(3) excludes
 * Christmas Day, Good Friday and bank holidays from any period shorter than
 * seven. Counting it plainly produces a deadline earlier than the statute
 * allows — which would have this platform tell a payee they were entitled to
 * the notified sum when the payer was still in time.
 */
export function generatePaymentCycle(
  startDate: string,
  cycles: number,
  terms: PaymentTerms,
  calendar?: BusinessCalendar,
): PaymentCyclePeriod[] {
  const periods: PaymentCyclePeriod[] = [];
  const start = new Date(`${startDate.slice(0, 10)}T00:00:00.000Z`);

  for (let i = 0; i < cycles; i++) {
    const periodStart = new Date(start);
    periodStart.setUTCMonth(start.getUTCMonth() + i);
    const periodEnd = new Date(periodStart);
    periodEnd.setUTCMonth(periodStart.getUTCMonth() + 1);
    periodEnd.setUTCDate(periodEnd.getUTCDate() - 1);

    const applicationDate = new Date(periodStart);
    applicationDate.setUTCDate(terms.applicationDayOfMonth);
    applicationDate.setUTCMonth(periodStart.getUTCMonth() + 1);

    const dueDateIso = applicationDate.toISOString().slice(0, 10);
    const finalDate = addDays(dueDateIso, terms.finalDateDays);

    periods.push({
      cycleNumber: i + 1,
      periodStart: periodStart.toISOString().slice(0, 10),
      periodEnd: periodEnd.toISOString().slice(0, 10),
      applicationDate: dueDateIso,
      dueDate: dueDateIso,
      paymentNoticeDeadline: reckonPeriod(dueDateIso, terms.paymentNoticeDays, calendar),
      payLessNoticeDeadline: addDays(finalDate, -terms.payLessNoticeDaysBeforeFinal),
      finalDateForPayment: finalDate,
    });
  }

  return periods;
}

/** Notice compliance check — what is overdue, and what the exposure is. */
export function checkNoticeCompliance(
  period: PaymentCyclePeriod,
  issued: { paymentNotice?: string; payLessNotice?: string },
  today: string,
): Array<{ notice: string; status: 'ISSUED_IN_TIME' | 'LATE' | 'OVERDUE' | 'PENDING'; consequence?: string }> {
  const results: Array<{ notice: string; status: 'ISSUED_IN_TIME' | 'LATE' | 'OVERDUE' | 'PENDING'; consequence?: string }> = [];

  if (issued.paymentNotice) {
    results.push({
      notice: 'Payment notice',
      status: issued.paymentNotice <= period.paymentNoticeDeadline ? 'ISSUED_IN_TIME' : 'LATE',
      consequence:
        issued.paymentNotice > period.paymentNoticeDeadline
          ? 'Late payment notice: the sum applied for may become the notified sum'
          : undefined,
    });
  } else if (today > period.paymentNoticeDeadline) {
    results.push({
      notice: 'Payment notice',
      status: 'OVERDUE',
      consequence: 'No payment notice issued: the amount applied for is likely to become payable in full',
    });
  } else {
    results.push({ notice: 'Payment notice', status: 'PENDING' });
  }

  if (issued.payLessNotice) {
    results.push({
      notice: 'Pay less notice',
      status: issued.payLessNotice <= period.payLessNoticeDeadline ? 'ISSUED_IN_TIME' : 'LATE',
      consequence:
        issued.payLessNotice > period.payLessNoticeDeadline ? 'Late pay less notice is ineffective; deductions cannot be made' : undefined,
    });
  } else if (today > period.payLessNoticeDeadline) {
    results.push({ notice: 'Pay less notice', status: 'OVERDUE', consequence: 'Deductions can no longer be made for this cycle' });
  } else {
    results.push({ notice: 'Pay less notice', status: 'PENDING' });
  }

  return results;
}
