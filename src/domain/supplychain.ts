import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, registerEvidence, write, type EngineContext } from '../engines/context.ts';

/**
 * The prequalified supply chain.
 *
 * Procurement could invite anybody: `invitedSupplierIds` was an array of free
 * strings with no register behind it and nothing to check. A main contractor
 * does not work that way — you cannot send an enquiry to a firm nobody has
 * checked the insurance of, and if you do, the first time anyone finds out is
 * when something goes wrong on site.
 *
 * So this is the register, and the gate:
 *
 *   trade catalogue -> supplier -> prequalification -> approved for enquiry
 *
 * The rules that make it a gate rather than a list:
 *
 *   - An expired insurance policy fails prequalification outright, whatever the
 *     rest of the assessment says. It is not a scoring input; it is a bar.
 *   - Approval expires. A firm prequalified two years ago is not prequalified.
 *   - A supplier carries a single-package value cap, so nobody gets invited to
 *     a package larger than they were assessed to carry.
 *   - Suspension is immediate and blocks enquiry regardless of expiry date.
 */

// --- Trade catalogue ----------------------------------------------------------

export type TradeGroup =
  | 'ENABLING'
  | 'SUBSTRUCTURE'
  | 'STRUCTURE'
  | 'ENVELOPE'
  | 'MEP'
  | 'FIT_OUT'
  | 'FIRE_AND_COMPLIANCE'
  | 'EXTERNAL_WORKS'
  | 'PLANT_AND_SITE'
  | 'PROFESSIONAL';

export type TradeDefinition = {
  code: string;
  label: string;
  group: TradeGroup;
  /**
   * Trades where the work is concealed, life-safety critical, or both — the
   * ones where a failure is found years later. These demand a third-party
   * accreditation, not just insurance.
   */
  accreditationRequired?: boolean;
};

/**
 * The trades a main contractor actually buys.
 *
 * A closed list rather than free text: "Drylining", "Dry lining" and "Dry-lining"
 * as three separate entries is how a supply chain register becomes unusable for
 * the one thing it is for — finding everyone who can do a thing.
 */
