/**
 * Roles, permission codes and the enforceable permission matrix.
 *
 * Three account layers exist and must never blur — this separation is what
 * stops the navigation and permission loops the platform review called out:
 *
 *   PLATFORM_ADMIN    system operator: creates tenants, onboards enterprises,
 *                     manages billing and global engine config. Must NOT see
 *                     projects, packages, daily logs or portfolio operations.
 *   ENTERPRISE_ADMIN  customer org admin: creates users, portfolios,
 *                     programmes, projects, packages; assigns roles; views
 *                     Enterprise -> Portfolio -> Project dashboards.
 *   TENANT_USER       delivery team: works daily on projects. Never sees
 *                     platform-level controls.
 */

import { DomainError } from '../core/errors.ts';

export type AccountLayer = 'PLATFORM_ADMIN' | 'ENTERPRISE_ADMIN' | 'TENANT_USER';

export type Role =
  | 'PLATFORM_ADMIN'
  | 'ENTERPRISE_ADMIN'
  | 'OWNER'
  | 'EPC'
  | 'QS'
  | 'PM'
  | 'PLANNER'
  | 'SAFETY'
  | 'QAQC'
  | 'DESIGNER'
  | 'BIM'
  | 'SUPERVISOR'
  | 'FM'
  | 'SUPPLIER'
  | 'REGULATOR';

/** Permission codes, per the platform permission matrix. */
export type PermissionCode =
  | 'R' // Read
  | 'C' // Create
  | 'U' // Update
  | 'A' // Approve / Freeze / Execute
  | 'I' // Import / Export
  | 'X' // Run AI (ACU consuming)
  | 'G'; // Governance (users / policies)

export type CapabilityArea =
  | 'PLATFORM_ADMINISTRATION'
  | 'BUSINESS_DEVELOPMENT'
  | 'ENTERPRISE_STRUCTURE'
  | 'PROJECT_SETUP'
  | 'DESIGN_INFORMATION'
  | 'WORKPACKAGES_TASKS'
  | 'PROGRAMME_BASELINES'
  | 'LOOKAHEAD_CONSTRAINTS'
  | 'BOQ_TAKEOFF'
  | 'ESTIMATE_TENDER'
  | 'PROCUREMENT_AWARD'
  | 'SUPPLIER_SUBMISSION'
  | 'BUDGET_COST'
  | 'PAYMENT_APPLICATIONS'
  | 'CHANGE_VARIATION'
  | 'CONTRACTS_CLAIMS'
  | 'RISK_REGISTER'
  | 'SAFETY_RAMS'
  | 'FIELD_EXECUTION'
  | 'QUALITY_COMMISSIONING'
  | 'BIM_TWIN'
  | 'HANDOVER_OM'
  | 'EVIDENCE_AUDIT'
  | 'AI_EXECUTION'
  | 'BILLING_ACU';

export const ROLE_ACCOUNT_LAYER: Record<Role, AccountLayer> = {
  PLATFORM_ADMIN: 'PLATFORM_ADMIN',
  ENTERPRISE_ADMIN: 'ENTERPRISE_ADMIN',
  OWNER: 'TENANT_USER',
  EPC: 'TENANT_USER',
  QS: 'TENANT_USER',
  PM: 'TENANT_USER',
  PLANNER: 'TENANT_USER',
  SAFETY: 'TENANT_USER',
  QAQC: 'TENANT_USER',
  DESIGNER: 'TENANT_USER',
  BIM: 'TENANT_USER',
  SUPERVISOR: 'TENANT_USER',
  FM: 'TENANT_USER',
  SUPPLIER: 'TENANT_USER',
  REGULATOR: 'TENANT_USER',
};

