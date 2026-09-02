import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { authorise, write, type EngineContext } from '../../engines/context.ts';
import { requireModule } from '../../identity/modules.ts';
import { openEnquiry } from '../enquiry.ts';
import { appointmentInForce, appointmentPosition, profileFor } from './appointment.ts';
import { SERVICE_FAMILIES, type ServiceFamily } from './brief.ts';
import { FAMILY_DESIGN, type ServiceInterface, type ServiceSystem } from './composer.ts';

/**
 * §7 — the procurement and supplier-control factory.
 *
 * Three things, and each one exists because of a specific way site-services
 * procurement goes wrong.
 *
 * **§7.1 Packaging is an argument, not a preference.** Whether welfare and
 * cleaning are one package or two decides how many interfaces exist, how many
 * firms can bid, who carries the risk when a cabin is late and who is standing
 * in the room when it is. The spec's rule is the sharp part: a packaging
 * recommendation *must show* why bundling reduces interfaces, or why
 * disaggregation protects competition and specialist performance. A
 * recommendation that cannot say which of those it is doing is a preference
 * with a diagram attached, and this module refuses to produce one.
 *
 * **§7.2 A price is not comparable until it is normalised.** Five returns
 * against one schedule are five different scopes: one excludes reinstatement,
 * one prices a 40-week hire against a 46-week programme, one is in euros, one
 * assumes single-shift working and one has folded standby into a rate. The six
 * steps turn them into one comparison — and the third step is the one that
 * matters most: **an exclusion is priced visibly, never hidden inside a score.**
 * A scoring model that quietly deducts points for an exclusion produces a
 * winner nobody can defend and a contract that costs more than the loser.
 *
 * **§7.3 A supplier is not a status, it is a position on a package.** The
 * corporate register in `domain/supplychain.ts` holds whether a firm may be
 * used at all — approved, conditional, barred. That is a tenant-wide standing
 * and it is not what this is. The nine control states here are the state of
 * *this firm on this package*: the same supplier can be Operational on welfare
 * and Tendering on cleaning on the same Tuesday, and a single status field
 * cannot say so.
 *
 * ---
 *
 * ## What is reused rather than rebuilt
 *
 * The tender event itself — controlled recipients, acknowledgement, addenda,
 * return completeness, late-return treatment, audit log — is `domain/enquiry.ts`
 * and is called, not copied. The supplier's competence, insurance, financial
 * standing and expiry dates are `domain/supplychain.ts` and are read, not
 * duplicated. §7's contribution is the two things neither of them does: the
 * packaging argument, and the normalisation that makes returns comparable.
 */

// --- §7.1 Package strategy ---------------------------------------------------------

/**
 * The number of credible bidders below which a package stops being competitive.
 *
 * Three is the conventional floor and the reason is arithmetic rather than
 * custom: with two returns a single withdrawal leaves a negotiation, and a
 * negotiation with the only firm that can do the work is not a price. It is
 * stated here as a domain rule with its basis rather than buried in a
 * comparison, because it is the number that decides every disaggregation
 * argument this module makes.
 */
export const COMPETITION_FLOOR = 3;

export type PackagingFactorId =
  | 'interfaceDensity'
  | 'marketCapability'
  | 'riskOwnership'
  | 'mobilisationLead'
  | 'geographicAvailability'
  | 'customerStandards'
  | 'cashProfile'
  | 'appointmentModel';

export type PackagingFactor = {
  id: PackagingFactorId;
  label: string;
  /** What the factor is actually asking, in the words it is argued in. */
  question: string;
  /** Which way this factor pushes when it is strong. */
  argues: 'BUNDLE' | 'DISAGGREGATE';
};

/**
 * The eight factors §7.1 names, and which way each one pushes.
 *
 * They do not all push the same way, which is the point: interface density and
 * mobilisation lead argue for bundling, market capability and specialist
 * performance argue for splitting, and a real recommendation is the resolution
 * of that disagreement rather than a preference dressed as one.
 */
export const PACKAGING_FACTORS: readonly PackagingFactor[] = [
  {
    id: 'interfaceDensity',
    label: 'Interface density',
    question:
      'How many interfaces sit between these families? Each one is a conversation between two firms that becomes an internal matter if one firm holds both.',
    argues: 'BUNDLE',
  },
  {
    id: 'marketCapability',
    label: 'Market capability',
    question:
      'How many firms can actually deliver the whole bundle? A bundle only one firm can price is a negotiation, not a tender.',
    argues: 'DISAGGREGATE',
  },
  {
    id: 'riskOwnership',
    label: 'Risk ownership',
    question:
      'When the compound is late because the ground was not ready, who carries it? Split packages split the answer, and the argument that follows is about whose fault it was.',
    argues: 'BUNDLE',
  },
  {
    id: 'mobilisationLead',
    label: 'Mobilisation lead',
    question:
      'Do these families have to be on site together? Families with the same lead time and the same window mobilise as one operation whether or not they are bought as one.',
    argues: 'BUNDLE',
  },
  {
    id: 'geographicAvailability',
    label: 'Geographic availability',
    question:
      'How many of those firms are within reach of this site? National capability is not availability at the gate on a Monday.',
    argues: 'DISAGGREGATE',
  },
  {
    id: 'customerStandards',
    label: 'Customer standards',
    question:
      'Does the customer mandate a standard, a framework or a named supplier for any family here? A mandated family cannot be competed inside a bundle.',
    argues: 'DISAGGREGATE',
  },
  {
    id: 'cashProfile',
    label: 'Cash profile',
    question:
      'What does this bundle commit before the first payment arrives? Under Prime the exposure is ETABLIX’s, and one large package concentrates it.',
    argues: 'DISAGGREGATE',
  },
  {
    id: 'appointmentModel',
    label: 'Appointment model',
    question:
      'Who is contracting? Under Advisory the customer lets every package and bundling saves them interfaces; under Prime the bundle is ETABLIX’s own balance sheet.',
    argues: 'BUNDLE',
  },
];

const FACTOR_BY_ID = new Map(PACKAGING_FACTORS.map((factor) => [factor.id, factor]));

/**
 * The twelve minimum fields §7.1 requires of a package.
 *
 * Five of them are **derived** from the system breakdown structure the package
 * links to, and are not asked about: the interfaces, the quantities, the
 * programme and the removal obligation are already established facts, and
 * asking a buyer to retype them is how a package ends up describing something
 * the design does not.
 *
 * The other seven have to be stated, because nothing in the platform can
 * honestly infer them. A package missing any of the twelve can be created — a
 * half-drafted package is a real thing — but it cannot be issued to tender.
 * Absent is not the same as none required.
 */
export type PackageRequirement = {
  id: string;
  label: string;
  kind: 'DERIVED' | 'STATED';
  /** The failure it prevents, not the box it fills. */
  matters: string;
};

export const PACKAGE_REQUIREMENTS: readonly PackageRequirement[] = [
  {
    id: 'sbsLinks',
    label: 'System breakdown links',
    kind: 'DERIVED',
    matters:
      'A package bought against no system is bought against somebody’s memory of the brief, and there is nothing to compare the delivery to.',
  },
  {
    id: 'interfaces',
    label: 'Interfaces',
    kind: 'DERIVED',
    matters:
      'The interfaces the linked systems carry become this supplier’s obligations. Omitted from the package, they are discovered on site and priced as a variation.',
  },
  {
    id: 'quantities',
    label: 'Quantities',
    kind: 'DERIVED',
    matters:
      'Prices returned against no stated quantity cannot be compared, and the difference is discovered at the first valuation.',
  },
  {
    id: 'programme',
    label: 'Programme',
    kind: 'DERIVED',
    matters:
      'Hire priced against the wrong duration is the single commonest normalisation error, and it is only visible if the package stated the duration.',
  },
  {
    id: 'removal',
    label: 'Removal obligation',
    kind: 'DERIVED',
    matters:
      'Removal and reinstatement omitted from the package are excluded from the price, and the cost lands at the end when there is nothing left to negotiate with.',
  },
  {
    id: 'scope',
    label: 'Scope inclusions and exclusions',
    kind: 'STATED',
    matters:
      'Inclusions alone leave every silence to be argued. What is deliberately out is as much a part of a scope as what is in.',
  },
  {
    id: 'drawings',
    label: 'Drawings and revisions',
    kind: 'STATED',
    matters:
      'A price against an unnamed revision is a price against whichever drawing the bidder happened to hold.',
  },
  {
    id: 'kpis',
    label: 'KPIs',
    kind: 'STATED',
    matters:
      'A service with no measure cannot be failed, so it cannot be enforced, so the remedy in the contract is decorative.',
  },
  {
    id: 'evidence',
    label: 'Evidence requirements',
    kind: 'STATED',
    matters:
      'What the supplier must produce, and when. Agreed after award, it becomes a request the supplier is entitled to charge for.',
  },
  {
    id: 'acceptance',
    label: 'Acceptance criteria',
    kind: 'STATED',
    matters:
      'The line between done and not done. Undefined, it is drawn by whoever is under the most pressure on the day.',
  },
  {
    id: 'pricingMethod',
    label: 'Pricing method',
    kind: 'STATED',
    matters:
      'Lump sum, remeasurable, schedule of rates or cost-plus decide what a change costs before any change happens.',
  },
  {
    id: 'changeMechanism',
    label: 'Change mechanism',
    kind: 'STATED',
    matters:
      'How a variation is instructed, valued and paid. Absent, every change becomes a negotiation from a standing start.',
  },
];

const STATED_REQUIREMENTS = PACKAGE_REQUIREMENTS.filter((entry) => entry.kind === 'STATED').map((entry) => entry.id);

export type ServicePackage = {
  id: string;
  projectId: string;
  reference: string;
  title: string;
  /** The service systems this package buys. One or many; never none. */
  systemIds: string[];
  families: ServiceFamily[];
  /** The seven stated fields, filled in as they are settled. */
  stated: Record<string, string>;
  /** Set once the package is issued to tender, and never re-set. */
  enquiryId?: string;
  tenderedAt?: string;
  createdBy: string;
  createdAt: string;
};

export type ServiceBidLine = {
  /** The item on the issued pricing schedule this line prices. */
  scheduleItemId: string;
  description: string;
  quantity: number;
  unit: string;
  rateMinor: number;
  /** A stated qualification changes what is being priced, and is reported. */
  qualification?: string;
};

export const TAX_BASIS = ['EXCLUSIVE', 'INCLUSIVE'] as const;
export type TaxBasis = (typeof TAX_BASIS)[number];

/**
 * The eleven bases §7.2 requires to be normalised before a comparison exists.
 *
 * They are declared rather than inferred because a bid that says nothing about
 * standby is not a bid with no standby — it is a bid whose standby position is
 * unknown, and the two are priced very differently.
 */
