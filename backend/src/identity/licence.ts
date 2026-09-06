import { PERMISSION_MATRIX, type CapabilityArea, type PermissionCode, type Role } from './roles.ts';

/**
 * Who consumes a paid seat, and where the licence for it comes from.
 *
 * Until this existed the platform answered "does this person cost a seat"
 * with "is this person an identity in the tenancy" — every identity took one
 * of the package's seats, and an invitation onto a project created an
 * identity in the host's tenancy. So a quantity surveyor whose own company
 * already paid for her seat took a second one the moment a main contractor
 * invited her onto a job, and a third when the next contractor did. The
 * commercial rule this module holds is the one that replaces that:
 *
 *   One person, one home organisation, one Controller seat — however many
 *   projects they are invited onto, and by however many organisations.
 *
 * Three things are told apart here that were one thing before:
 *
 * **Access class.** Whether the roles held carry Controller-level authority
 * or participant-level authority. Derived from the permission matrix, which is
 * the one document the platform enforces, rather than from a second list of
 * roles that would drift from it. A Controller approves money, baselines,
 * contracts or the business's own structure, administers people, or runs the
 * platform; a participant does the work inside a project — records, submits,
 * inspects, designs, supplies — and never takes a seat.
 *
 * **Licence source.** Where a Controller's seat comes from: their home
 * organisation's package, the group's, a pass the host bought for the one
 * project, or nowhere yet. Separate from the access class by construction: a
 * person is a Controller *in the host project* while licensed *by their own
 * company*, and the two facts must never be collapsed into one flag.
 *
 * **Host billability.** Whether the host pays anything for this person. Only
 * two things ever make that true: the person is the host's own Controller on
 * the host's own package, or the host bought a pass. Being invited is never
 * one of them.
 */

export const ACCESS_CLASSES = ['PARTICIPANT', 'CONTROLLER'] as const;
export type AccessClass = (typeof ACCESS_CLASSES)[number];

export const ORGANISATION_RELATIONSHIPS = ['HOME_MEMBER', 'GROUP_MEMBER', 'EXTERNAL_INVITEE'] as const;
export type OrganisationRelationship = (typeof ORGANISATION_RELATIONSHIPS)[number];

export const LICENCE_SOURCES = ['HOME_ORGANISATION', 'GROUP_ENTERPRISE', 'HOST_SPONSORED_PASS', 'NONE'] as const;
export type LicenceSource = (typeof LICENCE_SOURCES)[number];

/**
 * Who pays for an external person's AI. `PROJECT_WALLET` and
 * `CLIENT_FUNDED_ALLOWANCE` are named by the requirement and deliberately not
 * offered: no project wallet exists on this platform — every wallet belongs
 * to a tenancy — and offering a sponsor type nothing can fund would be a
 * setting that does nothing. Recorded in STATE under what is not built.
 */
export const ACU_SPONSOR_TYPES = ['HOME_ORGANISATION', 'HOST_ORGANISATION', 'ONE_TIME_AUTHORISATION'] as const;
export type AcuSponsorType = (typeof ACU_SPONSOR_TYPES)[number];

export const MEMBERSHIP_STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'REVOKED'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/**
 * The Controller-level permissions the requirement names, and what each one
 * is on this platform's permission matrix.
 *
 * Published so the console can show *why* a role is a Controller rather than
 * asserting it. Several of the named permissions have no matrix entry of
 * their own — workflow templates, integrations, agent authoring, unrestricted
 * export — because the platform has no separate permission for them: they
 * are held by the same roles that hold the ones that are mapped, and the
 * `basis` says so rather than inventing a matrix entry to point at.
 */
export type ControllerPermission = {
  permission: string;
  basis: { area: CapabilityArea | 'ANY'; codes: PermissionCode[] } | null;
  note: string;
};

