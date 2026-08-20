import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  abbreviateMoney,
  convert,
  currency,
  CurrencyError,
  formatMoney,
  JURISDICTIONS,
  minorPerMajor,
  presentTax,
  resolveLocale,
  toMajor,
  toMinor,
  type ExchangeRate,
} from '../src/domain/locale.ts';

/**
 * Localisation.
 *
 * "Money is in minor units everywhere" is a settled decision and a correct one.
 * What was missing is that a minor unit is not always a hundredth. A yen has
 * none and a dinar has three, so dividing by a hundred was wrong by an order of
 * magnitude on the first non-European contract — and it would have reached a
 * client before anybody noticed.
 */

describe('minor units are a property of the currency, not a constant', () => {
  it('knows a yen has no minor unit', () => {
    assert.equal(minorPerMajor('JPY'), 1);
    // 4,000 yen. Under the old assumption this would have displayed as ¥40.
    assert.equal(toMajor(4_000, 'JPY'), 4_000);
    // A British reader gets "JP¥", which is Intl disambiguating yen from the
    // other currencies that use the symbol. The part that matters is that the
    // figure is four thousand and carries no decimal.
    assert.match(formatMoney(4_000, 'JPY', 'en-GB'), /4,000$/);
    assert.doesNotMatch(formatMoney(4_000, 'JPY', 'en-GB'), /\./);
  });

  it('knows a dinar has three', () => {
    assert.equal(minorPerMajor('KWD'), 1_000);
    assert.equal(toMajor(4_000, 'KWD'), 4);
    assert.match(formatMoney(4_000, 'KWD', 'en-GB'), /4\.000/);
  });

  it('still counts sterling in hundredths', () => {
    assert.equal(minorPerMajor('GBP'), 100);
    assert.equal(formatMoney(123_456, 'GBP', 'en-GB'), '£1,234.56');
  });

  it('round-trips a figure somebody typed', () => {
    for (const [code, major] of [['GBP', 1234.56], ['JPY', 4000], ['KWD', 4.125]] as const) {
      assert.equal(toMajor(toMinor(major, code), code), major, code);
    }
  });

  it('refuses a currency it does not know rather than assuming two decimals', () => {
    // The silent default is exactly how a figure ends up a hundred times wrong.
    assert.throws(() => currency('XYZ'), CurrencyError);
    assert.throws(() => currency('XYZ'), /rather than assuming two decimal places/);
  });
});

describe('formatting for the reader rather than for us', () => {
  it('uses the reader’s conventions, not a hardcoded symbol table', () => {
    const british = formatMoney(123_456, 'EUR', 'en-GB');
    const french = formatMoney(123_456, 'EUR', 'fr-FR');

    assert.notEqual(british, french, 'a French reader does not read a British-formatted euro figure');
    assert.match(french, /1\s?234,56/, 'comma decimal and a space group separator');
  });

  it('abbreviates without losing the currency', () => {
    assert.equal(abbreviateMoney(1_850_000_000, 'GBP'), '£18.50M');
    // The same magnitude in yen is a hundred times larger in major units,
    // which is the whole point.
    assert.equal(abbreviateMoney(1_850_000_000, 'JPY'), '¥1.85B');
  });

  it('carries the sign', () => {
    assert.equal(abbreviateMoney(-1_400_000, 'GBP'), '-£14.0K');
  });
});

describe('resolving a language from what the device actually sent', () => {
  it('takes the highest-quality tag', () => {
    assert.equal(resolveLocale('fr-CA,fr;q=0.9,en;q=0.8'), 'fr-CA');
    assert.equal(resolveLocale('en;q=0.8,de-DE;q=0.95'), 'de-DE');
  });

  it('falls back rather than throwing on a header a client made up', () => {
    // The header reaches a formatter that would throw on an invalid tag, and a
    // request must not fail because somebody sent a odd string.
    assert.equal(resolveLocale('not a language tag at all!!'), 'en-GB');
    assert.equal(resolveLocale(''), 'en-GB');
    assert.equal(resolveLocale(undefined), 'en-GB');
    assert.equal(resolveLocale('*'), 'en-GB');
  });

  it('ignores a tag the client explicitly does not want', () => {
    assert.equal(resolveLocale('de-DE;q=0,en-GB;q=0.5'), 'en-GB');
  });
});

