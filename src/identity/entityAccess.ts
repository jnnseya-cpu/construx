import type { DataSensitivity } from './abac.ts';
import type { CapabilityArea } from './roles.ts';

/**
 * Which capability area governs each entity type, and how sensitive it is.
 *
 * The generic entity read is the one endpoint that can return any record in the
 * system. Without this map it would only enforce tenant isolation, which would
 * make every capability boundary elsewhere decorative: a safety manager barred
 * from the estimate could simply read `entities/Estimate` instead.
 *
 * An unmapped type is not readable. That is deliberate — a new entity type
 * should have to declare where it belongs before it can be served.
 */

export type EntityClassification = {
  area: CapabilityArea;
  sensitivity?: DataSensitivity;
};

export const ENTITY_ACCESS: Record<string, EntityClassification> = {
  // Business development — the pipeline, before a project exists
  Opportunity: { area: 'BUSINESS_DEVELOPMENT', sensitivity: 'COMMERCIAL_L3' },

  // Tenancy and platform — the operator layer, never delivery
  Tenant: { area: 'PLATFORM_ADMINISTRATION' },
  Subscription: { area: 'PLATFORM_ADMINISTRATION' },
  PermissionPolicy: { area: 'PLATFORM_ADMINISTRATION' },
  ACUWallet: { area: 'BILLING_ACU', sensitivity: 'COMMERCIAL_L3' },
  AIRequest: { area: 'AI_EXECUTION' },

  // Structure and setup
  Enterprise: { area: 'ENTERPRISE_STRUCTURE' },
  Portfolio: { area: 'ENTERPRISE_STRUCTURE' },
  Programme: { area: 'ENTERPRISE_STRUCTURE' },
  Project: { area: 'PROJECT_SETUP' },
  ScopePackage: { area: 'PROJECT_SETUP' },
  User: { area: 'ENTERPRISE_STRUCTURE' },

  // Design and information
  Specification: { area: 'DESIGN_INFORMATION' },
  SpecClause: { area: 'DESIGN_INFORMATION' },
  Drawing: { area: 'DESIGN_INFORMATION' },
  DrawingMarkup: { area: 'DESIGN_INFORMATION' },
  RFI: { area: 'DESIGN_INFORMATION' },
  Clarification: { area: 'DESIGN_INFORMATION' },
  Correspondence: { area: 'DESIGN_INFORMATION' },
  DesignMaturityAssessment: { area: 'DESIGN_INFORMATION' },

  // BIM and twin
  Model: { area: 'BIM_TWIN' },
  Clash: { area: 'BIM_TWIN' },
  DigitalTwinState: { area: 'BIM_TWIN' },
  SensorReading: { area: 'BIM_TWIN' },

  // Work breakdown and programme
  WorkPackage: { area: 'WORKPACKAGES_TASKS' },
  Task: { area: 'WORKPACKAGES_TASKS' },
  Dependency: { area: 'PROGRAMME_BASELINES' },
  ProgrammeBaseline: { area: 'PROGRAMME_BASELINES' },
  DelayRiskSnapshot: { area: 'PROGRAMME_BASELINES' },
  LookaheadPlan: { area: 'LOOKAHEAD_CONSTRAINTS' },
  Constraint: { area: 'LOOKAHEAD_CONSTRAINTS' },

  // Take-off, estimate and tender — commercial
  Takeoff: { area: 'BOQ_TAKEOFF' },
  BoQItem: { area: 'BOQ_TAKEOFF' },
  Estimate: { area: 'ESTIMATE_TENDER', sensitivity: 'COMMERCIAL_L3' },
  MasterPricing: { area: 'ESTIMATE_TENDER', sensitivity: 'COMMERCIAL_L3' },
  PricingSchedule: { area: 'ESTIMATE_TENDER', sensitivity: 'COMMERCIAL_L3' },
  Supplier: { area: 'PROCUREMENT_AWARD' },
  TenderPackage: { area: 'PROCUREMENT_AWARD' },
  RFQ: { area: 'PROCUREMENT_AWARD' },
  SupplierSubmission: { area: 'SUPPLIER_SUBMISSION', sensitivity: 'COMMERCIAL_L3' },
  BidEvaluation: { area: 'PROCUREMENT_AWARD', sensitivity: 'COMMERCIAL_L3' },
  Adjudication: { area: 'PROCUREMENT_AWARD', sensitivity: 'COMMERCIAL_L3' },
  BidSubmissionPack: { area: 'PROCUREMENT_AWARD', sensitivity: 'COMMERCIAL_L3' },
  Subcontract: { area: 'PROCUREMENT_AWARD', sensitivity: 'LEGAL_L4' },

  // Cost — commercial
  Budget: { area: 'BUDGET_COST', sensitivity: 'COMMERCIAL_L3' },
  ActualCost: { area: 'BUDGET_COST', sensitivity: 'COMMERCIAL_L3' },
  Commitment: { area: 'BUDGET_COST', sensitivity: 'COMMERCIAL_L3' },
  CVR: { area: 'BUDGET_COST', sensitivity: 'COMMERCIAL_L3' },
  EarnedValueSnapshot: { area: 'BUDGET_COST', sensitivity: 'COMMERCIAL_L3' },
  CashflowForecast: { area: 'BUDGET_COST', sensitivity: 'COMMERCIAL_L3' },
  Invoice: { area: 'BILLING_ACU', sensitivity: 'COMMERCIAL_L3' },
  PaymentApplication: { area: 'PAYMENT_APPLICATIONS', sensitivity: 'COMMERCIAL_L3' },
  PaymentCycle: { area: 'PAYMENT_APPLICATIONS', sensitivity: 'COMMERCIAL_L3' },
  PaymentNotice: { area: 'PAYMENT_APPLICATIONS', sensitivity: 'COMMERCIAL_L3' },
  PayLessNotice: { area: 'PAYMENT_APPLICATIONS', sensitivity: 'COMMERCIAL_L3' },
  PaymentCertificate: { area: 'PAYMENT_APPLICATIONS', sensitivity: 'COMMERCIAL_L3' },
  LedgerEntry: { area: 'BUDGET_COST', sensitivity: 'COMMERCIAL_L3' },

  // Contracts, change and claims — legal
  Contract: { area: 'CONTRACTS_CLAIMS', sensitivity: 'LEGAL_L4' },
  ContractClause: { area: 'CONTRACTS_CLAIMS', sensitivity: 'LEGAL_L4' },
  Obligation: { area: 'CONTRACTS_CLAIMS' },
  ChangeRequest: { area: 'CHANGE_VARIATION' },
  Variation: { area: 'CHANGE_VARIATION', sensitivity: 'COMMERCIAL_L3' },
  DelayEvent: { area: 'CONTRACTS_CLAIMS' },
  ImpactAssessment: { area: 'CONTRACTS_CLAIMS' },
  Claim: { area: 'CONTRACTS_CLAIMS', sensitivity: 'LEGAL_L4' },
  Notice: { area: 'CONTRACTS_CLAIMS' },
  Dispute: { area: 'CONTRACTS_CLAIMS', sensitivity: 'LEGAL_L4' },

  // Risk and safety
  RiskRegisterItem: { area: 'RISK_REGISTER' },
  RAMS: { area: 'SAFETY_RAMS' },
  CDMDocument: { area: 'SAFETY_RAMS', sensitivity: 'SAFETY_L2' },
  Induction: { area: 'SAFETY_RAMS', sensitivity: 'SAFETY_L2' },
  ToolboxTalk: { area: 'SAFETY_RAMS' },
  SafetyObservation: { area: 'SAFETY_RAMS' },
  SafetyForecast: { area: 'SAFETY_RAMS' },
  Competency: { area: 'SAFETY_RAMS' },
  TrainingRecord: { area: 'SAFETY_RAMS' },
  Incident: { area: 'SAFETY_RAMS' },

  // Field and quality
  WorkOrder: { area: 'FIELD_EXECUTION' },
  ProgressMeasurement: { area: 'FIELD_EXECUTION' },
  SiteDiary: { area: 'FIELD_EXECUTION' },
  SiteObservation: { area: 'FIELD_EXECUTION' },
  Snag: { area: 'QUALITY_COMMISSIONING' },
  Defect: { area: 'QUALITY_COMMISSIONING' },
  CommissioningTest: { area: 'QUALITY_COMMISSIONING' },
  InspectionPlan: { area: 'QUALITY_COMMISSIONING' },
  QualityInspection: { area: 'QUALITY_COMMISSIONING' },
  NCR: { area: 'QUALITY_COMMISSIONING' },

  // Handover and operations
  HandoverPack: { area: 'HANDOVER_OM' },
  OMManual: { area: 'HANDOVER_OM' },
  AssetRegisterItem: { area: 'HANDOVER_OM' },
  Warranty: { area: 'HANDOVER_OM' },
  MaintenanceForecast: { area: 'HANDOVER_OM' },

  // Evidence and AI
  EvidenceItem: { area: 'EVIDENCE_AUDIT' },
  Export: { area: 'EVIDENCE_AUDIT' },
  ReplaySnapshot: { area: 'EVIDENCE_AUDIT' },
  AIExecution: { area: 'AI_EXECUTION' },
  AgentRun: { area: 'AI_EXECUTION' },
  AgentProposal: { area: 'AI_EXECUTION' },

  // Platform-to-person messaging. These records hold email addresses and the
  // consent decisions behind them, so they sit with the operator layer and are
  // marked personal — a delivery log is a list of who was contacted and when.
  MarketingConsent: { area: 'PLATFORM_ADMINISTRATION', sensitivity: 'LEGAL_L4' },
  NewsletterCampaign: { area: 'PLATFORM_ADMINISTRATION' },
  NewsletterDelivery: { area: 'PLATFORM_ADMINISTRATION', sensitivity: 'LEGAL_L4' },
};

export function classifyEntity(refType: string): EntityClassification | undefined {
  return ENTITY_ACCESS[refType];
}
