import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { imsFindings } from '../src/agents/ims.ts';
import { ROUTES } from '../src/api/routes.ts';
import * as actions from '../src/domain/ims/actions.ts';
import * as ims from '../src/domain/ims/ims.ts';
import { LEGISLATION } from '../src/domain/ims/legislation.ts';
import * as registers from '../src/domain/ims/registers.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The environmental aspects register with significance on the company's own
 * threshold, the legal register evaluated on a schedule (a shortfall raising
 * its corrective action), and objectives measured to a close.
 */

let platform: Platform;
let seed: SeedResult;
const company = (who: string): EngineContext => platform.context(seed.users[who]!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
const people = () => platform.users(seed.tenantId).map((user) => ({ id: user.id, name: user.name, roles: user.roles, status: user.status }));
const refused = (fn: () => unknown, code: string) => assert.throws(fn, (error: { code?: string }) => error.code === code, `expected ${code}`);
const id = (who: string) => seed.users[who]!.id;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  platform.setModuleGrant({ moduleId: 'IMS', tenantId: seed.tenantId, status: 'ACTIVE', reason: 'IMS registers test', decidedBy: seed.users.operator!.id });
});

describe('environmental aspects', () => {
  let dustId: string;

  it('scores each aspect, and is significant at the company’s own threshold or where the law drives it', () => {
    refused(() => registers.recordAspect(company('safety'), { activity: 'Concrete cutting', aspect: 'Dust', impact: 'Air quality', condition: 'NORMAL', severity: 6, likelihood: 2, controls: 'Water suppression' }), 'IMS_SCORE');
    dustId = registers.recordAspect(company('safety'), { activity: 'Concrete cutting', aspect: 'Silica dust emission', impact: 'Local air quality and nuisance to neighbours', condition: 'NORMAL', severity: 3, likelihood: 4, controls: 'Water suppression at the blade; on-tool extraction' }).id;
    const washout = registers.recordAspect(company('safety'), { activity: 'Concrete washout', aspect: 'Alkaline washwater', impact: 'Pollution of surface water', condition: 'ABNORMAL', severity: 4, likelihood: 2, legalDriver: true, controls: 'Lined washout bay; no discharge to drains' });
    const fuel = registers.recordAspect(company('safety'), { activity: 'Refuelling plant', aspect: 'Diesel spill', impact: 'Ground contamination', condition: 'EMERGENCY', severity: 4, likelihood: 1, controls: 'Bunded bowser; spill kits; drip trays' });
    const register = registers.registersPosition(company('pm'), people());
    const byId = (aspectId: string) => register.aspects.find((entry) => entry.id === aspectId)!;
    assert.equal(byId(dustId).score, 12);
    assert.equal(byId(dustId).significant, true, '12 meets the starting threshold of 12');
    assert.equal(byId(washout.id).significant, true, 'a legal driver makes it significant whatever its score');
    assert.equal(byId(fuel.id).significant, false);
    // The company raises its threshold: the dust aspect is no longer significant on score.
    ims.setSettings(company('owner'), { aspectSignificanceThreshold: 15, note: 'Concentrate on the highest risks first' });
    assert.equal(registers.registersPosition(company('pm'), people()).aspects.find((entry) => entry.id === dustId)!.significant, false);
  });

  it('is reassessed and retired with its reason, and refused to a reader', () => {
    refused(() => registers.recordAspect(company('planner'), { activity: 'Piling', aspect: 'Vibration', impact: 'Nuisance', condition: 'NORMAL', severity: 2, likelihood: 3, controls: 'Monitoring' }), 'ACCESS_DENIED');
    assert.equal(registers.reviseAspect(company('qaqc'), dustId, { activity: 'Concrete cutting', aspect: 'Silica dust emission', impact: 'Local air quality', condition: 'NORMAL', severity: 4, likelihood: 4, controls: 'Water suppression; on-tool extraction; daily checks' }).severity, 4);
    const retired = registers.retireAspect(company('qaqc'), dustId, { reason: 'Cutting now done off site by the precaster' });
    assert.equal(retired.status, 'RETIRED');
    assert.equal(registers.registersPosition(company('pm'), people()).aspects.find((entry) => entry.id === dustId)!.significant, false, 'a retired aspect is not significant');
  });
});

