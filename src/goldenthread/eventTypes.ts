/**
 * eventTypes.catalog — the single authoritative registry of permitted Golden
 * Thread events. Any event not listed here is rejected at both the API and the
 * orchestrator. This is what stops the event log from becoming a free-text dump.
 */

export type EventAction =
  | 'CREATE'
  | 'UPDATE'
  | 'DELETE'
  | 'APPROVE'
  | 'REJECT'
  | 'FREEZE'
  | 'ISSUE'
  | 'IMPORT'
  | 'EXECUTE'
  | 'AI_EXECUTE';

export type EventTypeDefinition = {
  code: string;
  entity: string;
  action: EventAction;
  /** May this event be produced by an AI actor? */
  aiAllowed: boolean;
  /** Must the event carry at least one evidenceRef? Enforced hard. */
  requiresEvidence: boolean;
  /**
   * True when this event brings its entity into existence despite carrying an
   * action other than CREATE/IMPORT — an adjudication is recorded by approving
   * it, a notice by issuing it. Marked explicitly so that UPDATE still means
   * "the entity must already exist".
   */
  creates: boolean;
  /** Lifecycle phase this event belongs to, for phase-gate reporting. */
  group: EventGroup;
};

export type EventGroup =
  | 'GOVERNANCE'
  | 'PROJECT_CONTROL'
  | 'DESIGN'
  | 'PROCUREMENT'
  | 'DELIVERY'
  | 'COMMERCIAL'
  | 'CONTRACTS_CLAIMS'
  | 'RISK_SAFETY'
  | 'BIM_TWIN'
  | 'EVIDENCE'
  | 'COMMISSIONING'
  | 'HANDOVER_OM'
  | 'AI_BILLING';

function def(
  code: string,
  entity: string,
  action: EventAction,
  group: EventGroup,
  options: { aiAllowed?: boolean; requiresEvidence?: boolean; creates?: boolean } = {},
): EventTypeDefinition {
  return {
    code,
    entity,
    action,
    group,
    aiAllowed: options.aiAllowed ?? false,
    requiresEvidence: options.requiresEvidence ?? false,
    creates: options.creates ?? false,
  };
}

