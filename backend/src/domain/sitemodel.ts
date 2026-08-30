import { meterSpatialStage } from '../billing/spatial.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import { LOGISTICS_ELEMENT, type LogisticsElement } from '../engines/sitevisit.ts';
import * as geo from './geometry.ts';
import * as recon from './reconstruction.ts';
import * as segmentation from './segmentation.ts';

/**
 * The site as geometry, and what the geometry says is wrong with it.
 *
 * `sitevisit.ts` records logistics elements, their stated dimensions and the
 * checks arithmetic can settle, and says in as many words that it will not draw
 * a plan without the geometry behind it. `sitecapture.ts` runs the walk that
 * produces the geometry. This is the record in between: zones with real
 * polygons, measured rather than described, and every conflict between them
 * found by computation rather than by somebody noticing.
 *
 * ---
 *
 * ## Where the geometry comes from
 *
 * The device, in two different ways depending on what the device is.
 *
 * A handset with depth produces a mesh on its own, and `ingestSurface` simply
 * receives it. A handset without depth produces tracked poses and feature
 * points instead, and `reconstructSurface` solves the geometry from those —
 * exactly, by least squares, in `reconstruction.ts`. Either way a survey
 * arrives as a boundary ring, a triangulated surface and the zones a person
 * traced or an extraction proposed.
 *
 * What is *not* done anywhere is dense reconstruction from raw pixels. That is
 * declared on the reconstruction registry as a capability with no provider, and
 * asked for it the platform refuses rather than approximating. This is the whole
 * reason the module is buildable without a GPU, and it is what both
 * specifications actually describe once the pipeline diagrams are set aside.
 *
 * Coordinates are **projected metres on a local site grid**. The georeferencing
 * — which grid, and what it was registered against — lives on the capture
 * mission and governs what may be claimed. Nothing here re-asks that question,
 * and nothing here upgrades the answer.
 *
 * ## What it refuses
 *
 * **A zone outside the site is refused, not clipped.** A laydown drawn partly
 * over the neighbour is either a boundary that is wrong or a laydown that is
 * wrong, and silently trimming it to fit picks one without telling anybody.
 *
 * **Findings are computed every time, never stored.** An overlap is a fact
 * about the current zones; storing it would let a plan be edited into
 * correctness on paper while the stored finding still said otherwise, or the
 * reverse. The ledger holds the zones. The conflicts are derived.
 */

// --- The record --------------------------------------------------------------

/** Whether a zone was seen on the walk or drawn as a proposal. */
export type ZoneSource = 'OBSERVED' | 'PLANNED';

export type SiteZone = {
  zoneId: string;
  code: LogisticsElement;
  /** "Laydown A", "Gate 2". The code never changes; this does. */
  instanceName: string;
  ring: geo.Ring;
  source: ZoneSource;
  /** Free attributes the taxonomy allows — surface, capacity, reason. */
  attrs?: Record<string, string | number | boolean>;
  placedBy: string;
  placedAt: string;
};

type ModelState = {
  id: string;
  missionId: string;
  boundary?: geo.Ring;
  surface?: geo.Surface;
  /**
   * Present only where the surface was solved rather than received.
   *
   * A LiDAR mesh arrives already measured and this is absent; a reconstructed
   * one carries the error it was solved to. Keeping the two distinguishable on
   * the record is the point — "how good is this surface" must be answerable
   * later from the ledger rather than from whoever ran it.
   */
  reconstruction?: {
    provider: string;
    capability: recon.ReconstructionCapability;
    points: number;
    meanResidualPixels: number;
    worstResidualPixels: number;
    rejected: recon.ReconstructionResult['rejected'];
    limitation: string;
  };
  zones: SiteZone[];
  createdBy: string;
  createdAt: string;
};

/**
 * Zones that may not overlap anything, because overlapping them is the hazard.
 *
 * An exclusion zone with a laydown inside it is not a drafting untidiness, it is
 * material stored where nobody may go. A crane position overlapping a muster
 * point is an evacuation route under a load. These are checked against every
 * other zone rather than against a list of pairs, because the list of pairs is
 * where somebody forgets one.
 */
const KEEP_CLEAR: LogisticsElement[] = ['EXCLUSION_ZONE', 'CRANE_POSITION', 'EXISTING_SERVICES', 'MUSTER_POINT', 'FIRE_POINT'];

/** Zones that may legitimately sit inside another. A gate is in the hoarding line. */
const MAY_NEST: LogisticsElement[] = ['GATE', 'FIRE_POINT', 'MUSTER_POINT', 'WHEEL_WASH', 'TEMPORARY_SUPPLY'];