export const TRADES: TradeDefinition[] = [
  // Enabling and demolition
  { code: 'DEMOLITION', label: 'Demolition', group: 'ENABLING', accreditationRequired: true },
  { code: 'ASBESTOS_REMOVAL', label: 'Asbestos removal', group: 'ENABLING', accreditationRequired: true },
  { code: 'SITE_CLEARANCE', label: 'Site clearance', group: 'ENABLING' },
  { code: 'REMEDIATION', label: 'Land remediation', group: 'ENABLING', accreditationRequired: true },
  { code: 'SITE_SETUP', label: 'Site setup and hoarding', group: 'ENABLING' },

  // Substructure
  { code: 'GROUNDWORKS', label: 'Groundworks', group: 'SUBSTRUCTURE' },
  { code: 'PILING', label: 'Piling', group: 'SUBSTRUCTURE', accreditationRequired: true },
  { code: 'EARTHWORKS', label: 'Earthworks and bulk excavation', group: 'SUBSTRUCTURE' },
  { code: 'DRAINAGE', label: 'Drainage and below-ground services', group: 'SUBSTRUCTURE' },
  { code: 'UNDERPINNING', label: 'Underpinning', group: 'SUBSTRUCTURE', accreditationRequired: true },
  { code: 'CIVIL_ENGINEERING', label: 'Civil engineering', group: 'SUBSTRUCTURE' },

  // Structure
  { code: 'CONCRETE_FRAME', label: 'Concrete frame', group: 'STRUCTURE' },
  { code: 'CONCRETE_WORKS', label: 'Concrete works and screeds', group: 'STRUCTURE' },
  { code: 'REINFORCEMENT', label: 'Reinforcement supply and fix', group: 'STRUCTURE' },
  { code: 'FORMWORK', label: 'Formwork and falsework', group: 'STRUCTURE', accreditationRequired: true },
  { code: 'STRUCTURAL_STEELWORK', label: 'Structural steelwork', group: 'STRUCTURE', accreditationRequired: true },
  { code: 'METALWORK', label: 'Architectural metalwork', group: 'STRUCTURE' },
  { code: 'PRECAST_CONCRETE', label: 'Precast concrete', group: 'STRUCTURE' },
  { code: 'MASONRY', label: 'Masonry and brickwork', group: 'STRUCTURE' },
  { code: 'TIMBER_FRAME', label: 'Timber frame', group: 'STRUCTURE' },
  { code: 'MODULAR', label: 'Modular and volumetric', group: 'STRUCTURE' },

  // Envelope
  { code: 'ROOFING', label: 'Roofing', group: 'ENVELOPE', accreditationRequired: true },
  { code: 'CLADDING', label: 'Cladding and rainscreen', group: 'ENVELOPE', accreditationRequired: true },
  { code: 'CURTAIN_WALLING', label: 'Curtain walling', group: 'ENVELOPE', accreditationRequired: true },
  { code: 'GLAZING', label: 'Glazing and windows', group: 'ENVELOPE' },
  { code: 'WATERPROOFING', label: 'Waterproofing and tanking', group: 'ENVELOPE', accreditationRequired: true },
  { code: 'EXTERNAL_INSULATION', label: 'External wall insulation', group: 'ENVELOPE', accreditationRequired: true },

  // Mechanical, electrical and public health
  { code: 'MEP', label: 'M&E — combined mechanical and electrical', group: 'MEP', accreditationRequired: true },
  { code: 'MECHANICAL', label: 'Mechanical services', group: 'MEP', accreditationRequired: true },
  { code: 'ELECTRICAL', label: 'Electrical services', group: 'MEP', accreditationRequired: true },
  { code: 'PLUMBING', label: 'Plumbing and public health', group: 'MEP', accreditationRequired: true },
  { code: 'HVAC', label: 'Heating, ventilation and air conditioning', group: 'MEP', accreditationRequired: true },
  { code: 'BMS_CONTROLS', label: 'BMS and controls', group: 'MEP' },
  { code: 'SPRINKLERS', label: 'Sprinklers and wet fire suppression', group: 'MEP', accreditationRequired: true },
  { code: 'FIRE_ALARM', label: 'Fire alarm and detection', group: 'MEP', accreditationRequired: true },
  { code: 'LIFTS', label: 'Lifts and escalators', group: 'MEP', accreditationRequired: true },
  { code: 'DATA_COMMS', label: 'Data, comms and security systems', group: 'MEP' },
  { code: 'RENEWABLES', label: 'Renewables and low-carbon plant', group: 'MEP', accreditationRequired: true },

  // Fit-out and finishes
  { code: 'DRYLINING', label: 'Drylining and partitions', group: 'FIT_OUT' },
  { code: 'PLASTERING', label: 'Plastering and render', group: 'FIT_OUT' },
  { code: 'SUSPENDED_CEILINGS', label: 'Suspended ceilings', group: 'FIT_OUT' },
  { code: 'CARPENTRY', label: 'Carpentry and joinery', group: 'FIT_OUT' },
  { code: 'DOORS_IRONMONGERY', label: 'Doors and ironmongery', group: 'FIT_OUT' },
  { code: 'DECORATING', label: 'Painting and decorating', group: 'FIT_OUT' },
  { code: 'FLOORING', label: 'Flooring', group: 'FIT_OUT' },
  { code: 'TILING', label: 'Wall and floor tiling', group: 'FIT_OUT' },
  { code: 'KITCHENS', label: 'Kitchens and fitted furniture', group: 'FIT_OUT' },
  { code: 'SPECIALIST_JOINERY', label: 'Specialist joinery', group: 'FIT_OUT' },
  { code: 'SIGNAGE', label: 'Signage and wayfinding', group: 'FIT_OUT' },

  // Fire and compliance
  { code: 'FIRE_STOPPING', label: 'Fire-stopping', group: 'FIRE_AND_COMPLIANCE', accreditationRequired: true },
  { code: 'PASSIVE_FIRE_PROTECTION', label: 'Passive fire protection', group: 'FIRE_AND_COMPLIANCE', accreditationRequired: true },
  { code: 'INTUMESCENT_COATING', label: 'Intumescent coating', group: 'FIRE_AND_COMPLIANCE', accreditationRequired: true },
  { code: 'INSULATION', label: 'Thermal and acoustic insulation', group: 'FIRE_AND_COMPLIANCE' },
  { code: 'ACOUSTICS', label: 'Acoustic works and testing', group: 'FIRE_AND_COMPLIANCE' },

  // External works
  { code: 'LANDSCAPING', label: 'Hard and soft landscaping', group: 'EXTERNAL_WORKS' },
  { code: 'PAVING', label: 'Paving and kerbing', group: 'EXTERNAL_WORKS' },
  { code: 'SURFACING', label: 'Road surfacing', group: 'EXTERNAL_WORKS' },
  { code: 'FENCING', label: 'Fencing and gates', group: 'EXTERNAL_WORKS' },
  { code: 'STREET_LIGHTING', label: 'Street lighting and external power', group: 'EXTERNAL_WORKS' },
  { code: 'UTILITIES', label: 'Statutory utilities connections', group: 'EXTERNAL_WORKS' },

  // Plant, temporary works and site services
  { code: 'SCAFFOLDING', label: 'Scaffolding', group: 'PLANT_AND_SITE', accreditationRequired: true },
  { code: 'TEMPORARY_WORKS_SUPPLY', label: 'Temporary works supply', group: 'PLANT_AND_SITE', accreditationRequired: true },
  { code: 'PLANT_HIRE', label: 'Plant hire', group: 'PLANT_AND_SITE' },
  { code: 'CRANE_HIRE', label: 'Crane hire and lifting', group: 'PLANT_AND_SITE', accreditationRequired: true },
  { code: 'ACCESS_EQUIPMENT', label: 'Powered access', group: 'PLANT_AND_SITE' },
  { code: 'WASTE_MANAGEMENT', label: 'Waste management', group: 'PLANT_AND_SITE', accreditationRequired: true },
  { code: 'WELFARE', label: 'Welfare and site accommodation', group: 'PLANT_AND_SITE' },
  { code: 'LOGISTICS', label: 'Site logistics', group: 'PLANT_AND_SITE' },
  { code: 'TRAFFIC_MANAGEMENT', label: 'Traffic management', group: 'PLANT_AND_SITE', accreditationRequired: true },
  { code: 'SECURITY', label: 'Site security', group: 'PLANT_AND_SITE' },
  { code: 'CLEANING', label: 'Builders clean', group: 'PLANT_AND_SITE' },
  { code: 'MATERIALS_SUPPLY', label: 'Materials supply', group: 'PLANT_AND_SITE' },

  // Professional and freelance
  { code: 'QUANTITY_SURVEYOR', label: 'Quantity surveyor (freelance or practice)', group: 'PROFESSIONAL' },
  { code: 'SITE_MANAGER', label: 'Site manager (freelance)', group: 'PROFESSIONAL' },
  { code: 'PROJECT_MANAGER', label: 'Project manager (freelance)', group: 'PROFESSIONAL' },
  { code: 'PLANNER', label: 'Planner (freelance)', group: 'PROFESSIONAL' },
  { code: 'SITE_ENGINEER', label: 'Site engineer (freelance)', group: 'PROFESSIONAL' },
  { code: 'HS_ADVISOR', label: 'Health and safety advisor', group: 'PROFESSIONAL', accreditationRequired: true },
  { code: 'CDM_PRINCIPAL_DESIGNER', label: 'CDM principal designer', group: 'PROFESSIONAL', accreditationRequired: true },
  { code: 'ARCHITECT', label: 'Architect', group: 'PROFESSIONAL', accreditationRequired: true },
  { code: 'STRUCTURAL_ENGINEER', label: 'Structural engineer', group: 'PROFESSIONAL', accreditationRequired: true },
  { code: 'CIVIL_ENGINEER', label: 'Civil engineer', group: 'PROFESSIONAL', accreditationRequired: true },
  { code: 'MEP_CONSULTANT', label: 'M&E consultant', group: 'PROFESSIONAL', accreditationRequired: true },
  { code: 'TEMPORARY_WORKS_DESIGNER', label: 'Temporary works designer', group: 'PROFESSIONAL', accreditationRequired: true },
  { code: 'FIRE_ENGINEER', label: 'Fire engineer', group: 'PROFESSIONAL', accreditationRequired: true },
  { code: 'BUILDING_CONTROL', label: 'Building control approved inspector', group: 'PROFESSIONAL', accreditationRequired: true },
  { code: 'BIM_COORDINATOR', label: 'BIM coordinator', group: 'PROFESSIONAL' },
  { code: 'SURVEYOR', label: 'Setting-out and measured survey', group: 'PROFESSIONAL' },
  { code: 'TESTING_INSPECTION', label: 'Testing and inspection', group: 'PROFESSIONAL', accreditationRequired: true },
  { code: 'ECOLOGIST', label: 'Ecologist and environmental consultant', group: 'PROFESSIONAL' },
  { code: 'GEOTECHNICAL', label: 'Geotechnical and ground investigation', group: 'PROFESSIONAL', accreditationRequired: true },
];

