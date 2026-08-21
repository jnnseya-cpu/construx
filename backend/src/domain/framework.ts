import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import {
  ORGANISATION_BANDS,
  organisationScale,
  type OrganisationBand,
  type OrganisationScale,
} from '../lifecycle/scale.ts';
import { eligibilityProblem, TRADES, tradeByCode, type TradeGroup } from './supplychain.ts';

/**
 * Framework agreements.
 *
 * A framework is not a longer supplier list. It is a standing relationship with
 * a term, agreed commercial terms, and a rule for how work is awarded under it —
 * and the rule is the part that decides whether it is worth having. A framework
 * where the same firm gets every package is a preferred supplier arrangement
 * with extra paperwork; one where every package goes to open competition is a
 * list. Both are common and both waste the relationship.
 *
 * Three things this module does that a list cannot:
 *
 *   1. It sizes itself. How many firms a business needs is arithmetic — the
 *      trades it actually buys, multiplied by enough firms per trade to run a
 *      competitive enquiry and survive one dropping out, bounded by how many
 *      relationships a business that size can genuinely maintain.
 *   2. It keeps the balance deliberate. Local SMEs, specialists and large
 *      contractors do different jobs on a framework, and a framework that
 *      drifted to all-large or all-small has quietly lost something.
 *   3. It enforces the call-off rule, including rotation. Fair distribution is
 *      the single most common framework governance failure and the easiest to
 *      measure.
 */

// --- Company sizing ------------------------------------------------------------

/**
 * Company sizing now lives in `lifecycle/scale.ts`, because the same bands
 * decide how much process a job needs everywhere else in the platform and two
 * copies of "how big is this business" would eventually disagree.
 */
export type CompanySize = OrganisationScale;
export type CompanyBand = OrganisationBand & { size: OrganisationScale };

export const COMPANY_BANDS: CompanyBand[] = ORGANISATION_BANDS.map((band) => ({ ...band, size: band.scale }));

export function bandFor(annualTurnoverMinor: number): CompanyBand {
  const scale = organisationScale(annualTurnoverMinor);
  return COMPANY_BANDS.find((b) => b.size === scale)!;
}

/**
 * What a business actually buys, by the kind of work it does.
 *
 * A fit-out contractor and a civils contractor both build things and share
 * almost no supply chain. Sizing a framework without knowing which is which
 * produces a number that is wrong for everybody.
 */
export type ProjectType =
  | 'HRB_RESIDENTIAL'
  | 'RESIDENTIAL'
  | 'COMMERCIAL_NEW_BUILD'
  | 'FIT_OUT'
  | 'REFURBISHMENT'
  | 'CIVILS_INFRASTRUCTURE'
  | 'INDUSTRIAL'
  | 'REMEDIATION'
  | 'MAINTENANCE';

/** The trade groups each kind of project draws on. */
const PROJECT_TRADE_GROUPS: Record<ProjectType, TradeGroup[]> = {
  HRB_RESIDENTIAL: ['ENABLING', 'SUBSTRUCTURE', 'STRUCTURE', 'ENVELOPE', 'MEP', 'FIT_OUT', 'FIRE_AND_COMPLIANCE', 'EXTERNAL_WORKS', 'PLANT_AND_SITE', 'PROFESSIONAL'],
  RESIDENTIAL: ['SUBSTRUCTURE', 'STRUCTURE', 'ENVELOPE', 'MEP', 'FIT_OUT', 'EXTERNAL_WORKS', 'PLANT_AND_SITE'],
  COMMERCIAL_NEW_BUILD: ['ENABLING', 'SUBSTRUCTURE', 'STRUCTURE', 'ENVELOPE', 'MEP', 'FIT_OUT', 'FIRE_AND_COMPLIANCE', 'PLANT_AND_SITE'],
  FIT_OUT: ['FIT_OUT', 'MEP', 'FIRE_AND_COMPLIANCE', 'PLANT_AND_SITE'],
  REFURBISHMENT: ['ENABLING', 'STRUCTURE', 'ENVELOPE', 'MEP', 'FIT_OUT', 'FIRE_AND_COMPLIANCE', 'PLANT_AND_SITE'],
  CIVILS_INFRASTRUCTURE: ['ENABLING', 'SUBSTRUCTURE', 'STRUCTURE', 'EXTERNAL_WORKS', 'PLANT_AND_SITE', 'PROFESSIONAL'],
  INDUSTRIAL: ['SUBSTRUCTURE', 'STRUCTURE', 'ENVELOPE', 'MEP', 'EXTERNAL_WORKS', 'PLANT_AND_SITE'],
  REMEDIATION: ['ENABLING', 'ENVELOPE', 'FIRE_AND_COMPLIANCE', 'PLANT_AND_SITE', 'PROFESSIONAL'],
  MAINTENANCE: ['MEP', 'FIT_OUT', 'PLANT_AND_SITE'],
};