/** Ground nothing should be built on without a decision. */
const UNSUITABLE_GROUND: LogisticsElement[] = ['STANDING_WATER', 'EXCAVATION', 'SPOIL_HEAP', 'VEGETATION'];

/** What has to be somewhere on a site before the layout is a layout. */
const REQUIRED_FOR_A_COMPLETE_SITE: Array<{ code: LogisticsElement; why: string }> = [
  { code: 'GATE', why: 'Nothing reaches the site without one, and the whole traffic plan hangs off where it is.' },
  { code: 'WELFARE', why: 'A site without welfare is not a site anybody may work on.' },
  { code: 'MUSTER_POINT', why: 'An evacuation with nowhere to go is an evacuation into the traffic route.' },
  { code: 'PEDESTRIAN_ROUTE', why: 'Without one, people walk in the haul road, which is how they are killed.' },
];

// --- Recording ---------------------------------------------------------------

/**
 * Open the geometric record for a capture, with the boundary that bounds it.
 *
 * The boundary comes first and separately because everything else is measured
 * against it: containment, oversail, the buildable area. A model with zones and
 * no boundary can be drawn and cannot be checked.
 */
export function recordBoundary(
  ctx: EngineContext,
  input: { missionId: string; ring: geo.Ring },
): { modelId: string; areaSquareMetres: number; perimeterMetres: number } {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'C');

  if (input.ring.length < 3) {
    throw new DomainError('BOUNDARY_DEGENERATE', 'A site boundary needs at least three corners');
  }
  const existing = ctx.ledger.list(ctx.projectId, 'SiteModel').find((record) => record.state.missionId === input.missionId);
  if (existing) {
    throw new DomainError(
      'SITE_MODEL_EXISTS',
      'This capture already has a geometric record. A second boundary for one walk is two answers to where the site ends.',
    );
  }

  const boundary = geo.orient(input.ring);
  const modelId = ulid();
  write(ctx, {
    eventType: 'SITE_MODEL_RECORDED',
    entity: { refType: 'SiteModel', refId: modelId },
    nextState: {
      id: modelId,
      missionId: input.missionId,
      boundary,
      zones: [],
      createdBy: ctx.auth.actorId,
      createdAt: new Date().toISOString(),
    } satisfies ModelState,
  });

  return {
    modelId,
    areaSquareMetres: round(geo.area(boundary)),
    perimeterMetres: round(geo.perimeter(boundary)),
  };
}

/**
 * Take the triangulated surface the device produced.
 *
 * Not reconstructed here — received. A handset with depth returns a mesh, and
 * this stores it so slope and volume can be computed from it. A capture with no
 * depth simply never calls this, and every answer that needs a surface then
 * says it has none rather than estimating one.
 */
export function ingestSurface(
  ctx: EngineContext,
  input: { modelId: string; triangles: geo.Triangle3[] },
): { triangles: number; steepestPercent?: number } {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'U');

  const record = requireModel(ctx, input.modelId);
  if (input.triangles.length === 0) {
    throw new DomainError('SURFACE_EMPTY', 'A surface with no triangles is not a surface');
  }

  const surface: geo.Surface = { triangles: input.triangles };
  write(ctx, {
    eventType: 'SITE_SURFACE_INGESTED',
    entity: { refType: 'SiteModel', refId: input.modelId },
    nextState: { ...record.state, surface },
  });

  return { triangles: input.triangles.length, steepestPercent: geo.steepestSlope(surface)?.percent };
}

/**
 * Reconstruct a surface from what a device without depth recorded, and store it.
 *
 * The path for the `VISUAL_INERTIAL` tier, which until now had none: an ordinary
 * phone tracks its own pose and its own feature points, and those are enough to
 * recover geometry exactly. `reconstruction.ts` does the arithmetic; this puts
 * the answer where `ingestSurface` puts a LiDAR mesh, so everything downstream —
 * slope, volume, segmentation, the viewer — works identically whichever kind of
 * device walked the site.
 *
 * Charged, because it is real compute. Reserved before the solve and settled
 * after, so a tenancy with an empty wallet is refused before the work rather
 * than after it.
 *
 * The residuals are stored beside the mesh rather than discarded. A
 * reconstruction with no stated error is a drawing with no scale, and the
 * question "how good is this surface" has to be answerable later from the
 * record rather than from whoever happened to run it.
 */
