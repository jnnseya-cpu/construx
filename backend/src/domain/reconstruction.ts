import { DomainError } from '../core/errors.ts';
import type { Point3, Surface, Triangle3 } from './geometry.ts';

/**
 * Turning what a device recorded into geometry the platform can measure.
 *
 * The site model has always said it *receives* a mesh rather than reconstructing
 * one, and for a LiDAR handset that is exactly right: ARKit and ARCore hand over
 * a depth mesh and there is nothing to compute. But the device tier table has
 * always had a second row — `VISUAL_INERTIAL`, a camera with tracked pose and no
 * depth sensor — and for that device there was no path to geometry at all. A
 * capture on an ordinary phone produced a video and a shrug.
 *
 * This is that path, and it is a real one rather than a seam with nothing behind
 * it.
 *
 * ---
 *
 * ## Why this is arithmetic and not a GPU problem
 *
 * The hard part of photogrammetry is finding the same feature in two frames and
 * knowing where the camera was. **The handset already does both.** ARKit's
 * `ARFrame` and ARCore's `Frame` expose a tracked camera transform and a set of
 * tracked feature points, per frame, as a normal part of the AR session. What
 * arrives here is therefore not raw pixels: it is a set of camera poses and a
 * set of 2D observations grouped into tracks.
 *
 * Given those, recovering the 3D point is a least-squares problem in three
 * unknowns with a closed-form normal equation, and it is solved exactly below.
 * No optimiser, no iteration, no dependency.
 *
 * What is *not* solved here is dense stereo — a height for every pixel rather
 * than for every tracked feature. That genuinely needs a GPU and a model, it is
 * declared on the registry as a capability with no provider, and asking for it
 * gets a refusal that names what is missing rather than a coarse answer
 * presented as a fine one.
 *
 * ## Why the residual is the point
 *
 * A reconstruction with no stated error is a drawing with no scale. Every point
 * carries the reprojection residual it was solved to — the distance, in pixels,
 * between where the point projects and where the device actually saw it — and
 * the result carries the distribution. That is what decides whether the output
 * is worth anything, and it is what the accuracy class is argued from.
 *
 * Points that do not converge are **dropped, not kept with a large error**. A
 * bad point in a surface is worse than a missing one: the surface interpolates
 * through it and a volume is computed over the result.
 */

// --- What a device supplies --------------------------------------------------

/**
 * Where a camera was, and what it could see.
 *
 * `rotation` is row-major camera-from-world: it takes a point in site
 * coordinates to the camera's own frame. That is the convention both AR SDKs
 * expose once their view matrix is inverted, and stating it here is the
 * difference between a working ingest and a site reconstructed inside-out.
 */
export type CameraPose = {
  frameId: string;
  /** Camera centre, in site metres. */
  position: Point3;
  /** Row-major 3×3, camera-from-world. */
  rotation: [number, number, number, number, number, number, number, number, number];
  /** Focal lengths and principal point, in pixels. */
  intrinsics: { fx: number; fy: number; cx: number; cy: number };
};

/** One sighting of one feature in one frame. */
export type FeatureObservation = {
  trackId: string;
  frameId: string;
  /** Pixel coordinates in that frame. */
  u: number;
  v: number;
};

export type ReconstructionJob = {
  poses: CameraPose[];
  observations: FeatureObservation[];
  /**
   * How far a solved point may sit from where the device saw it before it is
   * thrown away, in pixels. Two is about the noise floor of a tracked feature
   * on a handset; anything much beyond that is a mismatched track.
   */
  maximumResidualPixels?: number;
};

// --- What comes back ---------------------------------------------------------

export type ReconstructedPoint = {
  trackId: string;
  point: Point3;
  /** How many frames saw it. Two is the minimum; more is a better-conditioned solve. */
  views: number;
  residualPixels: number;
};

