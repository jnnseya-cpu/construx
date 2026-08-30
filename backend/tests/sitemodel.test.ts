import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as geo from '../src/domain/geometry.ts';
import * as layout from '../src/domain/sitelayout.ts';
import * as model from '../src/domain/sitemodel.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The site as geometry, and the layout designed on it.
 *
 * Every figure asserted here is one a person could re-measure off a drawing,
 * because that is the whole claim: the platform is not describing a site setup,
 * it is computing one and can be checked.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

/** A 200m × 100m site: 20,000m². */
const SITE: geo.Ring = [
  { x: 0, y: 0 },
  { x: 200, y: 0 },
  { x: 200, y: 100 },
  { x: 0, y: 100 },
];

const box = (x: number, y: number, w: number, h: number): geo.Ring => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

async function site(): Promise<{
  platform: Platform;
  seed: SeedResult;
  ctx: () => ReturnType<Platform['context']>;
  modelId: string;
}> {
  const fresh = new Platform();
  const freshSeed = await seedDemoProject(fresh);
  const ctx = () => fresh.context(freshSeed.users.constructionManager!.auth, freshSeed.projectId, { source: 'PWA' });
  const { modelId } = model.recordBoundary(ctx(), { missionId: 'MISSION-1', ring: SITE });
  return { platform: fresh, seed: freshSeed, ctx, modelId };
}

// ── The record ──────────────────────────────────────────────────────────────

describe('the boundary everything is measured against', () => {
  it('measures the site it was given', async () => {
    const s = await site();
    const view = model.siteModel(s.ctx(), s.modelId);
    assert.equal(view.boundary?.areaSquareMetres, 20000);
    assert.equal(view.boundary?.perimeterMetres, 600);
  });

  it('refuses a second boundary for one walk', async () => {
    const s = await site();
    throwsCode(() => model.recordBoundary(s.ctx(), { missionId: 'MISSION-1', ring: SITE }), 'SITE_MODEL_EXISTS');
  });

  it('refuses a zone that leaves the site rather than trimming it to fit', async () => {
    // A 40×40 laydown at x=180 puts half of it on the neighbour. Clipping it
    // would silently decide that the boundary was right and the laydown wrong.
    const s = await site();
    const refusal = throwsCode(
      () =>
        model.placeZone(s.ctx(), {
          modelId: s.modelId,
          code: 'LAYDOWN',
          instanceName: 'Laydown A',
          ring: box(180, 30, 40, 40),
          source: 'PLANNED',
        }),
      'ZONE_OUTSIDE_BOUNDARY',
    );
    assert.match(String(refusal.message), /800m² of 1600m² outside/);
    assert.match(String(refusal.message), /without telling anybody/);
  });

  it('measures a zone that is on the site', async () => {
    const s = await site();
    const placed = model.placeZone(s.ctx(), {
      modelId: s.modelId,
      code: 'LAYDOWN',
      instanceName: 'Laydown A',
      ring: box(10, 10, 40, 20),
      source: 'PLANNED',
    });
    assert.equal(placed.areaSquareMetres, 800);
  });

  it('refuses a code that is not in the element catalogue', async () => {
    const s = await site();
    throwsCode(
      () =>
        model.placeZone(s.ctx(), {
          modelId: s.modelId,
          code: 'HELIPAD' as never,
          instanceName: 'Helipad',
          ring: box(10, 10, 10, 10),
          source: 'PLANNED',
        }),
      'ZONE_CODE_UNKNOWN',
    );
  });
});

// ── What the geometry finds ─────────────────────────────────────────────────

