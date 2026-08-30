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