export type ReconstructionResult = {
  provider: string;
  capability: ReconstructionCapability;
  points: ReconstructedPoint[];
  surface: Surface;
  /** Tracks that were offered and did not survive, and why not. */
  rejected: {
    tooFewViews: number;
    degenerate: number;
    residualTooLarge: number;
    /**
     * Solved to a position behind a camera that reported seeing it.
     *
     * Its own count rather than a large residual, because it is a different
     * failure and reads as one on a diagnostic: the rays crossed, but they
     * crossed on the wrong side of the lens. A point four metres above the
     * cameras reprojects *perfectly* onto both of them — the arithmetic is
     * symmetric about the focal point — so nothing but this check rejects it.
     */
    behindCamera: number;
  };
  meanResidualPixels: number;
  worstResidualPixels: number;
  /**
   * What this result may be used for, in the same language as the accuracy
   * classes. Carried out of the provider rather than decided by the caller,
   * because the provider is the only thing that knows how it got the answer.
   */
  limitation: string;
};

/**
 * The kinds of reconstruction there are, whether or not anything implements
 * them.
 *
 * A closed list for the same reason the event catalogue is one: a provider
 * registering an invented capability is a claim nobody checked.
 */
export const RECONSTRUCTION_CAPABILITY = {
  POSED_FEATURE_TRACKS: {
    label: 'Feature tracks with device poses',
    needs: 'Per-frame camera poses and 2D feature tracks, both of which an AR session already produces.',
    gives: 'A sparse point cloud and a surface through it, with a stated reprojection residual.',
  },
  DENSE_STEREO: {
    label: 'Dense depth from imagery',
    needs: 'The frames themselves, and hardware that can run stereo matching over them.',
    gives: 'A height for every pixel rather than for every tracked feature.',
  },
  MATERIAL_CLASSIFICATION: {
    label: 'Surface material from imagery',
    needs: 'The frames, and a model trained to tell hardstanding from clay from vegetation.',
    gives: 'What the ground is made of, which geometry alone cannot say.',
  },
} as const;

export type ReconstructionCapability = keyof typeof RECONSTRUCTION_CAPABILITY;

export type ReconstructionProvider = {
  name: string;
  capability: ReconstructionCapability;
  reconstruct: (job: ReconstructionJob) => ReconstructionResult;
};

// --- The provider that exists ------------------------------------------------

const LOCAL_TRIANGULATION: ReconstructionProvider = {
  name: 'LOCAL_MULTIVIEW',
  capability: 'POSED_FEATURE_TRACKS',
  reconstruct(job) {
    const maximumResidual = job.maximumResidualPixels ?? 2;
    const posesById = new Map(job.poses.map((pose) => [pose.frameId, pose]));

    const tracks = new Map<string, FeatureObservation[]>();
    for (const observation of job.observations) {
      if (!posesById.has(observation.frameId)) continue;
      const bucket = tracks.get(observation.trackId);
      if (bucket) bucket.push(observation);
      else tracks.set(observation.trackId, [observation]);
    }

    const points: ReconstructedPoint[] = [];
    const rejected = { tooFewViews: 0, degenerate: 0, residualTooLarge: 0, behindCamera: 0 };

    for (const [trackId, sightings] of tracks) {
      // One camera sees a ray, not a point. Depth along that ray is
      // unrecoverable from a single view, and guessing it is how a flat wall
      // becomes a hillside.
      if (sightings.length < 2) {
        rejected.tooFewViews += 1;
        continue;
      }

      const rays = sightings.map((sighting) => {
        const pose = posesById.get(sighting.frameId)!;
        return { origin: pose.position, direction: rayDirection(pose, sighting) };
      });

      const solved = closestPointToRays(rays);
      if (!solved) {
        // Every ray parallel: the camera did not actually move between the
        // frames that saw this feature, so the sightings carry no depth
        // information however many of them there are.
        rejected.degenerate += 1;
        continue;
      }

      let worst = 0;
      let behind = false;
      for (const sighting of sightings) {
        const pose = posesById.get(sighting.frameId)!;
        const projected = project(pose, solved);
        if (!projected) {
          behind = true;
          break;
        }
        worst = Math.max(worst, Math.hypot(projected.u - sighting.u, projected.v - sighting.v));
      }

      if (behind) {
        rejected.behindCamera += 1;
        continue;
      }
      if (!(worst <= maximumResidual)) {
        rejected.residualTooLarge += 1;
        continue;
      }

      points.push({
        trackId,
        point: { x: round(solved.x), y: round(solved.y), z: round(solved.z) },
        views: sightings.length,
        residualPixels: Math.round(worst * 100) / 100,
      });
    }

    // Deterministic order, so the same capture reconstructs the same way twice
    // and the mesh through the points does not reshuffle between reads.
    points.sort((a, b) => a.trackId.localeCompare(b.trackId));

    const residuals = points.map((point) => point.residualPixels);
    const surface: Surface = { triangles: meshThrough(points.map((point) => point.point)) };

    return {
      provider: LOCAL_TRIANGULATION.name,
      capability: 'POSED_FEATURE_TRACKS',
      points,
      surface,
      rejected,
      meanResidualPixels: residuals.length === 0 ? 0 : Math.round((residuals.reduce((sum, r) => sum + r, 0) / residuals.length) * 100) / 100,
      worstResidualPixels: residuals.length === 0 ? 0 : Math.max(...residuals),
      limitation:
        'Solved from tracked features, so the surface is interpolated between them and is only as dense as the ' +
        'tracking was. It carries no material classification and is measured reconnaissance at best — not set-out.',
    };
  },
};

