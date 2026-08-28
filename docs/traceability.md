# Requirement traceability

> Requirement-by-requirement detail. For the short answer on what exists, read
> [`STATE.md`](STATE.md) first — it is the source of truth and this document is
> the long form of it.


Every requirement drawn from the CONSTRUX specification set, mapped to where it
lives in the build. Status is one of:

| Status | Meaning |
|---|---|
| **Built** | Implemented in code, covered by tests |
| **Partial** | Core implemented; a stated extension is not |
| **Design only** | Specified and designed for, but not implemented here |

The "Design only" rows are the honest part of this document. They are mostly
deployment topology and native mobile clients — real work that this build does
not pretend to have done.

---

## 1. Scope and coverage

| Requirement | Status | Where |
|---|---|---|
| One data model and one operating logic across all sectors | Built | `backend/src/domain/structure.ts` — `sectorType` is an attribute, never a separate code path |
| Building construction (residential, commercial, industrial, public) | Built | `SectorType.BUILDING`, WBS templates in `backend/src/engines/planning.ts` |
| Civil and infrastructure (transport, utilities, energy) | Built | `SectorType.INFRASTRUCTURE`, distinct WBS template; the seeded demo is a water treatment works |
| Specialised and operational (demolition, MEP, fit-out, FM, RM&I) | Built | `SectorType.SPECIALISED` template; FM and O&M covered by Engine G |
| No sector verticals, no duplicated logic | Built | One event catalogue, one permission matrix, one ledger for all sectors |
| Full lifecycle: concept → 30+ year O&M | Built | `backend/src/lifecycle/phases.ts`; demo traverses all seven phases |
| Data persists through handover without migration | Built | Handover and O&M write to the same ledger and project as tender did |

## 2. Golden Thread

| Requirement | Status | Where |
|---|---|---|
| Continuous, immutable, append-only lineage | Built | `backend/src/goldenthread/ledger.ts` |
| No destructive updates; all changes versioned | Built | Only `commit()` mutates; every commit increments `version` |
| No state change without a valid event | Built | Entity state is unreachable except through `commit()` |
| Event envelope with all mandated fields | Built | `backend/src/goldenthread/types.ts` |
| Canonical serialisation: sorted keys, no whitespace, array order preserved | Built | `backend/src/core/canonical.ts`, tested |
| Non-state fields stripped before hashing (audit, derived, transient) | Built | `stripNonState()`, tested |
| SHA-256 as `sha256:<lowercase hex>` | Built | `sha256()` |
| `beforeHash` / `afterHash` per event | Built | Set on commit, verified on replay |
| JSON Patch constrained to add/remove/replace | Built | `backend/src/core/jsonpatch.ts`, tested |
| Ordering remove → add → replace | Built | `orderPatch()`, tested |
| No wildcard paths, explicit array indices only | Built | `validatePatch()`, tested |
| Patch validated against entity schema before commit | Built | `assertValid()` in `commit()` after applying the patch |
| Event type catalogue is authoritative; unknown types rejected | Built | `backend/src/goldenthread/eventTypes.ts`, tested |
| `aiAllowed=false` + AI actor = hard failure | Built | Enforced in `commit()`, tested |
| `requiresEvidence=true` with no evidence = hard failure | Built | Enforced in `commit()`, tested |
| Correlation and causation ids | Built | On the envelope; AI writes carry the request id as causation |
| Chain hash detecting deletion and reordering | Built | Beyond the written spec; `chainHash`/`previousChainHash`, verified on replay |
| Exports branded with client identity | Built | `backend/src/export/exporter.ts` — refuses to export without branding |

## 3. Replay and audit

| Requirement | Status | Where |
|---|---|---|
| Deterministic replay from the event log | Built | `backend/src/goldenthread/replay.ts` |
| Ordering by (timestamp, eventId) | Built | `ledger.events()` |
| Per-event verification statuses | Built | `VERIFIED`, `FAILED_HASH`, `FAILED_SCHEMA`, `FAILED_PATCH`, `FAILED_CHAIN`, `FAILED_CATALOG`, `MISSING_EVIDENCE` |
| State materialisation keyed by (refType, refId) | Built | `replayProject()` |
| Project state root hash | Built | `stateRootHash()`, sorted by (refType, refId) |
| Replay report: root hash, verification summary, entity inventory, evidence index, redaction log, baselines in force | Built | `ReplayReport` |
| Tamper detection surfaces as a failure | Built | Demonstrated in `npm run demo`, tested |
| Timeline / range replay | Built | `replayTimeline()` |
| Evidence pack for court, regulator, insurer | Built | `claims.buildEvidencePack()` + `exports.auditExport()` with attestation |
| Audience-based redaction | Built | Regulator audience withholds commercial entities; root hash still covers the full record |
| PDF/JSON bundle export | Partial | Structured document model + HTML rendering built; PDF rendering is a downstream concern |

## 4. Seven AI engines

