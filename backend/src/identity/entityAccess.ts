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
  // D-WF-07. With design rather than with safety, deliberately: its findings
  // are about the design and its output is a design change, an RFI or a
  // constraint. The residual risks it carries reach the safety file through the
  // pre-construction information, which is where SAFETY_RAMS picks them up.
  // Classifying it as safety would bar the designers whose review it is.
  ConstructabilityReview: { area: 'DESIGN_INFORMATION' },
  // With the clause it answers, not with quality. QUALITY_COMMISSIONING is
  // phase-gated to CONSTRUCTION onwards, and a long-lead submittal raised in
  // design — which is the only time a fourteen-week item can be raised usefully
  // — is not a process error. The area also already splits the two parties
  // correctly: the contractor and EPC hold C and U so they submit, the designer
  // and principal designer hold A so they decide.
  MaterialSubmittal: { area: 'DESIGN_INFORMATION' },
  // Not `ChangeRequest`, which is contractual and sits under CHANGE_VARIATION
  // with the quantity surveyor's authority on it. This is a change to approved
  // *design*, most instances of which are a designer correcting their own work
  // and never become a variation. Classifying it as CHANGE_VARIATION would put
  // every drawing correction in front of the commercial team and bar the
  // designers whose change it is; the link between the two registers is a
  // reference on the record, not a shared area.
  DesignChange: { area: 'DESIGN_INFORMATION' },
  // The baseline and what it froze. Design information rather than project
  // setup: freezing a package is a design authority's act, and the same people
  // who accept a deliverable are the ones who can say it has stopped moving.
  // The 7.4 stage gate that reads them sits under PROJECT_SETUP, which is the
  // governance layer above and a different question.
  FrozenPackage: { area: 'DESIGN_INFORMATION' },
  DesignBaseline: { area: 'DESIGN_INFORMATION' },
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
  // CN-WF-08. The controlled issue of information, with who acknowledged it.
  Transmittal: { area: 'DESIGN_INFORMATION' },
  StorageEntitlement: { area: 'BILLING_ACU' },
  // A permit names who is authorised to do a high-risk activity and on whose
  // competence. Same area as the RAMS it depends on.
  Permit: { area: 'SAFETY_RAMS' },
  DesignMaturityAssessment: { area: 'DESIGN_INFORMATION' },

  // BIM and twin
  Model: { area: 'BIM_TWIN' },
  Clash: { area: 'BIM_TWIN' },
  // D-WF-04. The set is the exact revisions a run was made against, the run is
  // what it found, and the issue is the grouped thing somebody owns. All three
  // under BIM_TWIN, which already splits the parties: the EPC and the designer
  // hold C and U so they federate, run and resolve; the BIM lead alone holds A,
  // so verifying that a clash is actually gone — and accepting one that is not
  // — is the coordination authority's, not the party who says they fixed it.
  FederationSet: { area: 'BIM_TWIN' },
  ClashRun: { area: 'BIM_TWIN' },
  CoordinationIssue: { area: 'BIM_TWIN' },
  DigitalTwinState: { area: 'BIM_TWIN' },
  SensorReading: { area: 'BIM_TWIN' },

  // Work breakdown and programme
  WorkPackage: { area: 'WORKPACKAGES_TASKS' },
  /**
   * Who carries which obligation, between the client and every firm on the job.
   *
   * `WORKPACKAGES_TASKS` because that is the area the project manager and the
   * construction manager both hold `C`, `U` and `A` on, and they are the two
   * who answer for the interface. `COMMERCIAL_L3` because the matrix states
   * what this business has and has not accepted: a subcontractor reading the
   * line that says a duty is theirs is reading this business's negotiating
   * position on a claim they have not made yet.
   */
  ResponsibilityItem: { area: 'WORKPACKAGES_TASKS', sensitivity: 'COMMERCIAL_L3' },
  /**
   * The integrator's commercial account — the price build-up, the client
   * advance and every contingency draw. `BUDGET_COST` and `COMMERCIAL_L3`: it
   * states this business's margin, and a supplier or a client reading it is
   * reading the negotiating position rather than the contract.
   */
  IntegrationAccount: { area: 'BUDGET_COST', sensitivity: 'COMMERCIAL_L3' },
  // Which suppliers have approached the client, and what share each holds.
  // The most damaging thing on the project to leak into the supply chain, and
  // every supplier is an identity on this platform.
  IntermediationPosition: { area: 'BUDGET_COST', sensitivity: 'COMMERCIAL_L3' },
  Calendar: { area: 'PROGRAMME_BASELINES', sensitivity: 'INTERNAL' },
  ScheduleRun: { area: 'PROGRAMME_BASELINES', sensitivity: 'INTERNAL' },
  Resource: { area: 'PROGRAMME_BASELINES', sensitivity: 'INTERNAL' },
  ResourceAssignment: { area: 'PROGRAMME_BASELINES', sensitivity: 'INTERNAL' },
  ActivityCode: { area: 'PROGRAMME_BASELINES', sensitivity: 'INTERNAL' },
  ProgrammeReview: { area: 'PROGRAMME_BASELINES', sensitivity: 'INTERNAL' },
  ProgrammeComment: { area: 'PROGRAMME_BASELINES', sensitivity: 'INTERNAL' },
  Task: { area: 'WORKPACKAGES_TASKS' },
  Dependency: { area: 'PROGRAMME_BASELINES' },
  ProgrammeBaseline: { area: 'PROGRAMME_BASELINES' },
  // The same area as the baseline it is a forecast against — reading one
  // without the other is how a variance gets quoted with no reference.
  ProgrammeForecast: { area: 'PROGRAMME_BASELINES' },
  DelayRiskSnapshot: { area: 'PROGRAMME_BASELINES' },
  LookaheadPlan: { area: 'LOOKAHEAD_CONSTRAINTS' },
  Constraint: { area: 'LOOKAHEAD_CONSTRAINTS' },

  // CN-WF-01. Field execution rather than safety or work packages: mobilisation
  // is the construction manager's, and the area already splits it the right way
  // — the site manager, safety and quality hold create and update so they run
  // the readiness check, and only the project or construction manager holds
  // approve, which is the authority to put people to work.
  // The receipt a device leaves when it comes back into signal. Field
  // execution, because it is a fact about the site record rather than about the
  // platform's plumbing.
  SyncSession: { area: 'FIELD_EXECUTION' },
  SyncConflict: { area: 'FIELD_EXECUTION' },
  // CN-WF-04. The basis sits with the work package it measures, because it is
  // a statement about scope; the claim and its certification sit with field
  // execution, where the area already splits the two parties — the site
  // manager holds create so the gang claims, and only the project or
  // construction manager holds approve, so somebody else certifies.
  // CN-WF-05. The item is a procurement record and the delivery is what turned
  // up against it. Both under PROCUREMENT_AWARD, which is where the buying
  // already sits — and quarantine and release are gated on quality authority
  // inside the commands rather than by classifying the delivery as quality,
  // which would bar the buyer from their own register.
  // CN-WF-06. The request, the release and the instrument register all sit with
  // quality, which is where the ITP and the NCR already are.
  InspectionRequest: { area: 'QUALITY_COMMISSIONING' },
  HoldPointRelease: { area: 'QUALITY_COMMISSIONING' },
  Instrument: { area: 'QUALITY_COMMISSIONING' },
  ProcurementItem: { area: 'PROCUREMENT_AWARD' },
  Delivery: { area: 'PROCUREMENT_AWARD' },
  MeasurementBasis: { area: 'WORKPACKAGES_TASKS' },
  ProgressSubmission: { area: 'FIELD_EXECUTION' },
  MobilisationPlan: { area: 'FIELD_EXECUTION' },
  ReadinessCheck: { area: 'FIELD_EXECUTION' },
  StartWorkAuthorisation: { area: 'FIELD_EXECUTION' },

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
  // Who was asked onto the project, by whom, and whether they accepted. Under
  // PROJECT_SETUP because it is a fact about the project's team rather than
  // about the tenancy's billing, and a project person has to be able to see
  // whether the invitation they sent has been taken up.
  // The common data environment: the file itself, its revision and its state.
  InformationContainer: { area: 'DESIGN_INFORMATION' },
  ProjectInvitation: { area: 'PROJECT_SETUP' },
  // What the tenancy owes and whether it has been paid. Under billing, with
  // the wallet and the invoices, because that is who asks the question.
  SubscriptionCharge: { area: 'BILLING_ACU', sensitivity: 'COMMERCIAL_L3' },
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
  // A promise read out of a letter, quoting the letter. Named for where it
  // comes from because `Commitment` is already taken by the cost commitment
  // above — a purchase order against a budget is a different thing entirely,
  // and one word for two concepts is how a permission model goes wrong.
  CorrespondenceCommitment: { area: 'CONTRACTS_CLAIMS', sensitivity: 'LEGAL_L4' },
  ChangeRequest: { area: 'CHANGE_VARIATION' },
  Variation: { area: 'CHANGE_VARIATION', sensitivity: 'COMMERCIAL_L3' },
  DelayEvent: { area: 'CONTRACTS_CLAIMS' },
  ImpactAssessment: { area: 'CONTRACTS_CLAIMS' },
  Claim: { area: 'CONTRACTS_CLAIMS', sensitivity: 'LEGAL_L4' },
  Notice: { area: 'CONTRACTS_CLAIMS' },
  // CN-WF-08. An instruction binds the contract, and a verbal direction is the
  // exposure that exists until one confirms it. Both contractual rather than
  // design: the question they answer is what the project is owed and owes.
  Instruction: { area: 'CONTRACTS_CLAIMS' },
  // The five values and the deadline that was checked. Commercial-in-confidence
  // for the same reason the variation register is: what was claimed against
  // what was assessed is the negotiating position.
  ValueChain: { area: 'CONTRACTS_CLAIMS', sensitivity: 'COMMERCIAL_L3' },
  NoticeDeadline: { area: 'CONTRACTS_CLAIMS' },
  UnconfirmedDirection: { area: 'CONTRACTS_CLAIMS' },
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
  // The walk and the constraints it produced. Same area as the site visit
  // because it is the same register reached from a phone, and no more sensitive
  // than the findings it sits beside — the raw imagery is a separate concern
  // and does not live on this entity.
  CaptureMission: { area: 'LOOKAHEAD_CONSTRAINTS' },
  // The geometry and the layout adopted from it. Same area as the site visit
  // they belong to; a site plan is not more sensitive than the walk that made it.
  RetentionRelease: { area: 'PAYMENT_APPLICATIONS' },
  CISVerification: { area: 'PAYMENT_APPLICATIONS' },
  CISPayment: { area: 'PAYMENT_APPLICATIONS' },
  SiteModel: { area: 'LOOKAHEAD_CONSTRAINTS' },
  SiteLayout: { area: 'LOOKAHEAD_CONSTRAINTS' },
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
  // CN-WF-11. Both follow the meeting they come out of: the chair who issues the
  // minutes is the authority who approves the version and records the decision,
  // and splitting them into a different area would mean the person running the
  // meeting could not record what was decided at it.
  MinutesVersion: { area: 'LOOKAHEAD_CONSTRAINTS' },
  DecisionRecord: { area: 'LOOKAHEAD_CONSTRAINTS' },
  Snag: { area: 'QUALITY_COMMISSIONING' },
  Defect: { area: 'QUALITY_COMMISSIONING' },
  CommissioningTest: { area: 'QUALITY_COMMISSIONING' },
  // CN-WF-12. Turnover is a quality act — it is the point the construction
  // evidence is checked against a rule — while the period report and the
  // completion certificate belong to whoever governs the project itself.
  SystemTurnover: { area: 'QUALITY_COMMISSIONING' },
  // CM-WF-01. The hierarchy, the plan and the packs it requires all sit with the
  // commissioning manager, which the matrix already places in quality.
  SystemNode: { area: 'QUALITY_COMMISSIONING' },
  CommissioningPlan: { area: 'QUALITY_COMMISSIONING' },
  TestPackRequirement: { area: 'QUALITY_COMMISSIONING' },
  TemporaryOperation: { area: 'QUALITY_COMMISSIONING' },
  TestPack: { area: 'QUALITY_COMMISSIONING' },
  VendorTest: { area: 'QUALITY_COMMISSIONING' },
  CommissioningException: { area: 'QUALITY_COMMISSIONING' },
  PreFunctionalCheck: { area: 'QUALITY_COMMISSIONING' },
  FunctionalTest: { area: 'QUALITY_COMMISSIONING' },
  ReliabilityRun: { area: 'QUALITY_COMMISSIONING' },
  SeasonalTest: { area: 'QUALITY_COMMISSIONING' },
  TrainingSession: { area: 'QUALITY_COMMISSIONING' },
  CommissioningDossier: { area: 'QUALITY_COMMISSIONING' },
  SystemAcceptance: { area: 'QUALITY_COMMISSIONING' },
  // The stage exit belongs with whoever governs the project, as the
  // construction one does.
  CommissioningCompletion: { area: 'PROJECT_SETUP' },
  // H-WF-01. The matrix belongs with whoever runs handover, which the matrix
  // already places with the FM alongside the project director and the owner.
  HandoverRequirement: { area: 'HANDOVER_OM' },
  HandoverSection: { area: 'HANDOVER_OM' },
  // H-WF-02. With design information rather than handover: the set is design
  // information at its final revision, and the area already splits the parties
  // the workflow needs — the contractor and EPC hold C and U so they submit,
  // the designer and principal designer hold A so they verify, which is exactly
  // the specification's "authorised professionals verify".
  AsBuiltSet: { area: 'DESIGN_INFORMATION' },
  AssetInformationLink: { area: 'DESIGN_INFORMATION' },
  // H-WF-03. The structured manual, distinct from the AI-drafted `OMManual`
  // that feeds it: one is an extraction, the other is what the operator accepts.
  OMManualStructure: { area: 'HANDOVER_OM' },
  // H-WF-04. The validation and the exchange sit beside the register they judge.
  AssetValidation: { area: 'HANDOVER_OM' },
  AssetExchange: { area: 'HANDOVER_OM' },
  // H-WF-05. The pack and its readiness sit with handover; the transfer of
  // control over the record itself is an evidence act, which is the area the
  // regulator already reads through.
  CompletionReadiness: { area: 'HANDOVER_OM' },
  RegulatoryPack: { area: 'HANDOVER_OM' },
  GoldenThreadTransfer: { area: 'EVIDENCE_AUDIT' },
  // H-WF-06. The competence assessment carries SAFETY_L2, which is the nearest
  // restriction the sensitivity ladder offers for personal data — it has no
  // personal-data tier, and this is not claimed to be one.
  TrainingNeeds: { area: 'HANDOVER_OM' },
  CompetenceAssessment: { area: 'HANDOVER_OM', sensitivity: 'SAFETY_L2' },
  TrainingGapPlan: { area: 'HANDOVER_OM' },
  RetrainingObligation: { area: 'HANDOVER_OM' },
  OperatorReadiness: { area: 'HANDOVER_OM' },
  // H-WF-07. The register holds no secret value — a credential is recorded by
  // its vault reference — but it does say which doors exist and where the keys
  // are kept, so it is not a public part of the handover pack.
  TransferItem: { area: 'HANDOVER_OM', sensitivity: 'INTERNAL' },
  ServiceContact: { area: 'HANDOVER_OM' },
  // H-WF-08. The inspection is a quality record; the certificate, the securities
  // and the final account are contractual, and the last two carry the commercial
  // classification the value chain already uses for the same figures.
  CompletionInspection: { area: 'HANDOVER_OM' },
  CompletionRecord: { area: 'CONTRACTS_CLAIMS', sensitivity: 'LEGAL_L4' },
  CommercialSecurity: { area: 'CONTRACTS_CLAIMS', sensitivity: 'COMMERCIAL_L3' },
  FinalAccount: { area: 'CONTRACTS_CLAIMS', sensitivity: 'COMMERCIAL_L3' },
  // H-WF-09. The manifest and the baseline are the evidence record of what was
  // handed over and are read through the area the regulator already reads
  // through; the activation and the transfer are operational.
  HandoverManifest: { area: 'EVIDENCE_AUDIT' },
  HandoverBaseline: { area: 'EVIDENCE_AUDIT' },
  OperationalActivation: { area: 'HANDOVER_OM' },
  ResidualTransfer: { area: 'HANDOVER_OM' },
  // H-WF-10. Occupant feedback carries no name — the type has no field one
  // could go in — but it does say which part of a building people are unhappy
  // in, which is not a public part of the record.
  AftercarePlan: { area: 'HANDOVER_OM' },
  PerformanceComparison: { area: 'HANDOVER_OM' },
  OccupantFeedback: { area: 'HANDOVER_OM', sensitivity: 'INTERNAL' },
  PostOccupancyReview: { area: 'HANDOVER_OM' },
  TurnoverException: { area: 'QUALITY_COMMISSIONING' },
  PeriodSnapshot: { area: 'PROJECT_SETUP' },
  RecoveryPlan: { area: 'PROGRAMME_BASELINES' },
  ConstructionCompletion: { area: 'PROJECT_SETUP' },
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
  // Not AI_EXECUTION. Who granted a machine unattended authority, over what,
  // until when, and who withdrew it is an enterprise governance record — it
  // must be readable by the people who govern the enterprise, and it must not
  // be reachable by holding the capability to run AI, which every role holds.
  AgentEnvelope: { area: 'ENTERPRISE_STRUCTURE' },
  // The developer surface is enterprise governance, not project data: who holds
  // a credential against this tenancy, and where its data is being sent.
  ApiKey: { area: 'ENTERPRISE_STRUCTURE' },
  WebhookSubscription: { area: 'ENTERPRISE_STRUCTURE' },
  WebhookDelivery: { area: 'ENTERPRISE_STRUCTURE' },

  // Platform-to-person messaging. These records hold email addresses and the
  // consent decisions behind them, so they sit with the operator layer and are
  // marked personal — a delivery log is a list of who was contacted and when.
  MarketingConsent: { area: 'PLATFORM_ADMINISTRATION', sensitivity: 'LEGAL_L4' },
  NewsletterCampaign: { area: 'PLATFORM_ADMINISTRATION' },
  // A blog post. Operator-layer because the marketing site is the platform's
  // own, and carrying no personal data — the prose is written for strangers to
  // read, which is the opposite of everything else in this block.
  SitePost: { area: 'PLATFORM_ADMINISTRATION' },
  NewsletterDelivery: { area: 'PLATFORM_ADMINISTRATION', sensitivity: 'LEGAL_L4' },
  // A support request. Classified under ENTERPRISE_STRUCTURE rather than
  // PLATFORM_ADMINISTRATION on purpose: it belongs to the tenancy that raised
  // it, and the customer who wrote it has to be able to read it back. Putting
  // it in the operator area would make a customer's own request invisible to
  // them, which is the opposite of what a support record is for. Sensitivity is
  // LEGAL_L4 because somebody describing what went wrong writes down whatever
  // they need to — a request is free text and can carry anything.
  SupportRequest: { area: 'ENTERPRISE_STRUCTURE', sensitivity: 'LEGAL_L4' },
  // A reseller or influencer agreement. Operator-layer and commercial: it names
  // a person, the share they take and what has been sent to them.
  GrowthPartner: { area: 'PLATFORM_ADMINISTRATION', sensitivity: 'COMMERCIAL_L3' },
  // The identity documents go out under. Under ENTERPRISE_STRUCTURE because it
  // is the tenancy configuring itself, not a project record — and it is what
  // every generated document for that tenancy will carry.
  ClientBrandingRecord: { area: 'ENTERPRISE_STRUCTURE' },
  // Somebody who asked for twenty minutes. Operator-layer, and personal: a
  // stranger's name, address, employer and what they want to talk about.
  DemoBooking: { area: 'PLATFORM_ADMINISTRATION', sensitivity: 'LEGAL_L4' },
  // A dispatch record names a person and what they were told. The delivery
  // record additionally names their address and whether it reached them, which
  // is why the two are classified apart rather than together.
  AIEvaluation: { area: 'PLATFORM_ADMINISTRATION' },
  // The ingestion record holds the extracted text of whatever was uploaded, so
  // it is classified with the evidence it describes rather than more loosely.
  // A specification and a without-prejudice letter go through the same pipeline.
  IngestedFile: { area: 'EVIDENCE_AUDIT', sensitivity: 'LEGAL_L4' },
  NotificationDispatch: { area: 'PLATFORM_ADMINISTRATION' },
  // The queue holds the rendered payload and the recipients' addresses until it
  // settles, so it is classified with the delivery record rather than with the
  // dispatch summary above.
  NotificationOutbox: { area: 'PLATFORM_ADMINISTRATION', sensitivity: 'LEGAL_L4' },
  NotificationDelivery: { area: 'PLATFORM_ADMINISTRATION', sensitivity: 'LEGAL_L4' },
  NotificationPreferences: { area: 'PLATFORM_ADMINISTRATION', sensitivity: 'LEGAL_L4' },

  // --- Concept, stage 6 ------------------------------------------------------
  //
  // The configuration and the authority matrix are governance records: they say
  // who may decide what on this project, which is the question every later
  // refusal resolves to. Classified with the rest of governance rather than with
  // project control, so a delivery role can read them and no delivery role can
  // rewrite them.
  ProjectConfiguration: { area: 'PROJECT_SETUP' },
  AuthorityMatrix: { area: 'PROJECT_SETUP' },

  // The brief. Readable by everyone who delivers against it — a requirement
  // nobody on the project can see is a requirement nobody will meet.
  ProjectRequirement: { area: 'PROJECT_SETUP' },
  BriefBaseline: { area: 'PROJECT_SETUP' },

  // Due diligence. A survey and its constraints are engineering evidence, and
  // the whole team designs and prices against them.
  SiteSurvey: { area: 'PROJECT_SETUP' },
  SiteConstraint: { area: 'PROJECT_SETUP' },
  InvestigationAction: { area: 'PROJECT_SETUP' },
  DueDiligenceReview: { area: 'PROJECT_SETUP' },

  // Options carry order-of-cost figures and the reasons a client's money went
  // one way rather than another, so they are commercial rather than open.
  FeasibilityOption: { area: 'PROJECT_SETUP', sensitivity: 'COMMERCIAL_L3' },

  // The concept cost position. Commercial by nature: it holds the budget the
  // client is working to and the affordability gap against it.
  ConceptCostPlan: { area: 'BUDGET_COST', sensitivity: 'COMMERCIAL_L3' },
  ConceptCashflow: { area: 'BUDGET_COST', sensitivity: 'COMMERCIAL_L3' },
  ConceptControls: { area: 'BUDGET_COST', sensitivity: 'COMMERCIAL_L3' },
  // The programme is not commercial. Everybody plans against it, and a
  // milestone date hidden behind a commercial band is a date nobody works to.
  MilestoneProgramme: { area: 'PROGRAMME_BASELINES' },

  // Strategy. What will be bought, how, and under what contract — commercially
  // sensitive before the market sees it, and the contract strategy is the
  // decision a legal review is later given.
  ProcurementStrategy: { area: 'PROCUREMENT_AWARD', sensitivity: 'COMMERCIAL_L3' },
  PackageStrategy: { area: 'PROCUREMENT_AWARD', sensitivity: 'COMMERCIAL_L3' },
  ContractStrategy: { area: 'CONTRACTS_CLAIMS', sensitivity: 'LEGAL_L4' },

  // Compliance and risk at concept. The applicability record decides which
  // statutory gateways bind this project, so it is safety-critical reading for
  // everyone rather than a commercial secret.
  ComplianceApplicability: { area: 'SAFETY_RAMS', sensitivity: 'SAFETY_L2' },
  ConceptRiskReview: { area: 'RISK_REGISTER' },

  // The frozen concept position. Audit material: its whole purpose is to be
  // checked later against what was approved.
  ConceptBaseline: { area: 'EVIDENCE_AUDIT' },
};

export function classifyEntity(refType: string): EntityClassification | undefined {
  return ENTITY_ACCESS[refType];
}
