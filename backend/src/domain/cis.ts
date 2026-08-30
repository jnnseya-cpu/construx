import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';

/**
 * The Construction Industry Scheme: verification, deduction, and the monthly
 * return.
 *
 * Every contractor paying a subcontractor for construction work in the UK
 * operates CIS, and it is not optional at any size. A sole trader with one
 * labour-only subcontractor has exactly the same obligations as a national
 * contractor: verify before the first payment, deduct at the right rate, give
 * the subcontractor a statement, and file a return every month — including the
 * months with nothing to report.
 *
 * That is precisely the burden this platform exists to carry for a business
 * with no finance department, and it was the largest named gap in the payment
 * chain: the platform ran the Construction Act cycle, paid subcontractors, and
 * said nothing about the tax it was legally required to withhold from them.
 *
 * ---
 *
 * ## The three rules that cost people money
 *
 * **The deduction is on labour only.** Materials the subcontractor bought, and
 * VAT, come out of the gross before the rate is applied. Deducting from the
 * whole invoice takes money that is not the Revenue's, and the subcontractor is
 * out of pocket until the year end.
 *
 * **An unverified subcontractor is 30%, not 20%.** The rate follows what HMRC
 * returned at verification, and where nothing was returned the higher rate
 * applies. Paying at 20% on an assumption makes up the difference out of the
 * contractor's own money — the liability is the contractor's, not the
 * subcontractor's.
 *
 * **A nil month still has a return.** Filing nothing because nothing was paid
 * is the most common CIS penalty there is: £100 the day after the 19th, and it
 * compounds. So a month with no payments produces a return that says so rather
 * than no return at all.
 *
 * ## What this does not do
 *
 * It does not talk to HMRC. Verification is *recorded* — the number and rate
 * HMRC gave, and when — rather than obtained, and the return is *prepared*
 * rather than filed. Both are stated on the record so nobody mistakes a
 * prepared return for a filed one. The Government Gateway is a credential and
 * an integration, not arithmetic, and inventing a submission receipt would be
 * the worst possible thing to fake.
 */

// --- Rates and status --------------------------------------------------------

/**
 * What HMRC returns at verification, and what each means for a payment.
 *
 * `UNREGISTERED` and `UNVERIFIED` are different situations with the same rate,
 * and keeping them apart matters: one is a subcontractor HMRC does not
 * recognise, the other is one nobody has asked about yet. The first is a
 * conversation with the subcontractor; the second is a job for the contractor
 * this afternoon.
 */
export const CIS_STATUS = {
  GROSS: { ratePercent: 0, label: 'Gross payment status', means: 'HMRC has cleared this subcontractor to be paid in full. Nothing is withheld.' },
  NET_20: { ratePercent: 20, label: 'Registered — standard rate', means: 'Verified and registered. 20% of the labour element is withheld.' },
  NET_30: { ratePercent: 30, label: 'Higher rate', means: 'HMRC returned the higher rate for this subcontractor. 30% of labour is withheld.' },
  UNREGISTERED: {
    ratePercent: 30,
    label: 'Not registered with HMRC',
    means: 'HMRC does not hold this subcontractor. 30% applies until they register and are verified.',
  },
  UNVERIFIED: {
    ratePercent: 30,
    label: 'Not yet verified',
    means: 'Nobody has asked HMRC about this subcontractor. The higher rate applies until somebody does, and the shortfall is the contractor’s liability rather than theirs.',
  },
} as const;

export type CisStatus = keyof typeof CIS_STATUS;

/** Statuses a verification may legitimately return. `UNVERIFIED` is the absence of one. */
export const VERIFIED_STATUS: CisStatus[] = ['GROSS', 'NET_20', 'NET_30', 'UNREGISTERED'];

// --- The tax month -----------------------------------------------------------