| Engine | Status | Where |
|---|---|---|
| A — Tender & Commercial Intelligence | Built | `backend/src/engines/tender.ts` |
| Vision-based 2D and BIM take-off | Partial | `runTakeoff()` governs, evidences and prices measured items and traces each to a sheet and revision. Quantities can be read off a held drawing by the `DRAWING_TAKEOFF` perception task and confirmed before they become BoQ items; that path is exercised against a stub, not a live provider, and is refused outright where no configured provider can be shown a file |
| Auto-generated BoQ with confidence per item | Built | `BOQITEM_CREATED_FROM_TAKEOFF` carries `confidenceScore` |
| Bottom-up estimating (labour, plant, material, prelims, O&P) | Built | `buildEstimate()` |
| Explicit risk pricing, not buried in a percentage | Built | `riskAllowanceMinor` is a distinct line |
| Live market pricing feeds | Design only | Rate library and index entities modelled; no external feed connected |
| Contract-aware risk pricing (JCT, NEC, FIDIC, IChemE, MF/1) | Built | `ContractSuite` union; clause extraction per suite |
| Baseline programme and cashflow generation | Built | `planning.approveBaseline()`, `cost.forecastCashflow()` |
| B — Planning & Delivery | Built | `backend/src/engines/planning.ts` |
| AI-generated CPM programmes | Built | `generateWBS()` proposes; a planner approves |
| Critical path probability forecasting | Built | PERT variance → `probabilityOnTime`, `p80DurationDays` |
| 4D BIM-linked scheduling | Partial | Twin states link to task ids; no 4D visualisation |
| Lookahead planning (Last Planner) | Partial | Lookahead and constraint entities in the catalogue; PPC metrics not computed |
| Delay likelihood modelling with recovery scenarios | Built | `forecastDelay()` + system-controlled corrective measures library |
| C — Resource & Cost Intelligence | Built | `backend/src/engines/cost.ts` |
| Earned value (EAC, ETC, CPI, SPI) | Built | `calculateEVM()` with three EAC scenarios and confidence |
| Live CVR connected to contract, commitments, variations, certificates | Built | `publishCVR()` |
| Margin erosion alerts | Built | CVR alerts |
| Cashflow S-curve | Built | `sCurveDistribution()` |
| Payment cycle with statutory notice dates | Built | `generatePaymentSchedule()`, `checkNoticeCompliance()` |
| Application → certification → payment notice → settlement | Built | `submitApplication()`, `certifyApplication()`, `postPayment()`; the applicant cannot certify |
| Withheld sums recorded with a reason | Built | `withheldMinor` and `reason` on every certificate |
| Commercial ledger bridge (committed / certified / paid, exception queue) | Built | `ledgerPosition()` |
| Trade-level labour productivity analytics | Partial | Productivity factor derived per task from earned vs elapsed; no trade-level rollup |
| D — Risk, Safety & Compliance | Built | `backend/src/engines/safety.ts` |
| Risk quantified in money and days | Built | `scoreRisk()` with residual position and mitigation net benefit |
| P80 contingency | Built | `contingencyRequirement()` |
| RAMS generation as a deterministic multi-step machine | Built | `draftRAMS()` against a hazard library, not freeform |
| Company + platform safety knowledge fusion | Built | Company library takes precedence over platform library |
| PPE / plant / competency schedules from RAMS | Built | Aggregated per RAMS |
| RAMS review, approval, acknowledgement | Built | Work cannot be briefed before approval |
| Predictive safety incident modelling | Built | `forecastSafety()` from leading indicators |
| Weather-driven hazard forecasting | Partial | Adverse weather days are an input; no weather feed connected |
| Competency and training register | Built | `recordCompetency()` |
| E — BIM & Digital Twin | Built | `backend/src/engines/bim.ts` |
| Drawing register with title-block structuring | Partial | `registerDrawing()` structures a title block from raw text, and the `TITLE_BLOCK` perception task reads one from the held drawing itself for a person to confirm. Verified against a stub, not a live provider; a deployment with no multimodal provider is refused rather than given an invented title block |
| Revision supersession engine | Built | Automatic; marking up a superseded drawing is refused |
| Markup → RFI / instruction conversion | Built | `addMarkup({ convertTo })` with auto-numbering |
| Model ingestion (IFC and others) | Partial | `ingestModel()` records the model, its hash, discipline, LOD and element count as a governed event; no IFC schema parser, no geometry hash, no model diffing |
| Clash detection with cost-aware triage | Built | `detectClashes()` weighted by discipline rework cost |
| Live twin fed by drones, IoT, site capture | Partial | `updateTwinFromSite()` and `ingestSensorReading()` reconcile observed against expected element status from structured input. Progress, PPE, plant and defects can be read from a site photograph through the perception pipeline and confirmed into their own registers; nothing feeds the twin from imagery directly |
| Automated as-built generation | Built | `generateAsBuilt()` reconciling captures against the model |
| ISO 19650 CDE | Partial | Revision control, status and supersession built; full CDE state model not |
| F — Contracts, Change & Claims | Built | `backend/src/engines/claims.ts` |
| Contract generation and interpretation | Built | `createContract()`, `extractContractIntelligence()` |
| Bid-to-contract conversion carrying qualifications | Built | `convertBidToContract()` |
| Obligation register with time bars | Built | `OBLIGATION_REGISTERED` with `timeBarDays` |
| Variation control matrix (origin, notice type, affected packages) | Built | `submitChangeRequest()` |
| Domestic variations from trade applications | Built | `flagDomesticVariation()` with early warning |
| Delay attribution with concurrency | Built | `attributeDelay()` — time but no money on concurrency |
| Claim probability / entitlement scoring | Built | `assessClaim()` on entitlement, causation, evidence, procedure |
| Evidence pack auto-generation | Built | `buildEvidencePack()` |
| Notices with time-bar checking | Built | `issueNotice()`; late notices are recorded, not hidden |
| G — Handover & O&M Intelligence | Built | `backend/src/engines/handover.ts` |
| Commissioning results and system acceptance | Built | Inconsistent PASS with out-of-tolerance readings is refused |
| Handover pack with completeness scoring | Built | `compileHandoverPack()` |
| Digital O&M manuals | Built | `publishOMManual()` |
| Asset register with lifecycle dates | Built | `registerAsset()` |
| Warranty and retention tracking | Built | `registerWarranty()`; defects check cover at the point of raising |
| Snagging with trade dispatch by cost code | Built | `raiseSnag()`, `dispatchSnags()` |
| Predictive maintenance scheduling | Built | `forecastMaintenance()`, reliability-adjusted |

## 5. Dual-AI architecture and control plane

