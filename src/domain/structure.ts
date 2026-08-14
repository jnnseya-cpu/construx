import { hashEvidence } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import {
  assertTransitionAllowed,
  evaluatePhaseGate,
  LIFECYCLE_ORDER,
  nextPhase,
  type GateEvaluation,
  type LifecyclePhase,
} from '../lifecycle/phases.ts';

/**
 * Governance and delivery structure.
 *
 * The hierarchy is fixed and every level is creatable, because a blocked chain
 * at any level blocks everything below it:
 *
 *   Tenant -> Enterprise -> Portfolio -> Programme -> Project -> Package
 */

export type SectorType = 'BUILDING' | 'INFRASTRUCTURE' | 'SPECIALISED';

export function createPortfolio(
  ctx: EngineContext,
  input: {
    name: string;
    enterpriseId: string;
    governanceModel: string;
    continentCode?: string;
    countryCode?: string;
    city?: string;
    targets?: { budgetMinor?: number; targetCompletionDate?: string; kpis?: Record<string, number> };
    riskAppetite?: { costTolerancePercent: number; scheduleToleranceDays: number };
    reportingCadence?: 'WEEKLY' | 'FORTNIGHTLY' | 'MONTHLY';
    standardCalendar?: { workingDays: number[]; holidays: string[] };
  },
): { portfolioId: string } {
  authorise(ctx, 'ENTERPRISE_STRUCTURE', 'C');

  const portfolioId = ulid();
  write(ctx, {
    // Structural entities live on a tenant-level pseudo-project so that
    // governance events are never orphaned from a project chain.
    projectId: `${ctx.tenantId}-governance`,
    eventType: 'PORTFOLIO_CREATED',
    entity: { refType: 'Portfolio', refId: portfolioId },
    nextState: {
      id: portfolioId,
      tenantId: ctx.tenantId,
      enterpriseId: input.enterpriseId,
      name: input.name,
      governanceModel: input.governanceModel,
      // Region is stored as ISO codes so filters aggregate cleanly worldwide.
      continentCode: input.continentCode,
      countryCode: input.countryCode,
      city: input.city,
      targets: input.targets ?? {},
      riskAppetite: input.riskAppetite ?? { costTolerancePercent: 5, scheduleToleranceDays: 10 },
      reportingCadence: input.reportingCadence ?? 'MONTHLY',
      standardCalendar: input.standardCalendar ?? { workingDays: [1, 2, 3, 4, 5], holidays: [] },
      createdAt: new Date().toISOString(),
      createdBy: ctx.auth.actorId,
    },
  });

  return { portfolioId };
}

export function setPortfolioTargets(
  ctx: EngineContext,
  input: {
    portfolioId: string;
    targets: { budgetMinor?: number; targetCompletionDate?: string; kpis?: Record<string, number> };
    riskAppetite?: { costTolerancePercent: number; scheduleToleranceDays: number };
  },
): void {
  authorise(ctx, 'ENTERPRISE_STRUCTURE', 'U');

  const portfolio = ctx.ledger.require({ refType: 'Portfolio', refId: input.portfolioId });
  write(ctx, {
    projectId: `${ctx.tenantId}-governance`,
    eventType: 'PORTFOLIO_TARGETS_SET',
    entity: { refType: 'Portfolio', refId: input.portfolioId },
    nextState: {
      ...portfolio.state,
      targets: input.targets,
      riskAppetite: input.riskAppetite ?? portfolio.state.riskAppetite,
    },
  });
}

export function createProgramme(
  ctx: EngineContext,
  input: { portfolioId: string; name: string; objective: string },
): { programmeId: string } {
  authorise(ctx, 'ENTERPRISE_STRUCTURE', 'C');

  ctx.ledger.require({ refType: 'Portfolio', refId: input.portfolioId });

  const programmeId = ulid();
  write(ctx, {
    projectId: `${ctx.tenantId}-governance`,
    eventType: 'PROGRAMME_CREATED',
    entity: { refType: 'Programme', refId: programmeId },
    nextState: {
      id: programmeId,
      tenantId: ctx.tenantId,
      portfolioId: input.portfolioId,
      name: input.name,
      objective: input.objective,
      createdAt: new Date().toISOString(),
    },
  });

  return { programmeId };
}

