/**
 * The Housing Grants, Construction and Regeneration Act 1996, as amended by the
 * Local Democracy, Economic Development and Construction Act 2009.
 *
 * This is the statute that decides who gets paid what, and it is unusually
 * unforgiving: the sums do not turn on who was right about the work. If the
 * payer gives no payment notice and no pay less notice, the sum the payee
 * applied for becomes the notified sum and is payable in full, however
 * optimistic the application was. A contractor can lose six figures to a diary
 * entry, and the party that loses it is usually the smaller one.
 *
 * Two deliberate boundaries.
 *
 * **Statutory periods are counted in days, not business days.** It is tempting
 * to roll a deadline off a Sunday, and it would be wrong: the Act says days and
 * a court reads days. So the deadline computed here never moves. What the
 * calendar is for is the separate, practical question of *service* — a notice
 * that expires on Christmas Day has to arrive at an office that is shut, so the
 * position reports a serve-by date alongside the statutory date and labels it
 * as what it is. Contracts that count in business days of their own (adjudication
 * timetables, many JCT provisions) can use the same calendar directly.
 *
 * With one statutory exception, in s.116(3): a period of **less than seven
 * days** excludes Christmas Day, Good Friday and bank holidays — but not
 * weekends. The exception turns on the length of the period rather than on
 * which period it is, which is what makes it easy to miss, and the Scheme's
 * five-day payment notice period falls inside it. `reckonPeriod` is the only
 * place that decides; nothing should count a statutory period by hand.
 *
 * **Nothing here invents a rate.** Statutory interest under the Late Payment of
 * Commercial Debts (Interest) Act 1998 runs at the Bank of England base rate
 * plus 8%, and the base rate is a fact about the outside world that this
 * platform is not connected to. Where it has not been supplied the entitlement
 * is stated and the amount is left unstated, rather than computed from a number
 * somebody guessed.
 */

export type UkJurisdiction = 'ENGLAND_WALES' | 'SCOTLAND' | 'NORTHERN_IRELAND';

// --- The calendar ---------------------------------------------------------------

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utc(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function parse(date: string): Date {
  return new Date(`${date.slice(0, 10)}T00:00:00.000Z`);
}

/** Gregorian Easter Sunday (Meeus/Jones/Butcher). Four holidays hang off it. */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(year, month, day);
}