export const CONTROLLER_PERMISSIONS: readonly ControllerPermission[] = [
  { permission: 'SYSTEM_ADMINISTRATOR', basis: { area: 'PLATFORM_ADMINISTRATION', codes: ['R', 'C', 'U', 'A', 'G'] }, note: 'The platform operator layer' },
  { permission: 'USER_ADMINISTER', basis: { area: 'ANY', codes: ['G'] }, note: 'Governance of people and policy anywhere' },
  { permission: 'PERMISSION_ADMINISTER', basis: { area: 'ANY', codes: ['G'] }, note: 'The same governance code: roles are permissions' },
  { permission: 'ORGANISATION_SETTINGS_CHANGE', basis: { area: 'ENTERPRISE_STRUCTURE', codes: ['C', 'U', 'A'] }, note: 'Changing the enterprise, portfolios and programmes' },
  { permission: 'PROJECT_CREATE', basis: { area: 'PROJECT_SETUP', codes: ['C'] }, note: 'Creating a project' },
  { permission: 'PROJECT_DELETE', basis: { area: 'PROJECT_SETUP', codes: ['A'] }, note: 'Approving a project’s setup, gate and deletion' },
  { permission: 'ACU_BUDGET_CONTROL', basis: { area: 'BILLING_ACU', codes: ['U', 'A'] }, note: 'Setting caps, buying credit and seats' },
  { permission: 'CONTRACT_APPROVE', basis: { area: 'CONTRACTS_CLAIMS', codes: ['A'] }, note: 'Approving a contract, claim or notice' },
  { permission: 'CONTRACT_APPROVE', basis: { area: 'PROCUREMENT_AWARD', codes: ['A'] }, note: 'Approving an award' },
  { permission: 'PAYMENT_APPROVE', basis: { area: 'PAYMENT_APPLICATIONS', codes: ['A'] }, note: 'Certifying a payment' },
  { permission: 'BASELINE_APPROVE', basis: { area: 'PROGRAMME_BASELINES', codes: ['A'] }, note: 'Approving a programme baseline' },
  { permission: 'BASELINE_APPROVE', basis: { area: 'BUDGET_COST', codes: ['A'] }, note: 'Approving a budget baseline' },
  { permission: 'BASELINE_APPROVE', basis: { area: 'CHANGE_VARIATION', codes: ['A'] }, note: 'Approving a change to the baseline' },
  { permission: 'ORGANISATION_COMMERCIAL_VIEW', basis: { area: 'ESTIMATE_TENDER', codes: ['A'] }, note: 'Signing off the tender price' },
  { permission: 'PORTFOLIO_INTELLIGENCE_VIEW', basis: { area: 'BUSINESS_DEVELOPMENT', codes: ['A'] }, note: 'Deciding what the business bids for' },
  { permission: 'MULTI_PROJECT_DEFAULT_ACCESS', basis: null, note: 'Held by the enterprise and executive roles through ENTERPRISE_STRUCTURE; no separate matrix entry' },
  { permission: 'WORKFLOW_CONFIGURE', basis: null, note: 'Workflow templates are the engines’ own; no separate matrix entry' },
  { permission: 'AI_AGENT_CREATE', basis: null, note: 'Agents are declared in code, never authored from the console; no matrix entry' },
  { permission: 'AI_AGENT_MODIFY', basis: null, note: 'As AI_AGENT_CREATE' },
  { permission: 'AI_ADVANCED_UNRESTRICTED_EXECUTE', basis: null, note: 'Every AI execution is metered and capped; there is no unrestricted mode' },
  { permission: 'INTEGRATION_CONFIGURE', basis: null, note: 'API keys and webhooks are administered through ENTERPRISE_STRUCTURE governance' },
  { permission: 'TENANT_DATA_UNRESTRICTED_EXPORT', basis: null, note: 'Export is per record and audience-redacted; the tenancy export is an administrator’s act' },
];

/** The matrix tests that make a role a Controller, from the table above. */
const CONTROLLER_BASES = CONTROLLER_PERMISSIONS.map((entry) => entry.basis).filter((basis): basis is NonNullable<ControllerPermission['basis']> => basis !== null);

/** Does one role hold Controller-level authority anywhere on the matrix? */
export function isControllerRole(role: Role): boolean {
  const row = PERMISSION_MATRIX[role] ?? {};
  return CONTROLLER_BASES.some((basis) => {
    const areas = basis.area === 'ANY' ? (Object.keys(row) as CapabilityArea[]) : [basis.area];
    return areas.some((area) => (row[area] ?? []).some((code) => basis.codes.includes(code)));
  });
}

/**
 * The access class a set of roles carries: Controller if any role is one.
 *
 * No roles at all is a participant — a person who holds no authority costs
 * nothing, and the seat rule turns on authority.
 */
export function accessClassOf(roles: readonly Role[]): AccessClass {
  return roles.some(isControllerRole) ? 'CONTROLLER' : 'PARTICIPANT';
}

/** The roles of a set that are Controller-level, for saying which ones need the licence. */
export function controllerRolesOf(roles: readonly Role[]): Role[] {
  return roles.filter(isControllerRole);
}

// --- resolution ---------------------------------------------------------------

export type SeatResolutionInput = {
  accessClass: AccessClass;
  hasValidHomeControllerSeat: boolean;
  hasValidGroupControllerSeat: boolean;
  hasValidHostProjectPass: boolean;
};

