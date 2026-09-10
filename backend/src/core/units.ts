import { DomainError } from './errors.ts';

/**
 * The unit engine.
 *
 * ---
 *
 * **The error this exists to stop.** A quantity priced in the wrong dimension is
 * arithmetically perfect and commercially fatal. Ten thousand square metres of
 * blockwork entered against a rate built per linear metre produces a total that
 * adds up, prints correctly, reconciles against itself and is wrong by an order
 * of magnitude. Nothing in a spreadsheet notices, because a spreadsheet holds
 * numbers and this platform's whole argument is that it holds facts.
 *
 * So a unit here is not a label on a number. It carries a **dimension**, and two
 * quantities may only be compared, totalled or reconciled when their dimensions
 * agree. Where they agree but the units differ — metres against millimetres —
 * conversion is exact and available. Where the dimensions differ, there is no
 * conversion and the caller is refused rather than given a number.
 *
 * ## What is deliberately not here
 *
 * **A working day.** `day` below is twenty-four hours, which is what a day is.
 * Construction programmes are written in *working* days, and a working day is
 * five, seven, eight, nine or twelve hours depending on the calendar in force —
 * so a unit called `wd` would have to pick one and would be wrong on most
 * projects. Programme calendars already model this properly; a text unit here
 * that pretended to would silently disagree with them. `wd` is therefore
 * unrecognised, which is the honest answer.
 *
 * **Currency.** Money is not a dimension in this table. It has its own minor
 * units, its own rounding rules and its own conversion decision — an exchange
 * rate has a date and somebody's authority on it — and burying that in a
 * conversion factor would make a commercial decision look like arithmetic.
 *
 * **A lump sum is not a count.** `sum` is its own dimension with no conversion
 * to anything, including to itself times a number. Two lump sums do not make
 * two of something; they make two lump sums, and adding them is a decision
 * about scope rather than a calculation.
 *
 * ## Reading a unit written by a person
 *
 * Bills arrive as spreadsheets and recovered tables, and the same unit is
 * written `m2`, `m²`, `M2`, `sq m`, `sq.m.` and `SM` in one document. Those all
 * mean the same thing and `canonicalUnit` maps them to one symbol. Anything it
 * does not recognise returns `undefined` rather than a guess: a unit the
 * platform has invented a meaning for is worse than one it admits it cannot
 * read, because the first is checked against nothing and looks checked.
 */

export const UNIT_DIMENSION = ['LENGTH', 'AREA', 'VOLUME', 'MASS', 'TIME', 'COUNT', 'SUM', 'PROPORTION'] as const;
export type UnitDimension = (typeof UNIT_DIMENSION)[number];

export type UnitDefinition = {
  /** The one symbol this platform writes. */
  symbol: string;
  dimension: UnitDimension;
  /** How many of the dimension's base unit one of these is. Exact where the definition is exact. */
  perBase: number;
  /** What a person reading a bill would call it. */
  label: string;
};

/**
 * The base unit of each dimension. Conversion runs through it, so every factor
 * is stated once against one reference rather than as a matrix that can
 * disagree with itself.
 */
export const BASE_UNIT: Record<UnitDimension, string> = {
  LENGTH: 'm',
  AREA: 'm2',
  VOLUME: 'm3',
  MASS: 'kg',
  TIME: 'h',
  COUNT: 'nr',
  SUM: 'sum',
  PROPORTION: '%',
};

/**
 * Every unit the platform will read, with its factor to the dimension base.
 *
 * Imperial factors are the international definitions, exact by treaty: a foot
 * is 0.3048 m and a pound is 0.45359237 kg, both exactly. They are here because
 * a bill from a client working in feet is a bill this platform has to be able
 * to check, not because anything is priced in them.
 */