export function createProject(
  ctx: EngineContext,
  input: {
    projectId?: string;
    portfolioId: string;
    programmeId?: string;
    name: string;
    sectorType: SectorType;
    assetType: string;
    location: { continentCode: string; countryCode: string; city: string; coordinates?: { lat: number; lng: number } };
    contractValueMinor: number;
    currency: string;
    plannedStart: string;
    plannedCompletion: string;
  },
): { projectId: string; phase: LifecyclePhase } {
  authorise(ctx, 'PROJECT_SETUP', 'C');

  ctx.ledger.require({ refType: 'Portfolio', refId: input.portfolioId });

  const projectId = input.projectId ?? ulid();
  write(ctx, {
    projectId,
    eventType: 'PROJECT_CREATED',
    entity: { refType: 'Project', refId: projectId },
    nextState: {
      id: projectId,
      tenantId: ctx.tenantId,
      portfolioId: input.portfolioId,
      programmeId: input.programmeId,
      name: input.name,
      sectorType: input.sectorType,
      assetType: input.assetType,
      location: input.location,
      contractValueMinor: input.contractValueMinor,
      currency: input.currency,
      plannedStart: input.plannedStart,
      plannedCompletion: input.plannedCompletion,
      // Every project starts at the beginning of the lifecycle and moves
      // forward only through governed gates.
      phase: 'CONCEPT',
      phaseHistory: [{ phase: 'CONCEPT', enteredAt: new Date().toISOString(), by: ctx.auth.actorId }],
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
    },
  });

  return { projectId, phase: 'CONCEPT' };
}

export function createScopePackage(
  ctx: EngineContext,
  input: {
    name: string;
    discipline: string;
    scopeOfWorks: string;
    inclusions: string[];
    exclusions: string[];
    acceptanceCriteria: string[];
    estimatedValueMinor: number;
    designResponsibility: 'CLIENT' | 'CONTRACTOR' | 'SHARED';
  },
): { packageId: string } {
  // A scope package is delivery scope, not project governance — the PM and the
  // delivery roles own it, which is what the matrix reflects.
  authorise(ctx, 'WORKPACKAGES_TASKS', 'C');

  const packageId = ulid();
  write(ctx, {
    eventType: 'PACKAGE_CREATED',
    entity: { refType: 'ScopePackage', refId: packageId },
    nextState: {
      id: packageId,
      projectId: ctx.projectId,
      ...input,
      status: 'DEFINED',
      createdAt: new Date().toISOString(),
    },
  });

  return { packageId };
}

/**
 * Design maturity assessment. This is the control that stops a package going to
 * market before it can be priced properly — the single largest source of
 * downstream variations.
 */
