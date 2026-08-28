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
  // --- Design review -------------------------------------------------------
  //
  // The stage could hold documents and answer questions about them, and had no
  // way to review one. A deliverable went from registered to used with nothing
  // in between, which is the gap an uncoordinated package is built through.
  //
  // None of these is AI-authorable. A model may draft a comment and locate its
  // evidence; the raising of it is a professional opinion with a name against
  // it, and the acceptance of a design is a decision.
  def('DESIGN_SUBMITTED_FOR_REVIEW', 'DesignReviewCycle', 'ISSUE', 'DESIGN', { creates: true }),
  def('REVIEW_COMMENT_RAISED', 'DesignReviewComment', 'CREATE', 'DESIGN', { creates: true }),
  // Both the author's answer and the checker's agreement that it settles the
  // comment. One event type, because both are the same act on the same record —
  // and the record carries which of the two happened.
  def('COMMENT_DISPOSITIONED', 'DesignReviewComment', 'UPDATE', 'DESIGN'),
  def('DESIGN_ACCEPTED', 'DesignReviewCycle', 'APPROVE', 'DESIGN'),
  def('DESIGN_REJECTED', 'DesignReviewCycle', 'REJECT', 'DESIGN'),
  // D-WF-01. The plan for who produces what information, by when, for whom.
  // Deliverables and interfaces live on the package rather than as entities of
  // their own: a deliverable is meaningless outside the package that owes it,
  // and splitting them would let one exist against a package nobody created.
  def('DESIGN_PACKAGE_CREATED', 'DesignPackage', 'CREATE', 'DESIGN', { creates: true }),
  def('DESIGN_RESPONSIBILITY_ASSIGNED', 'DesignPackage', 'UPDATE', 'DESIGN'),
  // Its own event because a transfer is a different act from an assignment: it
  // needs both parties' acceptance, and an audit reading the ledger can tell
  // the two apart without inspecting state.
  def('DESIGN_RESPONSIBILITY_TRANSFERRED', 'DesignPackage', 'UPDATE', 'DESIGN'),
  // The master plan is what the team plans add up to, so it is approved rather
  // than authored. APPROVE with `creates` says exactly that.
  def('MIDP_APPROVED', 'MIDP', 'APPROVE', 'DESIGN', { creates: true }),
  // D-WF-07. The review where the people who will build a thing read the
  // drawings before anybody freezes them. Findings, residual risks and
  // temporary works interfaces all live on the review that produced them: a
  // finding outside its occasion is a note, and the occasion is what makes it
  // answerable.
  def('CONSTRUCTABILITY_REVIEWED', 'ConstructabilityReview', 'CREATE', 'DESIGN', { creates: true }),
  def('DESIGN_RISK_UPDATED', 'ConstructabilityReview', 'UPDATE', 'DESIGN'),
  // Its own event: a temporary works interface carries a BS 5975 category
  // somebody competent assigned, and the ledger should show it was raised
  // rather than leave it inside a general update.
  def('TEMPORARY_WORKS_INTERFACE_RAISED', 'ConstructabilityReview', 'UPDATE', 'DESIGN'),
  def('REVIEW_ACTION_CLOSED', 'ConstructabilityReview', 'UPDATE', 'DESIGN'),
  def('SPECIFICATION_INGESTED', 'Specification', 'IMPORT', 'DESIGN', { aiAllowed: true, requiresEvidence: true }),
  def('SPEC_CLAUSE_EXTRACTED', 'SpecClause', 'CREATE', 'DESIGN', { aiAllowed: true, requiresEvidence: true }),
  def('DESIGN_MATURITY_ASSESSED', 'DesignMaturityAssessment', 'CREATE', 'DESIGN', { aiAllowed: true, requiresEvidence: true }),
  // Technical and material approval submittals. A submittal answers a clause,
  // so it belongs beside the clause rather than in delivery, and the same
  // record carries every revision of it — a register that split each cycle into
  // its own row would hide the product that has been round three times, which
  // is the one fact the register exists to surface.
  def('SUBMITTAL_RAISED', 'MaterialSubmittal', 'CREATE', 'DESIGN', { creates: true }),
  def('SUBMITTAL_ISSUED', 'MaterialSubmittal', 'UPDATE', 'DESIGN'),
  // APPROVE covers all four outcomes: this is the act of deciding, and a
  // separate REJECT would say a rejection is a different kind of event when it
  // is the same event with a different answer in it.
  def('SUBMITTAL_REVIEWED', 'MaterialSubmittal', 'APPROVE', 'DESIGN'),
  def('SUBMITTAL_RESUBMITTED', 'MaterialSubmittal', 'UPDATE', 'DESIGN'),
  // Its own event because ordering is the act the approval was for, and an
  // order placed before the decision is the exposure the register is built to
  // make visible.
  def('SUBMITTAL_ORDERED', 'MaterialSubmittal', 'UPDATE', 'DESIGN'),
  def('RFI_RAISED', 'RFI', 'CREATE', 'DESIGN', { aiAllowed: true }),
  def('RFI_ANSWERED', 'RFI', 'UPDATE', 'DESIGN', { requiresEvidence: true }),
  def('CORRESPONDENCE_ISSUED', 'Correspondence', 'ISSUE', 'DESIGN', { aiAllowed: true, creates: true }),
  // A reply is a distinct fact with its own author and its own date, and on the
  // letters where silence is acceptance the date is the whole point. Recording
  // it as another ISSUE would lose who answered and when.
  def('CORRESPONDENCE_ANSWERED', 'Correspondence', 'UPDATE', 'DESIGN', { requiresEvidence: true }),
  // CN-WF-08. Superseding a drawing changes the register; it does not reach the
  // person holding the old one in a site cabin. A transmittal is the controlled
  // issue, and the acknowledgement is what makes "who is still holding
  // superseded information" an answerable question.
  def('INFORMATION_PUBLISHED', 'Transmittal', 'ISSUE', 'DESIGN', { creates: true }),
  def('INFORMATION_ACKNOWLEDGED', 'Transmittal', 'UPDATE', 'DESIGN'),
  // D-WF-06. A change to *approved design*, which is not the same record as the
  // contractual `ChangeRequest` under CHANGE_VARIATION: most design changes are
  // the designer correcting their own work and never become a variation at all.
  // Putting every drawing correction into the variation register is the
  // commonest way a project loses track of what it is actually owed, so these
  // are two registers with one link between them.
  def('DESIGN_CHANGE_PROPOSED', 'DesignChange', 'CREATE', 'DESIGN', { creates: true }),
  // Its own event because the six-domain assessment is the acceptance criterion:
  // an audit reading the ledger can count how many domains were looked at
  // without opening state.
  def('CHANGE_IMPACT_ASSESSED', 'DesignChange', 'UPDATE', 'DESIGN'),
  // APPROVE and UPDATE are deliberately split rather than one event with an
  // answer inside it: approval is the act that unlocks implementation, and the
  // ledger should show it as an approval. A rejection or a request for more
  // information unlocks nothing.
  def('DESIGN_CHANGE_APPROVED', 'DesignChange', 'APPROVE', 'DESIGN'),
  def('DESIGN_CHANGE_DECIDED', 'DesignChange', 'UPDATE', 'DESIGN'),
  def('CHANGE_IMPLEMENTED', 'DesignChange', 'UPDATE', 'DESIGN'),
  // Confirming each affected thing was revised — or established as unaffected
  // after all — and the closure that depends on all of them.
  def('CHANGE_VERIFIED', 'DesignChange', 'UPDATE', 'DESIGN'),
  // D-WF-08. The moment design stops moving. A freeze copies the exact
  // deliverable references, suitabilities and acceptance records onto itself,
  // so a package frozen in March is still readable in September whatever the
  // model has done since — which is the whole difference between a baseline and
  // a date with a name on it. One event covers freezing and re-freezing: a
  // re-freeze supersedes rather than edits, and the supersession is written on
  // the record it supersedes.
  def('DESIGN_PACKAGE_FROZEN', 'FrozenPackage', 'FREEZE', 'DESIGN', { creates: true }),
  // APPROVE, because a baseline is somebody accepting a position rather than
  // recording one. It is the signature everything downstream is built on.
  def('DESIGN_BASELINE_APPROVED', 'DesignBaseline', 'APPROVE', 'DESIGN', { creates: true }),

  // --- Tender & procurement -------------------------------------------------
  def('TAKEOFF_COMPLETED', 'Takeoff', 'AI_EXECUTE', 'PROCUREMENT', { aiAllowed: true, requiresEvidence: true }),
  def('BOQITEM_CREATED_FROM_TAKEOFF', 'BoQItem', 'CREATE', 'PROCUREMENT', { aiAllowed: true, requiresEvidence: true }),
  // T-WF-03. The schedule opens and takes items under one event, because its
  // whole life is the audit trail of how it was measured.
  def('BOQ_IMPORTED', 'MeasurementSchedule', 'UPDATE', 'PROCUREMENT', { creates: true, aiAllowed: true }),
  // An agent may suggest what a rate build-up is missing; it may never approve a
  // quantity or a rate, which is the specification's own guardrail.
  def('RATE_BUILDUP_CREATED', 'MeasurementSchedule', 'UPDATE', 'PROCUREMENT'),
  def('QUANTITY_REMEASURE_REQUIRED', 'MeasurementSchedule', 'UPDATE', 'PROCUREMENT'),
  def('MEASUREMENT_FROZEN', 'MeasurementSchedule', 'FREEZE', 'PROCUREMENT', { requiresEvidence: true }),
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
  // Reading the whole tender document set: what is missing, what nobody owns,
  // what two people own, and what the contract actually says.
  //
  // Extraction may be an agent's work — the specification gives it clause and
  // scope extraction with citations and confidence — and the acceptance is not.
  // UPDATE with `creates`, because validating the register is the same act
  // whether it is the first pack or a reissued one. A separate opening event
  // would mean an empty review that means nothing.
  def('TENDER_DOCUMENT_VALIDATED', 'TenderReview', 'UPDATE', 'PROCUREMENT', { creates: true, aiAllowed: true }),
  def('SCOPE_GAP_IDENTIFIED', 'TenderReview', 'UPDATE', 'PROCUREMENT', { aiAllowed: true }),
  def('CONTRACT_INTERPRETED', 'TenderReview', 'UPDATE', 'PROCUREMENT', { aiAllowed: true }),
  // The freeze is not. It declares the information the price is built on, and
  // an agent that could declare it could declare a pack complete.
  def('TENDER_REVIEW_FROZEN', 'TenderReview', 'FREEZE', 'PROCUREMENT', { requiresEvidence: true }),
  // What an addendum touches in a frozen review. The specification names this
  // event under T-WF-06, which is the workflow that owns addenda and their
  // impact reports; it is the same act, so it takes the same name rather than
  // a second one meaning the same thing.
  def('ADDENDUM_IMPACT_ASSESSED', 'TenderReview', 'UPDATE', 'PROCUREMENT', { aiAllowed: true }),
  // Tender intake. The deadline is registered the hour the invitation lands,
  // before anybody has read it, because a countdown that starts when somebody
  // gets round to reading the documents is not a countdown. Human-authored: the
  // return deadline is the most consequential date in the stage and an agent
  // reading it out of an email is exactly where a silent hour of error lives.
  def('TENDER_RECEIVED', 'TenderInvitation', 'CREATE', 'PROCUREMENT', { creates: true }),
  // The one act in this workflow the specification gives to an agent: extract
  // the requirements and deadlines with source anchors. It extracts; it does
  // not decide, and the bid decision below refuses an AI actor outright.
  def('TENDER_REQUIREMENTS_EXTRACTED', 'TenderInvitation', 'UPDATE', 'PROCUREMENT', { aiAllowed: true }),
  // An addendum appends. It never rewrites the issue, because "what was the
  // deadline when we planned the bid" is what a late submission turns into a
  // dispute about.
  def('TENDER_ADDENDUM_ISSUED', 'TenderInvitation', 'UPDATE', 'PROCUREMENT'),
  // The tender programme, back-planned from the return date across the working
  // calendar. Follows the decision to bid and never precedes it.
  def('TENDER_PROGRAMME_CREATED', 'BidProgramme', 'CREATE', 'PROCUREMENT', { creates: true }),
  // 8.4. The stage gate Definition of Done. Never an agent's: a gate decision
  // is the assurance somebody relies on two years later, and the whole point of
  // the record is that a person put their name to it.
  def('STAGE_GATE_DECIDED', 'StageGateDecision', 'APPROVE', 'GOVERNANCE', { creates: true, requiresEvidence: true }),
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
  // T-WF-04. An agent may assemble a pack from controlled documents; approving
  // it and putting it in front of a firm is a person's act, because what goes
  // out binds everybody who prices it.
  def('ENQUIRY_PACK_REVISED', 'Enquiry', 'UPDATE', 'PROCUREMENT', { creates: true, aiAllowed: true }),
  def('ENQUIRY_PACK_APPROVED', 'Enquiry', 'APPROVE', 'PROCUREMENT'),
  def('ENQUIRY_ISSUED', 'Enquiry', 'ISSUE', 'PROCUREMENT', { requiresEvidence: true }),
  def('BIDDER_ACKNOWLEDGED', 'Enquiry', 'UPDATE', 'PROCUREMENT'),
  def('BIDDER_ACCESS_REVOKED', 'Enquiry', 'UPDATE', 'PROCUREMENT'),
  def('RETURN_PERIOD_CLOSED', 'Enquiry', 'FREEZE', 'PROCUREMENT'),
  def('LATE_RETURN_ACCEPTED', 'Enquiry', 'APPROVE', 'PROCUREMENT'),
  def('RFQ_ACKNOWLEDGED', 'RFQ', 'UPDATE', 'PROCUREMENT'),
  def('CLARIFICATION_RAISED', 'Clarification', 'CREATE', 'PROCUREMENT', { aiAllowed: true }),
  def('CLARIFICATION_ANSWERED', 'Clarification', 'UPDATE', 'PROCUREMENT'),
  // T-WF-06. Issuing an answer is a human act by design: the specification puts
  // issue and commercial interpretation on the person, and an agent that could
  // release a clarification could release it unequally.
  def('CLARIFICATION_ISSUED', 'Clarification', 'ISSUE', 'PROCUREMENT', { requiresEvidence: true }),
  def('CLARIFICATION_ACKNOWLEDGED', 'Clarification', 'UPDATE', 'PROCUREMENT'),
  // Opening, every adjustment and the close all write this. The comparison is
  // one record whose whole life is the audit trail of how it was normalised.
  def('RETURN_COMPARISON_UPDATED', 'ReturnComparison', 'UPDATE', 'PROCUREMENT', { creates: true }),
  def('SUBMISSION_RECEIVED', 'SupplierSubmission', 'CREATE', 'PROCUREMENT', { requiresEvidence: true }),
  def('SUBMISSION_NORMALISED', 'SupplierSubmission', 'AI_EXECUTE', 'PROCUREMENT', { aiAllowed: true }),
  // T-WF-05. Buy it or do it. An agent may normalise and flag; the estimate of
  // our own cost and the choice between the two routes are people's acts,
  // because both are commercial judgements rather than arithmetic.
  def('PRICING_ROUTE_SELECTED', 'PricingRoute', 'APPROVE', 'PROCUREMENT', { creates: true }),
  def('SELF_PERFORM_PRICED', 'PricingRoute', 'UPDATE', 'PROCUREMENT'),
  def('RETURN_NORMALISED', 'PricingRoute', 'UPDATE', 'PROCUREMENT', { aiAllowed: true }),
  def('BIDS_EVALUATED', 'BidEvaluation', 'EXECUTE', 'PROCUREMENT', { aiAllowed: true, requiresEvidence: true }),
  def('MASTER_PRICING_CONSOLIDATED', 'MasterPricing', 'CREATE', 'PROCUREMENT'),
  def('ADJUDICATION_COMPLETED', 'Adjudication', 'APPROVE', 'PROCUREMENT', { requiresEvidence: true, creates: true }),
  // The settlement meeting on our own bid — the last two hours before a tender
  // goes out, where the price stops being the estimate and becomes a decision.
  // A different act from `ADJUDICATION_COMPLETED` above, which chooses a
  // subcontractor from an evaluation.
  //
  // None is AI-authorable. The specification is explicit that an agent may
  // identify margin exposure and draft the risk summary, and may not set the
  // margin, the contingency or the final price.
  def('ADJUDICATION_STARTED', 'Settlement', 'CREATE', 'PROCUREMENT', { creates: true, requiresEvidence: true }),
  def('PRICE_ADJUSTMENT_RECORDED', 'Settlement', 'UPDATE', 'PROCUREMENT'),
  // Beyond the four the specification names, because an action is not an
  // adjustment and riding it on the adjustment event would put two different
  // acts under one name.
  def('SETTLEMENT_ACTION_RECORDED', 'Settlement', 'UPDATE', 'PROCUREMENT'),
  def('BID_PROGRAMME_APPROVED', 'Settlement', 'APPROVE', 'PROCUREMENT'),
  def('ADJUDICATION_APPROVED', 'Settlement', 'APPROVE', 'PROCUREMENT', { requiresEvidence: true }),
  def('BID_PACK_COMPILED', 'BidSubmissionPack', 'CREATE', 'PROCUREMENT', { requiresEvidence: true }),
  def('BID_PACK_LOCKED', 'BidSubmissionPack', 'FREEZE', 'PROCUREMENT', { requiresEvidence: true }),
  // Submission, award and conversion. The receipt binds to the pack's content
  // hash: a record saying "a bid went in at 11:52" proves you sent something,
  // and the argument after a disqualification is always about which bytes.
  def('TENDER_SUBMITTED', 'BidSubmissionPack', 'ISSUE', 'PROCUREMENT', { requiresEvidence: true }),
  def('AWARD_RECEIVED', 'BidSubmissionPack', 'UPDATE', 'PROCUREMENT'),
  // What the client awarded that is not what was bid. Computed rather than
  // typed: a departure somebody noticed is not the one that costs money.
  def('AWARD_DEPARTURE_IDENTIFIED', 'BidSubmissionPack', 'UPDATE', 'PROCUREMENT'),
  // The budget and the buyout targets, carried off the estimate rather than
  // re-keyed. Evidence required because it is the join the whole no-re-entry
  // rule stands on.
  def('BID_CONVERTED_TO_CONTRACT', 'BidSubmissionPack', 'UPDATE', 'PROCUREMENT', { requiresEvidence: true }),
  def('RFQ_AWARDED', 'RFQ', 'APPROVE', 'PROCUREMENT', { requiresEvidence: true }),
  def('SUBCONTRACT_ASSEMBLED', 'Subcontract', 'CREATE', 'PROCUREMENT'),
  def('SUBCONTRACT_EXECUTED', 'Subcontract', 'APPROVE', 'PROCUREMENT', { requiresEvidence: true }),
  def('COMMITMENT_RAISED', 'Commitment', 'CREATE', 'PROCUREMENT'),
  // CN-WF-05. The platform could buy but not receive. An item carries the date
  // the programme needs it and the lead time it takes, so it can be reported as
  // late on the day it is ordered — the only moment that is cheap to fix.
  def('ORDER_PLACED', 'ProcurementItem', 'CREATE', 'PROCUREMENT', { creates: true }),
  // Every step names the evidence it rests on. "In manufacture" from a supplier
  // who has not started is the commonest overstatement on any project.
  def('MANUFACTURING_MILESTONE_UPDATED', 'ProcurementItem', 'UPDATE', 'PROCUREMENT'),
  def('DELIVERY_BOOKED', 'Delivery', 'CREATE', 'PROCUREMENT', { creates: true }),
  def('DELIVERY_RECEIVED', 'Delivery', 'UPDATE', 'PROCUREMENT', { requiresEvidence: true }),
  // Its own event because quarantine is a state material cannot leave without
  // somebody with quality authority saying why, and an audit reading the ledger
  // should see it without opening state. Release writes it too: the same
  // control saying something different.
  def('MATERIAL_QUARANTINED', 'Delivery', 'UPDATE', 'PROCUREMENT'),
  // APPROVE, and once: this is what moves inventory and the accrual.
  def('MATERIAL_ACCEPTED', 'Delivery', 'APPROVE', 'PROCUREMENT'),
  // A serial, where it went and what proves it works there — the chain that
  // turns a delivery note into an as-built record.
  def('MATERIAL_INSTALLED', 'Delivery', 'UPDATE', 'PROCUREMENT'),

  // --- Contracts ------------------------------------------------------------
  def('CONTRACT_CREATED', 'Contract', 'CREATE', 'CONTRACTS_CLAIMS'),
  def('CONTRACT_INGESTED', 'Contract', 'IMPORT', 'CONTRACTS_CLAIMS', { aiAllowed: true, requiresEvidence: true }),
  def('CONTRACT_CLAUSE_EXTRACTED', 'ContractClause', 'CREATE', 'CONTRACTS_CLAIMS', { aiAllowed: true, requiresEvidence: true }),
  def('OBLIGATION_REGISTERED', 'Obligation', 'CREATE', 'CONTRACTS_CLAIMS', { aiAllowed: true }),
  // A promise read out of a letter, and the moment somebody starts counting it
  // down. Two events because they are two acts by two parties: the reading is
  // the machine's and carries the sentence it read it from verbatim; tracking
  // is a person's, and it is what puts the date into the obligation calendar.
  // `COMMITMENT_DISCARDED` exists because a rejected reading is a fact too — a
  // machine's finding that quietly vanishes is the one thing nobody can audit.
  def('COMMITMENT_REGISTERED', 'CorrespondenceCommitment', 'CREATE', 'CONTRACTS_CLAIMS', { aiAllowed: true, creates: true }),
  def('DEADLINE_TRACKED', 'CorrespondenceCommitment', 'APPROVE', 'CONTRACTS_CLAIMS'),
  def('COMMITMENT_DISCARDED', 'CorrespondenceCommitment', 'UPDATE', 'CONTRACTS_CLAIMS'),
  def('NOTICE_ISSUED', 'Notice', 'ISSUE', 'CONTRACTS_CLAIMS', { requiresEvidence: true, creates: true }),
  // CN-WF-08. Sequentially numbered, because a gap in an instruction sequence is
  // a question somebody will ask and an unnumbered instruction is one nobody can
  // prove was issued.
  def('INSTRUCTION_ISSUED', 'Instruction', 'ISSUE', 'CONTRACTS_CLAIMS', { requiresEvidence: true, creates: true }),
  def('INSTRUCTION_IMPLEMENTED', 'Instruction', 'UPDATE', 'CONTRACTS_CLAIMS', { requiresEvidence: true }),
  // The thing that was said. Recording it does not make it an instruction — the
  // platform never converts one — but it makes it visible exposure with a name,
  // a date and what the site did about it.
  def('UNCONFIRMED_DIRECTION_RECORDED', 'UnconfirmedDirection', 'CREATE', 'CONTRACTS_CLAIMS', { creates: true }),
  def('DIRECTION_CONFIRMED', 'UnconfirmedDirection', 'UPDATE', 'CONTRACTS_CLAIMS'),

  // --- Programme & delivery -------------------------------------------------
  // CN-WF-01. Start is an authorisation rather than a date. The checklist is by
  // package because start authority is by package: one plan covering "the site"
  // authorises everything and therefore nothing.
  def('MOBILISATION_STARTED', 'MobilisationPlan', 'CREATE', 'DELIVERY', { creates: true }),
  // Two events for one act, deliberately. "Not ready" is the fact somebody has
  // to find in the ledger without opening state — it is what stops work, and an
  // audit reading the log should see it as its own kind of thing.
  def('READINESS_CHECK_COMPLETED', 'ReadinessCheck', 'CREATE', 'DELIVERY', { creates: true }),
  def('WORK_NOT_READY', 'ReadinessCheck', 'CREATE', 'DELIVERY', { creates: true }),
  // APPROVE, and never `aiAllowed`: authorising a start is somebody taking
  // responsibility for people going to work, and the specification is explicit
  // that no agent mandate reaches it. Revocation writes the same event, because
  // withdrawing an authority is the same authority saying something different
  // rather than a new kind of act.
  def('START_WORK_AUTHORISED', 'StartWorkAuthorisation', 'APPROVE', 'DELIVERY', { creates: true }),
  def('WBS_GENERATED', 'WorkPackage', 'AI_EXECUTE', 'DELIVERY', { aiAllowed: true }),
  def('TASK_CREATED', 'Task', 'CREATE', 'DELIVERY'),
  def('TASK_UPDATED', 'Task', 'UPDATE', 'DELIVERY'),
  def('DEPENDENCY_CREATED', 'Dependency', 'CREATE', 'DELIVERY'),
  def('PROGRAMME_BASELINE_APPROVED', 'ProgrammeBaseline', 'APPROVE', 'DELIVERY', { requiresEvidence: true, creates: true }),
  // CN-WF-02. A separate record from the baseline, and that is the whole point:
  // the baseline is what delay is measured against, so a forecast that replaced
  // it would destroy the only reference the measurement has — and every
  // extension of time argument on the project with it.
  def('PROGRAMME_FORECAST_APPROVED', 'ProgrammeForecast', 'APPROVE', 'DELIVERY', { creates: true }),
  // The week stops moving. A frozen week that can be reopened is one whose
  // promises get edited to match what happened, and PPC over an edited plan
  // measures nothing.
  def('WEEKLY_PLAN_FROZEN', 'LookaheadPlan', 'FREEZE', 'DELIVERY'),
  // Distinct from PROGRESS_RECORDED, which is a measurement. This is a
  // statement about the state of the work — including blocked, which a
  // percentage cannot express at all.
  def('PROGRESS_STATUS_UPDATED', 'Task', 'UPDATE', 'DELIVERY'),
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
  // CN-WF-04. What the activity is measured in and against, which every later
  // refusal needs: without a unit there is nothing to check a claim against,
  // and without a control total "more installed than exists" cannot be seen.
  def('MEASUREMENT_BASIS_SET', 'MeasurementBasis', 'UPDATE', 'DELIVERY', { creates: true }),
  // A claim and its certification are different records made by different
  // people, and the submitted quantity is written once and never touched
  // again — the gap between claimed and accepted is the finding.
  def('PROGRESS_REPORTED', 'ProgressSubmission', 'CREATE', 'DELIVERY', { requiresEvidence: true, creates: true }),
  def('PROGRESS_VERIFIED', 'ProgressSubmission', 'APPROVE', 'DELIVERY'),
  // Its own event because an adjustment is a different fact from an
  // acceptance: two people measured the same work and got different answers,
  // and that is what gets argued about later.
  def('PROGRESS_ADJUSTED', 'ProgressSubmission', 'APPROVE', 'DELIVERY', { requiresEvidence: true }),
  // Beside PROGRESS_REPORTED, not instead of it. The submission says a quantity
  // was claimed; this says the quantity was read off a photograph, by which
  // provider, at what confidence, on what stated basis, with what the model said
  // it could not see — and what the confirmer changed. Valuing the claim uses
  // the first; defending it three years later uses this.
  def('PROGRESS_EXTRACTED_FROM_IMAGES', 'ProgressSubmission', 'AI_EXECUTE', 'DELIVERY', {
    aiAllowed: true,
    requiresEvidence: true,
  }),
  def('SITE_DIARY_RECORDED', 'SiteDiary', 'CREATE', 'DELIVERY', { requiresEvidence: true }),
  // CN-WF-03. A shift is captured across a day on a device, often with no
  // signal, and submitted once at the end of it. The draft carries the id the
  // device minted, so a capture interrupted by a flat battery is the same
  // capture when it comes back rather than a second one.
  def('DAILY_LOG_DRAFTED', 'SiteDiary', 'CREATE', 'DELIVERY', { creates: true }),
  def('DAILY_LOG_SUBMITTED', 'SiteDiary', 'UPDATE', 'DELIVERY', { requiresEvidence: true }),
  // An amendment creates a new record naming what it supersedes, with the
  // before and after of every field that changed on it. The original is never
  // touched: somebody may have acted on it, and an append-only ledger does not
  // remove what was relied upon.
  def('DAILY_LOG_AMENDED', 'SiteDiary', 'CREATE', 'DELIVERY', { creates: true, requiresEvidence: true }),
  // Not the sync itself, which `field/sync.ts` performs — the mark it leaves.
  // The question after a handset has been out of signal for four days is never
  // "did the sync work" but "when did this device last reach us".
  def('OFFLINE_SYNC_COMPLETED', 'SyncSession', 'CREATE', 'DELIVERY', { creates: true }),
  // A conflict resolved at push time and reported in the response is a conflict
  // nobody sees if the device drops the response — and somebody's work lost
  // either way, because every resolution has a losing side. These two make the
  // loss a record with a queue behind it rather than a line in a payload.
  //
  // Raised by the sync engine, never by a person: it is the mechanical fact
  // that two writes disagreed. Resolving it is the human act.
  def('SYNC_CONFLICT_RAISED', 'SyncConflict', 'CREATE', 'DELIVERY', { creates: true }),
  def('SYNC_CONFLICT_RESOLVED', 'SyncConflict', 'UPDATE', 'DELIVERY'),
  def('SITE_OBSERVATION_CAPTURED', 'SiteObservation', 'CREATE', 'DELIVERY', { aiAllowed: true, requiresEvidence: true }),
  def('SITE_OBSERVATION_CLOSED', 'SiteObservation', 'UPDATE', 'DELIVERY'),
  // The site visit. Not the same act as a site observation above: an
  // observation is about the state of the work, a finding is about the state of
  // the site, and the second one governs the job for years rather than closing
  // next week.
  def('SITE_VISIT_RECORDED', 'SiteVisit', 'CREATE', 'DELIVERY', { creates: true }),
  // A finding observed on site carries its photograph. One read from a document
  // carries its source instead, which is why evidence is required by the engine
  // against the basis rather than unconditionally here.
  def('SITE_FINDING_RAISED', 'SiteFinding', 'CREATE', 'DELIVERY', { creates: true }),
  // Discharged, not "closed": the obligation is gone because somebody did the
  // thing, and the record says what the thing was.
  def('SITE_FINDING_DISCHARGED', 'SiteFinding', 'UPDATE', 'DELIVERY'),
  // One current plan per project, superseding rather than accumulating. A site
  // with two logistics plans has none.
  def('LOGISTICS_PLAN_SET', 'SiteLogisticsPlan', 'UPDATE', 'DELIVERY', { creates: true }),
  // The meeting and everything minuted in it — attendance, agenda, actions —
  // are one event because they are one act. Splitting the agenda item out would
  // let a set of minutes exist with items recorded against a meeting nobody
  // held.
  def('MEETING_HELD', 'SiteMeeting', 'UPDATE', 'DELIVERY', { creates: true }),
  // Its own event, because closing an action is permitted after the minutes are
  // frozen and every other change to the meeting is not. An audit reading the
  // ledger can tell the two apart without inspecting state.
  def('MEETING_ACTION_CLOSED', 'SiteMeeting', 'UPDATE', 'DELIVERY'),
  // FREEZE, not ISSUE. ISSUE would say the minutes went out; FREEZE says what
  // actually changed, which is that the narrative stopped being editable. The
  // refusal itself lives in `domain/meetings.ts` — the ledger does not act on
  // this action, so the action is a description of the event, not the guard.
  def('MINUTES_ISSUED', 'SiteMeeting', 'FREEZE', 'DELIVERY'),
  // A correction is recorded beside issued minutes, never applied to them.
  // Somebody disagreeing with what the minutes say is itself a fact about the
  // meeting; overwriting the text destroys the only thing minutes are for.
  def('MINUTES_CORRECTED', 'SiteMeeting', 'UPDATE', 'DELIVERY'),
  // CN-WF-11. A separate entity rather than a status on the meeting, because the
  // meeting keeps changing after approval — closing an action is deliberately
  // permitted once the minutes are issued — and a version that lived on the
  // record it snapshots would move with it. The hash is of what was approved,
  // so issue can prove the text has not drifted since somebody stood behind it.
  def('MINUTES_APPROVED', 'MinutesVersion', 'APPROVE', 'GOVERNANCE', { creates: true }),
  // A material decision, with what else was considered and why it was not taken.
  // GOVERNANCE rather than DELIVERY: this is the record that binds, and it is
  // human by construction — no agent mandate reaches a decision, and the
  // platform never converts one into a contractual instruction.
  def('DECISION_RECORDED', 'DecisionRecord', 'CREATE', 'GOVERNANCE', { creates: true }),
  // Recording that the instruction giving effect to a decision has been issued
  // is a different act from taking the decision, and an audit reading the ledger
  // can tell them apart without inspecting state. The platform never issues the
  // instruction — a person calls `informationcontrol.issueInstruction` and this
  // records the reference afterwards.
  def('DECISION_INSTRUCTION_LINKED', 'DecisionRecord', 'UPDATE', 'GOVERNANCE'),
  // Quality assurance: the plan, the hold points, and the record against them.
  def('ITP_CREATED', 'InspectionPlan', 'CREATE', 'DELIVERY', { creates: true }),
  // CN-WF-06. The request carries the exact information revision the inspection
  // is against — "inspected and passed" against a drawing superseded on the
  // Friday is invisible afterwards unless it was written down at the time.
  def('INSPECTION_REQUESTED', 'InspectionRequest', 'CREATE', 'DELIVERY', { creates: true }),
  // A separate act from the inspection that passed. The inspector finds; the
  // release is the authority to build over it, and without that distinction a
  // hold point is a witness point with a stronger word on it.
  def('HOLD_POINT_RELEASED', 'HoldPointRelease', 'APPROVE', 'DELIVERY', { creates: true, requiresEvidence: true }),
  def('INSTRUMENT_CALIBRATED', 'Instrument', 'UPDATE', 'DELIVERY', { creates: true }),
  def('NCR_ACTION_RECORDED', 'NCR', 'UPDATE', 'DELIVERY', { requiresEvidence: true }),
  // Use-as-is is a design decision, not a quality one: the designer accepting
  // that the as-built differs from the design.
  def('CONCESSION_APPROVED', 'NCR', 'APPROVE', 'DELIVERY', { requiresEvidence: true }),
  // A defect closed on evidence that was later withdrawn was never closed. The
  // original closure is kept in full on the record.
  def('NCR_REOPENED', 'NCR', 'UPDATE', 'DELIVERY'),
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
  // A break in the bid-to-CVR data flow, raised as an exception to whoever owns
  // the commercial position. Recorded rather than only sent, for two reasons:
  // an alert that exists only in an inbox cannot be shown as open or closed,
  // and the record is what stops the same break being escalated every time the
  // report is run. AI may detect one; the record is written by the platform.
  def('CHAIN_EXCEPTION_RAISED', 'ChainException', 'CREATE', 'COMMERCIAL', { creates: true }),
  def('CHAIN_EXCEPTION_CLEARED', 'ChainException', 'UPDATE', 'COMMERCIAL'),

  // --- Agent runtime --------------------------------------------------------
  def('AGENT_RUN_COMPLETED', 'AgentRun', 'EXECUTE', 'AI_BILLING', { aiAllowed: true, creates: true }),
  def('AGENT_PROPOSAL_RAISED', 'AgentProposal', 'CREATE', 'AI_BILLING', { aiAllowed: true, creates: true }),
  // Decisions are human by definition — an AI actor committing one is refused
  // by the ledger, which is what stops an agent approving its own proposal.
  def('AGENT_PROPOSAL_APPROVED', 'AgentProposal', 'APPROVE', 'AI_BILLING'),
  def('AGENT_PROPOSAL_REJECTED', 'AgentProposal', 'APPROVE', 'AI_BILLING'),
  // Mitigated is a decision in its own right and not a softer rejection:
  // rejected means the finding was wrong, mitigated means it was right and is
  // being handled another way. Kept apart so a reader can tell how many
  // findings the platform got right and nobody acted on through this route.
  def('AGENT_PROPOSAL_MITIGATED', 'AgentProposal', 'APPROVE', 'AI_BILLING'),
  // Assignment is not a decision — the proposal stays open — so this is an
  // UPDATE. It names who is dealing with it, which is what turns a queue into
  // something other than a list nobody has picked up.
  def('AGENT_PROPOSAL_ASSIGNED', 'AgentProposal', 'UPDATE', 'AI_BILLING'),
  def('AGENT_PROPOSAL_EXECUTED', 'AgentProposal', 'UPDATE', 'AI_BILLING'),
  // Granting a machine the authority to act without asking is the single
  // highest-consequence decision anybody makes about this platform, so it is a
  // governed event and no AI actor may author one. That is what stops an agent
  // granting itself an envelope: the registry declares *eligibility*, this
  // records *authority*, and the commit refuses an AI author outright.
  def('AGENT_ENVELOPE_GRANTED', 'AgentEnvelope', 'APPROVE', 'GOVERNANCE', { creates: true }),
  // Withdrawal is equally governed, and equally human. An agent that could
  // revoke could also decline to.
  def('AGENT_ENVELOPE_REVOKED', 'AgentEnvelope', 'APPROVE', 'GOVERNANCE'),

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
  // The outbox. Queued before anything is transmitted, settled after — so a
  // process that dies between deciding to tell somebody and telling them leaves
  // the intent on the volume rather than nothing at all. A queued notice that
  // was never settled is redelivered on the next drain, which is what makes
  // delivery at-least-once instead of at-most-once.
  // The evaluation harness's own record. Not an AI event: it is the platform
  // checking itself, and it runs on a throwaway instance so nothing it does
  // reaches a customer's project. Only the result lands here, which is what
  // makes drift comparable between deployments of the same commit.
  def('AI_EVALUATION_RECORDED', 'AIEvaluation', 'CREATE', 'GOVERNANCE', { creates: true }),
  // The file ingestion pipeline. Three events rather than one "processed" flag,
  // because inspecting a file, reading it and refusing it are three different
  // facts and a project argued over in year five needs to know which happened.
  //
  // `FILE_INGESTED` carries the structural inspection and the classification.
  // `FILE_EXTRACTED` carries what came out of it — text, tables, the lexical
  // index. `FILE_QUARANTINED` is the refusal, and it names what was found.
  def('FILE_INGESTED', 'IngestedFile', 'CREATE', 'GOVERNANCE', { creates: true }),
  def('FILE_EXTRACTED', 'IngestedFile', 'UPDATE', 'GOVERNANCE'),
  def('FILE_QUARANTINED', 'IngestedFile', 'UPDATE', 'GOVERNANCE'),
  def('NOTIFICATION_QUEUED', 'NotificationOutbox', 'CREATE', 'GOVERNANCE', { creates: true }),
  def('NOTIFICATION_QUEUE_SETTLED', 'NotificationOutbox', 'UPDATE', 'GOVERNANCE'),
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
  // CN-WF-09 and CN-WF-10. Submitted, assessed, certified, agreed and paid stay
  // separate: the gap between submitted and assessed is the negotiation,
  // between certified and paid the cashflow, between agreed and paid a dispute.
  // A register holding one number describes none of them.
  def('VALUE_STAGE_RECORDED', 'ValueChain', 'UPDATE', 'CONTRACTS_CLAIMS', { creates: true }),
  // A time bar is the one deadline where being wrong is unrecoverable, and
  // "the system said the 14th" is not a defence. The derivation carries its
  // inputs and stays unvalidated until a person agrees or corrects it.
  def('NOTICE_DEADLINE_DERIVED', 'NoticeDeadline', 'CREATE', 'CONTRACTS_CLAIMS', { creates: true }),
  def('NOTICE_DEADLINE_VALIDATED', 'NoticeDeadline', 'APPROVE', 'CONTRACTS_CLAIMS'),
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
  // CN-WF-07. A permit extended over a lapsed ticket authorises work by somebody
  // nobody has checked, and a permit nobody handed back leaves an area whose
  // state the next person in is relying on and nobody recorded.
  def('PERMIT_EXTENDED', 'Permit', 'APPROVE', 'RISK_SAFETY'),
  def('PERMIT_HANDED_BACK', 'Permit', 'APPROVE', 'RISK_SAFETY'),
  // A revision supersedes rather than edits: the new method starts unapproved
  // and unbriefed, and everybody who worked to the old one is owed the
  // difference by name.
  def('RAMS_REVISED', 'RAMS', 'CREATE', 'RISK_SAFETY', { creates: true }),
  def('RAMS_SUPERSEDED', 'RAMS', 'UPDATE', 'RISK_SAFETY'),
  def('SAFETY_ACTION_CLOSED', 'SafetyObservation', 'UPDATE', 'RISK_SAFETY', { requiresEvidence: true }),
  // Immediate cause, underlying cause, root cause and the actions out of them.
  // An incident closed on its immediate action alone has taught nothing.
  def('INCIDENT_INVESTIGATED', 'Incident', 'UPDATE', 'RISK_SAFETY'),
  def('TRAINING_COMPLETED', 'TrainingRecord', 'CREATE', 'RISK_SAFETY', { requiresEvidence: true }),

  // --- BIM & digital twin ---------------------------------------------------
  def('MODEL_INGESTED', 'Model', 'IMPORT', 'BIM_TWIN', { aiAllowed: true, requiresEvidence: true }),
  def('CLASH_DETECTED', 'Clash', 'AI_EXECUTE', 'BIM_TWIN', { aiAllowed: true, requiresEvidence: true }),
  def('CLASH_RESOLVED', 'Clash', 'APPROVE', 'BIM_TWIN', { requiresEvidence: true }),
  // D-WF-04. An immutable set of exact model revisions. Never updated: a set
  // that could gain a model would make every run against it incomparable with
  // every other, which is the one thing the set exists to prevent.
  def('MODEL_FEDERATION_CREATED', 'FederationSet', 'CREATE', 'BIM_TWIN', { creates: true }),
  def('CLASH_RUN_COMPLETED', 'ClashRun', 'CREATE', 'BIM_TWIN', { creates: true }),
  // The grouped, owned, verifiable thing — four thousand raw clashes are forty
  // problems, and this is the forty. One event covers raising and every move
  // along the ladder because they are the same act on the same record; the
  // three below are the ones that differ in kind.
  def('COORDINATION_ISSUE_ASSIGNED', 'CoordinationIssue', 'UPDATE', 'BIM_TWIN', { creates: true }),
  // Its own event because a later run found it again after it was closed, which
  // is a fact about the model rather than about anybody's decision.
  def('COORDINATION_ISSUE_REOPENED', 'CoordinationIssue', 'UPDATE', 'BIM_TWIN'),
  // Deliberately not CLASH_RESOLVED. Accepting a clash is a decision to live
  // with geometry that did not change, and an audit reading the ledger must be
  // able to tell it from a fix without inspecting state.
  def('COORDINATION_ISSUE_ACCEPTED', 'CoordinationIssue', 'APPROVE', 'BIM_TWIN'),
  def('ISSUE_VERIFIED', 'CoordinationIssue', 'APPROVE', 'BIM_TWIN'),
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

  // --- CN-WF-12 reporting, recovery, completion and turnover ---------------
  // The ledger as at a stated instant, with what it could not see named rather
  // than rendered as a zero. Evidence-bearing because the snapshot's hash is
  // what a report reconciles to, and a figure nobody can reproduce is an
  // assertion.
  def('REPORT_SNAPSHOT_CREATED', 'PeriodSnapshot', 'CREATE', 'PROJECT_CONTROL', { creates: true, requiresEvidence: true }),
  // The forecast produces costed options; a person selects them. APPROVE rather
  // than CREATE because selecting a recovery is a commitment of money, and the
  // specification's guardrail is that no agent makes it.
  def('RECOVERY_PLAN_APPROVED', 'RecoveryPlan', 'APPROVE', 'PROJECT_CONTROL', { creates: true }),
  // The boundary, the isolations and what construction retains. Without these
  // three, two parties each believe the other holds the isolation.
  def('SYSTEM_READY_FOR_TURNOVER', 'SystemTurnover', 'APPROVE', 'COMMISSIONING', { creates: true }),
  // The exception AC-CN-WF-12-03 permits, as a signed record with an expiry
  // rather than a flag. An exception nobody signed cannot be told apart from the
  // rule never having been applied.
  def('TURNOVER_EXCEPTION_ACCEPTED', 'TurnoverException', 'APPROVE', 'COMMISSIONING', { creates: true }),
  // The stage 9 exit. The certificate the defects period, the retention release
  // and half the insurance run from, so it carries its evidence.
  def('CONSTRUCTION_COMPLETION_ACCEPTED', 'ConstructionCompletion', 'APPROVE', 'PROJECT_CONTROL', {
    creates: true,
    requiresEvidence: true,
  }),

  // --- CM-WF-01 systemisation and the commissioning plan --------------------
  // The tag is the stable identity every test, reading and certificate hangs
  // off, so defining a node and approving the hierarchy are separate events: the
  // second is the point after which the boundaries stop moving.
  def('SYSTEM_NODE_DEFINED', 'SystemNode', 'CREATE', 'COMMISSIONING', { creates: true }),
  def('SYSTEM_HIERARCHY_APPROVED', 'SystemNode', 'APPROVE', 'COMMISSIONING'),
  def('COMMISSIONING_PLAN_DRAFTED', 'CommissioningPlan', 'CREATE', 'COMMISSIONING', { creates: true }),
  def('COMMISSIONING_PLAN_APPROVED', 'CommissioningPlan', 'APPROVE', 'COMMISSIONING'),
  // One per planned test. Recorded so a test executed without a pack is visibly
  // outside the plan rather than merely undocumented.
  def('TEST_PACK_REQUIRED', 'TestPackRequirement', 'CREATE', 'COMMISSIONING', { creates: true }),
  def('COMMISSIONING_BASELINE_UPDATED', 'CommissioningPlan', 'UPDATE', 'COMMISSIONING'),
  // Its own entity, never a state of commissioning. Running plant to dry out a
  // building is not commissioning it, but the hours accrue and the warranty
  // starts, and conflating the two reports a system as proven when nobody tested
  // anything.
  def('TEMPORARY_OPERATION_DECLARED', 'TemporaryOperation', 'APPROVE', 'COMMISSIONING', { creates: true }),

  // --- CM-WF-02 the procedure, the pack and the release to test -------------
  def('TEST_PROCEDURE_CREATED', 'TestPack', 'CREATE', 'COMMISSIONING', { creates: true }),
  // A revision is its own event. An audit reading the ledger can see that the
  // procedure moved without inspecting state, which matters because a revision
  // after release cancels the release.
  def('TEST_PROCEDURE_REVISED', 'TestPack', 'UPDATE', 'COMMISSIONING'),
  def('TEST_READINESS_CHECKED', 'TestPack', 'UPDATE', 'COMMISSIONING'),
  // Notice and response are separate events because AC-CM-WF-02-03 asks for both
  // to be time-stamped, and one event carrying both would date the pair by
  // whichever happened last.
  def('WITNESS_NOTIFIED', 'TestPack', 'UPDATE', 'COMMISSIONING'),
  def('WITNESS_RESPONSE_RECORDED', 'TestPack', 'UPDATE', 'COMMISSIONING'),
  // FREEZE rather than APPROVE. What actually happens at release is that the
  // revision stops moving: the hash taken here is what a result has to have been
  // executed against, and an edit afterwards cancels the release.
  def('TEST_RELEASED', 'TestPack', 'FREEZE', 'COMMISSIONING'),
  // Its own event, because a blocked test is a fact about the programme and the
  // pattern of them is how a late commissioning stage is diagnosed. A refusal
  // that left no trace would make the same blocker look new every week.
  def('TEST_BLOCKED', 'TestPack', 'REJECT', 'COMMISSIONING'),

  // --- CM-WF-03 FAT, SAT and vendor test control ---------------------------
  // One entity for both, because a SAT is the same act at a different address
  // and the exceptions have to travel between them. The kind is on the state and
  // the start and completion events name it, so an audit reading the ledger sees
  // which without loading the record.
  def('FAT_STARTED', 'VendorTest', 'CREATE', 'COMMISSIONING', { creates: true }),
  def('SAT_STARTED', 'VendorTest', 'CREATE', 'COMMISSIONING', { creates: true }),
  // A reading carries its instrument, its unit, who took it and when. Without
  // the instrument it cannot be defended when the equipment fails two years on.
  def('TEST_READING_RECORDED', 'VendorTest', 'UPDATE', 'COMMISSIONING'),
  def('VENDOR_EXCEPTION_RAISED', 'VendorTest', 'UPDATE', 'COMMISSIONING'),
  // APPROVE, because closing an exception needs the verification rather than the
  // vendor's assurance, and the authority to accept it.
  def('VENDOR_EXCEPTION_CLOSED', 'VendorTest', 'APPROVE', 'COMMISSIONING'),
  def('FAT_COMPLETED', 'VendorTest', 'APPROVE', 'COMMISSIONING'),
  def('SAT_COMPLETED', 'VendorTest', 'APPROVE', 'COMMISSIONING'),
  def('SHIPPING_RELEASED', 'VendorTest', 'APPROVE', 'COMMISSIONING'),

  // --- CM-WF-07 commissioning exception, punch, defect and retest -----------
  // One entity owns the open item, raised from the failed record rather than
  // retyped beside it: an exception whose failed reading was entered by hand can
  // disagree with the test it came from, and the two are never reconciled.
  def('COMMISSIONING_EXCEPTION_RAISED', 'CommissioningException', 'CREATE', 'COMMISSIONING', { creates: true }),
  def('CORRECTIVE_ACTION_COMPLETED', 'CommissioningException', 'UPDATE', 'COMMISSIONING', { requiresEvidence: true }),
  // APPROVE: which other tests a failure invalidates is confirmed by a person,
  // never assumed by the platform, and the tests already passed are the
  // dangerous ones because they read as complete.
  def('EXCEPTION_IMPACT_ASSESSED', 'CommissioningException', 'APPROVE', 'COMMISSIONING'),
  def('RETEST_STARTED', 'CommissioningException', 'UPDATE', 'COMMISSIONING'),
  def('RETEST_RESULT_RECORDED', 'CommissioningException', 'UPDATE', 'COMMISSIONING'),
  // Closure adds a verified succeeding result. It changes nothing about the
  // failure, which is why there is no event that could.
  def('EXCEPTION_CLOSED', 'CommissioningException', 'APPROVE', 'COMMISSIONING'),
  def('EXCEPTION_CONDITIONALLY_ACCEPTED', 'CommissioningException', 'APPROVE', 'COMMISSIONING'),

  // --- CM-WF-04 pre-functional and static completion ------------------------
  def('PREFUNCTIONAL_CHECK_STARTED', 'PreFunctionalCheck', 'CREATE', 'COMMISSIONING', { creates: true }),
  def('PREFUNCTIONAL_ITEM_RECORDED', 'PreFunctionalCheck', 'UPDATE', 'COMMISSIONING'),
  // Static completion is not construction completion: it is the statement that
  // the system is safe to energise and operate, which is a different question
  // with different evidence behind it.
  def('STATIC_COMPLETION_ACCEPTED', 'PreFunctionalCheck', 'APPROVE', 'COMMISSIONING'),
  def('FUNCTIONAL_TEST_RELEASED', 'PreFunctionalCheck', 'APPROVE', 'COMMISSIONING'),
  // Construction returning to a system after static completion means the system
  // tested is no longer the system installed. The affected items go back to
  // unanswered rather than failed, because nobody has looked at them since.
  def('STATIC_COMPLETION_INVALIDATED', 'PreFunctionalCheck', 'UPDATE', 'COMMISSIONING'),

  // --- CM-WF-05 functional performance and integrated systems testing -------
  def('FUNCTIONAL_TEST_STARTED', 'FunctionalTest', 'CREATE', 'COMMISSIONING', { creates: true }),
  def('INTEGRATED_TEST_STARTED', 'FunctionalTest', 'CREATE', 'COMMISSIONING', { creates: true }),
  // Carries the trend dataset by hash as well as the step results, because a
  // summary of a trend is an opinion about a trend and AC-CM-WF-05-01 asks the
  // response to be reconstructable from the raw evidence.
  def('FUNCTIONAL_STEP_RECORDED', 'FunctionalTest', 'UPDATE', 'COMMISSIONING'),
  def('TEST_SCRIPT_DEVIATION_RECORDED', 'FunctionalTest', 'UPDATE', 'COMMISSIONING'),
  // An abort is not a fail. A test abandoned because the chilled water was off
  // tells you nothing about the plant, and recording it as a failure puts a
  // defect against equipment nobody tested.
  def('FUNCTIONAL_TEST_ABORTED', 'FunctionalTest', 'UPDATE', 'COMMISSIONING'),
  def('FUNCTIONAL_TEST_COMPLETED', 'FunctionalTest', 'APPROVE', 'COMMISSIONING'),
  def('INTEGRATED_TEST_COMPLETED', 'FunctionalTest', 'APPROVE', 'COMMISSIONING'),
  def('RETEST_REQUIRED', 'FunctionalTest', 'UPDATE', 'COMMISSIONING'),

  // --- CM-WF-06 reliability, soak and the seasonal plan ---------------------
  def('RELIABILITY_TEST_STARTED', 'ReliabilityRun', 'CREATE', 'COMMISSIONING', { creates: true }),
  // Trend arrives as segments and coverage is derived from them, so a gap is a
  // hole in the evidence nobody has to remember to mention.
  def('RELIABILITY_TREND_IMPORTED', 'ReliabilityRun', 'IMPORT', 'COMMISSIONING', { requiresEvidence: true }),
  def('RELIABILITY_INTERVENTION_LOGGED', 'ReliabilityRun', 'UPDATE', 'COMMISSIONING'),
  def('PERFORMANCE_ANOMALY_DETECTED', 'ReliabilityRun', 'UPDATE', 'COMMISSIONING'),
  // Continue, reset or retest is the most consequential decision in a soak test
  // — a reset costs the whole duration again — and the one most often taken by
  // whoever is standing nearest the panel. APPROVE, and it names an authority.
  def('RELIABILITY_ANOMALY_DECIDED', 'ReliabilityRun', 'APPROVE', 'COMMISSIONING'),
  def('RELIABILITY_TEST_ACCEPTED', 'ReliabilityRun', 'APPROVE', 'COMMISSIONING'),
  // A test that cannot happen before handover, with its criteria fixed now and a
  // named party accepting the obligation. Criteria agreed later against a system
  // already in use are agreed under pressure.
  def('SEASONAL_TEST_PLANNED', 'SeasonalTest', 'APPROVE', 'COMMISSIONING', { creates: true }),

  // --- CM-WF-08 training, documentation readiness and the gate --------------
  def('TRAINING_DELIVERED', 'TrainingSession', 'CREATE', 'COMMISSIONING', { creates: true }),
  // Operators are trained in the last fortnight before handover, which is
  // exactly when as-builts and control descriptions are still moving. A session
  // taught from a revision that has since been superseded taught people to
  // operate a building that does not exist.
  def('TRAINING_INVALIDATED', 'TrainingSession', 'UPDATE', 'COMMISSIONING'),
  // The index is hashed so the dossier as handed over is identifiable: one that
  // can be quietly topped up afterwards is not a dossier anybody accepted.
  def('COMMISSIONING_DOSSIER_COMPILED', 'CommissioningDossier', 'CREATE', 'COMMISSIONING', {
    creates: true,
    requiresEvidence: true,
  }),
  def('SYSTEM_COMMISSIONING_ACCEPTED', 'SystemAcceptance', 'APPROVE', 'COMMISSIONING', { creates: true }),
  // The stage 10 exit. The obligations it carries are stored as identifiers and
  // their kind rather than copied text — a second copy of a seasonal test is the
  // one that disagrees with the first within a month.
  def('COMMISSIONING_COMPLETE', 'CommissioningCompletion', 'APPROVE', 'PROJECT_CONTROL', { creates: true }),

  // --- H-WF-01 the handover requirements matrix -----------------------------
  // The spine of stage 11: every other handover workflow satisfies requirements
  // that live here, and readiness is the arithmetic over them. There is no
  // READINESS_UPDATED event, although the specification lists one, because a
  // stored readiness figure is the number nobody updates after the requirement
  // it was computed from moved.
  def('HANDOVER_REQUIREMENT_CREATED', 'HandoverRequirement', 'CREATE', 'HANDOVER_OM', { creates: true }),
  def('DELIVERABLE_ASSIGNED', 'HandoverRequirement', 'UPDATE', 'HANDOVER_OM'),
  def('HANDOVER_MATRIX_BASELINED', 'HandoverRequirement', 'FREEZE', 'HANDOVER_OM'),
  def('HANDOVER_REQUIREMENT_SUBMITTED', 'HandoverRequirement', 'UPDATE', 'HANDOVER_OM'),
  // The decision is by the named acceptance party against the evidence rule. A
  // submitted document is what a decision is made about, never what makes one.
  def('HANDOVER_REQUIREMENT_DECIDED', 'HandoverRequirement', 'APPROVE', 'HANDOVER_OM'),
  def('HANDOVER_REQUIREMENT_WAIVED', 'HandoverRequirement', 'APPROVE', 'HANDOVER_OM'),
  // A source reissue flags the requirements drawn from the old version rather
  // than re-pointing them: what actually changed is a question for a person.
  def('HANDOVER_REQUIREMENT_DELTA_FLAGGED', 'HandoverRequirement', 'UPDATE', 'HANDOVER_OM'),
  def('HANDOVER_SECTION_DEFINED', 'HandoverSection', 'APPROVE', 'HANDOVER_OM', { creates: true }),

  // --- H-WF-02 as-built verification ----------------------------------------
  // `AS_BUILT_GENERATED` above stays as it is: generating an as-built model from
  // captured reality is a drafting act and legitimately an AI one. Certifying
  // that it is accurate is not, which is what this set of events is for.
  def('AS_BUILT_SUBMITTED', 'AsBuiltSet', 'CREATE', 'DESIGN', { creates: true, requiresEvidence: true }),
  def('AS_BUILT_VARIANCE_IDENTIFIED', 'AsBuiltSet', 'UPDATE', 'DESIGN'),
  def('AS_BUILT_VARIANCE_RESOLVED', 'AsBuiltSet', 'UPDATE', 'DESIGN'),
  // The act that makes a set as-built, signed by a named professional with their
  // registration on it. A set called "AS-BUILT-FINAL" is a set somebody named.
  def('AS_BUILT_VERIFIED', 'AsBuiltSet', 'APPROVE', 'DESIGN'),
  def('AS_BUILT_PUBLISHED', 'AsBuiltSet', 'ISSUE', 'DESIGN'),
  def('AS_BUILT_SUPERSEDED', 'AsBuiltSet', 'UPDATE', 'DESIGN'),
  // One record answering both directions, so the asset cannot open from the
  // drawing while the drawing does not know the asset is on it.
  def('ASSET_INFORMATION_LINKED', 'AssetInformationLink', 'CREATE', 'DESIGN', { creates: true }),

  // --- H-WF-03 O&M manuals and the technical file ---------------------------
  // `OM_MANUAL_PUBLISHED` above stays as it is: extracting maintenance tasks
  // from manufacturer documentation is a legitimate AI act, and what it produces
  // is a draft. These events are the structure, the review and the acceptance
  // that turn a draft into something an operator can run a building on.
  def('OM_MANUAL_DRAFTED', 'OMManualStructure', 'CREATE', 'HANDOVER_OM', { creates: true }),
  def('OM_SECTION_WRITTEN', 'OMManualStructure', 'UPDATE', 'HANDOVER_OM'),
  // Two reviews, not one: the technical checker and the operator who has to use
  // it are different assurances and the specification asks for both.
  def('OM_SECTION_REVIEWED', 'OMManualStructure', 'UPDATE', 'HANDOVER_OM'),
  // When an asset changes, the sections that described the old one are wrong and
  // read as current until somebody notices.
  def('OM_SECTION_REVISION_REQUIRED', 'OMManualStructure', 'UPDATE', 'HANDOVER_OM'),
  def('OM_MANUAL_ACCEPTED', 'OMManualStructure', 'APPROVE', 'HANDOVER_OM'),
  def('OM_MANUAL_REJECTED', 'OMManualStructure', 'REJECT', 'HANDOVER_OM'),

  // --- H-WF-04 asset register validation, exchange and reconciliation -------
  // A blank passes a presence check by not being examined. An explicit Unknown
  // with an owner and a date is a different thing entirely, because somebody has
  // to be asked about it.
  def('ASSET_DATA_VALIDATED', 'AssetValidation', 'UPDATE', 'HANDOVER_OM', { creates: true }),
  def('ASSET_EXCHANGE_EXPORTED', 'AssetExchange', 'IMPORT', 'HANDOVER_OM', { creates: true }),
  // Export success is not acceptance. A COBie file uploads cleanly, the project
  // closes, and eighteen months later the maintenance system turns out to have
  // silently rejected four hundred rows. APPROVE, and the totals have to add up.
  def('ASSET_RECONCILED', 'AssetExchange', 'APPROVE', 'HANDOVER_OM'),

  // --- H-WF-05 regulatory completion and Golden Thread transfer -------------
  // Nothing here makes a legal classification, signs a declaration or submits
  // anything: submission happens outside this platform and what is recorded is
  // that it happened, by whom, and what came back.
  def('COMPLETION_READINESS_CHECKED', 'CompletionReadiness', 'CREATE', 'GOVERNANCE', { creates: true }),
  def('REGULATORY_PACK_APPROVED', 'RegulatoryPack', 'APPROVE', 'GOVERNANCE', { creates: true }),
  def('REGULATORY_SUBMISSION_RECORDED', 'RegulatoryPack', 'UPDATE', 'GOVERNANCE'),
  // Evidence-bearing on a grant: the certificate is the document occupation,
  // insurance and half the operational obligations run from.
  def('COMPLETION_CERTIFICATE_RECEIVED', 'RegulatoryPack', 'UPDATE', 'GOVERNANCE'),
  // The recipient confirms access, completeness and a usable format, and any one
  // of them false means the duty has not moved.
  def('GOLDEN_THREAD_TRANSFERRED', 'GoldenThreadTransfer', 'ISSUE', 'EVIDENCE', { creates: true }),

  // --- H-WF-06 operator training, competence and operational readiness ------
  // CM-WF-08's `TRAINING_DELIVERED` already records a session against the
  // revision it taught, and is not duplicated here. What these add is the part
  // it does not answer: whether anybody is competent, and whether the roles the
  // building needs are covered.
  def('TRAINING_NEEDS_DEFINED', 'TrainingNeeds', 'CREATE', 'HANDOVER_OM', { creates: true }),
  // A separate act by a separate assessor. Attendance proves somebody was in
  // the room, and the specification is explicit that the platform never
  // certifies competence.
  def('COMPETENCE_ASSESSED', 'CompetenceAssessment', 'CREATE', 'HANDOVER_OM', { creates: true }),
  def('TRAINING_GAP_PLANNED', 'TrainingGapPlan', 'APPROVE', 'HANDOVER_OM', { creates: true }),
  def('RETRAINING_REQUIRED', 'RetrainingObligation', 'CREATE', 'HANDOVER_OM', { creates: true }),
  def('OPERATOR_READY', 'OperatorReadiness', 'APPROVE', 'HANDOVER_OM', { creates: true }),

  // H-WF-07. None of these is `aiAllowed`. The specification's guardrail is "no
  // access to or reproduction of secret values; only status metadata", and the
  // cheapest way to honour it is that no agent mandate reaches the register at
  // all — a credential's whereabouts is as useful to an attacker as its value.
  def('TRANSFER_ITEM_REGISTERED', 'TransferItem', 'CREATE', 'HANDOVER_OM', { creates: true }),
  // Two events for the two things a key and a spare are. Whoever reads the
  // ledger for "who holds the keys" is not asking the same question as whoever
  // reads it for "did the spares arrive".
  def('KEYS_TRANSFERRED', 'TransferItem', 'UPDATE', 'HANDOVER_OM', { requiresEvidence: true }),
  def('SPARES_ACCEPTED', 'TransferItem', 'UPDATE', 'HANDOVER_OM', { requiresEvidence: true }),
  // Separate from the transfer, because the transfer happened and the shortage
  // is the fact somebody still has to act on.
  def('TRANSFER_SHORTAGE_RECORDED', 'TransferItem', 'UPDATE', 'HANDOVER_OM'),
  // Status metadata only: which vault reference, by what mechanism, confirmed by
  // whom. The value never enters the platform.
  def('CREDENTIAL_TRANSFER_CONFIRMED', 'TransferItem', 'UPDATE', 'HANDOVER_OM'),
  // A security incident, not a shortage.
  def('TRANSFER_ITEM_LOST', 'TransferItem', 'UPDATE', 'HANDOVER_OM'),
  def('SERVICE_CONTACT_REGISTERED', 'ServiceContact', 'CREATE', 'HANDOVER_OM', { creates: true }),

  // H-WF-08. `DEFECT_RAISED` and `SNAG_CLOSED` already exist and are not
  // duplicated; these are the completion acts none of them covered.
  def('COMPLETION_INSPECTION_COMPLETED', 'CompletionInspection', 'CREATE', 'HANDOVER_OM', {
    creates: true,
    requiresEvidence: true,
  }),
  // AC-H-WF-08-03: a closed item shows the rectification somebody accepted.
  def('DEFECT_CLOSED', 'CompletionInspection', 'APPROVE', 'HANDOVER_OM', { requiresEvidence: true }),
  def('DEFECT_DEFERRED', 'CompletionInspection', 'UPDATE', 'HANDOVER_OM'),
  // The act that clears `requiresLegalReview`. Nothing in the platform could
  // before, so a certificate could have set a liability running from a clause
  // only a model had read.
  def('CONTRACT_CLAUSE_VALIDATED', 'ContractClause', 'APPROVE', 'CONTRACTS_CLAIMS'),
  // Determining completion is a contractual act. No agent mandate reaches it —
  // "cannot issue certificate, determine legal completion or agree final
  // account" is three of this workflow's four writes.
  def('PRACTICAL_COMPLETION_RECORDED', 'CompletionRecord', 'CREATE', 'CONTRACTS_CLAIMS', {
    creates: true,
    requiresEvidence: true,
  }),
  def('DEFECTS_PERIOD_STARTED', 'CompletionRecord', 'UPDATE', 'CONTRACTS_CLAIMS'),
  // AC-H-WF-08-02: there is no path that edits a triggered date. A change is
  // this, and it keeps the hash of the set it replaced.
  def('CONTRACT_DATES_REVISED', 'CompletionRecord', 'UPDATE', 'CONTRACTS_CLAIMS'),
  def('SECURITY_POSITION_RECORDED', 'CommercialSecurity', 'CREATE', 'CONTRACTS_CLAIMS', { creates: true }),
  def('FINAL_ACCOUNT_AGREED', 'FinalAccount', 'APPROVE', 'CONTRACTS_CLAIMS', { creates: true }),

  // H-WF-09. `HANDOVER_PACK_COMPILED` and `HANDOVER_ACCEPTED` already exist and
  // are not duplicated; these are the acts around them that did not.
  def('HANDOVER_MANIFEST_COMPILED', 'HandoverManifest', 'CREATE', 'HANDOVER_OM', { creates: true }),
  // Two events, because accepting and refusing are not the same act and the
  // second one freezes the pack.
  def('HANDOVER_DECISION_RECORDED', 'HandoverPack', 'APPROVE', 'HANDOVER_OM'),
  def('HANDOVER_REJECTED', 'HandoverPack', 'REJECT', 'HANDOVER_OM'),
  // AC-H-WF-09-02: derived from the accepted register, which is why this is an
  // EXECUTE rather than a CREATE — nothing is authored, something is run.
  def('ASSET_OPERATION_ACTIVATED', 'OperationalActivation', 'EXECUTE', 'HANDOVER_OM', { creates: true }),
  def('PROJECT_HANDOVER_BASELINED', 'HandoverBaseline', 'FREEZE', 'HANDOVER_OM', { creates: true }),
  def('RESIDUAL_OBLIGATIONS_TRANSFERRED', 'ResidualTransfer', 'CREATE', 'HANDOVER_OM', { creates: true }),

  // H-WF-10. `LESSON_CAPTURED` already exists in RISK_SAFETY and is not
  // duplicated; `LESSON_APPROVED` is the act it never had.
  def('AFTERCARE_STARTED', 'AftercarePlan', 'CREATE', 'HANDOVER_OM', { creates: true }),
  // Closes the CM-WF-06 record by its own reference. Nothing is renumbered.
  def('SEASONAL_TEST_COMPLETED', 'SeasonalTest', 'UPDATE', 'COMMISSIONING', { requiresEvidence: true }),
  // Two events, because a comparison inside tolerance is a fact worth keeping
  // and is not a gap. Recording both as gaps would make the register useless.
  def('PERFORMANCE_COMPARED', 'PerformanceComparison', 'CREATE', 'HANDOVER_OM', { creates: true }),
  def('PERFORMANCE_GAP_IDENTIFIED', 'PerformanceComparison', 'CREATE', 'HANDOVER_OM', { creates: true }),
  def('OCCUPANT_FEEDBACK_RECORDED', 'OccupantFeedback', 'CREATE', 'HANDOVER_OM', { creates: true }),
  def('POST_OCCUPANCY_REVIEWED', 'PostOccupancyReview', 'CREATE', 'HANDOVER_OM', {
    creates: true,
    requiresEvidence: true,
  }),
  // The approval a lesson needs before organisation memory will serve it.
  def('LESSON_APPROVED', 'LessonLearned', 'APPROVE', 'RISK_SAFETY'),

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
  /**
   * What a person decided about an AI output.
   *
   * The last of the three things every stage gate's fifth clause asked for and
   * the platform did not record. The other two — assumptions and prompt
   * version — are properties of the call and are written on the event itself.
   * This one cannot be: it is a *later* act by a different party, and the
   * ledger is append-only, so it is its own event pointing back at the
   * execution.
   *
   * `aiAllowed: false`, emphatically. A model marking its own output as
   * accepted is the exact failure this clause exists to catch.
   */
  def('AI_OUTPUT_DISPOSED', 'AIExecution', 'APPROVE', 'GOVERNANCE'),
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

  // --- Concept, stage 6 -----------------------------------------------------
  //
  // The head of the lifecycle, and the last stage to be built — which is the
  // right way round. Every rule here had to be answerable by something
  // downstream before it was worth writing: a requirement that nothing verifies
  // is a wish, and an option selected against no cost plan is a preference.
  //
  // `PROJECT_CREATED` and `PROGRAMME_CREATED` are already in the catalogue and
  // are not duplicated. What was missing is everything that turns a project
  // shell into a governed concept: what it is for, what the site will allow,
  // which option was chosen and why, and what it is expected to cost.

  // C-WF-01. The configuration is versioned rather than edited, because
  // changing it after an approved output has been produced against it is a
  // different act from setting it up — the exception control says so, and a
  // mutable configuration cannot show what an approval was given under.
  def('PROJECT_CONFIGURATION_VERSIONED', 'ProjectConfiguration', 'CREATE', 'PROJECT_CONTROL', { creates: true }),
  def('AUTHORITY_MATRIX_APPROVED', 'AuthorityMatrix', 'APPROVE', 'GOVERNANCE', { creates: true }),

  // C-WF-02. Extraction and acceptance are two events, not one with a flag:
  // AC-C-WF-02-02 requires an AI-created requirement to be visibly distinct
  // until a person accepts it, and a single event with `accepted: false` is
  // exactly the shape that gets defaulted to true by the next caller.
  def('REQUIREMENT_EXTRACTED', 'ProjectRequirement', 'CREATE', 'PROJECT_CONTROL', { aiAllowed: true, creates: true }),
  def('REQUIREMENT_ACCEPTED', 'ProjectRequirement', 'APPROVE', 'PROJECT_CONTROL'),
  // Deletion after baseline is prohibited. Superseding is the only way out, and
  // it carries the reason and the replacement.
  def('REQUIREMENT_SUPERSEDED', 'ProjectRequirement', 'UPDATE', 'PROJECT_CONTROL'),
  def('BRIEF_BASELINED', 'BriefBaseline', 'APPROVE', 'PROJECT_CONTROL', { requiresEvidence: true, creates: true }),

  // C-WF-03. `Constraint` is already taken by the Last Planner constraint log,
  // which is a different thing entirely — something blocking a task next week,
  // not something the ground will never permit. `SiteConstraint` is its own
  // entity for that reason rather than an overloaded status on the other.
  def('SURVEY_REGISTERED', 'SiteSurvey', 'CREATE', 'PROJECT_CONTROL', { requiresEvidence: true, creates: true }),
  def('SURVEY_SUPERSEDED', 'SiteSurvey', 'UPDATE', 'PROJECT_CONTROL'),
  def('CONSTRAINT_IDENTIFIED', 'SiteConstraint', 'CREATE', 'PROJECT_CONTROL', { aiAllowed: true, creates: true }),
  def('CONSTRAINT_ASSESSED', 'SiteConstraint', 'APPROVE', 'PROJECT_CONTROL'),
  def('INVESTIGATION_ASSIGNED', 'InvestigationAction', 'CREATE', 'PROJECT_CONTROL', { creates: true }),
  def('INVESTIGATION_CLOSED', 'InvestigationAction', 'UPDATE', 'PROJECT_CONTROL', { requiresEvidence: true }),
  def('DUE_DILIGENCE_REVIEWED', 'DueDiligenceReview', 'APPROVE', 'PROJECT_CONTROL', { creates: true }),

  // C-WF-04. Four events because rejection is a record, not an absence: the
  // rejected options are the evidence that a choice was made rather than a
  // preference expressed, and AC-C-WF-04-01 requires their rationale.
  def('OPTION_CREATED', 'FeasibilityOption', 'CREATE', 'PROJECT_CONTROL', { creates: true }),
  def('OPTION_ANALYSED', 'FeasibilityOption', 'UPDATE', 'PROJECT_CONTROL', { aiAllowed: true }),
  def('OPTION_SELECTED', 'FeasibilityOption', 'APPROVE', 'PROJECT_CONTROL', { requiresEvidence: true }),
  def('OPTION_REJECTED', 'FeasibilityOption', 'APPROVE', 'PROJECT_CONTROL'),

  // C-WF-05. The approval is one event over both, because the exception control
  // forbids approving cost and programme independently where time-related cost
  // is material — and on a construction project it always is.
  def('COST_PLAN_CREATED', 'ConceptCostPlan', 'CREATE', 'COMMERCIAL', { creates: true }),
  def('COST_PLAN_LINE_ADDED', 'ConceptCostPlan', 'UPDATE', 'COMMERCIAL'),
  def('MILESTONE_PROGRAMME_CREATED', 'MilestoneProgramme', 'CREATE', 'PROJECT_CONTROL', { creates: true }),
  def('CONCEPT_CASHFLOW_GENERATED', 'ConceptCashflow', 'CREATE', 'COMMERCIAL', { creates: true }),
  def('CONCEPT_CONTROLS_APPROVED', 'ConceptControls', 'APPROVE', 'COMMERCIAL', { requiresEvidence: true, creates: true }),

  // C-WF-06. Strategy, not procurement. The tender-stage entities are separate
  // and downstream; this is the decision about which of them will exist.
  def('PROCUREMENT_STRATEGY_CREATED', 'ProcurementStrategy', 'CREATE', 'PROCUREMENT', { creates: true }),
  def('PACKAGE_STRATEGY_APPROVED', 'PackageStrategy', 'APPROVE', 'PROCUREMENT', { creates: true }),
  def('CONTRACT_STRATEGY_SELECTED', 'ContractStrategy', 'APPROVE', 'CONTRACTS_CLAIMS', { creates: true }),

  // C-WF-07. `RISK_REGISTERED`, `RISK_SCORED` and `RISK_MITIGATION_SET` already
  // exist and carry the register; they are not duplicated. Missing were the two
  // acts that make a register a governed position rather than a list.
  def('COMPLIANCE_APPLICABILITY_CONFIRMED', 'ComplianceApplicability', 'APPROVE', 'RISK_SAFETY', { creates: true }),
  def('RISK_REVIEW_APPROVED', 'ConceptRiskReview', 'APPROVE', 'RISK_SAFETY', { creates: true }),

  // C-WF-08. The specification names `STAGE_VALIDATED` and
  // `PROJECT_STAGE_TRANSITIONED`; this platform already carries both acts under
  // the names every other stage uses — `STAGE_INSTANCE_STATUS_CHANGED` and
  // `PROJECT_PHASE_TRANSITIONED` — together with `STAGE_GATE_DECIDED` and
  // `STAGE_INSTANCE_LOCKED`. Registering synonyms would give the same act two
  // codes and split every query over the gate ceremony in half. The concept
  // baseline is the one thing stage 6 freezes that no other stage does, and it
  // is the only new event the gate needs.
  def('CONCEPT_BASELINE_APPROVED', 'ConceptBaseline', 'APPROVE', 'PROJECT_CONTROL', { requiresEvidence: true, creates: true }),
];

