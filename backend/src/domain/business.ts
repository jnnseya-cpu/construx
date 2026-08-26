import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import { createProject } from './structure.ts';
import { supplyChainCoverage } from './supplychain.ts';
import { bidApprovalPosition } from './tenderintake.ts';
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
 * Three design decisions carry the module.
 *
 * The qualification score is arithmetic, not judgement. Ten weighted factors,
 * each scored 1–5 by the person who knows, producing a number and a
 * recommendation against published thresholds. It recommends; it does not
 * decide.
 *
 * The bid/no-bid decision is human by construction. Chasing the wrong job is
 * how contractors lose money years later, and the record of who decided, on
 * what score, and against what reasoning is exactly what nobody can produce
 * when the post-mortem happens. The event catalogue refuses an AI actor here.
 *
 * And refusing is measured. An algorithm nobody declines against is a form, so
 * `bidDiscipline` counts the no-bid rate, names every override, and checks
 * whether the bands actually predict — because weights that do not predict are
 * a slower way of having the same opinion.
 */

export type OpportunityStage = 'IDENTIFIED' | 'QUALIFIED' | 'BID' | 'NO_BID' | 'CONVERTED' | 'LOST';

/**
 * The bid/no-bid algorithm.
 *
 * Ten factors, weighted to 100, each scored 1–5 by the person who knows.
 *
 * **Five is always good for us.** That sentence is the whole reason this
 * catalogue carries a `good` and a `bad` anchor on every factor rather than a
 * one-line prompt. Two of the ten are named as risks — competition and
 * cash flow — and a scorer who reads "cash-flow risk: 5" as "very risky" has
 * inverted the algorithm on the factors where being wrong costs most. The
 * anchors remove the ambiguity instead of relying on everyone reading the
 * heading the same way.
 */
export const QUALIFICATION_CRITERIA = [
  {
    key: 'relevantExperience',
    label: 'Relevant experience',
    weight: 15,
    prompt: 'Have we self-delivered work of this type, scale and complexity before?',
    good: 'We have completed several near-identical schemes and can name them',
    bad: 'We have never built one of these',
  },
  {
    key: 'clientAttractiveness',
    label: 'Client attractiveness',
    weight: 10,
    prompt: 'Payment history, fairness of the contract, appetite for dispute, repeat potential.',
    good: 'Pays on time, amends contracts reasonably, we want more of their work',
    bad: 'Late payer, onerous amendments, a history of claims against contractors',
  },
  {
    key: 'contractSize',
    label: 'Contract size',
    weight: 10,
    prompt: 'Is this the right size for us — large enough to be worth the bid, small enough not to bet the business?',
    good: 'Comfortably within the range we deliver well',
    bad: 'Too small to cover the bid cost, or so large that one job carries the company',
  },
  {
    key: 'geography',
    label: 'Geography',
    weight: 10,
    prompt: 'Distance from our operating base, and whether our people and supply chain travel to it.',
    good: 'Inside our operating patch, staffed and supplied from existing resource',
    bad: 'Outside our patch — accommodation, travel and an unknown local market',
  },
  {
    key: 'supplyChainCapacity',
    label: 'Supply-chain capacity',
    weight: 10,
    prompt: 'Can we get competitive prices from firms we already have, for the trades this needs?',
    good: 'Prequalified firms across every package, enough for real competition',
    bad: 'Trades with nobody on the register, or one firm and no alternative',
  },
  {
    key: 'competition',
    label: 'Competition',
    weight: 10,
    prompt: 'How crowded is the field, and where do we sit in it?',
    good: 'Few credible bidders, and we are one of them',
    bad: 'An open field of a dozen, and we are making up the numbers',
  },
  {
    key: 'marginOpportunity',
    label: 'Margin opportunity',
    weight: 15,
    prompt: 'What margin can this realistically carry, given how it will be bought?',
    good: 'Priced on value, with scope for the margin we need',
    bad: 'A race to the bottom on price alone',
  },
  {
    key: 'cashflowRisk',
    label: 'Cash-flow risk',
    weight: 10,
    prompt: 'Payment terms, retention, front-loaded cost, and how much of the job we fund.',
    good: 'Favourable terms, low retention, we are not funding the client',
    bad: 'Long payment periods and heavy early spend — we bankroll it',
  },
  {
    key: 'strategicValue',
    label: 'Strategic value',
    weight: 5,
    prompt: 'What it opens up beyond its own margin — a sector, a framework, a reference.',
    good: 'Opens a sector or framework we have decided to be in',
    bad: 'Leads nowhere we want to go',
  },
  {
    key: 'winProbability',
    label: 'Win probability',
    weight: 5,
    prompt: 'Honestly, what are our chances?',
    good: 'A strong position, and a reason the client would choose us',
    bad: 'A long shot we are entering out of habit',
  },
] as const;

