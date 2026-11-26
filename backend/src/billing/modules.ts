import { addonMonthlyMinorForSeats, ADDON_ADDITIONAL_SEAT_FEE_MINOR, ADDON_BASE_FEE_MINOR } from './addon.ts';

/**
 * Every private module is a monthly item on the company's subscription.
 *
 * One price for all of them, the one the Grid Connection add-on was first sold
 * at: the base fee covers one named seat, and each further seat is charged on
 * top (`billing/addon.ts`, the single source of both figures). The operator
 * still decides who holds a module; holding it is what puts it on the bill.
 *
 * It is raised with the package in the same monthly charge and shown on the
 * same invoice, so a module is usable for exactly as long as that charge is
 * paid: an unpaid charge past its grace suspends the tenancy, modules and all,
 * by the mechanism that already stops everything else (`billing/collection.ts`).
 *
 * A free-exempt account holds its modules free, as it holds the rest of the
 * platform, and for the term of its exemption only. A company in a paying
 * group pays for the modules it holds itself, as it always has for Grid: the
 * group's coverage is of the package, not of what is sold on top of it.
 */

export const MODULE_INCLUDED_SEATS = 1;
export const MODULE_BASE_FEE_MINOR = ADDON_BASE_FEE_MINOR;
export const MODULE_ADDITIONAL_SEAT_FEE_MINOR = ADDON_ADDITIONAL_SEAT_FEE_MINOR;

/** The most seats one allocation may carry; a larger company is a conversation, not a typo. */
export const MODULE_MAX_SEATS = 500;

export type ModuleCharge = { moduleId: string; name: string; seats: number; amountMinor: number };

/** What one module costs a month, at the seats it is held with. */
export const moduleMonthlyMinor = (seats: number): number => addonMonthlyMinorForSeats(seats);

/** The month's module lines for one company: none for an exempt account. */
export function moduleCharges(held: ReadonlyArray<{ moduleId: string; name: string; seats: number }>, exempt: boolean): ModuleCharge[] {
  if (exempt) return [];
  return held.map((entry) => {
    const seats = Math.max(MODULE_INCLUDED_SEATS, Math.floor(entry.seats));
    return { moduleId: entry.moduleId, name: entry.name, seats, amountMinor: moduleMonthlyMinor(seats) };
  });
}

/** The price as a sentence, from the figures rather than restated beside them. */
export function modulePriceSentence(): string {
  const pounds = (minor: number) => `£${(minor / 100).toLocaleString('en-GB', { maximumFractionDigits: 2 })}`;
  return `${pounds(MODULE_BASE_FEE_MINOR)}/month including one named seat, plus ${pounds(MODULE_ADDITIONAL_SEAT_FEE_MINOR)}/month for each additional seat`;
}
