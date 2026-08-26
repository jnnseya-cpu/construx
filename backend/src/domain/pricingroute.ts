import { DomainError, ForbiddenError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, write, type EngineContext } from '../engines/context.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';
import { compareReturns, type ComparisonResult } from './tenderintel.ts';

/**
 * Buy it or do it — T-WF-05.
 *
 * Every package is priced twice and only one of the two answers goes in the
 * bid. The market says one number; our own people say another; and the
 * comparison between them is where a contractor either finds the margin or
 * gives it away. What was missing is not the arithmetic — it is the three
 * things that make the two numbers actually comparable.
 *
 * **Raw, normalised and evaluated are three different figures.** A quotation
 * arrives on the firm's own basis: their currency, their tax treatment, their
 * idea of what the package includes. Getting it onto the common basis is
 * *normalisation*, and it is a correction — the same scope, differently priced.
 * What it costs us to choose that firm — the risk they carry back to us, the
 * interfaces somebody has to manage, the management time, the programme — is
 * *evaluation*, and it is an addition. Mixing the two produces a number nobody
 * can defend, because half of it is arithmetic and half of it is judgement.
 * `AC-T-WF-05-01`: all three reconcile, through adjustments each of which names
 * its source.
 *
 * **Every exclusion is somebody's cost.** `AC-T-WF-05-02`. A return excluding
 * scaffold is not cheaper; it is incomplete, and the scaffold is ours until
 * somebody says otherwise. Each exclusion has to be disposed — priced as an
 * allowance, answered by an issued clarification, or accepted as a project
 * exclusion the client carries — and an undisposed one blocks the route
 * selection rather than being noticed at the settlement meeting.
 *
 * **A route selected on price alone is a route selected on one quarter of the
 * question.** `AC-T-WF-05-03`: the selection carries cost, risk, programme and
 * capacity, and refuses to be made without them. The firm that is £80,000
 * cheaper and has no capacity until March is not cheaper.
 *
 * ---
 *
 * **The normalised figure comes from the return comparison, not from here.**
 * `ReturnComparison` (T-WF-06) already holds the raw returns immutably and
 * every adjustment against them, each citing a return line or an issued
 * clarification. That *is* normalisation, and rebuilding it would produce two
 * registers of the same thing. What this adds is the evaluation layer on top
 * and the decision that follows — so the comparison's own `evaluatedMinor`,
 * which is raw plus adjustments, is read here as the **normalised** figure.
 *
 * **A related-party interest is declared before the selection, not after.**
 * Where a firm being priced is connected to somebody in the decision, the
 * declaration is on the record before the route is chosen. Declaring it
 * afterwards is not a declaration; it is an explanation.
 */

// --- The self-perform route -------------------------------------------------

export type SelfPerformEstimate = {
  /** Our own direct cost to do the work, before anything site-wide. */
  directCostMinor: number;
  durationWeeks: number;
  /** Peak operatives, which is what capacity is actually constrained by. */
  peakLabour: number;
  /** How the estimate was built, in terms somebody can check. */
  basis: string;
  /** What we carry by doing it ourselves that a subcontractor would have carried. */
  retainedRisks: string[];
  estimatedBy: string;
  estimatedAt: string;
};

// --- Evaluation -------------------------------------------------------------

/**
 * The four things it costs to choose one route over another.
 *
 * Deliberately not a percentage on the price. A percentage says the cheapest
 * firm is also the cheapest to manage, which is the opposite of true often
 * enough to matter.
 */
export const EVALUATION_HEAD = ['RISK', 'INTERFACE', 'MANAGEMENT', 'PROGRAMME'] as const;
export type EvaluationHead = (typeof EVALUATION_HEAD)[number];

export type EvaluationAdder = {
  head: EvaluationHead;
  /** Signed. Negative is legitimate: a firm that takes design risk off us costs less. */
  amountMinor: number;
  /** Why, in terms an adjudication can test. */
  basis: string;
  recordedBy: string;
  recordedAt: string;
};

