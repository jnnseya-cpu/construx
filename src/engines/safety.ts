import { hashEvidence } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, runAI, write, type EngineContext } from './context.ts';
import { contingencyRequirement, forecastSafety, scoreRisk, type RiskInput, type SafetySignal } from './maths/risk.ts';

/**
 * Engine D — Risk, Safety & Compliance.
 *
 * Two jobs: quantify project risk in money and days so contingency can be
 * defended, and predict safety exposure from leading indicators so controls
 * land before an incident rather than after one.
 */

export function registerRisk(
  ctx: EngineContext,
  input: RiskInput & { projectValueMinor: number; projectDurationDays: number },
): { riskId: string; scored: ReturnType<typeof scoreRisk> } {
  authorise(ctx, 'RISK_REGISTER', 'C', { lifecyclePhase: currentPhase(ctx) });

  const scored = scoreRisk(input, input.projectValueMinor, input.projectDurationDays);
  const riskId = input.id || ulid();

  write(ctx, {
    eventType: 'RISK_REGISTERED',
    entity: { refType: 'RiskRegisterItem', refId: riskId },
    nextState: {
      ...scored,
      id: riskId,
      projectId: ctx.projectId,
      status: 'OPEN',
      registeredAt: new Date().toISOString(),
      registeredBy: ctx.auth.actorId,
    },
  });

  return { riskId, scored };
}

/** Portfolio-defensible contingency: expected value plus a P80 tail figure. */
export function assessContingency(ctx: EngineContext): ReturnType<typeof contingencyRequirement> {
  authorise(ctx, 'RISK_REGISTER', 'R');

  const risks = ctx.ledger
    .list(ctx.projectId, 'RiskRegisterItem')
    .filter((r) => r.state.status === 'OPEN')
    .map((r) => r.state as unknown as ReturnType<typeof scoreRisk>);

  return contingencyRequirement(risks);
}

export type MethodStep = {
  sequence: number;
  description: string;
  hazards: string[];
  controls: string[];
  ppe: string[];
  plant: string[];
  competencyRequired: string[];
};

/**
 * Guided RAMS production. Deterministic multi-step assembly against a hazard
 * library, not freeform generation — a method statement that varies run to run
 * is not a control document.
 */
