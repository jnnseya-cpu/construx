import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { imsFindings } from '../src/agents/ims.ts';
import { ROUTES } from '../src/api/routes.ts';
import * as actions from '../src/domain/ims/actions.ts';
import * as audits from '../src/domain/ims/audits.ts';
import { clausesFor } from '../src/domain/ims/clauses.ts';
import * as docs from '../src/domain/ims/documents.ts';
import { today } from '../src/domain/ims/ims.ts';
import { imsOverview } from '../src/domain/ims/overview.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { recordIncident } from '../src/engines/safety.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Internal audit to verified closure: an audit planned against clauses and a
 * procedure with an independent lead auditor, findings recorded only by them,
 * a nonconformity carried into its corrective action, and that action taken
 * from investigation through implementation to an effectiveness check by
 * somebody else — and an action raised from an incident on a project.
 */

let platform: Platform;
let seed: SeedResult;
const company = (who: string): EngineContext => platform.context(seed.users[who]!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
const people = () => platform.users(seed.tenantId).map((user) => ({ id: user.id, name: user.name, roles: user.roles, status: user.status }));
const refused = (fn: () => unknown, code: string) => assert.throws(fn, (error: { code?: string }) => error.code === code, `expected ${code}`);
const id = (who: string) => seed.users[who]!.id;

let procedureId: string;
let auditId: string;
let actionId: string;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  platform.setModuleGrant({ moduleId: 'IMS', tenantId: seed.tenantId, status: 'ACTIVE', reason: 'IMS audit test', decidedBy: seed.users.operator!.id });
  const procedure = docs.draftDocument(company('qaqc'), {
    type: 'PROCEDURE',
    title: 'Control of documented information',
    standards: ['ISO9001', 'ISO45001'],
    clauses: clausesFor('7.5', ['ISO9001', 'ISO45001']),
    ownerId: id('qaqc'),
    distribution: ['PM'],
    content: 'Purpose: to control documented information. Responsibilities: the owner keeps it current; it is approved before issue.',
  });
  procedureId = procedure.id;
  docs.approveDocument(company('safety'), procedureId, { note: 'Checked against 7.5' });
});

describe('planning an audit', () => {
  const plan = (leadAuditorId: string, extra: Partial<Parameters<typeof audits.planAudit>[2]> = {}) =>
    audits.planAudit(company('qaqc'), people(), { title: 'Documented information and competence', standards: ['ISO9001'], clauses: ['ISO9001:7.5', 'ISO9001:7.2'], documentIds: [procedureId], projectIds: [seed.projectId], plannedOn: '2099-01-15', leadAuditorId, ...extra });

  it('refuses an auditor who owns, drafted or approved what is audited', () => {
    refused(() => plan(id('qaqc')), 'IMS_AUDITOR_NOT_INDEPENDENT');
    refused(() => plan(id('safety')), 'IMS_AUDITOR_NOT_INDEPENDENT');
  });

  it('refuses an auditor who may not record findings, a clause outside the standards and a project not the company’s', () => {
    refused(() => plan(id('planner')), 'IMS_AUDITOR_CANNOT_RECORD');
    refused(() => plan(id('pm'), { clauses: ['ISO14001:6.1.2'] }), 'IMS_CLAUSE_STANDARD');
    refused(() => plan(id('pm'), { projectIds: ['someone-elses-project'] }), 'IMS_PROJECT_NOT_FOUND');
  });

  it('plans AUD-001 with an independent lead auditor', () => {
    const audit = plan(id('pm'));
    auditId = audit.id;
    assert.equal(audit.reference, 'AUD-001');
    assert.equal(audit.status, 'PLANNED');
    refused(() => audits.recordFinding(company('pm'), auditId, { grade: 'OBSERVATION', clauseId: 'ISO9001:7.5', statement: 'Before the audit started', evidence: 'None' }), 'IMS_AUDIT_STATE');
  });

  it('takes a checklist only within its scope', () => {
    refused(() => audits.setChecklist(company('pm'), auditId, { items: [{ clauseId: 'ISO9001:8.4', question: 'Are suppliers approved?' }] }), 'IMS_CLAUSE_STANDARD');
    const audit = audits.setChecklist(company('pm'), auditId, { items: [{ clauseId: 'ISO9001:7.5', documentId: procedureId, question: 'Is the revision in use the one in force?' }, { clauseId: 'ISO9001:7.2', question: 'Are competence records kept for site managers?' }] });
    assert.equal(audit.checklist.length, 2);
  });
});

