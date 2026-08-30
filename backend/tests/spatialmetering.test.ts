import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { ACUWallet, effectiveMultiplier } from '../src/billing/acu.ts';
import { meterSpatialStage, spatialStageRawCostMinor, SPATIAL_STAGE_LABEL } from '../src/billing/spatial.ts';
import { config } from '../src/config.ts';
import * as geo from '../src/domain/geometry.ts';
import * as model from '../src/domain/sitemodel.ts';
import type { CameraPose, DepthFrame, FeatureObservation } from '../src/domain/reconstruction.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject } from '../src/seed.ts';

/**
 * Paying for the spatial stages.
 *
 * Reconstruction, segmentation and change volumes are real compute the platform
 * performs, and they were free. Free is wrong twice: commercially, and for the
 * customer, whose ACU statement is where they see what the platform did on their
 * behalf — a stage that never appears on it cannot be accounted for.
 *
 * The order is what these tests are mostly about. Reserve, then work, then
 * settle. A wallet checked *after* the compute has already spent the compute.
 */

const wallet = (balanceMinor: number): ACUWallet => {
  const w = new ACUWallet('tenant-1');
  w.topUp(balanceMinor, 'test');
  return w;
};

describe('what a stage costs', () => {
  it('charges a base plus a rate for the work actually done', () => {
    // A reconstruction of 10,000 observations: the base plus ten thousandths of
    // the per-thousand rate.
    const base = config.billing.spatialStageRawCostMinor.RECONSTRUCTION;
    const rate = config.billing.spatialRawCostMinorPerThousandPrimitives;
    assert.equal(spatialStageRawCostMinor('RECONSTRUCTION', 10_000), base + 10 * rate);
    assert.equal(spatialStageRawCostMinor('RECONSTRUCTION', 0), base);
  });

  it('costs more for a bigger site, which is the whole reason it is not a flat fee', () => {
    const small = spatialStageRawCostMinor('SEGMENTATION', 500);
    const large = spatialStageRawCostMinor('SEGMENTATION', 500_000);
    assert.ok(large > small, `${large} was not more than ${small}`);
  });

  it('never falls to zero, because a settlement of zero is refused', () => {
    // The wallet refuses to settle a hold for nothing — deliberately, since a
    // completed run cost something. A stage over three triangles would round to
    // nothing and fail at the settle rather than at the quote, which is a
    // 500 after the work rather than a refusal before it.
    assert.ok(spatialStageRawCostMinor('CHANGE_VOLUME', 0) >= 1);
    assert.ok(spatialStageRawCostMinor('CHANGE_VOLUME', -5) >= 1);
    assert.ok(spatialStageRawCostMinor('CHANGE_VOLUME', Number.NaN) >= 1);
  });

  it('names every stage for the statement line', () => {
    for (const stage of ['RECONSTRUCTION', 'SEGMENTATION', 'CHANGE_VOLUME'] as const) {
      assert.ok(SPATIAL_STAGE_LABEL[stage].length > 10, `${stage} has no label a person could read`);
    }
  });
});

describe('reserving before the work and settling after it', () => {
  it('charges the raw cost through the ordinary markup', () => {
    const w = wallet(100_000);
    const before = w.snapshot().balanceMinor;
    const metered = meterSpatialStage(w, { stage: 'SEGMENTATION', primitives: 2000 }, () => 'done');

    assert.equal(metered.result, 'done');
    const raw = spatialStageRawCostMinor('SEGMENTATION', 2000);
    // The same markup as an AI call. One price list, not two.
    assert.equal(metered.chargedMinor, Math.ceil(raw * effectiveMultiplier(0, false)));
    assert.equal(w.snapshot().balanceMinor, before - metered.chargedMinor);
    assert.equal(w.snapshot().heldMinor, 0, 'the hold outlived the settlement');
  });

  it('files the charge against the module and the stage, so a statement can explain it', () => {
    const w = wallet(100_000);
    meterSpatialStage(w, { stage: 'RECONSTRUCTION', primitives: 100, projectId: 'p1', userId: 'u1' }, () => null);
    const debit = w.entries().find((entry) => entry.type === 'DEBIT');
    assert.ok(debit);
    assert.equal(debit.module, 'SITE_CAPTURE');
    assert.equal(debit.feature, 'spatial_reconstruction');
    assert.equal(debit.projectId, 'p1');
    assert.equal(debit.provider, 'LOCAL');
  });

  it('refuses before the compute runs, not after', () => {
    // The order is the whole point. A balance checked afterwards has already
    // spent the compute, and on a large mesh that is the expensive half.
    const w = wallet(1);
    let ran = false;
    assert.throws(() =>
      meterSpatialStage(w, { stage: 'RECONSTRUCTION', primitives: 500_000 }, () => {
        ran = true;
        return null;
      }),
    );
    assert.equal(ran, false, 'the work was done before the wallet was asked');
  });

  it('charges nothing for a stage that threw', () => {
    // Nothing was produced, so nothing is owed — and the hold must not be left
    // ring-fencing credit the tenancy can never use.
    const w = wallet(100_000);
    const before = w.snapshot().balanceMinor;
    assert.throws(() =>
      meterSpatialStage(w, { stage: 'CHANGE_VOLUME', primitives: 100 }, () => {
        throw new Error('the mesh was malformed');
      }),
    );
    assert.equal(w.snapshot().balanceMinor, before, 'a failed stage was charged for');
    assert.equal(w.snapshot().heldMinor, 0, 'a failed stage left its hold in place');
  });

  it('holds and settles the same figure', () => {
    // Reading the cost twice is how the two drift: a hold larger than the
    // charge refuses work the tenancy could afford, and a smaller one
    // undercharges. Neither shows up in a test that only inspects the final
    // number, so the hold entry is compared against the debit here.
    const w = wallet(100_000);
    meterSpatialStage(w, { stage: 'SEGMENTATION', primitives: 8000 }, () => null);
    const hold = w.entries().find((entry) => entry.type === 'HOLD');
    const debit = w.entries().find((entry) => entry.type === 'DEBIT');
    assert.ok(hold && debit);
    assert.equal(hold.rawCostMinor, debit.rawCostMinor);
    assert.equal(hold.billedMinor, debit.billedMinor);
  });
});

