import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { ROUTES } from '../src/api/routes.ts';
import * as apps from '../src/domain/planning/applications.ts';
import * as consents from '../src/domain/planning/consents.ts';
import * as gates from '../src/domain/planning/gates.ts';
import * as planning from '../src/domain/planning/planning.ts';
import { planningRegister } from '../src/domain/planning/register.ts';
import * as studies from '../src/domain/planning/studies.ts';
import { planningWatchAgent } from '../src/agents/planning.ts';
import { registerEvidence, write, type EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * CONSTRUX Planning from a proposal to the release of works: an outline
 * permission for 40 homes in two phases, its reserved matters, the conditions
 * and obligations, every gate, and the specification's acceptance rows (§8).
 *
 * Dates are fixed in the past for anything that has happened and far in the
 * future for deadlines, so the file passes on any day it is run.
 */

let platform: Platform;
let seed: SeedResult;
const as = (who: string): EngineContext => platform.context(seed.users[who]!.auth, seed.projectId, { source: 'WEB' });
const refused = (fn: () => unknown, code: string) => assert.throws(fn, (error: { code?: string }) => error.code === code, `expected ${code}`);
const blockedBy = (fn: () => unknown, id: RegExp) =>
  assert.throws(
    fn,
    (error: { code?: string; message?: string; fieldErrors?: Array<{ field: string }> }) => {
      const ok = error.code === 'GATE_BLOCKED' && (error.fieldErrors ?? []).some((entry) => id.test(entry.field));
      return ok;
    },
    `expected a blocker matching ${id}`,
  );

let docCount = 0;
/** A CDE revision on the project, as the design team deposits one. */
function document(title: string, projectId = seed.projectId): apps.EvidenceRef {
  docCount += 1;
  const refId = `doc-${docCount}-${projectId.slice(-4)}`;
  const ctx = platform.context(seed.users.owner!.auth, projectId, { source: 'WEB' });
  const evidence = registerEvidence(ctx, { type: 'INFORMATION_CONTAINER', hash: `hash-${docCount}`, description: title, linkedEntities: [] });
  write(ctx, {
    eventType: 'CONTAINER_DEPOSITED',
    entity: { refType: 'InformationContainer', refId },
    evidenceRefs: [evidence],
    nextState: { id: refId, projectId, reference: `PL-${docCount}`, revision: 'P01', title, kind: 'DOCUMENT', discipline: 'PLANNING', suitability: 'S0', state: 'WIP', fileHash: `hash-${docCount}`, author: 'design', depositedAt: new Date().toISOString() },
  });
  return { refType: 'InformationContainer', refId };
}

function rectangle(lat: number, lon: number, widthM: number, heightM: number): number[][] {
  const a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f), phi = (lat * Math.PI) / 180, w = 1 - e2 * Math.sin(phi) ** 2;
  const dLat = (heightM / ((a * (1 - e2)) / w ** 1.5)) * (180 / Math.PI);
  const dLon = (widthM / ((a / Math.sqrt(w)) * Math.cos(phi))) * (180 / Math.PI);
  return [[lon, lat], [lon + dLon, lat], [lon + dLon, lat + dLat], [lon, lat + dLat], [lon, lat]];
}

/** Every open requirement of an application at the given gates: evidence by the PM, accepted by the QS. */
function satisfy(applicationId: string, gatesToClear: string[]): void {
  for (const requirement of apps.requirements(as('pm'), applicationId).filter((entry) => gatesToClear.includes(entry.gate) && entry.delivery !== 'ACCEPTED' && entry.delivery !== 'NOT_APPLICABLE')) {
    apps.updateRequirement(as('pm'), requirement.id, { evidence: [document(requirement.title)], delivery: 'SUBMITTED_FOR_REVIEW' });
    apps.reviewRequirement(as('qs'), requirement.id, { decision: 'ACCEPTED', rationale: 'Checked against the requirement' });
  }
}

/** G1 with the unquoted allowances accepted as a commercial risk, then a pack and G2. */
function toReady(applicationId: string, feeQuoteId: string, evaluationId?: string): void {
  satisfy(applicationId, ['G1']);
  gates.approveGate(as('owner'), 'G1', { applicationId, rationale: 'Route and budget approved', riskAcceptances: [{ blockerId: 'G1:UNQUOTED', rationale: 'Quotes due before submission; allowances are within appetite' }] });
  satisfy(applicationId, ['G2']);
  apps.assemblePack(as('pm'), { applicationId, feeQuoteId, ...(evaluationId ? { evaluationId } : {}), documents: [document('Location plan'), document('Planning statement')] });
  gates.approveGate(as('owner'), 'G2', { applicationId, rationale: 'Pack checked' });
}

