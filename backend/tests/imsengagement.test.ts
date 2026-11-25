import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { imsFindings } from '../src/agents/ims.ts';
import { ROUTES } from '../src/api/routes.ts';
import * as actions from '../src/domain/ims/actions.ts';
import * as engagement from '../src/domain/ims/engagement.ts';
import * as ims from '../src/domain/ims/ims.ts';
import * as review from '../src/domain/ims/review.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * What customers said, how the emergency arrangements were tested, and what
 * workers raised: the complaints and satisfaction register, emergency drills,
 * and worker consultation — each feeding the management review and the watch.
 */

let platform: Platform;
let seed: SeedResult;
const company = (who: string): EngineContext => platform.context(seed.users[who]!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
const people = () => platform.users(seed.tenantId).map((user) => ({ id: user.id, name: user.name, roles: user.roles, status: user.status }));
const refused = (fn: () => unknown, code: string) => assert.throws(fn, (error: { code?: string }) => error.code === code, `expected ${code}`);
const daysAgo = (n: number) => ims.addDays(ims.today(), -n);
const period = () => ({ from: daysAgo(90), to: ims.today() });
const inputOf = (key: string) => review.companyPosition(company('pm'), people(), period()).inputs.find((input) => input.key === key)!;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  platform.setModuleGrant({ moduleId: 'IMS', tenantId: seed.tenantId, status: 'ACTIVE', reason: 'IMS engagement test', decidedBy: seed.users.operator!.id });
});

describe('complaints and customer satisfaction', () => {
  let late: engagement.ImsComplaint;
  let fresh: engagement.ImsComplaint;

  it('records a complaint as it was made, refusing one dated in the future, a project not the company’s, and a reader', () => {
    const input = { receivedOn: daysAgo(20), from: 'Resident, 4 Mill Lane', channel: 'EMAIL', category: 'ENVIRONMENT', description: 'Dust from the haul road covers our cars every afternoon', ownerId: seed.users.safety!.id };
    refused(() => engagement.recordComplaint(company('planner'), input), 'ACCESS_DENIED');
    refused(() => engagement.recordComplaint(company('qaqc'), { ...input, receivedOn: ims.addDays(ims.today(), 1) }), 'IMS_DATE');
    refused(() => engagement.recordComplaint(company('qaqc'), { ...input, channel: 'PIGEON' }), 'IMS_COMPLAINT_CHANNEL');
    refused(() => engagement.recordComplaint(company('qaqc'), { ...input, projectId: `${seed.tenantId}-governance` }), 'IMS_PROJECT_NOT_FOUND');
    late = engagement.recordComplaint(company('qaqc'), { ...input, projectId: seed.projectId });
    assert.equal(late.reference, 'CMP-001');
    assert.equal(late.status, 'OPEN');
    fresh = engagement.recordComplaint(company('qaqc'), { receivedOn: ims.today(), from: 'Client project manager', channel: 'LETTER', category: 'QUALITY', description: 'Snagging on level 2 was not closed before the walkround', ownerId: seed.users.pm!.id });
    assert.equal(fresh.reference, 'CMP-002');
  });

  it('shows a complaint unanswered after fourteen days as late, on the screen and to the watch', () => {
    const position = engagement.engagementPosition(company('pm'), people());
    assert.equal(position.complaints.find((entry) => entry.id === late.id)!.late, true);
    assert.equal(position.complaints.find((entry) => entry.id === fresh.id)!.late, false);
    const keys = imsFindings(company('pm'), ims.today()).map((finding) => finding.key);
    assert.ok(keys.includes(`ims:complaint-unanswered:${late.id}`));
    assert.ok(!keys.includes(`ims:complaint-unanswered:${fresh.id}`));
  });

  it('closes a complaint only once it is answered, and raises one corrective action named to it', () => {
    refused(() => engagement.closeComplaint(company('qaqc'), late.id, { note: 'Nothing more to do' }), 'IMS_COMPLAINT_UNANSWERED');
    refused(() => engagement.respondToComplaint(company('safety'), late.id, { respondedOn: daysAgo(30), text: 'Before it was received' }), 'IMS_DATE');
    engagement.respondToComplaint(company('safety'), late.id, { respondedOn: ims.today(), text: 'Haul road now damped twice daily and a wheel wash installed at the gate' });
    const withAction = engagement.actionFromComplaint(company('safety'), late.id, { ownerId: seed.users.safety!.id, dueOn: ims.addDays(ims.today(), 14) });
    refused(() => engagement.actionFromComplaint(company('safety'), late.id, { ownerId: seed.users.safety!.id, dueOn: ims.addDays(ims.today(), 14) }), 'IMS_COMPLAINT_ACTIONED');
    const action = actions.actionOf(company('pm'), withAction.actionId!);
    assert.equal(action.source.kind, 'COMPLAINT');
    assert.equal(action.source.refId, late.id);
    assert.deepEqual(action.standards, ['ISO14001'], 'an environmental complaint is an ISO 14001 matter');
    const closed = engagement.closeComplaint(company('qaqc'), late.id, { note: 'Resident confirmed the dust has stopped', satisfied: true });
    assert.equal(closed.status, 'CLOSED');
    assert.equal(closed.closed!.satisfied, true);
    refused(() => engagement.respondToComplaint(company('safety'), late.id, { respondedOn: ims.today(), text: 'After it was closed' }), 'IMS_COMPLAINT_CLOSED');
    assert.ok(!imsFindings(company('pm'), ims.today()).some((finding) => finding.key === `ims:complaint-unanswered:${late.id}`));
  });

  it('records satisfaction on a 1–5 scale and averages it', () => {
    refused(() => engagement.recordSurvey(company('qaqc'), { client: 'Conwy County', surveyedOn: ims.today(), score: 6, comments: 'Off the scale' }), 'IMS_SCORE');
    engagement.recordSurvey(company('qaqc'), { client: 'Conwy County', surveyedOn: daysAgo(5), score: 4, comments: 'Good communication; programme slipped a fortnight' });
    engagement.recordSurvey(company('qaqc'), { client: 'Gwynedd Council', projectId: seed.projectId, surveyedOn: daysAgo(2), score: 5, comments: 'Handover documents complete on the day' });
    assert.equal(engagement.engagementPosition(company('pm'), people()).averageSatisfaction, 4.5);
  });

  it('puts both into the management review as customer satisfaction and complaints', () => {
    const customers = inputOf('customers');
    assert.equal(customers.figures.surveys, 2);
    assert.equal(customers.figures.averageScore, 4.5);
    assert.equal(customers.figures.complaints, 2);
    assert.equal(customers.figures.unanswered, 1);
    assert.equal(customers.figures.actioned, 1);
  });
});