// --- Sizing --------------------------------------------------------------------

/**
 * Firms per trade.
 *
 * Three is the number of quotes almost every business asks for, so three is the
 * floor. A framework at exactly three has no slack: one firm declines, one is
 * already committed, and the enquiry is uncompetitive. Four is the working
 * minimum. Accredited trades carry five, because the pool is smaller and losing
 * one hurts more.
 */
export const COMPETITION_POLICY = {
  quotesRequired: 3,
  resilienceSpare: 1,
  accreditedSpare: 2,
  /**
   * How many of your concurrent sites one subcontractor can realistically hold
   * a package on. Beyond this they are the constraint, not the framework.
   */
  sitesPerSupplier: 3,
} as const;

export type FrameworkRecommendation = {
  band: CompanyBand;
  projectTypes: ProjectType[];
  /** Trades this business actually buys, given what it builds. */
  tradesInScope: number;
  /** Sites running at once, which drives how many firms each trade needs. */
  concurrentProjects: number;
  /** Firms needed per trade, before the relationship ceiling. */
  perTrade: Array<{ code: string; label: string; group: TradeGroup; target: number; accredited: boolean }>;
  /** What the trades add up to. */
  idealSize: number;
  /** What this business can genuinely maintain. */
  relationshipCapacity: number;
  /** The number to actually aim at. */
  recommendedSize: number;
  /** How the framework should be composed, not just how big. */
  composition: { localSme: number; specialist: number; large: number };
  rationale: string;
};

/**
 * Recommend a framework size and shape.
 *
 * The output is a range in the fifties to the low hundreds for most contractors
 * because that is what the arithmetic gives, not because it is a nice number.
 * A fit-out business doing £8m needs far fewer than a Tier 1 doing higher-risk
 * residential, and the difference is the trades they buy.
 */
