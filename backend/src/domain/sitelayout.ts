import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import type { LogisticsElement } from '../engines/sitevisit.ts';
import * as geo from './geometry.ts';
import { interiorPoint, type SiteZone } from './sitemodel.ts';

/**
 * Designing the site setup, and being able to say why.
 *
 * The specification asks for three to five ranked layout scenarios with a score
 * breakdown, a feasibility verdict, and an explanation of why each area is where
 * it is. This produces them — by search over real candidate positions against
 * real constraints, not by asking a model to imagine a compound.
 *
 * That distinction is the whole design. A layout is a set of rectangles on
 * ground, scored by distances anybody can re-measure: how far welfare is from
 * the work, how far deliveries travel from the gate, whether anything sits on an
 * exclusion. Those are arithmetic. A model asked for the same answer produces
 * something plausible that cannot be checked, and the first person to check it
 * finds the compound on the neighbour's land.
 *
 * ---
 *
 * ## How a scenario is built
 *
 * Every required area is placed in turn, biggest first, onto the best free
 * position found by scanning the buildable ground on a grid. "Best" differs per
 * area and is stated: welfare wants to be near the work face, laydown wants to
 * be near the gate, parking wants to be out of the way. Each placement then
 * becomes an obstacle for the next, so the result is a layout in which nothing
 * overlaps by construction rather than by later checking.
 *
 * Scenarios differ by **strategy** — which pull dominates — and that is why
 * they are genuinely different layouts rather than three renderings of one.
 *
 * ## What it refuses
 *
 * **A scenario that could not place everything is `INFEASIBLE` and says what it
 * could not place.** It is never silently returned short. The specification is
 * explicit that there is no hidden constraint relaxation, and a layout missing
 * its welfare is not a lower-scoring layout, it is not a layout.
 *
 * **Nothing here approves anything.** A scenario is a proposal with a score and
 * a reason. Adopting one is a person's act, under the same authority that sets
 * the site baseline.
 */

// --- What has to fit ---------------------------------------------------------

export type AreaRequirement = {
  code: LogisticsElement;
  instanceName: string;
  /** Ground it needs, in square metres. */
  squareMetres: number;
  /**
   * How square it has to be. A compound can be long and thin; a turning head
   * cannot. 1 is square, 3 means up to three times longer than wide.
   */
  maxAspect?: number;
};

/**
 * What the workforce implies, so a manager states people rather than areas.
 *
 * The rates are the ordinary ones used to size a compound and they are stated
 * here rather than buried in a calculation, because a business bidding against
 * a client's own standard has to be able to see them and argue with them.
 */
export const WELFARE_RATE = {
  /** Canteen, drying, lockers, WCs. Per person, m². */
  welfareSquareMetresPerPerson: 1.1,
  /** Site offices, meeting and induction. Per staff member, m². */
  officeSquareMetresPerStaff: 6.0,
  /** One space per this many operatives, plus staff one for one. */
  operativesPerParkingSpace: 4,
  /** A marked bay with circulation. */
  squareMetresPerParkingSpace: 25,
};

export function welfareRequirements(input: { peakWorkforce: number; staff: number }): AreaRequirement[] {
  const spaces = Math.ceil(input.peakWorkforce / WELFARE_RATE.operativesPerParkingSpace) + input.staff;
  return [
    {
      code: 'WELFARE',
      instanceName: 'Welfare',
      squareMetres: Math.max(20, Math.ceil(input.peakWorkforce * WELFARE_RATE.welfareSquareMetresPerPerson)),
      maxAspect: 2.5,
    },
    {
      code: 'SITE_OFFICE',
      instanceName: 'Site offices',
      squareMetres: Math.max(18, Math.ceil(input.staff * WELFARE_RATE.officeSquareMetresPerStaff)),
      maxAspect: 2.5,
    },
    {
      code: 'PARKING',
      instanceName: 'Parking',
      squareMetres: Math.max(25, spaces * WELFARE_RATE.squareMetresPerParkingSpace),
      maxAspect: 3,
    },
  ];
}

// --- Strategies --------------------------------------------------------------

/**
 * The pull that decides where things go.
 *
 * Three, because they are the three arguments actually had on a site, and each
 * produces a different layout rather than a different rendering:
 *
 *   - `WELFARE_NEAR_WORK` — people walk less, deliveries travel further
 *   - `SHORT_DELIVERY_RUN` — the reverse, and it is what a materials-heavy job
 *     wants
 *   - `COMPACT_COMPOUND` — everything together, which frees the most usable
 *     ground and is what a phased job needs
 */