export const NORMALISATION_BASES = [
  { id: 'currency', label: 'Currency', matters: 'Two currencies are two prices with an exchange rate between them, not two comparable numbers.' },
  { id: 'taxBasis', label: 'Tax basis', matters: 'A tax-inclusive return read as exclusive is a fifth of a package cheaper than it is.' },
  { id: 'hirePeriodWeeks', label: 'Hire period', matters: 'Hire priced over 40 weeks against a 46-week programme is six weeks somebody pays for later.' },
  { id: 'escalationPercent', label: 'Escalation', matters: 'A fixed price and an indexed price are the same number on the day of award and never again.' },
  { id: 'workingHours', label: 'Working hours', matters: 'A single-shift assumption on a double-shift site is a rate that will not be honoured.' },
  { id: 'transport', label: 'Transport', matters: 'Delivery to site or to the nearest depot is a lorry and a crane between the two answers.' },
  { id: 'mobilisation', label: 'Mobilisation', matters: 'Excluded and then instructed, mobilisation is charged at the rate the supplier picks.' },
  { id: 'demobilisation', label: 'Demobilisation', matters: 'The end-of-job cost that is invisible at award and unavoidable at the end.' },
  { id: 'consumables', label: 'Consumables', matters: 'Soap, paper and cleaning materials are trivial per unit and material over a year.' },
  { id: 'standby', label: 'Standby', matters: 'Standby folded into a rate makes the rate look high and the standby free, and neither is true.' },
  { id: 'supervision', label: 'Supervision', matters: 'A price without supervision is a price for people nobody is managing.' },
  { id: 'reinstatement', label: 'Reinstatement', matters: 'The obligation that outlives the service, and the one most often left out of the price.' },
] as const;

export type NormalisationBasisId = (typeof NORMALISATION_BASES)[number]['id'];

/** What a bidder declared about each of the normalisation bases. */
export type BidBasis = {
  currency: string;
  taxBasis: TaxBasis;
  hirePeriodWeeks?: number;
  escalationPercent?: number;
  workingHours?: string;
  transport?: string;
  mobilisationIncluded?: boolean;
  demobilisationIncluded?: boolean;
  consumablesIncluded?: boolean;
  standbyIncluded?: boolean;
  supervisionIncluded?: boolean;
  reinstatementIncluded?: boolean;
};

export type ServiceBid = {
  id: string;
  projectId: string;
  packageId: string;
  supplierId: string;
  supplierName: string;
  lines: ServiceBidLine[];
  basis: BidBasis;
  /** Scope items the bidder has stated they are not pricing. */
  exclusions: string[];
  /** Technical score out of 100, from the evaluation panel. Never a price. */
  technicalScore?: number;
  receivedAt: string;
  receivedBy: string;
  /** Set by `lockReturn`. Award analysis is refused until every bid carries it. */
  lockedAt?: string;
  lockedBy?: string;
  acknowledgedBy?: string;
  superseded?: true;
};

// --- Reading the system breakdown --------------------------------------------------

function systemsOf(ctx: EngineContext): ServiceSystem[] {
  return ctx.ledger.list(ctx.projectId, 'ServiceSystem').map((record) => record.state as unknown as ServiceSystem);
}

function interfacesOf(ctx: EngineContext): ServiceInterface[] {
  return ctx.ledger
    .list(ctx.projectId, 'ServiceInterface')
    .map((record) => record.state as unknown as ServiceInterface);
}

function packagesOf(ctx: EngineContext): ServicePackage[] {
  return ctx.ledger.list(ctx.projectId, 'ServicePackage').map((record) => record.state as unknown as ServicePackage);
}

function packageOf(ctx: EngineContext, packageId: string): ServicePackage {
  const found = packagesOf(ctx).find((entry) => entry.id === packageId);
  if (!found) throw new DomainError('SERVICE_PACKAGE_NOT_FOUND', 'No such package on this project', 404);
  return found;
}

function bidsOf(ctx: EngineContext, packageId: string): ServiceBid[] {
  return ctx.ledger
    .list(ctx.projectId, 'ServiceBid')
    .map((record) => record.state as unknown as ServiceBid)
    .filter((entry) => entry.packageId === packageId && !entry.superseded);
}

/**
 * Which trades on the corporate catalogue deliver each service family.
 *
 * The supply-chain register in `domain/supplychain.ts` records firms against a
 * closed trade catalogue — the trades a main contractor actually buys — and it
 * knows nothing about ETABLIX's seven families. This is the join, and it is
 * declared rather than guessed at from labels: "who can price welfare" has to
 * be a set of trade codes somebody can argue with, not a string match that
 * silently returns nobody.
 *
 * A firm covers a family if it holds any of the family's trades. It covers a
 * *bundle* only if it covers every family in it, which is the entire
 * disaggregation argument: capability per family is not capability across a
 * bundle, and treating it as such is how a bundle ends up with one return.
 */
export const FAMILY_TRADES: Record<ServiceFamily, readonly string[]> = {
  TEMPORARY_INFRASTRUCTURE: ['SITE_SETUP', 'MODULAR', 'FENCING', 'SIGNAGE', 'TEMPORARY_WORKS_SUPPLY', 'DATA_COMMS'],
  ENABLING_CIVILS: [
    'SITE_CLEARANCE',
    'DEMOLITION',
    'GROUNDWORKS',
    'EARTHWORKS',
    'DRAINAGE',
    'SURFACING',
    'PAVING',
    'CIVIL_ENGINEERING',
    'LANDSCAPING',
  ],
  TEMPORARY_MEP: ['MEP', 'ELECTRICAL', 'MECHANICAL', 'PLUMBING', 'HVAC', 'UTILITIES', 'STREET_LIGHTING', 'RENEWABLES'],
  WELFARE_ACCOMMODATION: ['WELFARE', 'MODULAR', 'PLUMBING'],
  CLEANING_FM: ['CLEANING', 'WASTE_MANAGEMENT'],
  SECURITY_LOGISTICS: ['SECURITY', 'LOGISTICS', 'TRAFFIC_MANAGEMENT'],
  PROCUREMENT_CONTROL: ['QUANTITY_SURVEYOR', 'PROJECT_MANAGER'],
};

type RegisteredSupplier = {
  id: string;
  legalName: string;
  status: string;
  trades?: string[];
  prequalifiedUntil?: string;
};

function registeredSuppliers(ctx: EngineContext): RegisteredSupplier[] {
  return ctx.ledger.listByTenant(ctx.tenantId, 'Supplier').map((record) => record.state as unknown as RegisteredSupplier);
}

/**
 * How many firms on the corporate register could bid for a set of families.
 *
 * Read from `domain/supplychain.ts` rather than counted here: whether a firm may
 * be used at all is that register's question and this module has no business
 * having a second opinion about it. A firm barred or suspended there is not a
 * bidder here, whatever it can do.
 */
function biddersFor(ctx: EngineContext, families: readonly ServiceFamily[]): { count: number; names: string[] } {
  const able = registeredSuppliers(ctx)
    .filter((entry) => entry.status !== 'DO_NOT_USE' && entry.status !== 'SUSPENDED')
    .filter((entry) =>
      families.every((family) => FAMILY_TRADES[family].some((trade) => (entry.trades ?? []).includes(trade))),
    );
  return { count: able.length, names: able.map((entry) => entry.legalName) };
}

// --- §7.1 The packaging argument ---------------------------------------------------

export type PackagingOption = {
  id: string;
  label: string;
  families: ServiceFamily[];
  systemIds: string[];
  /** Interfaces that stop being between two firms if this bundle is let as one. */
  internalised: { name: string; between: string }[];
  /** Interfaces that remain external whatever is done. */
  externalRemaining: number;
  biddersIfBundled: number;
  /** Bidders for each family taken alone. The disaggregation comparison. */
  biddersIfSeparate: { family: ServiceFamily; count: number }[];
  leadSpreadDays: number;
  /** Which factors argued for this, and what each one actually said. */
  factors: { id: PackagingFactorId; label: string; says: string; supports: 'BUNDLE' | 'DISAGGREGATE' }[];
  /**
   * The sentence §7.1 requires. Either why bundling reduces interfaces, or why
   * disaggregation protects competition and specialist performance — never a
   * preference, and never absent.
   */
  argument: string;
  recommendation: 'BUNDLE' | 'DISAGGREGATE';
};

export type PackagingStrategy = {
  id: string;
  projectId: string;
  options: PackagingOption[];
  competitionFloor: number;
  /** The appointment in force, because it changes who the argument is for. */
  model?: string;
  modelEffect: string;
  assessedAt: string;
  assessedBy: string;
};

/**
 * Which service family each non-negotiable interface is actually *with*.
 *
 * §4's interface matrix names each family's non-negotiable interfaces but not
 * who is on the other side of them, and without that the packaging argument
 * cannot be made at all. Welfare carries an interface called "Cleaning"; the
 * cleaning family carries ones called "Occupancy" and "Room status". Those are
 * three names for two firms having the same three conversations, and they are
 * exactly the conversations that stop happening if one firm holds both.
 *
 * Declared rather than inferred from the names, because inferring it would mean
 * a string match: "Cleaning" happens to match the cleaning family and
 * "Occupancy" does not, so a match-based rule would find one of the three and
 * silently miss the other two — and a packaging argument that undercounts the
 * interfaces is an argument for the wrong answer.
 *
 * An interface not named here is external whatever is bought together: the
 * landowner's reinstatement criterion, the discharge consent, the safeguarding
 * duty. Bundling does not remove those, and claiming it does would be the exact
 * overstatement this module exists to refuse.
 */
export const INTERFACE_COUNTERPART: Record<string, ServiceFamily> = {
  // Welfare and accommodation
  Cleaning: 'CLEANING_FM',
  Transport: 'SECURITY_LOGISTICS',
  'Potable water and waste': 'TEMPORARY_MEP',
  Fire: 'TEMPORARY_MEP',
  // Cleaning, FM and living services
  Occupancy: 'WELFARE_ACCOMMODATION',
  'Room status': 'WELFARE_ACCOMMODATION',
  'Waste routes': 'SECURITY_LOGISTICS',
  'Asset data': 'TEMPORARY_INFRASTRUCTURE',
  // Temporary infrastructure and compounds
  'Ground bearing': 'ENABLING_CIVILS',
  Drainage: 'ENABLING_CIVILS',
  'Power and data': 'TEMPORARY_MEP',
  'Fire strategy': 'TEMPORARY_MEP',
  'Security perimeter': 'SECURITY_LOGISTICS',
  // Enabling civils and reinstatement
  'Buried services': 'TEMPORARY_MEP',
  'Design loads': 'TEMPORARY_INFRASTRUCTURE',
  // Temporary MEP and building services
  'Demand coincidence': 'TEMPORARY_INFRASTRUCTURE',
  'Discharge consent': 'ENABLING_CIVILS',
  'Fuel logistics': 'SECURITY_LOGISTICS',
  'Asset energisation and isolation': 'TEMPORARY_INFRASTRUCTURE',
  // Security, access, logistics and transport
  'Workforce roster': 'WELFARE_ACCOMMODATION',
  'Gate capacity': 'TEMPORARY_INFRASTRUCTURE',
  'Working hours': 'WELFARE_ACCOMMODATION',
};

/**
 * Interfaces that stop being between two firms if two systems are bought as one.
 *
 * Two ways, and both are the same thing in practice. Either the interface is
 * declared as being with the other system's family, or somebody has named the
 * other system as its counterparty on the record — a conversation between two
 * parties that becomes one party's internal problem if they are bought
 * together.
 */
