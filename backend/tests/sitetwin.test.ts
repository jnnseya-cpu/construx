import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// The browser module, imported for its arithmetic. The shaders and the orbit
// controls need a browser and are exercised by driving the console; what is
// here is the part that decides what gets drawn.
import { _internals } from '../../frontend/lib/sitetwin.js';

/**
 * The three-dimensional view's arithmetic.
 *
 * The shaders and the orbit controls need a browser and are exercised by
 * driving the console. What is testable here is the part that decides *what*
 * gets drawn — and the one thing that must never happen is a flat plane
 * appearing where no ground was captured, because on a screen that reads as a
 * level site and nobody would question it.
 */

const { buildGeometry, frameOf, triangulate, signedArea, groundAt } = _internals as {
  buildGeometry: (scene: unknown) => Float32Array;
  frameOf: (scene: unknown) => { centre: number[]; radius: number };
  triangulate: (ring: Array<{ x: number; y: number }>) => unknown[];
  signedArea: (ring: Array<{ x: number; y: number }>) => number;
  groundAt: (surface: unknown, x: number, y: number) => number;
};

/** A 60 × 40 site rising evenly from z=0 at x=0 to z=3 at x=60. */
const SLOPE = {
  triangles: [
    [{ x: 0, y: 0, z: 0 }, { x: 60, y: 0, z: 3 }, { x: 0, y: 40, z: 0 }],
    [{ x: 60, y: 0, z: 3 }, { x: 60, y: 40, z: 3 }, { x: 0, y: 40, z: 0 }],
  ],
};

const box = (x: number, y: number, w: number, h: number) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

/** Six floats per vertex: position and colour, interleaved. */
const vertexCount = (data: Float32Array): number => data.length / 6;

describe('what the viewer draws', () => {
  it('draws no ground at all when none was captured', () => {
    // The whole point. A flat plane here reads as a level site to anybody
    // looking at the screen, and it is a measurement nobody made.
    const withoutGround = buildGeometry({ zones: [{ ring: box(0, 0, 10, 10), colour: '#ca8a04' }], boundary: undefined });
    const withGround = buildGeometry({
      surface: { triangles: [[{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 1 }, { x: 0, y: 10, z: 0 }]] },
      zones: [{ ring: box(0, 0, 10, 10), colour: '#ca8a04' }],
      boundary: undefined,
    });
    // Exactly three vertices more: the one captured triangle and nothing else.
    assert.equal(vertexCount(withGround) - vertexCount(withoutGround), 3);
  });

  it('draws the captured mesh at its own levels, not flattened', () => {
    const data = buildGeometry({
      surface: { triangles: [[{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 4 }, { x: 0, y: 10, z: -2 }]] },
      zones: [],
    });
    // z is the third float of each vertex.
    const heights = [data[2], data[8], data[14]];
    assert.deepEqual(heights, [0, 4, -2], 'the ground was drawn flat');
  });

  it('extrudes a zone into a top and four sides', () => {
    const data = buildGeometry({ zones: [{ ring: box(0, 0, 10, 10), colour: '#ca8a04' }] });
    // A rectangle triangulates into 2 triangles (6 vertices) for the top, and
    // each of its 4 edges is a quad of 2 triangles (6 vertices) for the sides.
    assert.equal(vertexCount(data), 6 + 4 * 6);
  });

  it('gives a zone the colour it was handed, not one of its own', () => {
    const data = buildGeometry({ zones: [{ ring: box(0, 0, 10, 10), colour: '#ff0000' }] });
    // The first side vertex carries the base colour unlightened; the top is
    // deliberately a shade up, so the base is what is checked.
    const sideStart = 6 * 6;
    assert.ok(Math.abs(data[sideStart + 3]! - 1) < 1e-6, 'red channel was not 1');
    assert.equal(data[sideStart + 4], 0);
    assert.equal(data[sideStart + 5], 0);
  });

  it('skips a ring that is not a ring rather than drawing nonsense', () => {
    const data = buildGeometry({ zones: [{ ring: [{ x: 0, y: 0 }, { x: 1, y: 1 }], colour: '#ff0000' }] });
    assert.equal(vertexCount(data), 0);
  });

  it('draws the boundary as a wall, so the site has an edge', () => {
    const data = buildGeometry({ zones: [], boundary: box(0, 0, 10, 10) });
    // Four edges, two triangles each.
    assert.equal(vertexCount(data), 4 * 6);
    // Two metres tall: the tallest z present.
    let maxZ = -Infinity;
    for (let i = 2; i < data.length; i += 6) maxZ = Math.max(maxZ, data[i]!);
    assert.equal(maxZ, 2);
  });

  it('draws nothing at all for an empty scene, so the caller can say so', () => {
    assert.equal(buildGeometry({ zones: [], boundary: undefined }).length, 0);
  });
});

/**
 * Sitting the layout on the ground.
 *
 * This is the defect the vertex-count tests above could not see. Every zone was
 * present, every triangle correct — and on a site that rose three metres across
 * its width, seven of nine zones were behind the terrain, because they were all
 * extruded from zero. A layout you cannot see is not a layout.
 */