export const TRADE_CODES = new Set(TRADES.map((t) => t.code));

export function tradeByCode(code: string): TradeDefinition | undefined {
  return TRADES.find((t) => t.code === code);
}

// --- Prequalification model ---------------------------------------------------

export type SupplierStatus = 'REGISTERED' | 'APPROVED' | 'CONDITIONAL' | 'REJECTED' | 'SUSPENDED';

export type InsurancePolicy = {
  type: 'PUBLIC_LIABILITY' | 'EMPLOYERS_LIABILITY' | 'PROFESSIONAL_INDEMNITY' | 'CONTRACT_WORKS';
  insurer: string;
  limitMinor: number;
  expiresOn: string;
};

/**
 * How long an approval lasts. Twelve months is the industry norm and, more to
 * the point, is roughly how long insurance and accounts stay current.
 */
export const PREQUALIFICATION_VALID_MONTHS = 12;

export type PrequalificationInput = {
  /** Financial standing. */
  annualTurnoverMinor: number;
  yearsTrading: number;
  accountsFiledUpToDate: boolean;
  /** Cover held, with expiry dates that are checked rather than stored. */
  insurances: InsurancePolicy[];
  /** CHAS, SafeContractor, SMAS, Constructionline, or a trade body scheme. */
  safetyAccreditations: string[];
  /** ISO 9001 / 14001 / 45001 and any trade-specific certification. */
  qualityAccreditations: string[];
  /** Accident frequency rate, per 100,000 hours. */
  accidentFrequencyRate?: number;
  riddorLastThreeYears: number;
  /** Contactable references for comparable work. */
  references: number;
  /** The largest single package they were assessed as able to carry. */
  maxPackageValueMinor: number;
  /** Right-to-work, CIS registration and modern slavery position confirmed. */
  complianceConfirmed: boolean;
};