export function recommendFramework(input: {
  annualTurnoverMinor: number;
  projectTypes: ProjectType[];
  /** Trades bought in addition to the ones the project types imply. */
  additionalTrades?: string[];
  /** Trades never bought — self-delivered, or simply not done. */
  excludedTrades?: string[];
  /** Sites running at once. Defaults to what is typical for the turnover band. */
  concurrentProjects?: number;
}): FrameworkRecommendation {
  if (input.projectTypes.length === 0) {
    throw new DomainError('PROJECT_TYPES_REQUIRED', 'Framework size depends on what the business builds');
  }
  if (input.concurrentProjects !== undefined && input.concurrentProjects < 1) {
    throw new DomainError('CONCURRENT_PROJECTS_INVALID', 'A business running no projects buys nothing');
  }

  const band = bandFor(input.annualTurnoverMinor);
  const concurrentProjects = input.concurrentProjects ?? band.typicalConcurrentProjects;
  const groups = new Set(input.projectTypes.flatMap((type) => PROJECT_TRADE_GROUPS[type] ?? []));
  const excluded = new Set(input.excludedTrades ?? []);
  const additional = new Set(input.additionalTrades ?? []);

  const inScope = TRADES.filter(
    (trade) => !excluded.has(trade.code) && (groups.has(trade.group) || additional.has(trade.code)),
  );

  // Two independent demands, and the trade needs whichever is larger. A firm
  // running two sites needs four roofers for competition, not because it has
  // much roofing on. A firm running twenty needs seven because four firms
  // physically cannot cover twenty sites, however competitive the enquiry was.
  const concurrencyDemand = Math.ceil(concurrentProjects / COMPETITION_POLICY.sitesPerSupplier);

  const perTrade = inScope.map((trade) => {
    const competitive =
      COMPETITION_POLICY.quotesRequired +
      (trade.accreditationRequired ? COMPETITION_POLICY.accreditedSpare : COMPETITION_POLICY.resilienceSpare);
    return {
      code: trade.code,
      label: trade.label,
      group: trade.group,
      accredited: Boolean(trade.accreditationRequired),
      target: Math.max(competitive, concurrencyDemand),
    };
  });

  const idealSize = perTrade.reduce((sum, t) => sum + t.target, 0);
  // Firms carry more than one trade, so the headcount is well below the sum of
  // the per-trade targets. Two and a half trades each is what a real register
  // looks like once it is populated.
  const withOverlap = Math.ceil(idealSize / 2.5);
  const recommendedSize = Math.min(withOverlap, band.relationshipCapacity);

  // A deliberate mix. Local SMEs are responsive and carry the social value;
  // specialists hold the accreditations; large contractors carry the packages
  // an SME cannot. A framework that drifted to one of these has lost something.
  const specialistShare = perTrade.filter((t) => t.accredited).length / Math.max(1, perTrade.length);
  const specialist = Math.round(recommendedSize * Math.min(0.4, specialistShare));
  const large = Math.round(recommendedSize * (band.size === 'MICRO' || band.size === 'SMALL' ? 0.1 : 0.2));
  const localSme = recommendedSize - specialist - large;

  const capped = withOverlap > band.relationshipCapacity;

  return {
    band,
    projectTypes: input.projectTypes,
    tradesInScope: inScope.length,
    concurrentProjects,
    perTrade,
    idealSize,
    relationshipCapacity: band.relationshipCapacity,
    recommendedSize,
    composition: { localSme, specialist, large },
    rationale: capped
      ? `${inScope.length} trades across ${concurrentProjects} concurrent sites would ideally carry ${withOverlap} firms, capped at ${band.relationshipCapacity} — the most a ${band.label} business can genuinely maintain. Prioritise the accredited trades.`
      : `${inScope.length} trades in scope, ${COMPETITION_POLICY.quotesRequired} quotes required plus cover, and ${concurrentProjects} concurrent sites at no more than ${COMPETITION_POLICY.sitesPerSupplier} sites per firm — allowing for firms carrying more than one trade.`,
  };
}

// --- The framework itself --------------------------------------------------------

export type CallOffMethod =
  /** Cheapest to run, and the one that quietly kills competition if unpoliced. */
  | 'DIRECT_AWARD'
  /** Every firm in the lot is invited. */
  | 'MINI_COMPETITION'
  /** Next in turn, so distribution is even by construction. */
  | 'ROTATION';

export type FrameworkLot = {
  reference: string;
  trade: string;
  /** Largest package expected to be called off from this lot. */
  maxPackageValueMinor: number;
  /** Below this, a direct award is permitted; above it, competition. */
  directAwardCeilingMinor: number;
};

export type SupplierTier = 'LOCAL_SME' | 'SPECIALIST' | 'LARGE';

function frameworkProject(ctx: EngineContext): string {
  return `${ctx.tenantId}-governance`;
}