export async function draftRAMS(
  ctx: EngineContext,
  input: {
    workPackageId: string;
    activityDescription: string;
    location: string;
    steps: Array<{ description: string; activityType: string }>;
    companyHazardLibrary?: Array<{ activityType: string; hazards: string[]; controls: string[] }>;
  },
): Promise<{ ramsId: string; steps: MethodStep[]; acuConsumed: number }> {
  authorise(ctx, 'SAFETY_RAMS', 'C', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'SAFETY_L2' });

  // Platform hazard knowledge, fused with the company's own library. Company
  // entries take precedence — they encode that contractor's specific controls.
  const platformLibrary: Record<string, { hazards: string[]; controls: string[]; ppe: string[]; plant: string[]; competency: string[] }> = {
    EXCAVATION: {
      hazards: ['Collapse of excavation', 'Buried services', 'Falls into excavation', 'Plant/pedestrian interface'],
      controls: ['Support system designed by a temporary works engineer', 'CAT scan and trial holes before breaking ground', 'Edge protection and barriers', 'Segregated pedestrian routes and banksman'],
      ppe: ['Hard hat', 'Hi-vis', 'Safety boots', 'Gloves', 'Eye protection'],
      plant: ['360 excavator', 'Trench support system', 'CAT and Genny'],
      competency: ['CPCS excavator operator', 'Confined space (if applicable)', 'Temporary works supervisor'],
    },
    WORKING_AT_HEIGHT: {
      hazards: ['Falls from height', 'Falling objects', 'Fragile surfaces', 'Adverse weather'],
      controls: ['Edge protection or fall arrest', 'Exclusion zones below', 'Inspected access equipment', 'Wind speed limits with stop-work trigger'],
      ppe: ['Hard hat with chinstrap', 'Harness and lanyard', 'Hi-vis', 'Safety boots'],
      plant: ['MEWP', 'Scaffold', 'Podium steps'],
      competency: ['IPAF for MEWP', 'Harness user training', 'Scaffold inspection'],
    },
    LIFTING: {
      hazards: ['Load failure', 'Crane instability', 'Struck by load', 'Overhead services'],
      controls: ['Lift plan by an appointed person', 'Certified lifting accessories', 'Exclusion zone and banksman', 'Wind and visibility limits'],
      ppe: ['Hard hat', 'Hi-vis', 'Safety boots', 'Gloves'],
      plant: ['Mobile crane', 'Certified slings and shackles'],
      competency: ['Appointed person', 'CPCS crane operator', 'Slinger/signaller'],
    },
    HOT_WORKS: {
      hazards: ['Fire', 'Fume inhalation', 'Burns', 'Explosion in confined areas'],
      controls: ['Hot works permit', 'Fire watch during and 60 minutes after', 'Combustibles removed or protected', 'Local exhaust ventilation'],
      ppe: ['Welding mask', 'Fire-retardant overalls', 'Gauntlets', 'Respiratory protection'],
      plant: ['Welding set', 'Fire extinguishers', 'Fume extraction'],
      competency: ['Hot works permit holder', 'Welding qualification'],
    },
    CONFINED_SPACE: {
      hazards: ['Oxygen deficiency', 'Toxic atmosphere', 'Engulfment', 'Difficult rescue'],
      controls: ['Confined space permit', 'Continuous gas monitoring', 'Top man and rescue plan', 'Forced ventilation'],
      ppe: ['Gas monitor', 'Escape set', 'Harness with retrieval line'],
      plant: ['Tripod and winch', 'Ventilation fan', 'Gas detection'],
      competency: ['Confined space entry (medium/high risk)', 'Emergency rescue'],
    },
    GENERAL: {
      hazards: ['Manual handling', 'Slips, trips and falls', 'Noise', 'Dust'],
      controls: ['Mechanical handling aids', 'Housekeeping regime', 'Noise assessment and zoning', 'On-tool extraction and water suppression'],
      ppe: ['Hard hat', 'Hi-vis', 'Safety boots', 'Gloves', 'Hearing protection'],
      plant: ['Hand tools', 'Extraction unit'],
      competency: ['CSCS card', 'Task-specific toolbox talk'],
    },
  };

  const companyByType = new Map((input.companyHazardLibrary ?? []).map((e) => [e.activityType, e]));

  const steps: MethodStep[] = input.steps.map((step, index) => {
    const platform = platformLibrary[step.activityType] ?? platformLibrary.GENERAL;
    const company = companyByType.get(step.activityType);
    return {
      sequence: index + 1,
      description: step.description,
      hazards: [...new Set([...(company?.hazards ?? []), ...(platform?.hazards ?? [])])],
      controls: [...new Set([...(company?.controls ?? []), ...(platform?.controls ?? [])])],
      ppe: platform?.ppe ?? [],
      plant: platform?.plant ?? [],
      competencyRequired: platform?.competency ?? [],
    };
  });

  const ramsId = ulid();

  const result = await runAI(ctx, {
    engine: 'RISK_SAFETY',
    taskType: 'rams_drafting',
    capability: 'REASONING',
    inputRefs: [{ refType: 'WorkPackage', refId: input.workPackageId }],
    request: {
      task: 'Review the assembled method steps for residual hazards and sequencing conflicts',
      payload: { activity: input.activityDescription, location: input.location, steps },
    },
    toWrites: (output) => [
      {
        eventType: 'RAMS_DRAFTED',
        entity: { refType: 'RAMS', refId: ramsId },
        nextState: {
          id: ramsId,
          projectId: ctx.projectId,
          workPackageId: input.workPackageId,
          activityDescription: input.activityDescription,
          location: input.location,
          steps,
          // Aggregated resource requirements: what the site must have available
          // before this method statement can be worked to.
          ppeSchedule: [...new Set(steps.flatMap((s) => s.ppe))],
          plantSchedule: [...new Set(steps.flatMap((s) => s.plant))],
          competencySchedule: [...new Set(steps.flatMap((s) => s.competencyRequired))],
          reviewNotes: String(output.narrative ?? ''),
          status: 'DRAFT',
          version: 1,
          draftedAt: new Date().toISOString(),
        },
      },
    ],
  });

  return { ramsId, steps, acuConsumed: result.acuConsumed };
}

