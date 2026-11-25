import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { imsFindings } from '../src/agents/ims.ts';
import { ROUTES } from '../src/api/routes.ts';
import { CLAUSES, clausesFor, isClauseId } from '../src/domain/ims/clauses.ts';
import * as docs from '../src/domain/ims/documents.ts';
import * as ims from '../src/domain/ims/ims.ts';
import { imsOverview, documentDetail } from '../src/domain/ims/overview.ts';
import { write, type EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The management system's controlled documents: a policy turned into a
 * procedure, approved by somebody other than its author, issued to roles who
 * each acknowledge it, revised, reviewed and withdrawn — all on the company's
 * record, never on a project.
 */

let platform: Platform;
let seed: SeedResult;
const company = (who: string): EngineContext => platform.context(seed.users[who]!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
const people = () => platform.users(seed.tenantId).map((user) => ({ id: user.id, name: user.name, roles: user.roles, status: user.status }));
const refused = (fn: () => unknown, code: string) => assert.throws(fn, (error: { code?: string }) => error.code === code, `expected ${code}`);

const PROCEDURE = 'Purpose: to control documented information. Scope: every controlled document. Responsibilities: the owner keeps it current; the quality manager approves it.';

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

describe('the clause catalogue', () => {
  it('holds the harmonised structure of all three standards, headings only', () => {
    for (const id of ['ISO9001:7.5', 'ISO14001:7.5', 'ISO45001:7.5', 'ISO9001:8.4', 'ISO14001:6.1.2', 'ISO45001:5.4', 'ISO45001:10.2', 'ISO9001:9.3']) assert.ok(isClauseId(id), id);
    assert.ok(!isClauseId('ISO14001:8.4'), '8.4 is a quality clause only');
    assert.equal(CLAUSES.find((clause) => clause.id === 'ISO45001:10.2')!.title, 'Incident, nonconformity and corrective action');
    assert.deepEqual(clausesFor('9.2'), ['ISO9001:9.2', 'ISO14001:9.2', 'ISO45001:9.2']);
  });
});

describe('the module and the company record', () => {
  it('is refused until the operator grants it', () => {
    refused(() => imsOverview(company('owner'), people()), 'MODULE_NOT_GRANTED');
    platform.setModuleGrant({ moduleId: 'IMS', tenantId: seed.tenantId, status: 'ACTIVE', reason: 'IMS test', decidedBy: seed.users.operator!.id });
    assert.equal(imsOverview(company('owner'), people()).documents.length, 0);
  });

  it('is kept on the company’s record, not on a project', () => {
    const onProject = platform.context(seed.users.qaqc!.auth, seed.projectId, { source: 'WEB' });
    refused(() => docs.draftDocument(onProject, { type: 'PROCEDURE', title: 'Document control', standards: ['ISO9001'], ownerId: seed.users.qaqc!.id, content: PROCEDURE }), 'IMS_COMPANY_RECORD');
  });

  it('lets only the authoring roles draft', () => {
    refused(() => docs.draftDocument(company('planner'), { type: 'PROCEDURE', title: 'Document control', standards: ['ISO9001'], ownerId: seed.users.qaqc!.id, content: PROCEDURE }), 'ACCESS_DENIED');
  });
});

describe('a procedure from draft to withdrawal', () => {
  let id: string;

  it('refuses a clause the document’s standards do not have, an unknown role and an empty document', () => {
    refused(() => docs.draftDocument(company('qaqc'), { type: 'PROCEDURE', title: 'Document control', standards: ['ISO9001'], clauses: ['ISO14001:7.5'], ownerId: seed.users.qaqc!.id, content: PROCEDURE }), 'IMS_CLAUSE_STANDARD');
    refused(() => docs.draftDocument(company('qaqc'), { type: 'PROCEDURE', title: 'Document control', standards: ['ISO9001'], clauses: ['ISO9001:99'], ownerId: seed.users.qaqc!.id, content: PROCEDURE }), 'IMS_CLAUSE_UNKNOWN');
    refused(() => docs.draftDocument(company('qaqc'), { type: 'PROCEDURE', title: 'Document control', standards: ['ISO9001'], ownerId: seed.users.qaqc!.id, distribution: ['ASTRONAUT'], content: PROCEDURE }), 'IMS_DISTRIBUTION');
    refused(() => docs.draftDocument(company('qaqc'), { type: 'PROCEDURE', title: 'Document control', standards: ['ISO9001'], ownerId: seed.users.qaqc!.id, content: 'Short' }), 'IMS_CONTENT_REQUIRED');
  });

  it('drafts PRO-001 for all three standards, not yet in force', () => {
    const document = docs.draftDocument(company('qaqc'), {
      type: 'PROCEDURE',
      title: 'Control of documented information',
      standards: ['ISO9001', 'ISO14001', 'ISO45001'],
      clauses: clausesFor('7.5'),
      ownerId: seed.users.qaqc!.id,
      distribution: ['PM', 'QS'],
      content: PROCEDURE,
    });
    id = document.id;
    assert.equal(document.reference, 'PRO-001');
    assert.equal(document.status, 'DRAFT');
    assert.equal(document.effectiveRevision, null);
    refused(() => docs.acknowledgeDocument(company('pm'), id), 'IMS_DOCUMENT_NOT_EFFECTIVE');
  });

  it('is approved only by somebody other than its author, then due for review in twelve months', () => {
    refused(() => docs.approveDocument(company('qaqc'), id, { note: 'My own work' }), 'IMS_APPROVAL_SAME_PERSON');
    refused(() => docs.approveDocument(company('pm'), id, { note: 'Checked against 7.5' }), 'ACCESS_DENIED');
    docs.returnDocument(company('safety'), id, { reason: 'Add how obsolete documents are kept from use' });
    const redrafted = docs.redraftDocument(company('qaqc'), id, { changeSummary: 'Added obsolete document control', content: `${PROCEDURE} Obsolete documents are marked superseded and kept from use.` });
    assert.equal(redrafted.revisions.length, 1, 'the open draft is redrafted in place');
    assert.equal(redrafted.revisions[0]!.returns!.length, 1, 'the return stays on the record');
    const approved = docs.approveDocument(company('safety'), id, { note: 'Checked against 7.5 of all three' });
    assert.equal(approved.status, 'EFFECTIVE');
    assert.equal(approved.effectiveRevision, 1);
    assert.equal(approved.reviewDueOn, ims.addMonths(ims.today(), 12));
  });

  it('is acknowledged by each person in the roles it is issued to, once per revision', () => {
    let position = docs.documentRegister(company('pm'), people()).find((entry) => entry.id === id)!;
    const required = position.acknowledgement.required;
    assert.ok(required >= 2, 'the PM and the QS at least');
    assert.equal(position.acknowledgement.acknowledged, 0);
    assert.equal(position.acknowledgement.mustAcknowledge, true);
    docs.acknowledgeDocument(company('pm'), id);
    refused(() => docs.acknowledgeDocument(company('pm'), id), 'IMS_ALREADY_ACKNOWLEDGED');
    // A reader outside the distribution may still acknowledge; it does not count towards it.
    docs.acknowledgeDocument(company('planner'), id);
    position = docs.documentRegister(company('pm'), people()).find((entry) => entry.id === id)!;
    assert.equal(position.acknowledgement.acknowledged, 1);
    assert.ok(position.acknowledgement.outstanding.some((person) => person.id === seed.users.qs!.id));
    assert.equal(position.acknowledgement.mine, true);
  });

  it('keeps revision 1 in force while revision 2 is drafted, then supersedes it and asks everyone again', () => {
    refused(() => docs.redraftDocument(company('qaqc'), id, { changeSummary: 'x' }), 'IMS_FIELD_REQUIRED');
    const drafting = docs.redraftDocument(company('qaqc'), id, { changeSummary: 'Electronic signatures accepted', content: `${PROCEDURE} Electronic approval is accepted.` });
    assert.equal(drafting.effectiveRevision, 1);
    assert.equal(drafting.status, 'EFFECTIVE');
    docs.approveDocument(company('owner'), id, { note: 'Approved by the director' });
    const detail = documentDetail(company('pm'), id, people());
    assert.deepEqual(detail.revisions.map((revision) => revision.status), ['SUPERSEDED', 'EFFECTIVE']);
    assert.equal(detail.acknowledgement.acknowledged, 0, 'a new revision is acknowledged afresh');
    assert.match(detail.revisions[1]!.content, /Electronic approval/);
  });

  it('records a periodic review that found it right, and a withdrawal with its reason', () => {
    const reviewed = docs.confirmReview(company('qaqc'), id, { note: 'Checked against current practice' });
    assert.equal(reviewed.reviews.length, 1);
    refused(() => docs.withdrawDocument(company('pm'), id, { reason: 'Replaced' }), 'ACCESS_DENIED');
    const withdrawn = docs.withdrawDocument(company('owner'), id, { reason: 'Replaced by the integrated manual' });
    assert.equal(withdrawn.status, 'WITHDRAWN');
    assert.equal(withdrawn.reviewDueOn, null);
    refused(() => docs.redraftDocument(company('qaqc'), id, { changeSummary: 'Bring it back' }), 'IMS_DOCUMENT_WITHDRAWN');
  });

  it('numbers each type in its own series', () => {
    const policy = docs.draftDocument(company('qaqc'), { type: 'POLICY', title: 'Quality, environmental and OH&S policy', standards: ['ISO9001', 'ISO14001', 'ISO45001'], clauses: clausesFor('5.2'), ownerId: seed.users.owner!.id, distribution: ['PM'], content: 'We commit to satisfying requirements, protecting the environment and preventing injury and ill health.' });
    assert.equal(policy.reference, 'POL-001');
    assert.equal(docs.draftDocument(company('qaqc'), { type: 'PROCEDURE', title: 'Internal audit', standards: ['ISO9001'], ownerId: seed.users.qaqc!.id, content: PROCEDURE }).reference, 'PRO-002');
  });
});

describe('settings, the watch and the routes', () => {
  it('lets an approver of the system change a setting, with a reason, within its limits', () => {
    refused(() => ims.setSettings(company('pm'), { documentReviewMonths: 24, note: 'Biennial' }), 'ACCESS_DENIED');
    refused(() => ims.setSettings(company('owner'), { documentReviewMonths: 99, note: 'Too long' }), 'IMS_SETTING');
    assert.equal(ims.setSettings(company('owner'), { documentReviewMonths: 24, note: 'Biennial review is enough for stable procedures' }).documentReviewMonths, 24);
    assert.equal(ims.settings(company('pm')).documentReviewMonths, 24);
  });

  it('reports a document past its review, with the record it read', () => {
    const document = docs.draftDocument(company('qaqc'), { type: 'WORK_INSTRUCTION', title: 'Concrete pour checks', standards: ['ISO9001'], ownerId: seed.users.qaqc!.id, content: PROCEDURE });
    const approved = docs.approveDocument(company('safety'), document.id, { note: 'Checked on site' });
    // A review date in the past, as a year on would leave it.
    write(company('safety'), { eventType: 'IMS_DOCUMENT_REVIEWED', entity: { refType: 'ImsDocument', refId: document.id }, nextState: { ...approved, reviewDueOn: '2026-01-01' } as unknown as Record<string, unknown> });
    const findings = imsFindings(company('pm'), ims.today());
    const overdue = findings.find((finding) => finding.key === `ims:review-overdue:${document.id}`)!;
    assert.equal(overdue.evidence[0]!.refId, document.id);
  });

  it('publishes every document action as a route under /v1/ims', () => {
    const paths = new Set(ROUTES.map((route) => `${route.method} ${route.pattern}`));
    for (const path of ['GET /v1/ims', 'PUT /v1/ims/settings', 'POST /v1/ims/documents', 'GET /v1/ims/documents/:documentId', 'POST /v1/ims/documents/:documentId/redraft', 'POST /v1/ims/documents/:documentId/approve', 'POST /v1/ims/documents/:documentId/return', 'POST /v1/ims/documents/:documentId/review', 'POST /v1/ims/documents/:documentId/withdraw', 'POST /v1/ims/documents/:documentId/acknowledge']) {
      assert.ok(paths.has(path), path);
    }
  });
});