export function reconstructSurface(
  ctx: EngineContext,
  input: { modelId: string; poses: recon.CameraPose[]; observations: recon.FeatureObservation[] },
): {
  triangles: number;
  points: number;
  meanResidualPixels: number;
  worstResidualPixels: number;
  rejected: recon.ReconstructionResult['rejected'];
  limitation: string;
  steepestPercent?: number;
  chargedMinor: number;
} {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'U');
  const record = requireModel(ctx, input.modelId);

  const metered = meterSpatialStage(
    ctx.wallet,
    {
      stage: 'RECONSTRUCTION',
      // The observations are the work: every one contributes a ray to a solve.
      primitives: input.observations.length,
      projectId: ctx.projectId,
      userId: ctx.auth.actorId,
    },
    () => recon.reconstruct('POSED_FEATURE_TRACKS', { poses: input.poses, observations: input.observations }),
  );
  const result = metered.result;

  if (result.surface.triangles.length === 0) {
    throw new DomainError(
      'RECONSTRUCTION_EMPTY',
      `Nothing survived the solve: ${result.rejected.tooFewViews} feature(s) seen in only one frame, ` +
        `${result.rejected.degenerate} with no baseline between the frames that saw them, ` +
        `${result.rejected.behindCamera} solving behind a camera, and ` +
        `${result.rejected.residualTooLarge} that did not reproject. Walk the site again taking a wider path — ` +
        'the camera has to move between frames for depth to be recoverable at all.',
    );
  }

  write(ctx, {
    eventType: 'SITE_SURFACE_RECONSTRUCTED',
    entity: { refType: 'SiteModel', refId: input.modelId },
    reason: `${result.points.length} point(s) from ${input.poses.length} frame(s), worst residual ${result.worstResidualPixels}px`,
    nextState: {
      ...record.state,
      surface: result.surface,
      reconstruction: {
        provider: result.provider,
        capability: result.capability,
        points: result.points.length,
        meanResidualPixels: result.meanResidualPixels,
        worstResidualPixels: result.worstResidualPixels,
        rejected: result.rejected,
        limitation: result.limitation,
      },
    },
  });

  return {
    triangles: result.surface.triangles.length,
    points: result.points.length,
    meanResidualPixels: result.meanResidualPixels,
    worstResidualPixels: result.worstResidualPixels,
    rejected: result.rejected,
    limitation: result.limitation,
    steepestPercent: geo.steepestSlope(result.surface)?.percent,
    chargedMinor: metered.chargedMinor,
  };
}

/**
 * Build a surface from a depth image the device measured, and store it.
 *
 * The third way geometry arrives, and the one the capability register said this
 * platform could do while nothing could reach it. A handset with a depth sensor
 * that hands over its *mesh* uses `ingestSurface`; one that hands over the raw
 * depth image — which is what ARKit's `sceneDepth` and the ARCore Depth API
 * actually expose — had nowhere to send it, and the pixels were being thrown
 * away in favour of the sparse feature-track solve on the same walk.
 *
 * One frame is enough, because the distances were measured and not solved. That
 * is the whole difference from `reconstructSurface`, and it is why this is a
 * separate entry point rather than an optional field on that one: the refusal
 * that protects a feature-track job — two frames minimum, or the depth of
 * everything is unknown — would be wrong here, and relaxing it there would have
 * made a one-frame photogrammetry job silently succeed at inventing a site.
 *
 * Charged on the samples, which are the work: every returning pixel is
 * unprojected and every complete cell of four becomes two triangles.
 */