export function createFramework(
  ctx: EngineContext,
  input: {
    name: string;
    startsOn: string;
    endsOn: string;
    /** Extensions available, in months. Recorded because everyone forgets them. */
    extensionMonths?: number;
    lots: FrameworkLot[];
    callOffMethod: CallOffMethod;
    paymentTerms: string;
    retentionPercent?: number;
    /** Targets the framework is judged against, not aspirations. */
    targets?: { localSmePercent?: number; maxSharePerSupplierPercent?: number };
  },
): { frameworkId: string; reference: string; lots: number } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'C');

  if (input.lots.length === 0) {
    throw new DomainError('FRAMEWORK_EMPTY', 'A framework with no lots buys nothing');
  }
  if (input.endsOn <= input.startsOn) {
    throw new DomainError('FRAMEWORK_TERM_INVALID', 'A framework must end after it starts');
  }

  const seen = new Set<string>();
  for (const lot of input.lots) {
    if (!tradeByCode(lot.trade)) throw new DomainError('TRADE_UNKNOWN', `${lot.trade} is not a trade in the catalogue`);
    if (seen.has(lot.reference)) throw new DomainError('LOT_DUPLICATE', `Lot ${lot.reference} appears twice`);
    seen.add(lot.reference);
    if (lot.directAwardCeilingMinor > lot.maxPackageValueMinor) {
      throw new DomainError(
        'DIRECT_AWARD_CEILING_INVALID',
        `Lot ${lot.reference} permits direct award up to more than the lot's own maximum, which is no ceiling at all`,
      );
    }
  }

  const frameworkId = ulid();
  const sequence = ctx.ledger.list(frameworkProject(ctx), 'Framework').length + 1;
  const reference = `FW-${String(sequence).padStart(3, '0')}`;

  write(ctx, {
    projectId: frameworkProject(ctx),
    eventType: 'FRAMEWORK_CREATED',
    entity: { refType: 'Framework', refId: frameworkId },
    nextState: {
      id: frameworkId,
      tenantId: ctx.tenantId,
      reference,
      name: input.name,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      extensionMonths: input.extensionMonths ?? 0,
      lots: input.lots,
      callOffMethod: input.callOffMethod,
      paymentTerms: input.paymentTerms,
      retentionPercent: input.retentionPercent ?? 0,
      targets: input.targets ?? {},
      members: [],
      status: 'ACTIVE',
      createdBy: ctx.auth.actorId,
      createdAt: new Date().toISOString(),
    },
  });

  return { frameworkId, reference, lots: input.lots.length };
}

function requireFramework(ctx: EngineContext, frameworkId: string) {
  const record = ctx.ledger.get({ refType: 'Framework', refId: frameworkId });
  if (!record) throw new DomainError('FRAMEWORK_NOT_FOUND', `No framework ${frameworkId}`, 404);
  return record;
}

type Member = { supplierId: string; legalName: string; lot: string; tier: SupplierTier; admittedAt: string; awards: number; awardedValueMinor: number };

/**
 * Admit a supplier to a lot.
 *
 * Prequalification is the gate, and it is the same gate the enquiry uses —
 * there is no second, weaker route onto a framework. A framework place is worth
 * more than a single enquiry, so admitting somebody who could not have been
 * invited to one package would be the larger mistake.
 */
