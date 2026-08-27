import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import { currentMilestoneProgramme } from './conceptcontrols.ts';
import { selectedOption } from './conceptoptions.ts';

/**
 * C-WF-06 — procurement, contract and delivery strategy.
 *
 * The decision about *how* the project will be bought, taken before anything is
 * bought. It is the stage where the risk allocation is really set: by the time
 * a contract form is chosen, most of the argument about who carries what has
 * already been settled by the route.
 *
 * What already exists and is not rebuilt: the tender-stage package strategy
 * (`domain/procurement.ts` and T-WF-04's enquiry composition), the supply-chain
 * and self-delivery pricing routes (`domain/pricingroute.ts`), the ITT
 * (`domain/itt.ts`) and the executed-contract clause register
 * (`ContractClause`). All of those operate on packages that exist. This module
 * is the decision that they will.
 *
 * **A package with a scope gap or overlap blocks approval.** The exception
 * control, and it is checked arithmetically rather than by eye: every package
 * declares the scope elements it carries, and the approval refuses if an element
 * appears twice or if a declared element of the works appears in none. A gap is
 * the more expensive of the two — an overlap gets argued about at tender, a gap
 * gets discovered on site.
 *
 * **A single-source route requires an authorised justification.** The exception
 * control. Not a warning: a route that avoids competition is the one a client's
 * auditor asks about first, and "it was quicker" needs to be somebody's signed
 * opinion rather than a field.
 *
 * **Long-lead dates trace to a required-on-site milestone.** AC-C-WF-06-03. A
 * procurement milestone with no downstream need date is a date somebody made
 * up, and it is how a sixty-week switchgear order gets placed in month
 * fourteen.
 *
 * **The contract rules stay provisional.** The exception control says so
 * explicitly and this module honours it: `CONTRACT_STRATEGY_SELECTED` records a
 * contract-form *family* and a provisional notice configuration. The real
 * clause register is extracted from the executed contract by the existing
 * `ContractClause` path and is a different record. Nothing here is presented as
 * a legal position.
 */

export const PROCUREMENT_ROUTE = [
  'TRADITIONAL',
  'DESIGN_AND_BUILD',
  'CONSTRUCTION_MANAGEMENT',
  'MANAGEMENT_CONTRACTING',
  'FRAMEWORK_CALL_OFF',
  'ALLIANCE',
  'SINGLE_SOURCE',
] as const;
export type ProcurementRoute = (typeof PROCUREMENT_ROUTE)[number];

/** What the route is judged on. Weighted, and the weights are recorded. */
export const ROUTE_CRITERION = [
  'SCOPE_CERTAINTY',
  'TIME',
  'PRICE_CERTAINTY',
  'DESIGN_CONTROL',
  'MARKET_CAPACITY',
  'RISK_TRANSFER',
] as const;
export type RouteCriterion = (typeof ROUTE_CRITERION)[number];

export type RouteAssessment = {
  route: ProcurementRoute;
  /** Criterion → raw score. Weights are on the strategy, not on each route. */
  scores: Record<string, number>;
  note: string;
};

export type ProcurementStrategyState = {
  strategyId: string;
  projectId: string;
  version: number;
  optionId: string;
  /** Criterion → weight. Summing to 1, checked. AC-C-WF-06-02. */
  weights: Record<string, number>;
  assessments: readonly RouteAssessment[];
  selectedRoute: ProcurementRoute;
  rationale: string;
  /** Required where the route avoids competition. Exception control. */
  singleSourceJustification?: string;
  singleSourceApprovedBy?: string;
  designResponsibility: string;
  riskAppetite: string;
  socialValueObligations: readonly string[];
  createdBy: string;
  createdAt: string;
};

export type ProposedPackage = {
  packageId: string;
  reference: string;
  name: string;
  /** The scope elements this package carries. Overlap and gap are computed from these. */
  scopeElements: readonly string[];
  /** What it hands to, and takes from, other packages. */
  interfaces: readonly string[];
  ownerId: string;
  /** When the package must be on site, and when it must therefore be bought. */
  requiredOnSiteMilestoneRef: string;
  enquiryDate: string;
  awardDate: string;
  leadTimeWeeks: number;
  retainedRisks: readonly string[];
};