describe('conflicts found by computation, not by somebody noticing', () => {
  it('reports two zones on the same ground, with how much', async () => {
    const s = await site();
    // 40×20 at (10,10) and 40×20 at (30,10) share 20×20 = 400m².
    model.placeZone(s.ctx(), { modelId: s.modelId, code: 'LAYDOWN', instanceName: 'Laydown A', ring: box(10, 10, 40, 20), source: 'PLANNED' });
    model.placeZone(s.ctx(), { modelId: s.modelId, code: 'PARKING', instanceName: 'Parking', ring: box(30, 10, 40, 20), source: 'PLANNED' });

    const overlap = model.siteModel(s.ctx(), s.modelId).findings.find((f) => f.kind === 'ZONE_OVERLAP');
    assert.ok(overlap, 'two zones on one piece of ground were not reported');
    assert.equal(overlap.squareMetres, 400);
    assert.equal(overlap.zoneIds.length, 2);
  });

  it('treats a breach of a keep-clear zone as critical, not as an overlap', async () => {
    // Storing material inside an exclusion is not untidy drafting.
    const s = await site();
    model.placeZone(s.ctx(), { modelId: s.modelId, code: 'EXCLUSION_ZONE', instanceName: 'Overhead line corridor', ring: box(100, 0, 30, 100), source: 'OBSERVED' });
    model.placeZone(s.ctx(), { modelId: s.modelId, code: 'LAYDOWN', instanceName: 'Laydown B', ring: box(110, 20, 40, 20), source: 'PLANNED' });

    const findings = model.siteModel(s.ctx(), s.modelId).findings;
    const breach = findings.find((f) => f.kind === 'KEEP_CLEAR_BREACHED');
    assert.ok(breach);
    assert.equal(breach.severity, 'CRITICAL');
    // 110→130 of the laydown is inside the corridor: 20 × 20 = 400m².
    assert.equal(breach.squareMetres, 400);
    // And it is not double reported as an ordinary overlap.
    assert.equal(findings.some((f) => f.kind === 'ZONE_OVERLAP'), false);
  });

  it('does not report a gate inside the hoarding as a conflict', async () => {
    // Some things belong inside others. A rule that flagged every nesting would
    // fill the report with noise and bury the breach above.
    const s = await site();
    model.placeZone(s.ctx(), { modelId: s.modelId, code: 'HOARDING', instanceName: 'Perimeter hoarding', ring: box(0, 0, 200, 4), source: 'PLANNED' });
    model.placeZone(s.ctx(), { modelId: s.modelId, code: 'GATE', instanceName: 'Gate 1', ring: box(20, 0, 8, 4), source: 'PLANNED' });

    const findings = model.siteModel(s.ctx(), s.modelId).findings;
    assert.equal(findings.some((f) => f.kind === 'ZONE_OVERLAP'), false);
  });

  it('reports a compound built on ground that cannot take it', async () => {
    const s = await site();
    model.placeZone(s.ctx(), { modelId: s.modelId, code: 'STANDING_WATER', instanceName: 'Standing water', ring: box(50, 50, 40, 30), source: 'OBSERVED' });
    model.placeZone(s.ctx(), { modelId: s.modelId, code: 'SITE_OFFICE', instanceName: 'Site offices', ring: box(60, 60, 20, 20), source: 'PLANNED' });

    const finding = model.siteModel(s.ctx(), s.modelId).findings.find((f) => f.kind === 'BUILT_ON_UNSUITABLE_GROUND');
    assert.ok(finding);
    assert.equal(finding.squareMetres, 400);
    assert.match(finding.detail, /cheaper now than after the units are craned in/);
  });

  it('names what is simply missing from the layout', async () => {
    const s = await site();
    const missing = model.siteModel(s.ctx(), s.modelId).findings.filter((f) => f.kind === 'MISSING_ESSENTIAL');
    // Gate, welfare, muster point and a pedestrian route: none is on an empty site.
    assert.equal(missing.length, 4);
    assert.ok(missing.some((f) => /pedestrian route/i.test(f.subject) && /how they are killed/.test(f.detail)));
  });

  it('says it has no surface rather than reporting a flat one', async () => {
    // A capture from a device without depth has no levels. Reporting zero slope
    // and zero cut would be a measurement nobody made.
    const s = await site();
    const view = model.siteModel(s.ctx(), s.modelId);
    assert.equal(view.surface, undefined);
    const finding = view.findings.find((f) => f.kind === 'NO_SURFACE');
    assert.ok(finding);
    assert.match(finding.detail, /absent rather than zero/);
  });
});

// ── The ground itself ───────────────────────────────────────────────────────