// ── Through the domain ──────────────────────────────────────────────────────

const SITE: geo.Ring = [
  { x: 0, y: 0 },
  { x: 60, y: 0 },
  { x: 60, y: 40 },
  { x: 0, y: 40 },
];

/** A surface rising evenly across the site, as two triangles. */
const slope = (rise: number): geo.Triangle3[] => [
  [{ x: 0, y: 0, z: 0 }, { x: 60, y: 0, z: rise }, { x: 0, y: 40, z: 0 }],
  [{ x: 60, y: 0, z: rise }, { x: 60, y: 40, z: rise }, { x: 0, y: 40, z: 0 }],
];

async function site(missionId = 'MISSION-1') {
  const platform = new Platform();
  const seed = await seedDemoProject(platform);
  const ctx = () => platform.context(seed.users.constructionManager!.auth, seed.projectId, { source: 'PWA' });
  const { modelId } = model.recordBoundary(ctx(), { missionId, ring: SITE });
  return { platform, seed, ctx, modelId };
}

describe('the stages charge when they run', () => {
  it('charges for segmenting the ground', async () => {
    const s = await site();
    model.ingestSurface(s.ctx(), { modelId: s.modelId, triangles: slope(3) });
    const result = model.segmentGround(s.ctx(), s.modelId);
    assert.ok(result.chargedMinor > 0, 'segmentation was free');
    assert.ok(result.regions.length > 0);
  });

  it('refuses to segment a capture with no ground, rather than charging for nothing', async () => {
    const s = await site();
    throwsCode(() => model.segmentGround(s.ctx(), s.modelId), 'NO_SURFACE_TO_SEGMENT');
  });

  it('charges for reconstructing a surface, and records what it was solved to', async () => {
    const s = await site();
    // Two frames 6m apart, 40m up, looking straight down at four corners.
    const DOWN: CameraPose['rotation'] = [1, 0, 0, 0, 1, 0, 0, 0, -1];
    const lens = { fx: 1000, fy: 1000, cx: 640, cy: 360 };
    const poses: CameraPose[] = [
      { frameId: 'f1', position: { x: 20, y: 20, z: 40 }, rotation: DOWN, intrinsics: lens },
      { frameId: 'f2', position: { x: 26, y: 20, z: 40 }, rotation: DOWN, intrinsics: lens },
    ];
    const corners = [
      { x: 0, y: 0, z: 0 },
      { x: 40, y: 0, z: 2 },
      { x: 40, y: 30, z: 2 },
      { x: 0, y: 30, z: 0 },
    ];
    const observations: FeatureObservation[] = poses.flatMap((pose) =>
      corners.map((corner, index) => {
        const relative = { x: corner.x - pose.position.x, y: corner.y - pose.position.y, z: corner.z - pose.position.z };
        return {
          trackId: `c${index}`,
          frameId: pose.frameId,
          u: lens.cx + (lens.fx * relative.x) / -relative.z,
          v: lens.cy + (lens.fy * relative.y) / -relative.z,
        };
      }),
    );

    const result = model.reconstructSurface(s.ctx(), { modelId: s.modelId, poses, observations });
    assert.ok(result.chargedMinor > 0, 'reconstruction was free');
    assert.equal(result.points, 4);
    assert.ok(result.triangles > 0);
    assert.match(result.limitation, /not set-out/);

    // And the surface is now the model's, so everything downstream works on a
    // reconstructed capture exactly as on a LiDAR one.
    const view = model.siteModel(s.ctx(), s.modelId);
    assert.equal(view.surface?.triangles, result.triangles);
    assert.ok(model.segmentGround(s.ctx(), s.modelId).regions.length > 0);
  });
});