export type PackageStrategyState = {
  packageStrategyId: string;
  projectId: string;
  version: number;
  strategyId: string;
  /** Every scope element of the works. The set packages are checked against. */
  worksScopeElements: readonly string[];
  packages: readonly ProposedPackage[];
  approvedBy: string;
  approvedAt: string;
};

export type ContractStrategyState = {
  contractStrategyId: string;
  projectId: string;
  version: number;
  strategyId: string;
  /** The family, not a specific executed contract. NEC4, JCT, FIDIC, bespoke. */
  contractFamily: string;
  contractOption: string;
  /** Provisional until the executed contract is ingested. Always true here. */
  provisional: true;
  paymentTerms: string;
  insuranceRequirements: readonly string[];
  bondsAndGuarantees: readonly string[];
  /** The notices the family implies, as a starting configuration. */
  provisionalNotices: readonly string[];
  selectedBy: string;
  selectedAt: string;
};

function strategiesOf(ctx: EngineContext): ProcurementStrategyState[] {
  return ctx.ledger
    .list(ctx.projectId, 'ProcurementStrategy')
    .map((r) => r.state as unknown as ProcurementStrategyState)
    .sort((a, b) => a.version - b.version);
}

function packageStrategiesOf(ctx: EngineContext): PackageStrategyState[] {
  return ctx.ledger
    .list(ctx.projectId, 'PackageStrategy')
    .map((r) => r.state as unknown as PackageStrategyState)
    .sort((a, b) => a.version - b.version);
}

function contractStrategiesOf(ctx: EngineContext): ContractStrategyState[] {
  return ctx.ledger
    .list(ctx.projectId, 'ContractStrategy')
    .map((r) => r.state as unknown as ContractStrategyState)
    .sort((a, b) => a.version - b.version);
}

export function currentProcurementStrategy(ctx: EngineContext): ProcurementStrategyState | undefined {
  return strategiesOf(ctx).at(-1);
}
export function currentPackageStrategy(ctx: EngineContext): PackageStrategyState | undefined {
  return packageStrategiesOf(ctx).at(-1);
}
export function currentContractStrategy(ctx: EngineContext): ContractStrategyState | undefined {
  return contractStrategiesOf(ctx).at(-1);
}

/**
 * Choose the procurement route.
 *
 * Every candidate route is scored, including the ones not chosen. AC-C-WF-06-02
 * asks for weighted criteria and authority, and a record showing only the
 * winner is a record of an assertion.
 */
export function createProcurementStrategy(
  ctx: EngineContext,
  input: {
    weights: Record<string, number>;
    assessments: readonly RouteAssessment[];
    selectedRoute: ProcurementRoute;
    rationale: string;
    designResponsibility: string;
    riskAppetite: string;
    socialValueObligations?: readonly string[];
    singleSourceJustification?: string;
    singleSourceApprovedBy?: string;
  },
): { strategyId: string; version: number } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'A');

  const option = selectedOption(ctx);
  if (!option) {
    throw new DomainError(
      'NO_SELECTED_OPTION',
      'No option has been selected. A procurement route buys a decision, and there is not one yet.',
      409,
    );
  }

  const weightTotal = Object.values(input.weights).reduce((sum, w) => sum + w, 0);
  if (Math.abs(weightTotal - 1) > 0.001) {
    throw new DomainError(
      'WEIGHTS_UNBALANCED',
      `The route criteria weights sum to ${weightTotal.toFixed(3)}, not 1.`,
      422,
    );
  }
  if (input.assessments.length < 2) {
    throw new DomainError(
      'NO_COMPARISON',
      'Assess at least two routes. A strategy that considered one route did not choose it.',
      422,
    );
  }
  if (!input.assessments.some((a) => a.route === input.selectedRoute)) {
    throw new DomainError(
      'SELECTED_ROUTE_UNASSESSED',
      `${input.selectedRoute} was selected but not assessed against the criteria.`,
      422,
    );
  }
  if (input.rationale.trim() === '') {
    throw new DomainError('RATIONALE_REQUIRED', 'State why this route was chosen', 422);
  }

  // The exception control. A route that avoids competition needs somebody's
  // name on the reason, not a field.
  if (input.selectedRoute === 'SINGLE_SOURCE') {
    if ((input.singleSourceJustification ?? '').trim() === '' || (input.singleSourceApprovedBy ?? '').trim() === '') {
      throw new DomainError(
        'SINGLE_SOURCE_UNJUSTIFIED',
        'A single-source route requires a justification and the person who authorised it. It is the first ' +
          "thing a client's auditor asks about, and it needs an answer with a name on it.",
        422,
      );
    }
  }

  const previous = currentProcurementStrategy(ctx);
  const strategyId = ulid();
  const version = (previous?.version ?? 0) + 1;
  write(ctx, {
    eventType: 'PROCUREMENT_STRATEGY_CREATED',
    entity: { refType: 'ProcurementStrategy', refId: strategyId },
    nextState: {
      strategyId,
      projectId: ctx.projectId,
      version,
      optionId: option.optionId,
      weights: input.weights,
      assessments: input.assessments,
      selectedRoute: input.selectedRoute,
      rationale: input.rationale,
      singleSourceJustification: input.singleSourceJustification,
      singleSourceApprovedBy: input.singleSourceApprovedBy,
      designResponsibility: input.designResponsibility,
      riskAppetite: input.riskAppetite,
      socialValueObligations: input.socialValueObligations ?? [],
      createdBy: ctx.auth.actorId,
      createdAt: new Date().toISOString(),
    } satisfies ProcurementStrategyState as unknown as Record<string, unknown>,
  });

  return { strategyId, version };
}