export function admitToFramework(
  ctx: EngineContext,
  frameworkId: string,
  input: { supplierId: string; lot: string; tier: SupplierTier },
): { members: number; lot: string } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'A');

  const framework = requireFramework(ctx, frameworkId);
  const lots = framework.state.lots as FrameworkLot[];
  const lot = lots.find((l) => l.reference === input.lot);
  if (!lot) throw new DomainError('LOT_NOT_FOUND', `Framework ${String(framework.state.reference)} has no lot ${input.lot}`);

  const supplier = ctx.ledger.get({ refType: 'Supplier', refId: input.supplierId });
  if (!supplier || supplier.tenantId !== ctx.tenantId) {
    throw new DomainError('SUPPLIER_NOT_FOUND', 'That supplier is not on the supply chain register', 404);
  }

  const problem = eligibilityProblem(supplier.state, {
    trade: lot.trade,
    packageValueMinor: lot.maxPackageValueMinor,
  });
  if (problem) {
    throw new DomainError(
      'SUPPLIER_NOT_ELIGIBLE_FOR_LOT',
      `${String(supplier.state.legalName)} cannot be admitted to ${input.lot}: ${problem}`,
    );
  }

  const members = (framework.state.members as Member[]) ?? [];
  if (members.some((m) => m.supplierId === input.supplierId && m.lot === input.lot)) {
    throw new DomainError('ALREADY_A_MEMBER', `${String(supplier.state.legalName)} is already on lot ${input.lot}`);
  }

  const next: Member[] = [
    ...members,
    {
      supplierId: input.supplierId,
      legalName: String(supplier.state.legalName),
      lot: input.lot,
      tier: input.tier,
      admittedAt: new Date().toISOString(),
      awards: 0,
      awardedValueMinor: 0,
    },
  ];

  write(ctx, {
    projectId: frameworkProject(ctx),
    eventType: 'FRAMEWORK_SUPPLIER_ADMITTED',
    entity: { refType: 'Framework', refId: frameworkId },
    nextState: { ...framework.state, members: next },
  });

  return { members: next.length, lot: input.lot };
}

// --- Call-off ---------------------------------------------------------------------

export type CallOffResult = {
  lot: string;
  method: CallOffMethod;
  /** Who should be approached, in the order the rule produced. */
  invited: Array<{ supplierId: string; legalName: string; tier: SupplierTier; awards: number }>;
  /** Members excluded from this call-off and why. */
  excluded: Array<{ legalName: string; reason: string }>;
  competitive: boolean;
  note: string;
};

/**
 * Work out who a package goes to under the framework's own rule.
 *
 * This returns the selection rather than issuing the enquiry: the RFQ path
 * already exists and already checks eligibility, and having two ways to issue
 * an enquiry is how one of them ends up weaker than the other.
 */
export function callOff(
  ctx: EngineContext,
  frameworkId: string,
  input: { lot: string; packageValueMinor: number; today?: string },
): CallOffResult {
  authorise(ctx, 'PROCUREMENT_AWARD', 'R');

  const framework = requireFramework(ctx, frameworkId);
  const today = input.today ?? new Date().toISOString().slice(0, 10);

  if (String(framework.state.endsOn) < today) {
    throw new DomainError(
      'FRAMEWORK_EXPIRED',
      `Framework ${String(framework.state.reference)} ended on ${String(framework.state.endsOn)} and cannot be called off`,
    );
  }

  const lots = framework.state.lots as FrameworkLot[];
  const lot = lots.find((l) => l.reference === input.lot);
  if (!lot) throw new DomainError('LOT_NOT_FOUND', `No lot ${input.lot} on this framework`);
  if (input.packageValueMinor > lot.maxPackageValueMinor) {
    throw new DomainError(
      'PACKAGE_EXCEEDS_LOT',
      `A package of ${input.packageValueMinor} exceeds what lot ${input.lot} was set up to carry`,
    );
  }

  const members = ((framework.state.members as Member[]) ?? []).filter((m) => m.lot === input.lot);
  const excluded: CallOffResult['excluded'] = [];
  const available = members.filter((member) => {
    const supplier = ctx.ledger.get({ refType: 'Supplier', refId: member.supplierId });
    // Membership is not a permanent pass. A firm suspended last week, or whose
    // prequalification lapsed, drops out of the call-off automatically.
    const problem = supplier
      ? eligibilityProblem(supplier.state, { trade: lot.trade, packageValueMinor: input.packageValueMinor, today })
      : 'No longer on the register';
    if (problem) excluded.push({ legalName: member.legalName, reason: problem });
    return !problem;
  });

  const declaredMethod = framework.state.callOffMethod as CallOffMethod;
  // A direct award above the lot's own ceiling is not a direct award, it is a
  // competition somebody skipped. The framework's ceiling wins over its method.
  const method: CallOffMethod =
    declaredMethod === 'DIRECT_AWARD' && input.packageValueMinor > lot.directAwardCeilingMinor
      ? 'MINI_COMPETITION'
      : declaredMethod;

  let invited = available;
  let note = '';

  if (method === 'ROTATION') {
    // Fewest awards first, then least value, then longest-standing. Rotation
    // exists so the same firm does not quietly take everything, which is the
    // most common framework governance failure and the easiest to measure.
    invited = [...available]
      .sort((a, b) => a.awards - b.awards || a.awardedValueMinor - b.awardedValueMinor || a.admittedAt.localeCompare(b.admittedAt))
      .slice(0, COMPETITION_POLICY.quotesRequired);
    note = 'Rotation: next in turn by awards then value.';
  } else if (method === 'DIRECT_AWARD') {
    invited = [...available].sort((a, b) => a.awards - b.awards).slice(0, 1);
    note = `Direct award permitted below ${lot.directAwardCeilingMinor} on this lot.`;
  } else {
    note = 'Mini-competition: every currently eligible member of the lot.';
  }

  const competitive = method === 'DIRECT_AWARD' || invited.length >= COMPETITION_POLICY.quotesRequired;

  return {
    lot: input.lot,
    method,
    invited: invited.map((m) => ({ supplierId: m.supplierId, legalName: m.legalName, tier: m.tier, awards: m.awards })),
    excluded,
    competitive,
    note: competitive
      ? note
      : `${note} Only ${invited.length} eligible member(s) — below the ${COMPETITION_POLICY.quotesRequired} required for a competitive enquiry.`,
  };
}

