import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as geo from '../src/domain/geometry.ts';

/**
 * Geometry, checked against answers worked out by hand.
 *
 * Every test here uses a shape whose area, volume, centroid or clearance can be
 * derived on paper, because a geometry suite that only checks a function against
 * itself proves the code is consistent rather than correct. Where a figure comes
 * from arithmetic rather than from a textbook, the arithmetic is in the comment.
 */

/** A 40m × 25m rectangle. Area 1000m², perimeter 130m, centroid (20, 12.5). */
const plot: geo.Ring = [
  { x: 0, y: 0 },
  { x: 40, y: 0 },
  { x: 40, y: 25 },
  { x: 0, y: 25 },
];

/** An L, 30×30 with a 20×20 bite out of the top right. Area 900 − 400 = 500m². */
const lShape: geo.Ring = [
  { x: 0, y: 0 },
  { x: 30, y: 0 },
  { x: 30, y: 10 },
  { x: 10, y: 10 },
  { x: 10, y: 30 },
  { x: 0, y: 30 },
];

describe('measurements a quantity surveyor could check by hand', () => {
  it('measures area, perimeter and the area centroid of a rectangle', () => {
    assert.equal(geo.area(plot), 1000);
    assert.equal(geo.perimeter(plot), 130);
    const c = geo.centroid(plot);
    assert.ok(Math.abs(c.x - 20) < 1e-9 && Math.abs(c.y - 12.5) < 1e-9);
  });

  it('measures a concave shape correctly, where a convex-only method would not', () => {
    // 30×30 less the 20×20 bite. Any method that assumes convexity gets 900.
    assert.equal(geo.area(lShape), 500);
  });

  it('gives the same area whichever way round the ring was drawn', () => {
    // A person tracing a boundary on a phone has no idea which way they went,
    // and a negative area reaching a report is a defect nobody would question.
    assert.equal(geo.area([...plot].reverse()), 1000);
    assert.equal(geo.area(lShape), geo.area([...lShape].reverse()));
  });

  it('computes the exact area centroid, which for a concave shape falls outside it', () => {
    // By hand: the L is a 30×10 strip (300m², centroid (15,5)) plus a 10×20
    // strip (200m², centroid (5,20)). Cx = (300·15 + 200·5)/500 = 11, and Cy is
    // 11 by the same sum. So the centroid is exactly (11,11).
    const c = geo.centroid(lShape);
    assert.ok(Math.abs(c.x - 11) < 1e-9 && Math.abs(c.y - 11) < 1e-9, JSON.stringify(c));

    // And (11,11) sits in the bite. This is not a defect, it is what a centroid
    // is — and it is exactly why nothing may place a compound at one without
    // checking it landed on the plot. `canTurnWithin` finds an interior point
    // properly for that reason.
    assert.equal(geo.containsPoint(lShape, c), false);
  });

  it('refuses a ring that is not a ring', () => {
    throwsCode(() => geo.area([{ x: 0, y: 0 }, { x: 1, y: 1 }]), 'GEOMETRY_DEGENERATE');
  });
});