/**
 * Scope elements covered twice, and elements covered by nothing.
 *
 * Exported so a screen can show the two lists before somebody tries to approve
 * — the refusal is the last resort, not the interface.
 */
export function packageScopeIssues(
  worksScopeElements: readonly string[],
  packages: ReadonlyArray<{ reference: string; scopeElements: readonly string[] }>,
): { overlaps: Array<{ element: string; packages: string[] }>; gaps: string[] } {
  const byElement = new Map<string, string[]>();
  for (const pkg of packages) {
    for (const element of pkg.scopeElements) {
      byElement.set(element, [...(byElement.get(element) ?? []), pkg.reference]);
    }
  }

  const overlaps = [...byElement.entries()]
    .filter(([, refs]) => refs.length > 1)
    .map(([element, refs]) => ({ element, packages: refs.sort() }))
    .sort((a, b) => a.element.localeCompare(b.element));

  const gaps = worksScopeElements.filter((element) => !byElement.has(element)).sort();

  return { overlaps, gaps };
}

/**
 * Approve the package strategy.
 *
 * The gap-and-overlap check is the substance of this command. AC-C-WF-06-01
 * additionally asks for a scope boundary, interfaces, procurement dates and an
 * owner on every package, and all four are required per package rather than
 * checked in aggregate.
 */