export const UNITS: readonly UnitDefinition[] = [
  // LENGTH
  { symbol: 'mm', dimension: 'LENGTH', perBase: 0.001, label: 'millimetre' },
  { symbol: 'cm', dimension: 'LENGTH', perBase: 0.01, label: 'centimetre' },
  { symbol: 'm', dimension: 'LENGTH', perBase: 1, label: 'metre' },
  { symbol: 'km', dimension: 'LENGTH', perBase: 1000, label: 'kilometre' },
  { symbol: 'in', dimension: 'LENGTH', perBase: 0.0254, label: 'inch' },
  { symbol: 'ft', dimension: 'LENGTH', perBase: 0.3048, label: 'foot' },
  { symbol: 'yd', dimension: 'LENGTH', perBase: 0.9144, label: 'yard' },

  // AREA
  { symbol: 'mm2', dimension: 'AREA', perBase: 0.000001, label: 'square millimetre' },
  { symbol: 'cm2', dimension: 'AREA', perBase: 0.0001, label: 'square centimetre' },
  { symbol: 'm2', dimension: 'AREA', perBase: 1, label: 'square metre' },
  { symbol: 'ha', dimension: 'AREA', perBase: 10000, label: 'hectare' },
  { symbol: 'km2', dimension: 'AREA', perBase: 1000000, label: 'square kilometre' },
  { symbol: 'ft2', dimension: 'AREA', perBase: 0.09290304, label: 'square foot' },
  { symbol: 'yd2', dimension: 'AREA', perBase: 0.83612736, label: 'square yard' },

  // VOLUME
  { symbol: 'mm3', dimension: 'VOLUME', perBase: 0.000000001, label: 'cubic millimetre' },
  { symbol: 'cm3', dimension: 'VOLUME', perBase: 0.000001, label: 'cubic centimetre' },
  { symbol: 'l', dimension: 'VOLUME', perBase: 0.001, label: 'litre' },
  { symbol: 'm3', dimension: 'VOLUME', perBase: 1, label: 'cubic metre' },
  { symbol: 'ft3', dimension: 'VOLUME', perBase: 0.028316846592, label: 'cubic foot' },
  { symbol: 'yd3', dimension: 'VOLUME', perBase: 0.764554857984, label: 'cubic yard' },

  // MASS
  { symbol: 'g', dimension: 'MASS', perBase: 0.001, label: 'gram' },
  { symbol: 'kg', dimension: 'MASS', perBase: 1, label: 'kilogram' },
  { symbol: 't', dimension: 'MASS', perBase: 1000, label: 'tonne' },
  { symbol: 'lb', dimension: 'MASS', perBase: 0.45359237, label: 'pound' },

  // TIME
  { symbol: 's', dimension: 'TIME', perBase: 1 / 3600, label: 'second' },
  { symbol: 'min', dimension: 'TIME', perBase: 1 / 60, label: 'minute' },
  { symbol: 'h', dimension: 'TIME', perBase: 1, label: 'hour' },
  { symbol: 'day', dimension: 'TIME', perBase: 24, label: 'day' },
  { symbol: 'wk', dimension: 'TIME', perBase: 168, label: 'week' },

  // COUNT
  { symbol: 'nr', dimension: 'COUNT', perBase: 1, label: 'number' },

  // SUM
  { symbol: 'sum', dimension: 'SUM', perBase: 1, label: 'lump sum' },

  // PROPORTION
  { symbol: '%', dimension: 'PROPORTION', perBase: 1, label: 'per cent' },
];

const BY_SYMBOL = new Map(UNITS.map((unit) => [unit.symbol, unit]));

/**
 * What people actually type, mapped to the symbol the platform writes.
 *
 * Keys are already normalised by `fold` below — lower case, no spaces, no full
 * stops, superscripts expanded — so `Sq. M.` and `SQM` both arrive here as
 * `sqm`. The canonical symbols are included as their own aliases so a lookup
 * never has to try two tables.
 */
