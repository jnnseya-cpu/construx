import type { LogisticsElement } from '../engines/sitevisit.ts';
import * as geo from './geometry.ts';

/**
 * Semantic segmentation of a captured site — what each part of the ground *is*.
 *
 * Both specifications ask the module to tell a level yard from a batter face
 * from a hollow that ponds. This does that, and it does it from the geometry
 * rather than from imagery, which is the whole reason it exists here rather
 * than behind a GPU.
 *
 * ---
 *
 * ## What it classifies, and what it cannot
 *
 * **It classifies form, not material.** A 2% plane is level ground whether it is
 * tarmac, hardcore or a wet clay field, and this module says "level ground" and
 * stops there. Telling tarmac from clay needs imagery and a trained model; that
 * is a *different* capability, it is declared on the reconstruction registry as
 * an unfilled slot, and nothing here quietly pretends to it. Every region
 * therefore carries `classifies: 'FORM'`, so a caller cannot read a bearing
 * capacity out of an answer that never looked at the ground's material.
 *
 * That distinction is the honest half of the specification's "AI spatial
 * analysis". Slope, aspect, ponding and the shape of usable ground decide most
 * of a site layout, and all four are arithmetic. What is left — surface type,
 * vegetation species, whether that dark patch is oil or shadow — is genuinely a
 * vision problem and is not claimed.
 *
 * ## How a region is found
 *
 * Every triangle is classified by its own slope, then triangles of the same
 * class that share an edge are grown into a region, and the region's outline is
 * the set of edges that belong to exactly one of its triangles. That outline is
 * a real polygon in site metres — it goes to the drawing, the DXF and the
 * viewer through the same taxonomy as everything else.
 *
 * Region growing rather than a grid: a grid would put a false edge wherever the
 * grid line fell, and the resulting "regions" would be squares of the grid
 * rather than shapes of the site.
 *
 * ## Ponding
 *
 * A hollow is not a slope class — a bowl can be gentle everywhere and still hold
 * water. So it is found separately and by the thing that defines it: a region
 * whose lowest point sits below the lowest point on its own outline has nowhere
 * for water to leave. That is a genuine test rather than a threshold on
 * steepness, and it is why standing water is reported on ground that every
 * slope rule calls good.
 */

// --- The classes -------------------------------------------------------------

/**
 * Ground form, by gradient, with the thresholds that actually govern site work.
 *
 * Not evenly spaced, because the decisions they drive are not. 1 in 12 (8.33%)
 * is the limit for a route people and plant share; 1 in 4 is roughly where
 * tracked plant stops being able to work across a face; beyond 1 in 1 it is not
 * ground anybody traverses at all.
 */
export const GROUND_FORM = {
  LEVEL: {
    label: 'Level ground',
    upToPercent: 2,
    means: 'Flat enough to stand a cabin, stack material or park on without regrading.',
    suits: ['SITE_OFFICE', 'WELFARE', 'LAYDOWN', 'STORAGE', 'PARKING', 'MUSTER_POINT'] as LogisticsElement[],
  },
  GENTLE: {
    label: 'Gently falling',
    upToPercent: 5,
    means: 'Usable as it is and it drains, which level ground does not. The best ground on most sites.',
    suits: ['LAYDOWN', 'PARKING', 'HAUL_ROAD', 'DELIVERY_HOLDING', 'PEDESTRIAN_ROUTE'] as LogisticsElement[],
  },
  WORKABLE: {
    label: 'Workable slope',
    upToPercent: 8.33,
    means: 'Within 1 in 12, so people and plant may share it. Above this they may not.',
    suits: ['HAUL_ROAD', 'PEDESTRIAN_ROUTE'] as LogisticsElement[],
  },
  STEEP: {
    label: 'Steep',
    upToPercent: 25,
    means: 'Plant only, and not across the fall. A pedestrian route here needs steps or a different line.',
    suits: ['VEGETATION'] as LogisticsElement[],
  },
  BATTER: {
    label: 'Batter or cut face',
    upToPercent: 100,
    means: 'An engineered or natural face. Nothing is sited on it and its stability is a design question.',
    suits: ['EXCLUSION_ZONE'] as LogisticsElement[],
  },
  FACE: {
    label: 'Near vertical',
    upToPercent: Number.POSITIVE_INFINITY,
    means: 'A wall, a retaining structure or an excavation side. Treated as an edge, not as ground.',
    suits: ['EXCLUSION_ZONE', 'PERMANENT_WORKS'] as LogisticsElement[],
  },
} as const;

