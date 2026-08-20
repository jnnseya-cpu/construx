/**
 * Localisation: currency, language and tax display.
 *
 * The platform is aimed at governments, DFIs and global EPCs, and it has been
 * quietly assuming everybody counts money the way the United Kingdom does.
 *
 * **Money is in minor units everywhere** is a settled decision and a correct
 * one. What was missing is that "minor units" is not a fixed exponent. A yen
 * has none, a dinar has three, and a sterling amount has two. Dividing by 100
 * to display a JPY figure is wrong by a factor of a hundred — not a rounding
 * difference, an order of magnitude — and it would have appeared on the first
 * Japanese contract without anybody noticing until the figure was in front of a
 * client.
 *
 * Two boundaries here matter more than the rest.
 *
 * **A project's money stays in the project's currency.** A JCT contract in
 * sterling is not a dollar contract and converting it for display would be
 * inventing precision the record does not have. Only the platform's own charges
 * — subscription and ACUs, which are priced in USD — are ever converted.
 *
 * **No exchange rate is invented.** A rate is a fact about a market on a date.
 * Where one has been supplied it is used and the source and date travel with
 * the result; where none has, the figure is shown in its own currency and the
 * platform says so. A converted figure with a made-up rate is worse than an
 * unconverted one, because it looks like it was checked.
 */

// --- Currency -------------------------------------------------------------------

export type CurrencyDefinition = {
  code: string;
  name: string;
  /**
   * Digits after the decimal point, per ISO 4217. This is the number that makes
   * "minor units" mean something, and the reason it is not always two.
   */
  exponent: 0 | 2 | 3;
};

/**
 * The currencies the platform knows how to count in.
 *
 * Deliberately a list rather than an assumption. An unknown code is refused
 * rather than defaulted to two digits, because a silent default is exactly how
 * a yen figure ends up a hundred times too small.
 */
export const CURRENCIES: Record<string, CurrencyDefinition> = {
  GBP: { code: 'GBP', name: 'Pound sterling', exponent: 2 },
  USD: { code: 'USD', name: 'US dollar', exponent: 2 },
  EUR: { code: 'EUR', name: 'Euro', exponent: 2 },
  AED: { code: 'AED', name: 'UAE dirham', exponent: 2 },
  SAR: { code: 'SAR', name: 'Saudi riyal', exponent: 2 },
  ZAR: { code: 'ZAR', name: 'South African rand', exponent: 2 },
  NGN: { code: 'NGN', name: 'Nigerian naira', exponent: 2 },
  KES: { code: 'KES', name: 'Kenyan shilling', exponent: 2 },
  INR: { code: 'INR', name: 'Indian rupee', exponent: 2 },
  AUD: { code: 'AUD', name: 'Australian dollar', exponent: 2 },
  CAD: { code: 'CAD', name: 'Canadian dollar', exponent: 2 },
  SGD: { code: 'SGD', name: 'Singapore dollar', exponent: 2 },
  // Zero-decimal currencies. A "minor unit" here is the unit itself.
  JPY: { code: 'JPY', name: 'Japanese yen', exponent: 0 },
  KRW: { code: 'KRW', name: 'South Korean won', exponent: 0 },
  // Three-decimal currencies, common across Gulf infrastructure programmes.
  KWD: { code: 'KWD', name: 'Kuwaiti dinar', exponent: 3 },
  BHD: { code: 'BHD', name: 'Bahraini dinar', exponent: 3 },
  OMR: { code: 'OMR', name: 'Omani rial', exponent: 3 },
  TND: { code: 'TND', name: 'Tunisian dinar', exponent: 3 },
};

export class CurrencyError extends Error {
  readonly code = 'CURRENCY_UNKNOWN';
  constructor(currency: string) {
    super(`${currency} is not a currency the platform counts in. Add it to the currency table rather than assuming two decimal places.`);
    this.name = 'CurrencyError';
  }
}