describe('what is inside what', () => {
  it('answers containment for points inside, outside and in the bite of an L', () => {
    assert.equal(geo.containsPoint(lShape, { x: 5, y: 5 }), true);
    assert.equal(geo.containsPoint(lShape, { x: 25, y: 5 }), true);
    // In the missing corner: inside the bounding box, outside the shape.
    assert.equal(geo.containsPoint(lShape, { x: 25, y: 25 }), false);
    assert.equal(geo.containsPoint(lShape, { x: 50, y: 50 }), false);
  });

  it('does not lose a point on the horizontal line through a vertex', () => {
    // The classic ray-casting failure. Every vertex of this diamond sits on a
    // scan line, so a naive rule double-counts and reports the centre outside.
    const diamond: geo.Ring = [
      { x: 10, y: 0 },
      { x: 20, y: 10 },
      { x: 10, y: 20 },
      { x: 0, y: 10 },
    ];
    assert.equal(geo.containsPoint(diamond, { x: 10, y: 10 }), true);
    assert.equal(geo.containsPoint(diamond, { x: 19.9, y: 10 }), true);
    assert.equal(geo.containsPoint(diamond, { x: 20.1, y: 10 }), false);
  });

  /**
   * One deliberate non-test, recorded so nobody spends an afternoon on it.
   *
   * Swapping the ray-casting rule from `>` to `>=` is an *equivalent* mutant for
   * this domain: a differential run of 200,000 point/polygon pairs on simple
   * rings, with the point's y deliberately landing on vertex lines, found the
   * two rules disagreeing only where the point lies exactly on the boundary —
   * where "inside" has no single right answer — and never anywhere the answer is
   * defined. There is therefore no test here that distinguishes them, and its
   * absence is a finding rather than a gap.
   */

  it('measures distance to a segment, not to the line it lies on', () => {
    // The point is off the end of the segment. The infinite line is 0m away;
    // the segment is 5m away, and the segment is what the hoarding is.
    assert.equal(geo.distanceToSegment({ x: 15, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 5);
    assert.equal(geo.distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 3);
  });
});

describe('overlap, measured exactly rather than estimated', () => {
  it('computes the overlapping area of two rectangles', () => {
    // 40×25 against a 20×25 offset by 30 in x: they share x∈[30,40], y∈[0,25].
    const other: geo.Ring = [
      { x: 30, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 25 },
      { x: 30, y: 25 },
    ];
    assert.ok(Math.abs(geo.intersectionArea(plot, other) - 250) < 1e-6);
    assert.equal(geo.overlaps(plot, other), true);
  });

  it('computes overlap with a concave shape, which convex clipping gets wrong', () => {
    // A 30×30 square over the L. The intersection is the L itself: 500m².
    // Sutherland-Hodgman with the L as the clip polygon would return 900.
    const square: geo.Ring = [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 30 },
      { x: 0, y: 30 },
    ];
    assert.ok(Math.abs(geo.intersectionArea(square, lShape) - 500) < 1e-6, 'concave intersection was not exact');
  });

  it('reports no overlap for zones that merely sit near each other', () => {
    const away: geo.Ring = [
      { x: 100, y: 100 },
      { x: 110, y: 100 },
      { x: 110, y: 110 },
      { x: 100, y: 110 },
    ];
    assert.equal(geo.intersectionArea(plot, away), 0);
    assert.equal(geo.overlaps(plot, away), false);
  });

  it('does not clip an ear at a reflex vertex, which would triangulate into the notch', () => {
    // An arrowhead: a 10×10 square with a triangular notch bitten into its east
    // side, apex at (5,5). Area = 100 − 25 = 75.
    //
    // The L above does not discriminate: its bad ears happen to contain another
    // vertex and get rejected anyway. Here the ear at the reflex apex —
    // (10,0),(5,5),(10,10) — contains no other vertex, so only the convexity
    // test stops it. Without that test the notch is triangulated as if it were
    // part of the site, and 25m² of ground that is not there is measured, paved
    // and priced.
    // Listed starting at the reflex apex, which is what exposes it. Listed from
    // a convex corner instead, the loop finds a genuine ear first and the bug
    // hides — so the vertex a person happened to start tracing from decides
    // whether the answer is right, which is exactly the kind of defect that
    // reaches a site.
    const arrowhead: geo.Ring = [
      { x: 5, y: 5 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    assert.equal(geo.area(arrowhead), 75);

    const triangles = geo.triangulate(arrowhead);
    const total = triangles.reduce((sum, t) => sum + geo.area(t), 0);
    assert.ok(Math.abs(total - 75) < 1e-6, `triangles cover ${total}m² of a 75m² shape`);
    for (const t of triangles) {
      assert.ok(geo.containsPoint(arrowhead, geo.centroid(t)), `a triangle was clipped into the notch: ${JSON.stringify(t)}`);
    }
  });

  it('produces triangles that all lie inside the ring and do not overlap', () => {
    // Count and total area are not enough. Ear clipping that ignores reflex
    // vertices still yields n−2 triangles whose absolute areas can sum to the
    // right figure, while individual triangles spill outside the shape — and a
    // laydown measured from those triangles is measured over ground it does not
    // occupy.
    const triangles = geo.triangulate(lShape);
    for (const t of triangles) {
      assert.ok(geo.containsPoint(lShape, geo.centroid(t)), `a triangle sits outside the ring: ${JSON.stringify(t)}`);
    }
    for (let i = 0; i < triangles.length; i += 1) {
      for (let j = i + 1; j < triangles.length; j += 1) {
        const shared = geo.intersectionArea(triangles[i]!, triangles[j]!);
        assert.ok(shared < 1e-6, `two triangles overlap by ${shared}m², so area is double counted`);
      }
    }
  });

  it('triangulates a concave ring into the right number of triangles', () => {
    // Any simple polygon of n vertices triangulates into exactly n−2 triangles,
    // and the triangles must account for the whole area.
    const triangles = geo.triangulate(lShape);
    assert.equal(triangles.length, lShape.length - 2);
    const total = triangles.reduce((sum, t) => sum + geo.area(t), 0);
    assert.ok(Math.abs(total - 500) < 1e-6, `triangles cover ${total}m² of a 500m² shape`);
  });
});

describe('buffers, which is what an exclusion zone is', () => {
  it('grows a rectangle by the buffer distance on every side', () => {
    // 40×25 buffered by 5 becomes 50×35 = 1750m². The corners are mitred, so
    // this is exact rather than approximate for a right-angled shape.
    const buffered = geo.buffer(plot, 5);
    assert.ok(Math.abs(geo.area(buffered) - 1750) < 1e-6, `got ${geo.area(buffered)}m²`);
  });

  it('shrinks on a negative buffer, which is what a setback is', () => {
    // 40×25 inset by 5 becomes 30×15 = 450m².
    assert.ok(Math.abs(geo.area(geo.buffer(plot, -5)) - 450) < 1e-6);
  });

  it('buffers outward whichever way the ring was drawn', () => {
    // Winding decides which side is outside. Without normalising it, a boundary
    // traced clockwise on a phone buffers *inward*, and an exclusion zone that
    // shrinks instead of growing is the most dangerous possible direction for
    // this particular error.
    const clockwise = [...plot].reverse();
    assert.ok(Math.abs(geo.area(geo.buffer(clockwise, 5)) - 1750) < 1e-6, `got ${geo.area(geo.buffer(clockwise, 5))}m²`);
    assert.ok(Math.abs(geo.area(geo.buffer(clockwise, -5)) - 450) < 1e-6);
  });

  it('holds every original vertex inside the buffered ring', () => {
    const buffered = geo.buffer(lShape, 3);
    for (const vertex of lShape) {
      assert.ok(geo.containsPoint(buffered, vertex), `${JSON.stringify(vertex)} fell outside its own buffer`);
    }
  });

  it('builds a circle whose area matches πr²', () => {
    // 64 segments inscribed in r=10: area is πr² less a little, and within 0.2%.
    const ring = geo.circle({ x: 0, y: 0 }, 10);
    const exact = Math.PI * 100;
    assert.ok(Math.abs(geo.area(ring) - exact) / exact < 0.002);
  });

  it('detects a crane radius oversailing a boundary, which is the check that costs most', () => {
    // Slew centre 8m from the north boundary, 15m radius: it oversails.
    const boundary: geo.Ring = [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 40 },
      { x: 0, y: 40 },
    ];
    const envelope = geo.circle({ x: 30, y: 32 }, 15);
    const outside = geo.area(envelope) - geo.intersectionArea(envelope, boundary);
    assert.ok(outside > 0, 'a jib over the neighbour was reported as contained');

    // And the same crane moved clear of it does not.
    const clear = geo.circle({ x: 30, y: 20 }, 15);
    assert.ok(Math.abs(geo.area(clear) - geo.intersectionArea(clear, boundary)) < 1e-6);
  });
});

describe('surfaces, slopes and volumes', () => {
  /** A 10×10 pad, flat at 2m above datum. Volume above datum = 200m³. */
  const flatPad: geo.Surface = {
    triangles: [
      [{ x: 0, y: 0, z: 2 }, { x: 10, y: 0, z: 2 }, { x: 10, y: 10, z: 2 }],
      [{ x: 0, y: 0, z: 2 }, { x: 10, y: 10, z: 2 }, { x: 0, y: 10, z: 2 }],
    ],
  };

  it('computes the volume of a flat pad above a datum', () => {
    // 100m² × 2m = 200m³, and no fill.
    const v = geo.volumeAboveLevel(flatPad, 0);
    assert.equal(v.cutCubicMetres, 200);
    assert.equal(v.fillCubicMetres, 0);
    // Not negative zero, which is what the naive rounding produced and which
    // reads as a defect on a report.
    assert.ok(Object.is(v.fillCubicMetres, 0));
    assert.equal(v.netCubicMetres, 200);
  });

  it('separates cut from fill in one traverse', () => {
    // The same pad measured against a datum of 3m: it is now 1m of fill.
    const v = geo.volumeAboveLevel(flatPad, 3);
    assert.equal(v.cutCubicMetres, 0);
    assert.equal(v.fillCubicMetres, 100);
    assert.equal(v.netCubicMetres, -100);
  });

  it('computes the volume of a wedge exactly, where a sampled method drifts', () => {
    // A 10×10 wedge rising 0→3m along x. Mean height 1.5m, so 150m³ exactly.
    const wedge: geo.Surface = {
      triangles: [
        [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 3 }, { x: 10, y: 10, z: 3 }],
        [{ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 3 }, { x: 0, y: 10, z: 0 }],
      ],
    };
    assert.equal(geo.volumeAboveLevel(wedge, 0).cutCubicMetres, 150);
  });

  it('measures slope as a percentage and points the aspect downhill', () => {
    // Rising 3m over 10m eastward is a 30% slope falling to the west (270°).
    const face: geo.Triangle3 = [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 3 },
      { x: 0, y: 10, z: 0 },
    ];
    const slope = geo.slopeOf(face);
    assert.equal(slope.percent, 30);
    assert.equal(slope.aspectDegrees, 270);
  });

  it('finds the steepest triangle, which is the one that decides access', () => {
    const mixed: geo.Surface = {
      triangles: [
        [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0.5 }, { x: 0, y: 10, z: 0 }],
        [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 4 }, { x: 0, y: 10, z: 0 }],
      ],
    };
    assert.equal(geo.steepestSlope(mixed)?.percent, 40);
  });
});

