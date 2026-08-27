# The workflow specifications as received

Verbatim. This is the source text for sections 6.3, 6.4, 7.3, 7.4, 8.3 and 8.4 —
the twenty-four workflow specifications and the three stage-gate Definitions of
Done — reproduced here so the requirement outlives the conversation it arrived
in. **Nothing in this file is a statement about what is built.** `docs/STATE.md`
says what exists; `docs/SPEC.md` says how each clause below was answered, or
that it was not.

Sections 6.3, 7.3 and 8.3 open with the concept, design and tender workflow
sets; C-WF-01, D-WF-01 and T-WF-01 are the first entry under each heading.

---

## 6.3

```
6.3 Workflow specifications
C-WF-01 - Project initiation and control configuration
Primary owner: Enterprise Client Admin → Project Director  |  Trigger: Authorised project creation
Required inputs
•	Portfolio/programme ID and enterprise legal entity
•	project name/code, sector/subsector and asset type
•	jurisdiction, local time zone, reporting currency and measurement system
•	sponsor, project director and delegated authority matrix
•	data residency, retention and sensitivity defaults
Deterministic flow
1.	Create the project shell and stable project ID; do not create delivery data from platform-admin.
2.	Select versioned jurisdiction, contract-calendar and classification packs.
3.	Create project parties, appointments, role scopes and maker-checker rules.
4.	Create default CDE containers, registers, numbering sequences and stage-gate checklist.
5.	Issue invitations only after scope, party and sensitivity policy validation.
6.	Emit project configuration snapshot and require Project Director acceptance.
AI-agent duties and human guardrails
•	Propose missing setup fields from enterprise templates; never invent legal entity, appointment or authority.
•	Explain configuration conflicts and likely downstream consequences.
Outputs
•	ProjectConfiguration v1
•	AuthorityMatrix v1
•	Party/role register
•	StageGateChecklist
•	CDE configuration
Exception controls
•	Duplicate project code blocks creation.
•	Missing jurisdiction/time zone/currency blocks baseline work.
•	Changing configuration after approved outputs requires impact assessment and a new configuration version.
Events: PROJECT_CREATED | PROJECT_CONFIGURATION_VERSIONED | AUTHORITY_MATRIX_APPROVED
APIs:   POST /v1/projects | POST /v1/projects/{id}/configuration | POST /v1/projects/{id}/authority-matrix:approve
Acceptance criteria
•	AC-C-WF-01-01: Platform Super Admin cannot execute any endpoint in this workflow.
•	AC-C-WF-01-02: Every project-scoped user resolves to one tenant, party and approved role scope.
•	AC-C-WF-01-03: All dates render in project time zone and persist as UTC with original offset.
```

## C-WF-02

```
C-WF-02 - Strategic brief and requirements baseline
Primary owner: Project Director / Client Requirements Lead  |  Trigger: Project shell accepted
Required inputs
•	Business case and sponsor objectives
•	functional brief, capacity and spatial/linear/output requirements
•	quality, safety, carbon, energy, resilience, accessibility and maintainability outcomes
•	scope inclusions, exclusions, interfaces and assumptions
•	measurable acceptance criteria and priority weighting
Deterministic flow
1.	Capture each requirement as an atomic record with category, source, owner, priority and verification method.
2.	Detect ambiguous, conflicting, duplicated and non-measurable statements.
3.	Route clarification actions to named owners with decision dates.
4.	Link every accepted requirement to proposed verification evidence and lifecycle stage.
5.	Freeze the approved brief; subsequent change proceeds through change control, never silent overwrite.
AI-agent duties and human guardrails
•	Decompose narrative documents into candidate requirements with source-page anchors and confidence.
•	Suggest measurable acceptance wording and identify unverified operational outcomes.
Outputs
•	RequirementsRegister
•	BriefBaseline
•	Assumptions/Exclusions Register
•	Verification and Validation Matrix
Exception controls
•	Extraction confidence below configured threshold remains Draft-Needs Review.
•	Conflicting mandatory requirements block option approval.
•	Requirement deletion after baseline is prohibited; supersede with reason.
Events: REQUIREMENT_EXTRACTED | REQUIREMENT_ACCEPTED | BRIEF_BASELINED | REQUIREMENT_SUPERSEDED
APIs:   POST /v1/projects/{id}/requirements:extract | POST /v1/requirements/{id}:accept | POST /v1/projects/{id}/brief:baseline
Acceptance criteria
•	AC-C-WF-02-01: 100% of baseline requirements have source, owner, priority and verification method.
•	AC-C-WF-02-02: AI-created requirements are visually marked until human acceptance.
•	AC-C-WF-02-03: A changed requirement shows affected design, cost, programme and approvals before approval.
```

## C-WF-03

```
C-WF-03 - Site, asset and constraint due diligence
Primary owner: Project Manager / Discipline Leads  |  Trigger: Site boundary or asset scope available
Required inputs
•	Cadastral/GIS boundary and rights
•	topographic, utility, geotechnical, contamination, ecology, flood and heritage surveys
•	existing drawings/models/asset data and intrusive-survey limitations
•	access, logistics, neighbours, possession/outage and operational constraints
•	planning, permitting and building-control pre-application evidence
Deterministic flow
1.	Register each survey with date, author, coverage, coordinate system, limitations and reliance status.
2.	Georeference constraints and link them to zones, assets and proposed options.
3.	Create unknowns and further-investigation actions for gaps or expired evidence.
4.	Classify constraint as hard, soft, assumption or opportunity and assign owner/date.
5.	Publish a due-diligence readiness score based on evidence coverage, not document count.
AI-agent duties and human guardrails
•	Extract findings and limitations; cross-check contradictions between surveys and drawings.
•	Produce constraint overlays and option-specific risk prompts, subject to professional validation.
Outputs
•	SiteConstraintRegister
•	SurveyCoverageMap
•	InvestigationPlan
•	DueDiligenceReadiness Snapshot
Exception controls
•	Unknown coordinate system prevents spatial overlay.
•	Superseded/expired survey is usable only as historic evidence.
•	Material unknowns must carry quantified allowance or explicit sponsor acceptance.
Events: SURVEY_REGISTERED | CONSTRAINT_IDENTIFIED | INVESTIGATION_ASSIGNED | DUE_DILIGENCE_REVIEWED
APIs:   POST /v1/projects/{id}/surveys | POST /v1/projects/{id}/constraints | POST /v1/constraints/{id}:accept
Acceptance criteria
•	AC-C-WF-03-01: Every constraint has evidence, spatial scope, impact categories and owner.
•	AC-C-WF-03-02: Options cannot be recommended while a critical constraint is unassessed.
•	AC-C-WF-03-03: Map and register use the same stable constraint IDs.
```

## C-WF-04

```
C-WF-04 - Feasibility options and option selection
Primary owner: Project Director / Design Lead  |  Trigger: Brief and initial due diligence sufficiently complete
Required inputs
•	Approved requirements and constraints
•	option geometry/capacity/technology/procurement assumptions
•	order-of-cost and programme ranges
•	operability, sustainability, safety and stakeholder criteria
•	criteria weights and decision authority
Deterministic flow
1.	Create comparable options using a fixed evaluation template and common base date.
2.	Record assumptions, exclusions, dependencies and confidence range for every option.
3.	Score criteria; preserve raw values separately from weighted score.
4.	Run sensitivity tests against budget, completion date, key risk and criteria weighting.
5.	Hold option review; record dissent, conditions and selected/rejected rationale.
6.	Freeze selected option and carry rejected options as historic alternatives.
AI-agent duties and human guardrails
•	Generate evidence-grounded comparisons and expose missing evidence.
•	Run scenarios; never choose the option or conceal uncertainty behind a single score.
Outputs
•	Option records
•	OptionComparison
•	SensitivityAnalysis
•	OptionSelection DecisionRecord
Exception controls
•	Options with different scope or price base are not comparable until normalised.
•	A selected option outside budget/time tolerance requires sponsor exception approval.
Events: OPTION_CREATED | OPTION_ANALYSED | OPTION_SELECTED | OPTION_REJECTED
APIs:   POST /v1/projects/{id}/options | POST /v1/options:compare | POST /v1/options/{id}:select
Acceptance criteria
•	AC-C-WF-04-01: Decision record contains evidence, attendees, authority, conditions and rejected rationale.
•	AC-C-WF-04-02: Scenario results are reproducible from stored inputs/model version.
•	AC-C-WF-04-03: Selected option links to the brief, cost, programme and risk snapshot used in approval.
```

## C-WF-05

```
C-WF-05 - Concept cost, programme and cashflow baseline
Primary owner: Cost Manager + Planner  |  Trigger: Comparable option definition
Required inputs
•	Scope quantities/capacity metrics
•	benchmark sources, location factors, base date, inflation and currency
•	preliminaries, design fees, risk, contingency, tax/duties and client costs
•	calendar, approvals, design/procurement/construction/commissioning durations
•	funding drawdown and payment assumptions
Deterministic flow
1.	Create elemental/package cost structure mapped to CBS/WBS and classification.
2.	Store low/most-likely/high ranges and source confidence for quantities and rates.
3.	Build milestone programme with logic, approval gates, procurement lead times and commissioning/handover.
4.	Time-phase cost against programme and produce cashflow range.
5.	Reconcile budget cap, risk allowance and funding; record affordability gap actions.
6.	Submit coupled cost/programme snapshot for independent approval.
AI-agent duties and human guardrails
•	Suggest benchmarks and missing cost categories from organisation memory; source and base-date are mandatory.
•	Detect impossible durations, double-counted contingency and inconsistent phasing.
Outputs
•	ConceptCostPlan
•	MilestoneProgramme
•	CashflowForecast
•	AffordabilityStatement
Exception controls
•	Unverified rate remains provisional and is excluded from high-confidence total.
•	Currency conversion stores rate, provider and timestamp.
•	Cost and programme cannot be approved independently when time-related cost is material.
Events: COST_PLAN_CREATED | PROGRAMME_CREATED | CASHFLOW_GENERATED | CONCEPT_CONTROLS_APPROVED
APIs:   POST /v1/projects/{id}/cost-plans | POST /v1/projects/{id}/programmes | POST /v1/concept-controls/{id}:approve
Acceptance criteria
•	AC-C-WF-05-01: Totals reconcile from line item to option and project.
•	AC-C-WF-05-02: Programme has logical predecessors/successors or documented open-start/open-finish exception.
•	AC-C-WF-05-03: P50/P80 or configured confidence ranges show method and assumptions.
```

## C-WF-06