const PROVIDERS: ReconstructionProvider[] = [LOCAL_TRIANGULATION];

/**
 * Every capability, and what serves it — including the ones nothing serves.
 *
 * Published rather than kept internal. A caller deciding whether to walk a site
 * with an ordinary phone needs to know what the platform can do with the result
 * *before* the walk, and an empty slot stated plainly is a more useful answer
 * than a capability list that only names what happens to work.
 */
export function reconstructionCapabilities(): Array<{
  capability: ReconstructionCapability;
  label: string;
  needs: string;
  gives: string;
  provider?: string;
  available: boolean;
}> {
  return (Object.keys(RECONSTRUCTION_CAPABILITY) as ReconstructionCapability[]).map((capability) => {
    const provider = PROVIDERS.find((candidate) => candidate.capability === capability);
    return {
      capability,
      ...RECONSTRUCTION_CAPABILITY[capability],
      ...(provider ? { provider: provider.name } : {}),
      available: provider !== undefined,
    };
  });
}

/**
 * The provider for a capability, or a refusal naming what is absent.
 *
 * Refusing here rather than returning a lesser answer from a provider that can
 * nearly do it: "nearly" in a reconstruction is a surface with a plausible
 * shape and no relationship to the ground, and it is indistinguishable from a
 * good one once it reaches a drawing.
 */
export function providerFor(capability: ReconstructionCapability): ReconstructionProvider {
  const provider = PROVIDERS.find((candidate) => candidate.capability === capability);
  if (!provider) {
    const entry = RECONSTRUCTION_CAPABILITY[capability];
    throw new DomainError(
      'RECONSTRUCTION_UNAVAILABLE',
      `Nothing on this platform provides ${entry.label.toLowerCase()}. It needs ${entry.needs} ` +
        'Until something does, this capture cannot produce that and nothing here will approximate it.',
      501,
    );
  }
  return provider;
}

/** Run a job through the provider for its capability. */
export function reconstruct(capability: ReconstructionCapability, job: ReconstructionJob): ReconstructionResult {
  if (job.poses.length < 2) {
    throw new DomainError(
      'RECONSTRUCTION_TOO_FEW_POSES',
      'Two camera positions are the minimum. From one the depth of everything seen is unknown, and a surface ' +
        'built from it would be invented rather than measured.',
    );
  }
  return providerFor(capability).reconstruct(job);
}

// --- The arithmetic ----------------------------------------------------------

type Vector = { x: number; y: number; z: number };

/**
 * The world-space direction the camera was looking when it saw this pixel.
 *
 * Undo the intrinsics to get a direction in the camera's own frame, then undo
 * the rotation to get it in the site's. The rotation is camera-from-world and
 * orthonormal, so its inverse is its transpose — which is why this reads as a
 * transpose rather than a matrix inversion.
 */
function rayDirection(pose: CameraPose, sighting: { u: number; v: number }): Vector {
  const { fx, fy, cx, cy } = pose.intrinsics;
  const camera: Vector = { x: (sighting.u - cx) / fx, y: (sighting.v - cy) / fy, z: 1 };
  const r = pose.rotation;
  const world: Vector = {
    x: r[0] * camera.x + r[3] * camera.y + r[6] * camera.z,
    y: r[1] * camera.x + r[4] * camera.y + r[7] * camera.z,
    z: r[2] * camera.x + r[5] * camera.y + r[8] * camera.z,
  };
  const length = Math.hypot(world.x, world.y, world.z) || 1;
  return { x: world.x / length, y: world.y / length, z: world.z / length };
}

