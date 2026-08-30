import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';

/**
 * Three minutes on site, and what may honestly be claimed afterwards.
 *
 * A construction manager walks an unfamiliar site with a phone. Three minutes
 * later the platform is expected to say what the constraints are, what the site
 * setup should be, and what has to happen next. The commercial proposition is
 * exactly that sentence, and the danger is exactly that sentence: a system that
 * produces a confident site layout from a three-minute walk, and does not say
 * how much of it is measured and how much is inference, is worse than one that
 * produces nothing. Somebody sets a compound out against it.
 *
 * So this module is built around the one rule both specifications call
 * non-negotiable: **nothing here is presented as survey grade, and the class of
 * the answer is derived from what was actually captured rather than declared by
 * whoever captured it.**
 *
 * ---
 *
 * ## What it does
 *
 * The three minutes are not continuous video. They are a timed protocol with
 * four stages, each with a purpose and a set of directions the coach gives:
 *
 *   0–30s    entrance, orientation, boundary
 *   30–90s   access, terrain, existing structures, obstructions
 *   90–150s  the areas the compound and logistics would occupy
 *   150–180s the constraints, spoken or marked by the manager
 *
 * The last thirty seconds are the valuable ones and the reason this vertical
 * needs no reconstruction to be useful. A constraint is not read out of pixels;
 * it is what the person standing there already knows — one entrance, deliveries
 * only after nine, the ground goes soft by the gate, that line is live. The
 * platform's job is to take those as **structured records with a life** rather
 * than a paragraph in a report, which is the same argument `sitevisit.ts` makes
 * about findings and the reason that module exists.
 *
 * ## What it refuses
 *
 * **The class is computed, never asserted.** `PROJECT_CONTROLLED` requires
 * control points on the record. `MEASURED_RECON` requires a device that
 * actually returned depth. A mission with neither is `CONCEPTUAL` however the
 * app asks to label it, and the brief says in words what that means: positions
 * are approximate, no dimension may be relied on, and nothing may be set out.
 *
 * **A stage not covered cannot be claimed.** If the walk never reached the
 * proposed compound area, the brief does not quietly present a compound
 * proposal with lower confidence — it names the stage as uncovered and says
 * which questions are therefore unanswered.
 *
 * **Every constraint carries a response.** This is the product rule: a report
 * that lists problems is a list of problems. Each constraint type maps to
 * practical responses that are ordinary construction practice, and a constraint
 * the platform has no response for is reported as exactly that rather than
 * dropped — because a silent omission reads as "nothing to do here".
 *
 * ---
 *
 * **What this deliberately does not do.** It does not reconstruct geometry, and
 * it does not draw the layout. `sitevisit.ts` already refuses to draw a
 * logistics plan without the geometry behind it, for the same reason, and that
 * decision stands until a reconstruction provider exists to supply it. What is
 * here is the half that never needed pixels: the protocol, the constraints, the
 * responses, the class, and the list of what the three minutes could not settle.
 */

// --- The protocol ------------------------------------------------------------

export type CaptureStage = {
  key: 'ORIENTATION' | 'SITE_CONTEXT' | 'PROPOSED_AREAS' | 'CONSTRAINTS';
  fromSecond: number;
  toSecond: number;
  purpose: string;
  /** What the coach says. Published by the server so the app holds no rule of its own. */
  directions: string[];
  /** What is unanswerable if this stage is skipped. Used by the gap register. */
  unansweredIfSkipped: string;
};

/**
 * The three minutes, as a published contract.
 *
 * On the server because `frontend/app.js` fetches the permission matrix and
 * phase gates rather than duplicating them, and a capture protocol is the same
 * kind of thing: a rule about how the work is done. An app that carried its own
 * copy would drift from the one the brief is scored against.
 */