export function reconstructFromDepth(
  ctx: EngineContext,
  input: { modelId: string; pose: recon.CameraPose; depth: recon.DepthFrame },
): {
  triangles: number;
  points: number;
  noReturnSamples: number;
  limitation: string;
  steepestPercent?: number;
  chargedMinor: number;
} {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'U');
  const record = requireModel(ctx, input.modelId);

  const metered = meterSpatialStage(
    ctx.wallet,
    {
      stage: 'RECONSTRUCTION',
      primitives: input.depth.samples.length,
      projectId: ctx.projectId,
      userId: ctx.auth.actorId,
    },
    () => recon.reconstruct('DEVICE_DEPTH_MAP', { poses: [input.pose], observations: [], depth: input.depth }),
  );
  const result = metered.result;

  if (result.surface.triangles.length === 0) {
    throw new DomainError(
      'RECONSTRUCTION_EMPTY',
      `Nothing survived: ${result.rejected.degenerate} of ${input.depth.samples.length} samples were no-return, and ` +
        'no group of four neighbouring pixels all came back. The sensor reached nothing at this range — it is ' +
        'defeated by daylight, by distance, and by dark or wet surfaces. Move closer and capture again.',
    );
  }

  write(ctx, {
    eventType: 'SITE_SURFACE_RECONSTRUCTED',
    entity: { refType: 'SiteModel', refId: input.modelId },
    reason: `${result.surface.triangles.length} triangle(s) from a ${input.depth.width} × ${input.depth.height} depth image on frame ${input.depth.frameId}`,
    nextState: {
      ...record.state,
      surface: result.surface,
      reconstruction: {
        provider: result.provider,
        capability: result.capability,
        points: result.points.length,
        meanResidualPixels: result.meanResidualPixels,
        worstResidualPixels: result.worstResidualPixels,
        rejected: result.rejected,
        limitation: result.limitation,
      },
    },
  });

  return {
    triangles: result.surface.triangles.length,
    points: result.points.length,
    // Named for what it is. On this path `rejected.degenerate` counts pixels the
    // sensor got nothing back from, which is not the degeneracy the feature-track
    // solve means by the word, and a caller reading it as one would be misled.
    noReturnSamples: result.rejected.degenerate,
    limitation: result.limitation,
    steepestPercent: geo.steepestSlope(result.surface)?.percent,
    chargedMinor: metered.chargedMinor,
  };
}

/**
 * Segment the captured ground into regions of like form.
 *
 * Derived on every read rather than stored, for the same reason the findings
 * are: a segmentation is a fact about the current surface, and a stored one
 * would go on saying a hollow is there after a recapture filled it.
 *
 * Charged on the triangles it actually processed.
 */
export function segmentGround(
  ctx: EngineContext,
  modelId: string,
): segmentation.Segmentation & { chargedMinor: number } {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'R');
  const record = requireModel(ctx, modelId);
  const surface = record.state.surface;
  if (!surface) {
    throw new DomainError(
      'NO_SURFACE_TO_SEGMENT',
      'This capture has no ground surface, so there is nothing to classify. A device with depth produces one on ' +
        'the walk; one without can have its frames reconstructed instead.',
      409,
    );
  }

  const metered = meterSpatialStage(
    ctx.wallet,
    { stage: 'SEGMENTATION', primitives: surface.triangles.length, projectId: ctx.projectId, userId: ctx.auth.actorId },
    () => segmentation.segment(surface),
  );
  return { ...metered.result, chargedMinor: metered.chargedMinor };
}

/**
 * Put a zone on the site, with the ground it actually occupies.
 *
 * Refused if it leaves the boundary. That is the check the whole record exists
 * for: a compound half on the neighbour's land is the single most expensive
 * thing a site layout gets wrong, and it is invisible on a sketch.
 */
export function placeZone(
  ctx: EngineContext,
  input: {
    modelId: string;
    code: LogisticsElement;
    instanceName: string;
    ring: geo.Ring;
    source: ZoneSource;
    attrs?: Record<string, string | number | boolean>;
  },
): { zoneId: string; areaSquareMetres: number } {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'C');

  const record = requireModel(ctx, input.modelId);
  if (!LOGISTICS_ELEMENT.includes(input.code)) {
    throw new DomainError('ZONE_CODE_UNKNOWN', `${input.code} is not in the site element catalogue`);
  }
  if (input.ring.length < 3) throw new DomainError('ZONE_DEGENERATE', 'A zone needs at least three corners');
  if (input.instanceName.trim() === '') {
    throw new DomainError('ZONE_NAME_REQUIRED', 'A zone needs a name somebody can say on the radio');
  }

  const ring = geo.orient(input.ring);
  const boundary = record.state.boundary;
  if (boundary) {
    const inside = geo.intersectionArea(ring, boundary);
    const zoneArea = geo.area(ring);
    // A millimetre of tolerance against floating point, not a licence to stray.
    if (zoneArea - inside > 1e-3) {
      throw new DomainError(
        'ZONE_OUTSIDE_BOUNDARY',
        `${input.instanceName} puts ${round(zoneArea - inside)}m² of ${round(zoneArea)}m² outside the site boundary. ` +
          'Either the boundary is wrong or the zone is, and trimming it to fit would decide which without telling anybody.',
      );
    }
  }

  const zoneId = ulid();
  const zone: SiteZone = {
    zoneId,
    code: input.code,
    instanceName: input.instanceName.trim(),
    ring,
    source: input.source,
    ...(input.attrs ? { attrs: input.attrs } : {}),
    placedBy: ctx.auth.actorId,
    placedAt: new Date().toISOString(),
  };

  write(ctx, {
    eventType: 'SITE_ZONE_PLACED',
    entity: { refType: 'SiteModel', refId: input.modelId },
    reason: `${input.code}: ${zone.instanceName}`,
    nextState: { ...record.state, zones: [...record.state.zones, zone] },
  });

  return { zoneId, areaSquareMetres: round(geo.area(ring)) };
}