export function currency(code: string): CurrencyDefinition {
  const definition = CURRENCIES[code.toUpperCase()];
  if (!definition) throw new CurrencyError(code);
  return definition;
}

/** Minor units in one major unit: 1 for yen, 100 for sterling, 1000 for dinar. */
export function minorPerMajor(code: string): number {
  return 10 ** currency(code).exponent;
}

/** Convert a major-unit figure a person typed into the minor units the platform stores. */
export function toMinor(major: number, code: string): number {
  return Math.round(major * minorPerMajor(code));
}

export function toMajor(minor: number, code: string): number {
  return minor / minorPerMajor(code);
}

// --- Language and locale ----------------------------------------------------------

/**
 * Resolve a locale from what the client actually sent.
 *
 * `Accept-Language` is the honest source: it is what the device is set to,
 * carried on every request, and it needs no permission. Geolocation is not used
 * — it asks a person where they are standing to answer a question about what
 * language they read, and it is wrong for every expatriate engineer on a
 * project.
 */
export function resolveLocale(acceptLanguage: string | undefined, fallback = 'en-GB'): string {
  if (!acceptLanguage) return fallback;

  const ranked = acceptLanguage
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      const quality = q ? Number(q.split('=')[1]) : 1;
      return { tag: (tag ?? '').trim(), quality: Number.isFinite(quality) ? quality : 0 };
    })
    .filter((entry) => entry.tag !== '' && entry.tag !== '*' && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality);

  const best = ranked[0]?.tag;
  if (!best) return fallback;

  // Validated rather than trusted: the header is client-supplied and reaches a
  // formatter, and an invalid tag would throw at the point of display.
  try {
    return new Intl.Locale(best).toString();
  } catch {
    return fallback;
  }
}

/**
 * Format money for display.
 *
 * `Intl.NumberFormat` is built into the runtime, which is why this is fifteen
 * lines rather than a dependency: it already knows that a French reader expects
 * a space before the symbol and a comma for the decimal, and that a yen figure
 * has no decimal at all.
 */
export function formatMoney(minor: number, code: string, locale = 'en-GB'): string {
  const definition = currency(code);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: definition.code,
    minimumFractionDigits: definition.exponent,
    maximumFractionDigits: definition.exponent,
  }).format(toMajor(minor, code));
}

/** The symbol a reader expects, from the runtime's own currency data. */
export function currencySymbol(code: string, locale = 'en-GB'): string {
  const definition = currency(code);
  return (
    new Intl.NumberFormat(locale, { style: 'currency', currency: definition.code, currencyDisplay: 'narrowSymbol' })
      .formatToParts(0)
      .find((part) => part.type === 'currency')?.value ?? `${definition.code} `
  );
}

/**
 * Money abbreviated for a sentence rather than an invoice.
 *
 * There were four copies of this scattered across the briefing, the agent
 * fleet, the copilot and the invoice, each with its own three-entry symbol
 * table that called every other currency a dollar, and each dividing by a
 * hundred. One of them is enough, and it is the one that knows the exponent.
 */
export function abbreviateMoney(
  minor: number,
  code = 'GBP',
  options: { locale?: string; uppercaseSuffix?: boolean } = {},
): string {
  const symbol = currencySymbol(code, options.locale ?? 'en-GB');
  const major = toMajor(minor, code);
  const abs = Math.abs(major);
  const sign = minor < 0 ? '-' : '';
  const [k, m, b] = options.uppercaseSuffix === false ? ['k', 'm', 'b'] : ['K', 'M', 'B'];

  if (abs >= 1_000_000_000) return `${sign}${symbol}${(abs / 1_000_000_000).toFixed(2)}${b}`;
  if (abs >= 1_000_000) return `${sign}${symbol}${(abs / 1_000_000).toFixed(2)}${m}`;
  if (abs >= 1_000) return `${sign}${symbol}${(abs / 1_000).toFixed(1)}${k}`;
  return `${sign}${symbol}${abs.toFixed(currency(code).exponent)}`;
}