/**
 * The roles a tenant administrator may grant.
 *
 * Everything except the two that are not theirs to give.
 *
 * `POST /v1/users` and `POST /v1/users/:id/roles` took `roles` as an array of
 * unconstrained strings and passed them through. An enterprise admin could
 * therefore create a `PLATFORM_ADMIN` identity, sign in as it, and hold the
 * whole operator surface: crediting wallets — their own — with unlimited money,
 * suspending and reactivating subscriptions, reading the estate. Every gate on
 * the money model was defeated by one request from an ordinary customer
 * account.
 *
 * `REGULATOR` is excluded for a smaller but real reason: it is an uncharged
 * seat. `assignIdentity` skips the seat cap for it, so a tenant on ten seats
 * could staff a hundred people as regulators and pay for none of them — and a
 * regulator's export bypasses the subscription gate on purpose, because that
 * access is statutory. Both are correct for an actual regulator and neither is
 * something a customer should be able to hand out to their own staff.
 *
 * An external regulator is invited by the operator, which is where the
 * relationship is actually established.
 */
export const OPERATOR_ONLY_ROLES: Role[] = ['PLATFORM_ADMIN', 'REGULATOR'];

export const ALL_ROLES: Role[] = Object.keys(ROLE_ACCOUNT_LAYER) as Role[];

export const TENANT_GRANTABLE_ROLES: Role[] = ALL_ROLES.filter((role) => !OPERATOR_ONLY_ROLES.includes(role));

/** Whether a string is a role at all. The route schemas take unconstrained arrays. */
export function isRole(value: string): value is Role {
  return (ALL_ROLES as string[]).includes(value);
}

/**
 * Check a set of roles a tenant administrator is trying to grant.
 *
 * Two failures, and they are told apart deliberately: a typo is a mistake and a
 * privilege escalation is not, and the operator's audit stream should be able
 * to see the difference.
 */
export function assertTenantGrantable(roles: readonly string[]): Role[] {
  const unknown = roles.filter((role) => !isRole(role));
  if (unknown.length > 0) {
    throw new DomainError('ROLE_UNKNOWN', `Not a role: ${unknown.join(', ')}`);
  }

  const forbidden = roles.filter((role) => OPERATOR_ONLY_ROLES.includes(role as Role));
  if (forbidden.length > 0) {
    throw new DomainError(
      'ROLE_NOT_GRANTABLE',
      `${forbidden.join(' and ')} cannot be granted from inside a tenancy. ` +
        'The platform operator holds the operator role, and a regulator is invited by them.',
      403,
    );
  }

  return roles as Role[];
}

type Matrix = Partial<Record<CapabilityArea, PermissionCode[]>>;

/**
 * The minimum enforceable model. Absent entry = no access at all.
 * Read this as: "what can this role do in this capability area".
 */