// --- Reading -----------------------------------------------------------------

export type ZoneMeasurement = {
  zoneId: string;
  code: LogisticsElement;
  instanceName: string;
  source: ZoneSource;
  /**
   * The ground itself, in site metres.
   *
   * Carried on the measurement rather than left on the record, because
   * everything that draws the site — the plan sheet, the DXF, the viewer —
   * needs the shape and the figures together, and fetching them from two places
   * is how a drawing and its schedule come to disagree.
   */
  ring: geo.Ring;
  areaSquareMetres: number;
  perimeterMetres: number;
  /** A point guaranteed to be inside the zone, for a label or a placement. */
  labelPoint: geo.Point;
};

export type SiteFindingKind =
  | 'ZONE_OVERLAP'
  | 'KEEP_CLEAR_BREACHED'
  | 'BUILT_ON_UNSUITABLE_GROUND'
  | 'MISSING_ESSENTIAL'
  | 'NO_SURFACE'
  | 'SLOPE_TOO_STEEP';

export type SiteModelFinding = {
  kind: SiteFindingKind;
  severity: 'CRITICAL' | 'MAJOR';
  subject: string;
  detail: string;
  /** The zones involved, so a screen can highlight them rather than search. */
  zoneIds: string[];
  /** How much ground is in conflict, where that is the measure of it. */
  squareMetres?: number;
};

export type SiteModelView = {
  modelId: string;
  missionId: string;
  boundary?: { ring: geo.Ring; areaSquareMetres: number; perimeterMetres: number };
  surface?: {
    triangles: number;
    /**
     * The mesh itself, for anything that draws the ground.
     *
     * Carried on the view rather than fetched separately for the same reason
     * the zone rings are: the figures and the shape they were computed from
     * belong together, and two fetches is how a screen comes to show one and
     * quote the other.
     */
    mesh: geo.Triangle3[];
    steepestPercent: number;
    steepestAspectDegrees: number;
    /** Against the mean level of the site, which is the only datum a capture has. */
    cutCubicMetres: number;
    fillCubicMetres: number;
    meanLevelMetres: number;
  };
  zones: ZoneMeasurement[];
  /** Ground inside the boundary that no zone occupies. */
  unallocatedSquareMetres?: number;
  findings: SiteModelFinding[];
  summary: string;
};

/**
 * The model, measured, with everything wrong with it.
 *
 * Findings are derived on every read rather than stored, so a plan cannot be
 * edited into correctness on paper while a stored finding still says otherwise.
 */