describe('vehicles, and whether the ground is the right shape', () => {
  it('computes a swept path wider than the kerb radius, because the corner swings', () => {
    const artic = geo.DESIGN_VEHICLE.ARTIC_16_5!;
    const swept = geo.sweptPath(artic);
    // Outer is hypot(12.5 + 1.275, 16.5) = 21.5m to the front outer corner,
    // which is far more than the 12.5m kerb radius a drawing often shows.
    assert.ok(swept.outerMetres > artic.turningRadiusMetres + artic.widthMetres);
    assert.ok(Math.abs(swept.outerMetres - Math.hypot(12.5 + 1.275, 16.5)) < 0.01);
    assert.ok(Math.abs(swept.innerMetres - (12.5 - 1.275)) < 0.01);
  });

  it('fails a turning area that is large enough but the wrong shape', () => {
    // 2000m² — ample by area — but only 10m wide, so nothing turns in it.
    // This is the case a drawing passes and a driver fails.
    const corridor: geo.Ring = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 10 },
      { x: 0, y: 10 },
    ];
    assert.equal(geo.area(corridor), 2000);
    const verdict = geo.canTurnWithin(corridor, geo.DESIGN_VEHICLE.ARTIC_16_5!);
    assert.equal(verdict.fits, false);
    assert.ok(verdict.availableMetres < verdict.requiredMetres);
  });

  it('passes a yard that is genuinely big enough', () => {
    const yard: geo.Ring = [
      { x: 0, y: 0 },
      { x: 90, y: 0 },
      { x: 90, y: 90 },
      { x: 0, y: 90 },
    ];
    assert.equal(geo.canTurnWithin(yard, geo.DESIGN_VEHICLE.ARTIC_16_5!).fits, true);
  });

  it('lets a transit turn where an artic cannot', () => {
    const smallYard: geo.Ring = [
      { x: 0, y: 0 },
      { x: 22, y: 0 },
      { x: 22, y: 22 },
      { x: 0, y: 22 },
    ];
    assert.equal(geo.canTurnWithin(smallYard, geo.DESIGN_VEHICLE.TRANSIT!).fits, true);
    assert.equal(geo.canTurnWithin(smallYard, geo.DESIGN_VEHICLE.ARTIC_16_5!).fits, false);
  });
});

