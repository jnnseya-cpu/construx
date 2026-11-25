import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { imsFindings } from '../src/agents/ims.ts';
import { ROUTES } from '../src/api/routes.ts';
import * as ims from '../src/domain/ims/ims.ts';
import * as monitoring from '../src/domain/ims/monitoring.ts';
import * as riddor from '../src/domain/riddor.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { recordIncident } from '../src/engines/safety.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The three things that were only half there: the RIDDOR clock (the kind of
 * report, its due date, the report made — late recorded as late), supplier
 * performance evaluated against the company's own score, and the competence
 * matrix of what each role requires against what each person holds.
 */

let platform: Platform;
let seed: SeedResult;
const company = (who: string): EngineContext => platform.context(seed.users[who]!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
const onProject = (who: string): EngineContext => platform.context(seed.users[who]!.auth, seed.projectId, { source: 'WEB' });
const people = () => platform.users(seed.tenantId).map((user) => ({ id: user.id, name: user.name, roles: user.roles, status: user.status }));
const refused = (fn: () => unknown, code: string) => assert.throws(fn, (error: { code?: string }) => error.code === code, `expected ${code}`);
const daysAgo = (n: number) => ims.addDays(ims.today(), -n);

function incident(daysBack: number, category: 'RIDDOR_REPORTABLE' | 'LOST_TIME' | 'DANGEROUS_OCCURRENCE', description: string) {
  return recordIncident(onProject('safety'), {
    occurredAt: `${daysAgo(daysBack)}T09:30:00Z`,
    location: 'Level 3 slab',
    category,
    description,
    immediateAction: 'Area made safe; first aid given',
    personsInvolved: [],
    riddorReportable: true,
    evidenceHash: 'b'.repeat(64),
  });
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  platform.setModuleGrant({ moduleId: 'IMS', tenantId: seed.tenantId, status: 'ACTIVE', reason: 'IMS monitoring test', decidedBy: seed.users.operator!.id });
});

