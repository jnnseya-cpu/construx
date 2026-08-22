import { minimumMultiplier } from './acu.ts';
import { config } from '../config.ts';
import type { Role } from '../identity/roles.ts';

/**
 * Role-based seat pricing.
 *
 * Construction seats are not interchangeable. A construction manager holding
 * final authority over programme, cost and subcontracting is not the same
 * commercial proposition as a trade subcontractor filing a snag response, and
 * pricing them identically either overcharges the site or undercharges the
 * authority. Each seat is priced for the authority it carries.
 *
 * Prices are in pence, matching the ACU wallet, so no part of the billing path
 * works in floating point.
 */

export type SeatType =
  | 'CONSTRUCTION_MANAGER'
  | 'PROJECT_MANAGER'
  | 'COMMERCIAL_MANAGER'
  | 'PLANNER'
  | 'DOCUMENT_CONTROLLER'
  | 'SITE_SUPERVISOR'
  | 'SUBCONTRACTOR'
  | 'EXECUTIVE';

export type SeatDefinition = {
  seat: SeatType;
  label: string;
  /** What the seat is bought for — the authority, not the screen list. */
  authority: string;
  monthlyPriceMinor: number;
  /** Roles this seat may be assigned to. A seat carries the role's permissions. */
  roles: Role[];
};

export const SEATS: Record<SeatType, SeatDefinition> = {
  CONSTRUCTION_MANAGER: {
    seat: 'CONSTRUCTION_MANAGER',
    label: 'Construction Manager',
    authority: 'Final decision on programme, cost, subcontracting, variations and site operations',
    monthlyPriceMinor: 18_000,
    roles: ['EPC'],
  },
  PROJECT_MANAGER: {
    seat: 'PROJECT_MANAGER',
    label: 'Project Manager',
    authority: 'Delivery ownership, programme and coordination; initiates variations but does not approve them',
    monthlyPriceMinor: 14_000,
    roles: ['PM'],
  },
  COMMERCIAL_MANAGER: {
    seat: 'COMMERCIAL_MANAGER',
    label: 'Commercial Manager / QS',
    authority: 'Cost control, procurement, applications and variation pricing',
    monthlyPriceMinor: 15_000,
    roles: ['QS'],
  },
  PLANNER: {
    seat: 'PLANNER',
    label: 'Planner / Planning Engineer',
    authority: 'Programme engine and scenario modelling; reads cost and variations',
    monthlyPriceMinor: 11_000,
    roles: ['PLANNER'],
  },
  DOCUMENT_CONTROLLER: {
    seat: 'DOCUMENT_CONTROLLER',
    label: 'Design / Document Controller',
    authority: 'Drawing register, document control, markups and RFI workflows',
    monthlyPriceMinor: 9_000,
    roles: ['BIM', 'DESIGNER'],
  },
  SITE_SUPERVISOR: {
    seat: 'SITE_SUPERVISOR',
    label: 'Site Manager / Supervisor',
    authority: 'Site diary, snagging, inspections and RAMS acknowledgement',
    monthlyPriceMinor: 7_000,
    // The seat list predates the O&M module; facilities management is operational
    // authority at the same level, so it is priced at the same seat.
    roles: ['SUPERVISOR', 'QAQC', 'SAFETY', 'FM'],
  },
  SUBCONTRACTOR: {
    seat: 'SUBCONTRACTOR',
    label: 'Subcontractor / Trade Access',
    authority: 'Filtered snag list, application submission and domestic variation input',
    monthlyPriceMinor: 2_500,
    roles: ['SUPPLIER'],
  },
  EXECUTIVE: {
    seat: 'EXECUTIVE',
    label: 'Director / Executive',
    authority: 'Portfolio dashboards, CVR summary, risk and cashflow insight',
    monthlyPriceMinor: 12_000,
    roles: ['OWNER', 'ENTERPRISE_ADMIN'],
  },
};