describe('the surface the device produced', () => {
  it('takes a mesh and reports its steepest slope', async () => {
    const s = await site();
    // Rising 6m over 40m eastward is 15%.
    const result = model.ingestSurface(s.ctx(), {
      modelId: s.modelId,
      triangles: [
        [{ x: 0, y: 0, z: 0 }, { x: 40, y: 0, z: 6 }, { x: 0, y: 40, z: 0 }],
        [{ x: 40, y: 0, z: 6 }, { x: 40, y: 40, z: 6 }, { x: 0, y: 40, z: 0 }],
      ],
    });
    assert.equal(result.triangles, 2);
    assert.equal(result.steepestPercent, 15);

    const view = model.siteModel(s.ctx(), s.modelId);
    assert.equal(view.surface?.steepestPercent, 15);
    // Steeper than 1 in 12, so it is a finding rather than a statistic.
    assert.ok(view.findings.some((f) => f.kind === 'SLOPE_TOO_STEEP'));
  });

  it('does not raise a slope finding on ground a wheelchair could use', async () => {
    const s = await site();
    // 2m over 40m is 5%, inside the 8.33% limit.
    model.ingestSurface(s.ctx(), {
      modelId: s.modelId,
      triangles: [[{ x: 0, y: 0, z: 0 }, { x: 40, y: 0, z: 2 }, { x: 0, y: 40, z: 0 }]],
    });
    assert.equal(model.siteModel(s.ctx(), s.modelId).findings.some((f) => f.kind === 'SLOPE_TOO_STEEP'), false);
  });

  it('refuses an empty surface', async () => {
    const s = await site();
    throwsCode(() => model.ingestSurface(s.ctx(), { modelId: s.modelId, triangles: [] }), 'SURFACE_EMPTY');
  });
});

// ── Change between captures ─────────────────────────────────────────────────

describe('what changed between two captures of the same site', () => {
  it('reports what was added, what grew and what went', async () => {
    const s = await site();
    model.placeZone(s.ctx(), { modelId: s.modelId, code: 'LAYDOWN', instanceName: 'Laydown A', ring: box(10, 10, 40, 20), source: 'OBSERVED' });
    model.placeZone(s.ctx(), { modelId: s.modelId, code: 'PARKING', instanceName: 'Parking', ring: box(60, 10, 20, 20), source: 'OBSERVED' });

    // A second walk two weeks later.
    const later = model.recordBoundary(s.ctx(), { missionId: 'MISSION-2', ring: SITE }).modelId;
    // Laydown A doubled: 40×20 → 80×20.
    model.placeZone(s.ctx(), { modelId: later, code: 'LAYDOWN', instanceName: 'Laydown A', ring: box(10, 10, 80, 20), source: 'OBSERVED' });
    // Parking is gone, a spoil heap has appeared.
    model.placeZone(s.ctx(), { modelId: later, code: 'SPOIL_HEAP', instanceName: 'Spoil', ring: box(120, 10, 30, 30), source: 'OBSERVED' });

    const { changes } = model.compareModels(s.ctx(), s.modelId, later);
    const byName = new Map(changes.map((c) => [c.instanceName, c]));
    assert.equal(byName.get('Laydown A')?.kind, 'GREW');
    assert.equal(byName.get('Laydown A')?.deltaSquareMetres, 800);
    assert.equal(byName.get('Parking')?.kind, 'REMOVED');
    assert.equal(byName.get('Spoil')?.kind, 'ADDED');
    assert.equal(byName.get('Spoil')?.toSquareMetres, 900);
  });

  it('reports a zone that only moved as moved, not as grown and shrunk', async () => {
    const s = await site();
    model.placeZone(s.ctx(), { modelId: s.modelId, code: 'WELFARE', instanceName: 'Welfare', ring: box(10, 10, 20, 20), source: 'OBSERVED' });
    const later = model.recordBoundary(s.ctx(), { missionId: 'MISSION-2', ring: SITE }).modelId;
    model.placeZone(s.ctx(), { modelId: later, code: 'WELFARE', instanceName: 'Welfare', ring: box(80, 10, 20, 20), source: 'OBSERVED' });

    const change = model.compareModels(s.ctx(), s.modelId, later).changes[0]!;
    assert.equal(change.kind, 'MOVED');
    assert.equal(change.movedMetres, 70);
  });

  it('does not report noise a handheld capture cannot resolve', async () => {
    // Half a metre and a fraction of a per cent are below what the device sees.
    // A change report full of those buries the one thing that actually moved.
    const s = await site();
    model.placeZone(s.ctx(), { modelId: s.modelId, code: 'WELFARE', instanceName: 'Welfare', ring: box(10, 10, 20, 20), source: 'OBSERVED' });
    const later = model.recordBoundary(s.ctx(), { missionId: 'MISSION-2', ring: SITE }).modelId;
    model.placeZone(s.ctx(), { modelId: later, code: 'WELFARE', instanceName: 'Welfare', ring: box(10.4, 10, 20, 20), source: 'OBSERVED' });

    assert.equal(model.compareModels(s.ctx(), s.modelId, later).changes[0]!.kind, 'UNCHANGED');
  });
});

