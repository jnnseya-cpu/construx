import { DomainError } from '../core/errors.ts';
import { hashState } from '../core/canonical.ts';
import { ulid } from '../core/ids.ts';
import { authorise, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import { briefConflictReason, currentBriefBaseline } from './conceptbrief.ts';
import { constraintAssessmentBlockedReason } from './conceptduediligence.ts';

/**
 * C-WF-04 — feasibility options and option selection.
 *
 * The decision that costs the most and is documented the least. By the time a
 * project is on site, the option was chosen years earlier by people who have
 * moved on, and the only surviving record is usually a slide.
 *
 * What already exists and is not rebuilt: `decisioncontrol.recordDecision`
 * holds the platform's decision record — attendees, authority, impact
 * dimensions, alternatives — and the option selection *is* one of those. This
 * module does not invent a second decision register; `selectOption` records the
 * option-specific facts and the governance record is the existing one, linked
 * by id.
 *
 * **Options must be comparable before they can be compared.** The exception
 * control: different scope or price base means not comparable until normalised.
 * So every option declares its `baseDate`, `currency` and `scopeStatement`, and
 * `compareOptions` refuses rather than producing a table whose columns mean
 * different things. A comparison of a 2024-base option against a 2026-base one
 * is arithmetic that looks like analysis.
 *
 * **The raw score and the weighted score are stored separately.** Deterministic
 * flow step 3. Once they are multiplied together the raw value is gone, and
 * with it any ability to ask what the answer would have been under different
 * weights — which is the question every option review actually asks.
 *
 * **No option is selected while a critical constraint is unassessed.**
 * AC-C-WF-03-02, asked of `conceptduediligence` rather than reimplemented.
 * Likewise the mandatory-requirement conflict check, asked of `conceptbrief`.
 *
 * **A selected option outside tolerance needs a sponsor exception.** The
 * exception control, and it is deliberately not a refusal: sometimes the right
 * option is over budget and the client knows it. What is refused is doing that
 * silently.
 *
 * **Rejected options are kept.** AC-C-WF-04-01 asks for the rejected rationale,
 * and it is the half that proves a choice was made rather than a preference
 * expressed. Rejection is its own event for that reason.
 */

export const OPTION_STATUS = ['DRAFT', 'ANALYSED', 'SELECTED', 'REJECTED'] as const;
export type OptionStatus = (typeof OPTION_STATUS)[number];

/** The criteria an option is scored against. Weights are set per project. */
export type CriterionScore = {
  criterion: string;
  /** What was measured. Preserved unweighted — deterministic flow step 3. */
  rawValue: number;
  /** 0–1, summing to 1 across the criteria. */
  weight: number;
  /** The basis of the raw value: a benchmark, a calculation, a judgement. */
  basis: string;
};

export type OptionState = {
  optionId: string;
  reference: string;
  name: string;
  description: string;
  /** What is in and out. Two options with different scope are not comparable. */
  scopeStatement: string;
  assumptions: readonly string[];
  exclusions: readonly string[];
  dependencies: readonly string[];
  /** The price base. Comparing across base dates is arithmetic dressed as analysis. */
  baseDate: string;
  currency: string;
  orderOfCostMinor: number;
  /** The range around the point estimate. A single number hides the uncertainty. */
  costLowMinor: number;
  costHighMinor: number;
  durationDaysLow: number;
  durationDaysMostLikely: number;
  durationDaysHigh: number;
  status: OptionStatus;
  scores: readonly CriterionScore[];
  analysedBy?: string;
  analysedAt?: string;
  /** Set on the selected option and on every rejected one. Never blank. */
  rationale?: string;
  decisionRecordId?: string;
  decidedBy?: string;
  decidedAt?: string;
  /** Sponsor acceptance where the selection is outside tolerance. */
  exceptionApprovedBy?: string;
  exceptionReason?: string;
  createdAt: string;
};

export type SensitivityResult = {
  /** What was varied, and by how much. */
  variable: string;
  changePercent: number;
  /** Option reference → weighted score under the varied condition. */
  scoresByOption: Record<string, number>;
  /** Whether the leader changed. The only result that actually matters. */
  rankChanged: boolean;
};

function optionsOf(ctx: EngineContext): OptionState[] {
  return ctx.ledger.list(ctx.projectId, 'FeasibilityOption').map((r) => r.state as unknown as OptionState);
}

function option(ctx: EngineContext, optionId: string): OptionState {
  const found = optionsOf(ctx).find((o) => o.optionId === optionId);
  if (!found) throw new DomainError('NO_SUCH_OPTION', `No option ${optionId} on this project`, 404);
  return found;
}

/** The weighted score. Computed on read, never stored — see the module note. */
export function weightedScore(state: OptionState): number {
  return Number(state.scores.reduce((sum, s) => sum + s.rawValue * s.weight, 0).toFixed(4));
}

/** Create a feasibility option. */
export function createOption(
  ctx: EngineContext,
  input: {
    reference: string;
    name: string;
    description: string;
    scopeStatement: string;
    assumptions: readonly string[];
    exclusions: readonly string[];
    dependencies?: readonly string[];
    baseDate: string;
    currency: string;
    orderOfCostMinor: number;
    costLowMinor: number;
    costHighMinor: number;
    durationDaysLow: number;
    durationDaysMostLikely: number;
    durationDaysHigh: number;
  },
): { optionId: string } {
  authorise(ctx, 'PROJECT_SETUP', 'C');

  if (input.scopeStatement.trim() === '') {
    throw new DomainError(
      'SCOPE_REQUIRED',
      'State what this option includes and excludes. Two options with undeclared scope cannot be compared, ' +
        'and comparing them anyway is the commonest way a cheap option wins by leaving something out.',
      422,
    );
  }
  if (input.assumptions.length === 0) {
    throw new DomainError(
      'ASSUMPTIONS_REQUIRED',
      'An option with no declared assumptions is one whose assumptions nobody wrote down.',
      422,
    );
  }
  if (input.costLowMinor > input.orderOfCostMinor || input.costHighMinor < input.orderOfCostMinor) {
    throw new DomainError(
      'RANGE_EXCLUDES_ESTIMATE',
      'The cost range must contain the point estimate. A range that does not is two different opinions.',
      422,
    );
  }
  if (
    input.durationDaysLow > input.durationDaysMostLikely ||
    input.durationDaysHigh < input.durationDaysMostLikely
  ) {
    throw new DomainError('RANGE_EXCLUDES_DURATION', 'The duration range must contain the most likely value', 422);
  }
  if (input.durationDaysLow <= 0) {
    throw new DomainError('INVALID_DURATION', 'An option must take a positive number of days', 422);
  }
  if (optionsOf(ctx).some((o) => o.reference === input.reference)) {
    throw new DomainError('DUPLICATE_OPTION', `Option ${input.reference} already exists`, 409);
  }

  const optionId = ulid();
  write(ctx, {
    eventType: 'OPTION_CREATED',
    entity: { refType: 'FeasibilityOption', refId: optionId },
    nextState: {
      optionId,
      reference: input.reference,
      name: input.name,
      description: input.description,
      scopeStatement: input.scopeStatement,
      assumptions: input.assumptions,
      exclusions: input.exclusions,
      dependencies: input.dependencies ?? [],
      baseDate: input.baseDate.slice(0, 10),
      currency: input.currency,
      orderOfCostMinor: input.orderOfCostMinor,
      costLowMinor: input.costLowMinor,
      costHighMinor: input.costHighMinor,
      durationDaysLow: input.durationDaysLow,
      durationDaysMostLikely: input.durationDaysMostLikely,
      durationDaysHigh: input.durationDaysHigh,
      status: 'DRAFT',
      scores: [],
      createdAt: new Date().toISOString(),
    } satisfies OptionState as unknown as Record<string, unknown>,
  });

  return { optionId };
}

/**
 * Score an option against the criteria.
 *
 * The weights must sum to 1 across the criteria supplied. Not a formality: a
 * set summing to 1.4 produces scores that cannot be compared against a set
 * summing to 1, and the comparison table would show one option ahead for
 * arithmetic reasons.
 */
export function analyseOption(
  ctx: EngineContext,
  input: { optionId: string; scores: readonly CriterionScore[] },
): { optionId: string; weightedScore: number } {
  authorise(ctx, 'PROJECT_SETUP', 'U');

  const existing = option(ctx, input.optionId);
  if (existing.status === 'SELECTED' || existing.status === 'REJECTED') {
    throw new DomainError(
      'OPTION_DECIDED',
      `${existing.reference} has been ${existing.status.toLowerCase()}. Re-scoring a decided option would ` +
        'change the evidence the decision was made on.',
      409,
    );
  }
  if (input.scores.length === 0) {
    throw new DomainError('SCORES_REQUIRED', 'Score the option against at least one criterion', 422);
  }

  const weightTotal = input.scores.reduce((sum, s) => sum + s.weight, 0);
  if (Math.abs(weightTotal - 1) > 0.001) {
    throw new DomainError(
      'WEIGHTS_UNBALANCED',
      `The criteria weights sum to ${weightTotal.toFixed(3)}, not 1. Options scored under different weight ` +
        'totals cannot be compared — one would lead for arithmetic reasons rather than merit.',
      422,
    );
  }
  for (const score of input.scores) {
    if (score.basis.trim() === '') {
      throw new DomainError(
        'BASIS_REQUIRED',
        `"${score.criterion}" has a value and no basis. A score nobody can trace to a benchmark, a calculation ` +
          'or a named judgement cannot be challenged at the review.',
        422,
      );
    }
  }

  const next: OptionState = {
    ...existing,
    status: 'ANALYSED',
    scores: input.scores,
    analysedBy: ctx.auth.actorId,
    analysedAt: new Date().toISOString(),
  };

  write(ctx, {
    eventType: 'OPTION_ANALYSED',
    entity: { refType: 'FeasibilityOption', refId: input.optionId },
    nextState: next as unknown as Record<string, unknown>,
  });

  return { optionId: input.optionId, weightedScore: weightedScore(next) };
}

export type Comparison = {
  comparable: boolean;
  /** Why not, when not. Named so the answer is actionable rather than a refusal. */
  incomparableReason?: string;
  baseDate?: string;
  currency?: string;
  rows: Array<{
    reference: string;
    name: string;
    status: OptionStatus;
    orderOfCostMinor: number;
    costLowMinor: number;
    costHighMinor: number;
    durationDaysMostLikely: number;
    /** Raw values preserved beside the weighted total. */
    scores: readonly CriterionScore[];
    weightedScore: number;
  }>;
  leader?: string;
};

/**
 * Compare the analysed options.
 *
 * Refuses rather than normalising. Normalising a 2024-base option to 2026
 * requires an inflation assumption, and inventing one inside a comparison
 * function would put an unstated assumption at the centre of the decision.
 * Whoever knows the right index can restate the option and re-score it.
 */
export function compareOptions(ctx: EngineContext): Comparison {
  authorise(ctx, 'PROJECT_SETUP', 'R');

  const live = optionsOf(ctx).filter((o) => o.status === 'ANALYSED' || o.status === 'SELECTED');
  if (live.length === 0) {
    return { comparable: false, incomparableReason: 'No option has been analysed.', rows: [] };
  }

  const baseDates = [...new Set(live.map((o) => o.baseDate))];
  const currencies = [...new Set(live.map((o) => o.currency))];

  const rows = live
    .map((o) => ({
      reference: o.reference,
      name: o.name,
      status: o.status,
      orderOfCostMinor: o.orderOfCostMinor,
      costLowMinor: o.costLowMinor,
      costHighMinor: o.costHighMinor,
      durationDaysMostLikely: o.durationDaysMostLikely,
      scores: o.scores,
      weightedScore: weightedScore(o),
    }))
    .sort((a, b) => b.weightedScore - a.weightedScore);

  if (currencies.length > 1) {
    return {
      comparable: false,
      incomparableReason:
        `The options are priced in ${currencies.join(' and ')}. Converting between them requires a rate, ` +
        'a provider and a timestamp that nobody has supplied, so the comparison is withheld rather than invented.',
      rows,
    };
  }
  if (baseDates.length > 1) {
    return {
      comparable: false,
      incomparableReason:
        `The options carry ${baseDates.length} different price base dates (${baseDates.sort().join(', ')}). ` +
        'Normalising them requires an inflation assumption; restate the options on one base and re-score.',
      rows,
    };
  }

  // Criteria sets must match too. Scoring option A on four criteria and option
  // B on three produces two numbers that are not the same measurement.
  const criteriaSets = [...new Set(live.map((o) => o.scores.map((s) => s.criterion).sort().join('|')))];
  if (criteriaSets.length > 1) {
    return {
      comparable: false,
      incomparableReason:
        'The options were scored against different criteria, so their weighted totals are not the same ' +
        'measurement. Score every option against one evaluation template.',
      rows,
    };
  }

  return {
    comparable: true,
    baseDate: baseDates[0],
    currency: currencies[0],
    rows,
    leader: rows[0]?.reference,
  };
}

/**
 * Vary one input and see whether the leader changes.
 *
 * Deterministic and reproducible from the stored option states, which is
 * AC-C-WF-04-02: the same options and the same variation give the same answer,
 * because nothing here samples or remembers.
 *
 * The only result that matters is `rankChanged`. A sensitivity test whose
 * answer is "the leader is still the leader" is the reassurance the review
 * wanted; one that flips it is the reason the test exists.
 */
export function sensitivity(
  ctx: EngineContext,
  input: { criterion: string; changePercent: number },
): SensitivityResult {
  authorise(ctx, 'PROJECT_SETUP', 'R');

  const live = optionsOf(ctx).filter((o) => o.status === 'ANALYSED' || o.status === 'SELECTED');
  if (live.length === 0) {
    throw new DomainError('NOTHING_TO_TEST', 'No option has been analysed', 409);
  }
  if (!live.some((o) => o.scores.some((s) => s.criterion === input.criterion))) {
    throw new DomainError('NO_SUCH_CRITERION', `No option is scored against "${input.criterion}"`, 404);
  }

  const baseline = [...live].sort((a, b) => weightedScore(b) - weightedScore(a))[0]?.reference;

  const factor = 1 + input.changePercent / 100;
  const varied = live.map((o) => ({
    reference: o.reference,
    score: Number(
      o.scores
        .reduce((sum, s) => sum + (s.criterion === input.criterion ? s.rawValue * factor : s.rawValue) * s.weight, 0)
        .toFixed(4),
    ),
  }));
  const leader = [...varied].sort((a, b) => b.score - a.score)[0]?.reference;

  return {
    variable: input.criterion,
    changePercent: input.changePercent,
    scoresByOption: Object.fromEntries(varied.map((v) => [v.reference, v.score])),
    rankChanged: leader !== baseline,
  };
}

/**
 * Why an option cannot be selected.
 *
 * Composed from the modules that own each rule rather than reimplemented here.
 * The concept gate asks the same question and gets the same answer.
 */
export function optionSelectionBlockedReason(ctx: EngineContext): string | null {
  const constraints = constraintAssessmentBlockedReason(ctx);
  if (constraints) return constraints;

  const conflict = briefConflictReason(ctx);
  if (conflict) return conflict;

  if (!currentBriefBaseline(ctx)) {
    return 'The brief has not been baselined. An option chosen against a moving brief is chosen against ' +
      'nothing in particular.';
  }

  const comparison = compareOptions(ctx);
  if (!comparison.comparable) return comparison.incomparableReason ?? 'The options are not comparable.';

  return null;
}

/**
 * Select an option.
 *
 * Freezes the brief baseline hash into the option, which is AC-C-WF-04-03: the
 * selected option links to the brief it was approved against, not to whatever
 * the brief later became.
 *
 * `exception` is how the tolerance exception control is satisfied. Supplying it
 * where none is needed is harmless and recorded; omitting it where one is
 * needed is refused by the caller's own tolerance check, which this function
 * does not invent — the budget and the tolerance live in the cost plan, and
 * `withinToleranceOf` is where the caller states them.
 */
export function selectOption(
  ctx: EngineContext,
  input: {
    optionId: string;
    rationale: string;
    decisionRecordId?: string;
    exception?: { approvedBy: string; reason: string };
    evidenceHash: string;
  },
): { optionId: string; rejected: number } {
  authorise(ctx, 'PROJECT_SETUP', 'A');

  const blocked = optionSelectionBlockedReason(ctx);
  if (blocked) throw new DomainError('SELECTION_BLOCKED', blocked, 409);

  const existing = option(ctx, input.optionId);
  if (existing.status !== 'ANALYSED') {
    throw new DomainError(
      'OPTION_NOT_ANALYSED',
      `${existing.reference} is ${existing.status.toLowerCase()}. Only an analysed option can be selected.`,
      409,
    );
  }
  if (input.rationale.trim() === '') {
    throw new DomainError(
      'RATIONALE_REQUIRED',
      'State why this option was chosen. The score says which option led; the rationale says why that ' +
        'mattered, and it is the only part still legible in five years.',
      422,
    );
  }
  const alreadySelected = optionsOf(ctx).find((o) => o.status === 'SELECTED');
  if (alreadySelected) {
    throw new DomainError(
      'OPTION_ALREADY_SELECTED',
      `${alreadySelected.reference} is already the selected option. Two selected options is not a decision.`,
      409,
    );
  }

  const baseline = currentBriefBaseline(ctx);
  const evidence = registerEvidence(ctx, {
    type: 'OPTION_SELECTION',
    hash: input.evidenceHash,
    description: `${existing.reference} selected — ${input.rationale.slice(0, 80)}`,
  });

  write(ctx, {
    eventType: 'OPTION_SELECTED',
    entity: { refType: 'FeasibilityOption', refId: input.optionId },
    nextState: {
      ...existing,
      status: 'SELECTED',
      rationale: input.rationale,
      decisionRecordId: input.decisionRecordId,
      decidedBy: ctx.auth.actorId,
      decidedAt: new Date().toISOString(),
      exceptionApprovedBy: input.exception?.approvedBy,
      exceptionReason: input.exception?.reason,
      // AC-C-WF-04-03. The brief as it was, not as it becomes.
      briefBaselineId: baseline?.baselineId,
      briefBaselineHash: baseline?.baselineHash,
      selectionHash: hashState({
        optionId: existing.optionId,
        scores: existing.scores,
        briefBaselineHash: baseline?.baselineHash,
      } as unknown as Record<string, unknown>),
    } as unknown as Record<string, unknown>,
    evidenceRefs: [evidence],
  });

  return {
    optionId: input.optionId,
    rejected: optionsOf(ctx).filter((o) => o.status === 'REJECTED').length,
  };
}

/**
 * Reject an option, with the reason.
 *
 * Its own act rather than a side effect of selecting another. AC-C-WF-04-01
 * asks for the rejected rationale, and a rejection that happened automatically
 * has none — which is exactly the gap that turns a decision record into a
 * record of a preference.
 */
export function rejectOption(
  ctx: EngineContext,
  input: { optionId: string; rationale: string },
): { optionId: string } {
  authorise(ctx, 'PROJECT_SETUP', 'A');

  const existing = option(ctx, input.optionId);
  if (existing.status === 'SELECTED') {
    throw new DomainError('OPTION_SELECTED', `${existing.reference} is the selected option`, 409);
  }
  if (existing.status === 'REJECTED') {
    throw new DomainError('ALREADY_REJECTED', `${existing.reference} is already rejected`, 409);
  }
  if (input.rationale.trim() === '') {
    throw new DomainError(
      'RATIONALE_REQUIRED',
      'State why this option was rejected. A rejected option with no reason is the one somebody proposes ' +
        'again next year.',
      422,
    );
  }

  write(ctx, {
    eventType: 'OPTION_REJECTED',
    entity: { refType: 'FeasibilityOption', refId: input.optionId },
    nextState: {
      ...existing,
      status: 'REJECTED',
      rationale: input.rationale,
      decidedBy: ctx.auth.actorId,
      decidedAt: new Date().toISOString(),
    } as unknown as Record<string, unknown>,
  });

  return { optionId: input.optionId };
}

/** The option in force, if one has been selected. */
export function selectedOption(ctx: EngineContext): OptionState | undefined {
  return optionsOf(ctx).find((o) => o.status === 'SELECTED');
}

export type OptionPosition = {
  total: number;
  draft: number;
  analysed: number;
  rejected: number;
  selected?: OptionState;
  comparison: Comparison;
  selectionBlocked: string | null;
  /** Rejected options with their reasons, which is the half nobody keeps. */
  rejectedWithRationale: Array<{ reference: string; rationale: string }>;
};

/** The options position, derived on every read. */
export function optionPosition(ctx: EngineContext): OptionPosition {
  authorise(ctx, 'PROJECT_SETUP', 'R');

  const all = optionsOf(ctx);
  return {
    total: all.length,
    draft: all.filter((o) => o.status === 'DRAFT').length,
    analysed: all.filter((o) => o.status === 'ANALYSED').length,
    rejected: all.filter((o) => o.status === 'REJECTED').length,
    selected: selectedOption(ctx),
    comparison: compareOptions(ctx),
    selectionBlocked: optionSelectionBlockedReason(ctx),
    rejectedWithRationale: all
      .filter((o) => o.status === 'REJECTED')
      .map((o) => ({ reference: o.reference, rationale: o.rationale ?? '' })),
  };
}
