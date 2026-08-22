import { DomainError } from '../core/errors.ts';
import { proportionality } from '../lifecycle/scale.ts';
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

/**
 * The four tiers a firm sits in.
 *
 *   STRATEGIC   — earned, not scored. A firm you want to keep: proven delivery
 *                 on this business's own work, capacity to take more, and a
 *                 relationship worth protecting. Paperwork alone never gets
 *                 anybody here.
 *   APPROVED    — cleared to be invited to anything within their capacity.
 *   CONDITIONAL — cleared, with something to watch. Invitable, but the
 *                 condition travels with them to the award.
 *   DO_NOT_USE  — barred. Distinct from "failed the questionnaire": a bar is a
 *                 decision the business made and it does not clear itself by
 *                 re-running the assessment.
 */
export type SupplierStatus = 'REGISTERED' | 'STRATEGIC' | 'APPROVED' | 'CONDITIONAL' | 'DO_NOT_USE' | 'SUSPENDED';

export type InsurancePolicy = {
  type: 'PUBLIC_LIABILITY' | 'EMPLOYERS_LIABILITY' | 'PROFESSIONAL_INDEMNITY' | 'CONTRACT_WORKS';
  insurer: string;
  limitMinor: number;
  expiresOn: string;
};

/**
 * How deeply a firm is examined, set by the value of what they might be asked
 * to do. This is what "financial information where proportionate" means in
 * practice: demanding three years of audited accounts from a two-person
 * decorating firm for a fifteen-thousand-pound package is not diligence, it is
 * an obstacle that pushes good small firms away and tells you nothing.
 */
export type ScrutinyLevel = 'LIGHT' | 'STANDARD' | 'ENHANCED';

export const SCRUTINY_THRESHOLDS = {
  /** Below this, identity, insurance, tax status and safety only. */
  lightCeilingMinor: 25_000_00,
  /** Above this, full financial standing and evidenced capacity. */
  enhancedFloorMinor: 250_000_00,
} as const;

/**
 * How hard to look at a supplier before buying from them.
 *
 * The absolute figures above are the default, and they are only ever right for
 * one size of business. Pass the buyer's turnover and the answer becomes
 * relative instead: a £200k package is routine for a £30m contractor and the
 * whole year for a £400k one, and the second needs the harder look however
 * modest the absolute number is.
 *
 * Demanding three years of audited accounts from a two-person firm for a £4,000
 * package is not diligence, it is an obstacle that pushes good small firms out
 * of the supply chain — which is why the small end matters as much as the large.
 */
export function scrutinyFor(packageValueMinor: number, buyerAnnualTurnoverMinor?: number): ScrutinyLevel {
  if (buyerAnnualTurnoverMinor !== undefined && buyerAnnualTurnoverMinor > 0) {
    return proportionality({ projectValueMinor: packageValueMinor, annualTurnoverMinor: buyerAnnualTurnoverMinor }).scrutiny;
  }
  if (packageValueMinor <= SCRUTINY_THRESHOLDS.lightCeilingMinor) return 'LIGHT';
  if (packageValueMinor >= SCRUTINY_THRESHOLDS.enhancedFloorMinor) return 'ENHANCED';
  return 'STANDARD';
}

/** Companies House and tax identity. */
export type IdentityRecord = {
  companyNumber?: string;
  /** As returned by Companies House: active, dissolved, liquidation. */
  companyStatus?: string;
  incorporatedOn?: string;
  registeredAddress?: string;
  sicCodes?: string[];
  vatNumber?: string;
  /** Unique Taxpayer Reference. */
  utr?: string;
  /** CIS deduction status. UNREGISTERED means 30% and a conversation. */
  cisStatus?: 'GROSS' | 'NET_20' | 'NET_30' | 'UNREGISTERED' | 'NOT_APPLICABLE';
  cisVerificationNumber?: string;
  /** Sole traders and partnerships are legitimate; they just have no number. */
  soleTrader?: boolean;
};

