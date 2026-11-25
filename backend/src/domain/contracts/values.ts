import { DomainError } from '../../core/errors.ts';
import type { FieldDef } from './schedules.ts';

/**
 * One form for every value a contract draft holds, whoever entered it.
 *
 * Money is a decimal string in the draft's currency ("1250000.00"), never a
 * float and never with its symbol; a percentage a bounded decimal ("3.5"); a
 * date an ISO local date; a duration a whole number and a unit ("12 MONTHS").
 * Two sources that say "£1,250,000" and "1.25m" are then seen to agree, and two
 * that look alike but differ are seen to differ.
 *
 * What cannot be read as its type is refused, never guessed: "about £1m",
 * "TBC" and "as per the tender" are not a contract sum.
 */

const UNITS: Record<string, 'DAYS' | 'WEEKS' | 'MONTHS' | 'YEARS'> = {
  d: 'DAYS', day: 'DAYS', days: 'DAYS',
  w: 'WEEKS', wk: 'WEEKS', wks: 'WEEKS', week: 'WEEKS', weeks: 'WEEKS',
  m: 'MONTHS', mo: 'MONTHS', mth: 'MONTHS', mths: 'MONTHS', month: 'MONTHS', months: 'MONTHS',
  y: 'YEARS', yr: 'YEARS', yrs: 'YEARS', year: 'YEARS', years: 'YEARS',
};

const refuse = (field: FieldDef, message: string): never => {
  throw new DomainError('CONTRACT_FIELD_VALUE', `${field.label}: ${message}`, 422, [{ field: 'value', message }]);
};

/** The currencies a contract draft is written in: the UK market's, and the two it most often prices against. */
export const DRAFT_CURRENCIES = ['GBP', 'EUR', 'USD'] as const;
const SYMBOL: Record<string, string> = { '£': 'GBP', '€': 'EUR', $: 'USD' };

function money(field: FieldDef, raw: string, currency: string): string {
  const code = /^(GBP|EUR|USD)\b/i.exec(raw)?.[1]?.toUpperCase() ?? SYMBOL[raw.charAt(0)];
  // An amount in another currency is not this draft's amount, converted or otherwise.
  if (code && code !== currency) return refuse(field, `an amount in ${currency}; this one is in ${code}`);
  const cleaned = raw.replace(/^(GBP|EUR|USD)\s*/i, '').replace(/^[£€$]\s*/, '').replace(/,/g, '').trim();
  const scaled = /^(\d+(?:\.\d+)?)\s*(m|bn|k)$/i.exec(cleaned);
  let amount: number;
  if (scaled) {
    const factor = { k: 1e3, m: 1e6, bn: 1e9 }[scaled[2]!.toLowerCase() as 'k' | 'm' | 'bn'];
    amount = Number(scaled[1]) * factor;
  } else if (/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    amount = Number(cleaned);
  } else {
    return refuse(field, 'an amount, such as 1,250,000 or 1,250,000.00');
  }
  if (!Number.isFinite(amount) || amount < 0 || amount > 1e13) return refuse(field, 'an amount, such as 1,250,000 or 1,250,000.00');
  // Whole pennies, as a string: never a float on the record.
  return (Math.round(amount * 100) / 100).toFixed(2);
}

function percent(field: FieldDef, raw: string): string {
  const cleaned = raw.replace(/%$/, '').trim();
  if (!/^\d+(\.\d{1,3})?$/.test(cleaned)) return refuse(field, 'a percentage, such as 3 or 3.5');
  const value = Number(cleaned);
  if (value > 100) return refuse(field, 'a percentage between 0 and 100');
  return String(value);
}

function date(field: FieldDef, raw: string): string {
  let y: number, m: number, d: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const uk = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (uk) [y, m, d] = [Number(uk[3]), Number(uk[2]), Number(uk[1])];
  else return refuse(field, 'a date, as YYYY-MM-DD or DD/MM/YYYY');
  const value = new Date(Date.UTC(y, m - 1, d));
  if (value.getUTCFullYear() !== y || value.getUTCMonth() !== m - 1 || value.getUTCDate() !== d) return refuse(field, 'a real calendar date');
  return value.toISOString().slice(0, 10);
}

function duration(field: FieldDef, raw: string): string {
  const match = /^(\d{1,4})\s*([a-z]+)$/i.exec(raw);
  const unit = match ? UNITS[match[2]!.toLowerCase()] : undefined;
  if (!match || !unit || Number(match[1]) < 1) return refuse(field, 'a period, such as 12 months, 52 weeks or 14 days');
  return `${Number(match[1])} ${unit}`;
}

/** The value as the record holds it, or a refusal saying what was expected. */
export function normalise(field: FieldDef, value: unknown, currency: string): string {
  const raw = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
  if (raw === '') return refuse(field, 'a value is needed; clear the field instead of saving it empty');
  switch (field.type) {
    case 'MONEY':
      return money(field, raw, currency);
    case 'PERCENT':
      return percent(field, raw);
    case 'DATE':
      return date(field, raw);
    case 'DURATION':
      return duration(field, raw);
    case 'CHOICE': {
      const option = field.options?.find((entry) => entry.value === raw.toUpperCase() || entry.label.toLowerCase() === raw.toLowerCase());
      return option ? option.value : refuse(field, `one of: ${(field.options ?? []).map((entry) => entry.label).join('; ')}`);
    }
    case 'REFERENCE':
      return raw.length > 300 ? refuse(field, 'a document reference of at most 300 characters') : raw;
    case 'TEXT':
      return raw.length > 3000 ? refuse(field, 'at most 3,000 characters') : raw;
  }
}

/** How a normalised value reads to a person. */
export function display(field: FieldDef, value: string, currency: string): string {
  switch (field.type) {
    case 'MONEY':
      return `${currency} ${Number(value).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    case 'PERCENT':
      return `${value}%`;
    case 'DURATION': {
      const [n, unit] = value.split(' ');
      return `${n} ${Number(n) === 1 ? unit!.toLowerCase().replace(/s$/, '') : unit!.toLowerCase()}`;
    }
    case 'CHOICE':
      return field.options?.find((entry) => entry.value === value)?.label ?? value;
    default:
      return value;
  }
}