describe('zones sit on the ground, not through it', () => {
  it('reads the captured level under a point', () => {
    // Along the slope: zero at the low edge, three at the high one, and
    // interpolated between rather than stepped.
    assert.ok(Math.abs(groundAt(SLOPE, 0, 20) - 0) < 1e-9);
    assert.ok(Math.abs(groundAt(SLOPE, 60, 20) - 3) < 1e-9);
    assert.ok(Math.abs(groundAt(SLOPE, 30, 20) - 1.5) < 1e-9);
    assert.ok(Math.abs(groundAt(SLOPE, 45, 10) - 2.25) < 1e-9);
  });

  it('is flat zero when nothing was captured, so zones share one plane', () => {
    assert.equal(groundAt(undefined, 30, 20), 0);
    assert.equal(groundAt({ triangles: [] }, 30, 20), 0);
  });

  it('uses the nearest captured level beyond the mesh rather than dropping to zero', () => {
    // The capture stopped short of this corner. Zero would bury the zone under
    // three metres of ground, which is the bug this whole section exists for.
    assert.equal(groundAt(SLOPE, 200, 20), 3);
  });

  it('lifts a zone on the high ground clear of the terrain', () => {
    // The laydown in the case study: x 32→54, where the ground is 1.6m→2.7m.
    // Every one of its vertices must be above the ground beneath it.
    const ring = box(32, 4, 22, 14);
    const data = buildGeometry({ surface: SLOPE, zones: [{ ring, colour: '#ca8a04' }] });
    const groundVertices = SLOPE.triangles.flat().length;
    let buried = 0;
    for (let v = groundVertices; v < data.length / 6; v += 1) {
      const [x, y, z] = [data[v * 6]!, data[v * 6 + 1]!, data[v * 6 + 2]!];
      if (z < groundAt(SLOPE, x, y) - 1e-9) buried += 1;
    }
    assert.equal(buried, 0, `${buried} vertices of the laydown were below the ground`);
  });

  it('follows the slope rather than sitting the whole zone on one level', () => {
    // A zone spanning the fall must be higher at its high end. Flattening it
    // onto a single level would float one end and bury the other.
    const data = buildGeometry({ surface: SLOPE, zones: [{ ring: box(0, 0, 60, 10), colour: '#ca8a04' }] });
    const groundVertices = SLOPE.triangles.flat().length;
    let lowEnd = Infinity;
    let highEnd = -Infinity;
    for (let v = groundVertices; v < data.length / 6; v += 1) {
      const [x, z] = [data[v * 6]!, data[v * 6 + 2]!];
      if (x === 0) lowEnd = Math.min(lowEnd, z);
      if (x === 60) highEnd = Math.max(highEnd, z);
    }
    assert.ok(Math.abs(lowEnd - 0) < 1e-9, `low end sat at ${lowEnd}, not on the ground`);
    assert.ok(Math.abs(highEnd - 3.5) < 1e-9, `high end sat at ${highEnd}, not 3m of ground plus 0.5m of zone`);
  });

  it('runs the boundary wall along the ground too', () => {
    // A wall at one level is underground at one end of a falling site and
    // floating at the other.
    const data = buildGeometry({ surface: SLOPE, zones: [], boundary: box(0, 0, 60, 40) });
    const groundVertices = SLOPE.triangles.flat().length;
    let maxZ = -Infinity;
    // Every vertex, not just the highest: checking the maximum alone passes
    // while any single corner of the wall still sits at a fixed level.
    for (let v = groundVertices; v < data.length / 6; v += 1) {
      const [x, y, z] = [data[v * 6]!, data[v * 6 + 1]!, data[v * 6 + 2]!];
      const ground = groundAt(SLOPE, x, y);
      assert.ok(
        Math.abs(z - ground) < 1e-9 || Math.abs(z - (ground + 2)) < 1e-9,
        `a wall vertex at (${x}, ${y}) sat at ${z}, and the ground there is ${ground}`,
      );
      maxZ = Math.max(maxZ, z);
    }
    // Two metres of hoarding on top of the three-metre high corner.
    assert.ok(Math.abs(maxZ - 5) < 1e-9, `the wall topped out at ${maxZ}`);
  });
});

describe('framing the camera', () => {
  it('centres on everything drawn, not on the origin', () => {
    const frame = frameOf({ zones: [{ ring: box(100, 200, 20, 20), colour: '#000000' }] });
    assert.deepEqual(frame.centre, [110, 210, 0]);
  });

  it('takes a radius that covers the whole site', () => {
    // 60 × 80 has a half-diagonal of 50.
    const frame = frameOf({ boundary: box(0, 0, 60, 80), zones: [] });
    assert.ok(Math.abs(frame.radius - 50) < 1e-6);
  });

  it('falls back to something usable when there is nothing to frame', () => {
    // A camera at radius zero renders a blank screen and looks like a bug.
    const frame = frameOf({ zones: [] });
    assert.ok(frame.radius > 0);
  });
});

describe('the triangulator the viewer carries', () => {
  it('handles a concave ring, so an L-shaped compound is not drawn as a rectangle', () => {
    const l = [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 30 },
      { x: 0, y: 30 },
    ];
    const triangles = triangulate(l) as Array<[{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }]>;
    assert.equal(triangles.length, l.length - 2);
    const total = triangles.reduce((sum, t) => sum + Math.abs(signedArea(t)), 0);
    assert.ok(Math.abs(total - 500) < 1e-6, `covered ${total}m² of a 500m² shape`);
  });

  it('gives the same result whichever way the ring was wound', () => {
    const ring = box(0, 0, 10, 20);
    assert.equal((triangulate(ring) as unknown[]).length, (triangulate([...ring].reverse()) as unknown[]).length);
  });
});