describe('emergency drills', () => {
  let fire: engagement.ImsDrill;
  let spill: engagement.ImsDrill;

  it('plans a drill with its scenario and lead, and shows one past its date as overdue', () => {
    refused(() => engagement.planDrill(company('safety'), { scenario: 'ALIEN_INVASION', description: 'Not a scenario', plannedOn: ims.today(), leadId: seed.users.safety!.id }), 'IMS_DRILL_SCENARIO');
    fire = engagement.planDrill(company('safety'), { scenario: 'FIRE_EVACUATION', description: 'Full evacuation of the level 3 slab to the muster point', projectId: seed.projectId, plannedOn: daysAgo(3), leadId: seed.users.safety!.id });
    spill = engagement.planDrill(company('safety'), { scenario: 'SPILL', description: 'Diesel spill at the bowser; spill kit to the drain', plannedOn: ims.addDays(ims.today(), 7), leadId: seed.users.safety!.id });
    assert.equal(fire.reference, 'DRL-001');
    assert.ok(imsFindings(company('pm'), ims.today()).some((finding) => finding.key === `ims:drill-overdue:${fire.id}`));
    assert.equal(inputOf('emergency').figures.overdue, 1);
  });

  it('records a drill not fully effective only with an owner and date, which raise the action', () => {
    const held = { heldOn: ims.today(), participants: 34, durationMinutes: 11, outcome: 'PARTLY_EFFECTIVE', lessons: 'Two operatives on the scaffold did not hear the sounder; muster took 11 minutes against a target of 6' };
    refused(() => engagement.recordDrill(company('safety'), fire.id, held), 'IMS_DRILL_ACTION_REQUIRED');
    refused(() => engagement.recordDrill(company('safety'), fire.id, { ...held, heldOn: ims.addDays(ims.today(), 1) }), 'IMS_DATE');
    refused(() => engagement.recordDrill(company('safety'), fire.id, { ...held, participants: 0 }), 'IMS_DRILL_PARTICIPANTS');
    const recorded = engagement.recordDrill(company('safety'), fire.id, { ...held, actionOwnerId: seed.users.safety!.id, actionDueOn: ims.addDays(ims.today(), 21) });
    assert.equal(recorded.status, 'HELD');
    const action = actions.actionOf(company('pm'), recorded.held!.actionId!);
    assert.equal(action.kind, 'CORRECTIVE');
    assert.match(action.source.label ?? '', /DRL-001/);
    refused(() => engagement.recordDrill(company('safety'), fire.id, { ...held, outcome: 'EFFECTIVE' }), 'IMS_DRILL_STATE');
    assert.ok(!imsFindings(company('pm'), ims.today()).some((finding) => finding.key === `ims:drill-overdue:${fire.id}`));
  });

  it('cancels a drill with its reason, and counts the period’s drills in the review', () => {
    refused(() => engagement.cancelDrill(company('planner'), spill.id, { reason: 'Bowser off hire this week' }), 'ACCESS_DENIED');
    const cancelled = engagement.cancelDrill(company('safety'), spill.id, { reason: 'Bowser off hire this week; re-planned for next month' });
    assert.equal(cancelled.status, 'CANCELLED');
    const emergency = inputOf('emergency');
    assert.equal(emergency.figures.held, 1);
    assert.equal(emergency.figures.notFullyEffective, 1);
    assert.equal(emergency.figures.overdue, 0);
  });
});

