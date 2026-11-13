/**
 * The CONSTRUX AI Gateway — human approval and prohibited actions (spec §11).
 *
 * Two guarantees live here, and both are structural rather than advisory:
 *
 *  1. **No model may take a consequential action.** A model may identify, draft,
 *     analyse, compare and propose; it may never issue, serve, certify, approve,
 *     sign, release payment, execute a contract, alter an approved baseline or
 *     delete a Golden-Thread record. The gateway refuses a tool grant that names
 *     such a capability (`assertGrantAllowed`) and screens an instruction that
 *     asks for one outright (`screenInstruction`) — both *before* any provider or
 *     tool runs (spec AT-06, §11.1).
 *
 *  2. **A consequential output is a proposal until an authorised person approves
 *     it.** `approvalRequirement` says whether a human gate is mandatory and which
 *     CONSTRUX capability the approver must hold — reusing the platform's own
 *     permission matrix rather than inventing a parallel one.
 *
 * Pure. No I/O. The service enforces what this returns.
 */
import type { CapabilityArea, PermissionCode } from '../../identity/roles.ts';
import type { GatewayErrorCode, RiskTier, TaskProfile } from './contract.ts';
import { ROUTE_POLICY } from './taxonomy.ts';

/**
 * Capabilities a tool grant may **never** include (spec §11.1). These are the acts
 * that commit the business; no AI envelope carries them, so a grant naming one is
 * a programming or configuration error and is refused before execution.
 */
export const PROHIBITED_TOOL_CAPABILITIES: ReadonlySet<string> = new Set([
  'APPROVE',
  'CERTIFY',
  'SIGN',
  'PAYMENT_RELEASE',
  'EXECUTE_CONTRACT',
  'ISSUE_NOTICE',
  'ALTER_BASELINE',
  'AWARD_SUPPLIER',
  'DELETE_LEDGER',
  'DELETE_EVIDENCE',
]);

/** Refuse a tool grant that includes a prohibited capability (spec §11.1, AT-03/AT-06). */
export function assertGrantAllowed(capabilities: readonly string[]): void {
  const bad = capabilities.find((c) => PROHIBITED_TOOL_CAPABILITIES.has(c.toUpperCase()));
  if (bad) {
    const err = new Error(`A tool grant may not include "${bad}" — no AI capability can take a consequential action`) as Error & { code?: GatewayErrorCode };
    err.code = 'AI_PROHIBITED_ACTION';
    throw err;
  }
}

/**
 * A conservative guard on the instruction text (spec AT-06). It flags an explicit
 * request for the gateway to *perform* a consequential act — "approve the payment",
 * "issue the notice", "sign and serve" — as opposed to the permitted "draft",
 * "identify", "analyse". Belt-and-braces beside the structural tool-grant refusal:
 * returns the error code to reject with, or null when the instruction is a proposal.
 */
export function screenInstruction(instruction: string): GatewayErrorCode | null {
  const text = ` ${instruction.toLowerCase()} `;
  // "verb the <consequential object>" — the verb performs, not proposes.
  const PERFORM = /\b(approve|certify|sign|serve|issue|release|pay|execute|award|delete|overwrite|backdate)\b/;
  const OBJECT = /\b(payment|certificate|notice|contract|baseline|award|supplier|evidence|ledger|golden thread|variation)\b/;
  const PROPOSE = /\b(draft|propose|identify|analyse|analyze|review|compare|recommend|assess|extract|summarise|summarize|check)\b/;
  if (PERFORM.test(text) && OBJECT.test(text) && !PROPOSE.test(text)) return 'AI_PROHIBITED_ACTION';
  return null;
}

/** Which CONSTRUX capability an approver must hold for a task, and a human label (spec §11). */
const APPROVAL_AUTHORITY: Partial<Record<TaskProfile, { area: CapabilityArea; code: PermissionCode; roleLabel: string }>> = {
  'contract.obligation_analysis': { area: 'CONTRACTS_CLAIMS', code: 'A', roleLabel: 'authorised contract/commercial role' },
  'claims.entitlement_analysis': { area: 'CONTRACTS_CLAIMS', code: 'A', roleLabel: 'authorised commercial role' },
  'commercial.cvr_analysis': { area: 'BUDGET_COST', code: 'A', roleLabel: 'authorised commercial and finance role' },
  'planning.logic_review': { area: 'PROGRAMME_BASELINES', code: 'A', roleLabel: 'project governance role' },
  'risk.change_analysis': { area: 'RISK_REGISTER', code: 'A', roleLabel: 'project governance role' },
  'procurement.vendor_analysis': { area: 'PROCUREMENT_AWARD', code: 'A', roleLabel: 'authorised procurement governance' },
  'document.generate': { area: 'DESIGN_INFORMATION', code: 'A', roleLabel: 'named authorised user' },
  'workflow.agent_execution': { area: 'ENTERPRISE_STRUCTURE', code: 'A', roleLabel: 'authorised operator of the workflow' },
  'operations.maintenance': { area: 'HANDOVER_OM', code: 'A', roleLabel: 'asset operations authority' },
  'tender.compliance_matrix': { area: 'ESTIMATE_TENDER', code: 'A', roleLabel: 'bid authority' },
};

export type ApprovalRequirement = {
  required: boolean;
  authority: { area: CapabilityArea; code: PermissionCode } | null;
  roleLabel: string;
};

/**
 * Whether a task's output must be approved by a human before it is committed, and
 * by whom (spec §6, §11). A **consequential** task always requires it. A
 * **material** task requires it when the caller opted in via `approvalPolicy`
 * (e.g. a notice draft). **Informational** output never does.
 */
export function approvalRequirement(profile: TaskProfile, approvalPolicy?: string): ApprovalRequirement {
  const tier: RiskTier = ROUTE_POLICY[profile].riskTier;
  const authority = APPROVAL_AUTHORITY[profile] ?? null;
  const required = tier === 'CONSEQUENTIAL' || (tier === 'MATERIAL' && typeof approvalPolicy === 'string' && approvalPolicy.length > 0);
  return {
    required,
    authority: authority ? { area: authority.area, code: authority.code } : null,
    roleLabel: authority?.roleLabel ?? 'an authorised person',
  };
}
