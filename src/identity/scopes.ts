import type { CapabilityArea, PermissionCode, Role } from './roles.ts';
import { rolePermissions } from './roles.ts';

/**
 * OAuth2-style capability scopes. Scopes are the coarse gate at the gateway;
 * the permission matrix is the fine-grained one inside the domain. A request
 * must satisfy both.
 */

export type Scope =
  | 'projects:read'
  | 'projects:write'
  | 'design:read'
  | 'design:write'
  | 'programme:read'
  | 'programme:write'
  | 'commercial:read'
  | 'commercial:write'
  | 'procurement:read'
  | 'procurement:write'
  | 'contracts:read'
  | 'contracts:write'
  | 'claims:write'
  | 'risk:read'
  | 'risk:write'
  | 'safety:read'
  | 'safety:write'
  | 'field:read'
  | 'field:write'
  | 'bim:read'
  | 'bim:write'
  | 'handover:read'
  | 'handover:write'
  | 'audit:read'
  | 'ai:execute'
  | 'billing:read'
  | 'billing:write'
  | 'media:upload'
  | 'media:read'
  | 'admin:*';

/** Which scope pair guards each capability area. */
const AREA_SCOPES: Record<CapabilityArea, { read: Scope; write: Scope }> = {
  PLATFORM_ADMINISTRATION: { read: 'admin:*', write: 'admin:*' },
  ENTERPRISE_STRUCTURE: { read: 'projects:read', write: 'projects:write' },
  PROJECT_SETUP: { read: 'projects:read', write: 'projects:write' },
  DESIGN_INFORMATION: { read: 'design:read', write: 'design:write' },
  WORKPACKAGES_TASKS: { read: 'programme:read', write: 'programme:write' },
  PROGRAMME_BASELINES: { read: 'programme:read', write: 'programme:write' },
  LOOKAHEAD_CONSTRAINTS: { read: 'programme:read', write: 'programme:write' },
  BOQ_TAKEOFF: { read: 'commercial:read', write: 'commercial:write' },
  ESTIMATE_TENDER: { read: 'commercial:read', write: 'commercial:write' },
  PROCUREMENT_AWARD: { read: 'procurement:read', write: 'procurement:write' },
  SUPPLIER_SUBMISSION: { read: 'procurement:read', write: 'procurement:write' },
  BUDGET_COST: { read: 'commercial:read', write: 'commercial:write' },
  PAYMENT_APPLICATIONS: { read: 'commercial:read', write: 'commercial:write' },
  CHANGE_VARIATION: { read: 'contracts:read', write: 'contracts:write' },
  CONTRACTS_CLAIMS: { read: 'contracts:read', write: 'claims:write' },
  RISK_REGISTER: { read: 'risk:read', write: 'risk:write' },
  SAFETY_RAMS: { read: 'safety:read', write: 'safety:write' },
  FIELD_EXECUTION: { read: 'field:read', write: 'field:write' },
  QUALITY_COMMISSIONING: { read: 'field:read', write: 'field:write' },
  BIM_TWIN: { read: 'bim:read', write: 'bim:write' },
  HANDOVER_OM: { read: 'handover:read', write: 'handover:write' },
  EVIDENCE_AUDIT: { read: 'audit:read', write: 'audit:read' },
  AI_EXECUTION: { read: 'ai:execute', write: 'ai:execute' },
  BILLING_ACU: { read: 'billing:read', write: 'billing:write' },
};

const WRITE_CODES = new Set<PermissionCode>(['C', 'U', 'A', 'I', 'G']);

export function requiredScope(area: CapabilityArea, code: PermissionCode): Scope {
  const pair = AREA_SCOPES[area];
  if (code === 'X') return 'ai:execute';
  return WRITE_CODES.has(code) ? pair.write : pair.read;
}

/** Derive the default scope set a role should be issued at login. */
export function scopesForRoles(roles: Role[]): Scope[] {
  const scopes = new Set<Scope>();
  for (const role of roles) {
    for (const area of Object.keys(AREA_SCOPES) as CapabilityArea[]) {
      for (const code of rolePermissions(role, area)) {
        scopes.add(requiredScope(area, code));
      }
    }
  }
  return [...scopes].sort();
}

export function scopesAllow(held: string[], required: Scope): boolean {
  if (held.includes('admin:*')) return true;
  return held.includes(required);
}
