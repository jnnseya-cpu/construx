import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import { currentConfiguration } from './conceptinitiation.ts';
import { selectedOption } from './conceptoptions.ts';

/**
 * C-WF-05 — concept cost, programme and cashflow baseline.
 *
 * The first numbers anybody outside the project will ever quote, and the ones
 * a business case is approved on. They are almost always wrong, which is fine;
 * what is not fine is being wrong without saying by how much.
 *
 * What already exists and is not rebuilt: the *tender* estimate across twenty
 * cost heads (`engines/tender.ts`), the bid cash-flow model, the live forward
 * cash flow (`CASHFLOW_FORECAST_UPDATED`), the delivery programme baseline
 * (`PROGRAMME_BASELINE_APPROVED`) and the Monte Carlo completion forecast
 * (`engines/maths/montecarlo.ts`). All of those operate on a project that has a
 * contract, a bill of quantities and a network of activities. None of that
 * exists at concept, which is the whole difficulty of this stage: the numbers
 * are needed before anything that produces them exists.
 *
 * **Every rate carries a source and a base date, or it is provisional.** The
 * exception control says an unverified rate is excluded from the
 * high-confidence total, and that is implemented as two totals rather than one
 * with a caveat: `verifiedTotalMinor` and `totalMinor`. A single total with a
 * footnote is a single total.
 *
 * **Ranges, not points.** AC-C-WF-05-03 asks for P50/P80 with method and
 * assumptions. This platform will not produce a confidence figure it cannot
 * derive: the cost plan carries low/most-likely/high per line, and the
 * confidence range is computed from them by a stated method
 * (`RANGE_METHOD`) rather than asserted. Where a line has no range, the range
 * is the point — and the plan says how many lines that is, because a P80 built
 * from point estimates is a P80 of nothing.
 *
 * **Cost and programme are approved together.** The exception control, and it
 * is one command over both. Time-related cost is material on every construction
 * project, so approving a programme without the cost of it — or a cost without
 * the duration it assumes — is approving half of a coupled pair.
 *
 * **A programme activity with no logic is declared, not hidden.**
 * AC-C-WF-05-02 allows an open start or finish where it is documented. So the
 * milestone programme refuses an undeclared dangler and accepts a declared one.
 *
 * **Currency conversion stores rate, provider and timestamp.** The exception
 * control. There is no conversion here: a cost plan is in one currency, the
 * project's. What is enforced is that it *is* the project's — a plan priced in
 * a currency the configuration does not declare is a conversion waiting to
 * happen with no rate recorded.
 */

/** The elemental structure. Mapped to CBS/WBS by `wbsCode` on each line. */
export const COST_CATEGORY = [
  'SUBSTRUCTURE',
  'SUPERSTRUCTURE',
  'FINISHES',
  'SERVICES',
  'EXTERNAL_WORKS',
  'PRELIMINARIES',
  'DESIGN_FEES',
  'CLIENT_COSTS',
  'RISK_ALLOWANCE',
  'CONTINGENCY',
  'INFLATION',
  'TAX_DUTIES',
] as const;
export type CostCategory = (typeof COST_CATEGORY)[number];

/**
 * How a confidence range is derived from the line ranges.
 *
 * Named on the plan so AC-C-WF-05-03's "show method" is satisfied by a value
 * rather than by prose. `PERT` is the three-point weighting; `TRIANGULAR` is the
 * unweighted mean. Both are stated arithmetic over the stored ranges, which is
 * why they can be reproduced.
 */
export const RANGE_METHOD = ['PERT', 'TRIANGULAR'] as const;
export type RangeMethod = (typeof RANGE_METHOD)[number];

export type CostLine = {
  lineId: string;
  wbsCode: string;
  category: CostCategory;
  description: string;
  quantity: number;
  unit: string;
  rateMinor: number;
  /** The benchmark, tender or judgement behind the rate. Blank makes it provisional. */
  rateSource: string;
  rateBaseDate: string;
  /** Location factor applied to the benchmark, where one was. 1 means none. */
  locationFactor: number;
  lowMinor: number;
  mostLikelyMinor: number;
  highMinor: number;
  /** False where the rate has a named source and a base date. */
  provisional: boolean;
  addedBy: string;
  addedAt: string;
};

