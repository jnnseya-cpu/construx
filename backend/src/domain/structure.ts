import { COUNTRY, values } from '../../../shared/vocabulary.js';
import { hashEvidence } from '../core/canonical.ts';
import { assertOrder } from './dates.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import * as stages from '../lifecycle/stages.ts';
import { openInheritanceRegister } from './inheritance.ts';
import {
  assertStartingPhase,
  assertTransitionAllowed,
  evaluatePhaseGate,
  LIFECYCLE_ORDER,
  nextPhase,
  phaseIndex,
  type GateEvaluation,
  type LifecyclePhase,
} from '../lifecycle/phases.ts';
import {
  assertLifecycleTransition,
  lifecycleLabel,
  lifecycleState,
  type CommercialOutcome,
  type DeliveryStatus,
  type LifecycleState,
} from '../lifecycle/state.ts';

/**
 * Governance and delivery structure.
 *
 * The hierarchy is fixed and every level is creatable, because a blocked chain
 * at any level blocks everything below it:
 *
 *   Tenant -> Enterprise -> Portfolio -> Programme -> Project -> Package
 */

/**
 * Sector, from the canonical vocabulary the browser and the route schemas both
 * read. Declared here as a union rather than inferred, because it is a domain
 * type and the engines switch on it — but the values are the shared list's, and
 * `vocabulary.test.ts` fails if the two drift apart.
 */
export type SectorType =
  | 'RESIDENTIAL'
  | 'COMMERCIAL'
  | 'INDUSTRIAL'
  | 'TRANSPORT'
  | 'UTILITIES'
  | 'ENERGY'
  | 'FM'
  | 'RMI'
  | 'PROFESSIONAL';

/**
 * The six regions a portfolio can sit in, from the shared vocabulary.
 *
 * Declared as a union here for the same reason `SectorType` is — the engines
 * switch on it and it is a domain type — while the values stay the shared
 * list's, which `vocabulary.test.ts` holds the two to.
 */
export type ContinentCode = 'EU' | 'AM' | 'AF' | 'AS' | 'OC' | 'AN';

const CONTINENT_CODES = new Set<string>(['EU', 'AM', 'AF', 'AS', 'OC', 'AN']);

/**
 * ISO 3166-1 alpha-2, checked against the standard rather than against a shape.
 *
 * This used to be `/^[A-Z]{2}$/` with a note saying a list of every country was
 * not ours to hold. The shape check accepts `ZZ`, `XX` and `QQ` — so a
 * portfolio could be created in a jurisdiction that does not exist, and the
 * console asked a person to type a code they had to already know.
 *
 * The list is now held once, in `shared/vocabulary.js`, which the gateway
 * serves to the browser byte for byte. So the picker offers exactly what this
 * accepts, and neither is a copy of the other.
 */
const COUNTRY_CODES = new Set<string>(values(COUNTRY));

/**
 * A portfolio must say where in the world it is.
 *
 * This is a multi-country platform and the region was **optional** — so a
 * portfolio could exist attached to nowhere, and every estate view that groups
 * by region had to cope with a blank. A field that is usually empty is not a
 * region model; it is a column, and no view can aggregate on it.
 *
 * Two levels, because both are real. `continentCode` is the commercial region a
 * business decides to operate in and is always required. `countryCode` is
 * optional and narrows the portfolio to one jurisdiction — which matters,
 * because a portfolio scoped to a country is one where contract law, tax and
 * the working calendar are the same for everything inside it, and a regional
 * portfolio spanning several is one where they are not.
 *
 * Below, `createProject` holds a project to the portfolio it is filed under:
 * that is the link the hierarchy is for, and without the check it was a foreign
 * key nobody enforced.
 */