export type QualificationKey = (typeof QUALIFICATION_CRITERIA)[number]['key'];

/** Scores are 1–5. Anything outside that is a caller bug, not a low score. */
export type QualificationScores = Record<QualificationKey, number>;

/**
 * The decision bands.
 *
 *   below 55       NO BID
 *   55 to 70       Director review
 *   above 70       BID
 *
 * Held here rather than inline so the rule can be published to the interface
 * and read back in a test, instead of being a number three places disagree on.
 */
export const BID_THRESHOLDS = { noBidBelow: 55, bidAbove: 70 } as const;

export type BidRecommendation = 'BID' | 'DIRECTOR_REVIEW' | 'NO_BID';

export type Qualification = {
  scores: QualificationScores;
  /**
   * Weighted percentage. The floor is 20, not 0 — every factor scored 1 out of
   * 5 still returns a fifth of the weight. A score of 20 is the worst possible
   * opportunity, and nothing scores below it.
   */
  score: number;
  recommendation: BidRecommendation;
  /** Factors scoring 2 or below — the reasons this could hurt. */
  concerns: string[];
  /**
   * Set when the band said BID but a hard stop pulled it back to review.
   * A single factor at 1 out of 5 does that: a job we have never built, or one
   * with nobody in the supply chain to price it, does not become safe because
   * the margin looked good. The number is a guide; a 1 is a fact.
   */
  cappedBy?: string;
  /** The band the raw score fell in, before any hard stop. */
  band: BidRecommendation;
};

/**
 * Score an opportunity.
 *
 * Exported separately from the command so the number moves while the form is
 * being filled in, without committing anything.
 */
export function qualify(scores: QualificationScores): Qualification {
  for (const criterion of QUALIFICATION_CRITERIA) {
    const value = scores[criterion.key];
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      throw new DomainError(
        'QUALIFICATION_SCORE_INVALID',
        `${criterion.label} must be scored 1 to 5, where 5 is "${criterion.good}". Received ${String(value)}.`,
      );
    }
  }

  // Weights sum to 100 and scores run 1–5, so the raw total runs 100–500.
  // Divided by five it reads as the familiar percentage, floor 20.
  const weighted = QUALIFICATION_CRITERIA.reduce((sum, c) => sum + scores[c.key] * c.weight, 0);
  const score = Math.round((weighted / 5) * 100) / 100;

  const concerns = QUALIFICATION_CRITERIA.filter((c) => scores[c.key] <= 2).map(
    (c) => `${c.label} scored ${scores[c.key]}/5 — ${c.bad}`,
  );

  const band: BidRecommendation =
    score > BID_THRESHOLDS.bidAbove ? 'BID' : score >= BID_THRESHOLDS.noBidBelow ? 'DIRECTOR_REVIEW' : 'NO_BID';

  // A weighted average hides a single catastrophic factor behind nine
  // comfortable ones. Any factor at 1 out of 5 is a fact rather than a
  // deduction, so it holds the job at a director's desk however well it scored.
  const floored = QUALIFICATION_CRITERIA.find((c) => scores[c.key] === 1);
  const cappedBy =
    band === 'BID' && floored ? `${floored.label} scored 1/5 — ${floored.bad}` : undefined;

  return {
    scores,
    score,
    band,
    recommendation: cappedBy ? 'DIRECTOR_REVIEW' : band,
    concerns,
    ...(cappedBy ? { cappedBy } : {}),
  };
}

/**
 * What the supply-chain register actually says about the trades this job needs.
 *
 * Supply-chain capacity is the one factor of the ten the platform can answer
 * from evidence rather than from memory. The register already knows how many
 * prequalified firms cover each trade and where the coverage is too thin to run
 * a competitive enquiry, so the scorer sees the numbers instead of estimating
 * them.
 *
 * It suggests a score and does not set one — the register knows the count, not
 * whether those firms would want the job. The scorer can disagree, and a
 * disagreement that is visible is worth more than an automatic number nobody
 * examines.
 */