let proposalId: string;
let outline: apps.Application;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  platform.setModuleGrant({ moduleId: 'PLANNING', tenantId: seed.tenantId, status: 'ACTIVE', reason: 'Planning consent test', decidedBy: seed.users.operator!.id });
  const site = planning.recordSiteVersion(as('pm'), {
    geometry: { type: 'Polygon', coordinates: [rectangle(52.2, -1.5, 300, 100)] },
    confirmedAreaM2: 30_000,
    authority: { name: 'Example District Council', confirmed: true, source: 'Boundary check' },
    boundarySource: 'Title plan',
  });
  planning.acceptSiteVersion(as('qs'), { siteVersionId: site.id, note: 'Title plan' });
  for (const [key, value] of [['FLOOD_ZONE', '1'], ['EIA_SENSITIVE_AREA', 'NO'], ['EIA_CUMULATIVE', 'NONE_FOUND'], ['BNG_APPLICABILITY', 'APPLIES'], ['CIL_CHARGING_SCHEDULE', 'IN_FORCE'], ['LOCAL_VALIDATION_LIST', 'VERIFIED_CURRENT']] as const) {
    planning.recordSiteFact(as('pm'), { key, value, source: 'Recorded for the test, 1 Oct 2026' });
  }
  proposalId = planning.recordProposal(as('pm'), { siteVersionId: site.id, scenarioName: 'Outline, 40 homes', route: 'outline', use: 'HOUSING', dwellingCount: 40, createdGiaM2: 3600 }).id;
  for (const version of ['england-housing-rules-2026-11', 'england-2026-12-08']) {
    planning.prepareRuleVersion(as('pm'), { version, checkNote: 'Checked against the published source, figure by figure' });
    planning.publishRuleVersion(as('owner'), { version, note: 'Second check' });
  }
  planning.seedIllustrativeAllowances(as('pm'));
});

describe('G0 and the application', () => {
  it('blocks G0 until the proposal is evaluated, then approves it once — the second approval is refused', () => {
    blockedBy(() => gates.approveGate(as('owner'), 'G0', { rationale: 'Appraisal complete' }), /^G0:EVAL:/);
    planning.evaluateProposal(as('pm'), { proposalId });
    refused(() => gates.approveGate(as('pm'), 'G0', { rationale: 'Appraisal complete' }), 'ACCESS_DENIED');
    gates.approveGate(as('owner'), 'G0', { rationale: 'Appraisal complete with unknowns recorded' });
    refused(() => gates.approveGate(as('owner'), 'G0', { rationale: 'Again' }), 'GATE_ALREADY_APPROVED');
  });

  it('promotes the proposal with each matter determined or reserved, and generates its requirements', () => {
    refused(() => apps.draftApplication(as('pm'), { route: 'outline', proposalId, matters: { access: 'DETERMINED' } }), 'OUTLINE_MATTERS');
    outline = apps.draftApplication(as('pm'), {
      route: 'outline',
      proposalId,
      phases: ['Phase 1', 'Phase 2'],
      matters: { access: 'DETERMINED', appearance: 'RESERVED', landscaping: 'RESERVED', layout: 'RESERVED', scale: 'RESERVED' },
      targetSubmissionOn: '2026-09-30',
    });
    const keys = apps.requirements(as('pm'), outline.id).map((entry) => entry.key);
    for (const key of ['G1:SITE_CONTROL', 'NAT:FORM', 'NAT:FEE', 'NAT:CERTIFICATES', 'NAT:DAS', 'NAT:BNG_INFO', 'FINDING:FRA', 'FINDING:LOCAL_VALIDATION']) assert.ok(keys.includes(key), key);
    assert.equal(apps.generateRequirements(as('pm'), outline.id).length, 0, 'never generated twice');
  });

  it('keeps the reviewer apart from the person who attached the evidence, and needs a source for non-applicability', () => {
    const requirement = apps.requirements(as('pm'), outline.id).find((entry) => entry.key === 'G1:SITE_CONTROL')!;
    refused(() => apps.reviewRequirement(as('qs'), requirement.id, { decision: 'ACCEPTED', rationale: 'Looks fine' }), 'REVIEW_EVIDENCE_REQUIRED');
    apps.updateRequirement(as('pm'), requirement.id, { evidence: [document('Title report')] });
    refused(() => apps.reviewRequirement(as('pm'), requirement.id, { decision: 'ACCEPTED', rationale: 'My own work' }), 'REVIEW_SAME_PERSON');
    refused(() => apps.updateRequirement(as('pm'), requirement.id, { delivery: 'ACCEPTED' }), 'REQUIREMENT_DELIVERY');
    const das = apps.requirements(as('pm'), outline.id).find((entry) => entry.key === 'NAT:CERTIFICATES')!;
    refused(() => apps.reviewRequirement(as('qs'), das.id, { decision: 'NOT_APPLICABLE', rationale: 'Applicant owns the land' }), 'PLANNING_FIELD_REQUIRED');
  });

  it('refuses evidence from another project as though it did not exist', () => {
    const elsewhere = document('Another project’s plan', seed.workingProjects[0]!.projectId);
    const requirement = apps.requirements(as('pm'), outline.id)[0]!;
    refused(() => apps.updateRequirement(as('pm'), requirement.id, { evidence: [elsewhere] }), 'EVIDENCE_NOT_FOUND');
  });
});