/** Approve a RAMS. Only the safety function can do this, and never its own author's work unreviewed. */
export function approveRAMS(ctx: EngineContext, ramsId: string, reviewComments: string): void {
  authorise(ctx, 'SAFETY_RAMS', 'A', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'SAFETY_L2' });

  const rams = ctx.ledger.require({ refType: 'RAMS', refId: ramsId });
  if (rams.state.status === 'APPROVED') throw new DomainError('RAMS_ALREADY_APPROVED', 'This RAMS is already approved');

  const evidence = registerEvidence(ctx, {
    type: 'RAMS_REVIEW',
    hash: hashEvidence(`${ramsId}:${reviewComments}:${ctx.auth.actorId}`),
    description: `RAMS review and approval: ${reviewComments}`,
    linkedEntities: [{ refType: 'RAMS', refId: ramsId }],
  });

  write(ctx, {
    eventType: 'RAMS_APPROVED',
    entity: { refType: 'RAMS', refId: ramsId },
    nextState: {
      ...rams.state,
      status: 'APPROVED',
      reviewComments,
      approvedAt: new Date().toISOString(),
      approvedBy: ctx.auth.actorId,
      acknowledgements: [],
    },
    evidenceRefs: [evidence],
  });
}

/** Workforce acknowledgement. Work must not start until the briefing is recorded. */
export function acknowledgeRAMS(ctx: EngineContext, ramsId: string, operativeIds: string[], briefingHash: string): void {
  authorise(ctx, 'SAFETY_RAMS', 'U', { dataSensitivity: 'SAFETY_L2' });

  const rams = ctx.ledger.require({ refType: 'RAMS', refId: ramsId });
  if (rams.state.status !== 'APPROVED') {
    throw new DomainError('RAMS_NOT_APPROVED', 'A RAMS must be approved before it can be briefed out');
  }

  const evidence = registerEvidence(ctx, {
    type: 'RAMS_BRIEFING_RECORD',
    hash: briefingHash,
    description: `Briefing acknowledged by ${operativeIds.length} operative(s)`,
    linkedEntities: [{ refType: 'RAMS', refId: ramsId }],
  });

  const existing = (rams.state.acknowledgements as string[] | undefined) ?? [];

  write(ctx, {
    eventType: 'RAMS_ACKNOWLEDGED',
    entity: { refType: 'RAMS', refId: ramsId },
    nextState: {
      ...rams.state,
      acknowledgements: [...new Set([...existing, ...operativeIds])],
      lastBriefedAt: new Date().toISOString(),
    },
    evidenceRefs: [evidence],
  });
}

/**
 * Safety observation from the field. Perception classifies the image; the
 * classification is advisory and a human owns the resulting action.
 */
export async function logSafetyObservation(
  ctx: EngineContext,
  input: {
    description: string;
    location: string;
    mediaHash: string;
    mediaUri?: string;
    observationType: 'UNSAFE_ACT' | 'UNSAFE_CONDITION' | 'NEAR_MISS' | 'GOOD_PRACTICE';
    reportedBy: string;
  },
): Promise<{ observationId: string; severity: string; acuConsumed: number }> {
  authorise(ctx, 'SAFETY_RAMS', 'C', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'SAFETY_L2' });

  const evidence = registerEvidence(ctx, {
    type: 'SAFETY_OBSERVATION_MEDIA',
    hash: input.mediaHash,
    uri: input.mediaUri,
    description: `Safety observation media: ${input.description}`,
  });

  const observationId = ulid();

  const result = await runAI(ctx, {
    engine: 'RISK_SAFETY',
    taskType: 'hazard_classification',
    capability: 'PERCEPTION',
    inputRefs: [evidence],
    request: {
      task: 'Classify the hazard, assess severity and recommend immediate controls',
      payload: {
        description: input.description,
        location: input.location,
        observationType: input.observationType,
      },
    },
    toWrites: (output, confidence) => [
      {
        eventType: 'SAFETY_OBSERVATION_LOGGED',
        entity: { refType: 'SafetyObservation', refId: observationId },
        nextState: {
          id: observationId,
          projectId: ctx.projectId,
          description: input.description,
          location: input.location,
          observationType: input.observationType,
          severity: String(output.classification ?? 'MEDIUM'),
          classificationConfidence: confidence ?? 0.7,
          recommendedControls: String(output.narrative ?? ''),
          reportedBy: input.reportedBy,
          reportedAt: new Date().toISOString(),
          status: 'OPEN',
          // Classification never closes an observation; a person does.
          requiresHumanReview: true,
        },
        evidenceRefs: [evidence],
      },
    ],
  });

  return {
    observationId,
    severity: String(result.output.classification ?? 'MEDIUM'),
    acuConsumed: result.acuConsumed,
  };
}

