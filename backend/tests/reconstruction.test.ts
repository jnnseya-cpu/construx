import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as geo from '../src/domain/geometry.ts';
import * as recon from '../src/domain/reconstruction.ts';

/**
 * Reconstruction from what an ordinary phone already knows.
 *
 * The claim is narrow and has to be tested as such: given camera poses and 2D
 * feature tracks — both of which an AR session produces without being asked —
 * the platform recovers the 3D points exactly, states the error it recovered
 * them to, and throws away anything it could not.
 *
 * The inputs below are built by projecting known points through known cameras.
 * That is not circular: projection is the forward model, and what is under test
 * is the *inverse* — a least-squares intersection of rays, which is a different
 * computation reached a different way. The first case is worked by hand anyway,
 * so at least one number here does not depend on the code being right.
 */

/** Looking straight down: camera +x is world +x, camera +z is world −z. */
const DOWN: recon.CameraPose['rotation'] = [1, 0, 0, 0, 1, 0, 0, 0, -1];
const LENS = { fx: 1000, fy: 1000, cx: 640, cy: 360 };

const camera = (frameId: string, x: number, y: number, z = 10): recon.CameraPose => ({
  frameId,
  position: { x, y, z },
  rotation: DOWN,
  intrinsics: LENS,
});

/** The forward model, so a scene can be turned into what a device would report. */
function see(pose: recon.CameraPose, trackId: string, point: { x: number; y: number; z: number }): recon.FeatureObservation {
  const relative = { x: point.x - pose.position.x, y: point.y - pose.position.y, z: point.z - pose.position.z };
  const r = pose.rotation;
  const cameraSpace = {
    x: r[0] * relative.x + r[1] * relative.y + r[2] * relative.z,
    y: r[3] * relative.x + r[4] * relative.y + r[5] * relative.z,
    z: r[6] * relative.x + r[7] * relative.y + r[8] * relative.z,
  };
  return {
    trackId,
    frameId: pose.frameId,
    u: pose.intrinsics.cx + (pose.intrinsics.fx * cameraSpace.x) / cameraSpace.z,
    v: pose.intrinsics.cy + (pose.intrinsics.fy * cameraSpace.y) / cameraSpace.z,
  };
}

describe('recovering a point from two views', () => {
  it('puts it exactly where it was, from figures worked out by hand', () => {
    // Two cameras 10m up, 4m apart, both looking straight down. The feature is
    // at the origin.
    //
    // From the first, at (0,0,10): the point is 10m below and directly under,
    // so it lands on the principal point — u = 640, v = 360.
    // From the second, at (4,0,10): the point is 4m behind in camera x and 10m
    // along camera z, so u = 640 + 1000 × (−4 ÷ 10) = 240, and v = 360.
    const a = camera('f1', 0, 0);
    const b = camera('f2', 4, 0);

    const observations: recon.FeatureObservation[] = [
      { trackId: 't1', frameId: 'f1', u: 640, v: 360 },
      { trackId: 't1', frameId: 'f2', u: 240, v: 360 },
    ];

    const result = recon.reconstruct('POSED_FEATURE_TRACKS', { poses: [a, b], observations });
    assert.equal(result.points.length, 1);
    const point = result.points[0]!;
    assert.ok(Math.abs(point.point.x) < 1e-6, `x was ${point.point.x}`);
    assert.ok(Math.abs(point.point.y) < 1e-6, `y was ${point.point.y}`);
    assert.ok(Math.abs(point.point.z) < 1e-6, `z was ${point.point.z}`);
    assert.equal(point.views, 2);
    assert.equal(point.residualPixels, 0);
  });

  it('recovers height, which is the whole reason for doing it', () => {
    // A point 3m above the ground and one on it, seen from the same two frames.
    // If the solve ignored depth these would come back at the same level.
    const a = camera('f1', 0, 0);
    const b = camera('f2', 6, 0);
    const high = { x: 2, y: 1, z: 3 };
    const low = { x: 2, y: 1, z: 0 };

    const result = recon.reconstruct('POSED_FEATURE_TRACKS', {
      poses: [a, b],
      observations: [see(a, 'high', high), see(b, 'high', high), see(a, 'low', low), see(b, 'low', low)],
    });

    const solved = new Map(result.points.map((p) => [p.trackId, p.point]));
    assert.ok(Math.abs(solved.get('high')!.z - 3) < 1e-6, `high came back at ${solved.get('high')!.z}`);
    assert.ok(Math.abs(solved.get('low')!.z - 0) < 1e-6, `low came back at ${solved.get('low')!.z}`);
  });
});