describe('G1 and G2', () => {
  let quoteId: string;

  it('lets a commercial assumption be accepted as a risk, and nothing statutory', () => {
    satisfy(outline.id, ['G1']);
    blockedBy(() => gates.approveGate(as('owner'), 'G1', { applicationId: outline.id, rationale: 'Route approved' }), /^G1:UNQUOTED$/);
    gates.approveGate(as('owner'), 'G1', { applicationId: outline.id, rationale: 'Route approved', riskAcceptances: [{ blockerId: 'G1:UNQUOTED', rationale: 'Quotes due before submission; allowances are within appetite' }] });
    quoteId = planning.quoteFeeFor(as('pm'), { route: 'outline', madeOn: '2026-12-08', dateBasis: 'ASSUMED', proposalId }).id;
    blockedBy(() => gates.approveGate(as('owner'), 'G2', { applicationId: outline.id, rationale: 'Pack reviewed' }), /^G2:PACK$/);
    refused(
      () => gates.approveGate(as('owner'), 'G2', { applicationId: outline.id, rationale: 'Pack reviewed', riskAcceptances: [{ blockerId: 'G2:PACK', rationale: 'We will assemble it later on' }] }),
      'RISK_ACCEPTANCE_REFUSED',
    );
  });

  it('will not export or approve a pack holding a document the scanner flagged', () => {
    satisfy(outline.id, ['G2']);
    write(as('owner'), { eventType: 'FILE_INGESTED', entity: { refType: 'IngestedFile', refId: 'bad-file' }, nextState: { ingestionId: 'bad-file', projectId: seed.projectId, hash: 'bad', evidenceId: 'bad', filename: 'appendix.pdf', status: 'INGESTED' } });
    write(as('owner'), { eventType: 'FILE_QUARANTINED', entity: { refType: 'IngestedFile', refId: 'bad-file' }, nextState: { ingestionId: 'bad-file', projectId: seed.projectId, hash: 'bad', evidenceId: 'bad', filename: 'appendix.pdf', status: 'QUARANTINED' } });
    const evaluationId = planning.evaluations(as('pm')).at(-1)!.id;
    const pack = apps.assemblePack(as('pm'), { applicationId: outline.id, evaluationId, feeQuoteId: quoteId, documents: [document('Location plan'), { refType: 'IngestedFile', refId: 'bad-file' }] });
    refused(() => apps.packManifest(as('pm'), pack.id), 'PACK_QUARANTINED');
    blockedBy(() => gates.approveGate(as('owner'), 'G2', { applicationId: outline.id, rationale: 'Pack reviewed' }), /^G2:QUARANTINE:/);
  });

  it('approves a clean pack, freezing it, and makes the application ready', () => {
    const evaluationId = planning.evaluations(as('pm')).at(-1)!.id;
    const pack = apps.assemblePack(as('pm'), { applicationId: outline.id, evaluationId, feeQuoteId: quoteId, documents: [document('Location plan'), document('Design and Access Statement')] });
    gates.approveGate(as('owner'), 'G2', { applicationId: outline.id, rationale: 'Pack checked against the validation list' });
    assert.equal(apps.applicationOf(as('pm'), outline.id).status, 'READY');
    assert.equal(apps.packs(as('pm'), outline.id).find((entry) => entry.id === pack.id)!.status, 'APPROVED');
    assert.ok(platform.ledger.eventsForEntity({ refType: 'PlanningPack', refId: pack.id }).some((event) => event.eventType === 'PLANNING_PACK_APPROVED'));
  });

  it('marks an approval for re-review when a material input changes after the gate, and keeps the history retrievable', () => {
    const approved = apps.packs(as('pm'), outline.id).find((entry) => entry.status === 'APPROVED')!;
    planning.recordProposal(as('pm'), { siteVersionId: planning.siteVersions(as('pm')).at(-1)!.id, scenarioName: 'Outline, 40 homes', route: 'outline', use: 'HOUSING', dwellingCount: 44, createdGiaM2: 3900 });
    const register = gates.gateRegister(as('pm'));
    assert.equal(register.project.status, 'superseded', 'G0 needs re-review');
    assert.equal(apps.applicationOf(as('pm'), outline.id).status, 'DRAFT', 'readiness is revoked');
    assert.ok(gates.gateReviews(as('pm')).some((review) => review.gate === 'G2' && review.status === 'INVALIDATED'));
    // The approved manifest is still exactly what it was.
    assert.equal(apps.packManifest(as('pm'), approved.id).manifestHash, approved.manifestHash);
  });
});

