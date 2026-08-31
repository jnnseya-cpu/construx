import { DomainError } from '../../core/errors.ts';

/**
 * Working calendars, and the arithmetic every dated programme rests on.
 *
 * `cpm.ts` schedules in abstract working-day indices, which is right for a
 * simulation and wrong for a programme somebody has to work to. A real
 * programme answers "what date", and that answer depends entirely on which days
 * are working days for the crew doing the work: a 5-day site calendar, a 6-day
 * one on a critical pour, a 7-day one for a concrete cure that does not care
 * what day it is, and a shutdown week nobody works at all.
 *
 * P6 models exactly this and so does everything serious, because getting it
 * wrong is not a rounding error. Three working days from Thursday is Monday on
 * a 5-day calendar and Saturday on a 7-day one, and a programme that says
 * Saturday when the site is shut has moved every downstream date by two days
 * and will go on doing it, compounding, for the length of the job.
 *
 * ---
 *
 * ## The index
 *
 * Every operation here is a lookup rather than a loop. Counting day by day is
 * the obvious implementation and it is O(days) per call — on a three-year
 * programme with six hundred activities and a backward pass, that is tens of
 * millions of date constructions per reschedule.
 *
 * So a calendar is compiled once into the ordered list of its working dates
 * plus a date-to-ordinal map, and every question becomes an array index. The
 * span is the compile-time contract: a date outside it cannot be answered, and
 * the refusal says so rather than returning a plausible wrong day.
 */

export type CalendarException = {
  /** ISO date, YYYY-MM-DD. */
  date: string;
  /**
   * True makes an otherwise non-working day work — a Saturday pour.
   * False makes an otherwise working day not — a bank holiday or shutdown.
   */
  working: boolean;
  reason?: string;
};

export type WorkCalendar = {
  id: string;
  name: string;
  /**
   * Which weekdays are working, indexed as `Date#getUTCDay`: 0 is Sunday.
   *
   * Seven booleans exactly. Six or eight is a caller sending something else,
   * and guessing which day they meant would shift the whole programme.
   */
  workingWeekdays: boolean[];
  exceptions: CalendarException[];
  /** Hours in a standard working day, for converting units to durations. */
  hoursPerDay: number;
};

/** The five-day week almost every site actually works. */
export const STANDARD_CALENDAR: WorkCalendar = {
  id: 'STANDARD_5_DAY',
  name: 'Five-day week',
  workingWeekdays: [false, true, true, true, true, true, false],
  exceptions: [],
  hoursPerDay: 8,
};

/**
 * Every day works.
 *
 * Not a convenience: a concrete cure, a ground settlement period and a
 * contractual notice period all run through weekends, and putting them on a
 * five-day calendar adds two days of pure fiction to every one of them.
 */
export const CONTINUOUS_CALENDAR: WorkCalendar = {
  id: 'CONTINUOUS_7_DAY',
  name: 'Seven-day continuous',
  workingWeekdays: [true, true, true, true, true, true, true],
  exceptions: [],
  hoursPerDay: 24,
};

const DAY_MS = 86_400_000;

const isoOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function parseDay(iso: string, field: string): number {
  const ms = Date.parse(`${iso.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(ms)) throw new DomainError('CALENDAR_DATE_INVALID', `${field} is not a date: ${iso}`);
  return ms;
}

/**
 * A calendar compiled over a date span, so every question is an index lookup.
 *
 * Built once per schedule run and shared by both passes. Building it per call
 * would put the loop back that the index exists to remove.
 */
export type CalendarIndex = {
  calendar: WorkCalendar;
  /** Every working date in the span, ascending. */
  workingDates: string[];
  /** Working date to its ordinal in `workingDates`. */
  ordinalOf: Map<string, number>;
  /**
   * For any date in the span, the ordinal of the first working day on or after
   * it. This is what makes a non-working start date answerable: a task told to
   * start on a Sunday starts on the Monday, and the programme says so.
   */
  nextOrdinalOf: Map<string, number>;
  /** The ordinal of the last working day on or before any date in the span. */
  previousOrdinalOf: Map<string, number>;
  spanFrom: string;
  spanTo: string;
};

export function compileCalendar(calendar: WorkCalendar, spanFrom: string, spanTo: string): CalendarIndex {
  if (calendar.workingWeekdays.length !== 7) {
    throw new DomainError(
      'CALENDAR_WEEK_INVALID',
      `${calendar.name} declares ${calendar.workingWeekdays.length} weekdays. A week has seven, and guessing which ` +
        'one was meant would move every date on the programme.',
    );
  }
  if (!calendar.workingWeekdays.some(Boolean) && calendar.exceptions.every((entry) => !entry.working)) {
    throw new DomainError(
      'CALENDAR_NEVER_WORKS',
      `${calendar.name} has no working days at all. Nothing scheduled on it could ever finish, and a programme ` +
        'built on it would report an infinite duration rather than an error.',
    );
  }

  const from = parseDay(spanFrom, 'spanFrom');
  const to = parseDay(spanTo, 'spanTo');
  if (to < from) throw new DomainError('CALENDAR_SPAN_INVALID', 'A calendar span must end on or after it starts.');

  const overrides = new Map(calendar.exceptions.map((entry) => [entry.date.slice(0, 10), entry.working]));

  const workingDates: string[] = [];
  const ordinalOf = new Map<string, number>();
  const nextOrdinalOf = new Map<string, number>();
  const previousOrdinalOf = new Map<string, number>();

  const allDates: string[] = [];
  for (let ms = from; ms <= to; ms += DAY_MS) {
    const iso = isoOf(ms);
    allDates.push(iso);
    const weekday = new Date(ms).getUTCDay();
    const working = overrides.get(iso) ?? calendar.workingWeekdays[weekday] === true;
    if (working) {
      ordinalOf.set(iso, workingDates.length);
      workingDates.push(iso);
    }
  }

  // One backward sweep fills "next working day on or after"; one forward sweep
  // fills "previous on or before". Both are needed: a start date lands forward
  // onto the next working day, a finish date lands back onto the previous one.
  let next = workingDates.length;
  for (let index = allDates.length - 1; index >= 0; index -= 1) {
    const iso = allDates[index]!;
    const own = ordinalOf.get(iso);
    if (own !== undefined) next = own;
    if (next < workingDates.length) nextOrdinalOf.set(iso, next);
  }
  let previous = -1;
  for (const iso of allDates) {
    const own = ordinalOf.get(iso);
    if (own !== undefined) previous = own;
    if (previous >= 0) previousOrdinalOf.set(iso, previous);
  }

  return { calendar, workingDates, ordinalOf, nextOrdinalOf, previousOrdinalOf, spanFrom, spanTo };
}

function requireInSpan(index: CalendarIndex, iso: string, what: string): void {
  const day = iso.slice(0, 10);
  if (day < index.spanFrom || day > index.spanTo) {
    throw new DomainError(
      'CALENDAR_OUT_OF_SPAN',
      `${what} (${day}) falls outside the ${index.calendar.name} calendar, which is compiled from ${index.spanFrom} ` +
        `to ${index.spanTo}. Answering anyway would mean guessing which days were working days, and a guessed ` +
        'holiday moves every date after it.',
    );
  }
}

/** True where this exact date is a working day on this calendar. */
export function isWorkingDay(index: CalendarIndex, iso: string): boolean {
  requireInSpan(index, iso, 'That date');
  return index.ordinalOf.has(iso.slice(0, 10));
}

/**
 * The first working day on or after a date — where work told to start on a
 * Sunday actually starts.
 */
export function nextWorkingDay(index: CalendarIndex, iso: string): string {
  requireInSpan(index, iso, 'That date');
  const ordinal = index.nextOrdinalOf.get(iso.slice(0, 10));
  if (ordinal === undefined) {
    throw new DomainError(
      'CALENDAR_NO_WORKING_DAY_AFTER',
      `There is no working day on or after ${iso.slice(0, 10)} within the ${index.calendar.name} calendar's span.`,
    );
  }
  return index.workingDates[ordinal]!;
}

/** The last working day on or before a date — where a finish lands. */
export function previousWorkingDay(index: CalendarIndex, iso: string): string {
  requireInSpan(index, iso, 'That date');
  const ordinal = index.previousOrdinalOf.get(iso.slice(0, 10));
  if (ordinal === undefined) {
    throw new DomainError(
      'CALENDAR_NO_WORKING_DAY_BEFORE',
      `There is no working day on or before ${iso.slice(0, 10)} within the ${index.calendar.name} calendar's span.`,
    );
  }
  return index.workingDates[ordinal]!;
}