export type GroundForm = keyof typeof GROUND_FORM;

/** The classes in the order their thresholds are tested. */
const FORM_ORDER: GroundForm[] = ['LEVEL', 'GENTLE', 'WORKABLE', 'STEEP', 'BATTER', 'FACE'];

/** Which class a gradient falls into. */
export function formOf(slopePercent: number): GroundForm {
  for (const form of FORM_ORDER) {
    if (slopePercent <= GROUND_FORM[form].upToPercent) return form;
  }
  return 'FACE';
}

// --- What comes out ----------------------------------------------------------

export type GroundRegion = {
  regionId: string;
  form: GroundForm;
  label: string;
  /**
   * Always `FORM`. On the record rather than in a comment, so a consumer of
   * this data through the API cannot read it as a statement about material.
   */
  classifies: 'FORM';
  ring: geo.Ring;
  areaSquareMetres: number;
  meanSlopePercent: number;
  maxSlopePercent: number;
  /** Downhill direction, clockwise from north. Undefined where the region is level. */
  aspectDegrees?: number;
  lowestLevelMetres: number;
  highestLevelMetres: number;
  /** Water arriving here has nowhere to leave. */
  ponds: boolean;
  /** How deep the hollow is at its worst, where it is one. */
  pondingDepthMetres?: number;
  /** Site elements this ground would take, from the one taxonomy. */
  suits: LogisticsElement[];
  triangles: number;
};

export type Segmentation = {
  regions: GroundRegion[];
  /** Total ground the capture covered, which is what every percentage is of. */
  coveredSquareMetres: number;
  /** Ground flat enough to build a compound on without regrading. */
  usableSquareMetres: number;
  pondingSquareMetres: number;
  /** What the analysis did *not* look at, said plainly. */
  notClassified: string;
  summary: string;
};

// --- Doing it ----------------------------------------------------------------

/**
 * Segment a captured surface into regions of like ground.
 *
 * Deterministic: the same mesh gives the same regions in the same order every
 * time, because triangles are visited in the order they were captured and the
 * regions are sorted by area. A segmentation that reordered itself between two
 * reads would make the change report between two captures unreadable.
 */