describe('from submission to decision', () => {
  it('re-approves against the new version and walks the application through its events', () => {
    // The application is promoted afresh from the new version; the old one is withdrawn as a draft would be.
    const latest = planning.proposals(as('pm')).filter((entry) => entry.scenarioName === 'Outline, 40 homes').at(-1)!;
    proposalId = latest.id;
    const evaluation = planning.evaluateProposal(as('pm'), { proposalId });
    gates.approveGate(as('owner'), 'G0', { rationale: 'Re-appraised at 44 homes' });
    outline = apps.draftApplication(as('pm'), {
      route: 'outline',
      proposalId,
      phases: ['Phase 1', 'Phase 2'],
      matters: { access: 'DETERMINED', appearance: 'RESERVED', landscaping: 'RESERVED', layout: 'RESERVED', scale: 'RESERVED' },
      targetSubmissionOn: '2026-09-30',
    });
    const quote = planning.quoteFeeFor(as('pm'), { route: 'outline', madeOn: '2026-12-08', dateBasis: 'ASSUMED', proposalId });
    toReady(outline.id, quote.id, evaluation.id);

    refused(() => apps.recordApplicationEvent(as('pm'), outline.id, { type: 'validated', occurredOn: '2026-10-01', evidence: [document('Validation letter')] }), 'APPLICATION_STATE');
    refused(() => apps.recordApplicationEvent(as('pm'), outline.id, { type: 'submitted', occurredOn: '2026-10-01', payload: { externalRef: 'PP-1' } }), 'APPLICATION_EVIDENCE_REQUIRED');
    apps.recordApplicationEvent(as('pm'), outline.id, { type: 'submitted', occurredOn: '2026-10-01', evidence: [document('Portal receipt')], payload: { externalRef: 'PP-14200001' } });
    apps.recordApplicationEvent(as('pm'), outline.id, { type: 'invalid', occurredOn: '2026-10-03', payload: { reasons: 'Ownership certificate unsigned' } });
    apps.recordApplicationEvent(as('pm'), outline.id, { type: 'resubmitted', occurredOn: '2026-10-05', evidence: [document('Corrected certificate')] });
    const valid = apps.recordApplicationEvent(as('pm'), outline.id, { type: 'validated', occurredOn: '2026-10-08', evidence: [document('Validation letter')] });
    assert.equal(valid.madeOn, '2026-10-01', 'the made date is the first submission');
    assert.deepEqual(valid.clock, { weeks: 13, statutoryTargetOn: '2027-01-07', basis: 'From the latest rule evaluation of the proposal' });
    refused(() => apps.recordApplicationEvent(as('pm'), outline.id, { type: 'consultation', occurredOn: '2099-01-01', payload: { kind: 'STATUTORY', summary: 'Highways' } }), 'APPLICATION_EVENT_FUTURE');
    apps.recordApplicationEvent(as('pm'), outline.id, { type: 'consultation', occurredOn: '2026-10-20', payload: { kind: 'STATUTORY', summary: 'Highway authority: no objection subject to conditions' } });
    apps.recordApplicationEvent(as('pm'), outline.id, { type: 'forecast', occurredOn: '2026-10-21', payload: { forecastDecisionOn: '2027-01-20', basis: 'Officer’s indication' } });
    const forecast = apps.applicationOf(as('pm'), outline.id);
    assert.equal(forecast.clock!.statutoryTargetOn, '2027-01-07', 'a forecast never rewrites the statutory baseline');
    assert.equal(forecast.forecastDecisionOn, '2027-01-20');
  });

  it('keeps G3 blocked on a committee resolution until the signed notice is recorded', () => {
    apps.recordApplicationEvent(as('pm'), outline.id, { type: 'committee_resolution', occurredOn: '2026-11-10', payload: { resolution: 'Grant subject to a section 106 agreement', subjectToS106: true } });
    assert.equal(apps.applicationOf(as('pm'), outline.id).status, 'VALID');
    blockedBy(() => gates.approveGate(as('owner'), 'G3', { applicationId: outline.id, rationale: 'Decision' }), /^G3:DECISION$/);
    refused(
      () => apps.recordApplicationEvent(as('pm'), outline.id, { type: 'determined', occurredOn: '2026-11-12', evidence: [document('Draft decision notice')], payload: { outcome: 'GRANTED', issuedBy: 'Example DC' } }),
      'DECISION_NOT_ISSUED',
    );
    const decided = apps.recordApplicationEvent(as('pm'), outline.id, {
      type: 'determined',
      occurredOn: '2026-11-12',
      evidence: [document('Decision notice, signed')],
      payload: { outcome: 'GRANTED', issuedBy: 'Example DC, ref 26/01234/OUT', issuedNotice: true, reservedMattersBy: '2099-11-12', approvedDrawings: [document('Parameter plan')] },
    });
    assert.equal(decided.status, 'DETERMINED');
    assert.ok(platform.ledger.eventsForEntity({ refType: 'PlanningApplication', refId: outline.id }).some((event) => event.eventType === 'PLANNING_DECISION_RECORDED'));
  });

  it('records the permission and the statutory biodiversity condition, then needs conditions verified and the s106 executed', () => {
    const permission = consents.consents(as('pm')).find((entry) => entry.applicationId === outline.id)!;
    assert.equal(permission.type, 'OUTLINE');
    assert.ok(consents.conditions(as('pm'), permission.id).some((condition) => condition.statutory && condition.trigger === 'BEFORE_COMMENCEMENT'));
    blockedBy(() => gates.approveGate(as('owner'), 'G3', { applicationId: outline.id, rationale: 'Decision' }), /^G3:S106$/);

    const c1 = consents.recordCondition(as('pm'), permission.id, { number: '4', wording: 'No development shall take place until a construction management plan has been approved.', interpretation: 'CMP before any works', trigger: 'BEFORE_COMMENCEMENT' });
    consents.recordCondition(as('pm'), permission.id, { number: '9', wording: 'No dwelling shall be occupied until its parking has been laid out.', interpretation: 'Parking before occupation', trigger: 'BEFORE_OCCUPATION' });
    consents.recordCondition(as('pm'), permission.id, { number: '12', wording: 'Phase 2 shall not commence until a noise assessment for that phase is approved.', interpretation: 'Noise for phase 2', trigger: 'BEFORE_COMMENCEMENT', phases: ['Phase 2'] });
    refused(() => consents.verifyCondition(as('pm'), c1.id), 'CONDITION_SAME_PERSON');
    for (const condition of consents.conditions(as('pm'), permission.id).filter((entry) => !entry.verified)) consents.verifyCondition(as('qs'), condition.id);
    refused(() => consents.confirmConditionsComplete(as('pm'), permission.id, { count: 2 }), 'CONDITIONS_COUNT');
    consents.confirmConditionsComplete(as('pm'), permission.id, { count: 3 });

    const s106 = consents.recordObligation(as('pm'), { applicationId: outline.id, instrument: 'S106', instrumentRef: 'S106 dated 20 Nov 2026', clause: 'Sch 2 para 1', kind: 'FINANCIAL', description: 'Education contribution', amountMinor: 24_000_000, indexation: 'BCIS from the agreement date', triggers: [{ event: 'ON_COMMENCEMENT' }], owner: 'Commercial lead' });
    blockedBy(() => gates.approveGate(as('owner'), 'G3', { applicationId: outline.id, rationale: 'Decision' }), /^G3:S106$/);
    consents.progressObligation(as('pm'), s106.id, { to: 'EXECUTED', on: '2026-11-11', evidence: [document('Executed s106')] });
    gates.approveGate(as('owner'), 'G3', { applicationId: outline.id, rationale: 'Decision and agreement recorded' });
  });
});

