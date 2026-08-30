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
    const available = capabilities.filter((entry) => entry.available).map((entry) => entry.capability);
    assert.deepEqual(
      available.sort(),
      ['DEVICE_DEPTH_MAP', 'MATERIAL_CLASSIFICATION', 'POSED_FEATURE_TRACKS'],
    );

    // The one that is not built is named rather than absent — the whole point
    // of publishing the register. Somebody deciding what to walk a site with
    // needs to know before the walk, not after.
    const missing = capabilities.filter((entry) => !entry.available).map((entry) => entry.capability);
    assert.deepEqual(missing, ['DENSE_STEREO']);
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

  it('keeps the two-camera minimum on the path that actually needs it', () => {
    // It is a requirement of solving depth from parallax, not of reconstruction
    // in general. Enforced on the general path it refused a depth-map job that
    // was perfectly valid with one frame.
    assert.throws(
      () => recon.reconstruct('POSED_FEATURE_TRACKS', { poses: [camera('f1', 0, 0)], observations: [] }),
      /Two camera positions are the minimum for solving depth from feature tracks/,
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

describe('depth the device measured rather than depth solved', () => {
  /**
   * A flat floor 5m below a camera looking straight down. Every pixel of a
   * depth image of it reads 5m, so the unprojected surface must come back at
   * z = 0 and cover the ground the lens saw.
   */
  const flatFloor = (width: number, height: number, metres = 5) => ({
    frameId: 'f1',
    width,
    height,
    samples: new Array(width * height).fill(metres),
  });

  it('unprojects a depth image onto the ground it measured', () => {
    // Camera 5m up, looking down, 640×360 principal point with the depth image
    // at 8×8 — which is what a device does: depth is a fraction of the colour
    // resolution, and the intrinsics scale with it.
    const pose = camera('f1', 0, 0, 5);
    const result = recon.reconstruct('DEVICE_DEPTH_MAP', {
      poses: [pose],
      observations: [],
      depth: flatFloor(8, 8),
    });

    assert.equal(result.points.length, 64);
    // Every point on the floor, not somewhere between the camera and it.
    for (const point of result.points) {
      assert.ok(Math.abs(point.point.z) < 1e-6, `a floor point came back at z = ${point.point.z}`);
    }
    // 7 × 7 cells, two triangles each.
    assert.equal(result.surface.triangles.length, 7 * 7 * 2);
  });

  it('covers the ground the lens actually saw, at the depth image’s own resolution', () => {
    // The depth image is a fraction of the colour resolution the intrinsics were
    // measured on — 8 × 8 against a 1280 × 720 frame here — so the pixel grid
    // has to be scaled onto those intrinsics before unprojecting. Skip it and
    // every point lands within a few centimetres of the principal ray: the
    // whole site collapses to a patch the size of a hand, at the right height,
    // and nothing about the surface looks wrong.
    //
    // Worked out: column c maps to u = c × 1280 ÷ 8 = 160c, so camera x is
    // (u − 640) ÷ 1000 × 5. Column 0 is −3.2m and column 7 is +2.4m — 5.6m of
    // ground. Rows map to v = 90r, giving −1.8m to +1.35m, or 3.15m.
    const result = recon.reconstruct('DEVICE_DEPTH_MAP', {
      poses: [camera('f1', 0, 0, 5)],
      observations: [],
      depth: flatFloor(8, 8),
    });

    const xs = result.points.map((p) => p.point.x);
    const ys = result.points.map((p) => p.point.y);
    assert.ok(Math.abs(Math.min(...xs) - -3.2) < 1e-6, `west edge at ${Math.min(...xs)}`);
    assert.ok(Math.abs(Math.max(...xs) - 2.4) < 1e-6, `east edge at ${Math.max(...xs)}`);
    assert.ok(Math.abs(Math.min(...ys) - -1.8) < 1e-6, `south edge at ${Math.min(...ys)}`);
    assert.ok(Math.abs(Math.max(...ys) - 1.35) < 1e-6, `north edge at ${Math.max(...ys)}`);
  });

  it('places the ground by the camera’s bearing, not mirrored about a diagonal', () => {
    // Every other camera in this file looks straight down with a *symmetric*
    // rotation, and a symmetric matrix is its own transpose — so whether the
    // code uses R or Rᵀ to take a camera-space point into the world is
    // invisible to all of them. A site unprojected the wrong way round is
    // mirrored, at the right height, with the right extent.
    //
    // Yawed 90°, the 5.6m of ground that ran east–west runs north–south.
    const yawed: recon.CameraPose = {
      frameId: 'f1',
      position: { x: 0, y: 0, z: 5 },
      rotation: [0, 1, 0, -1, 0, 0, 0, 0, -1],
      intrinsics: LENS,
    };
    const result = recon.reconstruct('DEVICE_DEPTH_MAP', {
      poses: [yawed],
      observations: [],
      depth: flatFloor(8, 8),
    });

    const xs = result.points.map((p) => p.point.x);
    const ys = result.points.map((p) => p.point.y);
    // The image's x range (5.6m) is now the world's y range, and its y range
    // (3.15m) is the world's x. Applying R instead of Rᵀ flips the signs, so
    // the edges land on the wrong side.
    assert.ok(Math.abs(Math.min(...ys) - -3.2) < 1e-6, `south edge at ${Math.min(...ys)}`);
    assert.ok(Math.abs(Math.max(...ys) - 2.4) < 1e-6, `north edge at ${Math.max(...ys)}`);
    assert.ok(Math.abs(Math.min(...xs) - -1.35) < 1e-6, `west edge at ${Math.min(...xs)}`);
    assert.ok(Math.abs(Math.max(...xs) - 1.8) < 1e-6, `east edge at ${Math.max(...xs)}`);
  });

  it('leaves a hole where the sensor got nothing back', () => {
    // A depth image has holes: dark surfaces, wet surfaces, anything beyond
    // range. Bridging one invents ground that was never measured.
    const depth = flatFloor(4, 4);
    depth.samples[5] = 0; // no return, one pixel in from the corner
    const result = recon.reconstruct('DEVICE_DEPTH_MAP', {
      poses: [camera('f1', 0, 0, 5)],
      observations: [],
      depth,
    });

    assert.equal(result.points.length, 15);
    assert.equal(result.rejected.degenerate, 1, 'the missing sample was not counted');
    // The four cells touching that pixel are gone: 3 × 3 cells, minus 4, at two
    // triangles each.
    assert.equal(result.surface.triangles.length, (9 - 4) * 2);
  });

  it('refuses a depth image with no pose for the frame that took it', () => {
    // The distances are real and the position they were measured from is
    // unknown. There is no defensible surface to build from that.
    assert.throws(
      () =>
        recon.reconstruct('DEVICE_DEPTH_MAP', {
          poses: [camera('other', 0, 0, 5), camera('another', 1, 0, 5)],
          observations: [],
          depth: flatFloor(4, 4),
        }),
      /No pose for frame f1/,
    );
  });

  it('refuses a depth image whose size and sample count disagree', () => {
    assert.throws(
      () =>
        recon.reconstruct('DEVICE_DEPTH_MAP', {
          poses: [camera('f1', 0, 0, 5), camera('f2', 1, 0, 5)],
          observations: [],
          depth: { frameId: 'f1', width: 4, height: 4, samples: new Array(12).fill(5) },
        }),
      /has 16 samples; 12 were sent/,
    );
  });

  it('states that it carries a sensor error and not a residual', () => {
    const result = recon.reconstruct('DEVICE_DEPTH_MAP', {
      poses: [camera('f1', 0, 0, 5)],
      observations: [],
      depth: flatFloor(4, 4),
    });
    assert.match(result.limitation, /Measured by the device’s depth sensor rather than solved/);
    assert.match(result.limitation, /not set-out/);
    // Zero residual is not a claim of perfection — it is the absence of a
    // reprojection, and the limitation says so rather than leaving the zero to
    // be read as accuracy.
    assert.equal(result.worstResidualPixels, 0);
  });
});

describe('a capability served somewhere else', () => {
  it('reports material classification as available, through the perception pipeline', () => {
    // It is not a reconstruction provider and never will be — it is a vision
    // task, and the platform already has a vision pipeline that charges it,
    // stamps the provenance and holds the answer as a draft somebody confirms.
    const entry = recon.reconstructionCapabilities().find((c) => c.capability === 'MATERIAL_CLASSIFICATION')!;
    assert.equal(entry.available, true);
    assert.equal(entry.provider, 'PERCEPTION_PIPELINE');
  });

  it('sends a caller asking the wrong pipeline to the right one', () => {
    assert.throws(
      () => recon.providerFor('MATERIAL_CLASSIFICATION'),
      (error: Error) => /perception pipeline/.test(error.message) && /perception route instead/.test(error.message),
    );
  });

  it('still refuses the one thing nothing serves', () => {
    // Dense stereo computed from imagery, for a device with no depth sensor at
    // all. It needs a GPU, and the register says so rather than quietly
    // redirecting to the depth-map provider, which answers a different question.
    assert.throws(
      () => recon.providerFor('DENSE_STEREO'),
      (error: Error) => /Nothing on this platform provides/.test(error.message) && /GPU/.test(error.message),
    );
    assert.equal(recon.reconstructionCapabilities().find((c) => c.capability === 'DENSE_STEREO')!.available, false);
  });
});
