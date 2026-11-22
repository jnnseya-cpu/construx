import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import type { AIProviderAdapter, ProviderRequest, ProviderResponse } from '../src/ai/providers/types.ts';
import { ROUTES } from '../src/api/routes.ts';
import { config } from '../src/config.ts';
import * as agents from '../src/domain/planning/agents.ts';
import * as apps from '../src/domain/planning/applications.ts';
import * as consents from '../src/domain/planning/consents.ts';
import * as gates from '../src/domain/planning/gates.ts';
import * as planning from '../src/domain/planning/planning.ts';
import * as studies from '../src/domain/planning/studies.ts';
import { registerEvidence, write, type EngineContext } from '../src/engines/context.ts';
import { ingestFile, packText } from '../src/evidence/pipeline.ts';
import { EvidenceStore, hashBytes } from '../src/evidence/store.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { docxOf, paragraph } from './fixtures/zip.ts';

/**
 * The planning agents do the reading, the drafting and the legwork; a person
 * decides. A primary school with temporary classrooms is described in words
 * and the agents carry it: the proposal, the site facts read from a flood map
 * extract, the study briefs, the planning statement, who does what by when,
 * and — on a granted permission — the conditions read from the notice.
 *
 * The model is a stub that answers each task from what it was sent, and
 * deliberately slips in an ungrounded quote, a paraphrased condition, a value
 * outside the rules' list and an id it was not given: each is dropped in code.
 */

let directory: string;
let previousClearance: (typeof config.ai.providerClearance)[string] | undefined;
let store: EvidenceStore;
let platform: Platform;
let seed: SeedResult;
const requests: ProviderRequest[] = [];
const as = (who: string): EngineContext => platform.context(seed.users[who]!.auth, seed.projectId, { source: 'WEB' });
const refused = async (fn: () => unknown, code: string) =>
  assert.rejects(async () => fn(), (error: { code?: string }) => error.code === code, `expected ${code}`);

const NEED = 'A two-form-entry primary school for 420 pupils on a 1.8 ha site in Example District, with temporary classrooms needed for 3 years while it is built.';
const FLOOD_LINE = 'The site lies wholly within Flood Zone 3a as shown on the Flood Map for Planning, extract dated 2 October 2026.';
const CONDITION_5 = 'No development shall take place until a construction traffic management plan has been submitted to and approved in writing by the local planning authority.';
const CONDITION_7 = 'No dwelling shall be occupied until the access road has been surfaced to base course.';