describe('reserved matters and the release of works', () => {
  let reserved: apps.Application;
  let rmConsent: consents.Consent;

  it('drafts reserved matters only for matters still outstanding, and records their approval', () => {
    const permission = consents.consents(as('pm')).find((entry) => entry.applicationId === outline.id)!;
    refused(() => apps.draftApplication(as('pm'), { route: 'reserved_matters', parentConsentId: permission.id, reservedMatters: ['access'] }), 'RESERVED_MATTERS_NOT_OUTSTANDING');
    reserved = apps.draftApplication(as('pm'), { route: 'reserved_matters', parentConsentId: permission.id, phases: ['Phase 1', 'Phase 2'], reservedMatters: ['appearance', 'landscaping', 'layout', 'scale'], targetSubmissionOn: '2026-11-01' });
    const quote = planning.quoteFeeFor(as('pm'), { route: 'reserved_matters', madeOn: '2026-12-08', dateBasis: 'ASSUMED', dwellings: 44, reservedHistoryThresholdMet: false });
    toReady(reserved.id, quote.id);
    apps.recordApplicationEvent(as('pm'), reserved.id, { type: 'submitted', occurredOn: '2026-11-13', evidence: [document('RM receipt')], payload: { externalRef: 'PP-14200002' } });
    refused(() => apps.recordApplicationEvent(as('pm'), reserved.id, { type: 'validated', occurredOn: '2026-11-14', evidence: [document('RM validation')] }), 'CLOCK_WEEKS_UNKNOWN');
    apps.recordApplicationEvent(as('pm'), reserved.id, { type: 'validated', occurredOn: '2026-11-14', evidence: [document('RM validation')], payload: { statutoryWeeks: 13, weeksBasis: 'Reserved matters for major development' } });
    apps.recordApplicationEvent(as('pm'), reserved.id, { type: 'determined', occurredOn: '2026-11-20', evidence: [document('RM decision notice')], payload: { outcome: 'GRANTED', issuedBy: 'Example DC, ref 26/01500/REM', issuedNotice: true, commencementBy: '2099-11-20', approvedDrawings: [document('Layout plan')] } });
    rmConsent = consents.consents(as('pm')).find((entry) => entry.applicationId === reserved.id)!;
    assert.equal(rmConsent.type, 'RESERVED_MATTERS');
    assert.equal(rmConsent.parentConsentId, permission.id);
    assert.deepEqual(apps.outstandingMatters(as('pm'), permission.id, 'Phase 1'), []);
    consents.confirmConditionsComplete(as('pm'), rmConsent.id, { count: 0 });
    gates.approveGate(as('owner'), 'G3', { applicationId: reserved.id, rationale: 'Reserved matters approved' });
  });

  it('refuses works under the outline alone, and refuses to accept a pre-commencement condition as a risk', () => {
    const permission = consents.consents(as('pm')).find((entry) => entry.applicationId === outline.id)!;
    const onOutline = gates.requestRelease(as('pm'), { gate: 'G4', phase: 'Phase 1', operation: 'COMMENCEMENT', description: 'Groundworks', consentId: permission.id });
    blockedBy(() => gates.approveGate(as('owner'), 'G4', { releaseId: onOutline.id, rationale: 'Release reviewed' }), /^REL:OUTLINE$/);
    gates.withdrawRelease(as('pm'), onOutline.id, { reason: 'Released against the reserved matters instead' });

    const release = gates.requestRelease(as('pm'), { gate: 'G4', phase: 'Phase 1', operation: 'COMMENCEMENT', description: 'Groundworks, plots 1–20', consentId: rmConsent.id });
    refused(() => gates.approveGate(as('pm'), 'G4', { releaseId: release.id, rationale: 'Release reviewed' }), 'ACCESS_DENIED');
    const condition = consents.conditions(as('pm')).find((entry) => entry.number === '4')!;
    refused(
      () => gates.approveGate(as('owner'), 'G4', { releaseId: release.id, rationale: 'Release reviewed', riskAcceptances: [{ blockerId: `COND:${condition.id}`, rationale: 'We are confident it will be approved' }] }),
      'RISK_ACCEPTANCE_REFUSED',
    );
    blockedBy(() => gates.approveGate(as('owner'), 'G4', { releaseId: release.id, rationale: 'Release reviewed' }), /^REL:CIL_NOTICE$/);
  });

  it('records one request for four conditions, the authority approving three and refusing one, with one fee line', () => {
    const permission = consents.consents(as('pm')).find((entry) => entry.applicationId === outline.id)!;
    const ids = consents.conditions(as('pm'), permission.id).map((entry) => entry.id);
    const quote = planning.quoteFeeFor(as('pm'), { route: 'condition_details', madeOn: '2026-12-08', dateBasis: 'ASSUMED' });
    const request = consents.recordConditionRequest(as('pm'), { consentId: permission.id, conditionIds: ids, madeOn: '2026-11-15', feeQuoteId: quote.id, evidence: [document('CMP, noise report, gain plan, parking plan')] });
    refused(() => consents.recordConditionRequest(as('pm'), { consentId: permission.id, conditionIds: [ids[0]!], madeOn: '2026-11-15', evidence: [document('Again')] }), 'REQUEST_CONDITION_STATE');
    const parking = consents.conditions(as('pm')).find((entry) => entry.number === '9')!;
    const decided = consents.recordConditionResponse(as('pm'), request.id, {
      on: '2026-11-19',
      evidence: [document('Discharge decision')],
      outcomes: ids.map((conditionId) => ({ conditionId, outcome: conditionId === parking.id ? 'REFUSED' : 'APPROVED', note: conditionId === parking.id ? 'Layout does not meet standards' : 'Approved' })),
    });
    assert.equal(decided.status, 'DECIDED');
    const statuses = Object.fromEntries(consents.conditions(as('pm'), permission.id).map((entry) => [entry.number, entry.status]));
    assert.deepEqual(statuses, { BNG: 'DISCHARGED', '4': 'DISCHARGED', '9': 'REFUSED', '12': 'DISCHARGED' });
    assert.equal(consents.conditionRequests(as('pm')).filter((entry) => entry.feeQuoteId === quote.id).length, 1, 'one fee line for the request');
  });

  it('releases phase 1 independently while phase 2 waits for its commencement notice, and marks the commencement obligation due', () => {
    const cil = consents.recordObligation(as('pm'), { instrument: 'CIL', instrumentRef: 'CIL liability notice LN-001', clause: 'Reg 67', kind: 'NOTICE', description: 'Commencement notice for phase 1', phases: ['Phase 1'], triggers: [{ event: 'BEFORE_COMMENCEMENT' }], owner: 'Planning lead' });
    consents.progressObligation(as('pm'), cil.id, { to: 'EXECUTED', on: '2026-11-20', evidence: [document('Commencement notice')] });
    consents.progressObligation(as('pm'), cil.id, { to: 'SATISFIED', on: '2026-11-21', evidence: [document('Authority acknowledgement')] });
    const phase1 = gates.releases(as('pm')).find((entry) => entry.phase === 'Phase 1' && entry.status === 'REQUESTED')!;
    gates.approveGate(as('owner'), 'G4', { releaseId: phase1.id, rationale: 'Pre-commencement conditions discharged; notice served' });
    assert.equal(gates.releases(as('pm')).find((entry) => entry.id === phase1.id)!.status, 'APPROVED');
    assert.ok(consents.obligations(as('pm')).find((entry) => entry.instrument === 'S106')!.dueSince, 'the education contribution is now due');

    const phase2 = gates.requestRelease(as('pm'), { gate: 'G4', phase: 'Phase 2', operation: 'COMMENCEMENT', description: 'Groundworks, plots 21–44', consentId: rmConsent.id });
    const blockers = gates.gateBlockers(as('pm'), 'G4', { releaseId: phase2.id });
    assert.deepEqual(blockers.map((blocker) => blocker.id), ['REL:CIL_NOTICE']);
  });

  it('keeps occupation blocked on the refused condition', () => {
    const occupation = gates.requestRelease(as('pm'), { gate: 'G5', phase: 'Phase 1', operation: 'OCCUPATION', description: 'First occupations, plots 1–5', consentId: rmConsent.id });
    const parking = consents.conditions(as('pm')).find((entry) => entry.number === '9')!;
    assert.ok(gates.gateBlockers(as('pm'), 'G5', { releaseId: occupation.id }).some((blocker) => blocker.id === `COND:${parking.id}`));
  });

  it('revokes a live release when a condition it rests on is added, alerting delivery and keeping the history', async () => {
    const permission = consents.consents(as('pm')).find((entry) => entry.applicationId === outline.id)!;
    consents.recordCondition(as('pm'), permission.id, { number: '15', wording: 'No development shall take place until an archaeological written scheme of investigation is approved.', interpretation: 'WSI before works', trigger: 'BEFORE_COMMENCEMENT' });
    const phase1 = gates.releases(as('pm')).find((entry) => entry.phase === 'Phase 1' && entry.operation === 'COMMENCEMENT' && entry.gate === 'G4' && entry.approvedBy)!;
    assert.equal(phase1.status, 'REVOKED');
    assert.match(phase1.revoked!.reasons.join(' '), /Condition 15/);
    assert.ok(platform.ledger.eventsForEntity({ refType: 'PlanningRelease', refId: phase1.id }).some((event) => event.eventType === 'PLANNING_RELEASE_APPROVED'));
    assert.ok(platform.ledger.eventsForEntity({ refType: 'PlanningRelease', refId: phase1.id }).some((event) => event.eventType === 'PLANNING_RELEASE_REVOKED'));
    const findings = (await planningWatchAgent.evaluate!(as('pm'))).findings;
    assert.ok(findings.some((finding) => finding.key === `planning:revoked:${phase1.id}` && finding.severity === 'URGENT'));
  });
});

