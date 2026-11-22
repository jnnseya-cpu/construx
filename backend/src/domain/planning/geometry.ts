/**
 * The red line: a site boundary as GeoJSON in EPSG:4326, checked and measured.
 *
 * **Validation.** A polygon or multipolygon; every ring closed, at least four
 * positions, finite coordinates in range; no ring crossing itself or another
 * ring; every hole inside its shell; no two parts overlapping. A boundary that
 * fails any of these is refused with the reason, never repaired silently —
 * a repaired red line is a different site.
 *
 * **Area.** On the WGS84 ellipsoid, without a GIS library. Each position is
 * taken to its *authalic* latitude, which maps the ellipsoid onto a sphere of
 * equal surface area exactly; that sphere is projected with a Lambert
 * azimuthal equal-area projection centred on the site, which preserves area
 * exactly; the planar ring area is then summed. Holes subtract; parts add. The
 * only approximation is that an edge is a straight line in the projection
 * rather than a geodesic, which at the scale of a development site is far below
 * a square metre.
 *
 * The calculated area is never the legal area. The confirmed red-line area is
 * held separately (`planning.ts`), and a material difference between them, or
 * one that straddles a rule threshold, is raised for review.
 */

type Position = [number, number];
type Ring = Position[];
type PolygonCoords = Ring[];

export type SiteGeometry = { type: 'MultiPolygon'; coordinates: PolygonCoords[] };

export class GeometryError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** The geometry from a Polygon, MultiPolygon, Feature or a FeatureCollection of exactly one such feature. */
function unwrap(input: unknown): { type: string; coordinates: unknown } {
  const value = input as { type?: string; geometry?: unknown; features?: unknown[]; coordinates?: unknown };
  if (!value || typeof value !== 'object') throw new GeometryError('The boundary is not GeoJSON.');
  if (value.type === 'Feature') return unwrap(value.geometry);
  if (value.type === 'FeatureCollection') {
    const features = Array.isArray(value.features) ? value.features : [];
    if (features.length !== 1) {
      throw new GeometryError(`A red line is one feature; this collection has ${features.length}. Merge the parts into one MultiPolygon.`);
    }
    return unwrap(features[0]);
  }
  if (value.type === 'Polygon' || value.type === 'MultiPolygon') return { type: value.type, coordinates: value.coordinates };
  throw new GeometryError(`A red line is a Polygon or MultiPolygon, not ${String(value.type ?? 'an untyped object')}.`);
}

function position(value: unknown, where: string): Position {
  if (!Array.isArray(value) || value.length < 2) throw new GeometryError(`${where}: a position is [longitude, latitude].`);
  const [lon, lat] = value as unknown[];
  if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat)) {
    throw new GeometryError(`${where}: a coordinate is not a finite number.`);
  }
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
    throw new GeometryError(`${where}: [${lon}, ${lat}] is outside longitude/latitude range — the boundary must be in EPSG:4326, not a projected grid.`);
  }
  return [lon, lat];
}

function ring(value: unknown, where: string): Ring {
  if (!Array.isArray(value)) throw new GeometryError(`${where}: a ring is a list of positions.`);
  const positions = value.map((entry, index) => position(entry, `${where}, position ${index + 1}`));
  if (positions.length < 4) throw new GeometryError(`${where}: a ring needs at least four positions, the last repeating the first.`);
  const [first, last] = [positions[0]!, positions.at(-1)!];
  if (first[0] !== last[0] || first[1] !== last[1]) throw new GeometryError(`${where}: the ring is not closed — the last position must repeat the first.`);
  const distinct = new Set(positions.slice(0, -1).map((entry) => `${entry[0]},${entry[1]}`));
  if (distinct.size < 3) throw new GeometryError(`${where}: the ring encloses no area.`);
  return positions;
}

const MAX_POSITIONS = 5000;

