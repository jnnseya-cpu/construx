import { assessCycle } from '../engines/maths/constructionAct.ts';
import { buildTimetable } from '../engines/maths/adjudication.ts';
import { calculateCPM, durationAtConfidence, pert } from '../engines/maths/cpm.ts';
import { calculateEVM } from '../engines/maths/evm.ts';

/**
 * The gold set.
 *
 * ---
 *
 * **Why this exists, given that the harness beside it refuses to score
 * judgement.** That refusal stands and is not being walked back: grading
 * whether a programme is *good*, or whether a risk allowance is *prudent*,
 * needs a construction professional and not a fixture, and a harness printing a
 * mark for it would be inventing the one figure nobody could check.
 *
 * But a great deal of what this platform computes has **no room for judgement
 * at all**. The notified sum under s.111 when no pay-less notice was served is
 * not a matter of opinion; it is the applied sum, and a system returning
 * anything else is wrong. The expected duration of a three-point estimate is
 * `(o + 4m + p) / 6`. A cost performance index is earned over actual. An
 * adjudicator's decision is due 28 days from referral, extendable by 14 on the
 * referring party's consent alone.
 *
 * Those have right answers, fixed by statute, by standard or by arithmetic —
 * and a gold set of *them* is a real gold set. Every case below states the
 * authority its expected value comes from, so a quantity surveyor or a planner
 * can read the case and say whether the expected value is right, which is
 * exactly the review a gold set is supposed to be open to.
 *
 * **What the cases are for.** Not to test the maths modules — the unit tests do
 * that. These run through the same functions the engines call, so that a model
 * introduced into any of those paths cannot move an answer that was never the
 * model's to move. A gold set whose expected values were themselves produced by
 * the platform would be a circle; each expected value here is written down
 * independently, with its derivation in the comment, and computed by hand.
 *
 * **Tolerance is stated per case and is usually zero.** A statutory sum is
 * exact. A PERT mean is exact to the arithmetic. Only where the platform
 * legitimately rounds — a duration at a confidence level, computed through a
 * normal approximation — is a tolerance allowed, and it is named.
 */

export type GoldCase = {
  id: string;
  /** What the case is about, in the language of the discipline. */
  title: string;
  /**
   * Where the right answer comes from. A statute section, a standard, or the
   * formula itself — never "as implemented", which would make the case a
   * restatement of whatever the code happens to do.
   */
  authority: string;
  /** The expected value, and how it was arrived at without running the code. */
  expected: number;
  derivation: string;
  /** Absolute tolerance. Zero where the answer is exact, which is most of them. */
  tolerance: number;
  /**
   * How to write the value down for a person.
   *
   * The comparison is always numeric — that is what makes a case checkable —
   * but `425000000` is not a sum of money anybody reads and `1812412800000` is
   * not a date. The number is the answer; this is how it is said.
   */
  format: 'MONEY_MINOR' | 'DATE_EPOCH' | 'DAYS' | 'RATIO';
  /** The platform's answer, through the same path an engine takes. */
  actual: () => number;
};