/** Record that a package was awarded, so rotation and share are real. */
export function recordFrameworkAward(
  ctx: EngineContext,
  frameworkId: string,
  input: { supplierId: string; lot: string; valueMinor: number; packageReference: string; evidenceHash: string },
): { awards: number; sharePercent: number } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'A');

  const framework = requireFramework(ctx, frameworkId);
  const members = (framework.state.members as Member[]) ?? [];
  const member = members.find((m) => m.supplierId === input.supplierId && m.lot === input.lot);
  if (!member) throw new DomainError('NOT_A_MEMBER', 'That supplier is not on this lot of the framework');

  const evidence = registerEvidence(ctx, {
    type: 'FRAMEWORK_AWARD',
    hash: input.evidenceHash,
    description: `${input.packageReference} awarded to ${member.legalName} under ${String(framework.state.reference)}`,
  });

  const next = members.map((m) =>
    m === member ? { ...m, awards: m.awards + 1, awardedValueMinor: m.awardedValueMinor + input.valueMinor } : m,
  );

  write(ctx, {
    projectId: frameworkProject(ctx),
    eventType: 'FRAMEWORK_AWARD_RECORDED',
    entity: { refType: 'Framework', refId: frameworkId },
    evidenceRefs: [evidence],
    nextState: { ...framework.state, members: next },
  });

  const total = next.reduce((sum, m) => sum + m.awardedValueMinor, 0);
  const updated = next.find((m) => m.supplierId === input.supplierId && m.lot === input.lot)!;
  return {
    awards: updated.awards,
    sharePercent: total === 0 ? 0 : Math.round((updated.awardedValueMinor / total) * 10000) / 100,
  };
}

// --- Position ---------------------------------------------------------------------

export type FrameworkPosition = {
  reference: string;
  name: string;
  status: string;
  expiresOn: string;
  daysRemaining: number;
  members: number;
  byTier: Record<SupplierTier, number>;
  localSmePercent: number;
  /** Lots with too few eligible members to run a competitive enquiry. */
  thinLots: Array<{ lot: string; trade: string; eligible: number }>;
  /** Members taking more than the framework's own concentration limit. */
  concentration: Array<{ legalName: string; sharePercent: number }>;
  /** Members admitted and never used — a relationship in name only. */
  neverAwarded: string[];
  warnings: string[];
};