/**
 * The acts a platform operator is accountable for.
 *
 * An explicit, closed list — and it is a list rather than a rule because the
 * first attempt used a rule and the rule was wrong. Every governance act is
 * written to a `<tenantId>-governance` project, so selecting those projects
 * looked like a clean structural boundary. It is not: that project is where
 * *everything tenant-scoped* is written, including portfolios, programmes,
 * suppliers, opportunities and radar runs. Selecting it handed the operator a
 * customer's commercial pipeline, and the mistake was invisible on an estate
 * with no delivery data on it — which is exactly what a fresh test fixture is.
 *
 * So the boundary is stated, one code at a time, and anything not named here is
 * out of the operator's reach by default. That is the right direction for the
 * failure to fall: a governance act missing from this list is a gap in an audit
 * screen, while a delivery event wrongly added is a customer's work handed to
 * somebody who has no business seeing it.
 *
 * Three things are deliberately absent:
 *
 * - **`ACU_CONSUMED`, `ACU_HELD`, `ACU_RELEASED` and the cap alerts.** Spend has
 *   its own view, computed from the wallet, and these are high-volume enough to
 *   bury the fifteen acts that actually need reading.
 * - **`PAYMENT_CERTIFIED`, `PAYMENT_NOTICE_ISSUED`, `PAYMENT_CYCLE_GENERATED`.**
 *   Those are construction contract payments under the Construction Act —
 *   a customer paying their subcontractor, not anybody paying the platform. The
 *   shared word "payment" is the whole trap.
 * - **`INVOICE_ISSUED`.** It reads as platform billing and is not worth the risk
 *   of being wrong about; the payment receipt already records money arriving.
 */