export const CAPTURE_PROTOCOL: CaptureStage[] = [
  {
    key: 'ORIENTATION',
    fromSecond: 0,
    toSecond: 30,
    purpose: 'Fix where the site is, which way it faces, and where it ends.',
    directions: [
      'Stand at the main entrance and face into the site.',
      'Pan slowly across the full width of the access.',
      'Walk the first stretch of the boundary you can see.',
      'Confirm whether this boundary is fixed or assumed.',
    ],
    unansweredIfSkipped:
      'Where the site begins and ends. Without it every area below is positioned against nothing, and the boundary is ' +
      'what every offset, oversail and exclusion is measured from.',
  },
  {
    key: 'SITE_CONTEXT',
    fromSecond: 30,
    toSecond: 90,
    purpose: 'What is already there: access, ground, structures, obstructions.',
    directions: [
      'Walk the access route in from the gate.',
      'Capture the full road width, including the verge.',
      'Show any slope, standing water or made ground.',
      'Show the overhead obstruction and anything crossing the site.',
      'Capture existing structures and anything that has to stay.',
    ],
    unansweredIfSkipped:
      'What the site already contains. A setup designed without it will place something on top of an existing ' +
      'service, a retained tree or a live interface.',
  },
  {
    key: 'PROPOSED_AREAS',
    fromSecond: 90,
    toSecond: 150,
    purpose: 'The ground the compound, laydown, parking and plant would occupy.',
    directions: [
      'Walk to where you would put the compound and scan it.',
      'Show the area you would use for laydown.',
      'Show where deliveries would turn and unload.',
      'Show where the crane or plant would stand.',
      'Capture an alternative emergency access.',
    ],
    unansweredIfSkipped:
      'Whether the areas the setup depends on are usable at all. A layout proposed over ground nobody looked at is ' +
      'a drawing, not a plan.',
  },
  {
    key: 'CONSTRAINTS',
    fromSecond: 150,
    toSecond: 180,
    purpose: 'What the person standing there already knows and nothing can infer.',
    directions: [
      'State the expected peak workforce.',
      'State the delivery hours you are held to.',
      'Identify areas unavailable for construction, and when.',
      'Name anything live: services, neighbours, protected trees, watercourses.',
      'Say what you already know will be the hard one.',
    ],
    unansweredIfSkipped:
      'Everything that cannot be seen. Delivery hours, workforce numbers, a no-reversing policy and a neighbour ' +
      'agreement are invisible to any scan and decide most of the layout.',
  },
];

/**
 * The whole protocol, for a screen or an app that has to run it.
 *
 * The constraint catalogue ships with it rather than from a second endpoint,
 * because a device running the walk needs both in the same breath: the stages
 * to follow, and the list to pick from when it reaches the last thirty seconds.
 * The responses come too — the manager should see what the platform will
 * recommend at the moment they record the problem, not in a report later.
 */
export function captureProtocol(): {
  totalSeconds: number;
  stages: CaptureStage[];
  constraintTypes: Array<{ code: ConstraintType; label: string; responses: readonly string[] }>;
} {
  return {
    totalSeconds: 180,
    stages: CAPTURE_PROTOCOL,
    constraintTypes: (Object.keys(CONSTRAINT_TYPE) as ConstraintType[]).map((code) => ({
      code,
      label: CONSTRAINT_TYPE[code].label,
      responses: CONSTRAINT_TYPE[code].responses,
    })),
  };
}

// --- What the device could actually do ---------------------------------------

/**
 * Device tiers, and what each is honestly allowed to produce.
 *
 * Straight from the specification, and the reason the class below cannot be
 * asserted: a phone with no depth sensor did not measure anything, whatever the
 * mission was labelled.
 */
export const DEVICE_TIER = {
  LIDAR: { label: 'Depth or LiDAR capable', measures: true },
  VISUAL_INERTIAL: { label: 'Camera with tracked pose', measures: true },
  VIDEO_ONLY: { label: 'Video and location only', measures: false },
  SURVEY_ASSISTED: { label: 'Depth or pose, plus imported survey control', measures: true },
} as const;
export type DeviceTier = keyof typeof DEVICE_TIER;

/**
 * What the result may be called. Four classes, and the boundary between the
 * second and the third is the one that matters commercially: reconnaissance is
 * a decision aid, controlled is something a drawing can be built on.
 */