function sharedInterfaces(
  a: ServiceSystem,
  b: ServiceSystem,
  all: ServiceInterface[],
): { name: string; between: string }[] {
  const forA = all.filter((entry) => entry.systemId === a.id);
  const forB = all.filter((entry) => entry.systemId === b.id);
  const shared: { name: string; between: string }[] = [];

  const consider = (entry: ServiceInterface, self: ServiceSystem, other: ServiceSystem): void => {
    if (shared.some((existing) => existing.name === entry.name)) return;
    if (INTERFACE_COUNTERPART[entry.name] === other.family) {
      shared.push({ name: entry.name, between: `${self.label} with ${other.label}` });
      return;
    }
    if (entry.counterparty && entry.counterparty.toLowerCase().includes(other.label.toLowerCase())) {
      shared.push({ name: entry.name, between: `${self.label} names ${other.label}` });
    }
  };

  for (const entry of forA) consider(entry, a, b);
  for (const entry of forB) consider(entry, b, a);
  return shared;
}

/**
 * Recommend how the composed systems should be packaged, and argue it.
 *
 * The method is a pairwise one and deliberately so. Every pair of composed
 * systems is examined for the interfaces bundling would internalise and the
 * competition bundling would cost, and each pair gets an argument in one
 * direction or the other. Producing an exhaustive set of every possible
 * grouping would be a combinatorial exercise that reads as rigour and decides
 * nothing; the pairwise answers are the ones a buyer actually argues about.
 *
 * A system with no pair — one family composed on its own — is reported as its
 * own option with the disaggregation argument, because "there is nothing to
 * bundle it with" is a real answer and silence is not.
 */
export function recommendPackaging(ctx: EngineContext): PackagingStrategy {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C');

  const systems = systemsOf(ctx);
  if (systems.length === 0) {
    throw new DomainError(
      'PACKAGING_NOTHING_COMPOSED',
      'Nothing is composed, so there is nothing to package. Packaging is an argument about interfaces and competition, and both are properties of composed systems rather than of a brief.',
    );
  }

  const all = interfacesOf(ctx);
  const position = appointmentPosition(ctx);
  const model = position.appointment?.model;
  const profile = model ? profileFor(model) : undefined;

  const modelEffect = profile
    ? profile.fundsSupplierCost
      ? 'ETABLIX holds and funds the supplier contracts, so every bundle is ETABLIX’s own cash exposure and its own margin. A large bundle concentrates both.'
      : 'The customer holds the supplier contracts, so a bundle saves the customer interfaces rather than ETABLIX cash. The competition argument is theirs to weigh.'
    : 'No appointment is in force, so who carries the cash and the risk of a bundle is unknown. The interface arithmetic below still holds; the commercial half of the argument does not.';

  const options: PackagingOption[] = [];

  for (let i = 0; i < systems.length; i += 1) {
    for (let k = i + 1; k < systems.length; k += 1) {
      const a = systems[i]!;
      const b = systems[k]!;
      const internalised = sharedInterfaces(a, b, all);
      const families = [a.family, b.family].filter((family, index, list) => list.indexOf(family) === index);
      const bundled = biddersFor(ctx, families);
      const separate = families.map((family) => ({ family, count: biddersFor(ctx, [family]).count }));
      const externalRemaining =
        all.filter((entry) => entry.systemId === a.id || entry.systemId === b.id).length - internalised.length;
      const leadSpreadDays = Math.abs(a.leadDays - b.leadDays);

      const competitionLost = bundled.count < COMPETITION_FLOOR;
      const recommendation: 'BUNDLE' | 'DISAGGREGATE' =
        internalised.length > 0 && !competitionLost ? 'BUNDLE' : 'DISAGGREGATE';

      const factors: PackagingOption['factors'] = [
        {
          id: 'interfaceDensity',
          label: FACTOR_BY_ID.get('interfaceDensity')!.label,
          says:
            internalised.length > 0
              ? `${internalised.length} interface${internalised.length === 1 ? '' : 's'} sit between them: ${internalised.map((entry) => entry.name).join(', ')}. One firm holding both makes each an internal matter rather than a meeting.`
              : 'Nothing sits between them. Bundling would not remove a single conversation.',
          supports: internalised.length > 0 ? 'BUNDLE' : 'DISAGGREGATE',
        },
        {
          id: 'marketCapability',
          label: FACTOR_BY_ID.get('marketCapability')!.label,
          says: `${bundled.count} firm${bundled.count === 1 ? '' : 's'} on the register can deliver both; ${separate
            .map((entry) => `${entry.count} for ${SERVICE_FAMILIES[entry.family].label.toLowerCase()}`)
            .join(' and ')} taken alone.`,
          supports: competitionLost ? 'DISAGGREGATE' : 'BUNDLE',
        },
        {
          id: 'mobilisationLead',
          label: FACTOR_BY_ID.get('mobilisationLead')!.label,
          says:
            leadSpreadDays === 0
              ? `Identical lead times of ${a.leadDays} days. They mobilise as one operation whether or not they are bought as one.`
              : `Lead times differ by ${leadSpreadDays} days (${a.leadDays} against ${b.leadDays}). Bundled, the shorter waits on the longer.`,
          supports: leadSpreadDays === 0 ? 'BUNDLE' : 'DISAGGREGATE',
        },
        {
          id: 'appointmentModel',
          label: FACTOR_BY_ID.get('appointmentModel')!.label,
          // About *this pair*, not the appointment in general. The general
          // statement is on the strategy once; repeating it under every option
          // would make it read as evidence when it is context.
          says: profile
            ? profile.fundsSupplierCost
              ? `Bundled, ${SERVICE_FAMILIES[a.family].label.toLowerCase()} and ${SERVICE_FAMILIES[b.family].label.toLowerCase()} become one cash exposure on ETABLIX's own balance sheet rather than two that can fail separately.`
              : `The customer contracts both either way, so bundling saves the customer ${internalised.length} interface${internalised.length === 1 ? '' : 's'} and costs ETABLIX nothing.`
            : 'No appointment is in force, so it is not yet known who would carry this bundle.',
          supports: profile?.fundsSupplierCost ? 'DISAGGREGATE' : 'BUNDLE',
        },
      ];

      // The sentence the specification requires. It is built from the counted
      // evidence rather than chosen from a list of phrasings, so a
      // recommendation cannot be produced without one.
      const one = internalised.length === 1;
      const argument =
        recommendation === 'BUNDLE'
          ? `Bundling reduces interfaces: ${internalised.map((entry) => entry.name).join(', ')} ${
              one ? 'stops being an interface' : 'stop being interfaces'
            } between two firms and ${one ? 'becomes an internal matter' : 'become internal matters'} for one. ${externalRemaining} interface${
              externalRemaining === 1 ? '' : 's'
            } remain${externalRemaining === 1 ? 's' : ''} external either way, and ${bundled.count} firms can still price it — which meets the floor of ${COMPETITION_FLOOR}, so the saving costs no competition.`
          : competitionLost
            ? `Disaggregation protects competition: ${
                bundled.count === 0
                  ? 'no firm on the register can deliver both families'
                  : `only ${bundled.count} firm${bundled.count === 1 ? '' : 's'} on the register can deliver both families, below the floor of ${COMPETITION_FLOOR}`
              }. Split, ${separate
                .map((entry) => `${entry.count} can price ${SERVICE_FAMILIES[entry.family].label.toLowerCase()}`)
                .join(' and ')}. A bundle ${
                bundled.count === 0 ? 'nobody' : bundled.count === 1 ? 'only one firm' : `only ${bundled.count} firms`
              } can price is a negotiation, not a tender.`
            : `Disaggregation protects specialist performance: no interface sits between ${SERVICE_FAMILIES[a.family].label.toLowerCase()} and ${SERVICE_FAMILIES[b.family].label.toLowerCase()}, so bundling would remove no conversation while asking one firm to be good at both. ${separate
                .map((entry) => `${entry.count} firms can price ${SERVICE_FAMILIES[entry.family].label.toLowerCase()}`)
                .join('; ')}.`;

      options.push({
        id: `${a.id}+${b.id}`,
        label: `${a.label} (${a.zone}) with ${b.label} (${b.zone})`,
        families,
        systemIds: [a.id, b.id],
        internalised,
        externalRemaining,
        biddersIfBundled: bundled.count,
        biddersIfSeparate: separate,
        leadSpreadDays,
        factors,
        argument,
        recommendation,
      });
    }
  }

  if (systems.length === 1) {
    const only = systems[0]!;
    const separate = biddersFor(ctx, [only.family]);
    options.push({
      id: only.id,
      label: `${only.label} (${only.zone}) on its own`,
      families: [only.family],
      systemIds: [only.id],
      internalised: [],
      externalRemaining: all.filter((entry) => entry.systemId === only.id).length,
      biddersIfBundled: separate.count,
      biddersIfSeparate: [{ family: only.family, count: separate.count }],
      leadSpreadDays: 0,
      factors: [
        {
          id: 'interfaceDensity',
          label: FACTOR_BY_ID.get('interfaceDensity')!.label,
          says: 'Only one system is composed, so there is nothing to bundle it with.',
          supports: 'DISAGGREGATE',
        },
      ],
      argument: `Disaggregation protects competition by default: this is the only composed system, so there is no bundle to argue about. ${separate.count} firms on the register can price it${separate.count < COMPETITION_FLOOR ? `, which is below the floor of ${COMPETITION_FLOOR} and is a market problem rather than a packaging one` : ''}.`,
      recommendation: 'DISAGGREGATE',
    });
  }

  const strategy: PackagingStrategy = {
    id: ulid(),
    projectId: ctx.projectId,
    options,
    competitionFloor: COMPETITION_FLOOR,
    ...(model ? { model } : {}),
    modelEffect,
    assessedAt: new Date().toISOString(),
    assessedBy: ctx.auth.actorId,
  };

  write(ctx, {
    eventType: 'PACKAGING_STRATEGY_ASSESSED',
    entity: { refType: 'PackagingStrategy', refId: strategy.id },
    nextState: strategy,
  });

  return strategy;
}

// --- The package itself ------------------------------------------------------------

export function createPackage(
  ctx: EngineContext,
  input: { title: string; systemIds: string[] },
): ServicePackage {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C');

  if (!input.title?.trim()) {
    throw new DomainError('SERVICE_PACKAGE_UNNAMED', 'A package is named for what it buys.');
  }
  if (!Array.isArray(input.systemIds) || input.systemIds.length === 0) {
    throw new DomainError(
      'SERVICE_PACKAGE_UNLINKED',
      'A package buys one or more composed service systems. Bought against nothing, it is bought against somebody’s memory of the brief and there is nothing to compare the delivery to.',
    );
  }

  const systems = systemsOf(ctx);
  const linked = input.systemIds.map((id) => {
    const found = systems.find((entry) => entry.id === id);
    if (!found) throw new DomainError('SERVICE_SYSTEM_NOT_FOUND', `No composed system ${id} on this project`, 404);
    return found;
  });

  // One system, one package. A system bought twice is a system paid for twice.
  for (const system of linked) {
    const clash = packagesOf(ctx).find((entry) => entry.systemIds.includes(system.id));
    if (clash) {
      throw new DomainError(
        'SERVICE_SYSTEM_ALREADY_PACKAGED',
        `${system.label} (${system.zone}) is already bought by ${clash.reference} ${clash.title}. A system in two packages is a system paid for twice.`,
      );
    }
  }

  const reference = `SVC-${String(packagesOf(ctx).length + 1).padStart(3, '0')}`;
  const record: ServicePackage = {
    id: ulid(),
    projectId: ctx.projectId,
    reference,
    title: input.title.trim(),
    systemIds: linked.map((entry) => entry.id),
    families: linked.map((entry) => entry.family).filter((family, index, list) => list.indexOf(family) === index),
    stated: {},
    createdBy: ctx.auth.actorId,
    createdAt: new Date().toISOString(),
  };

  write(ctx, {
    eventType: 'SERVICE_PACKAGE_CREATED',
    entity: { refType: 'ServicePackage', refId: record.id },
    nextState: record,
  });
  return record;
}