export function approvePackageStrategy(
  ctx: EngineContext,
  input: {
    worksScopeElements: readonly string[];
    packages: ReadonlyArray<{
      reference: string;
      name: string;
      scopeElements: readonly string[];
      interfaces: readonly string[];
      ownerId: string;
      requiredOnSiteMilestoneRef: string;
      enquiryDate: string;
      awardDate: string;
      leadTimeWeeks: number;
      retainedRisks?: readonly string[];
    }>;
  },
): { packageStrategyId: string; version: number; packages: number } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'A');

  const strategy = currentProcurementStrategy(ctx);
  if (!strategy) {
    throw new DomainError(
      'NO_PROCUREMENT_STRATEGY',
      'No procurement route has been chosen. Packages are how a route is executed, not a substitute for one.',
      409,
    );
  }
  if (input.packages.length === 0) {
    throw new DomainError('NO_PACKAGES', 'A package strategy with no packages buys nothing', 422);
  }
  if (input.worksScopeElements.length === 0) {
    throw new DomainError(
      'NO_SCOPE_DECLARED',
      'Declare the scope elements of the works. Without them a gap cannot be detected, and a gap is the ' +
        'expensive half of the exception control.',
      422,
    );
  }

  const programme = currentMilestoneProgramme(ctx);
  const milestoneRefs = new Set(programme?.milestones.map((m) => m.reference) ?? []);

  for (const pkg of input.packages) {
    if (pkg.scopeElements.length === 0) {
      throw new DomainError('PACKAGE_NO_SCOPE', `${pkg.reference} carries no scope elements`, 422);
    }
    if (pkg.ownerId.trim() === '') {
      throw new DomainError('PACKAGE_NO_OWNER', `${pkg.reference} names no owner`, 422);
    }
    if (pkg.enquiryDate > pkg.awardDate) {
      throw new DomainError(
        'PACKAGE_DATES_REVERSED',
        `${pkg.reference} is awarded before it is enquired.`,
        422,
      );
    }
    // AC-C-WF-06-03. A long-lead date that traces to nothing is a date
    // somebody made up.
    if (!milestoneRefs.has(pkg.requiredOnSiteMilestoneRef)) {
      throw new DomainError(
        'MILESTONE_NOT_FOUND',
        `${pkg.reference} is required on site at "${pkg.requiredOnSiteMilestoneRef}", which is not a ` +
          'milestone on the concept programme. A procurement date that traces to nothing is a date nobody owns.',
        422,
      );
    }
    // The lead time has to fit between award and need. This is the arithmetic
    // that puts a sixty-week switchgear order in month fourteen when nobody
    // checks it.
    const milestone = programme?.milestones.find((m) => m.reference === pkg.requiredOnSiteMilestoneRef);
    if (milestone) {
      const award = new Date(`${pkg.awardDate.slice(0, 10)}T00:00:00Z`).getTime();
      const need = new Date(`${milestone.plannedDate.slice(0, 10)}T00:00:00Z`).getTime();
      const weeksAvailable = Math.floor((need - award) / (7 * 86_400_000));
      if (weeksAvailable < pkg.leadTimeWeeks) {
        throw new DomainError(
          'LEAD_TIME_IMPOSSIBLE',
          `${pkg.reference} has a ${pkg.leadTimeWeeks}-week lead time and ${weeksAvailable} weeks between ` +
            `award (${pkg.awardDate.slice(0, 10)}) and required on site (${milestone.plannedDate}). ` +
            'The order is late before it is placed.',
          422,
        );
      }
    }
  }

  const issues = packageScopeIssues(input.worksScopeElements, input.packages);
  if (issues.overlaps.length > 0) {
    throw new DomainError(
      'PACKAGE_SCOPE_OVERLAP',
      `${issues.overlaps.length} scope element${issues.overlaps.length === 1 ? '' : 's'} appear in more than ` +
        `one package: ${issues.overlaps.map((o) => `${o.element} (${o.packages.join(', ')})`).join('; ')}. ` +
        'Two packages priced for the same work is money paid twice or an argument at settlement.',
      422,
    );
  }
  if (issues.gaps.length > 0) {
    throw new DomainError(
      'PACKAGE_SCOPE_GAP',
      `${issues.gaps.length} scope element${issues.gaps.length === 1 ? '' : 's'} are in no package: ` +
        `${issues.gaps.join(', ')}. An overlap gets argued about at tender; a gap gets discovered on site.`,
      422,
    );
  }

  const previous = currentPackageStrategy(ctx);
  const packageStrategyId = ulid();
  const version = (previous?.version ?? 0) + 1;
  write(ctx, {
    eventType: 'PACKAGE_STRATEGY_APPROVED',
    entity: { refType: 'PackageStrategy', refId: packageStrategyId },
    nextState: {
      packageStrategyId,
      projectId: ctx.projectId,
      version,
      strategyId: strategy.strategyId,
      worksScopeElements: input.worksScopeElements,
      packages: input.packages.map((p) => ({
        packageId: ulid(),
        reference: p.reference,
        name: p.name,
        scopeElements: p.scopeElements,
        interfaces: p.interfaces,
        ownerId: p.ownerId,
        requiredOnSiteMilestoneRef: p.requiredOnSiteMilestoneRef,
        enquiryDate: p.enquiryDate.slice(0, 10),
        awardDate: p.awardDate.slice(0, 10),
        leadTimeWeeks: p.leadTimeWeeks,
        retainedRisks: p.retainedRisks ?? [],
      })),
      approvedBy: ctx.auth.actorId,
      approvedAt: new Date().toISOString(),
    } satisfies PackageStrategyState as unknown as Record<string, unknown>,
  });

  return { packageStrategyId, version, packages: input.packages.length };
}

/**
 * Select the contract-form family.
 *
 * Provisional by construction. `provisional: true` is a literal on the type,
 * not a field a caller can set, because the exception control does not permit a
 * concept-stage contract strategy to be anything else: the real clause register
 * comes from the executed contract, through the path that already exists.
 */