export const ACCURACY_CLASS = {
  CONCEPTUAL: {
    label: 'Conceptual',
    basis: 'Video and approximate location only.',
    mayClaim: 'Relative positions, sequence, and what was observed.',
    mayNotClaim: 'Any dimension, area, level or set-out. Nothing here may be scaled or built to.',
  },
  MEASURED_RECON: {
    label: 'Measured reconnaissance',
    basis: 'Device depth or tracked pose, with a stated accuracy.',
    mayClaim: 'Approximate dimensions and areas, sufficient to compare options and size a compound.',
    mayNotClaim: 'Set-out, levels for earthworks, or any dimension a permanent work is built to.',
  },
  PROJECT_CONTROLLED: {
    label: 'Project controlled',
    basis: 'Registered against verified survey control points, with stated residuals.',
    mayClaim: 'Dimensions and positions in project coordinates, within the stated residual.',
    mayNotClaim: 'Safety-critical set-out without competent survey and design verification.',
  },
  APPROVED_BASELINE: {
    label: 'Approved construction baseline',
    basis: 'Controlled, and authorised by competent project personnel.',
    mayClaim: 'The agreed site baseline, against which later scans are compared.',
    mayNotClaim: 'Anything the approval was expressly conditioned against.',
  },
} as const;
export type AccuracyClass = keyof typeof ACCURACY_CLASS;

// --- Constraints -------------------------------------------------------------

/**
 * What a construction manager says in the last thirty seconds.
 *
 * A closed list, because a free-text constraint is a note and this register
 * exists to make each one actionable. Every entry carries the practical
 * responses that are ordinary practice against it — that is the product rule,
 * and the reason this is a rulepack rather than a prompt: the answer to a
 * narrow entrance does not vary by site, and a model asked to invent one would
 * sometimes invent a wrong one.
 */