describe('the legal register', () => {
  let wasteId: string;

  it('takes an entry from the legislation list or by its title, once, due for evaluation at once', () => {
    assert.ok(LEGISLATION.some((entry) => entry.key === 'CDM_2015' && entry.title === 'Construction (Design and Management) Regulations 2015'));
    refused(() => registers.recordObligation(company('safety'), { title: 'A permit', requirement: 'Something to do', applicability: 'Applies everywhere', howComplied: 'By being careful' }), 'IMS_STANDARDS');
    refused(() => registers.recordObligation(company('safety'), { standards: ['ISO14001'], catalogueKey: 'MADE_UP_ACT', requirement: 'Something', applicability: 'Applies everywhere', howComplied: 'By being careful' }), 'IMS_LEGISLATION_UNKNOWN');
    const waste = registers.recordObligation(company('safety'), {
      catalogueKey: 'EPA_1990',
      requirement: 'Duty of care for waste: transfer only to authorised carriers, with a description',
      applicability: 'Every project produces construction and demolition waste',
      howComplied: 'Waste carriers checked against the public register; transfer notes kept for two years',
    });
    wasteId = waste.id;
    assert.equal(waste.title, 'Environmental Protection Act 1990');
    assert.equal(waste.extent, 'Great Britain');
    assert.deepEqual(waste.standards, ['ISO14001'], 'the list entry carries its standards');
    assert.equal(waste.nextEvaluationDue, ims.today(), 'not yet shown to be complied with');
    refused(() => registers.recordObligation(company('safety'), { standards: ['ISO14001'], catalogueKey: 'EPA_1990', requirement: 'Duplicate entry', applicability: 'Again and again', howComplied: 'The same way' }), 'IMS_OBLIGATION_EXISTS');
    const permit = registers.recordObligation(company('safety'), { standards: ['ISO14001'], title: 'Trade effluent consent, Meridian depot', extent: 'England', requirement: 'Discharge only within the consented volume', applicability: 'Depot wash bay discharges to foul sewer', howComplied: 'Meter read monthly; interceptor emptied quarterly', evaluationMonths: 6 });
    assert.equal(permit.reference, 'LEG-002');
  });

  it('raises a corrective action when an evaluation finds it short, and sets the next evaluation date', () => {
    refused(() => registers.evaluateObligation(company('qaqc'), wasteId, { result: 'PARTIAL', note: 'Two transfer notes missing from the October file' }), 'IMS_EVALUATION_ACTION_REQUIRED');
    const evaluated = registers.evaluateObligation(company('qaqc'), wasteId, { result: 'PARTIAL', note: 'Two transfer notes missing from the October file on the Meridian project', actionOwnerId: id('pm'), actionDueOn: '2099-01-31' });
    const evaluation = evaluated.evaluations.at(-1)!;
    assert.equal(evaluated.nextEvaluationDue, ims.addMonths(ims.today(), 12));
    const action = actions.actionOf(company('pm'), evaluation.actionId!);
    assert.equal(action.source.kind, 'OBLIGATION');
    assert.equal(action.source.refId, wasteId);
    assert.equal(action.ownerId, id('pm'));
    const compliant = registers.evaluateObligation(company('qaqc'), wasteId, { result: 'COMPLIANT', note: 'Notes recovered from the carrier; file complete' });
    assert.equal(compliant.evaluations.at(-1)!.actionId, undefined);
  });

  it('is withdrawn with its reason and then evaluated no more', () => {
    const entry = registers.recordObligation(company('safety'), { standards: ['ISO45001'], catalogueKey: 'CONFINED_1997', requirement: 'Avoid entry; safe system of work where unavoidable', applicability: 'Drainage works on two projects', howComplied: 'Confined space permit and trained teams' });
    registers.withdrawObligation(company('safety'), entry.id, { reason: 'Drainage now subcontracted under the subcontractor’s own system' });
    refused(() => registers.evaluateObligation(company('safety'), entry.id, { result: 'COMPLIANT', note: 'After withdrawal' }), 'IMS_OBLIGATION_WITHDRAWN');
  });

  it('is reported by the watch when an evaluation falls due', () => {
    const findings = imsFindings(company('pm'), ims.addDays(ims.today(), 1));
    const permit = registers.obligations(company('pm')).find((entry) => entry.reference === 'LEG-002')!;
    assert.ok(findings.some((finding) => finding.key === `ims:evaluation-due:${permit.id}`));
  });
});

describe('objectives', () => {
  it('are set with a measure and a target, progressed, and closed by an approver', () => {
    refused(() => registers.setObjective(company('pm'), { standard: 'ISO45001', objective: 'Fewer', measure: 'AFR', target: '0.1', ownerId: id('safety'), dueOn: '2027-12-31' }), 'IMS_FIELD_REQUIRED');
    const objective = registers.setObjective(company('pm'), { standard: 'ISO45001', objective: 'Reduce the accident frequency rate across all projects', measure: 'RIDDOR-reportable injuries per 100,000 hours worked', target: '0.10', baseline: '0.18 (2026)', ownerId: id('safety'), dueOn: '2027-12-31' });
    registers.recordProgress(company('safety'), objective.id, { value: '0.14', note: 'Q1 2027 from the incident register and timesheets' });
    refused(() => registers.closeObjective(company('pm'), objective.id, { achieved: true, note: 'Done' }), 'ACCESS_DENIED');
    const closed = registers.closeObjective(company('owner'), objective.id, { achieved: false, note: 'Ended the year at 0.12; carried forward with a new target' });
    assert.equal(closed.status, 'NOT_ACHIEVED');
    refused(() => registers.recordProgress(company('safety'), objective.id, { value: '0.11', note: 'Late' }), 'IMS_OBJECTIVE_CLOSED');
  });

  it('publishes every register action as a route', () => {
    const paths = new Set(ROUTES.map((route) => `${route.method} ${route.pattern}`));
    for (const path of ['POST /v1/ims/aspects', 'PUT /v1/ims/aspects/:aspectId', 'POST /v1/ims/aspects/:aspectId/retire', 'POST /v1/ims/obligations', 'POST /v1/ims/obligations/:obligationId/evaluations', 'POST /v1/ims/obligations/:obligationId/withdraw', 'POST /v1/ims/objectives', 'POST /v1/ims/objectives/:objectiveId/progress', 'POST /v1/ims/objectives/:objectiveId/close']) {
      assert.ok(paths.has(path), path);
    }
  });
});