export function frameworkPosition(ctx: EngineContext, frameworkId: string, today = new Date().toISOString().slice(0, 10)): FrameworkPosition {
  authorise(ctx, 'PROCUREMENT_AWARD', 'R');

  const framework = requireFramework(ctx, frameworkId);
  const members = (framework.state.members as Member[]) ?? [];
  const lots = framework.state.lots as FrameworkLot[];
  const targets = (framework.state.targets ?? {}) as { localSmePercent?: number; maxSharePerSupplierPercent?: number };

  const byTier: Record<SupplierTier, number> = { LOCAL_SME: 0, SPECIALIST: 0, LARGE: 0 };
  for (const member of members) byTier[member.tier] += 1;

  const totalValue = members.reduce((sum, m) => sum + m.awardedValueMinor, 0);
  const localSmePercent = members.length === 0 ? 0 : Math.round((byTier.LOCAL_SME / members.length) * 10000) / 100;

  const thinLots = lots
    .map((lot) => {
      const eligible = members.filter((m) => {
        if (m.lot !== lot.reference) return false;
        const supplier = ctx.ledger.get({ refType: 'Supplier', refId: m.supplierId });
        return supplier ? !eligibilityProblem(supplier.state, { trade: lot.trade, today }) : false;
      }).length;
      return { lot: lot.reference, trade: lot.trade, eligible };
    })
    .filter((l) => l.eligible < COMPETITION_POLICY.quotesRequired);

  const shareLimit = targets.maxSharePerSupplierPercent ?? 40;
  const concentration = members
    .map((m) => ({
      legalName: m.legalName,
      sharePercent: totalValue === 0 ? 0 : Math.round((m.awardedValueMinor / totalValue) * 10000) / 100,
    }))
    .filter((m) => m.sharePercent > shareLimit);

  const endsOn = String(framework.state.endsOn);
  const daysRemaining = Math.ceil((Date.parse(endsOn) - Date.parse(today)) / 86_400_000);

  const warnings: string[] = [];
  if (daysRemaining < 0) warnings.push(`Expired on ${endsOn}`);
  else if (daysRemaining <= 180) warnings.push(`Expires in ${daysRemaining} days — re-tendering takes longer than people expect`);
  if (thinLots.length > 0) {
    warnings.push(`${thinLots.length} lot(s) cannot produce a competitive enquiry: ${thinLots.map((l) => l.lot).join(', ')}`);
  }
  for (const heavy of concentration) {
    warnings.push(`${heavy.legalName} holds ${heavy.sharePercent}% of framework value, above the ${shareLimit}% limit`);
  }
  if (targets.localSmePercent !== undefined && localSmePercent < targets.localSmePercent) {
    warnings.push(`Local SME membership is ${localSmePercent}%, below the ${targets.localSmePercent}% target`);
  }
  const neverAwarded = members.filter((m) => m.awards === 0).map((m) => m.legalName);
  if (totalValue > 0 && neverAwarded.length > members.length / 2) {
    warnings.push(`${neverAwarded.length} of ${members.length} members have never been awarded work`);
  }

  return {
    reference: String(framework.state.reference),
    name: String(framework.state.name),
    status: String(framework.state.status),
    expiresOn: endsOn,
    daysRemaining,
    members: members.length,
    byTier,
    localSmePercent,
    thinLots,
    concentration,
    neverAwarded,
    warnings,
  };
}

export function listFrameworks(ctx: EngineContext): Array<Record<string, unknown>> {
  authorise(ctx, 'PROCUREMENT_AWARD', 'R');
  return ctx.ledger
    .list(frameworkProject(ctx), 'Framework')
    .filter((r) => r.tenantId === ctx.tenantId)
    .map((r) => r.state);
}