```
C-WF-06 - Procurement, contract and delivery strategy
Primary owner: Commercial Director / Project Director  |  Trigger: Selected option and concept controls available
Required inputs
•	Design responsibility and risk appetite
•	market capacity, package strategy and long-lead constraints
•	candidate procurement routes and contract forms
•	payment, insurance, bond, guarantee and security requirements
•	social value/local content/sustainability obligations
Deterministic flow
1.	Compare routes against scope certainty, time, price certainty, design control and market capacity.
2.	Define packaging, interfaces, retained risks and required appointments.
3.	Select contract-form family and create provisional clause/notice configuration pack; project-specific amendments require later extraction.
4.	Create procurement milestones tied to design information release and construction need dates.
5.	Record strategy approval and initialise tender/procurement registers.
AI-agent duties and human guardrails
•	Expose route-specific risks and missing decisions; do not provide legal approval.
•	Recommend package sequence based on lead time and design maturity with confidence.
Outputs
•	ProcurementStrategy
•	PackageStrategy
•	ContractStrategy
•	ProcurementMilestone Plan
Exception controls
•	Single-source route requires authorised justification.
•	Package scope overlap/gap blocks approval.
•	Contract rules remain provisional until executed contract is ingested and validated.
Events: PROCUREMENT_STRATEGY_CREATED | PACKAGE_STRATEGY_APPROVED | CONTRACT_STRATEGY_SELECTED
APIs:   POST /v1/projects/{id}/procurement-strategies | POST /v1/projects/{id}/package-strategy:approve
Acceptance criteria
•	AC-C-WF-06-01: Every proposed package has scope boundary, interfaces, procurement dates and owner.
•	AC-C-WF-06-02: Route decision records weighted criteria and authority.
•	AC-C-WF-06-03: Long-lead procurement dates trace to required-on-site milestones.
```

## C-WF-07

```
C-WF-07 - Risk, opportunity, safety and compliance initiation
Primary owner: Project Director + HSE/Compliance Leads  |  Trigger: Brief, site and option evidence available
Required inputs
•	Risk taxonomy and scoring matrix
•	design/construction/operational hazard prompts
•	jurisdictional approvals and dutyholder screening
•	stakeholder/environment/community constraints
•	cost/programme quantitative assumptions
Deterministic flow
1.	Create risk and opportunity records with cause-event-effect wording.
2.	Score inherent exposure; assign preventive/mitigating actions and residual target.
3.	Link threats to requirements, constraints, cost allowance and programme activities.
4.	Screen CDM/dutyholder and higher-risk-building/Gateway applicability.
5.	Escalate critical intolerable risks; hold concept risk review and approve retained exposure.
AI-agent duties and human guardrails
•	Suggest missing risks from similar projects and source documents; flag as candidate until accepted.
•	Quantify exposure ranges and correlations only where data is sufficient.
Outputs
•	RiskOpportunityRegister
•	Approval/Consent Register
•	DutyholderApplicability Record
•	Risk-adjusted Cost/Programme Inputs
Exception controls
•	Critical risk without named owner and action blocks gate.
•	AI safety or legal classification requires competent-person confirmation.
Events: RISK_CREATED | RISK_ASSESSED | COMPLIANCE_APPLICABILITY_CONFIRMED | RISK_REVIEW_APPROVED
APIs:   POST /v1/projects/{id}/risks | POST /v1/projects/{id}/compliance-screen | POST /v1/risk-reviews/{id}:approve
Acceptance criteria
•	AC-C-WF-07-01: No risk record lacks cause, event, effect, owner, due date and linked response.
•	AC-C-WF-07-02: Risk allowance reconciles to cost plan without double counting.
•	AC-C-WF-07-03: Applicable statutory gateways appear as non-bypassable project milestones.
```

## C-WF-08

```
C-WF-08 - Concept stage assurance and gate
Primary owner: Project Director / Sponsor Approver  |  Trigger: Concept workstreams submitted
Required inputs
•	Brief, selected option, cost, programme, cashflow, procurement, risk and consent snapshots
•	Open actions, waivers, assumptions and evidence completeness
•	Independent review comments and delegated authority
Deterministic flow
1.	Run deterministic completeness and cross-consistency rules.
2.	Show blockers, warnings, stale inputs, low-confidence outputs and downstream impacts.
3.	Assign corrective actions; permitted warning waivers require reason, expiry and approver.
4.	Present gate decision pack and capture approve/approve-with-conditions/reject.
5.	On approval, lock component versions and create Design stage mobilisation tasks.
AI-agent duties and human guardrails
•	Draft gate narrative and evidence index; cannot change blocker status or approve.
•	Highlight contradictions among scope, budget, programme and risk.
Outputs
•	ConceptGateReport
•	ApprovedConceptBaseline
•	DesignMobilisation Worklist
•	DecisionRecord
Exception controls
•	All mandatory requirements must be complete; zero blockers is required.
•	Conditional approval creates tracked conditions with due dates and cannot silently become full approval.
Events: STAGE_VALIDATED | CONCEPT_GATE_SUBMITTED | CONCEPT_BASELINE_APPROVED | PROJECT_STAGE_TRANSITIONED
APIs:   POST /v1/projects/{id}/stages/concept:validate | POST /v1/projects/{id}/stages/concept:submit | POST /v1/stage-gates/{id}:decide
Acceptance criteria
•	AC-C-WF-08-01: Gate pack is reproducible and references exact component versions.
•	AC-C-WF-08-02: A rejected gate leaves the project in Concept and records required rework.
•	AC-C-WF-08-03: Design cannot publish an approved deliverable before Concept gate or authorised exception.
```

## 6.4

```
6.4 Stage gate Definition of Done
•	All mandatory inputs are present, validated and tied to exact source versions; completeness is 100% and blocking issues equal zero.
•	All approvals satisfy appointment, authority, maker-checker and party-separation policies.
•	All critical/major safety, compliance, interface and information blockers are closed or governed by a permitted, time-bound condition.
•	Cost, programme, risk, information and commercial snapshots share one declared cut-off and are cross-reconciled.
•	AI outputs used in the decision have evidence, confidence, assumptions, model/prompt versions, ACU settlement and human disposition.
•	Gate report, decision and locked baseline can be replayed from the event store and verified against evidence hashes.
•	Downstream mobilisation tasks, owners, due dates and inherited residual obligations are automatically created without re-entry.
```

## 7.3

```
7.3 Workflow specifications
D-WF-01 - Design mobilisation, responsibility and information planning
Primary owner: Design Manager / Information Manager  |  Trigger: Concept gate approval
Required inputs
•	Approved brief and concept baseline
•	appointments and scopes
•	design responsibility matrix and interface ownership
•	EIR/AIR and exchange requirements
•	design programme and procurement need dates
Deterministic flow
1.	Create design packages, disciplines, zones and deliverable obligations.
2.	Assign author, checker, approver and accepting party; prohibit unowned interfaces.
3.	Create MIDP and team TIDPs with issue purpose, suitability, due date and dependency.
4.	Configure CDE states Work-in-Progress, Shared, Published/Documentation and Archive with permission rules.
5.	Create review durations, planned acceptance dates and escalation routes.
6.	Approve mobilisation snapshot before deliverable production.
AI-agent duties and human guardrails
•	Suggest deliverables and interfaces from scope/package templates; mark as candidate.
•	Detect missing responsibility, impossible review periods and delivery dates later than procurement/site need.
Outputs
•	DesignPackage Register
•	Responsibility Matrix
•	MIDP/TIDPs
•	DesignDelivery Programme
•	CDE workflow
Exception controls
•	No deliverable may move to Shared without author/checker and metadata.
•	Delegated design does not remove the lead designer's interface obligations.
•	Responsibility change requires acceptance by outgoing/incoming owners.
Events: DESIGN_PACKAGE_CREATED | DESIGN_RESPONSIBILITY_ASSIGNED | MIDP_APPROVED | CDE_WORKFLOW_APPROVED
APIs:   POST /v1/projects/{id}/design-packages | POST /v1/projects/{id}/midp | POST /v1/midp/{id}:approve
Acceptance criteria
•	AC-D-WF-01-01: Every required deliverable has owner, checker, approver, purpose, format and due date.
•	AC-D-WF-01-02: MIDP totals reconcile with TIDPs and expose missing/duplicated deliverables.
•	AC-D-WF-01-03: Role changes preserve prior accountability in the audit trail.
```

## D-WF-02

```
D-WF-02 - Drawing, model, calculation and specification ingestion
Primary owner: Information Manager  |  Trigger: Information container uploaded or received through CDE integration
Required inputs
•	File/blob and immutable hash
•	originator, project, volume/system, level/location, type, role/discipline and number
•	revision, status/suitability, issue purpose and date
•	native/IFC/PDF relationships, coordinate system and units
•	transmittal and recipient scope
Deterministic flow
1.	Virus/malware scan, hash and quarantine until complete.
2.	Parse title blocks and file metadata; compare with submitted metadata.
3.	Validate naming, revision sequence, required attributes, file type, coordinates and units.
4.	Create container revision and explicit predecessor/supersession links.
5.	Route technical content to extraction/indexing; preserve original bytes.
6.	Notify only affected packages and require receipt/acknowledgement where configured.
AI-agent duties and human guardrails
•	Extract title-block data, sheets, objects, clauses and schedules with page/object anchors.
•	Flag suspected revision differences and classification; never publish automatically.
Outputs
•	InformationContainer Revision
•	Drawing/Model/Specification records
•	Extraction set
•	Transmittal/Acknowledgement records
Exception controls
•	Hash duplicate with same metadata is idempotent; with conflicting metadata it creates a review exception.
•	Unknown units/coordinates block quantitative or spatial automation.
•	Superseded information remains searchable but is visibly barred from current-work views.
Events: FILE_UPLOADED | INFORMATION_VALIDATED | FILE_EXTRACTED | REVISION_SUPERSEDED | TRANSMITTAL_ISSUED
APIs:   POST /v1/projects/{id}/files:presign | POST /v1/projects/{id}/files:complete | POST /v1/information-containers/{id}:validate
Acceptance criteria
•	AC-D-WF-02-01: Original, preview, extraction and derived entities share a traceable file ID/version.
•	AC-D-WF-02-02: No Published container lacks accepted status/suitability and issue record.
•	AC-D-WF-02-03: Affected users see supersession before opening the old revision.
```

## D-WF-03