const ALIASES: Record<string, string> = {
  // Length. A linear metre is a metre; the word "linear" says which dimension
  // of the thing was measured, not what the unit is.
  mm: 'mm', millimetre: 'mm', millimetres: 'mm', millimeter: 'mm', millimeters: 'mm',
  cm: 'cm', centimetre: 'cm', centimetres: 'cm', centimeter: 'cm', centimeters: 'cm',
  m: 'm', lm: 'm', linm: 'm', linearm: 'm', linearmetre: 'm', linearmeter: 'm',
  metre: 'm', metres: 'm', meter: 'm', meters: 'm', rm: 'm', runningm: 'm', runningmetre: 'm',
  km: 'km', kilometre: 'km', kilometres: 'km', kilometer: 'km', kilometers: 'km',
  in: 'in', inch: 'in', inches: 'in',
  ft: 'ft', foot: 'ft', feet: 'ft', lf: 'ft', linft: 'ft', linearft: 'ft',
  yd: 'yd', yard: 'yd', yards: 'yd',

  // Area
  mm2: 'mm2', sqmm: 'mm2',
  cm2: 'cm2', sqcm: 'cm2',
  m2: 'm2', sqm: 'm2', sqmetre: 'm2', sqmetres: 'm2', squaremetre: 'm2', squaremetres: 'm2',
  squaremeter: 'm2', squaremeters: 'm2', sm: 'm2',
  ha: 'ha', hectare: 'ha', hectares: 'ha',
  km2: 'km2', sqkm: 'km2',
  ft2: 'ft2', sqft: 'ft2', squarefoot: 'ft2', squarefeet: 'ft2', sf: 'ft2',
  yd2: 'yd2', sqyd: 'yd2', squareyard: 'yd2', squareyards: 'yd2',

  // Volume
  mm3: 'mm3', cumm: 'mm3',
  cm3: 'cm3', cucm: 'cm3', cc: 'cm3',
  l: 'l', litre: 'l', litres: 'l', liter: 'l', liters: 'l', ltr: 'l',
  m3: 'm3', cum: 'm3', cubm: 'm3', cubicmetre: 'm3', cubicmetres: 'm3',
  cubicmeter: 'm3', cubicmeters: 'm3',
  ft3: 'ft3', cuft: 'ft3', cubicfoot: 'ft3', cubicfeet: 'ft3', cf: 'ft3',
  yd3: 'yd3', cuyd: 'yd3', cubicyard: 'yd3', cubicyards: 'yd3',

  // Mass. "te" and "MT" are both written for a metric tonne on UK bills.
  g: 'g', gram: 'g', grams: 'g', gramme: 'g', grammes: 'g',
  kg: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg', kilogramme: 'kg', kilogrammes: 'kg',
  // "ton" is deliberately absent. A short ton is 907.18474 kg, a long ton is
  // 1016.0469088 kg and a tonne is 1000 kg, so reading the word as any one of
  // them is a silent error of up to 1.6% on every line it touches. Unreadable
  // is the correct answer to an ambiguous unit.
  t: 't', te: 't', mt: 't', tonne: 't', tonnes: 't',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',

  // Time
  s: 's', sec: 's', secs: 's', second: 's', seconds: 's',
  min: 'min', mins: 'min', minute: 'min', minutes: 'min',
  h: 'h', hr: 'h', hrs: 'h', hour: 'h', hours: 'h', manhour: 'h', manhours: 'h',
  day: 'day', days: 'day',
  wk: 'wk', wks: 'wk', week: 'wk', weeks: 'wk',

  // Count. "item" counts things; a lump sum is not one of them and is below.
  // "qty" is absent on purpose: it is a column heading, not a unit, and a bill
  // whose unit column says "qty" has told the reader nothing.
  nr: 'nr', no: 'nr', nos: 'nr', number: 'nr', num: 'nr',
  ea: 'nr', each: 'nr', item: 'nr', items: 'nr', pc: 'nr', pcs: 'nr', piece: 'nr', pieces: 'nr',
  unit: 'nr', units: 'nr', point: 'nr', points: 'nr',

  // Lump sum
  sum: 'sum', ls: 'sum', lumpsum: 'sum', lumpsums: 'sum', provisionalsum: 'sum', psum: 'sum',

  // Proportion
  '%': '%', pct: '%', percent: '%', percentage: '%', perc: '%',
};