describe('worker consultation', () => {
  let talk: engagement.ImsConsultation;

  it('records what workers raised, in their words, and refuses one in the future', () => {
    refused(() => engagement.recordConsultation(company('safety'), { on: ims.addDays(ims.today(), 1), method: 'TOOLBOX_TALK', topic: 'Welfare', participants: 12, raised: 'Not yet held' }), 'IMS_DATE');
    refused(() => engagement.recordConsultation(company('safety'), { on: ims.today(), method: 'TOOLBOX_TALK', topic: 'Welfare', participants: 0, raised: 'Nobody there' }), 'IMS_CONSULTATION_PARTICIPANTS');
    talk = engagement.recordConsultation(company('safety'), { on: daysAgo(40), method: 'TOOLBOX_TALK', topic: 'Welfare cabins', projectId: seed.projectId, participants: 18, raised: 'Drying room heater broken for a week; boots never dry' });
    assert.equal(talk.reference, 'CON-001');
    assert.ok(imsFindings(company('pm'), ims.today()).some((finding) => finding.key === `ims:consultation-unanswered:${talk.id}`), 'unanswered after thirty days');
    const consultation = inputOf('consultation');
    assert.equal(consultation.figures.consultations, 1);
    assert.equal(consultation.figures.participations, 18);
    assert.equal(consultation.figures.unanswered, 1);
  });

  it('records the answer once, dated between the consultation and today', () => {
    refused(() => engagement.answerConsultation(company('safety'), talk.id, { answeredOn: daysAgo(41), text: 'Before the talk was held' }), 'IMS_DATE');
    engagement.answerConsultation(company('safety'), talk.id, { answeredOn: daysAgo(38), text: 'Heater replaced and a second one fitted; told at the next toolbox talk' });
    refused(() => engagement.answerConsultation(company('safety'), talk.id, { answeredOn: ims.today(), text: 'A second answer to the same talk' }), 'IMS_CONSULTATION_ANSWERED');
    assert.ok(!imsFindings(company('pm'), ims.today()).some((finding) => finding.key === `ims:consultation-unanswered:${talk.id}`));
    assert.equal(inputOf('consultation').figures.unanswered, 0);
  });
});

describe('the engagement routes', () => {
  it('publishes every command and keeps it off a project record', () => {
    const paths = new Set(ROUTES.map((route) => `${route.method} ${route.pattern}`));
    for (const path of [
      'POST /v1/ims/complaints',
      'POST /v1/ims/complaints/:complaintId/response',
      'POST /v1/ims/complaints/:complaintId/action',
      'POST /v1/ims/complaints/:complaintId/close',
      'POST /v1/ims/satisfaction',
      'POST /v1/ims/drills',
      'POST /v1/ims/drills/:drillId/held',
      'POST /v1/ims/drills/:drillId/cancel',
      'POST /v1/ims/consultations',
      'POST /v1/ims/consultations/:consultationId/answer',
    ]) {
      assert.ok(paths.has(path), path);
    }
    const onProject = platform.context(seed.users.qaqc!.auth, seed.projectId, { source: 'WEB' });
    refused(() => engagement.recordSurvey(onProject, { client: 'Conwy County', surveyedOn: ims.today(), score: 4, comments: 'On a project record' }), 'IMS_COMPANY_RECORD');
  });
});