| Requirement | Status | Where |
|---|---|---|
| Perception observes, reasoning decides | Built | `ROUTING_MATRIX` in `backend/src/ai/orchestrator.ts` |
| Provider abstraction, no vendor lock-in | Built | `AIProviderAdapter`; engines never import a vendor SDK |
| Task routing rules per engine | Built | Routing matrix |
| Cost tracking per provider | Built | ACU entries carry provider and engine |
| Failover switching | Built | `adapterFor()` falls back on an unhealthy adapter |
| AI execution permissions | Built | `AI_EXECUTION` capability with `X` permission code |
| Users never see tokens, compute metrics or model identifiers | Built | Only ACUs are exposed; model class stays in operator views |
| Structured output only; free text never becomes state | Built | Response schemas; unparseable output fails the execution |
| Local mode with no provider spend | Built | Deterministic adapters under `AI_MODE=local` |

## 6. Commercial enforcement

| Requirement | Status | Where |
|---|---|---|
| Fixed markup over provider cost, all customer categories | Built | `ACU_MARKUP_MULTIPLIER`, tested |
| Prepaid only, no negative balances | Built | `reserve()` throws before any provider call, tested |
| Atomic reserve → execute → persist → debit | Built | `runAI()` in `backend/src/engines/context.ts` |
| No debit without a Golden Thread write | Built | Settlement occurs only after commits succeed, tested |
| Automatic halt when credits expire | Built | `aiHalted`, tested |
| Per-engine cost attribution | Built | `attributionByModule()` |
| Attribution by tenant, project, user, feature | Built | ACU entry fields |
| Monthly / per-project / per-module caps | Built | `setCaps()`, tested |
| Alerts at 50 / 80 / 100 percent | Built | Once per threshold per month, tested |
| Volume incentive bands | Built | `effectiveMultiplier()`, tested |
| Free trial: non-AI features plus a fixed AI grant, no auto top-up | Built | `grantTrialCredit()` |
| Subscription tiers with named identity seats | Built | `backend/src/billing/subscription.ts`, tested |
| One human = one identity, seats revocable and reusable | Built | `assignIdentity()` / `revokeIdentity()`, tested |
| Subscription includes no AI entitlement | Built | Stated on every invoice |
| Invoice separating subscription from AI usage | Built | `buildInvoice()`, tested |
| Environments: local mock, staging capped, production enforced | Built | `AI_MODE` |

## 7. Governance, identity and access

| Requirement | Status | Where |
|---|---|---|
| Three account layers, strictly separated | Built | `AccountLayer`; platform operators are barred from delivery data |
| Enterprise → Portfolio → Programme → Project → Package | Built | `backend/src/domain/structure.ts`; every level creatable |
| Roles: Owner, EPC, QS, PM, Planner, Safety, FM, Regulator, Supplier, and more | Built | `Role` union |
| Permission codes R/C/U/A/I/X/G | Built | `PermissionCode` |
| Permission matrix by role and capability area | Built | `PERMISSION_MATRIX`, exposed at `/v1/permissions/matrix` |
| QS cannot approve budget baselines | Built | Enforced; the demo routes approval to the Owner |
| Regulator read-only, no AI unless enabled by the owner | Built | ABAC, demonstrated in the demo |
| Safety cannot reach Legal-L4 content | Built | Data sensitivity redaction |
| FM controls post-handover, cannot alter tender baselines | Built | Matrix plus phase gating |
| Supplier confined to its own submissions | Built | ABAC party check; procurement commands verify identity |
| Decision order: authenticate → RBAC → scopes → ABAC | Built | `evaluateAccess()` |
| Fail-closed on missing attribute or evaluation error | Built | `evaluateAccess()`, covered in `tests/identity.test.ts` |
| Entity reads carry their own capability area and sensitivity | Built | `backend/src/identity/entityAccess.ts`; the generic entity endpoint evaluates it |
| The audit trail cannot be used to read around a capability boundary | Built | Event envelopes stay; the patch is withheld for entities the caller cannot read |
| Tenant isolation | Built | Enforced in ABAC and again in the ledger |
| Phase gating on writes | Built | `WRITE_PHASE_GATES` |
| OAuth2-style scopes | Built | `backend/src/identity/scopes.ts` |
| Access TTL 15 min, refresh 7 days, rotation | Built | `backend/src/identity/auth.ts` |
| No grace window on expiry | Built | Rejected before routing |
| MFA with exposure flag | Built | `shapeMfaResponse()` |
| Full audit log of all actions | Built | The Golden Thread is the audit log |

## 8. Lifecycle gates

| Requirement | Status | Where |
|---|---|---|
| Phase transitions are governed events | Built | `transitionPhase()` requires evidence and justification |
| Exit criteria evaluated from materialised state | Built | `evaluatePhaseGate()` |
| Cannot skip phases | Built | Tested by the demo traversal |
| Regression permitted but recorded as such | Built | `direction: 'REGRESSION'` |
| Design maturity gates the pricing basis | Built | `assessDesignMaturity()`; a lump sum against immature design is refused |
| Estimate frozen before bid submission | Built | `compileBidPack()` refuses an unfrozen estimate |
| Award blocked on insurance gaps | Built | `BLOCKING_FLAGS` in bid scoring, tested |
| Every specified stage gate has an implemented seven-clause Definition of Done | Built | 6.4, 7.4, 8.4, 9.4, 10.4 and 11.4. `gateFor()` picks by phase; TENDER is the fall-through |

## 8a. Concept, stage 6 (C-WF-01 to C-WF-08 and 6.4)

