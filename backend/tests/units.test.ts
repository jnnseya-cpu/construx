import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BASE_UNIT,
  UNITS,
  UNIT_DIMENSION,
  canonicalUnit,
  convert,
  dimensionOf,
  sameDimension,
  unitCatalogue,
  unitSymbol,
} from '../src/core/units.ts';
import { DomainError } from '../src/core/errors.ts';

/**
 * The unit engine.
 *
 * The error it exists to stop is the one that adds up. Ten thousand square
 * metres of blockwork against a rate built per linear metre produces a total
 * that prints correctly, reconciles against itself and is wrong by an order of
 * magnitude — and nothing notices, because a number is all a spreadsheet holds.
 *
 * These tests are in three parts. The first is that the reader accepts what
 * people actually write on a bill. The second is that conversion is exact
 * where it is possible and refused where it is not. The third is the set of
 * things the module deliberately refuses to read, because an ambiguous unit
 * silently resolved is worse than one that says it cannot be resolved.
 */

describe('reading a unit somebody typed', () => {
  it('folds the six ways a square metre gets written into one symbol', () => {
    for (const written of ['m2', 'm²', 'M2', 'sq m', 'sq.m.', 'SQM', 'square metres', 'm^2', ' m2 ']) {
      assert.equal(unitSymbol(written), 'm2', `"${written}" should read as m2`);
    }
  });

  it('reads a linear metre as a metre, because linear says which dimension was measured', () => {
    for (const written of ['m', 'lm', 'LM', 'lin m', 'linear metre', 'running metre', 'rm']) {
      assert.equal(unitSymbol(written), 'm', `"${written}" should read as m`);
    }
  });

  it('reads the count units a bill uses interchangeably', () => {
    for (const written of ['nr', 'No', 'no.', 'each', 'ea', 'item', 'pcs', 'points']) {
      assert.equal(unitSymbol(written), 'nr', `"${written}" should read as nr`);
    }
  });

  it('reads a tonne written four ways', () => {
    for (const written of ['t', 'te', 'MT', 'tonnes']) {
      assert.equal(unitSymbol(written), 't', `"${written}" should read as t`);
    }
  });

  it('returns undefined rather than guessing at something it does not know', () => {
    for (const written of ['widgets', 'per bay', '', '   ', 'each week']) {
      assert.equal(canonicalUnit(written), undefined, `"${written}" should not resolve`);
    }
    assert.equal(canonicalUnit(undefined), undefined);
    assert.equal(canonicalUnit(null), undefined);
  });

  it('says what each unit measures', () => {
    assert.equal(dimensionOf('m'), 'LENGTH');
    assert.equal(dimensionOf('m²'), 'AREA');
    assert.equal(dimensionOf('cu m'), 'VOLUME');
    assert.equal(dimensionOf('kg'), 'MASS');
    assert.equal(dimensionOf('hrs'), 'TIME');
    assert.equal(dimensionOf('each'), 'COUNT');
    assert.equal(dimensionOf('lump sum'), 'SUM');
    assert.equal(dimensionOf('%'), 'PROPORTION');
  });
});

describe('converting between units', () => {
  it('converts exactly within a dimension', () => {
    assert.equal(convert(1, 'm', 'mm'), 1000);
    assert.equal(convert(2500, 'mm', 'm'), 2.5);
    assert.equal(convert(1, 'ha', 'm2'), 10000);
    assert.equal(convert(1, 'm3', 'l'), 1000);
    assert.equal(convert(1, 't', 'kg'), 1000);
    assert.equal(convert(1, 'day', 'h'), 24);
    assert.equal(convert(1, 'wk', 'day'), 7);
  });

  it('uses the treaty definitions for imperial units, so a client bill in feet can be checked', () => {
    // A foot is 0.3048 m and a pound is 0.45359237 kg, both exact by definition.
    assert.equal(convert(1, 'ft', 'm'), 0.3048);
    assert.equal(convert(1, 'lb', 'kg'), 0.45359237);
    // A square foot is a foot squared, and the factor has to agree with that or
    // areas and lengths will disagree with each other on the same drawing.
    assert.ok(Math.abs(convert(1, 'ft2', 'm2') - 0.3048 ** 2) < 1e-15);
    assert.ok(Math.abs(convert(1, 'yd3', 'm3') - 0.9144 ** 3) < 1e-15);
  });

  it('round-trips without drift', () => {
    for (const [from, to] of [['m', 'ft'], ['m2', 'yd2'], ['kg', 'lb'], ['h', 'min']] as const) {
      const there = convert(1234.5, from, to);
      assert.ok(Math.abs(convert(there, to, from) - 1234.5) < 1e-9, `${from} → ${to} → ${from} drifted`);
    }
  });

  it('refuses across dimensions rather than producing a number', () => {
    assert.throws(
      () => convert(340, 'm2', 'm'),
      (error: unknown) => {
        assert.ok(error instanceof DomainError);
        assert.equal(error.code, 'UNIT_INCOMPATIBLE');
        // The message has to say what each side measures, because the reader is
        // looking at two plausible units and needs to know which is wrong.
        assert.match(error.message, /area/);
        assert.match(error.message, /length/);
        return true;
      },
    );
    assert.throws(() => convert(1, 'kg', 'm3'), /UNIT_INCOMPATIBLE|measures/);
    assert.throws(() => convert(1, 'nr', 'h'), /UNIT_INCOMPATIBLE|measures/);
  });

  it('refuses a unit it cannot read, on either side', () => {
    assert.throws(
      () => convert(1, 'widgets', 'm'),
      (error: unknown) => {
        assert.ok(error instanceof DomainError);
        assert.equal(error.code, 'UNIT_UNREADABLE');
        return true;
      },
    );
    assert.throws(
      () => convert(1, 'm', 'widgets'),
      (error: unknown) => {
        assert.ok(error instanceof DomainError);
        assert.equal(error.code, 'UNIT_UNREADABLE');
        return true;
      },
    );
  });

  it('lets a lump sum convert only to itself', () => {
    assert.equal(convert(3, 'sum', 'lump sum'), 3);
    // A lump sum has its own dimension with one member, so turning three lump
    // sums into three of anything is refused as a dimension error rather than
    // needing a rule of its own.
    assert.throws(
      () => convert(3, 'sum', 'nr'),
      (error: unknown) => {
        assert.ok(error instanceof DomainError);
        assert.equal(error.code, 'UNIT_INCOMPATIBLE');
        return true;
      },
    );
  });
});

