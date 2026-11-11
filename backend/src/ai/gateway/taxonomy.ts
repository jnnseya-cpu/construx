/**
 * The CONSTRUX AI Gateway — task taxonomy and routing policy (spec §4, §5, §10).
 *
 * This is the **versioned, explainable** policy the router reads: for every task
 * profile, which provider is primary, the task-specific fallback chain, what the
 * output must be validated for, and the risk tier that decides whether a human
 * approval gate is mandatory. Changing routing means changing this table and its
 * `POLICY_VERSION` — never editing a business module (P02), and never a universal
 * fallback sequence (spec §10 "task-specific, not one universal sequence").
 *
 * Pure data. The router (`router.ts`) and policy (`policy.ts`) consume it.
 */
import type { GatewayProvider, Modality, RiskTier, TaskProfile, ValidationKind } from './contract.ts';

/** Bump on any change to the matrix below; it stamps every route record (spec §15.4). */
export const POLICY_VERSION = 'route-2026-11-11.1';

/**
 * The provider-role policy (spec §4), kept for explainability and admin display:
 * Gemini sees and extracts, Claude reads deeply and evaluates, OpenAI acts and
 * operates workflows, Vertex governs and routes.
 */
export const PROVIDER_ROLE: Record<GatewayProvider, string> = {
  GEMINI: 'Perception and ingestion — sees and extracts',
  ANTHROPIC: 'Deep construction reasoning — reads and evaluates',
  OPENAI: 'Execution and workflow operation — acts and operates',
  VERTEX: 'Enterprise control plane — governs, routes and evaluates',
};

export type RoutePolicy = {
  /** The first provider the router tries. */
  primary: GatewayProvider;
  /** Task-specific fallback order after the primary (spec §10). May name an unwired provider; the router skips it. */
  fallback: GatewayProvider[];
  modality: Modality;
  riskTier: RiskTier;
  /** The canonical validators the output must pass (spec §5 "required validation"). */
  validations: ValidationKind[];
  /** A short, user-safe description of what the task does (never names a provider). */
  purpose: string;
};

/**
 * The routing matrix (spec §5). Primary + task-specific fallback, exactly as the
 * agreed provider allocation; `ANTHROPIC` is Claude, `GEMINI` is Gemini, `OPENAI`
 * is OpenAI, `VERTEX` is the (deferred) Vertex control plane.
 */