export type ConceptCostPlanState = {
  costPlanId: string;
  projectId: string;
  version: number;
  optionId: string;
  currency: string;
  baseDate: string;
  rangeMethod: RangeMethod;
  lines: readonly CostLine[];
  /** The client's cap, and how far outside it the plan may sit before exception. */
  budgetCapMinor?: number;
  tolerancePercent: number;
  createdBy: string;
  createdAt: string;
};

export type ProgrammeMilestone = {
  milestoneId: string;
  reference: string;
  name: string;
  plannedDate: string;
  /** Milestone references this one follows. Empty needs `openStartReason`. */
  predecessors: readonly string[];
  /** Why this milestone legitimately has no predecessor. AC-C-WF-05-02. */
  openStartReason?: string;
  /** Why nothing follows it. Same rule at the other end. */
  openFinishReason?: string;
  /** Statutory gateways cannot be bypassed. Set by C-WF-07's screening. */
  statutory: boolean;
  leadTimeDays?: number;
};

export type MilestoneProgrammeState = {
  programmeId: string;
  projectId: string;
  version: number;
  optionId: string;
  dataDate: string;
  milestones: readonly ProgrammeMilestone[];
  createdBy: string;
  createdAt: string;
};

export type CashflowPeriod = {
  period: string;
  spendMinor: number;
  cumulativeMinor: number;
  /** Funding available in the period, where the client has stated a drawdown. */
  fundingMinor?: number;
};

export type ConceptCashflowState = {
  cashflowId: string;
  projectId: string;
  version: number;
  costPlanId: string;
  programmeId: string;
  currency: string;
  periods: readonly CashflowPeriod[];
  peakExposureMinor: number;
  generatedBy: string;
  generatedAt: string;
};

export type ConceptControlsState = {
  controlsId: string;
  projectId: string;
  version: number;
  costPlanId: string;
  programmeId: string;
  cashflowId: string;
  /** The one declared cut-off both halves share. 6.4 asks for exactly this. */
  cutOffDate: string;
  totalMinor: number;
  verifiedTotalMinor: number;
  p50Minor: number;
  p80Minor: number;
  rangeMethod: RangeMethod;
  affordabilityGapMinor: number;
  affordabilityActions: readonly string[];
  approvedBy: string;
  approvedAt: string;
  supersedes?: string;
};

function plansOf(ctx: EngineContext): ConceptCostPlanState[] {
  return ctx.ledger
    .list(ctx.projectId, 'ConceptCostPlan')
    .map((r) => r.state as unknown as ConceptCostPlanState)
    .sort((a, b) => a.version - b.version);
}

function programmesOf(ctx: EngineContext): MilestoneProgrammeState[] {
  return ctx.ledger
    .list(ctx.projectId, 'MilestoneProgramme')
    .map((r) => r.state as unknown as MilestoneProgrammeState)
    .sort((a, b) => a.version - b.version);
}

function cashflowsOf(ctx: EngineContext): ConceptCashflowState[] {
  return ctx.ledger
    .list(ctx.projectId, 'ConceptCashflow')
    .map((r) => r.state as unknown as ConceptCashflowState)
    .sort((a, b) => a.version - b.version);
}

function controlsOf(ctx: EngineContext): ConceptControlsState[] {
  return ctx.ledger
    .list(ctx.projectId, 'ConceptControls')
    .map((r) => r.state as unknown as ConceptControlsState)
    .sort((a, b) => a.version - b.version);
}

export function currentCostPlan(ctx: EngineContext): ConceptCostPlanState | undefined {
  return plansOf(ctx).at(-1);
}
export function currentMilestoneProgramme(ctx: EngineContext): MilestoneProgrammeState | undefined {
  return programmesOf(ctx).at(-1);
}
export function currentConceptCashflow(ctx: EngineContext): ConceptCashflowState | undefined {
  return cashflowsOf(ctx).at(-1);
}
export function currentConceptControls(ctx: EngineContext): ConceptControlsState | undefined {
  return controlsOf(ctx).at(-1);
}