export function assessDesignMaturity(
  ctx: EngineContext,
  input: {
    packageId: string;
    disciplineScores: Array<{ discipline: string; ribaStage: number; completenessPercent: number; frozen: boolean }>;
    informationGaps: string[];
    assessorNotes: string;
  },
): { assessmentId: string; score: number; readyForPricing: boolean; recommendedPricingBasis: string } {
  authorise(ctx, 'DESIGN_INFORMATION', 'C');

  if (input.disciplineScores.length === 0) {
    throw new DomainError('DESIGN_MATURITY_NO_INPUT', 'At least one discipline must be assessed');
  }

  // A frozen discipline is worth more than an unfrozen one at the same
  // completeness: design that can still move is design that will still move.
  const score =
    input.disciplineScores.reduce((sum, d) => sum + d.completenessPercent * (d.frozen ? 1 : 0.8), 0) /
    input.disciplineScores.length;

  const gapPenalty = Math.min(20, input.informationGaps.length * 4);
  const finalScore = Number(Math.max(0, score - gapPenalty).toFixed(1));

  const recommendedPricingBasis =
    finalScore >= 80
      ? 'LUMP_SUM'
      : finalScore >= 60
        ? 'REMEASURABLE'
        : finalScore >= 40
          ? 'TARGET_COST'
          : 'COST_REIMBURSABLE';

  const assessmentId = ulid();
  const evidence = registerEvidence(ctx, {
    type: 'DESIGN_MATURITY_BASIS',
    hash: hashEvidence(JSON.stringify(input)),
    description: `Design maturity assessment for package ${input.packageId}: ${finalScore}`,
  });

  write(ctx, {
    eventType: 'DESIGN_MATURITY_ASSESSED',
    entity: { refType: 'DesignMaturityAssessment', refId: assessmentId },
    nextState: {
      id: assessmentId,
      projectId: ctx.projectId,
      packageId: input.packageId,
      disciplineScores: input.disciplineScores,
      informationGaps: input.informationGaps,
      assessorNotes: input.assessorNotes,
      score: finalScore,
      readyForPricing: finalScore >= 60,
      recommendedPricingBasis,
      assessedAt: new Date().toISOString(),
      assessedBy: ctx.auth.actorId,
    },
    evidenceRefs: [evidence],
  });

  return { assessmentId, score: finalScore, readyForPricing: finalScore >= 60, recommendedPricingBasis };
}

/** Evaluate the current phase gate against materialised project state. */
export function evaluateCurrentGate(ctx: EngineContext): GateEvaluation & { currentPhase: LifecyclePhase; nextPhase?: LifecyclePhase } {
  const project = ctx.ledger.require({ refType: 'Project', refId: ctx.projectId });
  const phase = project.state.phase as LifecyclePhase;

  const evaluation = evaluatePhaseGate(phase, (refType) =>
    ctx.ledger.list(ctx.projectId, refType).map((r) => r.state),
  );

  return { ...evaluation, currentPhase: phase, nextPhase: nextPhase(phase) };
}

/**
 * Move the project to another lifecycle phase. Forward moves must clear the
 * gate; a regression is allowed but recorded as such, because projects that
 * re-enter design genuinely happen and hiding it corrupts the record.
 */
export function transitionPhase(
  ctx: EngineContext,
  input: { to: LifecyclePhase; justification: string },
): { from: LifecyclePhase; to: LifecyclePhase; direction: 'FORWARD' | 'REGRESSION' } {
  authorise(ctx, 'PROJECT_SETUP', 'A');

  const project = ctx.ledger.require({ refType: 'Project', refId: ctx.projectId });
  const from = project.state.phase as LifecyclePhase;

  if (!LIFECYCLE_ORDER.includes(input.to)) {
    throw new DomainError('PHASE_UNKNOWN', `"${input.to}" is not a lifecycle phase`);
  }

  const evaluation = evaluatePhaseGate(from, (refType) => ctx.ledger.list(ctx.projectId, refType).map((r) => r.state));
  const { direction } = assertTransitionAllowed(from, input.to, evaluation);

  const evidence = registerEvidence(ctx, {
    type: 'PHASE_TRANSITION_AUTHORITY',
    hash: hashEvidence(JSON.stringify({ from, to: input.to, justification: input.justification, evaluation })),
    description: `Phase transition ${from} -> ${input.to}: ${input.justification}`,
  });

  const history = (project.state.phaseHistory as Array<Record<string, unknown>>) ?? [];

  write(ctx, {
    eventType: 'PROJECT_PHASE_TRANSITIONED',
    entity: { refType: 'Project', refId: ctx.projectId },
    nextState: {
      ...project.state,
      phase: input.to,
      phaseHistory: [
        ...history,
        {
          phase: input.to,
          enteredAt: new Date().toISOString(),
          by: ctx.auth.actorId,
          direction,
          justification: input.justification,
          gateEvaluation: evaluation.criteria,
        },
      ],
    },
    evidenceRefs: [evidence],
  });

  return { from, to: input.to, direction };
}