export const ROUTE_POLICY: Record<TaskProfile, RoutePolicy> = {
  'vision.drawing_extract': {
    primary: 'GEMINI', fallback: ['VERTEX', 'OPENAI'], modality: 'VISION', riskTier: 'INFORMATIONAL',
    validations: ['SCHEMA', 'SOURCE_ANCHORS', 'CONFIDENCE_FLOOR'],
    purpose: 'Read drawings and extract structured facts, objects and quantities',
  },
  'vision.site_evidence': {
    primary: 'GEMINI', fallback: ['VERTEX', 'OPENAI'], modality: 'VISION', riskTier: 'INFORMATIONAL',
    validations: ['SCHEMA', 'SOURCE_ANCHORS', 'OBSERVATION_ONLY_LANGUAGE'],
    purpose: 'Read site photos/video and report observable conditions only',
  },
  'document.itt_ingest': {
    primary: 'GEMINI', fallback: ['ANTHROPIC', 'OPENAI'], modality: 'DOCUMENT', riskTier: 'INFORMATIONAL',
    validations: ['COMPLETENESS', 'SOURCE_ANCHORS'],
    purpose: 'Ingest and structure an ITT / tender document pack',
  },
  'contract.obligation_analysis': {
    primary: 'ANTHROPIC', fallback: ['OPENAI', 'GEMINI'], modality: 'DOCUMENT', riskTier: 'MATERIAL',
    validations: ['CLAUSE_CITATIONS', 'EVIDENCE_COVERAGE'],
    purpose: 'Analyse obligations, contradictions and exposure in a contract',
  },
  'claims.entitlement_analysis': {
    primary: 'ANTHROPIC', fallback: ['OPENAI'], modality: 'DOCUMENT', riskTier: 'MATERIAL',
    validations: ['EVIDENCE_COVERAGE', 'LEGAL_DISCLAIMER'],
    purpose: 'Analyse entitlement from the record, with chronology and a disclaimer',
  },
  'tender.compliance_matrix': {
    primary: 'ANTHROPIC', fallback: ['OPENAI', 'GEMINI'], modality: 'DOCUMENT', riskTier: 'MATERIAL',
    validations: ['COMPLETENESS', 'SOURCE_ANCHORS'],
    purpose: 'Set a buyer’s requirements against the company’s facts',
  },
  'planning.logic_review': {
    primary: 'ANTHROPIC', fallback: ['OPENAI', 'GEMINI'], modality: 'DOCUMENT', riskTier: 'MATERIAL',
    validations: ['EVIDENCE_COVERAGE'],
    purpose: 'Review programme logic, dependencies and baseline references',
  },
  'commercial.cvr_analysis': {
    primary: 'OPENAI', fallback: ['ANTHROPIC', 'GEMINI'], modality: 'STRUCTURED', riskTier: 'MATERIAL',
    validations: ['DETERMINISTIC_CALC_MATCH', 'SCHEMA'],
    purpose: 'Analyse cost/value against the source ledger (arithmetic is deterministic)',
  },
  'risk.change_analysis': {
    primary: 'ANTHROPIC', fallback: ['OPENAI', 'GEMINI'], modality: 'DOCUMENT', riskTier: 'MATERIAL',
    validations: ['EVIDENCE_COVERAGE', 'SCHEMA'],
    purpose: 'Analyse a risk or change — cause, event, impact, probability',
  },
  'procurement.vendor_analysis': {
    primary: 'ANTHROPIC', fallback: ['OPENAI', 'GEMINI'], modality: 'DOCUMENT', riskTier: 'CONSEQUENTIAL',
    validations: ['EVIDENCE_COVERAGE', 'COMPLETENESS'],
    purpose: 'Evaluate suppliers against declared criteria (award is a human decision)',
  },
  'workflow.agent_execution': {
    primary: 'OPENAI', fallback: ['ANTHROPIC', 'GEMINI'], modality: 'STRUCTURED', riskTier: 'CONSEQUENTIAL',
    validations: ['TOOL_POSTCONDITION', 'SCHEMA'],
    purpose: 'Run an approved workflow step with allowlisted, scoped tools',
  },
  'document.generate': {
    primary: 'OPENAI', fallback: ['ANTHROPIC', 'GEMINI'], modality: 'STRUCTURED', riskTier: 'MATERIAL',
    validations: ['SCHEMA', 'CLAUSE_CITATIONS'],
    purpose: 'Draft a document from a template, cited and author-labelled',
  },
  'executive.synthesis': {
    primary: 'ANTHROPIC', fallback: ['OPENAI', 'GEMINI'], modality: 'DOCUMENT', riskTier: 'INFORMATIONAL',
    validations: ['EVIDENCE_COVERAGE'],
    purpose: 'Synthesise an executive view traceable to verified portfolio facts',
  },
  'external.watchtower': {
    primary: 'GEMINI', fallback: ['ANTHROPIC', 'OPENAI'], modality: 'MIXED', riskTier: 'INFORMATIONAL',
    validations: ['SOURCE_ANCHORS'],
    purpose: 'Read external market/regulatory signals and assess implications',
  },
  'operations.maintenance': {
    primary: 'VERTEX', fallback: ['OPENAI', 'ANTHROPIC'], modality: 'STRUCTURED', riskTier: 'MATERIAL',
    validations: ['SCHEMA', 'CONFIDENCE_FLOOR'],
    purpose: 'Asset operations and maintenance, under work-order policy',
  },
};

/** The ordered route chain (primary first) for a task profile — what the router walks. */
export function routeChain(profile: TaskProfile): GatewayProvider[] {
  const p = ROUTE_POLICY[profile];
  return [p.primary, ...p.fallback];
}
