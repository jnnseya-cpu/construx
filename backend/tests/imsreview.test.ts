import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { imsFindings } from '../src/agents/ims.ts';
import { ROUTES } from '../src/api/routes.ts';
import { actionOf } from '../src/domain/ims/actions.ts';
import { clausesFor } from '../src/domain/ims/clauses.ts';
import * as docs from '../src/domain/ims/documents.ts';
import * as ims from '../src/domain/ims/ims.ts';
import * as review from '../src/domain/ims/review.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { recordIncident } from '../src/engines/safety.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The company-wide view and management review: the position counted from every
 * project and the system, frozen as a review's inputs; each input minuted; the
 * decisions and the actions they raise; approved by top management, not by the
 * person who prepared it, and fixed thereafter.
 */

let platform: Platform;
let seed: SeedResult;
const company = (who: string): EngineContext => platform.context(seed.users[who]!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
const people = () => platform.users(seed.tenantId).map((user) => ({ id: user.id, name: user.name, roles: user.roles, status: user.status }));
const refused = (fn: () => unknown, code: string) => assert.throws(fn, (error: { code?: string }) => error.code === code, `expected ${code}`);
const period = () => ({ from: ims.addMonths(ims.today(), -12), to: ims.today() });

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  platform.setModuleGrant({ moduleId: 'IMS', tenantId: seed.tenantId, status: 'ACTIVE', reason: 'IMS review test', decidedBy: seed.users.operator!.id });
  recordIncident(platform.context(seed.users.safety!.auth, seed.projectId, { source: 'WEB' }), {
    occurredAt: `${ims.addDays(ims.today(), -3)}T08:00:00Z`,
    location: 'Haul road',
    category: 'NEAR_MISS',
    description: 'Dumper reversed without a banksman',
    immediateAction: 'Works stopped; briefing given',
    personsInvolved: [],
    riddorReportable: false,
    evidenceHash: 'a'.repeat(64),
  });
});

describe('the company-wide position', () => {
  it('counts every input from the records across the projects', () => {
    const position = review.companyPosition(company('pm'), people(), period());
    assert.ok(position.projects >= 1);
    const keys = position.inputs.map((input) => input.key);
    for (const key of ['previousActions', 'objectives', 'nonconformities', 'incidents', 'audits', 'compliance', 'aspects', 'suppliers', 'resources', 'documents', 'context', 'consultation', 'customers', 'emergency']) assert.ok(keys.includes(key), key);
    const incidents = position.inputs.find((input) => input.key === 'incidents')!;
    assert.ok(Number(incidents.figures.incidents) >= 1);
    assert.match(incidents.summary, /near miss/);
    refused(() => review.companyPosition(company('pm'), people(), { from: '2026-12-01', to: '2026-01-01' }), 'IMS_PERIOD');
  });

  it('is refused without the module grant and outside the company record', () => {
    const onProject = platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
    refused(() => review.companyPosition(onProject, people(), period()), 'IMS_COMPANY_RECORD');
  });
});