export type PrequalificationResult = {
  status: SupplierStatus;
  score: number;
  /** Anything that bars approval outright, regardless of score. */
  bars: string[];
  /** Anything that permits approval but with a condition attached. */
  conditions: string[];
  approvedTrades: string[];
  expiresOn: string;
  maxPackageValueMinor: number;
};

function addMonths(iso: string, months: number): string {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

/**
 * Assess a supplier.
 *
 * Bars and score are deliberately separate. A firm can score well on turnover,
 * references and accreditation and still be un-appointable because its
 * employers' liability policy lapsed last week — that is not a deduction of a
 * few points, it is a refusal. Scoring an absolute requirement is how a
 * prequalification system ends up approving somebody it should not have.
 */
export function assessPrequalification(
  input: PrequalificationInput,
  trades: string[],
  today = new Date().toISOString().slice(0, 10),
): PrequalificationResult {
  const bars: string[] = [];
  const conditions: string[] = [];

  for (const trade of trades) {
    if (!TRADE_CODES.has(trade)) {
      throw new DomainError('TRADE_UNKNOWN', `${trade} is not a trade in the catalogue`);
    }
  }

  // --- Bars: absolute requirements ---
  const required: InsurancePolicy['type'][] = ['PUBLIC_LIABILITY', 'EMPLOYERS_LIABILITY'];
  for (const type of required) {
    const policy = input.insurances.find((i) => i.type === type);
    if (!policy) bars.push(`No ${type.replace(/_/g, ' ').toLowerCase()} cover held`);
    else if (policy.expiresOn < today) {
      bars.push(`${type.replace(/_/g, ' ').toLowerCase()} expired on ${policy.expiresOn}`);
    }
  }

  if (!input.complianceConfirmed) {
    bars.push('Right to work, CIS and modern slavery position not confirmed');
  }

  // Concealed and life-safety trades need third-party accreditation. This is
  // the Building Safety Act lesson written as a rule: the trades where failure
  // is found years later are the ones nobody may self-certify into.
  const needsAccreditation = trades.filter((code) => tradeByCode(code)?.accreditationRequired);
  if (needsAccreditation.length > 0 && input.safetyAccreditations.length === 0) {
    bars.push(
      `No safety accreditation held, which is required for ${needsAccreditation
        .map((c) => tradeByCode(c)?.label ?? c)
        .join(', ')}`,
    );
  }

  // --- Score: judgement within the bars ---
  let score = 0;
  score += Math.min(25, input.yearsTrading * 2.5);
  score += input.accountsFiledUpToDate ? 10 : 0;
  score += Math.min(20, input.safetyAccreditations.length * 10);
  score += Math.min(15, input.qualityAccreditations.length * 5);
  score += Math.min(15, input.references * 5);
  score += input.riddorLastThreeYears === 0 ? 15 : Math.max(0, 15 - input.riddorLastThreeYears * 5);

  score = Math.round(Math.min(100, score) * 100) / 100;

  // --- Conditions: approve, but watch ---
  if (input.yearsTrading < 3) conditions.push('Under three years trading — review after first package');
  if (input.riddorLastThreeYears > 0) {
    conditions.push(`${input.riddorLastThreeYears} RIDDOR-reportable incident(s) in three years — safety review required`);
  }
  if (input.references < 2) conditions.push('Fewer than two references — obtain a second before award');
  if (input.accidentFrequencyRate !== undefined && input.accidentFrequencyRate > 0.5) {
    conditions.push(`Accident frequency rate ${input.accidentFrequencyRate} is above the acceptable threshold`);
  }
  for (const policy of input.insurances) {
    if (policy.expiresOn >= today && policy.expiresOn < addMonths(today, 3)) {
      conditions.push(`${policy.type.replace(/_/g, ' ').toLowerCase()} expires ${policy.expiresOn} — renewal needed`);
    }
  }

  const status: SupplierStatus =
    bars.length > 0 ? 'REJECTED' : score >= 70 && conditions.length === 0 ? 'APPROVED' : score >= 50 ? 'CONDITIONAL' : 'REJECTED';

  return {
    status,
    score,
    bars,
    conditions,
    approvedTrades: bars.length > 0 ? [] : trades,
    expiresOn: addMonths(today, PREQUALIFICATION_VALID_MONTHS),
    maxPackageValueMinor: input.maxPackageValueMinor,
  };
}

// --- Register -----------------------------------------------------------------

function registerProject(ctx: EngineContext): string {
  // The supply chain belongs to the business, not to one project.
  return `${ctx.tenantId}-governance`;
}

export function registerSupplier(
  ctx: EngineContext,
  input: {
    legalName: string;
    tradingName?: string;
    companyNumber?: string;
    trades: string[];
    contactName: string;
    contactEmail: string;
    countryCode?: string;
    regionsCovered?: string[];
  },
): { supplierId: string } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'C');

  if (input.trades.length === 0) {
    throw new DomainError('TRADES_REQUIRED', 'A supplier must be registered against at least one trade');
  }
  for (const trade of input.trades) {
    if (!TRADE_CODES.has(trade)) throw new DomainError('TRADE_UNKNOWN', `${trade} is not a trade in the catalogue`);
  }

  const supplierId = ulid();
  write(ctx, {
    projectId: registerProject(ctx),
    eventType: 'SUPPLIER_REGISTERED',
    entity: { refType: 'Supplier', refId: supplierId },
    nextState: {
      id: supplierId,
      tenantId: ctx.tenantId,
      legalName: input.legalName,
      tradingName: input.tradingName,
      companyNumber: input.companyNumber,
      trades: input.trades,
      contactName: input.contactName,
      contactEmail: input.contactEmail,
      countryCode: input.countryCode,
      regionsCovered: input.regionsCovered ?? [],
      status: 'REGISTERED' satisfies SupplierStatus,
      registeredAt: new Date().toISOString(),
      registeredBy: ctx.auth.actorId,
    },
  });

  return { supplierId };
}

