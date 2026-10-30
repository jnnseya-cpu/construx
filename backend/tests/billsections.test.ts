import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sectionCodeOf, rollUpSections } from '../src/domain/measurement.ts';

/**
 * Rolling a measured bill up into its work sections — the step between a bill of
 * priced lines and a sectional pricing schedule that asks for one lump sum
 * against sub-structure, superstructure and the rest. The lump sum is the
 * roll-up of the lines filed under the same code, so it still traces to them.
 */

describe('bill sections · the cost code a line belongs to', () => {
  it('reads the section from the leading code, before the item number', () => {
    assert.equal(sectionCodeOf('E20.001'), 'E20');
    assert.equal(sectionCodeOf('WALL.012'), 'WALL');
    assert.equal(sectionCodeOf('r10.4'), 'R10');
  });

  it('strips a trailing number where there is no dot, and keeps a bare code', () => {
    assert.equal(sectionCodeOf('WALL001'), 'WALL');
    assert.equal(sectionCodeOf('FOUNDATIONS'), 'FOUNDATIONS');
    assert.equal(sectionCodeOf(''), '');
  });
});

describe('bill sections · the roll-up', () => {
  it('groups lines by section, sums the amount, and counts priced against total', () => {
    const sections = rollUpSections([
      { reference: 'E20.001', amountMinor: 109040, priced: true },
      { reference: 'E20.002', amountMinor: 65248, priced: true },
      { reference: 'WALL.001', amountMinor: 490245, priced: true },
      { reference: 'WALL.002', amountMinor: 0, priced: false },
    ]);
    assert.equal(sections.length, 2);

    const e20 = sections.find((s) => s.code === 'E20')!;
    assert.equal(e20.amountMinor, 174288);
    assert.equal(e20.items, 2);
    assert.equal(e20.priced, 2);

    const wall = sections.find((s) => s.code === 'WALL')!;
    assert.equal(wall.amountMinor, 490245);
    assert.equal(wall.items, 2);
    assert.equal(wall.priced, 1, 'one of the two WALL lines is unpriced, and the roll-up says so');
  });

  it('returns sections sorted by code, and nothing for an empty bill', () => {
    assert.deepEqual(rollUpSections([]), []);
    const codes = rollUpSections([
      { reference: 'R10.1', amountMinor: 10, priced: true },
      { reference: 'E20.1', amountMinor: 20, priced: true },
      { reference: 'F30.1', amountMinor: 30, priced: true },
    ]).map((s) => s.code);
    assert.deepEqual(codes, ['E20', 'F30', 'R10']);
  });
});