```
D-WF-03 - Design production, check, review and acceptance
Primary owner: Discipline Lead → Design Manager / Client Reviewer  |  Trigger: Planned deliverable reaches review state
Required inputs
•	Information container revision
•	requirements and verification matrix
•	design criteria, calculations, specifications and referenced standards
•	review checklist and authority
•	prior comments/issues and dependency state
Deterministic flow
1.	Author submits from WIP to Shared with self-check declaration.
2.	Checker records clause/object/region-specific comments, severity and disposition.
3.	Author responds Accept/Reject/Propose Alternative with evidence; comments cannot disappear.
4.	Approver confirms technical and interface review completion.
5.	Accepting party records Accepted, Accepted with Comments, Revise and Resubmit, or Rejected.
6.	Published status creates a frozen revision; revisions require a new cycle.
AI-agent duties and human guardrails
•	Compare deliverable against requirements, prior revision, specification and related disciplines.
•	Draft review comments with evidence and severity; human reviewer confirms each material finding.
Outputs
•	ReviewCycle
•	Comment/Disposition Register
•	Accepted/Rejected Container
•	DesignDecision Records
Exception controls
•	Maker cannot act as independent checker where policy prohibits.
•	Accepted-with-comments may not conceal Critical/Major open comments.
•	Late review triggers programme impact and escalation.
Events: DESIGN_SUBMITTED_FOR_REVIEW | REVIEW_COMMENT_RAISED | COMMENT_DISPOSITIONED | DESIGN_ACCEPTED | DESIGN_REJECTED
APIs:   POST /v1/design-deliverables/{id}:submit | POST /v1/review-cycles/{id}/comments | POST /v1/design-deliverables/{id}:decide
Acceptance criteria
•	AC-D-WF-03-01: Every comment retains creator, location, evidence, response, final disposition and timestamps.
•	AC-D-WF-03-02: Publication is impossible with blocking comments.
•	AC-D-WF-03-03: Review duration and overdue ownership appear on design dashboards.
```

## D-WF-04

```
D-WF-04 - Multidiscipline coordination, clash and interface control
Primary owner: Design Manager / BIM Coordinator  |  Trigger: Federation milestone or new relevant model revision
Required inputs
•	Validated models and federation rules
•	model coordinates, zones, systems and tolerances
•	interface matrix
•	clash/clearance rules and exclusions
•	construction sequence and access/maintenance envelopes
Deterministic flow
1.	Create immutable federation set from exact model revisions.
2.	Run geometry, clearance, attribute and rule-based checks.
3.	Group duplicate clashes into actionable issues by location/system/root cause.
4.	Assign issue owner, affected parties, severity, due date and target revision.
5.	Manage issue through Open → Assigned → In Resolution → Ready for Verification → Verified → Closed.
6.	Re-run against new federation and preserve comparison metrics.
AI-agent duties and human guardrails
•	Cluster and explain clashes; suggest ownership and programme/cost impact.
•	Use BCF/object GUID references; no AI-only closure.
Outputs
•	FederationSet
•	ClashRun
•	BCF/Coordination Issues
•	InterfaceDecision Records
•	Coordination Report
Exception controls
•	Model misalignment or unit mismatch blocks clash run.
•	Accepted clash requires reason, risk owner and approval; it is not marked Resolved.
•	Closed issue reopens automatically if recurrence is detected.
Events: MODEL_FEDERATION_CREATED | CLASH_RUN_COMPLETED | COORDINATION_ISSUE_ASSIGNED | ISSUE_VERIFIED
APIs:   POST /v1/model-sets | POST /v1/model-sets/{id}:clash-detect | POST /v1/bcf/issues/{id}:verify
Acceptance criteria
•	AC-D-WF-04-01: Each clash result references exact model revisions and rule set.
•	AC-D-WF-04-02: Critical unresolved clashes appear as stage blockers and programme constraints.
•	AC-D-WF-04-03: BCF export/import preserves GUID, viewpoint, status and evidence.
```

## D-WF-05

```
D-WF-05 - Design queries, RFIs, submittals and technical decisions
Primary owner: Design Manager / Project Manager  |  Trigger: Ambiguity, missing information, proposed product or technical decision
Required inputs
•	Question/submittal description
•	drawing/model object/specification/requirement references
•	location/package/activity and required-by date
•	proposed response or alternatives
•	commercial/programme/safety impact statement
Deterministic flow
1.	Classify as design query, RFI, technical submittal, sample/mock-up or deviation.
2.	Route to responsible designer and reviewers with contractual response calendar.
3.	Validate response addresses the question and includes controlled replacement information where needed.
4.	Record accepted/rejected/clarification-required decision and conditions.
5.	Update affected design, procurement, programme, risk and change records.
6.	Close only after linked action and information update are verified.
AI-agent duties and human guardrails
•	Draft concise query from voice/markup and locate probable answer sources.
•	Detect response contradiction or hidden deviation; never treat generated answer as designer instruction.
Outputs
•	RFI/Query/Submittal Record
•	TechnicalDecision
•	Linked Change Candidate
•	Updated information actions
Exception controls
•	Email alone is not closure; response must be captured in the controlled record.
•	Late/ambiguous response triggers escalation and delay evidence.
•	Accepted deviation requires authorised change/compliance route.
Events: RFI_RAISED | SUBMITTAL_SUBMITTED | TECHNICAL_RESPONSE_ISSUED | TECHNICAL_DECISION_ACCEPTED | RFI_CLOSED
APIs:   POST /v1/projects/{id}/rfis | POST /v1/projects/{id}/submittals | POST /v1/technical-decisions/{id}:accept
Acceptance criteria
•	AC-D-WF-05-01: Required-by date derives from linked activity/procurement date where present.
•	AC-D-WF-05-02: Response due, overdue and impact are visible by responsible party.
•	AC-D-WF-05-03: Closure verifies downstream controlled information has been updated.
```

## D-WF-06

```
D-WF-06 - Design change and impact control
Primary owner: Design Manager + Commercial/Planning Leads  |  Trigger: Proposed change to approved brief, design or interface
Required inputs
•	Origin and instruction/request reference
•	current and proposed requirement/design revisions
•	reason and classification: correction, client change, value engineering, compliance, site condition
•	affected packages/assets/approvals
•	initial cost, time, safety, carbon, procurement and handover impacts
Deterministic flow
1.	Register change before design implementation and preserve originating evidence.
2.	Determine materiality and approval route from jurisdiction/authority configuration.
3.	Create impact assessment tasks for design, commercial, planning, safety, procurement and information.
4.	Compare options and obtain decision Approve/Reject/More Information.
5.	On approval, update requirements and create controlled deliverable revisions; on rejection preserve record.
6.	Verify implementation across affected outputs and close with benefit/impact realised.
AI-agent duties and human guardrails
•	Identify potentially affected objects, clauses, activities, BoQ items and approvals.
•	Draft impact narrative and detect downstream records not updated.
Outputs
•	DesignChange Request
•	ImpactAssessment
•	ChangeDecision
•	Implementation/Verification Tasks
Exception controls
•	Emergency safety correction follows expedited approval but cannot bypass retrospective record.
•	Major higher-risk-building change invokes configured regulator approval and work hold.
•	No silent revision after baseline.
Events: DESIGN_CHANGE_PROPOSED | CHANGE_IMPACT_ASSESSED | DESIGN_CHANGE_APPROVED | CHANGE_IMPLEMENTED | CHANGE_VERIFIED
APIs:   POST /v1/projects/{id}/design-changes | POST /v1/design-changes/{id}:assess | POST /v1/design-changes/{id}:decide
Acceptance criteria
•	AC-D-WF-06-01: Implementation cannot start before required approvals except recorded emergency path.
•	AC-D-WF-06-02: Impact assessment covers all configured domains or records Not Applicable with reason.
•	AC-D-WF-06-03: Closure confirms every affected baseline/reference was revised or explicitly unaffected.
```

## D-WF-07

```
D-WF-07 - Constructability, temporary works, logistics and design risk review
Primary owner: Construction Manager / Principal Designer  |  Trigger: Package reaches configured design maturity or before freeze
Required inputs
•	Design deliverables and sequence
•	site logistics, access, lifting and temporary works assumptions
•	construction methods and resource constraints
•	design risk register and residual-risk communication
•	maintenance, replacement and safe-access requirements
Deterministic flow
1.	Hold structured review by package/zone/system with construction, design, HSE and operations.
2.	Record buildability, tolerances, access, sequencing, temporary works, testability and maintainability findings.
3.	Convert findings into design change, risk, RFI, method constraint or acceptance record.
4.	Link residual design risks to drawings/models, pre-construction information and later RAMS.
5.	Verify critical findings resolved before design freeze.
AI-agent duties and human guardrails
•	Compare design against organisation lessons and known construction constraints.
•	Suggest residual-risk prompts; competent designers decide elimination/reduction/communication.
Outputs
•	ConstructabilityReview
•	TemporaryWorks Interface Register
•	Logistics Constraints
•	ResidualDesignRisk Register
Exception controls
•	Temporary works category/checking requirements are configured and cannot be inferred solely by AI.
•	Unresolved safe-access or testability issue blocks relevant package freeze.
Events: CONSTRUCTABILITY_REVIEWED | DESIGN_RISK_UPDATED | TEMPORARY_WORKS_INTERFACE_RAISED | REVIEW_ACTION_CLOSED
APIs:   POST /v1/design-packages/{id}/constructability-reviews | POST /v1/design-risks/{id}:update
Acceptance criteria
•	AC-D-WF-07-01: Every finding has disposition, owner, date and linked record.
•	AC-D-WF-07-02: Residual design risks are visible in construction work-pack and handover outputs.
•	AC-D-WF-07-03: Operations/maintenance access is reviewed for maintainable assets.
```

## D-WF-08

```
D-WF-08 - Design cost, programme, compliance and stage gate
Primary owner: Project Director / Design Manager  |  Trigger: Design packages submitted for baseline
Required inputs
•	Accepted design containers and model federation
•	updated quantities/cost plan and design/procurement programme
•	open comments, clashes, RFIs, changes and design risks
•	compliance/consent evidence and verification matrix
•	package information readiness and gate authority
Deterministic flow
1.	Reconcile quantities to design revision and cost-plan structure.
2.	Compare design programme and information release dates to procurement/site need dates.
3.	Run compliance and requirements verification; separate evidence-backed pass from pending opinion.
4.	Show blockers by package and permit partial freeze only where isolation rules are satisfied.
5.	Capture gate decision and lock exact accepted revisions, cost/programme/risk snapshots.
6.	Generate Tender mobilisation and missing-information actions.
AI-agent duties and human guardrails
•	Produce evidence index, revision delta and contradiction report.
•	Forecast package readiness; cannot approve compliance or design.
Outputs
•	DesignGateReport
•	DesignBaseline/FrozenPackage Set
•	Updated Cost/Programme/Risk Baselines
•	TenderReadiness Worklist
Exception controls
•	Partial freeze requires defined boundary, interface checks and separate baseline ID.
•	Open Critical/Major compliance or safety items block affected baseline.
•	Later revision automatically invalidates dependent quantity/tender readiness until revalidated.
Events: DESIGN_GATE_SUBMITTED | DESIGN_PACKAGE_FROZEN | DESIGN_BASELINE_APPROVED | PROJECT_STAGE_TRANSITIONED
APIs:   POST /v1/projects/{id}/stages/design:validate | POST /v1/design-packages/{id}:freeze | POST /v1/stage-gates/{id}:decide
Acceptance criteria
•	AC-D-WF-08-01: Every baseline container has revision, status/suitability and acceptance record.
•	AC-D-WF-08-02: Quantity/cost outputs state exact model/drawing sources.
•	AC-D-WF-08-03: Tender cannot issue a package using superseded/unaccepted information without authorised exception visibly included.
```