export type TaxMonth = {
  /** 6th of a month. */
  startsOn: string;
  /** 5th of the next. */
  endsOn: string;
  /** The return is due by the 19th of the month after the month end. */
  returnDueBy: string;
  /** Every subcontractor paid gets their statement within 14 days of the month end. */
  statementsDueBy: string;
  label: string;
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * The CIS tax month a date falls in.
 *
 * The 6th to the 5th, not the calendar month — a payment on the 3rd belongs to
 * the month that started on the 6th of the month *before*. Getting this wrong
 * puts a payment on the wrong return, which is an amendment and a penalty
 * rather than a rounding difference.
 */
export function taxMonthOf(dateISO: string): TaxMonth {
  const date = parseDate(dateISO);
  // Before the 6th, the tax month began in the previous calendar month.
  const anchor = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 6));
  if (date.getUTCDate() < 6) anchor.setUTCMonth(anchor.getUTCMonth() - 1);

  const endsOn = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 5));
  const returnDue = new Date(Date.UTC(endsOn.getUTCFullYear(), endsOn.getUTCMonth(), 19));
  const statementsDue = new Date(endsOn.getTime());
  statementsDue.setUTCDate(statementsDue.getUTCDate() + 14);

  return {
    startsOn: iso(anchor),
    endsOn: iso(endsOn),
    returnDueBy: iso(returnDue),
    statementsDueBy: iso(statementsDue),
    label: `${MONTHS[endsOn.getUTCMonth()]} ${endsOn.getUTCFullYear()} (6 ${MONTHS[anchor.getUTCMonth()]} to 5 ${MONTHS[endsOn.getUTCMonth()]})`,
  };
}

// --- The deduction -----------------------------------------------------------

export type CisDeduction = {
  status: CisStatus;
  ratePercent: number;
  grossMinor: number;
  /** Never deducted from: the subcontractor bought these. */
  materialsMinor: number;
  /** Never deducted from either, and not the contractor's to withhold. */
  vatMinor: number;
  /** What the rate is actually applied to. */
  labourMinor: number;
  deductionMinor: number;
  netPayableMinor: number;
};

/**
 * What to withhold from one payment.
 *
 * A pure function, deliberately: the arithmetic is the part a person will check
 * against their own working, and it must give the same answer whether it is
 * called from a payment, a forecast, or a screen showing what a payment *would*
 * be. Rounded down to the penny, which is the direction HMRC's own guidance
 * takes and the direction that never over-withholds from a subcontractor.
 */
export function deductionFor(input: {
  status: CisStatus;
  grossMinor: number;
  materialsMinor?: number;
  vatMinor?: number;
}): CisDeduction {
  const materials = Math.max(0, Math.round(input.materialsMinor ?? 0));
  const vat = Math.max(0, Math.round(input.vatMinor ?? 0));
  const gross = Math.round(input.grossMinor);

  if (gross < 0) throw new DomainError('CIS_GROSS_NEGATIVE', 'A payment cannot be negative');
  if (materials + vat > gross) {
    throw new DomainError(
      'CIS_MATERIALS_EXCEED_PAYMENT',
      `Materials of ${penny(materials)} and VAT of ${penny(vat)} are more than the ${penny(gross)} being paid. ` +
        'One of the three figures is wrong, and deducting on what is left would produce a negative labour element.',
    );
  }

  const labour = gross - materials - vat;
  const ratePercent = CIS_STATUS[input.status].ratePercent;
  const deduction = Math.floor((labour * ratePercent) / 100);

  return {
    status: input.status,
    ratePercent,
    grossMinor: gross,
    materialsMinor: materials,
    vatMinor: vat,
    labourMinor: labour,
    deductionMinor: deduction,
    netPayableMinor: gross - deduction,
  };
}

// --- Verification ------------------------------------------------------------

type VerificationState = {
  id: string;
  supplierId: string;
  supplierName: string;
  verificationNumber: string;
  status: CisStatus;
  verifiedOn: string;
  /**
   * Verification lasts the tax year it was done in and the two following. A
   * subcontractor paid within that window does not need re-verifying, which is
   * the rule that stops a contractor calling HMRC about the same firm monthly.
   */
  validUntil: string;
  recordedBy: string;
};

/**
 * Record what HMRC returned when this subcontractor was verified.
 *
 * Recorded, not obtained. The platform holds no Government Gateway credential
 * and does not pretend to: what is stored is the verification number and rate
 * HMRC gave, with the date, so the deduction that follows can be justified. The
 * number is what an inspection asks for.
 */