describe('a management review', () => {
  let id: string;

  it('is chaired by top management and freezes the position as its inputs, with a hash', () => {
    refused(() => review.openReview(company('qaqc'), people(), { periodFrom: period().from, periodTo: period().to, heldOn: ims.today(), chairId: seed.users.qaqc!.id }), 'IMS_REVIEW_CHAIR');
    const opened = review.openReview(company('qaqc'), people(), { periodFrom: period().from, periodTo: period().to, heldOn: ims.today(), chairId: seed.users.owner!.id, attendees: ['Quality manager', 'HSE manager'] });
    id = opened.id;
    assert.equal(opened.reference, 'MR-001');
    assert.equal(opened.inputs.length, 14);
    assert.match(opened.inputsHash, /^sha256:[a-f0-9]{64}$/);
  });

  it('cannot be approved until every input is minuted and an output recorded, nor by its preparer', () => {
    refused(() => review.approveReview(company('owner'), id, { note: 'Approved' }), 'IMS_REVIEW_INCOMPLETE');
    const opened = review.reviewOf(company('pm'), id);
    for (const input of opened.inputs) review.minuteInput(company('qaqc'), id, { key: input.key, text: `Discussed: ${input.summary.slice(0, 80)} — no further action beyond the outputs.` });
    refused(() => review.minuteInput(company('qaqc'), id, { key: 'weather', text: 'Not an input of the review' }), 'IMS_REVIEW_INPUT');
    const before = review.reviewOf(company('pm'), id).version;
    review.minuteInput(company('qaqc'), id, { key: 'objectives', text: review.reviewOf(company('pm'), id).minutes.objectives! });
    assert.equal(review.reviewOf(company('pm'), id).version, before, 'the same minute again writes nothing');
    refused(() => review.approveReview(company('owner'), id, { note: 'Approved' }), 'IMS_REVIEW_NO_OUTPUT');
    const withOutput = review.addOutput(company('qaqc'), id, { kind: 'IMPROVEMENT', text: 'Banksman briefing added to every site induction', action: { ownerId: seed.users.safety!.id, dueOn: '2099-01-31', standards: ['ISO45001'] } });
    const actionId = withOutput.outputs[0]!.actionId!;
    assert.equal(actionOf(company('pm'), actionId).source.kind, 'MANAGEMENT_REVIEW');
    review.addOutput(company('qaqc'), id, { kind: 'RESOURCE', text: 'A second HSE adviser for the northern projects' });
    refused(() => review.approveReview(company('safety'), id, { note: 'Approved' }), 'IMS_REVIEW_TOP_MANAGEMENT');
    // The owner prepares a second review and may not approve their own.
    const own = review.openReview(company('owner'), people(), { periodFrom: period().from, periodTo: period().to, heldOn: ims.today(), chairId: seed.users.owner!.id });
    refused(() => review.approveReview(company('owner'), own.id, { note: 'My own' }), 'IMS_REVIEW_SAME_PERSON');
  });

  it('is approved by top management and does not change afterwards', () => {
    const approved = review.approveReview(company('owner'), id, { note: 'The system is suitable, adequate and effective, with the actions above' });
    assert.equal(approved.status, 'APPROVED');
    refused(() => review.minuteInput(company('qaqc'), id, { key: 'objectives', text: 'A late change to the minutes' }), 'IMS_REVIEW_APPROVED');
    refused(() => review.addOutput(company('qaqc'), id, { kind: 'DECISION', text: 'A decision added after approval' }), 'IMS_REVIEW_APPROVED');
    const register = review.reviewRegister(company('pm'), people());
    assert.equal(register.lastApprovedOn, ims.today());
    assert.equal(register.nextDueBy, ims.addMonths(ims.today(), 12));
  });

  it('carries the previous review’s actions into the next review’s inputs', () => {
    const next = review.companyPosition(company('pm'), people(), { from: ims.addDays(ims.today(), 1), to: ims.addDays(ims.today(), 2) });
    const previous = next.inputs.find((input) => input.key === 'previousActions')!;
    assert.equal(previous.figures.previousReview, 'MR-001');
    assert.equal(previous.figures.raised, 1);
  });
});

describe('the watch and the routes', () => {
  it('reports a system in force with no management review', async () => {
    const fresh = new Platform();
    const freshSeed = await seedDemoProject(fresh);
    fresh.setModuleGrant({ moduleId: 'IMS', tenantId: freshSeed.tenantId, status: 'ACTIVE', reason: 'Watch test', decidedBy: freshSeed.users.operator!.id });
    const at = (who: string) => fresh.context(freshSeed.users[who]!.auth, `${freshSeed.tenantId}-governance`, { source: 'WEB' });
    const document = docs.draftDocument(at('qaqc'), { type: 'POLICY', title: 'IMS policy', standards: ['ISO9001'], clauses: clausesFor('5.2', ['ISO9001']), ownerId: freshSeed.users.owner!.id, content: 'We commit to meeting requirements and to continual improvement of the management system.' });
    assert.ok(!imsFindings(at('pm'), ims.today()).some((finding) => finding.key.startsWith('ims:review-due')), 'nothing in force yet');
    docs.approveDocument(at('safety'), document.id, { note: 'Approved' });
    assert.ok(imsFindings(at('pm'), ims.today()).some((finding) => finding.key === 'ims:review-due:never'));
  });

  it('publishes every review action as a route', () => {
    const paths = new Set(ROUTES.map((route) => `${route.method} ${route.pattern}`));
    for (const path of ['GET /v1/ims/position', 'POST /v1/ims/reviews', 'POST /v1/ims/reviews/:reviewId/refresh', 'PUT /v1/ims/reviews/:reviewId/minutes', 'POST /v1/ims/reviews/:reviewId/outputs', 'POST /v1/ims/reviews/:reviewId/approve']) {
      assert.ok(paths.has(path), path);
    }
  });
});