export function statePackageField(
  ctx: EngineContext,
  input: { packageId: string; field: string; value: string },
): ServicePackage {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'U');

  const record = packageOf(ctx, input.packageId);
  if (!STATED_REQUIREMENTS.includes(input.field)) {
    const derived = PACKAGE_REQUIREMENTS.find((entry) => entry.id === input.field);
    throw new DomainError(
      derived ? 'SERVICE_PACKAGE_FIELD_DERIVED' : 'SERVICE_PACKAGE_FIELD_UNKNOWN',
      derived
        ? `${derived.label} is derived from the systems this package links to and is not stated by hand. ${derived.matters}`
        : `${input.field} is not one of the fields a package carries`,
      derived ? 422 : 404,
    );
  }
  if (!input.value?.trim()) {
    throw new DomainError(
      'SERVICE_PACKAGE_FIELD_EMPTY',
      'An empty field is not an answer. Say what it is, or leave it outstanding so it reads as outstanding.',
    );
  }
  if (record.tenderedAt) {
    throw new DomainError(
      'SERVICE_PACKAGE_TENDERED',
      `${record.reference} has been issued to tender. Changing the scope now is an addendum on the enquiry, not an edit to the package — every bidder has to see it and re-acknowledge.`,
    );
  }

  const updated: ServicePackage = { ...record, stated: { ...record.stated, [input.field]: input.value.trim() } };
  write(ctx, {
    eventType: 'SERVICE_PACKAGE_SPECIFIED',
    entity: { refType: 'ServicePackage', refId: record.id },
    nextState: updated,
  });
  return updated;
}

export type PackageRequirementView = PackageRequirement & {
  satisfied: boolean;
  detail: string;
};

/** Every requirement, derived or stated, with what actually satisfies it. */
export function requirementsFor(ctx: EngineContext, record: ServicePackage): PackageRequirementView[] {
  const systems = systemsOf(ctx).filter((entry) => record.systemIds.includes(entry.id));
  const interfaces = interfacesOf(ctx).filter((entry) => record.systemIds.includes(entry.systemId));

  return PACKAGE_REQUIREMENTS.map((requirement) => {
    if (requirement.kind === 'STATED') {
      const value = record.stated[requirement.id];
      return {
        ...requirement,
        satisfied: Boolean(value),
        detail: value ?? 'Not stated.',
      };
    }

    switch (requirement.id) {
      case 'sbsLinks':
        return {
          ...requirement,
          satisfied: systems.length > 0,
          detail:
            systems.length > 0
              ? systems.map((entry) => `${entry.label} (${entry.zone}) v${entry.version}`).join('; ')
              : 'The linked systems are no longer on this project.',
        };
      case 'interfaces':
        return {
          ...requirement,
          satisfied: interfaces.length > 0,
          detail:
            interfaces.length > 0
              ? `${interfaces.length} carried into this package: ${interfaces.map((entry) => entry.name).join(', ')}.`
              : 'The linked systems raised no interfaces, which means nothing has been composed for them.',
        };
      case 'quantities': {
        const basis = systems.flatMap((entry) => entry.basis);
        return {
          ...requirement,
          satisfied: basis.length > 0,
          detail:
            basis.length > 0
              ? basis.map((entry) => `${entry.label} ${entry.normal} ${entry.unit} (peak ${entry.peak})`).join('; ')
              : 'Sized on scope and sequence rather than capacity, so the schedule is a scope schedule and not a quantified one.',
        };
      }
      case 'programme': {
        if (systems.length === 0) return { ...requirement, satisfied: false, detail: 'No linked system to take dates from.' };
        const from = systems.map((entry) => entry.fromDate).sort()[0]!;
        const to = systems.map((entry) => entry.toDate).sort().at(-1)!;
        const lead = Math.max(...systems.map((entry) => entry.leadDays));
        const weeks = Math.round((Date.parse(to) - Date.parse(from)) / (7 * 86_400_000));
        return {
          ...requirement,
          satisfied: true,
          detail: `On site ${from} to ${to} — ${weeks} weeks, ${lead} days lead. Hire and staffing price against this duration.`,
        };
      }
      case 'removal':
        return {
          ...requirement,
          satisfied: systems.length > 0,
          detail: systems.map((entry) => entry.removalObligation).join(' ') || 'No linked system to take a removal obligation from.',
        };
      default:
        // Fails closed, exactly as §8's derived evidence does: a requirement
        // declared derived with nothing deriving it would otherwise pass
        // silently for ever.
        return { ...requirement, satisfied: false, detail: `${requirement.id} is declared derived and nothing derives it.` };
    }
  });
}

/**
 * Issue a package to tender.
 *
 * The tender event itself is `domain/enquiry.ts` — controlled recipients,
 * acknowledgement, addenda, return completeness, late-return treatment and the
 * audit log are all already built and governed there, and a second copy of them
 * living inside a module would be the exact duplication rule 6 exists to stop.
 *
 * What this adds is the refusal: a package with an outstanding minimum field
 * cannot be issued. Every one of the twelve is a thing that gets argued about
 * later if it is silent now, and the moment of issue is the last moment it is
 * free to fix.
 */
export function openPackageTender(
  ctx: EngineContext,
  input: { packageId: string; returnDeadline: string },
): { package: ServicePackage; enquiryId: string; reference: string } {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'A');

  const record = packageOf(ctx, input.packageId);
  if (record.tenderedAt) {
    throw new DomainError(
      'SERVICE_PACKAGE_TENDERED',
      `${record.reference} was issued to tender on ${record.tenderedAt.slice(0, 10)} as enquiry ${record.enquiryId}. A second issue would be a second competition against the same scope.`,
    );
  }

  const outstanding = requirementsFor(ctx, record).filter((entry) => !entry.satisfied);
  if (outstanding.length > 0) {
    throw new DomainError(
      'SERVICE_PACKAGE_INCOMPLETE',
      `${record.reference} has ${outstanding.length} of ${PACKAGE_REQUIREMENTS.length} minimum fields outstanding: ${outstanding
        .map((entry) => `${entry.label} — ${entry.matters}`)
        .join(' ')}`,
    );
  }

  // Raised under `SITE_SERVICES`, not under `PROCUREMENT_AWARD`.
  //
  // The enquiry machinery is the same either way — controlled recipients,
  // addenda, acknowledgement, the audit log — and it is called rather than
  // copied. What differs is the authority to buy. Main-works procurement is
  // gated to Tender and Construction, and rightly: buying the frame in O&M is a
  // process error. Site services are not that. Welfare is bought before the
  // first pour, cleaning is re-let in month twenty, security runs past practical
  // completion and the whole compound is demobilised after handover. A window
  // drawn around the main works closes the wrong door on all four.
  const enquiry = openEnquiry(ctx, {
    packageReference: record.reference,
    title: record.title,
    returnDeadline: input.returnDeadline,
    area: 'SITE_SERVICES',
  });

  const updated: ServicePackage = {
    ...record,
    enquiryId: enquiry.enquiryId,
    tenderedAt: new Date().toISOString(),
  };
  write(ctx, {
    eventType: 'SERVICE_PACKAGE_TENDERED',
    entity: { refType: 'ServicePackage', refId: record.id },
    nextState: updated,
  });

  return { package: updated, enquiryId: enquiry.enquiryId, reference: enquiry.reference };
}

// --- §7.2 Bid normalisation --------------------------------------------------------