describe('cameras that are not square to the site', () => {
  it('recovers a point seen by rotated cameras', () => {
    // Every camera above looks straight down with a *symmetric* rotation
    // matrix, and a symmetric matrix is its own transpose — so the whole
    // question of whether the code uses R or Rᵀ to turn a pixel into a world
    // ray is invisible to those tests. Get it the wrong way round and a site
    // reconstructs mirrored about a diagonal.
    //
    // These two cameras are yawed 30° and 65° about the vertical, which no
    // longer commutes with anything.
    const yawed = (frameId: string, x: number, y: number, degrees: number): recon.CameraPose => {
      const t = (degrees * Math.PI) / 180;
      return {
        frameId,
        position: { x, y, z: 12 },
        // Rows are the camera's own axes expressed in world coordinates.
        rotation: [Math.cos(t), Math.sin(t), 0, -Math.sin(t), Math.cos(t), 0, 0, 0, -1],
        intrinsics: LENS,
      };
    };

    const a = yawed('f1', 0, 0, 30);
    const b = yawed('f2', 7, 2, 65);
    const target = { x: 3, y: -2, z: 1.5 };

    const result = recon.reconstruct('POSED_FEATURE_TRACKS', {
      poses: [a, b],
      observations: [see(a, 't', target), see(b, 't', target)],
    });

    assert.equal(result.points.length, 1, 'a point seen by two yawed cameras was not recovered');
    const solved = result.points[0]!.point;
    assert.ok(Math.abs(solved.x - target.x) < 1e-6, `x came back at ${solved.x}, not ${target.x}`);
    assert.ok(Math.abs(solved.y - target.y) < 1e-6, `y came back at ${solved.y}, not ${target.y}`);
    assert.ok(Math.abs(solved.z - target.z) < 1e-6, `z came back at ${solved.z}, not ${target.z}`);
  });
});

describe('what it refuses to reconstruct', () => {
  it('drops a feature only one frame ever saw', () => {
    // A single ray has no depth along it. Any point on that ray reprojects
    // perfectly, so a residual check would never catch this.
    const a = camera('f1', 0, 0);
    const b = camera('f2', 5, 0);
    const result = recon.reconstruct('POSED_FEATURE_TRACKS', {
      poses: [a, b],
      observations: [see(a, 'lonely', { x: 1, y: 1, z: 0 })],
    });
    assert.equal(result.points.length, 0);
    assert.equal(result.rejected.tooFewViews, 1);
  });

  it('drops a feature whose camera never moved', () => {
    // Two frames at the same position: two views, and no baseline between
    // them, so depth is still unrecoverable. Counting views alone would let
    // this through.
    const a = camera('f1', 0, 0);
    const b = { ...camera('f2', 0, 0), frameId: 'f2' };
    const result = recon.reconstruct('POSED_FEATURE_TRACKS', {
      poses: [a, b],
      observations: [see(a, 't', { x: 1, y: 1, z: 0 }), see(b, 't', { x: 1, y: 1, z: 0 })],
    });
    assert.equal(result.points.length, 0);
    assert.equal(result.rejected.degenerate, 1);
  });

  it('drops a track whose two sightings are not the same feature', () => {
    // The classic photogrammetry failure: the matcher paired a window corner in
    // one frame with a different window corner in the next. The rays cross
    // somewhere, so a point exists — it is simply not on anything real, and the
    // reprojection error is what gives it away.
    const a = camera('f1', 0, 0);
    const b = camera('f2', 6, 0);
    const mismatched = [see(a, 'bad', { x: 0, y: 0, z: 0 }), { ...see(b, 'bad', { x: 0, y: 0, z: 0 }), v: 360 + 90 }];

    const result = recon.reconstruct('POSED_FEATURE_TRACKS', { poses: [a, b], observations: mismatched });
    assert.equal(result.points.length, 0, 'a mismatched track produced a point');
    assert.equal(result.rejected.residualTooLarge, 1);
  });

  it('drops a point that solves behind the cameras that saw it', () => {
    // The reprojection arithmetic is symmetric about the focal point, so a
    // point *above* two downward-looking cameras reprojects onto both of them
    // perfectly — residual zero. Nothing but an explicit check on which side of
    // the lens it landed will reject it, and a site reconstructed with points
    // in the sky is a site with a surface through the sky.
    //
    // Worked out: camera A at (0,0,10) and B at (4,0,10), both looking down.
    // A point at (0,0,14) is 4m *behind* each lens. A's camera-space x is 0 so
    // it lands on the principal point, u = 640. B's camera-space x is −4 and
    // its z is −4, so u = 640 + 1000 × (−4 ÷ −4) = 1640.
    const a = camera('f1', 0, 0);
    const b = camera('f2', 4, 0);
    const result = recon.reconstruct('POSED_FEATURE_TRACKS', {
      poses: [a, b],
      observations: [
        { trackId: 'sky', frameId: 'f1', u: 640, v: 360 },
        { trackId: 'sky', frameId: 'f2', u: 1640, v: 360 },
      ],
    });

    assert.equal(result.points.length, 0, 'a point behind both cameras was accepted');
    assert.equal(result.rejected.behindCamera, 1);
    // Filed as what it is, not as a large residual — the residual was zero.
    assert.equal(result.rejected.residualTooLarge, 0);
  });

  it('refuses the whole job from a single camera position', () => {
    assert.throws(
      () => recon.reconstruct('POSED_FEATURE_TRACKS', { poses: [camera('f1', 0, 0)], observations: [] }),
      /RECONSTRUCTION_TOO_FEW_POSES|Two camera positions/,
    );
  });

  it('ignores an observation from a frame with no pose', () => {
    // A device that sent feature tracks and dropped a pose. Trusting the
    // observation would mean triangulating against a camera position of zero.
    const a = camera('f1', 0, 0);
    const b = camera('f2', 5, 0);
    const result = recon.reconstruct('POSED_FEATURE_TRACKS', {
      poses: [a, b],
      observations: [see(a, 't', { x: 0, y: 0, z: 0 }), { trackId: 't', frameId: 'ghost', u: 100, v: 100 }],
    });
    assert.equal(result.rejected.tooFewViews, 1);
  });
});

