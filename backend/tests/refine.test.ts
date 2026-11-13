import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { partitionByCritique, shapeCritiques, shapeHolisticCritique } from '../src/ai/refine.ts';

/**
 * The verify-and-improve core. The reviewer's marks are shaped into one verdict
 * per drafted item, then applied to the draft: keep what passed, queue what must
 * be sharpened, drop what was cut. The point of the loop is that a weak item does
 * not reach the person — so the tests that matter are that a DROP is gone and a
 * malformed review never silently discards good work.
 */

describe('shaping a reviewer’s critique', () => {
  it('returns one verdict per drafted item, in order', () => {
    const critiques = shapeCritiques({ reviews: [{ index: 0, verdict: 'DROP', fault: 'immaterial' }] }, 3);
    assert.equal(critiques.length, 3);
    assert.deepEqual(critiques.map((c) => c.verdict), ['DROP', 'KEEP', 'KEEP']);
  });

  it('keeps an item the reviewer did not mark — silence is not a cut', () => {
    const critiques = shapeCritiques({ reviews: [{ index: 1, verdict: 'SHARPEN', fault: 'vague' }] }, 3);
    assert.equal(critiques[0]!.verdict, 'KEEP');
    assert.equal(critiques[1]!.verdict, 'SHARPEN');
    assert.equal(critiques[1]!.fault, 'vague');
    assert.equal(critiques[2]!.verdict, 'KEEP');
  });

  it('ignores an out-of-range or malformed index', () => {
    const critiques = shapeCritiques({ reviews: [{ index: 9, verdict: 'DROP' }, { index: -1, verdict: 'DROP' }] }, 2);
    assert.deepEqual(critiques.map((c) => c.verdict), ['KEEP', 'KEEP']);
  });

  it('treats an unrecognised verdict as KEEP, so a bad review never discards work', () => {
    const critiques = shapeCritiques({ reviews: [{ index: 0, verdict: 'BANISH' }] }, 1);
    assert.equal(critiques[0]!.verdict, 'KEEP');
  });

  it('survives a missing or non-array reviews field', () => {
    assert.equal(shapeCritiques({}, 2).length, 2);
    assert.equal(shapeCritiques({ reviews: 'nope' } as unknown as Record<string, unknown>, 2).length, 2);
    assert.ok(shapeCritiques({}, 2).every((c) => c.verdict === 'KEEP'));
  });
});

describe('applying a critique to a draft', () => {
  const items = ['a', 'b', 'c', 'd'];

  it('keeps KEEP, queues SHARPEN with its fault, and drops DROP', () => {
    const { keep, sharpen, droppedCount } = partitionByCritique(items, [
      { index: 0, verdict: 'KEEP', fault: '' },
      { index: 1, verdict: 'SHARPEN', fault: 'not quantified' },
      { index: 2, verdict: 'DROP', fault: 'already answered' },
      { index: 3, verdict: 'KEEP', fault: '' },
    ]);
    assert.deepEqual(keep, ['a', 'd']);
    assert.equal(sharpen.length, 1);
    assert.equal(sharpen[0]!.item, 'b');
    assert.equal(sharpen[0]!.fault, 'not quantified');
    assert.equal(droppedCount, 1);
  });

  it('keeps everything when the reviewer passes it all', () => {
    const { keep, sharpen, droppedCount } = partitionByCritique(['x', 'y'], [
      { index: 0, verdict: 'KEEP', fault: '' },
      { index: 1, verdict: 'KEEP', fault: '' },
    ]);
    assert.deepEqual(keep, ['x', 'y']);
    assert.equal(sharpen.length, 0);
    assert.equal(droppedCount, 0);
  });

  it('can cut the whole set when none of it is worth sending', () => {
    const { keep, sharpen, droppedCount } = partitionByCritique(['x', 'y'], [
      { index: 0, verdict: 'DROP', fault: 'generic' },
      { index: 1, verdict: 'DROP', fault: 'unsupported' },
    ]);
    assert.equal(keep.length, 0);
    assert.equal(sharpen.length, 0);
    assert.equal(droppedCount, 2);
  });
});

describe('shaping a holistic critique of a single reasoned output', () => {
  it('keeps substantive faults and drops stubs', () => {
    const critique = shapeHolisticCritique({
      sound: false,
      faults: ['The entitlement is asserted without naming the clause it rests on.', 'no', '  ', 'The time and money impacts are run together rather than separated.'],
    });
    assert.equal(critique.sound, false);
    assert.equal(critique.faults.length, 2);
  });

  it('reads an empty fault list as "the draft stands"', () => {
    const critique = shapeHolisticCritique({ sound: true, faults: [] });
    assert.equal(critique.sound, true);
    assert.equal(critique.faults.length, 0);
  });

  it('survives missing or malformed fields', () => {
    assert.deepEqual(shapeHolisticCritique({}), { sound: false, faults: [] });
    assert.deepEqual(shapeHolisticCritique({ faults: 'nope' } as unknown as Record<string, unknown>), { sound: false, faults: [] });
  });
});