describe('the RIDDOR clock', () => {
  let fracture: { incidentId: string; reference: string };
  let absence: { incidentId: string; reference: string };

  it('puts a reportable incident on the clock unclassified, with no due date until its kind is recorded', () => {
    fracture = incident(4, 'RIDDOR_REPORTABLE', 'Operative fractured a wrist falling from a stepladder');
    const position = riddor.riddorClock(onProject('pm')).incidents.find((entry) => entry.incidentId === fracture.incidentId)!;
    assert.equal(position.status, 'UNCLASSIFIED');
    assert.equal(position.dueOn, null);
  });

  it('sets the due date by the kind of report: ten days for a specified injury, fifteen for over-seven-day', () => {
    refused(() => riddor.classifyRiddor(onProject('pm'), fracture.incidentId, { kind: 'SPECIFIED_INJURY', note: 'Fracture of the wrist — a specified injury' }), 'ACCESS_DENIED');
    refused(() => riddor.classifyRiddor(onProject('safety'), fracture.incidentId, { kind: 'BROKEN_ARM', note: 'Fracture of the wrist — a specified injury' }), 'RIDDOR_KIND');
    const specified = riddor.classifyRiddor(onProject('safety'), fracture.incidentId, { kind: 'SPECIFIED_INJURY', note: 'Fracture of the wrist, other than a finger or thumb — a specified injury' });
    assert.equal(specified.dueOn, ims.addDays(daysAgo(4), 10));
    absence = incident(20, 'LOST_TIME', 'Back strain lifting kerbs; signed off for ten days');
    const overSeven = riddor.classifyRiddor(onProject('safety'), absence.incidentId, { kind: 'OVER_SEVEN_DAY', note: 'Incapacitated for more than seven consecutive days, not counting the day of the accident' });
    assert.equal(overSeven.dueOn, ims.addDays(daysAgo(20), 15));
    const clock = riddor.riddorClock(onProject('pm')).incidents;
    assert.equal(clock.find((entry) => entry.incidentId === fracture.incidentId)!.status, 'DUE');
    assert.equal(clock.find((entry) => entry.incidentId === fracture.incidentId)!.daysLeft, 6);
    assert.equal(clock.find((entry) => entry.incidentId === absence.incidentId)!.status, 'OVERDUE');
  });

  it('needs the diagnosis date for a disease', () => {
    const disease = incident(1, 'RIDDOR_REPORTABLE', 'Operative diagnosed with hand-arm vibration syndrome');
    refused(() => riddor.classifyRiddor(onProject('safety'), disease.incidentId, { kind: 'OCCUPATIONAL_DISEASE', note: 'Hand-arm vibration syndrome diagnosed by the occupational physician' }), 'RIDDOR_DIAGNOSIS_DATE');
    const classified = riddor.classifyRiddor(onProject('safety'), disease.incidentId, { kind: 'OCCUPATIONAL_DISEASE', diagnosedOn: ims.today(), note: 'Hand-arm vibration syndrome diagnosed by the occupational physician' });
    assert.equal(classified.dueOn, ims.today(), 'reported without delay once diagnosed');
  });

  it('records the report: telephone only for deaths and specified injuries, a late report only with its reason', () => {
    refused(() => riddor.recordRiddorReport(onProject('safety'), absence.incidentId, { reportedOn: ims.today(), hseReference: '1234567', method: 'TELEPHONE' }), 'RIDDOR_METHOD');
    refused(() => riddor.recordRiddorReport(onProject('safety'), absence.incidentId, { reportedOn: ims.today(), hseReference: '1234567', method: 'ONLINE' }), 'RIDDOR_LATE_REASON');
    refused(() => riddor.recordRiddorReport(onProject('safety'), absence.incidentId, { reportedOn: ims.addDays(ims.today(), 2), hseReference: '1234567', method: 'ONLINE' }), 'RIDDOR_REPORTED_ON');
    const late = riddor.recordRiddorReport(onProject('safety'), absence.incidentId, { reportedOn: ims.today(), hseReference: '1234567', method: 'ONLINE', lateReason: 'The absence was only reported to the site office on day 18' });
    assert.equal(late.report!.late, true);
    const onTime = riddor.recordRiddorReport(onProject('safety'), fracture.incidentId, { reportedOn: daysAgo(3), hseReference: '7654321', method: 'TELEPHONE' });
    assert.equal(onTime.report!.late, false);
    refused(() => riddor.recordRiddorReport(onProject('safety'), fracture.incidentId, { reportedOn: daysAgo(2), hseReference: '7654322', method: 'ONLINE' }), 'RIDDOR_ALREADY_REPORTED');
    refused(() => riddor.classifyRiddor(onProject('safety'), fracture.incidentId, { kind: 'DEATH', note: 'Reclassified after the report was made' }), 'RIDDOR_ALREADY_REPORTED');
    const statuses = riddor.riddorClock(onProject('pm')).incidents.map((entry) => entry.status);
    assert.ok(statuses.includes('REPORTED') && statuses.includes('REPORTED_LATE'));
  });

  it('is rolled up across the company’s projects for the management system', () => {
    const company_ = monitoring.riddorCompany(company('pm'));
    assert.ok(company_.length >= 3);
    assert.ok(company_.every((entry) => entry.project && entry.project !== entry.projectId));
  });
});

describe('supplier performance', () => {
  it('evaluates an approved supplier on five headings, and puts it to review below the company’s score', () => {
    const suppliers = monitoring.supplierPerformance(company('pm'), people());
    assert.ok(suppliers.length > 0, 'the seed prequalifies a supply chain');
    const approved = suppliers.find((supplier) => supplier.status !== 'SUSPENDED' && supplier.status !== 'REGISTERED')!;
    assert.equal(approved.evaluationDue, true, 'an approved supplier never evaluated is due');
    refused(() => monitoring.evaluateSupplier(company('pm'), { supplierId: approved.supplierId, scores: { quality: 6, safety: 3, environment: 3, programme: 3, commercial: 3 }, comments: 'Out of range score' }), 'IMS_SCORE');
    refused(() => monitoring.evaluateSupplier(company('pm'), { supplierId: 'no-such-firm', scores: { quality: 3, safety: 3, environment: 3, programme: 3, commercial: 3 }, comments: 'A firm we never used' }), 'SUPPLIER_NOT_FOUND');
    refused(() => monitoring.evaluateSupplier(company('planner'), { supplierId: approved.supplierId, scores: { quality: 3, safety: 3, environment: 3, programme: 3, commercial: 3 }, comments: 'A reader cannot evaluate' }), 'ACCESS_DENIED');
    const evaluation = monitoring.evaluateSupplier(company('pm'), { supplierId: approved.supplierId, projectId: seed.projectId, scores: { quality: 2, safety: 2, environment: 3, programme: 2, commercial: 3 }, comments: 'Two NCRs on the drainage, one late handover and a near miss on the haul road' });
    assert.equal(evaluation.average, 2.4);
    const after = monitoring.supplierPerformance(company('pm'), people()).find((supplier) => supplier.supplierId === approved.supplierId)!;
    assert.equal(after.toReview, true);
    assert.equal(after.evaluationDue, false);
    assert.equal(after.nextEvaluationDue, ims.addMonths(ims.today(), 6));
    assert.ok(imsFindings(company('pm'), ims.today()).some((finding) => finding.key.startsWith(`ims:supplier-review:${approved.supplierId}:`)));
  });
});

