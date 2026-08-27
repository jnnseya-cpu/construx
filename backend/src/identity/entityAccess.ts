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
  LessonLearned: { area: 'RISK_REGISTER' },
  CompanyProfile: { area: 'BUSINESS_DEVELOPMENT' },
  RadarRun: { area: 'BUSINESS_DEVELOPMENT', sensitivity: 'COMMERCIAL_L3' },

  // Tenancy and platform — the operator layer, never delivery
  Tenant: { area: 'PLATFORM_ADMINISTRATION' },
  Subscription: { area: 'PLATFORM_ADMINISTRATION' },
  PermissionPolicy: { area: 'PLATFORM_ADMINISTRATION' },
  ACUWallet: { area: 'BILLING_ACU', sensitivity: 'COMMERCIAL_L3' },
  // Money entering the platform. Same area and sensitivity as the wallet it
  // credits — a payment record names an amount and a bank reference, which is
  // commercial-in-confidence for the same reasons the balance is.
  TopUpIntent: { area: 'BILLING_ACU', sensitivity: 'COMMERCIAL_L3' },
  PaymentReceipt: { area: 'BILLING_ACU', sensitivity: 'COMMERCIAL_L3' },
  AIRequest: { area: 'AI_EXECUTION' },

  // Structure and setup
  Enterprise: { area: 'ENTERPRISE_STRUCTURE' },
  Portfolio: { area: 'ENTERPRISE_STRUCTURE' },
  Programme: { area: 'ENTERPRISE_STRUCTURE' },
  Project: { area: 'PROJECT_SETUP' },
  ScopePackage: { area: 'PROJECT_SETUP' },
  // A stage occupancy and the gate decision that ends it both sit under
  // PROJECT_SETUP, which is the area that already authorises phase transitions.
  // A separate area would have meant an entry for each in the permission matrix
  // for every role, to express an authority that already exists.
  //
  // Segregation of duties is enforced where the spec actually asks for it — on
  // the decision itself, in `lifecycle/stages.ts`, which refuses a decision from
  // the person who submitted the gate. That is a rule about two acts by one
  // person; a capability area cannot express it.
  StageInstance: { area: 'PROJECT_SETUP' },
  GateReview: { area: 'PROJECT_SETUP' },
  User: { area: 'ENTERPRISE_STRUCTURE' },

  // Design and information
  Specification: { area: 'DESIGN_INFORMATION' },
  SpecClause: { area: 'DESIGN_INFORMATION' },
  // D-WF-01. The package carries its own deliverables and interfaces; the MIDP
  // is the reconciliation across them. Both under DESIGN_INFORMATION, which
  // already splits the parties the plan needs: the designer and principal
  // designer hold A and approve the plan, the contractor and EPC hold C and U
  // and build it.
  DesignPackage: { area: 'DESIGN_INFORMATION' },
  MIDP: { area: 'DESIGN_INFORMATION' },
  // With the clause it answers, not with quality. QUALITY_COMMISSIONING is
  // phase-gated to CONSTRUCTION onwards, and a long-lead submittal raised in
  // design — which is the only time a fourteen-week item can be raised usefully
  // — is not a process error. The area also already splits the two parties
  // correctly: the contractor and EPC hold C and U so they submit, the designer
  // and principal designer hold A so they decide.
  MaterialSubmittal: { area: 'DESIGN_INFORMATION' },
  Drawing: { area: 'DESIGN_INFORMATION' },
  DrawingMarkup: { area: 'DESIGN_INFORMATION' },
  RFI: { area: 'DESIGN_INFORMATION' },
  // Tender clarifications, not design ones — every write against this entity is
  // a procurement act. Classified `DESIGN_INFORMATION` with no sensitivity
  // until T-WF-06, which was wrong before and would have been a leak after: the
  // register now carries commercial-in-confidence bidder questions, and a
  // designer holding `DESIGN_INFORMATION` read could have listed them.
  Clarification: { area: 'PROCUREMENT_AWARD', sensitivity: 'COMMERCIAL_L3' },
  Correspondence: { area: 'DESIGN_INFORMATION' },
  StorageEntitlement: { area: 'BILLING_ACU' },
  // A permit names who is authorised to do a high-risk activity and on whose
  // competence. Same area as the RAMS it depends on.
  Permit: { area: 'SAFETY_RAMS' },
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
  // The measured items and their rate build-ups. Commercial-L3: the build-ups
  // are what our labour and material actually cost, which is the one thing a
  // competitor would most like to see.
  MeasurementSchedule: { area: 'BOQ_TAKEOFF', sensitivity: 'COMMERCIAL_L3' },
  Estimate: { area: 'ESTIMATE_TENDER', sensitivity: 'COMMERCIAL_L3' },
  TenderResponse: { area: 'ESTIMATE_TENDER', sensitivity: 'COMMERCIAL_L3' },
  ITTAnalysis: { area: 'ESTIMATE_TENDER', sensitivity: 'COMMERCIAL_L3' },
  // The reading of the tender documents. Legal-L4: it carries the executed
  // contract wording verbatim, which is the same sensitivity as the contract.
  TenderReview: { area: 'ESTIMATE_TENDER', sensitivity: 'LEGAL_L4' },
  TenderInvitation: { area: 'ESTIMATE_TENDER', sensitivity: 'COMMERCIAL_L3' },
  BidProgramme: { area: 'ESTIMATE_TENDER', sensitivity: 'COMMERCIAL_L3' },
  MasterPricing: { area: 'ESTIMATE_TENDER', sensitivity: 'COMMERCIAL_L3' },
  PricingSchedule: { area: 'ESTIMATE_TENDER', sensitivity: 'COMMERCIAL_L3' },
  // Buy it or do it, per package: the market's number beside our own, and the
  // reasoning behind which one went in the bid.
  PricingRoute: { area: 'ESTIMATE_TENDER', sensitivity: 'COMMERCIAL_L3' },
  // The stage gate decision and its conditions. Project setup, because leaving
  // a stage is a governance act rather than a commercial one, and internal
  // rather than commercial because a regulator asking whether the gate was
  // cleared is asking a question they are entitled to an answer to.
  StageGateDecision: { area: 'PROJECT_SETUP' },
  // Every bidder's price side by side. There is nothing more commercially
  // sensitive in a tender than this record, and one bidder seeing it would end
  // the process.
  ReturnComparison: { area: 'PROCUREMENT_AWARD', sensitivity: 'COMMERCIAL_L3' },
  // The enquiry pack and who holds which revision of it. One bidder reading the
  // distribution learns the size of the field they are competing in, which is
  // the commercially fatal disclosure — so the generic entity read is gated and
  // a bidder is served through `bidderView`, which returns only their own row.
  Enquiry: { area: 'PROCUREMENT_AWARD', sensitivity: 'COMMERCIAL_L3' },
  Supplier: { area: 'PROCUREMENT_AWARD' },
  Framework: { area: 'PROCUREMENT_AWARD' },
  TenderPackage: { area: 'PROCUREMENT_AWARD' },
  RFQ: { area: 'PROCUREMENT_AWARD' },
  SupplierSubmission: { area: 'SUPPLIER_SUBMISSION', sensitivity: 'COMMERCIAL_L3' },
  BidEvaluation: { area: 'PROCUREMENT_AWARD', sensitivity: 'COMMERCIAL_L3' },
  Adjudication: { area: 'PROCUREMENT_AWARD', sensitivity: 'COMMERCIAL_L3' },
  // The settlement meeting on our own bid. Estimating rather than procurement:
  // it is the price we are giving, not a price we are choosing between.
  Settlement: { area: 'ESTIMATE_TENDER', sensitivity: 'COMMERCIAL_L3' },
  BidSubmissionPack: { area: 'PROCUREMENT_AWARD', sensitivity: 'COMMERCIAL_L3' },
  Subcontract: { area: 'PROCUREMENT_AWARD', sensitivity: 'LEGAL_L4' },

  // A review cycle and its comments are design information: the same area, and
  // the same sensitivity, as the deliverable they are about. A comment naming a
  // structural defect is not less sensitive than the drawing it is on.
  DesignReviewCycle: { area: 'DESIGN_INFORMATION' },
  DesignReviewComment: { area: 'DESIGN_INFORMATION' },

  // Cost — commercial
  Budget: { area: 'BUDGET_COST', sensitivity: 'COMMERCIAL_L3' },
  ActualCost: { area: 'BUDGET_COST', sensitivity: 'COMMERCIAL_L3' },
  Commitment: { area: 'BUDGET_COST', sensitivity: 'COMMERCIAL_L3' },
  CVR: { area: 'BUDGET_COST', sensitivity: 'COMMERCIAL_L3' },
  EarnedValueSnapshot: { area: 'BUDGET_COST', sensitivity: 'COMMERCIAL_L3' },
  CashflowForecast: { area: 'BUDGET_COST', sensitivity: 'COMMERCIAL_L3' },
  FundingModel: { area: 'BUDGET_COST', sensitivity: 'COMMERCIAL_L3' },
  Invoice: { area: 'BILLING_ACU', sensitivity: 'COMMERCIAL_L3' },
  PaymentApplication: { area: 'PAYMENT_APPLICATIONS', sensitivity: 'COMMERCIAL_L3' },
  PaymentCycle: { area: 'PAYMENT_APPLICATIONS', sensitivity: 'COMMERCIAL_L3' },
  PaymentNotice: { area: 'PAYMENT_APPLICATIONS', sensitivity: 'COMMERCIAL_L3' },
  // A set-off names a subcontractor's failure and its cost. Same area and
  // sensitivity as the payment records it deducts from — reading it is reading
  // the commercial position of that supplier.
  ContraCharge: { area: 'PAYMENT_APPLICATIONS', sensitivity: 'COMMERCIAL_L3' },
  PayLessNotice: { area: 'PAYMENT_APPLICATIONS', sensitivity: 'COMMERCIAL_L3' },
  PaymentCertificate: { area: 'PAYMENT_APPLICATIONS', sensitivity: 'COMMERCIAL_L3' },
  LedgerEntry: { area: 'BUDGET_COST', sensitivity: 'COMMERCIAL_L3' },
  // A break in the bid-to-CVR chain. It names the unattached records and the
  // money standing behind them, so it is as commercially sensitive as the
  // records it is about.
  ChainException: { area: 'BUDGET_COST', sensitivity: 'COMMERCIAL_L3' },

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
  // The site visit lives with constraints rather than with field execution: it
  // is walked before construction starts, and FIELD_EXECUTION is phase-gated to
  // CONSTRUCTION and COMMISSIONING. Its output is constraints, and that is the
  // area that already owns them.
  SiteVisit: { area: 'LOOKAHEAD_CONSTRAINTS' },
  SiteFinding: { area: 'LOOKAHEAD_CONSTRAINTS' },
  SiteLogisticsPlan: { area: 'LOOKAHEAD_CONSTRAINTS' },
  // A meeting sits with constraints for the same reason a site visit does: what
  // comes out of it is actions somebody owns by a date, which is the thing this
  // area already governs. It is also the area that is not phase-gated, and a
  // design coordination meeting held in CONCEPT is not a process error.
  //
  // The split falls out of the matrix rather than being invented beside it: the
  // planner, supervisor and EPC hold C and U, so they minute; the project
  // manager and project director hold A, so they issue. That is exactly how a
  // set of minutes is produced on site.
  SiteMeeting: { area: 'LOOKAHEAD_CONSTRAINTS' },
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
  // What a model read out of a held file. Classified under evidence rather than
  // under the area it will eventually feed, because a draft is not yet a
  // drawing, a take-off or an observation — and until somebody confirms it, it
  // must not be readable as though it were one.
  OperatingCost: { area: 'HANDOVER_OM' },
  PerceptionDraft: { area: 'EVIDENCE_AUDIT' },
  // A signature request names who must sign and on what; the signature is the
  // record of their agreement. Both are audit material rather than the
  // commercial or contractual document they concern, and are readable by
  // everyone who may read the audit trail — which is what makes a signature
  // checkable rather than merely asserted.
  SignatureRequest: { area: 'EVIDENCE_AUDIT' },
  Signature: { area: 'EVIDENCE_AUDIT' },
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
  // A dispatch record names a person and what they were told. The delivery
  // record additionally names their address and whether it reached them, which
  // is why the two are classified apart rather than together.
  NotificationDispatch: { area: 'PLATFORM_ADMINISTRATION' },
  NotificationDelivery: { area: 'PLATFORM_ADMINISTRATION', sensitivity: 'LEGAL_L4' },
  NotificationPreferences: { area: 'PLATFORM_ADMINISTRATION', sensitivity: 'LEGAL_L4' },
};

export function classifyEntity(refType: string): EntityClassification | undefined {
  return ENTITY_ACCESS[refType];
}