export const CONSTRAINT_TYPE = {
  SINGLE_ENTRANCE: {
    label: 'Only one available entrance',
    responses: [
      'Timed delivery booking so arrivals do not queue on the public highway',
      'An external holding area off site, with a call-forward system',
      'Smaller vehicles on a higher frequency where the gate cannot be widened',
    ],
  },
  NARROW_ENTRANCE: {
    label: 'Entrance too narrow for the design vehicle',
    responses: [
      'Widen the gate opening and set the hoarding back to suit the swept path',
      'Timed deliveries so a single vehicle occupies the entrance at a time',
      'Smaller vehicles, priced into the preliminaries rather than discovered on site',
    ],
  },
  INSUFFICIENT_TURNING: {
    label: 'Insufficient turning or manoeuvring space',
    responses: [
      'A one-way route through the site so nothing has to turn',
      'An external holding area and a revised unloading position',
      'A banksman-controlled turning head sized to the design vehicle',
    ],
  },
  RESTRICTED_DELIVERY_HOURS: {
    label: 'Restricted delivery hours',
    responses: [
      'Delivery booking against the permitted window, with the window on the traffic plan',
      'Consolidation off site so fewer vehicles arrive inside the window',
      'Sequence the works so the deliveries that cannot move are the ones inside it',
    ],
  },
  WEAK_GROUND: {
    label: 'Weak or waterlogged ground',
    responses: [
      'Geotextile and a temporary stone platform to the areas that carry plant',
      'A load restriction on the affected area, stated on the layout',
      'Move the laydown to firmer ground and accept the longer haul',
    ],
  },
  OVERHEAD_LINES: {
    label: 'Overhead power lines',
    responses: [
      'An exclusion zone to the distance the network operator states, not one derived from the voltage',
      'Goalposts and height restriction at every crossing point',
      'Reroute traffic clear of the line and control the remaining crossings by permit',
    ],
  },
  UNDERGROUND_SERVICES: {
    label: 'Underground services',
    responses: [
      'Trial holes before anything is founded or excavated in the area',
      'A permit-to-dig regime with the drawings and the scan at the point of work',
      'Move the compound clear of the corridor rather than build over it',
    ],
  },
  PROTECTED_TREES: {
    label: 'Protected trees or root protection areas',
    responses: [
      'Protective fencing to the root protection area before any other work starts',
      'A logistics route that does not cross the RPA, even temporarily',
      'Ground protection where a crossing is unavoidable, agreed with the arboriculturalist',
    ],
  },
  WATERCOURSE: {
    label: 'Watercourse or drainage receptor',
    responses: [
      'A buffer zone with no storage, refuelling or washout inside it',
      'Spill response equipment at the point of risk, not in the office',
      'A washout and silt management position that discharges nowhere near it',
    ],
  },
  NEIGHBOURING_PROPERTY: {
    label: 'Neighbouring property or interface',
    responses: [
      'Agree oversail and access in writing before the crane or scaffold is designed around it',
      'A monitoring regime where the works are close enough to affect them',
      'A single named contact and a published complaints route',
    ],
  },
  NOISE_DUST_RECEPTOR: {
    label: 'Noise or dust sensitive receptor',
    responses: [
      'Position the noisiest operations at the far side of the site from the receptor',
      'Monitoring at the boundary with a threshold that triggers a change, not a report',
      'Restrict the hours of the specific operations rather than the whole site',
    ],
  },
  LIMITED_CRANE_POSITION: {
    label: 'Limited crane positioning',
    responses: [
      'An alternative position that keeps the envelope inside the boundary',
      'A smaller crane, or a mobile crane strategy on a lift-by-lift basis',
      'Change the sequence so the heavy lifts happen while the space still exists',
    ],
  },
  NO_REVERSING: {
    label: 'No reversing policy',
    responses: [
      'A one-way circulation route with a turning head at the far end',
      'Drive-through loading bays so nothing reverses to unload',
      'Where a reverse is unavoidable, a designated banksman position on the layout',
    ],
  },
  MAX_WORKFORCE: {
    label: 'Maximum workforce',
    responses: [
      'Size welfare, parking and canteen to the peak rather than the average',
      'Phase the accommodation so it grows with the workforce instead of standing empty',
      'Check the peak against the induction and muster capacity, which is what fails first',
    ],
  },
  WELFARE_CAPACITY: {
    label: 'Required office and welfare capacity',
    responses: [
      'Schedule the units against the peak workforce and publish the schedule with the layout',
      'Satellite welfare where the working face is too far from the compound',
      'Relocate the compound rather than accept a walk nobody will make',
    ],
  },
  WELFARE_DISTANCE: {
    label: 'Welfare too distant from the work face',
    responses: [
      'Relocate the compound closer to the sustained working area',
      'Satellite welfare units at the far face, serviced from the main compound',
      'Accept the distance and price the lost time honestly into the preliminaries',
    ],
  },
  LIMITED_LAYDOWN: {
    label: 'Limited laydown capacity',
    responses: [
      'Just-in-time delivery against the programme, with a booking system that enforces it',
      'Vertical storage and racking where the footprint cannot grow',
      'Phased zone relocation as the permanent works release ground',
    ],
  },
  VEHICLE_PEDESTRIAN_CONFLICT: {
    label: 'Vehicle and pedestrian conflict',
    responses: [
      'A segregated walkway with a physical barrier, not a painted line',
      'Controlled crossings at the points people actually cross',
      'Separate the gates so people and vehicles do not share an entrance',
    ],
  },
  EMERGENCY_ACCESS: {
    label: 'Emergency vehicle access',
    responses: [
      'A protected minimum-clearance corridor kept clear in every phase, not just the first',
      'Reconfigure storage that encroaches on the route rather than accept a pinch point',
      'A second egress where a single route can be blocked by one incident',
    ],
  },
  PHASED_UNAVAILABILITY: {
    label: 'Areas becoming unavailable in later phases',
    responses: [
      'A time-phased layout with the relocation planned and priced, not discovered',
      'Put nothing permanent on ground the permanent works will need',
      'Book the relocation into the programme as an activity with a duration',
    ],
  },
  CONSTRUCTION_SEQUENCE: {
    label: 'Permanent works construction sequence',
    responses: [
      'Release and reclaim logistics ground in step with the sequence',
      'Check the crane and access strategy survives each phase, not only the first',
      'Plan demobilisation from the start so the last works are not landlocked',
    ],
  },
} as const;
export type ConstraintType = keyof typeof CONSTRAINT_TYPE;