| Requirement | Status | Where |
|---|---|---|
| C-WF-01 · Configuration versioned, never edited | Built | `conceptinitiation.versionConfiguration()`; version 2 onwards requires an impact assessment |
| C-WF-01 · Duplicate project code blocks creation | Built | Checked across the tenancy against each project's *current* version |
| C-WF-01 · Missing jurisdiction / time zone / currency blocks baseline work | Built | `configurationBlockedReason()`, read by the brief baseline and the gate. Time zones are validated against `Intl`, not a hand-kept list |
| AC-C-WF-01-01 · Platform operator cannot execute any of it | Built, structurally | `tenantContext` bars the operator layer before any command is reached, and `PLATFORM_ADMIN` holds no `PROJECT_SETUP` in the matrix. Not restated in the module |
| AC-C-WF-01-03 · Dates in project time zone, persisted as UTC | **Partial** | The zone is recorded and validated on the configuration; rendering per-project time zone in the console is not built — the console renders in the viewer's locale |
| C-WF-02 · Requirement carries source, owner, priority, verification method | Built | Required at creation and re-checked at the baseline |
| AC-C-WF-02-02 · AI requirements visibly marked until accepted | Built | Two events rather than a flag; badged on the row in `frontend/pages/concept.js` |
| C-WF-02 · Below-threshold extraction stays Draft-Needs-Review | Built | `NEEDS_REVIEW` is a distinct status from `DRAFT` |
| C-WF-02 · Deletion after baseline prohibited | Built | `supersedeRequirement()` is the only exit and requires a reason |
| C-WF-02 · Conflicting mandatory requirements block option approval | Built | `briefConflictReason()`, read by `optionSelectionBlockedReason()`. Only *declared* conflicts — the platform does not infer them |
| AC-C-WF-02-03 · A changed requirement shows what it affects before approval | Built | `requirementImpact()` names what was approved against the requirement — the brief baseline, the selected option, the approved controls, the package strategy, the concept baseline — before the change is made. `HARD` where an approval names the hash about to change, `SOFT` where the work is downstream without freezing it. Every link is one the ledger holds; nothing is inferred from the text |
| C-WF-03 · Survey carries coordinate system and limitations | Built | Both mandatory. `NONE` is a legitimate coordinate system and is distinguished from an absent one |
| C-WF-03 · Readiness from evidence coverage, not document count | Built | `dueDiligenceReadiness()` over impact categories covered by *live* surveys |
| C-WF-03 · Superseded or expired survey usable only as history | Built | Stays readable; stops counting toward coverage |
| AC-C-WF-03-02 · Options cannot be recommended over an unassessed critical constraint | Built | `constraintAssessmentBlockedReason()` |
| C-WF-03 · Material unknown carries an allowance or explicit acceptance | Built | Enforced on `ASSUMPTION` constraints at assessment |
| AC-C-WF-03-03 · Map and register share stable IDs | **Partial** | The register's `reference` is the stable id and `geometryRef` is carried; there is no map surface to share it with |
| C-WF-04 · Raw values preserved separately from the weighted score | Built | `CriterionScore` stores both; `weightedScore()` is computed on read |
| C-WF-04 · Options not comparable across scope or price base | Built | `compareOptions()` refuses across base dates, currencies or criteria sets rather than normalising with an invented index |
| AC-C-WF-04-02 · Scenario results reproducible from stored inputs | Built | `sensitivity()` is deterministic arithmetic over the stored option states — nothing samples |
| AC-C-WF-04-03 · Selected option links to the brief it was approved against | Built | The brief baseline hash is frozen onto the option at selection and re-checked by the gate |
| AC-C-WF-04-01 · Rejected rationale recorded | Built | Rejection is its own act, never a side effect of selecting another |
| C-WF-05 · Unverified rate excluded from the high-confidence total | Built | `provisional` is derived from source and base date, not asserted by the caller. Two totals, not one with a caveat |
| AC-C-WF-05-03 · P50/P80 show method and assumptions | Built | Derived from the stored line ranges by the declared `rangeMethod`. Independence between lines is assumed and said so in the module — a real P80 is wider |
| AC-C-WF-05-02 · Logic or a documented open start/finish | Built | An undeclared dangler is refused; a declared one is accepted |
| C-WF-05 · Cost and programme cannot be approved independently | Built | One command over both, under one declared cut-off |
| AC-C-WF-05-01 · Totals reconcile line → option → project | Built | The cashflow must reconcile to the cost plan, and both must cite the selected option |
| C-WF-05 · Currency conversion stores rate, provider, timestamp | **Not applicable here** | No conversion happens: a concept cost plan must be in the project's reporting currency, and a mismatch is refused rather than converted |
| AC-C-WF-06-01 · Every package has scope, interfaces, dates and an owner | Built | Required per package |
| C-WF-06 · Package scope overlap or gap blocks approval | Built | `packageScopeIssues()` — computed, not eyeballed |
| AC-C-WF-06-03 · Long-lead dates trace to a required-on-site milestone | Built | And the lead time must fit between award and need, or the order is late before it is placed |
| C-WF-06 · Single-source route requires authorised justification | Built | Refused without both the justification and the approver |
| C-WF-06 · Contract rules remain provisional | Built | `provisional: true` is a literal on the type, not a settable field |
| AC-C-WF-07-01 · No critical risk without owner and response | Built | `riskReviewBlockedReason()` over the existing `RiskRegisterItem` register — not rebuilt |
| AC-C-WF-07-02 · Risk allowance reconciles without double counting | Built | The declared allowance is reconciled against `RISK_ALLOWANCE` in the cost plan and refused outside tolerance |
| AC-C-WF-07-03 · Statutory gateways are non-bypassable milestones | Built | An applicable regime must name a milestone that exists on the concept programme *and* is marked statutory |
| C-WF-07 · AI safety or legal classification needs competent-person confirmation | Built | Name, role and competence basis are recorded separately from the acting user |
| AC-C-WF-08-01 · Gate pack reproducible, exact component versions | Built | `approveConceptBaseline()` freezes twelve components with the hash of each; `conceptBaselineDrift()` re-checks |
| AC-C-WF-08-02 · A rejected gate leaves the project in Concept | Built | `decideGate()` records the decision; the phase moves only through `transitionPhase()`, which is a separate governed act |
| AC-C-WF-08-03 · Design cannot publish before the concept gate | Built | `designPublicationBlockedReason()` and `assertDesignMayPublish()` in `stagegate.ts`, read by `freezePackage()` — the moment design publishes. A `PASS` or `PASS_WITH_CONDITIONS` on 6.4 opens the door; a `HOLD`, a `REJECT` or no decision does not, and the decision must predate the freeze |
| 6.4 clause 5 · AI outputs fully accounted for | Built | Assessed at all six gates. Assumptions and prompt version are written onto every AI event by `runAI`; the human disposition is its own event, `AI_OUTPUT_DISPOSED`. The clause fails naming the execution nobody has decided about |
| 6.4 clause 7 · Design mobilisation worklist | Built | `designMobilisationWorklist()` derives the packages to mobilise from the approved package strategy — award date, lead time and required-on-site — with no re-entry |

