import { ForbiddenError } from '../core/errors.ts';
import type { LifecyclePhase } from '../lifecycle/phases.ts';
import type { AuthContext } from './auth.ts';
import type { CapabilityArea, PermissionCode, Role } from './roles.ts';
import { accountLayerFor, rolesAllow } from './roles.ts';
import { requiredScope, scopesAllow } from './scopes.ts';

/**
 * Attribute-based access control, evaluated after RBAC and scopes.
 *
 * Decision order is mandatory and fail-closed:
 *   1. Authenticate  2. RBAC  3. Scopes  4. ABAC  5. Final decision
 * Any missing required attribute, any evaluation error, and any explicit deny
 * results in a deny. Least privilege always wins.
 */

export type DataSensitivity = 'PUBLIC' | 'INTERNAL' | 'SAFETY_L2' | 'COMMERCIAL_L3' | 'LEGAL_L4';

export type AccessAttributes = {
  tenantId: string;
  projectId?: string;
  packageId?: string;
  lifecyclePhase?: LifecyclePhase;
  dataSensitivity?: DataSensitivity;
  /** Party the record belongs to — used to keep suppliers inside their own lane. */
  ownerPartyId?: string;
  /** True when the record has been approved/published (regulator visibility gate). */
  published?: boolean;
};

export type AccessDecision = {
  decision: 'ALLOW' | 'DENY' | 'REDACT';
  policyId: string;
  reason?: string;
};

/** Roles cleared for Legal-L4 (contract text, claims strategy, disputes). */
const LEGAL_L4_ROLES = new Set<Role>(['OWNER', 'EPC', 'QS', 'PM', 'ENTERPRISE_ADMIN']);
/** Roles cleared for Commercial-L3 (prices, margins, bid comparisons). */
const COMMERCIAL_L3_ROLES = new Set<Role>(['OWNER', 'EPC', 'QS', 'PM', 'ENTERPRISE_ADMIN']);

/**
 * Phases in which a capability area may be written. Writing a tender estimate
 * during O&M, or field progress before award, indicates a process error.
 */
const WRITE_PHASE_GATES: Partial<Record<CapabilityArea, LifecyclePhase[]>> = {
  BOQ_TAKEOFF: ['CONCEPT', 'DESIGN', 'TENDER'],
  ESTIMATE_TENDER: ['CONCEPT', 'DESIGN', 'TENDER'],
  PROCUREMENT_AWARD: ['TENDER', 'CONSTRUCTION'],
  FIELD_EXECUTION: ['CONSTRUCTION', 'COMMISSIONING'],
  QUALITY_COMMISSIONING: ['CONSTRUCTION', 'COMMISSIONING', 'HANDOVER'],
  HANDOVER_OM: ['COMMISSIONING', 'HANDOVER', 'OPERATIONS'],
};

const WRITE_CODES = new Set<PermissionCode>(['C', 'U', 'A', 'I', 'G']);