/**
 * Hard or optimisable, in the specification's own words.
 *
 * The distinction is load bearing: a hard constraint cannot be traded away by a
 * layout that scores better, and a preference presented as hard makes every
 * option look infeasible.
 */
export type ConstraintSeverity = 'HARD' | 'OPTIMISABLE';

/** Where the platform got this, which decides how much weight it carries. */
export type ConstraintSource = 'SPOKEN' | 'MARKED' | 'DRAWING' | 'CONSENT' | 'THIRD_PARTY';

export type RecordedConstraint = {
  constraintId: string;
  type: ConstraintType;
  description: string;
  severity: ConstraintSeverity;
  source: ConstraintSource;
  /** Where it applies, in the manager's words. Not geometry — there is none yet. */
  locationNote?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  /** What would settle it. A constraint nobody can verify stays an assumption. */
  requiredVerification?: string;
  responsibleParty?: string;
  recordedBy: string;
  recordedAt: string;
};

// --- The mission -------------------------------------------------------------

type MissionState = {
  id: string;
  purpose: string;
  deviceTier: DeviceTier;
  stagesCovered: CaptureStage['key'][];
  controlPoints: number;
  capturedSeconds: number;
  constraints: RecordedConstraint[];
  approved?: { by: string; at: string; conditions?: string };
  startedBy: string;
  startedAt: string;
  completedAt?: string;
};

export const MISSION_PURPOSE = ['RECON', 'TENDER_LOGISTICS', 'BASELINE', 'PROGRESS_DELTA', 'INCIDENT_REPLAN'] as const;
export type MissionPurpose = (typeof MISSION_PURPOSE)[number];

/**
 * Open a capture mission.
 *
 * `C` on `FIELD_EXECUTION` — the construction manager, site manager and
 * supervisor, which is who holds a phone on a site. The device tier is declared
 * here and never again, because it is a fact about the hardware rather than a
 * quality anybody may improve later by asserting it.
 */
export function startMission(
  ctx: EngineContext,
  input: { purpose: MissionPurpose; deviceTier: DeviceTier },
): { missionId: string; protocol: ReturnType<typeof captureProtocol> } {
  authorise(ctx, 'FIELD_EXECUTION', 'C');

  const missionId = ulid();
  write(ctx, {
    eventType: 'CAPTURE_MISSION_STARTED',
    entity: { refType: 'CaptureMission', refId: missionId },
    nextState: {
      id: missionId,
      purpose: input.purpose,
      deviceTier: input.deviceTier,
      stagesCovered: [],
      controlPoints: 0,
      capturedSeconds: 0,
      constraints: [],
      startedBy: ctx.auth.actorId,
      startedAt: new Date().toISOString(),
    } satisfies MissionState,
  });

  return { missionId, protocol: captureProtocol() };
}

/**
 * Record what the manager said or marked in the last thirty seconds.
 *
 * `C` on `LOOKAHEAD_CONSTRAINTS`, because that is what this is — the same
 * register, reached from the site rather than from a desk. A hard constraint
 * with nothing that would verify it is refused: "the ground is weak" with no
 * way to settle it is an opinion that will later be treated as a fact, and the
 * moment to name the trial hole is while somebody is standing on the ground.
 */