/**
 * Totals over a cost plan.
 *
 * Four numbers, and the distinction between them is the whole point:
 * `totalMinor` is what the plan says, `verifiedTotalMinor` is the part of it
 * with a source behind it, and the P50/P80 are derived from the stored ranges
 * by the plan's declared method.
 */
export function costTotals(plan: ConceptCostPlanState): {
  totalMinor: number;
  verifiedTotalMinor: number;
  provisionalLines: number;
  pointOnlyLines: number;
  p50Minor: number;
  p80Minor: number;
} {
  const totalMinor = plan.lines.reduce((sum, l) => sum + l.mostLikelyMinor, 0);
  const verifiedTotalMinor = plan.lines
    .filter((l) => !l.provisional)
    .reduce((sum, l) => sum + l.mostLikelyMinor, 0);

  // P50 by the declared method. PERT weights the most likely four times, which
  // is the standard three-point estimate; TRIANGULAR is the plain mean.
  const p50Minor = Math.round(
    plan.lines.reduce((sum, l) => {
      if (plan.rangeMethod === 'PERT') return sum + (l.lowMinor + 4 * l.mostLikelyMinor + l.highMinor) / 6;
      return sum + (l.lowMinor + l.mostLikelyMinor + l.highMinor) / 3;
    }, 0),
  );

  // P80 from the aggregate standard deviation, lines treated as independent.
  //
  // Independence is an assumption and a generous one — construction cost lines
  // correlate, so a real P80 is wider than this. It is stated here rather than
  // buried because the alternative was to state no method at all, and
  // AC-C-WF-05-03 asks for the method precisely so that somebody can disagree
  // with it.
  const variance = plan.lines.reduce((sum, l) => {
    const sigma = (l.highMinor - l.lowMinor) / 6;
    return sum + sigma * sigma;
  }, 0);
  const p80Minor = Math.round(p50Minor + 0.8416 * Math.sqrt(variance));

  return {
    totalMinor,
    verifiedTotalMinor,
    provisionalLines: plan.lines.filter((l) => l.provisional).length,
    pointOnlyLines: plan.lines.filter((l) => l.lowMinor === l.highMinor).length,
    p50Minor,
    p80Minor,
  };
}

/** Open a concept cost plan against the selected option. */
export function createCostPlan(
  ctx: EngineContext,
  input: {
    baseDate: string;
    rangeMethod?: RangeMethod;
    budgetCapMinor?: number;
    tolerancePercent?: number;
  },
): { costPlanId: string; version: number } {
  authorise(ctx, 'BUDGET_COST', 'C');

  const configuration = currentConfiguration(ctx);
  if (!configuration) throw new DomainError('NOT_CONFIGURED', 'The project has no configuration', 409);

  const option = selectedOption(ctx);
  if (!option) {
    throw new DomainError(
      'NO_SELECTED_OPTION',
      'No option has been selected. A concept cost plan prices a decision, and there is not one yet.',
      409,
    );
  }
  if (option.currency !== configuration.reportingCurrency) {
    throw new DomainError(
      'CURRENCY_MISMATCH',
      `The selected option is priced in ${option.currency} and the project reports in ` +
        `${configuration.reportingCurrency}. Converting requires a rate, a provider and a timestamp that ` +
        'nobody has supplied.',
      422,
    );
  }

  const previous = currentCostPlan(ctx);
  const costPlanId = ulid();
  write(ctx, {
    eventType: 'COST_PLAN_CREATED',
    entity: { refType: 'ConceptCostPlan', refId: costPlanId },
    nextState: {
      costPlanId,
      projectId: ctx.projectId,
      version: (previous?.version ?? 0) + 1,
      optionId: option.optionId,
      currency: configuration.reportingCurrency,
      baseDate: input.baseDate.slice(0, 10),
      rangeMethod: input.rangeMethod ?? 'PERT',
      lines: [],
      budgetCapMinor: input.budgetCapMinor,
      tolerancePercent: input.tolerancePercent ?? 5,
      createdBy: ctx.auth.actorId,
      createdAt: new Date().toISOString(),
    } satisfies ConceptCostPlanState as unknown as Record<string, unknown>,
  });

  return { costPlanId, version: (previous?.version ?? 0) + 1 };
}