/** Business-day reckoning needs real dates; these are all midweek in 2027. */
const CASES: GoldCase[] = [
  // --- The Construction Act ------------------------------------------------
  {
    id: 'hgcra.s111.no-notice',
    title: 'With no payment notice and no pay-less notice, the notified sum is the applied sum',
    authority: 'Housing Grants, Construction and Regeneration Act 1996, s.110A and s.111',
    expected: 4_250_000_00,
    derivation:
      'The payee applied for £4,250,000. Neither a payment notice nor a pay-less notice was served by its ' +
      'deadline, so under s.111 the notified sum is the sum stated in the application, and it is payable in ' +
      'full by the final date. The payer’s opinion of the work’s value does not enter into it.',
    tolerance: 0,
    format: 'MONEY_MINOR',
    actual: () =>
      assessCycle(
        {
          cycleNumber: 4,
          dueDate: '2027-03-10',
          paymentNoticeDeadline: '2027-03-15',
          payLessNoticeDeadline: '2027-03-24',
          finalDateForPayment: '2027-03-31',
          appliedMinor: 4_250_000_00,
        },
        '2027-04-01',
      ).notifiedSumMinor,
  },
  {
    id: 'hgcra.s111.late-pay-less',
    title: 'A pay-less notice served one day late does not reduce the sum',
    authority: 'HGCRA 1996 s.111(5) — the notice must be given not later than the prescribed period before the final date',
    expected: 4_250_000_00,
    derivation:
      'Same cycle, with a pay-less notice for £3,100,000 served on 25 March against a deadline of 24 March. ' +
      'Out of time, so it does not bite, and the notified sum remains the applied £4,250,000. This is the ' +
      'single most expensive date in UK construction payment and the answer is not negotiable.',
    tolerance: 0,
    format: 'MONEY_MINOR',
    actual: () =>
      assessCycle(
        {
          cycleNumber: 4,
          dueDate: '2027-03-10',
          paymentNoticeDeadline: '2027-03-15',
          payLessNoticeDeadline: '2027-03-24',
          finalDateForPayment: '2027-03-31',
          appliedMinor: 4_250_000_00,
          payLessNotice: { issuedDate: '2027-03-25', sumMinor: 3_100_000_00, basisStated: true },
        },
        '2027-04-01',
      ).notifiedSumMinor,
  },
  {
    id: 'hgcra.s111.valid-pay-less',
    title: 'A pay-less notice in time and stating its basis does reduce the sum',
    authority: 'HGCRA 1996 s.111(3)–(4)',
    expected: 3_100_000_00,
    derivation:
      'The same notice served on 23 March, in time and stating the basis of the calculation. It is effective, ' +
      'so the notified sum is the £3,100,000 the notice specifies. The case is the mirror of the one above: a ' +
      'platform that could not tell them apart would be no use to either party.',
    tolerance: 0,
    format: 'MONEY_MINOR',
    actual: () =>
      assessCycle(
        {
          cycleNumber: 4,
          dueDate: '2027-03-10',
          paymentNoticeDeadline: '2027-03-15',
          payLessNoticeDeadline: '2027-03-24',
          finalDateForPayment: '2027-03-31',
          appliedMinor: 4_250_000_00,
          payLessNotice: { issuedDate: '2027-03-23', sumMinor: 3_100_000_00, basisStated: true },
        },
        '2027-04-01',
      ).notifiedSumMinor,
  },
  {
    id: 'hgcra.s111.no-basis',
    title: 'A pay-less notice in time but stating no basis does not reduce the sum',
    authority: 'HGCRA 1996 s.111(4) — the notice must specify the basis on which the sum is calculated',
    expected: 4_250_000_00,
    derivation:
      'In time on 23 March, but with no basis stated. s.111(4) requires the basis, so the notice is ineffective ' +
      'and the applied sum stands. A notice is not made good by being early.',
    tolerance: 0,
    format: 'MONEY_MINOR',
    actual: () =>
      assessCycle(
        {
          cycleNumber: 4,
          dueDate: '2027-03-10',
          paymentNoticeDeadline: '2027-03-15',
          payLessNoticeDeadline: '2027-03-24',
          finalDateForPayment: '2027-03-31',
          appliedMinor: 4_250_000_00,
          payLessNotice: { issuedDate: '2027-03-23', sumMinor: 3_100_000_00, basisStated: false },
        },
        '2027-04-01',
      ).notifiedSumMinor,
  },

  // --- Adjudication ---------------------------------------------------------
  {
    id: 'hgcra.s108.decision-period',
    title: 'The adjudicator’s decision is due 28 days from referral',
    authority: 'HGCRA 1996 s.108(2)(c)',
    expected: Date.parse('2027-06-08T00:00:00.000Z'),
    derivation:
      'Referral served on 11 May 2027. Twenty-eight days from referral is 8 June 2027. Expressed as an epoch ' +
      'so the case compares a date without depending on how the platform formats one.',
    tolerance: 0,
    format: 'DATE_EPOCH',
    actual: () =>
      Date.parse(`${buildTimetable({ noticeDate: '2027-05-05', referralDate: '2027-05-11' }).decisionDeadline}T00:00:00.000Z`),
  },
  {
    id: 'hgcra.s108.referring-party-extension',
    title: 'The referring party alone may extend the decision by fourteen days',
    authority: 'HGCRA 1996 s.108(2)(d)',
    expected: Date.parse('2027-06-22T00:00:00.000Z'),
    derivation:
      'The same referral, with a fourteen-day extension consented to by the referring party on 20 May, after ' +
      'referral. s.108(2)(d) permits up to fourteen days on that consent alone, so the decision is due 22 June ' +
      '2027 — twenty-eight days plus fourteen from 11 May.',
    tolerance: 0,
    format: 'DATE_EPOCH',
    actual: () =>
      Date.parse(
        `${
          buildTimetable({
            noticeDate: '2027-05-05',
            referralDate: '2027-05-11',
            extensionDays: 14,
            extensionAgreedBy: 'REFERRING_PARTY',
            extensionAgreedDate: '2027-05-20',
          }).extendedDecisionDeadline
        }T00:00:00.000Z`,
      ),
  },

  // --- Programme arithmetic -------------------------------------------------
  {
    id: 'pert.expected-duration',
    title: 'The expected duration of a three-point estimate',
    authority: 'PERT: te = (o + 4m + p) / 6',
    expected: 21,
    derivation: 'o = 12, m = 20, p = 34. (12 + 80 + 34) / 6 = 126 / 6 = 21 days exactly.',
    tolerance: 0,
    format: 'DAYS',
    actual: () => pert(12, 20, 34).mean,
  },
  {
    id: 'pert.variance',
    title: 'The variance of a three-point estimate',
    authority: 'PERT: σ = (p − o) / 6, so σ² = ((p − o) / 6)²',
    expected: 13.4444,
    derivation: 'o = 12, p = 34. σ = 22 / 6 = 3.6667. σ² = 13.4444. Tolerated to four decimal places.',
    tolerance: 0.0001,
    format: 'RATIO',
    actual: () => pert(12, 20, 34).variance,
  },
  {
    id: 'cpm.critical-path',
    title: 'The critical path through a network with a longer parallel branch',
    authority: 'Critical path method: the longest path through the network determines the duration',
    expected: 24,
    derivation:
      'A→B→D takes 5 + 12 + 7 = 24 days. A→C→D takes 5 + 4 + 7 = 16. The project duration is 24 days, and C ' +
      'carries eight days of float. A platform that answered 16 would be reading the shorter branch as the ' +
      'critical one, which is the classic error this check exists to catch.',
    tolerance: 0,
    format: 'DAYS',
    actual: () =>
      calculateCPM(
        [
          { id: 'A', name: 'Enabling works', duration: 5 },
          { id: 'B', name: 'Substructure', duration: 12 },
          { id: 'C', name: 'Service diversion', duration: 4 },
          { id: 'D', name: 'Superstructure', duration: 7 },
        ],
        [
          { predecessorId: 'A', successorId: 'B', type: 'FS', lag: 0 },
          { predecessorId: 'A', successorId: 'C', type: 'FS', lag: 0 },
          { predecessorId: 'B', successorId: 'D', type: 'FS', lag: 0 },
          { predecessorId: 'C', successorId: 'D', type: 'FS', lag: 0 },
        ],
      ).projectDuration,
  },
  {
    id: 'cpm.float-on-the-shorter-branch',
    title: 'Total float on the non-critical branch',
    authority: 'Critical path method: total float = late start − early start',
    expected: 8,
    derivation:
      'In the same network, C can start on day 5 and must finish by day 17 to keep D on the critical path. ' +
      'It takes 4 days, so it carries 8 days of total float. Activities on the critical path carry none.',
    tolerance: 0,
    format: 'DAYS',
    actual: () => {
      const result = calculateCPM(
        [
          { id: 'A', name: 'Enabling works', duration: 5 },
          { id: 'B', name: 'Substructure', duration: 12 },
          { id: 'C', name: 'Service diversion', duration: 4 },
          { id: 'D', name: 'Superstructure', duration: 7 },
        ],
        [
          { predecessorId: 'A', successorId: 'B', type: 'FS', lag: 0 },
          { predecessorId: 'A', successorId: 'C', type: 'FS', lag: 0 },
          { predecessorId: 'B', successorId: 'D', type: 'FS', lag: 0 },
          { predecessorId: 'C', successorId: 'D', type: 'FS', lag: 0 },
        ],
      );
      return result.activities.find((activity) => activity.id === 'C')?.totalFloat ?? -1;
    },
  },
  {
    id: 'pert.p80-duration',
    title: 'The duration at 80% confidence',
    authority: 'Normal approximation: t(p) = te + z(p)·σ, with z(0.80) = 0.8416',
    expected: 24.086,
    derivation:
      'te = 21 days and σ² = 13.4444, so σ = 3.6667. 21 + 0.8416 × 3.6667 = 24.086 days. Tolerated to ' +
      '0.01 of a day, because the platform inverts the normal CDF numerically rather than using a table.',
    tolerance: 0.01,
    format: 'DAYS',
    actual: () => durationAtConfidence(21, 13.4444, 0.8),
  },

  // --- Earned value ---------------------------------------------------------
  {
    id: 'evm.cpi',
    title: 'Cost performance index',
    authority: 'Earned value management: CPI = EV / AC',
    expected: 0.8,
    derivation:
      '£4,000,000 earned against £5,000,000 spent. CPI = 0.80 — eighty pence of value for every pound. A ' +
      'figure above 1.0 here would be reporting a project as under budget while it is overspending by a fifth.',
    tolerance: 0.0001,
    format: 'RATIO',
    actual: () =>
      calculateEVM({
        budgetAtCompletionMinor: 20_000_000_00,
        plannedValueMinor: 5_000_000_00,
        earnedValueMinor: 4_000_000_00,
        actualCostMinor: 5_000_000_00,
      }).costPerformanceIndex,
  },
  {
    id: 'evm.spi',
    title: 'Schedule performance index',
    authority: 'Earned value management: SPI = EV / PV',
    expected: 0.8,
    derivation:
      '£4,000,000 earned against £5,000,000 planned to that date. SPI = 0.80 — the project has done four ' +
      'fifths of the work it planned by now.',
    tolerance: 0.0001,
    format: 'RATIO',
    actual: () =>
      calculateEVM({
        budgetAtCompletionMinor: 20_000_000_00,
        plannedValueMinor: 5_000_000_00,
        earnedValueMinor: 4_000_000_00,
        actualCostMinor: 5_000_000_00,
      }).schedulePerformanceIndex,
  },
  {
    id: 'evm.eac-at-current-performance',
    title: 'Forecast final cost if performance continues',
    authority: 'Earned value management: EAC = BAC / CPI',
    expected: 25_000_000_00,
    derivation:
      'A £20,000,000 budget at a CPI of 0.80 forecasts £25,000,000 at completion — a £5,000,000 overrun, ' +
      'visible from 25% complete. This is the number the whole discipline exists to produce early.',
    tolerance: 1,
    format: 'MONEY_MINOR',
    actual: () =>
      calculateEVM({
        budgetAtCompletionMinor: 20_000_000_00,
        plannedValueMinor: 5_000_000_00,
        earnedValueMinor: 4_000_000_00,
        actualCostMinor: 5_000_000_00,
      }).estimateAtCompletionMinor,
  },
];