export function supplyChainEvidence(
  ctx: EngineContext,
  trades: string[],
): {
  trades: Array<{ code: string; label: string; eligible: number; strategic: number; competitive: boolean }>;
  thinTrades: string[];
  uncovered: string[];
  suggestedScore: number;
  note: string;
} {
  authorise(ctx, 'BUSINESS_DEVELOPMENT', 'R');

  const coverage = supplyChainCoverage(ctx);
  const wanted = new Set(trades);
  const known = coverage.trades.filter((t) => wanted.has(t.code));
  const uncovered = trades.filter((code) => !coverage.trades.some((t) => t.code === code));

  const rows = known.map((t) => ({
    code: t.code,
    label: t.label,
    eligible: t.eligible,
    strategic: t.strategic,
    // Three quotes is the working definition of a competitive enquiry, and the
    // same number the framework sizing and the coverage report use.
    competitive: t.eligible >= 3,
  }));

  const thinTrades = rows.filter((t) => !t.competitive).map((t) => t.label);
  const covered = rows.length;
  const competitive = rows.filter((t) => t.competitive).length;

  // Proportion of the required trades we can genuinely compete, mapped onto the
  // 1–5 scale the algorithm uses.
  const ratio = covered === 0 ? 0 : competitive / covered;
  const suggestedScore = covered === 0 ? 1 : Math.max(1, Math.min(5, Math.round(1 + ratio * 4)));

  return {
    trades: rows,
    thinTrades,
    uncovered,
    suggestedScore,
    note:
      covered === 0
        ? 'None of these trades appear in the catalogue, so the register can say nothing about them.'
        : `${competitive} of ${covered} required trades have three or more eligible firms.` +
          (thinTrades.length > 0 ? ` Too thin to compete: ${thinTrades.join(', ')}.` : '') +
          (uncovered.length > 0 ? ` Not in the trade catalogue: ${uncovered.join(', ')}.` : ''),
  };
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
 * Who took the decision, and under what standing authority.
 *
 * `AC-T-WF-01-02` asks the record to show delegated authority alongside the
 * scoring. It is required only where the decision goes against the algorithm's
 * recommendation, and that is the whole point: overriding a published rule is
 * an exercise of authority, and an override with nobody's authority named on it
 * is the finding a post-mortem cannot answer.
 */
export type DecisionAuthority = {
  /** The person or office the authority sits with. */
  delegatedTo: string;
  /** The scheme of delegation, board minute or policy it comes from. */
  reference?: string;
  /** The value ceiling that authority carries, where one applies. */
  limitMinor?: number;
};

/** A recorded disagreement. Kept because unanimity that was not unanimous is a lie. */
export type DecisionDissent = { by: string; position: string };

/**
 * The bid/no-bid decision.
 *
 * Requires a qualification first: deciding without a score is the behaviour
 * this module exists to replace. Deciding against the recommendation is
 * permitted — the tool advises — but the divergence is recorded, because
 * "we overrode the score" is the finding a post-mortem needs and the one
 * nobody writes down at the time.
 *
 * One gate sits in front of a decision to **bid**, and it does not apply to a
 * decision to walk away — declining is always available, and gating a refusal
 * behind paperwork would make refusing the expensive option.
 *
 *   - Where a formal invitation has been recorded (`T-WF-01`), every mandatory
 *     deliverable must carry a source, an owner and an internal date. A bid
 *     disqualified for a missing certificate was priced correctly and lost
 *     anyway.
 *
 * What is deliberately **not** gated here is staleness. An addendum makes the
 * last decision stale, and deciding again is the act that answers it — so
 * refusing the decision would leave nothing able to clear the condition. The
 * staleness is reported on the tender position and enforced where it actually
 * bites: a tender programme cannot be built on a superseded invitation.
 */
export function decideBidNoBid(
  ctx: EngineContext,
  opportunityId: string,
  input: {
    bid: boolean;
    rationale: string;
    /** Conditions the decision is subject to — "bid, provided the LADs are capped". */
    conditions?: string[];
    dissent?: DecisionDissent[];
    authority?: DecisionAuthority;
  },
): { stage: OpportunityStage; againstRecommendation: boolean; conditions: string[] } {
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
    (input.bid && qualification.recommendation === 'NO_BID') ||
    (!input.bid && qualification.recommendation === 'BID');

  if (againstRecommendation && !input.authority?.delegatedTo?.trim()) {
    throw new DomainError(
      'AUTHORITY_REQUIRED',
      `The algorithm recommends ${qualification.recommendation.replace(/_/g, ' ').toLowerCase()} at a score of ${qualification.score}. ` +
        'Deciding otherwise is permitted, but the authority it is taken under has to be named.',
    );
  }

  if (input.bid) {
    const position = bidApprovalPosition(ctx, opportunityId);
    if (position.blockers.length > 0) {
      throw new DomainError(
        'TENDER_DELIVERABLES_INCOMPLETE',
        `Invitation ${position.reference} is not ready to bid. ${position.blockers.join('. ')}. ` +
          'A mandatory deliverable with no owner, no source or no internal date is how a correctly priced bid is disqualified.',
      );
    }
  }

  const conditions = (input.conditions ?? []).map((c) => c.trim()).filter(Boolean);
  const previous = record.state.decision as { decidedAt?: string } | undefined;

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
        conditions,
        dissent: input.dissent ?? [],
        authority: input.authority,
        // A re-review after an addendum supersedes rather than replaces: the
        // ledger keeps both, and this says which one this decision answers.
        supersedes: previous?.decidedAt,
      },
    },
  });

  return { stage, againstRecommendation, conditions };
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