export function recordConstraint(
  ctx: EngineContext,
  input: {
    missionId: string;
    type: ConstraintType;
    description: string;
    severity: ConstraintSeverity;
    source: ConstraintSource;
    locationNote?: string;
    effectiveFrom?: string;
    effectiveTo?: string;
    requiredVerification?: string;
    responsibleParty?: string;
  },
): { constraintId: string; responses: readonly string[] } {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'C');

  const record = requireMission(ctx, input.missionId);
  if (record.state.completedAt) {
    throw new DomainError(
      'MISSION_ALREADY_COMPLETE',
      'This mission is closed. A constraint remembered afterwards belongs on the constraints register with its own ' +
        'date, not backdated into a capture that did not record it.',
    );
  }
  if (input.description.trim().length < 8) {
    throw new DomainError('CONSTRAINT_DESCRIPTION_REQUIRED', 'A constraint needs saying in words somebody else can act on');
  }
  if (input.severity === 'HARD' && !input.requiredVerification?.trim()) {
    throw new DomainError(
      'CONSTRAINT_VERIFICATION_REQUIRED',
      'A hard constraint stops a layout being built. Name what would verify it — a trial hole, a service drawing, ' +
        'the operator’s stated clearance — while somebody is still standing on the ground to see it.',
    );
  }

  const constraintId = ulid();
  const constraint: RecordedConstraint = {
    constraintId,
    type: input.type,
    description: input.description,
    severity: input.severity,
    source: input.source,
    ...(input.locationNote ? { locationNote: input.locationNote } : {}),
    ...(input.effectiveFrom ? { effectiveFrom: input.effectiveFrom } : {}),
    ...(input.effectiveTo ? { effectiveTo: input.effectiveTo } : {}),
    ...(input.requiredVerification ? { requiredVerification: input.requiredVerification } : {}),
    ...(input.responsibleParty ? { responsibleParty: input.responsibleParty } : {}),
    recordedBy: ctx.auth.actorId,
    recordedAt: new Date().toISOString(),
  };

  write(ctx, {
    eventType: 'SITE_CONSTRAINT_RECORDED',
    entity: { refType: 'CaptureMission', refId: input.missionId },
    reason: `${CONSTRAINT_TYPE[input.type].label}: ${input.description}`,
    nextState: { ...record.state, constraints: [...record.state.constraints, constraint] },
  });

  return { constraintId, responses: CONSTRAINT_TYPE[input.type].responses };
}

/**
 * Close the three minutes.
 *
 * The stages actually covered are recorded rather than assumed complete, and
 * that single field is what stops the brief claiming an area nobody walked.
 * `capturedSeconds` is capped at the protocol length: a session that ran longer
 * did not follow this protocol, and quietly accepting it would make the
 * three-minute constraint decorative.
 */
export function completeMission(
  ctx: EngineContext,
  input: { missionId: string; stagesCovered: CaptureStage['key'][]; capturedSeconds: number; controlPoints?: number },
): { missionId: string; accuracyClass: AccuracyClass } {
  authorise(ctx, 'FIELD_EXECUTION', 'U');

  const record = requireMission(ctx, input.missionId);
  if (record.state.completedAt) throw new DomainError('MISSION_ALREADY_COMPLETE', 'This mission is already closed');

  if (input.capturedSeconds <= 0 || input.capturedSeconds > 180) {
    throw new DomainError(
      'CAPTURE_DURATION_INVALID',
      'A capture runs from one second to a hundred and eighty. A longer session is a different protocol and the ' +
        'brief below is scored against this one.',
    );
  }
  if (input.stagesCovered.length === 0) {
    throw new DomainError('NO_STAGE_COVERED', 'A mission that covered no stage of the protocol captured nothing');
  }

  const known = new Set(CAPTURE_PROTOCOL.map((stage) => stage.key));
  for (const stage of input.stagesCovered) {
    if (!known.has(stage)) throw new DomainError('UNKNOWN_CAPTURE_STAGE', `${stage} is not a stage of the capture protocol`);
  }

  const controlPoints = input.controlPoints ?? 0;
  const next: MissionState = {
    ...record.state,
    stagesCovered: [...new Set(input.stagesCovered)],
    capturedSeconds: input.capturedSeconds,
    controlPoints,
    completedAt: new Date().toISOString(),
  };

  write(ctx, {
    eventType: 'CAPTURE_MISSION_COMPLETED',
    entity: { refType: 'CaptureMission', refId: input.missionId },
    nextState: next,
  });

  return { missionId: input.missionId, accuracyClass: classify(next) };
}