describe('the planning watch, after release', () => {
  it('reports the commencement obligation due, and works recorded on a task with no live release', async () => {
    write(as('owner'), { eventType: 'TASK_CREATED', entity: { refType: 'Task', refId: 'task-ph2' }, nextState: { id: 'task-ph2', name: 'Phase 2 groundworks', percentComplete: 0 } });
    const phase2 = gates.releases(as('pm')).find((entry) => entry.phase === 'Phase 2' && entry.status === 'REQUESTED')!;
    gates.withdrawRelease(as('pm'), phase2.id, { reason: 'Re-requested against the programme task' });
    gates.requestRelease(as('pm'), { gate: 'G4', phase: 'Phase 2', operation: 'COMMENCEMENT', description: 'Groundworks, plots 21–44', consentId: consents.consents(as('pm')).find((entry) => entry.type === 'RESERVED_MATTERS')!.id, programmeTaskId: 'task-ph2' });
    refused(() => gates.requestRelease(as('pm'), { gate: 'G4', phase: 'Phase 2', operation: 'ABOVE_GROUND', description: 'Superstructure', consentId: consents.consents(as('pm')).find((entry) => entry.type === 'RESERVED_MATTERS')!.id, programmeTaskId: 'no-such-task' }), 'TASK_NOT_FOUND');
    const before = (await planningWatchAgent.evaluate!(as('pm'))).findings;
    assert.ok(!before.some((finding) => finding.key === 'planning:unreleased-works:task-ph2'), 'nothing started, nothing to say');
    write(as('owner'), { eventType: 'TASK_UPDATED', entity: { refType: 'Task', refId: 'task-ph2' }, nextState: { id: 'task-ph2', name: 'Phase 2 groundworks', percentComplete: 15 } });
    const after = (await planningWatchAgent.evaluate!(as('pm'))).findings;
    assert.ok(after.some((finding) => finding.key === 'planning:unreleased-works:task-ph2' && finding.severity === 'URGENT'));
    assert.ok(after.some((finding) => finding.key.startsWith('planning:obligation-due:') && /Education contribution/.test(finding.summary)));
  });
});

