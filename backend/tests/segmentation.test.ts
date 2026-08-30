import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as geo from '../src/domain/geometry.ts';
import { LOGISTICS_ELEMENT } from '../src/engines/sitevisit.ts';
import * as seg from '../src/domain/segmentation.ts';

/**
 * Segmenting a site by the shape of its ground.
 *
 * Every figure below is worked out by hand and written into the comment, for
 * the reason the geometry suite gives: a segmentation checked only against
 * itself proves the code is consistent, not that it is right.
 *
 * The case that matters most is the last one in the ponding block. A hollow and
 * a slope can have identical gradients everywhere and completely different
 * consequences — one holds water and one drains — and no threshold on steepness
 * separates them.
 */

const flat = (size: number, level = 0): geo.Surface => ({
  triangles: [
    [{ x: 0, y: 0, z: level }, { x: size, y: 0, z: level }, { x: 0, y: size, z: level }],
    [{ x: size, y: 0, z: level }, { x: size, y: size, z: level }, { x: 0, y: size, z: level }],
  ],
});

describe('classifying ground by gradient', () => {
  it('calls a flat plane level, and measures it', () => {
    const result = seg.segment(flat(20));
    assert.equal(result.regions.length, 1);
    const region = result.regions[0]!;
    assert.equal(region.form, 'LEVEL');
    assert.equal(region.areaSquareMetres, 400);
    assert.equal(region.meanSlopePercent, 0);
    // The outline is a real polygon, and it encloses the area quoted beside it.
    assert.equal(geo.area(region.ring), 400);
    assert.equal(result.usableSquareMetres, 400);
  });

  it('puts each gradient in the class that governs what may happen on it', () => {
    // The thresholds are decisions, not decoration: 1 in 12 is the limit for a
    // route people and plant share, and either side of it are different sites.
    assert.equal(seg.formOf(0), 'LEVEL');
    assert.equal(seg.formOf(2), 'LEVEL');
    assert.equal(seg.formOf(2.01), 'GENTLE');
    assert.equal(seg.formOf(5), 'GENTLE');
    assert.equal(seg.formOf(8.33), 'WORKABLE');
    assert.equal(seg.formOf(8.34), 'STEEP');
    assert.equal(seg.formOf(25), 'STEEP');
    assert.equal(seg.formOf(26), 'BATTER');
    assert.equal(seg.formOf(100), 'BATTER');
    assert.equal(seg.formOf(101), 'FACE');
  });

  it('separates a flat yard from the batter beside it', () => {
    // 20 × 20m. The left half is level; the right half climbs 6m over 10m,
    // which is 60% — a face, not ground anything is sited on. Two regions of
    // 200m² each, and only the flat half counts as usable.
    const surface: geo.Surface = {
      triangles: [
        [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 0, y: 20, z: 0 }],
        [{ x: 10, y: 0, z: 0 }, { x: 10, y: 20, z: 0 }, { x: 0, y: 20, z: 0 }],
        [{ x: 10, y: 0, z: 0 }, { x: 20, y: 0, z: 6 }, { x: 10, y: 20, z: 0 }],
        [{ x: 20, y: 0, z: 6 }, { x: 20, y: 20, z: 6 }, { x: 10, y: 20, z: 0 }],
      ],
    };
    const result = seg.segment(surface);
    assert.equal(result.regions.length, 2);

    const level = result.regions.find((region) => region.form === 'LEVEL');
    const batter = result.regions.find((region) => region.form === 'BATTER');
    assert.ok(level && batter, `got ${result.regions.map((r) => r.form).join(', ')}`);
    assert.equal(level.areaSquareMetres, 200);
    assert.equal(batter.areaSquareMetres, 200);
    assert.equal(batter.maxSlopePercent, 60);
    assert.equal(batter.highestLevelMetres, 6);
    assert.equal(result.usableSquareMetres, 200, 'the batter was counted as buildable ground');
  });

  it('grows a region across the triangles rather than reporting each one', () => {
    // Four coplanar triangles are one piece of ground, not four. A segmentation
    // that returned the mesh back is not a segmentation.
    const surface: geo.Surface = {
      triangles: [
        [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }],
        [{ x: 10, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }, { x: 0, y: 10, z: 0 }],
        [{ x: 10, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }],
        [{ x: 20, y: 0, z: 0 }, { x: 20, y: 10, z: 0 }, { x: 10, y: 10, z: 0 }],
      ],
    };
    const result = seg.segment(surface);
    assert.equal(result.regions.length, 1);
    assert.equal(result.regions[0]!.triangles, 4);
    assert.equal(result.regions[0]!.areaSquareMetres, 200);
    assert.equal(geo.area(result.regions[0]!.ring), 200);
  });

  it('averages a region by area, not by triangle count', () => {
    // One large triangle at 0% and three small ones at 2%, all inside LEVEL so
    // they form a single region. By area the mean is near zero; by triangle
    // count it is 1.5% — an order of magnitude out, and it is the figure a
    // reader takes as "how flat is that yard".
    //
    // A 400m² yard at 0%, and a 10m² wedge at 1% hung off its western edge so
    // the two grow into one region. Area-weighted the mean is
    // (400×0 + 10×1) ÷ 410 = 0.024%. By triangle count it is (0 + 1) ÷ 2 =
    // 0.5% — twenty times larger, off a strip a fiftieth of the size.
    const surface: geo.Surface = {
      triangles: [
        [{ x: 0, y: 0, z: 0 }, { x: 40, y: 0, z: 0 }, { x: 0, y: 20, z: 0 }],
        // Shares the edge (0,0)–(0,20), so region growing joins it.
        [{ x: 0, y: 0, z: 0 }, { x: 0, y: 20, z: 0 }, { x: -1, y: 10, z: 0.01 }],
      ],
    };
    const result = seg.segment(surface);
    const largest = result.regions[0]!;
    assert.equal(largest.form, 'LEVEL');
    assert.equal(largest.triangles, 2, 'the wedge did not join the yard into one region');
    assert.equal(largest.areaSquareMetres, 410);
    assert.ok(
      largest.meanSlopePercent < 0.2,
      `the mean came back at ${largest.meanSlopePercent}%, which is the unweighted answer rather than the area one`,
    );
  });

  it('does not count a vertical face as ground', () => {
    // The side of a wall captured square on: three points in a vertical plane.
    // It has no plan area — it occupies no square metre of the site — and its
    // gradient is infinite.
    //
    // Put it *next to* a steep face and the danger shows: both classify as
    // FACE, so region growing merges them, and an area-weighted mean then
    // computes Infinity × 0, which is NaN. One triangle standing on its edge
    // turns the reported gradient of a real region into "NaN%". Dropping it on
    // plan area is what prevents that, and it has to be dropped before the
    // gradient is ever taken.
    //
    // The steep face is 30m of rise over 10m — 300%, a face by any measure —
    // with a 50m² footprint. The vertical panel shares its western edge.
    const surface: geo.Surface = {
      triangles: [
        [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 30 }, { x: 0, y: 10, z: 0 }],
        [{ x: 0, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }, { x: 0, y: 5, z: 5 }],
      ],
    };
    const result = seg.segment(surface);
    assert.equal(result.regions.length, 1);
    const face = result.regions[0]!;
    assert.equal(face.triangles, 1, 'the vertical panel was counted as ground');
    assert.equal(face.areaSquareMetres, 50, 'a vertical face added ground area');
    assert.ok(
      Number.isFinite(face.meanSlopePercent),
      `the region's gradient came back as ${face.meanSlopePercent}`,
    );
    assert.equal(result.coveredSquareMetres, 50);
  });

  it('gives no downhill direction for ground that has no fall', () => {
    // An aspect on level ground sends somebody looking for a fall that is not
    // there, and 0° reads as due north rather than as absent.
    assert.equal(seg.segment(flat(20)).regions[0]!.aspectDegrees, undefined);
  });
});