// --- Exclusions -------------------------------------------------------------

/**
 * What happened to an exclusion.
 *
 * `PRICED` — we have put a number against it and it is in our cost.
 * `CLARIFIED` — an issued clarification says it is somebody else's after all.
 * `PROJECT_EXCLUSION` — the client carries it, and it goes in the bid's own
 *   exclusions schedule where they will read it.
 */
export const EXCLUSION_DISPOSITION = ['PRICED', 'CLARIFIED', 'PROJECT_EXCLUSION'] as const;
export type ExclusionDisposition = (typeof EXCLUSION_DISPOSITION)[number];

export type DisposedExclusion = {
  partyId: string;
  exclusion: string;
  disposition: ExclusionDisposition;
  /** The clarification reference, or the bid exclusion reference. */
  reference?: string;
  /** Set for PRICED. The allowance carried. */
  amountMinor?: number;
  disposedBy: string;
  disposedAt: string;
};

// --- Related parties --------------------------------------------------------

export type InterestDeclaration = {
  partyId: string;
  name: string;
  /** The connection, stated plainly. */
  nature: string;
  declaredBy: string;
  declaredAt: string;
};

// --- The route --------------------------------------------------------------

export const ROUTE = ['SUPPLY_CHAIN', 'SELF_PERFORM'] as const;
export type Route = (typeof ROUTE)[number];

type RouteState = {
  id: string;
  reference: string;
  packageReference: string;
  comparisonId?: string;
  selfPerform?: SelfPerformEstimate;
  adders: Record<string, EvaluationAdder[]>;
  exclusions: DisposedExclusion[];
  interests: InterestDeclaration[];
  selection?: {
    route: Route;
    partyId?: string;
    name: string;
    rationale: string;
    costBasis: string;
    riskBasis: string;
    programmeBasis: string;
    capacityBasis: string;
    selectedBy: string;
    selectedAt: string;
  };
  status: 'OPEN' | 'SELECTED';
};

/** The self-perform route's own key in the adders map, which has no party. */
const SELF = 'SELF_PERFORM';

function requireRoute(ctx: EngineContext, routeId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'PricingRoute', refId: routeId });
  if (!record) throw new DomainError('ROUTE_NOT_FOUND', `No pricing route ${routeId}`, 404);
  return record;
}

function stateOf(record: EntityRecord): RouteState {
  return record.state as unknown as RouteState;
}

function assertOpen(record: EntityRecord): void {
  if (record.state.status === 'SELECTED') {
    throw new DomainError(
      'ROUTE_SELECTED',
      `${String(record.state.reference)} has been selected. Changing what it was selected on afterwards is how a decision ` +
        'stops being reproducible; record a new route.',
    );
  }
}