export function selectContractStrategy(
  ctx: EngineContext,
  input: {
    contractFamily: string;
    contractOption: string;
    paymentTerms: string;
    insuranceRequirements: readonly string[];
    bondsAndGuarantees: readonly string[];
    provisionalNotices: readonly string[];
  },
): { contractStrategyId: string; version: number } {
  authorise(ctx, 'CONTRACTS_CLAIMS', 'A');

  const strategy = currentProcurementStrategy(ctx);
  if (!strategy) {
    throw new DomainError(
      'NO_PROCUREMENT_STRATEGY',
      'No procurement route has been chosen. The contract form follows the route.',
      409,
    );
  }
  if (input.contractFamily.trim() === '' || input.contractOption.trim() === '') {
    throw new DomainError('FAMILY_REQUIRED', 'Name the contract family and the option within it', 422);
  }

  const previous = currentContractStrategy(ctx);
  const contractStrategyId = ulid();
  const version = (previous?.version ?? 0) + 1;
  write(ctx, {
    eventType: 'CONTRACT_STRATEGY_SELECTED',
    entity: { refType: 'ContractStrategy', refId: contractStrategyId },
    nextState: {
      contractStrategyId,
      projectId: ctx.projectId,
      version,
      strategyId: strategy.strategyId,
      contractFamily: input.contractFamily,
      contractOption: input.contractOption,
      provisional: true,
      paymentTerms: input.paymentTerms,
      insuranceRequirements: input.insuranceRequirements,
      bondsAndGuarantees: input.bondsAndGuarantees,
      provisionalNotices: input.provisionalNotices,
      selectedBy: ctx.auth.actorId,
      selectedAt: new Date().toISOString(),
    } satisfies ContractStrategyState as unknown as Record<string, unknown>,
  });

  return { contractStrategyId, version };
}

/** Why the delivery strategy is not complete. Read by the concept gate. */
export function strategyBlockedReason(ctx: EngineContext): string | null {
  const strategy = currentProcurementStrategy(ctx);
  if (!strategy) return 'No procurement route has been chosen.';

  const packages = currentPackageStrategy(ctx);
  if (!packages) return 'No package strategy has been approved.';
  if (packages.strategyId !== strategy.strategyId) {
    return 'The package strategy was approved against an earlier procurement route. Re-approve it.';
  }

  const contract = currentContractStrategy(ctx);
  if (!contract) return 'No contract strategy has been selected.';
  if (contract.strategyId !== strategy.strategyId) {
    return 'The contract strategy was selected against an earlier procurement route. Re-select it.';
  }

  return null;
}

export type MobilisationTask = {
  reference: string;
  what: string;
  ownerId: string;
  /** The date it must be done by, taken from what actually depends on it. */
  by: string;
  /** Where it came from, so nothing on the list is somebody's idea. */
  derivedFrom: string;
};

/**
 * The design mobilisation worklist — C-WF-08's fourth output.
 *
 * Derived, never stored. Every task on it comes from something the concept
 * stage already decided: a package needs its employer's requirements written
 * before it can be enquired, a long-lead item needs an advance-order decision
 * before its award date, and a retained risk needs an owner on day one of
 * design rather than at the first design review.
 *
 * Deriving it is the point. A stored worklist is a list somebody wrote once
 * and nobody updated when the package strategy changed, and the whole reason
 * the specification asks for it is that the design stage should start from
 * what concept actually settled rather than from a fresh conversation.
 *
 * The dates are not invented. Each is the date of the thing that depends on
 * the task — an enquiry date, an award date — so a task with no downstream
 * date does not appear, because there would be nothing to be late against.
 */