/** Financial standing. What is required of it depends on the scrutiny level. */
export type FinancialRecord = {
  /** Most recent first. One year is enough at STANDARD; three at ENHANCED. */
  turnoverMinorByYear?: number[];
  netAssetsMinor?: number;
  /** Whatever agency the business uses; the scale is theirs. */
  creditScore?: number;
  creditAgency?: string;
  accountsFiledUpToDate?: boolean;
  accountsMadeUpTo?: string;
  /** Declared, so a firm carrying an unaffordable book is visible. */
  currentOrderBookMinor?: number;
};

export type CompetenceCard = {
  /** CSCS, CPCS, CISRS, JIB/ECS, Gas Safe, NICEIC, IPAF, PASMA. */
  scheme: string;
  /** How many operatives hold it. */
  holders: number;
  /** Soonest expiry across those holders — the one that matters. */
  earliestExpiry?: string;
};

export type TrainingRecordSummary = {
  /** SMSTS, SSSTS, First Aid at Work, Fire Marshal, Appointed Person, Temporary Works Supervisor. */
  qualification: string;
  holders: number;
  earliestExpiry?: string;
};

export type SuppliedReference = {
  clientName: string;
  projectName: string;
  valueMinor: number;
  completedOn?: string;
  contactName?: string;
  contactEmail?: string;
  /** True only when somebody actually rang them. An unchecked reference is a claim. */
  verified: boolean;
  /** 1–5 where the referee gave one. */
  rating?: number;
};

export type CapacityRecord = {
  /** Largest single package assessed as carryable. */
  maxPackageValueMinor: number;
  /** How many packages at once before quality starts to go. */
  maxConcurrentPackages?: number;
  /** Directly employed operatives, by trade code. */
  labourByTrade?: Record<string, number>;
  /** Proportion of labour that is subcontracted on rather than employed. */
  subcontractedLabourPercent?: number;
  /** Owned or long-term hired plant that comes with them. */
  plant?: Array<{ description: string; quantity: number; ownedOrHired: 'OWNED' | 'HIRED' }>;
  /** Notice needed to mobilise, in working days. */
  mobilisationDays?: number;
};

export type DayRate = {
  /** Role or trade the rate applies to. */
  role: string;
  rateMinor: number;
  /** Rates go stale. A rate with no date is a rate from an unknown year. */
  quotedOn: string;
  basis: 'DAY' | 'HOUR' | 'WEEK';
  /** Whether the rate already includes supervision, plant, consumables. */
  inclusions?: string[];
};

export type CoverageRecord = {
  regions: string[];
  countryCodes?: string[];
  maxTravelMiles?: number;
  officeLocations?: string[];
};

/** Everything the business asks a firm for. Most of it is optional at LIGHT. */
export type PrequalificationInput = {
  identity?: IdentityRecord;
  financial?: FinancialRecord;
  /** Cover held, with expiry dates that are checked rather than stored. */
  insurances: InsurancePolicy[];
  /** CHAS, SafeContractor, SMAS, Constructionline, or a trade body scheme. */
  safetyAccreditations: string[];
  /** ISO 9001 / 14001 / 45001 and any trade-specific certification. */
  qualityAccreditations: string[];
  /** Accident frequency rate, per 100,000 hours. */
  accidentFrequencyRate?: number;
  riddorLastThreeYears: number;
  /** HSE improvement or prohibition notices. A prohibition notice is a bar. */
  enforcementNotices?: Array<{ type: 'IMPROVEMENT' | 'PROHIBITION'; issuedOn: string; resolved: boolean }>;
  /**
   * Can they produce their own risk assessments and method statements, and has
   * one been read? A firm that outsources every RAMS and cannot discuss it is
   * a firm whose method statements nobody on site will follow.
   */
  ramsCapability?: { producesInHouse: boolean; sampleReviewed: boolean; sampleAcceptable?: boolean };
  competenceCards?: CompetenceCard[];
  training?: TrainingRecordSummary[];
  references?: SuppliedReference[];
  capacity: CapacityRecord;
  dayRates?: DayRate[];
  coverage?: CoverageRecord;
  /** Right to work, modern slavery statement and equal opportunities confirmed. */
  complianceConfirmed: boolean;
  /**
   * Delivery history with this business specifically. Nobody becomes strategic
   * on paperwork; they become strategic by having done the work.
   */
  performance?: { packagesCompleted: number; onTimePercent?: number; defectsPerPackage?: number; disputes: number };
};