export const PERMISSION_MATRIX: Record<Role, Matrix> = {
  // Platform operator: billing and tenancy only. Deliberately blind to delivery.
  PLATFORM_ADMIN: {
    PLATFORM_ADMINISTRATION: ['R', 'C', 'U', 'A', 'G'],
    BILLING_ACU: ['R', 'C', 'U', 'A'],
    EVIDENCE_AUDIT: ['R'],
  },

  ENTERPRISE_ADMIN: {
    BUSINESS_DEVELOPMENT: ['R', 'C', 'U', 'A'],
    ENTERPRISE_STRUCTURE: ['R', 'C', 'U', 'A', 'G'],
    PROJECT_SETUP: ['R', 'C', 'U', 'A'],
    DESIGN_INFORMATION: ['R'],
    WORKPACKAGES_TASKS: ['R'],
    PROGRAMME_BASELINES: ['R'],
    BOQ_TAKEOFF: ['R'],
    ESTIMATE_TENDER: ['R'],
    PROCUREMENT_AWARD: ['R', 'A'],
    BUDGET_COST: ['R', 'A'],
    PAYMENT_APPLICATIONS: ['R'],
    CHANGE_VARIATION: ['R'],
    CONTRACTS_CLAIMS: ['R'],
    RISK_REGISTER: ['R'],
    SAFETY_RAMS: ['R'],
    QUALITY_COMMISSIONING: ['R'],
    BIM_TWIN: ['R'],
    HANDOVER_OM: ['R'],
    EVIDENCE_AUDIT: ['R', 'I'],
    AI_EXECUTION: ['R', 'X'],
    BILLING_ACU: ['R', 'U'],
  },

  OWNER: {
    BUSINESS_DEVELOPMENT: ['R', 'C', 'U', 'A'],
    PROJECT_SETUP: ['R', 'A'],
    DESIGN_INFORMATION: ['R'],
    WORKPACKAGES_TASKS: ['R'],
    PROGRAMME_BASELINES: ['R', 'A'],
    LOOKAHEAD_CONSTRAINTS: ['R'],
    BOQ_TAKEOFF: ['R'],
    ESTIMATE_TENDER: ['R', 'A'],
    PROCUREMENT_AWARD: ['R', 'A'],
    BUDGET_COST: ['R', 'A'],
    PAYMENT_APPLICATIONS: ['R', 'A'],
    CHANGE_VARIATION: ['R', 'A'],
    CONTRACTS_CLAIMS: ['R', 'A'],
    RISK_REGISTER: ['R'],
    SAFETY_RAMS: ['R'],
    QUALITY_COMMISSIONING: ['R'],
    BIM_TWIN: ['R'],
    HANDOVER_OM: ['R', 'A'],
    EVIDENCE_AUDIT: ['R', 'I'],
    AI_EXECUTION: ['R', 'X'],
    BILLING_ACU: ['R', 'U'],
  },

  EPC: {
    BUSINESS_DEVELOPMENT: ['R', 'C', 'U', 'A'],
    PROJECT_SETUP: ['R'],
    DESIGN_INFORMATION: ['R', 'C', 'U', 'I'],
    WORKPACKAGES_TASKS: ['R', 'C', 'U'],
    PROGRAMME_BASELINES: ['R', 'U'],
    LOOKAHEAD_CONSTRAINTS: ['R', 'C', 'U'],
    BOQ_TAKEOFF: ['R'],
    ESTIMATE_TENDER: ['R'],
    PROCUREMENT_AWARD: ['R', 'C', 'U'],
    BUDGET_COST: ['R'],
    PAYMENT_APPLICATIONS: ['R', 'C', 'U'],
    CHANGE_VARIATION: ['R', 'C', 'U'],
    CONTRACTS_CLAIMS: ['R', 'C', 'U'],
    RISK_REGISTER: ['R', 'C', 'U'],
    SAFETY_RAMS: ['R', 'C', 'U'],
    FIELD_EXECUTION: ['R', 'C', 'U'],
    QUALITY_COMMISSIONING: ['R', 'C', 'U'],
    BIM_TWIN: ['R', 'I'],
    HANDOVER_OM: ['R', 'C', 'U'],
    EVIDENCE_AUDIT: ['R', 'I'],
    AI_EXECUTION: ['R', 'X'],
    BILLING_ACU: ['R'],
  },

  // QS authors commercial documents but must not approve the budget baseline
  // they authored — separation of duties is enforced, not advisory.
  QS: {
    BUSINESS_DEVELOPMENT: ['R', 'C', 'U'],
    PROJECT_SETUP: ['R'],
    DESIGN_INFORMATION: ['R'],
    WORKPACKAGES_TASKS: ['R'],
    PROGRAMME_BASELINES: ['R'],
    BOQ_TAKEOFF: ['R', 'C', 'U', 'A', 'X'],
    ESTIMATE_TENDER: ['R', 'C', 'U', 'A', 'X'],
    // Issues enquiries and runs evaluations, but award approval sits with the
    // PM, Owner or Enterprise Admin — the QS never awards its own evaluation.
    PROCUREMENT_AWARD: ['R', 'C', 'U', 'I', 'X'],
    // Authors cost reports and runs the CVR, but cannot approve the baseline.
    BUDGET_COST: ['R', 'C', 'U', 'X'],
    PAYMENT_APPLICATIONS: ['R', 'C', 'U', 'X'],
    CHANGE_VARIATION: ['R', 'C', 'U', 'X'],
    // Exports claim and evidence packs — the QS is the role that assembles them.
    CONTRACTS_CLAIMS: ['R', 'C', 'U', 'I', 'X'],
    RISK_REGISTER: ['R', 'C', 'U'],
    EVIDENCE_AUDIT: ['R', 'I'],
    AI_EXECUTION: ['R', 'X'],
    BILLING_ACU: ['R'],
  },

  PM: {
    BUSINESS_DEVELOPMENT: ['R'],
    PROJECT_SETUP: ['R', 'U'],
    DESIGN_INFORMATION: ['R', 'C', 'U'],
    WORKPACKAGES_TASKS: ['R', 'C', 'U', 'A'],
    PROGRAMME_BASELINES: ['R', 'A', 'X'],
    LOOKAHEAD_CONSTRAINTS: ['R', 'A'],
    BOQ_TAKEOFF: ['R'],
    ESTIMATE_TENDER: ['R'],
    // Approves the adjudication and the award the QS prepared — author and
    // approver are never the same person.
    PROCUREMENT_AWARD: ['R', 'C', 'U', 'A'],
    BUDGET_COST: ['R'],
    PAYMENT_APPLICATIONS: ['R'],
    CHANGE_VARIATION: ['R', 'C', 'U', 'A', 'X'],
    CONTRACTS_CLAIMS: ['R', 'C', 'U'],
    RISK_REGISTER: ['R', 'C', 'U', 'A'],
    SAFETY_RAMS: ['R'],
    FIELD_EXECUTION: ['R', 'C', 'U', 'A'],
    QUALITY_COMMISSIONING: ['R', 'A'],
    BIM_TWIN: ['R'],
    HANDOVER_OM: ['R', 'C', 'U'],
    EVIDENCE_AUDIT: ['R', 'I'],
    AI_EXECUTION: ['R', 'X'],
    BILLING_ACU: ['R'],
  },

  PLANNER: {
    PROJECT_SETUP: ['R'],
    DESIGN_INFORMATION: ['R'],
    WORKPACKAGES_TASKS: ['R', 'C', 'U'],
    PROGRAMME_BASELINES: ['R', 'C', 'U', 'A', 'X'],
    LOOKAHEAD_CONSTRAINTS: ['R', 'C', 'U'],
    BOQ_TAKEOFF: ['R'],
    CHANGE_VARIATION: ['R'],
    CONTRACTS_CLAIMS: ['R'],
    RISK_REGISTER: ['R', 'C', 'U'],
    FIELD_EXECUTION: ['R'],
    BIM_TWIN: ['R'],
    EVIDENCE_AUDIT: ['R', 'I'],
    AI_EXECUTION: ['R', 'X'],
  },

  // Safety approves RAMS but has no line of sight into Legal-L4 contract content.
  SAFETY: {
    PROJECT_SETUP: ['R'],
    DESIGN_INFORMATION: ['R'],
    WORKPACKAGES_TASKS: ['R'],
    PROGRAMME_BASELINES: ['R'],
    LOOKAHEAD_CONSTRAINTS: ['R'],
    RISK_REGISTER: ['R', 'C', 'U', 'A'],
    SAFETY_RAMS: ['R', 'C', 'U', 'A', 'X'],
    FIELD_EXECUTION: ['R', 'C', 'U'],
    QUALITY_COMMISSIONING: ['R'],
    EVIDENCE_AUDIT: ['R', 'I'],
    AI_EXECUTION: ['R', 'X'],
  },

  QAQC: {
    PROJECT_SETUP: ['R'],
    DESIGN_INFORMATION: ['R'],
    WORKPACKAGES_TASKS: ['R'],
    FIELD_EXECUTION: ['R', 'C', 'U'],
    QUALITY_COMMISSIONING: ['R', 'C', 'U', 'A', 'X'],
    HANDOVER_OM: ['R', 'C', 'U'],
    RISK_REGISTER: ['R'],
    EVIDENCE_AUDIT: ['R', 'I'],
    AI_EXECUTION: ['R', 'X'],
  },

  DESIGNER: {
    PROJECT_SETUP: ['R'],
    DESIGN_INFORMATION: ['R', 'C', 'U', 'A', 'I', 'X'],
    WORKPACKAGES_TASKS: ['R'],
    BOQ_TAKEOFF: ['R'],
    BIM_TWIN: ['R', 'C', 'U', 'I'],
    RISK_REGISTER: ['R'],
    EVIDENCE_AUDIT: ['R'],
    AI_EXECUTION: ['R', 'X'],
  },

  BIM: {
    PROJECT_SETUP: ['R'],
    // Registers drawings and raises markups; approval of design content stays
    // with the designer.
    DESIGN_INFORMATION: ['R', 'C', 'U', 'I'],
    BIM_TWIN: ['R', 'C', 'U', 'A', 'I', 'X'],
    WORKPACKAGES_TASKS: ['R'],
    BOQ_TAKEOFF: ['R', 'X'],
    HANDOVER_OM: ['R', 'C', 'U'],
    EVIDENCE_AUDIT: ['R', 'I'],
    AI_EXECUTION: ['R', 'X'],
  },

  SUPERVISOR: {
    PROJECT_SETUP: ['R'],
    DESIGN_INFORMATION: ['R'],
    WORKPACKAGES_TASKS: ['R', 'U'],
    LOOKAHEAD_CONSTRAINTS: ['R', 'C', 'U'],
    FIELD_EXECUTION: ['R', 'C', 'U'],
    SAFETY_RAMS: ['R', 'C', 'U'],
    QUALITY_COMMISSIONING: ['R', 'C', 'U'],
    RISK_REGISTER: ['R', 'C'],
    EVIDENCE_AUDIT: ['R'],
    AI_EXECUTION: ['R', 'X'],
  },

  // FM owns the asset after handover, and cannot reach back into tender baselines.
  FM: {
    PROJECT_SETUP: ['R'],
    HANDOVER_OM: ['R', 'C', 'U', 'A', 'I', 'X'],
    BIM_TWIN: ['R'],
    QUALITY_COMMISSIONING: ['R'],
    RISK_REGISTER: ['R', 'C', 'U'],
    SAFETY_RAMS: ['R'],
    EVIDENCE_AUDIT: ['R', 'I'],
    AI_EXECUTION: ['R', 'X'],
  },

  // Supplier sees only its own RFQ and its own submission (enforced by ABAC).
  SUPPLIER: {
    SUPPLIER_SUBMISSION: ['R', 'C', 'U'],
    DESIGN_INFORMATION: ['R'],
    EVIDENCE_AUDIT: ['R'],
  },

  // Regulator: read-only on approved/published data. No AI unless explicitly enabled.
  REGULATOR: {
    PROJECT_SETUP: ['R'],
    PROGRAMME_BASELINES: ['R'],
    RISK_REGISTER: ['R'],
    SAFETY_RAMS: ['R'],
    QUALITY_COMMISSIONING: ['R'],
    HANDOVER_OM: ['R'],
    BIM_TWIN: ['R'],
    EVIDENCE_AUDIT: ['R', 'I'],
  },
};

export function rolePermissions(role: Role, area: CapabilityArea): PermissionCode[] {
  return PERMISSION_MATRIX[role]?.[area] ?? [];
}

export function roleAllows(role: Role, area: CapabilityArea, code: PermissionCode): boolean {
  return rolePermissions(role, area).includes(code);
}

/** Any-of check across a user's roles. Explicit deny is handled by ABAC, not here. */
export function rolesAllow(roles: Role[], area: CapabilityArea, code: PermissionCode): boolean {
  return roles.some((role) => roleAllows(role, area, code));
}

export function accountLayerFor(roles: Role[]): AccountLayer {
  if (roles.includes('PLATFORM_ADMIN')) return 'PLATFORM_ADMIN';
  if (roles.includes('ENTERPRISE_ADMIN')) return 'ENTERPRISE_ADMIN';
  return 'TENANT_USER';
}