export function designMobilisationWorklist(ctx: EngineContext): MobilisationTask[] {
  const packages = currentPackageStrategy(ctx);
  const contract = currentContractStrategy(ctx);
  if (!packages) return [];

  const tasks: MobilisationTask[] = [];

  for (const pkg of packages.packages) {
    // Every package needs its scope written up before it can go to market, and
    // the enquiry date is the date that says when.
    tasks.push({
      reference: `MOB-ER-${pkg.reference}`,
      what: `Write the employer's requirements for ${pkg.name}, covering ${pkg.scopeElements.join(', ')}`,
      ownerId: pkg.ownerId,
      by: pkg.enquiryDate,
      derivedFrom: `Package ${pkg.reference}, enquiry ${pkg.enquiryDate}`,
    });

    // Interfaces are where packages meet, and they are agreed before the
    // enquiry or they are argued about after the award.
    for (const [index, boundary] of pkg.interfaces.entries()) {
      tasks.push({
        reference: `MOB-IF-${pkg.reference}-${index + 1}`,
        what: `Agree and draw the interface: ${boundary}`,
        ownerId: pkg.ownerId,
        by: pkg.enquiryDate,
        derivedFrom: `Package ${pkg.reference} interface`,
      });
    }

    // A long-lead package needs the advance-order decision taken before the
    // award, not at it. Twenty-six weeks is the same threshold the position
    // report uses, so the two cannot disagree about what "long lead" means.
    if (pkg.leadTimeWeeks >= 26) {
      tasks.push({
        reference: `MOB-LL-${pkg.reference}`,
        what:
          `Decide whether to advance-order the long-lead content of ${pkg.name} ` +
          `(${pkg.leadTimeWeeks}-week lead) under a pre-construction services agreement`,
        ownerId: pkg.ownerId,
        by: pkg.enquiryDate,
        derivedFrom: `Package ${pkg.reference}, ${pkg.leadTimeWeeks}-week lead against ${pkg.requiredOnSiteMilestoneRef}`,
      });
    }

    // A risk the client is keeping needs a named owner in design, or it is
    // discovered on site as a surprise nobody was watching for.
    for (const [index, risk] of pkg.retainedRisks.entries()) {
      tasks.push({
        reference: `MOB-RR-${pkg.reference}-${index + 1}`,
        what: `Assign and plan the retained risk carried into ${pkg.reference}: ${risk}`,
        ownerId: pkg.ownerId,
        by: pkg.enquiryDate,
        derivedFrom: `Package ${pkg.reference} retained risk`,
      });
    }
  }

  // The contract's notices have to exist as a register before the first one is
  // due, and the earliest enquiry is the date by which the form is being
  // quoted at bidders.
  const earliestEnquiry = packages.packages
    .map((p) => p.enquiryDate)
    .sort()
    .at(0);
  if (contract && earliestEnquiry) {
    tasks.push({
      reference: 'MOB-CONTRACT',
      what:
        `Open the notice register for ${contract.contractFamily} ${contract.contractOption} ` +
        `(${contract.provisionalNotices.length} provisional notices) and replace it from the executed contract`,
      ownerId: packages.approvedBy,
      by: earliestEnquiry,
      derivedFrom: `Contract strategy ${contract.contractFamily}, provisional until execution`,
    });
  }

  return tasks.sort((a, b) => (a.by === b.by ? a.reference.localeCompare(b.reference) : a.by.localeCompare(b.by)));
}

export type StrategyPosition = {
  procurement?: ProcurementStrategyState;
  packages?: PackageStrategyState;
  contract?: ContractStrategyState;
  packageCount: number;
  /** Packages whose order must be placed within a year of the cut-off. */
  longLead: Array<{ reference: string; leadTimeWeeks: number; awardDate: string }>;
  scopeIssues: ReturnType<typeof packageScopeIssues>;
  /** C-WF-08's fourth output, derived from the packages above. */
  mobilisation: MobilisationTask[];
  blocked: string | null;
};

/** The strategy position, derived on every read. */
export function strategyPosition(ctx: EngineContext): StrategyPosition {
  authorise(ctx, 'PROCUREMENT_AWARD', 'R');

  const packages = currentPackageStrategy(ctx);
  return {
    procurement: currentProcurementStrategy(ctx),
    packages,
    contract: currentContractStrategy(ctx),
    packageCount: packages?.packages.length ?? 0,
    longLead: (packages?.packages ?? [])
      .filter((p) => p.leadTimeWeeks >= 26)
      .map((p) => ({ reference: p.reference, leadTimeWeeks: p.leadTimeWeeks, awardDate: p.awardDate }))
      .sort((a, b) => b.leadTimeWeeks - a.leadTimeWeeks),
    scopeIssues: packageScopeIssues(packages?.worksScopeElements ?? [], packages?.packages ?? []),
    mobilisation: designMobilisationWorklist(ctx),
    blocked: strategyBlockedReason(ctx),
  };
}
