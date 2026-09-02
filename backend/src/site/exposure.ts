import { formatMoney } from '../domain/locale.ts';

/**
 * What the payment notice regime puts at stake on one contractor's turnover.
 *
 * ## Why this exists on a marketing site
 *
 * The rest of the public site argues from the product outwards: here is what it
 * does, here is why the record holds. That argument is answering the second
 * question a managing director asks. The first is "what does this get me", and
 * it is not answerable in the abstract — a £4m jobbing builder and a £250m
 * framework contractor have the same problem at two orders of magnitude.
 *
 * So this page computes with **their** numbers rather than ours.
 *
 * ## The discipline that makes it honest rather than a lead magnet
 *
 * Every figure here is arithmetic on what the visitor typed. There is no
 * industry average in this file, no assumed miss rate, no "companies like yours
 * typically recover" — those are the numbers a vendor invents, and one invented
 * number makes a reader discount every real one beside it.
 *
 * In particular it does **not** claim a saving. It computes the size of the
 * exposure the Construction Act creates and leaves the visitor to judge how
 * often it bites them, because only they know that. A page that multiplied
 * their turnover by a miss rate we made up would produce a bigger number and a
 * worse argument.
 *
 * ## The statute this is arithmetic about
 *
 * Housing Grants, Construction and Regeneration Act 1996 s.111: where the payer
 * gives no valid payment notice and no valid pay less notice within the
 * contractual window, the sum applied for becomes the notified sum and is
 * payable in full — however optimistic the application was, and whatever the
 * work is actually worth. The exposure on one missed window is therefore the
 * *gap* between what was applied for and what the payer would have certified,
 * which is why that gap is the input this page turns on.
 */

export type ExposureInput = {
  /** Annual turnover, in pounds. */
  turnover: number;
  /** How many contracts are live and being applied against at once. */
  liveContracts: number;
  /** Applications raised per contract per month. One is the ordinary cycle. */
  applicationsPerMonth: number;
  /**
   * The typical difference between what is applied for and what the payer
   * certifies, as a percentage of the application.
   *
   * The load-bearing input. It is what a missed pay less notice costs the payer
   * and what an unanswered application is worth to the payee — and it is the one
   * figure a commercial director knows off the top of their head.
   */
  gapPercent: number;
  /** Retention held against the works, as a percentage. */
  retentionPercent: number;
};

export type ExposureLine = {
  label: string;
  value: string;
  /** What the figure is, in a sentence, so no number stands without its meaning. */
  meaning: string;
  /** The arithmetic, shown rather than hidden. */
  working: string;
  emphasis?: boolean;
};

export type ExposurePosition = {
  input: ExposureInput;
  lines: ExposureLine[];
  /** What this page will not claim, stated on the page itself. */
  notClaimed: string[];
};

/** Clamp a submitted number into a range, so a stray keystroke cannot produce nonsense. */
function bounded(raw: unknown, low: number, high: number, fallback: number): number {
  const text = String(raw ?? '').replace(/[,£\s]/g, '');
  // Empty is absent, not zero. `Number('')` is 0 and finite, so without this a
  // visitor who cleared a field would be shown a page of £0 figures and would
  // reasonably conclude the calculator was broken rather than blank.
  if (text === '') return fallback;
  const value = Number(text);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(high, Math.max(low, value));
}

/** Read a submitted form into an input, with defaults that describe an ordinary contractor. */
export function readExposureInput(body: Record<string, unknown>): ExposureInput {
  return {
    turnover: bounded(body.turnover, 0, 10_000_000_000, 40_000_000),
    liveContracts: bounded(body.liveContracts, 1, 5_000, 8),
    applicationsPerMonth: bounded(body.applicationsPerMonth, 0.25, 8, 1),
    gapPercent: bounded(body.gapPercent, 0, 100, 8),
    retentionPercent: bounded(body.retentionPercent, 0, 20, 5),
  };
}

/** In pounds, to the nearest pound, using the platform's own money formatter. */
function money(pounds: number): string {
  return formatMoney(Math.round(pounds * 100), 'GBP');
}

export function exposurePosition(input: ExposureInput): ExposurePosition {
  const windowsPerYear = input.liveContracts * input.applicationsPerMonth * 12;
  const averageApplication = windowsPerYear > 0 ? input.turnover / windowsPerYear : 0;
  const perWindow = averageApplication * (input.gapPercent / 100);
  const annualGap = input.turnover * (input.gapPercent / 100);
  const retentionHeld = input.turnover * (input.retentionPercent / 100);

  return {
    input,
    lines: [
      {
        label: 'Payment windows a year',
        value: Math.round(windowsPerYear).toLocaleString('en-GB'),
        meaning:
          'Each one has a due date, a payment notice date and a pay less notice date, and each of those dates is a ' +
          'separate opportunity for the Act to decide who is right.',
        working: `${input.liveContracts} contracts × ${input.applicationsPerMonth} a month × 12 months`,
      },
      {
        label: 'Average application',
        value: money(averageApplication),
        meaning: 'What passes through a single one of those windows.',
        working: `${money(input.turnover)} ÷ ${Math.round(windowsPerYear).toLocaleString('en-GB')} windows`,
      },
      {
        label: 'Exposure on one missed pay less notice',
        value: money(perWindow),
        meaning:
          'Where the payer gives no valid payment notice and no valid pay less notice in time, the sum applied for ' +
          'becomes the notified sum and is payable in full. The amount at stake is the gap between what was applied ' +
          'for and what would have been certified — on one application, once.',
        working: `${money(averageApplication)} × ${input.gapPercent}% applied-to-certified gap`,
        emphasis: true,
      },
      {
        label: 'Value of that gap across a year',
        value: money(annualGap),
        meaning:
          'The total sum in dispute between application and certification over twelve months. Not a loss — it is the ' +
          'money the notice regime governs, and which side of it you end up on is decided by dates.',
        working: `${money(input.turnover)} × ${input.gapPercent}%`,
      },
      {
        label: 'Retention held against you',
        value: money(retentionHeld),
        meaning:
          'Held by somebody else, released against dates and certificates that have to be evidenced when the time ' +
          'comes. A release nobody can substantiate is a release nobody makes.',
        working: `${money(input.turnover)} × ${input.retentionPercent}%`,
      },
    ],
    notClaimed: [
      'How many notices you miss. Only you know that, and a figure we invented would be the largest number on this ' +
        'page and the least trustworthy.',
      'That this platform recovers any of it. It computes the position on the day the window closes rather than at ' +
        'the month-end review; what you do with three weeks of notice is yours.',
      'An industry average, a benchmark or a comparison with your peers. There is no such figure in this arithmetic — ' +
        'every number above came from the five you typed.',
    ],
  };
}