/**
 * Authorise the result as the site baseline.
 *
 * `A` on `LOOKAHEAD_CONSTRAINTS` — the construction manager or project manager,
 * which is what the specification's authority matrix says and what the role
 * matrix already grants. Refused unless the mission is already controlled: a
 * baseline is the thing later scans are compared against, and approving a
 * conceptual walk as one would make every later delta meaningless.
 */
export function approveAsBaseline(
  ctx: EngineContext,
  input: { missionId: string; conditions?: string },
): { missionId: string; accuracyClass: AccuracyClass } {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'A');

  const record = requireMission(ctx, input.missionId);
  if (!record.state.completedAt) throw new DomainError('MISSION_NOT_COMPLETE', 'A mission still running cannot be a baseline');

  const current = classify(record.state);
  if (current !== 'PROJECT_CONTROLLED') {
    throw new DomainError(
      'BASELINE_REQUIRES_CONTROL',
      `This capture is ${ACCURACY_CLASS[current].label.toLowerCase()}: ${ACCURACY_CLASS[current].basis} A baseline is ` +
        'what every later scan is measured against, so it has to be registered against verified survey control first. ' +
        'Approving this one would make every future change report a comparison with a guess.',
    );
  }

  const next: MissionState = {
    ...record.state,
    approved: {
      by: ctx.auth.actorId,
      at: new Date().toISOString(),
      ...(input.conditions ? { conditions: input.conditions } : {}),
    },
  };

  write(ctx, {
    eventType: 'SPATIAL_BASELINE_SET',
    entity: { refType: 'CaptureMission', refId: input.missionId },
    ...(input.conditions ? { reason: input.conditions } : {}),
    nextState: next,
  });

  return { missionId: input.missionId, accuracyClass: classify(next) };
}

/**
 * What the capture may be called.
 *
 * Derived from the record every time it is asked, and never stored as a field
 * anybody could set. Control points beat device tier: a phone with depth and
 * three verified markers is controlled; the same phone with none is
 * reconnaissance, and a video-only device is conceptual whatever else is true.
 */
export function classify(state: MissionState): AccuracyClass {
  if (state.approved) return 'APPROVED_BASELINE';
  const measures = DEVICE_TIER[state.deviceTier].measures;
  // Three is the smallest number that gives a transform and a residual to
  // report against it. Two would fit without any redundancy, which is a
  // transform with nothing to check it.
  if (measures && state.controlPoints >= 3) return 'PROJECT_CONTROLLED';
  if (measures) return 'MEASURED_RECON';
  return 'CONCEPTUAL';
}

// --- The brief ---------------------------------------------------------------

export type ConstraintWithResponse = {
  constraint: RecordedConstraint;
  typeLabel: string;
  /** Ordinary practice against this constraint. Never empty — see `NO_RESPONSE_HELD`. */
  responses: readonly string[];
};

export type CoverageGap = {
  stage: CaptureStage['key'];
  purpose: string;
  unanswered: string;
  /** The directions to give on the next burst, so the gap closes rather than persists. */
  nextBurstDirections: string[];
};

export type VerificationItem = {
  constraintId: string;
  subject: string;
  verification: string;
  responsibleParty: string;
  severity: ConstraintSeverity;
};

export type CaptureBrief = {
  missionId: string;
  purpose: string;
  accuracyClass: AccuracyClass;
  classBasis: string;
  mayClaim: string;
  mayNotClaim: string;
  capturedSeconds: number;
  stagesCovered: CaptureStage['key'][];
  /** Every constraint, each with what to do about it. */
  constraints: ConstraintWithResponse[];
  hardConstraints: number;
  /** Stages the walk never reached, and what is therefore unanswered. */
  gaps: CoverageGap[];
  /** What has to be settled before any of this is relied on. */
  verificationSchedule: VerificationItem[];
  /** Named rather than implied: what this module does not produce. */
  notProduced: string[];
  summary: string;
};

/**
 * The thing the manager reads walking back to the van.
 *
 * Ordered deliberately: what this is and is not first, then the constraints
 * with their responses, then what the three minutes could not answer. A report
 * that leads with findings and buries its accuracy class is read as a survey.
 */