function addDaysTo(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/** The nth given weekday of a month; n = -1 means the last one. */
function weekdayOfMonth(year: number, month: number, weekday: number, n: number): Date {
  if (n === -1) {
    const last = utc(year, month + 1, 0);
    const back = (last.getUTCDay() - weekday + 7) % 7;
    return addDaysTo(last, -back);
  }
  const first = utc(year, month, 1);
  const forward = (weekday - first.getUTCDay() + 7) % 7;
  return addDaysTo(first, forward + (n - 1) * 7);
}

function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

/**
 * The standing bank holidays for a year and jurisdiction.
 *
 * Standing is the operative word. One-off holidays — a coronation, a state
 * funeral, a jubilee — are created by royal proclamation and cannot be derived
 * from a rule, so they are supplied through `additionalHolidays` rather than
 * guessed at. A calendar that silently omitted one would be wrong in exactly
 * the year somebody most needed it; one that invented one would be worse.
 */
function fixedDateHolidays(year: number, jurisdiction: UkJurisdiction): Date[] {
  const fixed: Date[] = [utc(year, 1, 1)];
  if (jurisdiction === 'SCOTLAND') fixed.push(utc(year, 1, 2));
  if (jurisdiction === 'NORTHERN_IRELAND') {
    fixed.push(utc(year, 3, 17)); // St Patrick's Day
    fixed.push(utc(year, 7, 12)); // Battle of the Boyne
  }
  if (jurisdiction === 'SCOTLAND') fixed.push(utc(year, 11, 30)); // St Andrew's Day
  fixed.push(utc(year, 12, 25));
  fixed.push(utc(year, 12, 26));
  return fixed;
}

export function bankHolidays(year: number, jurisdiction: UkJurisdiction = 'ENGLAND_WALES'): string[] {
  const easter = easterSunday(year);
  // Fixed-date holidays take a substitute weekday when they fall at a weekend.
  const fixed = fixedDateHolidays(year, jurisdiction);
  const moveable: Date[] = [];

  moveable.push(addDaysTo(easter, -2)); // Good Friday
  if (jurisdiction !== 'SCOTLAND') moveable.push(addDaysTo(easter, 1)); // Easter Monday
  moveable.push(weekdayOfMonth(year, 5, 1, 1)); // Early May: first Monday
  moveable.push(weekdayOfMonth(year, 5, 1, -1)); // Spring: last Monday
  moveable.push(
    jurisdiction === 'SCOTLAND'
      ? weekdayOfMonth(year, 8, 1, 1) // Scotland takes the first Monday in August
      : weekdayOfMonth(year, 8, 1, -1),
  );

  const holidays = new Set(moveable.map(iso));

  // Substitution: the next weekday that is not already a holiday. Applied in
  // date order so Christmas and Boxing Day landing at a weekend produce two
  // distinct substitutes rather than colliding on the same Monday.
  for (const date of fixed.sort((a, b) => a.getTime() - b.getTime())) {
    let candidate = date;
    while (isWeekend(candidate) || holidays.has(iso(candidate))) {
      candidate = addDaysTo(candidate, 1);
    }
    holidays.add(iso(candidate));
  }

  return [...holidays].sort();
}

export type BusinessCalendar = {
  jurisdiction: UkJurisdiction;
  /** Proclaimed one-off holidays, which no rule can derive. */
  additionalHolidays: string[];
};

export const DEFAULT_CALENDAR: BusinessCalendar = { jurisdiction: 'ENGLAND_WALES', additionalHolidays: [] };

const holidayCache = new Map<string, Set<string>>();

function holidaySet(year: number, calendar: BusinessCalendar): Set<string> {
  const key = `${calendar.jurisdiction}:${year}`;
  let set = holidayCache.get(key);
  if (!set) {
    set = new Set(bankHolidays(year, calendar.jurisdiction));
    holidayCache.set(key, set);
  }
  return set;
}

export function isBusinessDay(date: string, calendar: BusinessCalendar = DEFAULT_CALENDAR): boolean {
  const parsed = parse(date);
  if (isWeekend(parsed)) return false;
  if (calendar.additionalHolidays.includes(date.slice(0, 10))) return false;
  return !holidaySet(parsed.getUTCFullYear(), calendar).has(date.slice(0, 10));
}

/** The last business day on or before a date. */
export function businessDayOnOrBefore(date: string, calendar: BusinessCalendar = DEFAULT_CALENDAR): string {
  let candidate = parse(date);
  // A fortnight is more than enough for any run of weekend and holidays.
  for (let i = 0; i < 14; i++) {
    if (isBusinessDay(iso(candidate), calendar)) return iso(candidate);
    candidate = addDaysTo(candidate, -1);
  }
  return iso(candidate);
}

/** The first business day on or after a date. */
export function businessDayOnOrAfter(date: string, calendar: BusinessCalendar = DEFAULT_CALENDAR): string {
  let candidate = parse(date);
  for (let i = 0; i < 14; i++) {
    if (isBusinessDay(iso(candidate), calendar)) return iso(candidate);
    candidate = addDaysTo(candidate, 1);
  }
  return iso(candidate);
}

/**
 * Reckon a statutory period the way s.116 of the Act requires.
 *
 * This is the exception to "the statute counts days, not business days", and it
 * is a narrow one that is easy to miss because it turns on the *length* of the
 * period rather than on which period it is.
 *
 * **s.116(2)** — the period begins immediately after the specified date. Day
 * one is the day after, which is ordinary date arithmetic.
 *
 * **s.116(3)** — where the period is **less than seven days**, it does not
 * include Christmas Day, Good Friday, or a day which is a bank holiday. Note
 * what that does *not* say: Saturdays and Sundays still count. The subsection
 * excludes three named categories, not the weekend, and treating it as a
 * business-day count would push every short deadline too far out.
 *
 * Christmas Day and Good Friday are named separately from bank holidays in the
 * statute because in England and Wales they are common law holidays rather than
 * bank holidays. That distinction matters here: when 25 December falls on a
 * Saturday the bank holiday is the following Monday, but 25 December itself is
 * still excluded from the count, even though a Saturday would otherwise be
 * counted.
 *
 * Only forward periods are reckoned this way. A pay less notice is required
 * "not later than N days before the final date", which is not an act required
 * to be done within a period after a date, and the Scheme's seven-day period
 * would fall outside s.116(3) in any event.
 */
export function reckonPeriod(fromDate: string, days: number, calendar: BusinessCalendar = DEFAULT_CALENDAR): string {
  if (days <= 0) return fromDate.slice(0, 10);

  let candidate = parse(fromDate);

  // Seven days or more: plain calendar days, and the deadline never moves.
  if (days >= 7) return iso(addDaysTo(candidate, days));

  let remaining = days;
  while (remaining > 0) {
    candidate = addDaysTo(candidate, 1);
    if (!excludedFromShortPeriod(candidate, calendar)) remaining -= 1;
  }
  return iso(candidate);
}

/**
 * Christmas Day, Good Friday, or a bank holiday — the three s.116(3) names.
 *
 * Wider than the business-day calendar, and deliberately so. That calendar
 * answers "was the office open", so when Boxing Day falls on a Saturday it
 * carries only the substitute Monday: nothing is lost, because Saturday was
 * never a working day. Here it would be lost. s.116(3) counts Saturdays, so a
 * bank holiday that falls on one has to be excluded explicitly or it is
 * silently counted — and the deadline comes out a day early.
 */
function excludedFromShortPeriod(date: Date, calendar: BusinessCalendar): boolean {
  const day = iso(date);
  const year = date.getUTCFullYear();

  if (calendar.additionalHolidays.includes(day)) return true;
  // The substitutes, Good Friday, Easter Monday and the Monday holidays.
  if (holidaySet(year, calendar).has(day)) return true;

  // Christmas Day, whatever weekday it lands on. The statute names the day
  // itself — it is a common law holiday rather than a bank holiday, which is
  // exactly why s.116(3) lists it separately from them.
  if (date.getUTCMonth() === 11 && date.getUTCDate() === 25) return true;

  // The remaining fixed-date bank holidays are appointed "if it be not a
  // Sunday" (Banking and Financial Dealings Act 1971, Sch 1), so the original
  // is a holiday on a Saturday even though the substitute Monday is one too.
  if (date.getUTCDay() !== 0) {
    for (const fixed of fixedDateHolidays(year, calendar.jurisdiction)) {
      if (iso(fixed) === day) return true;
    }
  }

  return false;
}

/** Count business days forward. Used by contract terms that count that way; never by the statute. */
export function addBusinessDays(date: string, days: number, calendar: BusinessCalendar = DEFAULT_CALENDAR): string {
  let candidate = parse(date);
  let remaining = Math.abs(days);
  const step = days < 0 ? -1 : 1;
  while (remaining > 0) {
    candidate = addDaysTo(candidate, step);
    if (isBusinessDay(iso(candidate), calendar)) remaining -= 1;
  }
  return iso(candidate);
}

export function businessDaysBetween(from: string, to: string, calendar: BusinessCalendar = DEFAULT_CALENDAR): number {
  if (to < from) return -businessDaysBetween(to, from, calendar);
  let count = 0;
  let candidate = parse(from);
  const end = parse(to);
  while (candidate < end) {
    candidate = addDaysTo(candidate, 1);
    if (isBusinessDay(iso(candidate), calendar)) count += 1;
  }
  return count;
}

// --- What the statute requires ----------------------------------------------------

/**
 * The Scheme for Construction Contracts fallbacks.
 *
 * These are what applies where the contract says nothing, or says something the
 * Act will not permit. They are the defaults a contract is measured against,
 * not a suggestion.
 */
export const SCHEME_DEFAULTS = {
  /** Scheme: the due date is 7 days after the end of the relevant period, or the making of a claim if later. */
  dueDateDaysAfterPeriodEnd: 7,
  /** s.110A: a payment notice not later than 5 days after the payment due date. */
  paymentNoticeDays: 5,
  /** Scheme: the final date for payment is 17 days after the due date. */
  finalDateDays: 17,
  /** s.111: the prescribed period for a pay less notice. The Scheme sets 7 days before the final date. */
  payLessNoticeDaysBeforeFinal: 7,
  /** s.112: the notice period before performance may be suspended for non-payment. */
  suspensionNoticeDays: 7,
  /** s.109: below this contract duration there is no statutory right to periodic payment. */
  periodicPaymentThresholdDays: 45,
  /** Late Payment of Commercial Debts (Interest) Act 1998: base rate plus this margin. */
  statutoryInterestMarginPercent: 8,
} as const;

export type ContractPaymentTerms = {
  applicationDayOfMonth: number;
  paymentNoticeDays: number;
  payLessNoticeDaysBeforeFinal: number;
  finalDateDays: number;
};

export type TermsFinding = {
  /** The section or regulation the finding rests on. */
  authority: string;
  severity: 'VOID' | 'ONEROUS' | 'COMPLIANT';
  finding: string;
  /** What replaces the term where it is void, or what to negotiate where it is merely bad. */
  consequence: string;
};

/**
 * Assess a contract's payment terms against the Act.
 *
 * The distinction that matters is between a term that is *void* and a term that
 * is merely *bad*. A void term is replaced by the Scheme whether anybody
 * noticed or not, so a contractor who priced for 60-day payment on a term the
 * Act strikes out has priced for a cost he does not carry. A bad-but-lawful
 * term is a commercial decision and stays the contractor's problem.
 */
export function assessPaymentTerms(terms: ContractPaymentTerms, contractDurationDays?: number): TermsFinding[] {
  const findings: TermsFinding[] = [];

  if (terms.paymentNoticeDays > SCHEME_DEFAULTS.paymentNoticeDays) {
    findings.push({
      authority: 'HGCRA 1996 s.110A(2)',
      severity: 'VOID',
      finding: `The contract allows ${terms.paymentNoticeDays} days for the payment notice; the Act allows 5 days after the due date.`,
      consequence: 'The statutory period applies. A notice given on the contractual date would be out of time and ineffective.',
    });
  }

  if (terms.payLessNoticeDaysBeforeFinal < 1) {
    findings.push({
      authority: 'HGCRA 1996 s.111(5)',
      severity: 'VOID',
      finding: 'The contract sets no prescribed period for a pay less notice.',
      consequence: `The Scheme applies: ${SCHEME_DEFAULTS.payLessNoticeDaysBeforeFinal} days before the final date for payment.`,
    });
  }

  if (terms.payLessNoticeDaysBeforeFinal >= terms.finalDateDays) {
    findings.push({
      authority: 'HGCRA 1996 s.111(5)',
      severity: 'VOID',
      finding:
        `A pay less notice is required ${terms.payLessNoticeDaysBeforeFinal} days before a final date that is only ` +
        `${terms.finalDateDays} days after the due date, so the period expires on or before the due date itself.`,
      consequence: 'The prescribed period cannot begin before the sum is due. The Scheme period applies instead.',
    });
  }

  // Not unlawful, but the thing that actually breaks small contractors. The Act
  // caps nothing here, so this is reported as a commercial position and not as
  // a legal defect.
  if (terms.finalDateDays > 30) {
    findings.push({
      authority: 'Commercial',
      severity: 'ONEROUS',
      finding: `The final date for payment is ${terms.finalDateDays} days after the due date, against a Scheme default of ${SCHEME_DEFAULTS.finalDateDays}.`,
      consequence: `${terms.finalDateDays - SCHEME_DEFAULTS.finalDateDays} additional days of working capital funded on every cycle. Price it or negotiate it.`,
    });
  }

  if (contractDurationDays !== undefined && contractDurationDays < SCHEME_DEFAULTS.periodicPaymentThresholdDays) {
    findings.push({
      authority: 'HGCRA 1996 s.109(1)',
      severity: 'COMPLIANT',
      finding: `The contract duration is ${contractDurationDays} days, under the 45-day threshold for a statutory right to periodic payment.`,
      consequence: 'Interim payment is a matter for the contract. There is no statutory entitlement to fall back on.',
    });
  }

  if (findings.length === 0) {
    findings.push({
      authority: 'HGCRA 1996 ss.109-111',
      severity: 'COMPLIANT',
      finding: 'The payment terms meet the Act.',
      consequence: 'No statutory substitution applies.',
    });
  }

  return findings;
}

// --- The statutory position on one cycle -----------------------------------------

export type NoticeRecord = {
  /** ISO date the notice was given. */
  issuedDate: string;
  /** The sum the notice states is due. s.111(4) requires this, and the basis for it. */
  sumMinor: number;
  /** Whether the notice sets out the basis on which the sum was calculated. */
  basisStated: boolean;
};

export type CyclePosition = {
  cycleNumber: number;
  dueDate: string;
  finalDateForPayment: string;
  appliedMinor: number;
  /**
   * The sum that is payable by the final date, whatever anybody thinks the work
   * was worth. This is the number the Act produces.
   */
  notifiedSumMinor: number;
  notifiedSumSource:
    | 'PAY_LESS_NOTICE'
    | 'PAYMENT_NOTICE'
    | 'APPLICATION_BY_DEFAULT'
    | 'NOT_YET_DETERMINED';
  paidMinor: number;
  shortfallMinor: number;
  /** Money at risk because a notice was missed, late or invalid. */
  exposureMinor: number;
  findings: StatutoryFinding[];
  /** Statutory deadlines with the practical date by which a notice must actually be served. */
  deadlines: Array<{ notice: string; statutoryDate: string; serveBy: string; movedForService: boolean }>;
  /** True once the final date has passed with the notified sum unpaid. */
  suspensionAvailable: boolean;
  suspensionEarliestDate?: string;
};

export type StatutoryFinding = {
  authority: string;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  finding: string;
  /** What it costs, or what to do, in terms somebody can act on today. */
  consequence: string;
};

export type CycleInput = {
  cycleNumber: number;
  dueDate: string;
  paymentNoticeDeadline: string;
  payLessNoticeDeadline: string;
  finalDateForPayment: string;
  /** The payee's application. Absent where none was made. */
  appliedMinor?: number;
  paymentNotice?: NoticeRecord;
  payLessNotice?: NoticeRecord;
  paidMinor?: number;
};

/**
 * Work out where one payment cycle actually stands under the Act.
 *
 * The order of the tests is the order the statute applies them, and it is the
 * whole substance: a pay less notice only bites if it is in time and states its
 * basis; a payment notice only bites if it is in time; and if neither survives,
 * the application is the notified sum. Getting that order wrong produces a
 * number that looks authoritative and is not.
 */
export function assessCycle(input: CycleInput, today: string, calendar: BusinessCalendar = DEFAULT_CALENDAR): CyclePosition {
  const findings: StatutoryFinding[] = [];
  const applied = input.appliedMinor ?? 0;
  const paid = input.paidMinor ?? 0;

  const paymentNoticeInTime =
    input.paymentNotice !== undefined && input.paymentNotice.issuedDate <= input.paymentNoticeDeadline;
  const payLessInTime = input.payLessNotice !== undefined && input.payLessNotice.issuedDate <= input.payLessNoticeDeadline;
  const payLessValid = payLessInTime && input.payLessNotice?.basisStated === true;

  let notifiedSumMinor = 0;
  let notifiedSumSource: CyclePosition['notifiedSumSource'] = 'NOT_YET_DETERMINED';

  if (input.payLessNotice && !payLessInTime) {
    findings.push({
      authority: 'HGCRA 1996 s.111(5)',
      severity: 'CRITICAL',
      finding: `The pay less notice was given on ${input.payLessNotice.issuedDate}, after the prescribed period expired on ${input.payLessNoticeDeadline}.`,
      consequence: 'It is ineffective. The deduction it makes cannot be made, and the earlier notified sum stands.',
    });
  } else if (input.payLessNotice && !input.payLessNotice.basisStated) {
    findings.push({
      authority: 'HGCRA 1996 s.111(4)',
      severity: 'CRITICAL',
      finding: 'The pay less notice states a sum but not the basis on which it was calculated.',
      consequence: 'A notice without the basis of calculation is liable to be held invalid, leaving the earlier notified sum payable in full.',
    });
  }

  if (input.paymentNotice && !paymentNoticeInTime) {
    findings.push({
      authority: 'HGCRA 1996 s.110A(2)',
      severity: 'CRITICAL',
      finding: `The payment notice was given on ${input.paymentNotice.issuedDate}, after the deadline of ${input.paymentNoticeDeadline}.`,
      consequence: 'A late payment notice is not a payment notice. Unless a valid pay less notice follows, the sum applied for becomes the notified sum.',
    });
  }

  if (payLessValid && input.payLessNotice) {
    notifiedSumMinor = input.payLessNotice.sumMinor;
    notifiedSumSource = 'PAY_LESS_NOTICE';
  } else if (paymentNoticeInTime && input.paymentNotice) {
    notifiedSumMinor = input.paymentNotice.sumMinor;
    notifiedSumSource = 'PAYMENT_NOTICE';
  } else if (input.appliedMinor !== undefined) {
    // The position the Act is famous for. No effective notice from the payer
    // means the application is the notified sum, whatever it says.
    const noticesDue = today > input.paymentNoticeDeadline;
    if (noticesDue) {
      notifiedSumMinor = applied;
      notifiedSumSource = 'APPLICATION_BY_DEFAULT';
      if (!input.paymentNotice && !input.payLessNotice) {
        findings.push({
          authority: 'HGCRA 1996 s.111(1)',
          severity: 'CRITICAL',
          finding: `No payment notice and no pay less notice were given for cycle ${input.cycleNumber}.`,
          consequence: 'The sum applied for is the notified sum and is payable in full by the final date, regardless of the true value of the work.',
        });
      }
    }
  }

  // Exposure is the money that changes hands because of the notices rather than
  // because of the work: what the payer must now pay above what it decided the
  // work was worth.
  let exposure = 0;
  if (notifiedSumSource === 'APPLICATION_BY_DEFAULT') {
    const intended = input.paymentNotice?.sumMinor ?? input.payLessNotice?.sumMinor ?? 0;
    exposure = Math.max(0, applied - intended);
  } else if (notifiedSumSource === 'PAYMENT_NOTICE' && input.payLessNotice && !payLessValid) {
    exposure = Math.max(0, input.paymentNotice!.sumMinor - input.payLessNotice.sumMinor);
  }

  const shortfall = Math.max(0, notifiedSumMinor - paid);
  const overdue = today > input.finalDateForPayment && shortfall > 0;

  if (overdue) {
    findings.push({
      authority: 'HGCRA 1996 s.111(1)',
      severity: 'CRITICAL',
      finding: `The notified sum was not paid by the final date for payment of ${input.finalDateForPayment}.`,
      consequence:
        `Statutory interest runs at the Bank of England base rate plus ${SCHEME_DEFAULTS.statutoryInterestMarginPercent}% ` +
        '(Late Payment of Commercial Debts (Interest) Act 1998). The base rate is not held by the platform, so the amount is not stated here.',
    });
    findings.push({
      authority: 'HGCRA 1996 s.112',
      severity: 'WARNING',
      finding: 'The right to suspend performance for non-payment is available.',
      consequence: `Seven days' written notice is required before suspension. Costs and time arising from a lawful suspension are recoverable.`,
    });
  }

  const deadlines = [
    { notice: 'Payment notice', statutoryDate: input.paymentNoticeDeadline },
    { notice: 'Pay less notice', statutoryDate: input.payLessNoticeDeadline },
    { notice: 'Final date for payment', statutoryDate: input.finalDateForPayment },
  ].map(({ notice, statutoryDate }) => {
    const serveBy = businessDayOnOrBefore(statutoryDate, calendar);
    return { notice, statutoryDate, serveBy, movedForService: serveBy !== statutoryDate };
  });

  for (const deadline of deadlines.filter((d) => d.movedForService && d.statutoryDate >= today)) {
    findings.push({
      authority: 'Service',
      severity: 'WARNING',
      finding: `The ${deadline.notice.toLowerCase()} deadline of ${deadline.statutoryDate} is not a business day.`,
      consequence: `The statutory date does not move. Serve by ${deadline.serveBy} so the notice is received in time.`,
    });
  }

  return {
    cycleNumber: input.cycleNumber,
    dueDate: input.dueDate,
    finalDateForPayment: input.finalDateForPayment,
    appliedMinor: applied,
    notifiedSumMinor,
    notifiedSumSource,
    paidMinor: paid,
    shortfallMinor: shortfall,
    exposureMinor: exposure,
    findings,
    deadlines,
    suspensionAvailable: overdue,
    suspensionEarliestDate: overdue ? addDaysTo(parse(today), SCHEME_DEFAULTS.suspensionNoticeDays).toISOString().slice(0, 10) : undefined,
  };
}

export type CompliancePosition = {
  cycles: CyclePosition[];
  /** Total money at risk from missed, late or invalid notices across the contract. */
  totalExposureMinor: number;
  /** Notified sums unpaid past their final date. */
  totalOverdueMinor: number;
  criticalCount: number;
  /** The next deadline anybody has to do something about, and how long is left. */
  nextAction?: { notice: string; cycleNumber: number; serveBy: string; daysRemaining: number };
  summary: string;
};

/** The whole contract's statutory position, which is the view a director needs. */
export function compliancePosition(
  cycles: CycleInput[],
  today: string,
  calendar: BusinessCalendar = DEFAULT_CALENDAR,
): CompliancePosition {
  const assessed = cycles.map((cycle) => assessCycle(cycle, today, calendar));

  const totalExposure = assessed.reduce((sum, c) => sum + c.exposureMinor, 0);
  const totalOverdue = assessed
    .filter((c) => today > c.finalDateForPayment)
    .reduce((sum, c) => sum + c.shortfallMinor, 0);
  const criticalCount = assessed.reduce((sum, c) => sum + c.findings.filter((f) => f.severity === 'CRITICAL').length, 0);

  const upcoming = assessed
    .flatMap((cycle) =>
      cycle.deadlines
        .filter((d) => d.notice !== 'Final date for payment' && d.statutoryDate >= today)
        .map((d) => ({ notice: d.notice, cycleNumber: cycle.cycleNumber, serveBy: d.serveBy })),
    )
    .sort((a, b) => a.serveBy.localeCompare(b.serveBy));

  const next = upcoming[0];
  const nextAction = next
    ? {
        ...next,
        daysRemaining: Math.round((Date.parse(next.serveBy) - Date.parse(today)) / 86_400_000),
      }
    : undefined;

  const summary =
    criticalCount === 0
      ? `Statutory position clean across ${assessed.length} ${assessed.length === 1 ? 'cycle' : 'cycles'}.`
      : `${criticalCount} statutory ${criticalCount === 1 ? 'failure' : 'failures'} across ${assessed.length} ${assessed.length === 1 ? 'cycle' : 'cycles'}.`;

  return { cycles: assessed, totalExposureMinor: totalExposure, totalOverdueMinor: totalOverdue, criticalCount, nextAction, summary };
}