/**
 * Add a line to the cost plan.
 *
 * `provisional` is derived, not supplied. A line with a named source and a base
 * date is verified; anything else is provisional and excluded from the
 * high-confidence total. Letting the caller assert it would make the exception
 * control a matter of opinion.
 */
export function addCostLine(
  ctx: EngineContext,
  input: {
    wbsCode: string;
    category: CostCategory;
    description: string;
    quantity: number;
    unit: string;
    rateMinor: number;
    rateSource?: string;
    rateBaseDate?: string;
    locationFactor?: number;
    lowMinor?: number;
    highMinor?: number;
  },
): { lineId: string; provisional: boolean; totalMinor: number } {
  authorise(ctx, 'BUDGET_COST', 'U');

  const plan = currentCostPlan(ctx);
  if (!plan) throw new DomainError('NO_COST_PLAN', 'No concept cost plan exists on this project', 409);

  if (input.quantity <= 0) throw new DomainError('INVALID_QUANTITY', 'Quantity must be positive', 422);
  if (input.rateMinor < 0) throw new DomainError('INVALID_RATE', 'A rate cannot be negative', 422);
  if (plan.lines.some((l) => l.wbsCode === input.wbsCode)) {
    throw new DomainError(
      'DUPLICATE_WBS',
      `${input.wbsCode} is already in this plan. Two lines on one code is how a total double-counts.`,
      409,
    );
  }

  const factor = input.locationFactor ?? 1;
  const mostLikelyMinor = Math.round(input.quantity * input.rateMinor * factor);
  const lowMinor = input.lowMinor ?? mostLikelyMinor;
  const highMinor = input.highMinor ?? mostLikelyMinor;
  if (lowMinor > mostLikelyMinor || highMinor < mostLikelyMinor) {
    throw new DomainError('RANGE_EXCLUDES_ESTIMATE', 'The range must contain the computed most-likely value', 422);
  }

  const provisional = (input.rateSource ?? '').trim() === '' || (input.rateBaseDate ?? '').trim() === '';

  const lineId = ulid();
  const line: CostLine = {
    lineId,
    wbsCode: input.wbsCode,
    category: input.category,
    description: input.description,
    quantity: input.quantity,
    unit: input.unit,
    rateMinor: input.rateMinor,
    rateSource: input.rateSource ?? '',
    rateBaseDate: (input.rateBaseDate ?? '').slice(0, 10),
    locationFactor: factor,
    lowMinor,
    mostLikelyMinor,
    highMinor,
    provisional,
    addedBy: ctx.auth.actorId,
    addedAt: new Date().toISOString(),
  };

  const next: ConceptCostPlanState = { ...plan, lines: [...plan.lines, line] };
  write(ctx, {
    eventType: 'COST_PLAN_LINE_ADDED',
    entity: { refType: 'ConceptCostPlan', refId: plan.costPlanId },
    nextState: next as unknown as Record<string, unknown>,
  });

  return { lineId, provisional, totalMinor: costTotals(next).totalMinor };
}

/**
 * Create the milestone programme.
 *
 * Refuses a dangling milestone unless the dangle is declared. AC-C-WF-05-02
 * permits an open start or finish; what it does not permit is one nobody
 * noticed, which is the ordinary way a concept programme ends up with three
 * unconnected islands and a completion date computed from one of them.
 */