// ── The layout planner ──────────────────────────────────────────────────────

describe('designing the site setup', () => {
  const gate = { x: 0, y: 50 };
  const workFace = { x: 200, y: 50 };

  it('sizes welfare from the workforce, at published rates', () => {
    // 60 operatives at 1.1m² and 8 staff at 6m². Parking: ceil(60/4)+8 = 23
    // spaces at 25m² = 575m².
    const requirements = layout.welfareRequirements({ peakWorkforce: 60, staff: 8 });
    assert.equal(requirements.find((r) => r.code === 'WELFARE')?.squareMetres, 66);
    assert.equal(requirements.find((r) => r.code === 'SITE_OFFICE')?.squareMetres, 48);
    assert.equal(requirements.find((r) => r.code === 'PARKING')?.squareMetres, 575);
  });

  it('produces three genuinely different layouts, each placing everything', async () => {
    const s = await site();
    const { scenarios } = layout.planLayout(s.ctx(), {
      boundary: SITE,
      gate,
      workFace,
      requirements: [
        ...layout.welfareRequirements({ peakWorkforce: 60, staff: 8 }),
        { code: 'LAYDOWN', instanceName: 'Laydown A', squareMetres: 800 },
      ],
    });

    assert.equal(scenarios.length, 3);
    for (const scenario of scenarios) {
      assert.equal(scenario.feasibility, 'FEASIBLE', `${scenario.label}: ${scenario.couldNotPlace.join(', ')}`);
      assert.equal(scenario.placements.length, 4);
      for (const placement of scenario.placements) {
        // Everything placed is inside the site — the check the whole module exists for.
        const inside = geo.intersectionArea(placement.ring, SITE);
        assert.ok(geo.area(placement.ring) - inside < 1e-3, `${placement.instanceName} left the site`);
        assert.ok(placement.reason.length > 30, `${placement.instanceName} was placed with no stated reason`);
      }
      // And nothing placed overlaps anything else placed.
      for (let i = 0; i < scenario.placements.length; i += 1) {
        for (let j = i + 1; j < scenario.placements.length; j += 1) {
          const shared = geo.intersectionArea(scenario.placements[i]!.ring, scenario.placements[j]!.ring);
          assert.ok(shared < 1e-3, `${scenario.label}: ${scenario.placements[i]!.instanceName} overlaps ${scenario.placements[j]!.instanceName} by ${shared}m²`);
        }
      }
    }

    // The strategies really differ: welfare is not in the same place in all three.
    const welfareX = scenarios.map((s2) => s2.placements.find((p) => p.code === 'WELFARE')!.metresToWorkFace);
    assert.ok(new Set(welfareX).size > 1, 'three strategies produced the same layout');
  });

  it('puts welfare nearer the work under one strategy and nearer the gate under the other', async () => {
    const s = await site();
    const { scenarios } = layout.planLayout(s.ctx(), {
      boundary: SITE,
      gate,
      workFace,
      requirements: [
        ...layout.welfareRequirements({ peakWorkforce: 60, staff: 8 }),
        { code: 'LAYDOWN', instanceName: 'Laydown A', squareMetres: 800 },
      ],
    });
    const near = scenarios.find((sc) => sc.strategy === 'WELFARE_NEAR_WORK')!;
    const delivery = scenarios.find((sc) => sc.strategy === 'SHORT_DELIVERY_RUN')!;

    // The score is metres of daily travel and nothing else, so it is a figure
    // somebody can check by pacing it. A credit for free ground used to be
    // folded in at a hundred times the weight of the distances, which made the
    // number both unreadable and dominated by the term it was meant to
    // tie-break.
    assert.equal(near.score.weighted, Math.round((near.score.welfareWalkMetres + near.score.deliveryRunMetres) * 10) / 10);
    assert.ok(near.score.weighted > 0, `a travel distance of ${near.score.weighted}m is not a distance`);

    assert.ok(
      near.score.welfareWalkMetres < delivery.score.welfareWalkMetres,
      'the welfare-first strategy did not put welfare closer to the work',
    );
    assert.ok(
      delivery.score.deliveryRunMetres < near.score.deliveryRunMetres,
      'the delivery-first strategy did not shorten the delivery run',
    );
  });

  it('plans around what is already on the ground', async () => {
    const s = await site();
    // An exclusion across the middle third of the site.
    model.placeZone(s.ctx(), { modelId: s.modelId, code: 'EXCLUSION_ZONE', instanceName: 'Overhead line', ring: box(80, 0, 40, 100), source: 'OBSERVED' });
    const obstacles = model.zonesOf(s.ctx(), s.modelId);

    const { scenarios } = layout.planLayout(s.ctx(), {
      boundary: SITE,
      gate,
      workFace,
      obstacles,
      requirements: [{ code: 'LAYDOWN', instanceName: 'Laydown A', squareMetres: 800 }],
    });

    for (const scenario of scenarios) {
      for (const placement of scenario.placements) {
        const shared = geo.intersectionArea(placement.ring, obstacles[0]!.ring);
        assert.ok(shared < 1e-3, `${scenario.label} placed ${placement.instanceName} inside the exclusion by ${shared}m²`);
      }
    }
  });

  it('declares a layout infeasible and names what would not fit, rather than shrinking it', async () => {
    // A 30×30 site cannot hold a 2000m² laydown. Sizing it down to fit is how a
    // compound ends up failing its first inspection.
    const s = await site();
    const tiny: geo.Ring = box(0, 0, 30, 30);
    const { scenarios, summary } = layout.planLayout(s.ctx(), {
      boundary: tiny,
      gate: { x: 0, y: 15 },
      workFace: { x: 30, y: 15 },
      requirements: [{ code: 'LAYDOWN', instanceName: 'Laydown A', squareMetres: 2000 }],
    });

    for (const scenario of scenarios) {
      assert.equal(scenario.feasibility, 'INFEASIBLE');
      assert.deepEqual(scenario.couldNotPlace, ['Laydown A (2000m²)']);
      assert.match(scenario.explanation, /Nothing has been shrunk/);
    }
    assert.match(summary, /None of the 3 strategies fits/);
  });

  it('ranks feasible layouts above infeasible ones whatever else they score', async () => {
    // A 60×50 site with these areas is genuinely mixed: two strategies fit
    // everything and the compact one does not. A site where all three agree
    // proves nothing about the ordering, which is what the first version of
    // this test did — it compared a sorted array against itself.
    const s = await site();
    const { scenarios } = layout.planLayout(s.ctx(), {
      boundary: box(0, 0, 60, 50),
      gate: { x: 0, y: 25 },
      workFace: { x: 60, y: 25 },
      requirements: [
        { code: 'LAYDOWN', instanceName: 'Laydown A', squareMetres: 1050 },
        { code: 'WELFARE', instanceName: 'Welfare', squareMetres: 540 },
        { code: 'SITE_OFFICE', instanceName: 'Offices', squareMetres: 420 },
      ],
    });

    const kinds = scenarios.map((sc) => sc.feasibility);
    assert.ok(new Set(kinds).size > 1, 'this site no longer produces a mix, so the ordering is untested');
    const firstInfeasible = kinds.indexOf('INFEASIBLE');
    assert.equal(
      kinds.slice(firstInfeasible).every((k) => k === 'INFEASIBLE'),
      true,
      `an infeasible layout outranked a feasible one: ${kinds.join(', ')}`,
    );
  });

  it('places the largest area first, because the reverse strands it', async () => {
    // A 40×40 site with a 560m² laydown, 192m² welfare and 154m² of offices.
    // Big-first fits all three strategies; smallest-first strands the laydown
    // on one of them, because the small areas land in the middle of the only
    // ground large enough to take it.
    const s = await site();
    const { scenarios } = layout.planLayout(s.ctx(), {
      boundary: box(0, 0, 40, 40),
      gate: { x: 0, y: 20 },
      workFace: { x: 40, y: 20 },
      requirements: [
        { code: 'LAYDOWN', instanceName: 'Laydown A', squareMetres: 560 },
        { code: 'WELFARE', instanceName: 'Welfare', squareMetres: 192 },
        { code: 'SITE_OFFICE', instanceName: 'Offices', squareMetres: 154 },
      ],
    });

    assert.equal(
      scenarios.filter((sc) => sc.feasibility === 'FEASIBLE').length,
      3,
      `only ${scenarios.filter((sc) => sc.feasibility === 'FEASIBLE').length} of 3 fitted: ` +
        scenarios.map((sc) => `${sc.strategy} ${sc.couldNotPlace.join('/')}`).join(' | '),
    );
  });

  it('refuses a gate that is not on the site', async () => {
    const s = await site();
    throwsCode(
      () =>
        layout.planLayout(s.ctx(), {
          boundary: SITE,
          gate: { x: 900, y: 900 },
          workFace,
          requirements: [{ code: 'LAYDOWN', instanceName: 'Laydown A', squareMetres: 100 }],
        }),
      'GATE_OFF_SITE',
    );
  });

  it('refuses to adopt a layout that could not place everything', async () => {
    const s = await site();
    const { scenarios } = layout.planLayout(s.ctx(), {
      boundary: box(0, 0, 30, 30),
      gate: { x: 0, y: 15 },
      workFace: { x: 30, y: 15 },
      requirements: [{ code: 'LAYDOWN', instanceName: 'Laydown A', squareMetres: 2000 }],
    });
    const refusal = throwsCode(
      () => layout.adoptScenario(s.ctx(), { modelId: s.modelId, scenario: scenarios[0]!, reason: 'It is the least bad one available' }),
      'SCENARIO_INFEASIBLE',
    );
    assert.match(String(refusal.message), /without a record of the decision to leave them out/);
  });

  it('adopts a feasible layout under approval authority, and refuses it without', async () => {
    const s = await site();
    const { scenarios } = layout.planLayout(s.ctx(), {
      boundary: SITE,
      gate,
      workFace,
      requirements: [{ code: 'LAYDOWN', instanceName: 'Laydown A', squareMetres: 800 }],
    });
    const best = scenarios[0]!;

    // The planner holds C and U on the constraints register but not A.
    throwsCode(
      () =>
        layout.adoptScenario(
          s.platform.context(s.seed.users.planner!.auth, s.seed.projectId, { source: 'WEB' }),
          { modelId: s.modelId, scenario: best, reason: 'Shortest delivery run on a materials-heavy job' },
        ),
      'ACCESS_DENIED',
    );

    const adopted = layout.adoptScenario(s.ctx(), {
      modelId: s.modelId,
      scenario: best,
      reason: 'Shortest delivery run on a materials-heavy job',
    });
    assert.equal(adopted.placements, best.placements.length);
  });

  it('refuses an adoption with no reason given', async () => {
    const s = await site();
    const { scenarios } = layout.planLayout(s.ctx(), {
      boundary: SITE,
      gate,
      workFace,
      requirements: [{ code: 'LAYDOWN', instanceName: 'Laydown A', squareMetres: 800 }],
    });
    throwsCode(
      () => layout.adoptScenario(s.ctx(), { modelId: s.modelId, scenario: scenarios[0]!, reason: 'best' }),
      'ADOPTION_REASON_REQUIRED',
    );
  });
});

// ── Labels ──────────────────────────────────────────────────────────────────

describe('a label point that is actually inside the zone', () => {
  it('falls inside a concave zone, where the centroid does not', () => {
    // The L from the geometry suite: its centroid is (11,11), which is in the
    // bite. A label placed there sits on the neighbouring zone.
    const l: geo.Ring = [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 30 },
      { x: 0, y: 30 },
    ];
    assert.equal(geo.containsPoint(l, geo.centroid(l)), false);
    assert.equal(geo.containsPoint(l, model.interiorPoint(l)), true);
  });

  it('uses the centroid for a convex zone, because it is the nicest answer', () => {
    const point = model.interiorPoint(SITE);
    assert.equal(point.x, 100);
    assert.equal(point.y, 50);
  });
});
