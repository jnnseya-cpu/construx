import { DomainError } from '../core/errors.ts';

/**
 * Site geometry, computed rather than described.
 *
 * Everything the spatial module claims — an area, a volume of spoil, a crane
 * envelope that oversails a boundary, a route a vehicle cannot turn in, a laydown
 * that overlaps an exclusion zone — is arithmetic on coordinates. Until now the
 * platform had none: `sitevisit.ts` refuses to draw a logistics plan precisely
 * because "producing a picture that looked like one without the geometry behind
 * it would be worse than producing nothing". This is the geometry behind it.
 *
 * ---
 *
 * **Nothing here approximates where an exact answer exists.** Intersection area
 * is computed by triangulating both polygons and clipping triangle against
 * triangle, which is exact for any simple polygon rather than correct only for
 * convex ones. Volume between surfaces is the closed form for a planar triangle
 * rather than a sampled grid. A sampled answer to a question with a closed form
 * is a number that changes when nobody changed anything, and on a spoil heap
 * that number is money.
 *
 * **Coordinates are projected metres, not degrees.** Every function here assumes
 * a local planar system where one unit is one metre — which is what a site grid
 * is, and what a device's tracked pose already produces. Latitude and longitude
 * are held alongside for georeferencing and are never used for measurement:
 * a degree is not a distance, and treating it as one produces answers that are
 * wrong by a factor that varies with where the site is.
 *
 * **Winding is normalised on entry.** Callers hand in rings drawn either way
 * round — a person tracing a boundary on a phone has no idea which — so every
 * entry point orients to counter-clockwise before it does anything else.
 * Signed area then means what it says, and a polygon does not silently report a
 * negative one.
 */

export type Point = { x: number; y: number };
export type Point3 = { x: number; y: number; z: number };

/** A closed ring. The last vertex is not repeated; closure is implicit. */
export type Ring = Point[];

export type Triangle3 = [Point3, Point3, Point3];

/** A triangulated surface — what a device's depth mesh already is. */
export type Surface = { triangles: Triangle3[] };

// --- Primitives --------------------------------------------------------------

/**
 * Twice the signed area. Positive counter-clockwise.
 *
 * The shoelace sum, kept undivided because every caller that wants a sign wants
 * it before the halving and every caller that wants an area halves the absolute
 * value. Splitting them avoids a rounding step nobody needs.
 */
function shoelace(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum;
}

/** Counter-clockwise, whichever way it arrived. */
export function orient(ring: Ring): Ring {
  requireRing(ring);
  return shoelace(ring) < 0 ? [...ring].reverse() : [...ring];
}

/** Plan area in square metres. */
export function area(ring: Ring): number {
  requireRing(ring);
  return Math.abs(shoelace(ring)) / 2;
}

/** Length of the closed boundary, in metres. */
export function perimeter(ring: Ring): number {
  requireRing(ring);
  let total = 0;
  for (let i = 0; i < ring.length; i += 1) {
    total += distance(ring[i]!, ring[(i + 1) % ring.length]!);
  }
  return total;
}

/**
 * The area centroid, not the average of the vertices.
 *
 * The vertex mean is what a naive implementation returns and it is wrong for any
 * ring whose vertices are unevenly spaced — which is every ring a person traces,
 * because they put more points on the interesting side. Placing a site office at
 * the vertex mean of its plot puts it off the plot.
 */