export function evaluateAccess(
  auth: AuthContext,
  area: CapabilityArea,
  code: PermissionCode,
  attributes: AccessAttributes,
  options: { rbacEnabled: boolean; scopesEnabled: boolean; abacEnabled: boolean },
): AccessDecision {
  const policyId = `policy:${area}:${code}`;

  // --- Missing mandatory attribute -> deny -----------------------------------
  if (!attributes.tenantId) {
    return { decision: 'DENY', policyId, reason: 'tenantId attribute missing' };
  }

  // --- Tenant isolation (always on, never optional) --------------------------
  if (auth.tenantId !== attributes.tenantId) {
    return { decision: 'DENY', policyId, reason: 'Cross-tenant access is never permitted' };
  }

  // --- RBAC ------------------------------------------------------------------
  if (options.rbacEnabled && !rolesAllow(auth.roles, area, code)) {
    return { decision: 'DENY', policyId, reason: `No role of ${auth.roles.join('/')} holds "${code}" on ${area}` };
  }

  // --- Scopes ----------------------------------------------------------------
  if (options.scopesEnabled) {
    const scope = requiredScope(area, code);
    if (!scopesAllow(auth.scopes, scope)) {
      return { decision: 'DENY', policyId, reason: `Token is missing scope "${scope}"` };
    }
  }

  if (!options.abacEnabled) return { decision: 'ALLOW', policyId };

  // --- Account-layer separation ---------------------------------------------
  const layer = accountLayerFor(auth.roles);
  if (layer === 'PLATFORM_ADMIN' && area !== 'PLATFORM_ADMINISTRATION' && area !== 'BILLING_ACU' && area !== 'EVIDENCE_AUDIT') {
    return {
      decision: 'DENY',
      policyId,
      reason: 'Platform operators are barred from customer delivery data',
    };
  }
  if (layer !== 'PLATFORM_ADMIN' && area === 'PLATFORM_ADMINISTRATION') {
    return { decision: 'DENY', policyId, reason: 'Platform administration is not visible to customer accounts' };
  }

  // --- Regulator restrictions ------------------------------------------------
  if (auth.roles.includes('REGULATOR')) {
    // Read-only means "may not change the record". Taking a Golden Thread
    // export is the one write code a regulator holds, and it is the entire
    // point of regulator access — refusing it here would contradict the
    // permission matrix, which grants EVIDENCE_AUDIT:I explicitly.
    if (WRITE_CODES.has(code) && code !== 'I') {
      return { decision: 'DENY', policyId, reason: 'Regulator access is read-only' };
    }
    if (code === 'X' && !auth.regulatorAiEnabled) {
      return { decision: 'DENY', policyId, reason: 'AI execution not enabled for this regulator by the asset owner' };
    }
    if (attributes.published === false) {
      return { decision: 'DENY', policyId, reason: 'Regulators see approved and published records only' };
    }
  }

  // --- Supplier confinement --------------------------------------------------
  if (auth.roles.includes('SUPPLIER') && auth.roles.length === 1) {
    if (attributes.ownerPartyId && attributes.ownerPartyId !== auth.partyId) {
      return { decision: 'DENY', policyId, reason: 'Suppliers may only access their own submissions' };
    }
    if (area !== 'SUPPLIER_SUBMISSION' && area !== 'DESIGN_INFORMATION' && area !== 'EVIDENCE_AUDIT') {
      return { decision: 'DENY', policyId, reason: 'Supplier accounts are confined to their own tender lane' };
    }
  }

  // --- Data sensitivity ------------------------------------------------------
  const sensitivity = attributes.dataSensitivity;
  if (sensitivity === 'LEGAL_L4' && !auth.roles.some((r) => LEGAL_L4_ROLES.has(r))) {
    // Safety needs the safety half of a contract, not its liability provisions.
    return { decision: 'REDACT', policyId, reason: 'Legal-L4 content withheld from this role' };
  }
  if (sensitivity === 'COMMERCIAL_L3' && !auth.roles.some((r) => COMMERCIAL_L3_ROLES.has(r))) {
    return { decision: 'REDACT', policyId, reason: 'Commercial-L3 content withheld from this role' };
  }

  // --- Phase gating ----------------------------------------------------------
  if (WRITE_CODES.has(code) && attributes.lifecyclePhase) {
    const allowed = WRITE_PHASE_GATES[area];
    if (allowed && !allowed.includes(attributes.lifecyclePhase)) {
      return {
        decision: 'DENY',
        policyId,
        reason: `${area} cannot be written during the ${attributes.lifecyclePhase} phase`,
      };
    }
  }

  return { decision: 'ALLOW', policyId };
}

/** Throwing wrapper for command handlers. REDACT is a deny for a write. */
export function assertAccess(
  auth: AuthContext,
  area: CapabilityArea,
  code: PermissionCode,
  attributes: AccessAttributes,
  options: { rbacEnabled: boolean; scopesEnabled: boolean; abacEnabled: boolean },
): AccessDecision {
  const decision = evaluateAccess(auth, area, code, attributes, options);
  if (decision.decision === 'DENY' || (decision.decision === 'REDACT' && WRITE_CODES.has(code))) {
    throw new ForbiddenError(decision.reason ?? 'Not permitted', 'ACCESS_DENIED');
  }
  return decision;
}