// --- Bid discipline ---------------------------------------------------------

export type BidDiscipline = {
  decided: number;
  bid: number;
  noBid: number;
  /** The number the business should be proud of. */
  noBidRatePercent: number;
  /** Bid cost avoided by refusing, at the assumed cost of a bid. */
  declinedValueMinor: number;
  /**
   * How each band actually turned out. If the algorithm works, jobs scored
   * above 70 convert more often than jobs pushed through from the review band.
   * If they do not, the weights are wrong and this is where that shows up.
   */
  byBand: Array<{
    band: BidRecommendation;
    range: string;
    decided: number;
    bid: number;
    noBid: number;
    converted: number;
    lost: number;
    /** Of the ones bid in this band, how many became projects. */
    winRatePercent: number | null;
  }>;
  /** Decisions taken against the algorithm, each one named. */
  overrides: Array<{
    opportunityId: string;
    title: string;
    score: number;
    recommendation: BidRecommendation;
    decision: 'BID' | 'NO_BID';
    rationale: string;
    decidedBy: string;
    outcome: string;
  }>;
  /** Factors most often scoring 2 or below across the pipeline. */
  recurringConcerns: Array<{ factor: string; count: number }>;
  observations: string[];
};

/**
 * Whether the business is actually refusing bad work, and whether refusing it
 * was right.
 *
 * A bid/no-bid algorithm that nobody declines against is a form. The point of
 * scoring every opportunity is to say no to some of them, and the only way that
 * becomes a habit rather than a policy is if the refusals are counted and the
 * overrides are named. So this reports three things:
 *
 *   - the no-bid rate, which should be substantial and is a number to be proud
 *     of rather than to explain away;
 *   - every decision taken against the algorithm, with who took it and how it
 *     turned out, because "we overrode the score" is the finding a post-mortem
 *     needs and the one nobody writes down at the time;
 *   - whether the bands predict. If jobs scored above 70 do not convert better
 *     than jobs pushed through from the review band, the weights are wrong, and
 *     an algorithm nobody checks against outcomes is just a slower opinion.
 */