export function prequalifySupplier(
  ctx: EngineContext,
  supplierId: string,
  input: PrequalificationInput & { evidenceHash: string },
): PrequalificationResult {
  authorise(ctx, 'PROCUREMENT_AWARD', 'A');

  const record = ctx.ledger.get({ refType: 'Supplier', refId: supplierId });
  if (!record) throw new DomainError('SUPPLIER_NOT_FOUND', `No supplier ${supplierId}`, 404);
  if (record.state.status === 'SUSPENDED') {
    throw new DomainError('SUPPLIER_SUSPENDED', 'A suspended supplier must be reinstated before reassessment');
  }

  const result = assessPrequalification(input, record.state.trades as string[]);

  const evidence = registerEvidence(ctx, {
    type: 'PREQUALIFICATION_PACK',
    hash: input.evidenceHash,
    description: `Prequalification of ${String(record.state.legalName)}: ${result.status}`,
  });

  write(ctx, {
    projectId: registerProject(ctx),
    eventType: 'SUPPLIER_PREQUALIFIED',
    entity: { refType: 'Supplier', refId: supplierId },
    evidenceRefs: [evidence],
    nextState: {
      ...record.state,
      status: result.status,
      prequalification: {
        ...result,
        insurances: input.insurances,
        safetyAccreditations: input.safetyAccreditations,
        qualityAccreditations: input.qualityAccreditations,
        annualTurnoverMinor: input.annualTurnoverMinor,
        assessedBy: ctx.auth.actorId,
        assessedAt: new Date().toISOString(),
      },
      maxPackageValueMinor: result.maxPackageValueMinor,
      prequalifiedUntil: result.expiresOn,
    },
  });

  return result;
}