export function recordVerification(
  ctx: EngineContext,
  input: { supplierId: string; supplierName: string; verificationNumber: string; status: CisStatus; verifiedOn: string },
): { verificationId: string; status: CisStatus; ratePercent: number; validUntil: string } {
  authorise(ctx, 'PAYMENT_APPLICATIONS', 'C', { dataSensitivity: 'COMMERCIAL_L3' });

  if (!VERIFIED_STATUS.includes(input.status)) {
    throw new DomainError(
      'CIS_STATUS_NOT_A_RESULT',
      `${input.status} is not something HMRC returns. A verification result is one of ${VERIFIED_STATUS.join(', ')}.`,
    );
  }
  if (!/^V\d{10}[A-Z]?$/i.test(input.verificationNumber.trim())) {
    throw new DomainError(
      'CIS_VERIFICATION_NUMBER_MALFORMED',
      'A verification number is V followed by ten digits, and a letter where HMRC could not match the subcontractor. ' +
        `"${input.verificationNumber}" is not one, and a deduction defended with an invented number is worse than an undefended one.`,
    );
  }

  const verifiedOn = parseDate(input.verifiedOn);
  const verificationId = ulid();
  const validUntil = endOfTaxYearPlusTwo(verifiedOn);

  write(ctx, {
    eventType: 'CIS_SUBCONTRACTOR_VERIFIED',
    entity: { refType: 'CISVerification', refId: verificationId },
    reason: `${input.supplierName}: ${CIS_STATUS[input.status].label}`,
    nextState: {
      id: verificationId,
      supplierId: input.supplierId,
      supplierName: input.supplierName,
      verificationNumber: input.verificationNumber.trim().toUpperCase(),
      status: input.status,
      verifiedOn: iso(verifiedOn),
      validUntil,
      recordedBy: ctx.auth.actorId,
    } satisfies VerificationState,
  });

  return { verificationId, status: input.status, ratePercent: CIS_STATUS[input.status].ratePercent, validUntil };
}

/** The verification in force for a subcontractor on a date, if there is one. */
export function verificationFor(ctx: EngineContext, supplierId: string, onDate: string): VerificationState | undefined {
  const day = iso(parseDate(onDate));
  return ctx.ledger
    .list(ctx.projectId, 'CISVerification')
    .map((record) => record.state as unknown as VerificationState)
    .filter((state) => state.supplierId === supplierId && state.verifiedOn <= day && state.validUntil >= day)
    .sort((a, b) => b.verifiedOn.localeCompare(a.verifiedOn))[0];
}

// --- Payments ----------------------------------------------------------------

type CisPaymentState = CisDeduction & {
  id: string;
  supplierId: string;
  supplierName: string;
  paidOn: string;
  taxMonthEndsOn: string;
  verificationId?: string;
  verificationNumber?: string;
  /** The certificate this payment settles, where it came from the payment cycle. */
  certificateId?: string;
  recordedBy: string;
};

/**
 * Record a payment to a subcontractor, with the deduction it carries.
 *
 * The rate is **derived from the verification on file**, never taken from the
 * caller. A contractor who believes a subcontractor is on 20% and is wrong pays
 * the difference out of their own money, so the one thing this must not do is
 * accept an asserted rate. Where there is no verification in force the higher
 * rate applies and the record says why.
 */
export function recordPayment(
  ctx: EngineContext,
  input: {
    supplierId: string;
    supplierName: string;
    grossMinor: number;
    materialsMinor?: number;
    vatMinor?: number;
    paidOn: string;
    certificateId?: string;
  },
): CisDeduction & { paymentId: string; taxMonth: TaxMonth; verificationNumber?: string; basis: string } {
  authorise(ctx, 'PAYMENT_APPLICATIONS', 'C', { dataSensitivity: 'COMMERCIAL_L3' });

  const verification = verificationFor(ctx, input.supplierId, input.paidOn);
  const status: CisStatus = verification?.status ?? 'UNVERIFIED';
  const deduction = deductionFor({
    status,
    grossMinor: input.grossMinor,
    materialsMinor: input.materialsMinor,
    vatMinor: input.vatMinor,
  });

  const taxMonth = taxMonthOf(input.paidOn);
  const paymentId = ulid();

  write(ctx, {
    eventType: 'CIS_PAYMENT_RECORDED',
    entity: { refType: 'CISPayment', refId: paymentId },
    reason: `${input.supplierName}: ${penny(deduction.deductionMinor)} withheld at ${deduction.ratePercent}%`,
    nextState: {
      ...deduction,
      id: paymentId,
      supplierId: input.supplierId,
      supplierName: input.supplierName,
      paidOn: iso(parseDate(input.paidOn)),
      taxMonthEndsOn: taxMonth.endsOn,
      ...(verification ? { verificationId: verification.id, verificationNumber: verification.verificationNumber } : {}),
      ...(input.certificateId ? { certificateId: input.certificateId } : {}),
      recordedBy: ctx.auth.actorId,
    } satisfies CisPaymentState,
  });

  return {
    ...deduction,
    paymentId,
    taxMonth,
    ...(verification ? { verificationNumber: verification.verificationNumber } : {}),
    basis: verification
      ? `Verified ${verification.verifiedOn} under ${verification.verificationNumber}: ${CIS_STATUS[status].label}.`
      : 'No verification in force on the payment date, so the higher rate applies. The shortfall from paying at a ' +
        'lower rate would be the contractor’s liability, not the subcontractor’s — verify before the next payment.',
  };
}