// --- Exchange ---------------------------------------------------------------------

export type ExchangeRate = {
  from: string;
  to: string;
  /** Major units of `to` per one major unit of `from`. */
  rate: number;
  /** The date the rate was struck. A rate without one is a number. */
  asAt: string;
  /** Where it came from, so a figure can be defended. */
  source: string;
};

export type Converted = {
  minor: number;
  currency: string;
  /** Present only where a conversion actually happened. */
  rate?: ExchangeRate;
  /** True where no rate was available and the original currency is shown instead. */
  unconverted: boolean;
  note?: string;
};

/**
 * Convert a sum, or decline to.
 *
 * The declining is the feature. A platform that quietly substitutes a stale or
 * invented rate produces a figure somebody quotes in a meeting, and there is no
 * way to tell afterwards which figures were real. Where no rate is held, the
 * original currency comes back with a note saying why.
 */
export function convert(minor: number, from: string, to: string, rates: ExchangeRate[]): Converted {
  if (from.toUpperCase() === to.toUpperCase()) {
    return { minor, currency: currency(from).code, unconverted: false };
  }

  const direct = rates.find((r) => r.from.toUpperCase() === from.toUpperCase() && r.to.toUpperCase() === to.toUpperCase());
  if (direct) {
    const major = toMajor(minor, from) * direct.rate;
    return { minor: toMinor(major, to), currency: currency(to).code, rate: direct, unconverted: false };
  }

  // An inverse is the same fact read the other way round, so it is used. A
  // cross-rate through a third currency is not: two rates struck at different
  // moments multiplied together is a number nobody published.
  const inverse = rates.find((r) => r.from.toUpperCase() === to.toUpperCase() && r.to.toUpperCase() === from.toUpperCase());
  if (inverse && inverse.rate !== 0) {
    const major = toMajor(minor, from) / inverse.rate;
    return {
      minor: toMinor(major, to),
      currency: currency(to).code,
      rate: { ...inverse, from: currency(from).code, to: currency(to).code, rate: 1 / inverse.rate },
      unconverted: false,
    };
  }

  return {
    minor,
    currency: currency(from).code,
    unconverted: true,
    note: `No ${from.toUpperCase()}/${to.toUpperCase()} rate is held, so the figure is shown in ${from.toUpperCase()}. A converted figure with an invented rate is worse than an unconverted one.`,
  };
}

// --- Tax ---------------------------------------------------------------------------

export type TaxRule = {
  /** The rate, as a percentage. */
  percent: number;
  label: string;
  /** What it applies to, in the terms the jurisdiction uses. */
  appliesTo: string;
};

export type Jurisdiction = {
  code: string;
  name: string;
  taxName: string;
  rules: TaxRule[];
  /**
   * Whether construction services in this jurisdiction move the tax charge to
   * the customer. In the UK the domestic reverse charge did exactly that, and
   * it changed construction working capital materially — a subcontractor no
   * longer receives the VAT it used to hold until its return.
   */
  reverseChargeOnConstruction: boolean;
  /** Where the reverse charge exists, the note that has to appear on the invoice. */
  reverseChargeNote?: string;
};

/**
 * Tax display rules.
 *
 * Display is the operative word. These decide what a figure is labelled and
 * what an invoice has to say; they do not compute a liability, which depends on
 * registration, place of supply and the nature of the work, and is an
 * accountant's job rather than a construction platform's.
 */