## 9. Procurement and tender workflow

| Requirement | Status | Where |
|---|---|---|
| Schedule builder with route split (market vs self-perform) | Built | `assignScheduleRoute()` |
| Tender package composer with completeness scoring | Built | `composeTenderPackage()`; an incomplete package cannot be issued |
| Enquiry letter, DRM, attendances, payment terms, programme | Built | Package composition inputs |
| Clarification register, answers issued to all bidders | Built | `answerClarification()` refuses to answer one bidder privately |
| Late returns rejected | Built | `receiveSubmission()` |
| Tender return normalisation and variance analysis | Built | `analyseReturns()`, median-based outlier detection |
| Clarification question generation from variance | Built | `generateClarifications()` |
| Deterministic bid comparison | Built | `evaluateBids()`, order-independent, tested |
| Price / programme / risk scoring with both methods | Built | Ratio and min-max; band-to-score and expected-risk-cost |
| Mandatory flags with penalty multipliers | Built | Seven flag codes |
| Unrealistic programme penalised | Built | Feasibility floor, tested |
| Award recommendation with conditions | Built | Conditions derived from flags |
| Adjudication with deviation from recommendation visible | Built | `deviatedFromRecommendation` |
| Bid pack compiled, locked and hashed | Built | `compileBidPack()` |
| Procurement as a continuation of tender | Built | Award → subcontract carries exclusions, exceptions and buyout delta |
| Commitment raised on subcontract execution | Built | Contract and commitment are created together |

## 10. Field execution

| Requirement | Status | Where |
|---|---|---|
| Offline-first capture | Built | `backend/src/field/sync.ts` |
| Local append-only writes | Built | Client-side contract; server accepts operation batches |
| Device timestamps preserved | Built | `deviceTimestamp` on the event, tested |
| Batch push / pull sync | Built | `push()` / `pull()` |
| Deterministic conflict resolution | Built | Safety stop → progress monotonicity → role priority |
| Cursor monotonicity enforced | Built | `CURSOR_REGRESSION`, tested |
| Idempotent sync | Built | Operation ids deduplicated, tested |
| Governance actions barred from devices | Built | `FIELD_FORBIDDEN_EVENTS`, tested |
| Progress requires evidence | Built | `recordProgress()` registers evidence before committing |
| Site diary, inspections, snagging, photo evidence | Built | Event catalogue and Engine G |
| Native Android and iOS applications | Design only | The API, sync protocol and event source enum support them; no native clients here |
| Voice-first capture | Design only | The record shape supports dictated input; no speech pipeline |

## 11. Gateway and API

| Requirement | Status | Where |
|---|---|---|
| Single internet-facing ingress | Built | `backend/src/api/gateway.ts` |
| Stateless gateway | Built | No sessions; tokens verified per request |
| Path-based routing with explicit versioning | Built | `ROUTES`, listed at `/v1/routes` |
| Trace and correlation id propagation | Built | `buildTrace()` |
| Token-bucket rate limiting with burst | Built | `rateLimiter` |
| Tighter limits on auth routes | Built | Route-group limits |
| IP-based pre-auth, token-based post-auth | Built | Applied before and after authentication |
| Tenant-aware rate limit keys | Built | `rl:{tenant}:{actor}:{group}` |
| Fail-closed when the limiter backend is down | Built | `setBackendHealthy(false)` denies |
| Request validation, no downstream forwarding on failure | Built | `validateRequest()` |
| Generic errors on public auth endpoints | Built | Detail suppressed on public routes |
| `application/problem+json` errors | Built | `toProblem()` |
| Idempotency key passthrough | Built | `readIdempotent()` / `storeIdempotent()` |
| Structured logging with mandatory fields | Built | `logRequest()` |
| Metrics | Built | `metrics()` |
| Health and readiness endpoints | Built | `/healthz`, `/readyz` |
| Zero-trust response headers | Built | `sendJson()` |
| Kong / Redis / Terraform deployment topology | Design only | Specified in the source documents; this build runs as a single Node process |
| Kafka topics, AsyncAPI contracts, webhooks | Design only | The ledger publishes to subscribers in-process; no broker wired |

## 12. Brand and application