/** The boundary as a validated MultiPolygon, or a GeometryError naming exactly what is wrong. */
export function parseSiteGeometry(input: unknown): SiteGeometry {
  const raw = unwrap(input);
  const polygons: unknown[] = raw.type === 'Polygon' ? [raw.coordinates] : Array.isArray(raw.coordinates) ? raw.coordinates : [];
  if (polygons.length === 0) throw new GeometryError('The boundary has no polygon in it.');
  const coordinates = polygons.map((polygon, p) => {
    if (!Array.isArray(polygon) || polygon.length === 0) throw new GeometryError(`Part ${p + 1}: a polygon is a shell and any holes.`);
    return polygon.map((entry, r) => ring(entry, `Part ${p + 1}, ${r === 0 ? 'shell' : `hole ${r}`}`));
  });
  const count = coordinates.flat(2).length;
  if (count > MAX_POSITIONS) throw new GeometryError(`The boundary has ${count} positions; simplify it to ${MAX_POSITIONS} or fewer.`);
  const geometry: SiteGeometry = { type: 'MultiPolygon', coordinates };
  assertSimple(geometry);
  return geometry;
}

// --- Topology -------------------------------------------------------------------

type Segment = { a: Position; b: Position; ring: string; index: number; length: number };

const cross = (o: Position, a: Position, b: Position): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const onSegment = (p: Position, q: Position, r: Position): boolean =>
  Math.min(p[0], r[0]) <= q[0] && q[0] <= Math.max(p[0], r[0]) && Math.min(p[1], r[1]) <= q[1] && q[1] <= Math.max(p[1], r[1]);

function intersects(s: Segment, t: Segment): boolean {
  const d1 = cross(t.a, t.b, s.a);
  const d2 = cross(t.a, t.b, s.b);
  const d3 = cross(s.a, s.b, t.a);
  const d4 = cross(s.a, s.b, t.b);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (d1 === 0 && onSegment(t.a, s.a, t.b)) return true;
  if (d2 === 0 && onSegment(t.a, s.b, t.b)) return true;
  if (d3 === 0 && onSegment(s.a, t.a, s.b)) return true;
  if (d4 === 0 && onSegment(s.a, t.b, s.b)) return true;
  return false;
}

function segmentsOf(r: Ring, name: string): Segment[] {
  return r.slice(0, -1).map((a, index) => ({ a, b: r[index + 1]!, ring: name, index, length: r.length - 1 }));
}

/** Even-odd point in ring. */
function inside(point: Position, r: Ring): boolean {
  let within = false;
  for (let i = 0, j = r.length - 2; i < r.length - 1; j = i++) {
    const [xi, yi] = r[i]!;
    const [xj, yj] = r[j]!;
    if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) within = !within;
  }
  return within;
}

function assertSimple(geometry: SiteGeometry): void {
  const segments: Segment[] = [];
  geometry.coordinates.forEach((polygon, p) =>
    polygon.forEach((r, k) => segments.push(...segmentsOf(r, `Part ${p + 1}, ${k === 0 ? 'shell' : `hole ${k}`}`))),
  );
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const s = segments[i]!;
      const t = segments[j]!;
      if (s.ring === t.ring) {
        // Neighbours share a vertex by construction; that touch is not a crossing.
        const gap = Math.abs(s.index - t.index);
        if (gap === 1 || gap === s.length - 1) continue;
      }
      if (intersects(s, t)) {
        throw new GeometryError(
          s.ring === t.ring
            ? `${s.ring} crosses or touches itself (edges ${s.index + 1} and ${t.index + 1}). A red line cannot self-intersect.`
            : `${s.ring} and ${t.ring} cross or touch. Rings of a red line must not meet.`,
        );
      }
    }
  }
  geometry.coordinates.forEach((polygon, p) => {
    polygon.slice(1).forEach((hole, h) => {
      if (!inside(hole[0]!, polygon[0]!)) throw new GeometryError(`Part ${p + 1}, hole ${h + 1} lies outside its shell.`);
    });
  });
  for (let p = 0; p < geometry.coordinates.length; p++) {
    for (let q = 0; q < geometry.coordinates.length; q++) {
      const point = geometry.coordinates[q]![0]![0]!;
      const [shell, ...holes] = geometry.coordinates[p]!;
      // An island inside another part's hole is not an overlap.
      if (p !== q && inside(point, shell!) && !holes.some((hole) => inside(point, hole))) {
        throw new GeometryError(`Part ${q + 1} lies within part ${p + 1}. Parts of a red line must not overlap.`);
      }
    }
  }
}