export const LAYOUT_STRATEGY = {
  WELFARE_NEAR_WORK: {
    label: 'Welfare close to the work',
    rationale:
      'Puts people nearest the face and accepts a longer delivery run. Chosen where the labour content is high and ' +
      'the walk is paid for twice a day by everybody on site.',
  },
  SHORT_DELIVERY_RUN: {
    label: 'Shortest delivery run',
    rationale:
      'Puts laydown and holding nearest the gate and accepts a longer walk to welfare. Chosen where the job is ' +
      'materials-heavy and every delivery pays the distance.',
  },
  COMPACT_COMPOUND: {
    label: 'Compact compound',
    rationale:
      'Keeps the accommodation together and frees the largest single piece of usable ground. Chosen where the ' +
      'permanent works will need the site back in phases.',
  },
} as const;
export type LayoutStrategy = keyof typeof LAYOUT_STRATEGY;

// --- A placed layout ---------------------------------------------------------

export type Placement = {
  code: LogisticsElement;
  instanceName: string;
  ring: geo.Ring;
  areaSquareMetres: number;
  /** Why here rather than somewhere else, in one sentence. */
  reason: string;
  metresToGate?: number;
  metresToWorkFace?: number;
};

export type ScenarioScore = {
  /** Total walk, in metres, from welfare to the work face. */
  welfareWalkMetres: number;
  /** Gate to laydown, which every delivery pays. */
  deliveryRunMetres: number;
  /** Ground still free after everything is placed. */
  usableRemainingSquareMetres: number;
  /** Lower is better. The weighted figure the ranking uses. */
  weighted: number;
};

export type LayoutScenario = {
  scenarioId: string;
  strategy: LayoutStrategy;
  label: string;
  rationale: string;
  feasibility: 'FEASIBLE' | 'INFEASIBLE';
  /** Named, never silently dropped. */
  couldNotPlace: string[];
  placements: Placement[];
  score: ScenarioScore;
  explanation: string;
};

/**
 * Generate the scenarios.
 *
 * Read-only: it computes proposals and writes nothing. Adopting one is a
 * separate act with its own authority, because a layout that appeared in the
 * ledger because somebody opened a screen is a layout nobody decided on.
 */
export function planLayout(
  ctx: EngineContext,
  input: {
    boundary: geo.Ring;
    /** Where vehicles enter. Everything delivery-related is measured from here. */
    gate: geo.Point;
    /** Where the permanent works are. Everything people-related is measured from here. */
    workFace: geo.Point;
    /** Ground already taken or forbidden: exclusions, services, existing structures. */
    obstacles?: SiteZone[];
    requirements: AreaRequirement[];
  },
): { scenarios: LayoutScenario[]; summary: string } {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'R');

  if (input.requirements.length === 0) {
    throw new DomainError('NOTHING_TO_PLACE', 'A layout with nothing to place is not a layout');
  }
  if (!geo.containsPoint(input.boundary, input.gate) && geo.distanceToRing(input.gate, input.boundary) > 5) {
    throw new DomainError(
      'GATE_OFF_SITE',
      'The gate has to be on the boundary or just inside it. Everything delivery-related is measured from it, so a ' +
        'gate in the wrong place moves every distance below.',
    );
  }

  const scenarios = (Object.keys(LAYOUT_STRATEGY) as LayoutStrategy[]).map((strategy) =>
    buildScenario(strategy, input),
  );

  // Feasible first, then by weighted score. An infeasible layout never outranks
  // a feasible one however well the rest of it scores.
  scenarios.sort((a, b) => {
    if (a.feasibility !== b.feasibility) return a.feasibility === 'FEASIBLE' ? -1 : 1;
    // Metres of daily travel first. Where two layouts are within a metre of each
    // other — which on a real site means they are the same answer — the one
    // that leaves more ground free wins, because that ground is what the
    // permanent works need back.
    if (Math.abs(a.score.weighted - b.score.weighted) >= 1) return a.score.weighted - b.score.weighted;
    return b.score.usableRemainingSquareMetres - a.score.usableRemainingSquareMetres;
  });

  const feasible = scenarios.filter((scenario) => scenario.feasibility === 'FEASIBLE').length;
  return {
    scenarios,
    summary:
      feasible === 0
        ? `None of the ${scenarios.length} strategies fits everything on this site. What could not be placed is named on each.`
        : `${feasible} of ${scenarios.length} strategies fit everything. ${scenarios[0]!.label} scores best.`,
  };
}