export function captureBrief(ctx: EngineContext, missionId: string): CaptureBrief {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'R');

  const record = requireMission(ctx, missionId);
  const state = record.state;
  const accuracyClass = classify(state);
  const grade = ACCURACY_CLASS[accuracyClass];

  const constraints: ConstraintWithResponse[] = state.constraints.map((constraint) => ({
    constraint,
    typeLabel: CONSTRAINT_TYPE[constraint.type].label,
    responses: CONSTRAINT_TYPE[constraint.type].responses,
  }));

  const covered = new Set(state.stagesCovered);
  const gaps: CoverageGap[] = CAPTURE_PROTOCOL.filter((stage) => !covered.has(stage.key)).map((stage) => ({
    stage: stage.key,
    purpose: stage.purpose,
    unanswered: stage.unansweredIfSkipped,
    nextBurstDirections: stage.directions,
  }));

  const verificationSchedule: VerificationItem[] = state.constraints
    .filter((constraint) => constraint.requiredVerification)
    .map((constraint) => ({
      constraintId: constraint.constraintId,
      subject: `${CONSTRAINT_TYPE[constraint.type].label} — ${constraint.description}`,
      verification: constraint.requiredVerification!,
      responsibleParty: constraint.responsibleParty ?? 'Unassigned',
      severity: constraint.severity,
    }));

  const hardConstraints = state.constraints.filter((constraint) => constraint.severity === 'HARD').length;

  return {
    missionId,
    purpose: String(state.purpose),
    accuracyClass,
    classBasis: grade.basis,
    mayClaim: grade.mayClaim,
    mayNotClaim: grade.mayNotClaim,
    capturedSeconds: state.capturedSeconds,
    stagesCovered: state.stagesCovered,
    constraints,
    hardConstraints,
    gaps,
    verificationSchedule,
    // Stated so the absence is not read as a result. A brief that simply did
    // not mention the site model would be taken to mean there wasn't one worth
    // showing, rather than that the platform does not make one.
    notProduced: [
      'No 3D model, orthomosaic or dimensioned drawing is produced here. Reconstruction is a separate provider and ' +
        'none is connected, so nothing below was measured from geometry.',
      'No site layout is positioned. The logistics plan records elements, their stated dimensions and the checks ' +
        'arithmetic can settle; it does not place them on ground it cannot see.',
    ],
    summary:
      `${grade.label}: ${grade.basis} ${state.capturedSeconds}s captured across ${state.stagesCovered.length} of ` +
      `${CAPTURE_PROTOCOL.length} stages. ${state.constraints.length} constraint(s) recorded, ${hardConstraints} hard. ` +
      `${gaps.length === 0 ? 'The protocol was covered in full.' : `${gaps.length} stage(s) were not reached and are listed with the directions to close them.`}` +
      `${verificationSchedule.length > 0 ? ` ${verificationSchedule.length} thing(s) need verifying before this is relied on.` : ''}`,
  };
}

/** Every mission on the project, newest first. */
export function missionBoard(
  ctx: EngineContext,
): Array<{ missionId: string; purpose: string; accuracyClass: AccuracyClass; constraints: number; startedAt: string }> {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'R');

  return ctx.ledger
    .list(ctx.projectId, 'CaptureMission')
    .map((record) => {
      const state = record.state as unknown as MissionState;
      return {
        missionId: state.id,
        purpose: String(state.purpose),
        accuracyClass: classify(state),
        constraints: state.constraints.length,
        startedAt: state.startedAt,
      };
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function requireMission(ctx: EngineContext, missionId: string): { refId: string; state: MissionState } {
  const record = ctx.ledger.get({ refType: 'CaptureMission', refId: missionId });
  if (!record || record.tenantId !== ctx.tenantId) {
    throw new DomainError('CAPTURE_MISSION_NOT_FOUND', `No capture mission ${missionId}`, 404);
  }
  return { refId: record.refId, state: record.state as unknown as MissionState };
}