/**
 * Reduce what somebody typed to a comparison key.
 *
 * Superscripts first, because `m²` has to become `m2` before the full stops and
 * spaces go — otherwise `m ²` and `m2` fold differently. Everything that is not
 * a letter, a digit or a per-cent sign is dropped: `sq. m.`, `sq-m` and `sq m`
 * are the same unit written by three people.
 */
function fold(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/²/g, '2')
    .replace(/³/g, '3')
    .replace(/\^/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9%]/g, '');
}

/**
 * The unit this text means, or `undefined` when the platform cannot read it.
 *
 * `undefined` is a real answer and callers must handle it. A unit nobody can
 * read is a quantity nobody can check, and the honest response is to say so
 * rather than to assume the commonest unit and carry on.
 */
export function canonicalUnit(text: string | undefined | null): UnitDefinition | undefined {
  if (typeof text !== 'string') return undefined;
  const key = fold(text);
  if (!key) return undefined;
  const symbol = ALIASES[key];
  if (!symbol) return undefined;
  return BY_SYMBOL.get(symbol);
}

/** The symbol this platform writes for that text, or `undefined`. */
export function unitSymbol(text: string | undefined | null): string | undefined {
  return canonicalUnit(text)?.symbol;
}

/** What is being measured, or `undefined` when the unit cannot be read. */
export function dimensionOf(text: string | undefined | null): UnitDimension | undefined {
  return canonicalUnit(text)?.dimension;
}

/**
 * Whether two units measure the same kind of thing.
 *
 * Two units the platform cannot read are **not** the same dimension, even when
 * the text is identical. Returning true there would mean two unreadable units
 * compared clean, which is the exact silence this module exists to break.
 */
export function sameDimension(a: string | undefined | null, b: string | undefined | null): boolean {
  const left = dimensionOf(a);
  const right = dimensionOf(b);
  return left !== undefined && left === right;
}

/**
 * Convert a quantity between two units of the same dimension.
 *
 * Refuses across dimensions and refuses a unit it cannot read. There is no
 * best-effort path: a caller that receives a number from this function may rely
 * on it, and a caller that receives an error knows exactly which two units
 * could not be reconciled.
 *
 * A lump sum converts only to itself. The `SUM` dimension exists to make that
 * refusal explicit rather than to let one lump sum become two.
 */
export function convert(value: number, from: string, to: string): number {
  const source = canonicalUnit(from);
  const target = canonicalUnit(to);

  if (!source) {
    throw new DomainError(
      'UNIT_UNREADABLE',
      `"${from}" is not a unit this platform reads, so ${value} of it cannot be converted or checked. ` +
        'Use one of the recognised units, or record the quantity with the unit the bill actually states and price it by hand.',
    );
  }
  if (!target) {
    throw new DomainError(
      'UNIT_UNREADABLE',
      `"${to}" is not a unit this platform reads, so nothing can be converted into it.`,
    );
  }
  if (source.dimension !== target.dimension) {
    throw new DomainError(
      'UNIT_INCOMPATIBLE',
      `${source.label} measures ${source.dimension.toLowerCase()} and ${target.label} measures ${target.dimension.toLowerCase()}. ` +
        'There is no conversion between them, and a number produced by pretending there is would be arithmetically ' +
        'perfect and wrong.',
    );
  }
  // A lump sum converts only to itself, and needs no branch of its own to do
  // it: `SUM` has exactly one member, so every conversion out of it is already
  // a conversion out of its dimension and is refused above. That is the point
  // of giving a lump sum a dimension rather than treating it as a count — two
  // lump sums are two lump sums, not two of anything.
  return (value * source.perBase) / target.perBase;
}

/**
 * The recognised units, for a form that has to offer a choice.
 *
 * Published rather than duplicated in the console, for the same reason the
 * permission matrix is: the browser holds no rule the API does not publish, and
 * a second list of units in the interface is a second list that drifts.
 */
export function unitCatalogue(): Array<{ symbol: string; dimension: UnitDimension; label: string }> {
  return UNITS.map((unit) => ({ symbol: unit.symbol, dimension: unit.dimension, label: unit.label }));
}