## 7.4

```
7.4 Stage gate Definition of Done
•	All mandatory inputs are present, validated and tied to exact source versions; completeness is 100% and blocking issues equal zero.
•	All approvals satisfy appointment, authority, maker-checker and party-separation policies.
•	All critical/major safety, compliance, interface and information blockers are closed or governed by a permitted, time-bound condition.
•	Cost, programme, risk, information and commercial snapshots share one declared cut-off and are cross-reconciled.
•	AI outputs used in the decision have evidence, confidence, assumptions, model/prompt versions, ACU settlement and human disposition.
•	Gate report, decision and locked baseline can be replayed from the event store and verified against evidence hashes.
•	Downstream mobilisation tasks, owners, due dates and inherited residual obligations are automatically created without re-entry.
```

## 8.3

```
8.3 Workflow specifications
T-WF-01 - Tender intake, compliance matrix and bid/no-bid
Primary owner: Bid Manager / Commercial Director  |  Trigger: ITT/RFP/RFQ receipt
Required inputs
•	Invitation files, transmittal and deadline
•	client/opportunity/project metadata
•	return instructions and mandatory deliverables
•	evaluation criteria and pass/fail conditions
•	resource/capacity and strategic-fit inputs
Deterministic flow
1.	Register immutable invitation issue and deadline in project time zone.
2.	Extract deliverables, forms, submission channels, page/file limits, signatures and bonds.
3.	Create compliance matrix with owner, internal due date, status and source clause/page.
4.	Score strategic fit, capacity, financial, delivery, contract and win risks.
5.	Record bid/no-bid decision, conditions, authority and re-review triggers.
6.	For Bid, generate tender programme and work packages; for No Bid, preserve rationale.
AI-agent duties and human guardrails
•	Extract requirements and deadlines with source anchors.
•	Draft risk/fit assessment from verified organisation data; cannot decide.
Outputs
•	TenderOpportunity
•	TenderCompliance Matrix
•	BidProgramme
•	BidNoBid DecisionRecord
Exception controls
•	Deadline conflict or unclear time zone is a Critical clarification.
•	Mandatory pass/fail requirement without owner blocks Bid approval.
•	Updated addendum can trigger automatic bid/no-bid re-review.
Events: TENDER_RECEIVED | COMPLIANCE_MATRIX_CREATED | BID_DECISION_RECORDED | TENDER_PROGRAMME_CREATED
APIs:   POST /v1/projects/{id}/tenders | POST /v1/tenders/{id}:extract-requirements | POST /v1/tenders/{id}:bid-decision
Acceptance criteria
•	AC-T-WF-01-01: All mandatory tender deliverables have source, owner and internal date.
•	AC-T-WF-01-02: Decision shows scoring, dissent/conditions and delegated authority.
•	AC-T-WF-01-03: No-bid opportunities remain searchable and cannot proceed to pricing.
```

## T-WF-02

```
T-WF-02 - Tender information, scope gap and contract risk review
Primary owner: Bid Manager + Design/Commercial/Legal Leads  |  Trigger: Bid decision = Bid
Required inputs
•	Tender document set and revisions
•	drawings/models/specifications/BoQ/scope
•	contract form, edition and amendments
•	design responsibility and interfaces
•	addenda and clarification history
Deterministic flow
1.	Validate document register, revisions, missing references and contradictory requirements.
2.	Extract scope obligations and map to WBS/packages/BoQ.
3.	Extract contract obligations, deadlines, payment, change, delay, insurance, security and liability terms.
4.	Create scope gaps/overlaps and contract risks with owner, pricing/programme response and clarification need.
5.	Freeze review snapshot used by pricing; later addenda create impact delta.
AI-agent duties and human guardrails
•	Perform clause/scope extraction with citations and confidence.
•	Suggest risk response and clarification; legal/commercial owners accept or reject.
Outputs
•	TenderDocument Register
•	ScopeMatrix
•	ContractRisk Register
•	Clarification Candidates
•	ReviewSnapshot
Exception controls
•	Unreadable/missing referenced document blocks relevant package pricing.
•	AI clause summary never replaces executed wording.
•	Contract edition/amendment ambiguity is Critical.
Events: TENDER_DOCUMENT_VALIDATED | SCOPE_GAP_IDENTIFIED | CONTRACT_INTERPRETED | TENDER_REVIEW_FROZEN
APIs:   POST /v1/tenders/{id}/documents:validate | POST /v1/tenders/{id}/scope:extract | POST /v1/tenders/{id}/contract-review
Acceptance criteria
•	AC-T-WF-02-01: Every extracted obligation links to clause/page and reviewer status.
•	AC-T-WF-02-02: Pricing exclusions/assumptions trace to scope or contract risk.
•	AC-T-WF-02-03: Addendum impact report identifies affected prices, programme and submissions.
```

## T-WF-03

```
T-WF-03 - Measurement, BoQ and estimate schedule builder
Primary owner: Estimator / QS  |  Trigger: Controlled tender information set available
Required inputs
•	BoQ/schedules or measurement rules
•	drawing/model revision and takeoff evidence
•	quantity, unit, description, location and classification
•	labour/material/plant/subcontract rate build-ups
•	waste, productivity, crew, output and currency/base date
Deterministic flow
1.	Import or create measurable rows with stable item IDs and hierarchy.
2.	Validate units, formulas, duplicates, omissions and quantity-source links.
3.	Create takeoff overlays or model object sets as evidence.
4.	Build unit-rate components and separate direct cost, preliminaries, risk and OH&P.
5.	Create estimate versions and reconciliation from prior estimate/design cost plan.
6.	Freeze pricing snapshot before supplier returns and adjudication.
AI-agent duties and human guardrails
•	Assist takeoff/object counting and anomaly detection; confidence and visual evidence mandatory.
•	Suggest rate build-up gaps; never approve quantity or rate.
Outputs
•	TenderSchedule/BoQ
•	TakeoffEvidence
•	RateBuildups
•	EstimateSnapshot
•	Reconciliation
Exception controls
•	Unit conflict or formula error blocks freeze.
•	Provisional quantity/rate is tagged and included in uncertainty report.
•	A revised drawing invalidates linked quantity until reviewed.
Events: BOQ_IMPORTED | TAKEOFF_CAPTURED | RATE_BUILDUP_CREATED | ESTIMATE_FROZEN
APIs:   POST /v1/tenders/{id}/boq:import | POST /v1/boq-items/{id}/takeoff | POST /v1/estimates/{id}:freeze
Acceptance criteria
•	AC-T-WF-03-01: Every priced item has quantity source or authorised allowance basis.
•	AC-T-WF-03-02: Totals reconcile across item/package/project and currency.
•	AC-T-WF-03-03: Revision impact identifies quantities requiring remeasurement.
```

## T-WF-04

```
T-WF-04 - Package strategy, enquiry composition and bidder issue
Primary owner: Procurement Manager / QS  |  Trigger: Package scope and issue information ready
Required inputs
•	Package scope boundaries and interfaces
•	pricing schedule, drawings/models/specifications
•	design responsibility, attendances, preliminaries and programme
•	payment/contract particulars and return templates
•	approved bidder list, prequalification and conflicts
Deterministic flow
1.	Create package and completeness checklist from dependency rules.
2.	Generate scope, interface/attendance and design responsibility schedules.
3.	Assemble numbered, versioned enquiry pack from controlled documents.
4.	Approve bidders and issue through portal with confidentiality/access controls.
5.	Track sent/delivered/opened/acknowledged/declined and clarification participation.
6.	Close return at deadline; late return follows configured acceptance authority.
AI-agent duties and human guardrails
•	Draft package-specific scope from project specifications and information.
•	Detect missing documents, scope overlap/gaps and inconsistent return fields.
Outputs
•	TenderPackage
•	EnquiryPack Revision
•	BidderIssue Log
•	Acknowledgements
•	ReturnWorkspace
Exception controls
•	Package cannot issue below 100% mandatory dependency completeness unless authorised exception is included.
•	Revoked bidder access does not delete prior issue evidence.
•	Addendum creates new pack revision and acknowledgement requirement.
Events: TENDER_PACKAGE_CREATED | ENQUIRY_PACK_APPROVED | ENQUIRY_ISSUED | BIDDER_ACKNOWLEDGED | RETURN_PERIOD_CLOSED
APIs:   POST /v1/tenders/{id}/packages | POST /v1/tender-packages/{id}:issue | POST /v1/tender-packages/{id}:close-returns
Acceptance criteria
•	AC-T-WF-04-01: Recipient-specific issue evidence shows exact pack revision.
•	AC-T-WF-04-02: Bidder sees only authorised package data.
•	AC-T-WF-04-03: Return workspace locks at deadline while preserving authorised late-return path.
```

## T-WF-05

```
T-WF-05 - Supply-chain and self-delivery pricing routes
Primary owner: Estimator / Procurement Manager  |  Trigger: Pricing package activated
Required inputs
•	Supplier quotations and return templates
•	internal labour/plant/material/productivity data
•	programme, logistics, temporary works and preliminaries
•	scope assumptions, exclusions, risks and qualifications
•	market indices and foreign-exchange assumptions
Deterministic flow
1.	Maintain independent supplier and self-perform routes per package.
2.	Normalise quotations to common scope, unit, tax/currency/base date and commercial basis.
3.	Map inclusions, exclusions, qualifications and provisional sums to scope matrix.
4.	Calculate evaluated cost including risk, interface, management and programme impacts.
5.	Preserve raw return and adjustment bridge; no overwriting supplier value.
6.	Select route provisionally for master pricing, subject to adjudication.
AI-agent duties and human guardrails
•	Extract and normalise return lines; flag outliers and missing scope.
•	Suggest clarification and evaluated-risk allowance with explainable basis.
Outputs
•	SupplierReturn
•	SelfPerformEstimate
•	NormalisationAdjustments
•	EvaluatedCost
•	ProvisionalRouteSelection
Exception controls
•	Currency conversion and tax treatment must be explicit.
•	Non-comparable returns remain flagged; ranking is suppressed if material data is missing.
•	Related-party/conflict declaration is mandatory where configured.
Events: TENDER_RETURN_RECEIVED | RETURN_NORMALISED | SELF_PERFORM_PRICED | PRICING_ROUTE_SELECTED
APIs:   POST /v1/tender-packages/{id}/returns | POST /v1/tender-returns/{id}:normalise | POST /v1/tender-packages/{id}:select-pricing-route
Acceptance criteria
•	AC-T-WF-05-01: Raw, normalised and evaluated values reconcile through visible adjustments.
•	AC-T-WF-05-02: Each exclusion maps to a priced allowance, clarification or accepted project exclusion.
•	AC-T-WF-05-03: Selected route shows cost, risk, programme and capacity basis.
```