export type PrequalificationResult = {
  status: SupplierStatus;
  score: number;
  scrutiny: ScrutinyLevel;
  /** Anything that bars approval outright, regardless of score. */
  bars: string[];
  /** Anything that permits approval but with a condition attached. */
  conditions: string[];
  /** Information the scrutiny level required and the submission did not carry. */
  missing: string[];
  approvedTrades: string[];
  expiresOn: string;
  maxPackageValueMinor: number;
  /** Why the tier came out as it did, in words somebody can put in an email. */
  rationale: string;
};

/**
 * How long an approval lasts. Twelve months is the industry norm and, more to
 * the point, is roughly how long insurance and accounts stay current.
 */
export const PREQUALIFICATION_VALID_MONTHS = 12;

function addMonths(iso: string, months: number): string {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

/**
 * Assess a firm.
 *
 * Three separate outputs, deliberately not blended into one number.
 *
 * BARS are absolute. A firm can score well on turnover, references and
 * accreditation and still be un-appointable because its employers' liability
 * lapsed last week. That is not a deduction of a few points; it is a refusal.
 * Scoring an absolute requirement is how a prequalification system ends up
 * approving somebody it should not have.
 *
 * MISSING is what the scrutiny level asked for and the submission did not
 * carry. It is reported separately from bars because "we have not seen your
 * accounts" is a different conversation from "your insurance has expired", and
 * a system that conflates them teaches people to send everything or nothing.
 *
 * CONDITIONS permit approval and travel with the firm to the award.
 */
export function assessPrequalification(
  input: PrequalificationInput,
  trades: string[],
  options: { today?: string; packageValueMinor?: number } = {},
): PrequalificationResult {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  // Scrutiny is set by what they might be asked to do, defaulting to whatever
  // capacity they claim — a firm offering to carry £2m is examined like it.
  const scrutiny = scrutinyFor(options.packageValueMinor ?? input.capacity.maxPackageValueMinor);

  for (const trade of trades) {
    if (!TRADE_CODES.has(trade)) {
      throw new DomainError('TRADE_UNKNOWN', `${trade} is not a trade in the catalogue`);
    }
  }

  const bars: string[] = [];
  const conditions: string[] = [];
  const missing: string[] = [];

  // ── Bars: absolute, at every scrutiny level ────────────────────────────────
  for (const type of ['PUBLIC_LIABILITY', 'EMPLOYERS_LIABILITY'] as const) {
    const policy = input.insurances.find((i) => i.type === type);
    const label = type.replace(/_/g, ' ').toLowerCase();
    if (!policy) bars.push(`No ${label} cover held`);
    else if (policy.expiresOn < today) bars.push(`${label} expired on ${policy.expiresOn}`);
  }

  if (!input.complianceConfirmed) {
    bars.push('Right to work, modern slavery and equal opportunities position not confirmed');
  }

  // A dissolved or liquidating company cannot be contracted with, whatever the
  // rest of the pack says.
  const companyStatus = input.identity?.companyStatus?.toLowerCase();
  if (companyStatus && !['active', 'registered'].includes(companyStatus)) {
    bars.push(`Companies House status is "${input.identity!.companyStatus}"`);
  }

  // An unresolved prohibition notice means the regulator stopped them working.
  const prohibition = (input.enforcementNotices ?? []).find((n) => n.type === 'PROHIBITION' && !n.resolved);
  if (prohibition) bars.push(`Unresolved HSE prohibition notice issued ${prohibition.issuedOn}`);

  // Concealed and life-safety trades need third-party accreditation. This is
  // the Building Safety Act lesson written as a rule: the trades where failure
  // is found years later are the ones nobody may self-certify into.
  const needsAccreditation = trades.filter((code) => tradeByCode(code)?.accreditationRequired);
  if (needsAccreditation.length > 0 && input.safetyAccreditations.length === 0) {
    bars.push(
      `No safety accreditation held, required for ${needsAccreditation.map((c) => tradeByCode(c)?.label ?? c).join(', ')}`,
    );
  }

  // ── Missing: proportionate to the scrutiny level ───────────────────────────
  const identity = input.identity ?? {};
  if (!identity.companyNumber && !identity.soleTrader) missing.push('Companies House number');
  if (!identity.cisStatus) missing.push('CIS deduction status');
  if (identity.cisStatus === 'UNREGISTERED') {
    conditions.push('Not CIS registered — deductions at the higher rate until verified');
  }

  if (scrutiny !== 'LIGHT') {
    if (!identity.vatNumber) missing.push('VAT registration number');
    if (!identity.utr) missing.push('UTR');
    if ((input.references ?? []).length === 0) missing.push('References');
    if ((input.competenceCards ?? []).length === 0) missing.push('Competence cards');
    const turnover = input.financial?.turnoverMinorByYear ?? [];
    if (turnover.length === 0) missing.push('Annual turnover');
  }

  if (scrutiny === 'ENHANCED') {
    const turnover = input.financial?.turnoverMinorByYear ?? [];
    if (turnover.length < 3) missing.push('Three years of turnover');
    if (input.financial?.netAssetsMinor === undefined) missing.push('Net assets');
    if (input.financial?.creditScore === undefined) missing.push('Credit reference');
    if (input.financial?.accountsFiledUpToDate === undefined) missing.push('Accounts filing position');
    if (!input.ramsCapability?.sampleReviewed) missing.push('RAMS sample review');
    if ((input.training ?? []).length === 0) missing.push('Training records');
  }

  // ── Conditions: approve, but watch ─────────────────────────────────────────
  const turnover = input.financial?.turnoverMinorByYear ?? [];
  const latestTurnover = turnover[0];
  const cap = input.capacity.maxPackageValueMinor;

  // The rule of thumb every commercial manager uses: one package should not be
  // most of a firm's year. If it is, their survival depends on this job.
  if (latestTurnover && cap > latestTurnover * 0.4) {
    conditions.push(
      `Assessed package capacity is more than 40% of last year's turnover — payment terms and bonding should reflect it`,
    );
  }
  if (input.financial?.accountsFiledUpToDate === false) {
    conditions.push('Accounts are not filed up to date at Companies House');
  }
  if (input.riddorLastThreeYears > 0) {
    conditions.push(`${input.riddorLastThreeYears} RIDDOR-reportable incident(s) in three years — safety review required`);
  }
  if ((input.enforcementNotices ?? []).some((n) => n.type === 'IMPROVEMENT')) {
    conditions.push('HSE improvement notice on record — confirm the actions were closed out');
  }
  if (input.accidentFrequencyRate !== undefined && input.accidentFrequencyRate > 0.5) {
    conditions.push(`Accident frequency rate ${input.accidentFrequencyRate} is above the acceptable threshold`);
  }
  if (input.ramsCapability && input.ramsCapability.sampleReviewed && input.ramsCapability.sampleAcceptable === false) {
    conditions.push('RAMS sample was not acceptable — method statements to be reviewed before each package');
  }
  if (input.ramsCapability && !input.ramsCapability.producesInHouse) {
    conditions.push('RAMS are outsourced — confirm site supervision can discuss and vary the method');
  }
  const verified = (input.references ?? []).filter((r) => r.verified);
  if ((input.references ?? []).length > 0 && verified.length === 0) {
    conditions.push('References supplied but none verified — an unchecked reference is a claim');
  }
  for (const policy of input.insurances) {
    if (policy.expiresOn >= today && policy.expiresOn < addMonths(today, 3)) {
      conditions.push(`${policy.type.replace(/_/g, ' ').toLowerCase()} expires ${policy.expiresOn} — renewal needed`);
    }
  }
  for (const card of input.competenceCards ?? []) {
    if (card.earliestExpiry && card.earliestExpiry < today) {
      conditions.push(`${card.scheme} cards have lapsed for at least one operative`);
    }
  }
  for (const rate of input.dayRates ?? []) {
    if (rate.quotedOn < addMonths(today, -12)) {
      conditions.push(`Day rate for ${rate.role} was quoted ${rate.quotedOn} and should be re-confirmed`);
    }
  }

  // ── Score: judgement within the bars ───────────────────────────────────────
  const yearsTrading = identity.incorporatedOn
    ? Math.max(0, Math.floor((Date.parse(today) - Date.parse(identity.incorporatedOn)) / (365.25 * 86_400_000)))
    : 0;

  let score = 0;
  score += Math.min(20, yearsTrading * 2);
  score += input.financial?.accountsFiledUpToDate ? 8 : 0;
  score += Math.min(20, input.safetyAccreditations.length * 10);
  score += Math.min(12, input.qualityAccreditations.length * 4);
  score += Math.min(15, verified.length * 5);
  score += input.riddorLastThreeYears === 0 ? 15 : Math.max(0, 15 - input.riddorLastThreeYears * 5);
  score += Math.min(10, (input.competenceCards ?? []).reduce((sum, c) => sum + (c.holders > 0 ? 5 : 0), 0));
  score = Math.round(Math.min(100, score) * 100) / 100;

  // ── Tier ───────────────────────────────────────────────────────────────────
  const performance = input.performance;
  // Strategic is earned on delivery, not on paperwork. Three completed packages
  // with no dispute is the floor; anybody can assemble a good-looking pack.
  const strategic =
    bars.length === 0 &&
    missing.length === 0 &&
    conditions.length === 0 &&
    score >= 80 &&
    Boolean(performance) &&
    performance!.packagesCompleted >= 3 &&
    performance!.disputes === 0 &&
    (performance!.onTimePercent ?? 0) >= 85;

  const status: SupplierStatus = bars.length > 0
    ? 'DO_NOT_USE'
    : strategic
      ? 'STRATEGIC'
      : missing.length > 0 || conditions.length > 0
        ? 'CONDITIONAL'
        : score >= 60
          ? 'APPROVED'
          : 'CONDITIONAL';

  const rationale = bars.length > 0
    ? `Barred: ${bars.join('; ')}`
    : strategic
      ? `Strategic on ${performance!.packagesCompleted} completed packages, no disputes, score ${score}`
      : missing.length > 0
        ? `Conditional pending ${missing.join(', ')} at ${scrutiny.toLowerCase()} scrutiny`
        : conditions.length > 0
          ? `Conditional: ${conditions.length} condition(s) attached`
          : `Approved on a score of ${score} at ${scrutiny.toLowerCase()} scrutiny`;

  return {
    status,
    score,
    scrutiny,
    bars,
    conditions,
    missing,
    approvedTrades: bars.length > 0 ? [] : trades,
    expiresOn: addMonths(today, PREQUALIFICATION_VALID_MONTHS),
    maxPackageValueMinor: cap,
    rationale,
  };
}

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
    /**
     * The commercial party this firm trades as — the identifier its people
     * carry on their identities and the one a submission arrives under.
     *
     * Required, and that is the whole point. Without it the register knew a
     * firm by one identifier and every return, award, subcontract and
     * commitment named it by another, with nothing joining the two: a firm
     * could be prequalified and invited, and its bid received, evaluated and
     * awarded, without the eligibility check at the enquiry ever reaching the
     * party that actually submitted. An optional field would have left exactly
     * that hole open for whoever forgot to fill it in.
     */
    partyId: string;
  },
): { supplierId: string } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'C');

  if (!input.partyId.trim()) {
    throw new DomainError(
      'SUPPLIER_PARTY_REQUIRED',
      'A supplier must name the commercial party it trades as, or nothing joins its returns to its prequalification',
    );
  }

  // One party, one firm. Two register entries sharing a party would make a
  // return ambiguous at exactly the moment it has to be attributed.
  const clash = ctx.ledger
    .listByTenant(ctx.tenantId, 'Supplier')
    .find((record) => record.state.partyId === input.partyId);
  if (clash) {
    throw new DomainError(
      'SUPPLIER_PARTY_TAKEN',
      `Party ${input.partyId} is already registered as ${String(clash.state.legalName)}`,
    );
  }

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
      partyId: input.partyId,
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
  input: PrequalificationInput & { evidenceHash: string; packageValueMinor?: number },
): PrequalificationResult {
  authorise(ctx, 'PROCUREMENT_AWARD', 'A');

  const record = ctx.ledger.get({ refType: 'Supplier', refId: supplierId });
  if (!record) throw new DomainError('SUPPLIER_NOT_FOUND', `No supplier ${supplierId}`, 404);
  if (record.state.status === 'SUSPENDED') {
    throw new DomainError('SUPPLIER_SUSPENDED', 'A suspended supplier must be reinstated before reassessment');
  }

  const result = assessPrequalification(input, record.state.trades as string[], {
    ...(input.packageValueMinor === undefined ? {} : { packageValueMinor: input.packageValueMinor }),
  });

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
        // The whole submission is kept, not just the verdict. "What did they
        // tell us, and when" is the question asked after something goes wrong.
        submitted: {
          identity: input.identity,
          financial: input.financial,
          insurances: input.insurances,
          safetyAccreditations: input.safetyAccreditations,
          qualityAccreditations: input.qualityAccreditations,
          accidentFrequencyRate: input.accidentFrequencyRate,
          riddorLastThreeYears: input.riddorLastThreeYears,
          enforcementNotices: input.enforcementNotices,
          ramsCapability: input.ramsCapability,
          competenceCards: input.competenceCards,
          training: input.training,
          references: input.references,
          capacity: input.capacity,
          dayRates: input.dayRates,
          coverage: input.coverage,
          performance: input.performance,
        },
        assessedBy: ctx.auth.actorId,
        assessedAt: new Date().toISOString(),
      },
      // Surfaced on the supplier itself so a search can filter on them without
      // reading the whole assessment.
      dayRates: input.dayRates ?? [],
      coverage: input.coverage,
      labourByTrade: input.capacity.labourByTrade ?? {},
      plant: input.capacity.plant ?? [],
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
  if (status === 'DO_NOT_USE') return 'Do not use — barred';

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
  trades: Array<{ code: string; label: string; group: TradeGroup; eligible: number; strategic: number; registered: number }>;
  gaps: string[];
  totals: { suppliers: number; strategic: number; approved: number; conditional: number; expired: number; suspended: number; doNotUse: number };
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
      strategic: registered.filter((s) => s.status === 'STRATEGIC').length,
    };
  });

  return {
    trades,
    // A trade with fewer than three eligible firms cannot produce a competitive
    // enquiry, which is the number that matters rather than "do we have one".
    gaps: trades.filter((t) => t.eligible < 3).map((t) => t.label),
    totals: {
      suppliers: suppliers.length,
      strategic: suppliers.filter((s) => s.status === 'STRATEGIC').length,
      approved: suppliers.filter((s) => s.status === 'APPROVED').length,
      conditional: suppliers.filter((s) => s.status === 'CONDITIONAL').length,
      expired: suppliers.filter((s) => (s.prequalifiedUntil as string | undefined) && String(s.prequalifiedUntil) < today).length,
      suspended: suppliers.filter((s) => s.status === 'SUSPENDED').length,
      doNotUse: suppliers.filter((s) => s.status === 'DO_NOT_USE').length,
    },
  };
}

/**
 * The register entry for a commercial party, within one tenancy.
 *
 * The join that was missing. A firm is invited by its register identifier and
 * submits under the party identifier its people carry, and until suppliers
 * recorded a party there was nothing connecting the two — so the eligibility
 * check at the enquiry never reached the party that actually returned a bid.
 *
 * Returns undefined for a party no register entry claims, and for a firm
 * registered before the join existed. Both are legitimately unknown rather than
 * errors, and the caller decides what an unknown party means: a submission
 * refuses it, a reconciliation reports it.
 */
export function supplierForParty(
  ctx: EngineContext,
  partyId: string,
): { supplierId: string; legalName: string } | undefined {
  const record = ctx.ledger
    .listByTenant(ctx.tenantId, 'Supplier')
    .find((entry) => entry.state.partyId === partyId);
  return record ? { supplierId: record.refId, legalName: String(record.state.legalName) } : undefined;
}