export function openRoute(
  ctx: EngineContext,
  input: { packageReference: string; comparisonId?: string },
): { routeId: string; reference: string } {
  authorise(ctx, 'ESTIMATE_TENDER', 'C', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  if (!input.packageReference.trim()) {
    throw new DomainError('PACKAGE_REQUIRED', 'A pricing route is for one package. Name it.');
  }

  if (input.comparisonId && !ctx.ledger.get({ refType: 'ReturnComparison', refId: input.comparisonId })) {
    throw new DomainError('COMPARISON_NOT_FOUND', `No return comparison ${input.comparisonId} on this project.`, 404);
  }

  const sequence = ctx.ledger.list(ctx.projectId, 'PricingRoute').length + 1;
  const reference = `PR-${String(sequence).padStart(3, '0')}`;
  const routeId = ulid();

  write(ctx, {
    eventType: 'PRICING_ROUTE_SELECTED',
    entity: { refType: 'PricingRoute', refId: routeId },
    nextState: {
      id: routeId,
      projectId: ctx.projectId,
      reference,
      packageReference: input.packageReference,
      comparisonId: input.comparisonId,
      adders: {},
      exclusions: [],
      interests: [],
      status: 'OPEN',
      openedAt: new Date().toISOString(),
      openedBy: ctx.auth.actorId,
    },
  });

  return { routeId, reference };
}

/**
 * What it costs us to do the work ourselves.
 *
 * Kept independent of the supplier returns, which is the specification's first
 * clause and is not a technicality: a self-perform estimate built after seeing
 * the quotations is not an estimate, it is a reaction to them, and it will land
 * just under the cheapest one every time.
 */
export function recordSelfPerform(
  ctx: EngineContext,
  routeId: string,
  input: { directCostMinor: number; durationWeeks: number; peakLabour: number; basis: string; retainedRisks?: string[] },
): { directCostMinor: number } {
  authorise(ctx, 'ESTIMATE_TENDER', 'U', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireRoute(ctx, routeId);
  assertOpen(record);

  if (input.directCostMinor <= 0) throw new DomainError('COST_INVALID', 'A self-perform estimate of nothing is not an estimate.');
  if (input.durationWeeks <= 0) throw new DomainError('DURATION_INVALID', 'The work takes at least a week.');
  if (input.peakLabour <= 0) {
    throw new DomainError(
      'LABOUR_REQUIRED',
      'Say the peak number of operatives. Capacity is what constrains a self-perform route, and a route selected without it was ' +
        'selected on price alone.',
    );
  }
  if (!input.basis.trim()) {
    throw new DomainError('BASIS_REQUIRED', 'Say how the estimate was built, in terms somebody else can check.');
  }

  const selfPerform: SelfPerformEstimate = {
    directCostMinor: input.directCostMinor,
    durationWeeks: input.durationWeeks,
    peakLabour: input.peakLabour,
    basis: input.basis,
    retainedRisks: input.retainedRisks ?? [],
    estimatedBy: ctx.auth.actorId,
    estimatedAt: new Date().toISOString(),
  };

  write(ctx, {
    eventType: 'SELF_PERFORM_PRICED',
    entity: { refType: 'PricingRoute', refId: routeId },
    nextState: { ...record.state, selfPerform },
  });

  return { directCostMinor: input.directCostMinor };
}

/**
 * Add to a route what choosing it costs beyond its price.
 *
 * `partyId` names the firm, or is omitted for the self-perform route. Signed,
 * because a firm that takes design responsibility off us genuinely costs less
 * than its price — and refusing negative adders would push that saving into a
 * fudge somewhere else.
 */
export function evaluateRoute(
  ctx: EngineContext,
  routeId: string,
  input: { partyId?: string; head: EvaluationHead; amountMinor: number; basis: string },
): { head: EvaluationHead; amountMinor: number } {
  authorise(ctx, 'ESTIMATE_TENDER', 'U', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireRoute(ctx, routeId);
  assertOpen(record);
  const state = stateOf(record);

  const key = input.partyId ?? SELF;
  if (key === SELF && !state.selfPerform) {
    throw new DomainError(
      'NO_SELF_PERFORM_ESTIMATE',
      'There is no self-perform estimate to evaluate. Price the work first, then say what doing it ourselves costs beyond that.',
    );
  }
  if (key !== SELF) {
    const comparison = readComparison(ctx, state);
    if (!comparison) {
      throw new DomainError('NO_COMPARISON', `${state.reference} is not linked to a return comparison, so there are no firms to evaluate.`);
    }
    if (!comparison.bidders.some((bidder) => bidder.partyId === key)) {
      throw new DomainError('BIDDER_NOT_IN_COMPARISON', `${key} is not one of the firms in ${comparison.reference}.`);
    }
  }

  if (!input.basis.trim()) {
    throw new DomainError(
      'BASIS_REQUIRED',
      'An evaluation adder is a judgement about what this route costs us. Say what it rests on, or an adjudication cannot test it.',
    );
  }
  if (input.amountMinor === 0) {
    throw new DomainError('ADDER_IS_ZERO', 'An adder of nothing changes nothing. Leave the head off rather than pricing it at zero.');
  }

  const adder: EvaluationAdder = {
    head: input.head,
    amountMinor: input.amountMinor,
    basis: input.basis,
    recordedBy: ctx.auth.actorId,
    recordedAt: new Date().toISOString(),
  };

  const existing = state.adders[key] ?? [];

  write(ctx, {
    eventType: 'RETURN_NORMALISED',
    entity: { refType: 'PricingRoute', refId: routeId },
    nextState: {
      ...record.state,
      adders: { ...state.adders, [key]: [...existing.filter((a) => a.head !== input.head), adder] },
    },
  });

  return { head: input.head, amountMinor: input.amountMinor };
}

/**
 * Dispose of an exclusion. `AC-T-WF-05-02`.
 *
 * A return excluding scaffold is not cheaper; it is incomplete, and the
 * scaffold is ours until somebody says otherwise. Each disposition needs the
 * thing that makes it true — a number for a priced allowance, a clarification
 * reference for one that turned out to be somebody else's, a bid exclusion
 * reference for one the client will carry.
 */
export function disposeExclusion(
  ctx: EngineContext,
  routeId: string,
  input: {
    partyId: string;
    exclusion: string;
    disposition: ExclusionDisposition;
    reference?: string;
    amountMinor?: number;
  },
): { disposition: ExclusionDisposition } {
  authorise(ctx, 'ESTIMATE_TENDER', 'U', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireRoute(ctx, routeId);
  assertOpen(record);
  const state = stateOf(record);

  if (!input.exclusion.trim()) throw new DomainError('EXCLUSION_REQUIRED', 'Name the exclusion being disposed of.');

  if (input.disposition === 'PRICED') {
    if (input.amountMinor === undefined || input.amountMinor <= 0) {
      throw new DomainError(
        'ALLOWANCE_REQUIRED',
        `Pricing "${input.exclusion}" means putting a number against it. A priced allowance of nothing is an exclusion with a ` +
          'different label on it.',
      );
    }
  } else if (!input.reference?.trim()) {
    throw new DomainError(
      'DISPOSITION_UNREFERENCED',
      input.disposition === 'CLARIFIED'
        ? `Name the clarification that says "${input.exclusion}" is somebody else's. Without it this is a hope.`
        : `Name the bid exclusion this becomes. An exclusion the client is meant to carry and never reads is one we carry.`,
    );
  }

  if (input.disposition === 'CLARIFIED') {
    const clarifications = ctx.ledger.list(ctx.projectId, 'Clarification');
    const cited = clarifications.find((c) => c.state.reference === input.reference);
    if (!cited) {
      throw new DomainError('UNKNOWN_CLARIFICATION', `There is no clarification ${input.reference} on this project.`);
    }
    if (cited.state.status !== 'ISSUED' && cited.state.status !== 'ANSWERED') {
      throw new DomainError(
        'CLARIFICATION_NOT_ISSUED',
        `${input.reference} has not been answered, so it does not yet say anything about "${input.exclusion}".`,
      );
    }
  }

  const disposed: DisposedExclusion = {
    partyId: input.partyId,
    exclusion: input.exclusion,
    disposition: input.disposition,
    reference: input.reference,
    amountMinor: input.amountMinor,
    disposedBy: ctx.auth.actorId,
    disposedAt: new Date().toISOString(),
  };

  write(ctx, {
    eventType: 'RETURN_NORMALISED',
    entity: { refType: 'PricingRoute', refId: routeId },
    nextState: {
      ...record.state,
      exclusions: [
        ...state.exclusions.filter((e) => !(e.partyId === input.partyId && e.exclusion === input.exclusion)),
        disposed,
      ],
    },
  });

  return { disposition: input.disposition };
}

/**
 * Declare a connection to a firm being priced.
 *
 * Before the selection, never after. Declaring it afterwards is not a
 * declaration; it is an explanation.
 */
export function declareInterest(
  ctx: EngineContext,
  routeId: string,
  input: { partyId: string; name: string; nature: string },
): { declaredAt: string } {
  authorise(ctx, 'ESTIMATE_TENDER', 'U', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireRoute(ctx, routeId);
  assertOpen(record);
  const state = stateOf(record);

  if (!input.nature.trim()) {
    throw new DomainError('NATURE_REQUIRED', 'Say what the connection is. "An interest" is not a declaration.');
  }

  const declaredAt = new Date().toISOString();

  write(ctx, {
    eventType: 'RETURN_NORMALISED',
    entity: { refType: 'PricingRoute', refId: routeId },
    nextState: {
      ...record.state,
      interests: [
        ...state.interests.filter((i) => i.partyId !== input.partyId),
        { partyId: input.partyId, name: input.name, nature: input.nature, declaredBy: ctx.auth.actorId, declaredAt },
      ],
    },
  });

  return { declaredAt };
}

// --- The three legs ---------------------------------------------------------

function readComparison(ctx: EngineContext, state: RouteState): ComparisonResult | undefined {
  if (!state.comparisonId) return undefined;
  return compareReturns(ctx, state.comparisonId);
}

export type RouteOption = {
  route: Route;
  partyId?: string;
  name: string;
  /** What the firm sent, or what we said it costs us. */
  rawMinor: number;
  /** Raw plus the normalisation adjustments — the same scope, differently priced. */
  normalisedMinor: number;
  /** Normalised plus what choosing this route costs us. */
  evaluatedMinor: number;
  adders: EvaluationAdder[];
  /** Exclusions from this firm that nobody has disposed of. */
  openExclusions: string[];
  /** Allowances carried because this firm excluded the work. */
  allowancesMinor: number;
  durationWeeks?: number;
  peakLabour?: number;
  interest?: InterestDeclaration;
  comparable: boolean;
  notComparableBecause?: string;
};

export type RoutePosition = {
  reference: string;
  packageReference: string;
  options: RouteOption[];
  /** Present only when every option is comparable. Lowest evaluated first. */
  ranking?: string[];
  rankingSuppressed: boolean;
  suppressionReason?: string;
  selection?: RouteState['selection'];
  status: string;
  summary: string;
};

function optionsOf(ctx: EngineContext, record: EntityRecord): RouteOption[] {
  const state = stateOf(record);
  const comparison = readComparison(ctx, state);
  const options: RouteOption[] = [];

  const disposedFor = (partyId: string) => state.exclusions.filter((e) => e.partyId === partyId);
  const interestFor = (partyId: string) => state.interests.find((i) => i.partyId === partyId);

  for (const bidder of comparison?.bidders ?? []) {
    if (!bidder.returned) continue;
    const adders = state.adders[bidder.partyId] ?? [];
    // The comparison's own evaluated figure is raw plus its adjustments, which
    // is the normalised basis. See the module note: it is read here rather than
    // recomputed, so there is one register of the adjustments and not two.
    const normalisedMinor = bidder.evaluatedMinor;
    const disposed = disposedFor(bidder.partyId);
    const allowancesMinor = disposed
      .filter((e) => e.disposition === 'PRICED')
      .reduce((sum, e) => sum + (e.amountMinor ?? 0), 0);

    const rawExclusions = comparisonExclusions(ctx, state, bidder.partyId);
    const openExclusions = rawExclusions.filter(
      (exclusion) => !disposed.some((e) => e.exclusion === exclusion),
    );

    options.push({
      route: 'SUPPLY_CHAIN',
      partyId: bidder.partyId,
      name: bidder.name,
      rawMinor: bidder.rawMinor,
      normalisedMinor,
      evaluatedMinor: normalisedMinor + allowancesMinor + adders.reduce((sum, a) => sum + a.amountMinor, 0),
      adders,
      openExclusions,
      allowancesMinor,
      interest: interestFor(bidder.partyId),
      comparable: openExclusions.length === 0,
      notComparableBecause:
        openExclusions.length > 0
          ? `${openExclusions.length} exclusion${openExclusions.length === 1 ? '' : 's'} nobody has disposed of: ${openExclusions.join('; ')}`
          : undefined,
    });
  }

  if (state.selfPerform) {
    const adders = state.adders[SELF] ?? [];
    options.push({
      route: 'SELF_PERFORM',
      name: 'Self-perform',
      rawMinor: state.selfPerform.directCostMinor,
      // Nothing to normalise: it is already on our own basis, which is the
      // basis everything else is being normalised to.
      normalisedMinor: state.selfPerform.directCostMinor,
      evaluatedMinor: state.selfPerform.directCostMinor + adders.reduce((sum, a) => sum + a.amountMinor, 0),
      adders,
      openExclusions: [],
      allowancesMinor: 0,
      durationWeeks: state.selfPerform.durationWeeks,
      peakLabour: state.selfPerform.peakLabour,
      comparable: true,
    });
  }

  return options;
}

/** The exclusions a firm actually stated, read from the raw return. */
function comparisonExclusions(ctx: EngineContext, state: RouteState, partyId: string): string[] {
  if (!state.comparisonId) return [];
  const record = ctx.ledger.get({ refType: 'ReturnComparison', refId: state.comparisonId });
  const returns = (record?.state.returns as Array<{ bidderPartyId: string; exclusions: string[] }>) ?? [];
  return returns.find((r) => r.bidderPartyId === partyId)?.exclusions ?? [];
}

export function routePosition(ctx: EngineContext, routeId: string): RoutePosition {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireRoute(ctx, routeId);
  const state = stateOf(record);
  const options = optionsOf(ctx, record);

  const reasons: string[] = [];
  if (options.length < 2) {
    reasons.push(
      options.length === 0
        ? 'neither route is priced'
        : `only the ${options[0]!.route === 'SELF_PERFORM' ? 'self-perform' : 'supply-chain'} route is priced`,
    );
  }
  for (const option of options.filter((o) => !o.comparable)) {
    reasons.push(`${option.name}: ${option.notComparableBecause}`);
  }

  const rankingSuppressed = reasons.length > 0;
  const ranked = [...options].sort((a, b) => a.evaluatedMinor - b.evaluatedMinor).map((option) => option.name);

  const summary = rankingSuppressed
    ? `${state.reference}: ranking suppressed — ${reasons.join('; ')}.`
    : `${state.reference}: ${options.length} routes on a common basis, cheapest evaluated is ${ranked[0]}.`;

  return {
    reference: state.reference,
    packageReference: state.packageReference,
    options,
    ranking: rankingSuppressed ? undefined : ranked,
    rankingSuppressed,
    suppressionReason: rankingSuppressed ? reasons.join('; ') : undefined,
    selection: state.selection,
    status: state.status,
    summary,
  };
}

// --- The selection ----------------------------------------------------------

/**
 * Choose the route. `AC-T-WF-05-03`.
 *
 * Four bases, none of them optional. A route chosen on price alone was chosen
 * on one quarter of the question, and the firm that is £80,000 cheaper and has
 * no capacity until March is not cheaper. The cheapest evaluated option does
 * not have to win — but choosing another one has to say so out loud, because
 * that is the sentence somebody will be asked about.
 */
export function selectRoute(
  ctx: EngineContext,
  routeId: string,
  input: {
    route: Route;
    partyId?: string;
    rationale: string;
    costBasis: string;
    riskBasis: string;
    programmeBasis: string;
    capacityBasis: string;
  },
): { name: string; evaluatedMinor: number; cheapest: boolean } {
  authorise(ctx, 'ESTIMATE_TENDER', 'A', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireRoute(ctx, routeId);
  assertOpen(record);
  const state = stateOf(record);
  const options = optionsOf(ctx, record);

  const chosen = options.find((option) =>
    input.route === 'SELF_PERFORM' ? option.route === 'SELF_PERFORM' : option.partyId === input.partyId,
  );
  if (!chosen) {
    throw new DomainError(
      'ROUTE_NOT_PRICED',
      input.route === 'SELF_PERFORM'
        ? 'There is no self-perform estimate to select.'
        : `${input.partyId ?? 'That firm'} has no return in this route's comparison.`,
    );
  }

  const undisposed = options.filter((option) => option.openExclusions.length > 0);
  if (undisposed.length > 0) {
    throw new DomainError(
      'EXCLUSIONS_UNDISPOSED',
      `${undisposed.map((option) => `${option.name} — ${option.notComparableBecause}`).join('; ')}. ` +
        'Every exclusion is somebody’s cost, and until each is priced, clarified or accepted as a project exclusion the routes ' +
        'are not on the same basis.',
    );
  }

  const missing = (['rationale', 'costBasis', 'riskBasis', 'programmeBasis', 'capacityBasis'] as const).filter(
    (field) => !input[field]?.trim(),
  );
  if (missing.length > 0) {
    throw new DomainError(
      'BASIS_INCOMPLETE',
      `A route is chosen on cost, risk, programme and capacity together. Missing: ${missing.join(', ')}. ` +
        'The firm that is cheaper and has no capacity until March is not cheaper.',
    );
  }

  // Somebody who declared a connection to the firm does not then choose it.
  const interest = chosen.partyId ? state.interests.find((i) => i.partyId === chosen.partyId) : undefined;
  if (interest && interest.declaredBy === ctx.auth.actorId) {
    throw new ForbiddenError(
      `You declared a connection to ${interest.name}: ${interest.nature}. Declaring an interest and then making the decision ` +
        'anyway is worse than not declaring it, because it puts the conflict on the record beside your own signature.',
      'DECLARED_INTEREST_CONFLICT',
    );
  }

  const cheapestMinor = Math.min(...options.map((option) => option.evaluatedMinor));
  const cheapest = chosen.evaluatedMinor === cheapestMinor;
  const selectedAt = new Date().toISOString();

  write(ctx, {
    eventType: 'PRICING_ROUTE_SELECTED',
    entity: { refType: 'PricingRoute', refId: routeId },
    nextState: {
      ...record.state,
      status: 'SELECTED',
      selection: {
        route: input.route,
        partyId: input.partyId,
        name: chosen.name,
        rationale: input.rationale,
        costBasis: input.costBasis,
        riskBasis: input.riskBasis,
        programmeBasis: input.programmeBasis,
        capacityBasis: input.capacityBasis,
        selectedBy: ctx.auth.actorId,
        selectedAt,
      },
      selectedEvaluatedMinor: chosen.evaluatedMinor,
      selectedWasCheapest: cheapest,
    },
  });

  return { name: chosen.name, evaluatedMinor: chosen.evaluatedMinor, cheapest };
}

// --- The tenant-wide position -----------------------------------------------

export type PricingRoutePosition = {
  routes: Array<{
    routeId: string;
    reference: string;
    packageReference: string;
    status: string;
    options: number;
    rankingSuppressed: boolean;
    selectedRoute?: Route;
    selectedName?: string;
    selectedWasCheapest?: boolean;
    interests: number;
  }>;
  summary: string;
};

export function pricingRoutePosition(ctx: EngineContext): PricingRoutePosition {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const routes = ctx.ledger.list(ctx.projectId, 'PricingRoute').map((record) => {
    const state = stateOf(record);
    const position = routePosition(ctx, state.id);
    return {
      routeId: state.id,
      reference: state.reference,
      packageReference: state.packageReference,
      status: state.status,
      options: position.options.length,
      rankingSuppressed: position.rankingSuppressed,
      selectedRoute: state.selection?.route,
      selectedName: state.selection?.name,
      selectedWasCheapest: record.state.selectedWasCheapest as boolean | undefined,
      interests: state.interests.length,
    };
  });

  const notCheapest = routes.filter((route) => route.selectedWasCheapest === false).length;
  const parts = [`${routes.length} package route${routes.length === 1 ? '' : 's'}`];
  if (notCheapest > 0) parts.push(`${notCheapest} where the cheapest evaluated option was not chosen`);

  return { routes, summary: parts.join(', ') + '.' };
}