export const JURISDICTIONS: Record<string, Jurisdiction> = {
  GB: {
    code: 'GB',
    name: 'United Kingdom',
    taxName: 'VAT',
    rules: [
      { percent: 20, label: 'Standard rate', appliesTo: 'Most construction services and materials' },
      { percent: 5, label: 'Reduced rate', appliesTo: 'Certain residential conversions and energy-saving materials' },
      { percent: 0, label: 'Zero rate', appliesTo: 'New-build residential and qualifying charitable buildings' },
    ],
    reverseChargeOnConstruction: true,
    reverseChargeNote:
      'Reverse charge: VAT Act 1994 Section 55A applies. Customer to account for the VAT to HMRC at the rate shown.',
  },
  IE: {
    code: 'IE',
    name: 'Ireland',
    taxName: 'VAT',
    rules: [
      { percent: 13.5, label: 'Reduced rate', appliesTo: 'Most construction services' },
      { percent: 23, label: 'Standard rate', appliesTo: 'Materials supplied without installation' },
    ],
    reverseChargeOnConstruction: true,
    reverseChargeNote: 'VAT on this supply is to be accounted for by the principal contractor under the relevant reverse charge rules.',
  },
  AE: {
    code: 'AE',
    name: 'United Arab Emirates',
    taxName: 'VAT',
    rules: [{ percent: 5, label: 'Standard rate', appliesTo: 'Construction services and materials' }],
    reverseChargeOnConstruction: false,
  },
  ZA: {
    code: 'ZA',
    name: 'South Africa',
    taxName: 'VAT',
    rules: [{ percent: 15, label: 'Standard rate', appliesTo: 'Construction services and materials' }],
    reverseChargeOnConstruction: false,
  },
  US: {
    code: 'US',
    name: 'United States',
    taxName: 'Sales tax',
    // Sales tax is set by state and locality, and there is no national rate to
    // state. Publishing one would be worse than publishing none.
    rules: [],
    reverseChargeOnConstruction: false,
  },
};

export type TaxPresentation = {
  jurisdiction: string;
  taxName: string;
  rate?: TaxRule;
  netMinor: number;
  taxMinor: number;
  grossMinor: number;
  reverseCharge: boolean;
  notes: string[];
};

/**
 * Present a sum with its tax, for a document somebody will read.
 *
 * Under a reverse charge the tax is shown at zero on the invoice and the note
 * explains why, which is what the rules require and also the thing that catches
 * people out: the money is not collected, so it is not available to fund the
 * job in the meantime.
 */
export function presentTax(
  netMinor: number,
  input: { jurisdictionCode: string; ratePercent?: number; construction?: boolean },
): TaxPresentation {
  const jurisdiction = JURISDICTIONS[input.jurisdictionCode.toUpperCase()];
  if (!jurisdiction) {
    return {
      jurisdiction: input.jurisdictionCode.toUpperCase(),
      taxName: 'Tax',
      netMinor,
      taxMinor: 0,
      grossMinor: netMinor,
      reverseCharge: false,
      notes: [
        `No tax rules are held for ${input.jurisdictionCode.toUpperCase()}. The figure is shown net, and tax is a matter for the invoice.`,
      ],
    };
  }

  const rate =
    input.ratePercent !== undefined
      ? jurisdiction.rules.find((r) => r.percent === input.ratePercent)
      : jurisdiction.rules[0];

  const notes: string[] = [];
  const reverseCharge = jurisdiction.reverseChargeOnConstruction && input.construction === true;

  if (jurisdiction.rules.length === 0) {
    notes.push(`${jurisdiction.taxName} in ${jurisdiction.name} is set locally; no single rate applies.`);
  }
  if (input.ratePercent !== undefined && !rate) {
    notes.push(`${input.ratePercent}% is not a published ${jurisdiction.taxName} rate in ${jurisdiction.name}.`);
  }
  if (reverseCharge && jurisdiction.reverseChargeNote) {
    notes.push(jurisdiction.reverseChargeNote);
    notes.push('The tax is not collected on this supply, so it is not cash the business holds between invoice and return.');
  }

  const percent = reverseCharge ? 0 : (rate?.percent ?? 0);
  const taxMinor = Math.round(netMinor * (percent / 100));

  return {
    jurisdiction: jurisdiction.code,
    taxName: jurisdiction.taxName,
    rate,
    netMinor,
    taxMinor,
    grossMinor: netMinor + taxMinor,
    reverseCharge,
    notes,
  };
}