export function createMilestoneProgramme(
  ctx: EngineContext,
  input: {
    dataDate: string;
    milestones: ReadonlyArray<{
      reference: string;
      name: string;
      plannedDate: string;
      predecessors?: readonly string[];
      openStartReason?: string;
      openFinishReason?: string;
      statutory?: boolean;
      leadTimeDays?: number;
    }>;
  },
): { programmeId: string; version: number; milestones: number } {
  authorise(ctx, 'PROGRAMME_BASELINES', 'C');

  const option = selectedOption(ctx);
  if (!option) {
    throw new DomainError(
      'NO_SELECTED_OPTION',
      'No option has been selected. A concept programme is the duration of a decision.',
      409,
    );
  }
  if (input.milestones.length === 0) {
    throw new DomainError('NO_MILESTONES', 'A programme with no milestones has no dates in it', 422);
  }

  const references = new Set(input.milestones.map((m) => m.reference));
  if (references.size !== input.milestones.length) {
    throw new DomainError('DUPLICATE_MILESTONE', 'Two milestones share a reference', 409);
  }

  const hasSuccessor = new Set<string>();
  for (const milestone of input.milestones) {
    for (const predecessor of milestone.predecessors ?? []) {
      if (!references.has(predecessor)) {
        throw new DomainError(
          'UNKNOWN_PREDECESSOR',
          `${milestone.reference} follows ${predecessor}, which is not in this programme.`,
          422,
        );
      }
      hasSuccessor.add(predecessor);
    }
  }

  for (const milestone of input.milestones) {
    const openStart = (milestone.predecessors ?? []).length === 0;
    if (openStart && (milestone.openStartReason ?? '').trim() === '') {
      throw new DomainError(
        'UNDECLARED_OPEN_START',
        `${milestone.reference} has no predecessor and no reason for having none. An undeclared open start ` +
          'is how a programme ends up as unconnected islands with a completion date computed from one of them.',
        422,
      );
    }
    if (!hasSuccessor.has(milestone.reference) && (milestone.openFinishReason ?? '').trim() === '') {
      throw new DomainError(
        'UNDECLARED_OPEN_FINISH',
        `Nothing follows ${milestone.reference} and no reason is given. Declare it as the end of the ` +
          'programme, or connect it.',
        422,
      );
    }
    // A milestone dated before something it follows is a logic error the
    // programme would otherwise carry silently into every later forecast.
    for (const predecessor of milestone.predecessors ?? []) {
      const before = input.milestones.find((m) => m.reference === predecessor);
      if (before && before.plannedDate > milestone.plannedDate) {
        throw new DomainError(
          'IMPOSSIBLE_LOGIC',
          `${milestone.reference} (${milestone.plannedDate.slice(0, 10)}) follows ${predecessor} ` +
            `(${before.plannedDate.slice(0, 10)}) but is dated earlier.`,
          422,
        );
      }
    }
  }

  const previous = currentMilestoneProgramme(ctx);
  const programmeId = ulid();
  const version = (previous?.version ?? 0) + 1;
  write(ctx, {
    eventType: 'MILESTONE_PROGRAMME_CREATED',
    entity: { refType: 'MilestoneProgramme', refId: programmeId },
    nextState: {
      programmeId,
      projectId: ctx.projectId,
      version,
      optionId: option.optionId,
      dataDate: input.dataDate.slice(0, 10),
      milestones: input.milestones.map((m) => ({
        milestoneId: ulid(),
        reference: m.reference,
        name: m.name,
        plannedDate: m.plannedDate.slice(0, 10),
        predecessors: m.predecessors ?? [],
        openStartReason: m.openStartReason,
        openFinishReason: m.openFinishReason,
        statutory: m.statutory ?? false,
        leadTimeDays: m.leadTimeDays,
      })),
      createdBy: ctx.auth.actorId,
      createdAt: new Date().toISOString(),
    } satisfies MilestoneProgrammeState as unknown as Record<string, unknown>,
  });

  return { programmeId, version, milestones: input.milestones.length };
}

/**
 * Time-phase the cost plan against the programme.
 *
 * The periods are supplied rather than computed. A spend curve is a judgement
 * about how work loads across a programme, and deriving one from milestone
 * dates alone would be a guess presented as arithmetic. What this enforces is
 * that the curve adds up to the plan — a cashflow that does not reconcile to
 * its own cost plan is two documents.
 */