describe('exchange, and refusing to invent one', () => {
  const rates: ExchangeRate[] = [
    { from: 'USD', to: 'GBP', rate: 0.79, asAt: '2026-08-01', source: 'Bank of England daily spot' },
  ];

  it('converts on a recorded rate and carries where it came from', () => {
    const result = convert(100_00, 'USD', 'GBP', rates);

    assert.equal(result.unconverted, false);
    assert.equal(result.minor, 79_00);
    assert.equal(result.rate?.source, 'Bank of England daily spot');
    assert.equal(result.rate?.asAt, '2026-08-01', 'a rate without a date is a number');
  });

  it('reads a rate backwards, because that is the same fact', () => {
    const result = convert(79_00, 'GBP', 'USD', rates);
    assert.equal(result.unconverted, false);
    assert.equal(result.minor, 100_00);
  });

  it('declines rather than crossing two rates struck at different moments', () => {
    // USD/GBP and USD/EUR multiplied together is a number nobody published.
    const withEuro: ExchangeRate[] = [
      ...rates,
      { from: 'USD', to: 'EUR', rate: 0.92, asAt: '2026-08-01', source: 'ECB reference' },
    ];

    const result = convert(100_00, 'GBP', 'EUR', withEuro);
    assert.equal(result.unconverted, true);
    assert.equal(result.currency, 'GBP', 'shown in its own currency');
    assert.match(result.note ?? '', /invented rate is worse/);
  });

  it('declines when no rate is held at all', () => {
    const result = convert(100_00, 'USD', 'JPY', rates);
    assert.equal(result.unconverted, true);
    assert.equal(result.minor, 100_00);
    assert.match(result.note ?? '', /No USD\/JPY rate is held/);
  });

  it('is a no-op between a currency and itself', () => {
    const result = convert(100_00, 'GBP', 'GBP', []);
    assert.equal(result.unconverted, false);
    assert.equal(result.minor, 100_00);
  });
});

describe('tax, for display rather than for a return', () => {
  it('applies the standard rate where one is published', () => {
    const presented = presentTax(100_000_00, { jurisdictionCode: 'GB' });

    assert.equal(presented.taxName, 'VAT');
    assert.equal(presented.rate?.percent, 20);
    assert.equal(presented.taxMinor, 20_000_00);
    assert.equal(presented.grossMinor, 120_000_00);
  });

  it('shows nothing collected under the domestic reverse charge, and says why', () => {
    // The rule that changed construction working capital: the tax is not
    // received, so it is not cash the business holds until its return.
    const presented = presentTax(100_000_00, { jurisdictionCode: 'GB', construction: true });

    assert.equal(presented.reverseCharge, true);
    assert.equal(presented.taxMinor, 0);
    assert.equal(presented.grossMinor, 100_000_00);
    assert.ok(presented.notes.some((n) => /Section 55A/.test(n)));
    assert.ok(presented.notes.some((n) => /not cash the business holds/.test(n)));
  });

  it('does not apply a reverse charge where the jurisdiction has none', () => {
    const presented = presentTax(100_000_00, { jurisdictionCode: 'AE', construction: true });
    assert.equal(presented.reverseCharge, false);
    assert.equal(presented.rate?.percent, 5);
  });

  it('publishes no national rate where there is none to publish', () => {
    // US sales tax is set by state and locality. Inventing a national figure
    // would be worse than showing none.
    assert.deepEqual(JURISDICTIONS.US!.rules, []);
    const presented = presentTax(100_000_00, { jurisdictionCode: 'US' });
    assert.equal(presented.taxMinor, 0);
    assert.ok(presented.notes.some((n) => /set locally/.test(n)));
  });

  it('says so rather than guessing for a jurisdiction it holds no rules for', () => {
    const presented = presentTax(100_000_00, { jurisdictionCode: 'BR' });
    assert.equal(presented.taxMinor, 0);
    assert.equal(presented.grossMinor, 100_000_00);
    assert.ok(presented.notes.some((n) => /No tax rules are held for BR/.test(n)));
  });

  it('names a rate that is not a published one instead of quietly using it', () => {
    const presented = presentTax(100_000_00, { jurisdictionCode: 'GB', ratePercent: 17.5 });
    assert.ok(presented.notes.some((n) => /not a published VAT rate/.test(n)));
    assert.equal(presented.taxMinor, 0, 'an unpublished rate is not applied');
  });
});