export function bidDiscipline(ctx: EngineContext): BidDiscipline {
  authorise(ctx, 'BUSINESS_DEVELOPMENT', 'R');

  const opportunities = ctx.ledger
    .list(pipelineProject(ctx), 'Opportunity')
    .filter((r) => r.tenantId === ctx.tenantId)
    .map((r) => r.state);

  type Decision = { bid: boolean; rationale: string; decidedBy: string; score: number; recommendation: BidRecommendation; againstRecommendation: boolean };

  const bands: BidRecommendation[] = ['BID', 'DIRECTOR_REVIEW', 'NO_BID'];
  const ranges: Record<BidRecommendation, string> = {
    BID: `above ${BID_THRESHOLDS.bidAbove}`,
    DIRECTOR_REVIEW: `${BID_THRESHOLDS.noBidBelow}–${BID_THRESHOLDS.bidAbove}`,
    NO_BID: `below ${BID_THRESHOLDS.noBidBelow}`,
  };
  const tally = new Map(bands.map((b) => [b, { decided: 0, bid: 0, noBid: 0, converted: 0, lost: 0 }]));

  const overrides: BidDiscipline['overrides'] = [];
  const concernCounts = new Map<string, number>();

  let decided = 0;
  let bid = 0;
  let noBid = 0;
  let declinedValueMinor = 0;

  for (const opportunity of opportunities) {
    const qualification = opportunity.qualification as Qualification | undefined;
    if (qualification) {
      for (const concern of qualification.concerns) {
        const factor = concern.split(' scored ')[0]!;
        concernCounts.set(factor, (concernCounts.get(factor) ?? 0) + 1);
      }
    }

    const decision = opportunity.decision as Decision | undefined;
    if (!decision || !qualification) continue;

    decided += 1;
    const stage = String(opportunity.stage) as OpportunityStage;
    // The band is what the score said, which is the thing being tested. The
    // recommendation can differ from it where a hard stop applied.
    const bucket = tally.get(qualification.band ?? decision.recommendation)!;
    bucket.decided += 1;

    if (decision.bid) {
      bid += 1;
      bucket.bid += 1;
      if (stage === 'CONVERTED') bucket.converted += 1;
      if (stage === 'LOST') bucket.lost += 1;
    } else {
      noBid += 1;
      bucket.noBid += 1;
      declinedValueMinor += Number(opportunity.estimatedValueMinor ?? 0);
    }

    if (decision.againstRecommendation) {
      overrides.push({
        opportunityId: String(opportunity.id),
        title: String(opportunity.title),
        score: qualification.score,
        recommendation: decision.recommendation,
        decision: decision.bid ? 'BID' : 'NO_BID',
        rationale: decision.rationale,
        decidedBy: decision.decidedBy,
        outcome:
          stage === 'CONVERTED'
            ? 'Won'
            : stage === 'LOST'
              ? 'Lost'
              : decision.bid
                ? 'Bid, no outcome yet'
                : 'Declined',
      });
    }
  }

  const byBand = bands.map((band) => {
    const t = tally.get(band)!;
    return {
      band,
      range: ranges[band],
      ...t,
      // A bid with no outcome yet is not a loss, so the rate is taken over
      // decided outcomes rather than over everything bid.
      winRatePercent:
        t.converted + t.lost === 0 ? null : Math.round((t.converted / (t.converted + t.lost)) * 10000) / 100,
    };
  });

  const noBidRatePercent = decided === 0 ? 0 : Math.round((noBid / decided) * 10000) / 100;

  const observations: string[] = [];
  if (decided === 0) {
    observations.push('No opportunity has reached a decision yet.');
  } else if (noBid === 0) {
    observations.push(
      `${decided} ${decided === 1 ? 'decision' : 'decisions'} and nothing declined. A pipeline where nothing is refused is not being qualified — it is being processed.`,
    );
  } else {
    observations.push(
      `${noBidRatePercent}% of decided opportunities were declined, releasing the bid team from ${noBid} ${noBid === 1 ? 'pursuit' : 'pursuits'}.`,
    );
  }

  const pushedThrough = overrides.filter((o) => o.decision === 'BID' && o.recommendation === 'NO_BID');
  if (pushedThrough.length > 0) {
    const lost = pushedThrough.filter((o) => o.outcome === 'Lost').length;
    observations.push(
      `${pushedThrough.length} ${pushedThrough.length === 1 ? 'job was' : 'jobs were'} bid against a NO BID recommendation${lost > 0 ? `, of which ${lost} ${lost === 1 ? 'was' : 'were'} lost` : ''}.`,
    );
  }

  const strong = byBand.find((b) => b.band === 'BID');
  const marginal = byBand.find((b) => b.band === 'DIRECTOR_REVIEW');
  if (strong?.winRatePercent !== null && marginal?.winRatePercent !== null && strong && marginal) {
    observations.push(
      strong.winRatePercent! >= marginal.winRatePercent!
        ? `The bands predict: ${strong.winRatePercent}% win rate above ${BID_THRESHOLDS.bidAbove} against ${marginal.winRatePercent}% in the review band.`
        : `The bands are not predicting — jobs in the review band are winning more often (${marginal.winRatePercent}%) than jobs scored above ${BID_THRESHOLDS.bidAbove} (${strong.winRatePercent}%). The weights need revisiting.`,
    );
  }

  return {
    decided,
    bid,
    noBid,
    noBidRatePercent,
    declinedValueMinor,
    byBand,
    overrides,
    recurringConcerns: [...concernCounts.entries()]
      .map(([factor, count]) => ({ factor, count }))
      .sort((a, b) => b.count - a.count),
    observations,
  };
}