describe('ground that holds water', () => {
  it('finds a hollow that every slope rule calls good ground', () => {
    // A 10 × 10m bowl: corners at 1m, centre at 0. Every face rises 1m over 5m,
    // which is 20% — inside STEEP and nowhere near a warning. What makes it a
    // problem is that the lowest point is 1m below the lowest way out.
    const surface: geo.Surface = {
      triangles: [
        [{ x: 0, y: 0, z: 1 }, { x: 10, y: 0, z: 1 }, { x: 5, y: 5, z: 0 }],
        [{ x: 10, y: 0, z: 1 }, { x: 10, y: 10, z: 1 }, { x: 5, y: 5, z: 0 }],
        [{ x: 10, y: 10, z: 1 }, { x: 0, y: 10, z: 1 }, { x: 5, y: 5, z: 0 }],
        [{ x: 0, y: 10, z: 1 }, { x: 0, y: 0, z: 1 }, { x: 5, y: 5, z: 0 }],
      ],
    };
    const result = seg.segment(surface);
    assert.equal(result.regions.length, 1);
    const bowl = result.regions[0]!;
    assert.equal(bowl.ponds, true, 'a closed hollow was not reported as ponding');
    assert.equal(bowl.pondingDepthMetres, 1);
    assert.equal(result.pondingSquareMetres, 100);
    // Whatever its gradient allows, ground that ponds suits nothing until it
    // is drained — and that has to override the slope class rather than sit
    // beside it.
    assert.deepEqual(bowl.suits, ['STANDING_WATER']);
  });

  it('does not call a slope a hollow just because it is the lowest ground', () => {
    // The discriminating case, and the reason ponding is not a threshold on
    // steepness. This ramp falls at exactly the same 20% as the bowl above and
    // reaches exactly the same low level — but its low point is *on its own
    // outline*, so water leaves. Anything keying off gradient or minimum level
    // reports these two identically.
    const surface: geo.Surface = {
      triangles: [
        [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 0, y: 10, z: 2 }],
        [{ x: 10, y: 0, z: 0 }, { x: 10, y: 10, z: 2 }, { x: 0, y: 10, z: 2 }],
      ],
    };
    const result = seg.segment(surface);
    assert.equal(result.regions.length, 1);
    const ramp = result.regions[0]!;
    assert.equal(ramp.form, 'STEEP', 'the control has a different gradient from the bowl');
    assert.equal(ramp.lowestLevelMetres, 0, 'the control reaches a different low level from the bowl');
    assert.equal(ramp.ponds, false, 'a slope that drains was reported as ponding');
    assert.equal(ramp.pondingDepthMetres, undefined);
    assert.equal(result.pondingSquareMetres, 0);
  });

  it('ignores a hollow shallower than the capture can resolve', () => {
    // 2cm deep over 10m. A handheld capture's vertical noise is that or more,
    // so reporting it as standing water is reporting the noise.
    const surface: geo.Surface = {
      triangles: [
        [{ x: 0, y: 0, z: 0.02 }, { x: 10, y: 0, z: 0.02 }, { x: 5, y: 5, z: 0 }],
        [{ x: 10, y: 0, z: 0.02 }, { x: 10, y: 10, z: 0.02 }, { x: 5, y: 5, z: 0 }],
        [{ x: 10, y: 10, z: 0.02 }, { x: 0, y: 10, z: 0.02 }, { x: 5, y: 5, z: 0 }],
        [{ x: 0, y: 10, z: 0.02 }, { x: 0, y: 0, z: 0.02 }, { x: 5, y: 5, z: 0 }],
      ],
    };
    assert.equal(seg.segment(surface).regions[0]!.ponds, false);
  });
});