describe('conducting it', () => {
  it('is started and recorded only by the lead auditor', () => {
    refused(() => audits.startAudit(company('qs'), auditId), 'IMS_NOT_THE_AUDITOR');
    audits.startAudit(company('pm'), auditId);
    refused(() => audits.recordFinding(company('qs'), auditId, { grade: 'OBSERVATION', clauseId: 'ISO9001:7.5', statement: 'Not the auditor writing this', evidence: 'None' }), 'IMS_NOT_THE_AUDITOR');
  });

  it('carries a nonconformity into its corrective action, and not an observation', () => {
    refused(
      () => audits.recordFinding(company('pm'), auditId, { grade: 'MINOR_NC', clauseId: 'ISO9001:7.5', documentId: procedureId, statement: 'A superseded drawing register was in use on site', evidence: 'Site office, register rev B on the wall' }),
      'IMS_FINDING_ACTION_REQUIRED',
    );
    const nc = audits.recordFinding(company('pm'), auditId, {
      grade: 'MINOR_NC',
      clauseId: 'ISO9001:7.5',
      documentId: procedureId,
      projectId: seed.projectId,
      statement: 'A superseded drawing register was in use on site',
      evidence: 'Site office, register rev B on the wall; rev C issued two weeks earlier',
      actionOwnerId: id('qaqc'),
      actionDueOn: '2099-02-15',
    });
    assert.equal(nc.finding.reference, 'AUD-001-F01');
    actionId = nc.actionId!;
    const action = actions.actionOf(company('pm'), actionId);
    assert.equal(action.source.kind, 'AUDIT_FINDING');
    assert.equal(action.source.refId, nc.finding.id);
    assert.equal(action.ownerId, id('qaqc'));
    const observation = audits.recordFinding(company('pm'), auditId, { grade: 'OBSERVATION', clauseId: 'ISO9001:7.2', statement: 'Competence records are held in two places', evidence: 'HR folder and site induction file' });
    assert.equal(observation.actionId, undefined);
  });

  it('completes, then shows the clauses covered and the finding’s action', () => {
    refused(() => audits.completeAudit(company('qs'), auditId, { summary: 'Done by someone else', conclusion: 'n/a' }), 'IMS_NOT_THE_AUDITOR');
    audits.completeAudit(company('pm'), auditId, { summary: 'Document control and competence sampled on the Meridian project.', conclusion: 'Conforming with one minor nonconformity.' });
    refused(() => audits.cancelAudit(company('owner'), auditId, { reason: 'Changed our minds' }), 'IMS_AUDIT_STATE');
    const programme = audits.auditProgramme(company('pm'), people());
    const audit = programme.audits.find((entry) => entry.id === auditId)!;
    assert.equal(audit.findings.length, 2);
    assert.equal(audit.findings[0]!.action?.id, actionId);
    const documentControl = programme.coverage.find((entry) => entry.clauseId === 'ISO9001:7.5')!;
    assert.equal(documentControl.lastAuditedOn, today());
    assert.equal(documentControl.uncovered, false);
    assert.equal(programme.coverage.find((entry) => entry.clauseId === 'ISO9001:9.3')!.uncovered, true, 'management review never audited nor planned');
  });

  it('cancels a planned audit with no findings, with its reason', () => {
    const audit = audits.planAudit(company('qaqc'), people(), { title: 'Purchasing', standards: ['ISO9001'], clauses: ['ISO9001:8.4'], plannedOn: '2099-03-01', leadAuditorId: id('qs') });
    refused(() => audits.cancelAudit(company('pm'), audit.id, { reason: 'Clash' }), 'ACCESS_DENIED');
    assert.equal(audits.cancelAudit(company('owner'), audit.id, { reason: 'Merged into the April audit' }).status, 'CANCELLED');
  });
});