export const PLATFORM_GOVERNANCE_EVENTS: readonly string[] = [
  // Tenancy and its commercial terms
  'TENANT_CREATED',
  'ENTERPRISE_CREATED',
  'SUBSCRIPTION_ACTIVATED',
  'SUBSCRIPTION_STATUS_CHANGED',
  // Identity — who exists, what they may do, and their removal
  'USER_CREATED',
  'USER_ROLE_ASSIGNED',
  'IDENTITY_SEAT_ASSIGNED',
  'IDENTITY_SEAT_REVOKED',
  'USER_ERASURE_REQUESTED',
  'USER_ERASURE_CANCELLED',
  'USER_ERASED',
  // Money entering the platform, and the ceilings on spending it
  'ACU_WALLET_OPENED',
  'ACU_TOPPED_UP',
  'ACU_CAPS_SET',
  'PAYMENT_RECEIVED',
];

const GOVERNANCE = new Set(PLATFORM_GOVERNANCE_EVENTS);

/** Whether an event is one the platform operator is accountable for. */
export function isPlatformGovernanceEvent(code: string): boolean {
  return GOVERNANCE.has(code);
}

const BY_CODE = new Map(EVENT_TYPES.map((t) => [t.code, t]));

export function lookupEventType(code: string): EventTypeDefinition | undefined {
  return BY_CODE.get(code);
}

export function eventTypeCodes(): string[] {
  return EVENT_TYPES.map((t) => t.code);
}