export function generateCashflow(
  ctx: EngineContext,
  input: { periods: ReadonlyArray<{ period: string; spendMinor: number; fundingMinor?: number }> },
): { cashflowId: string; version: number; peakExposureMinor: number } {
  authorise(ctx, 'BUDGET_COST', 'C');

  const plan = currentCostPlan(ctx);
  if (!plan) throw new DomainError('NO_COST_PLAN', 'No concept cost plan exists on this project', 409);
  const programme = currentMilestoneProgramme(ctx);
  if (!programme) throw new DomainError('NO_PROGRAMME', 'No milestone programme exists on this project', 409);
  if (input.periods.length === 0) {
    throw new DomainError('NO_PERIODS', 'A cashflow with no periods forecasts nothing', 422);
  }

  const totals = costTotals(plan);
  const phased = input.periods.reduce((sum, p) => sum + p.spendMinor, 0);
  if (phased !== totals.totalMinor) {
    throw new DomainError(
      'CASHFLOW_UNRECONCILED',
      `The phased spend totals ${phased} against a cost plan of ${totals.totalMinor}. A cashflow that does ` +
        'not reconcile to its own cost plan is a second, quieter budget.',
      422,
    );
  }

  let cumulative = 0;
  let peak = 0;
  const periods: CashflowPeriod[] = input.periods.map((p) => {
    cumulative += p.spendMinor;
    // Exposure is spend ahead of funding — the number that says when the client
    // needs money in the account, which is the whole reason to phase at all.
    const funded = p.fundingMinor ?? 0;
    peak = Math.max(peak, cumulative - funded);
    return { period: p.period, spendMinor: p.spendMinor, cumulativeMinor: cumulative, fundingMinor: p.fundingMinor };
  });

  const previous = currentConceptCashflow(ctx);
  const cashflowId = ulid();
  const version = (previous?.version ?? 0) + 1;
  write(ctx, {
    eventType: 'CONCEPT_CASHFLOW_GENERATED',
    entity: { refType: 'ConceptCashflow', refId: cashflowId },
    nextState: {
      cashflowId,
      projectId: ctx.projectId,
      version,
      costPlanId: plan.costPlanId,
      programmeId: programme.programmeId,
      currency: plan.currency,
      periods,
      peakExposureMinor: peak,
      generatedBy: ctx.auth.actorId,
      generatedAt: new Date().toISOString(),
    } satisfies ConceptCashflowState as unknown as Record<string, unknown>,
  });

  return { cashflowId, version, peakExposureMinor: peak };
}

/**
 * Why the concept controls cannot be approved.
 *
 * Read by the command and by the concept gate. The affordability gap is not
 * among the reasons: a project can be legitimately unaffordable at concept and
 * approved anyway with actions against the gap. What is refused is approving it
 * without saying so.
 */
export function conceptControlsBlockedReason(ctx: EngineContext): string | null {
  const plan = currentCostPlan(ctx);
  if (!plan) return 'No concept cost plan exists.';
  if (plan.lines.length === 0) return 'The cost plan has no lines. There is nothing to approve.';

  const programme = currentMilestoneProgramme(ctx);
  if (!programme) return 'No milestone programme exists.';

  const cashflow = currentConceptCashflow(ctx);
  if (!cashflow) return 'No cashflow has been generated.';

  // The coupling check. A cashflow generated against an earlier cost plan is
  // the commonest way the two drift: somebody adds a line and nobody re-phases.
  if (cashflow.costPlanId !== plan.costPlanId) {
    return 'The cashflow was generated against an earlier cost plan. Re-phase it against the current one.';
  }
  if (cashflow.programmeId !== programme.programmeId) {
    return 'The cashflow was generated against an earlier programme. Re-phase it against the current one.';
  }

  const totals = costTotals(plan);
  const phased = cashflow.periods.reduce((sum, p) => sum + p.spendMinor, 0);
  if (phased !== totals.totalMinor) {
    return `The cashflow totals ${phased} against a cost plan of ${totals.totalMinor}.`;
  }

  // AC-C-WF-05-01. Every line must reconcile to the selected option, which is
  // what makes the total the price of the decision rather than of something
  // adjacent to it.
  const option = selectedOption(ctx);
  if (!option) return 'No option is selected.';
  if (plan.optionId !== option.optionId) {
    return 'The cost plan prices an option that is not the selected one.';
  }
  if (programme.optionId !== option.optionId) {
    return 'The programme is for an option that is not the selected one.';
  }

  return null;
}

/**
 * Approve cost, programme and cashflow together, under one cut-off.
 *
 * The exception control forbids approving cost and programme independently
 * where time-related cost is material, so there is one command and no way to
 * approve half. The cut-off date is declared here and is the date the 6.4 gate
 * checks every other snapshot against.
 */