// --- The monthly return ------------------------------------------------------

export type ReturnLine = {
  supplierId: string;
  supplierName: string;
  verificationNumber?: string;
  status: CisStatus;
  payments: number;
  grossMinor: number;
  materialsMinor: number;
  labourMinor: number;
  deductionMinor: number;
};

export type MonthlyReturn = {
  taxMonth: TaxMonth;
  /** True where nothing was paid. A nil month still has a return. */
  nil: boolean;
  lines: ReturnLine[];
  totals: { grossMinor: number; materialsMinor: number; labourMinor: number; deductionMinor: number; subcontractors: number };
  /** Subcontractors paid in the month with no verification in force. */
  unverified: Array<{ supplierId: string; supplierName: string; deductedMinor: number }>;
  /** Days late as at the date asked about, and what that costs. */
  lateness?: { daysLate: number; penaltyMinor: number; basis: string };
  /** Said on the return itself: this is prepared, not filed. */
  status: string;
  summary: string;
};

/**
 * Late-filing penalties, which are fixed by statute and compound.
 *
 * Written out because they are the reason the nil return matters. A contractor
 * with nothing to report who files nothing is £100 down the day after the 19th,
 * and £300 or more by the time anybody notices.
 */
function penaltyFor(daysLate: number, deductionMinor: number): { penaltyMinor: number; basis: string } {
  if (daysLate <= 0) return { penaltyMinor: 0, basis: 'Filed on time.' };
  const fivePercent = Math.round(deductionMinor * 0.05);
  if (daysLate >= 365) {
    const penalty = Math.max(300_00, fivePercent);
    return { penaltyMinor: penalty, basis: 'Twelve months late: the higher of £300 and 5% of the deductions, on top of everything before it.' };
  }
  if (daysLate >= 182) {
    const penalty = Math.max(300_00, fivePercent);
    return { penaltyMinor: penalty, basis: 'Six months late: the higher of £300 and 5% of the deductions, on top of the earlier penalties.' };
  }
  if (daysLate >= 60) return { penaltyMinor: 200_00, basis: 'Two months late: £200, on top of the £100 already due.' };
  return { penaltyMinor: 100_00, basis: 'One day late: £100. The penalty is the same on day one as on day fifty-nine.' };
}

/**
 * The return for a tax month, derived from the payments in it.
 *
 * Derived on every read rather than stored, like every other position on this
 * platform: a return assembled once and kept would go on saying what it said
 * after a payment in that month was corrected.
 */