// ── The depth image the device measured ─────────────────────────────────────

/**
 * The third way geometry arrives, and until now the one with no way in.
 *
 * `DEVICE_DEPTH_MAP` was registered, implemented and tested, and a walkthrough
 * of the running console found no route reached it: a capability with a provider
 * and no door. These tests are through the domain function the route calls, so
 * what the register advertises and what a device can actually do are the same
 * thing.
 */
const DOWN: CameraPose['rotation'] = [1, 0, 0, 0, 1, 0, 0, 0, -1];
const LENS = { fx: 1000, fy: 1000, cx: 640, cy: 360 };

/** Camera 10m up looking straight down, so every sample lands on z = 0. */
const DEPTH_POSE: CameraPose = { frameId: 'd1', position: { x: 20, y: 20, z: 10 }, rotation: DOWN, intrinsics: LENS };

const depthImage = (samples: number[]): DepthFrame => ({ frameId: 'd1', width: 8, height: 6, samples });

describe('a surface from the depth image the device measured', () => {
  it('builds one from a single frame, which the feature-track solve refuses', async () => {
    const s = await site();
    const result = model.reconstructFromDepth(s.ctx(), {
      modelId: s.modelId,
      pose: DEPTH_POSE,
      depth: depthImage(new Array(48).fill(10)),
    });

    // Every pixel returned, so every cell of four is two triangles: 7 × 5 × 2.
    assert.equal(result.points, 48);
    assert.equal(result.triangles, 70);
    assert.equal(result.noReturnSamples, 0);
    assert.ok(result.chargedMinor > 0, 'a depth reconstruction was free');
    assert.match(result.limitation, /depth sensor rather than solved/);
    // Uniform depth from a camera pointing straight down is level ground, and
    // that is the check that the unprojection and the rotation transpose are
    // both right — get either wrong and this comes out tilted.
    assert.equal(result.steepestPercent, 0);

    // One frame. The same input through the feature-track path is refused,
    // because there depth is solved from parallax and one frame has none.
    throwsCode(
      () => model.reconstructSurface(s.ctx(), { modelId: s.modelId, poses: [DEPTH_POSE], observations: [] }),
      'RECONSTRUCTION_TOO_FEW_POSES',
    );

    // And the surface is the model's now, so everything downstream reads it.
    const view = model.siteModel(s.ctx(), s.modelId);
    assert.equal(view.surface?.triangles, 70);
    assert.ok(model.segmentGround(s.ctx(), s.modelId).regions.length > 0);
  });

  it('leaves a hole where the sensor got nothing back, rather than filling it', async () => {
    // A no-return is not a distance of zero. Interpolating across one puts
    // measured-looking ground where nothing was measured, which is the failure
    // that matters: it is indistinguishable from a good reading on a drawing.
    const s = await site();
    const samples = new Array(48).fill(10);
    samples[2 * 8 + 3] = 0; // one interior pixel, a corner of four cells
    const result = model.reconstructFromDepth(s.ctx(), { modelId: s.modelId, pose: DEPTH_POSE, depth: depthImage(samples) });

    assert.equal(result.points, 47);
    assert.equal(result.noReturnSamples, 1);
    assert.equal(result.triangles, 70 - 8, 'the four cells around a dead pixel were not dropped');
  });

  it('refuses a frame the sensor reached nothing on, rather than storing an empty surface', async () => {
    const s = await site();
    throwsCode(
      () => model.reconstructFromDepth(s.ctx(), { modelId: s.modelId, pose: DEPTH_POSE, depth: depthImage(new Array(48).fill(0)) }),
      'RECONSTRUCTION_EMPTY',
    );
    assert.equal(model.siteModel(s.ctx(), s.modelId).surface, undefined, 'a refused reconstruction still wrote a surface');
  });

  it('refuses a depth image whose pose belongs to another frame', async () => {
    // The distances are real and the position they were measured from is
    // unknown. Placing them from whatever pose was to hand puts a correct
    // surface in the wrong part of the site.
    const s = await site();
    throwsCode(
      () =>
        model.reconstructFromDepth(s.ctx(), {
          modelId: s.modelId,
          pose: { ...DEPTH_POSE, frameId: 'somewhere-else' },
          depth: depthImage(new Array(48).fill(10)),
        }),
      'RECONSTRUCTION_DEPTH_POSE_MISSING',
    );
  });

  it('charges on the samples, so a bigger depth image costs more', async () => {
    const small = await site('MISSION-SMALL');
    const cheap = model.reconstructFromDepth(small.ctx(), {
      modelId: small.modelId,
      pose: DEPTH_POSE,
      depth: depthImage(new Array(48).fill(10)),
    });
    const big = await site('MISSION-BIG');
    const dear = model.reconstructFromDepth(big.ctx(), {
      modelId: big.modelId,
      pose: DEPTH_POSE,
      depth: { frameId: 'd1', width: 256, height: 192, samples: new Array(256 * 192).fill(10) },
    });
    assert.ok(dear.chargedMinor > cheap.chargedMinor, `${dear.chargedMinor} was not more than ${cheap.chargedMinor}`);
  });
});