export function segment(surface: geo.Surface, options: { minimumRegionSquareMetres?: number } = {}): Segmentation {
  // Below this a "region" is a handful of mesh triangles, which is noise from
  // the capture rather than a feature of the site. A person cannot stand a
  // cabin on 4m² and would not want it on a drawing.
  const minimumArea = options.minimumRegionSquareMetres ?? 5;

  // Footprint first, then gradient, and the order is the guard.
  //
  // A triangle standing on its edge — the side of a wall, a trench face
  // captured square on — has infinite gradient and no plan area at all. It is
  // not ground: it occupies no square metre of the site, and a mean gradient it
  // took part in would be infinite. Dropping it on plan area covers that case
  // exactly, because infinite gradient and zero plan area are the same
  // condition: `slopeOf` returns Infinity precisely when the plane contains the
  // vertical, which is precisely when the triangle projects to a line.
  //
  // So there is no separate check for Infinity below. There is nothing for one
  // to catch.
  const faces = surface.triangles
    .map((triangle, index) => ({ index, triangle, footprint: footprintOf(triangle) }))
    .map((face) => ({ ...face, area: geo.area(face.footprint) }))
    .filter((face) => face.area > 0)
    .map((face) => {
      const slope = geo.slopeOf(face.triangle);
      return { ...face, percent: slope.percent, aspect: slope.aspectDegrees };
    });

  const neighbours = adjacency(faces);
  // Indexed rather than searched. The route accepts twenty thousand triangles,
  // and a linear scan inside the growth loop makes this quadratic — four
  // hundred million comparisons for one segmentation of a large capture.
  const byIndex = new Map(faces.map((face) => [face.index, face]));
  const seen = new Set<number>();
  const regions: GroundRegion[] = [];

  for (const face of faces) {
    if (seen.has(face.index)) continue;
    const form = formOf(face.percent);

    // Breadth-first over the mesh, taking only neighbours of the same class.
    const members: typeof faces = [];
    const queue = [face];
    seen.add(face.index);
    while (queue.length > 0) {
      const current = queue.shift()!;
      members.push(current);
      for (const neighbourIndex of neighbours.get(current.index) ?? []) {
        if (seen.has(neighbourIndex)) continue;
        const neighbour = byIndex.get(neighbourIndex);
        if (!neighbour || formOf(neighbour.percent) !== form) continue;
        seen.add(neighbourIndex);
        queue.push(neighbour);
      }
    }

    const regionArea = members.reduce((sum, member) => sum + member.area, 0);
    if (regionArea < minimumArea) continue;

    const ring = outline(members.map((member) => member.footprint));
    if (ring.length < 3) continue;

    const levels = members.flatMap((member) => member.triangle.map((point) => point.z));
    const { min: lowest, max: highest } = geo.extent(levels);
    const boundaryLowest = geo.extent(ring.map((point) => geo.heightAt(surface, point) ?? Number.POSITIVE_INFINITY)).min;

    // A hollow: the ground inside sits below every way out of it. Half of a
    // capture's vertical noise is a few centimetres, so the depth has to be
    // real before it is called ponding.
    const depth = Number.isFinite(boundaryLowest) ? boundaryLowest - lowest : 0;
    const ponds = depth > 0.05;

    // Area-weighted, so one large gentle triangle is not outvoted by twenty
    // small steep ones.
    const meanSlope = members.reduce((sum, member) => sum + member.percent * member.area, 0) / regionArea;
    const steepest = members.reduce((worst, member) => (member.percent > worst.percent ? member : worst), members[0]!);

    regions.push({
      regionId: `R${regions.length + 1}`,
      form,
      label: GROUND_FORM[form].label,
      classifies: 'FORM',
      ring,
      areaSquareMetres: round(regionArea),
      meanSlopePercent: round(meanSlope),
      maxSlopePercent: round(steepest.percent),
      // A level region has no meaningful downhill direction, and quoting one
      // would send somebody looking for a fall that is not there.
      ...(meanSlope >= 1 ? { aspectDegrees: steepest.aspect } : {}),
      lowestLevelMetres: round(lowest),
      highestLevelMetres: round(highest),
      ponds,
      ...(ponds ? { pondingDepthMetres: round(depth) } : {}),
      // Ground that ponds suits nothing until it is drained, whatever its
      // gradient says. This is the case the slope classes cannot see.
      suits: ponds ? ['STANDING_WATER'] : [...GROUND_FORM[form].suits],
      triangles: members.length,
    });
  }

  regions.sort((a, b) => b.areaSquareMetres - a.areaSquareMetres);
  regions.forEach((region, index) => {
    region.regionId = `R${index + 1}`;
  });

  const covered = faces.reduce((sum, face) => sum + face.area, 0);
  const usable = regions
    .filter((region) => !region.ponds && (region.form === 'LEVEL' || region.form === 'GENTLE'))
    .reduce((sum, region) => sum + region.areaSquareMetres, 0);
  const ponding = regions.filter((region) => region.ponds).reduce((sum, region) => sum + region.areaSquareMetres, 0);

  return {
    regions,
    coveredSquareMetres: round(covered),
    usableSquareMetres: round(usable),
    pondingSquareMetres: round(ponding),
    notClassified:
      'Surface material. This reads the shape of the ground, not what it is made of, so nothing here ' +
      'distinguishes hardstanding from soft clay and no bearing capacity may be inferred from it.',
    summary: summarise(regions, round(covered), round(usable), round(ponding)),
  };
}

function summarise(regions: GroundRegion[], covered: number, usable: number, ponding: number): string {
  if (regions.length === 0) return 'The capture covered no ground large enough to classify.';
  const parts = [`${regions.length} region(s) over ${covered}m².`];
  parts.push(
    usable > 0
      ? `${usable}m² is flat enough to build a compound on as it stands.`
      : 'No part of it is flat enough to build a compound on without regrading.',
  );
  if (ponding > 0) parts.push(`${ponding}m² has nowhere for water to leave.`);
  return parts.join(' ');
}

// --- The mesh work -----------------------------------------------------------

type Face = { index: number; footprint: geo.Ring; area: number };

