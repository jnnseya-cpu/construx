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
  storageGb: number | null;
  isolatedTenancy: boolean;
  apiAccess: boolean;
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
  },
  ENTERPRISE: {
    package: 'ENTERPRISE',
    label: 'Enterprise',
    targetCustomer: 'Tier 1 and multi-portfolio contractors',
    includedSeats: null,
    monthlyPriceMinor: 650_000,
    storageGb: null,
    isolatedTenancy: true,
    apiAccess: true,
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
  /** Approximate ACUs the bundle yields once the markup is applied. */
  usableAcus: number;
};

export const ACU_BUNDLES: Record<BundleName, BundleDefinition> = {
  STARTER: { bundle: 'STARTER', priceMinor: 30_000, usableAcus: 10_000 },
  GROWTH: { bundle: 'GROWTH', priceMinor: 100_000, usableAcus: 40_000 },
  SCALE: { bundle: 'SCALE', priceMinor: 250_000, usableAcus: 110_000 },
};

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