function buildScenario(
  strategy: LayoutStrategy,
  input: Parameters<typeof planLayout>[1],
): LayoutScenario {
  const definition = LAYOUT_STRATEGY[strategy];
  const taken: geo.Ring[] = (input.obstacles ?? []).map((zone) => zone.ring);
  const placements: Placement[] = [];
  const couldNotPlace: string[] = [];

  // Biggest first. A small area will fit in what is left of a big one's
  // position; the reverse is not true, and placing small things first is how a
  // layout ends up with nowhere for the compound.
  const ordered = [...input.requirements].sort((a, b) => b.squareMetres - a.squareMetres);

  for (const requirement of ordered) {
    const anchor = anchorFor(requirement.code, strategy, input);
    const placed = place(requirement, input.boundary, taken, anchor.point);
    if (!placed) {
      couldNotPlace.push(`${requirement.instanceName} (${requirement.squareMetres}m²)`);
      continue;
    }
    taken.push(placed);
    const centre = interiorPoint(placed);
    placements.push({
      code: requirement.code,
      instanceName: requirement.instanceName,
      ring: placed,
      areaSquareMetres: Math.round(geo.area(placed) * 100) / 100,
      reason: anchor.reason,
      metresToGate: Math.round(geo.distance(centre, input.gate) * 10) / 10,
      metresToWorkFace: Math.round(geo.distance(centre, input.workFace) * 10) / 10,
    });
  }

  const welfare = placements.find((p) => p.code === 'WELFARE');
  const laydown = placements.find((p) => p.code === 'LAYDOWN' || p.code === 'DELIVERY_HOLDING' || p.code === 'STORAGE');
  const occupied = placements.reduce((sum, p) => sum + p.areaSquareMetres, 0);

  const welfareWalk = welfare?.metresToWorkFace ?? 0;
  const deliveryRun = laydown?.metresToGate ?? 0;
  const remaining = Math.round((geo.area(input.boundary) - occupied) * 100) / 100;

  const score: ScenarioScore = {
    welfareWalkMetres: welfareWalk,
    deliveryRunMetres: deliveryRun,
    usableRemainingSquareMetres: remaining,
    // The daily travel, in metres, and nothing else.
    //
    // Free ground was previously credited at a tenth of a metre per square,
    // described as a tie-breaker. It was not one: on a two-hectare site that
    // term is about 1,840 against distance differences of around 16, so it
    // outweighed the thing it was meant to break ties in by a hundred to one,
    // and the score came out as an unreadable negative number. Ground that is
    // left over now breaks a tie and only a tie — see the sort in `planLayout`.
    weighted: Math.round((welfareWalk + deliveryRun) * 10) / 10,
  };

  const feasibility = couldNotPlace.length === 0 ? 'FEASIBLE' : 'INFEASIBLE';
  return {
    scenarioId: ulid(),
    strategy,
    label: definition.label,
    rationale: definition.rationale,
    feasibility,
    couldNotPlace,
    placements,
    score,
    explanation:
      feasibility === 'INFEASIBLE'
        ? `${couldNotPlace.length} area(s) would not fit on the ground left after the rest were placed: ${couldNotPlace.join(', ')}. ` +
          'Nothing has been shrunk to make it fit, because a compound sized to the space rather than the workforce is ' +
          'a compound that fails its first inspection.'
        : `Welfare is ${welfareWalk}m from the work face and the delivery run is ${deliveryRun}m from the gate — ` +
          `${score.weighted}m of travel paid every day — leaving ${remaining}m² of the site free. ${definition.rationale}`,
  };
}

/** Where this kind of area wants to be under this strategy, and why. */
function anchorFor(
  code: LogisticsElement,
  strategy: LayoutStrategy,
  input: Parameters<typeof planLayout>[1],
): { point: geo.Point; reason: string } {
  const peopleAreas: LogisticsElement[] = ['WELFARE', 'SITE_OFFICE', 'MUSTER_POINT'];
  const deliveryAreas: LogisticsElement[] = ['LAYDOWN', 'STORAGE', 'DELIVERY_HOLDING', 'WHEEL_WASH', 'WASTE'];

  if (strategy === 'COMPACT_COMPOUND') {
    // Everything pulls to one point between gate and face, which is what makes
    // the compound compact and the remaining ground one piece rather than three.
    const midpoint = { x: (input.gate.x + input.workFace.x) / 2, y: (input.gate.y + input.workFace.y) / 2 };
    return { point: midpoint, reason: 'Placed with the rest of the compound so the ground that is left is one usable piece.' };
  }

  if (peopleAreas.includes(code)) {
    return strategy === 'WELFARE_NEAR_WORK'
      ? { point: input.workFace, reason: 'Placed as close to the work face as the ground allows, so the walk is paid once rather than twice a day by everybody.' }
      : { point: input.gate, reason: 'Placed near the entrance, accepting a longer walk so the delivery run stays short.' };
  }

  if (deliveryAreas.includes(code)) {
    return strategy === 'SHORT_DELIVERY_RUN'
      ? { point: input.gate, reason: 'Placed nearest the gate, because every delivery on the job pays this distance.' }
      : { point: input.workFace, reason: 'Placed towards the work face so material is offloaded near where it is used.' };
  }

  if (code === 'PARKING') {
    return { point: input.gate, reason: 'Placed at the entrance so cars never enter the operational site.' };
  }

  return { point: input.gate, reason: 'Placed on the nearest usable ground to the entrance.' };
}