/** The value as a person reads it. The comparison never uses this. */
export function formatGold(value: number, format: GoldCase['format']): string {
  if (!Number.isFinite(value)) return 'no answer';
  if (format === 'MONEY_MINOR') {
    return `£${(value / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (format === 'DATE_EPOCH') return new Date(value).toISOString().slice(0, 10);
  if (format === 'DAYS') return `${Number(value.toFixed(3))} day${value === 1 ? '' : 's'}`;
  return String(Number(value.toFixed(4)));
}

export type GoldCaseResult = {
  id: string;
  title: string;
  authority: string;
  derivation: string;
  expected: number;
  actual: number;
  tolerance: number;
  /** Both values as a person reads them, in the unit the case is about. */
  expectedText: string;
  actualText: string;
  pass: boolean;
};

/** Every case, without running any of them. */
export function goldCases(): Array<Omit<GoldCase, 'actual'>> {
  return CASES.map(({ actual: _actual, ...rest }) => rest);
}

/**
 * Run the gold set.
 *
 * A case that throws is a failed case rather than a failed run: one broken
 * fixture must not hide the twelve results behind it.
 */
export function runGoldSet(): GoldCaseResult[] {
  return CASES.map((item) => {
    let actual = Number.NaN;
    try {
      actual = item.actual();
    } catch {
      // Left as NaN, which fails the comparison below and is reported as the
      // case failing rather than as the harness falling over.
    }
    return {
      id: item.id,
      title: item.title,
      authority: item.authority,
      derivation: item.derivation,
      expected: item.expected,
      actual,
      tolerance: item.tolerance,
      expectedText: formatGold(item.expected, item.format),
      actualText: formatGold(actual, item.format),
      pass: Number.isFinite(actual) && Math.abs(actual - item.expected) <= item.tolerance,
    };
  });
}