describe('the capability register', () => {
  it('says plainly which kinds of reconstruction have nothing behind them', () => {
    const capabilities = recon.reconstructionCapabilities();
    const available = capabilities.filter((entry) => entry.available);
    assert.deepEqual(available.map((entry) => entry.capability), ['POSED_FEATURE_TRACKS']);

    // The two that are not built are named rather than absent — the whole
    // point of publishing the register. Somebody deciding what to walk a site
    // with needs to know before the walk, not after.
    const missing = capabilities.filter((entry) => !entry.available).map((entry) => entry.capability);
    assert.deepEqual(missing.sort(), ['DENSE_STEREO', 'MATERIAL_CLASSIFICATION']);
    for (const entry of capabilities) {
      assert.ok(entry.needs.length > 20, `${entry.capability} does not say what it needs`);
      assert.ok(entry.gives.length > 20, `${entry.capability} does not say what it gives`);
    }
  });

  it('refuses an unserved capability rather than approximating it', () => {
    assert.throws(
      () => recon.providerFor('DENSE_STEREO'),
      (error: Error) => /Nothing on this platform provides/.test(error.message) && /stereo matching/.test(error.message),
    );
  });
});

describe('the surface through the points', () => {
  it('covers the ground the points span', () => {
    // A 3 × 3 grid over 20 × 20m. A Delaunay triangulation of it covers the
    // convex hull exactly, which here is the full 400m².
    const a = camera('f1', 10, 10, 30);
    const b = camera('f2', 16, 10, 30);
    const points: Array<{ x: number; y: number; z: number }> = [];
    for (let x = 0; x <= 20; x += 10) for (let y = 0; y <= 20; y += 10) points.push({ x, y, z: 0 });

    const observations = points.flatMap((point, index) => [
      see(a, `t${index}`, point),
      see(b, `t${index}`, point),
    ]);
    const result = recon.reconstruct('POSED_FEATURE_TRACKS', { poses: [a, b], observations });
    assert.equal(result.points.length, 9);

    const covered = result.surface.triangles.reduce(
      (sum, triangle) => sum + geo.area(triangle.map((p) => ({ x: p.x, y: p.y }))),
      0,
    );
    assert.ok(Math.abs(covered - 400) < 1e-6, `the mesh covered ${covered}m² of a 400m² hull`);
  });

  it('is actually Delaunay, not merely a tiling of the right total area', () => {
    // Checking that the triangles add up to the hull area passes for *any*
    // triangulation of those points, including one full of slivers. The
    // defining property is the empty-circumcircle one, and it is what matters
    // on a site: a long thin triangle between two distant points reports a
    // gradient that is an artefact of the meshing, and the segmentation
    // classifies ground on gradient.
    //
    // Points chosen off any common circle, so no four are cocircular and the
    // test is not deciding a tie.
    const scatter = [
      { x: 0, y: 0, z: 0 },
      { x: 17, y: 1, z: 0 },
      { x: 23, y: 14, z: 0 },
      { x: 9, y: 21, z: 0 },
      { x: 2, y: 11, z: 0 },
      { x: 11, y: 9, z: 0 },
      { x: 6, y: 4, z: 0 },
    ];
    const a = camera('f1', 10, 10, 60);
    const b = camera('f2', 18, 12, 60);
    const result = recon.reconstruct('POSED_FEATURE_TRACKS', {
      poses: [a, b],
      observations: scatter.flatMap((point, index) => [see(a, `s${index}`, point), see(b, `s${index}`, point)]),
    });
    assert.equal(result.points.length, scatter.length);

    for (const [p, q, r] of result.surface.triangles) {
      // Circumcentre from the perpendicular bisectors, then the radius.
      const d = 2 * (p.x * (q.y - r.y) + q.x * (r.y - p.y) + r.x * (p.y - q.y));
      assert.ok(Math.abs(d) > 1e-9, 'a degenerate triangle reached the mesh');
      const ux =
        ((p.x ** 2 + p.y ** 2) * (q.y - r.y) + (q.x ** 2 + q.y ** 2) * (r.y - p.y) + (r.x ** 2 + r.y ** 2) * (p.y - q.y)) / d;
      const uy =
        ((p.x ** 2 + p.y ** 2) * (r.x - q.x) + (q.x ** 2 + q.y ** 2) * (p.x - r.x) + (r.x ** 2 + r.y ** 2) * (q.x - p.x)) / d;
      const radius = Math.hypot(p.x - ux, p.y - uy);

      for (const other of scatter) {
        const corner = [p, q, r].some((v) => Math.abs(v.x - other.x) < 1e-6 && Math.abs(v.y - other.y) < 1e-6);
        if (corner) continue;
        assert.ok(
          Math.hypot(other.x - ux, other.y - uy) >= radius - 1e-6,
          `(${other.x}, ${other.y}) is inside the circumcircle of a mesh triangle, so the mesh is not Delaunay`,
        );
      }
    }
  });

  it('emits every triangle counter-clockwise, which the in-circle test relies on', () => {
    // The in-circle predicate reads the sign of a determinant, and that sign
    // flips with the winding. It is written for counter-clockwise triangles
    // only, on the argument that the mesher cannot produce any other kind —
    // so the invariant is asserted here rather than defended by a branch that
    // can never run.
    const a = camera('f1', 10, 10, 60);
    const b = camera('f2', 19, 13, 60);
    const scatter = [
      { x: 0, y: 0, z: 0 },
      { x: 17, y: 1, z: 0 },
      { x: 23, y: 14, z: 0 },
      { x: 9, y: 21, z: 0 },
      { x: 2, y: 11, z: 0 },
      { x: 11, y: 9, z: 0 },
      { x: 6, y: 4, z: 0 },
    ];
    const result = recon.reconstruct('POSED_FEATURE_TRACKS', {
      poses: [a, b],
      observations: scatter.flatMap((point, index) => [see(a, `s${index}`, point), see(b, `s${index}`, point)]),
    });
    assert.ok(result.surface.triangles.length > 0);
    for (const [p, q, r] of result.surface.triangles) {
      const winding = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
      assert.ok(winding > 0, `a clockwise triangle reached the mesh (winding ${winding})`);
    }
  });

  it('carries the heights through rather than flattening them', () => {
    // A ramp: four corners, two at 0 and two at 4. A mesh that dropped z would
    // give a level site, and every slope and volume after it would be wrong.
    const a = camera('f1', 5, 5, 40);
    const b = camera('f2', 12, 5, 40);
    const corners = [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 10, z: 0 },
      { x: 10, y: 0, z: 4 },
      { x: 10, y: 10, z: 4 },
    ];
    const result = recon.reconstruct('POSED_FEATURE_TRACKS', {
      poses: [a, b],
      observations: corners.flatMap((point, index) => [see(a, `c${index}`, point), see(b, `c${index}`, point)]),
    });

    const steepest = geo.steepestSlope(result.surface);
    // 4m over 10m is 40%.
    assert.ok(steepest && Math.abs(steepest.percent - 40) < 0.2, `the mesh sloped at ${steepest?.percent}%`);
  });

  it('produces the same answer twice, so a capture does not reshuffle between reads', () => {
    const a = camera('f1', 5, 5, 25);
    const b = camera('f2', 11, 5, 25);
    const points = [
      { x: 0, y: 0, z: 1 },
      { x: 8, y: 0, z: 0 },
      { x: 8, y: 8, z: 2 },
      { x: 0, y: 8, z: 0 },
    ];
    const job = {
      poses: [a, b],
      observations: points.flatMap((point, index) => [see(a, `p${index}`, point), see(b, `p${index}`, point)]),
    };
    assert.deepEqual(
      recon.reconstruct('POSED_FEATURE_TRACKS', job),
      recon.reconstruct('POSED_FEATURE_TRACKS', job),
    );
  });

  it('states what the result may not be used for', () => {
    const a = camera('f1', 0, 0);
    const b = camera('f2', 5, 0);
    const result = recon.reconstruct('POSED_FEATURE_TRACKS', {
      poses: [a, b],
      observations: [see(a, 't', { x: 0, y: 0, z: 0 }), see(b, 't', { x: 0, y: 0, z: 0 })],
    });
    assert.match(result.limitation, /not set-out/);
    assert.match(result.limitation, /no material classification/);
  });
});