| Requirement | Status | Where |
|---|---|---|
| Core Black, Carbon, Structural Grey, Signal Orange palette | Built | `frontend/app.css`, `frontend/landing.html` |
| Status colours (success, warning, critical, info) | Built | `frontend/app.css` tone tokens |
| Portfolio value formatter (zero as `$0.0M`) | Built | `formatContractValue()`, tested |
| Enterprise → Portfolio → Project drill-down | Built | Topbar breadcrumb and `frontend/pages/enterprise.js` |
| Single scroll container, sticky headers, no overlap | Built | `.table-scroll` in `frontend/app.css` |
| Region filters as ISO codes | Built | `continentCode` / `countryCode` on portfolios and projects |
| AI insights never look broken | Built | The copilot states when the record is empty rather than failing |
| Web application across the lifecycle | Built | Fifteen screens in `frontend/pages/`, each reading live endpoints |
| Role-aware navigation that matches enforcement | Built | Nav entries declare a capability area and resolve it against the live matrix; refused screens show the reason |
| Three account layers visible in the product | Built | Signing in as the Platform Operator produces a different application with no delivery data |
| Denials distinguished from empty records | Built | `withheldRecords()` in `frontend/lib/api.js`, surfaced by the shell |
| Command surfaces on every relevant screen | Built | `frontend/lib/command.js`; commands on field, cost, design, programme, change and handover |
| Field input zones (labour, plant, weather, progress) | Built | Daily site record on `frontend/pages/field.js`, submitted as an evidenced progress measurement |
| Canonical enum dropdowns shared across pickers | Built | `frontend/lib/enums.js`; every value matches the enum the API validates |
| Dates via picker, stored UTC | Built | Date controls in the command layer; ISO conversion on submit |
| Evidence attached at the point of capture | Partial | The file is hashed with SHA-256 in the browser and the hash is recorded; there is no object store for the file itself |
| Project profile input with canonical enums at creation | Design only | Projects are created through the API; the guided creation form is not built |
| Native Android and iOS clients | Design only | The sync and source model supports them; no native client written |

---

## 13. Ingestion and perception pipeline

The specification describes a full intake stack in front of the engines. Most of
it is now built — upload and storage, structural inspection, classification,
native extraction, a lexical index, seven perception tasks that read a held file
and produce a draft a person confirms, and commitment extraction from
correspondence. What remains absent is the part that
needs a model or a library this platform does not have: signature scanning, OCR,
semantic embedding and IFC parsing. Those rows say so rather than being implied
by a "Built" row elsewhere.

| Requirement | Status | Where |
|---|---|---|
| Presigned upload, SHA-256, MIME validation | Built | `evidence/store.ts` stores bytes only against a hash the ledger already names and refuses any whose content does not hash to it; `evidence/ingest.ts` checks the declared type against the leading bytes and quarantines a mismatch |
| Virus scan | Not built, and not claimed | There is no signature engine under the zero-dependency decision. `antivirusScanned: false` is on every inspection and `antivirusConfigured: false` on every read, so zero quarantined is never readable as nothing infected. What is refused is structural: executable magic, EICAR, active markup, an archive carrying a program, a declared compression ratio above 200:1 |
| File classifier (drawing, specification, programme, contract, certificate, photograph, model, schedule, correspondence) with confidence | Partial | `classify()` in `evidence/ingest.ts`, with `method: 'RULES'` on the record and a confidence that counts agreeing signals. It is filename convention, magic number and content markers — not machine learning, and the record does not call it that |
| OCR, table extraction, clause extraction, entity extraction | Partial | Native text and delimited tables are extracted (`extractText()`); clause extraction from supplied text is built (`extractContractIntelligence()`). A PDF or a photograph reports `NEEDS_OCR` and routes to the perception pipeline, which refuses where no multimodal provider is configured |
| Vector embedding and semantic retrieval | Partial | `lexicalVector()` and `similarFiles()` — feature hashing over words and word pairs, cosine compared. Named lexical because it is: it finds the near-duplicate revision and the second copy of a specification, not a document that means the same thing in other words. A semantic embedding is not built |
| `FILE_EXTRACTED` event | Built | With `FILE_INGESTED` and `FILE_QUARANTINED`, written by `ingestFile()` |
| IFC schema parsing, quantity computation, element→WBS mapping | Design only | `ingestModel()` records the model as an event; it does not parse it |
| Geometry hash, model version diffing, change detection | Design only | Not implemented |
| Vision: progress estimation, PPE compliance, equipment recognition, defect detection | Built | Four tasks in `engines/perception.ts`, each a draft a person confirms into the ordinary domain command — `submitProgress`, `logSafetyObservation`, `captureSiteObservation`, `raiseNCR`. Refused outright where no configured provider can be shown a file. Exercised against a stub, not a live provider |
| `PROGRESS_EXTRACTED_FROM_IMAGES` event | Built | Written against the submission beside `PROGRESS_REPORTED`, carrying the provider, whether the answer was synthetic, the stated basis, what the model could not see and what the confirmer changed |
| Audio: transcription | Built | The `VOICE_NOTE` perception task, confirmed into `captureSiteObservation` |
| Commitment and deadline extraction from correspondence | Built | `domain/commitments.ts` reads a held letter for what it promises and what it demands. Every finding must quote the letter verbatim or it is dropped before it is written, which is what stops a provider that cannot read prose from filing an invented undertaking; a confirmed one is registered in the obligation calendar through `registerObligation`. Exercised against a stub, not a live provider |
| `COMMITMENT_REGISTERED`, `DEADLINE_TRACKED` events | Built | Plus `COMMITMENT_DISCARDED`, because a rejected reading is a fact too. The entity is `CorrespondenceCommitment` — `Commitment` was already the cost commitment against a budget |
| Knowledge graph with typed edges and traversal | Partial | Entities cross-reference by id and the ledger reconstructs the lineage; there is no graph store or traversal API |

## 14. Commercial packaging

`CONSTRUX__REVIEW_05` supersedes the earlier tier model with role-based seat
pricing. The build still carries the earlier model.

| Requirement | Status | Where |
|---|---|---|
| Subscription separated from AI consumption | Built | `backend/src/billing/subscription.ts` and `backend/src/billing/acu.ts` are independent |
| Trial granted automatically on tenant creation, no manual override | Built | `grantTrialCredit()` in `createTenant()`; no operator path adds trial credit |
| Seat model with per-role prices (£25–£180) | Design only | Seats are counted and capped by tier; they carry no role price |
| Packages: Core Project £950, Professional Delivery £2,200, Enterprise £6,500 | Design only | Tiers are SOLO/TEAM/BUSINESS/ENTERPRISE/SOVEREIGN at the earlier prices |
| ACU bundles: Starter £300, Growth £1,000, Scale £2,500 | Design only | Top-ups are an arbitrary amount, not a bundle |