export function siteModel(ctx: EngineContext, modelId: string): SiteModelView {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'R');

  const record = requireModel(ctx, modelId);
  const state = record.state;
  const zones = state.zones;
  const findings: SiteModelFinding[] = [];

  const measurements: ZoneMeasurement[] = zones.map((zone) => ({
    zoneId: zone.zoneId,
    code: zone.code,
    instanceName: zone.instanceName,
    source: zone.source,
    ring: zone.ring,
    areaSquareMetres: round(geo.area(zone.ring)),
    perimeterMetres: round(geo.perimeter(zone.ring)),
    labelPoint: interiorPoint(zone.ring),
  }));

  // ── Zones that overlap each other ────────────────────────────────────────
  for (let i = 0; i < zones.length; i += 1) {
    for (let j = i + 1; j < zones.length; j += 1) {
      const a = zones[i]!;
      const b = zones[j]!;
      const shared = geo.intersectionArea(a.ring, b.ring);
      if (shared <= 1e-6) continue;

      const nesting = MAY_NEST.includes(a.code) || MAY_NEST.includes(b.code);
      const keepClear = KEEP_CLEAR.includes(a.code) ? a : KEEP_CLEAR.includes(b.code) ? b : undefined;

      if (keepClear) {
        const other = keepClear === a ? b : a;
        findings.push({
          kind: 'KEEP_CLEAR_BREACHED',
          severity: 'CRITICAL',
          subject: `${other.instanceName} sits inside ${keepClear.instanceName}`,
          detail:
            `${round(shared)}m² of ${other.instanceName} is inside ${keepClear.instanceName}, which is a zone nothing ` +
            'may occupy. Whatever the drawing shows, on the ground this is material or people where they may not be.',
          zoneIds: [a.zoneId, b.zoneId],
          squareMetres: round(shared),
        });
        continue;
      }

      if (nesting) continue;

      findings.push({
        kind: 'ZONE_OVERLAP',
        severity: 'MAJOR',
        subject: `${a.instanceName} and ${b.instanceName} occupy the same ${round(shared)}m²`,
        detail:
          'Two things cannot both be on that ground. On a drawing it reads as a hatching error; on site it is one of ' +
          'them being moved after it is built, and the cost of moving it is nobody’s allowance.',
        zoneIds: [a.zoneId, b.zoneId],
        squareMetres: round(shared),
      });
    }
  }

  // ── Anything built on ground that cannot take it ─────────────────────────
  const unsuitable = zones.filter((zone) => UNSUITABLE_GROUND.includes(zone.code));
  const built = zones.filter((zone) => !UNSUITABLE_GROUND.includes(zone.code) && !KEEP_CLEAR.includes(zone.code));
  for (const ground of unsuitable) {
    for (const structure of built) {
      const shared = geo.intersectionArea(ground.ring, structure.ring);
      if (shared <= 1e-6) continue;
      findings.push({
        kind: 'BUILT_ON_UNSUITABLE_GROUND',
        severity: 'MAJOR',
        subject: `${structure.instanceName} is on ${ground.instanceName}`,
        detail:
          `${round(shared)}m² of ${structure.instanceName} sits on ${ground.instanceName.toLowerCase()}. It needs ` +
          'either a decision to treat the ground or a different position, and the decision is cheaper now than after ' +
          'the units are craned in.',
        zoneIds: [ground.zoneId, structure.zoneId],
        squareMetres: round(shared),
      });
    }
  }

  // ── What is simply not there ─────────────────────────────────────────────
  const present = new Set(zones.map((zone) => zone.code));
  for (const essential of REQUIRED_FOR_A_COMPLETE_SITE) {
    if (present.has(essential.code)) continue;
    findings.push({
      kind: 'MISSING_ESSENTIAL',
      severity: 'MAJOR',
      subject: `No ${essential.code.toLowerCase().replace(/_/g, ' ')} is on the layout`,
      detail: essential.why,
      zoneIds: [],
    });
  }

  // ── The ground itself ────────────────────────────────────────────────────
  let surfaceView: SiteModelView['surface'];
  if (state.surface) {
    const steepest = geo.steepestSlope(state.surface);
    const levels = state.surface.triangles.flatMap((t) => t.map((p) => p.z));
    const meanLevel = levels.reduce((sum, z) => sum + z, 0) / levels.length;
    const volumes = geo.volumeAboveLevel(state.surface, meanLevel);
    surfaceView = {
      triangles: state.surface.triangles.length,
      mesh: state.surface.triangles,
      steepestPercent: steepest?.percent ?? 0,
      steepestAspectDegrees: steepest?.aspectDegrees ?? 0,
      cutCubicMetres: volumes.cutCubicMetres,
      fillCubicMetres: volumes.fillCubicMetres,
      meanLevelMetres: round(meanLevel),
    };

    // 1 in 12 is the ordinary limit for a route people and plant share. Above
    // it the layout needs regrading or a different route, and that is a
    // programme item rather than a note.
    if ((steepest?.percent ?? 0) > 8.33) {
      findings.push({
        kind: 'SLOPE_TOO_STEEP',
        severity: 'MAJOR',
        subject: `Ground reaches ${steepest?.percent}% where 8.33% is the working limit`,
        detail:
          'Steeper than 1 in 12 needs regrading, a different route, or a stated restriction on what may use it. ' +
          'Left alone it becomes the reason a delivery cannot reach the compound in February.',
        zoneIds: [],
      });
    }
  } else {
    findings.push({
      kind: 'NO_SURFACE',
      severity: 'MAJOR',
      subject: 'No ground surface was captured',
      detail:
        'Slopes, levels and cut and fill cannot be computed, so every one of them below is absent rather than zero. ' +
        'A device with depth produces this on the walk; one without cannot, and the layout is planned flat.',
      zoneIds: [],
    });
  }

  const boundaryArea = state.boundary ? geo.area(state.boundary) : undefined;
  const occupied = zones
    .filter((zone) => !KEEP_CLEAR.includes(zone.code))
    .reduce((sum, zone) => sum + geo.area(zone.ring), 0);

  const critical = findings.filter((finding) => finding.severity === 'CRITICAL').length;

  return {
    modelId,
    missionId: state.missionId,
    ...(state.boundary
      ? {
          boundary: {
            ring: state.boundary,
            areaSquareMetres: round(geo.area(state.boundary)),
            perimeterMetres: round(geo.perimeter(state.boundary)),
          },
        }
      : {}),
    ...(surfaceView ? { surface: surfaceView } : {}),
    zones: measurements,
    // Overlaps mean this can read low; it is what is left over rather than a
    // precise free area, and it is named that way on the screen.
    ...(boundaryArea === undefined ? {} : { unallocatedSquareMetres: round(Math.max(0, boundaryArea - occupied)) }),
    findings,
    summary:
      `${zones.length} zone(s) over ${boundaryArea === undefined ? 'an unbounded site' : `${round(boundaryArea)}m²`}. ` +
      `${findings.length === 0 ? 'Nothing conflicts.' : `${findings.length} finding(s)${critical > 0 ? `, ${critical} critical` : ''}.`}`,
  };
}