describe('routing on the site road graph', () => {
  const nodes: geo.RouteNode[] = [
    { id: 'GATE', point: { x: 0, y: 0 } },
    { id: 'JUNCTION', point: { x: 100, y: 0 } },
    { id: 'NARROWS', point: { x: 0, y: 50 } },
    { id: 'LAYDOWN', point: { x: 100, y: 50 } },
  ];
  const edges: geo.RouteEdge[] = [
    { from: 'GATE', to: 'JUNCTION', widthMetres: 6 },
    { from: 'JUNCTION', to: 'LAYDOWN', widthMetres: 6 },
    // The short way, but only 2m wide.
    { from: 'GATE', to: 'NARROWS', widthMetres: 2 },
    { from: 'NARROWS', to: 'LAYDOWN', widthMetres: 2 },
  ];

  it('takes the shortest way when everything fits', () => {
    const route = geo.shortestRoute(nodes, edges, 'GATE', 'LAYDOWN', geo.DESIGN_VEHICLE.TRANSIT!);
    // Both ways are 150m for a 2m-wide van, and it takes one of them.
    assert.ok(route);
    assert.equal(route.metres, 150);
  });

  it('refuses a road narrower than the vehicle rather than routing down it', () => {
    // The artic is 2.55m wide, so the 2m route is not a route. It must go the
    // long way — and 150m either way here, so the test is that it found a path
    // at all and that it is the wide one.
    const route = geo.shortestRoute(nodes, edges, 'GATE', 'LAYDOWN', geo.DESIGN_VEHICLE.ARTIC_16_5!);
    assert.ok(route);
    assert.deepEqual(route.path, ['GATE', 'JUNCTION', 'LAYDOWN']);
  });

  it('returns nothing when no route is wide enough, rather than the narrow one', () => {
    const onlyNarrow: geo.RouteEdge[] = [
      { from: 'GATE', to: 'NARROWS', widthMetres: 2 },
      { from: 'NARROWS', to: 'LAYDOWN', widthMetres: 2 },
    ];
    assert.equal(geo.shortestRoute(nodes, onlyNarrow, 'GATE', 'LAYDOWN', geo.DESIGN_VEHICLE.ARTIC_16_5!), undefined);
  });

  it('honours a one-way restriction', () => {
    const oneWay: geo.RouteEdge[] = [
      { from: 'GATE', to: 'JUNCTION', widthMetres: 6, oneWay: true },
      { from: 'JUNCTION', to: 'LAYDOWN', widthMetres: 6, oneWay: true },
    ];
    assert.ok(geo.shortestRoute(nodes, oneWay, 'GATE', 'LAYDOWN'));
    // And nothing comes back the way it went.
    assert.equal(geo.shortestRoute(nodes, oneWay, 'LAYDOWN', 'GATE'), undefined);
  });

  it('refuses endpoints that are not on the graph', () => {
    throwsCode(() => geo.shortestRoute(nodes, edges, 'GATE', 'NOWHERE'), 'ROUTE_NODE_UNKNOWN');
  });
});