---

## Cross-stage sections 12 to 18, and the appendices

These arrived as specification after the lifecycle workflows were built, and
much of what they describe already existed — they are largely a written
statement of the architecture rather than a list of new features. This table is
the audit of which parts are actually met, taken against the code rather than
against intent.

### 12 — Cross-stage state machines and handoffs

| Requirement | Status | Where |
|---|---|---|
| 12.1 Universal stage state machine | **Partial** | `domain/structure.transitionPhase` moves a project between lifecycle phases and records direction (`FORWARD`/`REGRESSION`) with a justification. There is no separate per-object state machine enumerating the 12.1 states as a shared type; each workflow carries its own status vocabulary |
| 12.2 Handoff contract | **Partial** | Each stage gate's `DOWNSTREAM_CREATED` clause enforces that the next stage's obligations exist with owners before the gate passes — 9.4, 10.4 and 11.4 all do this. There is no single declarative handoff-contract object |
| 12.3 The automatic handoffs (Concept→…→Operations) | **Partial** | The chain is proven end to end in `tests/lifecycle.test.ts`, and H-WF-09's `activateOperations` derives operations from accepted data without re-entry. The handoffs are implemented workflow by workflow, not as one table-driven mechanism |

### 13 — Canonical domain and data model

| Requirement | Status | Where |
|---|---|---|
| 13 Canonical domain model | **Built** | `identity/entityAccess.ts` is the single classification of every entity type to a capability area and sensitivity; `goldenthread/eventTypes.ts` is the closed event catalogue |
| 13.1 Canonical submission envelope | **Partial** | Every write goes through one `write()` in `engines/context.ts` carrying actor, source, correlation id, entity, evidence and policy. It is not exposed as a named public submission-envelope schema |
| 13.2 Data validation classes | **Built** | Route-level JSON Schema on every write route, plus domain-level refusals that carry an RFC 7807 problem type and a machine-readable code |

### 14 — APIs and events

| Requirement | Status | Where |
|---|---|---|
| 14.1 API conventions | **Built** | `api/middleware.ts` — RFC 7807 problem+json, `x-correlation-id` on every response, `buildTrace`/`logRequest` |
| 14.1b Representative endpoints | **Built** | 642 routes registered in `api/routes.ts`, covered by real HTTP tests |
| 14.2 Golden Thread event envelope | **Built** | `goldenthread/types.ts` — actor, source, entity, action, before/after hash, diff, evidence refs, AI block, policy block, correlation and causation ids, chain hash |
| 14.3 Event processing guarantees | **Partial** | Append-only with a hash chain, a durable journal and replay verification are built. Operation-id idempotency exists for field sync. The notification **outbox** is built (`notifications/outbox.ts`): the intent is committed to the ledger before anything is transmitted, so delivery is at-least-once with retry and a stated give-up, and a process that dies mid-send leaves a notice the platform still owes. It is an outbox, not a distributed transaction — the domain event and the queue entry are two journal appends, and that window is stated in the module rather than papered over |
| 14.4 Integration adapters | **Design only** | Modelled as inputs the engines accept; no adapter is connected to a real external system |

### 15 — AI control plane

| Requirement | Status | Where |
|---|---|---|
| 15.1 Three visible AI modes | **Built** | Workflow AI (named task buttons), Copilot and the Knowledge/audit read are all in the console and named at the point of use |
| 15.2 AI execution sequence | **Partial** | Authorisation, input resolution, ACU estimate and hold, provider routing with fallback, ledger write, prompt version and human disposition are all built (`ai/orchestrator.ts`, `engines/context.runAI`, `domain/aidisposition.ts`). The step that is **not** built: no retrieval snapshot is stored |
| 15.3 Risk tiers A–D and automation ceiling | **Partial** | The ceiling is enforced, but through a different mechanism than the specification's four tiers: `aiAllowed` on each event type in the closed catalogue, defaulting to false. Tier D — "AI cannot execute or impersonate signatory" — is met by construction, because every approval, completion, competence and regulatory event carries `aiAllowed: false`. The A/B/C gradations are not modelled as named tiers |
| 15.4 Mandatory AI output schema | **Built** | The AI event block carries provider, model class, ACU held and consumed, input refs, confidence, policy id, decision, **assumptions**, **known gaps**, **alternatives considered** and **prompt version**; the human disposition is a separate event because it is a later act by a different party. Clause five of every stage gate assesses all of them. `[]` and absent are distinguished throughout: "it declared none" and "nobody asked" are different facts |
| 15.5 Confidence and failure policy | **Built** | Provider timeout and fallback, cross-provider identification, and a wallet with no balance refusing the call. Confidence thresholds are configurable globally (`AI_CONFIDENCE_THRESHOLD`) and per task (`AI_CONFIDENCE_THRESHOLDS`). The evaluation harness is `ai/evaluation.ts` — see 17.1 for what it does and does not claim |

### 16 — Non-functional, security and offline