/** Suspend a supplier immediately — after an incident, a failure, or insolvency. */
export function suspendSupplier(
  ctx: EngineContext,
  supplierId: string,
  input: { reason: string },
): { status: SupplierStatus } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'A');

  const record = ctx.ledger.get({ refType: 'Supplier', refId: supplierId });
  if (!record) throw new DomainError('SUPPLIER_NOT_FOUND', `No supplier ${supplierId}`, 404);
  if (!input.reason?.trim()) throw new DomainError('REASON_REQUIRED', 'Suspending a supplier requires a reason');

  write(ctx, {
    projectId: registerProject(ctx),
    eventType: 'SUPPLIER_SUSPENDED',
    entity: { refType: 'Supplier', refId: supplierId },
    nextState: {
      ...record.state,
      status: 'SUSPENDED' satisfies SupplierStatus,
      suspension: { reason: input.reason.trim(), by: ctx.auth.actorId, at: new Date().toISOString() },
    },
  });

  return { status: 'SUSPENDED' };
}

// --- The gate -----------------------------------------------------------------

export type EligibilityProblem = { supplierId: string; legalName: string; reason: string };

/**
 * Why a supplier may not be invited to a package, or nothing if they may.
 *
 * Exported so the interface can grey out an ineligible firm and say why,
 * rather than letting somebody select it and meet the refusal at submit.
 */
export function eligibilityProblem(
  supplier: Record<string, unknown>,
  input: { trade?: string; packageValueMinor?: number; today?: string },
): string | undefined {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const status = String(supplier.status);

  if (status === 'SUSPENDED') return 'Suspended';
  if (status === 'REGISTERED') return 'Registered but never prequalified';
  if (status === 'REJECTED') return 'Prequalification rejected';

  const until = supplier.prequalifiedUntil as string | undefined;
  if (!until) return 'No prequalification on record';
  if (until < today) return `Prequalification expired on ${until}`;

  if (input.trade && !(supplier.trades as string[]).includes(input.trade)) {
    return `Not prequalified for ${tradeByCode(input.trade)?.label ?? input.trade}`;
  }

  const cap = Number(supplier.maxPackageValueMinor ?? 0);
  if (input.packageValueMinor && cap > 0 && input.packageValueMinor > cap) {
    return `Package exceeds assessed capacity of ${cap} minor units`;
  }

  return undefined;
}