export function createPortfolio(
  ctx: EngineContext,
  input: {
    name: string;
    enterpriseId: string;
    governanceModel: string;
    continentCode: ContinentCode;
    countryCode?: string;
    city?: string;
    targets?: { budgetMinor?: number; targetCompletionDate?: string; kpis?: Record<string, number> };
    riskAppetite?: { costTolerancePercent: number; scheduleToleranceDays: number };
    reportingCadence?: 'WEEKLY' | 'FORTNIGHTLY' | 'MONTHLY';
    standardCalendar?: { workingDays: number[]; holidays: string[] };
  },
): { portfolioId: string } {
  authorise(ctx, 'ENTERPRISE_STRUCTURE', 'C');

  if (!CONTINENT_CODES.has(input.continentCode)) {
    throw new DomainError(
      'PORTFOLIO_REGION_REQUIRED',
      `A portfolio must name the region it operates in. "${input.continentCode}" is not one of ` +
        `${[...CONTINENT_CODES].join(', ')}.`,
      422,
      [{ field: 'continentCode', message: 'Choose the region this portfolio operates in' }],
    );
  }
  if (input.countryCode !== undefined && input.countryCode !== '' && !COUNTRY_CODES.has(input.countryCode)) {
    throw new DomainError(
      'COUNTRY_CODE_INVALID',
      `"${input.countryCode}" is not an ISO 3166-1 alpha-2 country code.`,
      422,
      [{ field: 'countryCode', message: 'Choose a country, or leave it blank for a multi-country portfolio' }],
    );
  }

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
    /**
     * The opportunity this project came from, when it came from one. Carrying
     * it here is what lets a variation argued about in year three trace back
     * to the decision to chase the job at all.
     */
    originOpportunityId?: string;
    /**
     * The lifecycle phase this project opens at. `CONCEPT` unless said
     * otherwise, which is where an asset's own life starts.
     *
     * A business joins an asset's lifecycle wherever its involvement begins. A
     * contractor pricing somebody else's design opens at `TENDER`; an operator
     * taking over a finished building opens at `OPERATIONS`. Forcing either to
     * start at `CONCEPT` means inventing a scope package and a design maturity
     * assessment whose only purpose is to clear a gate — the platform teaching
     * people to put fabricated records into the Golden Thread on day one.
     */
    startingPhase?: LifecyclePhase;
    /**
     * Why it starts there. Required for anything past `CONCEPT`, because the
     * gates in front of it were never evaluated here and the reason is the only
     * thing that tells a reader that from a mis-selected dropdown.
     */
    startingPhaseReason?: string;
    /**
     * The tender project this one was won from, where it was.
     *
     * Set by `awardTender` rather than by a caller: it is the link that lets
     * the delivery job's contract be read against the bid that priced it.
     */
    originProjectId?: string;
  },
): { projectId: string; phase: LifecyclePhase } {
  authorise(ctx, 'PROJECT_SETUP', 'C');

  // A project that completes before it starts produces a negative duration
  // everywhere downstream — the programme, the cash-flow model and the delay
  // forecast all divide by it. Nothing checked, so nothing stopped it.
  assertOrder(input.plannedStart, input.plannedCompletion, 'plannedStart', 'plannedCompletion');

  const portfolio = ctx.ledger.require({ refType: 'Portfolio', refId: input.portfolioId });
  if (portfolio.state.status === 'DELETED') {
    throw new DomainError('PORTFOLIO_DELETED', `${String(portfolio.state.name)} was deleted on ${String(portfolio.state.deletedAt ?? '').slice(0, 10)}; file the project under a live portfolio.`, 409, [
      { field: 'portfolioId', message: 'That portfolio has been deleted' },
    ]);
  }

  // The project has to sit inside the portfolio it is filed under.
  //
  // The hierarchy is Enterprise → Portfolio → Programme → Project, and the
  // portfolio is what carries the geography, so a project's location is a claim
  // about where in the portfolio's world it is. Nothing enforced it: a
  // portfolio for Europe would accept a project in Kenya, and every regional
  // rollup — cost by region, risk by region, which jurisdiction's contract law
  // applies — would then be quietly wrong in a way no screen could show.
  //
  // A portfolio with no region recorded is one created before the region was
  // required. It is not rewritten here: the ledger is append-only and a project
  // creation is the wrong event to correct a portfolio with.
  const portfolioRegion = portfolio.state.continentCode as string | undefined;
  const portfolioCountry = portfolio.state.countryCode as string | undefined;

  if (portfolioRegion && input.location.continentCode !== portfolioRegion) {
    throw new DomainError(
      'PROJECT_OUTSIDE_PORTFOLIO_REGION',
      `This portfolio operates in ${portfolioRegion} and the project is in ${input.location.continentCode}. ` +
        'File it under a portfolio for that region, or create one.',
      422,
      [{ field: 'location.continentCode', message: `This portfolio covers ${portfolioRegion}` }],
    );
  }

  // A portfolio narrowed to one country is narrowed for a reason — contract
  // law, tax and the working calendar are the same throughout it, and a second
  // country inside it makes all three untrue at once. A portfolio with no
  // country is regional on purpose and accepts any country in its region.
  if (portfolioCountry && input.location.countryCode !== portfolioCountry) {
    throw new DomainError(
      'PROJECT_OUTSIDE_PORTFOLIO_COUNTRY',
      `This portfolio is scoped to ${portfolioCountry} and the project is in ${input.location.countryCode}. ` +
        'A portfolio scoped to one country is where contract law, tax and the calendar are common to everything ' +
        'in it — put this under a regional portfolio instead.',
      422,
      [{ field: 'location.countryCode', message: `This portfolio covers ${portfolioCountry} only` }],
    );
  }

  // Where this project joins the lifecycle, and what that means it skipped.
  // Refused without a reason for anything past CONCEPT — see `phases.ts`.
  const startingPhase = input.startingPhase ?? 'CONCEPT';
  const { skipped } = assertStartingPhase(startingPhase, input.startingPhaseReason);
  const openedAt = new Date().toISOString();

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
      originOpportunityId: input.originOpportunityId,
      originProjectId: input.originProjectId,
      // Where the project joins the lifecycle. Past the first phase it moves
      // forward only through governed gates — what changed is where it starts,
      // not how it advances.
      phase: startingPhase,
      /*
       * The lifecycle state, which is a different question from the phase.
       *
       * The phase says where the work is; this says what the project *is* — a
       * tender opportunity, a live job, a suspended one. A project opened at
       * TENDER is `PRE_AWARD` and has won nothing; one opened at CONSTRUCTION
       * is already being built. See `lifecycle/state.ts`.
       */
      lifecycleState: openingLifecycleState(startingPhase),
      lifecycleStateAt: openedAt,
      lifecycleStateBy: ctx.auth.actorId,
      lifecycleHistory: [
        { from: null, to: openingLifecycleState(startingPhase), at: openedAt, by: ctx.auth.actorId, reason: 'Project created' },
      ],
      commercialOutcome: openingLifecycleState(startingPhase) === 'PRE_AWARD' ? 'PENDING' : undefined,
      /**
       * The phases this project never entered, and the reason it did not.
       *
       * Recorded as state rather than left to be inferred from a short
       * `phaseHistory`, because the inference is the thing that goes wrong. A
       * project in CONSTRUCTION whose history holds one entry could have
       * started there or could be missing its earlier records, and those are
       * opposite readings. Named, they are one reading.
       */
      startedAtPhase: startingPhase,
      phasesNotTraversed: skipped,
      startingPhaseReason: input.startingPhaseReason,
      phaseHistory: [
        {
          phase: startingPhase,
          enteredAt: openedAt,
          by: ctx.auth.actorId,
          ...(skipped.length > 0
            ? { openedHere: true, notTraversed: skipped, reason: input.startingPhaseReason }
            : {}),
        },
      ],
      status: 'ACTIVE',
      createdAt: openedAt,
    },
  });

  // The first occupancy, opened with the project. `phaseHistory` above says the
  // project entered CONCEPT; this is the record of it being *in* CONCEPT — what
  // was open, what gate was submitted, and eventually what was frozen when it
  // left. Opened here rather than lazily so that a project created today has a
  // complete stage record rather than one that begins wherever somebody first
  // happened to look.
  //
  // `projectId` is passed explicitly: the context still points at whatever
  // project the caller was working in, and the ledger would otherwise file this
  // stage against that one.
  stages.openStage(
    { ...ctx, projectId },
    {
      phase: startingPhase,
      reason:
        skipped.length === 0
          ? `Project created: ${input.name}`
          : `Project created at ${startingPhase}, not traversing ${skipped.join(', ')}: ${input.startingPhaseReason}`,
    },
  );

  return { projectId, phase: startingPhase };
}

// ------------------------------- the lifecycle state, and how a bid ends

/**
 * Moving a project through the canonical lifecycle.
 *
 * Every transition except contract award comes through here. Award is
 * `convertToDelivery`, which is a separate command with its own gate, because
 * it changes what the project *is* and an award reachable from the same
 * dropdown as "put it on hold" is a contract award nobody reviewed.
 *
 * ## Three dimensions, not one field
 *
 * `lifecycleState` says what the project is — a tender opportunity, a live job,
 * a suspended one, a lost one. `commercialOutcome` says how the bid went.
 * `deliveryStatus` says what the team is doing. They move at different times
 * and for different reasons: a bid is `WON` while the project is still
 * `AWARD_PENDING` waiting for an executed contract, and that gap is where every
 * at-risk mobilisation cost lives.
 *
 * The phase — `CONCEPT` through `OPERATIONS` — is a fourth and separate thing:
 * the *primary stage*, which is where the work is rather than what the project
 * is. A suspended job is still in `CONSTRUCTION`; it is simply not proceeding.
 *
 * ## Reopening is permitted and is not the same act
 *
 * `CLOSED_LOST`, `WITHDRAWN`, `CLOSED_COMPLETE` and `CANCELLED` are terminal in
 * normal operation. They can be left, but the transition table marks it as a
 * reopen and this command demands `reopen: true` with it — an explicit second
 * act, because reopening a closed project is how a lost bid quietly becomes a
 * live one. Refusing outright would be worse: people would create a duplicate
 * project instead, and the duplicate is the thing the whole identity model
 * exists to prevent.
 */