export function recordBid(
  ctx: EngineContext,
  input: {
    packageId: string;
    supplierId: string;
    supplierName: string;
    lines: ServiceBidLine[];
    basis: BidBasis;
    exclusions?: string[];
    technicalScore?: number;
  },
): ServiceBid {
  requireModule(ctx.grantedModules, 'ETABLIX');
  // `COMMERCIAL_L3` on every path that touches a return. A priced return
  // belongs to a firm competing with the others in the field, and a rival's
  // rate leaked is the same harm here as anywhere else on the platform.
  authorise(ctx, 'SITE_SERVICES', 'C', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = packageOf(ctx, input.packageId);
  if (!record.tenderedAt) {
    throw new DomainError(
      'SERVICE_PACKAGE_NOT_TENDERED',
      `${record.reference} has not been issued. A return against a package nobody issued is a price for a scope nobody controlled.`,
    );
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new DomainError('SERVICE_BID_EMPTY', 'A return with no priced lines is not a return.');
  }
  if (!input.basis?.currency?.trim()) {
    throw new DomainError(
      'SERVICE_BID_UNBASED',
      'A return states the currency and tax basis it is priced on. Without them the number cannot be compared with any other number.',
    );
  }
  if (input.technicalScore !== undefined && (input.technicalScore < 0 || input.technicalScore > 100)) {
    throw new DomainError('SERVICE_BID_SCORE_RANGE', 'A technical score is out of 100');
  }

  // A second return from the same firm supersedes the first — a clarified
  // return replaces the one it clarifies rather than sitting beside it, or the
  // comparison has two prices for one bidder and no rule for choosing.
  const existing = bidsOf(ctx, record.id).find((entry) => entry.supplierId === input.supplierId);

  const bid: ServiceBid = {
    id: ulid(),
    projectId: ctx.projectId,
    packageId: record.id,
    supplierId: input.supplierId,
    supplierName: input.supplierName,
    lines: input.lines,
    basis: input.basis,
    exclusions: input.exclusions ?? [],
    ...(input.technicalScore !== undefined ? { technicalScore: input.technicalScore } : {}),
    receivedAt: new Date().toISOString(),
    receivedBy: ctx.auth.actorId,
  };

  write(ctx, {
    eventType: existing ? 'SERVICE_BID_CLARIFIED' : 'SERVICE_BID_RECEIVED',
    entity: { refType: 'ServiceBid', refId: bid.id },
    nextState: bid,
  });

  if (existing) {
    write(ctx, {
      eventType: 'SERVICE_BID_CLARIFIED',
      entity: { refType: 'ServiceBid', refId: existing.id },
      nextState: { ...existing, superseded: true as const },
    });
  }

  return bid;
}

/**
 * Lock a clarified return, with the supplier's acknowledgement.
 *
 * §7.2's sixth step, and the reason it is a step at all: award analysis run on
 * an unacknowledged return is analysis of what the buyer *believes* the bidder
 * meant. The bidder has to have agreed the clarified position before it becomes
 * the basis of a comparison, or the first thing that happens after award is a
 * conversation about what was actually priced.
 */
export function lockReturn(
  ctx: EngineContext,
  input: { bidId: string; acknowledgedBy: string },
): ServiceBid {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const bid = ctx.ledger
    .list(ctx.projectId, 'ServiceBid')
    .map((record) => record.state as unknown as ServiceBid)
    .find((record) => record.id === input.bidId);
  if (!bid) throw new DomainError('SERVICE_BID_NOT_FOUND', 'No such return on this project', 404);
  if (bid.superseded) {
    throw new DomainError(
      'SERVICE_BID_SUPERSEDED',
      'That return has been replaced by a later one from the same firm. Lock the return that stands.',
    );
  }
  if (!input.acknowledgedBy?.trim()) {
    throw new DomainError(
      'SERVICE_BID_UNACKNOWLEDGED',
      'Name who at the supplier acknowledged the clarified position. A lock the bidder never agreed to is the buyer’s opinion of what was priced.',
    );
  }
  if (bid.lockedAt) return bid;

  const locked: ServiceBid = {
    ...bid,
    lockedAt: new Date().toISOString(),
    lockedBy: ctx.auth.actorId,
    acknowledgedBy: input.acknowledgedBy.trim(),
  };
  write(ctx, {
    eventType: 'SERVICE_BID_LOCKED',
    entity: { refType: 'ServiceBid', refId: bid.id },
    nextState: locked,
  });
  return locked;
}

export type MappingProblem = {
  kind: 'OMISSION' | 'DUPLICATE' | 'QUALIFICATION' | 'UNSOLICITED';
  scheduleItemId: string;
  statement: string;
};

export type NormalisationAdjustment = {
  basis: NormalisationBasisId;
  label: string;
  /** What the bidder declared, in their terms. */
  declared: string;
  /** What it is worth once expressed on the common basis, in minor units. */
  adjustmentMinor: number;
  reason: string;
};

export type PricedExclusion = {
  item: string;
  /** Never a score deduction. A number, and where the number came from. */
  pricedMinor: number;
  source: string;
};

export type Sensitivity = {
  id: 'MOBILISATION_DELAY' | 'PEAK_WORKFORCE' | 'EXTENSION' | 'ENERGY_VARIANCE' | 'EARLY_TERMINATION';
  label: string;
  assumption: string;
  evaluatedMinor: number;
};

export type ClarificationQuestion = {
  question: string;
  /** What it is worth being wrong about, in minor units. Drives the ranking. */
  consequenceMinor: number;
  /** True where an award cannot be made until it is answered. */
  awardBlocking: boolean;
};

export type NormalisedBid = {
  bidId: string;
  supplierId: string;
  supplierName: string;
  submittedMinor: number;
  mapping: MappingProblem[];
  adjustments: NormalisationAdjustment[];
  pricedExclusions: PricedExclusion[];
  normalisedMinor: number;
  evaluatedMinor: number;
  sensitivities: Sensitivity[];
  clarifications: ClarificationQuestion[];
  technicalScore?: number;
  locked: boolean;
  /** Set where the return cannot be compared at all, and why. */
  incomparable?: string;
};

export type NormalisationResult = {
  packageId: string;
  reference: string;
  /** The pricing schedule every return is mapped to. Derived from the systems. */
  schedule: { itemId: string; description: string; quantity: number; unit: string }[];
  bids: NormalisedBid[];
  /** The median compliant rate per schedule item, and how many made it. */
  medians: { itemId: string; medianRateMinor: number; compliantBids: number }[];
  bases: typeof NORMALISATION_BASES;
  locked: number;
  received: number;
};

/**
 * The pricing schedule a package is priced against.
 *
 * Derived from the linked systems' design basis rather than typed, for the same
 * reason §8's derived evidence is derived: a schedule retyped from the design
 * is a schedule that will disagree with it, and the disagreement is discovered
 * at the first valuation.
 */
export function scheduleFor(ctx: EngineContext, record: ServicePackage): NormalisationResult['schedule'] {
  const systems = systemsOf(ctx).filter((entry) => record.systemIds.includes(entry.id));
  return systems.flatMap((system) =>
    system.basis.map((derivation) => ({
      itemId: `${system.id}:${derivation.id}`,
      description: `${system.label} — ${derivation.label}`,
      quantity: derivation.peak,
      unit: derivation.unit,
    })),
  );
}

function lineTotal(line: ServiceBidLine): number {
  return Math.round(line.quantity * line.rateMinor);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/**
 * The six steps, in order, and the third one is the point.
 *
 * 1. Map every line to the issued schedule — omissions, duplicates, unsolicited
 *    lines and qualifications, each named.
 * 2. Normalise the eleven bases onto one footing, each adjustment carrying what
 *    was declared and why it is worth what it is worth.
 * 3. Price every exclusion at the median compliant rate. **Visibly.** An
 *    exclusion folded into a score is a cost that arrives after award with
 *    nothing in the file explaining why the winner was cheaper.
 * 4. Evaluate across the planned duration and five sensitivity scenarios.
 * 5. Raise clarifications ranked by what it is worth being wrong about.
 * 6. Report which returns are locked, because the sixth step is a gate on the
 *    award rather than a step in the arithmetic.
 *
 * Recomputed on every read rather than stored. A stored normalisation is a
 * normalisation of the bids as they were, and the whole reason for the sixth
 * step is that returns keep changing until they are locked.
 */
export function normaliseBids(ctx: EngineContext, packageId: string): NormalisationResult {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = packageOf(ctx, packageId);
  const schedule = scheduleFor(ctx, record);
  const bids = bidsOf(ctx, packageId);

  // Step 3's median is a median of the *compliant* rates: a firm that excluded
  // an item has no opinion about what it costs, and including their silence as
  // a zero would drag the median toward the exclusion it is meant to price.
  const medians = schedule.map((item) => {
    const rates = bids
      .filter((bid) => !bid.exclusions.includes(item.itemId))
      .flatMap((bid) => bid.lines.filter((line) => line.scheduleItemId === item.itemId).map((line) => line.rateMinor));
    return { itemId: item.itemId, medianRateMinor: median(rates), compliantBids: rates.length };
  });

  const normalised = bids.map((bid): NormalisedBid => {
    const submittedMinor = bid.lines.reduce((sum, line) => sum + lineTotal(line), 0);

    // --- Step 1: map to the issued schedule
    const mapping: MappingProblem[] = [];
    for (const item of schedule) {
      const matched = bid.lines.filter((line) => line.scheduleItemId === item.itemId);
      if (matched.length === 0 && !bid.exclusions.includes(item.itemId)) {
        mapping.push({
          kind: 'OMISSION',
          scheduleItemId: item.itemId,
          statement: `${item.description} is on the schedule and not in the return, and was not declared as an exclusion. Silence is not a zero.`,
        });
      }
      if (matched.length > 1) {
        mapping.push({
          kind: 'DUPLICATE',
          scheduleItemId: item.itemId,
          statement: `${item.description} is priced ${matched.length} times. Either an allowance is duplicated or two different things are being called one.`,
        });
      }
      for (const line of matched) {
        if (line.qualification) {
          mapping.push({
            kind: 'QUALIFICATION',
            scheduleItemId: item.itemId,
            statement: `${item.description} is qualified: “${line.qualification}”. A qualified price is a price for something else.`,
          });
        }
        if (line.quantity !== item.quantity) {
          mapping.push({
            kind: 'QUALIFICATION',
            scheduleItemId: item.itemId,
            statement: `${item.description} is priced at ${line.quantity} ${line.unit} against an issued quantity of ${item.quantity} ${item.unit}.`,
          });
        }
      }
    }
    for (const line of bid.lines) {
      if (!schedule.some((item) => item.itemId === line.scheduleItemId)) {
        mapping.push({
          kind: 'UNSOLICITED',
          scheduleItemId: line.scheduleItemId,
          statement: `“${line.description}” is priced and is not on the issued schedule. It is either a scope the buyer did not ask for or a rename of one that is.`,
        });
      }
    }

    // --- Step 2: normalise the eleven bases
    const adjustments: NormalisationAdjustment[] = [];
    const add = (
      basis: NormalisationBasisId,
      declared: string,
      adjustmentMinor: number,
      reason: string,
    ): void => {
      adjustments.push({
        basis,
        label: NORMALISATION_BASES.find((entry) => entry.id === basis)!.label,
        declared,
        adjustmentMinor,
        reason,
      });
    };

    let incomparable: string | undefined;
    const houseCurrency = bids[0]?.basis.currency;
    if (houseCurrency && bid.basis.currency !== houseCurrency) {
      // Deliberately not converted. There is no rate on this platform and
      // inventing one would produce a comparison that looks right and is not.
      incomparable = `Priced in ${bid.basis.currency} against ${houseCurrency} elsewhere. No exchange rate is held, and a rate invented here would produce a comparison that looks right and is not.`;
      add('currency', bid.basis.currency, 0, incomparable);
    } else {
      add('currency', bid.basis.currency, 0, 'Same currency as the rest of the field.');
    }

    if (bid.basis.taxBasis === 'INCLUSIVE') {
      // Reported, never silently stripped: the rate is unknown here, and a
      // guessed one is worse than a stated unknown.
      add(
        'taxBasis',
        'Tax inclusive',
        0,
        'Returned tax-inclusive against a schedule issued exclusive. Read as exclusive it is a fifth of a package cheaper than it is; the tax has to come off before comparison.',
      );
      incomparable ??=
        'Returned on a tax-inclusive basis while the rest of the field is exclusive. The two cannot be compared until the tax is stripped.';
    } else {
      add('taxBasis', 'Tax exclusive', 0, 'On the issued basis.');
    }

    const programme = requirementsFor(ctx, record).find((entry) => entry.id === 'programme');
    const weeks = Number(/([0-9]+) weeks/.exec(programme?.detail ?? '')?.[1] ?? 0);
    if (bid.basis.hirePeriodWeeks !== undefined && weeks > 0 && bid.basis.hirePeriodWeeks < weeks) {
      const shortfall = weeks - bid.basis.hirePeriodWeeks;
      const weekly = Math.round(submittedMinor / Math.max(bid.basis.hirePeriodWeeks, 1));
      add(
        'hirePeriodWeeks',
        `${bid.basis.hirePeriodWeeks} weeks`,
        weekly * shortfall,
        `Priced over ${bid.basis.hirePeriodWeeks} weeks against a programme of ${weeks}. The ${shortfall} weeks nobody priced are ${shortfall} weeks somebody pays for.`,
      );
    } else if (bid.basis.hirePeriodWeeks !== undefined) {
      add('hirePeriodWeeks', `${bid.basis.hirePeriodWeeks} weeks`, 0, `Covers the ${weeks}-week programme.`);
    }

    if (bid.basis.escalationPercent) {
      // Half the period, because escalation applies from the midpoint on
      // average rather than from day one.
      const effect = Math.round((submittedMinor * bid.basis.escalationPercent) / 100 / 2);
      add(
        'escalationPercent',
        `${bid.basis.escalationPercent}% indexed`,
        effect,
        'Indexed rather than fixed. Applied over half the period, which is where an even spend profile puts the average.',
      );
    } else {
      add('escalationPercent', 'Fixed', 0, 'Fixed for the period.');
    }

    if (bid.basis.workingHours) add('workingHours', bid.basis.workingHours, 0, 'Declared. Compare against the operating hours in the brief.');
    if (bid.basis.transport) add('transport', bid.basis.transport, 0, 'Declared delivery basis.');

    const included: [NormalisationBasisId, boolean | undefined, string][] = [
      ['mobilisation', bid.basis.mobilisationIncluded, 'Mobilisation'],
      ['demobilisation', bid.basis.demobilisationIncluded, 'Demobilisation'],
      ['consumables', bid.basis.consumablesIncluded, 'Consumables'],
      ['standby', bid.basis.standbyIncluded, 'Standby'],
      ['supervision', bid.basis.supervisionIncluded, 'Supervision'],
      ['reinstatement', bid.basis.reinstatementIncluded, 'Reinstatement'],
    ];
    for (const [id, flag, label] of included) {
      if (flag === undefined) {
        add(id, 'Not stated', 0, `${label} is neither included nor excluded in the return. Unknown is not the same as included, and it is priced as a clarification rather than assumed.`);
      } else if (flag) {
        add(id, 'Included', 0, `${label} is in the price.`);
      } else {
        add(id, 'Excluded', 0, `${label} is out of the price and is priced separately below at the median compliant rate.`);
      }
    }

    // --- Step 3: price the exclusions, visibly
    const pricedExclusions: PricedExclusion[] = bid.exclusions.map((item) => {
      const onSchedule = schedule.find((entry) => entry.itemId === item);
      const medianEntry = medians.find((entry) => entry.itemId === item);
      if (onSchedule && medianEntry && medianEntry.compliantBids > 0) {
        return {
          item: onSchedule.description,
          pricedMinor: Math.round(medianEntry.medianRateMinor * onSchedule.quantity),
          // In the bidder's own currency and in major units. A sentence a
          // person reads carrying a bare minor-unit integer is a sentence that
          // gets misread by a factor of a hundred exactly once, expensively.
          source: `Median compliant rate of ${bid.basis.currency} ${(medianEntry.medianRateMinor / 100).toFixed(2)} across ${medianEntry.compliantBids} returns that priced it, applied to ${onSchedule.quantity} ${onSchedule.unit}.`,
        };
      }
      return {
        item: onSchedule?.description ?? item,
        pricedMinor: 0,
        source:
          'Nothing in the field priced this, so there is no median to price it at. It is carried at zero and named — not scored — because a cost nobody has priced is a cost, not a deduction.',
      };
    });
    for (const [id, flag, label] of included) {
      if (flag === false) {
        const basisMedian = median(
          bids
            .filter((other) => other.id !== bid.id)
            .map((other) => {
              const key = `${id}Included` as keyof BidBasis;
              return other.basis[key] === true ? other.lines.reduce((sum, line) => sum + lineTotal(line), 0) : 0;
            })
            .filter((value) => value > 0),
        );
        pricedExclusions.push({
          item: `${label} (declared out of the price)`,
          // Five per cent of a comparable whole-package price is the working
          // allowance where nothing better exists, and it is stated as an
          // allowance rather than presented as a measured figure.
          pricedMinor: Math.round(basisMedian * 0.05),
          source:
            basisMedian > 0
              ? `Allowed at 5% of the median of the returns that included it. An allowance, stated as one.`
              : 'No return in the field included it, so there is nothing to take an allowance from.',
        });
      }
    }

    const adjustmentTotal = adjustments.reduce((sum, entry) => sum + entry.adjustmentMinor, 0);
    const exclusionTotal = pricedExclusions.reduce((sum, entry) => sum + entry.pricedMinor, 0);
    const normalisedMinor = submittedMinor + adjustmentTotal + exclusionTotal;

    // --- Step 4: evaluated cost across the duration and five scenarios
    const sensitivities: Sensitivity[] = [
      {
        id: 'MOBILISATION_DELAY',
        label: 'Mobilisation delayed four weeks',
        assumption: 'Standing time and a re-mobilisation, taken at four weeks of the weekly rate.',
        evaluatedMinor: normalisedMinor + Math.round((normalisedMinor / Math.max(weeks, 1)) * 4),
      },
      {
        id: 'PEAK_WORKFORCE',
        label: 'Peak workforce 20% above the basis',
        assumption: 'Volume-driven scope — welfare, cleaning, transport — scales with headcount.',
        evaluatedMinor: Math.round(normalisedMinor * 1.2),
      },
      {
        id: 'EXTENSION',
        label: 'Programme extended by 12 weeks',
        assumption: 'Hire and staffing continue at the weekly rate; mobilisation is not repeated.',
        evaluatedMinor: normalisedMinor + Math.round((normalisedMinor / Math.max(weeks, 1)) * 12),
      },
      {
        id: 'ENERGY_VARIANCE',
        label: 'Fuel and energy 30% above the basis',
        assumption: 'Applied to the energy-bearing share of a site-services price, taken at a fifth.',
        evaluatedMinor: normalisedMinor + Math.round(normalisedMinor * 0.2 * 0.3),
      },
      {
        id: 'EARLY_TERMINATION',
        label: 'Terminated at the halfway point',
        assumption: 'Half the period served, demobilisation in full, and no recovery of mobilisation.',
        evaluatedMinor: Math.round(normalisedMinor * 0.5) + exclusionTotal,
      },
    ];

    // --- Step 5: clarifications, ranked by what it is worth being wrong about
    const clarifications: ClarificationQuestion[] = [];
    for (const problem of mapping) {
      const item = schedule.find((entry) => entry.itemId === problem.scheduleItemId);
      const worth = item ? (medians.find((entry) => entry.itemId === item.itemId)?.medianRateMinor ?? 0) * item.quantity : 0;
      clarifications.push({
        question:
          problem.kind === 'OMISSION'
            ? `${item?.description ?? problem.scheduleItemId} is not priced and not excluded. Is it included in another line, or is it out?`
            : problem.kind === 'DUPLICATE'
              ? `${item?.description ?? problem.scheduleItemId} appears more than once. Which line stands?`
              : problem.kind === 'UNSOLICITED'
                ? `${problem.scheduleItemId} is priced and is not on the schedule. What is it, and what does it replace?`
                : `${problem.statement} Please confirm the position that stands.`,
        consequenceMinor: worth,
        awardBlocking: problem.kind === 'OMISSION' || problem.kind === 'DUPLICATE',
      });
    }
    for (const [id, flag, label] of included) {
      if (flag === undefined) {
        clarifications.push({
          question: `${label} is neither included nor excluded. Which is it?`,
          consequenceMinor: Math.round(normalisedMinor * 0.05),
          awardBlocking: id === 'mobilisation' || id === 'demobilisation' || id === 'reinstatement',
        });
      }
    }
    if (incomparable) {
      clarifications.push({
        question: incomparable,
        consequenceMinor: normalisedMinor,
        awardBlocking: true,
      });
    }
    clarifications.sort(
      (a, b) =>
        Number(b.awardBlocking) - Number(a.awardBlocking) || b.consequenceMinor - a.consequenceMinor,
    );

    return {
      bidId: bid.id,
      supplierId: bid.supplierId,
      supplierName: bid.supplierName,
      submittedMinor,
      mapping,
      adjustments,
      pricedExclusions,
      normalisedMinor,
      evaluatedMinor: normalisedMinor,
      sensitivities,
      clarifications,
      ...(bid.technicalScore !== undefined ? { technicalScore: bid.technicalScore } : {}),
      locked: Boolean(bid.lockedAt),
      ...(incomparable ? { incomparable } : {}),
    };
  });

  return {
    packageId: record.id,
    reference: record.reference,
    schedule,
    bids: normalised.sort((a, b) => a.normalisedMinor - b.normalisedMinor),
    medians,
    bases: NORMALISATION_BASES,
    locked: normalised.filter((entry) => entry.locked).length,
    received: normalised.length,
  };
}

export type AwardRecommendation = {
  id: string;
  projectId: string;
  packageId: string;
  reference: string;
  recommended?: { supplierId: string; supplierName: string; normalisedMinor: number };
  /** Why nothing is recommended, where nothing is. */
  refusedBecause?: string;
  eligibility: { supplierId: string; supplierName: string; eligible: boolean; reason: string }[];
  comparison: {
    supplierId: string;
    supplierName: string;
    submittedMinor: number;
    normalisedMinor: number;
    exclusionsPricedMinor: number;
    technicalScore?: number;
    worstCaseMinor: number;
    worstCase: string;
    deliveryRisk: string;
    openClarifications: number;
  }[];
  /** True where the cheapest submitted price is not the cheapest normalised. */
  orderChanged: boolean;
  standstill?: string;
  recommendedAt: string;
  recommendedBy: string;
};

/**
 * The award recommendation §7.1's last object requires.
 *
 * It refuses on two grounds and both are the specification's. An unlocked
 * return is a position the bidder has not agreed, and an award-blocking
 * clarification is a question whose answer changes the answer. Recommending
 * over either produces a paper that reads as a decision and is a guess.
 */
export function recommendAward(ctx: EngineContext, packageId: string): AwardRecommendation {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'A', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = packageOf(ctx, packageId);
  const normalisation = normaliseBids(ctx, packageId);
  if (normalisation.bids.length === 0) {
    throw new DomainError('SERVICE_AWARD_NO_RETURNS', `${record.reference} has no returns to compare.`);
  }

  const suppliers = registeredSuppliers(ctx);

  const eligibility = normalisation.bids.map((bid) => {
    const supplier = suppliers.find((entry) => entry.id === bid.supplierId);
    if (!supplier) {
      return {
        supplierId: bid.supplierId,
        supplierName: bid.supplierName,
        eligible: false,
        reason: 'Not on the supply-chain register. A return from a firm nobody prequalified is a return from a firm nobody checked.',
      };
    }
    const barred = supplier.status === 'DO_NOT_USE' || supplier.status === 'SUSPENDED';
    return {
      supplierId: bid.supplierId,
      supplierName: bid.supplierName,
      eligible: !barred,
      reason: barred
        ? `The register holds this firm as ${supplier.status.replaceAll('_', ' ').toLowerCase()}. That is a decision the business made and it is not overridden by a good price.`
        : `On the register as ${supplier.status.replaceAll('_', ' ').toLowerCase()}.`,
    };
  });

  const comparison = normalisation.bids.map((bid) => {
    const worst = [...bid.sensitivities].sort((a, b) => b.evaluatedMinor - a.evaluatedMinor)[0]!;
    const open = bid.clarifications.filter((entry) => entry.awardBlocking).length;
    return {
      supplierId: bid.supplierId,
      supplierName: bid.supplierName,
      submittedMinor: bid.submittedMinor,
      normalisedMinor: bid.normalisedMinor,
      exclusionsPricedMinor: bid.pricedExclusions.reduce((sum, entry) => sum + entry.pricedMinor, 0),
      ...(bid.technicalScore !== undefined ? { technicalScore: bid.technicalScore } : {}),
      worstCaseMinor: worst.evaluatedMinor,
      worstCase: worst.label,
      deliveryRisk:
        bid.mapping.length === 0
          ? 'Return maps cleanly to the issued schedule.'
          : `${bid.mapping.length} mapping problem${bid.mapping.length === 1 ? '' : 's'}: ${bid.mapping
              .map((entry) => entry.kind.toLowerCase())
              .filter((kind, index, list) => list.indexOf(kind) === index)
              .join(', ')}.`,
      openClarifications: open,
    };
  });

  const bySubmitted = [...normalisation.bids].sort((a, b) => a.submittedMinor - b.submittedMinor);
  const orderChanged = bySubmitted[0]!.bidId !== normalisation.bids[0]!.bidId;

  const unlocked = normalisation.bids.filter((entry) => !entry.locked);
  const blocking = normalisation.bids.filter((entry) => entry.clarifications.some((q) => q.awardBlocking));
  const eligibleBids = normalisation.bids.filter(
    (bid) => eligibility.find((entry) => entry.supplierId === bid.supplierId)?.eligible,
  );

  let refusedBecause: string | undefined;
  if (unlocked.length > 0) {
    refusedBecause = `${unlocked.length} of ${normalisation.bids.length} returns are not locked: ${unlocked
      .map((entry) => entry.supplierName)
      .join(', ')}. A comparison of positions the bidders have not acknowledged is a comparison of what the buyer believes they meant.`;
  } else if (blocking.length > 0) {
    refusedBecause = `${blocking.length} return${blocking.length === 1 ? ' has' : 's have'} award-blocking clarifications outstanding: ${blocking
      .map((entry) => `${entry.supplierName} (${entry.clarifications.filter((q) => q.awardBlocking).length})`)
      .join(', ')}. Each one is a question whose answer changes the answer.`;
  } else if (eligibleBids.length === 0) {
    refusedBecause =
      'No eligible return. Every firm that priced this package is either off the register or held on it as barred or suspended.';
  }

  const winner = refusedBecause ? undefined : eligibleBids[0];

  const recommendation: AwardRecommendation = {
    id: ulid(),
    projectId: ctx.projectId,
    packageId: record.id,
    reference: record.reference,
    ...(winner
      ? {
          recommended: {
            supplierId: winner.supplierId,
            supplierName: winner.supplierName,
            normalisedMinor: winner.normalisedMinor,
          },
        }
      : {}),
    ...(refusedBecause ? { refusedBecause } : {}),
    eligibility,
    comparison,
    orderChanged,
    ...(eligibleBids.length >= COMPETITION_FLOOR && winner
      ? {
          standstill:
            'A competed award with three or more eligible returns. Where the customer’s procurement is subject to a standstill period, it runs from the notification and before the contract is placed.',
        }
      : {}),
    recommendedAt: new Date().toISOString(),
    recommendedBy: ctx.auth.actorId,
  };

  write(ctx, {
    eventType: 'SERVICE_AWARD_RECOMMENDED',
    entity: { refType: 'AwardRecommendation', refId: recommendation.id },
    nextState: recommendation,
  });

  return recommendation;
}

// --- §7.3 The nine supplier control states -----------------------------------------

export const CONTROL_STATE_IDS = [
  'PROSPECT',
  'PREQUALIFIED',
  'TENDERING',
  'PREFERRED',
  'CONTRACTED',
  'MOBILISING',
  'OPERATIONAL',
  'SUSPENDED_RECOVERY',
  'CLOSED',
] as const;

export type ControlStateId = (typeof CONTROL_STATE_IDS)[number];

export type ControlState = {
  id: ControlStateId;
  order: number;
  label: string;
  /** What has to be true to enter. Checked, not asserted. */
  entryCriteria: string;
  /** What the platform watches while a supplier sits here. */
  automatedControls: readonly string[];
};

/**
 * The nine states, in the order §7.3 sets them.
 *
 * `SUSPENDED_RECOVERY` is deliberately out of the linear order: it is entered
 * from any live state on a material failure or an evidence lapse, and its whole
 * function is to block new work while the recovery runs. A suspension that
 * quietly allowed the next order through would be a status, not a control.
 */
export const CONTROL_STATES: readonly ControlState[] = [
  {
    id: 'PROSPECT',
    order: 0,
    label: 'Prospect',
    entryCriteria: 'Basic entity and capability match — the firm is on the register and covers the package families.',
    automatedControls: [
      'Data enrichment against the register',
      'Conflict, sanctions and duplicate checks',
    ],
  },
  {
    id: 'PREQUALIFIED',
    order: 1,
    label: 'Prequalified',
    entryCriteria: 'Mandatory competence and financial evidence accepted — the register holds a live prequalification with no bars.',
    automatedControls: ['Evidence-expiry monitoring', 'Workload and capacity refresh'],
  },
  {
    id: 'TENDERING',
    order: 2,
    label: 'Tendering',
    entryCriteria: 'A controlled invitation has been issued — the package is at tender and this firm is on the issue list.',
    automatedControls: ['Return reminders', 'Addenda acknowledgement', 'Question and answer segregation'],
  },
  {
    id: 'PREFERRED',
    order: 3,
    label: 'Preferred',
    entryCriteria: 'Evaluation approval pending — a return is in and locked, and the award recommendation names this firm.',
    automatedControls: ['Final clarifications', 'Insurance, credit and capacity recheck'],
  },
  {
    id: 'CONTRACTED',
    order: 4,
    label: 'Contracted',
    entryCriteria: 'Executed agreement and purchase-order authority in place.',
    automatedControls: ['Obligation register', 'Submittal schedule', 'Invoice controls'],
  },
  {
    id: 'MOBILISING',
    order: 5,
    label: 'Mobilising',
    entryCriteria: 'A readiness plan is active — the package’s systems are in the mobilisation control tower.',
    automatedControls: ['Gate evidence chases', 'Constraint alerts', 'Delivery tracking'],
  },
  {
    id: 'OPERATIONAL',
    order: 6,
    label: 'Operational',
    entryCriteria: 'Integrated acceptance passed — every system in the package has reached G6.',
    automatedControls: [
      'KPI and inspection control',
      'Work order control',
      'Earned value',
      'Invoice and change control',
    ],
  },
  {
    id: 'SUSPENDED_RECOVERY',
    order: 7,
    label: 'Suspended / recovery',
    entryCriteria: 'Material failure or evidence lapse. Entered from any live state, and it blocks new work.',
    automatedControls: [
      'Block new work',
      'Recovery plan',
      'Senior escalation',
      'Replacement scenario',
    ],
  },
  {
    id: 'CLOSED',
    order: 8,
    label: 'Closed',
    entryCriteria: 'Demobilisation, defects and the final account are complete.',
    automatedControls: ['Archive', 'Performance score', 'Lessons and residual liability dates'],
  },
];

const STATE_BY_ID = new Map(CONTROL_STATES.map((state) => [state.id, state]));

export type SupplierEngagement = {
  id: string;
  projectId: string;
  packageId: string;
  supplierId: string;
  supplierName: string;
  state: ControlStateId;
  /** Every state this engagement has been in, with why it moved. */
  history: { state: ControlStateId; at: string; by: string; basis: string }[];
  /** Set while suspended. Cleared on recovery, kept on the history either way. */
  suspendedReason?: string;
  openedAt: string;
  openedBy: string;
};

function engagementsOf(ctx: EngineContext): SupplierEngagement[] {
  return ctx.ledger
    .list(ctx.projectId, 'SupplierEngagement')
    .map((record) => record.state as unknown as SupplierEngagement);
}

/**
 * Whether a supplier may enter a state, checked against the platform's own
 * records rather than asserted by whoever is moving them.
 *
 * This is the §8 discipline applied to the supply chain: a state is a
 * conclusion the platform reaches. "Contracted" because somebody clicked
 * contracted is exactly the control that fails in the month it matters.
 */
export function entryCheck(
  ctx: EngineContext,
  engagement: { packageId: string; supplierId: string },
  target: ControlStateId,
  today?: string,
): { permitted: boolean; because: string } {
  const record = packagesOf(ctx).find((entry) => entry.id === engagement.packageId);
  if (!record) return { permitted: false, because: 'The package no longer exists on this project.' };

  const supplier = registeredSuppliers(ctx).find((entry) => entry.id === engagement.supplierId);
  // `today` is a parameter for the same reason it is one on the mobilisation
  // tower: an expiry rule that can only be exercised by waiting for the date
  // is an expiry rule nobody has ever seen fire.
  const asAt = today ?? new Date().toISOString().slice(0, 10);

  switch (target) {
    case 'PROSPECT':
      return supplier
        ? { permitted: true, because: `On the supply-chain register as ${supplier.status.replaceAll('_', ' ').toLowerCase()}.` }
        : { permitted: false, because: 'Not on the supply-chain register. A prospect nobody has registered is a name in an email.' };

    case 'PREQUALIFIED': {
      if (!supplier) return { permitted: false, because: 'Not on the supply-chain register.' };
      const live = supplier.status === 'APPROVED' || supplier.status === 'CONDITIONAL' || supplier.status === 'STRATEGIC';
      if (!live) {
        return {
          permitted: false,
          because: `The register holds this firm as ${supplier.status.replaceAll('_', ' ').toLowerCase()}, which is not a prequalification. Prequalify them there rather than moving them here.`,
        };
      }
      // §7.3's evidence-expiry control, and the reason it is a control rather
      // than a reminder: a prequalification that has run out is not a
      // prequalification, and the day it lapses is the day the insurance behind
      // it stopped being checked.
      if (supplier.prequalifiedUntil && supplier.prequalifiedUntil < asAt) {
        return {
          permitted: false,
          because: `Their prequalification expired on ${supplier.prequalifiedUntil}. An expired assessment is not a lapsed formality — it is the point at which nobody is checking the insurance behind it.`,
        };
      }
      return {
        permitted: true,
        because: `The register holds a live prequalification: ${supplier.status.replaceAll('_', ' ').toLowerCase()}${
          supplier.prequalifiedUntil ? `, valid to ${supplier.prequalifiedUntil}` : ''
        }.`,
      };
    }

    case 'TENDERING':
      return record.tenderedAt
        ? { permitted: true, because: `${record.reference} was issued to tender on ${record.tenderedAt.slice(0, 10)}.` }
        : {
            permitted: false,
            because: `${record.reference} has not been issued. A firm cannot be tendering against a package nobody sent them.`,
          };

    case 'PREFERRED': {
      const bid = bidsOf(ctx, record.id).find((entry) => entry.supplierId === engagement.supplierId);
      if (!bid) return { permitted: false, because: 'No return from this firm against this package.' };
      return bid.lockedAt
        ? { permitted: true, because: `Return locked ${bid.lockedAt.slice(0, 10)}, acknowledged by ${bid.acknowledgedBy}.` }
        : {
            permitted: false,
            because:
              'Their return is not locked. Preferred on an unlocked return means preferred on a position the bidder has not agreed.',
          };
    }

    case 'CONTRACTED': {
      const recommendation = ctx.ledger
        .list(ctx.projectId, 'AwardRecommendation')
        .map((entry) => entry.state as unknown as AwardRecommendation)
        .filter((entry) => entry.packageId === record.id)
        .at(-1);
      if (recommendation?.recommended?.supplierId !== engagement.supplierId) {
        return {
          permitted: false,
          because:
            'No award recommendation names this firm for this package. A contract placed ahead of the recommendation is a contract nobody can point at a decision for.',
        };
      }

      // §19's second and third scenarios, and §20's third bullet: the platform
      // never confuses "ETABLIX coordinates" with "ETABLIX contracts". Which of
      // the three appointments is in force decides whose contract this is, and
      // under Prime it decides whether ETABLIX may commit at all.
      const appointment = appointmentInForce(ctx);
      if (!appointment) {
        return {
          permitted: false,
          because:
            'Nothing is appointed on this project, so there is no answer to whose contract this is. A contracted supplier under no appointment is a liability with no owner.',
        };
      }
      const profile = profileFor(appointment.model);
      const modelName = profile.label.split(' — ')[0];

      if (!profile.fundsSupplierCost) {
        // Advisory and Management. The customer signs, so what this state
        // records is the customer's contract — and it may only be recorded
        // once the customer's own order reference exists. ETABLIX carries no
        // payment liability here and the record has to say so, because a
        // register that shows a contracted supplier with no holder reads as
        // ETABLIX's supplier to everybody who opens it afterwards.
        return {
          permitted: true,
          because: `Awarded under ${modelName}: the customer holds this contract and pays this supplier direct. ETABLIX carries no payment liability against it.`,
        };
      }

      if (!appointment.authority) {
        return {
          permitted: false,
          because: `Under ${modelName} ETABLIX signs this contract and funds it out of its own account. No customer authority to proceed is recorded, and no credit facility is named against it. Both are missing, and a commitment made without either is one ETABLIX has given with nobody's authority and nobody's money.`,
        };
      }
      return {
        permitted: true,
        because: `Awarded under ${modelName} against the customer's authority ${appointment.authority.reference} of ${appointment.authority.grantedOn}, given by ${appointment.authority.grantedBy}.`,
      };
    }

    case 'MOBILISING': {
      const inTower = ctx.ledger
        .list(ctx.projectId, 'GateEvidence')
        .map((entry) => entry.state as unknown as { systemId: string })
        .some((entry) => record.systemIds.includes(entry.systemId));
      return inTower
        ? { permitted: true, because: 'Gate evidence is being attested against this package’s systems.' }
        : {
            permitted: false,
            because:
              'Nothing has been attested against this package’s systems in the mobilisation control tower, so there is no readiness plan to be active on.',
          };
    }

    case 'OPERATIONAL': {
      const accepted = ctx.ledger
        .list(ctx.projectId, 'GateApproval')
        .map((entry) => entry.state as unknown as { systemId: string; gate: string })
        .filter((entry) => entry.gate === 'G6')
        .map((entry) => entry.systemId);
      const outstanding = record.systemIds.filter((id) => !accepted.includes(id));
      return outstanding.length === 0
        ? { permitted: true, because: 'Every system in this package has passed G6 and reached mobilisation acceptance.' }
        : {
            permitted: false,
            because: `${outstanding.length} of ${record.systemIds.length} systems in this package have not reached G6. A supplier is not operational on a service that is not accepted.`,
          };
    }

    case 'SUSPENDED_RECOVERY':
      // Reachable from anywhere. A control that could be refused on entry
      // would be a control that fails exactly when it is needed.
      return { permitted: true, because: 'A material failure or evidence lapse. Entered from any live state.' };

    case 'CLOSED':
      return { permitted: true, because: 'Demobilisation, defects and the final account are recorded as complete.' };

    default:
      return { permitted: false, because: 'Unknown state' };
  }
}

export function engageSupplier(
  ctx: EngineContext,
  input: { packageId: string; supplierId: string; supplierName: string },
): SupplierEngagement {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C');

  const record = packageOf(ctx, input.packageId);
  const existing = engagementsOf(ctx).find(
    (entry) => entry.packageId === record.id && entry.supplierId === input.supplierId,
  );
  if (existing) {
    throw new DomainError(
      'SUPPLIER_ENGAGEMENT_EXISTS',
      `${existing.supplierName} is already engaged on ${record.reference} at ${STATE_BY_ID.get(existing.state)!.label}. A second engagement would give one firm two positions on one package.`,
    );
  }

  const check = entryCheck(ctx, { packageId: record.id, supplierId: input.supplierId }, 'PROSPECT');
  if (!check.permitted) {
    throw new DomainError('SUPPLIER_ENGAGEMENT_INELIGIBLE', check.because);
  }

  const at = new Date().toISOString();
  const engagement: SupplierEngagement = {
    id: ulid(),
    projectId: ctx.projectId,
    packageId: record.id,
    supplierId: input.supplierId,
    supplierName: input.supplierName,
    state: 'PROSPECT',
    history: [{ state: 'PROSPECT', at, by: ctx.auth.actorId, basis: check.because }],
    openedAt: at,
    openedBy: ctx.auth.actorId,
  };

  write(ctx, {
    eventType: 'SUPPLIER_ENGAGEMENT_OPENED',
    entity: { refType: 'SupplierEngagement', refId: engagement.id },
    nextState: engagement,
  });
  return engagement;
}

/**
 * Move a supplier to the next control state.
 *
 * Refused unless the entry criteria are met — and the criteria are read from
 * the platform's own records, not from the person doing the moving. Refused
 * also on a skipped state: a firm cannot be Contracted without having been
 * Preferred, because the state it skipped is the evaluation nobody did.
 */
export function advanceEngagement(
  ctx: EngineContext,
  input: { engagementId: string; to: string },
): SupplierEngagement {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'U');

  const engagement = engagementsOf(ctx).find((entry) => entry.id === input.engagementId);
  if (!engagement) throw new DomainError('SUPPLIER_ENGAGEMENT_NOT_FOUND', 'No such engagement on this project', 404);

  const target = STATE_BY_ID.get(input.to as ControlStateId);
  if (!target) throw new DomainError('CONTROL_STATE_UNKNOWN', `${input.to} is not one of the nine control states`, 404);
  if (target.id === 'SUSPENDED_RECOVERY') {
    throw new DomainError(
      'SUPPLIER_SUSPENSION_UNREASONED',
      'A suspension is not an advance. Suspend the engagement, which requires the failure that caused it.',
    );
  }

  const current = STATE_BY_ID.get(engagement.state)!;
  if (engagement.state === target.id) return engagement;

  if (engagement.state === 'SUSPENDED_RECOVERY') {
    throw new DomainError(
      'SUPPLIER_SUSPENDED',
      `${engagement.supplierName} is suspended: ${engagement.suspendedReason}. New work is blocked until the recovery is recorded.`,
    );
  }
  if (engagement.state === 'CLOSED') {
    throw new DomainError(
      'SUPPLIER_ENGAGEMENT_CLOSED',
      `${engagement.supplierName} is closed on this package. Re-engaging is a new engagement, not a move backwards.`,
    );
  }
  if (target.order !== current.order + 1 && target.id !== 'CLOSED') {
    throw new DomainError(
      'CONTROL_STATE_SKIPPED',
      `${engagement.supplierName} is at ${current.label} and ${target.label} is not the next state. ${
        STATE_BY_ID.get(CONTROL_STATE_IDS[current.order + 1] as ControlStateId)?.label ?? 'The next state'
      } is what stands between them, and skipping it skips the control it carries.`,
    );
  }

  const check = entryCheck(ctx, engagement, target.id);
  if (!check.permitted) {
    throw new DomainError('CONTROL_STATE_UNMET', `${target.label} cannot be entered. ${check.because}`);
  }

  const at = new Date().toISOString();
  const updated: SupplierEngagement = {
    ...engagement,
    state: target.id,
    history: [...engagement.history, { state: target.id, at, by: ctx.auth.actorId, basis: check.because }],
  };
  write(ctx, {
    eventType: 'SUPPLIER_ENGAGEMENT_ADVANCED',
    entity: { refType: 'SupplierEngagement', refId: engagement.id },
    nextState: updated,
  });
  return updated;
}

export function suspendEngagement(
  ctx: EngineContext,
  input: { engagementId: string; reason: string },
): SupplierEngagement {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'A');

  const engagement = engagementsOf(ctx).find((entry) => entry.id === input.engagementId);
  if (!engagement) throw new DomainError('SUPPLIER_ENGAGEMENT_NOT_FOUND', 'No such engagement on this project', 404);
  if (!input.reason?.trim()) {
    throw new DomainError(
      'SUPPLIER_SUSPENSION_UNREASONED',
      'Name the material failure or the evidence that lapsed. A suspension with no cause cannot be recovered from, because nobody can say what would fix it.',
    );
  }
  if (engagement.state === 'SUSPENDED_RECOVERY') return engagement;

  const at = new Date().toISOString();
  const updated: SupplierEngagement = {
    ...engagement,
    state: 'SUSPENDED_RECOVERY',
    suspendedReason: input.reason.trim(),
    history: [
      ...engagement.history,
      { state: 'SUSPENDED_RECOVERY', at, by: ctx.auth.actorId, basis: input.reason.trim() },
    ],
  };
  write(ctx, {
    eventType: 'SUPPLIER_ENGAGEMENT_SUSPENDED',
    entity: { refType: 'SupplierEngagement', refId: engagement.id },
    nextState: updated,
  });
  return updated;
}