## T-WF-06

```
T-WF-06 - Clarifications, addenda and tender return intelligence
Primary owner: Bid Manager / Procurement Manager  |  Trigger: Question, addendum or return received
Required inputs
•	Question/response/addendum and source
•	affected package, scope item, clause, drawing and price
•	bidder return files and structured response
•	confidentiality classification
•	response deadline and approval
Deterministic flow
1.	Number and classify clarification as internal, client-side or bidder-side.
2.	Link question and response to exact controlled information and impacted records.
3.	Issue approved response consistently to entitled recipients and preserve read evidence.
4.	On addendum, calculate impact on compliance, quantity, estimate, supplier returns and programme.
5.	Normalise returns, detect variances/outliers/missing scope and generate bidder-specific questions.
6.	Reconcile clarification responses and update comparison without changing raw return.
AI-agent duties and human guardrails
•	Draft neutral clarification, compare returns and identify concealed qualifications.
•	Recommend questions and completeness confidence; human controls issue and commercial interpretation.
Outputs
•	Clarification Register
•	AddendumImpact Report
•	TenderComparison
•	Variance/Outlier Register
•	Recommended Question Set
Exception controls
•	Commercially confidential bidder data cannot leak across bidders.
•	Late addendum may trigger deadline review and decision record.
•	Unresolved material variance carries priced risk to adjudication.
Events: CLARIFICATION_RAISED | CLARIFICATION_ISSUED | ADDENDUM_RECEIVED | ADDENDUM_IMPACT_ASSESSED | RETURN_COMPARISON_UPDATED
APIs:   POST /v1/tenders/{id}/clarifications | POST /v1/tenders/{id}/addenda | POST /v1/tender-packages/{id}:compare-returns
Acceptance criteria
•	AC-T-WF-06-01: Every adjustment in comparison links to raw return or clarification.
•	AC-T-WF-06-02: Recipients and issue times are auditable.
•	AC-T-WF-06-03: Comparison completeness/confidence falls when material queries remain open.
```

## T-WF-07

```
T-WF-07 - Commercial adjudication, bid programme and governance
Primary owner: Commercial Director / Bid Director  |  Trigger: Master pricing and qualitative responses ready
Required inputs
•	Estimate, supplier comparisons and route selections
•	preliminaries, risk, contingency, inflation and OH&P
•	bid programme, methods, resources and procurement schedule
•	contract risks, qualifications, exclusions and clarifications
•	authority limits and adjudication agenda
Deterministic flow
1.	Freeze pre-adjudication snapshot.
2.	Reconcile cost to scope and benchmark; review abnormal rates, coverage and risk.
3.	Review programme logic, resources, lead times and contractual milestones.
4.	Set allowances, margin and qualifications with reason/owner.
5.	Record action decisions, changes and post-adjudication snapshot.
6.	Route to technical, commercial and executive approvals under delegated authority.
AI-agent duties and human guardrails
•	Identify margin exposure, scope leakage and programme inconsistency.
•	Draft executive risk summary; cannot set margin, contingency or final price.
Outputs
•	AdjudicationRecord
•	PostAdjudicationEstimate
•	ApprovedBidProgramme
•	Qualifications/Exclusions Register
•	ApprovalPack
Exception controls
•	Every manual adjustment requires reason and evidence.
•	Approver cannot approve above personal limit or where conflict policy blocks.
•	Programme and price must use the same scope/addendum cut-off.
Events: ADJUDICATION_STARTED | PRICE_ADJUSTMENT_RECORDED | BID_PROGRAMME_APPROVED | ADJUDICATION_APPROVED
APIs:   POST /v1/tenders/{id}/adjudications | POST /v1/adjudications/{id}/adjustments | POST /v1/adjudications/{id}:approve
Acceptance criteria
•	AC-T-WF-07-01: Pre/post snapshots and adjustment bridge reconcile exactly.
•	AC-T-WF-07-02: All actions are closed or explicitly carried as submission conditions.
•	AC-T-WF-07-03: Final price, programme, risk and qualifications share one cut-off timestamp.
```

## T-WF-08

```
T-WF-08 - Submission, award and zero-re-entry conversion
Primary owner: Bid Director / Commercial Director  |  Trigger: All required approvals obtained
Required inputs
•	Approved price and programme
•	completed compliance matrix and qualitative documents
•	qualifications/exclusions/clarifications
•	submission instructions and authorised signatory
•	client receipt/award communication
Deterministic flow
1.	Compile ordered submission pack and run deterministic completeness/file-name/size/signature checks.
2.	Lock pack with hash and exact source versions.
3.	Submit via configured channel; capture receipt, portal ID and evidence.
4.	Record post-tender clarifications/revisions as separate controlled cycles.
5.	On award, compare award terms to submission and raise departures.
6.	Create main contract baseline, budget, package buyout targets, procurement records and mobilisation tasks from accepted data IDs.
AI-agent duties and human guardrails
•	Draft submission narrative and award-delta report.
•	No autonomous signature, submission, acceptance or contract execution.
Outputs
•	ImmutableSubmissionPack
•	SubmissionReceipt
•	AwardDelta Report
•	Contract/Budget/Procurement Initialisation
•	TenderLessons Record
Exception controls
•	Any post-approval content change invalidates prior approval and requires re-approval according to materiality.
•	Award departure blocks contract execution until resolved/accepted.
•	Unsuccessful bid preserves market/lessons data subject to retention policy.
Events: TENDER_SUBMISSION_LOCKED | TENDER_SUBMITTED | AWARD_RECEIVED | AWARD_DEPARTURE_IDENTIFIED | BID_CONVERTED_TO_CONTRACT
APIs:   POST /v1/tenders/{id}:compile-submission | POST /v1/tenders/{id}:record-submission | POST /v1/tenders/{id}:convert-award
Acceptance criteria
•	AC-T-WF-08-01: Submission receipt identifies exact immutable pack hash.
•	AC-T-WF-08-02: Contract sum, budget and buyout targets reconcile to awarded submission without re-entry.
•	AC-T-WF-08-03: Award departures are visible before contract execution.
```

## 8.4

```
8.4 Stage gate Definition of Done
•	All mandatory inputs are present, validated and tied to exact source versions; completeness is 100% and blocking issues equal zero.
•	All approvals satisfy appointment, authority, maker-checker and party-separation policies.
•	All critical/major safety, compliance, interface and information blockers are closed or governed by a permitted, time-bound condition.
•	Cost, programme, risk, information and commercial snapshots share one declared cut-off and are cross-reconciled.
•	AI outputs used in the decision have evidence, confidence, assumptions, model/prompt versions, ACU settlement and human disposition.
•	Gate report, decision and locked baseline can be replayed from the event store and verified against evidence hashes.
•	Downstream mobilisation tasks, owners, due dates and inherited residual obligations are automatically created without re-entry.
```

---

## 9 — Construction stage control

A different kind of specification from the twenty-four above: not a workflow but
the **stage control** — the conditions a stage is entered and left under, the
event that records leaving it, and the state path its records follow. Received
after sections 6 to 8 and recorded here for the same reason as the rest.

```
9. Construction stage
Stage outcome: Control safe, compliant and profitable delivery from mobilisation through physical completion using field evidence as the live source of truth.
Control	Requirement
Entry condition	Executed contract/authorised notice to proceed, approved baseline, mobilisation controls and construction information available.
Exit condition	Works physically complete by system/area, records reconciled, commissioning turnover released and all residual obligations controlled.
Gate event	CONSTRUCTION_COMPLETION_ACCEPTED
Default state path	Draft → Validated → Submitted → Under Review → Approved / Approved with Conditions / Rejected → Locked / Superseded
```

```
9.1 Mandatory input groups
Input group	Required construction data
Baseline	Executed contract, scope, budget/CBS, WBS/programme/calendar, procurement schedule, design information and authority
Mobilisation	Construction phase plan, logistics, welfare, permits, temporary works, surveys, quality plan/ITPs, RAMS, competence and site controls
Daily execution	Shift/weather, labour, plant, materials, deliveries, WBS quantities, locations, photos/video, constraints, delay, instructions and diary narrative
Quality	ITPs, inspection/test requests, checklists, hold/witness points, test readings, NCRs, defects, corrective actions and as-built evidence
Safety	RAMS, permits, toolbox talks, observations, incidents, isolations, competence, inspections and action closure
Commercial/contracts	Instructions, variations, notices, applications, certificates, commitments, invoices, accruals, CVR, claims and evidence
Information/procurement	Current drawings/models/specifications, RFIs, submittals, samples, manufacturing status, delivery notes and material traceability

9.2 Stage workspace
•	Route: /projects/{projectId}/construction. The page opens on a stage-specific Action Queue, not a static summary.
•	Header: gate state, completeness, blockers/warnings, approved baseline version, change since baseline, accountable owner, last data cut-off and permitted next command.
•	Tabs: Overview; Inputs; Workflows; Deliverables; Decisions & Approvals; Risks & Changes; Evidence; AI Runs; History.
•	Right rail: assigned decisions, overdue items, low-confidence extractions, stale evidence and downstream impacts.
Gate button remains disabled until all deterministic blockers pass; permitted warning waivers display approver, reason and
```

*(9.2's last line arrived truncated in the source message; the sentence continues
beyond "display approver, reason and". Recorded as received rather than guessed
at.)*

