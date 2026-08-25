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
  | 'BUSINESS_DEVELOPMENT'
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
  // --- Business development -------------------------------------------------
  // The head of the chain. A project that came from an opportunity carries its
  // id, so a variation argued about in year three traces back to the decision
  // to chase the job at all.
  def('OPPORTUNITY_REGISTERED', 'Opportunity', 'CREATE', 'BUSINESS_DEVELOPMENT', { creates: true }),
  def('OPPORTUNITY_QUALIFIED', 'Opportunity', 'UPDATE', 'BUSINESS_DEVELOPMENT'),
  // Deciding what the business chases is a governance act. An AI actor may
  // score an opportunity; it may not decide to pursue one.
  def('BID_NO_BID_DECIDED', 'Opportunity', 'APPROVE', 'BUSINESS_DEVELOPMENT'),
  def('OPPORTUNITY_CONVERTED', 'Opportunity', 'UPDATE', 'BUSINESS_DEVELOPMENT'),
  // Corporate memory. Captured on the project that produced it and read across
  // the business, because a lesson only pays for itself on a different job.
  def('LESSON_CAPTURED', 'LessonLearned', 'CREATE', 'RISK_SAFETY', { requiresEvidence: true }),
  // The company's own verified facts. Everything the radar and the bid library
  // assert traces here, so a claim about the business enters the system once,
  // as a governed event with an author.
  def('COMPANY_PROFILE_SET', 'CompanyProfile', 'UPDATE', 'BUSINESS_DEVELOPMENT', { creates: true }),
  def('RADAR_RUN_COMPLETED', 'RadarRun', 'CREATE', 'BUSINESS_DEVELOPMENT'),

  // --- Governance & identity ------------------------------------------------
  def('TENANT_CREATED', 'Tenant', 'CREATE', 'GOVERNANCE'),
  def('ENTERPRISE_CREATED', 'Enterprise', 'CREATE', 'GOVERNANCE'),
  def('USER_CREATED', 'User', 'CREATE', 'GOVERNANCE'),
  def('USER_ROLE_ASSIGNED', 'User', 'UPDATE', 'GOVERNANCE'),
  // Erasure is three events, not one, because the gap between them is the
  // point: a request starts a grace period the person can still call off, and
  // the record has to show which of the two actually happened.
  def('USER_ERASURE_REQUESTED', 'User', 'UPDATE', 'GOVERNANCE'),
  def('USER_ERASURE_CANCELLED', 'User', 'UPDATE', 'GOVERNANCE'),
  def('USER_ERASED', 'User', 'UPDATE', 'GOVERNANCE'),
  def('IDENTITY_SEAT_ASSIGNED', 'Subscription', 'UPDATE', 'GOVERNANCE'),
  def('IDENTITY_SEAT_REVOKED', 'Subscription', 'UPDATE', 'GOVERNANCE'),
  def('SUBSCRIPTION_ACTIVATED', 'Subscription', 'CREATE', 'GOVERNANCE'),
  // Suspension and reactivation. Until this existed, `Subscription.status`
  // could be read but never changed: nothing anywhere set SUSPENDED or
  // CANCELLED, so a customer who stopped paying kept every entitlement they
  // had. Evidence is required because this is the event that turns off a
  // paying customer's platform, and "who decided, when, and on what basis"
  // is the first question asked when it turns out to have been wrong.
  def('SUBSCRIPTION_STATUS_CHANGED', 'Subscription', 'UPDATE', 'GOVERNANCE', { requiresEvidence: true }),
  def('POLICY_UPDATED', 'PermissionPolicy', 'UPDATE', 'GOVERNANCE'),
  def('ACU_CAPS_SET', 'ACUWallet', 'UPDATE', 'GOVERNANCE'),
  // Capacity bought is a commercial fact with money behind it, so it belongs on
  // the record rather than in a counter. Usage is measured from the volume and
  // is not an event: bytes on disk are a measurement, and an event asserting
  // one would be a second source of truth for a number the filesystem already
  // holds.
  def('STORAGE_CAPACITY_PURCHASED', 'StorageEntitlement', 'CREATE', 'GOVERNANCE', { creates: true }),

  // --- Portfolio / project structure ---------------------------------------
  def('PORTFOLIO_CREATED', 'Portfolio', 'CREATE', 'PROJECT_CONTROL'),
  def('PORTFOLIO_TARGETS_SET', 'Portfolio', 'UPDATE', 'PROJECT_CONTROL'),
  def('PROGRAMME_CREATED', 'Programme', 'CREATE', 'PROJECT_CONTROL'),
  def('PROJECT_CREATED', 'Project', 'CREATE', 'PROJECT_CONTROL'),
  def('PROJECT_PHASE_TRANSITIONED', 'Project', 'UPDATE', 'PROJECT_CONTROL', { requiresEvidence: true }),
  def('PACKAGE_CREATED', 'ScopePackage', 'CREATE', 'PROJECT_CONTROL'),
  def('WORKPACKAGE_CREATED', 'WorkPackage', 'CREATE', 'PROJECT_CONTROL'),

  // --- Stage instances and gate reviews ------------------------------------
  //
  // A lifecycle stage is an occupancy with its own record, not a label on the
  // project. `PROJECT_PHASE_TRANSITIONED` above says the project moved; these
  // say which stage it moved out of, what was frozen at that moment, who
  // decided, on what authority, and what was still open when it happened.
  //
  // None is AI-authorable. A gate decision is the point where a named person
  // takes responsibility for a baseline, and an agent that could record one
  // would be an agent that could approve its own proposals. The mandate ceiling
  // is PROPOSE and this is where that matters most.
  def('STAGE_INSTANCE_OPENED', 'StageInstance', 'CREATE', 'PROJECT_CONTROL', { creates: true }),
  def('STAGE_INSTANCE_STATUS_CHANGED', 'StageInstance', 'UPDATE', 'PROJECT_CONTROL'),
  // FREEZE, not UPDATE: locking a stage fixes the baseline hash and the exact
  // component versions that satisfied its gate. Nothing may change afterwards.
  def('STAGE_INSTANCE_LOCKED', 'StageInstance', 'FREEZE', 'PROJECT_CONTROL', { requiresEvidence: true }),
  def('GATE_REVIEW_SUBMITTED', 'GateReview', 'CREATE', 'GOVERNANCE', { creates: true, requiresEvidence: true }),
  def('GATE_REVIEW_DECIDED', 'GateReview', 'APPROVE', 'GOVERNANCE', { requiresEvidence: true }),
  // Re-entering a stage opens a *new* instance. The approved one it supersedes
  // stays exactly as it was approved — re-opening a project must not rewrite
  // the record of the decision that was taken at the time.
  def('STAGE_REOPENED', 'StageInstance', 'CREATE', 'GOVERNANCE', { creates: true, requiresEvidence: true }),

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
  // A reply is a distinct fact with its own author and its own date, and on the
  // letters where silence is acceptance the date is the whole point. Recording
  // it as another ISSUE would lose who answered and when.
  def('CORRESPONDENCE_ANSWERED', 'Correspondence', 'UPDATE', 'DESIGN', { requiresEvidence: true }),

  // --- Tender & procurement -------------------------------------------------
  def('TAKEOFF_COMPLETED', 'Takeoff', 'AI_EXECUTE', 'PROCUREMENT', { aiAllowed: true, requiresEvidence: true }),
  def('BOQITEM_CREATED_FROM_TAKEOFF', 'BoQItem', 'CREATE', 'PROCUREMENT', { aiAllowed: true, requiresEvidence: true }),
  def('SCHEDULE_BUILT', 'PricingSchedule', 'CREATE', 'PROCUREMENT', { aiAllowed: true }),
  def('SCHEDULE_ROUTE_ASSIGNED', 'PricingSchedule', 'UPDATE', 'PROCUREMENT'),
  def('ESTIMATE_CREATED', 'Estimate', 'CREATE', 'PROCUREMENT', { aiAllowed: true }),
  def('ESTIMATE_FROZEN', 'Estimate', 'FREEZE', 'PROCUREMENT', { requiresEvidence: true }),
  // The response to a client enquiry. The model drafts the words; the price on
  // it comes from the estimate, which was committed first.
  def('TENDER_RESPONSE_DRAFTED', 'TenderResponse', 'CREATE', 'PROCUREMENT', { aiAllowed: true }),
  // The invitation read properly: every requirement with an owner, and the
  // commercial terms assessed against what this business can actually carry.
  def('ITT_ANALYSED', 'ITTAnalysis', 'CREATE', 'PROCUREMENT'),
  // Never bid without a cash model. The peak funding requirement is a
  // different question from the margin, and it is the one that closes
  // companies, so it lands on the thread beside the price.
  def('TENDER_FUNDING_MODELLED', 'FundingModel', 'CREATE', 'COMMERCIAL'),
  // The supply chain register sits in front of every enquiry: an RFQ cannot be
  // issued to a firm that is not on it and currently prequalified.
  def('SUPPLIER_REGISTERED', 'Supplier', 'CREATE', 'PROCUREMENT'),
  def('SUPPLIER_PREQUALIFIED', 'Supplier', 'APPROVE', 'PROCUREMENT', { requiresEvidence: true }),
  def('SUPPLIER_SUSPENDED', 'Supplier', 'UPDATE', 'PROCUREMENT'),
  // A framework is a standing relationship with an award rule. Admission and
  // every award land on the same entity so distribution is auditable.
  def('FRAMEWORK_CREATED', 'Framework', 'CREATE', 'PROCUREMENT'),
  def('FRAMEWORK_SUPPLIER_ADMITTED', 'Framework', 'UPDATE', 'PROCUREMENT'),
  def('FRAMEWORK_AWARD_RECORDED', 'Framework', 'UPDATE', 'PROCUREMENT', { requiresEvidence: true }),
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
  // The weekly review is what makes a lookahead Last Planner rather than a
  // rolling bar chart: the team says which promises were kept and, where one
  // was not, why. The reason cannot be derived from progress — a task at 60%
  // and a task nobody started both fail the promise, for different reasons that
  // lead to different fixes — so the review is its own event.
  def('LOOKAHEAD_REVIEWED', 'LookaheadPlan', 'UPDATE', 'DELIVERY'),
  def('CONSTRAINT_RAISED', 'Constraint', 'CREATE', 'DELIVERY'),
  // A constraints log that can only grow is a list. Closure carries who cleared
  // it and when, which is what turns the log into a measure of how long the
  // business takes to unblock its own work.
  def('CONSTRAINT_CLOSED', 'Constraint', 'UPDATE', 'DELIVERY'),
  def('PROGRESS_RECORDED', 'ProgressMeasurement', 'CREATE', 'DELIVERY', { requiresEvidence: true }),
  def('SITE_DIARY_RECORDED', 'SiteDiary', 'CREATE', 'DELIVERY', { requiresEvidence: true }),
  def('SITE_OBSERVATION_CAPTURED', 'SiteObservation', 'CREATE', 'DELIVERY', { aiAllowed: true, requiresEvidence: true }),
  def('SITE_OBSERVATION_CLOSED', 'SiteObservation', 'UPDATE', 'DELIVERY'),
  // Quality assurance: the plan, the hold points, and the record against them.
  def('ITP_CREATED', 'InspectionPlan', 'CREATE', 'DELIVERY', { creates: true }),
  def('ITP_STAGE_UPDATED', 'InspectionPlan', 'UPDATE', 'DELIVERY'),
  def('INSPECTION_COMPLETED', 'QualityInspection', 'CREATE', 'DELIVERY', { requiresEvidence: true }),
  def('SNAG_RAISED', 'Snag', 'CREATE', 'DELIVERY', { requiresEvidence: true }),
  def('SNAG_DISPATCHED', 'Snag', 'UPDATE', 'DELIVERY'),
  def('SNAG_CLOSED', 'Snag', 'APPROVE', 'DELIVERY', { requiresEvidence: true }),
  def('NCR_RAISED', 'NCR', 'CREATE', 'DELIVERY', { requiresEvidence: true }),
  // Accepting work that does not meet specification is a decision with a name
  // against it, so closure is an approval and carries its own evidence.
  def('NCR_CLOSED', 'NCR', 'APPROVE', 'DELIVERY', { requiresEvidence: true }),
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
  // Set-off against a subcontractor. Evidence is mandatory: a contra charge
  // without a record of the cost it recovers is a deduction the payer cannot
  // substantiate, and it is the first thing an adjudicator asks for.
  def('CONTRA_CHARGE_RAISED', 'ContraCharge', 'CREATE', 'COMMERCIAL', { requiresEvidence: true }),

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

  // Transactional communication. Separate from the newsletter because the
  // obligation is different: a marketing send is subject to consent, and a
  // notice that an account was locked is subject to nothing — the recipient is
  // entitled to it whatever they have muted. Recording the dispatch is what
  // makes "we told you on the 14th" answerable, which is the whole point of
  // keeping it here rather than in a log that rotates.
  //
  // No AI actor may author either. An agent that could set somebody's
  // notification preferences could silence the alert about what it did next.
  def('NOTIFICATION_DISPATCHED', 'NotificationDispatch', 'ISSUE', 'GOVERNANCE', { creates: true }),
  def('NOTIFICATION_DELIVERY_RECORDED', 'NotificationDelivery', 'CREATE', 'GOVERNANCE'),
  def('NOTIFICATION_PREFERENCES_SET', 'NotificationPreferences', 'UPDATE', 'GOVERNANCE', { creates: true }),

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
  def('DISPUTE_REFERRED', 'Dispute', 'UPDATE', 'CONTRACTS_CLAIMS', { requiresEvidence: true }),
  def('DISPUTE_DECIDED', 'Dispute', 'UPDATE', 'CONTRACTS_CLAIMS', { requiresEvidence: true }),

  // --- Risk, safety, compliance --------------------------------------------
  def('RISK_REGISTERED', 'RiskRegisterItem', 'CREATE', 'RISK_SAFETY', { aiAllowed: true }),
  def('RISK_SCORED', 'RiskRegisterItem', 'UPDATE', 'RISK_SAFETY', { aiAllowed: true }),
  def('RISK_MITIGATION_SET', 'RiskRegisterItem', 'UPDATE', 'RISK_SAFETY'),
  // CDM 2015. An agent may draft; a competent person approves. The approval
  // events below deliberately withhold aiAllowed, so the catalogue refuses an
  // AI actor authoring a safety sign-off even if a caller tried.
  def('CDM_DOCUMENT_DRAFTED', 'CDMDocument', 'CREATE', 'RISK_SAFETY', { aiAllowed: true, creates: true }),
  def('CDM_DOCUMENT_APPROVED', 'CDMDocument', 'APPROVE', 'RISK_SAFETY', { requiresEvidence: true }),
  def('INDUCTION_RECORDED', 'Induction', 'CREATE', 'RISK_SAFETY'),
  def('TOOLBOX_TALK_DELIVERED', 'ToolboxTalk', 'CREATE', 'RISK_SAFETY'),
  def('RAMS_DRAFTED', 'RAMS', 'CREATE', 'RISK_SAFETY', { aiAllowed: true }),
  def('RAMS_APPROVED', 'RAMS', 'APPROVE', 'RISK_SAFETY', { requiresEvidence: true }),
  def('RAMS_ACKNOWLEDGED', 'RAMS', 'UPDATE', 'RISK_SAFETY', { requiresEvidence: true }),
  def('SAFETY_OBSERVATION_LOGGED', 'SafetyObservation', 'CREATE', 'RISK_SAFETY', { aiAllowed: true, requiresEvidence: true }),
  def('INCIDENT_RECORDED', 'Incident', 'CREATE', 'RISK_SAFETY', { requiresEvidence: true }),
  def('SAFETY_FORECAST_PRODUCED', 'SafetyForecast', 'AI_EXECUTE', 'RISK_SAFETY', { aiAllowed: true }),
  def('COMPETENCY_RECORDED', 'Competency', 'CREATE', 'RISK_SAFETY', { requiresEvidence: true }),
  // A permit is an authorisation to do something that would otherwise be unsafe.
  // Evidence is mandatory and no AI actor may issue one: a permit signed by a
  // model is not a competent person's signature, which is the same rule the
  // catalogue already applies to a method statement.
  def('PERMIT_ISSUED', 'Permit', 'ISSUE', 'RISK_SAFETY', { requiresEvidence: true, creates: true }),
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

  // What a model read out of a held file, and what a person did about it. Three
  // events rather than one because a draft that was rejected is as much a part
  // of the record as one that was accepted: "the machine read this and we did
  // not agree" is exactly the question asked three years later.
  //
  // Only the first is AI-authored. Confirming an extraction is a human act with
  // a human's name on it, which is the same rule that keeps agents at PROPOSE.
  def('PERCEPTION_DRAFT_PRODUCED', 'PerceptionDraft', 'AI_EXECUTE', 'EVIDENCE', { aiAllowed: true, requiresEvidence: true, creates: true }),
  def('PERCEPTION_DRAFT_CONFIRMED', 'PerceptionDraft', 'APPROVE', 'EVIDENCE', { requiresEvidence: true }),
  def('PERCEPTION_DRAFT_DISCARDED', 'PerceptionDraft', 'REJECT', 'EVIDENCE', { requiresEvidence: true }),

  // Signing. None of these is AI-authorable, and that is the point rather than
  // an oversight: a signature is a person agreeing to something, and an agent
  // whose mandate stops at PROPOSE cannot be the one who agreed.
  def('SIGNATURE_REQUESTED', 'SignatureRequest', 'CREATE', 'GOVERNANCE', { requiresEvidence: true }),
  def('SIGNATURE_REQUEST_PROGRESSED', 'SignatureRequest', 'UPDATE', 'GOVERNANCE', { requiresEvidence: true }),
  def('SIGNATURE_REQUEST_SETTLED', 'SignatureRequest', 'UPDATE', 'GOVERNANCE', { requiresEvidence: true }),
  def('DOCUMENT_SIGNED', 'Signature', 'APPROVE', 'GOVERNANCE', { requiresEvidence: true, creates: true }),
  def('SIGNATURE_DECLINED', 'Signature', 'REJECT', 'GOVERNANCE', { requiresEvidence: true, creates: true }),
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
  // What the asset costs to run. The one FM question with no record behind it:
  // everything else on that centre was derivable and this had to be captured,
  // because deriving a cost nobody recorded is inventing one.
  def('OPERATING_COST_RECORDED', 'OperatingCost', 'CREATE', 'HANDOVER_OM', { requiresEvidence: true }),

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
  // Money entering the platform, in two halves that must never be one event.
  //
  // A request carries no money: it is a customer saying they would like credit.
  // A receipt is the claim that money arrived, and it is the only thing that
  // moves a balance. Collapsing the two is precisely what the old top-up route
  // did — it took an amount from a request body and credited the wallet with
  // it, which made the console's top-up button a mint.
  def('TOPUP_REQUESTED', 'TopUpIntent', 'CREATE', 'AI_BILLING', { creates: true }),
  def('TOPUP_SETTLED', 'TopUpIntent', 'UPDATE', 'AI_BILLING'),
  def('PAYMENT_RECEIVED', 'PaymentReceipt', 'CREATE', 'AI_BILLING', { creates: true }),
];

const BY_CODE = new Map(EVENT_TYPES.map((t) => [t.code, t]));

export function lookupEventType(code: string): EventTypeDefinition | undefined {
  return BY_CODE.get(code);
}

export function eventTypeCodes(): string[] {
  return EVENT_TYPES.map((t) => t.code);
}