export function approveConceptControls(
  ctx: EngineContext,
  input: { cutOffDate: string; affordabilityActions?: readonly string[]; evidenceHash: string },
): {
  controlsId: string;
  version: number;
  totalMinor: number;
  p80Minor: number;
  affordabilityGapMinor: number;
} {
  authorise(ctx, 'BUDGET_COST', 'A');

  const blocked = conceptControlsBlockedReason(ctx);
  if (blocked) throw new DomainError('CONTROLS_NOT_READY', blocked, 409);

  const plan = currentCostPlan(ctx) as ConceptCostPlanState;
  const programme = currentMilestoneProgramme(ctx) as MilestoneProgrammeState;
  const cashflow = currentConceptCashflow(ctx) as ConceptCashflowState;
  const totals = costTotals(plan);

  // The affordability gap, against the cap if the client set one. Positive
  // means over. An approval with a gap and no actions is what the deterministic
  // flow's step 5 forbids.
  const gap = plan.budgetCapMinor === undefined ? 0 : totals.p80Minor - plan.budgetCapMinor;
  const actions = input.affordabilityActions ?? [];
  if (gap > 0 && actions.length === 0) {
    throw new DomainError(
      'AFFORDABILITY_UNADDRESSED',
      `At P80 the plan is ${gap} over the budget cap of ${plan.budgetCapMinor}. Record what will be done ` +
        'about it. An approved gap with no actions is a gap somebody has decided to discover later.',
      422,
    );
  }

  const evidence = registerEvidence(ctx, {
    type: 'CONCEPT_CONTROLS',
    hash: input.evidenceHash,
    description: `Concept controls approved at cut-off ${input.cutOffDate.slice(0, 10)}`,
  });

  const previous = currentConceptControls(ctx);
  const controlsId = ulid();
  const state: ConceptControlsState = {
    controlsId,
    projectId: ctx.projectId,
    version: (previous?.version ?? 0) + 1,
    costPlanId: plan.costPlanId,
    programmeId: programme.programmeId,
    cashflowId: cashflow.cashflowId,
    cutOffDate: input.cutOffDate.slice(0, 10),
    totalMinor: totals.totalMinor,
    verifiedTotalMinor: totals.verifiedTotalMinor,
    p50Minor: totals.p50Minor,
    p80Minor: totals.p80Minor,
    rangeMethod: plan.rangeMethod,
    affordabilityGapMinor: gap,
    affordabilityActions: actions,
    approvedBy: ctx.auth.actorId,
    approvedAt: new Date().toISOString(),
    supersedes: previous?.controlsId,
  };

  write(ctx, {
    eventType: 'CONCEPT_CONTROLS_APPROVED',
    entity: { refType: 'ConceptControls', refId: controlsId },
    nextState: state as unknown as Record<string, unknown>,
    evidenceRefs: [evidence],
  });

  return {
    controlsId,
    version: state.version,
    totalMinor: totals.totalMinor,
    p80Minor: totals.p80Minor,
    affordabilityGapMinor: gap,
  };
}

export type ConceptControlsPosition = {
  costPlan?: ConceptCostPlanState;
  totals?: ReturnType<typeof costTotals>;
  programme?: MilestoneProgrammeState;
  cashflow?: ConceptCashflowState;
  approved?: ConceptControlsState;
  /** Statutory milestones, which cannot be bypassed. AC-C-WF-07-03. */
  statutoryMilestones: number;
  /** Lines with no range: a P80 built from these is a P80 of nothing. */
  pointOnlyLines: number;
  blocked: string | null;
};

/** The concept controls position, derived on every read. */
export function conceptControlsPosition(ctx: EngineContext): ConceptControlsPosition {
  authorise(ctx, 'BUDGET_COST', 'R');

  const plan = currentCostPlan(ctx);
  const programme = currentMilestoneProgramme(ctx);
  const totals = plan ? costTotals(plan) : undefined;

  return {
    costPlan: plan,
    totals,
    programme,
    cashflow: currentConceptCashflow(ctx),
    approved: currentConceptControls(ctx),
    statutoryMilestones: programme?.milestones.filter((m) => m.statutory).length ?? 0,
    pointOnlyLines: totals?.pointOnlyLines ?? 0,
    blocked: conceptControlsBlockedReason(ctx),
  };
}