| Requirement | Status | Where |
|---|---|---|
| Security | **Built** | TLS/HSTS headers, tenant isolation on every read, RBAC/ABAC, a tight CSP, secrets server-side only |
| Integrity | **Built** | SHA-256 throughout, immutable append-only events, replay verification, hash-chained ledger |
| Offline | **Built** | `field/sync.ts` — client-minted operation ids, device timestamps, base state hash, typed conflicts |
| Observability | **Built** | Trace/correlation on every request, authz decisions logged, sensitive values redacted |
| Accessibility | **Partial** | Audited and fixed against the automated WCAG 2.2 AA checks in this build — see `STATE.md`. Not a conformance statement; reflow, announcement order and the cognitive criteria are unaudited |
| Availability, Scale, Business continuity | **Design only** | Single instance by design; the ledger is in-process. Multi-zone, failover and RPO/RTO need the Postgres design that is not implemented |
| Privacy | **Partial** | Sensitivity classification and export redaction are built; H-WF-06 and H-WF-10 both take the structural approach of having no field a name could occupy. There is **no personal-data tier** in the sensitivity ladder and no retention/deletion engine |
| 16.1 Offline conflict policy | **Built** | Stable client id, idempotent duplicates, base state hash, typed resolutions, device time preserved. Field-level merge of non-conflicting scalars is built on the optional `baseState` the device sends — disjoint edits merge instead of picking a winner, and `MERGED` is now reachable. Every conflict is written as a `SyncConflict` record in `OPEN` state with both sides kept whole, and `resolveSyncConflict()` is where a person confirms the engine or writes the device's record over it |

### 17 — Quality assurance

| Requirement | Status | Where |
|---|---|---|
| 17.1 Unit/property tests | **Built** | 3,231 tests covering formulas, date logic, state guards, hash canonicalisation and permission decisions |
| 17.1 End-to-end role tests | **Built** | Every workflow tested from a permitted role and a denied role; maker-checker and party separation asserted where the domain requires them |
| 17.1 Offline/device tests | **Partial** | Duplicate submit, conflict and clock handling are tested. Process kill, app upgrade and two-device interleaving are not |
| 17.1 AI evaluations | **Built** | `ai/evaluation.ts` runs 23 cases on a throwaway instance of the demonstration project, records the result and reports drift against the previous run, case by case. Three are a prompt-injection suite. Fourteen are the **gold set** in `ai/goldset.ts`: cases whose right answer is fixed by statute, standard or arithmetic — the notified sum under HGCRA s.111, the adjudication timetable under s.108, PERT, critical path and float, EVM indices and the forecast final cost. Each states the authority its expected value comes from and derives it by hand, so a quantity surveyor or a planner can check the expectation without reading TypeScript. What is deliberately **not** graded is model *judgement* — whether a programme is good or an allowance prudent needs a professional, not a fixture, and a score for it would be the one figure nobody could check |
| 17.1 Performance/resilience tests | **Partial** | Provider outage and fallback are tested. Peak ingest, queue backlog, failover and restore are not |
| 17.2 E2E acceptance scenarios | **Partial** | The *behaviours* the twelve scenarios describe have test coverage — AI fallback on an empty wallet, a regulator refused a write and an AI run, a failed test whose prior data stays immutable, award converting to live commercial controls, and the eleven-stage chain end to end. What does **not** exist is the twelve scenarios written as twelve named acceptance tests, which is what 17.2 asks for; the coverage is spread across the suites that own each behaviour and has not been mapped scenario by scenario. E2E-02 additionally depends on the unbuilt C-WF concept workflows, and E2E-05 is tested at the sync layer rather than on a device |
| 17.3 Global Definition of Done | **Partial** | The code, test, no-fake-data and state-documentation clauses are held to on every change. Migration/backfill and rollback runbooks exist for deployment; there is no data migration because there is no database |

### 18 and the appendices

| Requirement | Status | Where |
|---|---|---|
| 18 Build sequence phases 0–4 | **Built** | Delivered in the order the section prescribes: control foundation, input spine, tender/commercial, field delivery, then commissioning and handover |
| 18 Phase 5 intelligence hardening | **Partial** | Specialist agents, scenario forecasting, organisation memory and the evaluation harness are built; the scale work is not |
| 18.1 Epic naming | **Not adopted** | The build is organised by lifecycle stage and workflow id rather than by the EPIC-* labels. No code change would follow from adopting them |
| A.1 KPI calculation rules | **Partial** | Stage completeness, SPI, CPI, forecast final cost, unapproved change exposure, design readiness, commissioning readiness and handover readiness are all implemented as derivations. Milestone confidence carries a band. **Data freshness is not implemented** as a first-class per-domain measure |
| A.2 Shared status enums | **Partial** | Each object carries a status vocabulary and the handover deliverable path matches A.2 exactly. They are not consolidated into one shared enum module, so a status added to one object is not automatically offered to another |
| B.2 Industry references | **Built** | The standards are what the domain rules were written against — HGCRA payment and notice logic, CDM duty holders, RIBA stage structure, ISO 19650 information control, CIBSE Code M commissioning sequence |

**The honest summary of this table:** most of sections 12–18 describe
architecture that already exists, and the four gaps listed here are closed. The
AI output schema carries the whole of 15.4 and every stage gate assesses it; the
notification outbox makes delivery at-least-once with a durable queue; the
offline `Conflict` record is built with a human resolution behind it; the
evaluation harness runs, records drift, and includes a gold set whose expected
values come from statute, standard and arithmetic rather than from the code.

One thing is deliberately still not done, and is not a gap being carried
quietly: the harness does not score model **judgement**. Whether a programme is
good or a risk allowance prudent is a professional's opinion, and a number
printed for it would be the one figure on this platform nobody could check. The
gold set grades what has a right answer; the rest is left to the person whose
name goes on the decision.

---

## Deliberate omissions

Three things are specified in the source documents and intentionally absent
here, because implementing them badly would be worse than not implementing them:

1. **Deployment topology** — Terraform modules, Kong, MSK, RDS and S3. The
   application is written to run behind them (stateless gateway, event stream,
   object references rather than blobs), but the infrastructure is not in this
   repository.
2. **Native mobile clients.** The sync protocol, offline conflict rules and
   `ANDROID`/`IOS` event sources are built and tested server-side. The apps
   themselves are a separate piece of work.
3. **External data feeds** — live commodity pricing, weather, and credit
   reference. Each is modelled as an input the engines already accept; none is
   connected to a real provider.
