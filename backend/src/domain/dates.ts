import { ValidationError } from '../core/errors.ts';

/**
 * Date invariants that the schema cannot express.
 *
 * `format: 'date'` proves a string is shaped like a date. It cannot say that a
 * pay less notice was not issued in 2031, that a delay ended before it started,
 * or that a project completes before it begins. None of those were checked, so
 * all three were accepted — into an append-only ledger, where a wrong date is
 * not a bad field but a permanent record that has to be corrected by a further
 * event rather than repaired.
 *
 * These are business rules, not syntax, which is why they live in the domain
 * and not in `core/validate.ts`. The `<input type="date">` bounds in the
 * console are an affordance for the same rules, never the enforcement: the
 * browser holds no rule the API does not enforce independently.
 */

/** The day part of an ISO date or date-time, which is what these rules compare. */
function day(value: string): string {
  return value.slice(0, 10);
}

/**
 * `now` is a parameter rather than a call to `Date.now()` inside each guard so
 * a test can state the day it is reasoning about instead of arranging one.
 */
function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * A date that records something that has already happened.
 *
 * Applied to the dates that carry legal weight — when a notice was served, when
 * a decision was handed down, when plant was installed. A future date on any of
 * those is not a typo the reader can discount; it is the date the record says
 * the thing happened, and statutory periods are counted from it.
 */
export function assertNotFuture(value: string, field: string, now = new Date()): void {
  if (day(value) > today(now)) {
    throw new ValidationError(`${field} cannot be in the future`, [
      { field, message: `must not be later than ${today(now)}` },
    ]);
  }
}

/**
 * A date by which something must still happen. A due date already past is
 * either a mistake or a record that should have been raised earlier, and the
 * countdown built on it reads as overdue the moment it is created.
 */
export function assertNotPast(value: string, field: string, now = new Date()): void {
  if (day(value) < today(now)) {
    throw new ValidationError(`${field} cannot be in the past`, [
      { field, message: `must not be earlier than ${today(now)}` },
    ]);
  }
}

/**
 * Two dates that bound a period. Equal is allowed: a delay, an inspection and
 * an occupation can all begin and end on the same day.
 */
export function assertOrder(start: string, end: string, startField: string, endField: string): void {
  if (day(end) < day(start)) {
    throw new ValidationError(`${endField} cannot be before ${startField}`, [
      { field: endField, message: `must not be earlier than ${startField} (${day(start)})` },
    ]);
  }
}