// --- The position ------------------------------------------------------------------

export type PackageView = ServicePackage & {
  requirements: PackageRequirementView[];
  outstanding: number;
  systems: { id: string; label: string; zone: string; family: ServiceFamily }[];
  engagements: (SupplierEngagement & { controls: readonly string[]; nextState?: string; nextBlocked?: string })[];
  returns: number;
  lockedReturns: number;
};

export type ProcurementPosition = {
  packages: PackageView[];
  requirements: readonly PackageRequirement[];
  states: readonly ControlState[];
  factors: readonly PackagingFactor[];
  strategy?: PackagingStrategy;
  /** Composed systems no package buys. Absent is not the same as none needed. */
  unpackaged: { id: string; label: string; zone: string }[];
  competitionFloor: number;
};

export function procurementPosition(ctx: EngineContext, today?: string): ProcurementPosition {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'R');

  const systems = systemsOf(ctx);
  const packages = packagesOf(ctx);
  const engagements = engagementsOf(ctx);

  const views: PackageView[] = packages.map((record) => {
    const requirements = requirementsFor(ctx, record);
    const bids = bidsOf(ctx, record.id);
    const mine = engagements
      .filter((entry) => entry.packageId === record.id)
      .map((entry) => {
        const state = STATE_BY_ID.get(entry.state)!;
        const next = CONTROL_STATE_IDS[state.order + 1] as ControlStateId | undefined;
        if (!next || entry.state === 'SUSPENDED_RECOVERY' || entry.state === 'CLOSED') {
          return { ...entry, controls: state.automatedControls };
        }
        const check = entryCheck(ctx, entry, next, today);
        return {
          ...entry,
          controls: state.automatedControls,
          nextState: STATE_BY_ID.get(next)!.label,
          ...(check.permitted ? {} : { nextBlocked: check.because }),
        };
      });

    return {
      ...record,
      requirements,
      outstanding: requirements.filter((entry) => !entry.satisfied).length,
      systems: systems
        .filter((entry) => record.systemIds.includes(entry.id))
        .map((entry) => ({ id: entry.id, label: entry.label, zone: entry.zone, family: entry.family })),
      engagements: mine,
      returns: bids.length,
      lockedReturns: bids.filter((entry) => entry.lockedAt).length,
    };
  });

  const bought = new Set(packages.flatMap((entry) => entry.systemIds));

  return {
    packages: views,
    requirements: PACKAGE_REQUIREMENTS,
    states: CONTROL_STATES,
    factors: PACKAGING_FACTORS,
    strategy: ctx.ledger
      .list(ctx.projectId, 'PackagingStrategy')
      .map((entry) => entry.state as unknown as PackagingStrategy)
      .at(-1),
    unpackaged: systems
      .filter((entry) => !bought.has(entry.id))
      .map((entry) => ({ id: entry.id, label: entry.label, zone: entry.zone })),
    competitionFloor: COMPETITION_FLOOR,
  };
}

/** Re-exported so a screen can name the family a package buys. */
export { FAMILY_DESIGN };