export function setLifecycleState(
  ctx: EngineContext,
  input: {
    to: LifecycleState;
    reason: string;
    /** Required when the transition table says this is a reopen. */
    reopen?: boolean;
    /** Set alongside, where this transition also decides the bid. */
    commercialOutcome?: CommercialOutcome;
    /** On a loss, where it is known. */
    wonBy?: string;
    winningValueMinor?: number;
    /** On a framework appointment. */
    frameworkReference?: string;
    evidenceHash?: string;
  },
): { projectId: string; from: LifecycleState; to: LifecycleState; reopened: boolean } {
  authorise(ctx, 'PROJECT_SETUP', 'A');

  const project = ctx.ledger.require({ refType: 'Project', refId: ctx.projectId });
  const from = currentLifecycleState(project.state);

  const { requiresReopen } = assertLifecycleTransition(from, input.to);

  if (requiresReopen && input.reopen !== true) {
    throw new DomainError(
      'REOPEN_REQUIRED',
      `${lifecycleLabel(from)} is a closed state. Reopening it to ${lifecycleLabel(input.to)} is a separate ` +
        'authorised act and has to say so — a closed project that can be reopened by the same control that ' +
        'advances a live one is a lost bid one click away from becoming a live job.',
      409,
    );
  }

  if (input.reason.trim().length < 10) {
    throw new DomainError('LIFECYCLE_REASON_REQUIRED', 'Say why this project is moving state.', 422, [
      { field: 'reason', message: 'Required, and long enough to be read' },
    ]);
  }

  const evidence = registerEvidence(ctx, {
    type: 'LIFECYCLE_TRANSITION',
    hash: input.evidenceHash ?? hashEvidence(JSON.stringify({ project: ctx.projectId, from, to: input.to, reason: input.reason })),
    description: `${String(project.state.name)}: ${lifecycleLabel(from)} → ${lifecycleLabel(input.to)}`,
  });

  const now = new Date().toISOString();
  const history = (project.state.lifecycleHistory as Array<Record<string, unknown>>) ?? [];

  write(ctx, {
    eventType: 'PROJECT_LIFECYCLE_STATE_CHANGED',
    entity: { refType: 'Project', refId: ctx.projectId },
    nextState: {
      ...project.state,
      lifecycleState: input.to,
      lifecycleStateAt: now,
      lifecycleStateBy: ctx.auth.actorId,
      lifecycleStateReason: input.reason,
      /*
       * Every state this project has been in, in order.
       *
       * A project that went on hold in March, back to tender in May and was
       * lost in July has a story, and one overwritten field tells none of it.
       * A reopen is marked, because "it was closed and somebody reopened it" is
       * the single most-asked question of any closed-then-live project.
       */
      lifecycleHistory: [
        ...history,
        { from, to: input.to, at: now, by: ctx.auth.actorId, reason: input.reason, ...(requiresReopen ? { reopened: true } : {}) },
      ],
      ...(input.commercialOutcome ? { commercialOutcome: input.commercialOutcome } : {}),
      ...(input.wonBy ? { lostTo: input.wonBy } : {}),
      ...(input.winningValueMinor !== undefined ? { winningValueMinor: input.winningValueMinor } : {}),
      ...(input.frameworkReference ? { frameworkReference: input.frameworkReference } : {}),
      // Delivery follows the lifecycle where the lifecycle decides it. A
      // suspended project's team is not mobilising, whatever the field said
      // before, and leaving the two to be set independently is how a screen
      // reports a demobilised job as active.
      deliveryStatus: deliveryFor(input.to) ?? project.state.deliveryStatus,
      status: lifecycleState(input.to).terminal ? 'CLOSED' : 'ACTIVE',
    },
    evidenceRefs: [evidence],
  });

  return { projectId: ctx.projectId, from, to: input.to, reopened: requiresReopen };
}

/**
 * The lifecycle state a project is in, for one created before the field existed.
 *
 * Derived from the phase rather than defaulted to `DRAFT`, because a project
 * mid-construction that reported itself as a draft would be wrong in the most
 * visible possible way — and the ledger is append-only, so the historic records
 * cannot be rewritten to carry a field they were written without.
 */
export function currentLifecycleState(state: Record<string, unknown>): LifecycleState {
  const held = state.lifecycleState as LifecycleState | undefined;
  if (held) return held;

  const phase = state.phase as LifecyclePhase | undefined;
  if (phase === 'TENDER') return 'PRE_AWARD';
  if (phase === 'HANDOVER') return 'HANDOVER';
  if (phase === 'OPERATIONS') return 'OPERATIONS';
  if (phase === 'CONCEPT' || phase === 'DESIGN') {
    // Pre-award unless an award has been recorded — a contractor's design work
    // happens after the win, a client's before the tender, and the award is the
    // only thing that tells the two apart.
    return state.awardedAt ? 'LIVE_ACTIVE' : 'PRE_AWARD';
  }
  return 'LIVE_ACTIVE';
}

/** The delivery status a lifecycle state settles, where it settles one. */
function deliveryFor(state: LifecycleState): DeliveryStatus | undefined {
  if (state === 'LIVE_MOBILISING') return 'MOBILISING';
  if (state === 'LIVE_ACTIVE') return 'ACTIVE';
  if (state === 'SUSPENDED') return 'SUSPENDED';
  if (state === 'CLOSED_COMPLETE' || state === 'OPERATIONS') return 'COMPLETE';
  // Pre-award states say nothing about delivery, which has not started.
  if (!lifecycleState(state).live && !lifecycleState(state).terminal) return 'NOT_STARTED';
  return undefined;
}

/** The lifecycle state a project opens in, given where it joins the lifecycle. */
export function openingLifecycleState(startingPhase: LifecyclePhase): LifecycleState {
  if (startingPhase === 'TENDER') return 'PRE_AWARD';
  if (startingPhase === 'HANDOVER') return 'HANDOVER';
  if (startingPhase === 'OPERATIONS') return 'OPERATIONS';
  // A project opened at CONCEPT or DESIGN by a client is pre-award work on
  // their own asset; one opened at CONSTRUCTION is already being built.
  if (startingPhase === 'CONCEPT' || startingPhase === 'DESIGN') return 'PRE_AWARD';
  return 'LIVE_ACTIVE';
}


/**
 * The ten comparisons between what was tendered and what was contracted.
 *
 * A fixed table rather than a free list, for the reason every fixed table on
 * this platform exists: a reconciliation that quietly grew or lost a line
 * between two projects cannot be compared across them, and "we reconciled the
 * award" would mean something different each time.
 *
 * Each becomes an item with an owner, a due date, a status and an approval. The
 * platform fills in the two it can measure — price and programme, because it
 * holds both numbers — and opens the rest as questions somebody has to answer.
 * **It does not pretend to have compared scope.** Comparing a tendered scope
 * with a contracted one is a reading of two documents, and a machine-generated
 * "no difference" against a scope nobody read is the single most dangerous row
 * this table could carry.
 */