/**
 * The volume between two captures.
 *
 * `volumeAboveLevel` measures against a datum, which is all one capture can
 * support. This measures against an *earlier capture*, which is the question a
 * progress claim actually asks: how much has gone since the last scan, and does
 * it agree with the muck-away tickets.
 *
 * Every figure is worked out by hand and written into the comment. A volume is
 * paid against, so a test that only checks the code agrees with itself is worth
 * nothing here.
 */
describe('volume between two surfaces', () => {
  /** A level plane over a square, as two triangles. */
  const plane = (size: number, level: number): geo.Surface => ({
    triangles: [
      [{ x: 0, y: 0, z: level }, { x: size, y: 0, z: level }, { x: 0, y: size, z: level }],
      [{ x: size, y: 0, z: level }, { x: size, y: size, z: level }, { x: 0, y: size, z: level }],
    ],
  });

  it('measures material placed', () => {
    // 10 × 10m raised by 1m: 100m³ of fill and no cut.
    const change = geo.volumeBetween(plane(10, 0), plane(10, 1));
    assert.equal(change.fillCubicMetres, 100);
    assert.equal(change.cutCubicMetres, 0);
    assert.equal(change.netCubicMetres, 100);
    assert.equal(change.comparedSquareMetres, 100);
    assert.equal(change.uncomparedSquareMetres, 0);
  });

  it('measures material taken away', () => {
    // The same ground dug down 1.5m: 150m³ of cut, and the net is negative
    // because the site is lower than it was.
    const change = geo.volumeBetween(plane(10, 0), plane(10, -1.5));
    assert.equal(change.cutCubicMetres, 150);
    assert.equal(change.fillCubicMetres, 0);
    assert.equal(change.netCubicMetres, -150);
  });

  it('reports cut and fill separately when both happened', () => {
    // 20 × 10m. The western half is dug 2m down, the eastern half raised 1m.
    // Cut is 10 × 10 × 2 = 200m³ and fill is 10 × 10 × 1 = 100m³. A net figure
    // alone would say 100m³ of fill and hide the 200m³ that left the site,
    // which is the number the haulage was invoiced against.
    const before: geo.Surface = {
      triangles: [
        [{ x: 0, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }],
        [{ x: 20, y: 0, z: 0 }, { x: 20, y: 10, z: 0 }, { x: 0, y: 10, z: 0 }],
      ],
    };
    const after: geo.Surface = {
      triangles: [
        [{ x: 0, y: 0, z: -2 }, { x: 10, y: 0, z: -2 }, { x: 0, y: 10, z: -2 }],
        [{ x: 10, y: 0, z: -2 }, { x: 10, y: 10, z: -2 }, { x: 0, y: 10, z: -2 }],
        [{ x: 10, y: 0, z: 1 }, { x: 20, y: 0, z: 1 }, { x: 10, y: 10, z: 1 }],
        [{ x: 20, y: 0, z: 1 }, { x: 20, y: 10, z: 1 }, { x: 10, y: 10, z: 1 }],
      ],
    };
    const change = geo.volumeBetween(before, after);
    assert.equal(change.cutCubicMetres, 200);
    assert.equal(change.fillCubicMetres, 100);
    assert.equal(change.netCubicMetres, -100);
    assert.equal(change.comparedSquareMetres, 200);
  });

  it('measures a wedge exactly, not by sampling it', () => {
    // A spoil heap as a wedge: flat at one edge, 3m at the other, over a
    // 10 × 10m footprint. Its mean height is 1.5m, so the volume is exactly
    // 150m³. A grid method gives a different answer every time the grid moves,
    // and this figure is what gets invoiced.
    const after: geo.Surface = {
      triangles: [
        [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 3 }, { x: 0, y: 10, z: 0 }],
        [{ x: 10, y: 0, z: 3 }, { x: 10, y: 10, z: 3 }, { x: 0, y: 10, z: 0 }],
      ],
    };
    const change = geo.volumeBetween(plane(10, 0), after);
    assert.equal(change.fillCubicMetres, 150);
    assert.equal(change.cutCubicMetres, 0);
  });

  it('says how much ground the two captures did not share', () => {
    // The second walk covered 10 × 10m; the first only reached the western
    // 4 × 10m of it. 40m² can be compared and 60m² cannot, and the volume is
    // over the 40m² alone: 1m of rise there is 40m³, not 100m³.
    //
    // Absorbing the difference silently is the failure this guards. A reader
    // handed "40m³" over an unstated footprint assumes it covers the site.
    const before: geo.Surface = {
      triangles: [
        [{ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }],
        [{ x: 4, y: 0, z: 0 }, { x: 4, y: 10, z: 0 }, { x: 0, y: 10, z: 0 }],
      ],
    };
    const change = geo.volumeBetween(before, plane(10, 1));
    assert.equal(change.comparedSquareMetres, 40);
    assert.equal(change.uncomparedSquareMetres, 60);
    assert.equal(change.fillCubicMetres, 40);
  });

  it('takes the mean over each piece, not the value at one of its corners', () => {
    // One sloping triangle over one flat one, same footprint, so the whole
    // comparison is a single piece and there is nowhere for an error to average
    // itself out.
    //
    // 12 × 12m right triangle: footprint 72m². The later surface is 0 at two
    // corners and 3m at the third, so its mean height over the piece is
    // (0 + 3 + 0) ÷ 3 = 1m and the volume is exactly 72m³.
    //
    // Sampling at a corner instead gives 0 × 72 = 0m³ or 3 × 72 = 216m³ —
    // never 72 — so this fails for any corner the code might pick.
    const before: geo.Surface = {
      triangles: [[{ x: 0, y: 0, z: 0 }, { x: 12, y: 0, z: 0 }, { x: 0, y: 12, z: 0 }]],
    };
    const after: geo.Surface = {
      triangles: [[{ x: 0, y: 0, z: 0 }, { x: 12, y: 0, z: 3 }, { x: 0, y: 12, z: 0 }]],
    };
    const change = geo.volumeBetween(before, after);
    assert.equal(change.comparedSquareMetres, 72);
    assert.equal(change.fillCubicMetres, 72);
    assert.equal(change.cutCubicMetres, 0);
  });

  it('reports nothing moved when nothing moved', () => {
    const change = geo.volumeBetween(plane(10, 2), plane(10, 2));
    assert.equal(change.cutCubicMetres, 0);
    assert.equal(change.fillCubicMetres, 0);
    assert.equal(change.netCubicMetres, 0);
    assert.equal(change.comparedSquareMetres, 100);
  });

  it('compares the same ground however the device wound its triangles', () => {
    // A mesh from a handset carries no promise about vertex order. Clipping
    // treats one winding as inside-out and finds no overlap at all, so a real
    // 100m³ of fill is reported as nothing moved over no shared ground — which
    // reads exactly like a site nobody has touched.
    const clockwise: geo.Surface = {
      triangles: [
        [{ x: 0, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }, { x: 10, y: 0, z: 0 }],
        [{ x: 10, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }, { x: 10, y: 10, z: 0 }],
      ],
    };
    const change = geo.volumeBetween(clockwise, plane(10, 1));
    assert.equal(change.comparedSquareMetres, 100, 'the two captures were treated as different ground');
    assert.equal(change.fillCubicMetres, 100);
  });

  it('ignores a vertical triangle rather than dividing by its zero footprint', () => {
    // A wall face in the mesh has no plan area and no single height at a point.
    // It must contribute nothing rather than a NaN that propagates into the
    // total.
    const after: geo.Surface = {
      triangles: [
        ...plane(10, 1).triangles,
        [{ x: 3, y: 3, z: 0 }, { x: 3, y: 7, z: 0 }, { x: 3, y: 5, z: 4 }],
      ],
    };
    const change = geo.volumeBetween(plane(10, 0), after);
    assert.equal(change.fillCubicMetres, 100);
    assert.ok(Number.isFinite(change.netCubicMetres));
  });
});