/**
 * Move whole calendar days, working or not.
 *
 * Needed for exactly one thing, and it is the thing a working-day step gets
 * wrong: a finish-to-start relationship means the successor may begin the
 * *day after* the predecessor finishes, and that step is a turn of the calendar
 * rather than a day of anybody's work. Taking it as a working day on the
 * predecessor's calendar makes a concrete cure — which runs through the weekend
 * — wait until Monday for a pour that finished on Friday, inventing two days on
 * every such pair.
 *
 * The lag is separate, and that one *is* measured in working days.
 */
export function addCalendarDays(iso: string, days: number): string {
  return isoOf(parseDay(iso, 'date') + days * DAY_MS);
}

/**
 * Move a number of working days from a date. Negative counts move backwards.
 *
 * The offset is applied from the *working ordinal*, so a non-working start is
 * first rolled forward (or a non-working base for a backward move rolled back).
 * Rolling the wrong way is the classic off-by-a-weekend: it produces a date
 * that looks entirely reasonable and is two days out.
 */
export function addWorkingDays(index: CalendarIndex, iso: string, days: number): string {
  const base = days >= 0 ? nextWorkingDay(index, iso) : previousWorkingDay(index, iso);
  const ordinal = (index.ordinalOf.get(base) as number) + days;
  const result = index.workingDates[ordinal];
  if (result === undefined) {
    throw new DomainError(
      'CALENDAR_OUT_OF_SPAN',
      `Moving ${days} working day(s) from ${iso.slice(0, 10)} leaves the ${index.calendar.name} calendar's compiled ` +
        `span of ${index.spanFrom} to ${index.spanTo}. Widen the span rather than accepting a date nobody checked.`,
    );
  }
  return result;
}

/**
 * Working days from one date to another, counting the first and not the second.
 *
 * The half-open convention, so `workingDaysBetween(a, a)` is 0 and a duration
 * of one day runs from a day to itself. Getting this off by one is how a
 * programme ends up a day short on every activity at once.
 */
export function workingDaysBetween(index: CalendarIndex, from: string, to: string): number {
  const start = index.ordinalOf.get(nextWorkingDay(index, from)) as number;
  const end = index.ordinalOf.get(nextWorkingDay(index, to)) as number;
  return end - start;
}

/**
 * The finish date of work of a given duration starting on a date.
 *
 * A one-day activity finishes on the day it starts; a zero-day milestone has no
 * span at all and finishes where it starts. The inclusive convention is P6's
 * and every planner's: an activity from Monday to Friday is five days, not four.
 */
export function finishOf(index: CalendarIndex, start: string, durationDays: number): string {
  if (durationDays <= 0) return nextWorkingDay(index, start);
  return addWorkingDays(index, start, durationDays - 1);
}

/** The start date implied by a finish and a duration. The inverse of `finishOf`. */
export function startOf(index: CalendarIndex, finish: string, durationDays: number): string {
  if (durationDays <= 0) return previousWorkingDay(index, finish);
  return addWorkingDays(index, finish, -(durationDays - 1));
}

/**
 * Every calendar a programme uses, compiled over one span.
 *
 * Keyed by id, with the span widened past the programme's own dates so the
 * backward pass and negative lags have somewhere to land. A pass that runs off
 * the end of its own index is the failure this padding exists to prevent, and
 * it is cheaper to compile a year of spare days than to discover it mid-pass.
 */
export function compileAll(
  calendars: WorkCalendar[],
  spanFrom: string,
  spanTo: string,
  padDays = 400,
): Map<string, CalendarIndex> {
  const from = isoOf(parseDay(spanFrom, 'spanFrom') - padDays * DAY_MS);
  const to = isoOf(parseDay(spanTo, 'spanTo') + padDays * DAY_MS);
  const compiled = new Map<string, CalendarIndex>();
  for (const calendar of calendars) compiled.set(calendar.id, compileCalendar(calendar, from, to));
  return compiled;
}