/**
 * The point closest to a bundle of rays, in the least-squares sense.
 *
 * For a unit direction `d`, the matrix `I − ddᵀ` projects onto the plane
 * perpendicular to it, so `‖(I − ddᵀ)(X − o)‖²` is the squared distance from X
 * to that ray. Summing over the rays and setting the derivative to zero gives
 * `(Σ Aᵢ) X = Σ Aᵢoᵢ` with `Aᵢ = I − dᵢdᵢᵀ` — a 3×3 linear system with a closed
 * form. No iteration, no optimiser, and the exact minimiser rather than an
 * approach to it.
 *
 * Undefined when the system is singular, which happens when every ray is
 * parallel: the camera did not move, and no number of frames recovers depth
 * from that.
 */
function closestPointToRays(rays: Array<{ origin: Point3; direction: Vector }>): Point3 | undefined {
  const a = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const b = [0, 0, 0];

  for (const ray of rays) {
    const d = ray.direction;
    const projector = [
      1 - d.x * d.x, -d.x * d.y, -d.x * d.z,
      -d.y * d.x, 1 - d.y * d.y, -d.y * d.z,
      -d.z * d.x, -d.z * d.y, 1 - d.z * d.z,
    ];
    for (let i = 0; i < 9; i += 1) a[i]! += projector[i]!;
    const o = ray.origin;
    b[0]! += projector[0]! * o.x + projector[1]! * o.y + projector[2]! * o.z;
    b[1]! += projector[3]! * o.x + projector[4]! * o.y + projector[5]! * o.z;
    b[2]! += projector[6]! * o.x + projector[7]! * o.y + projector[8]! * o.z;
  }

  return solve3(a, b);
}

/** Cramer's rule. Three unknowns does not warrant an elimination routine. */
function solve3(m: number[], v: number[]): Point3 | undefined {
  const determinant =
    m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) -
    m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) +
    m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!);
  // Not `=== 0`: a near-singular system from cameras that barely moved gives a
  // point tens of kilometres away, which passes every later check because
  // nothing else knows how it was obtained.
  if (Math.abs(determinant) < 1e-9) return undefined;

  const replaced = (column: number): number => {
    const c = [...m];
    c[column] = v[0]!;
    c[column + 3] = v[1]!;
    c[column + 6] = v[2]!;
    return (
      c[0]! * (c[4]! * c[8]! - c[5]! * c[7]!) -
      c[1]! * (c[3]! * c[8]! - c[5]! * c[6]!) +
      c[2]! * (c[3]! * c[7]! - c[4]! * c[6]!)
    );
  };

  return { x: replaced(0) / determinant, y: replaced(1) / determinant, z: replaced(2) / determinant };
}

/** Where a world point lands on a frame, or undefined if it is behind the lens. */
function project(pose: CameraPose, point: Point3): { u: number; v: number } | undefined {
  const relative = { x: point.x - pose.position.x, y: point.y - pose.position.y, z: point.z - pose.position.z };
  const r = pose.rotation;
  const camera = {
    x: r[0] * relative.x + r[1] * relative.y + r[2] * relative.z,
    y: r[3] * relative.x + r[4] * relative.y + r[5] * relative.z,
    z: r[6] * relative.x + r[7] * relative.y + r[8] * relative.z,
  };
  if (camera.z <= 1e-9) return undefined;
  const { fx, fy, cx, cy } = pose.intrinsics;
  return { u: cx + (fx * camera.x) / camera.z, v: cy + (fy * camera.y) / camera.z };
}

// --- A surface through the points --------------------------------------------

/**
 * Delaunay in plan, heights carried through — Bowyer–Watson.
 *
 * 2.5D rather than 3D on purpose. A site surface is a height field: one level
 * per position, which is what every slope, volume and drainage answer on this
 * platform assumes. A full 3D triangulation would happily produce an overhang,
 * and nothing downstream could interpret it.
 *
 * Delaunay rather than any triangulation because it maximises the minimum
 * angle: long thin slivers between distant points produce wild slope values,
 * and slope is what the segmentation classifies on.
 */