*(The truncated 9.2 line completes: "…permitted warning waivers display approver,
reason and expiry.")*

## 9.3

## CN-WF-01

```
CN-WF-01 - Mobilisation and start-work readiness
Primary owner: Project / Construction Manager  |  Trigger: Award conversion or notice to proceed
Required inputs
•	Executed contract/authorisation and possession/access dates
•	approved programme/budget and construction information
•	construction phase plan, logistics, welfare and emergency arrangements
•	insurances, bonds, permits, appointments and competence
•	package-specific RAMS, ITP, temporary works and procurement readiness
Deterministic flow
1.	Create mobilisation checklist by project, site, zone and package.
2.	Verify contractual preconditions, access, design, permits, welfare, surveys, resources and controls.
3.	Create unresolved constraints with owner, need date and impact.
4.	Hold readiness review; approve Ready, Ready with Conditions or Not Ready per package/area.
5.	Issue start authority only to defined scope/location and linked information revisions.
6.	Carry mobilisation evidence into the daily control and audit timeline.
AI-agent duties and human guardrails
•	Summarise missing prerequisites and likely start impact.
•	Cannot authorise work, declare competence or waive safety/statutory control.
Outputs
•	MobilisationPlan
•	ReadinessChecklist
•	StartWork Authorisation
•	Constraint Register
•	Mobilisation EvidencePack
Exception controls
•	No work authorisation where critical RAMS/permit/design/temporary works/competence prerequisite fails.
•	Conditional readiness has expiry and named conditions.
•	Changed information automatically rechecks affected start authority.
Events: MOBILISATION_STARTED | READINESS_CHECK_COMPLETED | START_WORK_AUTHORISED | WORK_NOT_READY
APIs:   POST /v1/projects/{id}/mobilisation-plans | POST /v1/work-packages/{id}:readiness-check | POST /v1/work-packages/{id}:authorise-start
Acceptance criteria
•	AC-CN-WF-01-01: Every package start shows approved information, RAMS, ITP, resource and access status.
•	AC-CN-WF-01-02: Not Ready prevents task movement to In Progress.
•	AC-CN-WF-01-03: Authority identifies scope, location, time window and approver.
```

## CN-WF-02

```
CN-WF-02 - Baseline, lookahead, task and constraint control
Primary owner: Planner + Construction Manager  |  Trigger: Construction baseline approved or weekly planning cycle
Required inputs
•	Contract/approved baseline and current forecast
•	WBS, calendars, logic, quantities and resource plan
•	design, procurement, access, permit and predecessor constraints
•	actual progress and productivity
•	subcontractor short-term plans
Deterministic flow
1.	Import/create logic-linked baseline and run open-end, constraint, calendar and critical-path validation.
2.	Create rolling six-week lookahead and weekly work plan from current forecast.
3.	Run make-ready screening: information, material, labour, plant, access, permit, predecessor and inspection.
4.	Assign constraints and commitments with need-by/owner; track aging and reliability.
5.	Freeze weekly plan; daily updates record Complete, In Progress, Blocked or Not Started with reason.
6.	Calculate plan-percent-complete, variance and forecast impact; propose recovery options.
AI-agent duties and human guardrails
•	Detect logic/float/resource anomalies and forecast constraint impact.
•	Generate scenario options; planner validates logic and authorises forecast/baseline submissions.
Outputs
•	ApprovedBaseline
•	CurrentForecast
•	SixWeekLookahead
•	WeeklyWorkPlan
•	Constraint/Commitment Register
•	RecoveryScenarios
Exception controls
•	Baseline change requires separate change request and approval; forecast does not overwrite baseline.
•	Out-of-sequence progress follows configured retained-logic/progress-override decision record.
•	Tasks cannot be marked Complete without required verification evidence.
Events: BASELINE_APPROVED | LOOKAHEAD_CREATED | CONSTRAINT_ADDED | WEEKLY_PLAN_FROZEN | PROGRESS_STATUS_UPDATED
APIs:   POST /v1/projects/{id}/programme-baselines | POST /v1/projects/{id}/lookaheads | POST /v1/tasks/{id}/constraints
Acceptance criteria
•	AC-CN-WF-02-01: Critical path and float calculation are reproducible from stored calendar/logic/version.
•	AC-CN-WF-02-02: Each blocked task has reason, owner, impact and next action.
•	AC-CN-WF-02-03: Baseline, current forecast and what-if scenarios are visually distinct.
```

## CN-WF-03

```
CN-WF-03 - Offline daily diary and voice field capture
Primary owner: Site Manager / Supervisor  |  Trigger: Shift start/during shift/shift close
Required inputs
•	Date, shift, supervisor and weather
•	WBS activity, package, location/zone and workface
•	labour role/count/hours; plant ID/hours/idle/fuel
•	materials/deliveries/quantities/delivery-note evidence
•	progress quantities, issues, delays, instructions, visitors, safety/quality events and photos
Deterministic flow
1.	Create local draft with device ID, local timestamp and stable client-generated UUID.
2.	Capture voice in segments; transcribe and map statements to structured sections while retaining audio.
3.	Attach photos with capture time, author, location and device metadata; user confirms tags.
4.	Validate mandatory WBS/location/unit and anomalous totals before submission.
5.	Supervisor reviews and submits once; edits after submission create amendment version with reason.
6.	Sync queue uploads metadata then attachments; server applies idempotency and conflict rules.
AI-agent duties and human guardrails
•	Clean dictation, categorise events and suggest linked tasks/packages.
•	Detect potential delay/change/safety/quality candidates but does not issue formal records automatically.
Outputs
•	DailyLog Revision
•	Labour/Plant/Material Records
•	ProgressCandidates
•	Issue Candidates
•	EvidenceItems
Exception controls
•	No network does not block capture.
•	Conflicting concurrent edits preserve both versions and require resolution for material fields.
•	Device time variance is stored; server receipt time never replaces original capture time.
Events: DAILY_LOG_DRAFTED | DAILY_LOG_SUBMITTED | OFFLINE_SYNC_COMPLETED | DAILY_LOG_AMENDED
APIs:   POST /v1/projects/{id}/daily-logs | POST /v1/sync/batches | POST /v1/daily-logs/{id}:amend
Acceptance criteria
•	AC-CN-WF-03-01: Airplane-mode capture survives app restart and later syncs exactly once.
•	AC-CN-WF-03-02: Submitted log has author, shift, WBS, location and immutable evidence references.
•	AC-CN-WF-03-03: Amendment displays before/after and reason without destroying original.
```

## CN-WF-04

```
CN-WF-04 - Progress measurement, verification and productivity
Primary owner: Site Manager → Planner / QS verifier  |  Trigger: Daily/weekly progress submission or reality capture
Required inputs
•	Baseline activity quantity and measurement rule
•	reported installed quantity/location/date
•	photo/video/scan/survey/test evidence
•	labour/plant hours and conditions
•	prior cumulative progress and rework
Deterministic flow
1.	Create progress claim against WBS activity, cost code and location.
2.	Validate unit, cumulative ceiling, duplicate time/location and required evidence.
3.	Compare field claim with prior records, imagery/model/survey where available.
4.	Authorised verifier Accepts, Adjusts with reason, or Rejects; preserve submitted value.
5.	Update actual start/finish, remaining duration, productivity and earned value using accepted data.
6.	Forecast downstream milestones and create variance/underperformance actions.
AI-agent duties and human guardrails
•	Estimate visual progress and detect anomalies as a comparison signal.
•	Explain productivity variance using evidence; never certify payment or progress alone.
Outputs
•	ProgressSubmission
•	VerifiedProgress
•	ProductivitySnapshot
•	Programme/EVM Update
•	VarianceAction
Exception controls
•	Cumulative quantity above control total blocks acceptance until scope/change is resolved.
•	Rework is recorded separately and must not inflate earned progress.
•	Adjusted value requires verifier rationale and evidence.
Events: PROGRESS_REPORTED | PROGRESS_VERIFIED | PROGRESS_ADJUSTED | PRODUCTIVITY_ANALYSED | FORECAST_UPDATED
APIs:   POST /v1/tasks/{id}/progress | POST /v1/progress/{id}:verify | GET /v1/projects/{id}/productivity
Acceptance criteria
•	AC-CN-WF-04-01: Submitted and accepted quantities remain separately auditable.
•	AC-CN-WF-04-02: Programme, earned value and valuation reference the same accepted progress version.
•	AC-CN-WF-04-03: Duplicate imagery/reporting does not double-count progress.
```

## CN-WF-05

```
CN-WF-05 - Resource, material, delivery and procurement control
Primary owner: Construction Manager / Procurement Manager  |  Trigger: Lookahead demand, order event or site delivery
Required inputs
•	Planned resource curve and activity demand
•	labour/plant allocation and competence/inspection status
•	purchase order/subcontract, manufacturing and logistics milestones
•	delivery booking, delivery note, quantity, batch/heat/serial and condition
•	required-on-site date, storage and preservation requirements
Deterministic flow
1.	Time-phase demand from programme and compare with committed supply.
2.	Track requisition → RFQ → order → design approval → manufacture → FAT → shipment → customs → delivery → acceptance.
3.	Book delivery against site access and lifting/storage capacity.
4.	On arrival, reconcile order/dispatch/delivery quantities and inspect condition/documentation.
5.	Quarantine rejected or unverified material; create shortage/damage/nonconformance records.
6.	Update inventory, activity readiness, commitments, accrual and forecast impact.
AI-agent duties and human guardrails
•	Forecast shortages/late delivery and suggest expediting or resequencing.
•	Extract delivery/serial data with human confirmation for safety-critical items.
Outputs
•	Demand/Supply Plan
•	ProcurementStatus
•	DeliveryRecord
•	MaterialTraceability Record
•	Inventory/Accrual Update
Exception controls
•	Safety-critical product without certificate/traceability remains quarantined.
•	Partial/over/short delivery creates explicit reconciliation exception.
•	Substitution routes through technical submittal/change control.
Events: RESOURCE_DEMAND_UPDATED | ORDER_PLACED | MANUFACTURING_MILESTONE_UPDATED | DELIVERY_RECEIVED | MATERIAL_QUARANTINED
APIs:   POST /v1/projects/{id}/procurement-items | POST /v1/deliveries | POST /v1/deliveries/{id}:accept
Acceptance criteria
•	AC-CN-WF-05-01: Long-lead status traces from programme need date to order/manufacture/logistics evidence.
•	AC-CN-WF-05-02: Accepted quantity updates inventory once and financial accrual consistently.
•	AC-CN-WF-05-03: Material/asset serials can be traced to installed location and test evidence.
```

## CN-WF-06

```
CN-WF-06 - Quality planning, inspection, testing, NCR and defect control
Primary owner: Quality Manager / Site Manager  |  Trigger: Work package mobilisation, inspection point or nonconformance
Required inputs
•	Quality plan and ITP revision
•	specification/drawing acceptance criteria
•	inspection lot/location and preceding work
•	hold/witness/review point and notification period
•	checklist, readings, calibration, photos and signatures
Deterministic flow
1.	Create ITP from scope with inspection/test points, parties and evidence requirements.
2.	Request inspection only when prerequisites and current information are confirmed.
3.	Record Pass, Fail, Observation or Not Applicable per item with evidence and signatory.
4.	Hold point prevents successor release until authorised acceptance.
5.	Failed item creates NCR/defect with containment, root cause, corrective/preventive action and disposition.
6.	Verify repair/rework/use-as-is/reject decision, retest and closure; feed handover readiness.
AI-agent duties and human guardrails
•	Draft ITP/checklist from specification and detect recurring defects.
•	Flag visual anomalies; qualified inspector controls result and disposition.
Outputs
•	ITP
•	Inspection/Test Record
•	HoldPoint Release
•	NCR/Defect
•	CorrectiveAction
•	QualityTrend
Exception controls
•	Use-as-is requires designated technical/commercial authority.
•	Calibration expiry invalidates affected measurement until reviewed.
•	Closed defect can reopen if verification evidence is withdrawn/superseded.
Events: ITP_APPROVED | INSPECTION_REQUESTED | HOLD_POINT_RELEASED | NCR_RAISED | NCR_CLOSED
APIs:   POST /v1/work-packages/{id}/itps | POST /v1/inspections | POST /v1/ncrs/{id}:close
Acceptance criteria
•	AC-CN-WF-06-01: Inspection links exact acceptance criteria and current information revision.
•	AC-CN-WF-06-02: Hold-point successor activity cannot start without release.
•	AC-CN-WF-06-03: NCR closure contains disposition approval and verified corrective evidence.
```

## CN-WF-07

```
CN-WF-07 - RAMS, permit, toolbox, observation and incident control
Primary owner: HSE Manager / Site Manager  |  Trigger: High-risk activity planning, shift start, observation or incident
Required inputs
•	Activity/method sequence and location
•	hazards, inherent/residual scoring and controls
•	PPE/plant/tools/materials/access/temporary works
•	competence, supervision, emergency/rescue and permits/isolations
•	programme date, workforce and approved design information
Deterministic flow
1.	Generate/revise RAMS through activity → steps → hazards → controls → resources → emergency → review.
2.	Obtain competent review/approval and issue controlled version to workface.
3.	Verify workforce briefing/acknowledgement, competence and permits before start.
4.	Record observations and actions; stop/escalate unsafe work through authorised process.
5.	For incident, secure immediate facts/evidence, classify, notify, investigate causes and actions.
6.	Supersede RAMS when method/design/conditions change and rebrief affected workforce.
AI-agent duties and human guardrails
•	Suggest hazards/controls from project and approved knowledge sources; never set acceptability.
•	Structure voice observations and detect trends; human confirms classification and reportability.
Outputs
•	RAMS Revision
•	Permit/Isolation Record
•	Toolbox/Acknowledgement
•	Observation/Action
•	Incident/Investigation Report
Exception controls
•	Expired/superseded RAMS or competence blocks start.
•	Permit extension/handback follows defined authorised states.
•	Potentially reportable incident routes to compliance lead; system does not make legal determination alone.
Events: RAMS_APPROVED | WORKFORCE_BRIEFED | PERMIT_ISSUED | SAFETY_OBSERVATION_RECORDED | INCIDENT_RECORDED
APIs:   POST /v1/projects/{id}/rams | POST /v1/permits/{id}:issue | POST /v1/projects/{id}/incidents
Acceptance criteria
•	AC-CN-WF-07-01: Start readiness sees current RAMS, competence, permit and briefing status.
•	AC-CN-WF-07-02: Every control/action has owner and verification evidence.
•	AC-CN-WF-07-03: Incident evidence is access-controlled, immutable and chronologically ordered.
```

## CN-WF-08

```
CN-WF-08 - Construction information, RFI, submittal and instruction control
Primary owner: Information Manager / Project Manager  |  Trigger: Information issue, ambiguity, product proposal or instruction
Required inputs
•	Drawing/model/specification revision and work package
•	RFI/submittal/markup/instruction content
•	contract clause and response calendar
•	required-by activity/date and affected location
•	response, approval and distribution parties
Deterministic flow
1.	Publish current information through controlled transmittal and notify affected workfaces.
2.	Detect superseded information access and require acknowledgement of replacement.
3.	Raise RFI/submittal from markup/voice with source and programme impact.
4.	Route, chase and record controlled response/decision.
5.	Issue instruction only by authorised role using sequential numbering and clause template.
6.	Create variation/change and programme impact candidates; verify site implementation.
AI-agent duties and human guardrails
•	Draft RFI/instruction text and find source clauses/drawings.
•	Detect likely change/delay but cannot issue contractual communication.
Outputs
•	Transmittal
•	RFI/Submittal
•	Instruction
•	AffectedParty Notifications
•	Change/Delay Candidates
Exception controls
•	Verbal direction is logged as Unconfirmed Direction and chased for formal confirmation.
•	Unauthorised response cannot alter controlled design.
•	Working to superseded information creates quality/change investigation.
Events: INFORMATION_PUBLISHED | RFI_RAISED | SUBMITTAL_DECIDED | INSTRUCTION_ISSUED | UNCONFIRMED_DIRECTION_RECORDED
APIs:   POST /v1/transmittals | POST /v1/projects/{id}/rfis | POST /v1/contracts/{id}/instructions
Acceptance criteria
•	AC-CN-WF-08-01: Site user can identify current applicable revision in two taps.
•	AC-CN-WF-08-02: RFI required-by and due dates are separate and traceable.
•	AC-CN-WF-08-03: Instruction shows authority, clause, recipients, issue evidence and implementation status.
```

## CN-WF-09

```
CN-WF-09 - Change, variation, notice, delay and claim evidence
Primary owner: Commercial Manager / Project Manager  |  Trigger: Instruction, condition, revision, delay, disruption or cost event
Required inputs
•	Originating event/evidence and contract clause
•	cause-event-effect and dates
•	affected scope/packages/activities/resources
•	notice requirement/deadline and recipient
•	cost/time/quality/safety/procurement impacts and mitigation
Deterministic flow
1.	Create a single change event with linked upstream and downstream records.
2.	Determine notice/early-warning/compensation-event/variation route from versioned contract rules and validated clause extraction.
3.	Issue authorised notice and preserve delivery/acknowledgement.
4.	Build contemporaneous chronology from diaries, programme, information, labour/plant, photos and correspondence.
5.	Assess quotation/valuation and time impact using approved method; maintain submitted/assessed/agreed values separately.
6.	Update CVR, programme and risk; close only after instruction, value/time and downstream liability are reconciled.
AI-agent duties and human guardrails
•	Detect candidate events, draft notices and map evidence/chronology.
•	Legal entitlement, causation and submission remain human-approved with clause citations.
Outputs
•	ChangeEvent
•	ContractNotice
•	Variation/Compensation Event
•	DelayEvent
•	EvidencePack
•	CVR/Programme Updates
Exception controls
•	Deadline alert escalates before expiry using project business calendar.
•	Uninstructed work and verbal direction remain visible exposure.
•	Downstream cost without upstream recovery is flagged; records are linked but not assumed equal.
Events: CHANGE_EVENT_CREATED | NOTICE_ISSUED | VARIATION_VALUED | DELAY_EVENT_RECORDED | CLAIM_EVIDENCE_PACK_BUILT
APIs:   POST /v1/projects/{id}/change-events | POST /v1/contracts/{id}/notices | POST /v1/claims/{id}:build-evidence-pack
Acceptance criteria
•	AC-CN-WF-09-01: Each notice deadline shows rule source, calculation inputs and human validation status.
•	AC-CN-WF-09-02: Raw records cannot be edited through claim workspace.
•	AC-CN-WF-09-03: Submitted, assessed, certified, agreed and paid values remain separate.
```

## CN-WF-10

```
CN-WF-10 - Applications, payments, commitments, ledger and live CVR
Primary owner: Commercial Director / QS  |  Trigger: Payment cycle or commercial update
Required inputs
•	Contract sum/budget and approved baseline
•	progress, variations, claims, retention and previous certificates
•	subcontract applications, commitments, invoices, accruals and actual costs
•	contract-specific due/notice/final dates and project business calendar
•	forecast final value/cost and remaining risk
Deterministic flow
1.	Generate upstream/downstream payment calendars from validated contract rule pack.
2.	Build valuation from verified progress and controlled commercial records.
3.	Route application/certificate/payment/pay-less or equivalent notices under authority and deadline controls.
4.	Reconcile certificate, invoice, payment and ledger; queue unmatched exceptions.
5.	Update live CVR by cost code/package with value, cost, commitment, accrual and forecast.
6.	Explain margin/cash movement and approve forecast snapshot.
AI-agent duties and human guardrails
•	Detect anomalies, under/overclaim, missing notice and forecast pressure.
•	Cannot submit/certify payment, set forecast or interpret law without approval.
Outputs
•	PaymentCycle
•	Application/Certificate Pack
•	LedgerReconciliation
•	CVR Snapshot
•	CashflowForecast
•	CommercialExceptions
Exception controls
•	Jurisdiction/contract rules are effective-dated and validated; no universal hard-coded calendar.
•	Trial/free ACUs do not appear as billable project cost.
•	Unmatched invoice/certificate never silently posts to CVR.
Events: PAYMENT_CYCLE_GENERATED | APPLICATION_SUBMITTED | CERTIFICATE_RECORDED | PAYMENT_RECONCILED | CVR_SNAPSHOT_APPROVED
APIs:   POST /v1/contracts/{id}/payment-cycles:generate | POST /v1/applications/{id}:submit | POST /v1/projects/{id}/cvr-snapshots
Acceptance criteria
•	AC-CN-WF-10-01: Every amount reconciles from source through value/cost/ledger/CVR.
•	AC-CN-WF-10-02: Deadline calculation displays contract clause, calendar and manual validation.
•	AC-CN-WF-10-03: Forecast change above threshold requires reason and approval.
```

## CN-WF-11

```
CN-WF-11 - Meeting, action, communication and decision control
Primary owner: Project Manager  |  Trigger: Meeting, voice note, correspondence or decision need
Required inputs
•	Meeting type/date/attendees/agenda
•	recording/notes and source documents
•	decisions, actions, owners and dates
•	RFI/change/risk/programme/package references
•	distribution and confidentiality
Deterministic flow
1.	Create meeting record and attendance; obtain recording consent where applicable.
2.	Transcribe/summarise into decisions, actions, issues and candidate formal communications.
3.	Human chair reviews, edits and approves minutes.
4.	Issue controlled minutes and capture comments/acceptance according to project protocol.
5.	Sync actions into role dashboards and linked registers.
6.	Convert material decisions into DecisionRecord and required instruction/change/notice.
AI-agent duties and human guardrails
•	Structure transcript, identify actions and contradictions.
•	Cannot turn discussion into contractual instruction or accepted decision without chair/authority.
Outputs
•	MeetingMinutes
•	Action Register
•	DecisionRecords
•	Communication Drafts
•	IssueEvidence
Exception controls
•	Disputed minutes preserve issuer and respondent versions.
•	Sensitive/legal discussion receives restricted ABAC classification.
•	Overdue action escalation respects role hierarchy.
Events: MEETING_RECORDED | MINUTES_APPROVED | MINUTES_ISSUED | ACTION_ASSIGNED | DECISION_RECORDED
APIs:   POST /v1/projects/{id}/meetings | POST /v1/meetings/{id}:approve-minutes | POST /v1/actions/{id}:complete
Acceptance criteria
•	AC-CN-WF-11-01: Action appears once across meeting, register and dashboard by stable ID.
•	AC-CN-WF-11-02: Issued minutes preserve exact approved version.
•	AC-CN-WF-11-03: Material decision has authority, rationale, alternatives and impacts.
```

## CN-WF-12

```
CN-WF-12 - Reporting, recovery, physical completion and turnover
Primary owner: Project / Construction Manager  |  Trigger: Daily/weekly/monthly cycle or package/system completion
Required inputs
•	Verified progress, forecast, cost/CVR, risks, safety/quality and procurement
•	design/RFI/change/claim status
•	commissioning turnover requirements
•	completion evidence, defects and as-built updates
•	reporting cut-off and audience template
Deterministic flow
1.	Create cut-off snapshot across all modules; disclose data freshness and missing owners.
2.	Generate role/audience report with changes since prior cut-off and decision requests.
3.	Run recovery scenarios with logic/resource/cost/risk effects; approve selected action plan.
4.	For package/system completion, verify work, tests, quality records, as-built and residual defects.
5.	Issue mechanical/construction completion certificate only by authorised party.
6.	Transfer system boundary and evidence to Commissioning while retaining construction obligations.
AI-agent duties and human guardrails
•	Draft evidence-grounded report and recovery options.
•	Forecast completion/readiness with confidence; cannot declare completion or select recovery.
Outputs
•	PeriodReport
•	RecoveryPlan
•	CompletionChecklist
•	Construction/Mechanical Completion Record
•	CommissioningTurnover Pack
Exception controls
•	Report does not hide stale/missing data.
•	Partial/system turnover requires defined boundary, isolations and retained responsibilities.
•	Defect acceptance/deferment requires classification, owner and completion condition.
Events: REPORT_SNAPSHOT_CREATED | RECOVERY_PLAN_APPROVED | SYSTEM_READY_FOR_TURNOVER | CONSTRUCTION_COMPLETION_ACCEPTED
APIs:   POST /v1/projects/{id}/reports:generate | POST /v1/programmes/{id}/recovery-scenarios | POST /v1/systems/{id}:construction-complete
Acceptance criteria
•	AC-CN-WF-12-01: Report numbers reconcile to source snapshots at cut-off.
•	AC-CN-WF-12-02: Turnover pack completeness is rule-driven and evidence-linked.
•	AC-CN-WF-12-03: Commissioning cannot start on a system without approved boundary/readiness or recorded authorised exception.
```

## 9.4

```
9.4 Stage gate Definition of Done
•	All mandatory inputs are present, validated and tied to exact source versions; completeness is 100% and blocking issues equal zero.
•	All approvals satisfy appointment, authority, maker-checker and party-separation policies.
•	All critical/major safety, compliance, interface and information blockers are closed or governed by a permitted, time-bound condition.
•	Cost, programme, risk, information and commercial snapshots share one declared cut-off and are cross-reconciled.
•	AI outputs used in the decision have evidence, confidence, assumptions, model/prompt versions, ACU settlement and human disposition.
•	Gate report, decision and locked baseline can be replayed from the event store and verified against evidence hashes.
•	Downstream mobilisation tasks, owners, due dates and inherited residual obligations are automatically created without re-entry.
```

*(Word for word identical to 6.4, 7.4 and 8.4. What differs between the four is
the evidence each is answered from, not the standard — which is why
`backend/src/domain/stagegate.ts` shares the clause list, the titles, the
`NOT_ASSESSABLE` rule, the AI clause, the replay clause and the report
arithmetic across all of them.)*

---

## 10 — Commissioning stage control

```
10. Commissioning stage
Stage outcome: Prove by controlled testing that systems are complete, safe, integrated and capable of meeting the approved design and operational intent.
Control	Requirement
Entry condition	Commissioning strategy and programme approved; system boundaries defined; relevant construction completion accepted.
Exit condition	Systems accepted or conditionally accepted with controlled exceptions, operator training complete and handover evidence ready.
Gate event	COMMISSIONING_COMPLETE
Default state path	Draft → Validated → Submitted → Under Review → Approved / Approved with Conditions / Rejected → Locked / Superseded
```

```
10.1 Mandatory input groups
Input group	Required construction data
Systemisation	Asset/system/subsystem hierarchy, boundaries, tags, locations, energisation and turnover sequence
Plans and procedures	Commissioning plan/programme, method statements, test scripts, cause/effect, acceptance criteria, witness/hold points
Readiness	Construction completion, punch status, clean/flush, utilities, isolations, permits, vendor attendance, instruments/calibration
Testing	FAT/SAT, pre-functional, functional, integrated system, reliability/soak/continuous performance and seasonal test data
Evidence	Raw readings, photos/video, trend logs, certificates, signatures, exceptions, retests and approvals
Operations	O&M drafts, asset data, spares, maintenance tasks, operator training and emergency response
```

```
10.2 Stage workspace
•	Route: /projects/{projectId}/commissioning. The page opens on a stage-specific Action Queue, not a static summary.
•	Header: gate state, completeness, blockers/warnings, approved baseline version, change since baseline, accountable owner, last data cut-off and permitted next command.
•	Tabs: Overview; Inputs; Workflows; Deliverables; Decisions & Approvals; Risks & Changes; Evidence; AI Runs; History.
•	Right rail: assigned decisions, overdue items, low-confidence extractions, stale evidence and downstream impacts.
•	Gate button remains disabled until all deterministic blockers pass; permitted warning waivers display approver, reason and expiry.
```

## 10.3

## CM-WF-01

```
CM-WF-01 - Systemisation and commissioning plan
Primary owner: Commissioning Manager  |  Trigger: Design maturity or construction mobilisation milestone
Required inputs
•	Design system schematics/models and asset hierarchy
•	contract and employer commissioning requirements
•	construction and handover milestones
•	system dependencies, utilities, energisation and operational interfaces
•	witness authorities and acceptance roles
Deterministic flow
1.	Define facility → system → subsystem → equipment boundaries with stable IDs and tags.
2.	Map construction completion, pre-commissioning, commissioning, integrated testing, training and handover milestones.
3.	Assign commissioning lead, contractor, vendor, witness and accepting authority per test level.
4.	Create deliverable/test pack matrix and notification periods.
5.	Link dependencies, temporary services, energisation/isolations and permit controls.
6.	Approve baseline commissioning plan and update under version control.
AI-agent duties and human guardrails
•	Suggest system hierarchy and missing tests from specifications/schematics.
•	Detect sequence and witness conflicts; competent Commissioning Manager approves.
Outputs
•	SystemHierarchy
•	CommissioningPlan
•	CommissioningProgramme
•	Responsibility/Witness Matrix
•	TestPack Matrix
Exception controls
•	Boundary overlap/gap blocks plan approval.
•	Change to systemisation requires impact to tests, assets and handover records.
•	Temporary operation is a separate controlled state, not implicit commissioning.
Events: SYSTEM_HIERARCHY_APPROVED | COMMISSIONING_PLAN_APPROVED | TEST_PACK_REQUIRED | COMMISSIONING_BASELINE_UPDATED
APIs:   POST /v1/projects/{id}/systems | POST /v1/projects/{id}/commissioning-plans | POST /v1/commissioning-plans/{id}:approve
Acceptance criteria
•	AC-CM-WF-01-01: Every commissioned asset belongs to one defined system boundary.
•	AC-CM-WF-01-02: Each required test has stage, owner, witness, criteria and prerequisite.
•	AC-CM-WF-01-03: Commissioning programme logic traces to construction and handover milestones.
```

## CM-WF-02

```
CM-WF-02 - Test procedure, pack and readiness release
Primary owner: Commissioning Engineer / Manager  |  Trigger: Test due within configured lookahead
Required inputs
•	Approved design/specification/vendor requirements
•	test type, objective, steps and acceptance criteria
•	prerequisite construction/quality/permit/utility status
•	instrument IDs and calibration certificates
•	witnesses, notice period, safety controls and contingency
Deterministic flow
1.	Create controlled test procedure and pack with system/equipment/tag scope.
2.	Map every acceptance criterion to source and required raw reading/evidence.
3.	Run readiness checklist across completion, defects, cleaning, energisation, access, documents, vendor, instruments and permits.
4.	Issue witness notification and capture attendance/waiver.
5.	Commissioning Manager releases Ready to Test or rejects with blockers.
6.	Freeze pack revision used for execution.
AI-agent duties and human guardrails
•	Draft procedure/checklist from accepted technical sources.
•	Identify missing criteria or contradictory tolerances; cannot release test.
Outputs
•	TestProcedure Revision
•	TestPack
•	ReadinessCheck
•	WitnessNotification
•	ReadyToTest Release
Exception controls
•	Calibration expiry, open critical defect or missing safe isolation blocks release.
•	Witness waiver requires authorised record and contract rule.
•	Procedure change after release cancels/reissues readiness.
Events: TEST_PROCEDURE_CREATED | TEST_READINESS_CHECKED | WITNESS_NOTIFIED | TEST_RELEASED | TEST_BLOCKED
APIs:   POST /v1/systems/{id}/test-packs | POST /v1/test-packs/{id}:readiness-check | POST /v1/test-packs/{id}:release
Acceptance criteria
•	AC-CM-WF-02-01: No test can enter In Progress without released pack revision.
•	AC-CM-WF-02-02: Criteria cite controlled design/spec/vendor source.
•	AC-CM-WF-02-03: Witness notice and response are time-stamped and recipient-specific.
```

## CM-WF-03

```
CM-WF-03 - FAT, SAT and vendor test control
Primary owner: Commissioning Manager / Vendor Representative  |  Trigger: Manufacturing or delivery milestone
Required inputs
•	Approved vendor documents and inspection/test plan
•	equipment tag/serial and purchase order
•	FAT/SAT procedure and acceptance criteria
•	witness attendance, calibrated instruments and raw logs
•	shipping release/delivery/installation prerequisites
Deterministic flow
1.	Schedule FAT/SAT with notice and attendance status.
2.	Verify equipment identity, document revision and instrument calibration.
3.	Execute each test step; record reading, unit, timestamp, instrument and performer.
4.	Record Pass/Fail/Conditional and punch/exception per item.
5.	Approve shipping release or site acceptance only under designated authority.
6.	Carry FAT exceptions into SAT/system commissioning until verified closed.
AI-agent duties and human guardrails
•	Extract readings from forms/images and compare to limits, subject to confirmation.
•	Summarise failure patterns and affected downstream tests.
Outputs
•	FAT/SAT Record
•	RawTestDataset
•	Exception/Punch Items
•	Shipping/Site Release
•	Equipment Traceability
Exception controls
•	Equipment serial mismatch blocks acceptance.
•	Conditional pass has explicit restrictions and closure due date.
•	Vendor PDF alone is insufficient where raw structured readings are required.
Events: FAT_STARTED | TEST_READING_RECORDED | FAT_COMPLETED | SHIPPING_RELEASED | SAT_COMPLETED
APIs:   POST /v1/equipment/{id}/fat-tests | POST /v1/tests/{id}/readings | POST /v1/tests/{id}:complete
Acceptance criteria
•	AC-CM-WF-03-01: Every reading retains instrument/calibration and performer identity.
•	AC-CM-WF-03-02: Result calculation is deterministic from raw readings and limits.
•	AC-CM-WF-03-03: Open FAT exception is visible at delivery, installation and SAT readiness.
```