describe('a ring that states its own closure', () => {
  it('triangulates a triangle written with its first vertex repeated', () => {
    // Every ring here is implicitly closed, so [a, b, c, a] is the same
    // three-sided shape written a different way. Ear clipping could not see
    // that: it compared vertices by reference, so the repeated `a` was a
    // different object at the same coordinates, sat on the boundary of every
    // candidate ear, and rejected all of them. The function returned nothing
    // for a perfectly good triangle.
    const open = geo.triangulate([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 10 }]);
    const closed = geo.triangulate([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 10 }, { x: 0, y: 0 }]);
    assert.equal(closed.length, 1, 'a closed triangle triangulated to nothing');
    assert.deepEqual(closed, open, 'the two spellings of one shape gave different answers');
  });

  it('triangulates a closed square, covering all of it', () => {
    const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    const closed = geo.triangulate([...square, { x: 0, y: 0 }]);
    assert.equal(closed.length, 2);
    assert.equal(closed.reduce((sum, t) => sum + geo.area(t), 0), 100);
  });

  it('drops a zero-length edge, which is not a side of anything', () => {
    // A vertex repeated mid-ring is an edge of no length. It breaks the same
    // comparison and it is not a corner of the shape.
    const doubled = geo.triangulate([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
    assert.equal(doubled.length, 2);
    assert.equal(doubled.reduce((sum, t) => sum + geo.area(t), 0), 100);
  });

  it('still refuses something that is not a ring once the repeats are gone', () => {
    // [a, a, a] is one point written three times, not a triangle. It used to
    // come back as a triangle of zero area, which is worse than a refusal
    // because everything downstream treats it as ground.
    throwsCode(() => geo.triangulate([{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }]), 'GEOMETRY_DEGENERATE');
    throwsCode(() => geo.triangulate([{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 0 }]), 'GEOMETRY_DEGENERATE');
  });

  it('leaves an ordinary ring exactly as it was', () => {
    const ring = [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 6 }, { x: 0, y: 6 }];
    const triangles = geo.triangulate(ring);
    assert.equal(triangles.length, 2);
    assert.equal(triangles.reduce((sum, t) => sum + geo.area(t), 0), 48);
  });
});

