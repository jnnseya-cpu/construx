import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import { createProject } from './structure.ts';
import type { SectorType } from './structure.ts';

/**
 * Business development — the head of the delivery chain.
 *
 * Everything else in this platform starts from a project that already exists.
 * Nothing described how it came to exist: a contractor hears about a job,
 * decides whether to chase it, and only then is there anything to estimate. So
 * the chain began at its second link.
 *
 *   Opportunity -> qualification -> bid / no-bid -> project
 *
 * Two design decisions carry the module.
 *
 * The qualification score is arithmetic, not judgement. Six weighted criteria,
 * each scored 1-5 by the person who knows, producing a number and a
 * recommendation. It recommends; it does not decide.
 *
 * The bid/no-bid decision is human by construction. Chasing the wrong job is
 * how contractors lose money years later, and the record of who decided, on
 * what score, and against what reasoning is exactly what nobody can produce
 * when the post-mortem happens. The event catalogue refuses an AI actor here.
 */

export type OpportunityStage = 'IDENTIFIED' | 'QUALIFIED' | 'BID' | 'NO_BID' | 'CONVERTED' | 'LOST';

/**
 * The six things that decide whether a job is worth chasing, weighted by how
 * often each one is the reason a pursued job turned bad.
 */
export const QUALIFICATION_CRITERIA = [
  { key: 'strategicFit', label: 'Strategic fit', weight: 15, prompt: 'Does this sit in the sector and geography we are trying to grow?' },
  { key: 'capability', label: 'Technical capability', weight: 20, prompt: 'Have we self-delivered work of this type and complexity before?' },
  { key: 'capacity', label: 'Delivery capacity', weight: 20, prompt: 'Can we resource it without starving a live project?' },
  { key: 'clientQuality', label: 'Client quality', weight: 15, prompt: 'Payment history, fairness of the contract, history of dispute.' },
  { key: 'competitivePosition', label: 'Competitive position', weight: 15, prompt: 'Do we have an advantage, or are we making up the numbers?' },
  { key: 'riskProfile', label: 'Risk profile', weight: 15, prompt: 'Ground, design liability, programme, liquidated damages.' },
] as const;

export type QualificationKey = (typeof QUALIFICATION_CRITERIA)[number]['key'];

/** Scores are 1–5. Anything outside that is a caller bug, not a low score. */
export type QualificationScores = Record<QualificationKey, number>;

export type Qualification = {
  scores: QualificationScores;
  /** Weighted percentage, 20–100. */
  score: number;
  recommendation: 'PURSUE' | 'REVIEW' | 'DECLINE';
  /** Criteria scoring 2 or below — the reasons this could hurt. */
  concerns: string[];
};

/**
 * Score an opportunity.
 *
 * Exported separately from the command so the number can be shown while the
 * form is being filled in, without committing anything.
 */
export function qualify(scores: QualificationScores): Qualification {
  for (const criterion of QUALIFICATION_CRITERIA) {
    const value = scores[criterion.key];
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      throw new DomainError(
        'QUALIFICATION_SCORE_INVALID',
        `${criterion.label} must be scored 1 to 5, received ${String(value)}`,
      );
    }
  }

  // Weights sum to 100 and scores run 1–5, so the raw total runs 100–500.
  // Expressed as a percentage of the maximum it reads as a familiar 20–100.
  const weighted = QUALIFICATION_CRITERIA.reduce((sum, c) => sum + scores[c.key] * c.weight, 0);
  const score = Math.round((weighted / 500) * 100 * 100) / 100;

  const concerns = QUALIFICATION_CRITERIA.filter((c) => scores[c.key] <= 2).map(
    (c) => `${c.label} scored ${scores[c.key]}/5 — ${c.prompt}`,
  );

  // A low score on capacity or client quality sinks an otherwise attractive
  // job more reliably than a mediocre average does, so either one forces a
  // review however well the rest scores.
  const forcedReview = scores.capacity <= 2 || scores.clientQuality <= 2;

  const recommendation: Qualification['recommendation'] =
    score >= 70 && !forcedReview ? 'PURSUE' : score >= 50 ? 'REVIEW' : 'DECLINE';

  return { scores, score, recommendation, concerns };
}

/** Opportunities live on the tenant's governance chain — there is no project yet. */
function pipelineProject(ctx: EngineContext): string {
  return `${ctx.tenantId}-governance`;
}