/** Predictive safety forecast from leading indicators across the last 30 days. */
export async function forecastSafetyRisk(
  ctx: EngineContext,
  input: { headcount: number; highRiskActivitiesPlanned: number; adverseWeatherDays: number },
): Promise<{ forecastId: string; forecast: ReturnType<typeof forecastSafety>; acuConsumed: number }> {
  authorise(ctx, 'SAFETY_RAMS', 'X', { dataSensitivity: 'SAFETY_L2' });

  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const observations = ctx.ledger
    .list(ctx.projectId, 'SafetyObservation')
    .filter((o) => String(o.state.reportedAt) >= cutoff);

  const ramsList = ctx.ledger.list(ctx.projectId, 'RAMS').filter((r) => r.state.status === 'APPROVED');
  const acknowledged = ramsList.filter((r) => ((r.state.acknowledgements as string[] | undefined) ?? []).length > 0).length;

  const competencies = ctx.ledger.list(ctx.projectId, 'Competency');
  const inDate = competencies.filter((c) => String(c.state.expiresAt ?? '9999') > new Date().toISOString()).length;

  const signal: SafetySignal = {
    unsafeObservations: observations.filter(
      (o) => o.state.observationType === 'UNSAFE_ACT' || o.state.observationType === 'UNSAFE_CONDITION',
    ).length,
    nearMisses: observations.filter((o) => o.state.observationType === 'NEAR_MISS').length,
    incidents: ctx.ledger.list(ctx.projectId, 'Incident').filter((i) => String(i.state.occurredAt ?? '') >= cutoff).length,
    headcount: input.headcount,
    ramsAcknowledgementRate: ramsList.length === 0 ? 1 : acknowledged / ramsList.length,
    competencyComplianceRate: competencies.length === 0 ? 1 : inDate / competencies.length,
    highRiskActivitiesPlanned: input.highRiskActivitiesPlanned,
    adverseWeatherDays: input.adverseWeatherDays,
  };

  const forecast = forecastSafety(signal);
  const forecastId = ulid();

  const result = await runAI(ctx, {
    engine: 'RISK_SAFETY',
    taskType: 'safety_forecast',
    capability: 'REASONING',
    inputRefs: [{ refType: 'Project', refId: ctx.projectId }],
    request: {
      task: 'Interpret the safety leading indicators and prioritise the recommended controls',
      payload: { signal, forecast },
    },
    toWrites: (output) => [
      {
        eventType: 'SAFETY_FORECAST_PRODUCED',
        entity: { refType: 'SafetyForecast', refId: forecastId },
        nextState: {
          ...forecast,
          id: forecastId,
          projectId: ctx.projectId,
          signal,
          narrative: String(output.narrative ?? ''),
          producedAt: new Date().toISOString(),
        },
      },
    ],
  });

  return { forecastId, forecast, acuConsumed: result.acuConsumed };
}

/** Competency and training register — the compliance half of workforce capability. */
export function recordCompetency(
  ctx: EngineContext,
  input: { operativeId: string; qualification: string; issuedAt: string; expiresAt: string; certificateHash: string },
): string {
  authorise(ctx, 'SAFETY_RAMS', 'C', { dataSensitivity: 'SAFETY_L2' });

  const evidence = registerEvidence(ctx, {
    type: 'COMPETENCY_CERTIFICATE',
    hash: input.certificateHash,
    description: `${input.qualification} for operative ${input.operativeId}`,
  });

  const id = ulid();
  write(ctx, {
    eventType: 'COMPETENCY_RECORDED',
    entity: { refType: 'Competency', refId: id },
    nextState: {
      id,
      projectId: ctx.projectId,
      operativeId: input.operativeId,
      qualification: input.qualification,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      status: input.expiresAt > new Date().toISOString() ? 'IN_DATE' : 'EXPIRED',
    },
    evidenceRefs: [evidence],
  });
  return id;
}