function answer(request: ProviderRequest): Record<string, unknown> {
  const properties = Object.keys(((request.responseSchema ?? {}) as { properties?: Record<string, unknown> }).properties ?? {});
  const payload = request.payload as Record<string, any>;
  if (properties.includes('scenarioName')) {
    // The second intake answers with a category the rules do not know.
    const odd = String(payload.need).includes('launch pad');
    return {
      scenarioName: odd ? 'Launch pad' : 'Primary school, 2FE',
      category: odd ? 'SPACEPORT' : 'EDUCATION',
      route: 'full',
      siteAreaHa: 1.8,
      authority: 'Example District Council',
      dwellings: 12, // stated nowhere for a school; dropped in code
      floorspaceM2: null,
      capacityCount: 420,
      capacityUnit: 'pupils',
      temporaryMonths: 36,
      capacityMW: null,
      assumptions: ['Two-form entry means 60 pupils a year across seven year groups'],
      questions: ['Is the temporary accommodation on the same site?'],
    };
  }
  if (properties.includes('facts')) {
    return {
      facts: [
        { key: 'FLOOD_ZONE', value: '3a', document: 'Flood map extract.docx', quote: FLOOD_LINE },
        { key: 'PROTECTED_SPECIES', value: 'NONE_FOUND', document: 'Flood map extract.docx', quote: 'No protected species were recorded on the site.' },
        { key: 'FLOOD_ZONE', value: 'Zone Three', document: 'Flood map extract.docx', quote: FLOOD_LINE },
      ],
    };
  }
  if (properties.includes('conditions')) {
    return {
      conditions: [
        { number: '5', wording: CONDITION_5, interpretation: 'A construction traffic plan before any works', trigger: 'BEFORE_COMMENCEMENT', phases: [] },
        { number: '7', wording: 'No home is to be lived in until the road is surfaced.', interpretation: 'Road before occupation', trigger: 'BEFORE_OCCUPATION' },
      ],
    };
  }
  if (properties.includes('scopes')) {
    const listed = (payload.studies as Array<{ id: string; title: string }>) ?? [];
    return {
      scopes: [
        ...listed.map((study) => ({ studyId: study.id, scope: `${study.title}: establish the baseline for a 420-pupil school, the survey work, and the outputs the application needs.` })),
        { studyId: 'not-a-study', scope: 'A brief for a study nobody asked for, long enough to pass the length check.' },
      ],
    };
  }
  if (properties.includes('sections')) {
    return {
      sections: [
        { heading: 'The site', body: 'A 1.8 ha site in Example District, wholly within Flood Zone 3a.' },
        { heading: 'The proposal', body: 'A two-form-entry primary school for 420 pupils, with temporary classrooms for three years.' },
        { heading: '', body: 'A section with no heading is not a section.' },
      ],
    };
  }
  if (properties.includes('actions')) {
    const open = (payload.open as Array<{ id: string }>) ?? [];
    return {
      actions: [
        { requirementId: open[0]!.id, owner: 'Planning lead', dueOn: '2027-01-15', why: 'Needed before the pack is assembled.' },
        { requirementId: open[1]!.id, owner: 'Ecologist', dueOn: 'next spring', why: 'Not a date.' },
      ],
    };
  }
  throw new Error(`The stub was asked something it does not answer: ${properties.join(', ')}`);
}

function stub(): AIProviderAdapter {
  return {
    name: 'OPENAI',
    capability: 'REASONING',
    multimodal: false,
    transmits: true,
    estimateCostMinor: () => 25,
    healthy: () => true,
    async execute(request: ProviderRequest): Promise<ProviderResponse> {
      requests.push(request);
      return { provider: 'OPENAI', modelClass: 'reasoning-standard', output: answer(request), rawCostMinor: 25, latencyMs: 5, confidence: 0.8 };
    },
  };
}