export type SeatResolutionReason =
  | 'PARTICIPANT_SEAT_NOT_REQUIRED'
  | 'HOME_CONTROLLER_SEAT_VERIFIED'
  | 'GROUP_CONTROLLER_SEAT_VERIFIED'
  | 'HOST_PROJECT_PASS_VERIFIED'
  | 'CONTROLLER_LICENCE_REQUIRED';

export type SeatResolutionResult = {
  controllerAccessAllowed: boolean;
  licenceSource: LicenceSource;
  hostBillableSeat: boolean;
  reasonCode: SeatResolutionReason;
};

/**
 * The resolution order the requirement fixes: home seat, then group seat,
 * then a host pass, then nothing. Pure, so it is testable on its own and so
 * the prohibited shortcut — `hostBillableSeat = hasControllerPermission` —
 * cannot creep back in through a caller.
 */
export function resolveControllerLicence(input: SeatResolutionInput): SeatResolutionResult {
  if (input.accessClass === 'PARTICIPANT') {
    return { controllerAccessAllowed: false, licenceSource: 'NONE', hostBillableSeat: false, reasonCode: 'PARTICIPANT_SEAT_NOT_REQUIRED' };
  }
  if (input.hasValidHomeControllerSeat) {
    return { controllerAccessAllowed: true, licenceSource: 'HOME_ORGANISATION', hostBillableSeat: false, reasonCode: 'HOME_CONTROLLER_SEAT_VERIFIED' };
  }
  if (input.hasValidGroupControllerSeat) {
    return { controllerAccessAllowed: true, licenceSource: 'GROUP_ENTERPRISE', hostBillableSeat: false, reasonCode: 'GROUP_CONTROLLER_SEAT_VERIFIED' };
  }
  if (input.hasValidHostProjectPass) {
    return { controllerAccessAllowed: true, licenceSource: 'HOST_SPONSORED_PASS', hostBillableSeat: true, reasonCode: 'HOST_PROJECT_PASS_VERIFIED' };
  }
  return { controllerAccessAllowed: false, licenceSource: 'NONE', hostBillableSeat: false, reasonCode: 'CONTROLLER_LICENCE_REQUIRED' };
}

// --- the badge -----------------------------------------------------------------

/**
 * The seat badge the console shows, as the requirement words it. One status
 * per membership, derived rather than stored, so the screen and the record
 * cannot disagree.
 */
export type LicenceBadge =
  | 'PARTICIPANT_NO_SEAT'
  | 'CONTROLLER_HOST_SEAT'
  | 'CONTROLLER_HOME_LICENSED'
  | 'CONTROLLER_GROUP_LICENSED'
  | 'CONTROLLER_HOST_SPONSORED'
  | 'CONTROLLER_LICENCE_REQUIRED'
  | 'CONTROLLER_LICENCE_EXPIRED';

export const LICENCE_BADGE_LABELS: Record<LicenceBadge, string> = {
  PARTICIPANT_NO_SEAT: 'Participant — No Seat Required',
  CONTROLLER_HOST_SEAT: 'Controller — Host Seat',
  CONTROLLER_HOME_LICENSED: 'Controller — Home Licensed',
  CONTROLLER_GROUP_LICENSED: 'Controller — Group Licensed',
  CONTROLLER_HOST_SPONSORED: 'Controller — Host Sponsored',
  CONTROLLER_LICENCE_REQUIRED: 'Controller — Licence Required',
  CONTROLLER_LICENCE_EXPIRED: 'Controller — Licence Expired',
};

export function licenceBadge(input: {
  accessClass: AccessClass;
  relationship: OrganisationRelationship;
  licenceSource: LicenceSource;
  /** True once a licence that was valid has stopped being so. */
  lapsed?: boolean;
}): LicenceBadge {
  if (input.accessClass === 'PARTICIPANT') return 'PARTICIPANT_NO_SEAT';
  if (input.lapsed) return 'CONTROLLER_LICENCE_EXPIRED';
  if (input.licenceSource === 'HOME_ORGANISATION') return input.relationship === 'HOME_MEMBER' ? 'CONTROLLER_HOST_SEAT' : 'CONTROLLER_HOME_LICENSED';
  if (input.licenceSource === 'GROUP_ENTERPRISE') return 'CONTROLLER_GROUP_LICENSED';
  if (input.licenceSource === 'HOST_SPONSORED_PASS') return 'CONTROLLER_HOST_SPONSORED';
  return 'CONTROLLER_LICENCE_REQUIRED';
}