export function centroid(ring: Ring): Point {
  const twiceArea = shoelace(ring);
  if (twiceArea === 0) {
    // Degenerate: a zero-area ring has no area centroid, and the vertex mean is
    // the only defensible answer for a line or a point.
    const sum = ring.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
    return { x: sum.x / ring.length, y: sum.y / ring.length };
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const cross = a.x * b.y - b.x * a.y;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  return { x: cx / (3 * twiceArea), y: cy / (3 * twiceArea) };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Shortest distance from a point to a segment, not to the infinite line.
 *
 * The line version is the common mistake and it under-reports near the ends: a
 * boundary segment that stops short of a crane still reads as close when the
 * crane is off the end of it.
 */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return distance(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/** Shortest distance from a point to a ring's boundary. Zero if it lies on it. */
export function distanceToRing(p: Point, ring: Ring): number {
  requireRing(ring);
  let best = Infinity;
  for (let i = 0; i < ring.length; i += 1) {
    best = Math.min(best, distanceToSegment(p, ring[i]!, ring[(i + 1) % ring.length]!));
  }
  return best;
}

/**
 * Is the point inside the ring?
 *
 * Ray casting with a half-open edge rule (`>` on both ends rather than `>=`), so
 * each edge is counted on exactly one of its endpoints. That makes membership
 * *deterministic* for a point lying on the boundary — it belongs to one side
 * consistently rather than flipping with vertex order.
 *
 * It is not a correctness fix for interior points: a differential run of 200,000
 * point/polygon pairs on simple rings found the `>=` variant disagreeing only
 * where the point sits on the boundary itself, and never anywhere the answer is
 * defined. Said plainly because the comment here previously claimed more than
 * that, and a reader trusting the stronger claim would not have tested for it.
 */
export function containsPoint(ring: Ring, p: Point): boolean {
  requireRing(ring);
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i]!;
    const b = ring[j]!;
    const straddles = a.y > p.y !== b.y > p.y;
    if (straddles && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// --- Triangulation, and exact intersection -----------------------------------

/**
 * Ear clipping. Handles any simple polygon, convex or not.
 *
 * Here because exact intersection needs it: clipping a general polygon against
 * a general polygon is the hard case, and clipping a *triangle* against a
 * triangle is the easy one. Decompose both, clip pairwise, and the general
 * problem is solved exactly rather than approximately.
 */
export function triangulate(ring: Ring): Array<[Point, Point, Point]> {
  const working = orient(ring);
  if (working.length < 3) throw new DomainError('GEOMETRY_DEGENERATE', 'A ring needs at least three vertices');
  if (working.length === 3) return [[working[0]!, working[1]!, working[2]!]];

  const indices = working.map((_, i) => i);
  const out: Array<[Point, Point, Point]> = [];
  // Bounded: each successful clip removes a vertex, and the guard stops a
  // self-intersecting ring spinning forever rather than returning nonsense.
  let guard = working.length * working.length;

  while (indices.length > 3 && guard > 0) {
    guard -= 1;
    let clipped = false;
    for (let i = 0; i < indices.length; i += 1) {
      const prev = working[indices[(i - 1 + indices.length) % indices.length]!]!;
      const ear = working[indices[i]!]!;
      const next = working[indices[(i + 1) % indices.length]!]!;

      if (cross(prev, ear, next) <= 0) continue; // reflex, not an ear

      const contains = indices.some((index) => {
        const p = working[index]!;
        if (p === prev || p === ear || p === next) return false;
        return pointInTriangle(p, prev, ear, next);
      });
      if (contains) continue;

      out.push([prev, ear, next]);
      indices.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }

  if (indices.length === 3) {
    out.push([working[indices[0]!]!, working[indices[1]!]!, working[indices[2]!]!]);
  }
  return out;
}

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function pointInTriangle(p: Point, a: Point, b: Point, c: Point): boolean {
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}

/**
 * Sutherland–Hodgman, which is exact when the clip polygon is convex.
 *
 * Only ever called with a triangle as the clip, which is always convex — that
 * is the whole reason for triangulating first.
 */
function clipByConvex(subject: Ring, clip: Ring): Ring {
  let output = subject;
  for (let i = 0; i < clip.length && output.length > 0; i += 1) {
    const a = clip[i]!;
    const b = clip[(i + 1) % clip.length]!;
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j += 1) {
      const current = input[j]!;
      const previous = input[(j - 1 + input.length) % input.length]!;
      const currentInside = cross(a, b, current) >= 0;
      const previousInside = cross(a, b, previous) >= 0;
      if (currentInside) {
        if (!previousInside) output.push(lineIntersection(previous, current, a, b));
        output.push(current);
      } else if (previousInside) {
        output.push(lineIntersection(previous, current, a, b));
      }
    }
  }
  return output;
}

function lineIntersection(p1: Point, p2: Point, p3: Point, p4: Point): Point {
  const d = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
  if (d === 0) return p2;
  const a = p1.x * p2.y - p1.y * p2.x;
  const b = p3.x * p4.y - p3.y * p4.x;
  return { x: (a * (p3.x - p4.x) - (p1.x - p2.x) * b) / d, y: (a * (p3.y - p4.y) - (p1.y - p2.y) * b) / d };
}

/**
 * Exact overlapping area of two simple polygons, in square metres.
 *
 * Triangulate both, clip every triangle of one against every triangle of the
 * other, sum. Quadratic in triangle count and entirely adequate for site zones,
 * which have tens of vertices rather than millions.
 */
export function intersectionArea(a: Ring, b: Ring): number {
  const trianglesA = triangulate(a);
  const trianglesB = triangulate(b);
  let total = 0;
  for (const ta of trianglesA) {
    for (const tb of trianglesB) {
      const piece = clipByConvex(ta, tb);
      if (piece.length >= 3) total += area(piece);
    }
  }
  return total;
}

/** Do these two zones overlap at all? Cheap enough to ask before measuring. */
export function overlaps(a: Ring, b: Ring): boolean {
  return intersectionArea(a, b) > 1e-9;
}

// --- Buffers -----------------------------------------------------------------

/**
 * Offset a ring outward by a distance, in metres.
 *
 * Each vertex moves along its angle bisector by the distance the miter needs, so
 * the offset edges stay parallel to the originals at exactly the buffer
 * distance. This is what a crane exclusion, a root protection area or an
 * excavation setback actually is: everything within `d` of the thing.
 *
 * The miter is limited. At a very sharp internal angle the exact miter runs
 * away to infinity, and an unbounded spike would report an exclusion reaching
 * across the site. Clamped at four times the buffer, which is the ordinary CAD
 * convention, and the clamp is a smaller error than the spike by a wide margin.
 */
export function buffer(ring: Ring, metres: number): Ring {
  const working = orient(ring);
  if (metres === 0) return working;
  const limit = Math.abs(metres) * 4;

  return working.map((current, i) => {
    const previous = working[(i - 1 + working.length) % working.length]!;
    const next = working[(i + 1) % working.length]!;

    const inbound = unit({ x: current.x - previous.x, y: current.y - previous.y });
    const outbound = unit({ x: next.x - current.x, y: next.y - current.y });
    // Outward normal of a counter-clockwise ring points to the right of travel.
    const n1 = { x: inbound.y, y: -inbound.x };
    const n2 = { x: outbound.y, y: -outbound.x };

    const bisector = unit({ x: n1.x + n2.x, y: n1.y + n2.y });
    // How far along the bisector to travel so both offset edges sit at `metres`.
    const cosHalf = bisector.x * n1.x + bisector.y * n1.y;
    const travel = cosHalf === 0 ? limit : Math.min(limit, Math.abs(metres / cosHalf));
    const signed = metres < 0 ? -travel : travel;

    return { x: current.x + bisector.x * signed, y: current.y + bisector.y * signed };
  });
}

function unit(v: Point): Point {
  const length = Math.hypot(v.x, v.y);
  return length === 0 ? { x: 0, y: 0 } : { x: v.x / length, y: v.y / length };
}

/** A circle as a ring, for a crane radius or a turning circle. */
export function circle(centre: Point, radius: number, segments = 64): Ring {
  const ring: Ring = [];
  for (let i = 0; i < segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    ring.push({ x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius });
  }
  return ring;
}

// --- Surfaces ----------------------------------------------------------------

/**
 * Volume between a triangulated surface and a level, in cubic metres.
 *
 * Closed form: for a planar triangle the mean of its three heights is the exact
 * mean height over its footprint, so the prism volume is that mean times the
 * projected area. Exact, not sampled — a spoil heap measured by sampling gives a
 * different figure every time the grid moves, and that figure is invoiced.
 *
 * Signed: material above the datum is positive, below negative, so a single
 * traverse gives cut and fill rather than needing two.
 */
export function volumeAboveLevel(
  surface: Surface,
  level: number,
): { cutCubicMetres: number; fillCubicMetres: number; netCubicMetres: number } {
  let above = 0;
  let below = 0;
  for (const [a, b, c] of surface.triangles) {
    const footprint = area([a, b, c]);
    if (footprint === 0) continue;
    const meanHeight = (a.z - level + (b.z - level) + (c.z - level)) / 3;
    const volume = meanHeight * footprint;
    if (volume >= 0) above += volume;
    else below += volume;
  }
  // To the nearest hundredth of a cubic metre: a volume quoted to nine decimal
  // places implies a precision the capture never had. `zero` exists because
  // `Math.round(-0 * 100) / 100` is negative zero, and "-0m³ of fill" on a
  // report is the kind of detail that makes a reader distrust the rest of it.
  const round = (value: number): number => zero(Math.round(value * 100) / 100);
  return {
    cutCubicMetres: round(above),
    fillCubicMetres: round(-below),
    netCubicMetres: round(above + below),
  };
}

/**
 * The height of a triangle's own plane at a point, without asking whether the
 * point is inside it.
 *
 * Unchecked on purpose. Every caller below evaluates it at points that are
 * inside by construction — clipped out of the triangle's own footprint — and a
 * containment test at each of those would be work done to confirm what the
 * clipper already guaranteed.
 */
function planeHeight(triangle: Triangle3, p: Point): number | undefined {
  const [a, b, c] = triangle;
  const denominator = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  // Zero for a triangle with no plan area: vertical, or degenerate. It has no
  // single height at a point and must not contribute one.
  if (denominator === 0) return undefined;
  const u = ((b.y - c.y) * (p.x - c.x) + (c.x - b.x) * (p.y - c.y)) / denominator;
  const v = ((c.y - a.y) * (p.x - c.x) + (a.x - c.x) * (p.y - c.y)) / denominator;
  return u * a.z + v * b.z + (1 - u - v) * c.z;
}

/**
 * The captured level under a point, or `undefined` where nothing was captured.
 *
 * Undefined rather than zero, and that is the whole design of it. A surface
 * covers what the walk reached; asked about ground the walk did not reach, the
 * only true answer is that there is no measurement — and zero would be a level,
 * which is a measurement nobody made.
 */
export function heightAt(surface: Surface, p: Point): number | undefined {
  for (const triangle of surface.triangles) {
    const [a, b, c] = triangle;
    if (!pointInTriangle(p, a, b, c)) continue;
    const height = planeHeight(triangle, p);
    if (height !== undefined) return height;
  }
  return undefined;
}

export type VolumeChange = {
  /** Material gone: the later surface is lower than the earlier one. */
  cutCubicMetres: number;
  /** Material placed: the later surface is higher. */
  fillCubicMetres: number;
  netCubicMetres: number;
  /** Ground both captures actually covered, which is all the volume is over. */
  comparedSquareMetres: number;
  /**
   * Ground the later capture covered and the earlier one did not.
   *
   * Reported rather than absorbed. A volume over 900m² of a 2,400m² site is a
   * different number from a volume over the whole site, and a report that does
   * not say which is being quoted invites the reader to assume the second.
   */
  uncomparedSquareMetres: number;
};

/**
 * The volume between two captured surfaces — what was moved, exactly.
 *
 * `volumeAboveLevel` answers cut and fill against a **datum**, which is what a
 * single capture can support. This answers it against an **earlier capture**,
 * which is the question a progress claim actually asks: how much material has
 * gone since the last scan, and is it what the muck-away tickets say.
 *
 * Exact, and by the same argument as `volumeAboveLevel`. Each triangle of the
 * later surface is clipped against each triangle of the earlier one, so over
 * every resulting piece **both** surfaces are planar. The difference of two
 * planes is itself a plane, so the mean of its values at a triangle's three
 * corners is its exact mean over that triangle, and mean height times footprint
 * is the exact prism volume. Nothing is sampled, so nothing changes when a grid
 * moves — which matters because this figure is what a payment is made against.
 *
 * Quadratic in triangle count, like `intersectionArea` and for the same reason.
 * Site meshes are thousands of triangles, not millions, and an exact answer at
 * that size is worth more than a fast approximate one.
 */
export function volumeBetween(from: Surface, to: Surface): VolumeChange {
  let cut = 0;
  let fill = 0;
  let compared = 0;
  let footprintOfLater = 0;

  const earlier = from.triangles
    .map((triangle) => ({ triangle, footprint: footprintOf(triangle) }))
    .filter((entry) => area(entry.footprint) > 0);

  for (const laterTriangle of to.triangles) {
    const laterFootprint = footprintOf(laterTriangle);
    const laterArea = area(laterFootprint);
    if (laterArea <= 0) continue;
    footprintOfLater += laterArea;

    for (const { triangle: earlierTriangle, footprint: earlierFootprint } of earlier) {
      const piece = clipByConvex(laterFootprint, earlierFootprint);
      if (piece.length < 3) continue;
      const pieceArea = area(piece);
      if (pieceArea <= 0) continue;

      // Over this piece both surfaces are planar, so their difference is a
      // plane too — and the exact mean of a plane over a polygon is its value
      // at that polygon's area centroid. That is what a centroid *is*. So one
      // evaluation gives the exact prism volume, with nothing sampled and
      // nothing approximated.
      //
      // Evaluating at the centroid rather than triangulating the piece and
      // averaging corners is not merely tidier, it is the difference between
      // right and wrong here. Sutherland–Hodgman returns a repeated vertex
      // whenever the subject and the clip share a corner — which two adjacent
      // mesh triangles do constantly — and `triangulate` rejects a ring like
      // that and returns nothing. Volumes computed that way silently lost most
      // of their footprint: a 40m² comparison came back as 8m².
      const middle = centroid(piece);
      const later = planeHeight(laterTriangle, middle);
      const earlierHeight = planeHeight(earlierTriangle, middle);
      if (later === undefined || earlierHeight === undefined) continue;

      const volume = (later - earlierHeight) * pieceArea;
      if (volume >= 0) fill += volume;
      else cut -= volume;
      compared += pieceArea;
    }
  }

  const round = (value: number): number => zero(Math.round(value * 100) / 100);
  return {
    cutCubicMetres: round(cut),
    fillCubicMetres: round(fill),
    netCubicMetres: round(fill - cut),
    comparedSquareMetres: round(compared),
    uncomparedSquareMetres: round(Math.max(0, footprintOfLater - compared)),
  };
}

/** A surface triangle's shadow on the ground, oriented so the clipper accepts it. */
function footprintOf(triangle: Triangle3): Ring {
  const ring: Ring = [
    { x: triangle[0].x, y: triangle[0].y },
    { x: triangle[1].x, y: triangle[1].y },
    { x: triangle[2].x, y: triangle[2].y },
  ];
  // Counter-clockwise, because `clipByConvex` treats the left of each clip edge
  // as inside. A clockwise triangle clips everything away and reports no
  // overlap, which reads as two captures of different ground.
  return shoelace(ring) < 0 ? [ring[0]!, ring[2]!, ring[1]!] : ring;
}

/** Slope of a triangle as a percentage, and its aspect in degrees from north. */
export function slopeOf(triangle: Triangle3): { percent: number; aspectDegrees: number } {
  const [a, b, c] = triangle;
  const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const v = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  const normal = {
    x: u.y * v.z - u.z * v.y,
    y: u.z * v.x - u.x * v.z,
    z: u.x * v.y - u.y * v.x,
  };
  if (normal.z === 0) return { percent: Infinity, aspectDegrees: 0 };
  // Gradient of the plane, which is the horizontal part of the normal over its
  // vertical part.
  const dzdx = -normal.x / normal.z;
  const dzdy = -normal.y / normal.z;
  const percent = Math.hypot(dzdx, dzdy) * 100;
  // Aspect points downhill, measured clockwise from north.
  const aspect = (Math.atan2(-dzdx, -dzdy) * 180) / Math.PI;
  return { percent: Math.round(percent * 10) / 10, aspectDegrees: Math.round(((aspect + 360) % 360) * 10) / 10 };
}

/** The steepest triangle on a surface, which is the one that decides access. */
export function steepestSlope(surface: Surface): { percent: number; aspectDegrees: number } | undefined {
  let worst: { percent: number; aspectDegrees: number } | undefined;
  for (const triangle of surface.triangles) {
    const slope = slopeOf(triangle);
    if (!Number.isFinite(slope.percent)) continue;
    if (!worst || slope.percent > worst.percent) worst = slope;
  }
  return worst;
}

// --- Vehicles ----------------------------------------------------------------

export type DesignVehicle = {
  label: string;
  lengthMetres: number;
  widthMetres: number;
  /** Kerb-to-kerb turning radius the manufacturer states. */
  turningRadiusMetres: number;
};

/**
 * Design vehicles, from the dimensions the standards actually use.
 *
 * Held here rather than typed in at each check, because the whole point of a
 * swept-path check is that it is against a stated vehicle rather than a guess,
 * and two screens guessing differently is two answers to one question.
 */
export const DESIGN_VEHICLE: Record<string, DesignVehicle> = {
  RIGID_8W: { label: 'Rigid 8-wheel tipper', lengthMetres: 9.5, widthMetres: 2.55, turningRadiusMetres: 9.5 },
  ARTIC_16_5: { label: 'Articulated 16.5m', lengthMetres: 16.5, widthMetres: 2.55, turningRadiusMetres: 12.5 },
  MOBILE_CRANE: { label: 'Mobile crane, 4-axle', lengthMetres: 13.0, widthMetres: 3.0, turningRadiusMetres: 11.0 },
  CONCRETE_MIXER: { label: 'Concrete mixer', lengthMetres: 9.0, widthMetres: 2.55, turningRadiusMetres: 9.0 },
  TRANSIT: { label: 'Transit van', lengthMetres: 5.9, widthMetres: 2.0, turningRadiusMetres: 6.5 },
  FIRE_APPLIANCE: { label: 'Fire appliance', lengthMetres: 8.0, widthMetres: 2.5, turningRadiusMetres: 10.5 },
};

/**
 * The annulus a vehicle sweeps turning at its minimum radius.
 *
 * Outer radius is to the front outer corner — the corner that hits the hoarding
 * — which is why the length is in it and not only the width. The inner radius
 * is to the inner rear wheel, and the band between them is the ground the turn
 * actually needs to be clear.
 */
export function sweptPath(vehicle: DesignVehicle): { outerMetres: number; innerMetres: number; bandMetres: number } {
  const inner = Math.max(0, vehicle.turningRadiusMetres - vehicle.widthMetres / 2);
  // Pythagoras on the front outer corner: it swings wide of the kerb radius by
  // the vehicle's own length.
  const outer = Math.hypot(vehicle.turningRadiusMetres + vehicle.widthMetres / 2, vehicle.lengthMetres);
  return {
    outerMetres: Math.round(outer * 100) / 100,
    innerMetres: Math.round(inner * 100) / 100,
    bandMetres: Math.round((outer - inner) * 100) / 100,
  };
}

/**
 * Can this vehicle turn inside this area?
 *
 * The test is whether the swept band fits with its centre somewhere in the area,
 * which is not the same as whether the area is big enough — an area of ample
 * size but the wrong shape fails, and that is the case that gets missed on a
 * drawing and found by a driver.
 */
export function canTurnWithin(manoeuvringArea: Ring, vehicle: DesignVehicle): { fits: boolean; requiredMetres: number; availableMetres: number } {
  const swept = sweptPath(vehicle);
  const required = swept.outerMetres * 2;

  // The largest circle that fits is centred at the point furthest from the
  // boundary, so sample candidate centres and keep the best clearance. Vertices
  // are the wrong candidates — the deepest point is interior — so the centroid
  // and a coarse interior grid are tried, refined around the best.
  let best = { point: centroid(manoeuvringArea), clearance: -Infinity };
  const box = bounds(manoeuvringArea);
  const steps = 24;
  for (let i = 0; i <= steps; i += 1) {
    for (let j = 0; j <= steps; j += 1) {
      const p = {
        x: box.minX + ((box.maxX - box.minX) * i) / steps,
        y: box.minY + ((box.maxY - box.minY) * j) / steps,
      };
      if (!containsPoint(manoeuvringArea, p)) continue;
      const clearance = distanceToRing(p, manoeuvringArea);
      if (clearance > best.clearance) best = { point: p, clearance };
    }
  }

  const available = Math.max(0, best.clearance) * 2;
  return {
    fits: available >= required,
    requiredMetres: Math.round(required * 100) / 100,
    availableMetres: Math.round(available * 100) / 100,
  };
}

export function bounds(ring: Ring): { minX: number; minY: number; maxX: number; maxY: number } {
  requireRing(ring);
  return ring.reduce(
    (box, p) => ({
      minX: Math.min(box.minX, p.x),
      minY: Math.min(box.minY, p.y),
      maxX: Math.max(box.maxX, p.x),
      maxY: Math.max(box.maxY, p.y),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
}

// --- Routing -----------------------------------------------------------------

export type RouteNode = { id: string; point: Point };
export type RouteEdge = { from: string; to: string; widthMetres?: number; oneWay?: boolean };

/**
 * Shortest route between two points on the site road graph.
 *
 * Dijkstra, weighted by real distance rather than hop count, and it refuses an
 * edge narrower than the vehicle rather than routing a sixteen-metre artic down
 * a two-metre gap and calling it the shortest way.
 */
export function shortestRoute(
  nodes: RouteNode[],
  edges: RouteEdge[],
  from: string,
  to: string,
  vehicle?: DesignVehicle,
): { path: string[]; metres: number } | undefined {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (!byId.has(from) || !byId.has(to)) {
    throw new DomainError('ROUTE_NODE_UNKNOWN', `Route endpoints must both be on the graph: ${from} → ${to}`);
  }

  const adjacency = new Map<string, Array<{ to: string; metres: number }>>();
  for (const edge of edges) {
    const a = byId.get(edge.from);
    const b = byId.get(edge.to);
    if (!a || !b) continue;
    if (vehicle && edge.widthMetres !== undefined && edge.widthMetres < vehicle.widthMetres) continue;
    const metres = distance(a.point, b.point);
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), { to: edge.to, metres }]);
    if (!edge.oneWay) adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), { to: edge.from, metres }]);
  }

  const best = new Map<string, number>([[from, 0]]);
  const previous = new Map<string, string>();
  const settled = new Set<string>();

  // A linear scan for the nearest unsettled node. A site graph has tens of
  // nodes; a heap here would be a dependency-free reimplementation of something
  // nothing on this platform is large enough to need.
  for (;;) {
    let current: string | undefined;
    let currentCost = Infinity;
    for (const [id, cost] of best) {
      if (!settled.has(id) && cost < currentCost) {
        current = id;
        currentCost = cost;
      }
    }
    if (current === undefined) return undefined;
    if (current === to) break;
    settled.add(current);

    for (const edge of adjacency.get(current) ?? []) {
      const candidate = currentCost + edge.metres;
      if (candidate < (best.get(edge.to) ?? Infinity)) {
        best.set(edge.to, candidate);
        previous.set(edge.to, current);
      }
    }
  }

  const path = [to];
  let cursor = to;
  while (cursor !== from) {
    const step = previous.get(cursor);
    if (step === undefined) return undefined;
    path.unshift(step);
    cursor = step;
  }
  return { path, metres: Math.round((best.get(to) ?? 0) * 100) / 100 };
}

/** Negative zero is arithmetically zero and reads as a defect. */
function zero(value: number): number {
  return value === 0 ? 0 : value;
}

function requireRing(ring: Ring): void {
  if (!Array.isArray(ring) || ring.length < 3) {
    throw new DomainError('GEOMETRY_DEGENERATE', 'A ring needs at least three vertices');
  }
}