async function planningDocument(name: string, lines: string[]): Promise<string> {
  const bytes = docxOf(lines.map((line) => paragraph(line)).join(''));
  const hash = hashBytes(bytes);
  agents.recordPlanningDocument(as('pm'), { hash, filename: name });
  await store.put(seed.tenantId, hash, bytes, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  return (await ingestFile(as('pm'), store, { hash, filename: name })).ingestionId;
}

let docCount = 0;
function evidence(title: string): apps.EvidenceRef {
  docCount += 1;
  const refId = `agent-doc-${docCount}`;
  const ctx = as('owner');
  const item = registerEvidence(ctx, { type: 'INFORMATION_CONTAINER', hash: `agent-hash-${docCount}`, description: title, linkedEntities: [] });
  write(ctx, {
    eventType: 'CONTAINER_DEPOSITED',
    entity: { refType: 'InformationContainer', refId },
    evidenceRefs: [item],
    nextState: { id: refId, projectId: seed.projectId, reference: `AG-${docCount}`, revision: 'P01', title, kind: 'DOCUMENT', discipline: 'PLANNING', suitability: 'S0', state: 'WIP', fileHash: `agent-hash-${docCount}`, author: 'design', depositedAt: new Date().toISOString() },
  });
  return { refType: 'InformationContainer', refId };
}

function satisfy(applicationId: string, gatesToClear: string[]): void {
  for (const requirement of apps.requirements(as('pm'), applicationId).filter((entry) => gatesToClear.includes(entry.gate) && entry.delivery !== 'ACCEPTED' && entry.delivery !== 'NOT_APPLICABLE')) {
    apps.updateRequirement(as('pm'), requirement.id, { evidence: [evidence(requirement.title)], delivery: 'SUBMITTED_FOR_REVIEW' });
    apps.reviewRequirement(as('qs'), requirement.id, { decision: 'ACCEPTED', rationale: 'Checked against the requirement' });
  }
}

const proposalsOf = (runId: string) => agents.agentProposals(as('pm')).filter((entry) => entry.runId === runId);

before(async () => {
  // The text read from an upload is classified LEGAL_L4 — a specification and a
  // without-prejudice letter go through the same pipeline — so it goes to a
  // vendor only once a deployment clears it that far with AI_PROVIDER_CLEARANCE.
  previousClearance = config.ai.providerClearance.OPENAI;
  config.ai.providerClearance.OPENAI = 'LEGAL_L4';
  directory = mkdtempSync(join(tmpdir(), 'construx-planning-agents-'));
  store = new EvidenceStore(directory);
  platform = new Platform(new AIOrchestrator({ reasoning: stub() }), store);
  seed = await seedDemoProject(platform);
  platform.setModuleGrant({ moduleId: 'PLANNING', tenantId: seed.tenantId, status: 'ACTIVE', reason: 'Planning agents test', decidedBy: seed.users.operator!.id });
  for (const version of ['england-planning-rules-2026-11', 'england-2026-12-08']) {
    planning.prepareRuleVersion(as('pm'), { version, checkNote: 'Checked against the published source, figure by figure' });
    planning.publishRuleVersion(as('owner'), { version, note: 'Second check' });
  }
  planning.seedIllustrativeAllowances(as('pm'));
});

after(() => {
  if (previousClearance === undefined) delete config.ai.providerClearance.OPENAI;
  else config.ai.providerClearance.OPENAI = previousClearance;
  rmSync(directory, { recursive: true, force: true });
});

let school: planning.Proposal;

describe('the intake agent', () => {
  it('turns the need in words into a proposal, and records nothing until a person accepts it', async () => {
    const run = await agents.runIntake(as('pm'), { need: NEED });
    assert.equal(run.proposed, 1);
    const [proposal] = proposalsOf(run.runId);
    assert.equal(proposal!.kind, 'PROPOSAL');
    assert.equal(proposal!.status, 'PROPOSED');
    assert.equal(proposal!.payload.category, 'EDUCATION');
    assert.equal(proposal!.payload.dwellings, null, 'dwellings are not a school’s measure');
    assert.deepEqual(proposal!.payload.capacityUnits, { count: 420, unit: 'pupils' });
    assert.deepEqual(proposal!.payload.site, { areaHa: 1.8, authority: 'Example District Council' });
    assert.equal(planning.siteVersions(as('pm')).length, 0, 'the agent recorded no site');
    assert.equal(planning.proposals(as('pm')).length, 0, 'the agent recorded no proposal');
    // Written by the agent, not by the person who pressed the button.
    const event = platform.ledger.eventsForEntity({ refType: 'PlanningAgentProposal', refId: proposal!.id })[0]!;
    assert.equal(event.eventType, 'PLANNING_AGENT_PROPOSED');
    assert.equal(event.actor.refType, 'AI');
  });

  it('records the site at the stated area and the proposal when accepted — once', async () => {
    const proposal = agents.agentProposals(as('pm')).find((entry) => entry.kind === 'PROPOSAL')!;
    await refused(() => agents.decideProposal(as('planner'), proposal.id, { decision: 'ACCEPT' }), 'ACCESS_DENIED');
    const decided = agents.decideProposal(as('pm'), proposal.id, { decision: 'ACCEPT', note: 'Matches the brief' });
    assert.equal(decided.status, 'ACCEPTED');
    const site = planning.siteVersions(as('pm')).at(-1)!;
    assert.equal(site.confirmedAreaM2, 18_000);
    assert.equal(site.authority.confirmed, false, 'an authority named by the agent is still to be confirmed');
    school = planning.proposals(as('pm')).at(-1)!;
    assert.equal(decided.result?.refId, school.id);
    assert.equal(school.category, 'EDUCATION');
    assert.equal(school.temporaryMonths, 36);
    assert.ok(school.assumptions.some((entry) => entry.startsWith('To answer: ')));
    await refused(() => agents.decideProposal(as('pm'), proposal.id, { decision: 'REJECT' }), 'AGENT_PROPOSAL_DECIDED');
  });

  it('drops an answer naming a category the rules do not have', async () => {
    const run = await agents.runIntake(as('pm'), { need: 'A rocket launch pad on the old airfield, about 40 ha.' });
    assert.equal(run.proposed, 0);
    assert.equal(run.dropped, 1);
  });

  it('refuses a person without planning authoring rights, and a run with no model behind it', async () => {
    await refused(() => agents.runIntake(as('planner'), { need: NEED }), 'ACCESS_DENIED');
    const bare = new Platform(undefined, store);
    const bareSeed = await seedDemoProject(bare);
    bare.setModuleGrant({ moduleId: 'PLANNING', tenantId: bareSeed.tenantId, status: 'ACTIVE', reason: 'No model', decidedBy: bareSeed.users.operator!.id });
    await refused(() => agents.runIntake(bare.context(bareSeed.users.pm!.auth, bareSeed.projectId, { source: 'WEB' }), { need: NEED }), 'PLANNING_AGENT_NEEDS_A_MODEL');
  });
});

describe('the site-facts agent', () => {
  it('needs a planning document to read', async () => {
    await refused(() => agents.readSiteFacts(as('pm'), {}), 'NO_PLANNING_DOCUMENTS');
  });

  it('proposes only facts quoted from the documents, with a value the rules read', async () => {
    const ingestionId = await planningDocument('Flood map extract.docx', ['Flood risk summary', FLOOD_LINE, 'Surface water risk was not assessed.']);
    assert.deepEqual(agents.planningDocuments(as('pm')).map((entry) => entry.ingestionId), [ingestionId]);
    // A planning document is not part of the tender pack.
    assert.ok(!packText(as('pm')).text.includes('Flood Zone 3a'));
    assert.ok(packText(as('pm'), { purpose: 'PLANNING' }).text.includes('Flood Zone 3a'));

    const run = await agents.readSiteFacts(as('pm'), {});
    assert.equal(run.proposed, 1, 'only the grounded fact with an allowed value');
    assert.equal(run.dropped, 2, 'the invented quote and the value outside the list');
    const [fact] = proposalsOf(run.runId);
    assert.deepEqual(fact!.payload, { key: 'FLOOD_ZONE', value: '3a' });
    assert.equal(fact!.citation?.quote, FLOOD_LINE);
    assert.equal(planning.siteFacts(as('pm')).FLOOD_ZONE, undefined, 'nothing recorded yet');

    agents.decideProposal(as('pm'), fact!.id, { decision: 'ACCEPT' });
    const recorded = planning.siteFacts(as('pm')).FLOOD_ZONE!;
    assert.equal(recorded.value, '3a');
    assert.match(recorded.source, /Flood Map for Planning, extract dated 2 October 2026/);
  });
});

describe('the application agents', () => {
  let application: apps.Application;

  it('drafts the brief for each study, and only for the studies it was given', async () => {
    for (const [key, value] of [['EIA_SENSITIVE_AREA', 'NO'], ['EIA_CUMULATIVE', 'NONE_FOUND'], ['BNG_APPLICABILITY', 'APPLIES'], ['CIL_CHARGING_SCHEDULE', 'IN_FORCE'], ['LOCAL_VALIDATION_LIST', 'VERIFIED_CURRENT']] as const) {
      planning.recordSiteFact(as('pm'), { key, value, source: 'Recorded for the test, 1 Oct 2026' });
    }
    planning.evaluateProposal(as('pm'), { proposalId: school.id });
    gates.approveGate(as('owner'), 'G0', { rationale: 'Appraisal complete with unknowns recorded' });
    application = apps.draftApplication(as('pm'), { route: 'full', proposalId: school.id, targetSubmissionOn: '2027-03-31' });
    await refused(() => agents.draftStudyScopes(as('pm'), { applicationId: application.id }), 'NO_STUDIES_TO_SCOPE');
    studies.generateStudies(as('pm'), application.id);
    const open = studies.studies(as('pm'), application.id).filter((study) => study.applicability !== 'NOT_REQUIRED');
    assert.ok(open.length > 0);

    const run = await agents.draftStudyScopes(as('pm'), { applicationId: application.id });
    assert.equal(run.proposed, open.length);
    assert.equal(run.dropped, 1, 'the brief for a study it was not given');
    const first = proposalsOf(run.runId)[0]!;
    agents.decideProposal(as('pm'), first.id, { decision: 'ACCEPT' });
    const scoped = studies.studies(as('pm'), application.id).find((study) => study.id === first.payload.studyId)!;
    assert.match(scoped.scope!, /420-pupil school/);
    for (const rest of proposalsOf(run.runId).slice(1)) agents.decideProposal(as('pm'), rest.id, { decision: 'REJECT', note: 'Brief to be written by the consultant' });
    assert.equal(studies.studies(as('pm'), application.id).filter((study) => study.scope).length, 1, 'a rejected brief changes nothing');
  });

  it('proposes an owner and a needed-by date, dropping one that is not a date', async () => {
    const run = await agents.adviseNextActions(as('pm'), { applicationId: application.id });
    assert.equal(run.proposed, 1);
    assert.equal(run.dropped, 1);
    const [action] = proposalsOf(run.runId);
    agents.decideProposal(as('pm'), action!.id, { decision: 'ACCEPT' });
    const requirement = apps.requirements(as('pm'), application.id).find((entry) => entry.id === action!.payload.requirementId)!;
    assert.equal(requirement.owner, 'Planning lead');
    assert.equal(requirement.dueOn, '2027-01-15');
  });

  it('drafts the planning statement in sections from the record', async () => {
    const run = await agents.draftStatement(as('pm'), { applicationId: application.id });
    assert.equal(run.proposed, 1);
    const [statement] = proposalsOf(run.runId);
    assert.equal((statement!.payload.sections as unknown[]).length, 2, 'the headless section is dropped');
    const sent = requests.at(-1)!.payload as Record<string, any>;
    assert.equal(sent.facts.FLOOD_ZONE.value, '3a', 'the statement is drafted from the recorded facts');
    assert.equal(agents.decideProposal(as('pm'), statement!.id, { decision: 'ACCEPT' }).status, 'ACCEPTED');
  });
});

describe('the conditions agent', () => {
  it('proposes each condition only word for word, and accepting it still needs a second person to verify', async () => {
    const homes = planning.recordProposal(as('pm'), { siteVersionId: planning.siteVersions(as('pm')).at(-1)!.id, scenarioName: 'Full, 40 homes', route: 'full', category: 'RESIDENTIAL', dwellingCount: 40, createdGiaM2: 3600 });
    const evaluationId = planning.evaluateProposal(as('pm'), { proposalId: homes.id }).id;
    // A new proposal reopens the appraisal; it is approved again with both in it.
    gates.approveGate(as('owner'), 'G0', { rationale: 'Both scenarios appraised' });
    const application = apps.draftApplication(as('pm'), { route: 'full', proposalId: homes.id, targetSubmissionOn: '2026-09-30' });
    satisfy(application.id, ['G1']);
    gates.approveGate(as('owner'), 'G1', { applicationId: application.id, rationale: 'Route and budget approved', riskAcceptances: [{ blockerId: 'G1:UNQUOTED', rationale: 'Quotes due before submission; allowances are within appetite' }] });
    satisfy(application.id, ['G2']);
    const quote = planning.quoteFeeFor(as('pm'), { route: 'full', madeOn: '2026-12-08', dateBasis: 'ASSUMED', proposalId: homes.id });
    apps.assemblePack(as('pm'), { applicationId: application.id, evaluationId, feeQuoteId: quote.id, documents: [evidence('Location plan'), evidence('Planning statement')] });
    gates.approveGate(as('owner'), 'G2', { applicationId: application.id, rationale: 'Pack checked' });
    apps.recordApplicationEvent(as('pm'), application.id, { type: 'submitted', occurredOn: '2026-10-01', evidence: [evidence('Portal receipt')], payload: { externalRef: 'PP-14300001' } });
    apps.recordApplicationEvent(as('pm'), application.id, { type: 'validated', occurredOn: '2026-10-08', evidence: [evidence('Validation letter')] });
    apps.recordApplicationEvent(as('pm'), application.id, {
      type: 'determined',
      occurredOn: '2026-11-12',
      evidence: [evidence('Decision notice, signed')],
      payload: { outcome: 'GRANTED', issuedBy: 'Example DC, ref 26/02000/FUL', issuedNotice: true, commencementBy: '2099-11-12', approvedDrawings: [evidence('Site plan')] },
    });
    const permission = consents.consents(as('pm')).find((entry) => entry.applicationId === application.id)!;
    const notice = await planningDocument('Decision notice 26-02000-FUL.docx', ['Conditions', `5. ${CONDITION_5}`, `7. ${CONDITION_7}`]);

    const run = await agents.readConditions(as('pm'), { consentId: permission.id, ingestionId: notice });
    assert.equal(run.proposed, 1, 'only the verbatim condition');
    assert.equal(run.dropped, 1, 'the paraphrase');
    const before = consents.conditions(as('pm'), permission.id).length;
    const [proposal] = proposalsOf(run.runId);
    const decided = agents.decideProposal(as('pm'), proposal!.id, { decision: 'ACCEPT' });
    const condition = consents.conditions(as('pm'), permission.id).find((entry) => entry.id === decided.result?.refId)!;
    assert.equal(consents.conditions(as('pm'), permission.id).length, before + 1);
    assert.equal(condition.wording, CONDITION_5);
    assert.equal(condition.trigger, 'BEFORE_COMMENCEMENT');
    assert.ok(!condition.verified, 'accepted, not verified');
    assert.throws(() => consents.verifyCondition(as('pm'), condition.id), (error: { code?: string }) => error.code === 'CONDITION_SAME_PERSON');
    consents.verifyCondition(as('qs'), condition.id);
  });
});

describe('the share of the work', () => {
  it('counts what the agents proposed and what people accepted or rejected', () => {
    const share = agents.agentShare(as('pm'));
    assert.equal(share.proposed, share.accepted + share.rejected + share.pending);
    assert.ok(share.accepted >= 6);
    assert.ok(share.rejected >= 1);
    for (const kind of ['PROPOSAL', 'SITE_FACT', 'STUDY_SCOPE', 'ASSIGNMENT', 'STATEMENT', 'CONDITION']) assert.ok(share.byKind[kind]?.accepted, kind);
  });

  it('quotes every agent before it runs and keeps the decision a human one', () => {
    const agentRoutes = ROUTES.filter((route) => /\/planning\/.*agents\//.test(route.pattern) && route.method === 'POST' && !route.pattern.endsWith('/decide'));
    assert.equal(agentRoutes.length, 6);
    for (const route of agentRoutes) assert.equal(route.ai?.engine, 'CONSENT', route.pattern);
    assert.equal(ROUTES.find((route) => route.pattern.endsWith('/planning/agents/proposals/:proposalId/decide'))?.ai, undefined);
  });
});