/**
 * The gate procurement calls before an enquiry goes out.
 *
 * Refuses the whole enquiry rather than quietly dropping the ineligible firms:
 * an RFQ that silently went to four of the six people you selected produces a
 * comparison you cannot trust.
 */
export function assertEligibleForEnquiry(
  ctx: EngineContext,
  supplierIds: string[],
  input: { trade?: string; packageValueMinor?: number } = {},
): void {
  const problems: EligibilityProblem[] = [];

  for (const supplierId of supplierIds) {
    const record = ctx.ledger.get({ refType: 'Supplier', refId: supplierId });
    if (!record || record.tenantId !== ctx.tenantId) {
      problems.push({ supplierId, legalName: supplierId, reason: 'Not on the supply chain register' });
      continue;
    }
    const reason = eligibilityProblem(record.state, input);
    if (reason) problems.push({ supplierId, legalName: String(record.state.legalName), reason });
  }

  if (problems.length > 0) {
    throw new DomainError(
      'SUPPLIER_NOT_PREQUALIFIED',
      `An enquiry cannot be issued to ${problems.length} of ${supplierIds.length} selected: ${problems
        .map((p) => `${p.legalName} — ${p.reason}`)
        .join('; ')}`,
    );
  }
}

// --- Read ---------------------------------------------------------------------

/** Everyone who could be invited to a package of this trade and value. */
export function findSuppliers(
  ctx: EngineContext,
  filter: { trade?: string; packageValueMinor?: number; includeIneligible?: boolean } = {},
): Array<Record<string, unknown> & { eligible: boolean; ineligibleReason?: string }> {
  authorise(ctx, 'PROCUREMENT_AWARD', 'R');

  return ctx.ledger
    .list(registerProject(ctx), 'Supplier')
    .filter((r) => r.tenantId === ctx.tenantId)
    .map((r) => {
      const reason = eligibilityProblem(r.state, filter);
      const supplier: Record<string, unknown> & { eligible: boolean; ineligibleReason?: string } = {
        ...r.state,
        eligible: !reason,
        ...(reason ? { ineligibleReason: reason } : {}),
      };
      return supplier;
    })
    .filter((s) => (filter.trade ? ((s.trades as string[]) ?? []).includes(filter.trade) : true))
    .filter((s) => filter.includeIneligible || s.eligible);
}

/** Coverage across the trade catalogue: where the supply chain has gaps. */
export function supplyChainCoverage(ctx: EngineContext): {
  trades: Array<{ code: string; label: string; group: TradeGroup; eligible: number; registered: number }>;
  gaps: string[];
  totals: { suppliers: number; approved: number; conditional: number; expired: number; suspended: number };
} {
  authorise(ctx, 'PROCUREMENT_AWARD', 'R');

  const suppliers = ctx.ledger
    .list(registerProject(ctx), 'Supplier')
    .filter((r) => r.tenantId === ctx.tenantId)
    .map((r) => r.state);

  const today = new Date().toISOString().slice(0, 10);
  const trades = TRADES.map((trade) => {
    const registered = suppliers.filter((s) => (s.trades as string[]).includes(trade.code));
    return {
      code: trade.code,
      label: trade.label,
      group: trade.group,
      registered: registered.length,
      eligible: registered.filter((s) => !eligibilityProblem(s, { trade: trade.code, today })).length,
    };
  });

  return {
    trades,
    // A trade with fewer than three eligible firms cannot produce a competitive
    // enquiry, which is the number that matters rather than "do we have one".
    gaps: trades.filter((t) => t.eligible < 3).map((t) => t.label),
    totals: {
      suppliers: suppliers.length,
      approved: suppliers.filter((s) => s.status === 'APPROVED').length,
      conditional: suppliers.filter((s) => s.status === 'CONDITIONAL').length,
      expired: suppliers.filter((s) => (s.prequalifiedUntil as string | undefined) && String(s.prequalifiedUntil) < today).length,
      suspended: suppliers.filter((s) => s.status === 'SUSPENDED').length,
    },
  };
}