describe('what it says it did not do', () => {
  it('states on the record that it read shape and not material', () => {
    const result = seg.segment(flat(20));
    assert.match(result.notClassified, /material/i);
    assert.match(result.notClassified, /bearing capacity/i);
    // On every region as well as on the summary. A consumer reading regions
    // through the API never sees the summary.
    for (const region of result.regions) assert.equal(region.classifies, 'FORM');
  });

  it('proposes site elements from the one taxonomy, not a list of its own', () => {
    const level = seg.segment(flat(20)).regions[0]!;
    assert.ok(level.suits.includes('LAYDOWN'));
    assert.ok(level.suits.includes('WELFARE'));
    // Never something a drawing has no colour or layer for.
    for (const code of level.suits) assert.ok(LOGISTICS_ELEMENT.includes(code), `${code} is not a site element`);
  });
});

describe('keeping the answer usable', () => {
  it('drops a patch too small to be a feature of the site', () => {
    // A 2m² sliver is capture noise. It cannot take a cabin and nobody wants it
    // on a drawing with a region number against it.
    const surface: geo.Surface = {
      triangles: [
        ...flat(20).triangles,
        [{ x: 40, y: 40, z: 0 }, { x: 42, y: 40, z: 0 }, { x: 40, y: 42, z: 0 }],
      ],
    };
    const result = seg.segment(surface);
    assert.equal(result.regions.length, 1);
    assert.equal(result.regions[0]!.areaSquareMetres, 400);
    // Still counted in what the capture covered, because it was captured.
    assert.equal(result.coveredSquareMetres, 402);
  });

  it('numbers regions largest first, and the same way every time', () => {
    const surface: geo.Surface = {
      triangles: [
        [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }],
        [{ x: 10, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }, { x: 0, y: 10, z: 0 }],
        [{ x: 10, y: 0, z: 0 }, { x: 40, y: 0, z: 18 }, { x: 10, y: 10, z: 0 }],
        [{ x: 40, y: 0, z: 18 }, { x: 40, y: 10, z: 18 }, { x: 10, y: 10, z: 0 }],
      ],
    };
    const first = seg.segment(surface);
    assert.deepEqual(first.regions.map((region) => region.regionId), ['R1', 'R2']);
    assert.ok(first.regions[0]!.areaSquareMetres >= first.regions[1]!.areaSquareMetres);
    assert.deepEqual(seg.segment(surface), first);
  });

  it('says so plainly when there is nothing to classify', () => {
    const result = seg.segment({ triangles: [] });
    assert.deepEqual(result.regions, []);
    assert.equal(result.coveredSquareMetres, 0);
    assert.match(result.summary, /no ground/i);
  });

  it('says when no part of the site can be built on as it stands', () => {
    // 40% throughout. A summary that only reported the usable area would say
    // "0m²" and leave the reader to decide whether that was a measurement.
    const surface: geo.Surface = {
      triangles: [
        [{ x: 0, y: 0, z: 0 }, { x: 20, y: 0, z: 8 }, { x: 0, y: 20, z: 0 }],
        [{ x: 20, y: 0, z: 8 }, { x: 20, y: 20, z: 8 }, { x: 0, y: 20, z: 0 }],
      ],
    };
    const result = seg.segment(surface);
    assert.equal(result.usableSquareMetres, 0);
    assert.match(result.summary, /without regrading/);
  });
});