/**
 * Packages cap how many seats a tenant may hold, at a flat monthly price. A
 * tenant pays the package, not the sum of its seats — the seat prices are what
 * a tenant compares against when deciding whether the package is worth it, and
 * what an over-cap seat is charged at.
 */
export type PackageTier = 'CORE_PROJECT' | 'PROFESSIONAL_DELIVERY' | 'ENTERPRISE' | 'FREE_TRIAL';

export type PackageDefinition = {
  package: PackageTier;
  label: string;
  targetCustomer: string;
  /** null = unlimited under fair use. */
  includedSeats: number | null;
  monthlyPriceMinor: number;
  /**
   * The included storage allowance. Never null — no package is uncapped.
   *
   * Unlimited storage against an append-only record is an unbounded liability:
   * nothing stored is ever deleted, so a tenant's usage only rises, and a plan
   * that promises no ceiling promises to carry that for ever at a fixed monthly
   * price. Every figure below is the smallest that reaches the 70% flag no
   * sooner than twelve months of typical use for that package, so the warning
   * lands a year in — early enough to be a conversation, late enough not to be
   * a tax on a customer who has just arrived.
   *
   * Derived from what a project actually accumulates, which is photographs:
   * they are 88–89% of everything on every project size. A small works job runs
   * about 9 GB over six months, a mid project 52 GB over twelve, a major
   * project 258 GB over twenty-four.
   */
  storageGb: number;
  isolatedTenancy: boolean;
  apiAccess: boolean;
  /**
   * Whether documents may leave the platform — export, download, print.
   *
   * The trial is the whole product minus the thing you would take to a client.
   * Everything governs, records and computes; nothing gets out. That is the
   * commercial line, and it is here rather than in the exporter so there is one
   * place to read what a package includes.
   */
  export: boolean;
};

export const PACKAGES: Record<PackageTier, PackageDefinition> = {
  FREE_TRIAL: {
    package: 'FREE_TRIAL',
    label: 'Trial',
    targetCustomer: 'Evaluation',
    includedSeats: 3,
    monthlyPriceMinor: 0,
    storageGb: 5,
    isolatedTenancy: false,
    apiAccess: false,
    export: false,
  },
  CORE_PROJECT: {
    package: 'CORE_PROJECT',
    label: 'Core Project',
    targetCustomer: 'SME contractors and pilot projects',
    includedSeats: 10,
    monthlyPriceMinor: 95_000,
    storageGb: 100,
    isolatedTenancy: false,
    apiAccess: false,
    export: true,
  },
  PROFESSIONAL_DELIVERY: {
    package: 'PROFESSIONAL_DELIVERY',
    label: 'Professional Delivery',
    targetCustomer: 'Active contractors running multiple packages',
    includedSeats: 25,
    monthlyPriceMinor: 220_000,
    storageGb: 500,
    isolatedTenancy: false,
    apiAccess: true,
    export: true,
  },
  ENTERPRISE: {
    package: 'ENTERPRISE',
    label: 'Enterprise',
    targetCustomer: 'Tier 1 and multi-portfolio contractors',
    includedSeats: null,
    monthlyPriceMinor: 650_000,
    // 20 live projects — 12 mid and 8 major — is about 2,685 GB in year one for
    // a division or region, and 2,685 / 0.7 is 3,836.
    storageGb: 4_000,
    isolatedTenancy: true,
    apiAccess: true,
    export: true,
  },
};

/**
 * Prepaid ACU bundles. AI is never included in a package — the bundle is a
 * separate purchase, and the usable figure is what remains after the markup
 * that funds the platform's own provider spend.
 */
export type BundleName = 'STARTER' | 'GROWTH' | 'SCALE';