const RECONCILIATION_LINES: ReadonlyArray<{
  id: string;
  tender: string;
  contract: string;
  /** Whether the platform can compute the difference or only ask for it. */
  measurable: boolean;
  /**
   * What the measured movement is counted in.
   *
   * Carried rather than inferred by the reader. The price line's movement is
   * minor units and the programme line's is days, and a screen that formatted
   * both the same way printed a £4.5M movement as the bare integer
   * `450000000` beside a correctly rendered "209 days" — a number nobody could
   * read, next to one they could, in the same column.
   */
  unit?: 'MONEY' | 'DAYS';
}> = [
  { id: 'PRICE', tender: 'Tender price', contract: 'Contract sum', measurable: true, unit: 'MONEY' },
  { id: 'PROGRAMME', tender: 'Tender programme', contract: 'Contract programme', measurable: true, unit: 'DAYS' },
  { id: 'SCOPE', tender: 'Tender scope', contract: 'Contracted scope', measurable: false },
  { id: 'ASSUMPTIONS', tender: 'Tender assumptions', contract: 'Contractual obligations', measurable: false },
  { id: 'EXCLUSIONS', tender: 'Tender exclusions', contract: 'Accepted or removed exclusions', measurable: false },
  { id: 'RISKS', tender: 'Tender risks', contract: 'Transferred, retained or closed risks', measurable: false },
  { id: 'DESIGN', tender: 'Tender design', contract: 'Contract design requirements', measurable: false },
  { id: 'RESOURCES', tender: 'Proposed resources', contract: 'Approved mobilisation resources', measurable: false },
  { id: 'CASHFLOW', tender: 'Tender cashflow', contract: 'Contract cashflow', measurable: false },
  { id: 'PROCUREMENT', tender: 'Supplier quotations', contract: 'Award-ready procurement packages', measurable: false },
];

/** Days from award before a reconciliation item is overdue. */
const RECONCILIATION_DUE_DAYS = 28;

/**
 * Open the reconciliation.
 *
 * Every line starts `OPEN` and unowned. An item the platform assigned to
 * somebody who has not agreed to it is an item nobody does, and a due date it
 * invented is a date nobody meets — so the due date is a default a person can
 * move and the owner is a blank a person fills.
 */
function openReconciliation(
  ctx: EngineContext,
  input: {
    tenderBaselineId: string;
    awardBaselineId: string;
    project: Record<string, unknown>;
    award: AwardParticulars;
    at: string;
  },
): string {
  const reconciliationId = ulid();
  const due = new Date(Date.parse(input.at) + RECONCILIATION_DUE_DAYS * 86_400_000).toISOString().slice(0, 10);

  const tenderValue = Number(input.project.contractValueMinor ?? 0);
  const contractSum = Number(input.award.contractSumMinor ?? 0);

  const tenderDays = daysBetween(String(input.project.plannedStart ?? ''), String(input.project.plannedCompletion ?? ''));
  const contractDays = daysBetween(input.award.contractStartDate, input.award.contractCompletionDate);

  const items = RECONCILIATION_LINES.map((line) => {
    // The two the platform holds both sides of. Stated as a movement rather
    // than as a verdict: whether a 3% difference is acceptable is a commercial
    // judgement, and a chart that called it "within tolerance" would be making
    // one on somebody's behalf.
    // Numbers, not sentences. The unit travels with them and the screen
    // formats — a domain that returned "£4.50M" would be deciding a currency,
    // a locale and a precision on behalf of every reader of every project.
    let measured: { tenderSide?: number; contractSide?: number; movement?: number } = {};
    if (line.id === 'PRICE') {
      measured = { tenderSide: tenderValue, contractSide: contractSum, movement: contractSum - tenderValue };
    } else if (line.id === 'PROGRAMME' && tenderDays !== undefined && contractDays !== undefined) {
      measured = { tenderSide: tenderDays, contractSide: contractDays, movement: contractDays - tenderDays };
    }

    return {
      id: line.id,
      tender: line.tender,
      contract: line.contract,
      measurable: line.measurable,
      unit: line.unit ?? null,
      ...measured,
      status: 'OPEN' as const,
      owner: null,
      dueDate: due,
      note: null,
      approvedBy: null,
      approvedAt: null,
    };
  });

  write(ctx, {
    eventType: 'RECONCILIATION_OPENED',
    entity: { refType: 'AwardReconciliation', refId: reconciliationId },
    nextState: {
      id: reconciliationId,
      projectId: ctx.projectId,
      tenderBaselineId: input.tenderBaselineId,
      awardBaselineId: input.awardBaselineId,
      openedAt: input.at,
      openedBy: ctx.auth.actorId,
      items,
    },
  });

  return reconciliationId;
}