describe('a refusal, its appeal and the permission it gives', () => {
  it('links the appeal to the refusal and records the permission the inspector grants', () => {
    const site = planning.siteVersions(as('pm')).at(-1)!;
    const full = planning.recordProposal(as('pm'), { siteVersionId: site.id, scenarioName: 'Full, 30 homes', route: 'full', use: 'HOUSING', dwellingCount: 30, createdGiaM2: 2700 });
    const evaluation = planning.evaluateProposal(as('pm'), { proposalId: full.id });
    gates.approveGate(as('owner'), 'G0', { rationale: 'Second scenario appraised' });
    const application = apps.draftApplication(as('pm'), { route: 'full', proposalId: full.id, targetSubmissionOn: '2026-06-01' });
    toReady(application.id, planning.quoteFeeFor(as('pm'), { route: 'full', madeOn: '2026-12-08', dateBasis: 'ASSUMED', proposalId: full.id }).id, evaluation.id);
    apps.recordApplicationEvent(as('pm'), application.id, { type: 'submitted', occurredOn: '2026-03-01', evidence: [document('Receipt')], payload: { externalRef: 'PP-14100001' } });
    apps.recordApplicationEvent(as('pm'), application.id, { type: 'validated', occurredOn: '2026-03-05', evidence: [document('Validation')] });
    refused(() => apps.recordApplicationEvent(as('pm'), application.id, { type: 'appeal_lodged', occurredOn: '2026-04-01', payload: { appealRef: 'APP/X/26/1' } }), 'APPEAL_NOT_AVAILABLE');
    apps.recordApplicationEvent(as('pm'), application.id, { type: 'determined', occurredOn: '2026-05-20', evidence: [document('Refusal notice')], payload: { outcome: 'REFUSED', issuedBy: 'Example DC', issuedNotice: true } });
    apps.recordApplicationEvent(as('pm'), application.id, { type: 'appeal_lodged', occurredOn: '2026-06-10', payload: { appealRef: 'APP/X/26/3300001' } });
    blockedBy(() => gates.approveGate(as('owner'), 'G3', { applicationId: application.id, rationale: 'Decision' }), /^G3:APPEAL$/);
    apps.recordApplicationEvent(as('pm'), application.id, { type: 'appeal_decided', occurredOn: '2026-10-30', evidence: [document('Appeal decision')], payload: { outcome: 'ALLOWED', inspectorRef: 'APP/X/26/3300001', commencementBy: '2099-10-30' } });
    const decided = apps.applicationOf(as('pm'), application.id);
    assert.equal(decided.decision!.outcome, 'REFUSED', 'the original refusal is kept');
    assert.equal(decided.appeal!.outcome, 'ALLOWED');
    const permission = consents.consents(as('pm')).find((entry) => entry.applicationId === application.id)!;
    assert.equal(permission.viaAppeal, true);
    assert.equal(permission.decidedOn, '2026-10-30');
  });
});