function requireOpportunity(ctx: EngineContext, opportunityId: string) {
  const record = ctx.ledger.get({ refType: 'Opportunity', refId: opportunityId });
  if (!record) throw new DomainError('OPPORTUNITY_NOT_FOUND', `No opportunity ${opportunityId}`, 404);
  return record;
}

// --- Register ---------------------------------------------------------------

export function registerOpportunity(
  ctx: EngineContext,
  input: {
    title: string;
    clientName: string;
    sectorType: SectorType;
    estimatedValueMinor: number;
    /** Where it came from — framework, tender portal, relationship, repeat client. */
    source: string;
    /** When the return is due. The single most important date in this stage. */
    submissionDueAt?: string;
    countryCode?: string;
    city?: string;
    notes?: string;
  },
): { opportunityId: string } {
  authorise(ctx, 'BUSINESS_DEVELOPMENT', 'C');

  if (input.estimatedValueMinor < 0) {
    throw new DomainError('VALUE_NEGATIVE', 'An opportunity cannot have a negative value');
  }

  const opportunityId = ulid();
  write(ctx, {
    projectId: pipelineProject(ctx),
    eventType: 'OPPORTUNITY_REGISTERED',
    entity: { refType: 'Opportunity', refId: opportunityId },
    nextState: {
      id: opportunityId,
      tenantId: ctx.tenantId,
      title: input.title,
      clientName: input.clientName,
      sectorType: input.sectorType,
      estimatedValueMinor: input.estimatedValueMinor,
      source: input.source,
      submissionDueAt: input.submissionDueAt,
      countryCode: input.countryCode,
      city: input.city,
      notes: input.notes,
      stage: 'IDENTIFIED' satisfies OpportunityStage,
      registeredAt: new Date().toISOString(),
      registeredBy: ctx.auth.actorId,
    },
  });

  return { opportunityId };
}

// --- Qualify ----------------------------------------------------------------

export function qualifyOpportunity(
  ctx: EngineContext,
  opportunityId: string,
  scores: QualificationScores,
): Qualification {
  authorise(ctx, 'BUSINESS_DEVELOPMENT', 'U');

  const record = requireOpportunity(ctx, opportunityId);
  const stage = record.state.stage as OpportunityStage;
  if (stage === 'CONVERTED' || stage === 'NO_BID') {
    throw new DomainError('OPPORTUNITY_CLOSED', `This opportunity is ${stage.toLowerCase()} and cannot be re-qualified`);
  }

  const qualification = qualify(scores);

  write(ctx, {
    projectId: pipelineProject(ctx),
    eventType: 'OPPORTUNITY_QUALIFIED',
    entity: { refType: 'Opportunity', refId: opportunityId },
    nextState: {
      ...record.state,
      stage: 'QUALIFIED' satisfies OpportunityStage,
      qualification,
      qualifiedAt: new Date().toISOString(),
      qualifiedBy: ctx.auth.actorId,
    },
  });

  return qualification;
}

// --- Decide -----------------------------------------------------------------

/**
 * The bid/no-bid decision.
 *
 * Requires a qualification first: deciding without a score is the behaviour
 * this module exists to replace. Deciding against the recommendation is
 * permitted — the tool advises — but the divergence is recorded, because
 * "we overrode the score" is the finding a post-mortem needs and the one
 * nobody writes down at the time.
 */
export function decideBidNoBid(
  ctx: EngineContext,
  opportunityId: string,
  input: { bid: boolean; rationale: string },
): { stage: OpportunityStage; againstRecommendation: boolean } {
  authorise(ctx, 'BUSINESS_DEVELOPMENT', 'A');

  const record = requireOpportunity(ctx, opportunityId);
  const qualification = record.state.qualification as Qualification | undefined;

  if (!qualification) {
    throw new DomainError(
      'QUALIFICATION_REQUIRED',
      'An opportunity must be qualified before a bid decision is recorded',
    );
  }
  if (!input.rationale?.trim()) {
    throw new DomainError('RATIONALE_REQUIRED', 'A bid decision requires a rationale, whichever way it goes');
  }

  const stage: OpportunityStage = input.bid ? 'BID' : 'NO_BID';
  const againstRecommendation =
    (input.bid && qualification.recommendation === 'DECLINE') ||
    (!input.bid && qualification.recommendation === 'PURSUE');

  write(ctx, {
    projectId: pipelineProject(ctx),
    eventType: 'BID_NO_BID_DECIDED',
    entity: { refType: 'Opportunity', refId: opportunityId },
    nextState: {
      ...record.state,
      stage,
      decision: {
        bid: input.bid,
        rationale: input.rationale.trim(),
        decidedBy: ctx.auth.actorId,
        decidedAt: new Date().toISOString(),
        score: qualification.score,
        recommendation: qualification.recommendation,
        againstRecommendation,
      },
    },
  });

  return { stage, againstRecommendation };
}