describe('how much earth moved between two captures', () => {
  it('measures the volume, and charges for measuring it', async () => {
    // The same 60 × 40m footprint captured twice: flat, then raised 1m
    // throughout. The later surface is 1m above the earlier over the whole
    // 2,400m² they share, so 2,400m³ of fill and nothing cut.
    const platform = new Platform();
    const seed = await seedDemoProject(platform);
    const ctx = () => platform.context(seed.users.constructionManager!.auth, seed.projectId, { source: 'PWA' });

    const first = model.recordBoundary(ctx(), { missionId: 'M1', ring: SITE }).modelId;
    model.ingestSurface(ctx(), { modelId: first, triangles: slope(0) });
    const second = model.recordBoundary(ctx(), { missionId: 'M2', ring: SITE }).modelId;
    model.ingestSurface(ctx(), {
      modelId: second,
      triangles: slope(0).map((t) => t.map((p) => ({ ...p, z: p.z + 1 })) as geo.Triangle3),
    });

    const comparison = model.compareModels(ctx(), first, second);
    assert.ok(comparison.volume, 'no volume was measured between two captures that both have surfaces');
    assert.equal(comparison.volume.fillCubicMetres, 2400);
    assert.equal(comparison.volume.cutCubicMetres, 0);
    assert.equal(comparison.volume.comparedSquareMetres, 2400);
    assert.ok((comparison.chargedMinor ?? 0) > 0, 'measuring the volume was free');
    assert.match(comparison.summary, /2400m³ in/);
    assert.match(comparison.volume.basis, /not a substitute for a measured survey/);
  });

  it('names which of the two captures is missing its surface', async () => {
    // Three different sentences, and each has to say the right thing about the
    // right capture — the reader's next action is to go and re-walk one of
    // them, and naming the wrong one sends them to the wrong site.
    const platform = new Platform();
    const seed = await seedDemoProject(platform);
    const ctx = () => platform.context(seed.users.constructionManager!.auth, seed.projectId, { source: 'PWA' });

    const withSurface = () => {
      const id = model.recordBoundary(ctx(), { missionId: `M${Math.random()}`, ring: SITE }).modelId;
      model.ingestSurface(ctx(), { modelId: id, triangles: slope(0) });
      return id;
    };
    const without = () => model.recordBoundary(ctx(), { missionId: `M${Math.random()}`, ring: SITE }).modelId;

    assert.match(model.compareModels(ctx(), without(), withSurface()).volumeAbsent ?? '', /^The earlier capture did not record/);
    assert.match(model.compareModels(ctx(), withSurface(), without()).volumeAbsent ?? '', /^The later capture did not record/);
    assert.match(model.compareModels(ctx(), without(), without()).volumeAbsent ?? '', /^Neither capture recorded/);
  });

  it('says the volume is absent rather than reporting nothing moved', async () => {
    // The failure this guards is a quiet zero. A device without depth captures
    // no surface, and "0m³ moved" on a progress claim is a statement that the
    // ground is exactly as it was — which nobody measured.
    const platform = new Platform();
    const seed = await seedDemoProject(platform);
    const ctx = () => platform.context(seed.users.constructionManager!.auth, seed.projectId, { source: 'PWA' });

    const first = model.recordBoundary(ctx(), { missionId: 'M1', ring: SITE }).modelId;
    model.ingestSurface(ctx(), { modelId: first, triangles: slope(0) });
    const second = model.recordBoundary(ctx(), { missionId: 'M2', ring: SITE }).modelId;

    const comparison = model.compareModels(ctx(), first, second);
    assert.equal(comparison.volume, undefined);
    // The whole sentence, not a fragment of it. Matching only "The later
    // capture" passed while the message read "The later capture *recorded* a
    // ground surface, so no volume can be measured" — the opposite of the
    // truth, printed to whoever asked why there was no figure.
    assert.equal(
      comparison.volumeAbsent,
      'The later capture did not record a ground surface, so no volume can be measured between them. ' +
        'This is absent rather than zero — zero would say the ground is exactly as it was.',
    );
    // Nothing was computed, so nothing was charged.
    assert.equal(comparison.chargedMinor, undefined);
    assert.doesNotMatch(comparison.summary, /m³/);
  });
});