describe('the level under a point', () => {
  const ramp: geo.Surface = {
    triangles: [
      [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 5 }, { x: 0, y: 10, z: 0 }],
      [{ x: 10, y: 0, z: 5 }, { x: 10, y: 10, z: 5 }, { x: 0, y: 10, z: 0 }],
    ],
  };

  it('interpolates across the triangle rather than stepping at its edges', () => {
    // 5m of rise over 10m, so halfway across is 2.5m and a quarter across is
    // 1.25m. A stepped answer would give the same level over a whole triangle
    // and read as terracing.
    assert.equal(geo.heightAt(ramp, { x: 5, y: 5 }), 2.5);
    assert.equal(geo.heightAt(ramp, { x: 2.5, y: 5 }), 1.25);
    assert.equal(geo.heightAt(ramp, { x: 0, y: 5 }), 0);
  });

  it('has no level at all on a triangle standing on its edge', () => {
    // A vertical face projects to a line, so a point on that line has no single
    // level: the face spans every height from 0 to 4 directly above it. The
    // only true answer is that there is no measurement. Returning zero would
    // put a level on the record that the plane never had, and it would be used
    // as ground.
    const wall: geo.Surface = {
      triangles: [[{ x: 3, y: 0, z: 0 }, { x: 3, y: 10, z: 0 }, { x: 3, y: 5, z: 4 }]],
    };
    assert.equal(geo.heightAt(wall, { x: 3, y: 5 }), undefined);
  });

  it('says there is no measurement rather than saying zero', () => {
    // Ground the walk did not reach. Zero is a level, and a level is a
    // measurement nobody made — it would sit in a volume as real material.
    assert.equal(geo.heightAt(ramp, { x: 100, y: 100 }), undefined);
  });
});