/**
 * What changed between two captures of the same site.
 *
 * Matched by code and name, because that is how a person refers to a zone —
 * "Laydown A moved" — and matching by identifier would report every zone as
 * removed and re-added on any recapture, which is the answer nobody can use.
 */
export type SiteChange = {
  kind: 'ADDED' | 'REMOVED' | 'GREW' | 'SHRANK' | 'MOVED' | 'UNCHANGED';
  code: LogisticsElement;
  instanceName: string;
  fromSquareMetres?: number;
  toSquareMetres?: number;
  deltaSquareMetres?: number;
  movedMetres?: number;
};

/**
 * How much material moved between two captures, and over what ground.
 *
 * The zone comparison above answers what changed on the *layout*. This answers
 * what changed in the *earth*, which is the question a progress claim and a
 * muck-away invoice both turn on. Absent rather than zero where either capture
 * has no surface: a device without depth cannot answer it, and zero would read
 * as "nothing moved".
 */
export type SiteVolumeChange = geo.VolumeChange & {
  /** What the figures may be used for, given how they were captured. */
  basis: string;
};

export function compareModels(
  ctx: EngineContext,
  fromModelId: string,
  toModelId: string,
): { changes: SiteChange[]; volume?: SiteVolumeChange; volumeAbsent?: string; chargedMinor?: number; summary: string } {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'R');

  const fromModel = requireModel(ctx, fromModelId).state;
  const toModel = requireModel(ctx, toModelId).state;
  const before = fromModel.zones;
  const after = toModel.zones;
  const key = (zone: SiteZone): string => `${zone.code}::${zone.instanceName.toLowerCase()}`;

  const beforeByKey = new Map(before.map((zone) => [key(zone), zone]));
  const afterByKey = new Map(after.map((zone) => [key(zone), zone]));
  const changes: SiteChange[] = [];

  for (const [k, zone] of afterByKey) {
    const was = beforeByKey.get(k);
    if (!was) {
      changes.push({ kind: 'ADDED', code: zone.code, instanceName: zone.instanceName, toSquareMetres: round(geo.area(zone.ring)) });
      continue;
    }
    const fromArea = geo.area(was.ring);
    const toArea = geo.area(zone.ring);
    const delta = toArea - fromArea;
    const moved = geo.distance(geo.centroid(was.ring), geo.centroid(zone.ring));

    // A metre of movement and a per cent of area are below what a handheld
    // capture can resolve. Reporting them would fill a change report with
    // noise and bury the one thing that actually moved.
    if (Math.abs(delta) / Math.max(fromArea, 1) < 0.01 && moved < 1) {
      changes.push({ kind: 'UNCHANGED', code: zone.code, instanceName: zone.instanceName, toSquareMetres: round(toArea) });
    } else if (moved >= 1 && Math.abs(delta) / Math.max(fromArea, 1) < 0.01) {
      changes.push({
        kind: 'MOVED',
        code: zone.code,
        instanceName: zone.instanceName,
        fromSquareMetres: round(fromArea),
        toSquareMetres: round(toArea),
        movedMetres: round(moved),
      });
    } else {
      changes.push({
        kind: delta > 0 ? 'GREW' : 'SHRANK',
        code: zone.code,
        instanceName: zone.instanceName,
        fromSquareMetres: round(fromArea),
        toSquareMetres: round(toArea),
        deltaSquareMetres: round(delta),
        ...(moved >= 1 ? { movedMetres: round(moved) } : {}),
      });
    }
  }

  for (const [k, zone] of beforeByKey) {
    if (afterByKey.has(k)) continue;
    changes.push({ kind: 'REMOVED', code: zone.code, instanceName: zone.instanceName, fromSquareMetres: round(geo.area(zone.ring)) });
  }

  // ── What moved in the ground, not on the drawing ─────────────────────────
  //
  // Only where both captures have a surface. A single-sided comparison is not
  // a volume, and reporting zero would say the site is untouched.
  let volume: SiteVolumeChange | undefined;
  let volumeAbsent: string | undefined;
  let chargedMinor: number | undefined;

  if (!fromModel.surface || !toModel.surface) {
    const missing =
      !fromModel.surface && !toModel.surface
        ? 'Neither capture recorded a ground surface'
        : !fromModel.surface
          ? 'The earlier capture did not record a ground surface'
          : 'The later capture did not record a ground surface';
    volumeAbsent =
      `${missing}, so no volume can be measured between them. This is absent rather than zero — zero would say ` +
      'the ground is exactly as it was.';
  } else {
    const from = fromModel.surface;
    const to = toModel.surface;
    const metered = meterSpatialStage(
      ctx.wallet,
      {
        stage: 'CHANGE_VOLUME',
        // The clip is every later triangle against every earlier one, so the
        // work is the product rather than the sum.
        primitives: from.triangles.length * to.triangles.length,
        projectId: ctx.projectId,
        userId: ctx.auth.actorId,
      },
      () => geo.volumeBetween(from, to),
    );
    chargedMinor = metered.chargedMinor;
    volume = {
      ...metered.result,
      basis:
        'Measured between two handheld captures. The figure is exact over the ground both of them covered, and ' +
        'carries whatever error those captures carried — it is a check against the haulage records, not a ' +
        'substitute for a measured survey.',
    };
  }

  const moved = changes.filter((change) => change.kind !== 'UNCHANGED').length;
  const layout =
    moved === 0 ? 'Nothing on the layout changed between these two captures.' : `${moved} of ${changes.length} zone(s) changed.`;
  const earth = volume
    ? ` ${volume.cutCubicMetres}m³ out and ${volume.fillCubicMetres}m³ in, over the ${volume.comparedSquareMetres}m² both captures covered.`
    : '';

  return {
    changes,
    ...(volume ? { volume } : {}),
    ...(volumeAbsent ? { volumeAbsent } : {}),
    ...(chargedMinor === undefined ? {} : { chargedMinor }),
    summary: `${layout}${earth}`,
  };
}