// --- Area -----------------------------------------------------------------------

const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const E = Math.sqrt(E2);
const q = (phi: number): number => {
  const s = Math.sin(phi);
  return (1 - E2) * (s / (1 - E2 * s * s) - (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)));
};
const QP = q(Math.PI / 2);
/** The radius of the sphere with the ellipsoid's surface area. */
const RQ = A * Math.sqrt(QP / 2);
const authalic = (phi: number): number => Math.asin(Math.max(-1, Math.min(1, q(phi) / QP)));
const RAD = Math.PI / 180;

/** Geodetic area of the red line in square metres, holes subtracted. */
export function geodeticAreaM2(geometry: SiteGeometry): number {
  const all = geometry.coordinates.flat(2);
  const lon0 = (all.reduce((sum, p) => sum + p[0], 0) / all.length) * RAD;
  const beta0 = authalic((all.reduce((sum, p) => sum + p[1], 0) / all.length) * RAD);
  const project = ([lon, lat]: Position): [number, number] => {
    const beta = authalic(lat * RAD);
    const dl = lon * RAD - lon0;
    const k = Math.sqrt(2 / (1 + Math.sin(beta0) * Math.sin(beta) + Math.cos(beta0) * Math.cos(beta) * Math.cos(dl)));
    return [RQ * k * Math.cos(beta) * Math.sin(dl), RQ * k * (Math.cos(beta0) * Math.sin(beta) - Math.sin(beta0) * Math.cos(beta) * Math.cos(dl))];
  };
  const planar = (r: Ring): number => {
    const points = r.map(project);
    let twice = 0;
    for (let i = 0; i < points.length - 1; i++) twice += points[i]![0] * points[i + 1]![1] - points[i + 1]![0] * points[i]![1];
    return Math.abs(twice) / 2;
  };
  const area = geometry.coordinates.reduce(
    (sum, polygon) => sum + planar(polygon[0]!) - polygon.slice(1).reduce((holes, hole) => holes + planar(hole), 0),
    0,
  );
  return Math.round(area * 100) / 100;
}

/** The thresholds a material area difference is measured against, in m². */
export const AREA_THRESHOLDS_M2 = [5_000, 10_000, 25_000, 50_000] as const;

/**
 * Whether the calculated and the confirmed area differ enough to review: by
 * more than 2% of the confirmed area, or by falling either side of a rule
 * threshold (0.5, 1, 2.5 or 5 ha), where the difference changes an outcome.
 */
export function areaDivergence(calculatedM2: number, confirmedM2: number | null): { material: boolean; reasons: string[] } {
  if (confirmedM2 === null) return { material: false, reasons: [] };
  const reasons: string[] = [];
  const difference = Math.abs(calculatedM2 - confirmedM2);
  if (difference > confirmedM2 * 0.02) {
    reasons.push(`The drawn boundary measures ${calculatedM2.toFixed(2)} m², ${((difference / confirmedM2) * 100).toFixed(1)}% from the confirmed ${confirmedM2.toFixed(2)} m².`);
  }
  for (const threshold of AREA_THRESHOLDS_M2) {
    if (calculatedM2 >= threshold !== confirmedM2 >= threshold) {
      reasons.push(`The drawn and confirmed areas fall either side of ${threshold / 10_000} ha, a threshold a rule turns on.`);
    }
  }
  return { material: reasons.length > 0, reasons };
}