function meshThrough(points: Point3[]): Triangle3[] {
  // Deduplicate in plan. Two points at the same position with different heights
  // is not a height field, and the circumcircle test divides by zero on
  // coincident points.
  const unique = new Map<string, Point3>();
  for (const point of points) {
    const key = `${Math.round(point.x * 1000)},${Math.round(point.y * 1000)}`;
    if (!unique.has(key)) unique.set(key, point);
  }
  const vertices = [...unique.values()];
  if (vertices.length < 3) return [];

  // A super-triangle enclosing everything, removed at the end. Sized from the
  // extent rather than from a constant, so a site in national grid coordinates
  // is enclosed as surely as one at the origin.
  const xs = vertices.map((p) => p.x);
  const ys = vertices.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY, 1) * 10;
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const superTriangle: Point3[] = [
    { x: midX - span, y: midY - span, z: 0 },
    { x: midX + span, y: midY - span, z: 0 },
    { x: midX, y: midY + span, z: 0 },
  ];

  let triangles: Point3[][] = [superTriangle];

  for (const vertex of vertices) {
    const bad: Point3[][] = [];
    const good: Point3[][] = [];
    for (const triangle of triangles) {
      if (inCircumcircle(vertex, triangle)) bad.push(triangle);
      else good.push(triangle);
    }

    // The hole the bad triangles leave: every edge belonging to exactly one of
    // them. Shared edges are interior to the hole and are not part of its
    // boundary.
    const boundary: Array<[Point3, Point3]> = [];
    for (const triangle of bad) {
      for (let i = 0; i < 3; i += 1) {
        const a = triangle[i]!;
        const b = triangle[(i + 1) % 3]!;
        const shared = bad.some(
          (other) =>
            other !== triangle &&
            [0, 1, 2].some((j) => {
              const c = other[j]!;
              const d = other[(j + 1) % 3]!;
              return (same(a, c) && same(b, d)) || (same(a, d) && same(b, c));
            }),
        );
        if (!shared) boundary.push([a, b]);
      }
    }

    triangles = good;
    for (const [a, b] of boundary) triangles.push([a, b, vertex]);
  }

  return triangles
    .filter((triangle) => !triangle.some((point) => superTriangle.some((corner) => same(point, corner))))
    .map((triangle) => [triangle[0]!, triangle[1]!, triangle[2]!] as Triangle3);
}

function inCircumcircle(p: Point3, triangle: Point3[]): boolean {
  const [a, b, c] = triangle as [Point3, Point3, Point3];
  const ax = a.x - p.x;
  const ay = a.y - p.y;
  const bx = b.x - p.x;
  const by = b.y - p.y;
  const cx = c.x - p.x;
  const cy = c.y - p.y;
  const determinant =
    (ax * ax + ay * ay) * (bx * cy - cx * by) -
    (bx * bx + by * by) * (ax * cy - cx * ay) +
    (cx * cx + cy * cy) * (ax * by - bx * ay);

  // The sign of this determinant depends on the triangle's winding, and every
  // triangle reaching here is counter-clockwise. That is an invariant of the
  // algorithm rather than a hope: the super-triangle is built counter-clockwise,
  // and each replacement is `[a, b, vertex]` where `a → b` is a hole-boundary
  // edge taken in the counter-clockwise direction it had in the triangle it came
  // from, with `vertex` inside the hole — which is counter-clockwise again. By
  // induction none is ever clockwise, and a branch handling the other case would
  // be code that cannot run, asserting a robustness it does not have. The
  // invariant is checked by a test instead, where a break in it will be seen.
  return determinant > 0;
}

const same = (a: Point3, b: Point3): boolean =>
  Math.round(a.x * 1000) === Math.round(b.x * 1000) &&
  Math.round(a.y * 1000) === Math.round(b.y * 1000) &&
  Math.round(a.z * 1000) === Math.round(b.z * 1000);

/** Millimetres. A reconstruction from a handset does not resolve finer. */
function round(value: number): number {
  const rounded = Math.round(value * 1000) / 1000;
  return rounded === 0 ? 0 : rounded;
}