/** Whole days between two ISO dates, or undefined where either is not one. */
function daysBetween(from: string, to: string): number | undefined {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Settle one reconciliation line.
 *
 * Four things move together — the status, the owner, the note and the approval
 * — because a line marked `AGREED` with nobody's name against it is a line that
 * will be asked about and cannot be answered. Closing one requires a note: the
 * whole value of this table is in the sentence explaining what the difference
 * turned out to be.
 */
export function settleReconciliationItem(
  ctx: EngineContext,
  input: {
    reconciliationId: string;
    itemId: string;
    status: 'OPEN' | 'IN_PROGRESS' | 'AGREED' | 'ACCEPTED_AS_RISK' | 'DISPUTED';
    owner?: string;
    dueDate?: string;
    note?: string;
  },
): { reconciliationId: string; itemId: string; status: string } {
  authorise(ctx, 'PROJECT_SETUP', 'U');

  const record = ctx.ledger.require({ refType: 'AwardReconciliation', refId: input.reconciliationId });
  const items = (record.state.items as Array<Record<string, unknown>>) ?? [];
  const item = items.find((entry) => entry.id === input.itemId);
  if (!item) {
    throw new DomainError('RECONCILIATION_ITEM_UNKNOWN', `No reconciliation line "${input.itemId}" on this award`, 404);
  }

  const closing = input.status === 'AGREED' || input.status === 'ACCEPTED_AS_RISK' || input.status === 'DISPUTED';
  if (closing && !(input.note ?? '').trim()) {
    throw new DomainError(
      'RECONCILIATION_NOTE_REQUIRED',
      `Closing "${String(item.tender)} against ${String(item.contract)}" needs the sentence saying what the ` +
        'difference turned out to be. That sentence is the whole value of this table.',
      422,
      [{ field: 'note', message: 'Required when settling a line' }],
    );
  }

  const now = new Date().toISOString();

  write(ctx, {
    eventType: 'RECONCILIATION_ITEM_SETTLED',
    entity: { refType: 'AwardReconciliation', refId: input.reconciliationId },
    nextState: {
      ...record.state,
      items: items.map((entry) =>
        entry.id === input.itemId
          ? {
              ...entry,
              status: input.status,
              owner: input.owner ?? entry.owner,
              dueDate: input.dueDate ?? entry.dueDate,
              note: input.note ?? entry.note,
              // Stamped only on a close. An "approved" date on an open line is
              // the field that makes a register look finished.
              approvedBy: closing ? ctx.auth.actorId : null,
              approvedAt: closing ? now : null,
            }
          : entry,
      ),
    },
  });

  return { reconciliationId: input.reconciliationId, itemId: input.itemId, status: input.status };
}

/**
 * The award reconciliation as a position, with what is overdue named.
 *
 * Percentage complete is over closed lines, and the two the platform measured
 * are **not** counted as closed — it computed a movement, which is the input to
 * the judgement rather than the judgement. A reconciliation that reported 20%
 * complete the moment it opened would be reporting its own arithmetic as work.
 */
export function awardReconciliation(
  ctx: EngineContext,
  asAt = new Date().toISOString().slice(0, 10),
): {
  reconciliationId?: string;
  items: Array<Record<string, unknown>>;
  openCount: number;
  overdue: Array<Record<string, unknown>>;
  completePercent: number | null;
  summary: string;
} | null {
  authorise(ctx, 'PROJECT_SETUP', 'R');

  const record = ctx.ledger.list(ctx.projectId, 'AwardReconciliation').at(-1);
  if (!record) return null;

  const items = (record.state.items as Array<Record<string, unknown>>) ?? [];
  const closed = items.filter((item) => item.status !== 'OPEN' && item.status !== 'IN_PROGRESS');
  const open = items.filter((item) => item.status === 'OPEN' || item.status === 'IN_PROGRESS');
  const overdue = open.filter((item) => String(item.dueDate ?? '') < asAt);

  return {
    reconciliationId: record.refId,
    items,
    openCount: open.length,
    overdue,
    completePercent: items.length === 0 ? null : Math.round((closed.length / items.length) * 1000) / 10,
    summary:
      `${closed.length} of ${items.length} lines settled` +
      (overdue.length > 0 ? `, ${overdue.length} past its date` : '') +
      '.',
  };
}


// ------------------------------------------- converting a bid into the job

/**
 * The delivery stage a converted project opens at.
 *
 * `DESIGN` for a contractor who has design responsibility and has to develop
 * what they priced; `CONSTRUCTION` where the design is complete and novated and
 * the job starts on site. Both are ordinary, and which one it is changes what
 * the project's next gate is — so it is asked rather than assumed.
 */
export type DeliveryEntry = 'DESIGN' | 'CONSTRUCTION';

/**
 * What the awarded contract says, captured at the gate.
 *
 * Not a copy of the tender. Every one of these is a term somebody agreed, and
 * the gap between them and what was priced is the reconciliation this project
 * spends its first month closing.
 */
export type AwardParticulars = {
  contractAwardDate: string;
  contractSumMinor: number;
  contractForm: string;
  /** Amendments to the standard form. The Z-clauses are where the risk moved. */
  amendments?: string;
  contractedScope: string;
  employersRequirements?: string;
  contractorsProposals?: string;
  /** Qualifications and exclusions that survived into the contract. */
  acceptedExclusions?: string[];
  /** Ones the client struck out, which are now this business's risk. */
  removedExclusions?: string[];
  contractStartDate: string;
  contractCompletionDate: string;
  paymentTermsDays?: number;
  retentionPercent?: number;
  liquidatedDamagesPerDayMinor?: number;
  bondsAndGuarantees?: string;
  insurances?: string;
  designResponsibility?: string;
  novationArrangements?: string;
  mobilisationDate?: string;
  noticeToProceedDate?: string;
  planningConditions?: string[];
  regulatoryObligations?: string[];
  contractParties?: Array<{ role: string; name: string }>;
  keySubcontractors?: string[];
};

/**
 * Contract award: the same project becomes the job.
 *
 * ## One project identity, start to finish
 *
 * The project id, reference, enterprise ownership, client record, evidence
 * vault, Golden Thread and audit history are created once, at tender
 * registration, and **never change**. A won bid does not become a second
 * project; it changes its lifecycle status.
 *
 * This was built the other way first — award created a successor project and
 * linked the two — and it was wrong. Two records for one job means the Golden
 * Thread has a seam in it exactly where the most-argued question lives: a
 * variation in year three has to trace back through a join to the tender
 * assumption that priced it, and a join is a thing that breaks. It also meant
 * re-entering information the platform already held, which is the failure the
 * platform exists to remove.
 *
 * ## The tender record becomes immutable, not invisible
 *
 * At conversion the tender position is frozen as a named baseline. The ledger is
 * append-only so nothing could have been rewritten anyway, but a baseline is the
 * difference between "the records are still there somewhere" and "this is what
 * we tendered, as one thing, and here is what we contracted". Everything after
 * award is measured against it.
 *
 * ## Which delivery stage it opens at
 *
 * `DESIGN` or `CONSTRUCTION`, chosen by the person converting. A contractor with
 * design responsibility develops what they priced; one taking a novated design
 * starts on site.
 *
 * `DESIGN` is *earlier* in this lifecycle than `TENDER`, because the lifecycle
 * order is the asset's and the asset's order is the client's: design it, then
 * tender it. The contractor's order is the reverse. That is why this is a
 * `CONVERSION` rather than a regression — the project has not gone back a stage,
 * it has started delivering — and why `entryStage` is kept beside `phase`
 * permanently, so the screen can say "entered at Tender, currently in Design"
 * rather than implying the project slipped.
 */
export function convertToDelivery(
  ctx: EngineContext,
  input: {
    award: AwardParticulars;
    deliveryEntry: DeliveryEntry;
    /** Why this is being converted now, and on whose authority. */
    justification: string;
    evidenceHash?: string;
    /**
     * The client's own key for this attempt (§11.2, FR-005).
     *
     * A retry carrying the key of an attempt that already succeeded gets that
     * attempt's receipt back, unchanged, and nothing else happens. Without one
     * a double-click, a proxy retry or a dropped response gets a 409 telling
     * somebody their award failed when it did not — which is the moment a
     * person creates the duplicate project this whole model exists to prevent.
     */
    idempotencyKey?: string;
  },
): ConversionReceipt {
  /*
   * `A` on PROJECT_SETUP — an approval, not a create.
   *
   * The specification asks for an Enterprise Administrator or an authorised
   * bid/commercial director, and that is what this grant already means on this
   * platform: `roles.ts` gives `PROJECT_SETUP:A` to the administrator and the
   * commercial authority and to nobody else. A second role check written here
   * would be a second permission model, and the first thing to drift.
   */
  authorise(ctx, 'PROJECT_SETUP', 'A');

  const project = ctx.ledger.require({ refType: 'Project', refId: ctx.projectId });
  const from = project.state.phase as LifecyclePhase;

  /*
   * A retry of a conversion that already succeeded.
   *
   * The key decides which of two very different things is happening. Same key:
   * this is the same attempt arriving twice — a double-click, a proxy retry, a
   * response that never got back — and the honest answer is the receipt that
   * attempt produced, with no second write. Different key, or none: somebody is
   * awarding an already-awarded project, and that is a supplemental agreement
   * rather than a conversion.
   *
   * Returning 409 to the first case is how a person concludes their award
   * failed when it did not, and then creates the duplicate project this whole
   * identity model exists to prevent.
   */
  const previous = project.state.conversionReceipt as ConversionReceipt | undefined;
  if (previous) {
    if (input.idempotencyKey && previous.idempotencyKey === input.idempotencyKey) {
      return { ...previous, replayed: true };
    }
    throw new DomainError(
      'ALREADY_CONVERTED',
      `This project was converted to delivery on ${String(project.state.awardedAt ?? '').slice(0, 10)}. ` +
        'A second award on one project is a supplemental agreement, which is a contract record rather than a conversion.',
      409,
    );
  }
  if (from !== 'TENDER') {
    throw new DomainError(
      'PROJECT_NOT_AT_TENDER',
      `A contract award converts a project at TENDER and this one is at ${from}.` +
        (phaseIndex(from) > phaseIndex('TENDER') ? ' This project is already in delivery.' : ''),
      409,
    );
  }
  if (input.justification.trim().length < 10) {
    throw new DomainError('CONVERSION_UNJUSTIFIED', 'Say what is being awarded and on whose authority.', 422, [
      { field: 'justification', message: 'Required, and long enough to be read' },
    ]);
  }

  assertOrder(input.award.contractStartDate, input.award.contractCompletionDate, 'contractStartDate', 'contractCompletionDate');

  const now = new Date().toISOString();

  /*
   * The tender position, frozen as one thing.
   *
   * Read from the project's own records rather than taken from the caller: a
   * baseline somebody typed is a baseline that says whatever they wanted it to.
   * The estimate is the frozen one if there is one — an unfrozen estimate is a
   * working figure and freezing it here would stamp a number nobody signed.
   */
  const frozenEstimate = ctx.ledger
    .list(ctx.projectId, 'Estimate')
    .filter((record) => record.state.status === 'FROZEN')
    .at(-1);

  const tenderBaselineId = ulid();
  const tenderBaseline = {
    id: tenderBaselineId,
    projectId: ctx.projectId,
    kind: 'TENDER' as const,
    frozenAt: now,
    frozenBy: ctx.auth.actorId,
    reason: 'Frozen at contract award. Everything after this is measured against it.',
    tenderValueMinor: Number(project.state.contractValueMinor ?? 0),
    estimateId: frozenEstimate?.refId,
    estimateTotalMinor: frozenEstimate ? Number(frozenEstimate.state.totalMinor ?? 0) : undefined,
    plannedStart: project.state.plannedStart,
    plannedCompletion: project.state.plannedCompletion,
    // What the ledger held at the moment of award, by type and count. Not the
    // records themselves — they are in the chain and unchanged — but the shape
    // of what was there, so a later reader can tell whether something appeared
    // before or after award without walking every event.
    heldAtAward: Object.fromEntries(
      ['Estimate', 'RFQ', 'SupplierSubmission', 'RiskRegisterItem', 'ScopePackage', 'Drawing', 'BoQItem'].map((refType) => [
        refType,
        ctx.ledger.list(ctx.projectId, refType).length,
      ]),
    ),
  };

  const baselineEvidence = registerEvidence(ctx, {
    type: 'TENDER_BASELINE',
    hash: hashEvidence(JSON.stringify(tenderBaseline)),
    description: `Tender baseline frozen at award of ${String(project.state.name)}`,
  });

  write(ctx, {
    eventType: 'BASELINE_FROZEN',
    entity: { refType: 'ProjectBaseline', refId: tenderBaselineId },
    nextState: tenderBaseline,
    evidenceRefs: [baselineEvidence],
  });

  // And the contract award baseline beside it, so "what we tendered" and "what
  // we contracted" are two records rather than one record and a memory.
  const awardBaselineId = ulid();
  write(ctx, {
    eventType: 'BASELINE_FROZEN',
    entity: { refType: 'ProjectBaseline', refId: awardBaselineId },
    nextState: {
      id: awardBaselineId,
      projectId: ctx.projectId,
      kind: 'CONTRACT_AWARD' as const,
      frozenAt: now,
      frozenBy: ctx.auth.actorId,
      reason: `Contract awarded: ${input.justification}`,
      supersedesBaselineId: null,
      comparedToBaselineId: tenderBaselineId,
      contractSumMinor: input.award.contractSumMinor,
      contractStartDate: input.award.contractStartDate,
      contractCompletionDate: input.award.contractCompletionDate,
      award: input.award,
    },
    evidenceRefs: [baselineEvidence],
  });

  /*
   * Every piece of pre-award information, with the question attached.
   *
   * Opened before the award is written, so a conversion that fails part way
   * leaves no project claiming to be live with nothing governing what its
   * tender drawings may be used for.
   *
   * Every record starts at REQUIRES_VALIDATION. Conversion is not permitted to
   * grant authority to anything — see `inheritance.ts`, and §6.2: a document
   * marked Proposed during tender cannot become approved for construction
   * solely because the project was won.
   */
  const inheritance = openInheritanceRegister(ctx, { sourceStage: from, at: now });

  // Every difference between the two, as items somebody owns.
  const reconciliationId = openReconciliation(ctx, {
    tenderBaselineId,
    awardBaselineId,
    project: project.state,
    award: input.award,
    at: now,
  });

  const awardEvidence = registerEvidence(ctx, {
    type: 'CONTRACT_AWARD',
    hash: input.evidenceHash ?? hashEvidence(JSON.stringify({ project: ctx.projectId, award: input.award })),
    description: `Contract award: ${input.award.contractForm}, ${input.award.contractAwardDate}`,
  });

  /*
   * The receipt, built before the write so it is stored in the same event that
   * awards the contract.
   *
   * §11.4 asks for the conversion id, both baseline ids and the count of
   * reconciliation lines still open. The count is taken here rather than
   * recomputed on read: it is the number at the moment of award, and a receipt
   * whose figures move afterwards is not a receipt.
   */
  const receipt: ConversionReceipt = {
    conversionId: ulid(),
    projectId: ctx.projectId,
    previousState: currentLifecycleState(project.state),
    currentState: 'LIVE_MOBILISING',
    entryStage: (project.state.startedAtPhase as LifecyclePhase | undefined) ?? 'TENDER',
    phase: input.deliveryEntry,
    tenderBaselineId,
    awardBaselineId,
    reconciliationId,
    unresolvedReconciliationItems: RECONCILIATION_LINES.length,
    // "Forty-one inherited items awaiting validation" is a number somebody
    // acts on. A register nobody knows exists is a register nobody opens.
    inheritanceRegisterId: inheritance.registerId,
    inheritedItemsAwaitingValidation: inheritance.items,
    committedAt: now,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  };

  write(ctx, {
    eventType: 'TENDER_WON',
    entity: { refType: 'Project', refId: ctx.projectId },
    nextState: {
      ...project.state,
      // BR-002: a Won outcome does not itself make the project live — the award
      // gate does, and this is that gate. The outcome and the state move
      // together here precisely because this is the one command that completes
      // both.
      commercialOutcome: 'WON' satisfies CommercialOutcome,
      lifecycleState: 'LIVE_MOBILISING' satisfies LifecycleState,
      lifecycleStateAt: now,
      lifecycleStateBy: ctx.auth.actorId,
      lifecycleStateReason: input.justification,
      lifecycleHistory: [
        ...((project.state.lifecycleHistory as Array<Record<string, unknown>>) ?? []),
        { from: currentLifecycleState(project.state), to: 'LIVE_MOBILISING', at: now, by: ctx.auth.actorId, reason: input.justification },
      ],
      outcomeAt: now,
      outcomeBy: ctx.auth.actorId,
      outcomeReason: input.justification,
      /*
       * The three statuses a converted project carries, and why they are three.
       *
       * `phase` is where the work is. `commercialStatus` is where the contract
       * is. `deliveryStatus` is what the team is doing. They move
       * independently: a project is AWARDED and MOBILISING while still in
       * DESIGN, and collapsing them into one field is how a dashboard ends up
       * saying "design" to a commercial manager who asked whether it was signed.
       */
      commercialStatus: 'AWARDED',
      deliveryStatus: 'MOBILISING',
      awardedAt: now,
      awardedBy: ctx.auth.actorId,
      award: input.award,
      // The contract sum replaces the tender value as the project's headline
      // figure, and the tender value is not lost — it is in the baseline above.
      contractValueMinor: input.award.contractSumMinor,
      tenderValueMinor: Number(project.state.contractValueMinor ?? 0),
      plannedStart: input.award.contractStartDate,
      plannedCompletion: input.award.contractCompletionDate,
      tenderBaselineId,
      awardBaselineId,
      reconciliationId,
      inheritanceRegisterId: inheritance.registerId,
      // Held on the project so a retry has something to answer with, and so
      // somebody can produce the receipt a year later without a log search.
      conversionReceipt: receipt,
      status: 'ACTIVE',
    },
    evidenceRefs: [awardEvidence],
  });

  // And the phase moves, through the one writer that moves phases.
  stages.applyPhaseChange(ctx, {
    from,
    to: input.deliveryEntry,
    direction: 'CONVERSION',
    justification: `Contract award — converted from pre-award to delivery. ${input.justification}`,
    gateEvaluation: [],
  });

  return receipt;
}

/**
 * What a committed conversion hands back (§11.4).
 *
 * Stored on the project as well as returned, because a receipt that exists only
 * in one HTTP response is a receipt nobody can produce when it matters — and it
 * is what makes a retry answerable rather than refusable.
 */
export type ConversionReceipt = {
  conversionId: string;
  projectId: string;
  previousState: LifecycleState;
  currentState: LifecycleState;
  entryStage: LifecyclePhase;
  phase: LifecyclePhase;
  tenderBaselineId: string;
  awardBaselineId: string;
  reconciliationId: string;
  unresolvedReconciliationItems: number;
  /** The register governing what pre-award information may be used for. */
  inheritanceRegisterId: string;
  /** How many inherited items still need a disposition. All of them, at award. */
  inheritedItemsAwaitingValidation: number;
  committedAt: string;
  idempotencyKey?: string;
  /** True only on a replay, so a caller can tell a fresh commit from an echo. */
  replayed?: boolean;
};

/**
 * Whether a project is still part of the estate. A deleted project keeps every
 * record it ever had — the chain is append-only — and leaves every register,
 * rollup and picker.
 */
export function isLiveProject(state: Record<string, unknown>): boolean {
  return state.status !== 'DELETED';
}

/** The accountable manager as the project record carries it. */
export type AccountableManager = {
  userId: string;
  assignedAt: string;
  assignedBy: string;
  /** Why this person, which is the part a successor actually needs. */
  reason: string;
};

/**
 * Name the person accountable for a project.
 *
 * The estate could be grouped by portfolio, sector and region and by nothing
 * about **who runs each job** — so the one question a director asks first
 * ("whose is this?") had no answer, and every portfolio report had to leave the
 * column out or invent it from whoever last touched a record.
 *
 * Three things make this a real dimension rather than a text field:
 *
 * **It is an identity, not a name.** A string typed into a box is a dimension
 * that looks real and drifts the first time somebody spells it differently.
 * The person has to be somebody the platform knows, in this tenancy.
 *
 * **They have to be able to run the job.** Naming somebody accountable who
 * cannot open the project is an accountability nobody can discharge, so the
 * person must hold a role carrying `PROJECT_SETUP U` — read from the same
 * ownership resolution every other "who owns this" answer uses rather than a
 * second list of acceptable roles kept here.
 *
 * **It is an approval, and it carries a reason.** Naming who carries a job is a
 * governance act, not an edit, so it takes `PROJECT_SETUP A`. Reassignment is
 * allowed and expected — people move — and the ledger keeps every prior holder
 * because the chain is append-only. Who was accountable in March is a question
 * a dispute in year three turns on.
 *
 * Only the identity is stored. The name and the role are resolved when the
 * record is read, so a promotion or a change of name does not leave a stale
 * copy on every project that person runs.
 */
export function assignAccountableManager(
  ctx: EngineContext,
  eligible: ReadonlyArray<{ userId: string; name: string; role: string }>,
  input: { projectId: string; userId: string; reason: string },
): { projectId: string; userId: string; previousUserId?: string } {
  authorise(ctx, 'PROJECT_SETUP', 'A');

  const record = ctx.ledger.require({ refType: 'Project', refId: input.projectId });
  if (record.tenantId !== ctx.tenantId) {
    throw new DomainError('PROJECT_NOT_FOUND', `No project ${input.projectId}`, 404);
  }
  if (!isLiveProject(record.state)) {
    throw new DomainError(
      'PROJECT_DELETED',
      `${String(record.state.name)} was deleted. A deleted project keeps its record and takes no new decisions.`,
      409,
    );
  }

  if (input.reason.trim().length < 10) {
    throw new DomainError(
      'REASON_REQUIRED',
      'Say why this person. A successor reading the record in two years needs the reason, not just the name.',
      422,
      [{ field: 'reason', message: 'Give the reason for the appointment' }],
    );
  }

  const candidate = eligible.find((entry) => entry.userId === input.userId);
  if (!candidate) {
    throw new DomainError(
      'MANAGER_NOT_ELIGIBLE',
      'That person cannot be made accountable for a project: they are not an identity in this tenancy holding a role ' +
        'that can run one. Accountability nobody can discharge is worse than none — give them the role first.',
      422,
      [{ field: 'userId', message: 'Not a role that can run a project' }],
    );
  }

  const previous = record.state.accountableManager as AccountableManager | undefined;
  if (previous?.userId === input.userId) {
    throw new DomainError(
      'ALREADY_ACCOUNTABLE',
      `${candidate.name} is already accountable for ${String(record.state.name)}.`,
      409,
    );
  }

  const manager: AccountableManager = {
    userId: input.userId,
    assignedAt: new Date().toISOString(),
    assignedBy: ctx.auth.actorId,
    reason: input.reason.trim(),
  };

  write(ctx, {
    projectId: input.projectId,
    eventType: 'PROJECT_MANAGER_ASSIGNED',
    entity: { refType: 'Project', refId: input.projectId },
    nextState: { ...record.state, accountableManager: manager },
  });

  return {
    projectId: input.projectId,
    userId: input.userId,
    ...(previous ? { previousUserId: previous.userId } : {}),
  };
}

/** The tenancy's projects that have not been deleted. What every listing and rollup should read. */
export function liveProjects(ledger: EngineContext['ledger'], tenantId: string): ReturnType<EngineContext['ledger']['listByTenant']> {
  return ledger.listByTenant(tenantId, 'Project').filter((record) => isLiveProject(record.state));
}

/** The portfolios that have not been deleted. */
export function livePortfolios(ledger: EngineContext['ledger'], tenantId: string): ReturnType<EngineContext['ledger']['listByTenant']> {
  return ledger.listByTenant(tenantId, 'Portfolio').filter((record) => record.state.status !== 'DELETED');
}

/**
 * Delete a project.
 *
 * Asked for plainly: a project can be deleted. The record is kept — every
 * event on the project's chain stays where it is and readable by its id — and
 * the project leaves the estate: the project list, the picker, every rollup,
 * and every command, which refuses it from here on. Two things stop it. A
 * project on which money has been certified is a financial record with a
 * counterparty, and is closed out rather than deleted; a project with an
 * executed contract is a live liability, and the contract is what governs its
 * end. Everything else — a test project, a duplicate, a job that never started
 * — goes, with the reason on the record.
 */
export function deleteProject(ctx: EngineContext, input: { reason: string }): { projectId: string; deletedAt: string } {
  authorise(ctx, 'PROJECT_SETUP', 'A');

  const project = ctx.ledger.require({ refType: 'Project', refId: ctx.projectId });
  if (!isLiveProject(project.state)) {
    throw new DomainError('PROJECT_ALREADY_DELETED', `${String(project.state.name)} was deleted on ${String(project.state.deletedAt ?? '').slice(0, 10)}`, 409);
  }
  if (input.reason.trim().length < 10) {
    throw new DomainError('REASON_REQUIRED', 'Say why the project is being deleted; it is the sentence the record keeps.', 422, [
      { field: 'reason', message: 'At least ten characters' },
    ]);
  }

  const certified = ctx.ledger.list(ctx.projectId, 'PaymentCertificate').length;
  if (certified > 0) {
    throw new DomainError(
      'PROJECT_HAS_CERTIFIED_PAYMENTS',
      `${certified} payment certificate${certified === 1 ? '' : 's'} ${certified === 1 ? 'has' : 'have'} been issued on this project. Money certified to a counterparty is closed out, not deleted.`,
      409,
    );
  }
  const executed = ctx.ledger.list(ctx.projectId, 'Contract').filter((record) => record.state.status === 'EXECUTED').length;
  if (executed > 0) {
    throw new DomainError(
      'PROJECT_HAS_EXECUTED_CONTRACT',
      `${executed} executed contract${executed === 1 ? '' : 's'} ${executed === 1 ? 'is' : 'are'} in force on this project. A live contract governs how the job ends; it cannot be deleted from under it.`,
      409,
    );
  }

  const deletedAt = new Date().toISOString();
  write(ctx, {
    eventType: 'PROJECT_DELETED',
    entity: { refType: 'Project', refId: ctx.projectId },
    nextState: {
      ...project.state,
      status: 'DELETED',
      deletedAt,
      deletedBy: ctx.auth.actorId,
      deletionReason: input.reason.trim(),
    },
  });
  return { projectId: ctx.projectId, deletedAt };
}

/**
 * Delete a portfolio. A portfolio is a filing structure; it goes when nothing
 * live is filed under it, and refuses while a project still is, naming them —
 * the projects are deleted or moved first, each on its own record.
 */
export function deletePortfolio(ctx: EngineContext, input: { portfolioId: string; reason: string }): { portfolioId: string; deletedAt: string } {
  authorise(ctx, 'ENTERPRISE_STRUCTURE', 'A');

  const portfolio = ctx.ledger.require({ refType: 'Portfolio', refId: input.portfolioId });
  if (portfolio.state.tenantId !== ctx.tenantId) {
    throw new DomainError('PORTFOLIO_NOT_FOUND', `No portfolio ${input.portfolioId}`, 404);
  }
  if (portfolio.state.status === 'DELETED') {
    throw new DomainError('PORTFOLIO_ALREADY_DELETED', `${String(portfolio.state.name)} was deleted on ${String(portfolio.state.deletedAt ?? '').slice(0, 10)}`, 409);
  }
  if (input.reason.trim().length < 10) {
    throw new DomainError('REASON_REQUIRED', 'Say why the portfolio is being deleted; it is the sentence the record keeps.', 422, [
      { field: 'reason', message: 'At least ten characters' },
    ]);
  }

  const filed = liveProjects(ctx.ledger, ctx.tenantId).filter((record) => record.state.portfolioId === input.portfolioId);
  if (filed.length > 0) {
    throw new DomainError(
      'PORTFOLIO_HOLDS_PROJECTS',
      `${filed.length} project${filed.length === 1 ? ' is' : 's are'} still filed under ${String(portfolio.state.name)}: ${filed.map((record) => String(record.state.name)).join(', ')}. Delete them first, each with its own reason.`,
      409,
    );
  }

  const deletedAt = new Date().toISOString();
  write(ctx, {
    projectId: `${ctx.tenantId}-governance`,
    eventType: 'PORTFOLIO_DELETED',
    entity: { refType: 'Portfolio', refId: input.portfolioId },
    nextState: {
      ...portfolio.state,
      status: 'DELETED',
      deletedAt,
      deletedBy: ctx.auth.actorId,
      deletionReason: input.reason.trim(),
    },
  });
  return { portfolioId: input.portfolioId, deletedAt };
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

  // The write itself lives in `lifecycle/stages.ts`.
  //
  // Two commands change a project's phase: this one, and a gate decision. If
  // each wrote its own transition they would drift — and the first symptom
  // would be a stage record disagreeing with the project it describes, which
  // is fatal for a record whose entire purpose is to be the thing you trust
  // when the project's own state is in question. So there is one writer, and
  // both callers reach it having already established their own right to.
  stages.applyPhaseChange(ctx, {
    from,
    to: input.to,
    direction,
    justification: input.justification,
    gateEvaluation: evaluation.criteria,
  });

  return { from, to: input.to, direction };
}