// --- Convert ----------------------------------------------------------------

/**
 * Turn a won opportunity into a project.
 *
 * This is the join between business development and everything downstream. The
 * project carries the opportunity id, so the estimate, the contract and every
 * event after it trace back to the decision to chase the job in the first
 * place — which is the whole point of a golden thread that starts early enough.
 */
export function convertToProject(
  ctx: EngineContext,
  opportunityId: string,
  input: {
    projectName: string;
    portfolioId: string;
    programmeId?: string;
    assetType: string;
    location: { continentCode: string; countryCode: string; city: string };
    currency: string;
    contractValueMinor?: number;
    plannedStart: string;
    plannedCompletion: string;
  },
): { projectId: string } {
  authorise(ctx, 'BUSINESS_DEVELOPMENT', 'A');

  const record = requireOpportunity(ctx, opportunityId);
  const stage = record.state.stage as OpportunityStage;

  if (stage !== 'BID') {
    throw new DomainError(
      'OPPORTUNITY_NOT_WON',
      `Only an opportunity decided as a bid becomes a project; this one is ${stage.toLowerCase()}`,
    );
  }

  const { projectId } = createProject(ctx, {
    name: input.projectName,
    portfolioId: input.portfolioId,
    programmeId: input.programmeId,
    sectorType: record.state.sectorType as SectorType,
    assetType: input.assetType,
    location: input.location,
    currency: input.currency,
    // The estimate carries forward unless a negotiated figure replaces it.
    contractValueMinor: input.contractValueMinor ?? (record.state.estimatedValueMinor as number),
    plannedStart: input.plannedStart,
    plannedCompletion: input.plannedCompletion,
    originOpportunityId: opportunityId,
  });

  write(ctx, {
    projectId: pipelineProject(ctx),
    eventType: 'OPPORTUNITY_CONVERTED',
    entity: { refType: 'Opportunity', refId: opportunityId },
    nextState: {
      ...record.state,
      stage: 'CONVERTED' satisfies OpportunityStage,
      convertedProjectId: projectId,
      convertedAt: new Date().toISOString(),
      convertedBy: ctx.auth.actorId,
    },
  });

  return { projectId };
}

// --- Read -------------------------------------------------------------------

export type PipelineSummary = {
  opportunities: Array<Record<string, unknown>>;
  /** Weighted pipeline value: only what is still live counts. */
  liveValueMinor: number;
  wonValueMinor: number;
  byStage: Record<string, number>;
  /** Decisions taken against the platform's own recommendation. */
  overrides: number;
};

export function pipeline(ctx: EngineContext): PipelineSummary {
  authorise(ctx, 'BUSINESS_DEVELOPMENT', 'R');

  const opportunities = ctx.ledger
    .list(pipelineProject(ctx), 'Opportunity')
    .filter((r) => r.tenantId === ctx.tenantId)
    .map((r) => r.state);

  const live: OpportunityStage[] = ['IDENTIFIED', 'QUALIFIED', 'BID'];
  const byStage: Record<string, number> = {};
  let liveValueMinor = 0;
  let wonValueMinor = 0;
  let overrides = 0;

  for (const opportunity of opportunities) {
    const stage = String(opportunity.stage);
    byStage[stage] = (byStage[stage] ?? 0) + 1;

    const value = Number(opportunity.estimatedValueMinor ?? 0);
    if (live.includes(stage as OpportunityStage)) liveValueMinor += value;
    if (stage === 'CONVERTED') wonValueMinor += value;

    if ((opportunity.decision as { againstRecommendation?: boolean } | undefined)?.againstRecommendation) {
      overrides += 1;
    }
  }

  return { opportunities, liveValueMinor, wonValueMinor, byStage, overrides };
}