/**
 * The zones as they stand, for a planner that has to treat them as obstacles.
 *
 * Separate from `siteModel` because the planner wants the rings and nothing
 * else — measurements and findings on every read would be work done to be
 * thrown away, and a planner that took the whole view would be tempted to
 * reason about findings it has no authority over.
 */
export function zonesOf(ctx: EngineContext, modelId: string): SiteZone[] {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'R');
  return requireModel(ctx, modelId).state.zones;
}

/** Every model on the project, newest first. */
export function modelBoard(ctx: EngineContext): Array<{ modelId: string; missionId: string; zones: number; createdAt: string }> {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'R');
  return ctx.ledger
    .list(ctx.projectId, 'SiteModel')
    .map((record) => {
      const state = record.state as unknown as ModelState;
      return { modelId: state.id, missionId: state.missionId, zones: state.zones.length, createdAt: state.createdAt };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * A point guaranteed to be inside the ring.
 *
 * The centroid is not: for a concave zone it lands in the bite, and a label
 * placed there sits on the neighbouring zone. So the centroid is tried first
 * because it is the nicest answer when it works, and the largest triangle's
 * centroid is the fallback, which always works because a triangle is convex.
 */
export function interiorPoint(ring: geo.Ring): geo.Point {
  const middle = geo.centroid(ring);
  if (geo.containsPoint(ring, middle)) return { x: round(middle.x), y: round(middle.y) };

  let best: { point: geo.Point; area: number } | undefined;
  for (const triangle of geo.triangulate(ring)) {
    const size = geo.area(triangle);
    if (!best || size > best.area) best = { point: geo.centroid(triangle), area: size };
  }
  const point = best?.point ?? middle;
  return { x: round(point.x), y: round(point.y) };
}

function requireModel(ctx: EngineContext, modelId: string): { refId: string; state: ModelState } {
  const record = ctx.ledger.get({ refType: 'SiteModel', refId: modelId });
  if (!record || record.tenantId !== ctx.tenantId) {
    throw new DomainError('SITE_MODEL_NOT_FOUND', `No site model ${modelId}`, 404);
  }
  return { refId: record.refId, state: record.state as unknown as ModelState };
}

/** Centimetre precision. A capture does not resolve finer, and printing more implies it did. */
function round(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}
