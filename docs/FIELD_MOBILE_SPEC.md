# CONSTRUX Site Field — Android & iOS Developer Specification (v1.0)

**Status of this file.** The product owner is streaming this specification into the
build session section by section. What follows is their text, **verbatim**, in the
order received. It is held here so that the build works from a durable document
rather than from conversation memory, and so tomorrow's sections append to it.

| Received | Sections |
|---|---|
| 3 September 2026 | Front matter, document map, §1–§8 (including all of §6's X-WF-01 to X-WF-12, §7's C-MOB-WF-01 to 05, §8's D-MOB-WF-01 to 06) |
| Pending | §9 Tender, §10 Construction, §11 Commissioning, §12 Handover, §13 Data, §14 Offline sync, §15 API, §16 AI/security/NFR, §17 QA/release/build order, Appendix A, Appendix B |

Two directives given alongside the text are binding on the build and are kept in
place where they were said:

- *"THE SAME PRINCIPLE APPLY. NOTHING TO BE REMOVED OR DELETED, BUT ENHANCED."*
- *"THERE IS NO SET UP SECTION HERE, ONLY SIGN-IN BASED ON THE ORGANISATION ALREADY WITH THEIR ACCOUNT."*

The header's own conflict rule governs: where this document and the lifecycle
baseline disagree, the stricter evidence, authority, safety, privacy or
immutable-record rule wins.

---

CONSTRUX PRODUCT + FIELD ENGINEERING

CONSTRUX SITE FIELD

Android & iOS Developer Specification

Mobile product, UX, offline architecture, field workflows, APIs, security and test contract

Implementation directive: Build field-native action clients, not reduced desktop dashboards. The apps must keep work moving without connectivity while preserving current-information, safety, authority, evidence, privacy and commercial traceability controls.

Control	Value

Document version	v1.0

Issue date	26 August 2026

Status	Developer implementation baseline

Platforms	Android and iOS only

Primary audience	Mobile product, UX/UI, React Native/native engineers, API/backend engineers, QA, security, DevOps and construction SMEs

Lifecycle field scope	Concept, Design, Tender, Construction, Commissioning and Handover

Classification	Confidential - controlled implementation document



This specification is a mobile-only companion to the CONSTRUX lifecycle implementation baseline. Where a conflict exists, the stricter evidence, authority, safety, privacy or immutable-record rule governs.

---

Document map
How to use this specification: Sections 1-5 define the mobile product and every routed surface. Sections 6-12 are the executable workflow contract. Sections 13-17 define data, offline sync, APIs, AI, security, testing and build order.
•	1. Executive mobile implementation directive
•	2. Mobile-only boundary, personas and authority
•	3. Information architecture and 40-screen route catalogue
•	4. Global field UX and component behaviour
•	5. Role command centres and dashboard contract
•	6. Shared mobile workflows
•	7. Concept field module
•	8. Design field module
•	9. Tender field module
•	10. Construction field module
•	11. Commissioning field module
•	12. Handover field module
•	13. Mobile domain, forms and local data contract
•	14. Offline-first architecture and deterministic sync
•	15. API, events and integration contract
•	16. AI, security, privacy and non-functional requirements
•	17. QA, release, Definition of Done and build sequence
•	Appendix A. Canonical status dictionary
•	Appendix B. Source and standards baseline

---

1. Executive mobile implementation directive
Product promise: A site user can start a shift, find current information, capture field truth, complete an inspection/test, raise an issue and close the shift in poor connectivity without losing evidence or bypassing project authority.
1.1 Build outcomes
•	The authenticated landing view tells each user what must be done today, what is blocked, which information changed and what remains unsynced.
•	A captured field fact is created once and projected to diaries, programme, commercial evidence, quality, HSE, commissioning and handover according to permissions.
•	Every material action is attributable to tenant, project, user, appointment, device, object/version, time source, location source, evidence and server receipt.
•	Offline capture is deterministic and recoverable. Network loss changes synchronisation state, not the meaning of the record.
•	Current approved information, RAMS, permits, inspections and test prerequisites are resolved at workface/system/asset level, not left as a document-library search problem.
•	AI reduces typing and finds evidence; it remains visually proposed and cannot exercise construction, safety, design, commercial, commissioning or acceptance authority.
1.2 Explicit non-goals
•	No Platform Super Admin, enterprise subscription, user-seat, trial-ACU or billing administration in the apps.
•	No portfolio or project creation, organisation configuration, authority-matrix authoring or contract/jurisdiction-rule editing.
•	No full estimating, tender pricing, bid adjudication, formal baseline authoring, CVR approval, payment certification or final-account agreement.
•	No design authoring/publishing, federated-model administration or uncontrolled file replacement.
•	No background employee surveillance, continuous location tracking or hidden audio/image capture.
1.3 Definition of mobile success
Dimension	Release-level outcome
Adoption	A supervisor completes planned shift capture with materially less re-entry than paper/spreadsheet/email route.
Field resilience	Airplane-mode workflows preserve structured records and attachments through process death, restart, upgrade and later sync.
Control	No stale information, failed safety prerequisite, hold point, test reading or acceptance signature can be silently overridden.
Traceability	A downstream programme/commercial/quality/HSE/commissioning/handover value resolves to originating mobile record and evidence.
Usability	Core task is discoverable within two taps from Today/Workface and usable with dynamic type, screen reader and field-sized touch targets.
THE SAME PRINCILE APPLY. NOTHING TO BE REMOVED OT DELETED , BUT ENHANCED
2. Mobile-only boundary, personas and authority
2.1 Non-negotiable product rules
ID	Rule	Developer requirement
MOB-001	Mobile-only execution boundary	Android and iOS are field execution clients. Enterprise setup, portfolio creation, subscription, contract-rule authoring, adjudication, baseline approval and customer-user administration remain web-only.
MOB-002	Action-first home	The first authenticated screen is My Shift / Action Queue for the selected project, not a portfolio dashboard. Every card resolves to an executable task, blocked reason or field decision.
MOB-003	Offline is a normal state	Permitted field records, media and signatures must be creatable without connectivity. Stable client IDs, local validation, encrypted storage, queued attachments and deterministic sync are mandatory.
MOB-004	Evidence before narrative	A field assertion that can affect progress, quality, safety, payment, change, commissioning or handover must reference time, accountable user, project/location/package and immutable evidence or an explicit evidence exception.
MOB-005	No silent mutation	Submitted, issued, approved, witnessed or accepted records are immutable on device. Corrections create amendments, superseding revisions or corrective records with reason and authority.
MOB-006	Current-information guard	Workface, inspection, test and permit screens display the current approved information revision and warn or block when the local pack is stale, superseded or outside the authorised work scope.
MOB-007	Human authority retained	AI may extract, classify, transcribe, compare, draft and forecast. It cannot approve design, authorise work, release a hold point, determine legal liability, certify payment, accept commissioning, certify competence or sign regulatory submissions.
MOB-008	Safety is fail-closed	Expired RAMS, permit, isolation, competence or safety-critical information blocks configured starts and releases. AI suggestions never convert into safety findings without competent-person confirmation.
MOB-009	One record, many projections	Daily logs, progress, quality, HSE, commercial candidates, commissioning and handover views are projections from shared canonical records and events; users do not re-key the same field fact into separate modules.
MOB-010	Project-scoped privacy	Local packs contain only assigned projects, packages, locations, dates and sensitivity classes. Lost-device revocation, remote key invalidation and policy-driven local purge are required.
MOB-011	ACU transparency	Every mobile AI action previews the estimated ACU range, task risk and data scope; execution uses hold, commit, provenance and settle. Trial ACUs are auto-provisioned and never represented as billable project cost.
MOB-012	Field-grade interaction	Primary actions are usable one-handed, with gloves and in poor light: large targets, short forms, scan/voice defaults, autosave, high-contrast status, haptics and explicit saved/offline/sync/conflict feedback.
MOB-013	Time and calendar truth	The device records server time when available, device time, IANA project time zone and original UTC offset. Contract/business-calendar calculations are server-controlled and effective-dated; the app never invents deadline rules.
MOB-014	Platform role separation	Platform Super Admin has no field app workspace. Enterprise Admin configures access on web. Mobile access is derived from enterprise membership, project appointment, package/location scope, role and device policy.
2.2 Mobile roles and decision ceilings
Role	Mobile purpose	Hard boundary
Project / Construction Manager	Cross-package field command, mobilisation, start-work authority, daily completeness, completion and escalation	Cannot administer enterprise subscription or change contract/jurisdiction packs
Site Manager	Shift control, daily diary, labour/plant/deliveries, progress, coordination, quality/HSE action routing	Cannot certify payment or accept design/commissioning outside delegation
Supervisor / Foreperson	Crew briefing, workface readiness, quantities, constraints, photos, toolbox talks and close-out	Sees assigned packages/locations and masked commercial values
General Operative	Acknowledge briefings, view assigned work/current information, raise observation/near miss and upload evidence	No approval, instruction, commercial, personal-data or cross-package access
HSE Manager / Advisor	RAMS review routing, permits, observations, inspections, incidents, investigations and action verification	AI suggestions are prompts; formal classification remains authorised human decision
Quality Manager / Inspector	ITPs, inspection/test requests, hold/witness points, NCRs, defects, corrective action and verification	Cannot inspect own work where independence policy applies
Site / Field Engineer	Set-out evidence, technical queries, drawing/model review, measurements, temporary works and as-built verification	Cannot issue contractual instruction unless separately appointed
Planner	Lookahead, constraints, actual dates, progress verification, productivity and recovery evidence	Cannot overwrite approved baseline from mobile
QS / Commercial Manager	Progress verification, change-event evidence, site records for notices, valuation and payment support	Cannot certify payment, agree final account or alter raw submitted quantities on device
Design Manager / Designer	Site design review, queries, field change verification, design-risk response and as-built review	Cannot publish a design revision from a field markup alone
Commissioning Manager / Engineer	System readiness, test packs, readings, witness, exceptions, retest and turnover	Cannot accept system without configured authority and immutable evidence
Handover / Asset Manager	Snags, asset data, O&M gaps, training, keys/spares, acceptance walkdowns and aftercare	Cannot waive statutory or safety-critical deliverables
Client / Operator Representative	Witness, comment, conditional acceptance and transfer acknowledgement for assigned scope	No contractor record editing or hidden commercial/internal access
Regulator / Independent Auditor	Read/export permitted evidence, scan manifests and witness assigned inspections	Every write, approval and AI mutation is denied and audited
Vendor / Subcontractor Representative	Submit assigned delivery, inspection, test, asset and completion evidence	Tenant-isolated, package-limited, expiry-controlled external access
THERE IS NOT SEP UP SECTION HERE , ONLY SIGNIN BASED ON THE ORGANUITION ALREADY WITH THIER ACCOUNT
2.3 Authorisation evaluation
allow = tenantMembership.active
     && projectAppointment.effectiveAt(command.occurredAt)
     && role.permits(command.type)
     && scope.contains(packageId, locationId, systemId, sensitivity)
     && object.state.allows(command.type)
     && devicePolicy.allows(devicePosture, appBuild, offlineMode)
     && authorityMatrix.allows(decisionType, value/risk tier)
// Client mirrors this for UX. Server is authoritative for every command.
Separation rule: Mobile may hide or disable an action for usability, but no client-side check is an authorisation control. Every command is re-evaluated server-side using effective-dated appointment, scope, authority, object state and device policy.

---

3. Information architecture and screen route catalogue
3.1 Primary navigation
Tab	Content	Behaviour
Today	My Shift header, urgent safety/quality notices, assigned work, pending acknowledgements, due inspections/tests, constraints and unsynced work	Always first tab; badge excludes already acknowledged informational alerts
Work	Stage-aware modules and package/location work queues	Only authorised modules render; unavailable web-only functions do not appear disabled
Capture	Persistent centre action for photo/video, voice note, scan, daily entry, issue, progress, observation and test reading	Context inherits project/package/location but user must confirm before save
Plans	Current drawings/models/specifications, lookahead, workface cards, ITP/test packs and handover requirements	Supports offline project pack and supersession banners
Inbox	Tasks, review requests, acknowledgements, mentions, approvals permitted on mobile, conflicts and sync failures	Actionable items separated from information notifications
More	Search, assets, people, offline packs, sync centre, settings, device security, help and diagnostic export	No enterprise billing or platform administration

---

3.2 Route hierarchy
/auth -> enterprise -> sign-in -> device-enrolment
/projects -> {projectId}
  /today | /work | /capture | /plans | /inbox | /map
  /shift/{start|close} | /daily-log/{id} | /workfaces/{id}
  /rams/{id} | /permits/{id} | /inspections/{id} | /ncrs/{id}
  /rfis/{id} | /change-candidates/{id} | /drawings/{id}
  /commissioning/systems/{id} | /tests/{id}
  /assets/{id} | /assets/scan | /snags/{id}
  /handover/walkdown | /training/{id} | /transfers/{id}
/offline-packs | /sync | /search | /settings/security

---

3.3 Screen catalogue
ID	Route	Screen	Required content / critical state
M-SCR-001	/auth/enterprise	Enterprise discovery	Organisation code/QR, region and privacy notice. Invalid/expired code; offline sign-in allowed only after prior device enrolment
M-SCR-002	/auth/sign-in	Sign-in	SSO/email, MFA/passkey and device trust. No project data is displayed until policy and device posture pass
M-SCR-003	/auth/device-enrolment	Device enrolment	Device name, attestation, push token, biometric opt-in and policy acknowledgement. Root/jailbreak or unsupported OS follows enterprise allow/deny/read-only policy
M-SCR-004	/projects	Project selector	Recent/assigned projects, stage, last sync, offline availability. No access request from app unless enterprise policy exposes workflow
M-SCR-005	/projects/{id}/today	My Shift / Today	Action queue, shift status, alerts, workface cards and unsynced count. Stale pack banner is persistent; critical revoked access locks data immediately
M-SCR-006	/projects/{id}/work	Stage module launcher	Authorised modules grouped by active stage and role. Web-only modules are absent, not dead tiles
M-SCR-007	/projects/{id}/capture	Universal capture sheet	Photo/video, voice, scan, issue, progress, diary, observation, test and asset. Confirms inherited project/package/location before durable local save
M-SCR-008	/projects/{id}/inbox	Action inbox	Assigned/review/acknowledge/conflict/sync queues with due date and priority. Information notifications cannot hide required actions
M-SCR-009	/projects/{id}/plans	Plans and controlled information	Drawings/models/specs, revision, suitability, downloaded state and impacted workfaces. Superseded content remains historic and cannot open as current-work default
M-SCR-010	/projects/{id}/map	Site/zone map	Offline tiles, zones, workfaces, assets, issues and access boundaries. GPS uncertainty and manual pin source are always visible
M-SCR-011	/projects/{id}/shift/start	Shift start	Weather, supervisor, crew, planned work, briefings, controls and readiness. Cannot start configured high-risk work with missing critical prerequisites
M-SCR-012	/projects/{id}/shift/close	Shift close	Progress, labour/plant, deliveries, issues, safety/quality, photos and completeness. Allows late amendment, never overwrites submitted shift
M-SCR-013	/projects/{id}/daily-log/{id}	Daily diary	Timeline editor with voice, structured sections and evidence rail. Autosaved offline draft; simultaneous edits create visible conflict
M-SCR-014	/projects/{id}/workfaces/{id}	Workface card	Scope, current information, RAMS/ITP, crew, material, constraints, plan and progress. Ready state is calculated; user cannot manually force green
M-SCR-015	/projects/{id}/briefings/{id}	Briefing/toolbox	Audience, content revision, questions, acknowledgement and exceptions. Attendance is not competence; failed understanding triggers action
M-SCR-016	/projects/{id}/rams/{id}	RAMS	Current revision, activity steps, hazards/controls, acceptance and briefing status. Read-only source; revisions authored through controlled route
M-SCR-017	/projects/{id}/permits/{id}	Permit/isolation	Boundary, validity, controls, issuer/acceptor, live state and handback. Fail-closed on expiry, revoked isolation or missing authorised signatory
M-SCR-018	/projects/{id}/progress/new	Progress claim	WBS/task/location, installed quantity, unit, date, crew and evidence. Submitted and verified values remain separate
M-SCR-019	/projects/{id}/resources	Labour and plant	Crew/role/hours, plant/usage/downtime, allocation and evidence. Sensitive personal fields masked by role and retention policy
M-SCR-020	/projects/{id}/deliveries/{id}	Delivery receipt	PO/package, supplier, quantity, condition, certificates, photos and accept/quarantine. Safety-critical material without traceability remains quarantined
M-SCR-021	/projects/{id}/inspections/{id}	Inspection/test request	ITP point, location, prerequisites, parties, criteria, evidence and result. Hold point successor work cannot start before authorised release
M-SCR-022	/projects/{id}/ncrs/{id}	NCR / defect	Requirement, finding, containment, cause, corrective action, verifier and chronology. Close requires succeeding verification; failed evidence is preserved
M-SCR-023	/projects/{id}/observations/{id}	Safety observation	Type, potential severity, location, activity, evidence, immediate action and owner. Potential incident prompts escalation but does not make legal classification
M-SCR-024	/projects/{id}/incidents/{id}	Incident	Immediate facts, injured persons, witnesses, scene evidence, notifications and actions. Restricted access; emergency actions precede form completion
M-SCR-025	/projects/{id}/rfis/{id}	RFI / technical query	Question, source revision, markup, location, need-by date and impacts. AI draft cannot be treated as controlled technical response
M-SCR-026	/projects/{id}/change-candidates/{id}	Change/notice candidate	Origin, event facts, clause candidate, dates, impacts and evidence chronology. Mobile record is a candidate until authorised contract route validates it
M-SCR-027	/projects/{id}/drawings/{id}	Drawing/model viewer	Pan/zoom, layers, revision compare, pin, measure, markup and offline state. Measurements are advisory unless calibrated/validated workflow says otherwise
M-SCR-028	/projects/{id}/meetings/{id}	Meeting/action record	Attendance, agenda, voice transcript, decisions, actions and issue controls. Consent and recording indicator required where applicable
M-SCR-029	/projects/{id}/commissioning/systems/{id}	System dashboard	Boundary, assets, completion, tests, exceptions and turnover. No implicit completion from document count
M-SCR-030	/projects/{id}/tests/{id}	Commissioning test	Procedure steps, readings, units, instruments, witness, result and retest. Raw readings immutable; derived result and authorised decision separate
M-SCR-031	/projects/{id}/assets/scan	Asset scan	QR/barcode/NFC/manual tag lookup, installed identity and required attributes. Duplicate tag/serial is a blocker, not auto-merged
M-SCR-032	/projects/{id}/assets/{id}	Asset record	Location/system/type, make/model/serial, dates, warranty, documents and status. Unknown mandatory values remain explicit Unknown with owner
M-SCR-033	/projects/{id}/snags/{id}	Snag/punch item	Requirement, severity, exact location/asset, evidence, owner and verification. Safety/statutory items cannot be ordinary-minor severity
M-SCR-034	/projects/{id}/handover/walkdown	Acceptance walkdown	Route, requirements, observations, conditions, signatures and receipt. Conditional acceptance records restrictions, owner, date and expiry
M-SCR-035	/projects/{id}/training/{id}	Training session	Module/version, trainer, attendees, assessment, evidence and competence outcome. Attendance alone never creates competence
M-SCR-036	/projects/{id}/transfers/{id}	Keys/spares/credential transfer	Inventory, condition, sender/recipient, secure-reference and receipt. Secret values never enter normal document or event payloads
M-SCR-037	/offline-packs	Offline pack manager	Project/package scope, size, freshness, download progress, expiry and purge. Pack build checks device space, network policy and sensitivity
M-SCR-038	/sync	Sync centre	Outbox/inbox, attachments, failures, conflicts, retry and diagnostic ID. No generic 'sync failed'; each item exposes safe next action
M-SCR-039	/search	Global project search	Records, plans, assets, tags and people filtered by local/server availability. Offline results clearly labelled and never imply complete server search
M-SCR-040	/settings/security	Security and device	Biometrics, session, downloads, cellular upload, cache, diagnostics and sign-out. Sign-out/revocation handles queued work according to enterprise policy

---

3.4 Universal screen state contract
•	Loading: skeleton reflects final layout; primary action remains unavailable until object/policy state is known.
•	Ready online: server freshness and pending local work both visible.
•	Ready offline: persistent Offline banner, pack version/expiry and permitted local actions.
•	Limited: specific missing live dependency is named; unaffected capture remains available.
•	Saving: local durable-save confirmation appears before navigation; network spinner is not the save indicator.
•	Queued/Uploading/Awaiting Receipt: record remains usable with explicit submission limitations.
•	Conflict: screen opens comparison/resolution; ordinary editing does not conceal conflict.
•	Rejected: data is safe, reason and correction path are displayed with correlation ID.
•	Access revoked: content is locked/quarantined and safe recovery instructions replace normal screen.
•	Empty: explains scope/filter/offline limitation and offers only authorised next action.

---

4. Global field UX and component behaviour
4.1 Interaction principles
•	One principal action per screen; destructive or authority-sensitive commands are never adjacent to routine save.
•	Forms progressively disclose sections. A user can save locally after the first valid identity/context fields.
•	Use scan, recent context and controlled defaults to reduce typing; every inherited value is confirmed before material submit.
•	Autosave on material field change, field blur, attachment capture, app background and navigation. Show Saved locally / Queued / Synced separately.
•	Never show generic green/red without text/icon. Warning waiver displays approver, reason, expiry and affected scope.
•	Date and time are native pickers, project time-zone aware and never plain unvalidated text.
•	Field targets are at least 48 dp; critical actions require deliberate confirmation and optional haptic feedback.
•	Photo/audio/location capture is visibly active, purpose-limited and permissioned at point of use.

---

4.2 Component contract
Component	Mandatory behaviour
App bar	Project, stage, sync badge and context switcher; destructive context switching warns about unsaved draft
Status chip	Icon + text + colour; never colour alone. Canonical states only, with timestamp and accountable source
Primary action	Minimum 48 dp target; one principal action per screen; blocked action explains rule, missing evidence and owner
Field control	Label, required/optional state, unit, source, validation and help. Numeric fields use locale input but store canonical unit/value
Date/time	Native pickers, project time zone and offset; defaults disclosed; future/past constraints validated
Location picker	Package > zone > level > room/chainage/grid hierarchy plus map/scan/manual route; stable IDs retained
Evidence rail	Thumbnail, type, capture time, author, hash/upload state, sensitivity and link count; original is never destructively edited
Signature sheet	Signatory identity, role, intent statement, exact object/version, timestamp, device/session and witnessed/remote status
Offline banner	Persistent state: Online, Limited, Offline, Syncing, Conflict, Access Revoked; tapping opens Sync Centre
Error state	Human-readable cause, correlation ID, whether data is safe, and Retry / Save Draft / Contact Support action
Empty state	Explains why list is empty and offers only permitted creation/download/filter action
AI suggestion	Distinct proposed styling, source anchors, confidence, limitations, ACU estimate and Accept/Edit/Reject; never looks approved

---

4.3 Form validation layers
Layer	Behaviour	Examples
Input	Immediate local format/range/unit validation; draft remains saveable	Required project context, invalid date, impossible negative quantity
Schema	Command cannot queue until payload validates against pack schema/version	Missing entity ID, unknown enum, invalid evidence link
Blocking rule	Submit/release disabled; reason and action owner visible	Expired permit, missing hold-point prerequisite, duplicate asset tag
Warning	Authorised submit may proceed with reason/waiver	Low-confidence OCR, stale non-critical reference
Server policy	Receipt or structured rejection after membership/authority/effective-rule validation	Authority expiry, changed contract calendar, object superseded
Conflict	Preserve base/local/server and require permitted resolution	Two-device material edit
4.4 Capture and accessibility specifics
•	Camera: torch, zoom, orientation, retake and safe permission fallback; never burn annotation into original.
•	Voice: pause/resume, segmented recovery, recording indicator, consent text and transcript correction.
•	Scanner: continuous scan guard, torch, manual entry, audible/haptic success and accessible resolved-entity confirmation.
•	Maps: do not require drag-only interaction; provide hierarchy/manual/coordinate entry equivalents.
•	Drawing/model: controls have accessible labels; essential issue creation works from sheet/object search without gesture-only precision.
•	Dynamic type: forms and cards reflow; no clipped button labels, fixed-height rows or horizontal scrolling for core action.
•	Media: user can add text description; generated OCR/description is proposed and editable.

---

5. Role command centres and dashboard contract
Dashboard rule: A mobile dashboard exists to decide and act during a shift. It must answer what is happening, what changed, what is unsafe/blocked, what needs action now and what remains unsynced.
5.1 Project / Construction Manager command centre
Decision: Can each package start or continue safely, compliantly and to the accepted plan?
Above-the-fold KPIs
•	Workfaces Ready / Blocked / Not Started
•	Critical constraints ageing
•	Verified progress vs plan
•	Open hold points and NCRs
•	Incidents and stop-work status
•	Daily-record completeness
•	Unsynced critical records
Widgets
•	Site/zone status map
•	Start-work readiness board
•	Six-week milestones
•	Critical decisions
•	Package turnover matrix
•	Shift exception feed
Quick actions
•	Authorise/decline start within delegation
•	Assign constraint
•	Request inspection
•	Escalate stop-work
•	Issue shift direction candidate
•	Approve daily close

---

5.2 Site Manager command centre
Decision: What must be briefed, recorded, verified or escalated before this shift closes?
Above-the-fold KPIs
•	Crew checked in
•	Briefings acknowledged
•	Deliveries due/late
•	Tasks claimed/verified
•	Open field issues
•	Diary completeness
•	Queued uploads
Widgets
•	My site map
•	Workface cards
•	Delivery gate
•	Labour/plant summary
•	Progress exceptions
•	Shift-close checklist
Quick actions
•	Start/close shift
•	Record diary
•	Verify progress
•	Accept/quarantine delivery
•	Raise RFI/NCR/observation
•	Submit shift pack

---

5.3 Supervisor / Foreperson command centre
Decision: Is my crew working on the right task, in the right place, with current information and controls?
Above-the-fold KPIs
•	Assigned work ready
•	Crew present/competent
•	Current drawing revision
•	Materials available
•	Constraints
•	Quantity completed
•	Briefings due
Widgets
•	Crew card
•	Workface readiness
•	Plan of day
•	Drawing shortcuts
•	Capture rail
•	End-of-shift quantities
Quick actions
•	Brief crew
•	Acknowledge RAMS
•	Record labour/plant
•	Claim progress
•	Raise blocker
•	Submit photo evidence

---

5.4 HSE Manager / Advisor command centre
Decision: Which activity presents unacceptable residual risk or a failed control?
Above-the-fold KPIs
•	High-risk work today
•	Permits expiring
•	Unbriefed workforce
•	Open observations
•	Incident actions
•	RAMS due review
•	Isolation status
Widgets
•	Activity-risk map
•	Permit/isolation board
•	Observation trend
•	Inspection route
•	Incident timeline
•	Action verification queue
Quick actions
•	Stop/escalate activity
•	Inspect
•	Issue action
•	Record incident
•	Verify close-out
•	Schedule toolbox talk

---

5.5 Quality Manager / Inspector command centre
Decision: Which work can pass, must remain held, or requires a controlled nonconformance route?
Above-the-fold KPIs
•	Inspections due
•	Hold/witness points
•	Pass/fail/conditional
•	Open NCRs
•	Defects ageing
•	Calibration expiry
•	First-time-pass rate
Widgets
•	Inspection route
•	ITP readiness
•	Evidence completeness
•	NCR recurrence
•	Defect heat map
•	Verifier workload
Quick actions
•	Release inspection
•	Record result
•	Maintain/release hold
•	Raise NCR
•	Reject evidence
•	Verify corrective action

---

5.6 Field Engineer / Design Manager command centre
Decision: Is the installed/workface condition consistent with the current approved design and controlled response?
Above-the-fold KPIs
•	Current revision availability
•	Open RFIs
•	Field design variances
•	Temporary works due
•	As-built gaps
•	Affected workfaces
Widgets
•	Drawing/model viewer
•	RFI queue
•	Markup comparison
•	Design-risk prompts
•	As-built verification
•	Change impact links
Quick actions
•	Markup
•	Raise/respond to query
•	Record variance
•	Verify as-built
•	Request design review
•	Notify affected package

---

5.7 Planner / QS / Commercial command centre
Decision: What verified field fact changes progress, productivity, forecast, payment or contractual exposure?
Above-the-fold KPIs
•	Verified quantity
•	Plan variance
•	Productivity
•	Change candidates
•	Notice deadlines
•	Unverified applications
•	Evidence gaps
Widgets
•	Progress verification
•	Lookahead/constraints
•	Quantity ledger
•	Change-event chronology
•	Notice clock
•	CVR evidence feed
Quick actions
•	Verify/adjust quantity
•	Record reason
•	Build evidence pack
•	Escalate notice
•	Assign constraint
•	Request source record

---

5.8 Commissioning Manager / Engineer command centre
Decision: Which system is ready to test, witness, retest or turn over?
Above-the-fold KPIs
•	Systems mechanically complete
•	Tests ready/in progress
•	Witnesses due
•	Tests passed/conditional/failed
•	Open exceptions
•	Calibration status
•	Turnover readiness
Widgets
•	System matrix
•	Test calendar
•	Readiness checklist
•	Live readings
•	Exception/retest board
•	Turnover pack
Quick actions
•	Release test
•	Scan asset
•	Record reading
•	Capture witness
•	Raise exception
•	Submit system completion

---

5.9 Handover / Asset Manager command centre
Decision: What prevents safe, usable, data-complete transfer to the operator?
Above-the-fold KPIs
•	Snags by severity
•	Assets validated
•	O&M gaps
•	Training complete
•	Keys/spares transferred
•	Regulatory evidence
•	Aftercare obligations
Widgets
•	Handover requirements
•	Snag route
•	Asset scan
•	O&M completeness
•	Training matrix
•	Acceptance walkdown
Quick actions
•	Raise/verify snag
•	Validate tag/data
•	Reject incomplete deliverable
•	Record transfer
•	Capture acceptance
•	Create aftercare task

---

5.10 Dashboard calculation and freshness
•	Each KPI declares source entity/version, cut-off, accepted-state filter, unit, project calendar and freshness status.
•	Uploaded-but-unaccepted records do not improve readiness/completion; claimed and verified progress are shown separately.
•	Offline projection identifies pack cursor and pending local deltas; it never implies the server dashboard is current.
•	Counts drill to exact records. A user can never see an aggregate that reveals out-of-scope restricted detail.

---

6. Shared mobile workflows
Shared control spine: These workflows are implemented once and reused by every stage module. Stage teams must not build separate authentication, evidence, scanning, signing or sync behaviour.
X-WF-01 - Enterprise sign-in, device enrolment and local unlock
Primary owner: Mobile user + Enterprise Identity Administrator  |  Trigger: First install, restored device, policy change or expired trust
Offline behaviour: Previously enrolled user may unlock an unexpired local session offline; first enrolment always requires network
Required inputs
•	Enterprise code/QR or verified deep link
•	OIDC/SAML identity and MFA/passkey challenge
•	device attestation, OS version, app build and integrity signals
•	enterprise mobile policy, privacy notice and permitted biometric mode
Deterministic mobile flow
1.	Resolve enterprise region and identity provider without exposing tenant enumeration.
2.	Authenticate through system browser/passkey; exchange one-time code for device-bound tokens.
3.	Register installationId, device public key, push token and posture; do not use advertising ID.
4.	Present exact mobile policy and privacy version; record acceptance before project data download.
5.	Generate local database/file-vault keys protected by iOS Keychain/Secure Enclave or Android Keystore hardware where available.
6.	Offer biometric local unlock only after successful online sign-in; retain server-controlled absolute/idle expiry.
7.	Fetch memberships, appointments and minimum app build; route to project selector or explicit no-access state.
AI duties and human guardrails
•	No model invocation in authentication.
•	AI must never infer enterprise, identity, role or device trust.
Outputs
•	DeviceRegistration
•	PolicyAcceptance
•	Session
•	AuditEvent
Exception controls
•	Root/jailbreak, failed attestation or unsupported OS follows configured Deny / Read-only / Warn policy.
•	Revoked membership invalidates refresh and local project keys at next push/foreground; sensitive data becomes inaccessible.
•	Lost network during callback returns to safe resumable state without duplicate registration.
Events: DEVICE_ENROLLED | MOBILE_POLICY_ACCEPTED | SESSION_STARTED | DEVICE_ACCESS_DENIED
APIs:   POST /v1/mobile/enterprise/resolve | POST /v1/mobile/device-registrations | GET /v1/mobile/bootstrap | POST /v1/mobile/sessions/revoke
Acceptance criteria
•	AC-X-01-01: Tenant data is unavailable before membership, appointment and device policy pass.
•	AC-X-01-02: Biometric unlock releases only device-bound local session material, never the account password.
•	AC-X-01-03: A revoked device cannot decrypt a newly rotated project pack and receives no sensitive push content.

---

X-WF-02 - Project selection, assignment scope and offline pack preparation
Primary owner: Mobile user  |  Trigger: Successful bootstrap, project assignment or planned offline work
Offline behaviour: Pack download requires network; downloaded authorised scope remains usable until policy expiry/revocation
Required inputs
•	Assigned projects and project appointments
•	package/location/date role scope
•	required controlled information, work queues and reference data
•	device capacity, Wi-Fi/cellular policy and sensitivity class
Deterministic mobile flow
1.	List only assigned projects; show active stage, role, last sync and offline-pack availability.
2.	User selects project and planned package/location/date window; default follows appointment, never broadens it.
3.	Server compiles manifest of entities, document derivatives, map tiles, forms, validation rules and object hashes.
4.	Display estimated storage, expiry, excluded sensitive content and required network type before download.
5.	Download manifest first, then priority records and resumable files in chunks; verify hash before activation.
6.	Atomically promote complete pack version; retain prior valid pack until new version is usable.
7.	Index local search and expose freshness per domain, not a single misleading project timestamp.
AI duties and human guardrails
•	Suggest pack scope from recent assignments and shift plan; user confirms.
•	AI cannot add unauthorised package/location or pre-download restricted data.
Outputs
•	OfflinePack
•	OfflineManifest
•	LocalSearchIndex
•	PackDownloadReceipt
Exception controls
•	Insufficient device storage proposes a narrower scope or purge of expired packs; never deletes unsynced work.
•	Hash mismatch quarantines the file and retries; pack remains inactive until mandatory content passes.
•	Partial pack visibly lists unavailable modules/documents and prevents false Ready state.
Events: OFFLINE_PACK_REQUESTED | OFFLINE_PACK_ACTIVATED | OFFLINE_FILE_QUARANTINED | OFFLINE_PACK_EXPIRED
APIs:   POST /v1/mobile/offline-packs:estimate | POST /v1/mobile/offline-packs | GET /v1/mobile/offline-packs/{id}/manifest | POST /v1/mobile/offline-packs/{id}/receipt
Acceptance criteria
•	AC-X-02-01: Every local entity is within tenant, project, role, package/location and sensitivity scope.
•	AC-X-02-02: Interrupted download resumes without duplicating files or activating an incomplete manifest.
•	AC-X-02-03: Pack purge cannot remove an entity or attachment referenced by a pending outbox item.

---

X-WF-03 - Shift start, work context and readiness handshake
Primary owner: Site Manager / Supervisor  |  Trigger: Planned shift window or user starts site work
Offline behaviour: Yes; local readiness uses signed pack rules and shows server-validation pending where required
Required inputs
•	Date/shift, supervisor and work area
•	planned workfaces and crew
•	weather/access constraints
•	current RAMS, permits, isolations, ITP/test prerequisites
•	latest information revisions and material/resource readiness
Deterministic mobile flow
1.	Create ShiftSession with project time zone, device time and stable client ID.
2.	Select planned workfaces; resolve current approved information and required control versions from local pack.
3.	Confirm supervisor, crew/roles and known availability; do not expose non-assigned personal details.
4.	Run deterministic readiness rules by workface: information, design, RAMS, permit/isolation, competence, access, material and inspection.
5.	Display Ready / Ready with Conditions / Not Ready with blocking reason, owner and next action.
6.	Capture briefing plan, unplanned work and initial evidence; require authorised decision for conditional readiness.
7.	Sync shift start and server revalidate effective-dated rules; any material rejection creates immediate Stop/Review action.
AI duties and human guardrails
•	Summarise missing prerequisites and cluster workfaces with common blockers.
•	Cannot authorise work, waive a permit, judge competence or convert Not Ready to Ready.
Outputs
•	ShiftSession
•	WorkfaceReadinessSnapshot
•	ReadinessDecision
•	BriefingTask
Exception controls
•	Stale control pack makes affected workface Unknown/Not Ready according to policy.
•	Offline conditional start is disabled for configured high-risk categories.
•	Server rule mismatch preserves local decision/evidence but stops affected work and requires reconciliation.
Events: SHIFT_STARTED | WORKFACE_READINESS_CALCULATED | CONDITIONAL_START_RECORDED | READINESS_REVALIDATION_FAILED
APIs:   POST /v1/projects/{id}/shift-sessions | POST /v1/workfaces/{id}/readiness-check | POST /v1/workfaces/{id}/start-decisions
Acceptance criteria
•	AC-X-03-01: Ready is computed from versioned prerequisites; it has no direct user-edit control.
•	AC-X-03-02: A start decision identifies exact workface, scope, time window, authority and conditions.
•	AC-X-03-03: Failed server revalidation cannot silently replace the field record or allow continued high-risk work.

---

X-WF-04 - Universal evidence capture: photo, video, audio, file and annotation
Primary owner: Any authorised field user  |  Trigger: User taps Capture or evidence is required inside a workflow
Offline behaviour: Yes; originals and metadata queue locally under encrypted storage
Required inputs
•	Project/package/location/workflow context
•	camera/microphone/file permission
•	capture purpose and sensitivity
•	optional asset/workface/record link
Deterministic mobile flow
1.	Open capture with inherited context; user confirms project, package, location and evidence purpose.
2.	Capture original media without destructive overlay; store annotations/crops/redactions as derivative instructions.
3.	Record client ID, device time/offset, capture source, orientation, dimensions/duration and available location accuracy.
4.	Calculate SHA-256 locally, encrypt file, create thumbnail/waveform and durable EvidenceDraft.
5.	Require description/category where the workflow cannot infer a controlled purpose.
6.	Run local safety checks for file type, size and malware-signature metadata; server performs authoritative scan.
7.	Queue metadata before resumable binary upload; link evidence only after hash/receipt confirmation, while retaining visible Pending state.
AI duties and human guardrails
•	On device or server, propose description, tags, OCR objects and duplicate candidates with confidence.
•	Never fabricate capture time/location, alter original pixels, or treat visual anomaly as confirmed quality/safety finding.
Outputs
•	EvidenceItem
•	EvidenceDerivative
•	UploadSession
•	EvidenceLink
Exception controls
•	Denied permission offers file picker/manual note where permitted; required camera evidence remains blocker.
•	Low-storage failure preserves form draft and prompts cleanup without losing other queued records.
•	Duplicate hash proposes reuse only if scope and sensitivity allow; original record linkage remains auditable.
Events: EVIDENCE_CAPTURED | EVIDENCE_UPLOAD_STARTED | EVIDENCE_SCANNED | EVIDENCE_LINKED | EVIDENCE_REJECTED
APIs:   POST /v1/evidence | POST /v1/evidence/{id}/upload-sessions | POST /v1/evidence/{id}/complete | POST /v1/entities/{type}/{id}/evidence-links
Acceptance criteria
•	AC-X-04-01: Original hash, bytes and capture metadata remain immutable after submission.
•	AC-X-04-02: Form submission cannot claim Complete when required evidence upload lacks server receipt.
•	AC-X-04-03: Every derivative links to original plus transformation instructions and author/tool version.

---

X-WF-05 - Voice-first structured entry and transcription review
Primary owner: Any authorised field user  |  Trigger: Voice capture inside diary, issue, meeting, inspection or test workflow
Offline behaviour: Recording and local draft yes; transcription may run on-device or queue for approved provider
Required inputs
•	Workflow context and target form sections
•	recording consent requirement
•	language/locale and terminology pack
•	microphone permission and maximum duration
Deterministic mobile flow
1.	Display recording indicator, elapsed time, pause/resume and applicable consent notice.
2.	Record in recoverable segments so app kill or call interruption loses at most active segment.
3.	Create AudioEvidence with timestamps and optional user-inserted section markers.
4.	Transcribe on-device where supported/policy permits; otherwise queue encrypted provider request after data-scope confirmation.
5.	Map proposed statements into structured form fields while retaining transcript and audio time anchors.
6.	Highlight low-confidence names, numbers, units, negations and safety/commercial terms for mandatory review.
7.	User edits and confirms structured fields; acceptance records transcript/model version, changes and disposition.
AI duties and human guardrails
•	Transcribe, translate where configured, classify sections, extract candidate actions/quantities/issues and detect contradictions.
•	Cannot submit unreviewed safety, quantity, instruction, incident or test fields as authoritative.
Outputs
•	AudioEvidence
•	TranscriptRevision
•	ExtractionCandidate
•	AIExecution
•	UserDisposition
Exception controls
•	Provider timeout preserves audio and queues retry; user can complete manually.
•	Overlapping speakers or high noise lowers confidence and suppresses automatic field mapping.
•	Recording without required consent is blocked or limited to user-authored text according to jurisdiction policy.
Events: VOICE_CAPTURE_STARTED | AUDIO_SEGMENT_SAVED | TRANSCRIPTION_COMPLETED | EXTRACTION_REVIEWED
APIs:   POST /v1/audio-evidence | POST /v1/ai/transcriptions:estimate | POST /v1/ai/transcriptions | POST /v1/extractions/{id}:decide
Acceptance criteria
•	AC-X-05-01: Process termination and relaunch recover every completed audio segment and linked draft.
•	AC-X-05-02: Accepted structured values retain audio time anchors and user edits.
•	AC-X-05-03: Low-confidence numeric/unit/negation tokens must be visibly confirmed before material submission.

---

X-WF-06 - QR, barcode and NFC identification
Primary owner: Any authorised field user  |  Trigger: User scans an asset, location, document, permit, delivery or test instrument
Offline behaviour: Yes for identifiers contained in active pack; unknown identifiers queue lookup
Required inputs
•	Scan mode/purpose
•	camera or NFC permission
•	authorised local identifier index
•	manual-entry fallback and check-digit rules
Deterministic mobile flow
1.	Open purpose-specific scanner with torch, zoom and accessible manual entry.
2.	Decode QR/Data Matrix/Code 128/EAN or NFC payload without executing embedded URL/code.
3.	Normalise identifier and validate namespace, check digit, tenant/project scope and payload signature where used.
4.	Resolve against local pack; display exact entity type, status, location, owner and last sync.
5.	Require user confirmation when scan could link evidence, transfer custody, record attendance or select test instrument.
6.	Unknown or duplicate identifiers create a controlled exception, not a new asset automatically.
7.	Record scan event, source, result and workflow action; server revalidates on sync.
AI duties and human guardrails
•	May suggest likely entity from nearby workface and visual label OCR.
•	Cannot manufacture an asset, location, permit or identity from an untrusted code.
Outputs
•	ScanRecord
•	IdentifierResolution
•	EntityLink
•	IdentifierException
Exception controls
•	Damaged label supports manual entry plus photo evidence and replacement-label action.
•	Cross-project code shows Not Authorised without leaking entity details.
•	Two assets with same tag/serial block reconciliation and assign data-quality owner.
Events: IDENTIFIER_SCANNED | IDENTIFIER_RESOLVED | IDENTIFIER_NOT_FOUND | DUPLICATE_IDENTIFIER_DETECTED
APIs:   POST /v1/mobile/scans | GET /v1/mobile/identifiers/{namespace}/{value} | POST /v1/identifier-exceptions
Acceptance criteria
•	AC-X-06-01: Embedded scan payload cannot execute arbitrary deep link or script.
•	AC-X-06-02: Scan-based action shows resolved entity/version before commit.
•	AC-X-06-03: Duplicate or out-of-scope identifier never auto-creates or discloses a record.

---

X-WF-07 - Geolocation, site zones and chainage/grid positioning
Primary owner: Field user  |  Trigger: Record needs a physical location or user opens site map
Offline behaviour: Yes with downloaded map/zone data; coordinates and accuracy sync later
Required inputs
•	Project coordinate reference system and site boundary
•	zone/location hierarchy and offline map tiles
•	device GNSS/compass permissions
•	manual grid/chainage/room alternatives
Deterministic mobile flow
1.	Request location only at point of need; explain purpose and precision requirement.
2.	Capture WGS84 coordinate, altitude where available, horizontal/vertical accuracy, provider and sample time.
3.	Transform to project grid only with versioned server/offline transformation; retain raw coordinate.
4.	Resolve contained/nearest zone and display uncertainty; never silently snap across boundary.
5.	Allow map pin, scan of location tag or hierarchical manual selection with source recorded.
6.	Validate workface/asset scope and any exclusion/no-capture area before save.
7.	Store location as evidence metadata and domain link; update only by explicit corrected-location record.
AI duties and human guardrails
•	Suggest location from scanned asset, recent workface or spatial containment with confidence.
•	Cannot claim survey-grade accuracy or infer a precise location from weak signal.
Outputs
•	GeoObservation
•	ProjectCoordinate
•	LocationLink
•	LocationCorrection
Exception controls
•	Accuracy worse than workflow threshold requires manual confirmation or blocks precision-critical record.
•	No GPS indoors falls back to tag/manual selection; state remains visible.
•	Location permission denial does not block non-location workflows unless location is a configured mandatory control.
Events: GEO_OBSERVATION_RECORDED | LOCATION_RESOLVED | LOCATION_ACCURACY_INSUFFICIENT | LOCATION_CORRECTED
APIs:   GET /v1/projects/{id}/spatial-pack | POST /v1/geo-observations | POST /v1/entities/{type}/{id}/location-links
Acceptance criteria
•	AC-X-07-01: Stored position includes source, accuracy, time and coordinate-system version.
•	AC-X-07-02: Manual/snap corrections never overwrite raw device coordinates.
•	AC-X-07-03: App does not label a coordinate as exact when accuracy exceeds configured tolerance.

---

X-WF-08 - Outbox sync, attachment transfer and deterministic conflict handling
Primary owner: Mobile app sync engine + record owner  |  Trigger: Connectivity returns, background window, pull-to-sync or critical submit
Offline behaviour: Core offline capability
Required inputs
•	Encrypted local outbox/inbox
•	stable UUID and idempotency key
•	baseVersion/expectedVersion
•	dependency graph and attachment hashes
•	network/battery/user policy
Deterministic mobile flow
1.	Persist every command locally in one transaction with its entity draft and dependency references.
2.	Order sends by dependency: metadata/entities, evidence metadata, binaries, links, then submit/decision commands.
3.	Batch small commands and use resumable chunk upload for media; expose per-item progress.
4.	Server authenticates current membership/device, applies idempotency and expected-version checks, and returns durable receipt/event IDs.
5.	Inbox applies ordered deltas by project stream version; never replaces local pending draft blindly.
6.	Auto-merge append-only items and non-overlapping draft scalar edits; create Conflict for competing material fields or approved-record edits.
7.	User resolves with Mine / Server / Merge / Create Amendment where policy permits; record rationale and both versions.
8.	Mark Synced only after durable receipt and linked attachment completeness; compact outbox without deleting audit metadata.
AI duties and human guardrails
•	Explain conflict differences and suggest safe merge for narrative drafts.
•	AI cannot choose a material value, approval, safety result, quantity or test reading.
Outputs
•	OutboxCommand
•	SyncReceipt
•	InboxDelta
•	ConflictRecord
•	AttachmentTransfer
Exception controls
•	401/403 quarantines unsent scope and prompts re-auth; it does not leak data or retry forever.
•	409 returns current server version and permitted resolution commands.
•	Deleted/superseded server parent converts child draft to orphan-review state with preserved evidence.
•	Clock drift affects metadata warning, never command ordering or evidence bytes.
Events: SYNC_BATCH_SENT | SYNC_COMMAND_ACCEPTED | SYNC_CONFLICT_CREATED | SYNC_CONFLICT_RESOLVED | ATTACHMENT_UPLOAD_COMPLETED
APIs:   POST /v1/mobile/sync/commands | GET /v1/mobile/sync/deltas | POST /v1/mobile/conflicts/{id}:resolve | PUT /v1/upload-sessions/{id}/parts/{part}
Acceptance criteria
•	AC-X-08-01: Replaying the same batch after timeout produces one business result.
•	AC-X-08-02: Two-device edits preserve both submitted values and require deterministic material-field resolution.
•	AC-X-08-03: A record cannot display Synced while any mandatory dependent attachment lacks durable server receipt.

---

X-WF-09 - Action inbox, push notifications and acknowledgement
Primary owner: Assigned mobile user  |  Trigger: Domain event assigns or changes a required action
Offline behaviour: Downloaded actions remain usable; new pushes require network
Required inputs
•	Notification policy and user quiet hours
•	action type, priority, due date and recipient resolution
•	sensitivity-safe push template
•	deep-link target and required pack entity
Deterministic mobile flow
1.	Server creates Action with stable ID, accountable owner, due date, priority, source entity and permitted commands.
2.	Push payload contains no sensitive narrative; installation resolves content after authenticated fetch.
3.	Device groups actions into Safety, Quality, Work, Commissioning, Handover, Reviews, Conflicts and Sync.
4.	Badge counts only open actionable records, not FYI notifications.
5.	Deep link validates tenant/project/role and local availability; fetches missing entity or shows offline-unavailable state.
6.	Acknowledgement records seen time but does not equal acceptance, completion, briefing attendance or instruction receipt unless workflow says so.
7.	Complete/return/escalate updates source workflow and all projections; stale notification becomes resolved with reason.
AI duties and human guardrails
•	Summarise a queue and suggest priority from configured rules and impacts.
•	Cannot suppress statutory/safety escalation or change contractual due dates.
Outputs
•	Action
•	Notification
•	Acknowledgement
•	Escalation
Exception controls
•	Duplicate pushes collapse by Action ID.
•	Revoked/out-of-scope action deep link shows access changed without cached sensitive detail.
•	Expired due date remains overdue until explicit disposition; it never disappears from queue.
Events: ACTION_ASSIGNED | NOTIFICATION_SENT | ACTION_ACKNOWLEDGED | ACTION_COMPLETED | ACTION_ESCALATED
APIs:   GET /v1/mobile/actions | POST /v1/actions/{id}:acknowledge | POST /v1/actions/{id}:complete | POST /v1/mobile/push-tokens
Acceptance criteria
•	AC-X-09-01: Push preview exposes no restricted narrative, person or commercial value.
•	AC-X-09-02: Badge count reconciles to open Action records after multi-device use.
•	AC-X-09-03: Seen, acknowledged, accepted and completed remain distinct timestamps/states.

---

X-WF-10 - Signature, witness, handover and receipt capture
Primary owner: Authorised signatory / witness  |  Trigger: Workflow requires attestation, approval, release, attendance or transfer receipt
Offline behaviour: Offline signature allowed only for configured objects with a valid signed policy pack; server acceptance pending
Required inputs
•	Exact object ID/version/hash
•	signatory identity, appointment and authority
•	intent statement and decision options
•	witness/recipient requirements
•	device/session/time and offline policy
Deterministic mobile flow
1.	Render full intent statement and exact record/version; link to readable underlying evidence.
2.	Re-authenticate with biometric/passcode/MFA according to signature risk tier.
3.	Signatory selects decision and any conditions; typed/drawn mark is presentation, identity comes from authenticated account.
4.	Capture server time or device time/offset when offline, appointment snapshot, device ID, policy version and object hash.
5.	Create append-only SignatureRecord and locally lock the signed version.
6.	Co-sign/witness routes to named independent party; signatures cannot be copied between versions.
7.	Server validates authority/effective dates and returns accepted/rejected receipt; rejection preserves signature attempt and reason.
AI duties and human guardrails
•	Explain missing signatories or conditions; draft condition text from selected findings.
•	Cannot impersonate, sign, reuse a signature image or decide acceptance.
Outputs
•	SignatureRecord
•	WitnessRecord
•	DecisionRecord
•	Receipt
Exception controls
•	Authority expired while offline yields Rejected-Pending-Correction, not valid acceptance.
•	Record change after first signature invalidates pending signatures and creates new version.
•	Shared device requires full user switch and re-authentication; previous signature credentials are inaccessible.
Events: SIGNATURE_REQUESTED | SIGNATURE_CAPTURED | SIGNATURE_ACCEPTED | SIGNATURE_REJECTED | WITNESS_COMPLETED
APIs:   POST /v1/signature-requests | POST /v1/signature-requests/{id}:sign | POST /v1/signatures/{id}:validate
Acceptance criteria
•	AC-X-10-01: Signature proves user, role/authority snapshot, intent, object hash/version and time source.
•	AC-X-10-02: Editing a signed object creates a new version and invalidates uncompleted signature requests.
•	AC-X-10-03: Offline signature never displays final Accepted until server authority validation succeeds.

---

X-WF-11 - Emergency, stop-work and critical escalation
Primary owner: Any user raises; authorised Site/HSE/Project Manager controls disposition  |  Trigger: Immediate danger, failed critical control, incident or authorised stop
Offline behaviour: Yes; emergency call/SMS options and local stop record do not depend on data sync
Required inputs
•	Project emergency plan and contacts
•	activity/workface/location
•	hazard/failed control and immediate facts
•	people affected and emergency-service status
•	evidence where safe
Deterministic mobile flow
1.	Persistent emergency action opens Call Emergency Services / Site Emergency Contact / Raise Stop Work without navigating long form.
2.	User confirms project/location/activity and selects immediate danger type; app prioritises human safety over capture.
3.	Create StopWorkRecord locally with high-priority sync, visible site banner and affected workface links.
4.	Notify configured command chain through push/SMS/email integrations; never rely on one channel.
5.	Authorised controller records isolation/containment, investigation owner and restart prerequisites.
6.	Affected workfaces remain Not Ready; assignments and successor tasks show stop reason without exposing restricted incident details.
7.	Restart requires named authority, verified controls, briefing/acknowledgements and a new ReadinessDecision; closing the incident alone does not restart work.
AI duties and human guardrails
•	May structure voice facts, locate emergency-plan content and identify affected linked workfaces.
•	Cannot decide emergency severity, contact emergency services autonomously, close incident or authorise restart.
Outputs
•	StopWorkRecord
•	CriticalAlert
•	ContainmentAction
•	RestartDecision
Exception controls
•	No connectivity uses native phone/SMS and queues encrypted record; display delivery uncertainty.
•	False/duplicate report is closed through disposition but remains auditable.
•	Restricted incident data is separated from widely visible stop-work status.
Events: STOP_WORK_RAISED | CRITICAL_ALERT_SENT | CONTAINMENT_RECORDED | RESTART_REQUESTED | WORK_RESTART_AUTHORISED
APIs:   POST /v1/projects/{id}/stop-work | POST /v1/stop-work/{id}/containment | POST /v1/stop-work/{id}:request-restart | POST /v1/stop-work/{id}:authorise-restart
Acceptance criteria
•	AC-X-11-01: Stop-work creation remains available offline and survives app/device process interruption.
•	AC-X-11-02: Restart cannot occur from incident closure, action completion or AI recommendation alone.
•	AC-X-11-03: General users see safe work restriction while restricted personal/incident details remain permission-filtered.

---

X-WF-12 - Shift close, completeness, supervisor review and amendment
Primary owner: Supervisor / Site Manager  |  Trigger: End of shift or configured reporting cut-off
Offline behaviour: Yes; submission queues and receives final server receipt later
Required inputs
•	ShiftSession and workfaces
•	daily timeline, labour/plant, deliveries and weather
•	progress claims and quantities
•	quality/HSE/issues/RFIs/change candidates
•	required photos and outstanding actions
Deterministic mobile flow
1.	Assemble shift summary from canonical records already captured; do not make user re-enter totals.
2.	Calculate completeness by configured mandatory record/evidence weights and disclose missing/stale/pending-sync items.
3.	Show claimed vs verified progress, unplanned work, lost time, blockers and next-shift handoff.
4.	Supervisor reviews source cards, resolves duplicates and assigns missing record owners.
5.	Generate narrative draft with source links; user edits and signs accuracy declaration.
6.	Submit immutable ShiftPack with cut-off snapshot, pending-upload disclosures and server-validation requirement.
7.	Server validates record versions, creates receipt and downstream programme/commercial/HSE/quality projections.
8.	Late correction creates ShiftAmendment referencing original, reason, changed fields and authorisation.
AI duties and human guardrails
•	Draft concise diary narrative, detect contradictory hours/quantities/events and identify likely missing sections.
•	Cannot invent lost time, quantity, incident, instruction, weather or cause; user confirms every material statement.
Outputs
•	ShiftPack
•	DailyReport
•	CompletenessResult
•	ShiftAmendment
•	NextShiftHandoff
Exception controls
•	Critical unsynced evidence may allow Submit-Pending-Upload only if configured; UI cannot call it Complete.
•	Cross-midnight shift uses explicit start/end and project time zone.
•	Supervisor rejection returns owned actions without deleting submitted evidence.
Events: SHIFT_CLOSE_STARTED | SHIFT_PACK_SUBMITTED | SHIFT_PACK_ACCEPTED | SHIFT_PACK_RETURNED | SHIFT_AMENDED
APIs:   GET /v1/shift-sessions/{id}/close-preview | POST /v1/shift-sessions/{id}:submit | POST /v1/shift-packs/{id}:review | POST /v1/shift-packs/{id}/amendments
Acceptance criteria
•	AC-X-12-01: Shift totals reconcile to linked source records and expose pending/unsynced status.
•	AC-X-12-02: Submitted report is immutable; corrections are versioned amendments.
•	AC-X-12-03: Generated narrative retains source links and cannot include unsupported material statements.

---

7. Concept field module
Stage field outcome: Capture defensible site reality, constraints and stakeholder evidence for feasibility without turning the app into the business-case approval workspace.
Control	Requirement
Entry condition	Project shell, preliminary boundary, sponsor/field appointments and concept field checklist available.
Exit condition	Site evidence, constraints, walkovers and option-relevant observations submitted with review status and immutable source links.
Mobile home indicators	Site walkovers due; Survey coverage; Open constraints/unknowns; Stakeholder evidence pending; Option evidence gaps; Unsynced media
Web-only controls	Concept baseline approval; option scoring/final selection; budget/cashflow approval; procurement strategy approval; planning/legal determination

---

7.1 Module workspace
•	Route group: /projects/{projectId}/work/concept; visible only when appointment/module policy permits.
•	Header: stage, project, package/location/system context, pack freshness, unsynced count and current shift.
•	Tabs: Action Queue, Capture, Plans/Criteria, Records, Evidence, History. Stage-specific screens appear as typed child routes.
•	Every list supports status, owner, location/package/system, due date, offline state and deterministic saved filters.
7.2 Workflow specifications
C-MOB-WF-01 - Site walkover plan, attendance and route capture
Primary owner: Project Manager / Field Engineer  |  Trigger: Authorised site visit
Offline behaviour: Full capture offline after project pack download
Required inputs
•	Visit purpose, boundary and access conditions
•	attendees/organisations and site host
•	planned route/checkpoints
•	PPE, inductions and known hazards
•	survey/observation checklist
Deterministic mobile flow
1.	Create visit record with date/time window, meeting point and emergency details.
2.	Confirm attendee identity/role and required induction; external visitors receive time-limited QR where configured.
3.	Download route, boundary, checklists and reference plans before loss of connectivity.
4.	At start, record access granted, weather, site condition and any route exclusion.
5.	Track user-confirmed checkpoints; location sampling is purposeful, not continuous employee surveillance.
6.	Capture observations against checkpoint/zone with evidence and severity/unknown classification.
7.	Close visit with coverage map, skipped checkpoints/reasons, follow-up actions and host acknowledgement.
AI duties and human guardrails
•	Suggest missed checklist areas and group observations by constraint theme.
•	Cannot determine legal boundary, contamination, planning status or site safety from photos alone.
Outputs
•	SiteVisit
•	VisitAttendance
•	RouteTrace
•	CheckpointObservation
•	VisitAction
Exception controls
•	Denied access records failed visit without inventing site condition.
•	Weak GPS uses map pin/checkpoint scan and records source.
•	Visitor refusal/absence remains explicit and routes action.
Events: SITE_VISIT_STARTED | CHECKPOINT_RECORDED | SITE_VISIT_COMPLETED
APIs:   POST /v1/projects/{id}/site-visits | POST /v1/site-visits/{id}/checkpoints | POST /v1/site-visits/{id}:complete
Acceptance criteria
•	AC-CM-01-01: Coverage distinguishes visited, inaccessible and not-planned areas.
•	AC-CM-01-02: Each observation links to checkpoint/zone, time, author and evidence status.
•	AC-CM-01-03: Route collection stops at visit close and follows workforce privacy policy.

---

C-MOB-WF-02 - Site constraint and opportunity observation
Primary owner: Field Engineer / Discipline Lead  |  Trigger: Constraint or opportunity observed
Offline behaviour: Yes
Required inputs
•	Constraint taxonomy
•	location/boundary and affected option/package
•	observed fact vs reported information
•	source/evidence and confidence
•	potential impact categories
Deterministic mobile flow
1.	Select category: access, utilities, topography, ground, contamination, ecology, heritage, neighbours, security, logistics, weather/flood, existing asset or opportunity.
2.	Record atomic observation using fact/cause/uncertainty wording; separate observed fact from interpretation.
3.	Locate by zone, point/line/area or asset and attach photographs/sketch/voice.
4.	Identify affected option, requirement, milestone or investigation without setting cost/time value.
5.	Assign verification method, competent owner and required-by date.
6.	Classify Known / Assumed / Unknown / Superseded and reliability of source.
7.	Submit for discipline review; accepted constraint receives stable ID used by maps and option analysis.
AI duties and human guardrails
•	Extract labels/utility markings, propose taxonomy and detect duplicates/contradictions.
•	Cannot confirm service ownership, ground condition, statutory designation or quantified impact.
Outputs
•	ConstraintCandidate
•	Constraint
•	Opportunity
•	VerificationAction
Exception controls
•	Safety-critical unknown triggers immediate access/work restriction where configured.
•	Duplicate candidates may link but are never discarded before reviewer decision.
•	Photograph without reliable location remains usable with explicit location gap.
Events: CONSTRAINT_CANDIDATE_CREATED | CONSTRAINT_ACCEPTED | CONSTRAINT_VERIFICATION_ASSIGNED
APIs:   POST /v1/projects/{id}/constraint-candidates | POST /v1/constraint-candidates/{id}:decide | POST /v1/constraints/{id}/verification-actions
Acceptance criteria
•	AC-CM-02-01: Constraint preserves fact, interpretation, uncertainty and source as separate fields.
•	AC-CM-02-02: Accepted constraint has stable geometry/location and affected-object links.
•	AC-CM-02-03: AI-proposed category or duplicate match remains visible until human disposition.

---

C-MOB-WF-03 - Existing asset, utility and intrusive-survey field record
Primary owner: Surveyor / Field Engineer  |  Trigger: Survey activity or existing asset identified
Offline behaviour: Yes, with downloaded survey method and safety controls
Required inputs
•	Survey commission/method and coordinate system
•	equipment/instrument and calibration
•	coverage/point/asset identifiers
•	reading/sample/observation and unit
•	limitations, obstruction and safety controls
Deterministic mobile flow
1.	Scan/select survey task and verify method revision, permit and instrument calibration.
2.	Create observation/sample/asset point with raw reading, unit, coordinate and instrument/operator.
3.	Attach field sheet, photograph, sketch or instrument export without overwriting raw data.
4.	Record coverage, depth/level, confidence and any inaccessible/obstructed area.
5.	For samples, create chain-of-custody identifier, container, time, sampler and laboratory transfer status.
6.	Run local range/unit/duplicate checks; anomalous values remain and require confirmation, not deletion.
7.	Submit to survey review; approved survey dataset supersedes provisional observation but retains linkage.
AI duties and human guardrails
•	OCR instrument displays/forms and flag unit/range/coordinate anomalies.
•	Cannot certify survey accuracy, interpret laboratory result or authorise intrusive work.
Outputs
•	SurveyObservation
•	ExistingAssetCandidate
•	Sample
•	ChainOfCustody
•	CoverageGap
Exception controls
•	Expired calibration blocks configured reading acceptance.
•	Manual reading correction creates amended value with reason; raw captured value persists.
•	Unknown coordinate system prevents spatial overlay and creates blocking data-quality action.
Events: SURVEY_OBSERVATION_RECORDED | SAMPLE_CUSTODY_TRANSFERRED | SURVEY_DATASET_SUBMITTED
APIs:   POST /v1/survey-tasks/{id}/observations | POST /v1/samples | POST /v1/samples/{id}:transfer | POST /v1/survey-tasks/{id}:submit
Acceptance criteria
•	AC-CM-03-01: Every reading identifies instrument, calibration, operator, time, unit and location source.
•	AC-CM-03-02: Corrected values never replace original captured values.
•	AC-CM-03-03: Coverage gaps appear in concept readiness and cannot be hidden by document upload.

---

C-MOB-WF-04 - Stakeholder interview and operational requirement capture
Primary owner: Client Requirements Lead / Project Manager  |  Trigger: Site stakeholder session or operational walk-through
Offline behaviour: Audio/text capture offline; AI processing may queue
Required inputs
•	Stakeholder identity/role and consent
•	session purpose and question set
•	facility/process/location context
•	existing requirement/assumption references
•	recording and confidentiality rules
Deterministic mobile flow
1.	Create session and record attendees, authority, consent and sensitive-topic restrictions.
2.	Capture voice notes, photographs and observations by topic/location while retaining time anchors.
3.	Mark each statement as Need, Constraint, Preference, Existing Condition, Risk, Decision or Open Question candidate.
4.	Draft atomic requirement candidates with source speaker/time, measurable outcome and verification idea.
5.	Review candidates with stakeholder; Accepted-in-Session means accurately captured, not concept baseline approval.
6.	Assign clarification owner/due date for contradictions, non-measurable or unauthorised statements.
7.	Submit session pack and link accepted candidates into desktop requirements review queue.
AI duties and human guardrails
•	Transcribe, translate where configured, decompose statements and identify conflicts/ambiguity.
•	Cannot attribute a statement to the wrong speaker, accept requirement baseline or expose confidential interview content.
Outputs
•	StakeholderSession
•	RequirementCandidate
•	DecisionCandidate
•	ClarificationAction
Exception controls
•	No recording consent falls back to reviewed notes.
•	Disputed transcript retains versions and participant comment.
•	Unauthorised requested scope is recorded as candidate with authority gap.
Events: STAKEHOLDER_SESSION_RECORDED | REQUIREMENT_CANDIDATE_CREATED | SESSION_PACK_SUBMITTED
APIs:   POST /v1/projects/{id}/stakeholder-sessions | POST /v1/stakeholder-sessions/{id}/requirement-candidates | POST /v1/stakeholder-sessions/{id}:submit
Acceptance criteria
•	AC-CM-04-01: Every requirement candidate links to source speaker/note/time and session version.
•	AC-CM-04-02: Session acceptance cannot be mistaken for project requirement approval.
•	AC-CM-04-03: Restricted content is excluded from users without stakeholder-session permission.

---

C-MOB-WF-05 - Feasibility option field comparison and evidence gap closure
Primary owner: Project Director / Design Lead  |  Trigger: Options require field validation
Offline behaviour: Yes for downloaded option cards and assigned checks
Required inputs
•	Option IDs and field-verifiable criteria
•	site constraints/opportunities
•	required viewpoints/measurements/checks
•	assumptions and evidence gaps
•	visit assignment and due date
Deterministic mobile flow
1.	Download immutable option cards showing only field-relevant differences and assumptions.
2.	Select option/checkpoint and capture evidence using the same criterion definitions across options.
3.	Record Pass / Concern / Not Observed / Not Applicable with reason; do not create overall option score.
4.	Measure/capture access, clearance, proximity, interface or operational condition with stated method/tolerance.
5.	Link new constraint/opportunity and show which options may be affected.
6.	Complete missing-evidence checklist and sign field-observation accuracy declaration.
7.	Submit comparison delta to desktop option analysis; later option selection never alters captured field evidence.
AI duties and human guardrails
•	Compare evidence coverage and highlight contradictions between option assumptions and field facts.
•	Cannot recommend or select the option without authorised multi-domain decision process.
Outputs
•	OptionFieldCheck
•	CriterionObservation
•	OptionEvidenceGap
•	ComparisonDelta
Exception controls
•	Changed option definition invalidates only affected checks and requests reassessment.
•	Non-comparable field methods are flagged rather than numerically combined.
•	Inaccessible area remains Not Observed with action; it is not treated as Pass.
Events: OPTION_FIELD_CHECK_STARTED | OPTION_ASSUMPTION_CHALLENGED | OPTION_FIELD_CHECK_SUBMITTED
APIs:   GET /v1/projects/{id}/mobile/option-cards | POST /v1/options/{id}/field-checks | POST /v1/option-field-checks/{id}:submit
Acceptance criteria
•	AC-CM-05-01: Field statuses never roll up into a hidden or mobile-created option score.
•	AC-CM-05-02: Option revision identifies exactly which observations need revalidation.
•	AC-CM-05-03: Not Observed and Not Applicable require different reasons and remain distinct.

---

7.3 Stage mobile Definition of Done
•	Every workflow has positive, denied, offline, interrupted-upload, conflict, supersession and revoked-access acceptance tests.
•	UI, local entity, outbox command, API policy, event, notification, audit and dashboard projection ship together.
•	Current information/criteria/rules and effective authority are visible at the decision point.
•	Submitted evidence and raw values are immutable; correction routes are versioned and verified.
•	Mobile outputs reconcile with web projections without duplicate re-entry or a second source of truth.

---

8. Design field module
Stage field outcome: Give site users current controlled design information and capture constructability, query, mock-up and as-built evidence without publishing design from the app.
Control	Requirement
Entry condition	Concept baseline approved; design packages, responsibility, CDE states and site-review appointments available.
Exit condition	Field design reviews, queries, mock-up evidence and installed-condition feedback submitted against exact revisions and accountable parties.
Mobile home indicators	Current-information health; Site reviews due; Open RFIs/queries; Field variances; Mock-ups/samples; Affected workfaces; As-built checks
Web-only controls	Author/publish design containers; approve design baseline; federated model management; formal design change approval; design cost/programme acceptance

---

8.1 Module workspace
•	Route group: /projects/{projectId}/work/design; visible only when appointment/module policy permits.
•	Header: stage, project, package/location/system context, pack freshness, unsynced count and current shift.
•	Tabs: Action Queue, Capture, Plans/Criteria, Records, Evidence, History. Stage-specific screens appear as typed child routes.
•	Every list supports status, owner, location/package/system, due date, offline state and deterministic saved filters.
8.2 Workflow specifications
D-MOB-WF-01 - Controlled drawing, model and specification access
Primary owner: Information Manager / Field user  |  Trigger: User opens Plans or a workface information link
Offline behaviour: Downloaded derivative available offline within pack scope
Required inputs
•	Information container/revision/status/suitability
•	package/location/workface applicability
•	device derivative and original hash
•	supersession/receipt policy
Deterministic mobile flow
1.	Resolve current applicable revision from workface/package rather than filename search alone.
2.	Show revision, status, suitability, publisher, accepted date, last sync and offline state in persistent header.
3.	Render optimised PDF/2D/3D derivative; original remains in controlled CDE.
4.	Support pan/zoom/layers, calibrated measure where configured, bookmarks and location pins.
5.	Acknowledge issued information where contract/project protocol requires; receipt is separate from acceptance.
6.	On supersession, prevent old revision as current default and identify downloaded replacement.
7.	Log access/acknowledgement without tracking unrelated viewing behaviour.
AI duties and human guardrails
•	Search sheets/objects/specification clauses and explain revision delta with source anchors.
•	Cannot mark WIP/shared content approved, publish a markup or guarantee measurement accuracy.
Outputs
•	MobileInformationDerivative
•	InformationReceipt
•	RevisionAccess
•	SupersessionNotice
Exception controls
•	Offline stale revision displays red persistent banner and may block workface start.
•	Missing derivative offers request/download action, not blank viewer.
•	Cross-package restricted information remains inaccessible even through deep link.
Events: INFORMATION_OPENED | INFORMATION_ACKNOWLEDGED | SUPERSESSION_NOTICE_DELIVERED
APIs:   GET /v1/workfaces/{id}/applicable-information | GET /v1/information-containers/{id}/mobile-derivative | POST /v1/information-revisions/{id}:acknowledge
Acceptance criteria
•	AC-DM-01-01: Viewer always shows current revision metadata and offline freshness.
•	AC-DM-01-02: Superseded information cannot be used to create a new inspection/progress claim without explicit exception.
•	AC-DM-01-03: Search result opens an exact document/object/section version, not an unversioned file.

---

D-MOB-WF-02 - Site design review and constructability walkdown
Primary owner: Design Manager / Site Manager  |  Trigger: Design package reaches configured site-review milestone
Offline behaviour: Yes
Required inputs
•	Design package/revisions
•	review route, zones and interfaces
•	constructability/maintainability/safety checklist
•	known clashes/queries/constraints
•	attendees and authority
Deterministic mobile flow
1.	Create walkdown with scope, route, design revisions and required disciplines.
2.	At each checkpoint, confirm observed existing condition and review criterion.
3.	Record finding as Acceptable, Concern, Query, Change Candidate or Not Reviewed with exact location/object.
4.	Capture markup and evidence; link to design risk, constraint, interface and workface where relevant.
5.	Assign owner and response-by date based on design responsibility matrix.
6.	Review findings with attendees and record dissent/conditions.
7.	Submit walkdown report; findings enter controlled design review/RFI/change routes and cannot directly modify design.
AI duties and human guardrails
•	Cluster recurring findings, identify likely affected objects and propose concise query wording.
•	Cannot close a design risk, resolve a clash or approve buildability.
Outputs
•	DesignWalkdown
•	ConstructabilityFinding
•	InterfaceFinding
•	WalkdownDecision
Exception controls
•	Changed design revision after walkdown marks affected findings Revalidation Required.
•	Area not visited remains incomplete and cannot inherit nearby acceptance.
•	Safety-critical finding prompts stop/review while awaiting designer response.
Events: DESIGN_WALKDOWN_STARTED | CONSTRUCTABILITY_FINDING_RAISED | DESIGN_WALKDOWN_SUBMITTED
APIs:   POST /v1/design-packages/{id}/walkdowns | POST /v1/design-walkdowns/{id}/findings | POST /v1/design-walkdowns/{id}:submit
Acceptance criteria
•	AC-DM-02-01: Every finding identifies exact reviewed revision and location/object.
•	AC-DM-02-02: Walkdown conclusion does not alter published design state.
•	AC-DM-02-03: Revision change creates visible revalidation scope and affected workface alert.

---

D-MOB-WF-03 - Drawing/model markup and field pin
Primary owner: Field Engineer / Designer  |  Trigger: User identifies a question, variance or coordination point
Offline behaviour: Yes on downloaded derivative
Required inputs
•	Exact drawing sheet/model object/revision
•	viewport, scale/coordinate and location
•	markup type and narrative
•	affected discipline/package/workface
Deterministic mobile flow
1.	Open markup from controlled viewer and freeze exact source revision/viewport.
2.	Add pin, cloud, line, arrow, dimension, text or photo link as non-destructive overlay.
3.	For model, store object GUIDs and camera state; for drawing, store sheet coordinate and calibrated scale version.
4.	Classify intent: comment, query, potential variance, as-built note, design-risk observation or redline candidate.
5.	Validate required context and affected parties before save.
6.	Create immutable markup revision; edits supersede prior markup, not source design.
7.	Submit into selected RFI/review/as-built workflow and notify only affected recipients.
AI duties and human guardrails
•	Suggest title, disciplines, object matches and duplicate open issues.
•	Cannot convert field markup into issued design or as-built without authorised verification/publish route.
Outputs
•	MarkupRevision
•	DrawingPin
•	ModelPin
•	AffectedPartyLink
Exception controls
•	Uncalibrated scale disables authoritative dimension label.
•	Missing model object retains viewport/location and marks object link unresolved.
•	Source revision supersession preserves markup and opens impact review.
Events: MARKUP_CREATED | MARKUP_SUBMITTED | MARKUP_SOURCE_SUPERSEDED
APIs:   POST /v1/information-revisions/{id}/markups | POST /v1/markups/{id}:submit | POST /v1/markups/{id}/superseding-revisions
Acceptance criteria
•	AC-DM-03-01: Markup reopens to the same source revision and viewport/object coordinates.
•	AC-DM-03-02: Source drawing/model bytes remain unchanged.
•	AC-DM-03-03: Measurements disclose calibration/source and cannot appear authoritative when uncalibrated.

---

D-MOB-WF-04 - RFI, design query and controlled response receipt
Primary owner: Field Engineer / Design Manager  |  Trigger: Ambiguity, conflict, missing information or technical decision need
Offline behaviour: Raise/acknowledge offline; response retrieval requires sync
Required inputs
•	Question and exact source references
•	location/workface/package
•	required-by date derived from activity/procurement need
•	proposed response/options
•	safety/quality/commercial/programme impact
Deterministic mobile flow
1.	Create RFI candidate from markup/workface and require one clear question.
2.	Link exact drawing/model/specification/requirement versions and evidence.
3.	Capture required-by date and impact statement; contract due date is server-calculated after route validation.
4.	AI may draft concise query; user confirms facts and recipients.
5.	Submit to controlled RFI workflow and display status/owner/clock.
6.	On response, require user acknowledgement and show response authority, conditions and attachments.
7.	Create implementation/verification tasks and flag design/change route when response changes controlled information.
8.	Close only when affected workface information is updated or authorised exception records why not.
AI duties and human guardrails
•	Draft query from markup and retrieve probable source clauses/drawings.
•	Cannot present draft/generated response as designer instruction or decide that implementation is complete.
Outputs
•	RFI
•	TechnicalResponse
•	InformationAction
•	ImplementationTask
Exception controls
•	Verbal direction records UnconfirmedDirection and chases formal response.
•	Late response escalates by configured calendar without inventing entitlement.
•	Superseded source triggers response impact review before use.
Events: RFI_DRAFTED | RFI_SUBMITTED | TECHNICAL_RESPONSE_ISSUED | RFI_IMPLEMENTATION_VERIFIED
APIs:   POST /v1/projects/{id}/rfis | POST /v1/rfis/{id}:submit | POST /v1/rfis/{id}:acknowledge | POST /v1/rfis/{id}:verify-implementation
Acceptance criteria
•	AC-DM-04-01: RFI question, source revisions, need-by basis and impacts are auditable.
•	AC-DM-04-02: A response that changes design creates controlled downstream information action.
•	AC-DM-04-03: Closure verifies affected information/workface, not just receipt of reply.

---

D-MOB-WF-05 - Sample, product and mock-up inspection
Primary owner: Design Manager / Quality Manager  |  Trigger: Sample/mock-up reaches inspection point
Offline behaviour: Yes
Required inputs
•	Submittal/sample/mock-up ID and revision
•	acceptance criteria and reference design
•	manufacturer/product data
•	location and inspection parties
•	evidence/witness requirements
Deterministic mobile flow
1.	Scan/select controlled sample or mock-up and verify current submittal/criteria.
2.	Record physical condition, dimensions/finish/interfaces/performance observations by criterion.
3.	Capture colour-controlled photography only with calibration card/process where colour is material.
4.	Record Pass, Conditional, Reject or Not Assessed per criterion with comments/evidence.
5.	Capture designer/client/quality witness decisions within appointment limits.
6.	Generate defects/actions and replacement/resubmission need; accepted sample receives durable reference ID.
7.	Link accepted reference to procurement/workface inspection controls without turning it into a design revision.
AI duties and human guardrails
•	Compare photos/criteria and identify missing manufacturer data or recurrent defects.
•	Cannot determine aesthetic acceptance, certify product compliance or replace authorised witnesses.
Outputs
•	SampleInspection
•	MockupInspection
•	CriterionResult
•	ReferenceSample
Exception controls
•	Material design/submittal revision invalidates prior acceptance where configured.
•	Partial/conditional acceptance identifies exact criteria and expiry/closure.
•	Damaged reference sample triggers preservation/replacement action.
Events: SAMPLE_INSPECTION_STARTED | SAMPLE_ACCEPTED | SAMPLE_REJECTED | REFERENCE_SAMPLE_CREATED
APIs:   POST /v1/submittals/{id}/field-inspections | POST /v1/sample-inspections/{id}:decide | POST /v1/reference-samples
Acceptance criteria
•	AC-DM-05-01: Decision references exact submittal, criteria, witnesses and evidence.
•	AC-DM-05-02: Conditional acceptance cannot appear as unconditional on workface card.
•	AC-DM-05-03: Later product/submittal revision triggers configured revalidation.

---

D-MOB-WF-06 - Installed condition and as-built design feedback
Primary owner: Field Engineer / Designer  |  Trigger: Work is installed, concealed or deviates from design intent
Offline behaviour: Yes
Required inputs
•	Installed location/asset/workface
•	approved design revision and implemented changes
•	survey/measurement/photo evidence
•	tolerance/verification criteria
•	concealment or inspection deadline
Deterministic mobile flow
1.	Open from workface/asset and resolve applicable approved design plus accepted changes.
2.	Capture installed condition using photo, scan, measurement, survey or model pin with method/accuracy.
3.	Compare against specified geometry/attribute/tolerance and record Match, Variance, Unknown or Not Verifiable.
4.	For variance, create NCR/RFI/change candidate according to type; do not label as-built accepted.
5.	Assign designer/information manager review before concealment where required.
6.	Designer/authorised verifier records disposition and required corrective/design/as-built action.
7.	Accepted installed condition creates AsBuiltCandidate linked to later controlled as-built publication.
AI duties and human guardrails
•	Highlight likely differences and missing tags/attributes from images/scans.
•	Cannot certify dimensional compliance, waive variance or publish as-built model/drawing.
Outputs
•	InstalledConditionObservation
•	DesignVariance
•	AsBuiltCandidate
•	VerificationDecision
Exception controls
•	Concealed before required verification creates evidence gap and escalation.
•	Tolerance method mismatch prevents automatic pass.
•	Later corrective work supersedes candidate and requires new verification.
Events: INSTALLED_CONDITION_CAPTURED | DESIGN_VARIANCE_RAISED | AS_BUILT_CANDIDATE_ACCEPTED
APIs:   POST /v1/workfaces/{id}/installed-condition-observations | POST /v1/design-variances | POST /v1/as-built-candidates/{id}:verify
Acceptance criteria
•	AC-DM-06-01: Comparison references exact design and accepted-change versions.
•	AC-DM-06-02: AsBuiltCandidate is visibly not a published as-built record.
•	AC-DM-06-03: Corrective work creates a new verification cycle while preserving original variance evidence.

---

8.3 Stage mobile Definition of Done
•	Every workflow has positive, denied, offline, interrupted-upload, conflict, supersession and revoked-access acceptance tests.
•	UI, local entity, outbox command, API policy, event, notification, audit and dashboard projection ship together.
•	Current information/criteria/rules and effective authority are visible at the decision point.
•	Submitted evidence and raw values are immutable; correction routes are versioned and verified.
•	Mobile outputs reconcile with web projections without duplicate re-entry or a second source of truth.