/**
 * Which triangles share an edge with which.
 *
 * Keyed on the rounded endpoints, because two triangles that meet along an edge
 * hold the *same* corner twice and floating point does not always agree that
 * they do. A millimetre is finer than any capture resolves and coarser than the
 * error, which is the whole width of the window this needs.
 */
function adjacency(faces: Face[]): Map<number, number[]> {
  const byEdge = new Map<string, number[]>();
  for (const face of faces) {
    for (let i = 0; i < face.footprint.length; i += 1) {
      const key = edgeKey(face.footprint[i]!, face.footprint[(i + 1) % face.footprint.length]!);
      const bucket = byEdge.get(key);
      if (bucket) bucket.push(face.index);
      else byEdge.set(key, [face.index]);
    }
  }

  const out = new Map<number, number[]>();
  for (const shared of byEdge.values()) {
    if (shared.length < 2) continue;
    for (const one of shared) {
      for (const other of shared) {
        if (one === other) continue;
        const bucket = out.get(one);
        if (bucket) {
          if (!bucket.includes(other)) bucket.push(other);
        } else out.set(one, [other]);
      }
    }
  }
  return out;
}

/**
 * The outline of a set of triangles: every edge belonging to exactly one of
 * them, chained into a ring.
 *
 * An edge shared by two triangles is interior and drops out; what is left is
 * the boundary. Chaining then walks it, which works because a region grown by
 * shared edges is connected.
 *
 * Returns an empty ring where the boundary does not close into one loop — a
 * region with a hole in it, or one the millimetre keying failed to match up.
 * An unclosed outline drawn as a polygon is a shape that was never there, and
 * dropping the region is better than putting an invented one on a drawing.
 */
function outline(footprints: geo.Ring[]): geo.Ring {
  const count = new Map<string, { a: geo.Point; b: geo.Point; times: number }>();
  for (const footprint of footprints) {
    for (let i = 0; i < footprint.length; i += 1) {
      const a = footprint[i]!;
      const b = footprint[(i + 1) % footprint.length]!;
      const key = edgeKey(a, b);
      const entry = count.get(key);
      if (entry) entry.times += 1;
      else count.set(key, { a, b, times: 1 });
    }
  }

  const boundary = [...count.values()].filter((edge) => edge.times === 1);
  if (boundary.length < 3) return [];

  // Chain the edges end to end. Directions are not consistent between
  // triangles, so each step looks for an unused edge with *either* endpoint at
  // the current vertex.
  const used = new Set<number>();
  const ring: geo.Point[] = [boundary[0]!.a, boundary[0]!.b];
  used.add(0);

  for (let step = 1; step < boundary.length; step += 1) {
    const tail = ring[ring.length - 1]!;
    let advanced = false;
    for (let i = 0; i < boundary.length; i += 1) {
      if (used.has(i)) continue;
      const edge = boundary[i]!;
      if (samePoint(edge.a, tail)) {
        ring.push(edge.b);
        used.add(i);
        advanced = true;
        break;
      }
      if (samePoint(edge.b, tail)) {
        ring.push(edge.a);
        used.add(i);
        advanced = true;
        break;
      }
    }
    if (!advanced) return [];
  }

  // The walk returns to where it started; that closing vertex is the first one
  // repeated, and a ring here is implicitly closed.
  if (ring.length >= 2 && samePoint(ring[ring.length - 1]!, ring[0]!)) ring.pop();
  if (ring.length < 3) return [];
  return geo.orient(ring);
}

/** Undirected: the same edge from either triangle produces the same key. */
function edgeKey(a: geo.Point, b: geo.Point): string {
  const first = `${millimetre(a.x)},${millimetre(a.y)}`;
  const second = `${millimetre(b.x)},${millimetre(b.y)}`;
  return first < second ? `${first}|${second}` : `${second}|${first}`;
}

const millimetre = (value: number): number => Math.round(value * 1000);
const samePoint = (a: geo.Point, b: geo.Point): boolean =>
  millimetre(a.x) === millimetre(b.x) && millimetre(a.y) === millimetre(b.y);

function footprintOf(triangle: geo.Triangle3): geo.Ring {
  return [
    { x: triangle[0].x, y: triangle[0].y },
    { x: triangle[1].x, y: triangle[1].y },
    { x: triangle[2].x, y: triangle[2].y },
  ];
}

function round(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}