describe('the competence matrix', () => {
  it('requires competences of roles, once each', () => {
    monitoring.requireCompetence(company('safety'), { role: 'PM', competence: 'SMSTS', note: 'Site Management Safety Training Scheme' });
    monitoring.requireCompetence(company('safety'), { role: 'PM', competence: 'First aid at work' });
    refused(() => monitoring.requireCompetence(company('safety'), { role: 'PM', competence: 'smsts' }), 'IMS_COMPETENCE_EXISTS');
    refused(() => monitoring.requireCompetence(company('safety'), { role: 'ASTRONAUT', competence: 'EVA' }), 'IMS_DISTRIBUTION');
  });

  it('shows each person’s holdings against their role: missing, expiring, held', () => {
    let row = monitoring.competenceMatrix(company('pm'), people()).rows.find((entry) => entry.personId === seed.users.pm!.id)!;
    assert.deepEqual(row.cells.map((cell) => cell.status), ['MISSING', 'MISSING']);
    refused(() => monitoring.recordHolding(company('pm'), people(), { personId: seed.users.pm!.id, competence: 'SMSTS', issuedOn: daysAgo(400), expiresOn: ims.addDays(ims.today(), 30), certificateHash: 'c'.repeat(64) }), 'ACCESS_DENIED');
    monitoring.recordHolding(company('safety'), people(), { personId: seed.users.pm!.id, competence: 'SMSTS', issuedOn: daysAgo(400), expiresOn: ims.addDays(ims.today(), 30), certificateHash: 'c'.repeat(64) });
    monitoring.recordHolding(company('safety'), people(), { personId: seed.users.pm!.id, competence: 'First Aid at Work', issuedOn: daysAgo(30), expiresOn: ims.addDays(ims.today(), 1000), certificateHash: 'd'.repeat(64) });
    refused(() => monitoring.recordHolding(company('safety'), people(), { personId: 'nobody', competence: 'SMSTS', issuedOn: daysAgo(10), expiresOn: ims.addDays(ims.today(), 100), certificateHash: 'e'.repeat(64) }), 'IMS_PERSON_NOT_FOUND');
    const matrix = monitoring.competenceMatrix(company('pm'), people());
    row = matrix.rows.find((entry) => entry.personId === seed.users.pm!.id)!;
    assert.deepEqual(row.cells.map((cell) => cell.status), ['EXPIRING', 'HELD'], 'matched by name, whatever the case');
    assert.equal(row.gaps, 0);
  });

  it('stops requiring a competence with the reason, and publishes every route', () => {
    const requirement = monitoring.competenceRequirements(company('pm')).find((entry) => entry.competence === 'First aid at work')!;
    monitoring.removeCompetenceRequirement(company('safety'), requirement.id, { reason: 'Covered by the site first-aider rota instead' });
    const row = monitoring.competenceMatrix(company('pm'), people()).rows.find((entry) => entry.personId === seed.users.pm!.id)!;
    assert.equal(row.cells.length, 1);
    const paths = new Set(ROUTES.map((route) => `${route.method} ${route.pattern}`));
    for (const path of ['POST /v1/ims/suppliers/:supplierId/evaluations', 'POST /v1/ims/competence/requirements', 'POST /v1/ims/competence/requirements/:requirementId/remove', 'POST /v1/ims/competence/records', 'GET /v1/projects/:projectId/safety/riddor', 'POST /v1/projects/:projectId/safety/incidents/:incidentId/riddor-classification', 'POST /v1/projects/:projectId/safety/incidents/:incidentId/riddor-report']) {
      assert.ok(paths.has(path), path);
    }
  });
});