describe('what it refuses to read on purpose', () => {
  it('does not read "ton", because three different tons are written that way', () => {
    // A short ton is 907.18474 kg, a long ton is 1016.0469088 kg, a tonne is
    // 1000. Picking one silently is up to a 1.6% error on every line it touches.
    assert.equal(canonicalUnit('ton'), undefined);
    assert.equal(canonicalUnit('tons'), undefined);
    assert.equal(unitSymbol('tonne'), 't', 'a tonne is unambiguous and is read');
  });

  it('does not read a working day, because its length is a calendar decision', () => {
    assert.equal(canonicalUnit('wd'), undefined);
    assert.equal(canonicalUnit('working day'), undefined);
    assert.equal(unitSymbol('day'), 'day', 'a day as twenty-four hours is read');
    assert.equal(convert(1, 'day', 'h'), 24);
  });

  it('does not read "qty", because a column heading is not a unit', () => {
    assert.equal(canonicalUnit('qty'), undefined);
  });

  it('does not treat currency as a dimension', () => {
    for (const money of ['gbp', '£', 'usd', 'eur']) {
      assert.equal(canonicalUnit(money), undefined, `"${money}" is money, and an exchange rate is a decision with a date on it`);
    }
  });
});

describe('the registry itself holds together', () => {
  it('gives every dimension a base unit that is present and has a factor of one', () => {
    for (const dimension of UNIT_DIMENSION) {
      const symbol = BASE_UNIT[dimension];
      const unit = UNITS.find((candidate) => candidate.symbol === symbol);
      assert.ok(unit, `${dimension} names ${symbol} as its base and no such unit exists`);
      assert.equal(unit.dimension, dimension, `${symbol} is the base of ${dimension} but is declared as ${unit.dimension}`);
      assert.equal(unit.perBase, 1, `${symbol} is a base unit and must have a factor of exactly 1`);
    }
  });

  it('declares no unit twice and no factor of zero', () => {
    const seen = new Set<string>();
    for (const unit of UNITS) {
      assert.ok(!seen.has(unit.symbol), `${unit.symbol} is declared twice`);
      seen.add(unit.symbol);
      assert.ok(unit.perBase > 0, `${unit.symbol} has a factor of ${unit.perBase}`);
      assert.ok(unit.label.trim().length > 0, `${unit.symbol} has no label`);
    }
  });

  it('reads back every symbol it publishes', () => {
    // A unit the catalogue offers and the reader rejects would be a form that
    // produces quantities the engine then refuses to check.
    for (const unit of unitCatalogue()) {
      assert.equal(unitSymbol(unit.symbol), unit.symbol, `${unit.symbol} is published and does not read back`);
    }
    assert.equal(unitCatalogue().length, UNITS.length);
  });

  it('converts every unit to its own base and back', () => {
    for (const unit of UNITS) {
      const base = BASE_UNIT[unit.dimension];
      const there = convert(7, unit.symbol, base);
      assert.ok(Number.isFinite(there), `${unit.symbol} does not convert to ${base}`);
      assert.ok(Math.abs(convert(there, base, unit.symbol) - 7) < 1e-9, `${unit.symbol} does not round-trip through ${base}`);
    }
  });
});

describe('sameDimension', () => {
  it('is true only when both sides read and agree', () => {
    assert.equal(sameDimension('m', 'mm'), true);
    assert.equal(sameDimension('sq m', 'ft2'), true);
    assert.equal(sameDimension('m', 'm2'), false);
    // Two units nobody can read are not the same dimension even when the text
    // matches, because there is no dimension to agree on. Returning true here
    // would let two unreadable units compare clean, which is exactly the
    // silence this module exists to break.
    assert.equal(sameDimension('widgets', 'widgets'), false);
    assert.equal(sameDimension('m', 'widgets'), false);
  });
});