export function monthlyReturn(ctx: EngineContext, input: { taxMonthEndsOn: string; asAt?: string }): MonthlyReturn {
  authorise(ctx, 'PAYMENT_APPLICATIONS', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const taxMonth = taxMonthOf(input.taxMonthEndsOn);
  const payments = ctx.ledger
    .list(ctx.projectId, 'CISPayment')
    .map((record) => record.state as unknown as CisPaymentState)
    .filter((payment) => payment.taxMonthEndsOn === taxMonth.endsOn);

  const grouped = new Map<string, ReturnLine>();
  for (const payment of payments) {
    const line = grouped.get(payment.supplierId) ?? {
      supplierId: payment.supplierId,
      supplierName: payment.supplierName,
      ...(payment.verificationNumber ? { verificationNumber: payment.verificationNumber } : {}),
      status: payment.status,
      payments: 0,
      grossMinor: 0,
      materialsMinor: 0,
      labourMinor: 0,
      deductionMinor: 0,
    };
    line.payments += 1;
    line.grossMinor += payment.grossMinor;
    line.materialsMinor += payment.materialsMinor;
    line.labourMinor += payment.labourMinor;
    line.deductionMinor += payment.deductionMinor;
    grouped.set(payment.supplierId, line);
  }

  const lines = [...grouped.values()].sort((a, b) => b.deductionMinor - a.deductionMinor);
  const totals = lines.reduce(
    (sum, line) => ({
      grossMinor: sum.grossMinor + line.grossMinor,
      materialsMinor: sum.materialsMinor + line.materialsMinor,
      labourMinor: sum.labourMinor + line.labourMinor,
      deductionMinor: sum.deductionMinor + line.deductionMinor,
      subcontractors: sum.subcontractors + 1,
    }),
    { grossMinor: 0, materialsMinor: 0, labourMinor: 0, deductionMinor: 0, subcontractors: 0 },
  );

  const unverified = lines
    .filter((line) => line.status === 'UNVERIFIED')
    .map((line) => ({ supplierId: line.supplierId, supplierName: line.supplierName, deductedMinor: line.deductionMinor }));

  const asAt = input.asAt ? iso(parseDate(input.asAt)) : undefined;
  const daysLate = asAt ? daysBetween(taxMonth.returnDueBy, asAt) : 0;
  const lateness = daysLate > 0 ? { daysLate, ...penaltyFor(daysLate, totals.deductionMinor) } : undefined;

  const nil = payments.length === 0;
  return {
    taxMonth,
    nil,
    lines,
    totals,
    unverified,
    ...(lateness ? { lateness } : {}),
    status:
      'Prepared, not filed. This platform holds no Government Gateway credential and does not submit to HMRC — the ' +
      'figures and the declarations are ready for whoever files.',
    summary: nil
      ? `Nothing was paid to a subcontractor in ${taxMonth.label}. A nil return is still due by ${taxMonth.returnDueBy}, and ` +
        'not filing one is the most common penalty under the scheme.'
      : `${totals.subcontractors} subcontractor(s), ${penny(totals.grossMinor)} paid, ${penny(totals.deductionMinor)} withheld. ` +
        `Due by ${taxMonth.returnDueBy}; statements to each subcontractor by ${taxMonth.statementsDueBy}.` +
        (unverified.length > 0
          ? ` ${unverified.length} of them was paid without a verification in force — deducted at the higher rate, which is right, but verify before the next payment.`
          : ''),
  };
}

/** Every tax month this project has CIS payments in, newest first. */
export function returnsBoard(ctx: EngineContext): Array<{ taxMonthEndsOn: string; label: string; returnDueBy: string; deductionMinor: number; subcontractors: number }> {
  authorise(ctx, 'PAYMENT_APPLICATIONS', 'R', { dataSensitivity: 'COMMERCIAL_L3' });
  const months = new Map<string, { deductionMinor: number; suppliers: Set<string> }>();
  for (const record of ctx.ledger.list(ctx.projectId, 'CISPayment')) {
    const payment = record.state as unknown as CisPaymentState;
    const bucket = months.get(payment.taxMonthEndsOn) ?? { deductionMinor: 0, suppliers: new Set<string>() };
    bucket.deductionMinor += payment.deductionMinor;
    bucket.suppliers.add(payment.supplierId);
    months.set(payment.taxMonthEndsOn, bucket);
  }
  return [...months.entries()]
    .map(([taxMonthEndsOn, bucket]) => {
      const month = taxMonthOf(taxMonthEndsOn);
      return {
        taxMonthEndsOn,
        label: month.label,
        returnDueBy: month.returnDueBy,
        deductionMinor: bucket.deductionMinor,
        subcontractors: bucket.suppliers.size,
      };
    })
    .sort((a, b) => b.taxMonthEndsOn.localeCompare(a.taxMonthEndsOn));
}

// --- Dates -------------------------------------------------------------------

function parseDate(value: string): Date {
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new DomainError('CIS_DATE_INVALID', `${value} is not a date`);
  return date;
}

const iso = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * The tax year runs 6 April to 5 April. A verification lasts the year it was
 * done in plus the two following, so the expiry is the 5th of April three years
 * after the tax year it fell in began.
 */
function endOfTaxYearPlusTwo(verifiedOn: Date): string {
  const yearStartsIn = verifiedOn.getUTCMonth() > 3 || (verifiedOn.getUTCMonth() === 3 && verifiedOn.getUTCDate() >= 6)
    ? verifiedOn.getUTCFullYear()
    : verifiedOn.getUTCFullYear() - 1;
  return iso(new Date(Date.UTC(yearStartsIn + 3, 3, 5)));
}

function daysBetween(fromISO: string, toISO: string): number {
  const from = parseDate(fromISO).getTime();
  const to = parseDate(toISO).getTime();
  return Math.round((to - from) / 86_400_000);
}

const penny = (minor: number): string => `£${(minor / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