/**
 * Find ground for one area and return the rectangle that sits on it.
 *
 * A grid search over candidate centres, keeping the one nearest the anchor that
 * fits entirely inside the boundary and clear of everything already placed.
 * Deliberately a rectangle: a site cabin, a laydown and a parking bay are laid
 * out as rectangles on every real site, and a clever organic shape would be
 * unbuildable and unmeasurable.
 */
function place(requirement: AreaRequirement, boundary: geo.Ring, taken: geo.Ring[], anchor: geo.Point): geo.Ring | undefined {
  const aspect = requirement.maxAspect ?? 2;
  const width = Math.sqrt(requirement.squareMetres * aspect);
  const height = requirement.squareMetres / width;
  const box = geo.bounds(boundary);

  // A metre grid, capped so a very large site does not turn into a very long
  // loop. Two metres of placement precision is finer than a compound is ever
  // set out to.
  const stepX = Math.max(1, (box.maxX - box.minX) / 60);
  const stepY = Math.max(1, (box.maxY - box.minY) / 60);

  let best: { ring: geo.Ring; distance: number } | undefined;

  for (let cx = box.minX; cx <= box.maxX; cx += stepX) {
    for (let cy = box.minY; cy <= box.maxY; cy += stepY) {
      for (const [w, h] of [[width, height], [height, width]] as const) {
        const ring: geo.Ring = [
          { x: cx - w / 2, y: cy - h / 2 },
          { x: cx + w / 2, y: cy - h / 2 },
          { x: cx + w / 2, y: cy + h / 2 },
          { x: cx - w / 2, y: cy + h / 2 },
        ];

        // Entirely inside the site. Not mostly.
        const insideArea = geo.intersectionArea(ring, boundary);
        if (geo.area(ring) - insideArea > 1e-3) continue;

        // Clear of everything already placed, including the obstacles it started
        // with. Touching is allowed; overlapping is not.
        if (taken.some((other) => geo.intersectionArea(ring, other) > 1e-3)) continue;

        const distance = geo.distance({ x: cx, y: cy }, anchor);
        if (!best || distance < best.distance) best = { ring, distance };
      }
    }
  }

  return best?.ring;
}

/**
 * Adopt a scenario as the site layout.
 *
 * `A` on `LOOKAHEAD_CONSTRAINTS` — the construction manager or project manager,
 * the same authority that sets the spatial baseline, because this is the same
 * kind of act: it decides what the site is.
 */
export function adoptScenario(
  ctx: EngineContext,
  input: { modelId: string; scenario: LayoutScenario; reason: string },
): { layoutId: string; placements: number } {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'A');

  if (input.scenario.feasibility !== 'FEASIBLE') {
    throw new DomainError(
      'SCENARIO_INFEASIBLE',
      `This scenario could not place ${input.scenario.couldNotPlace.join(', ')}. Adopting it would make the missing ` +
        'areas somebody’s problem later, without a record of the decision to leave them out.',
    );
  }
  if (input.reason.trim().length < 10) {
    throw new DomainError('ADOPTION_REASON_REQUIRED', 'Say why this layout rather than the others');
  }

  const layoutId = ulid();
  write(ctx, {
    eventType: 'SITE_LAYOUT_ADOPTED',
    entity: { refType: 'SiteLayout', refId: layoutId },
    reason: input.reason,
    nextState: {
      id: layoutId,
      modelId: input.modelId,
      strategy: input.scenario.strategy,
      placements: input.scenario.placements,
      score: input.scenario.score,
      adoptedBy: ctx.auth.actorId,
      adoptedAt: new Date().toISOString(),
    },
  });

  return { layoutId, placements: input.scenario.placements.length };
}