export type BundleDefinition = {
  bundle: BundleName;
  priceMinor: number;
  /**
   * ACUs the bundle yields at the headline multiplier, **derived** from the
   * price rather than stated.
   *
   * It was a hardcoded figure and it had gone stale: the three bundles
   * advertised 10,000 / 40,000 / 110,000 ACUs, which are the numbers a 3×
   * markup produces. The platform charges at 4×, so £300 buys 7,500 ACUs and
   * the published figure overstated every bundle by a third.
   *
   * No money was misposted — a top-up credits the price and spend is billed at
   * the effective multiplier, so this figure only ever appeared on the pricing
   * catalogue. That is precisely what made it worth fixing: it is a promise to
   * a customer that the billing engine was never going to keep, and the
   * customer would find out when the bundle ran out a third early.
   *
   * Deriving it means the multiplier decides both what is charged and what a
   * bundle is worth, so the two cannot disagree again. A volume incentive can
   * only make a bundle go **further** than this, never less far, so the figure
   * is a floor and is described as one.
   */
  usableAcus: number;
  /** The markup this bundle buys ACUs at. Lower is a bigger discount. */
  multiplier: number;
};

/**
 * The price of each bundle. What it buys is computed from the headline
 * multiplier — **4×, flat, for every bundle**.
 *
 * Two earlier versions of this were wrong in opposite directions and both are
 * worth recording.
 *
 * The original hardcoded 10,000 / 40,000 / 110,000 ACUs. Those are the numbers
 * a 3× markup produces, and they had gone stale when the multiplier moved to
 * 4×: the catalogue promised a third more than the billing engine would ever
 * deliver. No money was misposted — a top-up credits the price and spend is
 * billed at the effective multiplier, so the figure only ever appeared on the
 * pricing page — but it was a promise to a customer that could not be kept.
 *
 * The second version derived the yield from `VOLUME_BANDS`, which then stepped
 * down to 3.6 and 3.3 so a larger bundle stayed better value. That
 * reintroduced the sub-4× rates the pricing decision exists to rule out; the
 * bands are now flat at 4× too.
 *
 * The rate is 4×. A consequence follows and is stated rather than hidden: with
 * a flat multiplier every bundle yields exactly the same ACUs per pound, so a
 * bundle is a convenience — fewer transactions, one purchase order — and not a
 * discount. Nothing in the product should imply otherwise.
 */
const BUNDLE_PRICES: Record<BundleName, number> = {
  STARTER: 30_000,
  GROWTH: 100_000,
  SCALE: 250_000,
};

export const ACU_BUNDLES: Record<BundleName, BundleDefinition> = Object.fromEntries(
  (Object.keys(BUNDLE_PRICES) as BundleName[]).map((bundle) => {
    // Never below the profit floor, so an edit to the multiplier cannot sell AI
    // at a loss through this path.
    const multiplier = Math.max(config.billing.markupMultiplier, minimumMultiplier());
    return [
      bundle,
      {
        bundle,
        priceMinor: BUNDLE_PRICES[bundle],
        multiplier,
        // Floor down: a bundle advertising one ACU more than it delivers is the
        // same defect in miniature.
        usableAcus: Math.floor(BUNDLE_PRICES[bundle] / multiplier),
      },
    ];
  }),
) as Record<BundleName, BundleDefinition>;

/**
 * Roles that never consume a paid seat: the platform operator is not a customer
 * identity, and regulator access is granted by the asset owner as an obligation
 * of the Building Safety regime, not sold to the regulator.
 */
export const UNCHARGED_ROLES: Role[] = ['PLATFORM_ADMIN', 'REGULATOR'];

/** The seat a role is priced at. Unmapped roles carry no seat cost. */
export function seatForRole(role: Role): SeatDefinition | undefined {
  return Object.values(SEATS).find((seat) => seat.roles.includes(role));
}

/**
 * What a tenant's seats would cost bought individually. This is not what they
 * are charged — the package is — but an enterprise admin deciding whether to
 * move package needs both numbers side by side.
 */
export function seatValueMinor(roles: Role[][]): number {
  return roles.reduce((sum, held) => {
    const seat = held.map(seatForRole).find(Boolean);
    return sum + (seat?.monthlyPriceMinor ?? 0);
  }, 0);
}