describe('the smallest and largest of a great many numbers', () => {
  /**
   * The crash a small test mesh cannot find.
   *
   * `Math.min(...values)` passes one argument per element, and past a few tens
   * of thousands of them the engine's stack is gone: `RangeError: Maximum call
   * stack size exceeded`, surfacing as a 500 rather than as a slow answer. Three
   * call sites in the segmenter and two in the reconstruction solver were
   * written that way, and every one was correct on the ten-triangle fixtures
   * they were tested against.
   *
   * It took a real depth image to find. A 256 × 192 frame — what ARKit's
   * `sceneDepth` actually hands over — is 92,900 triangles and 278,700 levels,
   * and segmenting one failed outright.
   */
  it('handles more values than a spread call could pass', () => {
    const many = Array.from({ length: 300_000 }, (_, index) => index - 150_000);
    // Proof that the array really is past the limit: written the old way, this
    // is the failure. If a future engine raises the cap this assertion is what
    // says the test no longer covers what it was written for.
    assert.throws(() => Math.min(...many), RangeError);

    const { min, max } = geo.extent(many);
    assert.equal(min, -150_000);
    assert.equal(max, 149_999);
  });

  it('answers as Math.min and Math.max do on nothing at all', () => {
    // A caller testing Number.isFinite reads the same result either way, which
    // is what the segmenter's ponding check does with an unreachable boundary.
    assert.deepEqual(geo.extent([]), { min: Infinity, max: -Infinity });
  });

  it('finds both ends in one pass over the same values', () => {
    assert.deepEqual(geo.extent([3, -1, 7, 7, 0]), { min: -1, max: 7 });
    assert.deepEqual(geo.extent([2.5]), { min: 2.5, max: 2.5 });
  });
});