describe('study scheduling', () => {
  it('finds the next day inside a survey window, including one that wraps the year end', () => {
    assert.equal(studies.nextInWindow('2099-05-01', { from: '04-15', to: '09-30' }), '2099-05-01');
    assert.equal(studies.nextInWindow('2099-01-10', { from: '04-15', to: '09-30' }), '2099-04-15');
    assert.equal(studies.nextInWindow('2099-10-10', { from: '04-15', to: '09-30' }), '2100-04-15');
    assert.equal(studies.nextInWindow('2099-12-15', { from: '11-01', to: '02-28' }), '2099-12-15');
    assert.equal(studies.nextInWindow('2099-03-15', { from: '11-01', to: '02-28' }), '2099-11-01');
  });

  it('generates required studies from the findings and the rest for a planner, and flags a survey window on the critical path', () => {
    const full = planning.proposals(as('pm')).find((entry) => entry.scenarioName === 'Full, 30 homes')!;
    const application = apps.draftApplication(as('pm'), { route: 'full', proposalId: full.id, targetSubmissionOn: '2099-06-01', landOptionExpiresOn: '2099-12-31' });
    const generated = studies.generateStudies(as('pm'), application.id);
    assert.equal(generated.length, 10);
    assert.equal(studies.generateStudies(as('pm'), application.id).length, 0, 'never twice');
    const byTemplate = new Map(generated.map((entry) => [entry.template, entry]));
    assert.equal(byTemplate.get('FRA_SUDS')!.applicability, 'REQUIRED', 'Flood Zone 1 at 3 ha');
    assert.equal(byTemplate.get('ECOLOGY_BNG')!.applicability, 'REQUIRED', 'BNG applies');
    assert.equal(byTemplate.get('HERITAGE')!.applicability, 'REVIEW');

    refused(() => studies.updateStudy(as('pm'), byTemplate.get('HERITAGE')!.id, { applicability: 'NOT_REQUIRED' }), 'PLANNING_FIELD_REQUIRED');
    studies.updateStudy(as('pm'), byTemplate.get('HERITAGE')!.id, { applicability: 'NOT_REQUIRED', applicabilityNote: 'HER search: no records within 500 m' });
    refused(() => studies.updateStudy(as('pm'), byTemplate.get('ECOLOGY_BNG')!.id, { surveyWindow: { from: 'April', to: 'Sept' } }), 'STUDY_WINDOW');
    studies.updateStudy(as('pm'), byTemplate.get('ECOLOGY_BNG')!.id, { commissionBy: '2099-01-10', durationWeeks: 8, surveyWindow: { from: '04-15', to: '09-30' }, consultant: 'Example Ecology Ltd' });
    studies.updateStudy(as('pm'), byTemplate.get('FRA_SUDS')!.id, { commissionBy: '2099-01-10', durationWeeks: 6, dependsOn: [byTemplate.get('GROUND')!.id] });
    studies.updateStudy(as('pm'), byTemplate.get('GROUND')!.id, { applicability: 'REQUIRED', applicabilityNote: 'Historic land use: former works', commissionBy: '2099-01-10', durationWeeks: 4 });
    refused(() => studies.updateStudy(as('pm'), byTemplate.get('GROUND')!.id, { dependsOn: [byTemplate.get('FRA_SUDS')!.id] }), 'STUDY_DEPENDENCY_LOOP');

    const schedule = new Map(studies.studySchedule(as('pm'), application.id).map((entry) => [entry.template, entry]));
    const ecology = schedule.get('ECOLOGY_BNG')!;
    assert.equal(ecology.start, '2099-04-15');
    assert.equal(ecology.finish, '2099-06-10');
    assert.equal(ecology.waitedForWindowDays, 95);
    assert.match(ecology.critical.join(' '), /after the target submission .* waits 95 days for its survey window/);
    const fra = schedule.get('FRA_SUDS')!;
    assert.equal(fra.start, '2099-02-07', 'after the ground investigation it depends on');
    assert.deepEqual(fra.critical, []);
    assert.ok(!schedule.has('HERITAGE'), 'a study ruled out is not scheduled');
    assert.match(schedule.get('TRANSPORT')!.critical.join(' '), /^$/);
    assert.ok(planningRegister(as('pm')).studies.some((entry) => entry.template === 'ECOLOGY_BNG'));
  });
});

describe('the register and the routes', () => {
  it('reads everything in one register, and refuses the module to an ungranted company', () => {
    const register = planningRegister(as('planner'));
    assert.ok(register.applications.length >= 3);
    assert.ok(register.gates.releases.length >= 3);
    assert.ok(register.consents.some((consent) => consent.lineage.length === 1));
    refused(() => planningRegister({ ...as('owner'), grantedModules: [] }), 'MODULE_NOT_GRANTED');
    // A settled approval shows nothing blocking: not its accepted risk, not checks that no longer apply.
    const decided = register.gates.applications.find((entry) => entry.applicationId === outline.id)!;
    for (const position of decided.gates.slice(0, 2)) {
      assert.equal(position.status, 'approved', position.gate);
      assert.deepEqual(position.blockers, [], position.gate);
    }
    // Condition 15 was added after G3 and is unverified: the decision record needs re-review.
    assert.equal(decided.gates[2]!.status, 'superseded');
    assert.ok(decided.gates[2]!.blockers.some((blocker) => /Condition 15/.test(blocker.reason)));
    assert.equal(decided.gates[0]!.review!.riskAcceptances[0]!.blockerId, 'G1:UNQUOTED');
  });

  it('publishes a door for every command', () => {
    const paths = new Set(ROUTES.map((route) => `${route.method} ${route.pattern}`));
    const P = '/v1/projects/:projectId/planning';
    for (const path of [
      `GET ${P}/register`, `GET ${P}/rule-versions/:version`, `POST ${P}/applications`, `POST ${P}/applications/:applicationId/events`,
      `POST ${P}/applications/:applicationId/requirements/generate`, `POST ${P}/requirements`, `PATCH ${P}/requirements/:requirementId`,
      `POST ${P}/requirements/:requirementId/reviews`, `POST ${P}/packs`, `GET ${P}/packs/:packId`, `POST ${P}/gates/:gate/reviews`,
      `POST ${P}/consents/:consentId/conditions`, `POST ${P}/conditions/:conditionId/verify`, `POST ${P}/consents/:consentId/conditions-complete`,
      `POST ${P}/consents/:consentId/status`, `POST ${P}/condition-requests`, `PATCH ${P}/condition-requests/:requestId`, `POST ${P}/obligations`,
      `PATCH ${P}/obligations/:obligationId`, `POST ${P}/releases`, `POST ${P}/releases/:releaseId/withdraw`,
      `POST ${P}/applications/:applicationId/studies/generate`, `PATCH ${P}/studies/:studyId`,
    ]) assert.ok(paths.has(path), path);
  });

  it('shows the differences between the two fee schedules and their impact', () => {
    const detail = planning.ruleVersionDetail(as('pm'), 'england-2026-12-08');
    assert.equal(detail.comparedWith, 'england-2026-04-01');
    assert.ok(detail.differences.some((entry) => entry.path === 'full.middleUpTo' && entry.from === 50 && entry.to === 49));
    assert.deepEqual(detail.changedSinceChecked, []);
    assert.ok(detail.impact.payableQuotes >= 4);
  });
});