export const EVENT_TYPES: EventTypeDefinition[] = [
  // --- Governance & identity ------------------------------------------------
  def('TENANT_CREATED', 'Tenant', 'CREATE', 'GOVERNANCE'),
  def('ENTERPRISE_CREATED', 'Enterprise', 'CREATE', 'GOVERNANCE'),
  def('USER_CREATED', 'User', 'CREATE', 'GOVERNANCE'),
  def('USER_ROLE_ASSIGNED', 'User', 'UPDATE', 'GOVERNANCE'),
  def('IDENTITY_SEAT_ASSIGNED', 'Subscription', 'UPDATE', 'GOVERNANCE'),
  def('IDENTITY_SEAT_REVOKED', 'Subscription', 'UPDATE', 'GOVERNANCE'),
  def('SUBSCRIPTION_ACTIVATED', 'Subscription', 'CREATE', 'GOVERNANCE'),
  def('POLICY_UPDATED', 'PermissionPolicy', 'UPDATE', 'GOVERNANCE'),

  // --- Portfolio / project structure ---------------------------------------
  def('PORTFOLIO_CREATED', 'Portfolio', 'CREATE', 'PROJECT_CONTROL'),
  def('PORTFOLIO_TARGETS_SET', 'Portfolio', 'UPDATE', 'PROJECT_CONTROL'),
  def('PROGRAMME_CREATED', 'Programme', 'CREATE', 'PROJECT_CONTROL'),
  def('PROJECT_CREATED', 'Project', 'CREATE', 'PROJECT_CONTROL'),
  def('PROJECT_PHASE_TRANSITIONED', 'Project', 'UPDATE', 'PROJECT_CONTROL', { requiresEvidence: true }),
  def('PACKAGE_CREATED', 'ScopePackage', 'CREATE', 'PROJECT_CONTROL'),
  def('WORKPACKAGE_CREATED', 'WorkPackage', 'CREATE', 'PROJECT_CONTROL'),

  // --- Design & information ------------------------------------------------
  def('DRAWING_REGISTERED', 'Drawing', 'IMPORT', 'DESIGN', { aiAllowed: true, requiresEvidence: true }),
  def('DRAWING_SUPERSEDED', 'Drawing', 'UPDATE', 'DESIGN', { requiresEvidence: true }),
  def('DRAWING_MARKUP_ADDED', 'DrawingMarkup', 'CREATE', 'DESIGN', { aiAllowed: true, requiresEvidence: true }),
  def('SPECIFICATION_INGESTED', 'Specification', 'IMPORT', 'DESIGN', { aiAllowed: true, requiresEvidence: true }),
  def('SPEC_CLAUSE_EXTRACTED', 'SpecClause', 'CREATE', 'DESIGN', { aiAllowed: true, requiresEvidence: true }),
  def('DESIGN_MATURITY_ASSESSED', 'DesignMaturityAssessment', 'CREATE', 'DESIGN', { aiAllowed: true, requiresEvidence: true }),
  def('RFI_RAISED', 'RFI', 'CREATE', 'DESIGN', { aiAllowed: true }),
  def('RFI_ANSWERED', 'RFI', 'UPDATE', 'DESIGN', { requiresEvidence: true }),
  def('CORRESPONDENCE_ISSUED', 'Correspondence', 'ISSUE', 'DESIGN', { aiAllowed: true, creates: true }),

  // --- Tender & procurement -------------------------------------------------
  def('TAKEOFF_COMPLETED', 'Takeoff', 'AI_EXECUTE', 'PROCUREMENT', { aiAllowed: true, requiresEvidence: true }),
  def('BOQITEM_CREATED_FROM_TAKEOFF', 'BoQItem', 'CREATE', 'PROCUREMENT', { aiAllowed: true, requiresEvidence: true }),
  def('SCHEDULE_BUILT', 'PricingSchedule', 'CREATE', 'PROCUREMENT', { aiAllowed: true }),
  def('SCHEDULE_ROUTE_ASSIGNED', 'PricingSchedule', 'UPDATE', 'PROCUREMENT'),
  def('ESTIMATE_CREATED', 'Estimate', 'CREATE', 'PROCUREMENT', { aiAllowed: true }),
  def('ESTIMATE_FROZEN', 'Estimate', 'FREEZE', 'PROCUREMENT', { requiresEvidence: true }),
  def('RFQ_CREATED', 'RFQ', 'CREATE', 'PROCUREMENT'),
  def('TENDER_PACKAGE_COMPOSED', 'TenderPackage', 'CREATE', 'PROCUREMENT', { aiAllowed: true }),
  def('RFQ_ISSUED', 'RFQ', 'ISSUE', 'PROCUREMENT', { requiresEvidence: true }),
  def('RFQ_ACKNOWLEDGED', 'RFQ', 'UPDATE', 'PROCUREMENT'),
  def('CLARIFICATION_RAISED', 'Clarification', 'CREATE', 'PROCUREMENT', { aiAllowed: true }),
  def('CLARIFICATION_ANSWERED', 'Clarification', 'UPDATE', 'PROCUREMENT'),
  def('SUBMISSION_RECEIVED', 'SupplierSubmission', 'CREATE', 'PROCUREMENT', { requiresEvidence: true }),
  def('SUBMISSION_NORMALISED', 'SupplierSubmission', 'AI_EXECUTE', 'PROCUREMENT', { aiAllowed: true }),
  def('BIDS_EVALUATED', 'BidEvaluation', 'EXECUTE', 'PROCUREMENT', { aiAllowed: true, requiresEvidence: true }),
  def('MASTER_PRICING_CONSOLIDATED', 'MasterPricing', 'CREATE', 'PROCUREMENT'),
  def('ADJUDICATION_COMPLETED', 'Adjudication', 'APPROVE', 'PROCUREMENT', { requiresEvidence: true, creates: true }),
  def('BID_PACK_COMPILED', 'BidSubmissionPack', 'CREATE', 'PROCUREMENT', { requiresEvidence: true }),
  def('BID_PACK_LOCKED', 'BidSubmissionPack', 'FREEZE', 'PROCUREMENT', { requiresEvidence: true }),
  def('RFQ_AWARDED', 'RFQ', 'APPROVE', 'PROCUREMENT', { requiresEvidence: true }),
  def('SUBCONTRACT_ASSEMBLED', 'Subcontract', 'CREATE', 'PROCUREMENT'),
  def('SUBCONTRACT_EXECUTED', 'Subcontract', 'APPROVE', 'PROCUREMENT', { requiresEvidence: true }),
  def('COMMITMENT_RAISED', 'Commitment', 'CREATE', 'PROCUREMENT'),

  // --- Contracts ------------------------------------------------------------
  def('CONTRACT_CREATED', 'Contract', 'CREATE', 'CONTRACTS_CLAIMS'),
  def('CONTRACT_INGESTED', 'Contract', 'IMPORT', 'CONTRACTS_CLAIMS', { aiAllowed: true, requiresEvidence: true }),
  def('CONTRACT_CLAUSE_EXTRACTED', 'ContractClause', 'CREATE', 'CONTRACTS_CLAIMS', { aiAllowed: true, requiresEvidence: true }),
  def('OBLIGATION_REGISTERED', 'Obligation', 'CREATE', 'CONTRACTS_CLAIMS', { aiAllowed: true }),
  def('NOTICE_ISSUED', 'Notice', 'ISSUE', 'CONTRACTS_CLAIMS', { requiresEvidence: true, creates: true }),

  // --- Programme & delivery -------------------------------------------------
  def('WBS_GENERATED', 'WorkPackage', 'AI_EXECUTE', 'DELIVERY', { aiAllowed: true }),
  def('TASK_CREATED', 'Task', 'CREATE', 'DELIVERY'),
  def('TASK_UPDATED', 'Task', 'UPDATE', 'DELIVERY'),
  def('DEPENDENCY_CREATED', 'Dependency', 'CREATE', 'DELIVERY'),
  def('PROGRAMME_BASELINE_APPROVED', 'ProgrammeBaseline', 'APPROVE', 'DELIVERY', { requiresEvidence: true, creates: true }),
  def('PROGRAMME_RECALCULATED', 'ProgrammeBaseline', 'EXECUTE', 'DELIVERY'),
  def('LOOKAHEAD_PUBLISHED', 'LookaheadPlan', 'CREATE', 'DELIVERY'),
  def('CONSTRAINT_RAISED', 'Constraint', 'CREATE', 'DELIVERY'),
  def('PROGRESS_RECORDED', 'ProgressMeasurement', 'CREATE', 'DELIVERY', { requiresEvidence: true }),
  def('SITE_DIARY_RECORDED', 'SiteDiary', 'CREATE', 'DELIVERY', { requiresEvidence: true }),
  def('SITE_OBSERVATION_CAPTURED', 'SiteObservation', 'CREATE', 'DELIVERY', { aiAllowed: true, requiresEvidence: true }),
  def('INSPECTION_COMPLETED', 'QualityInspection', 'CREATE', 'DELIVERY', { requiresEvidence: true }),
  def('SNAG_RAISED', 'Snag', 'CREATE', 'DELIVERY', { requiresEvidence: true }),
  def('SNAG_DISPATCHED', 'Snag', 'UPDATE', 'DELIVERY'),
  def('SNAG_CLOSED', 'Snag', 'APPROVE', 'DELIVERY', { requiresEvidence: true }),
  def('NCR_RAISED', 'NCR', 'CREATE', 'DELIVERY', { requiresEvidence: true }),
  def('DELAY_RISK_FORECAST', 'DelayRiskSnapshot', 'AI_EXECUTE', 'DELIVERY', { aiAllowed: true }),
  def('DELAYEVENT_RECORDED', 'DelayEvent', 'CREATE', 'DELIVERY', { aiAllowed: true, requiresEvidence: true }),

  // --- Commercial -----------------------------------------------------------
  def('BUDGET_BASELINE_APPROVED', 'Budget', 'APPROVE', 'COMMERCIAL', { requiresEvidence: true, creates: true }),
  def('ACTUAL_COST_POSTED', 'ActualCost', 'CREATE', 'COMMERCIAL'),
  def('EVM_SNAPSHOT_TAKEN', 'EarnedValueSnapshot', 'CREATE', 'COMMERCIAL', { aiAllowed: true }),
  def('CVR_PUBLISHED', 'CVR', 'CREATE', 'COMMERCIAL', { aiAllowed: true }),
  def('CASHFLOW_FORECAST_UPDATED', 'CashflowForecast', 'UPDATE', 'COMMERCIAL', { aiAllowed: true, creates: true }),
  def('PAYMENT_CYCLE_GENERATED', 'PaymentCycle', 'CREATE', 'COMMERCIAL'),
  def('APPLICATION_SUBMITTED', 'PaymentApplication', 'ISSUE', 'COMMERCIAL', { requiresEvidence: true, creates: true }),
  def('PAYMENT_NOTICE_ISSUED', 'PaymentNotice', 'ISSUE', 'COMMERCIAL', { requiresEvidence: true, creates: true }),
  def('PAY_LESS_NOTICE_ISSUED', 'PayLessNotice', 'ISSUE', 'COMMERCIAL', { requiresEvidence: true, creates: true }),
  def('PAYMENT_CERTIFIED', 'PaymentCertificate', 'APPROVE', 'COMMERCIAL', { requiresEvidence: true, creates: true }),
  def('APPLICATION_CERTIFIED', 'PaymentApplication', 'APPROVE', 'COMMERCIAL'),
  def('LEDGER_ENTRY_POSTED', 'LedgerEntry', 'CREATE', 'COMMERCIAL'),

  // --- Agent runtime --------------------------------------------------------
  def('AGENT_RUN_COMPLETED', 'AgentRun', 'EXECUTE', 'AI_BILLING', { aiAllowed: true, creates: true }),
  def('AGENT_PROPOSAL_RAISED', 'AgentProposal', 'CREATE', 'AI_BILLING', { aiAllowed: true, creates: true }),
  // Decisions are human by definition — an AI actor committing one is refused
  // by the ledger, which is what stops an agent approving its own proposal.
  def('AGENT_PROPOSAL_APPROVED', 'AgentProposal', 'APPROVE', 'AI_BILLING'),
  def('AGENT_PROPOSAL_REJECTED', 'AgentProposal', 'APPROVE', 'AI_BILLING'),
  def('AGENT_PROPOSAL_EXECUTED', 'AgentProposal', 'UPDATE', 'AI_BILLING'),

  // --- Platform-to-person messaging -----------------------------------------
  // Consent is a data-protection record: what a person decided, when, and
  // through which route. It is governance rather than marketing, which is why
  // it lives here and why no AI actor may author it — an agent must never be
  // able to opt somebody into being written to.
  def('MARKETING_CONSENT_SET', 'MarketingConsent', 'UPDATE', 'GOVERNANCE', { creates: true }),
  def('NEWSLETTER_CAMPAIGN_ISSUED', 'NewsletterCampaign', 'ISSUE', 'GOVERNANCE', { creates: true }),
  def('NEWSLETTER_DELIVERY_RECORDED', 'NewsletterDelivery', 'CREATE', 'GOVERNANCE'),

  // --- Change, variation, claims -------------------------------------------
  def('CHANGE_REQUEST_SUBMITTED', 'ChangeRequest', 'CREATE', 'CONTRACTS_CLAIMS', { requiresEvidence: true }),
  def('IMPACT_ASSESSED', 'ImpactAssessment', 'AI_EXECUTE', 'CONTRACTS_CLAIMS', { aiAllowed: true, requiresEvidence: true }),
  def('CHANGE_REQUEST_APPROVED', 'ChangeRequest', 'APPROVE', 'CONTRACTS_CLAIMS', { requiresEvidence: true }),
  def('CHANGE_REQUEST_REJECTED', 'ChangeRequest', 'REJECT', 'CONTRACTS_CLAIMS', { requiresEvidence: true }),
  def('VARIATION_INSTRUCTED', 'Variation', 'ISSUE', 'CONTRACTS_CLAIMS', { requiresEvidence: true, creates: true }),
  def('VARIATION_VALUED', 'Variation', 'UPDATE', 'CONTRACTS_CLAIMS', { aiAllowed: true, requiresEvidence: true }),
  def('DOMESTIC_VARIATION_FLAGGED', 'Variation', 'CREATE', 'CONTRACTS_CLAIMS', { requiresEvidence: true }),
  def('CLAIM_OPENED', 'Claim', 'CREATE', 'CONTRACTS_CLAIMS', { requiresEvidence: true }),
  def('CLAIM_ASSESSED', 'Claim', 'AI_EXECUTE', 'CONTRACTS_CLAIMS', { aiAllowed: true, requiresEvidence: true }),
  def('CLAIM_EVIDENCEPACK_BUILT', 'Claim', 'AI_EXECUTE', 'CONTRACTS_CLAIMS', { aiAllowed: true, requiresEvidence: true }),
  def('DISPUTE_OPENED', 'Dispute', 'CREATE', 'CONTRACTS_CLAIMS', { requiresEvidence: true }),

  // --- Risk, safety, compliance --------------------------------------------
  def('RISK_REGISTERED', 'RiskRegisterItem', 'CREATE', 'RISK_SAFETY', { aiAllowed: true }),
  def('RISK_SCORED', 'RiskRegisterItem', 'UPDATE', 'RISK_SAFETY', { aiAllowed: true }),
  def('RISK_MITIGATION_SET', 'RiskRegisterItem', 'UPDATE', 'RISK_SAFETY'),
  def('RAMS_DRAFTED', 'RAMS', 'CREATE', 'RISK_SAFETY', { aiAllowed: true }),
  def('RAMS_APPROVED', 'RAMS', 'APPROVE', 'RISK_SAFETY', { aiAllowed: true, requiresEvidence: true }),
  def('RAMS_ACKNOWLEDGED', 'RAMS', 'UPDATE', 'RISK_SAFETY', { requiresEvidence: true }),
  def('SAFETY_OBSERVATION_LOGGED', 'SafetyObservation', 'CREATE', 'RISK_SAFETY', { aiAllowed: true, requiresEvidence: true }),
  def('INCIDENT_RECORDED', 'Incident', 'CREATE', 'RISK_SAFETY', { requiresEvidence: true }),
  def('SAFETY_FORECAST_PRODUCED', 'SafetyForecast', 'AI_EXECUTE', 'RISK_SAFETY', { aiAllowed: true }),
  def('COMPETENCY_RECORDED', 'Competency', 'CREATE', 'RISK_SAFETY', { requiresEvidence: true }),
  def('TRAINING_COMPLETED', 'TrainingRecord', 'CREATE', 'RISK_SAFETY', { requiresEvidence: true }),

  // --- BIM & digital twin ---------------------------------------------------
  def('MODEL_INGESTED', 'Model', 'IMPORT', 'BIM_TWIN', { aiAllowed: true, requiresEvidence: true }),
  def('CLASH_DETECTED', 'Clash', 'AI_EXECUTE', 'BIM_TWIN', { aiAllowed: true, requiresEvidence: true }),
  def('CLASH_RESOLVED', 'Clash', 'APPROVE', 'BIM_TWIN', { requiresEvidence: true }),
  def('TWIN_STATE_UPDATED', 'DigitalTwinState', 'UPDATE', 'BIM_TWIN', { aiAllowed: true, creates: true }),
  def('SENSOR_READING_INGESTED', 'SensorReading', 'IMPORT', 'BIM_TWIN'),
  def('AS_BUILT_GENERATED', 'Model', 'AI_EXECUTE', 'BIM_TWIN', { aiAllowed: true, requiresEvidence: true }),

  // --- Evidence & integrity -------------------------------------------------
  def('EVIDENCE_REGISTERED', 'EvidenceItem', 'CREATE', 'EVIDENCE', { requiresEvidence: false }),
  def('EXPORT_GENERATED', 'Export', 'EXECUTE', 'EVIDENCE', { requiresEvidence: true }),
  def('REPLAY_SNAPSHOT_TAKEN', 'ReplaySnapshot', 'EXECUTE', 'EVIDENCE'),

  // --- Commissioning, handover, O&M ----------------------------------------
  def('COMMISSIONING_TEST_RECORDED', 'CommissioningTest', 'CREATE', 'COMMISSIONING', { requiresEvidence: true }),
  def('SYSTEM_ACCEPTED', 'CommissioningTest', 'APPROVE', 'COMMISSIONING', { requiresEvidence: true }),
  def('HANDOVER_PACK_COMPILED', 'HandoverPack', 'CREATE', 'HANDOVER_OM', { aiAllowed: true, requiresEvidence: true }),
  def('HANDOVER_ACCEPTED', 'HandoverPack', 'APPROVE', 'HANDOVER_OM', { requiresEvidence: true }),
  def('ASSET_REGISTERED', 'AssetRegisterItem', 'CREATE', 'HANDOVER_OM'),
  def('OM_MANUAL_PUBLISHED', 'OMManual', 'CREATE', 'HANDOVER_OM', { aiAllowed: true, requiresEvidence: true }),
  def('WARRANTY_REGISTERED', 'Warranty', 'CREATE', 'HANDOVER_OM', { requiresEvidence: true }),
  def('DEFECT_RAISED', 'Defect', 'CREATE', 'HANDOVER_OM', { requiresEvidence: true }),
  def('WORK_ORDER_RAISED', 'WorkOrder', 'CREATE', 'HANDOVER_OM'),
  def('WORK_ORDER_CLOSED', 'WorkOrder', 'APPROVE', 'HANDOVER_OM', { requiresEvidence: true }),
  def('MAINTENANCE_FORECAST_PRODUCED', 'MaintenanceForecast', 'AI_EXECUTE', 'HANDOVER_OM', { aiAllowed: true }),

  // --- AI & billing ---------------------------------------------------------
  def('AI_REQUEST_QUEUED', 'AIRequest', 'CREATE', 'AI_BILLING'),
  def('AI_EXECUTION_COMPLETED', 'AIExecution', 'AI_EXECUTE', 'AI_BILLING', { aiAllowed: true }),
  def('AI_EXECUTION_FAILED', 'AIExecution', 'UPDATE', 'AI_BILLING', { aiAllowed: true }),
  def('ACU_WALLET_OPENED', 'ACUWallet', 'CREATE', 'AI_BILLING'),
  def('ACU_TOPPED_UP', 'ACUWallet', 'UPDATE', 'AI_BILLING'),
  def('ACU_HELD', 'ACUWallet', 'UPDATE', 'AI_BILLING'),
  def('ACU_CONSUMED', 'ACUWallet', 'UPDATE', 'AI_BILLING'),
  def('ACU_RELEASED', 'ACUWallet', 'UPDATE', 'AI_BILLING'),
  def('ACU_CAP_BREACHED', 'ACUWallet', 'UPDATE', 'AI_BILLING'),
  def('ACU_ALERT_RAISED', 'ACUWallet', 'UPDATE', 'AI_BILLING'),
  def('INVOICE_ISSUED', 'Invoice', 'ISSUE', 'AI_BILLING', { requiresEvidence: true, creates: true }),
];

const BY_CODE = new Map(EVENT_TYPES.map((t) => [t.code, t]));

export function lookupEventType(code: string): EventTypeDefinition | undefined {
  return BY_CODE.get(code);
}

export function eventTypeCodes(): string[] {
  return EVENT_TYPES.map((t) => t.code);
}