describe('a corrective action to verified closure', () => {
  it('is implemented only on a recorded root cause', () => {
    refused(() => actions.implementAction(company('qaqc'), actionId, { note: 'Register replaced' }), 'IMS_ROOT_CAUSE_REQUIRED');
    actions.updateAction(company('qaqc'), actionId, {
      correction: 'Superseded register removed from the site office the same day',
      rootCause: 'Site registers are printed copies and nobody is told when a revision is issued',
      plannedActions: 'Registers read from the common data environment on site tablets; printed copies withdrawn',
    });
    actions.implementAction(company('qaqc'), actionId, { note: 'Tablets issued to all three site offices; printed registers withdrawn' });
  });

  it('is verified by somebody else: not effective reopens it, effective closes it', () => {
    refused(() => actions.verifyAction(company('qaqc'), actionId, { effective: true, note: 'Looks good to me' }), 'IMS_VERIFY_SAME_PERSON');
    const reopened = actions.verifyAction(company('pm'), actionId, { effective: false, note: 'Printed register still found at the welfare cabin' });
    assert.equal(reopened.status, 'OPEN');
    refused(() => actions.verifyAction(company('pm'), actionId, { effective: true, note: 'Again' }), 'IMS_ACTION_STATE');
    actions.implementAction(company('qs'), actionId, { note: 'Welfare cabin copy withdrawn; weekly check added to the site manager’s list' });
    const closed = actions.verifyAction(company('pm'), actionId, { effective: true, note: 'Three site visits, no printed register found' });
    assert.equal(closed.status, 'CLOSED');
    assert.ok(closed.history.length >= 6, 'every step is on the record');
  });
});

describe('actions from the projects', () => {
  it('raises an action from an incident on a project, naming it, and refuses a record that is not there', () => {
    const projectCtx = platform.context(seed.users.safety!.auth, seed.projectId, { source: 'WEB' });
    const incident = recordIncident(projectCtx, {
      occurredAt: '2026-11-20T10:00:00Z',
      location: 'Level 2 slab edge',
      category: 'NEAR_MISS',
      description: 'Edge protection board removed and not replaced',
      immediateAction: 'Area closed; board replaced',
      personsInvolved: [],
      riddorReportable: false,
      evidenceHash: 'a'.repeat(64),
    });
    const sources = actions.sourceCandidates(company('pm'));
    const listed = sources.incidents.find((entry) => entry.refId === incident.incidentId)!;
    assert.equal(listed.reference, incident.reference);
    assert.ok(!('description' in listed), 'the company list carries no incident detail');
    refused(() => actions.raiseAction(company('safety'), { kind: 'CORRECTIVE', source: { kind: 'INCIDENT', refType: 'Incident', refId: 'no-such-incident' }, standards: ['ISO45001'], description: 'Edge protection removed', ownerId: id('safety'), dueOn: '2099-01-01' }), 'IMS_ACTION_SOURCE_NOT_FOUND');
    refused(() => actions.raiseAction(company('safety'), { kind: 'CORRECTIVE', source: { kind: 'INCIDENT', refType: 'NCR', refId: incident.incidentId }, standards: ['ISO45001'], description: 'Edge protection removed', ownerId: id('safety'), dueOn: '2099-01-01' }), 'IMS_ACTION_SOURCE');
    const action = actions.raiseAction(company('safety'), { kind: 'CORRECTIVE', source: { kind: 'INCIDENT', refType: 'Incident', refId: incident.incidentId }, standards: ['ISO45001'], description: 'Edge protection removed by a following trade without a permit', ownerId: id('safety'), dueOn: '2026-01-01' });
    assert.equal(action.source.projectId, seed.projectId);
    assert.equal(action.source.label, incident.reference);
    // Raised already past its date: the watch says so.
    assert.ok(imsFindings(company('pm'), today()).some((finding) => finding.key === `ims:action-overdue:${action.id}`));
    assert.ok(actions.actionRegister(company('pm'), people()).find((entry) => entry.id === action.id)!.overdue);
  });

  it('carries the programme, the actions and the sources on the overview, and publishes every route', () => {
    const view = imsOverview(company('pm'), people());
    assert.ok(view.programme.audits.length >= 2);
    assert.ok(view.actions.length >= 2);
    assert.ok(view.sources.incidents.length >= 1);
    const paths = new Set(ROUTES.map((route) => `${route.method} ${route.pattern}`));
    for (const path of ['POST /v1/ims/audits', 'PUT /v1/ims/audits/:auditId/checklist', 'POST /v1/ims/audits/:auditId/start', 'POST /v1/ims/audits/:auditId/findings', 'POST /v1/ims/audits/:auditId/complete', 'POST /v1/ims/audits/:auditId/cancel', 'POST /v1/ims/actions', 'PATCH /v1/ims/actions/:actionId', 'POST /v1/ims/actions/:actionId/implement', 'POST /v1/ims/actions/:actionId/verify']) {
      assert.ok(paths.has(path), path);
    }
  });
});
